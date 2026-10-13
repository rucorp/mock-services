#!/usr/bin/env node
// [sz/#64 · PC-17] Диагностика drift-чекера лжёт для alfa:callback-operation.
// scripts/check-protocol-drift.js:273 — копипаст:
//   assertCheck('alfa:callback-operation', op, inServer && inOpenApi, `server=${inServer}, openapi=${inServer}`);
//                                                                                              ^^^^^^^^^ должно быть inOpenApi.
// Статика: единственная строка с `openapi=${inServer}`. Динамика: в scratch-копии
// удаляем схему 'approved' из openapi -> проверка ПАДАЕТ (openapi реально false),
// но диагностика печатает openapi=true. Это «до»-проба: после фикса диагностика
// обязана показывать openapi=false при отсутствующей схеме.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
function report(id, title, verdict, evidence) {
  console.log(`\n=== ${id}: ${title} ===\nВЕРДИКТ: ${verdict}${evidence ? '\n' + evidence : ''}`);
}

function runDrift(cwd) {
  const r = spawnSync('node', [path.join('scripts', 'check-protocol-drift.js')], { cwd, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

(async () => {
  /* ---------- Статика: копипаст в исходнике ---------- */
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'check-protocol-drift.js'), 'utf8');
  const lines = src.split('\n');
  const bad = [];
  lines.forEach((l, i) => { if (l.includes('openapi=${inServer}')) bad.push(i + 1); });
  const callbackLine = lines.findIndex((l) => l.includes("alfa:callback-operation'") && l.includes('openapi=${inServer}')) + 1;
  // Адаптация 2026-10-13 (волна #58): на исправленном дереве строки с копипастом
  // больше нет — фаза обязана завершаться вердиктом «не подтвердилось», а не падать.
  const staticEvidence = callbackLine > 0
    ? `фрагмент :${callbackLine}: ${lines[callbackLine - 1].trim().slice(0, 160)}`
    : '(строки с копипастом нет — фикс применён)';
  report('PC-17a', 'статика: диагностика печатает openapi=${inServer} вместо inOpenApi',
    bad.length >= 1 ? 'ПОДТВЕРЖДЕНО' : 'не подтвердилось',
    `scripts/check-protocol-drift.js, строк(с) с openapi=\${inServer}: ${bad.join(', ') || '—'} (алфа-callback-проверка: :${callbackLine || '—'})\n` +
    staticEvidence);

  /* ---------- Динамика: scratch-копия с удалённой схемой 'approved' ---------- */
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sz-pc17-'));
  try {
    for (const dir of ['protocols', 'docs', 'services', 'scripts']) {
      fs.cpSync(path.join(REPO, dir), path.join(scratch, dir), { recursive: true });
    }

    const control = runDrift(scratch);
    const controlClean = control.code === 0 && /расхождений: 0/.test(control.out);
    report('PC-17b', 'контроль: нетронутая scratch-копия — drift зелёный',
      controlClean ? 'ПОДТВЕРЖДЕНО' : 'не подтвердилось',
      `exit=${control.code}; ${((control.out.match(/Проверено инвариантов контракта: .*/) || [''])[0]).trim()}`);

    const oaPath = path.join(scratch, 'docs', 'openapi', 'alfa-mock.openapi.json');
    const oa = JSON.parse(fs.readFileSync(oaPath, 'utf8'));
    const schemas = JSON.stringify(oa.components.schemas).split('approved').join('zpproved-removed');
    oa.components.schemas = JSON.parse(schemas);
    fs.writeFileSync(oaPath, JSON.stringify(oa, null, 2));

    const patched = runDrift(scratch);
    const failLine = (patched.out.split('\n').find((l) => l.includes('alfa:callback-operation') && l.includes('approved')) || '').trim();
    const lied = patched.code !== 0 && /openapi=true/.test(failLine);
    report('PC-17c', 'динамика: схема openapi удалена -> проверка падает, но диагностика печатает openapi=true',
      lied ? 'ПОДТВЕРЖДЕНО (диагностика противоречит вердикту)' : 'не подтвердилось',
      `exit=${patched.code} (проверка ПРОВАЛЕНА => inOpenApi фактически false)\n` +
      `строка диагностики: ${failLine.slice(0, 180)}\n` +
      `итог: месседж говорит openapi=true, а проверка упала именно из-за openapi=false — диагностика бесполезна для отладки`);

    console.log('\n---- ИТОГ PC-17 ----');
    console.log('До фикса: при падении alfa:callback-operation диагностика всегда показывает openapi=<значение inServer>.');
    console.log('Ожидание после фикса (предрегистрация): та же проба печатает server=true, openapi=false; строк с openapi=${inServer} в чекере нет.');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch((e) => { console.error('ПРОБА УПАЛА:', e.message); process.exit(2); });
