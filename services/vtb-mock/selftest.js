// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Selftest ВТБ SMB E-commerce API mock (issue #87, Stage 2).
 * Покрывает OAuth client_credentials (выдача/истечение/обновление токена на
 * виртуальных часах), заголовки Authorization/X-IBM-Client-Id, POST /orders с
 * десятичными рублями и идемпотентным orderId, hosted payUrl с [FORK]-картами,
 * preauth→complete (≤ авторизации), cancel, /refunds (полный/частичный, дубль
 * refundId), status.value ордер/операция, callbacks PAYMENT|REFUND без
 * нормализации (Status/status), GET-сверку после callback, TTL 20 минут,
 * retry/drop/duplicate, SSRF-терминальность, сценарии/журнал per-sandbox,
 * env-парсеры и hosted control-plane.
 * Запуск: node services/vtb-mock/selftest.js
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const CREDS = { clientId: 'vtbmocktest', clientSecret: 'mockpass123' };
const CARD_SUCCESS = { pan: '4242424242424242', exp: '1234', cvv: '123' };
const CARD_DECLINE = { pan: '4000000000000002', exp: '1234', cvv: '123' };
const CARD_EXPIRED = { pan: '4000000000000069', exp: '0120', cvv: '123' };
const REST_PATH = '/openapi/smb/efcp/e-commerce/v1';
const TOKEN_PATH = '/passport/oauth2/token';

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
    MOCK_VTB_CLIENT_ID: '',
    MOCK_VTB_CLIENT_SECRET: '',
    MOCK_VTB_PUBLIC_BASE_URL: '',
    MOCK_VTB_CALLBACK_URL: '',
    MOCK_VTB_CALLBACK_RETRY_MS: '60s',
    MOCK_VTB_CALLBACK_MAX_ATTEMPTS: '3',
    MOCK_VTB_TOKEN_TTL_SECS: '170',
    MOCK_VTB_ORDER_TTL_SECS: '1200',
    MOCK_VTB_PREAUTH: 'true',
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
      if (proc.exitCode !== null) return reject(new Error(`VTB mock exited early: ${output}`));
      const waiter = { pattern: /on http:\/\/[^:\s]+:\d+/, resolve: () => resolve(Number(output.match(/on http:\/\/[^:\s]+:(\d+)/)[1])), reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = outputWaiters.indexOf(waiter);
        if (index >= 0) outputWaiters.splice(index, 1);
        reject(new Error(`VTB mock did not start: ${output}`));
      }, 8000);
      outputWaiters.push(waiter);
    };
    proc.once('exit', (code) => { if (code !== null && code !== 0) reject(new Error(`VTB mock exited ${code}: ${output}`)); });
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

const formBody = (data) => new URLSearchParams(data).toString();
const orderId = (prefix = 'vtb') => `${prefix}-${Date.now().toString(36)}-${++sequence}`;

function getToken(port, { clientId = CREDS.clientId, clientSecret = CREDS.clientSecret, grantType = 'client_credentials' } = {}) {
  return request(port, 'POST', TOKEN_PATH, formBody({
    grant_type: grantType,
    client_id: clientId,
    client_secret: clientSecret,
  }));
}

function api(port, method, relPath, token, fields = null, headers = {}) {
  const auth = {
    'Authorization': `Bearer ${token}`,
    'X-IBM-Client-Id': CREDS.clientId,
  };
  if (headers.clientId !== undefined) auth['X-IBM-Client-Id'] = headers.clientId;
  const { clientId: _drop, ...restHeaders } = headers;
  return request(port, method, `${REST_PATH}/${relPath}`, fields, { ...auth, ...restHeaders });
}

function payForm(port, orderIdValue, card = CARD_SUCCESS, headers = {}) {
  return request(port, 'POST', `/pay/${encodeURIComponent(orderIdValue)}/pay`, formBody(card), headers);
}

function checkProviderError(name, response, error, statusCode) {
  const body = response.json() || {};
  check(`${name}: provider-shaped error (HTTP ${statusCode}, error=${error}, error_description + DX)`,
    response.statusCode === statusCode && body.error === error
    && typeof body.error_description === 'string' && body.error_description.length > 0
    && typeof body.hint === 'string' && body.hint.length > 0,
    `${response.statusCode} ${response.body.slice(0, 220)}`);
  return body;
}

