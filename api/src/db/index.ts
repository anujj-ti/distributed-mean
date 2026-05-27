import { Pool, PoolClient } from 'pg';

const pool = new Pool({
  connectionString: process.env['DATABASE_URL'] ?? 'postgresql://dm:dm@localhost:5432/dm',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const db = {
  query: pool.query.bind(pool),
  connect: () => pool.connect(),
  pool,
};

export type { PoolClient };

export async function initSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id            UUID PRIMARY KEY,
      f             INTEGER NOT NULL,
      c             INTEGER NOT NULL,
      status        VARCHAR(20) NOT NULL DEFAULT 'generating',
      batch_count   INTEGER NOT NULL,
      completed_batches INTEGER NOT NULL DEFAULT 0,
      result_path   TEXT,
      error         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at  TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id            UUID PRIMARY KEY,
      job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      batch_index   INTEGER NOT NULL,
      file_start    INTEGER NOT NULL,
      file_end      INTEGER NOT NULL,
      status        VARCHAR(20) NOT NULL DEFAULT 'pending',
      worker_id     TEXT,
      started_at    TIMESTAMPTZ,
      completed_at  TIMESTAMPTZ,
      error         TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_job_id ON tasks(job_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

    CREATE TABLE IF NOT EXISTS partial_results (
      id          UUID PRIMARY KEY,
      job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      sums        FLOAT8[] NOT NULL,
      count       INTEGER NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_partial_results_job_id ON partial_results(job_id);
  `);
}
