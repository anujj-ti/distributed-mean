# ADR-003: Worker Language — Python

**Status:** accepted  
**Date:** 2025-05-28

## Context
Workers must poll a queue, pull files from object storage, compute index-wise sums efficiently, and write partial results to PostgreSQL. Language is constrained by the task spec (Python required).

## Decision
Use **Python 3.11+** with:
- `redis` (redis-py) — queue polling via BRPOP
- `boto3` — MinIO/S3 file access
- `psycopg2` — PostgreSQL for partial result writes
- `numpy` — Vectorized array operations (sums across files)
- Type hints throughout (`from __future__ import annotations`)

## Consequences
- **Positive:** NumPy makes vectorized file loading and summing concise and fast. Python is a natural fit for data processing. redis-py is a battle-tested Redis client.
- **Negative:** Python is slower than compiled languages for pure CPU work; mitigated by NumPy's C backend. GIL limits multi-threading (not an issue — we use multi-process via Docker replicas).
- **Risks:** boto3 requires careful endpoint configuration for MinIO vs real S3.

## Alternatives Considered
| Alternative | Why rejected |
|-------------|-------------|
| Go workers | Not required; Python is spec'd |
| Node.js workers | Would share language with API but loses NumPy advantage |
