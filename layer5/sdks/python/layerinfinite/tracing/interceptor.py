"""
Patches httpx.Client.send, httpx.AsyncClient.send, requests.Session.send.

Each patched call:
  1. Generates a new action_id (uuid4)
  2. Infers action_name from URL + method
  3. Creates a CausalGraph
  4. Sets ExecutionContext via ContextVar token
  5. Wraps JSON response body in TracedResponse (via response.json())
  6. Resets ContextVar token in finally block
  7. Pushes item to OutcomePipeline queue (fire-and-forget)
"""
from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any, Callable
from urllib.parse import urlparse

from .causal_graph import CausalGraph
from .execution_context import ExecutionContext, reset_context, set_context
from .traced_response import TracedResponse

if TYPE_CHECKING:
    from ..pipeline.outcome_pipeline import OutcomePipeline


def _infer_action_name(url: str, method: str) -> str:
    """Best-effort: last two URL path segments + method."""
    path  = urlparse(str(url)).path.rstrip('/')
    parts = [p for p in path.split('/') if p]
    label = '_'.join(parts[-2:]) if len(parts) >= 2 else (parts[-1] if parts else 'unknown')
    return f"{method.lower()}_{label}"


class IOInterceptor:
    def __init__(self, pipeline: OutcomePipeline) -> None:
        self._pipeline      = pipeline
        self._patched_httpx = False
        self._patched_req   = False

    # ── Public: patch httpx ────────────────────────────────────────
    def instrument_httpx(self) -> None:
        """Patch httpx.Client.send (sync) and httpx.AsyncClient.send (async)."""
        if self._patched_httpx:
            return
        try:
            import httpx
            _orig_sync  = httpx.Client.send
            _orig_async = httpx.AsyncClient.send
            interceptor = self

            def _sync_send(client_self: Any, request: Any, **kwargs: Any) -> Any:
                return interceptor._wrap_sync(
                    request, lambda: _orig_sync(client_self, request, **kwargs)
                )

            async def _async_send(client_self: Any, request: Any, **kwargs: Any) -> Any:
                return await interceptor._wrap_async(
                    request, lambda: _orig_async(client_self, request, **kwargs)
                )

            httpx.Client.send      = _sync_send   # type: ignore[method-assign]
            httpx.AsyncClient.send = _async_send  # type: ignore[method-assign]
            self._patched_httpx    = True
        except ImportError:
            pass  # httpx not installed — silent skip

    # ── Public: patch requests ────────────────────────────────────
    def instrument_requests(self) -> None:
        """Patch requests.Session.send (sync only)."""
        if self._patched_req:
            return
        try:
            import requests
            _orig       = requests.Session.send
            interceptor = self

            def _send(session_self: Any, request: Any, **kwargs: Any) -> Any:
                return interceptor._wrap_requests(
                    request, lambda: _orig(session_self, request, **kwargs)
                )

            requests.Session.send = _send  # type: ignore[method-assign]
            self._patched_req     = True
        except ImportError:
            pass  # requests not installed — silent skip

    # ── Internal: build context ───────────────────────────────────
    def _make_context(self, url: str, method: str) -> tuple[ExecutionContext, Any]:
        action_id   = str(uuid.uuid4())
        action_name = _infer_action_name(url, method)
        graph       = CausalGraph()
        ctx         = ExecutionContext(action_id=action_id, action_name=action_name, graph=graph)
        token       = set_context(ctx)
        return ctx, token

    # ── Internal: wrap JSON response ──────────────────────────────
    def _wrap_response(self, response: Any, ctx: ExecutionContext) -> Any:
        """Wrap JSON body in TracedResponse, push to pipeline."""
        try:
            body = response.json()
            provenance = {
                'action_id':   ctx.action_id,
                'action_name': ctx.action_name,
                'field_path':  '',
                'depth':       0,
            }
            traced = TracedResponse(body, provenance, ctx.graph)

            # Replace .json() so callers get TracedResponse
            def traced_json(**kw: Any) -> TracedResponse:
                return traced

            response.json = traced_json
            response._layerinfinite_traced = traced
        except Exception:
            pass  # Non-JSON response — skip tracing, never raise

        # Push to pipeline (fire-and-forget)
        try:
            status = getattr(response, 'status_code', 200)
            self._pipeline.push(ctx, int(status))
        except Exception:
            pass

        return response

    # ── Internal: sync wrapper ────────────────────────────────────
    def _wrap_sync(self, request: Any, call: Callable[[], Any]) -> Any:
        ctx, token = self._make_context(str(request.url), request.method)
        try:
            response = call()
            return self._wrap_response(response, ctx)
        finally:
            reset_context(token)

    # ── Internal: async wrapper ───────────────────────────────────
    async def _wrap_async(self, request: Any, call: Callable[[], Any]) -> Any:
        ctx, token = self._make_context(str(request.url), request.method)
        try:
            response = await call()
            return self._wrap_response(response, ctx)
        finally:
            reset_context(token)

    # ── Internal: requests wrapper ────────────────────────────────
    def _wrap_requests(self, request: Any, call: Callable[[], Any]) -> Any:
        ctx, token = self._make_context(str(request.url), request.method)
        try:
            response = call()
            return self._wrap_response(response, ctx)
        finally:
            reset_context(token)
