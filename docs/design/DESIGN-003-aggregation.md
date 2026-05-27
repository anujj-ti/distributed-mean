# DESIGN-003: Partial Result Aggregation

## Overview
Describes how partial sums from workers are combined into the final index-wise mean file, with O(C) memory regardless of F.

## Algorithm

```
For job with F files, C values each, batch_size=5:
  batches = ceil(F / 5)
  
  Each batch i computes:
    partial_sums_i = [sum(file[f][j] for f in batch_i) for j in range(C)]
    count_i = len(batch_i)   # always 5 except possibly the last batch
  
  Aggregation (streaming, O(C) memory):
    total_sums = [0.0] * C
    total_count = 0
    for each (partial_sums_i, count_i) from DB:
      total_sums += partial_sums_i   # numpy vectorized add
      total_count += count_i
    
    final_mean = total_sums / total_count   # = total_sums / F
```

## Concurrency Safety

```sql
-- Atomic batch completion counter
UPDATE jobs
SET completed_batches = completed_batches + 1, updated_at = NOW()
WHERE id = $job_id
RETURNING id, completed_batches, batch_count;

-- If completed_batches == batch_count:
--   Try advisory lock (hash of job_id to integer)
SELECT pg_try_advisory_xact_lock(('x' || substr(md5($job_id), 1, 16))::bit(64)::bigint);
-- Returns true for exactly one worker → that worker runs aggregation
-- Other workers get false → they skip, job will be aggregated by the winner
```

## Output Format
```
result.csv:
2.5
3.5
4.5
```
One float per line, C lines total.
