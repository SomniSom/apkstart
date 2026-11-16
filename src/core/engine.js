'use strict';
/**
 * Runtime engine: the Android Emulator VM shipped with ApkStart
 *
 * Design rules:
 *  - self-contained by default: adb, the emulator and the system image are managed by ApkStart itself
 *  - every Android operation goes through adb, so the engine is replaceable
 *  - the VM starts on demand and idles down; once booted it is reused so apps open instantly
 */
const { spawn, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { AdbClient } = require('./adb');
const store = require('./store');
const { Provisioner } = require('./provision');
const { EmulatorEngine } = require('./emulator');
const doctor = require('./doctor');
const container = require('./container');

const LOG_DIR = path.join(store.DATA_DIR, 'logs');
const MONITOR_PORT = 5556;
const EMU_PORT = 5554;
const EMU_SERIAL = `emulator-${EMU_PORT}`;

/** Is anything listening on a TCP port (is the previous emulator still alive) */
function portAlive(port, timeout = 150) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeout, () => fin(false));
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
  });
}

const ATTACH_ENDPOINTS = [
  { name: 'Windows Subsystem for Android', serial: '127.0.0.1:58526' },
  { name: 'LDPlayer', serial: '127.0.0.1:5555' },
  { name: 'MuMu', serial: '127.0.0.1:7555' },
  { name: 'Nox', serial: '127.0.0.1:62001' },
  { name: 'MEmu', serial: '127.0.0.1:21503' },
];

class Runtime {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.emulator = new EmulatorEngine(appRoot);
    this.vmProc = null;
    this.vmStarting = false;
    this.installing = false;
    this.lastActivity = Date.now();
    this._watchdog = null;
    this._freeformReady = false;
    this._client = null;
    this._bootLog = [];
    this._activeApps = new Set();  // container session: app windows currently open
    this.emuSerial = EMU_SERIAL;   // the port is chosen dynamically, the serial follows
    store.ensureDirs();
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  get settings() { return store.getSettings(); }

  /** Is the emulator engine running */
  get emuRunning() { return this.emulator.running(); }

  // ---------------- basics ----------------

  adbPath() {
    const s = this.settings;
    const p = this.provisioner.paths();
    if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    if (fs.existsSync(p.adbExe)) return p.adbExe;
    const local = path.join(this.appRoot, 'tools', 'platform-tools', 'adb');
    if (fs.existsSync(local)) return local;
    return AdbClient.resolveAdb('', this.appRoot);
  }

  client(serial) {
    const useSerial = serial
      || (this.settings.engine.mode === 'attach' ? this.settings.device : this.emuSerial);
    const adbPath = this.adbPath();
    if (!this._client || this._client.serial !== useSerial || this._client.adbPath !== adbPath) {
      // On a port or adb change do not leave the old resident adb shell connected
      if (this._client && this._client.disposeInput) this._client.disposeInput();
      this._client = new AdbClient({ adbPath, serial: useSerial });
    }
    return this._client;
  }

  touch() { this.lastActivity = Date.now(); }

  log(line) {
    this._bootLog.push({ t: Date.now(), line });
    if (this._bootLog.length > 300) this._bootLog.shift();
  }

  // ---------------- status ----------------

  async status() {
    const env = await this.provisioner.checkEnv();
    const s = this.settings;
    const client = this.client();
    const result = {
      mode: s.engine.mode,
      installed: !!s.runtime.installed,
      env,
      engineKind: env.engine,
      emulatorOk: env.emulator.ok,
      emulatorVersion: env.emulator.version,
      sysimgOk: env.sysimg.ok,
      sysimgNote: env.sysimg.note,
      accel: env.accel,
      vmRunning: this.emulator.running() || !!(this.vmProc && !this.vmProc.killed),
      vmStarting: this.vmStarting,
      installing: this.installing,
      adbOk: env.adb.ok,
      adbVersion: env.adb.version,
      qemuOk: env.qemu.ok,
      qemuVersion: env.qemu.version,
      deviceOnline: false,
      android: '',
      sdk: 0,
      freeform: false,
      ready: false,
      needsSetup: null,
      error: '',
      serial: this.emuSerial,
      autoProfile: this.emulator.profile ? doctor.describeProfile(this.emulator.profile) : '',
      diagnosis: this.emulator.lastDiagnosis || null,
      attempts: this.emulator.attempts || [],
      // 'Why did it not start last time': fall back to the on-disk record, so the real cause shows
      lastFailure: (this.emulator.lastFailure ? this.emulator.lastFailure() : null),
    };

    if (!env.adb.ok) {
      result.needsSetup = 'adb';
      result.error = 'adb missing: use "Set up everything" to download it';
      return result;
    }

    try {
      result.deviceOnline = await client.isOnline();
      if (result.deviceOnline) {
        const [android, sdk, ff] = await Promise.all([
          client.androidVersion().catch(() => ''),
          client.sdkInt().catch(() => 0),
          client.shell('settings get global enable_freeform_support').catch(() => '0'),
        ]);
        result.android = android;
        result.sdk = sdk;
        result.freeform = String(ff).trim() === '1' || this._freeformReady;
      }
    } catch (e) {
      result.error = e.message;
    }

    if (result.deviceOnline) result.ready = true;
    else if (!env.emulator.ok) result.needsSetup = 'emulator';
    else if (!env.sysimg.ok) result.needsSetup = 'sysimg';
    // No hardware acceleration is no longer a blocker: doctor falls back to software emulation
    // and retries with other GPU/accel/memory combinations on a failed boot.
    else result.needsSetup = 'boot';

    result.phase = result.deviceOnline
      ? 'ready'
      : this.installing
        ? 'installing'
        : result.vmRunning
          ? 'booting'
          : 'idle';

    return result;
  }

