#!/usr/bin/env node
/* © 2026 ООО «Аксиома» ИНН:7842223709 · Apache-2.0
 * SZ проба PD-02 (PR #105, ревизия 01254d7): байтовая квота env песочниц
 * (MOCK_SANDBOX_MAX_STATE_BYTES) + глобальный бюджет состояния
 * (MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES). Пробный проход по сигналу координатора (#62).
 * Zero-dep, Node >= 18.
 *
 * Чек-лист сигнала:
 *   - env-квоты (пусто/число/0/мусор, точная граница)
 *   - глобальный бюджет (сумма default+A+B, отказ на записи и импорте, откат,
 *     освобождение после remove/reset/TTL, кэш размеров)
 *   - независимость квот; восстановленный default не теряет данные
 *   - hosted/owned + namespaces
 *
 * Зафиксированные в этой пробе факты поведения (01254d7):
 *   [Ф-1] ДЕФЕКТ: tbank, per-sandbox pre-check при used>=limit на инлайн-маршрутах
 *         (/av/v1/payment, /av/v1/verification) — ответ НЕ отправляется (клиент
 *         висит до таймаута), сервер молчит: `if (quotaX) return quotaX;` возвращает
 *         err-объект в route().catch, где он отбрасывается. Паттерн пришёл с
 *         e8d9f93 (#72) — латентный дефект, не регресс #105. Хелпер-маршруты
 *         (/v2/*) отвечают provider-shaped err(7) HTTP 200.
 *   [Ф-2] Per-sandbox квота на бизнес-записи: pre-check (used>=limit) + мягкое
 *         пересечение (запись, впервые превышающая лимит, принимается); строгая
 *         проверка persistRecord(rec, true, true) — только на импорте /mock/state.
 *   [Ф-3] Импорт = восстановление снимка (mergeValidatedInto удаляет ключи,
 *         отсутствующие в снимке); откат при отказе — к последнему принятому JSON.
 *
 * Запуск: node sz-wave105-pd02-state-bytes.js (из корня клона на 01254d7).
 */

'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ROOT: каталог, в котором лежит services/ (подъём вверх от __dirname) */
function findRoot() {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, 'services', 'tbank-mock', 'server.js'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('не нашёл корень клона mock-services (services/tbank-mock/server.js)');
}
const ROOT = findRoot();

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(title) { console.log(`\n== ${title}`); }

function request(port, method, urlPath, body, headers = {}, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: {
        ...(data !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT', body: '' }); });
    req.on('error', (e) => resolve({ status: `ERR:${e.code}`, body: '' }));
    if (data !== null) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- дочерние стенды (как в selftest tbank: MOCK_PORT=0, порт из стартовой строки) */
function startChild(serviceRel, extraEnv = {}) {
  const childEnv = {
    ...process.env,
    MOCK_HOST: '127.0.0.1',
    MOCK_PORT: '0',
    MOCK_STATE_FILE: '',
    MOCK_RETRY_MS: '1000',
    MOCK_PROFILE: 'plain',
    MOCK_ADMIN_TOKEN: '',
    MOCK_OPERATOR_TOKEN: '',
    MOCK_HOSTED: '',
    MOCK_TENANCY: 'namespaces',
    MOCK_STRICT_TOKEN: 'false',
    MOCK_SANDBOX_FILE: '',
    MOCK_SANDBOX_TOKEN: '',
    MOCK_SANDBOX_TTL_MS: '',
    MOCK_SANDBOX_SWEEP_MS: '',
    MOCK_SANDBOX_MAX: '',
    MOCK_SANDBOX_MAX_DOCUMENTS: '',
    MOCK_SANDBOX_MAX_STATE_BYTES: '',
    MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES: '',
    MOCK_SANDBOX_RETENTION_MS: '',
    MOCK_SANDBOX_HOST_SUFFIX: '',
    MOCK_SANDBOX_CREATE_LIMIT: '',
    ...extraEnv,
  };
  const proc = spawn('node', ['--max-old-space-size=48', path.join(ROOT, serviceRel)], {
    cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  proc.stdout.on('data', (d) => { buf += String(d); });
  proc.stderr.on('data', (d) => { buf += String(d); });
  const port = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${serviceRel}: порт не получен: ${buf.slice(0, 300)}`)), 7000);
    proc.stdout.on('data', () => {
      const m = /on http:\/\/[^:]+:(\d+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${serviceRel} завершился с кодом ${code}`)); });
  });
  return { proc, port, output: () => buf, kill: () => { try { proc.kill('SIGKILL'); } catch { /* уже мёртв */ } } };
}

