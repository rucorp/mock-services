// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Selftest alfa-mock (issue #41): интернет-эквайринг Альфа-Банка, REST *.do.
 *
 * Покрыто (DoD #41):
 *   • happy-path: register.do -> formUrl -> оплата тестовой картой (3DS1/3DS2)
 *     -> orderStatus=2 + callback deposited; registerPreAuth -> холд ->
 *     deposit ≤ авторизации -> списание; reverse; полный/частичный refund;
 *   • callback: HTTP GET с query-параметрами, симметричный checksum
 *     HMAC-SHA256 (независимая проверка канонической строки name;value;…;),
 *     ACK ровно 200 (204 — не успех), ретраи до 200, webhook-drop/
 *     webhook-duplicate, режим без checksum (MOCK_CALLBACK_CHECKSUM=false —
 *     эмуляция неподписанного уведомления, сверка через REST);
 *   • негативы: неверные креды (errorCode 2), повтор orderNumber (1),
 *     некорректные orderNumber/amount/returnUrl/currency/jsonParams/
 *     sessionTimeoutSecs (3/5), deposit больше холда и refund больше
 *     списанного (5), операции не в том статусе (4), неизвестный заказ (3);
 *   • отказные карты: -2011 (PaRes=U), 116 (недостаточно средств), 71015
 *     (неверный срок/CVV, Fail/неверный пароль ACS), SSL-карта без
 *     разрешения, неизвестный PAN; владелец карты — два слова латиницей;
 *   • sessionTimeoutSecs -> declinedByTimeout по виртуальным часам;
 *   • сценарии fail/hang/latency/http-500/http-504 и правила /mock/scenarios;
 *   • журнал (curl form-urlencoded, редакция кредов), PAN не хранится
 *     (только маска first6**last4) — F-09/F-10;
 *   • песочницы: namespaces (изоляция, formUrl c ?sandbox=) и owned
 *     (свои userName/password/callbackSecret, ownerToken, reset-creds);
 *   • /mock/state экспорт/импорт, /mock/reset, персистентность (рестарт),
 *     control-plane (MOCK_ADMIN_TOKEN/MOCK_OPERATOR_TOKEN, hosted fail-closed),
 *     OpenAPI, синтетические креды в стартовом логе.
 *
 * Zero dependencies. Запуск: node services/alfa-mock/selftest.js
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCondition(predicate, { timeoutMs = 8000, intervalMs = 25, description = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); } else { failed += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

/* ------------------------------------------------ синтетические креды стенда */

const CREDS = { userName: 'ALFAMOCKTEST', password: 'mockpass123' };
const CALLBACK_SECRET = 'mocksecret123';
// Фиктивные PG-01/PG-02 маркеры: ни одна проверка не использует настоящие креды.
const CREDENTIAL_SENTINELS = Object.freeze({
  userName: 'PG01_USERNAME_SENTINEL_60',
  password: 'PG01_PASSWORD_SENTINEL_60',
  callbackSecret: 'PG02_CALLBACK_SECRET_SENTINEL_60',
});

/* --------------------------------------------------- тестовые карты (конспект 03) */

const CARD_3DS1_OK = '4111111111111111';
const CARD_MIR_3DS1 = '639002000000000003';
const CARD_3DS2_FRICTIONLESS = '2201382000000062';
const CARD_3DS2_CHALLENGE = '2200000000000053';
const CARD_DECLINE_PAR_U = '5555555555555557';
const CARD_DECLINE_FUNDS = '5432543254325430'; // CVV 521
const CARD_SSL = '5555555555555599';
const CARD_UNKNOWN_LUHN_OK = '4242424242424242';
const CARD_UNKNOWN_LUHN_BAD = '4242424242424241';

/* --------------------------------------------------- приёмник callback'ов */

const HITS = []; // {path, method, query, body, status}
let flakyCount = 0;

const receiver = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://receiver.local');
    const query = Object.fromEntries(url.searchParams.entries());
    // /flaky отвечает 500 на первую доставку: проверяем ретрай до HTTP 200.
    if (url.pathname === '/flaky') flakyCount += 1;
    const isFail = url.pathname === '/flaky' && flakyCount === 1;
    // /noack всегда отвечает 204: ACK должен быть РОВНО 200 — доставка не засчитывается.
    const isNoAck = url.pathname === '/noack';
    const status = isFail ? 500 : (isNoAck ? 204 : 200);
    HITS.push({ path: url.pathname, method: req.method, query, body: buf, status });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(isNoAck ? '' : (isFail ? '{"error":"first attempt fails"}' : '{"ok":true}'));
  });
});

function listen(srv) {
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}

const hitsFor = (mdOrder) => HITS.filter((h) => h.query && h.query.mdOrder === mdOrder);

/* -------------------------------------------------------------- http-utils */

