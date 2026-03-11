"""
CrewAI integration for Layer5.

Usage:
    from crewai import Agent, Task, Crew
    from layer5.integrations.crewai import layer5_tool

    # Wrap any CrewAI tool with Layer5 tracking
    tracked_tool = layer5_tool(
        tool=my_tool,
        api_key="layer5_...",
        agent_id="my-crew-agent"
    )

    agent = Agent(
        role="Support Agent",
        tools=[tracked_tool]
    )
"""

from __future__ import annotations

from datetime import datetime
from functools import wraps
from typing import Any, Optional

from ..client import Layer5
from ..exceptions import Layer5Error


def layer5_tool(
    tool: Any,
    api_key: str,
    agent_id: str,
    base_url: str = "https://api.layer5.dev",
    silent_errors: bool = True,
) -> Any:
    """
    Wrap a CrewAI tool with Layer5 outcome tracking.

    The wrapped tool:
    - Fetches Layer5 scores before running
    - Logs the outcome after running
    - Never crashes the original tool on Layer5 errors
    - Preserves the original tool's interface exactly
    """
    client = Layer5(
        api_key=api_key,
        base_url=base_url,
        agent_id=agent_id,
    )

    # Get the original run method
    original_run = tool._run if hasattr(tool, "_run") else tool.run
    tool_name = getattr(tool, "name", None) or getattr(original_run, "__name__", "unknown_tool")

    @wraps(original_run)
    def tracked_run(*args: Any, **kwargs: Any) -> Any:
        context = {
            "tool": tool_name,
            "issue_type": tool_name,
            "args": str(args)[:200],
        }
        start = datetime.now()

        # Fetch scores (non-blocking)
        scores_result = None
        try:
            scores_result = client.get_scores(agent_id=agent_id, context=context)
        except Layer5Error:
            if not silent_errors:
                raise

        decision_id = scores_result.decision_id if scores_result else None

        # Run the original tool
        success = True
        result = None
        try:
            result = original_run(*args, **kwargs)
            return result
        except Exception:
            success = False
            raise
        finally:
            elapsed = int(
                (datetime.now() - start).total_seconds() * 1000
            )
            try:
                client.log_outcome(
                    agent_id=agent_id,
                    action_name=tool_name,
                    session_id="crewai-auto",
                    issue_type=tool_name,
                    success=success,
                    raw_context=context,
                    response_time_ms=elapsed,
                    decision_id=decision_id,
                )
            except Layer5Error:
                if not silent_errors:
                    raise

    # Patch the tool's run method
    if hasattr(tool, "_run"):
        tool._run = tracked_run
    else:
        tool.run = tracked_run

    return tool
