# Agent Smith Codex — The Rulebook

This document is the rulebook for AI agents building Agent Smith. Every commit, every feature, every refactor must serve the doctrine below. If a rule no longer serves the mission, **change the rule** — do not deviate silently.

Companion docs: [`AGENTS.md`](AGENTS.md) (navigation map), [`PROTOCOL.md`](PROTOCOL.md) (protocol/security detail), [`docs/architecture.md`](docs/architecture.md) (layout and deferred splits).

---

## 0. Mission Charter
*The runtime essence — the only part of this file loaded into the agent on every turn. Everything below §0 is development law for agents building Agent Smith itself, not carried in user missions.*

**Agent Smith is a Small-Model Code Agent.**

Three modes: **Chat** (conversation only), **Agent** (shell + read-only), **Code** (auto-run build loop). Code Mode runs in the main process with native guards: phase-gated tools, middleware, completion gate, and durable `.agentsmith/` plan files for long tasks.

The trust layer is not plan approval. Every file mutation is snapshotted (`changeLedger`). When a run finishes, the user sees a unified diff and **Revert All**. Code Mode auto-runs; the ledger makes that safe.

The five runtime laws:

*   **Ledger Is Trust.** Snapshot before every write/patch/delete. `ledger-revert-all` must restore byte-exact. Session id = ledger id.
*   **Modes Must Not Touch.** Chat, Agent, and Code have separate run state, abort controllers, and dispatch paths.
*   **Multi-Tool Turns.** Within a turn, execute tools until the model stops calling — with dedup, early stop, phase gates, and budget eviction.
*   **Local-Model Discipline.** Forgiving tool extraction, Gemma harness, compact prompts, `.agentsmith/` artifacts for long horizon.
*   **Finish or Stop.** Completion gate on every exit path; early stop on repeated errors or duplicate thrashing.

---

## 1. The Core Mandates
*Development law for agents building Agent Smith itself.*

*   **Code Mode Is the Product.** Chat is conversation-only permanently. New coding capability goes into `src/code/` and Code IPC only.
*   **Harness Owns Guards.** Early stop, dedup, budget, and ledger writes are code — not model prose.
*   **Mandate of the Trust Layer.** `changeLedger` snapshots before every write/edit/delete. `ledger-revert-all` must always work byte-exact.
*   **Mandate of Verification.** Every engine (`editEngine`, `planStore`, `contextBuilder`, `verificationHarness`, IPC registration) MUST have a unit or integration test. `npm test` + `npm run ship-check` + `node scripts/verify-main-ipc.js` must pass before any merge. GUI-only paths (`src/renderer/app.js` DOM) require manual `npm start` smoke until a headless harness exists.
*   **Mandate of Granularity.** No source file exceeds **800 lines**. Current violations are debt, not precedent:
    *   `src/renderer/app.js` (~2,350) — **split target #1** (was root `renderer.js`)
    *   `main.js` (~1,110) — bootstrap + inline OS/lifecycle; IPC already extracted
    *   `src/renderer/styles/base.css` (~1,560) — split by surface (login / sidebar / chat / build)
    *   `toolSchemas.js` + `toolExecutor.js` — migrate to colocated `src/agent/tools/<name>.js` modules
*   **Mandate of Honesty.** This codex tracks what works and what doesn't. The Weakness Registry (§6) reflects truth, not marketing. Over-engineering is acknowledged and scheduled for retirement, not hidden behind changelog enthusiasm.

---

## 2. Code Mode — Center of Power

Code Mode (`src/code/`) is the product surface for building. Chat is conversation-only; Agent adds shell + read-only tools in the chat path. Code Mode auto-runs in the main process with native guards.

The Code pipeline:

1.  **Run.** User enables CODE MODE, sets workspace (**📍 Here I am**), sends a build goal.
2.  **Turn loop.** `turnLoop.js` drives multi-tool turns with phase gates (explore → implement → verify), middleware, and budget eviction.
3.  **Mutate.** Tools run through `executor.js` → ledger snapshots before every write/patch.
4.  **Stream.** Desktop: `code-event` IPC. Web/mobile: `/api/events` SSE (same payloads).
5.  **Gate & finish.** `completionGate.js` blocks premature done; `.agentsmith/PLAN.md` + `IMPLEMENT.md` on non-trivial runs.
6.  **Review.** Unified diff in `#code-review-mount`; **Revert All** restores byte-exact state.

