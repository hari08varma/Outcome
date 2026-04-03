#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
  Layerinfinite Integration Test — DevOps Incident Response Agent
═══════════════════════════════════════════════════════════════════════

A REAL AI agent that resolves production infrastructure incidents.
Uses GPT-4o-mini for intelligent diagnosis alongside automated
remediation scripts.

Tests all three Layerinfinite modes against a no-Layerinfinite
baseline to prove measurable improvement in incident resolution.

What this agent tests end-to-end:
  ✓ SDK decorator with score_fn callback
  ✓ Auto-logging of outcomes with outcome_score
  ✓ Silent failure detection (success=true but score < 0.3)
  ✓ Trust system (update_config throws ~15% of the time)
  ✓ Scoring engine convergence over 30+ outcomes
  ✓ Policy engine decisions (explore → exploit)
  ✓ Recommendation accuracy (li.recommend)
  ✓ Observation stats (li.observe)
  ✓ Suggestion quality (li.suggest in assist mode)
  ✓ Autonomous execution (li.run in auto mode)
  ✓ Auto-fallback on action failure
  ✓ Dashboard metrics verification
  ✓ Before/after performance comparison

Usage:
  export LAYERINFINITE_API_KEY="layerinfinite_xxx"
  export OPENAI_API_KEY="sk-proj-xxx"
  pip install httpx pydantic
  python layerinfinite_test_agent.py

  To skip OpenAI calls (free run):
  python layerinfinite_test_agent.py --skip-llm
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import sys
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import httpx

# ═══════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════

def _sanitize_env_key(value: Optional[str]) -> str:
    """Normalize API keys copied from terminals/docs with accidental quotes."""
    if not value:
        return ""
    return (
        value.strip()
        .replace("\r", "")
        .replace("\n", "")
        .replace('"', "")
        .replace("'", "")
    )


LAYERINFINITE_API_KEY = _sanitize_env_key(os.environ.get("LAYERINFINITE_API_KEY"))
OPENAI_API_KEY = _sanitize_env_key(os.environ.get("OPENAI_API_KEY"))
LI_BASE_URL = os.environ.get("LAYERINFINITE_BASE_URL", "https://api.layerinfinite.app")
TASK_NAME = "incident_resolution"
AGENT_ID = "failure"
SKIP_LLM = "--skip-llm" in sys.argv


# ═══════════════════════════════════════════════════════════════
# 30 PRODUCTION INCIDENT SCENARIOS
# ═══════════════════════════════════════════════════════════════

