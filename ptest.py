#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════╗
║          CI/CD RELIABILITY AGENT — Real-Time Test Harness           ║
║          Tests Layerinfinite Decision Intelligence Layer             ║
╚══════════════════════════════════════════════════════════════════════╝

This is a REAL autonomous agent that:
  1. Monitors a simulated CI/CD pipeline for failures
  2. Diagnoses failures using GPT-4o-mini
  3. Chooses a remediation strategy from a known action set
  4. Executes the fix and records the actual outcome
  5. (Optionally) consults Layerinfinite before deciding

The agent does NOT know it's being evaluated. It's just doing its job.
Layerinfinite either helps it or doesn't — and we measure the difference.

Usage:
  # WITHOUT Layerinfinite (baseline):
  python agent.py --mode none --runs 15

  # WITH Layerinfinite in OBSERVE mode:
  python agent.py --mode observe --runs 15

  # WITH Layerinfinite in ADVISORY mode:
  python agent.py --mode advisory --runs 15

  # WITH Layerinfinite in AUTONOMOUS mode:
  python agent.py --mode autonomous --runs 15

  # Stress test (20 rapid decisions, autonomous):
  python agent.py --mode autonomous --runs 20 --stress
"""

import argparse
import json
import random
import re
import time
import uuid
import sys
import os
import socket
from datetime import datetime, timezone
from typing import Optional
import urllib.request
import urllib.parse
import urllib.error


# Network resilience tuning for transient DNS/socket/service errors.
HTTP_TIMEOUT_SECONDS = 15
HTTP_MAX_RETRIES = 8
HTTP_BACKOFF_BASE_SECONDS = 0.4
HTTP_BACKOFF_MAX_SECONDS = 6.0
NETWORK_PREFLIGHT_TIMEOUT_SECONDS = 2.0
PENDING_OUTCOMES_FILE = "ptest_pending_outcomes.jsonl"

# ─────────────────────────────────────────────────────────────────────
# CONFIGURATION — Use environment variables only
# ─────────────────────────────────────────────────────────────────────
LAYERINFINITE_API_KEY = os.getenv("LAYERINFINITE_API_KEY", "")
OPENAI_API_KEY        = os.getenv("OPENAI_API_KEY", "")
LAYERINFINITE_BASE    = os.getenv("LAYERINFINITE_BASE", "https://api.layerinfinite.app")
OPENAI_BASE           = os.getenv("OPENAI_BASE", "https://api.openai.com/v1")
OPENAI_MODEL          = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

# Keep transport/telemetry jitter out of seeded simulation randomness.
_NON_DETERMINISTIC_RNG = random.SystemRandom()

DNS_ERROR_MARKERS = (
    "getaddrinfo failed",
    "temporary failure in name resolution",
    "name or service not known",
    "nodename nor servname provided",
)


def configure_console_utf8() -> None:
    """Best-effort UTF-8 output so Windows terminals don't crash on report glyphs."""
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass

def normalize_api_key(value: str) -> str:
    """Clean common copy-paste artifacts while preserving valid keys."""
    cleaned = (value or '').strip().strip('"').strip("'")

    # Handles accidental suffix from quoted pastes like ..."s
    if cleaned.endswith('"s') or cleaned.endswith("'s"):
        cleaned = cleaned[:-2]

    return cleaned


def normalize_base_url(value: str, default: str) -> str:
    cleaned = (value or default).strip().strip('"').strip("'")
    if not cleaned:
        cleaned = default
    return cleaned.rstrip("/")


def validate_runtime_configuration() -> None:
    missing = []
    if not LAYERINFINITE_API_KEY:
        missing.append("LAYERINFINITE_API_KEY")
    if not OPENAI_API_KEY:
        missing.append("OPENAI_API_KEY")

    if missing:
        raise RuntimeError(
            "Missing required environment variables: " + ", ".join(missing)
        )

    if not LAYERINFINITE_API_KEY.startswith("layerinfinite_"):
        raise RuntimeError(
            "Invalid LAYERINFINITE_API_KEY format. Expected prefix: layerinfinite_"
        )

    if not OPENAI_API_KEY.startswith("sk-"):
        raise RuntimeError(
            "Invalid OPENAI_API_KEY format. Expected prefix: sk-"
        )

LAYERINFINITE_API_KEY = normalize_api_key(LAYERINFINITE_API_KEY)
OPENAI_API_KEY = normalize_api_key(OPENAI_API_KEY)
LAYERINFINITE_BASE = normalize_base_url(LAYERINFINITE_BASE, "https://api.layerinfinite.app")
OPENAI_BASE = normalize_base_url(OPENAI_BASE, "https://api.openai.com/v1")
validate_runtime_configuration()

LI_HOST = urllib.parse.urlparse(LAYERINFINITE_BASE).hostname or "api.layerinfinite.app"
_ORIGINAL_GETADDRINFO = socket.getaddrinfo
_DNS_CACHE: dict[str, list] = {}
_DNS_FALLBACK_INSTALLED = False

def is_dns_resolution_error(error_text: str) -> bool:
    text = (error_text or "").lower()
    return any(marker in text for marker in DNS_ERROR_MARKERS)

def install_dns_cache_fallback(host: str) -> None:
    """Reuse last successful DNS answer when resolver intermittently fails."""
    global _DNS_FALLBACK_INSTALLED
    if _DNS_FALLBACK_INSTALLED:
        return

    target = host.strip().lower()

    def cached_getaddrinfo(hostname, *args, **kwargs):
        host_key = str(hostname).strip().lower()
        try:
            resolved = _ORIGINAL_GETADDRINFO(hostname, *args, **kwargs)
            if host_key == target and resolved:
                _DNS_CACHE[target] = resolved
            return resolved
        except socket.gaierror:
            cached = _DNS_CACHE.get(target) if host_key == target else None
            if cached:
                return cached
            raise

    socket.getaddrinfo = cached_getaddrinfo
    _DNS_FALLBACK_INSTALLED = True