Supporting systems:

| System | Role | Location |
|---|---|---|
| Turn loop | Multi-tool turns + middleware | `src/code/loop/turnLoop.js` |
| Completion gate | Verify before done | `src/code/governor/completionGate.js` |
| Plan artifacts | Durable `.agentsmith/` files | `src/code/context/planArtifacts.js` |
| Change ledger | Snapshot + diff + revert | `src/main/services/changeLedger.js` |
| Activity timeline | Inline chat UI | `src/renderer/timeline/activityTimeline.js` |
| Gemma harness | Small-model compatibility | `src/code/context/gemmaHarness.js` |

**Small-model tuning.** Gemma gets system-prompt folding, tool JSON preamble, compact prompts. See `tests/gemmaHarness.test.js`.

---

## 3. The Trust Layer

Every edit Agent Smith makes must be discoverable, comparable, and undoable. This is mandate-level — not a nice-to-have.

*   **Auto-run with ledger** — Code Mode does not require pre-approval; trust = snapshots + review + Revert All.
*   **Per-file snapshots** — `changeLedger` records originals before write/edit/delete.
*   **Review diff** — end-of-run unified diff across all touched files (`#code-review-mount`).
*   **Revert All** — byte-exact restore from ledger snapshots.
*   **Session resume** — incomplete Code runs persist; resume banner when a checkpoint exists.

New editing tools or UI surfaces that bypass the ledger are **non-compliant**.

---

## 4. The Autonomous Workflow

When the user gives a build goal in **Code Mode**:

1.  **Detect intent.** Greenfield build tasks start in `implement` phase (`phases.resolveInitialPhase`).
2.  **Execute turns.** Rebuild context each turn; tools until model stops or gate blocks.
3.  **Verify.** `completionGate` runs syntax, web consistency, acceptance, smoke before done.
4.  **Review & close.** Show diff. User reverts or keeps.

When a read-only tool fits (`read_file`, `grep`, `glob`, `list_project`), call it directly. When an edit fails, the harness returns actionable feedback; reflections continue up to 3 times before incomplete exit.

---

## 5. Cleanup, Bloat & Final Form

### What bloat looks like today

Agent Smith accumulated features faster than it shed them. The v44 restructure **organized** the code; it did not **reduce** the product surface. Honest inventory:

| Area | Lines / scale | Verdict |
|---|---|---|
| `src/renderer/app.js` god file | ~2,350 | **Debt.** Chat tool stack removed; further DOM split still deferred. |
| Dual run paths | Build + Chat | **Shrinking (v44.2).** Chat tool stack deleted; Build Mode is the sole tool surface. |
| Four-place tool wiring | schema + executor + IPC + preload | **Shrinking.** Registry + integrity test exist; colocated tool modules are the target. |
| `main.js` inline integrations | ~850 lines | **Shrinking.** WhatsApp extracted; Piper TTS removed; web server / Cloudflare / GPU still inline. |
| Legacy CLI | deleted | **RESOLVED (v44.2)** |
| `ghosttrace/` | separate trace pipeline | **Peripheral.** Useful for diagnostics; not core. Keep small or fold into a plugin. |
| Smith persona / Matrix theme | persona prompts (`src/shared/smithPersona.js`) | **Cosmetic layer.** Fine for Chat Mode branding; must not pollute Build Mode prompts (especially Gemma). (Login fight / bg / audio easter eggs were removed as bloat.) |
| Plugin system | manager + host + installer + hooks | **Justified IF used.** Extends execution without four-place edits. Bloat if no real plugins ship. |
| Vector memory | LM Studio embeddings (`/v1/embeddings`); Ollama optional legacy fallback | **Single stack.** Load an embedding model in LM Studio. Acceptable if memory measurably helps builds; bloat if never retrieved in traces. |
| Dual model router | separate Planner / Editor selectors | **Justified for quality.** Bloat if both slots always run the same model. |

### Retirement doctrine

Before keeping or adding a feature, answer:

1.  Has this been used in **real Build Mode traces** in the last N sessions?
2.  Does it amplify the **plan loop** or the **Trust Layer**?

