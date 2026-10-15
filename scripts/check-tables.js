// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Проверка GFM-таблиц в markdown-документации и учёт таблиц (docs/tables.md).
 *
 * Таблица считается «рассыпавшейся», если GitHub/docsify покажут её не целиком:
 *   1. строка-разделитель `|---|` не идёт сразу за строкой заголовка;
 *   2. в строке число ячеек не совпадает с заголовком;
 *   3. внутри таблицы есть пустая строка (таблица разрывается на две);
 *   4. в ячейке есть неэкранированный `|` (в том числе внутри `код`) — GFM
 *      режет ячейку по нему, даже если он в обратных кавычках.
 *
 *   node scripts/check-tables.js          # проверка; 0 — все таблицы целы и реестр актуален
 *   node scripts/check-tables.js --write  # пересобрать реестр docs/tables.md
 *
 * Таблицы внутри блоков ```код``` не учитываются. Zero dependencies.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY = 'docs/tables.md';
const WRITE = process.argv.includes('--write');

const DELIM_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function mdFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) mdFiles(full, out);
    else if (entry.name.endsWith('.md') && entry.name !== path.basename(REGISTRY)) out.push(full);
  }
  return out;
}

/* Разбивка строки по неэкранированным `|`, без пустых краевых ячеек. */
function splitCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/);
}

/* Неэкранированный `|` внутри обратных кавычек — GFM разрежет ячейку. */
function rawPipeInCode(line) {
  const inner = line.replace(/\\\|/g, '');
  const inCode = inner.match(/`[^`]*`/g) || [];
  return inCode.some((span) => span.includes('|'));
}

function tablesIn(file) {
  const rel = path.relative(ROOT, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const found = [];
  const problems = [];
  let fence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    if (!line.includes('|') || i + 1 >= lines.length) continue;
    if (!DELIM_RE.test(lines[i + 1]) || !lines[i + 1].includes('-')) continue;

    const start = i + 1; // 1-based номер строки заголовка
    const header = splitCells(line);
    const cols = header.length;
    let rows = 0;
    let j = i + 2;
    const tableProblems = [];

    if (splitCells(lines[i + 1]).length !== cols) {
      tableProblems.push(`строка-разделитель с ${splitCells(lines[i + 1]).length} колонками вместо ${cols}`);
    }
    for (; j < lines.length; j++) {
      const row = lines[j];
      if (row.trim() === '') {
        // Пустая строка, за которой идёт строка таблицы, — разрыв таблицы.
        const next = lines[j + 1] || '';
        if (next.includes('|') && next.trim().startsWith('|')) {
          tableProblems.push(`пустая строка внутри таблицы (строка ${j + 1}) — таблица разорвана`);
        }
        break;
      }
      if (!row.includes('|')) break;
      rows++;
      const cells = splitCells(row);
      if (cells.length !== cols) {
        tableProblems.push(`строка ${j + 1}: ${cells.length} ячеек вместо ${cols}`);
      }
      if (rawPipeInCode(row)) {
        tableProblems.push(`строка ${j + 1}: неэкранированный | внутри \`код\` (писать \\|)`);
      }
    }
    if (rawPipeInCode(line)) tableProblems.push(`заголовок: неэкранированный | внутри \`код\``);

    const title = findTitle(lines, i);
    found.push({ file: rel, line: start, cols, rows, title, ok: tableProblems.length === 0 });
    for (const p of tableProblems) problems.push(`${rel}:${start}: ${p}`);
    i = j - 1;
  }
  return { found, problems };
}

/* Ближайший заголовок над таблицей — для читаемого реестра. */
function findTitle(lines, i) {
  for (let k = i - 1; k >= 0; k--) {
    const m = lines[k].match(/^#{1,6}\s+(.*?)\s*$/);
    if (m) return m[1].replace(/\s+#+\s*$/, '').replace(/`/g, '');
  }
  return '—';
}

function escapeCell(s) {
  return String(s).replace(/\|/g, '\\|');
}

function buildRegistry(all) {
  const today = '2026-10-15';
  const byFile = new Map();
  for (const t of all) {
    if (!byFile.has(t.file)) byFile.set(t.file, []);
    byFile.get(t.file).push(t);
  }
  const lines = [];
  lines.push('# Таблицы документации', '');
  lines.push('> Реестр всех markdown-таблиц репозитория. Файл собирается и проверяется скриптом ' +
    '`scripts/check-tables.js` (`npm run check:tables`). Не править вручную: ' +
    'после изменения таблиц выполните `node scripts/check-tables.js --write`.', '');
  lines.push(`Актуально на ${today}. Всего таблиц: **${all.length}** в **${byFile.size}** файлах.`, '');
  lines.push('## Сводка', '');
  lines.push('| Файл | Таблиц | Статус |', '|---|---:|---|');
  for (const [file, list] of [...byFile.entries()].sort()) {
    const ok = list.every((t) => t.ok) ? '✅ целы' : '⚠️ проблемы';
    lines.push(`| [\`${escapeCell(file)}\`](/${file}) | ${list.length} | ${ok} |`);
  }
  lines.push('', '## Реестр', '');
  lines.push('| № | Файл | Строка | Раздел | Колонок | Строк данных | Статус |', '|---:|---|---:|---|---:|---:|---|');
  let n = 0;
  for (const [file, list] of [...byFile.entries()].sort()) {
    for (const t of list) {
      n++;
      lines.push(`| ${n} | [\`${escapeCell(t.file)}\`](/${t.file}) | ${t.line} | ${escapeCell(t.title)} | ${t.cols} | ${t.rows} | ${t.ok ? '✅' : '⚠️'} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

const files = mdFiles(ROOT);
const all = [];
const problems = [];
for (const file of files.sort()) {
  const { found, problems: p } = tablesIn(file);
  all.push(...found);
  problems.push(...p);
}

const registryPath = path.join(ROOT, REGISTRY);
const registry = buildRegistry(all);

if (WRITE) {
  fs.writeFileSync(registryPath, registry);
  console.log(`реестр записан: ${REGISTRY} (${all.length} таблиц)`);
}

if (problems.length) {
  console.error('Сломанные таблицы:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

if (!WRITE) {
  const current = fs.existsSync(registryPath) ? fs.readFileSync(registryPath, 'utf8') : '';
  if (current !== registry) {
    console.error(`${REGISTRY} устарел — выполните: node scripts/check-tables.js --write`);
    process.exit(1);
  }
}

console.log(`tables OK: ${all.length} таблиц в ${new Set(all.map((t) => t.file)).size} файлах, все целы, реестр актуален`);
