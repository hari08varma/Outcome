---
name: Layerinfinite SDK — 4 fixes implemented and verified
description: Status of the 4 product-grade fixes to the Layerinfinite Python SDK v0.3.2
type: project
---

All 4 fixes implemented in the local SDK (`layer5/sdks/python/layerinfinite/`) and proof agent (`realworld_proof_agent.py`). User confirmed all four executed perfectly.

**Fix 1 — Exploration Floor:** `min_observations_per_action=20` param in `__init__`. `_build_execution_order` promotes least-observed action to front. Counts tracked in `_obs_counts` dict.

**Fix 2 — Data Resilience:** `normalize_business_outcome()` static method. Fuzzy action_name matching via `difflib.get_close_matches` in `log_outcome()`. Contradiction quarantine on `ingestion_quality.is_inconsistent`.

**Fix 3 — Trust UX:** `Suggestion` dataclass gains `outcomes_needed` + `cold_start` fields. Cold-start progress printed in `_fetch_scores`. Rich `LowConfidenceError` messages with gap/candidate/hint. `dispatch_auto` catches `LowConfidenceError` as `"li_abstained"` and logs outcome back to LI.

**Fix 4 — Auto Graduation:** `auto_graduate=False` param (opt-in). `_maybe_graduate()` maps trust_status → mode and switches `_mode` in place. Called after every log_outcome response (both async and public paths).

**Why:** User ran proof agent (`realworld_proof_agent.py`) across 200 baseline / 200 recommend / observe / 100 assist / 100 auto tickets. Identified exploration gap (payment_failed stuck at 38% confidence), data fragility, poor abstain UX, and no auto mode-switching.

**How to apply:** These fixes are in the local SDK only. If user asks about SDK behavior, these are the current capabilities. Zero-config SDK fix was planned but NOT implemented — deferred by user.
