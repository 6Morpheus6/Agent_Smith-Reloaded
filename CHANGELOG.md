# Agent Smith Changelog

## [56.0.0] - 2026-10-09 — 🔄 Updatable AppImage (zsync) + .deb for v56

User request: "other users have been asking me to make the appimage updateable and i dont know how
to do that" — a user explained it needs `appimagetool -u "<gh-releases-zsync URL>"` so an
`.AppImage.zsync` delta file is produced alongside, both uploaded to GitHub Releases.

What "updatable AppImage" actually means: the AppImage runtime can check a *zsync* (rsync-style
delta) endpoint and download only the changed blocks of a newer release instead of re-fetching the
whole ~270MB image. That requires TWO things, both now done:
1. An **UPDATEINFO header string** baked into the AppImage telling it where to look.
2. A matching **`.AppImage.zsync`** file uploaded next to each release (the delta manifest).

### Why a new script was needed
electron-builder 26.x does NOT write that UPDATEINFO header — it only emits an electron-updater
`.blockmap`, which this app doesn't consume. So the classic AppImage update channel had to be added
with raw `appimagetool -u` (the exact command from the user's explanation).

### What changed
- **`scripts/build-updatable-appimage.sh`** — new, reproducible build step. Assembles an AppDir from
  electron-builder's `release/linux-unpacked/` + `vendor/appdir-chrome/` (AppRun/.desktop/icons/usr
  libs), then runs:
  ```
  appimagetool -u "gh-releases-zsync|6Morpheus6|Agent_Smith-Reloaded|latest|Agent.Smith.Reloaded-*.AppImage.zsync" \
      AppDir Agent.Smith.Reloaded-<ver>.AppImage
  ```
  One command produces BOTH the updatable `.AppImage` (header embedded) and its `.zsync`. It then
  verifies: header round-trips via `--appimage-updateinfo`, zsync `Length` == actual file size, and
  removes electron-builder's non-updatable duplicate.
- **`vendor/appimagetool-x86_64.AppImage`** — vendored appimagetool (continuous build) so the build is
  self-contained; it bundles its own `zsyncmake`, so no system install / sudo needed.
- **`vendor/appdir-chrome/`** — AppRun, `.desktop`, icon set + desktop-integration libs captured from
  a known-good electron-builder AppDir (version-independent chrome).
- **Version bump 55.9.2 → 56.0.0** in `package.json`; `index.html` / README badge auto-synced by the
  existing `build-renderer.js`.

### How to ship it (each release)
```bash
npm run dist && bash scripts/build-updatable-appimage.sh   # or: npm run dist:updatable
```
Upload ALL THREE to the GitHub Release (tag `v<ver>`):
- `release/Agent.Smith.Reloaded-<ver>.AppImage`
- `release/Agent.Smith.Reloaded-<ver>.AppImage.zsync`   ← must be uploaded too, or updates break
- `release/agent-smith_<ver>_amd64.deb`

### Verified
- Header: `--appimage-updateinfo` returns the exact gh-releases-zsync URL.
- zsync SHA-1 matches `sha1sum` of the AppImage; `Length` field == file size.
- New AppImage launches (AMD Strix Halo detected, web UI on :3000) — not just packaged.
- `.deb` metadata: Package agent-smith, Version 56.0.0, amd64.
- Unit tests: 1068/1079 pass — identical to the v55.9.2 baseline (same 11 pre-existing failures).

## [55.9.2] - 2026-10-08 — 🎛️ Explicit context control: APPLY button + no more 32K snap-back

User request: "if i try to change ctx to a number higher than 32000 it still shows in agent smith
as 32000. anything over 32000k ctx should be accepted when detected" — plus an explicit APPLY
button next to the slider that reloads LM Studio at exactly what the user set.

Root cause — reproduced against the real modules: `ensureNow()` in
`src/main/services/lmStudioManager.js` treated ANY loaded window different from the requested one
as "wrong". The fast path only matched on exact equality (`loadedContext === requestedContext &&
parallel === 1`). So when LM Studio had a model loaded at, say, 65K/131K and Agent Smith asked for
its 32000 floor (auto-tune) or a stale slider value, the manager UNLOADED the model and reloaded it
DOWN to 32000 — then REFLECTION mirrored that 32000 back onto the slider. Every "change ctx above
32K" attempt ended up showing 32000 in the app, no matter what LM Studio actually had loaded.

### What changed
- **`src/main/services/lmStudioManager.js`** — `ensureNow()` now accepts a loaded window that is at
  OR ABOVE the requested context (no reload; the larger window is reported as-is). A smaller loaded
  window still reloads UP to the request (v55.9.1 min-ctx auto-reload preserved), and a larger
  request than what's loaded still grows the window — only "already at or above" became a no-op.
- **`src/renderer/ui/runtimeProfileUI.js`** — new `applyCtx(modelId, contextLength)`: the explicit
  MANUAL CTX APPLY path. It works whether Auto-tune is on or off, sends EXACTLY the slider value to
  `lmstudio-ensure-model`, mirrors what actually loaded back onto the slider + chip (VRAM fallbacks
  reported honestly), and keeps the 10s reflection loop from fighting it mid-reload (`_applyingCtx`).
  The ctx slider's old debounced auto-sync on every drag is gone — dragging only marks a manual
  override; pressing APPLY commits it. `mount()` accepts an `applyBtn` element (busy state + label).
- **`index.html`** — APPLY button next to the Context Window slider in the manual ctx field.
- **`src/renderer/app.js`** — passes the button into `XKRuntimeProfileUI.mount()` and wires its
  click to `applyCtx(modelSelect.value, ctxSlider.value)`.

### Tests
- `tests/lmStudioManager.test.js` — regression: loaded 131072 + request 32000 → NO reload, reports
  131072; plus the two inverse directions (grow up from below, min-ctx reload) still work.
- `tests/runtimeProfileUI.test.js` — slider drags no longer auto-sync; APPLY sends the exact value
  above the minimum and mirrors it back; VRAM fallback + unmanaged-endpoint paths report honestly.

## [55.9.1] - 2026-10-07 — 🧠 Auto-tune keeps LM Studio's loaded context honest (min-ctx auto-reload)

User request: "make sure autotune is able to refresh detected ctx changes in lm studio and any
model loaded in agent smith if detected model isnt loaded with a minimum of 32000 ctx it needs
to be automatically reloaded in lm studio for the user at 32000 ctx."

Root cause — two gaps, both reproduced against the real modules:

1. **Auto-tune could target a window below its own floor.** `buildRuntimeProfile()` sized
   `num_ctx` from VRAM tier × model size (e.g. 8K–18K on low-VRAM cards). That value drove BOTH
   auto-tune's context sync AND the v52.5 model-swap load — so the app would happily reload LM
   Studio at a window that is *below* the 32000-token minimum `ctxGate` enforces on every send.
   The user then hit "Minimum context not met" and was told to fix it by hand in LM Studio.

2. **A model already loaded below the floor was never fixed.** The 10s refresh loop re-read what
   LM Studio actually has loaded (REFLECTION) but only *mirrored* that value onto the slider — if
   the user had loaded a model at, say, 8K in LM Studio, auto-tune dutifully reflected 8K and did
   nothing. The send gate then blocked every message with "unload it and reload it with a context
   length of 32000 or higher" — i.e. the app detected the problem but made the user fix it.

### What changed
- **`src/shared/runtimeProfile.js`** — `buildRuntimeProfile()` now floors `num_ctx` at
  `ctxGate.minCtx()` (32000, env-overridable via `XK_MIN_CTX`). Applied LAST so no VRAM-tier cap
  can push it back below the minimum. A profile may never target a window Agent Smith can't use;
  when hardware genuinely cannot hold 32K the main-process loader's fallback ladder degrades and
  reports it, and a warning is surfaced on the chip.
- **`src/renderer/ui/runtimeProfileUI.js`** — MIN-CTX AUTO-RELOAD: `refreshLoadedContext()` (run by
  the 10s loop AND every send) now detects a VERIFIED loaded window below the floor and calls the
  new `ensureMinCtx(modelId)` to reload THAT model in LM Studio at exactly 32000. Guards: only when
  auto-tune is ON with no manual override; never while a run is busy or another sync/reload is in
  flight (the loop retries next tick); and a 60s back-off after a FAILED attempt so unfixable
  hardware doesn't churn a multi-GB unload/load every ten seconds. New `awaitMinCtxReload()` lets
  the send gate join an in-flight fix, and `getMinCtxReloadState()` reports in_flight/backoff.
- **`src/renderer/app.js`** — the min-ctx send gate now joins any in-flight auto-reload (bounded)
  and re-verifies before deciding to block; when it still blocks it says "auto-tune is reloading /
  will keep retrying automatically" instead of only the old manual "fix it yourself" wall.

### Tests
`tests/minCtxAutoReload.test.js` (new, 8 tests) covers: below-min → reload at exactly 32000;
at/above min → no reload; auto-tune OFF / override → detected but not reloaded; failed reload →
back-off + VRAM message; success clears back-off so a later regression is fixed again; the send-gate
join path; busy runs defer to the next tick; unmanaged/unreachable endpoints never trigger it.
`tests/runtimeProfile.test.js` updated for the floor (env-overridable).

## [55.9.0] - 2026-09-27 — 📱 Remote web UI button renders in browser (Windows) mode again

User report: "the windows version is missing the icon for sharing the remote webui."

Root cause — `src/renderer/app.js` hid the composer's 📱 button (`#phone-connect-btn`,
which opens the QR modal to open/share the remote web UI on a phone) whenever the page
loaded over http(s):

```js
if (isWebMode && phoneConnectBtn) phoneConnectBtn.style.display = 'none';
if (phoneConnectBtn && !isWebMode) { /* wire click */ }
```

Windows users run Agent Smith Pinokio-style through a browser, where the page is served
over http(s), so `isWebMode` was true and the button never rendered — while native
Electron (file://) showed it fine. The "pointless in a browser" premise was wrong: in a
desktop browser you still want to scan the QR with your real phone.

### What changed
- **`src/renderer/app.js`** — the 📱 button is now shown and wired in BOTH Electron and
  web mode (`if (phoneConnectBtn)`). On actual phones nothing changes: at ≤768px viewports
  `base.css` replaces the whole `.input-area` with the mobile FAB composer, so the button
  never appears there anyway.

## [55.8.0] - 2026-09-26 — Limitless deep-research budget (findings can no longer kill the run)

User report: "there's an issue with the search tool where the budget burns out before
the model is done, and then I see 'Compiled from the search results above — the model
spent its reply on internal reasoning and never wrote its own summary, so these are the
findings verbatim.' The model throws out what it had but it's just a regurgitation because
it was force-nudged. If the agent needs more budget to complete its deep research then
ensure it can by making its budget limitless."

Root cause — two compounding bugs, both reproduced against the real modules:

1. **The model never saw its own findings.** `web_search` (v54+) returns a DEEP RESEARCH
   REPORT of up to ~100k chars — that report IS the answer material, and its nudge demands
   a 1500+ word synthesis of it. But `contextPrune.pruneChatHistory()` caps EVERY recent
   tool result at `MAX_TOOL_CHARS` (1600) before each turn: an 87k-char report reached the
   model as a 1,663-char fragment + "…[truncated 86004 chars]". The nudge then demanded a
   long synthesis of a stub — impossible. The thinking-by-default model burned its entire
   per-reply output budget on reasoning (finish_reason:"length", zero content), the run fell
   into the v53.5 silence fallback, and the user got the "Compiled from … verbatim" dump.

2. **The context window was a hard cap mid-run.** When accumulated history + reports outgrew
   LM Studio's loaded context length, the request 400'd with `exceed_context_size` and the run
   died with "Lower the Context Window slider and retry" — i.e. the app told the user to make
   their research budget SMALLER while mid-research.

### What changed
- **`src/shared/contextPrune.js`** — deep-research reports (detected by the stable
  `DEEP RESEARCH REPORT` header, new exported helper `isDeepResearchReport`) are EXEMPT from
  the size cap while they sit in the recent window: they pass through verbatim. Reports pushed
  out of the recent window (older than `keepRecentTool`) and prior-session reports still stub
  to `[earlier tool output omitted…]`, so context stays bounded — the exemption is about the
  ACTIVE research, not unbounded history. All other tool results cap exactly as before.
- **`src/renderer/app.js`** — LIMITLESS RESEARCH BUDGET: when a mid-run request fails with a
  classified context overflow (`classifyHttpError.isContextOverflow`) and this run has not yet
  auto-expanded, the app asks LM Studio for the model's `max_context_length`, reloads at that
  maximum via `lmstudio-ensure-model` (the existing VRAM-safe path — it estimates first and
  falls back to the largest loadable window), marks the swap handled (suppresses the redundant
  10 s re-sync), and retries the SAME turn. One-shot per run (`ctxAutoExpanded`) — if it
  overflows again at max, the history is genuinely too big and the honest error surfaces
  instead of looping. Unmanaged/remote endpoints skip straight to the honest error.
- **`src/renderer/modes/webSearchFallback.js`** — the "Compiled from the search results above —
  … these are the findings verbatim" footer is GONE. The synthesized answer (first person,
  sources named inline) is presented as Smith's report, not an apology for a forced dump.
- **Tests** — `tests/contextPrune.test.js` (+6: verbatim recent report, out-of-window stub,
  prior-session stub, detector, non-report cap unchanged, idempotence),
  `tests/webSearchFallback.test.js` (footer-gone assertion), new `tests/researchBudget.test.js`
  (pins the auto-expand wiring + one-shot flag + fall-through error).

### What did NOT change
Turns were already infinite (v52.7) — no step cap was added or removed. The v53.5 silence /
web-only-batch fallbacks still exist as a last resort for genuinely silent models, but with the
report intact they are now reached only when the model truly produces nothing. No new env vars
or config keys; the expansion uses the existing `lmstudio-get-status` / `lmstudio-ensure-model`
IPC and LM Studio's own VRAM estimation.

### Verified
Unit suite green (see 55.7 section for the runner). Reproduction check: an 87,604-char report
pruned through `pruneChatHistory` now survives byte-for-byte (was 1,663 chars + truncation
marker before this fix).

## [55.7.0] - 2026-09-26 — No parallel web searches (one search per turn)

User report: "when I asked it to do a search, because it decided to do parallel
searches it burned through its chars budget."

Root cause — the model was never told not to fan out. `web_search` is a DEEP
RESEARCH call (v54): each one reads the top result pages in full and returns a
long report into history, so N parallel searches = N× page-reads + N× reports in
one turn. Worse, Code Mode's SYSTEM_PROMPT actively encouraged it: "BATCH
INDEPENDENT WORK — emit them ALL in ONE reply: they run concurrently." Nothing
excluded web_search from that advice, and the dsh dispatch lane happily overlaps
whatever the model emits (web_search is exclusive-classified, so it serialized
anyway — no speed win, only N× context cost).

### What changed (prompt-level only — no new guardrail machinery)
- **`src/renderer/modes/agentTools.js`** (chat mode):
  - `AGENT_MODE_SYSTEM_APPENDIX` gains a "NO PARALLEL SEARCHES" section: at most
    ONE web_search per turn; if more than one topic is needed, run them
    SEQUENTIALLY (search → wait for its result → next search) or fold everything
    into a single well-phrased query.
  - `web_search` tool schema description now says "ONE search per turn: never emit
    multiple web_search calls in one reply — each reads whole pages and burns the
    context budget." (Small models read the schema more than the appendix.)
- **`src/code/loop/turnLoop.js`** (code mode):
  - SYSTEM_PROMPT "BATCH INDEPENDENT WORK" now carries an explicit exception:
    "web_search is NEVER batched: at most ONE search per reply."
  - New rule 20 in the numbered rules: "NO PARALLEL SEARCHES — at most ONE
    web_search call per reply, never several in one turn (batching applies to
    reads/greps, NOT searches) …"
- **`package.json` / `index.html` / `README.md`** — version 55.7.0 + description/badge.

### What did NOT change
Execution paths are untouched: the chat batch executor and the code-mode dispatch
lane still run whatever (single) search the model emits, exactly as before. No
new env vars, config keys, or runtime guards — this is pure instruction to the
model, per request ("everything else works correctly; the agent just needs to know").

### Verified
- `npm test` full suite: 100% pass (see build log) — no behavior tests touched.
- `node --check` on both edited modules; renderer bundle rebuilt via
  `scripts/build-renderer.js`; "NO PARALLEL SEARCHES" confirmed present in the
  shipped `dist/renderer/bundle.js`.

## [55.6.0] - 2026-09-26 — Default Piper TTS voice switched to en_US-joe-medium

User request: "change the default tts piper voice to joe."

### What changed
- **`resources/piper/voices/`** — swapped the bundled voice: `en_US-lessac-medium.onnx(.json)` →
  `en_US-joe-medium.onnx(.json)` (HuggingFace rhasspy/piper-voices, en/en_US/joe/medium). Same
  Piper 2023.11.14-2 runtime, same ~60 MB model size — only the voice changed. The old lessac files
  were removed from the bundle so the AppImage/.deb ship exactly one voice (joe).
- **`src/main/lifecycle/tts.js`** — `VOICE_NAME`: `en_US-lessac-medium` → `en_US-joe-medium`. This is
  the single source of truth: runtime resolution (`findRuntimeIn`) looks for `voices/<VOICE_NAME>.onnx`,
  synthesis passes it to `piper --model`, and `tts-status` reports it — so the whole chain (status probe,
  TEST button toast "Piper (en_US-joe-medium)", response speech) follows automatically.
- **`index.html`** — SPEAK RESPONSES tooltip now names the joe voice; sidebar version chip → v55.6.0.
- **`package.json`** — version 55.6.0, description updated to name the new default voice.

### What did NOT change
Everything else: the Piper engine architecture (v55.5), playback chain (paplay/aplay/afplay/SoundPlayer),
newest-response-wins interruption, 90 s synthesis timeout, 32K min-ctx gate, Code Mode, and all other
settings.

### Verified
- `tests/tts.test.js`: **19/19 pass** (fake piper/player binaries; the tests key off `tts.VOICE_NAME`, so
  they exercise the joe path end-to-end).
- Real runtime smoke test on this machine: `piper --model voices/en_US-joe-medium.onnx` → valid WAV,
  synthesis RTF measured (see build log), no stderr.

## [55.5.0] - 2026-09-24 — SPEAK RESPONSES actually speaks again (Piper TTS restored in the main process)

User report: "the speak response toggle doesn't seem to work when I enable it and prompt the model, it
doesn't actually speak."

Root cause — **Electron on Linux has no Web Speech API backend.** The toggle drove `localSpeak()` →
`window.speechSynthesis.speak(...)` in the renderer. Chromium's speech-synthesis service is not built into
Linux Electron, so every utterance was silently dropped: TEST button silent, responses silent, zero errors
anywhere (the "not supported" branch never fires — `speechSynthesis` exists as an object, it just has no
voices/engine). The original desktop Piper path was deleted in v44.2 ("Browser Web Speech API TTS remains")
and that remaining path never worked on this platform.

What changed:
- **NEW `src/main/lifecycle/tts.js`** — main-process Piper engine (the same architecture v44.2 removed,
  rebuilt):
  - Synthesis via the bundled `piper` binary (`--model <voice> --output_file <tmp.wav>`, text on stdin),
    with a 90 s timeout + stderr capture for honest error messages.
  - Playback via `paplay` (PulseAudio/PipeWire) → `aplay` (ALSA) on Linux, `afplay` on macOS, PowerShell
    SoundPlayer on Windows. **Newest response wins** — a new request kills in-flight audio and supersedes an
    in-flight synthesis (a slow first reply can't talk over the second).
  - Runtime resolution: explicit `resourcesDir` → dev `<repo>/resources/piper` → packaged
    `<process.resourcesPath>/piper`. `ESPEAK_DATA_PATH` points at the bundled espeak-ng phonemizer data so no
    system package is required.
- **NEW `resources/piper/`** (~130 MB, ships via electron-builder `extraResources`, outside app.asar):
  Piper 2023.11.14-2 linux-x86_64 runtime (piper + onnxruntime 1.14.1 + espeak-ng phonemizer + data) and the
  **en_US-lessac-medium** voice (HuggingFace rhasspy/piper-voices). Measured RTF ≈ 0.043 — a 2 s reply
  synthesizes in ~90 ms, so speech starts almost immediately after the model finishes.
- **`main.js`** — registers `tts-status` / `tts-speak` IPC (startup-failure-tolerant like WhatsApp).
- **`src/shared/ipcChannels.js`** — both channels whitelisted for the preload bridge.
- **Renderer (`src/renderer/app.js`)** — `localSpeak()` now: (1) in Electron, probes `tts-status` once and
  speaks through `tts-speak`; (2) only falls back to Web Speech API when running as a plain web page. When no
  engine/player exists the user gets ONE honest system message per session ("TTS unavailable — …") instead of
  silent nothing. The TEST button exercises the exact same Piper path and confirms with a toast; the
  SPEAK RESPONSES label carries a tooltip naming the voice.
- **`package.json`** — `build.extraResources: resources/piper → piper`; version 55.5.0.

What did NOT change: the toggle's location/behavior contract (on = speak every final response, off = silent),
Code Mode, the v55.4 min-ctx gate, and everything else.

Verified:
- `tests/tts.test.js`: **19/19 pass** — runtime resolution layout, which/findPlayer probing, synthesize
  success/failure-with-stderr/timeout-kill, playWav completion + interrupt, IPC status/speak/empty-text/
  error-object/no-temp-file-leak/newest-wins-supersede (fake piper/player shell scripts; no audio device needed).
- Real runtime smoke test on this machine: `piper --model voices/en_US-lessac-medium.onnx` → valid 22.05 kHz
  WAV, RTF 0.043; live playback through PipeWire confirmed.

## [55.4.0] - 2026-09-21 — Min-ctx gate lowered from 64K to 32K (single-setting change)

User request: "lower the ctx gate down to 32000 and dont change any of the other settings."

### What changed
- `src/shared/ctxGate.js` — `DEFAULT_MIN_CTX`: **64000 → 32000**. This is the single source of truth for the send-time context gate: a model LM Studio reports as loaded with ≥ 32,000 tokens now passes; below that it still blocks with the same actionable "reload with more context" message (now naming 32000).
- `tests/ctxGate.test.js` — assertions updated to the new default (default value, pass/boundary at exactly 32000, block case moved to 16384 which is now genuinely below the gate; the v51.6 process-less-renderer regression test asserts 32000 too).
- Comments in `src/code/loop/contextWindow.js` + `src/renderer/app.js` updated so they no longer state the old 64K value (comments only — no behavior change).

### What did NOT change (per request)
- Code Mode's own request floor/cap (`CODE_MIN_NUM_CTX=65536`, `CODE_MAX_NUM_CTX=98304`) untouched. It clamps *within* whatever window the model actually has loaded (`clampCodeNumCtx`), so a 32K–64K model simply requests less — over-requesting (silent backend truncation) is still impossible.
- Slider bounds (2048–262144), `XK_MIN_CTX` env override, reflection logic, unmanaged-endpoint bypass, and every other setting: untouched.

### Verified
- `tests/ctxGate.test.js`: 9/9 pass at the new value (boundary inclusive at exactly 32000; 16384 blocks with a message naming the model + fix).
- Full unit suite vs baseline — no new failures beyond the known seccomp set.

## [55.3.0] - 2026-09-21 — Electron Depot auto-provisioning (vendor/ no longer bundled; ~635 MB off the package)

User request: "add auto detect for the electron tool to verify that its assets are there and if detected
missing pull and install them on first launch. Also need a notification that informs user those assets are
being downloaded ... i plan to remove those assets in vendor folder that are related to the electron tool so
this app isnt taking over 2 gigs."

Why — **the Electron Depot (v54.8) ships ~635 MB of pre-provisioned runtimes/toolsets INSIDE the package**
(`vendor/electron/*.zip` ≈564 MB + `vendor/electron-builder/*` ≈71 MB), which pushed the AppImage/.deb past
GitHub's free-tier upload limit and made every install carry 2 GB+ of assets most users never use.

What changed:
- **NEW `src/shared/electronAssetsManifest.js`** (auto-generated by
  `scripts/gen-electron-assets-manifest.js`) — the single source of truth for WHAT to fetch: exact GitHub URL +
  `sizeBytes` + `sha256` per asset, read from the REAL files on disk. 8 assets (~576 MB): five Electron runtime
  zips (31.7.7 / 37.10.3 / 42.5.0 / 42.9.3 / 42.10.1 linux-x64) + three builder toolsets (appimage-12.0.1,
  fpm@2.1.4, 7zip@1.0.0). Re-run the generator whenever vendor/ changes.
- **NEW `src/main/services/electronAssets.js`** — the provisioner. On first launch it: (1) AUTO-DETECTS which
  manifest assets are missing from the local cache (size check, then sha256), (2) DOWNLOADS only what's missing
  via imageGenManager.downloadFile (redirects + .part temp files + idle watchdog), (3) VERIFIES each file's sha256
  before trusting it (a corrupt/partial download is rejected and re-fetched, never moved into place), and (4) places
  every file EXACTLY where @electron/get / app-builder-lib already look — a downloaded depot and the old seeded
  (vendor) depot are indistinguishable to the build tools. Runtime zips land in `<userData>/electron-cache/<sha>/`
  (install.js's explicit cacheRoot) with zero-disk symlink mirrors into `<userData>/electron/<sha>/` (app-builder-lib's
  envPaths default under XDG_CACHE_HOME=<userData>) and `~/.cache/electron/<sha>/` (manual terminal builds). Toolset
  archives land in `<userData>/electron-builder/<release>/<file>` + the @electron/get downloads fallback; app-builder-lib
  extracts them itself on first use, so shipping archives only is sufficient.
- **Startup trigger** (`main.js`) — `ensureInstalled()` runs ~2 s after ready (non-blocking); a failure degrades to
  the old behavior where build tools fetch from GitHub on demand. Progress reaches the UI over the new
  `electron-assets-event` push channel; status/retry via `electron-assets-status` / `electron-assets-retry`.
- **NEW sidebar "BUILD ASSETS" section** (`src/renderer/ui/electronAssetsPanel.js`) — live "⬇ Downloading … X/Y MB (N%)"
  progress bar while a transfer runs (auto-expands so first-launch users see it), an honest final state, and a RETRY
  button after failures.
- **`package.json`** — `build.files` no longer includes `vendor/electron/**/*` or `vendor/electron-builder/**/*`, so the
  AppImage/.deb drops ~635 MB (≈2 GB → ≈1.4 GB). Dev mode is unaffected: `getAppPath()` still finds vendor/ on disk and
  seeds it as before; only the packaged app triggers auto-download.
- **SYSTEM_PROMPT rule #16** updated — "PRE-PROVISIONED" → "harness-managed depot cache, auto-downloaded on first launch";
  a one-time "downloading electron" in build output is now documented as NORMAL (a ~120 MB fetch), not a failure.

What did NOT change: the v54.8 depot env wiring (`electron_config_cache` / `XDG_CACHE_HOME` overrides on every Code Mode
shell), seedDepot's layout, all sudo/timeout behavior from v55.2, and the fact that once assets are cached builds run fully
offline.

Tests: `tests/electronAssets.test.js` (new, 9) — manifest self-consistency, destination layout vs @electron/get +
app-builder-lib, end-to-end ensureInstalled with a fake downloader (download→verify→place, idempotent no-op when complete,
failure degrades without throwing, sha256-mismatch rejection), and status() for the UI catch-up path. Plus a one-shot REAL
network test: downloaded 7zip-linux-x64.tar.gz from GitHub (exact manifest size + sha256) into both cache layouts.

## [55.2.0] - 2026-09-21 — FIX: v55.2 sudo change blanked the entire sidebar (renderer bundle crash)

User report: "v55.1 is the last stable working version ... all you had to do was simply make it where
agent could sudo and whatever u did broke the whole side bar in the gui."

Root cause — **the v55.2 sudo work made a RENDERER module require a MAIN-process module, dragging a
node builtin into the browser bundle.** `src/renderer/modes/agentTools.js` (bundled by esbuild for
`platform:'browser'`) gained a top-level `require('../../shared/commandPolicy.js')`. That module's own
top-level `const path = require('path')` is left as an EXTERNAL by esbuild, so the rebuilt
`dist/renderer/bundle.js` contained a static `require("path")`. The main window runs with
`nodeIntegration:false` / `contextIsolation:true` (main.js createWindow) — a pure browser context where
`require` does not exist — so the bundle threw "Dynamic require of 'path' is not supported" at load time,
killing the ENTIRE renderer: no sidebar, no composer, nothing. v55.1's bundle contained zero static
builtin requires (only one unreachable dynamic `require()`), which is why it loaded fine.

What changed:
- **NEW `src/shared/sudoInject.js`** — browser-safe home for `injectSudoPassword(command, pass)` (pure
  string logic, no node builtins). Same function, same behavior: rewrites EVERY sudo, escapes
  `"`, `\`, `$`, backtick, idempotent on already-injected prefixes.
- **`src/shared/commandPolicy.js`** — `injectSudoPassword` moved out; the module now REQUIRES it from
  sudoInject.js and re-exports it, so every main-process consumer (`src/code/tools/executor.js`) is
  unchanged.
- **`src/renderer/modes/agentTools.js`** — requires `../../shared/sudoInject.js` instead of
  commandPolicy.js. The rebuilt bundle again contains no static builtin require (verified: the only
  remaining `require(` in it is the same unreachable dynamic one v55.1 shipped).

What did NOT change: any sudo-authorization behavior from the original v55.2 entry below — leading-sudo
exemption, per-run password threading (Agent Mode + Code Mode), long-build timeouts for package-manager
ops are all exactly as before; only WHERE the injection function lives changed.

Tests: `tests/rendererBundleBrowserSafe.test.js` (new, 4) — asserts the built bundle contains no static
require of any node builtin (the exact shipped-bug signature), that agentTools.js requires sudoInject.js
and NOT commandPolicy.js, that sudoInject.js is builtin-free and exports a working function, and that
commandPolicy still re-exports it. Also verified by loading the real index.html + bundle in jsdom
(browser context, no require): old v55.2 bundle → "Dynamic require of 'path' is not supported"; fixed
bundle → zero script errors, sidebar/composer present.

## [55.2.0] - 2026-09-21 — SUDO OVERRIDE actually authorizes sudo (policy no longer blocks it)

User report: "this harness has the option for user to submit sudo password and this is intended so
agent can use sudo privileges. The problem is even if i give sudo the policy blocks agent from using
it. For example i asked agent to update my debian system using `sudo apt update && sudo apt upgrade -y`
and i provided my pass in the sudo override field and the policy blocked it. If sudo is provided via
the override the agent should have full permission to use it."

Root cause — **a blanket denylist rule vetoed every command containing "sudo", before or after any
password was supplied.** `src/shared/commandPolicy.js` carried
`{ re: /\bsudo\b/i, reason: 'privilege escalation (sudo) is not permitted in autonomous mode' }` as a
layer-1 rule. The SUDO OVERRIDE field (`#sudo-input`, index.html) and its password-injection machinery
already existed — `src/renderer/modes/agentTools.js` rewrote `sudo X` → `echo "<pass>" | sudo -S X` for
Agent Mode's `run_shell_command` — but the rewritten command STILL contains "sudo", so
`assessCommand()` (called in `src/main/ipc/agent.js` and `src/code/tools/executor.js`) vetoed it with
"privilege escalation (sudo) is not permitted". The override could therefore never take effect. Code
Mode had no injection at all: its `run_command` went straight to the same blanket rule.

What changed:
- **`src/shared/commandPolicy.js`** — removed the blanket `\bsudo\b` denylist rule. A command that
  BEGINS with sudo (or an already-injected `echo '<pass>' | sudo -S` prefix) is now judged by layer 1
  ONLY and then allowed: layers 2/3 (home/system-secret files + project-root containment) exist to keep
  an UNPRIVILEGED autonomous agent inside its sandbox, but with explicit root authorization system paths
  are the legitimate target (`sudo apt upgrade`, `sudo dpkg -i /tmp/x.deb`). Layer 1 still applies to
  elevated commands — no override implies unrecoverable machine damage: `sudo rm -rf /`, `sudo mkfs …`,
  `sudo dd of=/dev/sda`, and piping remote downloads into an interpreter are all still blocked. A sudo
  that appears MID-command (not leading) does not earn the exemption, so a non-elevated secret read can't
  piggyback on an authorized elevated tail (`cat ~/.ssh/id_rsa && sudo apt update` is still refused).
- **NEW `injectSudoPassword(command, pass)`** in the same module — single source of truth for password
  injection. Rewrites EVERY `sudo` in the command (the old Agent Mode replace missed
  `sudo x && sudo y`), escapes `"`, `\`, `$`, backtick so a password can never break out of the echo or
  spawn a subshell, and is idempotent on already-injected prefixes. No password / no sudo → unchanged.
- **Agent Mode** (`src/renderer/modes/agentTools.js`) — `run_shell_command` now uses
  `injectSudoPassword()` instead of its inline single-pass replace (same behavior for one sudo, correct
  for many, safe escaping).
- **Code Mode** — the override field is threaded per-run: renderer reads it at run/resume/plan-approve
  time (`src/renderer/app.js` mount dep `getSudoPassword`, `src/renderer/modes/code.js` payloads) →
  `code-run` / `code-resume` / `code-plan-approve` IPC (`src/main/ipc/code.js`) → in-memory
  `activeRun.sudoPassword` (NEVER persisted to a CodeSession on disk, mirroring the apiKey pattern) →
  `buildExecDeps()` → executor's `run_command`, which injects BEFORE the policy screen and before the
  shell runs. Sub-dispatches from `run_code` inherit it through the same deps object.
- **Timeouts** (`src/shared/longBuildPolicy.js`) — system package-manager operations are now recognized
  long operations: `sudo … apt/dpkg`, `apt-get/aptitude update|upgrade|install|full-upgrade`,
  `dpkg -i/-r/--install/--remove`, `yum/dnf update|upgrade|install`, `pacman -Syu/-S`. A full
  `sudo apt upgrade -y` no longer dies at the default bound. Agent Mode's foreground shell
  (`src/main/ipc/agent.js`) now resolves its timeout through `foregroundTimeoutFor()` (90 s fast-fail
  default preserved for ordinary commands; long ops get the build-sized window) instead of a flat 90 s —
  previously even an authorized `sudo apt upgrade` would have been SIGKILLed at 90 s in chat mode.

What did NOT change: layer-1 catastrophic rules (still apply to elevated commands), layers 2/3 for
non-elevated commands, the SUDO OVERRIDE field itself (same `#sudo-input`, same app-reset usage — that
path already worked and is untouched), session persistence format (no new on-disk fields; the password
lives only in memory for the duration of a run), all other tools/phases/middleware.

Tests: `tests/commandPolicy.test.js` (new) covers the v55.2 contract — leading-sudo allowed, injected
prefix form allowed, mid-command sudo still screened, elevated catastrophic/secret commands still
blocked, `injectSudoPassword()` multi-sudo + escaping + idempotency; existing
`securityPolicy.test.js` / `codeSecurity.test.js` expectations updated to the new contract.

## [55.0.0] - 2026-09-15 — Deep Research budget tripled (answers no longer capped short)

User request: "everything works how it should but i do not like the chars cap on deep research
web tool. the reports it currently gives are correct but are always capped short so every report
usually is provided under 200 words ... keep everything as is current but triple the budget for
deep research."

Root cause — **the v54.9 detail pass was still too small a ceiling.** The deep-research engine
(`src/shared/webTools.js`, ONE implementation behind the chat/agent `perform-search-deep` IPC,
Agent Mode's `web_search`, and Code Mode's `web_search`) read each page at 18k chars and carried
only a 12-sentence findings paragraph (3600-char cap) + 10 facts (400-char cap) per page into the
report Smith answers FROM (~34k chars worst case), and the nudge only demanded "at least 500
words." In practice Smith kept compressing to ~200-word summaries.

What changed (`src/shared/webTools.js` constants + its [SYSTEM NUDGE] — tripled end to end):
- **Per-page read**: `RESEARCH_PAGE_CHARS` 18k → **54k** readable chars; per-page fetch bound
  25 s → **75 s**; total parallel-read wall-clock budget 90 s → **270 s**.
- **Per-page detail carried into the report**: findings paragraph 12 → **36** sentences, key
  facts 10 → **30**, report caps `RESEARCH_REPORT_SUMMARY_CAP` 3600 → **10800** and
  `RESEARCH_REPORT_FACT_CAP` 400 → **1200**. Worst case ≈ 6 × (~10.8k + 30×1.2k) ≈ **100k chars**
  of source-grounded material (was ~34k).
- **[SYSTEM NUDGE]** now demands "at least **1500 words**" (was 500), same coverage rules.
- Both report caps exported for tests; `tests/webResearch.test.js` asserts the v55 contract
  (54k page chars, 36/30 detail levels, 10800/1200 caps, ≥1500-word nudge).

What did NOT change: sources read (still ALL six top results), report format (SOURCE N / WHAT I
LEARNED / KEY FACTS / SNIPPET-ONLY contract the UI card parses), snippet-only fallbacks, quick/
deep:false legacy path, search backend, and every other tool. `tests/webResearch.test.js` green;
full suite judged against the known 5-failure seccomp baseline.


## [54.9.0] - 2026-09-14 — Deep Research detail pass (ALL sources read in full; longer answers)

User request: "increase the char budget for search tool deep research as the provided results
is too short and needs to be longer to reasonably be able to give a good natural response as
smith. All sources need to be read by smith and provide his results as he currently does but
make sure it's not short."

Root cause — **the report Smith answers FROM was capped below what a detailed answer needs.**
`src/shared/webTools.js` (shared by the chat/agent `perform-search-deep` IPC in `main.js`,
Agent Mode's `web_search` tool in `src/renderer/modes/agentTools.js`, and Code Mode's
`web_search` in `src/code/tools/executor.js`) read only 3 of the top 6 results, kept just
6000 readable chars per page, then squeezed each page down to 4 sentences + 5 facts with a
900-char "WHAT I LEARNED" cap. The report — the ONLY material Smith has for his answer —
landed at ~3-4k chars total, so even when he followed the nudge and wrote in his voice, the
answer came back brief: there simply wasn't enough substance to synthesize. (Note: a partial
detail pass — 5 pages × 18k chars — had been edited into the v54.8 folder AFTER its
AppImage/.deb were built at 09:52, so it never shipped; this release completes and ships it.)

