# Distributed Mean - ITDs

| ITD 002 - Work Distribution Algorithm |  |
| :---- | :---- |
| **THE PROBLEM** | Given F files (up to 100k) and W workers (each handling max 5 files at a time), how should work be distributed such that workers spend minimal time idle, especially given that workers process at different speeds? |
| **OPTIONS CONSIDERED (Decision in bold)** | **Central queue + competitive BRPOP (work stealing via queue)** / Static pre-assignment / Dynamic round-robin with load tracking |
| **REASONING** | Central queue with competitive BRPOP is the simplest form of work stealing: tasks are in a shared Redis list, workers compete via BRPOP, fastest workers naturally pick up more tasks. No coordination logic needed — it emerges from the queue. Static pre-assignment (divide F/W tasks per worker) would leave fast workers idle while slow workers still process. Dynamic round-robin with load tracking adds complexity for marginal gain. The competitive pop approach maximizes CPU utilization across workers of any speed. |
| **TRADEOFFS** | Queue contention at very high worker counts (mitigated by BRPOP's O(1) behavior). No task affinity — workers always start fresh with each batch (acceptable since files are in MinIO). |
| **NOTES** | See `docs/research/worker-orchestration.md`. Batch size is fixed at 5 files (max per worker). Number of batches = ceil(F/5). For F=100k: 20,000 batches. With W=4 workers: roughly 5,000 batches per worker if all equal speed. |
