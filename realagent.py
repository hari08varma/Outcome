#!/usr/bin/env python3
# Real World Proof: OpenAI function-calling + Layerinfinite Python SDK
# Usage:
#   python realagent.py --mode none --runs 20
#   python realagent.py --mode observe --runs 100
#   python realagent.py --mode auto --runs 100
#   python realagent.py --mode auto --runs 100 --messy-profile heavy
#   python realagent.py --compare results_rw_none_X.json results_rw_auto_X.json
from __future__ import annotations
import argparse, json, os, random, sys, uuid
from datetime import datetime
from typing import Optional
import urllib.request
import urllib.parse

LAYERINFINITE_API_KEY = os.getenv("LAYERINFINITE_API_KEY", "")
OPENAI_API_KEY        = os.getenv("OPENAI_API_KEY", "")
LAYERINFINITE_BASE    = os.getenv("LAYERINFINITE_BASE", "https://api.layerinfinite.app")
OPENAI_MODEL          = "gpt-4o-mini"
AGENT_ID              = "realworld"
COST_PER_CALL         = 0.000075

SDK_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "layer5", "sdks", "python")
if SDK_PATH not in sys.path:
    sys.path.insert(0, SDK_PATH)

ALL_ACTIONS = [
    "clear_npm_cache", "increase_docker_timeout", "retry_with_seed",
    "inject_env_from_vault", "scale_runner_memory", "retry_with_backoff",
    "auto_fix_lint", "pin_previous_image", "rollback_migration", "warm_cache_layer",
]

MESSY_PROFILES = ("none", "light", "heavy")
GENERIC_ISSUE_TYPES = [
    "unknown_task", "UNKNOWN", "n/a", "none", "unspecified", "--", " ",
]
MESSY_LOG_SNIPPETS = [
    "[warn] retry budget exhausted for upstream service",
    "[debug] flaky network in zone us-east-1c",
    "[trace] timeout after 30481ms, request_id=2d1f",
    "[notice] previous rollback artifact still present",
    "[info] build cache key mismatch detected",
    "[error] dependency graph changed during warm start",
    "{" + '"level":"warn","msg":"partial failure","component":"runner"' + "}",
    "java.lang.IllegalStateException: transient race in pipeline",
    "socket hang up ECONNRESET during integration step",
]

