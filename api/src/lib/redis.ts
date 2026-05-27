import Redis from 'ioredis';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const QUEUE_KEY = 'dmsystem:queue';
const DLQ_KEY = 'dmsystem:dlq';
const WORKERS_SET = 'dmsystem:workers';

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

export const redisSubscriber = new Redis(REDIS_URL, {
  lazyConnect: true,
});

export const REDIS_KEYS = {
  QUEUE: QUEUE_KEY,
  DLQ: DLQ_KEY,
  WORKERS_SET,
  workerStatus: (id: string) => `dmsystem:worker:${id}:status`,
  workerHb: (id: string) => `dmsystem:worker:${id}:hb`,
  workerTask: (id: string) => `dmsystem:worker:${id}:task`,
} as const;

export async function connectRedis(): Promise<void> {
  await redis.connect();
}

export async function enqueueTask(payload: object): Promise<void> {
  await redis.lpush(QUEUE_KEY, JSON.stringify(payload));
}

export async function getQueueDepth(): Promise<number> {
  return redis.llen(QUEUE_KEY);
}

export async function getWorkerIds(): Promise<string[]> {
  return redis.smembers(WORKERS_SET);
}

export async function getWorkerStatus(id: string): Promise<'idle' | 'busy' | null> {
  const status = await redis.get(REDIS_KEYS.workerStatus(id));
  if (status === 'idle' || status === 'busy') return status;
  return null;
}

export async function getWorkerCurrentTask(id: string): Promise<string | null> {
  return redis.get(REDIS_KEYS.workerTask(id));
}
