# pip install openai layerinfinite-sdk httpx

import os, time, uuid, json
from openai import OpenAI
from layerinfinite import LayerinfiniteClient, LogOutcomeRequest

openai = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
li     = LayerinfiniteClient(api_key=os.environ["LAYERINFINITE_API_KEY"])

AGENT_ID = None

EPISODES = [
    {
        "episode_id": str(uuid.uuid4()),
        "issue_type": "billing_dispute",
        "messages": [
            "I was charged twice this month. Please fix it.",
            "The charge is still showing after your last reply.",
            "I need this resolved today or I am cancelling.",
        ],
    },
    {
        "episode_id": str(uuid.uuid4()),
        "issue_type": "billing_dispute",
        "messages": [
            "I cancelled but still got charged. This is fraud.",
            "Your team said it was resolved but I see it again.",
        ],
    },
    {
        "episode_id": str(uuid.uuid4()),
        "issue_type": "technical_bug",
        "messages": [
            "CSV export downloads an empty file every time.",
            "Still broken after clearing cache and retrying.",
        ],
    },
]

for episode in EPISODES:
    episode_id = episode["episode_id"]
    issue_type = episode["issue_type"]
    print(f"\n═══ Episode {episode_id[:8]} [{issue_type}] ═══")

    for message in episode["messages"]:
        # ── Step 1: Get recommended action from Layerinfinite ──
        scores     = li.get_scores(issue_type=issue_type)
        action     = scores.top_action.action_name if scores.top_action else "escalate_to_human"
        context_id = scores.context_id

        if AGENT_ID is None:
            AGENT_ID = scores.agent_id
            print(f"Agent ID resolved: {AGENT_ID}\n")

        print(f"\n  User    : {message}")
        print(f"  LI says : {action}  (policy={scores.policy})")

        # ── Step 2: Generate reply with GPT ──
        t0 = time.time()
        response = openai.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": (
                    f"You are a customer support agent. Your task: {action}. "
                    "Reply professionally in 2-3 sentences. Sign off as Support Team."
                )},
                {"role": "user", "content": message},
            ],
            max_tokens=100,
            temperature=0.3,
        )
        response_ms = int((time.time() - t0) * 1000)
        reply = response.choices[0].message.content.strip()
        print(f"  Reply   : {reply}")

        # ── Step 3: Evaluate outcome with GPT ──
        eval_raw = openai.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": (
                    'Return ONLY valid JSON: {"success":bool,"outcome":"resolved|partial|failed","score":0.0-1.0}'
                )},
                {"role": "user", "content": (
                    f"Issue: {message}\nAction: {action}\nReply: {reply}"
                )},
            ],
            max_tokens=40,
            temperature=0.0,
        )
        ev = json.loads(eval_raw.choices[0].message.content.strip())
        print(f"  Outcome : success={ev['success']} score={ev['score']} ({ev['outcome']})")

        # ── Step 4: Log outcome to Layerinfinite ──
        result = li.log_outcome(LogOutcomeRequest(
            agent_id         = AGENT_ID,
            action_name      = action,
            context_id       = context_id,
            issue_type       = issue_type,
            episode_id       = episode_id,
            success          = ev["success"],
            outcome_score    = float(ev["score"]),
            business_outcome = ev["outcome"],
            feedback_signal  = "immediate",
            response_ms      = response_ms,
        ))
        print(f"  Trust   : {result.agent_trust_score:.4f} ({result.trust_status})  policy→{result.policy}")

li._session.close()
print("\n✅ Done.")
