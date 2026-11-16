# ApkStart v0.3.7

> One line: **the window close button now really stops the Android app**, and the **VM
> network** goes from "wait and hope" to automatic self-healing; the CI Gitee token is set up.

## 1. Fix: the close button now really ends the app

**Problem**: clicking the ⨯ in the title bar removed the window but the Android app kept
running in the background, so reopening it looked as if it had never been closed.

**Cause**: `shell:close` called Electron's `win.close()` directly and bypassed
`AppWindow.close()`. The window's `closed` event only cleared internal state: **no
`force-stop` of the Android app and no detach of the emulator window from the host**.
Alt+F4 and closing from the taskbar behaved the same way.

**Fix**:

- the ⨯ button goes through `appWin.close()`: the emulator window is detached and hidden,
  then `am force-stop` stops the Android app;
- the `closed` event performs the same cleanup (covers Alt+F4, taskbar close and system shutdown);
- rotation / minimise / maximise are unchanged.

**Verified**: after a `WM_CLOSE` to the app window, `pidof <package>` went from `5152` to
**empty** and the foreground returned to the Android home screen — the app really exited.

## 2. Network: no longer luck, now self-healing

The previous release established that the black screen was "the VM has no network" but
only "waited longer"; a boot where Wi-Fi never associates still timed out.

This release escalates **from cheapest to most expensive**:

1. **wait for the network before launching** (up to 60 s, progress in the log);
2. if that fails, **cold-boot the VM once** (`-no-snapshot-load`, skipping a quickboot
   snapshot that may have been saved without a network) and wait up to 180 s more;
3. as soon as the network is up, **save a snapshot immediately**, so the adapter state
   comes back with the snapshot;
4. "Settings -> Repair network" runs the same sequence and only **resets the Android data**
   when the first two steps fail (the app list is kept and apps reinstall on launch, but
   in-app accounts and history are lost).

> On "upgrade the Android version": the image was not changed. Replacing it would force
> every user to re-download 1.5 GB, while the measured root cause is slow or missing Wi-Fi
> association in the emulator, not the Android version. Waiting plus a cold-boot cures the
> same cases without growing the package.

## 3. CI: the Gitee sync token is configured

The `GITEE_TOKEN` Actions secret is in place, so publishing a `v*` tag makes the release
workflow mirror the portable build to Gitee automatically.

## 4. Verified

- `npm test`: **113 checks passed** (8 + 25 + 80).
- After closing the window `pidof` is empty (the app really exits).
- Network log: `VM network ready (10.0.2.16)`, after which the home page renders normally.

## 5. Upgrading

- Portable: unpack over the old copy; the data directory is untouched.
- Installed build: install over the old version.
