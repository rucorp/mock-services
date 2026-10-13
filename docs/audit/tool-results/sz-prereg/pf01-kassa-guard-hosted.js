#!/usr/bin/env node
// [sz/#64 · PF-01] SSRF-гард кассы мёртв в MOCK_HOSTED=1.
// Claim дельты #54: kassa-mock/server.js:50 — дефолт-ЛИТЕРАЛ
// MOCK_BLOCK_PRIVATE_WEBHOOKS='false' -> flagEnabled('false', HOSTED)=false ВСЕГДА,
// включая hosted; README кассы (:122) при этом обещает «в MOCK_HOSTED=1 — true».
// Selftest кассы проверяет гард только при явном =1 (selftest.js:729-729) —
// hosted-дефолт не покрыт. Проба: hosted БЕЗ переопределений — callback уходит
// на 127.0.0.1 (доставлен); контроль с явным =1 — ERR SSRF. «До»-проба волны #51.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
function report(id, title, verdict, evidence) {
  console.log(`\n=== ${id}: ${title} ===\nВЕРДИКТ: ${verdict}${evidence ? '\n' + evidence : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(port, method, p, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...(data ? { 'Content-Length': Buffer.byteLength(data), 'Content-Type': 'application/json' } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, timeout: 6000 }, (res) => {
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

function startKassa(env, label) {
  return new Promise((resolve, reject) => {
    // Важно: переменные с пустыми значениями НЕ пробрасываем — kassa-дефолт
    // MOCK_BLOCK_PRIVATE_WEBHOOKS='false' срабатывает только при НЕЗАДАННОЙ переменной,
    // а это и есть кейс PF-01 (compose/стенд не определяет переменную вовсе).
    const base = { ...process.env };
    for (const k of ['MOCK_HOSTED', 'MOCK_BLOCK_PRIVATE_WEBHOOKS', 'MOCK_TENANCY', 'MOCK_SANDBOX_TOKEN', 'MOCK_ADMIN_TOKEN', 'MOCK_OPERATOR_TOKEN']) delete base[k];
    const child = spawn('node', ['services/kassa-mock/server.js'], {
      cwd: REPO, env: {
        ...base,
        MOCK_HOST: '127.0.0.1', MOCK_PORT: '0', MOCK_STATE_FILE: '',
        MOCK_PROCESS_MS: '0', MOCK_CALLBACK_RETRY_MS: '1000',
        ...env,
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let done = false;
    const onData = (c) => {
      out += c.toString();
      if (done) return;
      const m = out.match(/on 127\.0\.0\.1:(\d+)/);
      if (m) { done = true; resolve({ child, port: Number(m[1]), log: () => out }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`${label} exited early: ${code}\n${out}`)));
    setTimeout(() => { if (!done) reject(new Error(`${label}: порт не найден за 5с\n${out}`)); }, 5000);
  });
}

const sellBody = (extId, callbackUrl) => ({
  external_id: extId,
  receipt: {
    client: { email: 'a@b.c' },
    items: [{ name: 'X', price: 100, quantity: 1, sum: 100, vat: { type: 'none' } }],
    payments: [{ type: 1, sum: 100 }],
    total: 100,
    receipts: { service: { callback_url: callbackUrl } },
  },
});

async function waitFor(fn, timeoutMs, desc) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timeout: ${desc}`);
}

async function getToken(port) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const r = await req(port, 'POST', '/possystem/v1/getToken', { body: { login: 'loviitest', pass: 'mockpass123' } });
    if (r.json && r.json.token) return r.json.token;
    if (attempt < 4) await sleep(400); // стартовая гонка: сразу после listen возможен не-JSON ответ
  }
  throw new Error('getToken не вернул токен за 4 попытки');
}

