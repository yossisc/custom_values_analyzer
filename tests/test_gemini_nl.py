"""Unit tests for Service Dive NL filter via Gemini (no network)."""

from __future__ import annotations

import io
import json
import unittest
import urllib.error
from unittest.mock import patch

from backend.gemini_nl import (
    build_service_dive_nl_context,
    call_gemini_nl_filter,
    normalize_nl_filter,
)


class TestNormalizeNlFilter(unittest.TestCase):
    def test_coerce_cloud_segment(self) -> None:
        out = normalize_nl_filter(
            {
                "keyQ": "foo",
                "custQ": "",
                "kvKey": "x",
                "kvValue": "y",
                "cloud": "invalid",
                "segment": "nope",
                "explanation": "test",
            }
        )
        self.assertEqual(out["cloud"], "both")
        self.assertEqual(out["segment"], "all")
        self.assertEqual(out["keyQ"], "foo")

    def test_aws_core(self) -> None:
        out = normalize_nl_filter(
            {
                "keyQ": "",
                "custQ": "",
                "kvKey": "",
                "kvValue": "",
                "cloud": "AWS",
                "segment": "core",
                "explanation": "",
            }
        )
        self.assertEqual(out["cloud"], "AWS")
        self.assertEqual(out["segment"], "core")


class TestBuildContext(unittest.TestCase):
    def test_smoke(self) -> None:
        dive = {
            "service": "mysvc",
            "customers": ["AWS/a", "Azure/b"],
            "matrix": [
                {
                    "key": "replicas",
                    "by_customer": {
                        "AWS/a": {"display": "3", "is_missing": False},
                        "Azure/b": {"display": "—", "is_missing": True},
                    },
                }
            ],
        }
        text = build_service_dive_nl_context(dive)
        self.assertIn("mysvc", text)
        self.assertIn("replicas", text)
        self.assertIn("AWS/a", text)


class TestCallGeminiNlFilter(unittest.TestCase):
    def test_parses_json_response(self) -> None:
        fake_body = {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "text": json.dumps(
                                    {
                                        "keyQ": "cpu",
                                        "custQ": "",
                                        "kvKey": "resources",
                                        "kvValue": "500m",
                                        "cloud": "both",
                                        "segment": "all",
                                        "explanation": "Mapped CPU limit.",
                                    }
                                )
                            }
                        ]
                    }
                }
            ]
        }

        class FakeResp:
            def __enter__(self) -> FakeResp:
                return self

            def __exit__(self, *args: object) -> None:
                pass

            def read(self) -> bytes:
                return json.dumps(fake_body).encode("utf-8")

        with patch("backend.gemini_nl.urllib.request.urlopen", return_value=FakeResp()):
            out, model_used = call_gemini_nl_filter("AIza-test", "show cpu 500m", "ctx")

        self.assertEqual(model_used, "gemini-2.5-flash-lite")
        self.assertEqual(out["kvValue"], "500m")
        self.assertEqual(out["explanation"], "Mapped CPU limit.")

    def test_fallback_on_429(self) -> None:
        fake_ok = {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "text": json.dumps(
                                    {
                                        "keyQ": "",
                                        "custQ": "",
                                        "kvKey": "",
                                        "kvValue": "",
                                        "cloud": "both",
                                        "segment": "all",
                                        "explanation": "ok",
                                    }
                                )
                            }
                        ]
                    }
                }
            ]
        }

        class OkResp:
            def __enter__(self) -> OkResp:
                return self

            def __exit__(self, *args: object) -> None:
                pass

            def read(self) -> bytes:
                return json.dumps(fake_ok).encode("utf-8")

        fp429 = io.BytesIO(b'{"error":{"code":429}}')
        err429 = urllib.error.HTTPError("http://t", 429, "Too Many", {}, fp429)

        calls: list[str] = []

        def urlopen_side_effect(req, timeout=None):  # noqa: ANN001
            u = req.get_full_url() if hasattr(req, "get_full_url") else str(req)
            if "gemini-2.5-flash-lite" in u:
                calls.append("lite")
                raise err429
            calls.append("flash")
            return OkResp()

        with patch("backend.gemini_nl.urllib.request.urlopen", side_effect=urlopen_side_effect):
            out, model_used = call_gemini_nl_filter("AIza-test", "x", "ctx")

        self.assertEqual(calls, ["lite", "flash"])
        self.assertEqual(model_used, "gemini-2.5-flash")
        self.assertEqual(out["explanation"], "ok")


if __name__ == "__main__":
    unittest.main()
