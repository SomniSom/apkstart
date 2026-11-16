'use strict';
/**
 * Проверка окружения Linux: то, что должно быть в системе до первого запуска.
 * Запуск: npm run check:deps
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function which(cmd) {
  try {
    const out = execFileSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).trim();
    return out || '';
  } catch (_) {
    return '';
  }
}

function kvmStatus() {
  try {
    const st = fs.statSync('/dev/kvm');
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    return { ok: st.isCharacterDevice(), note: 'доступен' };
  } catch (e) {
    return { ok: false, note: e.code === 'EACCES' ? 'нет прав (добавьте себя в группу kvm)' : 'не найден (нет виртуализации или модуля kvm)' };
  }
}

function main() {
  const checks = [];
  const add = (name, ok, note) => checks.push({ name, ok, note });

  add('Linux x86_64', process.platform === 'linux' && process.arch === 'x64', `${process.platform}/${process.arch}`);
  add('Node.js >= 20', Number(process.versions.node.split('.')[0]) >= 20, process.versions.node);

  const kvm = kvmStatus();
  add('/dev/kvm', kvm.ok, kvm.note);

  for (const [cmd, pkg, why] of [
    ['xdotool', 'xdotool', 'заголовок, размер и фокус окна приложения'],
    ['wmctrl', 'wmctrl', 'полноэкранный режим окна'],
    ['qemu-img', 'qemu-utils', 'раздел /data'],
    ['resize2fs', 'e2fsprogs', 'расширение /data'],
    ['xdg-mime', 'xdg-utils', 'привязка .apk'],
    ['update-desktop-database', 'desktop-file-utils', 'обновление меню приложений'],
  ]) {
    const p = which(cmd);
    add(cmd, !!p, p ? path.basename(p) : `не найден: sudo apt install ${pkg} — ${why}`);
  }

  const session = process.env.XDG_SESSION_TYPE || (process.env.WAYLAND_DISPLAY ? 'wayland' : 'x11');
  add('графическая сессия', !!process.env.DISPLAY || session === 'wayland', session);

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    process.stdout.write(`${c.ok ? '  ok  ' : ' WARN '} ${c.name.padEnd(width)}  ${c.note}\n`);
  }
  const bad = checks.filter((c) => !c.ok);
  process.stdout.write(`\n${bad.length ? `${bad.length} из ${checks.length}: есть предупреждения` : 'всё готово'}\n`);
  process.stdout.write(`данные: ${path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'apkstart')}\n`);
  process.exitCode = bad.length ? 1 : 0;
}

main();
