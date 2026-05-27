"""
Distributed Mean Worker

Polls Redis queue for tasks, computes partial sums from files in MinIO,
and reports results back to the API.
"""
from __future__ import annotations

import json
import logging
import os
import signal
import threading
import time
import uuid
from typing import Any

import boto3
import numpy as np
import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] worker=%(worker_id)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
REDIS_URL: str = os.environ.get("REDIS_URL", "redis://localhost:6379")
MINIO_ENDPOINT: str = os.environ.get("MINIO_ENDPOINT", "http://localhost:9000")
MINIO_BUCKET: str = os.environ.get("MINIO_BUCKET", "distributed-mean")
AWS_ACCESS_KEY_ID: str = os.environ.get("AWS_ACCESS_KEY_ID", "minioadmin")
AWS_SECRET_ACCESS_KEY: str = os.environ.get("AWS_SECRET_ACCESS_KEY", "minioadmin")
AWS_REGION: str = os.environ.get("AWS_REGION", "us-east-1")
API_URL: str = os.environ.get("API_URL", "http://localhost:3000")
WORKER_ID: str = os.environ.get("WORKER_ID", str(uuid.uuid4()))
QUEUE_KEY: str = "dmsystem:queue"
BRPOP_TIMEOUT: int = 5  # seconds
HEARTBEAT_INTERVAL: int = 10  # seconds

# Artificial slowness simulation (set WORKER_SLOWNESS=0.0 to 1.0 for a sleep multiplier)
SLOWNESS: float = float(os.environ.get("WORKER_SLOWNESS", "0"))


class WorkerFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.worker_id = WORKER_ID[:8]  # type: ignore[attr-defined]
        return True


for handler in logging.root.handlers:
    handler.addFilter(WorkerFilter())

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Redis client
# ---------------------------------------------------------------------------
import redis as redis_lib

_redis_client: redis_lib.Redis | None = None


def get_redis() -> redis_lib.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = redis_lib.from_url(REDIS_URL, decode_responses=True)
    return _redis_client


# ---------------------------------------------------------------------------
# S3/MinIO client
# ---------------------------------------------------------------------------
_s3_client: Any = None


def get_s3() -> Any:
    global _s3_client
    if _s3_client is None:
        _s3_client = boto3.client(
            "s3",
            endpoint_url=MINIO_ENDPOINT,
            aws_access_key_id=AWS_ACCESS_KEY_ID,
            aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
            region_name=AWS_REGION,
            config=boto3.session.Config(signature_version="s3v4"),  # type: ignore[attr-defined]
        )
    return _s3_client


# ---------------------------------------------------------------------------
# API helper
# ---------------------------------------------------------------------------
def api_post(path: str, payload: dict[str, Any]) -> None:
    """POST to the internal API. Fire-and-forget with retry."""
    url = f"{API_URL}{path}"
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
_shutdown_event = threading.Event()
_current_task_id: str | None = None


def heartbeat_loop() -> None:
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
        _shutdown_event.wait(HEARTBEAT_INTERVAL)


# ---------------------------------------------------------------------------
# File loading from MinIO
# ---------------------------------------------------------------------------
def load_file(job_id: str, file_index: int) -> np.ndarray:
    """Download a file from MinIO and return its values as a numpy array."""
    key = f"jobs/{job_id}/inputs/file_{file_index:06d}.csv"
    s3 = get_s3()
    response = s3.get_object(Bucket=MINIO_BUCKET, Key=key)
    content = response["Body"].read().decode("utf-8")
    lines = [line.strip() for line in content.strip().splitlines() if line.strip()]
    return np.array([float(v) for v in lines], dtype=np.float64)


# ---------------------------------------------------------------------------
# Task processing
# ---------------------------------------------------------------------------
def process_task(task: dict[str, Any]) -> None:
    global _current_task_id

    task_id: str = task["taskId"]
    job_id: str = task["jobId"]
    file_start: int = task["fileStart"]
    file_end: int = task["fileEnd"]
    c: int = task["c"]

    _current_task_id = task_id
    logger.info(
        "Processing task %s (job=%s, files=%d-%d, C=%d)",
        task_id[:8],
        job_id[:8],
        file_start,
        file_end,
        c,
    )

    # Optional slowness simulation
    if SLOWNESS > 0:
        time.sleep(SLOWNESS * (file_end - file_start + 1))

    # Load all files in batch
    file_indices = list(range(file_start, file_end + 1))
    arrays: list[np.ndarray] = []

    for fi in file_indices:
        arr = load_file(job_id, fi)
        if len(arr) != c:
            raise ValueError(
                f"File {fi} has {len(arr)} values, expected {c}"
            )
        arrays.append(arr)

    # Compute partial sums using numpy (vectorized, O(batch_size * C))
    stacked = np.stack(arrays, axis=0)  # shape: (batch_size, C)
    partial_sums: list[float] = np.sum(stacked, axis=0).tolist()
    count = len(arrays)

    logger.info(
        "Task %s computed partial sums for %d files (first 3 sums: %s)",
        task_id[:8],
        count,
        [f"{v:.4f}" for v in partial_sums[:3]],
    )

    # Report completion to API
    api_post(
        "/internal/task/complete",
        {
            "taskId": task_id,
            "jobId": job_id,
            "workerId": WORKER_ID,
            "partialSums": partial_sums,
            "count": count,
        },
    )

    _current_task_id = None
    logger.info("Task %s done", task_id[:8])


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def main() -> None:
    logger.info("Worker starting (id=%s)", WORKER_ID)

    # Register with API
    api_post("/internal/worker/register", {"workerId": WORKER_ID})

    # Start heartbeat thread
    hb_thread = threading.Thread(target=heartbeat_loop, daemon=True)
    hb_thread.start()

    # Graceful shutdown
    def handle_signal(signum: int, _frame: Any) -> None:
        logger.info("Received signal %d, shutting down...", signum)
        _shutdown_event.set()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    r = get_redis()
    logger.info("Connected to Redis, polling queue '%s'...", QUEUE_KEY)

    while not _shutdown_event.is_set():
        try:
            # Blocking pop with timeout — natural work stealing
            result = r.brpop(QUEUE_KEY, timeout=BRPOP_TIMEOUT)
            if result is None:
                # Timeout — just loop (heartbeat thread handles keepalive)
                continue

            _queue_key, raw_payload = result
            task = json.loads(raw_payload)

            try:
                process_task(task)
            except Exception as exc:
                logger.error("Task %s failed: %s", task.get("taskId", "?")[:8], exc)
                # Report failure to API if possible
                try:
                    api_post(
                        "/internal/task/complete",
                        {
                            "taskId": task["taskId"],
                            "jobId": task["jobId"],
                            "workerId": WORKER_ID,
                            "error": str(exc),
                            "partialSums": [0.0] * task.get("c", 1),
                            "count": 0,
                        },
                    )
                except Exception:
                    pass

        except redis_lib.exceptions.ConnectionError as exc:
            logger.error("Redis connection error: %s — retrying in 5s", exc)
            time.sleep(5)
            _redis_client = None  # Reset connection
        except Exception as exc:
            logger.error("Unexpected error in main loop: %s", exc)
            time.sleep(1)

    # Unregister
    logger.info("Worker shutting down, unregistering...")
    try:
        api_post("/internal/worker/unregister", {"workerId": WORKER_ID})
    except Exception:
        pass
    logger.info("Worker stopped")


if __name__ == "__main__":
    main()