If **no** to both → retire. Prefer **removal over deprecation** — deprecation grows surface area indefinitely. If the idea has merit, a **plugin** can resurrect it without bloating core.

### Final form (target architecture)

Agent Smith's final form is **not** "more features." It is **one sharp loop** with a thin shell:

```
┌─────────────────────────────────────────────────────────┐
│  Electron shell (thin)                                  │
│  ┌─────────────┐  ┌──────────────────────────────────┐│
│  │ Sidebar     │  │ Build surface                    ││
│  │ - model     │  │ - plan drawer (approve/edit)     ││
│  │ - workspace │  │ - inline tool timeline           ││
│  │ - plugins   │  │ - review + revert                ││
│  └─────────────┘  └──────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
         │ IPC (whitelist: ipcChannels.js)
         ▼
┌─────────────────────────────────────────────────────────┐
│  Main process — services only                           │
│  planStore · editEngine · changeLedger · projectContext │
│  verificationHarness · pluginHost (generic invoke)      │
└─────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────┐
│  Renderer agent (bundled)                               │
│  loop/* · context/* · state/* · tools/* (colocated)     │
└─────────────────────────────────────────────────────────┘
```

**Final-form checklist:**

| Target | Status | Action |
|---|---|---|
| Single product path (Build Mode) | **done (v44.2)** | Chat tools removed; Build Mode owns tool surface |
| Plan-on-disk memory | **done** | Protect invariant |
| `app.js` split into `src/renderer/{bootstrap,chat,build}.js` | deferred | DOM modules + manual smoke |
| One tool = one file (`src/agent/tools/`) | started | Migrate off four-place rule |
| Integrations (WhatsApp, TTS, GPU) → plugins or out | partial | WhatsApp + TTS in `src/main/lifecycle/` |
| Legacy CLI deleted or rewritten | **done (v44.2)** | `cli/index.js` + `cli/tools.js` deleted |
| No file > 800 lines | failing | Track in Weakness Registry |
| GUI headless smoke harness | not started | `tests/ui/` or Playwright-lite |
| Login / Matrix chrome optional | not started | Settings flag or separate entry |

### Continuous cleanup

*   Audit every release for loose screws — orphaned files, stale docs, duplicate tool paths, dead IPC channels.
*   `CHANGELOG.md` history before v41 can stay archived; README should describe **current** Agent Smith, not ten version highlight blocks.
*   Root stays minimal: Electron entry (`main.js`, `preload.js`, `index.html`, assets), `src/`, `tests/`, `scripts/`, `docs/`, `dist/` (generated). Everything else earns its directory.

---

## 6. The Weakness Registry

The honest status of Agent Smith. Features claimed but never exercised in real Build Mode traces are **weaknesses, not strengths**.

### Active weaknesses (gate further feature work)

1.  **`src/renderer/app.js` God File.** ~2,350 lines of DOM, chat, sidebar, settings, and build UI in one script. Blocks AI-assisted maintenance, hides bugs, and duplicates patterns already split in `src/code/`. **No new renderer logic in `app.js`** — new UI goes in `src/renderer/` modules; migrate existing code incrementally.
2.  **Dual Run Paths.** ~~Build Mode (tested, plan-backed) and Chat Mode (legacy, transcript-backed) share the app but not the architecture.~~ **PARTIAL (v44.2)** — Chat Mode tool stack deleted; chat is conversation-only. Build Mode is the sole tool surface. Transcript pruning in chat remains legacy but harmless.
3.  **Four-Place Tool Wiring (residual).** Registry + integrity test exist, but most tools still live across `toolSchemas.js`, `toolExecutor.js`, IPC, and preload. Each new tool is four edits — drift waiting to happen. **Colocate** per `src/agent/tools/readFile.js` pattern until the old files are thin re-exports.
4.  **GUI Untested.** 304 node tests cover engines; zero cover `src/renderer/app.js` DOM, plan drawer interactions, or mobile web layout. IPC is structurally verified (`verify-main-ipc.js`); UI is not. **Manual `npm start` smoke is mandatory** for renderer changes until a headless harness lands.
5.  **Integration Sprawl in `main.js`.** WhatsApp and TTS moved to `src/main/lifecycle/*` (v44.2). Web server, Cloudflare tunnel, GPU telemetry, and Netrunner search still inline. **Extract or cut** the remainder.
6.  ~~**Legacy CLI Rot.**~~ **RESOLVED (v44.2)** — `cli/index.js` and `cli/tools.js` deleted. `cli/cli-build.js` + `cli/standalone-server.js` remain; GhostTrace → `scripts/ghosttrace-cli.js`.
7.  **Local-Model Tool-Use Fragility.** Small models emit tool calls as prose, nested JSON, or one-shot then stop. Mitigations exist (Gemma harness, `extractToolCallsFromText`, repair hints) but this remains the #1 user-visible failure mode. **Harness work beats prompt work.**

