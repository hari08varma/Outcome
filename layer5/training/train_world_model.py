"""
Layer5 — training/train_world_model.py
══════════════════════════════════════════════════════════════
Main training script. Run weekly via cron.
Reads from Supabase, trains LightGBM, validates,
and writes to world_model_artifacts if valid.

Idempotent: safe to run multiple times.
If run produces a worse model, the previous
active model remains active.
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
VALIDATION_SPLIT = 0.15  # 15% held out for validation
RANDOM_STATE = 42

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


def fetch_training_data(client):
    """
    Fetch all data needed for training from Supabase.
    Returns DataFrames for outcomes, sequences, counterfactuals.
    """
    import pandas as pd

    log.info("Fetching training data from Supabase...")

    # Fetch fact_outcomes
    outcomes_response = (
        client.table('fact_outcomes')
        .select(
            'id, agent_id, action_name, success, '
            'outcome_score, context_hash, episode_id, '
            'response_ms, created_at'
        )
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

    # Fetch counterfactuals (weighted training signal)
    # Only include high-enough weight to be useful
    cf_response = (
        client.table('fact_outcome_counterfactuals')
        .select(
            'unchosen_action_name, counterfactual_est, '
            'ips_weight, context_hash, created_at'
        )
        .gte('ips_weight', 0.05)
        .execute()
    )
    cf_df = pd.DataFrame(cf_response.data)

    log.info(
        f"Fetched {len(outcomes_df)} outcomes, "
        f"{len(sequences_df)} sequences, "
        f"{len(cf_df)} counterfactuals"
    )

    return outcomes_df, sequences_df, cf_df


def get_next_version(client) -> int:
    """Get next model version number (max existing + 1)."""
    response = (
        client.table('world_model_artifacts')
        .select('version')
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


def main():
    supabase_url = os.environ.get('SUPABASE_URL')
    supabase_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')

    if not supabase_url or not supabase_key:
        raise EnvironmentError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY "
            "must be set. Use .env file or environment variables."
        )

    client = create_client(supabase_url, supabase_key)

    # 1. Fetch data
    outcomes_df, sequences_df, cf_df = fetch_training_data(client)

    # 2. Build encodings
    action_encoding = build_action_encoding(outcomes_df)
    context_freqs = compute_context_frequencies(outcomes_df)

    # 3. Build feature matrix
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

    # 4. Train/validation split
    X_train, X_val, y_train, y_val, w_train, _ = train_test_split(
        X,
        y,
        weights,
        test_size=VALIDATION_SPLIT,
        random_state=RANDOM_STATE,
    )

    # 5. Train three quantile models
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

    # 6. Validate before deploying
    log.info("Validating model...")
    validation = validate_model(
        q50_model, q025_model, q975_model, X_val, y_val
    )

    log.info(
        f"Validation results: "
        f"R²={validation.r2_score:.3f}, "
        f"RMSE={validation.rmse:.3f}, "
        f"Coverage={validation.coverage_95:.3f}, "
        f"Width={validation.avg_interval_width:.3f}"
    )

    if not validation.passed:
        log.error("Model FAILED validation. Not deploying.")
        for reason in validation.failure_reasons:
            log.error(f"  Failure: {reason}")
        raise ValueError(
            "Model validation failed. "
            "Previous model remains active. "
            "See failure reasons above."
        )

    log.info("Model passed validation. Deploying...")

    # 7. Export to JSON
    version = get_next_version(client)
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

    # 8. Write to world_model_artifacts
    metrics = {
        'r2_score': validation.r2_score,
        'rmse': validation.rmse,
        'mae': validation.mae,
        'coverage_95': validation.coverage_95,
        'avg_interval_width': validation.avg_interval_width,
    }

    insert_response = (
        client.table('world_model_artifacts')
        .insert(
            {
                'version': version,
                'tier': 2,
                'model_data': model_json,
                'training_episodes': len(outcomes_df),
                'counterfactual_episodes': len(cf_df),
                'metrics': metrics,
                'is_active': False,  # activate separately
                'trained_at': trained_at,
            }
        )
        .execute()
    )

    new_model_id = insert_response.data[0]['id']

    # 9. Activate the new model (atomically deactivates previous)
    client.rpc(
        'activate_world_model', {'p_model_id': new_model_id}
    ).execute()

    # 10. Update is_active flag to trigger cache invalidation
    # via Supabase Realtime (edge function listens for this)
    (
        client.table('world_model_artifacts')
        .update({'is_active': True})
        .eq('id', new_model_id)
        .execute()
    )

    log.info(
        f"Successfully deployed model v{version}. "
        f"Trained on {len(outcomes_df)} episodes. "
        f"R²={validation.r2_score:.3f}"
    )


if __name__ == '__main__':
    main()
