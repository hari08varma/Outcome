"""
Single entry point. Call ONCE at agent startup. Never raises.

    from layerinfinite_l5.instrument import instrument
    instrument(client)
"""
from __future__ import annotations

from typing import Any

from .pipeline.outcome_pipeline import OutcomePipeline
from .tracing.interceptor import IOInterceptor


def instrument(client: Any) -> None:
    """
    Instruments the Python agent runtime.
    Patches httpx and requests at call time.
    Starts background pipeline daemon thread.

    NEVER raises. NEVER blocks.

    Args:
        client: LayerinfiniteClient instance (or any object with .log_outcome())
    """
    try:
        pipeline    = OutcomePipeline(client)
        interceptor = IOInterceptor(pipeline)

        interceptor.instrument_httpx()
        interceptor.instrument_requests()

        pipeline.start()
    except Exception:
        pass  # Instrumentation failure must never crash the agent
