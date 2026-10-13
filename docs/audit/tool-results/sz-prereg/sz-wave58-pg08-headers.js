#!/usr/bin/env node
// [sz/#58 · PG-08 ≡ MS-16-alfa] Security-заголовки на страницах оплаты/ACS.
// Предрегистрация: X-Frame-Options/CSP/Referrer-Policy/X-Content-Type-Options
// на GET /payment/{id}, /pay (ACS-страница), 404-странице заказа; /admin — были.
// Набор #58: XFO=DENY, Referrer-Policy=no-referrer, CSP form-action 'self'; base-uri 'none';
// frame-ancestors 'none', X-Content-Type-Options=nosniff, Cache-Control=no-store, private.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPECT = {
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
};
const CACHE = 'no-store, private';

function req(port, method, p, { body = null, form = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = form !== null ? new URLSearchParams(form).toString() : (body ? JSON.stringify(body) : null);
    const headers2 = { ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers };
    if (data && form !== null) headers2['Content-Type'] = 'application/x-www-form-urlencoded';
    if (data && body) headers2['Content-Type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: headers2, timeout: 5000 }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: buf, headers: res.headers }));
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
    let done = false;
    const onData = (c) => {
      out += c.toString();
      if (done) return;
      const m = out.match(/on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { done = true; resolve({ child, port: Number(m[1]), log: () => out }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`${label} exited early: ${code}\n${out}`)));
    setTimeout(() => { if (!done) reject(new Error(`${label}: порт не найден за 5с\n${out}`)); }, 5000);
  });
}

function checkHeaders(label, res) {
  const missing = [];
  for (const [h, v] of Object.entries(EXPECT)) {
    if (String(res.headers[h] || '') !== v) missing.push(`${h}: ${JSON.stringify(res.headers[h] || null)} ≠ ${JSON.stringify(v)}`);
  }
  if (String(res.headers['cache-control'] || '') !== CACHE) missing.push(`cache-control: ${JSON.stringify(res.headers['cache-control'] || null)}`);
  const ok = missing.length === 0 && res.headers['content-type'] && String(res.headers['content-type']).includes('text/html');
  return { ok, missing, ct: res.headers['content-type'] };
}

(async () => {
  const children = [];
  try {
    const a = await startAlfa({}, 'alfa-pg08');
    children.push(a.child);
    await sleep(200);

    const reg = await req(a.port, 'POST', '/payment/rest/register.do', {
      form: { userName: 'ALFAMOCKTEST', password: 'mockpass123', orderNumber: 'pg08-headers', amount: '1000', returnUrl: 'https://shop.test/ok' },
    });
    const regJson = JSON.parse(reg.text);
    if (regJson.errorCode !== 0) throw new Error(`register не удался: ${reg.text.slice(0, 200)}`);
    const orderId = regJson.orderId;
    const formPath = new URL(regJson.formUrl).pathname;

    const pages = [];

    // 1) GET /payment/{id} — форма оплаты (orderStatus=0)
    pages.push(['форма оплаты GET /payment/{id}', checkHeaders('form', await req(a.port, 'GET', formPath))]);

    // 2) POST /pay картой 3ds1 -> страница ACS (stage '3ds', 200 HTML)
    const acs = await req(a.port, 'POST', `/payment/${orderId}/pay`, {
      form: { pan: '4111111111111111', exp: '1234', cvv: '123', cardholder: 'IVAN IVANOV' },
    });
    pages.push([`ACS-страница POST /pay (status=${acs.status}, ${acs.text.includes('3DS') ? 'ACS-маркер есть' : 'маркера нет'})`, checkHeaders('acs', acs)]);

    // 3) GET /payment/{id} в статусе 5 -> ACS-страница повторно
    pages.push(['ACS-страница GET /payment/{id} (status=5)', checkHeaders('acs-get', await req(a.port, 'GET', formPath))]);

    // 4) 404-страница заказа
    pages.push(['404-страница заказа', checkHeaders('404', await req(a.port, 'GET', '/payment/00000000-0000-4000-8000-000000000000'))]);

    // 5) /admin (заголовки были — теперь тот же sendPage)
    pages.push(['/admin', checkHeaders('admin', await req(a.port, 'GET', '/admin'))]);

    for (const [label, r] of pages) {
      console.log(`\n=== PG-08: ${label} ===`);
      console.log(`ВЕРДИКТ: ${r.ok ? 'ЗАКРЫТО (все заголовки на месте)' : 'ТРЕБУЕТ ВНИМАНИЯ'}`);
      if (!r.ok) console.log('отклонения: ' + r.missing.join('; '));
    }
    const allOk = pages.every(([, r]) => r.ok);
    console.log('\n---- ИТОГ PG-08 ----');
    console.log(`Страниц проверено: ${pages.length}/5; ${allOk ? 'ВСЕ с security-набором (XFO/CSP/Referrer/nosniff/no-store)' : 'ЕСТЬ ОТКЛОНЕНИЯ'}`);
    console.log('До фикса (#58): страницы формы/ACS/404 отдавались html() без заголовков (MS-16-alfa).');
    process.exitCode = allOk ? 0 : 1;
  } finally {
    for (const c of children) { try { c.kill(); } catch {} }
  }
})().catch((e) => { console.error('ПРОБА УПАЛА:', e.message); process.exit(2); });
