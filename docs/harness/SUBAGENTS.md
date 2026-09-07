# Sequential milestone subagents (v1)

When **PARALLEL MILESTONES** is enabled in Code Mode and `.agentsmith/PLAN.md` has **3+ milestones**, the orchestrator runs **sequential child turn loops** — one per open milestone — before a final completion gate.

See **[Parallel milestone subagents v2](PARALLEL_MILESTONES_V2.md)** for worktree-per-milestone isolation (feature-flagged).

## Behavior

1. Parent session creates PLAN artifacts as usual.
2. For each incomplete milestone, a child loop receives a fresh message list with `[MILESTONE Mx]` context.
3. Child `filesTouched` merge into the parent.
4. Parent runs `checkCompletion` once at the end.

## v2 toggles (worktree per milestone)

| Flag | UI | Requires |
|------|-----|----------|
| `milestoneWorktrees` | MILESTONE WORKTREES | PARALLEL MILESTONES + git |
| `milestoneConcurrent` | CONCURRENT MILESTONES | MILESTONE WORKTREES (experimental) |

## Toggle (v1)

- UI: **PARALLEL MILESTONES** (default off)
- `localStorage`: `agentsmith_code_parallel_milestones`
- IPC: `code-run` `{ parallelMilestones: true }`

## Limitations (v1)

- **Sequential only** — avoids port conflicts and multi-worktree complexity.
- Child loops share `planArtifacts` and `planAnchor` state.
- No nested subagent depth.

## Future (see ROADMAP.md)

- Parallel milestones with one worktree per milestone
- Shared trace aggregation across child runs

## Code

[`src/code/loop/runCodeTask.js`](../../src/code/loop/runCodeTask.js) — `useSubagents` branch

Events: `subagent_start`, `subagent_done`
