import os
import random
import sys
import time
from pathlib import Path
import openai

# Initialize LayerInfinite SDK
try:
    from layerinfinite import Layerinfinite
except ImportError:
    _LOCAL_SDK = Path(__file__).resolve().parent / "layer5" / "sdks" / "python"
    sys.path.insert(0, str(_LOCAL_SDK))
    from layerinfinite import Layerinfinite

LI_API_KEY = os.getenv("LI_API_KEY", "")
LI_BASE_URL = os.getenv("LI_BASE_URL", "https://layerinfinite.me")
li = Layerinfinite(api_key=LI_API_KEY, agent_id="dev_agent_assist", mode="assist", base_url=LI_BASE_URL)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
openai.api_key = OPENAI_API_KEY

TICKET_TYPES = {
    "build_failed": {"trigger_rebuild": 0.60, "revert_commit": 0.85},
    "security_vulnerability": {"notify_security_team": 0.99, "auto_patch": 0.40},
    "pr_review": {"comment_on_pr": 0.90, "ignore_warning": 0.10},
    "dependency_conflict": {"auto_patch": 0.70, "revert_commit": 0.50}
}
ALL_ACTIONS = list({a for rates in TICKET_TYPES.values() for a in rates})

# ==========================================
# Real World Example: Decorating Functions
# ==========================================
# In a real-world agent, developers explicitly decorate their functions
# with @li.action(task_name). This tells LayerInfinite exactly which task 
# this function is trying to solve.

@li.action("build_failed")
def trigger_rebuild():
    success = random.random() < 0.60
    time.sleep(random.uniform(0.1, 0.3))
    if not success: raise Exception("Failed to trigger rebuild")
    return True

@li.action("build_failed")
def revert_commit():
    success = random.random() < 0.85
    time.sleep(random.uniform(0.1, 0.3))
    if not success: raise Exception("Failed to revert commit")
    return True

@li.action("security_vulnerability")
def notify_security_team():
    success = random.random() < 0.99
    time.sleep(random.uniform(0.1, 0.3))
    if not success: raise Exception("Failed to notify security team")
    return True

@li.action("security_vulnerability")
def auto_patch():
    success = random.random() < 0.40
    time.sleep(random.uniform(0.1, 0.3))
    if not success: raise Exception("Failed to auto patch")
    return True

@li.action("pr_review")
def comment_on_pr():
    success = random.random() < 0.90
    time.sleep(random.uniform(0.1, 0.3))
    if not success: raise Exception("Failed to comment on PR")
    return True

@li.action("pr_review")
def ignore_warning():
    success = random.random() < 0.10
    time.sleep(random.uniform(0.1, 0.3))
    if not success: raise Exception("Failed to ignore warning")
    return True

@li.action("dependency_conflict")
def auto_patch_dependency():
    success = random.random() < 0.70
    time.sleep(random.uniform(0.1, 0.3))
    if not success: raise Exception("Failed to patch dependency")
    return True

@li.action("dependency_conflict")
def revert_commit_dependency():
    success = random.random() < 0.50
    time.sleep(random.uniform(0.1, 0.3))
    if not success: raise Exception("Failed to revert commit")
    return True

# We store them in a dictionary so our simulated agent can call them by name
ACTION_FUNCS = {
    "build_failed:trigger_rebuild": trigger_rebuild,
    "build_failed:revert_commit": revert_commit,
    "security_vulnerability:notify_security_team": notify_security_team,
    "security_vulnerability:auto_patch": auto_patch,
    "pr_review:comment_on_pr": comment_on_pr,
    "pr_review:ignore_warning": ignore_warning,
    "dependency_conflict:auto_patch": auto_patch_dependency,
    "dependency_conflict:revert_commit": revert_commit_dependency
}

def normalize_action(raw):
    if not isinstance(raw, str): return None
    candidate = raw.strip().lower().replace("-", "_").replace(" ", "_")
    if candidate in ALL_ACTIONS: return candidate
    for action in ALL_ACTIONS:
        if action in candidate: return action
    return None

def execute_action(ticket_type: str, action: str):
    """Simulates executing the action in the infrastructure."""
    handler = ACTION_FUNCS.get(f"{ticket_type}:{action}")
    if not handler:
        return False
        
    try:
        # Executing the decorated function automatically logs the outcome to LayerInfinite
        handler()
        return True
    except Exception:
        return False

def call_openai(ticket_type: str) -> str:
    """Asks the LLM to decide the best action based on the ticket type."""
    prompt = (
        f"You are an autonomous DevOps support agent. A new ticket has come in with the issue type: '{ticket_type}'. "
        f"Choose the single best action to resolve this issue from the following options: {ALL_ACTIONS}. "
        f"Reply ONLY with the exact action name and nothing else."
    )
    
    # [LAYERINFINITE ASSIST MODE]
    # Ask LayerInfinite for a data-driven suggestion based on historical production outcomes
    try:
        suggestion = li.suggest(ticket_type)
        if suggestion and getattr(suggestion, "action_name", None):
            prompt += f"\n\nHINT: LayerInfinite recommends '{suggestion.action_name}' (Confidence: {suggestion.confidence:.2f})"
            print(f"  [LI Assist] Added hint to prompt: {suggestion.action_name}")
    except Exception as e:
        pass
    
    try:
        resp = openai.ChatCompletion.create(
            model="gpt-4o-mini", 
            messages=[{"role": "user", "content": prompt}], 
            temperature=0
        )
        action = normalize_action(resp["choices"][0]["message"]["content"].strip())
    except Exception as e:
        print(f"OpenAI API Error: {e}")
        # Fallback if OpenAI fails or API key is missing
        action = random.choice(list(TICKET_TYPES[ticket_type].keys()))
        
    return action or "comment_on_pr"

def process_ticket(ticket_type: str):
    print(f"Processing ticket: {ticket_type}...")
    
    # 1. Agent observes the ticket and decides what to do using LLM
    action = call_openai(ticket_type)
    print(f"  -> Agent decided to execute: {action}")
    
    # 2. Agent executes the action in the environment
    success = execute_action(ticket_type, action)
    
    if success:
        print(f"  -> [SUCCESS] Action {action} resolved the ticket.")
    else:
        print(f"  -> [FAILED] Action {action} did not resolve the ticket.")
        
    return success

def run_agent(ticket_count: int = 10):
    print(f"Starting Autonomous Dev Support Agent (processing {ticket_count} tickets)...\n")
    
    successes = 0
    tickets = [random.choice(list(TICKET_TYPES.keys())) for _ in range(ticket_count)]
    
    for i, ticket in enumerate(tickets):
        print(f"--- Ticket {i+1}/{ticket_count} ---")
        if process_ticket(ticket):
            successes += 1
        time.sleep(1.0) # Rate limiting to avoid OpenAI 429s
        
    print("\n--- Final Report ---")
    print(f"Total Tickets Processed: {ticket_count}")
    print(f"Successfully Resolved: {successes}")
    print(f"Resolution Rate: {(successes/ticket_count)*100:.1f}%")

if __name__ == "__main__":
    if not OPENAI_API_KEY:
        print("WARNING: OPENAI_API_KEY environment variable not set. Agent will fallback to random actions.\n")
    
    run_agent(20)
