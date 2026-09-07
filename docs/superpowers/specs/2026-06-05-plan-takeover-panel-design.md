# Plan Full-Takeover Panel — Design

**Date:** 2026-06-05
**Status:** Approved (pending spec review)

## Problem

When a build plan is active, the plan surface (`#agent-run-card`) is supposed to dominate
the left side panel. Instead it gets squished into a short strip at the bottom of the
panel, below a large empty gap, with the task text clipped. The user experience feels
broken.

### Root cause

`index.html` declares the layout spacer with an inline style:

```html
<div class="spacer" style="flex:1;"></div>
```

The run-mode rule that is meant to collapse it —
`body.xk-run-active .spacer { flex: 0 0 auto; }` — is a stylesheet rule and **cannot
override an inline style**. So in run mode the spacer keeps `flex:1` and competes with
`body.xk-run-active .plan-drawer { flex: 1; }`. The spacer eats roughly half the panel,
producing the empty gap and cramming the plan card into the leftover space.

## Goal

When a plan is created/active, the plan takes over the **entire** side panel (a dedicated
"plan mode"). The user can **EXIT** back to the regular panel view at any time; the plan
keeps running and is reachable via a compact chip.

## Decided behavior

- **Takeover trigger:** plan active in any non-terminal phase — new (awaiting approval),
  executing, paused, or restored-on-startup — auto-opens the full takeover.
- **Takeover surface:** an absolutely-positioned overlay covering the whole `#sidebar`
  (brand, user row, all settings sections), with its own internal scroll.
- **Plan header bar:** `⛏ PLAN` title + an **EXIT (✕)** button.
- **EXIT:** hides the overlay, reveals the normal panel (settings usable again), and pins
  a compact **`PLAN · N/M ›`** chip near the bottom of the panel. The plan keeps running.
- **Reopen:** clicking the chip re-opens the full takeover.
- **Terminal states (done/failed/aborted):** run mode exits fully — overlay and chip both
  removed (existing `exitRunMode` path).
- The old desktop **pin (📌) + vertical rail** concept is replaced by this **EXIT + chip**
  model. Mobile bottom-sheet behavior is unchanged.

## Architecture (no new files)

| File | Change |
|---|---|
| `index.html` | Remove inline `flex:1` from `.spacer`. Add **EXIT** button to `.plan-drawer-bar`. Replace `#plan-rail` markup with a `#plan-chip` element (`PLAN · N/M ›`). |
| `styles.css` | `body.xk-run-active .plan-drawer` becomes `position:absolute; inset:0; z-index` over the sidebar, full-height flex column with internal scroll. Remove the now-unneeded `max-height:132px` settings-strip rule. Add `.spacer { flex:1 }` (moved from inline). Style EXIT button and `#plan-chip`. |
| `lib/sidebarLayout.js` | Replace pin/rail semantics with takeover/chip: `openPlan()` shows the overlay; new `collapsePlan()` hides overlay and shows the chip; update `#plan-chip` step text in `updateRail`/equivalent. Wire EXIT → `collapsePlan`, chip → `openPlan`. Keep mobile sheet path intact. Drop `setPinned`/rail wiring (or repoint to chip). |
| `agentRunUI.js`, `renderer.js` | No changes — they already call `enterRunMode` / `onPhase` / `handleRunEvent`. |

## Data flow (unchanged)

Plan state machine, approval gate, execution loop, change ledger, and the mobile bottom
sheet are untouched. This is a CSS + DOM-wiring change to the desktop panel shell only.

## Testing

- `node test-durable-modules.js` still passes (engines untouched).
- Manual: with BUILD MODE on, create a plan → verify it takes the whole panel; hit EXIT →
  settings return + chip visible; click chip → takeover returns; cancel/finish → chip and
  overlay gone.
- Restored-plan-on-startup path (`presentRestoredPlan`) shows the takeover, not a squished
  strip.
- Narrow viewport (≤768px) still uses the bottom sheet, unaffected.

## Out of scope

- Mobile bottom-sheet redesign.
- Any change to plan execution, approval, or persistence logic.
