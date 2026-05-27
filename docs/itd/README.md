# Intent-To-Develop (ITD) Docs

Each ITD captures one architectural or technical decision made during development.

## Naming
`ITD-NNN-short-slug.md`  e.g. `ITD-001-queue-technology.md`

## Template

```markdown
# Distributed Mean - ITDs

| ITD N - Use this to perform that |  |
| :---- | :---- |
| **THE PROBLEM** | What are you trying to decide? (write as a question) |
| **OPTIONS CONSIDERED (Decision in bold)** | **Chosen Option** / Alternative A / Alternative B |
| **REASONING** | Why the chosen option was selected; why others were not. |
| **TRADEOFFS** | Drawbacks of the chosen option. |
| **NOTES** | Optional: links, follow-ups, related ITDs. |
```

## Index

| # | Title | Status |
|---|-------|--------|
| [ITD-001](ITD-001-queue-technology.md) | Queue technology selection | draft |
| [ITD-002](ITD-002-work-distribution-algorithm.md) | Work distribution algorithm | draft |
| [ITD-003](ITD-003-result-aggregation.md) | Result aggregation strategy | draft |
| [ITD-004](ITD-004-database-choice.md) | Database choice | draft |
| [ITD-005](ITD-005-realtime-ui-transport.md) | Real-time UI transport (WebSocket vs SSE) | draft |
| [ITD-006](ITD-006-file-storage.md) | File storage strategy | draft |
| [ITD-007](ITD-007-worker-process-model.md) | Worker process model (subprocess vs process pool) | draft |
