"""Fetch version counts from Prometheus (Glassbox + K8s node_exporter metrics)."""

from __future__ import annotations

import json
import os
import re
import socket
from concurrent.futures import ThreadPoolExecutor
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

PROMETHEUS_INSTANT_QUERY_URL = os.environ.get(
    "CVA_PROMETHEUS_URL",
    "https://mon.mgmt.glassboxdigital.io/api/v1/query",
)

VERSION_BY_CUSTOMER_QUERY = (
    "count by (glassboxVersion,Customer) (node_exporter_build_info)"
)

K8S_VERSION_QUERY = (
    'count by (Customer, cluster, k8s_version, region) '
    '(node_exporter_build_info{job="node-exporter-for-nodeType-label",k8s_version!=""})'
)

# Heatmap (treemap): node sizing + kube problem-pod counts by Customer label.
HEATMAP_NODES_BY_CUSTOMER_QUERY = (
    'count by (Customer) (node_exporter_build_info{Customer!=""})'
)
HEATMAP_ERROR_PODS_QUERY = (
    "count by (Customer) ("
    '(kube_pod_status_phase{Customer!="",phase="Pending"} == 1) or '
    '(kube_pod_container_status_waiting_reason{Customer!="",reason=~"ErrImagePull|ImagePullBackOff|CrashLoopBackOff"} == 1) or '
    '(kube_pod_container_status_terminated_reason{Customer!="",reason="Error"} == 1)'
    ")"
)

QUERY_TIMEOUT_SEC = 30


def _instant_query_vector(query: str) -> tuple[list[dict[str, Any]] | None, str | None]:
    """Run an instant query; return (result_vector, error)."""
    params = urllib.parse.urlencode({"query": query})
    url = f"{PROMETHEUS_INSTANT_QUERY_URL}?{params}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=QUERY_TIMEOUT_SEC) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except socket.timeout as ex:
        return None, f"Prometheus query timed out after {QUERY_TIMEOUT_SEC}s ({ex})"
    except urllib.error.HTTPError as ex:
        body = ""
        try:
            body = ex.read().decode("utf-8", errors="replace")[:2000]
        except Exception:  # noqa: BLE001
            body = ""
        return None, f"Prometheus HTTP {ex.code}: {body or ex.reason}"
    except urllib.error.URLError as ex:
        return None, f"Prometheus request failed: {ex}"
    except OSError as ex:
        return None, f"Prometheus request failed: {ex}"

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as ex:
        return None, f"Invalid JSON from Prometheus: {ex}"

    if payload.get("status") != "success":
        return None, f"Prometheus status: {payload.get('status', payload)}"

    result = payload.get("data", {}).get("result")
    if not isinstance(result, list):
        return None, "Unexpected Prometheus response shape"

    return result, None


def _parse_count(val_obj: object) -> int:
    if isinstance(val_obj, (list, tuple)) and len(val_obj) >= 2:
        try:
            return int(float(str(val_obj[1])))
        except (TypeError, ValueError):
            return 0
    return 0


def fetch_version_points() -> tuple[list[dict[str, str | int]], str | None]:
    """
    Glassbox versions: count by (glassboxVersion, Customer).

    Each point: {"customer": str, "version": str, "count": int}
    """
    rows, err = _instant_query_vector(VERSION_BY_CUSTOMER_QUERY)
    if err or rows is None:
        return [], err or "unknown error"

    points: list[dict[str, str | int]] = []
    for row in rows:
        metric = row.get("metric") or {}
        cust = metric.get("Customer") or metric.get("customer")
        ver = metric.get("glassboxVersion") or metric.get("glassbox_version")
        if not cust or not ver:
            continue
        points.append(
            {
                "customer": str(cust),
                "version": str(ver),
                "count": _parse_count(row.get("value")),
            }
        )

    return points, None


def fetch_k8s_version_points() -> tuple[list[dict[str, str | int]], str | None]:
    """
    K8s versions on labeled node_exporter job.

    Each point: customer, cluster, k8s_version, region, count
    """
    rows, err = _instant_query_vector(K8S_VERSION_QUERY)
    if err or rows is None:
        return [], err or "unknown error"

    points: list[dict[str, str | int]] = []
    for row in rows:
        metric = row.get("metric") or {}
        cust = metric.get("Customer") or metric.get("customer")
        cluster = metric.get("cluster") or metric.get("Cluster") or ""
        kv = metric.get("k8s_version") or metric.get("K8s_version") or ""
        region = metric.get("region") or metric.get("Region") or ""
        if not cust or not kv:
            continue
        points.append(
            {
                "customer": str(cust),
                "cluster": str(cluster),
                "k8s_version": str(kv),
                "region": str(region),
                "count": _parse_count(row.get("value")),
            }
        )

    return points, None


