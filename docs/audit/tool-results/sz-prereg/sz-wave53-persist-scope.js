#!/usr/bin/env node
// [sz/#62 · волна #53] Точечная проба PD-02 (#72) v3 — финал:
//   S (scope): per-file персист мутаций (ожидание 1200мс > debounce 150мс; SIGTERM-гонка исключена).
//   M (migration): legacy-реестр ДО-кода (с заказом!) -> .migrated + records, заказ переживает миграцию.
//   Q (quota): core-уровень, maxStateBytes малый — импорт сверх лимита: SANDBOX_QUOTA_BYTES + откат + сосед цел.
// NB: HTTP-путь переполнения 8МиБ недостижим (кап тела 5МиБ) — квота на HTTP-уровне покрыта самотестом #72; тут — независимый core-репрод.
// Запуск: SZ_REPO=<e8d9f93> SZ_BEFORE_REPO=<4d70201> node sz-wave53-persist-scope.js
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AFTER = process.env.SZ_REPO;
const BEFORE = process.env.SZ_BEFORE_REPO;

function req(port, method, p, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) { h['Content-Length'] = Buffer.byteLength(data); h['Content-Type'] = 'application/json'; }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, timeout: 30000 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, text: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
    });
    r.on('error', reject);
    if (data) r.write(data); r.end();
  });
}
async function startServer(repo, stateFile) {
  const child = spawn('node', ['services/alfa-mock/server.js'], {
    cwd: repo, env: { ...process.env, MOCK_HOST: '127.0.0.1', MOCK_PORT: '0', MOCK_TENANCY: 'namespaces', MOCK_STATE_FILE: stateFile, MOCK_SANDBOX_MAX_DOCUMENTS: '5000' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  let port = null;
  for (let i = 0; i < 200 && !port; i += 1) { await sleep(50); const m = out.match(/on http:\/\/127\.0\.0\.1:(\d+)/); if (m) port = Number(m[1]); }
  if (!port) { child.kill('SIGKILL'); throw new Error('порт не получен'); }
  return { child, port };
}
const stop = async (child) => { child.kill('SIGTERM'); await sleep(300); try { child.kill('SIGKILL'); } catch {} await sleep(200); };
const regForm = (port, sbx, order) => fetch(`http://127.0.0.1:${port}/payment/rest/register.do`, {
  method: 'POST', headers: { 'X-Mock-Sandbox': sbx, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ userName: 'ALFAMOCKTEST', password: 'mockpass123', orderNumber: order, amount: '1000', returnUrl: 'https://x/' + order }).toString(),
});
const recordsDirOf = (sf) => path.join(path.dirname(sf), `${path.basename(sf)}.sandboxes.records`);
const sizeOf = (p) => (fs.existsSync(p) ? fs.statSync(p).size : -1);

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sz-w53v3-'));
  const stateFile = path.join(tmp, 'state.json');

  /* ---------- S: per-file scope ---------- */
  console.log(`=== S: мутации пишут только свой <id>.json (state=${path.basename(stateFile)}) ===`);
  let s = await startServer(AFTER, stateFile);
  const regA = await regForm(s.port, 'sa', 'sa-order-1');
  const regB = await regForm(s.port, 'sb', 'sb-order-1');
  await sleep(1200); // debounce 150мс — с запасом
  await stop(s.child);
  const rdir = recordsDirOf(stateFile);
  const files = fs.existsSync(rdir) ? fs.readdirSync(rdir).sort() : [];
  const fa = path.join(rdir, 'sa.json'); const fb = path.join(rdir, 'sb.json');
  const cA = fs.readFileSync(fa, 'utf8'); const cB = fs.readFileSync(fb, 'utf8');
  const jA = JSON.parse(cA); const jB = JSON.parse(cB);
  const isoA = Object.keys(jA.sandbox.state.orders).length;
  const isoB = Object.keys(jB.sandbox.state.orders).length;
  const noSingle = !fs.existsSync(stateFile);
  console.log(`register A=${regA.status} B=${regB.status}; records: [${files.join(', ')}]`);
  console.log(`A: заказов=${isoA}, содержит sa-order-1=${cA.includes('sa-order-1')}, содержит sb-order-1=${cA.includes('sb-order-1')}`);
  console.log(`B: заказов=${isoB}, содержит sb-order-1=${cB.includes('sb-order-1')}, содержит sa-order-1=${cB.includes('sa-order-1')}; единый state-файл не создан=${noSingle}`);
  const aBytes0 = sizeOf(fa);
  s = await startServer(AFTER, stateFile);
  const regB2 = await regForm(s.port, 'sb', 'sb-order-2');
  await sleep(1200);
  await stop(s.child);
  const aBytes1 = sizeOf(fa);
  const cB2 = fs.readFileSync(fb, 'utf8');
  const sOk = files.length === 2 && isoA === 1 && isoB === 1
    && cA.includes('sa-order-1') && !cA.includes('sb-order-1')
    && cB.includes('sb-order-1') && !cB.includes('sa-order-1') && noSingle
    && regA.status === 200 && regB.status === 200 && regB2.status === 200
    && aBytes1 === aBytes0 && cB2.includes('sb-order-2') && !cB2.includes('sa-order-1');
  console.log(`рестарт + мутация B: файл A байт ${aBytes0} -> ${aBytes1} (не тронут: ${aBytes1 === aBytes0}); B получил sb-order-2=${cB2.includes('sb-order-2')}`);
  console.log(`ВЕРДИКТ S: ${sOk ? '✅' : '❌'}`);

  /* ---------- M: миграция legacy с бизнес-данными ---------- */
  console.log('\n=== M: legacy-реестр (ДО-код, с заказом) -> .migrated + records (ПОСЛЕ-код) ===');
  const legacyFile = path.join(tmp, 'legacy.json');
  const lb = await startServer(BEFORE, legacyFile);
  await regForm(lb.port, 'legacy-sbx', 'legacy-order-1');
  await sleep(1200);
  await stop(lb.child);
  const legacyReg = `${legacyFile}.sandboxes.json`;
  const legacyHadOrder = fs.existsSync(legacyReg) && fs.readFileSync(legacyReg, 'utf8').includes('legacy-order-1');
  const la = await startServer(AFTER, legacyFile);
  await sleep(300);
  const stLegacy = await req(la.port, 'GET', '/mock/state', { headers: { 'X-Mock-Sandbox': 'legacy-sbx' } });
  await stop(la.child);
  const migrated = fs.existsSync(`${legacyReg}.migrated`);
  const legacyRecords = fs.existsSync(recordsDirOf(legacyFile)) ? fs.readdirSync(recordsDirOf(legacyFile)).sort() : [];
  const recPath = path.join(recordsDirOf(legacyFile), 'legacy-sbx.json');
  const recHasOrder = fs.existsSync(recPath) && fs.readFileSync(recPath, 'utf8').includes('legacy-order-1');
  const mOk = legacyHadOrder && migrated && legacyRecords.includes('legacy-sbx.json') && recHasOrder
    && stLegacy.status === 200 && stLegacy.text.includes('legacy-order-1');
  console.log(`ДО-код записал legacy-реестр с заказом: ${legacyHadOrder}; ПОСЛЕ-код: .migrated=${migrated}, records=[${legacyRecords.join(', ')}]`);
  console.log(`заказ в записи legacy-sbx.json: ${recHasOrder}; GET /mock/state: ${stLegacy.status}, заказ читается=${stLegacy.text.includes('legacy-order-1')}`);
  console.log(`ВЕРДИКТ M: ${mOk ? '✅' : '❌'}`);

  /* ---------- Q: квота на core-уровне (независимый репрод) ---------- */
  console.log('\n=== Q: core createSandboxRuntime, maxStateBytes=2000: переполнение -> SANDBOX_QUOTA_BYTES + откат ===');
  const core = require(path.join(AFTER, 'packages', 'core', 'index.js'));
  const qTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sz-q-core-'));
  const rt = core.createSandboxRuntime({
    state: { counters: {}, orders: {}, orderNumbers: {}, callbacks: {}, clockOffsetMs: 0 },
    persist: () => {},
    mode: 'namespaces',
    stateFile: path.join(qTmp, 'core-state.json'),
    maxStateBytes: 2000,
    log: () => {},
  });
  const mk = (i, pad) => ({ counters: {}, orders: { [`o-${i}`]: { orderId: `o-${i}`, orderNumber: `o-${i}`, status: 2, note: 'x'.repeat(pad) } }, orderNumbers: {}, callbacks: {}, clockOffsetMs: 0 });
  const imp = (sbx, st) => { try { const r = rt.importState({ state: st }, sbx); return { ok: r.ok === true, error: r.error || '' }; } catch (e) { return { ok: false, error: `${e.code || ''}: ${e.message.slice(0, 90)}` }; } };
  const imp1 = imp('qa', mk(1, 300));                       // ~400Б < 2000 — ок
  const qaFile = path.join(qTmp, 'core-state.json.sandboxes.records', 'qa.json');
  const qbFile = path.join(qTmp, 'core-state.json.sandboxes.records', 'qb.json');
  const impB = imp('qb', mk(2, 300));                       // сосед — ок
  const qa0 = sizeOf(qaFile);
  const imp2 = imp('qa', mk(3, 5000));                      // ~5.2КБ > 2000 — отказ+откат
  const qaState = JSON.stringify(rt.find('qa').state);
  const qa1 = sizeOf(qaFile);
  const qOk = imp1.ok && impB.ok && !imp2.ok && /SANDBOX_QUOTA_BYTES/.test(imp2.error)
    && qaState.includes('"o-1"') && !qaState.includes('"o-3"') && qaState.length < 1500
    && qa1 === qa0 && sizeOf(qbFile) > 0;
  console.log(`импорт малого: ok=${imp1.ok}; импорт соседа: ok=${impB.ok}; импорт сверх квоты: ok=${imp2.ok}, error=${imp2.error}`);
  console.log(`откат: state qa содержит o-1=${qaState.includes('"o-1"')}, НЕ содержит o-3=${!qaState.includes('"o-3"')}; файл qa байт ${qa0} -> ${qa1} (отказ не записан: ${qa1 === qa0}); файл qb существует=${sizeOf(qbFile) > 0}`);
  console.log(`ВЕРДИКТ Q: ${qOk ? '✅' : '❌'}`);

  console.log('\n---- ИТОГ sz-wave53-persist-scope v3 (PD-02) ----');
  console.log(`S (scope): ${sOk ? '✅' : '❌'} | M (migration): ${mOk ? '✅' : '❌'} | Q (quota core): ${qOk ? '✅' : '❌'}`);
  console.log('Примечания: debounce персиста 150мс существовал и ДО #72 (4d70201:2000); нет SIGTERM-хендлера — мутации последнего окна <150мс теряются при жёстком kill (ИНФО, вне скоупа волны).');
  console.log(`tmpdir: ${tmp}`);
  process.exitCode = (sOk && mOk && qOk) ? 0 : 1;
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
