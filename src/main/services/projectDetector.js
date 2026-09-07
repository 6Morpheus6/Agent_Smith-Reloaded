const fs = require('fs');
const path = require('path');

function detect(projectRoot) {
    const out = {
        projectType: 'brownfield',
        testCmd: null,
        lintCmd: null,
        e2eCmd: null,
        installCmd: null,
        language: 'unknown'
    };

    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
        out.language = 'node';
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            if (pkg.scripts?.test) out.testCmd = 'npm test';
            if (pkg.scripts?.lint) out.lintCmd = 'npm run lint';
            if (pkg.scripts?.['test:e2e']) out.e2eCmd = 'npm run test:e2e';
            out.installCmd = fs.existsSync(path.join(projectRoot, 'package-lock.json')) ? 'npm ci' : 'npm install';
        } catch (e) { /* skip */ }
    }

    if (fs.existsSync(path.join(projectRoot, 'pyproject.toml')) || fs.existsSync(path.join(projectRoot, 'pytest.ini'))) {
        out.language = 'python';
        if (!out.testCmd) out.testCmd = 'pytest -q';
        if (!out.lintCmd) out.lintCmd = 'python -m py_compile .';
    }

    if (fs.existsSync(path.join(projectRoot, 'Cargo.toml'))) {
        out.language = 'rust';
        out.testCmd = out.testCmd || 'cargo test';
    }

    if (fs.existsSync(path.join(projectRoot, 'go.mod'))) {
        out.language = 'go';
        out.testCmd = out.testCmd || 'go test ./...';
    }

    const pwConfigs = ['playwright.config.js', 'playwright.config.ts', 'playwright.config.mjs'];
    if (!out.e2eCmd && pwConfigs.some(f => fs.existsSync(path.join(projectRoot, f)))) {
        out.e2eCmd = 'npx playwright test';
    }

    if (fs.existsSync(path.join(projectRoot, 'Makefile'))) {
        try {
            const mk = fs.readFileSync(path.join(projectRoot, 'Makefile'), 'utf-8');
            if (!out.testCmd && /(^|\n)test:/.test(mk)) out.testCmd = 'make test';
        } catch (e) { /* skip */ }
    }

    // No configured test runner, but the project carries JS/TS test files (e.g.
    // foo.test.js written into a bare folder with no package.json script). Node's
    // built-in runner discovers and runs them, giving the completion gate a real
    // pass/fail signal instead of stamping every scriptless JS project "unverified".
    if (!out.testCmd && hasNodeTestFiles(projectRoot)) {
        out.testCmd = 'node --test';
        if (out.language === 'unknown') out.language = 'node';
    }

    const hasSource = fs.existsSync(pkgPath) ||
        fs.existsSync(path.join(projectRoot, 'src')) ||
        fs.existsSync(path.join(projectRoot, 'main.py'));
    if (!hasSource && !fs.existsSync(path.join(projectRoot, '.git'))) {
        out.projectType = 'greenfield';
    }

    return out;
}

// True if the project root (or a conventional test dir) holds files Node's built-in
// test runner would pick up: *.test.js / *.test.mjs / *.test.cjs (and .ts variants).
function hasNodeTestFiles(projectRoot) {
    const TEST_RE = /\.test\.(c|m)?[jt]s$/;
    const scan = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
        return entries.some(e => e.isFile() && TEST_RE.test(e.name));
    };
    if (scan(projectRoot)) return true;
    for (const sub of ['test', 'tests', '__tests__']) {
        if (scan(path.join(projectRoot, sub))) return true;
    }
    return false;
}

module.exports = { detect };
