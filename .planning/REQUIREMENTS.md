# Requirements

## Must Have (MVP)
- REQ-001: POST /jobs accepts {f, c} and returns jobId
- REQ-002: API generates F files of C random floats and stores in MinIO
- REQ-003: Jobs split into ceil(F/5) tasks, enqueued to Redis
- REQ-004: W workers poll Redis (BRPOP work-stealing), process ≤5 files each
- REQ-005: Workers compute partial sums per index (not full means)
- REQ-006: API aggregates partial sums to final mean when all batches complete
- REQ-007: Result stored in MinIO, downloadable via GET /jobs/:id/result
- REQ-008: Multiple concurrent jobs supported simultaneously
- REQ-009: Workers simulate speed differences via WORKER_SLOWNESS env var
- REQ-010: GET /system returns worker status, queue depth, job stats
- REQ-011: GET /events SSE stream for real-time updates
- REQ-012: TypeScript strict mode, zero ESLint warnings
- REQ-013: Python Pydantic v2 models for all data structures
- REQ-014: Ruff + Black enforced at Docker build time
- REQ-015: Jest tests ≥75% API coverage
- REQ-016: pytest tests ≥75% worker coverage
- REQ-017: docker compose up starts full system

## Should Have
- REQ-018: React dashboard with worker fleet visualization
- REQ-019: Real-time charts (queue depth, worker speed)
- REQ-020: Job table with expandable task details
- REQ-021: Job submit form with file size preview
- REQ-022: Live log feed from SSE events
- REQ-023: GitHub Actions CI pipeline
- REQ-024: PATCH /system/workers to change worker count at runtime
- REQ-025: GET /jobs/:id/tasks returns task breakdown with worker assignments

## Nice to Have
- REQ-026: Worker speed sparklines (mini charts per worker)
- REQ-027: Integration test suite in CI
- REQ-028: Pre-commit hooks (Ruff, Black)
- REQ-029: Cloud deploy docs (Supabase/Neon PG, Upstash Redis, S3)
