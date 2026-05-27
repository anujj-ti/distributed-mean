import { db } from '../db/index.js';
import { redis, REDIS_KEYS, getWorkerIds, enqueueTask } from '../lib/redis.js';
import { broadcastLog, broadcast } from '../lib/sse.js';

const REAPER_INTERVAL_MS = 30_000;

let reaperTimer: ReturnType<typeof setInterval> | null = null;

export function startReaper(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    void runReaper();
  }, REAPER_INTERVAL_MS);
  broadcastLog('info', 'Reaper started');
}

export function stopReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}

async function runReaper(): Promise<void> {
  const workerIds = await getWorkerIds();

  for (const wid of workerIds) {
    const hb = await redis.get(REDIS_KEYS.workerHb(wid));
    if (hb !== null) continue; // heartbeat still alive

    broadcastLog('warn', `Worker ${wid} heartbeat expired — checking for orphaned tasks`);

    const taskId = await redis.get(REDIS_KEYS.workerTask(wid));
    if (taskId) {
      // Re-enqueue orphaned task
      const result = await db.query<Record<string, unknown>>(
        `UPDATE tasks SET status='pending', worker_id=NULL, started_at=NULL
         WHERE id=$1 AND status='running'
         RETURNING id, job_id, batch_index, file_start, file_end,
                   (SELECT c FROM jobs WHERE id=tasks.job_id) AS c`,
        [taskId]
      );
      if (result.rows.length > 0) {
        const row = result.rows[0]!;
        await enqueueTask({
          taskId: row['id'],
          jobId: row['job_id'],
          batchIndex: row['batch_index'],
          fileStart: row['file_start'],
          fileEnd: row['file_end'],
          c: row['c'],
        });
        broadcastLog('warn', `Re-enqueued orphaned task ${String(taskId)} from dead worker ${wid}`);
        broadcast({ type: 'queue_depth', depth: await import('../lib/redis.js').then(m => m.getQueueDepth()) });
      }
    }

    // Clean up dead worker's keys
    await Promise.all([
      redis.srem(REDIS_KEYS.WORKERS_SET, wid),
      redis.del(REDIS_KEYS.workerStatus(wid)),
      redis.del(REDIS_KEYS.workerTask(wid)),
    ]);

    broadcastLog('info', `Cleaned up dead worker ${wid}`);
  }
}
