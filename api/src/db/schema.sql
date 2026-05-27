-- Distributed Mean — Database Schema
-- Compatible with PostgreSQL 14+ and Supabase

CREATE TABLE IF NOT EXISTS jobs (
    id                UUID PRIMARY KEY,
    f                 INTEGER NOT NULL CHECK (f > 1 AND f <= 100000),
    c                 INTEGER NOT NULL CHECK (c > 0 AND c <= 10000),
    status            VARCHAR(20) NOT NULL DEFAULT 'generating'
                      CHECK (status IN ('generating','queued','running','aggregating','done','failed')),
    batch_count       INTEGER NOT NULL,
    completed_batches INTEGER NOT NULL DEFAULT 0,
    result_path       TEXT,
    error             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
    id            UUID PRIMARY KEY,
    job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    batch_index   INTEGER NOT NULL,
    file_start    INTEGER NOT NULL,
    file_end      INTEGER NOT NULL,
    status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','done','failed')),
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
