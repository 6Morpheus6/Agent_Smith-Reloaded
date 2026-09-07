# Agent Smith Coding-Capability Audit

**Date:** 2026-06-04
**Method:** 4 parallel readers across the agent loop, context builder, edit/verify engines, and tool surface; the Critical findings were re-validated against source by hand.
**Scope:** Build Mode (`agentLoop.js` + `contextBuilder.js` + engines). Not the legacy chat path.

> **Status (2026-06-04): Tier 1 IMPLEMENTED** (v42.1.0) — 1.1, 1.2, 1.3, 1.7, 1.9, 2.1, 2.3, 3.3, 4.1, 5.4, 6.1, 6.2. **Perf fix** (v42.2.0) — 1.6 (repo-map cache) + the per-token render freeze. **Tier 2 IMPLEMENTED** (v42.3.0) — 1.4 (light: auto-promote read files), 1.8 (embeddings fallback), 2.2 (per-step syntax gate), 3.1 (`add_steps`), 3.2 (retry-then-skip), 3.4 (read-only stall exemption), 4.2 (diff fail-loud), 5.1 (`fetch_url`), 5.3 (background-process control). Tests: `tests/codingTier1.test.js`, `tests/perfFreeze.test.js`, `tests/codingTier2.test.js` (suite now 67). Still open (Tier 3 / lower priority): 1.5, 2.4, 3.5, 4.3, 4.4, 4.5, 4.6, 4.7, 5.2 (research subagent), 5.5, 5.7, chat-path render throttle. Specs under `docs/superpowers/specs/`.

## TL;DR — what's actually blocking "production-agent level"

The durable-plan design is sound: state is harness-owned and the *forgetting* problem is genuinely solved. The blockers are **not** about memory — they're about **adaptivity, verification honesty, and the file layer the model edits against.** Six themes, in priority order:

