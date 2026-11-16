# ApkStart v0.3.9

> One line: **orientation switching** changes from "rotating the picture" to a real
> **phone / tablet layout switch**, fixing fullscreen not going landscape, dead taps and the
> black strip when clicking title-bar buttons; plus **storage reclamation**.

## 1. Orientation / fullscreen: a real layout switch

**Problem**: after tapping rotate (or fullscreen) the picture lay on its side clockwise or
counter-clockwise, the app never re-laid itself out, and fullscreen did not go landscape.

**Cause**: the old implementation "changed `wm size` and sent Ctrl+Left to the emulator".
Ctrl+Left only rotates **the emulator's picture** 90°; Android's layout did not change —
hence the sideways picture. The AVD config also hard-coded `hw.sensors.orientation=no`, so
Android did not allow rotation at all.

**What it does now**:

- only the **logical display size** changes (`wm size`), so Android re-lays out for the new width:
  - portrait 720x1280 @320dpi ~= **360dp wide -> phone layout**;
  - landscape 1280x720 @320dpi ~= **640dp wide -> tablet/two-pane layout** (600dp is
    Android's tablet threshold);
- `wm user-rotation lock 0` keeps the picture upright;
- **the picture-rotation step is gone**, so picture and layout always agree;
- the window recomputes its aspect ratio for the new resolution, leaving no black bars;
- **the fullscreen button now switches to landscape (tablet layout)** and back to portrait
  on exit; the "display mode" setting behaves the same way;
- new AVDs get `hw.sensors.orientation=yes` + `hw.sensors.accelerometer=yes`.

## 2. Fix: black strip when clicking the four title-bar buttons

The emulator's Qt window is larger than the real LCD (8 px of grey on each side). To keep
that grey out of the picture the child window used to overflow 8 px up/left — right onto
the bottom of the title bar; raising the emulator window on a button click made that strip
paint a **black band** under the title bar.

**Fix**: the embedded window got a **window region** (`SetWindowRgn`) clipping the 8 px
overflow, so raising it can no longer paint over the title bar.

## 3. Fix: dead taps / cannot reach "Agree and continue"

Same root cause: after the picture was rotated 90° the agent's coordinate mapping still
assumed portrait, so every tap was offset and looked like "nothing happens". The layout
switch fixes it.

The "wait for network" cost also dropped: the cold-boot retry runs **once per process**
and the first wait went from 60 s to 25 s.

## 4. Storage

"Clean up old version leftovers" now also reclaims **abandoned quickboot snapshots**:

- the legacy `default_boot` (a ~**3 GB** `ram.img`);
- `*.stale-*` leftovers that could not be deleted and were renamed;
- the snapshot in use (`apkstart`) is never touched.

On the dev machine this reclaims about **4.65 GB** (6 old version directories + 1 stale snapshot).

## 5. Verified

- `npm test`: **113 checks passed** (8 + 25 + 80).
- After `wm size 1280x720` the framebuffer really is **1280x720** and the picture upright
  (confirmed by screenshot).
- The app window reports `embedded=true`; `pidof` is empty after closing the window.

## 6. Upgrading

- Portable: unpack over the old copy; the data directory is untouched.
- Installed build: install over the old version.