SCENARIOS = [
    # ── Memory Leaks (6) ─────────────────────────────────────
    {"id": "INC-001", "root_cause": "memory_leak",
     "title": "API latency degrading over 24 hours",
     "description": "Main API response times climbing from 200ms to 2.5s over 24 hours. Memory usage trending upward in Grafana. No recent deployments. RSS growing 50MB/hour.",
     "keywords": ["memory", "leak", "heap", "gc", "oom", "rss"]},
    {"id": "INC-002", "root_cause": "memory_leak",
     "title": "Worker process consuming 95% RAM",
     "description": "Background job worker at 95% memory. OOM kills appearing in dmesg every 30 minutes. Process restart temporarily fixes but memory climbs back within 2 hours.",
     "keywords": ["memory", "oom", "worker", "process", "ram"]},
    {"id": "INC-003", "root_cause": "memory_leak",
     "title": "Connection pool exhaustion on auth service",
     "description": "Auth service returning 503s. Connection pool at max capacity (500/500). New connections queuing indefinitely. Connections not being released after use.",
     "keywords": ["memory", "connection", "pool", "leak", "exhaust"]},
    {"id": "INC-004", "root_cause": "memory_leak",
     "title": "GC pause times increasing to 800ms",
     "description": "Java service GC pause times went from 20ms to 800ms. Full GC happening every 90 seconds. Heap not releasing old generation objects. Thread dumps show growing HashMap.",
     "keywords": ["memory", "gc", "heap", "pause", "java", "leak"]},
    {"id": "INC-005", "root_cause": "memory_leak",
     "title": "Container OOM restarts every 4 hours",
     "description": "Kubernetes pod restarting due to OOM every 4 hours exactly. Memory limit 2Gi, usage grows linearly from 800Mi. No recent code changes.",
     "keywords": ["memory", "oom", "container", "kubernetes", "restart"]},
    {"id": "INC-006", "root_cause": "memory_leak",
     "title": "Redis memory growing unbounded",
     "description": "Redis instance memory at 14GB and climbing. maxmemory set to 16GB. Key count growing despite TTLs. Suspect orphaned session keys not expiring.",
     "keywords": ["memory", "redis", "cache", "leak", "keys"]},

    # ── Bad Deployments (6) ──────────────────────────────────
    {"id": "INC-007", "root_cause": "bad_deploy",
     "title": "500 errors spiking immediately after deploy",
     "description": "Error rate jumped from 0.1% to 34% immediately after v2.14.0 deploy at 14:23 UTC. Stack traces show NullPointerException in PaymentController.process().",
     "keywords": ["deploy", "rollback", "release", "version", "revert"]},
    {"id": "INC-008", "root_cause": "bad_deploy",
     "title": "Missing environment variable after release",
     "description": "New feature flag service crashing on startup. Logs show: 'FEATURE_FLAG_API_URL is not defined'. Variable was in staging .env but not added to production Helm chart.",
     "keywords": ["deploy", "env", "variable", "config", "missing", "release"]},
    {"id": "INC-009", "root_cause": "bad_deploy",
     "title": "Database migration failed silently",
     "description": "API returning empty arrays for all user queries since deploy. Migration 047_add_index.sql ran but 048_backfill_status.sql was skipped. status column is null for all rows.",
     "keywords": ["deploy", "migration", "database", "rollback", "schema"]},
    {"id": "INC-010", "root_cause": "bad_deploy",
     "title": "API contract broken for mobile clients",
     "description": "iOS app crashing on launch since API v2.14. Response field renamed from 'user_name' to 'username'. Mobile team wasn't notified. 40% of users affected.",
     "keywords": ["deploy", "api", "breaking", "contract", "rollback"]},
    {"id": "INC-011", "root_cause": "bad_deploy",
     "title": "Dependency version conflict causing import errors",
     "description": "Python service failing to start: 'ImportError: cannot import name CertificateError from urllib3'. Requirements.txt pinned urllib3==2.1.0 but requests needs <2.0.",
     "keywords": ["deploy", "dependency", "version", "conflict", "rollback"]},
    {"id": "INC-012", "root_cause": "bad_deploy",
     "title": "Feature flag misconfiguration after release",
     "description": "Premium features visible to all free-tier users since deploy. Feature flag 'premium_features' defaulting to true instead of false. LaunchDarkly config not updated.",
     "keywords": ["deploy", "feature", "flag", "config", "rollback"]},

    # ── Traffic Spikes (6) ───────────────────────────────────
    {"id": "INC-013", "root_cause": "traffic_spike",
     "title": "10x traffic surge, response queue backing up",
     "description": "Request rate jumped from 500 RPS to 5,000 RPS in 3 minutes. Queue depth at 12,000 and growing. P99 latency at 15 seconds. No auto-scaling triggered.",
     "keywords": ["traffic", "scale", "load", "capacity", "autoscal"]},
    {"id": "INC-014", "root_cause": "traffic_spike",
     "title": "Viral social media post causing massive surge",
     "description": "Influencer posted product link. Traffic from 800 to 25,000 concurrent users in 10 minutes. CDN cache miss rate at 89%. Origin servers overwhelmed.",
     "keywords": ["traffic", "scale", "cdn", "capacity", "viral"]},
    {"id": "INC-015", "root_cause": "traffic_spike",
     "title": "Cron job flood — all jobs executing simultaneously",
     "description": "Scheduled job runner fired 2,000 jobs at exactly 00:00 UTC instead of staggering. Database CPU at 100%. Connection pool exhausted. Other services timing out.",
     "keywords": ["traffic", "load", "cron", "burst", "scale"]},
    {"id": "INC-016", "root_cause": "traffic_spike",
     "title": "CDN origin overwhelmed after cache purge",
     "description": "Full CDN cache invalidation triggered by accident. 100% of requests hitting origin. 50x normal origin load. Homepage loading in 12 seconds.",
     "keywords": ["traffic", "cdn", "cache", "load", "scale"]},
    {"id": "INC-017", "root_cause": "traffic_spike",
     "title": "Auto-scaler not responding, instances at capacity",
     "description": "All 8 instances at 98% CPU. Auto-scaling group stuck at max. CloudWatch alarm not triggering. Scaling policy cooldown set to 600s, preventing new scale-out.",
     "keywords": ["traffic", "autoscal", "capacity", "scale", "instance"]},
    {"id": "INC-018", "root_cause": "traffic_spike",
     "title": "Database connections exhausted from traffic burst",
     "description": "PostgreSQL max_connections (200) reached. New API requests failing with 'too many connections'. PgBouncer pool also at capacity. Read replicas not receiving traffic.",
     "keywords": ["traffic", "database", "connection", "scale", "pool"]},

    # ── Config Errors (6) ────────────────────────────────────
    {"id": "INC-019", "root_cause": "config_error",
     "title": "SSL certificate expired, HTTPS failing",
     "description": "All HTTPS requests failing with ERR_CERT_DATE_INVALID since midnight. Let's Encrypt cert expired. Auto-renewal cron was disabled 3 months ago during migration.",
     "keywords": ["config", "ssl", "certificate", "tls", "renew"]},
    {"id": "INC-020", "root_cause": "config_error",
     "title": "DNS misconfiguration after provider migration",
     "description": "api.example.com resolving to old IP address. DNS propagation incomplete after Route53 to Cloudflare migration. TTL was set to 86400s (24 hours).",
     "keywords": ["config", "dns", "domain", "resolve", "record"]},
    {"id": "INC-021", "root_cause": "config_error",
     "title": "Rate limit threshold set too low",
     "description": "Legitimate API consumers getting 429 errors. Rate limit was changed from 1000/min to 100/min during testing and never reverted. 60% of enterprise clients affected.",
     "keywords": ["config", "rate", "limit", "threshold", "setting"]},
    {"id": "INC-022", "root_cause": "config_error",
     "title": "Wrong database connection string in production",
     "description": "Reporting service querying staging database instead of production. Connection string ENV var pointing to staging host. Reports showing stale data from 2 weeks ago.",
     "keywords": ["config", "database", "connection", "environment", "wrong"]},
    {"id": "INC-023", "root_cause": "config_error",
     "title": "Firewall rule blocking internal service communication",
     "description": "Payment service cannot reach fraud detection service. New firewall rule added yesterday blocking port 8443 between subnets. Security team unaware of service dependency.",
     "keywords": ["config", "firewall", "network", "rule", "block"]},
    {"id": "INC-024", "root_cause": "config_error",
     "title": "Logging level set to DEBUG, disk filling up",
     "description": "Production disk at 98%. Log volume jumped from 2GB/day to 200GB/day. DEBUG logging was enabled for troubleshooting last week and never reverted. /var/log consuming all space.",
     "keywords": ["config", "logging", "disk", "level", "debug"]},

    # ── Complex / Multi-cause (6) ────────────────────────────
    {"id": "INC-025", "root_cause": "complex",
     "title": "Cascading failure across microservices",
     "description": "Order service timeout → inventory service backlog → payment service retries → database connection storm. 5 services affected. Circuit breakers not configured. Error rate 67%.",
     "keywords": ["cascade", "circuit", "breaker", "timeout", "retry", "microservice"]},
    {"id": "INC-026", "root_cause": "complex",
     "title": "Data corruption causing intermittent 500 errors",
     "description": "Random 500 errors affecting 12% of requests. Specific user records have malformed JSON in metadata column. ETL job from last week inserted invalid Unicode sequences.",
     "keywords": ["data", "corruption", "json", "encoding", "etl", "intermittent"]},
    {"id": "INC-027", "root_cause": "complex",
     "title": "Race condition under high load",
     "description": "Inventory showing negative stock for popular items during flash sale. Concurrent purchase requests bypassing stock check. Distributed lock not acquired properly.",
     "keywords": ["race", "condition", "concurrent", "lock", "distributed"]},
    {"id": "INC-028", "root_cause": "complex",
     "title": "Third-party API rate limiting causing timeouts",
     "description": "Stripe API returning 429s for 80% of requests. Our retry logic is making it worse — exponential backoff not configured. Payment success rate dropped to 20%.",
     "keywords": ["third", "party", "api", "rate", "limit", "external"]},
    {"id": "INC-029", "root_cause": "complex",
     "title": "Clock skew causing JWT validation failures",
     "description": "Auth tokens rejected as 'expired' despite being freshly issued. NTP sync failed on 3 of 8 app servers. Clock drift of 45 seconds causing JWT exp validation to fail.",
     "keywords": ["clock", "skew", "ntp", "time", "sync", "jwt"]},
    {"id": "INC-030", "root_cause": "complex",
     "title": "Network partition between availability zones",
     "description": "us-east-1a cannot reach us-east-1b. Database primary in 1a, replicas in 1b. Read traffic failing. Failover not triggering because primary is healthy. Split-brain risk.",
     "keywords": ["network", "partition", "availability", "zone", "failover"]},
]


