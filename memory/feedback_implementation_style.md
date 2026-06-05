---
name: Implementation style — careful, read-first, no mistakes
description: User expects thorough file reading before any edits, careful targeted changes, no regressions
type: feedback
---

Read every file completely before planning. Plan explicitly before touching code. Make surgical edits only — never rewrite more than needed.

**Why:** User validated this approach after a 4-fix implementation session (exploration floor, data resilience, trust UX, auto graduation) all executed perfectly on first attempt with no regressions.

**How to apply:** Always read full file content before editing. State the plan clearly. Make one focused change at a time. Verify with grep after edits to confirm all touch points are consistent.
