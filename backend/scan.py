"""Read-only scan of customer folders and custom_values_*.yaml files."""

from __future__ import annotations

import json
import time
from collections import Counter
from pathlib import Path
from typing import Any

import yaml

from backend.config import CLOUD_SUBDIRS, base_values_path, customers_root, ensure_data_dir
from backend.db import connect, meta_set, replace_customers
from backend.merge import deep_merge
from backend.services import discover_service_keys, union_sorted

GLOB_PATTERNS = ("custom_values_*.yaml", "custom_values_*.yml")


def _load_yaml_file(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8", errors="replace")
    data = yaml.safe_load(text)
    if data is None:
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def _load_base(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    return _load_yaml_file(path)


def _canonical_cloud_dirs(parent: Path) -> list[tuple[str, Path]]:
    """
    Find AWS / Azure under ``parent`` using **case-insensitive** folder names
    (e.g. ``azure`` on disk → canonical key ``Azure``).
    """
    if not parent.is_dir():
        return []
    found: dict[str, Path] = {}
    for child in parent.iterdir():
        if not child.is_dir() or child.name.startswith("."):
            continue
        key = child.name.casefold()
        if key == "aws":
            found["AWS"] = child
        elif key == "azure":
            found["Azure"] = child
    return [(name, found[name]) for name in ("AWS", "Azure") if name in found]


def _customer_dirs_to_scan(root: Path) -> list[tuple[str, Path]]:
    """
    (customer_key, directory) — key is ``CloudName/customerDir`` when using
    st_customers/AWS/foo layout, or legacy flat names if root has no AWS/Azure children.
    """
    out: list[tuple[str, Path]] = []
    if not root.is_dir():
        return out

    cloud_pairs = _canonical_cloud_dirs(root)
    if cloud_pairs:
        for cloud, sub in cloud_pairs:
            for child in sorted(sub.iterdir(), key=lambda p: p.name.lower()):
                if child.is_dir() and not child.name.startswith("."):
                    out.append((f"{cloud}/{child.name}", child))
        return out

    # Env pointed at a single cloud folder (e.g. .../st_customers/AWS or .../azure)
    rn = root.name.casefold()
    if rn == "aws":
        cloud = "AWS"
        for child in sorted(root.iterdir(), key=lambda p: p.name.lower()):
            if child.is_dir() and not child.name.startswith("."):
                out.append((f"{cloud}/{child.name}", child))
        return out
    if rn == "azure":
        cloud = "Azure"
        for child in sorted(root.iterdir(), key=lambda p: p.name.lower()):
            if child.is_dir() and not child.name.startswith("."):
                out.append((f"{cloud}/{child.name}", child))
        return out

    for child in sorted(root.iterdir(), key=lambda p: p.name.lower()):
        if child.is_dir() and not child.name.startswith("."):
            out.append((child.name, child))
    return out


def _list_custom_value_files(customer_dir: Path) -> list[Path]:
    found: list[Path] = []
    for pattern in GLOB_PATTERNS:
        found.extend(sorted(customer_dir.glob(pattern)))
    # De-dupe same file
    seen: set[Path] = set()
    out: list[Path] = []
    for p in sorted(found, key=lambda x: x.name.lower()):
        rp = p.resolve()
        if rp not in seen:
            seen.add(rp)
            out.append(p)
    return out


def scan_customers(
    *,
    customers_dir: Path | None = None,
    base_path: Path | None = None,
) -> dict[str, Any]:
    """
    Walk customer directories, merge base + all custom_values_* per customer.
    Returns a report dict (does not write DB).
    """
    root = customers_dir or customers_root()
    base = base_path or base_values_path()
    base_doc = _load_base(base)

    if not root.is_dir():
        return {
            "ok": False,
            "error": f"Customers root is not a directory: {root}",
            "customers": [],
            "service_keys": [],
        }

    rows: list[tuple[str, list[dict[str, Any]], dict[str, Any]]] = []
    errors: list[str] = []

    for name, child in _customer_dirs_to_scan(root):
        files = _list_custom_value_files(child)
        if not files:
            continue
        merged: dict[str, Any] = deep_merge({}, base_doc)
        files_meta: list[dict[str, Any]] = []
        for fp in files:
            try:
                patch = _load_yaml_file(fp)
                merged = deep_merge(merged, patch)
                files_meta.append({"name": fp.name, "path": str(fp.resolve())})
            except Exception as ex:  # noqa: BLE001 — surface per-file errors
                errors.append(f"{name}/{fp.name}: {ex}")

        if not files_meta:
            errors.append(f"{name}: no custom_values_*.yaml could be loaded; skipped")
            continue

        rows.append((name, files_meta, merged))

    service_keys = union_sorted(discover_service_keys(m) for _, _, m in rows)

    return {
        "ok": len(errors) == 0 or bool(rows),
        "errors": errors,
        "customers_scanned": len(rows),
        "service_keys": service_keys,
        "base_values_path": str(base.resolve()),
        "customers_root": str(root.resolve()),
        "rows": rows,
    }


def persist_scan(db_path: Path, report: dict[str, Any]) -> None:
    """Write report rows + meta to SQLite."""
    ensure_data_dir()
    rows = report.get("rows") or []
    with connect(db_path) as conn:
        replace_customers(conn, rows)
        meta_set(conn, "last_scan_iso", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        meta_set(conn, "last_scan_epoch", str(time.time()))
        meta_set(conn, "customers_root", report.get("customers_root", ""))
        meta_set(conn, "cloud_subdirs_scanned", ",".join(CLOUD_SUBDIRS))
        counts = Counter(n.split("/")[0] for n, _, _ in rows)
        meta_set(conn, "customer_counts_by_cloud_json", json.dumps(dict(sorted(counts.items()))))
        meta_set(conn, "base_values_path", report.get("base_values_path", ""))
        meta_set(conn, "service_key_count", str(len(report.get("service_keys") or [])))
        meta_set(conn, "scan_errors_json", json.dumps(report.get("errors") or []))


def run_scan_to_db(db_path: Path) -> dict[str, Any]:
    report = scan_customers()
    if report.get("rows") is not None:
        persist_scan(db_path, report)
    # Re-read errors from persisted meta for API
    out = {k: v for k, v in report.items() if k != "rows"}
    return out


if __name__ == "__main__":
    from backend.config import DB_PATH, ensure_data_dir

    ensure_data_dir()
    summary = run_scan_to_db(DB_PATH)
    brief = {k: v for k, v in summary.items() if k != "service_keys"}
    brief["service_key_count"] = len(summary.get("service_keys") or [])
    print(json.dumps(brief, indent=2))
