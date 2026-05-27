# Research: Queue Technology for Distributed Mean

## Question
Which queue technology is best for a distributed job queue that needs to work locally (Docker Compose) and deploy easily to cloud, with TypeScript API and Python workers?

## Options Evaluated

### 1. Redis + BRPOP (Direct Redis Lists)
- Workers use `BRPOP` (blocking pop) — natural work-stealing
- TypeScript: `ioredis`; Python: `redis-py`
- Docker: single `redis` image, no config
- Cloud: Redis Enterprise, Upstash Redis, AWS ElastiCache
- Dead letter: manual (move failed tasks to a DLQ list)
- At-least-once: re-enqueue on worker crash (heartbeat + reaper)

### 2. Redis + BullMQ
- BullMQ is a TypeScript-first job queue on Redis
- Has Python SDK (`bullmq` pip package) but it's young
- Rich features: priority, rate limiting, retries, cron
- Overhead: more Redis keys/structures per job
- Python workers can poll via the SDK but less idiomatic

### 3. PostgreSQL SKIP LOCKED
- Queue stored in PG table; workers SELECT FOR UPDATE SKIP LOCKED
- Eliminates a separate service (just PG, which we need anyway)
- Works locally and in cloud (RDS, Supabase)
- Natural transactional: task dequeued + status updated atomically
- Performance: fine for thousands of tasks/sec; may bottleneck at very high volume
- No blocking pop — must poll with sleep

### 4. RabbitMQ
- AMQP; mature, feature-rich, good for complex routing
- TypeScript: `amqplib`; Python: `pika` or `aio-pika`
- Docker: needs its own image
- Cloud: CloudAMQP, Amazon MQ
- Overkill for this use case; more complex ops

## Decision: **Redis with BRPOP** (direct list, no BullMQ)

### Rationale
1. **Best work-stealing**: BRPOP is blocking, so workers wake immediately when work appears — no polling latency. Fastest workers pop more tasks naturally.
2. **Language parity**: Both `ioredis` (TS) and `redis-py` (Python) are mature, well-documented clients.
3. **Zero config locally**: `redis:7-alpine` in Docker Compose, one line.
4. **Cloud portability**: Any managed Redis works — Upstash, ElastiCache, Redis Enterprise. Just swap the URL.
5. **Simplicity**: No abstraction layer. Easy to reason about, debug with `redis-cli`.
6. **Worker heartbeats**: Redis TTL on heartbeat keys lets us detect crashed workers and re-enqueue orphaned tasks.

### Trade-offs
- Manual dead-letter logic (vs BullMQ built-in)
- No built-in retry scheduling (implement with a delayed requeue)
- Reaper process needed to recover tasks from crashed workers

### Supporting Data Structures
```
dmsystem:queue            → LIST (LPUSH to enqueue, BRPOP to dequeue)
dmsystem:worker:{id}:hb  → STRING (TTL=15s heartbeat)
dmsystem:worker:{id}:task → STRING (current task id)
dmsystem:workers          → SET (all known worker IDs)
dmsystem:dlq             → LIST (failed tasks for inspection)
```
