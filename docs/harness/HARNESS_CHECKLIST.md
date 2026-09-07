# Harness Review Checklist

> Run through this before shipping a harness change or handing off a Code Mode feature.
> A failing item is a blocker; a skipped item needs a written justification.

## Agent instructions (AGENTS.md)

- [x] Project overview is accurate and up to date
- [x] Repository structure reflects the current layout
- [x] Tool permissions are explicit — Chat / Agent / Code modes documented
- [x] Verification gates are defined and commands are correct
- [x] No ambiguous instructions that could be interpreted multiple ways

## Tool design

- [x] Each tool has a clear, unambiguous name
- [x] Tool schemas are minimal — no optional fields the agent won't use
- [x] Error messages tell the agent what to do next, not just what went wrong
- [x] Tool return values are consistent (same shape on success and failure)
- [x] No tool does more than one conceptual thing

## Context delivery

- [x] Context is scoped to what the agent needs for this task
- [x] Long-lived state (plans, decisions, progress) is in `.agentsmith/` files when non-trivial
- [x] Context compaction strategy is defined (`fitBudget` eviction + `phaseCompact` at phase transitions)
- [x] No sensitive data (secrets, credentials) in agent-accessible context

## Planning artifacts

- [x] `.agentsmith/PLAN.md` created for non-trivial Code runs
- [x] Milestones have explicit verification commands
- [x] Scope boundaries (in-scope / out-of-scope) are written down
- [x] `.agentsmith/IMPLEMENT.md` captures decisions as they happen

## Permissions & sandbox

- [x] Agent mode: write tools hard-blocked at dispatch
- [x] Code mode: auto-run with project-root logical sandbox + change ledger
- [x] Destructive ops: no pre-approval (trust = ledger + Revert All) — documented explicitly
- [x] Network access scoped via netGuard for proxy/download paths

## Verification loop

- [x] Unit tests exist for harness engines (`npm test`)
- [x] Harness eval scenarios pass (`npm run harness-eval-regression` + `npm run harness-security`)
- [x] Capability evals available (`npm run harness-eval-capability`)
- [x] Completion gate runs on every exit path (not just happy path)
- [x] Eval criteria documented in `tests/harness-eval/README.md`
- [x] Post-edit sensors run after write tools (`postEditChecks` middleware)
- [x] Grind-until-green blocks done when lint/test fail (toggle in Code Mode UI)
- [x] Greenfield empty-files path covered (`scripts/greenfield-smoke.js`)

## GUI / E2E (explicit gap)

- [x] Playwright/e2e grind when `test:e2e` or `playwright.config.*` detected
- [ ] Desktop Code timeline + Revert All — manual (`docs/MANUAL_SMOKE.md`)
- [ ] Web/mobile SSE timeline during Code run — manual
- [ ] Playwright visual regression — not implemented (e2e command grind only)

## Orchestration & observability

- [x] Workspace readiness scorer (`code-readiness`, UI chip, `scripts/readiness-report.js`)
- [x] Plugin lifecycle hooks: sessionStart/Stop, afterTurn, afterToolBatch, phaseChange
- [x] Optional worktree isolation (`ISOLATED RUN` toggle)
- [x] Sequential milestone subagents (`PARALLEL MILESTONES` toggle, 3+ milestones)
- [x] Milestone worktrees v2 (`MILESTONE WORKTREES` + optional `CONCURRENT MILESTONES`)
- [x] Verify-phase `query_run_trace` tool

## When this harness component should be removed

See [`WHEN_TO_REMOVE.md`](WHEN_TO_REMOVE.md).

---

*Reviewed: 2026-06-06*  
*Reviewer: post-audit remediation sprint*
