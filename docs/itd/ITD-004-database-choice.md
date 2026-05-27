# Distributed Mean - ITDs

| ITD 004 - Database Choice |  |
| :---- | :---- |
| **THE PROBLEM** | Which database should store job metadata, task state, and partial results? Requirements: ACID transactions for completion detection, array type for partial sums, Docker-friendly, cloud-portable. |
| **OPTIONS CONSIDERED (Decision in bold)** | **PostgreSQL** / SQLite / MongoDB / Redis only |
| **REASONING** | PostgreSQL supports FLOAT8[] (native float array) for efficient storage of partial_sums vectors, ACID transactions for the atomic completion counter, advisory locks for single-aggregator guarantee, and is universally deployable (Docker locally, RDS/Supabase/Neon in cloud). SQLite lacks concurrent multi-writer support (workers writing in parallel). MongoDB could store arrays natively but lacks ACID transactions across documents without sessions. Redis-only would need Lua scripting for atomics and lacks durable structured queries needed for job history. |
| **TRADEOFFS** | Extra Docker service (postgres container). Schema migrations needed. Float8[] arrays not as space-efficient as binary for very large C (each float stored with PG overhead). |
| **NOTES** | For partial results with C=10k, each FLOAT8[] row is ~80KB. For F=100k/5=20k batches, total storage: ~1.6GB per job — acceptable for a dev/demo system. Production would use binary storage or clear completed partial results after aggregation. |