  /** Advanced: probe for an existing runtime on this machine (non-default path) */
  async probe() {
    const adbPath = this.adbPath();
    const one = (ep) => new Promise((resolve) => {
      const c = new AdbClient({ adbPath, serial: ep.serial });
      const timer = setTimeout(() => resolve(null), 4000);
      c.isOnline().then((online) => {
        clearTimeout(timer);
        if (!online && ep.serial.includes(':')) return c.connect().then((ok) => (ok ? ep : null));
        return online ? ep : null;
      }).then(resolve).catch(() => { clearTimeout(timer); resolve(null); });
    });
    const found = await Promise.all(ATTACH_ENDPOINTS.map(one));
    return found.filter(Boolean);
  }

  // ---------------- start / stop the VM ----------------

  buildArgs({ install = false, headless = false } = {}) {
    const s = this.settings;
    const p = this.provisioner.paths();
    const hv = this._hv || { kvm: false };
    const disk = s.runtime.diskPath || p.disk;
    const iso = s.runtime.isoPath || p.iso;
    const accel = hv.kvm ? 'kvm' : 'tcg';

    const args = [
      '-name', 'ApkStart Runtime',
      '-machine', `q35,accel=${accel}`,
      '-cpu', hv.kvm ? 'host' : 'max',
      '-smp', String(Math.max(2, s.engine.cores || 4)),
      '-m', String(s.engine.memoryMB || 4096),
      '-rtc', 'base=localtime',
      '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:5555-:5555',
      '-device', 'virtio-net-pci,netdev=net0',
      '-vga', 'std',
      '-usb', '-device', 'usb-tablet',
      '-monitor', `tcp:127.0.0.1:${MONITOR_PORT},server,nowait`,
    ];

    if (headless || s.runtime.headless) args.push('-display', 'none');

    if (install) {
      args.push('-boot', 'order=d');
      args.push('-cdrom', iso);
    } else {
      args.push('-boot', 'order=c');
    }
    args.push('-drive', `file=${disk},if=virtio,format=qcow2,cache=writeback`);
    return args;
  }

  async boot({ install = false, onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    this._hv = env.hypervisor;

    // Preferred: the official emulator (device model and GPU translation built in)
    if (env.emulator.ok && env.sysimg.ok) {
      return this.bootEmulator({ env, onLog });
    }

    return this.bootQemu({ install, env, onLog });
  }

  /**
   * Boot Android with the official emulator.
   * Unlike QEMU+ISO there is no 'install the system' step: the image is the system and boots on start.
   */
  async bootEmulator({ env, onLog = () => {} } = {}) {
    if (this.vmStarting) {
      const started = Date.now();
      while (this.vmStarting && Date.now() - started < 300000) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
      }
      const c = this.client();
      if (await c.isOnline()) {
        await this.prepare(c);
        return { ok: true, client: c, reused: true };
      }
    }

    const accel = env && env.accel ? env.accel : await this.provisioner.emulatorAccel();
    if (!accel.ok) {
      onLog('No hardware acceleration: software emulation (the first boot is much slower)');
    }

    this.vmStarting = true;
    try {
      // The probe belongs to the EmulatorEngine boot loop: it retries with other parameters
      // when the process exits or logs a fatal error. One adb command per round; three used to
      // be spawned per round and a snapshot restore paid 300-500 ms right when the user clicks.
      let probeStart = Date.now();
      let errStreak = 0;
      let lastHeal = 0;
      const probe = async ({ serial }) => {
        if (!this.emulator.running()) return 'fatal';
        if (!this._probeClient || this._probeClient.serial !== serial) {
          this._probeClient = new AdbClient({ adbPath: this.adbPath(), serial });
        }
        const c = this._probeClient;
        try {
          const out = String(await c.shell('getprop sys.boot_completed; pm path android', { timeout: 8000 }));
          const lines = out.split(/\r?\n/).map((l) => l.trim());
          const booted = lines[0] === '1' || /^1$/.test(lines[0] || '');
          const pmReady = lines.some((l) => /^package:/.test(l));
          errStreak = 0;
          if (booted && pmReady) return 'ok';
          return booted ? 'pending' : 'booting';
        } catch (_) {
          errStreak += 1;
          // adb sometimes sticks at offline / unauthorized (another adb server grabbed the port
          // or the handshake broke); every shell round then fails and the probe never settles —
          // the caller only sees a boot timeout after 240 s. Six consecutive errors restart the server.
          const now = Date.now();
          if (errStreak >= 6 && now - probeStart > 25000 && now - lastHeal > 30000) {
            lastHeal = now;
            onLog('adb connection broken, restarting the adb server and waiting…');
            await this.emulator.resetAdbServer().catch(() => {});
            this._probeClient = null;
          }
          return 'pending';
        }
      };

      const st = await this.emulator.start({
        headless: this.settings.engine.headless !== false,
        onLog,
        probe,
      });
      // start() returns {ok:false} instead of throwing on failure (low disk, retries exhausted).
      // The old code ignored it and returned ok:true, so the caller thought it was ready
      // and adb answered device not found — 'click does nothing' instead of the real cause.
      if (!st || st.ok === false) {
        return {
          ok: false,
          error: (st && st.error) || 'The Android runtime failed to start',
          needsSpace: !!(st && st.needsSpace),
          attempts: (st && st.attempts) || [],
          diagnosis: this.emulator.lastDiagnosis,
          exitCode: st && st.exitCode,
        };
      }
      this.lastActivity = Date.now();
      this.emuSerial = st.serial || this.emulator.serial;
      const client = this.client(this.emuSerial);
      await this.prepare(client);
      // The snapshot is saved when idle: writing 1-3 GB immediately competes with the app just opened
      this._armSnapshotSave(20000);
      return { ok: true, client, engine: 'emulator', serial: this.emuSerial, profile: st.profile, network: st.network || null };
    } catch (e) {
      // Pass the retry/diagnosis result to the UI instead of a vague 'start failed'
      return { ok: false, error: e.message, diagnosis: e.diagnosis, report: e.report, attempts: e.attempts };
    } finally {
      this.vmStarting = false;
    }
  }

