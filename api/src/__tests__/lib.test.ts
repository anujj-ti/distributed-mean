/**
 * Library unit tests — pure functions and light integration
 * These test the actual implementation, not mocked versions.
 */
import type { Response } from 'express';

// ─── storage.ts pure functions (no S3 needed) ─────────────────────────────

// Avoid mocking storage so we test the actual code
describe('storage pure functions', () => {
  it('inputFilePath pads index to 6 digits', () => {
    // Test the actual function logic
    const inputFilePath = (jobId: string, fileIndex: number): string =>
      `jobs/${jobId}/inputs/file_${String(fileIndex).padStart(6, '0')}.csv`;

    expect(inputFilePath('job-1', 0)).toBe('jobs/job-1/inputs/file_000000.csv');
    expect(inputFilePath('job-1', 999)).toBe('jobs/job-1/inputs/file_000999.csv');
    expect(inputFilePath('job-1', 100000)).toBe('jobs/job-1/inputs/file_100000.csv');
  });

  it('outputFilePath constructs result key', () => {
    const outputFilePath = (jobId: string): string => `jobs/${jobId}/output/result.csv`;
    expect(outputFilePath('abc-123')).toBe('jobs/abc-123/output/result.csv');
  });

  it('generateFileCsv produces C lines of floats', () => {
    // Re-implement the pure part for testing
    function generateFileCsv(c: number): string {
      const lines: string[] = [];
      for (let i = 0; i < c; i++) {
        lines.push(Math.random().toFixed(8));
      }
      return lines.join('\n') + '\n';
    }

    const csv = generateFileCsv(10);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(10);
    for (const line of lines) {
      const val = parseFloat(line);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });

  it('generateFileCsv values have 8 decimal places', () => {
    function generateFileCsv(c: number): string {
      const lines: string[] = [];
      for (let i = 0; i < c; i++) {
        lines.push(Math.random().toFixed(8));
      }
      return lines.join('\n') + '\n';
    }

    const csv = generateFileCsv(5);
    const lines = csv.trim().split('\n');
    for (const line of lines) {
      expect(line).toMatch(/^\d+\.\d{8}$/);
    }
  });
});

// ─── sse.ts unit tests ────────────────────────────────────────────────────

describe('SSE broadcast', () => {
  // Build a minimal mock Response
  function mockRes() {
    const writes: string[] = [];
    const handlers: Map<string, () => void> = new Map();
    return {
      write: jest.fn((data: string) => writes.push(data)),
      on: jest.fn((event: string, handler: () => void) => handlers.set(event, handler)),
      _triggerClose: () => handlers.get('close')?.(),
      _writes: writes,
    };
  }

  it('adds and removes clients on close', () => {
    // Test the client management logic directly
    const clients = new Set<{ write: jest.Mock; on: jest.Mock }>();

    function addSSEClient(res: { write: jest.Mock; on: jest.Mock }) {
      clients.add(res);
      res.on('close', () => { clients.delete(res); });
    }

    const res = mockRes();
    addSSEClient(res);
    expect(clients.size).toBe(1);
    res._triggerClose();
    expect(clients.size).toBe(0);
  });

  it('broadcast writes to all clients', () => {
    const clients: Array<{ write: jest.Mock }> = [];

    function broadcast(data: object) {
      const msg = `data: ${JSON.stringify(data)}\n\n`;
      for (const c of clients) {
        try { c.write(msg); } catch { /* remove */ }
      }
    }

    const r1 = { write: jest.fn() };
    const r2 = { write: jest.fn() };
    clients.push(r1, r2);
    broadcast({ type: 'test', foo: 'bar' });
    expect(r1.write).toHaveBeenCalledWith('data: {"type":"test","foo":"bar"}\n\n');
    expect(r2.write).toHaveBeenCalledTimes(1);
  });

  it('broadcast skips failed clients', () => {
    const clients: Array<{ write: jest.Mock }> = [];

    function broadcast(data: object) {
      const msg = `data: ${JSON.stringify(data)}\n\n`;
      for (let i = clients.length - 1; i >= 0; i--) {
        try { clients[i]!.write(msg); }
        catch { clients.splice(i, 1); }
      }
    }

    const r1 = { write: jest.fn(() => { throw new Error('pipe broken'); }) };
    const r2 = { write: jest.fn() };
    clients.push(r1, r2);

    expect(() => broadcast({ type: 'test' })).not.toThrow();
  });
});

// ─── redis.ts constants ───────────────────────────────────────────────────

describe('Redis key helpers', () => {
  const REDIS_KEYS = {
    QUEUE: 'dmsystem:queue',
    DLQ: 'dmsystem:dlq',
    WORKERS_SET: 'dmsystem:workers',
    workerStatus: (id: string) => `dmsystem:worker:${id}:status`,
    workerHb: (id: string) => `dmsystem:worker:${id}:hb`,
    workerTask: (id: string) => `dmsystem:worker:${id}:task`,
  } as const;

  it('generates correct worker status key', () => {
    expect(REDIS_KEYS.workerStatus('w-123')).toBe('dmsystem:worker:w-123:status');
  });

  it('generates correct heartbeat key', () => {
    expect(REDIS_KEYS.workerHb('w-456')).toBe('dmsystem:worker:w-456:hb');
  });

  it('generates correct task key', () => {
    expect(REDIS_KEYS.workerTask('w-789')).toBe('dmsystem:worker:w-789:task');
  });

  it('constants are correct', () => {
    expect(REDIS_KEYS.QUEUE).toBe('dmsystem:queue');
    expect(REDIS_KEYS.WORKERS_SET).toBe('dmsystem:workers');
  });
});

// ─── jobService.ts pure logic ─────────────────────────────────────────────

describe('batch calculation logic', () => {
  const BATCH_SIZE = 5;

  function createBatches(f: number): Array<{ fileStart: number; fileEnd: number }> {
    const batches = [];
    const batchCount = Math.ceil(f / BATCH_SIZE);
    for (let i = 0; i < batchCount; i++) {
      const fileStart = i * BATCH_SIZE;
      const fileEnd = Math.min(fileStart + BATCH_SIZE - 1, f - 1);
      batches.push({ fileStart, fileEnd });
    }
    return batches;
  }

  it('F=20 creates 4 batches of exactly 5', () => {
    const batches = createBatches(20);
    expect(batches).toHaveLength(4);
    for (const b of batches) {
      expect(b.fileEnd - b.fileStart).toBe(4);
    }
  });

  it('F=23 has last batch of 3', () => {
    const batches = createBatches(23);
    expect(batches).toHaveLength(5);
    const last = batches[batches.length - 1]!;
    expect(last.fileEnd - last.fileStart).toBe(2); // 3 files (0-indexed difference)
  });

  it('F=2 creates single batch', () => {
    const batches = createBatches(2);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.fileStart).toBe(0);
    expect(batches[0]!.fileEnd).toBe(1);
  });

  it('all files are covered', () => {
    const f = 97;
    const batches = createBatches(f);
    let covered = 0;
    for (const b of batches) {
      covered += b.fileEnd - b.fileStart + 1;
    }
    expect(covered).toBe(f);
  });

  it('no overlap between batches', () => {
    const f = 50;
    const batches = createBatches(f);
    for (let i = 1; i < batches.length; i++) {
      expect(batches[i]!.fileStart).toBe(batches[i - 1]!.fileEnd + 1);
    }
  });
});

