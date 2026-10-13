'use strict';
// [sz/#62 · волна #60] Грани сигнала вне P1/P1b: (1) без env — текст лога прежний (дефолты как есть);
// (2) авторизация фактическими кредами работает; (3) логи отказов авторизации без фактических кредов.
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = process.env.SZ_REPO;
async function start(sf, env) {
  const child = spawn('node', ['services/alfa-mock/server.js'], { cwd: REPO, env: { ...process.env, MOCK_HOST: '127.0.0.1', MOCK_PORT: '0', MOCK_TENANCY: 'namespaces', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  let port = null;
  for (let i = 0; i < 200 && !port; i += 1) { await sleep(50); const m = out.match(/on http:\/\/127\.0\.0\.1:(\d+)/); if (m) port = Number(m[1]); }
  return { child, port, out };
}
const reg = (port, user, pass, order) => fetch(`http://127.0.0.1:${port}/payment/rest/register.do`, { method: 'POST', headers: { 'X-Mock-Sandbox': 'cx', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ userName: user, password: pass, orderNumber: order, amount: '1000', returnUrl: 'https://x/' + order }).toString() }).then(async (r) => ({ status: r.status, body: await r.text() }));
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sz-w60-'));
  // (1) без env: дефолты в логе как прежде
  let s = await start(path.join(tmp, 'a.json'), {});
  await sleep(200);
  const noEnvLog = s.out;
  const defaultsPrinted = noEnvLog.includes('ALFAMOCKTEST') && noEnvLog.includes('mockpass123');
  console.log(`(1) без env: дефолты ALFAMOCKTEST/mockpass123 в стартовом логе как прежде: ${defaultsPrinted ? '✅' : '❌'}`);
  await s.child.kill('SIGKILL');
  // (2)+(3) с env: auth фактическими работает; отказ — без кредов в логах/ответах
  s = await start(path.join(tmp, 'b.json'), { MOCK_ALFA_USERNAME: 'customuser', MOCK_ALFA_PASSWORD: 'CUSTOM-SECRET-2026', MOCK_ALFA_CALLBACK_SECRET: 'CUSTOM-CB-SECRET' });
  await sleep(200);
  const okAuth = await reg(s.port, 'customuser', 'CUSTOM-SECRET-2026', 'cx-order-1');
  const badAuth = await reg(s.port, 'customuser', 'WRONG-PASSWORD', 'cx-order-2');
  await sleep(300);
  const srvLog = s.out;
  const okAuthWorks = okAuth.status === 200 && okAuth.body.includes('"orderId"');
  const badAuthHintClean = !badAuth.body.includes('CUSTOM-SECRET-2026') && !badAuth.body.includes('customuser') && badAuth.body.includes('ALFAMOCKTEST');
  const failLogClean = !srvLog.includes('CUSTOM-SECRET-2026');
  const startLogClean = !srvLog.includes('CUSTOM-SECRET-2026') && srvLog.includes('<задан через env, скрыт>');
  console.log(`(2) auth фактическими кредами: status=${okAuth.status}, orderId есть=${okAuth.body.includes('"orderId"')} -> ${okAuthWorks ? '✅' : '❌'}`);
  console.log(`(3a) отказ авторизации: hint только дефолты, без customuser/CUSTOM-SECRET-2026: ${badAuthHintClean ? '✅' : '❌'}; фрагмент: ${badAuth.body.slice(0, 150)}`);
  console.log(`(3b) лог сервера: стартовый лог скрыл env-креды=${startLogClean ? '✅' : '❌'}; логи отказов без фактических кредов=${failLogClean ? '✅' : '❌'}`);
  await s.child.kill('SIGKILL');
  console.log('\nИТОГ mini-creds-check:', defaultsPrinted && okAuthWorks && badAuthHintClean && failLogClean && startLogClean ? '✅ ВСЕ ГРАНИ' : '❌');
  console.log('tmpdir:', tmp);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
