"""
Natural-language → structured Service Dive filters via Google Gemini (JSON output).

Filter semantics must match js/app.js: substring key row, substring customer name,
substring key+value on 2nd-level keys and display/yaml text, cloud + segment radios.

Model selection (free tier friendly; see https://ai.google.dev/gemini-api/docs/models):
- If ``GEMINI_MODEL`` is set, only that model is used.
- Otherwise we try ``GEMINI_MODEL_FALLBACKS`` (comma-separated) or, by default,
  stable 2.5+ models — **not** deprecated ``gemini-2.0-flash`` (often shows
  exhausted free-tier quota as limit 0).
- On HTTP 429 we try the next model in the chain.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

# Context limits (token budget; adjustable via env)
_MAX_KEY_LINE = 220
_MAX_QUERY = 4000
_MAX_MATRIX_KEYS_CAP = 300

# Stable / current-generation models suitable for Google AI free tier (2.0 is deprecated per Google).
_DEFAULT_FREE_TIER_MODEL_CHAIN = (
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-3-flash-preview",
)

SYSTEM_PROMPT = """You map a short natural-language request to filters for a Helm Service Dive matrix UI.

Rules (must follow):
- keyQ: substring match against 2nd-level YAML key names (case-insensitive). Empty string = no filter.
- custQ: substring match against customer folder names (case-insensitive). Empty = no filter.
- kvKey: substring to pick which row key(s) apply to the key+value filter (case-insensitive on key name). Empty = not used alone for kv; see below.
- kvValue: substring matched against each cell's display text AND raw yaml snippet (case-insensitive). Empty = if kvKey is set, keep customers where that key exists and is not missing; if kvKey empty, kv filter is unused.
- cloud: one of "both", "AWS", "Azure" — which cloud's customers to show.
- segment: one of "all", "core", "other" — core = customers where the chart's core service is enabled.

Use only information from the provided service context. Prefer short substrings that will match the intended keys/values. If the user is vague, make a best guess and explain briefly.

