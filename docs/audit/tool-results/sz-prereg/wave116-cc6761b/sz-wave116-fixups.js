#!/usr/bin/env node
/**
 * SZ wave116-fixups — добивка к sz-wave116-ms06-token-migration.js (cc6761b).
 * Пять позиций v1, упавших по причинам харнесса:
 *  - A1/A8: в owned admission-слой закрывает /admin и /admin/login ДО формы
 *    (fail-closed admission выше логин-формы) → форма/логин проверяются на
 *    hosted-namespaces (там их и показали спот-пробы координатора);
 *  - B2/Ф-1a: у пустой консоли tbank нет форм с _csrf (adminButton рисуется
 *    только на записях) → создаём платёж валидным Init (tokenOf: sha256
 *    скаляров + Password, сортировка по ключу) и повторяем;
 *  - Ф-3: в namespaces POST /sandboxes — switch-active (BC), не create →
 *    нюанс проверяем простым запросом с ?sandbox_token без создания.
 *
 * Zero dependencies, Node >= 18.
 * © 2026 ООО «Аксиома» ИНН:7842223709 · Apache-2.0
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const EV = path.join(ROOT, 'evidence');
fs.mkdirSync(EV, { recursive: true });

const results = [];
function check(name, fn) { results.push({ name, fn }); }
const CONSOLE_MARKER = 'action="/admin/login"';
function isConsole(body) {
  return typeof body === 'string' && body.length > 0 && !body.includes(CONSOLE_MARKER);
}

function request({ port, method = 'GET', p = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function spawnService({ name, script, env, port }) {
  const stderrLog = path.join(EV, `stderr-${name}-fixups.log`);
  const child = spawn(process.execPath, [script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { stderr: '' };
  child.stderr.on('data', (c) => { const s = c.toString('utf8'); state.stderr += s; fs.appendFileSync(stderrLog, s); });
  const svc = {
    procs: [child], state,
    async waitReady(ms = 15000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        try { const r = await request({ port, p: '/health' }); if (r.status === 200) return; } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error(`service ${name} не поднялся`);
    },
    snapWarn() { return state.stderr.length; },
    stderrDelta(from) { return state.stderr.slice(from); },
    stop() { try { child.kill('SIGTERM'); } catch {} },
  };
  return svc;
}

/** Подпись tbank: sha256(скаляры top-level кроме Token + Password, сортировка по ключу). */
function tokenOf(payload, password) {
  const values = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'Token') continue;
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') continue;
    values.push([key, typeof value === 'boolean' ? String(value) : String(value)]);
  }
  values.push(['Password', password]);
  values.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256').update(values.map(([, v]) => v).join('')).digest('hex');
}

