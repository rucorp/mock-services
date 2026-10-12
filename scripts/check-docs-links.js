// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Проверка относительных ссылок markdown-документации (F-38).
 *
 * Документация адаптеров живёт в `docs/reference/<provider>/` (см. CONTRIBUTING.md),
 * и все относительные ссылки между доками обязаны разрешаться в существующие файлы.
 * Скрипт обходит *.md (корень, docs/, services/, packages/) и для каждой
 * относительной ссылки `[текст](путь)` / `![](путь)` проверяет существование цели
 * (якоря `#...` отбрасываются; http(s):/mailto: пропускаются).
 *
 *   node scripts/check-docs-links.js     # 0 — все ссылки живы
 *
 * Zero dependencies.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['docs', 'services', 'packages'];
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;

function mdFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...mdFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function checkFile(file) {
  const problems = [];
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(LINK_RE)) {
    const raw = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue; // http:, https:, mailto: — внешние
    const target = raw.split('#')[0];
    if (!target) continue; // только якорь `#section`
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
    if (!fs.existsSync(resolved)) {
      const line = text.slice(0, match.index).split('\n').length;
      problems.push(`${path.relative(ROOT, file)}:${line} -> ${raw}`);
    }
  }
  return problems;
}

const files = [
  path.join(ROOT, 'README.md'),
  path.join(ROOT, 'CONTRIBUTING.md'),
  path.join(ROOT, 'SECURITY.md'),
  ...SCAN_DIRS.flatMap((d) => (fs.existsSync(path.join(ROOT, d)) ? mdFiles(path.join(ROOT, d)) : [])),
];

const problems = files.flatMap(checkFile);
if (problems.length) {
  console.error('Битые относительные ссылки в документации:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`docs links OK: ${files.length} файлов, битых ссылок нет`);
