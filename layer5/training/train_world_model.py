"""
Layerinfinite — training/train_world_model.py
══════════════════════════════════════════════════════════════
Main training script. Run weekly via cron or on-demand.
Reads from Supabase, trains LightGBM, validates,
and writes to world_model_artifacts as a canary for review.

Additions vs. original:
  - Minimum CF sample gate (MIN_CF_SAMPLES, default 500)
  - Doubly-robust (DR) counterfactual targets
  - Distribution drift guard (KL divergence, real vs CF data)
  - Performance gates vs current active model (r2, mae, coverage)
  - Canary deploy — writes is_canary=True, NOT is_active=True
    Promotion to production is a separate manual/automated step.

Idempotent: safe to run multiple times. If training fails gates,
the previous active model remains active.
══════════════════════════════════════════════════════════════
"""

import os
import json
import logging
from datetime import datetime, timezone

import numpy as np
import lightgbm as lgb
from sklearn.model_selection import train_test_split
from supabase import create_client
from dotenv import load_dotenv

from features import (
    build_action_encoding,
    compute_context_frequencies,
    build_training_data,
)
from export_model import export_quantile_models
from validate_model import validate_model

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
)
log = logging.getLogger(__name__)

MIN_TRAINING_EPISODES = 200
MIN_CF_SAMPLES = int(os.environ.get('MIN_CF_SAMPLES', '500'))  # new CF since last run
VALIDATION_SPLIT = 0.15  # 15% held out for validation
RANDOM_STATE = 42

# Performance gate tolerances vs current active model
PERF_GATE_R2_DELTA = -0.01      # candidate r2 >= current_r2 - 0.01
PERF_GATE_MAE_FACTOR = 1.05     # candidate mae <= current_mae * 1.05
PERF_GATE_COVERAGE_MIN = 0.88   # coverage must be >= 0.88

LGBM_PARAMS_BASE = {
    'boosting_type': 'gbdt',
    'num_leaves': 31,
    'learning_rate': 0.05,
    'n_estimators': 200,
    'min_child_samples': 10,
    'subsample': 0.8,
    'colsample_bytree': 0.8,
    'reg_alpha': 0.1,
    'reg_lambda': 0.1,
    'random_state': RANDOM_STATE,
    'n_jobs': -1,
    'verbose': -1,
}


# ── Sample gate ───────────────────────────────────────────────

def fetch_last_model_info(client, customer_id: str):
    """
    Returns (trained_at, metrics) for the current active model for this customer, or
    (None, None) if no model has been trained yet.
    """
    response = (
        client.table('world_model_artifacts')
        .select('trained_at, metrics, version')
        .eq('tier', 2)
        .eq('is_active', True)
        .eq('customer_id', customer_id)
        .order('version', desc=True)
        .limit(1)
        .execute()
    )

    if not response.data:
        return None, None

    row = response.data[0]
    return row.get('trained_at'), row.get('metrics')


def count_new_cf_samples(client, since_iso: str | None, customer_id: str) -> int:
    """
    Count counterfactual samples created since the last training run for this customer.
    If since_iso is None (no previous model), count all samples.
    """
    query = (
        client.table('fact_outcome_counterfactuals')
        .select('id', count='exact')
        .gte('ips_weight', 0.05)
        .eq('customer_id', customer_id)
    )

    if since_iso:
        query = query.gte('created_at', since_iso)

    response = query.execute()
    return response.count or 0


# ── Data fetching ─────────────────────────────────────────────

