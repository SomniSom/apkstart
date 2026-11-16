'use strict';
/**
 * APK metadata extraction: package / version / label / launch activity / icon / ABI
 * Fully offline: no aapt, no adb, no network.
 */
const fs = require('fs');
const { ZipFile } = require('./zip');
const { parseAxml, attr, attrValue, children } = require('./axml');
const { ResTable } = require('./arsc');

const LAUNCHER_ACTIONS = ['android.intent.action.MAIN'];
const LAUNCHER_CATS = ['android.intent.category.LAUNCHER'];

function isLauncherActivity(node) {
  const filters = children(node, 'intent-filter');
  for (const f of filters) {
    const actions = children(f, 'action').map((a) => attrValue(a, 'name'));
    const cats = children(f, 'category').map((c) => attrValue(c, 'name'));
    const hasMain = actions.some((a) => LAUNCHER_ACTIONS.includes(a));
    const hasLauncher = cats.some((c) => LAUNCHER_CATS.includes(c));
    if (hasMain && hasLauncher) return true;
  }
  return false;
}

function pickIconFromZip(zip) {
  // Fallback: the largest icon-looking bitmap under res/ (png / webp / jpg)
  const candidates = zip.names().filter((n) => /^res\/.*\.(png|webp|jpe?g)$/i.test(n));
  const scored = candidates.map((n) => {
    const e = zip.entries.get(n);
    let s = e.uncompSize;
    if (/ic_launcher|app_icon|ic_app/i.test(n)) s *= 6;
    if (/_round|_foreground|_background/i.test(n)) s *= 0.4;
    if (/xxxhdpi/i.test(n)) s *= 1.6;
    else if (/xxhdpi/i.test(n)) s *= 1.4;
    else if (/xhdpi/i.test(n)) s *= 1.2;
    if (/\//.test(n.split('/')[1] || '')) { /* noop */ }
    return { n, s };
  }).sort((a, b) => b.s - a.s);
  for (const c of scored.slice(0, 30)) {
    try {
      const data = zip.read(c.n);
      if (data && data.length > 100) return { data, file: c.n };
    } catch (_) { /* ignore */ }
  }
  return null;
}

const IMG_RE = /\.(png|webp|jpe?g)$/i;

/** Take a drawable / src reference from a node and resolve it to a path inside the APK */
function drawableFileOf(node, res) {
  for (const name of ['drawable', 'src']) {
    const a = attr(node, name);
    if (!a) continue;
    if (a.refId && res) {
      const f = res.resolve(a.refId, 'file');
      if (f) return f;
    } else if (typeof a.typed === 'string') {
      return a.typed;
    }
  }
  return null;
}

/**
 * Find a usable bitmap in the icon XML tree. Depth-first, expanding at most 3 levels:
 * Modern icons often look like `<adaptive-icon><foreground><inset><drawable/></inset></foreground>`
 * or `<layer-list><item><bitmap android:src="@drawable/x"/></item></layer-list>`,
 * so looking one level deep lands on the brand placeholder.
 */
function iconFromNode(zip, node, res, depth = 0) {
  const file = drawableFileOf(node, res);
  if (file) {
    if (IMG_RE.test(file) && zip.has(file)) {
      const data = zip.read(file);
      if (data && data.length > 100) return { data, file };
    }
    if (/\.xml$/i.test(file) && depth < 3 && zip.has(file)) {
      const inner = iconFromXml(zip, zip.read(file), res, depth + 1);
      if (inner) return inner;
    }
  }
  for (const c of node.children || []) {
    const hit = iconFromNode(zip, c, res, depth);
    if (hit) return hit;
  }
  return null;
}

/** Pick the foreground/background bitmap from adaptive-icon / layer-list XML */
function iconFromXml(zip, xmlBuffer, res, depth = 0) {
  let root;
  try {
    root = parseAxml(xmlBuffer);
  } catch (_) {
    return null;
  }
  // First the canonical order: foreground → background → monochrome
  for (const key of ['foreground', 'background', 'monochrome']) {
    const node = root.children.find((c) => c.name === key) || (root.name === key ? root : null);
    if (!node) continue;
    const hit = iconFromNode(zip, node, res, depth);
    if (hit) return hit;
  }
  // Then scan the whole tree (layer-list / bitmap / inset have no fixed child names)
  return iconFromNode(zip, root, res, depth);
}

/**
 * Parse the metadata of one APK.
 * Uses the file-based ZIP reader (central directory + entries on demand), so no full APK in RAM:
 * the old readFileSync approach failed on packages above 2 GB (Node Buffer cap)
 * and large packages were OOM-killed on small machines.
 */
function parseApk(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size < 1024) throw new Error('File too small to be a valid APK');
  const zip = new ZipFile(filePath);
  try {
    return parseApkZip(zip, filePath, stat);
  } finally {
    zip.close();
  }
}

