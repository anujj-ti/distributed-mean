"""
Tests for worker.py — main loop, heartbeat, S3 client, signal handling.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Tests for get_s3
# ---------------------------------------------------------------------------


class TestGetS3:
    """Test S3 client lazy initialization."""

    def test_get_s3_creates_client(self) -> None:
        import worker

        worker._s3_client = None  # type: ignore[attr-defined]
        mock_client = MagicMock()

        with (
            patch("boto3.client", return_value=mock_client),
            patch("worker.settings") as ms,
        ):
            ms.minio_endpoint = "http://minio:9000"
            ms.aws_access_key_id = "minioadmin"
            ms.aws_secret_access_key = "minioadmin"
            ms.aws_region = "us-east-1"
            result = worker.get_s3()

        assert result is mock_client

    def test_get_s3_is_cached(self) -> None:
        import worker

        mock_client = MagicMock()
        worker._s3_client = mock_client  # type: ignore[attr-defined]
        result = worker.get_s3()
        assert result is mock_client

    def test_get_s3_reset_on_none(self) -> None:
        import worker

        worker._s3_client = None  # type: ignore[attr-defined]
        mock_boto = MagicMock()

        with (
            patch("boto3.client", return_value=mock_boto),
            patch("worker.settings") as ms,
        ):
            ms.minio_endpoint = "http://minio:9000"
            ms.aws_access_key_id = "key"
            ms.aws_secret_access_key = "secret"
            ms.aws_region = "us-east-1"
            worker.get_s3()

        # Second call should be cached
        result2 = worker.get_s3()
        assert result2 is mock_boto


# ---------------------------------------------------------------------------
# Tests for heartbeat_loop
# ---------------------------------------------------------------------------


class TestHeartbeatLoop:
    """Test the heartbeat loop function."""

    def test_heartbeat_sends_idle_when_no_task(self) -> None:
        import worker

        worker._current_task_id = None  # type: ignore[attr-defined]
        worker._shutdown_event.clear()  # type: ignore[attr-defined]

        calls: list[dict[str, Any]] = []
        call_count = [0]

        def fake_api_post(path: str, payload: dict[str, Any]) -> None:
            calls.append({"path": path, "payload": payload})
            call_count[0] += 1
            if call_count[0] >= 1:
                worker._shutdown_event.set()  # type: ignore[attr-defined]

        with (
            patch("worker.api_post", side_effect=fake_api_post),
            patch("worker.settings") as ms,
        ):
            ms.heartbeat_interval = 0  # no sleep
            worker.heartbeat_loop()

        assert len(calls) >= 1
        assert calls[0]["payload"]["status"] == "idle"
        worker._shutdown_event.clear()  # type: ignore[attr-defined]

    def test_heartbeat_sends_busy_when_task_running(self) -> None:
        import worker

        worker._current_task_id = "task-abc"  # type: ignore[attr-defined]
        worker._shutdown_event.clear()  # type: ignore[attr-defined]

        calls: list[dict[str, Any]] = []
        call_count = [0]

        def fake_api_post(path: str, payload: dict[str, Any]) -> None:
            calls.append({"path": path, "payload": payload})
            call_count[0] += 1
            if call_count[0] >= 1:
                worker._shutdown_event.set()  # type: ignore[attr-defined]

        with (
            patch("worker.api_post", side_effect=fake_api_post),
            patch("worker.settings") as ms,
        ):
            ms.heartbeat_interval = 0
            worker.heartbeat_loop()

        assert calls[0]["payload"]["status"] == "busy"
        assert calls[0]["payload"]["currentTaskId"] == "task-abc"
        worker._current_task_id = None  # type: ignore[attr-defined]
        worker._shutdown_event.clear()  # type: ignore[attr-defined]

    def test_heartbeat_handles_api_exception(self) -> None:
        import worker

        worker._current_task_id = None  # type: ignore[attr-defined]
        worker._shutdown_event.clear()  # type: ignore[attr-defined]

        call_count = [0]

        def failing_api_post(path: str, payload: dict[str, Any]) -> None:
            call_count[0] += 1
            worker._shutdown_event.set()  # type: ignore[attr-defined]
            raise ConnectionError("API down")

        with (
            patch("worker.api_post", side_effect=failing_api_post),
            patch("worker.settings") as ms,
        ):
            ms.heartbeat_interval = 0
            # Should not raise
            worker.heartbeat_loop()

        assert call_count[0] >= 1
        worker._shutdown_event.clear()  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Tests for main() loop
# ---------------------------------------------------------------------------


class TestMainLoop:
    """Test the main worker loop with mock Redis."""

    def _make_redis_mock(self, tasks: list[dict[str, Any] | None]) -> MagicMock:
        """Mock Redis that returns tasks from a list, then stops."""
        r = MagicMock()
        brpop_calls: list[Any] = []
        for task in tasks:
            if task is None:
                brpop_calls.append(None)
            else:
                brpop_calls.append(("queue", json.dumps(task)))
        r.brpop.side_effect = brpop_calls
        return r

    def test_main_registers_and_polls(self) -> None:
        import worker

        worker._shutdown_event.clear()  # type: ignore[attr-defined]
        worker._redis_client = None  # type: ignore[attr-defined]

        api_calls: list[str] = []
        call_count = [0]

        def fake_api_post(path: str, payload: dict[str, Any]) -> None:
            api_calls.append(path)

        # After one timeout (None from brpop), set shutdown
        mock_redis = self._make_redis_mock([None])
        mock_redis.brpop.side_effect = [None]

        def set_shutdown(*args: Any, **kwargs: Any) -> None:
            call_count[0] += 1
            worker._shutdown_event.set()  # type: ignore[attr-defined]
            return None

        mock_redis.brpop.side_effect = set_shutdown

        with (
            patch("worker.api_post", side_effect=fake_api_post),
            patch("worker.get_redis", return_value=mock_redis),
            patch("worker.settings") as ms,
            patch("threading.Thread") as mock_thread,
        ):
            ms.queue_name = "dmsystem:queue"
            ms.brpop_timeout = 5
            ms.api_url = "http://localhost:3000"
            ms.heartbeat_interval = 10
            mock_thread.return_value = MagicMock()
            worker.main()

        # Should have registered
        assert "/internal/worker/register" in api_calls
        # Should have unregistered on shutdown
        assert "/internal/worker/unregister" in api_calls

    def test_main_processes_valid_task(self) -> None:
        import worker

        worker._shutdown_event.clear()  # type: ignore[attr-defined]
        worker._redis_client = None  # type: ignore[attr-defined]

        task_payload = {
            "taskId": "task-test",
            "jobId": "job-test",
            "batchIndex": 0,
            "fileStart": 0,
            "fileEnd": 0,
            "c": 3,
        }

        call_count = [0]

        def fake_brpop(queue: str, timeout: int) -> tuple[str, str] | None:
            call_count[0] += 1
            if call_count[0] == 1:
                return ("queue", json.dumps(task_payload))
            worker._shutdown_event.set()  # type: ignore[attr-defined]
            return None

        mock_redis = MagicMock()
        mock_redis.brpop.side_effect = fake_brpop

        with (
            patch("worker.api_post"),
            patch("worker.get_redis", return_value=mock_redis),
            patch("worker.process_task") as mock_process,
            patch("worker.settings") as ms,
            patch("threading.Thread") as mock_thread,
        ):
            ms.queue_name = "dmsystem:queue"
            ms.brpop_timeout = 5
            ms.api_url = "http://localhost:3000"
            ms.heartbeat_interval = 10
            mock_thread.return_value = MagicMock()
            worker.main()

        mock_process.assert_called_once()
        task_arg = mock_process.call_args[0][0]
        assert task_arg.task_id == "task-test"

    def test_main_handles_invalid_task_payload(self) -> None:
        """Invalid task payload should be skipped (logged but no crash)."""
        import worker

        worker._shutdown_event.clear()  # type: ignore[attr-defined]
        worker._redis_client = None  # type: ignore[attr-defined]

        call_count = [0]

        def fake_brpop(queue: str, timeout: int) -> tuple[str, str] | None:
            call_count[0] += 1
            if call_count[0] == 1:
                return ("queue", '{"invalid": "payload"}')  # missing required fields
            worker._shutdown_event.set()  # type: ignore[attr-defined]
            return None

        mock_redis = MagicMock()
        mock_redis.brpop.side_effect = fake_brpop

        with (
            patch("worker.api_post"),
            patch("worker.get_redis", return_value=mock_redis),
            patch("worker.process_task") as mock_process,
            patch("worker.settings") as ms,
            patch("threading.Thread") as mock_thread,
        ):
            ms.queue_name = "dmsystem:queue"
            ms.brpop_timeout = 5
            ms.api_url = "http://localhost:3000"
            ms.heartbeat_interval = 10
            mock_thread.return_value = MagicMock()
            worker.main()  # should not raise

        mock_process.assert_not_called()

    def test_main_handles_redis_connection_error(self) -> None:
        """Redis connection errors cause a 5s sleep and reconnect."""
        import redis as redis_lib

        import worker

        worker._shutdown_event.clear()  # type: ignore[attr-defined]
        worker._redis_client = None  # type: ignore[attr-defined]

        call_count = [0]
        sleep_count = [0]

        def fake_brpop(queue: str, timeout: int) -> tuple[str, str] | None:
            call_count[0] += 1
            if call_count[0] == 1:
                raise redis_lib.exceptions.ConnectionError("Connection refused")
            worker._shutdown_event.set()  # type: ignore[attr-defined]
            return None

        mock_redis = MagicMock()
        mock_redis.brpop.side_effect = fake_brpop

        with (
            patch("worker.api_post"),
            patch("worker.get_redis", return_value=mock_redis),
            patch("worker.settings") as ms,
            patch("threading.Thread") as mock_thread,
            patch(
                "worker.time.sleep",
                side_effect=lambda s: sleep_count.__setitem__(0, sleep_count[0] + 1),
            ),
        ):
            ms.queue_name = "dmsystem:queue"
            ms.brpop_timeout = 5
            ms.api_url = "http://localhost:3000"
            ms.heartbeat_interval = 10
            mock_thread.return_value = MagicMock()
            worker.main()

        # Should have slept 5s for the connection error
        assert sleep_count[0] >= 1

    def test_main_handles_task_processing_failure(self) -> None:
        """Task processing failure should report error to API and continue."""
        import worker

        worker._shutdown_event.clear()  # type: ignore[attr-defined]
        worker._redis_client = None  # type: ignore[attr-defined]

        task_payload = {
            "taskId": "task-fail",
            "jobId": "job-fail",
            "batchIndex": 0,
            "fileStart": 0,
            "fileEnd": 0,
            "c": 3,
        }

        call_count = [0]
        api_calls: list[str] = []

        def fake_brpop(queue: str, timeout: int) -> tuple[str, str] | None:
            call_count[0] += 1
            if call_count[0] == 1:
                return ("queue", json.dumps(task_payload))
            worker._shutdown_event.set()  # type: ignore[attr-defined]
            return None

        mock_redis = MagicMock()
        mock_redis.brpop.side_effect = fake_brpop

        def fake_api(path: str, payload: dict[str, Any]) -> None:
            api_calls.append(path)

        with (
            patch("worker.api_post", side_effect=fake_api),
            patch("worker.get_redis", return_value=mock_redis),
            patch("worker.process_task", side_effect=RuntimeError("Processing failed")),
            patch("worker.settings") as ms,
            patch("threading.Thread") as mock_thread,
        ):
            ms.queue_name = "dmsystem:queue"
            ms.brpop_timeout = 5
            ms.api_url = "http://localhost:3000"
            ms.heartbeat_interval = 10
            mock_thread.return_value = MagicMock()
            worker.main()

        # Should have attempted to report the task failure
        assert "/internal/task/complete" in api_calls
