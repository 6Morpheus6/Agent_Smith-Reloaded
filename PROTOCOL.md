# PROTOCOL.md — Agent Smith operating notes

Working notes for AI assistants (and humans) in this repo. Navigation map: [`AGENTS.md`](AGENTS.md). Product doctrine: [`SMITH.md`](SMITH.md). Code Mode: [`docs/CODE_MODE.md`](docs/CODE_MODE.md).

## What this is

A **local AI assistant** (Electron desktop app + optional web UI) that talks to an OpenAI-compatible LLM server (LM Studio by default). Tools run in the **main process** during **Code Mode**; **Chat Mode** is conversation-only.

## Backend protocol

The app speaks **OpenAI chat-completions format only** (`/v1/chat/completions`). Default base URL: `http://localhost:1234`. Embeddings use Ollama-native `/api` via `memory.js` — not for chat.

## Code Mode architecture

| Module | Role |
|--------|------|
| `src/code/loop/runCodeTask.js` | Orchestrator |
| `src/code/loop/turnLoop.js` | Multi-tool turn loop |
| `src/code/tools/executor.js` | Tool dispatch + ledger |
| `src/main/services/changeLedger.js` | Snapshots, diff, revert |
| `src/renderer/timeline/` | Inline activity timeline |

## Security

- Web server binds `0.0.0.0`; treat tunneling as security-sensitive. Tool/agent channels
  (`code-*`, `agent-*`, `git-*`, `edit-*`, `plugin-*`, `app-reset`, `open-external-url`)
  require `canUseTools` on the web surface — `src/shared/channelPolicy.js`.
- File tools are confined to the project root: `projectContext.resolvePath` rejects `..`
  traversal AND absolute paths that escape the root. Path containment, not an OS jail.
- Shell tools refuse a denylist of catastrophic commands (`rm -rf /`, `mkfs`, fork bombs,
  `curl | sh`, …) via `src/shared/commandPolicy.js` — a guardrail, not a sandbox.
- Plugins are **trusted code**; installing one runs its code in-process by default. Treat
  install URLs like `npm install`. Mitigations: enabling records a content hash
  (`pluginIntegrity.js`) so tampering quarantines the plugin until re-enabled; an opt-in
  OS sandbox (`AGENT_SMITH_PLUGIN_SANDBOX=1`, `pluginSandbox.js`) runs plugin tools in a
  child process under Node's permission model (no child_process/worker, fs scoped to the
  project root), with shell/net/memory brokered back through the same guards.
- Network egress is constrained via `src/shared/netGuard.js`.
- Renderer hardened: CSP (`script-src 'self'`, `object-src 'none'`), navigation/window-open
  denied, external URLs limited to http/https/mailto, sudo password passed via stdin.

## Verification

```bash
npm test
npm run ship-check
node scripts/verify-main-ipc.js
```

Vanilla JS, CommonJS, no bundler. Match surrounding style.
