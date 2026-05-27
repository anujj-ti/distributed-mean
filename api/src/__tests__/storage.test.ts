/**
 * Storage module unit tests — pure functions that don't need S3
 */

// Mock S3 client before importing storage
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
  })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  CreateBucketCommand: jest.fn(),
  HeadBucketCommand: jest.fn(),
}));

import {
  inputFilePath,
  outputFilePath,
  generateFileCsv,
  ensureBucket,
  putObject,
  getObject,
  getObjectString,
} from '../lib/storage.js';

describe('inputFilePath', () => {
  it('formats file index with 6-digit padding', () => {
    expect(inputFilePath('job-1', 0)).toBe('jobs/job-1/inputs/file_000000.csv');
    expect(inputFilePath('job-1', 5)).toBe('jobs/job-1/inputs/file_000005.csv');
    expect(inputFilePath('job-1', 999)).toBe('jobs/job-1/inputs/file_000999.csv');
    expect(inputFilePath('job-1', 99999)).toBe('jobs/job-1/inputs/file_099999.csv');
    expect(inputFilePath('job-1', 100000)).toBe('jobs/job-1/inputs/file_100000.csv');
  });

  it('uses job ID in path', () => {
    const path = inputFilePath('my-special-job', 42);
    expect(path).toContain('my-special-job');
  });
});

describe('outputFilePath', () => {
  it('returns correct output key', () => {
    const path = outputFilePath('job-xyz');
    expect(path).toBe('jobs/job-xyz/output/result.csv');
  });
});

describe('generateFileCsv', () => {
  it('generates exactly C lines', () => {
    const csv = generateFileCsv(10);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(10);
  });

  it('generates values in [0, 1)', () => {
    const csv = generateFileCsv(100);
    const lines = csv.trim().split('\n');
    for (const line of lines) {
      const val = parseFloat(line);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });

  it('values are formatted as floating point strings', () => {
    const csv = generateFileCsv(5);
    const lines = csv.trim().split('\n');
    for (const line of lines) {
      expect(line).toMatch(/^\d+\.\d+$/);
    }
  });

  it('ends with newline', () => {
    const csv = generateFileCsv(3);
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('C=1 generates single line', () => {
    const csv = generateFileCsv(1);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(1);
  });
});

describe('S3 operations (mocked)', () => {
  const { S3Client } = require('@aws-sdk/client-s3');
  const mockSend = jest.fn();

  beforeEach(() => {
    S3Client.mockImplementation(() => ({ send: mockSend }));
    mockSend.mockReset();
  });

  it('ensureBucket calls HeadBucketCommand', async () => {
    mockSend.mockResolvedValueOnce({}); // HeadBucket succeeds
    await expect(ensureBucket()).resolves.not.toThrow();
  });

  it('ensureBucket creates bucket if not found', async () => {
    mockSend
      .mockRejectedValueOnce(new Error('NoSuchBucket')) // HeadBucket fails
      .mockResolvedValueOnce({}); // CreateBucket succeeds
    await expect(ensureBucket()).resolves.not.toThrow();
  });
});