def heatmap_status(error_pods: int) -> str:
    """GREEN = no bad pods; ORANGE = minor (1–2); RED = severe (3+)."""
    if error_pods <= 0:
        return "GREEN"
    if error_pods <= 2:
        return "ORANGE"
    return "RED"


def _customer_count_map(rows: list[dict[str, Any]] | None) -> dict[str, int]:
    out: dict[str, int] = {}
    for row in rows or []:
        metric = row.get("metric") or {}
        cust = metric.get("Customer") or metric.get("customer")
        if not cust:
            continue
        out[str(cust)] = _parse_count(row.get("value"))
    return out


def fetch_heatmap_cells() -> tuple[list[dict[str, Any]], str | None]:
    """
    Per Prometheus ``Customer`` label: node counts and aggregated bad-pod signals.

    Returns list of { customer, node_count, error_pods, status } sorted by customer name.
    """
    with ThreadPoolExecutor(max_workers=2) as pool:
        fut_nodes = pool.submit(_instant_query_vector, HEATMAP_NODES_BY_CUSTOMER_QUERY)
        fut_errs = pool.submit(_instant_query_vector, HEATMAP_ERROR_PODS_QUERY)
        node_rows, err = fut_nodes.result()
        err_rows, err2 = fut_errs.result()

    if err or node_rows is None:
        return [], err or "unknown error"
    if err2 or err_rows is None:
        return [], err2 or "unknown error"

    nodes = _customer_count_map(node_rows)
    errs = _customer_count_map(err_rows)
    names = sorted(set(nodes) | set(errs), key=str.casefold)

    out: list[dict[str, Any]] = []
    for name in names:
        n = int(nodes.get(name, 0))
        e = int(errs.get(name, 0))
        out.append(
            {
                "customer": name,
                "node_count": n,
                "error_pods": e,
                "status": heatmap_status(e),
            }
        )
    return out, None


# Customer label value allowed in heatmap detail query (no PromQL injection).
_HEATMAP_CUSTOMER_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


def heatmap_bad_pod_detail_row(metric: dict[str, Any]) -> dict[str, str]:
    """
    One instant-vector series → table row (labels match kube exporters / user jq example).
    """
    m = metric or {}
    cust = str(m.get("Customer") or m.get("customer") or "")
    cluster = str(
        m.get("clusterName") or m.get("cluster") or m.get("Cluster") or ""
    )
    region = str(m.get("region") or m.get("Region") or "")
    ns = str(m.get("namespace") or m.get("Namespace") or "")
    pod = str(m.get("pod") or m.get("Pod") or "")
    container = str(m.get("container") or m.get("Container") or "")
    phase = m.get("phase")
    reason_raw = m.get("reason")
    rs = str(reason_raw) if reason_raw is not None else ""

    if phase is not None and str(phase) != "":
        status = str(phase)
    elif rs == "Error":
        status = "Terminated"
    else:
        status = "Waiting"

    reason_col = rs or (str(phase) if phase is not None else "")

    return {
        "customer": cust,
        "cluster": cluster,
        "region": region,
        "namespace": ns,
        "pod": pod,
        "container": container,
        "status": status,
        "reason": reason_col,
    }


def _heatmap_bad_pods_detail_query(customer: str) -> str | None:
    if not _HEATMAP_CUSTOMER_RE.fullmatch(customer):
        return None
    esc = customer.replace("\\", "\\\\").replace('"', '\\"')
    return (
        f'(kube_pod_status_phase{{Customer="{esc}",phase="Pending"}} == 1) or '
        f'(kube_pod_container_status_waiting_reason{{Customer="{esc}",reason=~'
        f'"ErrImagePull|ImagePullBackOff|CrashLoopBackOff"}} == 1) or '
        f'(kube_pod_container_status_terminated_reason{{Customer="{esc}",reason="Error"}} == 1)'
    )


def fetch_heatmap_bad_pod_rows(customer: str) -> tuple[list[dict[str, str]], str | None]:
    """
    Raw instant-vector rows for one Customer (same selectors as HEATMAP_ERROR_PODS_QUERY).
    """
    name = (customer or "").strip()
    if not name:
        return [], "missing customer"
    q = _heatmap_bad_pods_detail_query(name)
    if q is None:
        return [], "invalid customer name"

    rows, err = _instant_query_vector(q)
    if err or rows is None:
        return [], err or "unknown error"

    out = [heatmap_bad_pod_detail_row(row.get("metric") or {}) for row in rows]
    out.sort(key=lambda r: (r["namespace"], r["pod"], r["container"]))
    return out, None
