"""
Pydantic v2 models for the Distributed Mean worker.

All external data structures are strictly typed and validated.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class TaskMessage(BaseModel):
    """A task received from the Redis queue."""

    model_config = ConfigDict(strict=True, frozen=True)

    task_id: str = Field(alias="taskId")
    job_id: str = Field(alias="jobId")
    batch_index: int = Field(alias="batchIndex", ge=0)
    file_start: int = Field(alias="fileStart", ge=0)
    file_end: int = Field(alias="fileEnd", ge=0)
    c: int = Field(gt=0, le=10_000)

    @property
    def file_indices(self) -> list[int]:
        """Return list of file indices for this task."""
        return list(range(self.file_start, self.file_end + 1))

    @property
    def file_count(self) -> int:
        """Number of files in this task batch."""
        return self.file_end - self.file_start + 1


class PartialResult(BaseModel):
    """Partial sums result posted back to the API."""

    model_config = ConfigDict(strict=True)

    task_id: str = Field(alias="taskId")
    job_id: str = Field(alias="jobId")
    worker_id: str = Field(alias="workerId")
    partial_sums: list[float] = Field(alias="partialSums", min_length=1)
    count: int = Field(gt=0)

    model_config = ConfigDict(strict=True, populate_by_name=True)


class WorkerSettings(BaseSettings):
    """Worker configuration from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    redis_url: str = Field(default="redis://localhost:6379")
    api_url: str = Field(default="http://localhost:3000")
    minio_endpoint: str = Field(default="http://localhost:9000")
    minio_bucket: str = Field(default="distributed-mean")
    aws_access_key_id: str = Field(default="minioadmin")
    aws_secret_access_key: str = Field(default="minioadmin")
    aws_region: str = Field(default="us-east-1")
    worker_id: str | None = Field(default=None)
    worker_slowness: float = Field(default=0.0, ge=0.0, le=60.0)
    queue_name: str = Field(default="dmsystem:queue")
    brpop_timeout: int = Field(default=5, gt=0)
    heartbeat_interval: int = Field(default=10, gt=0)
    task_timeout_seconds: int = Field(default=300, gt=0)
