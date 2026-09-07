const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSymbolMap, extractSymbols, scoreSymbol } = require('../src/code/context/symbolMap.js');

test('extractSymbols finds JS functions, classes, arrow consts, exports', () => {
    const code = `
export function fetchUser(id) {}
class AuthHandler {}
const validateToken = (t) => t.length > 0;
export const ROUTES = {};
function _private() {}
`;
    const syms = extractSymbols(code, '.js');
    assert.ok(syms.includes('fetchUser'));
    assert.ok(syms.includes('AuthHandler'));
    assert.ok(syms.includes('validateToken'));
    assert.ok(syms.includes('_private'));
});

test('extractSymbols handles Python def/class', () => {
    const syms = extractSymbols('def parse_args():\n    pass\nclass Server:\n    pass\n', '.py');
    assert.deepEqual(syms.sort(), ['Server', 'parse_args']);
});

test('scoreSymbol boosts entrypoint files + descriptive names, deboosts private', () => {
    assert.ok(scoreSymbol('handleRequest', 'src/index.js') > scoreSymbol('handleRequest', 'src/util.js'));
    assert.ok(scoreSymbol('validateToken', 'a.js') > scoreSymbol('x', 'a.js'));
    assert.ok(scoreSymbol('_internal', 'a.js') < scoreSymbol('internal', 'a.js'));
});

test('buildSymbolMap produces a bounded CODE MAP for a real project, ranked', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symmap-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'index.js'), 'export function main(){}\nexport const startServer = () => {};\n');
    fs.writeFileSync(path.join(root, 'src', 'auth.js'), 'export class AuthHandler {}\nfunction refreshToken(){}\n');
    const map = buildSymbolMap(root, { maxChars: 1000 });
    assert.match(map, /^\[CODE MAP\]/);
    assert.match(map, /index\.js: .*main/);
    assert.match(map, /auth\.js: .*AuthHandler/);
    // index.js (entrypoint) should rank before src/auth.js
    assert.ok(map.indexOf('index.js') < map.indexOf('auth.js'));
    fs.rmSync(root, { recursive: true, force: true });
});

test('buildSymbolMap returns empty string for a greenfield (no source) project', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symmap-empty-'));
    fs.writeFileSync(path.join(root, 'README.md'), '# hi');
    assert.equal(buildSymbolMap(root), '');
    fs.rmSync(root, { recursive: true, force: true });
});
