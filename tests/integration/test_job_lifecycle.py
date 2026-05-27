"""
Integration tests for the Distributed Mean system.

These tests run against a live docker compose stack.
Set API_URL environment variable or use the default localhost:3000.
"""
from __future__ import annotations

import os
import time
from typing import Any

import pytest
import requests

API_URL = os.environ.get("API_URL", "http://localhost:3000")
REQUEST_TIMEOUT = 10


def api(path: str) -> Any:
    """GET from API, return parsed JSON."""
    return requests.get(f"{API_URL}{path}", timeout=REQUEST_TIMEOUT).json()


def post(path: str, body: dict[str, Any]) -> requests.Response:
    """POST to API."""
    return requests.post(f"{API_URL}{path}", json=body, timeout=REQUEST_TIMEOUT)


@pytest.fixture(scope="session", autouse=True)
def wait_for_api() -> None:
    """Wait for the API to be healthy before running tests."""
    for attempt in range(30):
        try:
            resp = requests.get(f"{API_URL}/system", timeout=5)
            if resp.status_code == 200:
                print(f"\nAPI healthy after {attempt + 1} attempts")
                return
        except Exception:
            pass
        time.sleep(2)
    pytest.fail("API did not become healthy within 60 seconds")


class TestSystemHealth:
    """Basic health checks for the system."""

    def test_system_endpoint_returns_200(self) -> None:
        resp = requests.get(f"{API_URL}/system", timeout=REQUEST_TIMEOUT)
        assert resp.status_code == 200

    def test_system_has_required_fields(self) -> None:
        stats = api("/system")
        assert "workers" in stats
        assert "queueDepth" in stats
        assert "jobStats" in stats
        assert "workerCount" in stats

    def test_system_jobstats_has_all_statuses(self) -> None:
        stats = api("/system")
        job_stats = stats["jobStats"]
        for status in ["total", "generating", "queued", "running", "aggregating", "done", "failed"]:
            assert status in job_stats, f"Missing job status: {status}"

    def test_jobs_list_returns_200(self) -> None:
        resp = requests.get(f"{API_URL}/jobs", timeout=REQUEST_TIMEOUT)
        assert resp.status_code == 200
        data = resp.json()
        assert "jobs" in data
        assert isinstance(data["jobs"], list)


class TestJobValidation:
    """Input validation tests."""

    def test_post_jobs_rejects_missing_f(self) -> None:
        resp = post("/jobs", {"C": 10})
        assert resp.status_code == 400

    def test_post_jobs_rejects_missing_c(self) -> None:
        resp = post("/jobs", {"F": 10})
        assert resp.status_code == 400

    def test_post_jobs_rejects_f_less_than_2(self) -> None:
        resp = post("/jobs", {"F": 1, "C": 10})
        assert resp.status_code == 400

    def test_post_jobs_rejects_c_greater_than_10000(self) -> None:
        resp = post("/jobs", {"F": 10, "C": 10001})
        assert resp.status_code == 400

    def test_post_jobs_rejects_string_values(self) -> None:
        resp = post("/jobs", {"F": "ten", "C": "five"})
        assert resp.status_code == 400

    def test_get_job_returns_404_for_unknown(self) -> None:
        resp = requests.get(f"{API_URL}/jobs/nonexistent-job-id", timeout=REQUEST_TIMEOUT)
        assert resp.status_code == 404

    def test_get_job_result_returns_404_for_unknown(self) -> None:
        resp = requests.get(f"{API_URL}/jobs/nonexistent-job-id/result", timeout=REQUEST_TIMEOUT)
        assert resp.status_code == 404

    def test_patch_system_workers_rejects_zero(self) -> None:
        resp = requests.patch(f"{API_URL}/system/workers", json={"count": 0}, timeout=REQUEST_TIMEOUT)
        assert resp.status_code == 400

    def test_patch_system_workers_rejects_too_many(self) -> None:
        resp = requests.patch(f"{API_URL}/system/workers", json={"count": 25}, timeout=REQUEST_TIMEOUT)
        assert resp.status_code == 400