async function stopChild(child) {
  if (!child || child.proc.exitCode !== null || child.proc.signalCode !== null) return;
  await new Promise((resolve) => {
    child.proc.once('exit', resolve);
    try { child.proc.kill('SIGKILL'); } catch { resolve(); }
  });
}

/* ---- учёт байт реального состояния
 * tbank: GET /mock/state → {sandbox, state:{ok,sandbox,exportedAt,state}} (двойная обёртка)
 * first-ofd: GET /mock/state → {sandbox, state} (одноуровневая)
 */
function realState(respBody, unwrap) { return unwrap ? JSON.parse(respBody).state : JSON.parse(respBody).state.state; }
function realBytes(respBody, unwrap) { return Buffer.byteLength(JSON.stringify(realState(respBody, unwrap))); }
/* pad длины n, добавленный в НЕпустой снимок, добавляет ровно n байт:
 * bytes({…snap, pad:'x'.repeat(n)}) = bytes({…snap, pad:''}) + n */
function padFor(snap, targetBytes) {
  const withEmpty = Buffer.byteLength(JSON.stringify({ ...snap, pad: '' }));
  return targetBytes - withEmpty;
}

/* бинпоиск max pad: полный снимок {…snap0, pad} принимается сервером */
async function maxPad(port, snap0, { sandbox = '', unwrap = false, headers = {} } = {}) {
  let lo = 0; let hi = 1 << 20; let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const body = { state: { ...snap0, pad: 'x'.repeat(mid) } };
    if (sandbox) body.sandbox = sandbox;
    const r = await request(port, 'POST', '/mock/state', body, headers);
    if (r.status === 200) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

async function withTbank(env, fn) {
  const child = startChild('services/tbank-mock/server.js', env);
  try {
    const port = await child.port;
    await request(port, 'GET', '/health');
    return await fn(port, child);
  } finally { await stopChild(child); }
}

/* ============================================================ legs */

async function leg1_envMatrix() {
  section('L1. env-матрица per-sandbox квоты (глобальный 0) — импорт ~100 КиБ');
  const big = 100 * 1024;
  const variants = [
    { name: "MAX='' (пусто → дефолт; tbank maxDocuments=0 → без лимита)", val: '' },
    { name: "MAX='мусор' (нечисло → безопасный дефолт)", val: 'мусор' },
    { name: "MAX='0' (квота выключена)", val: '0' },
    { name: "MAX='-5' (отрицательное → 0 → выключено)", val: '-5' },
  ];
  for (const v of variants) {
    await withTbank({ MOCK_SANDBOX_MAX_STATE_BYTES: v.val, MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES: '0' }, async (port) => {
      const g = await request(port, 'GET', '/mock/state');
      const snap0 = realState(g.body, false);
      const r = await request(port, 'POST', '/mock/state', { state: { ...snap0, pad: 'x'.repeat(big) } });
      check(`L1 ${v.name}: импорт 100 КиБ проходит`, r.status === 200, `HTTP ${r.status}`);
    });
  }
}

async function leg2_exactBoundary() {
  section('L2. Точная граница per-sandbox: MAX=2048, GBL=0');
  await withTbank({ MOCK_SANDBOX_MAX_STATE_BYTES: '2048', MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES: '0' }, async (port) => {
    const g = await request(port, 'GET', '/mock/state');
    const snap0 = realState(g.body, false);
    const pad = await maxPad(port, snap0);
    const g1 = await request(port, 'GET', '/mock/state');
    const used = realBytes(g1.body, false);
    check('L2.1 used==limit проходит (ровно 2048)', pad >= 0 && used === 2048, `pad=${pad}, used=${used}`);

    const over = await request(port, 'POST', '/mock/state', { state: { ...snap0, pad: 'x'.repeat(pad + 1) } });
    let body = {};
    try { body = JSON.parse(over.body); } catch { /* пусто */ }
    check('L2.2 used==limit+1 → HTTP 400', over.status === 400, `HTTP ${over.status}`);
    check('L2.3 код sandbox_state_quota_exceeded + errorCode 400 + kind=bytes',
      body.code === 'sandbox_state_quota_exceeded' && body.errorCode === 400 && body.kind === 'bytes',
      `code=${body.code}`);
    check('L2.4 used==2049, limit==2048, sandbox=default в отказе',
      body.used === 2049 && body.limit === 2048 && body.sandbox === 'default',
      `used=${body.used}, limit=${body.limit}, sandbox=${body.sandbox}`);

    const g2 = await request(port, 'GET', '/mock/state');
    const st = realState(g2.body, false);
    check('L2.5 полный откат: состояние == последний принятый (pad не применён)',
      realBytes(g2.body, false) === used && (st.pad || '').length === pad,
      `bytes=${realBytes(g2.body, false)}, pad=${(st.pad || '').length}`);

    const again = await request(port, 'POST', '/mock/state', { state: { ...snap0, pad: 'x'.repeat(pad) } });
    check('L2.6 кэш размера: сразу после отката корректный импорт проходит', again.status === 200, `HTTP ${again.status}`);
  });
}

async function leg3_globalBudget() {
  section('L3. Глобальный бюджет: MAX=0, GBL=60000 — сумма default+A+B');
  await withTbank({ MOCK_SANDBOX_MAX_STATE_BYTES: '0', MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES: '60000' }, async (port) => {
    const g = await request(port, 'GET', '/mock/state');
    const snap0 = realState(g.body, false);
    /* default: заполняем ровно до 25000 */
    const padD = padFor(snap0, 25000);
    const fillD = await request(port, 'POST', '/mock/state', { state: { ...snap0, pad: 'x'.repeat(padD) } });
    const dBytes = realBytes((await request(port, 'GET', '/mock/state')).body, false);
    check('L3.1 default заполнен ровно до 25000', fillD.status === 200 && dBytes === 25000, `HTTP ${fillD.status}, used=${dBytes}`);

    /* A: создана явно (quotaSnapshot=factory), заполнена ровно до 20000 */
    await request(port, 'POST', '/sandboxes', { sandbox: 'budget-a' });
    const ga = await request(port, 'GET', '/mock/state?sandbox=budget-a');
    const snapA = realState(ga.body, false);
    const padA = padFor(snapA, 20000);
    const fillA = await request(port, 'POST', '/mock/state', { sandbox: 'budget-a', state: { ...snapA, pad: 'x'.repeat(padA) } });
    check('L3.2 A заполнена ровно до 20000 (сумма 45000 < 60000)', fillA.status === 200, `HTTP ${fillA.status}`);

    /* B: импорт, переваливающий сумму через 60000 */
    await request(port, 'POST', '/sandboxes', { sandbox: 'budget-b' });
    const gb = await request(port, 'GET', '/mock/state?sandbox=budget-b');
    const snapB = realState(gb.body, false);
    const padB = padFor(snapB, 20000); /* сумма ровно 65000 > 60000 */
    const over = await request(port, 'POST', '/mock/state', { sandbox: 'budget-b', state: { ...snapB, pad: 'x'.repeat(padB) } });
    let body = {};
    try { body = JSON.parse(over.body); } catch { /* пусто */ }
    const usedExpected = 25000 + 20000 + 20000;
    check('L3.3 сумма > GBL → HTTP 400 sandbox_state_budget_exceeded',
      over.status === 400 && body.code === 'sandbox_state_budget_exceeded' && body.kind === 'bytes',
      `HTTP ${over.status}, code=${body.code}`);
    check('L3.4 used == точная сумма (default+A+B-кандидат), limit == 60000',
      body.used === usedExpected && body.limit === 60000,
      `used=${body.used} (ожидали ${usedExpected}), limit=${body.limit}`);

    const gb2 = await request(port, 'GET', '/mock/state?sandbox=budget-b');
    const stB = realState(gb2.body, false);
    check('L3.5 B: частичного применения нет (pad отсутствует)',
      (stB.pad || '').length === 0, `pad len=${(stB.pad || '').length}`);
    const dAfter = realBytes((await request(port, 'GET', '/mock/state')).body, false);
    check('L3.6 default не тронут', dAfter === 25000, `bytes=${dAfter}`);
  });
}

async function leg4_businessWrites() {
  section('L4. Бизнес-записи tbank (MAX=2048, GBL=0): pre-check и persist');
  await withTbank({ MOCK_SANDBOX_MAX_STATE_BYTES: '2048', MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES: '0' }, async (port) => {
    const g = await request(port, 'GET', '/mock/state');
    const snap0 = realState(g.body, false);
    const pad = await maxPad(port, snap0); /* used == 2048 */

    /* 4.1 хелпер-маршрут: provider-shaped отказ */
    const h = await request(port, 'POST', '/v2/Init', { TerminalKey: 'TBANKMOCKTEST', Amount: 10000, OrderId: 'o1' });
    let hb = {};
    try { hb = JSON.parse(h.body); } catch { /* пусто */ }
    check('L4.1 /v2/Init @ used==limit → HTTP 200 + ErrorCode 7 (provider-shaped), used/limit в сообщении',
      h.status === 200 && String(hb.ErrorCode) === '7' && /байт: 2048\/2048/.test(hb.Message || ''),
      `HTTP ${h.status}, ErrorCode=${hb.ErrorCode}, msg=${(hb.Message || '').slice(0, 60)}`);

    /* 4.2/4.3 инлайн-маршруты: [Ф-1] ответ не отправляется */
    const payT0 = Date.now();
    const pay = await request(port, 'POST', '/av/v1/payment', { VerificationCode: '1', Amount: '100', PayerInn: '7800000000' }, {}, 3500);
    check('L4.2 [Ф-1 ДЕФЕКТ] /av/v1/payment @ used==limit → ответ НЕ отправляется (TIMEOUT), сервер молчит',
      pay.status === 'TIMEOUT' && Date.now() - payT0 >= 3400, `${pay.status} за ${Date.now() - payT0}мс`);
    const ver = await request(port, 'POST', '/av/v1/verification', { VerificationCode: '1', Amount: '100', PayerInn: '7800000000' }, {}, 3500);
    check('L4.3 [Ф-1 ДЕФЕКТ] /av/v1/verification @ used==limit → TIMEOUT (второй инлайн-сайт)',
      ver.status === 'TIMEOUT', `${ver.status}`);

    /* 4.4 мягкое пересечение лимита бизнес-записью [Ф-2] */
    const g2 = await request(port, 'GET', '/mock/state');
    const used2 = realBytes(g2.body, false);
    const under = await request(port, 'POST', '/mock/state', { state: { ...realState(g2.body, false), pad: 'x'.repeat(pad - 1) } });
    const used3 = realBytes((await request(port, 'GET', '/mock/state')).body, false);
    check('L4.4 подготовка: used == limit-1', under.status === 200 && used3 === 2047, `HTTP ${under.status}, used=${used3} (было ${used2})`);
    const cross = await request(port, 'POST', '/av/v1/payment', { VerificationCode: '2', Amount: '100', PayerInn: '7800000000' });
    const used4 = realBytes((await request(port, 'GET', '/mock/state')).body, false);
    check('L4.5 [Ф-2 НАБЛЮДЕНИЕ] запись, ПЕРЕСЕКАЮЩАЯ per-sandbox лимит, принимается (persist без verifyPerSandbox)',
      cross.status === 200 && used4 > 2048 && /"Success":true/.test(cross.body),
      `HTTP ${cross.status}, used после записи=${used4} > 2048`);

    /* 4.6 после пересечения следующая запись упирается в pre-check → снова [Ф-1] */
    const next = await request(port, 'POST', '/av/v1/payment', { VerificationCode: '3', Amount: '100', PayerInn: '7800000000' }, {}, 3500);
    check('L4.6 следующая запись @ used>limit → pre-check → снова молчание [Ф-1]', next.status === 'TIMEOUT', `${next.status}`);
  });

  section('L4b. Глобальный бюджет на бизнес-записи (MAX=0, GBL=60000)');
  await withTbank({ MOCK_SANDBOX_MAX_STATE_BYTES: '0', MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES: '60000' }, async (port) => {
    const g = await request(port, 'GET', '/mock/state');
    const snap0 = realState(g.body, false);
    const pad = await maxPad(port, snap0); /* used == 60000 ровно */
    const used = realBytes((await request(port, 'GET', '/mock/state')).body, false);
    check('L4b.1 default заполнен ровно до бюджета (импорт при used==limit проходит)', used === 60000, `pad=${pad}, used=${used}`);
    const pay = await request(port, 'POST', '/av/v1/payment', { VerificationCode: '4', Amount: '100', PayerInn: '7800000000' });
    let pb = {};
    try { pb = JSON.parse(pay.body); } catch { /* пусто */ }
    check('L4b.2 запись сверх глобального бюджета → HTTP 400 sandbox_state_budget_exceeded (throw в pre-check ДО мутации)',
      pay.status === 400 && pb.code === 'sandbox_state_budget_exceeded',
      `HTTP ${pay.status}, code=${pb.code}, used=${pb.used}, limit=${pb.limit}`);
    const st = realState((await request(port, 'GET', '/mock/state')).body, false);
    check('L4b.3 мутации нет: incoming пуст', Object.keys(st.incoming || {}).length === 0,
      `incoming=${Object.keys(st.incoming || {}).length}`);
  });
}

async function leg5_release() {
  section('L5. Освобождение глобального бюджета: MAX=0, GBL=60000, TTL=5000мс');
  await withTbank({
    MOCK_SANDBOX_MAX_STATE_BYTES: '0', MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES: '60000', MOCK_SANDBOX_TTL_MS: '5000',
  }, async (port) => {
    const g = await request(port, 'GET', '/mock/state');
    const snap0 = realState(g.body, false);
    const padD = padFor(snap0, 20000);
    await request(port, 'POST', '/mock/state', { state: { ...snap0, pad: 'x'.repeat(padD) } });

    /* A: ровно 35000; B-кандидат 10000 → сумма ~65000 > 60000 → отказ */
    await request(port, 'POST', '/sandboxes', { sandbox: 'rel-a' });
    const ga = await request(port, 'GET', '/mock/state?sandbox=rel-a');
    const snapA = realState(ga.body, false);
    const padA = padFor(snapA, 35000);
    await request(port, 'POST', '/mock/state', { sandbox: 'rel-a', state: { ...snapA, pad: 'x'.repeat(padA) } });
    await request(port, 'POST', '/sandboxes', { sandbox: 'rel-b' });
    const gb = await request(port, 'GET', '/mock/state?sandbox=rel-b');
    const snapB = realState(gb.body, false);
    const padB = padFor(snapB, 10000);
    const denied = await request(port, 'POST', '/mock/state', { sandbox: 'rel-b', state: { ...snapB, pad: 'x'.repeat(padB) } });
    check('L5.1 бюджет исчерпан: импорт в B → 400 sandbox_state_budget_exceeded',
      denied.status === 400 && JSON.parse(denied.body).code === 'sandbox_state_budget_exceeded', `HTTP ${denied.status}`);

    /* 5.2 освобождение remove */
    const del = await request(port, 'DELETE', '/sandboxes?sandbox=rel-a');
    check('L5.2a DELETE /sandboxes?sandbox=rel-a → ок', del.status === 200 && /removed/.test(del.body), `HTTP ${del.status}`);
    const gb1b = await request(port, 'GET', '/mock/state?sandbox=rel-b');
    const snapB1 = realState(gb1b.body, false);
    const afterDel = await request(port, 'POST', '/mock/state', { sandbox: 'rel-b', state: { ...snapB1, pad: 'x'.repeat(padB) } });
    check('L5.2b после remove бюджет освобождён: тот же импорт в B проходит', afterDel.status === 200, `HTTP ${afterDel.status}`);

    /* 5.3 освобождение reset: B до исчерпания через бинпоиск (сумма == 60000 ровно), +1 → отказ */
    const gb2 = await request(port, 'GET', '/mock/state?sandbox=rel-b');
    const snapB2 = realState(gb2.body, false);
    const padMax = await maxPad(port, snapB2, { sandbox: 'rel-b' });
    const gb2b = await request(port, 'GET', '/mock/state?sandbox=rel-b');
    const usedMax = realBytes(gb2b.body, false);
    check('L5.3a бинпоиск дошёл до исчерпания: used+factory прочих == 60000', usedMax + 20000 === 60000, `B used=${usedMax}`);
    const block2 = await request(port, 'POST', '/mock/state', { sandbox: 'rel-b', state: { ...snapB2, pad: 'x'.repeat(padMax + 1) } });
    check('L5.3b исчерпан: +1 байт → 400 sandbox_state_budget_exceeded',
      block2.status === 400 && JSON.parse(block2.body).code === 'sandbox_state_budget_exceeded', `HTTP ${block2.status}`);
    const reset = await request(port, 'POST', '/mock/reset', { sandbox: 'rel-b' });
    check('L5.3c POST /mock/reset {sandbox} → ок', reset.status === 200, `HTTP ${reset.status}`);
    const gb3 = await request(port, 'GET', '/mock/state?sandbox=rel-b');
    const snapB3 = realState(gb3.body, false);
    /* бинпоиск заново: padMax был калиброван под другой снимок (seed-дрейф factory ±1 байт) */
    const pad3 = await maxPad(port, snapB3, { sandbox: 'rel-b' });
    const gb3b = await request(port, 'GET', '/mock/state?sandbox=rel-b');
    const usedB3 = realBytes(gb3b.body, false);
    check('L5.3d после reset бюджет освобождён: B снова до исчерпания (сумма == 60000)',
      pad3 >= 0 && usedB3 + 20000 === 60000, `HTTP-импорт ok, B used=${usedB3}`);
    /* возвращаем B к фактическому max-размеру минус запас — замеряем факт */
    await request(port, 'POST', '/mock/state', { sandbox: 'rel-b', state: { ...snapB3, pad: 'x'.repeat(padB) } });
    const usedB = realBytes((await request(port, 'GET', '/mock/state?sandbox=rel-b')).body, false);

    /* 5.4 освобождение TTL: T исчерпывает бюджет (бинпоиск), затем выселяется по TTL */
    await request(port, 'POST', '/sandboxes', { sandbox: 'rel-t' });
    const gt = await request(port, 'GET', '/mock/state?sandbox=rel-t');
    const snapT = realState(gt.body, false);
    const padT = await maxPad(port, snapT, { sandbox: 'rel-t' });
    const gt2 = await request(port, 'GET', '/mock/state?sandbox=rel-t');
    const usedT = realBytes(gt2.body, false);
    check('L5.4a T исчерпала бюджет: used default+B+T == 60000 ровно', usedT + 20000 + usedB === 60000, `T used=${usedT}, B used=${usedB}`);
    const tOver = await request(port, 'POST', '/mock/state', { sandbox: 'rel-t', state: { ...snapT, pad: 'x'.repeat(padT + 1) } });
    check('L5.4b +1 байт → 400 (бюджет впритык)', tOver.status === 400, `HTTP ${tOver.status}`);
    await sleep(5400); /* TTL 5000мс истёк */
    const exp = await request(port, 'GET', '/mock/state?sandbox=rel-t');
    check('L5.4c доступ к истёкшей T → выселение (4xx)', exp.status >= 400 && exp.status < 500, `HTTP ${exp.status}`);
    await request(port, 'POST', '/sandboxes', { sandbox: 'rel-f' });
    const gf = await request(port, 'GET', '/mock/state?sandbox=rel-f');
    const snapF = realState(gf.body, false);
    const freedT = await request(port, 'POST', '/mock/state', { sandbox: 'rel-f', state: { ...snapF, pad: 'x'.repeat(Math.max(padT - 1, 0)) } });
    check('L5.4d после TTL-выселения бюджет освобождён: размер T (−1 байт на seed-дрейф) проходит в F', freedT.status === 200, `HTTP ${freedT.status}`);
    void snap0; void g; void padD;
  });
}

async function leg6_restoreDefault() {
  section('L6. Восстановленный default не теряет данные (MOCK_STATE_FILE + рестарт)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sz-pd02-'));
  const stateFile = path.join(dir, 'state.json');
  {
    const child = startChild('services/tbank-mock/server.js', {
      MOCK_STATE_FILE: stateFile,
      MOCK_SANDBOX_MAX_STATE_BYTES: '8192', MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES: '0',
    });
    try {
      const port = await child.port;
      const g = await request(port, 'GET', '/mock/state');
      const snap0 = realState(g.body, false);
      const withMarker = { ...snap0, marker: 'sz-wave105', pad: '' };
      const padL6 = 4000 - Buffer.byteLength(JSON.stringify(withMarker));
      const fill = await request(port, 'POST', '/mock/state', { state: { ...snap0, marker: 'sz-wave105', pad: 'x'.repeat(padL6) } });
      check('L6.1 default заполнен маркером + pad ровно до 4000 (лимит 8192)', fill.status === 200, `HTTP ${fill.status}, pad=${padL6}`);
      await sleep(600); /* flush 150мс + запас */
      const saved = fs.existsSync(stateFile);
      check('L6.2 файл состояния записан', saved, stateFile);
    } finally { await stopChild(child); }
  }
  {
    const child = startChild('services/tbank-mock/server.js', {
      MOCK_STATE_FILE: stateFile,
      MOCK_SANDBOX_MAX_STATE_BYTES: '8192', MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES: '0',
    });
    try {
      const port = await child.port;
      const g = await request(port, 'GET', '/mock/state');
      const st = realState(g.body, false);
      check('L6.3 после рестарта default восстановлен с маркером', st.marker === 'sz-wave105', `marker=${st.marker}`);
      check('L6.4 байты восстановленного состояния сохранены', realBytes(g.body, false) === 4000, `bytes=${realBytes(g.body, false)}`);
      const over = await request(port, 'POST', '/mock/state', { state: { ...st, pad: 'x'.repeat(9000) } });
      check('L6.5 сверхлимитный импорт → 400 sandbox_state_quota_exceeded',
        over.status === 400 && JSON.parse(over.body).code === 'sandbox_state_quota_exceeded', `HTTP ${over.status}`);
      const g2 = await request(port, 'GET', '/mock/state');
      check('L6.6 откат к ВОССТАНОВЛЕННОМУ состоянию (маркер жив, не {})',
        realState(g2.body, false).marker === 'sz-wave105' && realBytes(g2.body, false) === 4000,
        `marker=${realState(g2.body, false).marker}, bytes=${realBytes(g2.body, false)}`);
    } finally { await stopChild(child); fs.rmSync(dir, { recursive: true, force: true }); }
  }
}

