'use strict';
/**
 * Downloader: redirects, resume, progress callbacks, SHA-256 verification
 * Depends on http/https only; usable from the main process and plain Node tests.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const UA = 'ApkStart/0.2 (Windows; +https://github.com/apkstart)';

function openStream(url, { method = 'GET', headers = {}, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'));
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method,
      timeout: 30000,
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...headers },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(openStream(next, { method, headers, redirects: redirects + 1 }));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Connection timed out')); });
    req.end();
  });
}

async function head(url) {
  try {
    const res = await openStream(url, { method: 'HEAD' });
    res.resume();
    return {
      status: res.statusCode,
      size: Number(res.headers['content-length']) || 0,
      type: res.headers['content-type'] || '',
    };
  } catch (e) {
    return { status: 0, size: 0, error: e.message };
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/**
 * Discard everything a failed download leaves behind (partial file + chunk sidecar).
 *
 * Cause of endless re-downloads: every failure path used to throw without deleting files, so tmp kept
 * a half zip + .chunks.json forever. The next run resumed with Range, and whenever the server's
 * total size or chunking differed the bytes did not line up → fail again →
 * another partial file… every start re-downloaded the same package. Resume itself is fine, but only when
 * resuming is confirmed; once an attempt fails the whole file is dropped and the next run starts clean.
 */
function discardPartial(dest) {
  for (const p of [dest, `${dest}.chunks.json`, `${dest}.part`]) {
    try { fs.rmSync(p, { force: true }); } catch (_) { /* in use — leave it */ }
  }
}

/**
 * Download to a local file (resume automatically).
 * @param {string} url
 * @param {string} dest
 * @param {object} opt { onProgress({got,total,percent,speed}), signal, expectSha256, timeoutMs }
 */
async function download(url, dest, opt = {}) {
  const { onProgress = () => {}, signal, expectSha256, retries = 2 } = opt;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let attempt = 0;
  try {
  for (;;) {
    attempt++;
    const existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const headers = {};
    if (existing > 0) headers.Range = `bytes=${existing}-`;

    // eslint-disable-next-line no-await-in-loop
    const res = await openStream(url, { headers });

    if (res.statusCode === 416) {
      res.resume();
      // already complete
      break;
    }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.resume();
      if (attempt <= retries) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      discardPartial(dest);   // retries exhausted: never leave a bad file for the next resume
      throw new Error(`Download failed HTTP ${res.statusCode}: ${url}`);
    }

    const total = res.statusCode === 206
      ? existing + (Number(res.headers['content-length']) || 0)
      : Number(res.headers['content-length']) || 0;

    if (res.statusCode === 200 && existing > 0) {
      // server does not support resume — write from scratch
      fs.rmSync(dest, { force: true });
    }

    try {
      await new Promise((resolve, reject) => {
        const startSize = res.statusCode === 206 ? existing : 0;
        let got = startSize;
        let lastTick = Date.now();
        let lastBytes = got;
        const ws = fs.createWriteStream(dest, { flags: startSize > 0 ? 'a' : 'w' });

        // As with chunked downloads, the promise must always settle.
        // On a silent connection (blocked/throttled) res neither ends nor errors and pipe never finishes,
        // so the download hangs: the progress bar freezes and nothing is reported.
        const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 30000;
        let settled = false;
        let idle = null;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          if (idle) clearTimeout(idle);
          try { ws.destroy(); } catch (_) { /* ignore */ }
          if (err) reject(err); else resolve();
        };
        const kick = () => {
          if (settled) return;
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => {
            res.destroy();
            finish(new Error('Connection stalled (no data for a long time)'));
          }, idleMs);
        };
        kick();

        const onAbort = () => { res.destroy(new Error('Cancelled')); };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        res.on('data', (c) => {
          got += c.length;
          kick();
          const now = Date.now();
          if (now - lastTick > 400) {
            const speed = (got - lastBytes) / ((now - lastTick) / 1000);
            lastTick = now;
            lastBytes = got;
            onProgress({
              got, total,
              percent: total ? Math.min(100, (got / total) * 100) : 0,
              speed,
              eta: total && speed > 0 ? Math.max(0, (total - got) / speed) : null,
            });
          }
        });
        res.pipe(ws);
        ws.on('finish', () => finish());
        ws.on('error', (e) => finish(e));
        res.on('error', (e) => finish(e));
        res.on('close', () => { if (!res.complete) finish(new Error('Connection interrupted')); });
      });
    } catch (e) {
      discardPartial(dest);   // interrupted / timed out / write failed: a partial file only breaks the next resume
      throw e;
    }

    break;
  }

  // wrap up: make sure the progress bar reaches 100%
  const finalSize = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  onProgress({ got: finalSize, total: finalSize, percent: 100, speed: 0, eta: 0 });

  if (expectSha256) {
    const actual = await sha256File(dest);
    if (actual.toLowerCase() !== expectSha256.toLowerCase()) {
      discardPartial(dest);
      throw new Error(`Checksum mismatch: expected ${expectSha256.slice(0, 12)}… got ${actual.slice(0, 12)}…`);
    }
  }
  return { file: dest, size: fs.statSync(dest).size };
  } catch (e) {
    // A direct openStream reject (refused / DNS failure / timeout) never reaches the write stage —
    // catch everything at the outer level so any throw first discards the remains.
    discardPartial(dest);
    throw e;
  }
}

