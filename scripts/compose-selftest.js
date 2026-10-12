// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Black-box selftest против поднятого стенда (docker compose / внешние контейнеры).
 * Проверяет сервисы (tbank-mock на :3100, kassa-mock на :3101, yookassa-mock на :3102,
 * atol-mock на :3103, alfa-mock на :3104) снаружи по HTTP:
 *   1. Healthchecks (/health, /healthz, /health)
 *   2. Т-Банк: Init -> форма оплаты -> Confirm -> Chargeback (DISPUTED -> REPRESENTMENT -> ARBITRATION -> WON) -> виртуальные часы /mock/time -> /admin/journal
 *   3. Ferma (54-ФЗ): getToken -> sell (предоплата с расчётным НДС vat20_120) -> sell (зачёт предоплаты) -> buy (расход) -> маркировка -> очередь ОФД -> печать с ускорением через /mock/time -> /receipts/:uuid
 *   4. ЮKassa: POST /v3/payments -> confirmation-страница -> оплата -> succeeded -> POST /v3/refunds -> списки
 *   5. АТОЛ Онлайн v4: getToken -> sell (wait -> done, payload с ФД) -> повтор external_id (тот же uuid)
 *      -> sell_refund -> buy -> негативы (группа/реквизиты/токен) -> страница чека
 *   6. Альфа-Банк REST: register.do -> форма (3DS2 frictionless) -> getOrderStatusExtended (orderStatus=2)
 *      -> registerPreAuth -> холд -> deposit ≤ авторизации -> partial refund -> reverse -> негативы
 *      (креды, дубль orderNumber, дробный amount, неизвестный заказ)
 *
 * F-33: прогон выполняется в одноразовой песочнице (X-Mock-Sandbox, в hosted —
 * через POST /sandboxes с owner-token) и убирает её в finally, чтобы повторные
 * запуски на persistent volume оставляли одинаковые базовые counts.
 *
 * Zero dependencies. Запуск:
 *   node scripts/compose-selftest.js
 */

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

const TBANK_BASE = (process.env.MOCK_TBANK_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');
const KASSA_BASE = (process.env.MOCK_KASSA_URL || 'http://127.0.0.1:3101').replace(/\/$/, '');
const YOOKASSA_BASE = (process.env.MOCK_YOOKASSA_URL || 'http://127.0.0.1:3102').replace(/\/$/, '');
const ATOL_BASE = (process.env.MOCK_ATOL_URL || 'http://127.0.0.1:3103').replace(/\/$/, '');
const ALFA_BASE = (process.env.MOCK_ALFA_URL || 'http://127.0.0.1:3104').replace(/\/$/, '');
const TERMINAL_KEY = process.env.MOCK_TERMINAL_KEY || 'TBANKMOCKTEST';
const TERMINAL_PASSWORD = process.env.MOCK_TERMINAL_PASSWORD || 'mockpass123';
const FERMA_LOGIN = process.env.MOCK_FERMA_LOGIN || 'loviitest';
const FERMA_PASSWORD = process.env.MOCK_FERMA_PASSWORD || 'mockpass123';
const YOOKASSA_SHOP_ID = process.env.MOCK_SHOP_ID || process.env.YOOKASSA_SHOP_ID || 'YOOKASSAMOCKTEST';
const YOOKASSA_SECRET_KEY = process.env.MOCK_SECRET_KEY || process.env.YOOKASSA_SECRET_KEY || 'mockpass123';
const YOOKASSA_AUTH = `Basic ${Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString('base64')}`;
// Публичные тестовые реквизиты АТОЛ Онлайн v4 (дефолты образа).
const ATOL_LOGIN = process.env.MOCK_ATOL_LOGIN || process.env.ATOL_LOGIN || 'v4-online-atol-ru';
const ATOL_PASSWORD = process.env.MOCK_ATOL_PASSWORD || process.env.ATOL_PASSWORD || 'iGFFuihss';
const ATOL_GROUP = process.env.MOCK_ATOL_GROUP || process.env.ATOL_GROUP || 'v4-online-atol-ru_4179';
// СИНТЕТИЧЕСКИЕ креды alfa-mock (дефолты образа; реальные тестовые креды
// Альфа-Банка выдаёт индивидуально — в конфиге стенда их нет).
const ALFA_USERNAME = process.env.MOCK_ALFA_USERNAME || process.env.ALFA_USERNAME || 'ALFAMOCKTEST';
const ALFA_PASSWORD = process.env.MOCK_ALFA_PASSWORD || process.env.ALFA_PASSWORD || 'mockpass123';

/*
 * F-33 (RFC-001 §8): прогон идёт в одноразовой песочнице, чтобы не накапливать
 * платежи/чеки в default-состоянии стенда и не сдвигать его виртуальные часы.
 *   • namespaces (дефолт self-hosted): достаточно селектора X-Mock-Sandbox;
 *   • owned (MOCK_TENANCY/MOCK_HOSTED): POST /sandboxes выдаёт owner-token и креды;
 *   • off: селектор игнорируется, проверка неизменности счётчиков пропускается.
 */
const SANDBOX_ID = (process.env.MOCK_SANDBOX_ID
  || `cmp-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`)
  .replace(/[^a-zA-Z0-9_.-]/g, '');
const SANDBOX = {
  [TBANK_BASE]: { id: SANDBOX_ID, token: '', creds: null },
  [KASSA_BASE]: { id: SANDBOX_ID, token: '', creds: null },
  [YOOKASSA_BASE]: { id: SANDBOX_ID, token: '', creds: null },
  [ATOL_BASE]: { id: SANDBOX_ID, token: '', creds: null },
  [ALFA_BASE]: { id: SANDBOX_ID, token: '', creds: null },
};
const ALL_BASES = [TBANK_BASE, KASSA_BASE, YOOKASSA_BASE, ATOL_BASE, ALFA_BASE];

/** Заголовки песочницы прогона; вызов может переопределить их (например, default). */
function sandboxHeaders(baseUrl) {
  const sbx = SANDBOX[baseUrl] || { id: SANDBOX_ID };
  return { 'X-Mock-Sandbox': sbx.id, ...(sbx.token ? { 'X-Sandbox-Token': sbx.token } : {}) };
}

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function tokenOf(payload) {
  const values = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'Token') continue;
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') continue;
    values.push([key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)]);
  }
  const sbxCreds = SANDBOX[TBANK_BASE].creds || {};
  values.push(['Password', sbxCreds.terminalPassword || TERMINAL_PASSWORD]);
  values.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256').update(values.map(([, v]) => v).join('')).digest('hex');
}

