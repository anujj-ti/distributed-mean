import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getSystemStats } from '../services/systemService.js';
import { addSSEClient, broadcast, broadcastLog } from '../lib/sse.js';

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

const PatchWorkersSchema = z.object({
  count: z.number().int().min(1).max(20),
});

// PATCH /system/workers — change target worker count (signals orchestrator)
router.patch('/workers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = PatchWorkersSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }
    const { count } = parsed.data;
    // Store desired count in Redis for orchestrators to pick up
    const { redis } = await import('../lib/redis.js');
    await redis.set('dmsystem:desired_workers', String(count));
    broadcastLog('info', `Worker count target set to ${count}`);
    res.json({ ok: true, targetWorkerCount: count });
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
