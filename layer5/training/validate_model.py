"""
Layer5 — training/validate_model.py
══════════════════════════════════════════════════════════════
Validate the trained model before deploying.
A model that fails validation is NEVER deployed.
This prevents bad models from corrupting predictions.
══════════════════════════════════════════════════════════════
"""

import numpy as np
import lightgbm as lgb
from dataclasses import dataclass

# Minimum acceptable model quality thresholds
MIN_R2_SCORE = 0.20  # model must explain > 20% of variance
MAX_RMSE = 0.35  # predictions off by at most 0.35 on average
MIN_COVERAGE_95 = 0.85  # 95% CI must contain true value 85%+ of time
MAX_INTERVAL_WIDTH = 0.60  # average interval must not be too wide


@dataclass
class ValidationResult:
    passed: bool
    r2_score: float
    rmse: float
    mae: float
    coverage_95: float
    avg_interval_width: float
    failure_reasons: list[str]


def validate_model(
    q50_model,
    q025_model,
    q975_model,
    X_val: np.ndarray,
    y_val: np.ndarray,
) -> ValidationResult:
    """
    Validate all three quantile models on held-out data.
    Returns ValidationResult with pass/fail and metrics.

    Validation checks:
    1. R² must be above threshold (model has signal)
    2. RMSE must be below threshold (predictions are accurate)
    3. 95% CI must cover true values at expected rate
    4. Intervals must not be pathologically wide
    """
    failures = []

    q50_preds = q50_model.predict(X_val)
    q025_preds = q025_model.predict(X_val)
    q975_preds = q975_model.predict(X_val)

    # Clip predictions to [0, 1]
    q50_preds = np.clip(q50_preds, 0.0, 1.0)
    q025_preds = np.clip(q025_preds, 0.0, 1.0)
    q975_preds = np.clip(q975_preds, 0.0, 1.0)

    # Ensure ordering: q025 <= q50 <= q975
    q025_preds = np.minimum(q025_preds, q50_preds)
    q975_preds = np.maximum(q975_preds, q50_preds)

    # R² score
    ss_res = np.sum((y_val - q50_preds) ** 2)
    ss_tot = np.sum((y_val - np.mean(y_val)) ** 2)
    r2 = float(1 - (ss_res / ss_tot)) if ss_tot > 0 else 0.0

    # RMSE
    rmse = float(np.sqrt(np.mean((y_val - q50_preds) ** 2)))

    # MAE
    mae = float(np.mean(np.abs(y_val - q50_preds)))

    # Coverage: fraction of true values inside [q025, q975]
    coverage = float(
        np.mean((y_val >= q025_preds) & (y_val <= q975_preds))
    )

    # Average interval width
    avg_width = float(np.mean(q975_preds - q025_preds))

    # Check thresholds
    if r2 < MIN_R2_SCORE:
        failures.append(
            f"R² {r2:.3f} below minimum {MIN_R2_SCORE}. "
            f"Model has insufficient signal. "
            f"Collect more training data."
        )

    if rmse > MAX_RMSE:
        failures.append(
            f"RMSE {rmse:.3f} above maximum {MAX_RMSE}. "
            f"Predictions are too inaccurate."
        )

    if coverage < MIN_COVERAGE_95:
        failures.append(
            f"95% CI coverage {coverage:.3f} below "
            f"minimum {MIN_COVERAGE_95}. "
            f"Confidence intervals are too narrow."
        )

    if avg_width > MAX_INTERVAL_WIDTH:
        failures.append(
            f"Average interval width {avg_width:.3f} above "
            f"maximum {MAX_INTERVAL_WIDTH}. "
            f"Predictions are too uncertain to be useful."
        )

    return ValidationResult(
        passed=len(failures) == 0,
        r2_score=r2,
        rmse=rmse,
        mae=mae,
        coverage_95=coverage,
        avg_interval_width=avg_width,
        failure_reasons=failures,
    )
