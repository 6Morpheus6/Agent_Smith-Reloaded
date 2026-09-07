# Coding-Capability Tier 1 — Implementation Spec

**Date:** 2026-06-04
**Source:** `docs/CODING_CAPABILITY_AUDIT.md` (Tier 1 + the per-language verification from Tier 2, per owner choice).
**Decisions:** Keep all tools in the roster (no gating). Verification = honest labeling **and** per-language syntax checks.

All engines are unit-testable in plain node; each change ships with a test (`tests/codingTier1.test.js`).

## 1. Context layer — `contextBuilder.js`

- **1.1 Line numbers.** `readFileExcerpt` prefixes every line with its real number (`${n}\t${line}`). The model can now address "line 42" and build accurate `edit_file` find-blocks.
- **1.2 No silent middle-drop.** On overflow, keep a *contiguous* numbered head window of whole lines that fit, then append an explicit marker: `... [lines X–Y of Z omitted — use read_file start/end to view] ...`. Never head+tail (which hid the edited region and looked complete).
- **1.3 Honest token budget.** `CHARS_PER_TOKEN 3.5 → 2.5` (code tokenizes denser). After assembly, a hard fit-check trims messages **from the end** until total ≤ `promptBudget`, but **never** removes message 0 (system + plan digest). Removes the silent front-truncation of the protected digest.
- **6.1 Coding doctrine prompt.** Replace the "fire a tool every turn" wall with real doctrine: read before edit, prefer small targeted `edit_file` diffs over rewriting whole files, run/verify before `mark_step_done`, match existing style, never leave placeholders. Keep one anti-laziness line.
- **6.2 Shell-aware.** New `options.shell` ('powershell' | 'bash') surfaced in the prompt so the model uses correct shell syntax. Passed from `agentLoop` (`navigator.platform`).

## 2. Verification — `lib/verificationHarness.js` + `main.js`

- **2.1 Per-language syntax checks**, availability-gated by *running* the checker and treating "tool missing" (ENOENT / "not recognized" / "not found") as a **skip**, not a failure:
  - `.js/.cjs/.mjs` → `node --check` (existing); `.json` → `JSON.parse` (existing).
  - `.py` → `python -m py_compile` (fallback `python3`).
  - `.ts/.tsx/.mts/.cts` → `tsc --noEmit --skipLibCheck --isolatedModules <file>` (best-effort local syntax).
  - `.go` → `gofmt -e` (pure syntax, no build deps). `.rb` → `ruby -c`. `.php` → `php -l`.
  - else → `{ok:true, skipped:true}`.
- **2.1 Honesty.** `runVerification` returns `unverified: (!lintCmd && !testCmd && checked === 0)`. When unverified, `main.js`'s `agent-verify` does **not** stamp `verifiedAt` (no false `[verified]`), and the model is told plainly: "No automated verification available for these files — proceeding unverified; confirm correctness manually." A genuinely-unverifiable step is still allowed through (we can't gate on an impossible check), but it never *claims* verification.

## 3. Edit engine — `editEngine.js` + `lib/editFormats.js`

- **4.1 CRLF + BOM safety.** `editEngine.apply` detects a leading BOM and CRLF-majority line endings, normalizes to LF (and strips BOM) for matching, applies the edit, then restores the file's original EOL and BOM on write. Fixes silent CRLF→LF corruption on every Windows edit and lets LF find-blocks match CRLF files.
- **4.1 Tolerant-window cap.** The whitespace-tolerant matcher's fixed 40-line window becomes `find`-line-count + margin (min 40), so multi-line find blocks >40 lines can match.

## 4. Tools — `agentLoop.js`

- **5.4 Empty-write guard.** `write_file` with empty content returns an error (a mis-keyed arg silently wrote an empty file and reported success — data loss).
- **3.3 Tool-call cap.** `slice(0,4) → slice(0,8)`; if the model emitted more, append a tool message telling it which calls did **not** run (no silent drop).
- **6.2 sudo gating.** The `sudo → echo|sudo -S` rewrite only runs on non-Windows.
- **6.2 `run_shell_command` description** made shell-neutral and accurate (no false "bash"/"sudo" claim).

## 5. Memory — `memory.js`

- **1.7 Similarity floor.** `queryVectors` drops hits below a modest floor (default 0.35, tunable) so low-relevance snippets aren't injected as authoritative memory. Floor logic is a pure, exported helper for testing.

## Deferred to a later pass (noted, not done here)
- Unified-diff applier fail-loud on context mismatch (4.2), `add_steps`/`replan` (3.1/3.2), `fetch_url` (5.1), background-process control (5.3), repo-map cache/scaling (1.5/1.6), research subagent (5.2), embeddings fallback to `/v1/embeddings` (1.8). These are Tier 2/3.

## Verification
`npm test` (existing suite stays green) + new `tests/codingTier1.test.js`.
