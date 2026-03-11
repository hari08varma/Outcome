"""
Layer5 — training/export_model.py
══════════════════════════════════════════════════════════════
Export trained LightGBM model to JSON format
that the TypeScript inference code can read.

The JSON structure MUST match what world-model.ts expects.
Do not change this format without changing world-model.ts.

Tree encoding contract with TypeScript evaluateTree():
  - Internal nodes have non-negative indices in left_child/right_child
  - Leaf nodes are encoded as negative: -(leaf_index + 1)
  - evaluateTree() checks: if (nodeIndex < 0) { leafIndex = -(nodeIndex + 1) }
══════════════════════════════════════════════════════════════
"""

import json
import lightgbm as lgb
import numpy as np
from typing import Dict, Any


def lgbm_to_json(
    model: lgb.Booster | lgb.LGBMRegressor,
) -> Dict[str, Any]:
    """
    Convert LightGBM booster to the JSON format
    expected by TypeScript inference code.

    LightGBM's native dump_model() produces a verbose JSON.
    We need only the tree structure fields used by
    evaluateTree() in world-model.ts.

    Returns dict matching TypeScript LGBMTree interface:
    {
      trees: [{
        num_leaves: int,
        split_index: int[],
        split_feature: int[],
        threshold: (float | string)[],
        decision_type: string[],
        left_child: int[],
        right_child: int[],
        leaf_value: float[]
      }],
      num_trees: int
    }
    """
    # Handle both LGBMRegressor (has .booster_) and raw Booster
    booster = getattr(model, 'booster_', model)

    model_dict = booster.dump_model()
    trees = []

    for tree_data in model_dict.get('tree_info', []):
        tree_structure = tree_data.get('tree_structure', {})

        # Extract arrays by traversing the tree structure
        split_index = []
        split_feature = []
        threshold = []
        decision_type = []
        left_child = []
        right_child = []
        leaf_value = []

        # LightGBM stores trees as nested dicts.
        # Convert to flat arrays (index-based format).
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

        trees.append(
            {
                'num_leaves': len(leaf_value),
                'split_index': split_index,
                'split_feature': split_feature,
                'threshold': threshold,
                'decision_type': decision_type,
                'left_child': left_child,
                'right_child': right_child,
                'leaf_value': leaf_value,
            }
        )

    return {
        'trees': trees,
        'num_trees': len(trees),
    }


def _flatten_tree(
    node: Dict,
    split_index: list,
    split_feature: list,
    threshold: list,
    decision_type: list,
    left_child: list,
    right_child: list,
    leaf_value: list,
    node_count: list,
) -> int:
    """
    Recursively flatten LightGBM nested tree dict
    into parallel arrays.

    Returns the reference for this node:
      - Non-negative int for internal nodes (index in arrays)
      - Negative int for leaf nodes: -(leaf_idx + 1)

    This encoding matches TypeScript evaluateTree() in world-model.ts:
      if (nodeIndex < 0) { leafIndex = -(nodeIndex + 1); }
    """
    if 'split_index' not in node:
        # Leaf node — encode as negative index
        leaf_idx = len(leaf_value)
        leaf_value.append(node['leaf_value'])
        return -(leaf_idx + 1)

    # Internal node
    current_idx = node_count[0]
    node_count[0] += 1

    split_index.append(node['split_index'])
    split_feature.append(node['split_feature'])
    threshold.append(node['threshold'])
    decision_type.append(node.get('decision_type', '<='))
    left_child.append(0)  # placeholder
    right_child.append(0)  # placeholder

    # Process left child — returns node index or negative leaf ref
    left_ref = _flatten_tree(
        node['left_child'],
        split_index,
        split_feature,
        threshold,
        decision_type,
        left_child,
        right_child,
        leaf_value,
        node_count,
    )

    # Process right child
    right_ref = _flatten_tree(
        node['right_child'],
        split_index,
        split_feature,
        threshold,
        decision_type,
        left_child,
        right_child,
        leaf_value,
        node_count,
    )

    # Write actual child references (may be negative for leaves)
    left_child[current_idx] = left_ref
    right_child[current_idx] = right_ref

    return current_idx


def export_quantile_models(
    q50_model: lgb.Booster | lgb.LGBMRegressor,
    q025_model: lgb.Booster | lgb.LGBMRegressor,
    q975_model: lgb.Booster | lgb.LGBMRegressor,
    action_encoding: Dict[str, int],
    context_encoding: Dict[str, Any],
    learning_rate: float,
    version: int,
    trained_at: str,
) -> Dict[str, Any]:
    """
    Export all three quantile models plus metadata
    into the format expected by world-model.ts.
    """
    return {
        'q50': lgbm_to_json(q50_model),
        'q025': lgbm_to_json(q025_model),
        'q975': lgbm_to_json(q975_model),
        'feature_names': [
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
        ],
        'num_features': 10,
        'action_encoding': action_encoding,
        'context_encoding': context_encoding,
        'learning_rate': learning_rate,
        'version': version,
        'trained_at': trained_at,
    }
