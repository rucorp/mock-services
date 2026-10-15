// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * selftest taxcom-mock (issue #112): Login/Integrator-ID/[VERIFY]-форма тела,
 * Session-Token TTL 300 с sliding на виртуальных часах и 401 по истечении,
 * AccountList, NewDocuments (окно 10 суток, курсор по id, хвост → пустой ответ,
 * лимит 10 000, сортировка по времени приёма, ошибки 3106/2203), read-only
 * границы (405/404 с подсказкой), сценарии/часы/журнал, изоляция песочниц,
 * owned-режим, квоты, persist/restore и независимые негативные drift-контроли.
 * Zero dependencies, эфемерные порты, без sleep-ожиданий.
 */

const assert = require('assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { verifyRoutes } = require('./drift');

let checks = 0;
function ok(condition, message) { assert.ok(condition, message); console.log(`  ✓ ${message}`); checks++; }

const CREDS = { login: 'taxcomselftest', password: 'Пароль UTF-8 &+\n', integratorId: 'SELFTEST-INTEGRATOR' };
const LOGIN = '/API/v2/Login';
const ACCOUNTS = '/API/v2/AccountList';
const DOCS = '/API/v2/NewDocuments';

async function launch(extra = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: {
    ...process.env, MOCK_HOST: '127.0.0.1', MOCK_PORT: '0', MOCK_HOSTED: 'false', MOCK_TENANCY: 'namespaces',
    MOCK_STATE_FILE: '', MOCK_SANDBOX_FILE: '', MOCK_ADMIN_TOKEN: '', MOCK_OPERATOR_TOKEN: '', MOCK_SANDBOX_TOKEN: '',
    MOCK_TAXCOM_LOGIN: CREDS.login, MOCK_TAXCOM_PASSWORD: CREDS.password, MOCK_TAXCOM_INTEGRATOR_ID: CREDS.integratorId,
    MOCK_SANDBOX_TTL_MS: '', MOCK_SANDBOX_MAX: '100', MOCK_SANDBOX_MAX_DOCUMENTS: '',
    MOCK_SANDBOX_HOST_SUFFIX: '', MOCK_SANDBOX_CREATE_LIMIT: '20',
    MOCK_TAXCOM_SESSION_TTL_SECS: '60', MOCK_VIRTUAL_CLOCK: '2026-10-11T12:00:00Z', ...extra,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`startup timeout: ${output}`)); }, 10000);
    child.on('error', reject);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exit ${code}: ${output}`)); });
    child.stderr.on('data', (b) => { output += b; });
    child.stdout.on('data', (b) => {
      output += b;
      const match = /listening on :(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  return { base, logs: () => output, stop: async () => { if (child.exitCode !== null || child.signalCode !== null) return; child.kill(); await once(child, 'exit'); } };
}
async function request(base, route, { method = 'GET', body, headers = {}, raw, timeout = 20000 } = {}) {
  const response = await fetch(base + route, { method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw !== undefined ? raw : body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
}
async function login(base, creds = CREDS, headers = {}) {
  return request(base, LOGIN, { method: 'POST',
    body: { login: creds.login, password: creds.password },
    headers: { 'Integrator-ID': creds.integratorId, ...headers } });
}
const sessionOf = (token) => ({ 'Session-Token': token });

async function main() {
  const service = await launch();
  const { base } = service;
  const r = (route, opts) => request(base, route, opts);
  try {
    ok((await r('/health')).data.service === 'taxcom-mock', 'health');
    const api = (await r('/openapi.json')).data;
    ok(api.openapi === '3.1.0', 'OpenAPI 3.1 served');

    console.log('— Login: Integrator-ID, [VERIFY]-форма тела, реквизиты');
    ok(service.logs().includes('synthetic credentials') && !service.logs().includes(CREDS.login),
      'startup log prints the credential block, env-provided login not echoed');
    ok((await r(LOGIN, { method: 'POST', body: { login: CREDS.login, password: CREDS.password } })).data.field === 'Integrator-ID',
      'Login without Integrator-ID → 401 with field hint');
    ok((await login(base, { ...CREDS, integratorId: 'OTHER' })).status === 401, 'unknown Integrator-ID rejected');
    for (const bad of [{ ...CREDS, login: 'wrong' }, { ...CREDS, password: 'wrong' }]) {
      ok((await login(base, bad)).status === 401, `bad ${bad.login === 'wrong' ? 'login' : 'password'} rejected`);
    }
    const unknownField = await r(LOGIN, { method: 'POST', headers: { 'Integrator-ID': CREDS.integratorId },
      body: { login: CREDS.login, password: CREDS.password, grant_type: 'password' } });
    ok(unknownField.status === 400 && unknownField.data.verify === 'Login_Request [VERIFY]',
      '[VERIFY] unknown Login_Request key → 400 with re-verify marker');
    ok((await r(LOGIN, { method: 'POST', headers: { 'Integrator-ID': CREDS.integratorId }, raw: 'not json' })).status === 400,
      'invalid JSON body → 400');
    ok((await r(LOGIN, { method: 'POST', headers: { 'Integrator-ID': CREDS.integratorId }, raw: '["login","password"]' })).status === 400,
      'JSON array is not Login_Request');
    ok((await r(LOGIN, { method: 'POST', headers: { 'Integrator-ID': CREDS.integratorId },
      body: { login: CREDS.login } })).status === 400, 'missing password → 400');
    ok((await r(LOGIN, { method: 'POST', headers: { 'Integrator-ID': CREDS.integratorId },
      raw: `{"login":"${'x'.repeat(1024 * 1024 + 16)}","password":"y"}` })).status === 413,
      'provider body limit 1 МиБ → 413 (fixture import has its own 8 МиБ limit)');
    const logged = await login(base);
    ok(logged.status === 200 && typeof logged.data.token === 'string' && logged.data.token.length >= 32,
      'Login → temporary marker in body.token');
    ok(logged.headers.get('x-mock-token-ttl-secs') === '60' && /^\d{4}-\d{2}-\d{2}T/.test(logged.headers.get('x-mock-token-expires-at')),
      'mock headers expose TTL and expiry of the marker');
    let token = logged.data.token;
    const second = await login(base);
    ok(second.data.token !== token, '[FORK] repeated Login issues a NEW marker');
    const accounts = (await r(ACCOUNTS, { headers: sessionOf(token) })).data;
    ok(accounts.length === 2, '[FORK] previous marker stays valid until its own TTL');

    console.log('— Session-Token: sliding TTL 5 минут на виртуальных часах');
    ok((await r(ACCOUNTS)).data.errorCodeId === 401, 'missing Session-Token → 401');
    ok((await r(ACCOUNTS, { headers: sessionOf('unknown') })).data.errorCodeId === 401, 'unknown Session-Token → 401');
    ok((await r(ACCOUNTS, { headers: { Authorization: `Bearer ${token}` } })).data.errorCodeId === 401,
      'Authorization: Bearer is not Session-Token');
    const sliding = (await login(base)).data.token;
    await r('/mock/time', { method: 'POST', body: { advance: '+40s' } });
    ok((await r(ACCOUNTS, { headers: sessionOf(sliding) })).status === 200, 'marker alive before TTL');
    await r('/mock/time', { method: 'POST', body: { advance: '+40s' } });
    ok((await r(ACCOUNTS, { headers: sessionOf(sliding) })).status === 200,
      'sliding TTL: second use is still inside 60 s from the LAST use');
    await r('/mock/time', { method: 'POST', body: { advance: '+61s' } });
    const expired = await r(ACCOUNTS, { headers: sessionOf(sliding) });
    ok(expired.data.errorCodeId === 401, 'marker expired → 401 (TTL counted from last use, virtual clock)');
    ok(expired.data.message.includes('истёк') && expired.data.message.includes('sliding'),
      'expired marker message names the TTL rule');
    ok((await r(ACCOUNTS, { headers: sessionOf(sliding) })).data.message.includes('отсутствует или неизвестен'),
      'expired session is deleted: reuse is not a second chance');

    // После проверки sliding часы сдвинуты: берём свежий маркер для чтения.
    token = (await login(base)).data.token;

    console.log('— AccountList');
    ok(accounts.every((a) => a.an && a.inn && a.kpp && a.name && Array.isArray(a.rights))
      && !accounts.some((a) => a.an === '1000003' || 'accessible' in a),
      'accessible contracts with requisites and rights; restricted contract hidden');

    console.log('— NewDocuments: окно 10 суток, сортировка, курсор, хвост');
    const read = (query = '', extra = {}) => r(DOCS + query, { headers: { ...sessionOf(token), ...extra } });
    const all = (await read()).data;
    ok(all.length === 12, 'documents of accessible KKT inside the 10-day window');
    ok(!all.some((d) => ['doc-0011', 'doc-0012', 'doc-0015'].includes(d.id)),
      'KKT without consent, other contract and document older than 10 суток are filtered out');
    const received = all.map((d) => Date.parse(d.receivedAt));
    ok(received.every((v, i) => i === 0 || received[i - 1] <= v), 'sorted by acceptance time');
    const pair = all.slice(-2);
    ok(pair[0].id === 'doc-0013' && pair[1].id === 'doc-0014'
      && Date.parse(pair[0].dateTime) > Date.parse(pair[1].dateTime),
      'sort key is receivedAt, not fiscal dateTime');
    const types = require('../../protocols/taxcom-ofd.json').documentTypes;
    ok(types.length === 7 && types.every((t) => all.some((d) => d.type === t)),
      'all seven document types: shifts, state report, receipt, correction, BSO, BSO correction');
    const receipt = all.find((d) => d.type === 'receipt');
    ok(receipt.totalSum === 12345 && receipt.items[0].price === 12345 && receipt.fiscalDocumentNumber > 0
      && receipt.fiscalSign && receipt.operationType === 1, 'fiscal identity, items and integer kopeks [FORK]');
    ok(all.some((d) => d.type === 'receipt' && d.operationType === 2), 'already fiscalized return present');
    ok(all.every((d) => !('accessible' in d)), 'internal fixture flags are not disclosed');
    const byContract = (await read('?an=1000001')).data;
    ok(byContract.length === all.length, 'an filter keeps the same visible set');
    const noKkt = await read('?an=1000002');
    ok(noKkt.status === 403 && noKkt.data.errorCodeId === 3106, '3106 — no accessible KKT for the contract');
    ok(noKkt.data.hint.includes('AccountList'), '3106 hint points to AccountList');
    ok((await read('?an=9999999')).status === 404, 'unknown contract → 404');
    let cursor = '';
    const collected = [];
    for (let page = 0; page < 20; page += 1) {
      const batch = (await read(cursor ? `?id=${encodeURIComponent(cursor)}` : '')).data;
      if (!batch.length) break;
      collected.push(...batch);
      cursor = batch[batch.length - 1].id;
    }
    ok(collected.length === all.length && new Set(collected.map((d) => d.id)).size === all.length,
      'cursor walk by id returns every document once');
    ok((await read(`?id=${cursor}`)).data.length === 0, 'tail reached → empty response, HTTP 200');
    for (const bad of ['nope', 'doc-9999', '']) {
      const badCursor = await read(`?id=${encodeURIComponent(bad)}`);
      ok(badCursor.status === 400 && badCursor.data.errorCodeId === 2203, `2203 — bad cursor ${JSON.stringify(bad)}`);
    }
    ok((await read('?id=doc-0015')).data.errorCodeId === 2203,
      'cursor outside the 10-day window is a bad cursor, not a silent reset');

    console.log('— read-only границы (write API не моделируется)');
    ok((await r(DOCS, { method: 'POST', headers: sessionOf(token), body: {} })).status === 405,
      'POST NewDocuments → 405');
    const sell = await r('/API/v2/Sell', { method: 'POST', body: {} });
    ok(sell.status === 404 && sell.data.hint.includes('не моделируется'),
      'unknown /API/v2 write route → 404 with hint');
    ok((await r(LOGIN, { headers: sessionOf(token) })).status === 405, 'GET Login → 405');
    ok((await r('/sell', { method: 'POST', body: {} })).status === 404, 'no foreign write route');

    console.log('— сценарии, хаос, журнал, песочницы');
    ok((await read('', { 'X-Mock-Scenario': 'fail' })).status === 500, 'fail scenario → 500');
    ok((await read('', { 'X-Mock-Scenario': 'http-500' })).data.errorCodeId === 500, 'core transport chaos');
    const duplicated = (await read('', { 'X-Mock-Scenario': 'duplicate' })).data;
    ok(duplicated.length === 13 && duplicated[0].id === duplicated[1].id
      && duplicated[0].fiscalSign === duplicated[1].fiscalSign,
      '[FORK] duplicate repeats the same fiscal identity before cursor slicing');
    ok((await read(`?id=${duplicated[0].id}`, { 'X-Mock-Scenario': 'duplicate' })).data.length === duplicated.length - 1,
      'cursor resolves the FIRST occurrence of a duplicated id, the repeat stays after it');
    await assert.rejects(() => read('', { 'X-Mock-Scenario': 'hang', timeout: 200 }));
    ok(true, 'hang is abortable by caller');
    await r('/mock/scenarios', { method: 'POST', body: { scenario: 'fail', target: 'read', times: 1 } });
    ok((await read()).status === 500 && (await read()).status === 200, 'registry scenario consumed once');
    await r('/mock/scenarios', { method: 'POST', body: { scenario: 'fail', target: 'read', persistent: true } });
    ok((await r(ACCOUNTS, { headers: { ...sessionOf(token), 'X-Mock-Sandbox': 'other' } })).status === 401,
      'Session-Token isolated between sandboxes');
    const otherToken = (await login(base, CREDS, { 'X-Mock-Sandbox': 'other' })).data.token;
    const otherHeaders = { ...sessionOf(otherToken), 'X-Mock-Sandbox': 'other' };
    ok((await r(DOCS, { headers: otherHeaders })).status === 200, 'scenario registry isolated per sandbox');
    await r('/mock/scenarios', { method: 'DELETE' });

    const snapshot = (await r('/mock/state')).data;
    ok(Object.keys(snapshot.state.sessions).length === 0, 'state export redacts session tokens');
    const malicious = JSON.parse(JSON.stringify(snapshot.state));
    Object.defineProperty(malicious.documents[0], '__proto__', { value: { polluted: true }, enumerable: true });
    ok((await r('/mock/state', { method: 'PUT', body: malicious })).status === 400, 'unsafe imported keys rejected');
    const badAmount = structuredClone(snapshot.state);
    badAmount.documents.find((d) => d.type === 'receipt').totalSum = 123.45;
    ok((await r('/mock/state', { method: 'PUT', body: badAmount })).status === 400,
      'fixture amounts cannot be fractional rubles');
    const badDate = structuredClone(snapshot.state);
    badDate.documents[0].receivedAt = '2026-02-30T00:00:00Z';
    ok((await r('/mock/state', { method: 'PUT', body: badDate })).status === 400, 'impossible calendar date rejected');
    ok((await read()).status === 200, 'rejected state import leaves existing session alive');

    console.log('— лимит 10 000 документов за вызов');
    const many = structuredClone(snapshot.state);
    const first = many.documents[0];
    many.documents = Array.from({ length: 10001 }, (_, i) => ({ ...first, id: `bulk-${String(i).padStart(5, '0')}`,
      fiscalDocumentNumber: i + 1, receivedAt: new Date(Date.parse('2026-10-11T00:00:00Z') + i * 1000).toISOString(),
      dateTime: new Date(Date.parse('2026-10-11T00:00:00Z') + i * 1000).toISOString() }));
    ok((await r('/mock/state', { method: 'PUT', body: many })).status === 200, 'mock state fixture injection');
    const bulkToken = (await login(base)).data.token;
    const bulkHeaders = sessionOf(bulkToken);
    const bulkPage = (await r(DOCS, { headers: bulkHeaders })).data;
    ok(bulkPage.length === 10000, 'hard page cap 10 000 documents per call');
    const tail = (await r(DOCS + '?id=bulk-09999', { headers: bulkHeaders })).data;
    ok(tail.length === 1 && tail[0].id === 'bulk-10000', '10001st document reachable through the cursor');
    ok((await r(DOCS + '?id=bulk-10000', { headers: bulkHeaders })).data.length === 0, 'bulk tail → empty response');
    ok((await r(DOCS, { headers: { ...bulkHeaders, 'X-Mock-Scenario': 'duplicate' } })).data.length === 10000,
      'duplicate scenario preserves the hard page cap');

    console.log('— окно 10 суток на виртуальных часах');
    await r('/mock/reset', { method: 'POST', body: {} });
    ok((await read()).data.errorCodeId === 401, 'reset revokes sessions');
    const freshToken = (await login(base)).data.token;
    await r('/mock/time', { method: 'POST', body: { advance: '+11d' } });
    const windowToken = (await login(base)).data.token;
    const windowDocs = await r(DOCS, { headers: sessionOf(windowToken) });
    ok(windowDocs.status === 200 && windowDocs.data.length === 0,
      'after 11 суток демо-документы выпадают из окна → пустой ответ');
    ok((await r(ACCOUNTS, { headers: sessionOf(freshToken) })).data.errorCodeId === 401,
      'Session-Token TTL uses the same virtual clock');

    console.log('— секреты, журнал, admin, drift');
    const journal = JSON.stringify((await r('/admin/journal')).data);
    for (const secret of [CREDS.password, token, bulkToken, CREDS.integratorId]) {
      ok(!journal.includes(secret) && !service.logs().includes(secret), `secret absent from journal/logs: ${secret.slice(0, 6)}…`);
    }
    ok(journal.includes('/API/v2/NewDocuments') && journal.includes('/API/v2/Login'), 'journal records API v2 calls');
    const admin = await r('/admin');
    ok(admin.status === 200 && admin.data.includes('read-only'), 'read-only admin console');
    const manifest = require('../../protocols/taxcom-ofd.json');
    const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    ok(verifyRoutes(serverSource, api, manifest).every((x) => x.inServer && x.inOpenApi),
      'independent server/OpenAPI route parity');
    const brokenApi = structuredClone(api); delete brokenApi.paths[ACCOUNTS];
    const brokenServer = serverSource.replace("['GET', '/API/v2/AccountList']", "['GET', '/API/v2/Removed']");
    ok(verifyRoutes(serverSource, brokenApi, manifest).some((x) => x.inServer && !x.inOpenApi),
      'negative control: missing OpenAPI route detected independently');
    ok(verifyRoutes(brokenServer, api, manifest).some((x) => !x.inServer && x.inOpenApi),
      'negative control: missing server route detected independently');
  } finally { await service.stop(); }

  console.log('— синтетические дефолты и валидация env');
  const defaults = await launch({ MOCK_TAXCOM_LOGIN: '', MOCK_TAXCOM_PASSWORD: '', MOCK_TAXCOM_INTEGRATOR_ID: '' });
  try {
    const logged = await login(defaults.base, { login: 'taxcommocktest', password: 'mockpass123', integratorId: 'TAXCOMMOCKTEST' });
    ok(logged.status === 200 && typeof logged.data.token === 'string', 'synthetic defaults work without env');
    ok(defaults.logs().includes('login=taxcommocktest') && defaults.logs().includes('Integrator-ID=TAXCOMMOCKTEST'),
      'startup log prints synthetic defaults');
    ok(defaults.logs().includes('не реквизиты Такском'), 'startup log marks them as mock-only, not provider credentials');
  } finally { await defaults.stop(); }

  const overridden = await launch();
  try {
    ok((await login(overridden.base, { login: 'taxcommocktest', password: 'mockpass123', integratorId: 'TAXCOMMOCKTEST' })).status === 401,
      'env credentials replace the synthetic defaults');
    ok(!overridden.logs().includes(CREDS.password) && overridden.logs().includes('<задан через env, скрыт>'),
      'env credentials are masked in the startup log');
  } finally { await overridden.stop(); }

  const badTtl = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: {
    ...process.env, MOCK_PORT: '0', MOCK_TAXCOM_SESSION_TTL_SECS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let ttlOutput = '';
  badTtl.stdout.on('data', (b) => { ttlOutput += b; });
  badTtl.stderr.on('data', (b) => { ttlOutput += b; });
  const ttlCode = await new Promise((resolve) => badTtl.once('exit', resolve));
  ok(ttlCode !== 0 && ttlOutput.includes('MOCK_TAXCOM_SESSION_TTL_SECS'),
    'MOCK_TAXCOM_SESSION_TTL_SECS=0 rejected at startup (0 does not disable TTL)');

  console.log('— hosted/owned: provisioning, owner-token, ротация');
  const hosted = await launch({ MOCK_HOSTED: 'true', MOCK_TENANCY: 'owned', MOCK_TAXCOM_SESSION_TTL_SECS: '300' });
  try {
    const r = (route, opts) => request(hosted.base, route, opts);
    ok((await r('/health')).status === 200, 'hosted public health');
    for (const route of ['/admin', '/mock/time', '/mock/state']) ok((await r(route)).status === 401, `hosted fail-closed ${route}`);
    const a = (await r('/sandboxes', { method: 'POST', body: { id: 'owned-a' } })).data;
    const b = (await r('/sandboxes', { method: 'POST', body: { id: 'owned-b' } })).data;
    ok(a.ownerToken && a.creds.login && a.creds.password && a.creds.integratorId && b.ownerToken !== a.ownerToken,
      'owned sandbox provisioning generates private mock credentials');
    const owner = { 'X-Mock-Sandbox': a.id, 'X-Sandbox-Token': a.ownerToken };
    const token = (await login(hosted.base, a.creds, owner)).data.token;
    const headers = { ...owner, ...sessionOf(token) };
    ok((await r(ACCOUNTS, { headers })).status === 200, 'Session-Token coexists with X-Sandbox-Token');
    ok((await r(LOGIN, { method: 'POST', headers: { ...owner, 'Integrator-ID': b.creds.integratorId },
      body: { login: a.creds.login, password: a.creds.password } })).status === 401,
      'Integrator-ID isolated between owned sandboxes');
    ok((await r(ACCOUNTS, { headers: { 'X-Mock-Sandbox': a.id } })).status === 401, 'sandbox ID alone grants nothing');
    ok((await r(ACCOUNTS, { headers: { ...headers, 'X-Sandbox-Token': b.ownerToken } })).status === 401,
      'foreign owner cannot access sandbox');
    ok((await r('/mock/time', { method: 'POST', headers: owner, body: { advance: '+2s' } })).status === 200,
      'owner controls own virtual clock');
    ok((await r('/mock/reset', { method: 'POST', headers: owner, body: { sandbox: b.id } })).status === 401,
      'owner cannot reset foreign sandbox');
    ok(!JSON.stringify((await r('/sandboxes/me', { headers: owner })).data).includes(a.creds.password),
      '/me does not disclose credentials');
    const rotated = (await r('/sandboxes/me/reset-creds', { method: 'POST', headers: owner, body: {} })).data;
    ok(rotated.creds.password !== a.creds.password && rotated.creds.integratorId !== a.creds.integratorId,
      'reset-creds rotates login/password/Integrator-ID');
    ok((await r(ACCOUNTS, { headers })).data.errorCodeId === 401, 'credential rotation revokes existing Session-Token');
    ok((await login(hosted.base, a.creds, owner)).status === 401, 'old credentials rejected after rotation');
    ok((await login(hosted.base, rotated.creds, owner)).status === 200, 'new credentials accepted');
    ok((await r('/sandboxes/me/reset', { method: 'POST', headers: owner, body: {} })).status === 200, 'owned reset');
    ok((await r('/sandboxes/me', { method: 'DELETE', headers: owner })).status === 200, 'owned delete');
  } finally { await hosted.stop(); }

  console.log('— квота сессий песочницы');
  const quotaService = await launch({ MOCK_HOSTED: 'true', MOCK_TENANCY: 'owned', MOCK_SANDBOX_MAX_DOCUMENTS: '16' });
  try {
    const created = (await request(quotaService.base, '/sandboxes', { method: 'POST', body: { id: 'quota' } })).data;
    const owner = { 'X-Mock-Sandbox': created.id, 'X-Sandbox-Token': created.ownerToken };
    const first = await login(quotaService.base, created.creds, owner);
    ok(first.status === 200, 'session within sandbox document quota');
    ok((await login(quotaService.base, created.creds, owner)).status === 429, 'session quota enforced');
    await request(quotaService.base, '/mock/time', { method: 'POST', headers: owner, body: { advance: '+61s' } });
    ok((await login(quotaService.base, created.creds, owner)).status === 200,
      'expired sessions reclaimed before quota check');
  } finally { await quotaService.stop(); }

  console.log('— persist/restore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxcom-selftest-'));
  const fileEnv = { MOCK_STATE_FILE: path.join(dir, 'state.json'), MOCK_SANDBOX_FILE: path.join(dir, 'sandboxes.json') };
  let persistent;
  try {
    persistent = await launch(fileEnv);
    const token = (await login(persistent.base)).data.token;
    const namespaceToken = (await login(persistent.base, CREDS, { 'X-Mock-Sandbox': 'persistent-namespace' })).data.token;
    await request(persistent.base, '/mock/time', { method: 'POST', body: { advance: '+2s' } });
    await persistent.stop();
    persistent = await launch(fileEnv);
    ok((await request(persistent.base, ACCOUNTS, { headers: sessionOf(token) })).status === 200,
      'persist/restore session + virtual clock');
    ok((await request(persistent.base, DOCS, { headers: { ...sessionOf(namespaceToken), 'X-Mock-Sandbox': 'persistent-namespace' } })).status === 200,
      'namespace persist/restore with graceful flush');
  } finally { if (persistent) await persistent.stop(); fs.rmSync(dir, { recursive: true, force: true }); }

  console.log(`\ntaxcom: ${checks} passed, 0 failed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
