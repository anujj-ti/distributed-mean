/**
 * Internal endpoints called by Python workers to report status.
 * These are not part of the public API surface.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { redis, REDIS_KEYS, getQueueDepth } from '../lib/redis.js';
import { broadcast, broadcastLog } from '../lib/sse.js';
import { getJob } from '../services/jobService.js';

const router = Router();

const WorkerHeartbeatSchema = z.object({
  workerId: z.string(),
  status: z.enum(['idle', 'busy']),
  currentTaskId: z.string().nullable().optional(),
});

// POST /internal/worker/heartbeat
router.post('/worker/heartbeat', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = WorkerHeartbeatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid' });
      return;
    }
    const { workerId, status, currentTaskId } = parsed.data;

    await Promise.all([
      redis.sadd(REDIS_KEYS.WORKERS_SET, workerId),
      redis.setex(REDIS_KEYS.workerHb(workerId), 15, '1'),
      redis.set(REDIS_KEYS.workerStatus(workerId), status),
      currentTaskId
        ? redis.set(REDIS_KEYS.workerTask(workerId), currentTaskId)
        : redis.del(REDIS_KEYS.workerTask(workerId)),
    ]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const TaskCompleteSchema = z.object({
  taskId: z.string(),
  jobId: z.string(),
  workerId: z.string(),
  partialSums: z.array(z.number()),
  count: z.number().int().positive(),
});

// POST /internal/task/complete — worker reports task completion with partial result
router.post('/task/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = TaskCompleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid', details: parsed.error.flatten() });
      return;
    }
    const { taskId, jobId, workerId, partialSums, count } = parsed.data;

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Store partial result
      const { v4: uuidv4 } = await import('uuid');
      await client.query(
        `INSERT INTO partial_results (id, job_id, task_id, sums, count)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv4(), jobId, taskId, partialSums, count]
      );

      // Mark task done
      await client.query(
        `UPDATE tasks SET status='done', completed_at=NOW(), worker_id=$2 WHERE id=$1`,
        [taskId, workerId]
      );

      // Atomic increment
      const jobResult = await client.query<{ completed_batches: number; batch_count: number }>(
        `UPDATE jobs SET completed_batches=completed_batches+1, updated_at=NOW(), status=
          CASE WHEN status='queued' THEN 'running' ELSE status END
         WHERE id=$1
         RETURNING completed_batches, batch_count`,
        [jobId]
      );

      await client.query('COMMIT');

      const { completed_batches, batch_count } = jobResult.rows[0]!;

      broadcastLog(
        'info',
        `Job ${jobId}: batch ${completed_batches}/${batch_count} done (worker ${workerId})`
      );
      broadcast({
        type: 'job_update',
        job: { id: jobId, completedBatches: completed_batches, status: 'running' },
      });
      broadcast({ type: 'queue_depth', depth: await getQueueDepth() });

      if (completed_batches >= batch_count) {
        // Trigger aggregation
        setImmediate(() => void triggerAggregation(jobId));
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

async function triggerAggregation(jobId: string): Promise<void> {
  broadcastLog('info', `Job ${jobId}: starting aggregation`);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Advisory lock using hash of jobId — ensures single aggregation
    const lockResult = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`,
      [jobId]
    );
    if (!lockResult.rows[0]?.acquired) {
      await client.query('ROLLBACK');
      broadcastLog('info', `Job ${jobId}: aggregation already running`);
      return;
    }

    // Mark aggregating
    await client.query(
      `UPDATE jobs SET status='aggregating', updated_at=NOW() WHERE id=$1`,
      [jobId]
    );
    broadcast({ type: 'job_update', job: { id: jobId, status: 'aggregating' } });

    // Get job info
    const jobRow = await client.query<{ c: number; f: number }>(
      `SELECT c, f FROM jobs WHERE id=$1`,
      [jobId]
    );
    const { c, f } = jobRow.rows[0]!;

    // Stream partial results and accumulate
    const totalSums = new Float64Array(c);
    let totalCount = 0;

    const cursor = client.query<{ sums: number[]; count: number }>(
      `SELECT sums, count FROM partial_results WHERE job_id=$1`,
      [jobId]
    );

    for await (const row of iterateCursor(cursor)) {
      const { sums, count } = row;
      for (let i = 0; i < c; i++) {
        // Float64Array with noUncheckedIndexedAccess — current value always exists for valid index
        totalSums[i] = (totalSums[i] ?? 0) + (sums[i] ?? 0);
      }
      totalCount += count;
    }

    // Compute final mean
    const finalMean = Array.from(totalSums).map((s) => s / totalCount);
    const resultCsv = finalMean.map((v) => v.toFixed(8)).join('\n') + '\n';

    // Store result in MinIO
    const { putObject, outputFilePath } = await import('../lib/storage.js');
    const resultPath = outputFilePath(jobId);
    await putObject(resultPath, resultCsv);

    // Mark job done
    await client.query(
      `UPDATE jobs SET status='done', result_path=$2, updated_at=NOW(), completed_at=NOW() WHERE id=$1`,
      [jobId, resultPath]
    );

    await client.query('COMMIT');

    broadcastLog('info', `Job ${jobId}: DONE! Aggregated ${f} files, result at ${resultPath}`);
    const job = await getJob(jobId);
    if (job) broadcast({ type: 'job_update', job });
  } catch (err) {
    await client.query('ROLLBACK');
    broadcastLog('error', `Job ${jobId} aggregation failed: ${String(err)}`);
    await db.query(
      `UPDATE jobs SET status='failed', error=$2, updated_at=NOW() WHERE id=$1`,
      [jobId, String(err)]
    );
    broadcast({ type: 'job_update', job: { id: jobId, status: 'failed' } });
  } finally {
    client.release();
  }
}

// Helper to iterate over a pg query promise as an async iterable
async function* iterateCursor<T>(
  queryPromise: Promise<{ rows: T[] }> | { rows: T[] }
): AsyncIterable<T> {
  const result = await queryPromise;
  for (const row of result.rows) {
    yield row;
  }
}

const WorkerRegisterSchema = z.object({
  workerId: z.string(),
});

// POST /internal/worker/register
router.post('/worker/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = WorkerRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid' });
      return;
    }
    const { workerId } = parsed.data;
    await redis.sadd(REDIS_KEYS.WORKERS_SET, workerId);
    await redis.setex(REDIS_KEYS.workerHb(workerId), 15, '1');
    await redis.set(REDIS_KEYS.workerStatus(workerId), 'idle');

    broadcastLog('info', `Worker ${workerId} registered`);
    // Broadcast updated workers
    const { getSystemStats } = await import('../services/systemService.js');
    const stats = await getSystemStats();
    broadcast({ type: 'worker_update', workers: stats.workers });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /internal/worker/unregister
router.post('/worker/unregister', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = WorkerRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid' });
      return;
    }
    const { workerId } = parsed.data;
    await Promise.all([
      redis.srem(REDIS_KEYS.WORKERS_SET, workerId),
      redis.del(REDIS_KEYS.workerHb(workerId)),
      redis.del(REDIS_KEYS.workerStatus(workerId)),
      redis.del(REDIS_KEYS.workerTask(workerId)),
    ]);

    broadcastLog('info', `Worker ${workerId} unregistered`);
    const { getSystemStats } = await import('../services/systemService.js');
    const stats = await getSystemStats();
    broadcast({ type: 'worker_update', workers: stats.workers });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
export { triggerAggregation };
