#!/usr/bin/env node
/* © 2026 ООО «Аксиома» ИНН:7842223709 · Apache-2.0
 * SZ wave-#98 проба: ядро RFC-001/owned — приоритет X-Sandbox-Token/X-Owner-Token
 * над Authorization: Bearer (ownerTokenOf, 12 строк) — верификация по предрегистрации SZ
 * (issue62 prereg #98) + сигнал координатора (issuecomment-6165617453) на ревизии c4d5a82.
 * Zero-dep, Node >= 18.
 *
 * «До»-контроль снят на 6b01501 (legE пробы волны #92, first-ofd owned):
 *   Bearer<очередь>+X-Sandbox-Token<owner> → 401 «знание ID не является доступом» (дефект).
 * Здесь — «после» на c4d5a82: тот же угол → 200.
 *
 * Ноги: first-ofd owned (Bearer-класс, углы a–g) / vtb owned (Bearer-класс, h) / atol owned (не-Bearer, i).
 * Запуск: node sz-wave98-owned-priority.js (из services/first-ofd-mock/ клона на c4d5a82).
 */

'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname || process.cwd());
let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function req(port, method, requestPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers: {
      ...(payload != null ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...headers,
    } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(data); } catch { return null; } })(), text: data }));
    });
    r.on('error', reject);
    r.setTimeout(5000, () => r.destroy(new Error('timeout')));
    if (payload != null) r.write(payload);
    r.end();
  });
}

function startChild(serverPath, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: path.dirname(serverPath),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const onData = () => {
      resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    setTimeout(() => resolve(child), 2500);
  });
}

async function waitHealth(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await req(port, 'GET', '/health'); if (r.status === 200) return r.json; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`health fail :${port}`);
}

