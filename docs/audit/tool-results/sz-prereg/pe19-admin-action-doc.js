#!/usr/bin/env node
// [sz/#64 · PE-19] POST /admin/action — живой недокументированный маршрут alfa.
// Обработчик есть (server.js:1847, используется консолью :1542/:1552-1574), но:
//   - отсутствует в манифесте protocols/alfa-eacq.json (mockRoutes/mockControlRoutes);
//   - отсутствует в docs/openapi/alfa-mock.openapi.json (есть только /admin, /admin/journal);
//   - отсутствует в services/alfa-mock/README.md (там «GET /admin, GET /admin/journal»).
// Drift-чекер маршрут не видит вовсе (нет в манифесте — нечему расходиться).
// Это «до»-проба: после фикса маршрут обязан быть задекларирован или закрыт.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
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
      res.on('end', () => resolve({ status: res.statusCode, text: buf, json: (() => { try { return JSON.parse(buf); } catch { return null; } })(), headers: res.headers }));
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
  /* ---------- Статическая часть: где маршрут задекларирован, а где нет ---------- */
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'protocols', 'alfa-eacq.json'), 'utf8'));
  const openapi = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'openapi', 'alfa-mock.openapi.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(REPO, 'services', 'alfa-mock', 'README.md'), 'utf8');
  const serverCode = fs.readFileSync(path.join(REPO, 'services', 'alfa-mock', 'server.js'), 'utf8');

  const inMockRoutes = (manifest.mockRoutes || []).includes('/admin/action');
  const inControlRoutes = (manifest.mockControlRoutes || []).includes('/admin/action');
  const inOpenApi = Boolean(openapi.paths && openapi.paths['/admin/action']);
  const inReadme = readme.includes('/admin/action');
  const inServer = serverCode.includes("p === '/admin/action'");
  const siblingJournalInOpenApi = Boolean(openapi.paths && openapi.paths['/admin/journal']);

  report('PE-19a', 'статика: /admin/action жив в коде, но отсутствует во всех декларациях',
    inServer && !inMockRoutes && !inControlRoutes && !inOpenApi && !inReadme ? 'ПОДТВЕРЖДЕНО' : 'не подтвердилось',
    `server.js: обработчик POST /admin/action — ${inServer}\n` +
    `protocols/alfa-eacq.json: mockRoutes=${inMockRoutes}, mockControlRoutes=${inControlRoutes}\n` +
    `docs/openapi/alfa-mock.openapi.json: /admin/action=${inOpenApi} (для сравнения /admin/journal=${siblingJournalInOpenApi})\n` +
    `services/alfa-mock/README.md: ${inReadme}`);

  /* ---------- Живая часть: маршрут отвечает и ИСПОЛНЯЕТ действия ---------- */
  const { child, port } = await startAlfa({}, 'alfa-pe19');
  try {
    await sleep(150);
    const reg = await req(port, 'POST', '/payment/rest/register.do', {
      form: { userName: 'ALFAMOCKTEST', password: 'mockpass123', orderNumber: 'pe19-o1', amount: '1000', returnUrl: 'https://shop.test/ok' },
    });
    const orderId = reg.json && reg.json.orderId;

    const noCsrf = await req(port, 'POST', '/admin/action', { form: { action: 'expire-order', id: orderId } });
    report('PE-19b', 'живой маршрут: POST /admin/action без CSRF -> 403 с подсказкой консоли (маршрут существует)',
      noCsrf.status === 403 ? 'ПОДТВЕРЖДЕНО' : 'не подтвердилось',
      `status=${noCsrf.status}; фрагмент: ${noCsrf.text.slice(0, 200)}`);

    const page = await req(port, 'GET', '/admin');
    const csrfMatch = page.text.match(/name="_csrf" value="([^"]+)"/);
    const csrf = csrfMatch && csrfMatch[1];
    const withCsrf = await req(port, 'POST', '/admin/action', { form: { _csrf: csrf || '', action: 'expire-order', id: orderId } });
    const st = await req(port, 'POST', '/payment/rest/getOrderStatusExtended.do', {
      form: { userName: 'ALFAMOCKTEST', password: 'mockpass123', orderId },
    });
    const executed = withCsrf.status === 302 && st.json && st.json.orderStatus !== 0;
    report('PE-19c', 'живой маршрут с валидным CSRF исполняет действие (expire-order -> заказ отклонён)',
      executed ? 'ПОДТВЕРЖДЕНО (недокументированная управляющая поверхность активна)' : 'не подтвердилось',
      `POST /admin/action с _csrf: status=${withCsrf.status} (302-редирект консоли)\n` +
      `статус заказа после действия: orderStatus=${st.json && st.json.orderStatus} (был 0)`);

    console.log('\n---- ИТОГ PE-19 ----');
    console.log('До фикса: /admin/action — действующая управляющая поверхность вне mockRoutes/OpenAPI/README и вне поля зрения drift-чекера.');
    console.log('Ожидание после фикса (предрегистрация): /admin/action декларирован в mockRoutes+openapi+README (и виден drift-чекеру), либо маршрут закрыт.');
  } finally {
    try { child.kill(); } catch {}
  }
})().catch((e) => { console.error('ПРОБА УПАЛА:', e.message); process.exit(2); });
