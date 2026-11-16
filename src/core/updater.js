'use strict';
/**
 * Онлайн-обновление: берём последнюю версию из GitHub Releases, скачиваем и заменяем на месте.
 * На Linux это AppImage или каталог сборки; замена идёт через sh-скрипт,
 * который ждёт выхода процесса, копирует файлы и запускает новую версию.
 *
 * Three delivery shapes are covered:
 *   - packaged install: the installer package is downloaded and run silently;
 *   - portable zip (runtime downloaded on demand): the zip is unpacked over the program
 *     directory — the runtime directory, installed apps and
 *     snapshots live in the user data directory and are untouched;
 *   - portable build bundling the runtime: same as above, plus resources/runtime.
 *
 * Заменять файлы из своего процесса нельзя (они заняты), поэтому генерируется
 * sh-скрипт: ждёт выхода процесса по pid → копирует → запускает снова.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { downloadAnyParallel, downloadMulti } = require('./download');
const { ZipFile } = require('./zip');
const { cmpVer } = require('./version');
const { Sources } = require('./sources');

const OWNER = 'RoutineMiku';
const REPO = 'apkstart';

/** Строка в одинарных кавычках для sh: внутренние ' экранируются */
function psq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

class Updater {
  /**
   * @param {{currentVersion:string, exePath:string, isPackaged:boolean, dataDir:string,
   *          onProgress?:Function}} o
   */
  constructor(o) {
    this.current = o.currentVersion || '0.0.0';
    this.exePath = o.exePath;
    this.installDir = path.dirname(o.exePath || '');
    this.isPackaged = !!o.isPackaged;
    this.dataDir = o.dataDir;
    this.onProgress = o.onProgress || (() => {});
    this.settings = typeof o.settings === 'function' ? o.settings : () => (o.settings || {});
    // settings() feeds sources: GitHub vs Gitee and whether a mirror prefix is set
    this.sources = new Sources(this.settings);
    this.latest = null;
    this._last = null;
  }

  /** Форма установки. На Linux — только AppImage/распакованный каталог. */
  get flavor() {
    return 'portable';
  }

  get updateDir() {
    return path.join(this.dataDir, 'update');
  }

  /**
   * Check for updates: ask GitHub / Gitee concurrently, keep the higher version and unite assets.
   * Actual download URLs are speed-ranked again inside prepare().
   */
  /**
   * @param {{force?:boolean}} [opts] force=true skips the 10-minute version cache
   *        (a manual check should be fresh; the silent start-up check may use the cache)
   */
  async check(opts = {}) {
    const merged = await this.sources.latest({ force: !!opts.force });
    const pick = (re) => merged.assets.find((a) => re.test(String(a.name || '')));
    // Releases carry both the program package and the runtime bundle (ApkStart-runtime-*.zip).
    // The .zip fallback must exclude the runtime bundle: a release with only the runtime
    // used to be unpacked over the program (1.5 GB of files, a broken install).
    const isRuntimePack = (a) => /runtime/i.test(String((a && a.name) || ''));

    // Linux: берём только AppImage или linux.zip; .exe и win-архивы не наши.
    const asset = pick(/\.AppImage$/i) || pick(/linux.*\.zip$/i)
      || merged.assets.find((a) => /\.zip$/i.test(a.name) && !isRuntimePack(a)
        && !/win|setup|portable/i.test(String(a.name || '')));

    this.latest = {
      version: merged.version,
      tag: merged.tag,
      name: merged.name,
      notes: merged.notes,
      htmlUrl: merged.htmlUrl,
      publishedAt: merged.publishedAt,
      // Keep parts: Gitee split packages have no single url, and dropping them leaves an asset without an address
      asset: asset
        ? {
          name: asset.name,
          size: asset.size,
          url: asset.url,
          // The asset exists on GitHub and Gitee: keep both URLs and let prepare() pick the faster.
          // sizes are per URL — the two sources produce different byte counts.
          urls: asset.urls,
          sizes: asset.sizes,
          source: asset.source,
          parts: asset.parts,
          partial: asset.partial,
        }
        : null,
      assets: merged.assets,
      // Per-source latest versions and unreachable flags, so the UI can say which source was used
      sources: merged.sources,
      unreachable: merged.unreachable,
      flavor: this.flavor,
      hasUpdate: cmpVer(merged.tag, this.current) > 0,
      current: this.current,
      canAutoApply: !!asset && (!!asset.url || !!(asset.parts && asset.parts.length)),
    };
    this._last = this.latest;
    return this.latest;
  }

  /**
   * Download and prepare the payload: zip into update/<ver>/payload, installers kept as-is.
   * @returns {Promise<{mode:'zip'|'setup', payload:string, version:string}>}
   */
  async prepare(info) {
    const it = info || this.latest;
    if (!it || !it.asset) throw new Error('This release has no auto-installable package — download it from the releases page');
    const dir = path.join(this.updateDir, it.version);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, it.asset.name);
    let total = it.asset.size || 0;
    const conns = Math.max(1, Math.min(16, Number((this.settings().runtime || {}).downloadConnections) || 8));

