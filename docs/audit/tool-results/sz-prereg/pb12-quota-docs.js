#!/usr/bin/env node
// [sz/#64 · PB-12] alfa квота документов: «документ» не равен документу.
// Claim: MOCK_SANDBOX_MAX_DOCUMENTS=2 -> ровно 1 успешный register, потому что
// счётчик (server.js:201-204) считает orders + orderNumbers + callbacks, а один
// register создаёт И order, И запись orderNumbers (server.js:1010) = 2 единицы.
// Это «до»-проба волны #53: после фикса MAX_DOCUMENTS=2 должен допускать 2 заказа.
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
      MOCK_SANDBOX_TOKEN: 'close-default-sz-pb12',
      MOCK_SANDBOX_MAX_DOCUMENTS: '2',
    }, 'alfa-pb12');
    children.push(child);
    await sleep(150);

    const mk = await req(port, 'POST', '/sandboxes', { body: {} });
    const A = { id: mk.json.id, tok: mk.json.ownerToken, creds: mk.json.creds };
    const AH = { 'X-Mock-Sandbox': A.id, 'X-Sandbox-Token': A.tok };
    console.log(`[PB-12] песочница A=${A.id}, лимит MAX_DOCUMENTS=2`);

    const r1 = await req(port, 'POST', '/payment/rest/register.do', {
      form: { userName: A.creds.userName, password: A.creds.password, orderNumber: 'pb12-o1', amount: '1000', returnUrl: 'https://shop.test/ok' },
      headers: AH,
    });
    const ok1 = r1.json && r1.json.errorCode === 0;
    console.log(`[PB-12] register #1 (pb12-o1): errorCode=${r1.json && r1.json.errorCode} orderId=${r1.json && r1.json.orderId}`);

    const r2 = await req(port, 'POST', '/payment/rest/register.do', {
      form: { userName: A.creds.userName, password: A.creds.password, orderNumber: 'pb12-o2', amount: '2000', returnUrl: 'https://shop.test/ok' },
      headers: AH,
    });
    const blocked2 = r2.json && r2.json.errorCode !== 0;
    const hint = (r2.json && r2.json.errorMessage) || r2.text || '';
    console.log(`[PB-12] register #2 (pb12-o2): errorCode=${r2.json && r2.json.errorCode} hint=${String(hint).slice(0, 140)}`);

    const snap = await req(port, 'GET', '/mock/state', { headers: AH });
    let ordersN = -1; let orderNumbersN = -1;
    try {
      const s = snap.json && (snap.json.state || snap.json);
      ordersN = Object.keys((s && s.orders) || {}).length;
      orderNumbersN = Object.keys((s && s.orderNumbers) || {}).length;
    } catch {}
    const used = ordersN + orderNumbersN;

    report('PB-12', 'MOCK_SANDBOX_MAX_DOCUMENTS=2 -> только 1 успешный register (1 заказ = 2 квот-единицы)',
      ok1 && blocked2 && used === 2 ? 'ПОДТВЕРЖДЕНО (квота исчерпана одним заказом)' : 'не подтвердилось',
      `register#1 errorCode=0; register#2 errorCode=${r2.json && r2.json.errorCode} (заблокирован);\n` +
      `состояние A: orders=${ordersN}, orderNumbers=${orderNumbersN} -> used=${used} >= limit=2\n` +
      `подсказка сервера: ${String(hint).slice(0, 200)}`);

    console.log('\n---- ИТОГ PB-12 ----');
    console.log('До фикса (#53): один register расходует 2 единицы квоты документов (order + orderNumbers).');
    console.log('Ожидание после фикса (предрегистрация): MAX_DOCUMENTS=2 допускает 2 успешных register; счётчик считает пользовательские документы, а не внутренние словари.');
  } finally {
    for (const c of children) { try { c.kill(); } catch {} }
  }
})().catch((e) => { console.error('ПРОБА УПАЛА:', e.message); process.exit(2); });
