"""
SupportBot — AI-powered customer support triage agent.

This agent handles incoming support tickets by classifying them and dispatching
the best remediation action. It integrates with Layerinfinite to learn from
outcomes and continuously improve action selection over time.

Modes:
  baseline   — OpenAI picks every action, nothing logged to Layerinfinite.
  recommend  — OpenAI acts, Layerinfinite logs outcomes and surfaces recommendations.
  assist     — Layerinfinite suggests the best action; OpenAI is the fallback.
  auto       — Layerinfinite drives action selection and execution end-to-end.
"""

import os
import random
import sys
import time

from pathlib import Path

import openai

# ---------------------------------------------------------------------------
# Layerinfinite SDK import
# Supports both: `pip install layerinfinite` and running directly from repo.
# ---------------------------------------------------------------------------
try:
    from layerinfinite import Layerinfinite, LogOutcomeRequest
    from layerinfinite.exceptions import LowConfidenceError
except ImportError:
    _LOCAL_SDK = Path(__file__).resolve().parent / "layer5" / "sdks" / "python"
    if _LOCAL_SDK.exists():
        sys.path.insert(0, str(_LOCAL_SDK))
    from layerinfinite import Layerinfinite, LogOutcomeRequest
    from layerinfinite.exceptions import LowConfidenceError

# ---------------------------------------------------------------------------
# Configuration — set via env vars or replace the defaults below.
# ---------------------------------------------------------------------------
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "your_openai_key")
LI_API_KEY     = os.getenv("LI_API_KEY",     "layerinfinite_7c06c8cbd6b0ad726decc5d4fc63214a")
LI_AGENT_ID    = os.getenv("LI_AGENT_ID",    "chatgpt")
LI_BASE_URL    = os.getenv("LI_BASE_URL",    "https://api.layerinfinite.app")

openai.api_key = OPENAI_API_KEY

# ---------------------------------------------------------------------------
# Agent domain — tickets the bot handles and the actions available per ticket.
# Success probabilities reflect real-world action effectiveness.
# ---------------------------------------------------------------------------
TICKET_TYPES = {
    "payment_failed": {
        "switch_provider":  0.82,
        "retry_request":    0.51,
        "notify_user":      0.30,
        "escalate_issue":   0.25,
        "fallback_cache":   0.10,
    },
    "api_timeout": {
        "retry_request":    0.73,
        "fallback_cache":   0.62,
        "switch_provider":  0.40,
        "notify_user":      0.20,
        "escalate_issue":   0.15,
    },
    "user_not_responding": {
        "notify_user":      0.78,
        "escalate_issue":   0.42,
        "retry_request":    0.20,
        "switch_provider":  0.10,
        "fallback_cache":   0.08,
    },
}

ALL_ACTIONS = list({a for rates in TICKET_TYPES.values() for a in rates})

# ---------------------------------------------------------------------------
# Test plan — each (mode, n_tickets) pair runs in sequence.
# ---------------------------------------------------------------------------
TEST_PLAN = [
    ("baseline",  200),
    ("recommend", 200),
    ("observe",     0),   # observe phase — no tickets, just LI stats
    ("assist",    100),
    ("auto",      100),
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def normalize_action(raw: object) -> str | None:
    """Map a raw string to a known action name, or return None."""
    if not isinstance(raw, str):
        return None
    candidate = raw.strip().lower().replace("-", "_").replace(" ", "_")
    if candidate in ALL_ACTIONS:
        return candidate
    for action in ALL_ACTIONS:
        if action in candidate:
            return action
    return None


def call_openai(ticket_type: str) -> str:
    """Ask OpenAI to pick the best action for this ticket type."""
    prompt = (
        f"You are a support triage agent. A '{ticket_type}' ticket just came in.\n"
        f"Choose the single best remediation action from this list: {ALL_ACTIONS}.\n"
        "Reply with only the action name — nothing else."
    )
    try:
        resp = openai.ChatCompletion.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
        )
        content = resp["choices"][0]["message"]["content"].strip()
    except Exception:
        if hasattr(openai, "OpenAI"):
            client = openai.OpenAI(api_key=OPENAI_API_KEY)
            resp = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
            )
            content = (resp.choices[0].message.content or "").strip()
        else:
            raise

    action = normalize_action(content)
    if action:
        return action
    raise RuntimeError(f"OpenAI returned an unrecognised action: '{content}'")


