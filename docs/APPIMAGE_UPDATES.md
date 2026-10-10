# How AppImage Updates Work (zsync) — and how Agent Smith ships them

Plain-English version of the mechanism a user described with:
`appimagetool -u "gh-releases-zsync|..."`.

## The problem it solves

Agent Smith's AppImage is ~270MB. Without update support, every new release means
every user re-downloads the whole thing. With zsync updates, an already-installed
AppImage can fetch only the *changed blocks* of a newer version (often 10–40MB)
and patch itself in place — no full download, no reinstall.

## The two moving parts

An "updatable AppImage" needs exactly two things:

### 1. UPDATEINFO header (inside the .AppImage file)

A one-line string embedded in the AppImage's metadata section that tells the
runtime *where* to look for updates. Ours is:

```
gh-releases-zsync|6Morpheus6|Agent_Smith-Reloaded|latest|Agent.Smith.Reloaded-*.AppImage.zsync
```

Read it as 4 pipe-separated fields:

| Field | Value | Meaning |
|-------|-------|---------|
| scheme | `gh-releases-zsync` | "this is a GitHub Releases zsync endpoint" (the AppImage runtime knows this format) |
| owner | `6Morpheus6` | your GitHub account |
| repo | `Agent_Smith-Reloaded` | the repo releases live in |
| tag + glob | `latest` / `Agent.Smith.Reloaded-*.AppImage.zsync` | look at the *latest* release and find any asset matching that name pattern — it must be a `.zsync` file |

When a user's AppImage checks for updates, the runtime resolves
`gh-releases-zsync|owner|repo|tag|glob` to a concrete URL like:

```
https://github.com/6Morpheus6/Agent_Smith-Reloaded/releases/latest/download/Agent.Smith.Reloaded-57.0.0.AppImage.zsync
```

downloads that `.zsync`, compares it against the local file, and if there's a new
version, downloads only the differing blocks (via `https://.../download/<new>.AppImage`)
and swaps itself in place.

Check any AppImage's header with:  `./Your.AppImage --appimage-updateinfo`

### 2. The .zsync file (uploaded next to each release)

A small (~460KB for us) *delta manifest*: SHA-1 hashes of the AppImage cut into
blocks, plus the full-file length and checksum. It's what makes "download only
what changed" possible — it's the rsync-style fingerprint of the file.

**Critical rule: every release must upload BOTH files.** If you ship a new
`.AppImage` without its `.zsync`, the update check finds no matching asset, the
glob fails, and users silently never get updates (they just keep their old copy).

## Why "first time there is no zsync file" (your user's note)

The *previous* release (v54.3) has no `.zsync` — that's fine. The first
zsync-enabled release (this one, v56) creates the baseline: its own `.zsync`.
Updates only ever happen between zsync-enabled releases (v56 → v57 → …). Users on
v54.3 or older will need to download v56 manually once; from then on they update
incrementally forever.

## Why we can't just use electron-builder for this

electron-builder 26.x builds AppImages with its own toolchain and does NOT write
the UPDATEINFO header (it emits an `electron-updater` `.blockmap` instead — a
different, in-app updater system that Agent Smith doesn't have wired up). So the
build is two stages:

```
npm run dist                                  # electron-builder → linux-unpacked/ + .deb
bash scripts/build-updatable-appimage.sh      # appimagetool -u  → updatable AppImage + .zsync
# or one command:
npm run dist:updatable
```

Stage 2 assembles an `AppDir` (electron-builder's unpacked payload + the
version-independent "chrome": AppRun, .desktop, icons — kept in
`vendor/appdir-chrome/`) and runs raw `appimagetool -u`. The vendored
`vendor/appimagetool-x86_64.AppImage` bundles its own `zsyncmake`, so the `.zsync`
is generated automatically — no system packages, no sudo.

## Naming rules (these are load-bearing)

- AppImage asset:  `Agent.Smith.Reloaded-<version>.AppImage`   ← **dots**, matches v54.3's convention
- zsync asset:     `Agent.Smith.Reloaded-<version>.AppImage.zsync`
- deb asset:       `agent-smith_<version>_amd64.deb`
- Release tag:     `v<version>` (e.g. `v56.0.0`)

The zsync glob in the header (`Agent.Smith.Reloaded-*`) only matches the dotted
name — if a future build emits spaces or hyphens, updates break silently. The
build script enforces the name and verifies the result before it finishes.

## Release checklist (copy-paste)

```bash
cd ~/Documents/testing/"agent smith"/vNN        # your version folder
npm test                                        # sanity: same pass/fail as baseline
npm run dist:updatable                          # builds .deb + updatable AppImage + .zsync, self-verifies
ls -la release/Agent.Smith.Reloaded-*.AppImage* release/*.deb   # confirm 3 files
```

Then on GitHub (repo `6Morpheus6/Agent_Smith-Reloaded`):
1. Create a new release, tag `v<version>`.
2. Upload **all three**: the `.AppImage`, its `.zsync`, and the `.deb`.
3. Done — every installed v56+ AppImage will now find it via "latest".

## Verifying an updatable AppImage (any of them)

```bash
./Agent.Smith.Reloaded-56.0.0.AppImage --appimage-updateinfo   # prints the header URL
grep -a '^SHA-1:' Agent.Smith.Reloaded-56.0.0.AppImage.zsync   # must equal: sha1sum <AppImage>
grep -a '^Length:' Agent.Smith.Reloaded-56.0.0.AppImage.zsync  # must equal file size (bytes)
```
