// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { verifyRoutes } = require('./drift');
let checks = 0;
function ok(condition, message) { assert.ok(condition, message); console.log(`  ✓ ${message}`); checks++; }
const CREDS = { login: 'selftest@example.invalid', password: 'Пароль UTF-8 &+\n', apiKey: 'selftest-api-key' };
async function launch(extra = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: {
    ...process.env, MOCK_HOST: '127.0.0.1', MOCK_PORT: '0', MOCK_HOSTED: 'false', MOCK_TENANCY: 'namespaces',
    MOCK_STATE_FILE: '', MOCK_SANDBOX_FILE: '', MOCK_ADMIN_TOKEN: '', MOCK_OPERATOR_TOKEN: '', MOCK_SANDBOX_TOKEN: '',
    MOCK_KONTUR_OFD_LOGIN: CREDS.login, MOCK_KONTUR_OFD_PASSWORD: CREDS.password, MOCK_KONTUR_OFD_API_KEY: CREDS.apiKey,
    MOCK_SANDBOX_TTL_MS: '', MOCK_SANDBOX_MAX: '100', MOCK_SANDBOX_MAX_DOCUMENTS: '',
    MOCK_SANDBOX_HOST_SUFFIX: '', MOCK_SANDBOX_CREATE_LIMIT: '20',
    MOCK_KONTUR_OFD_SID_TTL_SECS: '60', MOCK_VIRTUAL_CLOCK: '2026-10-11T12:00:00Z', ...extra,
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
async function request(base, route, { method = 'GET', body, headers = {}, timeout = 5000 } = {}) {
  const response = await fetch(base + route, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
async function login(base, creds = CREDS, headers = {}) {
  return request(base, `/auth/authenticate-by-pass?login=${encodeURIComponent(creds.login)}`, {
    method: 'POST', body: creds.password, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
  });
}
const ORG = '/v2/organizations';
const BOXES = ORG + '/org-demo/cashboxes';
const DOCS = BOXES + '/0000000000000001/documents';
const PERIOD = DOCS + '/by-period?dateFrom=2026-10-11T00:00:00&dateTo=2026-10-11T23:59:59';
async function main() {
  const service = await launch();
  const { base } = service;
  const r = (route, opts) => request(base, route, opts);
  try {
    ok((await r('/health')).status === 200, 'health');
    const api = (await r('/openapi.json')).data;
    ok(api.openapi === '3.1.0', 'OpenAPI 3.1 served');
    const logged = await login(base);
    ok(logged.status === 200 && typeof logged.data.Sid === 'string', 'UTF-8 plaintext password → Sid');
    const sid = logged.data.Sid;
    const headers = { Authorization: `auth.sid ${sid}`, 'X-Kontur-Ofd-ApiKey': CREDS.apiKey };
    const read = (route, extra = {}) => r(route, { headers: { ...headers, ...extra } });
    for (const bad of [{ ...CREDS, login: 'wrong' }, { ...CREDS, password: 'wrong' }])
      ok((await login(base, bad)).data.errorCodeId === 401002, 'bad login/password rejected');
    ok((await r(ORG)).data.errorCodeId === 401002, 'missing Sid → 401002');
    ok((await read(ORG, { Authorization: 'auth.sid unknown' })).data.errorCodeId === 401002, 'unknown Sid → 401002');
    ok((await read(ORG, { Authorization: `Bearer ${sid}` })).data.errorCodeId === 401002, 'Bearer is not auth.sid');
    for (const key of ['', 'bad']) ok((await read(ORG, { 'X-Kontur-Ofd-ApiKey': key })).data.errorCodeId === 401003, 'missing/unknown API key → 401003');
    const orgs = await read(ORG);
    ok(orgs.status === 200 && orgs.data.length === 1 && orgs.data[0].inn && orgs.data[0].kpp, 'accessible organizations with requisites');
    const boxes = (await read(BOXES)).data;
    ok(boxes.length === 1 && boxes[0].regNumber && boxes[0].addresses.length && boxes[0].model
      && boxes[0].fiscalDriveNumber && boxes[0].accessPeriod.dateFrom && boxes[0].accessPeriod.dateTo, 'cashbox registration, model, FN, address history, access boundaries');
    for (const [route, status] of [[ORG + '/missing/cashboxes', 404], [ORG + '/org-restricted/cashboxes', 403],
      [BOXES + '/0000000000000002/documents?date=2026-10-11', 403], [BOXES + '/missing/documents?date=2026-10-11', 404],
      [DOCS + '/missing', 404]]) ok((await read(route)).status === status, `access/not-found ${status}: ${route}`);
    const all = (await read(DOCS + '?date=2026-10-11')).data;
    ok(all.length === 12, 'documents for date, all ten types');
    const receipts = (await read(DOCS + '?date=2026-10-11&types=receipt')).data;
    ok(receipts.length === 3 && receipts[1].operationType === 2, 'receipt filter includes already fiscalized return');
    const receipt = (await read(DOCS + '/' + receipts[0].id)).data;
    ok(receipt.items[0].price === 12345 && receipt.totalSum === 12345 && receipt.fiscalDocumentNumber && receipt.fiscalSign, 'detail fiscal identity, items and integer KOPEKS');
    ok((await read(DOCS + '?date=2026-10-11&types=bso,bsoCorrection')).data.length === 2, 'comma-separated types');
    const types = require('../../protocols/kontur-ofd.json').documentTypes;
    for (const type of types) {
      const docs = (await read(DOCS + '?date=2026-10-11&types=' + type)).data;
      ok(docs.length > 0 && docs.every((d) => d.type === type), `filter ${type}`);
    }
    ok((await read(DOCS + '?date=2026-01-02')).data.length === 0, 'empty day is 200 []');
    let offset = 0, collected = [];
    do {
      const page = (await read(PERIOD + '&limit=2&offset=' + offset)).data;
      collected.push(...page.documents);
      ok(page.documents.length <= 2, 'pagination honors limit');
      offset = page.paging.nextOffset;
    } while (offset !== null);
    ok(collected.length === all.length && new Set(collected.map((d) => d.id)).size === all.length, 'walk nextOffset without missing/repeated IDs');
    ok((await read(PERIOD + '&offset=999')).data.documents.length === 0, 'exhausted cursor → empty page');
    const empty = (await read(DOCS + '/by-period?dateFrom=2026-01-02T00:00:00&dateTo=2026-01-02T01:00:00')).data;
    ok(empty.documents.length === 0 && empty.paging.nextOffset === null, 'empty period → documents[], nextOffset null');
    const precise = (await read(DOCS + '/by-period?dateFrom=2026-10-11T12:05:00&dateTo=2026-10-11T12:05:01&types=receipt')).data;
    ok(precise.documents.length === 2, '[FORK] inclusive period bounds, timezone-less UTC');
    for (const suffix of ['&limit=1001', '&limit=0', '&limit=1.5', '&offset=-1', '&offset=2junk', '&offset=', '&currentOffset=0', '&types=unknown'])
      ok((await read(PERIOD + suffix)).status === 400, `invalid query ${suffix}`);
    ok((await read(PERIOD + '&currentOffset=0')).data.message.includes('offset'), 'cursor mismatch has actionable hint');
    for (const date of ['2026-02-30', '2026-13-01', 'invalid', '2026-1-01', ''])
      ok((await read(DOCS + '?date=' + date)).status === 400, `invalid date ${date}`);
    ok((await read(DOCS + '/by-period?dateFrom=2026-10-12T00:00:00&dateTo=2026-10-11T00:00:00')).status === 400, 'reversed period rejected');
    ok((await r(DOCS, { method: 'POST', headers, body: {} })).status === 405, 'no receipt creation');
    ok((await r('/sell', { method: 'POST', body: {} })).status === 404, 'no foreign write route');
    ok((await read(ORG, { 'X-Mock-Scenario': 'fail' })).status === 500, 'fail scenario → provider-shaped 500');
    ok((await read(ORG, { 'X-Mock-Scenario': 'http-500' })).data.errorCodeId === 500, 'core transport chaos');
    const duplicated = (await read(PERIOD + '&types=receipt', { 'X-Mock-Scenario': 'duplicate' })).data.documents;
    ok(duplicated.length === 4 && duplicated[0].id === duplicated[3].id, 'duplicate repeats fiscal identity');
    await assert.rejects(() => r(ORG, { headers: { ...headers, 'X-Mock-Scenario': 'hang' }, timeout: 150 }));
    ok(true, 'hang is abortable by caller');
    await r('/mock/scenarios', { method: 'POST', body: { scenario: 'fail', target: 'read', times: 1 } });
    ok((await read(ORG)).status === 500 && (await read(ORG)).status === 200, 'registry scenario consumed once');
    await r('/mock/scenarios', { method: 'POST', body: { scenario: 'fail', target: 'read', persistent: true } });
    ok((await r(ORG, { headers: { ...headers, 'X-Mock-Sandbox': 'other' } })).data.errorCodeId === 401002, 'Sid isolated between sandboxes');
    const otherLogin = await login(base, CREDS, { 'X-Mock-Sandbox': 'other' });
    const otherHeaders = { ...headers, Authorization: `auth.sid ${otherLogin.data.Sid}`, 'X-Mock-Sandbox': 'other' };
    ok((await r(ORG, { headers: otherHeaders })).status === 200, 'scenario isolation');
    await r('/mock/scenarios', { method: 'DELETE' });
    const snapshot = (await r('/mock/state')).data;
    ok(Object.keys(snapshot.state.sessions).length === 0, 'state export redacts session IDs');
    const malicious = JSON.parse(JSON.stringify(snapshot.state));
    Object.defineProperty(malicious.documents[0], '__proto__', { value: { polluted: true }, enumerable: true });
    ok((await r('/mock/state', { method: 'PUT', body: malicious })).status === 400, 'unsafe imported keys rejected');
    const badAmount = structuredClone(snapshot.state);
    badAmount.documents.find((d) => d.type === 'receipt').totalSum = 123.45;
    ok((await r('/mock/state', { method: 'PUT', body: badAmount })).status === 400, 'fixture amounts cannot be fractional rubles');
    ok((await read(ORG)).status === 200, 'rejected state import leaves existing session alive');
    // Больше страницы hard cap; import fixtures — только mock-control, НЕ provider write API.
    const many = structuredClone(snapshot.state);
    many.documents = Array.from({ length: 1001 }, (_, i) => ({ ...snapshot.state.documents[0], id: `bulk-${i}`, fiscalDocumentNumber: i + 1 }));
    ok((await r('/mock/state', { method: 'PUT', body: many })).status === 200, 'mock state fixture injection');
    const bulkSid = (await login(base)).data.Sid;
    const bulkHeaders = { ...headers, Authorization: `auth.sid ${bulkSid}` };
    const bulkPage = (await r(PERIOD, { headers: bulkHeaders })).data;
    ok(bulkPage.documents.length === 1000 && bulkPage.paging.nextOffset === 1000, 'default maximum 1000 + nextOffset');
    ok((await r(PERIOD + '&offset=1000', { headers: bulkHeaders })).data.documents.length === 1, '1001st document reachable');
    ok((await r(PERIOD, { headers: { ...bulkHeaders, 'X-Mock-Scenario': 'duplicate' } })).data.documents.length === 1000, 'duplicate scenario preserves hard page cap');
    ok((await r(DOCS + '?date=2026-10-11', { headers: otherHeaders })).data.length === 12, 'document isolation after import');
    await r('/mock/reset', { method: 'POST', body: {} });
    ok((await read(ORG)).data.errorCodeId === 401002, 'reset revokes sessions');
    const fresh = (await login(base)).data.Sid;
    await r('/mock/time', { method: 'POST', body: { advance: '+61s' } });
    ok((await read(ORG, { Authorization: `auth.sid ${fresh}` })).data.errorCodeId === 401002, 'Sid TTL uses virtual clock');
    ok((await r(ORG, { headers: otherHeaders })).status === 200, 'clock isolation');
    const journal = JSON.stringify((await r('/admin/journal')).data);
    for (const secret of [CREDS.password, CREDS.apiKey, fresh]) ok(!journal.includes(secret) && !service.logs().includes(secret), 'secrets absent from journal/logs');
    ok((await r('/admin')).status === 200, 'read-only admin');
    const manifest = require('../../protocols/kontur-ofd.json');
    const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    ok(verifyRoutes(serverSource, api, manifest).every((x) => x.inServer && x.inOpenApi), 'independent server/OpenAPI route parity');
    const brokenApi = structuredClone(api); delete brokenApi.paths[ORG];
    const brokenServer = serverSource.replace("['GET', '/v2/organizations']", "['GET', '/v2/removed']");
    ok(verifyRoutes(serverSource, brokenApi, manifest).some((x) => x.inServer && !x.inOpenApi), 'negative control: missing OpenAPI route detected independently');
    ok(verifyRoutes(brokenServer, api, manifest).some((x) => !x.inServer && x.inOpenApi), 'negative control: missing server route detected independently');
  } finally { await service.stop(); }

  const unconfigured = await launch({ MOCK_KONTUR_OFD_LOGIN: '', MOCK_KONTUR_OFD_PASSWORD: '', MOCK_KONTUR_OFD_API_KEY: '' });
  try { ok((await login(unconfigured.base)).status === 401, 'no static default credentials'); }
  finally { await unconfigured.stop(); }

  const hosted = await launch({ MOCK_HOSTED: 'true', MOCK_TENANCY: 'owned' });
  try {
    const r = (route, opts) => request(hosted.base, route, opts);
    ok((await r('/health')).status === 200, 'hosted public health');
    for (const route of ['/admin', '/mock/time', '/mock/state']) ok((await r(route)).status === 401, `hosted fail-closed ${route}`);
    const a = (await r('/sandboxes', { method: 'POST', body: { id: 'owned-a' } })).data;
    const b = (await r('/sandboxes', { method: 'POST', body: { id: 'owned-b' } })).data;
    ok(a.ownerToken && a.creds.apiKey && a.creds.password && b.ownerToken !== a.ownerToken, 'owned sandbox provisioning generates private credentials');
    const owner = { 'X-Mock-Sandbox': a.id, 'X-Sandbox-Token': a.ownerToken };
    const sid = (await login(hosted.base, a.creds, owner)).data.Sid;
    const headers = { ...owner, Authorization: `auth.sid ${sid}`, 'X-Kontur-Ofd-ApiKey': a.creds.apiKey };
    ok((await r(ORG, { headers })).status === 200, 'auth.sid coexists with X-Sandbox-Token');
    ok((await r(ORG, { headers: { ...headers, 'X-Kontur-Ofd-ApiKey': b.creds.apiKey } })).data.errorCodeId === 401003, 'API keys isolated between owned sandboxes');
    ok((await r(ORG, { headers: { 'X-Mock-Sandbox': a.id } })).status === 401, 'sandbox ID alone grants nothing');
    ok((await r(ORG, { headers: { ...headers, 'X-Sandbox-Token': b.ownerToken } })).status === 401, 'foreign owner cannot access sandbox');
    ok((await r('/mock/time', { method: 'POST', headers: owner, body: { advance: '+2s' } })).status === 200, 'owner controls own virtual clock');
    ok((await r('/mock/reset', { method: 'POST', headers: owner, body: { sandbox: b.id } })).status === 401, 'owner cannot reset foreign sandbox');
    const me = (await r('/sandboxes/me', { headers: owner })).data;
    ok(!JSON.stringify(me).includes(a.creds.password), '/me does not disclose credentials');
    const rotated = (await r('/sandboxes/me/reset-creds', { method: 'POST', headers: owner, body: {} })).data;
    ok(rotated.creds.apiKey !== a.creds.apiKey, 'reset-creds rotates generated credentials');
    ok((await r(ORG, { headers })).data.errorCodeId === 401002, 'credential rotation revokes existing Sid');
    ok((await login(hosted.base, a.creds, owner)).status === 401, 'old password rejected after rotation');
    ok((await login(hosted.base, rotated.creds, owner)).status === 200, 'new password accepted');
    ok((await r('/sandboxes/me/reset', { method: 'POST', headers: owner, body: {} })).status === 200, 'owned reset');
    ok((await r('/sandboxes/me', { method: 'DELETE', headers: owner })).status === 200, 'owned delete');
  } finally { await hosted.stop(); }

  const quotaService = await launch({ MOCK_HOSTED: 'true', MOCK_TENANCY: 'owned', MOCK_SANDBOX_MAX_DOCUMENTS: '13' });
  try {
    const created = (await request(quotaService.base, '/sandboxes', { method: 'POST', body: { id: 'quota' } })).data;
    const owner = { 'X-Mock-Sandbox': created.id, 'X-Sandbox-Token': created.ownerToken };
    ok((await login(quotaService.base, created.creds, owner)).status === 200, 'session within sandbox document quota');
    ok((await login(quotaService.base, created.creds, owner)).status === 429, 'session quota enforced');
    await request(quotaService.base, '/mock/time', { method: 'POST', headers: owner, body: { advance: '+61s' } });
    ok((await login(quotaService.base, created.creds, owner)).status === 200, 'expired sessions reclaimed before quota check');
  } finally { await quotaService.stop(); }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kontur-ofd-selftest-'));
  const fileEnv = { MOCK_STATE_FILE: path.join(dir, 'state.json'), MOCK_SANDBOX_FILE: path.join(dir, 'sandboxes.json') };
  let persistent;
  try {
    persistent = await launch(fileEnv);
    const sid = (await login(persistent.base)).data.Sid;
    const namespaceSid = (await login(persistent.base, CREDS, { 'X-Mock-Sandbox': 'persistent-namespace' })).data.Sid;
    await request(persistent.base, '/mock/time', { method: 'POST', body: { advance: '+2s' } });
    await persistent.stop();
    persistent = await launch(fileEnv);
    ok((await request(persistent.base, ORG, { headers: { Authorization: `auth.sid ${sid}`, 'X-Kontur-Ofd-ApiKey': CREDS.apiKey } })).status === 200, 'persist/restore session + virtual clock');
    ok((await request(persistent.base, ORG, { headers: { Authorization: `auth.sid ${namespaceSid}`, 'X-Kontur-Ofd-ApiKey': CREDS.apiKey,
      'X-Mock-Sandbox': 'persistent-namespace' } })).status === 200, 'namespace persist/restore with graceful flush');
  } finally { if (persistent) await persistent.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(`\nkontur-ofd: ${checks} passed, 0 failed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
