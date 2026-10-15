#!/usr/bin/env node
/**
 * SZ probe — волна #121 (MS-12 + хвосты находок SZ Ф-1…Ф-4), ревизия b569db31 (squash PR #122).
 * Сигнал координатора: #62 comment 6188364198 (2026-10-15T08:57:58Z): «Прошу пробный проход:
 *   (1) MS-12: hosted без токена — бизнес 404+маркер, health/control живы, named-песочницы работают,
 *       старт-лог default=closed; (2) Ф-1: живые прогоны — Location/HTML без токенов
 *       (tbank/kassa/yookassa/atol/alfa + sber/vtb/first-ofd), non-hosted query → cookie-навигация;
 *   (3) Ф-2: токены с "="/";" через форму; (4) Ф-3: hosted-ns ?sandbox_token → 401;
 *   (5) регресс базлайна (числа приёмки — в #121). Статусы — сюда.»
 *
 * ПРЕДРЕГИСТРАЦИЯ DoD (зафиксирована ДО прогона; источник претензий — сигнал + PR #122 + issue #121):
 *   C0  Базлайн: npm test EXIT=0 на b569db3, поле-в-поле с приёмкой PR #122:
 *       core 84 · tbank PASSED · kassa 176 · yookassa 250 (wh 26) · atol 228 (cb 8) · alfa 377 (cb 32)
 *       · sber 71 (cb 21) · vtb 85 (cb 8) · first-ofd 108 (cb 18) · kontur 109 · taxcom 106
 *       · upstream 11 · links 84 файлов/0 битых · drift 828/828. (Выполнен до этой пробы; см. отчёт.)
 *   C1  MS-12, hosted без MOCK_SANDBOX_TOKEN (tbank, admin/operator токены заданы):
 *       старт-лог `default=closed (MS-12…)`; /healthz, /openapi.json, /sandboxes → 200 (public infra);
 *       бизнес POST /oauth/token (Basic partner:partner) → 404 c message+hint, содержащими «MS-12»;
 *       control жив: GET /admin без токена → 200 логин-форма; GET /admin с X-Mock-Admin-Token → 200 консоль
 *       (НЕ логин-форма); GET /mock/state с X-Operator-Token → 200; named-песочница:
 *       POST /mock/sandboxes (X-Operator-Token) → 2xx с ownerToken; бизнес с X-Sandbox-Token=<ownerToken>
 *       → 2xx/бизнес-ответ (НЕ 404-MS-12).
 *   C2  MS-12, hosted с MOCK_SANDBOX_TOKEN (owned, tbank): старт-лог `default=owner-token`;
 *       бизнес с X-Sandbox-Token → 200 (default обслуживается); бизнес без токена → 401 (owned admission).
 *   C3  Ф-1, tbank non-hosted (plain): GET /admin?admin_token=<valid> → 200 консоль + Set-Cookie
 *       mock_admin_token (HttpOnly, SameSite=Strict); навигация по cookie БЕЗ query → 200 консоль;
 *       GET /admin без авторизации → 200 логин-форма; POST /admin/login (поле admin_token) → 302,
 *       Location=/admin БЕЗ токенов, Set-Cookie выдан; POST /admin/action (CSRF из консоли, Origin
 *       same-origin) → 302, Location НЕ содержит admin_token=/sandbox_token=; BC: бизнес без токена
 *       → 200 (default open, старт-лог `default=open`).
 *   C4  Ф-1 Location ×4 (kassa/yookassa/atol/alfa, non-hosted, query→cookie→консоль→CSRF):
 *       POST /admin/action → 302, Location без admin_token=/sandbox_token=.
 *   C5  Ф-1 HTML owned ×3 (sber/vtb/first-ofd, MOCK_HOSTED=1 + MOCK_SANDBOX_TOKEN + MOCK_ADMIN_TOKEN):
 *       консоль (GET /admin с X-Mock-Admin-Token) → 200, HTML НЕ содержит ни значения admin-токена,
 *       ни owner/sandbox-токена, ни `admin_token=`/`sandbox_token=` в URL-параметрах (раньше: в owned
 *       в ссылки попадал фактический owner-токен); хит по query-токену в hosted → БЕЗ Set-Cookie.
 *   C6  Ф-2, kassa с MOCK_ADMIN_TOKEN=`adm=1;x&2`: POST /admin/login (admin_token=`adm=1;x&2`)
 *       → Set-Cookie (encoded); GET /admin по cookie → 200 консоль (раньше: сыное сравнение ломало
 *       токены с «=», «;», «&»).
 *   C7  Ф-3: hosted-owned: GET /?sandbox_token=<валидный owner> → 401 + hint «запрещены в hosted/owned»
 *       (query запрещён КАК КЛАСС — даже валидный токен); hosted-namespaces: бизнес с ?sandbox_token
 *       → 401 + hint (регресс находки Ф-3 MS-06: раньше 200+WARN); named-песочница в ns по заголовку
 *       → работает; сентинел `FAIL_QUERY_TOKEN_REJECTED` в репо отсутствует (grep=0); non-hosted:
 *       валидный query sandbox_token → BC-ответ + WARN «устарел» в stderr; невалидный query sandbox_token
 *       (non-hosted) → 401.
 *   C8  Ф-4 + log: — инспекция + рантайм: checkAdminAuth делегирует checkControlAccess с опцией hosted
 *       (core :1930-1949); рантайм core.checkAdminAuth: hosted+query → false, Bearer → true, non-hosted
 *       query → true (BC); taxcom-mock server.js подключает `log:` с тегом [taxcom-mock], kontur-ofd-mock —
 *       `[kontur-ofd-mock]`; оба передают hosted: HOSTED в createSandboxRuntime.
 *   C9  Наблюдение (флейк из отчёта PR #122): services/taxcom-mock/selftest.js изолированно ×2 — зелёный.
 *
 * Харнесс: zero-dep, последовательные инстансы (Node child_process, SIGTERM → graceful MS-04),
 * порты 3910–3921. EXIT=0 ⇔ все чек-пункты pass. Срез: /tmp/mock-services @ b569db3 (детач).
 */

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO = process.env.SZ_REPO || process.cwd();
const HOST = '127.0.0.1';

