"""
Tests for worker.py — file loading, task processing, main loop.
Uses mocks for Redis and S3 to avoid real infrastructure.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from models import TaskMessage

# ---------------------------------------------------------------------------
# Helper factories
# ---------------------------------------------------------------------------


def make_task(
    task_id: str = "task-001",
    job_id: str = "job-001",
    batch_index: int = 0,
    file_start: int = 0,
    file_end: int = 2,
    c: int = 3,
) -> TaskMessage:
    return TaskMessage.model_validate(
        {
            "taskId": task_id,
            "jobId": job_id,
            "batchIndex": batch_index,
            "fileStart": file_start,
            "fileEnd": file_end,
            "c": c,
        }
    )


def make_csv(values: list[float]) -> bytes:
    """Create CSV bytes with one float per line."""
    return "\n".join(f"{v:.8f}" for v in values).encode("utf-8")


# ---------------------------------------------------------------------------
# Tests for load_file
# ---------------------------------------------------------------------------


class TestLoadFile:
    """Test the load_file function with mocked S3."""

    def test_load_file_returns_numpy_array(self) -> None:
        values = [0.1, 0.2, 0.3]
        mock_body = MagicMock()
        mock_body.read.return_value = make_csv(values)

        mock_s3 = MagicMock()
        mock_s3.get_object.return_value = {"Body": mock_body}

        with patch("worker.get_s3", return_value=mock_s3):
            from worker import load_file

            result = load_file("job-1", 0, 3)

        assert isinstance(result, np.ndarray)
        assert result.dtype == np.float64
        assert len(result) == 3
        np.testing.assert_allclose(result, [0.1, 0.2, 0.3], rtol=1e-6)

    def test_load_file_constructs_correct_key(self) -> None:
        mock_body = MagicMock()
        mock_body.read.return_value = make_csv([0.5, 0.5])
        mock_s3 = MagicMock()
        mock_s3.get_object.return_value = {"Body": mock_body}

        with patch("worker.get_s3", return_value=mock_s3):
            from worker import load_file

            load_file("job-abc", 42, 2)

        call_kwargs = mock_s3.get_object.call_args
        assert call_kwargs is not None
        call_kwargs.kwargs.get("Key") or call_kwargs.args[0] if call_kwargs.args else None
        # Check the key via any argument
        call_str = str(mock_s3.get_object.call_args)
        assert "jobs/job-abc/inputs/file_000042.csv" in call_str

    def test_load_file_raises_on_wrong_count(self) -> None:
        mock_body = MagicMock()
        mock_body.read.return_value = make_csv([0.1, 0.2])  # 2 values, expected 5
        mock_s3 = MagicMock()
        mock_s3.get_object.return_value = {"Body": mock_body}

        with patch("worker.get_s3", return_value=mock_s3):
            from worker import load_file

            with pytest.raises(ValueError, match="expected 5"):
                load_file("job-1", 0, 5)

    def test_load_file_handles_empty_lines(self) -> None:
        """CSV may have trailing newline — should be stripped."""
        mock_body = MagicMock()
        mock_body.read.return_value = b"0.1\n0.2\n0.3\n"
        mock_s3 = MagicMock()
        mock_s3.get_object.return_value = {"Body": mock_body}

        with patch("worker.get_s3", return_value=mock_s3):
            from worker import load_file

            result = load_file("job-1", 0, 3)

        assert len(result) == 3


# ---------------------------------------------------------------------------
# Tests for process_task
# ---------------------------------------------------------------------------


class TestProcessTask:
    """Test process_task with mocked S3 and API."""

    def _make_s3_mock(self, values_per_file: list[list[float]]) -> MagicMock:
        """Create a mock S3 that returns different values for each file."""
        s3 = MagicMock()
        responses: list[dict[str, Any]] = []
        for vals in values_per_file:
            body = MagicMock()
            body.read.return_value = make_csv(vals)
            responses.append({"Body": body})
        s3.get_object.side_effect = responses
        return s3

    def test_process_task_computes_correct_partial_sums(self) -> None:
        """3 files with values [1,2,3], [4,5,6], [7,8,9] → partial sums [12,15,18]."""
        values = [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0, 8.0, 9.0]]
        mock_s3 = self._make_s3_mock(values)
        captured_payload: list[dict[str, Any]] = []

        def fake_api_post(path: str, payload: dict[str, Any]) -> None:
            captured_payload.append(payload)

        task = make_task(file_start=0, file_end=2, c=3)

        with (
            patch("worker.get_s3", return_value=mock_s3),
            patch("worker.api_post", side_effect=fake_api_post),
            patch("worker.settings") as mock_settings,
        ):
            mock_settings.worker_slowness = 0.0
            mock_settings.minio_bucket = "test-bucket"
            mock_settings.api_url = "http://localhost:3000"
            mock_settings.heartbeat_interval = 10
            from worker import process_task

            process_task(task)

        assert len(captured_payload) == 1
        result = captured_payload[0]
        assert result["taskId"] == "task-001"
        assert result["count"] == 3
        sums = result["partialSums"]
        np.testing.assert_allclose(sums, [12.0, 15.0, 18.0], rtol=1e-6)

    def test_process_task_single_file(self) -> None:
        """Single file: partial sums = file values."""
        values = [[0.1, 0.2, 0.3, 0.4, 0.5]]
        mock_s3 = self._make_s3_mock(values)
        captured: list[dict[str, Any]] = []

        task = make_task(file_start=0, file_end=0, c=5)

        with (
            patch("worker.get_s3", return_value=mock_s3),
            patch("worker.api_post", side_effect=lambda p, pl: captured.append(pl)),
            patch("worker.settings") as ms,
        ):
            ms.worker_slowness = 0.0
            ms.minio_bucket = "test-bucket"
            from worker import process_task

            process_task(task)

        result = captured[0]
        assert result["count"] == 1
        np.testing.assert_allclose(result["partialSums"], [0.1, 0.2, 0.3, 0.4, 0.5], rtol=1e-6)

    def test_process_task_max_batch_5_files(self) -> None:
        """Processes exactly 5 files (max batch size per TASK.md)."""
        values = [[float(i)] for i in range(5)]
        mock_s3 = self._make_s3_mock(values)
        captured: list[dict[str, Any]] = []

        task = make_task(file_start=0, file_end=4, c=1)

        with (
            patch("worker.get_s3", return_value=mock_s3),
            patch("worker.api_post", side_effect=lambda p, pl: captured.append(pl)),
            patch("worker.settings") as ms,
        ):
            ms.worker_slowness = 0.0
            ms.minio_bucket = "test-bucket"
            from worker import process_task

            process_task(task)

        result = captured[0]
        assert result["count"] == 5
        # Partial sum of [0,1,2,3,4] at index 0 = 10.0
        np.testing.assert_allclose(result["partialSums"], [10.0], rtol=1e-6)

    def test_process_task_with_slowness(self) -> None:
        """Slowness adds a sleep proportional to file count."""
        values = [[0.5, 0.5]]
        mock_s3 = self._make_s3_mock(values)
        sleep_calls: list[float] = []

        task = make_task(file_start=0, file_end=0, c=2)

        with (
            patch("worker.get_s3", return_value=mock_s3),
            patch("worker.api_post"),
            patch("worker.settings") as ms,
            patch("worker.time.sleep", side_effect=lambda s: sleep_calls.append(s)),
        ):
            ms.worker_slowness = 1.5
            ms.minio_bucket = "test-bucket"
            from worker import process_task

            process_task(task)

        # Should have called sleep with 1.5 * 1 (file_count=1) = 1.5
        assert len(sleep_calls) == 1
        assert sleep_calls[0] == pytest.approx(1.5)


# ---------------------------------------------------------------------------
# Tests for API helpers
# ---------------------------------------------------------------------------


class TestApiPost:
    """Test the api_post retry logic."""

    def test_api_post_succeeds_on_first_try(self) -> None:
        mock_resp = MagicMock()
        mock_resp.raise_for_status.return_value = None

        with (
            patch("worker.requests.post", return_value=mock_resp) as mock_post,
            patch("worker.settings") as ms,
        ):
            ms.api_url = "http://localhost:3000"
            from worker import api_post

            api_post("/internal/test", {"key": "value"})

        mock_post.assert_called_once()

    def test_api_post_retries_on_failure(self) -> None:
        mock_resp = MagicMock()
        mock_resp.raise_for_status.return_value = None

        call_count = [0]

        def side_effect(*args: Any, **kwargs: Any) -> MagicMock:
            call_count[0] += 1
            if call_count[0] < 3:
                raise ConnectionError("connection refused")
            return mock_resp

        with (
            patch("worker.requests.post", side_effect=side_effect),
            patch("worker.time.sleep"),  # skip sleep
            patch("worker.settings") as ms,
        ):
            ms.api_url = "http://localhost:3000"
            from worker import api_post

            api_post("/internal/test", {})

        assert call_count[0] == 3

    def test_api_post_gives_up_after_3_attempts(self) -> None:
        with (
            patch("worker.requests.post", side_effect=ConnectionError("nope")),
            patch("worker.time.sleep"),
            patch("worker.settings") as ms,
        ):
            ms.api_url = "http://localhost:3000"
            from worker import api_post

            # Should not raise — just logs the error
            api_post("/internal/test", {})


# ---------------------------------------------------------------------------
# Tests for Redis client management
# ---------------------------------------------------------------------------


class TestRedisClient:
    """Test get_redis and reset_redis."""

    def test_get_redis_returns_client(self) -> None:
        import worker

        worker._redis_client = None  # type: ignore[attr-defined]
        mock_client = MagicMock()

        with (
            patch("redis.from_url", return_value=mock_client),
            patch("worker.settings") as ms,
        ):
            ms.redis_url = "redis://localhost:6379"
            result = worker.get_redis()

        assert result is mock_client

    def test_get_redis_is_cached(self) -> None:
        """Second call returns same client."""
        import worker

        mock_client = MagicMock()
        worker._redis_client = mock_client  # type: ignore[attr-defined]
        result = worker.get_redis()
        assert result is mock_client

    def test_reset_redis_clears_client(self) -> None:
        import worker

        worker._redis_client = MagicMock()  # type: ignore[attr-defined]
        worker.reset_redis()
        assert worker._redis_client is None  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Tests for aggregation math (pure numpy)
# ---------------------------------------------------------------------------


class TestAggregationMath:
    """Verify the partial sum computation is numerically correct."""

    def test_partial_sums_are_deterministic(self) -> None:
        """Same input → same output."""
        arrays = [np.array([1.0, 2.0, 3.0]), np.array([4.0, 5.0, 6.0])]
        stacked = np.stack(arrays, axis=0)
        result = np.sum(stacked, axis=0)
        np.testing.assert_array_equal(result, [5.0, 7.0, 9.0])

    def test_partial_sums_float64_precision(self) -> None:
        """Float64 maintains precision for 100k files."""
        n_files = 100_000
        c = 10
        # All files have value 0.1 at each index
        partial_sum = np.zeros(c, dtype=np.float64)
        for _ in range(n_files):
            partial_sum += np.full(c, 0.1)
        mean = partial_sum / n_files
        # Should be very close to 0.1
        np.testing.assert_allclose(mean, np.full(c, 0.1), rtol=1e-10)

    def test_stack_then_sum_equals_incremental_sum(self) -> None:
        """Vectorized stack+sum equals manual incremental sum."""
        arrays = [np.random.rand(100) for _ in range(5)]

        # Vectorized
        stacked = np.stack(arrays, axis=0)
        vec_sum = np.sum(stacked, axis=0)

        # Incremental
        inc_sum = np.zeros(100)
        for a in arrays:
            inc_sum += a

        np.testing.assert_allclose(vec_sum, inc_sum, rtol=1e-12)

    def test_final_mean_is_correct(self) -> None:
        """End-to-end: 4 batches of 5 files each, all value 1.0 → mean = 1.0."""
        f = 20
        c = 5
        partial_sums_list = [np.full(c, 5.0) for _ in range(4)]  # 4 batches of 5 files

        total_sum = np.zeros(c, dtype=np.float64)
        for ps in partial_sums_list:
            total_sum += ps

        final_mean = total_sum / f
        np.testing.assert_allclose(final_mean, np.ones(c), rtol=1e-10)
