"""Build JSON payloads for the UI from DB state."""

from __future__ import annotations

import csv
import io
import json
from collections import Counter
from difflib import HtmlDiff
from typing import Any

from backend.config import CORE_SEGMENT_SERVICE_KEY
from backend.db import connect, get_customer, iter_customers_merged, meta_get
from backend.services import (
    discover_service_keys,
    effective_enabled,
    get_service_block,
    union_sorted,
)
from backend.yamlfmt import MERGED_YAML_MAX, TOOLTIP_YAML_MAX, dump_yaml


def meta_bundle(conn) -> dict[str, Any]:
    return {
        "last_scan_iso": meta_get(conn, "last_scan_iso"),
        "last_scan_epoch": meta_get(conn, "last_scan_epoch"),
        "customers_root": meta_get(conn, "customers_root"),
        "cloud_subdirs_scanned": meta_get(conn, "cloud_subdirs_scanned"),
        "customer_counts_by_cloud": json.loads(
            meta_get(conn, "customer_counts_by_cloud_json") or "{}"
        ),
        "base_values_path": meta_get(conn, "base_values_path"),
        "service_key_count": meta_get(conn, "service_key_count"),
        "scan_errors": json.loads(meta_get(conn, "scan_errors_json") or "[]"),
        "core_segment_service_key": meta_get(conn, "core_segment_service_key")
        or CORE_SEGMENT_SERVICE_KEY,
    }


def _load_merged_and_core(conn) -> tuple[dict[str, dict[str, Any]], dict[str, bool], str]:
    """Single SELECT over customers — avoids N+1 get_customer calls."""
    merged_by_name: dict[str, dict[str, Any]] = {}
    customer_core: dict[str, bool] = {}
    for name, merged, is_core in iter_customers_merged(conn):
        merged_by_name[name] = merged
        customer_core[name] = is_core
    core_key = meta_get(conn, "core_segment_service_key") or CORE_SEGMENT_SERVICE_KEY
    return merged_by_name, customer_core, core_key


def _merged_by_customer(conn) -> dict[str, dict[str, Any]]:
    merged_by_name, _, _ = _load_merged_and_core(conn)
    return merged_by_name


def _filter_customers_segment(
    names: list[str], core_map: dict[str, bool], segment: str
) -> list[str]:
    if segment == "core":
        return [n for n in names if core_map.get(n) is True]
    if segment == "other":
        return [n for n in names if core_map.get(n) is not True]
    return list(names)


def customer_public_view(conn, name: str) -> dict[str, Any] | None:
    row = get_customer(conn, name)
    if row is None:
        return None
    merged = row.pop("merged")
    row["merged_yaml"] = dump_yaml(merged, max_len=MERGED_YAML_MAX)
    return row


def dashboard_matrix(conn) -> dict[str, Any]:
    merged_by_name, customer_core, core_key = _load_merged_and_core(conn)
    customer_names = sorted(merged_by_name.keys(), key=str.casefold)

    service_keys = union_sorted(
        discover_service_keys(m) for m in merged_by_name.values()
    )

    matrix: list[dict[str, Any]] = []
    for sk in service_keys:
        by_c: dict[str, Any] = {}
        for cname in customer_names:
            merged = merged_by_name.get(cname) or {}
            block = get_service_block(merged, sk)
            en = effective_enabled(block)
            by_c[cname] = {
                "enabled": en is True,
                "yaml": dump_yaml(block, max_len=TOOLTIP_YAML_MAX),
            }
        matrix.append({"service": sk, "by_customer": by_c})

    return {
        "customer_names": customer_names,
        "service_keys": service_keys,
        "matrix": matrix,
        "customer_core": customer_core,
        "core_service_key": core_key,
    }


def matrix_csv(conn, segment: str = "all") -> str:
    data = dashboard_matrix(conn)
    names = _filter_customers_segment(
        data["customer_names"], data["customer_core"], segment
    )
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["service", *names])
    for row in data["matrix"]:
        sk = row["service"]
        cells = row["by_customer"]
        w.writerow([sk] + [_cell_csv(cells.get(n, {})) for n in names])
    return buf.getvalue()


def _cell_csv(cell: dict[str, Any]) -> str:
    return "on" if cell.get("enabled") is True else "off"