def simulate_action(ticket_type: str, action: str) -> tuple[bool, float]:
    """
    Simulate executing an action against a ticket.
    Returns (success, outcome_score).
    """
    rate = TICKET_TYPES.get(ticket_type, {}).get(action, 0.25)
    success = random.random() < rate
    score   = rate if success else random.uniform(0.05, 0.35)
    return success, round(score, 4)


# ---------------------------------------------------------------------------
# Layerinfinite client factory
# ---------------------------------------------------------------------------

def build_li(mode: str) -> Layerinfinite:
    """
    Create a Layerinfinite client for the given mode.
    Fix 1: min_observations_per_action=20 — forces LI to try every action at
            least 20 times before exploiting the top scorer (exploration floor).
    Fix 4: auto_graduate=True — LI auto-switches mode as trust_status improves.
    """
    return Layerinfinite(
        api_key=LI_API_KEY,
        agent_id=LI_AGENT_ID,
        mode=mode,
        base_url=LI_BASE_URL,
        timeout=10.0,
        max_retries=3,
        auto_fallback=True,
        confidence_threshold=0.35,          # lower threshold — unlock payment_failed
        min_observations_per_action=20,     # Fix 1: exploration floor
        auto_graduate=(mode != "baseline"), # Fix 4: auto-graduation for non-baseline modes
    )


def register_actions(li: Layerinfinite) -> None:
    """
    Register every ticket→action pair with the Layerinfinite decorator.
    In a real agent these would be your actual handler functions.
    The decorator auto-logs success/failure/latency on every call.
    """
    for ticket_type in TICKET_TYPES:
        for action_name in ALL_ACTIONS:
            # Closure captures the specific ticket_type + action_name.
            def _make_handler(t: str, a: str):
                @li.action(t, name=a)
                def handler():
                    success, score = simulate_action(t, a)
                    if not success:
                        raise RuntimeError(f"action_failed score={score:.3f}")
                    return {"action": a, "score": score}
                return handler

            _make_handler(ticket_type, action_name)


# ---------------------------------------------------------------------------
# Per-mode dispatch logic
# ---------------------------------------------------------------------------

def dispatch_baseline(ticket_type: str) -> tuple[str, bool, float, str]:
    """Baseline: OpenAI decides, nothing touches Layerinfinite."""
    action = call_openai(ticket_type)
    success, score = simulate_action(ticket_type, action)
    return action, success, score, "openai"


def dispatch_recommend(li: Layerinfinite, ticket_type: str) -> tuple[str, bool, float, str]:
    """
    Recommend mode:
      1. Ask LI for the top-scored action (POST /v1/get-scores).
      2. Fall back to li.recommend() (GET /v1/recommendations) if scores unavailable.
      3. Fall back to OpenAI if LI has no data yet.
      4. Execute the action, then log the outcome to LI.
    """
    source = "openai_fallback"
    action = None

    scores = li.scores(ticket_type)
    top = getattr(scores, "top_action", None)
    if top and normalize_action(getattr(top, "action_name", None)):
        action = normalize_action(top.action_name)
        source = "li_scores"

    if not action:
        rec = li.recommend(ticket_type)
        action = normalize_action(getattr(rec, "recommendation", None))
        if action:
            source = "li_recommend"

    if not action:
        action = call_openai(ticket_type)
        source = "openai_fallback"

    success, score = simulate_action(ticket_type, action)

    # Log outcome so LI learns from this decision.
    li.log_outcome(LogOutcomeRequest(
        agent_id=LI_AGENT_ID,
        action_name=action,
        issue_type=ticket_type,
        success=success,
        outcome_score=score,
    ))

    return action, success, score, source


