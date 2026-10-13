#!/usr/bin/env node
// sz-wave81-sber-baseline.js — SZ trial probe for wave #81 (sber-mock, rev 3f4dea20).
// Инварианты из сигнала координатора (issue #62, комментарий 6152069533):
//   (1) креды-hint: env-креды скрыты в стартовом логе; auth фактическими кредами работает
//   (2) callbacks: unsigned JSON, ACK только 200, дефолт 3 попытки × 60s, виртуальные часы ускоряют retry
//   (3) форк errorCode 1..6 ([FORK]: дубликат/авторизация/неизвестный заказ/неверное состояние/валидация/системная)
//   (4) отсутствие PAN: PAN не хранится/не логируется (REST-ответы, журнал, callbacks, лог сервера) —
//       только маска first6**last4; статичный каталог пресетов тестовых карт на hosted-страницах —
//       документированные публичные синтетические данные, в скан хранения не входит
//   (5) SSRF-терминальность: SSRF_BLOCKED в hosted — терминальный отказ без повтора (в т.ч. после +60s)
// Плюс: одностадийный и двухстадийный (preAuth) флоу, TTL 20m + declinedByTimeout, 3 попытки ACS.
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
        resolve({ statusCode: res.statusCode, raw, json, location: res.headers.location || '' });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const panScan = []; // «хранилища»: REST-ответы, журнал, лог сервера, тела callbacks
let htmlFormPages = []; // hosted-HTML отдельно (содержат статичный каталог пресетов)
async function req2(port, method, p, opts = {}) {
  const r = await request(port, method, p, opts);
  if (opts.jsonStore) panScan.push(r.raw || '');
  else htmlFormPages.push(r.raw || '');
  return r;
}

