import { Router, Request, Response, NextFunction } from 'express';
import { getSystemStats } from '../services/systemService.js';
import { addSSEClient, broadcast } from '../lib/sse.js';

const router = Router();

// GET /system — system stats
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = await getSystemStats();
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

// GET /system/events — SSE stream
router.get('/events', sseHandler);

export function sseHandler(req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');

  // Send current stats immediately
  getSystemStats()
    .then((stats) => {
      broadcast({ type: 'worker_update', workers: stats.workers });
      broadcast({ type: 'queue_depth', depth: stats.queueDepth });
    })
    .catch(() => {});

  addSSEClient(res);

  // Keep-alive ping every 15s
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15_000);

  req.on('close', () => {
    clearInterval(keepAlive);
  });
}

export default router;
