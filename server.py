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

VERSION = "1.0.12"

from backend.api_payloads import (  # noqa: E402
    compute_anomaly,
    customer_public_view,
    dashboard_matrix,
    list_service_names,
    matrix_csv,
    meta_bundle,
    service_dive,
    service_public_view,
)
from backend.config import (  # noqa: E402
    DB_PATH,
    PID_FILE,
    base_values_path,
    customers_root,
    ensure_data_dir,
    save_user_config,
)
from backend.db import connect, list_customers  # noqa: E402
from backend.scan import run_scan_to_db  # noqa: E402

# Module-level server reference so /api/stop can shut it down
_httpd: ThreadingHTTPServer | None = None


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
                    "Scan — read-only scan of ~/work/st_customers/{AWS,Azure}/ merged with base values.yaml",
                    "Matrix — service × customer grid with enabled/disabled status and YAML hover",
                    "Customers — browse merged YAML per customer",
                    "Services — browse merged YAML per service across all customers",
                    "Anomaly — find customers or services with unusually few enabled/disabled entries",
                    "Service Dive — 2nd-level key × customer matrix with modal/outlier analysis",
                    "Key+Value filter — find customers by specific config key values",
                    "Cloud filter — AWS / Azure / Both toggle on all matrix views",
                    "Click-to-pin — click any matrix cell to pin its YAML tooltip for copy/paste",
                    "CSV export — download the main matrix as CSV",
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
                self._json([])
                return
            with connect(DB_PATH) as conn:
                self._json(list_service_names(conn))
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
            try:
                threshold = int((qs.get("threshold") or ["5"])[0])
            except ValueError:
                threshold = 5
            if not DB_PATH.is_file():
                self._json([])
                return
            with connect(DB_PATH) as conn:
                self._json(compute_anomaly(conn, entity, threshold, color))
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

        if path == "/api/export/matrix.csv":
            if not DB_PATH.is_file():
                self._text("", "text/csv", HTTPStatus.NOT_FOUND)
                return
            with connect(DB_PATH) as conn:
                csv_body = matrix_csv(conn)
            self._text(csv_body, "text/csv; charset=utf-8")
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
