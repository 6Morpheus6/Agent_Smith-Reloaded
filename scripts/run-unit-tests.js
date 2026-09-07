#!/usr/bin/env node
/**
 * Unit-test entry — runs a set of test files via the node:test runner with explicit
 * globbing, so it works on Node 20 (no built-in --test glob) and shells in POSIX mode
 * (where an unquoted *.js pattern reaches node as a literal).
 *
 * Usage:
 *   node scripts/run-unit-tests.js                     # all tests/*.test.js
 *   node scripts/run-unit-tests.js tests/harness-security  # that directory's *.test.js
 *   node scripts/run-unit-tests.js "tests/foo.test.js"     # explicit file(s)
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function collect(dir) {
    const abs = path.resolve(root, dir);
    if (!fs.existsSync(abs)) return [];
    if (fs.statSync(abs).isFile()) return [dir];
    return fs.readdirSync(abs)
        .filter(f => f.endsWith('.test.js'))
        .map(f => path.join(dir.replace(/\\/g, '/'), f))
        .sort();
}

const args = process.argv.slice(2);
let files;
if (!args.length) {
    files = collect(path.join('tests'));
} else {
    files = [];
    for (const a of args) {
        if (a.startsWith('-')) continue; // forward flags to node --test
        const got = collect(a);
        if (got.length) files.push(...got);
        else files.push(a); // trust explicit file paths even without .test.js match
    }
}

if (!files.length || !files.some(f => f.endsWith('.test.js'))) {
    console.error('[run-unit-tests] no test files resolved from: ' + (args.join(' ') || '(tests/)'));
    process.exit(1);
}

const extra = args.filter(a => a.startsWith('-'));
execFileSync(process.execPath, ['--test', ...files, ...extra], { stdio: 'inherit', cwd: root });
