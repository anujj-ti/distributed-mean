# Architecture Decision Records (ADRs)

ADRs capture significant structural decisions — things that shape the system long-term and are costly to reverse.

## Naming
`ADR-NNN-short-slug.md`  e.g. `ADR-001-monorepo-structure.md`

## Template

```markdown
# ADR-NNN: Title

**Status:** proposed | accepted | deprecated | superseded by ADR-XXX
**Date:** YYYY-MM-DD

## Context
What situation or problem forced this decision?

## Decision
What was decided, stated clearly.

## Consequences
- **Positive:** benefits gained
- **Negative:** costs incurred or constraints introduced
- **Risks:** what could go wrong

## Alternatives Considered
| Alternative | Why rejected |
|-------------|-------------|
| Option A    | reason      |
```

## Index

| # | Title | Status |
|---|-------|--------|
| [ADR-001](ADR-001-repo-structure.md) | Monorepo structure (api/workers/ui/shared) | draft |
| [ADR-002](ADR-002-api-framework.md) | API framework: Express + TypeScript | draft |
| [ADR-003](ADR-003-worker-language.md) | Worker language: Python | draft |
| [ADR-004](ADR-004-local-first.md) | Local-first: no cloud dependencies | draft |
