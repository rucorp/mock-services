#!/usr/bin/env node
// Живые пробы аудита alfa-mock (SZ, параллельно #54). Только 127.0.0.1:0.
// Пробы: P1 утечка кредов в hint; P2 PA-50 (read/reset/import чужой песочницы);
// P3 PA-51 (правила/история сценариев между арендаторами); P4 PA-01 (%-энкод → 500);
// P5 env-парсинг (тихие fallback); P6 SSRF-гард hosted (PF-01 не растиражирован?);
// P7 редакция журнала. Доказательства — stdout этого скрипта.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');

const REPO = require('node:path').resolve(__dirname, '..', '..', '..', '..');
const results = [];
function report(id, title, verdict, evidence) {
  results.push({ id, title, verdict, evidence });
  console.log(`\n=== ${id}: ${title} ===\nВЕРДИКТ: ${verdict}${evidence ? '\n' + evidence : ''}`);
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

function req(port, method, path, { body = null, headers = {}, form = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = form !== null ? new URLSearchParams(form).toString() : (body ? JSON.stringify(body) : null);
    const options = {
      host: '127.0.0.1', port, method, path,
      headers: { ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
      timeout: 5000,
    };
    if (data && form !== null) options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (data && body) options.headers['Content-Type'] = 'application/json';
    const r = http.request(options, (res) => {
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
  // Адаптация 2026-10-13 (после #63, ревизия f6e7cf3e): НЕ снимаем слушатели вывода при обнаружении
  // порта — boot-блок (creds/callbacks/control-plane) печатается СЛЕДУЮЩИМИ console.error-чанками,
  // и ранее снятые слушатели теряли его (гонка чанков; P1-лог/P5/P6 слепли: retry=undefined,
  // session_timeout=undefined, guardOn=false). Слушатели держим до конца процесса, резолвимся с
  // задержкой 300мс, чтобы boot-блок долился в буфер.
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['services/alfa-mock/server.js'], {
      cwd: REPO, env: { ...process.env, MOCK_HOST: '127.0.0.1', MOCK_PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let settled = false;
    const onData = (c) => {
      out += c.toString();
      if (settled) return;
      const m = out.match(/on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        settled = true;
        setTimeout(() => resolve({ child, port: Number(m[1]), log: () => out }), 300);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { if (!settled) reject(new Error(`${label} exited early: ${code}\n${out}`)); });
    setTimeout(() => { if (!settled) reject(new Error(`${label}: порт не найден за 5с\n${out}`)); }, 5000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const children = [];
  try {
    /* ---------- P1: утечка кастомных кредов в hint ошибки errorCode=2 ---------- */
    {
      const { child, port, log } = await startAlfa({
        MOCK_ALFA_USERNAME: 'customuser', MOCK_ALFA_PASSWORD: 'CUSTOM-SECRET-2026', MOCK_ALFA_CALLBACK_SECRET: 'CUSTOM-CB-SECRET',
      }, 'alfa-custom-creds');
      children.push(child);
      await sleep(200);
      const wrongPass = await req(port, 'POST', '/payment/rest/register.do', {
        form: { userName: 'customuser', password: 'totally-wrong', orderNumber: 'p1-a', amount: '1000', returnUrl: 'https://shop.test/ok' },
      });
      const leakedPass = wrongPass.text.includes('CUSTOM-SECRET-2026');
      const wrongUser = await req(port, 'POST', '/payment/rest/register.do', {
        form: { userName: 'nosuchuser', password: 'x', orderNumber: 'p1-b', amount: '1000', returnUrl: 'https://shop.test/ok' },
      });
      const leakedUser = wrongUser.text.includes('customuser');
      const logText = log();
      const logLeak = logText.includes('CUSTOM-SECRET-2026') && logText.includes('customuser');
      report('P1', 'Кастомные креды в hint errorCode=2 (сеть) и в стартовом логе',
        leakedPass && leakedUser ? 'ПОДТВЕРЖДЕНО (blocker/major)' : 'не подтвердилось',
        `password в hint: ${leakedPass}; userName в hint: ${leakedUser}; креды в стартовом логе: ${logLeak}\n` +
        `фрагмент ответа: ${wrongPass.text.slice(0, 400)}`);
    }

    /* ---------- P2/P3: owned-мультиаренда (PA-50, PA-51) ---------- */
    {
      const { child, port } = await startAlfa({ MOCK_TENANCY: 'owned', MOCK_SANDBOX_TOKEN: 'close-default-tok' }, 'alfa-owned');
      children.push(child);
      await sleep(200);
      const mk = await req(port, 'POST', '/sandboxes', { body: {} });
      const mk2 = await req(port, 'POST', '/sandboxes', { body: {} });
      const A = { id: mk.json.id, tok: mk.json.ownerToken, creds: mk.json.creds };
      const B = { id: mk2.json.id, tok: mk2.json.ownerToken, creds: mk2.json.creds };
      console.log(`\n[P2] песочницы: A=${A.id} B=${B.id}`);

      const regB = await req(port, 'POST', '/payment/rest/register.do', {
        form: { userName: B.creds.userName, password: B.creds.password, orderNumber: 'p2-order-B', amount: '7000', returnUrl: 'https://shop.test/b-ok', jsonParams: JSON.stringify({ callback_url: 'http://127.0.0.1:9/hook' }) },
        headers: { 'X-Mock-Sandbox': B.id, 'X-Sandbox-Token': B.tok },
      });
      const orderIdB = regB.json && regB.json.orderId;
      console.log(`[P2] заказ в B: ${orderIdB} (errorCode=${regB.json && regB.json.errorCode})`);

      // P2a: кросс-арендаторское ЧТЕНИЕ state B владельцем A
      const read = await req(port, 'GET', `/mock/state?sandbox=${B.id}`, { headers: { 'X-Mock-Sandbox': A.id, 'X-Sandbox-Token': A.tok } });
      const readOk = read.status === 200 && read.text.includes('p2-order-B');
      report('P2a', 'PA-50: владелец A читает state песочницы B (GET /mock/state?sandbox=B)',
        readOk ? 'ПОДТВЕРЖДЕНО (репликация PA-50)' : 'не подтвердилось',
        `status=${read.status}, заказ B в ответе: ${read.text.includes('p2-order-B')}\nфрагмент: ${read.text.slice(0, 220)}`);

      // P2b: кросс-арендаторское УНИЧТОЖЕНИЕ: POST /mock/reset {sandbox:B} от A
      const reset = await req(port, 'POST', '/mock/reset', { body: { sandbox: B.id }, headers: { 'X-Mock-Sandbox': A.id, 'X-Sandbox-Token': A.tok } });
      const stateB = await req(port, 'GET', '/mock/state', { headers: { 'X-Mock-Sandbox': B.id, 'X-Sandbox-Token': B.tok } });
      const wiped = reset.status === 200 && !stateB.text.includes('p2-order-B');
      report('P2b', 'PA-50: владелец A сбрасывает песочницу B (POST /mock/reset {sandbox:B})',
        wiped ? 'ПОДТВЕРЖДЕНО (репликация PA-50)' : 'не подтвердилось',
        `reset status=${reset.status}; заказ B после reset у B же: ${stateB.text.includes('p2-order-B') ? 'ЕЩЁ ЕСТЬ' : 'уничтожен'}\nreset ответ: ${reset.text.slice(0, 160)}`);

      // P2c: кросс-арендаторская ЗАПИСЬ: import в B от A
      const regB2 = await req(port, 'POST', '/payment/rest/register.do', {
        form: { userName: B.creds.userName, password: B.creds.password, orderNumber: 'p2-order-B2', amount: '5000', returnUrl: 'https://shop.test/b2' },
        headers: { 'X-Mock-Sandbox': B.id, 'X-Sandbox-Token': B.tok },
      });
      const craft = { counters: { callbackId: 999001 }, orders: { 'crafted-by-A': { orderId: 'crafted-by-A', orderNumber: 'A-IMPORT', status: 2, amountK: 1, authorizedK: 1, depositedK: 1, refundedK: 0, createdAtMs: 0, expiresAtMs: 0, createdAt: '', sessionTimeoutSecs: 1, returnUrl: 'https://x', callbackUrl: '', maskPan: null, cardAuthCode: null, tdsApplied: false, authDate: null, depositDate: null, reverseDate: null, refundDate: null, declinedAt: null, pending3ds: null, twoStage: false, currency: 643, actionCode: 0, actionCodeDescription: 'x' } }, orderNumbers: { 'A-IMPORT': 'crafted-by-A' }, callbacks: {}, clockOffsetMs: 0 };
      const imp = await req(port, 'POST', '/mock/state', { body: { sandbox: B.id, state: craft }, headers: { 'X-Mock-Sandbox': A.id, 'X-Sandbox-Token': A.tok, 'Content-Type': 'application/json' } });
      const impOk = imp.status === 200 && imp.text.includes(B.id);
      report('P2c', 'PA-50: владелец A перезаписывает state песочницы B (POST /mock/state {sandbox:B})',
        impOk ? 'ПОДТВЕРЖДЕНО (репликация PA-50)' : 'не подтвердилось',
        `import status=${imp.status}, ответ=${imp.text.slice(0, 120)}; заказ B2 при этом ещё в B (перезаписан): проверка ниже`);
      const stateB2 = await req(port, 'GET', '/mock/state', { headers: { 'X-Mock-Sandbox': B.id, 'X-Sandbox-Token': B.tok } });
      console.log(`[P2c] B после импорта содержит crafted: ${stateB2.text.includes('crafted-by-A')}; заказ B2 сохранился: ${stateB2.text.includes('p2-order-B2')}`);

      // P3: глобальный реестр сценариев между арендаторами
      const rule = await req(port, 'POST', '/mock/scenarios', { body: { scenario: 'fail', target: 'register' }, headers: { 'X-Mock-Sandbox': A.id, 'X-Sandbox-Token': A.tok } });
      const regB3 = await req(port, 'POST', '/payment/rest/register.do', {
        form: { userName: B.creds.userName, password: B.creds.password, orderNumber: 'p3-order-B3', amount: '3000', returnUrl: 'https://shop.test/b3' },
        headers: { 'X-Mock-Sandbox': B.id, 'X-Sandbox-Token': B.tok },
      });
      const ruleFired = regB3.json && regB3.json.errorCode === 6;
      const hist = await req(port, 'GET', '/mock/scenarios', { headers: { 'X-Mock-Sandbox': A.id, 'X-Sandbox-Token': A.tok } });
      const b3leak = hist.text.includes('p3-order-B3');
      report('P3', 'PA-51: правило сценария A срабатывает на трафике B + история A содержит orderNumber B',
        ruleFired || b3leak ? 'ПОДТВЕРЖДЕНО (репликация PA-51)' : 'не подтвердилось',
        `правило A target=register: ${rule.status}; register B3 errorCode=${regB3.json && regB3.json.errorCode} (6 = правило A сработало); orderNumber B3 в истории A: ${b3leak}`);
    }

    /* ---------- P4: битый %-энкод → 500 (PA-01) ---------- */
    {
      const { child, port } = await startAlfa({}, 'alfa-p4');
      children.push(child);
      await sleep(200);
      const r = await req(port, 'POST', '/payment/rest/register.do', {
        body: null, form: null, headers: {},
      }).catch(() => null);
      // сырой form с %zz через низкоуровневый запрос
      const raw = await new Promise((resolve, reject) => {
        const data = 'a=%zz&b=1';
        const rq = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/payment/rest/register.do', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
          let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, text: b }));
        });
        rq.on('error', reject); rq.write(data); rq.end();
      });
      report('P4', 'PA-01: битый %-энкод формы → 500 вместо 400',
        raw.status === 500 ? 'ПОДТВЕРЖДЕНО (унаследовано из core)' : `не подтвердилось (status=${raw.status})`,
        `status=${raw.status}, тело: ${raw.text.slice(0, 160)}`);
    }

    /* ---------- P5: env-парсинг (тихие fallback) ---------- */
    {
      const { child, port, log } = await startAlfa({ MOCK_CALLBACK_RETRY_MS: '1h', MOCK_SESSION_TIMEOUT_SECS: '0' }, 'alfa-p5');
      children.push(child);
      await sleep(200);
      const t = log();
      const retryLine = (t.match(/retry (\d+)ms/) || [])[1];
      const timeoutLine = (t.match(/session_timeout=(\d+)s/) || [])[1];
      // PG-05 ≡ PB-11 (до #58): '1h' тихо → parseInt=1 → Math.max(1000,1)=1000мс (не 3600000),
      // '0' без семантики тихо → 1200; WARN нет. После #58 ожидание инвертируется (WARN или честный парс).
      report('P5', 'env-парсинг: MOCK_CALLBACK_RETRY_MS=1h и MOCK_SESSION_TIMEOUT_SECS=0 (тихий fallback)',
        retryLine === '1000' && timeoutLine === '1200' ? 'ПОДТВЕРЖДЕНО (класс MS-08/PB-03/PF-03: тихий миспарс)' : 'не подтвердилось',
        `retry=${retryLine}ms (дефект PG-05: '1h' → 1000мс, а не 3600000), session_timeout=${timeoutLine}s ('0' тихо → 1200)`);
    }

    /* ---------- P6: SSRF-гард callback в hosted (PF-01 не растиражирован?) ---------- */
    {
      const recvPort = await freePort();
      let hits = 0;
      const recv = http.createServer((rq, rs) => { hits += 1; rs.writeHead(200); rs.end('ok'); });
      await new Promise((r) => recv.listen(recvPort, '127.0.0.1', r));
      const { child, port, log } = await startAlfa({
        MOCK_HOSTED: '1', MOCK_TENANCY: 'namespaces',
        MOCK_DEFAULT_CALLBACK_URL: `http://127.0.0.1:${recvPort}/hook`,
      }, 'alfa-hosted');
      children.push(child);
      await sleep(200);
      const bl = log();
      const guardOn = /block_private_webhooks=true/.test(bl);
      const o1 = await req(port, 'POST', '/payment/rest/register.do', {
        form: { userName: 'ALFAMOCKTEST', password: 'mockpass123', orderNumber: 'p6-direct', amount: '1000', returnUrl: 'https://shop.test/x' },
        headers: { 'X-Mock-Sandbox': 'p6a' },
      });
      await sleep(2500); // очередь тикает раз в секунду
      const directHits = hits;
      const o2 = await req(port, 'POST', '/payment/rest/register.do', {
        form: { userName: 'ALFAMOCKTEST', password: 'mockpass123', orderNumber: 'p6-mapped', amount: '1000', returnUrl: 'https://shop.test/x', jsonParams: JSON.stringify({ callback_url: `http://[::ffff:127.0.0.1]:${recvPort}/mapped` }) },
        headers: { 'X-Mock-Sandbox': 'p6b' },
      });
      await sleep(2500);
      recv.close();
      report('P6', 'SSRF-гард callback в hosted: приватные цели (127.0.0.1 и mapped-IPv6) не доставляются',
        guardOn && directHits === 0 && hits === 0 ? 'ПОДТВЕРЖДЕНО: PF-01 в альфe НЕ растиражирован (гард включён)' : `ТРЕБУЕТ ВНИМАНИЯ: guardOn=${guardOn}, доставок=${hits}`,
        `block_private_webhooks=${guardOn}; register p6-direct errorCode=${o1.json && o1.json.errorCode}; register p6-mapped errorCode=${o2.json && o2.json.errorCode}; доставок на приватный приёмник: ${hits} (ожидалось 0)`);
    }

    /* ---------- P7: редакция журнала (позитив) ---------- */
    {
      const { child, port } = await startAlfa({}, 'alfa-p7');
      children.push(child);
      await sleep(200);
      await req(port, 'POST', '/payment/rest/register.do', {
        form: { userName: 'ALFAMOCKTEST', password: 'mockpass123', orderNumber: 'p7-j', amount: '1000', returnUrl: 'https://shop.test/j' },
      });
      const j = await req(port, 'GET', '/admin/journal');
      const entry = j.json && j.json.entries && j.json.entries.find((e) => e.path && e.path.endsWith('register.do'));
      const passMasked = entry && entry.body && (entry.body.password === '[REDACTED]' || !/mockpass123/.test(JSON.stringify(entry.body)));
      report('P7', 'Журнал /admin/journal не содержит password (позитивная проверка ядра)',
        passMasked ? 'ПОДТВЕРЖДЕНО: редакция работает' : 'ТРЕБУЕТ ВНИМАНИЯ',
        `body журнала: ${JSON.stringify(entry && entry.body).slice(0, 220)}`);
    }
  } catch (e) {
    console.error('ОШИБКА ПРОБЫ:', e.message);
  } finally {
    for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  }
  console.log('\n===== СВОДКА =====');
  for (const r of results) console.log(`${r.verdict.startsWith('ПОДТВЕРЖДЕНО') ? '[+]' : r.verdict.includes('ВНИМАНИЯ') ? '[!]' : '[-]'} ${r.id}: ${r.title} → ${r.verdict}`);
})();
