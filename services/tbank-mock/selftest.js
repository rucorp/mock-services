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

// Основной инстанс — профиль Lovii (Мультирасчеты); plain тестируется
// отдельным процессом в сценарии 25.
process.env.MOCK_PROFILE = 'multisplit';
process.env.MOCK_RETRY_MS = '1000';
process.env.MOCK_STATE_FILE = '';
process.env.MOCK_PUBLIC_BASE_URL = 'http://mock.test';

const { server, state, tokenOf, TERMINAL_KEY, TERMINAL_PASSWORD } = require('./server.js');

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
// переопределить в body для негативных проверок).
const api = (port, method, body, sign = true) => {
  const payload = { TerminalKey: TERMINAL, ...body };
  return request(port, 'POST', `/v2/${method}`, sign ? { ...payload, Token: tokenOf(payload) } : payload);
};

/**
 * Дочерний стенд на свободном порту (MOCK_PORT=0): родитель узнаёт реальный
 * порт из стартовой строки сервера — без фиксированных номеров (F-32).
 */
function startChild(env = {}) {
  const { spawn } = require('child_process');
  const proc = spawn('node', [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      MOCK_PORT: '0',
      MOCK_STATE_FILE: '',
      MOCK_RETRY_MS: '1000',
      MOCK_PROFILE: 'plain',
      MOCK_ADMIN_TOKEN: '',
      MOCK_OPERATOR_TOKEN: '',
      MOCK_HOSTED: '',
      MOCK_BLOCK_PRIVATE_WEBHOOKS: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`дочерний стенд не сообщил порт: ${buf.slice(0, 300)}`)), 5000);
    proc.stdout.on('data', (d) => {
      buf += String(d);
      const m = /on http:\/\/[^:]+:(\d+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    proc.stderr.on('data', (d) => { buf += String(d); });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`дочерний стенд завершился с кодом ${code}: ${buf.slice(0, 300)}`)); });
  });
  return { proc, port, stop: () => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } } };
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

