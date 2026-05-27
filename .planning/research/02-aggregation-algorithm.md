# Aggregation Algorithm Research — Distributed Mean Computation

## Question
Memory-efficient distributed mean computation: aggregating partial sums across 100k files without loading all data.
PostgreSQL atomic counters for job completion detection. Numerical stability of incremental mean vs sum+divide.
Best approach for streaming aggregation of distributed worker results.

## Algorithm Design

### Core Mathematical Identity

For F files each with C values:
- Each file i has values: `[x_{i,0}, x_{i,1}, ..., x_{i,C-1}]`
- Final mean at index j: `mean[j] = (1/F) * sum_{i=0}^{F-1} x_{i,j}`

**Key insight**: Mean = TotalSum / F

This is perfectly parallelizable:
- Worker processes files `{i1, i2, ..., i5}` (up to 5)
- Worker computes partial sum per index: `partial_sum[j] = sum_{i in batch} x_{i,j}`
- API accumulates: `total_sum[j] += partial_sum[j]` (atomic)
- When all batches done: `final[j] = total_sum[j] / F`

### Why Partial Sums, Not Partial Means

Partial means would require weighted aggregation:
```
# WRONG approach - extra complexity:
partial_mean[j] = sum(batch_files_at_j) / len(batch)
# Combining partial means requires knowing batch sizes:
final[j] = sum(partial_mean[j] * batch_size) / F  # fragile!

# CORRECT approach:
partial_sum[j] = sum(batch_files_at_j)
final[j] = total_sum[j] / F  # clean, no extra metadata
```

Partial sums are simpler, cleaner, and correct.

### Numerical Stability

**Float64 is sufficient for this use case** (random values in [0,1], up to 100k files):
- Max accumulated sum per index: `100_000 * 1.0 = 100_000.0`
- Float64 has ~15 decimal digits of precision
- Relative error: ~1e-11 for this magnitude — negligible

**Kahan summation**: Not needed for this scale, but would be for F > 1e12 or very high precision requirements.

```python
import numpy as np

# Simple float64 accumulation - sufficient for F <= 100k
partial_sum = np.zeros(C, dtype=np.float64)
for file_key in batch_file_keys:
    data = read_file_from_minio(file_key)  # shape: (C,)
    partial_sum += data
```

### Memory-Efficient Worker Design

For C up to 10,000 values and up to 5 files per batch:
- Memory per worker = 5 * C * 8 bytes (float64) = 5 * 10,000 * 8 = 400KB
- Entirely in memory, no temp files needed
- numpy vectorized addition: microseconds per file

For much larger C (not required here but good design):
```python
# Streaming approach for huge C:
chunk_size = 1000
partial_sums = np.zeros(C, dtype=np.float64)
for file_key in batch_file_keys:
    with minio_client.get_object(bucket, file_key) as stream:
        for chunk in pd.read_csv(stream, chunksize=chunk_size):
            idx = chunk.index
            partial_sums[idx] += chunk.values.flatten()
```

### PostgreSQL Atomic Accumulation

Use a dedicated `job_partial_sums` table with PostgreSQL arrays:

```sql
CREATE TABLE job_partial_sums (
    job_id      UUID PRIMARY KEY REFERENCES jobs(id),
    sums        DOUBLE PRECISION[],   -- length = C
    batch_count INTEGER DEFAULT 0,    -- completed batch counter
    total_batches INTEGER NOT NULL    -- total batches for this job
);

-- Atomic update (called from API when worker POSTs result):
UPDATE job_partial_sums
SET
    sums = (
        SELECT ARRAY(
            SELECT sums[i] + $partial_sums[i]
            FROM generate_subscripts(sums, 1) AS i
        )
    ),
    batch_count = batch_count + 1
WHERE job_id = $job_id
RETURNING batch_count, total_batches;
```

**Job completion detection**: When `batch_count = total_batches` after the atomic UPDATE, that worker is responsible for computing the final mean and writing the result. No polling loop needed.

### Alternative: Redis for Partial Sum Accumulation

For high concurrency (many jobs simultaneously), Redis HINCRBYFLOAT can accumulate partial sums:
```
HINCRBYFLOAT job:{id}:sums idx:0 {partial_sum[0]}
HINCRBYFLOAT job:{id}:sums idx:1 {partial_sum[1]}
...
```
**Pros**: Atomic, fast, no DB contention
**Cons**: For C=10,000, that's 10,000 Redis operations per batch — expensive. Array approach in PostgreSQL is cleaner.

**Recommendation**: Use PostgreSQL array approach — single atomic UPDATE, job state and sums in same DB.

### Alternative for Large C: Binary Format

Instead of PostgreSQL arrays (max ~1MB), for C > 100,000:
```
Store partial sums as binary blob in MinIO
Use API to serialize: np.ndarray.tobytes()
Accumulate with file locking or Redis atomic patterns
```
For our scale (C ≤ 10,000), PostgreSQL arrays are perfect.

### Job Completion Flow

```
Worker → POST /internal/task-result {job_id, partial_sums}
API → BEGIN TRANSACTION
         UPDATE job_partial_sums ...
         RETURNING batch_count, total_batches
      END TRANSACTION
API → IF batch_count == total_batches:
         final_mean = sums / F
         write_csv_to_minio(final_mean)
         UPDATE jobs SET status='done', result_key=...
         broadcast SSE event
```

### Batch Division Strategy

Given F files, split into ceil(F/5) batches:
```typescript
function createBatches(fileKeys: string[], batchSize: number = 5): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < fileKeys.length; i += batchSize) {
    batches.push(fileKeys.slice(i, i + batchSize));
  }
  return batches;
}
// F=20 → 4 batches of 5
// F=23 → 4 batches of 5 + 1 batch of 3
```

Work-stealing: enqueue all batches to Redis at job creation time. Workers BRPOP and get whatever's available. Fastest workers naturally get more batches.

## Summary

| Decision | Choice | Reason |
|----------|--------|--------|
| Worker computes | Partial sums, not partial means | Simpler aggregation formula |
| Accumulation | PostgreSQL array atomic UPDATE | Single atomic op, state in DB |
| Completion detection | Atomic counter in PostgreSQL | batch_count == total_batches |
| Numerical precision | float64 | Sufficient for F≤100k, C≤10k |
| Memory per worker | ~400KB peak | C×5×8 bytes, all in numpy array |
| Batch size | max 5 files | Per TASK.md constraint |
| Work distribution | Redis BRPOP | Natural work-stealing |
