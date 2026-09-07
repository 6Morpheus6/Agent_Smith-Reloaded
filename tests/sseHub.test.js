'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createSseHub } = require('../src/main/server/sseHub.js');

function mockRes() {
    const chunks = [];
    const res = new EventEmitter();
    res.writeHead = () => {};
    res.write = (c) => { chunks.push(String(c)); return true; };
    res.chunks = chunks;
    return res;
}

test('sseHub addClient sends connected comment', () => {
    const hub = createSseHub();
    const res = mockRes();
    hub.addClient(res);
    assert.ok(res.chunks.some(c => c.includes(': connected')));
    assert.equal(hub.clientCount(), 1);
});

test('sseHub broadcast writes SSE frame for whitelisted channel', () => {
    const hub = createSseHub();
    const res = mockRes();
    hub.addClient(res);
    hub.broadcast('code-event', { type: 'turn_start', turn: 1 });
    const body = res.chunks.join('');
    assert.match(body, /event: code-event/);
    assert.match(body, /"turn":1/);
});

test('sseHub ignores unknown channels', () => {
    const hub = createSseHub();
    const res = mockRes();
    hub.addClient(res);
    const before = res.chunks.length;
    hub.broadcast('not-a-real-channel', { x: 1 });
    assert.equal(res.chunks.length, before);
});

test('sseHub removes client on close', () => {
    const hub = createSseHub();
    const res = mockRes();
    hub.addClient(res);
    res.emit('close');
    assert.equal(hub.clientCount(), 0);
});
