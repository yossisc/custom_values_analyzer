#!/usr/bin/env python3
"""
Local HTTP server for the Custom Values Analyzer.

Chrome cannot reliably load this app from file:// (fetch/CORS). Run:

    ./run.sh          # creates .venv, installs deps, starts server
    python server.py  # if deps already installed

Then open http://127.0.0.1:8765/
"""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
import urllib.parse
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

VERSION = "2.0.6"

from backend.api_payloads import (  # noqa: E402
    compute_anomaly,
    customer_public_view,
    dashboard_matrix,
    matrix_csv,
    meta_bundle,
    service_dive,
    service_public_view,
    customer_yaml_diff_payload,
    service_yaml_diff_payload,
    services_list_payload,
)
from backend.config import (  # noqa: E402
    DB_PATH,
    PID_FILE,
    base_values_path,
    clear_saved_gemini_api_key_file,
    customers_root,
    ensure_data_dir,
    resolve_gemini_api_key,
    save_gemini_api_key_to_data_file,
    save_user_config,
    saved_gemini_key_path,
    set_user_gemini_key_file,
    user_config_gemini_key_file_path,
)
from backend.db import connect, list_customers  # noqa: E402
from backend.gemini_nl import build_service_dive_nl_context, call_gemini_nl_filter  # noqa: E402
from backend.prometheus_versions import (  # noqa: E402
    fetch_k8s_version_points,
    fetch_version_points,
)
from backend.scan import run_scan_to_db  # noqa: E402

# Module-level server reference so /api/stop can shut it down
_httpd: ThreadingHTTPServer | None = None