1. **The model edits blind.** File excerpts have no line numbers, are truncated in the *middle* (where the code being edited usually is), and the token budget is a char-count guess that can silently overflow `num_ctx` and front-truncate the very plan digest the design promises to protect.
2. **"Verified" is frequently a lie.** Only `.js`/`.json` are syntax-checked; Python/TS/Rust/Go/HTML pass with zero checks. Intermediate steps aren't gated at all by default. So the agent marks broken code "done."
3. **The plan can't adapt.** It's frozen at approval — no add-step/re-plan. A blocked step skips forward and strands its dependents; 3 blocks kill the whole plan.
4. **Edits silently corrupt or fail on Windows.** No CRLF/BOM handling (the owner's OS!); the hand-rolled diff applier consumes-to-EOF without erroring; large new-file scaffolding dead-ends.
5. **Tool-surface gaps.** No URL fetch (can't read docs → hallucinated APIs), no subagent/parallelism, broken background-process lifecycle (no kill/status), non-coding tools dilute selection.
6. **The system prompt teaches "fire a tool," not "code well."** No read-before-edit / small-diff / verify doctrine; tells the model it's driving bash on a Windows machine.

---

## Theme 1 — The model edits blind (context layer)

| # | Sev | Finding | Evidence |
|---|-----|---------|----------|
| 1.1 | **Critical** | File excerpts carry **no line numbers**; `agent-read-file` is called with no range, so the model can't address "the second handler" and `edit_file` search strings hit the wrong occurrence on repeated lines (`});`, imports). | `contextBuilder.js:81-90,162,175` |
| 1.2 | **Critical** | Truncation keeps head+tail and **drops the middle** — exactly the region being edited. Model sees an apparently-complete file (no line numbers to reveal the gap) and edits against the wrong part. | `contextBuilder.js:85-88` |
| 1.3 | **Critical** | Token budget = `String.length / 3.5`. Code tokenizes ~2.0–2.8 chars/token, so the estimate **over-fills**; the server then truncates from the front — message 0, the "never dropped" digest. No hard fit-check before returning. | `contextBuilder.js:5-9,105,189-205` |
| 1.4 | High | File **selection** is `activeFiles + last 6 ledger keys + step's touched files`. A dependency the model must read *but hasn't edited yet* (the interface it implements, the caller it must not break) is invisible unless it `add_files`-es it — which small models rarely do. | `contextBuilder.js:152,168-169` |
| 1.5 | High | Repo map caps at 25 files / 120 tree lines / skips files >100KB; regex-only symbols miss arrow-consts, class methods, TS `type`/`interface`, default exports. Doesn't scale to a 50-file project. | `lib/repoMap.js:65,84,127,131` |
| 1.6 | High | Repo map + every active/ledger file are **re-read from disk every turn**, no cache. fs storm + token tax that crowds out working memory. | `contextBuilder.js:136-146,159-177`; `main.js:685-689` |
| 1.7 | High | Memory retrieval has **no similarity floor** — top-K cosine injects low-relevance snippets as authoritative `[LONG-TERM MEMORY]`, and the text is sliced mid-sentence. | `memory.js:160-171`; `contextBuilder.js:200-203` |
| 1.8 | High | Embeddings hard-depend on **Ollama :11434**; an LM-Studio-only user (the documented default) gets silent embedding failure → memory is permanently empty. | `memory.js:27,91-99,162` |
| 1.9 | Med | Budget **accounting drift**: `used += lastToolReceipt.length` but only 8000 chars are sent; `fileBlocks.join('')` omits separators/headers. Over/under-charges, compounding 1.3. | `contextBuilder.js:181-187` |

## Theme 2 — "Verified" is frequently a lie (verification)

| # | Sev | Finding | Evidence |
|---|-----|---------|----------|
| 2.1 | **Critical** | Syntax-check fallback only covers `.js/.cjs/.mjs/.json`; **every other extension returns `{ok:true, skipped:true}`**. When all touched files are non-JS, `checked===0` → `runVerification` returns `ok:true` → step reported `[verified]` with zero real checks. | `lib/verificationHarness.js:10-26,79-88` |
| 2.2 | **Critical** | Default `verifyPolicy:'block'` is *not* `'strict'`, so `mark_step_done` only hard-gates the **final** step; intermediate steps pass with a scratchpad warning. 5 steps of latent breakage pile up, then must be fixed within 3 reflections. | `planStore.js:40`; `agentLoop.js` mark_step_done gate (`verifyPolicy==='strict' || isFinalStep`) |
| 2.3 | Med | `node --check` validates **syntax only** — not imports, not TS types (`.ts/.tsx` aren't checked at all). `import {x} from './missing.js'` "passes." | `lib/verificationHarness.js:14-15` |
| 2.4 | Low | Fixed 120s verify timeout is treated as a *failure*; slow-but-correct suites get force-blocked. | `lib/verificationHarness.js:44` |

## Theme 3 — The plan can't adapt (agent loop)

| # | Sev | Finding | Evidence |
|---|-----|---------|----------|
| 3.1 | **Critical** | No `add_steps`/`amend_plan`/`replan` tool. Once approved, the agent is locked to exactly N steps in order. It cannot grow the plan as it learns — the single biggest ceiling on multi-step quality. | `agentLoop.js` PLAN_TOOLS; `planStore.js` (no append method) |
| 3.2 | **Critical** | `mark_step_blocked` only **skips forward** and never retries; dependents run against missing scaffolding and cascade-fail; 3 consecutive blocks fail the whole plan, discarding completed work. | `agentLoop.js` mark_step_blocked + consecutive-block ceiling |
| 3.3 | **Critical** | Hard `toolCalls.slice(0, 4)` **silently drops** the model's 5th+ calls with no feedback → state drift (model "knows" it wrote a file that doesn't exist). | `agentLoop.js` execution + planning slices |
| 3.4 | High | Stall detection blocks the step after 8 prose turns, and a second counter blocks when `filesLedger` is unchanged — so **legitimate multi-file reading before editing** looks like a stall and gets killed. | `agentLoop.js` stall counters; `READ_ONLY_TOOLS` exists but isn't exempted |
| 3.5 | Med | Planning aborts after **one** nudge / 6 turns, and whatever `submit_plan` emits (even "build the app" as one step) is accepted with no quality gate. | `agentLoop.js` runPlanningPhase |

## Theme 4 — Edits silently corrupt or fail (edit engine)

| # | Sev | Finding | Evidence |
|---|-----|---------|----------|
| 4.1 | High | No **CRLF/BOM** handling. On Windows (owner's OS), an LF `find` block misses the exact path; the whitespace-tolerant path then rebuilds the file with `\n`, **converting CRLF→LF on every edit**. `find` blocks >40 lines can never match. | `lib/editFormats.js:6-35`; `editEngine.js:62,78` |
| 4.2 | High | Unified-diff applier is hand-rolled: a `-`/context line that doesn't match **consumes to EOF**, silently corrupting the file, and still returns "Patch applied." | `lib/editFormats.js:110-130,141-142` |
| 4.3 | High | `write_file` >64KB routes to `edit_file`/`apply_patch`, which **cannot create a new file** (`edit_file` needs a match; `apply_patch` IPC passes no `allowCreate`). Large-file scaffolding dead-ends. (Cap is 64KB, not the ~8KB PROTOCOL.md claims.) | `editEngine.js:38,116-123`; `main.js:718` |
| 4.4 | High | grep node-fallback compiles the model's pattern as a **raw RegExp** — literal strings with metachars (`app.use(`, `Array<string>`) give wrong results or an uncaught `SyntaxError`. ripgrep isn't bundled, so this is the default path on Windows. | `lib/grepTool.js:59,100-107` |
| 4.5 | Med | Review diff uses a non-LCS greedy walker → a one-line insertion marks all following lines as churn. The diff/revert panel is the only recovery in this non-git repo. | `changeLedger.js:90-110` |
| 4.6 | Med | Path sandbox only traversal-checks **relative** paths; an absolute `C:\Windows\...` / `/etc/passwd` bypasses containment entirely. Case-sensitive on a case-insensitive FS. | `projectContext.js:111-117` |
| 4.7 | Med | `*.js` glob in the node fallback anchors the **full path**, so it only matches root files — recursive matches silently missed → false "not found." | `lib/grepTool.js:8-10` |

## Theme 5 — Tool-surface gaps (vs leading coding agents)

| # | Sev | Finding | Evidence |
|---|-----|---------|----------|
| 5.1 | **Critical** | **No URL fetch tool.** `web_search` returns only 6 title+snippet+url triples; the model can never open a docs/API page → hallucinated APIs on a small model. | `agentLoop.js` web_search; `main.js:989-1042` |
| 5.2 | **Critical** | **No subagent/Task dispatch** — zero parallelism or context isolation. Every exploratory read competes for the same tight `num_ctx` that holds the plan and edits. | no task tool in PLAN_TOOLS |
| 5.3 | High | Background-process lifecycle is broken: **no kill/stop tool**, `read_process_log` exposes no `running`/`exitCode`, and a foreground long-runner (forgot `is_background`) hangs the turn with no timeout. Can't do start-server→poll→curl→kill. | `main.js:458-503,487-494` |
| 5.4 | High | `write_file` with no content guard defaults to `''` → a mis-keyed arg writes an **empty file** and returns "Success" (data loss). | `agentLoop.js` write_file (`args.content ?? args.text ?? args.code ?? ''`) |
| 5.5 | Med | `apply_edits` is **not atomic** — a mid-batch failure leaves the file half-modified. (Leading agents' MultiEdit is all-or-nothing per file.) | `agentLoop.js` apply_edits; `editEngine.js:105-114` |
| 5.6 | Med | Non-coding tools (`send_whatsapp_message`, `provide_file_download_link`, `dynamic_schema_generate` — a near no-op) sit in the execution toolset every turn, increasing small-model mis-selection. | `agentLoop.js` PLAN_TOOLS; `contextBuilder.js:113` |
| 5.7 | High | Auto-commit uses `git commit --allow-empty` → empty checkpoints pollute history and make `undoLast` (`reset --hard HEAD~1`) destroy a real prior step. | `lib/gitIntegration.js:42,53` |

## Theme 6 — System prompt teaches the wrong thing

| # | Sev | Finding | Evidence |
|---|-----|---------|----------|
| 6.1 | High | The prompt is 5 lines of "MUST use a tool in EVERY response" with **no** read-before-edit / small-diff / verify / match-style doctrine. A 7B model takes this literally and `write_file`s over files it never read. | `contextBuilder.js:108-116` |
| 6.2 | High | `run_shell_command` tells the model it's driving **bash** ("Sudo is handled…") while the app runs **PowerShell on Windows** — guaranteeing wrong shell commands (`ls`, `rm -rf`, `&&`, `sudo`). | `agentLoop.js` run_shell_command desc + sudo rewrite |

---

## Recommended fix sequence (impact ÷ effort)

**Tier 1 — high impact, low effort (do first):**
- Line-number every injected file excerpt (1.1).
- Stop middle-of-file truncation; center the window on the edit region, with line ranges (1.2).
- Token budget: drop to ~2.5 chars/token for code + a hard fit-check that never evicts message 0 (1.3).
- Verification honesty: when `checked===0` or files are non-JS, report **"unverified — no check available"** instead of `[verified]` (2.1).
- Rewrite the system prompt with real coding doctrine; make it shell-aware; trim non-coding tools from the execution roster (6.1, 6.2, 5.6).
- Raise/remove the 4-call cap, or tell the model which calls didn't run (3.3).
- Reject empty `write_file` content (5.4). CRLF/BOM handling in the edit path (4.1).
- Memory similarity floor (1.7).

**Tier 2 — high impact, structural:**
- `add_steps`/`amend_plan` tool + retry-blocked-step instead of skip-and-strand (3.1, 3.2).
- Per-step verification by default + real per-language syntax fallbacks (`py_compile`, `tsc --noEmit`, `go build`, `cargo check`) (2.1, 2.2).
- `fetch_url` tool routed through `lib/netGuard.js` (5.1).
- Background-process `stop`/`status` tools + foreground timeout (5.3).
- Make the unified-diff applier fail loudly on context mismatch (4.2); exempt read-only tools from stall counters (3.4).
- Auto-surface untouched dependency files via grep/repo-map hits (1.4); repo-map cache (1.6).
- Embeddings fallback to `/v1/embeddings` (1.8).

**Tier 3 — larger:**
- Read-only research **subagent** (5.2) — the highest-leverage structural gap, mirrors leading agents' Task tool.

## What's already good (don't break)
Harness-owned state (step status, ledger, decisions written from tool outcomes, never model prose); byte-exact snapshot revert; the plan digest as message 0; crash-resume; whitespace-tolerant edit matching with ambiguity rejection; the small-model text tool-call fallback.
