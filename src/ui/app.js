'use strict';

const api = window.apkstart;
const $ = (id) => document.getElementById(id);

const state = {
  apps: [],
  settings: null,
  status: null,
  filter: '',
  installing: false,
  setupBusy: null,
  menuPkg: null,
};

/* ---------------- utils ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function initialOf(label) {
  const t = String(label || '?').trim();
  return (t[0] || '?').toUpperCase();
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.floor(d / 60000)} min ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} h ago`;
  if (d < 86400000 * 30) return `${Math.floor(d / 86400000)} d ago`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

/**
 * Tiny toast
 *
 * Deduplicate messages and cap the count:
 * On a failed install the runtime log keeps streaming; a toast per line used to pile up
 * the same error over and over, looking like 'the error keeps looping'.
 */
let _toastSeq = 0;
function toast({ title, body = '', type = 'info', progress = null, sticky = false, spinner = false }) {
  const wrap = $('toastWrap');
  // 1) dedupe: same title + body within 4 s refreshes one toast instead of stacking
  const key = `${title}|${body}`;
  const dup = [...wrap.children].find((n) => n.dataset.key === key && Date.now() - Number(n.dataset.at || 0) < 4000);
  if (dup) {
    dup.dataset.at = String(Date.now());
    return {
      el: dup,
      dismiss: () => dup.remove(),
      update: ({ title: t2, body: b2 } = {}) => {
        if (t2 !== undefined) dup.querySelector('.t-title-text').textContent = t2;
        if (b2 !== undefined) dup.querySelector('.t-body').textContent = b2;
      },
    };
  }
  // 2) cap: at most four at once; the oldest goes first
  while (wrap.children.length >= 4) wrap.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.dataset.key = key;
  el.dataset.at = String(Date.now());
  el.dataset.seq = String(++_toastSeq);
  el.innerHTML = `
    <div class="t-title">
      ${spinner ? '<span class="spinner"></span>' : ''}
      <span class="t-title-text">${esc(title)}</span>
    </div>
    <div class="t-body">${esc(body)}</div>
    ${progress === null ? '' : '<div class="bar"><i></i></div>'}
  `;
  $('toastWrap').appendChild(el);

  const dismiss = () => {
    el.style.transition = 'opacity .18s, transform .18s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(4px)';
    setTimeout(() => el.remove(), 200);
  };

  const ctl = {
    el, dismiss,
    update({ title: t2, body: b2, progress: p2, type: ty } = {}) {
      if (t2 !== undefined) el.querySelector('.t-title-text').textContent = t2;
      if (b2 !== undefined) el.querySelector('.t-body').textContent = b2;
      if (p2 !== undefined && el.querySelector('.bar i')) {
        el.querySelector('.bar i').style.width = `${Math.max(2, Math.min(100, p2))}%`;
      }
      if (ty === 'error') el.classList.add('error');
      if (ty === 'ok') {
        el.querySelector('.spinner')?.remove();
        el.classList.remove('error');
      }
    },
  };

  if (!sticky) setTimeout(dismiss, type === 'error' ? 6000 : 3200);
  return ctl;
}

/* ---------------- rendering ---------------- */

function visibleApps() {
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.apps;
  return state.apps.filter((a) => (
    a.label.toLowerCase().includes(q)
    || a.package.toLowerCase().includes(q)
  ));
}

function renderGrid() {
  const apps = visibleApps();
  const grid = $('grid');
  const empty = $('empty');

  const hasAny = state.apps.length > 0;
  grid.classList.toggle('hidden', apps.length === 0);
  empty.classList.toggle('hidden', apps.length > 0);

  if (!hasAny) {
    const s = state.status;
    $('emptyHint').textContent = s && s.adbOk === false
      ? 'First run: open Settings (top right) → Runtime → Set up everything, then install an app.'
      : 'Hint: every app shares one Android runtime, so the second app starts almost instantly.';
    grid.innerHTML = '';
    return;
  }

  grid.innerHTML = apps.map((a) => `
    <div class="card" data-pkg="${esc(a.package)}" title="${esc(a.label)} · ${esc(a.package)}">
      ${a.pinned ? '<span class="pin">★</span>' : ''}
      ${a.running ? '<span class="badge-run" title="Running"></span>' : ''}
      <div class="icon">
        ${a.iconUrl
          ? `<img src="${esc(a.iconUrl)}" alt="" draggable="false" />`
          : `<div class="fallback" style="background:${esc(a.accent || '#9aa6b2')}">${esc(initialOf(a.label))}</div>`}
      </div>
      <div class="name">${esc(a.label)}</div>
      <div class="meta">${a.running ? 'Running' : `v${esc(a.versionName)}${a.lastLaunchAt ? ' · ' + relTime(a.lastLaunchAt) : ''}`}</div>
      <div class="open-hint">${a.running ? 'Bring to front' : 'Open'}</div>
    </div>
  `).join('');
}

/* ---------------- data refresh ---------------- */

async function refreshApps() {
  try {
    state.apps = await api.listApps();
    renderGrid();
    updateStats();
  } catch (e) {
    console.error(e);
  }
}

function updateStats() {
  const n = state.apps.length;
  $('statusStats').textContent = n ? `${n} app(s)` : 'No apps yet';
}

async function refreshStatus() {
  try {
    state.status = await api.runtimeStatus();
    const s = state.status;
    const dot = $('statusDot');
    const text = $('statusText');
    const tag = $('engineTag');

    if (!s.adbOk) {
      dot.className = 'dot err';
      text.textContent = 'Runtime not deployed — Settings → Runtime, set up everything';
      tag.textContent = 'Needs setup';
      tag.className = 'brand-tag';
    } else if (s.deviceOnline) {
      dot.className = 'dot ok';
      text.textContent = `Runtime ready · Android ${s.android || '?'}${s.freeform ? ' · per-app windows on' : ''}`;
      tag.textContent = `Android ${s.android || ''}`.trim();
      tag.className = 'brand-tag ok';
    } else if (s.phase === 'booting' || s.vmStarting) {
      dot.className = 'dot warn';
      text.textContent = 'Booting Android…';
      tag.textContent = 'Booting';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'accel') {
      dot.className = 'dot warn';
      text.textContent = 'No hardware acceleration: software emulation (first boot is slow)';
      tag.textContent = 'Software emulation';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'sysimg') {
      dot.className = 'dot err';
      text.textContent = 'Android 14 image missing — download it in Settings → Runtime (~1.5 GB, once)';
      tag.textContent = 'Image pending';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'emulator') {
      dot.className = 'dot err';
      text.textContent = 'Runtime engine not installed — Settings → Runtime, set up everything';
      tag.textContent = 'Needs setup';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'boot') {
      dot.className = 'dot warn';
      text.textContent = 'Runtime ready — installing an APK or opening a shortcut boots it';
      tag.textContent = 'Not booted';
      tag.className = 'brand-tag';
    } else if (s.installing) {
      dot.className = 'dot warn';
      text.textContent = 'Installer running — finish the installation in the VM window';
      tag.textContent = 'Installing';
      tag.className = 'brand-tag';
    } else {
      dot.className = 'dot';
      text.textContent = s.installed
        ? 'Runtime idle (starts on install or launch)'
        : 'Android is not installed yet — Settings → Runtime to continue';
      tag.textContent = s.installed ? 'Idle' : 'Not installed';
      tag.className = 'brand-tag';
    }
    $('statusDevice').textContent = s.deviceOnline ? (s.serial || '') : '';

    renderSetup(s);
  } catch (e) {
    $('statusText').textContent = `Status check failed: ${e.message}`;
  }
}

/* ---------------- runtime deployment (lives in Settings) ---------------- */

/**
 * Runtime/deploy/self-test panels live in Settings; the main screen lists installed apps.
 * showSetup is kept for the tray menu and ui:navigate: it opens Settings at the runtime panel.
 */
function showSetup(on) {
  if (!on) { $('setupGuide').hidden = true; return; }
  openSettings().then(() => {
    const box = $('runtimeGroup');
    if (box) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }).catch(() => {});
}

function fmtGB(n) { return n ? `${(n / 1073741824).toFixed(2)} GB` : ''; }

function stepRow(opt) {
  const cls = ['step'];
  if (opt.done) cls.push('done');
  if (opt.busy) cls.push('busy');
  return `
    <div class="${cls.join(' ')}" data-step="${opt.key}">
      <div class="idx">${opt.done ? '✓' : opt.index}</div>
      <div class="body">
        <div class="t">${esc(opt.title)}${opt.tag ? `<span class="tag ${opt.req ? 'req' : ''}">${esc(opt.tag)}</span>` : ''}</div>
        <div class="d" data-desc>${esc(opt.desc)}</div>
        <div class="bar"><i data-bar></i></div>
      </div>
      <div class="act">${opt.actions || ''}</div>
    </div>`;
}

