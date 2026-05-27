# Distributed Mean - ITDs

| ITD 006 - File Storage Strategy |  |
| :---- | :---- |
| **THE PROBLEM** | Where should generated input files (F files of C values) be stored such that both the API (writer) and workers (readers) can access them, locally and in cloud? |
| **OPTIONS CONSIDERED (Decision in bold)** | **MinIO (S3-compatible object store)** / Shared Docker volume / NFS / Embed in PostgreSQL |
| **REASONING** | MinIO runs as a Docker container locally and exposes an S3-compatible API. Workers use boto3 with `endpoint_url=http://minio:9000` locally and `endpoint_url=https://s3.amazonaws.com` in cloud — same code, different config. Shared Docker volume requires that all containers run on the same Docker host; breaks in Kubernetes or distributed Docker Swarm deployments. NFS is complex to configure. Embedding large binary data in PostgreSQL is an antipattern. |
| **TRADEOFFS** | Extra Docker container. File generation (F=100k) takes measurable time — handled by generating files asynchronously in background after job creation (job status = 'generating' until all files are ready and tasks enqueued). |
| **NOTES** | See `docs/research/file-storage.md`. Format: CSV (one float per line). Files: `jobs/{jobId}/inputs/file_{N:06d}.csv`. Result: `jobs/{jobId}/output/result.csv`. For cloud: set `MINIO_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` env vars. |
