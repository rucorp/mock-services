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
let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); } else { failed += 1; console.log(`  ✗ ${name} ${extra}`); }
}

function request(method, url, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
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

  await phaseRestart();

  console.log(`\nИТОГ: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
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
  await sleep(1200);
  check('MOCK_PROCESS_MS=0: чек печатается сразу', (await api('GET', `/possystem/v1/Main/report/${doc.uuid}?token=${tok}`)).json().status === 'done');
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
    const data = body ? JSON.stringify(body) : null;
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
proc.stderr.on('data', (d) => process.stderr.write(d));

setTimeout(async () => {
  try { await main(); } catch (e) { console.error('selftest crashed:', e); process.exit(1); } finally { proc.kill(); catcher.close(); }
}, 800);
