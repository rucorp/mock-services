#!/usr/bin/env node
// SZ probe: PA-54 / PA-55 / PA-56 (ядро, createSandboxRuntime) — волна #50, ревизия из сигнала.
// Одна и та же проба различает «до» (дефект воспроизведён) и «после» (закрыто) — дифференцирующая.
// Запуск: node docs/audit/tool-results/alfa-probes/sz-wave50-pa54-56.js [ /путь/к/репо ]
// (по умолчанию REPO резолвится от __dirname, как у остальных проб бандла; listener'ов нет)
// Источники находок: AUDIT-PARTY-A2-2026-10-12.md (PA-54, PA-55, PA-56); реестр VERIFY-CHECKLIST-registry-90.md.
'use strict';

const path = require('node:path');
const REPO = process.argv[2] || path.resolve(__dirname, '..', '..', '..', '..');
const core = require(path.join(REPO, 'packages', 'core', 'index.js'));

const results = [];
function report(id, title, verdict, evidence) {
  results.push({ id, verdict });
  console.log(`\n=== ${id}: ${title} ===\nВЕРДИКТ: ${verdict}\n${evidence}`);
}
const noop = () => {};

/* ---------- PA-54: public/form-политики обходят токен защищённой default-песочницы ---------- */
{
  const rt = core.createSandboxRuntime({
    state: { payments: { p1: { secret: 'DEFAULT-SECRET' } } },
    initialStateFactory: () => ({ payments: {} }),
    mode: 'owned',
    defaultOwnerToken: 'default-owner-secret',
    operatorTokens: ['op-secret'],
    log: noop,
  });
  rt.create({ id: 'tenant-b' });

  // (a) form-политика без токена на защищённой default
  const formA = rt.admit({ headers: {}, url: '/payment/1' }, 'form');
  let leak = '';
  if (formA.ok) {
    try {
      rt.run(formA, () => { leak = JSON.stringify(rt.state.payments); });
    } catch (e) { leak = `run() отклонён: ${e.code || e.message}`; }
  }
  const formBypass = formA.ok;
  const formLeak = leak.includes('DEFAULT-SECRET');

  // (b) public-политика на непубличном пути без токена
  const pubBypass = rt.admit({ headers: {}, url: '/not-public' }, 'public').ok;

  // (c) public /health: изоляция state (пустая копия вместо защищённой default)
  const pubHealth = rt.admit({ headers: {}, url: '/health' }, 'public');
  let healthSees = 'n/a (admit отклонён)';
  if (pubHealth.ok) {
    try { rt.run(pubHealth, () => { healthSees = JSON.stringify(rt.state.payments); }); }
    catch (e) { healthSees = `run() отклонён: ${e.code || e.message}`; }
  }
  const healthLeak = healthSees.includes('DEFAULT-SECRET');

  const anyDefect = formBypass || pubBypass || healthLeak || formLeak;
  report('PA-54', 'public/form-политики обходят токен защищённой default-песочницы (байпас admit)',
    anyDefect ? 'ДЕФЕКТ ВОСПРОИЗВЕДЁН (до фикса)' : 'ЗАКРЫТО (fail-closed, байпаса нет)',
    `form-адмит без токена: ${formBypass ? 'ПРОПУЩЕНО' : 'отклонено'}; leak state через form: ${formLeak}; ` +
    `public на непубличном пути: ${pubBypass ? 'ПРОПУЩЕНО' : 'отклонено'}; ` +
    `public /health видит state default: ${healthLeak} (видит: ${healthSees.slice(0, 80)})`);
}

/* ---------- PA-55: switchActive в namespaces переключает глобальный fallback ---------- */
{
  const rt = core.createSandboxRuntime({
    state: { payments: {} },
    initialStateFactory: () => ({ payments: {} }),
    mode: 'namespaces',
    log: noop,
  });
  const sw = rt.switchActive('ci-worker-b');
  const activeAfter = rt.activeId();
  const noSel = rt.admit({ headers: {}, url: '/v2/Init' }, 'business');
  const noSelId = noSel.ok ? noSel.record.id : `отклонено (${noSel.kind || '?'})`;
  const globalSwitch = activeAfter !== 'default' || (noSel.ok && noSel.record.id !== 'default');
  report('PA-55', 'switchActive в namespaces переключает глобальный fallback для чужих запросов',
    globalSwitch ? 'ДЕФЕКТ ВОСПРОИЗВЕДЁН (до фикса)' : 'ЗАКРЫТО (fallback остаётся default)',
    `switchActive('ci-worker-b')=${sw && sw.ok ? 'ok' : JSON.stringify(sw)}; activeId() после = ${activeAfter}; ` +
    `запрос без селектора идёт в: ${noSelId} (ожидалось после фикса: default)`);
}

/* ---------- PA-56: run() выполняет обработчик при неуспешном admission ---------- */
{
  const rt = core.createSandboxRuntime({
    state: { payments: {} },
    initialStateFactory: () => ({ payments: {} }),
    mode: 'owned',
    log: noop,
  });
  const bad = rt.admit({ headers: { 'x-mock-sandbox': 'missing' }, url: '/v2/Init' }, 'business');
  let executed = false;
  let refused = '';
  try {
    rt.run(bad, () => { executed = true; });
    if (!executed) refused = 'run() вернулся без выполнения обработчика';
  } catch (e) {
    refused = `run() отказал: ${e.code || e.message}`;
  }
  let nullHandling = '';
  try {
    rt.run(null, () => { executed = true; });
  } catch (e) {
    nullHandling = `run(null) отказал: ${e.code || e.message}`;
  }
  report('PA-56', 'run() выполняет обработчик при неуспешном admission (fail-open)',
    executed ? 'ДЕФЕКТ ВОСПРОИЗВЕДЁН (до фикса)' : 'ЗАКРЫТО (fail-closed SANDBOX_ADMISSION_FAILED)',
    `admission ok=${bad.ok}; обработчик выполнен: ${executed}; ${refused}; ${nullHandling}`);
}

/* ---------- Сводка ---------- */
console.log('\n===== СВОДКА (sz-wave50-pa54-56) =====');
for (const r of results) console.log(`[${r.verdict.startsWith('ЗАКРЫТО') ? '-' : '+'}] ${r.id}: ${r.verdict}`);
console.log(`Ревизия пробы: ${REPO}`);
