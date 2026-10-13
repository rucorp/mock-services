#!/usr/bin/env node
// sz-wave87-vtb-baseline.js — SZ trial probe for wave #87 (vtb-mock, rev 11329556).
// Инварианты из сигнала координатора (issue #62, комментарий 6153478615):
//   (1) OAuth client_credentials: TTL ~170 с на виртуальных часах, истечение/обновление по expires_in
//   (2) Bearer + X-IBM-Client-Id (lowercase, без @ext.vtb.ru) — нарушение → invalid_client
//   (3) идемпотентность orderId (X-Mock-Replayed) vs НЕ-идемпотентность refundId (409 duplicate_refund_id)
//   (4) decimal-рубли {value, code:"RUB"} — не копейки; >2 знаков/не-RUB → invalid_amount
//   (5) callback payload как есть: PAYMENT → "Status" (заглавная), REFUND → "status" (строчные), без нормализации;
//       сценарии status-lowercase/reconciled; ACK = любой 2xx [FORK], дефолт 3×60s на виртуальных часах
//   (6) отсутствие PAN: REST-ответы, /admin/journal, callbacks, лог сервера — только маска first6**last4;
//       hosted-страницы содержат статичный каталог [FORK]-пресетов (документированные публичные
//       синтетические данные — в скан хранения не входят, урок #81 §6)
//   (7) SSRF-терминальность: hosted — доставка на private/reserved терминальна («заблокирован политикой SSRF»),
//       контроль — non-hosted доставка на loopback работает (дефолт false задокументирован)
//   (8) [FORK]-карты: официальная тестовая карта ВТБ (4111 1111 1111 1111, 12/24) истекла и отклоняется;
//       синтетические пресеты мока — успех/отказ эмитента
// Плюс: preauth-холд (NEW, без callback до complete), частичный complete, cancel→voided,
//       TTL ордера 20m → CANCELED «order expired», preauth_disabled, «без callback URL — очереди нет».
// Конвенция REPO: __dirname-резолв (урок P3c — никаких хардкодов cwd).
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..', '..');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: detail || '' });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, everyMs = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true;
    await sleep(everyMs);
  }
  return fn();
}

