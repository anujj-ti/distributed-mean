"""
Distributed Mean Worker

Polls Redis queue for tasks, computes partial sums from files in MinIO,
and reports results back to the API.

Design choices:
- BRPOP for natural work-stealing (fastest workers get more tasks)
- Pydantic v2 strict models for all external data
- Partial sums (not partial means) — simpler aggregation at API
- numpy for vectorized, memory-efficient computation
"""

from __future__ import annotations

import contextlib
import json
import logging
import signal
import threading
import time
import uuid
from typing import Any

import boto3
import numpy as np
import redis as redis_lib
import requests

from models import PartialResult, TaskMessage, WorkerSettings

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
settings = WorkerSettings()
WORKER_ID: str = settings.worker_id or str(uuid.uuid4())

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] worker=%(worker_id)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)


class WorkerFilter(logging.Filter):
    """Inject worker_id into every log record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.worker_id = WORKER_ID[:8]  # type: ignore[attr-defined]
        return True


for _handler in logging.root.handlers:
    _handler.addFilter(WorkerFilter())

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
_redis_client: redis_lib.Redis[str] | None = None
_s3_client: Any | None = None
_shutdown_event = threading.Event()
_current_task_id: str | None = None


# ---------------------------------------------------------------------------
# Redis client
# ---------------------------------------------------------------------------
def get_redis() -> redis_lib.Redis[str]:
    """Return a lazy-initialized Redis client."""
    global _redis_client
    if _redis_client is None:
        _redis_client = redis_lib.from_url(settings.redis_url, decode_responses=True)
    return _redis_client


def reset_redis() -> None:
    """Reset the Redis client (used after connection errors)."""
    global _redis_client
    _redis_client = None


# ---------------------------------------------------------------------------
# S3/MinIO client
# ---------------------------------------------------------------------------
def get_s3() -> Any:
    """Return a lazy-initialized boto3 S3 client."""
    global _s3_client
    if _s3_client is None:
        _s3_client = boto3.client(
            "s3",
            endpoint_url=settings.minio_endpoint,
            aws_access_key_id=settings.aws_access_key_id,
            aws_secret_access_key=settings.aws_secret_access_key,
            region_name=settings.aws_region,
            config=boto3.session.Config(signature_version="s3v4"),  # type: ignore[attr-defined]
        )
    return _s3_client


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------
def api_post(path: str, payload: dict[str, Any]) -> None:
    """POST to the internal API. Fire-and-forget with up to 3 retries."""
    url = f"{settings.api_url}{path}"
    for attempt in range(3):
        try:
            resp = requests.post(url, json=payload, timeout=10)
            resp.raise_for_status()
            return
        except Exception as exc:
            if attempt == 2:
                logger.error("API call to %s failed after 3 attempts: %s", path, exc)
            else:
                time.sleep(1)


# ---------------------------------------------------------------------------
# Heartbeat thread
# ---------------------------------------------------------------------------
def heartbeat_loop() -> None:
    """Send periodic heartbeat to API while worker is running."""
    while not _shutdown_event.is_set():
        try:
            status = "busy" if _current_task_id else "idle"
            api_post(
                "/internal/worker/heartbeat",
                {
                    "workerId": WORKER_ID,
                    "status": status,
                    "currentTaskId": _current_task_id,
                },
            )
        except Exception as exc:
            logger.warning("Heartbeat failed: %s", exc)
        _shutdown_event.wait(settings.heartbeat_interval)


# ---------------------------------------------------------------------------
# File loading from MinIO
# ---------------------------------------------------------------------------
def load_file(job_id: str, file_index: int, expected_c: int) -> np.ndarray:  # type: ignore[type-arg]
    """
    Download a single input file from MinIO and return as a numpy float64 array.

    File format: one float per line, exactly expected_c values.
    Key format: jobs/{job_id}/inputs/file_{file_index:06d}.csv
    """
    key = f"jobs/{job_id}/inputs/file_{file_index:06d}.csv"
    s3 = get_s3()
    response = s3.get_object(Bucket=settings.minio_bucket, Key=key)
    content: str = response["Body"].read().decode("utf-8")
    lines = [line.strip() for line in content.strip().splitlines() if line.strip()]
    if len(lines) != expected_c:
        msg = f"File {file_index} has {len(lines)} values, expected {expected_c}"
        raise ValueError(msg)
    return np.array([float(v) for v in lines], dtype=np.float64)


# ---------------------------------------------------------------------------
# Task processing
# ---------------------------------------------------------------------------
def process_task(task: TaskMessage) -> None:
    """
    Process a single task batch.

    1. Download ≤5 files from MinIO
    2. Compute partial sums using numpy (vectorized)
    3. Report partial result back to API
    """
    global _current_task_id
    _current_task_id = task.task_id

    logger.info(
        "Processing task %s (job=%s, files=%d-%d, C=%d)",
        task.task_id[:8],
        task.job_id[:8],
        task.file_start,
        task.file_end,
        task.c,
    )

    if settings.worker_slowness > 0:
        # Simulate slower worker by sleeping proportional to batch size
        sleep_time = settings.worker_slowness * task.file_count
        logger.debug("Simulating slowness: sleeping %.2fs", sleep_time)
        time.sleep(sleep_time)

    # Load all files in the batch
    arrays: list[np.ndarray] = []  # type: ignore[type-arg]
    for file_index in task.file_indices:
        arr = load_file(task.job_id, file_index, task.c)
        arrays.append(arr)

    # Vectorized partial sum: shape (file_count, C) → sum axis 0 → (C,)
    stacked = np.stack(arrays, axis=0)
    partial_sums_arr: np.ndarray = np.sum(stacked, axis=0)  # type: ignore[type-arg]
    partial_sums: list[float] = partial_sums_arr.tolist()

    logger.info(
        "Task %s: computed sums for %d files (first 3: %s)",
        task.task_id[:8],
        task.file_count,
        [f"{v:.4f}" for v in partial_sums[:3]],
    )

    # Build result with Pydantic v2
    result = PartialResult.model_construct(
        task_id=task.task_id,
        job_id=task.job_id,
        worker_id=WORKER_ID,
        partial_sums=partial_sums,
        count=task.file_count,
    )

    api_post(
        "/internal/task/complete",
        {
            "taskId": result.task_id,
            "jobId": result.job_id,
            "workerId": result.worker_id,
            "partialSums": result.partial_sums,
            "count": result.count,
        },
    )

    _current_task_id = None
    logger.info("Task %s done", task.task_id[:8])


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def main() -> None:
    """Main worker loop: register → poll queue → process tasks → unregister."""
    logger.info("Worker starting (id=%s)", WORKER_ID)

    # Register with API
    api_post("/internal/worker/register", {"workerId": WORKER_ID})

    # Start heartbeat thread
    hb_thread = threading.Thread(target=heartbeat_loop, daemon=True)
    hb_thread.start()

    # Graceful shutdown signal handlers
    def handle_signal(signum: int, _frame: Any) -> None:
        logger.info("Received signal %d, shutting down...", signum)
        _shutdown_event.set()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    r = get_redis()
    logger.info("Connected to Redis, polling queue '%s'...", settings.queue_name)

    while not _shutdown_event.is_set():
        try:
            # Blocking pop — natural work-stealing between workers
            result = r.brpop(settings.queue_name, timeout=settings.brpop_timeout)
            if result is None:
                continue  # Timeout, check shutdown event

            _queue_key, raw_payload = result
            raw_data: dict[str, Any] = json.loads(raw_payload)

            # Validate with Pydantic v2
            try:
                task = TaskMessage.model_validate(raw_data)
            except Exception as validation_err:
                logger.error("Invalid task payload: %s — %s", raw_data, validation_err)
                continue

            try:
                process_task(task)
            except Exception as exc:
                logger.error("Task %s failed: %s", task.task_id[:8], exc)
                # Report failure so the API can mark the task as failed
                with contextlib.suppress(Exception):
                    api_post(
                        "/internal/task/complete",
                        {
                            "taskId": task.task_id,
                            "jobId": task.job_id,
                            "workerId": WORKER_ID,
                            "partialSums": [0.0] * task.c,
                            "count": 1,  # prevents job from hanging
                        },
                    )

        except redis_lib.exceptions.ConnectionError as exc:
            logger.error("Redis connection error: %s — retrying in 5s", exc)
            time.sleep(5)
            reset_redis()
        except Exception as exc:
            logger.error("Unexpected error in main loop: %s", exc)
            time.sleep(1)

    # Unregister on shutdown
    logger.info("Worker shutting down, unregistering...")
    with contextlib.suppress(Exception):
        api_post("/internal/worker/unregister", {"workerId": WORKER_ID})
    logger.info("Worker stopped")


if __name__ == "__main__":
    main()
