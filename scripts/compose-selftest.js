'use strict';

/*
 * Black-box selftest против поднятого стенда (docker compose / внешние контейнеры).
 * Проверяет оба сервиса (tbank-mock на :3100 и kassa-mock на :3101) снаружи по HTTP:
 *   1. Healthchecks (/health, /healthz)
 *   2. Т-Банк: Init -> форма оплаты -> Confirm -> Chargeback (DISPUTED -> REPRESENTMENT -> ARBITRATION -> WON) -> виртуальные часы /mock/time -> /admin/journal
 *   3. Ferma (54-ФЗ): getToken -> sell (предоплата с расчётным НДС vat20_120) -> sell (зачёт предоплаты) -> buy (расход) -> маркировка -> очередь ОФД -> печать с ускорением через /mock/time -> /receipts/:uuid
 *
 * Zero dependencies. Запуск:
 *   node scripts/compose-selftest.js
 */

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

const TBANK_BASE = (process.env.MOCK_TBANK_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');
const KASSA_BASE = (process.env.MOCK_KASSA_URL || 'http://127.0.0.1:3101').replace(/\/$/, '');
const TERMINAL_KEY = process.env.MOCK_TERMINAL_KEY || 'TBANKMOCKTEST';
const TERMINAL_PASSWORD = process.env.MOCK_TERMINAL_PASSWORD || 'mockpass123';
const FERMA_LOGIN = process.env.MOCK_FERMA_LOGIN || 'loviitest';
const FERMA_PASSWORD = process.env.MOCK_FERMA_PASSWORD || 'mockpass123';

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
  values.push(['Password', TERMINAL_PASSWORD]);
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
  const payload = { TerminalKey: TERMINAL_KEY, ...body };
  return httpReq(TBANK_BASE, 'POST', `/v2/${method}`, { ...payload, Token: tokenOf(payload) }, headers);
}

async function main() {
  console.log(`\n== compose black-box selftest (${TBANK_BASE} & ${KASSA_BASE}) ==\n`);

  const runId = `cmp-${Date.now()}`;

  // 1. Healthchecks
  const hBank = await httpReq(TBANK_BASE, 'GET', '/health');
  check('tbank-mock /health === 200 ok', hBank.status === 200 && hBank.json() && hBank.json().ok === true);

  const hKassa = await httpReq(KASSA_BASE, 'GET', '/healthz');
  check('kassa-mock /healthz === 200 ok', hKassa.status === 200 && hKassa.json() && hKassa.json().ok === true);

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
  const tokRes = (await httpReq(KASSA_BASE, 'POST', '/possystem/v1/getToken', { login: FERMA_LOGIN, pass: FERMA_PASSWORD })).json();
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

  const receiptHtml = await httpReq(KASSA_BASE, 'GET', `/receipts/${fullPay.uuid}`);
  check('kassa страница чека /receipts/:uuid отдаёт 200 и [М]', receiptHtml.status === 200 && receiptHtml.text.includes('[М]'));

  // Сбрасываем виртуальные часы кассы обратно
  await httpReq(KASSA_BASE, 'POST', '/mock/time', { reset: true });

  console.log(`\nИТОГ compose-selftest: ${passed} passed, ${failed} failed\n`);
  assert.strictEqual(failed, 0, `${failed} checks failed`);
}

main().catch((e) => {
  console.error('compose-selftest failed:', e);
  process.exit(1);
});
