/**
 * Tests for POST /internal/task/complete and aggregation logic
 */
import express from 'express';
import request from 'supertest';

// Create mock client for the DB transaction
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockClient = {
  query: mockClientQuery,
  release: mockClientRelease,
};

jest.mock('../db/index.js', () => ({
  db: {
    query: jest.fn(),
    connect: jest.fn().mockResolvedValue(mockClient),
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
  getObject: jest.fn(),
  getObjectString: jest.fn().mockResolvedValue('0.5\n'),
  generateFileCsv: jest.fn().mockReturnValue('0.1\n0.2\n'),
}));

jest.mock('../lib/sse.js', () => ({
  addSSEClient: jest.fn(),
  broadcast: jest.fn(),
  broadcastLog: jest.fn(),
}));

jest.mock('../services/jobService.js', () => ({
  createJob: jest.fn(),
  getJob: jest.fn(),
  listJobs: jest.fn().mockResolvedValue([]),
  getTasksForJob: jest.fn().mockResolvedValue([]),
  getTask: jest.fn(),
}));

import internalRouter from '../routes/internal.js';
import { errorHandler } from '../middleware/errorHandler.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/internal', internalRouter);
  app.use(errorHandler);
  return app;
}

describe('POST /internal/task/complete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
  });

  it('rejects invalid payload', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/internal/task/complete')
      .send({ taskId: 'abc' }); // missing fields
    expect(res.status).toBe(400);
  });

  it('rejects negative count', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/internal/task/complete')
      .send({
        taskId: 'task-1',
        jobId: 'job-1',
        workerId: 'w-1',
        partialSums: [0.5, 0.5],
        count: -1,
      });
    expect(res.status).toBe(400);
  });

  it('successfully completes a task (not last batch)', async () => {
    // Mock the DB client transaction
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // INSERT partial_result
      .mockResolvedValueOnce({}) // UPDATE tasks
      .mockResolvedValueOnce({ rows: [{ completed_batches: 1, batch_count: 4 }] }) // UPDATE jobs
      .mockResolvedValueOnce({}); // COMMIT

    const app = createApp();
    const res = await request(app)
      .post('/internal/task/complete')
      .send({
        taskId: 'task-1',
        jobId: 'job-1',
        workerId: 'w-1',
        partialSums: [0.5, 0.7, 0.3],
        count: 3,
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockClientRelease).toHaveBeenCalled();
  });

  it('triggers aggregation when all batches complete', async () => {
    // Mock completed_batches == batch_count
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // INSERT partial_result
      .mockResolvedValueOnce({}) // UPDATE tasks
      .mockResolvedValueOnce({ rows: [{ completed_batches: 3, batch_count: 3 }] }) // UPDATE jobs - all done!
      .mockResolvedValueOnce({}); // COMMIT

    // For aggregation (triggerAggregation is called via setImmediate)
    // The aggregation will use db.connect() again
    const { db } = require('../db/index.js');
    const aggClient = {
      query: jest.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // pg_try_advisory_xact_lock
        .mockResolvedValueOnce({}) // UPDATE status='aggregating'
        .mockResolvedValueOnce({ rows: [{ c: 3, f: 3 }] }) // SELECT c, f
        .mockResolvedValueOnce({ rows: [{ sums: [1.5, 2.5, 3.5], count: 3 }] }) // SELECT partial_results
        .mockResolvedValueOnce({}) // COMMIT
        .mockResolvedValueOnce({}), // UPDATE jobs SET status='done'
      release: jest.fn(),
    };
    (db.connect as jest.Mock).mockResolvedValueOnce(mockClient).mockResolvedValueOnce(aggClient);

    // Mock getJob for the final broadcast
    const { getJob } = require('../services/jobService.js');
    (getJob as jest.Mock).mockResolvedValue({
      id: 'job-1', status: 'done', f: 3, c: 3,
      batchCount: 3, completedBatches: 3,
      resultPath: 'jobs/job-1/output/result.csv',
      error: null, createdAt: new Date(), updatedAt: new Date(), completedAt: new Date(),
    });

    const { putObject } = require('../lib/storage.js');

    const app = createApp();
    const res = await request(app)
      .post('/internal/task/complete')
      .send({
        taskId: 'task-3',
        jobId: 'job-1',
        workerId: 'w-1',
        partialSums: [1.5, 2.5, 3.5],
        count: 3,
      });
    expect(res.status).toBe(200);

    // Wait for setImmediate
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  });

  it('handles DB error gracefully', async () => {
    mockClientQuery
      .mockResolvedValueOnce({})                           // BEGIN
      .mockRejectedValueOnce(new Error('DB error'))        // INSERT fails
      .mockResolvedValueOnce({});                          // ROLLBACK

    const app = createApp();
    const res = await request(app)
      .post('/internal/task/complete')
      .send({
        taskId: 'task-err',
        jobId: 'job-1',
        workerId: 'w-1',
        partialSums: [0.5],
        count: 1,
      });
    expect(res.status).toBe(500);
    expect(mockClientRelease).toHaveBeenCalled();
  });
});

