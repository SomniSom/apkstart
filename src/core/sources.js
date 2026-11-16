'use strict';
/**
 * Unified download sources: two releases hosts (GitHub / Gitee) plus mirror prefixes.
 *
 * Direct GitHub access has two pitfalls:
 *   1. api.github.com often takes tens of seconds or times out — 'checking for updates' spins forever;
 *   2. asset downloads (objects.githubusercontent.com) are throttled per connection, often ~100 KB/s —
 *      a 1.5 GB runtime bundle would take four hours.
 *
 * So no source is designated primary; every run measures real bytes:
 *   - version info: ask GitHub and Gitee CONCURRENTLY and take the higher version;
 *   - download URLs: list direct GitHub, the same asset on Gitee and mirror-prefixed copies,
 *     really fetch 128 KB from each and sort by measured speed.
 *
 * Speed results are cached for 30 minutes so repeated checks and downloads do not re-probe.
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { cmpVer } = require('./version');

const OWNER_GH = 'RoutineMiku';
const OWNER_GITEE = 'daily-miku';
const REPO = 'apkstart';

const SOURCES = {
  github: {
    id: 'github',
    name: 'GitHub',
    api: `https://api.github.com/repos/${OWNER_GH}/${REPO}`,
    web: `https://github.com/${OWNER_GH}/${REPO}`,
  },
  gitee: {
    id: 'gitee',
    name: 'Gitee',
    api: `https://gitee.com/api/v5/repos/${OWNER_GITEE}/${REPO}`,
    web: `https://gitee.com/${OWNER_GITEE}/${REPO}`,
  },
};

/** Known GitHub mirror prefixes. Probing them requires autoMirror and no custom prefix. */
const KNOWN_MIRRORS = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
];

/**
 * Sample size for one speed probe.
 * 128 KB is too small: handshake + TLS take hundreds of ms, so the 'speed' mostly measures latency
 * and labels a high-latency/high-bandwidth source slow. 256 KB separates the two at an acceptable cost.
 */
const SAMPLE_BYTES = 256 * 1024;

function openUrl(url, { timeout = 10000, headers = {}, redirects = 0, followRedirect = true } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'));
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('Invalid URL')); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method: 'GET',
      timeout,
      headers: {
        'User-Agent': 'ApkStart/0.3 (Windows)',
        'Accept-Encoding': 'identity',
        ...headers,
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && followRedirect) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        openUrl(next, { timeout, headers, redirects: redirects + 1, followRedirect }).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('Connection timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** Fetch a small JSON payload (redirects, timeout and size cap) */
async function getJson(url, timeout = 10000) {
  const res = await openUrl(url, { timeout });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error(`${new URL(url).host} ${res.statusCode}`);
  }
  const chunks = [];
  let len = 0;
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      len += c.length;
      if (len > 4 * 1024 * 1024) { res.destroy(); resolve(); return; }
      chunks.push(c);
    });
    res.on('end', resolve);
    res.on('error', reject);
  });
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Download a real byte slice to measure speed.
 * @returns {Promise<{url:string, ok:boolean, speed:number, got:number, ms:number, error?:string}>}
 */
function measure(url, { bytes = SAMPLE_BYTES, timeoutMs = 9000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let firstAt = 0;
    let got = 0;
    let settled = false;
    let req = null;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      try { req?.destroy(); } catch (_) { /* ignore */ }
      const now = Date.now();
      // Throughput counts only the time after the first byte: TLS + DNS are fixed overhead,
      // negligible for a 1.4 GB bundle but misleading in a speed number.
      const span = Math.max(1, now - (firstAt || t0));
      resolve({
        url,
        ok: ok && got > 0,
        got,
        ms: now - t0,
        ttfb: firstAt ? firstAt - t0 : 0,
        speed: ok && got > 0 ? (got / span) * 1000 : 0,
        error,
      });
    };
    const timer = setTimeout(() => done(got > 0), timeoutMs);
    if (timer.unref) timer.unref();

    openUrl(url, {
      timeout: timeoutMs,
      headers: { Range: `bytes=0-${bytes - 1}` },
    }).then((res) => {
      req = res;
      if (res.statusCode >= 400) {
        res.resume();
        clearTimeout(timer);
        done(false, `HTTP ${res.statusCode}`);
        return;
      }
      res.on('data', (c) => {
        if (!firstAt) firstAt = Date.now();
        got += c.length;
        if (got >= bytes) { clearTimeout(timer); done(true); }
      });
      // The asset is smaller than the sample: EOF counts as success
      res.on('end', () => { clearTimeout(timer); done(got > 0); });
      res.on('error', (e) => { clearTimeout(timer); done(false, e.message); });
    }).catch((e) => { clearTimeout(timer); done(false, e.message); });
  });
}

