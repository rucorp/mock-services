// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Проверка публичного сайта документации (GitHub Pages + docsify).
 *
 * Инварианты:
 *   1. самодостаточность — ни одна страница сайта не тянет ресурсы из внешней
 *      сети (CDN/шрифты): только файлы репозитория (site/vendor/*, site/*);
 *   2. ресурсы, на которые ссылается index.html, существуют;
 *   3. навигация полная — каждый публичный markdown-документ достижим из
 *      `_sidebar.md` (иначе документ есть, а найти его на сайте нельзя);
 *   4. служебные файлы сайта на месте и непустые.
 *
 *   node scripts/check-site.js     # 0 — сайт собран корректно
 *
 * Zero dependencies.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const problems = [];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

/* ---------- 1. index.html: локальные ресурсы и запрет CDN ---------- */

if (!exists('index.html')) {
  problems.push('index.html отсутствует');
} else {
  const html = read('index.html');
  const assets = [];

  for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) assets.push(match[1]);
  for (const match of html.matchAll(/<link[^>]+href="([^"]+)"/g)) assets.push(match[1]);
  for (const match of html.matchAll(/<img[^>]+src="([^"]+)"/g)) assets.push(match[1]);

  for (const asset of assets) {
    if (/^(https?:)?\/\//i.test(asset)) {
      problems.push(`index.html тянет внешний ресурс (CDN запрещён): ${asset}`);
      continue;
    }
    if (!exists(asset)) problems.push(`index.html ссылается на отсутствующий файл: ${asset}`);
  }

  for (const required of ['site/theme.css', 'site/site.js', 'site/favicon.svg',
    'site/vendor/docsify.min.js', 'site/vendor/docsify-search.min.js']) {
    if (!assets.includes(required)) problems.push(`index.html не подключает ${required}`);
  }

  if (!/window\.\$docsify\s*=/.test(read('site/site.js'))) {
    problems.push('site/site.js не задаёт window.$docsify');
  }
  if (!/loadSidebar:\s*true/.test(read('site/site.js'))) {
    problems.push('site/site.js: не включён loadSidebar');
  }
}

/* ---------- 2. CSS/JS сайта: никаких внешних url(...) ---------- */