(async () => {
  /* ---- Статика: README против кода ---- */
  const kassaCode = require('fs').readFileSync(path.join(REPO, 'services', 'kassa-mock', 'server.js'), 'utf8').split('\n');
  const envLine = kassaCode.findIndex((l) => l.includes("MOCK_BLOCK_PRIVATE_WEBHOOKS = 'false'")) + 1;
  const flagLine = kassaCode.findIndex((l) => l.includes('flagEnabled(MOCK_BLOCK_PRIVATE_WEBHOOKS, HOSTED)')) + 1;
  // Адаптация 2026-10-13 (волна #51, head PR #68): флип-логика — на исправленном дереве литерал 'false' отсутствует.
  const literalGone = envLine <= 0;
  report('PF-01a', 'статика: дефолт-литерал \'false\' убивает HOSTED-дефолт; README обещает true',
    literalGone ? 'ЗАКРЫТО (статика: дефолт-литерал \'false\' отсутствует — дефолт выровнен с остальными сервисами)' : 'ПОДТВЕРЖДЕНО (факты кода)',
    literalGone
      ? `server.js: MOCK_BLOCK_PRIVATE_WEBHOOKS = 'false' не найден (фикс волны #51: дефолт '' + core.defaultBlockPrivateHosts)\n` +
        (flagLine > 0 ? `server.js:${flagLine}: flagEnabled(MOCK_BLOCK_PRIVATE_WEBHOOKS, HOSTED) — hosted-дефолт применяется` : '')
      : `server.js:${envLine}: MOCK_BLOCK_PRIVATE_WEBHOOKS = 'false' (литерал, не пустая строка)\n` +
        `server.js:${flagLine}: flagEnabled('false', HOSTED) -> false всегда (значение передано — дефолт-параметр не применяется)\n` +
        `README.md:122 обещает: «false (в MOCK_HOSTED=1 — true)» — код это обещание не выполняет`);

  /* ---- Фаза 1: hosted БЕЗ переопределений -> callback доставлен на 127.0.0.1 ---- */
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200); res.end('{"data":{"status":"confirmed"}}'); });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const fixPort = srv.address().port;

  const a = await startKassa({ MOCK_HOSTED: '1' }, 'kassa-pf01-hosted');
  try {
    await sleep(150);
    const flagInLog = /hosted=true block_private_webhooks=false/.test(a.log());
    const tk = await getToken(a.port);
    const sell = await req(a.port, 'POST', `/possystem/v1/Main/sell?token=${tk}`, { body: sellBody('pf01-hosted-1', `http://127.0.0.1:${fixPort}/callback`) });
    if (!sell.json || sell.json.error) console.log(`[info] sell: status=${sell.status} body=${sell.text.slice(0, 300)}`);
    // Адаптация 2026-10-13 (волна #51): таймаут доставки — не падение, а «после»-поведение; идём дальше в контроль.
    let delivered = false;
    try {
      await waitFor(async () => hits.length > 0, 6000, 'доставка callback в hosted-режиме');
      delivered = true;
    } catch (e) {
      console.log(`[info] доставка не дождались (ожидаемо после #68 — гард режет loopback). Лог kassa (хвост):\n${a.log().split('\n').slice(-8).join('\n')}`);
    }
    const guardTrue = /hosted=true block_private_webhooks=true/.test(a.log());
    const ssrfInLog = /SSRF/i.test(a.log());
    report('PF-01b', 'MOCK_HOSTED=1 (без переопределений): callback кассы ДОСТАВЛЕН на 127.0.0.1',
      delivered && flagInLog && sell.status === 200 ? 'ПОДТВЕРЖДЕНО (гард мёртв в hosted)'
        : (!delivered && guardTrue && ssrfInLog ? 'ЗАКРЫТО (hosted-дефолт true: доставка на loopback блокирована SSRF-политикой)' : 'не подтвердилось'),
      `стартовый лог: block_private_webhooks=false при hosted=true: ${flagInLog}; block_private_webhooks=true: ${guardTrue}\n` +
      `sell: status=${sell.status}, uuid=${(sell.json || {}).uuid}; доставок на loopback-приёмник: ${hits.length} (после фикса: 0, ERR SSRF)`);

    /* ---- Фаза 2: контроль — явный =1 в hosted: блок SSRF ---- */
    const b = await startKassa({ MOCK_HOSTED: '1', MOCK_BLOCK_PRIVATE_WEBHOOKS: '1', MOCK_ADMIN_TOKEN: 'sz-admin' }, 'kassa-pf01-ctl');
    try {
      await sleep(150);
      const hitsBefore = hits.length;
      const tk2 = await getToken(b.port);
      const sell2 = await req(b.port, 'POST', `/possystem/v1/Main/sell?token=${tk2}`, { body: sellBody('pf01-ctl-1', `http://127.0.0.1:${fixPort}/callback`) });
      await sleep(2500);
      let lastStatus = '';
      try {
        const st = await req(b.port, 'GET', '/mock/state', { headers: { Authorization: 'Bearer sz-admin', 'X-Admin-Token': 'sz-admin' } });
        const s = (st.json && (st.json.state || st.json)) || {};
        const cb = Object.values(s.callbacks || {})[0];
        if (cb) lastStatus = String(cb.lastStatus);
      } catch {}
      const blocked = hits.length === hitsBefore && /SSRF/i.test(lastStatus);
      report('PF-01c', 'контроль: явный MOCK_BLOCK_PRIVATE_WEBHOOKS=1 в hosted -> ERR SSRF, доставок нет',
        blocked ? 'ПОДТВЕРЖДЕНО (механизм гарда работает — сломан именно дефолт)' : 'не подтвердилось',
        `sell: status=${sell2.status}; новых доставок: ${hits.length - hitsBefore}; lastStatus callback: ${lastStatus.slice(0, 90)}`);
    } finally {
      try { b.child.kill(); } catch {}
    }

    console.log('\n---- ИТОГ PF-01 ----');
    console.log('До фикса (#51): в MOCK_HOSTED=1 SSRF-гард кассы выключен дефолт-литералом; callback по умолчанию уходит на приватные адреса.');
    console.log('Ожидание после фикса (предрегистрация): hosted-старт кассы пишет block_private_webhooks=true; та же проба — доставок 0, lastStatus ERR SSRF; selftest кассы покрывает hosted-дефолт.');
  } finally {
    try { a.child.kill(); } catch {}
    srv.close();
  }
})().catch((e) => { console.error('ПРОБА УПАЛА:', e.message); process.exit(2); });