What changed (`src/shared/webTools.js` only — one engine, all three tool paths):
- **ALL sources are read.** `RESEARCH_PAGE_COUNT` → `MAX_RESULTS` (6): every top result is
  fetched and read in full by default; a page that genuinely can't be read (paywall/timeout/
  empty body) still falls back to snippet-only, so one bad source never sinks the report.
- **Char budget per page**: 18k readable chars (`RESEARCH_PAGE_CHARS`) — a full article body —
  with the wall-clock budget for all parallel reads raised to 90 s (`RESEARCH_TOTAL_BUDGET_MS`)
  and the per-page fetch bound to 25 s, so six full pages actually fit.
- **Per-page detail carried into the report**: 12-sentence "WHAT I LEARNED" paragraph (3600-char
  cap) + up to 10 key facts (400-char cap each). Worst case ≈ 6 × ~7.6k ≈ 34k chars of real,
  source-grounded material — the report's size IS Smith's answer ceiling, and it is no longer
  the bottleneck.
- **SYSTEM NUDGE strengthened**: now tells Smith every listed source was read in full and his
  reply must be at least 500 words (was 300), cover EVERY source, and weave sources together
  where they agree/disagree — same voice, same format, just no longer allowed to compress.

Tests (`tests/webResearch.test.js`): the detail-levels test now pins `RESEARCH_PAGE_COUNT === 6`;
new behavioral tests with stubbed fetch prove (a) ALL six top sources are read in full and each
one's learned content reaches the report with zero snippet-only fallback, and (b) an explicit
`pageCount: 2` still bounds reads for fast lookups. Nudge test updated to the 500-word / EVERY-
source contract.

What did NOT change: the report format (SOURCE N / WHAT I LEARNED / KEY FACTS / SNIPPET-ONLY /
NUDGE — renderer sources card + silence-fallback parse it), `quick:true`/`deep:false` snippet-only
mode, `fetch_url`, mode routing, LM Studio plumbing, and every Code Mode guard.

## [54.8.0] - 2026-09-14 — Electron Depot (pre-provisioned Electron runtimes; no more pulling from GitHub)

User request: "include electron deps to be already provided in harness so if I ask agent
to package apps as an appimage it doesn't have to waste time pulling electron from github."

Root cause — **every packaging build re-downloads ~120 MB of Electron from GitHub.** When
Code Mode builds/packs an Electron app, two independent download paths fire:
(1) `npm install` in the target project runs `node_modules/electron/install.js`, which calls
`@electron/get.downloadArtifact()` and fetches `electron-vX.Y.Z-linux-x64.zip` (~120 MB) from
GitHub releases; (2) `electron-builder` (`npm run dist`) re-fetches that SAME zip plus its own
toolsets — appimage tools, fpm (for .deb), 7zip — via `app-builder-lib/out/util/electronGet.js`.
Both are cached under the user's XDG cache, but a FRESH project / clean machine has nothing there,
so each packaging task pays minutes of pure network time (and fails outright on slow/flaky links).

What changed:
- **NEW `src/main/services/electronDepot.js`** — the "Electron Depot". Ships the Electron runtime
  zips + electron-builder toolsets INSIDE the app and, on first use, seeds them into the exact cache
  layouts the two downloaders read (verified against the real code):
    - `vendor/electron/linux-x64/*.zip` → `<userData>/electron-cache/<sha256(url-dir)>/electron-vX.zip`
      (`@electron/get Cache.getCacheDirectory()` — dir = sha256 of URL with path truncated to dirname).
    - `vendor/electron-builder/<release>/<files>` → `<userData>/electron-builder/<release>/<file>`
      (builder archive-cache short-circuit, checked BEFORE any network) + pre-extracted dirs + `.state`
      files verbatim + the `downloads/<sha256(url)>/` fallback.
  Seeding is idempotent (size-checked copy-if-missing), non-blocking at startup, and degrades to old
  behavior if `vendor/` was stripped.
- **Pre-provisioned artifacts** — `vendor/electron/linux-x64/`: electron 31.7.7, 37.10.3, 42.5.0,
  42.9.3, 42.10.1 (covers the user's current test apps + this app's own runtime). `vendor/electron-builder/`:
  appimage-12.0.1, fpm@2.1.4 (.deb), 7zip@1.0.0 — archives + extracted dirs + `.state`.
- **`src/main/ipc/code.js`** — BOTH shell paths (foreground `runForegroundCommand` and background
  `spawnShell`) now spawn with the depot env: `electron_config_cache=<userData>/electron-cache`
  (points `electron/install.js` at the seeded cache; it validates against the LOCAL checksums.json
  bundled in the user's project → 100% offline) and, on Linux, `XDG_CACHE_HOME=<userData>` so
  `@electron/get` + `app-builder-lib` resolve their default caches INTO the depot. Foreground also
  awaits `ensureReady()` before spawning so a build never starts before its runtime is in place.
- **`main.js`** — creates the service (`safeInit('electronDepot', …)`), warms it on `whenReady`, and
  passes it through the IPC deps object.
- **`package.json`** — version → 54.8.0, description updated, `vendor/electron/**/*` +
  `vendor/electron-builder/**/*` added to electron-builder `files` so they ship in app.asar.
- **SYSTEM_PROMPT rule #16 (`src/code/loop/turnLoop.js`)** — extended: the agent is told Electron
  runtimes are PRE-PROVISIONED, its commands already carry depot env, and it must NOT set up mirrors /
  pre-download manually or treat "downloading electron" as failure.
- **NEW `tests/electronDepot.test.js`** (11 tests) — pure-helper layout assertions pinned to REAL
  on-disk cache dir names (42.5.0 → `59ea1574…`, etc.), a real-filesystem seeding test, and an
  integration test that loads the ACTUAL `@electron/get` ESM `Cache` class and asserts it reports a
  HIT for the seeded zip at the exact URL it would download.

What did NOT change: chat path, LM Studio plumbing, mode routing, every other Code Mode middleware /
guard, and the v54.5 long-build timeout policy (this is orthogonal — that fixed "builds get killed",
this fixes "builds wait on a 120 MB download"). The only remaining network touch is electron-builder's
~KB `SHASUMS256.txt` fetch (its `@electron/get` call uses Bypass cache mode by design) — negligible vs
a 120 MB zip, and absent entirely on the `npm install` path.

## [54.7.0] - 2026-09-13 — Code Mode circling fix (run_command on write-first turns + empty-reply recovery)

User report: "Code mode goes in circles with what it's doing and says it can't find
run_command." Reproduced live against LM Studio (qwen3.8-27b abliterated) with the exact
task class — "build a web based game of pacman and package it as an appimage" into an
EMPTY project folder. Two failed sessions (`~/.config/Agent Smith/code-sessions/`
code_1789304064851, code_1789235157) + their ghost traces show the full loop:

Root cause 1 — **run_command was not offered on write-first turns.** A greenfield build
starts in `implement` with `emptyWorkspace=true`, so `turnLoop.js` runs every turn until
the first file exists under `writeOnly=true`. The router (`src/code/tools/router.js`)
filters the implement set down to `WRITE_OR_HOST` (writes + host-control tools) — and
`run_command` is in NEITHER. So on exactly the turns where a "build X AND package it"
task needs shell (checking node/npm versions, architecture, existing artifacts), the tool
does not exist in the schema: the model can only explore with `list_host_directory` /
`review_actions` / `read_host_file`, or write a `run_code` program whose sub-call throws
"not offered by the phase router". v53.7 added run_command to implement, but this filter
silently nullified it on empty-workspace turns — the model then stalls, stops with an
empty reply, and gets generic "COMPLETION BLOCKED / WRITE REQUIRED" nudges: circling.

Root cause 2 — **clean-empty replies looped into the completion gate.** The 27B
abliterated Qwen spent ~40 minutes per turn on internal reasoning (ghost trace: single
`inference.generate` of 2,421,844 ms) and then emitted an EMPTY reply with
finish_reason `stop`. That classifies as "clean" in `streamSignals.classifyStreamEnd`, so
the v52.7 exhaustion recovery (which only catches finish_reason `length`) never fired —
the empty stop went straight to the completion gate, which pushed a generic nudge and let
the run loop on 40-minute dead turns until aborted.

What changed:
- `src/code/loop/phases.js` — `WRITE_OR_HOST` now includes `run_command`. The write-first
  turn's purpose is "stop exploring the empty folder, start producing" — shell is part of
  producing (env checks, scaffolding, and for build/package goals the packaging command
  itself). Read/search/preview tools stay withheld; only the one execution tool joins.
- `src/code/tools/runCode.js` — no change needed: its sub-tool surface mirrors the offered
  set, so run_code programs on write-first turns can now call `tools.run_command` too.
- `src/code/loop/turnLoop.js` — bounded empty-reply recovery: when a turn ends with NO
  content and NO tool calls (a clean stop that produced nothing), the harness pushes ONE
  targeted "ACT NOW" nudge per run (`session._emptyReplyNudges`, cap 2) telling the model
  to immediately emit its next tool call, then retries. This is distinct from the
  finish_reason=length exhaustion path and from the completion gate: an empty reply on a
  build task is never "done", so it must not be allowed to fall through to generic
  COMPLETION BLOCKED nudges that loop. After the cap, normal gate logic applies (a run
  that genuinely has nothing left to do still terminates).

What did NOT change: phase tables for non-write-only turns, explore/verify gating,
completion gate internals, v54.6 middlewares, chat path, packaging config. The write-first
filter's original purpose (no read/grep/list of an empty folder) is preserved — the test
suite asserts it.

Tests: `tests/writeFirstTools.test.js` updated (run_command offered on write-only turns;
read/search/preview still withheld), new cases in `tests/codeModeCircling.test.js` for the
empty-reply nudge cap and clean-empty vs length-exhausted classification.

## [54.6.0] - 2026-09-13 — Discipline-enforced coding (Hermes guide port)

User request: compare the Hermes development guide (`code.md`) against Code Mode and
port its coding-reliability discipline into v54.6. The guide's core insight: telling a
model "verify your premise / re-read before retrying" in prose is not enough — weak
local models ignore prose, so the harness must ENFORCE it. Three gaps found (the guide's
METHOD block was already ported as advice in v51.5; these were never enforced):

1. **Blind retries of failed edits.** When a `patch`/`write_file` failed (stale text,
   multiple matches), the model routinely re-sent near-identical content — burning turns
   and sometimes half-applying. The guide: "If an edit fails to apply, re-read the file
   for its current content instead of retrying the stale text."
2. **Done-claims with zero read-back.** A run could finish immediately after its last
   write without ever reading what it wrote — broken imports / mismatched ids only got
   caught if the completion gate happened to spot them. The guide: GATHER BEFORE CHANGING,
   VERIFY THE RESULT.
3. **"Done" while a background build still ran.** v54.5 taught the model to background
   long builds; nothing stopped it from declaring done before polling one to an exit code
   — a failed electron-builder left running at run-end read as success.

What changed:
- `src/code/loop/middleware.js` — three new hooks in `createDefaultMiddleware()`:
  - `stalePatchGuard`: afterTool records every FAILED write path; beforeTool vetoes any
    subsequent write to a stale path (`blockedReason: 'stale_write_retry'`) until a
    successful read_file of that same path clears it (a failed read proves nothing).
  - `gatherBeforeChange`: beforeDone vetoes ONCE when the run edited files but performed
    zero reads/greps/globs since its last edit — one forced read-back pass, never a
    deadlock.
  - `backgroundJobsSettled`: beforeDone refuses completion (once) while any background job
    THIS run started (`session._bgJobIds`, fed from `run_command is_background:true` job
    ids in both the tool path and run_code sub-calls) still reports `running` via
    `execDeps.jobApi.listJobs()`. An intentionally-persistent server passes on the second
    attempt.
- `src/code/loop/turnLoop.js` — bookkeeping beside the existing testRunsSinceEdit block:
  `_readsSinceLastEdit` counter (incremented by read_file/grep/glob, reset by writes) and
  the `_bgJobIds` ledger. SYSTEM_PROMPT gains rules 17 (NEVER RETRY A FAILED EDIT BLIND),
  18 (READ BACK BEFORE DONE), 19 (BACKGROUND JOBS MUST SETTLE).
- `src/code/tools/runCode.js` — sub-call bookkeeping now uses the SHARED
  `isVerificationCommand` policy from `src/shared/longBuildPolicy.js` instead of its own
  inline regex that had drifted (build/package commands counted as verification in the
  tool path but not inside run_code programs). Reads and background jobs from programs
  feed the same session counters.

What did NOT change: mode routing, phase tables, completion gate internals, long-build
timeouts/progress ledger (v54.5), chat path, packaging config. All new enforcement is
middleware-layer with one-shot escapes — no guard can loop a run forever.

Tests: `tests/reliabilityGuards.test.js` (10 cases: stale-path block/clear semantics incl.
failed reads, gather veto + one-shot + pass-through, job settle running/exited/foreign/
inert, full beforeDone chain integration).

## [54.5.0] - 2026-09-12 — Packaging-reliable coding + durable progress ledger

User report: "when I give it coding tasks that also require packaging the assets into
AppImages or .deb, the process fails. The agent needs to remember what it's done and
keep on a stable track of everything it's doing." Root causes (four independent killers
of exactly the packaging task class):

1. **Flat 5-minute command bounds.** `runToolPipeline` wrapped every exclusive tool call
   in a hard 300 s timeout (`src/code/tools/pipeline.js`) and the Code Mode shell runner
   SIGTERM'd foreground commands at 300 s (`src/main/ipc/code.js`). electron-builder /
   `npm run dist` legitimately take 10–60 min on a modest machine — they were killed
   mid-build every time, and the model read the timeout as "packaging failed".
2. **Watchdog aborted silent builders.** The run watchdog's inactivity guard only ticks
   on emitted run events; electron-builder is quiet between phases for minutes at a
   stretch → healthy builds were declared stalled.
3. **NO_PROGRESS killed packaging stretches.** `EarlyStopDetector.onProgress` resets only
   on file writes — packaging runs churn turns touching no project SOURCE files, so 12
   such turns ended the run with "No files written in 12 turns".
4. **TEST-BEFORE-DONE ignored builds.** The verification regex counted only test/lint
   commands; a passing `electron-builder` exit-0 was not verification, so completion kept
   getting vetoed into a verify phase that re-ran nothing useful.

What changed:
- NEW `src/shared/longBuildPolicy.js` — single source of truth: which commands are long
  builds (`isLongBuildCommand`), which count as verification (now including build/package
  runs), per-call timeout resolution (`exclusiveBoundFor` / `foregroundTimeoutFor`:
  explicit `timeout_ms` > recognized-build window (default 60 min, env
  XK_CODE_BUILD_TIMEOUT_MS) > 5-min default; hard ceiling XK_CODE_MAX_CMD_MS = 4 h), and
  recovery guidance for timed-out builds. Pipeline + shell runner now agree on the bound.
- `run_command` schema gains `timeout_ms`; description teaches background-and-poll as the
  preferred strategy for long builds (SYSTEM_PROMPT rule #16 codifies it: never treat a
  timeout as failure, check release/|dist/ before retrying, verify artifact size).
- Shell runner emits a 30 s heartbeat while ANY command runs → feeds the run watchdog and
  surfaces a `tool_heartbeat` event (renderer ignores unknown events — no UI change).
- NEW `src/code/context/progressLedger.js` — durable on-disk ledger under
  `.agentsmith/ledgers/<goalhash>.json`: every tool outcome (✓/✗, ref, retry-collapse)
  recorded as it happens. Injected into the plan anchor block EVERY turn (stable track),
  persisted in session state for resume, and loaded by goal-hash on a FRESH run of the
  same task — crash/re-request continuity: "do NOT redo steps already ✓".
- `EarlyStopDetector.onProgress` accepts `buildProgress`: a completed long build (pass OR
  fail) resets the no-write counter.
