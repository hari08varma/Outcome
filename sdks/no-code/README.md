# Layer5 No-Code Integrations

Connect Layer5 to your workflows **without writing code**.  
Works with n8n, Zapier, and Make.com (Integromat).

---

## What is Layer5?

Layer5 learns from every action your AI agent takes.  
It tracks what works, what fails, and recommends the best next action — automatically.

These connectors let you plug Layer5 into your existing automation workflows.

---

## Quick Start

### 📋 Before you begin

1. **Get your API key** at [app.layer5.dev/settings/api-keys](https://app.layer5.dev/settings/api-keys)
2. **Register your actions** at [app.layer5.dev/actions](https://app.layer5.dev/actions)  
   (e.g., `send_refund`, `restart_service`, `escalate_to_human`)
3. **Pick your connector** below

---

## n8n

### Install

1. Open your n8n instance
2. Go to **Settings → Community Nodes**
3. Enter: `n8n-nodes-layer5`
4. Click **Install**

### Set up credentials

1. Go to **Credentials → New**
2. Search for **Layer5 API**
3. Paste your API key (starts with `layer5_`)
4. Click **Save**

### Example: Score → Act → Log

```
[Trigger] → [Layer5: Get Scores] → [IF top_action = "send_refund"] → [Send Refund] → [Layer5: Log Outcome]
```

**Step 1 — Get Scores:**
| Field       | Value            |
|-------------|------------------|
| Agent Name  | `refund-bot`     |
| Issue Type  | `payment_failed` |

**Step 2 — Log Outcome:**
| Field       | Value           |
|-------------|-----------------|
| Agent Name  | `refund-bot`    |
| Action Name | `send_refund`   |
| Did It Work?| `true`          |

### Available operations

| Operation           | What it does                                         |
|---------------------|------------------------------------------------------|
| Get Scores          | Get ranked action recommendations for a situation    |
| Log Outcome         | Tell Layer5 whether an action succeeded or failed    |
| Log Feedback        | Update a previous outcome with a final score         |
| Get Patterns        | See which action sequences have worked best          |
| Simulate Sequence   | Predict the outcome of a proposed action sequence    |

### Simulating Action Sequences (before running them)

Use the **Simulate Sequence** operation to predict what will happen before your agent tries a sequence. Layer5 uses your historical data to estimate success probability and suggest better alternatives.

**Example:**
Your agent is about to try `[clear_cache → restart_service]`.
Pass this sequence to Simulate and Layer5 returns:
- **predicted_outcome:** 0.83 (83% likely to succeed)
- **confidence_low:** 0.65
- **confidence_high:** 0.94
- **best_alternative_actions:** restart_service, clear_cache
- **best_alternative_outcome:** 0.91

Your automation can use this to choose the better path before any action runs.

| Field                        | Value                           |
|------------------------------|----------------------------------|
| Agent ID                     | `my-payment-agent`               |
| Context (JSON)               | `{"issue_type": "payment_failed"}` |
| Proposed Action Sequence     | `clear_cache,restart_service`    |
| Already Tried (Optional)     | `update_app`                     |
| Number of Alternatives       | `2`                              |

**What the tiers mean:**
- **Tier 1:** Based on your historical records. Available from day one.
- **Tier 2:** Trained ML model. Available after ~200 outcomes.
- **Tier 3:** Advanced planning (MCTS). Available after ~1,000 outcomes.

---

## Zapier

### Install

1. Go to [zapier.com](https://zapier.com) and log in
2. Create a new Zap
3. Search for **Layer5** in the app selector
4. Connect your account with your API key

### Set up authentication

1. When prompted, paste your **Layer5 API key**
2. Keys start with `layer5_`
3. Find yours at [app.layer5.dev/settings/api-keys](https://app.layer5.dev/settings/api-keys)

### Example: Log an outcome after a Zendesk ticket closes

```
Trigger: Zendesk → Ticket Closed
Action:  Layer5  → Log Action Outcome
```

| Field        | Value                            |
|--------------|----------------------------------|
| Agent Name   | `support-bot`                    |
| Action Name  | `close_ticket`                   |
| Did It Work? | `True`                           |
| Outcome Score| `0.9`                            |
| Response Time| `1500`                           |

### Available actions

| Action                     | Type    | What it does                                      |
|----------------------------|---------|---------------------------------------------------|
| Get Action Scores          | Search  | Look up the best actions for a situation           |
| Simulate Action Sequence   | Search  | Predict the outcome of a proposed action sequence  |
| Log Action Outcome         | Create  | Record what happened after an action               |

### Simulating Action Sequences (before running them)

Use the **Simulate Action Sequence** search to predict what will happen before your agent tries a sequence. Layer5 uses your historical data to estimate success probability and suggest better alternatives.

**Example:**
Your agent is about to try `[clear_cache → restart_service]`.
Pass this sequence to Simulate and Layer5 returns:
- **predicted_outcome:** 0.83 (83% likely to succeed)
- **confidence_low:** 0.65
- **confidence_high:** 0.94
- **best_alternative_actions:** restart_service, clear_cache
- **best_alternative_outcome:** 0.91

Your automation can use this to choose the better path before any action runs.

**What the tiers mean:**
- **Tier 1:** Based on your historical records. Available from day one.
- **Tier 2:** Trained ML model. Available after ~200 outcomes.
- **Tier 3:** Advanced planning (MCTS). Available after ~1,000 outcomes.

---

## Make.com (Integromat)

### Install

1. Open [make.com](https://www.make.com) and go to your scenario
2. Add a new module → search **Layer5**
3. Create a connection with your API key

### Set up connection

1. Click **Add** next to the Connection dropdown
2. Paste your **Layer5 API key** (starts with `layer5_`)
3. Click **Save**

### Example: Get scores and route based on recommendation

```
[Webhook] → [Layer5: Get Action Scores] → [Router]
                                              ├─ top_action = "send_refund"    → [Stripe: Refund]
                                              ├─ top_action = "restart_service" → [AWS: Restart]
                                              └─ should_escalate = true         → [Slack: Alert]
```

| Field       | Value            |
|-------------|------------------|
| Agent Name  | `ops-agent`      |
| Issue Type  | `service_down`   |

### Available modules

| Module                     | What it does                                      |
|----------------------------|---------------------------------------------------|
| Get Action Scores          | Get ranked action recommendations                  |
| Log Action Outcome         | Record what happened after an action                |
| Submit Outcome Feedback    | Update a previous outcome with a final score        |
| Simulate Action Sequence   | Predict the outcome of a proposed action sequence   |

### Simulating Action Sequences (before running them)

Use the **Simulate Action Sequence** module to predict what will happen before your agent tries a sequence. Layer5 uses your historical data to estimate success probability and suggest better alternatives.

**Example:**
Your agent is about to try `[clear_cache → restart_service]`.
Pass this sequence to Simulate and Layer5 returns:
- **predicted_outcome:** 0.83 (83% likely to succeed)
- **confidence_low:** 0.65
- **confidence_high:** 0.94
- **best_alternative_actions:** restart_service, clear_cache
- **best_alternative_outcome:** 0.91

Your automation can use this to choose the better path before any action runs.

**What the tiers mean:**
- **Tier 1:** Based on your historical records. Available from day one.
- **Tier 2:** Trained ML model. Available after ~200 outcomes.
- **Tier 3:** Advanced planning (MCTS). Available after ~1,000 outcomes.

---

## Troubleshooting

### "Invalid API key"

**What happened:** Your API key was rejected.

**How to fix it:**
1. Go to [app.layer5.dev/settings/api-keys](https://app.layer5.dev/settings/api-keys)
2. Copy your API key — it starts with `layer5_`
3. Paste it into your connector's credentials/connection settings
4. Make sure there are no extra spaces before or after the key

**Still not working?** Your key may have been revoked. Generate a new one at the link above.

---

### "Unknown action"

**What happened:** You tried to log an outcome for an action that Layer5 doesn't recognize.

**How to fix it:**
1. Go to [app.layer5.dev/actions](https://app.layer5.dev/actions)
2. Click **Add Action**
3. Enter the exact same action name you're using in your workflow  
   (e.g., `send_refund` — spelling and capitalization matter)
4. Save and try again

**Common mistake:** Using `sendRefund` when you registered `send_refund`. The name must match **exactly**.

---

### "Agent suspended"

**What happened:** Layer5 suspended this agent because it had too many consecutive failures. This is a safety feature to prevent runaway agents from causing damage.

**How to fix it:**
1. Go to [app.layer5.dev/agents](https://app.layer5.dev/agents)
2. Find the suspended agent
3. Click **Reinstate**
4. Investigate why the agent was failing — check your action logs for error patterns

**Tip:** You can configure suspension thresholds in your Layer5 dashboard under **Settings → Policy**.

---

## File Structure

```
sdks/no-code/
├── n8n/
│   ├── Layer5.node.ts          ← n8n community node (5 operations)
│   ├── Layer5.credentials.ts   ← API key credential type
│   └── package.json
├── make/
│   └── layer5-make-spec.json   ← Make.com app specification (4 modules)
├── zapier/
│   ├── index.js                ← Zapier app entry point
│   ├── package.json
│   ├── authentication.js       ← API key auth
│   ├── creates/
│   │   └── log_outcome.js      ← Log Action Outcome
│   └── searches/
│       ├── get_scores.js       ← Get Action Scores
│       └── simulate_sequence.js ← Simulate Action Sequence
└── README.md                   ← This file
```

---

## Need Help?

- **Docs:** [docs.layer5.dev](https://docs.layer5.dev)
- **Dashboard:** [app.layer5.dev](https://app.layer5.dev)
- **API Reference:** [docs.layer5.dev/api](https://docs.layer5.dev/api)
