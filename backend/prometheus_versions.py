"""Fetch version counts from Prometheus (Glassbox + K8s node_exporter metrics)."""

from __future__ import annotations

import json
import os
import socket
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