function httpReq(baseUrl, method, pathUrl, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathUrl, baseUrl);
    const isRawString = typeof body === 'string';
    const data = body === null || body === undefined ? null : (isRawString ? body : JSON.stringify(body));
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method,
      headers: {
        ...(data ? {
          'Content-Type': isRawString ? 'application/x-www-form-urlencoded' : 'application/json',
          'Content-Length': Buffer.byteLength(data),
        } : {}),
        ...sandboxHeaders(baseUrl),
        ...headers,
      },
      timeout: 8000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: buf,
        json: () => { try { return JSON.parse(buf); } catch { return null; } },
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

function tbankApi(method, body, headers = {}) {
  const sbxCreds = SANDBOX[TBANK_BASE].creds || {};
  const payload = { TerminalKey: sbxCreds.terminalKey || TERMINAL_KEY, ...body };
  return httpReq(TBANK_BASE, 'POST', `/v2/${method}`, { ...payload, Token: tokenOf(payload) }, headers);
}

/** POST /payment/rest/{method} с form-параметрами и кредами песочницы (Альфа-Банк). */
function alfaApi(method, fields, headers = {}) {
  const sbxCreds = SANDBOX[ALFA_BASE].creds || {};
  const params = new URLSearchParams({
    userName: sbxCreds.userName || ALFA_USERNAME,
    password: sbxCreds.password || ALFA_PASSWORD,
    ...fields,
  });
  return httpReq(ALFA_BASE, 'POST', `/payment/rest/${method}`, params.toString(), headers);
}

/** Выделение песочницы прогона: в owned — POST /sandboxes, в namespaces — селектор. */
async function provisionSandboxes() {
  for (const base of ALL_BASES) {
    const slot = SANDBOX[base];
    try {
      const r = await httpReq(base, 'POST', '/sandboxes', { sandbox: slot.id }, { 'X-Mock-Sandbox': 'default' });
      const j = r.json();
      if (j && j.ownerToken) {
        slot.token = j.ownerToken;
        slot.id = j.id || slot.id;
      }
      if (j && j.creds) slot.creds = j.creds;
      if (j && j.current) slot.id = j.current;
      if (j && j.ok && !j.ownerToken) {
        // namespaces: POST переключил активную песочницу стенда — возвращаем default,
        // чтобы прогон не влиял на немаркированные запросы.
        await httpReq(base, 'POST', '/sandboxes', { sandbox: 'default' }, { 'X-Mock-Sandbox': 'default' });
      }
    } catch (e) {
      console.warn(`  ! песочница на ${base} не выделена: ${e.message}`);
    }
  }
}

/** Уборка: clock платформы, удаление песочницы и fallback-сброс (F-33, finally). */
async function cleanupSandboxes() {
  for (const base of ALL_BASES) {
    const slot = SANDBOX[base];
    const headers = sandboxHeaders(base);
    try {
      await httpReq(base, 'POST', '/mock/time', { reset: true }, headers);
    } catch { /* виртуальные часы не критичны для уборки */ }
    let removed = false;
    try {
      removed = (await httpReq(base, 'DELETE', `/mock/sandboxes?sandbox=${encodeURIComponent(slot.id)}`, null, headers)).status === 200;
    } catch { /* ignore */ }
    if (!removed) {
      try { await httpReq(base, 'POST', '/mock/reset', {}, headers); } catch { /* ignore */ }
      console.warn(`  ! песочница ${slot.id} на ${base} не удалена — состояние сброшено`);
    }
  }
}