def dispatch_assist(li: Layerinfinite, ticket_type: str) -> tuple[str, bool, float, str]:
    """
    Assist mode:
      1. LI suggests the best action (POST /v1/get-scores via li.suggest()).
      2. Fall back to OpenAI if LI isn't confident yet.
      3. Execute and log outcome.
    """
    source = "openai_fallback"
    action = None

    try:
        suggestion = li.suggest(ticket_type)
        action = normalize_action(getattr(suggestion, "action_name", None))
        if action:
            source = "li_suggest"
    except Exception:
        pass

    if not action:
        action = call_openai(ticket_type)
        source = "openai_fallback"

    success, score = simulate_action(ticket_type, action)

    li.log_outcome(LogOutcomeRequest(
        agent_id=LI_AGENT_ID,
        action_name=action,
        issue_type=ticket_type,
        success=success,
        outcome_score=score,
    ))

    return action, success, score, source


def dispatch_auto(li: Layerinfinite, ticket_type: str) -> tuple[str, bool, float, str]:
    """
    Auto mode:
      LI picks, executes, and logs the outcome autonomously via li.run().
      Fix 3: LowConfidenceError is caught explicitly — best candidate from LI
             is used as OpenAI fallback and outcome is logged back so LI learns.
    """
    try:
        result = li.run(ticket_type)
        action = normalize_action(
            result.get("action") if isinstance(result, dict) else None
        ) or "li_auto"
        score = float(result.get("score", 1.0)) if isinstance(result, dict) else 1.0
        return action, True, score, "li_auto"

    except LowConfidenceError as exc:
        # Fix 3: LI abstained — use its best candidate as the OpenAI fallback seed,
        # then log the outcome back so LI learns from this edge case too.
        candidate = normalize_action(getattr(exc.suggestion, "action_name", None))
        action = candidate or call_openai(ticket_type)
        source = "li_abstained" if candidate else "openai_fallback"
        success, score = simulate_action(ticket_type, action)
        li.log_outcome(LogOutcomeRequest(
            agent_id=LI_AGENT_ID,
            action_name=action,
            issue_type=ticket_type,
            success=success,
            outcome_score=score,
        ))
        return action, success, score, source

    except Exception as exc:
        return "auto_error", False, 0.0, f"li_error({type(exc).__name__})"


# ---------------------------------------------------------------------------
# Observe phase — pull LI stats for all tasks after recommend warmup
# ---------------------------------------------------------------------------

def run_observe() -> None:
    print(f"\n{'='*60}")
    print(f"  OBSERVE PHASE — LI learned state after recommend warmup")
    print(f"{'='*60}")
    li = build_li("recommend")
    for task in TICKET_TYPES:
        obs = li.observe(task)
        print(f"\n  Task: {task}")
        print(f"    Total runs logged : {obs.total_runs}")
        print(f"    LI success rate   : {obs.success_rate:.1%}")
        print(f"    Actions seen      : {', '.join(obs.actions_seen) if obs.actions_seen else 'none'}")
        print(f"    Best performing   : {obs.best_performing or 'n/a'}")
        print(f"    Worst performing  : {obs.worst_performing or 'n/a'}")
        print(f"    Last run          : {obs.last_run or 'n/a'}")


# ---------------------------------------------------------------------------
# Main runner
# ---------------------------------------------------------------------------

def run_mode(mode: str, n_tickets: int) -> list[dict]:
    print(f"\n{'='*60}")
    print(f"  SupportBot — mode: {mode.upper()}  ({n_tickets} tickets)")
    print(f"{'='*60}")

    li = None
    if mode != "baseline":
        li = build_li(mode)
        # Pre-register ALL actions upfront so API never sees unknown action names
        register_actions(li)

    records = []
    for i in range(n_tickets):
        ticket_type = random.choice(list(TICKET_TYPES.keys()))

        if mode == "baseline":
            action, success, score, source = dispatch_baseline(ticket_type)
        elif mode == "recommend":
            action, success, score, source = dispatch_recommend(li, ticket_type)
        elif mode == "assist":
            action, success, score, source = dispatch_assist(li, ticket_type)
        else:
            action, success, score, source = dispatch_auto(li, ticket_type)

        status = "OK " if success else "ERR"
        print(f"  [{i+1:>3}] {status} | {ticket_type:<22} | {action:<20} | score={score:.3f} | via={source}")

        records.append({
            "ticket_type": ticket_type,
            "action":      action,
            "success":     success,
            "score":       score,
            "source":      source,
        })

        time.sleep(0.3)

    return records


# ---------------------------------------------------------------------------
# Summary + comparison
# ---------------------------------------------------------------------------