function renderSetup(s) {
  if (!s) return;
  const env = s.env || {};
  const hv = env.hypervisor || {};
  const accel = env.accel || s.accel || {};

  // Installed apps are visible right away: no deployment wizard taking over the main screen,
  // status shows in the Settings runtime panel and the bottom status bar.
  const accelOk = accel.ok || hv.kvm;
  const adbDone = !!(env.adb && env.adb.ok);
  const emuDone0 = !!(env.emulator && env.emulator.ok);
  const imgDone0 = !!(env.sysimg && env.sysimg.ok);
  const allDone0 = adbDone && emuDone0 && imgDone0;
  const stateText = $('setupStateText');
  if (stateText) {
    const missing = [];
    if (!adbDone) missing.push('adb');
    if (!emuDone0) missing.push('engine');
    if (!imgDone0) missing.push('system image');
    stateText.textContent = s.deviceOnline
      ? `Ready · Android ${s.android || ''}`
      : s.phase === 'booting' || s.vmStarting
        ? 'Booting Android…'
        : allDone0
          ? 'All components present · not booted (starts on launch)'
          : `Missing ${missing.join(', ')}${accelOk ? '' : ' (no acceleration, software emulation)'}`;
    stateText.title = s.autoProfile || accel.note || hv.note || '';
  }

  const emuDone = !!(env.emulator && env.emulator.ok);
  const imgDone = !!(env.sysimg && env.sysimg.ok);
  const busy = state.setupBusy;
  const booting = s.phase === 'booting';

  // One step only: download, adaptation and boot are chained by 'Set up everything',
  // and the first start runs it in the background — no clicking through steps.
  const allDone = !!(env.adb && env.adb.ok) && emuDone && imgDone;
  const left = [];
  if (!(env.adb && env.adb.ok)) left.push('adb tools');
  if (!emuDone) left.push('Android runtime');
  if (!imgDone) left.push('system image');
  const step = {
    key: 'all',
    index: 1,
    title: allDone ? 'Everything ready' : 'Set up everything',
    tag: allDone ? 'Done automatically' : 'Auto',
    done: allDone,
    busy: !!busy,
    desc: s.deviceOnline
      ? `Android ${s.android || ''} ready · windows adapt to the screen`
      : booting
        ? 'Booting Android…'
        : allDone
          ? 'All components present: any APK or shortcut boots it'
          : `Still missing ${left.join(', ')}; press 'Set up everything' to install and boot in one go`,
    actions: s.deviceOnline
      ? '<button class="btn ghost sm" data-act="vmStop">Stop runtime</button>'
      : '',
  };

  $('setupSteps').innerHTML = stepRow(step);
  $('btnDeployAll').disabled = !!busy;
  $('btnDeployAll').textContent = busy ? 'Preparing…' : (allDone ? 'Done · check again' : 'Set up everything');
  // 'Why did it not start last time' prefers the on-disk failure record: in-memory diagnosis is empty
  // after a restart, and autoProfile alone hides the cause (see issue #20/#25).
  const lf = s.lastFailure;
  const lastMsg = (lf && lf.diagnosis && lf.diagnosis.title)
    ? `Last start failed: ${lf.diagnosis.title}`
    : (s.diagnosis ? `Last start diagnosis: ${s.diagnosis.title}` : '');
  $('setupNote').textContent = lastMsg
    || s.autoProfile || 'Automatic: no image choice, no acceleration setup, no memory tuning';
}

function store_getDiskSize() {
  return (state.settings && state.settings.runtime && state.settings.runtime.diskSizeGB) || 24;
}

function setStepBusy(key, on) {
  state.setupBusy = on ? key : null;
  // The five steps are one row; all sub-step progress goes to this single bar
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (row) {
    row.classList.toggle('busy', !!on);
    if (on) {
      const bar = row.querySelector('[data-bar]');
      if (bar) bar.style.width = '3%';
    }
  }
}

function updateStepProgress(component, p) {
  if (!component) return;
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (!row) return;
  if (p.percent !== undefined) {
    const bar = row.querySelector('[data-bar]');
    if (bar) bar.style.width = `${Math.max(3, Math.min(100, p.percent))}%`;
  }
  if (p.message) {
    const d = row.querySelector('[data-desc]');
    if (d) d.textContent = p.message;
  }
}

async function deployAll() {
  if (state.setupBusy) return;
  setStepBusy('all', true);
  try {
    // One call installs adb / engine / image; progress shows in the single row
    // A manual 'set up' is an explicit retry and bypasses the failure cooldown
    const r = await api.autoDeploy({ force: true });
    if (!r || !r.ok) {
      toast({ title: 'Setup failed', body: (r && r.error) || 'Check the network and retry', type: 'error', sticky: true });
      return;
    }
    await refreshStatus();
    toast({ title: 'Components ready, booting Android…', body: 'About 1-3 minutes the first time, seconds afterwards.', type: 'info' });
    const started = await api.runtimeStart();
    await refreshStatus();
    toast(started && started.ok
      ? { title: 'Runtime ready', body: 'Drop an APK here or double-click a shortcut.', type: 'ok' }
      : { title: 'Boot did not finish', body: (started && started.error) || 'Export the diagnostic report for details', type: 'error', sticky: true });
  } catch (e) {
    toast({ title: 'Setup failed', body: e.message, type: 'error', sticky: true });
  } finally {
    setStepBusy('all', false);
    await refreshStatus();
    selfCheck();
  }
}

async function runStep(key) {
  if (state.setupBusy) return { ok: false, error: 'A setup task is already running' };
  setStepBusy(key, true);
  let r;
  try {
    if (key === 'adb') r = await api.installAdb();
    else if (key === 'emulator') r = await api.installEmulator();
    else if (key === 'sysimg') r = await api.installSysimg();
    else if (key === 'accel') {
      const t = toast({
        title: 'Installing the acceleration setup…',
        body: 'Confirm the permission prompt',
        sticky: true,
        spinner: true,
      });
      r = await api.enableAccel();
      if (r.ok) t.update({ title: 'Hardware acceleration enabled', type: 'ok' });
      else t.update({ title: 'Acceleration not enabled', body: r.error, type: 'error', sticky: true });
    } else if (key === 'qemu') r = await api.installQemu();
    else if (key === 'iso') r = await api.downloadIso();
    else if (key === 'disk') r = await api.createDisk(store_getDiskSize());
    else r = { ok: false, error: 'Unknown step' };
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  setStepBusy(key, false);
  await refreshStatus();
  return r;
}

async function startInstall() {
  const r = await api.startInstaller();
  if (!r.ok) {
    toast({ title: 'Could not start the installer VM', body: r.error, type: 'error', sticky: true });
    return;
  }
  $('setupGuide').hidden = false;
  $('setupGuide').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast({ title: 'VM window opened', body: 'Follow the six steps below, then press “I finished the installation”.', type: 'ok', sticky: true });
}

async function markInstalled() {
  await api.markInstalled();
  await api.runtimeStop();
  $('setupGuide').hidden = true;
  await refreshStatus();
  toast({ title: 'Installed, the runtime took over', body: 'You can drop APKs here now.', type: 'ok' });
}



/* ---------------- install ---------------- */

/** Turn an install failure into 'what to do next' for the common cases; others shown as is */
function friendlyInstallErrorText(msg) {
  const s = String(msg || 'Unknown error');
  if (/INSUFFICIENT_STORAGE|not enough space|ENOSPC/i.test(s)) {
    return `${s}\nThe Android data partition is full: Settings → Performance → grow the data partition and press "Grow now".`;
  }
  if (/NO_MATCHING_ABIS/i.test(s)) return `${s}\nThe package is ARM-only; switching to the compatible image and retrying.`;
  if (/INSTALL_FAILED_ALREADY_EXISTS|signatures do not match/i.test(s)) {
    return `${s}\nSame package, different signature (installed from another source). Right-click the card, Uninstall, then install again.`;
  }
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(s)) return `${s}\nA newer version is installed; uninstall it from the context menu first.`;
  if (/ERR_FS_FILE_TOO_LARGE|greater than possible Buffer|Cannot allocate|ENOMEM|out of memory/i.test(s)) {
    return `${s}\nThe package is too large or memory is short and parsing was refused. Free some disk and RAM and retry;`
      + ' if it still fails, move the APK to a short ASCII path.';
  }
  return s;
}

/* The sticky 'installing…' toast. install:error must be able to dismiss it:
 * the main process sends install:error before the invoke rejects, both may arrive late,
 * and relying on catch alone leaves a spinner after the error. */
let installToast = null;

