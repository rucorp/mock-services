#!/usr/bin/env node
/**
 * SZ wave116 — пробный проход MS-06 (#116 @ cc6761b): миграция управляющих
 * токенов из query в заголовки/cookie.
 *
 * Чек-лист сигнала координатора (#62, 6181799890):
 *  (1) hosted: query-токены доступа не дают (/admin — форма; API — 401 + hint);
 *      header/cookie-доступ работает;
 *  (2) cookie-атрибуты (HttpOnly/SameSite) + CSRF-контур не сломан;
 *  (3) non-hosted: совместимость query + WARN;
 *  (4) sandbox_token: cookie читается, в owned query отклоняется;
 *  (5) регресс базлайна — отдельно полный `npm test` (лог рядом).
 *
 * Плюс находки-кандидаты SZ:
 *  Ф-1a  POST /admin/action redirect несёт admin_token/sandbox_token в URL
 *        (tbank 3401-3406 и ещё 4 адаптера);
 *  Ф-1b  adminPage sber/vtb/first-ofd вставляет admin_token (и owner-token
 *        как sandbox_token) в ссылки консоли (first-ofd 1688-1694);
 *  Ф-2   cookie-кодирование асимметрично: login пишет encodeURIComponent,
 *        чтение сравнивает RAW → токен с '=' через cookie не работает
 *        (header/query работают);
 *  Ф-3   sandbox_token в hosted-Namespaces принимается из query с WARN
 *        (режим 'owned' отклоняет) — нюанс против формулы «hosted/owned —
 *        fail-closed»; DX-хинт «В hosted-режиме query-токены запрещены»
 *        (tbank 2525) для hosted-Namespaces неточен;
 *  Ф-4   checkAdminAuth в ядре зовёт tokenMatches БЕЗ hosted → query-токен
 *        через этот путь не fail-closed в hosted (адаптеры его не зовут —
 *        латентно, только ядро/selftest).
 *
 * Zero dependencies, Node >= 18. Запуск: node sz-wave116-ms06-token-migration.js
 * © 2026 ООО «Аксиома» ИНН:7842223709 · Apache-2.0
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const EV = path.join(ROOT, 'evidence');
fs.mkdirSync(EV, { recursive: true });

const results = [];
function check(name, fn) {
  results.push({ name, fn });
}
const CONSOLE_MARKER = 'action="/admin/login"'; // форма входа — маркер «НЕ консоль»
function isConsole(body) {
  return typeof body === 'string' && body.length > 0 && !body.includes(CONSOLE_MARKER);
}

function request({ port, method = 'GET', p = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function spawnService({ name, script, env, port, healthPath = '/health' }) {
  const stderrLog = path.join(EV, `stderr-${name}.log`);
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { warnCount: 0, stderr: '' };
  child.stderr.on('data', (c) => {
    const s = c.toString('utf8');
    state.stderr += s;
    fs.appendFileSync(stderrLog, s);
  });
  const svc = {
    procs: [child],
    state,
    stderrLog,
    async waitReady(ms = 15000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        try {
          const r = await request({ port, p: healthPath });
          if (r.status === 200) return;
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error(`service ${name} не поднялся за ${ms} мс`);
    },
    /** Снапшот длины stderr для дельты WARN. */
    snapWarn() { return state.stderr.length; },
    stderrDelta(from) { return state.stderr.slice(from); },
    stop() {
      for (const c of svc.procs) { try { c.kill('SIGTERM'); } catch {} }
    },
  };
  return svc;
}

function formData(obj) {
  return new URLSearchParams(obj).toString();
}

