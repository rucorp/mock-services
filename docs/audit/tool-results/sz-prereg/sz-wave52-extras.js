#!/usr/bin/env node
// [sz/#62 · волна #52] Комплементарная проба к P3/P3c/pb13 — три дифференцирующие секции (v2):
//   R (PG-09): POST /mock/reset от A чистит ТОЛЬКО A; правила (persistent) / история / журнал B целы, правило B матчит трафик B.
//   L (жизненный цикл, #52): DELETE песочницы -> пересоздание тем же id: rules/history пусты, журнал содержит только записи новой жизни (нет наследования).
//   CAP (дополнения владельца #52): 201-е правило -> 400 + code:rule_cap_exceeded; >8KiB -> 400 + code:rule_too_large; без новых статусов.
// Запуск: SZ_REPO=<корень репо> node sz-wave52-extras.js  (REPO по умолчанию — от __dirname).
// Контроль силы пробы: на до-коде 4d70201 ожидаются R ❌ (глобальный clear), L ❌ (глобальный реестр = наследование), CAP: #201=200, big=200.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = process.env.SZ_REPO || path.resolve(__dirname, '..', '..', '..', '..');

function req(port, method, p, { form = null, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = form !== null ? new URLSearchParams(form).toString() : (body ? JSON.stringify(body) : null);
    const h = { ...headers };
    if (data) { h['Content-Length'] = Buffer.byteLength(data); h['Content-Type'] = form !== null ? 'application/x-www-form-urlencoded' : 'application/json'; }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, timeout: 8000 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, text: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
    });
    r.on('error', reject);
    if (data) r.write(data); r.end();
  });
}

