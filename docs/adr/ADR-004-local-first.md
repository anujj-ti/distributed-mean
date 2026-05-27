# ADR-004: Local-First — No Hard Cloud Dependencies

**Status:** accepted  
**Date:** 2025-05-28

## Context
The system must run fully locally via `docker compose up` with no internet access, no cloud accounts, and no API keys configured. At the same time, it must be easily deployable to a cloud environment by changing environment variables.

## Decision
All external services have local equivalents that run in Docker Compose:
- **Redis** → `redis:7-alpine` container (same API as Redis Enterprise/Upstash/ElastiCache)
- **PostgreSQL** → `postgres:16-alpine` container (same API as RDS/Supabase/Neon)
- **MinIO** → `minio/minio` container (S3-compatible API; same boto3 code points to AWS S3 in prod)

Cloud deployment only requires changing env vars (no code changes):
```env
# local (docker-compose.yml bakes these in)
REDIS_URL=redis://redis:6379
DATABASE_URL=postgresql://dm:dm@postgres:5432/dm
MINIO_ENDPOINT=http://minio:9000

# cloud (docker-compose.prod.yml or environment injection)
REDIS_URL=rediss://user:pass@my-redis.cloud:6380
DATABASE_URL=postgresql://user:pass@my-db.cloud:5432/dm
MINIO_ENDPOINT=https://s3.amazonaws.com
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

## Consequences
- **Positive:** Zero friction for local development. No cloud accounts required to evaluate the system. Easy to test with `docker compose up`.
- **Negative:** MinIO adds ~200MB to Docker images pulled. Initial `docker compose up` downloads ~500MB total.
- **Risks:** MinIO version drift from S3 API (use `path_style_endpoint=True` in boto3 for MinIO compatibility — not needed for real S3).

## Alternatives Considered
| Alternative | Why rejected |
|-------------|-------------|
| Use real S3/Redis/RDS directly | Requires cloud account; breaks offline development |
| SQLite instead of PostgreSQL | No FLOAT8[], no advisory locks, no concurrent writers |
| In-process queue (array) | Not distributable; workers in separate containers can't share memory |
