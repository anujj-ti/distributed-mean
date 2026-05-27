"""
Tests for Pydantic v2 models — TaskMessage, PartialResult, WorkerSettings
"""

import pytest
from pydantic import ValidationError

from models import PartialResult, TaskMessage, WorkerSettings


class TestTaskMessage:
    """Test TaskMessage model validation."""

    def test_valid_task_message(self) -> None:
        task = TaskMessage.model_validate(
            {
                "taskId": "task-001",
                "jobId": "job-001",
                "batchIndex": 0,
                "fileStart": 0,
                "fileEnd": 4,
                "c": 100,
            }
        )
        assert task.task_id == "task-001"
        assert task.job_id == "job-001"
        assert task.batch_index == 0
        assert task.file_start == 0
        assert task.file_end == 4
        assert task.c == 100

    def test_file_indices_property(self) -> None:
        task = TaskMessage.model_validate(
            {
                "taskId": "t1",
                "jobId": "j1",
                "batchIndex": 0,
                "fileStart": 5,
                "fileEnd": 9,
                "c": 10,
            }
        )
        assert task.file_indices == [5, 6, 7, 8, 9]

    def test_file_count_property(self) -> None:
        task = TaskMessage.model_validate(
            {
                "taskId": "t1",
                "jobId": "j1",
                "batchIndex": 2,
                "fileStart": 10,
                "fileEnd": 12,
                "c": 5,
            }
        )
        assert task.file_count == 3

    def test_single_file_batch(self) -> None:
        task = TaskMessage.model_validate(
            {
                "taskId": "t1",
                "jobId": "j1",
                "batchIndex": 0,
                "fileStart": 0,
                "fileEnd": 0,
                "c": 100,
            }
        )
        assert task.file_count == 1
        assert task.file_indices == [0]

    def test_max_batch_size(self) -> None:
        """Batch of 5 files — the maximum per TASK.md constraint."""
        task = TaskMessage.model_validate(
            {
                "taskId": "t1",
                "jobId": "j1",
                "batchIndex": 3,
                "fileStart": 15,
                "fileEnd": 19,
                "c": 1000,
            }
        )
        assert task.file_count == 5
        assert len(task.file_indices) == 5

    def test_rejects_negative_file_start(self) -> None:
        with pytest.raises(ValidationError):
            TaskMessage.model_validate(
                {
                    "taskId": "t1",
                    "jobId": "j1",
                    "batchIndex": 0,
                    "fileStart": -1,
                    "fileEnd": 4,
                    "c": 10,
                }
            )

    def test_rejects_c_too_large(self) -> None:
        with pytest.raises(ValidationError):
            TaskMessage.model_validate(
                {
                    "taskId": "t1",
                    "jobId": "j1",
                    "batchIndex": 0,
                    "fileStart": 0,
                    "fileEnd": 4,
                    "c": 10_001,  # > 10_000
                }
            )

    def test_rejects_c_zero(self) -> None:
        with pytest.raises(ValidationError):
            TaskMessage.model_validate(
                {
                    "taskId": "t1",
                    "jobId": "j1",
                    "batchIndex": 0,
                    "fileStart": 0,
                    "fileEnd": 4,
                    "c": 0,
                }
            )

    def test_frozen_model_immutable(self) -> None:
        """TaskMessage is frozen — cannot be mutated."""
        task = TaskMessage.model_validate(
            {
                "taskId": "t1",
                "jobId": "j1",
                "batchIndex": 0,
                "fileStart": 0,
                "fileEnd": 4,
                "c": 10,
            }
        )
        with pytest.raises(Exception):  # noqa: B017
            task.task_id = "modified"  # type: ignore[misc]

    def test_rejects_wrong_type_for_c(self) -> None:
        """strict=True means no coercion."""
        with pytest.raises(ValidationError):
            TaskMessage.model_validate(
                {
                    "taskId": "t1",
                    "jobId": "j1",
                    "batchIndex": 0,
                    "fileStart": 0,
                    "fileEnd": 4,
                    "c": "100",  # string, not int — strict mode rejects
                }
            )


class TestPartialResult:
    """Test PartialResult model."""

    def test_valid_partial_result_via_model_construct(self) -> None:
        result = PartialResult.model_construct(
            task_id="task-001",
            job_id="job-001",
            worker_id="worker-001",
            partial_sums=[1.0, 2.0, 3.0],
            count=3,
        )
        assert result.task_id == "task-001"
        assert len(result.partial_sums) == 3
        assert result.count == 3

    def test_partial_sums_are_floats(self) -> None:
        result = PartialResult.model_construct(
            task_id="t1",
            job_id="j1",
            worker_id="w1",
            partial_sums=[0.1, 0.2, 0.3, 0.4, 0.5],
            count=5,
        )
        assert all(isinstance(s, float) for s in result.partial_sums)

    def test_large_partial_sums(self) -> None:
        """Handles C=10000 values."""
        sums = [float(i) * 0.001 for i in range(10_000)]
        result = PartialResult.model_construct(
            task_id="t1",
            job_id="j1",
            worker_id="w1",
            partial_sums=sums,
            count=5,
        )
        assert len(result.partial_sums) == 10_000


class TestWorkerSettings:
    """Test WorkerSettings configuration."""

    def test_default_settings(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Clear any env vars that might interfere
        monkeypatch.delenv("REDIS_URL", raising=False)
        monkeypatch.delenv("API_URL", raising=False)
        s = WorkerSettings()
        assert s.redis_url == "redis://localhost:6379"
        assert s.api_url == "http://localhost:3000"
        assert s.minio_bucket == "distributed-mean"
        assert s.worker_slowness == 0.0

    def test_env_var_override(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("REDIS_URL", "redis://myhost:6380")
        monkeypatch.setenv("WORKER_SLOWNESS", "2.5")
        s = WorkerSettings()
        assert s.redis_url == "redis://myhost:6380"
        assert s.worker_slowness == 2.5

    def test_queue_name_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("QUEUE_NAME", raising=False)
        s = WorkerSettings()
        assert s.queue_name == "dmsystem:queue"