let out = '';
async function startAlfa() {
  const child = spawn('node', ['services/alfa-mock/server.js'], {
    cwd: REPO, env: { ...process.env, MOCK_HOST: '127.0.0.1', MOCK_PORT: '0', MOCK_TENANCY: 'namespaces' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  let port = null;
  for (let i = 0; i < 140 && !port; i += 1) { await sleep(50); const m = out.match(/on http:\/\/127\.0\.0\.1:(\d+)/); if (m) port = Number(m[1]); }
  if (!port) { child.kill('SIGKILL'); throw new Error('порт не получен; стартовый лог:\n' + out.slice(0, 800)); }
  return child;
}
const reg = (port, sbx, order) => req(port, 'POST', '/payment/rest/register.do', { form: { userName: 'ALFAMOCKTEST', password: 'mockpass123', orderNumber: order, amount: '1000', returnUrl: 'https://shop.test/' + order }, headers: { 'X-Mock-Sandbox': sbx } });
const ruleP = (port, sbx, match) => req(port, 'POST', '/mock/scenarios', { body: { scenario: 'fail', target: 'register', persistent: true, ...(match ? { match } : {}) }, headers: { 'X-Mock-Sandbox': sbx } });
const scenarios = (port, sbx) => req(port, 'GET', '/mock/scenarios', { headers: { 'X-Mock-Sandbox': sbx } });
const journal = (port, sbx) => req(port, 'GET', '/admin/journal', { headers: { 'X-Mock-Sandbox': sbx } });
const ok = (b) => (b ? '✅' : '❌');

(async () => {
  const child = await startAlfa();
  const port = Number((out.match(/on http:\/\/127\.0\.0\.1:(\d+)/) || [])[1]);
  try {
    console.log(`[extras] REPO=${REPO} port=${port}`);

    /* ---------- Секция R: PG-09 scope сброса ---------- */
    console.log('\n=== R: POST /mock/reset от A — сброс только целевой записи (PG-09) ===');
    const r1 = await ruleP(port, 'r-a'); const r2 = await ruleP(port, 'r-b');
    const oa = await reg(port, 'r-a', 'ra-old-111'); const ob = await reg(port, 'r-b', 'rb-old-222');
    console.log(`правила заведены: A=${r1.status} B=${r2.status}; заказы: A errorCode=${oa.json && oa.json.errorCode} B errorCode=${ob.json && ob.json.errorCode}`);
    const preA = await scenarios(port, 'r-a'); const preB = await scenarios(port, 'r-b');
    console.log(`до reset: A rules=${preA.json.rules.length} history=${preA.json.history.length}; B rules=${preB.json.rules.length} history=${preB.json.history.length}; rb-old-222 виден A: ${preA.text.includes('rb-old-222')}; ra-old-111 виден B: ${preB.text.includes('ra-old-111')}`);
    const rst = await req(port, 'POST', '/mock/reset', { body: {}, headers: { 'X-Mock-Sandbox': 'r-a' } });
    console.log(`reset от A: status=${rst.status} ответ=${rst.text.slice(0, 140)}`);
    const postA = await scenarios(port, 'r-a'); const postB = await scenarios(port, 'r-b');
    const jb = await journal(port, 'r-b');
    const regA2 = await reg(port, 'r-a', 'ra-new-333');
    const regB2 = await reg(port, 'r-b', 'rb-new-444');
    console.log(`после: A rules=${postA.json.rules.length} history=${postA.json.history.length}; register A2 errorCode=${regA2.json && regA2.json.errorCode} (0 = правила A нет — свой сброс работает)`);
    console.log(`после: B rules=${postB.json.rules.length} history=${postB.json.history.length}; запись-триггер B: ${JSON.stringify((postB.json.history || [])[0] || null)}`);
    console.log(`orderId B в истории B: ${postB.text.includes(ob.json.orderId)}; rb-old-222 в журнале B: ${jb.text.includes('rb-old-222')} (entries=${(jb.json.entries || []).length})`);
    console.log(`register B2 errorCode=${regB2.json && regB2.json.errorCode} (6 = persistent-правило B живо и матчит трафик B)`);
    // NB: register-триггеры в истории ядра не содержат orderId/orderNumber (schema: {at,scenario,source,target});
    // идентичность записи B — её происхождение (rule:sc-1 = правило B). Утечка orderId — грань pay/3ds (P3c), там закрыта.
    const rOk = rst.status === 200 && postA.json.rules.length === 0 && postA.json.history.length === 0
      && (regA2.json && regA2.json.errorCode === 0)
      && postB.json.rules.length === 1 && postB.json.history.length === 1
      && jb.text.includes('rb-old-222')
      && regB2.json && regB2.json.errorCode === 6;
    console.log(`ВЕРДИКТ R: сброс A не задевает B, свой state A очищен: ${rOk ? '✅ ЗАКРЫТО' : '❌ НЕ ЗАКРЫТО'}`);

    /* ---------- Секция L: жизненный цикл ---------- */
    console.log('\n=== L: DELETE /sandboxes/me -> пересоздание тем же id: разделы пусты (нет наследования) ===');
    await ruleP(port, 'l-c');
    await reg(port, 'l-c', 'lc-old-555');
    const jC1 = await journal(port, 'l-c');
    const del = await req(port, 'DELETE', '/sandboxes/me', { headers: { 'X-Mock-Sandbox': 'l-c' } });
    const reReg = await reg(port, 'l-c', 'lc-new-666');
    const scC2 = await scenarios(port, 'l-c');
    const jC2 = await journal(port, 'l-c');
    console.log(`до: journal=${(jC1.json.entries || []).length} (lc-old-555: ${jC1.text.includes('lc-old-555')}); DELETE status=${del.status}; register после пересоздания status=${reReg.status}`);
    console.log(`после пересоздания: rules=${scC2.json.rules.length} history=${scC2.json.history.length}; журнал: entries=${(jC2.json.entries || []).length}, lc-new-666: ${jC2.text.includes('lc-new-666')}, lc-old-555: ${jC2.text.includes('lc-old-555')} (ожидаются 0/0, новый: да, старый: нет)`);
    const lOk = del.status === 200 && reReg.status === 200 && scC2.json.rules.length === 0 && scC2.json.history.length === 0
      && jC2.text.includes('lc-new-666') && !jC2.text.includes('lc-old-555');
    console.log(`ВЕРДИКТ L: пересоздание тем же id без наследования: ${lOk ? '✅' : '❌'}`);

    /* ---------- Секция CAP: лимиты правил ---------- */
    console.log('\n=== CAP: cap 200 правил / 8 KiB -> 400 + code, без новых статусов ===');
    let added = 0;
    for (let i = 0; i < 200; i += 1) {
      const r = await ruleP(port, 'cap-d', { orderNumber: `cap-${i}` });
      if (r.status === 200) added += 1; else { console.log(`неожиданный отказ на правиле #${i + 1}: ${r.status} ${r.text.slice(0, 120)}`); break; }
    }
    const over = await ruleP(port, 'cap-d', { orderNumber: 'cap-201' });
    const big = await ruleP(port, 'cap-d', { pad: 'x'.repeat(9000) });
    const overOk = over.status === 400 && over.json && over.json.code === 'rule_cap_exceeded';
    const bigOk = big.status === 400 && big.json && big.json.code === 'rule_too_large';
    console.log(`добавлено правил: ${added}/200; правило #201: status=${over.status} code=${over.json && over.json.code} ${ok(overOk)}`);
    console.log(`правило ~9 KiB: status=${big.status} code=${big.json && big.json.code} ${ok(bigOk)}; новые статусы не введены (оба 400): ${ok(over.status === 400 && big.status === 400)}`);
    console.log(`ВЕРДИКТ CAP: ${overOk && bigOk && added === 200 ? '✅' : '❌'}`);

    console.log('\n---- ИТОГ extras (волна #52) ----');
    console.log(`R (PG-09 reset-scope): ${rOk ? '✅' : '❌'} | L (lifecycle): ${lOk ? '✅' : '❌'} | CAP (limits): ${overOk && bigOk && added === 200 ? '✅' : '❌'}`);
    console.log('Контроль силы пробы — ДО-код 4d70201: R ❌ (глобальный clear), L ❌ (глобальный реестр), CAP: #201=200, big=200');
  } finally { child.kill('SIGKILL'); }
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
