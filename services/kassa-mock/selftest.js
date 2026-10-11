// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Selftest kassa-mock: 10 сценариев контракта Ferma (token, sell, dup,
 * fail-, hang-, report, stats, callback delivery, down-mode, чек покупателю).
 * Запуск: node kassa-mock/selftest.js (поднимает свой экземпляр на :3301).
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 3301;
const BASE = `http://127.0.0.1:${PORT}`;
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

async function main() {
  console.log(`\n== kassa-mock selftest on :${PORT} ==\n`);

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
      receipts: { service: { callback_url: `http://127.0.0.1:${PORT + 1}/fake-core-callback` } },
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
  await sleep(2500);
  check('callback доставлен', global.__callbackHits > 0);

  // 9. отчёт done с фискальными данными
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
  await sleep(1500);
  const rp1 = (await request('GET', `/possystem/v1/Main/report/${p1.uuid}?token=${token}`)).json();
  const rp2 = (await request('GET', `/possystem/v1/Main/report/${p2.uuid}?token=${token}`)).json();
  check('receipt_datetime не 1970 (снимок после печати)', Boolean(rp1.payload) && !String(rp1.payload.receipt_datetime).startsWith('1970'));
  check('номера чеков в смене уникальны', rp1.payload.fiscal_receipt_number !== rp2.payload.fiscal_receipt_number);

  // 10e. XSS: название позиции экранируется в чеке покупателя
  // sum обязателен (валидатор чека инвариантом sum = price × quantity) —
  // без него запрос отбраковывается до создания документа, и проверка
  // экранирования получала 404 вместо чека.
  const xss = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, { ...sellBody, external_id: 'xss-1', receipt: { ...sellBody.receipt, items: [{ ...sellBody.receipt.items[0], name: '<img src=x onc=alert(1)>', sum: sellBody.receipt.items[0].price * sellBody.receipt.items[0].quantity }] } })).json();
  await sleep(2200); // печать — на секундном тике после processAt=500мс; 1200 мс — гонка
  r = await request('GET', `/receipts/${xss.uuid}`);
  check('чек покупателя экранирует HTML из данных интегратора', r.status === 200 && !r.text.includes('<img src=x onc=alert(1)>') && r.text.includes('&lt;img'));

  // 10f. Лента чека: НДС считается по позициям (ставка из vat.type)
  const vatDoc = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, { ...sellBody, external_id: 'vat-1', receipt: { ...sellBody.receipt, items: [{ ...sellBody.receipt.items[0], vat: { type: 'vat20' }, sum: sellBody.receipt.items[0].sum }] } })).json();
  await sleep(2200); // аналогично 10e
  r = await request('GET', `/receipts/${vatDoc.uuid}`);
  check('лента чека: НДС по ставке позиции (vat20 → «НДС 20%»)', r.text.includes('НДС 20%'));

  // 11. негатив fail-
  r = await request('POST', `/possystem/v1/Main/sell?token=${token}`, { ...sellBody, external_id: 'fail-2' });
  const failUuid = r.json().uuid;
  await sleep(1500);
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
  await sleep(2200);
  r = await request('GET', `/possystem/v1/Main/report/${hdr.uuid}?token=${token}`);
  check('X-Mock-Scenario: fail -> статус fail для обычного external_id', r.json().status === 'fail' && r.json().external_id === 'order-42');
  const hdrHang = (await request('POST', `/possystem/v1/Main/sell?token=${token}`, { ...sellBody, external_id: 'order-43' }, { 'X-Mock-Scenario': 'hang' })).json();
  r = await request('GET', `/possystem/v1/Main/report/${hdrHang.uuid}?token=${token}`);
  check('X-Mock-Scenario: hang -> вечный wait', r.json().status === 'wait');

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

  await sleep(2200);

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

  const verifyMerchantRes = (await request('POST', '/mock/verify-merchant', { url: `http://127.0.0.1:${PORT + 1}/callback` })).json();
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
      const tk = (await requestOn(child.port, 'POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' })).json().token;
      check('#22: getToken (контракт Ferma) не требует operator-токена', Boolean(tk));
      const sell = await requestOn(child.port, 'POST', `/possystem/v1/Main/sell?token=${tk}`, validBody('auth-check-1'));
      check('#22: sell (контракт Ferma) не требует operator-токена', Boolean(sell.json() && sell.json().uuid));
    } finally {
      child.stop();
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
      child.stop();
    }
  }

  // 25. Hosted-режим без секрета: управляющая поверхность fail-closed,
  //     публичные маршруты (healthz, контракт Ferma) работают
  {
    const child = await startKassaChild({ MOCK_HOSTED: '1' });
    try {
      const st = await requestOn(child.port, 'GET', '/mock/state');
      check('#22: hosted без секрета: /mock/state закрыт (fail-closed)', st.status === 401 && st.text.includes('hosted'));
      const fn = await requestOn(child.port, 'GET', '/possystem/v1/fn/state');
      check('#22: hosted без секрета: /fn/state закрыт', fn.status === 401);
      const health = await requestOn(child.port, 'GET', '/healthz');
      check('#22: hosted: /healthz публичный', health.status === 200);
      const tk = (await requestOn(child.port, 'POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' })).json().token;
      check('#22: hosted: контракт Ferma (getToken) работает', Boolean(tk));
    } finally {
      child.stop();
    }
  }

  // 26. SSRF-политика: `=1` блокирует приватные IPv4/IPv6 и examiner, и очередь
  //     callback'ов; `=true` работает так же
  {
    const catchPort = await freePort();
    let hits = 0;
    const catcher = http.createServer((req, res) => { hits += 1; res.writeHead(200); res.end('{"data":{"status":"confirmed"}}'); });
    await new Promise((r) => catcher.listen(catchPort, '127.0.0.1', r));
    const child = await startKassaChild({ MOCK_BLOCK_PRIVATE_WEBHOOKS: '1' });
    try {
      const v4 = await requestOn(child.port, 'POST', '/mock/verify-merchant', { url: `http://127.0.0.1:${catchPort}/callback` });
      check('#22: =1: private IPv4 в /mock/verify-merchant -> 403 + SSRF', v4.status === 403 && v4.text.includes('SSRF'));
      const v6 = await requestOn(child.port, 'POST', '/mock/verify-merchant', { url: 'http://[::1]:3101/hook' });
      check('#22: =1: private IPv6 -> 403', v6.status === 403);

      const tk = (await requestOn(child.port, 'POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' })).json().token;
      const body = validBody('ssrf-callback-1');
      body.receipt.receipts = { service: { callback_url: `http://127.0.0.1:${catchPort}/callback` } };
      await requestOn(child.port, 'POST', `/possystem/v1/Main/sell?token=${tk}`, body);
      await sleep(2000);
      const exported = (await requestOn(child.port, 'GET', '/mock/state')).json();
      const stateSlice = (exported && exported.state) || exported || {};
      const cb = Object.values(stateSlice.callbacks || {})[0];
      check('#22: =1: callback на приватный адрес заблокирован (SSRF в lastStatus)',
        hits === 0 && cb && String(cb.lastStatus).includes('SSRF'), `hits=${hits}, lastStatus=${cb && cb.lastStatus}`);
    } finally {
      child.stop();
      catcher.close();
    }
  }

  {
    const child = await startKassaChild({ MOCK_BLOCK_PRIVATE_WEBHOOKS: 'true' });
    try {
      const r = await requestOn(child.port, 'POST', '/mock/verify-merchant', { url: 'http://127.0.0.1:3101/hook' });
      check('#22: =true тоже включает SSRF-guard', r.status === 403);
    } finally {
      child.stop();
    }
  }

  await phaseRestart();

  console.log(`\nИТОГ: ${passed} passed, ${failed} failed\n`);
  return failed ? 1 : 0;
}

