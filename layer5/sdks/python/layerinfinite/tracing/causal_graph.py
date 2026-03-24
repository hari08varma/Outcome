from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class FieldAccess:
    action_id:  str
    field_path: str
    value:      Any
    depth:      int
    confidence: float
    timestamp:  float = field(default_factory=time.time)


@dataclass
class Comparison:
    action_id:  str
    field_path: str
    value:      Any
    op:         str   # 'eq', 'ne', 'lt', 'gt', 'le', 'ge', 'bool', 'coerce_str', etc.
    result:     bool
    timestamp:  float = field(default_factory=time.time)


class CausalGraph:
    def __init__(self) -> None:
        self.field_accesses: list[FieldAccess] = []
        self.comparisons:    list[Comparison]  = []

    def record_field_access(self, access: FieldAccess) -> None:
        self.field_accesses.append(access)

    def record_comparison(self, comp: Comparison) -> None:
        self.comparisons.append(comp)

    def derive_outcome(self) -> tuple[bool | None, float]:
        """
        Returns (success, confidence).
        - Empty graph          → (None, 0.0)
        - Field accesses only  → (None, 0.5)
        - Has comparisons      → majority-vote success, mean confidence of
                                 field accesses whose field_path matched a comparison
        """
        if not self.comparisons:
            if self.field_accesses:
                return None, 0.5
            return None, 0.0

        true_count = sum(1 for c in self.comparisons if c.result)
        total      = len(self.comparisons)
        success    = true_count > total / 2

        comparison_paths = {c.field_path for c in self.comparisons}
        matched = [
            fa.confidence for fa in self.field_accesses
            if fa.field_path in comparison_paths
        ]
        confidence = sum(matched) / len(matched) if matched else 0.5
        return success, confidence
