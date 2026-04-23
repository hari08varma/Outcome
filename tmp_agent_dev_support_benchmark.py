import concurrent.futures
import json
import os
import random
import time
from datetime import datetime
from pathlib import Path

import agent_developer_support as ads

try:
    from openai import (
        APIConnectionError,
        APIError,
        APITimeoutError,
        AuthenticationError,
        OpenAI,
        RateLimitError,
    )
except Exception:
    from openai import OpenAI  # type: ignore
    APITimeoutError = TimeoutError  # type: ignore
    RateLimitError = Exception  # type: ignore
    APIConnectionError = Exception  # type: ignore
    AuthenticationError = Exception  # type: ignore
    APIError = Exception  # type: ignore

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
LI_API_KEY = os.getenv("LI_API_KEY", "").strip()

if not OPENAI_API_KEY:
    raise RuntimeError("OPENAI_API_KEY is missing")
if not LI_API_KEY:
    raise RuntimeError("LI_API_KEY is missing")

# Make sure the imported module uses runtime credentials.
ads.OPENAI_API_KEY = OPENAI_API_KEY
ads.LI_API_KEY = LI_API_KEY

openai_client = OpenAI(api_key=OPENAI_API_KEY)

TARGET_RPM = 70.0
MAX_WORKERS = 3
# Per-worker cycle time to keep global throughput near target RPM.
MIN_CYCLE_SECONDS = (60.0 / TARGET_RPM) * MAX_WORKERS

MODE_PLAN = [
    ("baseline", 100),
    ("recommend", 100),
    ("auto", 100),
]

openai_error_buckets: dict[str, dict[str, int]] = {}
mode_dispatch_error_buckets: dict[str, dict[str, int]] = {}
mode_context = {"name": "baseline"}


def new_error_bucket() -> dict[str, int]:
    return {
        "timeout": 0,
        "rate_limit": 0,
        "auth": 0,
        "network": 0,
        "api_error": 0,
        "other": 0,
    }


def bucket_exception(exc: Exception) -> str:
    if isinstance(exc, APITimeoutError):
        return "timeout"
    if isinstance(exc, RateLimitError):
        return "rate_limit"
    if isinstance(exc, AuthenticationError):
        return "auth"
    if isinstance(exc, APIConnectionError):
        return "network"
    if isinstance(exc, APIError):
        return "api_error"

    msg = str(exc).lower()
    if "timeout" in msg:
        return "timeout"
    if "rate" in msg or "429" in msg:
        return "rate_limit"
    if "401" in msg or "403" in msg or "auth" in msg or "invalid api key" in msg:
        return "auth"
    if "connection" in msg or "network" in msg or "dns" in msg:
        return "network"
    if "api" in msg or "server" in msg or "5" in msg:
        return "api_error"
    return "other"


def real_call_openai(ticket_type: str) -> str:
    prompt = (
        f"Dev Support Ticket: '{ticket_type}'. "
        f"Choose single best action from {ads.ALL_ACTIONS}. "
        "Reply ONLY action name."
    )
    mode = mode_context["name"]
    if mode not in openai_error_buckets:
        openai_error_buckets[mode] = new_error_bucket()

    try:
        resp = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            timeout=15,
        )
        content = (resp.choices[0].message.content or "").strip()
        action = ads.normalize_action(content)
    except Exception as exc:
        category = bucket_exception(exc)
        openai_error_buckets[mode][category] += 1
        action = random.choice(list(ads.TICKET_TYPES[ticket_type].keys()))

    return action or "comment_on_pr"


# Monkey-patch the script helper to ensure real OpenAI API usage under openai>=1.x.
ads.call_openai = real_call_openai