Respond with a single JSON object only (no markdown), with keys:
keyQ, custQ, kvKey, kvValue, cloud, segment, explanation
All string values; explanation is one short sentence for the user."""

_CLOUDS = frozenset({"both", "AWS", "Azure"})
_SEGMENTS = frozenset({"all", "core", "other"})


def _truncate(s: str, n: int) -> str:
    s = s.replace("\n", " ").strip()
    if len(s) <= n:
        return s
    return s[: n - 1] + "…"


def build_service_dive_nl_context(dive: dict[str, Any]) -> str:
    """Compact text context for the model: keys, customer names, value hints per key."""
    service = dive.get("service") or ""
    customers: list[str] = list(dive.get("customers") or [])
    matrix: list[dict[str, Any]] = list(dive.get("matrix") or [])

    lines: list[str] = [
        f"service={service}",
        f"customer_count={len(customers)}",
        "customers (names may look like AWS/foo or Azure/bar):",
        _truncate(", ".join(customers), _MAX_KEY_LINE),
        "",
        "Per-key hints (substring filters use these display strings):",
    ]

    cap = _max_matrix_keys()
    for i, row in enumerate(matrix):
        if i >= cap:
            lines.append(f"... ({len(matrix) - cap} more keys omitted)")
            break
        rk = row.get("key") or ""
        by_c = row.get("by_customer") or {}
        samples: list[str] = []
        seen: set[str] = set()
        for cname in customers:
            cell = by_c.get(cname) or {}
            if cell.get("is_missing"):
                continue
            disp = str(cell.get("display") or "").strip()
            if disp and disp not in seen:
                seen.add(disp)
                samples.append(f"{cname}={_truncate(disp, 48)}")
            if len(samples) >= 6:
                break
        samp = "; ".join(samples) if samples else "(all missing)"
        lines.append(f"- {rk}: {_truncate(samp, _MAX_KEY_LINE)}")

    return "\n".join(lines)


def _max_matrix_keys() -> int:
    """Cap matrix rows sent to the model (smaller = fewer input tokens on free tier)."""
    try:
        n = int(os.environ.get("GEMINI_NL_MAX_MATRIX_KEYS", "100"))
    except ValueError:
        n = 100
    return max(20, min(n, _MAX_MATRIX_KEYS_CAP))


def _parse_json_object(raw: str) -> dict[str, Any]:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    return json.loads(raw)


def normalize_nl_filter(obj: dict[str, Any]) -> dict[str, Any]:
    """Validate and coerce model output to strings and allowed enums."""

    def _s(name: str, default: str = "") -> str:
        v = obj.get(name, default)
        if v is None:
            return default
        return str(v).strip()[:500]

    out = {
        "keyQ": _s("keyQ"),
        "custQ": _s("custQ"),
        "kvKey": _s("kvKey"),
        "kvValue": _s("kvValue"),
        "explanation": _s("explanation", "Applied filters."),
    }
    cloud = _s("cloud", "both")
    if cloud not in _CLOUDS:
        cloud = "both"
    segment = _s("segment", "all")
    if segment not in _SEGMENTS:
        segment = "all"
    out["cloud"] = cloud
    out["segment"] = segment
    return out


def _sanitize_model_id(m: str) -> str | None:
    m = m.strip()
    if not m or not re.match(r"^[\w.\-]+$", m):
        return None
    return m


def _models_to_try() -> list[str]:
    """Models to call: explicit GEMINI_MODEL only, else FALLBACKS or default free-tier chain."""
    explicit = os.environ.get("GEMINI_MODEL", "").strip()
    if explicit:
        sid = _sanitize_model_id(explicit)
        return [sid] if sid else []

    fb = os.environ.get("GEMINI_MODEL_FALLBACKS", "").strip()
    if fb:
        out: list[str] = []
        for part in fb.split(","):
            sid = _sanitize_model_id(part)
            if sid:
                out.append(sid)
        if out:
            return out

    return list(_DEFAULT_FREE_TIER_MODEL_CHAIN)


def _post_generate_content(api_key: str, model: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    qkey = urllib.parse.quote(api_key, safe="")
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={qkey}"
    )
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError:
        raise
    except urllib.error.URLError as e:
        raise RuntimeError(f"Gemini request failed: {e}") from e


def call_gemini_nl_filter(api_key: str, user_query: str, context_text: str) -> tuple[dict[str, Any], str]:
    """
    Call Gemini generateContent with JSON response MIME type.
    Returns (normalized_filter, model_id_used).
    """
    models = _models_to_try()
    if not models:
        raise ValueError("no valid Gemini model id (check GEMINI_MODEL / GEMINI_MODEL_FALLBACKS)")

    q = user_query.strip()[: _MAX_QUERY]
    if not q:
        raise ValueError("empty query")

    user_text = f"Context:\n{context_text}\n\nUser request:\n{q}\n"

    payload: dict[str, Any] = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [
            {
                "role": "user",
                "parts": [{"text": user_text}],
            }
        ],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json",
        },
    }

    timeout = float(os.environ.get("GEMINI_TIMEOUT_SEC", "60"))
    last_429: str | None = None
    body: dict[str, Any] | None = None
    used: str | None = None

    for i, model in enumerate(models):
        try:
            body = _post_generate_content(api_key, model, payload, timeout)
            used = model
            break
        except urllib.error.HTTPError as e:
            try:
                err_body = e.read().decode("utf-8", errors="replace")
            except Exception:  # noqa: BLE001
                err_body = str(e)
            if e.code == 429 and i < len(models) - 1:
                last_429 = err_body
                continue
            raise RuntimeError(f"Gemini HTTP {e.code}: {err_body}") from e

    if body is None or used is None:
        raise RuntimeError(
            "Gemini quota exhausted for all models tried "
            f"({', '.join(models)}). Last 429: {last_429 or 'unknown'}"
        )

    cands = body.get("candidates") or []
    if not cands:
        fb = body.get("promptFeedback") or body.get("error") or body
        raise RuntimeError(f"Gemini returned no candidates: {fb!r}")

    try:
        parts = cands[0].get("content", {}).get("parts") or []
        content = parts[0].get("text", "")
    except (IndexError, KeyError, TypeError) as e:
        raise RuntimeError(f"unexpected Gemini response shape: {body!r}") from e

    if not str(content).strip():
        raise RuntimeError(f"empty Gemini text: {body!r}")

    parsed = _parse_json_object(content)
    return normalize_nl_filter(parsed), used
