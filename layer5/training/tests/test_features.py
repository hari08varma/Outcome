"""
Layerinfinite — tests/test_features.py
══════════════════════════════════════════════════════════════
Tests for features.py, export_model.py, and validate_model.py.
No external services required — all data is synthetic.
══════════════════════════════════════════════════════════════
"""

import sys
from pathlib import Path

# Ensure training/ is on the import path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pandas as pd
import pytest

from features import (
    FEATURE_NAMES,
    build_action_encoding,
    build_training_data,
    compute_context_frequencies,
    cyclical_encode,
    extract_features,
)
from validate_model import validate_model


# ─── Fixtures ──────────────────────────────────────────────


@pytest.fixture
def sample_outcomes_df():
    """Minimal outcomes DataFrame for testing."""
    return pd.DataFrame(
        {
            'action_name': ['alpha', 'beta', 'gamma', 'alpha', 'beta'],
            'context_hash': ['ctx_a', 'ctx_a', 'ctx_b', 'ctx_a', 'ctx_b'],
            'created_at': pd.to_datetime(
                [
                    '2026-03-01 10:30:00',
                    '2026-03-01 14:00:00',
                    '2026-03-02 08:15:00',
                    '2026-03-02 22:45:00',
                    '2026-03-03 06:00:00',
                ]
            ),
            'episode_id': ['ep1', 'ep1', 'ep2', 'ep3', 'ep3'],
            'success': [True, False, True, True, False],
            'outcome_score': [0.9, 0.1, 0.8, 0.7, 0.2],
        }
    )


@pytest.fixture
def sample_sequences_df():
    """Action sequences by episode."""
    return pd.DataFrame(
        {
            'episode_id': ['ep1', 'ep2', 'ep3'],
            'action_sequence': [
                ['alpha', 'beta'],
                ['gamma'],
                ['alpha', 'beta'],
            ],
        }
    )


@pytest.fixture
def sample_counterfactuals_df():
    """Counterfactual estimates for unchosen actions."""
    return pd.DataFrame(
        {
            'unchosen_action_name': ['gamma', 'alpha'],
            'counterfactual_est': [0.5, 0.3],
            'ips_weight': [0.15, 0.08],
            'context_hash': ['ctx_a', 'ctx_b'],
            'created_at': pd.to_datetime(
                ['2026-03-01 10:30:00', '2026-03-02 08:15:00']
            ),
        }
    )


@pytest.fixture
def action_encoding(sample_outcomes_df):
    return build_action_encoding(sample_outcomes_df)


@pytest.fixture
def context_freqs(sample_outcomes_df):
    return compute_context_frequencies(sample_outcomes_df)


# ─── build_action_encoding ─────────────────────────────────


class TestBuildActionEncoding:
    def test_deterministic_sorted(self, sample_outcomes_df):
        """build_action_encoding: deterministic (sorted)"""
        enc = build_action_encoding(sample_outcomes_df)
        keys = list(enc.keys())
        assert keys == sorted(keys), "Action encoding must be alphabetically sorted"
        assert enc == {'alpha': 0, 'beta': 1, 'gamma': 2}

    def test_identical_on_rerun(self, sample_outcomes_df):
        """build_action_encoding: new run with same data produces identical encoding"""
        enc1 = build_action_encoding(sample_outcomes_df)
        enc2 = build_action_encoding(sample_outcomes_df)
        assert enc1 == enc2, "Same data must produce identical encoding"

    def test_new_actions_get_new_ids(self, sample_outcomes_df):
        """New actions in expanded data get higher IDs."""
        enc_original = build_action_encoding(sample_outcomes_df)

        expanded = pd.concat(
            [
                sample_outcomes_df,
                pd.DataFrame(
                    {
                        'action_name': ['delta'],
                        'context_hash': ['ctx_c'],
                        'created_at': [pd.Timestamp.now()],
                        'episode_id': ['ep4'],
                        'success': [True],
                        'outcome_score': [0.5],
                    }
                ),
            ],
            ignore_index=True,
        )
        enc_expanded = build_action_encoding(expanded)

        # Original actions keep same relative order
        assert enc_expanded['alpha'] < enc_expanded['beta']
        assert enc_expanded['beta'] < enc_expanded['delta']
        assert enc_expanded['delta'] < enc_expanded['gamma']


# ─── cyclical_encode ───────────────────────────────────────


