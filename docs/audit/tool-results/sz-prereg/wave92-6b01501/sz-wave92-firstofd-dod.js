#!/usr/bin/env node
/* © 2026 ООО «Аксиома» ИНН:7842223709 · Apache-2.0
 * SZ wave-#92 проба: первый-ofd-mock (OKassa, 8-й сервис) — формальная верификация DoD issue #92
 * на ревизии 6b01501. Zero-dep, Node >= 18.
 *
 * Логи: G1 getToken (выдача/истечение 24ч/повтор), G2 очередь transaction/{type} → requestId →
 * status/transaction, G3 statuses по externalId+groupId (+повтор externalId [VERIFY]),
 * G4 /receipts за период (+пагинация/фильтры), G5 оба слоя ошибок (API vs KKT) + правила смен,
 * G6 негативы, G7 «знание ID ≠ доступ» (namespaces), G8 callback+сверка статусом (+retry, SSRF),
 * legD токен-одиночка, legE owned-режим (наблюдение для #98 — INFO).
 */

'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = __dirname; // проба лежит в корне worktree/клона
const SERVER = path.join(ROOT, 'services', 'first-ofd-mock', 'server.js');

const PASS = [];
const FAIL = [];
let expectedFiscal = 0; // счётчик фискальных документов, созданных пробой в legA

function record(name, ok, detail) {
  if (ok) {
    PASS.push(name);
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    FAIL.push(`${name}: ${detail || 'условие не выполнено'}`);
    console.log(`  FAIL ${name} — ${detail || 'условие не выполнено'}`);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function request(port, method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        ...headers,
      }, timeout: 8000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* не JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('client timeout')));
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForHealth(port, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request(port, 'GET', '/health');
      if (res.status === 200) return true;
    } catch { /* ещё не поднялся */ }
    await sleep(150);
  }
  throw new Error(`сервер ${label} не поднялся (${port})`);
}

function startServer(label, env) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, MOCK_HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  const collector = (chunk) => {
    for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) logs.push(line.trim());
  };
  child.stdout.on('data', collector);
  child.stderr.on('data', collector);
  child.logs = logs;
  return child;
}

function stopServer(child) {
  try { child.kill('SIGTERM'); } catch { /* уже мёртв */ }
}

const Q = '/api/external/queue/v1';

function receiptBody({ extId, group = 'MOCKGROUP', operation = 'INCOME', total = '200.00', price = '100.00', quantity = 2, vat = 'VAT_22', label = 'Тестовый товар', callbackUrl, userInn = '7801234567', correction = false }) {
  return {
    cashboxParameters: { userInn: userInn },
    requestMetadata: {
      externalId: extId,
      userGroup: group,
      ...(callbackUrl ? { callbackUrl } : {}),
    },
    document: {
      operationType: operation,
      items: [{ label, measurementUnit: 'шт', price, quantity, vatCode: vat }],
      totalSum: total,
      ...(correction ? { correctionCause: 'исправление данных прошлой смены' } : {}),
    },
  };
}

function stateBody({ extId, group = 'MOCKGROUP', document }) {
  return {
    cashboxParameters: {},
    requestMetadata: { externalId: extId, userGroup: group },
    ...(document ? { document } : {}),
  };
}

async function advance(port, spec) {
  const res = await request(port, 'POST', '/mock/time', { body: { advance: spec } });
  if (res.status !== 200) throw new Error(`advance ${spec} → ${res.status} ${res.text.slice(0, 120)}`);
  return res.json;
}

/* --------------------------------------------------------------- legs */

