// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Проверка относительных ссылок markdown-документации (F-38).
 *
 * Конспекты адаптеров живут в приватном репозитории `mock-services-docs` (см. CONTRIBUTING.md),
 * и все относительные ссылки между доками обязаны разрешаться в существующие файлы.
 * Скрипт обходит *.md (корень, docs/, services/, packages/), навигацию сайта
 * (`_sidebar.md`) и «сноски на документы вне публичного репозитория».
 *
 * Проверяется:
 *   1. каждая относительная ссылка `[текст](путь)` / `![](путь)` ведёт в существующий
 *      файл (якоря `#...` отбрасываются; http(s):/mailto: пропускаются; путь от корня
 *      сайта, начинающийся с `/`, разрешается от корня репозитория — так устроен
 *      `_sidebar.md` для docsify);
 *   2. GFM-сноски согласованы: у каждой ссылки `[^id]` есть определение `[^id]: …`
 *      и на каждое определение есть ссылка (стандарт: документы вне публичного
 *      периметра оформляются сноской, а не битой ссылкой);
 *   3. якоря `file.md#anchor` / `#anchor` существуют: слаг считается как на GitHub
 *      (строчные буквы, без пунктуации, пробелы — дефисы, дубли — «-1»), потому что
 *      документы читают и на GitHub, и на сайте — см. `scripts/check-site.js`,
 *      где отдельно проверяются слаги навигации сайта (`_sidebar.md`, нотация docsify);
 *   4. ни один документ, вынесенный из репозитория, не упоминается ссылкой.
 *
 *   node scripts/check-docs-links.js     # 0 — все ссылки живы
 *
 * Zero dependencies.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['docs', 'services', 'packages'];
const ROOT_FILES = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'AGENTS.md', 'CHANGELOG.md', '_sidebar.md'];
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;
const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\](?!:)/g;
const FOOTNOTE_DEF_RE = /^\s*\[\^([^\]\s]+)\]:/gm;

/* Слаг заголовка в нотации GitHub (docsify считает иначе — проверяется отдельно). */
function githubSlug(text) {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

const slugCache = new Map();

function fileAnchors(file) {
  if (slugCache.has(file)) return slugCache.get(file);
  const seen = Object.create(null);
  const anchors = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^#{1,6}\s+(.*?)\s*$/);
    if (!match) continue;
    let slug = githubSlug(match[1].replace(/\s+#+\s*$/, ''));
    if (!slug) continue;
    if (slug in seen) {
      seen[slug] += 1;
      slug = slug + '-' + seen[slug];
    } else {
      seen[slug] = 0;
    }
    anchors.push(slug);
  }
  slugCache.set(file, anchors);
  return anchors;
}

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

function checkLinks(file) {
  const problems = [];
  const text = fs.readFileSync(file, 'utf8');
  const isSidebar = path.basename(file) === '_sidebar.md';
  const isMarkdownFile = file.endsWith('.md');

  for (const match of text.matchAll(LINK_RE)) {
    const raw = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue; // http:, https:, mailto: — внешние

    const line = text.slice(0, match.index).split('\n').length;
    const hashAt = raw.indexOf('#');
    const target = (hashAt === -1 ? raw : raw.slice(0, hashAt)).split('?')[0];
    const anchor = hashAt === -1 ? '' : decodeURIComponent(raw.slice(hashAt + 1));

    /* цель: относительный путь, путь от корня сайта или сама эта страница */
    let resolved = file;
    if (target) {
      resolved = target.startsWith('/')
        ? path.join(ROOT, decodeURIComponent(target))
        : path.resolve(path.dirname(file), decodeURIComponent(target));
      if (!fs.existsSync(resolved)) {
        problems.push(`${path.relative(ROOT, file)}:${line} -> ${raw}`);
        continue;
      }
    }
    if (!isMarkdownFile || !anchor || anchor.startsWith('?id=')) continue;

    /* _sidebar.md — навигация сайта: там слаги docsify (их проверяет check-site.js) */
    if (isSidebar) continue;

    const anchors = resolved.endsWith('.md') ? fileAnchors(resolved) : [];
    if (!anchors.length) continue;
    if (!anchors.includes(anchor)) {
      const near = anchors.filter((slug) => slug.slice(0, 8) === anchor.slice(0, 8)).slice(0, 2);
      problems.push(
        `${path.relative(ROOT, file)}:${line} -> ${raw} (нет якоря #${anchor}${near.length ? '; есть: #' + near.join(', #') : ''})`
      );
    }
  }
  return problems;
}

function checkFootnotes(file) {
  const problems = [];
  const text = fs.readFileSync(file, 'utf8');
  const refs = new Set();
  const defs = new Set();

  for (const match of text.matchAll(FOOTNOTE_REF_RE)) refs.add(match[1]);
  for (const match of text.matchAll(FOOTNOTE_DEF_RE)) defs.add(match[1]);

  const rel = path.relative(ROOT, file);
  for (const id of refs) {
    if (!defs.has(id)) problems.push(`${rel}: сноска [^${id}] без определения`);
  }
  for (const id of defs) {
    if (!refs.has(id)) problems.push(`${rel}: определение [^${id}] без ссылки`);
  }
  return problems;
}

const files = [
  ...ROOT_FILES.map((name) => path.join(ROOT, name)).filter((file) => fs.existsSync(file)),
  ...SCAN_DIRS.flatMap((dir) => (fs.existsSync(path.join(ROOT, dir)) ? mdFiles(path.join(ROOT, dir)) : [])),
];

const linkProblems = files.flatMap(checkLinks);
const footnoteProblems = files.flatMap(checkFootnotes);

let failed = false;
if (linkProblems.length) {
  failed = true;
  console.error('Битые относительные ссылки в документации:');
  for (const problem of linkProblems) console.error(`  ${problem}`);
}
if (footnoteProblems.length) {
  failed = true;
  console.error('Несогласованные сноски (нужны и ссылка, и определение):');
  for (const problem of footnoteProblems) console.error(`  ${problem}`);
}
if (failed) process.exit(1);

console.log(`docs links OK: ${files.length} файлов, битых ссылок нет, сноски согласованы`);
