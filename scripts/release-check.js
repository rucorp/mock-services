// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Проверка согласованности релиза (R-17). Запускается в CI по тегу `v*`
 * (workflow Release) и локально:
 *
 *   node scripts/release-check.js --tag v0.8.0
 *
 * Проверяет: тег == версии package.json; в CHANGELOG есть раздел `[X.Y.Z]`;
 * существует файл нот `docs/release-notes/<тег>.md`; в CHANGELOG нет
 * запрещённой правоустанавливающей формулировки (R-01).
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;

const args = process.argv.slice(2);
const tagArg = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : null;
const tag = tagArg || process.env.GITHUB_REF_NAME || '';

const problems = [];
if (!tag) problems.push('тег не задан (--tag vX.Y.Z или GITHUB_REF_NAME)');
else if (tag !== `v${version}`) problems.push(`тег ${tag} не совпадает с версией пакета v${version}`);

const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## [${version}]`)) problems.push(`в CHANGELOG.md нет раздела «## [${version}]»`);

const notesName = `${tag || `v${version}`}.md`;
if (!fs.existsSync(path.join(ROOT, 'docs', 'release-notes', notesName))) {
  problems.push(`нет файла нот релиза: docs/release-notes/${notesName}`);
}

if (changelog.includes('все права защищены')) {
  problems.push('в CHANGELOG.md вернулась правоустанавливающая формулировка (R-01)');
}

if (problems.length) {
  console.error('release-check: проблемы:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`release-check OK: ${tag}, CHANGELOG и ноты на месте`);
