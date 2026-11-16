'use strict';
/**
 * Mirror a release onto Gitee.
 *
 * Why this script exists: Gitee caps a single attachment at 100 MB (104,800,000 bytes
 * uploads fine). A 7-Zip-compressed portable build is ~99.6 MB, so one complete zip can
 * be uploaded and users just unpack it — no part1/part2 that must be concatenated in
 * order and is unusable for manual downloads. Splitting happens only when the limit is
 * really exceeded, and the app's updater accepts both.
 * The installer (1.4 GB) and the full runtime package (1.4 GB) stay on GitHub; the app
 * unions assets across sources, so updates are unaffected.
 *
 * Usage:
 *   GITEE_TOKEN=xxxx node tools/publish-gitee.js v0.3.3 D:/dist
 *     v0.3.3   tag to publish (must already be pushed to Gitee)
 *     /tmp/dist   holds ApkStart-v0.3.3-linux-x64-portable.zip (optional; --zip overrides)
 *
 *   node tools/publish-gitee.js v0.3.3 --zip D:/x.zip --notes notes.md
 */
const fs = require('fs');
const path = require('path');

const OWNER = 'daily-miku';
const REPO = 'apkstart';
const API = `https://gitee.com/api/v5/repos/${OWNER}/${REPO}`;
const HARD_LIMIT = 100 * 1024 * 1024;  // Gitee attachment limit (100 MiB, verified)
const PART_LIMIT = 99 * 1024 * 1024;   // Part size when splitting, leaving 1 MB for multipart headers

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
}

async function api(method, p, body) {
  const token = process.env.GITEE_TOKEN;
  if (!token) throw new Error('the GITEE_TOKEN environment variable is missing');
  const url = `${API}${p}${p.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* may be an empty body */ }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text.slice(0, 300)}`);
  return json || {};
}

/** Split a large file; returns the part paths */
function splitFile(file, limit) {
  const size = fs.statSync(file).size;
  if (size <= limit) return [];
  const fd = fs.openSync(file, 'r');
  const out = [];
  try {
    let index = 1;
    let offset = 0;
    while (offset < size) {
      const len = Math.min(limit, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const p = `${file}.part${index}`;
      fs.writeFileSync(p, buf);
      out.push(p);
      offset += len;
      index += 1;
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

/**
 * Upload one attachment.
 * A 95 MB package goes up in a single POST (Gitee has no chunked upload API) and a
 * flaky link easily fails halfway. Retries were missing before, and one blip meant
 * re-running the whole command and cleaning old attachments again. Hence 3 retries
 * with backoff.
 */
async function upload(releaseId, file, attempts = 3) {
  const token = process.env.GITEE_TOKEN;
  const name = path.basename(file);
  const buf = fs.readFileSync(file);
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const fd = new FormData();
      fd.append('access_token', token);
      fd.append('file', new Blob([buf]), name);
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${API}/releases/${releaseId}/attach_files`, { method: 'POST', body: fd });
      // eslint-disable-next-line no-await-in-loop
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      // 4xx (except 429) is not worth retrying: a bad token or name clash stays broken
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(`uploading ${name} failed: ${res.status} ${text.slice(0, 200)}`);
      }
      lastErr = new Error(`${res.status} ${text.slice(0, 120)}`);
    } catch (e) {
      lastErr = e;
      if (/^uploading .* failed/.test(e.message)) throw e;
    }
    if (i < attempts) {
      const wait = i * 8;
      console.warn(`   upload attempt ${i} failed (${lastErr.message}), retrying in ${wait}s...`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  throw new Error(`uploading ${name} failed after ${attempts} attempts: ${lastErr && lastErr.message}`);
}

(async () => {
  const tag = process.argv[2];
  if (!tag || !/^v\d/.test(tag)) {
    console.error('usage: GITEE_TOKEN=xxx node tools/publish-gitee.js v0.3.3 [--zip path] [--notes file]');
    process.exit(1);
  }
  const dir = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '';
  let zip = arg('--zip', '');
  if (!zip && dir) {
    const hit = fs.existsSync(dir)
      ? fs.readdirSync(dir).find((n) => /portable\.zip$/i.test(n))
      : '';
    if (hit) zip = path.join(dir, hit);
  }
  if (!zip || !fs.existsSync(zip)) {
    console.error(`portable package not found: ${zip || '(not given)'}; pass --zip or put the zip in ${dir}`);
    process.exit(1);
  }
  const notesFile = arg('--notes', '');
  const body = notesFile && fs.existsSync(notesFile)
    ? fs.readFileSync(notesFile, 'utf8')
    : `Portable build (one zip, unpack and run; the app can update itself). Installer and full runtime stay on GitHub Releases.`;

  console.log('1) find or create the release', tag);
  const list = await api('GET', `/releases?per_page=50`);
  let rel = (Array.isArray(list) ? list : []).find((r) => r.tag_name === tag);
  if (!rel) {
    rel = await api('POST', '/releases', {
      tag_name: tag,
      name: tag,
      target_commitish: 'main',
      body,
    });
    console.log('   created id =', rel.id);
  } else {
    console.log('   exists, id =', rel.id);
  }

  // Re-publishing a version must first delete old attachments, otherwise both old and
  // new part1/part2 hang on the page and the client grabs one at random.
  if (process.argv.includes('--replace')) {
    console.log('2) removing stale attachments');
    const list = await api('GET', `/releases/${rel.id}/attach_files`);
    const olds = (Array.isArray(list) ? list : []).filter((a) => /^ApkStart-.*\.zip(\.part\d+)?$/i.test(a.name || ''));
    for (const a of olds) {
      // eslint-disable-next-line no-await-in-loop
      await api('DELETE', `/releases/${rel.id}/attach_files/${a.id}`);
      console.log('   deleting', a.name);
    }
  }

  const zipSize = fs.statSync(zip).size;
  if (zipSize > HARD_LIMIT) {
    console.warn(`! portable package is ${(zipSize / 1048576).toFixed(1)} MB, over the Gitee limit; splitting into parts.`
      + ' Manual downloads must be concatenated in order — squeeze with `node build/zip.js` or slim the package.');
  }
  console.log('3) preparing the upload (whole file first, split only if needed)');
  const parts = splitFile(zip, PART_LIMIT);
  const files = parts.length ? parts : [zip];

  // The packaging style may change between runs (whole file vs parts): delete the other
  // form so `x.zip` and `x.zip.part1/part2` never coexist. --replace clears other
  // versions too; this clears only the other form of the current package name.
  {
    const base = path.basename(zip).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const other = parts.length ? new RegExp(`^${base}$`, 'i') : new RegExp(`^${base}\\.part\\d+$`, 'i');
    const list = await api('GET', `/releases/${rel.id}/attach_files`);
    for (const a of Array.isArray(list) ? list : []) {
      if (!other.test(a.name || '')) continue;
      // eslint-disable-next-line no-await-in-loop
      await api('DELETE', `/releases/${rel.id}/attach_files/${a.id}`);
      console.log('   deleting the previous form', a.name);
    }
  }

  for (const f of files) {
    console.log(`   uploading ${path.basename(f)} (${(fs.statSync(f).size / 1048576).toFixed(1)} MB)`);
    // eslint-disable-next-line no-await-in-loop
    await upload(rel.id, f);
  }
  for (const p of parts) fs.rmSync(p, { force: true });
  console.log(`\ndone: https://gitee.com/${OWNER}/${REPO}/releases/tag/${tag}`);
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