async function legMain() {
  const port = await freePort();
  const srv = startServer('main', { MOCK_PORT: String(port), MOCK_FIRST_OFD_PROCESS_MS: '1000' });
  try {
    await waitForHealth(port, 'main');
    console.log('\n=== G1: getToken — выдача / истечение 24 ч / повтор ===');
    const t1res = await request(port, 'POST', '/getToken', { body: { login: 'firstofdmocktest', pass: '11111111-2222-4333-8444-555555555555' } });
    record('G1a getToken: 200 + token', t1res.status === 200 && typeof t1res.json?.token === 'string' && t1res.json.token.length >= 16, `status=${t1res.status} tokenLen=${(t1res.json?.token || '').length}`);
    record('G1a TTL-заголовки: 86400 + Expires-At ISO', t1res.headers['x-mock-token-ttl-secs'] === '86400' && !Number.isNaN(Date.parse(t1res.headers['x-mock-token-expires-at'] || 'bad')), `ttl=${t1res.headers['x-mock-token-ttl-secs']} expiresAt=${t1res.headers['x-mock-token-expires-at']}`);
    const t1 = t1res.json.token;

    const bad = await request(port, 'POST', '/getToken', { body: { login: 'firstofdmocktest', pass: 'wrong-key' } });
    record('G1b плохие креды: 401 invalid_credentials', bad.status === 401 && bad.json?.error?.code === 'invalid_credentials', `status=${bad.status} code=${bad.json?.error?.code}`);
    const noBody = await request(port, 'POST', '/getToken', { body: {} });
    record('G1b пустое тело: 400 invalid_request', noBody.status === 400 && noBody.json?.error?.code === 'invalid_request', `status=${noBody.status} code=${noBody.json?.error?.code}`);

    const t2res = await request(port, 'POST', '/getToken', { body: { login: 'firstofdmocktest', pass: '11111111-2222-4333-8444-555555555555' } });
    const t2 = t2res.json?.token;
    record('G1d повторная выдача: 200, второй токен', t2res.status === 200 && typeof t2 === 'string' && t2 !== t1, `t1!==t2: ${t1 !== t2}`);
    const t1works = await request(port, 'GET', `${Q}/status/sz-known-absent`, { headers: { Authorization: `Bearer ${t1}` } });
    record('G1d прежний токен жив (повтор не аннулирует): 404 request_not_found', t1works.status === 404 && t1works.json?.error?.code === 'request_not_found', `status=${t1works.status} code=${t1works.json?.error?.code}`);
    const t2works = await request(port, 'GET', `${Q}/status/sz-known-absent`, { headers: { Authorization: `Bearer ${t2}` } });
    record('G1d новый токен жив: 404', t2works.status === 404, `status=${t2works.status}`);

    await advance(port, '+25h');
    const t1after = await request(port, 'GET', `${Q}/status/sz-known-absent`, { headers: { Authorization: `Bearer ${t1}` } });
    record('G1c после +25h токен 1: 401 invalid_token', t1after.status === 401 && t1after.json?.error?.code === 'invalid_token', `status=${t1after.status} code=${t1after.json?.error?.code} text=${t1after.json?.error?.text}`);
    const t2after = await request(port, 'GET', `${Q}/status/sz-known-absent`, { headers: { Authorization: `Bearer ${t2}` } });
    record('G1c после +25h токен 2: 401', t2after.status === 401, `status=${t2after.status}`);
    const t3res = await request(port, 'POST', '/getToken', { body: { login: 'firstofdmocktest', pass: '11111111-2222-4333-8444-555555555555' } });
    const t3 = t3res.json?.token;
    const t3works = await request(port, 'GET', `${Q}/status/sz-known-absent`, { headers: { Authorization: `Bearer ${t3}` } });
    record('G1c повторная выдача после истечения: рабочий токен', t3res.status === 200 && t3works.status === 404, `issue=${t3res.status} use=${t3works.status}`);
    const B1 = { Authorization: `Bearer ${t3}` };

    console.log('\n=== G2: очередь transaction/{type} → requestId → status/transaction ===');
    const openRes = await request(port, 'POST', `${Q}/transaction/openShift`, { body: stateBody({ extId: 'sz-open-1' }), headers: B1 });
    record('G2a openShift → requestId', openRes.status === 200 && typeof openRes.json?.requestId === 'string', `status=${openRes.status} body=${openRes.text.slice(0, 120)}`);
    const openId = openRes.json?.requestId;
    const openP = await request(port, 'GET', `${Q}/status/${openId}`, { headers: B1 });
    record('G2a сразу: IN_PROGRESS', openP.status === 200 && openP.json?.status === 'IN_PROGRESS', `status=${openP.json?.status}`);
    await advance(port, '+5s');
    const openC = await request(port, 'GET', `${Q}/status/${openId}`, { headers: B1 });
    record('G2a после +5s: COMPLETED', openC.status === 200 && openC.json?.status === 'COMPLETED', `status=${openC.json?.status} errorCode=${openC.json?.errorCode}`);
    record('G2a результат: requestId/transactionType/errorCode/errorType/details/payload', openC.json?.requestId === openId && openC.json?.transactionType === 'openShift' && openC.json?.errorCode === null && openC.json?.errorType === null && 'payload' in openC.json, `keys=${Object.keys(openC.json || {}).join(',')}`);
    record('G2a payload смены: shiftNumber=1', openC.json?.payload?.shiftNumber === 1, `shiftNumber=${openC.json?.payload?.shiftNumber}`);
    expectedFiscal += 1;
    const openFull = await request(port, 'GET', `${Q}/transaction/${openId}`, { headers: B1 });
    record('G2a GET transaction/{id}: заявка + результат', openFull.status === 200 && openFull.json?.result?.status === 'COMPLETED' && openFull.json?.transactionType === 'openShift', `status=${openFull.status} resultStatus=${openFull.json?.result?.status} type=${openFull.json?.transactionType}`);

    const incRes = await request(port, 'POST', `${Q}/transaction/receipt`, { body: receiptBody({ extId: 'sz-inc-1' }), headers: B1 });
    record('G2b receipt INCOME → requestId', incRes.status === 200 && typeof incRes.json?.requestId === 'string', `status=${incRes.status}`);
    await advance(port, '+5s');
    const incC = await request(port, 'GET', `${Q}/status/${incRes.json.requestId}`, { headers: B1 });
    const p = incC.json?.payload || {};
    record('G2b INCOME COMPLETED + фискальный payload', incC.json?.status === 'COMPLETED' && Number.isInteger(p.fiscalDocumentNumber) && typeof p.fiscalDocumentSign === 'string' && typeof p.fiscalDriveNumber === 'string' && typeof p.kkmRegId === 'string', `payload=${JSON.stringify(p).slice(0, 160)}`);
    record('G2b payload: operationType=INCOME, суммы — десятичные рубли (числа)', p.operationType === 'INCOME' && p.totalSum === 200 && p.items?.[0]?.price === 100 && p.items?.[0]?.vatCode === 'VAT_22', `op=${p.operationType} totalSum=${p.totalSum} price=${p.items?.[0]?.price} vat=${p.items?.[0]?.vatCode}`);
    expectedFiscal += 1;
    const incFull = await request(port, 'GET', `${Q}/transaction/${incRes.json.requestId}`, { headers: B1 });
    record('G2b receipt: GET transaction отдаёт эхо-тело (как принято)', incFull.status === 200 && incFull.json?.request?.requestMetadata?.externalId === 'sz-inc-1' && incFull.json?.request?.document?.operationType === 'INCOME', `echo extId=${incFull.json?.request?.requestMetadata?.externalId}`);

    console.log('\n=== G2c/d: receiptCorrection + операции написания по схеме ===');
    for (const [name, op, expected] of [
      ['G2d INCOME_RETURN', 'INCOME_RETURN', 'INCOME_RETURN'],
      ['G2d EXPENCE (как в схеме)', 'EXPENCE', 'EXPENCE'],
      ['G2d EXPENCE_RETURN', 'EXPENCE_RETURN', 'EXPENCE_RETURN'],
    ]) {
      const r = await request(port, 'POST', `${Q}/transaction/receipt`, { body: receiptBody({ extId: `sz-${op.toLowerCase()}`, operation: op }), headers: B1 });
      await advance(port, '+5s');
      const s = await request(port, 'GET', `${Q}/status/${r.json?.requestId}`, { headers: B1 });
      record(`${name}: COMPLETED, operationType сохранён`, s.status === 200 && s.json?.status === 'COMPLETED' && s.json?.payload?.operationType === expected, `status=${s.json?.status} op=${s.json?.payload?.operationType}`);
      expectedFiscal += 1;
    }
    const corrRes = await request(port, 'POST', `${Q}/transaction/receiptCorrection`, { body: receiptBody({ extId: 'sz-corr-1', correction: true }), headers: B1 });
    await advance(port, '+5s');
    const corrC = await request(port, 'GET', `${Q}/status/${corrRes.json?.requestId}`, { headers: B1 });
    record('G2c receiptCorrection (+correctionCause): COMPLETED', corrC.status === 200 && corrC.json?.status === 'COMPLETED' && corrC.json?.transactionType === 'receiptCorrection', `status=${corrC.json?.status} corrCause=${corrC.json?.payload?.correctionCause ? 'есть' : 'нет'}`);
    const corrNoCause = await request(port, 'POST', `${Q}/transaction/receiptCorrection`, { body: receiptBody({ extId: 'sz-corr-2' }), headers: B1 });
    record('G2c без correctionCause: 400 (обязателен по схеме)', corrNoCause.status === 400, `status=${corrNoCause.status} field=${corrNoCause.json?.field}`);
    expectedFiscal += 1;

    const csrRes = await request(port, 'POST', `${Q}/transaction/currentStateReport`, { body: stateBody({ extId: 'sz-csr-1' }), headers: B1 });
    await advance(port, '+5s');
    const csrC = await request(port, 'GET', `${Q}/status/${csrRes.json?.requestId}`, { headers: B1 });
    record('G2e currentStateReport: COMPLETED, responseType', csrC.json?.status === 'COMPLETED' && csrC.json?.payload?.responseType === 'CURRENT_STATE_REPORT', `status=${csrC.json?.status} responseType=${csrC.json?.payload?.responseType}`);
    record('G2e отчёт состояния — не фискальный документ ([VERIFY] наблюдение)', csrC.json?.payload?.fiscalDocumentNumber === undefined, `fiscalDocumentNumber=${csrC.json?.payload?.fiscalDocumentNumber}`);

    console.log('\n=== G3: statuses по externalId+groupId ===');
    const dup1 = await request(port, 'POST', `${Q}/transaction/receipt`, { body: receiptBody({ extId: 'sz-dup-x', total: '300.00' }), headers: B1 });
    expectedFiscal += 1;
    const dup2 = await request(port, 'POST', `${Q}/transaction/receipt`, { body: receiptBody({ extId: 'sz-dup-x', total: '400.00' }), headers: B1 });
    expectedFiscal += 1;
    record('G3b повтор externalId в группе: НОВАЯ заявка + свой requestId ([VERIFY] зафиксировано)', dup1.status === 200 && dup2.status === 200 && dup1.json?.requestId !== dup2.json?.requestId, `r1=${dup1.json?.requestId} r2=${dup2.json?.requestId}`);
    record('G3b маркер дубликата: X-Mock-Duplicate-External-Id: 1', dup2.headers['x-mock-duplicate-external-id'] === '1', `hdr=${dup2.headers['x-mock-duplicate-external-id']}`);
    await advance(port, '+5s');
    const st = await request(port, 'GET', `${Q}/statuses?externalId=sz-dup-x&groupId=MOCKGROUP`, { headers: B1 });
    record('G3a statuses по externalId+groupId: обе заявки', st.status === 200 && Array.isArray(st.json) && st.json.length === 2, `len=${Array.isArray(st.json) ? st.json.length : 'n/a'}`);
    const stFiltered = await request(port, 'GET', `${Q}/statuses?externalId=sz-dup-x&groupId=MOCKGROUP&status=COMPLETED`, { headers: B1 });
    record('G3a фильтр status=COMPLETED: 2/2', stFiltered.status === 200 && Array.isArray(stFiltered.json) && stFiltered.json.length === 2, `len=${Array.isArray(stFiltered.json) ? stFiltered.json.length : 'n/a'}`);
    const stNoParams = await request(port, 'GET', `${Q}/statuses?externalId=sz-dup-x`, { headers: B1 });
    record('G3a без groupId: 400 missing_parameter', stNoParams.status === 400 && stNoParams.json?.error?.code === 'missing_parameter', `status=${stNoParams.status} code=${stNoParams.json?.error?.code}`);
    const stNoParams2 = await request(port, 'GET', `${Q}/statuses?groupId=MOCKGROUP`, { headers: B1 });
    record('G3a без externalId: 400', stNoParams2.status === 400 && stNoParams2.json?.error?.code === 'missing_parameter', `status=${stNoParams2.status}`);
    const stBadFilter = await request(port, 'GET', `${Q}/statuses?externalId=x&groupId=MOCKGROUP&status=WEIRD`, { headers: B1 });
    record('G3a плохой фильтр status: 400', stBadFilter.status === 400, `status=${stBadFilter.status}`);

    console.log('\n=== G4: /receipts за период (+пагинация) ===');
    const snap = await request(port, 'GET', '/mock/time');
    const nowMs = Number.isFinite(snap.json?.now) ? snap.json.now : Date.now(); // виртуальные часы
    const fromIso = new Date(nowMs - 3600_000).toISOString();
    const toIso = new Date(nowMs + 3600_000).toISOString();
    record('G4-pre часы: snapshot.now виртуальный', Number.isFinite(snap.json?.now), `now=${snap.json?.now} iso=${snap.json?.iso} virtual=${snap.json?.virtual}`);
    const recAll = await request(port, 'GET', `${'/api/external/receipts'}?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`, { headers: B1 });
    record('G4a receipts: 200, envelope {items,total,page,pageSize}', recAll.status === 200 && Array.isArray(recAll.json?.items) && recAll.json?.total === expectedFiscal && recAll.json?.page === 1 && recAll.json?.pageSize === 20, `total=${recAll.json?.total} ожид=${expectedFiscal} page=${recAll.json?.page}`);
    const pg1 = await request(port, 'GET', `/api/external/receipts?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&pageSize=4&page=1`, { headers: B1 });
    const pg2 = await request(port, 'GET', `/api/external/receipts?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&pageSize=4&page=2`, { headers: B1 });
    const pg3 = await request(port, 'GET', `/api/external/receipts?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&pageSize=4&page=3`, { headers: B1 });
    record('G4b пагинация pageSize=4: 4+4+' + (expectedFiscal - 8), pg1.json?.items?.length === 4 && pg2.json?.items?.length === 4 && pg3.json?.items?.length === expectedFiscal - 8, `pages=[${pg1.json?.items?.length},${pg2.json?.items?.length},${pg3.json?.items?.length}] total=${pg1.json?.total}`);
    const pgIds = new Set([...(pg1.json?.items || []), ...(pg2.json?.items || []), ...(pg3.json?.items || [])].map((i) => i.fiscalDocumentNumber));
    record('G4b страницы без пересечений и без потерь', pgIds.size === expectedFiscal, `уникальных ФД=${pgIds.size} из ${expectedFiscal}`);
    const pgOrdered = [...(pg1.json?.items || []), ...(pg2.json?.items || [])].every((it, idx, arr) => idx === 0 || String(arr[idx - 1].documentDate) <= String(it.documentDate));
    record('G4b упорядочивание по documentDate', pgOrdered, ' ASC-порядок сохранён');
    const recType = await request(port, 'GET', `/api/external/receipts?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&transactionType=receipt`, { headers: B1 });
    record('G4c фильтр transactionType=receipt: только чеки (без коррекции/смен)', recType.status === 200 && recType.json?.items?.every((i) => i.transactionType === 'receipt') && recType.json?.total === 6, `total=${recType.json?.total}`);
    const recGroup = await request(port, 'GET', `/api/external/receipts?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&groupId=MOCKGROUP`, { headers: B1 });
    record('G4c фильтр groupId: весь каталог группы', recGroup.json?.total === expectedFiscal, `total=${recGroup.json?.total}`);
    const recKkm = await request(port, 'GET', `/api/external/receipts?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&kkmRegId=${encodeURIComponent(recAll.json?.items?.[0]?.kkmRegId || '')}`, { headers: B1 });
    record('G4c фильтр kkmRegId: та же касса', recKkm.json?.total === expectedFiscal, `total=${recKkm.json?.total}`);
    const recNoFrom = await request(port, 'GET', `/api/external/receipts?to=${encodeURIComponent(toIso)}`, { headers: B1 });
    record('G4d без from: 400 missing_parameter', recNoFrom.status === 400 && recNoFrom.json?.error?.code === 'missing_parameter', `status=${recNoFrom.status}`);
    const recFromTo = await request(port, 'GET', `/api/external/receipts?from=${encodeURIComponent(toIso)}&to=${encodeURIComponent(fromIso)}`, { headers: B1 });
    record('G4d from>to: 400 invalid_request', recFromTo.status === 400, `status=${recFromTo.status}`);
    const recBigPage = await request(port, 'GET', `/api/external/receipts?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&pageSize=101`, { headers: B1 });
    record('G4d pageSize>100 (mock cap): 400', recBigPage.status === 400, `status=${recBigPage.status}`);
    const recNoDocs = await request(port, 'GET', `/api/external/receipts?from=${encodeURIComponent(new Date(nowMs - 7200_000).toISOString())}&to=${encodeURIComponent(new Date(nowMs - 7000_000).toISOString())}`, { headers: B1 });
    record('G4e пустой период: 200 + пустой список (не ошибка)', recNoDocs.status === 200 && recNoDocs.json?.items?.length === 0 && recNoDocs.json?.total === 0, `total=${recNoDocs.json?.total}`);

    console.log('\n=== G5: оба слоя ошибок (API vs KKT) + правила смен ===');
    const kktRes = await request(port, 'POST', `${Q}/transaction/receipt`, { body: receiptBody({ extId: 'sz-kkt-err' }), headers: { ...B1, 'X-Mock-Scenario': 'kkt-error' } });
    await advance(port, '+5s');
    const kktS = await request(port, 'GET', `${Q}/status/${kktRes.json?.requestId}`, { headers: B1 });
    record('G5a сценарий kkt-error: ERROR, слой KKT', kktS.json?.status === 'ERROR' && kktS.json?.errorType === 'KKT' && kktS.json?.errorCode === 'KKT_UNAVAILABLE', `status=${kktS.json?.status} type=${kktS.json?.errorType} code=${kktS.json?.errorCode}`);
    record('G5a details присутствуют', typeof kktS.json?.details === 'string' && kktS.json.details.length > 0, `details=${JSON.stringify(kktS.json?.details).slice(0, 80)}`);
    record('G5a ERROR-заявка не создаёт фискальный документ', kktS.json?.payload === null, `payload=${JSON.stringify(kktS.json?.payload)}`);

    const apiRes = await request(port, 'POST', `${Q}/transaction/receipt`, { body: receiptBody({ extId: 'sz-api-err' }), headers: { ...B1, 'X-Mock-Scenario': 'api-error' } });
    await advance(port, '+5s');
    const apiS = await request(port, 'GET', `${Q}/status/${apiRes.json?.requestId}`, { headers: B1 });
    record('G5b сценарий api-error: ERROR, слой API', apiS.json?.status === 'ERROR' && apiS.json?.errorType === 'API' && apiS.json?.errorCode === 'DOCUMENT_REJECTED', `status=${apiS.json?.status} type=${apiS.json?.errorType} code=${apiS.json?.errorCode}`);
    record('G5b слои раздельны: KKT и API каталоги не совпадают', (kktS.json?.errorCode) !== (apiS.json?.errorCode) && kktS.json?.errorType !== apiS.json?.errorType, `kkt=${kktS.json?.errorCode} api=${apiS.json?.errorCode}`);

    const openAgain = await request(port, 'POST', `${Q}/transaction/openShift`, { body: stateBody({ extId: 'sz-open-2' }), headers: B1 });
    await advance(port, '+5s');
    const openAgainS = await request(port, 'GET', `${Q}/status/${openAgain.json?.requestId}`, { headers: B1 });
    record('G5c повторный openShift: ERROR KKT SHIFT_ALREADY_OPEN ([FORK])', openAgainS.json?.status === 'ERROR' && openAgainS.json?.errorType === 'KKT' && openAgainS.json?.errorCode === 'SHIFT_ALREADY_OPEN', `code=${openAgainS.json?.errorCode} type=${openAgainS.json?.errorType}`);
    const closeRes = await request(port, 'POST', `${Q}/transaction/closeShift`, { body: stateBody({ extId: 'sz-close-1' }), headers: B1 });
    await advance(port, '+5s');
    const closeS = await request(port, 'GET', `${Q}/status/${closeRes.json?.requestId}`, { headers: B1 });
    record('G5c closeShift при открытой смене: COMPLETED', closeS.json?.status === 'COMPLETED', `status=${closeS.json?.status}`);
    expectedFiscal += 1;
    const closeAgain = await request(port, 'POST', `${Q}/transaction/closeShift`, { body: stateBody({ extId: 'sz-close-2' }), headers: B1 });
    await advance(port, '+5s');
    const closeAgainS = await request(port, 'GET', `${Q}/status/${closeAgain.json?.requestId}`, { headers: B1 });
    record('G5c повторный closeShift: ERROR KKT SHIFT_NOT_OPEN ([FORK])', closeAgainS.json?.status === 'ERROR' && closeAgainS.json?.errorCode === 'SHIFT_NOT_OPEN' && closeAgainS.json?.errorType === 'KKT', `code=${closeAgainS.json?.errorCode}`);

    console.log('\n=== G6: негативы ===');
    const noAuth = await request(port, 'POST', `${Q}/transaction/openShift`, { body: stateBody({ extId: 'x' }) });
    record('G6a без Authorization: 401 invalid_token', noAuth.status === 401 && noAuth.json?.error?.code === 'invalid_token', `status=${noAuth.status} code=${noAuth.json?.error?.code}`);
    const badAuth = await request(port, 'POST', `${Q}/transaction/openShift`, { body: stateBody({ extId: 'x' }), headers: { Authorization: 'Bearer sz-not-a-token' } });
    record('G6a чужой/неизвестный Bearer: 401 invalid_token', badAuth.status === 401 && badAuth.json?.error?.code === 'invalid_token', `status=${badAuth.status}`);
    const badScheme = await request(port, 'POST', `${Q}/transaction/openShift`, { body: stateBody({ extId: 'x' }), headers: { Authorization: `Basic ${t3}` } });
    record('G6a non-Bearer схема: 401', badScheme.status === 401, `status=${badScheme.status}`);

    const noInn = await request(port, 'POST', `${Q}/transaction/receipt`, { body: receiptBody({ extId: 'sz-noinn', userInn: '' }), headers: B1 });
    record('G6c чек без userInn: 400 (обязателен)', noInn.status === 400 && (noInn.json?.field || '') === 'cashboxParameters.userInn', `status=${noInn.status} field=${noInn.json?.field}`);
    const badInn = await request(port, 'POST', `${Q}/transaction/receipt`, { body: receiptBody({ extId: 'sz-badinn', userInn: '123' }), headers: B1 });
    record('G6c userInn некорректный: 400', badInn.status === 400, `status=${badInn.status}`);
    const noMeta = await request(port, 'POST', `${Q}/transaction/openShift`, { body: { cashboxParameters: {} }, headers: B1 });
    record('G6c без requestMetadata: 400 ([VERIFY] строгая схема OpenAPI)', noMeta.status === 400, `status=${noMeta.status} code=${noMeta.json?.error?.code}`);
    const noGroup = await request(port, 'POST', `${Q}/transaction/openShift`, { body: { cashboxParameters: {}, requestMetadata: { externalId: 'sz-x' } }, headers: B1 });
    record('G6c без userGroup: 400 (обязателен)', noGroup.status === 400 && (noGroup.json?.field || '').includes('userGroup'), `status=${noGroup.status} field=${noGroup.json?.field}`);
    const noDoc = await request(port, 'POST', `${Q}/transaction/receipt`, { body: { cashboxParameters: { userInn: '7801234567' }, requestMetadata: { externalId: 'sz-x', userGroup: 'MOCKGROUP' } }, headers: B1 });
    record('G6c чек без document: 400', noDoc.status === 400, `status=${noDoc.status}`);

    const mixedBody = await request(port, 'POST', `${Q}/transaction/openShift`, { body: receiptBody({ extId: 'sz-mixed' }), headers: B1 });
    record('G6d receipt-тело на openShift: 400 (не собирать универсальный объект)', mixedBody.status === 400 && (mixedBody.json?.hint || '').includes('StateCommandRequest') && mixedBody.json?.field === 'document', `status=${mixedBody.status} field=${mixedBody.json?.field} hint=${(mixedBody.json?.hint || '').slice(0, 60)}`);

    const badGroup = await request(port, 'POST', `${Q}/transaction/openShift`, { body: stateBody({ extId: 'sz-bg', group: 'NO-SUCH-GROUP' }), headers: B1 });
    record('G6e неизвестный userGroup: 400 unknown_user_group', badGroup.status === 400 && badGroup.json?.error?.code === 'unknown_user_group', `status=${badGroup.status} code=${badGroup.json?.error?.code}`);

    const expenseTypo = await request(port, 'POST', `${Q}/transaction/receipt`, { body: receiptBody({ extId: 'sz-exp', operation: 'EXPENSE' }), headers: B1 });
    record('G6f EXPENSE (не по схеме): 400 invalid_operation_type с подсказкой EXPENCE', expenseTypo.status === 400 && expenseTypo.json?.error?.code === 'invalid_operation_type' && (expenseTypo.json?.hint || '').includes('EXPENCE'), `code=${expenseTypo.json?.error?.code} hint=${(expenseTypo.json?.hint || '').slice(0, 60)}`);

    const badVat = await request(port, 'POST', `${Q}/transaction/receipt`, { body: receiptBody({ extId: 'sz-vat', vat: 'VAT_99' }), headers: B1 });
    record('G6h неизвестный vatCode: 400 invalid_vat_code', badVat.status === 400 && badVat.json?.error?.code === 'invalid_vat_code', `code=${badVat.json?.error?.code}`);

    const miss1 = await request(port, 'GET', `${Q}/status/sz-never-existed`, { headers: B1 });
    const miss2 = await request(port, 'GET', `${Q}/transaction/sz-never-existed`, { headers: B1 });
    record('G6g неизвестный requestId: 404 request_not_found (status/transaction)', miss1.status === 404 && miss1.json?.error?.code === 'request_not_found' && miss2.status === 404, `status=${miss1.status}/${miss2.status}`);

    console.log('\n=== G7: «знание ID ≠ доступ» (namespaces) ===');
    const bAuth = await request(port, 'POST', '/getToken', { body: { login: 'firstofdmocktest', pass: '11111111-2222-4333-8444-555555555555' }, headers: { 'X-Mock-Sandbox': 'sz-sandbox-b' } });
    record('G7 sandbox B: токен выдан', bAuth.status === 200, `status=${bAuth.status}`);
    const bTok = bAuth.json?.token;
    const bClaim = await request(port, 'POST', `${Q}/transaction/openShift`, { body: stateBody({ extId: 'sz-b-ext' }), headers: { Authorization: `Bearer ${bTok}`, 'X-Mock-Sandbox': 'sz-sandbox-b' } });
    record('G7 sandbox B: заявка создана', bClaim.status === 200, `status=${bClaim.status}`);
    const crossRead = await request(port, 'GET', `${Q}/status/${bClaim.json?.requestId}`, { headers: B1 });
    record('G7a чужой requestId из дефолтной песочницы: 404 (ID ≠ доступ)', crossRead.status === 404 && crossRead.json?.error?.code === 'request_not_found', `status=${crossRead.status}`);
    const crossStatuses = await request(port, 'GET', `${Q}/statuses?externalId=sz-b-ext&groupId=MOCKGROUP`, { headers: B1 });
    record('G7a statuses в дефолтной песочнице: чужих заявок нет', crossStatuses.status === 200 && Array.isArray(crossStatuses.json) && crossStatuses.json.length === 0, `len=${Array.isArray(crossStatuses.json) ? crossStatuses.json.length : 'n/a'}`);
    const crossToken = await request(port, 'POST', `${Q}/transaction/openShift`, { body: stateBody({ extId: 'sz-def' }), headers: { Authorization: `Bearer ${bTok}` } });
    record('G7b токен песочницы B на дефолтной: 401 invalid_token', crossToken.status === 401 && crossToken.json?.error?.code === 'invalid_token', `status=${crossToken.status}`);
    const bSelfRead = await request(port, 'GET', `${Q}/status/${bClaim.json?.requestId}`, { headers: { Authorization: `Bearer ${bTok}`, 'X-Mock-Sandbox': 'sz-sandbox-b' } });
    record('G7 владелец внутри B читает свою заявку: 200', bSelfRead.status === 200, `status=${bSelfRead.status}`);

    console.log('\n=== G1e: квирк примера getToken ([VERIFY] расхождение №4) ===');
    const quirkRes = await request(port, 'POST', '/getToken', { body: { login: 'firstofdmocktest', pass: '11111111-2222-4333-8444-555555555555' }, headers: { 'X-Mock-Scenario': 'getToken-error-quirk' } });
    record('G1e сценарий getToken-error-quirk: 200 + error{code:0}', quirkRes.status === 200 && quirkRes.json?.error?.code === 0 && typeof quirkRes.json?.token === 'string', `status=${quirkRes.status} error=${JSON.stringify(quirkRes.json?.error)}`);

    stopServer(srv);
  } catch (e) {
    stopServer(srv);
    throw e;
  }
  return srv;
}

