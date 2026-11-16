'use strict';
/**
 * Lightweight log writer with rotation.
 *
 * app.log / emulator.log used to be plain append-only files and kept growing:
 * one emulator boot alone writes tens of KB of kernel log; a dozen boots a day plus qemu's
 * verbose output add up to hundreds of MB in a few months — that is how the disk silently fills up.
 * Here we rotate by size, keep one .1.log backup, and cap the size from the settings.
 */
const fs = require('fs');
const path = require('path');

const counters = new Map();

function rotate(file, limitKB) {
  try {
    const st = fs.statSync(file);
    if (st.size < limitKB * 1024) return false;
    const bak = file.replace(/\.log$/i, '.1.log');
    // If the name does not end in .log the backup path equals the file: delete+rename would erase the log.
    // Skip that edge case explicitly — better a bigger log than a lost one.
    if (path.resolve(bak) === path.resolve(file)) return false;
    try { fs.rmSync(bak, { force: true }); } catch (_) { /* ignore */ }
    fs.renameSync(file, bak);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * @param {string} file target log
 * @param {string} line one line (newline is appended automatically)
 * @param {number} [limitKB] rotate when the file gets bigger
 */
function append(file, line, limitKB = 2048) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const n = (counters.get(file) || 0) + 1;
    counters.set(file, n);
    // Check once per process start, then every 200 lines (statSync is cheap but not free)
    if (n === 1 || n % 200 === 0) rotate(file, Math.max(256, Number(limitKB) || 2048));
    fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`);
    return true;
  } catch (_) {
    return false;
  }
}

/** Start-up cleanup: rotate an oversized log right away (ignoring the counter) */
function trimNow(file, limitKB = 2048) {
  return rotate(file, Math.max(256, Number(limitKB) || 2048));
}

module.exports = { append, rotate, trimNow };