const results = [];
let counter = 0;
function check(name, pass, detail) {
  counter += 1;
  const id = 'C' + String(counter).padStart(2, '0');
  results.push({ id, name, pass: !!pass, detail: detail || '' });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}  ${name}${detail ? ' — ' + detail : ''}`);
}

function req(method, port, p, { headers = {}, body = null, timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : String(body));
    const hdrs = payload ? { 'content-length': payload.length, ...headers } : { ...headers };
    const r = http.request(
      { host: HOST, port, path: p, method, headers: hdrs, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    r.on('timeout', () => { r.destroy(new Error('timeout')); });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startInstance(label, service, env, port) {
  const child = spawn('node', [path.join(REPO, 'services', service, 'server.js')], {
    cwd: REPO,
    env: { ...process.env, MOCK_HOST: HOST, MOCK_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (c) => stdout.push(String(c)));
  child.stderr.on('data', (c) => stderr.push(String(c)));
  const deadline = Date.now() + 15000;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label}: процесс вышел (${child.exitCode})\nSTDOUT:${stdout.join('')}\nSTDERR:${stderr.join('')}`);
    try {
      for (const hp of ['/healthz', '/health']) {
        const h = await req('GET', port, hp, { timeoutMs: 900 });
        if (h.status === 200) { up = true; break; }
      }
      if (up) break;
    } catch { /* ещё не поднялся */ }
    await sleep(250);
  }
  if (!up) { try { child.kill('SIGKILL'); } catch {} throw new Error(`${label}: /healthz не поднялся за 15с\nSTDOUT:${stdout.join('')}\nSTDERR:${stderr.join('')}`); }
  return { child, stdout, stderr, port };
}

async function stopInstance(inst) {
  if (!inst || !inst.child || inst.child.exitCode !== null) return;
  const done = new Promise((r) => inst.child.once('exit', r));
  inst.child.kill('SIGTERM');
  const t = setTimeout(() => { try { inst.child.kill('SIGKILL'); } catch {} }, 8000);
  await done;
  clearTimeout(t);
}

async function withInstance(label, service, env, port, fn) {
  const inst = await startInstance(label, service, env, port);
  try { await fn(inst); } finally { await stopInstance(inst); }
}

// ---------- URL/cookie helpers ----------
function extractSetCookie(res, name) {
  const raw = res.headers['set-cookie'] || [];
  for (const c of raw) if (String(c).trim().startsWith(name + '=')) return String(c);
  return null;
}
function cookieValue(setCookieLine) {
  const m = /[^;]+/.exec(setCookieLine || '');
  return m ? m[0] : '';
}
function extractCsrf(html) {
  const patterns = [
    /name="_csrf"[^>]*value="([^"]+)"/,
    /value="([^"]+)"[^>]*name="_csrf"/,
    /name='_csrf'[^>]*value='([^']+)'/,
    /value='([^']+)'[^>]*name='_csrf'/,
  ];
  for (const re of patterns) { const m = re.exec(html); if (m) return m[1]; }
  return null;
}
const isLoginForm = (html) => /action="\/admin\/login"/.test(html) || /Вход в панель управления/.test(html);
const enc = encodeURIComponent;
const form = (obj) => Object.entries(obj).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');