/** Prefix a GitHub asset URL with a mirror */
function withMirror(url, prefix) {
  if (!prefix || !/^https?:\/\//i.test(prefix)) return '';
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${p}${url}`;
}

/**
 * Gitee caps release attachments at 100 MB, so packages of 105-110 MB are split into
 * xxx.zip.part1 / xxx.zip.part2 and recombined here into one logical asset:
 *   { name: 'xxx.zip', size: total, parts: [{index, size, urls:[...]}] }
 * Parts must be contiguous from part1; otherwise the set is dropped (never download a broken bundle).
 */
function groupParts(assets) {
  const groups = new Map();
  const out = [];
  for (const a of assets) {
    const m = /^(.*)\.part(\d+)$/i.exec(String(a.name || ''));
    if (!m) { out.push(a); continue; }
    const base = m[1];
    const idx = Number(m[2]);
    let g = groups.get(base);
    if (!g) {
      g = { name: base, size: 0, parts: [], partial: true };
      groups.set(base, g);
      out.push(g);
    }
    let p = g.parts.find((x) => x.index === idx);
    if (!p) {
      p = { index: idx, size: Number(a.size) || 0, urls: [] };
      g.parts.push(p);
    }
    if (a.url && !p.urls.includes(a.url)) p.urls.push(a.url);
    if (!p.size) p.size = Number(a.size) || 0;
  }
  for (const g of groups.values()) {
    g.parts.sort((x, y) => x.index - y.index);
    const contiguous = g.parts.every((p, i) => p.index === i + 1);
    g.size = g.parts.reduce((n, p) => n + (Number(p.size) || 0), 0);
    // Note: Gitee release assets carry name/url only — NO size.
    // Requiring size>0 would drop the whole set (seen in practice),
    // so only contiguity and an address per part are required; unknown size shows bytes received.
    if (!contiguous || !g.parts.every((p) => p.urls.length)) g.broken = true;
  }
  return { list: out.filter((a) => !a.broken), broken: [...groups.values()].filter((g) => g.broken).map((g) => g.name) };
}

/** Mirror list: user-defined first, then built-in (autoMirror off = custom only) */
function mirrorList(settings) {
  const r = (settings && settings.runtime) || {};
  const custom = String(r.mirrorPrefix || process.env.APKSTART_MIRROR || '').trim();
  if (custom) return [custom];
  if (r.autoMirror === false) return [];
  return KNOWN_MIRRORS.slice();
}

class Sources {
  constructor(settingsFn) {
    this.settings = typeof settingsFn === 'function' ? settingsFn : () => ({});
    this._rankCache = new Map();   // url -> {at, speed, ok}
    this._rankTtl = 30 * 60 * 1000;
    // Version-check cache: anonymous Gitee calls are rate limited hard (403 after a few),
    // and 'is there a new version' needs no second-level freshness.
    this._relCache = { at: 0, key: '', value: null };
    this._relTtl = 10 * 60 * 1000;
    // Circuit breaker: after a rate limit/error a source is skipped for a while
    this._blocked = new Map();     // sourceId -> until(ms)
    this._blockMs = 15 * 60 * 1000;
  }

  /** Is the source tripped? null = usable, otherwise a reason for the UI */
  blockedReason(id) {
    const until = this._blocked.get(id) || 0;
    if (until <= Date.now()) return null;
    return `Skipped for now (no retry for ${Math.ceil((until - Date.now()) / 60000)} min)`;
  }

  /** Latest release per source (concurrent; one failure does not affect the other) */
  /**
   * API-free fallback: follow the 302 of `/releases/latest` to learn the tag.
   *
   * Why it is needed: the anonymous GitHub API allows 60 calls per IP per hour,
   * Gitee is stricter still (403 Rate Limit Exceeded after a few clicks).
   * Behind corporate/campus networks or carrier NAT, 'update check failed' is common —
   * while the `releases/latest` redirect goes through a CDN and costs no quota.
   *
   * With the tag, asset names can be built from the release conventions:
   *   ApkStart-<tag>-win64-portable.zip / ApkStart-<version>-Setup.exe / ApkStart-runtime-<tag>.zip
   */
  async _releaseTagViaRedirect(id) {
    const s = SOURCES[id];
    const page = `${s.web}/releases/latest`;
    const res = await openUrl(page, { timeout: 9000, followRedirect: false });
    const loc = String(res.headers.location || '');
    try { res.resume(); } catch (_) { /* ignore */ }
    const m = /\/releases\/tag\/([^/?#]+)/i.exec(loc);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /** Build a minimal usable release from a tag (used when the API is unavailable) */
  _syntheticRelease(id, tag) {
    const s = SOURCES[id];
    const ver = String(tag).replace(/^v/i, '');
    const names = [
      `ApkStart-${tag}-win64-portable.zip`,
      `ApkStart-${ver}-Setup.exe`,
      `ApkStart-runtime-${tag}.zip`,
    ];
    // Both GitHub and Gitee support /releases/download/<tag>/<file>,
    // (Gitee 302s to foruda.gitee.com attachment URLs that serve full bytes),
    // so a working URL can be built without the API. Missing assets 404,
    // and the speed ranking skips them automatically.
    const assets = names.map((n) => ({
      name: n,
      size: 0,
      browser_download_url: `${s.web}/releases/download/${tag}/${n}`,
    }));
    return {
      tag_name: tag,
      name: tag,
      body: '',
      html_url: `${s.web}/releases/tag/${tag}`,
      published_at: '',
      assets,
      synthetic: true,
    };
  }

  async fetchReleases() {
    const prefs = String((this.settings().runtime || {}).sourcePreference || 'auto');
    const ids = prefs === 'github' || prefs === 'gitee' ? [prefs] : ['github', 'gitee'];
    // Public releases endpoints are readable anonymously; a private repo gets 404
    // "Not Found Project" (not 401), which is when a read-only token is needed.
    // Anonymous calls are rate limited; a token raises the quota.
    const token = String((this.settings().runtime || {}).giteeToken || '').trim();
    const withToken = (id, url) => (id === 'gitee' && token
      ? `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
      : url);

    const jobs = ids.map(async (id) => {
      const s = SOURCES[id];
      const skip = this.blockedReason(id);
      if (skip) return { source: id, name: s.name, web: s.web, error: skip };
      try {
        const rel = await getJson(withToken(id, `${s.api}/releases/latest`), 9000);
        return { source: id, name: s.name, web: s.web, rel };
      } catch (e) {
        // No formal release on Gitee or GitHub blocked: fall back to the first list entry
        try {
          const list = await getJson(withToken(id, `${s.api}/releases?per_page=10`), 9000);
          const first = (Array.isArray(list) ? list : []).find((r) => r && !r.draft);
          if (first) return { source: id, name: s.name, web: s.web, rel: first };
        } catch (_) { /* try the API-free fallback */ }
        // API rate limited/blocked: take the tag from the redirect and build asset names
        try {
          const tag = await this._releaseTagViaRedirect(id);
          if (tag) {
            return { source: id, name: s.name, web: s.web, rel: this._syntheticRelease(id, tag), degraded: true };
          }
        } catch (_) { /* fallback failed too */ }
        const limited = /\b(403|429)\b/.test(e.message);
        if (limited) this._blocked.set(id, Date.now() + this._blockMs);
        const hint = limited
          ? ' (rate limited, source paused for a while)'
          : (id === 'gitee' && !token ? ' (retry later, or set a read-only token in the settings)' : '');
        return { source: id, name: s.name, web: s.web, error: `${e.message}${hint}` };
      }
    });
    return Promise.all(jobs);
  }

  /**
   * Merge both latest versions: the higher version wins but the ASSET LISTS are unified,
   * so even if Gitee has metadata only and the assets live on GitHub, both paths are tried.
   */
  async latest({ force = false } = {}) {
    const pref = String((this.settings().runtime || {}).sourcePreference || 'auto');
    const cached = this._relCache;
    if (!force && cached.value && cached.key === pref && Date.now() - cached.at < this._relTtl) {
      return cached.value;
    }
    const all = await this.fetchReleases();
    // Tripped sources are recorded here rather than inside fetchReleases so that 'who
    // supplies the result' stays replaceable/testable and every 403 trips the breaker
    for (const x of all) {
      if (x && x.error && /\b(403|429)\b/.test(x.error)) {
        this._blocked.set(x.source, Date.now() + this._blockMs);
      }
    }
    const ok = all.filter((x) => x && x.rel);
    if (!ok.length) {
      const why = all.map((x) => `${x.name || x.source}: ${x.error || 'no data'}`).join('; ');
      // Everything failed but the previous result is known: a possibly stale version
      // beats an error screen — the user still sees the current version and the release link.
      if (cached.value) return { ...cached.value, stale: true, staleReason: why };
      throw new Error(`Cannot reach the update servers (${why})`);
    }
    ok.sort((a, b) => cmpVer(b.rel.tag_name || b.rel.name, a.rel.tag_name || a.rel.name));
    const top = ok[0];
    const tag = String(top.rel.tag_name || top.rel.name || '');
    const version = tag.replace(/^v/i, '');

    // Only same-version assets count (an old asset from another source must not be used).
    // With both a whole package and a part set, prefer the whole one: parts add failure points.
    let raw = [];
    for (const item of ok) {
      const t = String(item.rel.tag_name || item.rel.name || '').replace(/^v/i, '');
      if (t !== version) continue;
      for (const a of (item.rel.assets || [])) {
        const key = String(a.name || '');
        if (!key) continue;
        // Gitee attaches source archives automatically (v0.3.2.zip / v0.3.2.tar.gz);
        // they are not installers, yet a `\.zip$` rule would download them as updates — exclude them.
        // Our own release assets all start with ApkStart, so a prefix whitelist is safer.
        if (!/^ApkStart/i.test(key)) continue;
        raw.push({
          name: key,
          size: Number(a.size) || 0,
          url: a.browser_download_url || a.url || '',
          source: item.source,
        });
      }
    }
    const grouped = groupParts(raw);
    const wholeNames = new Set(grouped.list.filter((a) => !a.partial).map((a) => a.name));
    raw = grouped.list.filter((a) => !(a.partial && wholeNames.has(a.name)));

    // The same asset on both sources (normal once packages stopped being split): keep all URLs as candidates.
    // It used to dedupe by name and keep the first — GitHub came first, Gitee URLs were dropped,
    // so 'pick the better network source' degraded to GitHub only. Now it picks by measured speed (rank()).
    // Sizes are kept per URL: the two sources build different bytes (a few MB apart),
    // and downloadMulti only mixes URLs with the same declared size — never average them.
    const assets = [];
    const byName = new Map();
    for (const a of raw) {
      const hit = byName.get(a.name);
      if (!hit) {
        const item = { ...a, urls: a.url ? [a.url] : [], sizes: {} };
        if (a.url && a.size) item.sizes[a.url] = a.size;
        byName.set(a.name, item);
        assets.push(item);
        continue;
      }
      if (a.url && !hit.urls.includes(a.url)) hit.urls.push(a.url);
      if (a.url && a.size) hit.sizes[a.url] = a.size;
      if (!hit.size && a.size) hit.size = a.size;
    }

    const result = {
      version,
      tag,
      name: top.rel.name || tag,
      notes: top.rel.body || '',
      htmlUrl: top.rel.html_url || top.web,
      publishedAt: top.rel.published_at || top.rel.created_at || '',
      assets,
      sources: ok.map((x) => ({ source: x.source, name: x.name, tag: x.rel.tag_name || x.rel.name || '' })),
      unreachable: all.filter((x) => x && x.error).map((x) => ({ source: x.source, name: x.name, error: x.error })),
      bySource: top.source,
    };
    this._relCache = { at: Date.now(), key: pref, value: result };
    return result;
  }

  /**
   * Candidate URLs for an asset across sources and mirrors (deduped, ordered: origin first, then mirrors).
   * Mirrors only wrap GitHub URLs: ghfast / gh-proxy proxy GitHub only,
   * a Gitee link through them just returns 403 and wastes a probe.
   */
  candidates(assetOrUrl) {
    // Three input shapes: a single URL, an asset object (url), or a merged asset (urls array)
    const urls = (typeof assetOrUrl === 'string'
      ? [assetOrUrl]
      : (assetOrUrl && (assetOrUrl.urls && assetOrUrl.urls.length ? assetOrUrl.urls : [assetOrUrl.url])))
      .filter(Boolean);
    const out = [];
    if (!urls.length) return out;
    const mirrors = mirrorList(this.settings());
    for (const url of urls) {
      if (out.includes(url)) continue;
      out.push(url);
      let host = '';
      try { host = new URL(url).host.toLowerCase(); } catch (_) { continue; }
      const isGithub = /(^|\.)github\.com$/.test(host) || /(^|\.)githubusercontent\.com$/.test(host);
      if (!isGithub) continue;
      for (const m of mirrors) {
        const u = withMirror(url, m);
        if (u && !out.includes(u)) out.push(u);
      }
    }
    return out;
  }

  /**
   * Sort candidate URLs by measured speed. Results are cached for 30 minutes;
   * if every probe fails, keep the original order so downloads still work.
   */
  async rank(urls, { onProgress } = {}) {
    const list = (urls || []).filter(Boolean);
    if (list.length <= 1) return list;
    const now = Date.now();
    const need = [];
    for (const u of list) {
      const c = this._rankCache.get(u);
      if (!c || now - c.at > this._rankTtl) need.push(u);
    }
    if (need.length) {
      onProgress?.({ stage: 'probe', message: `Probing ${need.length} download sources…` });
      // Probe sequentially, not concurrently: concurrency competes for bandwidth and ranks
      // 'who grabs hardest' instead of 'who is fastest'. 256 KB each, about a second.
      // Give up on a source after 6 s (9 s x 4 sources = 36 s of no progress before,
      // which looked like 'stuck preparing the runtime'); a failed probe only sorts last.
      let i = 0;
      for (const u of need) {
        i += 1;
        let host = u;
        try { host = new URL(u).host; } catch (_) { /* invalid URL — show as is */ }
        onProgress?.({ stage: 'probe', message: `Probing source ${i}/${need.length}: ${host}…` });
        // eslint-disable-next-line no-await-in-loop
        const r = await measure(u, { timeoutMs: 6000 });
        this._rankCache.set(u, { at: Date.now(), ok: r.ok, speed: r.speed });
      }
    }
    const score = (u) => {
      const c = this._rankCache.get(u);
      return c && c.ok ? c.speed : -1;
    };
    const sorted = list.slice().sort((a, b) => score(b) - score(a));
    const best = sorted[0];
    const s = score(best);
    if (s > 0) {
      onProgress?.({
        stage: 'probe',
        message: `Fastest source: ${new URL(best).host} (~${(s / 1048576).toFixed(2)} MB/s)`,
      });
    }
    return sorted;
  }

  /** Clear the speed cache (after a mirror prefix or network change) */
  reset() {
    this._rankCache.clear();
    this._relCache = { at: 0, key: '', value: null };
    this._blocked.clear();
  }
}

module.exports = { Sources, SOURCES, measure, KNOWN_MIRRORS, withMirror, mirrorList };
