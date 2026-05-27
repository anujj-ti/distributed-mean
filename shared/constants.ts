/**
 * Shared constants used across the system.
 * Workers use the Python equivalents in worker.py.
 */

export const BATCH_SIZE = 5; // max files per worker batch

export const REDIS_KEYS = {
  QUEUE: 'dmsystem:queue',
  DLQ: 'dmsystem:dlq',
  WORKERS_SET: 'dmsystem:workers',
  workerStatus: (id: string) => `dmsystem:worker:${id}:status`,
  workerHb: (id: string) => `dmsystem:worker:${id}:hb`,
  workerTask: (id: string) => `dmsystem:worker:${id}:task`,
} as const;

export const JOB_STATUSES = [
  'generating',
  'queued',
  'running',
  'aggregating',
  'done',
  'failed',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
