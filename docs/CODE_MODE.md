# Code Mode

Code Mode is Agent Smith's auto-run coding loop for local small/medium LLMs.

**Runtime auto-tune:** When enabled in the TUNING sidebar, model + GPU telemetry set context window, Code Mode `maxTurns`, and `codeTemperature` automatically on model change. See [`RUNTIME_PROFILE.md`](RUNTIME_PROFILE.md).

## Architecture

```
Renderer (IPC only)          Main process
──────────────────          ─────────────────────────────
code-mode toggle     →      src/code/loop/runCodeTask.js
code-run / code-stop        src/code/loop/turnLoop.js
code-event stream           src/code/tools/executor.js → changeLedger
```

**Modes are isolated:**

| Mode | Toggle | May use |
|------|--------|---------|
| Chat | Both off | LLM stream, memory, Netrunner |
| Agent | AGENT (SYS-ACCESS) on | Chat-path shell + read-only tools (`src/renderer/modes/agentTools.js`) — **no write/patch** |
| Code | CODE MODE on | `code-*` IPC, ledger, project sandbox — full build tools |

Agent and Code are mutually exclusive in the UI.

Chat and Code have separate `chatRunState` / `codeRunState` (busy flag, abort).

## Trust layer

By default tools auto-run without a pre-approval step. Every mutating tool snapshots via `changeLedger`. On done, the review panel shows unified diff + **Revert All** (`ledger-revert-all` with the run's `sessionId`).

### Optional plan approval (Option B)

Enable **REQUIRE PLAN APPROVAL** in the Code Mode settings strip (sidebar, visible when CODE MODE is on). Flow:

1. **Planning phase** — read-only tools + `submit_code_plan` (`src/code/loop/planningPhase.js`)
2. **Sidebar plan drawer** — edit steps, **Approve & Run** or **Reject** (`code-plan-approve` / `code-plan-reject` IPC)
3. **Execution** — approved steps injected each turn; model calls `mark_code_step_done` to advance

Plan state lives on the code session (`codePlan` in `<userData>/code-sessions/`). Toggle persists in `localStorage` (`agentsmith_code_plan_approval`).

### Grind until green

Enable **GRIND UNTIL GREEN** (default on) to block completion until project `lint`, `test`, and optional `test:e2e` / Playwright commands pass (from `package.json` / [`projectDetector.js`](src/main/services/projectDetector.js)). Toggle persists in `localStorage` (`agentsmith_code_grind`).

### Isolated run (worktree)

Enable **ISOLATED RUN** to execute in a git worktree under `.agentsmith/worktrees/<sessionId>/`. Requires a git repo. Toggle: `agentsmith_code_isolated`.

### Parallel milestones (sequential subagents)

Enable **PARALLEL MILESTONES** when PLAN.md has 3+ milestones — runs sequential child loops per milestone. Enable **MILESTONE WORKTREES** (requires git) for one worktree per milestone; **CONCURRENT MILESTONES** is experimental. See [`docs/harness/SUBAGENTS.md`](docs/harness/SUBAGENTS.md) and [`docs/harness/PARALLEL_MILESTONES_V2.md`](docs/harness/PARALLEL_MILESTONES_V2.md).

## Tool surface (v1)

`read_file`, `patch`, `write_file`, `grep`, `glob`, `run_command`, `list_project`, `show_preview`, `browser_verify`, `query_run_trace` (verify phase)

See [`docs/PREVIEW.md`](PREVIEW.md) for the Preview panel tool. See [`docs/BROWSER_VERIFY.md`](BROWSER_VERIFY.md) for headless HTML verification.

## Guards (native implementation)

| Module | Role |
|--------|------|
| `src/code/tools/extractor.js` | JSON-in-prose, Hermes tags, fenced blocks |
| `src/code/tools/router.js` | Per-turn phase-aware tool subset |
| `src/code/loop/phases.js` | explore → implement → verify tool gating |
| `src/code/loop/middleware.js` | phaseGate, planSync, postEditSensors, beforeDone |
| `src/code/governor/postEditChecks.js` | Scoped lint + rules after each write |
| `src/code/governor/projectRules.js` | `.agentsmith/rules/*.js` enforcement |
| `src/code/context/planArtifacts.js` | `.agentsmith/PLAN.md` + `IMPLEMENT.md` |
| `src/code/context/planAnchor.js` | Inline task block + plan excerpt each turn |
| `src/code/context/phaseCompact.js` | Phase-boundary message compaction |
| `src/code/loop/codeTrace.js` | GhostTrace export + `query_run_trace` |
| `src/code/governor/completionGate.js` | Block premature done; grind lint/test/e2e; milestone verify |
| `src/code/governor/readiness.js` | Workspace readiness scorer |
| `src/main/services/worktreeManager.js` | Optional git worktree isolation |
| `src/main/services/browserVerify.js` | Headless browser_verify tool |
| `src/code/governor/earlyStop.js` | Stagnation / error ceiling |
| `src/code/governor/qualityMonitor.js` | Tool success rate hints |
| `src/code/tools/dedup.js` | Per-turn duplicate short-circuit |
| `src/shared/verificationHarness.js` | Syntax, runLint/runTest, PLAN verify |
| `src/code/context/gemmaHarness.js` | Gemma message adaptation |

## Session resume

Incomplete runs persist under `<userData>/code-sessions/`. IPC: `code-list-sessions`, `code-resume`. UI shows a resume banner when a resumable session exists for the workspace.

## Harness docs

See [`docs/harness/HARNESS_CHECKLIST.md`](docs/harness/HARNESS_CHECKLIST.md) and [`docs/harness/WHEN_TO_REMOVE.md`](docs/harness/WHEN_TO_REMOVE.md).

## Activity timeline (inline chat)

Code runs stream structured activity into `#messages` — turn headers, collapsible thinking, in-place tool rows, and inline file diffs — styled with the **Matrix terminal theme** (`src/renderer/styles/base.css` tokens only):

| UI element | Module | `code-event` types |
|------------|--------|-------------------|
| Turn header | `src/renderer/timeline/activityTimeline.js` | `turn_start` |
| Thinking block (collapsible) | same | `delta` |
| Tool rows (running → ok/fail in place) | same | `tool_start`, `tool_result` |
| Inline file diffs | `src/renderer/timeline/diffView.js` | `tool_result.result.fileDiff` |
| Event normalization | `src/renderer/timeline/eventAdapter.js` | all |

Tool rows use `.agent-log` + category badges (read / search / write / shell). Patch and `write_file` results include a per-edit unified diff from `editEngine` / `changeLedger.buildFileDiffResult`.

Post-run session diff + **Revert All** remains in the sidebar `#code-review-mount`.

## Desktop vs web parity

| Capability | Electron desktop | LAN / mobile web |
|------------|------------------|------------------|
| Start/stop Code run | `code-run` / `code-stop` IPC | `/api/invoke` proxy |
| Live tool timeline | `code-event` via `ipcRenderer.on` | `GET /api/events` SSE (same payload) |
| Resource warnings | `resource-update` IPC | SSE |
| WhatsApp QR / status | IPC push | SSE |
| Plugin UI toasts | `plugin-ui-event` | SSE |

Web clients use the polyfill in `src/renderer/app.js`: `api.on(channel, cb)` opens an `EventSource` to `/api/events?token=…` and dispatches named SSE events. Desktop Electron is unchanged — no duplicate delivery on desktop because the web polyfill is not loaded when `window.api` comes from preload.

## Completion gate (verify before done)

When the model tries to finish without tool calls, Code Mode runs `checkCompletion` on all touched files:

- `node --check` for `.js` files
- Heuristics for truncated files (unbalanced braces, broken template literals like `repeat(${n}` without backticks)
- Web projects: ensures `index.html` script/link refs point at files that exist

If checks fail, a `[COMPLETION BLOCKED]` user message is injected and the loop continues (up to 3 reflections). Write/patch tool results also include immediate `warnings[]` when issues are detected.

Reference web game: `examples/pacman/` (open `index.html` in a browser).

## Verification

```bash
npm test
npm run harness-eval
npm run ship-check
node scripts/code-smoke.js
node scripts/verify-main-ipc.js
```