describe('POST /internal/worker/heartbeat (direct)', () => {
  it('accepts idle heartbeat', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/internal/worker/heartbeat')
      .send({ workerId: 'w-1', status: 'idle' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /internal/worker/register', () => {
  beforeEach(() => {
    const { db } = require('../db/index.js');
    (db.query as jest.Mock).mockResolvedValue({
      rows: [{
        total: '0', generating: '0', queued: '0', running: '0',
        aggregating: '0', done: '0', failed: '0',
      }],
    });
  });

  it('registers a new worker', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/internal/worker/register')
      .send({ workerId: 'new-worker-123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects empty body', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/internal/worker/register')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /internal/worker/unregister', () => {
  beforeEach(() => {
    const { db } = require('../db/index.js');
    (db.query as jest.Mock).mockResolvedValue({
      rows: [{
        total: '0', generating: '0', queued: '0', running: '0',
        aggregating: '0', done: '0', failed: '0',
      }],
    });
  });

  it('unregisters a worker', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/internal/worker/unregister')
      .send({ workerId: 'old-worker' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects empty body', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/internal/worker/unregister')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /internal/task/complete - advisory lock false', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
  });

  it('skips aggregation when lock not acquired', async () => {
    // Setup: all batches complete, but advisory lock returns false
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // INSERT partial_result
      .mockResolvedValueOnce({}) // UPDATE tasks
      .mockResolvedValueOnce({ rows: [{ completed_batches: 2, batch_count: 2 }] }) // UPDATE jobs
      .mockResolvedValueOnce({}); // COMMIT

    const { db } = require('../db/index.js');
    const aggClientLockFalse = {
      query: jest.fn()
        .mockResolvedValueOnce({})  // BEGIN
        .mockResolvedValueOnce({ rows: [{ acquired: false }] }) // lock not acquired
        .mockResolvedValueOnce({}), // ROLLBACK
      release: jest.fn(),
    };
    (db.connect as jest.Mock)
      .mockResolvedValueOnce(mockClient)
      .mockResolvedValueOnce(aggClientLockFalse);

    const app = createApp();
    const res = await request(app)
      .post('/internal/task/complete')
      .send({
        taskId: 'task-x',
        jobId: 'job-x',
        workerId: 'w-x',
        partialSums: [1.0],
        count: 1,
      });
    expect(res.status).toBe(200);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(aggClientLockFalse.release).toHaveBeenCalled();
  });

  it('handles aggregation error gracefully', async () => {
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN (task complete)
      .mockResolvedValueOnce({}) // INSERT partial_result
      .mockResolvedValueOnce({}) // UPDATE tasks
      .mockResolvedValueOnce({ rows: [{ completed_batches: 1, batch_count: 1 }] }) // UPDATE jobs
      .mockResolvedValueOnce({}); // COMMIT

    const { db } = require('../db/index.js');
    const aggClientError = {
      query: jest.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // lock acquired
        .mockRejectedValueOnce(new Error('DB failure during aggregation')) // next query fails
        .mockResolvedValueOnce({}), // ROLLBACK
      release: jest.fn(),
    };
    (db.connect as jest.Mock)
      .mockResolvedValueOnce(mockClient)
      .mockResolvedValueOnce(aggClientError);

    const { db: db2 } = require('../db/index.js');
    (db2.query as jest.Mock).mockResolvedValue({ rows: [] }); // for UPDATE failed status

    const app = createApp();
    const res = await request(app)
      .post('/internal/task/complete')
      .send({
        taskId: 'task-fail',
        jobId: 'job-fail',
        workerId: 'w-fail',
        partialSums: [0.5],
        count: 1,
      });
    expect(res.status).toBe(200); // task complete itself succeeded

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(aggClientError.release).toHaveBeenCalled();
  });
});
