# ApkStart for Linux

[English](README.md) · [Русский](README.ru.md)

<p align="center"><img src="docs/images/logo.png" alt="ApkStart" width="160" /></p>

**Run Android apps on Linux: double-click an APK and the app opens in its own window, like a native program.**

> **This is a fork.** The upstream project is [RoutineMiku/apkstart](https://github.com/RoutineMiku/apkstart)
> (MIT). This fork has been reworked for **Linux only**: the registry/NSIS/PowerShell layer is gone, and
> window handling, shortcuts, file association, runtime provisioning and packaging all target Linux.
> The Windows branch is not maintained here. Upstream credit and the MIT licence are kept intact.

A fork of [RoutineMiku/apkstart](https://github.com/RoutineMiku/apkstart) (MIT), reworked for Linux. The Windows branch is not maintained: all code, docs and scripts target Linux only.

## What it does

- **Double-click an `.apk`** — once the MIME type is associated, your file manager (Nautilus, Dolphin, Thunar) hands the file over; ApkStart parses it, installs it and creates a launcher.
- **Desktop and application-menu shortcut** — a `.desktop` file with the icon extracted from the APK; launch from the menu by app name.
- **An app is a window** — Android Emulator starts windowed; ApkStart sets its title, `WM_CLASS` and size for the current orientation through `xdotool`/`wmctrl`. No screen mirroring: native 60 fps rendering.
- **Google services and ARM-only apps** — via the official `google_apis_playstore` system image (Android 14, x86_64) with Play Services and an ARM translation layer.
- **Shared folder with the host** — `~/.local/share/apkstart/shared` ↔ `/sdcard/ApkStartShared`, synced both ways over `adb`.
- **Self-contained runtime** — adb, emulator and images are downloaded and verified by the app into `~/.local/share/apkstart/runtime`; no third-party emulator is required (you may also attach to an existing one over `adb`).

```
Desktop: ~/.local/share/applications/<package>.desktop
        │  double-click
        ▼
electron . --launch <package>
        │  engine not running? → bring up the emulator (KVM)
        ▼
start via the system-resolved LAUNCHER activity
        │  liveness watch, retry on crash
        ▼
emulator window = the app window (title, icon, size, focus)
```

## Requirements

| Component | Why | Install (Debian/Ubuntu) |
|---|---|---|
| Linux x86_64 with `/dev/kvm` | hardware acceleration — required to boot | `sudo apt install qemu-kvm && sudo usermod -aG kvm $USER` |
| Node.js ≥ 20 | build and run from source | `sudo apt install nodejs npm` or nvm |
| `xdotool` | window control (title, focus, size) | `sudo apt install xdotool` |
| `wmctrl` | fullscreen and maximize | `sudo apt install wmctrl` |
| `qemu-utils` | `qemu-img` for the `/data` partition | `sudo apt install qemu-utils` |
| `e2fsprogs` | `resize2fs` to grow `/data` | usually preinstalled |
| `libfuse2` | AppImage only | `sudo apt install libfuse2` |

Session: X11 or Wayland (through XWayland). On Wayland the emulator window is an XWayland window, so `xdotool`/`wmctrl` work; Wayland does not let one client adopt another client's window — a platform limitation, not an implementation shortcut.

Disk: the system image is ~3.1 GB (plus ~1.5 GB while unpacking), app data and snapshots start at 4 GB. Reserve at least 15 GB.

## Install from source

```bash
git clone <your-fork> apkstart
cd apkstart
npm install
npm start                      # first run: UI + runtime deployment
npm run assoc:on               # associate .apk with ApkStart (xdg-mime)
```

On first run the app downloads `platform-tools`, the Linux Android Emulator build and the `google_apis_playstore` x86_64 image, then boots Android once. Later launches resume from the saved snapshot.

Check the environment without starting the UI:

```bash
npm run check:deps
```

## Packaging

```bash
npm run build:deb              # dist/release/ApkStart-<version>-amd64.deb
npm run build:appimage         # dist/release/ApkStart-<version>.AppImage
npm run build:all              # both, with the runtime prepared once
```

The **.deb** is the recommended install on Debian/Ubuntu: it registers the
`application/vnd.android.package-archive` MIME type, installs a desktop entry and
`apt`-visible dependencies. The **AppImage** is a single self-contained file for any
distribution; it needs FUSE (`libfuse2`) or `--appimage-extract-and-run`.

## CLI

```text
electron .                     open the main window
electron . <path/to/app.apk>   install an APK
electron . --launch <package>  start an app (used by .desktop entries)
electron . --silent            start without a window (autostart)
```

## Project layout

```
src/
├─ main.js              main process: window, tray, single instance, CLI, IPC
├─ preload.js           secure bridge
├─ ui/                  UI (plain HTML/CSS/JS, no framework)
└─ core/
   ├─ zip.js            minimal ZIP reader
   ├─ axml.js           binary AndroidManifest parser
   ├─ arsc.js           resources.arsc parser (app name and icon)
   ├─ apk.js            APK metadata: package, version, activity, icon, ABI
   ├─ png.js            PNG encoder + procedural icon drawing
   ├─ shortcut.js       .desktop files + PNG icons (freedesktop, XDG)
   ├─ assoc.js          .apk association: MIME + xdg-mime
   ├─ appwin.js         app window: locate and configure the emulator window
   ├─ adb.js            adb client (install, launch, sync, …)
   ├─ emulator.js       starting and wrapping Android Emulator
   ├─ engine.js         runtime management, session reuse
   ├─ provision.js      download/verify adb, emulator, images, KVM
   ├─ doctor.js         host profile, parameter selection, diagnostics
   ├─ sharer.js         two-way sync of the shared folder
   ├─ installer.js      install pipeline
   └─ store.js          app manifest and settings
```

Internals: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/LINUX-PORT.md](docs/LINUX-PORT.md), [docs/DEV-ENV.md](docs/DEV-ENV.md).

## Tests

```bash
npm test                # unit + engine + auto tests (offline)
npm run test:boot       # real boot: QEMU args, partition, shutdown
npm run selftest        # on a live Android: install → launch → screenshot → shared folder
```

## Differences from the Windows version

| Windows | Linux |
|---|---|
| `HKCU` registry + `reg.exe` for `.apk` | `application/vnd.android.package-archive` MIME + `xdg-mime` |
| `.lnk` shortcuts + ICO | `.desktop` + PNG in `~/.local/share/icons/hicolor` |
| `SetParent` — emulator window inside its own window | the emulator window *is* the app window (`xdotool`/`wmctrl`) |
| PowerShell agent, console hiding, `WHPX`/`AEHD` | KVM (`/dev/kvm`), no console windows |
| Data in `%APPDATA%\apkstart` | `~/.local/share/apkstart` (XDG) |

## Limitations

- No window adoption: Wayland does not expose such a protocol to every compositor, and the X11 trick is fragile. The window is the emulator window; the ApkStart UI stays a separate window.
- Right-click → "Back" and smooth scrolling are configured through the emulator; there is no OS-level global mouse hook.
- x86_64 with KVM only: on ARM machines (Apple Silicon, Snapdragon X) this path does not work — use Waydroid there.
- Apps that aggressively probe sensors or the baseband may not run — a limitation of the emulator itself.

## License

MIT. Distributed builds contain only ApkStart code and Electron; Android images, QEMU and Google components are downloaded by the user from official sources under their own licenses.
