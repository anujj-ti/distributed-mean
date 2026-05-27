/**
 * Route integration tests using supertest
 */
import express from 'express';
import request from 'supertest';

// Mock external dependencies
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
    llen: jest.fn().mockResolvedValue(3),
    smembers: jest.fn().mockResolvedValue(['worker-1', 'worker-2']),
    setex: jest.fn().mockResolvedValue('OK'),
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue('idle'),
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
  getQueueDepth: jest.fn().mockResolvedValue(3),
  getWorkerIds: jest.fn().mockResolvedValue(['worker-1', 'worker-2']),
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
    pipe: (res: { end: () => void }) => { res.end(); },
    on: jest.fn(),
  }),
  getObjectString: jest.fn().mockResolvedValue('0.5\n0.6\n'),
  generateFileCsv: jest.fn().mockReturnValue('0.1\n0.2\n0.3\n'),
}));

jest.mock('../lib/sse.js', () => ({
  addSSEClient: jest.fn(),
  broadcast: jest.fn(),
  broadcastLog: jest.fn(),
}));

// ─── Setup app ─────────────────────────────────────────────────────────────
import jobsRouter from '../routes/jobs.js';
import systemRouter, { sseHandler } from '../routes/system.js';
import internalRouter from '../routes/internal.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { db } from '../db/index.js';

const mockDbQuery = db.query as jest.Mock;
const mockDbConnect = db.connect as jest.Mock;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/jobs', jobsRouter);
  app.use('/system', systemRouter);
  app.get('/events', sseHandler);
  app.use('/internal', internalRouter);
  app.use(errorHandler);
  return app;
}

// ─── Jobs routes ──────────────────────────────────────────────────────────

const mockJob = {
  id: 'job-abc-123',
  f: 10,
  c: 5,
  status: 'done',
  batch_count: 2,
  completed_batches: 2,
  result_path: 'jobs/job-abc-123/output/result.csv',
  error: null,
  created_at: new Date(),
  updated_at: new Date(),
  completed_at: new Date(),
};

describe('GET /jobs', () => {
  it('returns list of jobs', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [mockJob] });
    const app = createApp();
    const res = await request(app).get('/jobs');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('jobs');
    expect(Array.isArray(res.body.jobs)).toBe(true);
  });

  it('returns empty array when no jobs', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const app = createApp();
    const res = await request(app).get('/jobs');
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(0);
  });
});

describe('GET /jobs/:id', () => {
  it('returns job when found', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [mockJob] });
    const app = createApp();
    const res = await request(app).get('/jobs/job-abc-123');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('job-abc-123');
  });

  it('returns 404 when job not found', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const app = createApp();
    const res = await request(app).get('/jobs/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
  });
});

describe('GET /jobs/:id/tasks', () => {
  it('returns tasks for job', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [mockJob] })  // getJob
      .mockResolvedValueOnce({ rows: [{            // getTasksForJob
        id: 'task-1',
        job_id: 'job-abc-123',
        batch_index: 0,
        file_start: 0,
        file_end: 4,
        status: 'done',
        worker_id: 'worker-1',
        started_at: new Date(),
        completed_at: new Date(),
        error: null,
      }] });
    const app = createApp();
    const res = await request(app).get('/jobs/job-abc-123/tasks');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('tasks');
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].batchIndex).toBe(0);
  });

  it('returns 404 for nonexistent job', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const app = createApp();
    const res = await request(app).get('/jobs/nonexistent/tasks');
    expect(res.status).toBe(404);
  });
});

describe('GET /jobs/:id/result', () => {
  it('returns 409 when job not done', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ ...mockJob, status: 'running', result_path: null }]
    });
    const app = createApp();
    const res = await request(app).get('/jobs/job-abc-123/result');
    expect(res.status).toBe(409);
  });

  it('returns 404 when job not found', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const app = createApp();
    const res = await request(app).get('/jobs/nonexistent/result');
    expect(res.status).toBe(404);
  });

  it('streams CSV when job is done', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [mockJob] });
    const app = createApp();
    const res = await request(app).get('/jobs/job-abc-123/result');
    expect(res.status).toBe(200);
  });
});

describe('POST /jobs validation', () => {
  it('rejects missing F and C', async () => {
    const app = createApp();
    const res = await request(app).post('/jobs').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('rejects F < 2', async () => {
    const app = createApp();
    const res = await request(app).post('/jobs').send({ F: 1, C: 100 });
    expect(res.status).toBe(400);
  });

  it('rejects C > 10000', async () => {
    const app = createApp();
    const res = await request(app).post('/jobs').send({ F: 10, C: 10001 });
    expect(res.status).toBe(400);
  });

  it('rejects string values', async () => {
    const app = createApp();
    const res = await request(app).post('/jobs').send({ F: 'ten', C: 'five' });
    expect(res.status).toBe(400);
  });
});

// ─── System routes ────────────────────────────────────────────────────────

describe('GET /system', () => {
  it('returns system stats', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        total: '3', generating: '0', queued: '1', running: '1',
        aggregating: '0', done: '1', failed: '0',
      }],
    });
    const app = createApp();
    const res = await request(app).get('/system');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('workers');
    expect(res.body).toHaveProperty('queueDepth');
    expect(res.body).toHaveProperty('jobStats');
    expect(res.body.queueDepth).toBe(3);
  });
});

describe('PATCH /system/workers', () => {
  it('accepts valid count', async () => {
    const app = createApp();
    const res = await request(app)
      .patch('/system/workers')
      .send({ count: 8 });
    expect(res.status).toBe(200);
    expect(res.body.targetWorkerCount).toBe(8);
  });

  it('rejects count > 20', async () => {
    const app = createApp();
    const res = await request(app)
      .patch('/system/workers')
      .send({ count: 25 });
    expect(res.status).toBe(400);
  });

  it('rejects count < 1', async () => {
    const app = createApp();
    const res = await request(app)
      .patch('/system/workers')
      .send({ count: 0 });
    expect(res.status).toBe(400);
  });
});

// ─── Internal routes ─────────────────────────────────────────────────────

describe('POST /internal/worker/heartbeat', () => {
  it('accepts valid idle heartbeat', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/internal/worker/heartbeat')
      .send({ workerId: 'w-123', status: 'idle' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('accepts busy heartbeat with task', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/internal/worker/heartbeat')
      .send({ workerId: 'w-123', status: 'busy', currentTaskId: 'task-456' });
    expect(res.status).toBe(200);
  });

  it('rejects invalid status', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/internal/worker/heartbeat')
      .send({ workerId: 'w-123', status: 'sleeping' });
    expect(res.status).toBe(400);
  });
});

describe('POST /internal/worker/register', () => {
  it('registers a worker', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        total: '0', generating: '0', queued: '0', running: '0',
        aggregating: '0', done: '0', failed: '0',
      }],
    });
    const app = createApp();
    const res = await request(app)
      .post('/internal/worker/register')
      .send({ workerId: 'w-123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /internal/worker/unregister', () => {
  it('unregisters a worker', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        total: '0', generating: '0', queued: '0', running: '0',
        aggregating: '0', done: '0', failed: '0',
      }],
    });
    const app = createApp();
    const res = await request(app)
      .post('/internal/worker/unregister')
      .send({ workerId: 'w-123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('Error handler', () => {
  it('handles unknown errors as 500', async () => {
    const app = express();
    app.get('/throw', () => { throw new Error('Unexpected error'); });
    app.use(errorHandler);
    const res = await request(app).get('/throw');
    expect(res.status).toBe(500);
  });
});
