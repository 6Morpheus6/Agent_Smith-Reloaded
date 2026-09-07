# Guard author template

Use this checklist when adding a harness guard.

## Metadata

| Field | Value |
|-------|-------|
| **Guard name** | e.g. `postEditChecks` |
| **Hook point** | `afterTool` / `beforeDone` / `checkCompletion` / plugin |
| **Blocks write?** | yes / no (advisory warnings only) |
| **Blocks done?** | yes / no |

## Failure mode

Describe what condition triggers the guard and what message the model sees.

## Remediation

Error messages should tell the agent **what to do next**, not only what failed.

## Files

| Role | Path |
|------|------|
| Implementation | `src/code/governor/<name>.js` |
| Middleware wiring | `src/code/loop/middleware.js` (if applicable) |
| Unit test | `tests/<name>.test.js` |
| Eval scenario | `tests/harness-eval/scenarios.test.js` |

## WHEN_TO_REMOVE row

Add to [`WHEN_TO_REMOVE.md`](WHEN_TO_REMOVE.md):

```markdown
| `myGuard` | Exists because … | Can be removed when … |
```

## Manual smoke

If user-visible, add steps to [`docs/MANUAL_SMOKE.md`](../MANUAL_SMOKE.md).
