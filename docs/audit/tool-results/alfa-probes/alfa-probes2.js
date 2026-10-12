#!/usr/bin/env node
// Повторные пробы: P1b/P5 (полный лог), P6 (callback доведён до доставки), P3b (orderId B в истории A).
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');

const REPO = require('node:path').resolve(__dirname, '..', '..', '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
function req(port, method, path, { form = null, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = form !== null ? new URLSearchParams(form).toString() : (body ? JSON.stringify(body) : null);
    const h = { ...headers };
    if (data) { h['Content-Length'] = Buffer.byteLength(data); h['Content-Type'] = form !== null ? 'application/x-www-form-urlencoded' : 'application/json'; }
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: h, timeout: 5000 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, text: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data); r.end();
  });
}
function startAlfa(env, label) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['services/alfa-mock/server.js'], { cwd: REPO, env: { ...process.env, MOCK_HOST: '127.0.0.1', MOCK_PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const grab = (c) => { out += c.toString(); };
    child.stdout.on('data', grab); child.stderr.on('data', grab);
    const tick = setInterval(() => {
      const m = out.match(/on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearInterval(tick);
        resolve({ child, port: Number(m[1]), fullLog: async () => { await sleep(700); return out; } });
      }
    }, 50);
    child.on('exit', (code) => { clearInterval(tick); reject(new Error(`${label} exited: ${code}\n${out}`)); });
    setTimeout(() => { clearInterval(tick); reject(new Error(`${label}: порт не найден\n${out}`)); }, 6000);
  });
}