def warm_dns_cache(host: str, attempts: int = 3) -> bool:
    target = host.strip().lower()
    for _ in range(max(1, attempts)):
        try:
            resolved = _ORIGINAL_GETADDRINFO(target, 443, type=socket.SOCK_STREAM)
            if resolved:
                _DNS_CACHE[target] = resolved
                return True
        except socket.gaierror:
            pass
        time.sleep(0.2)
    return False


def quick_health_probe(base_url: str, timeout_seconds: float = NETWORK_PREFLIGHT_TIMEOUT_SECONDS) -> dict:
    url = f"{base_url}/health"
    req = urllib.request.Request(url, headers={"Content-Type": "application/json"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            payload = json.loads(resp.read().decode() or "{}")
            return {
                "ok": True,
                "status": str(payload.get("status", "unknown")),
                "checks": payload.get("checks", {}),
            }
    except Exception as exc:
        return {
            "ok": False,
            "status": "unknown",
            "checks": {},
            "error": str(exc),
        }


def run_connectivity_preflight(base_url: str, host: str) -> dict:
    result = {
        "host": host,
        "dns_ok": False,
        "tcp_ok": False,
        "health_ok": False,
        "health_status": "unknown",
        "status": "unknown",
        "error": None,
    }

    target = host.strip().lower()

    try:
        resolved = _ORIGINAL_GETADDRINFO(target, 443, type=socket.SOCK_STREAM)
        if resolved:
            _DNS_CACHE[target] = resolved
            result["dns_ok"] = True
    except socket.gaierror as exc:
        result["status"] = "dns_unstable"
        result["error"] = str(exc)
        return result

    try:
        with socket.create_connection((target, 443), timeout=NETWORK_PREFLIGHT_TIMEOUT_SECONDS):
            pass
        result["tcp_ok"] = True
    except OSError as exc:
        result["status"] = "network_degraded"
        result["error"] = str(exc)
        return result

    health = quick_health_probe(base_url)
    result["health_ok"] = bool(health.get("ok"))
    result["health_status"] = str(health.get("status", "unknown"))
    if not result["health_ok"] and health.get("error"):
        result["error"] = str(health.get("error"))

    if result["health_ok"] and result["health_status"] == "ok":
        result["status"] = "healthy"
    elif result["health_ok"]:
        result["status"] = "network_degraded"
    else:
        result["status"] = "network_degraded"

    return result


def print_preflight_banner(preflight: dict) -> None:
    print("  Startup connectivity preflight...")
    print(
        f"  Preflight status ({preflight.get('host', 'unknown')}) : {preflight.get('status', 'unknown')} "
        f"(dns={preflight.get('dns_ok')}, tcp={preflight.get('tcp_ok')}, health={preflight.get('health_status')})"
    )

    if preflight.get("status") != "healthy":
        error_text = str(preflight.get("error") or "connectivity issue")
        print(f"  ⚠️  Preflight warning: {error_text}")
        print("  Resilience layer active: DNS cache fallback + pending outcome replay.")

install_dns_cache_fallback(LI_HOST)
DNS_WARMUP_OK = warm_dns_cache(LI_HOST)

# Agent identity — persistent across all runs so Layerinfinite builds history
AGENT_ID_FILE = "ptest"

def get_or_create_agent_id() -> str:
    if os.path.exists(AGENT_ID_FILE):
        with open(AGENT_ID_FILE) as f:
            return f.read().strip()
    aid = str(uuid.uuid4())
    with open(AGENT_ID_FILE, "w") as f:
        f.write(aid)
    return aid

AGENT_ID = get_or_create_agent_id()

# ─────────────────────────────────────────────────────────────────────
# GROUND TRUTH — What the CORRECT fix is for each failure type
# This lets us score whether Layerinfinite recommendations match reality
# ─────────────────────────────────────────────────────────────────────
GROUND_TRUTH = {
    "npm_install_failed":        "clear_npm_cache",
    "docker_build_timeout":      "increase_docker_timeout",
    "test_suite_flaky":          "retry_with_seed",
    "env_var_missing":           "inject_env_from_vault",
    "out_of_memory":             "scale_runner_memory",
    "network_timeout":           "retry_with_backoff",
    "lint_failure":              "auto_fix_lint",
    "deploy_rollback_triggered": "pin_previous_image",
    "db_migration_failed":       "rollback_migration",
    "cache_miss_spike":          "warm_cache_layer",
}

# Action success probability per failure type (simulates real-world effectiveness)
ACTION_SUCCESS_RATES = {
    ("npm_install_failed",        "clear_npm_cache"):          0.92,
    ("npm_install_failed",        "retry_with_backoff"):       0.45,
    ("npm_install_failed",        "scale_runner_memory"):      0.20,
    ("docker_build_timeout",      "increase_docker_timeout"):  0.88,
    ("docker_build_timeout",      "retry_with_backoff"):       0.40,
    ("docker_build_timeout",      "scale_runner_memory"):      0.30,
    ("test_suite_flaky",          "retry_with_seed"):          0.85,
    ("test_suite_flaky",          "retry_with_backoff"):       0.50,
    ("test_suite_flaky",          "auto_fix_lint"):            0.10,
    ("env_var_missing",           "inject_env_from_vault"):    0.95,
    ("env_var_missing",           "retry_with_backoff"):       0.05,
    ("env_var_missing",           "pin_previous_image"):       0.08,
    ("out_of_memory",             "scale_runner_memory"):      0.90,
    ("out_of_memory",             "increase_docker_timeout"):  0.15,
    ("out_of_memory",             "retry_with_backoff"):       0.25,
    ("network_timeout",           "retry_with_backoff"):       0.82,
    ("network_timeout",           "clear_npm_cache"):          0.20,
    ("network_timeout",           "warm_cache_layer"):         0.35,
    ("lint_failure",              "auto_fix_lint"):            0.93,
    ("lint_failure",              "retry_with_backoff"):       0.05,
    ("deploy_rollback_triggered", "pin_previous_image"):       0.88,
    ("deploy_rollback_triggered", "rollback_migration"):       0.55,
    ("deploy_rollback_triggered", "retry_with_backoff"):       0.20,
    ("db_migration_failed",       "rollback_migration"):       0.91,
    ("db_migration_failed",       "retry_with_backoff"):       0.30,
    ("db_migration_failed",       "inject_env_from_vault"):    0.10,
    ("cache_miss_spike",          "warm_cache_layer"):         0.87,
    ("cache_miss_spike",          "retry_with_backoff"):       0.40,
    ("cache_miss_spike",          "scale_runner_memory"):      0.25,
}

ALL_ACTIONS = list(set(a for (_, a) in ACTION_SUCCESS_RATES.keys()))
ALL_FAILURE_TYPES = list(GROUND_TRUTH.keys())

# Controlled exploration so Layerinfinite can build multi-action evidence per task.
# Recommendation engine requires 2+ actions with enough samples per task.
OBSERVE_EXPLORATION_RATE = 0.35
ADVISORY_EXPLORATION_RATE = 0.15

# Autonomous mode only executes recommendations that pass quality gates.
AUTONOMOUS_ALLOWED_STATES = {"early_signal", "stable"}
AUTONOMOUS_MIN_CONFIDENCE_BY_STATE = {
    "early_signal": 0.25,
    "stable": 0.50,
}
AUTONOMOUS_MIN_SAMPLES_BY_STATE = {
    "early_signal": 10,
    "stable": 20,
}

# ─────────────────────────────────────────────────────────────────────
# HTTP HELPERS
# ─────────────────────────────────────────────────────────────────────
def _request_json(method: str, url: str, headers: dict, body: Optional[dict] = None) -> dict:
    payload = json.dumps(body).encode() if body is not None else None
    last_error = "unknown_error"

    for attempt in range(HTTP_MAX_RETRIES + 1):
        req = urllib.request.Request(url, data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            status = getattr(e, "code", 0) or 0
            try:
                body_text = e.read().decode()
            except Exception:
                body_text = str(e)

            if status >= 500 and attempt < HTTP_MAX_RETRIES:
                sleep_s = min(HTTP_BACKOFF_BASE_SECONDS * (2 ** attempt), HTTP_BACKOFF_MAX_SECONDS) + _NON_DETERMINISTIC_RNG.uniform(0.0, 0.2)
                time.sleep(sleep_s)
                last_error = body_text
                continue

            return {"error": body_text, "status": status, "error_category": "http_error"}
        except Exception as e:
            last_error = str(e)
            if attempt >= HTTP_MAX_RETRIES:
                category = "dns_resolution" if is_dns_resolution_error(last_error) else "transport_error"
                return {
                    "error": f"{last_error} (attempts={attempt + 1})",
                    "error_category": category,
                }
            sleep_s = min(HTTP_BACKOFF_BASE_SECONDS * (2 ** attempt), HTTP_BACKOFF_MAX_SECONDS) + _NON_DETERMINISTIC_RNG.uniform(0.0, 0.2)
            time.sleep(sleep_s)

    category = "dns_resolution" if is_dns_resolution_error(last_error) else "transport_error"
    return {
        "error": f"{last_error} (attempts={HTTP_MAX_RETRIES + 1})",
        "error_category": category,
    }


def http_post(url: str, headers: dict, body: dict) -> dict:
    return _request_json("POST", url, headers, body)


def http_get(url: str, headers: dict) -> dict:
    return _request_json("GET", url, headers)


def enqueue_pending_outcome(body: dict) -> None:
    if not body:
        return
    try:
        with open(PENDING_OUTCOMES_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(body, default=str) + "\n")
    except Exception:
        # Keep the harness running even if local persistence fails.
        pass


def flush_pending_outcomes() -> tuple[int, int]:
    if not os.path.exists(PENDING_OUTCOMES_FILE):
        return (0, 0)

    try:
        with open(PENDING_OUTCOMES_FILE, "r", encoding="utf-8") as f:
            queued = [json.loads(line) for line in f if line.strip()]
    except Exception:
        return (0, 0)

    if not queued:
        try:
            os.remove(PENDING_OUTCOMES_FILE)
        except Exception:
            pass
        return (0, 0)

    sent = 0
    remaining: list[dict] = []
    for payload in queued:
        resp = http_post(f"{LAYERINFINITE_BASE}/v1/log-outcome", LI_HEADERS, payload)
        if "error" in resp:
            remaining.append(payload)
        else:
            sent += 1

    if remaining:
        try:
            with open(PENDING_OUTCOMES_FILE, "w", encoding="utf-8") as f:
                for payload in remaining:
                    f.write(json.dumps(payload, default=str) + "\n")
        except Exception:
            pass
    else:
        try:
            os.remove(PENDING_OUTCOMES_FILE)
        except Exception:
            pass

    return (sent, len(remaining))

# ─────────────────────────────────────────────────────────────────────
# OPENAI — Agent's brain (diagnosis + action selection)
# ─────────────────────────────────────────────────────────────────────
def call_openai(system: str, user: str) -> str:
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }
    body = {
        "model": OPENAI_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user",   "content": user},
        ],
        # Deterministic decisions keep seeded cross-mode comparisons fair.
        "temperature": 0.0,
        "max_tokens": 300,
    }
    result = http_post(f"{OPENAI_BASE}/chat/completions", headers, body)
    if "error" in result:
        print(f"    ⚠️  OpenAI error: {result['error']}")
        return ""
    return result["choices"][0]["message"]["content"].strip()

def diagnose_and_pick_action(failure_type: str, context: dict, advisory_hint: Optional[str] = None) -> str:
    """Agent's core decision: given a failure, pick an action."""
    hint_text = ""
    if advisory_hint:
        hint_text = f"\n\nAdvisory system suggests: {advisory_hint}. Consider this but make your own judgment."

    system = (
        "You are a CI/CD reliability agent. You diagnose pipeline failures and choose "
        "the single best remediation action. You must respond with ONLY the action name "
        "from the provided list — no explanation, no punctuation, just the action name."
    )
    user = (
        f"Pipeline failure: {failure_type}\n"
        f"Context: {json.dumps(context)}\n"
        f"Available actions: {', '.join(ALL_ACTIONS)}"
        f"{hint_text}\n\n"
        "Choose ONE action from the list above:"
    )
    choice = call_openai(system, user)
    # Validate it's a real action
    choice_clean = choice.strip().lower().replace("-", "_").replace(" ", "_")
    for action in ALL_ACTIONS:
        if action in choice_clean or choice_clean in action:
            return action
    # Fallback: random action (agent made an invalid choice)
    return random.choice(ALL_ACTIONS)

# ─────────────────────────────────────────────────────────────────────
# LAYERINFINITE API CALLS
# ─────────────────────────────────────────────────────────────────────
LI_HEADERS = {
    "X-API-Key": LAYERINFINITE_API_KEY,
    "Content-Type": "application/json",
}


def clamp_score(value: float) -> float:
    return max(0.0, min(1.0, round(float(value), 4)))


def build_execution_result(failure_type: str, action: str, success: bool,
                           confidence: float, context: dict) -> dict:
    """Builds action output used by score_fn to produce ranking input."""
    correct_action = GROUND_TRUTH[failure_type]
    action_match_score = 1.0 if action == correct_action else 0.2
    attempt_factor = 1.0 / max(1, int(context.get("attempt", 1)))
    success_signal = 1.0 if success else 0.0

    # score_fn input mirrors a production action result shape.
    resolution_score = clamp_score(
        (0.55 * success_signal)
        + (0.30 * confidence)
        + (0.10 * action_match_score)
        + (0.05 * attempt_factor)
    )

    return {
        "resolved": success,
        "resolution_score": resolution_score,
        "confidence": confidence,
        "action": action,
        "failure_type": failure_type,
        "attempt": int(context.get("attempt", 1)),
        "correct_action": correct_action,
        "action_match": action == correct_action,
    }


def score_fn(result: dict) -> float:
    """Extract ranking score from action output. Required shape: resolution_score in [0,1]."""
    try:
        return clamp_score(result.get("resolution_score", 0.0))
    except Exception:
        return 0.0

def li_get_recommendation(task: str) -> dict:
    url = f"{LAYERINFINITE_BASE}/v1/recommendations?task={urllib.parse.quote(task)}"
    return http_get(url, LI_HEADERS)

def li_log_outcome(task: str, action: str, success: bool, confidence: float,
                   outcome_score: float, score_input: dict,
                   context: dict, episode_id: str, sequence_index: int) -> dict:
    idempotency_key = f"ptest-{episode_id}-{sequence_index}-{uuid.uuid4().hex[:8]}"
    body = {
        "issue_type": task,
        "task_name": task,
        "action_name": action,
        "success": success,
        "outcome_score": outcome_score,
        "raw_context": context,
        "response_ms": _NON_DETERMINISTIC_RNG.randint(40, 900),
        "idempotency_key": idempotency_key,
        "episode_id": episode_id,
        "episode_history": [f"step_{i}" for i in range(sequence_index)],
        "metadata": {
            "test_harness": "ci_reliability_agent_v1",
            "score_fn": "resolution_score_v1",
            "score_input": {
                "resolution_score": score_input.get("resolution_score"),
                "action_match": score_input.get("action_match"),
                "attempt": score_input.get("attempt"),
            },
        },
    }
    resp = http_post(f"{LAYERINFINITE_BASE}/v1/log-outcome", LI_HEADERS, body)
    if "error" in resp:
        resp["_payload"] = body
    return resp

def li_get_scores(task: str) -> dict:
    url = f"{LAYERINFINITE_BASE}/v1/get-scores?issue_type={urllib.parse.quote(task)}"
    return http_get(url, LI_HEADERS)

def li_observe(task: str) -> dict:
    url = f"{LAYERINFINITE_BASE}/v1/observe?task={urllib.parse.quote(task)}"
    return http_get(url, LI_HEADERS)

def li_health() -> dict:
    return http_get(f"{LAYERINFINITE_BASE}/health", {"Content-Type": "application/json"})

# ─────────────────────────────────────────────────────────────────────
# SIMULATE: Execute an action and get an outcome
# ─────────────────────────────────────────────────────────────────────
def simulate_action_outcome(failure_type: str, action: str) -> tuple[bool, float]:
    """Returns (success, confidence_score)."""
    rate = ACTION_SUCCESS_RATES.get((failure_type, action), 0.15)
    # Add noise — real world isn't deterministic
    noisy_rate = max(0.02, min(0.99, rate + random.gauss(0, 0.05)))
    success = random.random() < noisy_rate
    confidence = round(noisy_rate + random.gauss(0, 0.03), 3)
    confidence = max(0.01, min(0.99, confidence))
    return success, confidence


def maybe_explore_action(li_mode: str, failure_type: str, chosen_action: str) -> tuple[str, bool]:
    if li_mode not in ("observe", "advisory"):
        return chosen_action, False

    exploration_rate = OBSERVE_EXPLORATION_RATE if li_mode == "observe" else ADVISORY_EXPLORATION_RATE
    if random.random() >= exploration_rate:
        return chosen_action, False

    task_actions = [
        action for (ft, action) in ACTION_SUCCESS_RATES.keys()
        if ft == failure_type and action != chosen_action
    ]
    if not task_actions:
        return chosen_action, False

    return random.choice(task_actions), True


def parse_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def extract_leading_action_from_reason(reason_text: str) -> Optional[str]:
    text = (reason_text or "").strip()
    if not text:
        return None

    match = re.search(r'"([a-zA-Z0-9_\-]+)"\s+is\s+the\s+leading\s+action', text)
    if not match:
        return None

    return match.group(1)


def validate_autonomous_recommendation(
    failure_type: str,
    recommendation: dict,
    recommended_action: Optional[str],
    reason_text: str,
) -> tuple[bool, str]:
    if not recommended_action:
        return (False, "missing_action")

    task_actions = {
        action
        for (ft, action) in ACTION_SUCCESS_RATES.keys()
        if ft == failure_type
    }
    if recommended_action not in task_actions:
        return (False, "unknown_action_for_task")

    state = str(recommendation.get("state") or "no_data").strip().lower()
    if state not in AUTONOMOUS_ALLOWED_STATES:
        return (False, f"state={state}")

    confidence = parse_float(recommendation.get("confidence"), 0.0)
    required_confidence = AUTONOMOUS_MIN_CONFIDENCE_BY_STATE.get(state, 1.0)
    if confidence < required_confidence:
        return (False, f"confidence={confidence:.3f}<min={required_confidence:.3f}")

    sample_size = recommendation.get("sample_size") or {}
    min_samples_seen = int(parse_float(sample_size.get("min"), 0.0))
    required_samples = AUTONOMOUS_MIN_SAMPLES_BY_STATE.get(state, 0)
    if min_samples_seen < required_samples:
        return (False, f"samples={min_samples_seen}<min={required_samples}")

    reason_action = extract_leading_action_from_reason(reason_text)
    if reason_action and reason_action != recommended_action:
        return (False, f"inconsistent_reason_leader={reason_action}")

    return (True, "accepted")

# ─────────────────────────────────────────────────────────────────────
# SCORING ENGINE
# ─────────────────────────────────────────────────────────────────────
def score_recommendation(failure_type: str, recommended_action: Optional[str],
                         chosen_action: str) -> dict:
    correct_action = GROUND_TRUTH[failure_type]
    rec_correct = recommended_action == correct_action if recommended_action else None
    chosen_correct = chosen_action == correct_action
    return {
        "correct_action":        correct_action,
        "recommended_action":    recommended_action,
        "chosen_action":         chosen_action,
        "recommendation_correct": rec_correct,
        "choice_correct":        chosen_correct,
        "followed_recommendation": recommended_action == chosen_action if recommended_action else None,
    }

# ─────────────────────────────────────────────────────────────────────
# MAIN AGENT LOOP
# ─────────────────────────────────────────────────────────────────────
def run_agent(li_mode: str, num_runs: int, stress: bool = False,
              seed: Optional[int] = None) -> dict:
    """
    li_mode: "none" | "observe" | "advisory" | "autonomous"
    """
    print(f"\n{'═'*70}")
    print(f"  CI/CD RELIABILITY AGENT")
    print(f"  Layerinfinite Mode : {li_mode.upper()}")
    print(f"  Runs               : {num_runs}")
    print(f"  Agent ID           : {AGENT_ID[:16]}...")
    print(f"  OpenAI Model       : {OPENAI_MODEL}")
    if seed is not None:
        print(f"  Random Seed        : {seed}")
    print(f"{'═'*70}\n")

    if seed is not None:
        random.seed(seed)

    replayed_total = 0
    preflight = {
        "host": LI_HOST,
        "dns_ok": DNS_WARMUP_OK,
        "tcp_ok": False,
        "health_ok": False,
        "health_status": "unknown",
        "status": "skipped",
        "error": None,
    }
    api_errors_total = 0
    dns_errors_total = 0
    recommendation_errors = 0
    observe_errors = 0
    score_errors = 0
    log_errors = 0

    # ── Health check first ──────────────────────────────────────────
    if li_mode != "none":
        preflight = run_connectivity_preflight(LAYERINFINITE_BASE, LI_HOST)
        print_preflight_banner(preflight)

        replayed, pending = flush_pending_outcomes()
        replayed_total += replayed
        if replayed > 0 or pending > 0:
            print(f"  Replayed pending logs : sent={replayed}, remaining={pending}")

        print("  Checking Layerinfinite health...")
        dns_state = "ok" if DNS_WARMUP_OK else "failed"
        print(f"  DNS preflight ({LI_HOST}) : {dns_state}")
        health = li_health()
        status = health.get("status", "unknown")
        color = "✅" if status == "ok" else "⚠️ "
        print(f"  {color} Backend status: {status}")
        checks = health.get("checks", {})
        for k, v in checks.items():
            icon = "✅" if v == "ok" else "⚠️ "
            print(f"     {icon} {k}: {v}")
        print()

    results = []
    episode_id = str(uuid.uuid4())  # One episode per run session
    delay = 0.3 if stress else 1.2  # Stress mode: faster

    for i in range(num_runs):
        failure_type = random.choice(ALL_FAILURE_TYPES)
        context = {
            "repo":        random.choice(["api-service", "dashboard", "sdk", "worker"]),
            "branch":      random.choice(["main", "dev", "feature/auth", "hotfix/prod"]),
            "runner":      random.choice(["ubuntu-22.04", "ubuntu-20.04"]),
            "attempt":     random.randint(1, 3),
            "duration_s":  random.randint(30, 480),
            "timestamp":   datetime.now(timezone.utc).isoformat(),
        }

        print(f"  [{i+1:02d}/{num_runs}] failure={failure_type}")

        recommended_action = None
        li_rec_data = {}
        rec_fetch_ok = True
        rec_validation = {"accepted": False, "reason": None}

        # ── OBSERVE / ADVISORY / AUTONOMOUS: always log + get rec ───
        if li_mode in ("observe", "advisory", "autonomous"):
            rec = li_get_recommendation(failure_type)
            if "error" in rec:
                rec_fetch_ok = False
                recommendation_errors += 1
                api_errors_total += 1
                if is_dns_resolution_error(str(rec.get("error", ""))):
                    dns_errors_total += 1
                print(f"         ⚠️  LI rec error : {str(rec.get('error'))[:80]}")

            rec_state = rec.get("state")
            rec_conf = rec.get("confidence")
            rec_reason = ((rec.get("reason") or {}).get("confidence_note")
                          or rec.get("message")
                          or "No recommendation yet")
            unlock_hint = rec.get("unlock_hint")
            best_action = (rec.get("insight") or {}).get("best_action")
            if best_action:
                recommended_action = str(best_action)
                li_rec_data = rec
                if li_mode == "autonomous":
                    accepted, reason = validate_autonomous_recommendation(
                        failure_type=failure_type,
                        recommendation=rec,
                        recommended_action=recommended_action,
                        reason_text=rec_reason,
                    )
                    rec_validation = {"accepted": accepted, "reason": reason}
                    if accepted:
                        print(f"         LI recommends : {recommended_action} "
                              f"(state={rec_state}, confidence={rec_conf})")
                    else:
                        print(f"         LI candidate  : {recommended_action} "
                              f"(state={rec_state}, confidence={rec_conf})")
                        print(f"         LI guardrail  : rejected ({reason})")
                else:
                    print(f"         LI recommends : {recommended_action} "
                          f"(state={rec_state}, confidence={rec_conf})")
            else:
                print(f"         LI status     : {rec_state or 'no_data'}")
                print(f"         LI reason     : {rec_reason}")
                if unlock_hint:
                    print(f"         LI unlock     : {unlock_hint}")

        # ── DECIDE: agent picks action ───────────────────────────────
        if li_mode == "autonomous" and recommended_action and rec_validation.get("accepted"):
            # Layerinfinite makes the decision outright
            chosen_action = recommended_action
            print(f"         Action taken  : {chosen_action} [AUTONOMOUS — LI decided]")
        elif li_mode == "autonomous" and recommended_action and not rec_validation.get("accepted"):
            # Autonomous safe fallback: recommendation present but below quality gate.
            chosen_action = diagnose_and_pick_action(failure_type, context)
            print(f"         Action taken  : {chosen_action} [AUTONOMOUS SAFE-FALLBACK — agent]")
        elif li_mode == "advisory" and recommended_action:
            # Agent consults hint but decides independently
            chosen_action = diagnose_and_pick_action(failure_type, context,
                                                      advisory_hint=recommended_action)
            print(f"         Action taken  : {chosen_action} [ADVISORY — agent + LI]")
        else:
            # Pure agent decision (none or observe or no prior data)
            chosen_action = diagnose_and_pick_action(failure_type, context)
            print(f"         Action taken  : {chosen_action} [AGENT ONLY]")

        chosen_action, explored = maybe_explore_action(li_mode, failure_type, chosen_action)
        if explored:
            print(f"         Exploration   : switched to {chosen_action} for data diversity")

        # ── EXECUTE: simulate real outcome ───────────────────────────
        success, confidence = simulate_action_outcome(failure_type, chosen_action)
        execution_result = build_execution_result(
            failure_type=failure_type,
            action=chosen_action,
            success=success,
            confidence=confidence,
            context=context,
        )
        outcome_score = score_fn(execution_result)
        outcome_icon = "✅" if success else "❌"
        print(f"         Outcome       : {outcome_icon} {'SUCCESS' if success else 'FAILURE'} "
              f"(conf={confidence:.3f})")
        print(f"         score_fn      : outcome_score={outcome_score:.3f}")

        # ── LOG: always send outcome to Layerinfinite if connected ───
        log_resp = {}
        if li_mode != "none":
            log_resp = li_log_outcome(
                task=failure_type,
                action=chosen_action,
                success=success,
                confidence=confidence,
                outcome_score=outcome_score,
                score_input=execution_result,
                context=context,
                episode_id=episode_id,
                sequence_index=i,
            )
            if "error" in log_resp:
                api_errors_total += 1
                log_errors += 1
                if is_dns_resolution_error(str(log_resp.get("error", ""))):
                    dns_errors_total += 1
                print(f"         ⚠️  Log error   : {log_resp['error'][:80]}")
                enqueue_pending_outcome(log_resp.get("_payload", {}))
                print("         📦 Queued      : pending replay enabled")
            else:
                print(f"         📝 Logged      : outcome_id={log_resp.get('outcome_id', log_resp.get('id', 'ok'))[:16]}...")

        # ── SCORE ────────────────────────────────────────────────────
        score = score_recommendation(failure_type, recommended_action, chosen_action)
        if li_mode == "autonomous" and recommended_action and not rec_validation.get("accepted"):
            score["followed_recommendation"] = False
        results.append({
            "run":            i + 1,
            "failure_type":   failure_type,
            "context":        context,
            "recommended":    recommended_action,
            "chosen":         chosen_action,
            "success":        success,
            "confidence":     confidence,
            "outcome_score":  outcome_score,
            "score_input":    execution_result,
            "score":          score,
            "log_ok":         "error" not in log_resp,
            "rec_fetch_ok":   rec_fetch_ok,
            "rec_autonomous_accepted": bool(rec_validation.get("accepted")),
            "rec_autonomous_reject_reason": rec_validation.get("reason"),
        })

        if not stress:
            time.sleep(delay)
        else:
            time.sleep(0.2)

    # ── POST-RUN: fetch observe + scores from Layerinfinite ─────────
    observed_tasks = {}
    if li_mode != "none":
        replayed, pending = flush_pending_outcomes()
        replayed_total += replayed
        if replayed > 0 or pending > 0:
            print(f"\n  Pending replay pass: sent={replayed}, remaining={pending}")

        print(f"\n  Fetching post-run Layerinfinite metrics...")
        for ft in set(r["failure_type"] for r in results):
            obs = li_observe(ft)
            sc  = li_get_scores(ft)

            if "error" in obs:
                api_errors_total += 1
                observe_errors += 1
                if is_dns_resolution_error(str(obs.get("error", ""))):
                    dns_errors_total += 1
                print(f"     {ft}: observe_error={str(obs.get('error'))[:80]}")

            if "error" in sc:
                api_errors_total += 1
                score_errors += 1
                if is_dns_resolution_error(str(sc.get("error", ""))):
                    dns_errors_total += 1
                print(f"     {ft}: score_error={str(sc.get('error'))[:80]}")

            observed_tasks[ft] = {"observe": obs, "scores": sc}
            total = obs.get("total_runs", 0)
            sr    = obs.get("success_rate", 0)
            best  = obs.get("best_performing")
            print(f"     {ft}: runs={total}, success_rate={sr:.0%}, "
                f"best_action={best or '—'}")

    return {
        "mode":           li_mode,
        "agent_id":       AGENT_ID,
        "episode_id":     episode_id,
        "seed":           seed,
        "num_runs":       num_runs,
        "results":        results,
        "observed_tasks": observed_tasks,
        "replayed_outcomes": replayed_total,
        "network": {
            "li_host": LI_HOST,
            "dns_warmup_ok": DNS_WARMUP_OK,
            "preflight": preflight,
            "api_errors_total": api_errors_total,
            "dns_errors_total": dns_errors_total,
            "recommendation_errors": recommendation_errors,
            "log_errors": log_errors,
            "observe_errors": observe_errors,
            "score_errors": score_errors,
        },
    }

# ─────────────────────────────────────────────────────────────────────
# REPORT GENERATOR
# ─────────────────────────────────────────────────────────────────────
def generate_report(run_data: dict) -> None:
    results = run_data["results"]
    mode    = run_data["mode"]
    n       = len(results)

    # ── Core metrics ─────────────────────────────────────────────────
    successes         = sum(1 for r in results if r["success"])
    success_rate      = successes / n if n else 0

    rec_available     = [r for r in results if r["recommended"] is not None]
    rec_correct_count = sum(1 for r in rec_available if r["score"]["recommendation_correct"])
    rec_accuracy      = rec_correct_count / len(rec_available) if rec_available else None

    choice_correct    = sum(1 for r in results if r["score"]["choice_correct"])
    choice_accuracy   = choice_correct / n if n else 0
    mean_outcome_score = (sum(float(r.get("outcome_score", 0.0)) for r in results) / n) if n else 0

    followed_count    = sum(1 for r in rec_available if r["score"]["followed_recommendation"])
    follow_rate       = followed_count / len(rec_available) if rec_available else None

    rec_fetch_ok = sum(1 for r in results if r.get("rec_fetch_ok", True))
    rec_fetch_rate = rec_fetch_ok / n if n else 0

    rec_candidates = sum(1 for r in results if r.get("recommended") is not None)
    rec_autonomous_accepted = sum(1 for r in results if r.get("rec_autonomous_accepted", False))
    rec_autonomous_accept_rate = (
        rec_autonomous_accepted / rec_candidates
        if rec_candidates else 0
    )

    log_ok            = sum(1 for r in results if r.get("log_ok", False))
    replayed_outcomes = int(run_data.get("replayed_outcomes", 0) or 0)
    effective_logged  = min(n, log_ok + replayed_outcomes)
    log_success_rate  = effective_logged / n if n else 0
    network = run_data.get("network", {})

    # ── Per-failure breakdown ─────────────────────────────────────────
    per_type: dict = {}
    for r in results:
        ft = r["failure_type"]
        if ft not in per_type:
            per_type[ft] = {"total": 0, "success": 0, "correct_choice": 0}
        per_type[ft]["total"]          += 1
        per_type[ft]["success"]        += int(r["success"])
        per_type[ft]["correct_choice"] += int(r["score"]["choice_correct"])

    # ── Print report ─────────────────────────────────────────────────
    WIDTH = 70
    print(f"\n{'═'*WIDTH}")
    print(f"  FINAL REPORT  |  Mode: {mode.upper()}  |  Runs: {n}")
    print(f"{'═'*WIDTH}")

    print(f"\n  BACKEND VERIFICATION")
    print(f"  {'─'*50}")
    if mode != "none":
        preflight = network.get("preflight") or {}
        if preflight:
            print(
                f"  Startup preflight status        : {preflight.get('status', 'unknown')} "
                f"(dns={preflight.get('dns_ok')}, tcp={preflight.get('tcp_ok')})"
            )
        print(f"  Outcomes logged immediately      : {log_ok}/{n}")
        print(f"  Outcomes replayed from queue     : {replayed_outcomes}")
        print(f"  Outcomes delivered eventually    : {effective_logged}/{n} ({log_success_rate:.0%})")
        print(f"  Recommendation fetch success     : {rec_fetch_ok}/{n} ({rec_fetch_rate:.0%})")

        api_errors_total = int(network.get("api_errors_total", 0) or 0)
        dns_errors_total = int(network.get("dns_errors_total", 0) or 0)
        if api_errors_total > 0:
            print(f"  API transport errors observed    : {api_errors_total} (DNS={dns_errors_total})")
            if dns_errors_total > 0:
                print(f"  ⚠️  DNS resolution instability detected. LI learning/recommendation coverage can be undercounted.")

        if effective_logged == n:
            print(f"  ✅ All outcomes reached backend (direct + replay) — no silent failures")
        else:
            print(f"  ⚠️  {n - effective_logged} outcomes still pending/failed — check backend health")
    else:
        print(f"  Mode=none — not connected to Layerinfinite")

    print(f"\n  AGENT PERFORMANCE")
    print(f"  {'─'*50}")
    print(f"  Overall success rate        : {success_rate:.1%}  ({successes}/{n})")
    print(f"  Correct action chosen       : {choice_accuracy:.1%}  ({choice_correct}/{n})")
    print(f"  Mean outcome score (score_fn): {mean_outcome_score:.3f}")
    if mode == "autonomous" and rec_candidates > 0:
        print(f"  Autonomous rec accepted     : {rec_autonomous_accepted}/{rec_candidates} ({rec_autonomous_accept_rate:.1%})")

    if rec_accuracy is not None:
        print(f"\n  LAYERINFINITE ACCURACY")
        print(f"  {'─'*50}")
        print(f"  Recommendations available   : {len(rec_available)}/{n}")
        print(f"  Recommendation accuracy     : {rec_accuracy:.1%}  ({rec_correct_count}/{len(rec_available)})")
        print(f"  Agent follow rate           : {follow_rate:.1%}  ({followed_count}/{len(rec_available)})")

        # Verdict
        print(f"\n  VERDICT")
        print(f"  {'─'*50}")
        if rec_accuracy >= 0.80:
            print(f"  🟢 EXCELLENT — LI is recommending correct actions {rec_accuracy:.0%} of the time")
            print(f"     Developers can trust these recommendations in production")
        elif rec_accuracy >= 0.60:
            print(f"  🟡 IMPROVING — LI accuracy at {rec_accuracy:.0%}. Needs more data (run more episodes)")
        else:
            print(f"  🔴 LEARNING — LI at {rec_accuracy:.0%} accuracy. Normal for cold start. Run advisory/autonomous")
            print(f"     mode again after this run and accuracy will improve")

    print(f"\n  PER-FAILURE BREAKDOWN")
    print(f"  {'─'*50}")
    for ft, stats in sorted(per_type.items()):
        sr   = stats["success"]  / stats["total"]
        cacc = stats["correct_choice"] / stats["total"]
        print(f"  {ft:<40} success={sr:.0%}  correct={cacc:.0%}  (n={stats['total']})")

    # ── What to check in dashboard ───────────────────────────────────
    if mode != "none":
        print(f"\n  DASHBOARD CHECKLIST")
        print(f"  {'─'*50}")
        failure_types_seen = list(set(r["failure_type"] for r in results))
        print(f"  Open your Layerinfinite dashboard and verify:")
        print(f"  ✓ [{n}] new outcomes visible in the outcomes table")
        for ft in failure_types_seen[:5]:
            print(f"  ✓ Task '{ft}' shows success_rate and best_action")
        print(f"  ✓ Trust score for agent {AGENT_ID[:16]}... has updated")
        print(f"  ✓ No alerts firing for silent failures (all outcomes logged: {log_ok==n})")
        if mode == "autonomous":
            print(f"  ✓ Sequence patterns visible in /v1/get-patterns")
            print(f"  ✓ mv_sequence_scores updated for episode {run_data['episode_id'][:16]}...")

    print(f"\n{'═'*WIDTH}\n")

    # ── Save JSON results ─────────────────────────────────────────────
    filename = f"results_{mode}_{datetime.now().strftime('%H%M%S')}.json"
    with open(filename, "w") as f:
        json.dump(run_data, f, indent=2, default=str)
    print(f"  Full results saved → {filename}")
    print()

# ─────────────────────────────────────────────────────────────────────
# COMPARISON REPORT (run after you have baseline + LI results)
# ─────────────────────────────────────────────────────────────────────
def compare_reports(file_none: str, file_li: str) -> None:
    with open(file_none) as f:  baseline = json.load(f)
    with open(file_li) as f:    li_run   = json.load(f)

    def get_metrics(data):
        res = data["results"]
        n = len(res)
        return {
            "success_rate":   sum(1 for r in res if r["success"]) / n,
            "choice_accuracy": sum(1 for r in res if r["score"]["choice_correct"]) / n,
            "n": n,
        }

    bm = get_metrics(baseline)
    lm = get_metrics(li_run)

    print(f"\n{'═'*60}")
    print(f"  COMPARISON: WITHOUT vs WITH Layerinfinite")
    print(f"  LI Mode: {li_run['mode'].upper()}")
    print(f"{'═'*60}")
    print(f"  {'Metric':<30} {'WITHOUT':>10} {'WITH':>10}  {'Δ':>8}")
    print(f"  {'─'*58}")

    def diff(a, b): return f"+{(b-a)*100:.1f}pp" if b > a else f"{(b-a)*100:.1f}pp"

    print(f"  {'Success Rate':<30} {bm['success_rate']:>9.1%} {lm['success_rate']:>9.1%}  {diff(bm['success_rate'], lm['success_rate']):>8}")
    print(f"  {'Correct Action %':<30} {bm['choice_accuracy']:>9.1%} {lm['choice_accuracy']:>9.1%}  {diff(bm['choice_accuracy'], lm['choice_accuracy']):>8}")
    print(f"{'═'*60}\n")

# ─────────────────────────────────────────────────────────────────────
# CLI ENTRY POINT
# ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    configure_console_utf8()

    parser = argparse.ArgumentParser(
        description="CI/CD Reliability Agent — Layerinfinite Test Harness"
    )
    parser.add_argument("--mode", choices=["none","observe","advisory","autonomous"],
                        default="none", help="Layerinfinite integration mode")
    parser.add_argument("--runs", type=int, default=15,
                        help="Number of failure scenarios to process (default: 15)")
    parser.add_argument("--stress", action="store_true",
                        help="Stress mode: 20 rapid decisions")
    parser.add_argument("--compare", nargs=2, metavar=("BASELINE_JSON", "LI_JSON"),
                        help="Compare two saved result files")
    parser.add_argument("--seed", type=int, default=None,
                        help="Deterministic random seed for reproducible runs")
    args = parser.parse_args()

    if args.compare:
        compare_reports(args.compare[0], args.compare[1])
        sys.exit(0)

    if args.stress:
        args.runs = 20
        print("  ⚡ STRESS MODE: 20 rapid decisions")

    run_data = run_agent(
        li_mode=args.mode,
        num_runs=args.runs,
        stress=args.stress,
        seed=args.seed,
    )
    generate_report(run_data)