function request(port, method, p, { body, headers = {}, form } = {}) {
  return new Promise((resolve, reject) => {
    let payload = null;
    const h = { ...headers };
    if (form) {
      payload = new URLSearchParams(form).toString();
      h['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
    if (payload) h['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* html/empty */ }
        resolve({ statusCode: res.statusCode, raw, json, location: res.headers.location || '', replayed: res.headers['x-mock-replayed'] || '' });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const panScan = []; // «хранилища»: REST-ответы, журнал, лог сервера, тела callbacks
let htmlFormPages = 0; // hosted-HTML отдельно (содержат статичный каталог [FORK]-пресетов)
async function req2(port, method, p, opts = {}) {
  const r = await request(port, method, p, opts);
  if (opts.jsonStore) panScan.push(r.raw || '');
  else if (p.startsWith('/pay/')) htmlFormPages += 1;
  return r;
}

function startCollector(port, handler) {
  const deliveries = []; // {type, object, raw, ts}
  const srv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(raw); } catch { /* keep null */ }
      const entry = { type: json ? json.type : null, object: json ? json.object : null, raw, ts: Date.now() };
      deliveries.push(entry);
      panScan.push(raw);
      const { code } = handler(entry, deliveries);
      rs.writeHead(code, { 'Content-Type': 'application/json' });
      rs.end('{}');
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ srv, deliveries })));
}

async function startServer({ port, env = {}, label }) {
  const child = spawn('node', [path.join(REPO, 'services', 'vtb-mock', 'server.js')], {
    cwd: REPO,
    env: { ...process.env, MOCK_HOST: '127.0.0.1', MOCK_PORT: String(port), MOCK_VTB_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logChunks = [];
  child.stdout.on('data', (c) => { logChunks.push(c); });
  child.stderr.on('data', (c) => { logChunks.push(c); });
  const up = await waitFor(async () => {
    try { const r = await request(port, 'GET', '/health'); return r.statusCode === 200; } catch { return false; }
  }, 15000);
  if (!up) throw new Error(`server ${label} не поднялся на ${port}`);
  return { child, logText: () => Buffer.concat(logChunks).toString('utf8') };
}

const stopServer = async (s) => { if (s && s.child) { s.child.kill('SIGTERM'); await sleep(150); } };

const RETURN_URL = 'https://shop.test/ret';
const REST = '/openapi/smb/efcp/e-commerce/v1';
const PAN_OK = '4242424242424242';   // [FORK] синтетическая · успешная оплата (exp 1234, cvv 123)
const PAN_DECLINE = '4000000000000002'; // [FORK] повторяемый отказ эмитента
const PAN_OFFICIAL = '4111111111111111'; // официальная карта SMB-доки — истекла (12/24), непригодна

const uniq = (pfx) => `sz87-${pfx}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// ---------- Leg 1: OAuth, заголовки, orders/refunds, callbacks, preauth, PAN, часы ----------
async function leg1() {
  const PORT = 3125;
  const ENV_CREDS = { client_id: 'szclient', client_secret: 'SZ-SECRET-2026' };
  console.log(`\n— V1..V9: нога non-hosted :${PORT} (env-креды, retry 300ms, admin-token)`);
  const { srv: collector, deliveries } = await startCollector(3219, (e, all) => {
    // REFUND: первая доставка 500 (нет ACK), повторные 200
    if (e.type === 'REFUND' && all.filter((x) => x.type === 'REFUND' && x.object && x.object.refundId === e.object.refundId).length === 1) return { code: 500 };
    return { code: 200 };
  });
  const srv = await startServer({
    port: PORT,
    env: {
      MOCK_VTB_CLIENT_ID: ENV_CREDS.client_id,
      MOCK_VTB_CLIENT_SECRET: ENV_CREDS.client_secret,
      MOCK_VTB_CALLBACK_RETRY_MS: '300',
      MOCK_VTB_CALLBACK_URL: 'http://127.0.0.1:3219/cb',
      MOCK_ADMIN_TOKEN: 'SZADMIN',
    },
    label: 'leg1',
  });
  let log1 = srv.logText();

  // V1: OAuth client_credentials (token endpoint)
  const tokenRes = await req2(PORT, 'POST', '/passport/oauth2/token', { form: { ...ENV_CREDS, grant_type: 'client_credentials' }, jsonStore: true });
  check('V1 token: HTTP 200 + access_token/token_type=Bearer/expires_in=170', tokenRes.statusCode === 200 && tokenRes.json && Boolean(tokenRes.json.access_token) && tokenRes.json.token_type === 'Bearer' && tokenRes.json.expires_in === 170, `expires_in=${tokenRes.json && tokenRes.json.expires_in}`);
  let TOKEN = tokenRes.json.access_token;
  const badTok = await req2(PORT, 'POST', '/passport/oauth2/token', { form: { ...ENV_CREDS, client_secret: 'WRONG-SECRET', grant_type: 'client_credentials' }, jsonStore: true });
  check('V1 token: неверный secret → 401 invalid_client (RFC 6749 §5.2), без утечки', badTok.statusCode === 401 && badTok.json && badTok.json.error === 'invalid_client' && !JSON.stringify(badTok.json).includes(ENV_CREDS.client_secret));
  const badGrant = await req2(PORT, 'POST', '/passport/oauth2/token', { form: { ...ENV_CREDS, grant_type: 'password' }, jsonStore: true });
  check('V1 token: grant_type=password → 400 unsupported_grant_type', badGrant.statusCode === 400 && badGrant.json && badGrant.json.error === 'unsupported_grant_type');
  const auth = () => ({ Authorization: `Bearer ${TOKEN}`, 'X-IBM-Client-Id': ENV_CREDS.client_id });

  // V2: Bearer + X-IBM-Client-Id (lowercase, без суффикса)
  const orderBody = (id, extra = {}) => ({ orderId: id, orderName: 'sz87 заказ', amount: { value: 10.56, code: 'RUB' }, returnUrl: RETURN_URL, ...extra });
  const noIbm = await req2(PORT, 'POST', `${REST}/orders`, { body: orderBody(uniq('noibm')), headers: { Authorization: `Bearer ${TOKEN}` }, jsonStore: true });
  check('V2 orders без X-IBM-Client-Id → 401 invalid_client (hint: lowercase, без @ext.vtb.ru)', noIbm.statusCode === 401 && noIbm.json && noIbm.json.error === 'invalid_client' && /@ext\.vtb\.ru|НИЖНЕМ регистре/.test(String(noIbm.json.hint || '')));
  const badIbm = await req2(PORT, 'POST', `${REST}/orders`, { body: orderBody(uniq('badibm')), headers: { Authorization: `Bearer ${TOKEN}`, 'X-IBM-Client-Id': 'SzClient@ext.vtb.ru' }, jsonStore: true });
  check('V2 orders с регистром/суффиксом в X-IBM-Client-Id → 401 invalid_client', badIbm.statusCode === 401 && badIbm.json && badIbm.json.error === 'invalid_client');
  const okOrder = await req2(PORT, 'POST', `${REST}/orders`, { body: orderBody(uniq('main')), headers: auth(), jsonStore: true });
  check('V2 orders с корректными Bearer+X-IBM-Client-Id → 200', okOrder.statusCode === 200 && okOrder.json && okOrder.json.orderId);

  // V3: decimal-рубли + форма ордера
  const mainId = okOrder.json.orderId;
  const ov = okOrder.json;
  check('V3 ордер: status.value=CREATED (свой уровень), amount echo {value:10.56, code:RUB}', ov.status && ov.status.value === 'CREATED' && ov.amount && ov.amount.value === 10.56 && ov.amount.code === 'RUB');
  check('V3 ордер: payUrl → /pay/{orderId}; expire — ISO с миллисекундами и tz', typeof ov.payUrl === 'string' && ov.payUrl.includes(`/pay/${mainId}`) && /\.\d{3}(Z|[+-]\d{2}:\d{2})$/.test(String(ov.expire)), `expire=${ov.expire}`);
  const badDec = await req2(PORT, 'POST', `${REST}/orders`, { body: orderBody(uniq('dec'), { amount: { value: 10.567, code: 'RUB' } }), headers: auth(), jsonStore: true });
  check('V3 amount с 3 знаками после точки → 400 invalid_amount (десятичные рубли, не копейки)', badDec.statusCode === 400 && badDec.json && badDec.json.error === 'invalid_amount');
  const badCode = await req2(PORT, 'POST', `${REST}/orders`, { body: orderBody(uniq('cur'), { amount: { value: 10.56, code: 'USD' } }), headers: auth(), jsonStore: true });
  check('V3 amount.code=USD → 400 invalid_amount (code строго RUB)', badCode.statusCode === 400 && badCode.json && badCode.json.error === 'invalid_amount');

  // V4: идемпотентность orderId vs НЕ-идемпотентность refundId
  const replay = await req2(PORT, 'POST', `${REST}/orders`, { body: orderBody(mainId), headers: auth(), jsonStore: true });
  check('V4 повтор orderId → 200 + X-Mock-Replayed:1 + тот же orderCode (идемпотентно)', replay.statusCode === 200 && replay.replayed === '1' && replay.json && replay.json.orderCode === ov.orderCode, `replayed=${replay.replayed}`);
  const payRes = await req2(PORT, 'POST', `/pay/${mainId}/pay`, { form: { pan: PAN_OK, exp: '1234', cvv: '123' } });
  check('V4 оплата [FORK]-картой → 302 redirect на returnUrl', payRes.statusCode === 302 && payRes.location === RETURN_URL, `code=${payRes.statusCode} loc=${payRes.location}`);
  const paid = await req2(PORT, 'GET', `${REST}/orders/${encodeURIComponent(mainId)}`, { headers: auth(), jsonStore: true });
  const paymentId = paid.json && paid.json.payments && paid.json.payments[0] && paid.json.payments[0].paymentId;
  check('V4 GET orders: status.value=PAID, payment CONFIRMED, paymentId выдан', paid.statusCode === 200 && paid.json.status.value === 'PAID' && paid.json.payments[0].status.value === 'CONFIRMED' && Boolean(paymentId));
  const refundId1 = uniq('ref1');
  const ref1 = await req2(PORT, 'POST', `${REST}/refunds`, { body: { refundId: refundId1, paymentId, amount: { value: 3.33, code: 'RUB' } }, headers: auth(), jsonStore: true });
  check('V4 частичный refund 3.33 из 10.56 → 200 CONFIRMED', ref1.statusCode === 200 && ref1.json && ref1.json.status.value === 'CONFIRMED', `code=${ref1.statusCode}`);
  const afterRef1 = await req2(PORT, 'GET', `${REST}/orders/${encodeURIComponent(mainId)}`, { headers: auth(), jsonStore: true });
  check('V4 статус ордера после частичного возврата = PARTIALLY_REFUNDED', afterRef1.json && afterRef1.json.status.value === 'PARTIALLY_REFUNDED');
  const refDup = await req2(PORT, 'POST', `${REST}/refunds`, { body: { refundId: refundId1, paymentId, amount: { value: 1, code: 'RUB' } }, headers: auth(), jsonStore: true });
  check('V4 повтор refundId → 409 duplicate_refund_id (ошибка, а НЕ replay; X-Mock-Replayed нет)', refDup.statusCode === 409 && refDup.json && refDup.json.error === 'duplicate_refund_id' && refDup.replayed === '' && /не идемпотентный replay|ошибка, а не/.test(String(refDup.json.hint || '')));
  const ref2 = await req2(PORT, 'POST', `${REST}/refunds`, { body: { refundId: uniq('ref2'), paymentId, amount: { value: 7.23, code: 'RUB' } }, headers: auth(), jsonStore: true });
  const afterRef2 = await req2(PORT, 'GET', `${REST}/orders/${encodeURIComponent(mainId)}`, { headers: auth(), jsonStore: true });
  check('V4 второй refund 7.23 (сумма = списанию) → ордер REFUNDED', ref2.statusCode === 200 && afterRef2.json && afterRef2.json.status.value === 'REFUNDED');

  // V5: [FORK]-карты — официальная истекла, отказ эмитента
  const forkId = uniq('fork');
  await req2(PORT, 'POST', `${REST}/orders`, { body: orderBody(forkId), headers: auth(), jsonStore: true });
  const official = await req2(PORT, 'POST', `/pay/${forkId}/pay`, { form: { pan: PAN_OFFICIAL, exp: '1224', cvv: '123' } });
  check('V5 официальная карта ВТБ (4111…, 12/24) → форма с отказом «истекла»', official.statusCode === 200 && /истекла/.test(official.raw));
  const officialState = await req2(PORT, 'GET', `${REST}/orders/${encodeURIComponent(forkId)}`, { headers: auth(), jsonStore: true });
  check('V5 после официальной карты: status.value=CREATED, payments пуст', officialState.json && officialState.json.status.value === 'CREATED' && officialState.json.payments.length === 0);
  const decline = await req2(PORT, 'POST', `/pay/${forkId}/pay`, { form: { pan: PAN_DECLINE, exp: '1234', cvv: '123' } });
  check('V5 [FORK]-карта отказа эмитента → форма с причиной, оплаты нет', decline.statusCode === 200 && /Отказ эмитента/.test(decline.raw));
  const expBad = await req2(PORT, 'POST', `/pay/${forkId}/pay`, { form: { pan: PAN_OK, exp: '1299', cvv: '123' } });
  check('V5 неверный срок/CVV пресета → форма с ошибкой сверки', expBad.statusCode === 200 && /Срок\/CVV не совпадают/.test(expBad.raw));

  // V6: callbacks payload как есть (Status vs status), ACK/ретрай
  await waitFor(() => deliveries.some((d) => d.type === 'PAYMENT' && d.object && d.object.orderId === mainId), 5000);
  const payCb = deliveries.find((d) => d.type === 'PAYMENT' && d.object && d.object.orderId === mainId);
  check('V6 PAYMENT-callback: ключ "Status" заглавными, "status" отсутствует (без нормализации)', payCb && payCb.object && ('Status' in payCb.object) && !('status' in payCb.object) && payCb.object.Status.value === 'CONFIRMED');
  check('V6 PAYMENT-callback: без signature/checksum; amount {value,code:RUB}; paymentData.cardMask=424242**4242', payCb && !('signature' in payCb.object) && !('checksum' in payCb.object) && payCb.object.amount && payCb.object.amount.code === 'RUB' && payCb.object.paymentData && payCb.object.paymentData.cardMask === '424242**4242');
  await sleep(900); // > retry 300ms: ACK 200 → повторов нет
  check('V6 ACK 200 → ровно 1 доставка PAYMENT по ордеру (терминальный done)', deliveries.filter((d) => d.type === 'PAYMENT' && d.object && d.object.orderId === mainId).length === 1);
  await waitFor(() => deliveries.filter((d) => d.type === 'REFUND' && d.object && d.object.refundId === refundId1).length >= 2, 8000);
  check('V6 REFUND: отказ 500 → ретрай (env 300ms) → ACK 200', deliveries.filter((d) => d.type === 'REFUND' && d.object && d.object.refundId === refundId1).length >= 2);
  const refCb = deliveries.find((d) => d.type === 'REFUND' && d.object && d.object.refundId === refundId1);
  check('V6 REFUND-callback: ключ "status" строчными, "Status" отсутствует (payload как есть)', refCb && refCb.object && ('status' in refCb.object) && !('Status' in refCb.object) && refCb.object.status.value === 'CONFIRMED');
  // сценарий status-lowercase: СБП-вариант статуса у платежа
  const lowerId = uniq('lower');
  await req2(PORT, 'POST', `${REST}/orders`, { body: orderBody(lowerId), headers: auth(), jsonStore: true });
  await req2(PORT, 'POST', `/pay/${lowerId}/pay`, { form: { pan: PAN_OK, exp: '1234', cvv: '123' }, headers: { 'X-Mock-Scenario': 'status-lowercase' } });
  await waitFor(() => deliveries.some((d) => d.type === 'PAYMENT' && d.object && d.object.orderId === lowerId), 5000);
  const lowerCb = deliveries.find((d) => d.type === 'PAYMENT' && d.object && d.object.orderId === lowerId);
  check('V6 сценарий status-lowercase: PAYMENT отдаёт "status" (СБП-вариант) — регистр ключа не нормализуется', lowerCb && lowerCb.object && ('status' in lowerCb.object) && !('Status' in lowerCb.object));
  // сценарий reconciled
  const recId = uniq('rec');
  await req2(PORT, 'POST', `${REST}/orders`, { body: orderBody(recId), headers: auth(), jsonStore: true });
  await req2(PORT, 'POST', `/pay/${recId}/pay`, { form: { pan: PAN_OK, exp: '1234', cvv: '123' }, headers: { 'X-Mock-Scenario': 'reconciled' } });
  await waitFor(() => deliveries.some((d) => d.type === 'PAYMENT' && d.object && d.object.orderId === recId), 5000);
  const recCb = deliveries.find((d) => d.type === 'PAYMENT' && d.object && d.object.orderId === recId);
  check('V6 сценарий reconciled: payment RECONCILED и в callback Status.value=RECONCILED', recCb && recCb.object && recCb.object.Status && recCb.object.Status.value === 'RECONCILED');

  // V7: preauth — холд NEW без callback, частичный complete, cancel → voided
  const preId = uniq('pre');
  const pre = await req2(PORT, 'POST', `${REST}/orders/preauth`, { body: orderBody(preId, { amount: { value: 9, code: 'RUB' }, twoStageParams: { paymentCode: 'sz87' } }), headers: auth(), jsonStore: true });
  check('V7 preauth (twoStageParams обязателен) → 200, twoStageParams отражён', pre.statusCode === 200 && pre.json && Boolean(pre.json.twoStageParams));
  await req2(PORT, 'POST', `/pay/${preId}/pay`, { form: { pan: PAN_OK, exp: '1234', cvv: '123' } });
  const held = await req2(PORT, 'GET', `${REST}/orders/${encodeURIComponent(preId)}`, { headers: auth(), jsonStore: true });
  check('V7 холд: payment status.value=NEW, ордер остаётся CREATED (уровни не смешиваются)', held.json && held.json.payments[0].status.value === 'NEW' && held.json.status.value === 'CREATED');
  const preCbCount = () => deliveries.filter((d) => d.type === 'PAYMENT' && d.object && d.object.orderId === preId).length;
  await sleep(400);
  check('V7 холд: PAYMENT-callback НЕ уходит до complete (в срезе нет типа события холда)', preCbCount() === 0, `доставок: ${preCbCount()}`);
  const complete = await req2(PORT, 'POST', `${REST}/orders/complete/${encodeURIComponent(preId)}`, { body: { amount: { value: 5, code: 'RUB' } }, headers: auth(), jsonStore: true });
  const completed = await req2(PORT, 'GET', `${REST}/orders/${encodeURIComponent(preId)}`, { headers: auth(), jsonStore: true });
  check('V7 частичный complete 5 из 9 → payment CONFIRMED (5 ₽), ордер PAID', complete.statusCode === 200 && completed.json && completed.json.status.value === 'PAID' && completed.json.payments[0].status.value === 'CONFIRMED' && completed.json.payments[0].amount.value === 5);
  await waitFor(() => deliveries.some((d) => d.type === 'PAYMENT' && d.object && d.object.orderId === preId), 5000);
  check('V7 PAYMENT-callback уходит только после complete', deliveries.some((d) => d.type === 'PAYMENT' && d.object && d.object.orderId === preId && d.object.Status.value === 'CONFIRMED'));
  const complete2 = await req2(PORT, 'POST', `${REST}/orders/complete/${encodeURIComponent(preId)}`, { body: { amount: { value: 1, code: 'RUB' } }, headers: auth(), jsonStore: true });
  check('V7 повторный complete → 409 invalid_order_state', complete2.statusCode === 409 && complete2.json && complete2.json.error === 'invalid_order_state');
  await sleep(700);
  check('V7 и после отказа complete доставок по ордеру по-прежнему 1', preCbCount() === 1);
  const pre2Id = uniq('pre2');
  await req2(PORT, 'POST', `${REST}/orders/preauth`, { body: orderBody(pre2Id, { amount: { value: 4, code: 'RUB' }, twoStageParams: { paymentCode: 'sz87b' } }), headers: auth(), jsonStore: true });
  await req2(PORT, 'POST', `/pay/${pre2Id}/pay`, { form: { pan: PAN_OK, exp: '1234', cvv: '123' } });
  const cancel = await req2(PORT, 'POST', `${REST}/orders/${encodeURIComponent(pre2Id)}/cancel`, { body: { cancelReason: 'sz87 cancel probe' }, headers: auth(), jsonStore: true });
  const canceled = await req2(PORT, 'GET', `${REST}/orders/${encodeURIComponent(pre2Id)}`, { headers: auth(), jsonStore: true });
  check('V7 cancel preauth до complete → CANCELED, холд помечен voided (статуса reversal в срезе нет)', cancel.statusCode === 200 && canceled.json && canceled.json.status.value === 'CANCELED' && canceled.json.payments[0].voided === true);
  const cancelComplete = await req2(PORT, 'POST', `${REST}/orders/complete/${encodeURIComponent(pre2Id)}`, { body: { amount: { value: 1, code: 'RUB' } }, headers: auth(), jsonStore: true });
  check('V7 complete по отменённому → 409 invalid_order_state', cancelComplete.statusCode === 409 && cancelComplete.json && cancelComplete.json.error === 'invalid_order_state');

  // V8: PAN-скан хранилищ (REST-ответы, журнал, callbacks, лог) — HTML-страницы с каталогом пресетов исключены
  const journal = await req2(PORT, 'GET', '/admin/journal', { headers: { Authorization: 'Bearer SZADMIN' }, jsonStore: true });
  check('V8 /admin/journal доступен с Bearer-токеном', journal.statusCode === 200);
  log1 = srv.logText();
  const haystack = panScan.join('\n') + '\n' + log1;
  check('V8 полный PAN отсутствует в REST-ответах, журнале, callbacks и логе сервера', !haystack.includes(PAN_OK) && !haystack.includes(PAN_DECLINE) && !haystack.includes(PAN_OFFICIAL));
  check('V8 маска first6**last4 (424242**4242) присутствует в заказе/платеже', /424242\*{2}4242/.test(haystack));
  check(`V8 hosted-страниц (с документированным каталогом [FORK]-пресетов) посещено: ${htmlFormPages} — в скан хранения не входят`, htmlFormPages >= 5);

  // V9: виртуальные часы — TTL токена +171s (истечение/обновление) и TTL ордера +20m
  const ttlOrder = await req2(PORT, 'POST', `${REST}/orders`, { body: orderBody(uniq('ttl')), headers: auth(), jsonStore: true });
  check('V9 подготовка: свежий ордер CREATED и токен выдан', ttlOrder.statusCode === 200 && ttlOrder.json.status.value === 'CREATED');
  const adv171 = await req2(PORT, 'POST', '/mock/time', { body: { advance: '+171s' }, headers: { Authorization: 'Bearer SZADMIN' } });
  const expired = await req2(PORT, 'POST', `${REST}/orders`, { body: orderBody(uniq('afterttl')), headers: { Authorization: `Bearer ${TOKEN}`, 'X-IBM-Client-Id': ENV_CREDS.client_id }, jsonStore: true });
  // tickVtb() раз в секунду лениво удаляет истёкшие токены → описание либо «Срок действия … истёк»,
  // либо «Неизвестный access_token»; инвариант — 401 invalid_token именно от виртуальных часов (hint про expires_in)
  check('V9 /mock/time +171s → токен истёк на виртуальных часах: 401 invalid_token (hint про expires_in)', adv171.statusCode === 200 && expired.statusCode === 401 && expired.json && expired.json.error === 'invalid_token' && /expires_in|виртуальн/.test(String(expired.json.hint || '')) && /истёк|Неизвестный/.test(String(expired.json.error_description || '')), `code=${expired.statusCode} desc=${expired.json && expired.json.error_description}`);
  const renew = await req2(PORT, 'POST', '/passport/oauth2/token', { form: { ...ENV_CREDS, grant_type: 'client_credentials' }, jsonStore: true });
  check('V9 обновление по expires_in: новый client_credentials → 200 с новым access_token', renew.statusCode === 200 && renew.json && Boolean(renew.json.access_token) && renew.json.access_token !== TOKEN);
  TOKEN = renew.json.access_token;
  const ttlState = await req2(PORT, 'GET', `${REST}/orders/${encodeURIComponent(ttlOrder.json.orderId)}`, { headers: auth(), jsonStore: true });
  check('V9 TTL ордера 20 мин не наступил после +171s (171s < 1200s), CREATED жив', ttlState.json && ttlState.json.status.value === 'CREATED');
  const adv20 = await req2(PORT, 'POST', '/mock/time', { body: { advance: '+20m' }, headers: { Authorization: 'Bearer SZADMIN' } });
  // +20m истёк и обновлённый токен (170s < 1200s) — клиент снова перевыпускает по expires_in
  const renew2 = await req2(PORT, 'POST', '/passport/oauth2/token', { form: { ...ENV_CREDS, grant_type: 'client_credentials' }, jsonStore: true });
  TOKEN = renew2.json.access_token;
  const ttlAfter = await req2(PORT, 'GET', `${REST}/orders/${encodeURIComponent(ttlOrder.json.orderId)}`, { headers: auth(), jsonStore: true });
  check('V9 /mock/time +20m → незакрытый ордер CANCELED с причиной «order expired» (callback-типа истечения в срезе нет)', adv20.statusCode === 200 && ttlAfter.statusCode === 200 && ttlAfter.json && ttlAfter.json.status.value === 'CANCELED' && ttlAfter.json.cancelReason === 'order expired', `code=${ttlAfter.statusCode}`);

  await stopServer(srv);
  collector.close();
}

// ---------- Leg 2: дефолтные креды + дефолтный ретрай 60s ×3 на виртуальных часах ----------
async function leg2() {
  const PORT = 3126;
  console.log(`\n— V10: нога default-retry :${PORT} (дефолтные креды, retry 60s по умолчанию, часы)`);
  const { srv: collector, deliveries } = await startCollector(3218, () => ({ code: 500 })); // никогда не ACK
  const srv = await startServer({ port: PORT, env: { MOCK_VTB_CALLBACK_URL: 'http://127.0.0.1:3218/cb' }, label: 'leg2' }); // дефолты: vtbmocktest/mockpass123, retry 60s, max 3
  const tok = await req2(PORT, 'POST', '/passport/oauth2/token', { form: { grant_type: 'client_credentials', client_id: 'vtbmocktest', client_secret: 'mockpass123' }, jsonStore: true });
  check('V10 OAuth дефолтными синтетическими кредами (vtbmocktest/mockpass123) → 200', tok.statusCode === 200 && tok.json && Boolean(tok.json.access_token), `code=${tok.statusCode}`);
  const auth = () => ({ Authorization: `Bearer ${tok.json.access_token}`, 'X-IBM-Client-Id': 'vtbmocktest' });
  const ord = await req2(PORT, 'POST', `${REST}/orders`, { body: { orderId: uniq('def'), orderName: 'sz87 default', amount: { value: 1.01, code: 'RUB' }, returnUrl: RETURN_URL }, headers: auth(), jsonStore: true });
  check('V10 ордер с decimal-рублями 1.01 → 200 CREATED', ord.statusCode === 200 && ord.json && ord.json.status.value === 'CREATED');
  await req2(PORT, 'POST', `/pay/${ord.json.orderId}/pay`, { form: { pan: PAN_OK, exp: '1234', cvv: '123' } });
  const first = await waitFor(() => deliveries.length >= 1, 5000);
  check('V10 попытка 1 доставки immediate (PAYMENT), collector 500', first && deliveries[0].type === 'PAYMENT');
  check('V10 callback unsigned, ключ "Status" заглавными (дефолт, без сценариев)', deliveries[0] && !('signature' in deliveries[0].object) && ('Status' in deliveries[0].object));
  const adv1 = await req2(PORT, 'POST', '/mock/time', { body: { advance: '+60s' }, jsonStore: true });
  const second = await waitFor(() => deliveries.length >= 2, 5000);
  check('V10 /mock/time +60s ускорил ретрай → попытка 2', adv1.statusCode === 200 && second);
  await req2(PORT, 'POST', '/mock/time', { body: { advance: '+60s' }, jsonStore: true });
  const third = await waitFor(() => deliveries.length >= 3, 5000);
  check('V10 попытка 3 (последняя из max 3 по умолчанию)', third);
  await req2(PORT, 'POST', '/mock/time', { body: { advance: '+60s' }, jsonStore: true });
  await sleep(800);
  check('V10 исчерпание: ровно 3 доставки, 4-й нет (терминально)', deliveries.length === 3, `фактически ${deliveries.length}`);
  const jrn = await req2(PORT, 'GET', '/admin/journal', { jsonStore: true });
  check('V10 /admin/journal и /mock/time без токена в non-hosted читаемы (документированная модель)', jrn.statusCode === 200);
  await stopServer(srv);
  collector.close();
}

// ---------- Leg 3: SSRF-терминальность (hosted) ----------
async function leg3() {
  const PORT = 3127;
  console.log(`\n— V11: нога hosted :${PORT} (MOCK_HOSTED=1 → SSRF-блок по умолчанию)`);
  const { srv: collector, deliveries } = await startCollector(3217, () => ({ code: 200 }));
  const srv = await startServer({ port: PORT, env: { MOCK_HOSTED: '1', MOCK_ADMIN_TOKEN: 'SZADMIN3', MOCK_VTB_CALLBACK_URL: 'http://169.254.169.254/latest/meta-data' }, label: 'leg3' });
  const tok = await req2(PORT, 'POST', '/passport/oauth2/token', { form: { grant_type: 'client_credentials', client_id: 'vtbmocktest', client_secret: 'mockpass123' }, jsonStore: true });
  const auth = () => ({ Authorization: `Bearer ${tok.json.access_token}`, 'X-IBM-Client-Id': 'vtbmocktest' });
  const ord = await req2(PORT, 'POST', `${REST}/orders`, { body: { orderId: uniq('ssrf'), orderName: 'sz87 ssrf', amount: { value: 2, code: 'RUB' }, returnUrl: RETURN_URL }, headers: auth(), jsonStore: true });
  check('V11 ордер с callback-URL (metadata 169.254.169.254) принят: OAuth+Bearer+X-IBM-Client-Id работают в hosted', ord.statusCode === 200 && ord.json && ord.json.status.value === 'CREATED');
  const payRes = await req2(PORT, 'POST', `/pay/${ord.json.orderId}/pay`, { form: { pan: PAN_OK, exp: '1234', cvv: '123' } });
  check('V11 оплата прошла (302 на returnUrl), PAYMENT-callback поставлен в очередь', payRes.statusCode === 302);
  await sleep(1200);
  check('V11 SSRF: ни одна доставка на private/reserved не ушла (0 на collector)', deliveries.length === 0, `доставок: ${deliveries.length}`);
  const log3 = srv.logText();
  check('V11 SSRF-отказ зафиксирован сервером: «заблокирован политикой SSRF — терминальный отказ, без повторов»', /заблокирован политикой SSRF|SSRF_BLOCKED/.test(log3));
  await req2(PORT, 'POST', '/mock/time', { body: { advance: '+60s' }, headers: { Authorization: 'Bearer SZADMIN3' } });
  await sleep(1000);
  check('V11 терминальность: после /mock/time +60s доставок по-прежнему 0 (без ретрая)', deliveries.length === 0, `доставок: ${deliveries.length}`);
  const jrn = await req2(PORT, 'GET', '/admin/journal', { headers: { Authorization: 'Bearer SZADMIN3' }, jsonStore: true });
  check('V11 контроль: в non-hosted ногах доставка на 127.0.0.1 РАБОТАЛА (дефолт false задокументирован); журнал hosted читается с токеном', jrn.statusCode === 200);
  await stopServer(srv);
  collector.close();
}

// ---------- Leg 4: без callback URL очередь не создаётся; MOCK_VTB_PREAUTH=false ----------
async function leg4() {
  const PORT = 3128;
  console.log(`\n— V12: нога :${PORT} (без MOCK_VTB_CALLBACK_URL, MOCK_VTB_PREAUTH=false)`);
  const srv = await startServer({ port: PORT, env: { MOCK_VTB_PREAUTH: 'false' }, label: 'leg4' });
  const tok = await req2(PORT, 'POST', '/passport/oauth2/token', { form: { grant_type: 'client_credentials', client_id: 'vtbmocktest', client_secret: 'mockpass123' }, jsonStore: true });
  const auth = () => ({ Authorization: `Bearer ${tok.json.access_token}`, 'X-IBM-Client-Id': 'vtbmocktest' });
  const pre = await req2(PORT, 'POST', `${REST}/orders/preauth`, { body: { orderId: uniq('preoff'), orderName: 'sz87 preauth-off', amount: { value: 1, code: 'RUB' }, twoStageParams: { paymentCode: 'x' } }, headers: auth(), jsonStore: true });
  check('V12 MOCK_VTB_PREAUTH=false → preauth 403 preauth_disabled («отдельное разрешение банка»)', pre.statusCode === 403 && pre.json && pre.json.error === 'preauth_disabled');
  const ord = await req2(PORT, 'POST', `${REST}/orders`, { body: { orderId: uniq('nocb'), orderName: 'sz87 no-callback', amount: { value: 1, code: 'RUB' }, returnUrl: RETURN_URL }, headers: auth(), jsonStore: true });
  const payRes = await req2(PORT, 'POST', `/pay/${ord.json.orderId}/pay`, { form: { pan: PAN_OK, exp: '1234', cvv: '123' } });
  await sleep(1200);
  const log4 = srv.logText();
  check('V12 без callback URL: оплата прошла (302), очередь callback НЕ создаётся («поставлен в очередь» нет)', payRes.statusCode === 302 && !log4.includes('поставлен в очередь') && /оплата/.test(log4));
  await stopServer(srv);
}

(async () => {
  console.log('SZ wave #87 vtb-baseline — ревизия 11329556');
  const t0 = Date.now();
  try {
    await leg1();
    await leg2();
    await leg3();
    await leg4();
  } catch (e) {
    check('проба выполнилась без исключений', false, e.message);
  }
  const failed = results.filter((r) => r.ok === false);
  const passed = results.filter((r) => r.ok === true);
  console.log(`\nИТОГ: ${passed.length} passed, ${failed.length} failed · ${(Date.now() - t0) / 1000 | 0}s`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
    process.exit(1);
  }
  process.exit(0);
})();
