# Tradeoff Analyses

Dedicated tradeoff docs for decisions where multiple options were seriously evaluated. Complements ITDs with deeper analysis.

## Naming
`TRADEOFF-NNN-short-slug.md`  e.g. `TRADEOFF-001-queue-options.md`

## Template

```markdown
# TRADEOFF-NNN: Title

## Decision Question
State the decision as a question.

## Options Matrix

| Criterion | Option A | Option B | Option C |
|-----------|----------|----------|----------|
| Local setup complexity | low | medium | high |
| Operational overhead | low | medium | medium |
| Throughput at scale | low | high | high |
| DX / debuggability | high | medium | low |
| Fit for this use case | ✅ | ⚠️ | ❌ |

## Analysis
Narrative explanation of the matrix. Which criteria mattered most and why.

## Decision
**Chosen: Option A** — one sentence rationale.

## Related ITD
Link to the ITD that records the final decision.
```

## Index

| # | Title |
|---|-------|
| [TRADEOFF-001](TRADEOFF-001-queue-options.md) | Queue: BullMQ+Redis vs in-process vs RabbitMQ |
| [TRADEOFF-002](TRADEOFF-002-db-options.md) | DB: SQLite vs Postgres local |
| [TRADEOFF-003](TRADEOFF-003-ui-transport.md) | UI transport: WebSocket vs SSE |
| [TRADEOFF-004](TRADEOFF-004-aggregation-strategy.md) | Aggregation: running sum vs collect-then-merge |
