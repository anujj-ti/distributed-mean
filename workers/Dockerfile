# ─── Quality stage: run linting and type checks at build time ─────────────────
FROM python:3.11-slim AS quality

WORKDIR /app

# Install all deps including dev tools
COPY pyproject.toml .
RUN pip install --no-cache-dir -e ".[dev]"

COPY models.py worker.py ./

# ──── Quality gates — build fails if any of these fail ────────────────────────
# Ruff: linting
RUN ruff check .

# Black: formatting check
RUN black --check .

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

WORKDIR /app
ENV PYTHONUNBUFFERED=1

COPY pyproject.toml .
RUN pip install --no-cache-dir -e .

COPY --from=quality /app/models.py /app/worker.py ./

CMD ["python", "-u", "worker.py"]