def services_list_payload(conn) -> dict[str, Any]:
    merged_by_name, customer_core, core_key = _load_merged_and_core(conn)
    keys_by_customer: dict[str, set[str]] = {
        c: set(discover_service_keys(m)) for c, m in merged_by_name.items()
    }
    service_keys = union_sorted(keys_by_customer.values())
    items: list[dict[str, Any]] = []
    for sk in service_keys:
        incore = any(
            customer_core.get(c) and sk in keys_by_customer[c] for c in merged_by_name
        )
        inother = any(
            (not customer_core.get(c)) and sk in keys_by_customer[c] for c in merged_by_name
        )
        items.append({"name": sk, "in_core": incore, "in_other": inother})
    return {
        "core_service_key": core_key,
        "customer_core": customer_core,
        "services": items,
    }


def compute_anomaly(
    conn, entity: str, threshold: int, color: str, segment: str = "all"
) -> list[dict[str, Any]]:
    """
    entity: 'customers' | 'services'
    threshold: return items whose count is strictly < threshold
    color: 'green' (enabled=true) | 'red' (enabled!=true)
    segment: 'all' | 'core' | 'other' — limit to customers with core service on/off
    Returns list of {name, count, total} sorted by count ascending.
    """
    data = dashboard_matrix(conn)
    matrix = data["matrix"]
    customers_all = data["customer_names"]
    customers = _filter_customers_segment(
        customers_all, data["customer_core"], segment
    )
    match = (lambda v: v) if color == "green" else (lambda v: not v)

    results: list[dict[str, Any]] = []
    if entity == "customers":
        total = len(matrix)
        for cname in customers:
            count = sum(
                1
                for row in matrix
                if match(row["by_customer"].get(cname, {}).get("enabled", False))
            )
            if count < threshold:
                results.append({"name": cname, "count": count, "total": total})
    else:
        total = len(customers)
        if total == 0:
            return []
        for row in matrix:
            svc = row["service"]
            count = sum(
                1
                for c in customers
                if match(row["by_customer"].get(c, {}).get("enabled", False))
            )
            if count < threshold:
                results.append({"name": svc, "count": count, "total": total})

    return sorted(results, key=lambda x: x["count"])


def _val_compare(val: Any) -> str:
    """Canonical string for grouping equal values across customers."""
    try:
        return json.dumps(val, sort_keys=True, default=str, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        return repr(val)


def _val_display(val: Any, *, max_len: int = 22) -> str:
    """Short human-readable label for a matrix cell (≤max_len chars)."""
    if val is None:
        return "null"
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, (int, float)):
        return str(val)
    if isinstance(val, str):
        s = val.strip()
        return (s[: max_len - 1] + "…") if len(s) > max_len else s
    if isinstance(val, dict):
        n = len(val)
        return f"{{{n} key{'s' if n != 1 else ''}}}"
    if isinstance(val, list):
        n = len(val)
        return f"[{n} item{'s' if n != 1 else ''}]"
    return str(val)[:max_len]


def service_dive(conn, service_key: str) -> dict[str, Any] | None:
    """
    Build a 2nd-level key × customer matrix for one service.

    For each row (2nd-level YAML key):
    - ``display``   – short label for the cell
    - ``yaml``      – full YAML of the value (for hover, 3rd level+)
    - ``is_modal``  – True when value == most-common value for that row
    - ``is_missing``– True when the key is absent in that customer's block
    - ``modal_pct`` – percentage of customers sharing the modal value
    """
    merged_by_name, customer_core, core_key = _load_merged_and_core(conn)
    all_keys = union_sorted(discover_service_keys(m) for m in merged_by_name.values())
    if service_key not in all_keys:
        return None

    customers = sorted(merged_by_name.keys(), key=str.casefold)

    # Service block per customer (empty dict = service not defined for them)
    blocks: dict[str, dict[str, Any]] = {}
    for cname in customers:
        b = get_service_block(merged_by_name[cname], service_key)
        blocks[cname] = b if isinstance(b, dict) else {}

    # Union of all 2nd-level keys, sorted
    all_row_keys: set[str] = set()
    for b in blocks.values():
        all_row_keys.update(b.keys())
    row_keys = sorted(all_row_keys)

    matrix: list[dict[str, Any]] = []
    for rk in row_keys:
        compare_vals: dict[str, str | None] = {}
        display_vals: dict[str, str] = {}
        yaml_vals:    dict[str, str] = {}

        for cname in customers:
            b = blocks[cname]
            if rk in b:
                val = b[rk]
                compare_vals[cname] = _val_compare(val)
                display_vals[cname] = _val_display(val)
                # Hover YAML: show the value subtree (3rd level+)
                if isinstance(val, (dict, list)):
                    yaml_vals[cname] = dump_yaml(val, max_len=TOOLTIP_YAML_MAX)
                else:
                    yaml_vals[cname] = f"{rk}: {val}\n"
            else:
                compare_vals[cname] = None
                display_vals[cname] = "—"
                yaml_vals[cname] = f"# '{rk}' not set for this customer\n"

        # Modal value = most common non-missing
        non_missing = [v for v in compare_vals.values() if v is not None]
        if non_missing:
            modal_compare, modal_count = Counter(non_missing).most_common(1)[0]
            modal_pct = round(modal_count / len(customers) * 100, 1)
        else:
            modal_compare = None
            modal_pct = 0.0

        by_customer: dict[str, Any] = {}
        for cname in customers:
            cv = compare_vals[cname]
            is_missing = cv is None
            is_modal   = (not is_missing) and (cv == modal_compare)
            by_customer[cname] = {
                "display":    display_vals[cname],
                "yaml":       yaml_vals[cname],
                "is_modal":   is_modal,
                "is_missing": is_missing,
            }

        matrix.append({
            "key":         rk,
            "modal_pct":   modal_pct,
            "by_customer": by_customer,
        })

    return {
        "service":   service_key,
        "customers": customers,
        "row_keys":  row_keys,
        "matrix":    matrix,
        "customer_core": customer_core,
        "core_service_key": core_key,
    }