class TestCyclicalEncode:
    def test_hour_0_and_24_produce_same_value(self):
        """cyclical_encode: hour 0 and hour 24 produce same value"""
        sin_0, cos_0 = cyclical_encode(0.0, 24.0)
        sin_24, cos_24 = cyclical_encode(24.0, 24.0)
        assert abs(sin_0 - sin_24) < 1e-10
        assert abs(cos_0 - cos_24) < 1e-10

    def test_output_in_minus_one_to_one(self):
        """cyclical_encode: output is in [-1, 1]"""
        for value in [0, 3, 6, 12, 18, 23.99]:
            sin_v, cos_v = cyclical_encode(value, 24.0)
            assert -1.0 <= sin_v <= 1.0, f"sin({value}) = {sin_v} out of range"
            assert -1.0 <= cos_v <= 1.0, f"cos({value}) = {cos_v} out of range"

    def test_dow_cyclical(self):
        """Day 0 and day 7 produce the same encoding."""
        sin_0, cos_0 = cyclical_encode(0.0, 7.0)
        sin_7, cos_7 = cyclical_encode(7.0, 7.0)
        assert abs(sin_0 - sin_7) < 1e-10
        assert abs(cos_0 - cos_7) < 1e-10

    def test_opposite_hours(self):
        """Hour 0 and hour 12 should have opposite sin values."""
        sin_0, cos_0 = cyclical_encode(0.0, 24.0)
        sin_12, cos_12 = cyclical_encode(12.0, 24.0)
        assert abs(sin_0 - sin_12) < 1e-10  # both near 0
        assert abs(cos_0 - (-cos_12)) < 1e-10  # opposite cos


# ─── extract_features ─────────────────────────────────────


class TestExtractFeatures:
    def test_returns_array_of_length_10(
        self, sample_outcomes_df, action_encoding, context_freqs
    ):
        """extract_features: returns array of length 10"""
        row = sample_outcomes_df.iloc[0]
        features = extract_features(
            row, action_encoding, context_freqs, {}
        )
        assert features.shape == (10,)
        assert features.dtype == np.float32

    def test_unknown_action_minus_one(self, context_freqs):
        """extract_features: unknown action → -1 encoding"""
        encoding = {'alpha': 0, 'beta': 1}
        row = pd.Series(
            {
                'action_name': 'unknown_action',
                'context_hash': 'ctx_a',
                'created_at': '2026-03-01 10:00:00',
                'episode_id': None,
            }
        )
        features = extract_features(row, encoding, context_freqs, {})
        assert features[0] == -1.0, "Unknown action should encode as -1"

    def test_episode_position_counts(self, action_encoding, context_freqs):
        """extract_features: episode_position counts correctly"""
        sequences = {'ep1': ['alpha', 'beta', 'gamma']}
        row = pd.Series(
            {
                'action_name': 'alpha',
                'context_hash': 'ctx_a',
                'created_at': '2026-03-01 10:00:00',
                'episode_id': 'ep1',
            }
        )
        features = extract_features(
            row, action_encoding, context_freqs, sequences
        )
        # Position = len(sequence) = 3
        assert features[1] == 3.0

    def test_previous_actions_padded(self, action_encoding, context_freqs):
        """extract_features: previous actions padded with -1"""
        # Episode with only 1 previous action
        sequences = {'ep1': ['alpha']}
        row = pd.Series(
            {
                'action_name': 'beta',
                'context_hash': 'ctx_a',
                'created_at': '2026-03-01 10:00:00',
                'episode_id': 'ep1',
            }
        )
        features = extract_features(
            row, action_encoding, context_freqs, sequences
        )
        # prev_action_1 = alpha (0), prev_action_2 = -1, prev_action_3 = -1
        assert features[2] == 0.0  # alpha
        assert features[3] == -1.0  # padded
        assert features[4] == -1.0  # padded

    def test_no_episode_all_padded(self, action_encoding, context_freqs):
        """No episode_id → all previous actions are -1."""
        row = pd.Series(
            {
                'action_name': 'alpha',
                'context_hash': 'ctx_a',
                'created_at': '2026-03-01 10:00:00',
                'episode_id': None,
            }
        )
        features = extract_features(row, action_encoding, context_freqs, {})
        assert features[2] == -1.0
        assert features[3] == -1.0
        assert features[4] == -1.0

    def test_feature_names_match_count(self):
        """Feature names list has exactly 10 entries."""
        assert len(FEATURE_NAMES) == 10


# ─── build_training_data ──────────────────────────────────


