# ApkStart v0.4.3

> One line: **rotation / fullscreen** now switches the **physical panel size** instead of
> "changing the runtime resolution", so landscape is finally **upright and filled**; the
> whole-machine stutter is gone and a new **game / low-latency mode** (for FPS) is added.

## 1. Rotation / fullscreen: now really upright and filled

### Why it never worked

The picture comes from a "physical LCD panel": Qt opens a window sized to that panel and
pastes the picture in the top-left corner. All three previous approaches were wrong, and
each one matches one of your screenshots:

| Approach | Result |
|---|---|
| changing `wm size` at runtime | only the Android logical resolution changes, the panel stays portrait -> the picture **lies on its side**, occupies a strip in the top-left corner, taps are offset |
| changing `wm density` at runtime | the framebuffer size does not change -> the picture **does not fill**, leaving a large blank area at the right when maximised |
| `adb emu rotate` | rotates the picture only, the system is still portrait |

### What it does now

**Rotation = change `hw.lcd.width/height` and restart the emulator** (30-60 s, only when
the rotate button is pressed):

- portrait panel `720x1280`, landscape panel `1280x720`;
- the direction lock `wm user-rotation` follows (1 for landscape, 0 for portrait) and sensor
  auto-rotation is off — a landscape panel with rotation 0 still shows a sideways picture;
- the orientation is stored in settings and used on the next boot;
- **the fullscreen button = switch to landscape**: maximise the window and rotate the
  physical panel, instead of stretching a portrait picture.

### Two real bugs fixed along the way

1. **`-no-skin` overriding `-skin`**: both flags were passed and `-no-skin` reverted the
   panel size to the old `config.ini` value — the direct cause of "landscape selected but
   still portrait". `-no-skin` is gone.
2. **Not filling after maximise**: Electron's maximised host becomes 1936x1048 while the
   inner Chrome render layer stays at the old size (measured 532x984), and the emulator
   window hangs below that layer and gets clipped. `Fit` now **stretches the render layer
   to the host client area first** and then sizes the emulator; the window scan also
   self-heals once per round, so a lost JS resize event recovers.

## 2. Stutter: three sources of whole-machine slowdown

1. **Window scan frequency**: the first 90 s after launch used to enumerate every window on
   the desktop every 120 ms (4 `EnumWindows` calls plus process path lookups per round).
   Now 250 ms for the first 10 s and **1500 ms** afterwards; game mode drops to **3000 ms**.
2. **Emulator priority**: the default balanced preset pushed qemu to BelowNormal and even
   to **Idle** after the app was closed, which made Android drop frames badly. Closing an
   app no longer drops the priority to Idle unconditionally.
3. **Global mouse hook**: `WH_MOUSE_LL` fires a synchronous callback for every desktop
   mouse event and adds visible pointer latency. **Game mode installs no hook at all.**

## 3. New: game / low-latency mode

Settings -> Performance & resources -> **VM priority -> "Game / low latency"**:

- the emulator process is raised to **High** priority so Android rendering and input get CPU first;
- the global mouse hook is not installed, the pointer takes the native input path;
- the window scan drops to 3000 ms, reducing host-side overhead;
- the "smooth" resource preset now also enters this mode (video/game first).

The price is a slower machine overall, so "balanced" stays the default.

## 4. Hardening

- `settings.json` now tolerates a **UTF-8 BOM**. With a BOM, `JSON.parse` threw and the
  whole config silently fell back to defaults — users saw "all settings lost" with no clue.
- New regression tests: landscape must come from `lcdFor({landscape})` and never from a
  runtime `wm size`; window mode must pass `-skin` and never `-no-skin`; game mode must be
  High priority and install no global hook.

## 5. Verified

- `npm test`: **117 checks passed** (8 + 25 + 84).
- Landscape: `wm size` = `Physical size: 1280x720`, `user_rotation=1`, and the guest picture
  is **upright, correctly laid out and filled**; after maximise the host client area is
  1920x1032 and the render layer matches it.
- Portrait: `720x1280`, `rotation=0`, picture upright and filled.

## 6. Upgrading

- Portable: unpack over the old copy; the data directory is untouched.
- Installed build: install over the old version.
