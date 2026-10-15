// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Selftest kassa-mock: regression matrix for Ferma, 54-ФЗ, tenancy, CSRF,
 * callbacks and OFD workflows. Child servers and callback listeners use
 * ephemeral ports; stateful checks poll for observable outcomes.
 * Запуск: node services/kassa-mock/selftest.js.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

let PORT = 0;
let CALLBACK_PORT = 0;
let BASE = '';
let MAIN_CHILD = null;
// Лог дочернего стенда: нужен для проверок «секретов нет в логах» (#24, F-09).
const SERVER_LOG = [];
let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); } else { failed += 1; console.log(`  ✗ ${name} ${extra}`); }
}

function request(method, url, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null || body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(BASE + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
      timeout: 5000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: buf, json: () => { try { return JSON.parse(buf); } catch { return null; } } }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

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

async function waitForReport(uuid, token, status, timeoutMs = 8000) {
  return waitForCondition(async () => {
    const report = (await request('GET', `/possystem/v1/Main/report/${uuid}?token=${token}`)).json();
    return report && report.status === status ? report : null;
  }, { timeoutMs, description: `receipt ${uuid} → ${status}` });
}

async function main() {
  console.log(`\n== kassa-mock selftest on :${PORT} ==\n`);

  // #31: неправильная tenancy-конфигурация предупреждает и не мешает старту.
  const warningLogOffset = SERVER_LOG.length;
  const invalidTenancyChild = await startKassaChild({ MOCK_TENANCY: 'unexpected-mode' });
  const tenancyStartupLog = SERVER_LOG.slice(warningLogOffset).join('');
  check('#31: неизвестный MOCK_TENANCY пишет WARN и запускается с безопасным namespaces default',
    tenancyStartupLog.includes('WARN Неизвестное значение MOCK_TENANCY')
      && tenancyStartupLog.includes('безопасный режим по умолчанию: namespaces'));
  await stopChild(invalidTenancyChild);

  // 1. healthz
  let r = await request('GET', '/healthz');
  check('healthz ok', r.status === 200 && r.json().ok === true);

  // 2. getToken с плохим паролем
  r = await request('POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'wrong' });
  check('getToken bad password -> error', r.json() && r.json().error && r.json().error.code === 14);

  // 3. getToken ok
  r = await request('POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' });
  const token = r.json() && r.json().token;
  check('getToken ok returns token', Boolean(token));

  // 4. sell без токена
  r = await request('POST', `/possystem/v1/Main/sell`, { external_id: 'x1', receipt: {} });
  check('sell без токена -> error 11', r.json() && r.json().error && r.json().error.code === 11);
  check('DX: error 11 несёт field/hint/doc (спека §6.2)', (() => { const e = r.json().error; return e.field === 'token' && !!e.hint && String(e.doc || '').startsWith('https://'); })());

  // 5. sell ok -> uuid + wait
  const sellBody = {
    external_id: 'lovii-1-prepayment',
    receipt: {
      client: { email: 'buyer@example.com' },
      company: { sno: 'usn_income', inn: '7842223709', payment_address: 'lovi.ru' },
      items: [{ name: 'Пышка', price: 61000, quantity: 1, sum: 61000, payment_method: 'full_prepayment', payment_object: 'commodity', vat: { type: 'none' }, agent_info: { type: 'another' }, supplier_info: { name: 'Пекарня', inn: '7801111111', phones: ['+7800'] } }],
      payments: [{ type: 1, sum: 61000 }],
      total: 61000,
      receipts: { service: { callback_url: `http://127.0.0.1:${CALLBACK_PORT}/fake-core-callback` } },
    },
  };
  r = await request('POST', `/possystem/v1/Main/sell?token=${token}`, sellBody);
  const uuid = r.json() && r.json().uuid;
  check('sell -> uuid + status wait', Boolean(uuid) && r.json().status === 'wait');

  // 6. дубль external_id
  r = await request('POST', `/possystem/v1/Main/sell?token=${token}`, sellBody);
  check('dup external_id -> error 12', r.json() && r.json().error && r.json().error.code === 12);

  // 7. отчёт до обработки: wait
  r = await request('GET', `/possystem/v1/Main/report/${uuid}?token=${token}`);
  check('report сразу -> wait', r.json() && r.json().status === 'wait');

  // 8. callback с ФД/ФП пришёл на callback_url (MOCK_PROCESS_MS=500)
  await waitForCondition(() => global.__callbackHits > 0, { description: 'first receipt callback delivery' });
  check('callback доставлен', global.__callbackHits > 0);

  // 9. отчёт done с фискальными данными
  await waitForReport(uuid, token, 'done');
  r = await request('GET', `/possystem/v1/Main/report/${uuid}?token=${token}`);
  const p = r.json() && r.json().payload;
  check('report -> done + ФД/ФП', Boolean(p && p.fiscal_document_number && p.fiscal_document_attribute && p.ofd_receipt_url));

  // 10. страница чека покупателю
  r = await request('GET', `/receipts/${uuid}`);
  check('страница чека 200 + ИНН поставщика', r.status === 200 && r.text.includes('7801111111'));

  // 10a. Инварианты чека: total ≠ Σ позиций -> ошибка 4 с полем и подсказкой
  r = await request('POST', `/possystem/v1/Main/sell?token=${token}`, {
    external_id: 'bad-total',
    receipt: { client: { email: 'a@b.c' }, items: [{ name: 'X', price: 100, quantity: 1, sum: 100, vat: { type: 'none' } }], payments: [{ type: 1, sum: 100 }], total: 50000 },
  });
  check('валидация: total ≠ Σ позиций -> код 4 + field + hint', r.json().error && r.json().error.code === 4 && r.json().error.field === 'receipt.total' && Boolean(r.json().error.hint));

  // 10b. Инварианты чека: Σ оплат ≠ total -> ошибка 4
  r = await request('POST', `/possystem/v1/Main/sell?token=${token}`, {
    external_id: 'bad-payments',
    receipt: { client: { email: 'a@b.c' }, items: [{ name: 'X', price: 100, quantity: 1, sum: 100, vat: { type: 'none' } }], payments: [{ type: 1, sum: 50 }], total: 100 },
  });
  check('валидация: Σ оплат ≠ total -> код 4', r.json().error && r.json().error.code === 4 && r.json().error.field === 'receipt.payments');

  // 10c. Опечатка в ставке НДС ловится до «печати»
  r = await request('POST', `/possystem/v1/Main/sell?token=${token}`, {
    external_id: 'bad-vat',
    receipt: { client: { email: 'a@b.c' }, items: [{ name: 'X', price: 100, quantity: 1, sum: 100, vat: { type: 'vat120' } }], payments: [{ type: 1, sum: 100 }], total: 100 },
  });
  check('валидация: неизвестный vat.type -> код 4 с подсказкой', r.json().error && r.json().error.code === 4 && r.json().error.field === 'receipt.items[0].vat.type');

  // 10d. Дата чека — реальная (не 1970) и совпадает с processedAt; номер чека в смене уникален
  const p1 = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, { ...sellBody, external_id: 'num-1' })).json();
  const p2 = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, { ...sellBody, external_id: 'num-2' })).json();
  await Promise.all([waitForReport(p1.uuid, token, 'done'), waitForReport(p2.uuid, token, 'done')]);
  const rp1 = (await request('GET', `/possystem/v1/Main/report/${p1.uuid}?token=${token}`)).json();
  const rp2 = (await request('GET', `/possystem/v1/Main/report/${p2.uuid}?token=${token}`)).json();
  check('receipt_datetime не 1970 (снимок после печати)', Boolean(rp1.payload) && !String(rp1.payload.receipt_datetime).startsWith('1970'));
  check('номера чеков в смене уникальны', rp1.payload.fiscal_receipt_number !== rp2.payload.fiscal_receipt_number);

  // 10e. XSS: название позиции экранируется в чеке покупателя
  // sum обязателен (валидатор чека инвариантом sum = price × quantity) —
  // без него запрос отбраковывается до создания документа, и проверка
  // экранирования получала 404 вместо чека.
  const xss = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, { ...sellBody, external_id: 'xss-1', receipt: { ...sellBody.receipt, items: [{ ...sellBody.receipt.items[0], name: '<img src=x onc=alert(1)>', sum: sellBody.receipt.items[0].price * sellBody.receipt.items[0].quantity }] } })).json();
  await waitForReport(xss.uuid, token, 'done');
  r = await request('GET', `/receipts/${xss.uuid}`);
  check('чек покупателя экранирует HTML из данных интегратора', r.status === 200 && !r.text.includes('<img src=x onc=alert(1)>') && r.text.includes('&lt;img'));

  // 10f. F-30: денежные поля и произведение price × quantity — только безопасные
  // целые (≤ 2^53−1 копеек); overflow отклоняется до создания документа.
  {
    const UNSAFE = 2 ** 53; // 9007199254740992 — первый не-safe integer
    const minimal = (extId, over) => ({
      external_id: extId,
      receipt: {
        client: { email: 'a@b.c' },
        items: [{ name: 'X', price: 100, quantity: 1, sum: 100, vat: { type: 'none' } }],
        payments: [{ type: 1, sum: 100 }],
        total: 100,
        ...over,
      },
    });

    // price за границей safe integer -> код 4 на items[0].price
    const bigPrice = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, minimal('unsafe-price', {
      items: [{ name: 'X', price: UNSAFE, quantity: 1, sum: UNSAFE, vat: { type: 'none' } }],
      payments: [{ type: 1, sum: UNSAFE }],
      total: UNSAFE,
    }))).json();
    check('F-30: price за пределами safe integer -> код 4', bigPrice.error && bigPrice.error.code === 4 && bigPrice.error.field === 'receipt.items[0].price');

    // произведение price × quantity переполняет safe integer (sum подан
    // безопасным — срабатывает именно проверка произведения)
    const overflow = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, minimal('unsafe-product', {
      items: [{ name: 'X', price: 4000000000000000, quantity: 3, sum: 4000000000000000, vat: { type: 'none' } }],
      payments: [{ type: 1, sum: 4000000000000000 }],
      total: 4000000000000000,
    }))).json();
    check('F-30: price × quantity вне safe integer -> код 4', overflow.error && overflow.error.code === 4 && overflow.error.field === 'receipt.items[0].sum');

    // итог за границей safe integer -> код 4 на receipt.total
    const bigTotal = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, minimal('unsafe-total', {
      payments: [{ type: 1, sum: UNSAFE }],
      total: UNSAFE,
    }))).json();
    check('F-30: total за пределами safe integer -> код 4', bigTotal.error && bigTotal.error.code === 4 && bigTotal.error.field === 'receipt.total');

    // Σ оплат переполняет безопасный диапазон -> код 4 на payments[1].sum
    const payOverflow = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, minimal('unsafe-pay-sum', {
      items: [{ name: 'X', price: 5000000000000000, quantity: 1, sum: 5000000000000000, vat: { type: 'none' } }],
      payments: [{ type: 1, sum: 5000000000000000 }, { type: 1, sum: 5000000000000000 }],
      total: 5000000000000000,
    }))).json();
    check('F-30: Σ оплат вне safe integer -> код 4', payOverflow.error && payOverflow.error.code === 4 && payOverflow.error.field === 'receipt.payments[1].sum');

    // dry-run /validate ловит те же границы без создания документа
    const dryUnsafe = (await request('POST', '/possystem/v1/validate', minimal('unsafe-dry', {
      payments: [{ type: 1, sum: UNSAFE }],
      total: UNSAFE,
    }))).json();
    check('F-30: /validate отклоняет суммы вне safe integer', dryUnsafe.valid === false && dryUnsafe.error && dryUnsafe.error.code === 4);

    // отказ overflow происходит до изменения state: external_id не занят —
    // повторный sell с тем же external_id и валидными суммами проходит
    const retry = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, minimal('unsafe-price', {
      receipts: { service: { callback_url: `http://127.0.0.1:${CALLBACK_PORT}/fake-core-callback` } },
    }))).json();
    check('F-30: отклонённый sell не занимает external_id (state не менялся)', Boolean(retry.uuid) && retry.status === 'wait');
    await waitForReport(retry.uuid, token, 'done');

    // возврат: сумма вне safe integer -> код 4 до изменения остатка
    const refundUnsafe = (await request('POST', `/possystem/v1/Main/sell_refund?token=${token}`, {
      ...minimal('unsafe-refund', {
        payments: [{ type: 1, sum: UNSAFE }],
        total: UNSAFE,
      }),
      origin_external_id: 'unsafe-price',
    })).json();
    check('F-30: sell_refund с суммой вне safe integer -> код 4', refundUnsafe.error && refundUnsafe.error.code === 4 && refundUnsafe.error.field === 'receipt.total');
  }

  // 10f. Лента чека: НДС считается по позициям (ставка из vat.type)
  const vatDoc = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, { ...sellBody, external_id: 'vat-1', receipt: { ...sellBody.receipt, items: [{ ...sellBody.receipt.items[0], vat: { type: 'vat20' }, sum: sellBody.receipt.items[0].sum }] } })).json();
  await waitForReport(vatDoc.uuid, token, 'done');
  r = await request('GET', `/receipts/${vatDoc.uuid}`);
  check('лента чека: НДС по ставке позиции (vat20 → «НДС 20%»)', r.text.includes('НДС 20%'));

  // 11. негатив fail-
  r = await request('POST', `/possystem/v1/Main/sell?token=${token}`, { ...sellBody, external_id: 'fail-2' });
  const failUuid = r.json().uuid;
  await waitForReport(failUuid, token, 'fail');
  r = await request('GET', `/possystem/v1/Main/report/${failUuid}?token=${token}`);
  check('fail- сценарий -> status fail + error', r.json().status === 'fail' && Boolean(r.json().error));

  // 12. hang- остаётся в wait и не зовёт callback
  r = await request('POST', `/possystem/v1/Main/sell?token=${token}`, { ...sellBody, external_id: 'hang-3' });
  const hangUuid = r.json().uuid;
  r = await request('GET', `/possystem/v1/Main/report/${hangUuid}?token=${token}`);
  check('hang- -> wait', r.json().status === 'wait');

  // 12b. Универсальный драйвер негативов: X-Mock-Scenario на запросе
  // (для внешних интеграторов, чьи external_id не начинаются с fail-/hang-)
  const hdr = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, { ...sellBody, external_id: 'order-42', }, { 'X-Mock-Scenario': 'fail' })).json();
  await waitForReport(hdr.uuid, token, 'fail');
  r = await request('GET', `/possystem/v1/Main/report/${hdr.uuid}?token=${token}`);
  check('X-Mock-Scenario: fail -> статус fail для обычного external_id', r.json().status === 'fail' && r.json().external_id === 'order-42');
  const hdrHang = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, { ...sellBody, external_id: 'order-43' }, { 'X-Mock-Scenario': 'hang' })).json();
  r = await request('GET', `/possystem/v1/Main/report/${hdrHang.uuid}?token=${token}`);
  check('X-Mock-Scenario: hang -> вечный wait', r.json().status === 'wait');

  // F-06: http-500/http-504 должны прервать request до создания документа.
  const chaosHealthBefore = (await request('GET', '/healthz')).json();
  for (const status of [500, 504]) {
    const chaosResponse = await request('POST', `/possystem/v1/Main/sell?token=${token}`, {
      ...sellBody,
      external_id: `chaos-http-${status}`,
    }, { 'X-Mock-Scenario': `http-${status}` });
    check(`X-Mock-Scenario: http-${status} -> HTTP ${status}`, chaosResponse.status === status);
    const chaosBody = chaosResponse.json();
    check(`chaos http-${status} -> provider-shaped error`, chaosBody && chaosBody.error && chaosBody.error.code === status
      && chaosBody.error.field === 'X-Mock-Scenario');
  }
  const chaosHealthAfter = (await request('GET', '/healthz')).json();
  check('chaos http-500/504 не меняет счётчики/очередь', chaosHealthAfter.checks === chaosHealthBefore.checks
    && chaosHealthAfter.ofdQueueCount === chaosHealthBefore.ofdQueueCount
    && chaosHealthAfter.fnUsed === chaosHealthBefore.fnUsed);

  // #52 PA-51/PB-13/PG-09: сценарии, история и журнал — per-sandbox.
  {
    const isoA = { 'X-Mock-Sandbox': 'sc52-a' };
    const isoB = { 'X-Mock-Sandbox': 'sc52-b' };
    const tokA = (await request('POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' }, isoA)).json().token;
    const tokB = (await request('POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' }, isoB)).json().token;
    await request('POST', '/mock/scenarios', { scenario: 'fail', target: 'sell', persistent: true }, isoA);
    const seenByB = await request('GET', '/mock/scenarios', null, isoB);
    check('#52: правила песочницы A не видны B', seenByB.json().rules.length === 0 && seenByB.json().history.length === 0);
    const sellB = await request('POST', `/possystem/v1/Main/sell?token=${tokB}`, { ...sellBody, external_id: 'sc52-b-1' }, isoB);
    check('#52: правило A не влияет на документ B (uuid выдан)', sellB.status === 200 && Boolean(sellB.json().uuid), sellB.text.slice(0, 120));
    const histB0 = await request('GET', '/mock/scenarios', null, isoB);
    check('#52: срабатывания правила A в истории B нет', histB0.json().history.length === 0);
    await request('POST', `/possystem/v1/Main/sell?token=${tokB}`, { ...sellBody, external_id: 'sc52-b-hist' }, { ...isoB, 'X-Mock-Scenario': 'webhook-drop' });
    await request('POST', `/possystem/v1/Main/sell?token=${tokA}`, { ...sellBody, external_id: 'sc52-a-1' }, isoA);
    const histA = await request('GET', '/mock/scenarios', null, isoA);
    check('#52: история B (external_id) не видна A', !JSON.stringify(histA.json().history).includes('sc52-b-hist'));
    const journalA = await request('GET', '/admin/journal', null, isoA);
    const journalB = await request('GET', '/admin/journal', null, isoB);
    check('#52 PB-13: журналы A и B не пересекаются', journalA.text.includes('sc52-a-1') && !journalA.text.includes('sc52-b-1')
      && journalB.text.includes('sc52-b-1') && !journalB.text.includes('sc52-a-1'));
    await request('POST', '/mock/scenarios', { id: 'sc52-own', scenario: 'webhook-drop', persistent: true }, isoB);
    await request('POST', '/mock/reset', {}, isoA);
    const afterResetB = await request('GET', '/mock/scenarios', null, isoB);
    const journalAfterB = await request('GET', '/admin/journal', null, isoB);
    check('#52 PG-09/PB-13: reset A не стирает правила и журнал B', afterResetB.json().rules.some((r) => r.id === 'sc52-own')
      && journalAfterB.text.includes('sc52-b-1'));
    const tooBig = await request('POST', '/mock/scenarios', { scenario: 'fail', match: { pad: 'x'.repeat(9000) } }, isoA);
    check('#52: правило >8 KiB -> 400 + code rule_too_large', tooBig.status === 400 && tooBig.json().code === 'rule_too_large', tooBig.text.slice(0, 140));
    await request('POST', '/mock/scenarios', { id: 'sc52-upd', scenario: 'fail', persistent: true }, isoA);
    await request('POST', '/mock/scenarios', { id: 'sc52-upd', scenario: 'webhook-drop', persistent: true }, isoA);
    const updBig = await request('POST', '/mock/scenarios', { id: 'sc52-upd', scenario: 'fail', match: { pad: 'x'.repeat(9000) } }, isoA);
    const updList = await request('GET', '/mock/scenarios', null, isoA);
    check('#52: update по id; oversized update -> 400 без затирания старого', updBig.status === 400
      && updBig.json().code === 'rule_too_large' && updList.json().rules.filter((r) => r.id === 'sc52-upd').length === 1
      && updList.json().rules.find((r) => r.id === 'sc52-upd').scenario === 'webhook-drop');
    await request('DELETE', '/mock/scenarios', null, isoA);
    let capStatus = 0;
    for (let i = 0; i < 200; i += 1) {
      capStatus = (await request('POST', '/mock/scenarios', { id: `sc52-cap-${i}`, scenario: 'fail', persistent: true }, isoA)).status;
    }
    const capOver = await request('POST', '/mock/scenarios', { id: 'sc52-cap-200', scenario: 'fail' }, isoA);
    const capList = await request('GET', '/mock/scenarios', null, isoA);
    check('#52: cap 200; 201-е -> 400 + code rule_cap_exceeded', capStatus === 200 && capOver.status === 400
      && capOver.json().code === 'rule_cap_exceeded' && capList.json().rules.length === 200);
    await request('DELETE', '/mock/scenarios', null, isoB);
  }

  // 13. stats кассы
  r = await request('GET', `/possystem/v1/stats/cashboxes/extended?token=${token}`);
  check('stats: Готова к работе', r.json().Status === 'Success' && r.json().Data[0].kktState === 'Готова к работе');

  /* --- Этап 6–7 (бриф 2026-10-11): полнота 54-ФЗ, ОФД, маркировка, сценарии --- */

  // 14. buy / buy_refund (расход / возврат расхода) в обычной (неагентской) схеме + связка origin_external_id
  const buyRes = (await request('POST', `/possystem/v1/Main/buy?token=${token}`, {
    external_id: 'buy-plain-1',
    receipt: {
      client: { phone: '+79990001122' },
      company: { sno: 'usn_income_outcome', payment_address: 'shop.test' },
      items: [{ name: 'Выкуп вторсырья', price: 45000, quantity: 2, sum: 90000, payment_method: 'full_payment', payment_object: 'commodity', vat: { type: 'vat5' }, measure_unit: 11 }],
      payments: [{ type: 1, sum: 90000 }],
      total: 90000,
    },
  })).json();
  check('buy (неагентский расход) -> uuid + wait', Boolean(buyRes && buyRes.uuid && buyRes.status === 'wait'));

  // Частичный возврат расхода (buy_refund) с привязкой к buy-plain-1
  const buyRefundRes = (await request('POST', `/possystem/v1/Main/buy_refund?token=${token}`, {
    external_id: 'buy-refund-1',
    origin_external_id: 'buy-plain-1',
    receipt: {
      client: { phone: '+79990001122' },
      items: [{ name: 'Выкуп вторсырья', price: 45000, quantity: 1, sum: 45000, payment_method: 'full_payment', payment_object: 'commodity', vat: { type: 'vat5' } }],
      payments: [{ type: 1, sum: 45000 }],
      total: 45000,
    },
  })).json();
  check('buy_refund с origin_external_id в пределах суммы -> ok', Boolean(buyRefundRes && buyRefundRes.uuid));

  // Повторный buy_refund сверх оставшегося лимита (осталось 45000, просим 90000) -> ошибка 4
  const buyRefundTooBig = (await request('POST', `/possystem/v1/Main/buy_refund?token=${token}`, {
    external_id: 'buy-refund-over',
    origin_external_id: 'buy-plain-1',
    receipt: {
      client: { phone: '+79990001122' },
      items: [{ name: 'Выкуп вторсырья', price: 45000, quantity: 2, sum: 90000, payment_method: 'full_payment', payment_object: 'commodity', vat: { type: 'vat5' } }],
      payments: [{ type: 1, sum: 90000 }],
      total: 90000,
    },
  })).json();
  check('buy_refund сверх остатка исходного чека -> код 4', buyRefundTooBig.error && buyRefundTooBig.error.code === 4 && buyRefundTooBig.error.field === 'receipt.total');

  // 15. Аванс / предоплата ( расчётная ставка vat20_120 ) -> Полный расчёт (зачёт аванса type=2)
  const prepayDoc = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, {
    external_id: 'adv-100',
    receipt: {
      client: { email: 'adv@test.ru' },
      items: [{ name: 'Сертификат / предоплата заказа', price: 120000, quantity: 1, sum: 120000, payment_method: 'full_prepayment', payment_object: 'payment', vat: { type: 'vat20_120' } }],
      payments: [{ type: 1, sum: 120000 }],
      total: 120000,
    },
  })).json();
  check('чек предоплаты с расчётным НДС vat20_120 принят', Boolean(prepayDoc && prepayDoc.uuid));

  const offsetDoc = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, {
    external_id: 'full-after-adv-100',
    prepayment_external_id: 'adv-100',
    receipt: {
      client: { email: 'adv@test.ru' },
      items: [{ name: 'Заказ по предоплате', price: 120000, quantity: 1, sum: 120000, payment_method: 'full_payment', payment_object: 'commodity', vat: { type: 'vat22' } }],
      payments: [{ type: 2, sum: 120000 }], // type 2 = зачёт предоплаты (аванса)
      total: 120000,
    },
  })).json();
  check('зачёт предоплаты (type=2 + prepayment_external_id) принят', Boolean(offsetDoc && offsetDoc.uuid));

  const doubleOffset = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, {
    external_id: 'full-after-adv-100-dup',
    prepayment_external_id: 'adv-100',
    receipt: {
      client: { email: 'adv@test.ru' },
      items: [{ name: 'Повторный зачёт', price: 120000, quantity: 1, sum: 120000, payment_method: 'consideration', payment_object: 'commodity', vat: { type: 'vat22' } }],
      payments: [{ type: 2, sum: 120000 }],
      total: 120000,
    },
  })).json();
  check('повторный зачёт уже погашенного аванса -> код 4', doubleOffset.error && doubleOffset.error.code === 4 && doubleOffset.error.field === 'receipt.payments');

  // 16. Валидация ИНН поставщика и маркировки (Честный ЗНАК, ФФД 1.2)
  const badSupplierInn = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, {
    external_id: 'bad-inn-1',
    receipt: {
      client: { email: 'a@b.c' },
      items: [{ name: 'Товар', price: 1000, quantity: 1, sum: 1000, vat: { type: 'none' }, supplier_info: { name: 'ООО Тест', inn: '12345' } }],
      payments: [{ type: 1, sum: 1000 }],
      total: 1000,
    },
  })).json();
  check('валидация: невалидный ИНН поставщика -> код 4', badSupplierInn.error && badSupplierInn.error.code === 4 && badSupplierInn.error.field === 'receipt.items[0].supplier_info.inn');

  const missingMark = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, {
    external_id: 'mark-missing-1',
    receipt: {
      client: { email: 'a@b.c' },
      items: [{ name: 'Вода маркированная', price: 5000, quantity: 1, sum: 5000, vat: { type: 'vat20' }, payment_object: 'marked_commodity' }],
      payments: [{ type: 1, sum: 5000 }],
      total: 5000,
    },
  })).json();
  check('валидация: marked_commodity без кода маркировки -> код 4', missingMark.error && missingMark.error.code === 4 && missingMark.error.field === 'receipt.items[0].marking_code');

  const markedOk = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, {
    external_id: 'mark-ok-1',
    receipt: {
      client: { email: 'a@b.c' },
      items: [{
        name: 'Сыр маркированный',
        price: 35000,
        quantity: 1,
        sum: 35000,
        vat: { type: 'vat7' },
        payment_method: 'full_payment',
        payment_object: 'marked_commodity',
        measure_unit: 0,
        marking_code: '010460000000000021abcDEF1234567',
        mark_quantity: { numerator: 1, denominator: 5 },
      }],
      payments: [{ type: 1, sum: 35000 }],
      total: 35000,
    },
  })).json();
  check('маркированный товар с КМ и mark_quantity принят', Boolean(markedOk && markedOk.uuid));

  const markFailDoc = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, {
    external_id: 'mark-fail-1',
    receipt: {
      client: { email: 'a@b.c' },
      items: [{
        name: 'Табак',
        price: 20000,
        quantity: 1,
        sum: 20000,
        vat: { type: 'vat20' },
        payment_object: 'marked_excise',
        marking_code: '010460000000000021badCODE9999',
      }],
      payments: [{ type: 1, sum: 20000 }],
      total: 20000,
    },
  }, { 'X-Mock-Scenario': 'mark-fail' })).json();

  // 17. Очередь ОФД и статусы «ждёт/передан/отказ» (pending / sent / rejected)
  const ofdPendingDoc = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, {
    external_id: 'ofd-q-1',
    receipt: {
      client: { email: 'ofd@test.ru' },
      items: [{ name: 'Кофе', price: 15000, quantity: 1, sum: 15000, vat: { type: 'vat5' } }],
      payments: [{ type: 1, sum: 15000 }],
      total: 15000,
    },
  }, { 'X-Mock-Scenario': 'ofd-queue, webhook-drop' })).json();

  const ofdRejectDoc = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, {
    external_id: 'ofd-rej-1',
    receipt: {
      client: { email: 'ofd@test.ru' },
      items: [{ name: 'Чай', price: 10000, quantity: 1, sum: 10000, vat: { type: 'none' } }],
      payments: [{ type: 1, sum: 10000 }],
      total: 10000,
    },
  }, { 'X-Mock-Scenario': 'ofd-reject' })).json();

  await Promise.all([
    waitForReport(markedOk.uuid, token, 'done'),
    waitForReport(markFailDoc.uuid, token, 'fail'),
    waitForReport(ofdPendingDoc.uuid, token, 'done'),
    waitForReport(ofdRejectDoc.uuid, token, 'done'),
  ]);

  const markedReport = (await request('GET', `/possystem/v1/Main/report/${markedOk.uuid}?token=${token}`)).json();
  check('отчёт маркированного чека содержит marking_verified + vat_amounts (vat7)', Boolean(markedReport.payload && markedReport.payload.marking_verified === true && markedReport.payload.marked_items_count === 1));
  const markedReceiptPage = await request('GET', `/receipts/${markedOk.uuid}`);
  check('лента маркированного чека печатает [М] и КМ', markedReceiptPage.status === 200 && markedReceiptPage.text.includes('[М]') && markedReceiptPage.text.includes('НДС 7%'));

  const markFailReport = (await request('GET', `/possystem/v1/Main/report/${markFailDoc.uuid}?token=${token}`)).json();
  check('X-Mock-Scenario: mark-fail -> status fail + код 58', markFailReport.status === 'fail' && markFailReport.error && markFailReport.error.code === 58);

  const ofdPendingReport = (await request('GET', `/possystem/v1/Main/report/${ofdPendingDoc.uuid}?token=${token}`)).json();
  check('X-Mock-Scenario: ofd-queue -> чек done в ККТ, но ofd_status=pending', ofdPendingReport.status === 'done' && ofdPendingReport.ofd_status === 'pending');

  const ofdQueueRes = (await request('GET', '/possystem/v1/ofd/queue')).json();
  check('GET /possystem/v1/ofd/queue показывает документ в очереди ОФД', ofdQueueRes.count >= 1 && ofdQueueRes.items.some((i) => i.uuid === ofdPendingDoc.uuid && i.status === 'pending'));

  const ofdRejReport = (await request('GET', `/possystem/v1/Main/report/${ofdRejectDoc.uuid}?token=${token}`)).json();
  check('X-Mock-Scenario: ofd-reject -> ofd_status=rejected + ofd_error', ofdRejReport.ofd_status === 'rejected' && Boolean(ofdRejReport.ofd_error));

  // Прокачка очереди ОФД (flush) -> pending переходит в sent
  const flushRes = (await request('POST', '/possystem/v1/ofd/mode', { mode: 'online', flush: true })).json();
  const ofdAfterFlush = (await request('GET', `/possystem/v1/Main/report/${ofdPendingDoc.uuid}?token=${token}`)).json();
  check('POST /possystem/v1/ofd/mode {flush:true} -> ofd_status=sent', flushRes.flushed >= 1 && ofdAfterFlush.ofd_status === 'sent');

  // 18. Виртуальные часы (/mock/time): сдвиг на +13h делает 12-часовой токен просроченным мгновенно
  const vClockSnap = (await request('POST', '/mock/time', { advance: '13h' })).json();
  check('POST /mock/time {advance:"13h"} сдвигает виртуальные часы', vClockSnap.offsetMs >= 13 * 3600 * 1000);
  const expiredByClock = (await request('GET', `/possystem/v1/Main/report/${uuid}?token=${token}`)).json();
  check('после сдвига часов на +13h токен (TTL 12ч) возвращает код 11', expiredByClock.error && expiredByClock.error.code === 11);
  await request('POST', '/mock/time', { reset: true });

  // Получаем свежий токен для проверок смен, ФН, позиционного возврата и dry-run
  const freshToken = (await request('POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' })).json().token;
  const validBody = (extId) => JSON.parse(JSON.stringify({ ...sellBody, external_id: extId }));

  // 19. Смены ККТ и Z-отчёты (/possystem/v1/shift/* + ограничение 24 часа 54-ФЗ -> код 62)
  const shiftClose = (await request('POST', '/possystem/v1/shift/close', {})).json();
  check('POST /possystem/v1/shift/close закрывает смену и формирует Z-отчёт', shiftClose.ok === true && shiftClose.zReport && shiftClose.zReport.fdNumber > 0);
  const closedShiftReceipt = (await request('POST', `/possystem/v1/Main/sell?token=${freshToken}`, validBody('sell-closed-shift'))).json();
  check('попытка фискализации при закрытой смене -> код 62', closedShiftReceipt.error && closedShiftReceipt.error.code === 62);
  const shiftOpen = (await request('POST', '/possystem/v1/shift/open', {})).json();
  check('POST /possystem/v1/shift/open открывает новую смену', shiftOpen.ok === true && shiftOpen.status === 'open');
  // Сдвигаем часы на +25 часов (больше 24ч лимита смены по 54-ФЗ), предварительно обновив токен после сдвига
  await request('POST', '/mock/time', { advance: '25h' });
  const tokAfter25h = (await request('POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' })).json().token;
  const expiredShiftReceipt = (await request('POST', `/possystem/v1/Main/sell?token=${tokAfter25h}`, validBody('sell-expired-shift'))).json();
  check('смена открыта > 24 часов (ст. 4.3 54-ФЗ) -> код 62', expiredShiftReceipt.error && expiredShiftReceipt.error.code === 62);
  await request('POST', '/mock/time', { reset: true });
  const tokNormal = (await request('POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' })).json().token;

  // 20. Ресурс и переполнение ФН (/possystem/v1/fn/state -> код 63)
  await request('POST', '/possystem/v1/fn/state', { capacity: 10, used: 10 });
  const fnOverflowReceipt = (await request('POST', `/possystem/v1/Main/sell?token=${tokNormal}`, validBody('sell-fn-overflow'))).json();
  check('переполнение фискального накопителя (used >= capacity) -> код 63', fnOverflowReceipt.error && fnOverflowReceipt.error.code === 63);
  const fnReset = (await request('POST', '/possystem/v1/fn/state', { reset: true, capacity: 250000, fnNumber: '9999078902009999' })).json();
  check('POST /possystem/v1/fn/state {reset:true} сбрасывает счётчик ФН', fnReset.ok === true && fnReset.used === 0 && fnReset.overflow === false);

  // 21. Позиционный контроль количества при возврате (origin_external_id)
  const parentMulti = validBody('sell-multi-qty');
  parentMulti.receipt.items = [
    { name: 'Наушники', price: 10000, quantity: 2, sum: 20000, vat: { type: 'none' }, payment_method: 'full_payment', payment_object: 'commodity' },
    { name: 'Чехол', price: 5000, quantity: 1, sum: 5000, vat: { type: 'none' }, payment_method: 'full_payment', payment_object: 'commodity' },
  ];
  parentMulti.receipt.payments = [{ type: 1, sum: 25000 }];
  parentMulti.receipt.total = 25000;
  await request('POST', `/possystem/v1/Main/sell?token=${tokNormal}`, parentMulti);

  // Пытаемся вернуть 3 шт. «Наушники» по 5000 (сумма 15000 <= 25000, но количество 3 > 2 проданных!)
  const badItemQtyRefund = validBody('refund-bad-item-qty');
  badItemQtyRefund.origin_external_id = 'sell-multi-qty';
  badItemQtyRefund.receipt.items = [
    { name: 'Наушники', price: 5000, quantity: 3, sum: 15000, vat: { type: 'none' }, payment_method: 'full_payment', payment_object: 'commodity' },
  ];
  badItemQtyRefund.receipt.payments = [{ type: 1, sum: 15000 }];
  badItemQtyRefund.receipt.total = 15000;
  const badQtyRes = (await request('POST', `/possystem/v1/Main/sell_refund?token=${tokNormal}`, badItemQtyRefund)).json();
  check('позиционный контроль возврата: возврат 3 шт. при 2 проданных -> код 4 на items[0].quantity',
    badQtyRes.error && badQtyRes.error.code === 4 && badQtyRes.error.field === 'receipt.items[0].quantity');

  // 22. Dry-run валидация чека без фискализации (POST /possystem/v1/validate)
  const dryOk = (await request('POST', '/possystem/v1/validate', validBody('dry-run-ok'))).json();
  check('POST /possystem/v1/validate на валидном чеке -> valid=true без записи в реестр',
    dryOk.valid === true && dryOk.total === 61000);
  const dryBadBody = validBody('dry-run-bad');
  dryBadBody.receipt.total = 99999;
  const dryBad = (await request('POST', '/possystem/v1/validate', dryBadBody)).json();
  check('POST /possystem/v1/validate на битом чеке -> valid=false + error.field',
    dryBad.valid === false && dryBad.error && dryBad.error.field === 'receipt.total');

  // 23. Мульти-песочницы (X-Mock-Sandbox), активный экзаменатор вебхуков и curl в /admin/journal
  const sbHealth = (await request('GET', '/healthz', null, { 'X-Mock-Sandbox': 'worker-kassa-2' })).json();
  check('X-Mock-Sandbox изолирует состояние кассы (checks=0 в новой песочнице)',
    sbHealth.sandbox === 'worker-kassa-2' && sbHealth.checks === 0);
  await request('POST', '/mock/sandboxes', { sandbox: 'default' });

  const verifyMerchantRes = (await request('POST', '/mock/verify-merchant', { url: `http://127.0.0.1:${CALLBACK_PORT}/callback` })).json();
  check('POST /mock/verify-merchant проверяет callback мерчанта (readyForProd=true)',
    verifyMerchantRes.ok === true && verifyMerchantRes.readyForProd === true);

  const journalResp = (await request('GET', '/admin/journal')).json();
  check('/admin/journal содержит готовый curl-сниппет для воспроизведения',
    Array.isArray(journalResp.entries) && journalResp.entries.length > 0 && journalResp.entries[journalResp.entries.length - 1].curl.startsWith('curl '));
  const tokenEntry = journalResp.entries.find((entry) => String(entry.path).includes('/Main/sell?token='));
  check('#23 F-04: Kassa сохраняет query-token в сниппете только как YOUR_TOKEN',
    Boolean(tokenEntry && tokenEntry.path.includes('token=YOUR_TOKEN') && tokenEntry.curl.includes('token=YOUR_TOKEN')
      && !tokenEntry.path.includes(token) && !tokenEntry.curl.includes(token)));

  // 23b. #24 (F-09): креды getToken (login/pass) и выданный токен не попадают
  //      ни в журнал (JSON, HTML, curl), ни в лог стенда.
  {
    const sentinelPass = `sentinel-pass-${process.pid}`;
    const denied = (await request('POST', '/possystem/v1/getToken', { login: 'loviitest', pass: sentinelPass })).json();
    check('#24: getToken с чужим паролем -> error 14', Boolean(denied && denied.error && denied.error.code === 14));
    const issuedToken = (await request('POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' })).json().token;
    check('#24: getToken с верным паролем выдаёт токен', Boolean(issuedToken));

    const redactedJournal = (await request('GET', '/admin/journal')).json();
    const journalText = JSON.stringify(redactedJournal);
    check('#24: пароль getToken отсутствует в /admin/journal',
      !journalText.includes(sentinelPass) && !journalText.includes('mockpass123'));
    check('#24: логин getToken отсутствует в /admin/journal', !journalText.includes('loviitest'));
    check('#24: выданный токен не хранится в журнале', !journalText.includes(issuedToken));

    // В журнал Kassa попадает тело запроса (выжимка + rawBody), поэтому
    // проверяем обе формы: и выжимку, и сырое тело, и curl-сниппет.
    const getTokenEntries = (redactedJournal.entries || []).filter((entry) => String(entry.path).includes('/getToken'));
    check('#24: запись getToken хранит креды только как [REDACTED]',
      getTokenEntries.length >= 2
      && getTokenEntries.every((entry) => String(entry.rawBody).includes('"pass":"[REDACTED]"')
        && String(entry.rawBody).includes('"login":"[REDACTED]"')
        && !String(entry.rawBody).includes(sentinelPass)
        && entry.body && entry.body.pass === '[REDACTED]' && entry.body.login === '[REDACTED]'));
    check('#24: curl-сниппет getToken воспроизводим без секретов',
      getTokenEntries.every((entry) => String(entry.curl).startsWith('curl ')
        && entry.curl.includes('"pass":"[REDACTED]"')
        && !entry.curl.includes(sentinelPass)));

    const adminHtml = await request('GET', '/admin');
    check('#24: пароль getToken отсутствует в HTML-консоли',
      adminHtml.status === 200 && !adminHtml.text.includes(sentinelPass) && !adminHtml.text.includes('mockpass123'));

    const serverLog = SERVER_LOG.join('\n');
    check('#24: креды getToken отсутствуют в логе стенда',
      serverLog.length > 0 && !serverLog.includes(sentinelPass) && !serverLog.includes('mockpass123') && !serverLog.includes('loviitest'));
    check('#24: в логе остаётся различимый префикс логина (DX)', serverLog.includes('login=lo***'));
    await stopChild(MAIN_CHILD);
    MAIN_CHILD = null;
  }

  /* --- #22 (F-07/F-08): доступ к управляющей поверхности и SSRF-политика --- */

  // 24. Токены управляющей поверхности: /mock/*, смены, ФН и ОФД закрыты,
  //     контракт Ferma (getToken/sell) управляющего токена не требует
  {
    const child = await startKassaChild({ MOCK_ADMIN_TOKEN: 'adm-secret', MOCK_OPERATOR_TOKEN: 'op-secret' });
    try {
      const guarded = [
        ['GET', '/mock/state'], ['GET', '/mock/time'], ['GET', '/mock/sandboxes'],
        ['GET', '/possystem/v1/shift/status'], ['POST', '/possystem/v1/shift/open'],
        ['GET', '/possystem/v1/fn/state'], ['POST', '/possystem/v1/ofd/mode'],
        ['GET', '/possystem/v1/ofd/queue'], ['GET', '/admin/journal'],
      ];
      for (const [method, url] of guarded) {
        const r = await requestOn(child.port, method, url, method === 'POST' ? {} : null);
        check(`#22: ${method} ${url} без токена -> 401`, r.status === 401, `получено ${r.status}`);
      }
      const badTok = await requestOn(child.port, 'GET', '/mock/state', null, { Authorization: 'Bearer nope' });
      check('#22: неверный управляющий токен -> 401', badTok.status === 401);
      const opState = await requestOn(child.port, 'GET', '/mock/state', null, { Authorization: 'Bearer op-secret' });
      check('#22: operator-токен открывает /mock/state', opState.status === 200);
      const opShift = await requestOn(child.port, 'GET', '/possystem/v1/shift/status', null, { 'X-Operator-Token': 'op-secret' });
      check('#22: X-Operator-Token открывает /shift/status', opShift.status === 200);
      const opFn = await requestOn(child.port, 'POST', '/possystem/v1/fn/state', { reset: true }, { Authorization: 'Bearer op-secret' });
      check('#22: operator-токен открывает POST /fn/state', opFn.status === 200);
      const operatorOnAdmin = await requestOn(child.port, 'GET', '/admin/journal', null, { Authorization: 'Bearer op-secret' });
      check('#22: operator-токен не открывает /admin', operatorOnAdmin.status === 401);
      const adminOnAdmin = await requestOn(child.port, 'GET', '/admin/journal', null, { Authorization: 'Bearer adm-secret' });
      check('#22: админ-токен открывает /admin/journal', adminOnAdmin.status === 200);
      const loginRes = await requestOn(child.port, 'POST', '/admin/login', new URLSearchParams({ admin_token: 'adm-secret' }).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
      check('#5 A-20: POST login устанавливает cookie', loginRes.status === 302 && (loginRes.headers['set-cookie'] || []).some(c => c.includes('mock_admin_token=')));
      const sessionCookie = loginRes.headers['set-cookie'][0].split(';')[0];
      
      const adminPage = await requestOn(child.port, 'GET', '/admin', '', { 'Cookie': sessionCookie });
      const html = String(adminPage.text || adminPage.body);
      const actionStart = html.indexOf('action="') + 8;
      const actionEnd = html.indexOf('"', actionStart);
      const actionUrl = actionStart > 7 ? html.slice(actionStart, actionEnd) : '/admin/action';
      const csrfStart = html.indexOf('name="_csrf" value="') + 20;
      const csrfEnd = html.indexOf('"', csrfStart);
      const csrfToken = csrfStart > 19 ? html.slice(csrfStart, csrfEnd) : 'missing';
      
      check('#5 A-20: cookie доступ работает, токенов в action URL нет',
        adminPage.status === 200 && Boolean(csrfToken) && !actionUrl.includes('admin_token'));
      const form = (fields) => new URLSearchParams(fields).toString();
      const deniedNoCsrf = await requestOn(child.port, 'POST', actionUrl, form({ action: 'ofd-offline' }), { 'Cookie': sessionCookie, 'Content-Type': 'application/x-www-form-urlencoded' });
      check('#5 A-20: действие без CSRF-токена отклоняется', deniedNoCsrf.status === 403);
      const deniedCrossOrigin = await requestOn(child.port, 'POST', actionUrl, form({ action: 'ofd-offline', _csrf: csrfToken }), {
        'Cookie': sessionCookie, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://attacker.invalid',
      });
      check('#5 A-20: same-origin проверка отклоняет cross-site форму', deniedCrossOrigin.status === 403);
      
      const portForOrigin = await child.port;
      const validAction = await requestOn(child.port, 'POST', actionUrl, form({ action: 'ofd-offline', _csrf: csrfToken }), { 
        'Cookie': sessionCookie, 'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'http://127.0.0.1:' + portForOrigin
      });
      check('#5 A-20/Ф-1: CSRF-форма работает, redirect без токенов в URL (Location=/admin)',
        validAction.status === 302 && validAction.headers.location === '/admin');
      const redirectedAdmin = await requestOn(child.port, 'GET', validAction.headers.location || '/admin', '', { 'Cookie': sessionCookie });
      check('#5 A-20/Ф-1: redirect возвращает в консоль по cookie-сессии', redirectedAdmin.status === 200);

      // Ф-1 (#121): вход в консоль по query-токену (non-hosted DX) переносит токен
      // в HttpOnly-cookie, а HTML/Location токенов больше не содержат.
      const adminByQuery = await requestOn(child.port, 'GET', '/admin?admin_token=adm-secret');
      check('Ф-1: GET /admin?admin_token=… в non-hosted доступен и не эхо-ит токен',
        adminByQuery.status === 200 && !String(adminByQuery.text).includes('adm-secret'));
      const queryCookie = (adminByQuery.headers['set-cookie'] || []).find((c) => c.startsWith('mock_admin_token=adm-secret'));
      check('Ф-1: принятый из query токен перенесён в HttpOnly-cookie', Boolean(queryCookie));
      const actionByQuery = await requestOn(child.port, 'POST', '/admin/action?admin_token=adm-secret',
        form({ action: 'ofd-online', _csrf: csrfToken }),
        { 'Cookie': queryCookie.split(';')[0], 'Content-Type': 'application/x-www-form-urlencoded' });
      check('Ф-1: Location действия не содержит admin_token/sandbox_token',
        actionByQuery.status === 302
          && !String(actionByQuery.headers.location || '').includes('adm-secret')
          && !String(actionByQuery.headers.location || '').includes('sandbox_token'),
        `location=${actionByQuery.headers.location}`);
      const tk = (await requestOn(child.port, 'POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' })).json().token;
      check('#22: getToken (контракт Ferma) не требует operator-токена', Boolean(tk));
      const sell = await requestOn(child.port, 'POST', `/possystem/v1/Main/sell?token=${tk}`, validBody('auth-check-1'));
      check('#22: sell (контракт Ferma) не требует operator-токена', Boolean(sell.json() && sell.json().uuid));
    } finally {
      await stopChild(child);
    }
  }

  // #23 F-01/F-02: опасный снимок отклоняется до изменения state, а тело
  // выше byte-limit возвращает контролируемый 413 с DX-ошибкой.
  {
    const child = await startKassaChild({ MOCK_OPERATOR_TOKEN: 'op-secret' });
    const auth = { Authorization: 'Bearer op-secret' };
    try {
      const before = (await requestOn(child.port, 'GET', '/mock/state', null, auth)).json().state;
      const unsafe = '{"payments":{"__proto__":{"sandbox":"f01-polluted"}}}';
      const rejected = await requestOn(child.port, 'POST', '/mock/state', unsafe, auth);
      const error = rejected.json() && rejected.json().error;
      check('#23 F-01: /mock/state отклоняет __proto__ с DX-ошибкой 400',
        rejected.status === 400 && error && error.code === 4 && error.field === 'state'
          && String(error.text).includes('__proto__') && Boolean(error.hint));

      const switchAfterReject = await requestOn(child.port, 'POST', '/mock/sandboxes', {}, auth);
      check('#23 F-01: импорт не загрязнил Object.prototype (пустой body не переключает sandbox)',
        switchAfterReject.status === 200 && switchAfterReject.json().current === 'default');
      const after = (await requestOn(child.port, 'GET', '/mock/state', null, auth)).json().state;
      check('#23 F-01: отклонённый импорт не меняет state', JSON.stringify(after) === JSON.stringify(before));

      const oversized = await requestOn(child.port, 'POST', '/mock/state', ' '.repeat(5 * 1024 * 1024 + 1), auth);
      const bodyError = oversized.json() && oversized.json().error;
      check('#23 F-02: /mock/state отдаёт 413 + DX при лимит+1',
        oversized.status === 413 && bodyError && bodyError.code === 4 && bodyError.field === 'body'
          && Boolean(bodyError.hint));
    } finally {
      await stopChild(child);
    }
  }

  // 25. Hosted-режим без секрета: управляющая поверхность fail-closed (MS-06),
  //     default не отдаётся бизнес-API (MS-12, #121), /healthz публичный
  {
    const child = await startKassaChild({ MOCK_HOSTED: '1' });
    try {
      const st = await requestOn(child.port, 'GET', '/mock/state');
      check('#22: hosted без секрета: /mock/state закрыт (fail-closed)', st.status === 401 && st.text.includes('hosted'));
      const fn = await requestOn(child.port, 'GET', '/possystem/v1/fn/state');
      check('#22: hosted без секрета: /fn/state (управляющая поверхность) закрыт', fn.status === 401);
      const health = await requestOn(child.port, 'GET', '/healthz');
      check('#22: hosted: /healthz публичный', health.status === 200);
      const tk = await requestOn(child.port, 'POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' });
      check('#22/MS-12: hosted без секрета: контракт Ferma закрыт до появления песочницы',
        tk.status === 404 && tk.text.includes('MOCK_SANDBOX_TOKEN'), `status=${tk.status}`);
      const queryOnBiz = await requestOn(child.port, 'POST', '/possystem/v1/getToken?sandbox_token=owner-secret', { login: 'loviitest', pass: 'mockpass123' });
      check('Ф-3: hosted отвергает ?sandbox_token на бизнес-маршруте', queryOnBiz.status === 401 && queryOnBiz.text.includes('X-Sandbox-Token'));
      const createNamed = await requestOn(child.port, 'POST', '/sandboxes', { sandbox: 'ms12-named' });
      check('MS-12: при закрытой default именованная песочница создаётся', createNamed.status === 201 && Boolean(createNamed.json().ownerToken));
      const named = createNamed.json();
      const namedTk = await requestOn(child.port, 'POST', `/possystem/v1/getToken?sandbox=${encodeURIComponent(named.id)}`,
        { login: named.creds.fermaLogin, pass: named.creds.fermaPassword }, { 'X-Sandbox-Token': named.ownerToken });
      check('MS-12: именованная песочница обслуживает контракт Ferma по owner-token и своим кредам',
        Boolean(namedTk.json() && namedTk.json().token), namedTk.text.slice(0, 160));
    } finally {
      await stopChild(child);
    }
  }

  // 25b. MS-12 BC: с MOCK_SANDBOX_TOKEN поведение hosted-стенда прежнее —
  //      default требует owner-token, с ним контракт Ferma работает
  {
    const child = await startKassaChild({ MOCK_HOSTED: '1', MOCK_SANDBOX_TOKEN: 'default-owner-secret' });
    try {
      const noToken = await requestOn(child.port, 'POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' });
      check('MS-12 BC: hosted с токеном требует owner-token (401)', noToken.status === 401);
      const tk = await requestOn(child.port, 'POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' },
        { 'X-Sandbox-Token': 'default-owner-secret' });
      check('MS-12 BC: owner-token открывает default (контракт Ferma работает)', Boolean(tk.json().token));
      check('MS-12: стартовый статус сообщает про owner-token', child.getOutput().includes('default=owner-token'), child.getOutput());
    } finally {
      await stopChild(child);
    }
  }

  // 26. SSRF-политика: `=1` блокирует приватные IPv4/IPv6 и examiner, и очередь
  //     callback'ов; `=true` работает так же
  {
    let hits = 0;
    const catcher = http.createServer((req, res) => { hits += 1; res.writeHead(200); res.end('{"data":{"status":"confirmed"}}'); });
    const catchPort = await new Promise((resolve, reject) => {
      catcher.once('error', reject);
      catcher.listen(0, '127.0.0.1', () => resolve(catcher.address().port));
    });
    const child = await startKassaChild({ MOCK_BLOCK_PRIVATE_WEBHOOKS: '1' });
    try {
      const v4 = await requestOn(child.port, 'POST', '/mock/verify-merchant', { url: `http://127.0.0.1:${catchPort}/callback` });
      check('#22: =1: private IPv4 в /mock/verify-merchant -> 403 + SSRF', v4.status === 403 && v4.text.includes('SSRF'));
      const v6 = await requestOn(child.port, 'POST', '/mock/verify-merchant', { url: 'http://[::1]/hook' });
      check('#22: =1: private IPv6 -> 403', v6.status === 403);

      const tk = (await requestOn(child.port, 'POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' })).json().token;
      const body = validBody('ssrf-callback-1');
      body.receipt.receipts = { service: { callback_url: `http://127.0.0.1:${catchPort}/callback` } };
      await requestOn(child.port, 'POST', `/possystem/v1/Main/sell?token=${tk}`, body);
      const cb = await waitForCondition(async () => {
        const exported = (await requestOn(child.port, 'GET', '/mock/state')).json();
        const stateSlice = (exported && exported.state) || exported || {};
        const callback = Object.values(stateSlice.callbacks || {})[0];
        return callback && String(callback.lastStatus).includes('SSRF') ? callback : null;
      }, { timeoutMs: 5000, description: 'SSRF callback rejection recorded in state' });
      check('#22: =1: callback на приватный адрес заблокирован (SSRF в lastStatus)',
        hits === 0 && String(cb.lastStatus).includes('SSRF'), `hits=${hits}, lastStatus=${cb.lastStatus}`);
    } finally {
      await stopChild(child);
      catcher.close();
    }
  }

  {
    const child = await startKassaChild({ MOCK_BLOCK_PRIVATE_WEBHOOKS: 'true' });
    try {
      const r = await requestOn(child.port, 'POST', '/mock/verify-merchant', { url: 'http://[::1]/hook' });
      check('#22: =true тоже включает SSRF-guard', r.status === 403);
    } finally {
      await stopChild(child);
    }
  }

  // #51 PF-01: при MOCK_HOSTED=1 (без явного MOCK_BLOCK_PRIVATE_WEBHOOKS в окружении)
  // SSRF-guard в kassa-mock включается по умолчанию, как и в остальных 4 сервисах
  {
    let hostedHits = 0;
    const catcher = http.createServer((req, res) => { hostedHits += 1; res.writeHead(200); res.end('{"data":{"status":"confirmed"}}'); });
    const catchPort = await new Promise((resolve, reject) => {
      catcher.once('error', reject);
      catcher.listen(0, '127.0.0.1', () => resolve(catcher.address().port));
    });
    // MS-12 (#121): default в hosted без MOCK_SANDBOX_TOKEN бизнес-API не
    // обслуживает, поэтому сценарий даёт стенду песочницу с owner-token —
    // SSRF-политика при этом проверяется ровно так же.
    const child = await startKassaChild({ MOCK_HOSTED: '1', MOCK_OPERATOR_TOKEN: 'op-secret', MOCK_SANDBOX_TOKEN: 'default-owner-secret' });
    const auth = { Authorization: 'Bearer op-secret' };
    try {
      const v4 = await requestOn(child.port, 'POST', '/mock/verify-merchant', { url: `http://127.0.0.1:${catchPort}/callback` }, auth);
      check('#51 PF-01: MOCK_HOSTED=1 без MOCK_BLOCK_PRIVATE_WEBHOOKS включает block_private_webhooks=true по умолчанию',
        child.getOutput().includes('hosted=true block_private_webhooks=true'), child.getOutput());
      check('#51 PF-01: MOCK_HOSTED=1 по умолчанию блокирует private IPv4 в /mock/verify-merchant (403 + SSRF)',
        v4.status === 403 && v4.text.includes('SSRF') && hostedHits === 0, `status=${v4.status}, hits=${hostedHits}`);

      const tk = (await requestOn(child.port, 'POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' }, auth)).json().token;
      const body = validBody('pf01-hosted-ssrf-1');
      body.receipt.receipts = { service: { callback_url: `http://127.0.0.1:${catchPort}/callback` } };
      await requestOn(child.port, 'POST', `/possystem/v1/Main/sell?token=${tk}`, body, auth);
      const cb = await waitForCondition(async () => {
        const exported = (await requestOn(child.port, 'GET', '/mock/state', null, auth)).json();
        const stateSlice = (exported && exported.state) || exported || {};
        const callback = Object.values(stateSlice.callbacks || {})[0];
        return callback && String(callback.lastStatus).includes('SSRF_BLOCKED') ? callback : null;
      }, { timeoutMs: 5000, description: 'PF-01 hosted SSRF callback rejection recorded in state' });
      check('#51 PF-01: MOCK_HOSTED=1 по умолчанию блокирует приватный callback очереди (SSRF_BLOCKED, 0 соединений)',
        hostedHits === 0 && String(cb.lastStatus).includes('SSRF_BLOCKED'), `hits=${hostedHits}, lastStatus=${cb.lastStatus}`);
    } finally {
      await stopChild(child);
      catcher.close();
    }
  }

  /* --- #8 (RFC-001, F-11—F-15): изоляция песочниц ------------------------- */

  // 27. F-11/F-13: request-local контекст (гонка activeId), target в export/import
  {
    const child = await startKassaChild({});
    try {
      // Токен резолвится в песочнице: getToken в каждой свой (state.tokens изолирован).
      const tokenIn = async (sandbox) => (await requestOn(
        child.port, 'POST', '/possystem/v1/getToken',
        { login: 'loviitest', pass: 'mockpass123' },
        { 'X-Mock-Sandbox': sandbox },
      )).json().token;
      const sellIn = (sandbox, tk, extId, latency = 0) => requestOn(
        child.port,
        'POST',
        `/possystem/v1/Main/sell?token=${tk}`,
        validBody(extId),
        { 'X-Mock-Sandbox': sandbox, ...(latency ? { 'X-Mock-Latency': String(latency) } : {}) },
      );
      const checksBefore = (await requestOn(child.port, 'GET', '/healthz')).json().checks;
      const [tkA, tkB] = await Promise.all([tokenIn('k-a'), tokenIn('k-b')]);
      // A отвечает с задержкой, B — сразу: раньше первый await оставлял B в state A.
      const [ra, rb] = await Promise.all([sellIn('k-a', tkA, 'k-a-1', 300), sellIn('k-b', tkB, 'k-b-1')]);
      check('#8 F-11: параллельные чеки в разных песочницах принимаются',
        Boolean(ra.json() && ra.json().uuid) && Boolean(rb.json() && rb.json().uuid), `${ra.text.slice(0, 80)} | ${rb.text.slice(0, 80)}`);
      const stA = (await requestOn(child.port, 'GET', '/mock/state?sandbox=k-a')).json().state;
      const stB = (await requestOn(child.port, 'GET', '/mock/state?sandbox=k-b')).json().state;
      check('#8 F-11: песочница A видит только свой чек',
        Object.keys(stA.receipts).length === 1 && Boolean(stA.receipts[ra.json().uuid]));
      check('#8 F-11: песочница B видит только свой чек',
        Object.keys(stB.receipts).length === 1 && Boolean(stB.receipts[rb.json().uuid]));
      const health = (await requestOn(child.port, 'GET', '/healthz')).json();
      check('#8 F-11: запрос без селектора разрешается в default без чеков песочниц',
        health.sandbox === 'default' && health.checks === checksBefore, `sandbox=${health.sandbox}, checks=${health.checks}, before=${checksBefore}`);

      // F-13: импорт в явный target не переключает активную (default) песочницу
      const seeded = {
        counters: { deviceId: 1, uuid: 1, fd: 1, notification: 1 },
        tokens: {}, receipts: { seed: { uuid: 'seed', status: 'done' } }, externalIds: { seeded: 'seed' },
        callbacks: {}, ofdQueue: {}, zReports: [], clockOffsetMs: 0, cashbox: {}, shift: {}, fn: {},
      };
      const imp = await requestOn(child.port, 'POST', '/mock/state', { sandbox: 'k-target', state: seeded });
      check('#8 F-13: импорт возвращает фактический target', imp.json() && imp.json().sandbox === 'k-target', imp.text.slice(0, 120));
      const targetState = (await requestOn(child.port, 'GET', '/mock/state?sandbox=k-target')).json().state;
      check('#8 F-13: экспорт читает только выбранный снимок', Boolean(targetState.receipts.seed));
      const defaultState = (await requestOn(child.port, 'GET', '/mock/state')).json().state;
      check('#8 F-13: импорт в target не изменил default', !defaultState.receipts.seed);
    } finally {
      await stopChild(child);
    }
  }

  // 28. F-12: hosted tenancy — owner-token, креды песочницы, знание ID ≠ доступ
  {
    const child = await startKassaChild({ MOCK_TENANCY: '1', MOCK_OPERATOR_TOKEN: 'op-agent', MOCK_SANDBOX_TTL_MS: '3600000' });
    try {
      const created = (await requestOn(child.port, 'POST', '/sandboxes', {})).json();
      check('#8 F-12: POST /sandboxes отдаёт id, ownerToken и креды песочницы',
        Boolean(created.id && created.ownerToken && created.creds && created.creds.fermaPassword), JSON.stringify(created).slice(0, 180));
      const owner = { Authorization: `Bearer ${created.ownerToken}` };
      const loginRes12 = await requestOn(child.port, 'POST', '/admin/login', new URLSearchParams({ sandbox_token: created.ownerToken }).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
      const ownerCookie = loginRes12.headers['set-cookie'][0].split(';')[0];
      const ownerAdminPage = await requestOn(child.port, 'GET', `/admin?sandbox=${encodeURIComponent(created.id)}`, null, { Cookie: ownerCookie });
      const actionMatch = /<form method="POST" action="([^"]*\/admin\/action[^"]*)"/.exec(ownerAdminPage.text);
      const csrfMatch = /name="_csrf" value="([^"]+)"/.exec(ownerAdminPage.text);
      let ownerAdminActionWorks = false;
      if (actionMatch && csrfMatch) {
        const actionUrl = new URL(actionMatch[1].replace(/&amp;/g, '&'), `http://127.0.0.1:${child.port}`);
        const adminPost = await requestOn(child.port, 'POST', `${actionUrl.pathname}${actionUrl.search}`,
          `_csrf=${encodeURIComponent(csrfMatch[1])}&action=ofd-offline`, {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: `http://127.0.0.1:${child.port}`,
            Cookie: ownerCookie
          });
        const returnedPage = adminPost.headers.location
          ? await requestOn(child.port, 'GET', adminPost.headers.location, null, { Cookie: ownerCookie })
          : null;
        ownerAdminActionWorks = !actionUrl.searchParams.has('sandbox_token')
          && adminPost.status === 302
          && returnedPage && returnedPage.status === 200;
      }
      check('#8 F-12: native admin-form передаёт owner-token, CSRF и сохраняет токен после redirect',
        ownerAdminPage.status === 200 && ownerAdminActionWorks, `страница ${ownerAdminPage.status}`);

      const idOnly = await requestOn(child.port, 'POST', '/possystem/v1/getToken', { login: created.creds.fermaLogin, pass: created.creds.fermaPassword }, { 'X-Mock-Sandbox': created.id });
      check('#8 F-12: знание ID без owner-token -> 401', idOnly.status === 401, `получено ${idOnly.status}`);
      const other = (await requestOn(child.port, 'POST', '/sandboxes', {})).json();
      const foreign = await requestOn(child.port, 'GET', '/mock/state', null, { 'X-Mock-Sandbox': created.id, Authorization: `Bearer ${other.ownerToken}` });
      check('#8 F-12: owner-token другой песочницы не открывает чужую', foreign.status === 401);
      const unknown = await requestOn(child.port, 'GET', '/mock/state', null, { 'X-Mock-Sandbox': 'ghost-8' });
      check('#8 F-12: неизвестная песочница -> 404 + подсказка создать', unknown.status === 404 && unknown.text.includes('POST /sandboxes'));

      const tk = (await requestOn(child.port, 'POST', '/possystem/v1/getToken', { login: created.creds.fermaLogin, pass: created.creds.fermaPassword }, { 'X-Mock-Sandbox': created.id, ...owner })).json().token;
      check('#8 F-12: getToken с кредами песочницы и owner-token работает', Boolean(tk));
      const wrong = await requestOn(child.port, 'POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' }, { 'X-Mock-Sandbox': created.id, ...owner });
      check('#8 F-12: креды стенда в песочнице не действуют (код 14)', Boolean(wrong.json() && wrong.json().error && wrong.json().error.code === 14));

      const noTokList = await requestOn(child.port, 'GET', '/mock/sandboxes');
      check('#8 F-12: список песочниц без токена -> 401', noTokList.status === 401);
      const ownList = (await requestOn(child.port, 'GET', '/mock/sandboxes', null, owner)).json();
      check('#8 F-12: владелец видит только свою песочницу', ownList && ownList.sandboxes.length === 1 && ownList.sandboxes[0].id === created.id);
      const ownState = await requestOn(child.port, 'GET', '/mock/state', null, owner);
      check('#8 F-12: owner-token открывает управляющие маршруты своей песочницы', ownState.status === 200);
      const me = (await requestOn(child.port, 'GET', '/sandboxes/me', null, owner)).json();
      check('#8 F-12: /sandboxes/me отдаёт песочницу владельца', Boolean(me && me.sandbox && me.sandbox.id === created.id));
      const rotated = (await requestOn(child.port, 'POST', '/sandboxes/me/reset-creds', {}, owner)).json();
      check('#8 F-12: reset-creds меняет пароль песочницы',
        Boolean(rotated && rotated.creds && rotated.creds.fermaPassword && rotated.creds.fermaPassword !== created.creds.fermaPassword));
    } finally {
      await stopChild(child);
    }
  }

  // 29. F-14: персистентность песочницы через рестарт и TTL-очистка; F-15: квота
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kassa-sbx-'));
    const stateFile = path.join(tmpDir, 'state.json');
    let savedUuid = '';
    const child1 = await startKassaChild({ MOCK_STATE_FILE: stateFile });
    try {
      const tk = (await requestOn(child1.port, 'POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' }, { 'X-Mock-Sandbox': 'k-persist' })).json().token;
      savedUuid = (await requestOn(child1.port, 'POST', `/possystem/v1/Main/sell?token=${tk}`, validBody('k-persist-1'), { 'X-Mock-Sandbox': 'k-persist' })).json().uuid;
      await waitForCondition(() => {
        try {
          // PD-02: реестр песочниц поштучно — один файл на песочницу
          const record = JSON.parse(fs.readFileSync(`${stateFile}.sandboxes.records/k-persist.json`, 'utf8')).sandbox;
          return Boolean(record && record.state && record.state.receipts && record.state.receipts[savedUuid]);
        } catch { return false; }
      }, { description: 'sandbox registry flush before restart' });
    } finally {
      await stopChild(child1);
    }
    const child2 = await startKassaChild({ MOCK_STATE_FILE: stateFile });
    try {
      const restored = (await requestOn(child2.port, 'GET', '/mock/state?sandbox=k-persist')).json().state;
      check('#8 F-14: состояние именованной песочницы восстанавливается после рестарта', Boolean(restored.receipts[savedUuid]));
      const def = (await requestOn(child2.port, 'GET', '/mock/state')).json().state;
      check('#8 F-14: чужой state не приписывается default', !def.receipts[savedUuid]);
    } finally {
      await stopChild(child2);
    }

    const child3 = await startKassaChild({ MOCK_TENANCY: '1', MOCK_SANDBOX_TTL_MS: '800', MOCK_SANDBOX_SWEEP_MS: '1000' });
    try {
      const created = (await requestOn(child3.port, 'POST', '/sandboxes', {})).json();
      const before = await requestOn(child3.port, 'GET', '/mock/state', null, { 'X-Mock-Sandbox': created.id, Authorization: `Bearer ${created.ownerToken}` });
      check('#8 F-14: до TTL песочница доступна', before.status === 200);
      const after = await waitForCondition(async () => {
        const response = await requestOn(child3.port, 'GET', '/mock/state', null, { 'X-Mock-Sandbox': created.id, Authorization: `Bearer ${created.ownerToken}` });
        return [404, 410].includes(response.status) ? response : null;
      }, { timeoutMs: 5000, description: 'sandbox TTL expiry' });
      check('#8 F-14: после TTL песочница недоступна', [404, 410].includes(after.status), `получено ${after.status}`);
    } finally {
      await stopChild(child3);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // Квота считает документы песочницы: токен, чеки, external_id и записи
    // очереди callback'ов — поэтому лимит 6 пропускает два чека и режет третий.
    const child4 = await startKassaChild({ MOCK_SANDBOX_MAX_DOCUMENTS: '6' });
    try {
      const tk = (await requestOn(child4.port, 'POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' }, { 'X-Mock-Sandbox': 'k-quota' })).json().token;
      const sell = (extId) => requestOn(child4.port, 'POST', `/possystem/v1/Main/sell?token=${tk}`, validBody(extId), { 'X-Mock-Sandbox': 'k-quota' });
      check('#8 F-15: первый чек проходит', Boolean((await sell('k-quota-1')).json().uuid));
      check('#8 F-15: второй чек проходит (лимит 6 документов)', Boolean((await sell('k-quota-2')).json().uuid));
      const third = (await sell('k-quota-3')).json();
      check('#8 F-15: превышение квоты документов отклоняется с DX',
        Boolean(third.error) && String(third.error.text).includes('Лимит документов песочницы'), JSON.stringify(third).slice(0, 160));
    } finally {
      await stopChild(child4);
    }

    // PA-50 / PA-54 / PA-55: авторизация явного target, гонка TTL-sweep mid-await,
    // закрытая default-песочница и отсутствие глобального switchActive
    const tmpPa = fs.mkdtempSync(path.join(os.tmpdir(), 'kassa-pa50-'));
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
            tokens: { 'tok-victim': { login: 'v***', createdAt: Date.now() } },
            receipts: { 'k-victim-uuid': { uuid: 'k-victim-uuid', externalId: 'VICTIM-CANARY-KASSA', group: 'Main', operation: 'sell', status: 'done', payload: {} } },
            externalIds: {},
            callbacks: {},
            ofdQueue: {},
            zReports: [],
            cashbox: { kktState: 'Готова', checksCnt: 1 },
            shift: { status: 'open', shiftNumber: 1, openedAtMs: Date.now() },
            fn: { fnNumber: '9999078902001294', used: 1, capacity: 250000 },
          },
        },
        {
          id: 'attacker-a',
          expiresAt: 0,
          ownerTokenHash: core.hashSecret('attacker-owner-token'),
          state: {
            tokens: {},
            receipts: {},
            externalIds: {},
            callbacks: {},
            ofdQueue: {},
            zReports: [],
            cashbox: { kktState: 'Готова', checksCnt: 0 },
            shift: { status: 'open', shiftNumber: 1, openedAtMs: Date.now() },
            fn: { fnNumber: '9999078902001294', used: 0, capacity: 250000 },
          },
        },
      ],
    }));
    const child5 = await startKassaChild({
      MOCK_TENANCY: 'owned',
      MOCK_SANDBOX_FILE: sbxFile,
      MOCK_SANDBOX_TOKEN: 'default-owner-secret',
      MOCK_OPERATOR_TOKEN: 'op-secret',
      MOCK_SANDBOX_TTL_MS: '1000',
      MOCK_SANDBOX_SWEEP_MS: '1000',
    });
    try {
      const hdrA = { 'X-Mock-Sandbox': 'attacker-a', 'X-Sandbox-Token': 'attacker-owner-token' };
      const expB = await requestOn(child5.port, 'GET', '/mock/state?sandbox=victim-b', null, hdrA);
      check('PA-50: чужой GET /mock/state?sandbox=victim-b -> 401 без утечки', expB.status === 401 && !expB.text.includes('VICTIM-CANARY-KASSA'));
      const impB = await requestOn(child5.port, 'POST', '/mock/state', { sandbox: 'victim-b', state: { receipts: { pwn: {} } } }, hdrA);
      check('PA-50: чужой POST /mock/state -> 401', impB.status === 401);
      const rstB = await requestOn(child5.port, 'POST', '/mock/reset', { sandbox: 'victim-b' }, hdrA);
      check('PA-50: чужой POST /mock/reset -> 401', rstB.status === 401);
      const delB = await requestOn(child5.port, 'DELETE', '/sandboxes?sandbox=victim-b', null, hdrA);
      check('PA-50: чужой DELETE /sandboxes -> 401', delB.status === 401);

      const opB = await requestOn(child5.port, 'GET', '/mock/state?sandbox=victim-b', null, { 'X-Operator-Token': 'op-secret' });
      check('PA-50: оператор читает /mock/state?sandbox=victim-b', opB.status === 200 && opB.text.includes('VICTIM-CANARY-KASSA'));

      const defReceipt = await requestOn(child5.port, 'GET', '/receipts/k-victim-uuid');
      check('PA-54: страница чека защищённой default без токена -> 401', defReceipt.status === 401);
      const pubHealth = (await requestOn(child5.port, 'GET', '/healthz')).json();
      check('PA-54: публичный /healthz на защищённой default не раскрывает checks', pubHealth.checks === undefined);

      const r = (await requestOn(child5.port, 'POST', '/sandboxes', { id: 'race-tenant' })).json();
      const raceResp = await requestOn(child5.port, 'GET', '/possystem/v1/Main/report/k-victim-uuid?token=tok-victim', null, {
        'X-Mock-Sandbox': r.id,
        'X-Sandbox-Token': r.ownerToken,
        'X-Mock-Latency': '1700',
      });
      check('PA-50 §7.2: истёкшая во время await песочница -> 410 без утечки',
        raceResp.status === 410 && !raceResp.text.includes('VICTIM-CANARY-KASSA'), `status=${raceResp.status}`);
    } finally {
      await stopChild(child5);
      fs.rmSync(tmpPa, { recursive: true, force: true });
    }
  }

  // 30. MS-04: SIGINT сохраняет отложенную (debounced) запись песочницы —
  // «отложенная запись → сигнал → рестарт с тем же state-файлом → данные на месте»;
  // SIGTERM-ветка того же хелпера проверяется selftest'ом Т-Банка.
  {
    let verified = false;
    for (let attempt = 1; attempt <= 3 && !verified; attempt += 1) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kassa-ms04-'));
      const stateFile = path.join(tmpDir, 'state.json');
      const sandboxId = `k-ms04-${attempt}`;
      const recordFile = `${stateFile}.sandboxes.records/${sandboxId}.json`;
      const receiptsOnDisk = () => {
        try { return JSON.parse(fs.readFileSync(recordFile, 'utf8')).sandbox.state.receipts || {}; } catch { return {}; }
      };
      let child = await startKassaChild({ MOCK_STATE_FILE: stateFile });
      try {
        const token = (await requestOn(child.port, 'POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' }, { 'X-Mock-Sandbox': sandboxId })).json().token;
        const uuid = (await requestOn(child.port, 'POST', `/possystem/v1/Main/sell?token=${token}`, validBody(`k-ms04-${attempt}`), { 'X-Mock-Sandbox': sandboxId })).json().uuid;
        if (receiptsOnDisk()[uuid]) {
          // Окно debounce (150 мс) истекло раньше сигнала: регресс не смог бы
          // отличить сброс при SIGINT от обычного отложенного сброса —
          // повторяем попытку с чистой песочницей.
          continue;
        }
        const stopped = await stopChildGracefully(child, 'SIGINT');
        check('MS-04: SIGINT даёт самостоятельный exit 0',
          stopped.signal === null && stopped.code === 0, `code=${stopped.code} signal=${stopped.signal}`);
        check('MS-04: выход по SIGINT ≤ 2 с', stopped.ms <= 2000, `${stopped.ms} мс`);
        check('MS-04: SIGINT сбросил отложенную запись песочницы на диск', Boolean(receiptsOnDisk()[uuid]));
        // Рестарт с тем же state-файлом: чек обязан быть на месте.
        child = await startKassaChild({ MOCK_STATE_FILE: stateFile });
        const restored = (await requestOn(child.port, 'GET', `/mock/state?sandbox=${sandboxId}`)).json().state;
        check('MS-04: после рестарта отложенная запись на месте',
          Boolean(restored && restored.receipts[uuid] && restored.receipts[uuid].externalId === `k-ms04-${attempt}`));
        verified = true;
      } finally {
        await stopChild(child);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
    check('MS-04: удалось наблюдать отложенную запись (окно debounce 150 мс)', verified);
  }

  await phaseRestart();

  console.log(`\nИТОГ: ${passed} passed, ${failed} failed\n`);
  return failed ? 1 : 0;
}