class TestJobSubmission:
    """Test job creation flow."""

    def test_submit_small_job_returns_202(self) -> None:
        resp = post("/jobs", {"F": 2, "C": 5})
        assert resp.status_code == 202

    def test_submit_job_returns_correct_batch_count(self) -> None:
        resp = post("/jobs", {"F": 10, "C": 5})
        assert resp.status_code == 202
        data = resp.json()
        assert data["batchCount"] == 2  # ceil(10/5) = 2

    def test_submit_job_returns_correct_batch_count_f13(self) -> None:
        resp = post("/jobs", {"F": 13, "C": 5})
        assert resp.status_code == 202
        data = resp.json()
        assert data["batchCount"] == 3  # ceil(13/5) = 3

    def test_submit_job_returns_job_id(self) -> None:
        resp = post("/jobs", {"F": 5, "C": 3})
        assert resp.status_code == 202
        data = resp.json()
        assert "jobId" in data
        assert len(data["jobId"]) == 36  # UUID format

    def test_submitted_job_appears_in_list(self) -> None:
        resp = post("/jobs", {"F": 5, "C": 5})
        assert resp.status_code == 202
        job_id = resp.json()["jobId"]

        # Job should appear in the list
        jobs_resp = api("/jobs")
        job_ids = [j["id"] for j in jobs_resp["jobs"]]
        assert job_id in job_ids

    def test_get_job_by_id(self) -> None:
        resp = post("/jobs", {"F": 5, "C": 5})
        job_id = resp.json()["jobId"]

        job = api(f"/jobs/{job_id}")
        assert job["id"] == job_id
        assert "status" in job
        assert job["f"] == 5
        assert job["c"] == 5

    def test_get_job_tasks(self) -> None:
        resp = post("/jobs", {"F": 10, "C": 5})
        assert resp.status_code == 202
        job_id = resp.json()["jobId"]

        # Wait a bit for tasks to be created
        time.sleep(2)

        tasks_resp = requests.get(f"{API_URL}/jobs/{job_id}/tasks", timeout=REQUEST_TIMEOUT)
        assert tasks_resp.status_code == 200
        data = tasks_resp.json()
        assert "tasks" in data


