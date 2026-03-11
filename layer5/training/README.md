# Layer5 — World Model Training Pipeline

Production training pipeline for the LightGBM world model
used by the 3-tier simulation engine.

## Overview

Trains three quantile regression models (q50, q025, q975) on
historical outcome data from Supabase. The trained model is
validated against quality thresholds before deployment. Invalid
models are rejected — the previous active model stays in place.

## Architecture

```
Supabase (fact_outcomes, action_sequences, counterfactuals)
    │
    ▼
features.py          ← Extract 10-feature vectors
    │
    ▼
train_world_model.py ← Train 3 LightGBM quantile models
    │
    ▼
validate_model.py    ← R², RMSE, coverage, interval width checks
    │
    ▼
export_model.py      ← Serialize to JSON matching TypeScript types
    │
    ▼
Supabase (world_model_artifacts) → TypeScript inference engine
```

## Feature Vector (10 features)

| Index | Name             | Type    | Description                     |
|-------|------------------|---------|---------------------------------|
| 0     | action_encoded   | int     | Alphabetically-sorted action ID |
| 1     | episode_position | int     | 0-based step in episode         |
| 2     | prev_action_1    | int     | Most recent previous action     |
| 3     | prev_action_2    | int     | 2nd previous action             |
| 4     | prev_action_3    | int     | 3rd previous action             |
| 5     | context_type_freq| float   | Normalized context frequency    |
| 6     | hour_sin         | float   | Cyclical hour encoding (sin)    |
| 7     | hour_cos         | float   | Cyclical hour encoding (cos)    |
| 8     | dow_sin          | float   | Cyclical day-of-week (sin)      |
| 9     | dow_cos          | float   | Cyclical day-of-week (cos)      |

**CRITICAL**: This order must match `buildFeatures()` in
`api/lib/simulation/world-model.ts`. Any change here
requires a matching change there.

## Validation Thresholds

| Metric              | Threshold | Description                       |
|---------------------|-----------|-----------------------------------|
| R²                  | ≥ 0.20    | Model explains >20% of variance   |
| RMSE                | ≤ 0.35    | Average prediction error           |
| 95% CI Coverage     | ≥ 0.85    | True values inside interval 85%+  |
| Avg Interval Width  | ≤ 0.60    | Intervals not pathologically wide  |

A model that fails any threshold is **never deployed**.

## Local Development

### Setup

```bash
cd training
python -m venv .venv
source .venv/bin/activate    # Linux/Mac
# .venv\Scripts\activate     # Windows

pip install -r requirements.txt
```

### Run Tests

```bash
pytest tests/ -v
```

### Train Locally (requires Supabase credentials)

```bash
cp .env.example .env
# Edit .env with your Supabase credentials

python train_world_model.py
```

### Environment Variables

| Variable                    | Required | Description                |
|-----------------------------|----------|----------------------------|
| `SUPABASE_URL`              | Yes      | Supabase project URL       |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes      | Service role key (not anon) |

## Docker

### Build

```bash
docker build -t layer5-training .
```

### Run

```bash
docker run --env-file .env layer5-training
```

Exit codes:
- `0` — Training succeeded, model deployed
- `1` — Training failed (validation failure or insufficient data)

## Railway Deployment

### Cron Job Setup

1. Create a new Railway service from this directory
2. Set the build command: `docker build -t layer5-training .`
3. Set environment variables in Railway dashboard:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. Configure as a **Cron Job** with schedule: `0 3 * * 0`
   (runs weekly at 3 AM UTC on Sundays)
5. Set restart policy to "Never" (idempotent — next cron run is the retry)

### Monitoring

Check Railway logs for training output. Key log lines:

```
Fetched 1500 outcomes, 300 sequences, 200 counterfactuals
Training matrix: 1700 samples, 10 features (1500 real + 200 counterfactual)
Validation results: R²=0.450, RMSE=0.220, Coverage=0.920, Width=0.350
Successfully deployed model v5. Trained on 1500 episodes. R²=0.450
```

### Manual Trigger

In Railway dashboard, use "Run Now" to trigger an immediate
training run outside the cron schedule.

## Idempotency

- Safe to run multiple times. Each run creates a new version.
- The `activate_world_model` RPC atomically swaps the active model.
- If validation fails, the previous active model remains unchanged.
- Version numbers are monotonically increasing (never reused).

## Model Format

The exported JSON matches the TypeScript `WorldModelArtifact` interface:

```json
{
  "q50":  { "trees": [...], "num_trees": 50 },
  "q025": { "trees": [...], "num_trees": 50 },
  "q975": { "trees": [...], "num_trees": 50 },
  "feature_names": ["action_encoded", ...],
  "num_features": 10,
  "action_encoding": { "update_app": 0, "restart_service": 1 },
  "context_encoding": {},
  "learning_rate": 0.05,
  "version": 5,
  "trained_at": "2026-03-11T03:00:00+00:00"
}
```
