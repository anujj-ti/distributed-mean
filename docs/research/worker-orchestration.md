# Research: Worker Orchestration Strategy

## Question
Task-stealing vs pre-assignment, handling different worker speeds, detecting job completion across distributed workers.

## Strategies Compared

### Pre-assignment
Each worker is given a fixed set of tasks upfront. Simple but:
- Slow workers become bottlenecks (others sit idle)
- No rebalancing when workers fail
- Requires knowing worker count and speed upfront

### Work Stealing
Workers maintain local queues; idle workers steal from busy workers' queues.
- Complex to implement distributed
- Good for CPU-bound compute with shared memory
- Overkill when we have a central queue

### Central Queue with Competitive Pop (chosen)
All tasks go to a shared Redis list. Workers compete via `BRPOP`:
- Fastest workers pop more tasks (natural load balancing)
- No rebalancing logic needed — emergent from competition
- Worker failure: reaper re-enqueues tasks with expired heartbeats
- Scales linearly: add more workers = more throughput

## Chosen Architecture: Central Queue + BRPOP

### Worker Lifecycle
```
start →
  register in Redis (add to workers:set, set heartbeat TTL)
  loop:
    set status=idle
    BRPOP dmsystem:queue TIMEOUT=5s
    if timeout: refresh heartbeat, check shutdown signal, loop
    if task:
      set status=busy, set current_task
      process task (pull files, compute, store result)
      mark task done in DB
      trigger completion check
      remove current_task
  unregister from Redis
```

### Heartbeat & Recovery
- Worker updates `dmsystem:worker:{id}:hb` key every 10s (TTL=15s)
- Reaper task (in API) runs every 30s:
  ```
  for each worker_id in dmsystem:workers:
    if dmsystem:worker:{id}:hb expired:
      task_id = dmsystem:worker:{id}:task
      if task_id:
        re-enqueue task_id (LPUSH back to queue)
        reset task status to 'pending'
      remove worker from dmsystem:workers set
  ```

### Handling Different Worker Speeds
- Fast worker: completes task, immediately BRPOP → gets next task
- Slow worker: still processing while fast worker takes next 3 tasks
- Queue depth acts as natural buffer
- No starvation: every worker eventually gets tasks as long as queue non-empty
- At-most-once in-flight per worker (worker processes one batch at a time)

## Job Completion Detection

### Challenge
With W workers and J concurrent jobs, we need to know when ALL batches of a specific job are done, across workers that may finish in any order.

### Solution: Atomic Counter in PostgreSQL
```sql
-- When a worker finishes a batch:
UPDATE jobs
SET completed_batches = completed_batches + 1,
    updated_at = NOW()
WHERE id = $job_id
RETURNING completed_batches, batch_count;

-- If completed_batches == batch_count:
--   Use advisory lock to serialize aggregation
SELECT pg_try_advisory_xact_lock(hashtext($job_id));
-- If lock acquired: run aggregation, mark job done
-- If not: another worker is already aggregating
```

### Why Not Event-Based?
- Could use Redis pub/sub to broadcast "task done" events
- But the aggregation step needs all partials in DB anyway
- Atomic counter in PG is simpler and correct under concurrent workers

## Concurrent Jobs
- Queue is FIFO but multiple jobs' tasks are interleaved
- Workers don't know or care which job a task belongs to
- Each task is self-contained: `{taskId, jobId, batchIndex, fileStart, fileEnd, C}`
- Multiple jobs in flight naturally multiplex across workers
- Fairness: round-robin enqueuing (all job 1 batches, then job 2) vs interleaved
  - Interleaved is better for completion time of concurrent jobs
  - Implementation: jobs enqueue their tasks as they're created