def fetch_training_data(client, customer_id: str):
    """
    Fetch all data needed for training from Supabase, scoped to customer_id.
    Returns DataFrames for outcomes, sequences, counterfactuals.
    Counterfactuals include real_outcome_score for DR computation.
    """
    import pandas as pd

    log.info(f"Fetching training data from Supabase for customer_id={customer_id}...")

    # Fetch fact_outcomes scoped to this customer
    outcomes_response = (
        client.table('fact_outcomes')
        .select(
            'id, agent_id, action_name, success, '
            'outcome_score, context_hash, episode_id, '
            'response_ms, created_at'
        )
        .eq('customer_id', customer_id)
        .execute()
    )

    outcomes_df = pd.DataFrame(outcomes_response.data)

    if len(outcomes_df) < MIN_TRAINING_EPISODES:
        raise ValueError(
            f"Insufficient training data: {len(outcomes_df)} outcomes. "
            f"Minimum required: {MIN_TRAINING_EPISODES}. "
            f"Collect more real episodes before training."
        )

    # Fetch action_sequences (for episode position features)
    sequences_response = (
        client.table('action_sequences')
        .select('episode_id, action_sequence')
        .not_.is_('closed_at', 'null')
        .execute()
    )
    sequences_df = pd.DataFrame(sequences_response.data)

    # Fetch counterfactuals with real_outcome_score for DR computation, scoped to this customer
    cf_response = (
        client.table('fact_outcome_counterfactuals')
        .select(
            'real_outcome_id, unchosen_action_name, counterfactual_est, '
            'ips_weight, real_outcome_score, context_hash, created_at'
        )
        .gte('ips_weight', 0.05)
        .eq('customer_id', customer_id)
        .execute()
    )
    cf_df = pd.DataFrame(cf_response.data)

    # Join CF with outcomes to get the chosen action name (needed for DR)
    if not cf_df.empty and not outcomes_df.empty:
        outcome_lookup = outcomes_df[['id', 'action_name', 'outcome_score']].copy()
        outcome_lookup.columns = ['real_outcome_id', 'chosen_action_name', 'observed_score']
        cf_df = cf_df.merge(outcome_lookup, on='real_outcome_id', how='left')

    log.info(
        f"Fetched {len(outcomes_df)} outcomes, "
        f"{len(sequences_df)} sequences, "
        f"{len(cf_df)} counterfactuals"
    )

    return outcomes_df, sequences_df, cf_df


# ── Doubly-robust estimator ───────────────────────────────────

def compute_dr_targets(cf_df, outcomes_df) -> np.ndarray:
    """
    Compute doubly-robust (DR) training targets for counterfactual samples.

    DR formula:
      DR(a') = mu_hat(a') + w * (r_obs - mu_hat(a_chosen))

    Where:
      mu_hat(a')       = empirical mean reward for the unchosen action
                         (direct model estimate using observed data)
      mu_hat(a_chosen) = empirical mean reward for the chosen action
      w                = IPS weight (p_unchosen / p_chosen)
      r_obs            = observed reward for the chosen action

    Using empirical action means as mu_hat is a valid DR baseline that
    dramatically reduces IPS variance vs raw importance weighting.
    """
    import pandas as pd

    # Empirical mean reward per action from real observed data
    action_mean_rewards = (
        outcomes_df.groupby('action_name')['outcome_score'].mean().to_dict()
    )
    global_mean = float(outcomes_df['outcome_score'].mean())

    dr_targets = []
    for _, row in cf_df.iterrows():
        mu_hat_unchosen = action_mean_rewards.get(
            row['unchosen_action_name'], global_mean
        )
        mu_hat_chosen = action_mean_rewards.get(
            row.get('chosen_action_name', ''), global_mean
        )
        w = float(row['ips_weight'])
        # Use observed_score if available (including 0.0), else fall back safely.
        observed = row.get('observed_score', None)
        if observed is not None and not pd.isna(observed):
            r_obs = float(observed)
        else:
            fallback = row.get('real_outcome_score', global_mean)
            r_obs = float(global_mean if pd.isna(fallback) else fallback)

        # DR correction: direct model estimate + IPS-weighted residual
        dr_target = mu_hat_unchosen + w * (r_obs - mu_hat_chosen)
        dr_targets.append(float(np.clip(dr_target, 0.0, 1.0)))

    return np.array(dr_targets)


# ── Distribution drift guard ──────────────────────────────────

def compute_distribution_drift(X_real: np.ndarray, X_cf: np.ndarray) -> float:
    """
    Compute a distribution drift score between real and counterfactual
    feature matrices using symmetric KL divergence approximated via
    per-feature histogram comparison.

    Returns a float >= 0 where 0 means identical distributions.
    High values (> 1.0) indicate counterfactual samples are from
    a significantly different distribution than real data.

    This is a warning-only guard — high drift does not block training.
    """
    if X_real.shape[0] == 0 or X_cf.shape[0] == 0:
        return 0.0

    n_features = min(X_real.shape[1], X_cf.shape[1])
    kl_scores = []

    for feat_idx in range(n_features):
        real_col = X_real[:, feat_idx]
        cf_col = X_cf[:, feat_idx]

        # Use shared bin edges across both distributions
        combined = np.concatenate([real_col, cf_col])
        if combined.size == 0:
            continue
        if np.isclose(combined.min(), combined.max()):
            # Constant feature in both sets: zero divergence contribution.
            kl_scores.append(0.0)
            continue
        bins = np.linspace(combined.min(), combined.max(), 20)

        real_hist, _ = np.histogram(real_col, bins=bins, density=True)
        cf_hist, _ = np.histogram(cf_col, bins=bins, density=True)

        # Add small epsilon to avoid log(0)
        eps = 1e-10
        real_hist = real_hist + eps
        cf_hist = cf_hist + eps

        # Normalize to probability distributions
        real_hist = real_hist / real_hist.sum()
        cf_hist = cf_hist / cf_hist.sum()

        # Symmetric KL divergence: KL(P||Q) + KL(Q||P)
        kl_pq = float(np.sum(real_hist * np.log(real_hist / cf_hist)))
        kl_qp = float(np.sum(cf_hist * np.log(cf_hist / real_hist)))
        kl_scores.append((kl_pq + kl_qp) / 2)

    return float(np.mean(kl_scores)) if kl_scores else 0.0


