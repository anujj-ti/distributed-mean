# Roadmap — v1.0.0

## Phase 1: Infrastructure & Foundations
**Goal:** Working Docker Compose with all services, DB schema, shared types, queue setup
**Branch:** feat/phase-1-infrastructure
**Deliverables:**
- docker-compose.yml with PostgreSQL, Redis, MinIO, API, Workers (healthchecks)
- .env.example with all variables
- DB schema: jobs, tasks, workers tables with proper indexes
- Shared TypeScript types (Job, Task, WorkerInfo, SSEEvent)
- MinIO bucket creation on startup
- Redis connection + queue helpers
- Makefile for local dev commands
**Success:** docker compose up starts all services. API /system returns 200.

## Phase 2: API — Endpoints, Validation, Tests
**Goal:** All API endpoints working, strict TypeScript, Zod validation, Jest tests
**Branch:** feat/phase-2-api
**Depends on:** Phase 1
**Deliverables:**
- POST /jobs (Zod validation, file generation, task enqueue)
- GET /jobs, GET /jobs/:id, GET /jobs/:id/tasks, GET /jobs/:id/result
- GET /system (workers, queue, job stats)
- PATCH /system/workers (runtime worker count change)
- GET /events (SSE stream)
- POST /internal/worker-heartbeat, POST /internal/task-result
- tsconfig strict, ESLint strict-type-checked, zero warnings
- Jest + supertest tests ≥75% coverage
**Success:** All endpoints work. npm run check passes with zero errors.

## Phase 3: Workers — Pydantic, Ruff, Black, Tests
**Goal:** Python workers fully typed, strict quality, tested
**Branch:** feat/phase-3-workers
**Depends on:** Phase 1
**Deliverables:**
- Pydantic v2 TaskMessage, PartialResult, WorkerSettings models
- Strict Ruff config (select broad rules), Black formatting
- pyproject.toml with proper deps and dev extras
- Heartbeat loop with worker registration in API
- Partial sum computation (memory-efficient, numpy)
- pytest tests ≥75% coverage (mock S3 + Redis)
- Dockerfile with build-time ruff + black check
**Success:** ruff check, black --check, pytest all pass. Worker runs and processes tasks.

## Phase 4: Dashboard — React, Recharts, Real-time
**Goal:** Rich real-time dashboard with full system visibility
**Branch:** feat/phase-4-dashboard
**Deliverables:**
- React 18 + TypeScript + Vite + Tailwind + Recharts
- Worker fleet grid (status, speed, current task)
- Queue depth chart (last 2 min, 2s refresh)
- Worker speed chart (multi-line, last 2 min)
- Jobs table (sortable, expandable tasks)
- Job submit form (F, C inputs with size preview)
- Live log feed (SSE, 200-entry limit, level filter)
- System stats cards
- nginx Dockerfile + docker-compose service
- Vitest + React Testing Library tests
**Success:** Dashboard loads, shows live data, submitting a job shows progress in real time.

## Phase 5: CI/CD & Quality Gates
**Goal:** GitHub Actions CI, integration tests, pre-commit hooks, complete README
**Branch:** feat/phase-5-cicd
**Deliverables:**
- .github/workflows/ci.yml (api/workers/ui quality + docker build + integration tests)
- .github/workflows/pr-review.yml (quality checklist: no any, no console.log, no bare noqa)
- tests/integration/ with pytest: job lifecycle, concurrent jobs, worker speed
- .pre-commit-config.yaml
- Complete README (quickstart, API ref, algorithm, cloud deploy)
**Success:** CI pipeline green on a test PR. Integration tests pass against docker compose stack.
