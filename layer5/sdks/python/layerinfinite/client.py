from __future__ import annotations

import functools
import inspect
import logging
import os
import threading
import time
import uuid
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

import httpx

from .exceptions import (
    LayerinfiniteAuthError,
    LayerinfiniteError,
    LayerinfiniteNotFoundError,
    LayerinfiniteRateLimitError,
    LayerinfiniteServerError,
    LowConfidenceError,
)
from .models import (
    ActionEntry,
    GetScoresResponse,
    LogOutcomeRequest,
    LogOutcomeResponse,
    ObservationSummary,
    RankedAction,
    Recommendation,
    Suggestion,
)

logger = logging.getLogger("layerinfinite")

_VALID_MODES = ("recommend", "assist", "auto")
_SDK_VERSION = "0.3.1"
_DEFAULT_BASE_URL = "https://api.layerinfinite.app"
_BASE_URLS_ENV = "LAYERINFINITE_BASE_URLS"


class Layerinfinite:
    """
    Layerinfinite — Decision Intelligence SDK for AI Agents.

    Automatically logs every action's outcome, learns from results,
    and provides ranked recommendations — with zero LLM dependency.

    Three modes:
      recommend (default) — observe, log, learn, recommend later
      assist              — everything + li.suggest(task) guidance
      auto                — everything + li.run(task) autonomous execution

    Quick start::

        from layerinfinite import Layerinfinite

        li = Layerinfinite(api_key="layerinfinite_xxx", agent_id="my-agent")

        @li.action("payment_failed")
        def retry_payment(ticket_id):
            return gateway.charge(ticket_id)

        @li.action("payment_failed")
        def switch_provider(ticket_id):
            return alt_gateway.charge(ticket_id)

        # Decorator auto-logs every call's outcome.
        retry_payment("t-001")

        # Get a recommendation after enough data accumulates:
        rec = li.recommend("payment_failed")
    """

    def __init__(
        self,
        api_key: str,
        agent_id: str,
        mode: str = "recommend",
        confidence_threshold: float = 0.7,
        auto_fallback: bool = True,
        base_url: str = _DEFAULT_BASE_URL,
        timeout: float = 10.0,
        max_retries: int = 3,
        log_async: bool = True,
        auto_register: bool = True,
    ) -> None:
        if not isinstance(api_key, str) or not api_key.startswith("layerinfinite_"):
            raise ValueError(
                "Invalid API key format. Key must start with 'layerinfinite_'. "
                "Get your key from https://outcome-green.vercel.app/settings/api-keys"
            )
        if not isinstance(agent_id, str) or not agent_id.strip():
            raise ValueError("agent_id must be a non-empty string.")
        if mode not in _VALID_MODES:
            raise ValueError(
                f"Invalid mode '{mode}'. Must be one of: {', '.join(_VALID_MODES)}."
            )
        if not (0.0 <= confidence_threshold <= 1.0):
            raise ValueError(
                "confidence_threshold must be between 0.0 and 1.0, "
                f"got {confidence_threshold}."
            )

        self._api_key = api_key
        self._agent_id = agent_id.strip()
        self._mode = mode
        self._confidence_threshold = confidence_threshold
        self._auto_fallback = auto_fallback
        self._base_url = base_url.rstrip("/")
        self._max_retries = max_retries
        self._log_async = log_async
        self._auto_register = auto_register

        self._base_urls = self._resolve_base_urls(self._base_url)
        self._endpoint_lock = threading.Lock()
        self._active_endpoint_index = 0

        self._actions: Dict[str, Dict[str, ActionEntry]] = {}
        self._registry_lock = threading.Lock()

        self._http_clients = [
            self._build_http_client(base_url=endpoint, timeout=timeout, api_key=api_key)
            for endpoint in self._base_urls
        ]
        self._http = self._http_clients[0]

    def __enter__(self) -> "Layerinfinite":
        return self

    def __exit__(self, *args: Any) -> None:
        for client in self._http_clients:
            client.close()

    def _build_http_client(self, base_url: str, timeout: float, api_key: str) -> httpx.Client:
        return httpx.Client(
            base_url=base_url,
            timeout=timeout,
            headers={
                "X-API-Key": api_key,
                "User-Agent": f"layerinfinite-python-sdk/{_SDK_VERSION}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )

    def _resolve_base_urls(self, primary_base_url: str) -> List[str]:
        candidates: List[str] = [primary_base_url]
        env_base_urls = os.getenv(_BASE_URLS_ENV, "")
        if env_base_urls:
            candidates.extend(url.strip() for url in env_base_urls.split(",") if url.strip())

        deduped: List[str] = []
        for url in candidates:
            normalized = url.rstrip("/")
            if normalized and normalized not in deduped:
                deduped.append(normalized)

        return deduped or [primary_base_url]

    def _current_http_client(self) -> tuple[int, httpx.Client, str]:
        with self._endpoint_lock:
            idx = self._active_endpoint_index
        return idx, self._http_clients[idx], self._base_urls[idx]

    def _rotate_endpoint(self, reason: str) -> None:
        if len(self._http_clients) <= 1:
            return

        with self._endpoint_lock:
            previous_idx = self._active_endpoint_index
            next_idx = (previous_idx + 1) % len(self._http_clients)
            if next_idx == previous_idx:
                return
            self._active_endpoint_index = next_idx

        logger.warning(
            "[layerinfinite] Endpoint failover: %s -> %s (%s)",
            self._base_urls[previous_idx],
            self._base_urls[next_idx],
            reason,
        )

    def action(
        self,
        task: str,
        name: str | None = None,
        score_fn: Callable[[Any], float | None] | None = None,
    ) -> Callable:
        def decorator(fn: Callable) -> Callable:
            action_name = name or fn.__name__

            entry = ActionEntry(
                fn=fn,
                name=action_name,
                task=task,
                score_fn=score_fn,
                registered_via="decorator",
                created_at=datetime.now(timezone.utc).isoformat(),
            )

            with self._registry_lock:
                if task not in self._actions:
                    self._actions[task] = {}
                if action_name in self._actions[task]:
                    logger.debug(
                        "Action '%s' for task '%s' re-registered.",
                        action_name,
                        task,
                    )
                self._actions[task][action_name] = entry

            if self._auto_register:
                self._register_action_in_dashboard(task, action_name)

            @functools.wraps(fn)
            def wrapper(*args: Any, **kwargs: Any) -> Any:
                session_id = str(uuid.uuid4())
                start = time.monotonic()
                success = False
                error_msg: str | None = None
                outcome_score: float | None = None
                result: Any = None

                try:
                    result = fn(*args, **kwargs)
                    success = True
                    outcome_score = self._compute_outcome_score(
                        task=task,
                        action_name=action_name,
                        score_fn=score_fn,
                        result=result,
                    )
                    return result
                except Exception as exc:
                    error_msg = f"{type(exc).__name__}: {exc}"
                    raise
                finally:
                    latency_ms = round((time.monotonic() - start) * 1000)
                    self._log_outcome(
                        task=task,
                        action_name=action_name,
                        success=success,
                        session_id=session_id,
                        latency_ms=latency_ms,
                        outcome_score=outcome_score,
                        error=error_msg,
                    )

            wrapper._li_task = task
            wrapper._li_action = action_name
            wrapper._li_original = fn
            return wrapper

        return decorator

    def register_action(
        self,
        task: str,
        name: str,
        fn: Callable,
        score_fn: Callable[[Any], float | None] | None = None,
    ) -> None:
        """
        Manually register an action without the decorator.

        IMPORTANT: This does NOT wrap fn with auto-logging.
        When this action is executed via li.run(), the run() method
        handles outcome logging directly.

        Args:
            task: Task name (e.g. "payment_failed")
            name: Action name (e.g. "retry_payment")
            fn:   Callable to register
            score_fn: Optional callable(result) -> outcome_score in [0.0, 1.0]
        """
        entry = ActionEntry(
            fn=fn,
            name=name,
            task=task,
            score_fn=score_fn,
            registered_via="manual",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        with self._registry_lock:
            if task not in self._actions:
                self._actions[task] = {}
            if name in self._actions[task]:
                logger.debug(
                    "Action '%s' for task '%s' re-registered (manual).",
                    name,
                    task,
                )
            self._actions[task][name] = entry

        if self._auto_register:
            self._register_action_in_dashboard(task, name)

    def run(self, task: str, **kwargs: Any) -> Any:
        """
        Pick the best action for task, execute it, log outcome, return result.
        Only available in mode='auto'.

        Args:
            task:    Task name matching registered actions.
            **kwargs: Passed directly to the executed action function.

        Returns:
            The return value of the executed action.

        Raises:
            LayerinfiniteError: If mode != 'auto', no actions registered,
                                or all actions fail.
            LowConfidenceError: If best action confidence < confidence_threshold.

        Note:
            Auto mode only supports keyword arguments. Action functions should
            accept keyword arguments or **kwargs.
        """
        if self._mode != "auto":
            raise LayerinfiniteError(
                f"run() is only available in 'auto' mode. "
                f"Current mode: '{self._mode}'. "
                "Use mode='auto' when initializing Layerinfinite."
            )

        with self._registry_lock:
            task_actions = self._actions.get(task, {}).copy()
        if not task_actions:
            raise LayerinfiniteError(
                f"No actions registered for task '{task}'. "
                f"Use @li.action('{task}') to register action functions."
            )

        execution_order = self._build_execution_order(task)

        top_confidence = 0.0
        top_reason = "No outcome data yet."
        scores_resp: GetScoresResponse | None = None
        try:
            scores_resp = self._fetch_scores(task)
            if scores_resp and scores_resp.top_action:
                top_confidence = scores_resp.top_action.confidence
                top_reason = (
                    scores_resp.top_action.policy_reason
                    or "Ranked by outcome history."
                )
        except Exception as exc:
            logger.warning("[layerinfinite] Could not fetch confidence scores: %s", exc)

        if top_confidence > 0.0 and top_confidence < self._confidence_threshold:
            ranked = self._build_ranked_from_scores(scores_resp) if scores_resp else []
            top_name = execution_order[0] if execution_order else "unknown"
            suggestion = Suggestion(
                action_name=top_name,
                confidence=top_confidence,
                reason=top_reason,
                ranked=ranked,
            )
            raise LowConfidenceError(
                f"Confidence {top_confidence:.0%} is below threshold "
                f"{self._confidence_threshold:.0%} for task '{task}'. "
                f"Best action: '{top_name}'. "
                "Lower confidence_threshold or wait for more outcome data.",
                suggestion=suggestion,
                confidence=top_confidence,
                threshold=self._confidence_threshold,
            )

        last_error: Exception | None = None

        for idx, action_name in enumerate(execution_order):
            with self._registry_lock:
                entry = self._actions.get(task, {}).get(action_name)
            if not entry:
                continue

            session_id = str(uuid.uuid4())
            start = time.monotonic()

            try:
                result = entry.fn(**kwargs)
                outcome_score = self._compute_outcome_score(
                    task=task,
                    action_name=action_name,
                    score_fn=entry.score_fn,
                    result=result,
                )
                latency_ms = round((time.monotonic() - start) * 1000)
                logger.info(
                    "[layerinfinite] task=%s action=%s succeeded (%dms)",
                    task,
                    action_name,
                    latency_ms,
                )
                self._log_outcome(
                    task=task,
                    action_name=action_name,
                    success=True,
                    session_id=session_id,
                    latency_ms=latency_ms,
                    outcome_score=outcome_score,
                )
                return result
            except Exception as exc:
                last_error = exc
                latency_ms = round((time.monotonic() - start) * 1000)
                error_msg = f"{type(exc).__name__}: {exc}"
                logger.warning(
                    "[layerinfinite] task=%s action=%s failed: %s (%dms)",
                    task,
                    action_name,
                    error_msg,
                    latency_ms,
                )
                self._log_outcome(
                    task=task,
                    action_name=action_name,
                    success=False,
                    session_id=session_id,
                    latency_ms=latency_ms,
                    error=error_msg,
                )

                if not self._auto_fallback:
                    raise LayerinfiniteError(
                        f"Action '{action_name}' failed for task '{task}': {error_msg}"
                    ) from exc

                if idx + 1 < len(execution_order):
                    logger.warning(
                        "[layerinfinite] ↻ task=%s falling back to %s",
                        task,
                        execution_order[idx + 1],
                    )
                continue

        if last_error is None:
            raise LayerinfiniteError(f"All actions failed for task '{task}'.")

        raise LayerinfiniteError(
            f"All actions failed for task '{task}'. "
            f"Last error: {type(last_error).__name__}: {last_error}"
        ) from last_error

    def suggest(self, task: str) -> Suggestion:
        """
        Return the best action recommendation without executing anything.
        Only available in mode='assist'.

        Args:
            task: Task name matching registered actions.

        Returns:
            Suggestion with action_name, confidence, reason, and ranked list.

        Raises:
            LayerinfiniteError: If mode != 'assist' or no actions registered.
        """
        if self._mode != "assist":
            raise LayerinfiniteError(
                f"suggest() is only available in 'assist' mode. "
                f"Current mode: '{self._mode}'. "
                "Use mode='assist' when initializing Layerinfinite."
            )

        with self._registry_lock:
            task_actions = self._actions.get(task, {}).copy()
        if not task_actions:
            raise LayerinfiniteError(
                f"No actions registered for task '{task}'. "
                f"Use @li.action('{task}') to register action functions."
            )

        try:
            scores_resp = self._fetch_scores(task)
        except LayerinfiniteAuthError:
            raise
        except Exception as exc:
            logger.warning(
                "[layerinfinite] suggest() could not reach scoring engine: %s. "
                "Returning cold-start suggestion (first registered action).",
                exc,
            )
            scores_resp = None

        ranked_actions = scores_resp.ranked_actions if scores_resp else []

        if not scores_resp or not scores_resp.top_action or not ranked_actions:
            first_action = next(iter(task_actions))
            suggestion = Suggestion(
                action_name=first_action,
                confidence=0.0,
                reason="No outcome data yet. This is the first registered action.",
                ranked=[
                    RankedAction(action_name=a, score=0.0, confidence=0.0)
                    for a in task_actions
                ],
            )
        else:
            ranked = self._build_ranked_from_scores(scores_resp)
            top = scores_resp.top_action
            suggestion = Suggestion(
                action_name=top.action_name,
                confidence=top.confidence,
                reason=top.policy_reason
                or f"{top.action_name} has the highest outcome score.",
                ranked=ranked,
            )

        print(f'\n[layerinfinite] Suggestion for "{task}":')
        print(f"  Best action:  {suggestion.action_name} (confidence: {suggestion.confidence:.0%})")
        print(f"  Reason:       {suggestion.reason}")
        if suggestion.ranked:
            print("  Ranked:")
            for i, ranked_action in enumerate(suggestion.ranked, 1):
                print(f"    {i}. {ranked_action.action_name:<20} (score: {ranked_action.score:.2f})")
        print("")

        return suggestion

    def recommend(self, task: str) -> Recommendation:
        """
        Get a plain-English recommendation based on accumulated outcome data.
        Available in ALL modes.

        Args:
            task: Task name (e.g. "payment_failed")

        Returns:
            Recommendation dataclass.

        Raises:
            LayerinfiniteError: If backend is unreachable.
        """
        import urllib.parse

        encoded = urllib.parse.quote(task)
        try:
            resp = self._request(
                "GET",
                f"/v1/recommendations?task={encoded}",
                retry_server_errors=False,
            )
            data = resp.json()
        except LayerinfiniteServerError as exc:
            logger.warning(
                "[layerinfinite] recommend() backend unavailable: %s. "
                "Returning no_data recommendation.",
                exc,
            )
            data = {}

        rec = Recommendation(
            task=task,
            state=data.get("state", "no_data"),
            problem=data.get("problem"),
            recommendation=data.get("recommendation"),
            expected_improvement=data.get("expected_improvement"),
            reason=data.get("reason"),
            confidence=data.get("confidence"),
        )

        print(f'\n[layerinfinite] Recommendation for "{task}":')
        print(f"  State:      {rec.state}")
        if rec.problem:
            print(f"  Problem:    {rec.problem}")
        if rec.recommendation:
            print(f"  Action:     {rec.recommendation}")
        if rec.expected_improvement:
            imp = rec.expected_improvement
            print(f"  Impact:     {imp.get('baseline')} -> {imp.get('improved')} ({imp.get('delta')})")
        if rec.reason:
            print(f"  Reason:     {rec.reason}")
        if rec.confidence is not None:
            print(f"  Confidence: {round(rec.confidence * 100)}%")
        print("")

        return rec

    def scores(self, task: str) -> GetScoresResponse:
        """
        Fetch raw ranked action scores for a task. Available in ALL modes.
        Power users and dashboards.

        Args:
            task: Task name / issue_type.

        Returns:
            GetScoresResponse with ranked_actions, top_action, policy.
        """
        scores_resp = self._fetch_scores(task)
        if scores_resp is None:
            return GetScoresResponse(ranked_actions=[])
        return scores_resp

    def observe(self, task: str) -> ObservationSummary:
        """
        Get quick outcome stats for a task. Available in ALL modes.
        Pretty-prints to console for terminal-first developers.

        Args:
            task: Task name.

        Returns:
            ObservationSummary dataclass.
        """
        import urllib.parse

        encoded = urllib.parse.quote(task)
        try:
            resp = self._request(
                "GET",
                f"/v1/observe?task={encoded}",
                retry_server_errors=False,
            )
            data = resp.json()
        except LayerinfiniteServerError as exc:
            logger.warning(
                "[layerinfinite] observe() backend unavailable: %s. "
                "Returning cold-start observation.",
                exc,
            )
            data = {
                "task": task,
                "total_runs": 0,
                "success_rate": 0.0,
                "actions_seen": [],
                "best_performing": None,
                "worst_performing": None,
                "last_run": None,
            }

        obs = ObservationSummary(
            task=data["task"],
            total_runs=data["total_runs"],
            success_rate=data["success_rate"],
            actions_seen=data["actions_seen"],
            best_performing=data.get("best_performing"),
            worst_performing=data.get("worst_performing"),
            last_run=data.get("last_run"),
        )

        print(f'\n[layerinfinite] Stats for "{task}":')
        print(f"  Total runs:      {obs.total_runs}")
        print(f"  Success rate:    {obs.success_rate:.0%}")
        if obs.total_runs == 0:
            print("  No outcome data yet for this task.")
        if obs.actions_seen:
            print(f"  Actions seen:    {', '.join(obs.actions_seen)}")
        if obs.best_performing:
            print(f"  Best performing: {obs.best_performing}")
        if obs.worst_performing:
            print(f"  Worst performing: {obs.worst_performing}")
        if obs.last_run:
            print(f"  Last run:        {obs.last_run}")
        print("")

        return obs

    def health(self) -> dict:
        """Check API health. No auth required."""
        logger.debug("GET /health")
        resp = self._request("GET", "/health", timeout=5.0)
        return resp.json()

    def list_actions(self, task: str | None = None) -> Dict[str, List[str]]:
        """
        List all registered actions, optionally filtered by task.

        Returns:
            Dict mapping task name -> list of action names.
            Example: {"payment_failed": ["retry_payment", "switch_provider"]}
        """
        with self._registry_lock:
            if task is not None:
                actions = self._actions.get(task, {})
                return {task: list(actions.keys())}
            return {t: list(a.keys()) for t, a in self._actions.items()}

    def log_outcome(self, request: LogOutcomeRequest) -> LogOutcomeResponse:
        """
        Backward-compatible direct outcome logging method for power users.
        """
        payload = request.model_dump(exclude_none=True)
        if not payload.get("session_id"):
            payload["session_id"] = str(uuid.uuid4())
        response = self._request("POST", "/v1/log-outcome", json=payload)
        return LogOutcomeResponse.model_validate(response.json())

    def _log_outcome(
        self,
        task: str,
        action_name: str,
        success: bool,
        session_id: str,
        latency_ms: int = 0,
        outcome_score: float | None = None,
        error: str | None = None,
    ) -> None:
        """
        POST /v1/log-outcome.
        If log_async=True (default): fire in background daemon thread.
        If log_async=False: send synchronously.
        NEVER raises to the caller — logs warnings only.

        Note: The backend expects 'response_ms' (SDK alias for response_time_ms).
        """
        payload: Dict[str, Any] = {
            "agent_id": self._agent_id,
            "action_name": action_name,
            "issue_type": task,
            "success": success,
            "session_id": session_id,
            "response_ms": latency_ms,  # backend alias: response_ms → response_time_ms
        }
        if outcome_score is not None:
            payload["outcome_score"] = outcome_score
        if error:
            payload["metadata"] = {"error": error}

        def _send() -> None:
            try:
                self._request("POST", "/v1/log-outcome", json=payload)
            except Exception as exc:
                logger.warning(
                    "[layerinfinite] Failed to log outcome for %s/%s: %s",
                    task,
                    action_name,
                    exc,
                )

        if self._log_async:
            threading.Thread(target=_send, daemon=True).start()
        else:
            _send()

    def _compute_outcome_score(
        self,
        task: str,
        action_name: str,
        score_fn: Callable[[Any], float | None] | None,
        result: Any,
    ) -> float | None:
        if inspect.iscoroutine(result):
            logger.debug(
                "[layerinfinite] '%s/%s' is async - score callback skipped. "
                "Use the async SDK wrapper for async actions.",
                task,
                action_name,
            )
            return None

        if score_fn is None:
            return None

        try:
            raw_score = score_fn(result)
        except Exception as exc:
            logger.warning(
                "[layerinfinite] score_fn failed for %s/%s: %s",
                task,
                action_name,
                exc,
            )
            return None

        if raw_score is None:
            return None

        if not isinstance(raw_score, (int, float)):
            logger.warning(
                "[layerinfinite] score_fn for %s/%s returned non-numeric value %r; skipping outcome_score.",
                task,
                action_name,
                raw_score,
            )
            return None

        score = float(raw_score)
        if score < 0.0 or score > 1.0:
            logger.warning(
                "[layerinfinite] score_fn for %s/%s returned out-of-range score %.4f; expected [0.0, 1.0].",
                task,
                action_name,
                score,
            )
            return None

        return score

    def _register_action_in_dashboard(self, task: str, action_name: str) -> None:
        """
        No-op. Action registration is handled automatically by the backend.

        When the decorated function is called for the first time,
        _log_outcome() fires POST /v1/log-outcome. The server's
        validateActionMiddleware intercepts the request and upserts
        the action into dim_actions scoped to this customer.
        It also seeds dim_institutional_knowledge with a baseline
        prior so scoring starts immediately.

        The /v1/admin/register-action endpoint requires customer_admin
        session auth — not an agent API key. The SDK must not call it.

        auto_register=True is preserved in the constructor signature
        for forward compatibility when a dedicated SDK-accessible
        registration endpoint is added.
        """
        if self._auto_register:
            logger.debug(
                "[layerinfinite] '%s/%s' will be auto-registered in dashboard "
                "on first outcome log via validateActionMiddleware.",
                task,
                action_name,
            )

    def _fetch_scores(self, task: str) -> GetScoresResponse | None:
        """
        GET /v1/get-scores?issue_type={task}
        Returns None if cold start (no scores available).
        """
        try:
            resp = self._request(
                "GET",
                "/v1/get-scores",
                params={"issue_type": task, "environment": "production"},
            )
            scores = GetScoresResponse.model_validate(resp.json())
            if not scores.ranked_actions and not scores.top_action:
                return None
            return scores
        except LayerinfiniteError:
            raise
        except Exception as exc:
            logger.warning("[layerinfinite] _fetch_scores failed: %s", exc)
            return None

    def _build_execution_order(self, task: str) -> List[str]:
        """
        Returns action names in execution priority order:
          1. Actions ranked by backend score (highest first)
          2. Registered actions NOT in backend scores (appended at end)

        On backend failure: falls back to registration order (dict insertion order).
        """
        with self._registry_lock:
            registered = list(self._actions.get(task, {}).keys())
            registered_set = set(self._actions.get(task, {}).keys())

        try:
            scores_resp = self._fetch_scores(task)
        except Exception as exc:
            logger.warning(
                "[layerinfinite] Cannot reach scoring engine, using registration order: %s",
                exc,
            )
            return registered

        if not scores_resp or not scores_resp.ranked_actions:
            return registered

        scored_names = [
            action.action_name
            for action in scores_resp.ranked_actions
            if action.action_name in registered_set
        ]
        unscored = [action_name for action_name in registered if action_name not in scored_names]
        return scored_names + unscored

    def _build_ranked_from_scores(
        self,
        scores_resp: GetScoresResponse | None,
    ) -> List[RankedAction]:
        """Convert GetScoresResponse ranked_actions to List[RankedAction]."""
        if not scores_resp:
            return []
        return [
            RankedAction(
                action_name=action.action_name,
                score=action.composite_score,
                confidence=action.confidence,
            )
            for action in scores_resp.ranked_actions
        ]

    def _request(
        self,
        method: str,
        path: str,
        retry_server_errors: bool = True,
        **kwargs: Any,
    ) -> httpx.Response:
        """
        HTTP request with retry logic.
        - 429: wait Retry-After header seconds, retry up to max_retries
                - 5xx: exponential backoff (1s, 2s, 4s), retry up to max_retries
                    unless retry_server_errors=False
        - Timeout: retry up to max_retries
        - Network error: retry up to max_retries
        - 401, 404, other 4xx: raise immediately (no retry)
        """
        last_exc: Exception | None = None

        for attempt in range(self._max_retries + 1):
            endpoint_idx, client, endpoint_base_url = self._current_http_client()
            try:
                logger.debug(
                    "[layerinfinite] %s %s via %s (attempt %d)",
                    method,
                    path,
                    endpoint_base_url,
                    attempt + 1,
                )
                resp = client.request(method, path, **kwargs)

                if resp.status_code == 429 and attempt < self._max_retries:
                    retry_after = int(resp.headers.get("Retry-After", 60))
                    logger.warning(
                        "[layerinfinite] Rate limited. Waiting %ds (attempt %d/%d).",
                        retry_after,
                        attempt + 1,
                        self._max_retries,
                    )
                    time.sleep(retry_after)
                    continue

                if (
                    retry_server_errors
                    and resp.status_code >= 500
                    and attempt < self._max_retries
                ):
                    self._rotate_endpoint(f"server error {resp.status_code}")
                    wait = 2**attempt
                    logger.warning(
                        "[layerinfinite] Server error %d. Backing off %ds (attempt %d/%d).",
                        resp.status_code,
                        wait,
                        attempt + 1,
                        self._max_retries,
                    )
                    time.sleep(wait)
                    continue

                self._raise_for_status(resp)
                return resp

            except (LayerinfiniteAuthError, LayerinfiniteNotFoundError):
                raise
            except (LayerinfiniteRateLimitError, LayerinfiniteServerError, LayerinfiniteError) as exc:
                last_exc = exc
                if attempt >= self._max_retries:
                    raise
            except httpx.TimeoutException as exc:
                last_exc = exc
                self._rotate_endpoint("timeout")
                wait = min(2**attempt, 8)
                logger.warning(
                    "[layerinfinite] Timeout via %s (attempt %d/%d). Backing off %ds.",
                    endpoint_base_url,
                    attempt + 1,
                    self._max_retries,
                    wait,
                )
                if attempt >= self._max_retries:
                    raise LayerinfiniteError("Request timed out.") from exc
                time.sleep(wait)
            except httpx.RequestError as exc:
                last_exc = exc
                self._rotate_endpoint("network request error")
                wait = min(2**attempt, 8)
                logger.warning(
                    "[layerinfinite] Network error via %s: %s (attempt %d/%d). Backing off %ds.",
                    endpoint_base_url,
                    exc,
                    attempt + 1,
                    self._max_retries,
                    wait,
                )
                if attempt >= self._max_retries:
                    raise LayerinfiniteError(f"Network error: {exc}") from exc
                time.sleep(wait)

        raise LayerinfiniteError("Max retries exceeded.") from last_exc

    def _raise_for_status(self, resp: httpx.Response) -> None:
        if resp.status_code < 400:
            return
        try:
            body = resp.json()
        except Exception:
            body = {}

        code = resp.status_code
        if code == 401:
            raise LayerinfiniteAuthError(
                "Invalid or missing API key. Verify your X-API-Key.",
                status_code=code,
                response_body=body,
            )
        if code == 404:
            raise LayerinfiniteNotFoundError(
                "Resource not found.",
                status_code=code,
                response_body=body,
            )
        if code == 429:
            retry_after = int(resp.headers.get("Retry-After", 60))
            raise LayerinfiniteRateLimitError(
                f"Rate limit exceeded. Retry after {retry_after}s.",
                status_code=code,
                response_body=body,
                retry_after=retry_after,
            )
        if code >= 500:
            raise LayerinfiniteServerError(
                f"Server error [{code}]: {body.get('error', 'unknown')}",
                status_code=code,
                response_body=body,
            )
        raise LayerinfiniteError(
            f"Request error [{code}]: {body.get('error', 'unknown')}",
            status_code=code,
            response_body=body,
        )


LayerinfiniteClient = Layerinfinite