async function main() {
  console.log('SZ wave116 fixups @ cc6761b — start\n');

  const tbankOwned = spawnService({
    name: 'tbank-owned-fix', script: 'services/tbank-mock/server.js', port: 3920,
    env: {
      MOCK_PORT: '3920', MOCK_HOSTED: '1', MOCK_TENANCY: 'owned',
      MOCK_ADMIN_TOKEN: 'adm-sec-9f2', MOCK_OPERATOR_TOKEN: 'opr-sec-7c1', MOCK_SANDBOX_TOKEN: 'own-sec-5a3',
      MOCK_STATE_FILE: path.join(EV, 'tbank-owned-state-fix.json'), MOCK_PUBLIC_BASE_URL: 'http://127.0.0.1:3920',
    },
  });
  const tbankNs = spawnService({
    name: 'tbank-ns-fix', script: 'services/tbank-mock/server.js', port: 3923,
    env: {
      MOCK_PORT: '3923', MOCK_HOSTED: '1', MOCK_TENANCY: 'namespaces',
      MOCK_ADMIN_TOKEN: 'adm-ns-1c7', MOCK_OPERATOR_TOKEN: 'opr-ns-9k5',
      MOCK_STATE_FILE: path.join(EV, 'tbank-ns-state-fix.json'), MOCK_PUBLIC_BASE_URL: 'http://127.0.0.1:3923',
    },
  });
  await Promise.all([tbankOwned.waitReady(), tbankNs.waitReady()]);
  console.log('инстансы подняты\n');

  /* ── A1-owned: наблюдение — admission закрывает /admin до формы (Ф-5) ── */
  check('Ф-5 (наблюдение) owned: GET /admin без кредов → 401 admission (форма недостижима; fail-closed)', async () => {
    const r = await request({ port: 3920, p: '/admin' });
    if (r.status !== 401) throw new Error(`status ${r.status} — ожидался 401 admission`);
    console.log('  [Ф-5] в owned /admin без кредов закрыт admission-слоем (401), форма входа не показывается');
  });
  check('A1b hosted-namespaces: GET /admin без кредов → 200 форма входа (не консоль)', async () => {
    const r = await request({ port: 3923, p: '/admin' });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (isConsole(r.text)) throw new Error('отдана консоль вместо формы');
    if (!r.text.includes('Вход в панель управления')) throw new Error('нет маркера формы');
  });
  check('A2b hosted-namespaces: GET /admin?admin_token=<верный> → форма (query отклонён)', async () => {
    const r = await request({ port: 3923, p: '/admin?admin_token=adm-ns-1c7' });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (isConsole(r.text)) throw new Error('query-токен дал консоль в hosted-ns');
  });
  check('A8b hosted-namespaces: POST /admin/login → 302 + Set-Cookie HttpOnly/SameSite=Strict/Path=/ → cookie дают консоль', async () => {
    const login = await request({
      port: 3923, method: 'POST', p: '/admin/login',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ admin_token: 'adm-ns-1c7', operator_token: 'opr-ns-9k5' }).toString(),
    });
    if (login.status !== 302) throw new Error(`login status ${login.status}`);
    if ((login.headers.location || '') !== '/admin') throw new Error(`Location=${login.headers.location}`);
    const sc = [].concat(login.headers['set-cookie'] || []);
    const admin = sc.find((s) => s.startsWith('mock_admin_token='));
    if (!admin || !admin.includes('mock_admin_token=adm-ns-1c7')) throw new Error(`нет admin-cookie: ${sc}`);
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/']) if (!admin.includes(flag)) throw new Error(`нет флага ${flag}`);
    const page = await request({ port: 3923, p: '/admin', headers: { Cookie: 'mock_admin_token=adm-ns-1c7' } });
    if (page.status !== 200 || !isConsole(page.text)) throw new Error(`cookie из формы не дали консоль: ${page.status}`);
  });

  /* ── Init с валидной подписью → платёж → _csrf → B2-позитив и Ф-1a ── */
  const initBody = { TerminalKey: 'TBANKMOCKTEST', Amount: '1000', OrderId: 'sz-probe-1' };
  initBody.Token = tokenOf(initBody, 'mockpass123');
  check('D6 owned (tbank): POST /v2/Init (валидная подпись) + X-Sandbox-Token → 200, платёж создан', async () => {
    const r = await request({
      port: 3920, method: 'POST', p: '/v2/Init',
      headers: { 'Content-Type': 'application/json', 'X-Sandbox-Token': 'own-sec-5a3' },
      body: JSON.stringify(initBody),
    });
    if (r.status !== 200) throw new Error(`status ${r.status}: ${r.text.slice(0, 200)}`);
    const j = JSON.parse(r.text);
    if (!j.Success || !j.PaymentId) throw new Error(`нет PaymentId: ${r.text.slice(0, 200)}`);
  });
  check('B2v2 hosted-owned: POST /admin/action c _csrf из консоли (реальная запись) + same-origin → НЕ 403', async () => {
    const page = await request({ port: 3920, p: '/admin', headers: { 'X-Mock-Admin-Token': 'adm-sec-9f2' } });
    if (page.status !== 200 || !isConsole(page.text)) throw new Error(`консоль недоступна: ${page.status}`);
    const m = page.text.match(/name="_csrf" value="([^"]+)"/);
    if (!m) throw new Error('и с записью нет _csrf — смотреть разметку btn()');
    const idm = page.text.match(/name="id" value="([^"]+)"/);
    const id = idm ? idm[1] : 'sz-probe-1';
    const r = await request({
      port: 3920, method: 'POST', p: '/admin/action',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Mock-Admin-Token': 'adm-sec-9f2',
        Origin: 'http://127.0.0.1:3920', Referer: 'http://127.0.0.1:3920/admin',
      },
      body: new URLSearchParams({ action: 'cancel-new', id, _csrf: m[1] }).toString(),
    });
    if (r.status === 403) throw new Error('валидный CSRF отклонён');
    console.log(`  [B2v2] action с валидным CSRF → ${r.status} (контур жив)`);
  });
  check('Ф-1a-v2 tbank: POST /admin/action?admin_token=… → 302 Location несёт admin_token (утечка в URL)', async () => {
    const page = await request({ port: 3920, p: '/admin', headers: { 'X-Mock-Admin-Token': 'adm-sec-9f2' } });
    const m = page.text.match(/name="_csrf" value="([^"]+)"/);
    if (!m) throw new Error('нет _csrf');
    const idm = page.text.match(/name="id" value="([^"]+)"/);
    const id = idm ? idm[1] : 'sz-probe-1';
    const r = await request({
      port: 3920, method: 'POST', p: '/admin/action?admin_token=adm-sec-9f2',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Mock-Admin-Token': 'adm-sec-9f2',
        Origin: 'http://127.0.0.1:3920',
      },
      body: new URLSearchParams({ action: 'cancel-new', id, _csrf: m[1] }).toString(),
    });
    if (r.status !== 302) throw new Error(`status ${r.status}, ожидался 302`);
    const loc = r.headers.location || '';
    console.log(`  [Ф-1a-v2] Location: ${loc}`);
    if (!loc.includes('admin_token=adm-sec-9f2')) throw new Error(`Location без токена: ${loc}`);
  });

  /* ── Ф-3-v2: hosted-namespaces принимает ?sandbox_token c WARN (без создания) ── */
  check('Ф-3-v2 hosted-namespaces: /v2/Init?sandbox_token=<любой> → НЕ 401 + WARN в stderr (нюанс fail-closed)', async () => {
    const snap = tbankNs.snapWarn();
    const r = await request({
      port: 3923, method: 'POST', p: '/v2/Init?sandbox_token=sz-probe-token',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(initBody),
    });
    const delta = tbankNs.stderrDelta(snap);
    const rejected = r.status === 401 && r.text.includes('unauthorized');
    const warned = delta.includes('sandbox_token') && delta.includes('устарел');
    console.log(`  [Ф-3-v2] status=${r.status}, WARN-sandbox_token=${warned}`);
    if (rejected) throw new Error('query sandbox_token отклонён в hosted-ns — поведение против кода');
    if (!warned) throw new Error('нет WARN о deprecated query sandbox_token');
  });

  let passed = 0; const failed = [];
  for (const { name, fn } of results) {
    try { await fn(); passed++; console.log(`PASS ${name}`); }
    catch (e) { failed.push({ name, err: e.message }); console.log(`FAIL ${name}\n      ${e.message}`); }
  }
  console.log(`\nИТОГ: ${passed} passed, ${failed.length} failed`);
  for (const f of failed) console.log(`  FAILED: ${f.name}: ${f.err}`);
  tbankOwned.stop(); tbankNs.stop();
  const exitCode = failed.length ? 1 : 0;
  console.log(`EXIT=${exitCode}`);
  process.exit(exitCode);
}

main().catch((e) => { console.error('fixups crashed:', e); process.exit(2); });
