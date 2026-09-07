# LM Studio Context Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent Smith context settings immediately configure local LM Studio and automatically fall back to the highest loadable context.

**Architecture:** A focused main-process manager inspects and reloads local LM Studio through its management API and `lms` CLI. IPC exposes that manager to `runtimeProfileUI`, which synchronizes auto-tuned and manually selected context values while avoiding reloads during active generation.

**Tech Stack:** Electron IPC, Node.js `http`/`https`, `child_process.execFile`, browser JavaScript, Node test runner.

---

## File Structure

- Create `src/main/services/lmStudioManager.js`: local endpoint detection, model inspection,
  candidate selection, CLI execution, and serialized ensure operations.
- Create `src/main/ipc/lmStudio.js`: IPC registration and dependency wiring.
- Create `tests/lmStudioManager.test.js`: manager behavior and fallback tests.
- Create `tests/runtimeProfileUI.test.js`: renderer synchronization tests.
- Modify `src/shared/ipcChannels.js`: whitelist management channels.
- Modify `main.js`: register LM Studio IPC.
- Modify `src/renderer/ui/runtimeProfileUI.js`: immediate/debounced synchronization and status.
- Modify `renderer.js`: provide API base/busy dependencies and flush before runs.
- Modify `docs/RUNTIME_PROFILE.md`: document real server synchronization.

### Task 1: LM Studio Manager Core

**Files:**
- Create: `tests/lmStudioManager.test.js`
- Create: `src/main/services/lmStudioManager.js`

- [ ] **Step 1: Write failing endpoint and candidate tests**

Test exported `isLoopbackApiBase()` and `buildContextCandidates()`:

```js
assert.equal(isLoopbackApiBase('http://127.0.0.1:1234'), true);
assert.equal(isLoopbackApiBase('http://localhost:1234'), true);
assert.equal(isLoopbackApiBase('https://example.com/v1'), false);
assert.deepEqual(
    buildContextCandidates(70000, 65536).slice(0, 3),
    [65536, 49152, 32768]
);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/lmStudioManager.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement pure helpers**

Export:

```js
function isLoopbackApiBase(apiBaseUrl) { /* URL hostname validation */ }
function buildContextCandidates(requested, maxContext) { /* unique descending list */ }
```

- [ ] **Step 4: Add failing status inspection tests**

Inject `requestJson` and assert `getStatus()` maps `/api/v1/models` to:

```js
{
  managed: true,
  model: 'google/gemma-4-e4b',
  loadedContext: 4096,
  maxContext: 131072,
  parallel: 4
}
```

Also assert remote endpoints return `{ managed: false, reason: 'remote_endpoint' }`.

- [ ] **Step 5: Implement status inspection**

Add `createLmStudioManager({ requestJson, execFile })` and `getStatus(opts)`. Validate the
model against the API response and never invoke the CLI during status reads.

- [ ] **Step 6: Run manager tests**

Run: `node --test tests/lmStudioManager.test.js`

Expected: PASS.

### Task 2: Reload and Automatic Fallback

**Files:**
- Modify: `tests/lmStudioManager.test.js`
- Modify: `src/main/services/lmStudioManager.js`

- [ ] **Step 1: Write failing no-op and reload tests**

Assert:

- Matching loaded context with `parallel: 1` returns `reloaded: false`.
- A 65536 request executes estimate then load with argument arrays.
- `--parallel 1`, `--gpu max`, and `--identifier <model>` are always present.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/lmStudioManager.test.js`

Expected: FAIL because `ensureModel()` is absent.

- [ ] **Step 3: Implement `ensureModel()`**

Implement:

```js
async function ensureModel({ apiBaseUrl, model, contextLength }) {
  // inspect -> clamp -> no-op or estimate/load -> re-inspect -> result
}
```

Use `execFile(lmsPath, args)` with no shell.

- [ ] **Step 4: Write failing fallback test**

Make 65536 estimate fail and 49152 succeed. Assert:

```js
assert.equal(result.loadedContext, 49152);
assert.equal(result.fallbackUsed, true);
assert.match(result.warning, /49152/);
```

- [ ] **Step 5: Implement candidate fallback and serialization**

Try candidates sequentially. Maintain one promise chain per manager and collapse queued
requests so the latest requested context is applied after the active reload.

- [ ] **Step 6: Run manager tests**

Run: `node --test tests/lmStudioManager.test.js`

Expected: PASS.