class TestJobCompletion:
    """Test a full job lifecycle with workers."""

    def wait_for_job(self, job_id: str, timeout: int = 90) -> dict[str, Any]:
        """Poll until job reaches 'done' or 'failed' status."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            job = api(f"/jobs/{job_id}")
            if job["status"] in ("done", "failed"):
                return job
            time.sleep(2)
        pytest.fail(f"Job {job_id} did not complete within {timeout}s (current status: {job['status']})")

    def test_small_job_completes(self) -> None:
        """F=5, C=3: should complete in a single batch."""
        stats_before = api("/system")
        workers_count = stats_before.get("workerCount", 0)

        if workers_count == 0:
            pytest.skip("No workers running — start with docker compose up --scale worker=2")

        resp = post("/jobs", {"F": 5, "C": 3})
        assert resp.status_code == 202
        job_id = resp.json()["jobId"]

        job = self.wait_for_job(job_id, timeout=60)
        assert job["status"] == "done", f"Job failed: {job.get('error')}"
        assert job["resultPath"] is not None

    def test_completed_job_result_downloadable(self) -> None:
        """Result CSV should be downloadable after job completes."""
        stats = api("/system")
        if stats.get("workerCount", 0) == 0:
            pytest.skip("No workers running")

        resp = post("/jobs", {"F": 5, "C": 5})
        job_id = resp.json()["jobId"]

        job = self.wait_for_job(job_id, timeout=60)
        assert job["status"] == "done"

        result_resp = requests.get(f"{API_URL}/jobs/{job_id}/result", timeout=30)
        assert result_resp.status_code == 200
        assert result_resp.headers.get("content-type", "").startswith("text/csv")

        # Verify CSV has exactly C lines
        lines = [l for l in result_resp.text.strip().split("\n") if l.strip()]
        assert len(lines) == 5  # C=5

    def test_result_values_are_valid_floats(self) -> None:
        """Result CSV values should be valid floats between 0 and 1."""
        stats = api("/system")
        if stats.get("workerCount", 0) == 0:
            pytest.skip("No workers running")

        resp = post("/jobs", {"F": 10, "C": 4})
        job_id = resp.json()["jobId"]

        job = self.wait_for_job(job_id, timeout=90)
        assert job["status"] == "done"

        result_resp = requests.get(f"{API_URL}/jobs/{job_id}/result", timeout=30)
        lines = [l for l in result_resp.text.strip().split("\n") if l.strip()]
        assert len(lines) == 4  # C=4

        for line in lines:
            val = float(line)
            assert 0.0 <= val <= 1.0, f"Value {val} outside [0, 1]"

    def test_concurrent_jobs(self) -> None:
        """Multiple jobs can run simultaneously."""
        stats = api("/system")
        if stats.get("workerCount", 0) == 0:
            pytest.skip("No workers running")

        # Submit 3 small jobs concurrently
        job_ids = []
        for _ in range(3):
            resp = post("/jobs", {"F": 5, "C": 3})
            assert resp.status_code == 202
            job_ids.append(resp.json()["jobId"])

        # Wait for all to complete
        for job_id in job_ids:
            job = self.wait_for_job(job_id, timeout=120)
            assert job["status"] == "done", f"Job {job_id} failed"

    def test_job_with_multiple_batches(self) -> None:
        """F=15 creates 3 batches — tests multi-batch aggregation."""
        stats = api("/system")
        if stats.get("workerCount", 0) == 0:
            pytest.skip("No workers running")

        resp = post("/jobs", {"F": 15, "C": 5})
        assert resp.status_code == 202
        data = resp.json()
        assert data["batchCount"] == 3  # ceil(15/5)
        job_id = data["jobId"]

        job = self.wait_for_job(job_id, timeout=120)
        assert job["status"] == "done"

        # Verify result
        result_resp = requests.get(f"{API_URL}/jobs/{job_id}/result", timeout=30)
        lines = [l for l in result_resp.text.strip().split("\n") if l.strip()]
        assert len(lines) == 5  # C=5


class TestSSEEndpoint:
    """Test the SSE endpoint."""

    def test_events_endpoint_returns_event_stream(self) -> None:
        resp = requests.get(
            f"{API_URL}/events",
            stream=True,
            timeout=5,
            headers={"Accept": "text/event-stream"},
        )
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("content-type", "")
        resp.close()


class TestWorkerEndpoints:
    """Test internal worker endpoints."""

    def test_worker_heartbeat_accepted(self) -> None:
        resp = requests.post(
            f"{API_URL}/internal/worker/heartbeat",
            json={"workerId": "test-worker-integration", "status": "idle"},
            timeout=REQUEST_TIMEOUT,
        )
        assert resp.status_code == 200
        assert resp.json()["ok"] is True

    def test_worker_register_unregister(self) -> None:
        worker_id = "integration-test-worker"

        # Register
        reg_resp = requests.post(
            f"{API_URL}/internal/worker/register",
            json={"workerId": worker_id},
            timeout=REQUEST_TIMEOUT,
        )
        assert reg_resp.status_code == 200

        # Should appear in system stats
        stats = api("/system")
        worker_ids = [w["id"] for w in stats["workers"]]
        assert worker_id in worker_ids

        # Unregister
        unreg_resp = requests.post(
            f"{API_URL}/internal/worker/unregister",
            json={"workerId": worker_id},
            timeout=REQUEST_TIMEOUT,
        )
        assert unreg_resp.status_code == 200
