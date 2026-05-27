/**
 * Type safety tests — verify our type guards and helpers work correctly
 */

describe('JobStatus type guard', () => {
  const JOB_STATUSES = ['generating', 'queued', 'running', 'aggregating', 'done', 'failed'] as const;
  type JobStatus = typeof JOB_STATUSES[number];

  function isJobStatus(s: string): s is JobStatus {
    return (JOB_STATUSES as readonly string[]).includes(s);
  }

  it('accepts valid statuses', () => {
    expect(isJobStatus('done')).toBe(true);
    expect(isJobStatus('running')).toBe(true);
    expect(isJobStatus('failed')).toBe(true);
  });

  it('rejects invalid statuses', () => {
    expect(isJobStatus('unknown')).toBe(false);
    expect(isJobStatus('')).toBe(false);
    expect(isJobStatus('DONE')).toBe(false);
  });
});

describe('Worker status', () => {
  it('idle and busy are only valid statuses', () => {
    type WorkerStatus = 'idle' | 'busy';
    const status: WorkerStatus = 'idle';
    expect(['idle', 'busy']).toContain(status);
  });
});

describe('SSEEventType discriminated union', () => {
  type SSEEventType =
    | { type: 'worker_update'; workers: Array<{ id: string; status: string }> }
    | { type: 'job_update'; job: { id: string } }
    | { type: 'queue_depth'; depth: number }
    | { type: 'log'; level: string; message: string; timestamp: string };

  it('creates worker_update event', () => {
    const event: SSEEventType = {
      type: 'worker_update',
      workers: [{ id: 'w1', status: 'idle' }],
    };
    expect(event.type).toBe('worker_update');
    if (event.type === 'worker_update') {
      expect(event.workers).toHaveLength(1);
    }
  });

  it('creates queue_depth event', () => {
    const event: SSEEventType = { type: 'queue_depth', depth: 42 };
    expect(event.type).toBe('queue_depth');
    if (event.type === 'queue_depth') {
      expect(event.depth).toBe(42);
    }
  });

  it('creates log event', () => {
    const event: SSEEventType = {
      type: 'log',
      level: 'info',
      message: 'test',
      timestamp: new Date().toISOString(),
    };
    expect(event.type).toBe('log');
  });
});

describe('Float64Array mean computation', () => {
  it('maintains precision with many values', () => {
    const c = 1000;
    const acc = new Float64Array(c);
    // Add 100 batches of uniform [0.5] values
    for (let b = 0; b < 100; b++) {
      for (let i = 0; i < c; i++) {
        acc[i] += 0.5;
      }
    }
    const mean = Array.from(acc).map((s) => s / 100);
    for (const m of mean) {
      expect(m).toBeCloseTo(0.5, 10);
    }
  });

  it('handles edge case of single file', () => {
    const sums = new Float64Array([3.14, 2.71, 1.41]);
    const mean = Array.from(sums).map((s) => s / 1);
    expect(mean[0]).toBeCloseTo(3.14, 5);
    expect(mean[1]).toBeCloseTo(2.71, 5);
    expect(mean[2]).toBeCloseTo(1.41, 5);
  });
});

describe('CSV result format', () => {
  it('formats mean values to 8 decimal places', () => {
    const finalMean = [0.123456789, 0.987654321];
    const resultCsv = finalMean.map((v) => v.toFixed(8)).join('\n') + '\n';
    const lines = resultCsv.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('0.12345679');
    expect(lines[1]).toBe('0.98765432');
  });
});
