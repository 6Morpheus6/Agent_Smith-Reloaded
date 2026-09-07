const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRuntimeProfile, vramTierFromTelemetry, snapCtx } = require('../src/shared/runtimeProfile.js');

test('vramTierFromTelemetry maps memory tiers', () => {
    assert.equal(vramTierFromTelemetry({ memory: { total: 6000 } }), 'low');
    assert.equal(vramTierFromTelemetry({ memory: { total: 12000 } }), 'medium');
    assert.equal(vramTierFromTelemetry({ memory: { total: 20000 } }), 'high');
    assert.equal(vramTierFromTelemetry({ memory: { total: 32000 } }), 'ultra');
    assert.equal(vramTierFromTelemetry(null), 'medium');
});

test('snapCtx rounds to 1024 step within bounds', () => {
    assert.equal(snapCtx(10000), 10240);
    assert.equal(snapCtx(1000), 2048);
});

test('coder + medium VRAM gets higher maxTurns and moderate ctx', () => {
    const p = buildRuntimeProfile({
        modelId: 'qwen2.5-coder-7b-instruct',
        telemetry: { memory: { total: 12288 } }
    });
    assert.equal(p.maxTurns, 50);
    assert.equal(p.codeTemperature, 0.15);
    assert.ok(p.numCtx >= 8192 && p.numCtx <= 24576);
    assert.match(p.summary, /ctx/i);
});

test('general 7B + low VRAM caps context', () => {
    const p = buildRuntimeProfile({
        modelId: 'llama-3.2-7b-instruct',
        telemetry: { memory: { total: 6144 } }
    });
    assert.ok(p.numCtx <= 12288);
    assert.ok(p.warnings.some(w => /coder model/i.test(w)));
});

test('32B + high VRAM scales context down', () => {
    const p = buildRuntimeProfile({
        modelId: 'qwen2.5-32b-instruct',
        telemetry: { memory: { total: 20480 } }
    });
    assert.ok(p.numCtx < 49152);
    assert.equal(p.maxTurns, 35);
});

test('high VRAM pressure downgrades tier', () => {
    const p = buildRuntimeProfile({
        modelId: 'qwen2.5-coder-7b-instruct',
        telemetry: { memory: { total: 20480 }, is_high_pressure: true }
    });
    assert.ok(p.warnings.some(w => /pressure/i.test(w)));
    const calm = buildRuntimeProfile({
        modelId: 'qwen2.5-coder-7b-instruct',
        telemetry: { memory: { total: 20480 } }
    });
    // Strictly smaller: this model/VRAM is above the ctx floor, so the pressure downgrade
    // MUST reduce ctx. `<=` would also pass if the downgrade silently stopped working.
    assert.ok(p.numCtx < calm.numCtx, `pressure must shrink ctx: ${p.numCtx} vs ${calm.numCtx}`);
});
