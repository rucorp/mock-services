#!/usr/bin/env node
/**
 * SZ wave118 — пробный проход волны #112 «Такском» (#118 @ 822b2a3, #112).
 * Read-only кабинет/ОФД API v2: Login/Session-Token/AccountList/NewDocuments.
 *
 * ПРЕДРЕГИСТРАЦИЯ DoD (сформулирована по коду 822b2a3 ДО прогона; suite §2.13):
 *  - C1. Session-Token header-only, fail-closed (MS-06-дисциплина в новом
 *        адаптере): валидный токен в query → 401; дубликат заголовка → 401;
 *        case-вариант query → 401; hosted-owned: /admin* и /mock/* без
 *        управляющих токенов → 401; эха токена в ответах нет.
 *  - C2. Read-only граница: GET Login → 405; POST NewDocuments → 405;
 *        POST /API/v2/Sell → 404 с подсказкой; admin-консоль без форм/действий;
 *        поверхность исчерпывается ROUTES ∪ MOCK_ROUTES; исходящих HTTP-вызовов
 *        в server.js нет (SSRF-поверхность отсутствует).
 *  - C3. [FORK] мульти-сессии и бюджет: каждый Login даёт новый токен, старые
 *        живы до своего TTL; namespaces — сессии не ограничены квотой
 *        документов (0 = без лимита); owned: sessions делят бюджет документов —
 *        fixture ровно на максимуме → Login 429 «Лимит сессий песочницы»
 *        (ядро :2924 used>=max ДО добавления сессии), fixture max-1 → 200;
 *        истёкшие сессии reclaimed до проверки квоты.
 *  - C4. Секреты: журнал — шаблоны путей без query и без токенов/пароля/
 *        Integrator-ID; логи старта маскируют env-креды; /mock/state экспорт
 *        вычищает sessions; state-файл на диске содержит живые маркеры —
 *        по дизайну persist/restore и ЗАДОКУМЕНТИРОВАНО (README «Persist files
 *        содержат mock-маркеры/креды», docs/integration «State files содержат
 *        маркеры»).
 *  - C5. Контракты десятого сервиса: /openapi.json отдаётся и содержит все 3
 *        провайдерских пути (полная поверхность = 16 путей: 3 + 13 mock);
 *        compose :3109 (default bind 127.0.0.1 через MOCK_TAXCOM_BIND_IP),
 *        smoke/healthcheck/package.json включают taxcom; hosted-namespaces:
 *        query sandbox_token не даёт доступа к provider-API (401 по
 *        Session-Token) — поведение консистентно с Ф-3 из волны #116.
 *
 * Ф-НАХОДКА (демонстрация D1, вне чек-листа): createSandboxRuntime в
 * taxcom-mock вызывается БЕЗ log — ядро по умолчанию глушит диагностику
 * рантайма песочниц (WARN о приёме sandbox_token из query — контракт Ф-3
 * MS-06; сбои persist/restore реестра). 8/9 прежних адаптеров log
 * подключают (tbank/kassa/yookassa/atol/alfa/sber/vtb/first-ofd).
 *
 * Zero dependencies, Node >= 18. Эфемерные порты (MOCK_PORT=0).
 * © 2026 ООО «Аксиома» ИНН:7842223709 · Apache-2.0
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(__dirname, '..', '..', 'services', 'taxcom-mock', 'server.js');
const EV = path.join(__dirname, 'evidence');
fs.mkdirSync(EV, { recursive: true });

const results = [];
function check(name, fn) { results.push({ name, fn }); }
const szQuota = { id: null, ownerToken: null }; // созданная в C3c песочница (для C3d)

function request({ port, method = 'GET', p = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function spawnService({ name, env }) {
  const evFile = path.join(EV, `stderr-taxcom-${name}.txt`);
  fs.writeFileSync(evFile, '');
  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env: {
    ...process.env, MOCK_HOST: '127.0.0.1', MOCK_PORT: '0', ...env } , stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stderr.on('data', (c) => { const s = c.toString('utf8'); output += s; fs.appendFileSync(evFile, s); });
  child.stdout.on('data', (c) => { output += c.toString('utf8'); });
  const svc = {
    name, child, output: () => output, evFile,
    base: null, port: null,
    waitReady(ms = 15000) {
      const t0 = Date.now();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error(`startup timeout: ${output.slice(-400)}`)); }, ms);
        child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exit ${code}: ${output.slice(-400)}`)); });
        const iv = setInterval(() => {
          const m = /listening on :(\d+)/.exec(output);
          if (m) { clearInterval(iv); clearTimeout(timer); child.removeAllListeners('exit');
            svc.base = `http://127.0.0.1:${m[1]}`; svc.port = Number(m[1]); resolve(svc); }
        }, 50);
      });
    },
    stop() { try { child.kill(); } catch { /* уже мёртв */ } },
  };
  return svc;
}