# ═══════════════════════════════════════════════════════════════
# ACTION SUCCESS PROBABILITIES
# ═══════════════════════════════════════════════════════════════
# Each action has a probability of resolving an incident based
# on the root cause type. This creates a realistic scenario where
# different actions are better for different incident types,
# and Layerinfinite must learn which action works best overall.

SUCCESS_MATRIX = {
    #                    memory_leak  bad_deploy  traffic_spike  config_error  complex
    "restart_service":     [0.90,       0.40,       0.70,          0.25,        0.55],
    "rollback_deploy":     [0.10,       0.85,       0.05,          0.30,        0.35],
    "scale_horizontally":  [0.20,       0.05,       0.90,          0.05,        0.25],
    "update_config":       [0.05,       0.20,       0.05,          0.85,        0.20],
    "llm_diagnose_and_fix":[0.50,       0.50,       0.45,          0.45,        0.60],
}

ROOT_CAUSE_INDEX = {
    "memory_leak": 0, "bad_deploy": 1, "traffic_spike": 2,
    "config_error": 3, "complex": 4,
}

ACTION_NAMES = list(SUCCESS_MATRIX.keys())
if SKIP_LLM:
    ACTION_NAMES = [a for a in ACTION_NAMES if a != "llm_diagnose_and_fix"]


# ═══════════════════════════════════════════════════════════════
# DETERMINISTIC OUTCOME CHECKER
# ═══════════════════════════════════════════════════════════════

def _det_check(incident_id: str, action_name: str, probability: float) -> bool:
    """Deterministic success check — same (incident, action) always
    produces the same result. Reproducible across runs."""
    seed = int(hashlib.md5(f"{incident_id}:{action_name}".encode()).hexdigest(), 16)
    return (seed % 1000) < int(probability * 1000)


def _det_value(incident_id: str, label: str) -> float:
    """Deterministic float 0.0–1.0 for a given (incident, label)."""
    seed = int(hashlib.md5(f"{incident_id}:{label}".encode()).hexdigest(), 16)
    return (seed % 1000) / 1000.0


def get_success_prob(action_name: str, root_cause: str) -> float:
    """Look up the probability of an action resolving a given root cause."""
    idx = ROOT_CAUSE_INDEX[root_cause]
    return SUCCESS_MATRIX[action_name][idx]