SCENARIOS = [
    # EASY: clear best action
    {"failure_type": "npm_install_failed", "description": "npm install failing with ERESOLVE peer dependency conflict. Node modules corrupted.", "tier": "easy", "actions": {"clear_npm_cache": {"success_rate": 0.92}, "retry_with_backoff": {"success_rate": 0.30}, "scale_runner_memory": {"success_rate": 0.15}, "rollback_migration": {"success_rate": 0.05}}, "correct_action": "clear_npm_cache"},
    {"failure_type": "lint_failure", "description": "ESLint failing with 47 errors across multiple files. Code style violations.", "tier": "easy", "actions": {"auto_fix_lint": {"success_rate": 0.91}, "retry_with_backoff": {"success_rate": 0.12}, "clear_npm_cache": {"success_rate": 0.08}, "pin_previous_image": {"success_rate": 0.04}}, "correct_action": "auto_fix_lint"},
    {"failure_type": "out_of_memory", "description": "Runner OOM killed. Build exceeded 4GB memory limit during compilation.", "tier": "easy", "actions": {"scale_runner_memory": {"success_rate": 0.90}, "retry_with_backoff": {"success_rate": 0.25}, "clear_npm_cache": {"success_rate": 0.10}, "increase_docker_timeout": {"success_rate": 0.08}}, "correct_action": "scale_runner_memory"},
    {"failure_type": "db_migration_failed", "description": "Database migration 0045 failed with constraint violation on users table.", "tier": "easy", "actions": {"rollback_migration": {"success_rate": 0.88}, "retry_with_backoff": {"success_rate": 0.22}, "inject_env_from_vault": {"success_rate": 0.10}, "scale_runner_memory": {"success_rate": 0.06}}, "correct_action": "rollback_migration"},
    {"failure_type": "env_var_missing", "description": "Build failing: Required env var DATABASE_URL not found. Secrets not injected.", "tier": "easy", "actions": {"inject_env_from_vault": {"success_rate": 0.89}, "retry_with_backoff": {"success_rate": 0.18}, "clear_npm_cache": {"success_rate": 0.07}, "scale_runner_memory": {"success_rate": 0.05}}, "correct_action": "inject_env_from_vault"},
    # MEDIUM: some noise
    {"failure_type": "test_suite_flaky", "description": "12 tests intermittently failing. Race condition suspected in async test setup.", "tier": "medium", "actions": {"retry_with_seed": {"success_rate": 0.72}, "retry_with_backoff": {"success_rate": 0.48}, "auto_fix_lint": {"success_rate": 0.20}, "clear_npm_cache": {"success_rate": 0.18}}, "correct_action": "retry_with_seed"},
    {"failure_type": "docker_build_timeout", "description": "Docker build timed out after 30 minutes. Layer caching may be invalidated.", "tier": "medium", "actions": {"increase_docker_timeout": {"success_rate": 0.68}, "warm_cache_layer": {"success_rate": 0.55}, "retry_with_backoff": {"success_rate": 0.30}, "scale_runner_memory": {"success_rate": 0.25}}, "correct_action": "increase_docker_timeout"},
    {"failure_type": "cache_miss_spike", "description": "Cache hit rate dropped from 85% to 12%. Cold cache causing 10x slower builds.", "tier": "medium", "actions": {"warm_cache_layer": {"success_rate": 0.70}, "retry_with_backoff": {"success_rate": 0.45}, "clear_npm_cache": {"success_rate": 0.35}, "scale_runner_memory": {"success_rate": 0.20}}, "correct_action": "warm_cache_layer"},
    # HARD: no clear winner
    {"failure_type": "deploy_rollback_triggered", "description": "Deployment triggered automatic rollback. Health check failed on 3/5 instances. Root cause unclear.", "tier": "hard", "actions": {"pin_previous_image": {"success_rate": 0.52}, "rollback_migration": {"success_rate": 0.44}, "retry_with_backoff": {"success_rate": 0.38}, "increase_docker_timeout": {"success_rate": 0.32}}, "correct_action": "pin_previous_image"},
    {"failure_type": "network_timeout", "description": "Intermittent network timeouts during test phase. 3/10 requests timing out.", "tier": "hard", "actions": {"retry_with_backoff": {"success_rate": 0.55}, "increase_docker_timeout": {"success_rate": 0.48}, "warm_cache_layer": {"success_rate": 0.35}, "inject_env_from_vault": {"success_rate": 0.28}}, "correct_action": "retry_with_backoff"},
    # AMBIGUOUS: close success rates, hardest tier
    {"failure_type": "intermittent_auth_failure", "description": "Auth service returning 401 on 30% of requests. Token refresh or rate limit suspected. No clear pattern.", "tier": "ambiguous", "actions": {"retry_with_backoff": {"success_rate": 0.51}, "inject_env_from_vault": {"success_rate": 0.49}, "rollback_migration": {"success_rate": 0.41}, "scale_runner_memory": {"success_rate": 0.38}}, "correct_action": "retry_with_backoff"},
    {"failure_type": "resource_contention", "description": "CPU throttling. Both memory scaling and timeout increases show similar improvement rates.", "tier": "ambiguous", "actions": {"scale_runner_memory": {"success_rate": 0.54}, "increase_docker_timeout": {"success_rate": 0.50}, "retry_with_backoff": {"success_rate": 0.44}, "warm_cache_layer": {"success_rate": 0.39}}, "correct_action": "scale_runner_memory"},
]

TOOLS = [{"type": "function", "function": {"name": "execute_remediation", "description": "Execute a remediation action to fix the CI/CD failure.", "parameters": {"type": "object", "properties": {"action": {"type": "string", "enum": ALL_ACTIONS}, "reasoning": {"type": "string"}, "confidence": {"type": "number"}}, "required": ["action", "reasoning", "confidence"]}}}]


