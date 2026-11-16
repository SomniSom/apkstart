## What this release fixes

### 1. Slow downloads: every thread was hammering one blocked address

Measured on one machine: 8 threads against GitHub alone gave **0.23 MB/s**, i.e. **493 s**
for a 113 MB update. At the same time two direct connections returned **zero bytes**
(TCP up, no data) and only the mirror moved.

- **Parallel multi-source chunks**: the file is split and different chunks are pulled
  from GitHub direct / ghfast / gh-proxy at the same time, so bandwidth adds up.
  Same machine: **113 MB went from 493 s to 77 s** (~1.5 MB/s including probing and unpacking).
- **Low-speed switching**: a chunk crawling at tens of KB/s is dropped, another source is
  picked and the transfer resumes from the same offset — no more "stuck at 95%".
- **Chunk-level resume**: a failed 1.4 GB runtime download only refetches the missing
  chunks on retry.
- **Stall watchdog**: a connection that delivers no bytes for 20 s is discarded and the
  next source is tried, instead of waiting out a 30 s socket timeout.
- **Measure every time**: each candidate really downloads 256 KB and only the throughput
  after the first byte is counted (including the handshake would punish high-latency
  sources with good bandwidth). Candidates are probed sequentially so they do not
  compete for bandwidth.

### 2. Two sources: GitHub and Gitee are chosen automatically

- Both repositories are public: GitHub `RoutineMiku/apkstart`, Gitee `daily-miku/apkstart`.
- The version check asks both and takes the higher tag; a timeout or a block on one
  source does not affect the other.
- Gitee caps a release attachment at 100 MB, so the portable package is published there
  as `.part1/.part2`; the client picks a source per part, verifies each size and
  concatenates them, aborting if a part is missing.
- Gitee rate-limits anonymous calls: a 10-minute version cache plus a 15-minute
  breaker on 403/429. When both sources fail the last result is returned marked
  `stale` instead of showing an error.

### 3. No more accidental data loss

- **A full disk no longer wipes data**: the last retry step used to pass `-wipe-data`,
  so a full disk made every step fail and repeated retries erased apps and saves.
  Automatic retries are now forbidden from wiping; the app stops and explains what to do.
- **Moving the runtime dir is not an image change**: relocating the runtime from `C:` to
  `D:` (which the settings suggest) was treated as a new image → `-wipe-data` → all apps
  lost. Identity is now compared per image, so a new location keeps the data.
- **`qemu-img resize` argument order fixed**: previously the file grew to 6 GB while the
  filesystem stayed at 64 MB, so Android filled up instantly and every service died with
  ENOSPC on `setxattr`. Startup now also heals the mismatch.

### 4. Other

- Install failures no longer spam: repeated clicks on the same APK run once, and the
  message gives an actionable conclusion (small partition / ARM-only / signature clash /
  downgrade).
- Resources and disk are configurable: three resource presets (frugal / balanced /
  smooth), three quality levels, a 4-24 GB Android data partition that can grow in place
  without losing apps, and a separate data directory.
- Size: the portable build is 230 MB (52 unused locales dropped, 39 MB saved).
- Logs rotate by size instead of growing forever; the shared folder no longer re-copies
  the same file back and forth.

## Verified on a real machine (Windows 11 + Android 14 Play image)

| Check | Result |
|---|---|
| Cold start to a launchable app | **23-25 s** (~32 s on the very first run) |
| Quickboot snapshot hit | **5 s** |
| Install an APK and open it | app window in **1.5 s** (warm snapshot) |
| Stray emulator/console windows in the first 45 s | **0** |
| Windows left on screen after quitting | **0** |

## Install

- **Full build** `ApkStart-*-Setup.exe`: ships the runtime, usable right after install (~1.4 GB).
- **Portable build** `ApkStart-*-win64-portable.zip`: unpack and run; the runtime is
  downloaded on first launch (fastest source, resumable).

Both repositories carry the same files.
