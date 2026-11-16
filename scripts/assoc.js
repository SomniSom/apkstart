#!/usr/bin/env node
'use strict';
/**
 * Привязка .apk без запуска интерфейса (Linux)
 *   node scripts/assoc.js on   → открывать .apk через ApkStart
 *   node scripts/assoc.js off  → вернуть прежний обработчик
 */
const path = require('path');
const fs = require('fs');
const { registerAssociation, unregisterAssociation, isAssociated } = require('../src/core/assoc');

const action = process.argv[2] || 'on';
const appDir = path.join(__dirname, '..');
const localElectron = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron');
const exe = process.env.APKSTART_PACKAGED ? process.execPath : localElectron;
const isDev = !process.env.APKSTART_PACKAGED;
const iconName = path.join(appDir, 'src', 'ui', 'assets', 'logo-128.png');

if (!fs.existsSync(exe)) {
  console.error(`Не найден Electron: ${exe}\nСначала выполните npm install.`);
  process.exit(1);
}

if (action === 'on') {
  const r = registerAssociation(exe, isDev ? appDir : undefined, fs.existsSync(iconName) ? iconName : undefined);
  console.log(`Готово: ${r.handler}`);
  console.log(`Обработчик .apk для application/vnd.android.package-archive установлен (${r.progId}).`);
  console.log(isAssociated() ? 'Двойной клик по .apk теперь открывает ApkStart.' : 'xdg-mime не подтвердил выбор — проверьте его наличие.');
} else if (action === 'off') {
  const r = unregisterAssociation();
  console.log(r.restored ? `Привязка снята, прежний обработчик: ${r.restored}` : 'Привязка снята.');
} else {
  console.log('Использование: node scripts/assoc.js [on|off]');
  process.exit(1);
}