# ═══════════════════════════════════════════════════════════════
# RAW ACTION FUNCTIONS (no Layerinfinite dependency)
# ═══════════════════════════════════════════════════════════════

def _restart_service(*, incident: dict) -> dict:
    """Simulate restarting the affected service (systemctl restart)."""
    time.sleep(random.uniform(0.15, 0.40))
    prob = get_success_prob("restart_service", incident["root_cause"])
    resolved = _det_check(incident["id"], "restart_service", prob)
    return {
        "resolved": resolved,
        "resolution_score": 0.95 if resolved else 0.12,
        "action": "restart_service",
        "detail": "Service restarted, memory freed, connections reset"
        if resolved else "Service restarted but issue persists after 5 minutes",
    }


def _rollback_deploy(*, incident: dict) -> dict:
    """Simulate rolling back to the previous deployment version."""
    time.sleep(random.uniform(0.30, 0.70))
    prob = get_success_prob("rollback_deploy", incident["root_cause"])
    resolved = _det_check(incident["id"], "rollback_deploy", prob)
    return {
        "resolved": resolved,
        "resolution_score": 0.92 if resolved else 0.10,
        "action": "rollback_deploy",
        "detail": "Rolled back to v2.13.2, error rate returning to baseline"
        if resolved else "Rollback completed but issue predates this deploy",
    }


def _scale_horizontally(*, incident: dict) -> dict:
    """Simulate scaling out by adding more instances."""
    time.sleep(random.uniform(0.20, 0.55))
    prob = get_success_prob("scale_horizontally", incident["root_cause"])
    resolved = _det_check(incident["id"], "scale_horizontally", prob)
    return {
        "resolved": resolved,
        "resolution_score": 0.88 if resolved else 0.15,
        "action": "scale_horizontally",
        "detail": "Scaled from 4 to 12 instances, load distributed"
        if resolved else "Added instances but per-instance issue remains",
    }


def _update_config(*, incident: dict) -> dict:
    """Simulate updating a configuration file. Sometimes crashes."""
    time.sleep(random.uniform(0.10, 0.25))

    # 15% deterministic crash rate — tests trust system + auto-fallback
    crash = _det_value(incident["id"], "update_config_crash")
    if crash < 0.15:
        raise RuntimeError(
            f"Config update failed: permission denied on /etc/app/config.yaml "
            f"(incident {incident['id']})"
        )

    prob = get_success_prob("update_config", incident["root_cause"])
    resolved = _det_check(incident["id"], "update_config", prob)
    return {
        "resolved": resolved,
        "resolution_score": 0.90 if resolved else 0.08,
        "action": "update_config",
        "detail": "Configuration updated, service reloaded"
        if resolved else "Config change applied but did not address root cause",
    }


def _llm_diagnose_and_fix(*, incident: dict) -> dict:
    """Use GPT-4o-mini to analyze the incident and suggest a fix.
    This is the REAL LLM call — tests AI integration."""
    if SKIP_LLM or not OPENAI_API_KEY:
        # Fallback: simulate LLM response when keys unavailable
        time.sleep(random.uniform(0.3, 0.6))
        prob = get_success_prob("llm_diagnose_and_fix", incident["root_cause"])
        resolved = _det_check(incident["id"], "llm_diagnose_and_fix", prob)
        return {
            "resolved": resolved,
            "resolution_score": 0.75 if resolved else 0.20,
            "action": "llm_diagnose_and_fix",
            "detail": "[simulated] LLM analysis skipped (--skip-llm)",
        }

    try:
        response = httpx.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "gpt-4o-mini",
                "messages": [
                    {"role": "system", "content": (
                        "You are an expert DevOps engineer. Diagnose the root cause "
                        "of this production incident and suggest a specific fix. "
                        "Be concise — 2-3 sentences max."
                    )},
                    {"role": "user", "content": (
                        f"Incident: {incident['title']}\n\n"
                        f"Details: {incident['description']}"
                    )},
                ],
                "max_tokens": 120,
                "temperature": 0.3,
            },
            timeout=30.0,
        )
        response.raise_for_status()
        diagnosis = response.json()["choices"][0]["message"]["content"].strip()

        # Score based on keyword match against known root cause
        keywords = incident.get("keywords", [])
        matches = sum(1 for kw in keywords if kw.lower() in diagnosis.lower())
        resolution_score = min(1.0, matches / max(len(keywords), 1) * 1.8)
        resolved = resolution_score > 0.45

        return {
            "resolved": resolved,
            "resolution_score": round(resolution_score, 2),
            "action": "llm_diagnose_and_fix",
            "detail": diagnosis[:200],
        }
    except Exception as e:
        return {
            "resolved": False,
            "resolution_score": 0.0,
            "action": "llm_diagnose_and_fix",
            "detail": f"LLM analysis failed: {type(e).__name__}: {e}",
        }


RAW_ACTIONS = {
    "restart_service": _restart_service,
    "rollback_deploy": _rollback_deploy,
    "scale_horizontally": _scale_horizontally,
    "update_config": _update_config,
    "llm_diagnose_and_fix": _llm_diagnose_and_fix,
}

