#!/usr/bin/env python3
"""
Layerinfinite real-world proof benchmark.

What this script does:
1. Uses real OpenAI tool-calling (gpt-4o-mini) to choose remediation actions.
2. Uses Layerinfinite Python SDK (scores + log_outcome), not raw HTTP.
3. Keeps CI/CD domain/tasks aligned with ptest.py for direct comparability.
4. Supports harder ambiguous scenarios (close action success rates).
5. Reports confidence curve, convergence, stability, and
   expected vs actual improvement.
6. Supports both OpenAI native tool-calling and LangChain tool-calling backends.

Examples:
  python realworld_proof_agent.py --backend openai --mode auto --runs 100 --agent-id realworld1
  python realworld_proof_agent.py --backend openai --mode auto --runs 200 --agent-id realworld1
  python realworld_proof_agent.py --backend langchain --mode auto --runs 100 --agent-id realworld1
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import statistics
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


# Prefer workspace SDK package so behavior matches this repo exactly.
REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
SDK_PATH = os.path.join(REPO_ROOT, "layer5", "sdks", "python")
if os.path.isdir(SDK_PATH) and SDK_PATH not in sys.path:
    sys.path.insert(0, SDK_PATH)

try:
    from layerinfinite import Layerinfinite, LogOutcomeRequest  # type: ignore[import-not-found]
except Exception as exc:  # pragma: no cover
    raise RuntimeError(
        "Failed to import Layerinfinite SDK. Ensure layer5/sdks/python exists or install layerinfinite-sdk."
    ) from exc

try:
    from openai import OpenAI
except Exception as exc:  # pragma: no cover
    raise RuntimeError(
        "Failed to import OpenAI SDK. Install with: pip install openai"
    ) from exc


DEFAULT_LI_API_KEY = ""
DEFAULT_AGENT_ID = "realworld1"
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"
DEFAULT_LI_BASE = os.getenv("LAYERINFINITE_BASE", "https://api.layerinfinite.app")
DEFAULT_OPENAI_BASE = os.getenv("OPENAI_BASE", "https://api.openai.com/v1")


def normalize_api_key(value: str) -> str:
    cleaned = (value or "").strip().strip('"').strip("'")
    # Handles accidental copy/paste suffix artifacts like ..."s
    if cleaned.endswith('"s') or cleaned.endswith("'s"):
        cleaned = cleaned[:-2]
    return cleaned


def normalize_base_url(value: str, default: str) -> str:
    cleaned = (value or default).strip().strip('"').strip("'")
    if not cleaned:
        cleaned = default
    return cleaned.rstrip("/")


# Same CI/CD domain and core failure types used in ptest.py.
GROUND_TRUTH: dict[str, str] = {
    "npm_install_failed": "clear_npm_cache",
    "docker_build_timeout": "increase_docker_timeout",
    "test_suite_flaky": "retry_with_seed",
    "env_var_missing": "inject_env_from_vault",
    "out_of_memory": "scale_runner_memory",
    "network_timeout": "retry_with_backoff",
    "lint_failure": "auto_fix_lint",
    "deploy_rollback_triggered": "pin_previous_image",
    "db_migration_failed": "rollback_migration",
    "cache_miss_spike": "warm_cache_layer",
}

ACTION_SUCCESS_RATES: dict[tuple[str, str], float] = {
    ("npm_install_failed", "clear_npm_cache"): 0.92,
    ("npm_install_failed", "retry_with_backoff"): 0.45,
    ("npm_install_failed", "scale_runner_memory"): 0.20,
    ("docker_build_timeout", "increase_docker_timeout"): 0.88,
    ("docker_build_timeout", "retry_with_backoff"): 0.40,
    ("docker_build_timeout", "scale_runner_memory"): 0.30,
    ("test_suite_flaky", "retry_with_seed"): 0.85,
    ("test_suite_flaky", "retry_with_backoff"): 0.50,
    ("test_suite_flaky", "auto_fix_lint"): 0.10,
    ("env_var_missing", "inject_env_from_vault"): 0.95,
    ("env_var_missing", "retry_with_backoff"): 0.05,
    ("env_var_missing", "pin_previous_image"): 0.08,
    ("out_of_memory", "scale_runner_memory"): 0.90,
    ("out_of_memory", "increase_docker_timeout"): 0.15,
    ("out_of_memory", "retry_with_backoff"): 0.25,
    ("network_timeout", "retry_with_backoff"): 0.82,
    ("network_timeout", "clear_npm_cache"): 0.20,
    ("network_timeout", "warm_cache_layer"): 0.35,
    ("lint_failure", "auto_fix_lint"): 0.93,
    ("lint_failure", "retry_with_backoff"): 0.05,
    ("deploy_rollback_triggered", "pin_previous_image"): 0.88,
    ("deploy_rollback_triggered", "rollback_migration"): 0.55,
    ("deploy_rollback_triggered", "retry_with_backoff"): 0.20,
    ("db_migration_failed", "rollback_migration"): 0.91,
    ("db_migration_failed", "retry_with_backoff"): 0.30,
    ("db_migration_failed", "inject_env_from_vault"): 0.10,
    ("cache_miss_spike", "warm_cache_layer"): 0.87,
    ("cache_miss_spike", "retry_with_backoff"): 0.40,
    ("cache_miss_spike", "scale_runner_memory"): 0.25,
}

FAILURE_DESCRIPTIONS: dict[str, str] = {
    "npm_install_failed": "npm install failing with peer dependency conflicts and intermittent lockfile corruption.",
    "docker_build_timeout": "Docker build exceeded CI timeout; cache invalidation suspected.",
    "test_suite_flaky": "Integration tests flaky across runs with race-condition signatures.",
    "env_var_missing": "Required runtime secret missing during deploy step.",
    "out_of_memory": "Runner process OOM-killed during compile or test phase.",
    "network_timeout": "Intermittent network timeouts in external API calls during pipeline.",
    "lint_failure": "Lint stage failing with code-style and static checks.",
    "deploy_rollback_triggered": "Auto rollback triggered by failing health checks after deploy.",
    "db_migration_failed": "Schema migration failed due to constraint and ordering issues.",
    "cache_miss_spike": "Cold cache event caused severe latency and build slowdown.",
}

ALL_ACTIONS = sorted({a for (_, a) in ACTION_SUCCESS_RATES.keys()})
ALL_FAILURE_TYPES = sorted(GROUND_TRUTH.keys())


@dataclass
class AgentDecision:
    action: str
    reasoning: str
    confidence: float
    backend: str


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def normalize_model_name(model: str) -> str:
    normalized = (model or "").strip().lower().replace(" ", "")
    aliases = {
        "gpt-4.0-mini": "gpt-4o-mini",
        "gpt-4o-mini": "gpt-4o-mini",
        "gpt4o-mini": "gpt-4o-mini",
        "gpt40mini": "gpt-4o-mini",
    }
    return aliases.get(normalized, model)


def build_tool_schema(actions: list[str]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "execute_remediation",
                "description": "Execute one CI/CD remediation action.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": actions,
                            "description": "Action to run.",
                        },
                        "reasoning": {
                            "type": "string",
                            "description": "Short rationale for this action.",
                        },
                        "confidence": {
                            "type": "number",
                            "description": "Confidence from 0.0 to 1.0.",
                        },
                    },
                    "required": ["action", "reasoning", "confidence"],
                },
            },
        }
    ]


def build_prompt(
    failure_type: str,
    description: str,
    available_actions: list[str],
    li_recommendation: str | None,
    li_confidence: float | None,
    mode: str,
) -> tuple[str, str]:
    li_hint = ""
    if mode == "assist" and li_recommendation:
        li_hint = (
            f"\nLayerinfinite suggests '{li_recommendation}' "
            f"(confidence={li_confidence:.3f}). Consider this as one signal."
        )
    elif mode == "auto" and li_recommendation:
        li_hint = (
            f"\nLayerinfinite recommends '{li_recommendation}' "
            f"(confidence={li_confidence:.3f}). Prioritize it unless context strongly contradicts it."
        )

    # Keep core instruction style aligned with ptest.py (single action from allowed set).
    system = (
        "You are a CI/CD reliability agent. "
        "Diagnose the pipeline failure and choose the single best remediation action. "
        "You must call execute_remediation exactly once with one action from the allowed list."
        f"\nAllowed actions: {', '.join(available_actions)}"
        f"{li_hint}"
    )

    user = (
        f"Pipeline failure: {failure_type}\n"
        f"Description: {description}\n\n"
        "Call execute_remediation now with the best action."
    )
    return system, user


def choose_action_openai(
    client: OpenAI,
    model: str,
    system_prompt: str,
    user_prompt: str,
    available_actions: list[str],
) -> AgentDecision:
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        tools=build_tool_schema(available_actions),
        tool_choice="required",
        temperature=0.0,
    )

    message = response.choices[0].message
    tool_calls = message.tool_calls or []
    if not tool_calls:
        raise RuntimeError("OpenAI returned no tool_calls")

    raw_args = tool_calls[0].function.arguments or "{}"
    parsed = json.loads(raw_args)
    action = str(parsed.get("action", "")).strip()
    reasoning = str(parsed.get("reasoning", "")).strip()
    confidence = clamp01(parsed.get("confidence", 0.0))

    if action not in available_actions:
        raise RuntimeError(f"OpenAI selected invalid action: {action}")

    return AgentDecision(
        action=action,
        reasoning=reasoning,
        confidence=confidence,
        backend="openai",
    )


def choose_action_langchain(
    model: str,
    openai_api_key: str,
    openai_base_url: str,
    system_prompt: str,
    user_prompt: str,
    available_actions: list[str],
) -> AgentDecision:
    try:
        from langchain_openai import ChatOpenAI
        from langchain_core.messages import HumanMessage, SystemMessage
        from pydantic import BaseModel, Field
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(
            "LangChain backend requested but packages are missing. Install langchain and langchain-openai."
        ) from exc

    class ExecuteRemediationCall(BaseModel):
        action: str = Field(description=f"One of: {', '.join(available_actions)}")
        reasoning: str = Field(description="Short rationale")
        confidence: float = Field(description="Confidence from 0.0 to 1.0")

    llm = ChatOpenAI(
        model=model,
        temperature=0.0,
        api_key=openai_api_key,
        base_url=openai_base_url,
    )
    llm_with_tools = llm.bind_tools([ExecuteRemediationCall], tool_choice="required")

    response = llm_with_tools.invoke([
        SystemMessage(content=system_prompt),
        HumanMessage(content=user_prompt),
    ])

    tool_calls = getattr(response, "tool_calls", None) or []
    if not tool_calls:
        raise RuntimeError("LangChain returned no tool_calls")

    args = tool_calls[0].get("args", {})
    action = str(args.get("action", "")).strip()
    reasoning = str(args.get("reasoning", "")).strip()
    confidence = clamp01(args.get("confidence", 0.0))

    if action not in available_actions:
        raise RuntimeError(f"LangChain selected invalid action: {action}")

    return AgentDecision(
        action=action,
        reasoning=reasoning,
        confidence=confidence,
        backend="langchain",
    )


def make_action_rates(failure_type: str, harder_case: bool, rng: random.Random) -> dict[str, float]:
    rates: dict[str, float] = {}
    for action in ALL_ACTIONS:
        rates[action] = ACTION_SUCCESS_RATES.get((failure_type, action), 0.10)

    if not harder_case:
        return rates

    # Hard scenario: keep same task/action space, but compress action deltas
    # to create ambiguous close-success-rate conditions.
    leader = GROUND_TRUTH[failure_type]
    leader_rate = max(0.48, min(0.62, rates[leader]))
    rates[leader] = round(leader_rate, 3)

    for action in ALL_ACTIONS:
        if action == leader:
            continue
        gap = rng.uniform(0.01, 0.08)
        near_rate = leader_rate - gap
        near_rate = max(0.05, min(leader_rate - 0.005, near_rate))
        rates[action] = round(near_rate, 3)

    return rates


def execute_remediation(rates: dict[str, float], action: str, rng: random.Random) -> tuple[bool, float, float]:
    base_rate = rates.get(action, 0.10)
    noisy_rate = clamp01(base_rate + rng.gauss(0.0, 0.03))
    noisy_rate = max(0.01, min(0.99, noisy_rate))
    success = rng.random() < noisy_rate

    if success:
        outcome_score = rng.uniform(0.70, 1.00)
    else:
        outcome_score = rng.uniform(0.05, 0.35)

    return success, round(outcome_score, 4), round(noisy_rate, 4)


def fetch_li_scores(li: Layerinfinite, task: str) -> dict[str, Any]:
    try:
        scores = li.scores(task)
        top_action = scores.top_action.action_name if scores.top_action else None
        top_conf = float(scores.top_action.confidence) if scores.top_action else None
        return {
            "ok": True,
            "policy": getattr(scores, "policy", None),
            "top_action": top_action,
            "top_confidence": top_conf,
            "ranked_count": len(scores.ranked_actions or []),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def log_li_outcome(
    li: Layerinfinite,
    agent_id: str,
    task: str,
    action: str,
    context_id: str,
    success: bool,
    outcome_score: float,
) -> dict[str, Any]:
    try:
        request = LogOutcomeRequest(
            agent_id=agent_id,
            action_name=action,
            context_id=context_id,
            issue_type=task,
            success=success,
            outcome_score=outcome_score,
            business_outcome="resolved" if success else "failed",
            response_ms=random.randint(40, 900),
        )
        resp = li.log_outcome(request)
        return {"ok": True, "outcome_id": resp.outcome_id, "trust_status": resp.trust_status}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def mean_or_zero(values: list[float]) -> float:
    return float(sum(values) / len(values)) if values else 0.0


def std_or_zero(values: list[float]) -> float:
    return float(statistics.pstdev(values)) if len(values) > 1 else 0.0


def build_confidence_curve(results: list[dict[str, Any]], buckets: int = 10) -> list[dict[str, Any]]:
    n = len(results)
    if n == 0:
        return []

    buckets = max(1, min(buckets, n))
    bucket_size = math.ceil(n / buckets)
    curve: list[dict[str, Any]] = []

    for i in range(0, n, bucket_size):
        chunk = results[i:i + bucket_size]
        idx = len(curve) + 1

        curve.append(
            {
                "bucket": idx,
                "start_run": i + 1,
                "end_run": i + len(chunk),
                "success_rate": mean_or_zero([1.0 if r["success"] else 0.0 for r in chunk]),
                "choice_accuracy": mean_or_zero([1.0 if r["choice_correct"] else 0.0 for r in chunk]),
                "agent_confidence": mean_or_zero([float(r.get("agent_confidence", 0.0)) for r in chunk]),
                "li_confidence": mean_or_zero([
                    float(r["li_confidence"]) for r in chunk if r.get("li_confidence") is not None
                ]),
                "expected_improvement": mean_or_zero([float(r["expected_improvement"]) for r in chunk]),
                "actual_improvement": mean_or_zero([float(r["actual_improvement"]) for r in chunk]),
                "optimal_gap": mean_or_zero([float(r["optimal_gap"]) for r in chunk]),
            }
        )

    return curve


def rolling_mean(values: list[float], window: int) -> list[float]:
    if window <= 0 or len(values) < window:
        return []
    out: list[float] = []
    running = sum(values[:window])
    out.append(running / window)
    for i in range(window, len(values)):
        running += values[i] - values[i - window]
        out.append(running / window)
    return out


def summarize_results(results: list[dict[str, Any]]) -> dict[str, Any]:
    n = len(results)
    if n == 0:
        return {
            "num_runs": 0,
            "success_rate": 0.0,
            "choice_accuracy": 0.0,
            "expected_improvement": 0.0,
            "actual_improvement": 0.0,
            "optimal_gap": 0.0,
            "confidence_curve": [],
            "convergence": {},
            "stability": {},
        }

    success_series = [1.0 if r["success"] else 0.0 for r in results]
    correct_series = [1.0 if r["choice_correct"] else 0.0 for r in results]
    expected_series = [float(r["expected_improvement"]) for r in results]
    actual_series = [float(r["actual_improvement"]) for r in results]
    gap_series = [float(r["optimal_gap"]) for r in results]

    window_n = max(1, int(math.ceil(n * 0.2)))
    first = results[:window_n]
    last = results[-window_n:]

    convergence = {
        "window_size": window_n,
        "success_rate_first": mean_or_zero([1.0 if r["success"] else 0.0 for r in first]),
        "success_rate_last": mean_or_zero([1.0 if r["success"] else 0.0 for r in last]),
        "choice_accuracy_first": mean_or_zero([1.0 if r["choice_correct"] else 0.0 for r in first]),
        "choice_accuracy_last": mean_or_zero([1.0 if r["choice_correct"] else 0.0 for r in last]),
        "optimal_gap_first": mean_or_zero([float(r["optimal_gap"]) for r in first]),
        "optimal_gap_last": mean_or_zero([float(r["optimal_gap"]) for r in last]),
    }
    convergence["success_rate_delta"] = convergence["success_rate_last"] - convergence["success_rate_first"]
    convergence["choice_accuracy_delta"] = convergence["choice_accuracy_last"] - convergence["choice_accuracy_first"]
    convergence["optimal_gap_delta"] = convergence["optimal_gap_last"] - convergence["optimal_gap_first"]

    rolling_window = max(10, n // 10)
    roll_success = rolling_mean(success_series, rolling_window)
    roll_gap = rolling_mean(gap_series, rolling_window)
    roll_actual = rolling_mean(actual_series, rolling_window)

    stability = {
        "rolling_window": rolling_window,
        "rolling_success_std": std_or_zero(roll_success),
        "rolling_optimal_gap_std": std_or_zero(roll_gap),
        "rolling_actual_improvement_std": std_or_zero(roll_actual),
        "last_half_success_std": std_or_zero(success_series[n // 2:]),
        "last_half_optimal_gap_std": std_or_zero(gap_series[n // 2:]),
    }

    return {
        "num_runs": n,
        "success_rate": mean_or_zero(success_series),
        "choice_accuracy": mean_or_zero(correct_series),
        "expected_improvement": mean_or_zero(expected_series),
        "actual_improvement": mean_or_zero(actual_series),
        "optimal_gap": mean_or_zero(gap_series),
        "confidence_curve": build_confidence_curve(results, buckets=10),
        "convergence": convergence,
        "stability": stability,
    }


def print_summary(run_data: dict[str, Any]) -> None:
    summary = run_data["summary"]

    print("=" * 78)
    print(
        f"REAL WORLD PROOF | backend={run_data['backend']} | mode={run_data['mode']} | "
        f"runs={summary['num_runs']}"
    )
    print("=" * 78)
    print(f"Agent ID                     : {run_data['agent_id']}")
    print(f"OpenAI model                 : {run_data['openai_model']}")
    print(f"Hard scenario rate           : {run_data['hard_scenario_rate']:.0%}")
    print()

    print("Core metrics")
    print("-" * 78)
    print(f"Success rate                 : {summary['success_rate']:.1%}")
    print(f"Choice accuracy              : {summary['choice_accuracy']:.1%}")
    print(f"Expected improvement (mean)  : {summary['expected_improvement']:+.4f}")
    print(f"Actual improvement (mean)    : {summary['actual_improvement']:+.4f}")
    print(f"Optimality gap (mean, lower) : {summary['optimal_gap']:.4f}")
    print()

    convergence = summary["convergence"]
    print("Convergence")
    print("-" * 78)
    print(
        f"Success first/last {convergence['window_size']} runs : "
        f"{convergence['success_rate_first']:.1%} -> {convergence['success_rate_last']:.1%} "
        f"(delta {convergence['success_rate_delta']:+.1%})"
    )
    print(
        f"Accuracy first/last {convergence['window_size']} runs: "
        f"{convergence['choice_accuracy_first']:.1%} -> {convergence['choice_accuracy_last']:.1%} "
        f"(delta {convergence['choice_accuracy_delta']:+.1%})"
    )
    print(
        f"Optimal gap first/last       : "
        f"{convergence['optimal_gap_first']:.4f} -> {convergence['optimal_gap_last']:.4f} "
        f"(delta {convergence['optimal_gap_delta']:+.4f})"
    )
    print()

    stability = summary["stability"]
    print("Stability")
    print("-" * 78)
    print(f"Rolling success std          : {stability['rolling_success_std']:.4f}")
    print(f"Rolling optimal-gap std      : {stability['rolling_optimal_gap_std']:.4f}")
    print(f"Rolling actual-impr std      : {stability['rolling_actual_improvement_std']:.4f}")
    print(f"Last-half success std        : {stability['last_half_success_std']:.4f}")
    print(f"Last-half optimal-gap std    : {stability['last_half_optimal_gap_std']:.4f}")
    print()

    print("Confidence curve (10 buckets)")
    print("-" * 78)
    for row in summary["confidence_curve"]:
        print(
            f"Bucket {row['bucket']:>2} runs {row['start_run']:>3}-{row['end_run']:<3} | "
            f"success={row['success_rate']:.1%} | acc={row['choice_accuracy']:.1%} | "
            f"agent_conf={row['agent_confidence']:.2f} | li_conf={row['li_confidence']:.2f}"
        )
    print("=" * 78)


def compare_result_files(path_a: str, path_b: str) -> None:
    with open(path_a, "r", encoding="utf-8") as f:
        a = json.load(f)
    with open(path_b, "r", encoding="utf-8") as f:
        b = json.load(f)

    sa = a.get("summary", {})
    sb = b.get("summary", {})

    def metric(name: str) -> tuple[float, float, float]:
        va = float(sa.get(name, 0.0))
        vb = float(sb.get(name, 0.0))
        return va, vb, vb - va

    print("=" * 78)
    print("RESULT COMPARISON")
    print("=" * 78)
    print(f"A: {path_a}")
    print(f"B: {path_b}")
    print()

    rows = [
        ("success_rate", "Success rate"),
        ("choice_accuracy", "Choice accuracy"),
        ("expected_improvement", "Expected improvement"),
        ("actual_improvement", "Actual improvement"),
        ("optimal_gap", "Optimal gap (lower better)"),
    ]

    for key, label in rows:
        va, vb, d = metric(key)
        if "rate" in key or "accuracy" in key:
            print(f"{label:<30} {va:>8.1%} -> {vb:>8.1%}   delta {d:+.1%}")
        else:
            print(f"{label:<30} {va:>8.4f} -> {vb:>8.4f}   delta {d:+.4f}")

    print("=" * 78)


def run_experiment(args: argparse.Namespace) -> dict[str, Any]:
    rng = random.Random(args.seed)

    openai_model = normalize_model_name(args.model)
    openai_client = OpenAI(api_key=args.openai_api_key, base_url=args.openai_base)

    li = None
    if args.mode != "none":
        li = Layerinfinite(
            api_key=args.li_api_key,
            agent_id=args.agent_id,
            mode="recommend",
            base_url=args.li_base,
            log_async=False,
            auto_register=True,
        )

    started_at = datetime.now(timezone.utc).isoformat()
    results: list[dict[str, Any]] = []
    openai_failures = 0
    li_score_failures = 0
    li_log_failures = 0

    for i in range(args.runs):
        failure_type = rng.choice(ALL_FAILURE_TYPES)
        harder_case = rng.random() < args.hard_scenario_rate
        rates = make_action_rates(failure_type, harder_case, rng)

        optimal_action = max(rates.items(), key=lambda kv: kv[1])[0]
        baseline_rate = mean_or_zero(list(rates.values()))

        li_top_action: str | None = None
        li_top_conf: float | None = None
        li_policy: str | None = None

        if li is not None:
            score_info = fetch_li_scores(li, failure_type)
            if score_info.get("ok"):
                li_top_action = score_info.get("top_action")
                li_top_conf = score_info.get("top_confidence")
                li_policy = score_info.get("policy")
            else:
                li_score_failures += 1

        system_prompt, user_prompt = build_prompt(
            failure_type=failure_type,
            description=FAILURE_DESCRIPTIONS.get(failure_type, failure_type),
            available_actions=ALL_ACTIONS,
            li_recommendation=li_top_action,
            li_confidence=li_top_conf if li_top_conf is not None else 0.0,
            mode=args.mode,
        )

        decision: AgentDecision
        try:
            if args.backend == "openai":
                decision = choose_action_openai(
                    client=openai_client,
                    model=openai_model,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    available_actions=ALL_ACTIONS,
                )
            else:
                decision = choose_action_langchain(
                    model=openai_model,
                    openai_api_key=args.openai_api_key,
                    openai_base_url=args.openai_base,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    available_actions=ALL_ACTIONS,
                )
        except Exception as exc:
            openai_failures += 1
            fallback_action = rng.choice(ALL_ACTIONS)
            decision = AgentDecision(
                action=fallback_action,
                reasoning=f"model_error_fallback: {exc}",
                confidence=0.05,
                backend=args.backend,
            )

        success, outcome_score, effective_rate = execute_remediation(
            rates=rates,
            action=decision.action,
            rng=rng,
        )

        li_outcome_id = None
        li_log_error = None
        if li is not None:
            log_info = log_li_outcome(
                li=li,
                agent_id=args.agent_id,
                task=failure_type,
                action=decision.action,
                context_id=str(uuid.uuid4()),
                success=success,
                outcome_score=outcome_score,
            )
            if log_info.get("ok"):
                li_outcome_id = log_info.get("outcome_id")
            else:
                li_log_failures += 1
                li_log_error = log_info.get("error")

        chosen_rate = rates.get(decision.action, 0.0)
        expected_improvement = chosen_rate - baseline_rate
        actual_improvement = (1.0 if success else 0.0) - baseline_rate
        optimal_gap = rates.get(optimal_action, 0.0) - chosen_rate

        results.append(
            {
                "run": i + 1,
                "failure_type": failure_type,
                "scenario": "hard_ambiguous" if harder_case else "normal",
                "optimal_action": optimal_action,
                "chosen_action": decision.action,
                "choice_correct": decision.action == optimal_action,
                "success": success,
                "outcome_score": outcome_score,
                "effective_success_rate": effective_rate,
                "agent_confidence": decision.confidence,
                "agent_reasoning": decision.reasoning,
                "li_action": li_top_action,
                "li_confidence": li_top_conf,
                "li_policy": li_policy,
                "li_followed": (decision.action == li_top_action) if li_top_action else None,
                "li_outcome_id": li_outcome_id,
                "li_log_error": li_log_error,
                "expected_improvement": expected_improvement,
                "actual_improvement": actual_improvement,
                "optimal_gap": optimal_gap,
                "rate_card": rates,
            }
        )

        if not args.quiet and ((i + 1) % max(1, args.progress_every) == 0 or (i + 1) == args.runs):
            partial = summarize_results(results)
            print(
                f"[{i + 1:>3}/{args.runs}] success={partial['success_rate']:.1%} "
                f"acc={partial['choice_accuracy']:.1%} "
                f"exp={partial['expected_improvement']:+.4f} "
                f"act={partial['actual_improvement']:+.4f}"
            )

    finished_at = datetime.now(timezone.utc).isoformat()
    summary = summarize_results(results)

    return {
        "created_at": started_at,
        "finished_at": finished_at,
        "duration_seconds": round(
            datetime.fromisoformat(finished_at).timestamp() - datetime.fromisoformat(started_at).timestamp(),
            3,
        ),
        "backend": args.backend,
        "mode": args.mode,
        "agent_id": args.agent_id,
        "openai_model": openai_model,
        "runs": args.runs,
        "seed": args.seed,
        "hard_scenario_rate": args.hard_scenario_rate,
        "openai_failures": openai_failures,
        "li_score_failures": li_score_failures,
        "li_log_failures": li_log_failures,
        "summary": summary,
        "results": results,
    }


def ensure_required_args(args: argparse.Namespace) -> None:
    if args.compare:
        return

    if not args.openai_api_key:
        raise RuntimeError(
            "OPENAI_API_KEY is required. Export it (same key source used by ptest.py) "
            "or pass --openai-api-key."
        )

    if args.mode != "none" and not args.li_api_key:
        raise RuntimeError(
            "Layerinfinite API key is required for assist/auto mode. "
            "Pass --li-api-key or set LAYERINFINITE_API_KEY."
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Real world proof benchmark (OpenAI/ LangChain + Layerinfinite SDK)."
    )
    parser.add_argument("--backend", choices=["openai", "langchain"], default="openai")
    parser.add_argument("--mode", choices=["none", "assist", "auto"], default="auto")
    parser.add_argument("--runs", type=int, default=100)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--hard-scenario-rate", type=float, default=0.40)
    parser.add_argument("--agent-id", default=DEFAULT_AGENT_ID)
    parser.add_argument("--model", default=DEFAULT_OPENAI_MODEL)

    parser.add_argument("--li-base", default=DEFAULT_LI_BASE)
    parser.add_argument("--openai-base", default=DEFAULT_OPENAI_BASE)

    parser.add_argument("--li-api-key", default=os.getenv("LAYERINFINITE_API_KEY", DEFAULT_LI_API_KEY))
    parser.add_argument("--openai-api-key", default=os.getenv("OPENAI_API_KEY", ""))

    parser.add_argument("--output", default="")
    parser.add_argument("--progress-every", type=int, default=10)
    parser.add_argument("--quiet", action="store_true")

    parser.add_argument("--compare", nargs=2, metavar=("RESULT_A", "RESULT_B"))

    return parser.parse_args()


def main() -> None:
    args = parse_args()

    args.li_api_key = normalize_api_key(args.li_api_key)
    args.openai_api_key = normalize_api_key(args.openai_api_key)
    args.li_base = normalize_base_url(args.li_base, DEFAULT_LI_BASE)
    args.openai_base = normalize_base_url(args.openai_base, DEFAULT_OPENAI_BASE)

    if args.compare:
        compare_result_files(args.compare[0], args.compare[1])
        return

    ensure_required_args(args)

    run_data = run_experiment(args)
    print_summary(run_data)

    if args.output:
        output_path = args.output
    else:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_path = f"results_realworld_{args.backend}_{args.mode}_{args.runs}_{ts}.json"

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(run_data, f, indent=2)

    print(f"Saved results: {output_path}")


if __name__ == "__main__":
    main()
