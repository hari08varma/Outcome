# Training Pipeline Deployment

## Option 1: Google Cloud Run (recommended)

### Build and push container:

```bash
PROJECT_ID=[your-gcp-project]
docker build -t gcr.io/$PROJECT_ID/layerinfinite-training .
docker push gcr.io/$PROJECT_ID/layerinfinite-training
```

### Create Cloud Run Job:

```bash
gcloud run jobs create layerinfinite-world-model-trainer \
  --image gcr.io/$PROJECT_ID/layerinfinite-training \
  --region asia-south1 \
  --memory 2Gi \
  --cpu 2 \
  --set-secrets SUPABASE_URL=SUPABASE_URL:latest \
  --set-secrets SUPABASE_SERVICE_ROLE_KEY=\
    SUPABASE_SERVICE_ROLE_KEY:latest
```

### Schedule weekly run:

```bash
gcloud scheduler jobs create http \
  layerinfinite-training-weekly \
  --schedule "0 2 * * 0" \
  --uri https://[region]-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/[project]/jobs/layerinfinite-world-model-trainer:run \
  --http-method POST \
  --location asia-south1
```
*(Runs every Sunday at 2 AM)*

### Manual run:

```bash
gcloud run jobs execute layerinfinite-world-model-trainer
```

## Option 2: Railway cron (simpler, less control)

In Railway: Deploy the training container.
Set a cron schedule: `0 2 * * 0` (weekly)
Set env vars: `SUPABASE_URL` + `SERVICE_ROLE_KEY`

## Option 3: Run locally when needed

```bash
cd training/
pip install -r requirements.txt
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python train_world_model.py
```

## When to train:

First run: when `fact_outcomes` count >= 200
After that: weekly (Cloud Run scheduler)
Or: after a major context type accumulates 200+ new outcomes (use `/v1/admin/trigger-training` to check readiness)

## Validation gates (from validate_model.py):

R² ≥ 0.20 — model must have signal
RMSE ≤ 0.35 — predictions must be accurate enough
Coverage ≥ 0.85 — confidence intervals must be honest
Width ≤ 0.60 — intervals must not be uselessly wide

If any gate fails: previous model stays active.
Training is completely safe to run anytime — a failed validation never degrades predictions.
