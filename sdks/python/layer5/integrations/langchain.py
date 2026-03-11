"""
LangChain integration for Layer5.

Usage:
    from langchain.agents import AgentExecutor
    from layer5.integrations.langchain import Layer5Callback

    callback = Layer5Callback(
        api_key="layer5_...",
        agent_id="my-langchain-agent"
    )

    agent = AgentExecutor(
        agent=agent,
        tools=tools,
        callbacks=[callback]
    )

    # That's it. Layer5 now scores every tool call.
"""

from __future__ import annotations

import json
import warnings
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Union

from ..client import Layer5
from ..exceptions import Layer5Error

try:
    from langchain_core.callbacks import BaseCallbackHandler

    LANGCHAIN_AVAILABLE = True
except ImportError:
    try:
        from langchain.callbacks.base import BaseCallbackHandler  # type: ignore[no-redef]

        LANGCHAIN_AVAILABLE = True
    except ImportError:
        LANGCHAIN_AVAILABLE = False
        BaseCallbackHandler = object  # type: ignore[assignment,misc]


class Layer5Callback(BaseCallbackHandler if LANGCHAIN_AVAILABLE else object):  # type: ignore[misc]
    """
    LangChain callback handler for Layer5.
    Automatically intercepts every tool call:
      - Fetches scores before tool execution
      - Logs outcome after tool execution
      - Handles errors gracefully (never crashes your agent)

    Works with:
      - AgentExecutor
      - LangGraph
      - Any LangChain tool-using pattern
    """

    def __init__(
        self,
        api_key: str,
        agent_id: str,
        base_url: str = "https://api.layer5.dev",
        context_extractor: Optional[Callable[[dict], dict]] = None,
        silent_errors: bool = True,
    ):
        """
        Args:
            api_key:           Your Layer5 API key
            agent_id:          Identifier for this agent
            context_extractor: Optional function to extract context from
                              tool input dict.
                              Signature: (tool_input: dict) -> dict
                              Default: passes tool_input as context
            silent_errors:     If True (default), Layer5 errors never crash
                              your agent. They are logged as warnings
                              instead. Set False in testing to surface
                              errors.
        """
        if not LANGCHAIN_AVAILABLE:
            raise ImportError(
                "LangChain is required for Layer5Callback. "
                "Install it: pip install langchain-core"
            )

        self.client = Layer5(
            api_key=api_key,
            base_url=base_url,
            agent_id=agent_id,
        )
        self.agent_id = agent_id
        self.context_extractor = context_extractor
        self.silent_errors = silent_errors

        # Track in-flight tool calls
        # run_id → {tool_name, start_time, context, scores}
        self._active_calls: Dict[str, dict] = {}

    def on_tool_start(
        self,
        serialized: Dict[str, Any],
        input_str: str,
        *,
        run_id: Any,
        **kwargs: Any,
    ) -> None:
        """Called before every tool execution."""
        tool_name = serialized.get("name", "unknown_tool")

        # Extract context from tool input
        try:
            tool_input = (
                json.loads(input_str) if isinstance(input_str, str) else {}
            )
        except Exception:
            tool_input = {"raw_input": str(input_str)[:500]}

        context = (
            self.context_extractor(tool_input)
            if self.context_extractor
            else tool_input
        )

        # Ensure issue_type is present for the API
        if "issue_type" not in context:
            context["issue_type"] = tool_name

        # Fetch scores (non-blocking on error)
        scores = None
        try:
            scores = self.client.get_scores(
                agent_id=self.agent_id,
                context=context,
            )
        except Layer5Error as e:
            if not self.silent_errors:
                raise
            warnings.warn(
                f"Layer5 get_scores failed (agent will continue): {e}",
                stacklevel=2,
            )

        self._active_calls[str(run_id)] = {
            "tool_name": tool_name,
            "start_time": datetime.now(),
            "context": context,
            "scores": scores,
            "decision_id": scores.decision_id if scores else None,
        }

    def on_tool_end(
        self,
        output: str,
        *,
        run_id: Any,
        **kwargs: Any,
    ) -> None:
        """Called after successful tool execution."""
        call = self._active_calls.pop(str(run_id), None)
        if not call:
            return

        elapsed_ms = int(
            (datetime.now() - call["start_time"]).total_seconds() * 1000
        )

        try:
            self.client.log_outcome(
                agent_id=self.agent_id,
                action_name=call["tool_name"],
                session_id="langchain-auto",
                issue_type=call["context"].get("issue_type", call["tool_name"]),
                success=True,
                raw_context=call["context"],
                response_time_ms=elapsed_ms,
                feedback_signal="immediate",
                decision_id=call.get("decision_id"),
            )
        except Layer5Error as e:
            if not self.silent_errors:
                raise
            warnings.warn(
                f"Layer5 log_outcome failed: {e}",
                stacklevel=2,
            )

    def on_tool_error(
        self,
        error: Union[Exception, KeyboardInterrupt],
        *,
        run_id: Any,
        **kwargs: Any,
    ) -> None:
        """Called when a tool raises an exception."""
        call = self._active_calls.pop(str(run_id), None)
        if not call:
            return

        elapsed_ms = int(
            (datetime.now() - call["start_time"]).total_seconds() * 1000
        )

        try:
            self.client.log_outcome(
                agent_id=self.agent_id,
                action_name=call["tool_name"],
                session_id="langchain-auto",
                issue_type=call["context"].get("issue_type", call["tool_name"]),
                success=False,
                raw_context=call["context"],
                response_time_ms=elapsed_ms,
                feedback_signal="immediate",
                decision_id=call.get("decision_id"),
            )
        except Layer5Error as e:
            if not self.silent_errors:
                raise
            warnings.warn(
                f"Layer5 log_outcome (error) failed: {e}",
                stacklevel=2,
            )
