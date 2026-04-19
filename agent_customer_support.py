import os
import random
import sys
import time
from pathlib import Path
import requests

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
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
LI_API_KEY     = os.getenv("LI_API_KEY",     "layerinfinite_2c9d7ed5bc4ad49647cfbd4791479d75")
LI_AGENT_ID    = os.getenv("LI_AGENT_ID",    "sagent")
LI_BASE_URL    = os.getenv("LI_BASE_URL",    "https://king-prawn-app-oiwpl.ondigitalocean.app")

TICKET_TYPES = {
    "payment_failed": {"switch_provider": 0.85, "retry_request": 0.50, "notify_user": 0.3},
    "api_timeout": {"retry_request": 0.70, "switch_provider": 0.40, "fallback_cache": 0.90},
    "user_not_responding": {"notify_user": 0.80, "escalate_issue": 0.30},
    "account_locked": {"reset_password": 0.95, "escalate_issue": 0.50}
}
ALL_ACTIONS = list({a for rates in TICKET_TYPES.values() for a in rates})

TEST_PLAN = [
    ("baseline", 100),
    ("assist", 100),
    ("auto", 100),
]


def parse_non_negative_float(env_name: str, fallback: float) -> float:
    raw = os.getenv(env_name)
    if raw is None:
        return fallback
    try:
        value = float(raw)
        return value if value >= 0 else fallback
    except Exception:
        return fallback


def parse_positive_int(env_name: str, fallback: int) -> int:
    raw = os.getenv(env_name)
    if raw is None:
        return fallback
    try:
        value = int(raw)
        return value if value > 0 else fallback
    except Exception:
        return fallback


OPENAI_REQUEST_TIMEOUT_SECONDS = parse_non_negative_float("OPENAI_REQUEST_TIMEOUT_SECONDS", 20.0)
LI_REQUEST_TIMEOUT_SECONDS = parse_non_negative_float("LI_REQUEST_TIMEOUT_SECONDS", 60.0)
LI_MAX_RETRIES = parse_positive_int("LI_MAX_RETRIES", 3)


# Keep request volume under API rate limits when running stress simulations.
MODE_DELAY_SECONDS = {
    "observe": parse_non_negative_float("LI_OBSERVE_DELAY_SECONDS", 0.35),
    "recommend": parse_non_negative_float("LI_RECOMMEND_DELAY_SECONDS", 1.15),
    "assist": parse_non_negative_float("LI_ASSIST_DELAY_SECONDS", 1.10),
    "auto": parse_non_negative_float("LI_AUTO_DELAY_SECONDS", 1.20),
}
DELAY_JITTER_SECONDS = parse_non_negative_float("LI_DELAY_JITTER_SECONDS", 0.15)

def normalize_action(raw):
    if not isinstance(raw, str): return None
    candidate = raw.strip().lower().replace("-", "_").replace(" ", "_")
    if candidate in ALL_ACTIONS: return candidate
    for action in ALL_ACTIONS:
        if action in candidate: return action
    return None

HANDLERS = {}

def build_li(mode: str) -> Layerinfinite:
    sdk_mode = mode if mode in {"recommend", "assist", "auto"} else "recommend"
    return Layerinfinite(
        api_key=LI_API_KEY, agent_id=LI_AGENT_ID, mode=sdk_mode,
        base_url=LI_BASE_URL, timeout=LI_REQUEST_TIMEOUT_SECONDS, max_retries=LI_MAX_RETRIES, auto_fallback=True,
        confidence_threshold=0.35,
        log_async=False,
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
    prompt = f"Customer Ticket: '{ticket_type}'. Choose single best action from {ALL_ACTIONS}. Reply ONLY action name."
    try:
        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": OPENAI_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0,
            },
            timeout=OPENAI_REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        payload = response.json()
        content = payload["choices"][0]["message"]["content"]
        action = normalize_action(content.strip())
    except Exception:
        action = random.choice(list(TICKET_TYPES[ticket_type].keys()))
    return action or "escalate_issue"

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
    try:
        scores = li.scores(ticket_type)
        if scores and getattr(scores, "top_action", None):
            action = normalize_action(scores.top_action.action_name)
            source = "li_scores"
    except Exception:
        scores = None

    if not action:
        try:
            rec = li.recommend(ticket_type)
            if rec and getattr(rec, "recommendation", None):
                action = normalize_action(rec.recommendation)
                source = "li_recommend"
        except Exception:
            rec = None

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
        base_delay = MODE_DELAY_SECONDS.get(mode, 1.0)
        if base_delay > 0:
             time.sleep(base_delay + random.uniform(0, DELAY_JITTER_SECONDS))
             
        return {"ticket": t, "action": act, "success": suc, "source": src}

    # Use 3 concurrent workers to guarantee ~60 RPM despite OpenAI's 2-second latency
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