async function callbacksFor(port, targetOrderId, headers = {}) {
  const snapshot = (await request(port, 'GET', '/mock/state', null, headers)).json() || {};
  const inner = snapshot.state || {};
  return Object.values(inner.callbacks || {}).filter((entry) => entry.orderId === targetOrderId);
}

async function main() {
  const receiverPort = await listen(callbackReceiver);
  const origin = `http://127.0.0.1:${receiverPort}`;
  const hookUrl = `${origin}/hook`;
  const children = [];
  try {
    const primary = startChild({ MOCK_VTB_CALLBACK_URL: hookUrl });
    children.push(primary);
    const port = await primary.port;
    console.log(`\n== vtb-mock selftest on :${port} (SMB E-commerce API) ==\n`);

    console.log('— health, OpenAPI, синтетические креды');
    const health = await request(port, 'GET', '/health');
    const healthJson = health.json() || {};
    check('health: 200 ok, api smb-ecommerce-json, base /openapi/smb/efcp/e-commerce/v1/', health.statusCode === 200 && healthJson.ok === true && healthJson.api === 'smb-ecommerce-json' && healthJson.base === '/openapi/smb/efcp/e-commerce/v1/');
    check('health: token TTL 170с, order TTL 1200с, callback POST без подписи', healthJson.tokenTtlSecs === 170 && healthJson.orderTtlSecs === 1200 && healthJson.callbackMethod === 'POST' && healthJson.callbackSignature === 'none');
    const openapi = (await request(port, 'GET', '/openapi.json')).json() || {};
    check('openapi.json: 3.1.0 с orders и refunds', openapi.openapi === '3.1.0' && Boolean(openapi.paths && openapi.paths[`${REST_PATH}/orders`]) && Boolean(openapi.paths[`${REST_PATH}/refunds`]));

    console.log('— OAuth2 client_credentials: выдача, отказы, истечение и обновление');
    const tokenRes = await getToken(port);
    const tokenJson = tokenRes.json() || {};
    check('token: access_token + Bearer + expires_in=170', tokenRes.statusCode === 200 && typeof tokenJson.access_token === 'string' && tokenJson.access_token.length >= 32 && tokenJson.token_type === 'Bearer' && tokenJson.expires_in === 170);
    let token = tokenJson.access_token;
    checkProviderError('token: неверный client_secret', await getToken(port, { clientSecret: 'wrong' }), 'invalid_client', 401);
    checkProviderError('token: не client_credentials grant', await getToken(port, { grantType: 'password' }), 'unsupported_grant_type', 400);
    const tokenForm = await request(port, 'POST', TOKEN_PATH, JSON.stringify({ grant_type: 'client_credentials' }), { 'Content-Type': 'application/json' });
    check('token: JSON вместо form-urlencoded → 415', tokenForm.statusCode === 415);

    console.log('— бизнес-заголовки: Bearer и X-IBM-Client-Id (lowercase, без @ext.vtb.ru)');
    checkProviderError('без Bearer',
      await request(port, 'POST', `${REST_PATH}/orders`, { orderId: orderId('nb'), orderName: 'x', amount: { value: 1, code: 'RUB' } }, { 'X-IBM-Client-Id': CREDS.clientId }),
      'invalid_token', 401);
    checkProviderError('неизвестный Bearer',
      await api(port, 'POST', 'orders', 'deadbeef', { orderId: orderId('bb'), orderName: 'x', amount: { value: 1, code: 'RUB' } }),
      'invalid_token', 401);
    checkProviderError('без X-IBM-Client-Id',
      await request(port, 'POST', `${REST_PATH}/orders`, { orderId: orderId('nc'), orderName: 'x', amount: { value: 1, code: 'RUB' } }, { 'Authorization': `Bearer ${token}` }),
      'invalid_client', 401);
    checkProviderError('X-IBM-Client-Id с @ext.vtb.ru/uppercase отклонён',
      await api(port, 'POST', 'orders', token, { orderId: orderId('sc'), orderName: 'x', amount: { value: 1, code: 'RUB' } }, { clientId: 'VTBMOCKTEST@ext.vtb.ru' }),
      'invalid_client', 401);

    console.log('— POST /orders: десятичные рубли, payUrl, идемпотентный orderId');
    const orderA = orderId('ord-a');
    const createRes = await api(port, 'POST', 'orders', token, {
      orderId: orderA,
      orderName: 'Заказ A',
      amount: { value: 10.56, code: 'RUB' },
      description: 'decimal rubles',
      returnUrl: `${origin}/return`,
    });
    const created = createRes.json() || {};
    check('orders: 200, status.value=CREATED, amount.value=10.56 (десятичные рубли, не копейки)',
      createRes.statusCode === 200 && created.status && created.status.value === 'CREATED' && created.amount && created.amount.value === 10.56 && created.amount.code === 'RUB', createRes.body.slice(0, 200));
    check('orders: payUrl ведёт на /pay/{orderId}', typeof created.payUrl === 'string' && created.payUrl.includes(`/pay/${orderA}`));
    check('orders: expire с tz/мс (ISO)', typeof created.expire === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|[+-]\d{2}:\d{2})$/.test(created.expire));
    const replayRes = await api(port, 'POST', 'orders', token, { orderId: orderA, orderName: 'Другое имя', amount: { value: 99, code: 'RUB' } });
    const replayed = replayRes.json() || {};
    check('orders: повтор orderId идемпотентен — тот же ордер, X-Mock-Replayed, не второй',
      replayRes.statusCode === 200 && replayed.orderId === orderA && replayed.amount.value === 10.56 && replayRes.headers['x-mock-replayed'] === '1');
    for (const [name, amountValue] of [
      ['дробь >2 знаков', 10.567],
      ['отрицательная сумма', -1],
      ['ноль', 0],
      ['строка с запятой', '10,56'],
      ['exp-строка', '1e2'],
    ]) {
      checkProviderError(`amount.value ${name} → invalid_amount`,
        await api(port, 'POST', 'orders', token, { orderId: orderId('bad'), orderName: 'x', amount: { value: amountValue, code: 'RUB' } }),
        'invalid_amount', 400);
    }
    checkProviderError('amount.code USD отклонён (только RUB)',
      await api(port, 'POST', 'orders', token, { orderId: orderId('usd'), orderName: 'x', amount: { value: 1, code: 'USD' } }),
      'invalid_amount', 400);
    const getRes = await api(port, 'GET', `orders/${orderA}`, token);
    const getJson = getRes.json() || {};
    check('GET /orders/{orderId}: status.value ордера на своём уровне, payments[]/refunds[]',
      getRes.statusCode === 200 && getJson.status && getJson.status.value === 'CREATED' && Array.isArray(getJson.payments) && Array.isArray(getJson.refunds));
    checkProviderError('неизвестный orderId', await api(port, 'GET', 'orders/no-such-order', token), 'order_not_found', 404);

    console.log('— happy-path: payUrl → PAID → PAYMENT callback (Status) → GET-сверка');
    const payRes = await payForm(port, orderA, CARD_SUCCESS);
    check('payUrl: синтетическая [FORK]-карта → 302 returnUrl', payRes.statusCode === 302 && payRes.headers.location === `${origin}/return`);
    const paidOrder = (await api(port, 'GET', `orders/${orderA}`, token)).json() || {};
    check('после оплаты: order.status.value=PAID, payment.status.value=CONFIRMED (не смешиваются)',
      paidOrder.status.value === 'PAID' && paidOrder.payments.length === 1 && paidOrder.payments[0].status.value === 'CONFIRMED');
    const paymentId = paidOrder.payments[0].paymentId;
    const payCallback = await waitForCallback((hit) => hit.json && hit.json.type === 'PAYMENT' && hit.json.object && hit.json.object.orderId === orderA);
    check('PAYMENT callback: оболочка {"type":"PAYMENT","object":{...}}, POST JSON',
      payCallback.method === 'POST' && String(payCallback.contentType).includes('application/json'));
    check('PAYMENT callback: ключ статуса Status (заглавная) сохранён без нормализации',
      Object.prototype.hasOwnProperty.call(payCallback.json.object, 'Status') && !Object.prototype.hasOwnProperty.call(payCallback.json.object, 'status') && payCallback.json.object.Status.value === 'CONFIRMED', payCallback.raw.slice(0, 300));
    check('PAYMENT callback: amount.value десятичные рубли, paymentId/orderId на месте',
      payCallback.json.object.amount.value === 10.56 && payCallback.json.object.paymentId === paymentId && payCallback.json.object.orderId === orderA);
    const afterCallback = (await api(port, 'GET', `orders/${orderA}`, token)).json() || {};
    check('GET-сверка после callback: уведомление — не единственный источник истины', afterCallback.status.value === 'PAID');

    console.log('— refunds: частичный и полный, REFUND callback (status), дубль refundId');
    const refund1Id = orderId('ref-1');
    const refund1 = await api(port, 'POST', 'refunds', token, { refundId: refund1Id, paymentId, amount: { value: 4.56, code: 'RUB' } });
    const refund1Json = refund1.json() || {};
    const afterRefund1 = (await api(port, 'GET', `orders/${orderA}`, token)).json() || {};
    check('refunds: частичный возврат 4.56 → refund status.value=CONFIRMED, order PARTIALLY_REFUNDED',
      refund1.statusCode === 200 && refund1Json.status.value === 'CONFIRMED' && afterRefund1.status.value === 'PARTIALLY_REFUNDED');
    const refundCallback = await waitForCallback((hit) => hit.json && hit.json.type === 'REFUND' && hit.json.object && hit.json.object.refundId === refund1Id);
    check('REFUND callback: ключ статуса status (строчная) сохранён — Status/status не нормализуются',
      Object.prototype.hasOwnProperty.call(refundCallback.json.object, 'status') && !Object.prototype.hasOwnProperty.call(refundCallback.json.object, 'Status') && refundCallback.json.object.status.value === 'CONFIRMED', refundCallback.raw.slice(0, 300));
    check('REFUND callback: refundId/paymentId/amount на месте',
      refundCallback.json.object.refundId === refund1Id && refundCallback.json.object.paymentId === paymentId && refundCallback.json.object.amount.value === 4.56);
    const refund2Id = orderId('ref-2');
    const refund2 = await api(port, 'POST', 'refunds', token, { refundId: refund2Id, paymentId, amount: { value: 6, code: 'RUB' } });
    const afterRefund2 = (await api(port, 'GET', `orders/${orderA}`, token)).json() || {};
    check('refunds: полный возврат остатка → order REFUNDED', refund2.statusCode === 200 && afterRefund2.status.value === 'REFUNDED');
    const getRefund = await api(port, 'GET', `refunds/${refund1Id}`, token);
    const getRefundJson = getRefund.json() || {};
    check('GET /refunds/{refundId}: status.value возврата на своём уровне',
      getRefund.statusCode === 200 && getRefundJson.status && getRefundJson.status.value === 'CONFIRMED' && getRefundJson.refundId === refund1Id);
    checkProviderError('дубль refundId (не идемпотентен, в отличие от orderId)',
      await api(port, 'POST', 'refunds', token, { refundId: refund1Id, paymentId, amount: { value: 1, code: 'RUB' } }),
      'duplicate_refund_id', 409);
    checkProviderError('refund > списания (остаток 0)',
      await api(port, 'POST', 'refunds', token, { refundId: orderId('ref-over'), paymentId, amount: { value: 1, code: 'RUB' } }),
      'amount_exceeds_limit', 409);
    checkProviderError('неизвестный refundId', await api(port, 'GET', 'refunds/no-such-refund', token), 'refund_not_found', 404);

    console.log('— preauth → complete (≤ авторизации) и cancel');
    const preId = orderId('pre');
    const preRes = await api(port, 'POST', 'orders/preauth', token, {
      orderId: preId,
      orderName: 'Preauth',
      amount: { value: 9, code: 'RUB' },
      twoStageParams: { hold: true },
      returnUrl: `${origin}/pre-return`,
    });
    const preOrder = preRes.json() || {};
    check('preauth: ордер создан (twoStageParams сохранён), payment ещё нет',
      preRes.statusCode === 200 && preOrder.status.value === 'CREATED' && preOrder.twoStageParams && preOrder.payments.length === 0);
    const holdRes = await payForm(port, preId, CARD_SUCCESS);
    const heldOrder = (await api(port, 'GET', `orders/${preId}`, token)).json() || {};
    check('preauth payUrl: 302, холд держится payment.status.value=NEW, ордер остаётся CREATED',
      holdRes.statusCode === 302 && heldOrder.status.value === 'CREATED' && heldOrder.payments[0].status.value === 'NEW');
    checkProviderError('complete > авторизации',
      await api(port, 'POST', `orders/complete/${preId}`, token, { amount: { value: 9.01, code: 'RUB' } }),
      'amount_exceeds_limit', 409);
    const completeRes = await api(port, 'POST', `orders/complete/${preId}`, token, { amount: { value: 9, code: 'RUB' } });
    const completedOrder = completeRes.json() || {};
    check('complete = авторизации: order PAID, payment CONFIRMED',
      completeRes.statusCode === 200 && completedOrder.status.value === 'PAID' && completedOrder.payments[0].status.value === 'CONFIRMED');
    await waitForCallback((hit) => hit.json && hit.json.type === 'PAYMENT' && hit.json.object && hit.json.object.orderId === preId && hit.json.object.Status && hit.json.object.Status.value === 'CONFIRMED');
    const preCallbacks = await callbacksFor(port, preId);
    check('complete: PAYMENT callback отправлен после подтверждения (не на холде)',
      preCallbacks.filter((entry) => entry.type === 'PAYMENT').length === 1);

    const cancelId = orderId('cancel');
    await api(port, 'POST', 'orders', token, { orderId: cancelId, orderName: 'Cancel me', amount: { value: 3, code: 'RUB' } });
    const cancelRes = await api(port, 'POST', `orders/${cancelId}/cancel`, token, { cancelReason: 'тест отмены' });
    const cancelJson = cancelRes.json() || {};
    check('cancel: CREATED → CANCELED, cancelReason сохранён',
      cancelRes.statusCode === 200 && cancelJson.status.value === 'CANCELED' && cancelJson.cancelReason === 'тест отмены');
    checkProviderError('cancel уже отменённого → invalid_order_state',
      await api(port, 'POST', `orders/${cancelId}/cancel`, token, {}),
      'invalid_order_state', 409);
    checkProviderError('cancel оплаченного → invalid_order_state (после оплаты — /refunds)',
      await api(port, 'POST', `orders/${orderA}/cancel`, token, {}),
      'invalid_order_state', 409);

    console.log('— order TTL 20 минут и токен TTL по expires_in на виртуальных часах');
    const ttlId = orderId('ttl');
    await api(port, 'POST', 'orders', token, { orderId: ttlId, orderName: 'TTL', amount: { value: 5, code: 'RUB' } });
    await request(port, 'POST', '/mock/time', { advance: '+21m' });
    const afterTravel = (await getToken(port)).json() || {};
    const ttlOrder = (await api(port, 'GET', `orders/${ttlId}`, afterTravel.access_token)).json() || {};
    check('после +21m: незакрытый ордер CANCELED (20 мин TTL, expire)', ttlOrder.status && ttlOrder.status.value === 'CANCELED' && ttlOrder.cancelReason === 'order expired');
    const ttlPay = await payForm(port, ttlId, CARD_SUCCESS);
    check('payUrl истёкшего ордера не принимает карту', ttlPay.statusCode === 200 && ttlPay.body.includes('не принимает карточные данные'));
    const shortLived = (await getToken(port)).json() || {};
    await request(port, 'POST', '/mock/time', { advance: '+171s' });
    checkProviderError('истёкший access_token → invalid_token (TTL по expires_in)',
      await api(port, 'GET', `orders/${orderA}`, shortLived.access_token),
      'invalid_token', 401);
    const refreshed = (await getToken(port)).json() || {};
    const refreshedOk = await api(port, 'GET', `orders/${orderA}`, refreshed.access_token);
    check('обновление токена по client_credentials восстанавливает доступ', refreshedOk.statusCode === 200);
    await request(port, 'POST', '/mock/time', { reset: true });
    // Истёкшие токены вычищаются из состояния; для дальнейших запросов — свежий.
    token = ((await getToken(port)).json() || {}).access_token;

    console.log('— карточные отказы [FORK] и expire-сценарий карты');
    const declineId = orderId('decl');
    await api(port, 'POST', 'orders', token, { orderId: declineId, orderName: 'Decline', amount: { value: 3, code: 'RUB' } });
    const declineRes = await payForm(port, declineId, CARD_DECLINE);
    const declineOrder = (await api(port, 'GET', `orders/${declineId}`, token)).json() || {};
    check('[FORK]-карта отказа: форма остаётся, ордер CREATED без платежей',
      declineRes.statusCode === 200 && declineRes.body.includes('Отказ эмитента') && declineOrder.status.value === 'CREATED' && declineOrder.payments.length === 0);
    const expiredCardRes = await payForm(port, declineId, CARD_EXPIRED);
    check('expire-сценарий карты: просроченная карта → отказ', expiredCardRes.statusCode === 200 && expiredCardRes.body.includes('просрочена'));
    const unknownCardRes = await payForm(port, declineId, { pan: '4111111111111111', exp: '1224', cvv: '123' });
    check('официальная истёкшая карта ВТБ (4111…) не принимается моком', unknownCardRes.statusCode === 200 && unknownCardRes.body.includes('только синтетические'));

    console.log('— callbacks: webhook-drop / webhook-duplicate на оплате');
    const dropId = orderId('drop');
    await api(port, 'POST', 'orders', token, { orderId: dropId, orderName: 'Drop', amount: { value: 2, code: 'RUB' } });
    const dropPaid = await payForm(port, dropId, CARD_SUCCESS, { 'X-Mock-Scenario': 'webhook-drop' });
    const dropEntries = await callbacksFor(port, dropId);
    check('webhook-drop: оплата прошла, callback подавлен', (dropPaid.statusCode === 200 || dropPaid.statusCode === 302) && dropEntries.length === 1 && dropEntries[0].suppressed === true, `status=${dropPaid.statusCode}, entries=${dropEntries.length}`);
    const dupId = orderId('dup');
    await api(port, 'POST', 'orders', token, { orderId: dupId, orderName: 'Dup', amount: { value: 2, code: 'RUB' } });
    await payForm(port, dupId, CARD_SUCCESS, { 'X-Mock-Scenario': 'webhook-duplicate' });
    await waitFor(() => callbackHits.filter((hit) => hit.json && hit.json.object && hit.json.object.orderId === dupId).length >= 2, { description: 'duplicate callbacks' });
    check('webhook-duplicate: доставлено два одинаковых PAYMENT', callbackHits.filter((hit) => hit.json && hit.json.object && hit.json.object.orderId === dupId).length === 2);

    console.log('— сценарии status-lowercase / reconciled (SBP-варианты для парсеров)');
    const lowerId = orderId('lower');
    await api(port, 'POST', 'orders', token, { orderId: lowerId, orderName: 'Lower', amount: { value: 4, code: 'RUB' } });
    await payForm(port, lowerId, CARD_SUCCESS, { 'X-Mock-Scenario': 'status-lowercase' });
    const lowerHit = await waitForCallback((hit) => hit.json && hit.json.object && hit.json.object.orderId === lowerId);
    check('status-lowercase: PAYMENT уходит с ключом status (СБП-вариант), payload не нормализуется',
      Object.prototype.hasOwnProperty.call(lowerHit.json.object, 'status') && !Object.prototype.hasOwnProperty.call(lowerHit.json.object, 'Status'), lowerHit.raw.slice(0, 200));
    const recId = orderId('rec');
    await api(port, 'POST', 'orders', token, { orderId: recId, orderName: 'Reconciled', amount: { value: 4, code: 'RUB' } });
    await payForm(port, recId, CARD_SUCCESS, { 'X-Mock-Scenario': 'reconciled' });
    const recOrder = (await api(port, 'GET', `orders/${recId}`, token)).json() || {};
    check('reconciled: payment.status.value=RECONCILED на уровне операции', recOrder.payments[0].status.value === 'RECONCILED');

    console.log('— негативы и транспортные ограничения');
    const wrongMethod = await api(port, 'DELETE', `orders/${orderA}`, token);
    check('DELETE /orders/{id} → 405', wrongMethod.statusCode === 405);
    const notJson = await request(port, 'POST', `${REST_PATH}/orders`, 'orderId=x', {
      'Authorization': `Bearer ${token}`, 'X-IBM-Client-Id': CREDS.clientId, 'Content-Type': 'text/plain',
    });
    check('Content-Type не JSON → 415', notJson.statusCode === 415);
    const brokenJson = await request(port, 'POST', `${REST_PATH}/orders`, '{oops', {
      'Authorization': `Bearer ${token}`, 'X-IBM-Client-Id': CREDS.clientId, 'Content-Type': 'application/json',
    });
    check('битый JSON → 400 invalid_request', brokenJson.statusCode === 400 && (brokenJson.json() || {}).error === 'invalid_request');
    const unknownRoute = await api(port, 'GET', 'payments/xyz', token);
    check('неизвестный маршрут REST → 404', unknownRoute.statusCode === 404);
    const chaos = await api(port, 'GET', `orders/${orderA}`, token, null, { 'X-Mock-Scenario': 'http-500' });
    check('chaos abortStatus http-500: транспортный сбой до операции', chaos.statusCode === 500 && (chaos.json() || {}).error === 'system_error');

    console.log('— сценарии и состояние принадлежат своей песочнице');
    const sandboxA = `vtb-a-${Date.now().toString(36)}`;
    // Токены per-sandbox: для запросов в песочнице A нужен выданный в ней token.
    const sandboxTokenRes = await request(port, 'POST', TOKEN_PATH, formBody({
      grant_type: 'client_credentials',
      client_id: CREDS.clientId,
      client_secret: CREDS.clientSecret,
    }), { 'X-Mock-Sandbox': sandboxA });
    const sandboxToken = (sandboxTokenRes.json() || {}).access_token;
    const sandboxHeaders = { 'X-Mock-Sandbox': sandboxA, 'Authorization': `Bearer ${sandboxToken}`, 'X-IBM-Client-Id': CREDS.clientId, 'Content-Type': 'application/json' };
    const sandboxOrderRes = await request(port, 'POST', `${REST_PATH}/orders`, { orderId: orderId('sbx'), orderName: 'Sandbox', amount: { value: 1, code: 'RUB' } }, sandboxHeaders);
    const sandboxOrderId = (sandboxOrderRes.json() || {}).orderId;
    check('песочница: ордер создан в X-Mock-Sandbox', sandboxOrderRes.statusCode === 200 && Boolean(sandboxOrderId), sandboxOrderRes.body.slice(0, 160));
    const defaultSees = await api(port, 'GET', `orders/${sandboxOrderId}`, token);
    check('default-песочница не видит чужой ордер (404)', defaultSees.statusCode === 404);
    await request(port, 'POST', '/mock/scenarios', { scenario: 'fail', target: '*', times: 1 }, { 'X-Mock-Sandbox': sandboxA });
    const rulesA = (await request(port, 'GET', '/mock/scenarios', null, { 'X-Mock-Sandbox': sandboxA })).json() || {};
    const rulesDefault = (await request(port, 'GET', '/mock/scenarios', null, { 'X-Mock-Sandbox': 'default' })).json() || {};
    check('правило сценария живёт в своей песочнице', (rulesA.rules || []).length >= 1 && (rulesDefault.rules || []).length === 0);
    await request(port, 'POST', '/mock/reset', {}, { 'X-Mock-Sandbox': sandboxA });
    const rulesAfterReset = (await request(port, 'GET', '/mock/scenarios', null, { 'X-Mock-Sandbox': sandboxA })).json() || {};
    check('/mock/reset очищает сценарии песочницы', (rulesAfterReset.rules || []).length === 0);

    console.log('— SSRF-отказ терминален, один вызов и никакого retry');
    {
      const ssrfChild = startChild({
        MOCK_VTB_CALLBACK_URL: 'http://127.0.0.1:9/hook',
        MOCK_BLOCK_PRIVATE_WEBHOOKS: '1',
      });
      children.push(ssrfChild);
      const ssrfPort = await ssrfChild.port;
      const ssrfToken = ((await getToken(ssrfPort)).json() || {}).access_token;
      const ssrfOrder = orderId('ssrf');
      await api(ssrfPort, 'POST', 'orders', ssrfToken, { orderId: ssrfOrder, orderName: 'SSRF', amount: { value: 1, code: 'RUB' } });
      await payForm(ssrfPort, ssrfOrder, CARD_SUCCESS);
      await waitFor(async () => {
        const entries = await callbacksFor(ssrfPort, ssrfOrder);
        return entries.some((entry) => entry.dumped && String(entry.lastStatus).includes('ERR SSRF_BLOCKED'));
      }, { description: 'SSRF terminal refusal' });
      const entries = await callbacksFor(ssrfPort, ssrfOrder);
      const blocked = entries.find((entry) => String(entry.lastStatus).includes('ERR SSRF_BLOCKED'));
      check('SSRF_BLOCKED помечает callback terminal/dumped после первой попытки', Boolean(blocked && blocked.dumped && blocked.attempts === 1));
    }

    console.log('— env-парсеры и скрытие env-кредов');
    {
      const envChild = startChild({
        MOCK_VTB_CALLBACK_RETRY_MS: '1h',
        MOCK_VTB_CALLBACK_MAX_ATTEMPTS: '0',
        MOCK_VTB_CLIENT_ID: 'customsecretid',
        MOCK_VTB_CLIENT_SECRET: 'customsecretvalue',
      });
      children.push(envChild);
      const envPort = await envChild.port;
      const envHealth = (await request(envPort, 'GET', '/health')).json() || {};
      check('env parser: 1h → retry 3600000ms; attempts=0 нормализовано в 1', envHealth.callbackRetryMs === 3600000 && envHealth.callbackMaxAttempts === 1);
      await envChild.waitForOutput(/creds: clientId=/);
      check('start log hides custom VTB creds', !envChild.output().includes('customsecretvalue') && !envChild.output().includes('customsecretid') && envChild.output().includes('<задан через env, скрыт>'));
      const envToken = await getToken(envPort, { clientId: 'customsecretid', clientSecret: 'customsecretvalue' });
      check('кастомные env-креды работают в token endpoint', envToken.statusCode === 200 && Boolean((envToken.json() || {}).access_token));
      const envAuthErr = await api(envPort, 'POST', 'orders', (envToken.json() || {}).access_token, { orderId: orderId('env'), orderName: 'x', amount: { value: 1, code: 'RUB' } }, { clientId: 'customsecretid@ext.vtb.ru' });
      check('auth DX response never echoes effective env creds', !envAuthErr.body.includes('customsecretvalue') && !envAuthErr.body.includes('customsecretid'));
    }

    console.log('— hosted control-plane fail-closed');
    {
      const hostedChild = startChild({ MOCK_HOSTED: 'true', MOCK_ADMIN_TOKEN: 'adm1', MOCK_OPERATOR_TOKEN: 'op1' });
      children.push(hostedChild);
      const hostedPort = await hostedChild.port;
      const adminNoToken = await request(hostedPort, 'GET', '/admin');
      check('hosted: /admin без токена закрыт', adminNoToken.statusCode === 401);
      const timeNoToken = await request(hostedPort, 'GET', '/mock/time');
      check('hosted: /mock/time без токена закрыт, /health открыт', timeNoToken.statusCode === 401 && (await request(hostedPort, 'GET', '/health')).statusCode === 200);
    }
  } finally {
    for (const child of children) await child.stop();
    callbackReceiver.close();
  }

  console.log(`\nИТОГ: ${passed} passed, ${failed} failed · callback requests: ${callbackHits.length}`);
  if (failed > 0) {
    console.log('SELFTEST FAILED ✗');
    process.exit(1);
  }
  console.log('SELFTEST PASSED ✅');
}

main().catch((error) => {
  console.error('selftest crashed:', error);
  process.exit(1);
});
