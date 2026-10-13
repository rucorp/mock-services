// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Selftest yookassa-mock (issue #33): контракт /v3, идемпотентность,
 * confirmation-страница и тестовые карты, вебхуки (ACK 200, ретраи, дубли,
 * drop), сценарии, виртуальные часы, песочницы, персистентность и
 * control-plane токены. Zero dependencies.
 *
 * Запуск: node services/yookassa-mock/selftest.js
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Заполняются в main() после require('./server.js') (env должен быть до require).
let SHOP_ID = 'YOOKASSAMOCKTEST';
let SECRET_KEY = 'mockpass123';

async function waitForCondition(predicate, { timeoutMs = 8000, intervalMs = 25, description = 'condition', ignoreErrors = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      if (!ignoreErrors) throw error;
      lastError = error;
    }
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); } else { failed += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

/* ------------------------------------------------- приёмник вебхуков */

const RECEIVER_HITS = [];   // {path, event, id, status}
let flakyCount = 0;

const receiver = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    let event = '';
    let id = '';
    try {
      const payload = JSON.parse(buf);
      event = payload.event || '';
      id = (payload.object && payload.object.id) || '';
    } catch { /* не-JSON */ }
    if (req.url === '/flaky') flakyCount += 1;
    const isFail = req.url === '/flaky' && flakyCount === 1;
    RECEIVER_HITS.push({ path: req.url, event, id, status: isFail ? 500 : 200 });
    res.writeHead(isFail ? 500 : 200, { 'Content-Type': 'application/json' });
    res.end(isFail ? '{"error":"first attempt fails"}' : '{"ok":true}');
  });
});

async function listen(srv) {
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}

function request(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: p,
      method,
      headers: {
        ...(data !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: out, json: () => { try { return JSON.parse(out); } catch { return null; } } }));
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

/** Запрос, которому разрешено не получить ответа (сценарий hang). */
function requestHang(port, method, p, body, headers = {}, waitMs = 700) {
  return new Promise((resolve) => {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: p,
      method,
      headers: {
        ...(data !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, () => { /* ответа не ждём */ });
    const timer = setTimeout(() => { req.destroy(); resolve({ timedOut: true }); }, waitMs);
    req.on('error', () => { clearTimeout(timer); resolve({ timedOut: true, connectionError: true }); });
    req.on('close', () => { clearTimeout(timer); resolve({ timedOut: false, closedEarly: true }); });
    if (data !== null) req.write(data);
    req.end();
  });
}

const BASE_AUTH = () => `Basic ${Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString('base64')}`;

let autoKeySeq = 0;
/**
 * API-вызов /v3: Basic + Idempotence-Key по умолчанию (снимаются опциями).
 * Без явного `key` каждый вызов получает уникальный: контракт идемпотентности
 * («тот же ключ = та же операция») означает, что разные тела требуют разных
 * ключей — так поступает честный клиент.
 */
function api(port, method, p, body, { key, auth = true, headers = {} } = {}) {
  const effectiveKey = key === '' ? '' : (key || `st-${Date.now()}-${autoKeySeq += 1}`);
  return request(port, method, p, body, {
    ...(auth ? { Authorization: BASE_AUTH() } : {}),
    ...(effectiveKey ? { 'Idempotence-Key': effectiveKey } : {}),
    ...headers,
  });
}

function providerError(r) {
  const obj = r.json();
  return obj && obj.type === 'error' ? obj : null;
}

/** Каждый отказ — provider-shaped: код, описание, hint, doc (DX-слой). */
function checkProviderError(name, r, { status, code = 'invalid_request', parameter, description } = {}) {
  const e = providerError(r);
  check(`${name}: HTTP ${status} + формат ЮKassa`, r.statusCode === status && !!e && e.code === code,
    `got ${r.statusCode} ${r.body.slice(0, 160)}`);
  if (!e) return;
  if (parameter !== undefined) check(`${name}: parameter=${parameter}`, e.parameter === parameter, `got ${JSON.stringify(e.parameter)}`);
  if (description !== undefined) check(`${name}: description`, e.description === description, `got ${JSON.stringify(e.description)}`);
  check(`${name}: id + DX hint/doc`, Boolean(e.id) && Boolean(e.hint) && Boolean(e.doc && e.doc.includes('yookassa.ru')),
    JSON.stringify({ id: e.id, hint: e.hint, doc: e.doc }).slice(0, 200));
}

const hitsFor = (id, event) => RECEIVER_HITS.filter((h) => h.id === id && (!event || h.event === event));

function startChild(env = {}) {
  const childEnv = {
    ...process.env,
    MOCK_HOST: '127.0.0.1',
    MOCK_PORT: '0',
    MOCK_STATE_FILE: '',
    MOCK_RETRY_MS: '1000',
    MOCK_ADMIN_TOKEN: '',
    MOCK_OPERATOR_TOKEN: '',
    MOCK_HOSTED: '',
    MOCK_TENANCY: '',
    MOCK_SANDBOX_FILE: '',
    MOCK_SANDBOX_TOKEN: '',
    MOCK_SANDBOX_TTL_MS: '',
    MOCK_SANDBOX_SWEEP_MS: '',
    MOCK_SANDBOX_MAX: '',
    MOCK_SANDBOX_MAX_DOCUMENTS: '',
    MOCK_SANDBOX_RETENTION_MS: '',
    MOCK_SANDBOX_HOST_SUFFIX: '',
    MOCK_SANDBOX_CREATE_LIMIT: '',
    ...env,
  };
  if (!Object.prototype.hasOwnProperty.call(env, 'MOCK_BLOCK_PRIVATE_WEBHOOKS')) {
    delete childEnv.MOCK_BLOCK_PRIVATE_WEBHOOKS;
  }
  const proc = spawn('node', ['--max-old-space-size=48', path.join(__dirname, 'server.js')], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let fullLog = '';
  proc.stdout.on('data', (d) => { fullLog += String(d); });
  proc.stderr.on('data', (d) => { fullLog += String(d); });
  const port = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`дочерний стенд не сообщил порт: ${fullLog.slice(0, 300)}`)), 6000);
    const tryResolve = () => {
      const m = /on http:\/\/[^:]+:(\d+)/.exec(fullLog);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); return true; }
      return false;
    };
    if (!tryResolve()) {
      const poll = setInterval(() => { if (tryResolve()) clearInterval(poll); }, 50);
      proc.once('exit', (code) => { clearInterval(poll); clearTimeout(timer); reject(new Error(`дочерний стенд завершился с кодом ${code}: ${fullLog.slice(0, 300)}`)); });
    }
  });
  const stop = () => new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) { resolve(); return; }
    proc.once('exit', () => resolve());
    try { proc.kill('SIGKILL'); } catch { resolve(); }
  });
  return { proc, port, output: () => fullLog, stop };
}