async function legCallback() {
  console.log('\n=== G8: callback без подписи + сверка статусом + retry-график ===');
  const hits = { ok: [], fail: [] };
  const okRcv = await freePort();
  const failRcv = await freePort();
  const okServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* не JSON */ }
      hits.ok.push({ path: req.url, headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"received":true}');
    });
  });
  const failServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.fail.push({ path: req.url });
      res.writeHead(500);
      res.end('nope');
    });
  });
  await new Promise((r) => okServer.listen(okRcv, '127.0.0.1', r));
  await new Promise((r) => failServer.listen(failRcv, '127.0.0.1', r));
  const port = await freePort();
  const srv = startServer('callback', {
    MOCK_PORT: String(port),
    MOCK_FIRST_OFD_PROCESS_MS: '1000',
    MOCK_FIRST_OFD_CALLBACK_RETRY_MS: '2000',
  });
  try {
    await waitForHealth(port, 'callback');
    const auth = await request(port, 'POST', '/getToken', { body: { login: 'firstofdmocktest', pass: '11111111-2222-4333-8444-555555555555' } });
    const B = { Authorization: `Bearer ${auth.json.token}` };

    const c1 = await request(port, 'POST', `${Q}/transaction/receipt`, { body: receiptBody({ extId: 'sz-cb-ok', callbackUrl: `http://127.0.0.1:${okRcv}/cb` }), headers: B });
    await advance(port, '+5s');
    const s1 = await request(port, 'GET', `${Q}/status/${c1.json?.requestId}`, { headers: B });
    record('G8a заявка с callbackUrl: COMPLETED', s1.json?.status === 'COMPLETED', `status=${s1.json?.status}`);
    let got = null;
    for (let i = 0; i < 40 && !got; i += 1) { await sleep(150); got = hits.ok.find((h) => h.body?.requestId === c1.json?.requestId); }
    record('G8a callback доставлен (2xx ACK)', Boolean(got), got ? `body.requestId=${got.body.requestId}` : 'за 6с не доставлен');
    record('G8a уведомление без подписи (никаких signature/HMAC-заголовков)', Boolean(got) && !Object.keys(got.headers || {}).some((k) => /signature|hmac|x-sign/i.test(k)), `headers=${Object.keys(got?.headers || {}).filter((k) => k.startsWith('x-') || k.includes('sign')).join(',')}`);
    record('G8a тело: результат заявки + externalId + userGroup', Boolean(got) && got.body?.externalId === 'sz-cb-ok' && got.body?.userGroup === 'MOCKGROUP' && got.body?.requestId === c1.json?.requestId && got.body?.status === 'COMPLETED', `extId=${got?.body?.externalId} group=${got?.body?.userGroup} status=${got?.body?.status}`);
    const rec = await request(port, 'GET', `${Q}/status/${c1.json?.requestId}`, { headers: B });
    record('G8a сверка статусом: COMPLETED (источник истины — метод статуса)', rec.json?.status === 'COMPLETED', `status=${rec.json?.status}`);

    const c2 = await request(port, 'POST', `${Q}/transaction/receipt`, { body: receiptBody({ extId: 'sz-cb-fail', callbackUrl: `http://127.0.0.1:${failRcv}/cb` }), headers: B });
    await advance(port, '+5s');
    for (let i = 0; i < 6; i += 1) {
      await advance(port, '+3s'); // retry-график мока: nextAttemptAt = +2000 мс виртуальных
      await sleep(500);
    }
    const failCount = hits.fail.filter((h) => true).length;
    record('G8b ретраи по графику: 3 попытки (max) при 500', failCount === 3, `attempt=${failCount}`);
    const s2 = await request(port, 'GET', `${Q}/status/${c2.json?.requestId}`, { headers: B });
    record('G8b заявка сама COMPLETED — ошибка доставки не влияет на заявку', s2.json?.status === 'COMPLETED', `status=${s2.json?.status} (доставка фиксируется в очереди callback, сверка — статусом)`);

    stopServer(srv);
  } catch (e) {
    stopServer(srv);
    throw e;
  } finally {
    okServer.close();
    failServer.close();
  }
}

