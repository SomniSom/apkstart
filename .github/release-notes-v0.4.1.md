# ApkStart v0.4.1

> One line: the "black bars on rotation / app not filling / dead clicks / Agree not
> clickable" group of symptoms was traced to **one cause**: the embedded emulator window is
> a sibling of the Electron web layer, and the web layer always sits on top.

## 1. The real root cause

A `WindowFromPoint` hit test in the middle of the picture returned **not the emulator
window** but `Chrome_RenderWidgetHostHWND` (Electron's web renderer).

The web layer's black background covered the Android picture and swallowed every mouse
event. Hence all at once:

| What the user saw | Actual cause |
|---|---|
| Black bars / app not filling | the web layer's black background covered the embedded picture |
| Clicks did nothing / landed elsewhere | the mouse hit the web layer, never Android |
| "Agree and continue" not clickable | same (`adb input tap` works because it uses logical coordinates) |
| Worse after rotate / fullscreen | resizing triggers a Chromium repaint that raised the web layer again |

v0.3.9 tried to clip the 8 px title-bar overflow with `SetWindowRgn`, which **broke hit
testing of the Qt/GL child** and left the region mismatched after a resize — the direct
source of this release's problems.

## 2. Fix

1. **Removed the `SetWindowRgn` clipping**; `Embed()` now explicitly clears any region left
   by older versions. The 8 px overflow is covered by the host's own title bar.
2. **The emulator window is now a child of the web render layer** (not a sibling of the
   host). A child window's Z order and hit testing naturally win, so the web layer can no
   longer cover the picture or eat clicks.
   - the web layer may not exist at embed time, so both `Fit()` and the resident scan
     re-parent it to be sure.
3. **`HideStrayWindows` narrowed**: only explicit popup classes (Qt tool windows, consoles)
   are hidden, never `QWindowIcon` / `subWin` (the visible LCD).
4. **The window is raised after a successful start** (brief topmost, then restored) so
   other windows cannot cover it.
5. **Window size on rotation**:
   - `setContentSize` has no effect while maximised, so `unmaximize` runs first — otherwise
     the landscape picture is squeezed into a portrait window;
   - target sizes are clamped to the screen work area;
   - Qt re-lays out several times after `wm size`, so `Fit` runs 6 rounds in a row to
     converge with no leftover bars.

## 3. Verified (real interaction, not adb simulation)

- Tapping "Agree and continue" with a **real mouse** reaches the app's main activity and
  then its player screen;
- `PrintWindow` of the host: the Android picture **fills everything below the title bar
  with no bars or gaps**; video, likes, comments, episode list and the four title-bar
  buttons all work;
- `WindowFromPoint` in the middle returns the emulator window (it returned the web layer before);
- `npm test`: **115 checks passed** (8 + 25 + 82), with two new regression tests pinning
  "the embedded window must be a child of the web layer and must not use a region".

## 4. Hardening

- `agent.ps1` keeps its UTF-8 BOM (losing it makes PowerShell 5.1 compile the script as
  ANSI and `Add-Type` fail);
- new regression tests: `SetParent(emu, parent)` / `FindChromeRender` exist,
  `CreateRectRgn(0, clipTop)` does not, and embed clears the region.

## 5. Upgrading

- Portable: unpack over the old copy; the data directory is untouched.
- Installed build: install over the old version.