async function main() {
  const kids = [];
  const OWNER = 'owner-secret-123';
  const OP = 'op-777';
  const PORT_FOFD = 3167, PORT_VTB = 3177, PORT_ATOL = 3187;
  const HOSTED = { MOCK_HOSTED: '1', MOCK_SANDBOX_TOKEN: OWNER, MOCK_OPERATOR_TOKEN: OP };
  const S = (svc) => path.join(ROOT, 'services', svc, 'server.js');
  try {
    console.log('— нога first-ofd owned (Bearer-класс, углы a–g)');
    kids.push(await startChild(S('first-ofd-mock'), { ...HOSTED, MOCK_PORT: String(PORT_FOFD), MOCK_FIRST_OFD_PROCESS_MS: '0' }));
    await waitHealth(PORT_FOFD);

    // бизнес-токен очереди: /getToken сам защищён owner-токеном (hosted fail-closed)
    const gt = await req(PORT_FOFD, 'POST', '/getToken', { headers: { 'X-Sandbox-Token': OWNER }, body: { login: 'firstofdmocktest', pass: '11111111-2222-4333-8444-555555555555' } });
    check('getToken в hosted требует owner-заголовок', gt.status === 200 && typeof gt.json.token === 'string', `status=${gt.status} len=${(gt.json.token || '').length}`);
    const Q = gt.json.token;
    const BIZ = `/api/external/queue/v1/statuses?externalId=sz98&groupId=MOCKGROUP`;

    // (a) ГЛАВНЫЙ УГОЛ: Bearer<очередь> + X-Sandbox-Token<owner> → 200 (на 6b01501 — 401, дефект)
    const a = await req(PORT_FOFD, 'GET', BIZ, { headers: { Authorization: `Bearer ${Q}`, 'X-Sandbox-Token': OWNER } });
    check('(a) owned: Bearer<очередь>+X-Sandbox-Token<owner> → 200 («после»; «до» на 6b01501 — 401)', a.status === 200, `status=${a.status}`);

    // (b) битый X-Sandbox-Token при валидном Bearer → 401 «знание ID ≠ доступ»
    const b = await req(PORT_FOFD, 'GET', BIZ, { headers: { Authorization: `Bearer ${Q}`, 'X-Sandbox-Token': 'wrong-owner' } });
    check('(b) битый X-Sandbox-Token → 401 «знание ID ≠ доступ»', b.status === 401 && /знание ID/.test(b.text), `status=${b.status} code=${(b.json && b.json.error && b.json.error.code) || '—'}`);

    // (в) fallback на контрольной поверхности: только Bearer<owner> → 200; только Bearer<очередь> → 401
    const c1 = await req(PORT_FOFD, 'GET', '/mock/state', { headers: { Authorization: `Bearer ${OWNER}` } });
    const c2 = await req(PORT_FOFD, 'GET', '/mock/state', { headers: { Authorization: `Bearer ${Q}` } });
    check('(в) fallback: только Bearer<owner> → 200 (state)', c1.status === 200, `status=${c1.status}`);
    check('(в) контроль: только Bearer<очередь> на state → 401 (бизнес-токен не owner)', c2.status === 401, `status=${c2.status}`);

    // (г) оператор: Bearer<operator> + чужой X-Sandbox-Token → 200 (isOperatorRequest по самому Bearer)
    const d = await req(PORT_FOFD, 'GET', '/mock/state', { headers: { Authorization: `Bearer ${OP}`, 'X-Sandbox-Token': 'wrong-owner' } });
    check('(г) оператор по Bearer обслуживает при чужом X-Sandbox-Token → 200', d.status === 200, `status=${d.status}`);

    // (д) X-Owner-Token: второй явный источник — работает как X-Sandbox-Token
    const e1 = await req(PORT_FOFD, 'GET', BIZ, { headers: { Authorization: `Bearer ${Q}`, 'X-Owner-Token': OWNER } });
    const e2 = await req(PORT_FOFD, 'GET', '/mock/state', { headers: { Authorization: `Bearer ${Q}`, 'X-Owner-Token': OWNER } });
    check('(д) X-Owner-Token<owner> + Bearer<очередь> → 200 (бизнес и state)', e1.status === 200 && e2.status === 200, `biz=${e1.status} state=${e2.status}`);

    // (е) query sandbox_token: 4-й источник; пустой Bearer не затеняет; непустой затеняет
    const f1 = await req(PORT_FOFD, 'GET', `/mock/state?sandbox_token=${OWNER}`, {});
    const f2 = await req(PORT_FOFD, 'GET', `/mock/state?sandbox_token=${OWNER}`, { headers: { Authorization: 'Bearer' } });
    const f3 = await req(PORT_FOFD, 'GET', `/mock/state?sandbox_token=${OWNER}`, { headers: { Authorization: `Bearer ${Q}` } });
    const f4 = await req(PORT_FOFD, 'GET', `/mock/state?sandbox_token=evil`, {});
    check('(е) query: без Authorization → 200', f1.status === 200, `status=${f1.status}`);
    check('(е) пустой Bearer + query → 200 (единообразие: пустой = отсутствует)', f2.status === 200, `status=${f2.status}`);
    check('(е) непустой Bearer<очередь> + query<owner> → 401 (Bearer затеняет query; доступ не ослаблен)', f3.status === 401, `status=${f3.status}`);
    check('(е) невалидный query → 401 (негативный контроль)', f4.status === 401, `status=${f4.status}`);

    // (ж) затенение между явными источниками: непустой побеждает; пустой = отсутствует
    const g1 = await req(PORT_FOFD, 'GET', '/mock/state', { headers: { 'X-Sandbox-Token': OWNER, 'X-Owner-Token': 'nope' } });
    const g2 = await req(PORT_FOFD, 'GET', '/mock/state', { headers: { 'X-Sandbox-Token': 'nope', 'X-Owner-Token': OWNER } });
    const g3 = await req(PORT_FOFD, 'GET', '/mock/state', { headers: { 'X-Sandbox-Token': '  ', 'X-Owner-Token': OWNER } });
    check('(ж) X-Sandbox-Token валид + X-Owner-Token битый → 200 (порядок источников)', g1.status === 200, `status=${g1.status}`);
    check('(ж) X-Sandbox-Token битый + X-Owner-Token валид → 401 (непустой затеняет)', g2.status === 401, `status=${g2.status}`);
    check('(ж) X-Sandbox-Token пустой + X-Owner-Token валид → 200 (пустой = отсутствует)', g3.status === 200, `status=${g3.status}`);

    console.log('— нога vtb owned (Bearer-класс, угол h)');
    kids.push(await startChild(S('vtb-mock'), { ...HOSTED, MOCK_PORT: String(PORT_VTB) }));
    await waitHealth(PORT_VTB);
    const vt = await req(PORT_VTB, 'POST', '/passport/oauth2/token', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Sandbox-Token': OWNER },
      body: 'grant_type=client_credentials&client_id=vtbmocktest&client_secret=mockpass123',
    });
    const VT = vt.json && vt.json.access_token;
    check('vtb: OAuth access_token получен', vt.status === 200 && typeof VT === 'string' && VT.length > 0, `len=${(VT || '').length}`);
    const h1 = await req(PORT_VTB, 'GET', '/mock/state', { headers: { Authorization: `Bearer ${VT}`, 'X-Sandbox-Token': OWNER } });
    const h2 = await req(PORT_VTB, 'GET', '/mock/state', { headers: { Authorization: `Bearer ${VT}` } });
    check('(h) vtb: Bearer<access>+X-Sandbox-Token<owner> → 200 («после»; «до» — 401)', h1.status === 200, `status=${h1.status}`);
    check('(h) vtb контроль: Bearer<access> без явного owner → 401 (знание ID ≠ доступ)', h2.status === 401, `status=${h2.status}`);

    console.log('— нога atol owned (не-Bearer класс, угол i — регресса нет)');
    kids.push(await startChild(S('atol-mock'), { ...HOSTED, MOCK_PORT: String(PORT_ATOL) }));
    await waitHealth(PORT_ATOL);
    const i1 = await req(PORT_ATOL, 'GET', '/mock/state', { headers: { 'X-Sandbox-Token': OWNER } });
    const i2 = await req(PORT_ATOL, 'GET', '/mock/state', { headers: { 'X-Sandbox-Token': 'nope' } });
    check('(i) atol: X-Sandbox-Token<owner> → 200 (не-Bearer класс без регресса)', i1.status === 200, `status=${i1.status}`);
    check('(i) atol: битый X-Sandbox-Token → 401 (инвариант сохранён)', i2.status === 401, `status=${i2.status}`);

    console.log('================ ИТОГ ================');
    console.log(`PASSED: ${passed}`);
    console.log(`FAILED: ${failed}`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    for (const k of kids) { try { k.kill('SIGKILL'); } catch {} }
  }
}

main().catch((e) => { console.error('PROBE CRASH:', e.message); process.exit(1); });
