# Real-Time Dashboard Architecture Research

## Question
Best approach for real-time distributed system dashboard: SSE vs WebSocket vs polling for React dashboard
showing worker status, queue depth, job progress. Visualizing worker speed differences, job timelines,
file processing rates. React + Recharts or alternatives for live updating charts.

## Recommendation: Server-Sent Events (SSE)

### SSE vs WebSocket vs Polling Comparison

| Feature | SSE | WebSocket | Polling |
|---------|-----|-----------|---------|
| Complexity | Low | Medium | Low |
| Protocol | HTTP/1.1 | WS upgrade | HTTP |
| Direction | Server→Client | Bidirectional | Client→Server |
| Browser support | Excellent | Excellent | N/A |
| Auto-reconnect | Built-in | Manual | N/A |
| HTTP/2 multiplex | Yes | No | N/A |
| Proxy/firewall | Works | Sometimes issues | Works |
| Express setup | 3 lines | Requires library | 3 lines |

### Why SSE for This Dashboard

1. **Unidirectional events**: Dashboard only needs server→client updates (job status, worker heartbeats, queue depth). No client→server streaming needed (form submissions are regular REST calls).

2. **Auto-reconnect**: Browser `EventSource` API reconnects automatically on disconnect — zero code.

3. **HTTP compatibility**: Works through all proxies, CDNs, load balancers that support HTTP/1.1 (unlike WebSocket upgrades which can fail).

4. **Simple Express implementation**:
```typescript
router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: SSEEvent) =>
    res.write(`data: ${JSON.stringify(event)}\n\n`);

  const cleanup = eventBus.subscribe(send);
  req.on('close', cleanup);
});
```

5. **In-memory event bus**: No Redis pub/sub needed for small worker counts (< 100 workers). Simple EventEmitter pattern.

### SSE Event Schema

```typescript
type SSEEventType =
  | 'worker_status'      // Worker came online/offline/busy/idle
  | 'task_started'       // Worker picked up a task
  | 'task_completed'     // Worker completed a task (with timing)
  | 'job_created'        // New job submitted
  | 'job_completed'      // Job finished with result
  | 'queue_depth'        // Current queue depth (every 2s)
  | 'log'               // Free-form log message
  | 'heartbeat'         // Keep-alive (every 15s)

interface SSEEvent {
  type: SSEEventType;
  timestamp: string;    // ISO 8601
  data: unknown;        // Event-specific payload
}
```

## Chart Library: Recharts

### Recharts vs Alternatives

| Library | Bundle | API | Perf | Notes |
|---------|--------|-----|------|-------|
| Recharts | ~300KB | Declarative, React-native | Good | Best for React, composable |
| Chart.js | ~200KB | Imperative | Good | Canvas-based, but verbose with React |
| Victory | ~400KB | Declarative, React | OK | Heavier, less maintained |
| D3 | ~230KB | Low-level | Excellent | Too low-level for dashboard components |
| Nivo | ~500KB | Declarative | Good | Beautiful but heavy |
| Visx | modular | Low-level | Excellent | Best perf, highest complexity |

**Recommendation: Recharts** for this project:
- Perfect React component composition model
- `<LineChart>`, `<AreaChart>`, `<BarChart>` work out of the box
- `<ResponsiveContainer>` handles resize automatically
- TypeScript support built-in
- Lightweight enough for 5 charts on one page

### Live Update Pattern with Recharts

```tsx
const WINDOW_MS = 120_000; // 2 minutes

function QueueDepthChart() {
  const [data, setData] = useState<{ t: number; depth: number }[]>([]);

  useEffect(() => {
    const es = new EventSource('/events');
    es.addEventListener('queue_depth', (e) => {
      const { depth } = JSON.parse(e.data);
      const now = Date.now();
      setData(prev => [
        ...prev.filter(p => now - p.t < WINDOW_MS),
        { t: now, depth }
      ]);
    });
    return () => es.close();
  }, []);

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={data}>
        <XAxis dataKey="t" type="number" scale="time" tickFormatter={formatTime} />
        <YAxis />
        <Area dataKey="depth" stroke="#6366f1" fill="#6366f1" fillOpacity={0.1} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
```

## Dashboard Component Architecture

```
App
├── SystemStats          # Cards: workers, queue depth, active jobs, completed jobs
├── WorkerFleet          # Grid of WorkerCard components
│   └── WorkerCard       # Status, current task, speed sparkline
├── Charts
│   ├── QueueDepthChart  # SSE 'queue_depth' events, 2-min window
│   └── WorkerSpeedChart # SSE 'task_completed' events, files/sec per worker
├── JobsTable            # REST-polled, expandable rows
│   └── TaskBreakdown    # Per-task: worker, duration, files
├── JobSubmitForm        # POST /jobs, shows real-time progress after submit
└── LogFeed              # SSE 'log' + 'task_*' events, 200 entry ring buffer
```

## Worker Speed Visualization

Workers have different speeds via `WORKER_SLOWNESS` env var. Visualize:

```tsx
// Speed metric: files processed per second (rolling average)
type WorkerSpeedMetric = {
  workerId: string;
  filesPerSec: number;  // rolling 30s average
  tasksCompleted: number;
  currentTask: string | null;
  status: 'idle' | 'busy' | 'offline';
};

// Mini sparkline per worker (last 10 task durations)
function WorkerSpeedSparkline({ durations }: { durations: number[] }) {
  return (
    <Sparklines data={durations} width={80} height={30}>
      <SparklinesLine color="#6366f1" />
    </Sparklines>
  );
}
```

## Tech Stack for Dashboard

```json
{
  "react": "18",
  "typescript": "5",
  "vite": "5",
  "tailwindcss": "3",
  "recharts": "2",
  "react-sparklines": "1",
  "@tanstack/react-query": "5",
  "react-hot-toast": "2"
}
```

- **Tailwind**: Utility classes for rapid layout, dark mode optional
- **React Query**: REST endpoint polling (jobs table, system stats every 5s)
- **EventSource**: SSE for real-time events (worker status, logs, queue depth)
- **react-hot-toast**: Job completion notifications

## nginx Dockerfile for Production

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json .
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

```nginx
# nginx.conf — proxy /api and /events to API service
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;

  location /api/ {
    proxy_pass http://api:3000/;
    proxy_buffering off;  # Critical for SSE
  }

  location /events {
    proxy_pass http://api:3000/events;
    proxy_buffering off;          # No buffering for SSE
    proxy_cache off;
    proxy_set_header Connection '';
    proxy_http_version 1.1;
    chunked_transfer_encoding on;
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

## Summary

| Decision | Choice | Reason |
|----------|--------|--------|
| Real-time protocol | SSE | Unidirectional, auto-reconnect, HTTP-compatible |
| Chart library | Recharts | React-native, composable, TypeScript |
| State management | React hooks + React Query | Simple, no Redux needed |
| Live data window | 2 minutes | Sufficient for monitoring, manageable state |
| Log buffer | 200 entries ring | Avoid memory growth |
| Build tool | Vite | Fast HMR, ESM-native |
| Styling | Tailwind CSS | Rapid prototyping, consistent design |
