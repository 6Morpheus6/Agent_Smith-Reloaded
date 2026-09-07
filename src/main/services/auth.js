const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Sessions persist to disk so a phone/web client's token survives an app restart.
// In-memory-only sessions (the v52 bug) meant every desktop update/crash killed the
// LAN session: the next /api/invoke from the phone — including imagegen-set-enabled,
// which is what made the 🎨 IMG toggle report "unauthorized" — got a 401. Tokens are
// 256-bit random hex (unguessable); they expire after SESSION_TTL_MS of inactivity
// (verifyToken refreshes on every use), so a lost phone can't hold a session forever.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

class AuthManager {
    constructor(userDataPath) {
        this.usersFile = path.join(userDataPath, 'users_v32.json');
        this.sessionsFile = path.join(userDataPath, 'sessions.json');
        this.sessions = new Map(); // token -> { username, expires }
        this.users = this.loadUsers();
        this.loadSessions();
    }

    loadUsers() {
        if (fs.existsSync(this.usersFile)) {
            try {
                const users = JSON.parse(fs.readFileSync(this.usersFile, 'utf8'));
                // Normalize legacy/hand-edited records so downstream `user.permissions.x`
                // access can never throw (which would hang the web request handler).
                for (const u of Object.values(users || {})) {
                    if (u && typeof u === 'object' && (!u.permissions || typeof u.permissions !== 'object')) {
                        u.permissions = { canUseApp: u.role === 'admin', canUseTools: u.role === 'admin' };
                    }
                }
                return users || {};
            } catch (e) {
                console.error('Failed to load users:', e);
                return {};
            }
        }
        return {};
    }

    saveUsers() {
        // Throw on failure so a non-writable userData dir surfaces as a real error
        // instead of silently "creating" an account that vanishes on next launch.
        try {
            fs.writeFileSync(this.usersFile, JSON.stringify(this.users, null, 2));
        } catch (e) {
            console.error('Failed to save users:', e);
            throw new Error(`Could not save account (${e.code || e.message}). Check write permissions for ${this.usersFile}`);
        }
    }

    // --- session persistence -------------------------------------------------
    // Best-effort: a non-writable dir must never break login (the in-memory map
    // still works for the life of this process), so failures are logged, not thrown.
    loadSessions() {
        try {
            if (!fs.existsSync(this.sessionsFile)) return;
            const raw = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
            const now = Date.now();
            let dropped = 0;
            for (const [token, rec] of Object.entries(raw || {})) {
                if (!rec || typeof rec.username !== 'string' || !this.users[rec.username]) { dropped++; continue; }
                const expires = Number(rec.expires) > now ? Number(rec.expires) : now + SESSION_TTL_MS;
                this.sessions.set(token, { username: rec.username, expires });
            }
            if (dropped) this.saveSessions(); // prune dead entries from the file
        } catch (e) {
            console.error('Failed to load sessions:', e.message);
        }
    }

    saveSessions() {
        try {
            const obj = {};
            for (const [token, rec] of this.sessions.entries()) obj[token] = rec;
            fs.writeFileSync(this.sessionsFile, JSON.stringify(obj));
        } catch (e) {
            console.error('Failed to persist sessions:', e.message);
        }
    }

    // verifyToken runs on EVERY web request and refreshes the sliding expiry each
    // time — writing the file per call would churn disk under load. Coalesce: mark
    // dirty, flush once after 250 ms of quiet (and again hard at process exit).
    markSessionsDirty() {
        if (this._sessionSaveTimer) return;
        this._sessionSaveTimer = setTimeout(() => {
            this._sessionSaveTimer = null;
            this.saveSessions();
        }, 250);
        if (typeof this._sessionSaveTimer.unref === 'function') this._sessionSaveTimer.unref();
    }

    flushSessions() {
        if (this._sessionSaveTimer) { clearTimeout(this._sessionSaveTimer); this._sessionSaveTimer = null; }
        this.saveSessions();
    }

    /** True when at least one account can actually get in (admin + canUseApp). */
    hasUsableAdmin() {
        return Object.values(this.users).some(
            u => u.role === 'admin' && u.permissions && u.permissions.canUseApp
        );
    }

    async register(username, password) {
        if (this.users[username]) {
            throw new Error('User already exists');
        }
        // The first account is always the admin. Also self-heal a locked-out state:
        // if no usable admin exists (e.g. a stale users file with only non-admin
        // entries), promote the next account to admin so the app can never become
        // permanently unreachable.
        const isFirst = Object.keys(this.users).length === 0;
        const makeAdmin = isFirst || !this.hasUsableAdmin();
        const hashedPassword = await bcrypt.hash(password, 10);
        this.users[username] = {
            password: hashedPassword,
            role: makeAdmin ? 'admin' : 'user',
            permissions: {
                canUseApp: makeAdmin,   // standard (non-first) users start denied
                canUseTools: makeAdmin  // only an admin gets tools by default
            }
        };
        this.saveUsers();
        return true;
    }

    async login(username, password) {
        const user = this.users[username];
        if (!user) {
            throw new Error('Invalid username or password');
        }
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            throw new Error('Invalid username or password');
        }
        if (!user.permissions.canUseApp) {
            throw new Error('Account pending admin approval');
        }
        const token = crypto.randomBytes(32).toString('hex');
        this.sessions.set(token, { username, expires: Date.now() + SESSION_TTL_MS });
        this.saveSessions();
        return token;
    }

    verifyToken(token) {
        if (!token) return null;
        const rec = this.sessions.get(String(token));
        if (!rec) return null;
        // Sliding expiry: any verified use refreshes the window, so an actively used
        // phone session never dies mid-conversation while an abandoned one lapses.
        if (Date.now() > rec.expires) {
            this.sessions.delete(String(token));
            this.markSessionsDirty();
            return null;
        }
        const user = this.users[rec.username];
        if (!user) {
            this.sessions.delete(String(token));
            this.markSessionsDirty();
            return null;
        }
        rec.expires = Date.now() + SESSION_TTL_MS;
        this.markSessionsDirty();
        return { username: rec.username, role: user.role, permissions: user.permissions };
    }

    logout(token) {
        if (token && this.sessions.delete(String(token))) this.saveSessions(); // immediate — the token must die now
    }
    
    hasUsers() {
        return Object.keys(this.users).length > 0;
    }

    getAllUsers(requesterUsername) {
        const requester = this.users[requesterUsername];
        if (!requester || requester.role !== 'admin') throw new Error('Unauthorized');
        
        const userList = [];
        for (const [uname, data] of Object.entries(this.users)) {
            userList.push({
                username: uname,
                role: data.role,
                permissions: data.permissions
            });
        }
        return userList;
    }

    updateUserPermissions(requesterUsername, targetUsername, permissions) {
        const requester = this.users[requesterUsername];
        if (!requester || requester.role !== 'admin') throw new Error('Unauthorized');
        if (!this.users[targetUsername]) throw new Error('User not found');
        
        this.users[targetUsername].permissions = { 
            ...this.users[targetUsername].permissions, 
            ...permissions 
        };
        this.saveUsers();
        return true;
    }
}

module.exports = AuthManager;