/** Дочерний стенд кассы на свободном порту с ожиданием healthz. */
async function startKassaChild(env = {}) {
  const childEnv = {
    ...process.env,
    MOCK_HOST: '127.0.0.1',
    MOCK_PORT: '0',
    MOCK_STATE_FILE: '',
    MOCK_SANDBOX_FILE: '',
    MOCK_PROCESS_MS: '0',
    MOCK_CALLBACK_RETRY_MS: '1000',
    MOCK_ADMIN_TOKEN: '',
    MOCK_OPERATOR_TOKEN: '',
    MOCK_HOSTED: '',
    MOCK_TENANCY: '',
    MOCK_SANDBOX_TOKEN: '',
    MOCK_SANDBOX_TTL_MS: '',
    MOCK_SANDBOX_SWEEP_MS: '',
    MOCK_SANDBOX_MAX: '',
    MOCK_SANDBOX_MAX_DOCUMENTS: '',
    MOCK_SANDBOX_RETENTION_MS: '',
    MOCK_SANDBOX_HOST_SUFFIX: '',
    MOCK_SANDBOX_CREATE_LIMIT: '',
    ...env,
    MOCK_PORT: '0',
  };
  if (!Object.prototype.hasOwnProperty.call(env, 'MOCK_BLOCK_PRIVATE_WEBHOOKS')) {
    delete childEnv.MOCK_BLOCK_PRIVATE_WEBHOOKS;
  }
  const proc = spawn('node', ['--max-old-space-size=48', path.join(__dirname, 'server.js')], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        reject(error);
      } else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`kassa-mock did not report its ephemeral port: ${output.slice(-500)}`)), 5000);
    proc.stdout.on('data', (data) => {
      const text = String(data);
      output += text;
      SERVER_LOG.push(text);
      const match = /kassa-mock \(Ferma cloud-cashbox mock\) on [^:\s]+:(\d+)/.exec(output);
      if (match) finish(null, Number(match[1]));
    });
    proc.stderr.on('data', (data) => process.stderr.write(String(data)));
    proc.once('exit', (code, signal) => finish(new Error(`kassa-mock exited before listen (${code ?? signal}): ${output.slice(-500)}`)));
  });
  return { proc, port, getOutput: () => output, stop: () => stopChild(proc) };
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
 * MS-04: остановить дочерний стенд штатным сигналом и дождаться выхода.
 * Возвращает `{code, signal, ms}` — регресс проверяет по ним код 0 и ≤ 2 с.
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

