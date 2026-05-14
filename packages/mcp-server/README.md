# @layerinfinite/mcp-server

The LayerInfinite Decision Layer for MCP-compatible AI agents.

## What it does

LayerInfinite tracks the real-world success rates of every action your agent takes. Over time, it builds a statistical model of what works best for each task, then injects that intelligence directly into your agent's context.

## Quick Start

```bash
npm install
npm run build
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "layerinfinite": {
      "command": "node",
      "args": ["/path/to/packages/mcp-server/dist/bin/cli.js"],
      "env": {
        "LAYERINFINITE_API_KEY": "layerinfinite_your_key_here",
        "LAYERINFINITE_BASE_URL": "https://layerinfinite.me"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "layerinfinite": {
      "command": "node",
      "args": ["./packages/mcp-server/dist/bin/cli.js"],
      "env": {
        "LAYERINFINITE_API_KEY": "layerinfinite_your_key_here",
        "LAYERINFINITE_BASE_URL": "https://layerinfinite.me",
        "LAYERINFINITE_MODE": "recommend"
      }
    }
  }
}
```

## Three Modes

### Bootstrap (default — no mode set)

Only logging tools are available. Your agent does its work normally and logs outcomes via `li_log`. LI learns from every outcome.

**Tools visible:** `li_log`, `li_observe`, `li_audit`, `li_health`

### Recommend (`LAYERINFINITE_MODE=recommend`)

LI injects scored recommendations into the agent's context via the `layerinfinite://tasks/{task}` resource BEFORE the agent reasons. The agent sees real production data and reasons from it.

**Additional tools:** `li_simulate`, `li_patterns`

### Assist (`LAYERINFINITE_MODE=assist`)

All action execution routes through `li_action`. LI intercepts and warns when a better-performing action exists with real evidence. The agent can still proceed with its original choice.

**Additional tools:** `li_action`, `li_fallback`

### Auto (`LAYERINFINITE_MODE=auto`)

`li_action` redirects to the statistically proven best action. The agent executes whatever LI returns. Requires stable recommendations with ≥90% confidence. Falls back to assist for low-confidence tasks.

**Additional tools:** `li_action`, `li_fallback`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LAYERINFINITE_API_KEY` | ✅ | Your API key from the dashboard |
| `LAYERINFINITE_BASE_URL` | ✅ | API URL (default: `https://layerinfinite.me`) |
| `LAYERINFINITE_MODE` | ❌ | `recommend`, `assist`, or `auto` |
| `LAYERINFINITE_ADMIN_KEY` | ❌ | Enables admin tools |

## Tools Reference

| Tool | Modes | Description |
|------|-------|-------------|
| `li_log` | All | Log action outcome |
| `li_observe` | All | Get task statistics |
| `li_audit` | All | Outcome audit trail |
| `li_health` | All | System health check |
| `li_action` | assist, auto | Decision layer gateway |
| `li_fallback` | assist, auto | Recovery after failure |
| `li_simulate` | recommend+ | Sequence prediction |
| `li_patterns` | recommend+ | Successful playbooks |
| `li_register_action` | admin | Register action |
| `li_toggle_action` | admin | Enable/disable action |
