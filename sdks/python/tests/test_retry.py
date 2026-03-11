"""Tests for retry logic and exponential backoff."""

from unittest.mock import patch

from layer5.retry import exponential_backoff, with_retry, RETRYABLE_EXCEPTIONS
from layer5.exceptions import (
    Layer5AuthError,
    Layer5NetworkError,
    Layer5ServerError,
    Layer5ValidationError,
)


class TestExponentialBackoff:
    def test_attempt_0_approx_half_second(self):
        # Without jitter
        delay = exponential_backoff(0, jitter=False)
        assert delay == 0.5

    def test_attempt_1_approx_one_second(self):
        delay = exponential_backoff(1, jitter=False)
        assert delay == 1.0

    def test_attempt_3_approx_four_seconds(self):
        delay = exponential_backoff(3, jitter=False)
        assert delay == 4.0

    def test_never_exceeds_max_delay(self):
        delay = exponential_backoff(100, max_delay=30.0, jitter=False)
        assert delay == 30.0

    def test_jitter_produces_different_values(self):
        # Run multiple times — with jitter, values should vary
        delays = [exponential_backoff(2, jitter=True) for _ in range(20)]
        unique = set(delays)
        assert len(unique) > 1, "Jitter should produce varying delays"

    def test_jitter_stays_within_bounds(self):
        # base_delay=0.5, attempt=2 → base = 2.0
        # With jitter: 2.0 * [0.75, 1.25] → [1.5, 2.5]
        for _ in range(100):
            delay = exponential_backoff(2, jitter=True)
            assert 1.4 <= delay <= 2.6  # small margin for float math


class TestWithRetry:
    def test_succeeds_on_first_try(self):
        call_count = 0

        def func():
            nonlocal call_count
            call_count += 1
            return "ok"

        wrapped = with_retry(func, max_attempts=3)
        result = wrapped()
        assert result == "ok"
        assert call_count == 1

    def test_retries_on_server_error_then_succeeds(self):
        call_count = 0

        def func():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise Layer5ServerError(503)
            return "ok"

        with patch("layer5.retry.time.sleep"):
            wrapped = with_retry(func, max_attempts=3)
            result = wrapped()

        assert result == "ok"
        assert call_count == 3

    def test_retries_on_network_error(self):
        call_count = 0

        def func():
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                raise Layer5NetworkError("DNS resolution failed")
            return "ok"

        with patch("layer5.retry.time.sleep"):
            wrapped = with_retry(func, max_attempts=3)
            result = wrapped()

        assert result == "ok"
        assert call_count == 2

    def test_does_not_retry_auth_error(self):
        call_count = 0

        def func():
            nonlocal call_count
            call_count += 1
            raise Layer5AuthError("bad key")

        wrapped = with_retry(func, max_attempts=3)
        try:
            wrapped()
        except Layer5AuthError:
            pass

        assert call_count == 1

    def test_does_not_retry_validation_error(self):
        call_count = 0

        def func():
            nonlocal call_count
            call_count += 1
            raise Layer5ValidationError("invalid field", field="test")

        wrapped = with_retry(func, max_attempts=3)
        try:
            wrapped()
        except Layer5ValidationError:
            pass

        assert call_count == 1

    def test_exhausts_retries_then_raises(self):
        def func():
            raise Layer5ServerError(500)

        with patch("layer5.retry.time.sleep"):
            wrapped = with_retry(func, max_attempts=3)
            try:
                wrapped()
                assert False, "Should have raised"  # noqa: B011
            except Layer5ServerError as e:
                assert e.status_code == 500
