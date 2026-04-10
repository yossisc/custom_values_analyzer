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


# ── Google Gemini API key (local dev; never commit secrets) ─────────────────
# Resolution order — see resolve_gemini_api_key():
#   1. GEMINI_API_KEY env
#   2. GOOGLE_API_KEY env
#   3. GEMINI_API_KEY_FILE / GOOGLE_API_KEY_FILE (first non-empty line)
#   4. user_config.json "gemini_key_file" (then legacy "openai_key_file")
#   5. data/.gemini_api_key (then legacy data/.openai_api_key)
#   6. data/.api_key

GEMINI_KEY_BASENAME = ".gemini_api_key"
LEGACY_OPENAI_KEY_BASENAME = ".openai_api_key"
GENERIC_KEY_BASENAME = ".api_key"


def _read_first_line_key_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    for line in raw.splitlines():
        s = line.strip()
        if s:
            return s
    return None


def saved_gemini_key_path() -> Path:
    return DATA_DIR / GEMINI_KEY_BASENAME


def user_config_gemini_key_file_path() -> Path | None:
    cfg = _load_user_config()
    p = cfg.get("gemini_key_file") or cfg.get("openai_key_file")
    if not p or not str(p).strip():
        return None
    return Path(str(p).strip()).expanduser()


def set_user_gemini_key_file(path_str: str | None) -> None:
    """Persist optional path to a key file (or clear when None/empty)."""
    ensure_data_dir()
    cfg = _load_user_config()
    cfg.pop("openai_key_file", None)
    if path_str is None or not str(path_str).strip():
        cfg.pop("gemini_key_file", None)
    else:
        cfg["gemini_key_file"] = str(path_str).strip()
    USER_CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def save_gemini_api_key_to_data_file(api_key: str) -> None:
    """Write key to data/.gemini_api_key (chmod 600 on POSIX)."""
    ensure_data_dir()
    path = saved_gemini_key_path()
    key = api_key.strip()
    path.write_text(key + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except (OSError, NotImplementedError):
        pass


def clear_saved_gemini_api_key_file() -> None:
    for name in (GEMINI_KEY_BASENAME, LEGACY_OPENAI_KEY_BASENAME, GENERIC_KEY_BASENAME):
        p = DATA_DIR / name
        try:
            p.unlink(missing_ok=True)
        except OSError:
            pass


def resolve_gemini_api_key() -> tuple[str | None, str]:
    """
    Return (api_key, source) where source is one of:
    env, google_env, env_file, google_env_file, user_file,
    data_file, legacy_data_file, alt_data_file, none
    """
    env_k = os.environ.get("GEMINI_API_KEY", "").strip()
    if env_k:
        return env_k, "env"

    g = os.environ.get("GOOGLE_API_KEY", "").strip()
    if g:
        return g, "google_env"

    env_path = os.environ.get("GEMINI_API_KEY_FILE", "").strip()
    if env_path:
        k = _read_first_line_key_file(Path(env_path).expanduser())
        if k:
            return k, "env_file"

    gpath = os.environ.get("GOOGLE_API_KEY_FILE", "").strip()
    if gpath:
        k = _read_first_line_key_file(Path(gpath).expanduser())
        if k:
            return k, "google_env_file"

    u = user_config_gemini_key_file_path()
    if u is not None:
        k = _read_first_line_key_file(u)
        if k:
            return k, "user_file"

    k = _read_first_line_key_file(saved_gemini_key_path())
    if k:
        return k, "data_file"

    k = _read_first_line_key_file(DATA_DIR / LEGACY_OPENAI_KEY_BASENAME)
    if k:
        return k, "legacy_data_file"

    k = _read_first_line_key_file(DATA_DIR / GENERIC_KEY_BASENAME)
    if k:
        return k, "alt_data_file"

    return None, "none"


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
