import express from 'express';
import path from 'path';
import { initSchema } from './db/index.js';
import { connectRedis } from './lib/redis.js';
import { ensureBucket } from './lib/storage.js';
import jobsRouter from './routes/jobs.js';
import systemRouter, { sseHandler } from './routes/system.js';
import internalRouter from './routes/internal.js';
import { errorHandler } from './middleware/errorHandler.js';
import { startReaper } from './services/reaperService.js';
import { broadcastLog } from './lib/sse.js';

const PORT = Number(process.env['PORT'] ?? 3000);

async function main(): Promise<void> {
  // Connect to dependencies
  await connectRedis();
  await initSchema();
  await ensureBucket();

  const app = express();

  app.use(express.json({ limit: '10mb' }));

  // CORS
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (_req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // API routes
  app.use('/jobs', jobsRouter);
  app.use('/system', systemRouter);
  app.get('/events', sseHandler); // convenience alias for /system/events
  app.use('/internal', internalRouter);

  // Serve UI (static files from /ui at root)
  const uiPath = process.env['UI_PATH'] ?? path.join(process.cwd(), '..', 'ui');
  app.use(express.static(uiPath));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(uiPath, 'index.html'));
  });

  // Error handler
  app.use(errorHandler);

  app.listen(PORT, () => {
    console.log(`API listening on http://0.0.0.0:${PORT}`);
    broadcastLog('info', `API started on port ${PORT}`);
    startReaper();
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
