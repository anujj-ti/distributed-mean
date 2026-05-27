# ADR-001: Monorepo Structure (api/workers/ui/shared)

**Status:** accepted  
**Date:** 2025-05-28

## Context
The system has multiple components written in different languages (TypeScript API, Python workers, HTML/JS UI). We need to decide how to organize the codebase — one repo or multiple, and how to structure directories within.

A monorepo allows atomic commits across components (e.g., changing the task queue message format in the API and workers simultaneously). A polyrepo would separate concerns but add coordination overhead for a small project.

## Decision
Use a **monorepo** with top-level directories per component:
```
distributed-mean/
├── api/           # Node.js + Express + TypeScript
├── workers/       # Python workers
├── ui/            # Dashboard (static HTML + vanilla JS)
├── shared/        # Shared constants and schema documentation
├── docs/          # All design/architecture docs
├── docker-compose.yml
├── docker-compose.prod.yml
└── .env.example
```

Each component has its own `Dockerfile` and dependency manifest (`package.json` or `requirements.txt`). The root has `docker-compose.yml` that orchestrates everything.

## Consequences
- **Positive:** Single PR touches all layers. Shared docs stay co-located. One clone to run the whole system.
- **Negative:** Language-specific tooling (eslint, mypy) runs at different subdirectory levels. Larger clone for developers who only need one component.
- **Risks:** Accidental coupling between components via shared code. Mitigated by keeping `shared/` to constants/docs only, not runtime imports across language boundaries.

## Alternatives Considered
| Alternative | Why rejected |
|-------------|-------------|
| Polyrepo (api-repo, worker-repo, ui-repo) | Coordination overhead for a small project; harder to atomic-commit cross-component changes |
| Flat structure (all files at root) | Unscalable; mixing TypeScript and Python toolchains at root causes confusion |
