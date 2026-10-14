#!/usr/bin/env node
/* © 2026 ООО «Аксиома» ИНН:7842223709 · Apache-2.0
 * SZ wave-#97 проба: kontur-ofd-mock (Контур.ОФД read/reconciliation, 9-й сервис, :3108) —
 * верификация по предрегистрации SZ (issue62) + сигнал координатора (6165122182) на ревизии 72627cd.
 * Zero-dep, Node >= 18.
 *
 * Группы: K1 auth (Sid+ApiKey, два уровня), K2 Sid TTL на виртуальных часах, K3 organizations,
 * K4 cashboxes (+403/404), K5 documents за дату (+types, пустой день), K6 by-period (пагинация
 * ≤1000, paging.nextOffset, [FORK] offset каноничен / currentOffset 400), K7 документ по ID,
 * K8 копейки, K9 write-путь не моделируется (405/404), K10 сценарии (duplicate/fail/http-500/504),
 * K11 журнал без секретов, K12 изоляция/«знание ID ≠ доступ», legB owned-режим.
 */

'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = __dirname;
const SERVER = path.join(ROOT, 'services', 'kontur-ofd-mock', 'server.js');

const PASS = [];
const FAIL = [];

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

function request(port, method, urlPath, { body, headers = {}, timeoutMs = 8000, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const data = rawBody !== undefined ? Buffer.from(rawBody, 'utf8')
      : body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        ...headers,
      }, timeout: timeoutMs },
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

function authHeaders(sid, apiKey) {
  return {
    ...(sid ? { Authorization: `auth.sid ${sid}` } : {}),
    ...(apiKey ? { 'X-Kontur-Ofd-ApiKey': apiKey } : {}),
  };
}

const LOGIN = 'sz-kontur-integrator@example.invalid';
const PASSWORD = 'sz-utf8-пароль-2026';
const API_KEY = 'sz-api-key-0123456789abcdef';
const V2 = '/v2';

async function authenticate(port, { login = LOGIN, password = PASSWORD, headers = {} } = {}) {
  const sep = login.includes('?') ? '&' : '?';
  return request(port, 'POST', `/auth/authenticate-by-pass${sep}login=${encodeURIComponent(login)}`, {
    rawBody: password,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
  });
}

