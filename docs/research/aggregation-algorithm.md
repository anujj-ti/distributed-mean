# Research: Aggregation Algorithm for Distributed Mean

## Question
How to aggregate partial means from workers efficiently without loading all data in memory, for F up to 100k files each with C values?

## Problem Statement
- F files, C values each (F up to 100k, C up to 10k)
- Workers process batches of ≤5 files
- Must produce index-wise mean: `result[i] = mean(file[0][i], file[1][i], ..., file[F-1][i])`
- Cannot load all F×C values at once (F=100k, C=10k = 1 billion values)

## Mathematical Foundation

### Partial Sum Aggregation (chosen approach)
Each worker computes:
- `partial_sums[i]` = sum of value[i] across its batch of files
- `partial_count` = number of files in the batch

Final aggregation:
```
total_sums[i] = Σ partial_sums[i]   (over all batches)
final_mean[i] = total_sums[i] / F
```

Memory: O(C × batches) for accumulation, but we stream from DB so O(C) at any moment.

### Why Not Incremental Mean (Welford)?
Welford's algorithm computes running mean as:
```
mean_n = mean_{n-1} + (x_n - mean_{n-1}) / n
```
Useful for streaming single values. Less useful here because:
- Workers process batches, not single values
- Parallel workers complete out of order
- Partial sums are simpler and equally precise at our scale

### Precision Analysis
- Using float64 (IEEE 754 double): 15-16 decimal digits of precision
- For F=100k files summed: worst case accumulated error ~ε × F where ε ≈ 2.2e-16
- At F=100k: error ~2.2e-11 — negligible for all practical purposes
- If higher precision needed: use Python `decimal.Decimal` or Kahan compensated summation

## Implementation

### Step 1: Worker computes partial result
```python
import numpy as np

def compute_partial(file_paths: list[str]) -> tuple[list[float], int]:
    # Load all files in this batch
    arrays = [np.loadtxt(p, delimiter=',') for p in file_paths]
    # Stack and sum along file axis → shape (C,)
    partial_sums = np.sum(np.stack(arrays), axis=0).tolist()
    return partial_sums, len(arrays)
```

### Step 2: Store partial result in PostgreSQL
```sql
INSERT INTO partial_results (job_id, task_id, sums, count)
VALUES ($1, $2, $3, $4)
```

### Step 3: Aggregate (streaming from DB)
```python
total_sums = [0.0] * C
total_count = 0

cursor.execute("SELECT sums, count FROM partial_results WHERE job_id = %s", [job_id])
for row in cursor:  # streams row by row, O(C) memory
    sums, count = row
    for i in range(C):
        total_sums[i] += sums[i]
    total_count += count

final_mean = [s / total_count for s in total_sums]
```

With NumPy:
```python
# Even faster: accumulate as numpy array
total_sums = np.zeros(C)
for row in cursor:
    total_sums += np.array(row.sums)
    total_count += row.count
final_mean = (total_sums / total_count).tolist()
```

## Complexity
- Worker: O(batch_size × C) time, O(C) memory per batch
- Aggregation: O(batches × C) time, O(C) memory total
- For F=100k, C=10k, batch=5: 20k batches × 10k = 200M additions — ~1 second in numpy

## Completion Detection
- PostgreSQL tracks `completed_batches` per job
- Atomic increment + compare using:
  ```sql
  UPDATE jobs SET completed_batches = completed_batches + 1
  WHERE id = $1
  RETURNING completed_batches, batch_count
  ```
- If `completed_batches == batch_count`: trigger aggregation
- Use `pg_try_advisory_lock(job_id_hash)` to ensure only one worker aggregates
