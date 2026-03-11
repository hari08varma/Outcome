"""
AutoGen integration for Layer5.

Usage:
    from autogen import AssistantAgent, UserProxyAgent
    from layer5.integrations.autogen import Layer5AutoGenHook

    hook = Layer5AutoGenHook(
        api_key="layer5_...",
        agent_id="my-autogen-agent"
    )

    assistant = AssistantAgent(
        name="assistant",
        llm_config=llm_config
    )
    hook.attach(assistant)
"""

from __future__ import annotations

import warnings
from datetime import datetime
from functools import wraps
from typing import Any, Callable, Dict

from ..client import Layer5
from ..exceptions import Layer5Error


class Layer5AutoGenHook:
    """
    AutoGen hook for Layer5 outcome tracking.
    Attaches to AssistantAgent or ConversableAgent.
    Intercepts function/tool calls automatically.
    """

    def __init__(
        self,
        api_key: str,
        agent_id: str,
        base_url: str = "https://api.layer5.dev",
        silent_errors: bool = True,
    ):
        self.client = Layer5(
            api_key=api_key,
            base_url=base_url,
            agent_id=agent_id,
        )
        self.agent_id = agent_id
        self.silent_errors = silent_errors

    def attach(self, agent: Any) -> None:
        """
        Attach Layer5 tracking to an AutoGen agent.
        Wraps the agent's function_map execution.
        """
        if not hasattr(agent, "function_map"):
            warnings.warn(
                f"Agent {getattr(agent, 'name', '?')} has no function_map. "
                f"Layer5 cannot intercept tool calls.",
                stacklevel=2,
            )
            return

        original_map = agent.function_map.copy()

        for func_name, func in original_map.items():
            agent.function_map[func_name] = self._wrap_function(
                func_name, func
            )

    def _wrap_function(
        self, func_name: str, func: Callable[..., Any]
    ) -> Callable[..., Any]:
        @wraps(func)
        def wrapped(*args: Any, **kwargs: Any) -> Any:
            context = {"function": func_name, "issue_type": func_name}
            start = datetime.now()
            success = True

            scores_result = None
            try:
                scores_result = self.client.get_scores(
                    agent_id=self.agent_id,
                    context=context,
                )
            except Layer5Error:
                pass

            decision_id = scores_result.decision_id if scores_result else None

            try:
                result = func(*args, **kwargs)
                return result
            except Exception:
                success = False
                raise
            finally:
                elapsed = int(
                    (datetime.now() - start).total_seconds() * 1000
                )
                try:
                    self.client.log_outcome(
                        agent_id=self.agent_id,
                        action_name=func_name,
                        session_id="autogen-auto",
                        issue_type=func_name,
                        success=success,
                        raw_context=context,
                        response_time_ms=elapsed,
                        decision_id=decision_id,
                    )
                except Layer5Error:
                    pass

        return wrapped
