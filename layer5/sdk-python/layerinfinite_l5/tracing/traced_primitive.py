"""
PYTHON CHALLENGE 2 — TAG SURVIVAL THROUGH TYPE CONVERSION

Python's str() builtin enforces a plain str return from __str__.
If __str__ returns a TracedPrimitive, Python raises TypeError.

CORRECT Python behaviour:
  - Direct comparisons  → result.status == "succeeded"  → __eq__ fires → TRACKED
  - Coerced comparisons → str(result.status) == "..."   → tag retired  → HTTP fallback
  - This is IDENTICAL to TypeScript depth > MAX_DEPTH tag retirement.

PYTHON CHALLENGE 1 — TYPE SYSTEM RESISTANCE

Python primitives (str, int, bool) cannot be subclassed without breaking
equality semantics. TracedPrimitive is a WRAPPER class, not a subclass.
Agents NEVER see it — it only lives inside TracedResponse field access.
"""
from __future__ import annotations

import time
from typing import Any, Union

from .causal_graph import CausalGraph, Comparison

MAX_DEPTH       = 8
CONFIDENCE_BASE = 0.90
DECAY_RATE      = 0.04


def compute_confidence(depth: int) -> float:
    if depth > MAX_DEPTH:
        return 0.0
    return max(0.0, CONFIDENCE_BASE - depth * DECAY_RATE)


class TracedPrimitive:
    """
    Wraps a str/int/float/bool primitive.
    Intercepts comparisons via magic methods — records to CausalGraph.

    TRACKED:
      if result.status == "succeeded"     ← __eq__ fires
      if result.score >= result.threshold ← __ge__ fires
      if result.ok                        ← __bool__ fires

    NOT TRACKED (tag retired at coercion — Python Challenge 2):
      s = str(result.status)              ← plain str returned, tag lost
    """

    def __init__(
        self,
        value: Union[str, int, float, bool],
        provenance: dict[str, Any],
        graph: CausalGraph,
    ) -> None:
        self._value      = value
        self._provenance = provenance
        self._graph      = graph

    # ── Internal: record a comparison ─────────────────────────────
    def _record(self, op: str, result: bool) -> None:
        try:
            self._graph.record_comparison(Comparison(
                action_id  = self._provenance['action_id'],
                field_path = self._provenance['field_path'],
                value      = self._value,
                op         = op,
                result     = result,
                timestamp  = time.time(),
            ))
        except Exception:
            pass  # graph recording never raises

    # ── Comparison operators — FULLY TRACKED ──────────────────────
    def __eq__(self, other: Any) -> bool:
        real = self._value == (other._value if isinstance(other, TracedPrimitive) else other)
        self._record('eq', bool(real))
        return bool(real)

    def __ne__(self, other: Any) -> bool:
        real = self._value != (other._value if isinstance(other, TracedPrimitive) else other)
        self._record('ne', bool(real))
        return bool(real)

    def __lt__(self, other: Any) -> bool:
        real = self._value < (other._value if isinstance(other, TracedPrimitive) else other)  # type: ignore[operator]
        self._record('lt', bool(real))
        return bool(real)

    def __le__(self, other: Any) -> bool:
        real = self._value <= (other._value if isinstance(other, TracedPrimitive) else other)  # type: ignore[operator]
        self._record('le', bool(real))
        return bool(real)

    def __gt__(self, other: Any) -> bool:
        real = self._value > (other._value if isinstance(other, TracedPrimitive) else other)  # type: ignore[operator]
        self._record('gt', bool(real))
        return bool(real)

    def __ge__(self, other: Any) -> bool:
        real = self._value >= (other._value if isinstance(other, TracedPrimitive) else other)  # type: ignore[operator]
        self._record('ge', bool(real))
        return bool(real)

    def __bool__(self) -> bool:
        real = bool(self._value)
        self._record('bool', real)
        return real

    # ── Type coercions — TAG RETIRED AT BOUNDARY ──────────────────
    def __str__(self) -> str:
        # Python enforces plain str return — tag retired here.
        # Records coerce_str so pipeline knows tag was retired.
        self._record('coerce_str', bool(self._value))
        return str(self._value)

    def __int__(self) -> int:
        self._record('coerce_int', bool(self._value))
        return int(self._value)  # type: ignore[arg-type]

    def __float__(self) -> float:
        self._record('coerce_float', bool(self._value))
        return float(self._value)  # type: ignore[arg-type]

    # ── Utility ───────────────────────────────────────────────────
    def __hash__(self) -> int:
        return hash(self._value)

    def __repr__(self) -> str:
        return repr(self._value)

    @property
    def raw(self) -> Any:
        """Unwrap to plain Python value. For internal pipeline use only."""
        return self._value