function request(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const isString = typeof body === 'string';
    const data = body === undefined || body === null ? null : (isString ? body : JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method,
      headers: {
        ...(data !== null ? { 'Content-Type': isString ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
        ...(data !== null ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: out,
        json: () => { try { return JSON.parse(out); } catch { return null; } },
      }));
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

/** Запрос, которому разрешено не получить ответа (сценарий hang). */
function requestHang(port, method, p, body, headers = {}, waitMs = 700) {
  return new Promise((resolve) => {
    const data = body === undefined || body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method,
      headers: {
        ...(data !== null ? { 'Content-Type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
        ...(data !== null ? { 'Content-Length': Buffer.byteLength(data) } : {}),
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

const form = (fields) => new URLSearchParams(fields).toString();

/** POST /payment/rest/{method} с form-параметрами (контракт шлюза). */
const rest = (port, method, fields, headers = {}) => request(port, 'POST', `/payment/rest/${method}`, form(fields), headers);

let orderSeq = 0;
const nextOrderNumber = (prefix = 'st') => `${prefix}-${Date.now().toString(36)}-${(orderSeq += 1)}`;

/**
 * Независимая реализация проверки checksum (как должен делать мерчант):
 * удалить checksum/sign_alias, отсортировать имена алфавитно, строка
 * «name;value;…;», HMAC-SHA256, hex в верхнем регистре.
 */
function verifyChecksum(query, secret) {
  const params = { ...query };
  const received = params.checksum;
  delete params.checksum;
  delete params.sign_alias;
  if (received === undefined) return false;
  const canonical = Object.keys(params).sort().map((k) => `${k};${params[k]};`).join('');
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest('hex').toUpperCase();
  return received === expected;
}

/**
 * Сквозной флоу: регистрация -> оплата картой на форме -> (ACS) -> статус.
 * `tdsPassword=null` эмулирует кнопку Fail на тестовом ACS.
 */
async function fullFlow(port, {
  op = 'register.do',
  pan = CARD_3DS1_OK,
  exp = '1234',
  cvv = '123',
  cardholder = 'IVAN IVANOV',
  creds = CREDS,
  orderNumber = nextOrderNumber(),
  amount = 10000,
  description = null,
  callbackUrl = null,
  failUrl = 'https://shop.test/fail',
  headers = {},
  payHeaders = {},
  tdsPassword = '12345678',
  sessionTimeoutSecs = null,
} = {}) {
  const fields = {
    ...creds,
    orderNumber,
    amount: String(amount),
    returnUrl: 'https://shop.test/ok',
    ...(failUrl ? { failUrl } : {}),
    ...(description ? { description } : {}),
    ...(callbackUrl ? { jsonParams: JSON.stringify({ callback_url: callbackUrl }) } : {}),
    ...(sessionTimeoutSecs ? { sessionTimeoutSecs: String(sessionTimeoutSecs) } : {}),
  };
  const reg = await rest(port, op, fields, headers);
  const regJson = reg.json() || {};
  if (!regJson.orderId) return { reg, regJson, orderNumber };
  const orderId = regJson.orderId;
  const pay = await request(port, 'POST', `/payment/${orderId}/pay`, form({ pan, exp, cvv, cardholder }), payHeaders);
  let tds = null;
  if (pay.statusCode === 200 && pay.body.includes('3-D Secure')) {
    tds = await request(port, 'POST', `/payment/${orderId}/3ds`, form(tdsPassword === null ? { action: 'fail' } : { password: tdsPassword }), payHeaders);
  }
  const st = await rest(port, 'getOrderStatusExtended.do', { ...creds, orderId }, headers);
  return { reg, regJson, orderId, orderNumber, formUrl: regJson.formUrl, pay, tds, status: st.json() || {}, statusRes: st };
}

function startChild(env = {}) {
  const childEnv = {
    ...process.env,
    MOCK_HOST: '127.0.0.1',
    MOCK_PORT: '0',
    MOCK_STATE_FILE: '',
    MOCK_PUBLIC_BASE_URL: '',
    MOCK_DEFAULT_CALLBACK_URL: '',
    MOCK_CALLBACK_RETRY_MS: '1000',
    MOCK_CALLBACK_MAX_ATTEMPTS: '4',
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
    MOCK_TWO_STAGE: '',
    MOCK_PARTIAL_REFUND: '',
    MOCK_SSL_PERMITTED: '',
    MOCK_CALLBACK_CHECKSUM: '',
    MOCK_SESSION_TIMEOUT_SECS: '',
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

/** Проверка provider-shaped ошибки: HTTP 200 + {errorCode, errorMessage} + DX hint/doc. */
function checkError(name, r, { code, field, status = 200 } = {}) {
  const j = r.json() || {};
  check(`${name}: provider-shaped error (errorCode=${code}, HTTP ${status})`,
    r.statusCode === status && j.errorCode === code && typeof j.errorMessage === 'string' && j.errorMessage.length > 0,
    `got HTTP ${r.statusCode} ${String(r.body).slice(0, 160)}`);
  if (field !== undefined) check(`${name}: field=${field}`, String(j.field || '') === field, `got ${JSON.stringify(j.field)}`);
  check(`${name}: DX hint + doc`, Boolean(j.hint) && String(j.doc || '').includes('alfabank.ru'),
    JSON.stringify({ hint: j.hint && String(j.hint).slice(0, 40), doc: j.doc }));
}

/* ------------------------------------------------------------------- main */

async function main() {
  const receiverPort = await listen(receiver);
  const HOOK_URL = `http://127.0.0.1:${receiverPort}/hook`;
  const FLAKY_URL = `http://127.0.0.1:${receiverPort}/flaky`;
  const NOACK_URL = `http://127.0.0.1:${receiverPort}/noack`;

  // env ДО require: конфиг читается при загрузке модуля.
  process.env.MOCK_STATE_FILE = '';
  process.env.MOCK_HOST = '127.0.0.1';
  process.env.MOCK_PUBLIC_BASE_URL = 'http://mock.test';
  process.env.MOCK_CALLBACK_RETRY_MS = '1000';
  process.env.MOCK_CALLBACK_MAX_ATTEMPTS = '4';

  const mod = require('./server.js');
  const { server, state, sandboxRuntime } = mod;
  const port = await listen(server);

  console.log(`\n== alfa-mock selftest on :${port} (Альфа-Банк, интернет-эквайринг REST /payment/rest/*.do) ==\n`);

  const children = [];
  const tmpFiles = [];

  try {
    /* ------------------------------------------- health / OpenAPI / креды */
    console.log('— health, OpenAPI, синтетические креды стенда');
    const health = await request(port, 'GET', '/health');
    check('health 200 ok', health.statusCode === 200 && health.json().ok === true);
    check('health: api=rest, base=/payment/rest', health.json().api === 'rest' && health.json().base === '/payment/rest');
    check('health: two-stage и checksum HMAC-SHA256, sessionTimeoutSecs=1200',
      health.json().twoStage === true && health.json().checksum === 'HMAC-SHA256' && health.json().sessionTimeoutSecs === 1200,
      JSON.stringify(health.json()));
    check('health: счётчики orders/awaiting/callbacks',
      typeof health.json().orders === 'number' && typeof health.json().awaiting === 'number' && typeof health.json().callbacks === 'number');

    const openapi = await request(port, 'GET', '/openapi.json');
    check('/openapi.json отдаёт OpenAPI 3.1 с маршрутами *.do',
      openapi.statusCode === 200 && openapi.json().openapi === '3.1.0'
      && Boolean(openapi.json().paths['/payment/rest/register.do'])
      && Boolean(openapi.json().paths['/payment/rest/getOrderStatusExtended.do'])
      && Boolean(openapi.json().paths['/payment/{orderId}']));

    check('дефолты мока — СИНТЕТИЧЕСКИЕ креды (не реквизиты банка)',
      mod.USER_NAME_CRED === 'ALFAMOCKTEST' && mod.PASSWORD_CRED === 'mockpass123' && mod.CALLBACK_SECRET_CRED === 'mocksecret123',
      `${mod.USER_NAME_CRED}/${mod.PASSWORD_CRED}`);

    /* --------------------------------------------------- checksum (unit) */
    console.log('— checksum: каноническая строка name;value;…; и HMAC-SHA256 uppercase');
    check('canonicalChecksumString: сортировка, хвостовой «;», checksum/sign_alias исключены',
      mod.canonicalChecksumString({ b: '2', a: '1', checksum: 'X', sign_alias: 'Y' }) === 'a;1;b;2;',
      mod.canonicalChecksumString({ b: '2', a: '1', checksum: 'X', sign_alias: 'Y' }));
    const sampleChecksum = mod.checksumOf({ a: '1', b: '2' }, 'secret');
    check('checksumOf: HMAC-SHA256, hex 64 символа в верхнем регистре',
      /^[0-9A-F]{64}$/.test(sampleChecksum), sampleChecksum);
    check('checksumOf совпадает с независимой реализацией',
      sampleChecksum === (() => crypto.createHmac('sha256', 'secret').update('a;1;b;2;').digest('hex').toUpperCase())());

    /* ---------------------------------------------- register.do: валидация */
    console.log('— register.do: креды, обязательные поля, orderNumber уникален');
    const noCreds = await rest(port, 'register.do', { orderNumber: nextOrderNumber(), amount: '10000', returnUrl: 'https://shop.test/ok' });
    checkError('пустые креды', noCreds, { code: 2, field: 'userName' });

    const badUser = await rest(port, 'register.do', { ...CREDS, userName: 'wrong-user', orderNumber: nextOrderNumber(), amount: '10000', returnUrl: 'https://shop.test/ok' });
    checkError('неверный userName', badUser, { code: 2, field: 'userName' });

    const badPass = await rest(port, 'register.do', { ...CREDS, password: 'wrong-pass', orderNumber: nextOrderNumber(), amount: '10000', returnUrl: 'https://shop.test/ok' });
    checkError('неверный password', badPass, { code: 2, field: 'password' });
    check('неверный password: hint объясняет, что креды синтетические и где их взять',
      String((badPass.json() || {}).hint || '').includes('ALFAMOCKTEST'));

    /* --------------------------------------------- PG-01/PG-02 sentinels */
    console.log('— PG-01/PG-02: env-креды не попадают в hint и стартовый лог');
    const childCredentialProbe = startChild({
      MOCK_ALFA_USERNAME: CREDENTIAL_SENTINELS.userName,
      MOCK_ALFA_PASSWORD: CREDENTIAL_SENTINELS.password,
      MOCK_ALFA_CALLBACK_SECRET: CREDENTIAL_SENTINELS.callbackSecret,
    });
    children.push(childCredentialProbe);
    const portCredentialProbe = await childCredentialProbe.port;
    await waitForCondition(
      () => childCredentialProbe.output().includes('вне области: асимметричный checksum'),
      { description: 'alfa startup log' },
    );

    const wrongConfiguredPass = await rest(portCredentialProbe, 'register.do', {
      userName: CREDENTIAL_SENTINELS.userName,
      password: 'wrong-probe-password',
      orderNumber: nextOrderNumber('pg60-pass'),
      amount: '100',
      returnUrl: 'https://shop.test/ok',
    });
    const wrongConfiguredPassJson = wrongConfiguredPass.json() || {};
    check('PG-01: custom userName + неверный password → errorCode=2',
      wrongConfiguredPass.statusCode === 200 && wrongConfiguredPassJson.errorCode === 2
      && wrongConfiguredPassJson.field === 'password' && Boolean(wrongConfiguredPassJson.hint));

    const wrongConfiguredUser = await rest(portCredentialProbe, 'register.do', {
      userName: 'wrong-probe-user',
      password: 'wrong-probe-password',
      orderNumber: nextOrderNumber('pg60-user'),
      amount: '100',
      returnUrl: 'https://shop.test/ok',
    });
    const wrongConfiguredUserJson = wrongConfiguredUser.json() || {};
    check('PG-01: неверный userName при custom env → errorCode=2',
      wrongConfiguredUser.statusCode === 200 && wrongConfiguredUserJson.errorCode === 2
      && wrongConfiguredUserJson.field === 'userName' && Boolean(wrongConfiguredUserJson.hint));

    const credentialMarkers = Object.values(CREDENTIAL_SENTINELS);
    const responseHasCredentialMarker = credentialMarkers.some((marker) =>
      wrongConfiguredPass.body.includes(marker) || wrongConfiguredUser.body.includes(marker));
    check('PG-01: errorCode=2 responses не раскрывают configured env values',
      !responseHasCredentialMarker,
      responseHasCredentialMarker ? 'sentinel found; value suppressed' : '');
    check('PG-01: оба hint используют синтетический fallback для примера',
      String(wrongConfiguredPassJson.hint || '').includes('ALFAMOCKTEST/mockpass123')
      && String(wrongConfiguredUserJson.hint || '').includes('ALFAMOCKTEST'));

    await waitForCondition(
      () => childCredentialProbe.output().includes('отказ авторизации: неверный password'),
      { description: 'alfa wrong-password log' },
    );
    const credentialProbeOutput = childCredentialProbe.output();
    const startupCredsLine = credentialProbeOutput.split('\n').find((line) => line.includes('creds (')) || '';
    const logHasCredentialMarker = credentialMarkers.some((marker) => credentialProbeOutput.includes(marker));
    check('PG-02: startup/auth logs не раскрывают configured env values',
      !logHasCredentialMarker,
      logHasCredentialMarker ? 'sentinel found; value suppressed' : '');
    check('PG-02: custom env overrides не меняют synthetic defaults в startup log',
      startupCredsLine.includes('userName=ALFAMOCKTEST')
      && startupCredsLine.includes('password=mockpass123')
      && startupCredsLine.includes('callback_secret=mocksecret123')
      && !logHasCredentialMarker,
      startupCredsLine ? 'строка лога проверена без вывода значений' : 'startup creds line missing');
    await childCredentialProbe.stop();

    const noOrderNumber = await rest(port, 'register.do', { ...CREDS, amount: '10000', returnUrl: 'https://shop.test/ok' });
    checkError('нет orderNumber', noOrderNumber, { code: 3, field: 'orderNumber' });

    const longOrderNumber = await rest(port, 'register.do', { ...CREDS, orderNumber: 'x'.repeat(65), amount: '10000', returnUrl: 'https://shop.test/ok' });
    checkError('orderNumber длиннее 64 символов', longOrderNumber, { code: 3, field: 'orderNumber' });

    const noAmount = await rest(port, 'register.do', { ...CREDS, orderNumber: nextOrderNumber(), returnUrl: 'https://shop.test/ok' });
    checkError('нет amount', noAmount, { code: 5, field: 'amount' });

    const fracAmount = await rest(port, 'register.do', { ...CREDS, orderNumber: nextOrderNumber(), amount: '1000.9', returnUrl: 'https://shop.test/ok' });
    checkError('amount дробный (копейки — целые)', fracAmount, { code: 5, field: 'amount' });

    const negAmount = await rest(port, 'register.do', { ...CREDS, orderNumber: nextOrderNumber(), amount: '-500', returnUrl: 'https://shop.test/ok' });
    checkError('amount отрицательный', negAmount, { code: 5, field: 'amount' });

    const noReturnUrl = await rest(port, 'register.do', { ...CREDS, orderNumber: nextOrderNumber(), amount: '10000' });
    checkError('нет returnUrl', noReturnUrl, { code: 5, field: 'returnUrl' });

    const badReturnUrl = await rest(port, 'register.do', { ...CREDS, orderNumber: nextOrderNumber(), amount: '10000', returnUrl: 'ftp://shop.test/ok' });
    checkError('returnUrl не http(s)', badReturnUrl, { code: 5, field: 'returnUrl' });

    const badCurrency = await rest(port, 'register.do', { ...CREDS, orderNumber: nextOrderNumber(), amount: '10000', returnUrl: 'https://shop.test/ok', currency: '840' });
    checkError('currency != 643 (только RUB)', badCurrency, { code: 5, field: 'currency' });

    const badTimeout = await rest(port, 'register.do', { ...CREDS, orderNumber: nextOrderNumber(), amount: '10000', returnUrl: 'https://shop.test/ok', sessionTimeoutSecs: 'abc' });
    checkError('sessionTimeoutSecs не целое', badTimeout, { code: 5, field: 'sessionTimeoutSecs' });

    const zeroTimeout = await rest(port, 'register.do', { ...CREDS, orderNumber: nextOrderNumber(), amount: '10000', returnUrl: 'https://shop.test/ok', sessionTimeoutSecs: '0' });
    checkError('sessionTimeoutSecs=0', zeroTimeout, { code: 5, field: 'sessionTimeoutSecs' });

    const badJsonParams = await rest(port, 'register.do', { ...CREDS, orderNumber: nextOrderNumber(), amount: '10000', returnUrl: 'https://shop.test/ok', jsonParams: '{oops' });
    checkError('jsonParams не JSON', badJsonParams, { code: 5, field: 'jsonParams' });

    const badCallbackUrl = await rest(port, 'register.do', { ...CREDS, orderNumber: nextOrderNumber(), amount: '10000', returnUrl: 'https://shop.test/ok', jsonParams: JSON.stringify({ callback_url: 'not-a-url' }) });
    checkError('jsonParams.callback_url некорректен', badCallbackUrl, { code: 5, field: 'jsonParams' });

    const unknownMethod = await rest(port, 'foo.do', { ...CREDS });
    checkError('неизвестный REST-метод foo.do', unknownMethod, { code: 6, status: 404 });
    check('неизвестный метод: hint перечисляет методы шлюза',
      String((unknownMethod.json() || {}).hint || '').includes('register.do') && String((unknownMethod.json() || {}).hint || '').includes('getOrderStatusExtended.do'));

    const wrongHttpMethod = await request(port, 'GET', '/payment/rest/register.do');
    checkError('GET вместо POST на *.do', wrongHttpMethod, { code: 6, status: 405 });
    check('GET вместо POST: Allow: POST', wrongHttpMethod.headers.allow === 'POST', JSON.stringify(wrongHttpMethod.headers.allow));

    /* ------------------------------------------- register.do: успех и дубль */
    console.log('— register.do: {orderId, formUrl}, errorCode=0 ≠ оплата, дубль orderNumber -> 1');
    const regOrderNumber = nextOrderNumber('reg');
    const reg = await rest(port, 'register.do', { ...CREDS, orderNumber: regOrderNumber, amount: '10000', returnUrl: 'https://shop.test/ok', failUrl: 'https://shop.test/fail', description: 'Тестовый заказ', jsonParams: JSON.stringify({ callback_url: HOOK_URL }) });
    const regJson = reg.json() || {};
    check('register принят: HTTP 200, errorCode=0, errorMessage пуст', reg.statusCode === 200 && regJson.errorCode === 0 && regJson.errorMessage === '', reg.body.slice(0, 160));
    check('register: orderId — uuid', /^[0-9a-f-]{36}$/i.test(String(regJson.orderId || '')), String(regJson.orderId));
    check('register: formUrl ведёт на платёжную страницу стенда',
      String(regJson.formUrl || '') === `http://mock.test/payment/${regJson.orderId}`, String(regJson.formUrl));
    check('register: DX-hint — errorCode=0 не эквивалент финального статуса оплаты',
      String(regJson.hint || '').includes('не эквивалент финального статуса оплаты'));

    const dup = await rest(port, 'register.do', { ...CREDS, orderNumber: regOrderNumber, amount: '10000', returnUrl: 'https://shop.test/ok' });
    checkError('повтор orderNumber', dup, { code: 1, field: 'orderNumber' });
    check('повтор orderNumber: hint ведёт к прежнему заказу (не replay)',
      String((dup.json() || {}).hint || '').includes(regJson.orderId));

    /* ------------------------------------------- одностадийная оплата (3DS1) */
    console.log('— оплата: formUrl -> карта 3DS1 -> ACS (12345678) -> orderStatus=2 + callback deposited');
    const formPageBefore = await request(port, 'GET', `/payment/${regJson.orderId}`);
    check('форма до оплаты: пресеты тестовых карт, ACS-пароль 12345678, сумма',
      formPageBefore.statusCode === 200 && formPageBefore.body.includes(CARD_3DS1_OK)
      && formPageBefore.body.includes('12345678') && formPageBefore.body.includes('100,00 ₽'));
    const flow1 = await fullFlow(port, { callbackUrl: HOOK_URL, amount: 10000, description: 'Тестовый заказ' });
    check('платёжная страница formUrl открывается (GET /payment/{orderId})', flow1.pay.statusCode === 200 && flow1.pay.body.includes('3-D Secure'),
      `pay HTTP ${flow1.pay.statusCode}`);
    const formPageRes = await request(port, 'GET', `/payment/${flow1.orderId}`);
    check('после оплаты форма показывает состояние заказа (orderStatus=2)',
      formPageRes.statusCode === 200 && formPageRes.body.includes('orderStatus=<b>2</b>'), formPageRes.body.slice(0, 120));
    check('ACS проведён: 302 на returnUrl', flow1.tds && flow1.tds.statusCode === 302 && flow1.tds.headers.location === 'https://shop.test/ok',
      JSON.stringify(flow1.tds && { s: flow1.tds.statusCode, l: flow1.tds.headers.location }));
    check('getOrderStatusExtended: orderStatus=2 (оплата проведена)', flow1.status.orderStatus === 2, JSON.stringify(flow1.status));
    check('статус: actionCode=0 «Одобрено», amount, date — epoch-ms',
      flow1.status.actionCode === 0 && flow1.status.actionCodeDescription === 'Одобрено' && flow1.status.amount === 10000
      && Number.isInteger(flow1.status.date) && flow1.status.date > 1e12);
    check('статус: маска карты first6**last4 и cardAuthCode (PAN не хранится)',
      flow1.status.maskPan === '411111**1111' && /^\d{6}$/.test(String(flow1.status.cardAuthCode || '')),
      JSON.stringify({ maskPan: flow1.status.maskPan, cardAuthCode: flow1.status.cardAuthCode }));
    check('статус: terminalId и orderDescription (эхо description)',
      flow1.status.terminalId === 'ALFA-MOCK-1' && flow1.status.orderDescription === 'Тестовый заказ',
      JSON.stringify({ terminalId: flow1.status.terminalId, orderDescription: flow1.status.orderDescription }));
    check('extended: authorizedAmount=depositedAmount=10000, refundedAmount=0',
      flow1.status.authorizedAmount === 10000 && flow1.status.depositedAmount === 10000 && flow1.status.refundedAmount === 0);
    check('extended: authDate/depositDate — epoch-ms',
      Number.isInteger(flow1.status.authDate) && Number.isInteger(flow1.status.depositDate));

    await waitForCondition(() => hitsFor(flow1.orderId).length >= 1, { description: 'callback deposited' });
    const cb1 = hitsFor(flow1.orderId)[0];
    check('callback доставлен HTTP GET (не POST)', cb1.method === 'GET', cb1.method);
    check('callback GET — без тела', cb1.body === '', cb1.body.slice(0, 60));
    check('callback: mdOrder=orderId, orderNumber, operation=deposited, status=1, amount',
      cb1.query.mdOrder === flow1.orderId && cb1.query.orderNumber === flow1.orderNumber
      && cb1.query.operation === 'deposited' && cb1.query.status === '1' && cb1.query.amount === '10000',
      JSON.stringify(cb1.query));
    check('callback: callbackCreationDate — epoch-миллисекунды', /^\d{13}$/.test(String(cb1.query.callbackCreationDate || '')), String(cb1.query.callbackCreationDate));
    check('callback: checksum — валидный HMAC-SHA256 (независимая проверка), sign_alias отсутствует',
      verifyChecksum(cb1.query, CALLBACK_SECRET) && cb1.query.sign_alias === undefined);
    check('callback: checksum — hex в верхнем регистре', /^[0-9A-F]{64}$/.test(String(cb1.query.checksum || '')));
    const cbEntry1 = Object.values(state.callbacks).find((c) => c.orderId === flow1.orderId);
    await waitForCondition(() => cbEntry1.done === true, { description: 'ACK 200 -> done' });
    check('ACK 200 принят: запись done, попытка одна', cbEntry1.done === true && cbEntry1.attempts === 1, JSON.stringify({ done: cbEntry1.done, attempts: cbEntry1.attempts }));

    /* --------------------------------------------------------- 3DS2 / МИР */
    console.log('— 3DS2 frictionless (без ACS), 3DS2 challenge, МИР 18 цифр');
    const flowFr = await fullFlow(port, { pan: CARD_3DS2_FRICTIONLESS, callbackUrl: HOOK_URL });
    check('frictionless: ACS не требуется — сразу 302 на returnUrl',
      flowFr.pay.statusCode === 302 && flowFr.tds === null && flowFr.status.orderStatus === 2,
      JSON.stringify({ s: flowFr.pay.statusCode, st: flowFr.status.orderStatus }));
    check('frictionless: маска 18-значной карты МИР first6**last4', flowFr.status.maskPan === '220138**0062', String(flowFr.status.maskPan));

    const flowCh = await fullFlow(port, { pan: CARD_3DS2_CHALLENGE, callbackUrl: HOOK_URL });
    check('3DS2 challenge: страница ACS (подтверждение плательщика)',
      flowCh.pay.statusCode === 200 && flowCh.pay.body.includes('3DS 2.0 (challenge)'));
    check('3DS2 challenge: пароль 12345678 -> orderStatus=2', flowCh.status.orderStatus === 2);

    const flowMir = await fullFlow(port, { pan: CARD_MIR_3DS1, callbackUrl: HOOK_URL });
    check('МИР 639002000000000003 (3DS1): успех, orderStatus=2', flowMir.status.orderStatus === 2);

    /* ------------------------------------------------------ отказные карты */
    console.log('— отказы: -2011 (PaRes=U), 116 (недостаточно средств), 71015 (неверные данные / ACS Fail)');
    const flowParU = await fullFlow(port, { pan: CARD_DECLINE_PAR_U, failUrl: 'https://shop.test/fail', callbackUrl: HOOK_URL });
    check('-2011: после ACS заказ отклонён (orderStatus=6), редирект на failUrl',
      flowParU.status.orderStatus === 6 && flowParU.tds.statusCode === 302 && flowParU.tds.headers.location === 'https://shop.test/fail',
      JSON.stringify({ st: flowParU.status.orderStatus, loc: flowParU.tds && flowParU.tds.headers.location }));
    check('-2011: actionCode=-2011 с описанием PaRes=U',
      flowParU.status.actionCode === -2011 && String(flowParU.status.actionCodeDescription).includes('PaRes=U'),
      JSON.stringify({ ac: flowParU.status.actionCode, d: flowParU.status.actionCodeDescription }));
    await waitForCondition(() => hitsFor(flowParU.orderId).length >= 1, { description: 'callback отказа' });
    const cbDecl = hitsFor(flowParU.orderId)[0];
    check('отказ: callback declinedCardpresent status=0 (семантика операции — форк мока, задокументирован)',
      cbDecl.query.operation === 'declinedCardpresent' && cbDecl.query.status === '0' && verifyChecksum(cbDecl.query, CALLBACK_SECRET),
      JSON.stringify(cbDecl.query));

    const flowFunds = await fullFlow(port, { pan: CARD_DECLINE_FUNDS, cvv: '521', callbackUrl: HOOK_URL });
    check('116: недостаточно средств (CVV 521), actionCode=116', flowFunds.status.orderStatus === 6 && flowFunds.status.actionCode === 116,
      JSON.stringify({ st: flowFunds.status.orderStatus, ac: flowFunds.status.actionCode }));

    const flowAcsFail = await fullFlow(port, { tdsPassword: null, callbackUrl: HOOK_URL });
    check('ACS Fail: отказ 71015 «введённая информация неверна»',
      flowAcsFail.status.orderStatus === 6 && flowAcsFail.status.actionCode === 71015
      && String(flowAcsFail.status.actionCodeDescription).includes('Fail'),
      JSON.stringify({ st: flowAcsFail.status.orderStatus, ac: flowAcsFail.status.actionCode, d: flowAcsFail.status.actionCodeDescription }));

    const flowAcsBadPass = await fullFlow(port, { tdsPassword: '00000000', callbackUrl: HOOK_URL });
    check('неверный пароль ACS: отказ 71015', flowAcsBadPass.status.orderStatus === 6 && flowAcsBadPass.status.actionCode === 71015);

    const flowBadCvv = await fullFlow(port, { cvv: '999' });
    check('неверный CVV на тестовой карте: 71015 без ACS', flowBadCvv.status.orderStatus === 6 && flowBadCvv.status.actionCode === 71015 && flowBadCvv.tds === null);

    const flowBadExp = await fullFlow(port, { exp: '1235' });
    check('неверный срок на тестовой карте: 71015', flowBadExp.status.orderStatus === 6 && flowBadExp.status.actionCode === 71015);

    const flowExpired = await fullFlow(port, { exp: '0120' });
    check('просроченная карта: 71015', flowExpired.status.orderStatus === 6 && flowExpired.status.actionCode === 71015
      && String(flowExpired.status.actionCodeDescription).includes('просрочена'));

    const flowUnknownOk = await fullFlow(port, { pan: CARD_UNKNOWN_LUHN_OK });
    check('неизвестный валидный PAN: отказ эмитента (actionCode=5), не успех',
      flowUnknownOk.status.orderStatus === 6 && flowUnknownOk.status.actionCode === 5
      && String(flowUnknownOk.status.actionCodeDescription).includes('тестовым картам'),
      JSON.stringify({ ac: flowUnknownOk.status.actionCode, d: flowUnknownOk.status.actionCodeDescription }));

    const flowUnknownBad = await fullFlow(port, { pan: CARD_UNKNOWN_LUHN_BAD });
    check('PAN без контрольной суммы Луна: 71015', flowUnknownBad.status.orderStatus === 6 && flowUnknownBad.status.actionCode === 71015);

    const flowSslOff = await fullFlow(port, { pan: CARD_SSL });
    check('карта без 3DS при выключенном SSL-разрешении: отказ (actionCode=5, SSL)',
      flowSslOff.status.orderStatus === 6 && flowSslOff.status.actionCode === 5
      && String(flowSslOff.status.actionCodeDescription).includes('SSL'),
      JSON.stringify({ ac: flowSslOff.status.actionCode, d: flowSslOff.status.actionCodeDescription }));

    console.log('— валидация формы: держатель карты (два слова латиницей), формат полей');
    const formOrderNumber = nextOrderNumber('frm');
    const formReg = await rest(port, 'register.do', { ...CREDS, orderNumber: formOrderNumber, amount: '5000', returnUrl: 'https://shop.test/ok' });
    const formOrderId = (formReg.json() || {}).orderId;
    const badHolder = await request(port, 'POST', `/payment/${formOrderId}/pay`, form({ pan: CARD_3DS1_OK, exp: '1234', cvv: '123', cardholder: 'IVAN' }));
    check('держатель из одного слова: ошибка формы, заказ не оплачен',
      badHolder.statusCode === 200 && badHolder.body.includes('два слова латиницей'));
    const cyrHolder = await request(port, 'POST', `/payment/${formOrderId}/pay`, form({ pan: CARD_3DS1_OK, exp: '1234', cvv: '123', cardholder: 'ИВАН ИВАНОВ' }));
    check('держатель кириллицей: ошибка формы (тестовый контур — латиница)', cyrHolder.statusCode === 200 && cyrHolder.body.includes('два слова латиницей'));
    const badPan = await request(port, 'POST', `/payment/${formOrderId}/pay`, form({ pan: '12345', exp: '1234', cvv: '123', cardholder: 'IVAN IVANOV' }));
    check('короткий PAN: ошибка формы «13–19 цифр»', badPan.statusCode === 200 && badPan.body.includes('13–19 цифр'));
    const badExpFormat = await request(port, 'POST', `/payment/${formOrderId}/pay`, form({ pan: CARD_3DS1_OK, exp: '12/34', cvv: '123', cardholder: 'IVAN IVANOV' }));
    check('срок не MMYY: ошибка формы', badExpFormat.statusCode === 200 && badExpFormat.body.includes('MMYY'));
    const badCvvFormat = await request(port, 'POST', `/payment/${formOrderId}/pay`, form({ pan: CARD_3DS1_OK, exp: '1234', cvv: '12', cardholder: 'IVAN IVANOV' }));
    check('CVV не 3 цифры: ошибка формы', badCvvFormat.statusCode === 200 && badCvvFormat.body.includes('3 цифры'));
    const stForm = await rest(port, 'getOrderStatus.do', { ...CREDS, orderId: formOrderId });
    check('после ошибок формы заказ остаётся orderStatus=0 (не оплачен)', (stForm.json() || {}).orderStatus === 0);
    const payAgain = await request(port, 'POST', `/payment/${formOrderId}/pay`, form({ pan: CARD_3DS2_FRICTIONLESS, exp: '1234', cvv: '123', cardholder: 'IVAN IVANOV' }));
    check('форма доступна повторно: frictionless-оплата проходит', payAgain.statusCode === 302 && payAgain.headers.location === 'https://shop.test/ok');
    const payAfterDone = await request(port, 'POST', `/payment/${formOrderId}/pay`, form({ pan: CARD_3DS1_OK, exp: '1234', cvv: '123', cardholder: 'IVAN IVANOV' }));
    check('оплата завершённого заказа: 404 «сессия не найдена или завершена»',
      payAfterDone.statusCode === 404 && payAfterDone.body.includes('завершена'));
    const unknownForm = await request(port, 'GET', '/payment/00000000-0000-4000-8000-000000000000');
    check('форма неизвестного заказа: 404', unknownForm.statusCode === 404 && unknownForm.body.includes('Заказ не найден'));

    /* ------------------------------------------------- двухстадийная схема */
    console.log('— двухстадийная схема: registerPreAuth -> холд -> deposit ≤ авторизации');
    const flow2 = await fullFlow(port, { op: 'registerPreAuth.do', callbackUrl: HOOK_URL, amount: 10000 });
    check('registerPreAuth: orderId + formUrl (errorCode=0)', flow2.regJson.errorCode === 0 && Boolean(flow2.orderId));
    check('холд: orderStatus=1, authorizedAmount=10000, depositedAmount=0',
      flow2.status.orderStatus === 1 && flow2.status.authorizedAmount === 10000 && flow2.status.depositedAmount === 0,
      JSON.stringify(flow2.status));
    await waitForCondition(() => hitsFor(flow2.orderId).some((h) => h.query.operation === 'approved'), { description: 'callback approved' });
    const cbApproved = hitsFor(flow2.orderId).find((h) => h.query.operation === 'approved');
    check('холд: callback approved status=1, checksum валиден',
      cbApproved.query.status === '1' && cbApproved.query.amount === '10000' && verifyChecksum(cbApproved.query, CALLBACK_SECRET));

    const depBig = await rest(port, 'deposit.do', { ...CREDS, orderId: flow2.orderId, amount: '20000' });
    checkError('deposit больше авторизованной суммы', depBig, { code: 5, field: 'amount' });
    check('deposit>auth: сообщение называет суммы', String((depBig.json() || {}).errorMessage).includes('20000') && String((depBig.json() || {}).errorMessage).includes('10000'));

    const depBad = await rest(port, 'deposit.do', { ...CREDS, orderId: flow2.orderId, amount: 'abc' });
    checkError('deposit с некорректной суммой', depBad, { code: 5, field: 'amount' });

    const depPartial = await rest(port, 'deposit.do', { ...CREDS, orderId: flow2.orderId, amount: '6000' });
    check('частичный deposit 6000 ≤ 10000: errorCode=0', (depPartial.json() || {}).errorCode === 0, depPartial.body.slice(0, 120));
    const st2 = await rest(port, 'getOrderStatusExtended.do', { ...CREDS, orderId: flow2.orderId });
    const st2j = st2.json() || {};
    check('после частичного deposit: orderStatus=2, deposited=6000, authorized=10000',
      st2j.orderStatus === 2 && st2j.depositedAmount === 6000 && st2j.authorizedAmount === 10000, JSON.stringify(st2j));
    await waitForCondition(() => hitsFor(flow2.orderId).some((h) => h.query.operation === 'deposited'), { description: 'callback deposited (частичный)' });
    const cbDep = hitsFor(flow2.orderId).find((h) => h.query.operation === 'deposited');
    check('частичный deposit: callback deposited amount=6000', cbDep.query.amount === '6000' && cbDep.query.status === '1');

    const depTwice = await rest(port, 'deposit.do', { ...CREDS, orderId: flow2.orderId, amount: '1000' });
    checkError('повторный deposit', depTwice, { code: 4, field: 'orderId' });

    const depOnOneStage = await rest(port, 'deposit.do', { ...CREDS, orderId: flow1.orderId, amount: '100' });
    checkError('deposit на одностадийный заказ', depOnOneStage, { code: 4 });
    check('deposit на одностадийный: hint объясняет разницу схем',
      String((depOnOneStage.json() || {}).hint || '').includes('registerPreAuth.do'));

    const unpaidPreAuthNumber = nextOrderNumber('upa');
    const unpaidPreAuth = await rest(port, 'registerPreAuth.do', { ...CREDS, orderNumber: unpaidPreAuthNumber, amount: '3000', returnUrl: 'https://shop.test/ok' });
    check('registerPreAuth неоплаченного заказа принят (для негативов)', (unpaidPreAuth.json() || {}).errorCode === 0);
    const depUnpaid = await rest(port, 'deposit.do', { ...CREDS, orderNumber: unpaidPreAuthNumber, amount: '100' });
    checkError('deposit неоплаченного холд-заказа (по orderNumber)', depUnpaid, { code: 4 });
    check('deposit неоплаченного: hint объясняет, что нужен холд (orderStatus=1)',
      String((depUnpaid.json() || {}).hint || '').includes('orderStatus=1'));

    /* ------------------------------------------------------------ reverse */
    console.log('— reverse: отмена холда и отмена оплаты до расчётов');
    const flowRev1 = await fullFlow(port, { op: 'registerPreAuth.do', callbackUrl: HOOK_URL, amount: 7000 });
    const rev1 = await rest(port, 'reverse.do', { ...CREDS, orderId: flowRev1.orderId });
    check('reverse холда: errorCode=0', (rev1.json() || {}).errorCode === 0, rev1.body.slice(0, 120));
    const stRev1 = await rest(port, 'getOrderStatusExtended.do', { ...CREDS, orderId: flowRev1.orderId });
    check('reverse холда: orderStatus=3, reverseDate', (stRev1.json() || {}).orderStatus === 3 && Number.isInteger((stRev1.json() || {}).reverseDate));
    await waitForCondition(() => hitsFor(flowRev1.orderId).some((h) => h.query.operation === 'reversed'), { description: 'callback reversed' });
    const cbRev = hitsFor(flowRev1.orderId).find((h) => h.query.operation === 'reversed');
    check('reverse: callback reversed status=1 amount=7000 (сумма холда)',
      cbRev.query.status === '1' && cbRev.query.amount === '7000' && verifyChecksum(cbRev.query, CALLBACK_SECRET));

    const rev1Twice = await rest(port, 'reverse.do', { ...CREDS, orderId: flowRev1.orderId });
    checkError('повторный reverse', rev1Twice, { code: 4 });

    const flowRev2 = await fullFlow(port, { op: 'register.do', callbackUrl: HOOK_URL, amount: 4000 });
    const rev2 = await rest(port, 'reverse.do', { ...CREDS, orderId: flowRev2.orderId });
    check('reverse одностадийной оплаты (orderStatus=2): errorCode=0', (rev2.json() || {}).errorCode === 0);
    const stRev2 = await rest(port, 'getOrderStatus.do', { ...CREDS, orderId: flowRev2.orderId });
    check('reverse оплаты: orderStatus=3', (stRev2.json() || {}).orderStatus === 3);

    const revUnpaid = await rest(port, 'reverse.do', { ...CREDS, orderNumber: regOrderNumber });
    checkError('reverse неоплаченного заказа', revUnpaid, { code: 4 });

    /* ------------------------------------------------------------- refund */
    console.log('— refund: полный и частичные возвраты, лимит по списанному');
    const flowRef = await fullFlow(port, { op: 'register.do', callbackUrl: HOOK_URL, amount: 10000 });
    const refBig = await rest(port, 'refund.do', { ...CREDS, orderId: flowRef.orderId, amount: '10001' });
    checkError('refund больше списанного', refBig, { code: 5, field: 'amount' });
    check('refund>deposited: сообщение называет доступный остаток', String((refBig.json() || {}).errorMessage).includes('10000'));

    const refNoAmount = await rest(port, 'refund.do', { ...CREDS, orderId: flowRef.orderId });
    checkError('refund без amount', refNoAmount, { code: 5, field: 'amount' });

    const ref1 = await rest(port, 'refund.do', { ...CREDS, orderId: flowRef.orderId, amount: '3000' });
    check('частичный refund 3000: errorCode=0', (ref1.json() || {}).errorCode === 0, ref1.body.slice(0, 120));
    const stRef1 = await rest(port, 'getOrderStatusExtended.do', { ...CREDS, orderId: flowRef.orderId });
    check('после частичного возврата: orderStatus=4, refundedAmount=3000',
      (stRef1.json() || {}).orderStatus === 4 && (stRef1.json() || {}).refundedAmount === 3000);
    const ref2 = await rest(port, 'refund.do', { ...CREDS, orderId: flowRef.orderId, amount: '3000' });
    check('второй частичный refund 3000: errorCode=0 (накопительно 6000)', (ref2.json() || {}).errorCode === 0);
    const ref3 = await rest(port, 'refund.do', { ...CREDS, orderId: flowRef.orderId, amount: '5000' });
    checkError('refund сверх остатка (4000)', ref3, { code: 5 });
    const ref4 = await rest(port, 'refund.do', { ...CREDS, orderId: flowRef.orderId, amount: '4000' });
    check('возврат остатка 4000: errorCode=0', (ref4.json() || {}).errorCode === 0);
    const stRef2 = await rest(port, 'getOrderStatusExtended.do', { ...CREDS, orderId: flowRef.orderId });
    check('итог: refundedAmount=10000, depositedAmount=10000',
      (stRef2.json() || {}).refundedAmount === 10000 && (stRef2.json() || {}).depositedAmount === 10000);
    await waitForCondition(() => hitsFor(flowRef.orderId).filter((h) => h.query.operation === 'refunded').length >= 3, { description: '3 callback refunded' });
    const cbRefs = hitsFor(flowRef.orderId).filter((h) => h.query.operation === 'refunded');
    check('каждый возврат — свой callback refunded (3000/3000/4000, status=1)',
      cbRefs.map((h) => h.query.amount).sort().join(',') === '3000,3000,4000' && cbRefs.every((h) => h.query.status === '1' && verifyChecksum(h.query, CALLBACK_SECRET)),
      JSON.stringify(cbRefs.map((h) => h.query.amount)));
    const refAfterReverse = await rest(port, 'refund.do', { ...CREDS, orderId: flowRev1.orderId, amount: '100' });
    checkError('refund после reverse (orderStatus=3)', refAfterReverse, { code: 4 });

    const flowRefHold = await fullFlow(port, { op: 'registerPreAuth.do', callbackUrl: null, amount: 2000 });
    const refOnHold = await rest(port, 'refund.do', { ...CREDS, orderId: flowRefHold.orderId, amount: '100' });
    checkError('refund на холд (orderStatus=1)', refOnHold, { code: 4 });
    check('refund на холд: hint направляет к deposit/reverse',
      String((refOnHold.json() || {}).hint || '').includes('deposit.do') && String((refOnHold.json() || {}).hint || '').includes('reverse.do'));
    const refUnpaid = await rest(port, 'refund.do', { ...CREDS, orderId: regJson.orderId, amount: '100' });
    checkError('refund неоплаченного заказа', refUnpaid, { code: 4 });

    /* ------------------------------------------------ getOrderStatus: поиск */
    console.log('— getOrderStatus(Extended).do: orderId/orderNumber, неизвестный заказ');
    const stByNumber = await rest(port, 'getOrderStatus.do', { ...CREDS, orderNumber: flow1.orderNumber });
    check('getOrderStatus по orderNumber находит заказ', (stByNumber.json() || {}).orderId === flow1.orderId);
    const stBase = stByNumber.json() || {};
    check('базовый getOrderStatus: без сумм авторизации/списания (они — в Extended)',
      stBase.authorizedAmount === undefined && stBase.depositedAmount === undefined && stBase.orderStatus === 2,
      JSON.stringify(Object.keys(stBase)));
    const stUnknown = await rest(port, 'getOrderStatus.do', { ...CREDS, orderId: '00000000-0000-4000-8000-000000000000' });
    checkError('неизвестный orderId', stUnknown, { code: 3, field: 'orderId' });
    const stUnknownNumber = await rest(port, 'getOrderStatusExtended.do', { ...CREDS, orderNumber: 'no-such-order' });
    checkError('неизвестный orderNumber', stUnknownNumber, { code: 3, field: 'orderNumber' });
    const stNoId = await rest(port, 'getOrderStatus.do', { ...CREDS });
    checkError('без orderId и orderNumber', stNoId, { code: 3, field: 'orderId, orderNumber' });
    const stUnpaid = await rest(port, 'getOrderStatusExtended.do', { ...CREDS, orderId: regJson.orderId });
    check('неоплаченный заказ: orderStatus=0, actionCode=0, описание статуса',
      (stUnpaid.json() || {}).orderStatus === 0 && (stUnpaid.json() || {}).actionCode === 0
      && String((stUnpaid.json() || {}).actionCodeDescription).includes('зарегистрирован'));

    /* --------------------------------------------- callback: ретраи и ACK */
    console.log('— callback: ретраи до HTTP 200, ACK ровно 200 (204 — не успех), дубли, подавление');
    const flowFlaky = await fullFlow(port, { pan: CARD_3DS2_FRICTIONLESS, callbackUrl: FLAKY_URL, amount: 2500 });
    const flakyEntry = Object.values(state.callbacks).find((c) => c.orderId === flowFlaky.orderId);
    await waitForCondition(() => flakyEntry.done === true, { timeoutMs: 10000, description: 'ретрай до 200' });
    check('первая доставка 500 -> ретрай: attempts ≥ 2, итог done', flakyEntry.attempts >= 2 && flakyEntry.done === true,
      JSON.stringify({ attempts: flakyEntry.attempts, done: flakyEntry.done }));
    check('ретраи шли до HTTP 200 (последний статус 200)', flakyEntry.lastStatus === 200, String(flakyEntry.lastStatus));
    check('приёмник получил обе попытки (500 и 200) с одним mdOrder', hitsFor(flowFlaky.orderId).length >= 2);

    const flowNoack = await fullFlow(port, { pan: CARD_3DS2_FRICTIONLESS, callbackUrl: NOACK_URL, amount: 1500 });
    const noackEntry = Object.values(state.callbacks).find((c) => c.orderId === flowNoack.orderId);
    await waitForCondition(() => noackEntry.dumped === true, { timeoutMs: 12000, description: 'dump после лимита попыток' });
    check('ACK 204 НЕ засчитан: запись не done, ретраи до лимита и dumped',
      noackEntry.done !== true && noackEntry.dumped === true && noackEntry.attempts >= 4,
      JSON.stringify({ done: noackEntry.done, dumped: noackEntry.dumped, attempts: noackEntry.attempts, lastStatus: noackEntry.lastStatus }));
    check('204 зафиксирован как последний статус доставки', noackEntry.lastStatus === 204, String(noackEntry.lastStatus));

    const flowDup = await fullFlow(port, { pan: CARD_3DS2_FRICTIONLESS, callbackUrl: HOOK_URL, payHeaders: { 'X-Mock-Scenario': 'webhook-duplicate' }, amount: 1200 });
    await waitForCondition(() => hitsFor(flowDup.orderId).length >= 2, { description: 'две копии callback' });
    check('webhook-duplicate: две копии уведомления с одним mdOrder', hitsFor(flowDup.orderId).length === 2,
      String(hitsFor(flowDup.orderId).length));
    check('дубли подписаны одинаково (приёмник обязан быть идемпотентным)',
      hitsFor(flowDup.orderId)[0].query.checksum === hitsFor(flowDup.orderId)[1].query.checksum);

    const flowDrop = await fullFlow(port, { pan: CARD_3DS2_FRICTIONLESS, callbackUrl: HOOK_URL, payHeaders: { 'X-Mock-Scenario': 'webhook-drop' }, amount: 1100 });
    await sleep(1500);
    check('webhook-drop: уведомление подавлено (0 доставок), сверка через REST',
      hitsFor(flowDrop.orderId).length === 0 && flowDrop.status.orderStatus === 2);
    const dropEntry = Object.values(state.callbacks).find((c) => c.orderId === flowDrop.orderId);
    check('webhook-drop: запись suppressed видна в состоянии', dropEntry && dropEntry.suppressed === true);

    console.log('— callback без адреса: уведомление не уходит, заказ сверяется через REST');
    const flowNoCb = await fullFlow(port, { pan: CARD_3DS2_FRICTIONLESS, callbackUrl: null, amount: 900 });
    await sleep(1200);
    check('без callback_url/MOCK_DEFAULT_CALLBACK_URL: доставок нет, orderStatus=2',
      hitsFor(flowNoCb.orderId).length === 0 && flowNoCb.status.orderStatus === 2);

    /* ------------------------------------------------- sessionTimeoutSecs */
    console.log('— sessionTimeoutSecs: истечение по виртуальным часам -> declinedByTimeout');
    const timeoutReg = await rest(port, 'register.do', { ...CREDS, orderNumber: nextOrderNumber('tmo'), amount: '800', returnUrl: 'https://shop.test/ok', sessionTimeoutSecs: '30', jsonParams: JSON.stringify({ callback_url: HOOK_URL }) });
    const timeoutOrderId = (timeoutReg.json() || {}).orderId;
    check('заказ с sessionTimeoutSecs=30 зарегистрирован', (timeoutReg.json() || {}).errorCode === 0 && Boolean(timeoutOrderId));
    const adv = await request(port, 'POST', '/mock/time', { advance: '+31s' });
    check('POST /mock/time advance +31s принят', adv.statusCode === 200 && adv.json().offsetMs > 0, JSON.stringify(adv.json() && adv.json().offsetMs));
    await waitForCondition(() => hitsFor(timeoutOrderId).some((h) => h.query.operation === 'declinedByTimeout'), { description: 'callback declinedByTimeout' });
    const stTimeout = await rest(port, 'getOrderStatusExtended.do', { ...CREDS, orderId: timeoutOrderId });
    check('истёк sessionTimeoutSecs: orderStatus=6, описание «Истёк срок оплаты»',
      (stTimeout.json() || {}).orderStatus === 6 && String((stTimeout.json() || {}).actionCodeDescription).includes('Истёк срок оплаты'),
      JSON.stringify(stTimeout.json() && { st: stTimeout.json().orderStatus, d: stTimeout.json().actionCodeDescription }));
    const cbTimeout = hitsFor(timeoutOrderId).find((h) => h.query.operation === 'declinedByTimeout');
    check('declinedByTimeout: status=0, checksum валиден', cbTimeout.query.status === '0' && verifyChecksum(cbTimeout.query, CALLBACK_SECRET));
    const payExpired = await request(port, 'POST', `/payment/${timeoutOrderId}/pay`, form({ pan: CARD_3DS1_OK, exp: '1234', cvv: '123', cardholder: 'IVAN IVANOV' }));
    check('оплата просроченного заказа невозможна (404)', payExpired.statusCode === 404);
    const formExpired = await request(port, 'GET', `/payment/${timeoutOrderId}`);
    check('форма просроченного заказа показывает отказ', formExpired.statusCode === 200 && formExpired.body.includes('Оплата отклонена'));
    await request(port, 'POST', '/mock/time', { reset: true });

    /* ---------------------------------------------------- сценарии и chaos */
    console.log('— сценарии: fail (errorCode 6, HTTP 200), hang, latency, http-500/504, правила /mock/scenarios');
    const failOrderNumber = nextOrderNumber('failsc');
    const failRes = await rest(port, 'register.do', { ...CREDS, orderNumber: failOrderNumber, amount: '1000', returnUrl: 'https://shop.test/ok' }, { 'X-Mock-Scenario': 'fail' });
    checkError('X-Mock-Scenario: fail на register.do', failRes, { code: 6 });
    check('fail: errorMessage отмечает симуляцию', String((failRes.json() || {}).errorMessage).includes('смоделирована'));
    const failAfter = await rest(port, 'register.do', { ...CREDS, orderNumber: failOrderNumber, amount: '1000', returnUrl: 'https://shop.test/ok' });
    check('fail не создал заказ: тот же orderNumber регистрируется', (failAfter.json() || {}).errorCode === 0, failAfter.body.slice(0, 120));

    const hangRes = await requestHang(port, 'POST', '/payment/rest/getOrderStatus.do', form({ ...CREDS, orderId: flow1.orderId }), { 'X-Mock-Scenario': 'hang' });
    check('X-Mock-Scenario: hang — ответ не приходит (клиент таймаутится)', hangRes.timedOut === true, JSON.stringify(hangRes));

    const t0 = Date.now();
    const latRes = await rest(port, 'register.do', { ...CREDS, orderNumber: nextOrderNumber('lat'), amount: '1000', returnUrl: 'https://shop.test/ok' }, { 'X-Mock-Scenario': 'latency:1200ms' });
    const elapsed = Date.now() - t0;
    check('X-Mock-Scenario: latency:1200ms задерживает ответ (≥1100 мс) и не ломает его',
      elapsed >= 1100 && (latRes.json() || {}).errorCode === 0, `${elapsed}ms`);

    const err500 = await rest(port, 'getOrderStatus.do', { ...CREDS, orderId: flow1.orderId }, { 'X-Mock-Scenario': 'http-500' });
    checkError('X-Mock-Scenario: http-500 — честный HTTP 500 + errorCode 6', err500, { code: 6, status: 500 });
    const err504 = await rest(port, 'getOrderStatus.do', { ...CREDS, orderId: flow1.orderId }, { 'X-Mock-Scenario': 'http-504' });
    checkError('X-Mock-Scenario: http-504 — честный HTTP 504 + errorCode 6', err504, { code: 6, status: 504 });

    const ruleAdd = await request(port, 'POST', '/mock/scenarios', { scenario: 'fail', target: 'deposit', times: 1 });
    check('POST /mock/scenarios: правило fail на target=deposit (times=1)', ruleAdd.statusCode === 200 && ruleAdd.json().ok === true, ruleAdd.body.slice(0, 120));
    const flowRule = await fullFlow(port, { op: 'registerPreAuth.do', callbackUrl: null, amount: 2200 });
    const depRuleFail = await rest(port, 'deposit.do', { ...CREDS, orderId: flowRule.orderId, amount: '2200' });
    check('правило сработало: первый deposit — errorCode 6', (depRuleFail.json() || {}).errorCode === 6, depRuleFail.body.slice(0, 120));
    const depRuleOk = await rest(port, 'deposit.do', { ...CREDS, orderId: flowRule.orderId, amount: '2200' });
    check('times=1 исчерпан: второй deposit успешен', (depRuleOk.json() || {}).errorCode === 0);
    const rulesGet = await request(port, 'GET', '/mock/scenarios');
    check('GET /mock/scenarios: правила и история срабатываний',
      rulesGet.statusCode === 200 && Array.isArray(rulesGet.json().rules) && Array.isArray(rulesGet.json().history) && rulesGet.json().history.length >= 1);
    const ruleBad = await request(port, 'POST', '/mock/scenarios', { target: 'deposit' });
    check('POST /mock/scenarios без scenario: 400 с DX-hint', ruleBad.statusCode === 400 && Boolean((ruleBad.json() || {}).hint));
    const rulesDel = await request(port, 'DELETE', '/mock/scenarios');
    check('DELETE /mock/scenarios очищает правила', rulesDel.statusCode === 200 && rulesDel.json().rules.length === 0);

    // #52 PA-51/PG-04/PB-13/PG-09: сценарии, история и журнал — per-sandbox.
    {
      const isoA = { 'X-Mock-Sandbox': 'sc52-a' };
      const isoB = { 'X-Mock-Sandbox': 'sc52-b' };
      await request(port, 'POST', '/mock/scenarios', { scenario: 'fail', target: 'register', persistent: true }, isoA);
      const seenByB = await request(port, 'GET', '/mock/scenarios', undefined, isoB);
      check('#52: правила песочницы A не видны B', seenByB.json().rules.length === 0 && seenByB.json().history.length === 0);
      const orderB = nextOrderNumber('sc52b');
      const regB = await rest(port, 'register.do', { ...CREDS, orderNumber: orderB, amount: '2000', returnUrl: 'https://shop.test/ok' }, isoB);
      check('#52 PG-04: правило A не срабатывает на register B', (regB.json() || {}).errorCode === 0, regB.body.slice(0, 120));
      const orderB2 = nextOrderNumber('sc52bh');
      await rest(port, 'register.do', { ...CREDS, orderNumber: orderB2, amount: '2000', returnUrl: 'https://shop.test/ok' }, { ...isoB, 'X-Mock-Scenario': 'webhook-drop' });
      const orderA = nextOrderNumber('sc52a');
      await rest(port, 'register.do', { ...CREDS, orderNumber: orderA, amount: '2000', returnUrl: 'https://shop.test/ok' }, isoA);
      const histA = await request(port, 'GET', '/mock/scenarios', undefined, isoA);
      const histB = await request(port, 'GET', '/mock/scenarios', undefined, isoB);
      check('#52: история B не видна A, своя история у B есть', histB.json().history.length >= 1
        && !JSON.stringify(histA.json().history).includes(orderB2));
      const journalA = await request(port, 'GET', '/admin/journal', undefined, isoA);
      const journalB = await request(port, 'GET', '/admin/journal', undefined, isoB);
      check('#52 PB-13: журнал A видит только свои записи, B — свои', journalA.body.includes(orderA)
        && !journalA.body.includes(orderB) && journalB.body.includes(orderB) && !journalB.body.includes(orderA));
      await request(port, 'POST', '/mock/scenarios', { id: 'sc52-own', scenario: 'webhook-drop', persistent: true }, isoB);
      await request(port, 'POST', '/mock/reset', {}, isoA);
      const afterResetA = await request(port, 'GET', '/mock/scenarios', undefined, isoA);
      const afterResetB = await request(port, 'GET', '/mock/scenarios', undefined, isoB);
      const journalAfterB = await request(port, 'GET', '/admin/journal', undefined, isoB);
      check('#52 PG-09/PB-13: reset A очистил только A, правила/история/журнал B целы', afterResetA.json().rules.length === 0
        && afterResetB.json().rules.some((r) => r.id === 'sc52-own') && journalAfterB.body.includes(orderB));
      const tooBig = await request(port, 'POST', '/mock/scenarios', { scenario: 'fail', match: { pad: 'x'.repeat(9000) } }, isoA);
      check('#52: правило >8 KiB -> 400 + code rule_too_large', tooBig.statusCode === 400 && tooBig.json().code === 'rule_too_large', tooBig.body.slice(0, 140));
      await request(port, 'POST', '/mock/scenarios', { id: 'sc52-upd', scenario: 'fail', persistent: true }, isoA);
      await request(port, 'POST', '/mock/scenarios', { id: 'sc52-upd', scenario: 'webhook-drop', persistent: true }, isoA);
      const updBig = await request(port, 'POST', '/mock/scenarios', { id: 'sc52-upd', scenario: 'fail', match: { pad: 'x'.repeat(9000) } }, isoA);
      const updList = await request(port, 'GET', '/mock/scenarios', undefined, isoA);
      check('#52: update правила по id; oversized update -> 400 без затирания старого', updBig.statusCode === 400
        && updBig.json().code === 'rule_too_large' && updList.json().rules.filter((r) => r.id === 'sc52-upd').length === 1
        && updList.json().rules.find((r) => r.id === 'sc52-upd').scenario === 'webhook-drop');
      await request(port, 'DELETE', '/mock/scenarios', undefined, isoA);
      let capStatus = 0;
      for (let i = 0; i < 200; i += 1) {
        capStatus = (await request(port, 'POST', '/mock/scenarios', { id: `sc52-cap-${i}`, scenario: 'fail', persistent: true }, isoA)).statusCode;
      }
      const capOver = await request(port, 'POST', '/mock/scenarios', { id: 'sc52-cap-200', scenario: 'fail' }, isoA);
      const capList = await request(port, 'GET', '/mock/scenarios', undefined, isoA);
      check('#52: cap 200 правил на песочницу; 201-е -> 400 + code rule_cap_exceeded', capStatus === 200
        && capOver.statusCode === 400 && capOver.json().code === 'rule_cap_exceeded' && capList.json().rules.length === 200);
      await request(port, 'DELETE', '/mock/scenarios', undefined, isoB);
    }

    /* --------------------------------------- журнал, редакция, PAN (F-09/10) */
    console.log('— журнал /payment/rest: curl form-urlencoded, креды редактированы, PAN не хранится');
    const journalRes = await request(port, 'GET', '/admin/journal');
    const entries = (journalRes.json() || {}).entries || [];
    check('журнал содержит POST /payment/rest/register.do со статусом 200',
      entries.some((e) => e.method === 'POST' && e.path === '/payment/rest/register.do' && e.status === 200));
    const regEntry = entries.filter((e) => e.path === '/payment/rest/register.do').pop();
    check('журнал: креды в выжимке тела редактированы ([REDACTED])',
      regEntry && regEntry.body && regEntry.body.password === '[REDACTED]' && regEntry.body.userName === '[REDACTED]',
      JSON.stringify(regEntry && regEntry.body));
    check('журнал: curl-сниппет — form-urlencoded и password=[REDACTED]',
      regEntry && String(regEntry.curl || '').includes('application/x-www-form-urlencoded')
      && String(regEntry.curl || '').includes('password=[REDACTED]') && String(regEntry.curl || '').includes('--data'),
      String(regEntry && regEntry.curl || '').slice(0, 120));
    check('журнал: только /payment/rest/* (платёжная форма не журналируется)',
      entries.every((e) => String(e.path).startsWith('/payment/rest/')),
      JSON.stringify(entries.map((e) => e.path).filter((p) => !String(p).startsWith('/payment/rest/'))));
    const journalText = JSON.stringify(entries);
    const allPans = Object.keys(mod.CARDS);
    check('в журнале нет полных PAN тестовых карт', allPans.every((pan) => !journalText.includes(pan)));
    const stateText = JSON.stringify(state);
    check('в состоянии нет полных PAN (только маска first6**last4) — F-10',
      allPans.every((pan) => !stateText.includes(pan)) && stateText.includes('411111**1111'));

    /* ------------------------------------------- namespaces-песочницы (F-11) */
    console.log('— песочницы (namespaces): изоляция, formUrl c ?sandbox=, health по арендатору');
    const sbxHeaders = { 'X-Mock-Sandbox': 'sbx-ci' };
    const sbxReg = await rest(port, 'register.do', { ...CREDS, orderNumber: nextOrderNumber('sbx'), amount: '1500', returnUrl: 'https://shop.test/ok' }, sbxHeaders);
    const sbxRegJson = sbxReg.json() || {};
    check('register в песочнице sbx-ci: errorCode=0', sbxRegJson.errorCode === 0, sbxReg.body.slice(0, 120));
    check('formUrl песочницы содержит ?sandbox=sbx-ci', String(sbxRegJson.formUrl || '').endsWith('?sandbox=sbx-ci'), String(sbxRegJson.formUrl));
    const sbxHealth = await request(port, 'GET', '/health', undefined, sbxHeaders);
    check('health песочницы: sandbox=sbx-ci, счётчики свои',
      sbxHealth.json().sandbox === 'sbx-ci' && sbxHealth.json().orders >= 1);
    const crossLook = await rest(port, 'getOrderStatus.do', { ...CREDS, orderId: sbxRegJson.orderId });
    check('изоляция: заказ sbx-ci не виден из default (errorCode 3)', (crossLook.json() || {}).errorCode === 3);
    const sbxSwitch = await request(port, 'POST', '/sandboxes', { sandbox: 'sbx-ci' });
    check('POST /sandboxes (namespaces): переключение активно', sbxSwitch.statusCode === 200 && sbxSwitch.json().current === 'sbx-ci');
    await request(port, 'POST', '/sandboxes', { sandbox: 'default' });
    const sbxReset = await request(port, 'POST', '/mock/reset', { sandbox: 'sbx-ci' }, sbxHeaders);
    check('POST /mock/reset песочницы', sbxReset.statusCode === 200 && sbxReset.json().ok === true);

    /* ------------------------------------------------ /mock/state, /mock/reset */
    console.log('— /mock/state экспорт/импорт, /mock/reset');
    const exported = await request(port, 'GET', '/mock/state');
    check('GET /mock/state: снимок состояния default-песочницы',
      exported.statusCode === 200 && exported.json().sandbox === 'default' && Boolean(exported.json().state.orders));
    const exportCount = Object.keys(exported.json().state.orders).length;
    const resetRes = await request(port, 'POST', '/mock/reset', {});
    check('POST /mock/reset очищает заказы', resetRes.statusCode === 200 && resetRes.json().ok === true);
    const healthAfterReset = await request(port, 'GET', '/health');
    check('после reset: orders=0', healthAfterReset.json().orders === 0);
    const importRes = await request(port, 'POST', '/mock/state', { state: exported.json().state });
    check('POST /mock/state: импорт снимка', importRes.statusCode === 200 && importRes.json().ok === true);
    const healthAfterImport = await request(port, 'GET', '/health');
    check('после импорта заказы восстановлены', healthAfterImport.json().orders === exportCount, `${healthAfterImport.json().orders} vs ${exportCount}`);
    const stAfterImport = await rest(port, 'getOrderStatusExtended.do', { ...CREDS, orderId: flow1.orderId });
    check('восстановленный заказ читается: orderStatus=2', (stAfterImport.json() || {}).orderStatus === 2);
    const badImport = await request(port, 'POST', '/mock/state', '{oops', { 'Content-Type': 'application/json' });
    check('импорт битого JSON: 400 + DX', badImport.statusCode === 400 && Boolean((badImport.json() || {}).hint));

    /* ------------------------------------- флаги контура (дочерние процессы) */
    console.log('— env-флаги: MOCK_TWO_STAGE=false, MOCK_SSL_PERMITTED=true, MOCK_PARTIAL_REFUND=false, MOCK_CALLBACK_CHECKSUM=false');

    const childTwo = startChild({ MOCK_TWO_STAGE: 'false' });
    children.push(childTwo);
    const portTwo = await childTwo.port;
    const healthTwo = await request(portTwo, 'GET', '/health');
    check('MOCK_TWO_STAGE=false: health twoStage=false', healthTwo.json().twoStage === false);
    const preAuthOff = await rest(portTwo, 'registerPreAuth.do', { ...CREDS, orderNumber: nextOrderNumber('two-off'), amount: '1000', returnUrl: 'https://shop.test/ok' });
    checkError('двухстадийная схема выключена: registerPreAuth отклонён', preAuthOff, { code: 5 });
    check('выключенная двухстадийная схема: hint объясняет (включается банком / MOCK_TWO_STAGE)',
      String((preAuthOff.json() || {}).hint || '').includes('MOCK_TWO_STAGE') && String((preAuthOff.json() || {}).errorMessage).includes('не подключена'));
    const regStillOk = await rest(portTwo, 'register.do', { ...CREDS, orderNumber: nextOrderNumber('two-off-ok'), amount: '1000', returnUrl: 'https://shop.test/ok' });
    check('одностадийная регистрация при выключенной двухстадийной схеме работает', (regStillOk.json() || {}).errorCode === 0);
    check('стартовый лог печатает СИНТЕТИЧЕСКИЕ креды (требование #41)',
      childTwo.output().includes('userName=ALFAMOCKTEST') && childTwo.output().includes('password=mockpass123')
      && childTwo.output().includes('СИНТЕТИЧЕСКИЕ') && childTwo.output().includes('TBANKMOCKTEST'),
      childTwo.output().split('\n').find((l) => l.includes('creds')) || '');
    check('стартовый лог отмечает границы: асимметричный checksum вне области',
      childTwo.output().includes('асимметричный checksum'));
    await childTwo.stop();

    const childSsl = startChild({ MOCK_SSL_PERMITTED: 'true' });
    children.push(childSsl);
    const portSsl = await childSsl.port;
    const flowSslOn = await fullFlow(portSsl, { pan: CARD_SSL, callbackUrl: HOOK_URL, amount: 1300 });
    check('MOCK_SSL_PERMITTED=true: карта без 3DS успешна (orderStatus=2)', flowSslOn.status.orderStatus === 2,
      JSON.stringify({ st: flowSslOn.status.orderStatus, ac: flowSslOn.status.actionCode }));
    await childSsl.stop();

    const childPartial = startChild({ MOCK_PARTIAL_REFUND: 'false' });
    children.push(childPartial);
    const portPartial = await childPartial.port;
    const flowPartial = await fullFlow(portPartial, { pan: CARD_3DS2_FRICTIONLESS, callbackUrl: null, amount: 5000 });
    const partialBlocked = await rest(portPartial, 'refund.do', { ...CREDS, orderId: flowPartial.orderId, amount: '2000' });
    checkError('MOCK_PARTIAL_REFUND=false: частичный возврат отклонён', partialBlocked, { code: 5, field: 'amount' });
    check('запрет частичного возврата: hint про разрешённый контур и полное возмещение',
      String((partialBlocked.json() || {}).hint || '').includes('MOCK_PARTIAL_REFUND'));
    const fullRefundOk = await rest(portPartial, 'refund.do', { ...CREDS, orderId: flowPartial.orderId, amount: '5000' });
    check('полный возврат при запрете частичных: errorCode=0', (fullRefundOk.json() || {}).errorCode === 0);
    await childPartial.stop();

    const childNoChecksum = startChild({ MOCK_CALLBACK_CHECKSUM: 'false' });
    children.push(childNoChecksum);
    const portNoChecksum = await childNoChecksum.port;
    const healthNoCs = await request(portNoChecksum, 'GET', '/health');
    check('MOCK_CALLBACK_CHECKSUM=false: health checksum=off', healthNoCs.json().checksum === 'off');
    const flowNoCs = await fullFlow(portNoChecksum, { pan: CARD_3DS2_FRICTIONLESS, callbackUrl: HOOK_URL, amount: 777 });
    await waitForCondition(() => hitsFor(flowNoCs.orderId).length >= 1, { description: 'callback без checksum' });
    const cbNoCs = hitsFor(flowNoCs.orderId)[0];
    check('неподписанный callback: checksum отсутствует, остальные параметры на месте',
      cbNoCs.query.checksum === undefined && cbNoCs.query.mdOrder === flowNoCs.orderId && cbNoCs.query.operation === 'deposited',
      JSON.stringify(cbNoCs.query));
    check('неподписанный callback: статус сверяется через REST (orderStatus=2)', flowNoCs.status.orderStatus === 2);
    await childNoChecksum.stop();

    /* --------------------------------------- owned-песочницы (дочерний процесс) */
    console.log('— песочницы (owned): свои userName/password/callbackSecret, ownerToken, изоляция');
    const childOwned = startChild({ MOCK_TENANCY: 'owned', MOCK_SANDBOX_TOKEN: 'root-owner-token' });
    children.push(childOwned);
    const portOwned = await childOwned.port;

    const sbxA = await request(portOwned, 'POST', '/sandboxes', {});
    const sbxAJson = sbxA.json() || {};
    check('POST /sandboxes (owned): 201, id + ownerToken + url',
      sbxA.statusCode === 201 && Boolean(sbxAJson.id) && Boolean(sbxAJson.ownerToken) && Boolean(sbxAJson.url), sbxA.body.slice(0, 160));
    check('owned: свои креды — userName ALFASBX*, password, callbackSecret (секрет checksum)',
      /^ALFASBX/.test(String(sbxAJson.creds && sbxAJson.creds.userName || '')) && Boolean(sbxAJson.creds.password) && Boolean(sbxAJson.creds.callbackSecret),
      JSON.stringify(sbxAJson.creds && sbxAJson.creds.userName));
    check('owned: hint — сохранить ownerToken (показывается один раз)',
      String(sbxAJson.hint || '').includes('ownerToken'));

    // Селектор песочницы (X-Mock-Sandbox) и авторизация (X-Sandbox-Token) —
    // разные вещи: id выбирает состояние, owner-token даёт доступ (RFC-001).
    const headersA = { 'X-Mock-Sandbox': sbxAJson.id, 'X-Sandbox-Token': sbxAJson.ownerToken };
    const regA = await rest(portOwned, 'register.do', { ...sbxAJson.creds, orderNumber: nextOrderNumber('sbxA'), amount: '2000', returnUrl: 'https://shop.test/ok', jsonParams: JSON.stringify({ callback_url: HOOK_URL }) }, headersA);
    check('register в своей песочнице со своими кредами: errorCode=0', (regA.json() || {}).errorCode === 0, regA.body.slice(0, 140));
    check('formUrl своей песочницы содержит ?sandbox=', String((regA.json() || {}).formUrl || '').includes(`sandbox=${sbxAJson.id}`));

    const regADefaultCreds = await rest(portOwned, 'register.do', { ...CREDS, orderNumber: nextOrderNumber('sbxA-def'), amount: '2000', returnUrl: 'https://shop.test/ok' }, headersA);
    checkError('дефолтные креды стенда в owned-песочнице не работают', regADefaultCreds, { code: 2 });

    const regANoToken = await rest(portOwned, 'register.do', { ...sbxAJson.creds, orderNumber: nextOrderNumber('sbxA-nt'), amount: '2000', returnUrl: 'https://shop.test/ok' });
    check('без ownerToken доступ к default закрыт (MOCK_SANDBOX_TOKEN): 401', regANoToken.statusCode === 401,
      `HTTP ${regANoToken.statusCode}`);
    check('знание id ≠ доступ: 401 объясняет owner-token',
      String((regANoToken.json() || {}).hint || '').includes('owner-token') || String((regANoToken.json() || {}).errorMessage || '').includes('owner-token'),
      regANoToken.body.slice(0, 140));

    const listNoToken = await request(portOwned, 'GET', '/sandboxes');
    check('GET /sandboxes (owned) без токена: 401', listNoToken.statusCode === 401);
    const listA = await request(portOwned, 'GET', '/sandboxes', undefined, headersA);
    check('GET /sandboxes со своим ownerToken: видна только своя песочница',
      listA.statusCode === 200 && listA.json().sandboxes.length === 1 && listA.json().sandboxes[0].id === sbxAJson.id);

    const meA = await request(portOwned, 'GET', '/sandboxes/me', undefined, headersA);
    check('GET /sandboxes/me: свои креды (включая callbackSecret)',
      meA.statusCode === 200 && meA.json().creds && meA.json().creds.userName === sbxAJson.creds.userName);

    const orderIdA = (regA.json() || {}).orderId;
    const formPageA = await request(portOwned, 'GET', `/payment/${orderIdA}?sandbox=${sbxAJson.id}`);
    check('форма песочницы открывается по formUrl (capability-ссылка, owner-token не нужен) и сохраняет ?sandbox= в action',
      formPageA.statusCode === 200 && formPageA.body.includes(`action="/payment/${orderIdA}/pay?sandbox=${sbxAJson.id}"`),
      `HTTP ${formPageA.statusCode}`);
    const payA = await request(portOwned, 'POST', `/payment/${orderIdA}/pay?sandbox=${sbxAJson.id}`, form({ pan: CARD_3DS2_FRICTIONLESS, exp: '1234', cvv: '123', cardholder: 'IVAN IVANOV' }));
    check('оплата в owned-песочнице проходит: 302 на returnUrl', payA.statusCode === 302, `HTTP ${payA.statusCode}`);
    await waitForCondition(() => hitsFor(orderIdA).length >= 1, { description: 'callback песочницы A' });
    const cbA = hitsFor(orderIdA)[0];
    check('checksum callback подписан СЕКРЕТОМ ПЕСОЧНИЦЫ (не глобальным)',
      verifyChecksum(cbA.query, sbxAJson.creds.callbackSecret) && !verifyChecksum(cbA.query, CALLBACK_SECRET));

    const sbxB = await request(portOwned, 'POST', '/sandboxes', { sandbox: 'team-b' });
    const sbxBJson = sbxB.json() || {};
    check('POST /sandboxes sandbox=team-b: создан с заданным id', sbxB.statusCode === 201 && sbxBJson.id === 'team-b');
    const dupB = await request(portOwned, 'POST', '/sandboxes', { sandbox: 'team-b' });
    check('повторное создание team-b: 409', dupB.statusCode === 409);
    const crossB = await rest(portOwned, 'getOrderStatus.do', { ...sbxBJson.creds, orderId: orderIdA }, { 'X-Mock-Sandbox': 'team-b', 'X-Sandbox-Token': sbxBJson.ownerToken });
    checkError('изоляция: заказ песочницы A не виден из песочницы B', crossB, { code: 3 });

    const resetCreds = await request(portOwned, 'POST', '/sandboxes/me/reset-creds', {}, headersA);
    const newCreds = (resetCreds.json() || {}).creds || {};
    check('POST /sandboxes/me/reset-creds: новые userName/password/callbackSecret, ownerToken сохранён',
      resetCreds.statusCode === 200 && newCreds.userName && newCreds.userName !== sbxAJson.creds.userName && resetCreds.json().ownerTokenChanged === false);
    const regOldCreds = await rest(portOwned, 'register.do', { ...sbxAJson.creds, orderNumber: nextOrderNumber('sbxA-old'), amount: '100', returnUrl: 'https://shop.test/ok' }, headersA);
    checkError('старые креды после reset-creds не работают', regOldCreds, { code: 2 });
    const regNewCreds = await rest(portOwned, 'register.do', { ...newCreds, orderNumber: nextOrderNumber('sbxA-new'), amount: '100', returnUrl: 'https://shop.test/ok' }, headersA);
    check('новые креды после reset-creds работают', (regNewCreds.json() || {}).errorCode === 0);

    const delA = await request(portOwned, 'DELETE', '/sandboxes/me', {}, headersA);
    check('DELETE /sandboxes/me: песочница удалена', delA.statusCode === 200 && delA.json().ok === true);
    const goneA = await rest(portOwned, 'register.do', { ...newCreds, orderNumber: nextOrderNumber('sbxA-gone'), amount: '100', returnUrl: 'https://shop.test/ok' }, { 'X-Sandbox-Token': sbxAJson.ownerToken, 'X-Mock-Sandbox': sbxAJson.id });
    check('после удаления песочница не найдена: 404 + hint «POST /sandboxes»',
      goneA.statusCode === 404 && String((goneA.json() || {}).hint || '').includes('POST /sandboxes'));
    await childOwned.stop();

    /* ------------------------- PD-02: квота состояния песочницы по байтам */
    console.log('— квота состояния по байтам (PD-02, owned)');
    const childQuota = startChild({ MOCK_TENANCY: 'owned', MOCK_SANDBOX_TOKEN: 'root-owner-token' });
    children.push(childQuota);
    const portQuota = await childQuota.port;
    const sbxQ = JSON.parse((await request(portQuota, 'POST', '/sandboxes', {})).body);
    const headersQ = { 'X-Mock-Sandbox': sbxQ.id, 'X-Sandbox-Token': sbxQ.ownerToken };
    const quotaDescription = 'd'.repeat(2 * 1024 * 1024); // 2 МБ на заказ, тело запроса < 5 МБ
    const quotaRegs = [];
    for (let i = 1; i <= 5; i += 1) {
      quotaRegs.push(await rest(portQuota, 'register.do', { ...sbxQ.creds, orderNumber: `quota-bytes-${i}`, amount: '1000', returnUrl: 'https://shop.test/ok', description: quotaDescription }, headersQ));
    }
    check('PD-02: 4 заказа по 2 МБ (≈8 МиБ состояния) проходят квоту документов и байтов',
      quotaRegs.slice(0, 4).every((r) => (r.json() || {}).errorCode === 0), quotaRegs.slice(0, 4).map((r) => r.body.slice(0, 80)).join(' | '));
    const overQuota = quotaRegs[4].json() || {};
    check('PD-02: 5-й заказ отклонён квотой по байтам (errorCode=5, текст про объём состояния, не про документы)',
      overQuota.errorCode === 5 && /объёма состояния/.test(String(overQuota.errorMessage || '')) && /байт/.test(String(overQuota.errorMessage || '')),
      quotaRegs[4].body.slice(0, 160));
    await childQuota.stop();

    /* ----------------------------------- control-plane (дочерний процесс) */
    console.log('— control-plane: MOCK_ADMIN_TOKEN / MOCK_OPERATOR_TOKEN, hosted fail-closed');
    const childControl = startChild({ MOCK_ADMIN_TOKEN: 'adm-t', MOCK_OPERATOR_TOKEN: 'op-t' });
    children.push(childControl);
    const portControl = await childControl.port;
    const adminNoToken = await request(portControl, 'GET', '/admin');
    checkError('/admin без токена: 401', adminNoToken, { code: 2, status: 401 });
    const adminOk = await request(portControl, 'GET', '/admin', undefined, { 'X-Admin-Token': 'adm-t' });
    check('/admin с X-Admin-Token: 200 HTML-консоль', adminOk.statusCode === 200 && adminOk.body.includes('Консоль стенда Альфа-Эквайринга'));
    const journalNoToken = await request(portControl, 'GET', '/admin/journal');
    check('/admin/journal без токена: 401', journalNoToken.statusCode === 401);
    const journalOk = await request(portControl, 'GET', '/admin/journal', undefined, { 'X-Admin-Token': 'adm-t' });
    check('/admin/journal с токеном: 200 {entries}', journalOk.statusCode === 200 && Array.isArray(journalOk.json().entries));
    const timeNoToken = await request(portControl, 'POST', '/mock/time', { advance: '+1s' });
    check('/mock/time без operator-токена: 401', timeNoToken.statusCode === 401);
    const timeOk = await request(portControl, 'POST', '/mock/time', { advance: '+1s' }, { 'X-Operator-Token': 'op-t' });
    check('/mock/time с X-Operator-Token: 200, offsetMs>0', timeOk.statusCode === 200 && timeOk.json().offsetMs > 0);
    const businessOpen = await rest(portControl, 'register.do', { ...CREDS, orderNumber: nextOrderNumber('ctl'), amount: '100', returnUrl: 'https://shop.test/ok' });
    check('бизнес-маршруты *.do токенов не требуют', (businessOpen.json() || {}).errorCode === 0);
    const healthOpen = await request(portControl, 'GET', '/health');
    check('/health открыт', healthOpen.statusCode === 200 && healthOpen.json().ok === true);
    await childControl.stop();

    const childHosted = startChild({ MOCK_HOSTED: '1' });
    children.push(childHosted);
    const portHosted = await childHosted.port;
    const hostedTime = await request(portHosted, 'POST', '/mock/time', { advance: '+1s' });
    checkError('hosted без токенов: /mock/time закрыт (fail-closed)', hostedTime, { code: 2, status: 401 });
    check('hosted: сообщение объясняет fail-closed', String((hostedTime.json() || {}).errorMessage).includes('hosted'));
    const hostedHealth = await request(portHosted, 'GET', '/health');
    check('hosted: /health открыт', hostedHealth.statusCode === 200);
    const hostedReg = await rest(portHosted, 'register.do', { ...CREDS, orderNumber: nextOrderNumber('hosted'), amount: '100', returnUrl: 'https://shop.test/ok' });
    check('hosted: бизнес-регистрация работает', (hostedReg.json() || {}).errorCode === 0);
    await childHosted.stop();

    /* --------------------------------------- персистентность (MOCK_STATE_FILE) */
    console.log('— персистентность: рестарт с MOCK_STATE_FILE сохраняет заказы');
    const stateFile = path.join(os.tmpdir(), `alfa-mock-state-${Date.now()}.json`);
    tmpFiles.push(stateFile);
    const childPersist1 = startChild({ MOCK_STATE_FILE: stateFile });
    children.push(childPersist1);
    const portPersist = await childPersist1.port;
    const flowPersist = await fullFlow(portPersist, { pan: CARD_3DS2_FRICTIONLESS, callbackUrl: null, amount: 4321 });
    check('до рестарта: заказ оплачен (orderStatus=2)', flowPersist.status.orderStatus === 2);
    await waitForCondition(() => fs.existsSync(stateFile), { description: 'state-файл записан' });
    await childPersist1.stop();
    const childPersist2 = startChild({ MOCK_STATE_FILE: stateFile });
    children.push(childPersist2);
    const portPersist2 = await childPersist2.port;
    const stPersist = await rest(portPersist2, 'getOrderStatusExtended.do', { ...CREDS, orderId: flowPersist.orderId });
    check('после рестарта заказ читается из state-файла: orderStatus=2, depositedAmount=4321',
      (stPersist.json() || {}).orderStatus === 2 && (stPersist.json() || {}).depositedAmount === 4321,
      stPersist.body.slice(0, 140));
    const dupAfterRestart = await rest(portPersist2, 'register.do', { ...CREDS, orderNumber: flowPersist.orderNumber, amount: '100', returnUrl: 'https://shop.test/ok' });
    check('уникальность orderNumber переживает рестарт (errorCode 1)', (dupAfterRestart.json() || {}).errorCode === 1);
    await childPersist2.stop();

    /* ---------- PA-50 / PG-03 / PG-10 / PA-54 / PA-55: авторизация песочниц и гонка TTL ---------- */
    console.log('— PA-50 / PG-03 / PG-10 / PA-54 / PA-55: авторизация явного target и гонка TTL-sweep');
    const tmpPa = fs.mkdtempSync(path.join(os.tmpdir(), 'alfa-pa50-'));
    const sbxFile = path.join(tmpPa, 'sandboxes.json');
    const core = require('../../packages/core');
    fs.writeFileSync(sbxFile, JSON.stringify({
      activeId: 'victim-b',
      sandboxes: [
        {
          id: 'victim-b',
          expiresAt: 0,
          ownerTokenHash: core.hashSecret('victim-owner-token'),
          creds: { userName: 'ALFAVICTIM', password: 'victim-password', callbackSecret: 'victim-cb-secret' },
          state: {
            orders: {
              'alfa-victim-order': {
                orderId: 'alfa-victim-order',
                orderNumber: 'VICTIM-CANARY-ALFA',
                status: 2,
                amountK: 12345,
                depositedK: 12345,
                currency: '643',
                createdAtMs: Date.now(),
              },
            },
            orderNumbers: { 'VICTIM-CANARY-ALFA': 'alfa-victim-order' },
            callbacks: {},
          },
        },
        {
          id: 'attacker-a',
          expiresAt: 0,
          ownerTokenHash: core.hashSecret('attacker-owner-token'),
          creds: { userName: 'ALFAATTACK', password: 'attacker-password', callbackSecret: 'attacker-cb-secret' },
          state: { orders: {}, orderNumbers: {}, callbacks: {} },
        },
      ],
    }));
    const childPa = startChild({
      MOCK_TENANCY: 'owned',
      MOCK_SANDBOX_FILE: sbxFile,
      MOCK_SANDBOX_TOKEN: 'default-owner-secret',
      MOCK_OPERATOR_TOKEN: 'op-secret',
      MOCK_SANDBOX_TTL_MS: '1000',
      MOCK_SANDBOX_SWEEP_MS: '1000',
    });
    children.push(childPa);
    try {
      const portPa = await childPa.port;
      const hdrA = { 'X-Mock-Sandbox': 'attacker-a', 'X-Sandbox-Token': 'attacker-owner-token' };
      const expB = await request(portPa, 'GET', '/mock/state?sandbox=victim-b', undefined, hdrA);
      check('PA-50 / PG-03: чужой GET /mock/state?sandbox=victim-b -> 401 без утечки',
        expB.statusCode === 401 && !expB.body.includes('VICTIM-CANARY-ALFA'));
      const impB = await request(portPa, 'POST', '/mock/state', { sandbox: 'victim-b', state: { orders: { pwn: {} } } }, hdrA);
      check('PA-50 / PG-03: чужой POST /mock/state -> 401', impB.statusCode === 401);
      const rstB = await request(portPa, 'POST', '/mock/reset', { sandbox: 'victim-b' }, hdrA);
      check('PA-50 / PG-03: чужой POST /mock/reset -> 401', rstB.statusCode === 401);
      const delB = await request(portPa, 'DELETE', '/sandboxes?sandbox=victim-b', undefined, hdrA);
      check('PA-50 / PG-03: чужой DELETE /sandboxes -> 401', delB.statusCode === 401);

      const opB = await request(portPa, 'GET', '/mock/state?sandbox=victim-b', undefined, { 'X-Operator-Token': 'op-secret' });
      check('PA-50 / PG-03: оператор читает /mock/state?sandbox=victim-b',
        opB.statusCode === 200 && opB.body.includes('VICTIM-CANARY-ALFA'));

      const defForm = await request(portPa, 'GET', '/payment/alfa-victim-order');
      check('PA-54: форма защищённой default без токена -> 401', defForm.statusCode === 401);
      const pubHealth = (await request(portPa, 'GET', '/health')).json();
      check('PA-54: публичный /health на защищённой default не раскрывает orders', pubHealth.orders === undefined);

      const r = (await request(portPa, 'POST', '/sandboxes', { id: 'race-tenant' })).json();
      const raceResp = await rest(portPa, 'getOrderStatus.do', { ...CREDS, orderId: 'alfa-victim-order' }, {
        'X-Mock-Sandbox': r.id,
        'X-Sandbox-Token': r.ownerToken,
        'X-Mock-Latency': '1700',
      });
      check('PA-50 §7.2 / PG-10: истёкшая во время await песочница -> 410 без утечки',
        raceResp.statusCode === 410 && !raceResp.body.includes('VICTIM-CANARY-ALFA'), `status=${raceResp.statusCode}`);
    } finally {
      await childPa.stop();
      fs.rmSync(tmpPa, { recursive: true, force: true });
    }

    /* ---------- #51 PF-01 / PG-11 / PA-25 / PA-26: SSRF-контур и DNS TOCTOU ---------- */
    console.log('— #51 PF-01 / PG-11: SSRF по умолчанию в MOCK_HOSTED=1 и защита от DNS TOCTOU');
    {
      const preloadFile = path.join(os.tmpdir(), `alfa-rebind-preload-${process.pid}-${Date.now()}.js`);
      tmpFiles.push(preloadFile);
      fs.writeFileSync(preloadFile, `
        'use strict';
        const dns = require('dns');
        const origPromisesLookup = dns.promises.lookup;
        const origDnsLookup = dns.lookup;
        dns.promises.lookup = async (host, opts) => {
          if (host === 'rebind.audit.test') return [{ address: '93.184.216.34', family: 4 }];
          return origPromisesLookup(host, opts);
        };
        dns.lookup = (host, opts, cb) => {
          const callback = typeof opts === 'function' ? opts : cb;
          const options = typeof opts === 'function' ? {} : (opts || {});
          if (host === 'rebind.audit.test') {
            if (options.all) return process.nextTick(() => callback(null, [{ address: '127.0.0.1', family: 4 }]));
            return process.nextTick(() => callback(null, '127.0.0.1', 4));
          }
          return origDnsLookup(host, opts, cb);
        };
      `);
      const rebindEnv = {
        ...process.env,
        MOCK_HOST: '127.0.0.1',
        MOCK_PORT: '0',
        MOCK_STATE_FILE: '',
        MOCK_SANDBOX_FILE: '',
        MOCK_HOSTED: '1',
        MOCK_OPERATOR_TOKEN: 'op-ssrf',
        MOCK_CALLBACK_RETRY_MS: '1000',
      };
      delete rebindEnv.MOCK_BLOCK_PRIVATE_WEBHOOKS;
      const rebindProc = spawn('node', ['--max-old-space-size=48', '-r', preloadFile, path.join(__dirname, 'server.js')], {
        env: rebindEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let rebindLog = '';
      rebindProc.stdout.on('data', (d) => { rebindLog += String(d); });
      rebindProc.stderr.on('data', (d) => { rebindLog += String(d); });
      try {
        const rebindPort = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`rebind-child timeout: ${rebindLog}`)), 6000);
          const poll = setInterval(() => {
            const m = /on http:\/\/[^:]+:(\d+)/.exec(rebindLog);
            if (m) { clearInterval(poll); clearTimeout(timer); resolve(Number(m[1])); }
          }, 25);
        });
        const hitsBefore = HITS.filter((h) => h.path === '/rebind-pg11').length;
        await fullFlow(rebindPort, {
          pan: CARD_3DS2_FRICTIONLESS,
          callbackUrl: `http://rebind.audit.test:${receiverPort}/rebind-pg11`,
          amount: 2000,
        });
        check('#51 PF-01: MOCK_HOSTED=1 в alfa-mock включает block_private_webhooks=true по умолчанию',
          rebindLog.includes('hosted=true block_private_webhooks=true'));
        const blockedCb = await waitForCondition(async () => {
          const st = (await request(rebindPort, 'GET', '/mock/state', undefined, { 'X-Operator-Token': 'op-ssrf' })).json();
          const stateSlice = (st && st.state) || st || {};
          const entry = Object.values(stateSlice.callbacks || {})[0];
          return entry && String(entry.lastStatus).includes('SSRF_BLOCKED') ? entry : null;
        }, { timeoutMs: 5000, description: 'PG-11 SSRF_BLOCKED recorded in /mock/state' });
        const hitsAfter = HITS.filter((h) => h.path === '/rebind-pg11').length;
        check('#51 PG-11 / §7.3: DNS TOCTOU rebinding блокируется с SSRF_BLOCKED и 0 соединений к loopback',
          Boolean(blockedCb) && hitsAfter === hitsBefore, `hits=${hitsAfter - hitsBefore}`);
      } finally {
        await new Promise((resolve) => {
          if (rebindProc.exitCode !== null) { resolve(); return; }
          rebindProc.once('exit', () => resolve());
          rebindProc.kill('SIGTERM');
          setTimeout(() => { if (rebindProc.exitCode === null) rebindProc.kill('SIGKILL'); }, 1500).unref();
        });
      }
    }
  } finally {
    for (const child of children) await child.stop();
    for (const f of tmpFiles) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
    try { receiver.close(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
  }

  console.log(`\nИТОГ: ${passed} passed, ${failed} failed · callback-доставок: ${HITS.length}`);
  if (failed > 0) {
    console.log('SELFTEST FAILED ❌');
    process.exit(1);
  }
  console.log('SELFTEST PASSED ✅');
  process.exit(0);
}

main().catch((e) => {
  console.error('SELFTEST ERROR:', e);
  process.exit(1);
});
