## What this release fixes

### 1. Opening ApkStart made WeChat (and other Qt apps) disappear

The most serious problem of the previous release. The window agent identified its own
windows by **window class name**:

- `FindEmulator()` matched any window whose class contains `QWindowIcon` — which is the
  class of **every Qt top-level window**;
- `HideToolWindows()` matched `QWindowTool` — and Qt menus, emoji panels and floating
  helper windows use `QWindowToolSaveBits`;
- the resident hiding loop scanned every 120 ms and called `ShowWindow(h, 0)` on a hit;
  `embed` / `park` even re-parented such windows.

WeChat 4.x is built on Qt 6 (its `Weixin.dll` contains `QWindowToolSaveBits` / `Qt6`
strings) and its main window class is `Qt51514QWindowIcon` — identical to the emulator's.
So "open ApkStart and the WeChat window vanishes / becomes a black block" happened.

**Measured on the same machine** (WeChat 4.1.7.59, main window 296x388):

| Version | WeChat window state |
|---|---|
| 0.3.3 | `hidden` 3.7 s after launch, hidden in all 74 later samples |
| 0.3.4 | `visible` through two runs of 45 s / 280 s, hidden **0** times |

**Fix: the class name is not identity, the process path is.**

- New `scope` command: before hiding or embedding, the main process sends "our
  directories" (runtime root plus the bundled `engine` dir) and its own pid;
- every window decision first passes `IsOurs(pid)`: the executable must live in those
  directories;
- **with no scope nothing is touched** — rather miss a console window than hide somebody else's;
- console windows are no longer matched by "title contains emulator/qemu/netsim" but by
  the conhost parent chain reaching the runtime dir, or the absolute runtime path in the title;
- `embed` verifies the host window pid equals the main process pid and refuses otherwise
  (a recycled handle must not embed the emulator into another app);
- the mouse hook checks `IsWindow(_host)` and the host pid and passes everything through
  when the handle is stale;
- rotation (Ctrl+Left/Right) sends global keys only when our own window is foreground;
- a rebuilt agent gets the scope again, otherwise it would touch nothing.

### 2. Gitee now carries a complete, directly unpackable package (no part1/part2)

- Compressor changed from `Compress-Archive` (.NET deflate) to 7-Zip `-mx=9`:
  **105.2 MB -> 99.8 MB** for the same tree;
- `d3dcompiler_47.dll` dropped (Windows 8.1+ ships it in `System32`, rendering identical),
  another 2.1 MB; `vk_swiftshader` / `vulkan-1` kept as the software fallback;
- final **95.0 MiB**, inside Gitee's 100 MB single-file limit, unpacked right after download;
- new `build/zip.js` re-reads the archive with the app's own zip reader and compares entry
  count and total bytes, **failing CI above 100 MiB** so the package cannot silently
  regress into split parts.

### 3. "Best source" selection was not actually working

Same-name assets were deduplicated by name and the first one won; GitHub came first, so
**Gitee's URL was dropped**. With the package no longer split, that meant GitHub forever.

- Same-name assets now merge their `urls` and keep a per-URL `size` (the two sources
  produce different byte counts);
- speed is measured before downloading; `downloadMulti` now uses the **fastest source's
  total size** instead of `Math.max`, which made it always pick the larger source;
- on this machine Gitee was the fastest of four candidates: 95.2 MB in 48 s (~2 MB/s).

### 4. Other

- The agent's "guard" check only recognises processes from our runtime dir, so other
  emulators (MuMu / LDPlayer) do not keep it busy for 3 extra minutes;
- the tool scripts (`check-agent`, `check-console`, `check-windows`, `check-launch-clean`,
  `check-quit-clean`) send the scope too.

## Verified

| Check | Result |
|---|---|
| Unit + integration tests | run-tests 3 / auto-test **70 passed, 0 failed** |
| End to end (real runtime + real AVD + real APK) | install -> open -> embed all pass; app window in 0.5 s; leaked windows **0** |
| WeChat (4.1.7.59) coexistence | over the whole run WeChat was hidden **0** times |
| Gitee package | 95.18 MiB, `Expand-Archive` in 5.2 s, md5 of 69 files matches the source |
| Download from Gitee | 95.2 MB in 48 s, zip structure intact |

## Download

- Portable `ApkStart-v0.3.4-win64-portable.zip` (**95 MB**, unpack and run, runtime on first
  launch): **one complete zip** on both GitHub and Gitee, no part concatenation.
- Full build `ApkStart-0.3.4-Setup.exe` (~1.35 GB, bundled adb / emulator / system image,
  offline after install): above Gitee's limit, GitHub only.