# ── Performance gates ─────────────────────────────────────────

def check_performance_gates(validation, current_metrics: dict | None) -> list[str]:
    """
    Check candidate model performance against current active model.
    Returns list of failure reasons (empty = all gates passed).

    Gates:
      r2  >= current_r2 - 0.01   (no more than 1% regression)
      mae <= current_mae * 1.05  (no more than 5% regression)
      coverage >= 0.88           (absolute floor regardless of current model)
    """
    failures = []

    if current_metrics:
        current_r2 = current_metrics.get('r2_score', 0.0)
        current_mae = current_metrics.get('mae', 1.0)

        if validation.r2_score < current_r2 + PERF_GATE_R2_DELTA:
            failures.append(
                f"R² regression: candidate {validation.r2_score:.3f} < "
                f"current {current_r2:.3f} - {abs(PERF_GATE_R2_DELTA):.2f} "
                f"(gate: {current_r2 + PERF_GATE_R2_DELTA:.3f})"
            )

        if current_mae > 0 and validation.mae > current_mae * PERF_GATE_MAE_FACTOR:
            failures.append(
                f"MAE regression: candidate {validation.mae:.3f} > "
                f"current {current_mae:.3f} * {PERF_GATE_MAE_FACTOR} "
                f"(gate: {current_mae * PERF_GATE_MAE_FACTOR:.3f})"
            )

    if validation.coverage_95 < PERF_GATE_COVERAGE_MIN:
        failures.append(
            f"Coverage below floor: {validation.coverage_95:.3f} < {PERF_GATE_COVERAGE_MIN}"
        )

    return failures


# ── Model utilities ───────────────────────────────────────────

def get_next_version(client, customer_id: str) -> int:
    """Get next model version number for this customer (max existing + 1)."""
    response = (
        client.table('world_model_artifacts')
        .select('version')
        .eq('customer_id', customer_id)
        .order('version', desc=True)
        .limit(1)
        .execute()
    )

    if not response.data:
        return 1
    return response.data[0]['version'] + 1


def train_quantile_model(
    X: np.ndarray,
    y: np.ndarray,
    weights: np.ndarray,
    alpha: float,
    X_val: np.ndarray | None = None,
    y_val: np.ndarray | None = None,
) -> lgb.LGBMRegressor:
    """
    Train one quantile regression model.
    If validation data is provided, uses early stopping.
    """
    params = {
        **LGBM_PARAMS_BASE,
        'objective': 'quantile',
        'alpha': alpha,
        'metric': 'quantile',
    }

    model = lgb.LGBMRegressor(**params)

    fit_kwargs: dict = {'sample_weight': weights}
    if X_val is not None and y_val is not None:
        fit_kwargs['eval_set'] = [(X_val, y_val)]
        fit_kwargs['callbacks'] = [lgb.early_stopping(20, verbose=False)]

    model.fit(X, y, **fit_kwargs)
    return model


# ── Main ──────────────────────────────────────────────────────

