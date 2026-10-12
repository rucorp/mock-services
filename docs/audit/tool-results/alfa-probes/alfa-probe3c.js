#!/usr/bin/env node
// P3c: правило арендатора A срабатывает на оплате B; orderId B попадает в историю, читаемую A (конфигурация из пробы A2/tbank).
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(port, method, path, { form = null, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = form !== null ? new URLSearchParams(form).toString() : (body ? JSON.stringify(body) : null);
    const h = { ...headers };
    if (data) { h['Content-Length'] = Buffer.byteLength(data); h['Content-Type'] = form !== null ? 'application/x-www-form-urlencoded' : 'application/json'; }
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: h, timeout: 5000 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, text: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
    });
    r.on('error', reject);
    if (data) r.write(data); r.end();
  });
}

(async () => {
  const child = spawn('node', ['services/alfa-mock/server.js'], {
    cwd: '/tmp/mock-services-alfa', env: { ...process.env, MOCK_HOST: '127.0.0.1', MOCK_PORT: '0', MOCK_TENANCY: 'namespaces' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  let port = null;
  for (let i = 0; i < 100 && !port; i += 1) { await sleep(50); const m = out.match(/on http:\/\/127\.0\.0\.1:(\d+)/); if (m) port = Number(m[1]); }
  try {
    // A заводит правило на target=pay (глобально)
    const rule = await req(port, 'POST', '/mock/scenarios', { body: { scenario: 'webhook-drop', target: 'pay' }, headers: { 'X-Mock-Sandbox': 'tenant-a' } });
    // B оплачивает заказ (форма + ACS)
    const o = await req(port, 'POST', '/payment/rest/register.do', { form: { userName: 'ALFAMOCKTEST', password: 'mockpass123', orderNumber: 'p3c-B', amount: '2000', returnUrl: 'https://shop.test/b' }, headers: { 'X-Mock-Sandbox': 'tenant-b' } });
    await req(port, 'POST', `/payment/${o.json.orderId}/pay`, { form: { pan: '4111111111111111', exp: '1234', cvv: '123', cardholder: 'TEST USER' }, headers: { 'X-Mock-Sandbox': 'tenant-b' } });
    // A читает историю сценариев
    const hist = await req(port, 'GET', '/mock/scenarios', { headers: { 'X-Mock-Sandbox': 'tenant-a' } });
    console.log('=== P3c ===');
    console.log('правило A заведено:', rule.status);
    console.log('orderId B:', o.json.orderId);
    console.log('orderId B в истории A:', hist.text.includes(o.json.orderId));
    console.log('история:', hist.text.slice(0, 320));
    // бонус: заказ B оплатился? (webhook-drop на pay не влияет на оплату, только на callback)
    const st = await req(port, 'GET', `/mock/state?sandbox=tenant-b`, { headers: { 'X-Mock-Sandbox': 'tenant-b' } });
    const orders = st.json && st.json.state && st.json.state.orders ? Object.values(st.json.state.orders) : [];
    console.log('статус заказа B после оплаты:', orders.map((x) => `${x.orderNumber}:${x.status}`).join(' '));
  } finally { child.kill('SIGKILL'); }
})();