### Shrinking weaknesses (restructure in progress)

8.  ~~**Flat layout / god files in agent loop.**~~ **RESOLVED (v44)** — `src/` tree, `agentLoop.js` decomposed into `loop/*`, IPC extracted to `src/main/ipc/*`, esbuild bundle, tool registry + integrity test.
9.  ~~**Root shim clutter.**~~ **RESOLVED (v44.1)** — 33 re-export shims deleted; requires repointed to `src/`. Legacy CLIs moved to `cli/`.
10. ~~**IPC monolith in `main.js`.**~~ **RESOLVED (v44)** — ten domains extracted; bootstrap stays at root for `__dirname`.

### Resolved weaknesses (patterns still load-bearing)

1.  **Forgetting mid-task:** RESOLVED — plan object on disk + context rebuild every turn; autosave after each tool call.
2.  **Edit blind truncation:** RESOLVED — full file in context when budget allows; failing test output keeps tail.
3.  **Step never advances:** RESOLVED — harness-owned `mark_step_done`; verify step no longer wipes activity counter; turn budget scales with plan size.
4.  **Silent edit failures:** RESOLVED — editEngine returns closest-region feedback; 3 retries before block.
5.  **Tool schema / IPC drift:** RESOLVED (infra) — `src/shared/ipcChannels.js` + `tests/codeToolRegistry.test.js`; per-tool colocation still in progress.
6.  **Gemma system-prompt ignored:** RESOLVED — `gemmaHarness` folds system into first user turn; compact Build Mode prompts.
7.  **Sidebar plan invisible:** RESOLVED (v43) — plan drawer with full scrollable steps; approval can't be missed.
8.  **Plugin crash on startup:** RESOLVED — broken plugins quarantined; generic `plugin-invoke-tool` IPC.

---

## 7. Comparison — Agent Smith vs GhostCode

Both projects share an owner and a local-first philosophy. They are **not** the same agent:

| | Agent Smith | GhostCode |
|---|---|---|
| **Identity** | Durable Plan Agent | Origami Agent |
| **Center of power** | Plan loop + ledger | Forge + kernel |
| **Memory** | Plan JSON on disk | Almanac + code index |
| **Shape** | Fixed tool surface + plugins | Folds new tools on demand |
| **Shell** | Electron desktop + mobile web | TUI |
| **Target model** | 7B–14B Gemma/Qwen via LM Studio | 14–30B local |
| **Bloat risk** | Feature accretion (integrations, dual paths) | Fixed-shape patterns that never earned use |

Agent Smith should **not** adopt GhostCode's Forge. It should adopt GhostCode's **discipline**: Mastery over Bloat, retirement over deprecation, honesty in the Weakness Registry, and a single center of power.

---

## 8. Doctrine for AI Assistants Working This Repo

When you touch Agent Smith:

1.  Read [`AGENTS.md`](AGENTS.md) first — folder map and the four-place checklist.
2.  Run `npm test` + `npm run ship-check` before claiming done.
3.  **Do not add features** to Chat Mode, `main.js` inline integrations, or `src/renderer/app.js` without explicit user request.
4.  **Do not reintroduce** a Chat Mode tool stack — tools belong in Build Mode only.
5.  **Do not parse model prose** for plan state — ever.
6.  Prefer **delete** over **deprecate**. Prefer **plugin** over **core** for integrations.
7.  If a file you edit crosses 800 lines, split it in the same PR or file a Weakness Registry entry.

---

**Agent Smith is not a chatbot with tools bolted on. It is a Durable Plan Agent — a plan loop with the smallest trustworthy shell folded around it, designed to finish multi-step builds on a 7B local model without forgetting, and to beat bloated IDE agents by being sharper, not bigger.**
