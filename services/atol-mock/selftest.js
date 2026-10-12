// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Selftest atol-mock (issue #34): прямой API АТОЛ Онлайн v4 (ФФД 1.05).
 *
 * Покрыто (DoD #34):
 *   • happy-path: getToken -> sell (wait -> done, payload с ФД) -> report;
 *     возврат прихода (sell_refund), расход (buy), коррекции;
 *   • идемпотентность external_id: повтор -> ТОТ ЖЕ UUID, второй чек не создан
 *     (отличие от Ferma); дедуп в пределах группы;
 *   • callback: POST результата, повторная доставка, идемпотентный приём,
 *     ретрай на не-2xx, webhook-drop / webhook-duplicate, сверка через report;
 *   • негативы: неверные креды getToken, чужая группа, битые реквизиты ФФД
 *     (client без email/телефона, НДС, ИНН, арифметика, payments),
 *     отсутствующий/чужой/истёкший токен, битый JSON, длинный external_id;
 *   • сценарии fail/hang/latency/http-500/http-504 и правила /mock/scenarios;
 *   • виртуальные часы (ускорение печати, истечение токена 24 ч);
 *   • журнал (curl, редакция секретов), песочницы, /mock/state, /mock/reset,
 *     OpenAPI, страница чека, персистентность и control-plane (дочерние
 *     процессы), hosted-режим (свои креды АТОЛ и своя группа на песочницу).
 *
 * Zero dependencies. Запуск: node services/atol-mock/selftest.js
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCondition(predicate, { timeoutMs = 8000, intervalMs = 25, description = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); } else { failed += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

/* --------------------------------------------------- приёмник callback'ов */

const HITS = [];      // {path, uuid, externalId, status, body}
let flakyCount = 0;

const receiver = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    let uuid = '';
    let externalId = '';
    try {
      const payload = JSON.parse(buf);
      uuid = payload.uuid || '';
      externalId = payload.external_id || '';
    } catch { /* не-JSON */ }
    // /flaky отвечает 500 на первую доставку: проверяем ретрай и идемпотентность.
    if (req.url === '/flaky') flakyCount += 1;
    const isFail = req.url === '/flaky' && flakyCount === 1;
    HITS.push({ path: req.url, uuid, externalId, status: isFail ? 500 : 200, body: buf });
    res.writeHead(isFail ? 500 : 200, { 'Content-Type': 'application/json' });
    res.end(isFail ? '{"error":"first attempt fails"}' : '{"ok":true}');
  });
});

function listen(srv) {
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}

const hitsFor = (uuid) => HITS.filter((h) => h.uuid === uuid);

/* -------------------------------------------------------------- http-utils */

function request(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method,
      headers: {
        ...(data !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: out,
        json: () => { try { return JSON.parse(out); } catch { return null; } },
      }));
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

/** Запрос, которому разрешено не получить ответа (сценарий hang). */
function requestHang(port, method, p, body, headers = {}, waitMs = 700) {
  return new Promise((resolve) => {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method,
      headers: {
        ...(data !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, () => { /* ответа не ждём */ });
    const timer = setTimeout(() => { req.destroy(); resolve({ timedOut: true }); }, waitMs);
    req.on('error', () => { clearTimeout(timer); resolve({ timedOut: true, connectionError: true }); });
    req.on('close', () => { clearTimeout(timer); resolve({ timedOut: false, closedEarly: true }); });
    if (data !== null) req.write(data);
    req.end();
  });
}

/* ----------------------------------------------------------- домены v4 */

const GROUP = 'v4-online-atol-ru_4179';
let TOKEN = '';

/** POST /possystem/v4/{group}/{operation} с заголовком Token (контракт v4). */
const register = (port, operation, body, headers = {}) => request(port, 'POST', `/possystem/v4/${GROUP}/${operation}`, body, { Token: TOKEN, ...headers });
const report = (port, uuid, group = GROUP) => request(port, 'GET', `/possystem/v4/${group}/report/${uuid}`, undefined, { Token: TOKEN });

/**
 * Реквизиты ФФД 1.05: decimal-рубли, client с контактом, company с ИНН/адресом.
 * `overrides` — частичная замена receipt для негативных проверок.
 */
function receipt(overrides = {}) {
  return {
    client: { email: 'buyer@example.test' },
    company: { email: 'kassa@example.test', inn: '5544332219', payment_address: 'https://v4.online.atol.ru', sno: 'usn_income' },
    items: [{ name: 'Кофе латте', price: 120.50, quantity: 2, sum: 241, payment_method: 'full_payment', payment_object: 'commodity', vat: 'vat120' }],
    payments: [{ type: 1, sum: 241 }],
    total: 241,
    ...overrides,
  };
}

const doc = (externalId, operation = 'sell', receiptOverrides = {}, extra = {}) => ({
  external_id: externalId,
  timestamp: '12.10.2026 10:00:00',
  receipt: receipt(receiptOverrides),
  ...extra,
});

async function getToken(port, login = 'v4-online-atol-ru', pass = 'iGFFuihss') {
  const r = await request(port, 'POST', '/possystem/v4/getToken', { login, pass });
  const json = r.json() || {};
  return { status: r.statusCode, token: json.token || '', error: json.error || null };
}

/** Проверка provider-shaped ошибки: {error:{code,text,type,error_id}} + DX hint/doc. */
function checkError(name, r, { code, field, status = 200 } = {}) {
  const j = r.json() || {};
  const e = j.error;
  check(`${name}: provider-shaped error (code=${code})`, r.statusCode === status && Boolean(e) && e.code === code,
    `got ${r.statusCode} ${r.body.slice(0, 160)}`);
  if (!e) return;
  if (field !== undefined) check(`${name}: field=${field}`, e.field === field, `got ${JSON.stringify(e.field)}`);
  check(`${name}: type + error_id + DX hint/doc`, Boolean(e.type) && Boolean(e.error_id) && Boolean(e.hint)
    && String(e.doc || '').includes('atol.online'),
    JSON.stringify({ type: e.type, hint: e.hint && e.hint.slice(0, 40), doc: e.doc }));
}

function startChild(env = {}) {
  const proc = spawn('node', [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      MOCK_HOST: '127.0.0.1',
      MOCK_PORT: '0',
      MOCK_STATE_FILE: '',
      MOCK_DEFAULT_CALLBACK_URL: '',
      MOCK_CALLBACK_RETRY_MS: '1000',
      MOCK_CALLBACK_MAX_ATTEMPTS: '5',
      MOCK_ADMIN_TOKEN: '',
      MOCK_OPERATOR_TOKEN: '',
      MOCK_HOSTED: '',
      MOCK_BLOCK_PRIVATE_WEBHOOKS: '',
      MOCK_TENANCY: '',
      MOCK_SANDBOX_TOKEN: '',
      MOCK_SANDBOX_TTL_MS: '',
      MOCK_SANDBOX_MAX: '',
      MOCK_SANDBOX_MAX_DOCUMENTS: '',
      MOCK_SANDBOX_RETENTION_MS: '',
      MOCK_SANDBOX_HOST_SUFFIX: '',
      MOCK_SANDBOX_CREATE_LIMIT: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let fullLog = '';
  proc.stdout.on('data', (d) => { fullLog += String(d); });
  proc.stderr.on('data', (d) => { fullLog += String(d); });
  const port = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`дочерний стенд не сообщил порт: ${fullLog.slice(0, 300)}`)), 6000);
    const tryResolve = () => {
      const m = /on http:\/\/[^:]+:(\d+)/.exec(fullLog);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); return true; }
      return false;
    };
    if (!tryResolve()) {
      const poll = setInterval(() => { if (tryResolve()) clearInterval(poll); }, 50);
      proc.once('exit', (code) => { clearInterval(poll); clearTimeout(timer); reject(new Error(`дочерний стенд завершился с кодом ${code}: ${fullLog.slice(0, 300)}`)); });
    }
  });
  return { proc, port, output: () => fullLog, stop: () => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } } };
}

