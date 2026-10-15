#!/usr/bin/env node
/* SZ wave116-fixups2 — Ф-1a-v3: два платежа, POST /admin/action?admin_token первым.
 * © 2026 ООО «Аксиома» ИНН:7842223709 · Apache-2.0 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const ROOT = __dirname;
const EV = path.join(ROOT, 'evidence');
require('fs').mkdirSync(EV, { recursive: true });

function request({ port, method = 'GET', p = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(String(body));
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
function tokenOf(payload, password) {
  const values = [];
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'Token' || v === null || v === undefined || v === '' || typeof v === 'object') continue;
    values.push([k, String(v)]);
  }
  values.push(['Password', password]);
  values.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256').update(values.map(([, v]) => v).join('')).digest('hex');
}
async function main() {
  const child = spawn(process.execPath, ['services/tbank-mock/server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MOCK_PORT: '3925', MOCK_HOSTED: '1', MOCK_TENANCY: 'owned',
      MOCK_ADMIN_TOKEN: 'adm-sec-9f2', MOCK_SANDBOX_TOKEN: 'own-sec-5a3',
      MOCK_STATE_FILE: path.join(EV, 'tbank-owned-state-fix2.json'), MOCK_PUBLIC_BASE_URL: 'http://127.0.0.1:3925' },
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try { const r = await request({ port: 3925, p: '/health' }); if (r.status === 200) break; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  // два платежа
  for (const oid of ['sz-probe-1', 'sz-probe-2']) {
    const b = { TerminalKey: 'TBANKMOCKTEST', Amount: '1000', OrderId: oid };
    b.Token = tokenOf(b, 'mockpass123');
    const r = await request({ port: 3925, method: 'POST', p: '/v2/Init', headers: { 'Content-Type': 'application/json', 'X-Sandbox-Token': 'own-sec-5a3' }, body: JSON.stringify(b) });
    if (r.status !== 200) throw new Error(`Init ${oid}: ${r.status} ${r.text.slice(0, 120)}`);
  }
  const page = await request({ port: 3925, p: '/admin', headers: { 'X-Mock-Admin-Token': 'adm-sec-9f2' } });
  const m = page.text.match(/name="_csrf" value="([^"]+)"/);
  if (!m) throw new Error('нет _csrf даже с двумя записями');
  const idm = page.text.match(/name="id" value="([^"]+)"/);
  const id = idm ? idm[1] : 'sz-probe-1';
  const r = await request({
    port: 3925, method: 'POST', p: '/admin/action?admin_token=adm-sec-9f2',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Mock-Admin-Token': 'adm-sec-9f2', Origin: 'http://127.0.0.1:3925' },
    body: new URLSearchParams({ action: 'cancel-new', id, _csrf: m[1] }).toString(),
  });
  const loc = r.headers.location || '';
  console.log(`Ф-1a-v3: action POST → status=${r.status}, Location=${loc}`);
  if (r.status !== 302 || !loc.includes('admin_token=adm-sec-9f2')) {
    child.kill('SIGTERM'); process.exit(1);
  }
  console.log('PASS Ф-1a-v3: Location несёт admin_token — токен в URL редиректа (утечка подтверждена живой пробой)');
  child.kill('SIGTERM');
  process.exit(0);
}
main().catch((e) => { console.error('crashed:', e.message); process.exit(2); });