/**
 * Parallel chunked download (large files only).
 * Some mirrors throttle a single TCP connection to tens of KB/s; parallel chunks raise real throughput.
 * Parallel only when the target does not exist; a partial file falls back to single-stream resume.
 */
async function downloadParallel(url, dest, opt = {}) {
  const {
    connections = 8,
    onProgress = () => {},
    minChunk = 1024 * 1024,
    retries = 3,
  } = opt;

  // partial file present — hand over to single-stream resume
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return download(url, dest, opt);
  }

  // probe Range support
  let total = 0;
  let supportsRange = false;
  try {
    const probe = await openStream(url, { headers: { Range: 'bytes=0-0' } });
    const cr = probe.headers['content-range'];
    if (probe.statusCode === 206 && cr) {
      supportsRange = true;
      total = Number(/\/(\d+)$/.exec(cr)[1]) || 0;
    } else {
      total = Number(probe.headers['content-length']) || 0;
    }
    probe.destroy();
  } catch (_) { /* probe failed — use a single stream */ }

  if (!supportsRange || !total || total < minChunk * 2) {
    return download(url, dest, opt);
  }

  const n = Math.max(1, Math.min(connections, Math.ceil(total / minChunk)));
  const per = Math.ceil(total / n);
  const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 20000;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { force: true });

  // Create the file and seek to its end first so later writes stay in range
  const fd = fs.openSync(dest, 'w');
  fs.ftruncateSync(fd, total);

  const chunks = Array.from({ length: n }, (_, i) => {
    const start = i * per;
    const end = Math.min(total - 1, start + per - 1);
    return { start, end, pos: start, done: false, tries: 0 };
  });

  let got = 0;
  let lastTick = Date.now();
  let lastBytes = 0;
  const tick = () => {
    const now = Date.now();
    if (now - lastTick < 400) return;
    const speed = (got - lastBytes) / ((now - lastTick) / 1000);
    lastTick = now;
    lastBytes = got;
    onProgress({
      got, total,
      percent: Math.min(100, (got / total) * 100),
      speed,
      eta: speed > 0 ? Math.max(0, (total - got) / speed) : null,
    });
  };

  const fetchChunk = async (c) => {
    const res = await openStream(url, { headers: { Range: `bytes=${c.pos}-${c.end}` } });
    if (res.statusCode !== 206) {
      res.resume();
      throw new Error(`Chunk request rejected HTTP ${res.statusCode}`);
    }
    await new Promise((resolve, reject) => {
      // Guard against a promise that never settles: res.destroy(err) can emit
      // close without error, which would hang one chunk and freeze the whole download.
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        if (err) reject(err); else resolve();
      };
      let idle = setTimeout(() => { res.destroy(); finish(new Error('Connection stalled (no data for a long time)')); }, idleMs);
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { res.destroy(); finish(new Error('Connection stalled (no data for a long time)')); }, idleMs);
      };
      res.on('data', (buf) => {
        try {
          fs.writeSync(fd, buf, 0, buf.length, c.pos);
        } catch (e) {
          res.destroy();
          return finish(e);
        }
        c.pos += buf.length;
        got += buf.length;
        kick();
        tick();
      });
      res.on('end', () => finish());
      res.on('error', (e) => finish(e));
      res.on('close', () => finish(new Error('Connection interrupted')));
    });
    return c.pos > c.end;
  };

  try {
    await Promise.all(chunks.map(async (c) => {
      for (;;) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const ok = await fetchChunk(c);
          if (ok) return;
          throw new Error('Chunk returned incomplete');
        } catch (e) {
          c.tries += 1;
          if (c.tries >= retries) throw new Error(`Chunk download failed (${c.start}-${c.end}): ${e.message}`);
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 800 * c.tries));
        }
      }
    }));
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    discardPartial(dest);   // drop the whole file; never resume from a broken one
    throw e;
  }
  fs.closeSync(fd);

  const size = fs.statSync(dest).size;
  onProgress({ got: size, total: size, percent: 100, speed: 0, eta: 0 });
  if (size !== total) {
    discardPartial(dest);
    throw new Error(`Incomplete download: ${size}/${total} bytes`);
  }
  return { file: dest, size, parallel: n };
}