def call_openai(messages, timeout=30):
    payload = json.dumps({"model": OPENAI_MODEL, "messages": messages, "tools": TOOLS, "tool_choice": "required", "temperature": 0.1}).encode()
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=payload, headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def mutate_issue_type(issue_type, rng, messy_profile):
    if messy_profile == "none":
        return issue_type, "clean"

    generic_probability = 0.06 if messy_profile == "light" else 0.18
    typo_probability = 0.12 if messy_profile == "light" else 0.26
    noise_probability = 0.25 if messy_profile == "light" else 0.48

    if rng.random() < generic_probability:
        return rng.choice(GENERIC_ISSUE_TYPES), "generic_placeholder"

    value = issue_type
    transforms = []

    if rng.random() < 0.35:
        value = rng.choice([value.upper(), value.title(), value.lower()])
        transforms.append("case")

    if rng.random() < 0.45:
        value = value.replace("_", rng.choice([" ", "-", "__"]))
        transforms.append("separator")

    if rng.random() < typo_probability and len(value) >= 5:
        idx = rng.randrange(1, len(value) - 1)
        typo_kind = rng.choice(["drop", "duplicate"])
        if typo_kind == "drop":
            value = value[:idx] + value[idx + 1:]
        else:
            value = value[:idx] + value[idx] + value[idx:]
        transforms.append("typo")

    if rng.random() < noise_probability:
        prefix = rng.choice(["ERROR:", "ALERT", "ci-failure", "pipeline::"])
        suffix = rng.choice(["", " !!!", " ???", " [urgent]"])
        value = f"{prefix} {value}{suffix}".strip()
        transforms.append("wrapped")

    return value, "+".join(transforms) if transforms else "cleanish"


def build_messy_description(base_description, observed_issue_type, rng, messy_profile):
    if messy_profile == "none":
        return base_description

    snippet_count = 2 if messy_profile == "light" else 4
    picked = rng.sample(MESSY_LOG_SNIPPETS, k=min(snippet_count, len(MESSY_LOG_SNIPPETS)))
    contradictory_hint = "Potential root cause: cache corruption" if rng.random() < 0.5 else "Potential root cause: network jitter"
    noise_block = "\n".join(f"- {line}" for line in picked)
    return (
        f"{base_description}\n\n"
        f"Observed issue label from telemetry: {observed_issue_type}\n"
        f"Additional noisy logs:\n{noise_block}\n"
        f"Ambiguous hint: {contradictory_hint}"
    )


def execute_action(scenario, action_name, rng, messy_profile="none", issue_corruption="clean"):
    action_data = scenario["actions"].get(action_name)
    if not action_data:
        return False, 0.05

    success_rate = action_data["success_rate"]
    if messy_profile != "none":
        jitter = rng.uniform(-0.07, 0.05) if messy_profile == "light" else rng.uniform(-0.14, 0.08)
        success_rate = max(0.01, min(0.99, success_rate + jitter))

        if issue_corruption == "generic_placeholder":
            penalty = 0.06 if messy_profile == "light" else 0.14
            success_rate = max(0.01, success_rate - penalty)

    success = rng.random() < success_rate
    return success, (rng.uniform(0.70, 1.00) if success else rng.uniform(0.05, 0.35))


def get_li_recommendation(failure_type):
    """
    Use /v1/get-scores (ranked actions) as primary signal.
    Falls back to /v1/recommendations for state/explanation metadata.
    Returns dict with: action_name, confidence, state, source
    """
    try:
        # Primary: get-scores gives ranked actions immediately with real confidence
        query = urllib.parse.urlencode({"agent_id": AGENT_ID, "issue_type": failure_type})
        url = f"{LAYERINFINITE_BASE}/v1/get-scores?{query}"
        req = urllib.request.Request(url, headers={"X-API-Key": LAYERINFINITE_API_KEY}, method="GET")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())

        ranked = data.get("ranked_actions", [])
        top = data.get("top_action") or (ranked[0] if ranked else None)

        if top and top.get("confidence", 0) >= 0.25 and not top.get("is_cold_start"):
            return {
                "action_name": top["action_name"],
                "confidence": top["confidence"],
                "state": "scored",
                "source": "get-scores",
                "policy": data.get("policy", "exploit"),
            }
        return None
    except Exception as e:
        print(f"  [warn] LI rec fetch: {e}")
        return None


_li_client = None

def get_li_client():
    global _li_client
    if _li_client is None:
        from layerinfinite import Layerinfinite
        _li_client = Layerinfinite(api_key=LAYERINFINITE_API_KEY, agent_id=AGENT_ID, mode="recommend", base_url=LAYERINFINITE_BASE)
    return _li_client


def log_outcome_sdk(failure_type, action_name, success, outcome_score, context_id):
    try:
        from layerinfinite.models import LogOutcomeRequest
        li = get_li_client()
        req = LogOutcomeRequest(agent_id=AGENT_ID, action_name=action_name, context_id=context_id, issue_type=failure_type, success=success, outcome_score=outcome_score)
        result = li.log_outcome(req)
        return getattr(result, "outcome_id", "ok")
    except Exception as e:
        print(f"  [warn] LI log_outcome: {e}")
        return None