/**
 * Фаза 2 — рестарт стенда (дефекты A-2/A-10/A-11 аудита):
 *   • MOCK_PROCESS_MS=0 печатает чек сразу, а не через 4 с (parseInt(x)||def);
 *   • незавершённый callback переживает рестарт и продолжает ретраиться
 *     (очередь сохраняет ссылку на восстановленный state);
 *   • токен с истёкшим TTL (12 ч) даёт ошибку 11, а не «работает вечно».
 */
async function phaseRestart() {
  const stateFile = path.join(os.tmpdir(), `kassa-selftest-${process.pid}.json`);
  const hits = { fail: 0, ok: 0 };
  const catcher = http.createServer((req, res) => {
    if (req.url.startsWith('/fail')) { hits.fail += 1; res.writeHead(500); res.end('no'); return; }
    hits.ok += 1; res.writeHead(200); res.end('{"data":{"status":"confirmed"}}');
  });
  const catchPort = await new Promise((resolve, reject) => {
    catcher.once('error', reject);
    catcher.listen(0, '127.0.0.1', () => resolve(catcher.address().port));
  });
  const childEnv = {
    MOCK_PROCESS_MS: '0',
    MOCK_CALLBACK_RETRY_MS: '500',
    MOCK_STATE_FILE: stateFile,
  };
  let port = 0;
  let child = null;
  const start = async () => {
    const next = await startKassaChild(childEnv);
    port = next.port;
    return next;
  };
  const api = (method, url, body, headers = {}) => requestOn(port, method, url, body, headers);

  try {
    child = await start();
    const tok = (await api('POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' })).json().token;
    const doc = (await api('POST', `/possystem/v1/Main/sell?token=${tok}`, {
      external_id: 'restart-pending',
      receipt: {
        client: { email: 'a@b.c' },
        company: { sno: 'usn_income', payment_address: 'lovi.test' },
        items: [{ name: 'X', price: 100, quantity: 1, sum: 100, vat: { type: 'none' }, payment_method: 'full_payment', payment_object: 'commodity' }],
        payments: [{ type: 1, sum: 100 }],
        total: 100,
        receipts: { service: { callback_url: `http://127.0.0.1:${catchPort}/fail` } },
      },
    })).json();
    await waitForCondition(async () => {
      const report = (await api('GET', `/possystem/v1/Main/report/${doc.uuid}?token=${tok}`)).json();
      return report.status === 'done' ? report : null;
    }, { description: 'MOCK_PROCESS_MS=0 receipt processing' });
    check('MOCK_PROCESS_MS=0: чек печатается сразу', (await api('GET', `/possystem/v1/Main/report/${doc.uuid}?token=${tok}`)).json().status === 'done');

    await waitForCondition(async () => {
      const exported = (await api('GET', '/mock/state')).json();
      const stateSlice = (exported && exported.state) || exported || {};
      const callback = Object.values(stateSlice.callbacks || {})[0];
      return hits.fail >= 1 && callback && callback.lastStatus ? callback : null;
    }, { timeoutMs: 8000, description: 'first failed callback attempt recorded' });
    const hitsBefore = hits.fail;
    check('незавершённый callback ретраится до рестарта', hitsBefore >= 1);
    await stopChild(child);

    child = await start();
    await waitForCondition(() => hits.fail > hitsBefore, {
      timeoutMs: 8000,
      description: 'pending callback retry after process restart',
    });
    check('после рестарта незавершённый callback продолжает ретраиться (A-2)', hits.fail > hitsBefore);
    await stopChild(child);
    child = null;

    // Токен с истёкшим TTL: подкладываем в state-файл просроченную сессию.
    const savedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    savedState.tokens = { ...(savedState.tokens || {}), expiredtoken: { login: 'loviitest', createdAt: Date.now() - 13 * 60 * 60 * 1000 } };
    fs.writeFileSync(stateFile, JSON.stringify(savedState));
    child = await start();
    const expired = (await api('GET', '/possystem/v1/Main/report/00000000-0000-0000-0000-000000000000?token=expiredtoken')).json();
    check('токен с истёкшим TTL -> ошибка 11 (A-11)', expired.error && expired.error.code === 11);
  } finally {
    await stopChild(child);
    fs.rmSync(stateFile, { force: true });
    fs.rmSync(`${stateFile}.sandboxes.json`, { force: true });
    fs.rmSync(`${stateFile}.sandboxes.records`, { recursive: true, force: true });
    await new Promise((resolve) => catcher.close(resolve));
  }
}

