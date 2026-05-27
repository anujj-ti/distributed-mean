# Distributed Mean - ITDs

| ITD 003 - Result Aggregation Strategy |  |
| :---- | :---- |
| **THE PROBLEM** | How should partial results from workers be combined into a final index-wise mean, without loading all F×C values into memory at once? |
| **OPTIONS CONSIDERED (Decision in bold)** | **Partial sum accumulation with streaming DB reads** / Incremental mean (Welford) / Map-reduce tree / All-at-once in memory |
| **REASONING** | Each worker computes `partial_sums[i]` (sum of value[i] across its batch) and `count` (number of files). Aggregation streams all partial results from PostgreSQL one row at a time and accumulates totals: `total_sums[i] += partial_sums[i]`. Final mean = `total_sums[i] / F`. Memory cost: O(C) for accumulators, regardless of F or batch count. Welford's algorithm applies to single-value streams; less natural for batch partial sums. Tree reduce would minimize precision loss but adds coordination complexity that's unnecessary at double precision. All-at-once is infeasible for F=100k, C=10k (requires 8GB RAM). |
| **TRADEOFFS** | Slight floating-point accumulation error (O(ε × batches) where ε ≈ 2.2e-16 for float64; at 20k batches error ≈ 4e-12 — negligible). Aggregation is a sequential step after all batches complete (cannot be fully parallelized without tree reduce). |
| **NOTES** | See `docs/research/aggregation-algorithm.md`. Uses numpy for vectorized accumulation. PostgreSQL stores sums as `FLOAT8[]` array. Completion detection uses atomic counter (`UPDATE jobs SET completed_batches = completed_batches + 1 RETURNING completed_batches, batch_count`) with advisory lock to ensure single aggregation. |