/** parseApk body: the caller closes the zip */
function parseApkZip(zip, filePath, stat) {
  if (!zip.has('AndroidManifest.xml')) {
    throw new Error('AndroidManifest.xml missing: not a single APK (maybe a .apks/.xapk bundle)');
  }

  const manifestBuf = zip.read('AndroidManifest.xml');
  const manifest = parseAxml(manifestBuf);

  // package is a NON-namespaced attribute on <manifest> (ns=''), so search any namespace:
  // attrValue defaults to the android namespace; null means any namespace.
  const packageName = attrValue(manifest, 'package', null);
  if (!packageName) throw new Error('No package name in the manifest');

  const versionName = attrValue(manifest, 'versionName') || '1.0';
  const versionCodeRaw = attrValue(manifest, 'versionCode');
  const versionCode = typeof versionCodeRaw === 'number' ? versionCodeRaw : 0;

  const usesSdk = children(manifest, 'uses-sdk')[0];
  const minSdk = usesSdk ? (attrValue(usesSdk, 'minSdkVersion') | 0) : 0;
  const targetSdk = usesSdk ? (attrValue(usesSdk, 'targetSdkVersion') | 0) : 0;

  const app = children(manifest, 'application')[0] || { children: [], attrs: [] };

  // ---- resource table (for @0x7f references) ----
  let res = null;
  if (zip.has('resources.arsc')) {
    try { res = new ResTable(zip.read('resources.arsc')); } catch (_) { res = null; }
  }

  // ---- app label ----
  let label = null;
  const labelAttr = attr(app, 'label');
  if (labelAttr) {
    if (labelAttr.refId && res) label = res.resolve(labelAttr.refId, 'string');
    else if (typeof labelAttr.typed === 'string') label = labelAttr.typed;
  }
  if (!label || typeof label !== 'string') {
    label = packageName.split('.').pop();
    label = label.charAt(0).toUpperCase() + label.slice(1);
  }

  // ---- launch activity ----
  let launchActivity = null;
  const acts = children(app, 'activity').concat(children(app, 'activity-alias'));
  const launcher = acts.find(isLauncherActivity);
  if (launcher) {
    const n = attrValue(launcher, 'name');
    const target = attrValue(launcher, 'targetActivity');
    if (n) {
      if (n.startsWith('.')) launchActivity = packageName + n;
      else if (!n.includes('.')) launchActivity = `${packageName}.${n}`;
      else launchActivity = n;
      if (launcher.name === 'activity-alias' && target) {
        launchActivity = target.startsWith('.') ? packageName + target : target;
      }
    }
  }

  // ---- icon ----
  let icon = null;
  const iconAttr = attr(app, 'icon') || attr(app, 'roundIcon');
  if (iconAttr) {
    let file = null;
    if (iconAttr.refId && res) file = res.resolve(iconAttr.refId, 'file');
    else if (typeof iconAttr.typed === 'string') file = iconAttr.typed;

    if (file && zip.has(file)) {
      if (/\.xml$/i.test(file)) {
        icon = iconFromXml(zip, zip.read(file), res);
      } else {
        icon = { data: zip.read(file), file };
      }
    }
  }
  if (!icon) icon = pickIconFromZip(zip);

  // ---- ABIs (can the x86 runtime run ARM native libs directly?) ----
  const abis = [...new Set(zip.names()
    .filter((n) => n.startsWith('lib/'))
    .map((n) => n.split('/')[1])
    .filter(Boolean))];

  return {
    ok: true,
    filePath,
    sizeBytes: stat.size,
    package: packageName,
    label: String(label).replace(/\s+/g, ' ').trim().slice(0, 60),
    versionName: String(versionName),
    versionCode,
    minSdk,
    targetSdk,
    launchActivity,
    abis,
    iconPng: icon ? icon.data : null,
    iconFile: icon ? icon.file : null,
  };
}

/** Cheap check: does it start with PK\x03\x04 */
function quickCheck(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    fs.closeSync(fd);
    return b[0] === 0x50 && b[1] === 0x4b;
  } catch (_) {
    return false;
  }
}

module.exports = { parseApk, quickCheck };
