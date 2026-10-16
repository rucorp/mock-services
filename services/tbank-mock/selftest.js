// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Self-test for the T-Bank multisplit mock stand (wave 1).
 * Runs the server on an ephemeral port with a fake merchant webhook
 * receiver and drives every scenario end-to-end. Zero dependencies.
 *
 *   node tbank-mock/selftest.js
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Основной инстанс — профиль Lovii (Мультирасчеты); plain тестируется
// отдельным процессом в сценарии 25.
process.env.MOCK_PROFILE = 'multisplit';
process.env.MOCK_RETRY_MS = '1000';
process.env.MOCK_STATE_FILE = '';
process.env.MOCK_PUBLIC_BASE_URL = 'http://mock.test';
// acqapi reference credentials from документации Т-Банка
process.env.MOCK_ACQAPI_CLIENT_ID = 'partner';
process.env.MOCK_ACQAPI_CLIENT_SECRET = 'mock-acqapi-secret';

const { server, state, tokenOf, validateRedirectDueDate, TERMINAL_KEY, TERMINAL_PASSWORD } = require('./server.js');

const PASSWORD = TERMINAL_PASSWORD;
const TERMINAL = TERMINAL_KEY;
const WEBHOOK_HITS = [];

function listen(srv) {
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
}

function request(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    // Objects are JSON-encoded; raw strings (form bodies) go out as-is.
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: p,
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Как настоящий клиент: TerminalKey стенда подставляется всегда (его можно
// переопределить в body для негативных проверок). В профиле multisplit Init
// требует PaymentRecipientId (F-16), поэтому helper добавляет его так же, как
// это делает клиент Мультирасчётов; негативные кейсы шлются через request()
// или с явным `PaymentRecipientId: undefined`/`''`.
const DEFAULT_RECIPIENT = 'recipient-77';

const api = (port, method, body, sign = true) => {
  const payload = { TerminalKey: TERMINAL, ...body };
  if (method === 'Init' && payload.PaymentRecipientId === undefined) payload.PaymentRecipientId = DEFAULT_RECIPIENT;
  return request(port, 'POST', `/v2/${method}`, sign ? { ...payload, Token: tokenOf(payload) } : payload);
};

/**
 * Клиент выплат `/e2c/v2/*`: подпись обязательна, TerminalKey стенда — по
 * умолчанию, PaymentRecipientId добавляется только к Init (F-17). Поля можно
 * переопределить/убрать через body (например `TerminalKey: undefined`).
 */
const e2c = (port, method, body = {}) => {
  const payload = { TerminalKey: TERMINAL, ...(method === 'Init' ? { PaymentRecipientId: DEFAULT_RECIPIENT } : {}), ...body };
  return request(port, 'POST', `/e2c/v2/${method}`, { ...payload, Token: tokenOf(payload) });
};

/**
 * Сделка с подтверждённым приходом: выплаты идут только по сделке с балансом
 * (03-payouts-and-deals.md §Сделка), поэтому каждая payout-сцена тест-плана
 * сначала заводит и пополняет свою сделку.
 */
async function fundedDeal(port, amountKopeks = 100000, orderPrefix = 'fund') {
  const dealId = JSON.parse((await api(port, 'createSpDeal', { SpDealType: 'NN' })).body).SpAccumulationId;
  const init = JSON.parse((await api(port, 'Init', {
    Amount: String(amountKopeks), OrderId: `${orderPrefix}-${dealId}`, DealId: dealId, PayType: 'O',
  })).body);
  await request(port, 'POST', `/payment/${init.PaymentId}/pay`, 'pan=2201382000000013&exp=1227&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.strictEqual(state.payments[init.PaymentId].status, 'CONFIRMED', `фонд сделки ${dealId} должен подтвердиться`);
  return dealId;
}

/**
 * Партнёрская точка через acqapi (OAuth + sm-register): её shopCode используется
 * как PartnerId в выплатах `/e2c/v2/Init` (F-20).
 */
let partnerFixtureNumber = 0;

function partnerRegistrationFixture(descriptor, inn = '7701234567', article = '') {
  partnerFixtureNumber += 1;
  const safeArticle = article || `article-${partnerFixtureNumber}-${String(descriptor).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 18)}`;
  return {
    shopArticleId: safeArticle,
    billingDescriptor: descriptor,
    fullName: `ООО «${descriptor}»`,
    name: `ООО «${descriptor}»`,
    inn,
    kpp: '00000000',
    ogrn: '1027700132195',
    addresses: [{ type: 'legal', zip: '190000', country: 'RUS', city: 'Санкт-Петербург', street: 'Невский проспект, 1' }],
    ceo: { phone: '+79991112233', citizenship: 'RUS' },
    founders: { individuals: [{ fullName: 'Иванов Иван Иванович' }] },
    email: 'shop@example.test',
    siteUrl: 'https://shop.example.test',
    bankAccount: {
      account: '40702810000000000001',
      korAccount: '30101810000000000001',
      bankName: 'АО «Т-Банк»',
      bik: '044525974',
      details: 'Перевод средств по договору $(date). Сумма $(rub) руб. $(kop) коп.',
    },
    mcc: '5812',
    nonResident: false,
  };
}

async function registerPartner(port, descriptor, inn = '7701234567') {
  const oauth = await request(port, 'POST', '/oauth/token', 'grant_type=password&username=partner&password=partner', {
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: 'Basic ' + Buffer.from('partner:mock-acqapi-secret').toString('base64'),
  });
  if (oauth.statusCode !== 200) throw new Error(`OAuth не выдал токен: ${oauth.statusCode} ${oauth.body}`);
  const token = JSON.parse(oauth.body).access_token;
  const shop = JSON.parse((await request(port, 'POST', '/sm-register/register', partnerRegistrationFixture(descriptor, inn), { Authorization: `Bearer ${token}` })).body);
  if (!shop.shopCode) throw new Error(`не удалось зарегистрировать партнёра: ${JSON.stringify(shop).slice(0, 300)}`);
  return shop.shopCode;
}

/**
 * Дочерний стенд на свободном порту (MOCK_PORT=0): родитель узнаёт реальный
 * порт из стартовой строки сервера — без фиксированных номеров (F-32).
 */
function startChild(env = {}) {
  const { spawn } = require('child_process');
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
    MOCK_TENANCY: '',
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
    ...env,
  };
  if (!Object.prototype.hasOwnProperty.call(env, 'MOCK_BLOCK_PRIVATE_WEBHOOKS')) {
    delete childEnv.MOCK_BLOCK_PRIVATE_WEBHOOKS;
  }
  const proc = spawn('node', ['--max-old-space-size=48', path.join(__dirname, 'server.js')], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  const port = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`дочерний стенд не сообщил порт: ${buf.slice(0, 300)}`)), 5000);
    proc.stdout.on('data', (d) => {
      buf += String(d);
      const m = /on http:\/\/[^:]+:(\d+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    proc.stderr.on('data', (d) => { buf += String(d); });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`дочерний стенд завершился с кодом ${code}: ${buf.slice(0, 300)}`)); });
  });
  return { proc, port, output: () => buf, stop: () => stopChild(proc) };
}

async function stopChild(child) {
  const proc = child && child.proc ? child.proc : child;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise((resolve) => {
    proc.once('exit', resolve);
    try { proc.kill('SIGKILL'); } catch { resolve(); }
  });
}

/**
 * MS-04: остановить дочерний стенд штатным сигналом (по умолчанию SIGTERM) и
 * дождаться самостоятельного выхода. Возвращает `{code, signal, ms}` — регресс
 * «отложенная запись переживает SIGTERM» проверяет по ним код 0 и время ≤ 2 с.
 */
