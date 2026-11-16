# Runtime engine directory (optional, manual)

**Since 0.2 ApkStart is fully self-provisioning**: adb, the emulator and system images are
downloaded by the app into `$XDG_DATA_HOME/apkstart/runtime/` (default
`~/.local/share/apkstart/runtime/`). Nothing has to be prepared by hand.

This directory only matters in the two cases below.

## 1. A pre-downloaded emulator

```
engine/emulator/
├─ emulator
├─ qemu/linux-x86_64/
└─ …
```

Unpack the official `emulator-linux_x64-*.zip` here if the download source is blocked or
you want to pin a specific build. ApkStart prefers a complete `engine/emulator/` over
downloading one.

## 2. A portable adb

```
engine/platform-tools/
└─ adb
```

Download: https://developer.android.com/tools/releases/platform-tools

## System images

- Recommended: the Google APIs Play Store image for Android 14 (`android-34`,
  `google_apis_playstore`, `x86_64`), downloaded inside the app (resumable, multi-source).
- Or import any already-installed Android disk image (qcow2 / raw / vmdk) via
  “Runtime → Import”. The runtime then boots straight from that disk.

## Hardware acceleration

The runtime requires KVM:

```bash
ls -l /dev/kvm                 # must exist
sudo usermod -aG kvm "$USER"   # then log out and back in
```

Without KVM the app refuses to start the emulator rather than falling back to a
10-minute software boot. `npm run check:deps` reports what is missing.
