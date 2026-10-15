// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Проверка источников сайта документации и его изолированной сборки VitePress.
 *
 *   node scripts/check-site.js
 *
 * Полная HTML-проверка выполняется отдельно в site-build/ после npm ci:
 *   npm test
 *
 * Runtime-зависимостей у mock-services нет: VitePress живёт только в site-build.
 */

const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../site-build/scripts/site-manifest.cjs');

const ROOT = path.resolve(__dirname, '..');
const problems = [];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function headingSlug(text) {
  return String(text)
    .trim()
    .replace(/[A-Z]+/g, (match) => match.toLowerCase())
    .replace(/<[^>]+>/g, '')
    .replace(/[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
    .replace(/\s/g, '-')
    .replace(/-+/g, '-')
    .replace(/^(\d)/, '_$1');
}

function headingSlugs(relativePath) {
  const slugs = [];
  const seen = Object.create(null);
  const text = read(relativePath);
  for (const line of text.split('\n')) {
    const match = line.match(/^#{1,6}\s+(.*?)\s*$/);
    if (!match) continue;
    const heading = match[1]
      .replace(/\s+#+\s*$/, '')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!heading) continue;
    const base = headingSlug(heading);
    const duplicate = seen[base] || 0;
    seen[base] = duplicate + 1;
    slugs.push(duplicate ? `${base}-${duplicate}` : base);
  }
  return slugs;
}

function sidebarSourcePath(target) {
  const pathPart = target.replace(/^\//, '').split('#')[0];
  return pathPart.endsWith('.md') ? pathPart : `${pathPart}.md`;
}

/* ---------- 1. Build tools stay isolated from the runtime package ---------- */
const rootPackage = JSON.parse(read('package.json'));
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  if (rootPackage[field] && Object.keys(rootPackage[field]).length) {
    problems.push(`root package.json не должен иметь ${field}; инструменты сайта изолированы в site-build/`);
  }
}

const sitePackage = JSON.parse(read('site-build/package.json'));
if (sitePackage.devDependencies?.vitepress !== '1.6.4') {
  problems.push('site-build/package.json: VitePress должен быть закреплён на 1.6.4');
}
for (const script of ['build:pages', 'build:root', 'check', 'test']) {
  if (!sitePackage.scripts?.[script]) problems.push(`site-build/package.json: отсутствует скрипт ${script}`);
}
for (const required of [
  'site-build/.vitepress/config.mjs',
  'site-build/.vitepress/theme/index.js',
  'site-build/.vitepress/theme/SourceLinks.vue',
  'site-build/.vitepress/theme/custom.css',
  'site-build/public/legacy-redirect.js',
  'site-build/scripts/build-site.js',
  'site-build/scripts/check-site-build.js',
]) {
  if (!exists(required)) problems.push(`файл сборки сайта отсутствует: ${required}`);
}

const config = exists('site-build/.vitepress/config.mjs') ? read('site-build/.vitepress/config.mjs') : '';
for (const [expression, message] of [
  [/cleanUrls:\s*true/, 'не включены чистые URL'],
  [/outline:\s*\{\s*level:\s*\[1,\s*3\]/, 'интерактивное оглавление не охватывает h1–h3'],
  [/headers:\s*\{\s*level:\s*\[1,\s*2,\s*3\]/, 'не извлекаются заголовки h1–h3 для TOC'],
  [/transformPageData\(/, 'страницы не получают метаданные из Markdown'],

  [/transformHead\(/, 'canonical не генерируется при сборке'],
  [/srcDir:\s*CONTENT_DIR/, 'источником сборки не является staging-копия Markdown'],
]) {
  if (!expression.test(config)) problems.push(`VitePress config: ${message}`);
}

/* ---------- 2. Workflow: проверки на PR, Pages deploy только с main, SHA pins ---------- */
if (!exists('.github/workflows/pages.yml')) {
  problems.push('.github/workflows/pages.yml отсутствует');
} else {
  const workflow = read('.github/workflows/pages.yml');
  if (!/pull_request:/.test(workflow) || !/branches:\s*\[main\]/.test(workflow)) {
    problems.push('Pages workflow должен собираться на pull_request и push в main');
  }
  if (!/github\.event_name\s*==\s*'push'.*github\.ref\s*==\s*'refs\/heads\/main'/s.test(workflow)) {
    problems.push('Pages workflow должен публиковать только push в main');
  }
  for (const match of workflow.matchAll(/^\s*uses:\s*([^\s]+)$/gm)) {
    if (!/@[0-9a-f]{40}$/i.test(match[1])) {
      problems.push(`GitHub Action не закреплён по SHA: ${match[1]}`);
    }
  }
  if (!/npm test/.test(workflow) || !/working-directory:\s*site-build/.test(workflow)) {
    problems.push('Pages workflow должен выполнять npm test и сборку в site-build/');
  }
}

/* ---------- 3. Sidebar includes every public Markdown page ---------- */
const sidebarText = exists('_sidebar.md') ? read('_sidebar.md') : '';
const sidebarTargets = new Set();
const seenSidebarTargets = new Map();
for (const match of sidebarText.matchAll(/\]\(([^)]+)\)/g)) {
  const target = match[1].trim();
  if (!target || /^https?:/i.test(target)) continue;
  const filePath = sidebarSourcePath(target);
  sidebarTargets.add(filePath);
  seenSidebarTargets.set(target, (seenSidebarTargets.get(target) || 0) + 1);
}

const publicDocuments = manifest.getPublicDocuments();
for (const document of publicDocuments) {
  if (!sidebarTargets.has(document)) problems.push(`документ не попал в навигацию сайта (_sidebar.md): ${document}`);
}
for (const [target, count] of seenSidebarTargets) {
  if (count > 1) problems.push(`_sidebar.md: ссылка дублируется (${count}) — ${target}`);
}

/* ---------- 4. Sidebar pages and anchors exist ---------- */
for (const match of sidebarText.matchAll(/\]\(([^)]+)\)/g)) {
  const target = match[1].trim();
  if (/^https?:/i.test(target)) continue;
  const [pathPart, anchorPart] = target.replace(/^\//, '').split('#');
  if (!pathPart.endsWith('.md')) continue;
  if (!publicDocuments.includes(pathPart)) {
    problems.push(`_sidebar.md: ссылка ведёт в документ, который не собирается: ${target}`);
    continue;
  }
  if (!anchorPart) continue;
  let anchor;
  try {
    anchor = decodeURIComponent(anchorPart);
  } catch (error) {
    problems.push(`_sidebar.md: некорректный anchor ${target}`);
    continue;
  }
  if (!headingSlugs(pathPart).includes(anchor)) {
    problems.push(`_sidebar.md: якорь #${anchor} не найден в ${pathPart}`);
  }
}

/* ---------- 5. Guides continue to satisfy the existing authoring template ---------- */
const GUIDE_EXEMPT = new Map([
  ['docs/integration/lovii.md', 'подключение внешней платформы, а не протокол провайдера'],
]);
const integrationDir = path.join(ROOT, 'docs', 'integration');
const guides = fs.readdirSync(integrationDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => `docs/integration/${entry.name}`);

for (const guide of guides) {
  if (GUIDE_EXEMPT.has(guide)) continue;
  const text = read(guide);
  const numbers = [...text.matchAll(/^##\s+(\d+)\.\s+\S/gm)].map((match) => Number(match[1]));
  if (!numbers.length) problems.push(`${guide}: нет нумерованных разделов «## 1. …»`);
  else if (numbers.join(',') !== numbers.map((_, index) => index + 1).join(',')) {
    problems.push(`${guide}: нумерация разделов «## N.» должна идти 1..N без пропусков и дублей`);
  }
  if (!/^##\s+(?:\d+\.\s*)?(?:Что мок проверяет за вас|Известные отличия)/m.test(text)) {
    problems.push(`${guide}: нет раздела «Что мок проверяет за вас»/«Известные отличия»`);
  }
  if (!/^##\s+\d+\.\s+Ссылки\s*$/m.test(text)) problems.push(`${guide}: нет раздела «Ссылки»`);
  if (!/\]\([^)]*services\/[a-z0-9-]+-mock\/README\.md\)/.test(text)) {
    problems.push(`${guide}: нет ссылки на README сервиса`);
  }
}

/* ---------- 6. README mentions every service directory ---------- */
const readme = read('README.md');
const servicesDir = path.join(ROOT, 'services');
for (const entry of fs.readdirSync(servicesDir, { withFileTypes: true })) {
  if (entry.isDirectory() && !readme.includes(entry.name)) {
    problems.push(`README.md не упоминает сервис ${entry.name} (services/${entry.name})`);
  }
}

if (problems.length) {
  console.error('Проблемы сайта документации:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`site OK: ${publicDocuments.length} документов в навигации, VitePress изолирован в site-build/, Pages workflow SHA-pinned`);
