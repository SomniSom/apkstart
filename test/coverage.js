'use strict';
/**
 * Pure-Node coverage guard.
 *
 * There is no instrumentation here on purpose: the project ships no test runner and takes
 * no runtime dependencies, so adding istanbul/nyc would contradict that. Instead this walks
 * `src/` and reports, per module, how many of its exported functions and classes are
 * referenced by at least one test file and the requirement is that every module is reached.
 *
 * Run: node test/coverage.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const TESTS = [
  'test/run-tests.js',
  'test/core-test.js',
  'test/engine-test.js',
  'test/auto-test.js',
  // The Electron entry points cannot be required from plain Node (they call app.whenReady
  // on load); instead a static check asserts that every UI channel they expose is wired.
  'test/ui-wiring-test.js',
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function testSource() {
  return TESTS
    .filter((f) => fs.existsSync(path.join(ROOT, f)))
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n');
}

/** Names exported by `module.exports = { ... }` or `exports.x =` */
function exportedNames(src) {
  const names = new Set();
  const block = /module\.exports\s*=\s*\{([\s\S]*?)\};/g;
  let m;
  while ((m = block.exec(src))) {
    for (const part of m[1].split(',')) {
      const key = part.split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(key)) names.add(key);
    }
  }
  const single = /module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;/g;
  while ((m = single.exec(src))) names.add(m[1]);
  const named = /exports\.([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = named.exec(src))) names.add(m[1]);
  return [...names];
}

function main() {
  const tests = testSource();
  const files = walk(SRC).filter((f) => !f.includes(`${path.sep}ui${path.sep}assets`));
  const rows = [];
  let reached = 0;

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const src = fs.readFileSync(file, 'utf8');
    const names = exportedNames(src);
    const used = names.filter((n) => {
      // The test either requires the module and calls the name, or destructures it.
      const byName = new RegExp(`\\b${n}\\b`).test(tests);
      return byName;
    });
    const base = path.basename(file, '.js');
    // Module names may appear as a string literal ("../src/main") or as a require target
    // (require('../src/core/zip')); a plain quoted-suffix match covers both.
    const imported = new RegExp(`['"][^'"]*/${base}['"]`).test(tests)
      || new RegExp(`['"][^'"]*\\/${base}['"]`).test(tests);
    // main.js / preload.js / ui/*.js cannot be required from Node (they call app.whenReady
    // or run in the renderer); their contract is checked by test/ui-wiring-test.js instead.
    const wiring = ['src/main.js', 'src/preload.js', 'src/ui/app.js', 'src/ui/shell.js'].includes(rel)
      && fs.existsSync(path.join(ROOT, 'test/ui-wiring-test.js'));
    if (imported || used.length || wiring) reached += 1;
    rows.push({
      module: rel,
      exports: names.length,
      referenced: used.length,
      imported,
      wiring: ['src/main.js', 'src/preload.js', 'src/ui/app.js', 'src/ui/shell.js'].includes(rel),
      ratio: names.length ? used.length / names.length : 1,
    });
  }

  console.log('\nmodule coverage (exports referenced by tests)\n');
  for (const r of rows.sort((a, b) => a.ratio - b.ratio)) {
    const pct = (r.ratio * 100).toFixed(0).padStart(3);
    const flag = r.imported || r.referenced || r.wiring ? ' ' : '!';
    console.log(`  ${flag} ${String(pct).padStart(3)}%  ${r.referenced}/${r.exports}`.padEnd(28) + r.module);
  }

  const total = rows.length;
  const pct = total ? (reached / total) * 100 : 0;
  console.log(`\nmodules reached by tests: ${reached}/${total} (${pct.toFixed(0)}%)`);

  const missing = rows.filter((r) => !r.imported && !r.referenced && !r.wiring);
  if (missing.length) {
    console.error(`\n${missing.length} module(s) are never imported by a test:`);
    for (const r of missing) console.error(`  - ${r.module}`);
    process.exitCode = 1;
  } else {
    console.log('every module is reached by at least one test');
  }
}

if (require.main === module) main();

module.exports = { exportedNames, walk };
