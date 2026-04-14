"""Unit tests for Prometheus heatmap status bucketing."""

from __future__ import annotations

import unittest

from backend.prometheus_versions import heatmap_bad_pod_detail_row, heatmap_status


class TestHeatmapStatus(unittest.TestCase):
    def test_buckets(self) -> None:
        self.assertEqual(heatmap_status(0), "GREEN")
        self.assertEqual(heatmap_status(1), "ORANGE")
        self.assertEqual(heatmap_status(2), "ORANGE")
        self.assertEqual(heatmap_status(3), "RED")
        self.assertEqual(heatmap_status(99), "RED")


class TestBadPodDetailRow(unittest.TestCase):
    def test_terminated_error(self) -> None:
        row = heatmap_bad_pod_detail_row(
            {
                "Customer": "hkjc",
                "clusterName": "hkjc-core",
                "region": "ap-east-1",
                "namespace": "kubernetes-dashboard",
                "pod": "kubernetes-dashboard-646f7b6c74-2x2bj",
                "container": "kubernetes-dashboard",
                "reason": "Error",
            }
        )
        self.assertEqual(row["status"], "Terminated")
        self.assertEqual(row["reason"], "Error")
        self.assertEqual(row["cluster"], "hkjc-core")

    def test_pending_phase(self) -> None:
        row = heatmap_bad_pod_detail_row(
            {"Customer": "x", "phase": "Pending", "namespace": "ns", "pod": "p", "container": "c"}
        )
        self.assertEqual(row["status"], "Pending")
        self.assertEqual(row["reason"], "Pending")

    def test_waiting_reason(self) -> None:
        row = heatmap_bad_pod_detail_row(
            {
                "Customer": "x",
                "reason": "CrashLoopBackOff",
                "namespace": "ns",
                "pod": "p",
                "container": "c",
            }
        )
        self.assertEqual(row["status"], "Waiting")
        self.assertEqual(row["reason"], "CrashLoopBackOff")


if __name__ == "__main__":
    unittest.main()
