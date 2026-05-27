# Distributed Mean

A distributed computation system that computes the **index-wise mean** across F files of C random numbers each.

Workers poll a Redis queue, process batches of ≤5 files, and report partial sums. The API aggregates results and serves them. A real-time dashboard shows the full system state.

## Quick Start

```bash
# Clone
git clone https://github.com/anujj-ti/distributed-mean.git
cd distributed-mean

# Configure (defaults work out of the box)
cp .env.example .env

# Start everything
docker compose up --build -d

# Scale workers (optional)
docker compose up --scale worker=8 -d

# Submit a job
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{"F": 20, "C": 100}'

# Watch dashboard
open http://localhost:3000
```

## Architecture

```
┌──────────────┐     ┌─────────────┐     ┌───────────────┐
│   Browser    │────▶│  Express API│────▶│  PostgreSQL   │
│  (Dashboard) │◀────│  (Port 3000)│     │  (jobs/tasks) │
└──────────────┘ SSE └─────────────┘     └───────────────┘
                            │                      ▲
                            │                      │
                     ┌──────▼──────┐      ┌────────┴──────┐
                     │    Redis    │◀─────│ Python Workers│
                     │   (Queue)   │      │  (W replicas) │
                     └─────────────┘      └───────────────┘
                                                   │
                                          ┌────────▼──────┐
                                          │     MinIO     │
                                          │ (S3-compat.)  │
                                          └───────────────┘
```

## Algorithm

### Work Distribution

1. User submits job: `POST /jobs` with `{F, C}`
2. API generates F random CSV files (C values each, uniform [0,1)) → uploads to MinIO
3. API splits into `ceil(F/5)` tasks (max 5 files per worker per task)
4. All tasks enqueued to Redis at once

### Work Stealing

Workers use `BRPOP` — they block waiting for work. When a task arrives, the fastest available worker gets it. No coordination needed. Slower workers automatically get fewer tasks.

### Aggregation (Partial Sums)

Each worker computes **partial sums** (not partial means) per index:
```
worker: partial_sum[j] = sum(file[j] for each file in batch)
```

The API accumulates with a PostgreSQL atomic update:
```sql
UPDATE jobs SET completed_batches = completed_batches + 1
WHERE id = $job_id
RETURNING completed_batches, batch_count
```

When `completed_batches == batch_count`, one thread computes the final mean:
```
final_mean[j] = total_sum[j] / F
```

This is numerically stable for F ≤ 100k (float64 precision ~1e-11 relative error).

### Crash Recovery

- Workers send heartbeats every 10s
- A reaper service runs every 30s, detects dead workers (no heartbeat), re-enqueues their tasks

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/jobs` | Create job `{F, C}` → `{jobId, batchCount, ...}` |
| `GET` | `/jobs` | List all jobs |
| `GET` | `/jobs/:id` | Job status + progress |
| `GET` | `/jobs/:id/tasks` | Task breakdown with worker assignments |
| `GET` | `/jobs/:id/result` | Download result CSV (when done) |
| `GET` | `/system` | Workers, queue depth, job stats |
| `PATCH` | `/system/workers` | Set target worker count `{count: N}` |
| `GET` | `/events` | SSE stream for real-time updates |

## Stack

| Component | Technology |
|-----------|-----------|
| API | Node.js 20, Express 4, TypeScript 5 (strict) |
| Workers | Python 3.11, Pydantic v2, numpy |
| Queue | Redis 7 (BRPOP work-stealing) |
| Database | PostgreSQL 16 |
| Storage | MinIO (S3-compatible) |
| Dashboard | Vanilla JS + Chart.js 4 |
| Quality | ESLint strict-type-checked, Ruff, Black |
| Tests | Jest (≥75%), pytest (≥75%) |
| CI | GitHub Actions |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `DATABASE_URL` | `postgresql://dm:dm@localhost:5432/dm` | PostgreSQL |
| `MINIO_ENDPOINT` | `http://localhost:9000` | MinIO/S3 endpoint |
| `MINIO_BUCKET` | `distributed-mean` | Storage bucket |
| `AWS_ACCESS_KEY_ID` | `minioadmin` | S3 key |
| `AWS_SECRET_ACCESS_KEY` | `minioadmin` | S3 secret |
| `WORKER_SLOWNESS` | `0` | Sleep multiplier per file (0=off) |
| `WORKER_COUNT` | `4` | Number of worker replicas |

## Development

```bash
# Run API in dev mode (hot reload)
cd api && npm install && npm run dev

# Run workers locally
cd workers && pip install -r requirements.txt
REDIS_URL=redis://localhost:6379 API_URL=http://localhost:3000 python worker.py

# Run API tests
cd api && npm test

# Run worker tests
cd workers && python -m pytest tests/ -v

# Type check
cd api && npm run typecheck

# Lint
cd api && npm run lint
cd workers && ruff check . && black --check .
```

## Cloud Deployment

This system is designed for easy cloud migration via environment variable substitution:

| Service | Cloud replacement | Env var |
|---------|------------------|---------|
| PostgreSQL | Supabase, Neon | `DATABASE_URL` |
| Redis | Upstash Redis | `REDIS_URL` |
| MinIO | AWS S3 | `MINIO_ENDPOINT`, `AWS_*` |

No code changes needed — just update `.env`.

## Quality Gates

| Check | Standard |
|-------|---------|
| TypeScript | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| ESLint | `@typescript-eslint/strict-type-checked`, `--max-warnings 0` |
| Python | Pydantic v2 strict mode |
| Ruff | `E,W,F,I,N,UP,B,C4,SIM,PTH,RUF` |
| Black | line-length=100 |
| Jest coverage | ≥75% statements, branches, functions, lines |
| pytest coverage | ≥75% |
| Docker build | Ruff + Black quality gates in worker Dockerfile |