for (const rel of ['site/theme.css', 'site/site.js']) {
  if (!exists(rel)) {
    problems.push(`${rel} отсутствует`);
    continue;
  }
  const text = read(rel);
  if (!text.trim()) problems.push(`${rel} пустой`);
  for (const match of text.matchAll(/url\(\s*['"]?(https?:)?\/\/[^)'"]+/g)) {
    problems.push(`${rel}: внешний url() — ${match[0].slice(0, 60)}…`);
  }
  if (/@import\s+url\(\s*['"]?https?:/i.test(text)) {
    problems.push(`${rel}: @import внешнего шрифта/стиля`);
  }
}

/* ---------- 3. Полнота навигации ---------- */

function mdFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) mdFiles(full, out);
    else if (entry.name.endsWith('.md')) out.push(path.relative(ROOT, full));
  }
  return out;
}

const sidebar = exists('_sidebar.md') ? read('_sidebar.md') : '';
const sidebarTargets = new Set();
for (const match of sidebar.matchAll(/\]\(([^)]+)\)/g)) {
  const target = match[1].split('#')[0].trim();
  if (!target || /^https?:/i.test(target)) continue;
  sidebarTargets.add(target.replace(/^\//, ''));
}

const publicDocs = [
  'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'AGENTS.md', 'CHANGELOG.md',
  ...mdFiles(path.join(ROOT, 'docs')),
  ...mdFiles(path.join(ROOT, 'services')),
  ...mdFiles(path.join(ROOT, 'packages')),
];

for (const doc of publicDocs) {
  if (doc === '_sidebar.md') continue;
  if (!sidebarTargets.has(doc)) problems.push(`документ не попал в навигацию сайта (_sidebar.md): ${doc}`);
}

/* Ссылки сайдбара не должны дублироваться (один документ с разными якорями — можно) */
const seen = new Map();
for (const match of sidebar.matchAll(/\]\(([^)]+)\)/g)) {
  const target = match[1].replace(/^\//, '');
  if (/^https?:/i.test(target)) continue;
  seen.set(target, (seen.get(target) || 0) + 1);
}
for (const [target, count] of seen) {
  if (count > 1) problems.push(`_sidebar.md: ссылка дублируется (${count}) — ${target}`);
}

/* ---------- 4. Ссылки сайдбара: только markdown и корректные якоря ---------- */

/*
 * Слаг документации — зеркало slugify из вендоренного docsify (4.13.1):
 * латинские заглавные приводятся к строчным, кириллические — нет,
 * пунктуация удаляется, пробелы становятся дефисами, дубли получают «-1».
 * Если docsify обновят, тест это покажет.
 */
function docsifySlug(text) {
  const seen = Object.create(null);
  return (value) => {
    const slug = String(value)
      .trim()
      .replace(/[A-Z]+/g, (match) => match.toLowerCase())
      .replace(/<[^>]+>/g, '')
      .replace(/[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
      .replace(/\s/g, '-')
      .replace(/-+/g, '-')
      .replace(/^(\d)/, '_$1');
    const count = seen[slug];
    seen[slug] = count === undefined ? 0 : count + 1;
    return count ? slug + '-' + count : slug;
  };
}

function headingSlugs(relPath) {
  const slugs = [];
  const next = docsifySlug();
  for (const rawLine of fs.readFileSync(path.join(ROOT, relPath), 'utf8').split('\n')) {
    const match = rawLine.match(/^#{1,6}\s+(.*?)\s*$/);
    if (!match) continue;
    const text = match[1]
      .replace(/\s+#+\s*$/, '')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (text) slugs.push(next(text));
  }
  return slugs;
}

for (const match of sidebar.matchAll(/\]\(([^)]+)\)/g)) {
  const target = match[1].trim();
  if (/^https?:/i.test(target)) continue;

  const [filePart, hashPart] = target.replace(/^\//, '').split('#');
  const ext = path.extname(filePart).toLowerCase();

  if (ext && ext !== '.md') {
    problems.push(`_sidebar.md: ссылка на не-markdown файл должна быть абсолютной (GitHub): ${target}`);
    continue;
  }
  if (!hashPart) continue;

  const file = ext === '.md' ? filePart : filePart + '.md';
  if (!exists(file)) {
    problems.push(`_sidebar.md: якорь ведёт в отсутствующий документ: ${target}`);
    continue;
  }
  const anchor = decodeURIComponent(hashPart);
  if (!headingSlugs(file).includes(anchor)) {
    problems.push(`_sidebar.md: якорь #${anchor} не найден в ${file}`);
  }
}

/* ---------- 5. Гайды интеграции: единый шаблон ---------- */

/*
 * Шаблон гайда «Интеграция за 10 минут» зафиксирован в CONTRIBUTING.md
 * (раздел «Гайды интеграции: шаблон»). Линтер требует от каждого
 * провайдерского гайда в `docs/integration/`:
 *   1. нумерованные `## N.`-разделы без пропусков и дублей (1..N);
 *   2. раздел «Что мок проверяет за вас» (или «Известные отличия …»);
 *   3. раздел «Ссылки» — контракт сервиса, OpenAPI, манифест протокола;
 *   4. ссылку на README сервиса (`services/<name>-mock/README.md`).
 * Материалы, которые не описывают протокол провайдера, перечислены в
 * GUIDE_EXEMPT с причиной (у каждого — свой трек).
 */

const GUIDE_EXEMPT = new Map([
  ['docs/integration/lovii.md',
    'гайд по подключению платформы Lovii (внешний мок-контур), а не по протоколу провайдера; '
    + 'перенос в docs/platform/ — отдельной задачей'],
]);

for (const guide of mdFiles(path.join(ROOT, 'docs/integration')).map((f) => f.split(path.sep).join('/'))) {
  if (GUIDE_EXEMPT.has(guide)) continue;
  const text = read(guide);

  const numbers = [];
  for (const match of text.matchAll(/^##\s+(\d+)\.\s+\S/gm)) numbers.push(Number(match[1]));
  if (!numbers.length) {
    problems.push(`${guide}: нет нумерованных разделов «## 1. …» — гайд вне шаблона`);
  } else {
    const expected = numbers.map((_, i) => i + 1);
    if (numbers.join(',') !== expected.join(',')) {
      problems.push(`${guide}: нумерация разделов «## N.» должна идти 1..N без пропусков `
        + `и дублей, а идёт ${numbers.join(', ')}`);
    }
  }

  if (!/^##\s+(?:\d+\.\s*)?(?:Что мок проверяет за вас|Известные отличия)/m.test(text)) {
    problems.push(`${guide}: нет раздела «Что мок проверяет за вас» `
      + '(допустимая альтернатива — «Известные отличия от боевого провайдера»)');
  }
  if (!/^##\s+\d+\.\s+Ссылки\s*$/m.test(text)) {
    problems.push(`${guide}: нет раздела «Ссылки» на контракт сервиса (шаблон гайда)`);
  }
  if (!/\]\([^)]*services\/[a-z0-9-]+-mock\/README\.md\)/.test(text)) {
    problems.push(`${guide}: нет ссылки на README сервиса (services/<name>-mock/README.md)`);
  }
}

/* ---------- 6. README упоминает все services/* ---------- */

if (exists('README.md') && exists('services')) {
  const readme = read('README.md');
  const servicesDir = path.join(ROOT, 'services');
  const serviceDirs = fs.readdirSync(servicesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const svc of serviceDirs) {
    if (!readme.includes(svc)) {
      problems.push(`README.md не упоминает сервис ${svc} (services/${svc}) — структура устарела`);
    }
  }
}

/* ---------- 7. Вендоренные файлы и лицензии ---------- */

const vendorReadme = 'site/vendor/README-LICENSE.md';
for (const rel of ['site/vendor/docsify.min.js', 'site/vendor/docsify-search.min.js', vendorReadme]) {
  if (!exists(rel)) problems.push(`вендоренный файл отсутствует: ${rel}`);
}
if (exists(vendorReadme)) {
  const licenseText = read(vendorReadme);
  for (const name of ['docsify.min.js', 'docsify-search.min.js']) {
    if (!licenseText.includes(name)) problems.push(`${vendorReadme}: не описан ${name}`);
  }
}

/* ---------- Итог ---------- */

if (problems.length) {
  console.error('Проблемы сайта документации:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`site OK: ${publicDocs.length} документов в навигации, ресурсы локальные, вендор на месте`);