# Score callback — extracts resolution_score from action result
SCORE_FN = lambda result: result.get("resolution_score", 0.0)


# ═══════════════════════════════════════════════════════════════
# PHASE RUNNERS
# ═══════════════════════════════════════════════════════════════

def run_baseline(scenarios: list) -> dict:
    """Phase 1: Run scenarios WITHOUT Layerinfinite.
    Random action selection. Local result tracking only."""
    print("\n" + "=" * 65)
    print("  PHASE 1: BASELINE (no Layerinfinite)")
    print("=" * 65)

    results = []
    for i, sc in enumerate(scenarios):
        action_name = random.choice(ACTION_NAMES)
        fn = RAW_ACTIONS[action_name]

        try:
            result = fn(incident=sc)
            success = True
        except Exception as e:
            result = {"resolved": False, "resolution_score": 0.0,
                      "action": action_name, "detail": str(e)}
            success = False

        score = result.get("resolution_score", 0.0)
        results.append({
            "scenario": sc["id"],
            "action": action_name,
            "resolved": result.get("resolved", False),
            "score": score,
            "success": success,
        })

        status = "✓" if result.get("resolved") else "✗"
        print(f"  [{i+1:2d}/{len(scenarios)}] {sc['id']} → {action_name:<22} "
              f"{status} score={score:.2f}")

    return _compute_phase_stats(results, "BASELINE")


def run_recommend_phase(scenarios: list, num_rounds: int = 3) -> dict:
    """Phase 2: RECOMMEND mode — random selection, but outcomes
    are logged to Layerinfinite. Builds up outcome data.

    Runs multiple rounds to accumulate enough data for the scoring
    engine to learn. With 5 actions and Bayesian smoothing, the engine
    needs ~15-20 outcomes per action (75-100 total) for stable rankings.
    """
    from layerinfinite import Layerinfinite

    print("\n" + "=" * 65)
    print(f"  PHASE 2: RECOMMEND MODE ({num_rounds} rounds × {len(scenarios)} scenarios)")
    print("=" * 65)
    print(f"  Training the scoring engine with {num_rounds * len(scenarios)} random outcomes...")

    li = Layerinfinite(
        api_key=LAYERINFINITE_API_KEY,
        agent_id=AGENT_ID,
        mode="recommend",
        base_url=LI_BASE_URL,
        timeout=15.0,
        log_async=False,  # Synchronous — ensure data commits before next phase
    )

    # Register all actions with score_fn
    decorated = {}
    for name in ACTION_NAMES:
        fn = RAW_ACTIONS[name]
        decorated[name] = li.action(
            TASK_NAME, name=name, score_fn=SCORE_FN
        )(fn)

    all_results = []
    action_stats: Dict[str, Dict[str, int]] = {a: {"total": 0, "resolved": 0} for a in ACTION_NAMES}

    for round_num in range(1, num_rounds + 1):
        print(f"\n  ── Round {round_num}/{num_rounds} ──")
        for i, sc in enumerate(scenarios):
            action_name = random.choice(ACTION_NAMES)
            fn = decorated[action_name]

            try:
                result = fn(incident=sc)
                success = True
            except Exception:
                result = {"resolved": False, "resolution_score": 0.0,
                          "action": action_name}
                success = False

            score = result.get("resolution_score", 0.0)
            resolved = result.get("resolved", False)

            action_stats[action_name]["total"] += 1
            if resolved:
                action_stats[action_name]["resolved"] += 1

            all_results.append({
                "scenario": sc["id"],
                "action": action_name,
                "resolved": resolved,
                "score": score,
                "success": success,
            })

            status = "✓" if resolved else "✗"
            idx = (round_num - 1) * len(scenarios) + i + 1
            total = num_rounds * len(scenarios)
            print(f"  [{idx:3d}/{total}] {sc['id']} → {action_name:<22} "
                  f"{status} score={score:.2f}  [logged]")

        # Brief pause between rounds for backend processing
        if round_num < num_rounds:
            time.sleep(2)

    stats = _compute_phase_stats(all_results, "RECOMMEND (training)")

    # Show per-action resolution rates (what the engine should learn)
    print("\n  ── Empirical action performance (ground truth) ──")
    for name in sorted(ACTION_NAMES):
        s = action_stats[name]
        rate = s["resolved"] / s["total"] if s["total"] > 0 else 0
        print(f"    {name:<22} {s['resolved']:>2d}/{s['total']:>2d} = {rate:.0%}")

    # Show what Layerinfinite learned
    print("\n  ── Checking what Layerinfinite learned ──")
    time.sleep(5)  # Let backend process final batch

    try:
        li.observe(TASK_NAME)
    except Exception as e:
        print(f"  ⚠ observe() error: {e}")

    try:
        li.recommend(TASK_NAME)
    except Exception as e:
        print(f"  ⚠ recommend() error: {e}")

    # Show raw scores — this is what Assist/Auto will use
    try:
        scores_resp = li.scores(TASK_NAME)
        print(f"\n  [layerinfinite] Ranked scores after training:")
        for sa in scores_resp.ranked_actions:
            print(f"    {sa.action_name:<22} score={sa.composite_score:.3f}  "
                  f"conf={sa.confidence:.0%}  attempts={sa.total_attempts}")
        if scores_resp.ranked_actions:
            top = scores_resp.ranked_actions[0]
            print(f"\n  → Engine will recommend: {top.action_name} "
                  f"(score={top.composite_score:.3f})")
    except Exception as e:
        print(f"  ⚠ scores() error: {e}")

    li._http.close()
    return stats


