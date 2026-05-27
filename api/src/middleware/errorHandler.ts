import { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error('Unhandled error:', err);
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: 'Internal server error', message });
}
