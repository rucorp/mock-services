#!/usr/bin/env node
// [sz/#64 · PD-02] Write-амплификация persist + квота в документах вместо байтов.
// Claim дельты #54 (core): каждая мутация любой песочницы перезаписывает ВЕСЬ
// реестр (flushRegistry -> writeFileSync полного payload, core:2054-2068) —
// O(состояние всех песочниц) на каждую мутацию; квота документов не считает
// байты (тело запроса до 5 МБ) -> раздувание файла/OOM при mem_limit 128m.
// Фазы: (1) in-process учёт байтов flushRegistry; (2) контроль малых состояний;
// (3) live-альфа: 2 «документа» = 2 МБ в реестре. «До»-проба волны #53.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const core = require(path.join(REPO, 'packages', 'core', 'index.js'));
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
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, timeout: 8000 }, (res) => {
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

const MB = 1024 * 1024;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sz-pd02-'));
  const children = [];
  try {
    /* ---- Фаза 1: in-process — 3 песочницы по ~1 МБ, 5 мелких мутаций одной ---- */
    const regFile = path.join(tmp, 'registry.json');
    const writes = [];
    const origWrite = fs.writeFileSync;
    fs.writeFileSync = function (p, data, ...rest) {
      if (String(p).startsWith(regFile)) writes.push({ bytes: Buffer.byteLength(data) }); // flushRegistry пишет в regFile.tmp + rename
      return origWrite.call(fs, p, data, ...rest);
    };

    let runtime;
    try {
      runtime = core.createSandboxRuntime({
        state: { callbacks: {} },
        mode: 'owned',
        sandboxFile: regFile,
        initialStateFactory: () => ({ callbacks: {}, orders: {} }),
        documentCounter: (st) => Object.keys(st.orders || {}).length,
        maxDocuments: 2,
        saveDelayMs: 10,
        log: () => {},
      });

      for (const id of ['pd-a', 'pd-b', 'pd-c']) {
        runtime.create({ id });
        runtime.importState({ state: { orders: { d1: { blob: 'x'.repeat(MB) } } } }, id);
      }
      const sizeAfterImports = fs.statSync(regFile).size;

      const recB = runtime.find('pd-b');
      const docsB = runtime.documents ? runtime.documents(recB) : Object.keys(recB.state.orders || {}).length;
      report('PD-02b', 'квота считает документы, байты не ограничены: 1 документ = ~1 МБ проходит',
        docsB === 1 && sizeAfterImports >= 3 * MB * 0.9 ? 'ПОДТВЕРЖДЕНО (байтовая квота отсутствует)' : 'не подтвердилось',
        `pd-b: документов=${docsB} (лимит 2), унесла в общий реестр ~1 МБ; реестр после 3 импортов: ${Math.round(sizeAfterImports / MB * 10) / 10} МБ — ни один предел по байтам не сработал`);

      writes.length = 0;
      for (let k = 1; k <= 5; k += 1) {
        runtime.importState({ state: { orders: { [`k${k}`]: { small: `mut-${k}` } } } }, 'pd-a');
      }
      const totalWritten = writes.reduce((s, w) => s + w.bytes, 0);
      const finalSize = fs.statSync(regFile).size;
      const amplification = totalWritten / Math.max(1, finalSize);

      report('PD-02a', '5 мелких мутаций ОДНОЙ песочницы -> 5 полных перезаписей всего реестра',
        writes.length === 5 && amplification > 4 ? 'ПОДТВЕРЖДЕНО (амплификация ×N песочниц)' : 'не подтвердилось',
        `реестр до мутаций: ${Math.round(sizeAfterImports / MB * 10) / 10} МБ; мутации: 5 × ~200 байт в pd-a
` +
        `записей flush-а: ${writes.length}; суммарно записано: ${Math.round(totalWritten / MB * 10) / 10} МБ при итоговом файле ${Math.round(finalSize / MB * 10) / 10} МБ
` +
        `коэффициент амплификации: ×${amplification.toFixed(1)} (каждая мелкая мутация переписывает состояние ВСЕХ песочниц)`);
    } finally {
      fs.writeFileSync = origWrite;
    }

    /* ---- Фаза 2: live-альфа — 2 «документа» = 2 МБ в файле реестра ---- */
    const regFile2 = path.join(tmp, 'alfa-registry.json');
    const { child, port } = await startAlfa({
      MOCK_TENANCY: 'owned',
      MOCK_SANDBOX_TOKEN: 'close-default-sz-pd02',
      MOCK_SANDBOX_MAX_DOCUMENTS: '2',
      MOCK_SANDBOX_FILE: regFile2,
    }, 'alfa-pd02');
    children.push(child);
    await sleep(150);

    const mk = await req(port, 'POST', '/sandboxes', { body: {} });
    const A = { id: mk.json.id, tok: mk.json.ownerToken, creds: mk.json.creds };
    const AH = { 'X-Mock-Sandbox': A.id, 'X-Sandbox-Token': A.tok };
    const bigImport = await req(port, 'POST', '/mock/state', {
      body: { sandbox: A.id, state: { orders: { o1: { blob: 'y'.repeat(MB) }, o2: { blob: 'z'.repeat(MB) } }, orderNumbers: {}, callbacks: {} } },
      headers: AH,
    });
    const regSize = fs.existsSync(regFile2) ? fs.statSync(regFile2).size : 0;
    const back = await req(port, 'GET', '/mock/state?sandbox=' + A.id, { headers: AH });
    const persisted = back.text.length >= 2 * MB;

    const regAttempt = await req(port, 'POST', '/payment/rest/register.do', {
      form: { userName: A.creds.userName, password: A.creds.password, orderNumber: 'pd02-blocked', amount: '1000', returnUrl: 'https://shop.test/ok' },
      headers: AH,
    });
    const quotaBlocked = regAttempt.json && regAttempt.json.errorCode !== 0 && /MAX_DOCUMENTS/.test(regAttempt.text);

    report('PD-02c', 'live-альфа: импорт 2 документов = 2 МБ принят (квота документов), register при этом заблокирован',
      bigImport.status === 200 && regSize >= 2 * MB && quotaBlocked ? 'ПОДТВЕРЖДЕНО' : 'не подтвердилось',
      `POST /mock/state (2 заказа × 1 МБ): status=${bigImport.status}; файл реестра: ${Math.round(regSize / MB * 10) / 10} МБ; состояние читается обратно с blob-ами: ${persisted}\n` +
      `register №3 (3-й документ): errorCode=${regAttempt.json && regAttempt.json.errorCode} — квота в ДОКУМЕНТАХ сработала, но 2 МБ уже в файле: байтового предела нет`);

    console.log('\n---- ИТОГ PD-02 ----');
    console.log('До фикса (#53): полный реестр перезаписывается на каждую мутацию (×N песочниц), байтовая квота состояния отсутствует.');
    console.log('Ожидание после фикса (предрегистрация): K мелких мутаций пишут O(K×Δ), а не O(K×весь реестр); импорт/состояние ограничены байтовой квотой (413/422), 2 МБ через 2 документа не проходят.');
  } finally {
    for (const c of children) { try { c.kill(); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error('ПРОБА УПАЛА:', e.message); process.exit(2); });