/** Try sources in order and return on the first success */
async function downloadAny(urls, dest, opt = {}) {
  const errors = [];
  for (const u of urls) {
    discardPartial(dest);   // clear the previous source's partial file (bytes from different sources must not mix)
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await download(u, dest, opt);
      return { ...r, url: u };
    } catch (e) {
      errors.push(`${u} → ${e.message}`);
      discardPartial(dest);
    }
  }
  throw new Error(`All download sources failed:\n${errors.join('\n')}`);
}

/**
 * Multi-source download: split the file into chunks and pull different chunks from different sources.
 *
 * Why: GitHub throttles single connections and mirrors throttle too;
 * eight connections to one host cap at that host. Four to GitHub and four to a mirror
 * add up — measured twice as fast.
 *
 * Safety: only sources that declare the same total size are mixed, otherwise the file would be corrupt;
 * chunks of a failing source move to the next address automatically (no full restart).
 */
async function downloadMulti(urls, dest, opt = {}) {
  const {
    connections = 8,
    onProgress = () => {},
    minChunk = 2 * 1024 * 1024,
    // Retries per chunk. Three was not enough with two flaky sources out of three:
    // one exhausted chunk dropped a 1.4 GB runtime. Six (two rounds per source).
    // Retries resume from c.pos, so received bytes are not downloaded twice.
    retries = 6,
  } = opt;
  const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 20000;

  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) throw new Error('No download address available');
  if (list.length === 1) return downloadParallel(list[0], dest, opt);

  // 1) parallel probe: total size + Range support
  const probes = await Promise.all(list.map(async (u) => {
    try {
      const res = await openStream(u, { headers: { Range: 'bytes=0-0' } });
      const cr = res.headers['content-range'];
      const total = res.statusCode === 206 && cr ? Number(/\/(\d+)$/.exec(cr)[1]) || 0 : 0;
      res.destroy();
      return { url: u, total, ranged: !!total };
    } catch (_) {
      return { url: u, total: 0, ranged: false };
    }
  }));

  const usable = probes.filter((p) => p.ranged && p.total > 0);
  if (!usable.length) {
    return downloadAnyParallel(list, dest, opt);
  }
  // Only mix sources that declare the same total size, otherwise the file is corrupt.
  // The baseline is the total size of the FASTEST source (usable is speed-ranked,
  // Promise.all keeps the input order):
  // GitHub and Gitee packages differ by a few MB,
  // and taking Math.max always picked the bigger one — on slow networks
  // the faster Gitee package got excluded in favour of the slow GitHub one.
  const total = usable[0].total;
  const same = usable.filter((p) => p.total === total);
  if (same.length === 1 || total < minChunk * 2) {
    return downloadParallel(same[0].url, dest, opt);
  }

  // 2) split into chunks, assign sources round-robin
  const n = Math.max(2, Math.min(connections, Math.ceil(total / minChunk)));
  const per = Math.ceil(total / n);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // Chunked resume: on flaky mirrors a 1.4 GB package easily exhausts chunk retries,
  // and a full restart costs another fifteen minutes. Finished chunks are recorded in
  // a sidecar file, so the next run (same path and chunking) fetches only the gaps.
  const meta = `${dest}.chunks.json`;
  let doneSet = new Set();
  let resume = false;
  try {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (m && m.total === total && m.n === n && fs.existsSync(dest) && fs.statSync(dest).size === total) {
      doneSet = new Set(m.done || []);
      resume = true;
    }
  } catch (_) { /* no sidecar — start fresh */ }

  if (!resume) {
    fs.rmSync(dest, { force: true });
    fs.rmSync(meta, { force: true });
  }
  const fd = resume ? fs.openSync(dest, 'r+') : fs.openSync(dest, 'w');
  if (!resume) fs.ftruncateSync(fd, total);

  const chunks = Array.from({ length: n }, (_, i) => ({
    start: i * per,
    end: Math.min(total - 1, i * per + per - 1),
    pos: i * per,
    src: i % same.length,
    tries: 0,
    rotates: 0,   // must be initialised: undefined < 2 is false and source rotation never fires
  })).filter((c) => !doneSet.has(c.start));

  const saveMeta = () => {
    try {
      fs.writeFileSync(meta, JSON.stringify({ total, n, done: [...doneSet] }));
    } catch (_) { /* a sidecar write failure does not stop the download */ }
  };

  // Count finished chunks into the progress so the percentage does not restart at 0
  let got = resume ? [...doneSet].reduce((sum, start) => (
    sum + (Math.min(total - 1, start + per - 1) - start + 1)
  ), 0) : 0;
  let lastTick = Date.now();
  let lastBytes = got;
  const tick = (force) => {
    const now = Date.now();
    if (!force && now - lastTick < 400) return;
    const speed = (got - lastBytes) / Math.max(0.001, (now - lastTick) / 1000);
    lastTick = now;
    lastBytes = got;
    onProgress({
      got,
      total,
      percent: Math.min(100, (got / total) * 100),
      speed,
      eta: speed > 0 ? Math.max(0, (total - got) / speed) : null,
      sources: same.length,
    });
  };

  // Slow-source rotation: a chunk crawling at tens of KB/s drags the whole download to
  // 'stuck at 95%'. After slowAfterMs below slowBps it is aborted and moved to the next source
  // (resuming from c.pos). Two rotations per chunk at most, to avoid ping-ponging.
  const slowAfterMs = Number(opt.slowAfterMs) > 0 ? Number(opt.slowAfterMs) : 45000;
  const slowBps = Number(opt.slowBps) > 0 ? Number(opt.slowBps) : 120 * 1024;

  const fetchChunk = async (c) => {
    const url = same[c.src % same.length].url;
    const res = await openStream(url, { headers: { Range: `bytes=${c.pos}-${c.end}` } });
    if (res.statusCode !== 206) {
      res.resume();
      throw new Error(`Chunk rejected HTTP ${res.statusCode}`);
    }
    const startPos = c.pos;
    const startedAt = Date.now();
    // After destroy, a connection may still deliver buffered packets and rotate the source twice,
    // so each request may rotate only once.
    let rotated = false;
    await new Promise((resolve, reject) => {
      // Idle watchdog + guaranteed settle: the connection is up but no byte arrives (typical
      // 'TCP open but blocked/throttled'); the socket timeout alone takes 30 s, and res.destroy(err)
      // may emit close without error so the promise never rejects — one chunk hangs and
      // the download stalls (seen in practice). Hence the watchdog calls finish itself.
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        if (err) reject(err); else resolve();
      };
      let idle = setTimeout(() => { res.destroy(); finish(new Error('Connection stalled (no data for a long time)')); }, idleMs);
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { res.destroy(); finish(new Error('Connection stalled (no-data timeout)')); }, idleMs);
      };
      res.on('data', (buf) => {
        try {
          fs.writeSync(fd, buf, 0, buf.length, c.pos);
        } catch (e) {
          res.destroy();
          return finish(e);
        }
        c.pos += buf.length;
        got += buf.length;
        kick();
        tick(false);
        // Not done and too slow → rotate (c.pos advanced, resume from there)
        const took = Date.now() - startedAt;
        if (!rotated && took > slowAfterMs && (c.rotates || 0) < 2 && c.pos <= c.end) {
          const bps = (c.pos - startPos) / (took / 1000);
          if (bps < slowBps) {
            rotated = true;
            c.rotates = (c.rotates || 0) + 1;
            // c.src is not advanced here: the catch below rotates, otherwise one failure would skip two sources
            res.destroy();
            finish(new Error(`Source too slow (${(bps / 1024).toFixed(0)} KB/s), switching`));
          }
        }
      });
      res.on('end', () => finish());
      res.on('error', (e) => finish(e));
      res.on('close', () => finish(new Error('Connection interrupted')));
    });
    return c.pos > c.end;
  };

  try {
    await Promise.all(chunks.map(async (c) => {
      for (;;) {
        try {
          // eslint-disable-next-line no-await-in-loop
          if (await fetchChunk(c)) {
            doneSet.add(c.start);
            saveMeta();
            return;
          }
          throw new Error('Chunk returned incomplete');
        } catch (e) {
          c.tries += 1;
          if (c.tries >= retries) {
            // Retries exhausted: the file already mixes chunks from different sources and can
            // never assemble correctly. Drop the file and the sidecar; start clean next time.
            // It used to saveMeta() instead, so every start resumed from a bad chunk → endless re-download.
            discardPartial(dest);
            throw new Error(`Chunk failed (${c.start}-${c.end}): ${e.message}`);
          }
          // Try another source: one flaky mirror must not fail the whole download
          c.src += 1;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 600 * c.tries));
        }
      }
    }));
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    discardPartial(dest);
    throw e;
  }
  fs.closeSync(fd);
  fs.rmSync(meta, { force: true });

  const size = fs.statSync(dest).size;
  tick(true);
  if (size !== total) {
    discardPartial(dest);
    throw new Error(`Incomplete download: ${size}/${total} bytes`);
  }
  return { file: dest, size, parallel: n, sources: same.length, multi: true, resumed: resume };
}

/** Try several sources in order (parallel chunked) and return on the first success */
async function downloadAnyParallel(urls, dest, opt = {}) {
  const errors = [];
  for (const u of urls) {
    discardPartial(dest);   // clear the previous source's partial file
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await downloadParallel(u, dest, opt);
      return { ...r, url: u };
    } catch (e) {
      errors.push(`${u} → ${e.message}`);
      discardPartial(dest);
    }
  }
  throw new Error(`All download sources failed:\n${errors.join('\n')}`);
}

module.exports = {
  download, downloadAny, downloadParallel, downloadAnyParallel, downloadMulti,
  head, sha256File, openStream, discardPartial,
};
