# Preview Browser

Built-in Preview panel for Code and Agent modes via the **`show_preview`** tool.

## Tool schema

```json
{
  "kind": "project_file" | "web_url" | "screenshot",
  "target": "index.html or https://…",
  "caption": "optional label",
  "viewport": { "width": 1280, "height": 720 },
  "scope": "app" | "window" | "screen"
}
```

| Kind | Behavior |
|------|----------|
| `project_file` | Live iframe via `/preview/project/<path>` (workspace sandbox) |
| `web_url` | Hidden BrowserWindow capture → PNG in Preview panel |
| `screenshot` | Desktop source picker → PNG (`scope: app` captures Agent Smith only) |

## Security

- Project files: `projectContext.resolvePath` only
- Web URLs: `validatePublicFetchTarget` + loopback via `validatePreviewUrl`
- Snapshots served from `<userData>/previews/` via `validatePreviewAssetPath`
- Desktop screen/window capture: **ADVANCED → DESKTOP PREVIEW** toggle + user picks source
- Web client: project + web snapshots work; desktop screenshot returns an error

## Architecture

| Module | Role |
|--------|------|
| `src/main/services/previewService.js` | Paths, snapshots, capture |
| `src/main/services/previewRunner.js` | Orchestration + events |
| `src/main/server/previewRoutes.js` | HTTP `/preview/*` |
| `src/main/ipc/preview.js` | IPC for renderer Agent path |
| `src/renderer/ui/previewPanel.js` | Sidebar drawer UI |

Code Mode calls `showPreview` in-process via `code.js` `buildExecDeps`. Agent Mode uses `preview-show` IPC.

## Desktop vs web

| Capability | Electron | Web (LAN) |
|------------|----------|-----------|
| Project live preview | iframe + auth token | iframe + auth token |
| Web URL snapshot | yes | yes (SSE `preview-event`) |
| Desktop screenshot | yes (opt-in) | no |

See [`docs/MANUAL_SMOKE.md`](MANUAL_SMOKE.md) for checklist items.
