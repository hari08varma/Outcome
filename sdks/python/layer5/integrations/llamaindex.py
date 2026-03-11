"""
LlamaIndex integration for Layer5.

Usage:
    from llama_index.core.callbacks import CallbackManager
    from layer5.integrations.llamaindex import Layer5CallbackHandler

    handler = Layer5CallbackHandler(
        api_key="layer5_...",
        agent_id="my-agent"
    )

    callback_manager = CallbackManager([handler])

    # With query engine:
    query_engine = index.as_query_engine(
        callback_manager=callback_manager
    )

    # With agent:
    agent = ReActAgent.from_tools(
        tools=tools,
        callback_manager=callback_manager
    )
"""

from __future__ import annotations

import json
import warnings
from datetime import datetime
from typing import Any, Dict, List, Optional

from ..client import Layer5
from ..exceptions import Layer5Error

try:
    from llama_index.core.callbacks import (
        CBEventType,
        BaseCallbackHandler as LlamaBaseCallbackHandler,
    )
    from llama_index.core.callbacks.schema import EventPayload

    LLAMAINDEX_AVAILABLE = True
except ImportError:
    try:
        from llama_index.callbacks import (  # type: ignore[no-redef]
            CBEventType,
            BaseCallbackHandler as LlamaBaseCallbackHandler,
            EventPayload,
        )

        LLAMAINDEX_AVAILABLE = True
    except ImportError:
        LLAMAINDEX_AVAILABLE = False

        class LlamaBaseCallbackHandler:  # type: ignore[no-redef]
            """Stub so class definition doesn't fail at import time."""

            def __init__(self, **kwargs: Any) -> None:
                pass

        class CBEventType:  # type: ignore[no-redef]
            FUNCTION_CALL = "function_call"

        class EventPayload:  # type: ignore[no-redef]
            FUNCTION_CALL = "function_call"
            FUNCTION_OUTPUT = "function_output"


class Layer5CallbackHandler(LlamaBaseCallbackHandler):  # type: ignore[misc]
    """
    LlamaIndex callback handler for Layer5.

    Intercepts FUNCTION_CALL events:
      -> get_scores before function runs
      -> log_outcome after function completes

    Works with:
      ReActAgent, OpenAIAgent,
      FunctionCallingAgent, QueryEngine
    """

    event_starts_to_ignore: List[CBEventType] = []
    event_ends_to_ignore: List[CBEventType] = []

    def __init__(
        self,
        api_key: str,
        agent_id: str,
        base_url: str = "https://api.layer5.dev",
        silent_errors: bool = True,
    ) -> None:
        if not LLAMAINDEX_AVAILABLE:
            raise ImportError(
                "LlamaIndex is not installed. "
                "Install it: pip install llama-index-core\n"
                "Or: pip install layer5[llamaindex]"
            )

        super().__init__(
            event_starts_to_ignore=[],
            event_ends_to_ignore=[],
        )

        self._client = Layer5(
            api_key=api_key,
            base_url=base_url,
            agent_id=agent_id,
        )
        self.agent_id = agent_id
        self.silent_errors = silent_errors
        self._calls: Dict[str, Dict[str, Any]] = {}

    def on_event_start(
        self,
        event_type: CBEventType,
        payload: Optional[Dict[str, Any]] = None,
        event_id: str = "",
        **kwargs: Any,
    ) -> str:
        if event_type != CBEventType.FUNCTION_CALL:
            return event_id

        func_name = ""
        context: Dict[str, Any] = {}

        if payload:
            func_call = payload.get(EventPayload.FUNCTION_CALL, "")
            if isinstance(func_call, dict):
                func_name = func_call.get("name", "unknown")
                raw_args = func_call.get("arguments", {})
                if isinstance(raw_args, str):
                    try:
                        context = json.loads(raw_args)
                    except Exception:
                        context = {"raw": raw_args[:500]}
                elif isinstance(raw_args, dict):
                    context = raw_args
            else:
                func_name = str(func_call)

        context["issue_type"] = func_name or "unknown"

        try:
            self._client.get_scores(
                agent_id=self.agent_id,
                context={"tool": func_name, **context},
            )
        except Layer5Error as e:
            if not self.silent_errors:
                raise
            warnings.warn(f"[Layer5] get_scores failed: {e}", stacklevel=2)

        self._calls[event_id] = {
            "func_name": func_name,
            "context": context,
            "start": datetime.now(),
        }
        return event_id

    def on_event_end(
        self,
        event_type: CBEventType,
        payload: Optional[Dict[str, Any]] = None,
        event_id: str = "",
        **kwargs: Any,
    ) -> None:
        if event_type != CBEventType.FUNCTION_CALL:
            return

        call = self._calls.pop(event_id, None)
        if not call:
            return

        elapsed_ms = int(
            (datetime.now() - call["start"]).total_seconds() * 1000
        )

        # Determine success from output payload
        success = True
        if payload:
            output = payload.get(EventPayload.FUNCTION_OUTPUT)
            if output is not None:
                output_str = str(output).lower()
                success = not any(
                    word in output_str
                    for word in ["error", "failed", "exception"]
                )

        try:
            self._client.log_outcome(
                agent_id=self.agent_id,
                action_name=call["func_name"] or "unknown",
                session_id="llamaindex-auto",
                issue_type=call["context"].get("issue_type", "unknown"),
                success=success,
                raw_context={"tool": call["func_name"], **call["context"]},
                response_time_ms=elapsed_ms,
            )
        except Layer5Error as e:
            if not self.silent_errors:
                raise
            warnings.warn(f"[Layer5] log_outcome failed: {e}", stacklevel=2)

    def start_trace(self, trace_id: Optional[str] = None) -> None:
        pass

    def end_trace(
        self,
        trace_id: Optional[str] = None,
        trace_map: Optional[Dict[str, List[str]]] = None,
    ) -> None:
        pass
