# When to Remove Harness Components

> Every harness component exists because the model can't do something yet.
> Document what capability improvement would make this component unnecessary.

| Component | Exists because | Can be removed when |
|---|---|---|
| `completionGate` truncation heuristics | Small models truncate files and break template literals | Model reliably emits complete files with valid syntax on first write |
| `completionGate` web validators | Model mismatches CSS selectors, HTML refs, map dimensions | Model consistently cross-checks DOM/CSS/JS before stopping |
| `gemmaHarness` message folding | Gemma mishandles system + tool JSON in native format | Native tool_calls reliable on target Gemma builds |
| `extractor.js` JSON-in-prose | Model emits tool JSON outside native `tool_calls` | LM Studio / model always returns structured tool_calls |
| `dedup.js` per-turn | Model repeats identical tool calls in one turn | Duplicate calls rare enough that earlyStop alone suffices |
| `earlyStop.js` max turns | Runaway loops on weak models | Model reliably completes or stops within ~15 turns |
| `planAnchor` + `.agentsmith/` | Inline context forgets goal mid-run | Model maintains task state without file artifacts (unlikely on 7B) |
| Phase-gated tools (`phases.js`) | Model writes before reading | Model explores then implements without phase enforcement |
| `acceptance.js` game checks | Game tasks need domain-specific static validation | General web validators catch all game failures |
| `smokeTest.js` jsdom/vm | Static checks miss runtime JS errors | Headless browser smoke redundant with perfect static analysis |
| Agent write blocklist | User wants shell/read without accidental edits | Separate profiles unnecessary if unified registry enforces caps |
| Change ledger + Revert All | Auto-run without HITL | User accepts pre-approval workflow instead (product decision) |
| `postEditChecks` | Model ignores syntax/lint until done | Model fixes issues on first tool warning without post-edit sensors |
| `projectRules` | Repo-specific invariants not in AGENTS.md | Custom linters in CI replace `.agentsmith/rules/` |
| Grind until green | Model stops before lint/test pass | Model reliably runs and fixes tests without completion enforcement |
| `beforeDone` hooks | Extension point for plugins/custom veto | N/A — keep as stable API |
| `browser_verify` | Static validators miss runtime DOM/console errors | Playwright E2E in CI makes headless verify redundant |

---

*Update this table when adding or retiring harness guards.*