def main(force: bool = False, customer_id: str | None = None):
    """
    Run the full training pipeline for a specific customer.

    Args:
        force: If True, bypass the CF sample gate.
               Used by the admin trigger-training endpoint.
        customer_id: UUID of the customer to train for (required).
                     Training is always per-customer to prevent cross-tenant data contamination.
    """
    if not customer_id:
        customer_id = os.environ.get('CUSTOMER_ID', '')
    if not customer_id:
        raise ValueError(
            "customer_id is required. Pass it as a parameter or set the CUSTOMER_ID env var. "
            "Training must be scoped per customer to prevent cross-tenant data contamination."
        )
    supabase_url = os.environ.get('SUPABASE_URL')
    supabase_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')

    if not supabase_url or not supabase_key:
        raise EnvironmentError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY "
            "must be set. Use .env file or environment variables."
        )

    client = create_client(supabase_url, supabase_key)

    # 1. Check when the last model was trained + fetch its metrics
    last_trained_at, current_metrics = fetch_last_model_info(client, customer_id)
    log.info(
        f"Current active model: trained_at={last_trained_at}, "
        f"metrics={current_metrics}"
    )

    # 2. Sample gate: require MIN_CF_SAMPLES new counterfactuals since last run
    new_cf_count = count_new_cf_samples(client, last_trained_at, customer_id)
    log.info(
        f"New counterfactual samples since last training: {new_cf_count} "
        f"(threshold: {MIN_CF_SAMPLES}, force={force})"
    )

    if not force and new_cf_count < MIN_CF_SAMPLES:
        log.info(
            f"Sample gate not met — skipping training. "
            f"Have {new_cf_count} new samples, need {MIN_CF_SAMPLES}. "
            f"Use force=True or wait for more data."
        )
        return {
            'skipped': True,
            'skip_reason': 'insufficient_samples',
            'new_cf_count': new_cf_count,
            'threshold': MIN_CF_SAMPLES,
        }

    # 3. Fetch data
    outcomes_df, sequences_df, cf_df = fetch_training_data(client, customer_id)

    # 4. Compute doubly-robust targets for counterfactual data
    dr_used = False
    if not cf_df.empty and 'ips_weight' in cf_df.columns:
        log.info("Computing doubly-robust targets for counterfactual samples...")
        cf_df['dr_target'] = compute_dr_targets(cf_df, outcomes_df)
        # Replace counterfactual_est with DR target for training
        cf_df['counterfactual_est'] = cf_df['dr_target']
        dr_used = True
        log.info(
            f"DR targets computed — mean={cf_df['dr_target'].mean():.3f}, "
            f"std={cf_df['dr_target'].std():.3f}"
        )

    # 5. Build encodings and feature matrix
    action_encoding = build_action_encoding(outcomes_df)
    context_freqs = compute_context_frequencies(outcomes_df)

    log.info("Building feature matrix...")
    X, y, weights = build_training_data(
        outcomes_df,
        sequences_df,
        cf_df,
        action_encoding,
        context_freqs,
    )

    log.info(
        f"Training matrix: {X.shape[0]} samples, "
        f"{X.shape[1]} features "
        f"({len(outcomes_df)} real + "
        f"{len(cf_df)} counterfactual)"
    )

    # 6. Distribution drift guard — compare real vs CF feature distributions
    drift_score = 0.0
    if len(outcomes_df) > 0 and len(cf_df) > 0:
        X_real = X[:len(outcomes_df)]
        X_cf = X[len(outcomes_df):]
        drift_score = compute_distribution_drift(X_real, X_cf)
        if drift_score > 1.0:
            log.warning(
                f"[drift-guard] High feature distribution drift detected: "
                f"score={drift_score:.3f}. Counterfactual samples differ "
                f"significantly from real data distribution. "
                f"Training continues — monitor model quality carefully."
            )
        else:
            log.info(f"Distribution drift score: {drift_score:.3f} (healthy < 1.0)")

    # 7. Train/validation split
    X_train, X_val, y_train, y_val, w_train, _ = train_test_split(
        X,
        y,
        weights,
        test_size=VALIDATION_SPLIT,
        random_state=RANDOM_STATE,
    )

    # 8. Train three quantile models
    log.info("Training q50 model (median)...")
    q50_model = train_quantile_model(
        X_train, y_train, w_train, 0.50, X_val, y_val
    )

    log.info("Training q025 model (lower bound)...")
    q025_model = train_quantile_model(
        X_train, y_train, w_train, 0.025, X_val, y_val
    )

    log.info("Training q975 model (upper bound)...")
    q975_model = train_quantile_model(
        X_train, y_train, w_train, 0.975, X_val, y_val
    )

    # 9. Validate candidate model (absolute quality gates)
    log.info("Validating model (absolute quality gates)...")
    validation = validate_model(
        q50_model, q025_model, q975_model, X_val, y_val
    )

    log.info(
        f"Validation results: "
        f"R²={validation.r2_score:.3f}, "
        f"RMSE={validation.rmse:.3f}, "
        f"MAE={validation.mae:.3f}, "
        f"Coverage={validation.coverage_95:.3f}, "
        f"Width={validation.avg_interval_width:.3f}"
    )

    if not validation.passed:
        log.error("Model FAILED absolute validation gates. Not deploying.")
        for reason in validation.failure_reasons:
            log.error(f"  Failure: {reason}")
        return {
            'skipped': False,
            'deployed': False,
            'fail_reason': 'absolute_validation_failed',
            'failures': validation.failure_reasons,
            'metrics': {
                'r2_score': validation.r2_score,
                'rmse': validation.rmse,
                'mae': validation.mae,
                'coverage_95': validation.coverage_95,
            },
        }

    # 10. Performance gates — candidate must not regress vs current active model
    log.info("Checking performance gates vs current active model...")
    perf_failures = check_performance_gates(validation, current_metrics)

    if perf_failures:
        log.error("Model FAILED performance gates vs current active model.")
        for reason in perf_failures:
            log.error(f"  Gate failure: {reason}")
        return {
            'skipped': False,
            'deployed': False,
            'fail_reason': 'performance_gate_failed',
            'failures': perf_failures,
            'metrics': {
                'r2_score': validation.r2_score,
                'mae': validation.mae,
                'coverage_95': validation.coverage_95,
            },
        }

    log.info("All gates passed. Deploying as canary...")

    # 11. Export to JSON
    version = get_next_version(client, customer_id)
    trained_at = datetime.now(timezone.utc).isoformat()

    model_json = export_quantile_models(
        q50_model,
        q025_model,
        q975_model,
        action_encoding=action_encoding,
        context_encoding={},  # reserved for future use
        learning_rate=LGBM_PARAMS_BASE['learning_rate'],
        version=version,
        trained_at=trained_at,
    )

    # 12. Write to world_model_artifacts as CANARY (not active)
    metrics = {
        'r2_score': validation.r2_score,
        'rmse': validation.rmse,
        'mae': validation.mae,
        'coverage_95': validation.coverage_95,
        'avg_interval_width': validation.avg_interval_width,
    }

    gate_results = {
        'absolute_validation': {'passed': True},
        'performance_gates': {'passed': True, 'vs_version': None if not current_metrics else 'current_active'},
        'dr_estimate_used': dr_used,
        'drift_score': round(drift_score, 4),
        'new_cf_count': new_cf_count,
        'perf_failures': perf_failures,
    }

    canary_traffic_pct = int(os.environ.get('CANARY_TRAFFIC_PCT', '10'))

    insert_response = (
        client.table('world_model_artifacts')
        .insert(
            {
                'version': version,
                'tier': 2,
                'customer_id': customer_id,
                'model_data': model_json,
                'training_episodes': len(outcomes_df),
                'counterfactual_episodes': len(cf_df),
                'metrics': metrics,
                'sample_count': len(X),
                'dr_estimate_used': dr_used,
                'drift_score': round(drift_score, 4),
                'is_active': False,    # NOT activated — canary only
                'is_canary': True,
                'canary_traffic_pct': canary_traffic_pct,
                'training_timestamp': trained_at,
                'gate_results': gate_results,
                'trained_at': trained_at,
            }
        )
        .execute()
    )

    new_model_id = insert_response.data[0]['id']

    log.info(
        f"Deployed model v{version} as canary (id={new_model_id}). "
        f"Traffic: {canary_traffic_pct}% of requests. "
        f"R²={validation.r2_score:.3f}, MAE={validation.mae:.3f}, "
        f"DR={dr_used}, drift_score={drift_score:.3f}. "
        f"Promote via: UPDATE world_model_artifacts SET is_active=TRUE, "
        f"is_canary=FALSE WHERE id={new_model_id}"
    )

    return {
        'skipped': False,
        'deployed': True,
        'model_id': new_model_id,
        'version': version,
        'is_canary': True,
        'canary_traffic_pct': canary_traffic_pct,
        'metrics': metrics,
        'gate_results': gate_results,
    }


if __name__ == '__main__':
    import sys
    force_flag = '--force' in sys.argv
    # Accept --customer-id <uuid> or fall back to CUSTOMER_ID env var
    cid = None
    if '--customer-id' in sys.argv:
        idx = sys.argv.index('--customer-id')
        if idx + 1 < len(sys.argv):
            cid = sys.argv[idx + 1]
    result = main(force=force_flag, customer_id=cid)
    print(json.dumps(result, indent=2, default=str))
