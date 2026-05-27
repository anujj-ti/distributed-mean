# Distributed Mean - ITDs

| ITD 001 - Queue Technology Selection |  |
| :---- | :---- |
| **THE PROBLEM** | Which queue technology should we use for dispatching sub-tasks to Python workers, such that it works locally via Docker Compose and is easily deployable to a cloud environment, supporting TypeScript API producers and Python worker consumers? |
| **OPTIONS CONSIDERED (Decision in bold)** | **Redis with BRPOP** / BullMQ (Redis-based) / PostgreSQL SKIP LOCKED / RabbitMQ |
| **REASONING** | Redis BRPOP gives us blocking pop semantics — workers block until a task arrives, eliminating polling latency. Natural work-stealing: the fastest worker wins the BRPOP race and gets the next task. Both `ioredis` (TypeScript) and `redis-py` (Python) are mature, production-grade clients. Locally: one `redis:7-alpine` container. Cloud: swap connection string to Upstash, ElastiCache, or Redis Enterprise. BullMQ was considered but its Python SDK is immature. PostgreSQL SKIP LOCKED would eliminate the extra service but lacks push semantics (must poll). RabbitMQ is overkill and adds operational complexity. |
| **TRADEOFFS** | No built-in retry scheduling (implement with reaper pattern). Dead-letter queue must be managed manually. Redis is in-memory, so queue is lost on restart without persistence (AOF enabled in config). |
| **NOTES** | See `docs/research/queue-technology.md` for full comparison. Redis also serves as the worker registry and heartbeat store. |
