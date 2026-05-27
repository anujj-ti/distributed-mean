import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { createJob, getJob, listJobs, getTasksForJob } from '../services/jobService.js';
import { getObject } from '../lib/storage.js';

const router = Router();

const CreateJobSchema = z.object({
  F: z.number().int().min(2).max(100_000),
  C: z.number().int().min(1).max(10_000),
});

// POST /jobs — create a new job
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = CreateJobSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }
    const { F, C } = parsed.data;
    const job = await createJob(F, C);
    res.status(202).json({
      jobId: job.id,
      f: job.f,
      c: job.c,
      status: job.status,
      batchCount: job.batchCount,
      createdAt: job.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

// GET /jobs — list all jobs
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const jobs = await listJobs();
    res.json({ jobs });
  } catch (err) {
    next(err);
  }
});

// GET /jobs/:id — get job status
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await getJob(req.params['id']!);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json(job);
  } catch (err) {
    next(err);
  }
});

// GET /jobs/:id/result — stream result CSV
router.get('/:id/result', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await getJob(req.params['id']!);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (job.status !== 'done' || !job.resultPath) {
      res.status(409).json({ error: 'Job not done yet', status: job.status });
      return;
    }
    const stream = await getObject(job.resultPath);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="result-${job.id}.csv"`);
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

// GET /jobs/:id/tasks — list tasks for a job
router.get('/:id/tasks', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await getJob(req.params['id']!);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const tasks = await getTasksForJob(job.id);
    res.json({ tasks });
  } catch (err) {
    next(err);
  }
});

export default router;