async function main() {
  const started = new Date().toISOString();
  console.log(`SZ wave116 MS-06 probe @ cc6761b — start ${started}\n`);

  /* ── инстанс 1: tbank hosted+owned (admin/operator/sandbox fail-closed) ── */
  const tbankOwned = spawnService({
    name: 'tbank-owned',
    script: 'services/tbank-mock/server.js',
    port: 3920,
    env: {
      MOCK_PORT: '3920',
      MOCK_HOSTED: '1',
      MOCK_TENANCY: 'owned',
      MOCK_ADMIN_TOKEN: 'adm-sec-9f2',
      MOCK_OPERATOR_TOKEN: 'opr-sec-7c1',
      MOCK_SANDBOX_TOKEN: 'own-sec-5a3',
      MOCK_STATE_FILE: path.join(EV, 'tbank-owned-state.json'),
      MOCK_PUBLIC_BASE_URL: 'http://127.0.0.1:3920',
    },
  });

  /* ── инстанс 2: tbank non-hosted namespaces, админ-токен с '=' (Ф-2) ── */
  const tbankPlain = spawnService({
    name: 'tbank-plain',
    script: 'services/tbank-mock/server.js',
    port: 3921,
    env: {
      MOCK_PORT: '3921',
      MOCK_TENANCY: 'namespaces',
      MOCK_ADMIN_TOKEN: 'adm.eq=3x',
      MOCK_STATE_FILE: path.join(EV, 'tbank-plain-state.json'),
      MOCK_PUBLIC_BASE_URL: 'http://127.0.0.1:3921',
    },
  });

  /* ── инстанс 3: first-ofd owned (второй сервис для owned/cookie/Ф-1b) ── */
  const ofdOwned = spawnService({
    name: 'ofd-owned',
    script: 'services/first-ofd-mock/server.js',
    port: 3922,
    env: {
      MOCK_PORT: '3922',
      MOCK_HOSTED: '1',
      MOCK_SANDBOX_TOKEN: 'ofd-own-8b2',
      MOCK_ADMIN_TOKEN: 'adm-ofd-6f4',
      MOCK_STATE_FILE: path.join(EV, 'ofd-owned-state.json'),
      MOCK_PUBLIC_BASE_URL: 'http://127.0.0.1:3922',
    },
  });

  /* ── инстанс 4: tbank hosted+namespaces (D: query sandbox_token + WARN) ── */
  const tbankNs = spawnService({
    name: 'tbank-ns',
    script: 'services/tbank-mock/server.js',
    port: 3923,
    env: {
      MOCK_PORT: '3923',
      MOCK_HOSTED: '1',
      MOCK_TENANCY: 'namespaces',
      MOCK_ADMIN_TOKEN: 'adm-ns-1c7',
      MOCK_OPERATOR_TOKEN: 'opr-ns-9k5',
      MOCK_STATE_FILE: path.join(EV, 'tbank-ns-state.json'),
      MOCK_PUBLIC_BASE_URL: 'http://127.0.0.1:3923',
    },
  });

  /* ── инстанс 5: sber non-hosted (Ф-1b: токен в ссылках консоли) ── */
  const sberPlain = spawnService({
    name: 'sber-plain',
    script: 'services/sber-mock/server.js',
    port: 3924,
    env: {
      MOCK_PORT: '3924',
      MOCK_ADMIN_TOKEN: 'sb-sec-2e9',
      MOCK_STATE_FILE: path.join(EV, 'sber-plain-state.json'),
      MOCK_PUBLIC_BASE_URL: 'http://127.0.0.1:3924',
    },
  });

  for (const s of [tbankOwned, tbankPlain, ofdOwned, tbankNs, sberPlain]) await s.waitReady();
  console.log('все 5 инстансов подняты\n');

  /* =================== нога A: hosted fail-closed + header/cookie =================== */
  check('A1 hosted: GET /admin без кредов → 200 форма входа (не консоль)', async () => {
    const r = await request({ port: 3920, p: '/admin' });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (isConsole(r.text)) throw new Error('ожидалась форма входа, отдана консоль');
    if (!r.text.includes('Вход в панель управления')) throw new Error('нет маркера формы');
  });
  check('A2 hosted: GET /admin?admin_token=<верный> → форма (query не даёт консоль)', async () => {
    const r = await request({ port: 3920, p: '/admin?admin_token=adm-sec-9f2' });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (isConsole(r.text)) throw new Error('query-токен в hosted дал консоль');
  });
  check('A3 hosted: GET /admin/journal?admin_token=<верный> → 401 + hint про запрет query', async () => {
    const r = await request({ port: 3920, p: '/admin/journal?admin_token=adm-sec-9f2' });
    if (r.status !== 401) throw new Error(`status ${r.status}, ожидался 401`);
    if (!r.text.includes('Токены в query запрещены в hosted-режиме')) throw new Error(`нет hint в теле: ${r.text.slice(0, 200)}`);
  });
  check('A4 hosted: GET /admin + Cookie mock_admin_token → 200 консоль', async () => {
    const r = await request({ port: 3920, p: '/admin', headers: { Cookie: 'mock_admin_token=adm-sec-9f2' } });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (!isConsole(r.text)) throw new Error('cookie-доступ не дал консоль');
  });
  check('A5 hosted: GET /admin + X-Mock-Admin-Token → консоль', async () => {
    const r = await request({ port: 3920, p: '/admin', headers: { 'X-Mock-Admin-Token': 'adm-sec-9f2' } });
    if (r.status !== 200 || !isConsole(r.text)) throw new Error(`status ${r.status}`);
  });
  check('A6 hosted: GET /admin + легаси X-Admin-Token → консоль (совместимость заголовка)', async () => {
    const r = await request({ port: 3920, p: '/admin', headers: { 'X-Admin-Token': 'adm-sec-9f2' } });
    if (r.status !== 200 || !isConsole(r.text)) throw new Error(`status ${r.status}`);
  });
  check('A7 hosted: GET /admin + Authorization: Bearer → консоль', async () => {
    const r = await request({ port: 3920, p: '/admin', headers: { Authorization: 'Bearer adm-sec-9f2' } });
    if (r.status !== 200 || !isConsole(r.text)) throw new Error(`status ${r.status}`);
  });
  check('A8 hosted: POST /admin/login → 302 /admin + Set-Cookie HttpOnly; SameSite=Strict; Path=/', async () => {
    const r = await request({
      port: 3920, method: 'POST', p: '/admin/login',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData({ admin_token: 'adm-sec-9f2', operator_token: 'opr-sec-7c1' }),
    });
    if (r.status !== 302) throw new Error(`status ${r.status}`);
    if ((r.headers.location || '') !== '/admin') throw new Error(`Location=${r.headers.location}`);
    const sc = [].concat(r.headers['set-cookie'] || []);
    const admin = sc.find((s) => s.startsWith('mock_admin_token='));
    const oper = sc.find((s) => s.startsWith('mock_operator_token='));
    if (!admin || !admin.includes('mock_admin_token=adm-sec-9f2')) throw new Error(`нет admin-cookie: ${sc}`);
    if (!oper) throw new Error('нет operator-cookie');
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/']) {
      if (!admin.includes(flag)) throw new Error(`нет флага ${flag} у admin-cookie`);
      if (!oper.includes(flag)) throw new Error(`нет флага ${flag} у operator-cookie`);
    }
  });
  check('A9 hosted: cookies из POST /admin/login дают консоль /admin', async () => {
    const r = await request({ port: 3920, p: '/admin', headers: { Cookie: 'mock_admin_token=adm-sec-9f2; mock_operator_token=opr-sec-7c1' } });
    if (r.status !== 200 || !isConsole(r.text)) throw new Error(`status ${r.status}`);
  });
  check('A10 hosted: GET /admin/journal + X-Mock-Admin-Token → 200 JSON', async () => {
    const r = await request({ port: 3920, p: '/admin/journal', headers: { 'X-Mock-Admin-Token': 'adm-sec-9f2' } });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (!r.text.includes('entries')) throw new Error('нет entries в журнале');
  });
  check('A11 hosted: GET /mock/sandboxes?operator_token → 401; + X-Operator-Token → 200', async () => {
    const bad = await request({ port: 3920, p: '/mock/sandboxes?operator_token=opr-sec-7c1' });
    if (bad.status !== 401) throw new Error(`query operator_token: status ${bad.status}, ожидался 401`);
    const ok = await request({ port: 3920, p: '/mock/sandboxes', headers: { 'X-Operator-Token': 'opr-sec-7c1' } });
    if (ok.status !== 200) throw new Error(`header operator_token: status ${ok.status}`);
  });
  check('A12 owned: POST /v2/Init?sandbox_token=<owner> → 401 (query sandbox_token отклонён)', async () => {
    const r = await request({ port: 3920, method: 'POST', p: '/v2/Init?sandbox_token=own-sec-5a3', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (r.status !== 401) throw new Error(`status ${r.status}, ожидался 401 (query отклонён)`);
    if (!r.text.includes('знание ID не является доступом') && !r.text.includes('unauthorized')) throw new Error(`неожиданное тело: ${r.text.slice(0, 160)}`);
  });

  /* =================== нога B: CSRF-контур не сломан =================== */
  check('B1 hosted: POST /admin/action без CSRF/Origin → 403 (контур жив)', async () => {
    const r = await request({
      port: 3920, method: 'POST', p: '/admin/action',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Mock-Admin-Token': 'adm-sec-9f2' },
      body: formData({ action: 'cancel-new', id: 'x' }),
    });
    if (r.status !== 403) throw new Error(`status ${r.status}, ожидался 403`);
    if (!r.text.includes('CSRF')) throw new Error('нет CSRF-маркера в отказе');
  });
  check('B2 hosted: POST /admin/action с _csrf из консоли + same-origin → НЕ 403 (позитив)', async () => {
    const page = await request({ port: 3920, p: '/admin', headers: { 'X-Mock-Admin-Token': 'adm-sec-9f2' } });
    const m = page.text.match(/name="_csrf" value="([^"]+)"/);
    if (!m) throw new Error('не нашёл _csrf в консоли');
    const r = await request({
      port: 3920, method: 'POST', p: '/admin/action',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Mock-Admin-Token': 'adm-sec-9f2',
        Origin: 'http://127.0.0.1:3920',
        Referer: 'http://127.0.0.1:3920/admin',
      },
      body: formData({ action: 'cancel-new', id: 'no-such-id', _csrf: m[1] }),
    });
    if (r.status === 403) throw new Error('валидный CSRF отклонён — контур сломан');
  });

  /* =================== нога C: non-hosted совместимость + WARN =================== */
  check('C1 non-hosted: GET /admin?admin_token=<верный> → консоль + WARN в stderr', async () => {
    const snap = tbankPlain.snapWarn();
    const r = await request({ port: 3921, p: '/admin?admin_token=adm.eq%3D3x' });
    if (r.status !== 200 || !isConsole(r.text)) throw new Error(`status ${r.status} (compat сломан?)`);
    const delta = tbankPlain.stderrDelta(snap);
    if (!delta.includes('query-строки устарел')) throw new Error('нет WARN о deprecated query');
  });
  check('C2 non-hosted: GET /admin + X-Mock-Admin-Token → консоль БЕЗ WARN', async () => {
    const snap = tbankPlain.snapWarn();
    const r = await request({ port: 3921, p: '/admin', headers: { 'X-Mock-Admin-Token': 'adm.eq=3x' } });
    if (r.status !== 200 || !isConsole(r.text)) throw new Error(`status ${r.status}`);
    const delta = tbankPlain.stderrDelta(snap);
    if (delta.includes('устарел')) throw new Error(`WARN при header-доступе: ${delta.slice(0, 160)}`);
  });
  check('C3 non-hosted: /admin/journal + header с токеном, содержащим "=" → 200 (header не ломается)', async () => {
    const r = await request({ port: 3921, p: '/admin/journal', headers: { 'X-Mock-Admin-Token': 'adm.eq=3x' } });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
  });

  /* =================== нога D: sandbox_token — cookie/owned/Namespaces =================== */
  check('D1 owned (tbank): POST /v2/Init + X-Sandbox-Token → admission пройден (не 401)', async () => {
    const r = await request({ port: 3920, method: 'POST', p: '/v2/Init', headers: { 'Content-Type': 'application/json', 'X-Sandbox-Token': 'own-sec-5a3' }, body: '{}' });
    if (r.status === 401 && r.text.includes('unauthorized')) throw new Error(`owner-token не принят: ${r.status} ${r.text.slice(0, 120)}`);
  });
  check('D2 owned (tbank): POST /v2/Init + Cookie mock_sandbox_token → admission пройден', async () => {
    const r = await request({ port: 3920, method: 'POST', p: '/v2/Init', headers: { 'Content-Type': 'application/json', Cookie: 'mock_sandbox_token=own-sec-5a3' }, body: '{}' });
    if (r.status === 401 && r.text.includes('unauthorized')) throw new Error(`cookie не принят: ${r.status}`);
  });
  check('D3 owned (first-ofd): query sandbox_token → 401; X-Sandbox-Token → мимо admission-отказа', async () => {
    const bad = await request({ port: 3922, method: 'POST', p: '/v2/unknown-probe?sandbox_token=ofd-own-8b2' });
    if (bad.status !== 401) throw new Error(`query: status ${bad.status}, ожидался 401`);
    const ok = await request({ port: 3922, method: 'POST', p: '/v2/unknown-probe', headers: { 'X-Sandbox-Token': 'ofd-own-8b2' } });
    if (ok.status === 401 && ok.text.includes('unauthorized')) throw new Error(`header: admission не пройден (${ok.status})`);
  });
  check('D4 owned (first-ofd): Cookie mock_sandbox_token → admission пройден (cookie читается в owned)', async () => {
    const r = await request({ port: 3922, method: 'POST', p: '/v2/unknown-probe', headers: { Cookie: 'mock_sandbox_token=ofd-own-8b2' } });
    if (r.status === 401 && r.text.includes('unauthorized')) throw new Error(`cookie не принят: ${r.status}`);
  });
  check('D5 owned (first-ofd): X-Sandbox-Token + X-Mock-Admin-Token → консоль /admin', async () => {
    const r = await request({ port: 3922, p: '/admin', headers: { 'X-Mock-Admin-Token': 'adm-ofd-6f4', 'X-Sandbox-Token': 'ofd-own-8b2' } });
    if (r.status !== 200 || !isConsole(r.text)) throw new Error(`status ${r.status}`);
  });

  /* =================== нога E: находки SZ (демонстрации) =================== */
  check('Ф-1b first-ofd: owner-токен попадает в ссылки консоли (sandbox_token= в HTML adminPage)', async () => {
    const r = await request({ port: 3922, p: '/admin', headers: { 'X-Mock-Admin-Token': 'adm-ofd-6f4', 'X-Sandbox-Token': 'ofd-own-8b2' } });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (r.text.includes('sandbox_token=ofd-own-8b2')) {
      console.log('  [Ф-1b] подтверждено: owner-токен в URL ссылок консоли (утечка Referer/логи)');
    } else {
      console.log('  [Ф-1b] в HTML страницы токен не найден — паттерн остаётся кодовым (first-ofd-mock/server.js:1690), не блокирует');
    }
  });
  check('Ф-1b sber: admin_token из query попадает в HTML консоли (утечка в Referer/логи)', async () => {
    const r = await request({ port: 3924, p: '/admin?admin_token=sb-sec-2e9' });
    if (r.status !== 200 || !isConsole(r.text)) throw new Error(`status ${r.status}`);
    if (!r.text.includes('admin_token=sb-sec-2e9')) throw new Error('токен не найден в HTML — проверить sber-mock/server.js:1177');
    console.log('  [Ф-1b sber] подтверждено: токен в HTML ссылок консоли');
  });
  check('Ф-1a tbank: POST /admin/action?admin_token=… → 302 Location несёт admin_token (токен в URL редиректа)', async () => {
    const page = await request({ port: 3923, p: '/admin', headers: { 'X-Mock-Admin-Token': 'adm-ns-1c7' } });
    const m = page.text.match(/name="_csrf" value="([^"]+)"/);
    if (!m) throw new Error('нет _csrf');
    const r = await request({
      port: 3923, method: 'POST', p: '/admin/action?admin_token=adm-ns-1c7',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Mock-Admin-Token': 'adm-ns-1c7',
        Origin: 'http://127.0.0.1:3923',
      },
      body: formData({ action: 'cancel-new', id: 'no-such-id', _csrf: m[1] }),
    });
    if (r.status !== 302) throw new Error(`status ${r.status}`);
    if (!(r.headers.location || '').includes('admin_token=adm-ns-1c7')) throw new Error(`Location без токена: ${r.headers.location}`);
    console.log(`  [Ф-1a] Location: ${r.headers.location}`);
  });
  check('Ф-2 cookie encode/decode асимметрия: токен с "=" — header работает, закодированная cookie НЕТ', async () => {
    const login = await request({
      port: 3921, method: 'POST', p: '/admin/login',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData({ admin_token: 'adm.eq=3x' }),
    });
    if (login.status !== 302) throw new Error(`login: ${login.status}`);
    const sc = [].concat(login.headers['set-cookie'] || []).find((s) => s.startsWith('mock_admin_token='));
    if (!sc || !sc.includes('adm.eq%3D3x')) throw new Error(`cookie не закодирована: ${sc}`);
    const enc = await request({ port: 3921, p: '/admin', headers: { Cookie: 'mock_admin_token=adm.eq%3D3x' } });
    const raw = await request({ port: 3921, p: '/admin', headers: { Cookie: 'mock_admin_token=adm.eq=3x' } });
    const encOk = enc.status === 200 && isConsole(enc.text);
    const rawOk = raw.status === 200 && isConsole(raw.text);
    console.log(`  [Ф-2] cookie закодированная → консоль: ${encOk}; cookie сырая → консоль: ${rawOk}`);
    if (encOk) throw new Error('ожидание Ф-2 не подтвердилось (закодированная cookie вдруг работает)');
    if (!rawOk) throw new Error('и сырая cookie не работает — асимметрия хуже ожиданий');
  });
  check('Ф-3 hosted-Namespaces: query sandbox_token ПРИНИМАЕТСЯ с WARN (нюанс против формулы fail-closed)', async () => {
    const create = await request({
      port: 3923, method: 'POST', p: '/sandboxes',
      headers: { 'Content-Type': 'application/json', 'X-Operator-Token': 'opr-ns-9k5' },
      body: JSON.stringify({}),
    });
    let ownerToken = '';
    try { ownerToken = JSON.parse(create.text).ownerToken || ''; } catch { /* ниже диагностика */ }
    if (!ownerToken) throw new Error(`POST /sandboxes: ${create.status} ${create.text.slice(0, 160)}`);
    const snap = tbankNs.snapWarn();
    const r = await request({ port: 3923, method: 'POST', p: `/v2/Init?sandbox_token=${encodeURIComponent(ownerToken)}`, headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const delta = tbankNs.stderrDelta(snap);
    const notRejected = !(r.status === 401 && r.text.includes('unauthorized'));
    console.log(`  [Ф-3] hosted-namespaces query sandbox_token: status=${r.status}, WARN=${delta.includes('sandbox_token') || delta.includes('query-строки устарел')}`);
    if (!notRejected) throw new Error('query sandbox_token отклонён — поведение изменилось против кода cc6761b');
  });
  check('Ф-4 checkAdminAuth (ядро) без hosted: query-токен проходит — латентная дыра API', async () => {
    const core = require(path.join(ROOT, 'packages/core/index.js'));
    const res = core.checkAdminAuth({ headers: {}, url: '/admin?admin_token=k' }, 'k');
    if (res !== true) throw new Error('ядро изменилось: checkAdminAuth уже не пропускает query');
    console.log('  [Ф-4] core.checkAdminAuth пропускает query-токен без hosted-опции (адаптеры путь не используют — латент)');
  });

  /* =================== прогон =================== */
  let passed = 0; const failed = [];
  for (const { name, fn } of results) {
    try {
      await fn();
      passed++; console.log(`PASS ${name}`);
    } catch (e) {
      failed.push({ name, err: e.message });
      console.log(`FAIL ${name}\n      ${e.message}`);
    }
  }
  console.log(`\nИТОГ: ${passed} passed, ${failed.length} failed`);
  for (const f of failed) console.log(`  FAILED: ${f.name}: ${f.err}`);
  for (const s of [tbankOwned, tbankPlain, ofdOwned, tbankNs, sberPlain]) s.stop();
  const exitCode = failed.length ? 1 : 0;
  console.log(`EXIT=${exitCode}`);
  process.exit(exitCode);
}

main().catch((e) => { console.error('probe crashed:', e); process.exit(2); });