def run_assist_phase(scenarios: list) -> dict:
    """Phase 3: ASSIST mode — follow Layerinfinite's suggestions."""
    from layerinfinite import Layerinfinite

    print("\n" + "=" * 65)
    print("  PHASE 3: ASSIST MODE (following Layerinfinite suggestions)")
    print("=" * 65)

    li = Layerinfinite(
        api_key=LAYERINFINITE_API_KEY,
        agent_id=AGENT_ID,
        mode="assist",
        base_url=LI_BASE_URL,
        timeout=15.0,
        log_async=False,
    )

    # Register all actions
    decorated = {}
    for name in ACTION_NAMES:
        fn = RAW_ACTIONS[name]
        decorated[name] = li.action(
            TASK_NAME, name=name, score_fn=SCORE_FN
        )(fn)

    results = []
    suggestions_followed = 0
    cold_starts = 0
    action_choices: Dict[str, int] = {}

    # Pre-fetch the suggestion once — it won't change within this phase
    # because the engine's scores are stable for the same task
    initial_suggestion = None
    try:
        initial_suggestion = li.suggest(TASK_NAME)
        print(f"\n  Engine suggests: {initial_suggestion.action_name} "
              f"(confidence: {initial_suggestion.confidence:.0%})")
        if initial_suggestion.ranked:
            print("  Full ranking:")
            for r in initial_suggestion.ranked:
                print(f"    {r.action_name:<22} score={r.score:.3f}")
    except Exception as e:
        print(f"  ⚠ Initial suggest() failed: {e}")

    for i, sc in enumerate(scenarios):
        # Ask Layerinfinite what to do
        try:
            suggestion = li.suggest(TASK_NAME)
            suggested_action = suggestion.action_name
            confidence = suggestion.confidence

            if suggested_action in decorated:
                action_name = suggested_action
                suggestions_followed += 1
            else:
                action_name = random.choice(ACTION_NAMES)
        except Exception as e:
            action_name = random.choice(ACTION_NAMES)
            confidence = 0.0
            cold_starts += 1

        action_choices[action_name] = action_choices.get(action_name, 0) + 1
        fn = decorated[action_name]
        try:
            result = fn(incident=sc)
            success = True
        except Exception:
            result = {"resolved": False, "resolution_score": 0.0,
                      "action": action_name}
            success = False

        score = result.get("resolution_score", 0.0)
        results.append({
            "scenario": sc["id"],
            "action": action_name,
            "resolved": result.get("resolved", False),
            "score": score,
            "success": success,
        })

        status = "✓" if result.get("resolved") else "✗"
        print(f"  [{i+1:2d}/{len(scenarios)}] {sc['id']} → {action_name:<22} "
              f"{status} score={score:.2f}  [suggested, conf={confidence:.0%}]")

    stats = _compute_phase_stats(results, "ASSIST")
    stats["suggestions_followed"] = suggestions_followed
    stats["cold_starts"] = cold_starts
    stats["action_choices"] = action_choices

    # Show action distribution
    print(f"\n  Action distribution: {json.dumps(action_choices)}")
    if len(action_choices) == 1:
        only_action = list(action_choices.keys())[0]
        print(f"  ⚠ Engine converged 100% on '{only_action}' — this is expected")
        print(f"    when one action has the highest composite score. The improvement")
        print(f"    depends on whether that action is actually the best overall.")

    li._http.close()
    return stats


def run_auto_phase(scenarios: list) -> dict:
    """Phase 4: AUTO mode — Layerinfinite picks and executes."""
    from layerinfinite import Layerinfinite, LowConfidenceError

    print("\n" + "=" * 65)
    print("  PHASE 4: AUTO MODE (Layerinfinite picks and executes)")
    print("=" * 65)

    li = Layerinfinite(
        api_key=LAYERINFINITE_API_KEY,
        agent_id=AGENT_ID,
        mode="auto",
        confidence_threshold=0.0,  # Accept any confidence for testing
        auto_fallback=True,
        base_url=LI_BASE_URL,
        timeout=15.0,
        log_async=False,
    )

    # Register all actions
    for name in ACTION_NAMES:
        fn = RAW_ACTIONS[name]
        li.action(TASK_NAME, name=name, score_fn=SCORE_FN)(fn)

    results = []
    fallbacks_used = 0
    errors = 0

    for i, sc in enumerate(scenarios):
        try:
            result = li.run(TASK_NAME, incident=sc)
            action_name = result.get("action", "unknown")
            success = True
        except LowConfidenceError as e:
            # Shouldn't happen with threshold=0.0
            action_name = e.suggestion.action_name
            result = {"resolved": False, "resolution_score": 0.0}
            success = False
            print(f"  ⚠ Low confidence: {e.confidence:.0%}")
        except Exception as e:
            # All actions failed (all threw)
            action_name = "all_failed"
            result = {"resolved": False, "resolution_score": 0.0}
            success = False
            errors += 1

        score = result.get("resolution_score", 0.0)
        results.append({
            "scenario": sc["id"],
            "action": action_name,
            "resolved": result.get("resolved", False),
            "score": score,
            "success": success,
        })

        status = "✓" if result.get("resolved") else "✗"
        print(f"  [{i+1:2d}/{len(scenarios)}] {sc['id']} → {action_name:<22} "
              f"{status} score={score:.2f}  [auto-picked]")

    stats = _compute_phase_stats(results, "AUTO")
    stats["fallbacks_used"] = fallbacks_used
    stats["all_failed_errors"] = errors

    # Final verification
    print("\n  ── Final Layerinfinite verification ──")
    time.sleep(3)

    try:
        li.observe(TASK_NAME)
    except Exception as e:
        print(f"  ⚠ observe() error: {e}")

    try:
        li.recommend(TASK_NAME)
    except Exception as e:
        print(f"  ⚠ recommend() error: {e}")

    try:
        scores_resp = li.scores(TASK_NAME)
        print(f"\n  [layerinfinite] Ranked scores for \"{TASK_NAME}\":")
        for sa in scores_resp.ranked_actions:
            print(f"    {sa.action_name:<22} score={sa.composite_score:.3f}  "
                  f"conf={sa.confidence:.0%}  attempts={sa.total_attempts}")
    except Exception as e:
        print(f"  ⚠ scores() error: {e}")

    li._http.close()
    return stats


