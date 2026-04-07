"""Discover Helm component keys and read effective enabled + subtree for tooltips."""

from __future__ import annotations

from typing import Any, Iterable

# Keys that are not "components" with a top-level enabled flag in the chart sense
SKIP_ROOT = frozenset(
    {
        "global",
        "glassbox",
        "tags",
        "dumpScript",
        "dependencies",
        "imageAdmissionPolicy",
        "glassboxConfig",
    }
)

def _truthy_enabled(raw: Any) -> bool | None:
    if raw is None:
        return None
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return bool(raw)
    if isinstance(raw, str):
        s = raw.strip().lower()
        if s in ("true", "yes", "1", "on"):
            return True
        if s in ("false", "no", "0", "off", ""):
            return False
    return None


def _block_has_enabled_key(d: dict[str, Any]) -> bool:
    return "enabled" in d


def discover_service_keys(merged: dict[str, Any]) -> list[str]:
    """Collect logical service ids from a merged values document."""
    keys: set[str] = set()
    if not isinstance(merged, dict):
        return []

    for k, v in merged.items():
        if k in SKIP_ROOT:
            continue
        if k == "cronjobs" and isinstance(v, dict):
            for ck, cv in v.items():
                if isinstance(cv, dict) and _block_has_enabled_key(cv):
                    keys.add(f"cronjobs.{ck}")
        elif k == "siteGeneric" and isinstance(v, dict):
            for sk, sv in v.items():
                if isinstance(sv, dict) and _block_has_enabled_key(sv):
                    keys.add(f"siteGeneric.{sk}")
        elif isinstance(v, dict) and _block_has_enabled_key(v):
            keys.add(k)
    return sorted(keys)


def get_service_block(merged: dict[str, Any], service_key: str) -> dict[str, Any]:
    """Return the YAML subtree for one logical service."""
    if service_key.startswith("cronjobs."):
        sub = service_key.split(".", 1)[1]
        cj = merged.get("cronjobs")
        if not isinstance(cj, dict):
            return {}
        block = cj.get(sub)
        return block if isinstance(block, dict) else {}
    if service_key.startswith("siteGeneric."):
        sub = service_key.split(".", 1)[1]
        sg = merged.get("siteGeneric")
        if not isinstance(sg, dict):
            return {}
        block = sg.get(sub)
        return block if isinstance(block, dict) else {}
    block = merged.get(service_key)
    return block if isinstance(block, dict) else {}


def effective_enabled(block: dict[str, Any]) -> bool | None:
    return _truthy_enabled(block.get("enabled"))


def union_sorted(keys_iter: Iterable[Iterable[str]]) -> list[str]:
    u: set[str] = set()
    for group in keys_iter:
        u.update(group)
    return sorted(u)
