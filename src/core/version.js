'use strict';
/**
 * Version comparison. Kept in its own module so updater ↔ sources
 * do not require each other and form a cycle.
 */

/** v0.3.2 / 0.3.2-preview / 1.0.0+build → an array that compares in order */
function parseVer(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((x) => (/^\d+$/.test(x) ? Number(x) : x))
    .filter((x) => x !== '');
}

/** a>b → 1, a<b → -1, equal → 0 */
function cmpVer(a, b) {
  const A = parseVer(a);
  const B = parseVer(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i += 1) {
    const x = A[i];
    const y = B[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1;
    } else {
      const sx = String(x);
      const sy = String(y);
      if (sx !== sy) return sx < sy ? -1 : 1;
    }
  }
  return 0;
}

module.exports = { parseVer, cmpVer };
