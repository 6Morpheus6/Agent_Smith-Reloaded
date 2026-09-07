# LM Studio Context Control Design

## Goal

Make Agent Smith's context slider and runtime auto-tune configure the real context
length of a locally loaded LM Studio model, so the UI never claims more context than
the server can provide.

## Current Problem

`runtimeProfileUI` calculates a recommended context and updates Agent Smith's sliders,
but it does not inspect or reload LM Studio. LM Studio chooses context length when a
model is loaded. A model can therefore remain loaded at 4096 tokens while Agent Smith
budgets prompts as if 131072 tokens are available, causing repeated `finish_reason:
length` responses.

## Supported Boundary

Automatic server control applies only when the configured API base URL resolves to
loopback (`127.0.0.1`, `localhost`, or `::1`) and exposes LM Studio's
`/api/v1/models` management metadata. Remote and generic OpenAI-compatible servers
remain server-managed; Agent Smith changes only its client-side budget and labels that
state clearly.

## Architecture

### Main-Process Manager

Add `src/main/services/lmStudioManager.js`. It owns:

- Loopback and LM Studio detection.
- Reading `/api/v1/models` to find model capabilities and loaded-instance config.
- Serializing reload requests so rapid UI changes cannot race.
- Running the bundled `lms` CLI without a shell.
- Estimating and loading requested contexts.
- Falling back through supported lower context sizes.
- Returning the actual loaded context to the renderer.

The manager receives injected process and HTTP dependencies for deterministic tests.
It never accepts arbitrary CLI arguments from the renderer.

### IPC Contract

Add:

- `lmstudio-get-status`: returns endpoint type, model availability, maximum context,
  loaded context, parallel count, and whether Agent Smith can manage it.
- `lmstudio-ensure-model`: accepts `{ apiBaseUrl, model, contextLength }`, validates and
  clamps the request, then ensures the model is loaded at the best viable context.

The result includes:

```js
{
  managed: true,
  model,
  requestedContext,
  loadedContext,
  maxContext,
  fallbackUsed,
  reloaded,
  warning
}
```

### Renderer Integration

`runtimeProfileUI` becomes the coordinator for context synchronization:

- Auto-tune on model change applies the profile and immediately ensures LM Studio.
- Manual context slider changes are debounced before calling the manager.
- Programmatic slider updates do not mark a manual override.
- The chip displays `loading`, `reloading`, `ready`, `fallback`, or `server-managed`.
- If fallback occurs, the slider is updated to the actual loaded context.
- Starting a Chat, Agent, or Code run flushes any pending synchronization first.

The renderer receives `apiBaseUrl` and a busy-state callback through `mount()`. If a
generation is active, the newest requested context is queued and applied as soon as the
run becomes idle. This avoids destroying a model during an active stream while still
making slider changes immediate whenever the app is idle.

## Reload Policy

For a requested context `R`, candidates are unique descending values from:

1. `min(R, model.max_context_length)`
2. Standard fallback sizes below it: `131072`, `98304`, `65536`, `49152`, `32768`,
   `24576`, `16384`, `12288`, `8192`, `4096`

Each candidate is estimated before loading. The first candidate accepted by LM Studio
is loaded with:

```text
lms load <model> --context-length <candidate> --parallel 1 --gpu max
  --identifier <model> -y
```

If the same model is already loaded at the requested context and parallel count, no
reload occurs. Reload operations are serialized and latest-request-wins.

## Failure Handling

- Missing `lms` CLI: return an actionable warning and leave the slider client-side.
- LM Studio API unavailable: classify endpoint as unmanaged without crashing.
- Requested model absent: return an error naming the model.
- Every candidate fails: preserve the currently loaded model when possible and return
  the load error; do not claim the slider was applied.
- Fallback succeeds: update the slider and chip to the actual context.
- Active generation: display `Context change queued` and apply after idle.

## Security

- Only loopback endpoints can trigger local model management.
- Model identifiers must match a model returned by LM Studio.
- Context is parsed as an integer and clamped to `4096..model.max_context_length`.
- CLI execution uses `execFile`/`spawn` argument arrays, never shell interpolation.

## Testing

- Unit-test loopback detection, model inspection, no-op behavior, candidate fallback,
  serialized requests, and CLI argument construction.
- Unit-test renderer coordination for auto-tune, manual debounce, fallback slider
  correction, remote endpoint labeling, and busy queueing.
- IPC whitelist and registration tests.
- Run the full unit suite, harness regression suite, renderer build, and syntax checks.

