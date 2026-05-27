import { Response } from 'express';
import type { SSEEventType } from '../types/index.js';

const clients = new Set<Response>();

export function addSSEClient(res: Response): void {
  clients.add(res);
  res.on('close', () => {
    clients.delete(res);
  });
}

export function broadcast(event: SSEEventType): void {
  const data = JSON.stringify(event);
  const message = `data: ${data}\n\n`;
  for (const res of clients) {
    try {
      res.write(message);
    } catch {
      clients.delete(res);
    }
  }
}

export function broadcastLog(
  level: 'info' | 'warn' | 'error',
  message: string
): void {
  broadcast({
    type: 'log',
    level,
    message,
    timestamp: new Date().toISOString(),
  });
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[${level.toUpperCase()}] ${message}`);
}
