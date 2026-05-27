import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { enqueueTask, getQueueDepth } from '../lib/redis.js';
import {
  ensureBucket,
  inputFilePath,
  putObject,
  generateFileCsv,
} from '../lib/storage.js';
import { broadcast, broadcastLog } from '../lib/sse.js';
import type { Job, Task, TaskMessage } from '../types/index.js';

const BATCH_SIZE = 5;

export async function createJob(f: number, c: number): Promise<Job> {
  const jobId = uuidv4();
  const batchCount = Math.ceil(f / BATCH_SIZE);

  const result = await db.query<Record<string, unknown>>(
    `INSERT INTO jobs (id, f, c, status, batch_count)
     VALUES ($1, $2, $3, 'generating', $4)
     RETURNING id, f, c, status, batch_count,
               completed_batches, result_path, error,
               created_at, updated_at, completed_at`,
    [jobId, f, c, batchCount]
  );

  const job = rowToJob(result.rows[0]!);

  broadcastLog('info', `Job ${jobId} created: F=${f}, C=${c}, batches=${batchCount}`);
  broadcast({ type: 'job_update', job });

  // Generate files and enqueue tasks asynchronously
  setImmediate(() => generateAndEnqueue(job).catch((err: unknown) => {
    broadcastLog('error', `Job ${jobId} generation failed: ${String(err)}`);
    void db.query(
      `UPDATE jobs SET status='failed', error=$2, updated_at=NOW() WHERE id=$1`,
      [jobId, String(err)]
    );
  }));

  return job;
}

async function generateAndEnqueue(job: Job): Promise<void> {
  await ensureBucket();

  broadcastLog('info', `Generating ${job.f} files for job ${job.id}...`);

  // Generate all input files and upload to MinIO
  const GENERATE_BATCH = 100; // upload in chunks of 100 to avoid overwhelming MinIO
  for (let i = 0; i < job.f; i += GENERATE_BATCH) {
    const end = Math.min(i + GENERATE_BATCH, job.f);
    await Promise.all(
      Array.from({ length: end - i }, (_, k) => {
        const fileIndex = i + k;
        const csv = generateFileCsv(job.c);
        const key = inputFilePath(job.id, fileIndex);
        return putObject(key, csv);
      })
    );
    if (i % 1000 === 0 && i > 0) {
      broadcastLog('info', `Job ${job.id}: generated ${i}/${job.f} files`);
    }
  }

  broadcastLog('info', `Job ${job.id}: all files generated, enqueueing ${Math.ceil(job.f / BATCH_SIZE)} tasks`);

  // Create task records and enqueue
  const batchCount = Math.ceil(job.f / BATCH_SIZE);
  for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
    const fileStart = batchIndex * BATCH_SIZE;
    const fileEnd = Math.min(fileStart + BATCH_SIZE - 1, job.f - 1);
    const taskId = uuidv4();

    await db.query(
      `INSERT INTO tasks (id, job_id, batch_index, file_start, file_end, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [taskId, job.id, batchIndex, fileStart, fileEnd]
    );

    const msg: TaskMessage = {
      taskId,
      jobId: job.id,
      batchIndex,
      fileStart,
      fileEnd,
      c: job.c,
    };
    await enqueueTask(msg);
  }

  // Update job status to queued
  await db.query(
    `UPDATE jobs SET status='queued', updated_at=NOW() WHERE id=$1`,
    [job.id]
  );

  const depth = await getQueueDepth();
  broadcast({ type: 'queue_depth', depth });
  broadcast({ type: 'job_update', job: { id: job.id, status: 'queued' } });
  broadcastLog('info', `Job ${job.id}: queued, ${batchCount} tasks in queue`);
}

export async function getJob(jobId: string): Promise<Job | null> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT id, f, c, status, batch_count, completed_batches,
            result_path, error, created_at, updated_at, completed_at
     FROM jobs WHERE id=$1`,
    [jobId]
  );
  if (result.rows.length === 0) return null;
  return rowToJob(result.rows[0]!);
}

export async function listJobs(): Promise<Job[]> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT id, f, c, status, batch_count, completed_batches,
            result_path, error, created_at, updated_at, completed_at
     FROM jobs ORDER BY created_at DESC LIMIT 100`
  );
  return result.rows.map(rowToJob);
}

function rowToJob(row: Record<string, unknown>): Job {
  return {
    id: row['id'] as string,
    f: row['f'] as number,
    c: row['c'] as number,
    status: row['status'] as Job['status'],
    batchCount: row['batch_count'] as number,
    completedBatches: row['completed_batches'] as number,
    resultPath: (row['result_path'] as string | null) ?? null,
    error: (row['error'] as string | null) ?? null,
    createdAt: row['created_at'] as Date,
    updatedAt: row['updated_at'] as Date,
    completedAt: (row['completed_at'] as Date | null) ?? null,
  };
}

export async function getTasksForJob(jobId: string): Promise<Task[]> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT id, job_id, batch_index, file_start, file_end, status,
            worker_id, started_at, completed_at, error
     FROM tasks WHERE job_id=$1 ORDER BY batch_index`,
    [jobId]
  );
  return result.rows.map(rowToTask);
}

export async function getTask(taskId: string): Promise<Task | null> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT id, job_id, batch_index, file_start, file_end, status,
            worker_id, started_at, completed_at, error
     FROM tasks WHERE id=$1`,
    [taskId]
  );
  if (result.rows.length === 0) return null;
  return rowToTask(result.rows[0]!);
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row['id'] as string,
    jobId: row['job_id'] as string,
    batchIndex: row['batch_index'] as number,
    fileStart: row['file_start'] as number,
    fileEnd: row['file_end'] as number,
    status: row['status'] as Task['status'],
    workerId: (row['worker_id'] as string | null) ?? null,
    startedAt: (row['started_at'] as Date | null) ?? null,
    completedAt: (row['completed_at'] as Date | null) ?? null,
    error: (row['error'] as string | null) ?? null,
  };
}
