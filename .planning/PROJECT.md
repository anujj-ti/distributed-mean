# Distributed Mean — PROJECT.md

## What We're Building
A distributed computation system that computes the index-wise mean across F files of C random numbers each. Workers poll a Redis queue, process batches of ≤5 files, and report partial sums. The API aggregates results and serves them. A real-time React dashboard shows the full system state.

## Stack
- **API**: Node.js 20 + Express + TypeScript (strict mode)
- **Workers**: Python 3.11 + Pydantic v2 + Ruff + Black
- **Queue**: Redis BRPOP (work-stealing — fastest workers win)
- **DB**: PostgreSQL (job state, task tracking, worker registry, partial sum aggregation)
- **Storage**: MinIO (S3-compatible — same code works on AWS S3 via env var)
- **Dashboard**: React 18 + TypeScript + Vite + Recharts + Tailwind CSS
- **Deploy**: Docker Compose locally, cloud-ready via env var substitution

## Core Algorithm
1. User submits job: F files, C values each
2. API generates F random CSV files, uploads to MinIO
3. API splits into ceil(F/5) tasks (max 5 files per worker per task)
4. Tasks enqueued to Redis — workers BRPOP (work-stealing)
5. Each worker: read ≤5 files from MinIO, compute partial sums per index, POST to API
6. API: accumulate partial sums in PostgreSQL with atomic counter
7. When all batches done (atomic check), aggregate: mean[i] = total_sum[i] / F
8. Write result CSV to MinIO, mark job done, broadcast via SSE

## Code Quality Requirements
- TypeScript: strict, noImplicitAny, noUncheckedIndexedAccess, exactOptionalPropertyTypes
- ESLint: @typescript-eslint/strict-type-checked, zero warnings
- Python: Pydantic v2 strict, Ruff with select=ALL minus exceptions, Black, mypy strict
- Tests: Jest (API ≥75% coverage), pytest (workers ≥75% coverage), Vitest (UI)
- CI: GitHub Actions on every PR — lint + test + docker build + integration tests

## Success Criteria
- `docker compose up --build` → everything starts, no errors
- POST /jobs with F=20, C=100 → job completes, result downloadable
- Dashboard at http://localhost:3001 shows workers, queue, live logs in real time
- All tests pass in CI
- TypeScript strict: zero errors. Ruff: zero violations. ESLint: zero warnings.
