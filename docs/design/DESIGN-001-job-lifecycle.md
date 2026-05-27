# DESIGN-001: End-to-End Job Lifecycle

## Overview
This document describes the complete flow from job creation through worker processing to final result delivery. It covers the data flow, component interactions, and state transitions for a single job.

## Components Involved
- **Client** — Browser UI or API consumer
- **API** (Node.js/Express/TypeScript) — Job management, file generation, task enqueueing
- **PostgreSQL** — Persistent store for jobs, tasks, partial results
- **Redis** — Task queue (LIST), worker registry (SET + STRING keys)
- **MinIO** — Object storage for input files and output result
- **Worker** (Python) — Task processing (file download, computation, partial result storage)

## Data Flow

### Phase 1: Job Creation

```mermaid
sequenceDiagram
    Client->>API: POST /jobs {F: 1000, C: 100}
    API->>PostgreSQL: INSERT job (status=generating, batch_count=200)
    API-->>Client: 202 Accepted {jobId, batchCount: 200, status: "generating"}
    API->>API: spawn background generation task
    loop For each file 0..999 (streamed)
        API->>MinIO: PutObject jobs/{jobId}/inputs/file_{i:06d}.csv
    end
    loop For each batch 0..199 (ceil(1000/5))
        API->>PostgreSQL: INSERT task (jobId, batchIndex, fileStart, fileEnd, status=pending)
        API->>Redis: LPUSH dmsystem:queue <task-payload-json>
    end
    API->>PostgreSQL: UPDATE job SET status=queued
    API->>SSE: broadcast {type: job_update, jobId, status: queued}
```

### Phase 2: Worker Processing

```mermaid
sequenceDiagram
    Worker->>Redis: BRPOP dmsystem:queue 5
    Redis-->>Worker: task payload {taskId, jobId, batchIndex, fileStart, fileEnd, C}
    Worker->>Redis: SET dmsystem:worker:{id}:task taskId
    Worker->>Redis: SET dmsystem:worker:{id}:status busy
    Worker->>PostgreSQL: UPDATE task SET status=running, worker_id=..., started_at=NOW()
    Worker->>SSE(via API): POST /internal/events {type: worker_update}
    loop For each file in batch (fileStart..fileEnd)
        Worker->>MinIO: GetObject jobs/{jobId}/inputs/file_{i:06d}.csv
        Worker->>Worker: parse CSV → float array[C]
    end
    Worker->>Worker: numpy.stack(arrays) → sum along axis 0 → partial_sums[C]
    Worker->>PostgreSQL: INSERT partial_results (jobId, taskId, sums[C], count)
    Worker->>PostgreSQL: UPDATE task SET status=done, completed_at=NOW()
    Worker->>PostgreSQL: UPDATE jobs SET completed_batches=completed_batches+1\n         RETURNING completed_batches, batch_count
    Worker->>Redis: DEL dmsystem:worker:{id}:task
    Worker->>Redis: SET dmsystem:worker:{id}:status idle
```

### Phase 3: Completion Detection & Aggregation

```mermaid
sequenceDiagram
    Worker->>Worker: check if completed_batches == batch_count
    alt All batches done
        Worker->>PostgreSQL: SELECT pg_try_advisory_xact_lock(jobId_hash)
        alt Lock acquired (first worker to complete)
            Worker->>PostgreSQL: UPDATE job SET status=aggregating
            loop Stream partial results
                Worker->>PostgreSQL: SELECT sums, count FROM partial_results WHERE job_id=?
                Worker->>Worker: total_sums[i] += partial_sums[i]
            end
            Worker->>Worker: final_mean[i] = total_sums[i] / F
            Worker->>MinIO: PutObject jobs/{jobId}/output/result.csv
            Worker->>PostgreSQL: UPDATE job SET status=done, result_path=...
            Worker->>API: POST /internal/job-complete {jobId}
            API->>SSE: broadcast {type: job_update, jobId, status: done}
        else Lock not acquired (another worker is aggregating)
            Worker->>Worker: skip (already being aggregated)
        end
    else More batches pending
        Worker->>Worker: return to queue (BRPOP again)
    end
```

### Phase 4: Result Retrieval

```mermaid
sequenceDiagram
    Client->>API: GET /jobs/{jobId}
    API->>PostgreSQL: SELECT * FROM jobs WHERE id = ?
    API-->>Client: {jobId, status: "done", batchCount, completedBatches, resultPath, createdAt, completedAt}
    Client->>API: GET /jobs/{jobId}/result
    API->>MinIO: GetObject jobs/{jobId}/output/result.csv
    API-->>Client: CSV stream of C float values
```

## Key Contracts

### Task Queue Message Schema
```typescript
interface TaskMessage {
  taskId: string;        // UUID
  jobId: string;         // UUID
  batchIndex: number;    // 0-based batch number
  fileStart: number;     // first file index (inclusive)
  fileEnd: number;       // last file index (inclusive)
  c: number;             // number of values per file
}
```

### Partial Result Schema (PostgreSQL)
```sql
partial_results(
  id        UUID PRIMARY KEY,
  job_id    UUID REFERENCES jobs(id),
  task_id   UUID REFERENCES tasks(id),
  sums      FLOAT8[],   -- length C, partial sums for each index
  count     INTEGER,    -- number of files in this batch
  created_at TIMESTAMPTZ
)
```

### Worker Redis Keys
```
dmsystem:queue              LIST  — task payloads (FIFO, BRPOP)
dmsystem:dlq                LIST  — dead-letter tasks
dmsystem:workers            SET   — active worker IDs
dmsystem:worker:{id}:status STRING — "idle" | "busy"
dmsystem:worker:{id}:hb     STRING — heartbeat (TTL=15s)
dmsystem:worker:{id}:task   STRING — current task ID (if busy)
```

## State Machine: Job

```
GENERATING → QUEUED → RUNNING → AGGREGATING → DONE
                               ↘             ↗
                                   FAILED
```

- `GENERATING`: API is creating files in MinIO
- `QUEUED`: All files created, all tasks in Redis queue
- `RUNNING`: At least one task is in-progress (workers processing)
- `AGGREGATING`: All batches complete, combining partial results
- `DONE`: result.csv written, job complete
- `FAILED`: Unrecoverable error in any stage

## Open Questions
| Question | Owner | Notes |
|----------|-------|-------|
| File generation timeout for F=100k | API team | Async background; job status shows 'generating' |
| Partial result cleanup after job done | Ops | Keep for audit? Or delete to save space? |
| Worker scale-down: graceful drain | Infra | Worker checks shutdown signal after each task |
