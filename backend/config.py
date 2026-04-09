"""Paths and defaults — sources are read-only; only the app data dir is written."""

from __future__ import annotations

import json
import os
from pathlib import Path

# Hardcoded defaults (used when no user config and no env var)
DEFAULT_CUSTOMERS_ROOT = Path.home() / "work" / "st_customers"
DEFAULT_BASE_VALUES = Path.home() / "work" / "helm" / "glassbox" / "values.yaml"

CLOUD_SUBDIRS = ("AWS", "Azure")

# Top-level Helm service key used for Core vs Other customer segmentation (enabled: true → Core).
# Override with env if your chart uses a different key (e.g. cronjobs.foo).
CORE_SEGMENT_SERVICE_KEY = os.environ.get("CVA_CORE_SERVICE", "clingine")

# App workspace (this repo)
APP_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = APP_ROOT / "data"
DB_PATH = DATA_DIR / "analyzer.db"
PID_FILE = DATA_DIR / "server.pid"
USER_CONFIG_FILE = DATA_DIR / "user_config.json"


def ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _load_user_config() -> dict:
    if USER_CONFIG_FILE.is_file():
        try:
            return json.loads(USER_CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return {}
    return {}


def save_user_config(customers_root_str: str, base_values_str: str) -> None:
    ensure_data_dir()
    cfg = _load_user_config()
    cfg["customers_root"] = customers_root_str
    cfg["base_values"] = base_values_str
    USER_CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def _resolve(env_name: str, config_key: str, default: Path) -> Path:
    """Priority: env var > user_config.json > hardcoded default."""
    env = os.environ.get(env_name)
    if env:
        return Path(env).expanduser()
    cfg = _load_user_config()
    val = cfg.get(config_key)
    if val:
        return Path(val).expanduser()
    return default


def customers_root() -> Path:
    return _resolve("CVA_CUSTOMERS_ROOT", "customers_root", DEFAULT_CUSTOMERS_ROOT)


def base_values_path() -> Path:
    return _resolve("CVA_BASE_VALUES", "base_values", DEFAULT_BASE_VALUES)
