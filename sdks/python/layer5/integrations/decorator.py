"""
Decorator integration for custom Python agents.

Usage:
    from layer5 import Layer5
    from layer5.integrations.decorator import track

    l5 = Layer5(api_key="layer5_...")

    @track(client=l5, agent_id="my-agent",
           issue_type="payment_refund")
    def restart_service(host: str) -> bool:
        # your existing code unchanged
        return True

    # Or use outcome_score for nuanced results:
    @track(client=l5, agent_id="my-agent",
           issue_type="refund",
           score_fn=lambda r: 0.9 if r else 0.0)
    def process_refund(amount: float) -> bool:
        ...
"""

from __future__ import annotations

from datetime import datetime
from functools import wraps
from typing import Any, Callable, Dict, Optional

from ..exceptions import Layer5Error


def track(
    client: Any,
    agent_id: str,
    issue_type: str = "default",
    action_name: Optional[str] = None,
    context_fn: Optional[Callable[..., dict]] = None,
    score_fn: Optional[Callable[[Any], float]] = None,
    silent_errors: bool = True,
) -> Callable[..., Any]:
    """
    Decorator to add Layer5 tracking to any function.

    Args:
        client:      Layer5 client instance
        agent_id:    Your agent identifier
        issue_type:  Issue type for context resolution
        action_name: Override action name (default: function name)
        context_fn:  Extract context from function args.
                     Signature: (*args, **kwargs) -> dict
        score_fn:    Compute outcome_score from return value.
                     Signature: (return_value) -> float
                     Useful for nuanced success scoring.
        silent_errors: Layer5 errors never crash your code.

    Example:
        @track(client=l5, agent_id="payment-bot",
               issue_type="payment",
               score_fn=lambda r: 1.0 if r["status"]=="ok"
                                  else 0.0)
        def process_payment(order_id: str) -> dict:
            return payment_api.process(order_id)
    """

    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        resolved_name = action_name or func.__name__

        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            context: Dict[str, Any] = {"issue_type": issue_type}
            if context_fn:
                try:
                    context.update(context_fn(*args, **kwargs))
                except Exception:
                    pass

            start = datetime.now()
            success = True
            result = None

            scores_result = None
            try:
                scores_result = client.get_scores(
                    agent_id=agent_id,
                    context=context,
                )
            except Layer5Error:
                if not silent_errors:
                    raise

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

                outcome_score = None
                if score_fn and result is not None:
                    try:
                        outcome_score = float(score_fn(result))
                    except Exception:
                        pass

                try:
                    client.log_outcome(
                        agent_id=agent_id,
                        action_name=resolved_name,
                        session_id="decorator-auto",
                        issue_type=issue_type,
                        success=success,
                        raw_context=context,
                        response_time_ms=elapsed,
                        outcome_score=outcome_score,
                        decision_id=decision_id,
                    )
                except Layer5Error:
                    if not silent_errors:
                        raise

        return wrapper

    return decorator
