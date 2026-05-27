# Queue Technology Research — Distributed Worker System

## Question
Best queue technology for distributed worker system: Redis BRPOP vs BullMQ vs PostgreSQL SKIP LOCKED vs RabbitMQ.
Need: TypeScript API producer, Python worker consumers, works locally with Docker Compose, cloud-deployable with env var only.
Performance with 100k+ tasks, work-stealing behavior, partial failure recovery.

## Recommendation: Redis BRPOP (raw)

### Winner: Redis BRPOP

**Why Redis BRPOP wins for this use case:**

1. **Work-stealing built-in**: BRPOP is a blocking pop that atomically removes and returns the first available item. Multiple workers compete for items naturally — fastest workers automatically get more work. No coordination needed.

2. **Cross-language simplicity**: Both TypeScript (`ioredis`) and Python (`redis-py`) have excellent Redis clients. The queue protocol is just: `LPUSH queue_key item` (producer) and `BRPOP queue_key timeout` (consumer). No shared library needed.

3. **Docker Compose local, cloud-native remote**: Swap `REDIS_URL=redis://localhost:6379` → `REDIS_URL=redis://user:pass@upstash.io:6379` — zero code change.

4. **Performance**: Redis handles 100k+ tasks trivially. BRPOP is O(1). Under load, Redis processes ~1M operations/second on modest hardware.

5. **Partial failure recovery**: Use reliable queue pattern: worker pops from main queue, adds to a processing set with timestamp. If worker dies without ACK, reaper task re-enqueues items from processing set older than TTL.

### BullMQ Analysis

BullMQ is excellent but **overkill for this use case and has cross-language friction**:
- Python `bullmq` library is maintained but less mature than `redis-py`
- BullMQ adds structured job state, retries, priorities, scheduled jobs, UI — we don't need most of this
- Extra dependency complexity; harder to debug
- **Verdict**: Choose if you need job prioritization, rate limiting, or complex retry logic. Not here.

### PostgreSQL SKIP LOCKED Analysis

`SELECT ... FOR UPDATE SKIP LOCKED` gives you a transactional queue using your existing DB:
- **Pro**: No extra service, ACID guarantees, job state in same transaction as processing
- **Con**: Polling required (no blocking pop — must poll every N ms), higher DB load, harder to achieve true work-stealing (need careful locking), slower than Redis by 10-100x for pure queueing
- **Best for**: Applications where you don't want to add Redis, or where job state and queue are in the same DB transaction
- **Verdict**: Not ideal here since we have Redis anyway and need Python workers to participate

### RabbitMQ Analysis

- Full message broker with routing, exchanges, bindings, AMQP protocol
- Excellent for complex routing (fan-out, topic-based, etc.)
- **Overkill**: We just need FIFO with work-stealing
- Extra operational complexity, different protocol (AMQP vs Redis)
- **Verdict**: Use if you need message routing complexity. Unnecessary here.

## Implementation Pattern

```typescript
// TypeScript producer (ioredis)
import Redis from 'ioredis';
const redis = new Redis(process.env.REDIS_URL!);

async function enqueueTask(task: TaskMessage): Promise<void> {
  await redis.lpush('tasks:pending', JSON.stringify(task));
}
```

```python
# Python consumer (redis-py)
import redis, json, os

r = redis.from_url(os.environ["REDIS_URL"])

def consume_task() -> dict | None:
    result = r.brpop("tasks:pending", timeout=5)
    if result:
        _, data = result
        return json.loads(data)
    return None
```

## Reliable Queue Pattern (Crash Recovery)

```
LPUSH tasks:pending <task_json>          # enqueue
BRPOPLPUSH tasks:pending tasks:processing timeout  # atomic move (worker claims)
# ... do work ...
LREM tasks:processing 1 <task_json>     # ack on success
# On crash: reaper moves old tasks:processing items back to tasks:pending
```

## Cloud Deployment

| Service | Plan | Notes |
|---------|------|-------|
| Upstash Redis | Free tier | `REDIS_URL=rediss://...upstash.io` |
| Redis Cloud | Free tier | Similar env var swap |
| AWS ElastiCache | Paid | VPC-internal, need tunnel |

## Summary

**Use Redis BRPOP for this project:**
- Zero friction between TypeScript and Python consumers
- Natural work-stealing (fastest workers win, no configuration)
- Simple `docker-compose.yml` with official `redis:7-alpine` image
- Single env var `REDIS_URL` for cloud deployment
- 100k+ tasks handled in milliseconds
- Partial failure recovery via BRPOPLPUSH reliable queue pattern
