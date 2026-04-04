# Go-Live Production Readiness Checklist

Use this checklist before every major release or go-live. Each item must be checked and signed off by the responsible team member.

Important: This checklist is evidence-based. Do not mark an item complete without a verifiable link, screenshot, or run ID.

---

## Reality Guardrails (Do Not Over-Claim)
- [ ] If independent fallback endpoints are not deployed yet, all release notes and customer-facing docs explicitly state single-endpoint operation
- [ ] "Endpoint Independence" section is only marked complete when architecture evidence is attached (provider/region + DNS/LB separation)

## Endpoint Independence
- [ ] All primary and fallback endpoints are hosted in different cloud regions/providers
- [ ] No shared DNS, load balancer, or infra dependencies between endpoints
- [ ] Endpoint infra separation is documented in the runbook
- [ ] Evidence attached (architecture diagram + endpoint inventory)

## Backend Version & Schema Sync
- [ ] All endpoints return identical backend version and schema hash
- [ ] CI/CD blocks deploys if any endpoint is out of sync
- [ ] Version check process is documented in the runbook

## Monitoring & Alerts
- [ ] Monitoring is in place for failover events, DNS failures, timeout spikes, and 5xx bursts
- [ ] Alerts are configured for all critical thresholds (email, Slack, PagerDuty, etc.)
- [ ] Real-time dashboard is available for system health
- [ ] Sentry alert rules configured with threshold and routing (error-rate, 5xx burst, timeout spike)
- [ ] External uptime polling is active on `/health` (UptimeRobot or equivalent) with on-call alert routing

## Failover Drills
- [ ] Regular failover drills are scheduled and logged
- [ ] Drills verify automatic SDK fallback and no user-facing errors
- [ ] Monitoring/alerts are tested during drills
- [ ] Drill results are reviewed and signed off

## Security Housekeeping
- [ ] All API keys/tokens in terminal/chat history have been rotated
- [ ] Secrets in code, CI, and infra have been audited for exposure
- [ ] All tokens use least-privilege principle
- [ ] Secret rotation process is documented and scheduled
- [ ] Rotation evidence captured (timestamp + owner + system)

## CI/CD & Release Pipeline
- [ ] All typecheck, test, and publish steps are atomic and fail-fast
- [ ] Required status checks are enforced for merges/releases
- [ ] All publish steps are automated and reproducible
- [ ] Release checklist is followed for every release
- [ ] GitHub Actions secrets use exact names: `NPM_TOKEN` and `PYPI_TOKEN` (no typo variants such as `NPM_TKOEN`)
- [ ] CI runs on push/PR for `master` or `main`
- [ ] Python SDK publish workflow runs pytest before build
- [ ] Legacy one-off release workflows are removed

## Automation & Documentation
- [ ] All above checks are automated where possible
- [ ] Go-Live Checklist is reviewed and signed off before every major release
- [ ] Pre-release summary posted (changes, residual risks, rollback, owner)

## Required Evidence Links
- [ ] Latest CI run URL: ______________________________
- [ ] Latest production-readiness run URL: _____________
- [ ] Sentry alerts dashboard URL: _____________________
- [ ] Uptime monitor/status page URL: _________________
- [ ] Release summary URL: ____________________________

---

**Sign-Off:**

- Release Manager: ____________________  Date: __________
- Dev Lead: __________________________  Date: __________
- QA Lead: ___________________________  Date: __________
- Security Lead: ______________________  Date: __________

---

_Keep this file up to date. Automation and regular review are key to "set and forget" production reliability._