async function installFiles(paths) {
  if (!paths || !paths.length) return;
  if (state.installing) {
    toast({ title: 'An install is already running', body: 'Wait for the current app to finish.' });
    return;
  }
  state.installing = true;
  let ok = 0;
  let failed = 0;

  for (const p of paths) {
    const name = p.split(/[\\/]/).pop();
    const t = toast({ title: `Installing ${name}`, body: 'Parsing the APK…', progress: 8, sticky: true, spinner: true });
    installToast = t;
    let off = () => {};
    try {
      off = api.on('install:progress', (pr) => {
        const base = { parse: 12, 'parse-done': 24, runtime: 38, install: 62, shortcut: 88, done: 100 }[pr.stage] || 50;
        const pct = pr.percent != null ? Math.min(60, Math.round((pr.percent / 100) * 60)) : base;
        t.update({ title: pr.meta ? `Installing ${pr.meta.label}` : `Installing ${name}`, body: pr.message, progress: pct });
      });
      const r = await api.installApk(p);
      t.update({ title: `${r.app.label} installed`, body: r.app.shortcutPath ? 'A desktop shortcut was created; double-click it to open.' : 'Right-click the app card to create a desktop shortcut.', progress: 100, type: 'ok' });
      t.el.querySelector('.spinner')?.remove();
      setTimeout(t.dismiss, 3600);
      if (r.warnings && r.warnings.length) {
        toast({ title: `${r.app.label} compatibility notes`, body: r.warnings.join(' '), type: 'error', sticky: false });
      }
      ok++;
    } catch (e) {
      failed++;
      // Dismiss the sticky 'installing…' toast first, otherwise it keeps spinning and
      // keeps being refreshed by the runtime log — 'the error keeps looping'.
      // The install:error listener below shows the error (with file name and reason),
      // so no second toast here.
      try { off(); } catch (_) { /* ignore */ }
      t.dismiss();
      if (installToast === t) installToast = null;
    } finally {
      try { off(); } catch (_) { /* ignore */ }
    }
  }

  state.installing = false;
  await refreshApps();
  if (ok && !failed) $('search').value = '';
}

/* ---------------- app actions ---------------- */

async function launchApp(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  state.launchPkg = pkg;
  const t = toast({
    title: `Opening ${app ? app.label : pkg}`,
    body: 'The first start warms the runtime up, please wait…',
    sticky: true,
    spinner: true,
  });
  const r = await api.launch(pkg);
  if (r.ok) {
    // The app has its own window and the main UI folds away; one hint, then hide
    t.update({ title: 'Started', body: 'The app runs in its own window (rotate from the titlebar).', type: 'ok' });
    setTimeout(t.dismiss, 1600);
    setTimeout(() => api.winHide(), 900);
    setTimeout(refreshApps, 1200);
  } else {
    t.update({ title: 'Launch failed', body: r.error, type: 'error' });
    setTimeout(t.dismiss, 6000);
  }
}

async function createShortcut(pkg) {
  try {
    const r = await api.createShortcut(pkg);
    toast({ title: 'Desktop shortcut created', body: r.path, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: 'Could not create the shortcut', body: e.message, type: 'error' });
  }
}

async function uninstall(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  if (!app) return;
  const ok = window.confirm(`Uninstall ${app.label}?\n\nApp data and the desktop shortcut will be removed.`);
  if (!ok) return;
  try {
    await api.uninstall(pkg);
    toast({ title: 'Uninstalled', body: app.label, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: 'Uninstall failed', body: e.message, type: 'error' });
  }
}

/* ---------------- context menu ---------------- */

const MENU_ITEMS = [
  { key: 'open', label: 'Open app', kbd: 'Enter' },
  { key: 'shortcut', label: 'Create desktop shortcut' },
  { key: 'pin', label: 'Pin to top' },
  { divider: true },
  { key: 'reveal', label: 'Show the APK in the file manager' },
  { key: 'clear', label: 'Clear app data' },
  { divider: true },
  { key: 'uninstall', label: 'Uninstall', danger: true },
];

