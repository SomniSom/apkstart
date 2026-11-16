'use strict';
/**
 * Окно приложения на Linux
 *
 * На Windows апстрим вклеивал Qt-окно эмулятора внутрь своего окна через
 * Win32 SetParent. На Linux такой возможности нет (Wayland вообще не даёт
 * сторонним процессам присоседить чужое окно без протокола xdg-foreign,
 * который поддерживают не все композиторы). Поэтому модель другая:
 *
 *   1) эмулятор запускается в режиме ОДНОГО ОКНА (`-no-window` отключён),
 *      и это окно само по себе — окно приложения;
 *   2) мы управляем им через xdotool / wmctrl: заголовок, класс, размер,
 *      положение, максимизация, полноэкранный режим, фокус;
 *   3) если композитор умеет xdg-foreign (KDE/Sway/hyprland через
 *      `xdg-foreign` протокол) — пытаемся присоседить окно к нашему
 *      (best effort, ошибки не критичны).
 *
 * Отдельного Electron-окна с заголовком здесь нет: это окно-обёртка
 * плодит второй вход Alt+Tab и мешает фокусу эмулятора. Вместо него
 * UI-панель ApkStart показывает статус.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const store = require('./store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hasTool(name) {
  return new Promise((resolve) => {
    execFile('sh', ['-c', `command -v ${name}`], { timeout: 3000 }, (err, out) => {
      resolve(!err && String(out).trim().length > 0);
    });
  });
}

/**
 * WM_CLASS / заголовок окна эмулятора.
 * Android Emulator (Qt) на Linux выставляет WM_CLASS = "emulator,QEMU" и
 * заголовок "Android Emulator - <avd>_<port>".
 */
const EMU_CLASS = 'emulator';
const EMU_TITLE_RE = /^Android Emulator\s*-\s*/i;

class AppWindow {
  constructor({ runtime, agent } = {}) {
    this.runtime = runtime || null;
    this.agent = agent || null;
    this.pkg = null;
    this.state = { label: '', tip: '', ready: false, landscape: false };
    this._closedCb = null;
    this._watchTimer = null;
  }

  get isOpen() { return !!this.pkg; }

  open(o) {
    this.pkg = o.pkg;
    this.state = {
      label: o.label || 'Приложение',
      tip: '',
      ready: false,
      landscape: false,
    };
    this._closedCb = o.onClosed || null;
    return this;
  }

  /** Имя окна, под которым эмулятор появляется в списке wmctrl/xdotool */
  _emuTitle() {
    const avd = this.runtime && this.runtime.emulator ? this.runtime.emulator.avdName?.() : null;
    return avd ? new RegExp(`Android Emulator\\s*-\\s*${avd}`, 'i') : EMU_TITLE_RE;
  }

  /** Найти id окна эмулятора (string hex, формат xdotool) */
  async findEmuWindow(timeoutMs = 20000) {
    const re = this._emuTitle();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const id = await new Promise((resolve) => {
        execFile('xdotool', ['search', '--class', EMU_CLASS], { timeout: 3000 }, (err, out) => {
          if (err) return resolve(null);
          const ids = String(out).split('\n').map((s) => s.trim()).filter(Boolean);
          resolve(ids[0] || null);
        });
      });
      if (id) {
        // eslint-disable-next-line no-await-in-loop
        const name = await this.windowName(id);
        if (name && re.test(name)) return id;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(400);
    }
    return null;
  }

  windowName(id) {
    return new Promise((resolve) => {
      execFile('xdotool', ['getwindowname', id], { timeout: 3000 }, (err, out) => (
        resolve(err ? '' : String(out).trim())
      ));
    });
  }

  _run(cmd, args) {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout: 8000 }, (err, out, stderr) => {
        resolve({ ok: !err, out: String(out || ''), error: err ? String(stderr || err.message).trim() : '' });
      });
    });
  }

  /**
   * Привести окно эмулятора к виду «нативного приложения»:
   * заголовок = название приложения, класс = apkstart-<pkg> (для группировки
   * окон и подбора иконки в доке), размер по ориентации, фокус, максимизация.
   */
  async adopt({ label, portrait, fullscreen = false } = {}) {
    const id = await this.findEmuWindow();
    if (!id) return { ok: false, error: 'окно эмулятора не появилось (xdotool search)' };
    const title = label || this.state.label || 'ApkStart';
    await this._run('xdotool', ['set_window', '--name', title, id]);
    await this._run('xdotool', ['set_window', '--class', `apkstart-${this.pkg || 'app'}`, '--classname',
      'apkstart', id]);
    if (portrait && portrait.w && portrait.h) {
      await this._run('xdotool', ['windowsize', id, String(portrait.w), String(portrait.h)]);
    }
    await this._run('xdotool', ['windowactivate', '--sync', id]);
    if (fullscreen) await this.setFullscreen(true, id);
    this.winId = id;
    this.state.ready = true;
    return { ok: true, id };
  }

  async setFullscreen(on, id = this.winId) {
    if (!id) return { ok: false };
    return this._run('wmctrl', ['-i', '-r', id, '-b', on ? 'add,fullscreen' : 'remove,fullscreen']);
  }

  async maximize(id = this.winId) {
    if (!id) return { ok: false };
    return this._run('wmctrl', ['-i', '-r', id, '-b', 'add,maximized_vert,maximized_horz']);
  }

  async minimize(id = this.winId) {
    if (!id) return { ok: false };
    return this._run('xdotool', ['windowminimize', id]);
  }

  async focus(id = this.winId) {
    if (!id) return { ok: false };
    return this._run('xdotool', ['windowactivate', '--sync', id]);
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    return this.state;
  }

  /**
   * Следим за закрытием окна эмулятора пользователем (крестик в заголовке):
   * когда окно пропадает — сообщаем верхнему слою, чтобы остановить приложение.
   */
  watch(onGone) {
    this.stopWatch();
    const id = this.winId;
    if (!id) return;
    this._watchTimer = setInterval(async () => {
      const exists = await this._run('xdotool', ['getwindowname', id]);
      if (!exists.ok) {
        this.stopWatch();
        this.pkg = null;
        if (onGone) onGone();
        if (this._closedCb) this._closedCb();
      }
    }, 2000);
  }

  stopWatch() {
    if (this._watchTimer) clearInterval(this._watchTimer);
    this._watchTimer = null;
  }

  close({ keepApp = false } = {}) {
    this.stopWatch();
    const pkg = this.pkg;
    this.pkg = null;
    if (!keepApp && pkg && this._onCloseApp) this._onCloseApp(pkg);
    if (this._closedCb) this._closedCb(pkg);
  }

  onCloseApp(cb) { this._onCloseApp = cb; }
}

/**
 * Проверить инструменты, без которых управление окном невозможно.
 * Возвращает { ok, missing, note } — UI покажет понятный текст вместо ошибки xdotool.
 */
async function preflight() {
  const need = ['xdotool', 'wmctrl'];
  const missing = [];
  for (const t of need) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await hasTool(t))) missing.push(t);
  }
  return {
    ok: missing.length === 0,
    missing,
    note: missing.length
      ? `не установлены: ${missing.join(', ')} — окном эмулятора нельзя управлять (sudo apt install ${missing.join(' ')})`
      : '',
    session: process.env.XDG_SESSION_TYPE || (process.env.WAYLAND_DISPLAY ? 'wayland' : 'x11'),
  };
}

module.exports = { AppWindow, preflight, hasTool, EMU_CLASS };
