// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Страховка стандарта шапок (R-01, MS-05): правоустанавливающая формулировка
 * «все права защищены» противоречила лицензии Apache-2.0 и удалена из документов.
 * Проверка валит CI, если формулировка вернётся в любой markdown-файл проекта.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FORBIDDEN = 'все права защищены';
const SKIP_DIRS = new Set(['.git', 'node_modules', 'site-build', 'dist', 'dist-root', 'data', '.zcode', '.openclaw']);

function collectMarkdown(directory, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collectMarkdown(absolute, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(absolute);
  }
  return out;
}

const files = collectMarkdown(ROOT);
const offenders = files.filter((file) => fs.readFileSync(file, 'utf8').includes(FORBIDDEN));

if (offenders.length) {
  console.log(`copyright FAILED: формулировка «${FORBIDDEN}» найдена (${offenders.length}):`);
  for (const file of offenders) console.log(' -', path.relative(ROOT, file));
  process.exit(1);
}

console.log(`copyright OK: ${files.length} markdown-файлов, правоустанавливающей формулировки нет`);