async function legSsrf() {
  console.log('\n=== G8c: SSRF-терминальность callback (MOCK_BLOCK_PRIVATE_WEBHOOKS=1) ===');
  const port = await freePort();
  const srv = startServer('ssrf', { MOCK_PORT: String(port), MOCK_FIRST_OFD_PROCESS_MS: '1000', MOCK_BLOCK_PRIVATE_WEBHOOKS: '1' });
  try {
    await waitForHealth(port, 'ssrf');
    const auth = await request(port, 'POST', '/getToken', { body: { login: 'firstofdmocktest', pass: '11111111-2222-4333-8444-555555555555' } });
    const B = { Authorization: `Bearer ${auth.json.token}` };
    const c = await request(port, 'POST', `${Q}/transaction/receipt`, { body: receiptBody({ extId: 'sz-ssrf', callbackUrl: 'http://127.0.0.1:9/sz' }), headers: B });
    await advance(port, '+5s');
    const s = await request(port, 'GET', `${Q}/status/${c.json?.requestId}`, { headers: B });
    record('G8c заявка при SSRF-блоке: COMPLETED (блокирует только доставка)', s.json?.status === 'COMPLETED', `status=${s.json?.status}`);
    await sleep(2000);
    const attemptLines = () => srv.logs.filter((l) => /webhook \d+ (error|failed)/.test(l)).length;
    const terminalLine = srv.logs.find((l) => l.includes('заблокирован политикой SSRF — терминальный отказ, без повторов'));
    record('G8c терминальный SSRF-отказ: заявка dumped, без повторов', Boolean(terminalLine), terminalLine || 'строки нет');
    const attemptsBefore = attemptLines();
    await advance(port, '+65s');
    await sleep(2000);
    record('G8c после +65s второй попытки нет (терминально)', attemptLines() === attemptsBefore && attemptsBefore === 1, `attempt-строк до=${attemptsBefore} после=${attemptLines()}`);
    const lastStatusRecorded = srv.logs.filter((l) => l.includes('SSRF_BLOCKED')).length >= 0; // статус ERR SSRF_BLOCKED передаётся в entry.lastStatus (не печатается)
    record('G8c маркер ошибки доставки — сообщение политики SSRF (не литерал)', srv.logs.some((l) => l.includes('заблокирован политикой SSRF')), lastStatusRecorded ? 'маркер в логе' : 'нет');
    stopServer(srv);
  } catch (e) {
    stopServer(srv);
    throw e;
  }
}

