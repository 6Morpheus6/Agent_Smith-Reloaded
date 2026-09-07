# Harness documentation index

Agent Smith harness docs live in three tiers:

| Tier | Location | Purpose |
|------|----------|---------|
| Entry | [`AGENTS.md`](../../AGENTS.md) | Mode map, verification commands |
| Product | [`docs/CODE_MODE.md`](../CODE_MODE.md) | Guards table, tool surface, loops |
| Meta | `docs/harness/` (this folder) | Checklists, templates, retirement criteria |
| Runtime | `.agentsmith/` in workspace | Per-run PLAN.md, IMPLEMENT.md, rules |

## Files in this folder

| File | Use when |
|------|----------|
| [`HARNESS_CHECKLIST.md`](HARNESS_CHECKLIST.md) | Shipping a harness change |
| [`WHEN_TO_REMOVE.md`](WHEN_TO_REMOVE.md) | Adding or retiring a guard |
| [`GUARD_TEMPLATE.md`](GUARD_TEMPLATE.md) | Authoring a new guard |
| [`PLAN.md.template`](PLAN.md.template) | Milestone schema for Code runs |
| [`IMPLEMENT.md.template`](IMPLEMENT.md.template) | Decision log schema |
| [`SUBAGENTS.md`](SUBAGENTS.md) | Sequential milestone subagent dispatch |
| [`PARALLEL_MILESTONES_V2.md`](PARALLEL_MILESTONES_V2.md) | Worktree-per-milestone subagents |
| [`READINESS.md`](READINESS.md) | Workspace readiness scorer |
| [`ROADMAP.md`](ROADMAP.md) | Out-of-scope future platform items |

## Adding a new guard (5 steps)

1. **Hook point** — Choose `middleware` (`beforeTool`, `afterTool`, `beforeDone`), `completionGate`, `executor`, or plugin hook.
2. **Implement** — Keep one conceptual responsibility per module under `src/code/governor/` or `src/code/loop/`.
3. **Test** — Unit test in `tests/<name>.test.js`; integration scenario in [`tests/harness-eval/`](../tests/harness-eval/) (regression tier).
4. **Document** — Row in [`CODE_MODE.md`](../CODE_MODE.md) guards table; row in [`WHEN_TO_REMOVE.md`](WHEN_TO_REMOVE.md).
5. **Verify** — `npm test`, `npm run harness-eval-regression`, `npm run harness-security`, `npm run ship-check`.

## Continuous verification (2026)

Code Mode now runs:

- **Post-edit sensors** — scoped lint + project rules after each `patch` / `write_file` ([`postEditChecks.js`](../../src/code/governor/postEditChecks.js))
- **Grind until green** — optional lint + test at completion ([`completionGate.js`](../../src/code/governor/completionGate.js)); toggle: **GRIND UNTIL GREEN** in Code Mode settings
- **beforeDone hooks** — middleware + plugins can veto completion ([`turnLoop.js`](../../src/code/loop/turnLoop.js))
- **Project rules** — `.agentsmith/rules/*.js` ([`projectRules.js`](../../src/code/governor/projectRules.js)); example in [`examples/agentsmith-rules/`](../../examples/agentsmith-rules/)

See [`docs/BROWSER_VERIFY.md`](../BROWSER_VERIFY.md) for the verify-phase browser tool.

## Model harness (per-family prompt adaptation)

How the app talks to the loaded model is decided by ONE table:
[`src/code/context/modelHarness.js`](../../src/code/context/modelHarness.js).
Ordered rows (first match wins, `default` matches everything):

| Row | Prompt adaptation | Temperature |
|-----|-------------------|-------------|
| `gemma` | fold system → first user turn, serialize tool turns to text, JSON tool preamble | caller's |
| `kimi-k3` | none (native tools) | pinned to 1 |
| `default` | none (OpenAI-compatible) | caller's |

Rules: prompt shape lives in `modelHarness`; wire validity (tool pairing,
canonical fields, schemas) lives in `src/shared/toolPairing.js`. Adding a family
= one table row + one routing test in `tests/modelHarness.test.js`.
