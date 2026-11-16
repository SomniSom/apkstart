# ApkStart v0.4.0

> One line: fixed the "app does not open / stays black" regression, a single tray click
> opens the main window, another round of startup speed, and all stray runtime windows are
> now suppressed consistently.

## 1. Fix: the app did not open / stayed black (v0.3.9 regression)

**Cause**: the previous release added a network wait with **cold-boot retry** to the launch
path. On a slow network it would "stop the VM and cold-boot" while the app launch was about
to run `adb install` / `am start` — the device vanished mid-flight:

```
adb: device 'emulator-5554' not found
launch failed <package>
```

**Fix**:

- **the launch path only waits, never restarts**: at most 20 s, and if the network is still
  down the app launches anyway (a slow page beats a failed launch);
- cold boots and resets happen only when the user presses "Repair network";
- `waitForNetwork` no longer gives up on the first `device-offline` — a just-rebooted VM
  needs tens of seconds for adb, and 45 s of grace is now allowed.

**"Repair network" is also fixed**: only the boot after `-wipe-data` reliably gets a
network on this image, so it resets the data (app list kept, apps reinstall on launch),
waits for the network and **saves a snapshot immediately**.

Verified: the launch log shows `VM network ready (10.0.2.16)` and the app reaches its main
activity with the home page rendered.

## 2. Tray: a single click opens the main window

Only double-click was bound, so clicking once looked like a dead tray icon. A single click
now opens the window (right click still opens the menu, double click still works).

## 3. Startup speed

- no cold-boot retry in the launch path, so no more 3-5 minute waits;
- the network wait dropped from 60 s to **20 s** and returns at once when the device is offline;
- a "network ok" snapshot is saved, so a full start (boot -> network -> install -> embed) is
  about **48 s**, of which ~20 s is booting.

## 4. Stray runtime windows

The agent gained a fallback layer: every extra visible top-level window created by
**processes in our runtime directory** is hidden (Qt message boxes, crash dialogs, volume
overlays, log windows), keeping only the emulator main window that is embedded into the
host. The previous implementation named classes one by one and a miss flashed on screen.

## 5. Hardening

- `agent.ps1` carries the **UTF-8 BOM** again. Saving it normally dropped the BOM,
  PowerShell 5.1 read the non-ASCII comments as ANSI and could merge a comment with the
  next code line, breaking `Add-Type` ("window agent failed to start").
- New regression test: **the agent script must keep the UTF-8 BOM**.

## 6. Verified

- `npm test`: **114 checks passed** (8 + 25 + 81).
- App: launch -> agree -> home page renders the video feed (screenshot).
- A single tray click opens the main window.

## 7. Upgrading

- Portable: unpack over the old copy; the data directory is untouched.
- Installed build: install over the old version.