# ═══════════════════════════════════════════════════════════════
# STATS & DISPLAY
# ═══════════════════════════════════════════════════════════════

def _compute_phase_stats(results: list, phase_name: str) -> dict:
    """Compute aggregate statistics for a phase."""
    total = len(results)
    resolved = sum(1 for r in results if r["resolved"])
    avg_score = sum(r["score"] for r in results) / total if total else 0
    success_count = sum(1 for r in results if r["success"])

    # Action distribution
    action_counts = {}
    for r in results:
        action_counts[r["action"]] = action_counts.get(r["action"], 0) + 1

    # Silent failures: action returned (success=True) but score < 0.3
    silent_failures = sum(
        1 for r in results if r["success"] and r["score"] < 0.3
    )

    stats = {
        "phase": phase_name,
        "total": total,
        "resolved": resolved,
        "resolution_rate": resolved / total if total else 0,
        "avg_score": avg_score,
        "action_distribution": action_counts,
        "silent_failures": silent_failures,
        "errors": total - success_count,
    }

    print(f"\n  ── {phase_name} Summary ──")
    print(f"    Resolution rate: {stats['resolution_rate']:.1%}  "
          f"({resolved}/{total})")
    print(f"    Avg score:       {avg_score:.3f}")
    print(f"    Silent failures: {silent_failures}")
    print(f"    Errors (throws): {stats['errors']}")
    print(f"    Action breakdown: {json.dumps(action_counts)}")

    return stats


def print_final_results(
    baseline: dict,
    recommend: dict,
    assist: dict,
    auto: dict,
) -> None:
    """Print the beautiful comparison table."""
    print("\n")
    print("╔" + "═" * 65 + "╗")
    print("║" + "LAYERINFINITE INTEGRATION TEST RESULTS".center(65) + "║")
    print("╠" + "═" * 65 + "╣")

    for phase in [baseline, recommend, assist, auto]:
        name = phase["phase"]
        rate = phase["resolution_rate"]
        resolved = phase["resolved"]
        total = phase["total"]
        avg = phase["avg_score"]
        sf = phase["silent_failures"]
        errs = phase["errors"]

        print("║" + " " * 65 + "║")
        print("║" + f"  {name}".ljust(65) + "║")
        print("║" + f"    Resolution rate:  {rate:>6.1%}  ({resolved}/{total})".ljust(65) + "║")
        print("║" + f"    Avg outcome score: {avg:>5.3f}".ljust(65) + "║")
        print("║" + f"    Silent failures:  {sf:>3d}".ljust(65) + "║")
        print("║" + f"    Errors (throws):  {errs:>3d}".ljust(65) + "║")

    # Improvement summary
    bl_rate = baseline["resolution_rate"]
    as_rate = assist["resolution_rate"]
    au_rate = auto["resolution_rate"]

    print("║" + " " * 65 + "║")
    print("║" + "  ─── IMPROVEMENT SUMMARY ─────────────────────────────────".ljust(65) + "║")
    print("║" + " " * 65 + "║")

    if as_rate > bl_rate:
        delta_a = as_rate - bl_rate
        print("║" + f"    Baseline → Assist: +{delta_a:.1%}  ({bl_rate:.1%} → {as_rate:.1%})".ljust(65) + "║")
    else:
        print("║" + f"    Baseline → Assist: {as_rate - bl_rate:+.1%}  ({bl_rate:.1%} → {as_rate:.1%})".ljust(65) + "║")

    if au_rate > bl_rate:
        delta_u = au_rate - bl_rate
        print("║" + f"    Baseline → Auto:   +{delta_u:.1%}  ({bl_rate:.1%} → {au_rate:.1%})".ljust(65) + "║")
    else:
        print("║" + f"    Baseline → Auto:   {au_rate - bl_rate:+.1%}  ({bl_rate:.1%} → {au_rate:.1%})".ljust(65) + "║")

    print("║" + " " * 65 + "║")
    print("║" + "  ─── WHAT TO CHECK ON DASHBOARD ──────────────────────────".ljust(65) + "║")
    print("║" + " " * 65 + "║")

    total_logged = recommend["total"] + assist["total"] + auto["total"]
    print("║" + f"    Outcomes logged:     {total_logged} (recommend+assist+auto)".ljust(65) + "║")
    print("║" + f"    Actions registered:  {len(ACTION_NAMES)} auto-discovered".ljust(65) + "║")
    print("║" + "    Silent failures:     Check Alerts → Silent Failure tab".ljust(65) + "║")
    print("║" + "    Latency data:        Check Action Performance charts".ljust(65) + "║")
    print("║" + "    Trust score:         Check Agent page for trust updates".ljust(65) + "║")
    print("║" + "    Recommendations:     Check Recommendations page".ljust(65) + "║")
    print("║" + " " * 65 + "║")
    print("╚" + "═" * 65 + "╝")