def service_public_view(conn, service_key: str) -> dict[str, Any] | None:
    merged_by_name = _merged_by_customer(conn)
    all_keys = union_sorted(discover_service_keys(m) for m in merged_by_name.values())
    if service_key not in all_keys:
        return None
    by_customer: dict[str, Any] = {}
    for cname in sorted(merged_by_name.keys(), key=str.casefold):
        merged = merged_by_name[cname]
        block = get_service_block(merged, service_key)
        by_customer[cname] = {
            "enabled": effective_enabled(block) is True,
            "yaml": dump_yaml(block, max_len=MERGED_YAML_MAX),
        }
    return {"name": service_key, "by_customer": by_customer}


def service_yaml_diff_payload(
    conn,
    service_key: str,
    customer_a: str,
    customer_b: str,
    *,
    mode: str = "diff",
) -> dict[str, Any]:
    """
    Side-by-side HTML table diff of the merged YAML subtree for ``service_key``
    for two customers (stdlib :mod:`difflib.HtmlDiff`).

    ``mode``:
    - ``diff`` — context view (hunks + a few lines of context), default.
    - ``all`` — full YAML on both sides; changed lines still colored via HtmlDiff.
    """
    if mode not in ("diff", "all"):
        return {"error": "mode must be 'diff' or 'all'"}
    if not customer_a or not customer_b:
        return {"error": "customer_a and customer_b are required"}
    if customer_a == customer_b:
        return {"error": "choose two different customers"}

    merged_by_name, _, _ = _load_merged_and_core(conn)
    if customer_a not in merged_by_name:
        return {"error": f"unknown customer: {customer_a}"}
    if customer_b not in merged_by_name:
        return {"error": f"unknown customer: {customer_b}"}

    all_keys = union_sorted(discover_service_keys(m) for m in merged_by_name.values())
    if service_key not in all_keys:
        return {"error": "service not found"}

    block_a = get_service_block(merged_by_name[customer_a], service_key)
    block_b = get_service_block(merged_by_name[customer_b], service_key)
    if not isinstance(block_a, dict):
        block_a = {}
    if not isinstance(block_b, dict):
        block_b = {}

    yaml_a = dump_yaml(block_a, max_len=MERGED_YAML_MAX)
    yaml_b = dump_yaml(block_b, max_len=MERGED_YAML_MAX)
    lines_a = yaml_a.splitlines(True)
    lines_b = yaml_b.splitlines(True)

    try:
        differ = HtmlDiff(tabsize=2, wrapcolumn=96)
    except TypeError:
        differ = HtmlDiff(tabsize=2)

    use_context = mode != "all"

    table = differ.make_table(
        lines_a,
        lines_b,
        fromdesc=customer_a,
        todesc=customer_b,
        context=use_context,
        numlines=3,
    )
    return {
        "service": service_key,
        "left": customer_a,
        "right": customer_b,
        "mode": mode,
        "html": table,
    }