function payload(overrides = {}) {
  return {
    amount: { value: '100.00', currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: 'https://shop.example/return' },
    description: 'Order No. 37',
    metadata: { order_id: '37' },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ main */

async function main() {
  const receiverPort = await listen(receiver);
  // env ДО require: мок читает дефолтный URL вебхуков в момент постановки,
  // но стартовая конфигурация логируется при загрузке модуля.
  process.env.MOCK_RETRY_MS = '1000';
  process.env.MOCK_STATE_FILE = '';
  process.env.MOCK_PUBLIC_BASE_URL = 'http://mock.test';
  process.env.MOCK_DEFAULT_WEBHOOK_URL = `http://127.0.0.1:${receiverPort}/hook`;

  const mod = require('./server.js');
  const { server, state } = mod;
  SHOP_ID = mod.SHOP_ID;
  SECRET_KEY = mod.SECRET_KEY;
  const port = await listen(server);

  console.log(`\n== yookassa-mock selftest on :${port} ==\n`);

  try {
    /* ------------------------------------------ health и Basic Auth */
    console.log('— health / auth');
    const health = await request(port, 'GET', '/health');
    check('health 200 ok', health.statusCode === 200 && health.json().ok === true);
    check('health: payments/refunds числа', typeof health.json().payments === 'number' && typeof health.json().refunds === 'number');

    const noAuth = await request(port, 'GET', '/v3/payments');
    checkProviderError('без Basic Auth', noAuth, { status: 401, code: 'invalid_credentials' });
    check('401: WWW-Authenticate', String(noAuth.headers['www-authenticate'] || '').startsWith('Basic'));

    const badAuth = await request(port, 'GET', '/v3/payments', undefined, { Authorization: `Basic ${Buffer.from('shop:wrong').toString('base64')}` });
    checkProviderError('неверный secret', badAuth, { status: 401, code: 'invalid_credentials' });

    const listNoKey = await api(port, 'GET', '/v3/payments', undefined, { key: '' });
    check('GET /v3/payments без Idempotence-Key (GET ключ не нужен)', listNoKey.statusCode === 200);

    /* ------------------------------------------ валидация запросов */
    console.log('— валидация /v3/payments');
    const vMissing = await api(port, 'POST', '/v3/payments', {});
    checkProviderError('нет amount', vMissing, { status: 400, code: 'invalid_request', parameter: 'amount' });

    const vNumber = await api(port, 'POST', '/v3/payments', payload({ amount: { value: 100, currency: 'RUB' } }));
    checkProviderError('amount.value числом', vNumber, { status: 400, code: 'invalid_request', parameter: 'amount.value' });

    const vFraction = await api(port, 'POST', '/v3/payments', payload({ amount: { value: '100.999', currency: 'RUB' } }));
    checkProviderError('amount.value 3 знака', vFraction, { status: 400, parameter: 'amount.value' });

    const vZero = await api(port, 'POST', '/v3/payments', payload({ amount: { value: '0.00', currency: 'RUB' } }));
    checkProviderError('amount.value = 0', vZero, { status: 400, parameter: 'amount.value' });

    const vUsd = await api(port, 'POST', '/v3/payments', payload({ amount: { value: '100.00', currency: 'USD' } }));
    checkProviderError('валюта USD', vUsd, { status: 400, code: 'invalid_request', parameter: 'amount.currency' });

    const vCur = await api(port, 'POST', '/v3/payments', payload({ amount: { value: '100.00', currency: 'rub' } }));
    checkProviderError('валюта rub (не заглавными)', vCur, { status: 400, parameter: 'amount.currency' });

    const vCapture = await api(port, 'POST', '/v3/payments', payload({ capture: 'yes' }));
    checkProviderError('capture не boolean', vCapture, { status: 400, parameter: 'capture' });

    const vConfMissing = await api(port, 'POST', '/v3/payments', { amount: { value: '100.00', currency: 'RUB' } });
    checkProviderError('нет confirmation', vConfMissing, { status: 400, parameter: 'confirmation' });

    const vConfType = await api(port, 'POST', '/v3/payments', payload({ confirmation: { type: 'embedded', return_url: 'https://x' } }));
    checkProviderError('confirmation.type = embedded', vConfType, { status: 400, parameter: 'confirmation.type' });

    const vConfUrl = await api(port, 'POST', '/v3/payments', payload({ confirmation: { type: 'redirect' } }));
    checkProviderError('нет return_url', vConfUrl, { status: 400, parameter: 'confirmation.return_url' });

    const vDesc = await api(port, 'POST', '/v3/payments', payload({ description: 'x'.repeat(129) }));
    checkProviderError('description 129 символов', vDesc, { status: 400, parameter: 'description' });

    const meta17 = {};
    for (let i = 0; i < 17; i += 1) meta17[`k${i}`] = 'v';
    const vMeta = await api(port, 'POST', '/v3/payments', payload({ metadata: meta17 }));
    checkProviderError('metadata 17 ключей', vMeta, { status: 400, parameter: 'metadata' });

    const vMetaKey = await api(port, 'POST', '/v3/payments', payload({ metadata: { [ 'x'.repeat(33) ]: 'v' } }));
    checkProviderError('metadata-ключ 33 символа', vMetaKey, { status: 400, parameter: 'metadata' });

    const vExclusive = await api(port, 'POST', '/v3/payments', payload({ payment_token: 'tok', payment_method_id: 'pm_1' }));
    checkProviderError('payment_token + payment_method_id вместе', vExclusive, { status: 400, code: 'invalid_request' });

    const vMethod = await api(port, 'POST', '/v3/payments', payload({ payment_method_data: { type: 'sbp' } }));
    checkProviderError('payment_method_data.type = sbp', vMethod, { status: 400, parameter: 'payment_method_data.type' });

    const vNoKey = await request(port, 'POST', '/v3/payments', payload(), { Authorization: BASE_AUTH(), 'Content-Type': 'application/json' });
    checkProviderError('нет Idempotence-Key', vNoKey, {
      status: 400, code: 'invalid_request', parameter: 'Idempotence-Key',
      description: 'Idempotence key is missing. Generate a unique key is specify it in the Idempotence-Key header',
    });

    const vLongKey = await api(port, 'POST', '/v3/payments', payload(), { key: 'k'.repeat(65) });
    checkProviderError('Idempotence-Key 65 символов', vLongKey, {
      status: 400, parameter: 'Idempotence-Key',
      description: 'Idempotence key is too long. Send the value in accordance with the documentation',
    });

    const vBadJson = await request(port, 'POST', '/v3/payments', '{broken', { Authorization: BASE_AUTH(), 'Idempotence-Key': 'k1', 'Content-Type': 'application/json' });
    checkProviderError('битый JSON', vBadJson, { status: 400, code: 'invalid_request' });

    const v415 = await request(port, 'POST', '/v3/payments', '"just a string"', { Authorization: BASE_AUTH(), 'Idempotence-Key': 'k2', 'Content-Type': 'text/plain' });
    check('415 без тела (как у ЮKassa)', v415.statusCode === 415 && v415.body === '', `got ${v415.statusCode} "${v415.body.slice(0, 40)}"`);

    const vUnknown = await api(port, 'GET', '/v3/unknown');
    checkProviderError('неизвестный /v3-маршрут', vUnknown, { status: 404, code: 'not_found' });

    /* ------------------------------------------ create + идемпотентность */
    console.log('— create + идемпотентность');
    const createBody = payload();
    const createRaw = JSON.stringify(createBody);
    const created = await api(port, 'POST', '/v3/payments', createBody, { key: 'idem-1' });
    const payId = created.statusCode === 200 ? created.json().id : '';
    check('create 200: pending, test:true, decimal-строка', created.statusCode === 200
      && created.json().status === 'pending'
      && created.json().test === true
      && created.json().amount.value === '100.00'
      && typeof created.json().amount.value === 'string', created.body.slice(0, 200));
    check('create: confirmation.redirect + confirmation_url', created.json().confirmation
      && created.json().confirmation.type === 'redirect'
      && String(created.json().confirmation.confirmation_url || '').includes(`/payment/${payId}`));
    check('create: id — uuid', /^[0-9a-f-]{36}$/.test(payId));
    check('create: default capture=true не ломает pending', state.payments[payId].captureRequested === true);

    const countBefore = Object.keys(state.payments).length;
    const replay = await request(port, 'POST', '/v3/payments', createBody, {
      Authorization: BASE_AUTH(), 'Idempotence-Key': 'idem-1', 'Content-Type': 'application/json',
    });
    check('повтор того же ключа -> тот же объект', replay.statusCode === 200 && replay.json().id === payId);
    check('повтор: заголовок X-Idempotence-Replayed', replay.headers['x-idempotence-replayed'] === '1');
    check('повтор не создал второй платёж', Object.keys(state.payments).length === countBefore);

    const replayRaw = await request(port, 'POST', '/v3/payments', createRaw, {
      Authorization: BASE_AUTH(), 'Idempotence-Key': 'idem-1', 'Content-Type': 'application/json',
    });
    check('повтор raw-тела -> тот же объект (hash по raw)', replayRaw.json() && replayRaw.json().id === payId);

    const dupBody = payload({ description: 'другой заказ' });
    const dup = await request(port, 'POST', '/v3/payments', dupBody, {
      Authorization: BASE_AUTH(), 'Idempotence-Key': 'idem-1', 'Content-Type': 'application/json',
    });
    checkProviderError('тот же ключ, другое тело -> duplicate', dup, {
      status: 400, code: 'invalid_request', parameter: 'Idempotence-Key',
    });
    check('duplicate: description про дубль', providerError(dup) && String(providerError(dup).description).includes('duplicated'));

    const fetched = await api(port, 'GET', `/v3/payments/${payId}`, undefined, { key: '' });
    check('GET платежа -> тот же объект', fetched.statusCode === 200 && fetched.json().id === payId);

    const notFound = await api(port, 'GET', '/v3/payments/00000000-0000-0000-0000-000000000000', undefined, { key: '' });
    checkProviderError('GET неизвестного платежа', notFound, {
      status: 404, code: 'not_found', parameter: 'payment_id',
      description: "Incorrect payment_id. Payment doesn't exist or access denied.",
    });

    const list = await api(port, 'GET', '/v3/payments', undefined, { key: '' });
    check('GET /v3/payments: {type:list, items, next_cursor}', list.statusCode === 200
      && list.json().type === 'list' && Array.isArray(list.json().items) && 'next_cursor' in list.json());

    const methodNotAllowed = await api(port, 'PUT', `/v3/payments/${payId}`, {});
    check('PUT /v3/payments/{id} -> 405 с пустым телом', methodNotAllowed.statusCode === 405 && methodNotAllowed.body === '');

    /* ------------------------------------------ confirmation + оплата */
    console.log('— confirmation-страница и тестовые карты');
    const confPath = new URL(created.json().confirmation.confirmation_url).pathname;
    const confPage = await request(port, 'GET', confPath);
    check('страница оплаты 200 + тестовые карты', confPage.statusCode === 200
      && confPage.body.includes('Тестовый стенд ЮKassa')
      && confPage.body.includes('5555555555554444')
      && confPage.body.includes('100.00'), confPage.body.slice(0, 120));

    const conf404 = await request(port, 'GET', '/payment/00000000-0000-0000-0000-000000000000');
    check('страница неизвестного платежа 404', conf404.statusCode === 404);

    // Одностадийная оплата (capture=true) без 3DS.
    const payResp = await request(port, 'POST', `/payment/${payId}/pay`,
      'pan=4111111111111111&exp=1229&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
    check('оплата 302 на return_url', payResp.statusCode === 302 && payResp.headers.location === 'https://shop.example/return',
      `got ${payResp.statusCode} ${payResp.headers.location}`);

    const paidView = (await api(port, 'GET', `/v3/payments/${payId}`, undefined, { key: '' })).json();
    check('succeeded: paid, refundable, captured_at', paidView.status === 'succeeded' && paidView.paid === true
      && paidView.refundable === true && Boolean(paidView.captured_at));
    check('authorization_details: rrn + auth_code + 3ds', paidView.authorization_details
      && /^\d{10,16}$/.test(paidView.authorization_details.rrn)
      && /^\d{6}$/.test(paidView.authorization_details.auth_code)
      && paidView.authorization_details.three_d_secure.applied === false);
    check('payment_method: маска, заголовок, тип', paidView.payment_method
      && paidView.payment_method.card.last4 === '1111'
      && paidView.payment_method.card.first6 === '411111'
      && paidView.payment_method.title === 'Bank card *1111'
      && paidView.payment_method.card.card_type === 'Visa'
      && paidView.payment_method.saved === false);
    check('refunded_amount 0.00 у succeeded', paidView.refunded_amount && paidView.refunded_amount.value === '0.00');
    check('PAN не хранится в состоянии', !JSON.stringify(state.payments[payId]).includes('4111111111111111'));

    await waitForCondition(() => hitsFor(payId, 'payment.succeeded').length >= 1, { description: 'webhook payment.succeeded' });
    check('webhook payment.succeeded доставлен (ACK 200)', hitsFor(payId, 'payment.succeeded')[0].status === 200);
    // #56: флаг done выставляется ПОСЛЕ завершения postJson — ждём именно состояние done,
    // а не только факт хита (иначе окно гонки «ACK получен» vs «done записан» и флак CI).
    const succeededNotif = await waitForCondition(() => {
      const n = Object.values(state.notifications).find((x) => x.event === 'payment.succeeded' && x.payload.object.id === payId);
      return n && n.done && n.attempts >= 1 ? n : null;
    }, { description: 'уведомление done после ACK 200' });
    check('уведомление done после ACK 200', succeededNotif && succeededNotif.done && succeededNotif.attempts >= 1);

    // 3DS-сценарий.
    const tdsCreate = await api(port, 'POST', '/v3/payments', payload(), { key: 'tds-1' });
    const tdsId = tdsCreate.json().id;
    const tdsPay = await request(port, 'POST', `/payment/${tdsId}/pay`,
      'pan=5555555555554477&exp=1229&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
    check('3DS: страница ACS', tdsPay.statusCode === 200 && tdsPay.body.includes('3-D Secure'));
    const tdsDone = await request(port, 'POST', `/payment/${tdsId}/3ds`, 'code=1234', { 'Content-Type': 'application/x-www-form-urlencoded' });
    check('3DS: подтверждение 302', tdsDone.statusCode === 302 && tdsDone.headers.location === 'https://shop.example/return');
    const tdsView = (await api(port, 'GET', `/v3/payments/${tdsId}`, undefined, { key: '' })).json();
    check('3DS: succeeded + applied=true', tdsView.status === 'succeeded'
      && tdsView.authorization_details.three_d_secure.applied === true
      && tdsView.authorization_details.three_d_secure.challenge_completed === true);

    // Отказы с честными cancellation_details.
    async function declineCheck(name, pan, { reason, party, code3ds = false }) {
      const c = await api(port, 'POST', '/v3/payments', payload(), { key: `dec-${pan}` });
      const id = c.json().id;
      const r = await request(port, 'POST', `/payment/${id}/pay`,
        `pan=${pan}&exp=1229&cvv=123`, { 'Content-Type': 'application/x-www-form-urlencoded' });
      if (code3ds) {
        check(`${name}: 3DS-страница`, r.statusCode === 200 && r.body.includes('3-D Secure'));
        await request(port, 'POST', `/payment/${id}/3ds`, 'code=1234', { 'Content-Type': 'application/x-www-form-urlencoded' });
      } else {
        check(`${name}: 302 покупателю`, r.statusCode === 302);
      }
      const v = (await api(port, 'GET', `/v3/payments/${id}`, undefined, { key: '' })).json();
      check(`${name}: canceled + paid:false`, v.status === 'canceled' && v.paid === false, JSON.stringify(v.cancellation_details));
      check(`${name}: ${party}/${reason}`, v.cancellation_details
        && v.cancellation_details.party === party
        && v.cancellation_details.reason === reason, JSON.stringify(v.cancellation_details));
      await waitForCondition(() => hitsFor(id, 'payment.canceled').length >= 1, { description: `webhook canceled ${name}` });
      return id;
    }

    await declineCheck('insufficient_funds', '5555555555554600', { reason: 'insufficient_funds', party: 'payment_network' });
    await declineCheck('invalid_card_number (тестовая)', '5555555555554618', { reason: 'invalid_card_number', party: 'payment_network' });
    await declineCheck('Luhn-invalid карта', '1234567812345678', { reason: 'invalid_card_number', party: 'payment_network' });
    await declineCheck('не-тестовая Luhn-валидная', '4242424242424242', { reason: 'general_decline', party: 'payment_network' });
    await declineCheck('fraud_suspected', '5555555555554568', { reason: 'fraud_suspected', party: 'yoo_money' });
    await declineCheck('3d_secure_failed', '5555555555554592', { reason: '3d_secure_failed', party: 'payment_network', code3ds: true });

    // Форматные ошибки формы не убивают платёж.
    const fmtCreate = await api(port, 'POST', '/v3/payments', payload(), { key: 'fmt-1' });
    const fmtId = fmtCreate.json().id;
    const fmtResp = await request(port, 'POST', `/payment/${fmtId}/pay`,
      'pan=4111111111111111&exp=1229&cvv=ab', { 'Content-Type': 'application/x-www-form-urlencoded' });
    check('кривой CVC: ошибка на форме, платёж pending', fmtResp.statusCode === 200 && fmtResp.body.includes('3 цифры')
      && state.payments[fmtId].status === 'pending');
    const fmtPay = await request(port, 'POST', `/payment/${fmtId}/pay`,
      'pan=4111111111111111&exp=0120&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
    check('просроченный срок: 302', fmtPay.statusCode === 302);
    const fmtView = (await api(port, 'GET', `/v3/payments/${fmtId}`, undefined, { key: '' })).json();
    check('просроченный срок: card_expired', fmtView.cancellation_details
      && fmtView.cancellation_details.reason === 'card_expired' && fmtView.cancellation_details.party === 'payment_network');

    /* ------------------------------------------ two-stage / capture / cancel */
    console.log('— two-stage: capture / cancel');
    const holdCreate = await api(port, 'POST', '/v3/payments', payload({ capture: false }), { key: 'hold-1' });
    const holdId = holdCreate.json().id;
    const holdPay = await request(port, 'POST', `/payment/${holdId}/pay`,
      'pan=5555555555554444&exp=1229&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
    check('hold: оплата 302', holdPay.statusCode === 302);
    const holdView = (await api(port, 'GET', `/v3/payments/${holdId}`, undefined, { key: '' })).json();
    check('hold: waiting_for_capture + expires_at', holdView.status === 'waiting_for_capture'
      && holdView.paid === true && holdView.refundable === false && Boolean(holdView.expires_at));
    await waitForCondition(() => hitsFor(holdId, 'payment.waiting_for_capture').length >= 1,
      { description: 'webhook waiting_for_capture' });
    check('webhook payment.waiting_for_capture', true);

    const capNoKey = await request(port, 'POST', `/v3/payments/${holdId}/capture`, {}, {
      Authorization: BASE_AUTH(), 'Content-Type': 'application/json',
    });
    checkProviderError('capture без Idempotence-Key', capNoKey, {
      status: 400, parameter: 'Idempotence-Key',
      description: 'Idempotence key is missing. Generate a unique key is specify it in the Idempotence-Key header',
    });

    const capped = await api(port, 'POST', `/v3/payments/${holdId}/capture`, {}, { key: 'cap-1' });
    check('capture: succeeded', capped.statusCode === 200 && capped.json().status === 'succeeded'
      && capped.json().captured_at && capped.json().refundable === true, capped.body.slice(0, 160));
    await waitForCondition(() => hitsFor(holdId, 'payment.succeeded').length >= 1, { description: 'webhook after capture' });
    check('webhook payment.succeeded после capture', true);

    const capAgain = await api(port, 'POST', `/v3/payments/${holdId}/capture`, {}, { key: 'cap-2' });
    checkProviderError('повторный capture', capAgain, { status: 400, code: 'invalid_request' });

    const cancelSucceeded = await api(port, 'POST', `/v3/payments/${holdId}/cancel`, {}, { key: 'cx-0' });
    checkProviderError('cancel succeeded-платежа', cancelSucceeded, { status: 400, code: 'invalid_request' });

    // capture > authorized.
    const overHold = await api(port, 'POST', '/v3/payments', payload({ capture: false }), { key: 'hold-2' });
    await request(port, 'POST', `/payment/${overHold.json().id}/pay`,
      'pan=5555555555554444&exp=1229&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
    const overCap = await api(port, 'POST', `/v3/payments/${overHold.json().id}/capture`, { amount: { value: '200.00', currency: 'RUB' } }, { key: 'cap-over' });
    checkProviderError('capture больше авторизованного', overCap, { status: 400, code: 'invalid_request', parameter: 'amount' });
    const overNum = await api(port, 'POST', `/v3/payments/${overHold.json().id}/capture`, { amount: { value: 40, currency: 'RUB' } }, { key: 'cap-over2' });
    checkProviderError('capture: amount числом', overNum, { status: 400, parameter: 'amount.value' });

    // Частичный capture.
    const partCap = await api(port, 'POST', `/v3/payments/${overHold.json().id}/capture`, { amount: { value: '40.00', currency: 'RUB' } }, { key: 'cap-part' });
    check('частичный capture 40.00 -> succeeded', partCap.statusCode === 200 && partCap.json().status === 'succeeded');
    check('частичный capture: amount объекта не меняется', partCap.json().amount.value === '100.00');

    // Отмена pending.
    const cancelCreate = await api(port, 'POST', '/v3/payments', payload(), { key: 'cx-1' });
    const cancelId = cancelCreate.json().id;
    const cancelNoKey = await request(port, 'POST', `/v3/payments/${cancelId}/cancel`, {}, {
      Authorization: BASE_AUTH(), 'Content-Type': 'application/json',
    });
    checkProviderError('cancel без Idempotence-Key', cancelNoKey, { status: 400, parameter: 'Idempotence-Key' });
    const canceled = await api(port, 'POST', `/v3/payments/${cancelId}/cancel`, {}, { key: 'cx-2' });
    check('cancel: canceled + merchant/canceled_by_merchant', canceled.statusCode === 200
      && canceled.json().status === 'canceled'
      && canceled.json().cancellation_details.party === 'merchant'
      && canceled.json().cancellation_details.reason === 'canceled_by_merchant'
      && canceled.json().paid === false, canceled.body.slice(0, 200));
    await waitForCondition(() => hitsFor(cancelId, 'payment.canceled').length >= 1, { description: 'webhook canceled (api)' });
    const cancelAgain = await api(port, 'POST', `/v3/payments/${cancelId}/cancel`, {}, { key: 'cx-3' });
    checkProviderError('повторный cancel', cancelAgain, { status: 400, code: 'invalid_request' });

    // capture до оплаты (pending) — неверный статус.
    const capPending = await api(port, 'POST', `/v3/payments/${cancelId}/capture`, {}, { key: 'cap-pend' });
    checkProviderError('capture из pending (после cancel)', capPending, { status: 400, code: 'invalid_request' });

    /* ------------------------------------------ refunds */
    console.log('— возвраты');
    const refCreate = await api(port, 'POST', '/v3/payments', payload(), { key: 'ref-pay' });
    const refPayId = refCreate.json().id;
    await request(port, 'POST', `/payment/${refPayId}/pay`,
      'pan=5555555555554444&exp=1229&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });

    const refNoKey = await request(port, 'POST', '/v3/refunds', { payment_id: refPayId, amount: { value: '10.00', currency: 'RUB' } }, {
      Authorization: BASE_AUTH(), 'Content-Type': 'application/json',
    });
    checkProviderError('refund без Idempotence-Key', refNoKey, { status: 400, parameter: 'Idempotence-Key' });

    const refNoPid = await api(port, 'POST', '/v3/refunds', { amount: { value: '10.00', currency: 'RUB' } }, { key: 'rf-1' });
    checkProviderError('refund без payment_id', refNoPid, { status: 400, parameter: 'payment_id' });

    const refBadPid = await api(port, 'POST', '/v3/refunds', { payment_id: '00000000-0000-0000-0000-000000000000', amount: { value: '10.00', currency: 'RUB' } }, { key: 'rf-2' });
    checkProviderError('refund на неизвестный платёж', refBadPid, { status: 404, code: 'not_found', parameter: 'payment_id' });

    const refNoAmount = await api(port, 'POST', '/v3/refunds', { payment_id: refPayId }, { key: 'rf-3' });
    checkProviderError('refund без amount', refNoAmount, { status: 400, parameter: 'amount' });

    const refPartial1 = await api(port, 'POST', '/v3/refunds', { payment_id: refPayId, amount: { value: '30.00', currency: 'RUB' } }, { key: 'rf-4' });
    check('частичный возврат 30.00 -> succeeded', refPartial1.statusCode === 200 && refPartial1.json().status === 'succeeded'
      && refPartial1.json().amount.value === '30.00' && refPartial1.json().payment_id === refPayId, refPartial1.body.slice(0, 200));
    const refundId = refPartial1.json().id;
    check('refund: refund_authorization_details.rrn', /^\d{10,16}$/.test(refPartial1.json().refund_authorization_details.rrn));
    await waitForCondition(() => hitsFor(refundId, 'refund.succeeded').length >= 1, { description: 'webhook refund.succeeded' });
    check('webhook refund.succeeded', true);

    const afterRefund = (await api(port, 'GET', `/v3/payments/${refPayId}`, undefined, { key: '' })).json();
    check('payment.refunded_amount = 30.00', afterRefund.refunded_amount && afterRefund.refunded_amount.value === '30.00');
    check('payment после возврата остаётся succeeded', afterRefund.status === 'succeeded');

    const refGet = await api(port, 'GET', `/v3/refunds/${refundId}`, undefined, { key: '' });
    check('GET возврата', refGet.statusCode === 200 && refGet.json().id === refundId);
    const ref404 = await api(port, 'GET', '/v3/refunds/00000000-0000-0000-0000-000000000000', undefined, { key: '' });
    checkProviderError('GET неизвестного возврата', ref404, { status: 404, code: 'not_found', parameter: 'refund_id' });

    const refPartial2 = await api(port, 'POST', '/v3/refunds', { payment_id: refPayId, amount: { value: '70.00', currency: 'RUB' } }, { key: 'rf-5' });
    check('второй возврат 70.00 (остаток)', refPartial2.statusCode === 200 && refPartial2.json().status === 'succeeded');
    const refOver = await api(port, 'POST', '/v3/refunds', { payment_id: refPayId, amount: { value: '0.01', currency: 'RUB' } }, { key: 'rf-6' });
    checkProviderError('возврат больше refundable', refOver, { status: 400, parameter: 'amount' });

    // Возврат по pending — нельзя.
    const refPending = await api(port, 'POST', '/v3/refunds', { payment_id: cancelCreate.json().id, amount: { value: '10.00', currency: 'RUB' } }, { key: 'rf-7' });
    checkProviderError('refund по pending (canceled)', refPending, { status: 400, parameter: 'payment_id' });

    // Полный возврат с дочерним процессом отложенной финализации — ниже (отдельная фаза).

    const refList = await api(port, 'GET', '/v3/refunds', undefined, { key: '' });
    check('GET /v3/refunds: {type:list}', refList.statusCode === 200 && refList.json().type === 'list' && refList.json().items.length >= 2);

    // Частичный capture: refundable ограничен удержанной суммой.
    const partRefund = await api(port, 'POST', '/v3/refunds', { payment_id: overHold.json().id, amount: { value: '50.00', currency: 'RUB' } }, { key: 'rf-part' });
    checkProviderError('возврат > частичного capture (40 удержано)', partRefund, { status: 400, parameter: 'amount' });
    const partRefundOk = await api(port, 'POST', '/v3/refunds', { payment_id: overHold.json().id, amount: { value: '40.00', currency: 'RUB' } }, { key: 'rf-part2' });
    check('возврат ровно удержанной суммы', partRefundOk.statusCode === 200);

    /* ------------------------------------------ вебхуки: redelivery/drop/dup */
    console.log('— вебхуки: ретраи, drop, дубли');
    const flakyCreate = await api(port, 'POST', '/v3/payments', payload({
      metadata: { webhook_url: `http://127.0.0.1:${receiverPort}/flaky` },
    }), { key: 'flaky-1' });
    const flakyId = flakyCreate.json().id;
    await request(port, 'POST', `/payment/${flakyId}/pay`,
      'pan=4111111111111111&exp=1229&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
    await waitForCondition(() => {
      const n = Object.values(state.notifications).find((x) => x.event === 'payment.succeeded' && x.payload.object.id === flakyId);
      return n && n.done && n.attempts >= 2;
    }, { timeoutMs: 10000, description: 'redelivery: first 500 then 200' });
    check('недоставленный вебхук ретраится до 200 (повторная доставка)', true);

    const dropCreate = await api(port, 'POST', '/v3/payments', payload(), { key: 'drop-1' });
    const dropId = dropCreate.json().id;
    await request(port, 'POST', `/payment/${dropId}/pay`,
      'pan=4111111111111111&exp=1229&cvv=123',
      { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Mock-Scenario': 'webhook-drop' });
    await waitForCondition(() => Object.values(state.notifications)
      .some((n) => n.payload.object.id === dropId && n.suppressed), { description: 'notification suppressed' });
    await sleep(300);
    check('сценарий webhook-drop: уведомление подавлено, приёмник не тронут', hitsFor(dropId).length === 0,
      `hits=${hitsFor(dropId).length}`);

    const dupCreate = await api(port, 'POST', '/v3/payments', payload(), { key: 'dup-1' });
    const dupId = dupCreate.json().id;
    const dupCancel = await api(port, 'POST', `/v3/payments/${dupId}/cancel`, {}, { key: 'dup-cx', headers: { 'X-Mock-Scenario': 'webhook-duplicate' } });
    check('cancel с webhook-duplicate: 200', dupCancel.statusCode === 200);
    const dupEntries = Object.values(state.notifications).filter((n) => n.event === 'payment.canceled' && n.payload.object.id === dupId);
    check('webhook-duplicate: 2 записи в очереди', dupEntries.length === 2, `got ${dupEntries.length}`);
    await waitForCondition(() => hitsFor(dupId, 'payment.canceled').length >= 2, { description: '2 доставки дубля' });
    check('webhook-duplicate: приёмник получил 2 копии', true);

    /* ------------------------------------------ сценарии / chaos */
    console.log('— сценарии X-Mock-Scenario');
    const failResp = await api(port, 'POST', '/v3/payments', payload(), { key: 'sc-fail', headers: { 'X-Mock-Scenario': 'fail' } });
    checkProviderError('scenario fail -> 500 internal_server_error', failResp, { status: 500, code: 'internal_server_error' });
    const payCountBeforeFail = Object.keys(state.payments).length;
    await api(port, 'POST', '/v3/payments', payload(), { key: 'sc-fail-2', headers: { 'X-Mock-Scenario': 'fail' } });
    check('fail: бизнес не выполняется (платежей не прибавилось)', Object.keys(state.payments).length === payCountBeforeFail);

    const http500 = await api(port, 'POST', '/v3/payments', payload(), { key: 'sc-500', headers: { 'X-Mock-Scenario': 'http-500' } });
    checkProviderError('chaos http-500', http500, { status: 500, code: 'internal_server_error' });
    const http504 = await api(port, 'GET', '/v3/payments', undefined, { key: '', headers: { 'X-Mock-Scenario': 'http-504' } });
    check('chaos http-504 -> 504 provider-shaped', http504.statusCode === 504 && providerError(http504) !== null,
      `got ${http504.statusCode}`);

    const started = Date.now();
    await api(port, 'GET', '/v3/payments', undefined, { key: '', headers: { 'X-Mock-Latency': '300' } });
    check('X-Mock-Latency 300ms выдержан', Date.now() - started >= 300, `${Date.now() - started}ms`);

    const hangResult = await requestHang(port, 'POST', '/v3/payments', payload(), {
      Authorization: BASE_AUTH(), 'Idempotence-Key': 'sc-hang', 'Content-Type': 'application/json',
      'X-Mock-Scenario': 'hang',
    });
    check('scenario hang: ответа нет', hangResult.timedOut || hangResult.closedEarly || hangResult.connectionError,
      JSON.stringify(hangResult));

    const ruleAdd = await request(port, 'POST', '/mock/scenarios', { scenario: 'fail', times: 1 }, { 'Content-Type': 'application/json' });
    check('правило сценария добавлено', ruleAdd.statusCode === 200 && ruleAdd.json().ok === true);
    const ruleHit = await api(port, 'POST', '/v3/payments', payload(), { key: 'sc-rule-1' });
    check('правило сработало (fail)', ruleHit.statusCode === 500 && providerError(ruleHit) !== null, `got ${ruleHit.statusCode}`);
    const ruleMiss = await api(port, 'POST', '/v3/payments', payload(), { key: 'sc-rule-2' });
    check('правило израсходовано (times:1)', ruleMiss.statusCode === 200, `got ${ruleMiss.statusCode}`);
    const scenList = await request(port, 'GET', '/mock/scenarios');
    check('история триггеров непустая', Array.isArray(scenList.json().history) && scenList.json().history.length > 0);
    const scenClear = await request(port, 'DELETE', '/mock/scenarios');
    const scenAfter = await request(port, 'GET', '/mock/scenarios');
    check('правила очищены', scenClear.statusCode === 200 && scenAfter.json().rules.length === 0 && scenAfter.json().history.length === 0);

    // #52 PA-51/PB-13/PG-09: сценарии, история и журнал — per-sandbox.
    {
      const isoA = { 'X-Mock-Sandbox': 'sc52-a' };
      const isoB = { 'X-Mock-Sandbox': 'sc52-b' };
      await request(port, 'POST', '/mock/scenarios', { scenario: 'fail', persistent: true }, { 'Content-Type': 'application/json', ...isoA });
      const seenByB = await request(port, 'GET', '/mock/scenarios', undefined, isoB);
      check('#52: правила песочницы A не видны B', seenByB.json().rules.length === 0 && seenByB.json().history.length === 0);
      const payB = await api(port, 'POST', '/v3/payments', payload({ description: 'sc52-b-order' }), { key: 'sc52-b-1', headers: isoB });
      check('#52: правило A (fail) не срабатывает на платеже B', payB.statusCode === 200 && Boolean(payB.json().id), payB.body.slice(0, 120));
      const histB0 = await request(port, 'GET', '/mock/scenarios', undefined, isoB);
      check('#52: срабатывания правила A в истории B нет', histB0.json().history.length === 0);
      await api(port, 'POST', '/v3/payments', payload({ description: 'sc52-b-hist' }), { key: 'sc52-b-2', headers: { ...isoB, 'X-Mock-Scenario': 'webhook-drop' } });
      await api(port, 'POST', '/v3/payments', payload({ description: 'sc52-a-order' }), { key: 'sc52-a-1', headers: isoA });
      const histA = await request(port, 'GET', '/mock/scenarios', undefined, isoA);
      const histB = await request(port, 'GET', '/mock/scenarios', undefined, isoB);
      check('#52: история B не видна A, у B своя история есть', histB.json().history.length >= 1
        && !JSON.stringify(histB.json().history).includes('sc52-a-order') && histA.json().history.length >= 1);
      const journalA = await request(port, 'GET', '/admin/journal', undefined, isoA);
      const journalB = await request(port, 'GET', '/admin/journal', undefined, isoB);
      check('#52 PB-13: журналы A и B не пересекаются', journalA.body.includes('sc52-a-order') && !journalA.body.includes('sc52-b-order')
        && journalB.body.includes('sc52-b-order') && !journalB.body.includes('sc52-a-order'));
      await request(port, 'POST', '/mock/scenarios', { id: 'sc52-own', scenario: 'webhook-drop', persistent: true }, { 'Content-Type': 'application/json', ...isoB });
      await request(port, 'POST', '/mock/reset', {}, { 'Content-Type': 'application/json', ...isoA });
      const afterResetB = await request(port, 'GET', '/mock/scenarios', undefined, isoB);
      const journalAfterB = await request(port, 'GET', '/admin/journal', undefined, isoB);
      check('#52 PG-09/PB-13: reset A не стирает правила и журнал B', afterResetB.json().rules.some((r) => r.id === 'sc52-own')
        && journalAfterB.body.includes('sc52-b-order'));
      const tooBig = await request(port, 'POST', '/mock/scenarios', { scenario: 'fail', match: { pad: 'x'.repeat(9000) } }, { 'Content-Type': 'application/json', ...isoA });
      check('#52: правило >8 KiB -> 400 + code rule_too_large', tooBig.statusCode === 400 && tooBig.json().code === 'rule_too_large', tooBig.body.slice(0, 140));
      await request(port, 'POST', '/mock/scenarios', { id: 'sc52-upd', scenario: 'fail', persistent: true }, { 'Content-Type': 'application/json', ...isoA });
      await request(port, 'POST', '/mock/scenarios', { id: 'sc52-upd', scenario: 'webhook-drop', persistent: true }, { 'Content-Type': 'application/json', ...isoA });
      const updBig = await request(port, 'POST', '/mock/scenarios', { id: 'sc52-upd', scenario: 'fail', match: { pad: 'x'.repeat(9000) } }, { 'Content-Type': 'application/json', ...isoA });
      const updList = await request(port, 'GET', '/mock/scenarios', undefined, isoA);
      check('#52: update по id; oversized update -> 400 без затирания старого', updBig.statusCode === 400
        && updBig.json().code === 'rule_too_large' && updList.json().rules.filter((r) => r.id === 'sc52-upd').length === 1
        && updList.json().rules.find((r) => r.id === 'sc52-upd').scenario === 'webhook-drop');
      await request(port, 'DELETE', '/mock/scenarios', undefined, isoA);
      let capStatus = 0;
      for (let i = 0; i < 200; i += 1) {
        capStatus = (await request(port, 'POST', '/mock/scenarios', { id: `sc52-cap-${i}`, scenario: 'fail', persistent: true }, { 'Content-Type': 'application/json', ...isoA })).statusCode;
      }
      const capOver = await request(port, 'POST', '/mock/scenarios', { id: 'sc52-cap-200', scenario: 'fail' }, { 'Content-Type': 'application/json', ...isoA });
      const capList = await request(port, 'GET', '/mock/scenarios', undefined, isoA);
      check('#52: cap 200; 201-е -> 400 + code rule_cap_exceeded', capStatus === 200 && capOver.statusCode === 400
        && capOver.json().code === 'rule_cap_exceeded' && capList.json().rules.length === 200);
      await request(port, 'DELETE', '/mock/scenarios', undefined, isoB);
    }

    /* ------------------------------------------ виртуальные часы */
    console.log('— виртуальные часы /mock/time');
    const time0 = await request(port, 'GET', '/mock/time');
    check('GET /mock/time', time0.statusCode === 200 && Boolean(time0.json().iso));

    const ttlCreate = await api(port, 'POST', '/v3/payments', payload({ capture: false }), { key: 'ttl-1' });
    const ttlId = ttlCreate.json().id;
    await request(port, 'POST', `/payment/${ttlId}/pay`,
      'pan=5555555555554444&exp=1229&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
    check('hold создан', state.payments[ttlId].status === 'waiting_for_capture');
    const adv = await request(port, 'POST', '/mock/time', { advance: '+7d' }, { 'Content-Type': 'application/json' });
    check('advance +7d', adv.statusCode === 200 && adv.json().offsetMs > 0, JSON.stringify(adv.json()).slice(0, 120));
    check('холд истёк: canceled expired_on_capture', state.payments[ttlId].status === 'canceled'
      && state.payments[ttlId].cancellation_details.reason === 'expired_on_capture'
      && state.payments[ttlId].cancellation_details.party === 'yoo_money',
      JSON.stringify(state.payments[ttlId].cancellation_details));
    await waitForCondition(() => hitsFor(ttlId, 'payment.canceled').length >= 1, { description: 'webhook expired hold' });
    const resetTime = await request(port, 'POST', '/mock/time', { offset: 0 }, { 'Content-Type': 'application/json' });
    check('offset сброшен', resetTime.statusCode === 200 && resetTime.json().offsetMs === 0);

    /* ------------------------------------------ журнал / admin / sandbox */
    console.log('— журнал, admin, песочницы');
    const journalResp = await request(port, 'GET', '/admin/journal');
    const entries = journalResp.json().entries;
    check('journal: есть /v3-записи', journalResp.statusCode === 200 && Array.isArray(entries)
      && entries.some((e) => String(e.path).startsWith('/v3')));
    const jEntry = entries.find((e) => e.method === 'POST' && String(e.path).startsWith('/v3/payments'));
    check('journal: curl-сниппет', Boolean(jEntry && String(jEntry.curl || '').includes('curl')));
    const journalRaw = JSON.stringify(entries);
    check('journal: секретов нет в журнале (F-09)', !journalRaw.includes('mockpass123') && !journalRaw.includes('YOOKASSAMOCKTEST'),
      'утёк секрет');

    const adminPage = await request(port, 'GET', '/admin');
    check('admin: HTML-консоль', adminPage.statusCode === 200 && adminPage.body.includes('Консоль стенда'));

    // Песочницы: изоляция state (PA-55: POST /sandboxes создаёт песочницу, но без селектора запрос идёт в default).
    const sw = await request(port, 'POST', '/sandboxes', { sandbox: 'iso-a' }, { 'Content-Type': 'application/json' });
    check('создание/выбор песочницы iso-a', sw.statusCode === 200 && sw.json().current === 'iso-a');
    const isoCreate = await api(port, 'POST', '/v3/payments', payload(), { key: 'iso-1', headers: { 'X-Mock-Sandbox': 'iso-a' } });
    const isoId = isoCreate.json().id;
    const swBack = await request(port, 'POST', '/sandboxes', { sandbox: 'default' }, { 'Content-Type': 'application/json' });
    check('возврат на default', swBack.statusCode === 200 && swBack.json().current === 'default');
    const isoVisible = await api(port, 'GET', `/v3/payments/${isoId}`, undefined, { key: '' });
    check('платёж из iso-a в default не виден', isoVisible.statusCode === 404, `got ${isoVisible.statusCode}`);
    const isoBack = await api(port, 'GET', `/v3/payments/${isoId}`, undefined, { key: '', headers: { 'X-Mock-Sandbox': 'iso-a' } });
    check('тот же платёж виден в iso-a', isoBack.statusCode === 200);

    const stateResp = await request(port, 'GET', '/mock/state');
    check('GET /mock/state', stateResp.statusCode === 200 && stateResp.json().state);

    const resetResp = await request(port, 'POST', '/mock/reset', {}, { 'Content-Type': 'application/json' });
    check('POST /mock/reset', resetResp.statusCode === 200 && resetResp.json().ok === true);
    check('reset очистил платежи default', Object.keys(state.payments).length === 0);

    /* ------------------------------------------ дочерние процессы */
    console.log('— персистентность и control-plane (дочерние процессы)');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yookassa-selftest-'));
    const stateFile = path.join(tmpDir, 'state.json');
    let child = startChild({ MOCK_STATE_FILE: stateFile });
    try {
      const childPort = await child.port;
      const childCreate = await api(childPort, 'POST', '/v3/payments', createBody, { key: 'persist-1' });
      const childId = childCreate.json().id;
      check('дочерний стенд: платёж создан', childCreate.statusCode === 200);
      await new Promise((resolve) => { child.proc.once('exit', resolve); child.proc.kill('SIGTERM'); });
      child = null;

      child = startChild({ MOCK_STATE_FILE: stateFile });
      const childPort2 = await child.port;
      const after = await api(childPort2, 'GET', `/v3/payments/${childId}`, undefined, { key: '' });
      check('после рестарта платёж читается из state-файла', after.statusCode === 200 && after.json().id === childId,
        after.body.slice(0, 120));
      const replayAfter = await api(childPort2, 'POST', '/v3/payments', createBody, { key: 'persist-1' });
      check('после рестарта replay идемпотентности работает', replayAfter.statusCode === 200 && replayAfter.json().id === childId,
        replayAfter.body.slice(0, 160));
      // Вебхуков в дочернем стенде не ждём (дефолтный URL указывает на живой приёмник —
      // pay здесь не выполняется).
      await new Promise((resolve) => { child.proc.once('exit', resolve); child.proc.kill('SIGTERM'); });
      child = null;
    } finally {
      if (child) await child.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // Control-plane токены: закрытая управляющая поверхность, открытая business.
    let tokenChild = startChild({ MOCK_ADMIN_TOKEN: 'adm-secret', MOCK_OPERATOR_TOKEN: 'op-secret' });
    try {
      const tPort = await tokenChild.port;
      const jClosed = await request(tPort, 'GET', '/admin/journal');
      check('с токенами /admin/journal закрыт (401)', jClosed.statusCode === 401 && providerError(jClosed) !== null);
      const jOpen = await request(tPort, 'GET', '/admin/journal', undefined, { Authorization: 'Bearer adm-secret' });
      check('токен админа открывает /admin/journal', jOpen.statusCode === 200);
      const timeClosed = await request(tPort, 'GET', '/mock/time');
      check('/mock/time закрыт без оператор-токена', timeClosed.statusCode === 401);
      const timeOpen = await request(tPort, 'GET', '/mock/time', undefined, { 'X-Operator-Token': 'op-secret' });
      check('оператор-токен открывает /mock/time', timeOpen.statusCode === 200);
      const healthOpen = await request(tPort, 'GET', '/health');
      check('/health публичен', healthOpen.statusCode === 200);
      const bizOpen = await api(tPort, 'GET', '/v3/payments', undefined, { key: '' });
      check('/v3 не требует control-токенов (Basic Auth)', bizOpen.statusCode === 200);
    } finally {
      await tokenChild.stop();
    }

    // Стартовый лог печатает дефолтные креды (issue: «печатать в стартовом логе»).
    const logChild = startChild({});
    try {
      await logChild.port;
      await sleep(200);
      const logText = logChild.output();
      const okLog = logText.includes('basic auth: shopId=YOOKASSAMOCKTEST') && logText.includes('mockpass123');
      check('стартовый лог печатает креды', okLog, logText.slice(0, 300));
    } finally {
      await logChild.stop();
    }

    const hostedFlagChild = startChild({ MOCK_HOSTED: '1' });
    try {
      const hPort = await hostedFlagChild.port;
      await request(hPort, 'GET', '/health');
      check('#51 PF-01: MOCK_HOSTED=1 в yookassa-mock включает block_private_webhooks=true по умолчанию',
        hostedFlagChild.output().includes('hosted=true block_private_webhooks=true'), hostedFlagChild.output().slice(0, 300));
    } finally {
      await hostedFlagChild.stop();
    }

    // Отложенный возврат (MOCK_REFUND_DELAY_MS>0): pending -> succeeded по тику.
    let delayChild = startChild({ MOCK_REFUND_DELAY_MS: '500', MOCK_DEFAULT_WEBHOOK_URL: `http://127.0.0.1:${receiverPort}/hook` });
    try {
      const dPort = await delayChild.port;
      const dCreate = await api(dPort, 'POST', '/v3/payments', payload(), { key: 'delay-pay' });
      const dId = dCreate.json().id;
      await request(dPort, 'POST', `/payment/${dId}/pay`,
        'pan=5555555555554444&exp=1229&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
      const dRefund = await api(dPort, 'POST', '/v3/refunds', { payment_id: dId, amount: { value: '100.00', currency: 'RUB' } }, { key: 'delay-refund' });
      check('отложенный возврат создаётся pending', dRefund.statusCode === 200 && dRefund.json().status === 'pending',
        dRefund.body.slice(0, 160));
      const dRid = dRefund.json().id;
      await waitForCondition(async () => {
        const r = await api(dPort, 'GET', `/v3/refunds/${dRid}`, undefined, { key: '' });
        return r.statusCode === 200 && r.json().status === 'succeeded';
      }, { timeoutMs: 8000, description: 'refund pending -> succeeded' });
      check('по тику возврат становится succeeded', true);
      await waitForCondition(() => hitsFor(dRid, 'refund.succeeded').length >= 1, { timeoutMs: 8000, description: 'webhook refund.succeeded (async)' });
      check('webhook refund.succeeded после финализации', true);
    } finally {
      await delayChild.stop();
    }

    // PA-50 / PA-54 / PA-55: авторизация явного target, гонка TTL-sweep mid-await,
    // закрытая default-песочница и сохранение ?sandbox= в формах покупателя
    const tmpPa = fs.mkdtempSync(path.join(os.tmpdir(), 'yookassa-pa50-'));
    const sbxFile = path.join(tmpPa, 'sandboxes.json');
    const core = require('../../packages/core');
    fs.writeFileSync(sbxFile, JSON.stringify({
      activeId: 'victim-b',
      sandboxes: [
        {
          id: 'victim-b',
          expiresAt: 0,
          ownerTokenHash: core.hashSecret('victim-owner-token'),
          state: {
            payments: {
              'yoo-victim-pay': {
                id: 'yoo-victim-pay',
                status: 'succeeded',
                paid: true,
                amount: { value: '100.00', currency: 'RUB' },
                description: 'VICTIM-CANARY-YOO',
                created_at: new Date().toISOString(),
                metadata: {},
              },
            },
            refunds: {},
            idempotency: {},
            notifications: {},
          },
        },
        {
          id: 'attacker-a',
          expiresAt: 0,
          ownerTokenHash: core.hashSecret('attacker-owner-token'),
          state: { payments: {}, refunds: {}, idempotency: {}, notifications: {} },
        },
      ],
    }));
    const paChild = startChild({
      MOCK_TENANCY: 'owned',
      MOCK_SANDBOX_FILE: sbxFile,
      MOCK_SANDBOX_TOKEN: 'default-owner-secret',
      MOCK_OPERATOR_TOKEN: 'op-secret',
      MOCK_SANDBOX_TTL_MS: '1000',
      MOCK_SANDBOX_SWEEP_MS: '1000',
    });
    try {
      const pPort = await paChild.port;
      const hdrA = { 'X-Mock-Sandbox': 'attacker-a', 'X-Sandbox-Token': 'attacker-owner-token', 'Content-Type': 'application/json' };
      const expB = await request(pPort, 'GET', '/mock/state?sandbox=victim-b', undefined, hdrA);
      check('PA-50: чужой GET /mock/state?sandbox=victim-b -> 401 без утечки', expB.statusCode === 401 && !expB.body.includes('VICTIM-CANARY-YOO'));
      const impB = await request(pPort, 'POST', '/mock/state', { sandbox: 'victim-b', state: { payments: { pwn: {} } } }, hdrA);
      check('PA-50: чужой POST /mock/state -> 401', impB.statusCode === 401);
      const rstB = await request(pPort, 'POST', '/mock/reset', { sandbox: 'victim-b' }, hdrA);
      check('PA-50: чужой POST /mock/reset -> 401', rstB.statusCode === 401);
      const delB = await request(pPort, 'DELETE', '/sandboxes?sandbox=victim-b', undefined, hdrA);
      check('PA-50: чужой DELETE /sandboxes -> 401', delB.statusCode === 401);

      const opB = await request(pPort, 'GET', '/mock/state?sandbox=victim-b', undefined, { 'X-Operator-Token': 'op-secret' });
      check('PA-50: оператор читает /mock/state?sandbox=victim-b', opB.statusCode === 200 && opB.body.includes('VICTIM-CANARY-YOO'));

      const defForm = await request(pPort, 'GET', '/payment/yoo-victim-pay');
      check('PA-54: форма защищённой default без токена -> 401', defForm.statusCode === 401);
      const pubHealth = (await request(pPort, 'GET', '/health')).json();
      check('PA-54: публичный /health на защищённой default не раскрывает payments', pubHealth.payments === undefined);

      const r = (await request(pPort, 'POST', '/sandboxes', { id: 'race-tenant' }, { 'Content-Type': 'application/json' })).json();
      const raceResp = await api(pPort, 'GET', '/v3/payments/yoo-victim-pay', undefined, {
        key: '',
        headers: {
          'X-Mock-Sandbox': r.id,
          'X-Sandbox-Token': r.ownerToken,
          'X-Mock-Latency': '1700',
        },
      });
      check('PA-50 §7.2: истёкшая во время await песочница -> 410 без утечки',
        raceResp.statusCode === 410 && !raceResp.body.includes('VICTIM-CANARY-YOO'), `status=${raceResp.statusCode}`);
    } finally {
      await paChild.stop();
      fs.rmSync(tmpPa, { recursive: true, force: true });
    }

    console.log(`\nИТОГ: ${passed} passed, ${failed} failed · вебхуков доставлено: ${RECEIVER_HITS.length}`);
    if (failed > 0) {
      console.log('SELFTEST FAILED ❌');
      process.exit(1);
    }
    console.log('SELFTEST PASSED ✅');
    process.exit(0);
  } finally {
    try { server.close(); } catch { /* ignore */ }
    try { receiver.close(); } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error('SELFTEST FAILED ❌:', e);
  process.exit(1);
});
