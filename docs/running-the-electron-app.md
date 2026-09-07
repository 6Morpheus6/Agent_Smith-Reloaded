---
name: running-the-electron-app
description: How to launch and drive the Agent Smith Electron app headlessly for verification (binary download + Playwright + auth bypass)
metadata:
  type: reference
---

Verifying changes in the real app (this repo is the `v41.2-reduced` copy):

- **The Electron binary is missing** — `node_modules/electron/dist/` is empty because the postinstall never ran. Fetch it once with `node node_modules/electron/install.js` (downloads ~Electron 28 from GitHub releases; network worked here).
- **Drive it with `playwright-core`** (`_electron.launch`, executablePath `node_modules/electron/dist/electron.exe`, args `['--no-sandbox', '--user-data-dir=<temp>', APP_DIR]`). Windows has a real display — no xvfb. Use `--user-data-dir=<temp>` to keep tests off the real `%APPDATA%/agent-smith` profile. `playwright-core` was added to devDependencies for this.
- **Auth is a renderer-only gate.** First run shows a `CREATE ADMIN ACCOUNT` overlay (`#reg-username/#reg-password/#reg-password-confirm` → `#register-submit-btn`); registration does NOT auto-login — it switches to the sign-in form (`#auth-username/#auth-password` → `#login-btn`), which then hides `#login-overlay`. **But IPC handlers run regardless of the auth UI**, so to test main-process logic you can call `window.api.invoke(channel, ...)` via `page.evaluate` without signing in.
- The plugin system was verified this way end-to-end: real `git clone` install from a loopback git-smart-HTTP remote, enable with capability consent, tool invoke, slash-command resolve. See [[plugin-system]] notes if added.