def _gemini_status_payload() -> dict:
    key, source = resolve_gemini_api_key()
    return {
        "configured": key is not None,
        "source": source,
        "saved_key_file_exists": saved_gemini_key_path().is_file(),
        "user_key_file_configured": user_config_gemini_key_file_path() is not None,
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self) -> None:
        # Disable caching for all static files so changes are always picked up
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _json(self, obj: object, status: int = HTTPStatus.OK) -> None:
        data = json.dumps(obj, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _text(self, body: str, content_type: str, status: int = HTTPStatus.OK) -> None:
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ------------------------------------------------------------------ GET --

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/config":
            self._json({
                "customers_root": str(customers_root()),
                "base_values": str(base_values_path()),
            })
            return

        if path == "/api/about":
            self._json({
                "version": VERSION,
                "name": "Custom Values Analyzer",
                "description": "Browse and analyze Helm custom_values YAML across AWS and Azure customers.",
                "features": [
                    "Scan — read-only scan of customer trees merged with base values.yaml",
                    "Matrix — service × customer grid with enabled/disabled status and YAML hover",
                    "Customers — browse merged YAML per customer",
                    "Services — browse merged YAML per service across all customers",
                    "Service Dive — 2nd-level key × customer matrix with modal/outlier analysis",
                    "Service Dive AI (2.0+) — optional Gemini natural-language → same structured filters (BYO API key)",
                    "Service Dive — Diff 2 customers (matrix columns); YamlDiff side-by-side service YAML (stdlib difflib)",
                    "Compare 2 customers — full merged values.yaml diff (side-by-side)",
                    "Anomaly — find customers or services with unusually few enabled/disabled entries",
                    "GB_Versions — core customers only, glassboxVersion × Customer; K8S_Versions — cluster/k8s_version/region × Customer; row/column header click highlight; 30s query timeout",
                    "Key+Value filter — find customers by specific config key values",
                    "Cloud filter — AWS / Azure / Both toggle on matrix views",
                    "Core / others — filter by segment service (default: clingine) enabled on the customer",
                    "Click-to-pin — click any matrix cell to pin its YAML tooltip for copy/paste",
                    "CSV export — download the main matrix as CSV",
                    "Paths — override customers root and base values from Home (saved under data/)",
                ],
                "tech": "Python 3 + PyYAML + SQLite + vanilla HTML/JS/CSS + highlight.js",
                "source_paths": {
                    "customers_root": str(customers_root()),
                    "base_values": str(base_values_path()),
                },
            })
            return

        if path == "/api/meta":
            ensure_data_dir()
            pid = os.getpid()
            if not DB_PATH.is_file():
                self._json({"has_data": False, "pid": pid, "meta": {}})
                return
            with connect(DB_PATH) as conn:
                self._json({"has_data": True, "pid": pid, "meta": meta_bundle(conn)})
            return

        if path == "/api/customers":
            if not DB_PATH.is_file():
                self._json([])
                return
            with connect(DB_PATH) as conn:
                rows = list_customers(conn)
            out = []
            for r in rows:
                files = json.loads(r["source_files"])
                out.append(
                    {
                        "name": r["name"],
                        "file_count": len(files),
                        "files": [f["name"] for f in files],
                        "scan_epoch": r["scan_epoch"],
                        "core": bool(r.get("core_segment", 0)),
                    }
                )
            self._json(out)
            return

        if path == "/api/customer":
            qs = urllib.parse.parse_qs(parsed.query)
            name = (qs.get("name") or [""])[0]
            if not name:
                self._json({"error": "missing name"}, HTTPStatus.BAD_REQUEST)
                return
            if not DB_PATH.is_file():
                self._json({"error": "no database"}, HTTPStatus.NOT_FOUND)
                return
            with connect(DB_PATH) as conn:
                row = customer_public_view(conn, name)
            if row is None:
                self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
                return
            self._json(row)
            return

        if path == "/api/services":
            if not DB_PATH.is_file():
                self._json(
                    {
                        "core_service_key": "",
                        "customer_core": {},
                        "services": [],
                    }
                )
                return
            with connect(DB_PATH) as conn:
                self._json(services_list_payload(conn))
            return

        if path == "/api/service":
            qs = urllib.parse.parse_qs(parsed.query)
            name = (qs.get("name") or [""])[0]
            if not name:
                self._json({"error": "missing name"}, HTTPStatus.BAD_REQUEST)
                return
            if not DB_PATH.is_file():
                self._json({"error": "no database"}, HTTPStatus.NOT_FOUND)
                return
            with connect(DB_PATH) as conn:
                row = service_public_view(conn, name)
            if row is None:
                self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
                return
            self._json(row)
            return

        if path == "/api/dashboard":
            if not DB_PATH.is_file():
                self._json({"customer_names": [], "service_keys": [], "matrix": []})
                return
            with connect(DB_PATH) as conn:
                self._json(dashboard_matrix(conn))
            return

        if path == "/api/anomaly":
            qs = urllib.parse.parse_qs(parsed.query)
            entity = (qs.get("entity") or ["customers"])[0]
            color = (qs.get("color") or ["green"])[0]
            segment = (qs.get("segment") or ["all"])[0]
            if segment not in ("all", "core", "other"):
                segment = "all"
            try:
                threshold = int((qs.get("threshold") or ["5"])[0])
            except ValueError:
                threshold = 5
            if not DB_PATH.is_file():
                self._json([])
                return
            with connect(DB_PATH) as conn:
                self._json(compute_anomaly(conn, entity, threshold, color, segment))
            return

        if path == "/api/service-dive":
            qs = urllib.parse.parse_qs(parsed.query)
            name = (qs.get("service") or [""])[0]
            if not name:
                self._json({"error": "missing service"}, HTTPStatus.BAD_REQUEST)
                return
            if not DB_PATH.is_file():
                self._json({"error": "no database"}, HTTPStatus.NOT_FOUND)
                return
            with connect(DB_PATH) as conn:
                row = service_dive(conn, name)
            if row is None:
                self._json({"error": "service not found"}, HTTPStatus.NOT_FOUND)
                return
            self._json(row)
            return

        if path == "/api/service-yaml-diff":
            qs = urllib.parse.parse_qs(parsed.query)
            svc = (qs.get("service") or [""])[0]
            ca = (qs.get("customer_a") or [""])[0]
            cb = (qs.get("customer_b") or [""])[0]
            mode = (qs.get("mode") or ["diff"])[0]
            if mode not in ("diff", "all"):
                mode = "diff"
            if not svc:
                self._json({"error": "missing service"}, HTTPStatus.BAD_REQUEST)
                return
            if not DB_PATH.is_file():
                self._json({"error": "no database"}, HTTPStatus.NOT_FOUND)
                return
            with connect(DB_PATH) as conn:
                out = service_yaml_diff_payload(conn, svc, ca, cb, mode=mode)
            if "error" in out:
                self._json(out, HTTPStatus.BAD_REQUEST)
                return
            self._json(out)
            return

        if path == "/api/customer-yaml-diff":
            qs = urllib.parse.parse_qs(parsed.query)
            ca = (qs.get("customer_a") or [""])[0]
            cb = (qs.get("customer_b") or [""])[0]
            mode = (qs.get("mode") or ["diff"])[0]
            if mode not in ("diff", "all"):
                mode = "diff"
            if not ca or not cb:
                self._json({"error": "missing customer"}, HTTPStatus.BAD_REQUEST)
                return
            if not DB_PATH.is_file():
                self._json({"error": "no database"}, HTTPStatus.NOT_FOUND)
                return
            with connect(DB_PATH) as conn:
                out = customer_yaml_diff_payload(conn, ca, cb, mode=mode)
            if "error" in out:
                self._json(out, HTTPStatus.BAD_REQUEST)
                return
            self._json(out)
            return

        if path == "/api/export/matrix.csv":
            if not DB_PATH.is_file():
                self._text("", "text/csv", HTTPStatus.NOT_FOUND)
                return
            qs = urllib.parse.parse_qs(parsed.query)
            segment = (qs.get("segment") or ["all"])[0]
            if segment not in ("all", "core", "other"):
                segment = "all"
            with connect(DB_PATH) as conn:
                csv_body = matrix_csv(conn, segment)
            self._text(csv_body, "text/csv; charset=utf-8")
            return

        if path == "/api/gemini/status":
            self._json(_gemini_status_payload())
            return

        if path == "/api/glassbox-versions":
            points, err = fetch_version_points()
            if err:
                status = (
                    HTTPStatus.GATEWAY_TIMEOUT
                    if "timed out" in err.lower()
                    else HTTPStatus.BAD_GATEWAY
                )
                self._json({"error": err}, status)
                return
            self._json({"points": points})
            return

        if path == "/api/k8s-versions":
            points, err = fetch_k8s_version_points()
            if err:
                status = (
                    HTTPStatus.GATEWAY_TIMEOUT
                    if "timed out" in err.lower()
                    else HTTPStatus.BAD_GATEWAY
                )
                self._json({"error": err}, status)
                return
            self._json({"points": points})
            return

        return SimpleHTTPRequestHandler.do_GET(self)

    # ----------------------------------------------------------------- POST --

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length > 0 else b""

        if parsed.path == "/api/scan":
            try:
                report = run_scan_to_db(DB_PATH)
            except Exception as ex:  # noqa: BLE001
                self._json({"ok": False, "error": str(ex)}, HTTPStatus.INTERNAL_SERVER_ERROR)
                return
            self._json(
                {
                    "ok": bool(report.get("ok", True)),
                    "customers_scanned": report.get("customers_scanned", 0),
                    "service_keys": report.get("service_keys", []),
                    "errors": report.get("errors", []),
                    "customers_root": report.get("customers_root"),
                    "base_values_path": report.get("base_values_path"),
                }
            )
            return

        if parsed.path == "/api/config":
            try:
                payload = json.loads(body or b"{}")
            except Exception:
                self._json({"ok": False, "error": "invalid JSON"}, HTTPStatus.BAD_REQUEST)
                return
            cr = payload.get("customers_root", "").strip()
            bv = payload.get("base_values", "").strip()
            if not cr or not bv:
                self._json({"ok": False, "error": "both paths required"}, HTTPStatus.BAD_REQUEST)
                return
            save_user_config(cr, bv)
            self._json({
                "ok": True,
                "customers_root": str(customers_root()),
                "base_values": str(base_values_path()),
            })
            return

        if parsed.path == "/api/stop":
            pid = os.getpid()
            self._json({"ok": True, "pid": pid, "message": f"Server (PID {pid}) is stopping…"})

            def _shutdown_soon() -> None:
                import time
                time.sleep(0.4)
                try:
                    PID_FILE.unlink(missing_ok=True)
                except Exception:  # noqa: BLE001
                    pass
                if _httpd:
                    _httpd.shutdown()

            threading.Thread(target=_shutdown_soon, daemon=True).start()
            return

        if parsed.path == "/api/gemini/settings":
            try:
                payload = json.loads(body or b"{}")
            except Exception:
                self._json({"ok": False, "error": "invalid JSON"}, HTTPStatus.BAD_REQUEST)
                return
            if payload.get("clear_saved_key"):
                clear_saved_gemini_api_key_file()
            apk = payload.get("api_key")
            if isinstance(apk, str) and apk.strip():
                save_gemini_api_key_to_data_file(apk.strip())
            if "gemini_key_file" in payload or "openai_key_file" in payload:
                v = payload.get("gemini_key_file")
                if v is None:
                    v = payload.get("openai_key_file")
                if v is None or (isinstance(v, str) and not str(v).strip()):
                    set_user_gemini_key_file(None)
                elif isinstance(v, str):
                    set_user_gemini_key_file(v.strip())
            out = _gemini_status_payload()
            out["ok"] = True
            self._json(out)
            return

        if parsed.path == "/api/service-dive/nl-filter":
            try:
                payload = json.loads(body or b"{}")
            except Exception:
                self._json({"ok": False, "error": "invalid JSON"}, HTTPStatus.BAD_REQUEST)
                return
            svc = (payload.get("service") or "").strip()
            query = (payload.get("query") or "").strip()
            if not svc:
                self._json({"ok": False, "error": "missing service"}, HTTPStatus.BAD_REQUEST)
                return
            if not query:
                self._json({"ok": False, "error": "missing query"}, HTTPStatus.BAD_REQUEST)
                return
            if not DB_PATH.is_file():
                self._json({"ok": False, "error": "no database"}, HTTPStatus.NOT_FOUND)
                return
            api_key, _src = resolve_gemini_api_key()
            if not api_key:
                self._json(
                    {
                        "ok": False,
                        "error": "Gemini API key not configured. Set GEMINI_API_KEY or "
                        "GOOGLE_API_KEY, GEMINI_API_KEY_FILE / GOOGLE_API_KEY_FILE, save a key "
                        "under data/.gemini_api_key, or set gemini_key_file in the UI / "
                        "user_config.json.",
                    },
                    HTTPStatus.BAD_REQUEST,
                )
                return
            with connect(DB_PATH) as conn:
                dive = service_dive(conn, svc)
            if dive is None:
                self._json({"ok": False, "error": "service not found"}, HTTPStatus.NOT_FOUND)
                return
            ctx = build_service_dive_nl_context(dive)
            try:
                filt, model_used = call_gemini_nl_filter(api_key, query, ctx)
            except (RuntimeError, ValueError) as ex:
                self._json({"ok": False, "error": str(ex)}, HTTPStatus.BAD_GATEWAY)
                return
            self._json({"ok": True, "filter": filt, "model": model_used})
            return

        self.send_error(HTTPStatus.NOT_FOUND)


# ----------------------------------------------------------------- helpers ---

def _port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex((host, port)) == 0


def main() -> None:
    global _httpd
    ensure_data_dir()
    host = "127.0.0.1"
    port = 8765

    if _port_in_use(host, port):
        url = f"http://{host}:{port}/"
        print(f"Server is already running at {url}", file=sys.stderr)
        print("Stop it first (Ctrl+C in its terminal, or use the Stop button on the Home page).", file=sys.stderr)
        sys.exit(1)

    _httpd = ThreadingHTTPServer((host, port), Handler)
    pid = os.getpid()
    PID_FILE.write_text(str(pid))
    print(f"PID: {pid}  |  to stop: kill {pid}  or  Ctrl+C  or  use the Stop button in the browser")
    print(f"Serving http://{host}:{port}/  (Ctrl+C to stop)")

    try:
        _httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        _httpd.shutdown()
        try:
            PID_FILE.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    main()