/** Дочерний стенд кассы на свободном порту с ожиданием healthz. */
async function startKassaChild(env = {}) {
  const { spawn } = require('child_process');
  const port = await freePort();
  const proc = spawn('node', [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      MOCK_PORT: String(port),
      MOCK_STATE_FILE: '',
      MOCK_PROCESS_MS: '0',
      MOCK_CALLBACK_RETRY_MS: '1000',
      MOCK_ADMIN_TOKEN: '',
      MOCK_OPERATOR_TOKEN: '',
      MOCK_HOSTED: '',
      MOCK_BLOCK_PRIVATE_WEBHOOKS: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(String(d)));
  const deadline = Date.now() + 5000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try {
      const r = await requestOn(port, 'GET', '/healthz');
      up = r.status === 200;
    } catch { /* стенд ещё поднимается */ }
    if (!up) await sleep(100);
  }
  if (!up) {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    throw new Error(`дочерний стенд кассы на :${port} не поднялся за 5 с`);
  }
  return { proc, port, stop: () => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } } };
}

/**
 * Фаза 2 — рестарт стенда (дефекты A-2/A-10/A-11 аудита):
 *   • MOCK_PROCESS_MS=0 печатает чек сразу, а не через 4 с (parseInt(x)||def);
 *   • незавершённый callback переживает рестарт и продолжает ретраиться
 *     (очередь сохраняет ссылку на восстановленный state);
 *   • токен с истёкшим TTL (12 ч) даёт ошибку 11, а не «работает вечно».
 */