const TTL_ENV = { MOCK_HOSTED: 'false', MOCK_TENANCY: 'namespaces', MOCK_STATE_FILE: '', MOCK_SANDBOX_FILE: '',
  MOCK_ADMIN_TOKEN: '', MOCK_OPERATOR_TOKEN: '', MOCK_SANDBOX_TOKEN: '', MOCK_TAXCOM_SESSION_TTL_SECS: '60',
  MOCK_VIRTUAL_CLOCK: '2026-10-11T12:00:00Z',
  MOCK_TAXCOM_LOGIN: 'sz-probe', MOCK_TAXCOM_PASSWORD: 'sz-probe-pass', MOCK_TAXCOM_INTEGRATOR_ID: 'SZ-PROBE-INTEGRATOR' };
const CREDS = { login: 'sz-probe', password: 'sz-probe-pass', integratorId: 'SZ-PROBE-INTEGRATOR' };
const LOGIN = '/API/v2/Login';
const ACCOUNTS = '/API/v2/AccountList';
const DOCS = '/API/v2/NewDocuments';

async function login(svc, headers = {}, creds = CREDS) {
  const r = await request({ port: svc.port, method: 'POST', p: LOGIN,
    headers: { 'Content-Type': 'application/json', 'Integrator-ID': creds.integratorId, ...headers },
    body: JSON.stringify({ login: creds.login, password: creds.password }) });
  return { status: r.status, token: safeJson(r.text).token, text: r.text };
}
function safeJson(t) { try { return JSON.parse(t); } catch { return {}; } }
const sessionOf = (token) => ({ 'Session-Token': token });

function fixture(n) {
  const base = Date.parse('2026-10-11T12:00:00Z');
  const docs = Array.from({ length: n }, (_, i) => ({
    id: `q-${String(i + 1).padStart(4, '0')}`, an: '1000001', kktRegNumber: '0000000000000001',
    type: 'receipt', receivedAt: new Date(base - (i + 1) * 60000).toISOString(),
    dateTime: new Date(base - (i + 1) * 60000).toISOString(),
    fiscalDocumentNumber: i + 1, fiscalSign: String(2000000000 + i), shiftNumber: 1,
    operationType: 1, totalSum: 100, cashSum: 0, electronicSum: 100,
    items: [{ name: 'sz-probe', price: 100, quantity: 1, sum: 100 }],
  }));
  return {
    accounts: [{ an: '1000001', inn: '7700000000', kpp: '770001001', name: 'sz-probe кабинет', accessible: true }],
    kkt: [{ an: '1000001', regNumber: '0000000000000001', model: 'SZ-KKT',
      fiscalDriveNumber: '9999078900000001', address: 'sz-probe', accessible: true }],
    documents: docs, clockOffsetMs: 0,
  };
}

