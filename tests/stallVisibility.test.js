// Stall visibility + timeout policy: a stalled/retrying turn must render a timeline row (not a
// blank bar), and the FIRST token gets a more generous window than between-token gaps so a heavy
// single write_file (large context) is not killed as a false "stall".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// ---- Part A: timeline renders stream_retry / reasoning_truncated ----
function fakeEl() {
    const el = {
        className: '', textContent: '', style: {}, children: [], parentNode: null,
        appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
        insertBefore(c) { c.parentNode = el; el.children.unshift(c); return c; },
        addEventListener() {}, setAttribute() {}, scrollTo() {}, scrollTop: 0, scrollHeight: 0,
        querySelector() { return null; }, querySelectorAll() { return []; }, remove() {}
    };
    return el;
}

test('stream_retry and reasoning_truncated render as timeline rows (no blank turn)', () => {
    global.document = { createElement: () => fakeEl(), getElementById: () => fakeEl(), createTextNode: (t) => ({ textContent: t }) };
    global.window = { XKEventAdapter: { adaptCodeEvent: () => null }, XKScrollFollow: { get: () => null } };
    delete require.cache[require.resolve('../src/renderer/timeline/activityTimeline.js')];
    const tl = require('../src/renderer/timeline/activityTimeline.js');

    const container = fakeEl();
    const inst = tl.mount(container, {});
    inst.handleCodeEvent({ type: 'stream_retry', turn: 3, attempt: 1, message: 'Model stalled mid-reply — retrying (1/4).' });
    inst.handleCodeEvent({ type: 'reasoning_truncated', turn: 3, message: 'Model used the entire reply budget reasoning with no output — retrying.' });

    const text = container.children.map(c => c.textContent).join(' | ');
    assert.match(text, /stalled.*retrying/i, 'stall retry row rendered');
    assert.match(text, /reasoning with no output/i, 'reasoning-truncated row rendered');
    assert.ok(container.children.length >= 2);
});

// ---- Part B: first-token timeout window ----
const { streamCompletion } = require('../src/code/loop/streamCompletion.js');

function mockLmStudio(delayFirstMs) {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        setTimeout(() => {
            res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
        }, delayFirstMs);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

test('the first-token window tolerates a slow first byte', async () => {
    const { server, port } = await mockLmStudio(150);
    const r = await streamCompletion({
        apiBaseUrl: `http://127.0.0.1:${port}`, model: 'm', messages: [{ role: 'user', content: 'hi' }],
        onDelta: () => {}, firstTokenTimeoutMs: 500, inactivityTimeoutMs: 40
    });
    assert.match(r.message.content, /hello/);
    server.close();
});

test('a first token slower than the first-token window is reported as a stall', async () => {
    const { server, port } = await mockLmStudio(200);
    await assert.rejects(
        () => streamCompletion({
            apiBaseUrl: `http://127.0.0.1:${port}`, model: 'm', messages: [{ role: 'user', content: 'hi' }],
            onDelta: () => {}, firstTokenTimeoutMs: 60, inactivityTimeoutMs: 40
        }),
        /stalled/i
    );
    server.close();
});
