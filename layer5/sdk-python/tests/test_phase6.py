"""
Phase 6 — Python Instrumentation Layer
16 pytest tests.
DO NOT import from sdks/python/ — mock the client.
DO NOT use real HTTP — monkeypatch httpx/requests responses.
"""
from __future__ import annotations

import sys
import time
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from layerinfinite_l5.tracing.causal_graph import CausalGraph, Comparison, FieldAccess
from layerinfinite_l5.tracing.execution_context import (
    ExecutionContext,
    get_current_context,
    reset_context,
    set_context,
)
from layerinfinite_l5.tracing.traced_primitive import (
    MAX_DEPTH,
    TracedPrimitive,
    compute_confidence,
)
from layerinfinite_l5.tracing.traced_response import TracedResponse


# ── Helpers ──────────────────────────────────────────────────────────────────

def _graph() -> CausalGraph:
    return CausalGraph()


def _prov(action_id: str = "act-1", field_path: str = "status", depth: int = 0) -> dict:
    return {"action_id": action_id, "action_name": "test", "field_path": field_path, "depth": depth}


def _primitive(value: Any, field_path: str = "status", depth: int = 0) -> tuple[TracedPrimitive, CausalGraph]:
    g = _graph()
    p = TracedPrimitive(value, _prov(field_path=field_path, depth=depth), g)
    return p, g


# ── Test 1: CausalGraph.record_field_access stores FieldAccess ───────────────

def test_1_causal_graph_record_field_access():
    g = _graph()
    fa = FieldAccess(
        action_id="act-1", field_path="status", value="ok",
        depth=0, confidence=0.90, timestamp=time.time(),
    )
    g.record_field_access(fa)
    assert len(g.field_accesses) == 1
    assert g.field_accesses[0].field_path == "status"
    assert g.field_accesses[0].value == "ok"
    assert g.field_accesses[0].confidence == 0.90


# ── Test 2: derive_outcome — empty graph ─────────────────────────────────────

def test_2_derive_outcome_empty():
    g = _graph()
    success, confidence = g.derive_outcome()
    assert success is None
    assert confidence == 0.0


# ── Test 3: derive_outcome — field accesses only ──────────────────────────────

def test_3_derive_outcome_field_accesses_only():
    g = _graph()
    g.record_field_access(FieldAccess(
        action_id="a", field_path="x", value=1, depth=0, confidence=0.9, timestamp=time.time()
    ))
    success, confidence = g.derive_outcome()
    assert success is None
    assert confidence == 0.5


# ── Test 4: derive_outcome — majority True → success=True ─────────────────────

def test_4_derive_outcome_majority_true():
    g = _graph()
    for result in [True, True, False]:
        g.record_comparison(Comparison(
            action_id="a", field_path="ok", value=True,
            op="eq", result=result, timestamp=time.time()
        ))
    success, confidence = g.derive_outcome()
    assert success is True


# ── Test 5: derive_outcome — majority False → success=False ───────────────────

def test_5_derive_outcome_majority_false():
    g = _graph()
    for result in [False, False, True]:
        g.record_comparison(Comparison(
            action_id="a", field_path="ok", value=False,
            op="eq", result=result, timestamp=time.time()
        ))
    success, confidence = g.derive_outcome()
    assert success is False


# ── Test 6: TracedPrimitive.__eq__ ────────────────────────────────────────────

def test_6_traced_primitive_eq():
    p, g = _primitive("succeeded")
    result = p == "succeeded"
    assert result is True
    assert len(g.comparisons) == 1
    assert g.comparisons[0].op == "eq"
    assert g.comparisons[0].result is True

    p2, g2 = _primitive("failed")
    result2 = p2 == "succeeded"
    assert result2 is False
    assert g2.comparisons[0].result is False


# ── Test 7: TracedPrimitive.__gt__ ────────────────────────────────────────────

def test_7_traced_primitive_gt():
    p, g = _primitive(10, field_path="score")
    result = p > 5
    assert result is True
    assert len(g.comparisons) == 1
    assert g.comparisons[0].op == "gt"
    assert g.comparisons[0].result is True

    p2, g2 = _primitive(3, field_path="score")
    assert (p2 > 5) is False
    assert g2.comparisons[0].result is False


# ── Test 8: TracedPrimitive.__bool__ ──────────────────────────────────────────

def test_8_traced_primitive_bool():
    p_true, g_true = _primitive(1)
    assert bool(p_true) is True
    assert len(g_true.comparisons) == 1
    assert g_true.comparisons[0].op == "bool"
    assert g_true.comparisons[0].result is True

    p_false, g_false = _primitive(0)
    assert bool(p_false) is False
    assert g_false.comparisons[0].result is False


# ── Test 9: TracedPrimitive.__str__ — plain str returned, coerce_str recorded ─

