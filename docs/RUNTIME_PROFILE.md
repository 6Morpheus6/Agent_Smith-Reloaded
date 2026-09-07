# Runtime Profile (Auto-Tune)

Runtime auto-tune detects the **active model** and **GPU memory tier**, then applies recommended values to the existing TUNING sliders (temperature, thinking steps, context window) and Code Mode run limits when the model changes.

For local LM Studio (`localhost`, `127.0.0.1`, `::1`), the context slider is also applied to the actual loaded LM Studio instance. Agent Smith inspects LM Studio's `/api/v1/models` metadata and reloads the selected model with the requested context when needed, using `parallel=1` so large context windows fit more reliably.

This is separate from:

| Module | Concern |
|--------|---------|
| [`readiness.js`](../src/code/governor/readiness.js) | **Project** workspace score (tests, git, AGENTS.md) |
| [`gemmaHarness.js`](../src/code/context/gemmaHarness.js) | **Prompt/tool** adaptation for Gemma models |
| Hardware watchdog in `src/renderer/app.js` | **Display** VRAM/RAM bars — profile only reads telemetry |

## Modules

- [`src/shared/modelClassifier.js`](../src/shared/modelClassifier.js) — parses LM Studio model id → family, size bucket, coder/reasoning flags
- [`src/shared/runtimeProfile.js`](../src/shared/runtimeProfile.js) — `buildRuntimeProfile({ modelId, telemetry })` → tuning schema
- [`src/renderer/ui/runtimeProfileUI.js`](../src/renderer/ui/runtimeProfileUI.js) — auto-apply on model change; TUNING toggle + summary chip
- [`src/main/services/lmStudioManager.js`](../src/main/services/lmStudioManager.js) — local LM Studio status, estimate, reload, and fallback

## Profile schema

```js
{
  numCtx,           // context window (snapped to 1024)
  temperature,      // chat/agent slider
  codeTemperature,  // Code Mode LLM stream (typically 0.1–0.3)
  maxSteps,         // agent thinking-steps slider
  maxTurns,         // Code Mode earlyStop budget
  summary,          // UI chip text
  warnings,         // e.g. general instruct on Code Mode
  classifier,       // classifyModel() result
  vramTier          // low | medium | high | ultra
}
```

## VRAM tiers

| Tier | VRAM | Context ceiling |
|------|------|-----------------|
| low | &lt; 8 GB | 8K–12K |
| medium | 8–16 GB | 16K–24K |
| high | 16–24 GB | 32K–48K |
| ultra | 24+ GB | 64K–131K |

Larger parameter counts scale the ceiling down (14B ~0.75×, 32B+ ~0.5×). High VRAM pressure (`telemetry.is_high_pressure`) drops one tier and adds a warning.

## Example rules

- **Coder + medium VRAM** → ctx ~16K, maxTurns 50, code temp 0.15, steps 25
- **General 7B + low VRAM** → ctx 8K, maxTurns 40, temp 0.5, steps 15
- **32B + high VRAM** → ctx ~32K, maxTurns 35, temp 0.35, steps 20

## UI behavior

- **Auto-tune toggle** (`#auto-tune-toggle`, default on) — persisted as `agentsmith_auto_tune`
- On **model change**: fetch `get-gpu-telemetry`, build profile, write sliders + chip, then sync local LM Studio context
- **Manual slider move** sets `agentsmith_profile_override` so auto-tune does not fight the user until the next model switch; moving the context slider reloads local LM Studio after a short debounce
- Code Mode reads `maxTurns` and `codeTemperature` from localStorage keys set by the profile UI

## LM Studio synchronization

Local LM Studio context is fixed at model load time. If Agent Smith's slider says 131K but LM Studio loaded the model at 4K, the server will still truncate replies around the 4K window. To prevent that mismatch:

- Agent Smith calls `lmstudio-ensure-model` for local LM Studio endpoints.
- The main process estimates the requested context first.
- If the requested context cannot load, it retries lower context sizes and updates the slider to the highest successful value.
- Reloads use `lms load <model> --context-length <ctx> --parallel 1 --gpu max --identifier <model> -y`.
- If a Chat, Agent, or Code run is active, the latest context change is queued and flushed before the next run.
- Remote or generic OpenAI-compatible servers are marked `server-managed context`; Agent Smith does not attempt to mutate them.

## Tests

```
npm test -- tests/modelClassifier.test.js tests/runtimeProfile.test.js
```
