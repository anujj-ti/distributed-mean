# ADR-002: API Framework — Express + TypeScript

**Status:** accepted  
**Date:** 2025-05-28

## Context
The API must handle: job creation (generates files, enqueues tasks), job status queries, system stats, SSE streaming for real-time UI updates, and optional worker scaling. The framework choice is partly constrained by the task spec (Node.js + Express + TypeScript required).

## Decision
Use **Express 4** with **TypeScript** (strict mode), organized as:
```
api/
├── src/
│   ├── routes/        # Express routers (jobs, system, config, events)
│   ├── services/      # Business logic (jobService, queueService, storageService)
│   ├── db/            # PostgreSQL (pg client, migrations, queries)
│   ├── lib/           # Redis client, MinIO client, SSE broadcaster
│   ├── types/         # Shared TypeScript interfaces
│   └── index.ts       # App entry point
├── Dockerfile
├── package.json
└── tsconfig.json
```

Key dependencies:
- `express` — HTTP framework
- `pg` — PostgreSQL client  
- `ioredis` — Redis client (better TypeScript types than `redis`)
- `@aws-sdk/client-s3` — MinIO/S3 file operations
- `zod` — Runtime request validation
- `uuid` — Job/task ID generation

## Consequences
- **Positive:** TypeScript strict mode catches type errors at compile time. Express is well-understood, easy to reason about. Zod provides runtime validation at API boundaries.
- **Negative:** Express lacks built-in request validation (handled by zod). No built-in async error handling (add wrapper utility).
- **Risks:** Express 4 is somewhat dated; Express 5 or Fastify would be faster but adds churn. For this workload, Express 4 throughput is more than sufficient.

## Alternatives Considered
| Alternative | Why rejected |
|-------------|-------------|
| Fastify | Faster but less familiar; marginally relevant for this workload |
| NestJS | Heavy framework; overkill for a focused microservice |
| Hono | Very new; less community tooling |
