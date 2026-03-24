from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass, field

from .causal_graph import CausalGraph


@dataclass
class ExecutionContext:
    action_id:   str
    action_name: str
    graph:       CausalGraph = field(default_factory=CausalGraph)


# Single ContextVar — propagates through async coroutines automatically.
# Each instrument() call sets a NEW token; restored via reset_context().
_execution_store: ContextVar[ExecutionContext | None] = ContextVar(
    'layerinfinite_exec_ctx', default=None
)


def get_current_context() -> ExecutionContext | None:
    return _execution_store.get()


def set_context(ctx: ExecutionContext) -> Token:  # type: ignore[type-arg]
    """Returns the token needed to reset later."""
    return _execution_store.set(ctx)


def reset_context(token: Token) -> None:  # type: ignore[type-arg]
    _execution_store.reset(token)