class TestBuildTrainingData:
    def test_real_outcomes_weight_one(
        self,
        sample_outcomes_df,
        sample_sequences_df,
        action_encoding,
        context_freqs,
    ):
        """build_training_data: real outcomes have weight 1.0"""
        empty_cf = pd.DataFrame(
            columns=[
                'unchosen_action_name',
                'counterfactual_est',
                'ips_weight',
                'context_hash',
                'created_at',
            ]
        )
        X, y, w = build_training_data(
            sample_outcomes_df,
            sample_sequences_df,
            empty_cf,
            action_encoding,
            context_freqs,
        )
        assert np.all(w == 1.0), "Real outcomes must have weight 1.0"

    def test_counterfactuals_weight_less_than_one(
        self,
        sample_outcomes_df,
        sample_sequences_df,
        sample_counterfactuals_df,
        action_encoding,
        context_freqs,
    ):
        """build_training_data: counterfactuals have weight < 1.0"""
        X, y, w = build_training_data(
            sample_outcomes_df,
            sample_sequences_df,
            sample_counterfactuals_df,
            action_encoding,
            context_freqs,
        )
        n_real = len(sample_outcomes_df)
        cf_weights = w[n_real:]
        assert len(cf_weights) > 0
        assert np.all(cf_weights < 1.0), "Counterfactual weights must be < 1.0"
        assert np.all(cf_weights > 0.0), "Counterfactual weights must be > 0.0"

    def test_total_length(
        self,
        sample_outcomes_df,
        sample_sequences_df,
        sample_counterfactuals_df,
        action_encoding,
        context_freqs,
    ):
        """build_training_data: total length = outcomes + counterfactuals"""
        X, y, w = build_training_data(
            sample_outcomes_df,
            sample_sequences_df,
            sample_counterfactuals_df,
            action_encoding,
            context_freqs,
        )
        expected = len(sample_outcomes_df) + len(sample_counterfactuals_df)
        assert X.shape[0] == expected
        assert y.shape[0] == expected
        assert w.shape[0] == expected

    def test_feature_matrix_shape(
        self,
        sample_outcomes_df,
        sample_sequences_df,
        sample_counterfactuals_df,
        action_encoding,
        context_freqs,
    ):
        """Feature matrix has 10 columns."""
        X, y, w = build_training_data(
            sample_outcomes_df,
            sample_sequences_df,
            sample_counterfactuals_df,
            action_encoding,
            context_freqs,
        )
        assert X.shape[1] == 10

    def test_target_values_from_outcome_score(
        self,
        sample_outcomes_df,
        sample_sequences_df,
        action_encoding,
        context_freqs,
    ):
        """Target uses outcome_score when available."""
        empty_cf = pd.DataFrame(
            columns=[
                'unchosen_action_name',
                'counterfactual_est',
                'ips_weight',
                'context_hash',
                'created_at',
            ]
        )
        X, y, w = build_training_data(
            sample_outcomes_df,
            sample_sequences_df,
            empty_cf,
            action_encoding,
            context_freqs,
        )
        # First outcome has outcome_score=0.9
        assert abs(y[0] - 0.9) < 1e-6


# ─── export_model ─────────────────────────────────────────