(async () => {
  const kids = [];
  try {
    /* P1b + P5: полный стартовый лог */
    {
      const { child, fullLog } = await startAlfa({ MOCK_ALFA_USERNAME: 'customuser', MOCK_ALFA_PASSWORD: 'CUSTOM-SECRET-2026', MOCK_CALLBACK_RETRY_MS: '1h', MOCK_SESSION_TIMEOUT_SECS: '0' }, 'alfa-log');
      kids.push(child);
      const t = await fullLog();
      const credsLine = t.split('\n').find((l) => l.includes('creds:')) || '';
      const retry = (t.match(/retry (\d+)ms/) || [])[1];
      const to = (t.match(/session_timeout=(\d+)s/) || []).slice(-1)[0] || (t.match(/session_timeout=(\d+)/) || [])[1];
      console.log('=== P1b: креды в стартовом логе ===');
      console.log('пароль в логе:', t.includes('CUSTOM-SECRET-2026'), '| строка:', credsLine.trim().slice(0, 220));
      console.log('=== P5: env-парсинг (полный лог) ===');
      console.log(`MOCK_CALLBACK_RETRY_MS='1h' → retry=${retry}ms (тихий 10000); MOCK_SESSION_TIMEOUT_SECS='0' → ${to}s (тихий 1200)`);
    }

    /* P6: hosted, доводим заказ до оплаты → callback в очередь → приёмник */
    {
      const recvPort = await freePort();
      let hits = 0; const hitLog = [];
      const recv = http.createServer((rq, rs) => { hits += 1; hitLog.push(rq.url); rs.writeHead(200); rs.end('ok'); });
      await new Promise((r) => recv.listen(recvPort, '127.0.0.1', r));
      const { child, port, fullLog } = await startAlfa({
        MOCK_HOSTED: '1', MOCK_TENANCY: 'namespaces', MOCK_ADMIN_TOKEN: 'admin-p6',
        MOCK_DEFAULT_CALLBACK_URL: `http://127.0.0.1:${recvPort}/direct`,
      }, 'alfa-p6');
      kids.push(child);
      await sleep(150);
      // заказ 1: callback на MOCK_DEFAULT_CALLBACK_URL (приватный 127.0.0.1)
      const o1 = await req(port, 'POST', '/payment/rest/register.do', { form: { userName: 'ALFAMOCKTEST', password: 'mockpass123', orderNumber: 'p6-direct', amount: '1000', returnUrl: 'https://shop.test/x' }, headers: { 'X-Mock-Sandbox': 'p6a' } });
      await req(port, 'POST', `/payment/${o1.json.orderId}/pay`, { form: { pan: '4111111111111111', exp: '1234', cvv: '123', cardholder: 'TEST USER' }, headers: { 'X-Mock-Sandbox': 'p6a' } });
      await req(port, 'POST', `/payment/${o1.json.orderId}/3ds`, { form: { password: '12345678' }, headers: { 'X-Mock-Sandbox': 'p6a' } });
      // заказ 2: callback на mapped-IPv6 (после фикса #46 должен блокироваться)
      const o2 = await req(port, 'POST', '/payment/rest/register.do', { form: { userName: 'ALFAMOCKTEST', password: 'mockpass123', orderNumber: 'p6-mapped', amount: '1000', returnUrl: 'https://shop.test/x', jsonParams: JSON.stringify({ callback_url: `http://[::ffff:127.0.0.1]:${recvPort}/mapped` }) }, headers: { 'X-Mock-Sandbox': 'p6b' } });
      await req(port, 'POST', `/payment/${o2.json.orderId}/pay`, { form: { pan: '4111111111111111', exp: '1234', cvv: '123', cardholder: 'TEST USER' }, headers: { 'X-Mock-Sandbox': 'p6b' } });
      await req(port, 'POST', `/payment/${o2.json.orderId}/3ds`, { form: { password: '12345678' }, headers: { 'X-Mock-Sandbox': 'p6b' } });
      await sleep(3500);
      let cbStatuses = [];
      try {
        const st = await req(port, 'GET', '/mock/state?sandbox=p6a', { headers: { 'X-Mock-Sandbox': 'p6a', Authorization: 'Bearer admin-p6' } });
        const snap = st.json && (st.json.state || st.json);
        cbStatuses = (snap && snap.callbacks ? Object.values(snap.callbacks) : []).map((c) => `${c.operation}:${c.lastStatus}:${(c.lastBody || '').slice(0, 60)}`);
      } catch (e) { cbStatuses = ['ошибка чтения state: ' + e.message]; }
      const t = await fullLog();
      recv.close();
      console.log('\n=== P6: SSRF-гард в hosted (полный прогон до оплаты) ===');
      console.log('block_private_webhooks=true в логе:', /block_private_webhooks=true/.test(t));
      console.log('доставок на приватный приёмник:', hits, hitLog.join(' '));
      console.log('статусы callback в p6a:', JSON.stringify(cbStatuses));
      const blockedLog = t.split('\n').filter((l) => /SSRF|BLOCK|block/i.test(l)).slice(0, 4);
      console.log('строки SSRF-блокировок:', JSON.stringify(blockedLog));
    }

    /* P3b: orderId B в истории сценариев, видимой A */
    {
      const { child, port } = await startAlfa({ MOCK_TENANCY: 'namespaces' }, 'alfa-p3b');
      kids.push(child);
      await sleep(150);
      const o = await req(port, 'POST', '/payment/rest/register.do', { form: { userName: 'ALFAMOCKTEST', password: 'mockpass123', orderNumber: 'p3b-B', amount: '2000', returnUrl: 'https://shop.test/b' }, headers: { 'X-Mock-Sandbox': 'tenant-b' } });
      await req(port, 'POST', `/payment/${o.json.orderId}/pay`, { form: { pan: '4111111111111111', exp: '1234', cvv: '123', cardholder: 'TEST USER' }, headers: { 'X-Mock-Sandbox': 'tenant-b' } });
      await req(port, 'POST', `/payment/${o.json.orderId}/3ds`, { form: { password: '12345678' }, headers: { 'X-Mock-Sandbox': 'tenant-b' } });
      const hist = await req(port, 'GET', '/mock/scenarios', { headers: { 'X-Mock-Sandbox': 'tenant-a' } });
      console.log('\n=== P3b: orderId песочницы B в истории, читаемой A ===');
      console.log('orderId B в истории A:', hist.text.includes(o.json.orderId), '| фрагмент истории:', hist.text.slice(0, 260));
    }
  } catch (e) {
    console.error('ОШИБКА:', e.message);
  } finally {
    for (const c of kids) { try { c.kill('SIGKILL'); } catch {} }
  }
})();