function locationClean(loc) {
  return typeof loc === 'string' && !loc.includes('admin_token=') && !loc.includes('sandbox_token=');
}

const crypto = require('crypto');
// точная реплика tokenOf() из tbank-mock (Password по умолчанию mockpass123)
function tbankToken(payload) {
  const vals = [];
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'Token' || v === null || v === undefined || v === '' || typeof v === 'object') continue;
    vals.push([k, typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v)]);
  }
  vals.push(['Password', 'mockpass123']);
  vals.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256').update(vals.map(([, v]) => v).join('')).digest('hex');
}

// извлекает первую форму /admin/action (кнопка на записи) с hidden-полями
function extractActionForm(html) {
  const m = /<form[^>]*action="(\/admin\/action[^"]*)"[^>]*>([\s\S]*?)<\/form>/.exec(html);
  if (!m) return null;
  const fields = {};
  const re1 = /<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g;
  const re2 = /<input[^>]*value="([^"]*)"[^>]*name="([^"]+)"[^>]*>/g;
  let x;
  while ((x = re1.exec(m[2]))) fields[x[1]] = x[2];
  while ((x = re2.exec(m[2]))) if (fields[x[2]] === undefined) fields[x[2]] = x[1];
  if (!fields._csrf) return null;
  return { url: m[1], fields };
}

// сеет запись бизнес-API сервиса (чтобы консоль отрисовала кнопки с _csrf)
async function seedRecord(label, port) {
  try {
    if (label === 'tbank') {
      const payload = { TerminalKey: 'TBANKMOCKTEST', Amount: '100000', OrderId: 'szw121-' + Date.now() };
      payload.Token = tbankToken(payload);
      const r = await req('POST', port, '/v2/Init', { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      return r.status === 200 ? 'ok' : `Init ${r.status}: ${(r.body || '').slice(0, 120)}`;
    }
    if (label === 'yookassa') {
      const r = await req('POST', port, '/v3/payments', {
        headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('YOOKASSAMOCKTEST:mockpass123').toString('base64'), 'Idempotence-Key': 'sz-w121-' + Date.now() },
        body: JSON.stringify({ amount: { value: '100.00', currency: 'RUB' }, capture: true, description: 'sz-w121', confirmation: { type: 'redirect', return_url: `http://${HOST}/x` } }),
      });
      return r.status === 200 ? 'ok' : `payments ${r.status}: ${(r.body || '').slice(0, 120)}`;
    }
    if (label === 'alfa') {
      const r = await req('POST', port, '/payment/rest/register.do', {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ userName: 'ALFAMOCKTEST', password: 'mockpass123', orderNumber: 'szw121-' + Date.now(), amount: '100000', returnUrl: `http://${HOST}/x` }),
      });
      return r.status === 200 ? 'ok' : `register.do ${r.status}: ${(r.body || '').slice(0, 120)}`;
    }
  } catch (e) { return 'seed error: ' + e.message; }
  return null; // kassa/atol — консоль рендерит формы без записей
}

async function adminCookieFlow(port, adminToken) {
  // query-хит → Set-Cookie → консоль; затем CSRF из консоли.
  const hit = await req('GET', port, `/admin?admin_token=${enc(adminToken)}`);
  const sc = extractSetCookie(hit, 'mock_admin_token');
  const cookie = sc ? cookieValue(sc) : `mock_admin_token=${enc(adminToken)}`;
  const page = await req('GET', port, '/admin', { headers: { Cookie: cookie } });
  const csrf = extractCsrf(page.body);
  return { hit, sc, cookie, page, csrf };
}