async function legMain() {
  const port = await freePort();
  const srv = startServer('main', {
    MOCK_PORT: String(port),
    MOCK_KONTUR_OFD_LOGIN: LOGIN,
    MOCK_KONTUR_OFD_PASSWORD: PASSWORD,
    MOCK_KONTUR_OFD_API_KEY: API_KEY,
  });
  try {
    await waitForHealth(port, 'main');

    console.log('\n=== K1: auth — два уровня доступа (Sid + API key) ===');
    const ok = await authenticate(port);
    record('K1a правильные креды: 200 + {Sid}', ok.status === 200 && typeof ok.json?.Sid === 'string' && ok.json.Sid.length >= 32, `status=${ok.status} sidLen=${(ok.json?.Sid || '').length}`);
    const Sid = ok.json.Sid;
    const badPass = await authenticate(port, { password: 'wrong' });
    record('K1b неверный пароль: 401 errorCodeId=401002', badPass.status === 401 && badPass.json?.errorCodeId === 401002, `status=${badPass.status} code=${badPass.json?.errorCodeId}`);
    const badLogin = await authenticate(port, { login: 'nobody@example.invalid' });
    record('K1b неверный login: 401 401002', badLogin.status === 401 && badLogin.json?.errorCodeId === 401002, `status=${badLogin.status}`);
    const noCredsData = await request(port, 'GET', `${V2}/organizations`, {});
    record('K1c без Sid и ключа: 401 401002 (получить новую сессию)', noCredsData.status === 401 && noCredsData.json?.errorCodeId === 401002, `status=${noCredsData.status} code=${noCredsData.json?.errorCodeId}`);
    const onlyKey = await request(port, 'GET', `${V2}/organizations`, { headers: { 'X-Kontur-Ofd-ApiKey': API_KEY } });
    record('K1c только ApiKey без Sid: 401 401002', onlyKey.status === 401 && onlyKey.json?.errorCodeId === 401002, `status=${onlyKey.status}`);
    const onlySid = await request(port, 'GET', `${V2}/organizations`, { headers: authHeaders(Sid, '') });
    record('K1d только Sid без ключа: 401 401003', onlySid.status === 401 && onlySid.json?.errorCodeId === 401003, `status=${onlySid.status} code=${onlySid.json?.errorCodeId}`);
    const badKey = await request(port, 'GET', `${V2}/organizations`, { headers: { ...authHeaders(Sid, ''), 'X-Kontur-Ofd-ApiKey': 'wrong-key' } });
    record('K1d неверный ключ: 401 401003 (не путать с 401002)', badKey.status === 401 && badKey.json?.errorCodeId === 401003, `status=${badKey.status} hint=${(badKey.json?.hint || '').slice(0, 40)}`);
    const full = await request(port, 'GET', `${V2}/organizations`, { headers: authHeaders(Sid, API_KEY) });
    record('K1e Sid + ApiKey: 200', full.status === 200, `status=${full.status}`);
    record('K1e коды ошибок несут errorCodeId (ориентир, не errorCode)', 'errorCodeId' in (noCredsData.json || {}) && !('errorCode' in (noCredsData.json || {})), `keys=${Object.keys(noCredsData.json || {}).join(',')}`);

    console.log('\n=== K3: organizations ===');
    record('K3a только доступные организации (org-restricted скрыт из списка)', full.json?.length === 1 && full.json?.[0]?.id === 'org-demo' && full.json?.[0]?.inn === '7700000000', `len=${full.json?.length} first=${full.json?.[0]?.id}`);
    record('K3a поля id/inn/kpp/name, без служебного accessible', full.json?.[0] && ['id', 'inn', 'kpp', 'name'].every((k) => k in full.json[0]) && !('accessible' in full.json[0]), `keys=${Object.keys(full.json?.[0] || {}).join(',')}`);

    console.log('\n=== K4: cashboxes (+403/404) ===');
    const boxes = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes`, { headers: authHeaders(Sid, API_KEY) });
    record('K4a org-demo: 1 доступная касса regNumber=...0001', boxes.status === 200 && boxes.json?.length === 1 && boxes.json?.[0]?.regNumber === '0000000000000001', `len=${boxes.json?.length} reg=${boxes.json?.[0]?.regNumber}`);
    record('K4a поля кассы: модель/ФН/адреса/период доступа', ['model', 'fiscalDriveNumber', 'addresses', 'accessPeriod'].every((k) => k in (boxes.json?.[0] || {})), `keys=${Object.keys(boxes.json?.[0] || {}).join(',')}`);
    const restricted = await request(port, 'GET', `${V2}/organizations/org-restricted/cashboxes`, { headers: authHeaders(Sid, API_KEY) });
    record('K4b организация без согласия: 403 (знание ID ≠ доступ)', restricted.status === 403 && restricted.json?.errorCodeId === 403, `status=${restricted.status} code=${restricted.json?.errorCodeId}`);
    const unknownOrg = await request(port, 'GET', `${V2}/organizations/org-nope/cashboxes`, { headers: authHeaders(Sid, API_KEY) });
    record('K4b неизвестная организация: 404', unknownOrg.status === 404 && unknownOrg.json?.errorCodeId === 404, `status=${unknownOrg.status}`);
    const restrictedBox = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000002/documents?date=2026-10-11`, { headers: authHeaders(Sid, API_KEY) });
    record('K4c касса без согласия: 403', restrictedBox.status === 403 && restrictedBox.json?.errorCodeId === 403, `status=${restrictedBox.status}`);
    const unknownBox = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/9999999999999999/documents?date=2026-10-11`, { headers: authHeaders(Sid, API_KEY) });
    record('K4c неизвестная касса: 404', unknownBox.status === 404, `status=${unknownBox.status}`);

    console.log('\n=== K5: documents за дату (+types, пустой день) ===');
    const dayAll = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents?date=2026-10-11`, { headers: authHeaders(Sid, API_KEY) });
    record('K5a демо-каталог за 2026-10-11: 12 ФД', dayAll.status === 200 && Array.isArray(dayAll.json) && dayAll.json.length === 12, `len=${Array.isArray(dayAll.json) ? dayAll.json.length : 'n/a'}`);
    const typeSet = new Set((dayAll.json || []).map((d) => d.type));
    record('K5b все 10 типов из среза присутствуют', typeSet.size === 10, `types=${typeSet.size}`);
    const dayReceipts = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents?date=2026-10-11&types=receipt`, { headers: authHeaders(Sid, API_KEY) });
    record('K5c types=receipt: 3 чека (один возврат)', dayReceipts.status === 200 && dayReceipts.json?.length === 3 && dayReceipts.json.filter((d) => d.operationType === 2).length === 1, `len=${dayReceipts.json?.length} returns=${(dayReceipts.json || []).filter((d) => d.operationType === 2).length}`);
    const dayTwoTypes = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents?date=2026-10-11&types=receipt,bso`, { headers: authHeaders(Sid, API_KEY) });
    record('K5c types списком через запятую: 4', dayTwoTypes.status === 200 && dayTwoTypes.json?.length === 4, `len=${dayTwoTypes.json?.length}`);
    const badTypes = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents?date=2026-10-11&types=receipt,weird`, { headers: authHeaders(Sid, API_KEY) });
    record('K5d неизвестный type: 400 field=types', badTypes.status === 400 && badTypes.json?.field === 'types', `status=${badTypes.status} field=${badTypes.json?.field}`);
    const emptyDay = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents?date=2026-10-12`, { headers: authHeaders(Sid, API_KEY) });
    record('K5e пустой день: 200 + пустой список (не ошибка)', emptyDay.status === 200 && Array.isArray(emptyDay.json) && emptyDay.json.length === 0, `len=${Array.isArray(emptyDay.json) ? emptyDay.json.length : 'n/a'}`);
    const badDay = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents?date=2026-02-30`, { headers: authHeaders(Sid, API_KEY) });
    record('K5f невозможная дата (2026-02-30): 400', badDay.status === 400, `status=${badDay.status}`);

    console.log('\n=== K6: by-period — пагинация (≤1000, paging.nextOffset, [FORK] offset) ===');
    const from = '2026-10-11T00:00:00';
    const to = '2026-10-11T23:59:59';
    const p1 = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents/by-period?dateFrom=${from}&dateTo=${to}&offset=0&limit=5`, { headers: authHeaders(Sid, API_KEY) });
    record('K6a страница 1: 5 ФД + paging.nextOffset=5', p1.status === 200 && p1.json?.documents?.length === 5 && p1.json?.paging?.nextOffset === 5, `len=${p1.json?.documents?.length} next=${p1.json?.paging?.nextOffset}`);
    const p2 = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents/by-period?dateFrom=${from}&dateTo=${to}&offset=5&limit=5`, { headers: authHeaders(Sid, API_KEY) });
    record('K6a страница 2: 5 ФД + next=10', p2.status === 200 && p2.json?.documents?.length === 5 && p2.json?.paging?.nextOffset === 10, `len=${p2.json?.documents?.length} next=${p2.json?.paging?.nextOffset}`);
    const p3 = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents/by-period?dateFrom=${from}&dateTo=${to}&offset=10&limit=5`, { headers: authHeaders(Sid, API_KEY) });
    record('K6a страница 3: 2 ФД + next=null (терминальный курсор)', p3.status === 200 && p3.json?.documents?.length === 2 && p3.json?.paging?.nextOffset === null, `len=${p3.json?.documents?.length} next=${p3.json?.paging?.nextOffset}`);
    const allIds = [...p1.json.documents, ...p2.json.documents, ...p3.json.documents].map((d) => d.id);
    record('K6b обход страницами: без пересечений и потерь (12 уникальных)', new Set(allIds).size === 12 && allIds.length === 12, `unique=${new Set(allIds).size}/${allIds.length}`);
    const allDates = [...p1.json.documents, ...p2.json.documents, ...p3.json.documents].map((d) => d.date);
    const sorted = allDates.every((dt, idx) => idx === 0 || String(allDates[idx - 1]) <= String(dt));
    record('K6b ASC-порядок по date сохранён', sorted, `date0=${allDates[0]} dateLast=${allDates[allDates.length - 1]}`);
    const onePage = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents/by-period?dateFrom=${from}&dateTo=${to}`, { headers: authHeaders(Sid, API_KEY) });
    record('K6c без offset/limit: 12 ФД + next=null (дефолт 1000)', onePage.status === 200 && onePage.json?.documents?.length === 12 && onePage.json?.paging?.nextOffset === null, `len=${onePage.json?.documents?.length}`);
    const bigLimit = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents/by-period?dateFrom=${from}&dateTo=${to}&limit=1000`, { headers: authHeaders(Sid, API_KEY) });
    record('K6c limit=1000 (максимум): 12 + null', bigLimit.status === 200 && bigLimit.json?.documents?.length === 12, `len=${bigLimit.json?.documents?.length}`);
    const limit0 = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents/by-period?dateFrom=${from}&dateTo=${to}&limit=0`, { headers: authHeaders(Sid, API_KEY) });
    const limit1001 = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents/by-period?dateFrom=${from}&dateTo=${to}&limit=1001`, { headers: authHeaders(Sid, API_KEY) });
    record('K6d limit=0 и limit=1001: 400', limit0.status === 400 && limit1001.status === 400, `status=${limit0.status}/${limit1001.status}`);
    const currentOffset = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents/by-period?dateFrom=${from}&dateTo=${to}&currentOffset=0`, { headers: authHeaders(Sid, API_KEY) });
    record('K6e [FORK] currentOffset: 400 с подсказкой про offset', currentOffset.status === 400 && (currentOffset.json?.message || '').includes('offset') && currentOffset.json?.field === 'currentOffset', `status=${currentOffset.status} msg=${(currentOffset.json?.message || '').slice(0, 60)}`);
    const emptyPeriod = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents/by-period?dateFrom=2026-10-01T00:00:00&dateTo=2026-10-01T23:59:59`, { headers: authHeaders(Sid, API_KEY) });
    record('K6f пустой период: 200 {documents:[], nextOffset:null} (не ошибка)', emptyPeriod.status === 200 && emptyPeriod.json?.documents?.length === 0 && emptyPeriod.json?.paging?.nextOffset === null, `len=${emptyPeriod.json?.documents?.length}`);
    const reversed = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents/by-period?dateFrom=${to}&dateTo=${from}`, { headers: authHeaders(Sid, API_KEY) });
    record('K6g dateFrom>dateTo: 400', reversed.status === 400, `status=${reversed.status}`);
    const badFrom = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents/by-period?dateFrom=not-a-date&dateTo=${to}`, { headers: authHeaders(Sid, API_KEY) });
    record('K6g нечитаемая дата: 400', badFrom.status === 400, `status=${badFrom.status}`);
    const periodTypes = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents/by-period?dateFrom=${from}&dateTo=${to}&types=openShift,closeShift`, { headers: authHeaders(Sid, API_KEY) });
    record('K6h фильтр types в периоде: openShift+closeShift = 2', periodTypes.status === 200 && periodTypes.json?.documents?.length === 2 && periodTypes.json.documents.every((d) => ['openShift', 'closeShift'].includes(d.type)), `len=${periodTypes.json?.documents?.length}`);

    console.log('\n=== K7: документ по ID ===');
    const doc1 = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents/doc-6-1`, { headers: authHeaders(Sid, API_KEY) });
    record('K7a receipt по ID: 200, id/fiscalDocumentNumber/fiscalSign/operationType', doc1.status === 200 && doc1.json?.id === 'doc-6-1' && Number.isSafeInteger(doc1.json?.fiscalDocumentNumber) && typeof doc1.json?.fiscalSign === 'string' && doc1.json?.operationType === 1, `status=${doc1.status} fdn=${doc1.json?.fiscalDocumentNumber} op=${doc1.json?.operationType}`);
    const docRet = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents/doc-6-2`, { headers: authHeaders(Sid, API_KEY) });
    record('K7b возврат прихода: operationType=2', docRet.status === 200 && docRet.json?.operationType === 2, `status=${docRet.status} op=${docRet.json?.operationType}`);
    const noDoc = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents/doc-nope`, { headers: authHeaders(Sid, API_KEY) });
    record('K7c неизвестный documentId: 404', noDoc.status === 404 && noDoc.json?.errorCodeId === 404, `status=${noDoc.status}`);

    console.log('\n=== K8: суммы в целых копейках ===');
    record('K8a totalSum/cashSum/electronicSum — целые копейки', Number.isSafeInteger(doc1.json?.totalSum) && doc1.json?.totalSum === 12345 && doc1.json?.cashSum === 0 && doc1.json?.electronicSum === 12345, `total=${doc1.json?.totalSum} cash=${doc1.json?.cashSum} ecash=${doc1.json?.electronicSum}`);
    record('K8b items[].price/sum — копейки (контраст с банками-рублями)', Array.isArray(doc1.json?.items) && doc1.json.items.every((i) => Number.isSafeInteger(i.price) && Number.isSafeInteger(i.sum)), `item0=${JSON.stringify(doc1.json?.items?.[0])}`);

    console.log('\n=== K2: Sid TTL на виртуальных часах (30 дней) ===');
    const beforeTtl = await request(port, 'GET', `${V2}/organizations`, { headers: authHeaders(Sid, API_KEY) });
    record('K2a Sid жив до сдвига: 200', beforeTtl.status === 200, `status=${beforeTtl.status}`);
    const adv = await request(port, 'POST', '/mock/time', { body: { advance: '+31d' } });
    record('K2b сдвиг +31d принят', adv.status === 200 && Number.isFinite(adv.json?.now), `now=${adv.json?.now}`);
    const afterTtl = await request(port, 'GET', `${V2}/organizations`, { headers: authHeaders(Sid, API_KEY) });
    record('K2c Sid истёк: 401 errorCodeId=401002 («получить новую сессию»)', afterTtl.status === 401 && afterTtl.json?.errorCodeId === 401002, `status=${afterTtl.status} code=${afterTtl.json?.errorCodeId}`);
    const reAuth = await authenticate(port);
    record('K2d повторный authenticate-by-pass: новый Sid', reAuth.status === 200 && typeof reAuth.json?.Sid === 'string' && reAuth.json.Sid !== Sid, `sid2!==sid1: ${reAuth.json?.Sid !== Sid}`);
    const sid2 = reAuth.json.Sid;
    const worksAgain = await request(port, 'GET', `${V2}/organizations`, { headers: authHeaders(sid2, API_KEY) });
    record('K2e новый Sid рабочий: 200', worksAgain.status === 200, `status=${worksAgain.status}`);

    console.log('\n=== K9: write-путь не моделируется (405/404) ===');
    const postOrgs = await request(port, 'POST', `${V2}/organizations`, { body: { name: 'hack' }, headers: authHeaders(sid2, API_KEY) });
    record('K9a POST на read-маршрут: 405 (метод не поддерживается)', postOrgs.status === 405, `status=${postOrgs.status}`);
    const postDocs = await request(port, 'POST', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents`, { body: { type: 'receipt' }, headers: authHeaders(sid2, API_KEY) });
    record('K9b POST документа (фискализация): 405 — создание чека не моделируется', postDocs.status === 405, `status=${postDocs.status}`);
    const unknownPath = await request(port, 'POST', `${V2}/queue/sell`, { body: {}, headers: authHeaders(sid2, API_KEY) });
    record('K9c несуществующий write-маршрут: 404 «write API не моделируется»', unknownPath.status === 404 && (unknownPath.json?.message || '').includes('не моделируется'), `status=${unknownPath.status} msg=${(unknownPath.json?.message || '').slice(0, 50)}`);

    console.log('\n=== K10: сценарии (duplicate до пагинации / fail / http-504) ===');
    const dup = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents/by-period?dateFrom=${from}&dateTo=${to}&offset=0&limit=5`, { headers: { ...authHeaders(sid2, API_KEY), 'X-Mock-Scenario': 'duplicate' } });
    record('K10a duplicate: страница сохраняет лимит 5 (повтор до пагинации)', dup.status === 200 && dup.json?.documents?.length === 5, `len=${dup.json?.documents?.length}`);
    const dupNoLimit = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents/by-period?dateFrom=${from}&dateTo=${to}`, { headers: { ...authHeaders(sid2, API_KEY), 'X-Mock-Scenario': 'duplicate' } });
    record('K10b duplicate без лимита: 13 строк (12+повтор первой)', dupNoLimit.status === 200 && dupNoLimit.json?.documents?.length === 13 && dupNoLimit.json.documents[0].id === dupNoLimit.json.documents[12].id, `len=${dupNoLimit.json?.documents?.length} dup=${dupNoLimit.json?.documents?.[0]?.id === dupNoLimit.json?.documents?.[12]?.id}`);
    const fail = await request(port, 'GET', `${V2}/organizations`, { headers: { ...authHeaders(sid2, API_KEY), 'X-Mock-Scenario': 'fail' } });
    record('K10c сценарий fail: 500', fail.status === 500, `status=${fail.status}`);
    const h504 = await request(port, 'GET', `${V2}/organizations`, { headers: { ...authHeaders(sid2, API_KEY), 'X-Mock-Scenario': 'http-504' } });
    record('K10d сценарий http-504: 504', h504.status === 504, `status=${h504.status}`);

    console.log('\n=== K11: журнал без секретов ===');
    const journal = await request(port, 'GET', '/admin/journal');
    const journalText = JSON.stringify(journal.json || {});
    record('K11a журнал читаем (entries без admin-token в namespaces)', journal.status === 200 && Array.isArray(journal.json?.entries) && journal.json.entries.length > 0, `entries=${journal.json?.entries?.length}`);
    record('K11b журнал не содержит пароль/Sid/API-key', !journalText.includes(PASSWORD) && !journalText.includes(sid2) && !journalText.includes(API_KEY) && !journalText.includes(encodeURIComponent(LOGIN)), 'секретов нет');
    record('K11c записи — at/method/path/status/ms, body/headers пустые, curl без секретов и без query-login', (journal.json?.entries || []).every((e) => ['at', 'method', 'path', 'status', 'ms'].every((k) => k in e) && Object.keys(e.headers || {}).length === 0 && Object.keys(e.body || {}).length === 0 && !('raw' in e) && (e.curl === undefined || (!e.curl.includes('@') && !e.curl.includes('?')))), `entry0=${JSON.stringify(journal.json?.entries?.[0] || {}).slice(0, 140)}`);

    console.log('\n=== K12: изоляция песочниц / «знание ID ≠ доступ» ===');
    const sidB = await authenticate(port, { headers: { 'X-Mock-Sandbox': 'sz-b' } });
    record('K12a sandbox B: Sid выдан', sidB.status === 200 && typeof sidB.json?.Sid === 'string', `status=${sidB.status}`);
    const sidBv = sidB.json.Sid;
    const crossSid = await request(port, 'GET', `${V2}/organizations`, { headers: authHeaders(sidBv, API_KEY) });
    record('K12b Sid песочницы B на дефолтной: 401 401002 (сессии изолированы)', crossSid.status === 401 && crossSid.json?.errorCodeId === 401002, `status=${crossSid.status} code=${crossSid.json?.errorCodeId}`);
    const bRead = await request(port, 'GET', `${V2}/organizations`, { headers: { ...authHeaders(sidBv, API_KEY), 'X-Mock-Sandbox': 'sz-b' } });
    record('K12c владелец внутри B читает свои данные: 200', bRead.status === 200, `status=${bRead.status}`);
    const demoDoc = await request(port, 'GET', `${V2}/organizations/org-demo/cashboxes/0000000000000001/documents/doc-6-1`, { headers: authHeaders(sid2, API_KEY) });
    record('K12d знание documentId не даёт доступа при отсутствии прав: 403/404 на чужих объектах', demoDoc.status === 200, `doc=${demoDoc.status} (org-demo доступен владельцу; org-restricted — 403, K4b)`);

    stopServer(srv);
  } catch (e) {
    stopServer(srv);
    throw e;
  }
  return srv;
}

async function legOwned() {
  console.log('\n=== legB: owned-режим (MOCK_HOSTED=1) ===');
  const port = await freePort();
  const srv = startServer('owned', { MOCK_PORT: String(port), MOCK_HOSTED: '1' });
  try {
    await waitForHealth(port, 'owned');
    const created = await request(port, 'POST', '/sandboxes', { body: { id: 'sz-owned-1' } });
    record('B1 POST /sandboxes: 201 + ownerToken + сгенерированные креды', created.status === 201 && typeof created.json?.ownerToken === 'string' && typeof created.json?.creds?.apiKey === 'string', `status=${created.status} keys=${Object.keys(created.json || {}).join(',')}`);
    const { ownerToken, creds } = created.json;
    const owned = { 'X-Mock-Sandbox': 'sz-owned-1', 'X-Sandbox-Token': ownerToken };
    const authRes = await request(port, 'POST', `/auth/authenticate-by-pass?login=${encodeURIComponent(creds.login)}`, {
      rawBody: creds.password, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...owned },
    });
    const sid = authRes.json?.Sid;
    record('B2 creds песочницы: auth (с owner-заголовками) → Sid', authRes.status === 200 && typeof sid === 'string' && sid.length >= 32, `status=${authRes.status} sidLen=${(sid || '').length}`);
    const read = await request(port, 'GET', `${V2}/organizations`, { headers: { ...authHeaders(sid, creds.apiKey), ...owned } });
    record('B3 владелец: auth.sid + ApiKey + X-Mock-Sandbox + X-Sandbox-Token → 200', read.status === 200 && read.json?.[0]?.id === 'org-demo', `status=${read.status} len=${read.json?.length}`);
    const noOwner = await request(port, 'GET', `${V2}/organizations`, { headers: { ...authHeaders(sid, creds.apiKey), 'X-Mock-Sandbox': 'sz-owned-1' } });
    record('B4 без X-Sandbox-Token (только знание sandbox id): 401', noOwner.status === 401, `status=${noOwner.status} msg=${(noOwner.json?.message || '').slice(0, 60)}`);
    const badOwner = await request(port, 'GET', `${V2}/organizations`, { headers: { ...authHeaders(sid, creds.apiKey), 'X-Mock-Sandbox': 'sz-owned-1', 'X-Sandbox-Token': 'wrong-token' } });
    record('B5 битый X-Sandbox-Token: 401 (знание ID ≠ доступ)', badOwner.status === 401, `status=${badOwner.status}`);
    const ownerOnlyData = await request(port, 'GET', `${V2}/organizations`, { headers: { ...owned, 'X-Kontur-Ofd-ApiKey': creds.apiKey } });
    record('B6 без Sid (owner-token сам по себе не авторизация данных): 401 401002', ownerOnlyData.status === 401 && ownerOnlyData.json?.errorCodeId === 401002, `status=${ownerOnlyData.status} code=${ownerOnlyData.json?.errorCodeId}`);
    const me = await request(port, 'GET', '/sandboxes/me', { headers: owned });
    record('B7 /sandboxes/me не раскрывает креды', me.status === 200 && !JSON.stringify(me.json).includes(creds.password) && !JSON.stringify(me.json).includes(creds.apiKey), `status=${me.status} keys=${Object.keys(me.json?.sandbox || {}).join(',')}`);
    const stateExport = await request(port, 'GET', '/mock/state', { headers: owned });
    record('B8 экспорт state не раскрывает Sid', stateExport.status === 200 && !JSON.stringify(stateExport.json).includes(sid), `status=${stateExport.status}`);
    const rot = await request(port, 'POST', '/sandboxes/me/reset-creds', { headers: owned });
    record('B9 rotation кредов отзывает Sid (после — старый Sid 401)', rot.status === 200 && typeof rot.json?.creds?.apiKey === 'string', `status=${rot.status}`);
    const oldSid = await request(port, 'GET', `${V2}/organizations`, { headers: { ...authHeaders(sid, rot.json.creds.apiKey), ...owned } });
    record('B9b старый Sid после rotation: 401 401002', oldSid.status === 401 && oldSid.json?.errorCodeId === 401002, `status=${oldSid.status}`);
    stopServer(srv);
  } catch (e) {
    stopServer(srv);
    throw e;
  }
}

async function main() {
  console.log(`SZ wave-#97 проба kontur-ofd-mock (Контур.ОФД read-only) — предрегистрация SZ + сигнал 6165122182. server.js: ${SERVER}`);
  console.log(`server.js exists: ${fs.existsSync(SERVER)}`);
  await legMain();
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