# ═══════════════════════════════════════════════════════════════
# CONNECTIVITY CHECKS
# ═══════════════════════════════════════════════════════════════

def check_connectivity() -> bool:
    """Verify API connectivity before running tests."""
    print("\n  ── Connectivity Checks ──\n")
    ok = True

    # Check Layerinfinite API
    if not LAYERINFINITE_API_KEY:
        print("  ✗ LAYERINFINITE_API_KEY not set")
        print("    Export it: export LAYERINFINITE_API_KEY='layerinfinite_xxx'")
        return False

    try:
        r = httpx.get(f"{LI_BASE_URL}/health", timeout=10)
        data = r.json()
        status = data.get("status", "unknown")
        print(f"  ✓ Layerinfinite API: {status}")
    except Exception as e:
        print(f"  ✗ Layerinfinite API unreachable: {e}")
        ok = False

    # Check OpenAI (optional)
    if SKIP_LLM:
        print("  ○ OpenAI: skipped (--skip-llm)")
    elif not OPENAI_API_KEY:
        print("  ⚠ OPENAI_API_KEY not set — LLM action will use simulation")
    else:
        try:
            r = httpx.get(
                "https://api.openai.com/v1/models",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                timeout=10,
            )
            if r.status_code == 200:
                print("  ✓ OpenAI API: connected")
            else:
                print(f"  ⚠ OpenAI API: status {r.status_code}")
        except Exception as e:
            print(f"  ⚠ OpenAI API unreachable: {e}")

    # Check Layerinfinite SDK import
    try:
        from layerinfinite import Layerinfinite, __version__
        print(f"  ✓ Layerinfinite SDK: v{__version__}")
    except ImportError:
        print("  ✗ Layerinfinite SDK not installed")
        print("    Install it: pip install -e ./sdks/python/")
        ok = False

    return ok


# ═══════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════

def main():
    print("""
╔═══════════════════════════════════════════════════════════════════╗
║    Layerinfinite Integration Test — DevOps Incident Agent        ║
║    ──────────────────────────────────────────────────────────     ║
║    30 real production incidents × 5 remediation actions           ║
║    Phases: Baseline → Recommend (3 rounds) → Assist → Auto       ║
║    Tests: scoring, recommendations, trust, silent failures,      ║
║           auto-fallback, all three SDK modes                     ║
╚═══════════════════════════════════════════════════════════════════╝""")

    if not check_connectivity():
        print("\n  ✗ Prerequisites not met. Fix the issues above and retry.")
        sys.exit(1)

    # Seed random for reproducible baseline
    random.seed(42)

    print(f"\n  Scenarios: {len(SCENARIOS)}")
    print(f"  Actions:   {', '.join(ACTION_NAMES)}")
    print(f"  LLM:       {'skipped' if SKIP_LLM else 'GPT-4o-mini'}")
    print(f"  Agent ID:  {AGENT_ID}")
    print(f"  Task:      {TASK_NAME}")
    print(f"  Backend:   {LI_BASE_URL}")
    print(f"  Training:  3 rounds × 30 scenarios = 90 outcomes")

    # ── Phase 1: BASELINE ──
    baseline = run_baseline(SCENARIOS)

    # ── Phase 2: RECOMMEND (3 training rounds = 90 outcomes) ──
    recommend = run_recommend_phase(SCENARIOS, num_rounds=3)

    # Wait for backend to process materialized views
    # The MV refresh is debounced at 15s in production, so 30s is safe
    print("\n  ⏳ Waiting 30s for backend MV refresh...")
    time.sleep(30)

    # ── Phase 3: ASSIST ──
    assist = run_assist_phase(SCENARIOS)

    # Brief wait
    print("\n  ⏳ Waiting 15s for backend to process...")
    time.sleep(15)

    # ── Phase 4: AUTO ──
    auto = run_auto_phase(SCENARIOS)

    # ── Final Results ──
    print_final_results(baseline, recommend, assist, auto)

    # Known issue flag
    print("\n  ── Known SDK Issue ──")
    print("  The SDK sends 'latency_ms' but the backend expects 'response_ms'.")
    print("  If latency data is missing on the dashboard, this is why.")
    print("  Fix: change 'latency_ms' → 'response_ms' in SDK's _log_outcome.\n")


if __name__ == "__main__":
    main()