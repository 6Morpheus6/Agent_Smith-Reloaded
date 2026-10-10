'use strict';
// v55.5 TTS smoke test — drives the REAL IPC handlers against the REAL bundled
// Piper runtime (resources/piper) with real audio playback. Run: node scripts/tts-smoke.js
const path = require('path');
const tts = require('../src/main/lifecycle/tts.js');

const root = path.join(__dirname, '..');
const handlers = {};
tts({ handle: (c, h) => { handlers[c] = h; } }, { resourcesDir: path.join(root, 'resources') });

(async () => {
    const status = await handlers['tts-status']({}, undefined);
    console.log('STATUS:', JSON.stringify(status));
    if (!status.ok) { console.error('SMOKE FAIL: engine not ok'); process.exit(1); }

    const t0 = Date.now();
    const res = await handlers['tts-speak']({}, 'Agent Smith audio is operational. The speak responses toggle now works.');
    console.log('SPEAK:', JSON.stringify(res), 'elapsed_ms=' + (Date.now() - t0));
    if (!res.success) { console.error('SMOKE FAIL: speak did not succeed'); process.exit(1); }

    // Empty-text contract.
    const empty = await handlers['tts-speak']({}, '   ');
    console.log('EMPTY:', JSON.stringify(empty));
    console.log('SMOKE OK — Piper synthesized and played the test phrase.');
})().catch(err => { console.error('SMOKE FAIL:', err); process.exit(1); });