function showMenu(x, y, pkg) {
  const menu = $('ctxmenu');
  state.menuPkg = pkg;
  const app = state.apps.find((a) => a.package === pkg);
  menu.innerHTML = MENU_ITEMS.map((it) => {
    if (it.divider) return '<div class="divider"></div>';
    const label = it.key === 'pin' ? (app && app.pinned ? 'Unpin' : 'Pin to top') : it.label;
    return `<div class="item ${it.danger ? 'danger' : ''}" data-act="${it.key}">
      <span>${esc(label)}</span>${it.kbd ? `<span class="k">${it.kbd}</span>` : ''}
    </div>`;
  }).join('');
  menu.classList.add('on');

  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 10)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 10)}px`;
}

function hideMenu() {
  $('ctxmenu').classList.remove('on');
  state.menuPkg = null;
}

async function handleMenu(act) {
  const pkg = state.menuPkg;
  const app = state.apps.find((a) => a.package === pkg);
  hideMenu();
  if (!app) return;
  switch (act) {
    case 'open': return launchApp(pkg);
    case 'shortcut': return createShortcut(pkg);
    case 'pin': return api.pin(pkg, !app.pinned).then(refreshApps);
    case 'reveal': return api.revealApk(pkg);
    case 'clear': {
      if (!window.confirm(`Clear all data of ${app.label}? This cannot be undone.`)) return;
      try {
        await api.clearData(pkg);
        toast({ title: 'Data cleared', body: app.label, type: 'ok' });
      } catch (e) {
        toast({ title: 'Clear failed', body: e.message, type: 'error' });
      }
      return;
    }
    case 'uninstall': return uninstall(pkg);
    default: return undefined;
  }
}

/* ---------------- settings ---------------- */

// ---------------- Android system settings ----------------

let volumeTimer = null;

async function refreshAndroid() {
  const el = $('androidStatus');
  if (!el) return;
  el.textContent = 'Reading…';
  const r = await api.android.status().catch(() => null);
  if (!r || !r.ok) {
    el.textContent = r && r.error ? `Runtime not ready (${String(r.error).slice(0, 36)})` : 'Runtime not started';
    return;
  }
  el.textContent = `Android ${r.sdk || '?'} · Wi-Fi ${r.wifi ? 'on' : 'off'}` +
    `${r.airplane ? ' · airplane mode' : ''} · volume ${r.volume}%`;
  $('setAndroidWifi').checked = !!r.wifi;
  $('setAndroidAirplane').checked = !!r.airplane;
  $('setAndroidAnim').checked = !r.animationsOff;
  $('setAndroidVolume').value = r.volume;
  $('androidVolumeText').textContent = `${r.volume}%`;
  if (r.fontScale) $('setAndroidFont').value = Number(r.fontScale).toFixed(2);
  if (r.density) {
    const opt = [...$('setAndroidDensity').options].find((o) => o.value === String(r.density));
    if (opt) $('setAndroidDensity').value = String(r.density);
  }
}

function bindAndroid() {
  const set = async (key, value, msg) => {
    const r = await api.android.set(key, value).catch(() => null);
    toast({
      type: r && r.ok ? 'ok' : 'error',
      title: r && r.ok ? (msg || 'Applied') : `Failed: ${(r && r.error) || 'runtime not ready'}`, 
    });
    if (r && r.ok) refreshAndroid();
  };
  $('setAndroidWifi').addEventListener('change', (e) => set('wifi', e.target.checked, e.target.checked ? 'Wi-Fi on' : 'Wi-Fi off'));
  $('setAndroidAirplane').addEventListener('change', (e) => set('airplane', e.target.checked, e.target.checked ? 'Airplane mode on' : 'Airplane mode off'));
  $('setAndroidAnim').addEventListener('change', (e) => set('animations', e.target.checked, e.target.checked ? 'Animations on' : 'Animations off, faster UI'));
  $('setAndroidFont').addEventListener('change', (e) => set('fontScale', Number(e.target.value), 'Font size changed'));
  $('setAndroidDensity').addEventListener('change', (e) => set('density', Number(e.target.value), 'Display size changed'));
  $('setAndroidVolume').addEventListener('input', (e) => {
    $('androidVolumeText').textContent = `${e.target.value}%`;
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => set('volume', Number(e.target.value), 'Volume changed'), 260);
  });
  $('btnAndroidRefresh').addEventListener('click', () => refreshAndroid());
  $('btnAndroidTune').addEventListener('click', async () => {
    const r = await api.android.tune(state.launchPkg || '').catch(() => null);
    toast({ type: r && r.ok ? 'ok' : 'error', title: r && r.ok ? 'Tuned: animations off, background relaxed, battery whitelist' : 'Tune-up failed, the runtime may be down' });
    if (r && r.ok) refreshAndroid();
  });
  const open = async (action) => {
    const r = await api.android.open(action).catch(() => null);
    if (!r || !r.ok) {
      toast({ type: 'error', title: 'Open an app once so the runtime starts' });
    }
  };
  $('btnAndroidSettings').addEventListener('click', () => open('settings'));
  $('btnAndroidDisplay').addEventListener('click', () => open('display'));
  $('btnAndroidSound').addEventListener('click', () => open('sound'));
  $('btnAndroidLocale').addEventListener('click', () => open('locale'));
  $('btnAndroidApps').addEventListener('click', () => open('apps'));
}

function fillSettings(s) {
  $('setEngineMode').value = s.engine.mode;
  $('setAdbPath').value = s.adbPath || '';
  $('setDevice').value = s.device || '';
  $('setSystemImage').value = s.runtime.isoPath || '';
  $('setMemory').value = s.engine.memoryMB;
  $('setCores').value = s.engine.cores;
  $('setIdle').value = s.engine.idleShutdownMinutes;
  if ($('setSourcePref')) $('setSourcePref').value = (s.runtime && s.runtime.sourcePreference) || 'auto';
  if ($('setAutoMirror')) $('setAutoMirror').checked = (s.runtime && s.runtime.autoMirror) !== false;
  if ($('setGiteeToken')) $('setGiteeToken').value = (s.runtime && s.runtime.giteeToken) || '';
  if ($('setMirrorPrefix')) $('setMirrorPrefix').value = (s.runtime && s.runtime.mirrorPrefix) || '';
  if ($('setConnections')) $('setConnections').value = Number((s.runtime && s.runtime.downloadConnections) || 8);
  $('setAudio').checked = s.engine.audio !== false;
  $('setLiteMode').checked = s.engine.liteMode !== false;
  $('setPrewarm').checked = s.engine.prewarm !== false;
  $('setPriorityMode').value = ['performance', 'game'].includes(s.engine.priorityMode)
    ? s.engine.priorityMode : 'balanced';
  $('setDeepTrim').checked = !!s.engine.deepTrim;
  $('setMouseRightBack').checked = s.engine.mouseRightBack !== false;
  $('setMouseWheelMode').value = ['smooth', 'native', 'off'].includes(s.engine.mouseWheelMode)
    ? s.engine.mouseWheelMode : 'smooth';
  $('setMouseSideButtons').checked = !!s.engine.mouseSideButtons;
  $('setCompat').checked = !!(s.runtime && s.runtime.compatImage);
  $('setAutoShortcut').checked = !!s.createShortcutOnInstall;
  $('setStartMenuShortcut').checked = s.createStartMenuShortcut !== false;
  $('setShortcutDir').value = s.shortcutDir || '';
  $('setSharedDir').value = s.sharedDir || '';
  $('setDeviceSharedDir').value = s.deviceSharedDir || '';
  const d = s.display || {};
  $('setAutoStart').checked = s.autoStart !== false;
  const eng = s.engine || {};
  if ($('setResourceMode')) $('setResourceMode').value = eng.resourceMode || 'balanced';
  if ($('setRenderSize')) $('setRenderSize').value = eng.renderSize || 'auto';
  if ($('setDataGB')) $('setDataGB').value = String(Number(eng.dataPartitionGB || 0));
  if ($('setFastDns')) $('setFastDns').checked = eng.fastDns !== false;
  if ($('setKeepSnapshot')) $('setKeepSnapshot').checked = eng.keepSnapshot !== false;
  $('setDisplayMode').value = d.mode === 'fullscreen' ? 'fullscreen' : 'window';
  $('setPortrait').value = d.portrait || '900x1600';
  $('portraitField').hidden = $('setDisplayMode').value === 'fullscreen';
}

/** Data partition size + free disk, shown under the capacity selector */
async function refreshDataInfo() {
  const el = $('dataNote');
  if (!el) return;
  const info = await api.dataInfo().catch(() => null);
  if (!info) { el.textContent = 'Could not read the data partition'; return; }
  const auto = Number(($('setDataGB') || {}).value || 0) === 0;
  const img = info.imageGB ? `${info.imageGB} GB` : 'not created yet';
  const free = info.freeDiskMB ? `${(info.freeDiskMB / 1024).toFixed(1)} GB` : 'unknown';
  el.textContent = `Data partition image: ${img}${auto ? ' (auto)' : ''} · free on that disk: ${free}.`
    + 'If games report low storage, grow it above and press "Grow now" — in place, apps and saves kept.';
}

async function openSettings() {
  state.settings = await api.getSettings();
  fillSettings(state.settings);
  const info = await api.info();
  $('setRuntimeDir').value = info.runtimeDir || info.dataDir;
  if ($('setAvdDir')) {
    const di = await api.dataInfo().catch(() => null);
    $('setAvdDir').value = (di && di.avdDir) || '';
  }
  const verEl = document.getElementById('aboutVer');
  if (verEl && info.version) verEl.textContent = `v${info.version}`;
  const curVerEl = document.getElementById('updateCurrent');
  if (curVerEl && info.version) curVerEl.textContent = `v${info.version}`;
  const assoc = await api.assocStatus();
  const btn = $('btnAssoc');
  btn.textContent = assoc.registered ? 'Associated · click to remove' : 'Not associated · click to enable';
  btn.dataset.on = assoc.registered ? '1' : '0';

  api.doctorProfile().then((r) => {
    if (r && r.text) $('autoProfileText').textContent = r.text;
  }).catch(() => { $('autoProfileText').textContent = 'Automatic mode'; });
  api.runtimeUsage().then((u) => {
    $('usageText').textContent = u
      ? `Total ${u.totalText}${u.reclaimable ? ` · reclaimable ${u.reclaimableText} (${u.count} item(s))` : ' · already slim'}`
      : 'Usage unavailable';
  }).catch(() => { $('usageText').textContent = 'Usage unavailable'; });

  $('settingsMask').classList.add('on');
  refreshAndroid();
  refreshDataInfo();
}

function closeSettings() {
  $('settingsMask').classList.remove('on');
}

/* ---------------- software update ---------------- */

let lastUpdate = null;

/** Render a check result in the settings panel (also used by the silent start-up check) */
function renderUpdate(info) {
  lastUpdate = info || null;
  const cur = $('updateCurrent');
  const st = $('updateState');
  const btn = $('btnDoUpdate');
  const bar = $('updateBar');
  if (!cur || !st || !btn) return;
  if (!info) return;
  if (info.current) cur.textContent = `v${info.current}`;

  if (info.ok === false) {
    st.textContent = `Check failed: ${info.error || 'network unavailable'}`;
    // A failed check still needs a way out: open the releases page so the user can download.
    // It used to show nothing, which reads as 'updates are broken'.
    showUpdateBtn(true);
    btn.textContent = 'Open the download page';
    btn.dataset.mode = 'manual';
    lastUpdate = { htmlUrl: info.htmlUrl || '' };
    if (bar) bar.hidden = true;
    return;
  }
  if (info.hasUpdate) {
    // Say which source produced this version and why the other did not take part —
    // more useful than any log when diagnosing slow update checks.
    const src = (info.sources || []).map((x) => `${x.name} ${x.tag || ''}`.trim()).join(' / ');
    const bad = (info.unreachable || []).map((x) => x.name).join('、');
    const stale = info.stale ? ' (offline cache, may be outdated)' : '';
    st.textContent = `New version ${info.tag}${src ? ` (${src})` : ''}${bad ? `; ${bad} unreachable` : ''}${stale}`;
    showUpdateBtn(true);
    btn.textContent = info.asset ? 'Update now' : 'Open the download page';
    btn.dataset.mode = info.asset ? 'auto' : 'manual';
    const note = $('updateNote');
    if (note && info.notes) {
      const brief = String(info.notes).split('\n').slice(0, 8).join('\n').trim();
      if (brief) note.textContent = `What's new:\n${brief}`;
    }
    if (bar) bar.hidden = true;
  } else {
    const src = (info.sources || []).map((x) => x.name).join(' / ');
    const stale = info.stale ? ' (offline cache)' : '';
    st.textContent = `Up to date (v${info.current})${src ? ` · via ${src}` : ''}${stale}`;
    showUpdateBtn(false);
    if (bar) bar.hidden = true;
  }
}

/** .btn has display:inline-flex which overrides hidden, so display is set directly */
function showUpdateBtn(on) {
  const btn = $('btnDoUpdate');
  if (!btn) return;
  btn.hidden = !on;
  btn.style.display = on ? '' : 'none';
}

function renderUpdateProgress(p) {
  if (!p) return;
  const st = $('updateState');
  const bar = $('updateBar');
  const fill = $('updateBarFill');
  if (p.stage === 'error') {
    if (st) st.textContent = `Update failed: ${p.message || ''}`;
    if (bar) bar.hidden = true;
    toast({ title: 'Update failed', body: p.message || '', type: 'error' });
    return;
  }
  if (st) st.textContent = p.message || 'Updating…';
  if (bar && fill) {
    bar.hidden = false;
    fill.style.width = `${Math.max(0, Math.min(100, p.percent || 0))}%`;
  }
}

function bindUpdate() {
  const check = $('btnCheckUpdate');
  const go = $('btnDoUpdate');
  if (!check || !go) return;

  const runCheck = async (silent) => {
    if (!silent) {
      check.disabled = true;
      const old = check.textContent;
      check.textContent = 'Checking…';
      $('updateState').textContent = 'Contacting GitHub…';
      try {
        const info = await api.updateCheck();
        renderUpdate(info);
        if (info && info.hasUpdate) toast({ title: `New version ${info.tag}`, body: 'Press "Update now" to download and install', type: 'info' });
        else if (info && info.ok !== false) toast({ title: 'Up to date', body: `v${info.current}`, type: 'ok' });
      } catch (e) {
        $('updateState').textContent = `Check failed: ${e.message}`;
      } finally {
        check.disabled = false;
        check.textContent = old;
      }
      return;
    }
    const info = await api.updateCheck().catch(() => null);
    if (info) renderUpdate(info);
  };

  check.addEventListener('click', () => runCheck(false));

  go.addEventListener('click', async () => {
    if (go.dataset.mode === 'manual') {
      api.updateOpenRelease(lastUpdate && lastUpdate.htmlUrl);
      return;
    }
    go.disabled = true;
    go.textContent = 'Updating…';
    const r = await api.updateApply().catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) {
      go.disabled = false;
      go.textContent = 'Update now';
      if (r && r.error && !r.manual) {
        $('updateState').textContent = `Update failed: ${r.error}`;
        toast({ title: 'Update failed', body: r.error, type: 'error' });
      }
    } else {
      $('updateState').textContent = `Downloaded v${r.version}, restarting to finish…`;
    }
  });

  // On opening Settings, check once if there is no result yet (in the background)
  runCheck(true).catch(() => {});
}