/** Запрос на произвольный порт (для фазы рестарта). */
function requestOn(port, method, url, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null || body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
      timeout: 5000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: buf, json: () => { try { return JSON.parse(buf); } catch { return null; } } }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

// Ловушка callback'ов мока (эмулирует ядро); слушает отдельный ephemeral-порт.
const catcher = http.createServer((req, res) => {
  global.__callbackHits = (global.__callbackHits || 0) + 1;
  res.writeHead(200); res.end('{"data":{"status":"confirmed"}}');
});

async function runSelftest() {
  let child = null;
  let code = 1;
  try {
    CALLBACK_PORT = await new Promise((resolve, reject) => {
      catcher.once('error', reject);
      catcher.listen(0, '127.0.0.1', () => resolve(catcher.address().port));
    });
    child = await startKassaChild({ MOCK_PROCESS_MS: '500', MOCK_CALLBACK_RETRY_MS: '1000' });
    MAIN_CHILD = child;
    PORT = child.port;
    BASE = `http://127.0.0.1:${PORT}`;
    code = await main();
  } catch (error) {
    console.error('selftest crashed:', error);
    code = 1;
  } finally {
    await stopChild(child);
    if (catcher.listening) await new Promise((resolve) => catcher.close(resolve));
  }
  process.exitCode = code;
}

runSelftest();
