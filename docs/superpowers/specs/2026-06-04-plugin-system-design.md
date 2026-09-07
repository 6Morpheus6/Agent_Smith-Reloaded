# Agent Smith Plugin System — Design Spec

**Date:** 2026-06-04
**Status:** Approved for implementation
**Author:** AI assistant + owner (brainstorming session)

## Goal

Give Agent Smith a production-grade **plugin system**: third-party folders that can
extend the agent with new **tools**, **slash commands**, and **lifecycle hooks** —
without editing core files. Plugins are trusted local code, installable from a
Git/URL, and declare the host capabilities they need so the user can consent at
install time.

## Decisions (locked during brainstorming)

| Question | Decision |
|---|---|
| Core capability | **Full bundle**: tools + slash commands + hooks in one format |
| Trust/execution model | **Trusted local folders**, loaded as Node modules in the **main process** |
| Distribution | **Install from Git/URL**, built on top of a local-folder system + Plugins UI |
| Consent | **Declared capabilities + install-time consent**; host enforces declared caps at call time |
| Plugin layout | **Approach A**: `plugin.json` manifest + convention subfolders (`tools/`, `commands/`, `hooks/`), one file per contribution |

### Honest security boundary

Plugins are **trusted code running in the main process with full Node access**.
A malicious plugin can `require('fs')` directly and ignore the capability facade.
Capabilities are therefore **(a) transparency** — the user sees what a plugin
*declares* it needs before enabling it — and **(b) defence-in-depth for honest
plugins** — the `host` object only exposes the APIs a plugin declared, and the
host-mediated paths (fs/shell/net) stay sandboxed/guarded. They are **not** a
sandbox against hostile code. This matches the prevailing plugin model (plugins are
trusted local code) and is called out so nobody mistakes caps for a jail. A true
sandbox (VM isolation) was explicitly out of scope.

## Architecture

### New modules (main process)

| Module | Responsibility |
|---|---|
| `lib/pluginManager.js` | Discover plugin folders under `<userData>/plugins/`, validate manifests, load contributions, hold the registry, enable/disable, persist `plugins.json`, route tool/command/hook invocations. |
| `lib/pluginHost.js` | Build the **capability-gated `host`** facade for one plugin from its granted caps. |
| `lib/pluginInstaller.js` | Install from Git/URL: host block-check → `git clone --depth 1` (or GitHub-tarball + system `tar` fallback) into a staging dir → validate manifest → move into `plugins/<id>`. Safe against path traversal / zip-slip. |

These are pure-ish Node modules, unit-testable with `node --test` (per repo convention).

### Disk layout (`userData`)

```
<userData>/plugins/
  plugins.json                 # { "<id>": { enabled, grantedCaps, source, installedAt, version } }
  <id>/
    plugin.json                # manifest
    tools/     <name>.js       # one tool per file
    commands/  <name>.js       # one command per file
    hooks/     <name>.js       # one hook per file
```

### Manifest (`plugin.json`)

```json
{
  "id": "weather",
  "name": "Weather Tools",
  "version": "1.0.0",
  "description": "Look up weather and forecasts.",
  "author": "someone",
  "capabilities": ["net", "memory"],
  "contributes": {
    "tools": ["tools/get_weather.js"],
    "commands": ["commands/forecast.js"],
    "hooks": ["hooks/audit.js"]
  }
}
```

- `id` defaults to the folder name; must be unique, `[a-z0-9-]`.
- `capabilities` ⊆ `["fs","shell","net","memory","ui","log"]` (`log` always granted).
- `contributes` is optional. If omitted, the loader **auto-discovers** every
  `*.js` in `tools/`, `commands/`, `hooks/`.

### Contribution module shapes

