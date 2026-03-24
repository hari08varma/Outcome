from __future__ import annotations

import time
from typing import Any

from .causal_graph import CausalGraph, FieldAccess
from .traced_primitive import TracedPrimitive, compute_confidence, MAX_DEPTH


class TracedResponse:
    """
    Wraps a dict (JSON response body) or response-like object.
    __getattr__ intercepts every field access.
    Nested dicts    → nested TracedResponse.
    Primitive values → TracedPrimitive.
    Depth increments at each nesting level.
    """

    def __init__(
        self,
        data: Any,
        provenance: dict[str, Any],
        graph: CausalGraph,
    ) -> None:
        # Use object.__setattr__ to avoid triggering our own __setattr__
        object.__setattr__(self, '_data',       data)
        object.__setattr__(self, '_provenance', provenance)
        object.__setattr__(self, '_graph',      graph)

    def __getattr__(self, name: str) -> Any:
        data       = object.__getattribute__(self, '_data')
        provenance = object.__getattribute__(self, '_provenance')
        graph      = object.__getattribute__(self, '_graph')

        # Support both dict and object attribute access
        if isinstance(data, dict):
            if name not in data:
                raise AttributeError(f"No field '{name}'")
            value = data[name]
        else:
            value = getattr(data, name)

        depth      = provenance.get('depth', 0)
        confidence = compute_confidence(depth)

        child_prov = {**provenance, 'field_path': name, 'depth': depth + 1}

        graph.record_field_access(FieldAccess(
            action_id  = provenance['action_id'],
            field_path = name,
            value      = value,
            depth      = depth,
            confidence = confidence,
            timestamp  = time.time(),
        ))

        if confidence == 0.0:
            # Tag retired — return raw value
            return value

        if isinstance(value, dict):
            return TracedResponse(value, child_prov, graph)
        elif isinstance(value, (str, int, float, bool)):
            return TracedPrimitive(value, child_prov, graph)
        else:
            return value

    def __getitem__(self, key: Any) -> Any:
        """Support data['key'] access in addition to data.key"""
        return self.__getattr__(str(key))

    def get(self, key: str, default: Any = None) -> Any:
        try:
            return self.__getattr__(key)
        except (AttributeError, KeyError):
            return default