class TestExportModel:
    def test_flatten_tree_simple(self):
        """_flatten_tree produces correct flat arrays for a simple tree."""
        from export_model import _flatten_tree

        # Simple tree: root splits on feature 2 at threshold 0.5
        #   left: leaf value 0.3
        #   right: leaf value 0.7
        tree_structure = {
            'split_index': 0,
            'split_feature': 2,
            'threshold': 0.5,
            'decision_type': '<=',
            'left_child': {'leaf_index': 0, 'leaf_value': 0.3},
            'right_child': {'leaf_index': 1, 'leaf_value': 0.7},
        }

        split_index = []
        split_feature = []
        threshold = []
        decision_type = []
        left_child = []
        right_child = []
        leaf_value = []

        _flatten_tree(
            tree_structure,
            split_index,
            split_feature,
            threshold,
            decision_type,
            left_child,
            right_child,
            leaf_value,
            node_count=[0],
        )

        assert split_feature == [2]
        assert threshold == [0.5]
        assert leaf_value == [0.3, 0.7]
        # Left child is leaf 0 → -(0+1) = -1
        assert left_child == [-1]
        # Right child is leaf 1 → -(1+1) = -2
        assert right_child == [-2]

    def test_flatten_tree_two_levels(self):
        """_flatten_tree handles a 2-level tree (3 leaves)."""
        from export_model import _flatten_tree

        tree_structure = {
            'split_index': 0,
            'split_feature': 2,
            'threshold': 0.5,
            'decision_type': '<=',
            'left_child': {'leaf_index': 0, 'leaf_value': 0.3},
            'right_child': {
                'split_index': 1,
                'split_feature': 0,
                'threshold': 0.8,
                'decision_type': '<=',
                'left_child': {'leaf_index': 1, 'leaf_value': 0.5},
                'right_child': {'leaf_index': 2, 'leaf_value': 0.7},
            },
        }

        split_index = []
        split_feature = []
        threshold = []
        decision_type = []
        left_child = []
        right_child = []
        leaf_value = []

        _flatten_tree(
            tree_structure,
            split_index,
            split_feature,
            threshold,
            decision_type,
            left_child,
            right_child,
            leaf_value,
            node_count=[0],
        )

        assert split_feature == [2, 0]
        assert threshold == [0.5, 0.8]
        assert leaf_value == [0.3, 0.5, 0.7]
        # Root: left=leaf0 (-1), right=node1 (1)
        assert left_child[0] == -1
        assert right_child[0] == 1
        # Node1: left=leaf1 (-2), right=leaf2 (-3)
        assert left_child[1] == -2
        assert right_child[1] == -3

    def test_flatten_tree_matches_typescript_walk(self):
        """
        Verify flat arrays work with TypeScript evaluateTree logic.
        Simulates the exact TypeScript tree-walking algorithm.
        """
        from export_model import _flatten_tree

        tree_structure = {
            'split_index': 0,
            'split_feature': 0,
            'threshold': 5.0,
            'decision_type': '<=',
            'left_child': {'leaf_index': 0, 'leaf_value': 0.2},
            'right_child': {
                'split_index': 1,
                'split_feature': 1,
                'threshold': 3.0,
                'decision_type': '<=',
                'left_child': {'leaf_index': 1, 'leaf_value': 0.6},
                'right_child': {'leaf_index': 2, 'leaf_value': 0.9},
            },
        }

        si, sf, th, dt, lc, rc, lv = [], [], [], [], [], [], []
        _flatten_tree(tree_structure, si, sf, th, dt, lc, rc, lv, [0])

        # Simulate TypeScript evaluateTree
        def evaluate_tree_ts(features):
            node_index = 0
            while node_index >= 0:
                feat_idx = sf[node_index]
                thr = th[node_index]
                feat_val = features[feat_idx] if feat_idx < len(features) else 0
                if feat_val <= thr:
                    node_index = lc[node_index]
                else:
                    node_index = rc[node_index]
                if node_index < 0:
                    leaf_idx = -(node_index + 1)
                    return lv[leaf_idx]
            return 0

        # feature[0]=3 <= 5 → left leaf → 0.2
        assert evaluate_tree_ts([3.0, 0.0]) == 0.2
        # feature[0]=7 > 5 → right → feature[1]=2 <= 3 → left leaf → 0.6
        assert evaluate_tree_ts([7.0, 2.0]) == 0.6
        # feature[0]=7 > 5 → right → feature[1]=4 > 3 → right leaf → 0.9
        assert evaluate_tree_ts([7.0, 4.0]) == 0.9

    def test_export_quantile_models_structure(self):
        """export_quantile_models returns correct top-level structure."""
        from export_model import export_quantile_models
        from unittest.mock import MagicMock

        mock_model = MagicMock()
        mock_model.booster_ = MagicMock()
        mock_model.booster_.dump_model.return_value = {
            'tree_info': [
                {
                    'tree_structure': {
                        'split_index': 0,
                        'split_feature': 0,
                        'threshold': 0.5,
                        'left_child': {'leaf_value': 0.1},
                        'right_child': {'leaf_value': 0.9},
                    }
                }
            ]
        }

        result = export_quantile_models(
            q50_model=mock_model,
            q025_model=mock_model,
            q975_model=mock_model,
            action_encoding={'a': 0, 'b': 1},
            context_encoding={},
            learning_rate=0.05,
            version=1,
            trained_at='2026-03-11T00:00:00Z',
        )

        assert 'q50' in result
        assert 'q025' in result
        assert 'q975' in result
        assert result['num_features'] == 10
        assert result['learning_rate'] == 0.05
        assert result['version'] == 1
        assert result['feature_names'] == [
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

        # Each quantile model has trees
        assert 'trees' in result['q50']
        assert result['q50']['num_trees'] == 1


# ─── validate_model ───────────────────────────────────────


class MockModel:
    """Mock model that returns controlled predictions."""

    def __init__(self, predictions: np.ndarray):
        self._predictions = predictions

    def predict(self, X: np.ndarray) -> np.ndarray:
        return self._predictions[: len(X)]


class TestValidateModel:
    def test_perfect_model_passes(self):
        """validate_model: perfect model passes validation"""
        np.random.seed(42)
        n = 200
        y_val = np.random.uniform(0.2, 0.8, n).astype(np.float32)
        X_val = np.random.randn(n, 10).astype(np.float32)

        # Near-perfect predictions with tight intervals
        noise = np.random.normal(0, 0.01, n).astype(np.float32)
        q50_preds = y_val + noise
        q025_preds = y_val - 0.15
        q975_preds = y_val + 0.15

        result = validate_model(
            q50_model=MockModel(q50_preds),
            q025_model=MockModel(q025_preds),
            q975_model=MockModel(q975_preds),
            X_val=X_val,
            y_val=y_val,
        )

        assert result.passed is True, (
            f"Perfect model should pass. Failures: {result.failure_reasons}"
        )
        assert result.r2_score > 0.9
        assert result.rmse < 0.1
        assert result.coverage_95 > 0.9
        assert len(result.failure_reasons) == 0

    def test_constant_prediction_fails_r2(self):
        """validate_model: constant prediction fails R² check"""
        np.random.seed(42)
        n = 200
        y_val = np.random.uniform(0.1, 0.9, n).astype(np.float32)
        X_val = np.random.randn(n, 10).astype(np.float32)

        # Constant prediction = mean → R² ≈ 0
        mean_val = float(np.mean(y_val))
        constant = np.full(n, mean_val, dtype=np.float32)

        result = validate_model(
            q50_model=MockModel(constant),
            q025_model=MockModel(constant - 0.3),
            q975_model=MockModel(constant + 0.3),
            X_val=X_val,
            y_val=y_val,
        )

        assert result.passed is False
        assert result.r2_score < 0.01  # R² near 0 for constant

    def test_failure_reasons_explain_what_to_do(self):
        """validate_model: failure reasons explain what to do"""
        np.random.seed(42)
        n = 200
        y_val = np.random.uniform(0.1, 0.9, n).astype(np.float32)
        X_val = np.random.randn(n, 10).astype(np.float32)

        # Terrible model — constant at 0.5
        constant = np.full(n, 0.5, dtype=np.float32)

        result = validate_model(
            q50_model=MockModel(constant),
            q025_model=MockModel(constant - 0.01),  # narrow CI
            q975_model=MockModel(constant + 0.01),
            X_val=X_val,
            y_val=y_val,
        )

        assert result.passed is False
        assert len(result.failure_reasons) > 0

        # Check reasons are actionable
        all_reasons = ' '.join(result.failure_reasons)
        assert 'R²' in all_reasons or 'coverage' in all_reasons.lower()

    def test_wide_intervals_fail(self):
        """Very wide intervals fail the width threshold."""
        np.random.seed(42)
        n = 200
        y_val = np.random.uniform(0.3, 0.7, n).astype(np.float32)
        X_val = np.random.randn(n, 10).astype(np.float32)

        # Good predictions but pathologically wide intervals
        result = validate_model(
            q50_model=MockModel(y_val.copy()),
            q025_model=MockModel(np.zeros(n, dtype=np.float32)),
            q975_model=MockModel(np.ones(n, dtype=np.float32)),
            X_val=X_val,
            y_val=y_val,
        )

        assert result.passed is False
        assert any('width' in r.lower() for r in result.failure_reasons)

    def test_all_metrics_populated(self):
        """ValidationResult has all metric fields."""
        np.random.seed(42)
        n = 100
        y_val = np.random.uniform(0.2, 0.8, n).astype(np.float32)
        X_val = np.random.randn(n, 10).astype(np.float32)
        preds = np.full(n, 0.5, dtype=np.float32)

        result = validate_model(
            MockModel(preds),
            MockModel(preds - 0.2),
            MockModel(preds + 0.2),
            X_val,
            y_val,
        )

        assert isinstance(result.r2_score, float)
        assert isinstance(result.rmse, float)
        assert isinstance(result.mae, float)
        assert isinstance(result.coverage_95, float)
        assert isinstance(result.avg_interval_width, float)
        assert isinstance(result.passed, bool)
        assert isinstance(result.failure_reasons, list)
