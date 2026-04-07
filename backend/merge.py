"""Deep-merge Helm-style YAML dicts (customer overlays on base)."""

from __future__ import annotations

import copy
from typing import Any, Mapping


def deep_merge(base: Any, override: Any) -> Any:
    if isinstance(base, Mapping) and isinstance(override, Mapping):
        out = dict(copy.deepcopy(base))
        for k, v in override.items():
            if k in out and isinstance(out[k], Mapping) and isinstance(v, Mapping):
                out[k] = deep_merge(out[k], v)
            else:
                out[k] = copy.deepcopy(v)
        return out
    return copy.deepcopy(override)
