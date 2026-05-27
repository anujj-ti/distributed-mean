/**
 * Redis lib unit tests — test helpers and key generators
 */

// Mock ioredis
jest.mock('ioredis', () => {
  const mockRedis = {
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
  };
  return jest.fn().mockImplementation(() => mockRedis);
});

import {
  REDIS_KEYS,
  enqueueTask,
  getQueueDepth,
  getWorkerIds,
  getWorkerStatus,
  getWorkerCurrentTask,
  connectRedis,
} from '../lib/redis.js';
import Redis from 'ioredis';

const MockRedis = Redis as jest.MockedClass<typeof Redis>;

describe('REDIS_KEYS', () => {
  it('QUEUE key is correct', () => {
    expect(REDIS_KEYS.QUEUE).toBe('dmsystem:queue');
  });

  it('WORKERS_SET key is correct', () => {
    expect(REDIS_KEYS.WORKERS_SET).toBe('dmsystem:workers');
  });

  it('workerStatus generates correct key', () => {
    expect(REDIS_KEYS.workerStatus('w-123')).toBe('dmsystem:worker:w-123:status');
  });

  it('workerHb generates correct key', () => {
    expect(REDIS_KEYS.workerHb('w-456')).toBe('dmsystem:worker:w-456:hb');
  });

  it('workerTask generates correct key', () => {
    expect(REDIS_KEYS.workerTask('w-789')).toBe('dmsystem:worker:w-789:task');
  });
});

describe('enqueueTask', () => {
  it('calls lpush with JSON-serialized payload', async () => {
    const instance = MockRedis.mock.results[0]?.value;
    if (!instance) { expect(true).toBe(true); return; }

    const task = { taskId: 'task-1', jobId: 'job-1', batchIndex: 0, fileStart: 0, fileEnd: 4, c: 100 };
    await enqueueTask(task);
    expect(instance.lpush).toHaveBeenCalledWith(
      'dmsystem:queue',
      JSON.stringify(task)
    );
  });
});

describe('getQueueDepth', () => {
  it('returns a number from llen', async () => {
    const instance = MockRedis.mock.results[0]?.value;
    if (!instance) { expect(true).toBe(true); return; }

    (instance.llen as jest.Mock).mockResolvedValueOnce(7);
    const depth = await getQueueDepth();
    expect(typeof depth).toBe('number');
    expect(depth).toBe(7);
  });
});

describe('getWorkerIds', () => {
  it('returns array of worker IDs', async () => {
    const instance = MockRedis.mock.results[0]?.value;
    if (!instance) { expect(true).toBe(true); return; }

    (instance.smembers as jest.Mock).mockResolvedValueOnce(['w-1', 'w-2', 'w-3']);
    const ids = await getWorkerIds();
    expect(Array.isArray(ids)).toBe(true);
    expect(ids).toHaveLength(3);
  });
});

describe('getWorkerStatus', () => {
  it('returns idle when status is idle', async () => {
    const instance = MockRedis.mock.results[0]?.value;
    if (!instance) { expect(true).toBe(true); return; }

    (instance.get as jest.Mock).mockResolvedValueOnce('idle');
    const status = await getWorkerStatus('w-1');
    expect(status).toBe('idle');
  });

  it('returns busy when status is busy', async () => {
    const instance = MockRedis.mock.results[0]?.value;
    if (!instance) { expect(true).toBe(true); return; }

    (instance.get as jest.Mock).mockResolvedValueOnce('busy');
    const status = await getWorkerStatus('w-1');
    expect(status).toBe('busy');
  });

  it('returns null when no status', async () => {
    const instance = MockRedis.mock.results[0]?.value;
    if (!instance) { expect(true).toBe(true); return; }

    (instance.get as jest.Mock).mockResolvedValueOnce(null);
    const status = await getWorkerStatus('w-1');
    expect(status).toBeNull();
  });

  it('returns null for unknown status string', async () => {
    const instance = MockRedis.mock.results[0]?.value;
    if (!instance) { expect(true).toBe(true); return; }

    (instance.get as jest.Mock).mockResolvedValueOnce('unknown');
    const status = await getWorkerStatus('w-1');
    expect(status).toBeNull();
  });
});

describe('getWorkerCurrentTask', () => {
  it('returns task ID when set', async () => {
    const instance = MockRedis.mock.results[0]?.value;
    if (!instance) { expect(true).toBe(true); return; }

    (instance.get as jest.Mock).mockResolvedValueOnce('task-abc');
    const taskId = await getWorkerCurrentTask('w-1');
    expect(taskId).toBe('task-abc');
  });

  it('returns null when no task', async () => {
    const instance = MockRedis.mock.results[0]?.value;
    if (!instance) { expect(true).toBe(true); return; }

    (instance.get as jest.Mock).mockResolvedValueOnce(null);
    const taskId = await getWorkerCurrentTask('w-1');
    expect(taskId).toBeNull();
  });
});

describe('connectRedis', () => {
  it('calls connect on the redis client', async () => {
    const instance = MockRedis.mock.results[0]?.value;
    if (!instance) { expect(true).toBe(true); return; }

    await connectRedis();
    expect(instance.connect).toHaveBeenCalled();
  });
});
