# AGENTS.md — Agent Smith map for AI assistants

Primary entry point. See [`docs/CODE_MODE.md`](docs/CODE_MODE.md) for the coding loop; [`docs/harness/HARNESS_CHECKLIST.md`](docs/harness/HARNESS_CHECKLIST.md) for harness review.

## What this is

Local AI assistant: Electron desktop app + optional web UI. **Three modes** (mutually exclusive toggles):

| Mode | Toggle | Path |
|------|--------|------|
| **Chat** | Both off | Conversation-only LLM stream (`src/renderer/app.js`) |
| **Agent** | AGENT on | Full host control (`src/renderer/modes/agentTools.js`) — shell + whole-host file read/write/delete + process mgmt |
| **Code** | CODE MODE on | Auto-run build loop in main process (`src/code/`) |

Trust layer: `changeLedger` + **Revert All** — not plan approval. Code Mode auto-runs, contained to the project root. Agent mode manages the whole host; safety is guardrail-based — `commandPolicy` screens shell commands and `pathPolicy` screens file mutations, refusing only catastrophic targets (wiping a system/home root).

## Tool permissions

| Capability | Chat | Agent | Code |
|------------|------|-------|------|
| LLM stream | yes | yes | yes (main process) |
| Shell | no | yes | yes (`run_command`, safety-policy filtered) |
| Read files | no | yes (whole host) | yes (contained to project root) |
| Write/delete | no | yes (whole host, `pathPolicy` guarded) | yes (patch/write, contained to root) |
| Process mgmt | no | yes (`list_processes`/`stop_process`/`send_input`) | partial |
| Web | no | `web_search`, `fetch_url` (read-only) | no |
| Memory | optional | yes | yes (cross-session recall + remember) |
| Plugin tools | no | optional | yes (offered in implement/verify phases) |

Code Mode tool definitions: [`src/code/tools/schemas.js`](src/code/tools/schemas.js); mode/channel gating: [`src/shared/channelPolicy.js`](src/shared/channelPolicy.js).
Command safety: [`src/shared/commandPolicy.js`](src/shared/commandPolicy.js); file-mutation safety (Agent whole-host): [`src/shared/pathPolicy.js`](src/shared/pathPolicy.js); Code-Mode path containment: `projectContext.resolvePath`.
Agent Mode trust layer (audit + undo): [`src/main/services/actionLog.js`](src/main/services/actionLog.js) → IPC [`src/main/ipc/actions.js`](src/main/ipc/actions.js). Every consequential action is logged; reversible ones can be undone via `undo_action`/`review_actions` or the sidebar **📋 AGENT ACTIONS** panel.

Agent Mode end-to-end checks: `node scripts/agent-e2e.js` (every agent tool vs real OS) · `node scripts/agent-live-e2e.js` (real model drives tools via LM Studio).

## Plugins

Plugins are trusted code; **enabling one records a content hash** (`src/main/services/pluginIntegrity.js`) — a later change quarantines it until re-enabled. An **opt-in OS sandbox** (`AGENT_SMITH_PLUGIN_SANDBOX=1`, `src/main/services/pluginSandbox.js`) runs plugin tools in a child process under Node's permission model (no `child_process`/`worker`, fs scoped to the project). Default is in-process.

## Long-horizon artifacts (Code Mode)

Non-trivial Code runs create `.agentsmith/PLAN.md` and `.agentsmith/IMPLEMENT.md` in the project root. Milestones may declare `verify:` commands. Optional project rules: `.agentsmith/rules/*.js`. Templates: [`docs/harness/`](docs/harness/). Continuous verification (post-edit sensors, grind-until-green): [`docs/harness/README.md`](docs/harness/README.md).

## Folder map

```
src/
├── code/                 # Code Mode engine (main process)
│   ├── loop/             # runCodeTask, turnLoop, phases, middleware, codeTrace
│   ├── context/          # budget, bootstrap, planAnchor, planArtifacts, gemmaHarness, modelHarness
│   ├── governor/         # earlyStop, completionGate, webValidators, acceptance, smokeTest
│   └── session/          # CodeSession persistence + resume
├── main/
│   ├── services/         # changeLedger, editEngine, projectContext, pluginManager, …
│   └── ipc/              # agent, edit, project, ledger, code, plugins, …
├── renderer/
│   ├── app.js            # DOM shell: auth, chat stream, mode toggles, sidebar wiring
│   ├── entry.js          # esbuild bundle entry → dist/renderer/bundle.js
│   ├── modes/            # agentTools, chatLoop, code, modeHistory, runState
│   ├── styles/           # base.css + overlay.css (theme; loaded by index.html)
│   ├── timeline/         # activityTimeline (Code + Agent), eventAdapter, diffView
│   └── ui/               # codeRunUI, scrollFollow, sidebarLayout
├── shared/               # channelPolicy, modelClassifier, runtimeProfile, ipcChannels, …
└── ghosttrace/           # PipelineTrace diagnostics
```

## Verification

```
npm test
npm run harness-eval-regression
npm run harness-eval-capability
npm run harness-security
npm run harness-eval
npm run ship-check
node scripts/readiness-report.js
npm run build:renderer
```

Manual: `npm start` — toggle each mode; Code run should create `.agentsmith/` for build tasks; resume banner after interrupted run.
