'use strict';
/**
 * Pure display math (unit-testable, no Electron / adb).
 *  - fullscreen: the Android resolution matches the monitor work area, content fills it;
 *  - windowed: keeps the portrait preset; Qt rescales while the user drags, size is stored per app.
 */
function densityFor(w, h, manual) {
  if (manual > 0) return Math.max(120, Math.min(640, Math.round(manual)));
  return Math.max(200, Math.min(480, Math.round(Math.min(w, h) / 2.57)));
}

function portraitSize(str) {
  const m = /^(\d{3,4})x(\d{3,4})$/i.exec(String(str || ''));
  if (!m) return { w: 900, h: 1600 };
  const w = Number(m[1]);
  const h = Number(m[2]);
  return (h > w && w >= 320 && h >= 480) ? { w, h } : { w: 900, h: 1600 };
}

function defaultBounds(area) {
  const h = Math.round((area.h || 1080) * 0.84);
  const w = Math.round(h * 9 / 16);
  return {
    x: Math.round((area.x || 0) + ((area.w || 1920) - w) / 2),
    y: Math.round((area.y || 0) + ((area.h || 1080) - h) / 2),
    w, h,
  };
}

/**
 * Fullscreen = full screen height, horizontally centered.
 * The emulator window aspect ratio is fixed by the LCD at boot (9:16), so a plain maximize gives
 * a window stuck to the left with unchanged width; computing the height from the ratio and
 * centering it looks like a fullscreen app without distorting the picture.
 */
function fullscreenBounds(portrait, area) {
  const p = portraitSize(portrait);
  const ratio = p.w / p.h;
  const h = Math.max(320, Math.round(area.h || 1080));
  const w = Math.max(240, Math.round(h * ratio));
  return {
    x: Math.round((area.x || 0) + ((area.w || 1920) - w) / 2),
    y: Math.round(area.y || 0),
    w, h,
  };
}

/**
 * Android-side resolution: both modes keep the portrait preset.
 * Reason: the window aspect ratio is locked to the LCD size at boot (even after switching to 1920x1080
 * the window still accepts only 9:16 and the picture gets letterboxed or stretched). So fullscreen =
 * maximizing the window, windowed = freely resizable portrait; both share one Android resolution,
 * so switching needs no runtime restart and does not relayout the app.
 */
function sizeFor(mode, portrait, area) {
  return portraitSize(portrait);
}

module.exports = { densityFor, portraitSize, defaultBounds, fullscreenBounds, sizeFor };
