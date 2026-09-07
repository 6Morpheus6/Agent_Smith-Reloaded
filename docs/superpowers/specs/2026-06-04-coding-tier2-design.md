# Coding-Capability Tier 2 — Implementation Spec

**Date:** 2026-06-04  **Source:** `docs/CODING_CAPABILITY_AUDIT.md`.
**Decisions:** `add_steps` is **autonomous** (shown in the plan panel, no re-approval). Intermediate steps are **syntax-gated** (full test/lint suite still only at the final step).

Engines are unit-tested where pure (`tests/codingTier2.test.js`); IPC/tool wiring verified by a launch smoke + full suite staying green.

## A. Plan adaptivity (audit 3.1, 3.2)
- **`add_steps` tool** — the agent appends pending steps to the running plan as it learns. `planStore.addSteps(plan, titles)` appends with fresh ids; IPC `plan-add-steps`; renderer refreshes the panel via `onStepAdvance`. Execution-only (not a planning tool).
- **Retry-then-skip on `mark_step_blocked`** — a model-initiated block first returns guidance to try a *different approach to the same step* (bounded: `MAX_BLOCK_RETRY = 1` via `step.blockAttempts`); only after that does it skip. Harness-initiated auto-blocks (stall/loop/edit-fail) pass `_auto:true` and skip immediately.

## B. Per-step syntax gate (audit 2.2)
- `runVerification(root, plan, { syntaxOnly })` skips lint/test and only syntax-checks touched files. `agent-verify` accepts the opt. `mark_step_done` runs `syntaxOnly` for intermediate steps (blocks on a real syntax error — never legitimate mid-build) and the full suite for the final step. `unverified` still passes through honestly.

## C. `fetch_url` tool (audit 5.1)
- IPC `agent-fetch-url` → `netGuard.validatePublicFetchTarget` → fetch (timeout) → strip HTML to text → cap (~8 KB). Tool added to `PLAN_TOOLS`, `READ_ONLY_TOOLS`, and `PLANNING_TOOLS` (docs lookup helps planning too). Lets the model read an actual docs/API page instead of guessing from a search snippet.

## D. Background-process control (audit 5.3)
- `read_process_log` now returns `{ log, running, exitCode }` (tracked on the child's `close`). New `stop_process` and `list_processes` tools (+ IPC `agent-stop-process` / `agent-list-processes`). Foreground `run_shell_command` gets a timeout so a forgotten long-runner fails fast instead of hanging the turn. Enables start-server → poll → curl → kill.

## E. Unified-diff applier fails loudly (audit 4.2)
- `applyUnifiedDiff` throws `Patch context line not found: "…"` when a context/delete anchor can't be located (was: consume-to-EOF, silently corrupting the file while reporting success). The error returns to the model so it re-reads and regenerates.

## F. Stall counter exempts read-only turns (audit 3.4)
- The "no ledger change = no progress" ceiling no longer counts a turn that used a read-only tool (read/grep/glob/list/repo-map) — reading several files before editing is legitimate investigation, not a stall.

## G. Embeddings fallback (audit 1.8)
- When Ollama embeddings are unreachable, `memory.js` falls back to the configured LLM's OpenAI-compatible `/v1/embeddings` (`memoryManager.setLlmBase(lmsHostUrl)` from `main.js`). LM-Studio-only users get working memory when an embedding model is available, instead of silent total failure.

## H. Auto-promote read files into context (audit 1.4, light)
- When the model `read_file`s a file during a step, it's added to that step's `filesTouched` (capped) so the dependency it just read stays in the next turn's context instead of falling out.

## Deferred to Tier 3
- Read-only research **subagent** (5.2); repo-map symbol-ranked auto-selection (fuller 1.4/1.5); the chat-path render throttle.

## Verification
`npm test` (suite stays green) + new `tests/codingTier2.test.js` (addSteps, syntaxOnly verify, diff fail-loud, HTML-strip, read-only stall exemption helper).
