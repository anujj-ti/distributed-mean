```
━━━ Sherlock ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Research complete.
  Beads: 12/12 research resolved | 5/5 validation resolved
  Validated: 5 claims (3 confirmed, 1 corrected, 1 refuted+corrected)
  Time: ~12 min

  Files:
    report:  ~/.sherlock/sessions/983556f7/report/report.md
    data:    ~/.sherlock/sessions/983556f7/report/data.csv
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Research Report

Here are the verified findings across all four areas:

---

### 1. Distributed Mean Formula — The Exact Math

**Formula:**
```
Global_Mean = Σ(partial_sum_i) / Σ(count_i)
            = Σ(n_i × mean_i) / Σ(n_i)
```

Each file/worker emits exactly **2 numbers**: `(count, sum)`. The aggregator sums all counts and all partial sums, then divides. That's it.

**Memory at 100k scale:** 16 bytes per file (two 64-bit values) = **~1.6 MB total** — versus GB-scale for full data loading. ✓ Validated via systemdesign.one and cribl.io.

**Dask ACA pattern (Python):**
```python
from dask.dataframe import Aggregation

mean_agg = Aggregation(
    name='distributed_mean',
    chunk=lambda s: (s.count(), s.sum()),      # per-partition: emit (n, sum)
    agg=lambda c, s: (c.sum(), s.sum()),        # combine partitions
    finalize=lambda c, s: s / c                 # total_sum / total_count
)
```
For 100k partitions, Dask builds a tree with `split_every=8` — ~6 reduction levels instead of a single bottleneck. Critical: repartition to ~100MB chunks before aggregation.

---

### 2. Numerical Stability — Use Welford + Kahan

**Why naive sum-then-divide fails at scale:**

The naive variance formula `Var = (Σx²)/n - (Σx/n)²` subtracts two ~10¹⁸ numbers at large scales, losing all significant digits. Real measured result: data with mean ~10M and true variance 0.04 → naive returns **−0.098** (impossible). ✓ Validated via embeddedrelated.com.

**Welford per-element update:**
```python
# Per worker, per element:
mean_n = mean_prev + (x - mean_prev) / n
```

**Chan's parallel merge (combining two workers A and B):**
```python
n_AB = n_A + n_B
mean_AB = (n_A * mean_A + n_B * mean_B) / n_AB   # ← USE THIS (stable)
# NOT: mean_A + (mean_B - mean_A) * n_B / n_AB   ← catastrophic cancellation
#                                                    when means are nearly equal
```

**Kahan summation for the final aggregation step** (summing 100k partial sums):
```python
def kahan_sum(values):
    total, compensation = 0.0, 0.0
    for v in values:
        y = v - compensation
        t = total + y
        compensation = (t - total) - y
        total = t
    return total
```
Error bound drops from O(nε) to O(nε²) — applies at both per-worker summation AND global merge. **Disable `-ffast-math`** — it reorders float ops and breaks Kahan.

---

### 3. PostgreSQL Atomic Counters for Job Completion

**Direct `UPDATE counter = counter + 1`** is serialized to ~**105 TPS** under 400 concurrent clients. ✓ Validated.

**INSERT-queue pattern reaches 24,000–25,000 events/sec** (67× improvement). ✓ Validated.

**Recommended pattern:**
```sql
-- Workers INSERT cheaply (no lock contention)
CREATE UNLOGGED TABLE worker_completions (
    job_id    BIGINT,
    worker_id UUID
);
INSERT INTO worker_completions (job_id, worker_id) VALUES ($1, $2);

-- Background aggregator (runs every 100ms or on trigger):
WITH batch AS (
    DELETE FROM worker_completions RETURNING job_id
), counts AS (
    SELECT job_id, COUNT(*) n FROM batch GROUP BY job_id
)
UPDATE jobs SET completed_count = completed_count + c.n
FROM counts c WHERE jobs.id = c.job_id
RETURNING id, completed_count = total_count AS all_done;
```

`UNLOGGED` skips WAL → 30× faster inserts, at the cost of data loss on crash (acceptable for a work queue).

**LISTEN/NOTIFY for the completion signal:**
```sql
-- Trigger fires when all workers done:
CREATE TRIGGER check_done AFTER UPDATE ON jobs FOR EACH ROW
WHEN (NEW.completed_count = NEW.total_count)
EXECUTE FUNCTION pg_notify('job_complete', NEW.id::text);

-- Listener must use autocommit=True and a dedicated connection
-- Ceiling: ~52,000–100,000 jobs/hour. Above that → Redis.
```

**SELECT FOR UPDATE vs advisory locks:** ✗ Corrected — "SELECT FOR UPDATE = 105 ops/sec" was wrong. SELECT FOR UPDATE performs *worse* than naive UPDATE (transaction-level freezes lasting seconds). Advisory locks are not enforced by PostgreSQL and don't block other transactions — they're useless for this use case.

---

### 4. Streaming Aggregation Architecture

**Decision tree:**

| Workers | Recommended pattern |
|---|---|
| < 1,000 | Direct PG UPDATE + LISTEN/NOTIFY trigger |
| 1k–100k | PG INSERT queue (UNLOGGED) + async aggregator + NOTIFY |
| > 100k or sub-second needed | Redis INCRBYFLOAT → async batch to PG |
| Audit trail / replay needed | Kafka Streams KTables + EOS |

**Redis hybrid (recommended for scale):**
```
Worker → INCRBYFLOAT partial_sum:<job_id> <value>
       → INCR      worker_count:<job_id>
Background → check count == expected, batch to PG
```
PG queries degrade severely at ~1,000 inserts/sec (queries >20s). ~ Validated (degradation confirmed; "timeout" wording overstated in original claim).

**Idempotency (prevent double-counting on retry):**
```python
# Write partial sum + dedup marker atomically:
# (worker_id, submission_id) → unique constraint
# On duplicate: skip (idempotent by construction)
```
Redis 8.6+ Streams IDMP mode automates this: tracks `(producer_id, iid)` with configurable TTL — 2–5% throughput cost.

**Kafka exactly-once (for pipelines that need it):**
- Idempotent producers (sequence numbers deduplicate writes)
- Transactional commits (output records + consumer offsets atomic)
- `isolation.level=read_committed` (Last Stable Offset barrier)
- On restart: resumes from last committed offset, no reprocessing

---

Full report with all 28 sources, bead provenance, and validation verdicts saved to:
- **Report:** `~/.sherlock/sessions/983556f7/report/report.md`
- **CSV:** `~/.sherlock/sessions/983556f7/report/data.csv`
