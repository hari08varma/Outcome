import json
import random
from datetime import datetime, timedelta

# Configuration
NUM_OUTCOMES = 1800
DAYS_BACK = 90

# ---------------------------------------------------------------------------
# AGENT 1: Customer Support (LangGraph Format)
# ---------------------------------------------------------------------------
AGENT1_CONTEXTS = ["payment_failed", "api_timeout", "user_not_responding", "account_locked"]
AGENT1_ACTIONS = ["switch_provider", "retry_request", "notify_user", "escalate_issue", "fallback_cache", "reset_password"]

# Simulated Win Rates for Customer Support History
AGENT1_WIN_RATES = {
    "payment_failed": {"switch_provider": 0.85, "retry_request": 0.50},
    "api_timeout": {"retry_request": 0.70, "switch_provider": 0.40, "fallback_cache": 0.90},
    "user_not_responding": {"notify_user": 0.80, "escalate_issue": 0.30},
    "account_locked": {"reset_password": 0.95, "escalate_issue": 0.50}
}
# Fallback success for untuned combos
FALLBACK_RATE = 0.15

def generate_langgraph_customer_support():
    print("Generating Customer Support LangGraph traces...")
    records = []
    now = datetime.utcnow()
    
    for i in range(NUM_OUTCOMES):
        # Time decay distribution
        days_ago = random.uniform(5, DAYS_BACK)
        timestamp = now - timedelta(days=days_ago)
        
        ctx = random.choice(AGENT1_CONTEXTS)
        action = random.choice(AGENT1_ACTIONS)
        
        rate = AGENT1_WIN_RATES.get(ctx, {}).get(action, FALLBACK_RATE)
        success = random.random() < rate
        error_msg = None if success else random.choice(["Node execution failed", "Timeout", "Validation error"])
        
        records.append({
            "thread_id": f"thread-cs-{i}",
            "checkpoint_id": f"chk-cs-{i}",
            "node": action,
            "channel_values": {
                "issue_type": ctx,
                "user_id": f"usr-{random.randint(1000, 9999)}",
                "session_token": f"token-{random.randint(10000, 99999)}"
            },
            "error": error_msg,
            "metadata": {"step": random.randint(1, 4), "source": action},
            "created_at": timestamp.isoformat() + "Z"
        })
        
    with open("agent1_customer_support_import.json", "w") as f:
        json.dump(records, f, indent=2)
    print("-> Done agent1_customer_support_import.json")

# ---------------------------------------------------------------------------
# AGENT 2: Developer Support (LangChain Format)
# ---------------------------------------------------------------------------
AGENT2_CONTEXTS = ["build_failed", "security_vulnerability", "pr_review", "dependency_conflict"]
AGENT2_ACTIONS = ["trigger_rebuild", "revert_commit", "notify_security_team", "comment_on_pr", "auto_patch", "ignore_warning"]

AGENT2_WIN_RATES = {
    "build_failed": {"trigger_rebuild": 0.60, "revert_commit": 0.85},
    "security_vulnerability": {"notify_security_team": 0.99, "auto_patch": 0.40},
    "pr_review": {"comment_on_pr": 0.90, "ignore_warning": 0.10},
    "dependency_conflict": {"auto_patch": 0.70, "revert_commit": 0.50}
}

def generate_langchain_dev_support():
    print("Generating Dev Support LangChain traces...")
    records = []
    now = datetime.utcnow()
    
    for i in range(NUM_OUTCOMES):
        # Time decay distribution
        days_ago = random.uniform(5, DAYS_BACK)
        timestamp = now - timedelta(days=days_ago)
        
        ctx = random.choice(AGENT2_CONTEXTS)
        action = random.choice(AGENT2_ACTIONS)
        
        rate = AGENT2_WIN_RATES.get(ctx, {}).get(action, FALLBACK_RATE)
        success = random.random() < rate
        error_msg = None if success else "LangChain Run Failed"
        
        records.append({
            "id": f"run-dev-{i}",
            "name": action,
            "run_type": "tool",
            "start_time": timestamp.isoformat() + "Z",
            "end_time": (timestamp + timedelta(seconds=random.uniform(0.5, 3.0))).isoformat() + "Z",
            "error": error_msg,
            "inputs": {
                "issue_type": ctx,
                "github_repo": f"org/repo-{random.randint(1, 5)}",
                "pr_number": random.randint(100, 900) if ctx == "pr_review" else None
            },
            "outputs": {"result": "success"} if success else None,
            "tags": ["prod", "dev_agent"],
            "extra": {"attempt": random.randint(1, 3)}
        })
        
    with open("agent2_dev_support_import.json", "w") as f:
        json.dump(records, f, indent=2)
    print("-> Done agent2_dev_support_import.json")

if __name__ == "__main__":
    generate_langgraph_customer_support()
    generate_langchain_dev_support()
    print("All real-world traces generated.")
