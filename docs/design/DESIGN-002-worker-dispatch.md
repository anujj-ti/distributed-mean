# DESIGN-002: Worker Dispatch and Work Stealing

## Overview
Describes how tasks are dispatched to workers and how the system ensures minimal idle time across workers of varying processing speeds.

## Components Involved
- Redis (task queue + worker registry)
- Python Workers (consumers)
- API reaper (orphaned task recovery)

## Data Flow

### Work Stealing via Competitive Pop
```
Queue (Redis LIST):
  [task_0] [task_1] [task_2] [task_3] ... [task_N]
     ↑         ↑
  Worker A   Worker B
  (fast)     (slow — still on previous task)
```

All workers issue `BRPOP dmsystem:queue 5` concurrently. Redis serializes BRPOP operations — only one worker gets each task. The fastest worker finishes first and re-issues BRPOP, picking up task_2, task_3, etc. While Worker B is still on task_1, Worker A has already processed task_2, task_3, task_4.

**Result**: Fast workers process more tasks. Slow workers don't block fast workers. No idle time as long as queue is non-empty.

### Worker Registration
```python
# On startup
worker_id = os.environ.get('WORKER_ID', str(uuid.uuid4()))
redis.sadd('dmsystem:workers', worker_id)
redis.setex(f'dmsystem:worker:{worker_id}:hb', 15, '1')
redis.set(f'dmsystem:worker:{worker_id}:status', 'idle')
```

### Heartbeat Loop (runs in background thread)
```python
def heartbeat_loop():
    while not shutdown_event.is_set():
        redis.setex(f'dmsystem:worker:{worker_id}:hb', 15, '1')
        time.sleep(10)
```

### API Reaper (runs every 30s in API process)
```typescript
async function reaperLoop() {
  const workerIds = await redis.smembers('dmsystem:workers');
  for (const wid of workerIds) {
    const hb = await redis.get(`dmsystem:worker:${wid}:hb`);
    if (!hb) {
      // Worker is dead
      const taskId = await redis.get(`dmsystem:worker:${wid}:task`);
      if (taskId) {
        // Re-enqueue orphaned task
        const task = await db.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
        if (task.status === 'running') {
          await db.query("UPDATE tasks SET status='pending' WHERE id=$1", [taskId]);
          await redis.lpush('dmsystem:queue', JSON.stringify(task));
        }
      }
      await redis.srem('dmsystem:workers', wid);
    }
  }
}
```

## Key Contracts

### Worker Status Transitions
```
idle → busy  (after BRPOP returns a task)
busy → idle  (after task stored in DB)
busy → dead  (heartbeat expires → reaper re-enqueues)
```

### Task Status Transitions
```
pending → running  (worker picked up task)
running → done     (partial result stored)
running → pending  (reaper re-enqueued after worker crash)
done    → (terminal)
```
