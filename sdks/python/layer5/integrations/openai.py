"""
OpenAI SDK integration for Layer5.
Covers: function calling, tool use, Assistants API tool runs.

Supports: openai >= 1.0.0

Usage — function calling wrapper:
    from openai import OpenAI
    from layer5.integrations.openai import Layer5OpenAIWrapper

    openai_client = OpenAI()
    l5_client     = Layer5(api_key="layer5_...")

    wrapper = Layer5OpenAIWrapper(
        openai_client=openai_client,
        layer5_client=l5_client,
        agent_id="openai-agent"
    )

    response = wrapper.chat_completion(
        model="gpt-4o",
        messages=messages,
        tools=tools,
    )

Usage — manual tool tracking:
    from layer5.integrations.openai import track_tool_calls

    response = openai_client.chat.completions.create(
        model="gpt-4o",
        messages=messages,
        tools=tools
    )

    track_tool_calls(
        layer5_client=l5_client,
        agent_id="openai-agent",
        tool_calls=response.choices[0].message.tool_calls,
        results=your_execution_results,
    )
"""

from __future__ import annotations

import json
import warnings
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

from ..client import Layer5
from ..exceptions import Layer5Error


def _require_openai() -> Any:
    try:
        import openai

        return openai
    except ImportError:
        raise ImportError(
            "OpenAI SDK is not installed. "
            "Install it: pip install openai\n"
            "Or: pip install layer5[openai]"
        )


def track_tool_calls(
    layer5_client: Layer5,
    agent_id: str,
    tool_calls: List[Any],
    results: List[Dict[str, Any]],
    silent_errors: bool = True,
    decision_ids: Optional[List[Optional[str]]] = None,
) -> None:
    """
    Log outcomes for OpenAI tool calls you executed.

    Call this AFTER you execute all tool calls from
    an OpenAI response and have the results.

    Args:
        layer5_client: Initialized Layer5 client
        agent_id:      Your agent identifier
        tool_calls:    response.choices[0].message.tool_calls
        results:       List of dicts, one per tool call:
                       [{"success": True,
                         "response_ms": 241,
                         "outcome_score": 0.9},  # optional
                        ...]
                       Length must match tool_calls.
        silent_errors: True = don't crash on Layer5 errors
    """
    if len(tool_calls) != len(results):
        raise ValueError(
            f"tool_calls length ({len(tool_calls)}) must "
            f"match results length ({len(results)}). "
            f"Provide one result dict per tool call."
        )

    for i, (tool_call, result) in enumerate(zip(tool_calls, results)):
        func_name = tool_call.function.name

        try:
            args = json.loads(tool_call.function.arguments or "{}")
        except Exception:
            args = {}

        decision_id = (
            decision_ids[i] if decision_ids and i < len(decision_ids) else None
        )

        try:
            layer5_client.log_outcome(
                agent_id=agent_id,
                action_name=func_name,
                session_id="openai-auto",
                issue_type=func_name,
                success=result.get("success", True),
                raw_context={"tool": func_name, **args},
                response_time_ms=result.get("response_ms"),
                outcome_score=result.get("outcome_score"),
                business_outcome=result.get("business_outcome"),
                decision_id=decision_id,
            )
        except Layer5Error as e:
            if not silent_errors:
                raise
            warnings.warn(
                f"[Layer5] log_outcome for '{func_name}' failed: {e}",
                stacklevel=2,
            )


class Layer5OpenAIWrapper:
    """
    Drop-in wrapper around OpenAI client that adds
    Layer5 tracking to all tool calls automatically.
    """

    def __init__(
        self,
        openai_client: Any,
        layer5_client: Layer5,
        agent_id: str,
        tool_executor: Optional[Callable[..., Dict[str, Any]]] = None,
        silent_errors: bool = True,
    ) -> None:
        """
        Args:
            openai_client: Your initialized OpenAI client
            layer5_client: Your initialized Layer5 client
            agent_id:      Agent identifier
            tool_executor: Optional callable to auto-execute tool calls.
                          fn(tool_call) -> {"success": bool, "response_ms": int}
                          If None: tracks from response only.
            silent_errors: Layer5 errors never crash your code
        """
        _require_openai()
        self._openai = openai_client
        self._layer5 = layer5_client
        self.agent_id = agent_id
        self.tool_executor = tool_executor
        self.silent_errors = silent_errors

    def chat_completion(
        self,
        model: str,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Any]] = None,
        **kwargs: Any,
    ) -> Any:
        """
        Drop-in for openai_client.chat.completions.create().
        Automatically tracks tool call outcomes if
        tool_executor is provided.

        Returns: same OpenAI ChatCompletion response object.
        """
        response = self._openai.chat.completions.create(
            model=model,
            messages=messages,
            tools=tools,
            **kwargs,
        )

        message = response.choices[0].message
        if self.tool_executor and message.tool_calls:
            results: List[Dict[str, Any]] = []
            for tc in message.tool_calls:
                start = datetime.now()
                try:
                    self.tool_executor(tc)
                    results.append(
                        {
                            "success": True,
                            "response_ms": int(
                                (datetime.now() - start).total_seconds() * 1000
                            ),
                        }
                    )
                except Exception:
                    results.append(
                        {
                            "success": False,
                            "response_ms": int(
                                (datetime.now() - start).total_seconds() * 1000
                            ),
                        }
                    )

            track_tool_calls(
                layer5_client=self._layer5,
                agent_id=self.agent_id,
                tool_calls=message.tool_calls,
                results=results,
                silent_errors=self.silent_errors,
            )

        return response