### Task 3: IPC Surface

**Files:**
- Create: `src/main/ipc/lmStudio.js`
- Modify: `src/shared/ipcChannels.js`
- Modify: `main.js`
- Modify: `tests/codeToolRegistry.test.js` or add `tests/lmStudioIpc.test.js`

- [ ] **Step 1: Write failing IPC whitelist test**

Assert `INVOKE_CHANNELS` includes:

```js
'lmstudio-get-status'
'lmstudio-ensure-model'
```

- [ ] **Step 2: Run test and verify RED**

Run: `node --test tests/lmStudioIpc.test.js`

Expected: FAIL because channels and registrar are absent.

- [ ] **Step 3: Add channels and registrar**

Register handlers that pass only:

```js
{ apiBaseUrl, model, contextLength }
```

to the manager and return structured errors.

- [ ] **Step 4: Wire manager in `main.js`**

Instantiate once with the existing process dependencies and register beside other IPC
domains.

- [ ] **Step 5: Run IPC tests**

Run: `node --test tests/lmStudioIpc.test.js tests/codeToolRegistry.test.js`

Expected: PASS.

### Task 4: Renderer Context Synchronization

**Files:**
- Create: `tests/runtimeProfileUI.test.js`
- Modify: `src/renderer/ui/runtimeProfileUI.js`

- [ ] **Step 1: Write failing synchronization tests**

Mount with injected:

```js
{
  invoke: fakeInvoke,
  getApiBaseUrl: () => 'http://127.0.0.1:1234',
  isBusy: () => false
}
```

Assert auto-profile application calls `lmstudio-ensure-model` with the selected model and
profile context.

- [ ] **Step 2: Run test and verify RED**

Run: `node --test tests/runtimeProfileUI.test.js`

Expected: FAIL because synchronization is not implemented.

- [ ] **Step 3: Implement sync states**

Add:

```js
syncContextForModel(modelId, contextLength)
flushPendingContextSync()
```

Update the chip for reloading, ready, fallback, queued, unmanaged, and error states.

- [ ] **Step 4: Write failing manual-slider debounce test**

Dispatch several `input` events and one `change` event. Assert only the final context is
sent after the debounce interval.

- [ ] **Step 5: Implement debounce and fallback correction**

Use a short timer, set manual override, call ensure, and programmatically update the
slider when `loadedContext !== requestedContext` without creating another reload loop.

- [ ] **Step 6: Write and implement busy-queue test**

When `isBusy()` is true, store the latest request and show `queued`. When
`flushPendingContextSync()` runs idle, perform exactly one ensure call.

- [ ] **Step 7: Run renderer UI tests**

Run: `node --test tests/runtimeProfileUI.test.js`

Expected: PASS.

### Task 5: Application Wiring

**Files:**
- Modify: `renderer.js`
- Modify: `src/renderer/modes/code.js` only if run hooks cannot be injected centrally.

- [ ] **Step 1: Add failing wiring assertions**

Add a source-level test that verifies `runtimeProfileUI.mount()` receives:

```js
getApiBaseUrl
isBusy
```

and that Chat/Agent/Code start paths call `flushPendingContextSync()`.

- [ ] **Step 2: Run test and verify RED**

Run the new wiring test and confirm failure.

- [ ] **Step 3: Wire dependencies**

Provide the current API base URL and combined Chat/Code busy state. Flush pending context
before starting a new run. Keep remote endpoint behavior client-side.

- [ ] **Step 4: Run wiring and mode tests**

Run: `node --test tests/rendererInitOrder.test.js tests/runtimeProfileUI.test.js`

Expected: PASS.

### Task 6: Documentation and Verification

**Files:**
- Modify: `docs/RUNTIME_PROFILE.md`

- [ ] **Step 1: Update documentation**

Document that local LM Studio context is now applied at model load time, reloads use
parallel 1, fallback updates the slider, active runs queue reloads, and remote servers are
not mutated.

- [ ] **Step 2: Run focused tests**

Run:

```bash
node --test tests/lmStudioManager.test.js tests/lmStudioIpc.test.js tests/runtimeProfileUI.test.js
```

Expected: all pass.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test
npm run harness-eval-regression
npm run build:renderer
node --check src/main/services/lmStudioManager.js
node --check src/main/ipc/lmStudio.js
node --check src/renderer/ui/runtimeProfileUI.js
```

Expected: all commands exit 0.