    // Gitee caps attachments at 100 MB, so packages are published as .part1/.part2.
    // Each part is speed-tested separately (some from Gitee, some from a GitHub mirror)
    // and reassembled in order — still just a download plus an unpack for the user.
    if (it.asset.parts && it.asset.parts.length) {
      await this._downloadParts(it.asset, file, conns, total);
    } else {
      this.onProgress({ stage: 'download', percent: 1, message: `Downloading ${it.asset.name}…` });
      // Candidates = origin + mirror prefix; probe 256 KB each, then chunk-download from the fastest.
      // This is the only reliable choice when direct GitHub runs at tens of KB/s and a mirror at MB/s:
      // guessing by domain fails because speeds vary through the day.
      const cands = this.sources.candidates(it.asset);
      const ranked = await this.sources.rank(cands, { onProgress: (p) => this.onProgress(p) }).catch(() => cands);
      // Progress uses the total size of the source actually downloading: GitHub and Gitee differ
      // by several MB, and the wrong total sticks at 92% before jumping to done.
      const sizes = it.asset.sizes || {};
      for (const u of ranked) {
        if (sizes[u]) { total = sizes[u]; break; }
      }
      // downloadMulti pulls chunks from direct GitHub and mirrors at once to add bandwidth;
      // With a single source or no Range support, it falls back to single-source chunking.
      await downloadMulti(ranked, file, {
        connections: conns,
        onProgress: (pr) => {
          const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
          const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
          const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
          this.onProgress({
            stage: 'download',
            percent: Math.max(1, Math.min(99, pct)),
            message: `Downloading ${mb}${sp}`,
            speed: pr.speed,
          });
        },
      });
    }

