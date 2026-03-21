"""
Layerinfinite — training/counterfactual_retraining.py
══════════════════════════════════════════════════════════════
Idempotent orchestration script for automated counterfactual
retraining. Called by:
  - pg_cron weekly schedule (via admin_cron_log trigger)
  - POST /v1/admin/trigger-training API endpoint
  - Manual: python counterfactual_retraining.py [--force]

Logic:
  1. Check new CF sample count since last training
  2. If count >= MIN_CF_SAMPLES (or --force), call train_world_model.main()
  3. Emit structured JSON log at every stage

Safe to call multiple times — training only runs if the sample
gate is met. Designed to run unattended via cron.
══════════════════════════════════════════════════════════════
"""

import os
import sys
import json
import logging
from datetime import datetime, timezone

from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
)
log = logging.getLogger(__name__)

MIN_CF_SAMPLES = int(os.environ.get('MIN_CF_SAMPLES', '500'))


def emit(stage: str, status: str, **kwargs):
    """Emit a structured JSON log line for observability."""
    record = {
        'service': 'counterfactual_retraining',
        'stage': stage,
        'status': status,
        'timestamp': datetime.now(timezone.utc).isoformat(),
        **kwargs,
    }
    print(json.dumps(record), flush=True)


def run(force: bool = False) -> dict:
    """
    Main orchestration entry point.

    Returns a result dict suitable for JSON serialization.
    Never raises — all errors are caught and returned as structured output.
    """
    emit('start', 'running', force=force, min_cf_samples=MIN_CF_SAMPLES)

    # ── Validate environment ──────────────────────────────────
    supabase_url = os.environ.get('SUPABASE_URL')
    supabase_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')

    if not supabase_url or not supabase_key:
        result = {
            'skipped': True,
            'skip_reason': 'missing_env_vars',
            'detail': 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set',
        }
        emit('env_check', 'failed', **result)
        return result

    # ── Check sample gate ─────────────────────────────────────
    try:
        client = create_client(supabase_url, supabase_key)

        # Get last training timestamp
        model_response = (
            client.table('world_model_artifacts')
            .select('trained_at, version, metrics')
            .eq('tier', 2)
            .eq('is_active', True)
            .order('version', desc=True)
            .limit(1)
            .execute()
        )

        last_trained_at = None
        current_version = None
        if model_response.data:
            last_trained_at = model_response.data[0].get('trained_at')
            current_version = model_response.data[0].get('version')

        # Count new CF samples since last training
        cf_query = (
            client.table('fact_outcome_counterfactuals')
            .select('id', count='exact')
            .gte('ips_weight', 0.05)
        )
        if last_trained_at:
            cf_query = cf_query.gte('created_at', last_trained_at)

        cf_response = cf_query.execute()
        new_cf_count = cf_response.count or 0

        emit(
            'sample_gate',
            'checking',
            new_cf_count=new_cf_count,
            threshold=MIN_CF_SAMPLES,
            last_trained_at=last_trained_at,
            current_version=current_version,
            force=force,
        )

        if not force and new_cf_count < MIN_CF_SAMPLES:
            result = {
                'skipped': True,
                'skip_reason': 'insufficient_samples',
                'new_cf_count': new_cf_count,
                'threshold': MIN_CF_SAMPLES,
                'last_trained_at': last_trained_at,
                'current_version': current_version,
            }
            emit('sample_gate', 'not_met', **result)
            return result

        emit(
            'sample_gate',
            'passed',
            new_cf_count=new_cf_count,
            threshold=MIN_CF_SAMPLES,
            force=force,
        )

    except Exception as exc:
        result = {
            'skipped': True,
            'skip_reason': 'sample_check_error',
            'error': str(exc),
        }
        emit('sample_gate', 'error', **result)
        log.exception("Failed to check sample gate")
        return result

    # ── Run training ──────────────────────────────────────────
    emit('training', 'starting', force=force)

    try:
        # Import here to avoid loading heavy ML deps if gate not met
        from train_world_model import main as train_main

        training_result = train_main(force=force)
        training_result = training_result or {}

        if training_result.get('skipped'):
            emit('training', 'skipped', **training_result)
        elif training_result.get('deployed'):
            emit(
                'training',
                'deployed',
                model_id=training_result.get('model_id'),
                version=training_result.get('version'),
                is_canary=training_result.get('is_canary'),
                canary_traffic_pct=training_result.get('canary_traffic_pct'),
                metrics=training_result.get('metrics'),
            )
        else:
            emit(
                'training',
                'failed',
                fail_reason=training_result.get('fail_reason'),
                failures=training_result.get('failures'),
            )

        emit('done', 'complete', result=training_result.get('deployed', False))
        return training_result

    except Exception as exc:
        result = {
            'skipped': False,
            'deployed': False,
            'error': str(exc),
            'fail_reason': 'training_exception',
        }
        emit('training', 'exception', error=str(exc))
        log.exception("Training raised an unhandled exception")
        return result


if __name__ == '__main__':
    force_flag = '--force' in sys.argv
    output = run(force=force_flag)
    # Final summary to stdout as JSON (in addition to structured logs above)
    print(json.dumps({'summary': output}, indent=2, default=str))
    # Exit code reflects deployment success
    sys.exit(0 if output.get('skipped') or output.get('deployed') else 1)