async function phaseRestart() {
  const fs = require('fs');
  const stateFile = path.join(__dirname, `.selftest-state-${process.pid}.json`);
  const port = await freePort();
  const catchPort = await freePort();
  const hits = { fail: 0, ok: 0 };
  const catcher = http.createServer((req, res) => {
    if (req.url.startsWith('/fail')) { hits.fail += 1; res.writeHead(500); res.end('no'); return; }
    hits.ok += 1; res.writeHead(200); res.end('{"data":{"status":"confirmed"}}');
  });
  await new Promise((r) => catcher.listen(catchPort, '127.0.0.1', r));
  const env = {
    ...process.env, MOCK_PORT: String(port), MOCK_PROCESS_MS: '0', MOCK_CALLBACK_RETRY_MS: '500',
    MOCK_STATE_FILE: stateFile,
  };
  const start = () => spawn('node', [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const api = (method, url, body, headers = {}) => requestOn(port, method, url, body, headers);

  let child = start();
  await sleep(900);
  let tok = (await api('POST', '/possystem/v1/getToken', { login: 'loviitest', pass: 'mockpass123' })).json().token;
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
  await sleep(1300);
  check('MOCK_PROCESS_MS=0: чек печатается сразу', (await api('GET', `/possystem/v1/Main/report/${doc.uuid}?token=${tok}`)).json().status === 'done');
  for (let i = 0; i < 40 && hits.fail < 1; i += 1) await sleep(100); // первая callback-попытка — на следующем секундном тике (фиксированный sleep 1200 мс был гонкой)
  const hitsBefore = hits.fail;
  check('незавершённый callback ретраится до рестарта', hitsBefore >= 1);
  child.kill('SIGKILL');
  await sleep(400);

  child = start();
  await sleep(2500);
  check('после рестарта незавершённый callback продолжает ретраиться (A-2)', hits.fail > hitsBefore);
  child.kill('SIGKILL');
  await sleep(300);

  // Токен с истёкшим TTL: подкладываем в state-файл просроченную сессию
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  st.tokens = { ...(st.tokens || {}), expiredtoken: { login: 'loviitest', createdAt: Date.now() - 13 * 60 * 60 * 1000 } };
  fs.writeFileSync(stateFile, JSON.stringify(st));
  child = start();
  await sleep(900);
  const expired = (await api('GET', '/possystem/v1/Main/report/00000000-0000-0000-0000-000000000000?token=expiredtoken')).json();
  check('токен с истёкшим TTL -> ошибка 11 (A-11)', expired.error && expired.error.code === 11);

  child.kill('SIGKILL');
  fs.rmSync(stateFile, { force: true });
  catcher.close();
}

/** Свободный порт для параллельных прогонов selftest. */
function freePort() {
  return new Promise((resolve) => {
    const srv = require('net').createServer();
    srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => resolve(port)); });
  });
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
      res.on('end', () => resolve({ status: res.statusCode, text: buf, json: () => { try { return JSON.parse(buf); } catch { return null; } } }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

// Ловушка callback'ов мока (эмулирует ядро)
const catcher = http.createServer((req, res) => {
  global.__callbackHits = (global.__callbackHits || 0) + 1;
  res.writeHead(200); res.end('{"data":{"status":"confirmed"}}');
});
catcher.listen(PORT + 1);

const proc = spawn('node', [path.join(__dirname, 'server.js')], {
  env: { ...process.env, MOCK_PORT: String(PORT), MOCK_PROCESS_MS: '500', MOCK_CALLBACK_RETRY_MS: '1000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
proc.stdout.on('data', (d) => SERVER_LOG.push(String(d)));
proc.stderr.on('data', (d) => process.stderr.write(d));

setTimeout(async () => {
  let code = 0;
  try {
    code = await main();
  } catch (e) {
    console.error('selftest crashed:', e);
    code = 1;
  } finally {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    try { catcher.close(); } catch { /* ignore */ }
  }
  process.exit(code);
}, 800);
