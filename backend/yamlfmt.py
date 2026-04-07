"""Serialize Python structures (from YAML/JSON) back to YAML text for display."""

from __future__ import annotations

from typing import Any

import yaml

# Matrix hover / per-customer service blocks
TOOLTIP_YAML_MAX = 12_000
# Full merged customer document (soft cap)
MERGED_YAML_MAX = 2_000_000


def dump_yaml(data: Any, *, max_len: int | None = TOOLTIP_YAML_MAX) -> str:
    try:
        s = yaml.dump(
            data,
            default_flow_style=False,
            allow_unicode=True,
            sort_keys=False,
            width=100,
        )
    except Exception:  # noqa: BLE001
        s = f"# (could not serialize to YAML)\n{data!r}\n"
    if max_len is not None and len(s) > max_len:
        s = s[:max_len] + "\n# … (truncated)\n"
    return s
