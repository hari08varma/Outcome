"""
Layer5 — training/features.py
══════════════════════════════════════════════════════════════
Extract features from raw Supabase records.
Feature order MUST match world-model.ts exactly.
Any change here requires a matching change there.

Feature vector (10 features):
  Index 0:  action_encoded       — integer, action_encoding map
  Index 1:  episode_position     — integer, 0-based
  Index 2:  prev_action_1        — integer, -1 if none
  Index 3:  prev_action_2        — integer, -1 if none
  Index 4:  prev_action_3        — integer, -1 if none
  Index 5:  context_type_freq    — float, 0–1 normalized
  Index 6:  hour_sin             — float, cyclical
  Index 7:  hour_cos             — float, cyclical
  Index 8:  dow_sin              — float, cyclical
  Index 9:  dow_cos              — float, cyclical

Target:
  outcome_score = COALESCE(outcome_score, success::float)
  This matches the existing scoring engine convention.
══════════════════════════════════════════════════════════════
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Tuple, Optional

FEATURE_NAMES = [
    'action_encoded',
    'episode_position',
    'prev_action_1',
    'prev_action_2',
    'prev_action_3',
    'context_type_freq',
    'hour_sin',
    'hour_cos',
    'dow_sin',
    'dow_cos',
]


def build_action_encoding(
    outcomes_df: pd.DataFrame,
) -> Dict[str, int]:
    """
    Build integer encoding for action names.
    Deterministic: sorted alphabetically.
    New actions in future training runs get new IDs.
    """
    unique_actions = sorted(outcomes_df['action_name'].unique())
    return {action: idx for idx, action in enumerate(unique_actions)}


def compute_context_frequencies(
    outcomes_df: pd.DataFrame,
) -> Dict[str, float]:
    """
    Compute normalized frequency of each context_hash.
    Frequency = count(context) / total_count
    Used as feature to capture how common the context is.
    """
    total = len(outcomes_df)
    if total == 0:
        return {}
    freq = outcomes_df.groupby('context_hash').size() / total
    return freq.to_dict()


def cyclical_encode(value: float, period: float) -> Tuple[float, float]:
    """
    Encode a cyclical value (hour, day of week) as sin/cos pair.
    This preserves the circular relationship
    (hour 23 is close to hour 0).
    """
    angle = (value / period) * 2 * np.pi
    return float(np.sin(angle)), float(np.cos(angle))


def extract_features(
    row: pd.Series,
    action_encoding: Dict[str, int],
    context_freqs: Dict[str, float],
    action_sequences: Dict[str, List[str]],  # episode_id → sequence
) -> np.ndarray:
    """
    Extract feature vector for one outcome record.
    Returns array of shape (10,).
    """
    action_enc = action_encoding.get(row['action_name'], -1)

    # Episode position: how many actions were taken before this one
    ep_id = row.get('episode_id')
    sequence = action_sequences.get(ep_id, []) if ep_id else []
    position = len(sequence)

    # Previous actions (up to 3, padded with -1)
    prev = list(reversed(sequence[-3:])) if sequence else []
    prev_enc = [action_encoding.get(a, -1) for a in prev]
    while len(prev_enc) < 3:
        prev_enc.append(-1)  # padding

    # Context frequency
    ctx_freq = context_freqs.get(row.get('context_hash', ''), 0.0)

    # Cyclical time encoding
    created_at = pd.to_datetime(row['created_at'])
    hour_sin, hour_cos = cyclical_encode(
        created_at.hour + created_at.minute / 60.0,
        24.0,
    )
    dow_sin, dow_cos = cyclical_encode(
        float(created_at.dayofweek),
        7.0,
    )

    return np.array(
        [
            float(action_enc),
            float(position),
            float(prev_enc[0]),
            float(prev_enc[1]),
            float(prev_enc[2]),
            ctx_freq,
            hour_sin,
            hour_cos,
            dow_sin,
            dow_cos,
        ],
        dtype=np.float32,
    )


def build_training_data(
    outcomes_df: pd.DataFrame,
    sequences_df: pd.DataFrame,
    counterfactuals_df: pd.DataFrame,
    action_encoding: Dict[str, int],
    context_freqs: Dict[str, float],
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Build X, y, weights arrays for training.
    Combines real outcomes with counterfactual estimates.

    Returns:
      X:       (N, 10) feature matrix
      y:       (N,) target values
      weights: (N,) sample weights
                  1.0 for real outcomes
                  ips_weight for counterfactuals (0.001–0.3)
    """
    # Build sequence lookup: episode_id → ordered action list
    seq_lookup: Dict[str, List[str]] = {}
    for _, row in sequences_df.iterrows():
        seq_lookup[row['episode_id']] = row['action_sequence']

    X_list = []
    y_list = []
    w_list = []

    # Real outcomes (weight = 1.0)
    for _, row in outcomes_df.iterrows():
        target = row.get('outcome_score')
        if target is None or (isinstance(target, float) and np.isnan(target)):
            target = 1.0 if row['success'] else 0.0

        features = extract_features(
            row, action_encoding, context_freqs, seq_lookup
        )
        X_list.append(features)
        y_list.append(float(target))
        w_list.append(1.0)

    # Counterfactual estimates (weight = ips_weight)
    for _, row in counterfactuals_df.iterrows():
        # Build a synthetic outcome row for the unchosen action
        synthetic_row = pd.Series(
            {
                'action_name': row['unchosen_action_name'],
                'context_hash': row['context_hash'],
                'created_at': row.get('created_at', pd.Timestamp.now()),
                'episode_id': None,
            }
        )

        features = extract_features(
            synthetic_row, action_encoding, context_freqs, seq_lookup
        )
        X_list.append(features)
        y_list.append(float(row['counterfactual_est']))
        w_list.append(float(row['ips_weight']))

    return (
        np.array(X_list, dtype=np.float32),
        np.array(y_list, dtype=np.float32),
        np.array(w_list, dtype=np.float32),
    )