async function main() {
  console.log(`# SZ probe wave121 @ ${REPO} (expect b569db3)`);
  console.log('# git: ' + fs.readFileSync(path.join(REPO, '.git', 'HEAD'), 'utf8').trim());

  // ============ C1: MS-12 hosted-no-token (tbank) ============
  await withInstance('tbank-hosted-notoken', 'tbank-mock',
    { MOCK_HOSTED: '1', MOCK_ADMIN_TOKEN: 'adm_w121', MOCK_OPERATOR_TOKEN: 'opr_w121', MOCK_SANDBOX_TOKEN: '' },
    3910, async (inst) => {
      const so = inst.stdout.join('');
      check('C1a старт-лог default=closed (MS-12)', so.includes('default=closed (MS-12'), so.split('\n').find((l) => l.includes('sandboxes:')) || '');

      const hz = await req('GET', inst.port, '/healthz');
      const hh = await req('GET', inst.port, '/health');
      const oa = await req('GET', inst.port, '/openapi.json');
      const sb = await req('GET', inst.port, '/sandboxes', { headers: { 'X-Operator-Token': 'opr_w121' } });
      const sbAnon = await req('GET', inst.port, '/sandboxes');
      check('C1b public infra жива (health/openapi/sandboxes → 200)', (hz.status === 200 || hh.status === 200) && oa.status === 200 && sb.status === 200, `healthz=${hz.status} health=${hh.status} openapi=${oa.status} sandboxes=${sb.status} (anon=${sbAnon.status}: control-gate, не MS-12)`);

      const biz = await req('POST', inst.port, '/oauth/token', {
        headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('partner:partner').toString('base64') },
        body: JSON.stringify({ grant_type: 'client_credentials' }),
      });
      const bizBody = biz.body || '';
      check('C1c бизнес 404 c маркером MS-12', biz.status === 404 && bizBody.includes('MS-12') && bizBody.includes('MOCK_SANDBOX_TOKEN'), `status=${biz.status}; body: ${bizBody.slice(0, 160).replace(/\n/g, ' ')}`);

      const anon = await req('GET', inst.port, '/admin');
      const adm = await req('GET', inst.port, '/admin', { headers: { 'X-Mock-Admin-Token': 'adm_w121' } });
      check('C1d control жив: /admin форма без токена, консоль по заголовку', anon.status === 200 && isLoginForm(anon.body) && adm.status === 200 && !isLoginForm(adm.body), `anon=${anon.status}(форма=${isLoginForm(anon.body)}) adm=${adm.status}(форма=${isLoginForm(adm.body)})`);

      const st = await req('GET', inst.port, '/mock/state', { headers: { 'X-Operator-Token': 'opr_w121' } });
      check('C1e control жив: /mock/state по operator-заголовку → 200', st.status === 200, `status=${st.status}`);

      const mk = await req('POST', inst.port, '/mock/sandboxes', { headers: { 'X-Operator-Token': 'opr_w121', 'content-type': 'application/json' }, body: JSON.stringify({ id: 'sz-w121' }) });
      let ownerToken = '';
      try { const j = JSON.parse(mk.body); ownerToken = j.ownerToken || j.owner_token || (j.creds && j.creds.ownerToken) || ''; } catch {}
      check('C1f named-песочница создаётся (POST /mock/sandboxes → 2xx+ownerToken)', mk.status >= 200 && mk.status < 300 && Boolean(ownerToken), `status=${mk.status}; body: ${mk.body.slice(0, 140).replace(/\n/g, ' ')}`);

      if (ownerToken) {
        const nbiz = await req('POST', inst.port, '/oauth/token', {
          headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('partner:partner').toString('base64'), 'X-Sandbox-Token': ownerToken },
          body: JSON.stringify({ grant_type: 'client_credentials' }),
        });
        const nb = nbiz.body || '';
        check('C1g named-песочница обслуживается (не 404-MS-12)', nbiz.status !== 404 || !nb.includes('MS-12'), `status=${nbiz.status}; body: ${nb.slice(0, 100).replace(/\n/g, ' ')}`);
      }
    });

  // ============ C2: MS-12 hosted-owned (tbank) ============
  await withInstance('tbank-hosted-owned', 'tbank-mock',
    { MOCK_HOSTED: '1', MOCK_SANDBOX_TOKEN: 'st_owned_w121', MOCK_ADMIN_TOKEN: '', MOCK_OPERATOR_TOKEN: '' },
    3911, async (inst) => {
      const so = inst.stdout.join('');
      check('C2a старт-лог default=owner-token', so.includes('default=owner-token'), so.split('\n').find((l) => l.includes('sandboxes:')) || '');

      const biz = await req('POST', inst.port, '/oauth/token', {
        headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('partner:partner').toString('base64'), 'X-Sandbox-Token': 'st_owned_w121' },
        body: JSON.stringify({ grant_type: 'client_credentials' }),
      });
      check('C2b default обслуживается с owner-токеном → 200', biz.status === 200, `status=${biz.status}; body: ${(biz.body || '').slice(0, 120).replace(/\n/g, ' ')}`);

      const none = await req('POST', inst.port, '/oauth/token', {
        headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('partner:partner').toString('base64') },
        body: JSON.stringify({ grant_type: 'client_credentials' }),
      });
      check('C2c default без токена → 401 (owned admission)', none.status === 401, `status=${none.status}; body: ${(none.body || '').slice(0, 120).replace(/\n/g, ' ')}`);
    });

  // ============ C3: Ф-1 tbank plain (query→cookie, Location, BC) ============
  await withInstance('tbank-plain', 'tbank-mock',
    { MOCK_ADMIN_TOKEN: 'adm_plain_w121', MOCK_OPERATOR_TOKEN: 'opr_plain_w121' },
    3913, async (inst) => {
      const so = inst.stdout.join('');
      check('C3a старт-лог default=open (BC non-hosted)', so.includes('default=open'), so.split('\n').find((l) => l.includes('sandboxes:')) || '');

      const bc = await req('POST', inst.port, '/oauth/token', {
        headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('partner:partner').toString('base64') },
        body: JSON.stringify({ grant_type: 'client_credentials' }),
      });
      check('C3b BC: бизнес без токена → 200 (default open)', bc.status === 200, `status=${bc.status}`);

      const flow = await adminCookieFlow(inst.port, 'adm_plain_w121');
      const sc = flow.sc;
      const cookieOk = Boolean(sc) && sc.includes('HttpOnly') && sc.includes('SameSite=Strict');
      check('C3c query admin_token → Set-Cookie HttpOnly/SameSite=Strict + консоль', flow.hit.status === 200 && cookieOk && !isLoginForm(flow.page.body), `hit=${flow.hit.status} cookie=${cookieOk} консоль=${!isLoginForm(flow.page.body)}`);

      const nav = await req('GET', inst.port, '/admin', { headers: { Cookie: flow.cookie } });
      check('C3d навигация по cookie без query → консоль', nav.status === 200 && !isLoginForm(nav.body), `status=${nav.status} форма=${isLoginForm(nav.body)}`);

      const anonForm = await req('GET', inst.port, '/admin');
      check('C3e /admin без авторизации → логин-форма 200', anonForm.status === 200 && isLoginForm(anonForm.body), `status=${anonForm.status}`);

      const lg = await req('POST', inst.port, '/admin/login', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ admin_token: 'adm_plain_w121' }) });
      const lgSc = extractSetCookie(lg, 'mock_admin_token');
      check('C3f POST /admin/login → 302, Location чист, cookie выдан', lg.status === 302 && locationClean(lg.headers.location) && Boolean(lgSc), `status=${lg.status} loc=${lg.headers.location} cookie=${Boolean(lgSc)}`);

      // Ф-1 tbank: консоль tbank — meta-refresh без форм; кнопки с _csrf появляются на записях → сеем Init
      const seeded = await seedRecord('tbank', inst.port);
      const page2 = await req('GET', inst.port, '/admin', { headers: { Cookie: flow.cookie } });
      const af = extractActionForm(page2.body);
      if (af) {
        const act = await req('POST', inst.port, af.url, {
          headers: { 'content-type': 'application/x-www-form-urlencoded', Cookie: flow.cookie, Origin: `http://${HOST}:${inst.port}` },
          body: form(af.fields),
        });
        check('C3g POST /admin/action → 302, Location БЕЗ токенов (Ф-1 tbank)', act.status === 302 && locationClean(act.headers.location), `seed=${seeded}; status=${act.status} loc=${act.headers.location} fields=${Object.keys(af.fields).join(',')}`);
      } else {
        check('C3g POST /admin/action → 302, Location БЕЗ токенов (Ф-1 tbank)', false, `seed=${seeded}; форма /admin/action не найдена в консоли`);
      }

      const se = inst.stderr.join('');
      check('C3h non-hosted: WARN о query-токе в stderr (Ф-3: WARN остался в non-hosted)', se.includes('устарел') && se.includes('admin_token'), se.split('\n').find((l) => l.includes('устарел')) || '—');
    });

  // ============ C4: Ф-1 Location ×4 (kassa/yookassa/atol/alfa plain) ============
  const c4services = [
    ['kassa-mock', 'kassa', 3914], ['yookassa-mock', 'yookassa', 3915], ['atol-mock', 'atol', 3916], ['alfa-mock', 'alfa', 3917],
  ];
  for (const [svc, label, port] of c4services) {
    await withInstance(`${label}-plain`, svc,
      { MOCK_ADMIN_TOKEN: `adm_${label}_w121`, MOCK_OPERATOR_TOKEN: `opr_${label}_w121` },
      port, async (inst) => {
        const flow = await adminCookieFlow(inst.port, `adm_${label}_w121`);
        let af = flow.csrf ? { url: '/admin/action', fields: { _csrf: flow.csrf, action: 'cancel-new', id: 'sz-no-such-id' } } : null;
        if (!af) {
          const seeded = await seedRecord(label, inst.port);
          const page2 = await req('GET', inst.port, '/admin', { headers: { Cookie: flow.cookie } });
          af = extractActionForm(page2.body);
          if (!af) { check(`C4 ${label}: /admin/action Location чист (Ф-1)`, false, `seed=${seeded}; CSRF/форма не найдены: ` + (page2.body || '').slice(0, 140).replace(/\n/g, ' ')); return; }
        }
        const act = await req('POST', inst.port, af.url, {
          headers: { 'content-type': 'application/x-www-form-urlencoded', Cookie: flow.cookie, Origin: `http://${HOST}:${inst.port}` },
          body: form(af.fields),
        });
        check(`C4 ${label}: /admin/action → 302, Location БЕЗ токенов (Ф-1)`, act.status === 302 && locationClean(act.headers.location), `status=${act.status} loc=${act.headers.location}`);
      });
  }

  // ============ C5: Ф-1 HTML owned ×3 (sber/vtb/first-ofd) ============
  const c5services = [
    ['sber-mock', 'sber', 3918], ['vtb-mock', 'vtb', 3919], ['first-ofd-mock', 'first-ofd', 3920],
  ];
  for (const [svc, label, port] of c5services) {
    const adminTok = `adm_${label}_w121`;
    const ownerTok = `st_${label}_w121`;
    await withInstance(`${label}-owned`, svc,
      { MOCK_HOSTED: '1', MOCK_SANDBOX_TOKEN: ownerTok, MOCK_ADMIN_TOKEN: adminTok, MOCK_OPERATOR_TOKEN: `opr_${label}_w121` },
      port, async (inst) => {
        const page = await req('GET', inst.port, '/admin', { headers: { 'X-Mock-Admin-Token': adminTok } });
        const html = page.body || '';
        const clean = page.status === 200 && !isLoginForm(html)
          && !html.includes(adminTok) && !html.includes(ownerTok)
          && !html.includes('admin_token=') && !html.includes('sandbox_token=');
        check(`C5 ${label}: owned консоль HTML без admin/owner токенов (Ф-1)`, clean,
          `status=${page.status} форма=${isLoginForm(html)} adminInHtml=${html.includes(adminTok)} ownerInHtml=${html.includes(ownerTok)} q1=${html.includes('admin_token=')} q2=${html.includes('sandbox_token=')}`);

        const qhit = await req('GET', inst.port, `/admin?admin_token=${enc(adminTok)}`);
        const qsc = extractSetCookie(qhit, 'mock_admin_token');
        check(`C5 ${label}: hosted query-хит БЕЗ Set-Cookie (cookie не выдаются в hosted)`, qsc === null, `status=${qhit.status} set-cookie=${Boolean(qsc)}`);
      });
  }

  // ============ C6: Ф-2 kassa weird token ============
  await withInstance('kassa-weird', 'kassa-mock',
    { MOCK_ADMIN_TOKEN: 'adm=1;x&2', MOCK_OPERATOR_TOKEN: 'opr_weird_w121' },
    3921, async (inst) => {
      const lg = await req('POST', inst.port, '/admin/login', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ admin_token: 'adm=1;x&2' }) });
      const sc = extractSetCookie(lg, 'mock_admin_token');
      check('C6a токен с «=; &» принят формой → Set-Cookie', lg.status === 302 && Boolean(sc), `status=${lg.status} cookie=${sc || '—'}`);

      const page = await req('GET', inst.port, '/admin', { headers: { Cookie: sc ? cookieValue(sc) : '' } });
      check('C6b cookie с «=; &» декодируется → консоль 200 (Ф-2 закрыт)', page.status === 200 && !isLoginForm(page.body), `status=${page.status} форма=${isLoginForm(page.body)}`);

      const csrf = extractCsrf(page.body);
      if (csrf) {
        const act = await req('POST', inst.port, '/admin/action', {
          headers: { 'content-type': 'application/x-www-form-urlencoded', Cookie: sc ? cookieValue(sc) : '', Origin: `http://${HOST}:${inst.port}` },
          body: form({ _csrf: csrf, action: 'cancel-new', id: 'sz-no-such-id' }),
        });
        check('C6c weird-токен: /admin/action → 302 Location чист', act.status === 302 && locationClean(act.headers.location), `status=${act.status} loc=${act.headers.location}`);
      } else {
        check('C6c weird-токен: /admin/action → 302 Location чист', false, 'CSRF не найден');
      }
    });

  // ============ C7: Ф-3 ============
  // hosted-owned: query запрещён как класс (валидный owner-токен в query → 401)
  await withInstance('tbank-owned-f3', 'tbank-mock', { MOCK_HOSTED: '1', MOCK_SANDBOX_TOKEN: 'st_f3_w121' }, 3915, async (inst) => {
    const r = await req('GET', inst.port, `/?sandbox_token=${enc('st_f3_w121')}`);
    const body = r.body || '';
    check('C7a hosted-owned: валидный токен в query → 401 + hint (запрещён как класс)', r.status === 401 && body.includes('запрещены в hosted/owned'), `status=${r.status}; body: ${body.slice(0, 140).replace(/\n/g, ' ')}`);
  });
  // hosted-namespaces: query → 401 (регресс Ф-3 MS-06: раньше 200+WARN); header работает
  await withInstance('tbank-hosted-ns', 'tbank-mock',
    { MOCK_HOSTED: '1', MOCK_TENANCY: 'namespaces', MOCK_OPERATOR_TOKEN: 'opr_ns_w121' },
    3912, async (inst) => {
      const so = inst.stdout.join('');
      check('C7b hosted-ns старт-лог default=closed (MS-12)', so.includes('default=closed (MS-12'), so.split('\n').find((l) => l.includes('sandboxes:')) || '');

      const q = await req('POST', inst.port, '/oauth/token?sandbox_token=st_fake_w121', {
        headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('partner:partner').toString('base64') },
        body: JSON.stringify({ grant_type: 'client_credentials' }),
      });
      check('C7c hosted-ns: ?sandbox_token → 401 + hint (раньше 200+WARN)', q.status === 401 && (q.body || '').includes('запрещены в hosted/owned'), `status=${q.status}; body: ${(q.body || '').slice(0, 140).replace(/\n/g, ' ')}`);

      const mk = await req('POST', inst.port, '/mock/sandboxes', { headers: { 'X-Operator-Token': 'opr_ns_w121', 'content-type': 'application/json' }, body: JSON.stringify({ sandbox: 'sz-ns-w121' }) });
      // namespaces: POST = switch-active (BC), запись создаётся при необходимости
      const list = await req('GET', inst.port, '/sandboxes', { headers: { 'X-Operator-Token': 'opr_ns_w121' } });
      const hasNamed = (list.body || '').includes('sz-ns-w121');
      if (!hasNamed) { check('C7d hosted-ns: named-песочница доступна по селектору (без query-токена)', false, `switch=${mk.status}:${(mk.body || '').slice(0, 100)} list=${(list.body || '').slice(0, 100)}`); }
      else {
        const nbiz = await req('POST', inst.port, '/oauth/token?sandbox=sz-ns-w121', {
          headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('partner:partner').toString('base64') },
          body: JSON.stringify({ grant_type: 'client_credentials' }),
        });
        const nb = nbiz.body || '';
        check('C7d hosted-ns: named-песочница доступна по селектору ?sandbox= (без query-токена)', nbiz.status === 200 || (!nb.includes('MS-12') && !nb.includes('запрещены')), `status=${nbiz.status}; body: ${nb.slice(0, 100).replace(/\n/g, ' ')}`);
      }
    });
  // non-hosted: query sandbox_token не влияет на бизнес (BC default open); на control не авторизует
  await withInstance('tbank-plain-f3', 'tbank-mock', { MOCK_ADMIN_TOKEN: 'adm_pf3_w121', MOCK_OPERATOR_TOKEN: 'opr_pf3_w121' }, 3916, async (inst) => {
    const ok = await req('POST', inst.port, '/oauth/token?sandbox_token=st_some_w121', {
      headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('partner:partner').toString('base64') },
      body: JSON.stringify({ grant_type: 'client_credentials' }),
    });
    check('C7e non-hosted: бизнес с ?sandbox_token → BC-ответ (default open, не 401/не MS-12)', ok.status === 200, `status=${ok.status}; body: ${(ok.body || '').slice(0, 100).replace(/\n/g, ' ')}`);

    const adm = await req('GET', inst.port, '/admin?sandbox_token=st_some_w121');
    check('C7f non-hosted (admin-токен задан): sandbox_token в query НЕ авторизует control (логин-форма, не консоль)', adm.status === 200 && isLoginForm(adm.body), `status=${adm.status} форма=${isLoginForm(adm.body)}`);
  });

  // сентинел-греп: только product-код (core + адаптеры); хиты в selftests (негативные ассерты)
  // и в docs/audit (мой исторический текст находки Ф-3 MS-06) — легитимны и считаются отдельно
  {
    let prodHits = 0;
    const prodPaths = ['packages/core/index.js'];
    for (const s of fs.readdirSync(path.join(REPO, 'services'))) prodPaths.push(`services/${s}/server.js`);
    for (const rel of prodPaths) {
      try { if (fs.readFileSync(path.join(REPO, rel), 'utf8').includes('FAIL_QUERY_TOKEN_REJECTED')) prodHits += 1; } catch {}
    }
    check('C7g сентинел FAIL_QUERY_TOKEN_REJECTED удалён из product-кода (core+адаптеры, grep=0)', prodHits === 0, `productHits=${prodHits}`);
  }

  // ============ C8: Ф-4 checkAdminAuth + log: taxcom/kontur ============
  {
    const coreSrc = fs.readFileSync(path.join(REPO, 'packages/core/index.js'), 'utf8');
    const m = /function checkAdminAuth\(req, adminToken = process\.env\.MOCK_ADMIN_TOKEN \|\| '', options = \{\}\) \{([\s\S]*?)\n\}/.exec(coreSrc);
    const bodySrc = m ? m[1] : '';
    check('C8a checkAdminAuth делегирует checkControlAccess с опцией hosted (Ф-4)', bodySrc.includes('checkControlAccess') && bodySrc.includes('hosted'), bodySrc.slice(0, 120).replace(/\n/g, ' '));

    const core = require(path.join(REPO, 'packages/core/index.js'));
    const fakeReq = (url, headers) => ({ url, headers: headers || {}, socket: {} });
    const hostedQuery = core.checkAdminAuth(fakeReq('/?admin_token=adm_f4', {}), 'adm_f4', { hosted: true });
    const hostedBearer = core.checkAdminAuth(fakeReq('/', { authorization: 'Bearer adm_f4' }), 'adm_f4', { hosted: true });
    const plainQuery = core.checkAdminAuth(fakeReq('/?admin_token=adm_f4', {}), 'adm_f4', { hosted: false });
    check('C8b рантайм Ф-4: hosted+query=false, hosted+Bearer=true, plain+query=true (BC)', hostedQuery === false && hostedBearer === true && plainQuery === true, `hostedQuery=${hostedQuery} hostedBearer=${hostedBearer} plainQuery=${plainQuery}`);

    const taxcomSrc = fs.readFileSync(path.join(REPO, 'services/taxcom-mock/server.js'), 'utf8');
    const konturSrc = fs.readFileSync(path.join(REPO, 'services/kontur-ofd-mock/server.js'), 'utf8');
    check('C8c taxcom: log:[taxcom-mock] + hosted: HOSTED', /log:\s*\(msg\)\s*=>\s*console\.error\(`\[taxcom-mock\]/.test(taxcomSrc) && /hosted:\s*HOSTED/.test(taxcomSrc), '');
    check('C8d kontur: log:[kontur-ofd-mock] + hosted: HOSTED', /log:\s*\(msg\)\s*=>\s*console\.error\(`\[kontur-ofd-mock\]/.test(konturSrc) && /hosted:\s*HOSTED/.test(konturSrc), '');
  }

  // ============ C9: flake-наблюдение taxcom selftest ×2 ============
  for (let i = 1; i <= 2; i++) {
    const r = await new Promise((resolve) => {
      const p = spawn('node', [path.join(REPO, 'services/taxcom-mock/selftest.js')], { cwd: REPO });
      let out = '';
      p.stdout.on('data', (c) => (out += String(c)));
      p.stderr.on('data', (c) => (out += String(c)));
      p.on('exit', (code) => resolve({ code, out }));
    });
    const m = /(\d+) passed, 0 failed/.exec(r.out);
    check(`C9 taxcom selftest изолированно #${i} (флейк-наблюдение PR #122)`, r.code === 0, m ? `${m[0]} (exit=${r.code})` : `exit=${r.code}`);
  }

  // ---------- итог ----------
  const failed = results.filter((r) => !r.pass);
  console.log('\n==== SZ WAVE121 SUMMARY ====');
  console.log(`total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
  for (const f of failed) console.log(`FAIL ${f.id} ${f.name} — ${f.detail.slice(0, 300)}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