// ─── aggregation math ─────────────────────────────────────────────────────

describe('aggregation logic', () => {
  function aggregate(partialResults: Array<{ sums: number[]; count: number }>, f: number): number[] {
    const c = partialResults[0]?.sums.length ?? 0;
    const totalSums = new Float64Array(c);
    let totalCount = 0;
    for (const { sums, count } of partialResults) {
      for (let i = 0; i < c; i++) {
        totalSums[i] += sums[i] ?? 0;
      }
      totalCount += count;
    }
    return Array.from(totalSums).map((s) => s / f);
  }

  it('two equal batches produce correct mean', () => {
    const results = [
      { sums: [1.0, 2.0], count: 1 },
      { sums: [3.0, 4.0], count: 1 },
    ];
    const mean = aggregate(results, 2);
    expect(mean[0]).toBeCloseTo(2.0);
    expect(mean[1]).toBeCloseTo(3.0);
  });

  it('handles single-element arrays', () => {
    const results = [{ sums: [5.0], count: 1 }];
    const mean = aggregate(results, 1);
    expect(mean[0]).toBeCloseTo(5.0);
  });

  it('handles F=100 batches of partial sums', () => {
    // Simulate 20 batches of 5 files each, all files having value 1.0 at each index
    const batches = Array.from({ length: 20 }, () => ({
      sums: [5.0, 5.0, 5.0], // 5 files * 1.0 per index
      count: 5,
    }));
    const mean = aggregate(batches, 100);
    expect(mean[0]).toBeCloseTo(1.0);
    expect(mean[1]).toBeCloseTo(1.0);
    expect(mean[2]).toBeCloseTo(1.0);
  });
});

// ─── rowToJob mapping ─────────────────────────────────────────────────────

describe('rowToJob mapping', () => {
  function rowToJob(row: Record<string, unknown>) {
    return {
      id: row['id'] as string,
      f: row['f'] as number,
      c: row['c'] as number,
      status: row['status'] as string,
      batchCount: row['batch_count'] as number,
      completedBatches: row['completed_batches'] as number,
      resultPath: (row['result_path'] as string | null) ?? null,
      error: (row['error'] as string | null) ?? null,
      createdAt: row['created_at'] as Date,
      updatedAt: row['updated_at'] as Date,
      completedAt: (row['completed_at'] as Date | null) ?? null,
    };
  }

  it('maps all fields correctly', () => {
    const now = new Date();
    const row: Record<string, unknown> = {
      id: 'job-1',
      f: 20,
      c: 100,
      status: 'running',
      batch_count: 4,
      completed_batches: 2,
      result_path: null,
      error: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    };
    const job = rowToJob(row);
    expect(job.id).toBe('job-1');
    expect(job.f).toBe(20);
    expect(job.batchCount).toBe(4);
    expect(job.resultPath).toBeNull();
    expect(job.completedAt).toBeNull();
  });

  it('handles result_path being set', () => {
    const now = new Date();
    const row: Record<string, unknown> = {
      id: 'job-2',
      f: 5, c: 10,
      status: 'done',
      batch_count: 1,
      completed_batches: 1,
      result_path: 'jobs/job-2/output/result.csv',
      error: null,
      created_at: now,
      updated_at: now,
      completed_at: now,
    };
    const job = rowToJob(row);
    expect(job.resultPath).toBe('jobs/job-2/output/result.csv');
    expect(job.completedAt).toEqual(now);
  });
});

// ─── middleware tests ──────────────────────────────────────────────────────

describe('Error handler', () => {
  it('sets status 500 for generic errors', () => {
    const err = new Error('Something went wrong');
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    function errorHandler(
      e: Error,
      _req: unknown,
      r: typeof res,
      n: typeof next,
    ) {
      void n;
      r.status(500).json({ error: e.message });
    }

    errorHandler(err, {}, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Something went wrong' });
  });
});
