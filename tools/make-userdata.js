'use strict';
/**
 * Build the userdata seed image (for debugging).
 * Usage: node tools/make-userdata.js <out-file> [size-mb]
 */
const fs = require('fs');
const { buildEmptyExt4 } = require('../src/core/userdata');

const out = process.argv[2];
if (!out) {
  console.error('usage: node tools/make-userdata.js <out-file> [size-mb]');
  process.exit(2);
}
const sizeMB = Number(process.argv[3] || 64);
const img = buildEmptyExt4({ sizeMB });
fs.writeFileSync(out, img);
console.log(`wrote ${out} (${(img.length / 1024 / 1024).toFixed(0)} MB, ext4 with 4K blocks)`);
