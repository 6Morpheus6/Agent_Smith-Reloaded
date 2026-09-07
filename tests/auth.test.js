/**
 * AuthManager — the "first account becomes admin" guarantee and its self-heal, so the
 * app can never lock everyone out with an unapprovable account.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AuthManager = require('../src/main/services/auth.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-smith-auth-')); }

test('first account becomes admin and can log in immediately', async () => {
    const auth = new AuthManager(tmp());
    await auth.register('alice', 'pw');
    const token = await auth.login('alice', 'pw'); // must NOT throw "pending approval"
    assert.equal(typeof token, 'string');
    assert.equal(auth.verifyToken(token).role, 'admin');
    assert.equal(auth.verifyToken(token).permissions.canUseApp, true);
});

test('second account is a standard user, pending approval until an admin enables it', async () => {
    const auth = new AuthManager(tmp());
    await auth.register('alice', 'pw');   // admin
    await auth.register('bob', 'pw');     // standard
    await assert.rejects(() => auth.login('bob', 'pw'), /pending admin approval/i);
    // admin can approve, then bob gets in
    auth.updateUserPermissions('alice', 'bob', { canUseApp: true });
    assert.equal(typeof await auth.login('bob', 'pw'), 'string');
});

test('SELF-HEAL: with a stale users file that has NO usable admin, the next signup is promoted', async () => {
    const dir = tmp();
    // Simulate the lockout: a users_v32.json whose only account is a denied standard user
    // (the exact state that made every new account "pending approval" with nobody to approve).
    fs.writeFileSync(path.join(dir, 'users_v32.json'), JSON.stringify({
        ghost: { password: 'x', role: 'user', permissions: { canUseApp: false, canUseTools: false } }
    }));
    const auth = new AuthManager(dir);
    assert.equal(auth.hasUsableAdmin(), false, 'precondition: no usable admin exists');

    await auth.register('rescuer', 'pw');
    const token = await auth.login('rescuer', 'pw'); // must succeed, not "pending approval"
    assert.equal(auth.verifyToken(token).role, 'admin', 'next signup self-heals to admin when locked out');
});

test('legacy/hand-edited user records (no permissions) are normalized, not crashed on', async () => {
    const dir = tmp();
    // An old record with a role but no `permissions` object — accessing user.permissions.x
    // used to throw (and hang the web request handler).
    fs.writeFileSync(path.join(dir, 'users_v32.json'), JSON.stringify({
        legacyadmin: { password: 'x', role: 'admin' },
        legacyuser: { password: 'y', role: 'user' }
    }));
    const auth = new AuthManager(dir);
    const admin = auth.verifyToken('nope'); // just exercise the records are well-formed now
    assert.equal(admin, null);
    // admin record normalized to usable; a standard record normalized to denied.
    assert.equal(auth.users.legacyadmin.permissions.canUseApp, true);
    assert.equal(auth.users.legacyuser.permissions.canUseApp, false);
    assert.equal(auth.hasUsableAdmin(), true, 'a normalized admin counts as usable');
});

test('admin-only operations reject non-admins and missing targets', async () => {
    const auth = new AuthManager(tmp());
    await auth.register('alice', 'pw');  // admin
    await auth.register('bob', 'pw');    // standard user
    assert.throws(() => auth.getAllUsers('bob'), /unauthorized/i, 'non-admin cannot list users');
    assert.throws(() => auth.updateUserPermissions('bob', 'alice', { canUseApp: true }), /unauthorized/i,
        'non-admin cannot change permissions');
    assert.throws(() => auth.updateUserPermissions('alice', 'ghost', { canUseApp: true }), /not found/i,
        'admin updating a non-existent user errors');
    // admin CAN list and update
    assert.ok(Array.isArray(auth.getAllUsers('alice')));
    assert.equal(auth.updateUserPermissions('alice', 'bob', { canUseApp: true }), true);
});

test('login surfaces the real reasons (bad password vs unknown user)', async () => {
    const auth = new AuthManager(tmp());
    await auth.register('alice', 'pw');
    await assert.rejects(() => auth.login('alice', 'wrong'), /invalid username or password/i);
    await assert.rejects(() => auth.login('nobody', 'pw'), /invalid username or password/i);
});

// --- v52.1: session persistence (phone tokens must survive an app restart) ----

test('v52.1 REGRESSION: a logged-in token survives an AuthManager restart (the image-gen "unauthorized" bug)', async () => {
    const dir = tmp();
    const auth1 = new AuthManager(dir);
    await auth1.register('alice', 'pw');
    const token = await auth1.login('alice', 'pw');
    assert.equal(auth1.verifyToken(token).username, 'alice');

    // Simulate the desktop app restarting: a brand-new instance over the same userData dir.
    // In v52 this returned null (in-memory Map was gone) → every /api/invoke from the phone
    // 401'd, including imagegen-set-enabled — the "unauthorized" on the 🎨 IMG toggle.
    const auth2 = new AuthManager(dir);
    const user = auth2.verifyToken(token);
    assert.ok(user, 'token must still verify after restart');
    assert.equal(user.username, 'alice');
    assert.equal(user.role, 'admin');
});

test('v52.1: expired sessions are rejected and pruned from the persisted file', async () => {
    const dir = tmp();
    const auth = new AuthManager(dir);
    await auth.register('alice', 'pw');
    const token = await auth.login('alice', 'pw');
    // Force expiry (the sliding window would otherwise keep it alive).
    auth.sessions.get(token).expires = Date.now() - 1000;
    assert.equal(auth.verifyToken(token), null, 'expired token must not verify');
    auth.flushSessions();

    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'));
    assert.ok(!raw[token], 'expired entry is pruned from disk');

    // A fresh instance (restart) also sees nothing.
    const auth2 = new AuthManager(dir);
    assert.equal(auth2.verifyToken(token), null);
});

test('v52.1: logout removes the persisted token immediately', async () => {
    const dir = tmp();
    const auth = new AuthManager(dir);
    await auth.register('alice', 'pw');
    const token = await auth.login('alice', 'pw');
    assert.ok(auth.verifyToken(token));

    auth.logout(token);
    assert.equal(auth.verifyToken(token), null, 'logged-out token must not verify in-process');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'));
    assert.ok(!raw[token], 'logout is written to disk immediately (no debounce)');

    const auth2 = new AuthManager(dir); // restart
    assert.equal(auth2.verifyToken(token), null, 'logged-out token stays dead across restarts');
});

test('v52.1: persisted entries for deleted/unknown users are dropped on load', async () => {
    const dir = tmp();
    const auth = new AuthManager(dir);
    await auth.register('alice', 'pw');
    const token = await auth.login('alice', 'pw');
    auth.flushSessions();

    // Hand-edit the sessions file to reference a user that no longer exists (e.g. users
    // file was reset) — loading must drop it instead of handing out a ghost session.
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'));
    raw['deadbeef'.repeat(8)] = { username: 'ghost', expires: Date.now() + 1000 };
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(raw));

    const auth2 = new AuthManager(dir);
    assert.equal(auth2.verifyToken('deadbeef'.repeat(8)), null, 'ghost entry must not verify');
    assert.ok(auth2.sessions.has(token), 'the live session survives the prune');
});