    if (/\.zip$/i.test(file)) {
      const out = path.join(dir, 'payload');
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      await this._extract(file, out);
      this.onProgress({ stage: 'ready', percent: 100, message: 'Update unpacked' });
      return { mode: 'zip', payload: out, version: it.version };
    }
    this.onProgress({ stage: 'ready', percent: 100, message: 'Package downloaded' });
    return { mode: 'setup', payload: file, version: it.version };
  }

  /**
   * Download and reassemble a split package.
   * @param {{name:string, size:number, parts:Array<{index:number,size:number,urls:string[]}>}} asset
   */
  async _downloadParts(asset, target, conns, total) {
    const dir = path.dirname(target);
    let doneBytes = 0;
    const fd = fs.openSync(target, 'w');
    try {
      for (const part of asset.parts) {
        const tmp = path.join(dir, `${asset.name}.${part.index}.tmp`);
        const cands = [];
        for (const u of part.urls) {
          for (const c of this.sources.candidates(u)) if (!cands.includes(c)) cands.push(c);
        }
        // eslint-disable-next-line no-await-in-loop
        const ranked = await this.sources.rank(cands, {
          onProgress: (p) => this.onProgress({ ...p, percent: Math.max(1, Math.min(99, Math.round((doneBytes / (total || 1)) * 100))) }),
        }).catch(() => cands);
        // eslint-disable-next-line no-await-in-loop
        await downloadAnyParallel(ranked, tmp, {
          connections: conns,
          onProgress: (pr) => {
            const got = doneBytes + (pr.got || 0);
            const pct = total ? Math.round((got / total) * 100) : 0;
            const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
            this.onProgress({
              stage: 'download',
              percent: Math.max(1, Math.min(99, pct)),
              message: `Downloading ${(got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`
                + ` (part ${part.index}/${asset.parts.length})${sp}`,
              speed: pr.speed,
            });
          },
        });
        const buf = fs.readFileSync(tmp);
        if (part.size && buf.length !== part.size) {
          throw new Error(`Part ${part.index} has the wrong size (${buf.length} != ${part.size}); aborted, retry`);
        }
        fs.writeSync(fd, buf, 0, buf.length, doneBytes);
        doneBytes += buf.length;
        fs.rmSync(tmp, { force: true });
      }
    } finally {
      fs.closeSync(fd);
    }
    if (total && doneBytes !== total) {
      throw new Error(`Reassembled package has the wrong size (${doneBytes} != ${total}); aborted, retry`);
    }
  }

  async _extract(zipPath, dest) {
    const zf = new ZipFile(zipPath);
    try {
      const names = zf.names().filter((n) => !n.endsWith('/'));
      let i = 0;
      for (const n of names) {
        i += 1;
        const target = path.join(dest, n.replace(/\\/g, '/'));
        if (!target.startsWith(path.resolve(dest))) continue;   // zip-slip guard
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await zf.pipeTo(n, fs.createWriteStream(target));
        if (i % 20 === 0) {
          this.onProgress({
            stage: 'extract',
            percent: Math.min(99, Math.round((i / names.length) * 100)),
            message: `Extracting ${i}/${names.length}`,
          });
        }
      }
    } finally {
      try { zf.close(); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Generate and start the replace-and-restart script; the caller quits the app.
   * @param {{mode:'zip'|'setup', payload:string, version:string}} job
   * @param {{waitPid?:number, spawn?:boolean}} [opts] tests may pass another pid / not spawn
   */
  apply(job, opts = {}) {
    if (process.platform === 'linux') return this._applyLinux(job, opts);
    const exe = this.exePath;
    const dir = this.installDir;
    const logFile = path.join(this.updateDir, 'update.log');
    fs.mkdirSync(this.updateDir, { recursive: true });
    const waitPid = opts.waitPid || process.pid;

    const lines = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$log = ${psq(logFile)}`,
      `function Note($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }`,
      `Note 'updater start'`,
      // Wait for this process to really exit (90 s max), otherwise files stay locked
      `try { Wait-Process -Id ${waitPid} -Timeout 90 } catch { }`,
      `Start-Sleep -Milliseconds 700`,
    ];

    if (job.mode === 'zip') {
      lines.push(
        `$src = ${psq(job.payload)}`,
        `$dst = ${psq(dir)}`,
        `$ok = $false`,
        `for ($i = 1; $i -le 12; $i++) {`,
        `  Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force`,
        `  $probe = Join-Path $dst ${psq(path.basename(exe))}`,
        `  if (Test-Path $probe) { $ok = $true; Note "copy pass $i ok"; break }`,
        `  Note "copy pass $i failed, retry"; Start-Sleep -Milliseconds 600`,
        `}`,
        `if (-not $ok) { Note 'copy failed' }`,
        // Files removed in the new version are not deleted by a plain copy, which is harmless;
        // only this run's extract directory is cleaned so it does not waste hundreds of MB.
        `Remove-Item -Path $src -Recurse -Force`,
      );
    } else {
      lines.push(
        `Note 'run installer'`,
        `$p = Start-Process -FilePath ${psq(job.payload)} -ArgumentList '/S' -PassThru -Wait`,
        `Note ("installer exit " + $p.ExitCode)`,
        `Start-Sleep -Milliseconds 800`,
      );
    }

    lines.push(
      `if (Test-Path ${psq(exe)}) { Start-Process -FilePath ${psq(exe)}; Note 'relaunched' }`,
      `Note 'updater done'`,
      `Start-Sleep -Milliseconds 400`,
      `Remove-Item -Path ${psq(path.join(this.updateDir, job.version))} -Recurse -Force`,
      // A failing cleanup must not make the caller think the update failed
      `exit 0`,
    );

    const script = lines.join('\r\n');
    fs.writeFileSync(path.join(this.updateDir, 'apply.log.ps1'), script, 'utf8');
    if (opts.spawn === false) return script;
    // -EncodedCommand uses UTF-16LE base64 so non-ASCII paths survive any console code page
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // detached must NOT be used here: some security tools / sandbox policies block detached consoles,
    // leaving the script never started (the update UI sticks on 'replacing and restarting').
    // A normal child plus unref survives the parent exit just as well,
    // and is more compatible.
    const child = spawn(ps, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-EncodedCommand', b64,
    ], { stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  }

  /**
   * Linux: заменяем файлы и перезапускаем через bash-скрипт.
   * Ждём выхода процесса по pid, копируем каталог (или подменяем AppImage),
   * затем запускаем заново. Пишем в лог, чтобы сбой обновления было видно.
   */
  _applyLinux(job, opts = {}) {
    const { execFile } = require('child_process');
    const dir = this.installDir;
    const exe = this.exePath;
    const logFile = path.join(this.updateDir, 'update.log');
    fs.mkdirSync(this.updateDir, { recursive: true });
    const waitPid = opts.waitPid || process.pid;
    const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

    const lines = [
      '#!/bin/sh',
      `LOG=${q(logFile)}`,
      'note() { printf "[%s] %s\n" "$(date +%H:%M:%S)" "$1" >> "$LOG"; }',
      "note 'updater start'",
      `for i in $(seq 1 90); do kill -0 ${waitPid} 2>/dev/null || break; sleep 1; done`,
      'sleep 1',
    ];
    if (job.mode === 'zip') {
      lines.push(
        `SRC=${q(job.payload)}`,
        `DST=${q(dir)}`,
        'cp -a "$SRC"/. "$DST"/ 2>>"$LOG" || note "copy failed"',
        'rm -rf "$SRC"',
      );
    } else {
      // AppImage: payload — новый файл, подменяем на месте
      lines.push(
        `NEW=${q(job.payload)}`,
        `cp -f "$NEW" ${q(exe)} 2>>"$LOG" || note "replace failed"`,
        `chmod +x ${q(exe)}`,
      );
    }
    lines.push(
      `if [ -x ${q(exe)} ]; then nohup ${q(exe)} >/dev/null 2>&1 & note relaunched; fi`,
      "note 'updater done'",
      'exit 0',
    );

    const script = lines.join('\n') + '\n';
    const scriptPath = path.join(this.updateDir, 'apply.sh');
    fs.writeFileSync(scriptPath, script, 'utf8');
    fs.chmodSync(scriptPath, 0o755);
    if (opts.spawn === false) return script;
    const child = execFile('/bin/sh', [scriptPath], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  }

  /** When the UI cannot open (or no auto-installable asset exists), open the releases page */
  static repoUrl() {
    return `https://github.com/${OWNER}/${REPO}/releases`;
  }
}

module.exports = { Updater, cmpVer, OWNER, REPO };
