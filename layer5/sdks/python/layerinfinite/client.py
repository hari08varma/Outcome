from __future__ import annotations

import difflib
import functools
import inspect
import json
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
    DiscrepancyDetectResponse,
    DiscrepancyDriftSnapshot,
    DiscrepancySummaryResponse,
    GetScoresResponse,
    LogOutcomeRequest,
    LogOutcomeResponse,
    ObservationSummary,
    OutcomeFeedbackRequest,
    OutcomeFeedbackResponse,
    PendingSignalRequest,
    PendingSignalResponse,
    RankedAction,
    Recommendation,
    RecommendationDataFreshness,
    Suggestion,
)

logger = logging.getLogger("layerinfinite")

_VALID_MODES = ("recommend", "assist", "auto")
_SDK_VERSION = "0.4.2"
_DEFAULT_BASE_URL = "https://api.layerinfinite.app"
_BASE_URLS_ENV = "LAYERINFINITE_BASE_URLS"
_SCORES_CACHE_TTL_SECONDS = 15 * 60
_RECOMMENDATION_CACHE_TTL_SECONDS = 10 * 60
_OBSERVE_CACHE_TTL_SECONDS = 10 * 60
_PENDING_OUTCOMES_FILE_ENV = "LAYERINFINITE_PENDING_OUTCOMES_FILE"
_DEFAULT_PENDING_OUTCOMES_FILE = os.path.join(
    os.path.expanduser("~"),
    ".layerinfinite",
    "pending_outcomes.jsonl",
)
_PENDING_REPLAY_INTERVAL_SECONDS = 5


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
        min_observations_per_action: int = 0,
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

        # Auto-capture environment from LI_ENVIRONMENT env var.
        # Falls back to "production" when unset — same default the API uses.
        # This ensures context_id is correctly scoped per environment so
        # staging outcomes don't bleed into production recommendations.
        _env_raw = os.getenv("LI_ENVIRONMENT", "").strip().lower()
        _env_aliases = {"prod": "production", "stg": "staging", "dev": "development", "qa": "staging"}
        self._environment: str = _env_aliases.get(_env_raw, _env_raw) if _env_raw else "production"

        # Fix 1: Exploration floor — track per-(task, action) observation counts.
        # min_observations_per_action=0 means disabled (backward-compatible).
        self._min_observations_per_action = max(0, int(min_observations_per_action))
        self._obs_counts: Dict[str, Dict[str, int]] = {}
        self._obs_counts_lock = threading.Lock()

        self._base_urls = self._resolve_base_urls(self._base_url)
        self._endpoint_lock = threading.Lock()
        self._active_endpoint_index = 0
        self._scores_cache_ttl_seconds = _SCORES_CACHE_TTL_SECONDS
        self._scores_cache: Dict[str, tuple[float, GetScoresResponse]] = {}
        self._scores_cache_lock = threading.Lock()
        self._recommendation_cache_ttl_seconds = _RECOMMENDATION_CACHE_TTL_SECONDS
        self._recommendation_cache: Dict[str, tuple[float, Dict[str, Any]]] = {}
        self._observe_cache_ttl_seconds = _OBSERVE_CACHE_TTL_SECONDS
        self._observe_cache: Dict[str, tuple[float, Dict[str, Any]]] = {}
        self._snapshot_cache_lock = threading.Lock()

        self._pending_outcomes_file = (
            os.getenv(_PENDING_OUTCOMES_FILE_ENV, "").strip()
            or _DEFAULT_PENDING_OUTCOMES_FILE
        )
        self._pending_outcomes_lock = threading.Lock()
        self._pending_replay_interval_seconds = _PENDING_REPLAY_INTERVAL_SECONDS
        self._last_pending_replay_attempt = 0.0

        self._actions: Dict[str, Dict[str, ActionEntry]] = {}
        self._registry_lock = threading.Lock()
        self._active_run_decision_context: Dict[str, Any] | None = None

        # Tracks the most recent suggest() decision_id per task.
        # When @li.action wrapper fires after a suggest(), it picks this up
        # so LI knows which suggestion was active — even if a different action was run.
        self._active_suggest_context: Dict[str, str] = {}  # task -> decision_id
        self._suggest_context_lock = threading.Lock()

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

    def _cache_scores(self, task: str, scores: GetScoresResponse) -> None:
        if not scores.ranked_actions and not scores.top_action:
            return

        with self._scores_cache_lock:
            self._scores_cache[task] = (time.monotonic(), scores)

    def _get_cached_scores(self, task: str) -> tuple[GetScoresResponse | None, float | None]:
        with self._scores_cache_lock:
            entry = self._scores_cache.get(task)

        if entry is None:
            return None, None

        cached_at, cached_scores = entry
        age_seconds = max(0.0, time.monotonic() - cached_at)

        if age_seconds > self._scores_cache_ttl_seconds:
            with self._scores_cache_lock:
                self._scores_cache.pop(task, None)
            return None, None

        return cached_scores, age_seconds

    def _cache_snapshot(
        self,
        cache: Dict[str, tuple[float, Dict[str, Any]]],
        key: str,
        payload: Dict[str, Any],
    ) -> None:
        with self._snapshot_cache_lock:
            cache[key] = (time.monotonic(), dict(payload))

    def _get_cached_snapshot(
        self,
        cache: Dict[str, tuple[float, Dict[str, Any]]],
        key: str,
        ttl_seconds: float,
    ) -> tuple[Dict[str, Any] | None, float | None]:
        with self._snapshot_cache_lock:
            entry = cache.get(key)

        if entry is None:
            return None, None

        cached_at, payload = entry
        age_seconds = max(0.0, time.monotonic() - cached_at)
        if age_seconds > ttl_seconds:
            with self._snapshot_cache_lock:
                cache.pop(key, None)
            return None, None

        return dict(payload), age_seconds

    def _enqueue_pending_outcome(self, payload: Dict[str, Any]) -> None:
        if not payload:
            return

        path = self._pending_outcomes_file
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)

        with self._pending_outcomes_lock:
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(payload, default=str) + "\n")

    def _flush_pending_outcomes(self) -> tuple[int, int]:
        path = self._pending_outcomes_file
        if not os.path.exists(path):
            return (0, 0)

        with self._pending_outcomes_lock:
            try:
                with open(path, "r", encoding="utf-8") as f:
                    queued = [json.loads(line) for line in f if line.strip()]
            except Exception as exc:
                logger.warning("[layerinfinite] Failed reading pending outcomes queue: %s", exc)
                return (0, 0)

            if not queued:
                try:
                    os.remove(path)
                except OSError:
                    pass
                return (0, 0)

            sent = 0
            remaining: List[Dict[str, Any]] = []
            for idx, payload in enumerate(queued):
                try:
                    self._request("POST", "/v1/log-outcome", json=payload)
                    sent += 1
                except Exception as exc:
                    logger.warning(
                        "[layerinfinite] Pending outcome replay paused (%d sent): %s",
                        sent,
                        exc,
                    )
                    remaining.extend(queued[idx:])
                    break

            if remaining:
                with open(path, "w", encoding="utf-8") as f:
                    for payload in remaining:
                        f.write(json.dumps(payload, default=str) + "\n")
            else:
                try:
                    os.remove(path)
                except OSError:
                    pass

            return (sent, len(remaining))

    def _maybe_replay_pending_outcomes(self) -> tuple[int, int]:
        now = time.monotonic()
        if (now - self._last_pending_replay_attempt) < self._pending_replay_interval_seconds:
            return (0, 0)

        self._last_pending_replay_attempt = now
        return self._flush_pending_outcomes()

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
                    run_ctx = self._active_run_decision_context
                    decision_id = None
                    episode_id = None

                    # Priority 1: auto mode — run() sets _active_run_decision_context.
                    if (
                        isinstance(run_ctx, dict)
                        and run_ctx.get("task") == task
                        and run_ctx.get("action_name") == action_name
                    ):
                        decision_id = run_ctx.get("decision_id")
                        episode_id = run_ctx.get("episode_id")

                    # Priority 2: assist/recommend mode — suggest() set context.
                    # LI knows which suggestion was active when this action ran,
                    # even if the developer ran a different action than suggested.
                    # Clear after one use so it doesn't bleed into the next call.
                    if decision_id is None:
                        with self._suggest_context_lock:
                            suggest_decision_id = self._active_suggest_context.pop(task, None)
                        if suggest_decision_id:
                            decision_id = suggest_decision_id

                    self._log_outcome(
                        task=task,
                        action_name=action_name,
                        success=success,
                        session_id=session_id,
                        latency_ms=latency_ms,
                        outcome_score=outcome_score,
                        decision_id=decision_id,
                        episode_id=episode_id,
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

            if scores_resp and scores_resp.policy == "abstain":
                ranked = self._build_ranked_from_scores(scores_resp)
                top_name = (
                    scores_resp.top_action.action_name
                    if scores_resp.top_action
                    else (next(iter(task_actions), "unknown"))
                )
                abstain_reason = (
                    scores_resp.policy_abstain_message
                    or top_reason
                    or "Top actions are statistically indistinguishable. Gather more outcomes or escalate."
                )
                outcomes_needed = getattr(scores_resp, "outcomes_needed", 0)
                suggestion = Suggestion(
                    action_name=top_name,
                    confidence=top_confidence,
                    reason=abstain_reason,
                    ranked=ranked,
                    outcomes_needed=outcomes_needed,
                    cold_start=getattr(scores_resp, "cold_start", False),
                )
                # Fix 3: Rich abstain message with actionable guidance.
                needed_hint = (
                    f" Log ~{outcomes_needed} more outcomes to activate."
                    if outcomes_needed > 0 else ""
                )
                raise LowConfidenceError(
                    f"Policy abstain for task '{task}'. "
                    f"[LI abstain] task='{task}' policy=abstain "
                    f"confidence={top_confidence:.0%} threshold={self._confidence_threshold:.0%}. "
                    f"Best candidate: '{top_name}'.{needed_hint} "
                    f"Reason: {abstain_reason}",
                    suggestion=suggestion,
                    confidence=top_confidence,
                    threshold=self._confidence_threshold,
                )
        except Exception as exc:
            if isinstance(exc, LowConfidenceError):
                raise
            logger.warning("[layerinfinite] Could not fetch confidence scores: %s", exc)

        try:
            execution_plan = self._build_execution_order(
                task,
                preloaded_scores=scores_resp,
            )
        except TypeError as exc:
            # Backward compatibility for overrides/tests that still provide
            # _build_execution_order(task) without the preloaded_scores kwarg.
            if 'preloaded_scores' not in str(exc):
                raise
            execution_plan = self._build_execution_order(task)

        if isinstance(execution_plan, tuple):
            execution_order, decision_id = execution_plan
        else:
            execution_order = list(execution_plan or [])
            decision_id = None
        episode_id = str(uuid.uuid4())

        if top_confidence > 0.0 and top_confidence < self._confidence_threshold:
            ranked = self._build_ranked_from_scores(scores_resp) if scores_resp else []
            top_name = execution_order[0] if execution_order else "unknown"
            outcomes_needed = getattr(scores_resp, "outcomes_needed", 0) if scores_resp else 0
            suggestion = Suggestion(
                action_name=top_name,
                confidence=top_confidence,
                reason=top_reason,
                ranked=ranked,
                outcomes_needed=outcomes_needed,
                cold_start=getattr(scores_resp, "cold_start", False) if scores_resp else False,
            )
            # Fix 3: Rich message showing how far from threshold.
            gap = self._confidence_threshold - top_confidence
            needed_hint = (
                f" Log ~{outcomes_needed} more outcomes to close the gap."
                if outcomes_needed > 0 else " Keep logging outcomes."
            )
            raise LowConfidenceError(
                f"[LI low-confidence] task='{task}' "
                f"confidence={top_confidence:.0%} (need {self._confidence_threshold:.0%}, "
                f"gap={gap:.0%}). Best candidate: '{top_name}'.{needed_hint}",
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
            self._active_run_decision_context = {
                "task": task,
                "action_name": action_name,
                "decision_id": decision_id,
                "episode_id": episode_id,
            }

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
                    decision_id=decision_id,
                    episode_id=episode_id,
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
                    decision_id=decision_id,
                    episode_id=episode_id,
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
            finally:
                self._active_run_decision_context = None

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
                outcomes_needed=getattr(scores_resp, "outcomes_needed", 0) if scores_resp else 0,
                cold_start=True,
                decision_id=getattr(scores_resp, "decision_id", None) if scores_resp else None,
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
                outcomes_needed=getattr(scores_resp, "outcomes_needed", 0),
                cold_start=getattr(scores_resp, "cold_start", False),
                decision_id=scores_resp.decision_id,
            )

        # Fix B: Store suggest context so @li.action wrapper can link the
        # actual executed action back to this suggestion's decision_id.
        if suggestion.decision_id:
            with self._suggest_context_lock:
                self._active_suggest_context[task] = suggestion.decision_id

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
            self._cache_snapshot(self._recommendation_cache, task, data)
        except LayerinfiniteServerError as exc:
            cached_data, age_seconds = self._get_cached_snapshot(
                self._recommendation_cache,
                task,
                self._recommendation_cache_ttl_seconds,
            )
            if cached_data is not None and age_seconds is not None:
                logger.warning(
                    "[layerinfinite] recommend() backend unavailable: %s. Using cached recommendation from %.1fs ago.",
                    exc,
                    age_seconds,
                )
                data = cached_data
            else:
                logger.warning(
                    "[layerinfinite] recommend() backend unavailable: %s. "
                    "Returning no_data recommendation.",
                    exc,
                )
                data = {}
        except LayerinfiniteError as exc:
            cached_data, age_seconds = self._get_cached_snapshot(
                self._recommendation_cache,
                task,
                self._recommendation_cache_ttl_seconds,
            )
            if cached_data is not None and age_seconds is not None:
                logger.warning(
                    "[layerinfinite] recommend() network issue: %s. Using cached recommendation from %.1fs ago.",
                    exc,
                    age_seconds,
                )
                data = cached_data
            else:
                logger.warning(
                    "[layerinfinite] recommend() network issue: %s. "
                    "Returning no_data recommendation.",
                    exc,
                )
                data = {}
        except Exception as exc:
            cached_data, age_seconds = self._get_cached_snapshot(
                self._recommendation_cache,
                task,
                self._recommendation_cache_ttl_seconds,
            )
            if cached_data is not None and age_seconds is not None:
                logger.warning(
                    "[layerinfinite] recommend() unexpected error: %s. Using cached recommendation from %.1fs ago.",
                    exc,
                    age_seconds,
                )
                data = cached_data
            else:
                logger.warning(
                    "[layerinfinite] recommend() unexpected error: %s. "
                    "Returning no_data recommendation.",
                    exc,
                )
                data = {}

        freshness_raw = data.get("data_freshness")
        freshness: RecommendationDataFreshness | None = None
        if isinstance(freshness_raw, dict):
            source_raw = str(freshness_raw.get("source", "unknown"))
            source = source_raw if source_raw in {"mv", "fact_fallback", "unknown"} else "unknown"

            age_raw = freshness_raw.get("age_hours")
            age_hours: float | None
            try:
                age_hours = float(age_raw) if age_raw is not None else None
            except (TypeError, ValueError):
                age_hours = None

            stale_threshold_raw = freshness_raw.get("stale_threshold_hours", 72)
            try:
                stale_threshold = int(stale_threshold_raw)
            except (TypeError, ValueError):
                stale_threshold = 72

            freshness = RecommendationDataFreshness(
                source=source,  # type: ignore[arg-type]
                last_seen_at=freshness_raw.get("last_seen_at"),
                age_hours=age_hours,
                is_stale=bool(freshness_raw.get("is_stale", False)),
                stale_threshold_hours=stale_threshold,
            )

        rec = Recommendation(
            task=task,
            state=data.get("state", "no_data"),
            problem=data.get("problem"),
            recommendation=data.get("recommendation"),
            expected_improvement=data.get("expected_improvement"),
            data_freshness=freshness,
            reason=data.get("reason"),
            confidence=data.get("confidence"),
            confidence_source=data.get("confidence_source"),
            traceability=data.get("traceability"),
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
        if rec.data_freshness and rec.data_freshness.is_stale:
            age_text = (
                f"{rec.data_freshness.age_hours:.1f}h"
                if rec.data_freshness.age_hours is not None
                else "unknown age"
            )
            print(
                f"  Freshness:  stale ({age_text}) from {rec.data_freshness.source}"
            )
        print("")

        return rec

    def scores(self, task: str, raw_context: Dict[str, Any] | None = None) -> GetScoresResponse:
        """
        Fetch raw ranked action scores for a task. Available in ALL modes.
        Power users and dashboards.

        Args:
            task: Task name / issue_type.
            raw_context: Optional per-request context dictionary used for
                semantic context matching on the scoring endpoint.

        Returns:
            GetScoresResponse with ranked_actions, top_action, policy.
        """
        scores_resp = self._fetch_scores(task, raw_context=raw_context)
        if scores_resp is None:
            return GetScoresResponse(ranked_actions=[], cold_start=True, outcomes_needed=50)
        if scores_resp.cold_start and scores_resp.outcomes_needed > 0:
            logger.info(
                "[layerinfinite] Cold start for task '%s': log %d more outcome(s) to activate recommendations.",
                task,
                scores_resp.outcomes_needed,
            )
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
            self._cache_snapshot(self._observe_cache, task, data)
        except LayerinfiniteServerError as exc:
            cached_data, age_seconds = self._get_cached_snapshot(
                self._observe_cache,
                task,
                self._observe_cache_ttl_seconds,
            )
            if cached_data is not None and age_seconds is not None:
                logger.warning(
                    "[layerinfinite] observe() backend unavailable: %s. Using cached snapshot from %.1fs ago.",
                    exc,
                    age_seconds,
                )
                data = cached_data
            else:
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
        except LayerinfiniteError as exc:
            cached_data, age_seconds = self._get_cached_snapshot(
                self._observe_cache,
                task,
                self._observe_cache_ttl_seconds,
            )
            if cached_data is not None and age_seconds is not None:
                logger.warning(
                    "[layerinfinite] observe() network issue: %s. Using cached snapshot from %.1fs ago.",
                    exc,
                    age_seconds,
                )
                data = cached_data
            else:
                logger.warning(
                    "[layerinfinite] observe() network issue: %s. "
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
        except Exception as exc:
            cached_data, age_seconds = self._get_cached_snapshot(
                self._observe_cache,
                task,
                self._observe_cache_ttl_seconds,
            )
            if cached_data is not None and age_seconds is not None:
                logger.warning(
                    "[layerinfinite] observe() unexpected error: %s. Using cached snapshot from %.1fs ago.",
                    exc,
                    age_seconds,
                )
                data = cached_data
            else:
                logger.warning(
                    "[layerinfinite] observe() unexpected error: %s. "
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

    @staticmethod
    def normalize_business_outcome(value: str) -> str:
        """
        Fix 2 — Data resilience: normalize free-text business_outcome to
        the API's canonical values: resolved | partial | failed | unknown.

        Examples: "ok" -> "resolved", "error" -> "failed", "partial" -> "partial"
        """
        _MAP: Dict[str, str] = {
            "resolved": "resolved", "success": "resolved", "ok": "resolved",
            "done": "resolved", "completed": "resolved", "passed": "resolved",
            "partial": "partial", "degraded": "partial", "incomplete": "partial",
            "failed": "failed", "failure": "failed", "error": "failed",
            "err": "failed", "rejected": "failed", "declined": "failed",
        }
        normalized = str(value or "").strip().lower()
        return _MAP.get(normalized, "unknown")

    @staticmethod
    def normalize_task(value: str) -> str:
        """
        Normalize a task name (issue_type) to a consistent canonical form.
        Strips whitespace, lowercases, replaces spaces and hyphens with underscores.

        Examples:
          "Payment_Failed"  -> "payment_failed"
          "payment failed"  -> "payment_failed"
          "API-Timeout"     -> "api_timeout"
          "  user_not_responding  " -> "user_not_responding"
        """
        return str(value or "").strip().lower().replace(" ", "_").replace("-", "_")

    def log_outcome(self, request: LogOutcomeRequest) -> LogOutcomeResponse:
        """
        Backward-compatible direct outcome logging method for power users.
        Fix 2 — Data resilience:
          - Normalizes issue_type (task) to canonical snake_case form.
          - Fuzzy-matches action_name against registered actions to catch typos.
          - Normalizes business_outcome to canonical values before sending.
          - Warns on inconsistency (success=True but very low outcome_score).
        """
        # Fix 2a: Normalize issue_type — prevents task fragmentation from
        # casing/spacing differences ("Payment_Failed" vs "payment_failed").
        canonical_task = self.normalize_task(request.issue_type)
        if canonical_task != request.issue_type:
            logger.warning(
                "[layerinfinite] issue_type '%s' normalized to '%s'.",
                request.issue_type,
                canonical_task,
            )
            request = request.model_copy(update={"issue_type": canonical_task})

        task = request.issue_type
        action_name = request.action_name

        if action_name is None and not (request.action_id or request.action_id_input):
            raise LayerinfiniteError(
                "log_outcome requires action_name or action_id/action_id_input."
            )

        # Fix 2b: Fuzzy match action_name against registered actions for this task.
        with self._registry_lock:
            registered_actions = list(self._actions.get(task, {}).keys())
        if action_name is not None and registered_actions and action_name not in registered_actions:
            matches = difflib.get_close_matches(action_name, registered_actions, n=1, cutoff=0.8)
            if matches:
                logger.warning(
                    "[layerinfinite] action_name '%s' not found for task '%s'. "
                    "Fuzzy-matched to '%s'. Substituting.",
                    action_name,
                    task,
                    matches[0],
                )
                # Rebuild request with corrected action_name (Pydantic model is immutable).
                request = request.model_copy(update={"action_name": matches[0]})
                action_name = matches[0]
            else:
                logger.warning(
                    "[layerinfinite] action_name '%s' not found for task '%s' "
                    "and no close match found. Sending as-is — API may reject it.",
                    action_name,
                    task,
                )

        # Fix 2c: Normalize business_outcome if provided.
        if request.business_outcome is not None:
            canonical = self.normalize_business_outcome(request.business_outcome)
            if canonical != request.business_outcome:
                logger.debug(
                    "[layerinfinite] business_outcome '%s' normalized to '%s'.",
                    request.business_outcome,
                    canonical,
                )
                request = request.model_copy(update={"business_outcome": canonical})

        if request.execution_status is not None:
            inferred_success_from_status = request.execution_status == "COMPLETED"
            if inferred_success_from_status != request.success:
                raise LayerinfiniteError(
                    "execution_status conflicts with success. "
                    "Use COMPLETED with success=True or FAILED with success=False."
                )

        payload = request.model_dump(exclude_none=True)
        if payload.get("action_id") and not payload.get("action_id_input"):
            payload["action_id_input"] = payload["action_id"]
        if not payload.get("session_id"):
            payload["session_id"] = str(uuid.uuid4())
        if not payload.get("idempotency_key"):
            payload["idempotency_key"] = str(uuid.uuid4())

        # Fix 1: Increment obs count for exploration floor tracking.
        if self._min_observations_per_action > 0:
            with self._obs_counts_lock:
                task_counts = self._obs_counts.setdefault(task, {})
                task_counts[action_name] = task_counts.get(action_name, 0) + 1

        response = self._request("POST", "/v1/log-outcome", json=payload)
        result = LogOutcomeResponse.model_validate(response.json())

        # Fix 2d: Contradiction quarantine — warn when ingestion_quality flags inconsistency.
        if (
            result.ingestion_quality
            and result.ingestion_quality.is_inconsistent
            and request.outcome_score is not None
        ):
            print(
                f"[layerinfinite] Inconsistency detected: success={request.success} and "
                f"outcome_score={request.outcome_score:.2f} for '{task}/{action_name or request.action_id or request.action_id_input}'. "
                f"Logged, but flagged. Consider revising your scoring logic."
            )

        return result

    def register_pending_signal(self, request: PendingSignalRequest) -> PendingSignalResponse:
        """
        Register a delayed feedback signal so external webhooks can reconcile later.
        """
        payload = request.model_dump(exclude_none=True)
        payload["feedback_signal"] = "delayed"
        response = self._request("POST", "/v1/pending-signals", json=payload)
        return PendingSignalResponse.model_validate(response.json())

    def submit_outcome_feedback(self, request: OutcomeFeedbackRequest) -> OutcomeFeedbackResponse:
        """
        Submit delayed feedback to finalize an outcome after provider callbacks.
        """
        payload = request.model_dump(exclude_none=True)
        response = self._request("POST", "/v1/outcome-feedback", json=payload)
        return OutcomeFeedbackResponse.model_validate(response.json())

    def build_delayed_signal_metadata(self, outcome_id: str) -> Dict[str, Any]:
        """
        Build provider-specific metadata payloads from an outcome_id.
        """
        normalized_outcome_id = str(outcome_id).strip()
        if not normalized_outcome_id:
            raise LayerinfiniteError("outcome_id must be a non-empty string.")

        return {
            "outcome_id": normalized_outcome_id,
            "stripe": {
                "metadata": {
                    "layerinfinite_outcome_id": normalized_outcome_id,
                }
            },
            "sendgrid": {
                "unique_args": {
                    "outcome_id": normalized_outcome_id,
                }
            },
            "generic": {
                "outcome_id": normalized_outcome_id,
            },
        }

    def detect_discrepancies(self) -> DiscrepancyDetectResponse:
        """
        Trigger discrepancy detection and return the current detection summary.
        """
        response = self._request("POST", "/v1/discrepancies/detect", json={})
        return DiscrepancyDetectResponse.model_validate(response.json())

    def discrepancy_summary(self) -> DiscrepancySummaryResponse:
        """
        Get unresolved discrepancy totals by discrepancy type.
        """
        response = self._request("GET", "/v1/discrepancies/summary")
        return DiscrepancySummaryResponse.model_validate(response.json())

    def monitor_discrepancy_drift(
        self,
        observed_outcomes: int | None = None,
        run_detection: bool = True,
    ) -> DiscrepancyDriftSnapshot:
        """
        Compute discrepancy and conflict drift rates for production monitoring.
        """
        detected = self.detect_discrepancies() if run_detection else None
        summary = self.discrepancy_summary()

        open_total_discrepancies = int(summary.total)
        open_conflict_discrepancies = int(summary.by_type.get("cross_event_conflict", 0))
        open_conflict_share = (
            open_conflict_discrepancies / open_total_discrepancies
            if open_total_discrepancies > 0
            else 0.0
        )

        denominator = observed_outcomes if isinstance(observed_outcomes, int) and observed_outcomes > 0 else None

        discrepancy_rate = (
            open_total_discrepancies / denominator
            if denominator is not None
            else None
        )
        conflict_rate = (
            open_conflict_discrepancies / denominator
            if denominator is not None
            else None
        )

        return DiscrepancyDriftSnapshot(
            open_total_discrepancies=open_total_discrepancies,
            open_conflict_discrepancies=open_conflict_discrepancies,
            open_conflict_share=open_conflict_share,
            discrepancy_rate=discrepancy_rate,
            conflict_rate=conflict_rate,
            detected_now=detected.detected if detected is not None else None,
            detected_conflicts_now=(
                detected.advanced_cases.cross_event_conflict
                if detected is not None
                else None
            ),
            by_type=summary.by_type,
        )

    def _log_outcome(
        self,
        task: str,
        action_name: str,
        success: bool,
        session_id: str,
        latency_ms: int = 0,
        outcome_score: float | None = None,
        decision_id: str | None = None,
        episode_id: str | None = None,
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
            "idempotency_key": str(uuid.uuid4()),
            # Auto-captured from LI_ENVIRONMENT env var (default: "production").
            # Ensures the API creates a context_id scoped to the right environment,
            # so staging outcomes don't pollute production recommendations.
            "environment": self._environment,
        }
        if outcome_score is not None:
            payload["outcome_score"] = outcome_score
        if decision_id:
            payload["decision_id"] = decision_id
        if episode_id:
            payload["episode_id"] = episode_id
        if error:
            payload["metadata"] = {"error": error}

        # Fix 1: Increment observation count immediately (before async send)
        # so exploration floor decisions see up-to-date counts.
        if self._min_observations_per_action > 0:
            with self._obs_counts_lock:
                task_counts = self._obs_counts.setdefault(task, {})
                task_counts[action_name] = task_counts.get(action_name, 0) + 1

        def _send() -> None:
            try:
                replayed, remaining = self._maybe_replay_pending_outcomes()
                if replayed > 0:
                    logger.info(
                        "[layerinfinite] Replayed pending outcomes: sent=%d remaining=%d",
                        replayed,
                        remaining,
                    )
            except Exception as exc:
                logger.debug("[layerinfinite] Pending replay skipped: %s", exc)

            try:
                self._request("POST", "/v1/log-outcome", json=payload)
            except LayerinfiniteAuthError as exc:
                logger.warning(
                    "[layerinfinite] Failed to log outcome for %s/%s due to auth error (not queued): %s",
                    task,
                    action_name,
                    exc,
                )
            except Exception as exc:
                try:
                    self._enqueue_pending_outcome(payload)
                    logger.warning(
                        "[layerinfinite] Failed to log outcome for %s/%s: %s. Queued for replay.",
                        task,
                        action_name,
                        exc,
                    )
                except Exception as queue_exc:
                    logger.warning(
                        "[layerinfinite] Failed to log outcome for %s/%s: %s (queue write failed: %s)",
                        task,
                        action_name,
                        exc,
                        queue_exc,
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

    def _fetch_scores(self, task: str, raw_context: Dict[str, Any] | None = None) -> GetScoresResponse | None:
        """
        GET /v1/get-scores?issue_type={task}
        Returns None if cold start (no scores available).
        Fix 3: Emits a cold-start progress indicator when outcomes_needed > 0.
        """
        try:
            params: Dict[str, Any] = {
                "issue_type": task,
                "environment": self._environment,
            }
            if raw_context:
                # Keep query payload bounded. API defensively ignores invalid JSON.
                params["raw_context"] = json.dumps(raw_context, default=str)[:2000]

            resp = self._request(
                "GET",
                "/v1/get-scores",
                params=params,
            )
            scores = GetScoresResponse.model_validate(resp.json())

            # Fix: Seed _obs_counts from backend total_attempts on first fetch.
            # Prevents exploration floor from restarting from zero after a process
            # restart — the backend already has the real observation counts.
            if self._min_observations_per_action > 0 and scores.ranked_actions:
                with self._obs_counts_lock:
                    task_counts = self._obs_counts.setdefault(task, {})
                    for action in scores.ranked_actions:
                        # Only seed if we have no local count yet — never overwrite
                        # in-process increments which are more up-to-date than the
                        # backend (which only refreshes every 5 min via cron).
                        if action.action_name not in task_counts:
                            task_counts[action.action_name] = action.total_attempts

            if not scores.ranked_actions and not scores.top_action:
                # Cold-start: show progress toward activation.
                if scores.outcomes_needed > 0:
                    with self._obs_counts_lock:
                        logged_so_far = sum(self._obs_counts.get(task, {}).values())
                    total_needed = scores.outcomes_needed + logged_so_far
                    pct = (logged_so_far / total_needed * 100) if total_needed > 0 else 0
                    print(
                        f"[layerinfinite] Warming up '{task}': "
                        f"~{scores.outcomes_needed} more outcomes needed to unlock recommendations "
                        f"({pct:.0f}% there). Keep logging."
                    )
                return None
            self._cache_scores(task, scores)
            return scores
        except LayerinfiniteError as exc:
            cached_scores, age_seconds = self._get_cached_scores(task)
            if cached_scores is not None and age_seconds is not None:
                logger.warning(
                    "[layerinfinite] _fetch_scores failed for %s; using cached ranking from %.1fs ago: %s",
                    task,
                    age_seconds,
                    exc,
                )
                return cached_scores
            raise
        except Exception as exc:
            cached_scores, age_seconds = self._get_cached_scores(task)
            if cached_scores is not None and age_seconds is not None:
                logger.warning(
                    "[layerinfinite] _fetch_scores hit unexpected error for %s; using cached ranking from %.1fs ago: %s",
                    task,
                    age_seconds,
                    exc,
                )
                return cached_scores
            logger.warning("[layerinfinite] _fetch_scores failed: %s", exc)
            return None

    def _build_execution_order(
        self,
        task: str,
        preloaded_scores: GetScoresResponse | None = None,
    ) -> tuple[List[str], str | None]:
        """
        Returns action names in execution priority order:
          1. Actions ranked by backend score (highest first)
          2. Registered actions NOT in backend scores (appended at end)

        Fix 1 — Exploration floor: if min_observations_per_action > 0, any action
        with fewer than that many observations is promoted to the front so LI
        sees it at least N times before exploiting the top scorer.

        On backend failure: falls back to registration order (dict insertion order).
        """
        with self._registry_lock:
            registered = list(self._actions.get(task, {}).keys())
            registered_set = set(self._actions.get(task, {}).keys())

        try:
            scores_resp = preloaded_scores if preloaded_scores is not None else self._fetch_scores(task)
        except Exception as exc:
            logger.warning(
                "[layerinfinite] Cannot reach scoring engine, using registration order: %s",
                exc,
            )
            return (registered, None)

        if not scores_resp or not scores_resp.ranked_actions:
            base_order = registered
        else:
            scored_names = [
                action.action_name
                for action in scores_resp.ranked_actions
                if action.action_name in registered_set
            ]
            unscored = [a for a in registered if a not in scored_names]
            base_order = scored_names + unscored

        decision_id = scores_resp.decision_id if scores_resp else None

        # Fix 1: Exploration floor — promote under-observed actions to front.
        if self._min_observations_per_action > 0 and registered:
            with self._obs_counts_lock:
                counts = self._obs_counts.get(task, {})
            under = [
                a for a in registered
                if counts.get(a, 0) < self._min_observations_per_action
            ]
            if under:
                # Pick the least-observed action first.
                under_sorted = sorted(under, key=lambda a: counts.get(a, 0))
                explore_action = under_sorted[0]
                rest = [a for a in base_order if a != explore_action]
                logger.debug(
                    "[layerinfinite] Exploration floor: promoting '%s' for task '%s' "
                    "(seen %d/%d times).",
                    explore_action,
                    task,
                    counts.get(explore_action, 0),
                    self._min_observations_per_action,
                )
                return ([explore_action] + rest, decision_id)

        return (base_order, decision_id)

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
        total_attempts = self._max_retries + 1

        for attempt in range(total_attempts):
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
                        total_attempts,
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
                        total_attempts,
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
                    total_attempts,
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
                    total_attempts,
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
            error_text = body.get('error', 'unknown')
            details = body.get('details')
            if details:
                error_text = f"{error_text} | details: {details}"
            raise LayerinfiniteServerError(
                f"Server error [{code}]: {error_text}",
                status_code=code,
                response_body=body,
            )
        raise LayerinfiniteError(
            f"Request error [{code}]: {body.get('error', 'unknown')}",
            status_code=code,
            response_body=body,
        )


LayerinfiniteClient = Layerinfinite
