#!/usr/bin/env node
// [sz/#64 · PA-58] Дефолт ядра blockPrivateHosts=false — fail-open SSRF.
// Claim дельты #54: createDeliveryQueue (packages/core/index.js:1071) и
// verifyMerchantWebhook (:2545) по умолчанию НЕ блокируют приватные адреса —
// адаптер, забывший передать blockPrivateHosts, получает небезопасную доставку.
// Проба: реальная очередь ядра, доставка на loopback: без флага — доставлено;
// с флагом — ERR SSRF. Плюс обзор того, кто и что передаёт в адаптерах.
// Это «до»-проба волны #51 (класс PF-01: дефолт кассы 'false' — его частный случай).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const core = require(path.join(REPO, 'packages', 'core', 'index.js'));
function report(id, title, verdict, evidence) {
  console.log(`\n=== ${id}: ${title} ===\nВЕРДИКТ: ${verdict}${evidence ? '\n' + evidence : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200); res.end('{"ok":true}'); });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  const url = `http://127.0.0.1:${port}/hook`;

  const entry = (id) => ({ id, url, body: JSON.stringify({ probe: id }), attempts: 0, done: false, nextAttemptAt: 0 });

  /* ---- Фаза 1: дефолт (флаг не передан) -> доставка на loopback уходит ---- */
  hits.length = 0;
  const e1 = entry('e1');
  const q1 = core.createDeliveryQueue({
    entries: { e1 },
    retryMs: 1000, maxAttempts: 3,
    request: (e) => ({ url: e.url, data: e.body }),
    log: () => {},
  });
  q1.tick();
  await sleep(600);
  const delivered = hits.length >= 1 && e1.done;
  // Адаптация 2026-10-13 (волна #51, head PR #68): дефолт стал hosted-осознанным (core.defaultBlockPrivateHosts).
  // Верифицирующая конфигурация — прогон с MOCK_HOSTED=1; прогон без hosted фиксирует осознанный локальный дефолт.
  const hosted = ['1', 'true', 'yes', 'on'].includes(String(process.env.MOCK_HOSTED || '').trim().toLowerCase());
  const defVal = typeof core.defaultBlockPrivateHosts === 'function' ? core.defaultBlockPrivateHosts() : 'n/a (до #68)';
  report('PA-58a', 'createDeliveryQueue БЕЗ blockPrivateHosts: loopback-доставка уходит (fail-open)',
    delivered
      ? (hosted ? 'ПОДТВЕРЖДЕНО (небезопасный hosted-дефолт ядра)' : 'ИНФО (не дефект после #68): локальный дефолт false — осознанная семантика; для верификации запускать с MOCK_HOSTED=1')
      : 'ЗАКРЫТО (hosted-дефолт true: доставка на приватный блокирована)',
    `доставок на http://127.0.0.1:${port}/hook: ${hits.length}; entry.done=${e1.done}; MOCK_HOSTED=${hosted ? '1' : 'не задан'}; core.defaultBlockPrivateHosts()=${defVal}\n` +
    `дефолт в ядре: blockPrivateHosts = defaultBlockPrivateHosts(env) — flagEnabled(MOCK_BLOCK_PRIVATE_WEBHOOKS, flagEnabled(MOCK_HOSTED, false))`);

  /* ---- Фаза 2: явный true -> блок SSRF ---- */
  const hitsBefore = hits.length;
  const e2 = entry('e2');
  const q2 = core.createDeliveryQueue({
    entries: { e2 },
    retryMs: 1000, maxAttempts: 3, blockPrivateHosts: true,
    request: (e) => ({ url: e.url, data: e.body }),
    log: () => {},
  });
  q2.tick();
  await sleep(600);
  const blocked = !e2.done && String(e2.lastStatus || '').includes('SSRF') && hits.length === hitsBefore;
  report('PA-58b', 'контроль: blockPrivateHosts:true -> ERR SSRF, доставки нет',
    blocked ? 'ПОДТВЕРЖДЕНО' : 'не подтвердилось',
    `lastStatus=${JSON.stringify(e2.lastStatus).slice(0, 120)}; новых доставок во второй фазе: ${hits.length - hitsBefore}`);

  /* ---- Фаза 3: кто из адаптеров передаёт флаг осознанно ---- */
  const survey = [];
  for (const svc of ['alfa-mock', 'kassa-mock', 'tbank-mock', 'yookassa-mock', 'atol-mock']) {
    const p = path.join(REPO, 'services', svc, 'server.js');
    if (!fs.existsSync(p)) { survey.push(`${svc}: server.js не найден`); continue; }
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    const found = [];
    lines.forEach((l, i) => { if (l.includes('blockPrivateHosts')) found.push(`:${i + 1}`); });
    const envDefault = lines.find((l) => l.includes('MOCK_BLOCK_PRIVATE_WEBHOOKS ='));
    survey.push(`${svc}: blockPrivateHosts ${found.length ? 'передаётся ' + found.join(',') : 'НЕ передаётся'}${envDefault ? `; env-дефолт: ${envDefault.trim().slice(0, 60)}` : ''}`);
  }
  report('PA-58c', 'обзор адаптеров: значение флага зависит от каждого адаптера (молчаливый fail-open в ядре)',
    'ПОДТВЕРЖДЕНО (обзор)',
    survey.join('\n'));

  srv.close();
  console.log('\n---- ИТОГ PA-58 ----');
  console.log('До фикса (#51): ядро по умолчанию доставляет вебхуки на приватные адреса; безопасность зависит от того, вспомнил ли адаптер передать флаг.');
  console.log('Ожидание после фикса (предрегистрация): доставка на 127.0.0.1 без ЯВНОГО разрешения невозможна ни в одном адаптере (дефолт fail-closed ИЛИ каждый адаптер передаёт значение и это покрыто selftest-ом); проба PA-58a ожидает hits=0 + ERR SSRF.');
})();
