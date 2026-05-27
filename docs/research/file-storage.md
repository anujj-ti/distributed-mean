# Research: File Storage Strategy

## Question
Local filesystem vs MinIO (S3-compatible) for generated input files that workers need to read.

## Options

### Shared Docker Volume
- Workers and API share a Docker volume
- Simple: no extra service, just `./data:/data` in compose
- Locally perfect; breaks on cloud (distributed workers need shared FS)
- Cloud option: EFS (expensive), NFS (complex)
- Not cloud-portable without changes

### MinIO (S3-compatible object store)
- Runs as a Docker container locally
- API-compatible with AWS S3 (just change endpoint URL)
- Workers use `boto3` (Python) or `@aws-sdk/client-s3` (TS)
- Locally: `http://minio:9000`; Cloud: `https://s3.amazonaws.com`
- Single env var change for cloud deployment
- Web UI on port 9001 for debugging

### AWS S3 Directly
- No local equivalent without MinIO
- Cloud-only; requires real AWS account
- Not suitable for local dev/testing

## Decision: **MinIO** (S3-compatible)

### Rationale
1. **Local parity with cloud**: same API, same code, different endpoint URL
2. **No shared FS needed**: workers can be on different machines in cloud
3. **Simple Docker integration**: `minio/minio` image, one service in compose
4. **Battle-tested**: boto3 + MinIO is a standard pattern for local S3 dev
5. **Web UI**: Built-in object browser at port 9001 — useful for debugging

### Trade-offs
- Extra Docker container (minor)
- Workers need boto3 configured with MinIO endpoint
- For very large F (100k files × 10k values), file generation takes time

### File Format
Using CSV (float per line, comma-separated for single column):
- Human-readable for debugging
- Easy to generate with Python's random module
- For performance at scale: could switch to binary (.npy) but CSV is fine for now

### File Generation Strategy
For F=100k files:
- Generate in the API as a streaming operation
- Write directly to MinIO using `PutObject` with streamed body
- Use multipart upload for large files
- Generate asynchronously after enqueuing tasks (workers start before all files exist)
  - Each task specifies exact file indices; API ensures those files exist before enqueueing that task
  - OR: API generates all files, then enqueues tasks (simpler, blocks longer)
  - Decision: **generate all files first, then enqueue** (simpler, avoids race conditions)
  - Timeout consideration: for F=100k, generation runs in background; job status = 'generating' initially

### Storage Layout
```
Bucket: distributed-mean

jobs/{jobId}/inputs/
  file_000000.csv
  file_000001.csv
  ...
  file_099999.csv

jobs/{jobId}/output/
  result.csv
```