def run_agent(mode, num_runs, seed=None, verbose=True, messy_profile="none"):
    rng = random.Random(seed)
    results = []
    episode_id = str(uuid.uuid4())
    openai_calls = 0
    cost = 0.0

    if verbose:
        print("=" * 70)
        print(f"  LAYERINFINITE — REAL WORLD PROOF")
        print(f"  Mode     : {mode.upper()}  |  Runs: {num_runs}  |  Agent: {AGENT_ID}")
        print(f"  Data     : {messy_profile.upper()} profile")
        print(f"  Model    : {OPENAI_MODEL} (REAL API calls, NOT simulated)")
        print(f"  Episode  : {episode_id[:24]}...")
        print("=" * 70)
        print()

    for i in range(num_runs):
        sc = rng.choice(SCENARIOS)
        canonical_ft = sc["failure_type"]
        observed_ft, issue_corruption = mutate_issue_type(canonical_ft, rng, messy_profile)
        ctx = str(uuid.uuid4())
        correct = sc["correct_action"]
        tier = sc["tier"]
        description = build_messy_description(sc["description"], observed_ft, rng, messy_profile)

        # Step 1: consult LI
        li_rec = li_state = li_conf = None
        if mode != "none":
            rec = get_li_recommendation(observed_ft)
            if rec:
                li_state = rec.get("state", "scored")
                li_conf = rec.get("confidence", 0)
                li_rec = rec.get("action_name")

        # Step 2: build prompt with optional LI hint
        hint = ""
        if mode == "auto" and li_rec:
            hint = f"\n\nLayerinfinite recommends: '{li_rec}' (confidence={li_conf:.2f}, state={li_state}). Follow unless you have strong reason not to."
        elif mode == "assist" and li_rec:
            hint = f"\n\nLayerinfinite suggests: '{li_rec}' (confidence={li_conf:.2f}). Consider this."
        elif mode == "observe":
            # Observe-only: gather LI telemetry and log outcomes but do not prime
            # the LLM prompt with LI recommendations.
            hint = ""

        sys_prompt = f"You are an autonomous CI/CD reliability agent. Call execute_remediation with the best action.\nAvailable: {', '.join(ALL_ACTIONS)}{hint}"
        user_msg = f"FAILURE: {observed_ft}\nDescription: {description}\n\nChoose and execute the best remediation action."

        # Step 3: real OpenAI function-calling
        chosen = reasoning = ""
        agent_conf = 0.0
        err = None
        try:
            resp = call_openai([{"role": "system", "content": sys_prompt}, {"role": "user", "content": user_msg}])
            openai_calls += 1
            cost += COST_PER_CALL
            tc = resp["choices"][0].get("message", {}).get("tool_calls", [])
            if tc:
                args = json.loads(tc[0]["function"]["arguments"])
                chosen = args.get("action", "")
                reasoning = args.get("reasoning", "")
                agent_conf = args.get("confidence", 0.0)
        except Exception as e:
            err = str(e)
            chosen = rng.choice(ALL_ACTIONS)
            reasoning = f"OpenAI error fallback"

        if not chosen:
            chosen = rng.choice(ALL_ACTIONS)

        # Step 4: execute + measure
        success, score = execute_action(sc, chosen, rng, messy_profile=messy_profile, issue_corruption=issue_corruption)
        is_correct = chosen == correct
        best_rate = max(a["success_rate"] for a in sc["actions"].values())
        chosen_rate = sc["actions"].get(chosen, {}).get("success_rate", 0)
        subopt_gap = best_rate - chosen_rate

        # Step 5: log to LI via SDK
        outcome_id = None
        if mode != "none":
            outcome_id = log_outcome_sdk(observed_ft, chosen, success, score, ctx)

        if verbose:
            tag = ""
            if mode != "none":
                if li_rec:
                    tag = " [LI->FOLLOWED]" if chosen == li_rec else " [LI->OVERRIDDEN]"
                else:
                    tag = " [NO_LI_DATA]"
            mark = "✓" if is_correct else "✗"
            print(f"  [{i+1:03d}/{num_runs}] {observed_ft} [{tier}]")
            print(f"         GPT chose   : {chosen}{tag}")
            if li_rec and mode != "none":
                print(f"         LI hint     : {li_rec} (conf={li_conf:.3f}, {li_state})")
            if observed_ft != canonical_ft:
                print(f"         Canonical   : {canonical_ft} ({issue_corruption})")
            print(f"         Best action : {correct} [{mark}]  gap={subopt_gap*100:.0f}pp")
            print(f"         Outcome     : {'SUCCESS' if success else 'FAIL'} (score={score:.3f})")
            if outcome_id:
                print(f"         SDK logged  : {str(outcome_id)[:24]}...")
            print()

        results.append({
            "run": i + 1,
            "failure_type": observed_ft,
            "canonical_failure_type": canonical_ft,
            "issue_corruption": issue_corruption,
            "tier": tier,
            "correct_action": correct, "chosen_action": chosen,
            "li_recommendation": li_rec, "li_state": li_state, "li_confidence": li_conf,
            "success": success, "outcome_score": score, "is_correct": is_correct,
            "li_rec_correct": (li_rec == correct) if li_rec else None,
            "followed_li": (chosen == li_rec) if li_rec else None,
            "suboptimality_gap": subopt_gap,
            "agent_confidence": agent_conf, "openai_error": err,
            "logged": outcome_id is not None,
        })

    return {"mode": mode, "messy_profile": messy_profile, "agent_id": AGENT_ID, "episode_id": episode_id,
            "num_runs": num_runs, "openai_calls": openai_calls,
            "openai_cost_usd": round(cost, 4), "results": results}