function startCollector(port, handler) {
  const deliveries = []; // {op, body, raw, ts}
  const srv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(raw); } catch { /* keep null */ }
      const entry = { op: json ? json.operation : null, body: json, raw, ts: Date.now() };
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
  const child = spawn('node', [path.join(REPO, 'services', 'sber-mock', 'server.js')], {
    cwd: REPO,
    env: { ...process.env, MOCK_PORT: String(port), MOCK_SBER_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, ...env },
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

// ---------- Leg 1: креды-hint, errorCode 1..6, оба флоу, callbacks, PAN, TTL ----------
async function leg1() {
  const PORT = 3115;
  const ENV_CREDS = { user: 'customuser', pass: 'CUSTOM-SECRET-2026' };
  console.log(`\n— S1/S2/S3/S4/S7: нога non-hosted :${PORT} (env-креды, retry 300ms, admin-token)`);
  const { srv: collector, deliveries } = await startCollector(3199, (e, all) => {
    // deposited: первая доставка 500 (нет ACK), повторные 200
    if (e.op === 'deposited' && all.filter((x) => x.op === 'deposited').length === 1) return { code: 500 };
    return { code: 200 };
  });
  const srv = await startServer({
    port: PORT,
    env: {
      MOCK_SBER_USERNAME: ENV_CREDS.user,
      MOCK_SBER_PASSWORD: ENV_CREDS.pass,
      MOCK_SBER_CALLBACK_RETRY_MS: '300',
      MOCK_ADMIN_TOKEN: 'SZADMIN',
    },
    label: 'leg1',
  });
  const log1 = srv.logText();

  // S1: стартовый лог скрывает env-креды
  check('S1 стартовый лог: "<задан через env, скрыт>" присутствует (userName и password)', (log1.match(/<задан через env, скрыт>/g) || []).length >= 2);
  check('S1 стартовый лог: фактические env-креды НЕ попали в лог', !log1.includes(ENV_CREDS.user) && !log1.includes(ENV_CREDS.pass));
  const creds = { userName: ENV_CREDS.user, password: ENV_CREDS.pass };
  const badCreds = { userName: ENV_CREDS.user, password: 'WRONG-PASSWORD' };

  // S2: форк errorCode 1..6
  const uniq = (pfx) => `sz81-${pfx}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const regBody = (extra) => ({ ...creds, amount: 100, currency: 643, returnUrl: RETURN_URL, ...extra });
  const okReg = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/register.do', { body: regBody({ orderNumber: uniq('ok'), amount: 15000 }), jsonStore: true });
  check('S2 register фактическими env-кредами: HTTP 200 + errorCode=0 + orderId/formUrl', okReg.statusCode === 200 && okReg.json && okReg.json.errorCode === 0 && Boolean(okReg.json.orderId) && Boolean(okReg.json.formUrl));
  check('S2 hint register прямо говорит: errorCode=0 НЕ подтверждение оплаты', String((okReg.json || {}).hint || '').includes('НЕ подтверждение оплаты'));
  const authErr = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/register.do', { body: { ...badCreds, orderNumber: uniq('auth'), amount: 100, currency: 643, returnUrl: RETURN_URL }, jsonStore: true });
  check('S2 errorCode=2 (авторизация): HTTP 200 + envelope, без утечки пароля', authErr.statusCode === 200 && authErr.json && authErr.json.errorCode === 2 && !JSON.stringify(authErr.json).includes(ENV_CREDS.pass));
  const dupNum = uniq('dup');
  const dupBase = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/register.do', { body: regBody({ orderNumber: dupNum }), jsonStore: true });
  const dup2 = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/register.do', { body: regBody({ orderNumber: dupNum }), jsonStore: true });
  check('S2 errorCode=1 (дубликат orderNumber)', dupBase.json && dupBase.json.errorCode === 0 && dup2.statusCode === 200 && dup2.json && dup2.json.errorCode === 1, `dup2=${dup2.json && dup2.json.errorCode}`);
  const unknown = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/getOrderStatusExtended.do', { body: { ...creds, orderId: 'no-such-order-id' }, jsonStore: true });
  check('S2 errorCode=3 (неизвестный заказ)', unknown.statusCode === 200 && unknown.json && unknown.json.errorCode === 3);
  const stErr = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/deposit.do', { body: { ...creds, orderId: okReg.json.orderId }, jsonStore: true });
  check('S2 errorCode=4 (неверное состояние: deposit по одностадийному)', stErr.statusCode === 200 && stErr.json && stErr.json.errorCode === 4);
  const badUrl = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/register.do', { body: regBody({ orderNumber: uniq('val'), dynamicCallbackUrl: 'notaurl' }), jsonStore: true });
  check('S2 errorCode=5 (валидация: dynamicCallbackUrl некорректен)', badUrl.statusCode === 200 && badUrl.json && badUrl.json.errorCode === 5);
  const failScn = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/register.do', { body: regBody({ orderNumber: uniq('scn') }), headers: { 'X-Mock-Scenario': 'fail' }, jsonStore: true });
  check('S2 errorCode=6 (системная, сценарий fail; HTTP 200 envelope)', failScn.statusCode === 200 && failScn.json && failScn.json.errorCode === 6);
  const st0 = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/getOrderStatusExtended.do', { body: { ...creds, orderId: okReg.json.orderId }, jsonStore: true });
  check('S2 orderStatus — числовой источник истины 0..6 (до оплаты 0), errorCode=0 ≠ успех', st0.statusCode === 200 && st0.json && Number.isInteger(st0.json.orderStatus) && st0.json.orderStatus >= 0 && st0.json.orderStatus <= 6 && st0.json.orderStatus === 0);

  // S3a: одностадийный pay-флоу с callback URL (created + deposited, без approved)
  const cbUrl = 'http://127.0.0.1:3199/cb';
  const payReg = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/register.do', { body: regBody({ orderNumber: uniq('pay'), amount: 25000, dynamicCallbackUrl: cbUrl }), jsonStore: true });
  check('S3 register с dynamicCallbackUrl → errorCode=0', payReg.statusCode === 200 && payReg.json && payReg.json.errorCode === 0);
  const orderId = payReg.json.orderId;
  const createdOk = await waitFor(() => deliveries.some((d) => d.op === 'created'), 5000);
  check('S3 callback "created" доставлен (JSON)', createdOk && deliveries[0] && deliveries[0].body && typeof deliveries[0].body === 'object');
  const cb = deliveries[0] ? deliveries[0].body : {};
  check('S3 callback unsigned: без signature/checksum, поля mdOrder/orderNumber/operation/status', !('signature' in cb) && !('checksum' in cb) && 'mdOrder' in cb && 'orderNumber' in cb && cb.operation === 'created' && [0, 1].includes(cb.status));
  await sleep(900); // > retry 300ms: ACK 200 → повторов нет
  check('S3 ACK 200 → повторной доставки "created" нет (терминальный done)', deliveries.filter((d) => d.op === 'created').length === 1);

  const formPath = new URL(payReg.json.formUrl).pathname;
  const formPage = await req2(PORT, 'GET', formPath);
  check('S4 hosted-форма открыта (HTML c пресетами и /pay)', formPage.statusCode === 200 && /\/pay/.test(formPage.raw));
  const PAN = '4006800900962514';
  const payPage = await req2(PORT, 'POST', `/payment/${orderId}/pay`, { form: { pan: PAN, exp: '0530', cvv: '706' } });
  check('S4 pay → ACS-страница (подсказка пароля 111111)', payPage.statusCode === 200 && /111111/.test(payPage.raw));
  const acs = await req2(PORT, 'POST', `/payment/${orderId}/3ds`, { form: { password: '111111' } });
  check('S4 ACS 111111 → успех (302 redirect на returnUrl)', [200, 302, 303].includes(acs.statusCode) && acs.location === RETURN_URL, `code=${acs.statusCode} loc=${acs.location}`);
  const stPaid = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/getOrderStatusExtended.do', { body: { ...creds, orderId }, jsonStore: true });
  check('S4 orderStatus после оплаты = 2 (deposited), одностадийный без approved-фазы', stPaid.json && stPaid.json.orderStatus === 2, `orderStatus=${stPaid.json && stPaid.json.orderStatus}`);
  const depFirst = await waitFor(() => deliveries.filter((d) => d.op === 'deposited').length >= 1, 5000);
  const depRetry = await waitFor(() => deliveries.filter((d) => d.op === 'deposited').length >= 2, 8000);
  check('S3 deposited: отказ 500 → ретрай → ACK 200 (env 300ms)', depFirst && depRetry);
  check('S3 refunded после частичного refund.do', await (async () => {
    const refund = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/refund.do', { body: { ...creds, orderId, amount: 5000 }, jsonStore: true });
    if (!(refund.statusCode === 200 && refund.json && refund.json.errorCode === 0)) return false;
    return waitFor(() => deliveries.some((d) => d.op === 'refunded'), 5000);
  })());

  // S3b: двухстадийный preAuth-флоу → approved → deposit → deposited
  const preReg = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/registerPreAuth.do', { body: regBody({ orderNumber: uniq('pre'), amount: 9000, dynamicCallbackUrl: cbUrl }), jsonStore: true });
  check('S3b registerPreAuth → errorCode=0 (MOCK_SBER_TWO_STAGE=true по умолчанию)', preReg.statusCode === 200 && preReg.json && preReg.json.errorCode === 0, `errorCode=${preReg.json && preReg.json.errorCode}`);
  if (preReg.json && preReg.json.orderId) {
    const preId = preReg.json.orderId;
    await req2(PORT, 'POST', `/payment/${preId}/pay`, { form: { pan: PAN, exp: '0530', cvv: '706' } });
    await req2(PORT, 'POST', `/payment/${preId}/3ds`, { form: { password: '111111' } });
    const preApproved = await waitFor(() => deliveries.some((d) => d.op === 'approved'), 5000);
    const stHold = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/getOrderStatusExtended.do', { body: { ...creds, orderId: preId }, jsonStore: true });
    check('S3b после ACS: approved-фаза, orderStatus=1 (холд)', preApproved && stHold.json && stHold.json.orderStatus === 1, `orderStatus=${stHold.json && stHold.json.orderStatus}`);
    const dep = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/deposit.do', { body: { ...creds, orderId: preId, amount: 6000 }, jsonStore: true });
    const stDep = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/getOrderStatusExtended.do', { body: { ...creds, orderId: preId }, jsonStore: true });
    check('S3b deposit частичный (6000 из 9000) → orderStatus=2 + deposited callback', dep.json && dep.json.errorCode === 0 && stDep.json && stDep.json.orderStatus === 2 && deliveries.some((d) => d.op === 'deposited'));
    const rev = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/reverse.do', { body: { ...creds, orderId: preId }, jsonStore: true });
    const revCb = await waitFor(() => deliveries.some((d) => d.op === 'reversed'), 5000);
    const stRev = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/getOrderStatusExtended.do', { body: { ...creds, orderId: preId }, jsonStore: true });
    check('S3b reverse после deposit легален (до взаиморасчётов): errorCode=0, orderStatus=3, reversed callback', rev.json && rev.json.errorCode === 0 && revCb && stRev.json && stRev.json.orderStatus === 3, `errorCode=${rev.json && rev.json.errorCode} orderStatus=${stRev.json && stRev.json.orderStatus}`);
    const rev2 = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/reverse.do', { body: { ...creds, orderId: preId }, jsonStore: true });
    check('S3b повторный reverse → errorCode=4 (неверное состояние)', rev2.statusCode === 200 && rev2.json && rev2.json.errorCode === 4, `errorCode=${rev2.json && rev2.json.errorCode}`);
  }

  // S4: PAN-скан хранилищ (REST-ответы, журнал, callbacks, лог) — HTML-страницы с каталогом пресетов исключены
  const journal = await req2(PORT, 'GET', '/admin/journal', { headers: { Authorization: 'Bearer SZADMIN' } });
  panScan.push(journal.raw || '');
  const statusPage2 = await req2(PORT, 'GET', `/payment/${orderId}`);
  const haystack = panScan.join('\n') + '\n' + srv.logText();
  check('S4 полный PAN отсутствует в REST-ответах, журнале, callbacks и логе сервера', !haystack.includes(PAN));
  const maskSeen = /400680\*{2}2514/.test(statusPage2.raw || '') || /400680\*{2}2514/.test(haystack);
  check('S4 маска first6**last4 (400680**2514) присутствует в заказе', maskSeen);
  check('S4 /admin/journal доступен с Bearer-токеном', journal.statusCode === 200);

  // S7a: 3 попытки ACS
  const acsReg = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/register.do', { body: regBody({ orderNumber: uniq('acs') }), jsonStore: true });
  const acsId = acsReg.json.orderId;
  for (let i = 0; i < 3; i++) {
    await req2(PORT, 'POST', `/payment/${acsId}/pay`, { form: { pan: PAN, exp: '0530', cvv: '706' } });
    const wrong = await req2(PORT, 'POST', `/payment/${acsId}/3ds`, { form: { password: '000000' } });
    if (i < 2) check(`S7 ACS неверный пароль, попытка ${i + 1}/3 → retry-форма`, wrong.statusCode === 200 && /\/pay/.test(wrong.raw));
  }
  const attStatus = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/getOrderStatusExtended.do', { body: { ...creds, orderId: acsId }, jsonStore: true });
  check('S7 три неверных ACS → заказ отклонён (orderStatus=6)', attStatus.json && attStatus.json.orderStatus === 6, `orderStatus=${attStatus.json && attStatus.json.orderStatus}`);

  // S7b: TTL 20m на виртуальных часах + declinedByTimeout
  const ttlReg = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/register.do', { body: regBody({ orderNumber: uniq('ttl'), dynamicCallbackUrl: cbUrl }), jsonStore: true });
  const ttlId = ttlReg.json.orderId;
  const adv = await req2(PORT, 'POST', '/mock/time', { body: { advance: '+20m' }, headers: { Authorization: 'Bearer SZADMIN' } });
  const ttl1 = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/getOrderStatusExtended.do', { body: { ...creds, orderId: ttlId }, jsonStore: true });
  const ttlCb = await waitFor(() => deliveries.some((d) => d.op === 'declinedByTimeout'), 5000);
  check('S7 TTL: /mock/time +20m → orderStatus=6 + callback declinedByTimeout', adv.statusCode === 200 && ttl1.json && ttl1.json.orderStatus === 6 && ttlCb, `orderStatus=${ttl1.json && ttl1.json.orderStatus}`);

  await stopServer(srv);
  collector.close();
  return { log1 };
}

// ---------- Leg 2: default 60s + виртуальные часы + max 3 попытки ----------
async function leg2() {
  const PORT = 3116;
  console.log(`\n— S5: нога default-retry :${PORT} (дефолтные креды, retry 60s по умолчанию, часы)`);
  const { srv: collector, deliveries } = await startCollector(3198, () => ({ code: 500 })); // никогда не ACK
  const srv = await startServer({ port: PORT, env: {}, label: 'leg2' }); // дефолты: SBERMOCKTEST/mockpass123, retry 60000, max 3
  const creds = { userName: 'SBERMOCKTEST', password: 'mockpass123' };
  const defReg = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/register.do', { body: { ...creds, orderNumber: `sz81-def-${Date.now()}`, amount: 100, currency: 643, returnUrl: RETURN_URL, dynamicCallbackUrl: 'http://127.0.0.1:3198/cb' }, jsonStore: true });
  check('S5 register с дефолтными синтетическими кредами → errorCode=0', defReg.statusCode === 200 && defReg.json && defReg.json.errorCode === 0, `errorCode=${defReg.json && defReg.json.errorCode}`);
  const first = await waitFor(() => deliveries.length >= 1, 5000);
  check('S5 попытка 1 доставки immediate (created), collector 500', first && deliveries[0].op === 'created');
  check('S5 callback unsigned (без signature/checksum)', deliveries[0] && !('signature' in deliveries[0].body) && !('checksum' in deliveries[0].body));
  const adv1 = await req2(PORT, 'POST', '/mock/time', { body: { advance: '+60s' }, jsonStore: true });
  const second = await waitFor(() => deliveries.length >= 2, 5000);
  check('S5 /mock/time +60s ускорил retry → попытка 2', adv1.statusCode === 200 && second);
  await req2(PORT, 'POST', '/mock/time', { body: { advance: '+60s' }, jsonStore: true });
  const third = await waitFor(() => deliveries.length >= 3, 5000);
  check('S5 попытка 3 (последняя из max 3)', third);
  await req2(PORT, 'POST', '/mock/time', { body: { advance: '+60s' }, jsonStore: true });
  await sleep(800);
  check('S5 исчерпание: ровно 3 доставки, 4-й нет (терминально)', deliveries.length === 3, `фактически ${deliveries.length}`);
  const journal2 = await req2(PORT, 'GET', '/admin/journal');
  check('S5 /admin/journal без токена в non-hosted читаем (документированная модель)', journal2.statusCode === 200);
  await stopServer(srv);
  collector.close();
}

// ---------- Leg 3: SSRF-терминальность (hosted) ----------
async function leg3() {
  const PORT = 3117;
  console.log(`\n— S6: нога hosted :${PORT} (MOCK_HOSTED=1 → SSRF-блок по умолчанию)`);
  const { srv: collector, deliveries } = await startCollector(3197, () => ({ code: 200 }));
  const srv = await startServer({ port: PORT, env: { MOCK_HOSTED: '1', MOCK_ADMIN_TOKEN: 'SZADMIN2' }, label: 'leg3' });
  const creds = { userName: 'SBERMOCKTEST', password: 'mockpass123' };
  const meta = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/register.do', { body: { ...creds, orderNumber: `sz81-ssrf-${Date.now()}`, amount: 100, currency: 643, returnUrl: RETURN_URL, dynamicCallbackUrl: 'http://169.254.169.254/latest/meta-data' }, jsonStore: true });
  check('S6 register с metadata-URL принят (валидный абсолютный http)', meta.statusCode === 200 && meta.json && meta.json.errorCode === 0);
  const loop = await req2(PORT, 'POST', '/ecomm/gw/partner/api/v1/register.do', { body: { ...creds, orderNumber: `sz81-ssrf2-${Date.now()}`, amount: 100, currency: 643, returnUrl: RETURN_URL, dynamicCallbackUrl: 'http://127.0.0.1:3197/cb' }, jsonStore: true });
  check('S6 register с loopback-URL принят', loop.statusCode === 200 && loop.json && loop.json.errorCode === 0);
  await sleep(1200);
  check('S6 SSRF: ни одна доставка на private/reserved не ушла (0 на collector)', deliveries.length === 0, `доставок: ${deliveries.length}`);
  const log3 = srv.logText();
  check('S6 SSRF-отказ зафиксирован сервером: «заблокирован политикой SSRF — терминальный отказ, без повторов»', /заблокирован политикой SSRF|SSRF_BLOCKED/.test(log3));
  // терминальность: виртуальные часы +60s — ретрая нет
  await req2(PORT, 'POST', '/mock/time', { body: { advance: '+60s' }, headers: { Authorization: 'Bearer SZADMIN2' } });
  await sleep(1000);
  check('S6 терминальность: после /mock/time +60s доставок по-прежнему 0 (без ретрая)', deliveries.length === 0, `доставок: ${deliveries.length}`);
  const jrn = await req2(PORT, 'GET', '/admin/journal', { headers: { Authorization: 'Bearer SZADMIN2' } });
  check('S6 контроль: в non-hosted ноге доставка на 127.0.0.1 РАБОТАЛА (дефолт false задокументирован); журнал hosted читается с токеном', jrn.statusCode === 200);
  await stopServer(srv);
  collector.close();
}

(async () => {
  console.log('SZ wave #81 sber-baseline — ревизия 3f4dea20');
  const t0 = Date.now();
  try {
    await leg1();
    await leg2();
    await leg3();
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
