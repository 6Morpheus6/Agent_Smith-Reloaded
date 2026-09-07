# Harness eval tiers

Three eval matrices protect different concerns:

| Tier | Command | CI (ship-check) | Purpose |
|------|---------|-----------------|---------|
| Regression | `npm run harness-eval-regression` | **Required** | Must pass 100% — guards against regressions |
| Capability | `npm run harness-eval-capability` | Optional (`ship-check --capability`) | Improvement targets — softer thresholds |
| Security | `npm run harness-security` | **Required** | Harness resists injection, escape, bypass |

Run all: `npm run harness-eval`

## Regression scenarios (`regression/scenarios.test.js`)

- pacman-complete fixture validation
- plan-artifacts-created
- phase-gate-explore write block
- post-edit rule sensor
- grind-blocks-done-on-test-fail
- playwright-grind-blocks-on-failure (mock e2e script)
- beforeDone middleware veto
- project-rule-blocks-done
- phase-compaction-preserves-plan-anchor
- plugin hook contract (all HOOK_EVENTS)

## Capability scenarios (`capability/scenarios.test.js`)

- greenfield scaffold (file touched, no infinite loop)
- grind reflection on failing test
- rule advisory `[RULE:*]` in post-edit sensor
- early-stop turn limit
- plan artifacts for non-trivial task

## Security scenarios (`tests/harness-security/`)

- path containment (`projectContext.resolvePath`)
- command policy (`rm -rf /`, curl|sh)
- agent write block (BUILD_TOOL_NAMES)
- plugin beforeToolCall veto
- grind injection (empty filesTouched on build tasks)
