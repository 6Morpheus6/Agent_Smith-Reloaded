# Agent Smith Plugins

Plugins extend the agent with **tools**, **slash commands**, and **lifecycle
hooks** — without editing core files. They are **trusted local code** loaded in
the main process. See `docs/superpowers/specs/2026-06-04-plugin-system-design.md`
for the full design and the honest security boundary.

> **Trust:** a plugin runs with full Node access. Capabilities give you
> *transparency* (you see what a plugin asks for before enabling it) and
> defence-in-depth for honest plugins (the `host` only exposes what you grant) —
> they are **not** a sandbox against hostile code. Only install plugins you trust.

## Installing

- **From the UI:** sidebar → 🧩 PLUGINS → paste a `github.com/user/repo` (or any
  git/archive URL) → **INSTALL**. Then flip the toggle to enable it; you'll be
  shown the capabilities it requests and asked to confirm.
- **Manually:** drop a plugin folder into `<userData>/plugins/<id>/` and restart.
  On Windows, `<userData>` is `%APPDATA%/agent-smith` (Electron app userData).
- **Try the example:** copy `src/examples/plugins/hello` into your plugins dir.

## Folder layout

```
<id>/
  plugin.json          # manifest (required)
  tools/   *.js        # one tool per file
  commands/ *.js       # one slash command per file
  hooks/   *.js        # one hook per file
```

If `plugin.json` omits `contributes`, every `*.js` under `tools/`, `commands/`,
`hooks/` is auto-discovered.

## Manifest (`plugin.json`)

```json
{
  "id": "weather",
  "name": "Weather Tools",
  "version": "1.0.0",
  "description": "Look up weather.",
  "author": "you",
  "capabilities": ["net", "memory"]
}
```

`capabilities` ⊆ `["fs", "shell", "net", "memory", "ui", "log"]` (`log` is always
available). The `host` object passed to your code only exposes the caps you
declare *and* the user granted.

## Tools

The model can call your tool by its `schema.name`. Names must not collide with a
core tool or another enabled plugin's tool (the colliding plugin is disabled and
flagged in the UI).

```js
// tools/get_weather.js
module.exports = {
  schema: {
    name: 'get_weather',
    description: 'Get current weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
  },
  async run(args, host) {       // host is capability-gated
    const res = await host.net.fetch(`https://api.example.com/w?q=${args.city}`);
    return await res.text();    // return a string (or JSON-serialisable value)
  }
};
```

## Slash commands

Typing `/forecast Paris` in the input expands to the command's text.

```js
// commands/forecast.js
module.exports = {
  name: 'forecast',
  description: 'Insert a forecast prompt.',
  prompt: 'Get the weather forecast for {{args}} and summarise it.'
  // or: async run(argText, host) { return `...`; }
};
```

## Hooks

```js
// hooks/audit.js
module.exports = {
  event: 'beforeToolCall',   // see HOOK_EVENTS list below
  async run(payload, host) {
    host.log(`tool: ${payload.name || payload.toolName}`);
    // before* hooks may veto: return { block: true, reason: 'not allowed' };
  }
};
```

**HOOK_EVENTS:** `beforeToolCall`, `afterToolCall`, `beforeDone`, `onPlanApproved`, `onPlanDone`, `onMessageSend`, `sessionStart`, `sessionStop`, `afterTurn`, `afterToolBatch`, `phaseChange`

Hook payloads:
- `beforeToolCall` / `afterToolCall` → `{ name, args[, result] }` (legacy: `toolName` also accepted)
- `beforeDone` → `{ filesTouched, goal, grindMode }`
- `onPlanApproved` → `{ sessionId, goal, codePlan }`
- `onPlanDone` → `{ sessionId, goal, status, codePlan }`
- `onMessageSend` → `{ text }`
- `sessionStart` / `sessionStop` → `{ sessionId, goal, projectRoot, status? }`
- `afterTurn` → `{ turn, phase, toolCount }`
- `afterToolBatch` → `{ turn, toolCount }`
- `phaseChange` → `{ fromPhase, toPhase, droppedCount?, keptCount? }`

A failing hook is logged and ignored (it can't wedge
the agent); only a `before*` hook returning `{ block: true }` stops execution.

## The `host` object

| Member | Cap | What it does |
|---|---|---|
| `host.log(msg)` | always | write to the app log |
| `host.fs` | `fs` | `readFile/writeFile/exists/list` — sandboxed to the project root |
| `host.shell.run(cmd)` | `shell` | run a command in the project root |
| `host.net.fetch(url, opts)` | `net` | fetch, but metadata/link-local/ULA hosts are blocked |
| `host.memory` | `memory` | `store(text, meta)` / `query(text, k)` vector memory |
| `host.ui.notify(msg)` | `ui` | surface a message in the chat |

A cap you didn't declare is simply `undefined` on `host`.
