export type JobStatus =
  | 'generating'
  | 'queued'
  | 'running'
  | 'aggregating'
  | 'done'
  | 'failed';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  f: number;
  c: number;
  status: JobStatus;
  batchCount: number;
  completedBatches: number;
  resultPath: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface Task {
  id: string;
  jobId: string;
  batchIndex: number;
  fileStart: number;
  fileEnd: number;
  status: TaskStatus;
  workerId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
}

export interface TaskMessage {
  taskId: string;
  jobId: string;
  batchIndex: number;
  fileStart: number;
  fileEnd: number;
  c: number;
}

export interface WorkerInfo {
  id: string;
  status: 'idle' | 'busy';
  currentTaskId: string | null;
}

export interface SystemStats {
  workers: WorkerInfo[];
  workerCount: number;
  idleWorkers: number;
  busyWorkers: number;
  queueDepth: number;
  jobStats: {
    total: number;
    generating: number;
    queued: number;
    running: number;
    aggregating: number;
    done: number;
    failed: number;
  };
}

export type SSEEventType =
  | { type: 'worker_update'; workers: WorkerInfo[] }
  | { type: 'job_update'; job: Partial<Job> & { id: string } }
  | { type: 'queue_depth'; depth: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; timestamp: string };
