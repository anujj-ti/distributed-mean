# DESIGN-004: UI Real-Time Data Flow

## Overview
The dashboard subscribes to a Server-Sent Events (SSE) stream for live updates on workers, jobs, and queue depth.

## Event Types

```typescript
type SSEEvent =
  | { type: 'worker_update'; workers: WorkerStatus[] }
  | { type: 'job_update'; job: JobSummary }
  | { type: 'queue_depth'; depth: number }
  | { type: 'log'; level: 'info'|'warn'|'error'; message: string; timestamp: string };
```

## API SSE Endpoint

`GET /events` — Returns `text/event-stream`.

The API maintains a set of active SSE response streams. Any state change (worker status, job update, new task enqueued) triggers a broadcast to all connected clients.

## Dashboard Components
1. **Workers Panel** — Grid of worker cards: ID, status (green=idle, amber=busy), current task
2. **Queue Panel** — Current depth, throughput (tasks/min)
3. **Jobs Table** — All jobs with status badge, progress bar (completed/total batches), time elapsed
4. **Log Stream** — Scrolling tail of recent events
5. **New Job Form** — F and C inputs, submit button