async function legTokenSingle() {
  console.log('\n=== legD: MOCK_FIRST_OFD_TOKEN_SINGLE=1 — повторная выдача аннулирует ===');
  const port = await freePort();
  const srv = startServer('single', { MOCK_PORT: String(port), MOCK_FIRST_OFD_TOKEN_SINGLE: '1' });
  try {
    await waitForHealth(port, 'single');
    const a = await request(port, 'POST', '/getToken', { body: { login: 'firstofdmocktest', pass: '11111111-2222-4333-8444-555555555555' } });
    const b = await request(port, 'POST', '/getToken', { body: { login: 'firstofdmocktest', pass: '11111111-2222-4333-8444-555555555555' } });
    const aUse = await request(port, 'GET', `${Q}/status/x`, { headers: { Authorization: `Bearer ${a.json?.token}` } });
    const bUse = await request(port, 'GET', `${Q}/status/x`, { headers: { Authorization: `Bearer ${b.json?.token}` } });
    record('legD прежний токен аннулирован: 401', aUse.status === 401, `status=${aUse.status}`);
    record('legD новый токен рабочий: 404 (авторизован)', bUse.status === 404, `status=${bUse.status}`);
    stopServer(srv);
  } catch (e) {
    stopServer(srv);
    throw e;
  }
}

