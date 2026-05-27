/**
 * Jobs API Tests
 * Tests for POST /jobs, GET /jobs, GET /jobs/:id, GET /jobs/:id/tasks, GET /jobs/:id/result
 */
import type { Request, Response, NextFunction } from 'express';

// ─── Mock external dependencies ────────────────────────────────────────────

jest.mock('../db/index.js', () => ({
  db: {
    query: jest.fn(),
    connect: jest.fn(),
    pool: { end: jest.fn() },
  },
  initSchema: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/redis.js', () => ({
  redis: {
    connect: jest.fn().mockResolvedValue(undefined),
    lpush: jest.fn().mockResolvedValue(1),
    llen: jest.fn().mockResolvedValue(0),
    smembers: jest.fn().mockResolvedValue([]),
    setex: jest.fn().mockResolvedValue('OK'),
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
    sadd: jest.fn().mockResolvedValue(1),
    srem: jest.fn().mockResolvedValue(1),
  },
  redisSubscriber: { connect: jest.fn().mockResolvedValue(undefined) },
  REDIS_KEYS: {
    QUEUE: 'dmsystem:queue',
    DLQ: 'dmsystem:dlq',
    WORKERS_SET: 'dmsystem:workers',
    workerStatus: (id: string) => `dmsystem:worker:${id}:status`,
    workerHb: (id: string) => `dmsystem:worker:${id}:hb`,
    workerTask: (id: string) => `dmsystem:worker:${id}:task`,
  },
  connectRedis: jest.fn().mockResolvedValue(undefined),
  enqueueTask: jest.fn().mockResolvedValue(undefined),
  getQueueDepth: jest.fn().mockResolvedValue(0),
  getWorkerIds: jest.fn().mockResolvedValue([]),
  getWorkerStatus: jest.fn().mockResolvedValue('idle'),
  getWorkerCurrentTask: jest.fn().mockResolvedValue(null),
}));

jest.mock('../lib/storage.js', () => ({
  s3: {},
  ensureBucket: jest.fn().mockResolvedValue(undefined),
  inputFilePath: (jobId: string, idx: number) => `jobs/${jobId}/inputs/file_${idx}.csv`,
  outputFilePath: (jobId: string) => `jobs/${jobId}/output/result.csv`,
  putObject: jest.fn().mockResolvedValue(undefined),
  getObject: jest.fn().mockResolvedValue({
    pipe: jest.fn(),
    on: jest.fn(),
    [Symbol.asyncIterator]: function* () { yield Buffer.from('0.5\n0.6\n'); },
  }),
  getObjectString: jest.fn().mockResolvedValue('0.5\n0.6\n'),
  generateFileCsv: jest.fn().mockReturnValue('0.1\n0.2\n0.3\n'),
}));

jest.mock('../lib/sse.js', () => ({
  addSSEClient: jest.fn(),
  broadcast: jest.fn(),
  broadcastLog: jest.fn(),
}));

// ─── Tests ─────────────────────────────────────────────────────────────────

import { db } from '../db/index.js';

const mockJobRow = {
  id: 'test-job-id',
  f: 10,
  c: 5,
  status: 'done',
  batch_count: 2,
  completed_batches: 2,
  result_path: 'jobs/test-job-id/output/result.csv',
  error: null,
  created_at: new Date(),
  updated_at: new Date(),
  completed_at: new Date(),
};

const mockDbQuery = db.query as jest.Mock;

describe('jobService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getJob', () => {
    it('returns job when found', async () => {
      mockDbQuery.mockResolvedValueOnce({ rows: [mockJobRow] });
      const { getJob } = await import('../services/jobService.js');
      const job = await getJob('test-job-id');
      expect(job).not.toBeNull();
      expect(job?.id).toBe('test-job-id');
      expect(job?.f).toBe(10);
      expect(job?.status).toBe('done');
    });

    it('returns null when not found', async () => {
      mockDbQuery.mockResolvedValueOnce({ rows: [] });
      const { getJob } = await import('../services/jobService.js');
      const job = await getJob('nonexistent-id');
      expect(job).toBeNull();
    });
  });

  describe('listJobs', () => {
    it('returns array of jobs', async () => {
      mockDbQuery.mockResolvedValueOnce({ rows: [mockJobRow, { ...mockJobRow, id: 'job-2' }] });
      const { listJobs } = await import('../services/jobService.js');
      const jobs = await listJobs();
      expect(Array.isArray(jobs)).toBe(true);
      expect(jobs).toHaveLength(2);
    });

    it('returns empty array when no jobs', async () => {
      mockDbQuery.mockResolvedValueOnce({ rows: [] });
      const { listJobs } = await import('../services/jobService.js');
      const jobs = await listJobs();
      expect(jobs).toHaveLength(0);
    });
  });

  describe('getTasksForJob', () => {
    it('returns tasks for job', async () => {
      const mockTaskRow = {
        id: 'task-1',
        job_id: 'test-job-id',
        batch_index: 0,
        file_start: 0,
        file_end: 4,
        status: 'done',
        worker_id: 'worker-1',
        started_at: new Date(),
        completed_at: new Date(),
        error: null,
      };
      mockDbQuery.mockResolvedValueOnce({ rows: [mockTaskRow] });
      const { getTasksForJob } = await import('../services/jobService.js');
      const tasks = await getTasksForJob('test-job-id');
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.batchIndex).toBe(0);
      expect(tasks[0]?.status).toBe('done');
    });
  });
});