def test_9_traced_primitive_str_retires_tag():
    p, g = _primitive("hello")
    result = str(p)
    # Must be a plain str — NOT a TracedPrimitive
    assert type(result) is str
    assert result == "hello"
    # Records coerce_str event — Python Challenge 2 boundary
    assert len(g.comparisons) == 1
    assert g.comparisons[0].op == "coerce_str"


# ── Test 10: TracedResponse wraps primitive field in TracedPrimitive ──────────

def test_10_traced_response_wraps_primitive():
    g = _graph()
    prov = _prov(field_path="", depth=0)
    resp = TracedResponse({"status": "ok", "code": 200}, prov, g)

    status = resp.status
    assert isinstance(status, TracedPrimitive)
    assert status == "ok"
    # Field access was recorded
    assert any(fa.field_path == "status" for fa in g.field_accesses)


# ── Test 11: TracedResponse wraps nested dict in TracedResponse ───────────────

def test_11_traced_response_wraps_nested_dict():
    g = _graph()
    prov = _prov(field_path="", depth=0)
    resp = TracedResponse({"data": {"id": 42, "name": "alice"}}, prov, g)

    nested = resp.data
    assert isinstance(nested, TracedResponse)
    # Accessing field on nested TracedResponse still works
    id_val = nested.id
    assert isinstance(id_val, TracedPrimitive)
    assert id_val == 42


# ── Test 12: depth > MAX_DEPTH returns raw value (tag retired) ────────────────

def test_12_depth_max_returns_raw():
    g = _graph()
    prov = _prov(field_path="", depth=MAX_DEPTH)  # next access will be depth=MAX_DEPTH+1 → confidence=0.0
    resp = TracedResponse({"x": "raw_value"}, prov, g)

    # At depth MAX_DEPTH, compute_confidence(MAX_DEPTH) = 0.90 - 8*0.04 = 0.58 — still wrapped
    # But we need depth=MAX_DEPTH so the child gets depth=MAX_DEPTH+1 (confidence=0.0)
    val = resp.x
    # confidence at depth MAX_DEPTH = 0.58 > 0.0, so still wrapped
    # Let's test with depth=MAX_DEPTH+1 directly
    prov2 = _prov(field_path="", depth=MAX_DEPTH + 1)
    resp2 = TracedResponse({"x": "raw_value"}, prov2, g)
    val2 = resp2.x
    # confidence(MAX_DEPTH+1) == 0.0, tag retired → raw str returned
    assert type(val2) is str
    assert val2 == "raw_value"


# ── Test 13: compute_confidence values ────────────────────────────────────────

def test_13_compute_confidence():
    assert compute_confidence(0) == pytest.approx(0.90)
    assert compute_confidence(8) == pytest.approx(0.90 - 8 * 0.04)  # 0.58
    assert compute_confidence(9) == 0.0   # depth > MAX_DEPTH


# ── Test 14: ExecutionContext ContextVar set/get/reset ────────────────────────

def test_14_execution_context_contextvar():
    # Initially None
    assert get_current_context() is None

    ctx   = ExecutionContext(action_id="x1", action_name="fetch_users")
    token = set_context(ctx)

    retrieved = get_current_context()
    assert retrieved is ctx
    assert retrieved.action_id == "x1"
    assert retrieved.action_name == "fetch_users"

    # Reset restores to None
    reset_context(token)
    assert get_current_context() is None


# ── Test 15: IOInterceptor._wrap_response wraps JSON ─────────────────────────

def test_15_wrap_response_json_returns_traced_response():
    from layerinfinite_l5.pipeline.outcome_pipeline import OutcomePipeline
    from layerinfinite_l5.tracing.interceptor import IOInterceptor

    mock_client   = MagicMock()
    pipeline      = OutcomePipeline(mock_client)
    interceptor   = IOInterceptor(pipeline)

    # Mock response with .json() and .status_code
    mock_response = MagicMock()
    mock_response.json.return_value = {"result": "success", "score": 0.95}
    mock_response.status_code = 200

    ctx = ExecutionContext(action_id="test-1", action_name="get_result")
    wrapped = interceptor._wrap_response(mock_response, ctx)

    # After wrapping, .json() should return a TracedResponse
    traced = wrapped.json()
    assert isinstance(traced, TracedResponse)

    # Field access on TracedResponse returns TracedPrimitive
    result_field = traced.result
    assert isinstance(result_field, TracedPrimitive)
    assert result_field == "success"


# ── Test 16: instrument() never raises when httpx/requests absent ─────────────

def test_16_instrument_never_raises_without_deps():
    from layerinfinite_l5.instrument import instrument

    mock_client = MagicMock()

    # Simulate missing httpx AND requests
    with patch.dict(sys.modules, {'httpx': None, 'requests': None}):
        # Should not raise under any circumstance
        try:
            instrument(mock_client)
        except Exception as e:
            pytest.fail(f"instrument() raised unexpectedly: {e}")
