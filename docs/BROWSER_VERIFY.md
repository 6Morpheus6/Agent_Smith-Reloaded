# Browser verify (`browser_verify`)

Verify-phase tool for loading project HTML in a headless Electron window and detecting load/console failures.

## Tool schema

| Param | Description |
|-------|-------------|
| `target` | Relative HTML path (default `index.html`) |
| `checks` | Optional array of JS expressions that must evaluate truthy |

Available only in **verify** phase (see [`phases.js`](../src/code/loop/phases.js)).

## Architecture

| Layer | Module |
|-------|--------|
| Tool dispatch | [`executor.js`](../src/code/tools/executor.js) |
| Service | [`browserVerify.js`](../src/main/services/browserVerify.js) |
| Path resolve | [`previewService.js`](../src/main/services/previewService.js) |

## Security

- Paths resolved via `projectContext.resolvePath` (project root containment)
- Loads `file://` URLs only for resolved project files
- No arbitrary external URLs in v1
- Optional `checks` run via `executeJavaScript` in isolated sandbox window

## Example

During verify phase the model may call:

```json
{
  "name": "browser_verify",
  "arguments": {
    "target": "index.html",
    "checks": ["document.querySelector('canvas')", "typeof game !== 'undefined'"]
  }
}
```

## Playwright vs native tool

| Need | Use |
|------|-----|
| Static HTML loads, no console errors | `browser_verify` (verify phase) |
| Full user flows, multi-page E2E | `npm run test:e2e` or `npx playwright test` via grind |
| PLAN milestone E2E gate | `e2e: \`npm run test:e2e\`` in PLAN.md |

When `package.json` has `test:e2e` or `playwright.config.*` exists, **GRIND UNTIL GREEN** runs e2e after lint/test ([`projectDetector.js`](../src/main/services/projectDetector.js), [`completionGate.js`](../src/code/governor/completionGate.js)).

## Related

- [`docs/PREVIEW.md`](PREVIEW.md) — visual preview panel (`show_preview`)
- [`docs/CODE_MODE.md`](CODE_MODE.md) — verify phase tooling
