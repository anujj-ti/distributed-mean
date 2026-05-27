```
━━━ Sherlock ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 22 min ━━━━
  Research complete.
  Beads: 13/13 resolved | 5 validated | 0 unresolved
  Validated: 5 claims (2 confirmed, 1 corrected, 2 refuted+fixed)
  Time: ~22 min

  Files:
    report: ~/.sherlock/sessions/1a848609/report/report.md
    data:   ~/.sherlock/sessions/1a848609/report/data.csv

  Push to Google Docs? (yes/no)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Research Complete

Here's what the research surfaced, including the most important corrections from validation:

---

### TypeScript (Express + Zod)

**`noUncheckedIndexedAccess`** — highest-value flag not in `strict: true`. Every `req.params.id`, `arr[i]`, and `obj[key]` becomes `T | undefined`, catching the #1 JS runtime error at compile time. Use Zod to parse `req.params`/`req.query` at route entry — it handles the narrowing and runtime validation in one step.

**`exactOptionalPropertyTypes` + Zod — confirmed incompatibility.** `z.string().optional()` always infers `{foo?: string | undefined}` but `exactOptionalPropertyTypes` requires `{foo?: string}`. The Zod GitHub issues tracking this are closed, but the conflict persists as a Zod v3 design characteristic. **Disable `exactOptionalPropertyTypes` if you use Zod's `.optional()` pervasively.**

**`@tsconfig/strictest`** (validated ✓) includes both flags. Extend it + `@tsconfig/node-lts`, then override `exactOptionalPropertyTypes: false` as needed.

**ESLint + Jest:** Add a `disableTypeChecked` config block (validated ✓) for test file patterns — eliminates nearly all Jest mock false positives. Use an `asyncHandler` wrapper for all async Express routes to satisfy `no-misused-promises` without suppressions.

---

### Python (Pydantic v2 + Ruff)

**Key correction from validation:** `BaseSettings` with `strict=True` is **not broken**. Pydantic treats env vars as JSON input, which gets looser coercion rules even in strict mode — `"42"` → `42` still works. Use `ConfigDict(strict=True)` on business-logic `BaseModel` classes; leave `BaseSettings` in lax mode and use `StrictStr`/`StrictInt` annotations only where coercion must be prevented.

**Ruff replaces Black** with >99.9% formatting compatibility and 30x speed. Remove Black, use `ruff format`. Rule set: `["E", "W", "F", "B", "UP", "SIM", "I", "N"]` with `N818` ignored (50% false positive rate). Pin the Ruff version in pre-commit — new rules activate on version bumps.
