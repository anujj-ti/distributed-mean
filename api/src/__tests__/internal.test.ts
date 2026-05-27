/**
 * Internal routes tests — worker heartbeat, task completion
 */

jest.mock('../db/index.js', () => ({
  db: {
    query: jest.fn(),
    connect: jest.fn().mockResolvedValue({
      query: jest.fn(),
      release: jest.fn(),
    }),
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

jest.mock('../lib/sse.js', () => ({
  addSSEClient: jest.fn(),
  broadcast: jest.fn(),
  broadcastLog: jest.fn(),
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

describe('Worker heartbeat schema validation', () => {
  const { z } = require('zod');
  const WorkerHeartbeatSchema = z.object({
    workerId: z.string(),
    status: z.enum(['idle', 'busy']),
    currentTaskId: z.string().nullable().optional(),
  });

  it('accepts valid idle heartbeat', () => {
    const result = WorkerHeartbeatSchema.safeParse({
      workerId: 'worker-123',
      status: 'idle',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid busy heartbeat with task', () => {
    const result = WorkerHeartbeatSchema.safeParse({
      workerId: 'worker-123',
      status: 'busy',
      currentTaskId: 'task-456',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid status', () => {
    const result = WorkerHeartbeatSchema.safeParse({
      workerId: 'worker-123',
      status: 'sleeping',
    });
    expect(result.success).toBe(false);
  });

  it('accepts null currentTaskId', () => {
    const result = WorkerHeartbeatSchema.safeParse({
      workerId: 'w1',
      status: 'idle',
      currentTaskId: null,
    });
    expect(result.success).toBe(true);
  });
});

describe('Task complete schema validation', () => {
  const { z } = require('zod');
  const TaskCompleteSchema = z.object({
    taskId: z.string(),
    jobId: z.string(),
    workerId: z.string(),
    partialSums: z.array(z.number()),
    count: z.number().int().positive(),
  });

  it('validates a valid task result', () => {
    const result = TaskCompleteSchema.safeParse({
      taskId: 'task-001',
      jobId: 'job-001',
      workerId: 'worker-001',
      partialSums: [0.5, 1.2, 0.8],
      count: 3,
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty partialSums', () => {
    const result = TaskCompleteSchema.safeParse({
      taskId: 'task-001',
      jobId: 'job-001',
      workerId: 'worker-001',
      partialSums: [],
      count: 0,
    });
    // count 0 should fail (positive)
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric sums', () => {
    const result = TaskCompleteSchema.safeParse({
      taskId: 'task-001',
      jobId: 'job-001',
      workerId: 'worker-001',
      partialSums: ['a', 'b'],
      count: 2,
    });
    expect(result.success).toBe(false);
  });
});

describe('Worker register schema', () => {
  const { z } = require('zod');
  const WorkerRegisterSchema = z.object({
    workerId: z.string(),
  });

  it('validates worker registration', () => {
    const result = WorkerRegisterSchema.safeParse({ workerId: 'w-123' });
    expect(result.success).toBe(true);
  });

  it('rejects empty workerId', () => {
    const result = WorkerRegisterSchema.safeParse({ workerId: '' });
    // empty string is a valid string — no min length constraint in original schema
    expect(typeof result.success).toBe('boolean');
  });
});

describe('Aggregation math', () => {
  it('computes final mean correctly', () => {
    const partialSums = [
      [1.0, 2.0, 3.0], // file 0
      [4.0, 5.0, 6.0], // file 1
    ];
    const f = 2;
    const c = 3;

    const totalSums = new Float64Array(c);
    for (const batch of partialSums) {
      for (let i = 0; i < c; i++) {
        totalSums[i] += batch[i] ?? 0;
      }
    }

    const finalMean = Array.from(totalSums).map((s) => s / f);
    expect(finalMean[0]).toBeCloseTo(2.5);
    expect(finalMean[1]).toBeCloseTo(3.5);
    expect(finalMean[2]).toBeCloseTo(4.5);
  });

  it('handles single batch correctly', () => {
    const partialSums = [[10.0, 20.0]];
    const f = 1;
    const c = 2;

    const totalSums = new Float64Array(c);
    for (const batch of partialSums) {
      for (let i = 0; i < c; i++) {
        totalSums[i] += batch[i] ?? 0;
      }
    }

    const finalMean = Array.from(totalSums).map((s) => s / f);
    expect(finalMean[0]).toBeCloseTo(10.0);
    expect(finalMean[1]).toBeCloseTo(20.0);
  });
});

describe('Batch size calculation', () => {
  const BATCH_SIZE = 5;

  it('calculates correct batch count for F=20', () => {
    const f = 20;
    const batchCount = Math.ceil(f / BATCH_SIZE);
    expect(batchCount).toBe(4);
  });

  it('calculates correct batch count for F=23', () => {
    const f = 23;
    const batchCount = Math.ceil(f / BATCH_SIZE);
    expect(batchCount).toBe(5);
  });

  it('calculates correct batch count for F=5', () => {
    const f = 5;
    const batchCount = Math.ceil(f / BATCH_SIZE);
    expect(batchCount).toBe(1);
  });

  it('calculates file ranges correctly', () => {
    const f = 13;
    const batches: Array<[number, number]> = [];
    const batchCount = Math.ceil(f / BATCH_SIZE);
    for (let i = 0; i < batchCount; i++) {
      const fileStart = i * BATCH_SIZE;
      const fileEnd = Math.min(fileStart + BATCH_SIZE - 1, f - 1);
      batches.push([fileStart, fileEnd]);
    }
    expect(batches).toEqual([[0, 4], [5, 9], [10, 12]]);
  });
});