**Tool** (`tools/get_weather.js`):
```js
module.exports = {
  schema: {
    name: 'get_weather',
    description: 'Get current weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
  },
  async run(args, host) {
    const res = await host.net.fetch(`https://api.example.com/w?q=${args.city}`);
    return await res.text();   // string or JSON-serialisable
  }
};
```
- The model sees the tool by its declared `name` (clean, no namespace prefix).
- **Collision rule:** a plugin tool whose name equals a core tool, or another
  enabled plugin's tool, is **rejected and the plugin flagged** (logged + shown in
  UI). Core tools always win.

**Command** (`commands/forecast.js`):
```js
module.exports = {
  name: 'forecast',
  description: 'Insert a weather-forecast prompt.',
  // EITHER a static template (“{{args}}” → user-typed remainder):
  prompt: 'Get the weather forecast for {{args}} and summarise it.',
  // OR a handler returning the text to inject:
  async run(argText, host) { return `Forecast for ${argText}`; }
};
```
Invoking `/forecast Paris` in the input box resolves to injected text.

**Hook** (`hooks/audit.js`):
```js
module.exports = {
  event: 'beforeToolCall',  // beforeToolCall | afterToolCall | onPlanApproved | onPlanDone | onMessageSend
  async run(payload, host) {
    host.log(`tool ${payload.toolName}`);
    // before* hooks may veto: return { block: true, reason: '...' }
  }
};
```

### Capability-gated host

`pluginHost.build(grantedCaps, deps)` returns:

| Member | Cap | Backed by |
|---|---|---|
| `host.log(msg)` | always | console + ui channel |
| `host.capabilities` | always | the granted list |
| `host.fs` | `fs` | `projectContext`-sandboxed read/write/exists/list (project root only) |
| `host.shell.run(cmd)` | `shell` | the same guarded path as `agent-run-command` |
| `host.net.fetch(url, opts)` | `net` | `fetch` wrapped by a netGuard public-fetch check (blocks metadata/link-local/ULA; strips `Authorization`/`Cookie` on cross-origin redirects) |
| `host.memory` | `memory` | `mem-store` / `mem-query` |
| `host.ui.notify(msg)` | `ui` | emits to renderer (`resource-update`-style channel) |

A cap not granted → the member is **absent** (`undefined`) → honest plugins fail
fast. `pluginManager` passes each plugin its own host built from its granted caps.

## Wiring into existing code (additive)

### `main.js`
- `const pluginManager = require('./lib/pluginManager.js')` initialised with
  `userDataPath` + deps (`projectContext`, command runner, memory handlers, the
  main window for ui events, `netGuard`).
- IPC handlers: `plugins-list`, `plugins-get-contributions`, `plugin-invoke-tool`,
  `plugin-run-command`, `plugin-fire-hook`, `plugin-install`, `plugin-set-enabled`,
  `plugin-uninstall`, `plugin-grant-caps`.
- `plugin-fire-hook` lets the renderer drive hook firing for the chat path; the
  agent path fires hooks directly through the manager via IPC too.

### `preload.js`
- Add the above channels to `INVOKE_CHANNELS` (generic, **one-time** — not per tool).
- Add a receive channel `plugin-ui-event` for `host.ui.notify`.

### `agentLoop.js`
- At task start (`runAgentTask`), fetch enabled plugin tool schemas via
  `plugins-get-contributions` and stash on `ctx.pluginTools`.
- Planning + execution request bodies send `tools: [...PLAN_TOOLS, ...ctx.pluginTools]`.
- `toolNames()` and the text-fallback tool extractor include plugin tool names.
- `executeAgentTool` fallthrough: before the `Unknown tool` return, if the name is
  a known plugin tool, route to `api.invoke('plugin-invoke-tool', {tool, args})`.
- Fire hooks: `beforeToolCall`/`afterToolCall` around the execution-loop tool call
  (line ~1248), `onPlanApproved` after approval, `onPlanDone` at plan completion.
  A `beforeToolCall` veto turns into a synthetic tool result so the model adapts.

### `renderer.js` / `index.html`
- **Plugins panel** in the sidebar: list installed plugins (name, version, declared
  caps), enable/disable toggle, uninstall, and an **Install from Git/URL** input.
  Enabling a plugin shows its declared caps for consent before activation.
- Slash commands: on input, if text starts with `/<name>` matching a plugin
  command, resolve via `plugin-run-command` and inject the returned text.
- Chat path (`sendMessage`) fires `onMessageSend` hooks via `plugin-fire-hook`.

## Data flow — plugin tool call

```
LLM emits tool_call "get_weather"
  -> executeAgentTool: not a core tool, is a known plugin tool
  -> beforeToolCall hooks (may veto)
  -> IPC plugin-invoke-tool { tool:"get_weather", args }
  -> pluginManager: find owning plugin, build its gated host, run schema.run(args, host)
  -> result string returned up the normal tool-result path
  -> afterToolCall hooks
```

## Installer flow (Git/URL)

1. Parse URL. Reject if `netGuard.isBlockedHost(host)` (metadata/link-local/ULA).
   Require `http(s)` or a `git`-cloneable URL.
2. If `git` binary present → `git clone --depth 1 <url> <staging>`. Else, for a
   GitHub URL, download the codeload `tar.gz` via a guarded https GET to a temp
   file and extract with system `tar -xzf` into `<staging>`.
3. Locate the plugin root in `<staging>` (the dir containing `plugin.json`).
   Validate manifest (id, version, caps subset). Reject traversal/abs paths.
4. Move into `plugins/<id>` (refuse to overwrite a different existing id without
   explicit reinstall). Record `source`, `version`, `installedAt`; default
   `enabled:false` until the user grants caps.

## Error handling

- A plugin that throws on load is **skipped, quarantined** (kept disabled with an
  `error` field), and surfaced in the UI — one bad plugin never breaks startup.
- A tool handler that throws returns a normal error string to the model (same shape
  as core tool errors), not an unhandled rejection.
- Hook failures are logged and swallowed (a broken hook must not wedge the agent),
  except `beforeToolCall` returning `{block:true}` which is an intentional veto.
- Manifest validation failures → install rejected with a clear message.
- Capability-not-granted access → throws inside the plugin, caught as a tool error.

## Testing

`node --test tests/*.test.js`. New tests:
- `pluginManager`: discovery, manifest validation (good/bad/missing caps),
  auto-discovery vs explicit `contributes`, tool-name collision rejection,
  enable/disable persistence round-trip, quarantine of a throwing plugin.
- `pluginHost`: granted cap present / ungranted cap absent; net fetch blocked host
  rejected; fs sandboxed to project root.
- `pluginInstaller`: URL host block-check; staging-dir traversal/zip-slip rejection;
  manifest-missing rejection. (Network clone itself is integration-only / mocked.)
- A bundled **example plugin** (`examples/plugins/hello/`) exercised end-to-end in a
  node harness: load → list contributions → invoke its tool → fire a hook.

## Out of scope (YAGNI)

- VM/process sandbox for hostile plugins.
- In-app browsable marketplace / hosted registry.
- Plugin-to-plugin dependencies, versioned API compatibility negotiation.
- Hot-reload while a plan is executing (reload happens between tasks).
```