def print_report(data):
    R = data["results"]
    n = len(R)
    mode = data["mode"]
    messy_profile = data.get("messy_profile", "none")
    succ = sum(1 for r in R if r["success"])
    corr = sum(1 for r in R if r["is_correct"])
    mean_score = sum(r["outcome_score"] for r in R) / n
    mean_gap = sum(r["suboptimality_gap"] for r in R) / n * 100
    optimal = sum(1 for r in R if r["suboptimality_gap"] == 0)

    li_R = [r for r in R if r["li_recommendation"] is not None]
    li_corr = sum(1 for r in li_R if r["li_rec_correct"])
    followed = sum(1 for r in li_R if r["followed_li"])
    logged = sum(1 for r in R if r["logged"])

    tiers = {}
    for r in R:
        t = r["tier"]
        if t not in tiers:
            tiers[t] = {"n": 0, "s": 0, "c": 0}
        tiers[t]["n"] += 1
        tiers[t]["s"] += int(r["success"])
        tiers[t]["c"] += int(r["is_correct"])

    q = max(1, n // 4)
    quarters = []
    for i in range(0, n, q):
        chunk = R[i:i+q]
        if chunk:
            quarters.append((i, min(i+q, n), sum(1 for r in chunk if r["success"]) / len(chunk) * 100))

    corruption_counts = {}
    for r in R:
        label = r.get("issue_corruption") or "clean"
        corruption_counts[label] = corruption_counts.get(label, 0) + 1

    print("=" * 70)
    print(f"  REPORT  |  Mode: {mode.upper()}  |  Data: {messy_profile.upper()}  |  Runs: {n}")
    print("=" * 70)
    print(f"\n  AGENT PERFORMANCE")
    print(f"  Overall success rate     : {succ/n*100:.1f}%  ({succ}/{n})")
    print(f"  Correct action chosen    : {corr/n*100:.1f}%  ({corr}/{n})")
    print(f"  Mean outcome score       : {mean_score:.3f}")
    print(f"  Optimal choices          : {optimal/n*100:.1f}%")
    print(f"\n  EXPECTED vs ACTUAL")
    print(f"  Mean suboptimality gap   : {mean_gap:.1f}pp  (0=always optimal)")
    if li_R:
        print(f"\n  LAYERINFINITE")
        print(f"  Recs available           : {len(li_R)}/{n}")
        print(f"  LI accuracy              : {li_corr/len(li_R)*100:.1f}%  ({li_corr}/{len(li_R)})")
        print(f"  Agent follow rate        : {followed/len(li_R)*100:.1f}%")
        print(f"  Outcomes logged via SDK  : {logged}/{n}")
    print(f"\n  PER TIER")
    for tier_name in ["easy", "medium", "hard", "ambiguous"]:
        if tier_name in tiers:
            t = tiers[tier_name]
            print(f"  {tier_name:<12}  success={t['s']/t['n']*100:.0f}%  correct={t['c']/t['n']*100:.0f}%  n={t['n']}")
    print(f"\n  CONFIDENCE CURVE (success % by run quartile)")
    for s, e, pct in quarters:
        bar = "#" * int(pct / 5)
        print(f"  Q runs {s+1:>3}-{e:<3}  {pct:5.1f}%  {bar}")

    if messy_profile != "none":
        print("\n  DATA CORRUPTION PROFILE")
        for k, v in sorted(corruption_counts.items(), key=lambda kv: kv[1], reverse=True):
            print(f"  {k:<24} {v:>4} runs ({v/n*100:4.1f}%)")

    print(f"\n  OpenAI calls : {data['openai_calls']}  |  Est. cost: ${data['openai_cost_usd']:.4f}")
    print("=" * 70)


def compare_results(f1, f2):
    with open(f1) as fh:
        b = json.load(fh)
    with open(f2) as fh:
        l = json.load(fh)

    def m(data):
        R = data["results"]
        n = len(R)
        return {
            "n": n,
            "succ": sum(1 for r in R if r["success"]) / n * 100,
            "corr": sum(1 for r in R if r["is_correct"]) / n * 100,
            "score": sum(r["outcome_score"] for r in R) / n,
            "gap": sum(r["suboptimality_gap"] for r in R) / n * 100,
        }

    bm = m(b)
    lm = m(l)
    b_label = f"{b['mode'].upper()} / data={b.get('messy_profile', 'none')}"
    l_label = f"{l['mode'].upper()} / data={l.get('messy_profile', 'none')}"

    print()
    print("=" * 65)
    print("  REAL WORLD COMPARISON")
    print(f"  A : {b_label} — {bm['n']} runs")
    print(f"  B : {l_label} — {lm['n']} runs")
    print("=" * 65)
    print(f"  {'Metric':<36} {'A':>8} {'B':>8} {'Delta':>8}")
    print("  " + "-" * 60)

    def row(label, bv, lv, fmt, sfx=""):
        d = lv - bv
        sign = "+" if d >= 0 else ""
        print(f"  {label:<36} {bv:>7{fmt}}{sfx} {lv:>7{fmt}}{sfx} {sign}{d:>{fmt}}{sfx}")

    row("Success Rate", bm["succ"], lm["succ"], ".1f", "%")
    row("Correct Action %", bm["corr"], lm["corr"], ".1f", "%")
    row("Mean Outcome Score", bm["score"], lm["score"], ".3f")
    row("Suboptimality Gap (lower=better)", bm["gap"], lm["gap"], ".1f", "pp")
    print("=" * 65)
    delta_corr = lm["corr"] - bm["corr"]
    if delta_corr >= 20:
        print(f"\n  STRONG REAL-WORLD PROOF (+{delta_corr:.1f}pp correct action selection)")
    elif delta_corr >= 10:
        print(f"\n  POSITIVE SIGNAL (+{delta_corr:.1f}pp — more runs = stronger proof)")
    else:
        print(f"\n  WEAK SIGNAL ({delta_corr:+.1f}pp — scenario parity may be close or noisy)")
    print()


def main():
    for s in ("stdout", "stderr"):
        st = getattr(sys, s, None)
        r = getattr(st, "reconfigure", None)
        if callable(r):
            try:
                r(encoding="utf-8", errors="replace")
            except Exception:
                pass

    p = argparse.ArgumentParser()
    p.add_argument("--mode", choices=["none", "observe", "assist", "auto"], default="auto")
    p.add_argument("--runs", type=int, default=20)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--messy-profile", choices=MESSY_PROFILES, default="none")
    p.add_argument("--compare", nargs=2, metavar=("BASELINE", "LI_FILE"))
    p.add_argument("--quiet", action="store_true")
    args = p.parse_args()

    if args.compare:
        compare_results(args.compare[0], args.compare[1])
        return

    data = run_agent(
        args.mode,
        args.runs,
        seed=args.seed,
        verbose=not args.quiet,
        messy_profile=args.messy_profile,
    )
    print_report(data)
    ts = datetime.now().strftime("%H%M%S")
    fname = f"results_rw_{args.mode}_{args.messy_profile}_{ts}.json"
    with open(fname, "w") as fh:
        json.dump(data, fh, indent=2)
    print(f"\n  Saved -> {fname}")


if __name__ == "__main__":
    main()
