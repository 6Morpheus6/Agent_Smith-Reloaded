#!/usr/bin/env node
'use strict';
/**
 * fetch-electron-assets — restore the Electron Depot archives into vendor/ from the manifest.
 *
 * The GitHub source intentionally ships WITHOUT the ~576 MB of depot archives (five Electron
 * runtime zips + three builder toolsets) — the app auto-downloads them on first launch into the
 * user cache instead (src/main/services/electronAssets.js). This script is for developers who
 * want vendor/ fully populated again (offline dev, re-seeding a fresh machine): it reads
 * src/shared/electronAssetsManifest.js and fetches exactly those files, verifying sha256.
 *
 * Usage:
 *   node scripts/fetch-electron-assets.js                 # all missing assets → ./vendor
 *   node scripts/fetch-electron-assets.js --only <name>   # one asset (e.g. 7zip-linux-x64.tar.gz)
 *   node scripts/fetch-electron-assets.js --out <dir>     # different target root (default: repo vendor/)
 *
 * No dependencies — plain https with redirect following, .part temp files, sha256 verification.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');

const { ELECTRON_ASSETS_MANIFEST } = require('../src/shared/electronAssetsManifest.js');

function parseArgs(argv) {
    const args = { only: null, out: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--only') args.only = argv[++i];
        else if (argv[i] === '--out') args.out = argv[++i];
    }
    return args;
}

function fetchUrl(url, destPath, maxRedirects = 8) {
    // Follows 3xx redirects (GitHub release URLs → objects.githubusercontent.com).
    return new Promise((resolve, reject) => {
        const get = (u, depth) => {
            if (depth > maxRedirects) return reject(new Error(`too many redirects for ${url}`));
            https.get(u, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    res.resume();
                    const loc = new URL(res.headers.location, u).toString();
                    return get(loc, depth + 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
                }
                const tmp = `${destPath}.part`;
                const file = fs.createWriteStream(tmp);
                let received = 0;
                res.on('data', (c) => { received += c.length; });
                res.pipe(file);
                file.on('finish', () => file.close(() => resolve({ tmp, received })));
                file.on('error', reject);
            }).on('error', reject);
        };
        get(url, 0);
    });
}

function sha256File(p) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const s = fs.createReadStream(p);
        s.on('data', (c) => h.update(c));
        s.on('end', () => resolve(h.digest('hex')));
        s.on('error', reject);
    });
}

(async () => {
    const args = parseArgs(process.argv.slice(2));
    const root = path.resolve(__dirname, '..', args.out || 'vendor');
    let entries = ELECTRON_ASSETS_MANIFEST;
    if (args.only) {
        entries = entries.filter((e) => e.name === args.only);
        if (!entries.length) { console.error(`no manifest entry named "${args.only}"`); process.exit(1); }
    }

    let ok = 0, skipped = 0;
    for (const entry of entries) {
        // vendor layout: electron-runtime → vendor/electron/<platform>-<arch>/<name>;
        // builder-toolset → vendor/electron-builder/<releaseName>/<name>.
        const relDir = entry.kind === 'electron-runtime'
            ? path.join('electron', `${entry.platform}-${entry.arch}`)
            : path.join('electron-builder', entry.releaseName);
        const dest = path.join(root, relDir, entry.name);

        if (fs.existsSync(dest)) {
            const sum = await sha256File(dest);
            if (sum === entry.sha256) { console.log(`= ${entry.name}  (already present, checksum OK)`); skipped++; continue; }
            console.log(`! ${entry.name}  (present but checksum MISMATCH — re-downloading)`);
        }

        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const total = entry.sizeBytes || 0;
        process.stdout.write(`↓ ${entry.name}${total ? ` (${(total / 1048576).toFixed(1)} MB)` : ''} … `);
        try {
            const { tmp } = await fetchUrl(entry.url, dest);
            const sum = await sha256File(tmp);
            if (sum !== entry.sha256) throw new Error(`sha256 mismatch: got ${sum}`);
            fs.renameSync(tmp, dest);
            console.log('OK');
            ok++;
        } catch (err) {
            try { fs.unlinkSync(`${dest}.part`); } catch (_) {}
            console.error(`FAILED — ${err.message}`);
            process.exitCode = 1;
        }
    }
    console.log(`\nDone: ${ok} downloaded, ${skipped} already present.` +
        (entries.length < ELECTRON_ASSETS_MANIFEST.length ? ` (${ELECTRON_ASSETS_MANIFEST.length - entries.length} not requested.)` : ''));
})().catch((err) => { console.error('fetch-electron-assets failed:', err.message); process.exit(1); });