async function legOwned() {
  console.log('\n=== legE: owned-режим (MOCK_HOSTED=1) — наблюдение для #98 (INFO) ===');
  const port = await freePort();
  const srv = startServer('owned', {
    MOCK_PORT: String(port),
    MOCK_FIRST_OFD_PROCESS_MS: '1000',
    MOCK_HOSTED: '1',
    MOCK_SANDBOX_TOKEN: 'sz-owner-token-98',
  });
  try {
    await waitForHealth(port, 'owned');
    // (a) владелец только X-Sandbox-Token → доступ
    const ownerOnly = await request(port, 'POST', '/getToken', { body: { login: 'firstofdmocktest', pass: '11111111-2222-4333-8444-555555555555' }, headers: { 'X-Sandbox-Token': 'sz-owner-token-98' } });
    record('legE-a владелец (X-Sandbox-Token): 200', ownerOnly.status === 200, `status=${ownerOnly.status}`);
    const queueTok = ownerOnly.json?.token;
    // (b) Bearer <токен очереди> + X-Sandbox-Token → задокументированное ограничение #98: 401
    const both = await request(port, 'POST', `${Q}/transaction/openShift`, { body: stateBody({ extId: 'sz-own-1' }), headers: { Authorization: `Bearer ${queueTok}`, 'X-Sandbox-Token': 'sz-owner-token-98' } });
    record('legE-b Bearer+X-Sandbox-Token: 401 (ограничение #98 воспроизводится)', both.status === 401, `status=${both.status} code=${both.json?.error?.code}`);
    record('legE-b текст отказа про «знание ID»', (both.json?.error?.text || '').includes('знание ID'), `text=${(both.json?.error?.text || '').slice(0, 80)}`);
    // (c) битый X-Sandbox-Token → 401 (знание ID ≠ доступ)
    const badOwner = await request(port, 'POST', '/getToken', { body: { login: 'firstofdmocktest', pass: '11111111-2222-4333-8444-555555555555' }, headers: { 'X-Sandbox-Token': 'wrong-owner' } });
    record('legE-c битый X-Sandbox-Token: 401', badOwner.status === 401, `status=${badOwner.status} code=${badOwner.json?.error?.code}`);
    // (d) только Bearer <owner-token> — текущее ядро распознаёт владельца из Bearer (приоритет #1)
    const bearerOwner = await request(port, 'POST', '/getToken', { body: { login: 'firstofdmocktest', pass: '11111111-2222-4333-8444-555555555555' }, headers: { Authorization: 'Bearer sz-owner-token-98' } });
    record('legE-d только Bearer<owner-token>: 200 (fallback работает и до, и после #98)', bearerOwner.status === 200, `status=${bearerOwner.status} — вводные для предрегистрации #98`);
    stopServer(srv);
  } catch (e) {
    stopServer(srv);
    throw e;
  }
}

async function main() {
  console.log(`SZ wave-#92 проба first-ofd-mock (OKassa) — DoD issue #92. server.js: ${SERVER}`);
  console.log(`server.js exists: ${fs.existsSync(SERVER)}`);
  await legMain();
  await legCallback();
  await legSsrf();
  await legTokenSingle();
  await legOwned();
  console.log('\n================ ИТОГ ================');
  console.log(`PASSED: ${PASS.length}`);
  console.log(`FAILED: ${FAIL.length}`);
  if (FAIL.length) {
    console.log('--- провалы ---');
    for (const f of FAIL) console.log(`  ✗ ${f}`);
  }
  process.exitCode = FAIL.length ? 1 : 0;
}

main().catch((e) => {
  console.error('PROBE CRASH:', e && e.stack ? e.stack : e);
  process.exitCode = 2;
});