/* ------------------------------------------------------------------- main */

async function main() {
  const receiverPort = await listen(receiver);
  const hookUrl = `http://127.0.0.1:${receiverPort}/hook`;
  const flakyUrl = `http://127.0.0.1:${receiverPort}/flaky`;

  // env ДО require: конфиг читается при загрузке модуля.
  process.env.MOCK_STATE_FILE = '';
  process.env.MOCK_PUBLIC_BASE_URL = 'http://mock.test';
  process.env.MOCK_CALLBACK_RETRY_MS = '1000';
  process.env.MOCK_CALLBACK_MAX_ATTEMPTS = '5';
  // Задержка печати — как в доках стенда: wait -> done управляется
  // виртуальными часами (advance +20s), а не реальным ожиданием
  // (дефлак, CONTRIBUTING §5).
  process.env.MOCK_PROCESS_MS = '15000';

  const mod = require('./server.js');
  const { server, state, sandboxRuntime } = mod;
  const port = await listen(server);

  console.log(`\n== atol-mock selftest on :${port} (АТОЛ Онлайн direct API v4, ФФД 1.05) ==\n`);

  try {
    /* ------------------------------------------- health / OpenAPI / креды */
    console.log('— health, OpenAPI, публичные тестовые реквизиты v4');
    const health = await request(port, 'GET', '/health');
    check('health 200 ok', health.statusCode === 200 && health.json().ok === true);
    check('health: api=v4, ffd=1.05, группы и TTL токена', health.json().api === 'v4' && health.json().ffd === '1.05'
      && health.json().groups.includes(GROUP) && health.json().tokenTtlHours === 24, JSON.stringify(health.json()));
    check('health: счётчики документов', typeof health.json().documents === 'number' && typeof health.json().waiting === 'number');

    const openapi = await request(port, 'GET', '/openapi.json');
    check('/openapi.json отдаёт OpenAPI 3.1 с маршрутами v4',
      openapi.statusCode === 200 && openapi.json().openapi === '3.1.0'
      && Boolean(openapi.json().paths['/possystem/v4/getToken'])
      && Boolean(openapi.json().paths['/possystem/v4/{group}/report/{uuid}']));

    check('дефолт мока — публичные тестовые реквизиты v4',
      mod.ATOL_LOGIN_CRED === 'v4-online-atol-ru' && mod.ATOL_PASSWORD_CRED === 'iGFFuihss' && mod.ATOL_GROUP_CRED === GROUP,
      `${mod.ATOL_LOGIN_CRED}/${mod.ATOL_GROUP_CRED}`);

    /* ---------------------------------------------------- getToken (auth) */
    console.log('— getToken: авторизация v4');
    const badPass = await getToken(port, 'v4-online-atol-ru', 'wrong-pass');
    checkError('неверный пароль', { statusCode: badPass.status, body: JSON.stringify({ error: badPass.error }), json: () => ({ error: badPass.error }) }, { code: 14, field: 'login, pass' });

    const badLogin = await getToken(port, 'v5-online-atol-ru', 'iGFFuihss');
    check('неверный login (креды v5 против стенда v4) -> code 14', badLogin.error && badLogin.error.code === 14);

    const noCreds = await request(port, 'POST', '/possystem/v4/getToken', {});
    check('пустые креды -> code 14', noCreds.statusCode === 200 && noCreds.json().error.code === 14);

    const okToken = await getToken(port);
    check('getToken выдаёт токен', okToken.status === 200 && okToken.token.length >= 16, okToken.token);
    check('getToken: ответ без error', okToken.error === null);
    TOKEN = okToken.token;

    /* ------------------------------------------- регистрация документа: sell */
    console.log('— sell: wait -> done, payload с ФД/ФП/ФН/ККТ');
    const sellBody = doc('st-sell-1', 'sell', {}, { service: { callback_url: hookUrl } });
    const sell = await register(port, 'sell', sellBody);
    const sellUuid = sell.json().uuid;
    check('sell принят: {uuid, status:"wait"}', sell.statusCode === 200 && Boolean(sellUuid) && sell.json().status === 'wait'
      && sell.json().error === null, sell.body.slice(0, 160));

    const repWait = await report(port, sellUuid);
    check('report до печати: status=wait, payload=null', repWait.json().status === 'wait' && repWait.json().payload === null);
    check('report: эхо external_id/group/type', repWait.json().external_id === 'st-sell-1'
      && repWait.json().group_code === GROUP && repWait.json().type === 'sell');

    const earlyReceipt = await request(port, 'GET', `/receipts/${sellUuid}`);
    check('страница чека до печати объясняет, что документ ещё в очереди',
      earlyReceipt.statusCode === 200 && earlyReceipt.json().error.code === 10);

    // Виртуальные часы ускоряют очередь обработки (дефлак: без sleep-ожиданий).
    const adv = await request(port, 'POST', '/mock/time', { advance: '+20s' });
    check('POST /mock/time advance +20s', adv.statusCode === 200 && adv.json().offsetMs > 0);
    await waitForCondition(async () => (await report(port, sellUuid)).json().status === 'done', { description: 'sell wait -> done' });

    const repDone = await report(port, sellUuid);
    const payload = repDone.json().payload;
    check('report после печати: status=done', repDone.json().status === 'done');
    check('payload: ФД и ФП', payload && Number.isFinite(payload.fiscal_document_number) && /^\d{10}$/.test(String(payload.fiscal_document_attribute)),
      JSON.stringify(payload && { fd: payload.fiscal_document_number, fp: payload.fiscal_document_attribute }));
    check('payload: номер ФН и ККТ', payload && /^\d{14,16}$/.test(String(payload.fn_number)) && /^\d{16}$/.test(String(payload.ecr_registration_number)),
      JSON.stringify(payload && { fn: payload.fn_number, kkt: payload.ecr_registration_number }));
    check('payload: смена, номер чека, дата', payload && payload.shift_number > 0 && payload.fiscal_receipt_number > 0
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(payload.receipt_datetime));
    check('payload: ofd_receipt_url ведёт на страницу чека',
      payload && String(payload.ofd_receipt_url).endsWith(`/receipts/${sellUuid}`), payload && payload.ofd_receipt_url);
    check('payload: total в decimal-рублях и СНО', payload && payload.total === '241.00' && payload.taxation_type === 'usn_income',
      JSON.stringify(payload && { total: payload.total, sno: payload.taxation_type }));
    check('payload: vat_amounts по ставке vat120 (20/120)',
      payload && payload.vat_amounts.length === 1 && payload.vat_amounts[0].type === 'vat120'
      && payload.vat_amounts[0].tax === '40.17' && payload.vat_amounts[0].gross === '241.00',
      JSON.stringify(payload && payload.vat_amounts));

    const receiptPage = await request(port, 'GET', `/receipts/${sellUuid}`);
    check('страница чека /receipts/{uuid} отдаёт ленту с ФД/ФП',
      receiptPage.statusCode === 200 && receiptPage.body.includes(String(payload.fiscal_document_number))
      && receiptPage.body.includes('НЕ ОТПРАВЛЯЕТСЯ В ФНС'));

    /* --------------------------------------------------- callback (doнe) */
    console.log('— callback: POST результата, ретраи, дубли, идемпотентный приём');
    await waitForCondition(() => hitsFor(sellUuid).length >= 1, { description: 'callback после done' });
    const cb = hitsFor(sellUuid)[0];
    const cbPayload = JSON.parse(cb.body);
    check('callback доставлен POST-ом на service.callback_url', cb.path === '/hook' && cb.status === 200);
    check('callback: тело = результат документа (uuid/external_id/status)',
      cbPayload.uuid === sellUuid && cbPayload.external_id === 'st-sell-1' && cbPayload.status === 'done');
    check('callback: payload с ФД — сверяется с report',
      cbPayload.payload && cbPayload.payload.fiscal_document_number === payload.fiscal_document_number
      && cbPayload.payload.fiscal_document_attribute === payload.fiscal_document_attribute);
    check('callback: error=null при успехе', cbPayload.error === null);
    check('callback: подпись в тело не добавляется (v4 её не предусматривает)',
      !/signature|"sign"|hmac/i.test(cb.body), cb.body.slice(0, 120));
    check('report и callback согласованы (сверка через report)',
      (await report(port, sellUuid)).json().payload.fiscal_document_attribute === cbPayload.payload.fiscal_document_attribute);

    // Ретрай на не-2xx: приёмник /flaky отвечает 500 на первую доставку.
    const flakySell = await register(port, 'sell', doc('st-flaky-1', 'sell', {}, { service: { callback_url: flakyUrl } }));
    const flakyUuid = flakySell.json().uuid;
    await request(port, 'POST', '/mock/time', { advance: '+20s' });
    await waitForCondition(async () => (await report(port, flakyUuid)).json().status === 'done', { description: 'flaky doc done' });
    await waitForCondition(() => hitsFor(flakyUuid).length >= 2, { timeoutMs: 8000, description: 'ретрай callback после 500' });
    const flakyHits = hitsFor(flakyUuid);
    check('callback на 500 повторяется (ретрай до 2xx)', flakyHits.length >= 2 && flakyHits[0].status === 500
      && flakyHits[flakyHits.length - 1].status === 200,
      JSON.stringify(flakyHits.map((h) => h.status)));
    check('идемпотентный приём: обе доставки одного документа (тот же uuid)',
      flakyHits.every((h) => h.uuid === flakyUuid));

    // Повторная доставка дублем (приёмник обязан быть идемпотентным).
    const dupSell = await register(port, 'sell', doc('st-dup-1', 'sell', {}, { service: { callback_url: hookUrl } }),
      { 'X-Mock-Scenario': 'webhook-duplicate' });
    const dupUuid = dupSell.json().uuid;
    await request(port, 'POST', '/mock/time', { advance: '+20s' });
    await waitForCondition(() => hitsFor(dupUuid).length >= 2, { timeoutMs: 8000, description: 'две копии callback' });
    check('webhook-duplicate: две копии результата (приёмник должен быть идемпотентен)',
      hitsFor(dupUuid).length === 2 && hitsFor(dupUuid)[0].uuid === hitsFor(dupUuid)[1].uuid,
      `получено ${hitsFor(dupUuid).length}`);

    // Подавление callback сценарием: результат доступен только через report.
    const dropSell = await register(port, 'sell', doc('st-drop-1', 'sell', {}, { service: { callback_url: hookUrl } }),
      { 'X-Mock-Scenario': 'webhook-drop' });
    const dropUuid = dropSell.json().uuid;
    await request(port, 'POST', '/mock/time', { advance: '+20s' });
    await waitForCondition(async () => (await report(port, dropUuid)).json().status === 'done', { description: 'drop doc done' });
    check('webhook-drop: callback подавлен, но report отдаёт результат',
      hitsFor(dropUuid).length === 0 && (await report(port, dropUuid)).json().status === 'done',
      `доставок: ${hitsFor(dropUuid).length}`);

    // Без service.callback_url документ обрабатывается, результат — через report.
    const noCb = await register(port, 'sell', doc('st-nocb-1'));
    await request(port, 'POST', '/mock/time', { advance: '+20s' });
    await waitForCondition(async () => (await report(port, noCb.json().uuid)).json().status === 'done', { description: 'no-callback doc done' });
    check('без service.callback_url: докумнт обработан, callback не отправляется',
      hitsFor(noCb.json().uuid).length === 0 && (await report(port, noCb.json().uuid)).json().status === 'done');

    /* --------------------------------------- идемпотентность external_id */
    console.log('— идемпотентность external_id: повтор -> тот же UUID (НЕ ошибка)');
    const firstCount = Object.keys(state.documents).length;
    const replay = await register(port, 'sell', doc('st-sell-1', 'sell', { total: 999, payments: [{ type: 1, sum: 999 }], items: [{ name: 'Другое', price: 999, quantity: 1, sum: 999, vat: 'vat20' }] }));
    const replayJson = replay.json();
    check('повтор того же external_id НЕ ошибка (error=null)', replay.statusCode === 200 && replayJson.error === null,
      replay.body.slice(0, 160));
    check('повтор вернул ТОТ ЖЕ uuid', replayJson.uuid === sellUuid, `${replayJson.uuid} vs ${sellUuid}`);
    check('второй чек не создан (число документов не выросло)', Object.keys(state.documents).length === firstCount,
      `${firstCount} -> ${Object.keys(state.documents).length}`);
    check('повтор помечен заголовком X-Mock-Replayed', replay.headers['x-mock-replayed'] === '1');
    check('повтор объясняет, что тело проигнорировано (DX hint)',
      typeof replayJson.hint === 'string' && replayJson.hint.includes('проигнорировано'), String(replayJson.hint).slice(0, 80));
    check('повтор вернул актуальный статус документа (done, а не wait)', replayJson.status === 'done', replayJson.status);

    // Тот же external_id в другой разрешённой группе — это ДРУГОЙ документ
    // (уникальность external_id ограничена группой).
    const secondGroup = 'Shop-2';
    await request(port, 'POST', '/sandboxes', { sandbox: 'default' });
    const beforeGroups = state.documents;
    const childMulti = startChild({ MOCK_GROUPS: `${GROUP},Shop-2` });
    try {
      const mPort = await childMulti.port;
      const mToken = (await getToken(mPort)).token;
      const g1 = await request(mPort, 'POST', `/possystem/v4/${GROUP}/sell`, doc('st-multi-1'), { Token: mToken });
      const g2 = await request(mPort, 'POST', `/possystem/v4/Shop-2/sell`, doc('st-multi-1'), { Token: mToken });
      check('один external_id в двух группах — два разных документа',
        g1.json().uuid && g2.json().uuid && g1.json().uuid !== g2.json().uuid,
        `${g1.json().uuid} / ${g2.json().uuid}`);
      check('повтор в своей группе возвращает свой uuid',
        (await request(mPort, 'POST', `/possystem/v4/Shop-2/sell`, doc('st-multi-1'), { Token: mToken })).json().uuid === g2.json().uuid);
      check('отчёт в чужой группе — документ не найден (code 10)',
        (await request(mPort, 'GET', `/possystem/v4/Shop-2/report/${g1.json().uuid}`, undefined, { Token: mToken })).json().error.code === 10);
    } finally {
      childMulti.stop();
    }
    check('песочница default не изменилась от дочернего прогона', state.documents === beforeGroups);

    /* ------------------------------------------------ остальные операции */
    console.log('— операции v4: возврат прихода, расход, коррекции');
    const refund = await register(port, 'sell_refund', doc('st-refund-1', 'sell_refund', {
      items: [{ name: 'Кофе латте', price: 120.50, quantity: 1, sum: 120.50, payment_method: 'full_payment', payment_object: 'commodity', vat: 'vat120' }],
      payments: [{ type: 1, sum: 120.50 }],
      total: 120.50,
    }, { service: { callback_url: hookUrl } }));
    check('sell_refund принят в очередь', refund.statusCode === 200 && refund.json().status === 'wait');
    const refundUuid = refund.json().uuid;
    await request(port, 'POST', '/mock/time', { advance: '+20s' });
    await waitForCondition(async () => (await report(port, refundUuid)).json().status === 'done', { description: 'sell_refund done' });
    const refundRep = await report(port, refundUuid);
    check('sell_refund напечатан: payload.total = 120.50', refundRep.json().status === 'done'
      && refundRep.json().payload.total === '120.50' && refundRep.json().type === 'sell_refund');
    await waitForCondition(() => hitsFor(refundUuid).some((h) => JSON.parse(h.body).status === 'done'), { description: 'callback возврата' });
    check('callback возврата доставлен', hitsFor(refundUuid).length >= 1);

    const buy = await register(port, 'buy', doc('st-buy-1', 'buy', {
      client: { phone: '+79991112233' },
      items: [{ name: 'Выплата поставщику', price: '50.00', quantity: 1, sum: '50.00', payment_object: 'service', vat: 'none' }],
      payments: [{ type: 0, sum: '50.00' }],
      total: '50.00',
    }));
    check('buy (расход) принят: decimal-строки и наличные type=0', buy.statusCode === 200 && buy.json().status === 'wait');
    const buyUuid = buy.json().uuid;
    await request(port, 'POST', '/mock/time', { advance: '+20s' });
    await waitForCondition(async () => (await report(port, buyUuid)).json().status === 'done', { description: 'buy done' });
    check('buy напечатан, в ленте «НАЛИЧНЫМИ»', (await report(port, buyUuid)).json().status === 'done'
      && (await request(port, 'GET', `/receipts/${buyUuid}`)).body.includes('НАЛИЧНЫМИ'));

    for (const operation of ['sell_correction', 'buy_refund', 'buy_correction']) {
      const r = await register(port, operation, doc(`st-${operation}-1`, operation, {
        items: [{ name: 'Корректировка', price: 10, quantity: 1, sum: 10, vat: 'vat20' }],
        payments: [{ type: 1, sum: 10 }],
        total: 10,
      }, { correction_info: { type: 'self', base_date: '11.10.2026' } }));
      check(`${operation} принят в очередь`, r.statusCode === 200 && r.json().status === 'wait', r.body.slice(0, 140));
      await request(port, 'POST', '/mock/time', { advance: '+20s' });
      const uuid = r.json().uuid;
      await waitForCondition(async () => (await report(port, uuid)).json().status === 'done', { description: `${operation} done` });
      check(`${operation} напечатан`, (await report(port, uuid)).json().status === 'done');
    }

    /* --------------------------------------------------- негативы (DoD) */
    console.log('— негативы: группа, реквизиты ФФД, токены, формат');
    const wrongGroup = await request(port, 'POST', '/possystem/v4/wrong-group/sell', doc('st-neg-group'), { Token: TOKEN });
    checkError('чужая группа', wrongGroup, { code: 4, field: 'group_code' });

    const noClient = await register(port, 'sell', doc('st-neg-1', 'sell', { client: {} }));
    checkError('client без email и телефона', noClient, { code: 4, field: 'receipt.client' });

    const badEmail = await register(port, 'sell', doc('st-neg-2', 'sell', { client: { email: 'не-почта' } }));
    checkError('client.email некорректный', badEmail, { code: 4, field: 'receipt.client.email' });

    const badPhone = await register(port, 'sell', doc('st-neg-3', 'sell', { client: { phone: '12345' } }));
    checkError('client.phone некорректный', badPhone, { code: 4, field: 'receipt.client.phone' });

    const noCompany = await register(port, 'sell', doc('st-neg-4', 'sell', { company: undefined }));
    checkError('нет company', noCompany, { code: 4, field: 'receipt.company' });

    const badInn = await register(port, 'sell', doc('st-neg-5', 'sell', { company: { email: 'k@example.test', inn: '123', payment_address: 'x' } }));
    checkError('company.inn из 3 цифр', badInn, { code: 4, field: 'receipt.company.inn' });

    const noAddress = await register(port, 'sell', doc('st-neg-6', 'sell', { company: { email: 'k@example.test', inn: '5544332219' } }));
    checkError('нет company.payment_address', noAddress, { code: 4, field: 'receipt.company.payment_address' });

    const badSno = await register(port, 'sell', doc('st-neg-7', 'sell', { company: { email: 'k@example.test', inn: '5544332219', payment_address: 'x', sno: 'usn' } }));
    checkError('неизвестная СНО', badSno, { code: 4, field: 'receipt.company.sno' });

    const noItems = await register(port, 'sell', doc('st-neg-8', 'sell', { items: [] }));
    checkError('пустой items', noItems, { code: 4, field: 'receipt.items' });

    const badVat = await register(port, 'sell', doc('st-neg-9', 'sell', {
      items: [{ name: 'X', price: 10, quantity: 1, sum: 10, vat: 'vat99' }], payments: [{ type: 1, sum: 10 }], total: 10,
    }));
    checkError('неизвестная ставка НДС', badVat, { code: 4, field: 'receipt.items[0].vat' });

    const fermaVat = await register(port, 'sell', doc('st-neg-10', 'sell', {
      items: [{ name: 'X', price: 10, quantity: 1, sum: 10, vat: 'vat20_120' }], payments: [{ type: 1, sum: 10 }], total: 10,
    }));
    checkError('Ferma-синтаксис vat20_120 отклонён с подсказкой про vat120', fermaVat, { code: 4, field: 'receipt.items[0].vat' });
    check('hint объясняет запись расчётной ставки v4',
      String((fermaVat.json().error || {}).hint || '').includes('vat120'), String((fermaVat.json().error || {}).hint));

    const noVat = await register(port, 'sell', doc('st-neg-11', 'sell', {
      items: [{ name: 'X', price: 10, quantity: 1, sum: 10 }], payments: [{ type: 1, sum: 10 }], total: 10,
    }));
    checkError('нет vat у позиции', noVat, { code: 4, field: 'receipt.items[0].vat' });

    const badArith = await register(port, 'sell', doc('st-neg-12', 'sell', {
      items: [{ name: 'X', price: 10, quantity: 3, sum: 10, vat: 'vat20' }], payments: [{ type: 1, sum: 10 }], total: 10,
    }));
    checkError('sum ≠ price × quantity', badArith, { code: 4, field: 'receipt.items[0].sum' });

    const badTotal = await register(port, 'sell', doc('st-neg-13', 'sell', {
      items: [{ name: 'X', price: 10, quantity: 1, sum: 10, vat: 'vat20' }], payments: [{ type: 1, sum: 10 }], total: 11,
    }));
    checkError('total ≠ сумме позиций', badTotal, { code: 4, field: 'receipt.total' });

    const badPayments = await register(port, 'sell', doc('st-neg-14', 'sell', {
      items: [{ name: 'X', price: 10, quantity: 1, sum: 10, vat: 'vat20' }], payments: [{ type: 1, sum: 5 }], total: 10,
    }));
    checkError('Σ оплат ≠ итогу', badPayments, { code: 4, field: 'receipt.payments' });

    const fermaPayType = await register(port, 'sell', doc('st-neg-15', 'sell', {
      items: [{ name: 'X', price: 10, quantity: 1, sum: 10, vat: 'vat20' }], payments: [{ type: 5, sum: 10 }], total: 10,
    }));
    checkError('payments.type=5 (Ferma) отклонён', fermaPayType, { code: 4, field: 'receipt.payments[0].type' });
    check('hint объясняет формы расчёта v4 (ФФД 1081)',
      String((fermaPayType.json().error || {}).hint || '').includes('1081'));

    const threeDecimals = await register(port, 'sell', doc('st-neg-16', 'sell', {
      items: [{ name: 'X', price: '10.005', quantity: 1, sum: '10.005', vat: 'vat20' }], payments: [{ type: 1, sum: '10.005' }], total: '10.005',
    }));
    checkError('цена с 3 знаками после запятой', threeDecimals, { code: 4, field: 'receipt.items[0].price' });

    const noExternal = await request(port, 'POST', `/possystem/v4/${GROUP}/sell`, { receipt: receipt() }, { Token: TOKEN });
    checkError('нет external_id', noExternal, { code: 5, field: 'external_id' });

    const longExternal = await register(port, 'sell', doc(`x${'y'.repeat(200)}`));
    checkError('external_id длиннее 128 символов', longExternal, { code: 5, field: 'external_id' });

    const badTimestamp = await register(port, 'sell', { ...doc('st-neg-17'), timestamp: '2026-10-12T10:00:00Z' });
    checkError('timestamp не в формате dd.mm.yyyy HH:MM:SS', badTimestamp, { code: 4, field: 'timestamp' });

    const brokenJson = await request(port, 'POST', `/possystem/v4/${GROUP}/sell`, '{"external_id":', { Token: TOKEN });
    checkError('битый JSON в теле', brokenJson, { code: 4 });

    const noToken = await request(port, 'POST', `/possystem/v4/${GROUP}/sell`, doc('st-neg-18'));
    checkError('нет заголовка Token', noToken, { code: 11, field: 'Token' });
    check('hint подсказывает отличие v4 от Ferma (?token=)',
      String((noToken.json().error || {}).hint || '').includes('?token='));

    const alienToken = await request(port, 'POST', `/possystem/v4/${GROUP}/sell`, doc('st-neg-19'), { Token: 'deadbeefdeadbeef' });
    checkError('чужой/неизвестный токен', alienToken, { code: 11, field: 'Token' });

    const fermaStyle = await request(port, 'POST', `/possystem/v4/${GROUP}/sell?token=${TOKEN}`, doc('st-neg-20'));
    checkError('токен в query (Ferma-стиль) в v4 не работает', fermaStyle, { code: 11 });

    const notFound = await report(port, 'not-a-uuid');
    checkError('report: неизвестный uuid', notFound, { code: 10, field: 'uuid' });

    const reportNoToken = await request(port, 'GET', `/possystem/v4/${GROUP}/report/${sellUuid}`);
    checkError('report без токена', reportNoToken, { code: 11 });

    const method405 = await request(port, 'GET', `/possystem/v4/${GROUP}/sell`, undefined, { Token: TOKEN });
    checkError('GET на маршруте регистрации -> 405', method405, { code: 4, status: 405 });

    const unknownRoute = await request(port, 'GET', '/possystem/v1/getToken');
    checkError('маршрут Ferma /possystem/v1 не обслуживается', unknownRoute, { code: 404, status: 404 });

    /* ------------------------------------------- отказ печати и hang */
    console.log('— сценарии: fail (отказ печати), hang, latency, http-500/504');
    const failDoc = await register(port, 'sell', doc('fail-st-1', 'sell', {}, { service: { callback_url: hookUrl } }),
      { 'X-Mock-Scenario': 'fail' });
    const failUuid = failDoc.json().uuid;
    check('сценарий fail: документ принят в очередь', failDoc.statusCode === 200 && failDoc.json().status === 'wait');
    await request(port, 'POST', '/mock/time', { advance: '+20s' });
    await waitForCondition(async () => (await report(port, failUuid)).json().status === 'fail', { description: 'fail -> status fail' });
    const failRep = await report(port, failUuid);
    check('report: status=fail, error.code=57, payload=null',
      failRep.json().status === 'fail' && failRep.json().error.code === 57 && failRep.json().payload === null,
      JSON.stringify(failRep.json().error));
    check('report: error несёт code/text/type/error_id (не сводится к HTTP-коду)',
      failRep.json().error.text && failRep.json().error.type === 'system'
      && /^[0-9a-f-]{36}$/.test(String(failRep.json().error.error_id)),
      JSON.stringify(failRep.json().error));
    await waitForCondition(() => hitsFor(failUuid).length >= 1, { description: 'callback об отказе' });
    const failCb = JSON.parse(hitsFor(failUuid)[0].body);
    check('callback об отказе: status=fail и error (не «молчаливый» успех)',
      failCb.status === 'fail' && failCb.error && failCb.error.code === 57 && failCb.payload === null);

    const prefixFail = await register(port, 'sell', doc('fail-st-2'));
    const prefixFailUuid = prefixFail.json().uuid;
    await request(port, 'POST', '/mock/time', { advance: '+20s' });
    await waitForCondition(async () => (await report(port, prefixFailUuid)).json().status === 'fail', { description: 'fail- prefix' });
    check('external_id с префиксом fail- -> отказ печати', (await report(port, prefixFailUuid)).json().error.code === 57);

    const hangDoc = await register(port, 'sell', doc('hang-st-1', 'sell', {}, { service: { callback_url: hookUrl } }));
    const hangUuid = hangDoc.json().uuid;
    await request(port, 'POST', '/mock/time', { advance: '+60s' });
    check('external_id с префиксом hang- -> вечный wait, callback не уходит',
      (await report(port, hangUuid)).json().status === 'wait' && hitsFor(hangUuid).length === 0);

    const startedLatency = Date.now();
    await register(port, 'sell', doc('st-latency-1'), { 'X-Mock-Latency': '300' });
    check('X-Mock-Latency 300ms выдержан', Date.now() - startedLatency >= 300, `${Date.now() - startedLatency}ms`);

    const http500 = await register(port, 'sell', doc('st-500-1'), { 'X-Mock-Scenario': 'http-500' });
    checkError('chaos http-500 (системный сбой) -> 500 provider-shaped', http500, { code: 500, status: 500 });
    check('hint советует паузу ≥1 с и сверку через report (рекомендация v4)',
      String((http500.json().error || {}).hint || '').includes('1 с'));

    const http504 = await register(port, 'sell', doc('st-504-1'), { 'X-Mock-Scenario': 'http-504' });
    checkError('chaos http-504 -> 504 provider-shaped', http504, { code: 500, status: 504 });

    const hangRequest = await requestHang(port, 'POST', `/possystem/v4/${GROUP}/sell`, doc('st-hang-req'),
      { Token: TOKEN, 'X-Mock-Scenario': 'hang' });
    check('сценарий hang на запросе: ответа нет (клиент должен таймаутить)',
      hangRequest.timedOut || hangRequest.closedEarly || hangRequest.connectionError, JSON.stringify(hangRequest));

    const ruleAdd = await request(port, 'POST', '/mock/scenarios', { scenario: 'fail', times: 1 });
    check('правило сценария добавлено', ruleAdd.statusCode === 200 && ruleAdd.json().ok === true);
    const ruleDoc = await register(port, 'sell', doc('st-rule-1'));
    const ruleUuid = ruleDoc.json().uuid;
    await request(port, 'POST', '/mock/time', { advance: '+20s' });
    await waitForCondition(async () => (await report(port, ruleUuid)).json().status === 'fail', { description: 'rule fail' });
    check('правило /mock/scenarios сработало (fail)', (await report(port, ruleUuid)).json().status === 'fail');
    const ruleMiss = await register(port, 'sell', doc('st-rule-2'));
    const ruleMissUuid = ruleMiss.json().uuid;
    await request(port, 'POST', '/mock/time', { advance: '+20s' });
    await waitForCondition(async () => (await report(port, ruleMissUuid)).json().status === 'done', { description: 'rule consumed' });
    check('правило израсходовано (times:1)', (await report(port, ruleMissUuid)).json().status === 'done');
    const scenList = await request(port, 'GET', '/mock/scenarios');
    check('история триггеров непустая', Array.isArray(scenList.json().history) && scenList.json().history.length > 0);
    await request(port, 'DELETE', '/mock/scenarios');
    const scenAfter = await request(port, 'GET', '/mock/scenarios');
    check('правила очищены', scenAfter.statusCode === 200 && scenAfter.json().rules.length === 0 && scenAfter.json().history.length === 0);

    /* ------------------------------------------- журнал, admin, песочницы */
    console.log('— журнал, админ-консоль, песочницы, state/reset');
    const journalResp = await request(port, 'GET', '/admin/journal');
    const entries = journalResp.json().entries;
    check('journal: есть записи /possystem/v4', journalResp.statusCode === 200 && Array.isArray(entries)
      && entries.some((e) => String(e.path).startsWith('/possystem/v4/')));
    const jEntry = entries.find((e) => e.method === 'POST' && String(e.path).includes('/sell'));
    check('journal: curl-сниппет для воспроизведения', Boolean(jEntry && String(jEntry.curl || '').includes('curl')));
    const journalRaw = JSON.stringify(entries);
    check('journal: пароль и токены не утекают (F-09)',
      !journalRaw.includes('iGFFuihss') && !journalRaw.includes(TOKEN), 'в журнале найден секрет');
    check('journal: e-mail покупателя маскирован (F-09)', !journalRaw.includes('buyer@example.test'));

    const adminPage = await request(port, 'GET', '/admin');
    check('admin: HTML-консоль с документами и callback', adminPage.statusCode === 200
      && adminPage.body.includes('АТОЛ Онлайн direct API v4') && adminPage.body.includes('Callback'));

    const sw = await request(port, 'POST', '/sandboxes', { sandbox: 'iso-a' });
    check('переключение на песочницу iso-a', sw.statusCode === 200 && sw.json().current === 'iso-a');
    const isoToken = (await getToken(port)).token;
    const isoSell = await request(port, 'POST', `/possystem/v4/${GROUP}/sell`, doc('st-iso-1'), { Token: isoToken });
    check('документ создан в песочнице iso-a', isoSell.statusCode === 200 && Boolean(isoSell.json().uuid));
    const isoUuid = isoSell.json().uuid;
    await request(port, 'POST', '/sandboxes', { sandbox: 'default' });
    const isoInvisible = await report(port, isoUuid);
    check('документ из iso-a в default не виден (code 10)', isoInvisible.json().error.code === 10);
    const isoBack = await request(port, 'GET', `/possystem/v4/${GROUP}/report/${isoUuid}`, undefined,
      { Token: isoToken, 'X-Mock-Sandbox': 'iso-a' });
    check('тот же документ виден в своей песочнице', isoBack.statusCode === 200 && isoBack.json().uuid === isoUuid);
    check('токен другой песочницы не даёт доступа к её документам из default',
      sandboxRuntime.currentId() === 'default');

    const stateResp = await request(port, 'GET', '/mock/state');
    check('GET /mock/state отдаёт снимок', stateResp.statusCode === 200 && Boolean(stateResp.json().state));
    const resetResp = await request(port, 'POST', '/mock/reset', {});
    check('POST /mock/reset', resetResp.statusCode === 200 && resetResp.json().ok !== false);
    check('reset очистил документы default', Object.keys(state.documents).length === 0);

    /* -------------------------------------- дочерние процессы (persist, CP) */
    console.log('— персистентность и control-plane (дочерние процессы)');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atol-selftest-'));
    const stateFile = path.join(tmpDir, 'state.json');
    let child = startChild({ MOCK_STATE_FILE: stateFile });
    let persistedUuid = '';
    let persistedToken = '';
    try {
      const childPort = await child.port;
      persistedToken = (await getToken(childPort)).token;
      const created = await request(childPort, 'POST', `/possystem/v4/${GROUP}/sell`, doc('st-persist-1'), { Token: persistedToken });
      persistedUuid = created.json().uuid;
      check('дочерний стенд: документ создан', created.statusCode === 200 && Boolean(persistedUuid));
      await new Promise((resolve) => { child.proc.once('exit', resolve); child.proc.kill('SIGTERM'); });
      child = null;

      child = startChild({ MOCK_STATE_FILE: stateFile });
      const childPort2 = await child.port;
      const after = await request(childPort2, 'GET', `/possystem/v4/${GROUP}/report/${persistedUuid}`, undefined, { Token: persistedToken });
      check('после рестарта документ читается из state-файла', after.statusCode === 200 && after.json().uuid === persistedUuid,
        after.body.slice(0, 160));
      const tokenAlive = await request(childPort2, 'POST', `/possystem/v4/${GROUP}/sell`, doc('st-persist-2'), { Token: persistedToken });
      check('после рестарта токен продолжает работать', tokenAlive.statusCode === 200 && Boolean(tokenAlive.json().uuid),
        tokenAlive.body.slice(0, 160));
      const replayAfter = await request(childPort2, 'POST', `/possystem/v4/${GROUP}/sell`, doc('st-persist-1'), { Token: persistedToken });
      check('после рестарта дедуп external_id работает (тот же uuid)',
        replayAfter.json().uuid === persistedUuid, `${replayAfter.json().uuid} vs ${persistedUuid}`);
      await new Promise((resolve) => { child.proc.once('exit', resolve); child.proc.kill('SIGTERM'); });
      child = null;
    } finally {
      if (child) child.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    let tokenChild = startChild({ MOCK_ADMIN_TOKEN: 'adm-secret', MOCK_OPERATOR_TOKEN: 'op-secret' });
    try {
      const tPort = await tokenChild.port;
      const jClosed = await request(tPort, 'GET', '/admin/journal');
      checkError('/admin/journal без токена закрыт', jClosed, { code: 11, status: 401 });
      const jOpen = await request(tPort, 'GET', '/admin/journal', undefined, { Authorization: 'Bearer adm-secret' });
      check('токен админа открывает /admin/journal', jOpen.statusCode === 200);
      const timeClosed = await request(tPort, 'GET', '/mock/time');
      check('/mock/time закрыт без оператор-токена', timeClosed.statusCode === 401);
      const timeOpen = await request(tPort, 'GET', '/mock/time', undefined, { 'X-Operator-Token': 'op-secret' });
      check('оператор-токен открывает /mock/time', timeOpen.statusCode === 200);
      const healthOpen = await request(tPort, 'GET', '/health');
      check('/health публичен', healthOpen.statusCode === 200);
      const tToken = (await getToken(tPort)).token;
      const bizOpen = await request(tPort, 'POST', `/possystem/v4/${GROUP}/sell`, doc('st-cp-1'), { Token: tToken });
      check('/possystem/v4 не требует control-токенов (нужен только Token)', bizOpen.statusCode === 200 && Boolean(bizOpen.json().uuid));
    } finally {
      tokenChild.stop();
    }

    // Hosted-режим (tenancy=owned): у песочницы свои креды АТОЛ и своя группа.
    let hostedChild = startChild({ MOCK_HOSTED: '1', MOCK_PROCESS_MS: '200' });
    try {
      const hPort = await hostedChild.port;
      const created = await request(hPort, 'POST', '/sandboxes', { sandbox: 't1' });
      const creds = created.json() && created.json().creds;
      const ownerToken = created.json() && created.json().ownerToken;
      check('hosted: POST /sandboxes выдаёт ownerToken и креды АТОЛ',
        created.statusCode === 201 && Boolean(ownerToken) && Boolean(creds && creds.atolLogin && creds.atolGroup),
        JSON.stringify(creds));
      const HK = { 'X-Sandbox-Token': ownerToken, 'X-Mock-Sandbox': 't1' };
      const alien = await request(hPort, 'POST', `/possystem/v4/${creds.atolGroup}/sell`, doc('st-host-alien'),
        { 'X-Mock-Sandbox': 't1' });
      check('hosted: знание ID песочницы без owner-token доступа не даёт',
        alien.statusCode === 401 && alien.json().error.code === 11, alien.body.slice(0, 120));
      const standCreds = await request(hPort, 'POST', '/possystem/v4/getToken',
        { login: mod.ATOL_LOGIN_CRED, pass: mod.ATOL_PASSWORD_CRED }, HK);
      check('hosted: креды стенда в песочнице не работают (14)', standCreds.json().error.code === 14,
        JSON.stringify(standCreds.json().error && standCreds.json().error.field));
      const hToken = await request(hPort, 'POST', '/possystem/v4/getToken',
        { login: creds.atolLogin, pass: creds.atolPassword }, HK);
      check('hosted: креды песочницы выдают токен', Boolean(hToken.json().token));
      const HT = { ...HK, Token: hToken.json().token };
      const hSell = await request(hPort, 'POST', `/possystem/v4/${creds.atolGroup}/sell`, doc('st-host-1'), HT);
      check('hosted: sell в группе песочницы принят', hSell.statusCode === 200 && Boolean(hSell.json().uuid),
        hSell.body.slice(0, 140));
      const hOther = await request(hPort, 'POST', `/possystem/v4/${GROUP}/sell`, doc('st-host-2'), HT);
      check('hosted: группы стенда в песочнице остаются доступными', Boolean(hOther.json().uuid),
        hOther.body.slice(0, 140));
      const hBad = await request(hPort, 'POST', '/possystem/v4/no-such-group/sell', doc('st-host-3'), HT);
      check('hosted: незарегистрированная группа отклонена (4, group_code)',
        hBad.json().error.code === 4 && hBad.json().error.field === 'group_code');
      const hUuid = hSell.json().uuid;
      let hRep = await request(hPort, 'GET', `/possystem/v4/${creds.atolGroup}/report/${hUuid}`, undefined, HT);
      for (let i = 0; i < 30 && hRep.json().status === 'wait'; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        hRep = await request(hPort, 'GET', `/possystem/v4/${creds.atolGroup}/report/${hUuid}`, undefined, HT);
      }
      check('hosted: report в песочнице доходит до done', hRep.json().status === 'done',
        JSON.stringify(hRep.json()).slice(0, 120));
      check('hosted: ofd_receipt_url несёт селектор песочницы',
        /sandbox=t1/.test((hRep.json().payload || {}).ofd_receipt_url || ''),
        String((hRep.json().payload || {}).ofd_receipt_url));
      const removed = await request(hPort, 'DELETE', '/sandboxes/me', undefined, { 'X-Sandbox-Token': ownerToken });
      check('hosted: владелец удаляет свою песочницу', removed.statusCode === 200 && removed.json().removed === 't1',
        removed.body.slice(0, 120));
    } finally {
      hostedChild.stop();
    }

    // Стартовый лог печатает публичные тестовые реквизиты v4.
    const logChild = startChild({});
    try {
      await logChild.port;
      await sleep(150);
      const logText = logChild.output();
      check('стартовый лог печатает креды и группу v4',
        logText.includes('login=v4-online-atol-ru') && logText.includes('pass=iGFFuihss') && logText.includes(GROUP),
        logText.slice(0, 300));
      check('стартовый лог отмечает, что v5/маркировка вне области', logText.includes('вне области'));
    } finally {
      logChild.stop();
    }

    // MOCK_DEFAULT_CALLBACK_URL: приёмник по умолчанию, если в запросе нет
    // service.callback_url (mock-расширение, в протоколе v4 такого дефолта нет).
    let defaultCbChild = startChild({
      MOCK_DEFAULT_CALLBACK_URL: `http://127.0.0.1:${receiverPort}/hook`,
      MOCK_PROCESS_MS: '15000',
    });
    try {
      const dPort = await defaultCbChild.port;
      const dToken = (await getToken(dPort)).token;
      const created = await request(dPort, 'POST', `/possystem/v4/${GROUP}/sell`, doc('st-default-cb-1'), { Token: dToken });
      const dUuid = created.json().uuid;
      check('без service.callback_url документ создан', created.statusCode === 200 && Boolean(dUuid));
      await request(dPort, 'POST', '/mock/time', { advance: '+20s' });
      await waitForCondition(() => hitsFor(dUuid).length >= 1, { timeoutMs: 8000, description: 'callback на адрес по умолчанию' });
      check('MOCK_DEFAULT_CALLBACK_URL: результат ушёл на приёмник по умолчанию',
        hitsFor(dUuid).length >= 1 && hitsFor(dUuid)[0].path === '/hook', `доставок: ${hitsFor(dUuid).length}`);
    } finally {
      defaultCbChild.stop();
    }

    /* ------------------------------------------- истечение токена (24 ч) */
    console.log('— виртуальные часы: истечение токена v4 (TTL 24 ч)');
    let ttlChild = startChild({ MOCK_PROCESS_MS: '600000' });
    try {
      const cPort = await ttlChild.port;
      const cToken = (await getToken(cPort)).token;
      const alive = await request(cPort, 'GET', `/possystem/v4/${GROUP}/report/whatever`, undefined, { Token: cToken });
      check('токен жив: ошибка «документ не найден» (10), а не авторизация', alive.json().error.code === 10);
      const adv25 = await request(cPort, 'POST', '/mock/time', { advance: '+25h' });
      check('advance +25h принят', adv25.statusCode === 200 && adv25.json().offsetMs > 24 * 3600 * 1000);
      const expired = await request(cPort, 'GET', `/possystem/v4/${GROUP}/report/whatever`, undefined, { Token: cToken });
      checkError('токен истёк через 24 ч -> code 11', expired, { code: 11, field: 'Token' });
      check('hint объясняет, что нужен новый getToken', String((expired.json().error || {}).hint || '').includes('getToken'));
      const freshToken = (await getToken(cPort)).token;
      const afterFresh = await request(cPort, 'GET', `/possystem/v4/${GROUP}/report/whatever`, undefined, { Token: freshToken });
      check('новый getToken после истечения работает', afterFresh.json().error.code === 10);
    } finally {
      ttlChild.stop();
    }

    console.log(`\nИТОГ: ${passed} passed, ${failed} failed · callback-доставок: ${HITS.length}`);
    if (failed > 0) {
      console.log('SELFTEST FAILED ❌');
      process.exit(1);
    }
    console.log('SELFTEST PASSED ✅');
    process.exit(0);
  } finally {
    try { server.close(); } catch { /* ignore */ }
    try { receiver.close(); } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error('SELFTEST FAILED ❌:', e);
  process.exit(1);
});