async function scenario(runId) {
  // 1. Healthchecks + OpenAPI 3.1.0
  const hBank = await httpReq(TBANK_BASE, 'GET', '/health');
  check('tbank-mock /health === 200 ok', hBank.status === 200 && hBank.json() && hBank.json().ok === true);

  const hKassa = await httpReq(KASSA_BASE, 'GET', '/healthz');
  check('kassa-mock /healthz === 200 ok', hKassa.status === 200 && hKassa.json() && hKassa.json().ok === true);

  const oaBank = (await httpReq(TBANK_BASE, 'GET', '/openapi.json')).json();
  check('tbank-mock /openapi.json отдаёт OpenAPI 3.1.0', Boolean(oaBank && oaBank.openapi === '3.1.0' && oaBank.paths['/v2/Init']));

  const oaKassa = (await httpReq(KASSA_BASE, 'GET', '/openapi.json')).json();
  check('kassa-mock /openapi.json отдаёт OpenAPI 3.1.0', Boolean(oaKassa && oaKassa.openapi === '3.1.0' && oaKassa.paths['/possystem/v1/validate']));

  // 2. Т-Банк: сквозной платёж + чарджбэк e2e
  const orderId = `${runId}-ord-1`;
  const initRes = (await tbankApi('Init', {
    Amount: 180000,
    OrderId: orderId,
    PayType: 'T',
    CreateDealWithType: 'NN',
  })).json();
  check('tbank Init создаёт сессию NEW', Boolean(initRes && initRes.Success && initRes.Status === 'NEW'), JSON.stringify(initRes));

  const paymentId = initRes.PaymentId;
  const payRes = await httpReq(TBANK_BASE, 'POST', `/payment/${paymentId}/pay`, 'pan=2201382000000013&exp=1227&cvv=123');
  check('tbank оплата тестовой картой -> 302 redirect', payRes.status === 302);

  const confRes = (await tbankApi('Confirm', { PaymentId: paymentId, Amount: 180000 })).json();
  check('tbank Confirm -> CONFIRMED', confRes && confRes.Status === 'CONFIRMED');

  const cbOpen = (await tbankApi('Chargeback', { PaymentId: paymentId, Amount: 60000, ReasonCode: '4853' })).json();
  check('tbank Chargeback open -> PARTIAL_CHARGEBACK (DISPUTED)', cbOpen && cbOpen.Status === 'PARTIAL_CHARGEBACK' && cbOpen.DisputeStatus === 'DISPUTED');

  const cbRep = (await tbankApi('Chargeback', { DisputeId: cbOpen.DisputeId, Action: 'representment', FiscalDocumentNumber: '50001' })).json();
  check('tbank Chargeback -> REPRESENTMENT', cbRep && cbRep.DisputeStatus === 'REPRESENTMENT');

  const cbArb = (await tbankApi('Chargeback', { DisputeId: cbOpen.DisputeId, Action: 'arbitration' })).json();
  check('tbank Chargeback -> ARBITRATION', cbArb && cbArb.DisputeStatus === 'ARBITRATION');

  const cbWin = (await tbankApi('Chargeback', { DisputeId: cbOpen.DisputeId, Action: 'win' })).json();
  check('tbank Chargeback -> WON (возврат в CONFIRMED, сумма восстановлена)', cbWin && cbWin.DisputeStatus === 'WON' && cbWin.Status === 'CONFIRMED' && cbWin.NewAmount === 180000);

  // 3. Касса Ferma: getToken -> предоплата -> зачёт -> расход -> маркировка -> ОФД
  const kassaCreds = SANDBOX[KASSA_BASE].creds || {};
  const tokRes = (await httpReq(KASSA_BASE, 'POST', '/possystem/v1/getToken', {
    login: kassaCreds.fermaLogin || FERMA_LOGIN,
    pass: kassaCreds.fermaPassword || FERMA_PASSWORD,
  })).json();
  const token = tokRes && tokRes.token;
  check('kassa getToken выдаёт токен', Boolean(token));

  const prepayId = `${runId}-prepay`;
  const prepay = (await httpReq(KASSA_BASE, 'POST', `/possystem/v1/Main/sell?token=${token}`, {
    external_id: prepayId,
    receipt: {
      client: { email: 'compose@test.ru' },
      company: { sno: 'usn_income', payment_address: 'lovii.test' },
      items: [{ name: 'Заказ (предоплата)', price: 120000, quantity: 1, sum: 120000, payment_method: 'full_prepayment', payment_object: 'payment', vat: { type: 'vat20_120' } }],
      payments: [{ type: 1, sum: 120000 }],
      total: 120000,
    },
  })).json();
  check('kassa sell (full_prepayment + vat20_120) -> wait', Boolean(prepay && prepay.uuid && prepay.status === 'wait'));

  const fullPay = (await httpReq(KASSA_BASE, 'POST', `/possystem/v1/Main/sell?token=${token}`, {
    external_id: `${runId}-full`,
    prepayment_external_id: prepayId,
    receipt: {
      client: { email: 'compose@test.ru' },
      company: { sno: 'usn_income', payment_address: 'lovii.test' },
      items: [{
        name: 'Маркированный набор',
        price: 120000,
        quantity: 1,
        sum: 120000,
        payment_method: 'full_payment',
        payment_object: 'marked_commodity',
        marking_code: '010460000000000021cmpMARK777',
        vat: { type: 'vat20' },
      }],
      payments: [{ type: 2, sum: 120000 }],
      total: 120000,
    },
  }, { 'X-Mock-Scenario': 'ofd-queue' })).json();
  check('kassa sell (зачёт аванса + маркировка + ofd-queue) -> wait', Boolean(fullPay && fullPay.uuid));

  const buyDoc = (await httpReq(KASSA_BASE, 'POST', `/possystem/v1/Main/buy?token=${token}`, {
    external_id: `${runId}-buy`,
    receipt: {
      client: { phone: '+79991112233' },
      items: [{ name: 'Выплата поставщику', price: 50000, quantity: 1, sum: 50000, payment_method: 'full_payment', payment_object: 'service', vat: { type: 'none' } }],
      payments: [{ type: 1, sum: 50000 }],
      total: 50000,
    },
  })).json();
  check('kassa buy (расход) -> wait', Boolean(buyDoc && buyDoc.uuid));

  // Сдвигаем виртуальные часы кассы на +20s, чтобы чеки мгновенно «напечатались» без ожидания 15 с
  await httpReq(KASSA_BASE, 'POST', '/mock/time', { advance: '20s' });

  const fullRep = (await httpReq(KASSA_BASE, 'GET', `/possystem/v1/Main/report/${fullPay.uuid}?token=${token}`)).json();
  check('kassa после /mock/time +20s чек напечатан (done) и ждёт в очереди ОФД (pending)', fullRep && fullRep.status === 'done' && fullRep.ofd_status === 'pending');

  await httpReq(KASSA_BASE, 'POST', '/possystem/v1/ofd/mode', { mode: 'online', flush: true });
  const fullRepAfterFlush = (await httpReq(KASSA_BASE, 'GET', `/possystem/v1/Main/report/${fullPay.uuid}?token=${token}`)).json();
  check('kassa очередь ОФД отправлена -> ofd_status=sent', fullRepAfterFlush && fullRepAfterFlush.ofd_status === 'sent');

  const receiptHtml = await httpReq(KASSA_BASE, 'GET', `/receipts/${fullPay.uuid}?sandbox=${encodeURIComponent(SANDBOX[KASSA_BASE].id)}`, null, { 'X-Mock-Sandbox': SANDBOX[KASSA_BASE].id });
  check('kassa страница чека /receipts/:uuid отдаёт 200 и [М]', receiptHtml.status === 200 && receiptHtml.text.includes('[М]'));

  // Сбрасываем виртуальные часы кассы обратно (в песочнице прогона)
  await httpReq(KASSA_BASE, 'POST', '/mock/time', { reset: true });

  // 4. ЮKassa: create -> confirmation -> оплата -> succeeded -> возврат -> списки
  const hYk = await httpReq(YOOKASSA_BASE, 'GET', '/health');
  check('yookassa-mock /health === 200 ok', hYk.status === 200 && hYk.json() && hYk.json().ok === true);

  const ykCreate = await httpReq(YOOKASSA_BASE, 'POST', '/v3/payments', {
    amount: { value: '150.00', currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: 'https://compose.test/return' },
    description: 'Compose прогон ЮKassa',
  }, { Authorization: YOOKASSA_AUTH, 'Idempotence-Key': `cmp-${runId}-yk-1` });
  const ykPay = ykCreate.json();
  check('yookassa POST /v3/payments -> pending, test:true, decimal-строка',
    ykCreate.status === 200 && ykPay && ykPay.status === 'pending' && ykPay.test === true && ykPay.amount.value === '150.00',
    ykCreate.text.slice(0, 160));

  const ykConf = await httpReq(YOOKASSA_BASE, 'GET', new URL(ykPay.confirmation.confirmation_url).pathname);
  check('yookassa confirmation-страница отдаёт 200', ykConf.status === 200 && ykConf.text.includes('Тестовый стенд ЮKassa'));

  const ykPayResp = await httpReq(YOOKASSA_BASE, 'POST', `/payment/${ykPay.id}/pay`,
    'pan=4111111111111111&exp=1229&cvv=123');
  check('yookassa оплата тестовой картой -> 302', ykPayResp.status === 302);

  const ykGet = await httpReq(YOOKASSA_BASE, 'GET', `/v3/payments/${ykPay.id}`, null, { Authorization: YOOKASSA_AUTH });
  check('yookassa GET /v3/payments/{id} -> succeeded, paid, refundable',
    ykGet.status === 200 && ykGet.json() && ykGet.json().status === 'succeeded' && ykGet.json().paid === true && ykGet.json().refundable === true,
    ykGet.text.slice(0, 160));

  const ykRefund = await httpReq(YOOKASSA_BASE, 'POST', '/v3/refunds', {
    payment_id: ykPay.id,
    amount: { value: '150.00', currency: 'RUB' },
  }, { Authorization: YOOKASSA_AUTH, 'Idempotence-Key': `cmp-${runId}-yk-rf` });
  check('yookassa POST /v3/refunds -> succeeded',
    ykRefund.status === 200 && ykRefund.json() && ykRefund.json().status === 'succeeded' && ykRefund.json().payment_id === ykPay.id,
    ykRefund.text.slice(0, 160));

  const ykList = await httpReq(YOOKASSA_BASE, 'GET', '/v3/refunds', null, { Authorization: YOOKASSA_AUTH });
  check('yookassa GET /v3/refunds -> {type:list, items, next_cursor}',
    ykList.status === 200 && ykList.json() && ykList.json().type === 'list' && Array.isArray(ykList.json().items) && 'next_cursor' in ykList.json());

  const ykNoAuth = await httpReq(YOOKASSA_BASE, 'GET', `/v3/payments/${ykPay.id}`);
  check('yookassa без Basic Auth -> 401 invalid_credentials',
    ykNoAuth.status === 401 && ykNoAuth.json() && ykNoAuth.json().type === 'error' && ykNoAuth.json().code === 'invalid_credentials');

  // 5. АТОЛ Онлайн v4: getToken -> sell -> report(done) -> дедуп -> возврат -> расход
  const hAtol = await httpReq(ATOL_BASE, 'GET', '/health');
  check('atol-mock /health === 200 ok (api v4, ФФД 1.05)',
    hAtol.status === 200 && hAtol.json() && hAtol.json().ok === true && hAtol.json().api === 'v4' && hAtol.json().ffd === '1.05');

  const atolCreds = SANDBOX[ATOL_BASE].creds || {};
  const atolLogin = atolCreds.atolLogin || ATOL_LOGIN;
  const atolPassword = atolCreds.atolPassword || ATOL_PASSWORD;
  const atolGroup = atolCreds.atolGroup || ATOL_GROUP;

  const atolBadCreds = (await httpReq(ATOL_BASE, 'POST', '/possystem/v4/getToken', { login: atolLogin, pass: 'wrong' })).json();
  check('atol getToken с неверным паролем -> error.code 14', Boolean(atolBadCreds && atolBadCreds.error && atolBadCreds.error.code === 14));

  const atolTokenRes = (await httpReq(ATOL_BASE, 'POST', '/possystem/v4/getToken', { login: atolLogin, pass: atolPassword })).json();
  const atolToken = atolTokenRes && atolTokenRes.token;
  check('atol getToken выдаёт токен (v4, TTL 24 ч)', Boolean(atolToken));

  const atolReceipt = {
    client: { email: 'compose@test.ru' },
    company: { email: 'kassa@test.ru', inn: '5544332219', payment_address: 'https://v4.online.atol.ru', sno: 'usn_income' },
    items: [{ name: 'Кофе латте', price: 120.5, quantity: 2, sum: 241, payment_method: 'full_payment', payment_object: 'commodity', vat: 'vat120' }],
    payments: [{ type: 1, sum: 241 }],
    total: 241,
  };

  const atolSell = await httpReq(ATOL_BASE, 'POST', `/possystem/v4/${encodeURIComponent(atolGroup)}/sell`, {
    external_id: `${runId}-atol-sell`,
    timestamp: '12.10.2026 10:00:00',
    receipt: atolReceipt,
  }, { Token: atolToken });
  const atolUuid = atolSell.json() && atolSell.json().uuid;
  check('atol sell (decimal-рубли, vat120) -> {uuid, status:"wait"}',
    atolSell.status === 200 && Boolean(atolUuid) && atolSell.json().status === 'wait', atolSell.text.slice(0, 160));

  const atolReplay = await httpReq(ATOL_BASE, 'POST', `/possystem/v4/${encodeURIComponent(atolGroup)}/sell`, {
    external_id: `${runId}-atol-sell`,
    receipt: { ...atolReceipt, total: 999 },
  }, { Token: atolToken });
  check('atol повтор external_id -> ТОТ ЖЕ uuid и X-Mock-Replayed (не второй чек)',
    atolReplay.json() && atolReplay.json().uuid === atolUuid && atolReplay.headers['x-mock-replayed'] === '1'
    && atolReplay.json().error === null, atolReplay.text.slice(0, 160));

  await httpReq(ATOL_BASE, 'POST', '/mock/time', { advance: '20s' }, sandboxHeaders(ATOL_BASE));

  const atolReport = (await httpReq(ATOL_BASE, 'GET', `/possystem/v4/${encodeURIComponent(atolGroup)}/report/${atolUuid}`, null, { Token: atolToken })).json();
  check('atol report после /mock/time +20s -> done, payload с ФД/ФП/ФН/ККТ и ofd_receipt_url',
    atolReport && atolReport.status === 'done' && atolReport.payload
    && Number.isFinite(atolReport.payload.fiscal_document_number)
    && Boolean(atolReport.payload.fiscal_document_attribute)
    && Boolean(atolReport.payload.fn_number)
    && Boolean(atolReport.payload.ecr_registration_number)
    && Boolean(atolReport.payload.ofd_receipt_url), JSON.stringify(atolReport && atolReport.payload).slice(0, 180));

  const atolRefund = await httpReq(ATOL_BASE, 'POST', `/possystem/v4/${encodeURIComponent(atolGroup)}/sell_refund`, {
    external_id: `${runId}-atol-refund`,
    receipt: {
      ...atolReceipt,
      items: [{ name: 'Кофе латте', price: 120.5, quantity: 1, sum: 120.5, payment_method: 'full_payment', payment_object: 'commodity', vat: 'vat120' }],
      payments: [{ type: 1, sum: 120.5 }],
      total: 120.5,
    },
  }, { Token: atolToken });
  check('atol sell_refund (возврат прихода) -> wait', atolRefund.status === 200 && atolRefund.json().status === 'wait');

  const atolBuy = await httpReq(ATOL_BASE, 'POST', `/possystem/v4/${encodeURIComponent(atolGroup)}/buy`, {
    external_id: `${runId}-atol-buy`,
    receipt: {
      client: { phone: '+79991112233' },
      company: { email: 'kassa@test.ru', inn: '5544332219', payment_address: 'https://v4.online.atol.ru' },
      items: [{ name: 'Выплата поставщику', price: '50.00', quantity: 1, sum: '50.00', payment_object: 'service', vat: 'none' }],
      payments: [{ type: 0, sum: '50.00' }],
      total: '50.00',
    },
  }, { Token: atolToken });
  check('atol buy (расход, наличные type=0, decimal-строки) -> wait', atolBuy.status === 200 && atolBuy.json().status === 'wait');

  const atolWrongGroup = (await httpReq(ATOL_BASE, 'POST', '/possystem/v4/no-such-group/sell', {
    external_id: `${runId}-atol-group`, receipt: atolReceipt,
  }, { Token: atolToken })).json();
  check('atol чужая группа -> error.code 4 (field group_code)',
    Boolean(atolWrongGroup && atolWrongGroup.error && atolWrongGroup.error.code === 4 && atolWrongGroup.error.field === 'group_code'));

  const atolNoClient = (await httpReq(ATOL_BASE, 'POST', `/possystem/v4/${encodeURIComponent(atolGroup)}/sell`, {
    external_id: `${runId}-atol-client`, receipt: { ...atolReceipt, client: {} },
  }, { Token: atolToken })).json();
  check('atol client без email/телефона -> error.code 4', Boolean(atolNoClient && atolNoClient.error && atolNoClient.error.code === 4));

  const atolFermaVat = (await httpReq(ATOL_BASE, 'POST', `/possystem/v4/${encodeURIComponent(atolGroup)}/sell`, {
    external_id: `${runId}-atol-vat`,
    receipt: { ...atolReceipt, items: [{ name: 'X', price: 10, quantity: 1, sum: 10, vat: 'vat20_120' }], payments: [{ type: 1, sum: 10 }], total: 10 },
  }, { Token: atolToken })).json();
  check('atol Ferma-синтаксис vat20_120 отклонён с подсказкой про vat120',
    Boolean(atolFermaVat && atolFermaVat.error && atolFermaVat.error.code === 4
      && String(atolFermaVat.error.hint || '').includes('vat120')));

  const atolNoToken = (await httpReq(ATOL_BASE, 'POST', `/possystem/v4/${encodeURIComponent(atolGroup)}/sell`, {
    external_id: `${runId}-atol-token`, receipt: atolReceipt,
  })).json();
  check('atol без заголовка Token -> error.code 11', Boolean(atolNoToken && atolNoToken.error && atolNoToken.error.code === 11));

  const atolReceiptPage = await httpReq(ATOL_BASE, 'GET', `/receipts/${atolUuid}?sandbox=${encodeURIComponent(SANDBOX[ATOL_BASE].id)}`,
    null, { 'X-Mock-Sandbox': SANDBOX[ATOL_BASE].id });
  check('atol страница чека /receipts/:uuid отдаёт 200 и ФН', atolReceiptPage.status === 200 && atolReceiptPage.text.includes('ФН:'));

  await httpReq(ATOL_BASE, 'POST', '/mock/time', { reset: true }, sandboxHeaders(ATOL_BASE));

  // 6. Альфа-Банк REST: register -> форма (3DS2 frictionless) -> deposited ->
  //    двухстадийная схема (холд + deposit ≤ авторизации) -> refund -> reverse -> негативы.
  //    Callback здесь не принимается (нет внешнего приёмника): доставка и checksum
  //    покрыты selftest сервиса; здесь — REST-контракт и платёжная страница.
  const hAlfa = await httpReq(ALFA_BASE, 'GET', '/health');
  check('alfa-mock /health === 200 ok (api rest, base /payment/rest)',
    hAlfa.status === 200 && hAlfa.json() && hAlfa.json().ok === true && hAlfa.json().api === 'rest' && hAlfa.json().base === '/payment/rest');

  const oaAlfa = (await httpReq(ALFA_BASE, 'GET', '/openapi.json')).json();
  check('alfa-mock /openapi.json отдаёт OpenAPI 3.1.0 с register.do',
    Boolean(oaAlfa && oaAlfa.openapi === '3.1.0' && oaAlfa.paths['/payment/rest/register.do']));

  const alfaBadCreds = (await httpReq(ALFA_BASE, 'POST', '/payment/rest/register.do',
    new URLSearchParams({ userName: 'wrong', password: 'wrong', orderNumber: `${runId}-alfa-bad`, amount: '10000', returnUrl: 'https://compose.test/ok' }).toString())).json();
  check('alfa неверные userName/password -> errorCode 2 (merchant-логин не найден)',
    Boolean(alfaBadCreds && alfaBadCreds.errorCode === 2));

  const alfaReg = await alfaApi('register.do', { orderNumber: `${runId}-alfa-1`, amount: '15000', returnUrl: 'https://compose.test/ok', failUrl: 'https://compose.test/fail', description: 'Compose прогон Альфа' });
  const alfaRegJ = alfaReg.json() || {};
  check('alfa register.do -> errorCode 0, {orderId, formUrl}',
    alfaReg.status === 200 && alfaRegJ.errorCode === 0 && Boolean(alfaRegJ.orderId) && Boolean(alfaRegJ.formUrl), alfaReg.text.slice(0, 160));

  const alfaDup = (await alfaApi('register.do', { orderNumber: `${runId}-alfa-1`, amount: '15000', returnUrl: 'https://compose.test/ok' })).json();
  check('alfa повтор orderNumber -> errorCode 1 (уникальность в пределах магазина, не replay)',
    Boolean(alfaDup && alfaDup.errorCode === 1));

  const alfaFormUrl = new URL(alfaRegJ.formUrl);
  const alfaForm = await httpReq(ALFA_BASE, 'GET', alfaFormUrl.pathname + alfaFormUrl.search);
  check('alfa платёжная страница formUrl отдаёт 200 с пресетами тестовых карт',
    alfaForm.status === 200 && alfaForm.text.includes('2201382000000062') && alfaForm.text.includes('12345678'));

  const alfaPay = await httpReq(ALFA_BASE, 'POST', `/payment/${alfaRegJ.orderId}/pay${alfaFormUrl.search}`,
    'pan=2201382000000062&exp=1234&cvv=123&cardholder=IVAN+IVANOV');
  check('alfa оплата 3DS2-frictionless картой -> 302 на returnUrl',
    alfaPay.status === 302 && alfaPay.headers.location === 'https://compose.test/ok', `HTTP ${alfaPay.status}`);

  const alfaStatus = (await alfaApi('getOrderStatusExtended.do', { orderId: alfaRegJ.orderId })).json();
  check('alfa getOrderStatusExtended -> orderStatus=2, depositedAmount=15000, маска first6**last4 (PAN не хранится)',
    Boolean(alfaStatus && alfaStatus.errorCode === 0 && alfaStatus.orderStatus === 2 && alfaStatus.depositedAmount === 15000 && alfaStatus.maskPan === '220138**0062'),
    JSON.stringify(alfaStatus).slice(0, 160));

  const alfaPre = (await alfaApi('registerPreAuth.do', { orderNumber: `${runId}-alfa-2`, amount: '9000', returnUrl: 'https://compose.test/ok' })).json();
  check('alfa registerPreAuth.do -> orderId + formUrl (двухстадийная схема)',
    Boolean(alfaPre && alfaPre.errorCode === 0 && alfaPre.orderId && alfaPre.formUrl));
  const alfaPreUrl = new URL(alfaPre.formUrl);
  const alfaPrePay = await httpReq(ALFA_BASE, 'POST', `/payment/${alfaPre.orderId}/pay${alfaPreUrl.search}`,
    'pan=2201382000000062&exp=1234&cvv=123&cardholder=IVAN+IVANOV');
  check('alfa холд: оплата формы -> 302', alfaPrePay.status === 302);
  const alfaHold = (await alfaApi('getOrderStatusExtended.do', { orderId: alfaPre.orderId })).json();
  check('alfa холд: orderStatus=1, authorizedAmount=9000, depositedAmount=0',
    Boolean(alfaHold && alfaHold.orderStatus === 1 && alfaHold.authorizedAmount === 9000 && alfaHold.depositedAmount === 0));

  const alfaDepBig = (await alfaApi('deposit.do', { orderId: alfaPre.orderId, amount: '9001' })).json();
  check('alfa deposit больше авторизованной суммы -> errorCode 5', Boolean(alfaDepBig && alfaDepBig.errorCode === 5));
  const alfaDep = (await alfaApi('deposit.do', { orderId: alfaPre.orderId, amount: '6000' })).json();
  check('alfa частичный deposit 6000 ≤ 9000 -> errorCode 0', Boolean(alfaDep && alfaDep.errorCode === 0));
  const alfaDepSt = (await alfaApi('getOrderStatusExtended.do', { orderId: alfaPre.orderId })).json();
  check('alfa после deposit: orderStatus=2, depositedAmount=6000',
    Boolean(alfaDepSt && alfaDepSt.orderStatus === 2 && alfaDepSt.depositedAmount === 6000));

  const alfaRefBig = (await alfaApi('refund.do', { orderId: alfaPre.orderId, amount: '6001' })).json();
  check('alfa refund больше списанного -> errorCode 5', Boolean(alfaRefBig && alfaRefBig.errorCode === 5));
  const alfaRef = (await alfaApi('refund.do', { orderId: alfaPre.orderId, amount: '2500' })).json();
  check('alfa частичный refund 2500 -> errorCode 0', Boolean(alfaRef && alfaRef.errorCode === 0));
  const alfaRefSt = (await alfaApi('getOrderStatusExtended.do', { orderNumber: `${runId}-alfa-2` })).json();
  check('alfa после refund: orderStatus=4, refundedAmount=2500 (поиск по orderNumber)',
    Boolean(alfaRefSt && alfaRefSt.orderStatus === 4 && alfaRefSt.refundedAmount === 2500));

  const alfaRev = (await alfaApi('reverse.do', { orderId: alfaRegJ.orderId })).json();
  check('alfa reverse оплаченного заказа -> errorCode 0', Boolean(alfaRev && alfaRev.errorCode === 0));
  const alfaRevSt = (await alfaApi('getOrderStatus.do', { orderId: alfaRegJ.orderId })).json();
  check('alfa после reverse: orderStatus=3', Boolean(alfaRevSt && alfaRevSt.orderStatus === 3));

  const alfaUnknown = (await alfaApi('getOrderStatus.do', { orderId: '00000000-0000-4000-8000-000000000000' })).json();
  check('alfa неизвестный заказ -> errorCode 3', Boolean(alfaUnknown && alfaUnknown.errorCode === 3));

  const alfaBadAmount = (await alfaApi('register.do', { orderNumber: `${runId}-alfa-3`, amount: '100.50', returnUrl: 'https://compose.test/ok' })).json();
  check('alfa amount дробный -> errorCode 5 (копейки — целые)', Boolean(alfaBadAmount && alfaBadAmount.errorCode === 5));
}