- Completion gate: `[PACKAGE]` check — when the goal names AppImage/.deb/installer/
  packaging, completion is blocked until a real artifact (>64 KB *.AppImage/*.deb under
  release|dist|build|out) exists. Kills "claimed it built, nothing on disk".
- What did NOT change: chat path, mode routing, THINK toggle, phase router tool sets,
  background-job registry, agent-mode's own 90 s shell (separate runner), watchdog
  semantics for genuinely silent runs.

Tests: `tests/longBuildPolicy.test.js`, `tests/progressLedger.test.js`,
`tests/packagingGate.test.js`.

## [54.4.0] - 2026-09-12 — 🧠 THINK toggle: force model reasoning off from inside the harness

User report: "when I disable thinking in LM Studio it doesn't seem to take effect
in this harness — we need it as a toggle." Root cause: LM Studio's Thinking/
Reasoning control is a per-model SETTING in its own UI; requests arriving over the
OpenAI-compatible API are not guaranteed to inherit it (older builds ignore it, and
thinking-by-default chat templates like Qwen3 think unless `chat_template_kwargs.
enable_thinking:false` says otherwise). The harness had that override hard-wired ON
for qwen-family only (v51.3) — there was no user-facing switch for anything else.

What changed:
- NEW `src/shared/thinkingToggle.js` (`window.XKThinkingToggle`) — one table-free
  place producing the wire fields: OFF → `{chat_template_kwargs:{enable_thinking:
  false}}`; strict mode additionally sends `reasoning_effort:'none'` (LM Studio's
  native request-level control; NOT sent by default because models without a
  reasoning control error on it). ON → `{}` — zero new bytes, pre-v54.4 behaviour.
- UI: 🧠 THINK chip in the quick-toggles row (drives hidden `#thinking-toggle`,
  mirrored by modeBar like MEM/IMG) + STRICT NO-THINK checkbox in Settings toggles.
  Both persist to localStorage (`agentsmith_thinking_enabled`,
  `agentsmith_strict_no_think`). Default: thinking ON.
- Chat path (`src/renderer/app.js`): toggle overrides merged into the request body
  AFTER the family harness overrides, so an explicit user OFF always wins.
- Code Mode: `thinkingEnabled`/`strictNoThink` threaded renderer → `code-run` /
  `code-resume` / `code-plan-approve` IPC → `runCodeTask` → planning phase + turn
  loop + milestone subagents → `streamCompletion`, which merges the same overrides.
  Resumed runs honour the CURRENT toggle state (sessions saved before this field
  resume with thinking ON).
- Tests: `tests/thinkingToggle.test.js` (ON sends nothing new; OFF forces
  enable_thinking:false; strict adds reasoning_effort:none; legacy undefined → ON).

What did NOT change: LM Studio's own setting still applies when THINK is ON; the
qwen-family auto-override stays; no changes to model harness routing, retries, or
the Ollama-native chat branch.

## [54.3.0] - 2026-09-02 — Generation timers hidden: no more glitchy in/out jumps on the live status lines

Release cut from v54.2 after user testing: "everything works but rendering looks
visually glitchy as there's multiple things rendering at once fighting for display —
for example the generation time renders on and off, so it looks like it jumps into
and out." Decision: hide the generation timer entirely; that removes every
contention source.

### Root cause
Two live status lines each had a per-second elapsed clock, and in both cases the
clock was one of several writers repainting the same DOM node at different cadences:

- **Chat mode** (`src/renderer/app.js`) — `botDiv.innerHTML` was rewritten by (a) a
  dedicated 1 s `genPaintTimer`, (b) the ~80 ms throttled stream renderer, and (c)
  warm-up paints. The badge text itself changed every second ("⚡ generating M:SS"),
  so the pulse line visibly jumped in and out as each writer overwrote the last.
- **Code Mode** (`src/renderer/ui/codeRunUI.js`) — the status bar showed TWO clocks
  (a "⚡ generating M:SS" segment plus total elapsed) that changed every face cycle
  (650 ms), while the gen-state segment itself toggled on/off with every `gen_state`
  flip (`waiting → generating → idle` per tool call). Two repaint sources, one line.

### What changed
- **`src/renderer/app.js`** — the chat pulse badge is now static: "⚡ generating" /
  "⏳ processing prompt…" with no clock; `genSince` and the 1 s `genPaintTimer` are
  gone (nothing left to tick). The stream renderer + warm-up paints remain the only
  writers of `botDiv.innerHTML`, so nothing repaints just for a clock.
- **`src/renderer/ui/codeRunUI.js`** — both clocks removed from the Code Mode status
  bar (`fmtElapsed`, `startedAt`, `genSince`). The line now shows face + verb + token
  count (+ Plan/Turn/tools/ctx), with the static gen-state segment; the 650 ms face
  cycle is the only repaint and its text no longer changes between cycles.

### What did NOT change
The "still generating" signal itself — users can still see at a glance whether tokens
are flowing or the prompt is being processed, in both chat and Code Mode. Only the
timers are hidden; all v52.7 cut-off-protection semantics (nothing may interrupt an
in-flight generation) are untouched.

## [54.2.0] - 2026-09-02 — Chat tool timeout raised from 120 s to 4 min: slow image renders no longer report a false timeout

Release cut from v54 after a live chat report: asked the agent to make an image,
the `generate_image` call hit the 120-second chat-tool timeout, but the render
kept going in the background and the image DID appear — while the model was told
"timed out". Not knowing it had rendered, the agent looped re-checking whether
the image existed.

### Root cause
Every chat/agent tool call runs under a finite deadline
(`src/shared/toolResults.js` → `withTimeout`, wired into
`chatLoop.executeAgentToolBatch`). The default was 120 s — fine for shell/file/web
tools, but `generate_image` legitimately takes longer: first use auto-downloads
the stable-diffusion.cpp engine plus the ~4 GB SDXL GGUF model, then samples on
GPU. When the wrapper fired at 120 s it resolved an honest "timed out" error even
though the underlying IPC call (`imagegen-generate`) was still running and would
have succeeded — so the model saw a failure over an image that actually rendered,
and the anti-loop guard then spun on repeated re-checks.

### What changed
- **`src/shared/toolResults.js`** — `DEFAULT_TOOL_TIMEOUT_MS` raised from 120000 to
  240000 (4 min). The timeout is NOT removed: a genuinely hung tool (dead fetch,
  stalled download) must still fail loudly instead of freezing the run forever.
  4 min outlasts the slowest legitimate chat tool — first-run image generation —
  while staying finite.
- **`tests/toolResults.test.js`** — regression tests: the default deadline is at
  least 240 s (so a slow render settles before the wrapper fires), and an explicit
  shorter deadline still wins over the default.

### What did NOT change
Code Mode's own 120 s bounds (`run_code`, plugin-tool invocation) are separate,
deliberate limits for that loop and were left alone — this fix is scoped to the
chat/agent tool path where image generation lives.

## [54.0.0] - 2026-09-02 — Deep web research: web_search returns a full report of everything it learned, not snippets

Release cut from v53.9 after user feedback: "web search shows me snippets of what
it finds when I want a detailed full report of everything it learned from its
searches, in natural language."

### What changed
`web_search` (both Code Mode and Agent Mode) no longer stops at DuckDuckGo
snippets. It now runs **deep research**: after the search, the top result pages
are fetched and read IN FULL (in parallel), and the tool returns a
**DEEP RESEARCH REPORT** — for every source: what was actually learned from that
page (a natural-language paragraph taken from the page itself) plus its key facts;
sources whose pages could not be read (paywall, timeout, empty body) are listed
honestly as snippet-only. The report ends with a nudge instructing the model to
answer the user with a detailed, complete natural-language report of everything it
contains — no bare snippet lists.

### How it works
- **`src/shared/webTools.js`** — new `researchWeb(query, opts)` engine:
  - `webSearch()` (unchanged DuckDuckGo HTML search) → top pages read in parallel
    via the existing SSRF-guarded fetch (`netGuard.validatePublicFetchTarget`);
  - per-page budget: 15 s timeout, 6 KB readable text; shared wall-clock budget of
    45 s across ALL page reads — one slow/dead page can never stall the search;
  - a page that fails or comes back thin (<80 chars) falls back to snippet-only —
    the report is always built, and it says so honestly;
  - fact extraction is pure + unit-tested: sentence splitting, query-term scoring
    (digits/currency/years are fact signals), boilerplate penalties (cookie/nav/
    legal noise), title-echo filtering (header repeats of the page title) and
    nav-menu-run detection ("Overview Platforms All Targets macOS Windows Linux");
  - `quick:true` / `deep:false` keeps the old snippet-only behavior for fast lookups.
- **Code Mode** (`src/code/tools/executor.js`) — `web_search` returns
  `{query, results, pagesRead, summary: <report>, nudge}`; the report is what enters
  model history (the pipeline's spill stage bounds it as with any large result).
- **Agent Mode** (`src/renderer/modes/agentTools.js`) — new `perform-search-deep` IPC
  (whitelisted in `ipcChannels.js`, handled in `main.js`) returns the same report;
  the tool description and WEB OUTPUT STYLE now demand a detailed full report.
- **UI** — the sources card (`displayWebSearchResults`) renders each read source with
  an expandable "📄 What I learned from this page" block (findings + key facts) and
  labels deep-research cards; the silence-fallback synthesizer
  (`webSearchFallback.js`) parses the new report format, so a model that goes silent
  after the search still gets a real answer compiled from what was actually read.

### Tests
- **New `tests/webResearch.test.js`** — 14 tests: report-format contract (SOURCE N /
  WHAT I LEARNED / KEY FACTS / SNIPPET-ONLY SOURCES / nudge), sentence/fact/summary
  extraction, nav-noise filtering, and the full `researchWeb()` path with fetch stubbed
  (parallel reads, per-page failure → snippet-only fallback, deep:false = no page
  reads, zero-hit search). No test touches the network.
- **Extended** `tests/webSearchDisplay.test.js`, `tests/webSearchFallback.test.js`,
  `tests/kimiWebSearch.test.js` for the v54 report contract (old snippet-cap tests
  replaced — that behavior is now opt-in via quick:true).
- Full suite: 948 tests, no new failures vs the known 5-failure container baseline.

## [53.9.0] - 2026-09-01 — Phone QR fix: wait for the Cloudflare tunnel URL instead of racing it

Release cut from v53.8 after a live report: sharing the "OPEN ON YOUR PHONE"
QR code only worked on localhost/LAN, never via the public link.

### Root cause (verified against the running app)
`cloudflared` needs several seconds after spawn to register its
trycloudflare.com hostname — it prints the URL in a box-drawn banner on
stderr (~3 s later, confirmed by capturing real output). The old `main.js`
read `remoteUrl` **synchronously** inside the `get-remote-qr` IPC handler:

    const best = remoteUrl || lanUrl;   // null during the registration window

So any user who opened the QR modal while the tunnel was still registering —
which is most of the first minutes after launch, and every time cloudflared
reconnects — got a QR encoding `http://<LAN-IP>:3000`. That address is
unreachable from a phone on another network (and reads as "localhost" to the
user), while the public link that *was* up never made it into the code.

### Fixed
- **New `src/main/services/cloudflareTunnel.js`** — tunnel logic extracted out
  of `main.js` (download, spawn, stderr URL detection, close/error handling)
  as an injectable service (`createCloudflareTunnel({ app })`) with:
  - explicit state machine (`idle → starting → running → dead`) so callers can
    tell "tunnel is coming" from "no tunnel possible";
  - `waitForRemoteUrl(timeoutMs)` — resolves with the public URL when it
    arrives, or `null` immediately when no tunnel was ever started / is
    disabled (`AGENT_SMITH_NO_TUNNEL=1`) / the process died (callers must not
    hang on those), or after the timeout while still coming up;
  - stdout **and** stderr watched for the URL (the real binary logs to stderr;
    watching both means a future log-level change can't silently break
    detection again);
  - idempotent `start()` and stale-process-safe exit handlers.
- **`main.js` `get-remote-qr`** — now awaits `waitForRemoteUrl(15000)` before
  falling back to the LAN URL: tunnel already up → instant; registering →
  waits (the modal shows "Preparing link…" meanwhile); genuinely unavailable →
  LAN fallback, same as before. `get-host-url` reads straight from the service.

### Tests
- **New `tests/cloudflareTunnel.test.js`** — 8 tests driving the service with
  fake cloudflared shell binaries (delayed stderr banner, immediate-death
  variant): the QR race itself (waiter arriving before the URL is printed gets
  the public URL), already-known instant resolve, no-hang on idle/disabled/
  dead states, stop() semantics, and the regex against the real banner line.

## [53.8.0] - 2026-09-01 — Code Mode "never completes" fix: verification-window CSP isolation + reasoning-model advisory

Release cut from v53.7 after live diagnosis of real failed runs (LM Studio,
qwen3.8-27b-obliterated / qwen3.8-27b-uncensored): 14/14 persisted Code Mode sessions ended
`incomplete` or `aborted`, and the worst case was a **fully built Pac-Man game — all 6 acceptance
checks passed, browser smoke test passed — reported INCOMPLETE** because of one `[RUNTIME]` error.

### Root cause (verified by live Electron A/B E2E)
The main window registers a strict Content-Security-Policy header injection on
`session.defaultSession` (`main.js`) to lock down the LLM/markdown renderer. Every hidden
BrowserWindow — runtime verification, browser verify, web capture — was created WITHOUT a partition,
so it inherited `defaultSession` and that CSP. When the harness loaded a user-built page that linked
an external stylesheet (Google Fonts in the real case), Chromium logged a level-3 console error:

    Loading the stylesheet 'https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap'
    violates the following Content Security Policy directive: "style-src 'self' 'unsafe-inline'"…

The completion gate fed that back as `[RUNTIME]`, blocked `done`, and the model churned on reads until
the no-write guard stopped the run. The E2E (real Electron, strict CSP mirrored from main.js) showed
the old config produced 2 phantom errors on a valid page — including `script-src 'self'` blocking
INLINE scripts, which also masked real JS errors behind CSP noise.

### Fixed
- **New `src/main/services/hiddenWindowSession.js`** — shared helper for hidden windows:
  - `hiddenWindowWebPreferences()` → dedicated in-memory partition (`xk-hidden-window`, no
    `persist:` prefix — never touches the user profile) + the existing sandboxed shape.
  - `stripCspOnSession(win)` → belt-and-suspenders removal of any Content-Security-Policy response
    header on that session (idempotent per session, fail-open).
- **`runtimeBrowserCheck.js`, `browserVerify.js`, `previewService.captureWebUrl()`** — all three
  hidden-window sites now use the helper (whole bug class fixed, not just the reported site).
  `electronBrowserCheck` and `createBrowserVerify` accept an injectable `BrowserWindow` for tests.
- **Behavior contract preserved:** real runtime errors are still caught — the E2E's broken page
  (`undefinedFunc()`) is reported by the new config exactly as before; only phantom CSP noise goes away.

### Added (reasoning-model speed advisory)
Live probing of qwen3.8-27b-obliterated showed ~14–16k reasoning tokens BEFORE the first tool call on
every turn (~20 min/turn at ~12 tok/s — "frozen" from the user's seat). LM Studio's per-model
Reasoning toggle (set to medium → falls back to "on") overrides `chat_template_kwargs`, so the app
cannot force thinking off. The one-time Code Mode advisory now names the actual lever: set the model's
**Reasoning toggle to Off in LM Studio**, or use a coder model.

### Tests
- `tests/hiddenWindowSession.test.js` (9 tests): partition shape, CSP-strip semantics (any case,
  no-header input, idempotency, broken-session fail-open) + wiring assertions that all three services
  build their windows with the isolated partition.
- Live Electron A/B E2E (`e2e_csp.js`, run against real Chromium): BUG REPRODUCED on old config,
  FIX WORKS (zero errors on valid app), REAL ERRORS STILL CAUGHT — all green.

## [53.7.0] - 2026-08-29 — Full tool-surface audit + coding-pipeline fix

Release cut from v53.6 after a full audit of the Code Mode / host-control tool surface and
the coding pipeline, driven by real LM Studio runs (qwen3.8-27b).

### Audited
- **Every one of the 26 tools verified through the REAL production executor** (`scripts/verify-tools.js`,
  same deps wiring as `main.js`): read_file, patch, write_file, append_file, grep, glob,
  run_command (fg/bg/failure), list_project, show_preview, browser_verify, query_run_trace,
  run_code (incl. the 120s timeout negative test), all 9 host-control tools, web_search +
  fetch_url (live LM Studio round-trip), review_actions, undo_action, save_user_fact,
  memory_search — **32/32 verified OK**, each bounded by a per-tool watchdog so a hung tool
  fails the harness instead of looping.
- Unit suite: 910 pass / 5 fail — the 5 are the known container seccomp baseline
  (planningPhase + pluginSandbox), unchanged from v53.6.

### Fixed (coding pipeline: "create X … then run it" tasks stalled)
Live E2E of `runCodeTask()` exposed a long-standing phase-router flaw: **`run_command` was not
offered in the implement phase** (`src/code/loop/phases.js`) — only in verify. Since all coding
happens in implement and the phase advances to verify only at turn ≥ 8 / milestones done, the
model could write files but never execute them; "create factorial.js … then run it to confirm"
runs stalled re-reading their own PLAN.md/IMPLEMENT.md artifacts instead of running the code.
`run_code`'s sub-tool surface mirrors the offered set, so programs hit
`tools.run_command is not a function` — cryptic and unrecoverable for small models.

- `phases.js`: **implement now offers `run_command`** (explore stays read-only; verify unchanged).
  The model can run what it just wrote in the same phase, and "TEST BEFORE DONE" evidence
  (`agentRanOkAfterEdit`, `testRunsSinceEdit`) is settable from implement.
- `tools/runCode.js`: a program calling a tool NOT offered this turn now gets an **actionable
  rejection** naming what IS available (dsh denial contract, try/catch-recoverable) instead of
  the cryptic TypeError.
- Regression tests: `tests/codePhases.test.js` (implement offers run_command; explore does not),
  `tests/runCode.test.js` (non-offered tool → actionable error + recovery; no recursion).

## [53.6.0] - 2026-08-29 — AGENT SMITH RELOADED: hermes-grade pipeline for chat & coding

The application is now **Agent Smith Reloaded** (display name across window title, wordmark,
login card, package metadata and the Linux launcher). The Agent Smith persona itself is
untouched. This release ports the reliability *pipeline* that makes Hermes sessions feel solid —
bounded retry, honest tool results, finite timeouts, actionable failures — into the chat/agent
path, keeping every existing Agent Smith tool.

### Added (chat-path transient-failure recovery — parity with Code Mode)
Code Mode already retried a stalled stream up to 8 times before giving up; the chat loop had **no
retry at all** — one "failed to fetch", one LM Studio engine SIGABRT right after headers, one
ECONNRESET or hosted-relay 429/5xx ended the whole run with an error wall. New shared policy
(`src/shared/retryPolicy.js`, `window.XKRetryPolicy`):
- **Transient vs permanent classification** (stall / timeout / failed-to-fetch / ECONNRESET /
  429 / 5xx / rate-limit = retry; context overflow, bad key, model-not-loaded, user abort = fail
  fast — retrying those only burns minutes).
- **Bounded exponential backoff** with jitter (1s→15s cap), Retry-After honored up to 30s.
- **Safety contract:** a replay happens ONLY before any content token reached the user — after
  tokens flow, re-issuing would double-render the reply, so every error there stays fatal. User
  Stop is never retried.
- Wired into `src/renderer/app.js` around the chat fetch: connection-level failures retry on a
  fresh request with a visible "Connection hiccup — retrying (n/3)" pulse; transient HTTP 429/5xx
  gets one fresh attempt too.

### Fixed (tool results were dishonestly reported as successes)
The chat batch executor judged success by `!startsWith('Error:')` alone and had **no timeout**.
Consequences: "web search failed…", "[BLOCKED] …" variants beyond the prefix, thrown non-Error
values, JSON bodies carrying `{error}` and empty output all reached the timeline (and the model)
as OK — small models then narrated confident success over a failed call. New shared module
(`src/shared/toolResults.js`, `window.XKToolResults`):
- **classifyToolResult()** — one honest ok/error signal for strings, Error instances, thrown
  values, JSON `{error}` bodies and empty output; consumed by `executeAgentToolBatch` so the
  timeline card AND the tool message back to the model agree with reality.
- **withTimeout()** — every chat/agent tool call now runs under a finite deadline (default 120s);
  a hung fetch/shell returns an honest timeout error instead of freezing the run forever.

### Added (consecutive-tool-failure guard — stop honestly, don't spin)
With honest classification in place, `app.js` counts batches where EVERY tool failed: after **3**
in a row the model gets one firm nudge to change approach or report plainly what failed; after
**5** the run ends with an honest note instead of burning the GPU on a broken tool chain until
the user hits Stop. One success anywhere resets the streak.

### Improved (actionable failure text in chat)
Non-retryable HTTP failures now route through the same `streamSignals.classifyHttpError` Code
Mode uses: a context overflow says "lower the Context Window slider and retry", a load failure
says "pick a model that fits VRAM" — never a raw engine dump.

### Tests
`tests/retryPolicy.test.js` (19), `tests/toolResults.test.js`, `tests/chatLoopBatch.test.js` new —
classification tables, backoff bounds, the contentSeen/abort safety rules, executor end-to-end
(timeout, thrown values, mixed-batch ok flags). Full suite: 886 tests, only the 5 pre-existing
container-seccomp baseline failures (planningPhase + pluginSandbox) remain — no new failures.

## [53.5.0] - 2026-08-29 — Mobile web UI: online search now renders the actual results, not just sources

### Fixed (mobile web UI: after an online search the chat only shows the sources card — no answer ever appears)
Reproduced live against LM Studio with `qwen3.8-27b-obliterated` (`scripts/_repro-turn2.js`). The
post-search turn returned **8,600+ chars of reasoning_content and NO usable content** — either an
empty stream or a forbidden `fetch_url` call emitted as XML text. Two compounding causes:

1. **Merged/"abliterated" Qwen builds ignore the thinking-off override.** The v51.3 fix sends
   `chat_template_kwargs {enable_thinking:false}` for qwen3+ ids, but this merged model still thinks
   by default and burns its whole reply on internal reasoning — so the "answer NOW from the snippets"
   nudge in the web_search result is never honored. (Verified: 6k–8k chars of reasoning even WITH the
   override; the old repro's turn-1 also answered in prose instead of calling the tool.)
2. **The silence recovery looped into an apology.** The v53 bounded-nudge path nudged up to 3 times,
   and a no-prose `fetch_url` chain (minutes per call on slow GPUs) kept resetting the counter — the
   run ended with "the model went quiet… try asking again" while the user had seen ONLY sources.

Fix (`src/renderer/modes/webSearchFallback.js`, new; wired in `src/renderer/app.js`): when a
SUCCESSFUL web_search happened earlier in the run, the actual snippets are real data already in hand —
- **Silent turn right after the search** → render an answer synthesized from the ACTUAL results
  (Smith's voice, linked sources) and end the run. No more nudge-into-the-void.
- **Turn that returns ONLY more web calls with NO prose** (the model ignoring "answer now") → skip
  execution (it would burn minutes and loop back to silence), render from the actual results, finish.
  A turn WITH prose is untouched — narrating before a legitimate follow-up read still works.

Model-agnostic by design: it does not fight the thinking knob (demonstrably ineffective on merged
builds); it guarantees the user gets findings from data we already have.

### Tests
`tests/webSearchFallback.test.js` new — parser (compact + legacy shapes, nudge stripping, failure /
zero-hit rejection), synthesizer (markdown shape, 6-entry cap, null on nothing real), web-only batch
detection; plus static wiring checks in `app.js` (fallback module bundled via entry.js, both
guard sites present and gated on a successful search).

## [53.4.0] - 2026-08-28 — Fresh-start focus: the agent no longer re-runs tasks from previous sessions

### Fixed (on a fresh launch, given a new task the model first "resumes" a task from the previous session)
Three compounding causes, all fixed:

1. **Restored history posed as live context.** Chat/Agent histories persist across launches;
   after a fresh start the pruner's recent-window was made entirely of OLD tasks kept
   verbatim, out-voicing the message just typed. Now every turn restored from disk is
   stamped `__priorSession` at load (`src/renderer/app.js` → `stampPriorSession`) and the
   pruner compacts stamped turns to one-line stubs regardless of position — old tasks are
   closed background, never a to-do list. Prior-session tool results always stub out.
2. **The `[CURRENT TOPIC]` tag sat on the OLDEST surviving user turn** — after a relaunch
   that's an old task from yesterday, so the prompt literally told the model to work on it.
   The tag now sits on the LATEST real (non-prior-session) user message; stale tags are
   stripped (`src/shared/contextPrune.js`).
3. **Code sessions left open by a dead process resurfaced as "Resume Code run?" forever.**
   `CodeSession.sweepStale()` runs at startup and closes any session still marked running
   from a previous app process (status → aborted, honest reason). Cross-restart plan review
   (`awaiting_approval`) is preserved — that's an intentional feature.

Prompt directives updated to match: `[User/Smith, earlier]` turns are CLOSED history; only
the `[CURRENT TOPIC]` message is the job (`smithPersona.js`, agent-mode appendix).

### Tests
`tests/contextPrune.test.js` +5 prior-session cases (compaction inside the recent window,
tag placement/stripping, idempotence); `tests/codeSessionSweep.test.js` new (sweep closes
stale runs, preserves awaiting_approval, corrupt-file safe). Full suite green except the
known 5-test container seccomp baseline.

## [53.1.0] - 2026-08-27 — Reliability: no more tasks that loop/repeat after completion; Code Mode tune-up

### Fixed (tasks get looped and repeated even after the task is done — seen from the mobile web UI)
Root cause was a **persist-after-notify race**, exposed by slow clients. The renderer's `done`
handler immediately queries `code-list-sessions` to decide whether to offer "Resume Code run?".
But `runCodeTask` saved the terminal status only AFTER emitting `done` (emit → memory LLM call →
trace export → save). A phone client whose SSE round-trip landed before that save still saw
`running`, got offered Resume, and tapping it re-ran the whole finished task. Not mobile-exclusive —
any slow/remote client could hit it — but phones over Wi-Fi are exactly where the window is widest.

- **Persist-before-notify.** `runCodeTask` now saves the terminal status to disk BEFORE emitting
  `done`/`error` on every exit path (normal completion, watchdog stall, abort, generic error,
  worktree-creation failure, final-gate done). On-disk state is the source of truth by the time any
  client can ask. (`tests/persistBeforeNotify.test.js`)
- **Resume is refused for finished sessions.** `code-resume` now rejects sessions whose persisted
  status is terminal (done/error/aborted) and filters out live in-memory runs — a stale "Resume"
  banner can no longer restart a completed task even if it somehow renders. (`tests/codeResumeGuard.test.js`)
- **Double-start race closed.** `code-run`, `code-resume` and `code-plan-approve` each checked
  `isRunBlocking()` and then AWAITED (session load / hooks / save) before starting — two invokes in
  that window (double-tap "Resume", or desktop + phone at once) both passed the guard and started TWO
  concurrent runs of the same task. `startCodeTask` now re-checks the guard synchronously, right
  before it sets `activeRun`, so a second caller always sees the first.
- **Resume banner only for genuinely unfinished sessions.** The renderer's banner check filters on
  persisted terminal status and is triggered from `done` AFTER setting its own guard flag — no
  self-triggering loop.

### Fixed (composer permanently locked after one failed send)
`sendMessage` claims a single in-flight send slot (`src/shared/sendSlot.js`, new) that also drives
the busy state, so double-send (button + Enter racing) is impossible by construction. The audit found
two unguarded `await`s on the claim→finally path: if either threw, the slot was never released and
the composer stayed locked to "wait for current run" until reload.

- **Slot-leak class fixed.** Both `flushPendingContextSync` awaits (pre-flight between claim and try;
  post-run inside finally) are now guarded — a throw can no longer leak the slot or skip restoring
  send/stop buttons. The Code Mode `flushContextSync` dep is fault-tolerant too: context sync is
  advisory, so it can no longer kill run boundaries (resume tap / plan approve / run start) mid-setup.
- **Double-send guard.** `sendSlot.claim()` is synchronous and covers both send vectors (button click
  and Enter key); every early-return path releases the slot. (`tests/doubleSendGuard.test.js`)

### Fixed (Code Mode tune-up)
- **Kimi K3 / Moonshot no longer 400s every Code Mode turn.** The code stream path sent
  `max_tokens: -1`, which hosted Kimi/Moonshot APIs reject with HTTP 400 — so configuring a hosted
  Kimi key made EVERY Code Mode turn fail. It now sends 8192 for Kimi K3 models (mirroring the chat
  path, which already did this); LM Studio keeps `-1` (unbounded). The truncation-recovery path in
  `turnLoop` handles any resulting `length` finishes.
- **Truncation-scaffold counter typo fixed.** `truncationScaffoldAttemps` →
  `truncationScaffoldAttempts`. The cap still worked, but the misspelled field meant anything reading
  the intended name saw `undefined`; old persisted sessions simply start fresh at 0.

### Verified
- Full suite: **860 tests — 855 pass, 5 fail = the known container seccomp baseline** (planningPhase +
  pluginSandbox), i.e. no new failures vs v53.
- New tests: `tests/codeResumeGuard.test.js` (terminal-status refusal, live-run filter, resume actually
  starts for unfinished sessions), `tests/persistBeforeNotify.test.js` (save-before-emit ordering on all
  exit paths), `tests/doubleSendGuard.test.js` (slot claim/release, double-send rejection).
- `tests/codeToolRegistry.test.js` updated: `run_code` is part of the pinned Code Mode tool set.

## [53.0.0] - 2026-08-24 — Web search: results actually display, no more endless "working…" after a search

### Fixed (web_search "fails to display results and takes a long time")
Reproduced live against LM Studio (qwen3-27b): the search itself worked (~1s), but what
happened AFTER it broke the experience. The model's next turn either chained into `fetch_url`
(~50s of prompt processing per hop) or returned an EMPTY stream — its whole reply spent on
internal reasoning. The app then nudged ("Please summarize…") and looped with no bound, while
the only thing painted was a "sources" card that listed TITLES ONLY. To the user: search ran,
nothing displayed, no summary ever.

- **Results now display as real content.** `displayWebSearchResults` renders each source with
  its LINKED title, URL and snippet (was: titles only). Parses both the new compact tool-result
  shape and the legacy "title (url): snippet" shape; HTML in titles/snippets is escaped.
- **The post-search silence loop is bounded.** A thinking-by-default model can return empty
  streams after a tool result (budget spent on reasoning). The chat loop now counts consecutive
  silent turns: 3 nudges max, then the run ends with an honest note ("model went quiet… try
  again or switch models") instead of spinning forever. Any streamed reply resets the counter.
- **Tool-result text is compact + directive.** `web_search` (chat path) now returns numbered
  entries with snippets capped at 200 chars and a nudge that tells the model to answer NOW from
  what it has — explicitly NOT chaining fetch_url. That was the "takes a long time" driver:
  ~50s of prompt processing per chained hop, for pages the snippets already covered.
- **Code Mode shows retrieved content too.** The activity timeline renders web_search results /
  fetch_url bodies (was: an opaque KV dump) and counts sources in the row summary ("3 sources
  retrieved").

### Verified
- New tests: `tests/webSearchDisplay.test.js` (compact result text + "answer now" nudge, linked
  titles/snippets rendering for both shapes, XSS escaping, no-render on zero hits, bounded
  silence loop, timeline content) — 10 new assertions; `kimiWebSearch.test.js` updated to the
  v53 compact shape.
- Live repro script (`scripts/_repro-multiturn.js`) captured the exact failure chain: turn 2 →
  fetch_url (49s), turn 3 → silent (914ch reasoning, 0 content) — the loop this release bounds.

## [52.9.0] - 2026-08-24 — Chat reply integrity: no more "cut off + Error: Assignment to constant variable"

### Fixed (every chat reply ended in `Error: Assignment to constant variable`)
- **Root cause was a one-word bug in the live-generation badge timer.** The v52.7 badge painted the streaming bubble once a second via `const genPaintTimer = setInterval(...)`, but the stream-end cleanup does `clearInterval(genPaintTimer); genPaintTimer = null;`. Assigning to a `const` throws `TypeError: Assignment to constant variable` on EVERY reply — at exactly the moment tokens have finished streaming. The outer catch then replaced the whole bubble with an error wall, wiping the answer that had just been painted. That is why replies looked cut off and every one ended in the same error message. Fix: declare it with `let`.
- **A fault mid-reply can no longer wipe what already streamed.** Even after the const fix, any runtime error AFTER tokens flowed (stream cleanup, persist, …) would still have replaced the partial answer with a bare error wall. The chat loop now tracks `lastStreamedContent` (declared outside the try so the catch can see it); on timeout or generic error the reply keeps everything already painted and appends the error as a red note below it. The partial reply is also recorded in history — but idempotently: if the final push already happened before the fault landed, it is not recorded twice. Abort is untouched: the user asked to discard, so nothing is kept.
- **The whole bug class is now guarded.** A static scan asserts that no `const` setInterval/setTimeout variable anywhere in app.js is ever reassigned — a const timer that gets nulled or reset is always this same error wall waiting to happen (scanned: the other seven const timers are only cleared, never reassigned).

### Verified
- New unit tests: `tests/chatReplyIntegrity.test.js` (7: let-declaration of genPaintTimer + its nulling cleanup, no-const-timer-reassignment class scan with shadow/arrow/comparison exclusions, lastStreamedContent declared outside the try, emitStream recording, partial-reply preservation in BOTH non-abort error branches, AbortError still discards).
- Proven against the bug: run against v52.8's app.js the suite fails 5/7 (the const declaration and all partial-preservation guards); on v52.9 it passes 7/7.

## [52.8.0] - 2026-08-24 — Conversation-first chat: no forced tool calls, no stale-task fixation

### Fixed (normal conversation triggers constant tool calls)
- **Chat/Agent mode is now CONVERSATION-FIRST.** The v52.7 system prompt told the model to "use tools immediately, do not hesitate" and to run a Plan-Execute-Verify loop on every request — so on small local models EVERY message (greetings, vague remarks, plain questions) produced tool calls. `smithPersona.buildChatSystemPrompt` now leads with explicit conversation rules: most messages are answered in prose with NO tool call; tools fire only when the CURRENT message asks for an action or needs live data; "when in doubt between acting and answering — ANSWER". The forced plan-execute-verify block and every "do not hesitate" pressure line are gone (full AND compact/Gemma variants).
- **The Agent Mode appendix no longer pushes conversation into tool calls.** `AGENT_MODE_SYSTEM_APPENDIX` gained a CONVERSATION FIRST section, the anti-refusal directive is now scoped to *requested* actions ("never a reason to act unprompted"), and "make progress every turn with a tool call" was removed.
- **Tool schemas stop advertising themselves as mandatory.** `task_begin`/`task_complete` are marked Optional (multi-step work only, never conversation) and `run_shell_command` says "use ONLY when the user asks to run something".

### Fixed ("ignores what I just said and keeps working an old build")
- **RECENCY is now a first-class prompt rule.** Both chat prompts state that the user's MOST RECENT message defines the current job: history is background, not a to-do list — older builds/plans/requests are never resumed unless the latest message explicitly refers back to them. A new topic means a fresh start.
- **Stale conversation is compacted out of context.** `contextPrune.pruneChatHistory` now collapses conversation turns older than 8 user turns into one-line stubs (old assistant turns become bare markers), while the last 8 turns stay verbatim — so after a relaunch, a wall of old build tasks can no longer dominate what the model sees. The first surviving user turn is tagged `[CURRENT TOPIC]` (exactly one message ever carries it; the tag migrates as history grows). Harness control messages (`[CONTINUE]`, `[GUARD RAIL]`) are never compacted, and compaction is idempotent — safe to run every turn.
- **Tool-result pruning from v52.7 is preserved** (recent 4 kept size-capped, older stubbed) alongside the new conversation compaction.

### Verified
- New unit tests: `tests/contextPrune.test.js` (+8: window compaction, single CURRENT TOPIC tag, stale-assistant markers, control-message exemption, idempotency, tag migration on growth, opt-out, short-history no-op), `tests/smithPersona.test.js` (+3: conversation-first contract, recency rule in full+compact, exported rule blocks), `tests/agentTools.test.js` (+2: appendix contract, optional task_* schemas).
- Full per-file suite vs v52.7 baseline: 819→830 tests, no new failures (the same known container-sandbox failures remain — seccomp restrictions, not regressions).

## [52.7.0] - 2026-08-23 — Live generation indicators, no cut-offs while busy, all-model support, infinite turns

### Fixed (the "Gemma4 doesn't work" symptom — root cause was model-agnostic)
- **Thinking-by-default models of ANY family no longer die on empty turns.** Reproduced live: with the old explicit output budget (4096–8192 tokens), a model that thinks by default (gemma4, qwen3, …) spends its entire reply budget on internal reasoning and returns `finish_reason:"length"` with ZERO content — no file written, run dead. The fix is at the wire level, not per-family: `streamCompletion.js` now sends `max_tokens:-1`, which LM Studio honors as unbounded (verified live: 4k-token prompt + Gemma4 → `finish_reason:"stop"`, never `"length"`). A reply can only end when the model stops, the user hits Stop, or the engine dies — all explicit, none silent.
- **Exhaustion recovery is now persistent and model-agnostic.** New shared module `src/shared/streamSignals.js` classifies every stream by what the server actually reported: `clean` (normal stop), `budget_exhausted` (`finish_reason:"length"` + no content + no tool call — with or without a visible thinking channel), `truncated`. Code Mode's old "give up after 2 retries" path is replaced: while the exhaustion signature keeps appearing, the harness nudges ("stop reasoning, emit the tool call now") and retries until the model emits something; the existing no-write/error guards still bound it. The same classifier drives chat mode (below). No model names anywhere in the detection — Qwen3, Gemma4, or any future thinking family are handled identically.
- **Context overflow gets an actionable message.** LM Studio's `exceed_context_size_error` (prompt bigger than the loaded window) is classified by `streamSignals.classifyHttpError` and surfaced as "prompt exceeds the model's loaded context — lower the ctx slider or reload with a larger window" instead of raw engine text.

### Added (live indications of token generation from LM Studio)
- **Code Mode status bar now shows exactly what the in-flight request is doing.** `streamCompletion.js` reports its live state on wire events only: `waiting` when the request is sent (prompt processing / first-token window) and `generating` on the FIRST SSE delta of any kind — content, reasoning or tool_call. The status bar renders it explicitly: `(⊙_⊙) writing code… · ⚡ generating 0:42 ↓ 12.3k t · 1:57`, or `· ⏳ processing prompt…` while no token has landed yet. Because the state comes from what arrives on the wire, it is identical for every model family LM Studio can serve — this IS the "is the model still busy" signal.
- **Chat mode gets the same live badge** on the streaming bubble: a generation indicator that flips to "generating" on first token and shows elapsed time while tokens flow, so a slow thinker never looks frozen or dead.

### Fixed (nothing gets cut off while the model is generating)
- **The absolute request timer no longer applies once data flows.** The old 30-minute hard cap could kill an actively generating reply; now the first received byte disarms it and only the between-token idle window guards a truly dead stream (which still triggers the existing bounded stall-retry path). A 40-minute single reply that keeps emitting tokens can never be timer-killed, for any model.
- **Chat mode's first-byte timeout is adaptive.** The old fixed 5-minute "no response" abort fired while slow models were still processing large prompts; it now scales with prompt size and only trips when the server is genuinely silent.
- **Run watchdog wall-clock cap removed by default** (`XK_CODE_MAX_RUNTIME_MS=0` = unlimited). Turns are infinite, so an ACTIVE build must not be killed after N hours of elapsed time — the 20-minute inactivity guard remains as the real "is it stuck" detector (deltas touch it on every token).
- **Model swaps picked mid-run flush at run end.** On top of v52.5's swap queueing, `sendMessage`'s finally-block now calls `flushPendingModelSwap()` after the run ends — a pick made while the model was generating can never unload it mid-stream; it applies at the first safe boundary (before the next message).

### Changed (no more turn capping)
- **The "Thinking Steps" slider is gone** (`index.html`, `runtimeProfileUI.js`). Turns are infinite in every mode: `getMaxTurns()` returns -1, `EarlyStopDetector.normalizeMaxTurns` maps 0/-1/null/undefined → Infinity (explicit positive caps still honored by tests/advanced callers), and the IPC/resume/approve paths pass the value through with no `|| 40` default. A run ends only when the model stops calling tools, the user hits Stop, or a stuck-guard fires (consecutive errors / duplicate calls / no-file-progress).
- **Auto-tune now adjusts temperature + context only** — there is no steps value left to tune.

### Verified
- Live LM Studio probes: `max_tokens:-1` unbounded on chat path (`finish_reason:"stop"` with 4k-token prompt); context-overflow error shape captured and classified; Gemma4 (thinking-by-default) + Qwen3 both respond correctly through the OpenAI-compatible endpoint.
- New unit tests for `streamSignals.classifyStreamEnd` / `classifyHttpError` (exhaustion vs clean vs truncated, with/without visible reasoning, tool-call presence flips exhaustion→truncated; context-overflow classification).
- Full per-file suite comparison vs v52.6 baseline: no new failures (known container-sandbox failures in planningPhase/pluginSandbox remain on both — seccomp restrictions, not code regressions).

## [52.5.0] - 2026-08-22 — Instant model swap + embedding model on every startup

### Added (the "picking a new model should immediately unload the current one and load the new" request)
- **Picking a model from the dropdown is now an IMMEDIATE SWAP, not just a preference.** Before this version a pick only changed which id chat sent to LM Studio: every other loaded model stayed resident (VRAM leak), and the newly picked one JIT-loaded on the first message — often OOMing because there was no room. Now `lmstudio-swap-model` (`src/main/services/lmStudioManager.js`) runs ONE serialized main-process operation: it reads the live management list, frees every other loaded LLM instance via `POST /api/v1/models/unload`, then loads the selection at its context (estimate → load, same safe-args contract as `ensureModel`). The dropdown always matches what's actually in VRAM.
- **Embedding models are protected from swaps.** Memory recall is infrastructure, not a chat model: swap skips every instance whose type is `embedding` or whose name matches the embed heuristic (`embed|minilm|bge|nomic|gte|e5|sentence`, kept in sync with `memory.js`). They run CPU-only anyway, so keeping them resident costs zero VRAM.
- **A failed swap never leaves you with nothing.** If the new model fails to load AFTER the old ones were freed (e.g. not enough VRAM), the previously loaded models are restored best-effort in reverse order and the error says so — same rollback contract `ensureModel` already had for context changes.
- **Safe mid-run: swaps queue, they don't interrupt.** While a chat or Code run is active, a pick queues (`pendingModelSwap`, last pick wins) and flushes at the next safe boundary — before the next message sends, and at every Code-run start/resume/plan-approve/stop/end via the existing `flushContextSync` dep. An in-flight inference can never lose its model mid-run.
- **No double-load after a swap.** The runtime-profile UI's own post-change context sync would otherwise reload a multi-GB model seconds after the swap just loaded it. `markSwapHandled()` (`src/renderer/ui/runtimeProfileUI.js`) suppresses exactly that one redundant sync (single-use, 60s expiry), and `flushPendingContextSync` now DROPS a queued sync whose model no longer matches the selection instead of loading the old model back after a swap.
- **Honest receipts in chat.** Success: `🔁 Switched to <model> — unloaded <others> · VRAM freed · ctx N.` Remote/unmanaged backends and failures each get their own message explaining what will happen (JIT-load on next message) instead of failing silently. The LOADED badge refreshes immediately after every swap.

### Added (the "embed model should load on every startup" request)
- **The embedding model is now guaranteed at boot.** `main.js` calls `lmStudioManager.ensureEmbeddingModel()` ~1.5s after startup: if no embedding instance is resident, it loads the best available one — `XK_EMBED_MODEL` override first (the same env var `memory.js` already honors), otherwise the SMALLEST embedding model on disk (fastest to start) — with `--gpu off`, so embeddings cost zero VRAM from session one. It then pins that id into `memoryManager.setEmbeddingModel()` so `/v1/embeddings` requests never have to guess. Runs in the background: it never blocks window creation, and a failure only degrades memory recall exactly as before (with a console warning) — the next startup retries.
- **New IPC channels** `lmstudio-swap-model` + `lmstudio-ensure-embedding` (`src/shared/ipcChannels.js`, handlers in `src/main/ipc/lmStudio.js`). Both work from desktop AND mobile web through the existing `/api/invoke` proxy — all management-API traffic stays in main (LM Studio sends no CORS headers for cross-origin POSTs).

### Verified
- New regression tests: `tests/lmStudioManager.test.js` (+10): swap unloads every other LLM but protects the embedding instance; already-resident selection is not reloaded; failed load restores freed models in reverse order; remote endpoints refused without a network call; unreachable management API degrades to a warning; embed no-op when resident; smallest-embed selection with `--gpu off`; `XK_EMBED_MODEL` override wins; `no_embedding_model` report; lms failure surfaced; swap + ensure-embedding serialize on the shared operation queue (strict enter/exit interleaving check). `tests/lmStudioIpc.test.js` (+2): both channels whitelisted, forward only supported fields, shaped errors. `tests/runtimeProfileUI.test.js` (+3): markSwapHandled suppresses the redundant post-swap sync; flag is single-use and model-specific; stale queued context syncs are dropped after the selection moves.
- Full unit suite + ship-check run before packaging (see release notes in this folder).

## [52.4.0] - 2026-08-21 — Code Mode multi-file builds + live status indicator

### Fixed (the "build plan loops on step 3" symptom)
- **Plan auto-advance no longer hard-loops when the model picks a different file layout.** The step-satisfaction heuristics in `src/code/plan/planStepAutoAdvance.js` only recognized canonical root-level filenames (`script.js` / `app.js` / `main.js`, `style.css`). A run that wrote its JS inline in index.html — or used other names/subfolders (which the prompts explicitly allowed: "choose whatever structure fits") — could NEVER satisfy a JS step, so the plan stalled on step 3 forever while the stale-step nudge kept firing. The completion gate is ref-based and passed such builds, which is why the run looked stuck mid-plan even though the app itself was fine.
- **`readScript()` now reads ALL project JavaScript**: canonical root scripts + every local `.js` the deliverable index.html references (any depth) + inline `<script>` bodies in the HTML. DOM-contract validation and the JS-feature heuristics (localStorage, filters, forms, CRUD…) all run against that combined source, so multi-file builds with non-canonical names (`css/main.css`, `js/app.js`, `app/index.html`) are detected correctly too.
- **CSS/JS steps accept inline equivalents**: a substantive inline `<style>` satisfies styling steps; a linked local `.js` or substantive inline `<script>` satisfies JS steps and the verify step. Trivial snippets (≤40 chars, e.g. `console.log(1)`) do NOT count — no false "done" on an empty shell.
- **The harness now steers toward separate files instead of tolerating one giant HTML.** System prompt rule 4 + the `[NEW DELIVERABLE]` bootstrap block say it explicitly: build with SEPARATE FILES (index.html + style.css + script.js), don't cram everything into one file. When a model writes an index.html that inlines both substantive CSS and JS, a ONE-SHOT `[HARNESS — MULTI-FILE BUILD]` nudge (`buildMultiFileNudge`, `src/code/context/artifactHints.js`) tells it to split the files (all three write_file calls allowed in one turn). It never blocks: if the model keeps inlining, auto-advance accepts it anyway — steering without a new loop.

### Added (the "live status indicator like Hermes' spinner" request)
- **The Code Mode status bar is now a live activity indicator** while a run is active: an animated kawaii face that cycles every 650ms + the current activity verb + cumulative tokens + elapsed time, e.g. `(⊙_⊙) writing code… ↓ 12.3k t · 0:42 · Plan 2/4 · Turn 7`. Faces: `(⊙_⊙) (•_•) (¬‿¬) (◕‿◕) (°▽°)`.
- **The verb follows what the agent is actually doing**: planning → "brainstorming", `write_file` → "writing code", `patch` → "editing code", `read_file` → "reading files", `run_command` → "running command", `browser_verify` → "verifying in browser", gate-blocked → "fixing issues", etc. (`TOOL_VERBS` map, `src/renderer/modes/code.js`).
- **Real token counts from the server.** `streamCompletion.js` now captures OpenAI-compatible `usage` (prompt/completion/total) from SSE chunks — LM Studio sends it in the final chunk — and turnLoop accumulates it per run (`session.tokenUsage`) and emits a compact `run_status` event after every inference. The renderer renders tokens compactly (1234 → 1.2k, 1500000 → 1.5M) and ticks the elapsed clock locally.
- **When the run ends** (`done`/`error`) the face stops cycling and the line settles into the plain summary parts (Plan x/y · Turn n · tools · ctx %), so it never looks "alive" after completion.

### Verified
- New regression tests in `tests/multiFileBuild.test.js`: inline single-file build satisfies JS+CSS steps and auto-advances past step 3 (the exact loop scenario); multi-file with non-canonical names (`css/main.css`, `js/app.js`) satisfies steps; subdir deliverable (`app/index.html` + linked refs) works; trivial inline snippets don't count as a build; CDN-only scripts don't count as local JS; the multi-file nudge text. All 6 pass, plus all 16 pre-existing planStepAutoAdvance tests unchanged.
- Full per-file suite comparison vs v52.3: no new failures (the known container-sandbox failures in planningPhase/pluginSandbox remain on both).

## [52.3.0] - 2026-08-20 — UNLOAD ALL: one click frees every model loaded in LM Studio

### Added (the "I want a button that unloads all models from LM Studio" request)
- **New ⏏ UNLOAD ALL MODELS row under the active-model picker in the sidebar cockpit** (`index.html`, styles in `src/renderer/styles/base.css`). It sits inside the same `.ctx-card` as the model dropdown, is quiet until hovered (danger-tinted on hover — it frees VRAM), and shows an "UNLOADING…" state while the request is in flight.
- **The button unloads EVERY loaded instance, not just the selected one.** `lmStudioManager.unloadAll()` (`src/main/services/lmStudioManager.js`) reads LM Studio's live management list (`GET /api/v1/models`, loopback only — remote backends don't expose it) and POSTs one `POST /api/v1/models/unload { instance_id }` per loaded instance. Unloads run sequentially in the main process; a single failed unload never aborts the rest, and "not loaded" races (the model went away between list read and unload) count as success.
- **New `lmstudio-unload-all` IPC channel** (`src/shared/ipcChannels.js`, handler in `src/main/ipc/lmStudio.js`). The renderer passes only the backend URL — all management-API traffic happens in main, which is why it works from BOTH desktop and mobile web: LM Studio sends no CORS headers for cross-origin POSTs, so a direct renderer fetch would be blocked (the existing v52.2 loaded-model detection worked around this with a same-origin GET; unload needs the main-process route).
- **The chat gets an honest receipt.** On success: `⏏ Unloaded N model(s): <names> — VRAM freed.` Partial failures list exactly which models failed and why; "nothing loaded" says so instead of pretending. Afterward the app re-runs `fetchModels()` so the dropdown's LOADED badge and selection track the new state immediately (the v52.2 follow-loaded logic then sees an empty load set, as it should).
- **No change to chat behavior.** Unloading models does not touch Agent Smith's session, history, or settings — the next message simply makes LM Studio JIT-load whatever model is selected again, exactly like a fresh start.

### Verified
- New regression tests in `tests/lmStudioManager.test.js`: unloadAll unloads every loaded instance across multiple models (one POST per instance id, correct endpoint + body); nothing-loaded returns success with an empty list; remote endpoints are refused without any network call; an unreachable management API degrades to a warning instead of throwing; one failing unload still unloads the rest and reports the failure. Extended `tests/lmStudioIpc.test.js`: the new channel is whitelisted and forwards only `apiBaseUrl`.
- Endpoint verified against a live LM Studio 0.4.x server: `POST /api/v1/models/unload` with `{"instance_id": ...}` returns `model_not_found` for unknown ids (2xx/4xx contract confirmed) — the same endpoint LM Studio's own UI uses.
- Full unit suite run before packaging: no new failures vs the v52.2 baseline (the 5 pre-existing container-sandbox failures in `planningPhase` / `pluginSandbox` remain, unrelated).

## [52.2.0] - 2026-08-20 — Model dropdown polish: readable model list + auto-select the model LM Studio already has loaded

### Fixed (the "model names in the sidebar dropdown are hard to read / all run together" symptom)
- **The themed model picker rows were cramped.** `.mp-item` used `font-size: 0.72rem`, `padding: 0.45rem 0.55rem`, a 2px row gap and no line-height — long LM Studio ids (`mistral-small-24b-instruct-v0.2-q5_K_M`) rendered as a wall of small, tightly packed text that was hard to scan.
- **Rows now breathe** (`src/renderer/styles/base.css`): font `0.72rem → 0.8rem`, line-height `1.45`, padding `0.6rem 0.7rem`, row gap `2px → 4px`, menu padding `4px → 6px`, and the open list grows from a 220px to a 300px max so more models are visible before scrolling.
- **Long ids ellipsize cleanly instead of crowding.** Each row is now a flex layout: the model name lives in its own `.mp-item-name` span that owns `text-overflow: ellipsis`, and any badge stays pinned to the right edge — an id can never swallow or push out the marker.

### Added (the "make LM Studio's currently-loaded model the default" request)
- **The app now detects which model is actually loaded in LM Studio and selects it by default.** `fetchModels()` additionally queries LM Studio's management API (`GET /api/v1/models`, loopback endpoints only — remote backends don't expose it, 4s timeout, never throws). The first entry with a non-empty `loaded_instances` wins; its instance id is what the OpenAI-compatible `/v1/models` list uses, so it maps straight onto an existing dropdown option.
- **The loaded model gets a "LOADED" badge in the dropdown** (`src/renderer/ui/modelPicker.js`) — one glance shows which entry is live in LM Studio without opening it. The marker rides on `select.dataset.loadedModelId`; the picker's MutationObserver re-renders an open menu when it changes, so the badge tracks LM Studio across refreshes while the list is open.
- **Your explicit choice still wins.** Until you pick a model from the dropdown yourself, every model-list refresh follows whatever LM Studio has loaded (so loading a different model in LM Studio's UI just works). The moment you make an explicit selection it sticks for the session — no more of the app "snatching" your pick back on the next poll. Changing the backend URL resets to follow-loaded mode again, and the existing `agentsmith_last_model` remember/restore path is preserved as the fallback when nothing is loaded or the endpoint is remote/unreachable (JIT behavior unchanged).

### Verified
- New regression tests in `tests/modelPicker.test.js` (jsdom): one row per option with a name span; exactly one LOADED badge and it lands on the right model; changing `data-loaded-model-id` while the menu is open moves the marker (the live-update contract); picking a row still writes `select.value`, fires `change` (app.js's localStorage remember) and closes the menu. All 4 pass.
- Full unit suite run before packaging: no new failures vs the v52 baseline (the 5 pre-existing container-sandbox failures in `planningPhase` / `pluginSandbox` remain, unrelated).

## [52.1.0] - 2026-08-20 — Mobile web UI fixes: image-gen "unauthorized" + chat cut off at the bottom on phones

### Fixed (the "image gen toggle says unauthorized when enabled on mobile" symptom)
- **Phone sessions died every time the desktop app restarted, and the phone never knew.** `AuthManager` kept its login tokens in an in-memory `Map` (`src/main/services/auth.js`). The token a phone saved to `localStorage` at login was valid only for the life of that one process — so after any update/crash/restart (exactly what happens when you install v52.1 over v52), every `/api/invoke` from the phone 401'd, including `imagegen-set-enabled`, which is precisely the call the 🎨 IMG toggle makes on enable. The panel then rendered "Image gen unavailable: Unauthorized" and looked like image generation itself was broken.
- **Sessions now persist to `<userData>/sessions.json`** (token → `{ username, expires }`). A phone that logged in once keeps working across app restarts — no re-login after every update. `verifyToken()` refreshes the expiry on every use (sliding 30-day window), so an actively used session never lapses mid-conversation while an abandoned one does; dead entries are pruned on load and logout removes its token immediately.
- **Writes are coalesced, not per-request.** `verifyToken` runs on EVERY web request, so expiry refreshes mark the file dirty and a single debounced write (250 ms quiet) flushes it — plus a hard `flushSessions()` on Electron's `will-quit` (`main.js`) so nothing is lost between the last use and process death. Persistence failures are logged, never thrown: a non-writable dir degrades to v52 behavior instead of breaking login.
- **No security regression:** tokens remain 256-bit random hex; the file holds no passwords (users stay in `users_v32.json`); the existing permission gates (`canUseApp` / `canUseTools`) are untouched — a persisted session is only as privileged as the account it belongs to.

### Fixed (the "page runs down too low on phones — bottom ~3 lines of chat cut off" symptom)
- **The page was sized to the LARGE viewport, not the visible one.** Mobile browsers report `100vh` as the height *behind* the URL bar / home indicator, so a body pinned to it rendered its last few lines of chat under the browser chrome — unreachable by scrolling because `#messages` is the scroll container and its box ended exactly where the screen's visible area began.
- **`body { height: 100dvh }`** (`src/renderer/styles/base.css`) with the old `100vh` kept as a fallback line for engines without dynamic viewport units. `100dvh` tracks the actually-visible height and reflows when the browser chrome shows/hides, so the chat column now ends at the real bottom of the screen on every phone — desktop (Electron) is unaffected: its window has no browser chrome, where `100dvh === 100vh`.
- **Extra bottom breathing room in the transcript** (`#messages` mobile padding `0.6rem → 0.6rem 0.6rem 1rem`) so even subpixel rounding at the viewport edge can't clip the last line.

### Verified
- New regression tests in `tests/auth.test.js`: a logged-in token survives an AuthManager restart (the exact v52 failure — new instance, same userData dir, old token still verifies); expired sessions are rejected and pruned; logout removes the persisted token immediately; dead entries for deleted users are dropped on load. All pass.
- Full unit suite run before packaging: no new failures vs the v52 baseline (the 5 pre-existing container-sandbox failures in `planningPhase` / `pluginSandbox` remain, unrelated).

## [52.0.0] - 2026-08-20 — Mobile web UI fix: floating composer can now be closed (✕)

### Fixed (the "composer covers the chat and there's no way to close it" symptom)
- **The v51.9 floating composer could open but never close.** The 💬 FAB was the only toggle, yet opening the bar hid the FAB itself (`#mobile-composer.open .mc-fab { opacity: 0; pointer-events: none }`) — so once expanded there was no control left to dismiss it. The sheet stayed pinned over the chat at `z-index: 1500`, and any agent reply that arrived while it was open could never be scrolled back into view.
- **New ✕ close button in the expanded bar** (`#mc-close` / `.mc-close`, markup in `index.html`, styles in `base.css`). It is always visible whenever the bar is open (the bar only renders when `.open`), so the sheet can always be dismissed and the chat re-tracked. Closing also blurs `#user-input` so the mobile keyboard goes away with the sheet.
- **Open/close state centralized in one `setOpen()`** (`src/renderer/ui/mobileComposer.js`). Both the FAB and the ✕ button drive it, so they can never disagree; rapid interleaved toggling stays consistent (covered by a new regression test). The v51.9 "second tap on the FAB closes" behavior is preserved — the FAB still flips its glyph/aria-label as before.
- **No change to desktop or to the relocation contract.** The module still relocates the REAL `#user-input` / `#send-btn` / `#stop-btn` nodes into the bar (app.js wiring follows them unchanged), and a wide viewport restores everything exactly as in v51.9.

### Verified
- Extended `tests/mobileComposer.test.js` with 4 new jsdom regression tests: ✕ dismisses an open composer (the exact v51.9 trap); ✕ works when the FAB is unreachable; closing blurs the input; FAB + ✕ stay in sync through rapid interleaved toggling. All 9 tests in the file pass (5 original + 4 new).
- Full unit suite: 710/715 pass — the 5 failures (`planningPhase`, `pluginSandbox`) are pre-existing on pristine v51.9 in this container (sandbox/seccomp restrictions) and unrelated to this change; zero new failures introduced.

## [51.9.0] - 2026-08-19 — Mobile web UI fix: floating chat composer (💬 FAB)

### Fixed (the "no chat input field on the mobile web UI" symptom)
- **On phones, the bottom `.input-area` could be pushed off-screen / unreachable** (iOS `100vh` + dynamic browser chrome), leaving no way to type a message in the web UI. The desktop layout is untouched; this fix only activates below 768px — the same breakpoint as the existing mobile rules.
- **New floating composer** (`src/renderer/ui/mobileComposer.js`, markup in `index.html`, styles at the end of `base.css`): a persistent 💬 FAB pinned bottom-right (fixed positioning + `env(safe-area-inset-*)` so it clears the iOS home indicator). First tap expands a full-width bar holding the chat input and SEND; second tap collapses it. The expanded bar also shows STOP while a run is active (it follows the existing `#stop-btn`).
- **No new controls, no duplicated wiring.** The module relocates the REAL `#user-input` / `#send-btn` / `#stop-btn` nodes into the floating bar — app.js's send handler, Enter-to-send, and online/disabled sync are bound to those elements and follow them unchanged. On a wide viewport (or rotation to landscape) the nodes are restored to their original parents and the FAB disappears; desktop behavior is byte-identical to v51.8.
- The unreachable bottom `.input-area` is hidden on mobile so there is exactly one visible composer, and the onboarding hint gets extra bottom padding so it never sits under the FAB.

### Verified
- New regression tests in `tests/mobileComposer.test.js` (jsdom): mobile activation relocates the real input + send into the floating bar; FAB toggles open/closed with aria-label/glyph flip; a click listener bound BEFORE relocation still fires after reparenting (the app.js wiring contract); wide viewport restores every node to its original parent; desktop-from-start is a no-op. All 5 pass.

## [51.7.0] - 2026-08-19 — Local image generation (🎨 IMG) on Vulkan

### Added
- **Image generation toggle** — a new 🎨 IMG chip in the cockpit (drives hidden `#image-gen-toggle`, persisted by the main process). When enabled, Agent Smith gets a `generate_image` tool and a system-prompt note telling it to use that tool whenever you ask for an image.
- **`generate_image` agent tool** (`src/renderer/modes/agentTools.js`) — takes prompt (+ optional negative_prompt / width / height / steps / cfg_scale / seed), runs locally via stable-diffusion.cpp, and returns a confirmation; the rendered PNG is displayed inline in the chat (via a renderer image queue so megabytes of base64 never enter conversation history or the activity timeline).
- **Main-process engine** (`src/main/services/imageGenManager.js`) — downloads the pinned stable-diffusion.cpp release (`master-820-de298c2`, Vulkan build) into `<userData>/imagegen/engine` on first use, extracts it with a dependency-free ZIP reader (stored + deflate), and spawns `sd-cli -M img_gen`. **AMD GPUs work via Vulkan — no ROCm.** Progress events (`imagegen-event`) stream engine/model download % and sampling steps to the sidebar.
- **Default model auto-download** — when no image model is detected, the default complete SDXL GGUF (Juggernaut XL v9 Q8_0, ~4.3 GB, UNet+CLIP-L+CLIP-G+VAE in one file) downloads from Hugging Face on first generation. Note: the `hum-ma/SDXL-models-GGUF` juggernautXL Q5_K_M file is UNet-only with bare Comfy tensor names (no CLIP/VAE inside), so it cannot render standalone — a complete single-file model was chosen as the default instead.
- **Sidebar IMAGE GEN section** (`index.html` + `src/renderer/ui/imageGenPanel.js`) — enable checkbox, model list with select/remove, IMPORT FILE (native picker) and import-by-URL for `.gguf` models, plus generation defaults (width/height/steps/cfg/sampler/negative prompt). Imported files are copied into `<userData>/imagegen/models`; the selected model is used for every `generate_image` call.
- **IPC domain** (`src/main/ipc/imageGen.js`) — `imagegen-status/set-enabled/update-settings/list-models/import-model/pick-file/import-url/select-model/remove-model/generate`, all whitelisted in `src/shared/ipcChannels.js`.

### Verified
- Live render on AMD (RADV GFX1151) via the Vulkan build: 512×512, 20 steps ≈ 14 s; output PNG validated (correct dimensions + non-blank pixel data).
- New unit tests in `tests/imageGen.test.js`: sd-cli argv builder (clamping/defaults), ZIP extractor (stored + deflate round-trip, zip-slip guard), model resolution precedence (selected → first detected → auto-download default), state persistence, and the IPC domain wiring.

### Fixed (found during final review before packaging)
- **Tool-supplied `negative_prompt` / `cfg_scale` were silently dropped.** The `generate_image` tool sends snake_case keys (`negative_prompt`, `cfg_scale`) but `imageGenManager.generate()` read camelCase only, so a model-provided negative prompt or CFG never reached sd-cli (the sidebar's own settings used camelCase and worked). `normalizeOpts()` in `src/main/services/imageGenManager.js` now maps both spellings before merging with the user's predefined settings — explicit tool args still win over saved defaults.

## [51.6.0] - 2026-08-18 — Chat fix: SEND works again (no more silent dead button)

### Fixed (the "input isn't submitted / reply never displays" symptom)
- **Every message sent in v51.5 died before it was ever rendered.** The new v51.5 min-context gate calls `window.XKCtxGate.checkCtxGate(...)` on every send — and the renderer's `minCtx()` read `process.env.XK_MIN_CTX` with a BARE reference to `process`. In Electron the renderer runs with `nodeIntegration: false` + `contextIsolation: true` (see `main.js` webPreferences), so there is no `process` global in the page: every send threw an uncaught `ReferenceError: process is not defined`.
- **Why it looked exactly like "send does nothing":** that call sits ABOVE `sendMessage()`'s try/catch (it runs during pre-flight validation, before `isSending = true`, before the input is cleared, and before either message bubble is created). An uncaught rejection in an event-listener callback produces no toast, no error bubble, no state change — the typed text just stays in the box forever. And because nothing was ever submitted to the model, there was never a reply to display either. One root cause, both reported symptoms.
- **Root cause location:** `src/shared/ctxGate.js` → `minCtx()`. Reproduced outside Electron by loading the module in a bare `window`-only VM context (no `process`) and calling the exact line `sendMessage()` calls: throws pre-fix, passes post-fix.
- **Fix:** guard the env read — `(typeof process !== 'undefined' && process.env) ? process.env.XK_MIN_CTX : NaN`. In Node (tests) the `XK_MIN_CTX` override still works; in the renderer it falls through to the 64000 default exactly as intended. The gate's behavior is otherwise unchanged: verified-too-small windows still block with the actionable notice, unverifiable endpoints stay usable.
- **Sibling call paths checked:** every other module bundled into the renderer was scanned for bare `process` references — only this one site ran in browser context (the others are main-process-only code paths).

### Verified
- New regression test in `tests/ctxGate.test.js`: loads `src/shared/ctxGate.js` in a process-less VM context that mirrors the Electron renderer exactly, then exercises both gate outcomes (pass at 262144 / block below minimum) through the same call `sendMessage()` makes. Fails on v51.5 code, passes on this one. Full unit suite run before packaging; rebuilt `dist/renderer/bundle.js` confirmed to carry the guard.

## [51.5.0] - 2026-08-18 — Hermes-standard coding, honest context windows, and a 64K floor

### Added (Code Mode now builds like the agent it mimics)
- **Hermes-standard workflow in the Code Mode system prompt** (`src/code/loop/turnLoop.js`): the old "write complete code" preamble is joined by an explicit METHOD block — *gather before changing* (read first, trace symbols to definitions, check the project manifest before assuming a library exists), *edit with tools* (files on disk are the deliverable, not reply text), *smallest correct change* (match existing conventions; no drive-by refactors), *verify the premise* (reproduce bugs, fix the class including sibling call paths), and *verify the result* (real command output beats a plausible-sounding description). Existing rules 1–13 are unchanged.
- **TEST BEFORE DONE is now enforced, not just requested** — new `testBeforeDone` middleware (`src/code/loop/middleware.js`) + rule #14 in the prompt: a run cannot be declared complete until at least one verification command (test/lint/compile/tsc/py_compile/…) has PASSED since the last file edit. `session.testRunsSinceEdit` is set on passing verification commands and reset on every successful write (`turnLoop.js`). The veto carries `forcePhase:'verify'`, which `handleCompletionReflection()` applies so the agent lands in the phase where run_command/tsc/pytest are offered — weak models can no longer assert "tests pass" without running them. Project-specific hints name the detected lint/test command; otherwise language-appropriate fallbacks (node --check + npm test for JS, py_compile + pytest for Python).

### Changed (the app reflects what LM Studio actually has loaded)
- **Context reflection** — `src/renderer/ui/runtimeProfileUI.js` now queries the main process (`lmstudio-get-status`, which reads LM Studio's `/api/v1/models`) on mount, on every model change, and every 10 s while idle. The selected model's REAL loaded context (the user's own setting in LM Studio) is mirrored over the computed auto-tune value into the slider + status chip ("LM Studio ctx 262144"), so the app never shows a computed default that disagrees with reality, and a manual reload in LM Studio at a different size shows up live.
- **Code Mode context policy** (`src/code/loop/contextWindow.js`): floor raised 16384 → 65536 (paired with the new gate), cap raised 32768 → 98304 for inference speed on local GGUFs — still never above what the model has loaded. Slider max extended to 262144 so large loaded windows display honestly (`index.html`).
- `src/shared/ctxGate.js` (new, bundled into the renderer) holds both policies in one testable module; default min overridable via `XK_MIN_CTX` env for exotic hardware.

### Added (minimum context gate)
- **Every model used by Agent Smith must carry at least 64K of context.** Enforced at send time (`src/renderer/app.js` → `window.XKCtxGate.checkCtxGate`): a verified loaded window below the minimum blocks the message with an actionable notice naming the model, its actual size, and the fix (reload in LM Studio at ≥64000). Unverifiable endpoints — remote server, LM Studio down, model not found — are NOT blocked, so chat stays usable where there is nothing to verify against.

### Verified
- New unit tests: `tests/ctxGate.test.js` (gate boundaries incl. exact-64000 pass + unmanaged-not-blocked matrix; reflection win/fallback/clamp), `tests/testBeforeDone.test.js` (veto/pass/no-edit/project-meta/language-fallback paths, forcePhase wiring). Updated `tests/codeContextWindow.test.js` for the new floor/cap.

## [51.4.0] - 2026-08-18 — Launch fix: packaged app no longer dies on `Cannot find module 'glob-parent'`

### Fixed (the "v51.3 won't launch" symptom)
- **The v51.3 AppImage/.deb crashed at startup** with an uncaught main-process error:
  `Error: Cannot find module 'glob-parent'` (require stack through `fast-glob` → `src/shared/globTool.js` → `main.js`). The window never opened; the app exited before the renderer loaded.
- **Root cause:** v51.3's `node_modules` was a *symlink* to the neighboring tree (`../v51.2/node_modules`, created Aug 17 at 20:22) instead of a real directory. electron-builder collects production dependencies from the project's real file tree and does not follow a top-level `node_modules` symlink — its module scanner reported it plainly in the build log:
  > `cannot find path for dependency dependencies=["@nodelib/fs.stat@undefined","glob-parent@undefined","micromatch@undefined", …42 more…]`
  yet still exited 0. Result: only 17 top-level packages (the declared deps + npm-metadata-resolvable ones) made it into `app.asar` — fast-glob itself was in, but its entire subtree (`glob-parent`, `micromatch`, `merge2`, `to-regex-range`, `braces`, `fill`, `is-number`, `path-type`, `@nodelib/*`) was not. v51.2's asar carried 252 top-level packages, including all of them.
- **Fix:** v51.4 ships with a real (copied) `node_modules` tree; the rebuilt `app.asar` now contains fast-glob's full dependency closure and the packaged app boots past module resolution. Verified by launching `release/linux-unpacked/agent-smith --no-sandbox` on this machine — no main-process exception, window reaches the renderer (LM Studio connection aside).
- **Rebuild hygiene:** cleared the stale `release/` artifacts from v51.3 before building so nothing ships under a mixed identity; `builder-debug.yml` regenerated by electron-builder confirms the same file patterns as v51.2's good build.

### Hardened (so this class of bug can't ship silently again)
- **`scripts/check-native.js` now detects a symlinked `node_modules`** on every `prestart`/`predist` run and prints a loud, actionable warning naming the failure mode ("electron-builder will NOT follow it… glob-parent gets dropped… crashes at launch") — the exact trap v51.3 fell into, caught 4 hours before packaging instead of after install. It stays silent on healthy real-directory installs (verified both ways).

### Verified
- Packaged-binary smoke test: `release/linux-unpacked/agent-smith --no-sandbox` boots past the previously-fatal require (v51.3's binary died within ~47ms of JS execution with the glob-parent stack; v51.4 reaches renderer init).
- `asar list` on the new `app.asar`: `glob-parent`, `micromatch`, `merge2`, `@nodelib/fs.stat`, `@nodelib/fs.walk`, `to-regex-range`, `braces`, `fill`, `is-number`, `path-type` all present (17 → 250+ top-level packages, matching v51.2's known-good tree).
- Unit suite run in-tree before packaging (see build log); same pre-existing plugin-sandbox failures as v51.2/v51.3, nothing new.

## [51.3.0] - 2026-08-17 — Qwen-3.x thinking fix: coding works out of the box

### Fixed (the "crash after I accepted the task planner" symptom)
- **Qwen 3-and-newer models burned their entire output budget on internal reasoning.** The Qwen3 chat template THOUGHTS BY DEFAULT. With LM Studio's `qwen3.8-27b-uncensored`, Code Mode got back `finish_reason:"length"` with EMPTY content and NO tool_calls — every turn after plan approval returned an empty assistant message, the completion gate complained "No project files were created", six reflections later the run died reporting 0 files written (verified live: one reply took ~310s to produce 6 KB of reasoning and zero output). Fix is table-driven in `src/code/context/modelHarness.js` — a new `qwen` strategy that sends `chat_template_kwargs {enable_thinking:false}` on every request (LM Studio forwards it to the template; verified live: same model then answers with a native `write_file` tool call in ~1s, reasoning capped at 77 tokens). Qwen **2.x** ids do NOT match — their templates have no thinking var, so the blast radius stays exactly where the bug lives.
- **The fix reaches BOTH surfaces.** `streamCompletion.js` (Code Mode) merges family body overrides into the wire payload; the renderer chat/agent path (`src/renderer/app.js`) does the same via the new `window.XKModelHarness.bodyOverridesFor(model)` — so a Qwen3 model that thinks by default no longer returns empty replies in plain Chat either.
- **The budget-exhaustion guard now fires without a reasoning signal.** `turnLoop.js` previously only boosted the reply budget + nudged when it saw BOTH `finish_reason:"length"` AND streamed `reasoning_content`. Some servers fold thinking into content or drop the field entirely — an empty reply ending in `length` is exhaustion either way, so the condition is now `(sawReasoning || finish === 'length') && emptyOutput`. A genuine `stop` with an empty reply still falls through to the completion gate untouched (pinned by test).
- **An LM Studio engine crash mid-request no longer masquerades as six empty turns.** LM Studio's predict runtime SIGABRTs under load (`main.log`: "Engine protocol runtime exited unexpectedly" / Vulkan `ErrorDeviceLost` on large prompts) and closes the stream right after HTTP 200 — no deltas, no `[DONE]`. `streamCompletion.js` now detects that exact shape (zero deltas + no finish_reason + no [DONE]) and rejects with a stall-class error, which routes into turnLoop's existing bounded retry path instead of recording six identical empty turns. Protocol-complete streams (finish_reason chunk or `[DONE]`) resolve exactly as before — pinned by tests.

### Verified
- New `tests/qwenThinkingFix.test.js` (9 tests): classifier boundaries (qwen3.x in, qwen2.5 out), harness routing + body overrides per family, REAL wire capture proving `chat_template_kwargs` lands on the request for qwen3 ids only, abrupt-empty-stream rejection vs `[DONE]`/finish_reason resolution, and the no-reasoning-signal budget-exhaustion retry. Full suite: 667 tests — 4 failures are the same plugin-sandbox environment issues present on pristine v51.2 (verified by running that file against v51.2).
- Live e2e (`scripts/live-e2e-v513.js`): real Code Mode turn loop, real LM Studio `qwen3.8-27b-uncensored`, the exact field-report task ("build me a simple web based game of snake") — see run log for files written on disk.

## [51.2.0] - 2026-08-17 — Per-message mode routing: chat is chat, code is code

### Fixed
- **Every message ran Code Mode.** The v50 "unified harness" hard-coded `isCodeModeEnabled() { return true; }` and `isAgentModeEnabled() { return false; }` in the renderer (`src/renderer/app.js`), so ALL input — greetings, questions, file organization, log inspection — went through the Code engine's project-build pipeline (plan phases, build tools, test-before-done gate). You could barely hold a conversation. v51.2 routes each message individually:
  - **New `src/shared/taskClassifier.js`** (`window.XKTaskClassifier`) — scores a message against strong coding signals (build/create/fix + artifact types, "in/using <language>", bug-fix phrases, package-manager commands), medium context signals (.ext mentions, stack traces, git verbs) and negative file-management/research signals. A message is a CODING task when the score clears the threshold or it carries an unopposed strong signal; anything else routes to the Agent Mode chat path with its full host-control tool surface (shell, files anywhere, web, memory).
  - **`sendMessage()` now calls `routeMessage(text)`** before dispatch. Coding tasks run the Code engine exactly as before — including mid-run continuity: while a Code run is live (plan awaiting approval, execution in flight), follow-up messages stay inside that code conversation instead of leaking into chat.
  - **Manual overrides**: prefix any message with `code:` or `/CODE:` to force the build pipeline, or `agent:` to keep it conversational (the token is stripped before it reaches the model). A one-time system notice explains auto-routing after the first routed Code run.

### Fixed (class)
- **Agent-mode system appendix re-appended on every message.** The idempotency guard searched for `[AGENT MODE` — a bracketed string that never occurs in the actual appendix text ("…operating in AGENT MODE") — so each chat turn appended the full ~1.5 KB of agent instructions to the session's system prompt again. Guard now matches the real phrase; history bloat stops at one copy.

### Verified
- New `tests/taskClassifier.test.js` (9 tests): coding asks → code, plain chat + ordinary agent tasks → agent, override-token strip/force semantics, mid-sentence non-matches, empty-input routing, score determinism. Full suite: 654 pass / 4 fail — the same 4 plugin-sandbox failures present on pristine v50 (pre-existing environment issue). AppImage + .deb rebuilt for x64 Linux.

## [47.9.0] - 2026-08-02 — Download refusals explain themselves + stale-link self-heal

### Added
- **`explainDownloadRefusal` diagnostic** (`src/main/services/downloadRegistry.js`): the `/download_remote` endpoint no longer answers a bare "File not found or not permitted". Every refusal returns a precise code + actionable message in the body AND the server log:
  - `missing_param` — the link was malformed when created
  - `missing_file` — no file on disk at that path (moved / renamed / deleted / never created)
  - `not_registered` — file exists but there is no evidence the agent produced it (blocked by the arbitrary-host-file protection), with the remediation (re-share via the download tool)

### Fixed
- **Stale links from older sessions/builds self-heal**: the renderer's download-click handler now re-registers the link's path via `agent-register-download` and AWAITS it before opening the URL, so a link created before the registry existed (or after a restart) works whenever the file is still on disk. Truly missing files land on the new reason page instead of a bare 403.

### Verified
- `tests/downloadRegistry.test.js` extended to 9 tests: each refusal code, roots/registry decision order, adapter shape. `npm test` green, AppImage + .deb rebuilt.


## [47.8.0] - 2026-08-02 — Kimi web_search builtin collision + whitelist follow-up

### Fixed
- **Agent Mode `web_search` failing on kimi-k3 with `{"success":false,"error":"Search request failed"}`.** Root cause: the app's tool is named `web_search` — the exact name Moonshot reserves for its SERVER-SIDE builtin (its own error format; the builtin's tool-result echo is broken on kimi-k3, confirmed against Moonshot's forum + docs). The model triggered the builtin instead of the app's DuckDuckGo search. Fix (modelHarness table): the kimi-k3 strategy now carries `toolNameOverrides: { web_search: 'internet_search' }` — renamed on the wire in `body.tools`, mapped back to canonical on receipt before validation/dispatch, and the system prompt is rewritten per turn (`adaptSystemPromptForModel`) so prompt and tool list stay consistent. The fallback text-tool parser matches wire names too.
- **`agent-register-download` was missing from the preload channel whitelist** (`src/shared/ipcChannels.js`) — the v47.7 download-link fix was unreachable in the desktop app (`Blocked IPC channel`). Now whitelisted + covered by a channel-presence test so any future renderer-invoked agent channel must be registered.
- **Backend search failures no longer masquerade as "no results"**: `web_search` returns an explicit `Web search failed: <reason>` when the search backend errors, distinct from a genuine zero-hit search.

### Verified
- New `tests/kimiWebSearch.test.js` (8 tests): rename/back-map round trip, system-prompt rewrite, override isolation to kimi, channel whitelist, error-vs-no-results paths. `npm test` green, `harness-eval` green, AppImage + .deb rebuilt.


## [47.7.0] - 2026-08-02 — Download-link fix for agent-created files (403 "File not found or not permitted")

### Fixed
- **`provide_file_download_link` links 403'd on click.** Agent Mode writes anywhere on the host (by design), but `/download_remote` only served files under the project root, userData, or ~/Downloads — every link to an agent-created file elsewhere was refused. New `src/main/services/downloadRegistry.js`: files are registered as agent-produced on write (`agent-write-file`) and at link issue; the download endpoint serves a path when it's inside the default roots OR proven agent-produced by the registry. The SSRF boundary is unchanged — no wider roots, no arbitrary host file reads. Registry persists to userData so links survive restarts.
- **Relative paths broke links too**: the tool now routes through the new `agent-register-download` IPC, which resolves paths exactly like `agent-write-file` (relative → project root), verifies the file exists, registers it, and returns the absolute path used in the link. Missing files return an error to the model instead of a dead link.

### Verified
- New `tests/downloadRegistry.test.js` (5 tests): register/isRegistered round trip, cross-restart persistence, roots→registry→403 decision order, link building with the resolved absolute path, error surfacing. `npm test` green, AppImage + .deb rebuilt.


## [47.6.0] - 2026-08-02 — Audit pass + model-harness restructure

### Changed
- **Model adaptation is now one table-driven module** (`src/code/context/modelHarness.js`): an ordered STRATEGIES table (gemma → kimi-k3 → default), first match wins, default matches everything so a lookup can never fail. Each row owns `adaptMessages` (prompt reshaping, idempotent), `pinTemperature` (family-mandated pins), and `nativeTools` (informational). Call sites migrated — turnLoop, planningPhase, streamCompletion, renderer chat — replacing scattered `isGemmaModel` / inline kimi checks. Gemma behavior is byte-identical to the legacy path (pinned by test); `window.XKGemmaHarness` stays exported for compatibility. Adding a family = one table row + one routing test.

### Fixed (audit findings)
- **`fitBudget` non-atomic eviction** (`src/code/context/budget.js`): one-message-at-a-time eviction could split a multi-tool run, leaving orphaned tool messages / unanswered tool_calls in the prompt (wire validity was rescued by the v47.5 sanitizer, but the model saw lossy "skipped" placeholders). Eviction is now atomic per conversational unit — an assistant tool_call block and its tool results move together; the protected head (system block + goal) and the freshest tail message are preserved.
- **Stale capability test** (`tests/harness-eval/capability/scenarios.test.js`): `capability-early-stop prevents runaway turns` asserted pre-v46.24.0 stop-early semantics and was failing 16/17 in a suite `npm test` doesn't run. It now pins the intended contract (exactly maxTurns turns execute; the next call stops).

### Verified
- New `tests/modelHarness.test.js` (8 tests): routing, never-fail lookup, Gemma byte-parity, adapted shape (no system/tool roles), idempotency, passthrough, temperature pins, atomic-eviction invariant. `npm test` 625/625, `harness-eval` 17/17, `harness-security` 6/6, `ship-check` all pass. AppImage + .deb rebuilt.


## [47.5.1] - 2026-08-02 — Canonical wire shape for strict APIs (Kimi 400 follow-up)

### Fixed
- **Remaining `HTTP 400: Invalid request` in Code Mode with Kimi K3.** With tool pairing fixed (47.5.0), Moonshot's validator still rejected the app's non-canonical message shapes — the same wire LM Studio silently tolerates:
  - `tool` messages carried an internal `name` field — Moonshot's documented tool message is only `role`/`tool_call_id`/`content`. `normalizeWireMessage` (toolPairing.js) now strips undocumented fields from every message on the wire; `assistant` messages with tool_calls omit empty-string `content` (canonical Moonshot shape); multimodal array content on user messages is preserved.
  - Tool schemas are normalized (`normalizeToolSchemas` in streamCompletion.js) to the minimum valid shape — `type: "function"`, named function, `parameters: { type: "object", properties: {} }` — so a malformed plugin/builtin schema can't sink a run.
- **Strict-API 400s are now self-diagnosing:** the error includes the validator's `param`/`code`/`type` when present (e.g. `param: messages.[3].name`) instead of a bare "Invalid request".

### Verified
- `tests/toolPairing.test.js` extended to 11 tests: field stripping, empty-content omission, multimodal preservation, schema normalization, 400 detail surfacing. `npm test` green, AppImage + .deb rebuilt.


## [47.5.0] - 2026-08-02 — Strict-API tool pairing fix (Kimi K3 Code/Agent Mode HTTP 400)

### Fixed
- **`Invalid request: tool_call_id is not found` (HTTP 400) in Code Mode with the Kimi K3 toggle.** Two-layer fix:
  - **Root cause — `phaseCompact.collectRecentToolPairs`:** a multi-tool turn produces ONE assistant message followed by SEVERAL tool messages, but compaction kept only the FIRST tool message of the run. The surviving assistant message still referenced the dropped tool_call ids, and Moonshot's strict validation rejected every subsequent request. Compaction now keeps the complete consecutive tool run (and never keeps orphan runs).
  - **Wire guarantee — new `src/shared/toolPairing.js` (`sanitizeToolPairing`):** every Code Mode request (turn loop, planning phase, milestone subagents) and every Chat/Agent request now passes through a sanitizer that backfills missing tool_call ids, synthesizes explicit "skipped" responses for tool_calls whose results were lost (compaction, session resume, interrupted runs), and drops orphan tool messages. Valid histories pass through unchanged; local LM Studio behavior is unaffected.

### Verified
- New `tests/toolPairing.test.js` (7 tests): multi-tool synthesis, orphan drops, id backfill, block ordering, compaction keeps whole runs, and a wire-level end-to-end asserting strict-API validity from a deliberately broken history. `npm test` green, `npm run build:renderer` green, AppImage + .deb built.


## [47.4.0] - 2026-08-02 — Kimi K3 API provider toggle (Chat + Agent + Code)

### Added
- **KIMI K3 API toggle** (sidebar → CONNECT): routes Chat, Agent AND Code Mode through the hosted Kimi K3 API (`https://api.moonshot.ai`, OpenAI-compatible) instead of the local LM Studio backend. Adds a `KIMI API KEY` field (Bearer auth) and a `KIMI MODEL` field (default `kimi-k3`). Toggle, key, and model persist across restarts (`agentsmith_kimi_k3*` localStorage keys).
- Code Mode threads an optional `apiKey` end to end: renderer (`code-run` / `code-resume` / `code-plan-approve`) → `src/main/ipc/code.js` → `runCodeTask` → `executeTurnLoop` / `runPlanningPhase` / milestone subagents → `streamCompletion`, which now attaches `Authorization: Bearer <key>` when a key is present and sends no auth header otherwise (local LM Studio behavior unchanged). The key is passed per-run and never persisted into CodeSession files.
- `set-lms-url` (IPC + web-server trap) accepts an optional second array element: a separate MEMORY/embeddings base. When Kimi is active the local backend URL stays pinned for embeddings (Kimi has no embeddings API); the proxy allow-list and Code Mode fallback base follow the Kimi origin.

### Changed
- Chat/Agent streaming uses the effective provider base + Bearer key, and sends a concrete `max_tokens` budget when Kimi is active (hosted APIs reject `max_tokens: -1`).
- **Temperature pinned to 1 for kimi-k3** (thinking model — the API rejects any other value with HTTP 400). Pinned in `streamCompletion` (covers every Code Mode path incl. planning + milestone subagents) and in the Chat/Agent request body, keyed on the model id via `isKimiK3Model()` in `modelClassifier.js` so other Kimi models keep normal temperature control.
- While the toggle is on, the local model dropdown is disabled and shows the active Kimi model; sending without an API key shows a clear setup message instead of a failed request.
- Health check (`checkConnection`) and runtime auto-tune probe the effective provider base.

### Verified
- `tests/kimiK3Provider.test.js` (8 tests): Bearer header attached only when a key is set, kimi-k3 temperature pinned to 1 on the wire (HTTP 400 regression), turn loop + planning phase forward the key, proxy allow-list accepts the configured Kimi origin and blocks unrelated hosts. `npm test` green, `npm run build:renderer` green, AppImage + .deb built.


## [46.24.1] - 2026-06-28 — Code Mode: stopping a run cancels an in-flight command

### Fixed
- Stopping a run now aborts an in-flight `run_command` immediately instead of waiting out its timeout. `runForegroundCommand` binds the active run's abort signal to the spawned process (Node's exec `signal` option), so `code-stop` / a parent abort kills the child at once. Confirmed: a long command is terminated ~300ms after stop rather than running for its full duration.

This completes the aggressive-audit fix pass (v46.20.0–v46.24.1): all critical, high, medium, and low findings are resolved or verified non-issues. Suite 571/571, harness-eval 10/10, harness-security 6/6.


## [46.24.0] - 2026-06-28 — Code Mode: nested deliverables, content-aware artifacts, exact turn budget, listener cleanup

Code Mode only. The remaining low-severity audit items.

### Fixed
- **Nested deliverables** (`fileScan.js` + gate/partialBuild/planStepAutoAdvance): required-artifact existence, index.html discovery, and the partial-build / plan-step scans only looked at the project root + one level, so a deliverable at e.g. `src/js/app.js` or `apps/web/index.html` was wrongly reported missing (a false `[ARTIFACT]` block / spurious nudge). They now search a few levels deep (breadth-first, shallowest match wins) while skipping vendor/build dirs.
- **Content-aware required artifacts** (`completionGate.artifactExists`): a prompt-named deliverable that exists but is **0 bytes** is no longer accepted as done — it must be non-empty (with an allowlist for legitimately-empty files like `.gitkeep` / `__init__.py`).
- **Exact turn budget** (`earlyStop.onTurn`): the max-turns check ran one turn early (advertised 40, executed 39). It now executes exactly `maxTurns` turns.
- **Abort-listener cleanup** (`streamCompletion`): the per-request abort listener on the shared run signal was never removed on normal completion, accumulating across turns (MaxListenersExceededWarning + retained closures). It is now removed when the request settles.

Verified: +tests/fileScanArtifacts.test.js (3) and updated turn-budget tests. Suite 571/571, harness-eval 10/10, harness-security 6/6.


## [46.23.1] - 2026-06-28 — Code Mode: pin the containment root for every run

### Fixed
- `startCodeTask` now pins the project-context containment root to the active run's project root (the path clamp + run_command policy previously relied on it having been set elsewhere, and would otherwise fall back to process.cwd()). This makes the v46.21.0 symlink-safe path clamp and command policy actually enforce the run's boundary for normal (non-isolated) runs. The isolated-worktree path still re-points the root to its worktree.

Verified end to end after the full security/robustness/polish pass: a real runCodeTask build passes (gate done, acceptance + smoke PASS) with 5 run_command calls and zero false blocks. Suite 568/568, harness-eval 10/10, harness-security 6/6.


## [46.23.0] - 2026-06-28 — Code Mode polish (context window targeting, scaffold safety, resilient finalize)

Code Mode only. Remaining audit polish.

### Fixed
- **Context-window targeting** (`contextWindow.js`): `fetchLoadedContext` no longer borrows a *different* model's window. It uses the in-use model's window by exact id; only when the requested id is absent entirely does it fall back to a single unambiguously-loaded model — otherwise it fails open to the requested value.
- **Pac-Man scaffold safety** (`harnessScaffold.js`): the last-resort scaffold never writes to the project root of an existing app/Electron repo (it drops the game into a `pacman/` subfolder instead), so it can't clobber a host app's root index.html. (It was already ledgered.)
- **Resilient finalize** (`turnLoop.js`): a validation error during the final verdict no longer sinks the whole run (losing the status + summary and surfacing as a bare error) — it falls back to an honest `unverified`. The final validation's web-wiring repair is now ledgered too.

Verified: +fetchLoadedContext regression test (never borrows another model's window). Suite 568/568, harness-eval 10/10, harness-security 6/6.


## [46.22.0] - 2026-06-28 — Code Mode robustness (context budget, resume durability, background cleanup)

Code Mode only. Robustness fixes from the aggressive audit.

### Fixed
- **Context budget overflow** (`budget.js`): `fitBudget` previously could not evict ANY system message, so accumulated `[HARNESS …]` recovery nudges piled up and pushed the prompt past numCtx — the backend then silently truncated the real prompt. It now protects only the leading system block (base prompt + compaction breadcrumb), the original goal, and the latest message, and evicts everything between oldest-first (including stale nudges), then re-checks after inserting the breadcrumb so that itself can't tip the budget. Token estimate tightened to ~3.5 chars/token to leave headroom for the (uncounted) tool-schema array.
- **Resume durability** (`runCodeTask`, `earlyStop`, `state.js`): resuming a session previously (a) reset the max-turns / no-write budget to zero each time (a run could resume forever), (b) kept a stale `numCtx` that could exceed the currently-loaded window, and (c) lost the isolation fields so a resumed isolated run leaked its git worktree. Now the turn counter seeds from the persisted turn, `numCtx` is re-resolved against the live loaded window on resume, and `isolatedRun`/`worktreePath`/`parentProjectRoot` are persisted so cleanup works.
- **Background-process leak** (`ipc/code.js`): `run_command` background jobs were never killed. Stopping a run now SIGTERMs every background job it spawned so they don't outlive (or persist past) the run.

Verified: +tests/codeRobustness.test.js (3); existing budget tests updated to the new protect-goal behavior. Suite 567/567, harness-eval 10/10, harness-security 6/6.


## [46.21.0] - 2026-06-28 — Code Mode security hardening (autonomous run_command + path containment)

Code Mode only. From the aggressive audit: after plan approval Code Mode runs tools autonomously, and the containment had holes. Closed the three most serious.

### Security
- **run_command** (`commandPolicy.js`): replaced the thin denylist with a real guardrail. It now blocks host-destructive ops, **privilege escalation (sudo)**, access to **home dotfiles / credentials / system secrets** (~/.ssh, ~/.aws, /etc/shadow, id_rsa, …), **raw network sockets** (/dev/tcp), **inline interpreter RCE wrappers** (`node -e`/`python -c` that spawn processes or open sockets), and any **destructive op or redirect whose target path escapes the project root**. Legitimate in-project dev commands (npm/node/python/git/test runners, deletes/redirects inside the project, package downloads) still run, so the agent stays autonomous. The project root is now threaded into the policy.
- **Path containment** (`projectContext.resolvePath`): made symlink-safe. The previous check was purely lexical, so a symlink whose name sat inside the root but pointed outside passed and writes followed it out. resolvePath now resolves the real path of the deepest existing ancestor and refuses any path whose real target escapes the real project root — the hard boundary the file tools rely on.
- **Change-ledger integrity** (`webModuleNormalize.js`): the gate's deterministic web-wiring repair (ES-module ↔ classic-script normalization) rewrote the user's .js/.html via direct fs writes, so "Revert All" could not undo them. It now snapshots each file through the change ledger before writing (threaded from the run); with no ledger (tests) it writes directly as before.

Verified: +4 security regression tests (blocks every audited bypass, allows legit in-project commands, refuses symlink escape, confirms the repair snapshots the ORIGINAL content before writing). Suite 564/564, harness-eval 10/10, harness-security 6/6.


## [46.20.0] - 2026-06-28 — Code Mode builds ANYTHING (gate no longer false-blocks correct code)

Code Mode only. An aggressive audit found the completion gate was overfit to web/CRUD apps and false-BLOCKED correct code — a normal keyboard game produced 6 bogus blockers and could never pass. Fixed so Code Mode accepts correct projects of any kind (games, generic web apps, scripts, CLIs, libraries) while still catching genuinely broken output.

### Fixed (false-blocks on correct code)
- **Smoke test** (`smokeTest.js`): the vm sandbox now provides the standard browser globals (`window.addEventListener`/`removeEventListener`/`dispatchEvent`, `navigator`, `location`, `performance`, `fetch`, `matchMedia`, `getComputedStyle`, `Audio`/`Image`, `Event`/`KeyboardEvent`/`MouseEvent`, storage, typed arrays, etc.) so standard idioms don't throw a false `[SMOKE]` failure. It also now fires deferred `DOMContentLoaded`/`load`/`window.onload` init once, like a browser — exercising (not breaking) apps that wire up on load. Still catches real load-time throws and undefined references.
- **Undefined-constant check** (`webValidators.js`): the scrubber now strips template-literal TEXT (keeping `${…}` expressions), so UPPERCASE words in strings like `\`GAME OVER\`` are no longer mis-flagged as undeclared constants; UPPERCASE function parameters are recognized as declared. Real undeclared constants are still caught.
- **Serialization-artifact check** (`webValidators.js`): the escaped-brace heuristic now scrubs strings/regex/comments first, so a valid regex like `/^\{.*\}$/` is no longer flagged; genuine JSON over-escape is still caught.
- **Game acceptance** (`acceptance.js`): now requires only the universal signals (responds to input + changes the screen via DOM/canvas/loop). Genre-specific tropes (a "player" element, a score, an explicit win/lose state) are diagnostics, not blockers — so any kind of correct game passes, while an empty title-screen shell still fails.

### Changed (de-hardcoded guidance)
- The "no files written" and "blocked build" gate messages are no longer web-only; they describe the task's actual files (web app, script, CLI, library, service) and only mention CSS-selector/page-load advice when the failures are actually web-related. Non-web projects (no index.html) already skip the entire web validation layer and pass on syntax + content + required-artifact + project-command checks.

Verified: the exact keyboard game that produced 6 false blockers now passes; a Python CLI passes; smoke still fails a real ReferenceError; suite 560/560 (+7 build-anything tests), harness-eval 10/10, harness-security 6/6.


## [46.19.3] - 2026-06-28 — Regression test: auto-tune fires on startup

### Tests
- Added `tests/autoTuneStartup.test.js` — drives the real `runtimeProfileUI` + `runtimeProfile` modules through `applyForCurrentModel()` (exactly what `fetchModels()` calls on boot) and asserts auto-tune actually fires: it scans hardware (`get-gpu-telemetry`), sizes num_ctx to the model + VRAM, overrides the 8192 slider placeholder, and triggers an LM Studio context reload. Also covers the negative cases — auto-tune OFF and a manual slider override both correctly skip auto-config and leave the conservative default. Verifies the v46.19.x context behavior end to end.


## [46.19.2] - 2026-06-28 — Revert default Context slider to 8192 (release-safe)

### Changed
- Reverted the Context Window slider's static default back to **8192** (v46.19.1 had bumped it to 16384). On a released app with diverse hardware, the static default must stay conservative: Chat/Agent send the slider value directly (no clamp), so a higher static default could over-request on low-VRAM machines in manual mode. It is also unnecessary — **auto-tune (on by default) overrides the slider right after the startup hardware scan**: it reads GPU telemetry, sizes num_ctx to the model + VRAM (e.g. ~13K at 8GB, ~26K at 16GB), sets the slider, and reloads LM Studio to match. And Code Mode independently uses the model's loaded window via the v46.19.0 clamp (never exceeding it). So 8192 is just the pre-scan placeholder, not what users actually run with.


## [46.19.1] - 2026-06-28 — Raise the default Context Window slider to 16384

### Changed
- The **Context Window** slider now defaults to **16384** (was 8192). This shared default applies to all modes; it gives Chat/Agent more room out of the box and matches the Code Mode floor. Code Mode already auto-uses the model's full loaded window via the v46.19.0 clamp (never exceeding what the model is loaded with), so Code Mode is unaffected by the slider value; this change primarily raises the Chat/Agent starting point. Users can still slide anywhere from 2048–131072. (Note: Chat/Agent send the slider value directly, so if a model is loaded with a smaller window the user should lower the slider to match — Code Mode handles this automatically.)


## [46.19.0] - 2026-06-28 — Code Mode: use the model's full context window

Code Mode only — Chat and Agent Mode still use the context slider directly.

### Added
- **Code Mode now requests the model's loaded context window instead of the shared 8192 default.** Multi-file builds need room to hold the whole app in context; at 8192 the model drifts across files (kebab/camel id mismatches, "x is not a function" cross-module bugs, dropped requirements). The SAME budget-tracker task that failed at 8192 ctx passes cleanly once the window is raised — proven with real `runCodeTask` builds (gate done + a real browser confirms it renders, totals update, and persists).
- New `src/code/loop/contextWindow.js`: reads the loaded window from LM Studio's native `/api/v0/models` endpoint and clamps the run's num_ctx to it — at least a floor (`XK_CODE_MIN_NUM_CTX`, default 16384), capped for inference speed (`XK_CODE_MAX_NUM_CTX`, default 32768), and **never above what the model is actually loaded with** (over-requesting would make the harness over-pack history and the backend silently truncate the prompt). On any non-LM-Studio backend where the loaded window can't be read, the requested value is respected unchanged (no risk). Wired into `runCodeTask` at the new-session chokepoint; emits a one-line advisory when it raises the window.

Verified: suite 550/550, harness-eval 10/10, harness-security 6/6. Real E2E at the default num_ctx auto-raised to the loaded window and the budget tracker built and passed (gate done, acceptance + smoke PASS).


## [46.18.1] - 2026-06-28 — Code Mode: tighten plan-step auto-advance heuristics

Code Mode only.

### Fixed
- **Plan steps no longer tick "done" on incidental keywords.** `isStepSatisfied` now requires evidence a feature is actually IMPLEMENTED, not merely mentioned: a filter step needs an input/change listener AND a real `.filter()`; a form/transaction step needs a `submit` handler that mutates state/DOM; CRUD needs a list mutation (push/splice); theme needs an actual toggle (classList/ data-theme), not the word "theme"; categories must be rendered/used. Also fixed a bug where data import/export matched the ES-module `import`/`export` keywords — it now requires `JSON.stringify` plus a blob/download/file path. The plan-UI blocker scan (`collectPlanBlockers`) also flags missing linked files so a plan can't read "complete" while assets are missing. (Plan auto-advance is advisory; the real completion gate stays authoritative.) Tests: `planStepAutoAdvance.test.js` (+2 tightening cases).


## [46.18.0] - 2026-06-28 — Code Mode: DOM-contract repair guidance + partial-build recovery (audited)

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Added
- **DOM-contract repair guidance** (`htmlContract.js`): when JS references element ids/form controls that index.html does not define, the harness now hands the model a precise repair instruction (e.g. `getElementById('transactionForm') → ('transaction-form')`) so it fixes script.js itself via `patch` (a ledger-tracked, reversible edit). The HTML ids are treated as canonical — a rewrite of the correct index.html during repair is blocked. **Read-only by design: the harness never rewrites the model's source.**
- **Partial-build recovery** (`partialBuild.js`): detects half-built web deliverables (HTML on disk, linked JS/CSS/README still missing) and nudges the model to finish the missing files; write-first now extends to partial builds.
- **Plan-step auto-advance + gate visibility** (`planStepAutoAdvance.js`, `codePlanPanel.js`): plan steps tick "done" as deliverables land (models rarely call mark_code_step_done), and the plan panel surfaces remaining gate blockers. Planning now emits 4–6 milestone steps instead of 10+ micro-steps.
- Smaller: `earlyStop` counts edits as progress; `extractor` salvages malformed write tool calls; clearer `[DOM]`/`[ARTIFACT]` completion-gate repair messages.

### Audit / safety
- This release incorporates an external batch of changes that were audited and cleaned before merge: the **auto-`fs.writeFile` code rewriting** (fuzzy id-rename, orphan-line pruning, and a top-level dedupe that deleted valid declarations in different scopes, all bypassing the change ledger) was **removed** — it could corrupt working code and its test mutated a committed fixture. Replaced with the read-only "tell the model exactly what to patch" path above. Also fixed an unguarded `document.body` deref in the timeline. A regression test asserts the harness never modifies the model's script and preserves valid duplicate-scoped declarations.

Verified: suite 541/541, harness-eval 10/10, harness-security 6/6. Real runCodeTask E2E: write-first holds (0 pre-write exploration), the gate correctly blocks a broken app with precise DOM repair instructions WITHOUT touching the model's code, and a correct app passes the gate and runs (renders, totals update, persists) in a real browser.


## [46.17.0] - 2026-06-28 — Code Mode: functional verification, less exploration, no false stalls

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Added
- **Web-app functional acceptance** (`acceptance.js`) — non-game interactive apps (todo/tracker/kanban/budget/calculator…) now get capability checks like games do: responds to input + updates the DOM, plus list-state and persistence when the goal implies them. Empty shells are blocked; static pages and calculators are not force-failed.
- **Required-artifact enforcement** — files the prompt explicitly names (e.g. `README.md`) must exist or completion is blocked (`[ARTIFACT] …`).
- **DOM-contract consistency** (`webValidators.validateDomIdConsistency`) — JS that references an id/`form.field` the HTML never defines is blocked (`[DOM] script references #type-filter … did you mean #filter-type?`). Tolerates `a || b || c` fallback chains and dynamically-created ids.
- **jsdom functional smoke** (`functionalSmoke.js`, optional dep) — for interactive goals, loads the app, fills + submits the first form and fails on an uncaught error or a submit that changes nothing (`[FUNCTIONAL] …`). Patches jsdom's missing `form.namedField` access so working apps don't false-fail; reports unavailable (never silent) if jsdom isn't installed.
- **Write-first on empty workspaces** — a greenfield build's first turn offers only write tools (no read/grep/glob/list/preview), so the model creates files immediately instead of exploring an empty folder. Full toolset returns once a file exists.
- **Configurable stream timeouts** — `XK_CODE_STREAM_IDLE_MS` (between-token) and a separate, generous **first-token** window (`XK_CODE_STREAM_FIRST_TOKEN_MS`, default 120s) so a heavy single `write_file` (large context) isn't killed as a false "stall".
- **Stall/reasoning visibility** — `stream_retry` and `reasoning_truncated` now render as timeline rows instead of blank turn bars.

### Changed / Fixed
- Plan/artifact paths are **model-led** — bootstrap and recovery nudges no longer prescribe `pacman/`/`app/`/`site/`; path enforcement comes from disk truth.
- **Host-aware missing-ref seeding** — in an Electron/app repo, seeding uses the deliverable's subfolder index.html, never the host root.
- Pac-Man last-resort scaffold writes now go through the change ledger (revertable).

Verified: full suite 511/511, harness-eval 10/10, harness-security 6/6. Real `runCodeTask` E2E (qwen3-coder): write-first gives 0 pre-write exploration; the gate correctly blocks a broken app (kebab/camel id mismatch + missing README that acceptance and smoke both passed) and passes a correct app that runs in a real browser.


## [46.16.3] - 2026-06-28 — Code Mode: task-appropriate plan wording (no game language for non-games)

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **Non-game web app tasks no longer get game-specific plan wording.** The fallback plan (`codePlan.defaultPlan`) hardcoded "Verify game logic and show preview" for EVERY new-artifact build, so a "Personal Budget Tracker" showed a "Verify game logic" step. `defaultPlan` now branches by task type: a game gets game steps (input/game loop/win-lose — appropriate), while a generic web app gets neutral steps — "Create HTML structure and responsive styling", "Implement app state and localStorage persistence", "Implement core interactions (add/edit/delete, filters, totals)", "Verify interactive app behavior and linked assets, then show preview". Browser preview is preserved for both. Also gated the "For a game: …" completion-gate hint behind `goalIsGame` (non-games get a neutral "complete app behavior" hint), and neutralized two Pac-Man examples that appeared in generic prompts (the system-prompt CSS/JS class example and a write_file error example). Game/Pac-Man prompts still get game wording. Tests: `planTaskType.test.js`.


## [46.16.2] - 2026-06-28 — Code Mode: proactive asset-completion recovery

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **Keep the model on the asset-completion path instead of drifting back to rewriting the HTML.** After creating an HTML entry point, the harness already scans it for linked `<script src>` / `<link rel="stylesheet">` assets and arms a repair nudge. But once the model created ONE missing asset (e.g. `style.css`), the nudge didn't re-fire for the remaining one (`script.js`), so the model drifted into rewriting `index.html` and only then hit the block. Now creating any asset while others are still missing **re-arms the high-priority repair nudge** for the next turn, so the model is told to create the remaining file(s) — with their complete paths — before the rewrite even gets attempted. The block (and structured CREATE/FIX repair plan from 46.16.1) remains as the backstop; legitimate HTML edits once all assets exist are unaffected. This is per-run workspace state, not memory. Test: `assetRecoveryPolicy.test.js`.


## [46.16.1] - 2026-06-28 — Code Mode: structured blocked-write recovery

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **A blocked index.html rewrite now hands back a clear repair plan instead of trapping the model.** The guard still blocks pointless rewrites of a working `index.html`, but the old message forced one exact path ("NEXT tool call MUST be write_file path=…") and game-flavored hints, so weak models looped on the HTML. The block (and the next-turn nudge) now return a structured plan: **CREATE** each missing linked file (`write_file`, complete JS/CSS, no HTML) and **FIX** each existing-but-broken one — e.g. a `.css` that contains HTML → "replace with CSS only (use patch or write_file)". Complete paths, multiple files allowed in one turn, `patch` offered for repairs, and a strong "REPAIR, DO NOT RESTART" instruction injected on the next turn. New shared module `governor/repairPlan.js`; test `blockedWriteRecovery.test.js`.


## [46.16.0] - 2026-06-27 — Code Mode: proactive mid-build runtime verification

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Added
- **Load the app in a real browser DURING the build and feed errors back so the model fixes them in-flight.** The completion gate's runtime check only fired when the model declared "done" — which local models often never do (they grind to a turn/no-write limit). Now, once the web project is structurally complete (index.html + every referenced script on disk), the turn loop loads it in a real browser after a file-changing turn; if it throws, the exact errors are injected as a fix-it nudge so the model corrects mismatched import/export names, undefined references, wrong element ids, etc., and keeps going. Throttled by a content signature (only re-checks when files change) and capped (`XK_CODE_MAX_RUNTIME_CHECKS`, default 6) to avoid loops; disabled by `XK_CODE_NO_RUNTIME_VERIFY=1`. Tests: `proactiveRuntime.test.js`.


## [46.15.1] - 2026-06-27 — Code Mode: runtime check on the final verdict

Code Mode only.

### Fixed
- **Run the real-browser runtime check on the final verdict too.** 46.15.0 wired runtime verification into the completion-reflection gate, but a run that ends without a completion reflection (e.g. early-stop) computed its final status via `finalize()` -> `runValidation` without the verifier — so the end status didn't reflect whether the app actually runs. `finalize()` now passes `execDeps.runtimeVerify`, so the final status is honest about runtime errors even when the model never declared "done".


## [46.15.0] - 2026-06-27 — Code Mode: real-browser runtime verification

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Added
- **The completion gate now verifies a built web app actually RUNS, in a real browser.** Static checks (references, syntax, VM smoke) can't catch the open-ended space of "loads but doesn't work" — `import { X }` where the module doesn't export X, `window.App` undefined, an exception on init, a 404. The gate now serves the project over HTTP and loads it for real (hidden Electron `BrowserWindow` in the app; Puppeteer injected in tests), capturing uncaught exceptions, module errors and failed requests. Each becomes a `[RUNTIME]` message: the run is blocked AND the exact error is fed back to the model to fix next turn — instead of the gate passing an app that doesn't run. Fail-open (never blocks on infrastructure failure); disable via `XK_CODE_NO_RUNTIME_VERIFY=1`.

  Proven with a real browser: an app with a wrong import name is blocked with *"does not provide an export named 'KanbanState'"*; a wiring bug the normalizer repairs (`const App` used as `window.App`) loads cleanly and passes. Tests: `runtimeVerify.test.js`, `runtimeGate.test.js`.


## [46.14.1] - 2026-06-27 — Code Mode: converge multi-file wiring consistently

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **Make the multi-file web repair converge instead of flip-flopping across gate passes.** The gate runs repeatedly as the model edits, so the repair must drive the whole project to ONE consistent strategy. 46.14.0 "left real module apps untouched", but a prior pass could have already downgraded the tags to classic while the files still used `import`/`export` — leaving `<script>` + `export` → "Unexpected token 'export'" (the exact state an end-to-end build landed in). Now: if any file uses real import-wiring, every local `<script>` is forced back to `type="module"`; otherwise tags are forced to classic and module syntax is stripped — and in both cases referenced `window.*` globals are exposed. Verified in a real browser for both classes (3 columns, 1 button, zero errors). Tests: `webNormalizeProject.test.js` (now 6).


## [46.14.0] - 2026-06-27 — Code Mode: deterministically repair multi-file web wiring

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **The #1 reason a "built" multi-file app didn't actually run: inconsistent module/global wiring.** Local/coder models mix strategies unpredictably. The verification step now deterministically repairs both failure classes before judging the build:
  1. classic `<script>` + ES-module syntax (`import`/`export`) → strip the syntax (already shipped in 46.13.1), and
  2. **`type="module"` + code that relies on `window.*` globals** (e.g. `const App = {}` referenced as `window.App` — module scope means `window.App` is never set, so the app dies on load with "Cannot read properties of undefined") → downgrade the tags to classic and expose the referenced top-level declarations on `window`.

  Real ES-module apps (files that `import` each other) are detected and left untouched. Verified in a real browser, before vs after on the exact failure: `window.App` `undefined`→`object`, columns `0`→`3`, buttons `0`→`1`, errors → none. Tests: `webNormalizeProject.test.js`. Suite 454/454.


## [46.13.4] - 2026-06-27 — Fix: welcome page covering the activity timeline

### Fixed
- **The "AGENT SMITH" welcome/empty-state overlay stayed on top of the live activity timeline during a run.** The empty-state is hidden by `updateEmptyState`, which was only called at `run_start` (before any content exists). The timeline inserts its rows into `#messages` but never re-checked the empty-state, and system messages now render as toasts (not inline `.message` nodes), so nothing re-hid the welcome — it sat in front of the live timeline. The timeline now re-checks the empty-state whenever it inserts content (single choke point: `insertBeforeAnchor`). Verified in a real browser: the welcome's `display` goes `flex`→`none` once the first turn renders. Not caused by the preview-approval guard (v46.13.3), which is unrelated and correct.


## [46.13.3] - 2026-06-27 — Code Mode: Preview no longer hijacks plan approval

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **The Preview drawer auto-opened during planning/approval and blocked the Build Plan / "Approve & Run" controls.** Root cause: `show_preview` is a read tool, so the model can call it during the PLANNING phase (read-only exploration); the resulting preview event opened the drawer over the plan sidebar (a stale preview from a prior run could too). The renderer now **suppresses the automatic preview-drawer open while the plan is in the planning/approval phase** — the approval UI keeps priority. Preview content is still rendered (a later manual open shows it), and the drawer auto-opens normally once execution begins. Manual preview, `show_preview` during execution, and `browser_verify` are all unaffected. Pairs with the prior fix that clears a stale preview at run start.


## [46.13.2] - 2026-06-27 — Code Mode: clear stale preview at run start

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **An empty preview drawer left over from a prior run blocked the plan at the start of a new run** — you had to manually exit preview mode to reach plan mode. A new Code Mode run now clears any lingering preview drawer up front (on `run_start` / `planning_start`), so the planning/plan view is visible immediately. Mid-run previews opened by `show_preview` during execution are unaffected.


## [46.13.1] - 2026-06-27 — Code Mode: auto-repair module/classic script mismatch

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **The #1 reason built web apps didn't actually run: module-vs-classic script mismatch.** Local models (even coder models like qwen3-coder) routinely write `import`/`export` in `.js` files that `index.html` loads as classic `<script src>` — which throws "Unexpected token 'export'" and the app is dead on load. Code Mode now deterministically strips ES-module syntax from classic-loaded scripts during verification (they share state via the global scope), so the app runs. Proper `type="module"` apps are untouched. Model-independent — no longer relies on the model getting it right.

Verified end-to-end in a real headless browser: a multi-file Kanban app built by qwen3-coder (with constrained decoding) now loads with **zero JS errors**, renders its columns, and a card added through the UI appears in the DOM.


## [46.13.0] - 2026-06-27 — Code Mode: constrained tool-call decoding (opt-in)

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Added
- **Constrained tool-call decoding for local models (opt-in: `XK_CODE_CONSTRAIN_TOOLS=1`).** Local/reasoning models often narrate ("I'll write index.html") or emit malformed tool calls instead of actually calling a tool, which stalls multi-file builds. When enabled, Code Mode sends the advertised tools to LM Studio as a `response_format` `json_schema` union (structured-output / constrained decoding), so the model can ONLY emit a valid `{name, arguments}` tool call — it physically cannot malform or narrate. A synthetic `attempt_completion` branch lets it still signal "done" (handled as a normal no-tool-call turn). **Default OFF**, so current behavior is unchanged. Verified against `qwen3-coder-30b`: produces a valid tool call via the constrained path. Unit tests: `constrainTools.test.js`. Suite 440/440 with the feature off.


## [46.12.7] - 2026-06-27 — Code Mode: fix false "verified" on reused workspaces

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **CRITICAL: a web build could be falsely reported "✅ COMPLETE (verified)".** The completion gate located the web entry (`index.html`) only among files written in the *current run*. In a reused workspace where `index.html` already existed from an earlier run but this run only wrote a trivial file (e.g. `utils.js`), the gate skipped ALL web checks ("no web project") and passed on whatever parsed — even though `index.html` referenced 7 files that were never created. The gate now also locates an `index.html` on disk (root or an immediate subdir) for a web-app goal and validates its references + smoke test, so a partially-built app correctly reports INCOMPLETE. A host Electron app's own `index.html` is excluded (it isn't the deliverable). Verified against the exact failing scenario.

Known minor limitation: the HTML reference extractor parses only quoted attributes (`src="x.js"`); unquoted attributes are not checked (rare). Also recommended: run each Code Mode build in a **fresh** workspace — reusing one across tasks leaves stale files (and a stale `.agentsmith/PLAN.md`) that confuse the build.

## [46.12.6] - 2026-06-27 — Code Mode: retry on model stall

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **A single model stall no longer ends the whole run.** Local/reasoning models intermittently stall mid-stream (the 60s idle timeout fires). Previously that error ended the run immediately, abandoning a build that had already written some files with the rest missing. Now a stall retries the turn on a fresh request (up to 4 consecutive; `XK_CODE_STALL_RETRIES`), and the no-progress and max-turn guards still bound the run. Verified live: a build survived 4 stalls and kept going for ~10 minutes instead of dying on the first.

This is a **resilience** improvement, not a capability one. A model that stalls on a large fraction of its turns still cannot reliably complete very large multi-file specs in a reasonable time — use a coder model (e.g. Qwen2.5-Coder) for ambitious builds; the runtime advisory flags this.

## [46.12.5] - 2026-06-27 — Code Mode: multi-file build reliability

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Changed / Fixed
- **Multiple files per turn (was one-file-per-turn).** The system prompt and the missing-file recovery nudge previously pushed "ONE file per turn" / "ONE tool call", fragmenting multi-file builds across many turns (each a stall / lose-the-plan risk — the cause of a Kanban build leaving 8 referenced files uncreated). The model is now told it MAY emit several `write_file` calls in one turn; observed batching up to **6 files in a single turn**.
- **Anti-"lazy" prompting.** The system prompt now demands complete, working code — never placeholder comments, stubs, "..." elisions, or "TODO: implement" in place of real logic.
- **Web module-style guidance.** For static/offline web apps, instruct classic `<script src>` (no `import`/`export`; share via `window` globals) — ES modules break over `file://` (CORS) and `import`/`export` in a plain script throws a syntax error.
- Updated the stale "~400 lines" hint in the prompt to ~1000 (matches the write_file cap).

Verified by re-running a multi-file Kanban-class build (GLM in LM Studio): **all** linked files created (was 1 of 8), **zero** dangling references (was 8), batching up to 6 files/turn, and the build reaching `done`. Remaining run-to-run variance is model consistency — the runtime advisory recommends a coder model.

## [46.12.4] - 2026-06-27 — Code Mode: larger single-file writes

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **`write_file` no longer rejects complete source files at 400 lines.** Real multi-file apps have modules of 400–800 lines; a complete 449-line file was bounced with "Content too large (max 400)", forcing weak models into a fragile write-the-first-400-then-append dance that derailed ambitious builds (e.g. a Kanban app whose `utils.js` was rejected, after which the model stalled leaving 8 referenced files uncreated). Raised the line cap to **1000**. This only ever affected *complete* content — real output truncation is still handled separately (finish_reason=length → append chunks), and the 64KB byte cap remains the hard size backstop. Verified by building a 525-line module in a single write.

## [46.12.3] - 2026-06-27 — Code Mode: no-progress early stop

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **Runs no longer burn all 40 turns doing nothing.** Code Mode is a build/edit loop, but its early-stop only caught tool *errors* (5) and *duplicate* calls (8). A model that explored read-only every turn (read_file/grep/list) never tripped either and ground to the max-turn limit having written zero files — reported as UNVERIFIED. Added a no-progress guard: if no file is written for N consecutive turns (default 12, override with `XK_CODE_MAX_NOWRITE_TURNS`), the run stops early with an honest message — suggesting Chat/Agent mode for analysis/Q&A, or restating the task as a concrete build/edit. Writing a file resets the counter, so legitimate exploration-before-writing is unaffected.

## [46.12.2] - 2026-06-27 — Code Mode: generic (de-gamed) file-recovery nudges

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Fixed
- **Recovery nudges were game/Pac-Man-framed.** When a web build left a linked file missing (e.g. `index.html` referencing a `script.js` that wasn't created), the harness told the model to build "the complete game: state, input, loop, win/lose" and referenced `pacman/` paths — misleading for non-game apps (Kanban boards, dashboards, etc.) and a cause of runs stalling to max turns. Nudges are now generic; game-specific hints apply only to actual game goals.
- **Missing-file nudges enforce same-folder placement.** They now state the exact target path and that the file must be a sibling of the HTML that links it. The common failure was the model writing the file in a different directory or under a bare name, leaving a dangling reference.

Verified by re-running a Kanban build that previously failed at max turns (files split across `site/` and `src/`, dangling references): it now completes in ~20 turns with `index.html`/`style.css`/`script.js` in one folder, no dangling references, and runs in a browser (3 columns, no JS errors).

## [46.12.1] - 2026-06-27 — Code Mode: reasoning-model advisory + reasoning auto-collapse

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Added
- **Reasoning-model advisory.** When Code Mode detects at runtime that the selected model is a reasoning model (emits `reasoning_content` or inline `<think>`), it shows a one-time, non-blocking notice that a coder model (e.g. Qwen2.5-Coder) is recommended for builds. Detected by behavior, not by model name — so it never wrongly blocks a capable model. Code Mode still runs with any model.
- **Reasoning auto-collapse.** A turn's "Thinking" panel collapses when the next task/turn begins, and each turn's reasoning starts fresh — keeping the timeline readable on long runs.

## [46.12.0] - 2026-06-27 — Code Mode robustness: anti-freeze, reasoning models, code map

Code Mode only — Chat and Agent Mode behavior is unchanged.

### Added
- **Run watchdog + heartbeat.** Code Mode emits periodic `heartbeat` events (elapsed/idle/phase) and converts a genuine async stall into a clear `WATCHDOG_STALL` error instead of an invisible freeze. Tunable via `XK_CODE_HEARTBEAT_MS`, `XK_CODE_INACTIVITY_MS`, `XK_CODE_MAX_RUNTIME_MS`.
- **Ranked code map.** The first-turn bootstrap now includes a `[CODE MAP]` of key project symbols (functions/classes/exports), ranked by entrypoint/descriptive heuristics, so small models can locate code in an existing project without reading the whole tree. Empty for greenfield. Dependency-free.
- **Reasoning-model handling.** Detects when a model burns its whole reply budget on internal reasoning and emits empty output (`finish_reason: length`), then retries with a larger budget and a "stop reasoning, act now" nudge. Handles both the `reasoning_content` and `reasoning` stream fields and strips inline `<think>…</think>` from content before tool/edit parsing.
- **docs/CODE_MODE_MODELS.md** — guidance on choosing coder (non-reasoning) models, the LM Studio VRAM/`lms` model-switch steps, and watchdog env knobs.

### Fixed
- **Clearer model-load errors.** A model that fails to load in LM Studio now surfaces an actionable message instead of a generic HTTP error.
- **Bounded plugin tool calls** (2-min timeout) and **timeout-guarded smoke verification** (VM engine by default; jsdom opt-in via `XK_SMOKE_JSDOM`) so a misbehaving tool or infinite loop can't hang a run.
- **Pac-Man scaffold scope.** The last-resort recovery scaffold no longer fires for generic "game" goals, so a non-Pac-Man build can't be overwritten with Pac-Man code.

## [46.11.0] - 2026-06-24 — Desktop polish, sidebar UX, docs sync

### Added
- **Frameless desktop shell.** Electron runs with `frame: false` and a minimal custom titlebar — drag strip plus **− □ ×** on the top-right (not in the sidebar). Window IPC: `window-minimize`, `window-maximize`, `window-close`, `window-is-maximized`.
- **Official desktop icon.** AS monogram assets in `build/icons/`; Linux `npm run install-desktop` writes a `~/.local/share/applications/agent-smith.desktop` entry with `StartupWMClass=agent-smith` for correct taskbar/dock identity.

### Changed
- **Sidebar polish.** Lighter card surfaces and calmer green accents (less glow); **TUNING**, **CODE**, and **CONNECT** nested under a single **ADVANCED** section.
- **Phone QR UX.** 📱 stacked above 📁 in the composer; QR opens as a centered modal (moved to `<body>` so mobile sidebar transforms cannot clip it). Fallback QR generation in preload when `get-remote-qr` IPC is unavailable.
- **Linux window chrome.** `ozone-platform-hint: x11` and `WM_CLASS=agent-smith` for consistent frameless behavior; login/admin overlays start below the titlebar so close/minimize stay reachable.

### Fixed
- **WhatsApp link on machines without Puppeteer Chromium.** `resolveChromeExecutable()` falls back to system Chrome/Chromium before failing; onboarding explains `npx puppeteer browsers install chrome` when nothing is found.
- **Blank or missing phone QR** when tunnel/LAN URL was present but image generation failed.

### Removed
- **Live browser automation** (`agentBrowser`) and interactive `browser_*` agent tools — use **Code Mode `browser_verify`** (headless HTML check), **`show_preview`**, or **`web_search` / `fetch_url`** (read-only) instead.
- **Credential Vault** (`credentialVault`) and `vault_*` tools — no stored-password tool surface; regression test blocks credential tools from Agent Mode.
- **Persistent chat watchers** (`chatWatcher`) and `watch_chat_*` tools — removed with their `agent-browser-*` / `vault-*` / `chatwatch-*` IPC channels.

> **Still available:** Code Mode `browser_verify`, sidebar **Preview** (`show_preview`), Agent **`web_search` / `fetch_url`**, optional **WhatsApp** linking (`whatsapp-*` IPC, opt-in dep).

## [46.10.0] - 2026-06-24 — Phone connect, zero‑setup cockpit, gate + tool‑call fixes

### Added
- **Open on your phone (QR).** A new 📱 button in the composer opens a themed popup with a scannable QR of the phone‑reachable URL — the public Cloudflare tunnel link if it's up, otherwise the LAN URL — with a **REMOTE / LAN badge** so you know which kind of link you're scanning. Replaces the old sidebar "Web Remote URL" text readout. (`get-remote-qr` IPC via the bundled `qrcode` dep.)
- **WhatsApp onboarding.** When the optional WhatsApp dependency isn't installed, `LINK WHATSAPP` now opens a clear install wizard (what it does, the one‑time `npm install whatsapp-web.js qrcode` command with a COPY button, restart hint) instead of a cryptic error. When it *is* installed, the link QR shows in the same modal with explicit step‑by‑step instructions to scan it from **WhatsApp → Linked Devices → Link a Device** (not the phone camera, which can't read an account‑linking code and shows a dead link).

### Changed
- **Zero‑setup cockpit (less clutter).** Build Mode now **always plans then grinds** to green — the PLAN and GRIND chips are gone (engineered defaults, enforced in code). Removed the unused **ISO** (isolated‑worktree) chip and the **NETRUNNER** chat‑web toggle. The experimental **Milestone Execution** toggles were removed. Manual tuning sliders (Temperature / Thinking Steps / Context) are hidden unless **Auto‑tune** is turned off.
- **Hardware Guard redesigned.** Pulled out of the Advanced drawer into an **always‑visible, compact cockpit strip** (live RAM / GPU VRAM / GPU load with bars that colour amber > 80% and red under pressure), theme‑matched, with a clearly‑labelled **⟳ GPU RESET** button (still confirm‑gated).

### Fixed
- **Code Mode "unverified" on scriptless JS projects.** The completion gate could never validate a bare project that had `*.test.js` files but no `package.json` test script, so correct code kept iterating until the turn cap. The project detector now infers `node --test` for such projects, and the gate also credits the agent's own successful program/test run (exit 0 since the last edit). Lifted the Tests category from 5/10 → 9/10 in the 100‑task battery (incl. red→green "make the failing test pass").
- **Agent Mode dropped malformed tool calls.** A model emitting a tool call as raw JSON in prose with unescaped inner quotes (e.g. `{"command":"echo "x" > f"}`) failed strict `JSON.parse` and was silently dropped. `extractTextToolCalls` now repairs that shape (gated on a known tool name → no false positives). Added regression tests.
- **Data‑parsing hint.** Bootstrap now tells the model to read a data file and split on a delimiter it can actually see (mitigates a CSV pipe‑delimiter hallucination on some small models).
- **Build Mode live preview was blank.** The preview `<iframe>` loaded the auth‑gated `/preview/*` route as a cross‑origin request that can't carry the session cookie, so it had no token and returned HTTP 401 → a white panel even though the built app was fine. The Preview panel now appends the session token to the iframe, snapshot, RELOAD, and OPEN EXTERNAL URLs, so the live preview authenticates and renders the project.

## [46.9.0] - 2026-06-16 — Agent Mode (full host control + trust layer)

### Fixed
- **Chat Mode (critical):** Sending a message did nothing when LM Studio returned an empty model list (its Just‑In‑Time loading mode). `fetchModels` was overwriting the dropdown with an empty list, leaving "no model selected" so every send silently returned. It now never blanks a usable selection, **remembers the last model** (persisted), keeps it usable when the live list is empty (LM Studio loads it on demand), and shows a clear message instead of doing nothing.
- **Agent loop stability:** `pruneChatHistory` (a no‑op) was letting large tool outputs balloon the context → "reloads every step / yellow banner / repeats / hallucinated success". History is now bounded. The text‑JSON tool‑call fallback was generalized beyond `web_search`, and the anti‑loop guard uses a sliding window, ignores read‑only tools, and stops honestly (no false "failed" after a success).
- **Startup/build:** self‑hosted fonts (offline + CSP‑clean), resilient web‑server port binding (no crash if the port is busy), repaired the bundled Electron/electron‑builder.

### Added
- **Full host control in Agent Mode:** whole‑host file read/write/delete + process management (`list_processes`/`stop_process`/`send_input`), guarded by `pathPolicy` (refuses wiping system/home roots) and `commandPolicy`.
- **Web read in Agent Mode:** `web_search` (search the internet) and `fetch_url` (read a page/API as text).
- **Trust layer:** action log of consequential actions (file writes/deletes, shell, sends) with **undo** for file ops; `review_actions`/`undo_action` tools.

### Security / Privacy
- `pathPolicy` blocks catastrophic file targets (refuses wiping system/home roots); `commandPolicy` filters dangerous shell commands.

## [46.9.0] - 2026-06-15

### Fixed
- **UI:** Made the visual web search results block durable so that it properly re-renders from the chat history (`convo` array) when switching modes or reloading the application, ensuring the search sources retrieved are permanently visible in the chat feed.

## [46.8.0] - 2026-06-15
- **UI:** Added a persistent visual results block to the chat feed whenever `web_search` executes. This explicitly shows the user the exact URLs and Titles that were retrieved and injected into the agent context.

## [46.7.0] - 2026-06-15
- **Agent Mode:** Updated system prompt to strictly forbid raw JSON leakage. Rewrote the JSON fallback parser to use regex so it can extract and execute malformed tool calls even if the agent prefixes them with conversational text.

## [46.6.0] - 2026-06-15
- **Agent Mode:** Added a fallback JSON parser for `web_search` tool calls to catch cases where the model incorrectly outputs the raw tool call JSON into the chat stream with unescaped quotes instead of using the proper API schema.

## [46.5.0] - 2026-06-15
- **UI:** Added a visual toast notification in Agent Mode to alert the user when a `web_search` is executed.

## [46.4.0] - 2026-06-15
- **Agent Mode:** Added an automatic system nudge to the `web_search` tool output. This forces the model to immediately summarize search results for the user without waiting for a manual "continue" prompt.

## [46.3.0] - 2026-06-12
- **UI:** Disabled the debug window (DevTools) from opening automatically when the application starts.

**Build Optimization and Version Bump**

### Fixed
- **Build Size Reduction:** Optimized the build process to ensure that previous build artifacts and unnecessary dependencies are not included in the final packages.
- **Maintenance:** Bumped version to 46.2.0 for a fresh release cycle.

## [46.0.0] - 2026-06-11

**Agent Mode Legacy Port**

### Changed
- **Agent Mode Replaced:** Replaced the highly-restricted Agent Mode with the legacy 'Agent sys-access' logic from v41.7 of Xkaliber Agent. This restores full file modification capabilities (`write_file`, `delete_file`) to Agent Mode, effectively unlocking system writes outside of the rigid constraints of Code Mode.

## [45.0.3-hotfix2] - 2026-06-10

**Web Search Hang Fix.**

### Fixed
- **Web Search Timeout:** Added a 15-second timeout to the `web_search` tool (`perform-search` IPC handler). Previously, if DuckDuckGo tarpitted or silently dropped the connection without closing it, the Node.js `fetch` call would hang indefinitely because it lacks a default timeout. This caused the Agent Mode turn loop to freeze indefinitely, preventing the model from ever receiving the tool results and continuing the conversation.

## [45.0.3-hotfix] - 2026-06-10

**Critical Linux Build, UI, and Startup Crash Fixes.**

### Fixed
- **UI Lockup (Blank Scripts):** Fixed an issue where the renderer completely failed to bind event listeners (dead buttons/dropdowns) in packaged builds due to the `esbuild` output directory (`dist`) overlapping with the `electron-builder` output directory. `electron-builder` now outputs to `release/`, preserving the UI `bundle.js` in the archive.
- **Read-Only Filesystem Crash (app.asar):** Fixed a fatal `EACCES`/`EROFS` crash where `ghosttrace` attempted to run `fs.mkdirSync` inside the read-only `app.asar` archive on boot, preventing IPC registration. It now maps its data directory to `~/.config/Agent Smith/ghosttrace` when packaged.
- **Missing Dependencies:** Addressed missing `bcryptjs` dependency which threw exceptions before `auth.js` IPC handlers could mount.
- **Build Configuration:** Added missing `homepage` metadata to `package.json` to satisfy the strict requirements of `electron-builder`'s `.deb` target on Linux.

## [45.0.3] - 2026-06-09

**Agent mode, cross-platform run, and conversation persistence — hardened for release.**
Green on `npm test` (318), harness-eval (17), harness-security (6), `ship-check`, `verify-main-ipc`, `build:renderer`.

### Fixed
- **Agent mode** — `agent-list-directory` returned a pre-joined string but the renderer called `.join` on it (crashed the tool); now returns an array. Foreground `run_shell_command` blocked the whole turn for 5 min when opening a GUI app (browser) — `FG_TIMEOUT_MS` lowered 300s→90s and the model is told to background GUI/long-running launches. Background shell now uses `/bin/sh` (not `bash`, absent on minimal Linux) with an `error` listener so a spawn failure can't crash the main process.
- **Whole-app freeze on send** — the chat/agent stream re-parsed the entire growing markdown buffer per token (O(n²)); now throttled via `createThrottledRenderer`.
- **Reasoning display** — `reasoning_content` (qwen3 etc.) now renders in a collapsible "💭 Reasoning" panel instead of looking frozen while the model thinks.
- **Conversation persistence** — Chat/Agent/Code keep separate, per-mode rendered snapshots (messages + tool cards + reasoning) that survive mode switches and relaunch; switching mid-run no longer loses the reply; the run's bubble re-attaches live when you return. Final-render snapshot ordering and the abort path corrected.
- **Startup resilience** — an optional subsystem (puppeteer/Chromium, LM Studio probe, plugin) throwing no longer prevents IPC handlers from registering ("No handler for auth-register"); each IPC domain registers in isolation with auth first.
- **Auth** — first account is always admin, and if no usable admin exists the next signup is promoted (no lockout); legacy records without a `permissions` object are normalized on load.
- **Security** — `git commit` ran user-controlled message text through a shell (`exec`); now uses `execFile` (argv, no shell) — no injection, correct on Windows too.
- **Linux packaging** — WhatsApp deps (`whatsapp-web.js`/`qrcode` → puppeteer/Chromium) made optional so a clean `npm install` can't fail on them; `package.json` `author` restored (electron-builder `.deb`); `build-renderer` reports an esbuild platform-binary mismatch clearly.

### Added
- `run.sh` / `run.cmd` / `scripts/bootstrap.mjs` — zip-and-run on any OS; detects a cross-platform `node_modules` (electron/esbuild) and reinstalls for the current machine, then launches.
- Regression tests: `editDeathSpiral`, `autonomousGameBuild`, `agentListDir`, `ipcResilience`, `auth`, `whatsappOptional`, `modeHistory`, plus extended `historyPersistence`.

### Docs
- `docs/architecture.md` rewritten to the real `src/code/*` engine + three-mode model (was describing a non-existent `src/agent/*`); `AGENTS.md` folder map corrected.

---

## [45.0.2.1 — internal] Code-mode edit-loop robustness + release cleanup

**Code-mode edit-loop robustness + release cleanup.** Fixes the failure mode where a weak model corrupted a file into an unrecoverable state, removes dead code/features ahead of the test-user release, and locks the three-mode conversation invariant with a regression test. Green on `npm test`, harness-eval (17), harness-security (6), `ship-check`, `verify-main-ipc`, and `build:renderer`.

### Fixed
- **Edit death-spiral** — a weak model was forced onto `append_file` for *revisions* (because `write_file` was capped at 60 lines), which duplicated top-level definitions (five `gameLoop`s) until every `patch` hit "Multiple exact matches" and the run died on "5 consecutive tool errors". Four compounding fixes:
  - `MAX_WRITE_LINES` 60 → 400 (`src/code/tools/executor.js`) so a complete file fits one `write_file`; real truncation is still caught by the existing `finish_reason=length` retry path.
  - `patch` gains `replace_all` + actionable multi-match errors (`src/shared/editFormats.js`, `src/main/services/editEngine.js`, `src/code/tools/schemas.js`) — an escape from the duplicate dead-end.
  - `append_file` refuses to write past `</html>` or to re-declare a top-level symbol already in a `.js` file (`src/code/tools/executor.js`) — steers revisions to `patch`/`write_file`.
  - `EarlyStopDetector` no longer counts a duplicate-skip toward the fatal consecutive-error limit (`src/code/governor/earlyStop.js`).

### Added
- `tests/editDeathSpiral.test.js`, `tests/autonomousGameBuild.test.js` — reproduce the spiral through the real executor and prove a complete game now builds to a verified completion.
- `tests/historyPersistence.test.js` — regression coverage locking the **three separate, persisted conversations** invariant (Chat/Agent/Code round-trip independently; legacy single-array history migrates into Chat only).

### Fixed (startup)
- **"No handler registered for 'auth-register'" / dead IPC on some Linux builds** — `main.js` constructed optional subsystems (pluginManager, previewRunner, browserVerify, lmStudioManager) at module load *before* `registerAllIpc()`. If any threw (puppeteer/Chromium absent, LM Studio probe, a bad plugin), IPC registration never ran, so the window loaded but every channel was unhandled. Those inits are now wrapped (`safeInit`) so they degrade to null instead of aborting startup, and `registerAllIpc` registers each domain in isolation (auth first) so one failing domain can't take down sign-in. Regression: `tests/ipcResilience.test.js`.
- **Login/register now self-heal admin + surface real errors** — first account is always admin, and if no usable admin exists the next signup is promoted (`src/main/services/auth.js`); handlers show the actual failure instead of a dead button. Regression: `tests/auth.test.js`.

### Packaging
- **Zip-and-run on any OS** — added `run.sh` (Linux/macOS), `run.cmd` (Windows), and a dependency-free `scripts/bootstrap.mjs`. The bootstrapper detects when `node_modules` was built for a different OS (an Electron app's `electron`/`esbuild` binaries are native and single-platform) and reinstalls for the current machine automatically, then starts the app. You can now zip the whole folder and run it on Linux or Windows with no manual dependency surgery.
- **WhatsApp deps made optional — fixes recurring "`npm install` fails on Linux"** — `whatsapp-web.js` (a peripheral feature) pulled in **puppeteer**, whose postinstall downloads ~150 MB of Chromium and needs Linux system libs; that was the dependency that broke a clean Linux `npm install` every time. `whatsapp-web.js` + `qrcode` moved to `optionalDependencies` (a failure there no longer aborts the install), and `src/main/lifecycle/whatsapp.js` now lazy-loads them so the app installs/runs without Chromium. WhatsApp linking is opt-in (`npm install whatsapp-web.js qrcode`). No core feature used puppeteer — `browserVerify` uses Electron, not headless Chromium.
- **Restored `author` in `package.json`** — its removal in 45.0.2 broke `npm run dist` on Linux (electron-builder requires it for the `.deb` maintainer field). This, plus a Windows-built `node_modules` shipped in a zip, was the real cause of a friend's "app won't start / can't sign in" on Linux — not the login UI.
- **`scripts/build-renderer.js`** now detects an esbuild platform-binary mismatch (node_modules copied across OSes) and prints an actionable "run `npm install` on this machine" message instead of a cryptic stack trace.
- **README** — added a "Sharing with someone on another OS" section: send source only (never a cross-platform `node_modules`); build Linux artifacts on Linux.

### Removed
- Dead renderer module `src/renderer/ui/sidebarResize.js` (unwired; targeted non-existent DOM).
- Abandoned chat extraction `src/renderer/modes/chat.js` + `router.js` (bundled but unconsumed; live chat path is unchanged).
- Vestigial `src/shared/toolRegistry.js` + test (no runtime importer; live gating is `channelPolicy`/`phases`). Docs repointed to `src/code/tools/schemas.js`.
- ~2.2 MB of working-tree dev trace artifacts; stale `main.js` GPU comment.

## [45.0.2] - 2026-06-08

**Renderer organization + doc hygiene.** Moves UI assets into `src/renderer/`, removes stray third-party product references from package metadata and comments, and updates navigation docs. No agent-loop or IPC behavior changes. Green on `npm test` (304) and `npm run build:renderer`.

### Changed
- **`styles.css` / `styles.overlay.css`** → `src/renderer/styles/base.css` + `overlay.css`; `index.html` link paths updated.
- **Root `renderer.js`** → `src/renderer/app.js`; `index.html`, `main.js` public-file list, and `tests/rendererLoadOrder.test.js` repointed.
- **`README.md`** — project layout table, current key paths, runtime-profile highlight.
- **`AGENTS.md`**, **`docs/architecture.md`**, **`docs/CODE_MODE.md`**, **`SMITH.md`** — paths and folder map aligned with the move.
- **UI/CSS comments** — removed comparisons to other coding-agent products; neutral wording only.
- **`package.json`** — removed stale `System76` author/homepage metadata.

### Removed
- **`JAN_REDESIGN.md`** — obsolete overlay notes (theme lives in `src/renderer/styles/`).

## [45.0.1] - 2026-06-08

**Code-mode write integrity + web-project verification.** Fixes the failure that shipped a broken Pac-Man build (corrupted `style.css`, invisible game) and closes the verification gaps that let it pass the completion gate. Green on `npm test` (286), harness-eval (17), and harness-security (6); `npm run build:renderer` clean.

### Fixed
- **Tool-call extractor field-order corruption** (`src/code/tools/extractor.js`) — `extractLenientWriteCalls` found a write's `content` boundary by walking back from the end of the object, which only held when `content` was the last field. When a model emitted `{…,"content":"…","path":"…"}` (content before path), the `","path":"…"` tail was swallowed into the file (the `}\n","path":"style.css` artifact). Now trims any recognised key that follows `content` before locating its closing quote. Handles escaped and unescaped quotes in content; content-last ordering unaffected.
- **`memory` success-wrapper contract** (`src/main/services/memory.js`) — `addVector`/`queryVectors` returned a bare `{ error }` on embedding failure while the success path returned `{ success: true }`. Both error paths now return `{ success: false, error }` for a consistent wrapper (backward-compatible: `error` is still present).

### Added
- **`detectSerializationArtifacts`** (`src/code/governor/webValidators.js`) — error-level check for leaked tool-call JSON tails (`","path":…`) and backslash-escaped braces (`\{`/`\}`) in any written CSS/JS/HTML file. Defense-in-depth for the extractor fix above.
- **`validateRenderedClassesStyled`** + **`extractJsAppliedClasses`** (`src/code/governor/webValidators.js`) — flags the "invisible game" disconnect where a script renders elements with classes the stylesheet never defines (e.g. JS renders `.cell/.pellet/.pacman/.ghost` while CSS styles `.character/.dot/.powerup`). High precision: only fires when a stylesheet exists and the unstyled classes are the majority of what the script renders.
- All four checks wired into the completion gate (`src/code/governor/completionGate.js`) so they block a premature "done".
- Regression coverage in `tests/auditContinuation.test.js` (9 tests).

## [44.2.0] - 2026-06-06

**Doctrine-driven bloat cut** — implements [`SMITH.md`](SMITH.md): one product path (Build Mode), delete over deprecate, shrink `main.js`.

### Removed
- **`resources/piper/`** (~110MB) — bundled Piper TTS binaries, voice model, and espeak-ng data. `electron-builder` `extraResources` entry removed. Desktop Piper path deleted (`src/main/lifecycle/tts.js`, `tts-speak` IPC). **Browser Web Speech API** TTS remains via the ADVANCED toggle.
- **Chat Mode tool stack** — removed ~130 lines of `AGENT_TOOLS` schemas and ~100 lines of `executeTool` from `renderer.js`. Chat is conversation-only; memory still injects via `searchMemory()`. Retired AGENT toggle hidden in UI.
- **README bloat** — replaced ten version-highlight blocks with a concise current-state README pointing at `SMITH.md`.

### Changed
- **`main.js` slimmed** — WhatsApp IPC → `src/main/lifecycle/whatsapp.js`; Piper TTS → `src/main/lifecycle/tts.js`.
- GhostTrace CLI → `scripts/ghosttrace-cli.js` (`node scripts/ghosttrace-cli.js run`).

## [44.1.0] - 2026-06-06

**Root cleanup — shim removal.** The temporary re-export shims from the `src/` restructure are gone. Purely structural; no behavior changes. Green on `npm test` (148), `npm run ship-check` (7 scenarios), `node scripts/verify-main-ipc.js` (73 channels), and `npm run build:renderer`.

### Removed
- **All 8 root re-export shims** (`agentLoop.js`, `auth.js`, `changeLedger.js`, `contextBuilder.js`, `editEngine.js`, `memory.js`, `planStore.js`, `projectContext.js`) and the **entire `lib/` shim directory** (24 files).
- Every requirer now imports the real `src/...` path directly: `main.js`, the legacy CLIs (`index.js`, `tools.js`, `cli-build.js`, `standalone-server.js`), the test suite, and `scripts/ship-check.js`.
- **`preload.js` intentionally kept** at root (re-exporting `src/preload/index.js`): Electron's `webPreferences.preload` and the web server's static file list reference it by path, so it moves only with the deferred renderer/`main.js` bootstrap relocation.

### Changed
- **Legacy CLI entry points moved into `cli/`**: `cli/index.js` (Ollama CLI), `cli/tools.js`, `cli/cli-build.js`, `cli/standalone-server.js`. Their `require()` paths were repointed (`./src/...` → `../src/...`, `./ghosttrace` → `../ghosttrace`) and `standalone-server.js`'s `cloudflared` lookup adjusted to `../cloudflared`. Invocation is now `node cli/cli-build.js ...` etc. (docs updated). The Electron shell (`main.js`, `preload.js`, `index.html`, `icon.png`) stays at root — conventional for Electron and coupled to `__dirname`/the static web root. *(Renderer CSS/JS moved under `src/renderer/` in 45.0.2.)*
- `create_icon.py` moved into `scripts/`; `.gitignore` now also ignores `.claude/`.

## [44.0.0] - 2026-06-06

**Professional `src/` restructure** — a purely structural release. The flat Electron layout moved into a predictable `src/` tree so humans and AI assistants can navigate it: one folder per job, no 2,000+ line god files, one place to add a tool, and esbuild instead of fragile `<script>` ordering. **No agent behavior, prompt, or feature changes.** Every phase ended green on `npm test` (now 148 tests) and `npm run ship-check`.

### Added — repository structure
- **`src/` tree.** `src/main/` (Electron `services/` + `ipc/` + `server/`), `src/renderer/` (`chat/`, `build/`, `ui/`, `assets/`), `src/agent/` (`loop/`, `tools/`, `context/`, `state/`, `harness/`), and `src/shared/`. See [`AGENTS.md`](AGENTS.md) for the full map.
- **Root shims.** Every moved module keeps a one-line `module.exports = require('./src/...')` re-export at its old path so `cli-build.js`, tests, and external scripts keep working through the migration. *(Removed in 44.1.0 — see above.)*
- **`AGENTS.md`** — primary AI + human entry point: folder map, Build-vs-Chat flow, the "add a tool" checklist, IPC rules, and a "what not to touch" list.
- **`docs/architecture.md`** — process model, run paths, the agent-loop split, IPC domains, and the design for the still-deferred `renderer.js` / `main.js` split.

### Added — esbuild renderer bundle
- **`scripts/build-renderer.js`** + **`src/renderer/entry.js`** bundle the renderer-side agent modules into `dist-renderer/bundle.js`.
- **`index.html`** now loads one bundle script (plus `renderer.js`, still the large DOM script) instead of 12 ordered `<script>` tags.
- **`package.json`**: `esbuild` devDependency; `build:renderer` / `watch:renderer` scripts; `prestart` / `predist` auto-build the bundle.

### Changed — `agentLoop.js` decomposed
- The ~2,350-line god file is now a ~350-line orchestrator in `src/agent/loop/agentLoop.js` that wires focused factory modules through a shared harness `H`: `toolSchemas.js` (pure tool data), `streamCompletion.js` (SSE parse + tool-call extraction), `toolExecutor.js`, `planning.js`, `execution.js`, `review.js`. Exports on `window.XKAgentLoop` / `module.exports` are unchanged.

### Changed — `main.js` IPC handlers extracted to `src/main/ipc/*`
- The ten service-delegating IPC domains moved out of the ~1,770-line `main.js` into per-domain modules — `auth`, `history`, `agent`, `edit`, `project`, `plan`, `ledger`, `git`, `memory`, `plugins` — each exporting `register(ipcMain, deps)` and closing over nothing global. `main.js` builds one `deps` object and calls `registerAllIpc` (`src/main/ipc/index.js`).
- `main.js` **stays at the repo root** as the bootstrap, so `__dirname` is unchanged and the static web server, preload path, and `loadFile` keep working. OS/lifecycle handlers (WhatsApp, TTS, GPU telemetry, app-reset, set-lms-url, the web server, host/env/external-url) intentionally remain inline.
- Verified by `scripts/verify-main-ipc.js`, which loads the real `main.js` under stubbed electron/whatsapp/http/memory and asserts all 73 channels register exactly once and are whitelisted. Splitting `renderer.js` and relocating the `main.js` bootstrap into `src/main/` remain deferred (GUI-only verification) — see `docs/architecture.md`.

### Added — tool registry (kills four-place drift)
- **`src/shared/ipcChannels.js`**: single source of truth for the IPC channel whitelists; `src/preload/index.js` imports it instead of duplicating the lists.
- **`src/agent/tools/registry.js`**: aggregates tool schemas, phases, and IPC channels with integrity checks; **`src/agent/tools/readFile.js`** is the reference colocated-tool module.
- **`tests/toolRegistry.test.js`**: asserts every schema tool has a dispatch case, the reference module stays consistent, and the registry channel list matches the shared source.

### Added — git safety net
- `git init`, plus a `.gitignore` covering `node_modules/`, `dist/`, `dist-renderer/`, ghosttrace artifacts, `.superpowers/`, and OS junk.

### Deferred (documented, not done)
- Splitting `renderer.js` (~2,670 lines of DOM code, loaded as a plain script) and relocating the remaining `main.js` bootstrap into `src/main/index.js` are **designed in `docs/architecture.md`** but not executed, because they require an Electron GUI smoke this environment cannot run. Both stay at the repo root for now.

## [43.1.0] - 2026-06-06

**Gemma Harness** — ports Google ADK's Gemma-specific message adaptation into Agent Smith's OpenAI `/v1/chat/completions` path so Gemma 3n/4B and Gemma 4 models plan, call tools, and build reliably in LM Studio. No ADK Python dependency; pure JS in `lib/gemmaHarness.js`. New tests in `tests/gemmaHarness.test.js`; suite now 142 tests.

### Added — `lib/gemmaHarness.js`
- **`isGemmaModel` / `gemmaVariant`**: auto-detect Gemma models and branch Gemma3 vs Gemma4 (`tool_responses` role for Gemma 4 per ADK).
- **`foldSystemForGemma`**: moves `role: system` content into the first user turn — Gemma chat templates often ignore the system role.
- **`buildGemmaToolPreamble`**: injects an explicit "respond ONLY with `{"name","parameters"}`" block plus the real tool names for the call.
- **`serializeToolTurnsForGemma`**: rewrites assistant `tool_calls` and `role: tool` results into plain text turns so multi-turn builds don't error or stall.
- **`adaptMessagesForGemma`**: orchestrates the above; idempotent (safe when planning/recovery loops re-send a growing message array each turn).

### Changed — model family & prompts
- **`contextBuilder.js`**: Gemma is now its own model family (split out of the `llama` bucket) with a dedicated imperative family prompt; Gemma always gets compact build/planner prompts regardless of the context slider (Smith monologue is a known Gemma failure mode).
- **`lib/smithPersona.js`**: `buildPlannerSystemPrompt` and `buildChatSystemPrompt` accept `{ compact: true }` for Gemma — strips philosophical anchors, keeps guardrails and tool rules.

### Changed — agent loop & chat path
- **`agentLoop.js`**: `adaptOutgoingMessages` runs the harness before every `streamCompletion` (planning, recovery, execution) using that call's actual tool names. ADK's "last valid JSON object" fallback added to `extractToolCallsFromText` for when Gemma emits prose before the tool JSON. `model` threaded into `buildPlanningContext`.
- **`renderer.js`**: chat path (Build Mode off) folds system prompts and uses compact Smith for Gemma models.
- **`index.html`**: loads `lib/gemmaHarness.js` before `contextBuilder.js`.

### Testing
- **`tests/gemmaHarness.test.js`**: detection, variant branching, fold, serialize, preamble, idempotency, non-Gemma pass-through.
- **`tests/agent-loop.test.js`**: `detectModelFamily('gemma-3-4b-it')` → `'gemma'`.
- **`scripts/ship-check.js`**: smoke test for fold + serialize + preamble.

Non-Gemma models (Qwen, Llama, etc.) pass through completely untouched.

## [43.0.0] - 2026-06-05

A **left-panel UX overhaul** plus an inline tool-activity timeline. No engine/agent-loop changes — every fix is in the sidebar markup, the renderer's panel wiring, and the agent run UI's timeline target. Renderer JS references elements by ID, so the markup reorder is behaviour-preserving.

### Changed — sidebar reorganized for user flow (`index.html`, `styles.css`)
- **Instant-access quickbar.** The **BUILD MODE** and **AGENT** toggles are lifted out of any collapsible folder into a new always-visible `.xk-quickbar` at the top of the panel — the two things you reach for most are no longer buried in a section. Styled with a left accent rail + faint glow to read as the panel's primary control.
- **Sections renamed for clarity.** `CHAT` → **MODEL** (model select, temperature, steps, plus the Build-Mode model/context controls), `INTEGRATIONS` → **PLUGINS** (redundant inner "🧩 PLUGINS" label removed).
- **Sections reordered and regrouped.** New top-to-bottom order: quickbar → MODEL → PLUGINS → CONNECTION → WORKSPACE → ADVANCED. `FEATURES` (memory / local-TTS / TTS / Netrunner toggles) folded into **ADVANCED** alongside the WIPE / export / import / sudo / hardware-monitor controls. CONNECTION and WORKSPACE start collapsed.
- **WhatsApp moved to CONNECTION.** The `wa-link-btn` now lives in the CONNECTION section next to the LM Studio server input and host URL, where link/connection actions belong.

### Fixed
- **"📍 Here I am" workspace picker is always visible (`renderer.js`).** The button (and workspace status) were coupled to Build Mode and rendered with `display:none`, so the new WORKSPACE section showed up empty when Build Mode was off. Decoupled in `updateBuildModeUI` and `updateWorkspaceStatus` so the picker is available regardless of mode.
- **Agent tool activity now streams inline in the chat (`lib/agentRunUI.js`).** Tool calls/results and verify failures previously rendered in a separate `#agent-timeline` block detached from the conversation. The timeline now targets `#messages`, so each tool row flows chronologically in the chat column; the plan surface stayed in its drawer. Run reset no longer wipes chat history (it only cleared the old dedicated block).

## [42.3.1] - 2026-06-04

### Fixed
- **Build could spin for many turns doing nothing, then die with `[BLOCKED step null]`.** `submit_plan` was offered (and handled) during the execution phase. A small model that re-emitted `submit_plan` mid-build hit `plan-create`, which made a fresh `awaiting_approval` plan with `currentStepId = null` — wiping the live plan and stranding the loop until the no-progress ceiling killed it. Now `submit_plan` is excluded from the execution tool set, and its handler refuses to recreate a plan that is already approved/executing (covering the text tool-call fallback), steering the model to work the current step or use `add_steps`. Regression-tested in `tests/submitPlanGuard.test.js`.

## [42.3.0] - 2026-06-04

Coding-capability **Tier 2** from the audit — the structural items that most raise multi-step build quality. New tests in `tests/codingTier2.test.js`; suite now 67. Verified live in the running app (new tools registered; `fetch_url` strips HTML and is netGuard-blocked for internal hosts).

### Added — plan can now adapt mid-build
- **`add_steps` tool.** The agent appends new steps to the running plan when it discovers unplanned work (a missing config, migration, refactor); they appear in the plan panel and execute after the current ones — no re-approval (`planStore.addSteps`, IPC `plan-add-steps`).
- **Retry-then-skip on `mark_step_blocked`.** A blocked step first gets one chance to try a different approach to the *same* step instead of stranding its dependents; only then does it skip. Harness auto-blocks (stall/loop/edit-fail) still skip immediately.

### Added — new capabilities (toward production-agent parity)
- **`fetch_url` tool.** Fetch a docs/API page and get its readable text (HTML stripped, ~8 KB cap), routed through `lib/netGuard.js` (metadata/link-local/ULA blocked). Lets the model read real documentation instead of guessing from a search snippet. Available in planning and execution.
- **Background-process control.** `read_process_log` now reports `{ running, exitCode }`; new `list_processes` and `stop_process` tools; foreground `run_shell_command` gets a 5-min timeout so a forgotten long-runner fails fast instead of hanging the turn. Enables start-server → poll → curl → kill.

### Changed — verification & robustness
- **Per-step syntax gate.** Every step must now pass a fast per-file syntax check before `mark_step_done` (the full test/lint suite still runs only on the final step), so broken code is caught immediately instead of piling up to the end.
- **Unified-diff applier fails loudly.** A patch whose context/delete line doesn't match now returns a clear error and the model re-reads — previously it consumed to end-of-file, silently corrupting the file while reporting success.
- **Reading isn't a stall.** Read-only investigation (read/grep/glob/list/repo-map/fetch) no longer counts toward the "no progress" ceiling, so the agent can study several files before editing without getting its step killed.
- **Read files stay in context.** A file the model `read_file`s during a step is auto-added to that step's context (capped), so the dependency it just read doesn't fall out next turn.
- **Embeddings fallback.** When Ollama is unreachable, vector memory falls back to the configured LLM's OpenAI-compatible `/v1/embeddings`, so LM-Studio-only setups get working memory instead of silent failure.

## [42.2.0] - 2026-06-04

Fixed the **UI freeze while the agent is working** — root-caused to two synchronous hot paths (regression tests in `tests/perfFreeze.test.js`; suite now 59). Measured in the running app: streaming a 111 KB buffer went from **~3,700 ms of blocked UI thread to ~0 ms**.

### Fixed
- **Per-token re-render froze the renderer (primary cause).** `streamCompletion` calls `onDelta(fullContent)` on every streamed token, and the agent UI re-ran `markedParse` (full markdown + `highlight.js`) over the entire growing buffer and rebuilt the DOM each time — O(n²), worst with **small models**, which stream tool calls as plain text so a large `write_file` body balloons the buffer. Streaming now uses a **coalescing throttle** (`lib/renderThrottle.js`, ~10 fps) with a **cheap plain-text preview** (capped tail, no markdown/highlight per token); the full formatted result still renders once when the turn ends. The UI thread stays responsive throughout.
- **Repo map rebuilt synchronously every turn (secondary cause).** `buildRepoMap` did a synchronous whole-tree walk + 25 file reads in the main process on every execution turn, briefly freezing the whole app each turn. It's now **cached** (keyed by project root + boost terms, 10 s TTL) and **invalidated on file writes/edits/deletes**, so within a step the walk runs once instead of every turn.

Coding-capability **Tier 1** from the audit (`docs/CODING_CAPABILITY_AUDIT.md`) — the changes that most move Build Mode toward production-grade reliability on a small local model. New regression tests in `tests/codingTier1.test.js`; the suite is now 54.

### Fixed — the model no longer edits blind (`contextBuilder.js`)
- **Line numbers on every injected file** so the model can locate code precisely and build accurate `edit_file` find-blocks (the prompt tells it not to copy the `N⇥` prefix into edits).
- **No more silent middle-of-file truncation.** Oversized files show a contiguous numbered head plus an explicit `[lines X–Y omitted — use read_file…]` notice, instead of head+tail (which dropped the edited region while looking complete).
- **Honest token budget.** Estimate tightened from 3.5→2.5 chars/token (code tokenizes denser), exact-string accounting (was undercounting), and a hard fit-check that trims from the end until the prompt fits `num_ctx` but **never** drops message 0 (the plan digest). Stops the server silently front-truncating the protected digest.

### Fixed — "verified" is no longer a false signal (`lib/verificationHarness.js`, `main.js`)
- **Per-language syntax checks**, gated on the checker being installed (a missing tool is a *skip*, not a pass): Python (`py_compile`), TypeScript (`tsc`, syntax-error-only to avoid false module-resolution failures), Go (`gofmt -e`), Ruby (`ruby -c`), PHP (`php -l`), plus the existing JS/JSON.
- **Honest unverified state.** When nothing real could be checked (no test/lint command and an unsupported/uncheckable language), the step is reported **`[UNVERIFIED]`** and **not** stamped `[verified]` — it's still allowed through (can't gate on an impossible check), but it never claims verification it didn't do.

### Fixed — edits don't silently corrupt on Windows (`editEngine.js`, `lib/editFormats.js`)
- **CRLF + BOM preserved.** Edits normalize line endings/BOM for matching (so an LF find-block matches a CRLF file) and restore the file's original EOL/BOM on write — previously every tolerant edit silently rewrote CRLF→LF.
- **Tolerant match window scales to the find block**, so a find of more than 40 lines can match (was a hard 40-line cap).

### Fixed — agent loop & tools (`agentLoop.js`)
- **No more silently-dropped tool calls.** The per-turn cap is raised 4→8 and, if the model emitted more, it's told exactly how many didn't run (prevents state drift where the model believes an un-executed write happened).
- **Empty-`write_file` guard** rejects a mis-keyed argument that would write an empty file over real content (data loss).
- **Shell-aware.** The system prompt and `run_shell_command` description state the real shell (PowerShell on Windows, bash elsewhere); the bash-only `sudo` rewrite no longer runs on Windows.
- **Coding doctrine prompt.** Replaced the "fire a tool every turn" wall with real guidance: read before edit, prefer small targeted diffs, complete code (no placeholders), match style, run/verify before `mark_step_done`.

### Fixed — memory (`memory.js`)
- **Relevance floor** on vector retrieval (default 0.35, `XK_MEM_MIN_SIM`) so low-similarity snippets aren't injected as authoritative "facts".

## [42.0.0] - 2026-06-04

A **plugin system** on the level of leading coding agents': third-party folders that extend the agent with **tools**, **slash commands**, and **lifecycle hooks** — without editing core files. Plugins are trusted local code loaded in the main process, installable from a Git/URL, and declare the host capabilities they need so you consent before enabling. New engines are unit-tested (`tests/pluginSystem.test.js`); the suite is now 43 tests. Full design in `docs/superpowers/specs/2026-06-04-plugin-system-design.md`; authoring guide in `docs/PLUGINS.md`.

### Added
- **Plugin bundle format** (Approach A — industry-standard bundle style): a plugin is a folder with a `plugin.json` manifest plus convention subfolders `tools/`, `commands/`, `hooks/` (one contribution per file; auto-discovered, or listed explicitly via `contributes`). See `examples/plugins/hello` for a working tool + command + hook.
- **`lib/pluginManager.js`**: discovers/validates/loads plugins under `<userData>/plugins/`, holds the registry, persists enable + granted-capability state (`plugins.json`), routes tool/command/hook invocations, and **quarantines** a broken plugin (bad manifest, throwing module) so one bad plugin never breaks startup or the agent.
- **`lib/pluginHost.js`**: the capability-gated `host` facade handed to plugin code — `fs` (project-sandboxed), `shell`, `net` (netGuard-filtered), `memory`, `ui`, `log`. A capability you didn't declare is simply absent from `host`.
- **`lib/pluginInstaller.js`**: install from a Git/URL — host block-check via netGuard, then `git clone --depth 1` (or a GitHub-tarball download + system `tar` fallback) into a traversal-safe staging dir, manifest validation, then move into `plugins/<id>`.
- **Capability consent**: enabling a plugin shows the capabilities it requests and asks you to confirm; the host enforces only-granted caps at call time. (Honest boundary: plugins are trusted code — capabilities are transparency + defence-in-depth for honest plugins, **not** a sandbox against hostile code.)
- **Tools merge at runtime**: enabled plugin tool schemas are merged into the Build-Mode execution `tools:` array (`agentLoop.loadPluginContext` → `ctx.pluginTools`); a single generic `plugin-invoke-tool` IPC channel routes calls (no per-tool wiring). Plugin tool names are also recognised by the small-model text tool-call fallback. A tool name that collides with a core tool (or another enabled plugin) disables the offending plugin and flags it in the UI.
- **Lifecycle hooks**: `beforeToolCall`, `afterToolCall`, `onPlanApproved`, `onPlanDone`, `onMessageSend`. A `beforeToolCall` hook may veto a tool call (becomes a synthetic tool result); hook failures are logged and swallowed so a broken hook can't wedge the agent.
- **Slash commands**: typing `/<name> args` in the input expands to a plugin command's prompt template (`{{args}}`) or handler output.
- **Plugins UI** (sidebar 🧩 PLUGINS, desktop only — hidden in web mode): install-from-URL, per-plugin enable/disable with capability-consent dialog, uninstall, and surfaced `host.ui.notify` messages.
- **`lib/netGuard.js`**: new `validatePublicFetchTarget` — allows public http(s) hosts (for plugin `net` + installer downloads) while still blocking cloud-metadata / link-local / ULA hosts. Unit-tested.

## [41.3.0] - 2026-06-02

Build Mode (the durable coding agent) reliability + pro-level coding pass. No UI/markup
changes — all fixes are in the engine logic (`agentLoop.js`, `contextBuilder.js`,
`editEngine`/`editFormats`, `verificationHarness`, `planStore`, `main.js`) and renderer
wiring. A regression suite was added (`tests/agent-loop.test.js`); the full suite is now 27 tests.

### Fixed
- **Read-only / verify steps could never complete**: `run_verify` replaced the in-memory plan with the on-disk copy and wiped the per-step activity counter, so the following `mark_step_done` falsely tripped the "you haven't done any work" guard rail and the step never advanced. The activity counter is now preserved across every disk/verify sync (one shared helper, used in all three sync points).
- **Multi-step builds silently stalled**: the execution turn budget was the chat "Thinking Steps" slider (default 20) and counted every model turn, so any plan larger than a few steps ran out of turns and froze on the current step with no message. The budget now scales to the plan size (per-step allowance, the slider acts as a floor), and the agent posts a clear "reached the turn budget — paused, use Resume" notice instead of freezing.
- **`apply_edits` (batch edits) weren't tracked**: files changed via a batch edit weren't recorded on the plan, so they dropped out of context and change tracking. They're now recorded (filesTouched + ledger) and persisted like `edit_file`/`apply_patch`, on both the renderer and main-process sides.
- **BUILD MODE toggle could strand a run**: toggling build mode off mid-task hid the approve/revert controls (they live inside the build-mode panel). The toggle is now locked while a task is planning/approving/executing/under review.
- **Resuming an unapproved plan did nothing**: a resumed plan still `awaiting_approval` now runs the approval gate first instead of entering the execution loop (which only runs while `executing`) and silently returning.
- **BUILD MODE silently degraded to chat** if the plan engine failed to load; it now reports the failure instead of quietly answering as plain chat.
- **Stale agent context leak**: the per-run agent context is now cleared after a fresh build task (previously only the resume path cleaned up).

### Improved (pro-level coding)
- **No more blind edits**: a file the agent is actively editing is now shown in full when it fits the context budget, instead of being head/tail-truncated with the middle elided. The file section also gets a larger share of the prompt.
- **More reliable edits**: whitespace-tolerant search/replace now refuses ambiguous matches (instead of silently editing the first, possibly wrong, location), and unified-diff patches use the hunk's line number to anchor a repeated context/target line to the intended occurrence.
- **A real verification gate by default**: when a project has no test/lint command, verification now syntax-checks the files the step touched (JS via `node --check`, JSON via parse), so a step can't be marked complete with broken syntax.
- **Errors no longer truncated away**: long tool output (e.g. a failing test run) now preserves its tail, so the failing assertion / stack trace at the end survives.
- **Deeper working memory**: the agent retains more recent turns for continuity within a step.
- **Fewer false "infinite loop" stalls**: a single deliberate repeat of a tool call (e.g. re-running tests to recheck) is allowed rather than immediately flagged.
- **Per-step git checkpoints**: a commit is now made after each completed step (not only at the very end), so progress is recoverable mid-build.
- **Clear mode precedence**: BUILD MODE is now mutually exclusive with the Netrunner / Offline-Browser / Agent toggles, preventing those prompt-rewriting modes from leaking into a build goal.

## [41.2.1] - 2026-06-01

### Fixed
- **Massive Artifact Bloat**: Identified and resolved an issue where old `.AppImage` and `.deb` binaries from v40.7.0 were left in the project root directory. Electron-builder was recursively bundling these old 3GB+ artifacts into every new build. The workspace has been cleaned up, reducing the final application size drastically.

## [41.2.0] - 2026-06-01

### Fixed
- **Planner Render Stalls**: Resolved an issue where the agent completion of tasks would not properly trigger a DOM refresh in the sidebar, causing the UI to perpetually display Step 1. The planner now forcibly triggers an onStepAdvance UI rendering cycle every time the execution state synchronizes with the disk.
- **Explicit Task Completion**: The agent now posts a highly visible completion message in the chat feed (All Plan Steps Completed!) when it has finished all tasks in the planner, ensuring you know exactly when the full build is done.

## [41.1.0] - 2026-06-01

### Fixed
- **Planner Visual UI Desync Fix**: Resolved a critical state corruption issue inside `agentLoop.js` that caused the planner UI to visually freeze on Step 1 while the agent silently executed future steps. The agent-verification logic was incorrectly utilizing `Object.assign` without properly re-fetching array references, causing older array elements to be updated instead of the active tracking plan array. The planner UI will now reliably show the exact active step as it completes.

## [40.9.1] - 2026-06-01

### Fixed
- **Agent Progression Stall**: Fixed a critical execution loop bug where the frontend step activityCount was being wiped out by the backend plan sync at the end of every turn. This caused the agent to fail the mark_step_done guardrail repeatedly, preventing it from advancing past Phase 1 and eventually stalling out.
- **Defensive Step ID Handling**: Added fallback logic to prevent the planner from incorrectly reporting [BLOCKED step null] if an execution step is orphaned.

## [40.9.0] - 2026-06-01

### Fixed
- **Planner Sidebar Sync Bug**: Fixed a critical bug in planStore.js where approving a plan would incorrectly mark both step 1 and step 2 as active, causing the agent to skip the first step and the sidebar UI to permanently show multiple active tasks. The state is now cleanly synchronized, and the active task indicator accurately follows the agent progress.

## [40.8.0] - 2026-06-01

### Fixed
- **Planner Step Tracking**: Fixed a bug where the planner model would lose track of the agent's current progress during re-planning. The current plan digest is now correctly injected into the planning context, allowing the planner to see completed steps and the active focus.
- **Current Step Enforcement**: Enhanced the execution context to explicitly demand focus on the current step, reducing step jumping and repetition.

## [40.7.0] - 2026-06-01

### Fixed
- **Local Model Text Stalls**: Removed the overly-strict "GROUNDING" and "REASONING" text-prefix requirements from the Build Mode context builder. Forcing local models (via LM Studio) to output paragraphs of text *before* attempting a tool call was breaking their JSON tool-generation grammars, causing the `write_file` loop to stall endlessly with pure text responses like `<|channel>thought <channel|>`.
- **Code Completeness Rule**: Added a new strict directive demanding the agent output the *complete* file contents without using placeholders or comments like `// I'll fix this later`, which resolves the "lazy coding" issue during large logic tasks.

## [40.6.0] - 2026-06-01

### Fixed
- **Clean Application Build**: Removed unused CLI tools (`xagent-cli`, `build_deb.sh`) that caused conflicts during compilation. Generating `.deb` and `.AppImage` is now fully handled cleanly via `electron-builder`.
- **Infinite Loop Preventer (`agentLoop.js`)**: Implemented a hard signature check in the Build Mode execution loop. If the model fails a task and attempts to execute the exact same tool call sequence again, it is immediately caught and nudged.
- **Endless Exploration Loop (`agentLoop.js`)**: Re-anchored the loop progress checker so that if the model explores endlessly without writing to files or marking the step done, the step is automatically blocked.

## [40.4.0] - 2026-05-31

### Fixed
- **Hallucination Stalls Resolved (`agentLoop.js`)**: Fixed a critical bug where the agent would enter an endless hallucination loop if it failed to output a tool call during a long generation task. The system now injects a hard, authoritative prompt demanding a tool call, completely eliminating the "silent text-only" stalling bug.
- **True Live Chat Injection (`renderer.js` & `agentLoop.js`)**: In v40.3, user hints were appended to the chat history but weren't aggressively injected into the active execution timeline. Now, when you submit text while the agent is running, your hint is placed immediately before the AI's next internal generation tick, ensuring instant compliance and preventing the agent from "getting lost" when you manually push it to continue.

## [40.3.1] - 2026-05-31

### Fixed
- **UI Locking Syntax Error**: Resolved a syntax error in `renderer.js` that broke the main UI initialization loop, causing the application to fail to render the sign-in screen and preventing user authentication.

## [40.3.0] - 2026-05-31

### Added
- **Unlocked UI (`renderer.js`)**: The text input field is no longer disabled during agent plan execution or while awaiting approval.
- **Live Chat Injection**: Submitting text while the agent is actively executing a step or generating a plan no longer restarts or aborts the task. Instead, the message is seamlessly injected into the active `chatHistory` as a "User Hint" and is automatically appended to the agent's context on its very next iteration. This perfectly resolves the issue where the agent asks a question mid-task but the user was locked out from answering.

## [40.2.0] - 2026-05-31

### Added
- **Conversation Continuity**: preserves chat history and injects recent context into both Planning and Execution phases. No more "ignoring" follow-up instructions when entering Build Mode.
- **Grounding Mandate**: new system-level directives force the agent to verify file states and list required information before taking action.
- **Reasoning-First Execution**: the agent must now state its reasoning before every tool call, significantly reducing hallucinations and improving task transparency.
- **Mandatory Action Guard**: prevents the agent from stalling or outputting excessive conversational filler without taking functional steps.
- **Improved Remote State**: better synchronization of history and session state when using the agent via the Remote WebUI.

## [40.1.0] - 2026-05-30

### Added
- **Here I am Button**: Added a dedicated "📍 Here I am" button to the Build Mode UI allowing users to manually select and set the agent's active workspace directory.

### Fixed
- **Verification Loop Lock**: Upgraded loop-handling to aggressively prompt the model to utilize the `mark_step_done` tool when it attempts to stall or endlessly confirm completion via natural language.

## [39.9.0] - 2026-05-30

### Fixed
- **Build Mode Parity**: Synchronized Build Mode tools (`PLAN_TOOLS`) with standard agent tools (`AGENT_TOOLS`). Added missing functions like `provide_file_download_link`, `send_input`, and unified naming/descriptions for `write_file`, `run_shell_command`, and `list_directory`.
- **System Prompts**: Updated system prompts to correctly reflect version 39.9 and the full list of available tools in Build Mode.

## [39.7.0] - 2026-05-29

### Fixed
- **Build Mode Path Sandbox**: Relaxed the strict `projectRoot` path traversal sandbox. The agent can now successfully write, edit, and read from explicit absolute paths (e.g., `/home/user/Documents/gametime/`) provided by the user, while still strictly blocking malicious relative escapes (e.g., `../../etc/passwd`).

## [39.6.0] - 2026-05-29

### Fixed
- **Build Mode File Mutators**: Handled edge cases where AI agents generated tool calls using alternative JSON keys (like `file`, `path`, `text`, `code`) instead of strict schema parameters (`filepath`, `content`), which prevented file saving and editing during heavy tasks like project scaffolding.

## [39.5.0] - 2026-05-29

### Added
- Released as a consolidated stable version including all features from v50.1.0.
- Enhanced AppImage and .deb packaging.

## [50.1.0] - 2026-05-28

### Fixed — Pro-level reliability audit (esp. small models like Gemma 3n E4B)
- **`apply_patch` data loss (`lib/editFormats.js`)**: `applyUnifiedDiff` discarded every
  line *before* the first matched hunk line, silently corrupting files. Now preserves
  surrounding content and lands leading insertions at their anchor. Regression-tested.
- **Text-based tool-call fallback (`agentLoop.js`)**: small local models (Gemma 3n E4B,
  etc.) often emit tool calls as text/JSON instead of OpenAI-native `tool_calls`, which
  previously stalled the agent loop. Added a tolerant `extractToolCallsFromText`
  (handles `<tool_call>` tags, fenced ```json blocks, `parameters`/`arguments` keys,
  arrays, `tool_calls` wrappers) that only accepts real tool names so prose can't misfire.
- **Iterative planning (`agentLoop.runPlanningPhase`)**: the planner was single-shot —
  if the model ran a discovery tool (grep/read/repo-map) before `submit_plan`, the task
  aborted as `planning_failed`. It now loops, feeding tool results back, until
  `submit_plan` or a turn cap.
- **Orphaned tool messages (`contextBuilder.js`)**: budget trimming / `slice(-N)` of
  recent turns could produce a message array starting with a `role:'tool'` message that
  has no parent `tool_calls`, which strict OpenAI-compatible servers reject (HTTP 400).
  Added `sanitizeTurns` to drop orphaned tool results.
- **Verification cascade (`agentLoop.js`)**: `verifyPolicy: 'block'` ran the full
  lint/test suite before *every* `mark_step_done` and after *every* mutation, so
  intermediate multi-step work (legitimately red) blocked → 3 consecutive blocks failed
  the plan. Verification now hard-gates only the **final** step (or `verifyPolicy:
  'strict'`); mid-build failures are recorded as warnings and auto-verify is skipped to
  cut latency. The model can still call `run_verify` explicitly.
- **Web server path traversal (`main.js`)**: the static file handler did
  `path.join(__dirname, url)` with no containment, and `.js`/`.css`/`.png` paths bypass
  the auth gate — allowing unauthenticated arbitrary file reads by extension
  (`/../../secret.js`). Now decoded and contained within the app directory.
- **SSRF + arbitrary file download hardened (`lib/netGuard.js`, `main.js`,
  `standalone-server.js`)**: `/api/proxy/*` accepted any `x-target-url` (SSRF pivot into
  localhost services / cloud metadata `169.254.169.254`); it now only reaches loopback or
  the configured LLM origin, always blocks metadata/link-local, and strips
  `Authorization`/`Cookie` so the app's session token can't leak to the target.
  `set-lms-url` is validated before it feeds the allowlist. `/download_remote?file=`
  served any absolute path to an authenticated user; it's now confined (symlink-resolved)
  to the project root / app-data / downloads directories. `standalone-server.js`'s
  unauthenticated proxy is now loopback-only (override via `XK_LLM_ORIGIN`). Pure logic in
  `lib/netGuard.js`, unit-tested.
- **Tests**: `tests/durable-modules.test.js` expanded (patch correctness, search/replace
  tolerance, tool-call extraction, turn sanitization, SSRF allowlist, download path
  containment) — **14 passing**; ship-check green.

## [50.0.0] - 2026-05-28

### Added — Full-project coding agent
- **`lib/grepTool.js`**, **`lib/globTool.js`**, **`lib/repoMap.js`**, **`lib/ignoreFilter.js`**: Project search and repo map for large codebases.
- **`lib/editFormats.js`**, **`editEngine.js` v2**: Fuzzy search/replace, `apply_patch`, batch edits, 64KB write cap.
- **`lib/verificationHarness.js`**, **`lib/projectDetector.js`**: Detect test/lint commands; block `mark_step_done` until verified.
- **`lib/gitIntegration.js`**: Git init, per-step commits, undo last agent commit.
- **`lib/activeFileSet.js`**, **`lib/chatSummarizer.js`**, **`lib/planTemplates.js`**: Active file tracking, summarization, greenfield/brownfield step templates.
- **`lib/dualModelRouter.js`**: Planner vs editor model selection for build phases.
- **`agentLoop.js` v2**: Multi-tool turns (up to 4), expanded plan tools, post-mutate verify, git commit on step done.
- **`contextBuilder.js` v2**: Repo map, active files, verify hints in each turn.
- **Plan schema v2**: `testCmd`, `lintCmd`, `verifyPolicy`, `activeFiles`, `verifiedAt` per step.
- **UI**: Planner/editor model selects, plan test/lint fields, git log + undo in review.
- **Tests**: `tests/durable-modules.test.js` via `npm test`.
- **Ship check**: `npm run ship-check` (greenfield/brownfield/ledger scenarios).
- **CLI**: `cli-build.js` headless plan creation; `xagent-cli` reuses root `tools.js`.

### Changed
- **Version** 50.0.0; dependencies `fast-glob`, `ignore`, `diff-match-patch`.
- **`tools.js`**: Aligned with v50 discovery tools; fixed `memory_search` result parsing.

## [40.0.0] - 2026-05-28

### Added — Durable Memory & Planning System
- **`planStore.js`**: Plan object persisted per project (`<userData>/plans/`). Harness-owned step status, results, `filesLedger`, decisions, scratchpad.
- **`contextBuilder.js`**: Rebuilds model messages each turn from plan digest + live file excerpts + recent turns + vector memory (within `ctxSlider` budget).
- **`changeLedger.js`**: Snapshot before write/edit/delete; unified diff; `revertAll()` restores originals and deletes newly created files.
- **`editEngine.js`**: Exact → whitespace-tolerant `edit_file`; structured errors with closest-match hints; integrates with ledger.
- **`projectContext.js`**: Implicit project root (from user text or first file op); path sandbox; `list_project` tree; PowerShell on Windows / bash on Linux.
- **`agentLoop.js`**: Plan → user approval → step-by-step execution → review. Tools: `submit_plan`, `mark_step_done`, `mark_step_blocked`, `edit_file`, `run_command`, etc.
- **Build Mode toggle**: Coding workflow separated from chat. Plan panel, context slider, step tracker, diff/review UI shown only in Build Mode.
- **Agent toggle restored to chat tools**: AGENT (SYS-ACCESS) enables shell/file tools in the conversational loop without triggering plan approval.
- **Context Window slider**: Restored for Build Mode (2048–131072); drives `contextBuilder` token budgeting.
- **Resume banner**: Incomplete plans reload on startup; resume enables Build Mode automatically.
- **Project memory**: Compact task summary written to vector store at build completion (`type: project_memory`).
- **IPC**: `plan-*`, `ledger-*`, `edit-apply`, `project-*`, `agent-list-project` wired through `preload.js` and `main.js`.
- **`test-durable-modules.js`**: Smoke test for ledger, edit engine, and plan state machine.

### Changed
- **Memory model inverted**: Chat transcript is no longer authoritative during builds; Plan JSON on disk is. Fixes mid-task forgetting on long jobs.
- **Line-ranged `read_file`**: Optional `start`/`end` line parameters for large files.
- **`write_file` size cap** (~8KB in build path); large changes go through `edit_file`.
- **Generation cutoff**: No aggressive re-prune on context limit; user-visible message instead of emergency transcript wipe (build path).

### Removed
- **RESOURCE SAVER** toggle and Task Isolation flush (obsolete with durable plan memory).
- **`pruneChatHistory` aggressive logic** (`isDeepLoop`, hardcoded 131072 cap, char-budget nuking) — stub passthrough for chat path only.
- **`memory_purge`** tool from agent schema.
- **Auto-fallback plan**: Casual messages no longer forced into a 3-step plan when the model skips `submit_plan`.

### Fixed
- **`open-external-url`**: Added missing `shell` import from Electron.
- **Build vs chat routing**: "Hello" with Agent on no longer enters plan approval (requires Build Mode).

## [39.4.0] - 2026-05-28

### Removed
- **xagent-cli**: Completely removed the standalone CLI application (`xagent-cli`) and its CLI build scripts to focus entirely on the Electron desktop UI.

## [39.3.0] - 2026-05-28

### Changed
- **Context Slider Removal** *(restored in v40 for Build Mode)*: Removed from general UI in v39.3; v40 adds it back under Build Mode for `contextBuilder` token budgeting.
- **Robust Remote Downloads**: Fixed a UI crash related to binary file downloads by routing download links through Electron's native `shell` module instead of internal DOM navigation.

## [39.2.0] - 2026-05-27

### Changed
- **Ollama UI Removal**: Ollama has been removed as a user-selectable model provider in the sidebar to simplify the interface and focus on LM Studio / OpenAI compatible backends.
- **Persistent Embedding Backend**: Ollama remains the core engine for persistent vector memory and embeddings (all-minilm), ensuring backward compatibility with existing knowledge bases.
- **Forced Uplink Mode**: The application now defaults to LM Studio/OpenAI compatible mode for the primary chat interface.

## [39.1.0] - 2026-05-20

### Added
- **Dynamic System Clock**: The agent now automatically injects the current host date and time into the system prompt right before generation for both LM Studio (OpenAI format) and Ollama payloads. The AI will never assume or hallucinate the current date again.

## [38.2.0] - 2026-05-15

### Added
- **Cloudflare-Ready Download Links**: The agent can now securely serve files directly from the host machine to any remote device via a new `provide_file_download_link` tool.
- **Token-Authenticated Downloads**: Hyperlinks generated by the agent dynamically inherit the active user's session token, ensuring unauthorized access to the `/download_remote` endpoint is strictly blocked.
- **Unified Tool Schema**: Stabilized tool dispatch logic across `renderer.js` and `tools.js` to ensure the AI always has full context of available commands.
- **45% Generation Headroom**: The Context Guard now strictly limits prompt context to 55% of your slider size during loops, guaranteeing a massive 45% (thousands of tokens) dedicated purely to outputting huge code files.
- **In-Flight Wipes**: Intermediate tool outputs are now continuously wiped while the agent is running multi-step tasks, keeping the payload incredibly lean without dropping the original task instruction.
- **Auto-Recovery**: If a massive generation does hit the hard limit, the agent no longer crashes. It forces an emergency memory wipe and prompts the AI to try a chunked strategy.

## [38.1.0] - 2026-05-10

### Added
- **Task-Aware Pruning**: The agent now identifies your original task and formal `task_begin` plans, ensuring they are NEVER pruned even when context is tight.
- **Automatic Resource Guard**: When system RAM or process memory is low, the agent automatically triggers "Task Isolation" mode, flushing intermediate bloat while keeping your goals intact.
- **LM Studio Optimization**: Mathematically bound context payloads prevent "Rolling Window" thrashing and guardrail errors in LM Studio.

## [38.0.0] - 2026-05-05

### Changed
- **Ollama Stability Fixes**: Resolved issues where the agent would "hang" or "think" indefinitely when using Ollama models for complex tasks. This was caused by a missing loop continuation instruction after executing tools, which has now been fixed.
- **Improved Streaming Parser**: The Ollama stream handler now more reliably captures tool calls and content deltas, even with high-latency or high-pressure generation.
- **Resource Defaults**: RESOURCE SAVER is now toggled OFF by default. This ensures the model retains more conversational context for better reasoning, unless the user explicitly chooses to optimize for low VRAM.
- **Enhanced System Directives**: Refined the core system prompt (v38) to be more authoritative with file system and system-level tasks, ensuring the model uses tools immediately without hesitation.

## [37.9.1] - 2026-05-01

### Fixed
- **High-Contrast Chat Bubbles**: Eliminated visual halation (faint text) by redesigning chat bubbles to feature pure black text on light backgrounds, ensuring maximum readability without sacrificing the app's dark theme.
- **History & Agent Logic Restoration**: Fixed the silent agent bug (where the agent ignored prompts due to payload cloning errors) and restored the automated legacy history migration script to safely recover previously wiped chat logs.

## [37.9.0] - 2026-04-28

### Changed
- **Visual Overhaul**: Boosted the contrast, brightness, and font weight of all text in the chat interface. Solved the issue where default text, labels, and system messages appeared faded or "greyed out" against the dark background.

## [37.8] - 2026-04-25

### Fixed
- **Responsive Offline Browsing**: Fixed an issue in the Offline Web Browser where AI-generated websites lacked mobile-responsiveness constraints. The shadow DOM now forcibly injects responsive baseline CSS (like `word-wrap: break-word` and `max-width: 100%`) into all generated pages.

## [37.7] - 2026-04-20

### Fixed
- **Ollama Offline Browser Compatibility**: Ensures full compatibility with the Offline Web Browser mode when using standard Ollama models. Fixes a bug where Ollama's stream payload variations resulted in a blank white Shadow DOM.

## [37.6] - 2026-04-15

### Added
- **Offline Web Browser Mode**: Allows the agent to act as an offline web server. It dynamically generates a complete, professional HTML5/CSS webpage to present information, rendered directly in the chat via a secure Shadow DOM.

## [37.5] - 2026-04-10

### Added
- **Task Isolation (Ultra-Aggressive Pruning)**: When "Resource Saver" is enabled, the agent automatically and fully flushes its internal chat memory every time you send a new request (keeping only your new instruction and the system prompt).

## [37.4] - 2026-04-05

### Added
- **Hallucination Loop Protection**: Eliminates the "endless partial generation" bug. The agent actively monitors the stream's `finish_reason` and halts the autonomous loop if it detects an early cutoff. Uses deep-cache batch pruning to keep prompt evaluation speeds fast.

## [37.3] - 2026-04-01

### Added
- **LM Studio Context Guard**: Fixes extreme task times in LM Studio Mode caused by context window thrashing. Mathematically binds the chat history payload to 75% of your chosen Context Size.

## [37.2] - 2026-03-25

### Added
- **Active Generation Locks**: Fixes mid-task timeouts by completely locking models in VRAM (`keep_alive: -1`) while the agent is executing a multi-turn autonomous loop.

## [37.0] - 2026-03-20

### Added
- **Heavy Context Processing**: Resolves "Model timed out" errors after VRAM purges by implementing a dynamic Time-To-First-Token (TTFT) handler, allowing large models up to 15 minutes to reload.

## [36.4] - 2026-03-15

### Added
- **Predictive Resource Guard**: Multi-layered memory management system including Real-time Resource Monitoring, Adaptive Sliding Window, Visual Health Status, Dynamic History Pruning, and Autonomous Memory Purge.

## [36.2] - 2026-03-10

### Added
- **Secure Authentication**: Built-in security layer including Multi-User Support, Role-Based Access, and Encrypted Credentials (bcrypt).

## [36.0] - 2026-03-05

### Added
- **Asynchronous Background Tasks**: Natively execute, monitor, and interact with heavy system workloads via background processing, log tailing (`read_process_log`), and interactive input (`send_input`).

## [35.0] - 2026-02-28

### Added
- **Cloudflare Remote Access**: Automatic tunnels via `cloudflared` to generate secure, ephemeral URLs, plus a standalone headless server option.

## [34.0] - 2026-02-20

### Added
- **Autonomous "Plan-Execute-Verify" Workflow**: Sophisticated multi-turn autonomous loop using `task_begin` and `task_complete` for complex system tasks and research.

## [31.3] - 2026-02-10

### Added
- **Neuro-Core (Intelligent Persistent Memory)**: Low-VRAM optimization forcing `all-minilm` to run on CPU, zero-swap performance, and strict fact retention using `save_new_user_fact_only`.