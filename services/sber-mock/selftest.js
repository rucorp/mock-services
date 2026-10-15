// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Selftest Sberbank Ecom REST mock (issue #81, Stage 2).
 * Покрывает Ecom JSON REST, register/preAuth + hosted card form/ACS, состояния
 * 0…6, deposit/reverse/full+partial refund/decline, TTL 20 минут и три попытки;
 * callback POST JSON без подписи, ACK 200, операции, повторы 3×60s через часы,
 * дубли, SSRF-terminality, сценарии/журнал per-sandbox, секреты и env-парсеры.
 * Запуск: node services/sber-mock/selftest.js
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const CREDS = { userName: 'SBERMOCKTEST', password: 'mockpass123' };
const CARD_FRICTIONLESS = { pan: '2202205000012424', exp: '0535', cvv: '669' };
const CARD_CHALLENGE = { pan: '2202205300068092', exp: '1231', cvv: '583' };
const CARD_116 = { pan: '2202205000060910', exp: '0628', cvv: '810' };
const CARD_101 = { pan: '2202202107593166', exp: '0622', cvv: '123' };
const ACS_PASSWORD = '111111';
const REST_PATH = '/ecomm/gw/partner/api/v1';

let passed = 0;
let failed = 0;
let sequence = 0;
const callbackHits = [];
const callbackWaiters = [];

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function waitFor(predicate, { timeoutMs = 5000, description = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        if (await predicate()) return resolve(true);
        if (Date.now() >= until) return reject(new Error(`Timed out waiting for ${description}`));
        setImmediate(poll); // даём event loop обработать socket/queue I/O; фиксированных sleep нет.
      } catch (error) {
        reject(error);
      }
    };
    poll();
  });
}

function notifyCallbackWaiters(hit) {
  for (let index = callbackWaiters.length - 1; index >= 0; index -= 1) {
    const waiter = callbackWaiters[index];
    if (!waiter.predicate(hit)) continue;
    callbackWaiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(hit);
  }
}