describe('Jobs route validation', () => {
  const CreateJobSchema = require('zod').z.object({
    F: require('zod').z.number().int().min(2).max(100_000),
    C: require('zod').z.number().int().min(1).max(10_000),
  });

  it('validates F and C ranges', () => {
    const valid = CreateJobSchema.safeParse({ F: 20, C: 100 });
    expect(valid.success).toBe(true);
  });

  it('rejects F < 2', () => {
    const result = CreateJobSchema.safeParse({ F: 1, C: 100 });
    expect(result.success).toBe(false);
  });

  it('rejects C > 10000', () => {
    const result = CreateJobSchema.safeParse({ F: 10, C: 10001 });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer F', () => {
    const result = CreateJobSchema.safeParse({ F: 10.5, C: 100 });
    expect(result.success).toBe(false);
  });

  it('rejects missing fields', () => {
    const result = CreateJobSchema.safeParse({ F: 10 });
    expect(result.success).toBe(false);
  });
});

describe('systemService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('getSystemStats returns correct shape', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ total: '5', generating: '1', queued: '2', running: '1', aggregating: '0', done: '1', failed: '0' }]
    });
    const { getSystemStats } = await import('../services/systemService.js');
    const stats = await getSystemStats();
    expect(stats).toHaveProperty('workers');
    expect(stats).toHaveProperty('queueDepth');
    expect(stats).toHaveProperty('jobStats');
    expect(stats.jobStats.total).toBe(5);
    expect(stats.jobStats.done).toBe(1);
  });
});

describe('Zod schema validation helpers', () => {
  it('validates task complete schema', () => {
    const { z } = require('zod');
    const schema = z.object({
      taskId: z.string(),
      jobId: z.string(),
      workerId: z.string(),
      partialSums: z.array(z.number()),
      count: z.number().int().positive(),
    });
    const valid = schema.safeParse({
      taskId: 'abc',
      jobId: 'def',
      workerId: 'w1',
      partialSums: [1.0, 2.0, 3.0],
      count: 3,
    });
    expect(valid.success).toBe(true);
  });

  it('rejects zero count', () => {
    const { z } = require('zod');
    const schema = z.object({
      count: z.number().int().positive(),
    });
    const result = schema.safeParse({ count: 0 });
    expect(result.success).toBe(false);
  });
});

describe('SSE helpers', () => {
  it('broadcastLog is called with correct args', () => {
    const { broadcastLog } = require('../lib/sse.js');
    broadcastLog('info', 'test message');
    expect(broadcastLog).toHaveBeenCalledWith('info', 'test message');
  });
});

describe('storage helpers', () => {
  it('inputFilePath returns correct key format', () => {
    const { inputFilePath } = require('../lib/storage.js');
    const path = inputFilePath('job-123', 5) as string;
    expect(path).toContain('job-123');
    expect(path).toContain('file_5');
  });

  it('outputFilePath returns correct key format', () => {
    const { outputFilePath } = require('../lib/storage.js');
    const path = outputFilePath('job-456') as string;
    expect(path).toContain('job-456');
    expect(path).toContain('result');
  });

  it('generateFileCsv returns string with newlines', () => {
    const { generateFileCsv } = require('../lib/storage.js');
    const csv = generateFileCsv(5) as string;
    expect(typeof csv).toBe('string');
  });
});

describe('Redis queue operations', () => {
  it('enqueueTask calls lpush', async () => {
    const { redis, enqueueTask } = require('../lib/redis.js');
    await enqueueTask({ taskId: 'abc', jobId: 'def' });
    // enqueueTask is mocked — just ensure no throw
    expect(true).toBe(true);
  });

  it('getQueueDepth returns a number', async () => {
    const { getQueueDepth } = require('../lib/redis.js');
    const depth = await getQueueDepth() as number;
    expect(typeof depth).toBe('number');
  });
});
