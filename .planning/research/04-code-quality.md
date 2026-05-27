# Code Quality Research — TypeScript Strict + Python Strict

## Question
Best practices for strict TypeScript (noUncheckedIndexedAccess, exactOptionalPropertyTypes) with Express and Zod validation.
Pydantic v2 strict mode with BaseSettings for Python worker configuration.
Ruff + Black configuration for strict Python. Integrating ESLint typescript-strict-type-checked with Jest.

## TypeScript Strict Configuration

### tsconfig.json — Maximum Strictness

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

### Handling noUncheckedIndexedAccess with Express

```typescript
// BAD - fails with noUncheckedIndexedAccess:
const value = myArray[0]; // type: string | undefined

// GOOD - always check:
const value = myArray[0];
if (value === undefined) throw new Error('Empty array');

// Or use non-null assertion (documented, deliberate):
const value = myArray[0]!; // only if you KNOW it exists

// With Zod - the cleanest approach:
const schema = z.array(z.string()).nonempty();
const parsed = schema.parse(input);
const value = parsed[0]; // TypeScript knows it's string (nonempty)
```

### Zod Validation Pattern for Express

```typescript
import { z } from 'zod';
import { RequestHandler } from 'express';

const CreateJobSchema = z.object({
  f: z.number().int().min(2).max(100_000).describe('Number of files'),
  c: z.number().int().min(2).max(10_000).describe('Values per file'),
});

type CreateJobBody = z.infer<typeof CreateJobSchema>;

const createJob: RequestHandler = async (req, res) => {
  const result = CreateJobSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: result.error.issues });
    return;
  }
  const { f, c } = result.data;
  // f and c are fully typed here
};
```

### exactOptionalPropertyTypes Pattern

```typescript
// BAD - setting undefined explicitly fails:
interface JobFilter {
  status?: 'pending' | 'done';
}
const filter: JobFilter = { status: undefined }; // Error with exactOptionalPropertyTypes!

// GOOD - omit the property entirely:
const filter: JobFilter = {}; // OK

// Or use union explicitly:
interface JobFilter {
  status?: 'pending' | 'done' | undefined; // explicitly includes undefined
}
```

## ESLint Configuration — typescript-strict-type-checked

### .eslintrc.json

```json
{
  "root": true,
  "parser": "@typescript-eslint/parser",
  "parserOptions": {
    "project": "./tsconfig.json",
    "ecmaVersion": 2022,
    "sourceType": "module"
  },
  "plugins": ["@typescript-eslint"],
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/strict-type-checked",
    "plugin:@typescript-eslint/stylistic-type-checked"
  ],
  "rules": {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-misused-promises": "error",
    "@typescript-eslint/await-thenable": "error",
    "@typescript-eslint/consistent-type-imports": "error",
    "no-console": "warn"
  },
  "env": {
    "node": true
  }
}
```

### Jest + TypeScript Configuration

```json
// jest.config.json
{
  "preset": "ts-jest",
  "testEnvironment": "node",
  "collectCoverageFrom": [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/**/index.ts"
  ],
  "coverageThreshold": {
    "global": {
      "branches": 75,
      "functions": 75,
      "lines": 75,
      "statements": 75
    }
  }
}
```

### package.json Scripts

```json
{
  "scripts": {
    "build": "tsc --noEmit",
    "lint": "eslint 'src/**/*.ts' --max-warnings 0",
    "test": "jest",
    "test:coverage": "jest --coverage",
    "check": "npm run build && npm run lint && npm run test:coverage"
  }
}
```

## Python — Pydantic v2 Strict Mode

### Pydantic v2 Models for Worker

```python
from pydantic import BaseModel, ConfigDict, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

class TaskMessage(BaseModel):
    model_config = ConfigDict(strict=True, frozen=True)

    task_id: str
    job_id: str
    file_keys: list[str] = Field(..., min_length=1, max_length=5)
    c: int = Field(..., gt=0, le=10_000)

class PartialResult(BaseModel):
    model_config = ConfigDict(strict=True)

    task_id: str
    job_id: str
    partial_sums: list[float] = Field(..., min_length=1)
    files_processed: int = Field(..., gt=0)

class WorkerSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file='.env',
        env_file_encoding='utf-8',
        case_sensitive=False,
        extra='ignore',
    )

    redis_url: str = 'redis://localhost:6379'
    api_url: str = 'http://localhost:3000'
    minio_endpoint: str = 'localhost:9000'
    minio_access_key: str = 'minioadmin'
    minio_secret_key: str = 'minioadmin'
    minio_bucket: str = 'distributed-mean'
    worker_slowness: float = Field(default=1.0, ge=0.1, le=10.0)
    worker_id: str | None = None
    queue_name: str = 'tasks:pending'
    task_timeout_seconds: int = Field(default=300, gt=0)
```

### Pydantic v2 strict=True — What It Does

With `strict=True`:
- No coercion: `str` won't accept `int`, `int` won't accept `"42"`
- Explicit casting required: `TaskMessage(task_id=str(uuid), ...)`
- Better validation errors — fails fast on wrong types

## Ruff Configuration — Broad Select

```toml
# pyproject.toml
[tool.ruff]
target-version = "py311"
line-length = 100

[tool.ruff.lint]
select = [
    "E",    # pycodestyle errors
    "W",    # pycodestyle warnings
    "F",    # pyflakes
    "I",    # isort
    "N",    # pep8-naming
    "UP",   # pyupgrade
    "B",    # flake8-bugbear
    "C4",   # flake8-comprehensions
    "SIM",  # flake8-simplify
    "ANN",  # flake8-annotations (type hints)
    "S",    # flake8-bandit (security)
    "PTH",  # flake8-use-pathlib
    "RUF",  # ruff-specific rules
]
ignore = [
    "ANN101", # Missing type annotation for self
    "ANN102", # Missing type annotation for cls
    "S101",   # Use of assert (OK in tests)
    "S311",   # random not for cryptography - fine for our use
]

[tool.ruff.lint.isort]
known-first-party = ["worker"]

[tool.black]
line-length = 100
target-version = ["py311"]

[tool.mypy]
python_version = "3.11"
strict = true
warn_return_any = true
warn_unused_configs = true

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
addopts = "--cov=worker --cov-report=term-missing --cov-fail-under=75"
```

### Python Dockerfile — Build-time Quality Gates

```dockerfile
FROM python:3.11-slim AS quality
WORKDIR /app
COPY pyproject.toml .
RUN pip install ".[dev]"
COPY . .
# Fail build if quality gates don't pass
RUN ruff check .
RUN black --check .
RUN mypy worker/

FROM python:3.11-slim AS runtime
WORKDIR /app
COPY pyproject.toml .
RUN pip install ".[runtime]"
COPY --from=quality /app/worker/ ./worker/
CMD ["python", "-m", "worker"]
```

## Summary

| Tool | Config | Key Rules |
|------|--------|-----------|
| TypeScript | strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes | Zero any, zero implicit returns |
| ESLint | strict-type-checked + stylistic-type-checked | Zero warnings enforced (--max-warnings 0) |
| Zod | safeParse pattern everywhere | All external inputs validated |
| Pydantic v2 | strict=True + frozen where appropriate | No type coercion |
| BaseSettings | env_file + case_insensitive | All config from env vars |
| Ruff | E,W,F,I,N,UP,B,C4,SIM,ANN,S,PTH,RUF | Broad but not exhaustive |
| Black | line-length=100 | Consistent formatting |
| mypy | strict=True | Full type checking |
| Jest coverage | 75% minimum all dimensions | Hard failure in CI |
| pytest coverage | 75% minimum | Hard failure in CI |
