# Distributed Mean - ITDs

| ITD 005 - Real-time UI Transport (WebSocket vs SSE) |  |
| :---- | :---- |
| **THE PROBLEM** | What transport should the UI use to receive live updates about worker status, job progress, and queue depth without polling? |
| **OPTIONS CONSIDERED (Decision in bold)** | **Server-Sent Events (SSE)** / WebSocket / Long-polling / Client polling (setInterval) |
| **REASONING** | SSE is unidirectional (server→client), which is exactly the requirement: dashboard consumes system state updates, never sends data back via the event stream. SSE is HTTP/1.1 compatible, works through proxies without special config, and has a built-in browser `EventSource` API with automatic reconnect. WebSocket is bidirectional — useful if the UI needed to send commands; we handle that via REST instead. Long-polling is inefficient. Client polling every 2s creates unnecessary load and has up-to-2s latency. |
| **TRADEOFFS** | SSE is HTTP-only (no binary frames). Limited to 6 concurrent connections per origin in HTTP/1.1 (non-issue for a single-tab dashboard). One SSE connection per browser tab. |
| **NOTES** | Events pushed: `worker_update`, `job_update`, `queue_depth`, `log`. API maintains a set of active SSE response streams and broadcasts to all on state changes. |