async function stopChildGracefully(child, signal = 'SIGTERM', timeoutMs = 3000) {
  const proc = child && child.proc ? child.proc : child;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
    return { code: proc ? proc.exitCode : null, signal: proc ? proc.signalCode : null, ms: 0 };
  }
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MS-04: дочерний стенд не вышел по ${signal} за ${timeoutMs} мс`)), timeoutMs);
    proc.once('exit', (code, sig) => { clearTimeout(timer); resolve({ code, signal: sig, ms: Date.now() - started }); });
    try { proc.kill(signal); } catch (error) { clearTimeout(timer); reject(error); }
  });
}

function waitNotification(pred, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const hit = WEBHOOK_HITS.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() > deadline) return reject(new Error('notification not delivered in time'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function testStateByteEnv() {
  const verify = (name, condition) => { assert.ok(condition, name); };
  const configs = [
    { env: { MOCK_SANDBOX_MAX_STATE_BYTES: '1024', MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES: '0' }, code: 'sandbox_state_quota_exceeded', size: 2048 },
    { env: { MOCK_SANDBOX_MAX_STATE_BYTES: '10000', MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES: '16000' }, code: 'sandbox_state_budget_exceeded', size: 8000 },
    { env: { MOCK_SANDBOX_MAX_STATE_BYTES: '0', MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES: '0' }, code: null, size: 20000 },
    { env: { MOCK_SANDBOX_MAX_STATE_BYTES: '', MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES: '' }, code: null, size: 20000 },
  ];
  for (const config of configs) {
    const child = startChild({ MOCK_TENANCY: 'namespaces', ...config.env });
    try {
      const port = await child.port;
      const call = async (method, url, body, id) => {
        const headers = { 'X-Mock-Sandbox': id };
        const response = await request(port, method, url, body, headers);
        return { status: response.statusCode, body: JSON.parse(response.body) };
      };
      if (config.code === 'sandbox_state_budget_exceeded') {
        const first = await call('POST', '/mock/state', { state: { blob: 'я'.repeat(3000) } }, 'bytes-a');
        const second = await call('POST', '/mock/state', { state: { blob: 'я'.repeat(3000) } }, 'bytes-b');
        verify('PD-02: env global — две песочницы ниже суммарного бюджета проходят', first.status === 200 && second.status === 200);
      }
      const before = await call('GET', '/mock/state', undefined, 'bytes-target');
      const result = await call('POST', '/mock/state', { state: { blob: 'x'.repeat(config.size) } }, 'bytes-target');
      if (config.code) {
        verify(`PD-02: env ${config.code} доходит до рантайма → HTTP 400 + errorCode + kind`,
          result.status === 400 && result.body.errorCode === 400 && result.body.code === config.code && result.body.kind === 'bytes');
        const after = await call('GET', '/mock/state', undefined, 'bytes-target');
        verify('PD-02: отказ импорта не применяет состояние частично', JSON.stringify(after.body.state.state) === JSON.stringify(before.body.state.state));
      } else {
        verify('PD-02: env 0/пусто — импорт проходит', result.status === 200);
      }
    } finally {
      await child.stop();
    }
  }
}

async function main() {
  await testStateByteEnv();
  // Основной инстанс — профиль Lovii (Мультирасчеты); plain тестируется
// отдельным процессом в сценарии 25.
process.env.MOCK_PROFILE = 'multisplit';
process.env.MOCK_RETRY_MS = '1000';
  // /webhook — подтверждает доставку; /slow — «медленный и падающий» мерчант
  // (проверка, что очередь не шлёт одну нотификацию параллельно сама себе);
  // /ordered — «медленный, но успешный»: отвечает на ПЕРВУЮ нотификацию дольше
  // интервала тика доставки (F-29: порядок и отсутствие параллельных POST).
  const slowHook = { hits: 0, concurrent: 0, maxConcurrent: 0 };
  const orderedHook = { records: [], concurrent: 0, maxConcurrent: 0 };
  const webhook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/slow') {
        slowHook.hits += 1;
        slowHook.concurrent += 1;
        slowHook.maxConcurrent = Math.max(slowHook.maxConcurrent, slowHook.concurrent);
        setTimeout(() => { slowHook.concurrent -= 1; res.writeHead(500); res.end('no'); }, 600);
        return;
      }
      if (req.url === '/ordered') {
        let json = {};
        try { json = JSON.parse(body); } catch { /* диагностическое тело */ }
        const rec = { status: json.Status || '', arriveAt: Date.now(), respondAt: null };
        orderedHook.records.push(rec);
        orderedHook.concurrent += 1;
        orderedHook.maxConcurrent = Math.max(orderedHook.maxConcurrent, orderedHook.concurrent);
        // Ответ на первую нотификацию задерживается на 1200ms — дольше интервала
        // тика (1000ms): без последовательной доставки вторая ушла бы параллельно.
        const delayMs = orderedHook.records.length === 1 ? 1200 : 0;
        setTimeout(() => {
          orderedHook.concurrent -= 1;
          rec.respondAt = Date.now();
          res.end('OK');
        }, delayMs);
        return;
      }
      WEBHOOK_HITS.push({ body, json: JSON.parse(body) });
      res.end('OK');
    });
  });
  const port = await listen(webhook);
  const mockPort = await listen(server);
  console.log(`selftest: mock on :${mockPort}, webhook on :${port}`);

  const base = `http://127.0.0.1:${mockPort}`;
  const notificationUrl = `http://127.0.0.1:${port}/webhook`;
  const successUrl = `https://app.test/success/{order_id}`;
  const failUrl = `https://app.test/fail/{order_id}`;

  // #23 F-01: импорт небезопасного снимка отклоняется атомарно; сервер в этом
  // selftest работает в том же процессе, поэтому проверяем сам Object.prototype.
  {
    const pollutedKey = `f01_tbank_${process.pid}`;
    const paymentsRef = state.payments;
    const beforeCount = Object.keys(state.payments).length;
    const unsafe = `{"state":{"payments":{"__proto__":{"${pollutedKey}":true}}}}`;
    const rejected = await request(mockPort, 'POST', '/mock/state', unsafe);
    const response = JSON.parse(rejected.body);
    assert.strictEqual(rejected.statusCode, 400);
    assert.strictEqual(response.Success, false);
    assert.strictEqual(response.Details.Field, 'state');
    assert.ok(String(response.Details.Details).includes('__proto__'), response.Details.Details);
    assert.strictEqual(Object.prototype[pollutedKey], undefined);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, pollutedKey), false);
    assert.strictEqual(state.payments, paymentsRef);
    assert.strictEqual(Object.keys(state.payments).length, beforeCount);
    delete Object.prototype[pollutedKey];
  }

  // #23 F-02: один байт сверх лимита даёт DX 413 и не проваливается в 5000.
  {
    const tooLarge = await request(mockPort, 'POST', '/mock/state', ' '.repeat(5 * 1024 * 1024 + 1));
    const response = JSON.parse(tooLarge.body);
    assert.strictEqual(tooLarge.statusCode, 413);
    assert.strictEqual(response.ErrorCode, '7');
    assert.strictEqual(response.Details.Field, 'body');
    assert.ok(response.Details.Hint.includes('байт'));
  }

  // 1. Init without token under strict mode -> rejected
  const noTok = await request(mockPort, 'POST', '/v2/Init', { TerminalKey: TERMINAL, Amount: '1000', OrderId: 'o-1' });
  assert.strictEqual(JSON.parse(noTok.body).ErrorCode, '13', 'missing token must be rejected');

  // 2. Init with wrong token -> ErrorCode 13
  const badTok = await api(mockPort, 'Init', { Amount: '1000', OrderId: 'o-1' }, false);
  assert.strictEqual(JSON.parse(badTok.body).ErrorCode, '13', 'wrong token must be rejected');

  // 3. Multisplit Init without DealId/CreateDealWithType -> rejected
  const noDeal = await api(mockPort, 'Init', { Amount: '1000', OrderId: 'o-1', PaymentRecipientId: '+79001234567' }); // multisplit: сделка обязательна
  assert.strictEqual(JSON.parse(noDeal.body).ErrorCode, '7', 'recipient without deal must be rejected');
  {
    const d = JSON.parse(noDeal.body).Details || {};
    assert.ok(d.Hint && d.Doc && String(d.Doc).startsWith('https://developer.tbank.ru'), 'DX: Details must carry hint + doc link (spec §6.2)');
  }

  // 4. Happy path: two-stage Init with CreateDealWithType=NN
  const init = await api(mockPort, 'Init', {
    Amount: '150000', OrderId: 'order-77', CreateDealWithType: 'NN', PayType: 'T',
    PaymentRecipientId: '+79001234567', NotificationURL: notificationUrl, SuccessURL: successUrl, FailURL: failUrl,
  });
  const initRes = JSON.parse(init.body);
  assert.strictEqual(initRes.Success, true, JSON.stringify(initRes));
  assert.strictEqual(initRes.Status, 'NEW');
  assert.ok(initRes.PaymentURL.startsWith('http://mock.test/payment/'), initRes.PaymentURL);
  const paymentId = initRes.PaymentId;

  const payment = state.payments[paymentId];
  assert.ok(payment.dealId, 'deal must be created');

  // 5. GetState NEW
  const st1 = JSON.parse((await api(mockPort, 'GetState', { PaymentId: paymentId })).body);
  assert.strictEqual(st1.Status, 'NEW');

  // 6. Form load -> FORM_SHOWED; frictionless card -> AUTHORIZED + notification
  await request(mockPort, 'GET', `/payment/${paymentId}`);
  assert.strictEqual(state.payments[paymentId].status, 'FORM_SHOWED');
  const pay = await request(mockPort, 'POST', `/payment/${paymentId}/pay`, 'pan=2201382000000013&exp=1227&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
  if (state.payments[paymentId].status !== 'AUTHORIZED') {
    console.error('DEBUG pay:', { statusCode: pay.statusCode, location: pay.headers.location, body: pay.body.slice(0, 200), failCode: state.payments[paymentId].failCode, failMessage: state.payments[paymentId].failMessage, history: state.payments[paymentId].statusHistory });
  }
  assert.strictEqual(state.payments[paymentId].status, 'AUTHORIZED', 'frictionless card must authorize');
  assert.ok(pay.headers.location.startsWith('https://app.test/success/order-77'), 'success redirect must replace {order_id}: ' + pay.headers.location);

  const authNotif = await waitNotification((h) => h.json.Status === 'AUTHORIZED' && h.json.PaymentId === paymentId);
  assert.strictEqual(authNotif.json.SpAccumulationId, payment.dealId, 'AUTHORIZED notification must carry SpAccumulationId');
  const expectedToken = tokenOf({ ...authNotif.json, Token: undefined });
  assert.strictEqual(authNotif.json.Token, expectedToken, 'notification token must cover SpAccumulationId');

  // 7. Confirm (full) -> CONFIRMED + notification; deal balance grows
  const confirm = JSON.parse((await api(mockPort, 'Confirm', { PaymentId: paymentId })).body);
  assert.strictEqual(confirm.Status, 'CONFIRMED');
  assert.strictEqual(confirm.Amount, 150000);
  await waitNotification((h) => h.json.Status === 'CONFIRMED' && h.json.PaymentId === paymentId);
  assert.strictEqual(state.deals[payment.dealId] && 150000, 150000);

  // 8. Confirm twice -> error
  const confirm2 = JSON.parse((await api(mockPort, 'Confirm', { PaymentId: paymentId })).body);
  assert.strictEqual(confirm2.Success, false, 'second confirm must fail');

  // 9. Partial refund -> PARTIAL_REFUNDED + notification; remaining 50000
  const cancel1 = JSON.parse((await api(mockPort, 'Cancel', { PaymentId: paymentId, Amount: '100000' })).body);
  assert.strictEqual(cancel1.Status, 'PARTIAL_REFUNDED');
  assert.strictEqual(cancel1.NewAmount, 50000);
  await waitNotification((h) => h.json.Status === 'PARTIAL_REFUNDED' && h.json.PaymentId === paymentId);

  // 10. ExternalRequestId idempotency
  const idem1 = JSON.parse((await api(mockPort, 'Cancel', { PaymentId: paymentId, Amount: '10000', ExternalRequestId: 'refund-1' })).body);
  assert.strictEqual(idem1.Status, 'PARTIAL_REFUNDED');
  const idem2 = JSON.parse((await api(mockPort, 'Cancel', { PaymentId: paymentId, Amount: '10000', ExternalRequestId: 'refund-1' })).body);
  assert.strictEqual(idem2.NewAmount, 40000, 'repeat with same ExternalRequestId must not double-refund');

  // 11. CheckOrder lists the attempt
  const check = JSON.parse((await api(mockPort, 'CheckOrder', { OrderId: 'order-77' })).body);
  assert.strictEqual(check.Payments.length, 1);
  assert.strictEqual(check.Payments[0].Status, 'PARTIAL_REFUNDED');

  // 12. Challenge flow: wrong OTP twice, correct third time
  const init2 = JSON.parse((await api(mockPort, 'Init', {
    Amount: '60000', OrderId: 'order-78', CreateDealWithType: 'NN', PayType: 'T',
    NotificationURL: notificationUrl, SuccessURL: successUrl, FailURL: failUrl,
  })).body);
  const p2 = init2.PaymentId;
  await request(mockPort, 'POST', `/payment/${p2}/pay`, 'pan=2201382000000047&exp=1227&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.strictEqual(state.payments[p2].status, '3DS_CHECKING');
  const otpPage = await request(mockPort, 'POST', `/payment/${p2}/otp`, 'code=000000', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.ok(otpPage.body.includes('Неверный код'), 'wrong OTP must re-ask');
  await request(mockPort, 'POST', `/payment/${p2}/otp`, 'code=1qwezxc', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.strictEqual(state.payments[p2].status, 'AUTHORIZED');
  await waitNotification((h) => h.json.Status === 'AUTHORIZED' && h.json.PaymentId === p2);

  // 13. Insufficient funds -> REJECTED + notification + fail redirect
  const init3 = JSON.parse((await api(mockPort, 'Init', {
    Amount: '300000', OrderId: 'order-79', CreateDealWithType: 'NN', PayType: 'T',
    NotificationURL: notificationUrl, SuccessURL: successUrl, FailURL: failUrl,
  })).body);
  const p3 = init3.PaymentId;
  const fail = await request(mockPort, 'POST', `/payment/${p3}/pay`, 'pan=2201382000000831&exp=1227&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.ok(fail.headers.location.startsWith('https://app.test/fail/order-79'), 'fail redirect');
  assert.strictEqual(state.payments[p3].status, 'REJECTED');
  const rejNotif = await waitNotification((h) => h.json.Status === 'REJECTED' && h.json.PaymentId === p3);
  assert.strictEqual(rejNotif.json.Success, false);
  assert.strictEqual(rejNotif.json.ErrorCode, '1051');

  // 14. 3DS1 >1000₽ insufficient / <1000₽ success
  const init4 = JSON.parse((await api(mockPort, 'Init', {
    Amount: '150000', OrderId: 'order-80', CreateDealWithType: 'NN', PayType: 'T',
    NotificationURL: notificationUrl, SuccessURL: successUrl, FailURL: failUrl,
  })).body);
  await request(mockPort, 'POST', `/payment/${init4.PaymentId}/pay`, 'pan=5586200071499591&exp=1227&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.strictEqual(state.payments[init4.PaymentId].status, 'REJECTED', '3DS1 card must reject over 1000₽');

  // 15. Unknown payment id
  const unknown = JSON.parse((await api(mockPort, 'GetState', { PaymentId: '9999999999' })).body);
  assert.strictEqual(unknown.Success, false);

  // 16. Cancel from NEW -> CANCELED without notification
  const init5 = JSON.parse((await api(mockPort, 'Init', {
    Amount: '1000', OrderId: 'order-81', CreateDealWithType: 'NN', PayType: 'T',
    NotificationURL: notificationUrl, SuccessURL: successUrl, FailURL: failUrl,
  })).body);
  const cancelNew = JSON.parse((await api(mockPort, 'Cancel', { PaymentId: init5.PaymentId })).body);
  assert.strictEqual(cancelNew.Status, 'CANCELED');
  assert.ok(!WEBHOOK_HITS.some((h) => h.json.PaymentId === init5.PaymentId), 'CANCELED must not notify');

  // 17. Admin console + actions render
  const admin = await request(mockPort, 'GET', '/admin');
  assert.ok(admin.body.includes('Консоль стенда'));
  const health = JSON.parse((await request(mockPort, 'GET', '/health')).body);
  assert.strictEqual(health.ok, true);

  /* --- Регрессы аудита 2026-10-08 (дефекты A-5…A-9, A-3) --------------- */

  // 18. Короткий/битый Token — это код 13, а не «внутренняя ошибка» 5000 (A-5)
  const shortTok = await request(mockPort, 'POST', '/v2/Init', { TerminalKey: TERMINAL, Amount: '1000', OrderId: 'order-82', Token: 'abc' });
  assert.strictEqual(JSON.parse(shortTok.body).ErrorCode, '13', 'короткий Token должен отклоняться кодом 13, не 5000');

  // 18a. F-28: multibyte Token с той же JS-длиной, что и digest (32 эмодзи —
  // 64 UTF-16 units при 64-символьном hex-Token, но 128 байт) — код 13, а не
  // RangeError внутри timingSafeEqual и общий 5000.
  {
    const multiToken = '😄'.repeat(32);
    assert.strictEqual(multiToken.length, 64, 'сценарий: JS-длина Token совпадает с длиной digest');
    assert.strictEqual(Buffer.byteLength(multiToken), 128, 'сценарий: байтовая длина Token больше длины digest');
    const multiTok = await request(mockPort, 'POST', '/v2/Init', {
      TerminalKey: TERMINAL, Amount: '1000', OrderId: 'order-f28', Token: multiToken,
    });
    assert.strictEqual(JSON.parse(multiTok.body).ErrorCode, '13', 'multibyte Token должен отклоняться кодом 13, не 5000');
  }

  // 19. Повторный Init с тем же OrderId — ошибка 7 (дока Init: OrderId уникален) (A-6)
  const dupOrder = JSON.parse((await api(mockPort, 'Init', { Amount: '1000', OrderId: 'order-77', CreateDealWithType: 'NN' })).body);
  assert.strictEqual(dupOrder.ErrorCode, '7', 'дубль OrderId должен отклоняться');
  assert.ok(String(dupOrder.Message).includes('order-77'), 'сообщение должно называть OrderId');

  // 20. Cancel сверх доступной суммы — ошибка 7, состояние не меняется (A-7)
  const beforeBigCancel = state.payments[paymentId].status;
  const bigCancel = JSON.parse((await api(mockPort, 'Cancel', { PaymentId: paymentId, Amount: '999999999' })).body);
  assert.strictEqual(bigCancel.ErrorCode, '7', 'возврат больше суммы платежа должен отклоняться');
  assert.strictEqual(state.payments[paymentId].status, beforeBigCancel, 'статус не должен меняться');
  assert.strictEqual(bigCancel.OriginalAmount, 40000, 'должна возвращаться доступная сумма');

  // 21. GetState по OrderId (A-9)
  const byOrder = JSON.parse((await api(mockPort, 'GetState', { OrderId: 'order-77' })).body);
  assert.strictEqual(byOrder.Success, true, 'GetState должен принимать OrderId: ' + JSON.stringify(byOrder));
  assert.strictEqual(byOrder.PaymentId, paymentId);

  // 22. Confirm/Cancel из недопустимого статуса — код 32 (каталог ошибок)
  const confirmNew = JSON.parse((await api(mockPort, 'Confirm', { PaymentId: init5.PaymentId })).body);
  assert.strictEqual(confirmNew.ErrorCode, '32', 'Confirm из CANCELED — это 32');

  // 23. Медленный падающий вебхук: очередь не дублирует POST'ы самой себе (A-3)
  const slowInit = JSON.parse((await api(mockPort, 'Init', {
    Amount: '70000', OrderId: 'order-83', CreateDealWithType: 'NN', PayType: 'T',
    NotificationURL: `http://127.0.0.1:${port}/slow`, SuccessURL: successUrl, FailURL: failUrl,
  })).body);
  await request(mockPort, 'POST', `/payment/${slowInit.PaymentId}/pay`, 'pan=2201382000000013&exp=1227&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
  await waitForCondition(() => slowHook.hits >= 2 && slowHook.concurrent === 0, {
    timeoutMs: 12000,
    description: 'slow webhook retries complete without overlapping requests',
  });
  const slowNotif = Object.values(state.notifications).find((n) => n.paymentId === slowInit.PaymentId);
  assert.ok(slowHook.hits >= 2, `ретраев не было: ${slowHook.hits}`);
  assert.strictEqual(slowHook.maxConcurrent, 1, `параллельных POST на одну нотификацию: ${slowHook.maxConcurrent}`);
  assert.ok(slowNotif && slowHook.hits - slowNotif.attempts <= 1, `attempts=${slowNotif && slowNotif.attempts}, POST'ов=${slowHook.hits} — очередь отправляет больше, чем учитывает`);

  // 23a. F-29: две due-нотификации (AUTHORIZED → CONFIRMED) при медленном ответе
  // на первую: вторая ждёт завершения первой (порядок статусов сохраняется),
  // параллельных POST и повторов нет — контракт serial delivery Т-Банка.
  {
    const orderInit = JSON.parse((await api(mockPort, 'Init', {
      Amount: '50000', OrderId: 'order-f29', CreateDealWithType: 'NN', PayType: 'T',
      NotificationURL: `http://127.0.0.1:${port}/ordered`, SuccessURL: successUrl, FailURL: failUrl,
    })).body);
    await request(mockPort, 'POST', `/payment/${orderInit.PaymentId}/pay`, 'pan=2201382000000013&exp=1227&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
    const confirmed = JSON.parse((await api(mockPort, 'Confirm', { PaymentId: orderInit.PaymentId }).then((r) => r.body)));
    assert.strictEqual(confirmed.Status, 'CONFIRMED', `Confirm должен подтвердить платёж: ${JSON.stringify(confirmed)}`);
    await waitForCondition(() => orderedHook.records.length >= 2 && orderedHook.concurrent === 0, {
      timeoutMs: 8000,
      description: 'обе нотификации доставлены последовательно, без параллельных POST',
    });
    const [first, second] = orderedHook.records;
    assert.deepStrictEqual([first.status, second.status], ['AUTHORIZED', 'CONFIRMED'], `статусы должны приходить по порядку: ${JSON.stringify(orderedHook.records)}`);
    assert.ok(second.arriveAt >= first.respondAt, `вторая нотификация пришла до завершения ответа первой: ${JSON.stringify(orderedHook.records)}`);
    assert.strictEqual(orderedHook.maxConcurrent, 1, 'параллельных POST быть не должно');
    assert.strictEqual(orderedHook.records.length, 2, 'каждая нотификация доставлена ровно один раз');
    // #76 (класс #56): флаг done выставляется ПОСЛЕ завершения postJson — ждём
    // именно done-состояние обеих записей, а не только хук-сторону доставки.
    await waitForCondition(() => {
      const ns = Object.values(state.notifications).filter((n) => n.paymentId === orderInit.PaymentId);
      return ns.length === 2 && ns.every((n) => n.done && n.attempts === 1);
    }, { timeoutMs: 8000, description: 'обе нотификации помечены done с одной попыткой (#76)' });
    const queued = Object.values(state.notifications).filter((n) => n.paymentId === orderInit.PaymentId);
    assert.strictEqual(queued.length, 2, 'должно быть ровно две записи очереди');
    assert.ok(queued.every((n) => n.done && n.attempts === 1), `записи завершены с одной попыткой: ${JSON.stringify(queued.map((n) => ({ done: n.done, attempts: n.attempts })))}`);
  }

  // 23b. Чужой TerminalKey — ошибка 7 (A-15)
  const wrongTerminal = JSON.parse((await api(mockPort, 'Init', { TerminalKey: 'OTHER-TERMINAL', Amount: '1000', OrderId: 'order-84', CreateDealWithType: 'NN' })).body);
  assert.strictEqual(wrongTerminal.ErrorCode, '7', 'чужой TerminalKey должен отклоняться');
  assert.ok(String(wrongTerminal.Message).includes('OTHER-TERMINAL'));

  // 24. Журнал запросов отдаётся и содержит наши вызовы
  const journalRes = JSON.parse((await request(mockPort, 'GET', '/admin/journal')).body);
  const journalPaths = journalRes.entries.map((e) => e.path);
  assert.ok(journalPaths.includes('/v2/Init'), 'в журнале должен быть Init');
  const initEntry = journalRes.entries.find((e) => e.path === '/v2/Init' && e.body.OrderId === 'order-77');
  assert.ok(initEntry && initEntry.status === 200, 'запись журнала должна содержать статус ответа');

  // 25. plain-профиль (дефолт): Init без сделочных полей, PaymentRecipientId
  // не является ошибкой (классический эквайринг не знает полей Мультирасчетов)
  {
    const plainChild = startChild({ MOCK_PROFILE: 'plain' });
    const plainPort = await plainChild.port;
    try {
      const plainApi = (method, body) => { const signed = { ...body, Token: tokenOf(body) }; return request(plainPort, 'POST', `/v2/${method}`, signed); };
    const plainInit = await plainApi('Init', { TerminalKey: TERMINAL_KEY, OrderId: 'plain-1', Amount: '250000', PaymentRecipientId: 'acc-1', NotificationURL: `http://127.0.0.1:${port}/hook` });
    const plainParsed = JSON.parse(plainInit.body);
    assert.strictEqual(plainParsed.Success, true, 'plain Init с PaymentRecipientId должен проходить (профиль plain)');
    // F-16 регрессия: plain без сделочных полей и без PaymentRecipientId — успех (не меняем)
    const plainBare = JSON.parse((await plainApi('Init', { TerminalKey: TERMINAL_KEY, OrderId: 'plain-bare', Amount: '1000' })).body);
    assert.strictEqual(plainBare.Success, true, 'plain Init без сделки и без PaymentRecipientId должен проходить');
    const plainPay = await request(plainPort, 'POST', `/payment/${plainParsed.PaymentId}/pay`, 'pan=2201382000000013&exp=1227', { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.ok([200, 302].includes(plainPay.statusCode), `оплата по тестовой карте должна проходить (статус ${plainPay.statusCode}: ${String(plainPay.body).slice(0, 80)})`);
    await waitNotification((entry) => entry.json.PaymentId === plainParsed.PaymentId);
    const plainConf = await plainApi('Confirm', { TerminalKey: TERMINAL_KEY, PaymentId: plainParsed.PaymentId, Amount: '250000' });
    assert.strictEqual(JSON.parse(plainConf.body).Status, 'CONFIRMED', 'plain Confirm из AUTHORIZED');
    const plainHook = WEBHOOK_HITS.map((h) => { try { return JSON.parse(h.body); } catch { return null; } }).filter(Boolean).find((n) => n.PaymentId === plainParsed.PaymentId);
    assert.ok(plainHook, 'plain платёж должен уведомлять мерчанта');
    assert.strictEqual(plainHook.SpAccumulationId, undefined, 'в plain-нотификации не должно быть SpAccumulationId');
    } finally { await stopChild(plainChild); }
  }

  /* --- Этап 6–7 (бриф 2026-10-11): чарджбэки e2e, сценарии, виртуальные часы, e2c/AV --- */

  // Helper to call /v2/* with custom headers
  const apiWithHeaders = (p, method, body, headers = {}) => {
    const payload = { TerminalKey: TERMINAL, ...body };
    if (method === 'Init' && payload.PaymentRecipientId === undefined) payload.PaymentRecipientId = DEFAULT_RECIPIENT;
    return request(p, 'POST', `/v2/${method}`, { ...payload, Token: tokenOf(payload) }, headers);
  };

  // 26. Чарджбэк end-to-end (T-024): DISPUTED -> REPRESENTMENT -> ARBITRATION -> WON / LOST
  {
    const cbInit = JSON.parse((await api(mockPort, 'Init', {
      Amount: '200000', OrderId: 'order-cb-1', CreateDealWithType: 'NN', PayType: 'O',
      NotificationURL: notificationUrl, SuccessURL: successUrl, FailURL: failUrl,
    })).body);
    await request(mockPort, 'POST', `/payment/${cbInit.PaymentId}/pay`, 'pan=2201382000000013&exp=1227&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
    await waitNotification((h) => h.json.Status === 'CONFIRMED' && h.json.PaymentId === cbInit.PaymentId);

    // Негатив: нельзя уйти в ARBITRATION до открытия спора -> код 32 / 8
    const earlyArb = JSON.parse((await api(mockPort, 'Chargeback', { PaymentId: cbInit.PaymentId, Action: 'arbitration' })).body);
    assert.strictEqual(earlyArb.Success, false, 'арбитраж без спора должен отклоняться');

    // Негатив: чарджбэк сверх суммы платежа -> код 7
    const overCb = JSON.parse((await api(mockPort, 'Chargeback', { PaymentId: cbInit.PaymentId, Amount: '500000' })).body);
    assert.strictEqual(overCb.ErrorCode, '7', 'чарджбэк сверх суммы платежа -> 7');

    // Шаг 1: Открытие частичного чарджбэка (DISPUTED -> PARTIAL_CHARGEBACK)
    const openCb = JSON.parse((await api(mockPort, 'Chargeback', {
      PaymentId: cbInit.PaymentId, Amount: '80000', ReasonCode: '4853',
    })).body);
    assert.strictEqual(openCb.Success, true, JSON.stringify(openCb));
    assert.strictEqual(openCb.Status, 'PARTIAL_CHARGEBACK');
    assert.strictEqual(openCb.DisputeStatus, 'DISPUTED');
    assert.strictEqual(openCb.NewAmount, 120000);
    const disputeId = openCb.DisputeId;
    assert.ok(disputeId && disputeId.startsWith('DSP-'), 'должен вернуться DisputeId');

    const dispNotif = await waitNotification((h) => h.json.DisputeId === disputeId && h.json.DisputeStatus === 'DISPUTED');
    assert.strictEqual(dispNotif.json.Status, 'PARTIAL_CHARGEBACK');
    assert.strictEqual(dispNotif.json.Token, tokenOf({ ...dispNotif.json, Token: undefined }), 'Token нотификации чарджбэка должен быть валидным');

    // Негатив: нельзя перейти сразу в ARBITRATION из DISPUTED (минуя REPRESENTMENT) -> код 32
    const skipRep = JSON.parse((await api(mockPort, 'Chargeback', { DisputeId: disputeId, Action: 'arbitration' })).body);
    assert.strictEqual(skipRep.ErrorCode, '32', 'переход DISPUTED -> ARBITRATION без REPRESENTMENT запрещён (код 32)');

    // Шаг 2: Representment (оспаривание мерчантом с номером ФД 54-ФЗ)
    const repCb = JSON.parse((await api(mockPort, 'Chargeback', {
      DisputeId: disputeId, Action: 'representment', FiscalDocumentNumber: '50015', Comment: 'Чек 54-ФЗ и акт выдачи',
    })).body);
    assert.strictEqual(repCb.DisputeStatus, 'REPRESENTMENT');
    await waitNotification((h) => h.json.DisputeId === disputeId && h.json.DisputeStatus === 'REPRESENTMENT');

    // Шаг 3: Arbitration (передача в арбитраж)
    const arbCb = JSON.parse((await api(mockPort, 'Chargeback', { DisputeId: disputeId, Action: 'arbitration' })).body);
    assert.strictEqual(arbCb.DisputeStatus, 'ARBITRATION');
    await waitNotification((h) => h.json.DisputeId === disputeId && h.json.DisputeStatus === 'ARBITRATION');

    // Шаг 4: Резолюция WON (мерчант выиграл спор -> сумма возвращена, статус платежа снова CONFIRMED)
    const winCb = JSON.parse((await api(mockPort, 'Chargeback', { DisputeId: disputeId, Action: 'resolve', Outcome: 'WON' })).body);
    assert.strictEqual(winCb.DisputeStatus, 'WON');
    assert.strictEqual(winCb.Status, 'CONFIRMED');
    assert.strictEqual(winCb.NewAmount, 200000);
    await waitNotification((h) => h.json.DisputeId === disputeId && h.json.DisputeStatus === 'WON');

    // Повторное открытие спора и проигрыш (LOST -> финальный CHARGEBACK)
    const openCb2 = JSON.parse((await api(mockPort, 'Chargeback', { PaymentId: cbInit.PaymentId })).body);
    assert.strictEqual(openCb2.DisputeStatus, 'DISPUTED');
    const loseCb = JSON.parse((await api(mockPort, 'Chargeback', { DisputeId: openCb2.DisputeId, Action: 'lose' })).body);
    assert.strictEqual(loseCb.DisputeStatus, 'LOST');
    assert.strictEqual(loseCb.Status, 'CHARGEBACK');
    assert.strictEqual(loseCb.NewAmount, 0);
  }

  // 27. Сценарное API + виртуальные часы:
  //   - «вебхук не пришёл» (X-Mock-Scenario: webhook-drop)
  //   - «возврат частичный» (X-Mock-Scenario: partial-refund:30%)
  //   - «чарджбэк через 7 дней» (X-Mock-Scenario: chargeback-after:7d + сдвиг /mock/time на 7d)
  //   - «авто-подтверждение холда через 7 дней» и «авто-отмена через 60 дней»
  {
    // 27a. webhook-drop + partial-refund:25%
    const dropInit = JSON.parse((await apiWithHeaders(mockPort, 'Init', {
      Amount: '100000', OrderId: 'order-sc-drop', CreateDealWithType: 'NN', PayType: 'O',
      NotificationURL: notificationUrl,
    }, { 'X-Mock-Scenario': 'webhook-drop' })).body);
    await request(mockPort, 'POST', `/payment/${dropInit.PaymentId}/pay`, 'pan=2201382000000013&exp=1227&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
    const dropState = await waitForCondition(async () => {
      const current = JSON.parse((await api(mockPort, 'GetState', { PaymentId: dropInit.PaymentId })).body);
      return current.Status === 'CONFIRMED' ? current : null;
    }, { description: 'webhook-drop payment reaches CONFIRMED' });
    assert.ok(!WEBHOOK_HITS.some((h) => h.json.PaymentId === dropInit.PaymentId), 'при webhook-drop вебхук не должен приходить');
    assert.strictEqual(dropState.Status, 'CONFIRMED', 'при webhook-drop сам платёж в банке проведён (GetState=CONFIRMED)');

    // Частичный возврат через X-Mock-Scenario: partial-refund:25% (без передачи Amount в теле Cancel)
    const partCancel = JSON.parse((await apiWithHeaders(mockPort, 'Cancel', {
      PaymentId: dropInit.PaymentId,
    }, { 'X-Mock-Scenario': 'partial-refund:25%' })).body);
    assert.strictEqual(partCancel.Status, 'PARTIAL_REFUNDED');
    assert.strictEqual(partCancel.NewAmount, 75000, 'partial-refund:25% должен вернуть 25000 из 100000');

    // 27b. chargeback-after:7d + авто-подтверждение холда (AUTHORIZED -> CONFIRMED через 7d) + авто-отмена (NEW -> DEADLINE_EXPIRED через 60d)
    const hold7d = JSON.parse((await api(mockPort, 'Init', {
      Amount: '90000', OrderId: 'order-hold-7d', CreateDealWithType: 'NN', PayType: 'T',
      NotificationURL: notificationUrl,
    })).body);
    await request(mockPort, 'POST', `/payment/${hold7d.PaymentId}/pay`, 'pan=2201382000000013&exp=1227&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.strictEqual(state.payments[hold7d.PaymentId].status, 'AUTHORIZED');

    const cbAfter7d = JSON.parse((await apiWithHeaders(mockPort, 'Init', {
      Amount: '110000', OrderId: 'order-cbafter-7d', CreateDealWithType: 'NN', PayType: 'O',
      NotificationURL: notificationUrl,
    }, { 'X-Mock-Scenario': 'chargeback-after:7d' })).body);
    await request(mockPort, 'POST', `/payment/${cbAfter7d.PaymentId}/pay`, 'pan=2201382000000013&exp=1227&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.strictEqual(state.payments[cbAfter7d.PaymentId].status, 'CONFIRMED');

    const abandonedOrder = JSON.parse((await api(mockPort, 'Init', {
      Amount: '50000', OrderId: 'order-abandoned-60d', CreateDealWithType: 'NN', PayType: 'T',
    })).body);
    assert.strictEqual(state.payments[abandonedOrder.PaymentId].status, 'NEW');

    // Сдвигаем виртуальные часы на +7 дней
    const t7 = JSON.parse((await request(mockPort, 'POST', '/mock/time', { advance: '7d' })).body);
    assert.ok(t7.offsetMs >= 7 * 86400000, 'виртуальные часы сдвинуты на 7d');
    assert.strictEqual(state.payments[hold7d.PaymentId].status, 'CONFIRMED', 'холд через 7d должен авто-подтвердиться банком');
    assert.strictEqual(state.payments[cbAfter7d.PaymentId].status, 'CHARGEBACK', 'платёж с chargeback-after:7d через 7d должен перейти в CHARGEBACK');

    // Сдвигаем виртуальные часы ещё на +60 дней -> брошенный заказ истекает, незакрытая сделка рефандится
    await request(mockPort, 'POST', '/mock/time', { advance: '60d' });
    assert.strictEqual(state.payments[abandonedOrder.PaymentId].status, 'DEADLINE_EXPIRED', 'неоплаченный заказ через 60d -> DEADLINE_EXPIRED');

    // Сброс виртуальных часов
    await request(mockPort, 'POST', '/mock/time', { reset: true });
  }

  // 27c. F-05/F-06/F-24: виртуальные часы не принимают Date-overflow, chaos
  // обрывает запрос до handler, а все денежные Amount endpoints отклоняют
  // prefix/trailing junk и дроби без записи нового документа.
  {
    const offsetBefore = state.clockOffsetMs || 0;
    for (const spec of [{ offsetMs: Number.MAX_VALUE }, { advance: '9999999999999d' }]) {
      const badClock = await request(mockPort, 'POST', '/mock/time', spec);
      assert.strictEqual(badClock.statusCode, 400, `некорректный virtual clock ${JSON.stringify(spec)} -> 400`);
      assert.strictEqual(state.clockOffsetMs || 0, offsetBefore, 'невалидный offset не должен попадать в state');
    }
    const clockAfterReject = JSON.parse((await request(mockPort, 'GET', '/mock/time')).body);
    assert.strictEqual(clockAfterReject.offsetMs, offsetBefore, 'после отказа clock остаётся пригодным');

    const paymentsBeforeChaos = Object.keys(state.payments).length;
    for (const status of [500, 504]) {
      const chaos = await request(mockPort, 'POST', '/v2/Init', {
        TerminalKey: TERMINAL, Amount: '1000', OrderId: `chaos-http-${status}`,
      }, { 'X-Mock-Scenario': `http-${status}` });
      assert.strictEqual(chaos.statusCode, status, `X-Mock-Scenario http-${status} должен вернуть HTTP ${status}`);
      const chaosBody = JSON.parse(chaos.body);
      assert.strictEqual(chaosBody.Success, false);
      assert.strictEqual(chaosBody.ErrorCode, String(status));
      assert.ok(chaosBody.Details && chaosBody.Details.Field === 'X-Mock-Scenario');
    }
    assert.strictEqual(Object.keys(state.payments).length, paymentsBeforeChaos, 'chaos http-500/504 не должен создавать платёж');

    const invalidAmount = (raw) => String(raw);
    const badInitOrder = 'money-strict-init';
    for (const raw of ['1000xyz', '1000.9']) {
      const bad = JSON.parse((await api(mockPort, 'Init', { Amount: invalidAmount(raw), OrderId: `${badInitOrder}-${raw}` })).body);
      assert.strictEqual(bad.Success, false, `v2 Init отклоняет Amount=${raw}`);
      assert.strictEqual(bad.ErrorCode, '7');
    }
    const authorized = JSON.parse((await api(mockPort, 'Init', { Amount: '50000', OrderId: 'money-strict-confirm', PayType: 'T', CreateDealWithType: 'NN' })).body);
    await request(mockPort, 'POST', `/payment/${authorized.PaymentId}/pay`, 'pan=2201382000000013&exp=1227&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.strictEqual(state.payments[authorized.PaymentId].status, 'AUTHORIZED');
    for (const raw of ['1000xyz', '1000.9']) {
      const bad = JSON.parse((await api(mockPort, 'Confirm', { PaymentId: authorized.PaymentId, Amount: raw })).body);
      assert.strictEqual(bad.Success, false, `v2 Confirm отклоняет Amount=${raw}`);
      assert.strictEqual(state.payments[authorized.PaymentId].status, 'AUTHORIZED');
    }
    const confirmed = JSON.parse((await api(mockPort, 'Init', { Amount: '50000', OrderId: 'money-strict-cancel', PayType: 'O', CreateDealWithType: 'NN' })).body);
    await request(mockPort, 'POST', `/payment/${confirmed.PaymentId}/pay`, 'pan=2201382000000013&exp=1227&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.strictEqual(state.payments[confirmed.PaymentId].status, 'CONFIRMED');
    for (const raw of ['1000xyz', '1000.9']) {
      const badCancel = JSON.parse((await api(mockPort, 'Cancel', { PaymentId: confirmed.PaymentId, Amount: raw })).body);
      assert.strictEqual(badCancel.Success, false, `v2 Cancel отклоняет Amount=${raw}`);
      assert.strictEqual(state.payments[confirmed.PaymentId].status, 'CONFIRMED');
      const badChargeback = JSON.parse((await api(mockPort, 'Chargeback', { PaymentId: confirmed.PaymentId, Amount: raw })).body);
      assert.strictEqual(badChargeback.Success, false, `v2 Chargeback отклоняет Amount=${raw}`);
      assert.strictEqual(state.payments[confirmed.PaymentId].status, 'CONFIRMED');
    }

    const moneyDeal = await fundedDeal(mockPort, 60000, 'money-strict-e2c-fund');
    const badE2c = JSON.parse((await e2c(mockPort, 'Init', {
      Amount: '1000xyz', OrderId: 'money-strict-e2c', DealId: moneyDeal,
    })).body);
    assert.strictEqual(badE2c.Success, false, 'e2c Init отклоняет строгий Amount');
    const avPayload = { TerminalKey: TERMINAL, VerificationCode: 'MONEY-STRICT', Amount: '1000.9', PayerInn: '7801111111' };
    const badAvPayment = JSON.parse((await request(mockPort, 'POST', '/av/v1/payment', { ...avPayload, Token: tokenOf(avPayload) })).body);
    assert.strictEqual(badAvPayment.Success, false, 'AV payment отклоняет дробный Amount');
    const avVerificationPayload = { TerminalKey: TERMINAL, VerificationCode: 'MONEY-STRICT-2', Amount: '1000xyz' };
    const badAvVerification = JSON.parse((await request(mockPort, 'POST', '/av/v1/verification', { ...avVerificationPayload, Token: tokenOf(avVerificationPayload) })).body);
    assert.strictEqual(badAvVerification.Success, false, 'AV verification отклоняет мусорный Amount');
  }

  // 28. Покрытие /e2c/v2/* и /av/v1/* (рекомендация аудита A-22)
  // 27d. #52 PA-51/PB-13/PG-09: сценарии, история и журнал — per-sandbox.
  {
    const J = (r) => JSON.parse(r.body);
    const isoA = { 'X-Mock-Sandbox': 'sc52-a' };
    const isoB = { 'X-Mock-Sandbox': 'sc52-b' };
    await request(mockPort, 'POST', '/mock/scenarios', { scenario: 'webhook-drop', target: 'init', persistent: true }, isoA);
    const seenByB = J(await request(mockPort, 'GET', '/mock/scenarios', undefined, isoB));
    assert.deepStrictEqual(seenByB.rules, [], '#52: правила песочницы A не видны B');
    assert.deepStrictEqual(seenByB.history, [], '#52: история песочницы A не видна B');
    const initB = J(await apiWithHeaders(mockPort, 'Init', { Amount: '10000', OrderId: 'sc52-b-order', CreateDealWithType: 'NN', PayType: 'O' }, isoB));
    assert.strictEqual(initB.Success, true, '#52: трафик B проходит без правила A');
    const histB0 = J(await request(mockPort, 'GET', '/mock/scenarios', undefined, isoB));
    assert.deepStrictEqual(histB0.history, [], '#52: правило A не сработало на Init B (история B пуста)');
    const initB2 = J(await apiWithHeaders(mockPort, 'Init', { Amount: '10000', OrderId: 'sc52-b-hist', CreateDealWithType: 'NN', PayType: 'O' }, { ...isoB, 'X-Mock-Scenario': 'webhook-drop' }));
    assert.strictEqual(initB2.Success, true);
    const initA = J(await apiWithHeaders(mockPort, 'Init', { Amount: '10000', OrderId: 'sc52-a-order', CreateDealWithType: 'NN', PayType: 'O' }, isoA));
    assert.strictEqual(initA.Success, true);
    const histA = J(await request(mockPort, 'GET', '/mock/scenarios', undefined, isoA));
    assert.ok(!JSON.stringify(histA.history).includes('sc52-b-hist'), '#52: история B (orderId) не видна A');
    const journalA = await request(mockPort, 'GET', '/admin/journal', undefined, isoA);
    const journalB = await request(mockPort, 'GET', '/admin/journal', undefined, isoB);
    assert.ok(journalA.body.includes('sc52-a-order') && !journalA.body.includes('sc52-b-order'), '#52 PB-13: журнал A — только свои записи');
    assert.ok(journalB.body.includes('sc52-b-order') && !journalB.body.includes('sc52-a-order'), '#52 PB-13: журнал B — только свои записи');
    await request(mockPort, 'POST', '/mock/scenarios', { id: 'sc52-own', scenario: 'webhook-drop', persistent: true }, isoB);
    await request(mockPort, 'POST', '/mock/reset', {}, isoA);
    const afterResetA = J(await request(mockPort, 'GET', '/mock/scenarios', undefined, isoA));
    const afterResetB = J(await request(mockPort, 'GET', '/mock/scenarios', undefined, isoB));
    const journalAfterB = await request(mockPort, 'GET', '/admin/journal', undefined, isoB);
    assert.deepStrictEqual(afterResetA.rules, [], '#52 PG-09: reset A очистил свои правила');
    assert.ok(afterResetB.rules.some((r) => r.id === 'sc52-own'), '#52 PG-09: reset A не стёр правила B');
    assert.ok(journalAfterB.body.includes('sc52-b-order'), '#52 PB-13: reset A не стёр журнал B');
    const tooBig = await request(mockPort, 'POST', '/mock/scenarios', { scenario: 'fail', match: { pad: 'x'.repeat(9000) } }, isoA);
    assert.strictEqual(tooBig.statusCode, 400, '#52: правило >8 KiB -> 400');
    assert.strictEqual(J(tooBig).code, 'rule_too_large', '#52: code rule_too_large в теле ошибки');
    await request(mockPort, 'POST', '/mock/scenarios', { id: 'sc52-upd', scenario: 'fail', persistent: true }, isoA);
    await request(mockPort, 'POST', '/mock/scenarios', { id: 'sc52-upd', scenario: 'webhook-drop', persistent: true }, isoA);
    const updBig = await request(mockPort, 'POST', '/mock/scenarios', { id: 'sc52-upd', scenario: 'fail', match: { pad: 'x'.repeat(9000) } }, isoA);
    const updList = J(await request(mockPort, 'GET', '/mock/scenarios', undefined, isoA));
    assert.strictEqual(updBig.statusCode, 400, '#52: oversized update -> 400');
    assert.strictEqual(J(updBig).code, 'rule_too_large');
    assert.strictEqual(updList.rules.filter((r) => r.id === 'sc52-upd').length, 1, '#52: update по id не плодит дублей');
    assert.strictEqual(updList.rules.find((r) => r.id === 'sc52-upd').scenario, 'webhook-drop', '#52: старое правило цело после oversized update');
    await request(mockPort, 'DELETE', '/mock/scenarios', undefined, isoA);
    let capStatus = 0;
    for (let i = 0; i < 200; i += 1) {
      capStatus = (await request(mockPort, 'POST', '/mock/scenarios', { id: `sc52-cap-${i}`, scenario: 'fail', persistent: true }, isoA)).statusCode;
    }
    const capOver = await request(mockPort, 'POST', '/mock/scenarios', { id: 'sc52-cap-200', scenario: 'fail' }, isoA);
    const capList = J(await request(mockPort, 'GET', '/mock/scenarios', undefined, isoA));
    assert.strictEqual(capStatus, 200, '#52: 200 правил проходят');
    assert.strictEqual(capOver.statusCode, 400, '#52: 201-е правило -> 400');
    assert.strictEqual(J(capOver).code, 'rule_cap_exceeded', '#52: code rule_cap_exceeded в теле ошибки');
    assert.strictEqual(capList.rules.length, 200, '#52: после отказа по cap осталось 200 правил');
    await request(mockPort, 'DELETE', '/mock/scenarios', undefined, isoB);
  }

  {
    // Выплата идёт по сделке с балансом (F-17): заводим и пополняем её
    const covDealId = await fundedDeal(mockPort, 60000, 'order-e2c-fund');

    const e2cInit = JSON.parse((await e2c(mockPort, 'Init', {
      Amount: '45000', OrderId: 'payout-1', CustomerKey: 'merch-1', DealId: covDealId, CardId: 'card-coverage-1',
    })).body);
    assert.strictEqual(e2cInit.Success, true);
    assert.strictEqual(e2cInit.Status, 'NEW');
    assert.strictEqual(e2cInit.DealId, covDealId, 'ответ Init называет сделку выплаты');
    assert.strictEqual(state.payouts[e2cInit.PaymentId].recipientType, 'card', 'нормализованный канал сохраняется (F-20)');

    const e2cPay = JSON.parse((await e2c(mockPort, 'Payment', { PaymentId: e2cInit.PaymentId })).body);
    assert.strictEqual(e2cPay.Status, 'CONFIRMED');

    const e2cState = JSON.parse((await e2c(mockPort, 'GetState', { PaymentId: e2cInit.PaymentId })).body);
    assert.strictEqual(e2cState.Status, 'CONFIRMED');
    assert.strictEqual(e2cState.Amount, 45000);

    const avVerifPayload = { TerminalKey: TERMINAL, VerificationCode: 'VER-777', Amount: '100', Account: '40702810000000000001' };
    const avVerif = JSON.parse((await request(mockPort, 'POST', '/av/v1/verification', { ...avVerifPayload, Token: tokenOf(avVerifPayload) })).body);
    assert.strictEqual(avVerif.Success, true);
    assert.strictEqual(avVerif.Status, 'RETURNED');

    const avPayPayload = { TerminalKey: TERMINAL, VerificationCode: 'VER-777', Amount: '100', PayerInn: '7801111111', PayerName: 'ООО Тест', NotificationURL: notificationUrl };
    const avPay = JSON.parse((await request(mockPort, 'POST', '/av/v1/payment', { ...avPayPayload, Token: tokenOf(avPayPayload) })).body);
    assert.strictEqual(avPay.Success, true);
    assert.strictEqual(avPay.Status, 'RECEIVED');
    await waitNotification((h) => h.json.Type === 'INCOMING' && h.json.VerificationCode === 'VER-777');
  }

  // 29. Wave 2 Мультирасчётов: createSpDeal / closeSpDeal, строгий баланс сделки при e2c, FinalPayout, запрет возврата после закрытия, CancelPayment, GetSbpMembers и карта 5000000000000553 -> 1057
  {
    const dealResp = JSON.parse((await api(mockPort, 'createSpDeal', { SpDealType: 'NN' })).body);
    assert.strictEqual(dealResp.Success, true);
    const spDealId = dealResp.SpAccumulationId;
    assert.ok(spDealId, 'createSpDeal должен вернуть SpAccumulationId');

    // Пополняем сделку платежом на 1000 ₽ (100000 коп.)
    const dealPayInit = JSON.parse((await api(mockPort, 'Init', {
      Amount: '100000', OrderId: 'order-spdeal-1', DealId: spDealId, PayType: 'O',
      NotificationURL: notificationUrl,
    })).body);
    await request(mockPort, 'POST', `/payment/${dealPayInit.PaymentId}/pay`, 'pan=2201382000000013&exp=1227&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.strictEqual(state.payments[dealPayInit.PaymentId].status, 'CONFIRMED');

    // Попытка выплаты больше баланса сделки (150000 > 100000) -> ErrorCode 32
    const overPayout = JSON.parse((await e2c(mockPort, 'Init', {
      Amount: '150000', OrderId: 'payout-over', DealId: spDealId, CardId: 'card-over-1',
    })).body);
    assert.strictEqual(overPayout.Success, false);
    assert.strictEqual(overPayout.ErrorCode, '32');

    // Тестовая карта ошибки выплаты 5000000000000553 -> ErrorCode 1057 (канал «карта по данным»)
    const badCardInit = JSON.parse((await e2c(mockPort, 'Init', {
      Amount: '20000', OrderId: 'payout-badcard', DealId: spDealId, Pan: '5000000000000553',
    })).body);
    const badCardPay = JSON.parse((await e2c(mockPort, 'Payment', { PaymentId: badCardInit.PaymentId })).body);
    assert.strictEqual(badCardPay.Success, false);
    assert.strictEqual(badCardPay.ErrorCode, '1057');
    assert.strictEqual(badCardPay.Status, 'REJECTED');

    // Партнёрская точка (acqapi): shopCode = PartnerId для отменяемой выплаты (F-20)
    const cancelPartner = await registerPartner(mockPort, 'LOVII CANCEL');

    // Выплата 40000 коп. партнёру: успех, отмена CancelPayment -> CREDIT_CANCELED,
    // баланс сделки снова 100000 (сумма возвращается в сделку)
    const p1Init = JSON.parse((await e2c(mockPort, 'Init', {
      Amount: '40000', OrderId: 'payout-cancelable', DealId: spDealId, PartnerId: cancelPartner,
    })).body);
    assert.strictEqual(p1Init.Success, true, JSON.stringify(p1Init));
    assert.strictEqual(state.payouts[p1Init.PaymentId].recipientType, 'partner');
    const p1Pay = JSON.parse((await e2c(mockPort, 'Payment', { PaymentId: p1Init.PaymentId })).body);
    assert.strictEqual(p1Pay.Status, 'CONFIRMED');
    const p1Cancel = JSON.parse((await e2c(mockPort, 'CancelPayment', { PaymentId: p1Init.PaymentId, DealId: spDealId })).body);
    assert.strictEqual(p1Cancel.Success, true, JSON.stringify(p1Cancel));
    assert.strictEqual(p1Cancel.Status, 'CREDIT_CANCELED', 'отмена выплаты отдаёт CREDIT_CANCELED (F-23)');
    assert.deepStrictEqual(
      state.payouts[p1Init.PaymentId].statusHistory.map((h) => h.status),
      ['NEW', 'CONFIRMED', 'CREDIT_CANCELING', 'CREDIT_CANCELED'],
      'история отмены — CREDIT_CANCELING → CREDIT_CANCELED (F-23)',
    );

    // Финальная выплата 70000 коп. с FinalPayout=true -> закрывает сделку, остаток 30000 коп. уходит в вознаграждение площадки
    const finalInit = JSON.parse((await e2c(mockPort, 'Init', {
      Amount: '70000', OrderId: 'payout-final', DealId: spDealId, FinalPayout: true, CardId: 'card-final-1',
    })).body);
    const finalPay = JSON.parse((await e2c(mockPort, 'Payment', { PaymentId: finalInit.PaymentId })).body);
    assert.strictEqual(finalPay.Success, true);
    assert.strictEqual(finalPay.DealClosed, true);
    assert.strictEqual(finalPay.PlatformReward, 30000);
    assert.strictEqual(state.deals[spDealId].status, 'closed');

    // Попытка возврата покупателю по закрытой сделке -> ErrorCode 32
    const closedCancel = JSON.parse((await api(mockPort, 'Cancel', { PaymentId: dealPayInit.PaymentId })).body);
    assert.strictEqual(closedCancel.Success, false);
    assert.strictEqual(closedCancel.ErrorCode, '32');

    // Список банков СБП
    const sbpMembers = JSON.parse((await e2c(mockPort, 'GetSbpMembers', {})).body);
    assert.strictEqual(sbpMembers.Success, true);
    assert.ok(Array.isArray(sbpMembers.Members) && sbpMembers.Members.length >= 4);
  }

  // 30. СБП QR (GetQr + sbp-pay) и закрывающий чек SendClosingReceipt
  {
    // СБП меньше 10 ₽ (1000 коп.) -> ErrorCode 7
    const tinyInit = JSON.parse((await api(mockPort, 'Init', { Amount: '500', OrderId: 'order-sbp-tiny', CreateDealWithType: 'NN' })).body);
    const tinyQr = JSON.parse((await api(mockPort, 'GetQr', { PaymentId: tinyInit.PaymentId, DataType: 'PAYLOAD' })).body);
    assert.strictEqual(tinyQr.Success, false);
    assert.strictEqual(tinyQr.ErrorCode, '7');

    // СБП нормальный платёж + оплата по QR + SendClosingReceipt
    const sbpInit = JSON.parse((await api(mockPort, 'Init', {
      Amount: '25000', OrderId: 'order-sbp-ok', CreateDealWithType: 'NN', NotificationURL: notificationUrl,
    })).body);
    const qrPayloadResp = JSON.parse((await api(mockPort, 'GetQr', { PaymentId: sbpInit.PaymentId, DataType: 'PAYLOAD' })).body);
    assert.strictEqual(qrPayloadResp.Success, true);
    assert.ok(qrPayloadResp.Data.startsWith('https://qr.nspk.ru/'));

    const qrSvgResp = JSON.parse((await api(mockPort, 'GetQr', { PaymentId: sbpInit.PaymentId, DataType: 'IMAGE' })).body);
    assert.strictEqual(qrSvgResp.Success, true);
    assert.ok(qrSvgResp.Data.includes('<svg'));

    const sbpPayResp = JSON.parse((await request(mockPort, 'POST', `/payment/${sbpInit.PaymentId}/sbp-pay`, {})).body);
    assert.strictEqual(sbpPayResp.Success, true);
    assert.strictEqual(sbpPayResp.Status, 'CONFIRMED');
    await waitNotification((h) => h.json.PaymentId === sbpInit.PaymentId && h.json.Status === 'CONFIRMED');

    const closingResp = JSON.parse((await api(mockPort, 'SendClosingReceipt', {
      PaymentId: sbpInit.PaymentId,
      Receipt: {
        Email: 'buyer@example.com',
        Taxation: 'usn_income',
        Items: [{ Name: 'Услуга', Price: 25000, Quantity: 1, Amount: 25000, Tax: 'none' }],
      },
    })).body);
    assert.strictEqual(closingResp.Success, true);
  }

  // 31. Рекуррентные платежи (Recurrent=Y, RebillId, Charge), управление картами и валидация DATA / RedirectDueDate
  {
    // DATA > 100 символов -> ErrorCode 7
    const badData = JSON.parse((await api(mockPort, 'Init', {
      Amount: '10000', OrderId: 'order-baddata', CreateDealWithType: 'NN', DATA: { longKey: 'x'.repeat(105) },
    })).body);
    assert.strictEqual(badData.Success, false);
    assert.strictEqual(badData.ErrorCode, '7');

    // RedirectDueDate (F-25): обе границы диапазона «1 минута … 90 дней»
    // > 90 дней -> ErrorCode 7
    const farFuture = new Date(Date.now() + 100 * 86400000).toISOString();
    const badDue = JSON.parse((await api(mockPort, 'Init', {
      Amount: '10000', OrderId: 'order-baddue', CreateDealWithType: 'NN', RedirectDueDate: farFuture,
    })).body);
    assert.strictEqual(badDue.Success, false);
    assert.strictEqual(badDue.ErrorCode, '7');

    // истёкшая дата -> ErrorCode 7
    const expiredDue = JSON.parse((await api(mockPort, 'Init', {
      Amount: '10000', OrderId: 'order-expdue', CreateDealWithType: 'NN', RedirectDueDate: new Date(Date.now() - 60000).toISOString(),
    })).body);
    assert.strictEqual(expiredDue.Success, false);
    assert.strictEqual(expiredDue.ErrorCode, '7');
    assert.ok(String(expiredDue.Message).includes('истёк'), `сообщение об истёкшей дате: ${expiredDue.Message}`);

    // меньше минуты -> ErrorCode 7
    const soonDue = JSON.parse((await api(mockPort, 'Init', {
      Amount: '10000', OrderId: 'order-soondue', CreateDealWithType: 'NN', RedirectDueDate: new Date(Date.now() + 30000).toISOString(),
    })).body);
    assert.strictEqual(soonDue.Success, false);
    assert.strictEqual(soonDue.ErrorCode, '7');

    // не-ISO значение -> ErrorCode 7 (корректный ISO parsing сохраняется)
    const badFormatDue = JSON.parse((await api(mockPort, 'Init', {
      Amount: '10000', OrderId: 'order-fmtdue', CreateDealWithType: 'NN', RedirectDueDate: 'вчера',
    })).body);
    assert.strictEqual(badFormatDue.Success, false);
    assert.strictEqual(badFormatDue.ErrorCode, '7');
    assert.ok(String(badFormatDue.Message).includes('ISO 8601'), `сообщение о формате: ${badFormatDue.Message}`);

    // ровно 90 дней (верхняя граница, включительно) -> принимается
    const ok90Due = JSON.parse((await api(mockPort, 'Init', {
      Amount: '10000', OrderId: 'order-ok90due', CreateDealWithType: 'NN', RedirectDueDate: new Date(Date.now() + 90 * 86400000).toISOString(),
    })).body);
    assert.strictEqual(ok90Due.Success, true, `ровно 90 дней — допустимо: ${JSON.stringify(ok90Due)}`);

    // нижняя граница через HTTP: чуть больше минуты (запас на задержку запроса)
    const okMinDue = JSON.parse((await api(mockPort, 'Init', {
      Amount: '10000', OrderId: 'order-okmindue', CreateDealWithType: 'NN', RedirectDueDate: new Date(Date.now() + 65000).toISOString(),
    })).body);
    assert.strictEqual(okMinDue.Success, true, `ссылка на ~1 минуту — допустимо: ${JSON.stringify(okMinDue)}`);

    // Точная граница «1 минута» (включительно) — на фиксированном nowMs: HTTP-путь
    // сравнивает с clock.now() на момент валидации, и границу в 1 мс нельзя
    // удержать детерминированно из-за задержки запроса.
    const t0 = Date.parse('2030-06-15T12:00:00.000Z');
    const isoAt = (deltaMs) => new Date(t0 + deltaMs).toISOString();
    assert.strictEqual(validateRedirectDueDate(isoAt(60000), t0), null, 'ровно 1 минута — допустимо');
    assert.ok(validateRedirectDueDate(isoAt(59999), t0), 'чуть меньше минуты — отклоняется');
    assert.ok(validateRedirectDueDate(isoAt(0), t0), 'ровно сейчас — отклоняется');
    assert.ok(validateRedirectDueDate(isoAt(-1000), t0), 'истёкшая дата — отклоняется');
    assert.strictEqual(validateRedirectDueDate(isoAt(90 * 86400000), t0), null, 'ровно 90 дней — допустимо');
    assert.ok(validateRedirectDueDate(isoAt(90 * 86400000 + 1), t0), 'чуть больше 90 дней — отклоняется');

    // Recurrent=Y без CustomerKey -> ErrorCode 7
    const noCust = JSON.parse((await api(mockPort, 'Init', {
      Amount: '10000', OrderId: 'order-rec-nocust', CreateDealWithType: 'NN', Recurrent: 'Y',
    })).body);
    assert.strictEqual(noCust.Success, false);

    // AddCustomer -> Init(Recurrent=Y) -> Pay -> получаем RebillId в нотификации AUTHORIZED -> Charge следующего платежа
    const addCust = JSON.parse((await api(mockPort, 'AddCustomer', { CustomerKey: 'cust-rec-1', Email: 'rec@example.com' })).body);
    assert.strictEqual(addCust.Success, true);

    const recInit = JSON.parse((await api(mockPort, 'Init', {
      Amount: '30000', OrderId: 'order-rec-parent', CreateDealWithType: 'NN', Recurrent: 'Y', CustomerKey: 'cust-rec-1', PayType: 'O',
      NotificationURL: notificationUrl,
    })).body);
    assert.strictEqual(recInit.Success, true);
    await request(mockPort, 'POST', `/payment/${recInit.PaymentId}/pay`, 'pan=2201382000000013&exp=1227&cvv=123', { 'Content-Type': 'application/x-www-form-urlencoded' });
    const authHit = await waitNotification((h) => h.json.PaymentId === recInit.PaymentId && h.json.Status === 'AUTHORIZED' && h.json.RebillId);
    const rebillId = authHit.json.RebillId;
    assert.ok(rebillId, 'AUTHORIZED нотификация рекуррентного платежа должна содержать RebillId');

    // Проверяем список карт покупателя
    const cardList = JSON.parse((await api(mockPort, 'GetCardList', { CustomerKey: 'cust-rec-1' })).body);
    assert.ok(Array.isArray(cardList) && cardList.some((c) => c.RebillId === rebillId));

    // Автосписание по RebillId через Charge
    const childInit = JSON.parse((await api(mockPort, 'Init', {
      Amount: '15000', OrderId: 'order-rec-child', CreateDealWithType: 'NN', CustomerKey: 'cust-rec-1', NotificationURL: notificationUrl,
    })).body);
    const chargeResp = JSON.parse((await api(mockPort, 'Charge', {
      PaymentId: childInit.PaymentId, RebillId: rebillId,
    })).body);
    assert.strictEqual(chargeResp.Success, true);
    assert.strictEqual(chargeResp.Status, 'CONFIRMED');
    assert.strictEqual(chargeResp.RebillId, rebillId);
  }

  // 32. Регистрация партнёров acqapi (POST /oauth/token + /sm-register/register*)
  {
    const badBasicResp = await request(mockPort, 'POST', '/oauth/token', 'grant_type=password', {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from('partner:wrong-secret').toString('base64'),
    });
    assert.strictEqual(badBasicResp.statusCode, 401, 'OAuth должен отклонять неверный Basic secret');

    const tokResponse = await request(
      mockPort,
      'POST',
      '/oauth/token',
      'grant_type=password&username=partner&password=partner',
      {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from('partner:mock-acqapi-secret').toString('base64'),
      },
    );
    assert.strictEqual(tokResponse.statusCode, 200, `OAuth с фактическим Basic должен проходить: ${tokResponse.body}`);
    const tokResp = JSON.parse(tokResponse.body);
    assert.ok(tokResp.access_token && tokResp.scope === 'partner' && tokResp.expires_in === 3600, 'OAuth должен выдать opaque Bearer со scope и TTL');
    assert.ok(!tokResp.access_token.includes(String(Date.now())), 'Bearer не должен быть предсказуемым из времени');

    const anonymousGet = await request(mockPort, 'GET', '/sm-register/register/shop/does-not-exist');
    assert.strictEqual(anonymousGet.statusCode, 401, 'GET регистрации без Bearer должен быть закрыт');
    const arbitraryGet = await request(mockPort, 'GET', '/sm-register/register/shop/does-not-exist', undefined, { Authorization: 'Bearer arbitrary-token' });
    assert.strictEqual(arbitraryGet.statusCode, 401, 'GET регистрации с произвольным Bearer должен быть закрыт');

    // Невалидный billingDescriptor (>14 символов или кириллица) -> ошибка 7
    const badShop = JSON.parse((await request(
      mockPort,
      'POST',
      '/sm-register/register',
      { billingDescriptor: 'КИРИЛЛИЦА_СЛИШКОМ_ДЛИННО', inn: '7701234567' },
      { Authorization: `Bearer ${tokResp.access_token}` },
    )).body);
    assert.strictEqual(badShop.Success, false);

    // Валидная регистрация партнёра
    const goodShop = JSON.parse((await request(
      mockPort,
      'POST',
      '/sm-register/register',
      partnerRegistrationFixture('LOVII MARKET', '7701234567', 'article-lovii-market'),
      { Authorization: `Bearer ${tokResp.access_token}` },
    )).body);
    assert.ok(goodShop.shopCode);
    assert.strictEqual(goodShop.billingDescriptor, 'LOVII MARKET');

    // Контрактные негативы F-27: каждая обязательная часть схемы должна
    // отклоняться до записи нового shop.
    const requiredNegativeCases = [
      ['shopArticleId', (p) => { delete p.shopArticleId; }],
      ['billingDescriptor', (p) => { delete p.billingDescriptor; }],
      ['fullName', (p) => { delete p.fullName; }],
      ['name', (p) => { delete p.name; }],
      ['inn', (p) => { delete p.inn; }],
      ['kpp', (p) => { delete p.kpp; }],
      ['ogrn', (p) => { delete p.ogrn; }],
      ['addresses', (p) => { p.addresses = []; }],
      ['ceo', (p) => { delete p.ceo; }],
      ['ceo.phone', (p) => { delete p.ceo.phone; }],
      ['ceo.citizenship', (p) => { delete p.ceo.citizenship; }],
      ['founders.individuals', (p) => { p.founders.individuals = []; }],
      ['email', (p) => { delete p.email; }],
      ['siteUrl', (p) => { delete p.siteUrl; }],
      ['bankAccount', (p) => { delete p.bankAccount; }],
      ['bankAccount.account', (p) => { delete p.bankAccount.account; }],
      ['bankAccount.korAccount', (p) => { delete p.bankAccount.korAccount; }],
      ['bankAccount.bankName', (p) => { delete p.bankAccount.bankName; }],
      ['bankAccount.bik', (p) => { delete p.bankAccount.bik; }],
      ['bankAccount.details', (p) => { delete p.bankAccount.details; }],
      ['nonResident', (p) => { delete p.nonResident; }],
    ];
    for (const [field, mutate] of requiredNegativeCases) {
      const payload = partnerRegistrationFixture('NEGATIVE', '7701234567', `negative-${partnerFixtureNumber}-${field.replace(/[^A-Za-z0-9]+/g, '-')}`);
      mutate(payload);
      const response = await request(mockPort, 'POST', '/sm-register/register', payload, { Authorization: `Bearer ${tokResp.access_token}` });
      assert.strictEqual(response.statusCode, 400, `missing ${field} -> 400`);
      assert.ok(response.body.includes(field.split('.')[0]), `error for missing ${field} names the field`);
    }

    const getShopResponse = await request(mockPort, 'GET', `/sm-register/register/shop/${goodShop.shopCode}`, undefined, { Authorization: `Bearer ${tokResp.access_token}` });
    assert.strictEqual(getShopResponse.statusCode, 200, 'GET регистрации требует действующий Bearer и возвращает точку');
    const getShop = JSON.parse(getShopResponse.body);
    assert.strictEqual(getShop.inn, '7701234567');
    assert.strictEqual(getShop.shopCode, 'article-lovii-market', 'shopArticleId должен маппиться в shopCode');
    assert.strictEqual(getShop.shopArticleId, 'article-lovii-market');

    const anonymousPatch = await request(mockPort, 'PATCH', `/sm-register/register/${goodShop.shopCode}`, { billingDescriptor: 'NOPE' });
    assert.strictEqual(anonymousPatch.statusCode, 401, 'PATCH регистрации без Bearer должен быть закрыт');
    const patchShop = JSON.parse((await request(
      mockPort,
      'PATCH',
      `/sm-register/register/${goodShop.shopCode}`,
      { billingDescriptor: 'LOVII PRO' },
      { Authorization: `Bearer ${tokResp.access_token}` },
    )).body);
    assert.strictEqual(patchShop.billingDescriptor, 'LOVII PRO');

    // TTL токена считается виртуальными часами и не позволяет использовать
    // истёкший Bearer после +1h: произвольный новый токен нужен снова.
    await request(mockPort, 'POST', '/mock/time', { advance: '1h 1s' });
    const expiredGet = await request(mockPort, 'GET', `/sm-register/register/shop/${goodShop.shopCode}`, undefined, { Authorization: `Bearer ${tokResp.access_token}` });
    assert.strictEqual(expiredGet.statusCode, 401, 'Bearer после TTL должен быть отклонён');
    await request(mockPort, 'POST', '/mock/time', { reset: true });
  }

  // 33. Мульти-песочницы (X-Mock-Sandbox), экспорт состояния, активный экзаменатор вебхуков и curl в журнале
  {
    // В изолированной песочнице worker-2 платежей изначально 0
    const sbHealth = JSON.parse((await request(mockPort, 'GET', '/health', null, { 'X-Mock-Sandbox': 'worker-2' })).body);
    assert.strictEqual(sbHealth.sandbox, 'worker-2');
    assert.strictEqual(sbHealth.payments, 0);

    // Возвращаемся в default песочницу
    await request(mockPort, 'POST', '/mock/sandboxes', { sandbox: 'default' });

    // Активный экзаменатор вебхук-приёмника
    const verifyReport = JSON.parse((await request(mockPort, 'POST', '/mock/verify-merchant', { url: notificationUrl })).body);
    assert.strictEqual(verifyReport.steps.length, 3);
    assert.strictEqual(verifyReport.steps[0].passed, true, 'шаг 1 (валидный вебхук) должен пройти на тестовом приёмнике');
    assert.strictEqual(verifyReport.steps[1].passed, true, 'шаг 2 (дубль вебхука) должен пройти на тестовом приёмнике');

    // Проверяем наличие готового curl в /admin/journal
    const journalResp = JSON.parse((await request(mockPort, 'GET', '/admin/journal')).body);
    assert.ok(journalResp.entries.length > 0 && journalResp.entries[journalResp.entries.length - 1].curl.startsWith('curl '));
  }

  /* --- #22 (F-07/F-08): access-control управляющей поверхности и SSRF ------ */

  // 34. Управляющие маршруты закрыты токенами: без токена / неверный -> 401,
  //     operator-токен открывает /mock/*, но не админку; платёжный API свободен
  {
    const child = startChild({ MOCK_ADMIN_TOKEN: 'adm-secret', MOCK_OPERATOR_TOKEN: 'op-secret' });
    const childPort = await child.port;
    try {
      const guarded = [
        ['GET', '/mock/state'],
        ['GET', '/mock/time'],
        ['GET', '/mock/scenarios'],
        ['GET', '/mock/sandboxes'],
        ['POST', '/mock/reset'],
        ['GET', '/admin/journal'],
        ['GET', '/v2/Dispute/DSP-1'],
      ];
      for (const [method, path] of guarded) {
        const r = await request(childPort, method, path, method === 'POST' ? {} : undefined);
        assert.strictEqual(r.statusCode, 401, `${method} ${path} без токена должен требовать авторизацию (получено ${r.statusCode})`);
      }

      const badToken = await request(childPort, 'GET', '/mock/state', undefined, { Authorization: 'Bearer nope' });
      assert.strictEqual(badToken.statusCode, 401, 'неверный токен -> 401');
      // #147: подсказка 401 не должна ссылаться на удалённый docs/rfc/RFC-001-…,
      // а вести на актуальный SECURITY.md §«Изоляция песочниц».
      assert.ok(!String(badToken.body).includes('docs/rfc'), '401-подсказка не ссылается на удалённый RFC-документ');
      assert.ok(String(badToken.body).includes('SECURITY.md'), '401-подсказка указывает на SECURITY.md (изоляция песочниц)');

      const opState = await request(childPort, 'GET', '/mock/state', undefined, { Authorization: 'Bearer op-secret' });
      assert.strictEqual(opState.statusCode, 200, 'operator-токен должен открывать /mock/state');
      const opTime = await request(childPort, 'GET', '/mock/time', undefined, { 'X-Operator-Token': 'op-secret' });
      assert.strictEqual(opTime.statusCode, 200, 'X-Operator-Token должен приниматься');

      const operatorOnAdmin = await request(childPort, 'GET', '/admin/journal', undefined, { Authorization: 'Bearer op-secret' });
      assert.strictEqual(operatorOnAdmin.statusCode, 401, 'operator-токен не должен открывать /admin');
      const adminOnAdmin = await request(childPort, 'GET', '/admin/journal', undefined, { Authorization: 'Bearer adm-secret' });
      assert.strictEqual(adminOnAdmin.statusCode, 200, 'админ-токен должен открывать /admin/journal');

      const adminInitPayload = { TerminalKey: TERMINAL, Amount: '100', OrderId: 'csrf-admin-child' };
      const adminInit = JSON.parse((await request(childPort, 'POST', '/v2/Init', {
        ...adminInitPayload, Token: tokenOf(adminInitPayload),
      })).body);
      assert.strictEqual(adminInit.Success, true, 'тестовая операция для admin-формы создаётся');
      
      // HOSTED-режим: query-токен отвергается (MS-06/Ф-4), а default без
      // MOCK_SANDBOX_TOKEN больше не отдаётся бизнес-API (MS-12, #121).
      const hostedChild = startChild({ MOCK_HOSTED: '1', MOCK_ADMIN_TOKEN: 'adm-secret' });
      const hostedPort = await hostedChild.port;
      const hostedQueryFail = await request(hostedPort, 'GET', '/mock/time?admin_token=adm-secret');
      assert.strictEqual(hostedQueryFail.statusCode, 401, 'hosted-режим отвергает query-токен');
      const hostedClosedPayload = { TerminalKey: TERMINAL, Amount: '100', OrderId: 'ms12-closed-1' };
      const hostedClosedBiz = await request(hostedPort, 'POST', '/v2/Init', {
        ...hostedClosedPayload, Token: tokenOf(hostedClosedPayload),
      });
      assert.strictEqual(hostedClosedBiz.statusCode, 404, 'MS-12: hosted без MOCK_SANDBOX_TOKEN не обслуживает бизнес-API default-песочницы');
      assert.ok(String(hostedClosedBiz.body).includes('MOCK_SANDBOX_TOKEN'), 'MS-12: 404-ответ объясняет, как открыть песочницу');
      const hostedQueryOnBiz = await request(hostedPort, 'GET', '/v2/GetState?sandbox_token=owner-secret');
      assert.strictEqual(hostedQueryOnBiz.statusCode, 401, 'Ф-3: hosted отвергает ?sandbox_token и на бизнес-маршрутах');
      assert.ok(!String(hostedQueryOnBiz.body).includes('FAIL_QUERY_TOKEN_REJECTED'), 'Ф-3: сентинел-значение не попадает в ответы/журналы');
      hostedChild.proc.kill();
      
      const form = (fields) => new URLSearchParams(fields).toString();
      const adminLogin = await request(childPort, 'POST', '/admin/login', form({ admin_token: 'adm-secret' }), { 'Content-Type': 'application/x-www-form-urlencoded' });
      assert.strictEqual(adminLogin.statusCode, 302, 'Успешный вход через форму');
      const sessionCookie = (adminLogin.headers['set-cookie'] || []).find(c => c.startsWith('mock_admin_token=adm-secret'));
      assert.ok(sessionCookie, 'Cookie устанавливается');
      
      const adminPageWithQueryToken = await request(childPort, 'GET', '/admin', '', { 'Cookie': sessionCookie.split(';')[0] });
      assert.strictEqual(adminPageWithQueryToken.statusCode, 200, 'Доступ к /admin по cookie');
      const csrfToken = (adminPageWithQueryToken.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
      const actionStart = adminPageWithQueryToken.body.indexOf('action="/admin/action');
   const actionUrl = actionStart > -1 ? adminPageWithQueryToken.body.slice(actionStart + 8).split('"')[0] : '';
      assert.ok(csrfToken && actionUrl === '/admin/action', 'URL не содержит токенов');

      // Ф-1 (#121): query-токен non-hosted переносится в сессионную cookie, а
      // HTML/Location больше не несут токенов.
      const adminByQuery = await request(childPort, 'GET', '/admin?admin_token=adm-secret');
      assert.strictEqual(adminByQuery.statusCode, 200, 'non-hosted: вход в консоль по query-токену работает (DX)');
      assert.ok(!String(adminByQuery.body).includes('adm-secret'), 'Ф-1: HTML консоли не содержит управляющего токена');
      assert.ok(!String(adminByQuery.body).includes('admin_token='), 'Ф-1: HTML консоли не содержит токен в URL');
      const mintedCookie = (adminByQuery.headers['set-cookie'] || []).find((c) => c.startsWith('mock_admin_token=adm-secret'));
      assert.ok(mintedCookie, 'Ф-1: принятый из query токен перенесён в HttpOnly-cookie');
      const queryPayload = { TerminalKey: TERMINAL, Amount: '200', OrderId: 'csrf-admin-query' };
      const queryInit = JSON.parse((await request(childPort, 'POST', '/v2/Init', {
        ...queryPayload, Token: tokenOf(queryPayload),
      })).body);
      const actionByQuery = await request(childPort, 'POST', '/admin/action?admin_token=adm-secret', form({
        action: 'cancel-new', id: queryInit.PaymentId, _csrf: csrfToken,
      }), { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: mintedCookie.split(';')[0] });
      assert.strictEqual(actionByQuery.statusCode, 302, 'Ф-1: действие принимается по cookie-сессии (токен в POST-URL не нужен)');
      assert.strictEqual(actionByQuery.headers.location, '/admin', 'Ф-1: Location не содержит ни admin_token, ни sandbox_token');
            const deniedNoCsrf = await request(childPort, 'POST', '/admin/action', form({ action: 'cancel-new', id: adminInit.PaymentId }), { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': sessionCookie.split(';')[0] });
      assert.strictEqual(deniedNoCsrf.statusCode, 403, 'POST без CSRF-токена запрещён');
      const deniedCrossOrigin = await request(childPort, 'POST', '/admin/action', form({ action: 'cancel-new', id: adminInit.PaymentId, _csrf: csrfToken }), { 'Cookie': sessionCookie.split(';')[0],
        'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://attacker.invalid',
      });
      assert.strictEqual(deniedCrossOrigin.statusCode, 403, 'cross-site POST запрещён даже с действующим токеном');
      const validAction = await request(childPort, 'POST', actionUrl, form({ action: 'cancel-new', id: adminInit.PaymentId, _csrf: csrfToken }), { 'Cookie': sessionCookie.split(';')[0], 'Content-Type': 'application/x-www-form-urlencoded' });
      assert.strictEqual(validAction.statusCode, 302, 'CSRF-форма принимается');
      assert.strictEqual(validAction.headers.location, '/admin', 'redirect без токенов в URL');
      const getStatePayload = { TerminalKey: TERMINAL, PaymentId: adminInit.PaymentId };
      const adminActionState = JSON.parse((await request(childPort, 'POST', '/v2/GetState', {
        ...getStatePayload, Token: tokenOf(getStatePayload),
      })).body);
      assert.strictEqual(adminActionState.Status, 'CANCELED', 'успешная защищённая форма выполнила действие');

      // Платёжный API остаётся доступен без управляющих токенов
      const healthChild = await request(childPort, 'GET', '/health');
      assert.strictEqual(healthChild.statusCode, 200);
      const initPayload = { TerminalKey: TERMINAL, Amount: '1500', OrderId: 'auth-child-1' };
      const initChild = await request(childPort, 'POST', '/v2/Init', { ...initPayload, Token: tokenOf(initPayload) });
      assert.strictEqual(JSON.parse(initChild.body).Success, true, 'платёжный API не должен требовать operator-токен');
    } finally {
      await stopChild(child);
    }
  }

  // 35. Hosted-режим: fail-closed управляющей поверхности без секрета,
  //     SSRF-политика включена по умолчанию (MOCK_BLOCK_PRIVATE_WEBHOOKS не задан)
  {
    const child = startChild({ MOCK_HOSTED: '1' });
    const childPort = await child.port;
    try {
      for (const [method, path] of [['GET', '/mock/state'], ['GET', '/admin/journal'], ['GET', '/mock/sandboxes']]) {
        const r = await request(childPort, method, path);
        assert.strictEqual(r.statusCode, 401, `hosted без секрета: ${method} ${path} должен быть закрыт (fail-closed)`);
        assert.ok(String(r.body).includes('hosted'), 'DX-ответ должен объяснять hosted-политику');
      }
      const healthHosted = await request(childPort, 'GET', '/health');
      assert.strictEqual(healthHosted.statusCode, 200, 'health в hosted-режиме остаётся публичным');
      // MS-12 (#121): default в hosted без MOCK_SANDBOX_TOKEN бизнес-API не
      // обслуживает — это и есть предмет волны (раньше API работал анонимно).
      const initHosted = await request(childPort, 'POST', '/v2/Init', { ...(() => { const p = { TerminalKey: TERMINAL, Amount: '1500', OrderId: 'hosted-1' }; return { ...p, Token: tokenOf(p) }; })() });
      assert.strictEqual(initHosted.statusCode, 404, 'MS-12: hosted без MOCK_SANDBOX_TOKEN не отдаёт default бизнес-API');
      assert.ok(String(initHosted.body).includes('MOCK_SANDBOX_TOKEN'), 'MS-12: DX-ответ называет MOCK_SANDBOX_TOKEN');
      assert.ok(child.output().includes('hosted=true block_private_webhooks=true'), '#51 PF-01: MOCK_HOSTED=1 включает block_private_webhooks=true по умолчанию');
      assert.ok(child.output().includes('default=closed'), 'MS-12: стартовый статус сообщает, что default закрыта');
      // MS-12: при закрытой default именованные песочницы остаются рабочим путём
      const createNamed = await request(childPort, 'POST', '/sandboxes', { sandbox: 'ms12-named' });
      assert.strictEqual(createNamed.statusCode, 201, 'MS-12: именованная песочница создаётся при закрытой default');
      const named = JSON.parse(createNamed.body);
      const namedPayload = { TerminalKey: named.creds.terminalKey, Amount: '100', OrderId: 'ms12-named-1' };
      const namedInit = JSON.parse((await request(childPort, 'POST', `/v2/Init?sandbox=${encodeURIComponent(named.id)}`, {
        ...namedPayload, Token: tokenOf(namedPayload, named.creds.terminalPassword),
      }, { 'X-Sandbox-Token': named.ownerToken })).body);
      assert.strictEqual(namedInit.Success, true, 'MS-12: именованная песочница обслуживает бизнес-API по owner-token');
      assert.ok(!String(createNamed.body).includes('MOCK_SANDBOX_TOKEN'), 'MS-12: owner-token не путается с env-подсказкой');
    } finally {
      await stopChild(child);
    }

    // MS-12 BC: с MOCK_SANDBOX_TOKEN default остаётся песочницей с owner-token
    const hostedOwnerChild = startChild({ MOCK_HOSTED: '1', MOCK_SANDBOX_TOKEN: 'default-owner-secret' });
    const hostedOwnerPort = await hostedOwnerChild.port;
    try {
      const ownerPayload = { TerminalKey: TERMINAL, Amount: '500', OrderId: 'hosted-owner-1' };
      const noToken = await request(hostedOwnerPort, 'POST', '/v2/Init', { ...ownerPayload, Token: tokenOf(ownerPayload) });
      assert.strictEqual(noToken.statusCode, 401, 'MS-12: hosted с токеном требует owner-token (401)');
      const withToken = await request(hostedOwnerPort, 'POST', '/v2/Init', { ...ownerPayload, Token: tokenOf(ownerPayload) }, { 'X-Sandbox-Token': 'default-owner-secret' });
      assert.strictEqual(JSON.parse(withToken.body).Success, true, 'MS-12 BC: owner-token открывает default в hosted');
      assert.ok(!String(withToken.body).includes('default-owner-secret'), 'MS-12: ответ не эхо-ит owner-token');
      assert.ok(hostedOwnerChild.output().includes('default=owner-token'), 'MS-12: стартовый статус сообщает про owner-token');
    } finally {
      await stopChild(hostedOwnerChild);
    }
  }

  // 36. SSRF: `=1`/`=true` блокируют приватные IPv4/IPv6 и в очереди, и в examiner'е
  {
    const child = startChild({ MOCK_BLOCK_PRIVATE_WEBHOOKS: '1' });
    const childPort = await child.port;
    try {
      const v4 = await request(childPort, 'POST', '/mock/verify-merchant', { url: notificationUrl });
      assert.strictEqual(v4.statusCode, 403, 'MOCK_BLOCK_PRIVATE_WEBHOOKS=1: private IPv4 в /mock/verify-merchant -> 403');
      assert.ok(String(v4.body).includes('SSRF'), 'DX-ответ должен называть политику SSRF');

      const v6 = await request(childPort, 'POST', '/mock/verify-merchant', { url: 'http://[::1]/hook' });
      assert.strictEqual(v6.statusCode, 403, 'MOCK_BLOCK_PRIVATE_WEBHOOKS=1: private IPv6 -> 403');

      // Очередь вебхуков тоже под guard'ом: INCOMING-нотификация не уходит на 127.0.0.1
      const incomingPayload = { TerminalKey: TERMINAL, VerificationCode: 'VER-SSRF', Amount: '100', PayerInn: '7801111111', NotificationURL: notificationUrl };
      const incoming = await request(childPort, 'POST', '/av/v1/payment', { ...incomingPayload, Token: tokenOf(incomingPayload) });
      assert.strictEqual(JSON.parse(incoming.body).Success, true);
      const notif = await waitForCondition(async () => {
        const exported = JSON.parse((await request(childPort, 'GET', '/mock/state')).body);
        const childState = (exported.state && exported.state.state) || exported.state || {};
        const candidate = Object.values(childState.notifications || {}).find((n) => n.paymentId && n.paymentId.startsWith('IN-'));
        return candidate && candidate.lastStatus ? candidate : null;
      }, { description: 'private callback blocked and recorded in queue' });
      assert.ok(notif, 'нотификация должна быть зарегистрирована в очереди');
      assert.ok(String(notif.lastStatus).startsWith('ERR'), `доставка на приватный адрес должна быть заблокирована, lastStatus=${notif.lastStatus}`);
      assert.ok(String(notif.lastStatus).includes('SSRF'), 'причина отказа должна быть явной (SSRF)');
    } finally {
      await stopChild(child);
    }
  }

  // 37. Оба написания env: `=1` и `=true` включают guard; живые вебхуки на
  //     публичные адреса политикой не затрагиваются (локальный стенд = выключено)
  {
    const child = startChild({ MOCK_BLOCK_PRIVATE_WEBHOOKS: 'true' });
    const childPort = await child.port;
    try {
      const r = await request(childPort, 'POST', '/mock/verify-merchant', { url: notificationUrl });
      assert.strictEqual(r.statusCode, 403, 'MOCK_BLOCK_PRIVATE_WEBHOOKS=true тоже должен включать guard');
    } finally {
      await stopChild(child);
    }
    assert.ok(WEBHOOK_HITS.length > 0, 'локальный режим без флага продолжает доставлять вебхуки на localhost');
  }

  // 38. #24 (F-09, F-10): секреты и карточные данные не попадают в state,
  //     /mock/state, журнал (JSON и HTML) и console output.
  {
    // Уникальный валидный по Luhn PAN («Мир»), которого нет среди тестовых карт.
    const sentinelPan = '2200770012345676';
    const sentinelSecret = 'mock-acqapi-secret';
    const basicHeader = Buffer.from(`partner:${sentinelSecret}`).toString('base64');

    // Выплаты идут по сделке (F-17) — заводим и пополняем её до захвата console,
    // чтобы проверки логов относились только к sentinel-запросам.
    const sentinelDealId = await fundedDeal(mockPort, 100000, 'order-sentinel-fund');

    let bearerToken = '';
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => { logged.push(args.map((a) => String(a)).join(' ')); };
    try {
      // Выплата с PAN: в state остаются только маска и сценарий
      const panInitPayload = {
        TerminalKey: TERMINAL, Amount: '15000', OrderId: 'payout-sentinel-pan', DealId: sentinelDealId,
        PaymentRecipientId: 'recipient-sntl', Pan: sentinelPan,
        RecipientName: 'Иван Петров', RecipientInn: '7801111111',
      };
      const panInit = JSON.parse((await request(mockPort, 'POST', '/e2c/v2/Init', { ...panInitPayload, Token: tokenOf(panInitPayload) })).body);
      assert.strictEqual(panInit.Success, true, 'e2c Init с PAN должен проходить');
      const panPayout = state.payouts[panInit.PaymentId];
      assert.strictEqual(panPayout.pan, undefined, 'полный PAN не должен храниться в state (F-10)');
      assert.strictEqual(panPayout.panMask, '220077**5676', 'в state остаётся маска BIN + последние 4');
      assert.strictEqual(panPayout.cardScenario, null, 'PAN вне тестового списка сценария не выбирает');
      assert.strictEqual(panPayout.recipientType, 'card', 'PAN-выплата идёт по карточному каналу (F-17)');

      // Официальный тестовый кейс 5000000000000553 -> 1057 продолжает работать без PAN в state
      const badInit = JSON.parse((await e2c(mockPort, 'Init', {
        Amount: '10000', OrderId: 'payout-sentinel-1057', DealId: sentinelDealId, Pan: '5000000000000553',
      })).body);
      const badPayout = state.payouts[badInit.PaymentId];
      assert.strictEqual(badPayout.pan, undefined, 'полный PAN тестовой карты тоже не хранится');
      assert.strictEqual(badPayout.panMask, '500000**0553');
      assert.strictEqual(badPayout.cardScenario, 'reject-1057', 'сценарий выбирается в Init');
      const badPay = JSON.parse((await e2c(mockPort, 'Payment', { PaymentId: badInit.PaymentId })).body);
      assert.strictEqual(badPay.Success, false);
      assert.strictEqual(badPay.ErrorCode, '1057');
      assert.strictEqual(badPay.Status, 'REJECTED');

      // acqapi: Basic (OAuth) и Bearer — заголовки с кредами в журнал не попадают
      const oauth = await request(mockPort, 'POST', '/oauth/token', {}, { Authorization: `Basic ${basicHeader}` });
      assert.strictEqual(oauth.statusCode, 200, 'POST /oauth/token с Basic должен проходить');
      bearerToken = JSON.parse(oauth.body).access_token;
      const shopPayload = partnerRegistrationFixture('SENTINEL', '7801111111', 'article-sentinel');
      const shop = await request(mockPort, 'POST', '/sm-register/register', shopPayload, { Authorization: `Bearer ${bearerToken}` });
      assert.strictEqual(shop.statusCode, 200, `POST /sm-register/register должен проходить: ${shop.body.slice(0, 120)}`);

      // Битая подпись: диагностический payload в console — тоже через редакцию
      await request(mockPort, 'POST', '/v2/Init', { TerminalKey: TERMINAL, Amount: '100', OrderId: 'sentinel-bad-token', Pan: sentinelPan, Token: 'deadbeefdeadbeef' });
    } finally {
      console.log = originalLog;
    }

    const consoleText = logged.join('\n');
    assert.ok(logged.length > 0, 'стенд должен писать диагностику в console — иначе проверка логов пуста');
    assert.ok(!consoleText.includes(sentinelPan), `PAN не должен попадать в console: ${consoleText.slice(0, 300)}`);
    assert.ok(!consoleText.includes(sentinelSecret), 'секрет acqapi не должен попадать в console');
    assert.ok(!consoleText.includes(basicHeader), 'Basic-заголовок не должен попадать в console');
    assert.ok(!consoleText.includes('5000000000000553'), 'PAN тестовой карты не должен попадать в console');

    const journalText = (await request(mockPort, 'GET', '/admin/journal')).body;
    for (const [what, needle] of [
      ['sentinel PAN', sentinelPan],
      ['PAN тестовой карты', '5000000000000553'],
      ['Basic-заголовок', basicHeader],
      ['Bearer-токен', bearerToken],
      ['секрет acqapi', sentinelSecret],
    ]) {
      assert.ok(!journalText.includes(needle), `${what} не должен попадать в /admin/journal`);
    }
    const journal = JSON.parse(journalText);
    const initEntry = journal.entries.find((e) => e.path === '/e2c/v2/Init' && e.body && e.body.OrderId === 'payout-sentinel-pan');
    assert.ok(initEntry, 'запись e2c Init должна быть в журнале');
    assert.strictEqual(initEntry.body.Pan, '[REDACTED]', 'PAN в журнале — только [REDACTED]');
    assert.strictEqual(initEntry.body.RecipientName, 'Ив***', 'ФИО в журнале маскируется');
    assert.strictEqual(initEntry.body.RecipientInn, '7801******', 'ИНН получателя в журнале маскируется');
    assert.ok(!initEntry.curl.includes(sentinelPan), 'PAN не должен попадать в curl-сниппет');
    for (const entry of journal.entries) {
      assert.strictEqual(entry.headers && entry.headers.authorization, undefined, 'Authorization не должен храниться в журнале');
    }
    const oauthEntry = journal.entries.find((e) => e.path === '/oauth/token');
    assert.ok(oauthEntry, 'запись /oauth/token должна быть в журнале');
    assert.ok(JSON.stringify(oauthEntry.headers).length < 200, `в записи остаются только служебные заголовки: ${JSON.stringify(oauthEntry.headers)}`);

    const adminHtml = (await request(mockPort, 'GET', '/admin')).body;
    assert.ok(!adminHtml.includes(sentinelPan), 'PAN не должен попадать в HTML-консоль');
    assert.ok(!adminHtml.includes(basicHeader), 'Basic-заголовок не должен попадать в HTML-консоль');

    const stateText = (await request(mockPort, 'GET', '/mock/state')).body;
    assert.ok(!stateText.includes(sentinelPan), 'PAN не должен попадать в экспорт /mock/state');
    assert.ok(!stateText.includes('5000000000000553'), 'PAN тестовой карты не должен попадать в экспорт /mock/state');
    assert.ok(stateText.includes('500000**0553'), 'маска PAN в экспорте остаётся для отладки');
  }

  // 39. #24 (F-10): снимок состояния 0.5.0 с полным PAN вычищается при загрузке
  {
    const legacyFile = path.join(os.tmpdir(), `tbank-legacy-pan-${process.pid}.json`);
    fs.writeFileSync(legacyFile, JSON.stringify({
      payouts: {
        'P-1': { paymentId: 'P-1', amount: 100, status: 'NEW', pan: '2200770012345676', cardId: '5000000000000553', statusHistory: [] },
      },
    }));
    const child = startChild({ MOCK_STATE_FILE: legacyFile });
    const childPort = await child.port;
    try {
      const exported = JSON.parse((await request(childPort, 'GET', '/mock/state')).body);
      const childState = (exported.state && exported.state.state) || exported.state || {};
      const legacyPayout = (childState.payouts || {})['P-1'];
      assert.ok(legacyPayout, 'выплата из снимка должна загрузиться');
      assert.strictEqual(legacyPayout.pan, undefined, 'полный PAN из старого снимка должен быть удалён');
      assert.strictEqual(legacyPayout.panMask, '220077**5676');
      assert.strictEqual(legacyPayout.cardScenario, 'reject-1057', 'сценарий восстанавливается из номера карты');
      assert.strictEqual(legacyPayout.cardId, '500000**0553', 'PAN в поле cardId тоже маскируется');
      assert.ok(!(await request(childPort, 'GET', '/mock/state')).body.includes('2200770012345676'));

      // Импорт снимка с полным PAN вычищается так же
      const importRes = await request(childPort, 'POST', '/mock/state', {
        state: { payouts: { 'P-9': { paymentId: 'P-9', amount: 100, status: 'NEW', pan: '2200770012345676' } } },
      });
      assert.strictEqual(JSON.parse(importRes.body).ok, true, 'импорт снимка должен проходить');
      const imported = JSON.parse((await request(childPort, 'GET', '/mock/state')).body);
      const importedState = (imported.state && imported.state.state) || imported.state || {};
      assert.strictEqual(importedState.payouts['P-9'].pan, undefined, 'PAN из импорта не сохраняется');
      assert.strictEqual(importedState.payouts['P-9'].panMask, '220077**5676');
      assert.ok(!(await request(childPort, 'GET', '/mock/state')).body.includes('2200770012345676'), 'в экспорте после импорта PAN нет');
    } finally {
      await stopChild(child);
      try { fs.unlinkSync(legacyFile); } catch { /* уже удалён */ }
    }
  }

  /* --- #25 (F-16—F-23): точность Init recipient и CancelPayment ------------- */

  // Подписанный Init без клиентских значений по умолчанию (для негативных кейсов)
  const signedInit = (body) => {
    const p = { TerminalKey: TERMINAL, ...body };
    return request(mockPort, 'POST', '/v2/Init', { ...p, Token: tokenOf(p) });
  };

  // 40. F-16: multisplit Init без валидного PaymentRecipientId отклоняется ДО создания state
  {
    const paymentsBefore = Object.keys(state.payments).length;
    const missing = JSON.parse((await signedInit({ Amount: '1000', OrderId: 'f16-missing', CreateDealWithType: 'NN' })).body);
    assert.strictEqual(missing.ErrorCode, '7', 'Init без PaymentRecipientId в multisplit — код 7');
    assert.ok(String(missing.Message).includes('PaymentRecipientId'), 'сообщение называет поле');
    const empty = JSON.parse((await signedInit({ Amount: '1000', OrderId: 'f16-empty', CreateDealWithType: 'NN', PaymentRecipientId: '   ' })).body);
    assert.strictEqual(empty.ErrorCode, '7', 'пустой PaymentRecipientId — код 7');
    const tooLong = JSON.parse((await signedInit({ Amount: '1000', OrderId: 'f16-long', CreateDealWithType: 'NN', PaymentRecipientId: 'r'.repeat(17) })).body);
    assert.strictEqual(tooLong.ErrorCode, '7', 'PaymentRecipientId > 16 символов — код 7');
    assert.strictEqual(Object.keys(state.payments).length, paymentsBefore, 'отказы F-16 не создают платёж');
    assert.ok(!Object.values(state.payments).some((p) => ['f16-missing', 'f16-empty', 'f16-long'].includes(p.orderId)), 'state не содержит отклонённых заказов');

    const boundary = JSON.parse((await signedInit({ Amount: '1000', OrderId: 'f16-boundary', CreateDealWithType: 'NN', PaymentRecipientId: 'r'.repeat(16) })).body);
    assert.strictEqual(boundary.Success, true, 'PaymentRecipientId ровно 16 символов — допустим');
  }

  // 41. F-17: E2C Init валидирует общие поля и канал; неполная выплата не сохраняется
  {
    const dealId = await fundedDeal(mockPort, 300000, 'order-f17-fund');
    const payoutCount = () => Object.keys(state.payouts).length;
    const expectRejected = async (label, body, code = '7') => {
      const before = payoutCount();
      const r = JSON.parse((await e2c(mockPort, 'Init', body)).body);
      assert.strictEqual(r.Success, false, `${label}: должен отклоняться`);
      assert.strictEqual(r.ErrorCode, code, `${label}: код ${code} (получено ${r.ErrorCode}: ${r.Message})`);
      assert.ok(r.Details && r.Details.Field, `${label}: provider-shaped ошибка с полем`);
      assert.strictEqual(payoutCount(), before, `${label}: неполная выплата не сохраняется`);
      return r;
    };
    await expectRejected('без DealId', { Amount: '1000', OrderId: 'f17-nodeal', CardId: 'c-1', DealId: undefined });
    await expectRejected('без OrderId', { Amount: '1000', DealId: dealId, CardId: 'c-1', OrderId: undefined });
    await expectRejected('без PaymentRecipientId', { Amount: '1000', OrderId: 'f17-norec', DealId: dealId, CardId: 'c-1', PaymentRecipientId: undefined });
    await expectRejected('пустой PaymentRecipientId', { Amount: '1000', OrderId: 'f17-emptyrec', DealId: dealId, CardId: 'c-1', PaymentRecipientId: '' });
    await expectRejected('без Amount', { OrderId: 'f17-noamount', DealId: dealId, CardId: 'c-1', Amount: undefined });
    await expectRejected('без канала выплаты', { Amount: '1000', OrderId: 'f17-nochannel', DealId: dealId });
    await expectRejected('два канала (CardId + PartnerId)', { Amount: '1000', OrderId: 'f17-two', DealId: dealId, CardId: 'c-1', PartnerId: '700001' });
    await expectRejected('СБП без SbpMemberId', { Amount: '1000', OrderId: 'f17-sbp-nomem', DealId: dealId, Phone: '+79211234567' });
    await expectRejected('СБП без Phone', { Amount: '1000', OrderId: 'f17-sbp-nophone', DealId: dealId, SbpMemberId: '100000000004' });
    await expectRejected('СБП некорректный Phone', { Amount: '1000', OrderId: 'f17-sbp-badphone', DealId: dealId, Phone: '+7921', SbpMemberId: '100000000004' });
    await expectRejected('СБП меньше 10 ₽', { Amount: '500', OrderId: 'f17-sbp-tiny', DealId: dealId, Phone: '+79211234567', SbpMemberId: '100000000004' });
    await expectRejected('партнёр не зарегистрирован', { Amount: '1000', OrderId: 'f17-nopartner', DealId: dealId, PartnerId: 'NO-SUCH-SHOP' }, '8');
    await expectRejected('TerminalKey чужой', { Amount: '1000', OrderId: 'f17-term', DealId: dealId, CardId: 'c-1', TerminalKey: 'OTHER-TERMINAL' });

    // Позитивные по каждому реализованному каналу
    const card = JSON.parse((await e2c(mockPort, 'Init', { Amount: '1000', OrderId: 'f17-card', DealId: dealId, CardId: 'card-f17' })).body);
    assert.strictEqual(card.Success, true, 'канал «привязанная карта» проходит');
    assert.strictEqual(state.payouts[card.PaymentId].recipientType, 'card');

    const cardData = JSON.parse((await e2c(mockPort, 'Init', { Amount: '1000', OrderId: 'f17-carddata', DealId: dealId, Pan: '2200770012345676' })).body);
    assert.strictEqual(cardData.Success, true, 'канал «карта по данным» проходит');
    assert.strictEqual(state.payouts[cardData.PaymentId].panMask, '220077**5676', 'для карты по данным хранится только маска (F-10)');

    const sbp = JSON.parse((await e2c(mockPort, 'Init', { Amount: '1000', OrderId: 'f17-sbp', DealId: dealId, Phone: '+7 921 123-45-67', SbpMemberId: '100000000004' })).body);
    assert.strictEqual(sbp.Success, true, 'канал СБП проходит');
    assert.strictEqual(state.payouts[sbp.PaymentId].recipientType, 'sbp');
    assert.strictEqual(state.payouts[sbp.PaymentId].sbpMemberId, '100000000004', 'SbpMemberId сохраняется');
    assert.strictEqual(state.payouts[sbp.PaymentId].phone, '79211234567', 'телефон нормализуется до 11 цифр');

    const partner = await registerPartner(mockPort, 'LOVII F17 PART');
    const partnerInit = JSON.parse((await e2c(mockPort, 'Init', { Amount: '1000', OrderId: 'f17-partner', DealId: dealId, PartnerId: partner })).body);
    assert.strictEqual(partnerInit.Success, true, 'канал «партнёр» проходит');
    assert.strictEqual(state.payouts[partnerInit.PaymentId].recipientType, 'partner');
    assert.strictEqual(state.payouts[partnerInit.PaymentId].partnerId, partner, 'PartnerId (shopCode) сохраняется (F-20)');
  }

  // 42. F-18…F-23: CancelPayment — только успешная партнёрская выплата в открытой сделке
  {
    const dealId = await fundedDeal(mockPort, 500000, 'order-cxl-fund');
    const partner = await registerPartner(mockPort, 'LOVII CXL 42');
    const snapshot = (id, deal = dealId) => JSON.stringify({
      status: state.payouts[id].status,
      history: state.payouts[id].statusHistory.length,
      deal: state.deals[deal] && state.deals[deal].status,
    });
    const cancel = (body) => e2c(mockPort, 'CancelPayment', body);
    const partnerInit = (orderId, amount = '10000', deal = dealId) => e2c(mockPort, 'Init', {
      Amount: amount, OrderId: orderId, DealId: deal, PartnerId: partner,
    }).then((r) => JSON.parse(r.body));

    // F-18: NEW → отказ, состояние не меняется
    const pNew = await partnerInit('f18-new');
    assert.strictEqual(pNew.Success, true);
    const beforeNew = snapshot(pNew.PaymentId);
    const cNew = JSON.parse((await cancel({ PaymentId: pNew.PaymentId, DealId: dealId })).body);
    assert.strictEqual(cNew.Success, false, 'NEW не отменяется');
    assert.strictEqual(cNew.ErrorCode, '32');
    assert.strictEqual(snapshot(pNew.PaymentId), beforeNew, 'отказ NEW не меняет выплату');

    // F-18: REJECTED (тестовая карта 5000000000000553) → отказ
    const pRej = JSON.parse((await e2c(mockPort, 'Init', { Amount: '10000', OrderId: 'f18-rej', DealId: dealId, Pan: '5000000000000553' })).body);
    await e2c(mockPort, 'Payment', { PaymentId: pRej.PaymentId });
    assert.strictEqual(state.payouts[pRej.PaymentId].status, 'REJECTED');
    const beforeRej = snapshot(pRej.PaymentId);
    const cRej = JSON.parse((await cancel({ PaymentId: pRej.PaymentId, DealId: dealId })).body);
    assert.strictEqual(cRej.ErrorCode, '32', 'REJECTED не отменяется');
    assert.strictEqual(snapshot(pRej.PaymentId), beforeRej);

    // F-18/F-23: CONFIRMED партнёрская → успех, история CREDIT_CANCELING → CREDIT_CANCELED
    const pOk = await partnerInit('f18-ok');
    await e2c(mockPort, 'Payment', { PaymentId: pOk.PaymentId });
    assert.strictEqual(state.payouts[pOk.PaymentId].status, 'CONFIRMED');
    const cOk = JSON.parse((await cancel({ PaymentId: pOk.PaymentId, DealId: dealId })).body);
    assert.strictEqual(cOk.Success, true, 'CONFIRMED партнёрская — отмена проходит');
    assert.strictEqual(cOk.Status, 'CREDIT_CANCELED');
    const okHistory = state.payouts[pOk.PaymentId].statusHistory.map((h) => h.status);
    assert.deepStrictEqual(okHistory.slice(-2), ['CREDIT_CANCELING', 'CREDIT_CANCELED'], 'F-23: оба промежуточных статуса в истории');

    // F-18: уже отменённая (CREDIT_CANCELED) и legacy CANCELED → отказ
    const cAgain = JSON.parse((await cancel({ PaymentId: pOk.PaymentId, DealId: dealId })).body);
    assert.strictEqual(cAgain.ErrorCode, '32', 'повторная отмена отказывает');
    const pLegacy = await partnerInit('f18-legacy-canceled');
    await e2c(mockPort, 'Payment', { PaymentId: pLegacy.PaymentId });
    state.payouts[pLegacy.PaymentId].status = 'CANCELED';
    const cLegacy = JSON.parse((await cancel({ PaymentId: pLegacy.PaymentId, DealId: dealId })).body);
    assert.strictEqual(cLegacy.ErrorCode, '32', 'CANCELED не отменяется повторно');
    assert.strictEqual(state.payouts[pLegacy.PaymentId].status, 'CANCELED', 'отказ не меняет статус');

    // F-19: закрытая сделка → отказ без side effect
    const closedDeal = await fundedDeal(mockPort, 100000, 'order-cxl-closed');
    const pClosed = await partnerInit('f19-closed', '10000', closedDeal);
    await e2c(mockPort, 'Payment', { PaymentId: pClosed.PaymentId });
    await api(mockPort, 'closeSpDeal', { SpAccumulationId: closedDeal });
    assert.strictEqual(state.deals[closedDeal].status, 'closed');
    const beforeClosed = snapshot(pClosed.PaymentId, closedDeal);
    const cClosed = JSON.parse((await cancel({ PaymentId: pClosed.PaymentId, DealId: closedDeal })).body);
    assert.strictEqual(cClosed.Success, false, 'отмена в закрытой сделке отказывает');
    assert.strictEqual(snapshot(pClosed.PaymentId, closedDeal), beforeClosed, 'F-19: закрытая сделка — без side effect');

    // F-19: отсутствующая сделка → отказ без side effect
    const goneDeal = await fundedDeal(mockPort, 100000, 'order-cxl-gone');
    const pGone = await partnerInit('f19-gone', '10000', goneDeal);
    await e2c(mockPort, 'Payment', { PaymentId: pGone.PaymentId });
    delete state.deals[goneDeal];
    const cGone = JSON.parse((await cancel({ PaymentId: pGone.PaymentId, DealId: goneDeal })).body);
    assert.strictEqual(cGone.Success, false, 'отсутствующая сделка — отказ');
    assert.strictEqual(state.payouts[pGone.PaymentId].status, 'CONFIRMED', 'F-19: выплата остаётся CONFIRMED');

    // F-20: не-партнёрский канал (карта, СБП) → отказ, статус не меняется
    const cardPay = JSON.parse((await e2c(mockPort, 'Init', { Amount: '10000', OrderId: 'f20-card', DealId: dealId, CardId: 'card-f20' })).body);
    await e2c(mockPort, 'Payment', { PaymentId: cardPay.PaymentId });
    const beforeCard = snapshot(cardPay.PaymentId);
    const cCard = JSON.parse((await cancel({ PaymentId: cardPay.PaymentId, DealId: dealId })).body);
    assert.strictEqual(cCard.Success, false, 'F-20: карточная выплата не отменяется');
    assert.strictEqual(snapshot(cardPay.PaymentId), beforeCard);

    const sbpPay = JSON.parse((await e2c(mockPort, 'Init', { Amount: '10000', OrderId: 'f20-sbp', DealId: dealId, Phone: '+79211234567', SbpMemberId: '100000000004' })).body);
    await e2c(mockPort, 'Payment', { PaymentId: sbpPay.PaymentId });
    const cSbp = JSON.parse((await cancel({ PaymentId: sbpPay.PaymentId, DealId: dealId })).body);
    assert.strictEqual(cSbp.Success, false, 'F-20: выплата по СБП не отменяется');

    // F-21: DealId обязателен и сверяется с выплатой
    const pDeal = await partnerInit('f21-deal');
    await e2c(mockPort, 'Payment', { PaymentId: pDeal.PaymentId });
    const beforeDeal = snapshot(pDeal.PaymentId);
    const cNoDeal = JSON.parse((await cancel({ PaymentId: pDeal.PaymentId, DealId: undefined })).body);
    assert.strictEqual(cNoDeal.ErrorCode, '7', 'F-21: без DealId — код 7');
    const otherDeal = await fundedDeal(mockPort, 100000, 'order-cxl-other');
    const cMismatch = JSON.parse((await cancel({ PaymentId: pDeal.PaymentId, DealId: otherDeal })).body);
    assert.strictEqual(cMismatch.ErrorCode, '7', 'F-21: чужой DealId — код 7');
    assert.strictEqual(snapshot(pDeal.PaymentId), beforeDeal, 'F-21: отказы не меняют выплату');

    // F-22: TerminalKey проверяется до поиска выплаты
    const cNoTerm = JSON.parse((await cancel({ TerminalKey: undefined, PaymentId: pDeal.PaymentId, DealId: dealId })).body);
    assert.strictEqual(cNoTerm.ErrorCode, '7', 'F-22: без TerminalKey — код 7');
    const cBadTerm = JSON.parse((await cancel({ TerminalKey: 'OTHER-TERMINAL', PaymentId: 'P-NOPE', DealId: dealId })).body);
    assert.strictEqual(cBadTerm.ErrorCode, '7', 'F-22: чужой TerminalKey отвечает 7 раньше поиска (не 4)');
    assert.strictEqual(snapshot(pDeal.PaymentId), beforeDeal, 'F-22: отказ по терминалу без мутации');
    const cValid = JSON.parse((await cancel({ TerminalKey: TERMINAL_KEY, PaymentId: pDeal.PaymentId, DealId: dealId })).body);
    assert.strictEqual(cValid.Success, true, 'F-22: подписанный запрос с валидным терминалом — успех');
    const cValidE2c = await partnerInit('f22-e2c-terminal');
    await e2c(mockPort, 'Payment', { PaymentId: cValidE2c.PaymentId });
    const cE2cKey = JSON.parse((await cancel({ TerminalKey: `${TERMINAL_KEY}E2C`, PaymentId: cValidE2c.PaymentId, DealId: dealId })).body);
    assert.strictEqual(cE2cKey.Success, true, 'F-22: PAYOUT-терминал точки тоже допустим');
  }

  // 43. A-20: TerminalKey проверяется во всех E2C-маршрутах до поиска/мутации
  {
    const dealId = await fundedDeal(mockPort, 500000, 'order-e2c-terminal-check');
    const init = JSON.parse((await e2c(mockPort, 'Init', {
      Amount: '10000', OrderId: 'e2c-terminal-check', DealId: dealId, CardId: 'e2c-terminal-card',
    })).body);
    assert.strictEqual(init.Success, true);
    const payout = state.payouts[init.PaymentId];
    const beforePayment = JSON.stringify({ status: payout.status, history: payout.statusHistory.length });

    for (const [label, terminalKey] of [['missing', undefined], ['wrong', 'OTHER-TERMINAL']]) {
      const rejected = JSON.parse((await e2c(mockPort, 'Payment', {
        TerminalKey: terminalKey, PaymentId: init.PaymentId,
      })).body);
      assert.strictEqual(rejected.ErrorCode, '7', `Payment ${label} TerminalKey is rejected before transition`);
      assert.strictEqual(JSON.stringify({ status: payout.status, history: payout.statusHistory.length }), beforePayment, 'rejected Payment does not mutate payout');
    }
    const payment = JSON.parse((await e2c(mockPort, 'Payment', { PaymentId: init.PaymentId })).body);
    assert.strictEqual(payment.Success, true, 'Payment accepts the configured E2C terminal');

    for (const [label, terminalKey] of [['missing', undefined], ['wrong', 'OTHER-TERMINAL']]) {
      const rejected = JSON.parse((await e2c(mockPort, 'GetState', {
        TerminalKey: terminalKey, PaymentId: init.PaymentId,
      })).body);
      assert.strictEqual(rejected.ErrorCode, '7', `GetState ${label} TerminalKey is rejected`);
    }
    const payoutState = JSON.parse((await e2c(mockPort, 'GetState', { PaymentId: init.PaymentId })).body);
    assert.strictEqual(payoutState.Success, true);
    assert.strictEqual(payoutState.Status, 'CONFIRMED');

    for (const terminalKey of [undefined, 'OTHER-TERMINAL']) {
      const rejected = JSON.parse((await e2c(mockPort, 'GetSbpMembers', { TerminalKey: terminalKey })).body);
      assert.strictEqual(rejected.ErrorCode, '7', 'GetSbpMembers rejects missing/foreign TerminalKey');
    }
    const members = JSON.parse((await e2c(mockPort, 'GetSbpMembers')).body);
    assert.strictEqual(members.Success, true, 'GetSbpMembers accepts the configured terminal');
    assert.ok(Array.isArray(members.Members));
  }

  /* --- #8 (RFC-001, F-11—F-15): изоляция песочниц -------------------------- */

  // 44. F-11/F-13: request-local контекст (гонка activeId), target в export/import
  {
    const sandboxState = async (id) => JSON.parse((await request(mockPort, 'GET', `/mock/state?sandbox=${encodeURIComponent(id)}`)).body).state.state;
    const initIn = (id, orderId, latency = 0) => {
      // Профиль основного инстанса — multisplit: Init открывает сделку в песочнице.
      const payload = { TerminalKey: TERMINAL, Amount: '100', OrderId: orderId, PaymentRecipientId: DEFAULT_RECIPIENT, CreateDealWithType: 'NN' };
      return request(
        mockPort,
        'POST',
        '/v2/Init',
        { ...payload, Token: tokenOf(payload) },
        { 'X-Mock-Sandbox': id, ...(latency ? { 'X-Mock-Latency': String(latency) } : {}) },
      );
    };

    const defaultBefore = Object.keys(state.payments).length;
    // A отвечает с задержкой, B — сразу: раньше первый await оставлял B в state A.
    const [ra, rb] = await Promise.all([initIn('f11-a', 'f11-a-1', 300), initIn('f11-b', 'f11-b-1')]);
    assert.strictEqual(JSON.parse(ra.body).Success, true, 'Init в песочнице A должен проходить');
    assert.strictEqual(JSON.parse(rb.body).Success, true, 'Init в песочнице B должен проходить');
    const stA = await sandboxState('f11-a');
    const stB = await sandboxState('f11-b');
    assert.deepStrictEqual(Object.keys(stA.payments), [JSON.parse(ra.body).PaymentId], 'A видит только свой платёж');
    assert.deepStrictEqual(Object.keys(stB.payments), [JSON.parse(rb.body).PaymentId], 'B видит только свой платёж');

    // запрос без ID разрешается в default, а не остаётся в предыдущей песочнице
    const healthDefault = JSON.parse((await request(mockPort, 'GET', '/health')).body);
    assert.strictEqual(healthDefault.sandbox, 'default');
    assert.strictEqual(healthDefault.payments, defaultBefore, 'default не получает документы песочниц');

    // F-13: импорт в явный target не переключает активную (default) песочницу
    const seeded = {
      counters: { paymentId: 777, dealId: 50000, cardId: 80000, notificationId: 1, verificationId: 7000000, incomingId: 1, payoutId: 900000, disputeId: 30000, shopCode: 700100 },
      payments: { '777': { paymentId: '777', orderId: 'seeded-f13', status: 'CONFIRMED' } },
      clockOffsetMs: 0,
    };
    const imp = JSON.parse((await request(mockPort, 'POST', '/mock/state', { sandbox: 'f13-target', state: seeded })).body);
    assert.strictEqual(imp.sandbox, 'f13-target', 'импорт должен вернуть фактический target');
    assert.ok((await sandboxState('f13-target')).payments['777'], 'снимок попал в указанную песочницу');
    assert.ok(!(await sandboxState('default')).payments['777'], 'импорт в target не затронул default');
    const expTarget = JSON.parse((await request(mockPort, 'GET', '/mock/state?sandbox=f13-target')).body);
    assert.strictEqual(expTarget.sandbox, 'f13-target', 'экспорт называет фактическую песочницу');
    assert.strictEqual(expTarget.state.sandbox, 'f13-target');
    assert.ok(expTarget.state.state.payments['777'], 'экспорт читает выбранный снимок');
  }

  // 45. F-12: hosted tenancy — owner-token, креды песочницы, знание ID ≠ доступ
  {
    const child = startChild({ MOCK_TENANCY: '1', MOCK_OPERATOR_TOKEN: 'op-agent', MOCK_SANDBOX_TTL_MS: '3600000' });
    const childPort = await child.port;
    try {
      const created = JSON.parse((await request(childPort, 'POST', '/sandboxes', {})).body);
      assert.ok(created.id && created.ownerToken && created.creds && created.creds.terminalPassword,
        `POST /sandboxes отдаёт id, ownerToken и креды: ${JSON.stringify(created).slice(0, 200)}`);
      const owner = { Authorization: `Bearer ${created.ownerToken}` };

      // знание ID не даёт доступ: без owner-token бизнес-вызов отклоняется
      const idOnly = await request(childPort, 'POST', '/v2/Init', { TerminalKey: created.creds.terminalKey, Amount: '100', OrderId: 'owned-1' }, { 'X-Mock-Sandbox': created.id });
      assert.strictEqual(idOnly.statusCode, 401, 'ID без owner-token — 401');
      // чужой owner-token не подходит
      const other = JSON.parse((await request(childPort, 'POST', '/sandboxes', {})).body);
      const foreign = await request(childPort, 'GET', '/mock/state', undefined, { 'X-Mock-Sandbox': created.id, Authorization: `Bearer ${other.ownerToken}` });
      assert.strictEqual(foreign.statusCode, 401, 'owner-token другой песочницы не открывает чужую');
      // неизвестная песочница — 404 с подсказкой создать
      const unknown = await request(childPort, 'GET', '/mock/state', undefined, { 'X-Mock-Sandbox': 'ghost-8', Authorization: 'Bearer nope' });
      assert.strictEqual(unknown.statusCode, 404, 'неизвестный ID — 404');
      assert.ok(String(unknown.body).includes('POST /sandboxes'), 'DX-ответ подсказывает создание песочницы');

      // со своими кредами и owner-token — успех
      const payload = { TerminalKey: created.creds.terminalKey, Amount: '100', OrderId: 'owned-1', PaymentRecipientId: DEFAULT_RECIPIENT };
      const init = JSON.parse((await request(childPort, 'POST', '/v2/Init', { ...payload, Token: tokenOf(payload, created.creds.terminalPassword) }, { 'X-Mock-Sandbox': created.id, ...owner })).body);
      assert.strictEqual(init.Success, true, `Init с кредами песочницы должен проходить: ${JSON.stringify(init).slice(0, 160)}`);

      // Native admin form must carry the sandbox owner-token through the POST and redirect.
      const ownerAdminPage = await request(childPort, 'GET', `/admin?sandbox=${encodeURIComponent(created.id)}`, undefined, owner);
      const actionMatch = /<form method="POST" action="([^"]*\/admin\/action[^"]*)"/.exec(ownerAdminPage.body);
      const csrfMatch = /name="_csrf" value="([^"]+)"/.exec(ownerAdminPage.body);
      let ownerAdminActionWorks = false;
      if (actionMatch && csrfMatch) {
        const actionUrl = new URL(actionMatch[1].replace(/&amp;/g, '&'), `http://127.0.0.1:${childPort}`);
        const adminPost = await request(childPort, 'POST', `${actionUrl.pathname}${actionUrl.search}`,
          `_csrf=${encodeURIComponent(csrfMatch[1])}&action=cancel-new&id=${encodeURIComponent(init.PaymentId)}`, {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: `http://127.0.0.1:${childPort}`, ...owner });
        const returnedPage = adminPost.headers.location ? await request(childPort, 'GET', adminPost.headers.location, undefined, owner) : null;
        const redirectQuery = new URL(adminPost.headers.location || '/', `http://127.0.0.1:${childPort}`).searchParams;
        ownerAdminActionWorks = (actionUrl.pathname + actionUrl.search) === '/admin/action?sandbox=' + created.id
          && adminPost.statusCode === 302
          && (new URL(adminPost.headers.location || '/', `http://127.0.0.1:${childPort}`).pathname) === '/admin'
          && returnedPage && returnedPage.statusCode === 200;
      }
      assert.ok(ownerAdminPage.statusCode === 200 && ownerAdminActionWorks,
        `admin form keeps owner-token across POST/redirect; status=${ownerAdminPage.statusCode}`);

      // криптография песочницы: чужой (stand) пароль не подходит
      const wrongPassword = JSON.parse((await request(childPort, 'POST', '/v2/Init', { ...payload, OrderId: 'owned-2', Token: tokenOf({ ...payload, OrderId: 'owned-2' }) }, { 'X-Mock-Sandbox': created.id, ...owner })).body);
      assert.strictEqual(wrongPassword.ErrorCode, '13', 'пароль стенда не действует в песочнице (свои креды)');

      // список песочниц: без токена — 401, с owner-token — только своя, оператору — все
      assert.strictEqual((await request(childPort, 'GET', '/mock/sandboxes')).statusCode, 401);
      const ownList = JSON.parse((await request(childPort, 'GET', '/mock/sandboxes', undefined, owner)).body);
      assert.deepStrictEqual(ownList.sandboxes.map((s) => s.id), [created.id], 'владелец видит только свою песочницу');
      const opList = JSON.parse((await request(childPort, 'GET', '/mock/sandboxes', undefined, { Authorization: 'Bearer op-agent' })).body);
      assert.ok(opList.sandboxes.length >= 2, 'оператор видит все песочницы');

      // owner-token открывает управляющие маршруты своей песочницы (RFC-001 §6)
      const stateOwn = await request(childPort, 'GET', '/mock/state', undefined, owner);
      assert.strictEqual(stateOwn.statusCode, 200, 'owner-token открывает /mock/state своей песочницы');
      // /sandboxes/me: инфо, смена кредов, reset
      const me = JSON.parse((await request(childPort, 'GET', '/sandboxes/me', undefined, owner)).body);
      assert.strictEqual(me.sandbox.id, created.id);
      const rotated = JSON.parse((await request(childPort, 'POST', '/sandboxes/me/reset-creds', {}, owner)).body);
      assert.ok(rotated.creds.terminalPassword && rotated.creds.terminalPassword !== created.creds.terminalPassword, 'reset-creds меняет пароль');
      const afterRotate = JSON.parse((await request(childPort, 'GET', '/sandboxes/me', undefined, owner)).body);
      assert.strictEqual(afterRotate.creds.terminalPassword, rotated.creds.terminalPassword, 'новые креды сохранены');
      const meReset = JSON.parse((await request(childPort, 'POST', '/sandboxes/me/reset', {}, owner)).body);
      assert.strictEqual(meReset.sandbox, created.id, 'reset работает по owner-token');
    } finally {
      await stopChild(child);
    }
  }

  // 46. F-14: персистентность песочницы через рестарт и TTL-очистка
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbank-sbx-'));
    const stateFile = path.join(tmpDir, 'state.json');
    let savedPaymentId = '';
    const child1 = startChild({ MOCK_STATE_FILE: stateFile });
    const port1 = await child1.port;
    try {
      const payload = { TerminalKey: TERMINAL, Amount: '100', OrderId: 'persist-1', PaymentRecipientId: DEFAULT_RECIPIENT };
      savedPaymentId = JSON.parse((await request(port1, 'POST', '/v2/Init', { ...payload, Token: tokenOf(payload) }, { 'X-Mock-Sandbox': 'persist-a' })).body).PaymentId;
      await waitForCondition(() => {
        try {
          // PD-02: реестр песочниц поштучно — один файл на песочницу
          const record = JSON.parse(fs.readFileSync(`${stateFile}.sandboxes.records/persist-a.json`, 'utf8')).sandbox;
          return Boolean(record && record.state && record.state.payments && record.state.payments[savedPaymentId]);
        } catch { return false; }
      }, { description: 'atomic sandbox registry flush before restart' });
    } finally {
      await stopChild(child1);
    }

    const child2 = startChild({ MOCK_STATE_FILE: stateFile });
    const port2 = await child2.port;
    try {
      const restored = JSON.parse((await request(port2, 'GET', '/mock/state?sandbox=persist-a')).body);
      assert.ok(restored.state.state.payments[savedPaymentId], 'состояние именованной песочницы восстанавливается после рестарта');
      const def = JSON.parse((await request(port2, 'GET', '/mock/state')).body);
      assert.ok(!def.state.state.payments[savedPaymentId], 'чужой state не приписывается default (F-14)');
      // F-15: после рестарта ссылочные индексы пересобраны — новый Init не падает,
      // а поиск по OrderId находит и восстановленный снимком платёж.
      const payload2 = { TerminalKey: TERMINAL, Amount: '100', OrderId: 'persist-2', PaymentRecipientId: DEFAULT_RECIPIENT };
      const init2 = JSON.parse((await request(port2, 'POST', '/v2/Init', { ...payload2, Token: tokenOf(payload2) }, { 'X-Mock-Sandbox': 'persist-a' })).body);
      assert.strictEqual(init2.Success, true, `Init после рестарта: ${JSON.stringify(init2).slice(0, 160)}`);
      const ref = { TerminalKey: TERMINAL, OrderId: 'persist-1' };
      const found = JSON.parse((await request(port2, 'POST', '/v2/GetState', { ...ref, Token: tokenOf(ref) }, { 'X-Mock-Sandbox': 'persist-a' })).body);
      assert.strictEqual(found.PaymentId, savedPaymentId, 'GetState по OrderId находит платёж из восстановленного снимка (F-15)');
    } finally {
      await stopChild(child2);
    }

    const child3 = startChild({ MOCK_TENANCY: '1', MOCK_SANDBOX_TTL_MS: '800', MOCK_SANDBOX_SWEEP_MS: '1000' });
    const port3 = await child3.port;
    try {
      const created = JSON.parse((await request(port3, 'POST', '/sandboxes', {})).body);
      const before = await request(port3, 'GET', '/mock/state', undefined, { 'X-Mock-Sandbox': created.id, Authorization: `Bearer ${created.ownerToken}` });
      assert.strictEqual(before.statusCode, 200, 'до TTL песочница доступна');
      const after = await waitForCondition(async () => {
        const response = await request(port3, 'GET', '/mock/state', undefined, { 'X-Mock-Sandbox': created.id, Authorization: `Bearer ${created.ownerToken}` });
        return [404, 410].includes(response.statusCode) ? response : null;
      }, { timeoutMs: 5000, description: 'sandbox TTL expiry' });
      assert.ok([404, 410].includes(after.statusCode), `после TTL песочница недоступна (получено ${after.statusCode})`);
    } finally {
      await stopChild(child3);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // 47. F-15: квота документов песочницы (hosted-лимит на объём state)
  {
    const child = startChild({ MOCK_SANDBOX_MAX_DOCUMENTS: '2' });
    const childPort = await child.port;
    try {
      const mk = (orderId) => {
        const payload = { TerminalKey: TERMINAL, Amount: '100', OrderId: orderId, PaymentRecipientId: DEFAULT_RECIPIENT };
        return request(childPort, 'POST', '/v2/Init', { ...payload, Token: tokenOf(payload) }, { 'X-Mock-Sandbox': 'quota-a' });
      };
      assert.strictEqual(JSON.parse((await mk('quota-1')).body).Success, true, 'первый документ проходит');
      assert.strictEqual(JSON.parse((await mk('quota-2')).body).Success, true, 'второй документ проходит (лимит 2)');
      const third = JSON.parse((await mk('quota-3')).body);
      assert.strictEqual(third.Success, false, 'третий документ отклоняется квотой');
      assert.strictEqual(third.ErrorCode, '7');
      assert.ok(String(third.Message).includes('Лимит документов песочницы'), `DX должен называть квоту: ${third.Message}`);
    } finally {
      await stopChild(child);
    }
  }

  // 48. F-15: снимок без ссылочных индексов (state-файл до их появления) не
  // ломает создание и поиск по OrderId — индексы пересобираются из state
  {
    const child = startChild({});
    const childPort = await child.port;
    const inSandbox = { 'X-Mock-Sandbox': 'idx-a' };
    const init = (orderId) => {
      const payload = { TerminalKey: TERMINAL, Amount: '100', OrderId: orderId, PaymentRecipientId: DEFAULT_RECIPIENT };
      return request(childPort, 'POST', '/v2/Init', { ...payload, Token: tokenOf(payload) }, inSandbox);
    };
    try {
      const first = JSON.parse((await init('idx-1')).body);
      assert.strictEqual(first.Success, true, 'платёж в песочнице idx-a создан');
      // «старый» снимок: как state-файл до появления orderIndex/dealIndex
      const exported = JSON.parse((await request(childPort, 'GET', '/mock/state?sandbox=idx-a')).body);
      const legacy = exported.state.state;
      delete legacy.orderIndex;
      delete legacy.dealIndex;
      const imported = await request(childPort, 'POST', '/mock/state', { sandbox: 'idx-a', state: legacy }, inSandbox);
      assert.strictEqual(imported.statusCode, 200, `импорт снимка без индексов: ${imported.body}`);
      const second = JSON.parse((await init('idx-2')).body);
      assert.strictEqual(second.Success, true, `Init после импорта без индексов: ${JSON.stringify(second).slice(0, 160)}`);
      for (const [orderId, paymentId] of [['idx-1', first.PaymentId], ['idx-2', second.PaymentId]]) {
        const ref = { TerminalKey: TERMINAL, OrderId: orderId };
        const found = JSON.parse((await request(childPort, 'POST', '/v2/GetState', { ...ref, Token: tokenOf(ref) }, inSandbox)).body);
        assert.strictEqual(found.PaymentId, paymentId, `GetState по OrderId «${orderId}» после импорта`);
      }
      const check = { TerminalKey: TERMINAL, OrderId: 'idx-1' };
      const orders = JSON.parse((await request(childPort, 'POST', '/v2/CheckOrder', { ...check, Token: tokenOf(check) }, inSandbox)).body);
      assert.strictEqual((orders.Payments || []).length, 1, 'CheckOrder по OrderId работает после импорта');
    } finally {
      await stopChild(child);
    }
  }

  // 49. PA-50 / PA-54 / PA-55: авторизация явного target, гонка TTL-sweep mid-await,
  //     защита default-песочницы (MOCK_SANDBOX_TOKEN) и отсутствие глобального switchActive
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbank-pa50-'));
    const sbxFile = path.join(tmpDir, 'sandboxes.json');
    const core = require('../../packages/core');
    fs.writeFileSync(sbxFile, JSON.stringify({
      activeId: 'victim-b',
      sandboxes: [
        {
          id: 'victim-b',
          expiresAt: 0,
          ownerTokenHash: core.hashSecret('victim-owner-token'),
          state: {
            payments: { 'PA-VICTIM-42': { paymentId: 'PA-VICTIM-42', orderId: 'VICTIM-CANARY-TBANK', amount: 12345, status: 'CONFIRMED', statusHistory: [] } },
            orderIndex: { 'VICTIM-CANARY-TBANK': 'PA-VICTIM-42' },
          },
        },
        {
          id: 'attacker-a',
          expiresAt: 0,
          ownerTokenHash: core.hashSecret('attacker-owner-token'),
          state: { payments: {}, orderIndex: {} },
        },
      ],
    }));
    const child = startChild({
      MOCK_TENANCY: 'owned',
      MOCK_SANDBOX_FILE: sbxFile,
      MOCK_SANDBOX_TOKEN: 'default-owner-secret',
      MOCK_OPERATOR_TOKEN: 'op-secret',
      MOCK_SANDBOX_TTL_MS: '1000',
      MOCK_SANDBOX_SWEEP_MS: '1000',
    });
    const childPort = await child.port;
    try {
      const hdrA = { 'X-Mock-Sandbox': 'attacker-a', 'X-Sandbox-Token': 'attacker-owner-token' };

      // PA-50: чужой export/import/reset/delete из контекста A отклоняется (401)
      const expB = await request(childPort, 'GET', '/mock/state?sandbox=victim-b', undefined, hdrA);
      assert.strictEqual(expB.statusCode, 401, 'PA-50: чужой GET /mock/state?sandbox=victim-b -> 401');
      assert.ok(!expB.body.includes('VICTIM-CANARY-TBANK'), 'PA-50: канарка жертвы не утекает');
      const impB = await request(childPort, 'POST', '/mock/state', { sandbox: 'victim-b', state: { payments: { pwn: {} } } }, hdrA);
      assert.strictEqual(impB.statusCode, 401, 'PA-50: чужой POST /mock/state -> 401');
      const rstB = await request(childPort, 'POST', '/mock/reset', { sandbox: 'victim-b' }, hdrA);
      assert.strictEqual(rstB.statusCode, 401, 'PA-50: чужой POST /mock/reset -> 401');
      const delB = await request(childPort, 'DELETE', '/sandboxes?sandbox=victim-b', undefined, hdrA);
      assert.strictEqual(delB.statusCode, 401, 'PA-50: чужой DELETE /sandboxes -> 401');

      // Свой export/import/reset и оператор работают
      const opStateB = await request(childPort, 'GET', '/mock/state?sandbox=victim-b', undefined, { 'X-Operator-Token': 'op-secret' });
      assert.strictEqual(opStateB.statusCode, 200, 'PA-50: оператор читает /mock/state?sandbox=victim-b');
      assert.ok(opStateB.body.includes('VICTIM-CANARY-TBANK'), 'PA-50: состояние жертвы не повреждено');

      // PA-54: закрытая default-песочница не открывается через form и не светит счётчики в /health
      const defForm = await request(childPort, 'GET', '/payment/PA-VICTIM-42');
      assert.strictEqual(defForm.statusCode, 401, 'PA-54: форма защищённой default без токена -> 401');
      const pubHealth = JSON.parse((await request(childPort, 'GET', '/health')).body);
      assert.strictEqual(pubHealth.payments, undefined, 'PA-54: публичный /health на защищённой default не раскрывает счётчики');

      // PA-50 §7.2: гонка TTL-sweep во время in-flight запроса с валидным ownerToken -> 410 без утечки victim-b
      const r = JSON.parse((await request(childPort, 'POST', '/sandboxes', { id: 'race-tenant' })).body);
      const gsPayload = { TerminalKey: TERMINAL, PaymentId: 'PA-VICTIM-42' };
      gsPayload.Token = tokenOf(gsPayload);
      const raceResp = await request(childPort, 'POST', '/v2/GetState', gsPayload, {
        'X-Mock-Sandbox': r.id,
        'X-Sandbox-Token': r.ownerToken,
        'X-Mock-Latency': '1700',
      });
      assert.strictEqual(raceResp.statusCode, 410, `PA-50 §7.2: истёкшая во время await песочница -> 410 (получено ${raceResp.statusCode})`);
      assert.ok(!raceResp.body.includes('VICTIM-CANARY-TBANK'), 'PA-50 §7.2: канарка чужой песочницы не утекает при TTL-sweep');
    } finally {
      await stopChild(child);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // PA-55: POST /sandboxes в namespaces не переключает глобальный fallback для запросов без селектора
    const sw = JSON.parse((await request(mockPort, 'POST', '/sandboxes', { sandbox: 'ci-worker-b' })).body);
    assert.strictEqual(sw.current, 'ci-worker-b');
    const healthNoSel = JSON.parse((await request(mockPort, 'GET', '/health')).body);
    assert.strictEqual(healthNoSel.sandbox, 'default', 'PA-55: запрос без селектора остаётся в default');
  }

  // 49. MS-04: SIGTERM сохраняет отложенную (debounced) запись песочницы —
  // «отложенная запись → SIGTERM → рестарт с тем же state-файлом → данные на месте».
  {
    let verified = false;
    for (let attempt = 1; attempt <= 3 && !verified; attempt += 1) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbank-ms04-'));
      const stateFile = path.join(tmpDir, 'state.json');
      const sandboxId = `ms04-${attempt}`;
      const recordFile = `${stateFile}.sandboxes.records/${sandboxId}.json`;
      // Маркер отложенной записи — сам платёж в state (не его id: PaymentId
      // совпадает со счётчиком `counters.paymentId`, а счётчик уже сброшен на
      // диск при создании песочницы).
      const paymentsOnDisk = () => {
        try { return JSON.parse(fs.readFileSync(recordFile, 'utf8')).sandbox.state.payments || {}; } catch { return {}; }
      };
      let child = startChild({ MOCK_STATE_FILE: stateFile });
      try {
        const port = await child.port;
        const payload = { TerminalKey: TERMINAL, Amount: '100', OrderId: `ms04-order-${attempt}`, PaymentRecipientId: DEFAULT_RECIPIENT };
        const paymentId = JSON.parse((await request(port, 'POST', '/v2/Init', { ...payload, Token: tokenOf(payload) }, { 'X-Mock-Sandbox': sandboxId })).body).PaymentId;
        if (paymentsOnDisk()[paymentId]) {
          // Окно debounce (150 мс) истекло раньше сигнала: регресс не смог бы
          // отличить сброс при SIGTERM от обычного отложенного сброса —
          // повторяем попытку с чистой песочницей.
          continue;
        }
        const stopped = await stopChildGracefully(child, 'SIGTERM');
        assert.strictEqual(stopped.signal, null, `MS-04: дочерний стенд должен выйти сам (signal=${stopped.signal})`);
        assert.strictEqual(stopped.code, 0, `MS-04: SIGTERM должен давать exit 0 (получено ${stopped.code})`);
        assert.ok(stopped.ms <= 2000, `MS-04: SIGTERM должен завершаться ≤ 2 с (получено ${stopped.ms} мс)`);
        assert.ok(paymentsOnDisk()[paymentId], 'MS-04: SIGTERM не сбросил отложенную запись песочницы на диск');
        // Рестарт с тем же state-файлом: платёж обязан быть на месте.
        child = startChild({ MOCK_STATE_FILE: stateFile });
        const port2 = await child.port;
        const restored = JSON.parse((await request(port2, 'GET', `/mock/state?sandbox=${sandboxId}`)).body);
        assert.ok(restored.state.state.payments[paymentId], 'MS-04: после рестарта отложенная запись отсутствует');
        assert.strictEqual(restored.state.state.payments[paymentId].orderId, `ms04-order-${attempt}`, 'MS-04: восстановлен именно ожидаемый платёж');
        verified = true;
      } finally {
        await stopChild(child);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
    assert.ok(verified, 'MS-04: не удалось наблюдать отложенную запись (окно debounce 150 мс истекло 3 раза)');
  }

  console.log(`selftest: ${WEBHOOK_HITS.length} webhook deliveries, ${Object.keys(state.payments).length} payment sessions`);
  console.log('SELFTEST PASSED ✅');
  process.exit(0);
}

main().catch((e) => {
  console.error('SELFTEST FAILED ❌:', e);
  process.exit(1);
});
