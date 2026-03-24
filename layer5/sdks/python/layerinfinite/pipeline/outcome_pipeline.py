"""
Receives ExecutionContext objects from IOInterceptor.
Derives outcome from CausalGraph.
Calls client.log_outcome() fire-and-forget via daemon thread.
Uses queue.SimpleQueue — no size limit, no blocking.
"""
from __future__ import annotations

import queue
import threading
import time
from dataclasses import dataclass
from typing import Any

from ..tracing.execution_context import ExecutionContext


@dataclass
class PendingItem:
    ctx:         ExecutionContext
    http_status: int
    queued_at:   float


class OutcomePipeline:
    def __init__(self, client: Any) -> None:
        self._client:  Any                              = client
        self._queue:   queue.SimpleQueue[PendingItem]   = queue.SimpleQueue()
        self._started: bool                             = False

    def push(self, ctx: ExecutionContext, http_status: int) -> None:
        """Called by interceptor — never blocks, never raises."""
        try:
            self._queue.put_nowait(PendingItem(ctx, http_status, time.time()))
        except Exception:
            pass

    def start(self) -> None:
        """Start background daemon thread to drain the queue."""
        if self._started:
            return
        self._started = True
        t = threading.Thread(
            target=self._drain,
            daemon=True,
            name='layerinfinite-pipeline',
        )
        t.start()

    def _drain(self) -> None:
        while True:
            try:
                item = self._queue.get(timeout=1.0)
                self._process(item)
            except queue.Empty:
                continue
            except Exception:
                continue  # Never crash the daemon thread

    def _process(self, item: PendingItem) -> None:
        try:
            success, confidence = item.ctx.graph.derive_outcome()

            # HTTP status fallback when graph has no comparisons
            if success is None:
                success    = 200 <= item.http_status < 300
                confidence = 0.5

            outcome_score = round(confidence * (1.0 if success else 0.0), 4)
            response_ms   = int((time.time() - item.queued_at) * 1000)

            self._client.log_outcome(
                agent_id      = getattr(self._client, '_agent_id', 'unknown'),
                action_name   = item.ctx.action_name,
                success       = success,
                outcome_score = outcome_score,
                response_ms   = response_ms,
                feedback_signal = 'immediate',
            )
        except Exception:
            pass  # Never raise from pipeline
