"""SQLite persistence for scan results."""

from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Generator, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    source_files TEXT NOT NULL,
    merged_json TEXT NOT NULL,
    scan_epoch REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
"""


@contextmanager
def connect(db_path: Path) -> Generator[sqlite3.Connection, None, None]:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(SCHEMA)
        yield conn
        conn.commit()
    finally:
        conn.close()


def meta_set(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def meta_get(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    if row is None:
        return default
    return row["value"]


def replace_customers(
    conn: sqlite3.Connection,
    rows: list[tuple[str, list[dict[str, Any]], dict[str, Any]]],
) -> None:
    """rows: (customer_name, files_meta, merged_dict)"""
    conn.execute("DELETE FROM customers")
    epoch = time.time()
    for name, files_meta, merged in rows:
        conn.execute(
            "INSERT INTO customers(name, source_files, merged_json, scan_epoch) VALUES(?,?,?,?)",
            (name, json.dumps(files_meta), json.dumps(merged, default=str), epoch),
        )


def list_customers(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    cur = conn.execute(
        "SELECT name, source_files, scan_epoch FROM customers ORDER BY name COLLATE NOCASE"
    )
    return [dict(r) for r in cur.fetchall()]


def get_customer(conn: sqlite3.Connection, name: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT name, source_files, merged_json, scan_epoch FROM customers WHERE name = ?",
        (name,),
    ).fetchone()
    if row is None:
        return None
    return {
        "name": row["name"],
        "source_files": json.loads(row["source_files"]),
        "merged": json.loads(row["merged_json"]),
        "scan_epoch": row["scan_epoch"],
    }


def all_merged(conn: sqlite3.Connection) -> Iterator[tuple[str, dict[str, Any]]]:
    cur = conn.execute("SELECT name, merged_json FROM customers ORDER BY name COLLATE NOCASE")
    for row in cur.fetchall():
        yield row["name"], json.loads(row["merged_json"])