async function main() {
  console.log(`\n== compose black-box selftest (${TBANK_BASE} & ${KASSA_BASE} & ${YOOKASSA_BASE} & ${ATOL_BASE} & ${ALFA_BASE}) ==\n`);
  console.log(`  · одноразовая песочница прогона: ${SANDBOX_ID}`);

  // Базовая линия default-состояния: прогон не должен её изменить (два запуска
  // подряд оставляют одинаковые counts даже при ошибке в середине — уборка в finally).
  const BANK_KEYS = ['payments', 'deals', 'payouts', 'disputes', 'shops'];
  const bankCounts = (j) => BANK_KEYS.map((k) => `${k}=${j[k]}`).join(',');
  const kassaCounts = (j) => `checks=${j.checks},ofdQueue=${j.ofdQueueCount},fnUsed=${j.fnUsed},shift=${j.shiftStatus}`;
  const yookassaCounts = (j) => `payments=${j.payments},refunds=${j.refunds}`;
  const atolCounts = (j) => `documents=${j.documents},waiting=${j.waiting},callbacks=${j.callbacks}`;
  const alfaCounts = (j) => `orders=${j.orders},awaiting=${j.awaiting},callbacks=${j.callbacks}`;
  const beforeBank = (await httpReq(TBANK_BASE, 'GET', '/health?sandbox=default', null, { 'X-Mock-Sandbox': 'default' })).json() || {};
  const beforeKassa = (await httpReq(KASSA_BASE, 'GET', '/healthz?sandbox=default', null, { 'X-Mock-Sandbox': 'default' })).json() || {};
  const beforeYookassa = (await httpReq(YOOKASSA_BASE, 'GET', '/health?sandbox=default', null, { 'X-Mock-Sandbox': 'default' })).json() || {};
  const beforeAtol = (await httpReq(ATOL_BASE, 'GET', '/health?sandbox=default', null, { 'X-Mock-Sandbox': 'default' })).json() || {};
  const beforeAlfa = (await httpReq(ALFA_BASE, 'GET', '/health?sandbox=default', null, { 'X-Mock-Sandbox': 'default' })).json() || {};

  await provisionSandboxes();
  try {
    await scenario(`cmp-${Date.now()}`);
  } finally {
    await cleanupSandboxes();
  }

  const afterBank = (await httpReq(TBANK_BASE, 'GET', '/health?sandbox=default', null, { 'X-Mock-Sandbox': 'default' })).json() || {};
  const afterKassa = (await httpReq(KASSA_BASE, 'GET', '/healthz?sandbox=default', null, { 'X-Mock-Sandbox': 'default' })).json() || {};
  const afterYookassa = (await httpReq(YOOKASSA_BASE, 'GET', '/health?sandbox=default', null, { 'X-Mock-Sandbox': 'default' })).json() || {};
  const afterAtol = (await httpReq(ATOL_BASE, 'GET', '/health?sandbox=default', null, { 'X-Mock-Sandbox': 'default' })).json() || {};
  const afterAlfa = (await httpReq(ALFA_BASE, 'GET', '/health?sandbox=default', null, { 'X-Mock-Sandbox': 'default' })).json() || {};
  if (beforeBank.tenancy && beforeBank.tenancy !== 'off') {
    check('tbank: прогон не изменил default-счётчики (F-33)', bankCounts(beforeBank) === bankCounts(afterBank),
      `${bankCounts(beforeBank)} -> ${bankCounts(afterBank)}`);
  }
  if (beforeKassa.tenancy && beforeKassa.tenancy !== 'off') {
    check('kassa: прогон не изменил default-счётчики (F-33)', kassaCounts(beforeKassa) === kassaCounts(afterKassa),
      `${kassaCounts(beforeKassa)} -> ${kassaCounts(afterKassa)}`);
  }
  if (beforeYookassa.tenancy && beforeYookassa.tenancy !== 'off') {
    check('yookassa: прогон не изменил default-счётчики (F-33)', yookassaCounts(beforeYookassa) === yookassaCounts(afterYookassa),
      `${yookassaCounts(beforeYookassa)} -> ${yookassaCounts(afterYookassa)}`);
  }
  if (beforeAtol.tenancy && beforeAtol.tenancy !== 'off') {
    check('atol: прогон не изменил default-счётчики (F-33)', atolCounts(beforeAtol) === atolCounts(afterAtol),
      `${atolCounts(beforeAtol)} -> ${atolCounts(afterAtol)}`);
  }
  if (beforeAlfa.tenancy && beforeAlfa.tenancy !== 'off') {
    check('alfa: прогон не изменил default-счётчики (F-33)', alfaCounts(beforeAlfa) === alfaCounts(afterAlfa),
      `${alfaCounts(beforeAlfa)} -> ${alfaCounts(afterAlfa)}`);
  }

  console.log(`\nИТОГ compose-selftest: ${passed} passed, ${failed} failed\n`);
  assert.strictEqual(failed, 0, `${failed} checks failed`);
}

main().catch((e) => {
  console.error('compose-selftest failed:', e);
  process.exit(1);
});
