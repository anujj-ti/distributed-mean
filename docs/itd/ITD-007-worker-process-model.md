# Distributed Mean - ITDs

| ITD 007 - Worker Process Model |  |
| :---- | :---- |
| **THE PROBLEM** | How should each Python worker process be structured — single-threaded loop, multi-threaded, or process pool — to maximize throughput while keeping the implementation simple? |
| **OPTIONS CONSIDERED (Decision in bold)** | **Single-threaded event loop (one process per worker container)** / Thread pool per worker / asyncio with concurrent tasks |
| **REASONING** | Each worker container runs one Python process with a synchronous loop: BRPOP → download files → compute → store → repeat. Since the bottleneck is I/O (MinIO download) and CPU (numpy compute), a single-threaded worker is clean and predictable. Multiple workers are achieved by scaling Docker Compose replicas (`--scale worker=N`), not by threading within one process. This keeps worker code simple — no thread safety concerns. Threading within one worker would complicate error handling and partial result writes. |
| **TRADEOFFS** | Each worker handles one batch at a time (no pipelining within one worker). Throughput scales by adding more workers, not by threading. Context switching between tasks is at the Docker container level. |
| **NOTES** | W (number of workers) is configurable via `WORKER_COUNT` in `.env` and `docker-compose.yml` replicas. The `PATCH /config` endpoint scales workers at runtime using Docker SDK or scaling hint. Each worker container has a unique ID (`WORKER_ID` env var or generated UUID). |
