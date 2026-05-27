# Distributed Mean

A distributed system for computing the **index-wise mean** across F files of C random numbers, using a fleet of W Python workers coordinated through Redis and a Node.js/TypeScript API.

## Architecture

```
Client (UI / REST)
       │ HTTP
  ┌────▼────────────────────────────┐
  │  API (Node.js/Express/TS)       │  ←─── POST /jobs, GET /jobs/:id
  │  • File generation (MinIO)      │       GET /system, SSE /events
  │  • Task enqueueing (Redis)      │
  │  • Aggregation (PostgreSQL)     │
  └──────┬──────────────────────────┘
         │                    │
    ┌────▼────┐          ┌────▼─────┐
    │  Redis  │          │  MinIO   │
    │ (Queue) │          │ (Files)  │
    └────┬────┘          └────┬─────┘
         │                    │
┌────────▼────────────────────▼──────────────────────┐
│  Python Workers × W (competitive BRPOP work-steal) │
│  • Pull files from MinIO                            │
│  • Compute partial sums (numpy)                     │
│  • Report to API → stored in PostgreSQL             │
└────────────────────────┬───────────────────────────┘
                         │
                  ┌──────▼──────┐
                  │ PostgreSQL  │
                  │ jobs/tasks/ │
                  │ partials    │
                  └─────────────┘
```

### Key Design Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Queue | Redis + BRPOP | Blocking pop = natural work stealing; fastest workers get more tasks |
| DB | PostgreSQL | FLOAT8[] for partial sums, advisory locks for safe aggregation |
| File Storage | MinIO (S3-compat) | Same boto3 code works locally and on AWS S3 |
| UI Transport | SSE | Unidirectional push fits dashboard pattern; native browser `EventSource` |
| Aggregation | Streaming partial sums | O(C) memory, no loading all F×C values at once |
| Worker Model | Single-threaded per container | Scale by replicas, not threads; simple and predictable |

See `docs/` for full ITDs, ADRs, and design documents.

## Run Locally in 3 Commands

```bash
git clone https://github.com/echosysbot/distributed-mean.git && cd distributed-mean
cp .env.example .env
docker compose up --build
```

Then open **http://localhost:3000** for the live dashboard.

**MinIO console:** http://localhost:9001 (user: `minioadmin`, pass: `minioadmin`)

### Scale Workers

```bash
docker compose up --scale worker=8
```

### Test End-to-End

```bash
# Create a job (F=20 files, C=5 values each)
curl -s -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{"F": 20, "C": 5}' | jq

# Poll until done
curl -s http://localhost:3000/jobs/<jobId> | jq .status

# Download result
curl -s http://localhost:3000/jobs/<jobId>/result
```

## Deploy to Cloud

```bash
# Set your cloud service URLs
export REDIS_URL=rediss://user:pass@my-redis.cloud:6380
export DATABASE_URL=postgresql://user:pass@my-pg.cloud:5432/dm
export MINIO_ENDPOINT=https://s3.amazonaws.com
export MINIO_BUCKET=my-distributed-mean-bucket
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...

docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build
```

No code changes required — only environment variables differ.

## API Reference

### `POST /jobs`
Create a new job.
```json
// Request
{ "F": 1000, "C": 100 }

// Response 202
{
  "jobId": "uuid",
  "f": 1000, "c": 100,
  "status": "generating",
  "batchCount": 200,
  "createdAt": "2025-05-28T..."
}
```

### `GET /jobs/:id`
Get job status and metadata.
```json
{
  "id": "uuid",
  "status": "done",  // generating | queued | running | aggregating | done | failed
  "batchCount": 200,
  "completedBatches": 200,
  "resultPath": "jobs/uuid/output/result.csv",
  ...
}
```

### `GET /jobs/:id/result`
Download the result CSV (C float values, one per line).

### `GET /jobs`
List all jobs (most recent first, max 100).

### `GET /system`
System stats: workers, queue depth, job counts.

### `GET /events`
SSE stream for real-time dashboard updates.

## Job Lifecycle

```
GENERATING → QUEUED → RUNNING → AGGREGATING → DONE
```

1. **GENERATING**: API creates F files in MinIO
2. **QUEUED**: Tasks enqueued in Redis (ceil(F/5) tasks per job)
3. **RUNNING**: Workers processing batches, writing partial sums to DB
4. **AGGREGATING**: All batches done; streaming partial sums → compute final mean
5. **DONE**: Result CSV written to MinIO

## Aggregation Algorithm

Workers compute `partial_sums[i]` per batch. Final aggregation streams all partial results from PostgreSQL and accumulates:

```
total_sums[i] = Σ partial_sums[i]  for all batches
final_mean[i] = total_sums[i] / F
```

Memory: O(C), regardless of F. For F=100k, C=10k: ~1.6GB of partials in DB, ~80KB accumulator in memory.

## Structure

```
distributed-mean/
├── api/              # Node.js + Express + TypeScript
│   ├── src/
│   │   ├── routes/   # jobs.ts, system.ts, internal.ts
│   │   ├── services/ # jobService, systemService, reaperService
│   │   ├── db/       # PostgreSQL schema + queries
│   │   ├── lib/      # redis, storage, sse
│   │   └── types/    # TypeScript interfaces
│   └── Dockerfile
├── workers/          # Python workers
│   ├── worker.py     # Main worker loop
│   └── Dockerfile
├── ui/               # Dashboard (static HTML + vanilla JS)
│   └── index.html
├── shared/           # Shared constants
├── docs/
│   ├── research/     # Sherlock research reports
│   ├── itd/          # Intent-to-Develop decisions
│   ├── adr/          # Architecture Decision Records
│   └── design/       # System design documents
├── docker-compose.yml
├── docker-compose.prod.yml
└── .env.example
```

## Future Work / Bonus

- [ ] `PATCH /config` — change W at runtime via Docker API scaling
- [ ] Retry logic for failed tasks (currently re-queued by reaper after worker crash)
- [ ] Result cleanup (delete partial_results rows after aggregation to save DB space)
- [ ] gRPC or msgpack for more efficient worker ↔ API communication
- [ ] Kubernetes manifests (Deployment + HPA for workers)
- [ ] Metrics (Prometheus + Grafana)
- [ ] Task priority (process smaller jobs first when queue is deep)