def run_mode(mode: str, count: int) -> dict:
    mode_context["name"] = mode
    openai_error_buckets.setdefault(mode, new_error_bucket())
    mode_dispatch_error_buckets.setdefault(mode, new_error_bucket())

    li = None if mode == "baseline" else ads.build_li(mode)
    if li is not None:
        ads.register_actions(li)

    records: list[dict] = []
    mode_start = time.perf_counter()

    def process_ticket(i: int) -> dict:
        ticket_start = time.perf_counter()
        ticket_type = random.choice(list(ads.TICKET_TYPES.keys()))

        try:
            if mode == "baseline":
                action, success, source = ads.dispatch_baseline(ticket_type)
            elif mode == "recommend":
                action, success, source = ads.dispatch_recommend(li, ticket_type)
            elif mode == "auto":
                action, success, source = ads.dispatch_auto(li, ticket_type)
            else:
                raise RuntimeError(f"Unsupported mode: {mode}")

            dispatch_error_category = None
        except Exception as exc:
            action = "dispatch_exception"
            success = False
            source = "exception"
            dispatch_error_category = bucket_exception(exc)
            mode_dispatch_error_buckets[mode][dispatch_error_category] += 1

        elapsed = time.perf_counter() - ticket_start
        if elapsed < MIN_CYCLE_SECONDS:
            time.sleep(MIN_CYCLE_SECONDS - elapsed)

        total_elapsed = time.perf_counter() - ticket_start
        return {
            "ticket": ticket_type,
            "action": action,
            "success": bool(success),
            "source": source,
            "latency_sec": round(total_elapsed, 4),
            "dispatch_error_category": dispatch_error_category,
        }

    print(f"\n[{mode.upper()}] starting {count} outcomes with max_workers={MAX_WORKERS}, target~{TARGET_RPM:.0f} RPM")

    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = [executor.submit(process_ticket, i) for i in range(count)]
        for idx, fut in enumerate(concurrent.futures.as_completed(futures), start=1):
            rec = fut.result()
            records.append(rec)
            if idx % 20 == 0:
                wins = sum(1 for r in records if r["success"])
                print(f"  progress: {idx}/{count} | win={wins/idx*100:.1f}%")

    duration = time.perf_counter() - mode_start
    rpm = (count / duration) * 60.0 if duration > 0 else 0.0
    wins = sum(1 for r in records if r["success"])

    source_counts: dict[str, int] = {}
    for rec in records:
        source_counts[rec["source"]] = source_counts.get(rec["source"], 0) + 1

    return {
        "mode": mode,
        "count": count,
        "wins": wins,
        "win_rate": round((wins / count) * 100.0, 2),
        "duration_sec": round(duration, 2),
        "rpm": round(rpm, 2),
        "rpm_target_low": 60,
        "rpm_target_high": 80,
        "rpm_in_target": 60 <= rpm <= 80,
        "source_counts": source_counts,
        "openai_errors": openai_error_buckets[mode],
        "dispatch_errors": mode_dispatch_error_buckets[mode],
        "auto_li_error_count": source_counts.get("li_error", 0),
        "auto_abstain_count": source_counts.get("li_abstained", 0),
    }


def main() -> None:
    random.seed(42)
    results = []

    started_at = datetime.utcnow().isoformat() + "Z"
    print("Running real API benchmark against agent_developer_support.py logic...")
    print(f"Start UTC: {started_at}")

    for mode, count in MODE_PLAN:
        summary = run_mode(mode, count)
        results.append(summary)
        print(
            f"[{mode}] done -> win={summary['wins']}/{summary['count']} "
            f"({summary['win_rate']}%), rpm={summary['rpm']}"
        )
        print(f"  sources: {summary['source_counts']}")
        print(f"  openai_errors: {summary['openai_errors']}")
        print(f"  dispatch_errors: {summary['dispatch_errors']}")

    ended_at = datetime.utcnow().isoformat() + "Z"

    final = {
        "started_at": started_at,
        "ended_at": ended_at,
        "target_rpm": TARGET_RPM,
        "max_workers": MAX_WORKERS,
        "min_cycle_seconds": round(MIN_CYCLE_SECONDS, 3),
        "results": results,
    }

    out_path = Path(f"results_agent_dev_support_real_{int(time.time())}.json")
    out_path.write_text(json.dumps(final, indent=2), encoding="utf-8")

    print("\nFINAL SUMMARY")
    for r in results:
        print(
            f"  {r['mode']:<10} win={r['win_rate']:>6.2f}% "
            f"rpm={r['rpm']:>6.2f} in_target={r['rpm_in_target']}"
        )
    print(f"Saved JSON: {out_path}")


if __name__ == "__main__":
    main()