async function leg7_owned() {
  section('L7. Owned/hosted (first-ofd, MOCK_HOSTED=1): MAX=4096, GBL=0');
  const child = startChild('services/first-ofd-mock/server.js', {
    MOCK_HOSTED: '1', MOCK_TENANCY: '', MOCK_PROFILE: '',
    MOCK_SANDBOX_MAX_STATE_BYTES: '4096', MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES: '0',
  });
  try {
    const port = await child.port;
    await request(port, 'GET', '/healthz');
    const create = await request(port, 'POST', '/sandboxes', {});
    let created = {};
    try { created = JSON.parse(create.body); } catch { /* пусто */ }
    check('L7.1 POST /sandboxes (owned) → 201 + id + ownerToken',
      create.status === 201 && created.id && created.ownerToken,
      `HTTP ${create.status}, id=${created.id}`);
    const headers = { 'X-Sandbox-Token': created.ownerToken };
    const g = await request(port, 'GET', `/mock/state?sandbox=${encodeURIComponent(created.id)}`, undefined, headers);
    const snap0 = realState(g.body, true); /* first-ofd: одноуровневая обёртка */
    const base = realBytes(g.body, true);
    const pad = await maxPad(port, snap0, { sandbox: created.id, unwrap: true, headers });
    const used = realBytes((await request(port, 'GET', `/mock/state?sandbox=${encodeURIComponent(created.id)}`, undefined, headers)).body, true);
    check('L7.2 граница per-sandbox в owned: used==4096 проходит', used === 4096, `base=${base}, pad=${pad}, used=${used}`);
    const over = await request(port, 'POST', '/mock/state', { sandbox: created.id, state: { ...snap0, pad: 'x'.repeat(pad + 1) } }, headers);
    let ob = {};
    try { ob = JSON.parse(over.body); } catch { /* пусто */ }
    check('L7.3 +1 байт → 400 sandbox_state_quota_exceeded',
      over.status === 400 && ob.code === 'sandbox_state_quota_exceeded' && ob.used === 4097 && ob.limit === 4096,
      `HTTP ${over.status}, code=${ob.code}, used=${ob.used}, limit=${ob.limit}`);
    /* знание ID без токена — доступ по-прежнему закрыт */
    const anon = await request(port, 'POST', '/mock/state', { sandbox: created.id, state: { ...snap0, pad: 'x'.repeat(Math.max(pad, 0)) } });
    check('L7.4 знание ID без owner-токена → 401 (квота не открывает доступ)', anon.status === 401, `HTTP ${anon.status}`);
  } finally { await stopChild(child); }
}

