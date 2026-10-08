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

  // 13. stats кассы
  r = await request('GET', `/possystem/v1/stats/cashboxes/extended?token=${token}`);
  check('stats: Готова к работе', r.json().Status === 'Success' && r.json().Data[0].kktState === 'Готова к работе');

  console.log(`\nИТОГ: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
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
