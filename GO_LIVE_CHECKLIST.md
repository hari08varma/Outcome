# Go-Live Production Readiness Checklist

Use this checklist before every major release or go-live. Each item must be checked and signed off by the responsible team member.

---

## Endpoint Independence
- [ ] All primary and fallback endpoints are hosted in different cloud regions/providers
- [ ] No shared DNS, load balancer, or infra dependencies between endpoints
- [ ] Endpoint infra separation is documented in the runbook

## Backend Version & Schema Sync
- [ ] All endpoints return identical backend version and schema hash
- [ ] CI/CD blocks deploys if any endpoint is out of sync
- [ ] Version check process is documented in the runbook

## Monitoring & Alerts
- [ ] Monitoring is in place for failover events, DNS failures, timeout spikes, and 5xx bursts
- [ ] Alerts are configured for all critical thresholds (email, Slack, PagerDuty, etc.)
- [ ] Real-time dashboard is available for system health

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

## CI/CD & Release Pipeline
- [ ] All typecheck, test, and publish steps are atomic and fail-fast
- [ ] Required status checks are enforced for merges/releases
- [ ] All publish steps are automated and reproducible
- [ ] Release checklist is followed for every release

## Automation & Documentation
- [ ] All above checks are automated where possible
- [ ] Go-Live Checklist is reviewed and signed off before every major release

---

**Sign-Off:**

- Release Manager: ____________________  Date: __________
- Dev Lead: __________________________  Date: __________
- QA Lead: ___________________________  Date: __________
- Security Lead: ______________________  Date: __________

---

_Keep this file up to date. Automation and regular review are key to "set and forget" production reliability._