function bindSettings() {
  const save = async (patch) => {
    state.settings = await api.setSettings(patch);
  };

  $('setEngineMode').addEventListener('change', (e) => save({ engine: { mode: e.target.value } }));
  $('setAdbPath').addEventListener('change', (e) => save({ adbPath: e.target.value.trim() }));
  $('setDevice').addEventListener('change', async (e) => {
    await save({ device: e.target.value.trim() });
    refreshStatus();
  });
  $('setSystemImage').addEventListener('change', (e) => save({ runtime: { isoPath: e.target.value.trim() } }));
  // Memory / cores: a concrete value turns auto off, 0 turns it back on.
  // The old code wrote memoryMB only, and overridesFromSettings honours it only when
  // autoMemory=false, so a manual memory value was ignored — the 'does nothing' setting.
  $('setMemory').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { memoryMB: v, autoMemory: false } } : { engine: { memoryMB: 0, autoMemory: true } });
  });
  $('setCores').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { cores: v, autoMemory: false } } : { engine: { cores: 0, autoMemory: true } });
  });
  if ($('setResourceMode')) {
    $('setResourceMode').addEventListener('change', async (e) => {
      // The policy also sets liteMode / priorityMode / renderSize (translated in the main process)
      state.settings = await api.setSettings({ engine: { resourceMode: e.target.value } });
      fillSettings(state.settings);
      toast({ title: 'Resource policy changed', body: 'Applies on the next launch', type: 'ok' });
    });
  }
  if ($('setRenderSize')) {
    $('setRenderSize').addEventListener('change', (e) => save({ engine: { renderSize: e.target.value } }));
  }
  if ($('setFastDns')) {
    $('setFastDns').addEventListener('change', (e) => save({ engine: { fastDns: e.target.checked } }));
  }
  if ($('setKeepSnapshot')) {
    $('setKeepSnapshot').addEventListener('change', (e) => save({ engine: { keepSnapshot: e.target.checked } }));
  }
  if ($('setDataGB')) {
    $('setDataGB').addEventListener('change', (e) => {
      save({ engine: { dataPartitionGB: Number(e.target.value) || 0 } });
      refreshDataInfo();
    });
  }
  if ($('btnGrowData')) {
    $('btnGrowData').addEventListener('click', async () => {
      const gb = Number($('setDataGB').value) || 0;
      if (!gb) { toast({ title: 'Pick a size first', body: '"Auto" lets the app decide from free disk; nothing to grow', type: 'info' }); return; }
      const { response } = await api.confirm({
        title: 'Grow the Android data partition now?',
        message: `/data will become ${gb} GB (grown in place, apps and saves kept).`,
        detail: 'Running apps stop first; the next launch re-boots and takes a few extra seconds.',
        okLabel: 'Start growing',
      });
      if (response !== 1) return;
      $('btnGrowData').disabled = true;
      const old = $('btnGrowData').textContent;
      $('btnGrowData').textContent = 'Growing…';
      const r = await api.setDataSize(gb).catch((e) => ({ ok: false, error: e.message }));
      $('btnGrowData').disabled = false;
      $('btnGrowData').textContent = old;
      toast({
        type: r && r.ok ? 'ok' : 'error',
        title: r && r.ok ? 'Data partition grown' : 'Growing failed',
        body: r && r.ok ? `about ${r.imageGB || gb} GB available now` : (r && r.error) || 'Unknown error',
      });
      refreshDataInfo();
    });
  }
  $('setIdle').addEventListener('change', (e) => save({ engine: { idleShutdownMinutes: Number(e.target.value) || 0 } }));
  if ($('setSourcePref')) {
    $('setSourcePref').addEventListener('change', (e) => save({ runtime: { sourcePreference: e.target.value } }));
  }
  if ($('setAutoMirror')) {
    $('setAutoMirror').addEventListener('change', (e) => save({ runtime: { autoMirror: e.target.checked } }));
  }
  if ($('setGiteeToken')) {
    $('setGiteeToken').addEventListener('change', (e) => save({ runtime: { giteeToken: e.target.value.trim() } }));
  }
  if ($('setMirrorPrefix')) {
    $('setMirrorPrefix').addEventListener('change', (e) => save({ runtime: { mirrorPrefix: e.target.value.trim() } }));
  }
  if ($('setConnections')) {
    $('setConnections').addEventListener('change', (e) => {
      const n = Math.max(1, Math.min(16, Number(e.target.value) || 8));
      e.target.value = n;
      save({ runtime: { downloadConnections: n } });
    });
  }
  $('setAudio').addEventListener('change', (e) => save({ engine: { audio: e.target.checked } }));
  $('setLiteMode').addEventListener('change', (e) => save({ engine: { liteMode: e.target.checked } }));
  $('setPrewarm').addEventListener('change', (e) => save({ engine: { prewarm: e.target.checked } }));
  $('setPriorityMode').addEventListener('change', (e) => save({ engine: { priorityMode: e.target.value } }));
  const savePointer = async (patch) => {
    await save({ engine: patch });
    // Reinstall or remove the hook for the current focus right away
    api.refreshPointerMapping().catch(() => {});
  };
  $('setMouseRightBack').addEventListener('change', (e) => savePointer({ mouseRightBack: e.target.checked }));
  $('setMouseWheelMode').addEventListener('change', (e) => savePointer({ mouseWheelMode: e.target.value }));
  $('setMouseSideButtons').addEventListener('change', (e) => savePointer({ mouseSideButtons: e.target.checked }));
  $('setDeepTrim').addEventListener('change', async (e) => {
    await save({ engine: { deepTrim: e.target.checked } });
    // Turning deep trim off must re-enable packages disabled with pm disable-user
    if (!e.target.checked) {
      api.restoreSystemApps().catch(() => {});
      toast({ title: 'System components restored', body: 'Deep trim off, background packages coming back', type: 'info' });
    }
  });
  $('setCompat').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await save({ runtime: { compatImage: on } });
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (on && !ok) toast({ title: 'ARM compatibility enabled', body: 'The Google Play image (Android 14, ~1.5 GB) still needs downloading — use the button below', type: 'info' });
    else if (on) toast({ title: 'ARM compatibility enabled', body: 'Applies after a runtime restart', type: 'info' });
  });
  $('setAutoShortcut').addEventListener('change', (e) => save({ createShortcutOnInstall: e.target.checked }));
  $('setStartMenuShortcut').addEventListener('change', (e) => save({ createStartMenuShortcut: e.target.checked }));
  $('setShortcutDir').addEventListener('change', (e) => save({ shortcutDir: e.target.value.trim() }));
  $('setDeviceSharedDir').addEventListener('change', (e) => save({ deviceSharedDir: e.target.value.trim() }));
  $('setAutoStart').addEventListener('change', (e) => save({ autoStart: e.target.checked }));
  $('setDisplayMode').addEventListener('change', async (e) => {
    const mode = e.target.value;
    $('portraitField').hidden = mode === 'fullscreen';
    state.settings = await api.setSettings({ display: { mode } });
    toast({ title: mode === 'fullscreen' ? 'Fullscreen on' : 'Portrait window', type: 'ok' });
  });
  $('setPortrait').addEventListener('change', async (e) => {
    state.settings = await api.setSettings({ display: { portrait: e.target.value } });
    toast({ title: 'Picture size updated', body: 'Applies on the next launch or switch', type: 'ok' });
  });
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const r = await api.rebuildShortcuts();
    toast({
      title: r && r.fixed && r.fixed.length ? 'Shortcuts restored' : 'Shortcuts are all present',
      body: r && r.fixed && r.fixed.length ? r.fixed.join(', ') : 'Desktop and menu entries are fine',
      type: 'ok',
    });
  });

  $('btnDiagnostics').addEventListener('click', async () => {
    try {
      const r = await api.doctorReport();
      toast({ title: 'Diagnostic report exported', body: `${r.diagnosis.title} · ${r.file}`, type: 'ok', sticky: true });
    } catch (e) {
      toast({ title: 'Export failed', body: e.message, type: 'error' });
    }
  });

  $('btnCleanup').addEventListener('click', async () => {
    const btn = $('btnCleanup');
    const includeSnapshots = $('chkCleanSnapshots') && $('chkCleanSnapshots').checked;
    btn.disabled = true;
    try {
      const preview = await api.runtimeCleanup({ apply: false, includeSnapshots });
      if (!preview.candidates.length) {
        toast({ title: 'Already slim', body: 'No old images or snapshots to reclaim.', type: 'ok' });
        return;
      }
      const r = await api.runtimeCleanup({ apply: true, includeSnapshots });
      if (r.cancelled) return;
      toast({
        title: 'Cleanup finished',
        body: `Freed about ${(r.saved / 1048576).toFixed(0)} MB (${r.removed.length} item(s)); installed apps kept.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Total ${u.totalText} · reclaimable ${u.reclaimableText} (${u.count} item(s))`;
    } catch (e) {
      toast({ title: 'Cleanup failed', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Reset Android data: two confirmations (intent, then irreversibility), then refresh usage
  $('btnResetData').addEventListener('click', async () => {
    const btn = $('btnResetData');
    btn.disabled = true;
    try {
      const first = await api.confirm({
        type: 'warning',
        title: 'Reset Android data?',
        message: 'This restores Android to a freshly installed state:',
        detail: '• deletes every installed third-party app, its data and logins\n'
          + '• deletes the current AVD quickboot snapshot\n'
          + '• the system image is untouched; the next open cold-boots and recreates data\n\n'
          + 'This cannot be undone. Continue?',
        buttons: ['Cancel', 'Continue'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!first || first.response !== 1) return;
      const second = await api.confirm({
        type: 'warning',
        title: 'Confirm once more',
        message: 'Installed apps and their data will be deleted permanently. Reset?',
        detail: 'The system image, other AVDs, the APK cache and icons are not touched.',
        buttons: ['Cancel', 'Reset'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!second || second.response !== 1) return;
      const r = await api.runtimeResetData();
      if (!r || !r.ok) {
        toast({ title: 'Reset failed', body: (r && r.error) || 'Try again', type: 'error' });
        return;
      }
      toast({
        title: 'Android data reset',
        body: `Freed about ${r.reclaimedMB} MB; the app list is cleared.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Total ${u.totalText} · reclaimable ${u.reclaimableText} (${u.count} item(s))`;
    } catch (e) {
      toast({ title: 'Reset failed', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Repair network: for online pages that stay black in Android.
  // The cause is a broken Wi-Fi config in the VM /data: wlan0 down, no default route.
  // The Play image forbids root, so /data is reset wholesale; the app list stays and reinstalls on open.
  $('btnRepairNetwork').addEventListener('click', async () => {
    const btn = $('btnRepairNetwork');
    btn.disabled = true;
    try {
      const ok = await api.confirm({
        type: 'warning',
        title: 'Repair the VM network?',
        message: 'Online pages that stay black or spin usually mean the VM has no network.',
        detail: 'Repair tries from cheapest to costliest:\n\n'
          + '1. cold boot the VM (no snapshot) and wait for the network — no data touched\n'
          + '2. only then reset Android data — the app list stays and apps reinstall on open,\n'
          + '   but logins and in-app history are lost\n\n'
          + 'Only the current AVD is affected; the image and APK cache stay. Takes 1-5 minutes. Continue?',
        buttons: ['Cancel', 'Start repair'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const r = await api.runtimeRepairNetwork();
      if (!r || !r.ok) {
        toast({
          title: 'Network still down',
          body: (r && r.error) || 'The VM still has no network; check the host network and firewall.',
          type: 'error',
        });
        return;
      }
      toast({
        title: 'Network restored',
        body: `${(r.network && r.network.ip) || 'online'}${r.wiped ? ' (data was reset; apps reinstall on open)' : ' (your data was untouched)'}`,
        type: 'ok',
      });
    } catch (e) {
      toast({ title: 'Repair failed', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Clean leftovers: scan old program dirs, dead uninstall entries and update temp files.
  $('btnLeftovers').addEventListener('click', async () => {
    const btn = $('btnLeftovers');
    btn.disabled = true;
    try {
      const r = await api.leftoversScan();
      if (!r || !r.ok) {
        toast({ title: 'Scan failed', body: (r && r.error) || 'Try again', type: 'error' });
        return;
      }
      const items = r.items || [];
      if (!items.length) {
        toast({ title: 'All clean', body: 'No leftovers from older versions.', type: 'ok' });
        return;
      }
      const mb = Math.round((r.totalBytes || 0) / 1048576);
      const lines = items.slice(0, 8).map((x) => `• ${x.note}：${x.path}`);
      if (items.length > 8) lines.push(`…and ${items.length - 8} more`);
      const ok = await api.confirm({
        type: 'warning',
        title: 'Clean up old versions?',
        message: `Found ${items.length} leftover item(s), about ${mb} MB:`,
        detail: `${lines.join('\n')}\n\nOnly old program directories, dead uninstall entries and update temp files are removed;`
          + ' the running version and your app data stay.',
        buttons: ['Cancel', 'Start cleanup'],
        defaultId: 1,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const c = await api.leftoversClean(items);
      if (!c || !c.ok) {
        toast({ title: 'Cleanup failed', body: (c && c.error) || 'Try again', type: 'error' });
        return;
      }
      const failNote = (c.failed && c.failed.length) ? `, ${c.failed.length} in use not removed` : '';
      toast({
        title: 'Old versions cleaned',
        body: `Removed ${c.removed.length} item(s), freed ${c.freedMB || 0} MB${failNote}.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Total ${u.totalText} · reclaimable ${u.reclaimableText} (${u.count} item(s))`;
    } catch (e) {
      toast({ title: 'Cleanup failed', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  $('btnOpenShared').addEventListener('click', () => api.openSharedDir());

  // Rebuild shortcuts: fallback when icons were deleted or blocked
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const btn = $('btnRebuildShortcuts');
    btn.disabled = true;
    try {
      const r = await api.rebuildShortcuts().catch(() => ({ ok: false }));
      const fixed = (r && r.fixed) || [];
      toast(fixed.length
        ? { title: 'Shortcuts rebuilt', body: fixed.join(', '), type: 'ok' }
        : { title: 'Shortcuts are all present', body: 'Nothing to rebuild', type: 'info' });
    } finally {
      btn.disabled = false;
    }
  });

  // Shared directory: browse for a directory, then 'Save and migrate' moves the files
  $('btnBrowseShared').addEventListener('click', async () => {
    const picked = await api.openDir();
    if (!picked) return;
    $('setSharedDir').value = picked;
    toast({ title: 'New directory selected', body: 'Press "Save and migrate" to move the files', type: 'info' });
  });
  $('btnSaveShared').addEventListener('click', async () => {
    const dir = $('setSharedDir').value.trim();
    if (!dir) { toast({ title: 'Enter or browse for a directory first', type: 'error' }); return; }
    const btn = $('btnSaveShared');
    btn.disabled = true;
    const r = await api.setSharedDir(dir).catch(() => ({ ok: false }));
    btn.disabled = false;
    if (r.ok) {
      const moved = r.oldDir && r.oldDir !== r.newDir;
      toast({ title: 'Shared directory updated', body: moved ? 'Existing files moved to the new directory' : 'Saved', type: 'ok' });
    } else {
      toast({ title: 'Save failed', body: r.error, type: 'error' });
    }
  });

  // Uninstall ApkStart itself (drop the .apk association, remove the program)
  $('btnUninstall').addEventListener('click', async () => {
    const ok = window.confirm('Uninstall ApkStart?\n\nThe .apk association is removed and the program deleted. This cannot be undone.');
    if (!ok) return;
    const btn = $('btnUninstall');
    btn.disabled = true;
    const r = await api.removeSelf().catch(() => ({ ok: false }));
    if (r.ok && r.portable) {
      btn.disabled = false;
      toast({
        title: 'Portable build cannot self-uninstall',
        body: `Delete the program directory (${r.exeDir}) and the data directory (${r.dataDir}) manually`,
        type: 'info', sticky: true,
      });
      return;
    }
    if (!r.ok) {
      btn.disabled = false;
      toast({ title: 'Uninstall failed', body: r.error, type: 'error' });
      return;
    }
    toast({ title: 'Uninstalling…', body: 'The uninstaller started; ApkStart is about to exit', type: 'ok', sticky: true });
  });

  // ARM compatible image download (with a progress toast)
  $('btnInstallPlay').addEventListener('click', async () => {
    const btn = $('btnInstallPlay');
    btn.disabled = true;
    const t = toast({ title: 'Downloading the ARM compatible image', body: 'Preparing…', sticky: true, spinner: true, progress: 3 });
    const un = api.on('provision:progress', (p) => {
      if (p.component !== 'playimg') return;
      t.update({ title: 'Downloading the ARM compatible image', body: p.message || '', progress: p.percent });
    });
    try {
      const r = await api.installPlayImage();
      if (r && r.ok) {
        t.update({ title: 'ARM compatible image ready', body: 'Applies after a runtime restart', progress: 100 });
        setTimeout(() => t.dismiss(), 3000);
        $('compatInstallField').hidden = true;
        refreshStatus();
      } else {
        t.update({ title: 'Compatible image download failed', body: (r && r.error) || 'Unknown error', progress: null });
        t.dismiss();
        toast({ title: 'Compatible image download failed', body: (r && r.error) || 'Unknown error', type: 'error' });
      }
    } catch (e) {
      t.dismiss();
      toast({ title: 'Compatible image download failed', body: e.message, type: 'error' });
    } finally {
      un();
      btn.disabled = false;
    }
  });

  // Compatible image status
  (async () => {
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const s = state.settings;
    const on = !!(s && s.runtime && s.runtime.compatImage);
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (env.playImage) {
      $('compatImgStatus').textContent = ok
        ? `Ready (${(env.playImage.size / 1073741824).toFixed(2)} GB)` : 'Not downloaded';
    }
  })();
  $('btnOpenData').addEventListener('click', async () => {
    const info = await api.info();
    const dir = info.runtimeDir || info.dataDir;
    window.open(`file:///${dir.replace(/\\/g, '/')}`);
  });
  $('btnBrowseRuntimeDir').addEventListener('click', async () => {
    const info = await api.info();
    const picked = await api.openDir();
    if (!picked) return;
    await api.setSettings({ runtime: { dir: picked } });
    $('setRuntimeDir').value = picked;
    toast({ title: 'Data directory updated', body: 'Restart ApkStart to apply (old data is not moved automatically)', type: 'ok', sticky: true });
  });

  // Android data directory (AVD + snapshot): the real disk hog, point it elsewhere
  if ($('btnBrowseAvdDir')) {
    $('btnBrowseAvdDir').addEventListener('click', async () => {
      const picked = await api.openDir();
      if (!picked) return;
      await api.setSettings({ runtime: { avdDir: picked } });
      $('setAvdDir').value = picked;
      toast({
        title: 'Android data directory updated',
        body: 'Restart ApkStart to apply. The old apkstart.avd can be moved to the new directory and deleted.',
        type: 'ok',
        sticky: true,
      });
    });
  }
  if ($('btnOpenAvdDir')) {
    $('btnOpenAvdDir').addEventListener('click', async () => {
      const info = await api.dataInfo().catch(() => null);
      const dir = (info && info.avdDir) || (await api.info()).dataDir;
      window.open(`file:///${String(dir).replace(/\\/g, '/')}`);
    });
  }

  $('btnProbe').addEventListener('click', async () => {
    const el = $('probeResult');
    el.textContent = 'Probing…';
    const found = await api.runtimeProbe();
    if (!found.length) {
      el.textContent = 'No running runtime found';
      return;
    }
    el.textContent = `Found: ${found.map((f) => f.name).join(', ')}`;
    await api.setSettings({ device: found[0].serial });
    $('setDevice').value = found[0].serial;
    refreshStatus();
  });

  $('btnRuntimeStart').addEventListener('click', async () => {
    const el = $('probeResult');
    el.textContent = 'Starting…';
    const r = await api.runtimeStart();
    el.textContent = r.ok ? `Ready: ${r.engine}` : `Start failed: ${r.error}`;
    refreshStatus();
  });

  $('btnRuntimeStop').addEventListener('click', async () => {
    await api.runtimeStop();
    $('probeResult').textContent = 'Bundled VM stopped';
    refreshStatus();
  });

  $('btnAssoc').addEventListener('click', async () => {
    const btn = $('btnAssoc');
    if (btn.dataset.on === '1') {
      await api.assocUnregister();
      btn.textContent = 'Not associated · click to enable';
      btn.dataset.on = '0';
      toast({ title: '.apk association removed' });
    } else {
      const r = await api.assocRegister();
      btn.textContent = 'Associated · click to remove';
      btn.dataset.on = '1';
      toast({ title: '.apk association enabled', body: r.ok ? 'Double-clicking an APK now installs it into ApkStart' : '', type: r.ok ? 'ok' : 'error' });
    }
  });
}

/* ---------------- event wiring ---------------- */

function bindEvents() {
  // Links open in the system browser
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="http"]');
    if (!a) return;
    e.preventDefault();
    api.openExternal(a.getAttribute('href'));
  });

  $('btnSettings').addEventListener('click', openSettings);
  // The status tag is also an entry point to the Settings runtime panel
  $('engineTag').addEventListener('click', () => showSetup(true));
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('btnDoneSettings').addEventListener('click', closeSettings);
  $('settingsMask').addEventListener('click', (e) => {
    if (e.target === $('settingsMask')) closeSettings();
  });

  // Runtime deployment lives in Settings; this only wires the panel buttons
  $('btnDeployAll').addEventListener('click', deployAll);
  $('btnMarkInstalled').addEventListener('click', markInstalled);
  $('btnGuideClose').addEventListener('click', () => { $('setupGuide').hidden = true; });
  $('btnSetupAdvanced').addEventListener('click', () => {
    const adv = document.querySelector('.advanced-group');
    if (adv) {
      adv.open = true;
      adv.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });

  // The self-check counter opens the Settings runtime panel
  $('envChip').addEventListener('click', () => {
    openSettings().then(() => {
      const box = $('envCheck');
      if (box && !box.hidden) box.scrollIntoView({ block: 'center', behavior: 'smooth' });
      else $('runtimeGroup').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }).catch(() => {});
  });

  $('setupSteps').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'emulator' || act === 'sysimg' || act === 'accel'
      || act === 'adb' || act === 'qemu' || act === 'iso' || act === 'disk') {
      const r = await runStep(act);
      if (!r.ok) toast({ title: 'Operation failed', body: r.error, type: 'error', sticky: true });
      return;
    }
    if (act === 'isoImport') {
      const r = await api.importIso();
      if (r.ok) { toast({ title: 'System image imported', body: r.path, type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: 'Import failed', body: r.error, type: 'error' });
      return;
    }
    if (act === 'diskImport') {
      const r = await api.importDisk();
      if (r.ok) { toast({ title: 'Virtual disk imported', body: 'The runtime can start now', type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: 'Import failed', body: r.error, type: 'error' });
      return;
    }
    if (act === 'install') { await startInstall(); return; }
    if (act === 'vmStart') {
      const t = toast({ title: 'Starting the runtime…', body: 'The first start boots Android', sticky: true, spinner: true });
      const r = await api.runtimeStart();
      if (r.ok) { t.update({ title: 'Runtime ready', type: 'ok' }); setTimeout(t.dismiss, 2200); }
      else t.update({ title: 'Start failed', body: r.error, type: 'error' });
      refreshStatus();
      return;
    }
    if (act === 'vmStop') {
      await api.runtimeStop();
      toast({ title: 'Runtime session ended' });
      refreshStatus();
    }
  });

  const pick = async () => {
    const files = await api.pickApk();
    if (files.length) installFiles(files);
  };
  $('btnInstall').addEventListener('click', pick);
  $('btnInstall2').addEventListener('click', pick);
  // The shared-directory entry lives in Settings: sync and open are in 'Shared files'
  const btnSync = $('btnSyncShared');
  if (btnSync) btnSync.addEventListener('click', async () => {
    btnSync.disabled = true;
    try {
      await api.syncShared();
      toast({ title: 'Shared directory synced', type: 'ok' });
    } catch (_) {
      toast({ title: 'Sync failed', body: 'Sync is skipped while the runtime is not ready', type: 'error' });
    } finally {
      btnSync.disabled = false;
    }
  });

  $('search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderGrid();
  });

  $('grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) launchApp(card.dataset.pkg);
  });

  $('grid').addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, card.dataset.pkg);
  });

  $('grid').addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card');
    if (card) createShortcut(card.dataset.pkg);
  });

  $('ctxmenu').addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (item) handleMenu(item.dataset.act);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxmenu')) hideMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMenu();
      closeSettings();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search').focus();
    }
  });

  // drag-and-drop install
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('dropzone').classList.add('on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('dropzone').classList.remove('on');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').classList.remove('on');
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files
      .map((f) => { try { return api.pathForFile(f); } catch (_) { return null; } })
      .filter((p) => p && /\.apk$/i.test(p));
    if (paths.length) installFiles(paths);
    else toast({ title: 'Only .apk files can be dropped here', type: 'error' });
  });

  // main-process events
  api.on('install:error', (p) => {
    // On error stop the spinning 'installing…' toast (it may come from another path)
    if (installToast) { try { installToast.dismiss(); } catch (_) { /* ignore */ } installToast = null; }
    const name = p && p.file ? String(p.file).split(/[\\/]/).pop() : '';
    toast({
      title: name ? `Install failed: ${name}` : 'Install failed',
      body: friendlyInstallErrorText((p && p.message) || 'Unknown error'),
      type: 'error',
    });
  });
  api.on('toast', (p) => toast({ title: p.message, type: p.type === 'error' ? 'error' : 'info' }));
  api.on('app:launched', () => setTimeout(refreshApps, 800));
  api.on('runtime:log', (m) => console.log('[runtime]', m));
  api.on('ui:navigate', (v) => {
    if (v === 'settings') openSettings();
    if (v === 'setup') { showSetup(true); refreshStatus(); }
  });
  api.on('provision:progress', (p) => updateStepProgress(p.component, p));
  api.on('update:state', (info) => {
    if (!info) return;
    renderUpdate(info);
    // Update info arrives 8 s after start: add 'new version' to the welcome card if open
    const wm = $('welcomeMask');
    if (wm && !wm.hidden) renderWelcomeTips();
  });
  api.on('update:progress', (p) => renderUpdateProgress(p));
}

/* ---------------- start-up ---------------- */

async function init() {
  bindEvents();
  bindSettings();
  bindUpdate();
  bindAndroid();
  bindWelcome();
  state.settings = await api.getSettings();
  await refreshStatus();
  await refreshApps();
  refreshAndroid();
  selfCheck();
  maybeShowWelcome();
  setInterval(refreshStatus, 6000);
  setInterval(refreshApps, 15000);
  setInterval(selfCheck, 60000);
}

/* ---------------- welcome card ---------------- */

let startupInfo = null;

function greetingOf(h) {
  if (h < 5) return 'Late at night';
  if (h < 11) return 'Good morning';
  if (h < 13) return 'Good midday';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function bindWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  const close = () => { mask.hidden = true; };
  const never = $('welcomeNever');
  $('welcomeOk').addEventListener('click', () => {
    if (never && never.checked) api.setSettings({ welcome: { disabled: true } }).catch(() => {});
    close();
  });
  $('welcomeSettings').addEventListener('click', () => { close(); openSettings(); });
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mask.hidden) close(); });
}

/** Whether to show: always at login, once a day on a manual open, never if disabled */
async function maybeShowWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  // No welcome card during smoke screenshots: it would cover the main screen
  try { if ((await api.startupInfo()).smoke) return; } catch (_) { /* ignore */ }
  try { startupInfo = await api.startupInfo(); } catch (_) { startupInfo = null; }
  const cfg = (state.settings && state.settings.welcome) || {};
  if (cfg.disabled) return;
  const today = new Date().toISOString().slice(0, 10);
  if (!(startupInfo && startupInfo.autostart) && cfg.lastDate === today) return;

  const h = new Date().getHours();
  $('welcomeHi').textContent = `${greetingOf(h)}, welcome back`;
  const ver = (startupInfo && startupInfo.version) || (state.status && state.status.version) || '';
  const ready = state.status && state.status.ready;
  $('welcomeSub').textContent = `ApkStart${ver ? ` v${ver}` : ''} · ${ready ? 'runtime ready' : 'the runtime will set itself up on demand'}`;

  const apps = (state.apps || []).length;
  const dev = $('statusDevice') ? $('statusDevice').textContent.trim() : '';
  const chips = [
    { k: String(apps), v: 'apps installed' },
    { k: ready ? 'ready' : 'standby', v: 'Android runtime' },
    { k: dev ? dev.replace(/^.*?(\d+)/, '$1') : '—', v: 'device / port' },
  ];
  $('welcomeStats').innerHTML = chips
    .map((c) => `<div class="welcome-stat"><b>${esc(c.k)}</b><span>${esc(c.v)}</span></div>`)
    .join('');

  const tips = [];
  $('welcomeTips').innerHTML = '';
  mask.hidden = false;
  renderWelcomeTips();
  api.setSettings({ welcome: { lastDate: today } }).catch(() => {});
}

/** Tips are rendered separately: update info arrives later and the card may still be open */
function renderWelcomeTips() {
  const box = $('welcomeTips');
  if (!box) return;
  const apps = (state.apps || []).length;
  const tips = [];
  if (lastUpdate && lastUpdate.hasUpdate) {
    tips.push(`New version <b>${esc(lastUpdate.tag || '')}</b> — update from Settings → Software update`);
  }
  if (!apps) {
    tips.push('Drop an APK here to install it; a desktop shortcut appears automatically');
  } else {
    tips.push('Double-click a card to run it in its own window; rotate / resize / close from the titlebar');
  }
  tips.push('Closing the window exits only that app; Android stays resident for a faster next open');
  box.innerHTML = tips
    .map((t, i) => `<div class="welcome-tip"><i>${i + 1}</i><span>${t}</span></div>`)
    .join('');
}

/* ---------------- self-check ---------------- */

let envBusy = false;

/** doctor:selfCheck renders issues into the Settings panel and a counter in the status bar */
async function selfCheck() {
  if (envBusy) return;
  envBusy = true;
  try {
    const r = await api.selfCheck().catch(() => null);
    if (r) renderEnvCheck(r);
  } catch (_) { /* a failed self-check does not block anything */ }
  finally { envBusy = false; }
}

function renderEnvCheck(r) {
  const box = $('envCheck');
  if (!box) return;
  // Missing components are covered by the one-click setup, so they are not repeated
  const needDeploy = !!(state.status && state.status.needsSetup);
  const issues = (r.issues || []).filter((i) => !(needDeploy && i.fix === 'deploy'));

  // No banner: the status bar carries a clickable counter that opens the self-check panel
  const chip = $('envChip');
  if (chip) {
    const errs = issues.filter((i) => i.severity === 'error').length;
    chip.hidden = issues.length === 0;
    chip.textContent = errs ? `${errs} to fix` : `${issues.length} hint(s)`;
    chip.className = `status-chip${errs ? ' err' : ''}`;
    chip.title = issues.map((i) => i.title).join('；');
  }

  if (!issues.length) {
    box.hidden = false;
    box.innerHTML = `
      <div class="env-check-ok">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
        <span>Self-check passed; nothing that would break the runtime was found.</span>
        <span style="flex:1"></span>
        <button class="btn ghost sm" id="btnEnvRecheck">Check again</button>
      </div>`;
    const re = $('btnEnvRecheck');
    if (re) re.addEventListener('click', selfCheck);
    return;
  }
  const errs = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.length - errs;
  box.hidden = false;
  box.innerHTML = `
    <div class="env-check-head">
      <span class="ec-title">Self-check</span>
      ${errs ? `<span class="ec-count">${errs} critical</span>` : ''}
      ${warns ? `<span class="ec-count warn">${warns} hint(s)</span>` : ''}
      <span class="ec-spacer"></span>
      <button class="btn ghost sm" id="btnEnvRecheck">Check again</button>
      <button class="btn primary sm" id="btnEnvFixAll">Fix all</button>
    </div>
    <div class="env-check-list">
      ${issues.map((i) => `
        <div class="env-check-item ${i.severity}">
          <span class="ec-sev"></span>
          <div class="ec-body">
            <div class="ec-name">${esc(i.title)}</div>
            <div class="ec-hint">${esc(i.hint || '')}</div>
          </div>
          ${i.fix ? `<button class="ec-fix" data-code="${esc(i.code)}">Fix</button>` : ''}
        </div>`).join('')}
    </div>`;
  const re = $('btnEnvRecheck');
  if (re) re.addEventListener('click', selfCheck);
  const fixAll = $('btnEnvFixAll');
  if (fixAll) fixAll.addEventListener('click', () => fixAllIssues(issues));
  box.querySelectorAll('.ec-fix').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) fixIssue(issue);
    });
  });
}

async function fixIssue(issue) {
  switch (issue.fix) {
    case 'vcRedist': {
      const r = await api.installVcRedist().catch(() => ({ ok: false }));
      if (!r.ok && r.reason === 'no-installer') {
        api.openExternal('https://learn.microsoft.com/zh-CN/cpp/windows/latest-supported-vc-redist?view=msvc-170#visual-studio-2015-2017-2019-and-2022');
        toast({ title: 'Bundled installer not found', body: 'The vendor download page was opened; get the x64 build', type: 'info' });
        break;
      }
      toast(r.ok
        ? { title: 'Runtime libraries are installed', type: 'ok' }
        : { title: 'Installation incomplete', body: r.error || 'Try again', type: 'error' });
      break;
    }
    case 'virtualization': {
      const t = toast({ title: 'Enabling hardware acceleration…', body: 'Confirm the prompt', sticky: true, spinner: true });
      const r = await api.enableVirtualization().catch(() => ({ ok: false }));
      if (r.ok) {
        t.update({ title: 'Hardware acceleration enabled', body: r.restartNeeded ? 'Reboot for the best performance' : (r.note || ''), type: 'ok' });
        setTimeout(t.dismiss, 3200);
      } else {
        t.update({ title: 'Could not enable it', body: r.error || 'Try again', type: 'error', sticky: true });
      }
      break;
    }
    case 'disk': {
      // The main process shows a native dialog with the reclaimable preview; no second confirm
      const r = await api.runtimeCleanup({ apply: true }).catch(() => null);
      if (!r) { toast({ title: 'Cleanup failed', body: 'Try again', type: 'error' }); break; }
      if (r.cancelled) break;
      toast({ title: 'Cleanup finished', body: `Freed about ${((r.saved || 0) / 1048576).toFixed(0)} MB`, type: 'ok' });
      break;
    }
    case 'path': {
      toast({ title: 'Move it to an ASCII-only path', body: 'Change the runtime data directory in Settings → System integration and restart.', type: 'info', sticky: true });
      openSettings();
      break;
    }
    case 'deploy': {
      toast({ title: 'Restoring the missing runtime components…', type: 'info', sticky: true, spinner: true });
      await deployAll();
      break;
    }
    case 'lock': {
      const r = await api.clearLocks().catch(() => ({ ok: false }));
      toast(r.ok ? { title: 'Stale lock files cleared', type: 'ok' } : { title: 'Cleanup failed', body: r.error, type: 'error' });
      break;
    }
    default:
      toast({ title: 'No automatic fix for this', body: issue.hint || '', type: 'info' });
  }
  // Re-run the self-check after a fix to refresh the banner and status
  setTimeout(selfCheck, 600);
  setTimeout(refreshStatus, 600);
}

async function fixAllIssues(issues) {
  const fixable = issues.filter((i) => i.fix);
  for (const i of fixable) {
    // eslint-disable-next-line no-await-in-loop
    await fixIssue(i);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 500));
  }
}

init().catch((e) => {
  console.error(e);
  toast({ title: 'Initialisation failed', body: e.message, type: 'error', sticky: true });
});