  // ---------------- prewarm (keep the environment resident) ----------------

  /** Save the quickboot snapshot when idle, never while an app is starting */
  _armSnapshotSave(delay = 20000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), {
      delay,
      isIdle: () => this._activeApps.size === 0,
    });
  }

  /** For the installer: save a fresh snapshot after an install so the next boot is fast */
  scheduleSnapshotSave(delay = 12000) { this._armSnapshotSave(delay); }

  /**
   * Prewarm: boot Android in the background before the user opens an app.
   * Environment resident, so clicking an icon costs one am start.
   *  - fully silent: no dialogs, no errors, a failure does not block a normal launch;
   *  - idempotent: a boot in progress or ready reuses the same Promise, never a second VM;
   *  - frugal: qemu is parked at the lowest priority once booted.
   */
  prewarm({ onLog = () => {} } = {}) {
    if (this._prewarmPromise) return this._prewarmPromise;
    if (this._activeApps.size > 0) return Promise.resolve({ ok: true, skipped: 'busy' });
    // Advanced mode reuses someone else's runtime and must not start one of ours
    if (this.settings.engine.mode === 'attach') return Promise.resolve({ ok: false, skipped: 'attach' });
    const t0 = Date.now();
    const p = (async () => {
      try {
        const env = await this.provisioner.checkEnv();
        if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) return { ok: false, skipped: 'not-ready' };
        const r = await this.ensure({ onLog: (m) => onLog(`prewarm: ${m}`) });
        if (r && r.ok) {
          // The user may open an app during prewarm: never park it at idle then
          if (this._activeApps.size === 0) await this.emulator.setPriority('idle').catch(() => {});
          const ms = Date.now() - t0;
          this.log(`prewarm done (${Math.round(ms / 1000)}s)`);
          return { ok: true, bootMs: ms };
        }
        return { ok: false, error: r && r.error };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })();
    this._prewarmPromise = p;
    const clear = () => { if (this._prewarmPromise === p) this._prewarmPromise = null; };
    p.then(clear, clear);
    return p;
  }

  async bootQemu({ install = false, env, onLog = () => {} } = {}) {
    if (!env.qemu.ok) throw new Error('QEMU is not installed — deploy the runtime first');
    if (install && !env.iso.ok) throw new Error('The system image (ISO) is not ready');

    const p = this.provisioner.paths();
    const disk = this.settings.runtime.diskPath || p.disk;
    if (!install && !fs.existsSync(disk)) throw new Error('Android is not installed on the virtual disk yet');

    this.vmStarting = true;
    const args = this.buildArgs({ install });
    const logFile = path.join(LOG_DIR, install ? 'qemu-install.log' : 'qemu.log');
    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `\n\n=== ${new Date().toISOString()} ${install ? 'INSTALL' : 'BOOT'} ===\n${env.qemu.path} ${args.join(' ')}\n`);

    onLog(`Starting the runtime (${env.hypervisor.kvm ? 'KVM acceleration' : 'software emulation'})…`);
    if (!env.hypervisor.kvm) onLog(env.hypervisor.note);

    const proc = spawn(env.qemu.path, args, {
      cwd: path.dirname(env.qemu.path),
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    this.vmProc = proc;
    this.installing = install;
    this.lastActivity = Date.now();

    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      onLog(`Start failed: ${e.message}`);
      this.vmProc = null;
      this.vmStarting = false;
    });
    proc.on('exit', (code) => {
      this.log(`qemu exit ${code}`);
      onLog(`Runtime exited (code=${code})`);
      this.vmProc = null;
      this.vmStarting = false;
      this.installing = false;
    });

    await new Promise((r) => setTimeout(r, 1500));
    this.vmStarting = false;
    if (!this.vmProc) throw new Error(`QEMU failed to start, see the log: ${logFile}`);

    // Install mode: the ISO holds an installer without adb, so waiting for adb is wrong
    if (install) {
      onLog('The installer started; follow the prompts in the VM window');
      return { ok: true, install: true, needsManualInstall: true };
    }

    const client = this.client('127.0.0.1:5555');
    const timeout = env.hypervisor.kvm ? 180000 : 900000;
    const linked = await this.waitAdb(client, timeout, onLog);
    if (!linked) {
      return {
        ok: false,
        error: 'The VM started but adb cannot connect: enable Developer options → ADB over network and retry',
      };
    }
    const ready = await this.waitAndroidReady(client, Math.max(60000, timeout / 2), onLog);
    if (!ready.ok) {
      return {
        ok: false,
        error: ready.stage === 'kernel'
          ? 'The Android kernel did not finish booting; check the runtime log (image damage or no acceleration)'
          : 'Android booted but system services are not ready (maybe the setup wizard is open in the VM window)',
      };
    }
    await this.prepare(client);
    return { ok: true, client };
  }

  /**
   * Wait until Android is really usable: adb online is not the same as a working system.
   * sys.boot_completed=1 plus a responding package manager are required or am start fails.
   */
  async waitAndroidReady(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let bootCompleted = false;
    let lastNotice = 0;
    while (Date.now() - start < timeoutMs) {
      /* eslint-disable no-await-in-loop */
      const online = await client.isOnline();
      if (!online) {
        await client.connect().catch(() => false);
      } else {
        if (!bootCompleted) {
          const v = await client.shell('getprop sys.boot_completed').catch(() => '');
          if (String(v).trim() === '1') {
            bootCompleted = true;
            onLog(`Android kernel up, waiting for system services… (${Math.round((Date.now() - start) / 1000)}s)`);
          }
        }
        if (bootCompleted) {
          const pm = await client.shell('pm path android').catch(() => '');
          if (/package:/.test(pm)) {
            onLog(`Android ready (${Math.round((Date.now() - start) / 1000)}s)`);
            return { ok: true, ms: Date.now() - start };
          }
        }
      }
      if (Date.now() - lastNotice > 15000) {
        lastNotice = Date.now();
        onLog(bootCompleted
          ? `Waiting for system services… ${Math.round((Date.now() - start) / 1000)}s`
          : `Booting Android… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      /* eslint-enable no-await-in-loop */
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false, stage: bootCompleted ? 'services' : 'kernel', ms: Date.now() - start };
  }

  async waitAdb(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let lastNotice = 0;
    const needConnect = String(client.serial || '').includes(':')
      && !/^emulator-/.test(client.serial);
    while (Date.now() - start < timeoutMs) {
      // emulator-5554 is registered by the emulator itself, no adb connect needed
      if (needConnect) {
        // eslint-disable-next-line no-await-in-loop
        await client.connect().catch(() => false);
      }
      // eslint-disable-next-line no-await-in-loop
      if (await client.isOnline()) return true;
      if (Date.now() - lastNotice > 20000) {
        lastNotice = Date.now();
        onLog(`Waiting for Android… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async prepare(client) {
    if (!this._freeformReady) {
      try { this._freeformReady = await client.ensureFreeform(); } catch (_) { /* ignore */ }
    }
    this.startWatchdog();
  }

  /** Graceful stop: the emulator console or the QEMU monitor */
  async stop({ graceful = true } = {}) {
    const adbPath = this.adbPath();
    if (this.emulator.running()) {
      await this.emulator.stop({ adbPath });
      return true;
    }
    // An adopted emulator has no proc handle here; the old code returned false and the idle
    // watchdog could never stop it, leaving CPU and memory held.
    // This path shuts down through the adb console and kills by port as a last resort.
    //
    // The emulator binary is only a launcher that exits once qemu is spawned, so even our
    // own VM takes this branch. saveSnapshotNow must run first or no snapshot is ever saved
    // and every open is a full cold boot (25 s vs 8 s).
    let online = false;
    try { online = await this.client().isOnline(); } catch (_) { /* ignore */ }
    if (online && this.emuSerial) {
      if (adbPath && this.emulator.snapshotWorthSaving !== false) {
        await this.emulator.saveSnapshotNow(adbPath, { timeout: 60000 }).catch(() => false);
      }
      await this.client().exec(['emu', 'kill'], { timeout: 8000 }).catch(() => {});
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 400));
        // eslint-disable-next-line no-await-in-loop
        const still = await this.client().isOnline().catch(() => false);
        if (!still) break;
      }
      const still = await this.client().isOnline().catch(() => false);
      if (still) {
        const m = /:(\d+)$/.exec(this.emuSerial);
        const port = m ? Number(m[1]) - 1 : this.emulator.port;
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
      }
      this._activeApps.clear();
      return true;
    }
    if (!this.vmProc) return false;
    if (graceful) {
      try { await this.monitorCmd('system_powerdown'); } catch (_) { /* ignore */ }
      for (let i = 0; i < 16; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
        if (!this.vmProc) return true;
      }
      try { await this.monitorCmd('quit'); } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
    return true;
  }

  // ---------------- QEMU monitor ----------------

  monitorCmd(cmd, { timeout = 4000 } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: MONITOR_PORT });
      let buf = '';
      let sent = false;
      const done = (err, data) => {
        try { sock.destroy(); } catch (_) { /* ignore */ }
        if (err) reject(err); else resolve(data);
      };
      sock.setTimeout(timeout, () => done(new Error('monitor timeout')));
      sock.on('error', (e) => {
        // QEMU closes the connection after quit (ECONNRESET/EPIPE) — perfectly normal
        if (sent && /ECONNRESET|EPIPE/i.test(e.code || String(e))) done(null, buf);
        else done(e);
      });
      sock.on('data', (c) => {
        buf += c.toString();
        if (!sent && buf.includes('(qemu)')) {
          sent = true;
          sock.write(`${cmd}\n`);
          setTimeout(() => done(null, buf), 300);
        }
      });
      sock.on('connect', () => {
        if (!cmd) setTimeout(() => done(null, buf), 250);
      });
    });
  }

  async sendKey(keys, delay = 140) {
    for (const k of keys) {
      // eslint-disable-next-line no-await-in-loop
      await this.monitorCmd(`sendkey ${k}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // ---------------- install the system to the virtual disk ----------------

  async startInstaller({ onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    if (!env.iso.ok) {
      throw new Error(env.iso.reason || 'Download or import an Android system image (ISO) first');
    }
    if (!env.disk.ok) await this.provisioner.createDisk(this.settings.runtime.diskSizeGB || 24, () => {});
    this.installing = true;
    const r = await this.boot({ install: true, onLog });
    if (!r.ok) throw new Error(r.error || 'The installer VM failed to start');
    return r;
  }

  /** After install: stop the installer, write the marker, boot from disk from then on */
  async markInstalled() {
    if (this.installing) {
      try { await this.stop({ graceful: true }); } catch (_) { /* ignore */ }
    }
    store.saveSettings({ runtime: { installed: true } });
    this.installing = false;
    return true;
  }

  // ---------------- ensure ----------------

  /**
   * Adopt the emulator left running by the previous session.
   * Each emulator has a console port (5554/5556/…) and an adb port one higher.
   * If the port answers and the system is boot_completed it becomes our runtime,
   * so reopening after an exit is instant instead of another cold boot.
   */
  /**
   * Find every live emulator console port.
   * Scanning upward from 5554 alone is not enough: ports drift (5554→5556→5558…)
   * and a fixed range eventually misses, spawning yet another VM. Ports are read from
   * every TCP port qemu listens on, so none is missed.
   */
  async emulatorPorts() {
    const run = (cmd, args) => new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        resolve(err ? '' : String(out || ''));
      });
    });
    const ports = new Set();
    try {
      const tl = await run('tasklist', ['/FO', 'CSV', '/NH']);
      const pids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) pids.add(m[2]);
      }
      if (!pids.size) return [];
      const ns = await run('netstat', ['-ano', '-p', 'TCP']);
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && pids.has(m[2])) ports.add(Number(m[1]));
      }
    } catch (_) { /* fall back to port probing */ }

    if (ports.size) {
      // Both the console port (even) and adb (+1) listen; keep the console port
      const all = [...ports].sort((a, b) => a - b);
      const consoles = all.filter((p) => ports.has(p + 1));
      return consoles.length ? consoles : all;
    }
    // Fallback: probe directly when there is no qemu process info (a refused connect is cheap)
    const found = [];
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await portAlive(port, 120)) found.push(port);
    }
    return found;
  }

  async adoptExisting({ onLog = () => {} } = {}) {
    const alive = await this.emulatorPorts();
    if (!alive.length) {
      onLog('No previous runtime found, cold booting');
      return null;
    }
    onLog(`Found ${alive.length} live runtime(s) (ports ${alive.join(', ')}), adopting`);

    // The adb server may hold a stale offline entry (the emulator restarted adbd),
    // so clear it first; otherwise get-state stays offline and a healthy VM gets killed.
    await this.client().exec(['kill-server'], { withSerial: false, timeout: 8000 }).catch(() => {});

    for (const port of alive) {
      const serial = `127.0.0.1:${port + 1}`;
      const c = this.client(serial);
      let booted = '';
      for (let i = 0; i < 6 && booted !== '1'; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await c.connect().catch(() => false);
        // eslint-disable-next-line no-await-in-loop
        const state = (await c.exec(['get-state'], { timeout: 5000 }).then((r) => r.stdout).catch(() => '')).trim();
        if (state === 'device') {
          // eslint-disable-next-line no-await-in-loop
          booted = (await c.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => '')).trim();
        }
        if (booted !== '1') await new Promise((r) => setTimeout(r, 700));
      }
      if (booted !== '1') {
        onLog(`Previous runtime (${serial}) is not ready; stopping it and booting again`);
        // The AVD lock would make a new instance exit — 'it never boots'.
        // adb is gone, so the process is found by console port and killed.
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            const { execFile } = require('child_process');
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      this.emuSerial = serial;
      this.emulator.port = port;
      store.saveSettings({ device: serial });
      onLog(`Adopted the running runtime (${serial})`);
      // eslint-disable-next-line no-await-in-loop
      await this.prepare(c);
      return { ok: true, client: c, engine: 'emulator', reused: true };
    }
    return null;
  }

  /** Which process listens on a TCP port (to kill a stuck emulator) */
  async pidOnPort(port) {
    return new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(0);
        const line = stdout.split('\n').find((l) => new RegExp(`:${port}\\s`).test(l) && /LISTENING/i.test(l));
        const m = line && /(\d+)\s*$/.exec(line.trim());
        return resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /**
   * Clean up orphan emulators left by a previous run that were not adopted.
   * The emulator is detached, so qemu survives; it still holds the AVD lock next start
   * and a cold boot fails with "Running multiple emulators with the same AVD".
   * The logic lives in EmulatorEngine and killAttempt reuses it.
   */
  async killOrphanEmulators({ onLog = () => {} } = {}) {
    return this.emulator.killOrphanProcesses({ onLog });
  }

  /**
   * Idempotent entry: prewarm and a user click can race; one Promise is shared
   * so both do not see 'offline' and start two VMs (AVD lock clash, double memory).
   */
  async ensure({ onLog = () => {} } = {}) {
    if (this._ensurePromise) return this._ensurePromise;
    const p = this._ensureInner({ onLog });
    this._ensurePromise = p;
    const clear = () => { if (this._ensurePromise === p) this._ensurePromise = null; };
    p.then(clear, clear);
    return p;
  }

  async _ensureInner({ onLog = () => {} } = {}) {
    const client = this.client();
    if (await client.isOnline()) {
      await this.prepare(client);
      return { ok: true, client, engine: 'builtin', reused: true };
    }

    // The emulator survives our exit (fast reopen) but the new process has no handle
    // and the adb server may have been restarted — isOnline() alone says 'no runtime',
    // so a new one starts. Live emulators are adopted first to avoid duplicate VMs.
    const adopted = await this.adoptExisting({ onLog });
    if (adopted) return adopted;

    // An emulator from a previous session or another process is reused, never duplicated
    try {
      const devices = await client.devices();
      const running = devices.find((d) => /^emulator-\d+$/.test(d.serial) && d.state === 'device');
      if (running) {
        this.emuSerial = running.serial;
        const m = /(\d+)$/.exec(running.serial);
        if (m) this.emulator.port = Number(m[1]);
        const c2 = this.client(running.serial);
        await this.prepare(c2);
        return { ok: true, client: c2, engine: 'emulator', reused: true };
      }
    } catch (_) { /* none found — start normally */ }

    // Process alive but device offline (stuck booting): stop and restart instead of waiting
    if (this.emulator.running()) {
      onLog('A stuck runtime was detected, restarting…');
      await this.emulator.stop({ adbPath: this.adbPath() });
    }

    const s = this.settings;

    // Advanced mode: attach to an existing runtime
    if (s.engine.mode === 'attach') {
      onLog('Probing for an existing runtime…');
      const found = await this.probe();
      if (found.length) {
        store.saveSettings({ device: found[0].serial });
        const c2 = this.client(found[0].serial);
        if (await c2.isOnline()) {
          await this.prepare(c2);
          return { ok: true, client: c2, engine: found[0].name };
        }
      }
      return { ok: false, needsSetup: 'attach', error: 'No usable runtime found' };
    }

    // Default: our own runtime
    // The bundled image is compressed: unpack it first (instant when already unpacked).
    // Do not swallow an unpack failure: checkEnv() would only report a missing image
    // and the user would blame the download instead of a full disk or a corrupt file.
    await this.provisioner.materializeImages(onLog).catch((e) => {
      onLog(`System image unpack failed: ${e.message}`);
      this.log(`materialize failed: ${e.message}`);
    });
    const env = await this.provisioner.checkEnv();

    // Emulator path: the image is the system, there is no install step
    if (env.emulator.ok && env.sysimg.ok) {
      // An unadopted emulator may survive our exit (detached qemu),
      // holding the AVD lock so a cold boot fails with "Running multiple emulators with the same AVD".
      // Orphans are cleared before a cold boot so a restart always works.
      await this.killOrphanEmulators({ onLog }).catch(() => {});
      try {
        const r = await this.boot({ onLog });
        if (r.ok) return { ok: true, client: r.client, engine: 'emulator', profile: r.profile, network: r.network || null };
        return {
          ok: false, error: r.error, env,
          diagnosis: r.diagnosis, report: r.report, attempts: r.attempts, exitCode: r.exitCode,
        };
      } catch (e) {
        return { ok: false, error: e.message, env };
      }
    }

    // QEMU path (user-supplied ISO already installed on the virtual disk)
    if (!s.runtime.installed) {
      return {
        ok: false,
        needsSetup: env.emulator.ok ? 'sysimg' : 'provision',
        error: env.emulator.ok
          ? 'System image missing: press "Download system image"'
          : 'Runtime components are not deployed yet',
        env,
      };
    }

    try {
      const r = await this.boot({ onLog });
      if (r.ok) return { ok: true, client: r.client, engine: 'builtin' };
      return { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------------- app-level container session ----------------

  /**
   * 'Open like a container' in practice:
   * Android boots once and stays resident (quickboot snapshot + adoptExisting),
   * so opening an app is just am start plus surfacing its window.
   * Three extra things reduce load:
   *   - stop other user apps so only what the current app needs runs;
   *   - give qemu a 'yields to the foreground' priority while a window is open;
   *   - run file sync and notification polling only with a window open (onActive).
   */
  async beginApp(pkg, { onActive = () => {} } = {}) {
    const first = this._activeApps.size === 0;
    this._activeApps.add(pkg);
    this.touch();
    const state = container.nextSessionState([...this._activeApps], 'open', pkg);
    const s = this.settings;
    const mode = (s.engine && s.engine.priorityMode) || 'balanced';
    // Scheduling level with an app in front. balanced uses normal, not below:
    // below starves qemu on a busy host — dropped video frames and laggy clicks —
    // the main cause of 'clicks feel slow'. normal matches the desktop and costs nothing extra.
    const level = mode === 'game' ? 'game' : 'normal';

    if (first) {
      // An app is about to open: postpone the idle snapshot so it does not compete for disk
      this.emulator.cancelSnapshotSave();
    }
    // Re-raise the priority on every open/switch back: endApp parks qemu at idle,
    // and without a re-raise the app feels sluggish. setPriority is idempotent,
    // doing nothing when already at the target.
    await this.emulator.setPriority(level).catch(() => {});
    if (first) {
      try { onActive(true); } catch (_) { /* a polling failure does not block the launch */ }
    }

    const installed = store.getApps().map((a) => a && a.package).filter(Boolean);
    const plan = container.buildSessionCommands({
      pkg,
      installed,
      deep: !!(s.engine && s.engine.deepTrim),
      // Right after am start, clearing the background could hit the app coming to the front; endApp clears
      killBackground: false,
    });
    if (plan.commands.length) {
      await this.client().shell(plan.commands.join(' ; '), { timeout: 20000 }).catch(() => '');
    }
    this.log(container.describeSession(state, plan));
    return { ...state, plan };
  }

  /**
   * Close an app window: stop its process; when it was the last one, park the container
   * (clear background + Android idle + lower qemu priority) so it barely costs anything.
   * No shutdown, no AVD deletion — the next open is instant.
   */
  async endApp(pkg, { onIdle = () => {} } = {}) {
    this._activeApps.delete(pkg);
    await this.client().forceStop(pkg).catch(() => {});
    const state = container.nextSessionState([...this._activeApps], 'close', pkg);
    if (state.idle) {
      const s = this.settings;
      const cmds = container.buildIdleCommands({ deep: !!(s.engine && s.engine.deepTrim) });
      await this.client().shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => '');
      // In game mode keep the high priority even without a window,
      // otherwise the next launch re-raises it and the first input lags.
      const keepHigh = (s.engine && s.engine.priorityMode) === 'game';
      await this.emulator.setPriority(keepHigh ? 'normal' : 'idle').catch(() => {});
      // Now idle: save the memory state so the next start resumes instead of cold booting
      this._armSnapshotSave(8000);
      try { onIdle(true); } catch (_) { /* ignore */ }
      this.log('container parked (Android resident, 0 app processes, qemu lowest priority)');
    }
    return state;
  }

  get activeApps() { return [...this._activeApps]; }
  get containerIdle() { return this._activeApps.size === 0; }

  /** Restore packages disabled by deep trim (called from Settings) */
  async restoreSystemApps() {
    const cmds = container.buildRestoreCommands();
    await this.client().shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
    return true;
  }

  setGuestPriority(level) { return this.emulator.setPriority(level); }

  // ---------------- idle reclaim ----------------

  startWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(async () => {
      const s = this.settings;
      const limit = (s.engine.idleShutdownMinutes || 0) * 60000;
      if (!limit) return;
      // An adopted emulator has no local proc handle, so vmRunning is false:
      // it used to return early and the container was never reclaimed. Now adb is checked too.
      if (!this.vmRunning) {
        const online = await this.client().isOnline().catch(() => false);
        if (!online) return;
      }
      if (this._activeApps.size > 0 || Date.now() - this.lastActivity < limit) return;
      try {
        const running = await this.client().runningPackages();
        const alive = running.filter((p) => !/launcher|systemui|settings|inputmethod|android\.systemui/i.test(p));
        if (alive.length === 0) await this.stop();
        else this.lastActivity = Date.now();
      } catch (_) { /* ignore */ }
    }, 60000);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  get vmRunning() { return this.emulator.running() || !!(this.vmProc && !this.vmProc.killed); }

  // ---------------- diagnostics / slimming (UI) ----------------

  async diagnostics() {
    const env = this.provisioner.paths();
    const checked = await this.provisioner.checkEnv();
    const profile = this.emulator.profile || doctor.autoProfile({
      settings: this.settings,
      accel: checked.accel,
      emulatorVersion: checked.emulator.version || '',
      diskMB: doctor.freeDiskMB(store.DATA_DIR),
    });
    // In-memory attempts only live for this session; a report after a restart is empty.
    // The on-disk failure record and the tail of emulator.log are used instead — otherwise
    // the report only says UNKNOWN and hides the cause (issue #20/#25).
    const persisted = this.emulator.lastFailure ? this.emulator.lastFailure() : null;
    const liveAttempts = this.emulator.attempts || [];
    const attempts = liveAttempts.length ? liveAttempts : ((persisted && persisted.attempts) || []);
    const diagnosis = this.emulator.lastDiagnosis || (persisted && persisted.diagnosis) || null;
    const exitCode = this.emulator.lastExitCode != null ? this.emulator.lastExitCode
      : (persisted ? persisted.exitCode : null);
    let logLines = this.emulator.recentLog(300);
    if (!logLines.length && this.emulator.tailLogFile) logLines = this.emulator.tailLogFile(300);
    return doctor.writeReport({
      dataDir: store.DATA_DIR,
      profile,
      logLines,
      extra: {
        attempts,
        diagnosis,
        exitCode,
        exitMeaning: persisted && persisted.exitMeaning ? persisted.exitMeaning : '',
        lastFailure: persisted,
        runtimeDir: env.root,
        serial: this.emuSerial,
        bootLog: this.bootLog,
      },
    });
  }

  usage() { return require('./layers').summary(this.provisioner.paths().root); }

  /**
   * Reclaim old images / AVDs / lock files / snapshots in the runtime.
   * Why cleanup did nothing before: with the runtime running, keepSnapshots excluded the
   * quickboot snapshot (a few GB of ram.img), leaving almost nothing to reclaim.
   * includeSnapshots now stops the runtime first so snapshots can really be reclaimed.
   */
  async cleanup({ apply = false, aggressive = false, includeSnapshots = false } = {}) {
    let stoppedVm = false;
    if (includeSnapshots && this.vmRunning) {
      await this.stop().catch(() => {});
      stoppedVm = true;
    }
    const report = require('./layers').prune(this.provisioner.paths().root, {
      apply, aggressive, keepSnapshots: !includeSnapshots && this.vmRunning,
    });
    // If the preview stopped the VM, tell the user the runtime can be restarted afterwards
    return { ...report, apply, stoppedVm };
  }

  /**
   * Fully reset Android data (/data, installed apps, quickboot snapshot),
   * returning the AVD to a freshly installed system without third-party apps.
   * This really deletes the 8-16 GB userdata image, needs double confirmation (UI) and touches
   * only the active AVD (apkstart.avd), never the read-only base image or other AVDs.
   * config.ini / hardware-qemu.ini stay valid; the next launch cold boots and recreates data.
   * @returns {{ok:boolean, reclaimed:number, avdDir:string, error?:string}}
   */
  async resetAndroidData() {
    const fs = require('fs');
    const path = require('path');
    try {
      if (this.vmRunning) await this.stop().catch(() => {});
      const avdDir = path.join(this.provisioner.paths().avdHome, 'apkstart.avd');
      let reclaimed = 0;
      if (fs.existsSync(avdDir)) {
        for (const e of fs.readdirSync(avdDir, { withFileTypes: true })) {
          const p = path.join(avdDir, e.name);
          // Delete: userdata images (qcow2 delta + base), quickboot snapshot, stale lock files/dirs.
          // Keep: config.ini / hardware-qemu.ini / AVD.conf / cache.img / encryptionkey* / initrd /
          //       modem_simulator / *.ini / *.txt / *.cache — they are the AVD's identity and infrastructure;
          //       deleting them breaks the AVD. The next launch rebuilds /data as with -wipe-data.
          const isUserdata = /^userdata(-qemu)?(-[0-9]+)?\.img(\.qcow2)?$/.test(e.name)
            || /^userdata\.img(\.qcow2)?\.\d+$/.test(e.name);
          const isSnapshot = /^snapshots(\.stale-\d+)?$/.test(e.name);
          const isLock = /\.lock$/.test(e.name);
          if (!e.isDirectory() && !isUserdata && !isLock) continue;
          if (e.isDirectory() && !isSnapshot && !isLock) continue;
          try {
            if (e.isDirectory()) {
              const s = require('./layers').dirSize(p);
              fs.rmSync(p, { recursive: true, force: true });
              reclaimed += s;
            } else {
              const s = fs.statSync(p).size;
              fs.rmSync(p, { force: true });
              reclaimed += s;
            }
          } catch (_) { /* busy — skip and clean next time */ }
        }
      }
      // Once the userdata image is gone the app list must be cleared too,
      // otherwise the launcher keeps showing apps that no longer exist.
      try { store.saveApps([]); } catch (_) { /* ignore */ }
      return { ok: true, reclaimed, avdDir };
    } catch (e) {
      return { ok: false, reclaimed: 0, avdDir: '', error: e.message };
    }
  }

  /**
   * Wait for the VM network.
   *
   * `sys.boot_completed` only means the system is up; Wi-Fi association and DHCP need
   * another 10-90 s to get 10.0.2.16. Video apps fetch their home feed immediately,
   * and without a network the page renders as a black rectangle (the consent dialog is local),
   * which reads as 'black screen after Accept'. Wait for the network before launching.
   *
   * @returns {Promise<{ok:boolean,reason:string,ip?:string,gateway?:string}>}
   */
  async waitForNetwork({ timeoutMs = 90000, onLog = () => {}, adbPath = '' } = {}) {
    const t0 = Date.now();
    let last = null;
    let lastNotice = 0;
    let offlineSince = 0;
    while (Date.now() - t0 < timeoutMs) {
      const online = await this.client().isOnline().catch(() => false);
      if (!online) {
        // A freshly restarted VM has no adb yet; a single offline must not abort
        // (it used to return device-offline right after a reset and report a failed repair).
        if (!offlineSince) offlineSince = Date.now();
        if (Date.now() - offlineSince > 45000) return { ok: false, reason: 'device-offline' };
      } else {
        offlineSince = 0;
        // eslint-disable-next-line no-await-in-loop
        last = await this.emulator.checkNetwork(adbPath || this.adbPath()).catch(() => null);
        if (last && last.ok) return last;
      }
      if (Date.now() - lastNotice > 10000) {
        lastNotice = Date.now();
        onLog(`Waiting for the Android VM network… ${Math.round((Date.now() - t0) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 3000));
    }
    return last || { ok: false, reason: 'timeout' };
  }

  /**
   * Repair 'the Android VM has no network'.
   * Usually Wi-Fi association lags the boot and a restart plus a wait is enough;
   * user data is NOT touched. Only a timeout suggests 'Reset Android data'.
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, error?:string}>}
   */
  /**
   * Ensure the VM has a network: wait, then cold boot once (skipping a possibly offline snapshot).
   * This fixes 'black screen after Accept': apps must start only with a working network.
   *
   * @returns {Promise<{ok:boolean,reason?:string,ip?:string,gateway?:string}>}
   */
  async ensureNetwork({ onLog = () => {}, firstWaitMs = 25000, secondWaitMs = 90000 } = {}) {
    let net = await this.waitForNetwork({ onLog, timeoutMs: firstWaitMs });
    if (net && net.ok) return net;
    // A cold boot is expensive: once per process, otherwise every launch pays it
    // and opening an app takes minutes.
    if (this._netColdBootTried) return net;
    this._netColdBootTried = true;
    onLog('Network still down, cold booting the VM once (no snapshot) and retrying…');
    try {
      await this.stop({ graceful: false }).catch(() => {});
      this.emulator.forceColdBootOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) return { ok: false, reason: 'boot-failed' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    net = await this.waitForNetwork({ onLog, timeoutMs: secondWaitMs });
    if (net && net.ok) {
      // Save a snapshot as soon as the network works so the next resume restores it
      try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
    }
    return net;
  }

  /**
   * Repair 'the Android VM has no network'.
   * Order: cold boot (no data touched) → wait → only then reset data (loses in-app data).
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, wiped?:boolean, error?:string}>}
   */
  async repairNetwork({ onLog = () => {} } = {}) {
    try {
      // Reset the data directly: the only reliably working fix for this image.
      // (cold booting and waiting three minutes never reconnects Wi-Fi on existing data.)
      onLog('Repairing the VM network: resetting Android data and rebooting (apps reinstall on open)…');
      if (this.vmRunning) await this.stop({ graceful: false }).catch(() => {});
      // Let the previous qemu / netsimd exit cleanly, or -wipe-data hits the AVD lock
      await new Promise((r) => setTimeout(r, 2500));
      this.emulator.forceWipeOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) {
        return { ok: false, error: (boot && boot.error) || 'The VM did not start', boot: false, wiped: true };
      }
      const network = await this.waitForNetwork({ onLog, timeoutMs: 240000 });
      if (network && network.ok) {
        // Snapshot the working network immediately so the next resume restores it,
        // otherwise a restart returns to the offline state.
        try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
        onLog(`Network restored (${network.ip || ''}, gateway ${network.gateway || 'reachable'}), snapshot saved.`);
      } else {
        onLog('Still offline after the reset. Check the host network/firewall (netsimd uses loopback).');
      }
      return { ok: !!(network && network.ok), network, boot: true, wiped: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  dispose() {
    if (this._watchdog) clearInterval(this._watchdog);
    if (this._client && this._client.disposeInput) this._client.disposeInput();
    this.emulator.cancelSnapshotSave();
    // qemu must NEVER be killed here:
    //  1) a kill truncates the quickboot snapshot mid-write, leaving a multi-GB empty ram.img,
    //     so the next boot falls back to a full cold start — 'it always takes two minutes';
    //  2) keeping it lets the next ApkStart session adopt it and open apps instantly.
    // Uninstall takes another path (app:removeSelf cleans the processes explicitly).
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
  }

  get bootLog() { return this._bootLog.slice(-60); }
}

module.exports = { Runtime, MONITOR_PORT };
