'use strict';

/*
 * Self-test for the T-Bank multisplit mock stand (wave 1).
 * Runs the server on an ephemeral port with a fake merchant webhook
 * receiver and drives every scenario end-to-end. Zero dependencies.
 *
 *   node tbank-mock/selftest.js
 */

const http = require('http');
const assert = require('assert');

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

const api = (port, method, body, sign = true) =>
  request(port, 'POST', `/v2/${method}`, sign ? { ...body, Token: tokenOf(body) } : body);

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
  process.env.MOCK_RETRY_MS = '1000';
  const webhook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
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

  // 1. Init without token under strict mode -> rejected
  const noTok = await request(mockPort, 'POST', '/v2/Init', { TerminalKey: TERMINAL, Amount: '1000', OrderId: 'o-1' });
  assert.strictEqual(JSON.parse(noTok.body).ErrorCode, '13', 'missing token must be rejected');

  // 2. Init with wrong token -> ErrorCode 13
  const badTok = await api(mockPort, 'Init', { Amount: '1000', OrderId: 'o-1' }, false);
  assert.strictEqual(JSON.parse(badTok.body).ErrorCode, '13', 'wrong token must be rejected');

  // 3. Multisplit Init without DealId/CreateDealWithType -> rejected
  const noDeal = await api(mockPort, 'Init', { Amount: '1000', OrderId: 'o-1', PaymentRecipientId: '+79001234567' });
  assert.strictEqual(JSON.parse(noDeal.body).ErrorCode, '7', 'recipient without deal must be rejected');

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

  console.log(`selftest: ${WEBHOOK_HITS.length} webhook deliveries, ${Object.keys(state.payments).length} payment sessions`);
  console.log('SELFTEST PASSED ✅');
  process.exit(0);
}

main().catch((e) => {
  console.error('SELFTEST FAILED ❌:', e);
  process.exit(1);
});
