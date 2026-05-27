import { db } from '../db/index.js';
import {
  getWorkerIds,
  getWorkerStatus,
  getWorkerCurrentTask,
  getQueueDepth,
} from '../lib/redis.js';
import type { SystemStats, WorkerInfo } from '../types/index.js';

export async function getSystemStats(): Promise<SystemStats> {
  const [workerIds, queueDepth, jobStatsResult] = await Promise.all([
    getWorkerIds(),
    getQueueDepth(),
    db.query<Record<string, unknown>>(`
      SELECT
        COUNT(*) FILTER (WHERE status='generating') AS generating,
        COUNT(*) FILTER (WHERE status='queued') AS queued,
        COUNT(*) FILTER (WHERE status='running') AS running,
        COUNT(*) FILTER (WHERE status='aggregating') AS aggregating,
        COUNT(*) FILTER (WHERE status='done') AS done,
        COUNT(*) FILTER (WHERE status='failed') AS failed,
        COUNT(*) AS total
      FROM jobs
    `),
  ]);

  const workers: WorkerInfo[] = await Promise.all(
    workerIds.map(async (id) => {
      const [status, currentTaskId] = await Promise.all([
        getWorkerStatus(id),
        getWorkerCurrentTask(id),
      ]);
      return {
        id,
        status: status ?? 'idle',
        currentTaskId,
      };
    })
  );

  const stats = jobStatsResult.rows[0] ?? {};
  const toNumber = (v: unknown) => Number(v ?? 0);

  return {
    workers,
    workerCount: workers.length,
    idleWorkers: workers.filter((w) => w.status === 'idle').length,
    busyWorkers: workers.filter((w) => w.status === 'busy').length,
    queueDepth,
    jobStats: {
      total: toNumber(stats['total']),
      generating: toNumber(stats['generating']),
      queued: toNumber(stats['queued']),
      running: toNumber(stats['running']),
      aggregating: toNumber(stats['aggregating']),
      done: toNumber(stats['done']),
      failed: toNumber(stats['failed']),
    },
  };
}