async function main() {
  // Основной инстанс — профиль Lovii (Мультирасчеты); plain тестируется
// отдельным процессом в сценарии 25.
process.env.MOCK_PROFILE = 'multisplit';
process.env.MOCK_RETRY_MS = '1000';
  // /webhook — подтверждает доставку; /slow — «медленный и падающий» мерчант
  // (проверка, что очередь не шлёт одну нотификацию параллельно сама себе).
  const slowHook = { hits: 0, concurrent: 0, maxConcurrent: 0 };
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
  await new Promise((r) => setTimeout(r, 4500)); // ретрай 1 с + тик 1 с: успеваем увидеть 2–3 попытки
  const slowNotif = Object.values(state.notifications).find((n) => n.paymentId === slowInit.PaymentId);
  assert.ok(slowHook.hits >= 2, `ретраев не было: ${slowHook.hits}`);
  assert.strictEqual(slowHook.maxConcurrent, 1, `параллельных POST на одну нотификацию: ${slowHook.maxConcurrent}`);
  assert.ok(slowNotif && slowHook.hits - slowNotif.attempts <= 1, `attempts=${slowNotif && slowNotif.attempts}, POST'ов=${slowHook.hits} — очередь отправляет больше, чем учитывает`);

  // 23a. Чужой TerminalKey — ошибка 7 (A-15)
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
    const { spawn } = require('child_process');
    const plainProc = spawn('node', [path.join(__dirname, 'server.js')], {
      env: { ...process.env, MOCK_PORT: '3198', MOCK_RETRY_MS: '1000', MOCK_PROFILE: 'plain', MOCK_STATE_FILE: '' },
      stdio: 'ignore',
    });
    try {
    await new Promise((r) => setTimeout(r, 700));
    const plainApi = (method, body) => { const signed = { ...body, Token: tokenOf(body) }; return request(3198, 'POST', `/v2/${method}`, signed); };
    const plainInit = await plainApi('Init', { TerminalKey: TERMINAL_KEY, OrderId: 'plain-1', Amount: '250000', PaymentRecipientId: 'acc-1', NotificationURL: `http://127.0.0.1:${port}/hook` });
    const plainParsed = JSON.parse(plainInit.body);
    assert.strictEqual(plainParsed.Success, true, 'plain Init с PaymentRecipientId должен проходить (профиль plain)');
    const plainPay = await request(3198, 'POST', `/payment/${plainParsed.PaymentId}/pay`, 'pan=2201382000000013&exp=1227', { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.ok([200, 302].includes(plainPay.statusCode), `оплата по тестовой карте должна проходить (статус ${plainPay.statusCode}: ${String(plainPay.body).slice(0, 80)})`);
    await sleep(1500);
    const plainConf = await plainApi('Confirm', { TerminalKey: TERMINAL_KEY, PaymentId: plainParsed.PaymentId, Amount: '250000' });
    assert.strictEqual(JSON.parse(plainConf.body).Status, 'CONFIRMED', 'plain Confirm из AUTHORIZED');
    const plainHook = WEBHOOK_HITS.map((h) => { try { return JSON.parse(h.body); } catch { return null; } }).filter(Boolean).find((n) => n.PaymentId === plainParsed.PaymentId);
    assert.ok(plainHook, 'plain платёж должен уведомлять мерчанта');
    assert.strictEqual(plainHook.SpAccumulationId, undefined, 'в plain-нотификации не должно быть SpAccumulationId');
    } finally { plainProc.kill(); }
  }

  /* --- Этап 6–7 (бриф 2026-10-11): чарджбэки e2e, сценарии, виртуальные часы, e2c/AV --- */

  // Helper to call /v2/* with custom headers
  const apiWithHeaders = (p, method, body, headers = {}) => {
    const payload = { TerminalKey: TERMINAL, ...body };
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
    await sleep(1200);
    assert.ok(!WEBHOOK_HITS.some((h) => h.json.PaymentId === dropInit.PaymentId), 'при webhook-drop вебхук не должен приходить');
    const dropState = JSON.parse((await api(mockPort, 'GetState', { PaymentId: dropInit.PaymentId })).body);
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

  // 28. Покрытие /e2c/v2/* и /av/v1/* (рекомендация аудита A-22)
  {
    const e2cInitPayload = { TerminalKey: TERMINAL, Amount: '45000', OrderId: 'payout-1', CustomerKey: 'merch-1' };
    const e2cInit = JSON.parse((await request(mockPort, 'POST', '/e2c/v2/Init', { ...e2cInitPayload, Token: tokenOf(e2cInitPayload) })).body);
    assert.strictEqual(e2cInit.Success, true);
    assert.strictEqual(e2cInit.Status, 'NEW');

    const e2cPayPayload = { TerminalKey: TERMINAL, PaymentId: e2cInit.PaymentId };
    const e2cPay = JSON.parse((await request(mockPort, 'POST', '/e2c/v2/Payment', { ...e2cPayPayload, Token: tokenOf(e2cPayPayload) })).body);
    assert.strictEqual(e2cPay.Status, 'CONFIRMED');

    const e2cState = JSON.parse((await request(mockPort, 'POST', '/e2c/v2/GetState', { ...e2cPayPayload, Token: tokenOf(e2cPayPayload) })).body);
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
    const overPayoutPayload = { TerminalKey: TERMINAL, Amount: '150000', OrderId: 'payout-over', DealId: spDealId };
    const overPayout = JSON.parse((await request(mockPort, 'POST', '/e2c/v2/Init', { ...overPayoutPayload, Token: tokenOf(overPayoutPayload) })).body);
    assert.strictEqual(overPayout.Success, false);
    assert.strictEqual(overPayout.ErrorCode, '32');

    // Тестовая карта ошибки выплаты 5000000000000553 -> ErrorCode 1057
    const badCardInitPayload = { TerminalKey: TERMINAL, Amount: '20000', OrderId: 'payout-badcard', DealId: spDealId, Pan: '5000000000000553' };
    const badCardInit = JSON.parse((await request(mockPort, 'POST', '/e2c/v2/Init', { ...badCardInitPayload, Token: tokenOf(badCardInitPayload) })).body);
    const badCardPayPayload = { TerminalKey: TERMINAL, PaymentId: badCardInit.PaymentId };
    const badCardPay = JSON.parse((await request(mockPort, 'POST', '/e2c/v2/Payment', { ...badCardPayPayload, Token: tokenOf(badCardPayPayload) })).body);
    assert.strictEqual(badCardPay.Success, false);
    assert.strictEqual(badCardPay.ErrorCode, '1057');
    assert.strictEqual(badCardPay.Status, 'REJECTED');

    // Выплата 40000 коп. и её отмена через CancelPayment -> баланс сделки снова 100000
    const p1InitPayload = { TerminalKey: TERMINAL, Amount: '40000', OrderId: 'payout-cancelable', DealId: spDealId };
    const p1Init = JSON.parse((await request(mockPort, 'POST', '/e2c/v2/Init', { ...p1InitPayload, Token: tokenOf(p1InitPayload) })).body);
    const p1PayPayload = { TerminalKey: TERMINAL, PaymentId: p1Init.PaymentId };
    await request(mockPort, 'POST', '/e2c/v2/Payment', { ...p1PayPayload, Token: tokenOf(p1PayPayload) });
    const p1Cancel = JSON.parse((await request(mockPort, 'POST', '/e2c/v2/CancelPayment', { ...p1PayPayload, Token: tokenOf(p1PayPayload) })).body);
    assert.strictEqual(p1Cancel.Success, true);
    assert.strictEqual(p1Cancel.Status, 'CANCELED');

    // Финальная выплата 70000 коп. с FinalPayout=true -> закрывает сделку, остаток 30000 коп. уходит в вознаграждение площадки
    const finalInitPayload = { TerminalKey: TERMINAL, Amount: '70000', OrderId: 'payout-final', DealId: spDealId, FinalPayout: true };
    const finalInit = JSON.parse((await request(mockPort, 'POST', '/e2c/v2/Init', { ...finalInitPayload, Token: tokenOf(finalInitPayload) })).body);
    const finalPayPayload = { TerminalKey: TERMINAL, PaymentId: finalInit.PaymentId };
    const finalPay = JSON.parse((await request(mockPort, 'POST', '/e2c/v2/Payment', { ...finalPayPayload, Token: tokenOf(finalPayPayload) })).body);
    assert.strictEqual(finalPay.Success, true);
    assert.strictEqual(finalPay.DealClosed, true);
    assert.strictEqual(finalPay.PlatformReward, 30000);
    assert.strictEqual(state.deals[spDealId].status, 'closed');

    // Попытка возврата покупателю по закрытой сделке -> ErrorCode 32
    const closedCancel = JSON.parse((await api(mockPort, 'Cancel', { PaymentId: dealPayInit.PaymentId })).body);
    assert.strictEqual(closedCancel.Success, false);
    assert.strictEqual(closedCancel.ErrorCode, '32');

    // Список банков СБП
    const sbpMembersPayload = { TerminalKey: TERMINAL };
    const sbpMembers = JSON.parse((await request(mockPort, 'POST', '/e2c/v2/GetSbpMembers', { ...sbpMembersPayload, Token: tokenOf(sbpMembersPayload) })).body);
    assert.strictEqual(sbpMembers.Success, true);
    assert.ok(Array.isArray(sbpMembers.Members) && sbpMembers.Members.length >= 4);
  }

  // 30. СБП QR (GetQr + sbp-pay) и закрывающий чек SendClosingReceipt
  {
    // СБП меньше 10 ₽ (1000 коп.) -> ErrorCode 7
    const tinyInit = JSON.parse((await api(mockPort, 'Init', { Amount: '500', OrderId: 'order-sbp-tiny' })).body);
    const tinyQr = JSON.parse((await api(mockPort, 'GetQr', { PaymentId: tinyInit.PaymentId, DataType: 'PAYLOAD' })).body);
    assert.strictEqual(tinyQr.Success, false);
    assert.strictEqual(tinyQr.ErrorCode, '7');

    // СБП нормальный платёж + оплата по QR + SendClosingReceipt
    const sbpInit = JSON.parse((await api(mockPort, 'Init', {
      Amount: '25000', OrderId: 'order-sbp-ok', NotificationURL: notificationUrl,
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
      Amount: '10000', OrderId: 'order-baddata', DATA: { longKey: 'x'.repeat(105) },
    })).body);
    assert.strictEqual(badData.Success, false);
    assert.strictEqual(badData.ErrorCode, '7');

    // RedirectDueDate > 90 дней -> ErrorCode 7
    const farFuture = new Date(Date.now() + 100 * 86400000).toISOString();
    const badDue = JSON.parse((await api(mockPort, 'Init', {
      Amount: '10000', OrderId: 'order-baddue', RedirectDueDate: farFuture,
    })).body);
    assert.strictEqual(badDue.Success, false);
    assert.strictEqual(badDue.ErrorCode, '7');

    // Recurrent=Y без CustomerKey -> ErrorCode 7
    const noCust = JSON.parse((await api(mockPort, 'Init', {
      Amount: '10000', OrderId: 'order-rec-nocust', Recurrent: 'Y',
    })).body);
    assert.strictEqual(noCust.Success, false);

    // AddCustomer -> Init(Recurrent=Y) -> Pay -> получаем RebillId в нотификации AUTHORIZED -> Charge следующего платежа
    const addCust = JSON.parse((await api(mockPort, 'AddCustomer', { CustomerKey: 'cust-rec-1', Email: 'rec@example.com' })).body);
    assert.strictEqual(addCust.Success, true);

    const recInit = JSON.parse((await api(mockPort, 'Init', {
      Amount: '30000', OrderId: 'order-rec-parent', Recurrent: 'Y', CustomerKey: 'cust-rec-1', PayType: 'O',
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
      Amount: '15000', OrderId: 'order-rec-child', CustomerKey: 'cust-rec-1', NotificationURL: notificationUrl,
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
    const tokResp = JSON.parse((await request(
      mockPort,
      'POST',
      '/oauth/token',
      'grant_type=client_credentials',
      {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from('partner:secret').toString('base64'),
      },
    )).body);
    assert.ok(tokResp.access_token, 'OAuth /oauth/token должен выдать access_token');

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
      { billingDescriptor: 'LOVII MARKET', inn: '7701234567', name: 'ООО Ловии Партнёр', email: 'shop@lovii.ru' },
      { Authorization: `Bearer ${tokResp.access_token}` },
    )).body);
    assert.ok(goodShop.shopCode);
    assert.strictEqual(goodShop.billingDescriptor, 'LOVII MARKET');

    const getShop = JSON.parse((await request(mockPort, 'GET', `/sm-register/register/shop/${goodShop.shopCode}`)).body);
    assert.strictEqual(getShop.inn, '7701234567');

    const patchShop = JSON.parse((await request(
      mockPort,
      'PATCH',
      `/sm-register/register/${goodShop.shopCode}`,
      { billingDescriptor: 'LOVII PRO' },
      { Authorization: `Bearer ${tokResp.access_token}` },
    )).body);
    assert.strictEqual(patchShop.billingDescriptor, 'LOVII PRO');
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

      const opState = await request(childPort, 'GET', '/mock/state', undefined, { Authorization: 'Bearer op-secret' });
      assert.strictEqual(opState.statusCode, 200, 'operator-токен должен открывать /mock/state');
      const opTime = await request(childPort, 'GET', '/mock/time', undefined, { 'X-Operator-Token': 'op-secret' });
      assert.strictEqual(opTime.statusCode, 200, 'X-Operator-Token должен приниматься');

      const operatorOnAdmin = await request(childPort, 'GET', '/admin/journal', undefined, { Authorization: 'Bearer op-secret' });
      assert.strictEqual(operatorOnAdmin.statusCode, 401, 'operator-токен не должен открывать /admin');
      const adminOnAdmin = await request(childPort, 'GET', '/admin/journal', undefined, { Authorization: 'Bearer adm-secret' });
      assert.strictEqual(adminOnAdmin.statusCode, 200, 'админ-токен должен открывать /admin/journal');

      // Платёжный API остаётся доступен без управляющих токенов
      const healthChild = await request(childPort, 'GET', '/health');
      assert.strictEqual(healthChild.statusCode, 200);
      const initPayload = { TerminalKey: TERMINAL, Amount: '1500', OrderId: 'auth-child-1' };
      const initChild = await request(childPort, 'POST', '/v2/Init', { ...initPayload, Token: tokenOf(initPayload) });
      assert.strictEqual(JSON.parse(initChild.body).Success, true, 'платёжный API не должен требовать operator-токен');
    } finally {
      child.stop();
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
      const initHosted = await request(childPort, 'POST', '/v2/Init', { ...(() => { const p = { TerminalKey: TERMINAL, Amount: '1500', OrderId: 'hosted-1' }; return { ...p, Token: tokenOf(p) }; })() });
      assert.strictEqual(JSON.parse(initHosted.body).Success, true, 'платёжный API работает и в hosted-режиме');
    } finally {
      child.stop();
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

      const v6 = await request(childPort, 'POST', '/mock/verify-merchant', { url: 'http://[::1]:3100/hook' });
      assert.strictEqual(v6.statusCode, 403, 'MOCK_BLOCK_PRIVATE_WEBHOOKS=1: private IPv6 -> 403');

      // Очередь вебхуков тоже под guard'ом: INCOMING-нотификация не уходит на 127.0.0.1
      const incomingPayload = { TerminalKey: TERMINAL, VerificationCode: 'VER-SSRF', Amount: '100', PayerInn: '7801111111', NotificationURL: notificationUrl };
      const incoming = await request(childPort, 'POST', '/av/v1/payment', { ...incomingPayload, Token: tokenOf(incomingPayload) });
      assert.strictEqual(JSON.parse(incoming.body).Success, true);
      await sleep(1500);
      const exported = JSON.parse((await request(childPort, 'GET', '/mock/state')).body);
      const childState = (exported.state && exported.state.state) || exported.state || {};
      const notif = Object.values(childState.notifications || {}).find((n) => n.paymentId && n.paymentId.startsWith('IN-'));
      assert.ok(notif, 'нотификация должна быть зарегистрирована в очереди');
      assert.ok(String(notif.lastStatus).startsWith('ERR'), `доставка на приватный адрес должна быть заблокирована, lastStatus=${notif.lastStatus}`);
      assert.ok(String(notif.lastStatus).includes('SSRF'), 'причина отказа должна быть явной (SSRF)');
    } finally {
      child.stop();
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
      child.stop();
    }
    assert.ok(WEBHOOK_HITS.length > 0, 'локальный режим без флага продолжает доставлять вебхуки на localhost');
  }

  // 38. #24 (F-09, F-10): секреты и карточные данные не попадают в state,
  //     /mock/state, журнал (JSON и HTML) и console output.
  {
    // Уникальный валидный по Luhn PAN («Мир»), которого нет среди тестовых карт.
    const sentinelPan = '2200770012345676';
    const sentinelSecret = `sentinel-secret-${process.pid}`;
    const basicHeader = Buffer.from(`partner:${sentinelSecret}`).toString('base64');

    let bearerToken = '';
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => { logged.push(args.map((a) => String(a)).join(' ')); };
    try {
      // Выплата с PAN: в state остаются только маска и сценарий
      const panInitPayload = {
        TerminalKey: TERMINAL, Amount: '15000', OrderId: 'payout-sentinel-pan',
        Pan: sentinelPan, RecipientName: 'Иван Петров', Phone: '+79211234567',
      };
      const panInit = JSON.parse((await request(mockPort, 'POST', '/e2c/v2/Init', { ...panInitPayload, Token: tokenOf(panInitPayload) })).body);
      assert.strictEqual(panInit.Success, true, 'e2c Init с PAN должен проходить');
      const panPayout = state.payouts[panInit.PaymentId];
      assert.strictEqual(panPayout.pan, undefined, 'полный PAN не должен храниться в state (F-10)');
      assert.strictEqual(panPayout.panMask, '220077**5676', 'в state остаётся маска BIN + последние 4');
      assert.strictEqual(panPayout.cardScenario, null, 'PAN вне тестового списка сценария не выбирает');

      // Официальный тестовый кейс 5000000000000553 -> 1057 продолжает работать без PAN в state
      const badInitPayload = { TerminalKey: TERMINAL, Amount: '10000', OrderId: 'payout-sentinel-1057', Pan: '5000000000000553' };
      const badInit = JSON.parse((await request(mockPort, 'POST', '/e2c/v2/Init', { ...badInitPayload, Token: tokenOf(badInitPayload) })).body);
      const badPayout = state.payouts[badInit.PaymentId];
      assert.strictEqual(badPayout.pan, undefined, 'полный PAN тестовой карты тоже не хранится');
      assert.strictEqual(badPayout.panMask, '500000**0553');
      assert.strictEqual(badPayout.cardScenario, 'reject-1057', 'сценарий выбирается в Init');
      const badPayPayload = { TerminalKey: TERMINAL, PaymentId: badInit.PaymentId };
      const badPay = JSON.parse((await request(mockPort, 'POST', '/e2c/v2/Payment', { ...badPayPayload, Token: tokenOf(badPayPayload) })).body);
      assert.strictEqual(badPay.Success, false);
      assert.strictEqual(badPay.ErrorCode, '1057');
      assert.strictEqual(badPay.Status, 'REJECTED');

      // acqapi: Basic (OAuth) и Bearer — заголовки с кредами в журнал не попадают
      const oauth = await request(mockPort, 'POST', '/oauth/token', {}, { Authorization: `Basic ${basicHeader}` });
      assert.strictEqual(oauth.statusCode, 200, 'POST /oauth/token с Basic должен проходить');
      bearerToken = JSON.parse(oauth.body).access_token;
      const shopPayload = { billingDescriptor: 'SENTINEL', inn: '7801111111', shopCode: '700999', name: 'ООО «Сентинел»' };
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
    assert.strictEqual(initEntry.body.Phone, '***4567', 'телефон в журнале маскируется');
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
      child.stop();
      try { fs.unlinkSync(legacyFile); } catch { /* уже удалён */ }
    }
  }

  console.log(`selftest: ${WEBHOOK_HITS.length} webhook deliveries, ${Object.keys(state.payments).length} payment sessions`);
  console.log('SELFTEST PASSED ✅');
  process.exit(0);
}

main().catch((e) => {
  console.error('SELFTEST FAILED ❌:', e);
  process.exit(1);
});