async function main() {
  console.log('SZ wave118 — taxcom-mock read-only (822b2a3): предрегистрация C1–C5');
  const ns = spawnService({ name: 'ns', env: TTL_ENV });
  const owned = spawnService({ name: 'owned', env: { ...TTL_ENV, MOCK_HOSTED: 'true', MOCK_TENANCY: 'owned',
    MOCK_SANDBOX_MAX_DOCUMENTS: '30' } });
  const hns = spawnService({ name: 'hns', env: { ...TTL_ENV, MOCK_HOSTED: 'true', MOCK_TENANCY: 'namespaces' } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sz-wave118-'));
  const disk = spawnService({ name: 'disk', env: { ...TTL_ENV,
    MOCK_STATE_FILE: path.join(dir, 'state.json'), MOCK_SANDBOX_FILE: path.join(dir, 'sandboxes.json') } });
  for (const s of [ns, owned, hns, disk]) await s.waitReady();
  console.log(`instances: ns=${ns.port} owned=${owned.port} hns=${hns.port} disk=${disk.port}\n`);

  // ── C1. Session-Token header-only, fail-closed ──────────────────────────
  check('C1a: валидный токен в query ?session-token= → 401 (только заголовок)', async () => {
    const { token } = await login(ns);
    const q = await request({ port: ns.port, p: `${ACCOUNTS}?session-token=${encodeURIComponent(token)}` });
    const h = await request({ port: ns.port, p: ACCOUNTS, headers: sessionOf(token) });
    if (q.status !== 401) throw new Error(`query-токен принят: status=${q.status}`);
    if (h.status !== 200) throw new Error(`тот же токен по заголовку не работает: ${h.status} — 401 не про query`);
  });
  check('C1b: дубликат заголовка Session-Token → 401 fail-closed', async () => {
    const t1 = (await login(ns)).token, t2 = (await login(ns)).token;
    const r = await request({ port: ns.port, p: ACCOUNTS, headers: { 'Session-Token': [t1, t2] } });
    if (r.status !== 401) throw new Error(`дубликат заголовка принят: status=${r.status}`);
  });
  check('C1c: case-вариант query ?Session-Token= → 401', async () => {
    const { token } = await login(ns);
    const r = await request({ port: ns.port, p: `${ACCOUNTS}?Session-Token=${encodeURIComponent(token)}` });
    if (r.status !== 401) throw new Error(`case-query принят: status=${r.status}`);
  });
  check('C1d: hosted-owned fail-closed: /admin, /admin/journal, /mock/state, /mock/time → 401', async () => {
    for (const p of ['/admin', '/admin/journal', '/mock/state', '/mock/time']) {
      const r = await request({ port: owned.port, p, method: p === '/mock/time' ? 'POST' : 'GET' });
      if (r.status !== 401) throw new Error(`${p} → ${r.status}, ожидался 401`);
    }
  });
  check('C1e: эха токена в ответах нет (тело AccountList/401-конверт, Location отсутствует)', async () => {
    const { token } = await login(ns);
    const ok = await request({ port: ns.port, p: ACCOUNTS, headers: sessionOf(token) });
    const bad = await request({ port: ns.port, p: ACCOUNTS, headers: sessionOf('sz-invalid') });
    for (const [tag, r] of [['200', ok], ['401', bad]]) {
      if (r.text.includes(token) || r.text.includes('sz-invalid')) throw new Error(`${tag}: токен в теле ответа`);
      if (r.headers.location) throw new Error(`${tag}: Location=${r.headers.location}`);
    }
  });

  // ── C2. Read-only граница ────────────────────────────────────────────────
  check('C2a: GET /API/v2/Login → 405 с подсказкой', async () => {
    const r = await request({ port: ns.port, p: LOGIN, headers: sessionOf('x') });
    if (r.status !== 405) throw new Error(`status=${r.status}`);
    if (!r.text.includes('не поддерживается')) throw new Error('нет подсказки 405');
  });
  check('C2b: POST /API/v2/NewDocuments → 405', async () => {
    const r = await request({ port: ns.port, p: DOCS, method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sessionOf('x') }, body: '{}' });
    if (r.status !== 405) throw new Error(`status=${r.status}`);
  });
  check('C2c: POST /API/v2/Sell → 404 с подсказкой «не моделируется»', async () => {
    const r = await request({ port: ns.port, p: '/API/v2/Sell', method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (r.status !== 404 || !r.text.includes('не моделируется')) throw new Error(`status=${r.status}, text=${r.text.slice(0, 80)}`);
  });
  check('C2d: /admin — read-only консоль: без <form и action=, есть liveSessions', async () => {
    const r = await request({ port: ns.port, p: '/admin' });
    if (r.status !== 200) throw new Error(`status=${r.status}`);
    if (/<form[\s>]/i.test(r.text) || /action=["']/.test(r.text)) throw new Error('в консоли есть форма/действие');
    if (!r.text.includes('liveSessions') || !r.text.includes('read-only')) throw new Error('нет read-only маркеров');
  });
  check('C2e: исходящих HTTP-вызовов в server.js нет (SSRF-поверхность отсутствует)', async () => {
    const src = fs.readFileSync(SERVER, 'utf8');
    for (const pat of ['http.request(', 'https.request(', 'http.get(', 'https.get(', 'fetch(', 'net.connect(']) {
      if (src.includes(pat)) throw new Error(`найден исходящий вызов: ${pat}`);
    }
  });

  // ── C3. [FORK] мульти-сессии и бюджет ───────────────────────────────────
  check('C3a: [FORK] три Login → три разных токена, все живы одновременно', async () => {
    const tokens = [];
    for (let i = 0; i < 3; i++) tokens.push((await login(ns)).token);
    if (new Set(tokens).size !== 3) throw new Error('токены не уникальны');
    for (const t of tokens) {
      const r = await request({ port: ns.port, p: ACCOUNTS, headers: sessionOf(t) });
      if (r.status !== 200) throw new Error(`предыдущий токен умер раньше TTL: ${r.status}`);
    }
  });
  check('C3b: namespaces — сессии не ограничены квотой: 40 логинов → 40×200', async () => {
    let okN = 0;
    for (let i = 0; i < 40; i++) if ((await login(ns)).status === 200) okN++;
    if (okN !== 40) throw new Error(`только ${okN}/40 логинов прошли (квота там, где её не должно быть)`);
  });
  check('C3c: owned, max=30: fixture 30 документов → Login 429 «Лимит сессий песочницы»; fixture 29 → 200', async () => {
    const created = safeJson((await request({ port: owned.port, p: '/sandboxes', method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'sz-quota' }) })).text);
    szQuota.id = created.id; szQuota.ownerToken = created.ownerToken; szQuota.creds = created.creds;
    const owner = { 'X-Mock-Sandbox': created.id, 'X-Sandbox-Token': created.ownerToken, 'Content-Type': 'application/json' };
    const put = async (n) => request({ port: owned.port, p: '/mock/state', method: 'PUT', headers: owner,
      body: JSON.stringify({ state: fixture(n) }) });
    const full = await put(30);
    if (full.status !== 200) throw new Error(`import 30 документов не принят: ${full.status} ${full.text.slice(0, 120)}`);
    const blocked = await login(owned, owner, created.creds);
    if (!(blocked.status === 429 && blocked.text.includes('Лимит сессий песочницы'))) {
      throw new Error(`fixture=max: ожидался 429, получен ${blocked.status} ${blocked.text.slice(0, 120)}`);
    }
    const under = await put(29);
    if (under.status !== 200) throw new Error(`import 29 документов не принят: ${under.status}`);
    const first = await login(owned, owner, created.creds);
    if (first.status !== 200) throw new Error(`fixture=max-1: Login=${first.status}, ожидался 200`);
    const second = await login(owned, owner, created.creds);
    if (second.status !== 429) throw new Error(`вторая сессия на used=max: ${second.status}, ожидался 429`);
  });
  check('C3d: истёкшие сессии reclaimed до проверки квоты: advance > TTL → Login 200', async () => {
    const adv = await request({ port: owned.port, p: '/mock/time', method: 'POST',
      headers: { 'X-Mock-Sandbox': szQuota.id, 'X-Sandbox-Token': szQuota.ownerToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ advance: '+61s' }) });
    if (adv.status !== 200) throw new Error(`advance не принят: ${adv.status} — часы не сдвинуты`);
    const r = await login(owned, { 'X-Mock-Sandbox': szQuota.id, 'X-Sandbox-Token': szQuota.ownerToken }, szQuota.creds);
    if (r.status !== 200) throw new Error(`после reclaim Login=${r.status}: ${r.text.slice(0, 100)}`);
  });

  // ── C4. Секреты ──────────────────────────────────────────────────────────
  check('C4a: журнал — шаблоны путей, без query/токенов/пароля/Integrator-ID', async () => {
    const { token } = await login(ns);
    await request({ port: ns.port, p: `${DOCS}?an=1000001&id=q-0001`, headers: sessionOf(token) });
    const j = (await request({ port: ns.port, p: '/admin/journal' })).text;
    for (const secret of [token, CREDS.password, CREDS.login, CREDS.integratorId]) {
      if (j.includes(secret)) throw new Error(`секрет в журнале: ${secret.slice(0, 8)}…`);
    }
    if (j.includes('an=1000001') || j.includes('q-0001')) throw new Error('query-строка попала в журнал');
    if (!j.includes('/API/v2/NewDocuments') || !j.includes('/API/v2/Login')) throw new Error('шаблонов нет в журнале');
  });
  check('C4b: логи старта маскируют env-креды', async () => {
    const out = ns.output();
    if (out.includes('sz-probe-pass') || out.includes('SZ-PROBE-INTEGRATOR')) throw new Error('env-креды в логах');
    if (!out.includes('<задан через env, скрыт>')) throw new Error('нет маскировки env-кредов');
  });
  check('C4c: /mock/state экспорт вычищает sessions', async () => {
    const r = await request({ port: ns.port, p: '/mock/state' });
    const snap = safeJson(r.text);
    if (r.status !== 200) throw new Error(`status=${r.status}`);
    if (Object.keys(snap.state?.sessions || { x: 1 }).length !== 0) throw new Error('sessions не вычищены из экспорта');
  });
  check('C4d: state-файл на диске содержит живой маркер — persist/restore, задокументировано', async () => {
    const { token } = await login(disk);
    const file = path.join(dir, 'state.json');
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.includes(token)) throw new Error('маркера нет в state-файле — persist/restore сломан бы');
    const readme = fs.readFileSync(path.join(ROOT, 'services', 'taxcom-mock', 'README.md'), 'utf8');
    const integ = fs.readFileSync(path.join(ROOT, 'docs', 'integration', 'taxcom.md'), 'utf8');
    if (!readme.includes('Persist files содержат mock-маркеры/креды')) throw new Error('README не предупреждает о маркерах на диске');
    if (!integ.includes('State files содержат маркеры')) throw new Error('integration-док не предупреждает о маркерах на диске');
  });

  // ── C5. Контракты десятого сервиса ──────────────────────────────────────
  check('C5a: /openapi.json: 3 провайдерских пути присутствуют; полная поверхность = 16 путей', async () => {
    const api = safeJson((await request({ port: ns.port, p: '/openapi.json' })).text);
    for (const p of [LOGIN, ACCOUNTS, DOCS]) if (!api.paths?.[p]) throw new Error(`нет ${p} в OpenAPI`);
    const total = Object.keys(api.paths).length;
    if (total !== 16) throw new Error(`путей ${total}, ожидалось 16 (3 provider + 13 mock)`);
  });
  check('C5b: compose :3109 c default bind 127.0.0.1; smoke/healthcheck/package.json включают taxcom', async () => {
    const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    if (!/taxcom-mock:/.test(compose) ||
        !/\$\{MOCK_TAXCOM_BIND_IP:-127\.0\.0\.1\}:\$\{MOCK_TAXCOM_HOST_PORT:-3109\}:3109/.test(compose)) {
      throw new Error('compose: нет taxcom-mock на ${MOCK_TAXCOM_BIND_IP:-127.0.0.1}:${MOCK_TAXCOM_HOST_PORT:-3109}:3109');
    }
    const hc = fs.readFileSync(path.join(ROOT, 'scripts', 'docker-healthcheck.js'), 'utf8');
    if (!hc.includes("['3109', '/health']")) throw new Error('healthcheck: нет :3109');
    const smoke = fs.readFileSync(path.join(ROOT, 'scripts', 'docker-smoke.js'), 'utf8');
    if (!smoke.includes('NAME_TAXCOM')) throw new Error('smoke: нет taxcom');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (!pkg.scripts['test:taxcom'] || !pkg.scripts['start:taxcom'] || !pkg.scripts.test.includes('test:taxcom')) {
      throw new Error('package.json: нет taxcom-скриптов');
    }
  });
  check('C5c: hosted-namespaces: query sandbox_token не даёт доступа к provider-API → 401 по Session-Token (Ф-3 #116, поведение)', async () => {
    const r = await request({ port: hns.port, p: `${ACCOUNTS}?sandbox_token=sz-probe-token` });
    if (r.status !== 401) throw new Error(`status=${r.status}: ожидался 401 по Session-Token`);
    const j = safeJson(r.text);
    if (j.field !== 'Session-Token') throw new Error(`401 не про Session-Token: ${r.text.slice(0, 120)}`);
  });
  check('D1 (Ф-1, демонстрация): WARN о query sandbox_token заглушен — runtime log не подключён', async () => {
    const snap = hns.output().length;
    await request({ port: hns.port, p: `${ACCOUNTS}?sandbox_token=sz-probe-token` });
    const delta = hns.output().slice(snap);
    if (delta.includes('устарел')) throw new Error('WARN виден — находка Ф-1 не воспроизводится (проверка устарела)');
    const src = fs.readFileSync(SERVER, 'utf8');
    const call = src.match(/createSandboxRuntime\(\{[\s\S]*?\n\}\);/);
    if (!call) throw new Error('createSandboxRuntime не найден');
    if (/\blog:/.test(call[0])) throw new Error('log подключён — находка Ф-1 не воспроизводится');
    const wired = ['tbank-mock', 'kassa-mock', 'yookassa-mock', 'atol-mock', 'alfa-mock', 'sber-mock', 'vtb-mock', 'first-ofd-mock'];
    for (const s of wired) {
      const other = fs.readFileSync(path.join(ROOT, 'services', s, 'server.js'), 'utf8');
      const m = other.match(/createSandboxRuntime\(\{[\s\S]*?\n  \}\);/);
      if (!m || !/\blog:/.test(m[0])) throw new Error(`${s}: ожидалось подключение log (эталон 8/9)`);
    }
  });

  let passed = 0; const failed = [];
  for (const { name, fn } of results) {
    try { await fn(); passed++; console.log(`PASS ${name}`); }
    catch (e) { failed.push({ name, err: e.message }); console.log(`FAIL ${name}\n      ${e.message}`); }
  }
  console.log(`\nИТОГ: ${passed} passed, ${failed.length} failed`);
  for (const f of failed) console.log(`  FAILED: ${f.name}: ${f.err}`);
  for (const s of [ns, owned, hns, disk]) s.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  const exitCode = failed.length ? 1 : 0;
  console.log(`EXIT=${exitCode}`);
  process.exit(exitCode);
}

main().catch((e) => { console.error('probe crashed:', e); process.exit(2); });
