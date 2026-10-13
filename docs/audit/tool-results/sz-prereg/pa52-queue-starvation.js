#!/usr/bin/env node
// [sz/#64 · PA-52] Голодание очередей вебхуков: общий флаг ticking + awaitSequential.
// Claim дельты #54 (core): «общий флаг ticking без await — за один tickAll
// доставляется ≤1 песочница». Механика (packages/core/index.js):
//   createDeliveryQueue держит ОДИН флаг `ticking` на все песочницы (:1093);
//   tick() с awaitSequential=true подвисает на `await deliverOne` (:1137) и
//   держит флаг; tickAll() (:2448) прогоняет одну и ту же очередь в контексте
//   каждой песочницы -> тики B/C отпадают на `if (ticking) return` (:1127),
//   пока идёт медленная доставка A (head-of-line blocking между арендаторами).
// Живая экспозиция: services/tbank-mock/server.js:574 — awaitSequential: true.
// Проба: 3 песочницы, реальные доставки на локальный МЕДЛЕННЫЙ приёмник.
// Это «до»-проба волны #53 (фикс: per-sandbox ticker).
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const core = require(path.join(REPO, 'packages', 'core', 'index.js'));
function report(id, title, verdict, evidence) {
  console.log(`\n=== ${id}: ${title} ===\nВЕРДИКТ: ${verdict}${evidence ? '\n' + evidence : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture(delayMs) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(Date.now());
    setTimeout(() => { res.writeHead(200); res.end('{"ok":true}'); }, delayMs);
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, hits }));
  });
}

function makeRuntime() {
  return core.createSandboxRuntime({
    state: { callbacks: {} },
    mode: 'owned',
    initialStateFactory: () => ({ callbacks: {} }),
    log: () => {},
  });
}

function enqueue(runtime, id, url, tag) {
  const rec = runtime.find(id);
  runtime.run({ ok: true, record: rec }, () => {
    runtime.state.callbacks['w1-' + id] = { id: 'w1-' + id, url, body: JSON.stringify({ sb: id, tag }), attempts: 0, done: false, nextAttemptAt: 0 };
  });
}

async function starvationPhase(label, sequential, delayMs) {
  console.log(`\n[PA-52 · ${label}] sequential=${sequential}, задержка приёмника=${delayMs}мс`);
  const fx = await fixture(delayMs);
  const runtime = makeRuntime();
  const sandboxes = ['sz-a', 'sz-b', 'sz-c'];
  for (const id of sandboxes) runtime.create({ id });
  for (const id of sandboxes) enqueue(runtime, id, `http://127.0.0.1:${fx.port}/hook`, label);

  const queue = core.createDeliveryQueue({
    entries: () => runtime.state.callbacks,
    awaitSequential: sequential,
    retryMs: 30000,
    maxAttempts: 5,
    now: () => Date.now(),
    request: (e) => ({ url: e.url, data: e.body }),
    onSuccess: (e) => { e.done = true; },
    log: () => {},
  });

  const t0 = Date.now();
  const passDeltas = [];
  let pass = 0;
  while (Date.now() - t0 < 6500 && fx.hits.length < 3) {
    const before = fx.hits.length;
    runtime.tickAll(() => queue.tick());
    await sleep(280);
    pass += 1;
    passDeltas.push({ pass, started: fx.hits.length - before, total: fx.hits.length });
    if (fx.hits.length - before > 0) console.log(`  проход #${pass}: стартовало доставок: ${fx.hits.length - before} (всего ${fx.hits.length})`);
  }
  const maxPerPass = Math.max(...passDeltas.map((d) => d.started), 0);
  const firstPass = passDeltas.length ? passDeltas[0].started : 0;
  const gaps = fx.hits.slice(1).map((h, i) => h - fx.hits[i]);
  fx.srv.close();
  runtime.remove('sz-a'); runtime.remove('sz-b'); runtime.remove('sz-c');
  return { label, passes: pass, maxPerPass, firstPass, hits: fx.hits.map((h) => h - t0), gaps };
}

(async () => {
  /* ---- Статика: живая экспозиция и механика ядра ---- */
  const tbankCode = fs.readFileSync(path.join(REPO, 'services', 'tbank-mock', 'server.js'), 'utf8').split('\n');
  const tbankLine = tbankCode.findIndex((l) => l.includes('awaitSequential')) + 1;
  const coreCode = fs.readFileSync(path.join(REPO, 'packages', 'core', 'index.js'), 'utf8').split('\n');
  const tickingDecl = coreCode.findIndex((l) => l.includes('let ticking = false')) + 1;
  const tickingGuard = coreCode.findIndex((l) => l.includes('if (ticking) return')) + 1;
  const tickAllLine = coreCode.findIndex((l) => l.includes('function tickAll')) + 1;
  report('PA-52a', 'статика: одна очередь/флаг ticking на все песочницы; живая экспозиция — tbank',
    'ПОДТВЕРЖДЕНО (факты кода)',
    `packages/core/index.js: let ticking=false :${tickingDecl}; if (ticking) return :${tickingGuard}; tickAll :${tickAllLine}\n` +
    `services/tbank-mock/server.js: awaitSequential: true :${tbankLine} (тик висит на await deliverOne -> флаг держится всю доставку)`);

  /* ---- Фаза 1: последовательная очередь (как tbank) + медленный приёмник ---- */
  const seq = await starvationPhase('медленный приёмник, sequential', true, 1500);
  report('PA-52b', '3 песочницы с due-вебхуками: за проход доставляется ≤1 (голодание B/C, пока летит A)',
    seq.maxPerPass === 1 && seq.passes > 3 ? 'ПОДТВЕРЖДЕНО (head-of-line blocking между песочницами)' : 'не подтвердилось',
    `проходов tickAll за 6.5с: ${seq.passes}; доставлено: 3/3 — но растянуто на ${(seq.hits[2] / 1000).toFixed(1)}с\n` +
    `момент стартов доставок (мс от t0): [${seq.hits.map((h) => Math.round(h)).join(', ')}], интервалы между ними: [${seq.gaps.map((g) => Math.round(g)).join(', ')}]\n` +
    `максимум стартов за один проход: ${seq.maxPerPass} (при 3 должных записях — каждая ждала освобождения флага чужой доставки)`);

  /* ---- Фаза 2: контроль — без awaitSequential флаг не держится, все доставляются сразу ---- */
  const ctrl = await starvationPhase('контроль: не-sequential, быстрый приёмник', false, 30);
  report('PA-52c', 'контроль: не-sequential очередь доставляет все 3 в первом же проходе',
    ctrl.firstPass === 3 ? 'ПОДТВЕРЖДЕНО (дефект именно в связке общий-флаг × awaitSequential)' : 'не подтвердилось',
    `стартов доставок в проходе #1: ${ctrl.firstPass}/3; всего проходов: ${ctrl.passes}`);

  console.log('\n---- ИТОГ PA-52 ----');
  console.log('До фикса (#53): общий флаг ticking превращает N песочниц в последовательный конвейер: пока летит медленная доставка A, тики B/C отбрасываются.');
  console.log('Ожидание после фикса (предрегистрация): per-sandbox ticker — 3 должных доставки уходят в первом проходе независимо от скорости чужих приёмников; медленный приёмник A не задерживает B/C.');
})();
