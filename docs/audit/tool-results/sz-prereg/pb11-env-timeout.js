#!/usr/bin/env node
// [sz/#64 · PB-11 ≡ PG-05] alfa env-parse: тихая усечённая интерпретация суффиксов.
// Claim дельты #54: MOCK_SESSION_TIMEOUT_SECS='1h' -> 1 сек (parseInt('1h')=1),
// MOCK_CALLBACK_RETRY_MS='1h' -> 1000 мс (Math.max(1000,1)); честное поведение —
// фолбэк 1200/10000 либо отказ старта. Код: services/alfa-mock/server.js:143,146-149.
// Это «до»-проба волны #58: после фикса '1h' НЕ должен давать 1с/1000мс.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const results = [];
function report(id, title, verdict, evidence) {
  results.push({ id, title, verdict });
  console.log(`\n=== ${id}: ${title} ===\nВЕРДИКТ: ${verdict}${evidence ? '\n' + evidence : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(port, method, p, { body = null, form = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = form !== null ? new URLSearchParams(form).toString() : (body ? JSON.stringify(body) : null);
    const headers2 = { ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers };
    if (data && form !== null) headers2['Content-Type'] = 'application/x-www-form-urlencoded';
    if (data && body) headers2['Content-Type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: headers2, timeout: 5000 }, (res) => {
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

const FORM = { userName: 'ALFAMOCKTEST', password: 'mockpass123', amount: '1000', returnUrl: 'https://shop.test/ok' };

(async () => {
  const children = [];
  try {
    /* ---- Фаза A: '1h' в обоих env ---- */
    const a = await startAlfa({ MOCK_SESSION_TIMEOUT_SECS: '1h', MOCK_CALLBACK_RETRY_MS: '1h' }, 'alfa-pb11-1h');
    children.push(a.child);
    await sleep(150);
    const health = await req(a.port, 'GET', '/health');
    const sts = health.json && health.json.sessionTimeoutSecs;
    const retry = (a.log().match(/retry (\d+)ms/) || [])[1];
    report('PB-11a', "MOCK_SESSION_TIMEOUT_SECS='1h' -> sessionTimeoutSecs=1 (тихое усечение)",
      sts === 1 ? 'ПОДТВЕРЖДЕНО (int-префикс съеден)' : 'не подтвердилось',
      `GET /health -> sessionTimeoutSecs=${JSON.stringify(sts)} (честно было бы 1200-фолбэк или отказ старта)\n` +
      `стартовый лог: retry=${retry}ms (MOCK_CALLBACK_RETRY_MS='1h' -> ${retry}ms; честно было бы 10000-фолбэк)`);

    /* ---- Фаза B: поведенческая — заказ протухает через виртуальные часы (+2с) ---- */
    const reg = await req(a.port, 'POST', '/payment/rest/register.do', { form: { ...FORM, orderNumber: 'pb11-a1' } });
    const orderId = reg.json && reg.json.orderId;
    await sleep(2600); // interval-тик alfa (1с) обязан отклонить заказ (declinedByTimeout) при sessionTimeoutSecs=1
    const st = await req(a.port, 'POST', '/payment/rest/getOrderStatusExtended.do', { form: { ...FORM, orderId } });
    const expired = st.json && (st.json.orderStatus === 6 || /declinedByTimeout|Истёк срок|по таймауту/i.test(st.text));
    report('PB-11b', "поведенчески: сессия '1h' истекает через ~1с (declinedByTimeout)",
      expired ? 'ПОДТВЕРЖДЕНО (заказ отклонён по таймауту)' : 'не подтвердилось',
      `orderStatus=${st.json && st.json.orderStatus}, orderNumber=pb11-a1, через 2.6с реального времени при sessionTimeoutSecs=1; фрагмент: ${st.text.slice(0, 220)}`);

    /* ---- Фаза C: контроль — числовые значения интерпретируются честно ---- */
    const c = await startAlfa({ MOCK_SESSION_TIMEOUT_SECS: '3600', MOCK_CALLBACK_RETRY_MS: '60000' }, 'alfa-pb11-ctl');
    children.push(c.child);
    await sleep(150);
    const healthC = await req(c.port, 'GET', '/health');
    const stsC = healthC.json && healthC.json.sessionTimeoutSecs;
    const retryC = (c.log().match(/retry (\d+)ms/) || [])[1];
    report('PB-11c', "контроль: '3600'/'60000' проходят без искажений",
      stsC === 3600 && retryC === '60000' ? 'ПОДТВЕРЖДЕНО (дефект именно в суффиксах)' : 'не подтвердилось',
      `sessionTimeoutSecs=${stsC}, retry=${retryC}ms`);

    console.log('\n---- ИТОГ PB-11 ----');
    console.log('До фикса (#58): суффиксы времени в env alfa тихо усекаются до int-префикса.');
    console.log('Ожидание после фикса (предрегистрация): "1h" -> фолбэк 1200/10000 ИЛИ отказ старта с внятной ошибкой; никогда не 1с/1000мс.');
  } finally {
    for (const c of children) { try { c.kill(); } catch {} }
  }
})().catch((e) => { console.error('ПРОБА УПАЛА:', e.message); process.exit(2); });
