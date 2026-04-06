# Noise-Aware Evidence Gate v1

## Objective
Ship a strict, feature-flagged rollout that:
- Detects noisy tasks.
- Requires more evidence on noisy tasks before stronger recommendations.
- Uses simulation/counterfactual shadow signal only as bounded support.
- Caps confidence and blocks exploit-style recommendations when simulation influence is still high.
- Enforces runtime safety in `/v1/get-scores` and SDK auto execution order.

## Feature Flags (all default OFF)
- `LI_FEATURE_NOISE_AWARE_EVIDENCE_GATE_V1`
- `LI_FEATURE_SIMULATION_SHADOW_V1`
- `LI_FEATURE_SIMULATION_CONFIDENCE_CEILING_V1`
- `LI_FEATURE_SIMULATION_EXPLOIT_GATE_V1`

## Default Thresholds (v1)
- Noise detection:
- `LI_NOISE_WIN_RATE_LOWER=0.40`
- `LI_NOISE_WIN_RATE_UPPER=0.55`
- `LI_NOISE_GAP_MAX=0.10`
- `LI_NOISE_SCORE_THRESHOLD=0.55`
- Evidence thresholds:
- Normal warmup: `10` effective samples.
- Noisy warmup: `30` effective samples.
- Stable threshold: `50` effective samples.
- High-confidence target: `100` normal / `150` noisy.
- Simulation shadow blending:
- `LI_SIMULATION_SHADOW_BLEND_CAP=0.20`
- `LI_SIMULATION_SHADOW_BLEND_UNTIL_SAMPLES=30`
- Confidence ceiling:
- `LI_SIMULATION_CONFIDENCE_CEILING=0.65`
- Exploit gate:
- `LI_SIMULATION_EXPLOIT_GATE_MIN_SAMPLES=60`

## Rollout Plan
1. Stage A: metadata only
- Enable `LI_FEATURE_NOISE_AWARE_EVIDENCE_GATE_V1=true` in staging.
- Keep all simulation flags OFF.
- Verify response fields `noise_gate` and `simulation_guardrail` are present and sane.

2. Stage B: noisy-task gating
- Keep simulation flags OFF.
- Confirm noisy tasks require `30+` effective samples before leaving strict warmup behavior.

3. Stage C: simulation shadow support
- Enable `LI_FEATURE_SIMULATION_SHADOW_V1=true`.
- Keep ceiling and exploit gate ON before production expansion.

4. Stage D: confidence and exploit safety
- Enable `LI_FEATURE_SIMULATION_CONFIDENCE_CEILING_V1=true`.
- Enable `LI_FEATURE_SIMULATION_EXPLOIT_GATE_V1=true`.
- Confirm recommendations stay in monitor mode when simulation influence is high and real evidence is thin.

## Acceptance Tests
1. Unit tests
```bash
cd layer5/api
npm test -- tests/layer3/recommendation-engine.test.ts tests/layer3/recommendation-outcome-weighting.test.ts tests/layer3/recommendation-scope-transition.test.ts
```

2. Type check
```bash
cd layer5/api
npm run typecheck
```

3. Functional checks (manual)
- Query `GET /v1/recommendations?task=<task>`.
- Validate fields:
- `noise_gate.is_noisy_task`
- `noise_gate.task_noise_score`
- `noise_gate.effective_samples`
- `noise_gate.required_samples`
- `noise_gate.decision_gate_reason`
- `simulation_guardrail.shadow_applied`
- `simulation_guardrail.confidence_ceiling_applied`
- `simulation_guardrail.exploit_gate_applied`

## Go/No-Go
- GO when tests pass, typecheck passes, and noisy tasks remain monitor-first under thin data.
- NO-GO when noisy tasks produce direct replacement recommendations before required effective sample thresholds.
