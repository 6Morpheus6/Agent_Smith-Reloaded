# Post-Audit Remediation Report

**Date:** 2026-06-06  
**Target:** Agent Smith v45.0.0 ship gate

## Verification matrix

| ID | Fix | Pass/Fail | Evidence |
|----|-----|-----------|----------|
| P0-1 | Web `code-event` via SSE | **PASS** (automated) | `src/main/server/sseHub.js`, `GET /api/events` in `main.js`, web polyfill `src/renderer/app.js`; `tests/sseHub.test.js` (4 tests) |
| P0-1 | Desktop IPC unchanged | **PASS** (code review) | `pushEvent` sends `webContents.send` + SSE; Electron uses preload `api.on`, not web polyfill |
| P0-2 | Greenfield smoke | **PASS** | `scripts/greenfield-smoke.js`; integrated in `ship-check.js`; output: `OK (calls=4 status=incomplete reflections=3)` |
| P0-2 | Manual Pac-Man GUI | **UNVERIFIED** | See `docs/MANUAL_SMOKE.md` — requires LM Studio + human |
| P1-1 | Docs tri-mode | **PASS** | `README.md`, `SMITH.md` §2–4, `docs/CODE_MODE.md` parity table |
| P1-2 | Dead plan-drawer CSS | **PARTIAL** | Legacy `.plan-drawer` / `.agent-run-card` rules remain in `src/renderer/styles/base.css` (~300 lines); no HTML/JS references — safe to delete in follow-up |
| P1-3 | Windows hardware probe | **PASS** | Linux `lspci` only on linux; Windows uses PowerShell `Get-CimInstance`; `/proc/cpuinfo` gated to linux |
| P1-4 | Web auth error surfacing | **PASS** (code) | `src/renderer/app.js` invoke checks `response.ok`; `checkAuth` shows system bubble on web error |
| P2-1 | Version sync | **PASS** | `scripts/build-renderer.js` `syncAppVersion()` writes `#app-version` from `package.json` |
| P2-2 | Inline styles | **PARTIAL** | Quickbar agent row, memory badge, resume banner migrated; login/admin/plugins still inline |
| P2-3 | Layout symmetry | **PARTIAL** | `.input-controls` center; `.code-diff` max-height 320px; `#code-review-mount` still under MODEL |
| P2-4 | Dead `agent-event` IPC | **PASS** | Removed from `RECEIVE_CHANNELS` |

## Automated run (2026-06-06)

```
npm test                 → 167/167 pass
npm run harness-eval     → 3/3 pass
npm run ship-check       → pass (incl. greenfield-smoke)
node scripts/verify-main-ipc.js → PASS
npm run build:renderer   → syncs v45.0.0
```

## Ship recommendation

**CONDITIONAL SHIP** — P0 automated paths fixed. **Manual GUI smoke** (desktop + phone Code timeline) still required before commercial release.

## Remaining test debt

- Playwright visual regression (1280/768/480)
- Full inline-style migration (`index.html` auth/login/admin)
- Delete dead `.plan-drawer` CSS block
- Cloudflare tunnel opt-out documentation
