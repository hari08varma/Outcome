import os
import random
import sys
import time
from pathlib import Path
import openai

try:
    from layerinfinite import Layerinfinite, LogOutcomeRequest
    from layerinfinite.exceptions import LowConfidenceError
except ImportError:
    _LOCAL_SDK = Path(__file__).resolve().parent / "layer5" / "sdks" / "python"
    if _LOCAL_SDK.exists():
        sys.path.insert(0, str(_LOCAL_SDK))
    from layerinfinite import Layerinfinite, LogOutcomeRequest
    from layerinfinite.exceptions import LowConfidenceError

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
LI_API_KEY     = os.getenv("LI_API_KEY",     "layerinfinite_00269ae776661c4dbafeb13a36e37590")
LI_AGENT_ID    = os.getenv("LI_AGENT_ID",    "dev_agent_2")
LI_BASE_URL    = os.getenv("LI_BASE_URL",    "https://king-prawn-app-oiwpl.ondigitalocean.app")
openai.api_key = OPENAI_API_KEY

TICKET_TYPES = {
    "build_failed": {"trigger_rebuild": 0.60, "revert_commit": 0.85},
    "security_vulnerability": {"notify_security_team": 0.99, "auto_patch": 0.40},
    "pr_review": {"comment_on_pr": 0.90, "ignore_warning": 0.10},
    "dependency_conflict": {"auto_patch": 0.70, "revert_commit": 0.50}
}
ALL_ACTIONS = list({a for rates in TICKET_TYPES.values() for a in rates})

TEST_PLAN = [
    ("baseline", 100),
    ("assist", 100),
    ("auto", 100),
]

def normalize_action(raw):
    if not isinstance(raw, str): return None
    candidate = raw.strip().lower().replace("-", "_").replace(" ", "_")
    if candidate in ALL_ACTIONS: return candidate
    for action in ALL_ACTIONS:
        if action in candidate: return action
    return None

HANDLERS = {}

def build_li(mode: str) -> Layerinfinite:
    return Layerinfinite(
        api_key=LI_API_KEY, agent_id=LI_AGENT_ID, mode=mode,
        base_url=LI_BASE_URL, timeout=10.0, max_retries=3, auto_fallback=True,
        confidence_threshold=0.35
    )

def register_actions(li: Layerinfinite):
    for t in TICKET_TYPES:
        for a in ALL_ACTIONS:
            def _make_handler(ticket, act):
                @li.action(ticket, name=act)
                def handler():
                    rate = TICKET_TYPES.get(ticket, {}).get(act, 0.15)
                    success = random.random() < rate
                    if not success: raise RuntimeError(f"Failed {act}")
                    return {"action": act, "status": "resolved"}
                return handler
            HANDLERS[f"{t}:{a}"] = _make_handler(t, a)

def simulate_environment(ticket_type: str, action: str):
    handler = HANDLERS.get(f"{ticket_type}:{action}")
    if not handler:
        return False
    try:
        handler()
        return True
    except Exception:
        return False

def call_openai(ticket_type: str) -> str:
    prompt = f"Dev Support Ticket: '{ticket_type}'. Choose single best action from {ALL_ACTIONS}. Reply ONLY action name."
    try:
        resp = openai.ChatCompletion.create(model="gpt-4o-mini", messages=[{"role": "user", "content": prompt}], temperature=0)
        action = normalize_action(resp["choices"][0]["message"]["content"].strip())
    except Exception:
        action = random.choice(list(TICKET_TYPES[ticket_type].keys()))
    return action or "comment_on_pr"

def dispatch_baseline(ticket_type: str):
    action = call_openai(ticket_type)
    rate = TICKET_TYPES.get(ticket_type, {}).get(action, 0.15)
    success = random.random() < rate
    return action, success, "openai"

def dispatch_observe(li: Layerinfinite, ticket_type: str):
    action = call_openai(ticket_type)
    success = simulate_environment(ticket_type, action)
    return action, success, "openai_observe"

def dispatch_recommend(li: Layerinfinite, ticket_type: str):
    action = None; source = "openai_fallback"
    scores = li.scores(ticket_type)
    if scores and getattr(scores, "top_action", None):
        action = normalize_action(scores.top_action.action_name)
        source = "li_scores"
    if not action:
        rec = li.recommend(ticket_type)
        if rec and getattr(rec, "recommendation", None):
            action = normalize_action(rec.recommendation)
            source = "li_recommend"
    if not action: action = call_openai(ticket_type)
    
    success = simulate_environment(ticket_type, action)
    return action, success, source

def dispatch_assist(li: Layerinfinite, ticket_type: str):
    action = None; source = "openai_fallback"
    try:
        s = li.suggest(ticket_type)
        if s and getattr(s, "action_name", None):
            action = normalize_action(s.action_name); source = "li_suggest"
    except Exception: pass
    if not action: action = call_openai(ticket_type)
    success = simulate_environment(ticket_type, action)
    return action, success, source

def dispatch_auto(li: Layerinfinite, ticket_type: str):
    try:
        res = li.run(ticket_type)
        return res.get("action", "li_auto") if isinstance(res, dict) else "li_auto", True, "li_auto"
    except LowConfidenceError as exc:
        action = normalize_action(getattr(exc.suggestion, "action_name", None)) or call_openai(ticket_type)
        success = simulate_environment(ticket_type, action)
        return action, success, "li_abstained"
    except Exception:
        return "auto_error", False, "li_error"

import concurrent.futures

def run_mode(mode: str, count: int) -> list:
    print(f"\n[{mode.upper()}] Running {count} tickets concurrently (aiming for 60 rpm)...")
    li = None if mode == "baseline" else build_li(mode)
    if li: register_actions(li)
    records = []
    
    def process_ticket(i):
        t = random.choice(list(TICKET_TYPES.keys()))
        if mode == "baseline": act, suc, src = dispatch_baseline(t)
        elif mode == "observe": act, suc, src = dispatch_observe(li, t)
        elif mode == "recommend": act, suc, src = dispatch_recommend(li, t)
        elif mode == "assist": act, suc, src = dispatch_assist(li, t)
        else: act, suc, src = dispatch_auto(li, t)
        
        # Enforce rate limits natively per thread
        time.sleep(1.0 + random.uniform(0, 0.15))
        return {"ticket": t, "action": act, "success": suc, "source": src}

    # Use 3 concurrent workers to guarantee ~60 RPM despite OpenAI's latency
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        futures = [executor.submit(process_ticket, i) for i in range(count)]
        for i, future in enumerate(concurrent.futures.as_completed(futures)):
            records.append(future.result())
            if (i + 1) % 25 == 0:
                oks = sum(1 for r in records if r["success"])
                print(f"    progress: {i + 1}/{count} ({(oks / (i + 1)) * 100:.1f}% win)")

    return records

if __name__ == "__main__":
    results = {}
    for mode, count in TEST_PLAN:
        results[mode] = run_mode(mode, count)
        oks = sum(1 for r in results[mode] if r["success"])
        print(f" -> {mode} Finished: {oks}/{count} ({(oks/count)*100:.1f}%)")
    
    print("\nFINAL OVERVIEW:")
    for mode, recs in results.items():
        oks = sum(1 for r in recs if r["success"])
        print(f" {mode:<12}: {oks}/{len(recs)} = {(oks/len(recs))*100:.1f}% Win Rate")
