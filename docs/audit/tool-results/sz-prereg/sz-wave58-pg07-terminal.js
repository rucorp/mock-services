#!/usr/bin/env node
// [sz/#58 · PG-07] SSRF-блок терминален: запись dumped, попытки не растут, ретрай-цикла нет.
// Предрегистрация (sz-prereg/README, адаптация волны #58): «до» — attempts 2+/растут,
// dumped=false, терминального лога нет; «после» — attempts=1 (заморожены), dumped=true,
// 0 доставок, лог «повтор не имеет смысла» ×1, остаточная строка ядра «retry in …» ≤1.
// Ядро createDeliveryQueue не менялось — терминальность вводит onFailure адаптера alfa.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function report(id, title, verdict, evidence) {
  console.log(`\n=== ${id}: ${title} ===\nВЕРДИКТ: ${verdict}${evidence ? '\n' + evidence : ''}`);
}

function req(port, method, p, { body = null, form = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = form !== null ? new URLSearchParams(form).toString() : (body ? JSON.stringify(body) : null);
    const headers2 = { ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers };
    if (data && form !== null) headers2['Content-Type'] = 'application/x-www-form-urlencoded';
    if (data && body) headers2['Content-Type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: headers2, timeout: 5000 }, (res) => {
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

async function readCallbacks(port, sandbox) {
  const st = await req(port, 'GET', `/mock/state?sandbox=${sandbox}`, { headers: { 'X-Mock-Sandbox': sandbox, Authorization: 'Bearer adm-pg07' } });
  const state = (st.json && st.json.state) || st.json || {};
  return Object.values(state.callbacks || {});
}

(async () => {
  const children = [];
  let hits = 0;
  const recv = http.createServer((rq, rs) => { hits += 1; rs.writeHead(200); rs.end('ok'); });
  await new Promise((r) => recv.listen(0, '127.0.0.1', r));
  const recvPort = recv.address().port;

  try {
    const a = await startAlfa({
      MOCK_HOSTED: '1', MOCK_TENANCY: 'namespaces', MOCK_ADMIN_TOKEN: 'adm-pg07',
      MOCK_CALLBACK_RETRY_MS: '1000', // окно 2.6с = 2+ тика очереди
    }, 'alfa-pg07');
    children.push(a.child);
    await sleep(200);

    const reg = await req(a.port, 'POST', '/payment/rest/register.do', {
      form: {
        userName: 'ALFAMOCKTEST', password: 'mockpass123', orderNumber: 'pg07-term', amount: '1000',
        returnUrl: 'https://shop.test/x', jsonParams: JSON.stringify({ callback_url: `http://127.0.0.1:${recvPort}/cb` }),
      },
      headers: { 'X-Mock-Sandbox': 'pg07a' },
    });
    if (!reg.json || reg.json.errorCode !== 0) throw new Error(`register не удался: ${reg.text.slice(0, 200)}`);
    const orderId = reg.json.orderId;

    // deposited-callback планируется после завершения оплаты (как в P6 alfa-probes2):
    // pay картой 3ds1 -> ACS -> подтверждение 3ds паролем 12345678 -> deposited
    await req(a.port, 'POST', `/payment/${orderId}/pay`, {
      form: { pan: '4111111111111111', exp: '1234', cvv: '123', cardholder: 'TEST USER' },
      headers: { 'X-Mock-Sandbox': 'pg07a' },
    });
    await req(a.port, 'POST', `/payment/${orderId}/3ds`, {
      form: { password: '12345678' },
      headers: { 'X-Mock-Sandbox': 'pg07a' },
    });

    // Ждём первый доставочный тик: lastStatus содержит ERR SSRF_BLOCKED
    let entryAtBlock = null;
    for (let i = 0; i < 25; i++) {
      await sleep(200);
      const cbs = await readCallbacks(a.port, 'pg07a');
      const e = cbs.find((x) => String(x.lastStatus || '').includes('SSRF_BLOCKED'));
      if (e) { entryAtBlock = e; break; }
    }
    if (!entryAtBlock) throw new Error('SSRF_BLOCKED не зафиксирован в /mock/state за 5с\n' + a.log().slice(-800));
    const attemptsAtBlock = entryAtBlock.attempts;

    await sleep(2600); // 2+ тика очереди при retry=1000мс

    const cbsAfter = await readCallbacks(a.port, 'pg07a');
    const eAfter = cbsAfter.find((x) => x.id === entryAtBlock.id) || null;
    const terminalLogs = (a.log().match(/цель заблокирована политикой SSRF/g) || []).length;
    const retryLogs = (a.log().match(/retry in \d+ms/g) || []).length;

    const terminal = Boolean(eAfter) && eAfter.dumped === true && eAfter.attempts === attemptsAtBlock
      && hits === 0 && terminalLogs === 1 && retryLogs <= 1;
    report('PG-07a', 'SSRF-блок терминален: dumped, попытки не растут, доставок нет, терминальный лог ×1',
      terminal ? 'ЗАКРЫТО (терминальное состояние, цикла нет)' : 'ТРЕБУЕТ ВНИМАНИЯ',
      `attempts: ${attemptsAtBlock} → ${eAfter && eAfter.attempts}; dumped=${eAfter && eAfter.dumped}; доставок на приватный приёмник: ${hits}; ` +
      `лог «цель заблокирована…»: ${terminalLogs}×; «retry in …»: ${retryLogs}×\n` +
      `lastStatus: ${String(entryAtBlock.lastStatus).slice(0, 140)}`);

    console.log('\n---- ИТОГ PG-07 ----');
    console.log('До фикса (#58): onFailure не различал SSRF-отказ — запись ретраилась (attempts растут), dumped только по лимиту 24, терминального лога нет.');
    console.log('После фикса: запись dumped сразу, attempts заморожены, лог «повтор не имеет смысла» ровно один раз.');
  } finally {
    for (const c of children) { try { c.kill(); } catch {} }
    recv.close();
  }
})().catch((e) => { console.error('ПРОБА УПАЛА:', e.message); process.exit(2); });
