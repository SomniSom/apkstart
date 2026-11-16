# ApkStart v0.3.5 release notes

> Fixes a set of defects found during a code walkthrough of v0.3.4; all verified locally.

## What this release fixes

### 1. APKs over 2 GB could not be installed (#21)
The old parser read the whole file into memory and hit Node's single-Buffer limit above
2 GB: the user clicked install, got an English error and an endless spinner.

- Parsing now uses a **file-backed ZIP reader**: only the central directory is read, and
  the manifest / resource table / icon on demand, so peak memory drops from "size of the
  package" to "a few MB";
- `.apks` / `.xapk` bundles are unpacked as a stream (each part written as it decompresses)
  and the temp dir is cleaned up on failure;
- the `adb install` timeout is no longer a fixed 4 minutes but **scales with the package**
  (~5 minutes for 2 GB, capped at 20), so a large APK on a slow disk is not reported as failed;
- install failures are emitted from one place in the main process and clear the
  "installing..." spinner, so a stuck progress bar is not left behind.

### 2. ZIP compatibility for large runtime and update packages

- **ZIP64** support (EOCD locator + extra field id=0x0001): more than 65535 entries no
  longer silently loses entries, and offsets/sizes of huge entries are read from the
  extra field.

### 3. Setup stuck on "preparing the runtime" / "99% then re-downloading the image"

- source probing now reports progress per candidate (i/n) instead of 30 silent seconds,
  waiting at most 6 s per source; an unreachable port just sorts last;
- before the runtime download the UI says "fetching runtime version info...";
- a failed image unpack is **no longer swallowed**: it reports the file name instead of
  "99% -> jump back and re-download 1.4 GB from the official source";
- unpacking writes a `.part` file and renames it **atomically**: a crash or power cut
  cannot leave a half-written `system.img` that looks complete;
- "already unpacked" now means "at least as large as the archive", not ">32 MB", so a
  truncated image is unpacked again;
- the disk guard accounts for the runtime package (1.5 GB archive + 3.3 GB unpacked, both
  present at the peak) and gives an actionable message up front.

### 4. Changing "runtime data directory" still downloaded into the old one (#23)

When a portable build shipped with a `runtime/` next to the binary, startup overwrote a
user-set `runtime.dir`. Now: **an explicitly set directory that contains an emulator is
always respected**; auto-takeover happens only when nothing was set or the directory is
no longer usable.

### 5. Online update could install the 1.5 GB runtime package as the app

Releases carry both the portable package and `ApkStart-runtime-*.zip`. The fallback `.zip`
match did not exclude the latter, so a release missing the portable package would unpack
the runtime into the program directory. The fallback now excludes `runtime` assets and,
when nothing is usable, tells the user to download manually from the release page.

### 6. A failed boot left no usable diagnosis (#20 / #25)

Attempts and the diagnosis lived only in memory, so restarting ApkStart and exporting a
report gave `attempts: []` and `UNKNOWN`.

- on failure **attempts / diagnosis / exit code** are written to
  `~/.local/share/apkstart/logs/last-failure.json` (cleared by the next successful boot);
- the report includes the persisted record, the exit-code meaning and the tail of
  `emulator.log` (the last 300 lines are read from disk when the in-memory log is empty);
- new **`0xC0000005` (3221225477)** rule: classified as "renderer backend crash" with a
  hint to update the graphics driver or lower quality, instead of a vague "runtime did
  not finish booting";
- on such a crash the engine **retries once with a more conservative backend and remembers
  it** (`engine.badGpu`, invalidated per emulator version);
- the runtime panel in Settings shows "last launch failed: ..." without exporting a report.

### 7. Uninstalling ApkStart wiped the user's .apk association

The old code unconditionally cleared the default handler for `.apk` (the "only if it still
points at us" promise in the comment was never implemented). Now:

- on registration the previous handler is recorded in the app config;
- on unregistration it is **restored first**; only with no record and a handler still
  pointing at ApkStart is the entry cleared;
- verified locally: previous handler restored unchanged.

### 8. Icons: formats beyond WebP, and "placeholder without saying so"

- `jpg/jpeg` added to the icon candidates;
- adaptive icons and `layer-list` XML now search nested bitmaps recursively (up to 3
  levels) instead of always falling back to the brand placeholder;
- when the icon really cannot be decoded, the install message says "the icon could not be
  parsed; the shortcut uses a placeholder" instead of leaving the user with a green triangle.

### 9. After a fresh install the desktop shortcut showed only the Android home screen

An upstream bug (also present in v0.3.4): `apps.json` stores the launch entry as a full
component (`com.foo.bar/com.foo.bar/.MainActivity`) and the launcher prefixed the package
again, so `am start -n` received
`com.foo.bar/com.foo.bar/com.foo.bar/.MainActivity` and the system cancelled the launch
(`result code=-92`) — the window showed the home screen.

- new `componentArg()`: a full component is used as is, a bare class name gets the package
  prefixed; both legacy shapes work;
- `parseResolvedActivity()` scans all lines (the `resolve-activity` output often ends with
  a blank line) instead of bailing on a trailing empty string;
- verified: after reinstalling, `mCurrentFocus` lands on the app's splash activity and the
  window shows the app, not the home screen.

### 10. Log rotation edge case

When the log file name does not end in `.log`, rotation deleted before renaming and lost
the log; rotation is now skipped instead.

### 11. Other
- new synthetic-APK fixture (`test/lib/make-apk.js`): a hand-built binary AXML manifest +
  PNG icon + ABI dirs, so the parser is covered even without a real APK;
- new/expanded regression cases: Zip64, `.xapk` bundles, materializeImages, update asset
  selection, the `0xC0000005` diagnosis, log boundaries, persisted failures, WebP fallback;
- `npm test` went from 98 to **113 green checks**.

## Verified

| Check | Result |
|---|---|
| `npm test` | 113 passed / 0 failed (8 + 25 + 80) |
| `electron test/electron-integration.js` | ICO / .lnk / WebP fallback all pass |
| Real cold boot | ready in 25.0 s (`sys.boot_completed=1`) |
| Snapshot hit | 5-6 s |
| Graceful shutdown | `code=0`, `hasSnapshot=true` |
| Real APK parsing | label, WebP icon and arm64-v8a parsed correctly |
| 2.15 GB APK parsing | 18 ms, process RSS 47 MB (the old code needed 2.2 GB of RAM) |
| Fresh install + shortcut launch | `mCurrentFocus` on the app's splash activity; app UI in the window |
| `npm run selftest -- --apk` | **13 checks passed**: adb / engine / image / KVM, Android 14 API 34, freeform, two-way shared folder, parse -> install -> window -> screenshot |
| `tools/check-launch-clean.js` | during install + launch: app window in **0.5 s**, emulator/console windows **0** |
| Install path | a 153 MB APK dropped in: 22 s for parse/install/icon/shortcut; Target/Args/Icon correct |
| No leaked windows | `check-quit-clean`: nothing visible during boot and 8 s after exit |
| Association | previous handler restored unchanged after register -> unregister |
| Packaged build | 226 MB portable build, UI smoke test passed |

## Known limitations

- The **root cause** of `0xC0000005` is still in the graphics driver / Vulkan backend; this
  release switches the backend and explains the failure. A machine that still crashes
  reliably should send the new diagnostic report.
- Icon parsing still does not support `shape` / vector drawables (placeholder, reported
  as such).
- The `.apk` association is written per user; if another program keeps stealing it, the
  system "Default applications" setting wins.