async function leg8_independence() {
  section('L8. Независимость квот: MAX=2048, GBL=0');
  await withTbank({ MOCK_SANDBOX_MAX_STATE_BYTES: '2048', MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES: '0' }, async (port) => {
    /* A: до границы */
    await request(port, 'POST', '/sandboxes', { sandbox: 'quota-a' });
    const ga = await request(port, 'GET', '/mock/state?sandbox=quota-a');
    const snapA = realState(ga.body, false);
    const padA = await maxPad(port, snapA, { sandbox: 'quota-a' });
    const overA = await request(port, 'POST', '/mock/state', { sandbox: 'quota-a', state: { ...snapA, pad: 'x'.repeat(padA + 1) } });
    check('L8.1 A ограничена: +1 байт → 400 sandbox_state_quota_exceeded',
      overA.status === 400 && JSON.parse(overA.body).code === 'sandbox_state_quota_exceeded', `HTTP ${overA.status}`);
    /* B: квоты независимы — B независимо достигает СВОЕЙ границы (2048) */
    await request(port, 'POST', '/sandboxes', { sandbox: 'quota-b' });
    const gbb = await request(port, 'GET', '/mock/state?sandbox=quota-b');
    const snapB = realState(gbb.body, false);
    const padB = await maxPad(port, snapB, { sandbox: 'quota-b' });
    const usedB = realBytes((await request(port, 'GET', '/mock/state?sandbox=quota-b')).body, false);
    check('L8.2 B независимо достигает своей границы (2048), квота A не мешает', usedB === 2048, `pad=${padB}, used=${usedB}`);
    /* default тоже независим */
    const gd = await request(port, 'GET', '/mock/state');
    const snapD = realState(gd.body, false);
    const padD = await maxPad(port, snapD);
    const usedD = realBytes((await request(port, 'GET', '/mock/state')).body, false);
    check('L8.3 default независимо достигает своей границы (2048)', usedD === 2048, `pad=${padD}, used=${usedD}`);
  });
}

/* ============================================================ main */

async function main() {
  console.log('SZ проба PD-02 (01254d7): байтовые квоты песочниц + глобальный бюджет');
  console.log(`ROOT: ${ROOT}`);
  await leg1_envMatrix();
  await leg2_exactBoundary();
  await leg3_globalBudget();
  await leg4_businessWrites();
  await leg5_release();
  await leg6_restoreDefault();
  await leg7_owned();
  await leg8_independence();
  console.log(`\nИТОГ: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('PROBE CRASH:', e.message);
  process.exit(2);
});
