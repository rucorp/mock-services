#!/usr/bin/env node
// [sz/#64 · PB-13] Журнал alfa не изолирован по песочницам — обе грани.
// Грань 1: GET /admin/journal (server.js:1747) отдаёт journal.list() ГЛОБАЛЬНО —
//   владелец A видит REST-записи B (включая curl с кредами B).
// Грань 2: POST /mock/reset (server.js:1757-1768) вызывает journal.clear() (:1767)
//   безотносительно target — reset песочницы A стирает журнал B.
// Это «до»-проба волны #52: после фикса журнал должен быть per-sandbox.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
function report(id, title, verdict, evidence) {
  console.log(`\n=== ${id}: ${title} ===\nВЕРДИКТ: ${verdict}${evidence ? '\n' + evidence : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(port, method, p, { body = null, form = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = form !== null ? new URLSearchParams(form).toString() : (body ? JSON.stringify(body) : null);
    const h = { ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers };
    if (data && form !== null) h['Content-Type'] = 'application/x-www-form-urlencoded';
    if (data && body) h['Content-Type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, timeout: 5000 }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: buf, json: (() => { try { return JSON.parse(buf); } catch { return null; } })() }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

function startAlfa(env, label) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['services/alfa-mock/server.js'], {
      cwd: REPO, env: { ...process.env, MOCK_HOST: '127.0.0.1', MOCK_PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (c) => {
      out += c.toString();
      const m = out.match(/on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { child.stdout.removeListener('data', onData); child.stderr.removeListener('data', onData); resolve({ child, port: Number(m[1]), log: () => out }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`${label} exited early: ${code}\n${out}`)));
    setTimeout(() => reject(new Error(`${label}: порт не найден за 5с\n${out}`)), 5000);
  });
}

(async () => {
  const children = [];
  try {
    const { child, port } = await startAlfa({
      MOCK_TENANCY: 'owned',
      MOCK_SANDBOX_TOKEN: 'close-default-sz-pb13',
    }, 'alfa-pb13');
    children.push(child);
    await sleep(150);

    const mkA = await req(port, 'POST', '/sandboxes', { body: {} });
    const mkB = await req(port, 'POST', '/sandboxes', { body: {} });
    const A = { id: mkA.json.id, tok: mkA.json.ownerToken, creds: mkA.json.creds };
    const B = { id: mkB.json.id, tok: mkB.json.ownerToken, creds: mkB.json.creds };
    console.log(`[PB-13] песочницы: A=${A.id}, B=${B.id}`);

    // B делает REST-вызовы -> попадают в глобальный журнал
    const regB = await req(port, 'POST', '/payment/rest/register.do', {
      form: { userName: B.creds.userName, password: B.creds.password, orderNumber: 'pb13-order-B', amount: '7000', returnUrl: 'https://shop.test/b-ok' },
      headers: { 'X-Mock-Sandbox': B.id, 'X-Sandbox-Token': B.tok },
    });
    console.log(`[PB-13] заказ B: errorCode=${regB.json && regB.json.errorCode} orderId=${regB.json && regB.json.orderId}`);

    /* ---- Грань 1: владелец A читает записи B ---- */
    const jA = await req(port, 'GET', '/admin/journal', { headers: { 'X-Mock-Sandbox': A.id, 'X-Sandbox-Token': A.tok } });
    const entriesA = (jA.json && jA.json.entries) || [];
    const bLeak = jA.status === 200 && jA.text.includes('pb13-order-B');
    report('PB-13a', 'владелец A видит REST-записи B (GET /admin/journal глобален)',
      bLeak ? 'ПОДТВЕРЖДЕНО (кросс-арендаторское чтение журнала)' : 'не подтвердилось',
      `entries=${entriesA.length}, запись B (pb13-order-B) в ответе A: ${jA.text.includes('pb13-order-B')}
` +
      `поля кредов B в body журнала маскируются ([REDACTED]), но сама запись B (orderNumber/amount) A читаема; креды-маскирование — заслуга summarizeBody, не изоляции журнала\n` +
      `фрагмент: ${jA.text.slice(0, 300)}`);

    /* ---- Грань 2: reset своей песочницы A стирает журнал B ---- */
    const reset = await req(port, 'POST', '/mock/reset', { body: {}, headers: { 'X-Mock-Sandbox': A.id, 'X-Sandbox-Token': A.tok } });
    const jB = await req(port, 'GET', '/admin/journal', { headers: { 'X-Mock-Sandbox': B.id, 'X-Sandbox-Token': B.tok } });
    const entriesB = (jB.json && jB.json.entries) || [];
    report('PB-13b', 'reset песочницы A (POST /mock/reset от A) стирает журнал B (journal.clear() глобален)',
      reset.status === 200 && entriesB.length === 0 ? 'ПОДТВЕРЖДЕНО (журнал B уничтожен чужим reset)' : 'не подтвердилось',
      `reset от A: status=${reset.status} (target по умолчанию — своя песочница A)\n` +
      `журнал B после чужого reset: entries=${entriesB.length} (до reset — минимум 1 запись о register B)`);

    console.log('\n---- ИТОГ PB-13 ----');
    console.log('До фикса (#52): журнал REST-вызовов глобален: чтение чужих записей + уничтожение чужого журнала reset-ом.');
    console.log('Ожидание после фикса (предрегистрация): /admin/journal отдаёт только записи своей песочницы; journal.clear() затрагивает только целевую песочницу; записи B у B сохраняются.');
  } finally {
    for (const c of children) { try { c.kill(); } catch {} }
  }
})().catch((e) => { console.error('ПРОБА УПАЛА:', e.message); process.exit(2); });