def print_full_summary(all_results: list[tuple[str, list[dict]]], prev: dict) -> None:
    print(f"\n{'='*68}")
    print(f"  FULL RESULTS SUMMARY")
    print(f"{'='*68}")
    print(f"  {'Mode':<12} {'Tickets':>7} {'Success%':>9} {'AvgScore':>9}  {'vs Baseline':>11}  {'vs Prev Run':>11}")
    print(f"  {'-'*64}")

    baseline_rate = None
    for mode, records in all_results:
        if not records:
            continue
        total     = len(records)
        ok        = sum(1 for r in records if r["success"])
        rate      = ok / total
        avg_score = sum(r["score"] for r in records) / total
        abstains  = sum(1 for r in records if r["action"] == "auto_failed")

        if baseline_rate is None:
            baseline_rate = rate

        vs_base = f"+{(rate - baseline_rate)*100:.1f}%" if mode != "baseline" else "—"
        vs_prev = f"+{(rate - prev.get(mode, rate))*100:.1f}%" if mode in prev else "—"

        abstain_note = f" ({abstains} abstains)" if abstains else ""
        print(f"  {mode:<12} {total:>7} {rate:>9.1%} {avg_score:>9.3f}  {vs_base:>11}  {vs_prev:>11}{abstain_note}")

    print(f"\n  {'-'*64}")
    print(f"  PER TICKET TYPE BREAKDOWN")
    print(f"  {'-'*64}")

    for mode, records in all_results:
        if not records:
            continue
        tickets = {}
        for r in records:
            t = r["ticket_type"]
            tickets.setdefault(t, {"ok": 0, "total": 0, "scores": []})
            tickets[t]["total"] += 1
            tickets[t]["scores"].append(r["score"])
            if r["success"]:
                tickets[t]["ok"] += 1

        print(f"\n  {mode.upper()}:")
        for t, d in sorted(tickets.items()):
            avg_s = sum(d["scores"]) / len(d["scores"])
            prev_rate = prev.get(f"{mode}_{t}", None)
            delta = f"  vs prev: +{(d['ok']/d['total'] - prev_rate)*100:.1f}%" if prev_rate is not None else ""
            print(f"    {t:<25} {d['ok']:>3}/{d['total']:<3} = {d['ok']/d['total']:.1%}  avg={avg_s:.3f}{delta}")

    print(f"\n  {'-'*64}")
    print(f"  DECISION SOURCE BREAKDOWN (LI vs OpenAI)")
    print(f"  {'-'*64}")
    for mode, records in all_results:
        if not records or mode == "baseline":
            continue
        sources = {}
        for r in records:
            src = r["source"].split("(")[0]  # strip error details
            sources.setdefault(src, {"ok": 0, "total": 0})
            sources[src]["total"] += 1
            if r["success"]:
                sources[src]["ok"] += 1
        print(f"\n  {mode.upper()}:")
        for src, d in sorted(sources.items(), key=lambda x: -x[1]["total"]):
            print(f"    {src:<25} {d['ok']:>3}/{d['total']:<3} = {d['ok']/d['total']:.1%}")

    print(f"\n{'='*68}\n")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    random.seed(42)

    # Previous run results for comparison (run 1: 50/100/100/100)
    PREV_RUN = {
        "baseline":              0.720,
        "recommend":             0.630,
        "assist":                0.690,
        "auto":                  0.630,
        "baseline_payment_failed":        0.357,
        "baseline_api_timeout":           0.737,
        "baseline_user_not_responding":   1.000,
        "recommend_payment_failed":       0.432,
        "recommend_api_timeout":          0.750,
        "recommend_user_not_responding":  0.744,
        "assist_payment_failed":          0.500,
        "assist_api_timeout":             0.828,
        "assist_user_not_responding":     0.757,
        "auto_payment_failed":            0.000,
        "auto_api_timeout":               1.000,
        "auto_user_not_responding":       0.846,
    }

    all_results = []
    for mode, n_tickets in TEST_PLAN:
        if mode == "observe":
            run_observe()
            continue
        records = run_mode(mode, n_tickets)
        all_results.append((mode, records))

    print_full_summary(all_results, PREV_RUN)
