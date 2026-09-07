# Workspace readiness

Score how agent-ready a project is **before** starting Code Mode. Inspired by awesome-harness `/readiness` pattern.

## Scoring (8 pillars × 0–5)

| Pillar | Signals |
|--------|---------|
| docs | README.md, `docs/` folder |
| tests | `npm test` / pytest / cargo test |
| lint | eslint/ruff config or lint script |
| rules | `.agentsmith/rules/*.js` |
| git | `.git` present |
| structure | src layout, package.json |
| AGENTS.md | agent orientation doc |
| harness | `.agentsmith/` artifacts, e2e script |

## Usage

**UI:** Enable Code Mode — readiness chip shows `Readiness: N/40` when a workspace root is set.

**IPC:** `code-readiness` with `{ projectRoot }` → `{ score, maxScore, pillars[], recommendations[] }`

**CLI:**

```bash
node scripts/readiness-report.js /path/to/project
```

Exit code 0 when score ≥ 50% of max.

## Implementation

[`src/code/governor/readiness.js`](../../src/code/governor/readiness.js)

Recommendations are advisory — low scores do not block Code Mode runs.
