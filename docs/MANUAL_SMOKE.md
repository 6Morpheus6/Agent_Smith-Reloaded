# Manual Smoke Checklist

Run after harness or UI changes. Requires LM Studio (or compatible server) at `http://127.0.0.1:1234` unless noted.

## Automated substitutes (no GUI)

```bash
npm test
npm run harness-eval          # regression + capability
npm run harness-eval-regression
npm run harness-security
npm run ship-check          # includes greenfield-smoke.js
node scripts/readiness-report.js .
node scripts/verify-main-ipc.js
```

## Desktop — Code Mode greenfield

1. `npm start`
2. Load a coding model in LM Studio
3. Create an **empty folder**; click **📍 Here I am** and select it
4. Enable **CODE MODE**
5. Send: `Build a web Pac-Man game in HTML, CSS, and JavaScript`
6. **Expect:**
   - Live tool timeline rows (turn headers, tool_start/result, diffs)
   - **Not** a 1-turn exit with zero tool calls
   - No false ✅ if zero files written
   - `verify_blocked` or reflection if model tries prose-only exit
   - `.agentsmith/PLAN.md` for non-trivial build (check workspace folder)
7. After run: sidebar **Revert All** restores byte-exact pre-run state

## Desktop — Grind until green

1. Open a Node project with `scripts.lint` and `scripts.test` in `package.json`
2. Enable **CODE MODE** and **GRIND UNTIL GREEN** (default on)
3. Prompt: add a small file with an intentional lint issue
4. **Expect:** post-edit `sensor_result` / warnings on tool row; completion blocked until lint/tests pass
5. **Revert All** still restores pre-run state

## Desktop — Readiness chip

1. `npm start`; set workspace via **📍 Here I am** (any folder with `package.json` or `README.md`)
2. Enable **CODE MODE**
3. **Expect:** below the Code Mode toggles, a line like `Readiness: 26/40` (hidden if no project root)
4. CLI cross-check: `node scripts/readiness-report.js <that-folder>` — score should match the chip

## Desktop — Isolated run (git worktree)

Requires a **git repo** at the workspace root (`git init` is enough for smoke).

1. Open a git-backed project; enable **CODE MODE** and **ISOLATED RUN**
2. Prompt: a small change (e.g. add a comment to one file)
3. **Expect:**
   - Run uses a worktree under `.agentsmith/worktrees/<session-id>/` (not the main checkout)
   - Timeline may show `worktree_created` on `code-event`
   - Main branch working tree unchanged until you merge or copy from the worktree
4. **Revert All** still reverts ledger snapshots for the run’s `sessionId`
5. After run completes, worktree branch `agentsmith/run-<id>` is cleaned up automatically

## Desktop — Parallel milestones (sequential subagents)

1. Use an empty or greenfield folder; enable **CODE MODE** and **PARALLEL MILESTONES**
2. Prompt: a non-trivial build (e.g. `Build a todo app with HTML, CSS, and JS`)
3. **Expect:**
   - `.agentsmith/PLAN.md` created with **3+ milestones** (default template qualifies)
   - Timeline shows `subagent_start` / `subagent_done` per open milestone before final done
   - Parent run merges touched files and runs completion gate once at the end
4. v1 is **sequential** (one milestone loop at a time), not parallel processes

## Desktop — Milestone worktrees (v2)

Requires **git** initialized in the workspace.

1. Enable **CODE MODE**, **PARALLEL MILESTONES**, and **MILESTONE WORKTREES**
2. Prompt: non-trivial build (3+ PLAN milestones)
3. **Expect:** each `subagent_start` includes `worktreePath`; files sync to main checkout after each milestone; worktree cleaned up
4. Optional: **CONCURRENT MILESTONES** — only if LM backend can handle parallel requests
5. **ISOLATED RUN** is ignored when milestone worktrees are on (isolation is per-milestone)

## Desktop — Agent Mode

1. Enable **AGENT (SYS-ACCESS)** (Code off)
2. Ask to `write_file test.txt` → must show **[BLOCKED]** or equivalent
3. Ask to `run_shell_command dir` (Windows) or `ls` → should execute

## Desktop — Preview panel

1. Open workspace with `examples/pacman/` (or after a greenfield build with `index.html`)
2. CODE MODE or AGENT: ask model to `show_preview` with `kind: project_file`, `target: index.html`
3. **Expect:** sidebar PREVIEW drawer with playable iframe
4. AGENT: `web_search`, then `show_preview` with `kind: web_url` and a result URL → PNG snapshot
5. ADVANCED → enable **DESKTOP PREVIEW** → `show_preview` `kind: screenshot`, `scope: window` → source picker → PNG

## Web / mobile (LAN)

1. Open **ADVANCED → CONNECT** (or use the composer 📱 QR) for the LAN / remote URL
2. Open URL on phone (same Wi‑Fi)
3. Log in if auth enabled
4. Repeat Code Mode steps above
5. **Expect:** live timeline updates during run (SSE `/api/events`), not only final summary

## Auth errors (web)

1. Open LAN URL without logging in
2. Attempt an action requiring auth
3. **Expect:** visible system message (not silent failure)

---

*Record pass/fail and date in `docs/AUDIT_REMEDIATION.md`.*