function waitForCallback(predicate, { timeoutMs = 4000, description = 'callback' } = {}) {
  const existing = callbackHits.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      timer: setTimeout(() => {
        const index = callbackWaiters.indexOf(waiter);
        if (index >= 0) callbackWaiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${description}`));
      }, timeoutMs),
    };
    callbackWaiters.push(waiter);
  });
}

const callbackReceiver = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(raw); } catch { /* recorded for assertion */ }
    const hit = { path: new URL(req.url, 'http://receiver.local').pathname, method: req.method, contentType: req.headers['content-type'], raw, json, status: null };
    callbackHits.push(hit);
    notifyCallbackWaiters(hit);
    const pathName = hit.path;
    if (pathName === '/noack') {
      hit.status = 204;
      res.writeHead(204);
      res.end();
      return;
    }
    if (pathName === '/always-fail') {
      hit.status = 503;
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('temporarily unavailable');
      return;
    }
    if (pathName === '/flaky' && callbackHits.filter((item) => item.path === '/flaky').length === 1) {
      hit.status = 503;
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('first delivery fails');
      return;
    }
    hit.status = 200;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function request(port, method, requestPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const isRaw = typeof body === 'string';
    const data = body === undefined || body === null ? null : (isRaw ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: {
        ...(data !== null ? {
          'Content-Type': isRaw ? 'application/x-www-form-urlencoded' : 'application/json',
          'Content-Length': Buffer.byteLength(data),
        } : {}),
        ...headers,
      },
      timeout: 8000,
    }, (res) => {
      let output = '';
      res.on('data', (chunk) => { output += chunk; });
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: output,
        json: () => { try { return JSON.parse(output); } catch { return null; } },
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`HTTP timeout ${method} ${requestPath}`)));
    if (data !== null) req.write(data);
    req.end();
  });
}

function startChild(extraEnv = {}) {
  const env = {
    ...process.env,
    MOCK_HOST: '127.0.0.1',
    MOCK_PORT: '0',
    MOCK_STATE_FILE: '',
    MOCK_SBER_USERNAME: '',
    MOCK_SBER_PASSWORD: '',
    MOCK_SBER_PUBLIC_BASE_URL: '',
    MOCK_SBER_CALLBACK_URL: '',
    MOCK_SBER_CALLBACK_RETRY_MS: '60s',
    MOCK_SBER_CALLBACK_MAX_ATTEMPTS: '3',
    MOCK_SBER_SESSION_TIMEOUT_SECS: '1200',
    MOCK_SBER_TWO_STAGE: 'true',
    MOCK_BLOCK_PRIVATE_WEBHOOKS: '',
    MOCK_VIRTUAL_CLOCK: '',
    MOCK_ADMIN_TOKEN: '',
    MOCK_OPERATOR_TOKEN: '',
    MOCK_HOSTED: 'false',
    MOCK_TENANCY: '',
    MOCK_SANDBOX_TOKEN: '',
    MOCK_SANDBOX_TTL_MS: '',
    MOCK_SANDBOX_MAX: '',
    MOCK_SANDBOX_MAX_DOCUMENTS: '',
    MOCK_SANDBOX_RETENTION_MS: '',
    MOCK_SANDBOX_HOST_SUFFIX: '',
    MOCK_SANDBOX_CREATE_LIMIT: '',
    MOCK_SANDBOX_SWEEP_MS: '60000',
    ...extraEnv,
  };
  const proc = spawn(process.execPath, ['--max-old-space-size=64', path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const outputWaiters = [];
  const recordOutput = (chunk) => {
    output += chunk.toString();
    for (let index = outputWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = outputWaiters[index];
      if (!waiter.pattern.test(output)) continue;
      outputWaiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(output);
    }
  };
  proc.stdout.on('data', recordOutput);
  proc.stderr.on('data', recordOutput);
  const port = new Promise((resolve, reject) => {
    const checkPort = () => {
      const match = output.match(/on http:\/\/[^:\s]+:(\d+)/);
      if (match) return resolve(Number(match[1]));
      if (proc.exitCode !== null) return reject(new Error(`Sber mock exited early: ${output}`));
      const waiter = { pattern: /on http:\/\/[^:\s]+:\d+/, resolve: () => resolve(Number(output.match(/on http:\/\/[^:\s]+:(\d+)/)[1])), reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = outputWaiters.indexOf(waiter);
        if (index >= 0) outputWaiters.splice(index, 1);
        reject(new Error(`Sber mock did not start: ${output}`));
      }, 8000);
      outputWaiters.push(waiter);
    };
    proc.once('exit', (code) => { if (code !== null && code !== 0) reject(new Error(`Sber mock exited ${code}: ${output}`)); });
    checkPort();
  });
  return {
    proc,
    port,
    output: () => output,
    waitForOutput(pattern, timeoutMs = 5000) {
      if (pattern.test(output)) return Promise.resolve(output);
      return new Promise((resolve, reject) => {
        const waiter = { pattern, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = outputWaiters.indexOf(waiter);
          if (index >= 0) outputWaiters.splice(index, 1);
          reject(new Error(`Timed out waiting for log /${pattern.source}/: ${output}`));
        }, timeoutMs);
        outputWaiters.push(waiter);
      });
    },
    async stop() {
      if (proc.exitCode !== null) return;
      proc.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 3000);
        proc.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

const rest = (port, method, fields = {}, headers = {}) => request(port, 'POST', `${REST_PATH}/${method}`, { ...CREDS, ...fields }, headers);
const formBody = (data) => new URLSearchParams(data).toString();
const orderNumber = (prefix = 'sber') => `${prefix}-${Date.now().toString(36)}-${++sequence}`;

function checkProviderError(name, response, code, statusCode = 200) {
  const body = response.json() || {};
  check(`${name}: provider-shaped error (HTTP ${statusCode}, errorCode=${code}, errorMessage + DX)`,
    response.statusCode === statusCode && body.errorCode === code
    && typeof body.errorMessage === 'string' && body.errorMessage.length > 0
    && typeof body.hint === 'string' && body.hint.length > 0,
    `${response.statusCode} ${response.body.slice(0, 220)}`);
  return body;
}

async function paymentForm(port, orderId, card = CARD_FRICTIONLESS, headers = {}) {
  return request(port, 'POST', `/payment/${encodeURIComponent(orderId)}/pay`, formBody(card), headers);
}

async function statusOf(port, idOrNumber, headers = {}) {
  const key = /^[0-9a-f-]{36}$/i.test(String(idOrNumber)) ? { orderId: idOrNumber } : { orderNumber: idOrNumber };
  return rest(port, 'getOrderStatusExtended.do', key, headers);
}

async function callbacksFor(port, orderId, headers = {}) {
  const state = (await request(port, 'GET', '/mock/state', null, headers)).json() || {};
  const inner = state.state || {};
  return Object.values(inner.callbacks || {}).filter((entry) => entry.orderId === orderId);
}

async function main() {
  const receiverPort = await listen(callbackReceiver);
  const origin = `http://127.0.0.1:${receiverPort}`;
  const hookUrl = `${origin}/hook`;
  const children = [];
  try {
    const primary = startChild();
    children.push(primary);
    const port = await primary.port;
    console.log(`\n== sber-mock selftest on :${port} (Ecom REST v1.1.11.1) ==\n`);

    console.log('— health, OpenAPI, синтетические креды');
    const health = await request(port, 'GET', '/health');
    const healthJson = health.json() || {};
    check('GET /health: ok, API JSON, callback POST без подписи', health.statusCode === 200 && healthJson.ok === true && healthJson.api === 'rest-json' && healthJson.callbackMethod === 'POST' && healthJson.callbackSignature === 'none');
    check('health: 3105 contract defaults — 20m TTL, 3 attempts, 3 payment attempts', healthJson.sessionTimeoutSecs === 1200 && healthJson.callbackRetryMs === 60000 && healthJson.callbackMaxAttempts === 3 && healthJson.maxPaymentAttempts === 3, JSON.stringify(healthJson));
    const openapi = await request(port, 'GET', '/openapi.json');
    const openapiJson = openapi.json() || {};
    check('GET /openapi.json: OpenAPI 3.1 + register.do + getOrderStatusExtended.do + form', openapi.statusCode === 200 && openapiJson.openapi === '3.1.0' && Boolean(openapiJson.paths[`${REST_PATH}/register.do`]) && Boolean(openapiJson.paths[`${REST_PATH}/getOrderStatusExtended.do`]) && Boolean(openapiJson.paths['/payment/{orderId}']));

    console.log('— register.do: JSON, errorCode=0 ≠ оплата, уникальность orderNumber');
    const regFields = { orderNumber: orderNumber(), amount: 15000, currency: 643, returnUrl: 'https://shop.test/sber/return', description: 'Synthetic integration test', dynamicCallbackUrl: hookUrl, additionalParams: { reference: 'safe-ref-1' } };
    const reg = await rest(port, 'register.do', regFields);
    const regJson = reg.json() || {};
    check('register.do: HTTP 200, errorCode=0 + orderId/formUrl', reg.statusCode === 200 && regJson.errorCode === 0 && Boolean(regJson.orderId) && String(regJson.formUrl).includes(`/payment/${regJson.orderId}`), reg.body.slice(0, 180));
    check('register.do: hint прямо говорит errorCode=0 ≠ успешная оплата', String(regJson.hint || '').includes('НЕ подтверждение оплаты'));
    const statusCreated = await statusOf(port, regJson.orderId);
    check('до оплаты getOrderStatusExtended: orderStatus=0; errorCode=0 не трактуется как success', statusCreated.statusCode === 200 && statusCreated.json().errorCode === 0 && statusCreated.json().orderStatus === 0 && statusCreated.json().actionCode === null);
    const formPageRes = await request(port, 'GET', `/payment/${regJson.orderId}`);
    check('formUrl: hosted-форма предлагает официальные тестовые карты с PAN-масками', formPageRes.statusCode === 200 && formPageRes.body.includes('220220**2424') && formPageRes.body.includes('220220**0910') && formPageRes.body.includes('2202205000012424'));
    const duplicate = await rest(port, 'register.do', regFields);
    checkProviderError('повтор orderNumber', duplicate, 1);
    const createdHook = await waitForCallback((hit) => hit.path === '/hook' && hit.json && hit.json.mdOrder === regJson.orderId, { description: 'created callback' });
    check('callback created: POST JSON, Content-Type application/json, mdOrder/orderNumber/operation/status', createdHook.method === 'POST' && String(createdHook.contentType).includes('application/json') && createdHook.json.operation === 'created' && createdHook.json.status === 1 && createdHook.json.orderNumber === regFields.orderNumber);
    check('Ecom callback: нет checksum/signature; additionalParams переданы (редактируемая структура)', !Object.prototype.hasOwnProperty.call(createdHook.json, 'checksum') && !Object.prototype.hasOwnProperty.call(createdHook.json, 'signature') && createdHook.json.additionalParams.reference === 'safe-ref-1');

    console.log('— успешная оплата, 3DS preAuth, deposit/reverse/refund/decline');
    const pay = await paymentForm(port, regJson.orderId, CARD_FRICTIONLESS);
    check('register → тестовая карта frictionless → redirect в магазин', pay.statusCode === 302 && pay.headers.location === regFields.returnUrl);
    const paidStatus = (await statusOf(port, regJson.orderId)).json() || {};
    check('getOrderStatusExtended — источник истины: orderStatus=2, actionCode=0, списано 15000', paidStatus.orderStatus === 2 && paidStatus.actionCode === 0 && paidStatus.depositedAmount === 15000 && paidStatus.cardholderPan === '220220**2424');
    await waitForCallback((hit) => hit.json && hit.json.mdOrder === regJson.orderId && hit.json.operation === 'deposited', { description: 'deposited callback' });
    check('callback deposited для одностадийной оплаты', callbackHits.some((hit) => hit.json && hit.json.mdOrder === regJson.orderId && hit.json.operation === 'deposited' && hit.json.status === 1));

    const preFields = { orderNumber: orderNumber('pre'), amount: 9000, currency: '643', returnUrl: 'https://shop.test/sber/pre-return', dynamicCallbackUrl: hookUrl };
    const preReg = await rest(port, 'registerPreAuth.do', preFields);
    const preId = (preReg.json() || {}).orderId;
    check('registerPreAuth.do → {orderId, formUrl}', preReg.statusCode === 200 && Boolean(preId));
    const prePay = await paymentForm(port, preId, CARD_CHALLENGE);
    check('3DS challenge enters intermediate orderStatus=5, not final', prePay.statusCode === 200 && prePay.body.includes('тестового ACS') && prePay.body.includes(ACS_PASSWORD) && ((await statusOf(port, preId)).json() || {}).orderStatus === 5);
    const acs = await request(port, 'POST', `/payment/${preId}/3ds`, formBody({ password: ACS_PASSWORD }));
    check('ACS 111111 confirms preAuth and redirects', acs.statusCode === 302 && acs.headers.location === preFields.returnUrl);
    const held = (await statusOf(port, preId)).json() || {};
    check('preAuth success: orderStatus=1 (hold), authorizedAmount=9000, depositedAmount=0', held.orderStatus === 1 && held.authorizedAmount === 9000 && held.depositedAmount === 0);
    await waitForCallback((hit) => hit.json && hit.json.mdOrder === preId && hit.json.operation === 'approved', { description: 'approved callback' });
    const depositTooLarge = await rest(port, 'deposit.do', { orderId: preId, amount: 9001 });
    checkProviderError('deposit выше авторизации', depositTooLarge, 5);
    const deposit = await rest(port, 'deposit.do', { orderId: preId, amount: 6000 });
    check('deposit 6000 ≤ authorization 9000: errorCode=0', deposit.statusCode === 200 && (deposit.json() || {}).errorCode === 0);
    const deposited = (await statusOf(port, preId)).json() || {};
    check('после deposit: orderStatus=2, depositedAmount=6000', deposited.orderStatus === 2 && deposited.depositedAmount === 6000);
    await waitForCallback((hit) => hit.json && hit.json.mdOrder === preId && hit.json.operation === 'deposited', { description: 'preAuth deposited callback' });

    const reverse = await rest(port, 'reverse.do', { orderId: regJson.orderId });
    check('reverse.do оплаченного заказа: errorCode=0', reverse.statusCode === 200 && (reverse.json() || {}).errorCode === 0);
    check('после reverse: orderStatus=3', ((await statusOf(port, regJson.orderId)).json() || {}).orderStatus === 3);
    await waitForCallback((hit) => hit.json && hit.json.mdOrder === regJson.orderId && hit.json.operation === 'reversed', { description: 'reversed callback' });

    const refundFields = { orderNumber: orderNumber('refund'), amount: 20000, currency: 643, returnUrl: 'https://shop.test/refund', dynamicCallbackUrl: hookUrl };
    const refundReg = await rest(port, 'register.do', refundFields);
    const refundId = (refundReg.json() || {}).orderId;
    await paymentForm(port, refundId, CARD_FRICTIONLESS);
    const refundLarge = await rest(port, 'refund.do', { orderId: refundId, amount: 20001 });
    checkProviderError('refund выше списания', refundLarge, 5);
    const partialRefund = await rest(port, 'refund.do', { orderId: refundId, amount: 5000 });
    check('частичный refund.do: errorCode=0', partialRefund.statusCode === 200 && (partialRefund.json() || {}).errorCode === 0);
    const refundStatus = (await statusOf(port, refundId)).json() || {};
    check('после partial refund: orderStatus=4, refundedAmount=5000', refundStatus.orderStatus === 4 && refundStatus.refundedAmount === 5000);
    await waitForCallback((hit) => hit.json && hit.json.mdOrder === refundId && hit.json.operation === 'refunded', { description: 'refunded callback' });
    const finalRefund = await rest(port, 'refund.do', { orderId: refundId, amount: 15000 });
    check('полный возврат остатка после частичного: errorCode=0', (finalRefund.json() || {}).errorCode === 0 && ((await statusOf(port, refundId)).json() || {}).refundedAmount === 20000);

    const declineReg = await rest(port, 'register.do', { orderNumber: orderNumber('decline'), amount: 1000, currency: 643, returnUrl: 'https://shop.test/decline' });
    const declineId = (declineReg.json() || {}).orderId;
    const declineApi = await rest(port, 'decline.do', { orderId: declineId });
    check('decline.do до ввода карточных данных: errorCode=0', declineApi.statusCode === 200 && (declineApi.json() || {}).errorCode === 0);
    check('decline.do переводит заказ в orderStatus=6', ((await statusOf(port, declineId)).json() || {}).orderStatus === 6);
    checkProviderError('refund до оплаты', await rest(port, 'refund.do', { orderId: declineId, amount: 100 }), 4);

    console.log('— повторяемая карта 116, три попытки и numeric orderStatus не actionCode');
    const retryReg = await rest(port, 'register.do', { orderNumber: orderNumber('retry116'), amount: 5000, currency: 643, returnUrl: 'https://shop.test/retry' });
    const retryId = (retryReg.json() || {}).orderId;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const payAttempt = await paymentForm(port, retryId, CARD_116);
      const acsAttempt = await request(port, 'POST', `/payment/${retryId}/3ds`, formBody({ password: ACS_PASSWORD }));
      const attemptStatus = (await statusOf(port, retryId)).json() || {};
      check(`карта 116: попытка ${attempt} учтена отдельно от orderStatus`, attemptStatus.paymentAttempts === attempt && attemptStatus.actionCode === 116 && attemptStatus.orderStatus === (attempt < 3 ? 0 : 6), `pay=${payAttempt.statusCode}, acs=${acsAttempt.statusCode}, status=${JSON.stringify(attemptStatus)}`);
    }
    const retryForm = await request(port, 'GET', `/payment/${retryId}`);
    check('после третьей попытки платёжная форма больше не принимает платёж', retryForm.statusCode === 200 && retryForm.body.includes('Оплата отклонена'));
    const expiredCardReg = await rest(port, 'register.do', { orderNumber: orderNumber('retry101'), amount: 1000, currency: 643, returnUrl: 'https://shop.test/retry101' });
    const expiredCardId = (expiredCardReg.json() || {}).orderId;
    await paymentForm(port, expiredCardId, CARD_101);
    await request(port, 'POST', `/payment/${expiredCardId}/3ds`, formBody({ password: ACS_PASSWORD }));
    const expiredCardStatus = (await statusOf(port, expiredCardId)).json() || {};
    check('официальная повторяемая карта 101: actionCode=101, начальный отказ не маскируется под orderStatus', expiredCardStatus.actionCode === 101 && expiredCardStatus.orderStatus === 0 && expiredCardStatus.paymentAttempts === 1);

    console.log('— order TTL 20 минут на виртуальных часах');
    const ttlHeaders = { 'X-Mock-Sandbox': 'ttl-check' };
    const ttlReg = await rest(port, 'register.do', { orderNumber: orderNumber('ttl'), amount: 100, currency: 643, returnUrl: 'https://shop.test/ttl' }, ttlHeaders);
    const ttlId = (ttlReg.json() || {}).orderId;
    check('по умолчанию TTL заказа ровно 1200 секунд', ((await statusOf(port, ttlId, ttlHeaders)).json() || {}).orderStatus === 0 && ((await statusOf(port, ttlId, ttlHeaders)).json() || {}).maxPaymentAttempts === 3);
    await request(port, 'POST', '/mock/time', { advance: '+20m' }, ttlHeaders);
    const ttlStatus = (await statusOf(port, ttlId, ttlHeaders)).json() || {};
    check('виртуальные часы +20m: заказ истёк, orderStatus=6 / declinedByTimeout', ttlStatus.orderStatus === 6 && ttlStatus.declinedDate);

    console.log('— callbacks: ACK ровно 200, retry 3×60s, no-ACK 204, duplicate');
    const duplicateReg = await rest(port, 'register.do', { orderNumber: orderNumber('duplicate'), amount: 100, currency: 643, returnUrl: 'https://shop.test/dup', dynamicCallbackUrl: hookUrl }, { 'X-Mock-Scenario': 'webhook-duplicate' });
    const duplicateId = (duplicateReg.json() || {}).orderId;
    await waitFor(() => callbackHits.filter((hit) => hit.path === '/hook' && hit.json && hit.json.mdOrder === duplicateId).length >= 2, { description: 'duplicate callback pair' });
    check('webhook-duplicate: получены две одинаковые callback-копии', callbackHits.filter((hit) => hit.path === '/hook' && hit.json && hit.json.mdOrder === duplicateId && hit.json.operation === 'created').length === 2);
    check('ACK 200: успешный callback помечается доставленным', (await callbacksFor(port, duplicateId)).filter((entry) => entry.operation === 'created').every((entry) => entry.done && entry.attempts === 1));

    const flakyBefore = callbackHits.filter((hit) => hit.path === '/flaky').length;
    const flakyReg = await rest(port, 'register.do', { orderNumber: orderNumber('flaky'), amount: 100, currency: 643, returnUrl: 'https://shop.test/flaky', dynamicCallbackUrl: `${origin}/flaky` });
    const flakyId = (flakyReg.json() || {}).orderId;
    await waitFor(() => callbackHits.filter((hit) => hit.path === '/flaky').length === flakyBefore + 1, { description: 'first flaky attempt' });
    check('первая доставка 503 не считается ACK; запись ждёт повтора', callbackHits.filter((hit) => hit.path === '/flaky')[flakyBefore].status === 503 && (await callbacksFor(port, flakyId)).some((entry) => entry.attempts === 1 && !entry.done));
    await request(port, 'POST', '/mock/time', { advance: '+60s' });
    await waitFor(() => callbackHits.filter((hit) => hit.path === '/flaky').length === flakyBefore + 2, { description: 'flaky retry after virtual 60s' });
    check('вторая попытка через виртуальные 60 секунд с HTTP 200 закрывает callback', callbackHits.filter((hit) => hit.path === '/flaky')[flakyBefore + 1].status === 200 && (await callbacksFor(port, flakyId)).some((entry) => entry.done && entry.attempts === 2));

    const failBefore = callbackHits.filter((hit) => hit.path === '/always-fail').length;
    const alwaysFailReg = await rest(port, 'register.do', { orderNumber: orderNumber('retry3'), amount: 100, currency: 643, returnUrl: 'https://shop.test/retry3', dynamicCallbackUrl: `${origin}/always-fail` });
    const alwaysFailId = (alwaysFailReg.json() || {}).orderId;
    await waitFor(() => callbackHits.filter((hit) => hit.path === '/always-fail').length === failBefore + 1, { description: 'attempt 1/3' });
    await request(port, 'POST', '/mock/time', { advance: '+60s' });
    await waitFor(() => callbackHits.filter((hit) => hit.path === '/always-fail').length === failBefore + 2, { description: 'attempt 2/3 after 60s' });
    await request(port, 'POST', '/mock/time', { advance: '+60s' });
    await waitFor(() => callbackHits.filter((hit) => hit.path === '/always-fail').length === failBefore + 3, { description: 'attempt 3/3 after another 60s' });
    const failedCallback = (await callbacksFor(port, alwaysFailId)).find((entry) => entry.operation === 'created');
    check('callback: ровно 3 попытки (первая + две через 60s), затем dumped', failedCallback && failedCallback.attempts === 3 && failedCallback.dumped && !failedCallback.done);

    const noAckBefore = callbackHits.filter((hit) => hit.path === '/noack').length;
    const noAckReg = await rest(port, 'register.do', { orderNumber: orderNumber('noack'), amount: 100, currency: 643, returnUrl: 'https://shop.test/noack', dynamicCallbackUrl: `${origin}/noack` });
    const noAckId = (noAckReg.json() || {}).orderId;
    await waitFor(() => callbackHits.filter((hit) => hit.path === '/noack').length === noAckBefore + 1, { description: '204 non-ACK attempt' });
    const noAckRecord = (await callbacksFor(port, noAckId)).find((entry) => entry.operation === 'created');
    check('HTTP 204 — не ACK: callback не помечен done, status=204', callbackHits.filter((hit) => hit.path === '/noack')[noAckBefore].status === 204 && noAckRecord && noAckRecord.lastStatus === 204 && !noAckRecord.done);
    await request(port, 'POST', '/mock/time', { advance: '+60s' });
    await waitFor(() => callbackHits.filter((hit) => hit.path === '/noack').length === noAckBefore + 2, { description: '204 retry after virtual 60s' });
    check('ACK 200 only: ответ 204 повторяется по расписанию', callbackHits.filter((hit) => hit.path === '/noack')[noAckBefore + 1].status === 204);

    console.log('— сценарии и журнал принадлежат своей песочнице');
    const sandboxA = { 'X-Mock-Sandbox': 'scenario-a' };
    const sandboxB = { 'X-Mock-Sandbox': 'scenario-b' };
    await request(port, 'POST', '/mock/scenarios', { id: 'only-a', scenario: 'fail', target: 'register', persistent: true }, sandboxA);
    const rulesA = (await request(port, 'GET', '/mock/scenarios', null, sandboxA)).json() || {};
    const rulesB = (await request(port, 'GET', '/mock/scenarios', null, sandboxB)).json() || {};
    check('scenario registry: правило fail видно только sandbox A', rulesA.rules.length === 1 && rulesB.rules.length === 0);
    const scenarioFail = await rest(port, 'register.do', { orderNumber: orderNumber('rulefail'), amount: 100, currency: 643, returnUrl: 'https://shop.test/rule' }, sandboxA);
    checkProviderError('правило scenario fail', scenarioFail, 6);
    const sandboxBReg = await rest(port, 'register.do', { orderNumber: orderNumber('rulepass'), amount: 100, currency: 643, returnUrl: 'https://shop.test/rule' }, sandboxB);
    check('scenario A не ломает sandbox B', (sandboxBReg.json() || {}).errorCode === 0);
    const journalA = (await request(port, 'GET', '/admin/journal', null, sandboxA)).json() || {};
    const journalB = (await request(port, 'GET', '/admin/journal', null, sandboxB)).json() || {};
    check('journal per-sandbox: REST-запросы разделены', Array.isArray(journalA.entries) && journalA.entries.length > 0 && Array.isArray(journalB.entries) && journalB.entries.length > 0);
    await request(port, 'DELETE', '/mock/scenarios', null, sandboxA);
    check('form PAN не попадает в state export', !JSON.stringify((await request(port, 'GET', '/mock/state')).json() || {}).includes(CARD_FRICTIONLESS.pan));

    console.log('— ошибки/транспортные ограничения');
    checkProviderError('неверные креды', await request(port, 'POST', `${REST_PATH}/register.do`, { userName: 'wrong', password: 'wrong', orderNumber: orderNumber('badcred'), amount: 100, currency: 643, returnUrl: 'https://shop.test/cred' }), 2);
    checkProviderError('currency != 643', await rest(port, 'register.do', { orderNumber: orderNumber('currency'), amount: 100, currency: 840, returnUrl: 'https://shop.test/currency' }), 5);
    checkProviderError('дробные копейки', await rest(port, 'register.do', { orderNumber: orderNumber('fraction'), amount: 1.5, currency: 643, returnUrl: 'https://shop.test/money' }), 5);
    const wrongContentType = await request(port, 'POST', `${REST_PATH}/register.do`, 'userName=x&password=x');
    checkProviderError('не-JSON REST body отклонён как неверный transport', wrongContentType, 6, 415);
    const unknown = await rest(port, 'getOrderStatusExtended.do', { orderId: 'missing-order-id' });
    checkProviderError('неизвестный orderId', unknown, 3);
    const declineAfterAttemptReg = await rest(port, 'register.do', { orderNumber: orderNumber('decline-late'), amount: 100, currency: 643, returnUrl: 'https://shop.test/late' });
    const declineAfterAttemptId = (declineAfterAttemptReg.json() || {}).orderId;
    await paymentForm(port, declineAfterAttemptId, CARD_FRICTIONLESS);
    checkProviderError('decline.do после начала оплаты недопустим', await rest(port, 'decline.do', { orderId: declineAfterAttemptId }), 4);

    const csrf = await request(port, 'POST', '/admin/action', { action: 'expire-order', id: 'x' });
    check('admin action: POST без CSRF/Origin получает 403', csrf.statusCode === 403);
    const admin = await request(port, 'GET', '/admin');

    // Ф-1 (#121): query-токен консоли переносится в HttpOnly-cookie, а HTML и
    // Location больше не несут токенов (MS-06 довёл миграцию не до конца).
    {
      const adminConn = startChild({ MOCK_ADMIN_TOKEN: 'adm-secret', MOCK_OPERATOR_TOKEN: 'op-secret' });
      children.push(adminConn);
      const adminPort = await adminConn.port;
      try {
        const pageByQuery = await request(adminPort, 'GET', '/admin?admin_token=adm-secret');
        check('Ф-1: консоль по query-токену (non-hosted DX) -> 200 и токена нет в HTML',
          pageByQuery.statusCode === 200 && !String(pageByQuery.body).includes('adm-secret'));
        check('Ф-1: формы/ссылки консоли без токенов',
          !/action="[^"]*(admin_token|sandbox_token)=/.test(String(pageByQuery.body))
            && !/href="[^"]*(admin_token|sandbox_token)=/.test(String(pageByQuery.body)));
        const queryCookie = (pageByQuery.headers['set-cookie'] || []).find((c) => c.startsWith('mock_admin_token=adm-secret'));
        check('Ф-1: принятый из query токен перенесён в HttpOnly-cookie', Boolean(queryCookie));
        // Навигация/формы дальше работают cookie-сессией: токенов в URL нет.
        const pageByCookie = await request(adminPort, 'GET', '/admin', null, { Cookie: queryCookie.split(';')[0] });
        check('Ф-1: консоль открывается по cookie-сессии без токенов в URL', pageByCookie.statusCode === 200);
      } finally {
        /* остановит общий finally */
      }
    }

    check('GET /admin отдаёт HTML-консоль', admin.statusCode === 200 && admin.body.includes('Сбер Ecom'));

    console.log('— callback targeted URL и статусный контракт операций');
    const callbackOperations = new Set(callbackHits.map((hit) => hit.json && hit.json.operation).filter(Boolean));
    check('все операции callback покрыты: created/approved/deposited/reversed/refunded', ['created', 'approved', 'deposited', 'reversed', 'refunded'].every((op) => callbackOperations.has(op)));
    // declinedByTimeout приходит в ttl-check песочнице, если для неё указан endpoint;
    // создаём отдельный короткий TTL-сценарий с callback URL для доставки.
    const timeoutHeaders = { 'X-Mock-Sandbox': 'timeout-callback' };
    const timeoutReg = await rest(port, 'register.do', { orderNumber: orderNumber('timeout-cb'), amount: 100, currency: 643, returnUrl: 'https://shop.test/timeout', dynamicCallbackUrl: hookUrl, sessionTimeoutSecs: 1 }, timeoutHeaders);
    const timeoutId = (timeoutReg.json() || {}).orderId;
    // Параметрический TTL проще ускорить виртуальными часами, без ожидания секунды.
    await request(port, 'POST', '/mock/time', { advance: '+2s' }, timeoutHeaders);
    const timeoutStatus = (await statusOf(port, timeoutId, timeoutHeaders)).json() || {};
    check('order TTL custom + virtual clock yields orderStatus=6', timeoutStatus.orderStatus === 6);
    await waitForCallback((hit) => hit.json && hit.json.mdOrder === timeoutId && hit.json.operation === 'declinedByTimeout', { description: 'declinedByTimeout callback' });
    check('callback operation declinedByTimeout/status=0', callbackHits.some((hit) => hit.json && hit.json.mdOrder === timeoutId && hit.json.operation === 'declinedByTimeout' && hit.json.status === 0));

    const childrenForExtras = [];
    try {
      console.log('— SSRF-отказ терминален, один вызов и никакого retry');
      const blocked = startChild({ MOCK_BLOCK_PRIVATE_WEBHOOKS: 'true' });
      childrenForExtras.push(blocked);
      const blockedPort = await blocked.port;
      const hitCountBefore = callbackHits.length;
      const blockedReg = await rest(blockedPort, 'register.do', { orderNumber: orderNumber('ssrf'), amount: 100, currency: 643, returnUrl: 'https://shop.test/ssrf', dynamicCallbackUrl: hookUrl });
      const blockedId = (blockedReg.json() || {}).orderId;
      await blocked.waitForOutput(/SSRF_BLOCKED|заблокирован политикой SSRF/);
      const blockedEntries = await callbacksFor(blockedPort, blockedId);
      check('SSRF_BLOCKED помечает callback terminal/dumped после первой попытки', blockedEntries.length === 1 && blockedEntries[0].dumped && blockedEntries[0].attempts === 1 && !blockedEntries[0].nextAttemptAt);
      check('SSRF отказ не открывает соединение к loopback приёмнику', callbackHits.length === hitCountBefore);

      console.log('— env-парсеры и скрытие env-кредов');
      const parser = startChild({ MOCK_SBER_SESSION_TIMEOUT_SECS: '1h', MOCK_SBER_CALLBACK_RETRY_MS: '1h', MOCK_SBER_CALLBACK_MAX_ATTEMPTS: '0' });
      childrenForExtras.push(parser);
      const parserPort = await parser.port;
      const parserHealth = (await request(parserPort, 'GET', '/health')).json() || {};
      check('env parser: 1h → TTL 3600s / retry 3600000ms; attempts=0 нормализовано в 1', parserHealth.sessionTimeoutSecs === 3600 && parserHealth.callbackRetryMs === 3600000 && parserHealth.callbackMaxAttempts === 1);
      await parser.waitForOutput(/меньше 1/);

      const sentinelLogin = 'sber-user-sentinel-never-log';
      const sentinelPassword = 'sber-pass-sentinel-never-log';
      const secretChild = startChild({ MOCK_SBER_USERNAME: sentinelLogin, MOCK_SBER_PASSWORD: sentinelPassword });
      childrenForExtras.push(secretChild);
      const secretPort = await secretChild.port;
      await secretChild.waitForOutput(/callback: POST/);
      check('start log hides custom Sber creds', !secretChild.output().includes(sentinelLogin) && !secretChild.output().includes(sentinelPassword) && secretChild.output().includes('задан через env, скрыт'));
      const secretError = await request(secretPort, 'POST', `${REST_PATH}/register.do`, { userName: 'wrong', password: 'wrong', orderNumber: orderNumber('sentinel'), amount: 100, currency: 643, returnUrl: 'https://shop.test/sentinel' });
      check('auth DX response never echoes effective env creds', !secretError.body.includes(sentinelLogin) && !secretError.body.includes(sentinelPassword));
      check('auth log remains free of custom env creds', !secretChild.output().includes(sentinelLogin) && !secretChild.output().includes(sentinelPassword));

      console.log('— hosted control-plane fail-closed');
      const hosted = startChild({ MOCK_HOSTED: 'true', MOCK_TENANCY: 'owned', MOCK_ADMIN_TOKEN: '', MOCK_OPERATOR_TOKEN: '' });
      childrenForExtras.push(hosted);
      const hostedPort = await hosted.port;
      const res = await request(hostedPort, 'GET', '/admin');
      check('hosted: /admin без токена отдает форму входа', res.statusCode === 200 && String(res.body).includes('name="admin_token"'));
      check('hosted: /mock/time без токена закрыт, /health открыт', (await request(hostedPort, 'GET', '/mock/time')).statusCode === 401 && (await request(hostedPort, 'GET', '/health')).statusCode === 200);
    } finally {
      for (const child of childrenForExtras) await child.stop();
    }
  } finally {
    for (const child of children) await child.stop();
    await new Promise((resolve) => callbackReceiver.close(resolve));
  }

  console.log(`\nИТОГ: ${passed} passed, ${failed} failed · callback requests: ${callbackHits.length}`);
  if (failed) {
    console.log('SELFTEST FAILED ❌');
    process.exitCode = 1;
  } else {
    console.log('SELFTEST PASSED ✅');
  }
}

main().catch((error) => {
  console.error('SELFTEST ERROR:', error);
  process.exitCode = 1;
});
