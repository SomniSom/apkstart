'use strict';
/**
 * Window agent: talks to the long-lived helper (Windows-only module, not used on Linux).
 *
 * Why not spawn a helper per call: resizing while dragging takes many round trips,
 * and each spawn costs 150-300 ms, which makes dragging stutter.
 * The agent starts once and then speaks over loopback TCP (one JSON per line), under 2 ms per round trip.
 *
 * The agent may also own a WH_MOUSE_LL hook: right-click Back / wheel scroll / side buttons.
 * The hook is global and sees every mouse event, so it is installed only while the app window
 * is focused and at least one mapping is on; it is removed on blur and handles 7 messages.
 * See setHook(on, opts).
 */
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const SCRIPT = path.join(__dirname, 'win', 'agent.ps1');
const CALL_TIMEOUT = 6000;

class WinAgent extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.sock = null;
    this.port = 0;
    this.ready = null;
    this.buf = '';
    this.pending = [];
    this.dead = false;
    this.hooked = false;
    this.hookConf = null;
  }

  get available() { return process.platform === 'win32' && fs.existsSync(SCRIPT); }

  /** Start the agent and wait for TCP (idempotent) */
  ensure() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      if (!this.available) { reject(new Error('Window agent unavailable')); return; }
      let out = '';
      let settled = false;
      const proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Port', '0',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

      this.proc = proc;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        this.ready = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      const onData = (chunk) => {
        out += chunk.toString('utf8');
        const m = /PORT=(\d+)/.exec(out);
        if (!m || settled) return;
        settled = true;
        this.port = Number(m[1]);
        this._connect().then(resolve).catch(fail);
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', (d) => { out += d.toString('utf8'); });
      proc.on('error', fail);
      proc.on('exit', () => {
        const wasReady = !!this.sock;
        this.proc = null;
        this.sock = null;
        this.ready = null;
        this.hooked = false;
        this.hookConf = null;
        this._failAll('Window agent exited');
        if (wasReady) this.emit('exit');
        fail(new Error('Window agent failed to start'));
      });
      setTimeout(() => { if (!settled) fail(new Error('Window agent start timed out')); }, 15000);
    });
    return this.ready;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: this.port }, () => resolve(this));
      sock.setEncoding('utf8');
      sock.setNoDelay(true);
      sock.on('data', (d) => this._onData(d));
      sock.on('error', (e) => { reject(e); });
      sock.on('close', () => {
        this.sock = null;
        this.ready = null;
        this._failAll('Window agent connection closed');
      });
      this.sock = sock;
      this.buf = '';
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      // Events carry a payload (wheel dx/dy/nx/ny); older listeners ignore extra args
      if (msg.ev) { this.emit(msg.ev, msg); continue; }
      const p = this.pending.shift();
      if (p) { clearTimeout(p.timer); p.resolve(msg); }
    }
  }

  _failAll(reason) {
    const list = this.pending;
    this.pending = [];
    for (const p of list) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
  }

  /** Send one command and wait for the reply */
  async call(obj, timeout = CALL_TIMEOUT) {
    await this.ensure();
    if (!this.sock) throw new Error('Window agent not connected');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Window agent timeout: ${obj.cmd}`)), timeout);
      this.pending.push({ resolve, reject, timer });
      this.sock.write(`${JSON.stringify(obj)}\n`);
    });
  }

  // ---------------- convenience methods ----------------

  /**
   * Declare whose processes count as ours.
   * Must be called before bootHide / embed: the agent only touches windows of these processes.
   * Empty (or omitted) means it never moves a window — better an occasional stray console
   * than hiding or embedding another Qt app (messengers, players) by mistake.
   * @param {string[]} dirs runtime root / bundled engine directory
   * @param {number} [appPid] main process pid: the agent may only embed into this process,
   *        and uses it to decide whether a mouse event belongs to us (guards handle reuse)
   */
  async scope(dirs, appPid) {
    const list = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
    const req = { cmd: 'scope', dirs: list.join(';') };
    if (Number(appPid) > 0) req.pid = Number(appPid);
    return this.call(req, 4000).catch(() => ({ ok: false, n: 0 }));
  }

  /** Embed the emulator window into the host window at x,y,w,h (client coords) */
  async embed(hostHwnd, rect) {
    return this.call({
      cmd: 'embed', host: String(hostHwnd),
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    });
  }

  async fit(rect) {
    return this.call({
      cmd: 'fit',
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
      // The Qt window has an EMU_PAD frame around the LCD; overflow it up/left to push the frame
      // outside the client area, then clip the strip over the titlebar.
      clipTop: Math.round(rect.clipTop || 0),
    }, 3000);
  }

  async rotate(dir = 'left') { return this.call({ cmd: 'rotate', dir }, 8000); }
  async hide() { return this.call({ cmd: 'hide' }, 3000); }
  async show() { return this.call({ cmd: 'show' }, 3000); }
  /** Put the agent in low-latency mode: scan windows far less often, leave CPU to Android */
  async setPerformanceMode(on) { return this.call({ cmd: 'perf', on: on ? 1 : 0 }, 3000); }
  async detach() { return this.call({ cmd: 'detach' }, 5000); }
  async probe() { return this.call({ cmd: 'probe' }, 4000); }
  /** List visible top-level windows (to verify the window set) */
  async windows() { return this.call({ cmd: 'windows' }, 4000); }

  /**
   * Detach and hide the prime suspect window.
   * Must run before the host window is destroyed: the OS re-parents cross-process child windows
   * to the desktop with their old visibility — that is where stray emulator windows come from.
   * A busy agent must not delay closing, hence the hard 700 ms cap.
   */
  async park(maxWaitMs = 700) {
    const call = this.call({ cmd: 'park' }, 2000).catch(() => ({ ok: false }));
    if (!maxWaitMs) return call;
    return Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), maxWaitMs)),
    ]);
  }

  /**
   * Enable permanent suppression: the emulator main window, its toolbar and the qemu / netsimd
   * consoles must never show, except the one embedded into our window.
   * This is what makes 'open the app, see only the app' work: the emulator detaches qemu / netsimd
   * consoles that Node's windowsHide cannot reach, so the agent hides them periodically.
   *
   * maxWaitMs: the agent itself may need to start (hundreds of ms, longer in bad cases).
   * Called before the emulator starts, so a hard cap keeps boot from stalling.
   * @param {number} maxWaitMs
   */
  async bootHide(maxWaitMs = 3000) {
    const call = this.call({ cmd: 'boothide', on: 1 }, 4000).catch(() => ({ ok: false }));
    if (!maxWaitMs) return call;
    return Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), maxWaitMs)),
    ]);
  }

  /** Turn suppression off (usually unnecessary: it skips the embedded window) */
  async bootShow() {
    return this.call({ cmd: 'boothide', on: 0 }, 4000).catch(() => ({ ok: false }));
  }

  /**
   * Global mouse hook switch (idempotent).
   * Installed only with the app window focused and at least one mapping on; option changes
   * update the agent instead of reinstalling the hook thread on every focus change.
   * @param {boolean} on
   * @param {{rightBack?:boolean, wheel?:boolean, side?:boolean}} opts
   */
  async setHook(on, opts = {}) {
    const want = !!on;
    const conf = {
      right: !!(opts && opts.rightBack),
      wheel: !!(opts && opts.wheel),
      side: !!(opts && opts.side),
    };
    // Do not start the helper just to switch something off (zero cold-start cost)
    if (!want && !this.hooked) return { ok: true, hooked: false };
    const sameConf = this.hookConf
      && this.hookConf.right === conf.right
      && this.hookConf.wheel === conf.wheel
      && this.hookConf.side === conf.side;
    if (want === this.hooked && sameConf) return { ok: true, hooked: this.hooked };
    const req = { cmd: 'hook', on: want ? 1 : 0, right: conf.right ? 1 : 0, wheel: conf.wheel ? 1 : 0, side: conf.side ? 1 : 0 };
    if (!want) {
      this.hooked = false;
      this.hookConf = null;
      return this.call(req, 3000).catch(() => ({ ok: false, hooked: false }));
    }
    const r = await this.call(req, 3000).catch(() => null);
    this.hooked = !!(r && r.hooked !== false);
    this.hookConf = this.hooked ? conf : null;
    return { ok: this.hooked, hooked: this.hooked };
  }

  dispose() {
    // Remove the hook before exiting so a kill never leaves a stale hook
    if (this.hooked && this.sock) {
      try { this.sock.write('{"cmd":"hook","on":0}\n'); } catch (_) { /* ignore */ }
    }
    this.hooked = false;
    this.hookConf = null;
    try { this.sock?.end(); } catch (_) { /* ignore */ }
    try { this.sock?.destroy(); } catch (_) { /* ignore */ }
    // The agent process is deliberately not killed: after the disconnect it guards
    // (see _lingerUntil in agent.ps1). The emulator may still be booting and show its window
    // tens of seconds later; a dead agent would leave a stray window. It exits by itself.
    this.sock = null;
    this.proc = null;
    this.ready = null;
  }
}

module.exports = { WinAgent, AGENT_SCRIPT: SCRIPT };
