# Harness roadmap — out of scope (future platform)

Items tracked here are **not** implemented in the Max Potential v1 roadmap. Revisit when orchestration or platform needs grow.

| Item | Why deferred |
|------|----------------|
| MCP server exposing Agent Smith tools externally | Requires stable public API + auth model |
| Mission-control orchestration dashboard | UI product scope beyond local harness |
| Per-run token/cost budgets (FinOps) | Needs LM Studio / provider metering hooks |
| Self-healing loop (regression detect → auto fix run) | Depends on trace query + eval CI (partial foundation now) |
| AgentStepper-style interactive debugger | Large DX surface; GhostTrace export exists |
| Structured cross-project memory (OpenViking/Trellis-style) | Vector memory is best-effort today |
| Path-scoped `.agentsmith/rules/` by glob | Flat `rules/*.js` sufficient for v1 |
| Parallel milestone subagents + worktree per milestone | **Shipped v2** — see [`PARALLEL_MILESTONES_V2.md`](PARALLEL_MILESTONES_V2.md) |

## Shipped in Max Potential roadmap

- Phase-boundary context compaction
- Eval split (regression / capability / security)
- Playwright/e2e grind detection
- Workspace readiness scorer
- Lifecycle hook expansion (11 events)
- `query_run_trace` verify tool
- Optional git worktree isolation
- Sequential milestone subagent dispatch
- Milestone worktrees v2 (one worktree per milestone, optional concurrent)

See [`HARNESS_CHECKLIST.md`](HARNESS_CHECKLIST.md) for review status.
