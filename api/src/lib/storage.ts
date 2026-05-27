import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';

const BUCKET = process.env['MINIO_BUCKET'] ?? 'distributed-mean';

export const s3 = new S3Client({
  endpoint: process.env['MINIO_ENDPOINT'] ?? 'http://localhost:9000',
  region: process.env['AWS_REGION'] ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? 'minioadmin',
    secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'minioadmin',
  },
  forcePathStyle: true, // required for MinIO
});

export async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }
}

export function inputFilePath(jobId: string, fileIndex: number): string {
  return `jobs/${jobId}/inputs/file_${String(fileIndex).padStart(6, '0')}.csv`;
}

export function outputFilePath(jobId: string): string {
  return `jobs/${jobId}/output/result.csv`;
}

export async function putObject(key: string, body: string | Buffer | Readable): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
    })
  );
}

export async function getObject(key: string): Promise<Readable> {
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
    })
  );
  if (!response.Body) throw new Error(`Empty body for key ${key}`);
  return response.Body as Readable;
}

export async function getObjectString(key: string): Promise<string> {
  const stream = await getObject(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Generate a CSV file with C random float values in [0, 1)
 */
export function generateFileCsv(c: number): string {
  const lines: string[] = [];
  for (let i = 0; i < c; i++) {
    lines.push(Math.random().toFixed(8));
  }
  return lines.join('\n') + '\n';
}
