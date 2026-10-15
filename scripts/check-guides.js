// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Проверка документационных конвенций, не зависящих от движка сайта:
 *   1. каждый гайд в `docs/integration/` следует шаблону «интеграция за 10 минут»
 *      (шаблон зафиксирован в CONTRIBUTING.md): нумерация `## N.` 1..N,
 *      раздел «Что мок проверяет за вас» (или «Известные отличия…»),
 *      раздел «Ссылки», ссылка на README сервиса;
 *   2. README.md упоминает все каталоги `services/*`.
 *
 *   node scripts/check-guides.js
 *
 * Zero dependencies.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const problems = [];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/* ---------- 1. Гайды интеграции: единый шаблон ---------- */
const integrationGuides = fs.readdirSync(path.join(ROOT, 'docs', 'integration'), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => `docs/integration/${entry.name}`);

for (const guide of integrationGuides) {
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

/* ---------- 2. README упоминает все сервисы ---------- */
const readme = read('README.md');
const servicesDir = path.join(ROOT, 'services');
for (const entry of fs.readdirSync(servicesDir, { withFileTypes: true })) {
  if (entry.isDirectory() && !readme.includes(entry.name)) {
    problems.push(`README.md не упоминает сервис ${entry.name} (services/${entry.name})`);
  }
}

if (problems.length) {
  console.error('Проблемы документационных конвенций:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`guides OK: ${integrationGuides.length} гайдов по шаблону; README упоминает все сервисы`);
