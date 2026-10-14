// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Selftest мока «облачной кассы OKassa» Первого ОФД (issue #92, Stage 2).
 * Покрывает: getToken (выдача, отказ, квирк примера PDF, истечение 24 ч на
 * виртуальных часах, повторную выдачу), Bearer-авторизацию очереди, строгие
 * схемы по типу заявки (receipt / receiptCorrection / StateCommandRequest),
 * операции INCOME/INCOME_RETURN/EXPENCE/EXPENCE_RETURN с написанием как в схеме,
 * статусы IN_PROGRESS → COMPLETED/ERROR и оба слоя ошибок (API/ККТ),
 * transaction/status/statuses/receipts, повторный externalId ([VERIFY]),
 * callback без подписи + сверку статусом, retry/drop/duplicate, терминальный
 * SSRF-отказ, сценарии/журнал/песочницы, env-парсеры и hosted control-plane.
 * Запуск: node services/first-ofd-mock/selftest.js
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const CREDS = { login: 'firstofdmocktest', pass: '11111111-2222-4333-8444-555555555555' };
const QUEUE = '/api/external/queue/v1';
const RECEIPTS = '/api/external/receipts';
const TOKEN_PATH = '/getToken';

let passed = 0;
let failed = 0;
let sequence = 0;
const callbackHits = [];
const callbackWaiters = [];

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function waitFor(predicate, { timeoutMs = 6000, description = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        if (await predicate()) return resolve(true);
        if (Date.now() >= until) return reject(new Error(`Timed out waiting for ${description}`));
        setImmediate(poll); // без фиксированных sleep: даём event loop обработать I/O.
      } catch (error) {
        reject(error);
      }
    };
    poll();
  });
}

function notifyCallbackWaiters(hit) {
  for (let index = callbackWaiters.length - 1; index >= 0; index -= 1) {
    const waiter = callbackWaiters[index];
    if (!waiter.predicate(hit)) continue;
    callbackWaiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(hit);
  }
}

function waitForCallback(predicate, { timeoutMs = 5000, description = 'callback' } = {}) {
  const existing = callbackHits.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      timer: setTimeout(() => {
        const index = callbackWaiters.indexOf(waiter);
        if (index >= 0) callbackWaiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${description}`));
      }, timeoutMs),
    };
    callbackWaiters.push(waiter);
  });
}

const callbackReceiver = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(raw); } catch { /* recorded for assertion */ }
    const hit = {
      path: new URL(req.url, 'http://receiver.local').pathname,
      method: req.method,
      contentType: req.headers['content-type'],
      headers: req.headers,
      raw,
      json,
      status: null,
    };
    callbackHits.push(hit);
    notifyCallbackWaiters(hit);
    if (hit.path === '/noack') {
      hit.status = 204;
      res.writeHead(204);
      res.end();
      return;
    }
    if (hit.path === '/always-fail') {
      hit.status = 503;
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('temporarily unavailable');
      return;
    }
    hit.status = 200;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function request(port, method, requestPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: {
        ...(data !== null ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
      timeout: 8000,
    }, (res) => {
      let output = '';
      res.on('data', (chunk) => { output += chunk; });
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: output,
        json: () => { try { return JSON.parse(output); } catch { return null; } },
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`HTTP timeout ${method} ${requestPath}`)));
    if (data !== null) req.write(data);
    req.end();
  });
}

function startChild(extraEnv = {}) {
  const env = {
    ...process.env,
    MOCK_HOST: '127.0.0.1',
    MOCK_PORT: '0',
    MOCK_STATE_FILE: '',
    MOCK_FIRST_OFD_LOGIN: '',
    MOCK_FIRST_OFD_PASS: '',
    MOCK_FIRST_OFD_TOKEN_TTL_SECS: '86400',
    MOCK_FIRST_OFD_TOKEN_SINGLE: '',
    MOCK_FIRST_OFD_PROCESS_MS: '2000',
    MOCK_FIRST_OFD_PUBLIC_BASE_URL: '',
    MOCK_FIRST_OFD_CALLBACK_URL: '',
    MOCK_FIRST_OFD_CALLBACK_RETRY_MS: '60s',
    MOCK_FIRST_OFD_CALLBACK_MAX_ATTEMPTS: '3',
    MOCK_FIRST_OFD_CALLBACK_HTTPS_ONLY: '',
    MOCK_FIRST_OFD_USER_GROUPS: '',
    MOCK_BLOCK_PRIVATE_WEBHOOKS: '',
    MOCK_VIRTUAL_CLOCK: '',
    MOCK_ADMIN_TOKEN: '',
    MOCK_OPERATOR_TOKEN: '',
    MOCK_HOSTED: 'false',
    MOCK_TENANCY: '',
    MOCK_SANDBOX_TOKEN: '',
    MOCK_SANDBOX_TTL_MS: '',
    MOCK_SANDBOX_MAX: '',
    MOCK_SANDBOX_MAX_DOCUMENTS: '',
    MOCK_SANDBOX_RETENTION_MS: '',
    MOCK_SANDBOX_HOST_SUFFIX: '',
    MOCK_SANDBOX_CREATE_LIMIT: '',
    MOCK_SANDBOX_SWEEP_MS: '60000',
    ...extraEnv,
  };
  const proc = spawn(process.execPath, ['--max-old-space-size=64', path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const outputWaiters = [];
  const recordOutput = (chunk) => {
    output += chunk.toString();
    for (let index = outputWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = outputWaiters[index];
      if (!waiter.pattern.test(output)) continue;
      outputWaiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(output);
    }
  };
  proc.stdout.on('data', recordOutput);
  proc.stderr.on('data', recordOutput);
  const port = new Promise((resolve, reject) => {
    const match = output.match(/on http:\/\/[^:\s]+:(\d+)/);
    if (match) return resolve(Number(match[1]));
    const waiter = { pattern: /on http:\/\/[^:\s]+:\d+/, resolve: () => resolve(Number(output.match(/on http:\/\/[^:\s]+:(\d+)/)[1])), timer: null };
    waiter.timer = setTimeout(() => {
      const index = outputWaiters.indexOf(waiter);
      if (index >= 0) outputWaiters.splice(index, 1);
      reject(new Error(`first-ofd-mock did not start: ${output}`));
    }, 8000);
    outputWaiters.push(waiter);
    proc.once('exit', (code) => { if (code !== null && code !== 0) reject(new Error(`first-ofd-mock exited ${code}: ${output}`)); });
  });
  return {
    proc,
    port,
    output: () => output,
    waitForOutput(pattern, timeoutMs = 5000) {
      if (pattern.test(output)) return Promise.resolve(output);
      return new Promise((resolve, reject) => {
        const waiter = { pattern, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const index = outputWaiters.indexOf(waiter);
          if (index >= 0) outputWaiters.splice(index, 1);
          reject(new Error(`Timed out waiting for log /${pattern.source}/: ${output}`));
        }, timeoutMs);
        outputWaiters.push(waiter);
      });
    },
    async stop() {
      if (proc.exitCode !== null) return;
      proc.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 3000);
        proc.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

const uniqueId = (prefix = 'ofd') => `${prefix}-${Date.now().toString(36)}-${++sequence}`;

function getToken(port, { login = CREDS.login, pass = CREDS.pass, headers = {}, scenario = '' } = {}) {
  return request(port, 'POST', TOKEN_PATH, { login, pass }, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(scenario ? { 'X-Mock-Scenario': scenario } : {}),
    ...headers,
  });
}

function api(port, method, requestPath, token, body = null, headers = {}) {
  return request(port, method, requestPath, body, { 'Authorization': `Bearer ${token}`, ...headers });
}

/** Тело заявки на чек с разумными дефолтами: переопределяется точечно. */
function receiptBody(overrides = {}) {
  const { metadata = {}, document = {}, cashbox = {}, ...rest } = overrides;
  return {
    cashboxParameters: { userInn: '7842223709', ...cashbox },
    requestMetadata: { userGroup: 'MOCKGROUP', ...metadata },
    document: {
      operationType: 'INCOME',
      items: [{ label: 'Товар', measurementUnit: 'шт', price: 100.0, quantity: 1, vatCode: 'VAT_22' }],
      totalSum: 100.0,
      ...document,
    },
    ...rest,
  };
}

function checkProviderError(name, response, code, statusCode) {
  const body = response.json() || {};
  const error = body.error || {};
  check(`${name}: provider-shaped error (HTTP ${statusCode}, error.code=${code}, text + DX)`,
    response.statusCode === statusCode && error.code === code
      && typeof error.text === 'string' && error.text.length > 0
      && typeof body.hint === 'string' && body.hint.length > 0,
    `${response.statusCode} ${response.body.slice(0, 220)}`);
  return body;
}

async function submit(port, token, type, body, headers = {}) {
  const response = await api(port, 'POST', `${QUEUE}/transaction/${type}`, token, body, headers);
  const json = response.json() || {};
  return { response, requestId: json.requestId, body: json };
}

async function callbacksFor(port, requestId, headers = {}) {
  const snapshot = (await request(port, 'GET', '/mock/state', null, headers)).json() || {};
  const inner = snapshot.state || {};
  return Object.values(inner.callbacks || {}).filter((entry) => entry.requestId === requestId);
}

async function main() {
  const receiverPort = await listen(callbackReceiver);
  const origin = `http://127.0.0.1:${receiverPort}`;
  const hookUrl = `${origin}/hook`;
  const children = [];
  try {
    const primary = startChild({ MOCK_FIRST_OFD_CALLBACK_URL: hookUrl });
    children.push(primary);
    const port = await primary.port;
    console.log(`\n== first-ofd-mock selftest on :${port} (облачная касса OKassa) ==\n`);

    console.log('— health, OpenAPI, синтетические креды');
    const health = await request(port, 'GET', '/health');
    const healthJson = health.json() || {};
    check('health: 200 ok, api=okassa-queue, база очереди /api/external/queue/v1/',
      health.statusCode === 200 && healthJson.ok === true && healthJson.api === 'okassa-queue' && healthJson.base === '/api/external/queue/v1/');
    check('health: TTL токена 86400 с (24 ч), callback POST без подписи, операции с EXPENCE',
      healthJson.tokenTtlSecs === 86400 && healthJson.callbackMethod === 'POST' && healthJson.callbackSignature === 'none'
      && Array.isArray(healthJson.operations) && healthJson.operations.includes('EXPENCE') && healthJson.operations.includes('EXPENCE_RETURN'));
    check('health: статусы очереди IN_PROGRESS/COMPLETED/ERROR и пять типов заявок',
      JSON.stringify(healthJson.queueStatuses) === JSON.stringify(['IN_PROGRESS', 'COMPLETED', 'ERROR'])
      && JSON.stringify(healthJson.transactionTypes) === JSON.stringify(['receipt', 'receiptCorrection', 'openShift', 'closeShift', 'currentStateReport']));
    const openapi = (await request(port, 'GET', '/openapi.json')).json() || {};
    check('openapi.json: 3.1.0 с transaction/{type} и /api/external/receipts',
      openapi.openapi === '3.1.0' && Boolean(openapi.paths && openapi.paths[`${QUEUE}/transaction/{type}`]) && Boolean(openapi.paths[`${RECEIPTS}`]));

    console.log('— getToken: выдача, отказы, квирк примера PDF, повторная выдача');
    const tokenRes = await getToken(port);
    const tokenJson = tokenRes.json() || {};
    check('getToken: token + X-Mock-Token-TTL-Secs=86400, объекта error на успехе нет',
      tokenRes.statusCode === 200 && typeof tokenJson.token === 'string' && tokenJson.token.length >= 32
      && tokenJson.error === undefined && tokenRes.headers['x-mock-token-ttl-secs'] === '86400',
      tokenRes.body.slice(0, 200));
    let token = tokenJson.token;
    checkProviderError('getToken с неверным pass', await getToken(port, { pass: 'wrong' }), 'invalid_credentials', 401);
    checkProviderError('getToken без login', await getToken(port, { login: '' }), 'invalid_request', 400);
    const tokenNotJson = await request(port, 'POST', TOKEN_PATH, { login: CREDS.login, pass: CREDS.pass }, { 'Content-Type': 'text/plain' });
    check('getToken: Content-Type не JSON → 415 (срез фиксирует application/json; charset=utf-8)', tokenNotJson.statusCode === 415);
    const tokenWrongMethod = await request(port, 'GET', TOKEN_PATH);
    check('getToken: GET → 405', tokenWrongMethod.statusCode === 405);
    const quirkRes = await getToken(port, { scenario: 'getToken-error-quirk' });
    const quirkJson = quirkRes.json() || {};
    check('getToken-error-quirk: пример PDF воспроизведён ({token, error:{code:0,text}}) — семантика не угадывается',
      quirkRes.statusCode === 200 && typeof quirkJson.token === 'string'
      && quirkJson.error && quirkJson.error.code === 0 && quirkJson.error.text === 'Неверный логин и пароль',
      quirkRes.body.slice(0, 200));
    const secondToken = (await getToken(port)).json() || {};
    const oldTokenStillWorks = await api(port, 'GET', `${QUEUE}/status/unknown-id`, token);
    check('повторная выдача: прежний токен остаётся валидным до TTL (поведение мока, [VERIFY]) — 401 только по request_not_found',
      oldTokenStillWorks.statusCode === 404, `${oldTokenStillWorks.statusCode}`);
    check('повторная выдача: новый токен отличается от прежнего', secondToken.token !== token);

    console.log('— Bearer-авторизация очереди');
    checkProviderError('без заголовка Authorization',
      await request(port, 'POST', `${QUEUE}/transaction/receipt`, receiptBody()),
      'invalid_token', 401);
    checkProviderError('неизвестный Bearer',
      await api(port, 'POST', `${QUEUE}/transaction/receipt`, 'deadbeef', receiptBody()),
      'invalid_token', 401);
    checkProviderError('API-ключ UUID вместо bearer-токена',
      await api(port, 'POST', `${QUEUE}/transaction/receipt`, CREDS.pass, receiptBody()),
      'invalid_token', 401);

    console.log('— receipt INCOME: requestId → IN_PROGRESS → COMPLETED + payload');
    const externalId = uniqueId('ext');
    const created = await submit(port, token, 'receipt', receiptBody({
      metadata: { externalId, callbackUrl: hookUrl },
      document: { totalSum: 100.0 },
    }));
    check('POST transaction/receipt: 200 и requestId (не финальный результат)',
      created.response.statusCode === 200 && typeof created.requestId === 'string' && created.requestId.length >= 16,
      created.response.body.slice(0, 200));
    const immediate = await api(port, 'GET', `${QUEUE}/status/${created.requestId}`, token);
    const immediateJson = immediate.json() || {};
    check('сразу после подачи: status=IN_PROGRESS, payload=null, поля результата объявлены',
      immediate.statusCode === 200 && immediateJson.status === 'IN_PROGRESS' && immediateJson.payload === null
      && immediateJson.errorCode === null && immediateJson.errorType === null && immediateJson.requestId === created.requestId);
    await request(port, 'POST', '/mock/time', { advance: '+5s' });
    const completed = (await api(port, 'GET', `${QUEUE}/status/${created.requestId}`, token)).json() || {};
    check('после сдвига виртуальных часов: COMPLETED и payload фискального документа',
      completed.status === 'COMPLETED'
      && completed.payload && typeof completed.payload.fiscalDocumentNumber === 'number'
      && typeof completed.payload.fiscalDocumentSign === 'string'
      && typeof completed.payload.kkmRegId === 'string' && completed.payload.totalSum === 100);
    check('payload: операция и transactionType сохранены, ошибок нет',
      completed.payload.operationType === 'INCOME' && completed.payload.transactionType === 'receipt'
      && completed.errorCode === null && completed.errorType === null && completed.details === null);
    const transaction = (await api(port, 'GET', `${QUEUE}/transaction/${created.requestId}`, token)).json() || {};
    check('GET transaction/{requestId}: полная заявка + результат',
      transaction.requestId === created.requestId && transaction.status === 'COMPLETED'
      && transaction.request && transaction.request.requestMetadata.userGroup === 'MOCKGROUP'
      && transaction.request.document.operationType === 'INCOME'
      && transaction.result && transaction.result.requestId === created.requestId);
    checkProviderError('неизвестный requestId в transaction/{requestId}',
      await api(port, 'GET', `${QUEUE}/transaction/no-such-request`, token),
      'request_not_found', 404);

    console.log('— операции чека: INCOME_RETURN, EXPENCE, EXPENCE_RETURN (написание как в схеме)');
    for (const operation of ['INCOME_RETURN', 'EXPENCE', 'EXPENCE_RETURN']) {
      const submitted = await submit(port, token, 'receipt', receiptBody({
        metadata: { externalId: uniqueId('op'), callbackUrl: '' },
        document: { operationType: operation },
      }));
      await request(port, 'POST', '/mock/time', { advance: '+5s' });
      const status = (await api(port, 'GET', `${QUEUE}/status/${submitted.requestId}`, token)).json() || {};
      check(`receipt ${operation}: принят и COMPLETED (${status.payload ? status.payload.operationType : '—'})`,
        submitted.response.statusCode === 200 && status.status === 'COMPLETED' && status.payload && status.payload.operationType === operation);
    }
    checkProviderError('EXPENSE (английское написание) отклонён — схема требует EXPENCE',
      await api(port, 'POST', `${QUEUE}/transaction/receipt`, token, receiptBody({ document: { operationType: 'EXPENSE' } })),
      'invalid_operation_type', 400);
    checkProviderError('неизвестный vatCode отклонён',
      await api(port, 'POST', `${QUEUE}/transaction/receipt`, token, receiptBody({
        document: { items: [{ label: 'Товар', measurementUnit: 'шт', price: 1, quantity: 1, vatCode: 'VAT_99' }], totalSum: 1 },
      })),
      'invalid_vat_code', 400);

    console.log('— строгие схемы по типу заявки и обязательные поля');
    checkProviderError('отсутствует cashboxParameters.userInn (обязателен для ReceiptRequest)',
      await api(port, 'POST', `${QUEUE}/transaction/receipt`, token, receiptBody({ cashbox: { userInn: '' } })),
      'invalid_request', 400);
    checkProviderError('отсутствует requestMetadata.userGroup',
      await api(port, 'POST', `${QUEUE}/transaction/receipt`, token, receiptBody({ metadata: { userGroup: '' } })),
      'invalid_request', 400);
    checkProviderError('неверный userGroup (нет в каталоге стенда)',
      await api(port, 'POST', `${QUEUE}/transaction/receipt`, token, receiptBody({ metadata: { userGroup: 'НЕТ-ТАКОЙ-ГРУППЫ' } })),
      'unknown_user_group', 400);
    checkProviderError('отсутствует document',
      await api(port, 'POST', `${QUEUE}/transaction/receipt`, token, {
        cashboxParameters: { userInn: '7842223709' }, requestMetadata: { userGroup: 'MOCKGROUP' },
      }),
      'invalid_request', 400);
    checkProviderError('document.items — объект, а не массив (расхождение среза №2)',
      await api(port, 'POST', `${QUEUE}/transaction/receipt`, token, receiptBody({
        document: { items: { label: 'Товар', measurementUnit: 'шт', price: 1, quantity: 1, vatCode: 'VAT_20' } },
      })),
      'invalid_request', 400);
    checkProviderError('у позиции отсутствует vatCode',
      await api(port, 'POST', `${QUEUE}/transaction/receipt`, token, receiptBody({
        document: { items: [{ label: 'Товар', measurementUnit: 'шт', price: 1, quantity: 1 }], totalSum: 1 },
      })),
      'invalid_item', 400);
    checkProviderError('отсутствует document.totalSum',
      await api(port, 'POST', `${QUEUE}/transaction/receipt`, token, {
        cashboxParameters: { userInn: '7842223709' },
        requestMetadata: { userGroup: 'MOCKGROUP' },
        document: { operationType: 'INCOME', items: [{ label: 'Т', measurementUnit: 'шт', price: 1, quantity: 1, vatCode: 'VAT_20' }] },
      }),
      'invalid_request', 400);
    checkProviderError('userInn не той длины',
      await api(port, 'POST', `${QUEUE}/transaction/receipt`, token, receiptBody({ cashbox: { userInn: '12345' } })),
      'invalid_request', 400);
    checkProviderError('неизвестный тип заявки',
      await api(port, 'POST', `${QUEUE}/transaction/unknownType`, token, receiptBody()),
      'unknown_transaction_type', 400);
    checkProviderError('receipt-тело в openShift (смешивать схемы нельзя)',
      await api(port, 'POST', `${QUEUE}/transaction/openShift`, token, receiptBody()),
      'invalid_request', 400);
    const correctionMissingCause = await api(port, 'POST', `${QUEUE}/transaction/receiptCorrection`, token, receiptBody());
    checkProviderError('receiptCorrection без document.correctionCause', correctionMissingCause, 'invalid_request', 400);
    check('receiptCorrection: hint объясняет обязательность correctionCause',
      String((correctionMissingCause.json() || {}).hint || '').includes('correctionCause'));
    const wrongMethod = await api(port, 'DELETE', `${QUEUE}/status/any`, token);
    check('DELETE status/{requestId} → 405', wrongMethod.statusCode === 405);

    console.log('— ReceiptCorrectionRequest и смены (StateCommandRequest)');
    const correction = await submit(port, token, 'receiptCorrection', receiptBody({
      metadata: { externalId: uniqueId('corr'), callbackUrl: '' },
      document: { correctionCause: 'SELF' },
    }));
    await request(port, 'POST', '/mock/time', { advance: '+5s' });
    const correctionStatus = (await api(port, 'GET', `${QUEUE}/status/${correction.requestId}`, token)).json() || {};
    check('receiptCorrection: COMPLETED, payload содержит correctionCause',
      correctionStatus.status === 'COMPLETED' && correctionStatus.payload && correctionStatus.payload.correctionCause === 'SELF');

    const openShift = await submit(port, token, 'openShift', {
      cashboxParameters: { userInn: '7842223709' },
      requestMetadata: { userGroup: 'MOCKGROUP', externalId: uniqueId('shift'), callbackUrl: '' },
    });
    await request(port, 'POST', '/mock/time', { advance: '+5s' });
    const openStatus = (await api(port, 'GET', `${QUEUE}/status/${openShift.requestId}`, token)).json() || {};
    check('openShift: COMPLETED, смена открыта (shiftState=OPEN)',
      openStatus.status === 'COMPLETED' && openStatus.payload && openStatus.payload.shiftState === 'OPEN' && openStatus.payload.shiftNumber >= 1);
    const openTxn = (await api(port, 'GET', `${QUEUE}/transaction/${openShift.requestId}`, token)).json() || {};
    check('openShift: GET transaction отдаёт эхо request (StateCommandRequest «как принят»)',
      Boolean(openTxn.request) && openTxn.request.requestMetadata && openTxn.request.requestMetadata.userGroup === 'MOCKGROUP'
      && openTxn.request.document === undefined && Boolean(openTxn.result) && openTxn.result.requestId === openShift.requestId);
    const openAgain = await submit(port, token, 'openShift', {
      cashboxParameters: { userInn: '7842223709' },
      requestMetadata: { userGroup: 'MOCKGROUP', callbackUrl: '' },
    });
    await request(port, 'POST', '/mock/time', { advance: '+5s' });
    const openAgainStatus = (await api(port, 'GET', `${QUEUE}/status/${openAgain.requestId}`, token)).json() || {};
    check('openShift повторно: ERROR слоя ККТ (SHIFT_ALREADY_OPEN) с errorCode/errorType/details',
      openAgainStatus.status === 'ERROR' && openAgainStatus.errorType === 'KKT'
      && openAgainStatus.errorCode === 'SHIFT_ALREADY_OPEN' && typeof openAgainStatus.details === 'string');
    const report = await submit(port, token, 'currentStateReport', {
      cashboxParameters: { userInn: '7842223709' },
      requestMetadata: { userGroup: 'MOCKGROUP', callbackUrl: '' },
    });
    await request(port, 'POST', '/mock/time', { advance: '+5s' });
    const reportStatus = (await api(port, 'GET', `${QUEUE}/status/${report.requestId}`, token)).json() || {};
    check('currentStateReport: COMPLETED, состояние смены в payload',
      reportStatus.status === 'COMPLETED' && reportStatus.payload && reportStatus.payload.responseType === 'CURRENT_STATE_REPORT'
      && reportStatus.payload.shiftState === 'OPEN');
    const closeShift = await submit(port, token, 'closeShift', {
      cashboxParameters: { userInn: '7842223709' },
      requestMetadata: { userGroup: 'MOCKGROUP', callbackUrl: '' },
    });
    await request(port, 'POST', '/mock/time', { advance: '+5s' });
    const closeStatus = (await api(port, 'GET', `${QUEUE}/status/${closeShift.requestId}`, token)).json() || {};
    check('closeShift: COMPLETED, shiftState=CLOSED', closeStatus.status === 'COMPLETED' && closeStatus.payload && closeStatus.payload.shiftState === 'CLOSED');
    const closeAgain = await submit(port, token, 'closeShift', {
      cashboxParameters: { userInn: '7842223709' },
      requestMetadata: { userGroup: 'MOCKGROUP', callbackUrl: '' },
    });
    await request(port, 'POST', '/mock/time', { advance: '+5s' });
    const closeAgainStatus = (await api(port, 'GET', `${QUEUE}/status/${closeAgain.requestId}`, token)).json() || {};
    check('closeShift повторно: ERROR ККТ (SHIFT_NOT_OPEN) — оба слоя ошибок разделяются',
      closeAgainStatus.status === 'ERROR' && closeAgainStatus.errorType === 'KKT' && closeAgainStatus.errorCode === 'SHIFT_NOT_OPEN');

    console.log('— сценарии слоя API/ККТ и chaos');
    const kktFailed = await submit(port, token, 'receipt', receiptBody({
      metadata: { callbackUrl: '' },
      document: { totalSum: 5 },
    }), { 'X-Mock-Scenario': 'kkt-error' });
    await request(port, 'POST', '/mock/time', { advance: '+5s' });
    const kktStatus = (await api(port, 'GET', `${QUEUE}/status/${kktFailed.requestId}`, token)).json() || {};
    check('сценарий kkt-error: ERROR со слоем ККТ и mock-local errorCode',
      kktStatus.status === 'ERROR' && kktStatus.errorType === 'KKT' && kktStatus.errorCode === 'KKT_UNAVAILABLE' && kktStatus.payload === null);
    const apiFailed = await submit(port, token, 'receipt', receiptBody({
      metadata: { callbackUrl: '' },
      document: { totalSum: 5 },
    }), { 'X-Mock-Scenario': 'api-error' });
    await request(port, 'POST', '/mock/time', { advance: '+5s' });
    const apiStatus = (await api(port, 'GET', `${QUEUE}/status/${apiFailed.requestId}`, token)).json() || {};
    check('сценарий api-error: ERROR со слоем API (второй слой ошибок, срез)',
      apiStatus.status === 'ERROR' && apiStatus.errorType === 'API' && apiStatus.errorCode === 'DOCUMENT_REJECTED');
    const chaos = await api(port, 'GET', `${QUEUE}/status/${created.requestId}`, token, null, { 'X-Mock-Scenario': 'http-500' });
    check('chaos http-500: транспортный сбой до операции', chaos.statusCode === 500 && (chaos.json() || {}).error.code === 'system_error');
    const chaos504 = await api(port, 'POST', `${QUEUE}/transaction/receipt`, token, receiptBody(), { 'X-Mock-Scenario': 'http-504' });
    check('chaos http-504: таймаут шлюза до очереди', chaos504.statusCode === 504);

    console.log('— statuses по externalId+groupId и повторный externalId ([VERIFY])');
    const group = 'firstofd-mock';
    const dupExternalId = uniqueId('dup');
    const firstDup = await submit(port, token, 'receipt', receiptBody({ metadata: { userGroup: group, externalId: dupExternalId, callbackUrl: '' } }));
    const secondDup = await submit(port, token, 'receipt', receiptBody({ metadata: { userGroup: group, externalId: dupExternalId, callbackUrl: '' } }));
    check('повторный externalId в той же группе создаёт НОВУЮ заявку (идемпотентность не обещана [VERIFY])',
      firstDup.response.statusCode === 200 && secondDup.response.statusCode === 200
      && firstDup.requestId !== secondDup.requestId
      && secondDup.response.headers['x-mock-duplicate-external-id'] === '1');
    await request(port, 'POST', '/mock/time', { advance: '+5s' });
    const statuses = await api(port, 'GET', `${QUEUE}/statuses?externalId=${encodeURIComponent(dupExternalId)}&groupId=${encodeURIComponent(group)}`, token);
    const statusesJson = statuses.json() || [];
    check('GET statuses: обе заявки найдены по externalId+groupId',
      statuses.statusCode === 200 && Array.isArray(statusesJson) && statusesJson.length === 2
      && statusesJson.every((entry) => entry.externalId === dupExternalId && entry.userGroup === group));
    const statusesFiltered = (await api(port, 'GET', `${QUEUE}/statuses?externalId=${encodeURIComponent(dupExternalId)}&groupId=${encodeURIComponent(group)}&status=COMPLETED`, token)).json() || [];
    check('GET statuses: фильтр status необязателен и работает', statusesFiltered.length === 2);
    const statusesEmpty = (await api(port, 'GET', `${QUEUE}/statuses?externalId=${encodeURIComponent(dupExternalId)}&groupId=${encodeURIComponent(group)}&status=IN_PROGRESS`, token)).json() || [];
    check('GET statuses: фильтр status=IN_PROGRESS не находит завершённые заявки', statusesEmpty.length === 0);
    checkProviderError('statuses без groupId',
      await api(port, 'GET', `${QUEUE}/statuses?externalId=${encodeURIComponent(dupExternalId)}`, token),
      'missing_parameter', 400);
    const otherGroup = (await api(port, 'GET', `${QUEUE}/statuses?externalId=${encodeURIComponent(dupExternalId)}&groupId=MOCKGROUP`, token)).json() || [];
    check('GET statuses: заявки другой группы не попадают в выборку', otherGroup.length === 0);

    console.log('— /receipts: фискальные документы за период, фильтры и пагинация');
    const from = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const receipts = await api(port, 'GET', `${RECEIPTS}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, token);
    const receiptsJson = receipts.json() || {};
    check('/receipts: список фискальных документов с пагинацией {items,total,page,pageSize}',
      receipts.statusCode === 200 && Array.isArray(receiptsJson.items) && receiptsJson.total >= 1
      && receiptsJson.page === 1 && receiptsJson.pageSize === 20);
    check('/receipts: документ содержит requestId, РНМ, ФН, ФПД (фискальные реквизиты)',
      receiptsJson.items.every((item) => typeof item.requestId === 'string' && typeof item.kkmRegId === 'string'
        && typeof item.fiscalDriveNumber === 'string' && typeof item.fiscalDocumentSign === 'string'));
    const paged = (await api(port, 'GET', `${RECEIPTS}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pageSize=1&page=2`, token)).json() || {};
    check('/receipts: page/pageSize работают (pageSize=1&page=2 → один документ, не тот же)',
      paged.items.length === 1 && paged.pageSize === 1 && paged.page === 2 && paged.items[0].fiscalDocumentNumber !== receiptsJson.items[0].fiscalDocumentNumber);
    const receiptsShift = (await api(port, 'GET', `${RECEIPTS}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&transactionType=openShift`, token)).json() || {};
    check('/receipts: фильтр transactionType=openShift возвращает отчёт об открытии смены',
      receiptsShift.items.length >= 1 && receiptsShift.items.every((item) => item.transactionType === 'openShift'));
    const receiptsGroup = (await api(port, 'GET', `${RECEIPTS}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&groupId=MOCKGROUP`, token)).json() || {};
    check('/receipts: фильтр groupId не смешивает группы', receiptsGroup.items.every((item) => item.userGroup === 'MOCKGROUP'));
    const receiptsKkm = (await api(port, 'GET', `${RECEIPTS}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&kkmRegId=${encodeURIComponent(receiptsJson.items[0].kkmRegId)}`, token)).json() || {};
    check('/receipts: фильтр kkmRegId работает', receiptsKkm.items.every((item) => item.kkmRegId === receiptsJson.items[0].kkmRegId));
    const receiptsEmpty = (await api(port, 'GET', `${RECEIPTS}?from=2020-01-01T00:00:00.000Z&to=2020-01-02T00:00:00.000Z`, token)).json() || {};
    check('/receipts: пустой период даёт пустой список', receiptsEmpty.items.length === 0 && receiptsEmpty.total === 0);
    checkProviderError('/receipts без from/to',
      await api(port, 'GET', `${RECEIPTS}`, token),
      'missing_parameter', 400);
    const badRange = await api(port, 'GET', `${RECEIPTS}?from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`, token);
    checkProviderError('/receipts: from > to', badRange, 'invalid_request', 400);

    console.log('— callback: доставка без подписи, сверка статусом, drop/duplicate');
    const callbackHit = await waitForCallback((hit) => hit.json && hit.json.requestId === created.requestId);
    check('callback: POST application/json на requestMetadata.callbackUrl без подписи',
      callbackHit.method === 'POST' && String(callbackHit.contentType).includes('application/json')
      && !callbackHit.headers['x-signature'] && !callbackHit.headers['x-mock-signature'] && !callbackHit.headers['signature'],
      callbackHit.raw.slice(0, 240));
    check('callback: результат заявки как есть (requestId/transactionType/status/payload)',
      callbackHit.json.status === 'COMPLETED' && callbackHit.json.transactionType === 'receipt'
      && callbackHit.json.payload && typeof callbackHit.json.payload.fiscalDocumentNumber === 'number'
      && callbackHit.json.externalId === externalId);
    const reconciled = (await api(port, 'GET', `${QUEUE}/status/${created.requestId}`, token)).json() || {};
    check('сверка после callback: GET status/{requestId} — источник истины (статус совпал)',
      reconciled.status === 'COMPLETED' && reconciled.payload.fiscalDocumentNumber === callbackHit.json.payload.fiscalDocumentNumber);
    const dropRequest = await submit(port, token, 'receipt', receiptBody({
      metadata: { callbackUrl: hookUrl },
      document: { totalSum: 1 },
    }), { 'X-Mock-Scenario': 'webhook-drop' });
    await request(port, 'POST', '/mock/time', { advance: '+5s' });
    const dropEntries = await callbacksFor(port, dropRequest.requestId);
    check('webhook-drop: заявка обработана, callback подавлен',
      dropEntries.length === 1 && dropEntries[0].suppressed === true);
    const duplicateRequest = await submit(port, token, 'receipt', receiptBody({
      metadata: { callbackUrl: hookUrl },
      document: { totalSum: 2 },
    }), { 'X-Mock-Scenario': 'webhook-duplicate' });
    await request(port, 'POST', '/mock/time', { advance: '+5s' });
    await waitFor(() => callbackHits.filter((hit) => hit.json && hit.json.requestId === duplicateRequest.requestId).length >= 2, { description: 'duplicate callbacks' });
    check('webhook-duplicate: доставлено два одинаковых уведомления',
      callbackHits.filter((hit) => hit.json && hit.json.requestId === duplicateRequest.requestId).length === 2);
    {
      const failing = startChild({ MOCK_FIRST_OFD_CALLBACK_URL: `${origin}/always-fail`, MOCK_FIRST_OFD_CALLBACK_RETRY_MS: '1s', MOCK_FIRST_OFD_CALLBACK_MAX_ATTEMPTS: '2' });
      children.push(failing);
      const failingPort = await failing.port;
      const failingToken = ((await getToken(failingPort)).json() || {}).token;
      const failingRequest = await submit(failingPort, failingToken, 'receipt', receiptBody({ document: { totalSum: 3 } }));
      await waitFor(async () => {
        const entries = await callbacksFor(failingPort, failingRequest.requestId);
        return entries.some((entry) => entry.dumped === true);
      }, { description: 'callback dumped after retries' });
      const entries = await callbacksFor(failingPort, failingRequest.requestId);
      const dumped = entries.find((entry) => entry.dumped);
      check('callback 503: повтор по локальному графику и сброс после лимита попыток (ACK-условие 2xx — [FORK])',
        Boolean(dumped) && dumped.attempts === 2, `attempts=${dumped ? dumped.attempts : '—'}`);
      const stillReconcilable = (await api(failingPort, 'GET', `${QUEUE}/status/${failingRequest.requestId}`, failingToken)).json() || {};
      check('после сброса callback заявка всё ещё сверяется статусом', stillReconcilable.status === 'COMPLETED');
    }

    console.log('— SSRF-отказ терминален, один вызов и никакого retry');
    {
      const ssrfChild = startChild({
        MOCK_FIRST_OFD_CALLBACK_URL: 'http://127.0.0.1:9/hook',
        MOCK_BLOCK_PRIVATE_WEBHOOKS: '1',
      });
      children.push(ssrfChild);
      const ssrfPort = await ssrfChild.port;
      const ssrfToken = ((await getToken(ssrfPort)).json() || {}).token;
      const ssrfRequest = await submit(ssrfPort, ssrfToken, 'receipt', receiptBody({ document: { totalSum: 4 } }));
      await waitFor(async () => {
        const entries = await callbacksFor(ssrfPort, ssrfRequest.requestId);
        return entries.some((entry) => entry.dumped && String(entry.lastStatus).includes('ERR SSRF_BLOCKED'));
      }, { description: 'SSRF terminal refusal' });
      const entries = await callbacksFor(ssrfPort, ssrfRequest.requestId);
      const blocked = entries.find((entry) => String(entry.lastStatus).includes('ERR SSRF_BLOCKED'));
      check('SSRF_BLOCKED помечает callback terminal/dumped после первой попытки', Boolean(blocked && blocked.dumped && blocked.attempts === 1));
    }

    console.log('— расхождения среза: callbackUrl (http vs https) и токен');
    checkProviderError('callbackUrl с недопустимой схемой ftp://',
      await api(port, 'POST', `${QUEUE}/transaction/receipt`, token, receiptBody({ metadata: { callbackUrl: 'ftp://example.test/hook' } })),
      'invalid_request', 400);
    checkProviderError('callbackUrl с userinfo',
      await api(port, 'POST', `${QUEUE}/transaction/receipt`, token, receiptBody({ metadata: { callbackUrl: 'https://user:pass@example.test/hook' } })),
      'invalid_request', 400);
    {
      const httpsOnly = startChild({ MOCK_FIRST_OFD_CALLBACK_HTTPS_ONLY: '1' });
      children.push(httpsOnly);
      const httpsPort = await httpsOnly.port;
      const httpsToken = ((await getToken(httpsPort)).json() || {}).token;
      const httpCallback = await api(httpsPort, 'POST', `${QUEUE}/transaction/receipt`, httpsToken, receiptBody({ metadata: { callbackUrl: 'http://example.test/hook' } }));
      check('MOCK_FIRST_OFD_CALLBACK_HTTPS_ONLY: http:// отклонён (расхождение PDF vs примеры зафиксировано)',
        httpCallback.statusCode === 400 && (httpCallback.json() || {}).error.code === 'invalid_request');
      const httpsOk = await api(httpsPort, 'POST', `${QUEUE}/transaction/receipt`, httpsToken, receiptBody({ metadata: { callbackUrl: 'https://example.test/hook' } }));
      check('MOCK_FIRST_OFD_CALLBACK_HTTPS_ONLY: https:// проходит валидацию', httpsOk.statusCode === 200);
    }

    console.log('— TTL токена 24 ч на виртуальных часах и заявка «в работе»');
    {
      const ttlChild = startChild({ MOCK_FIRST_OFD_TOKEN_TTL_SECS: '86400', MOCK_FIRST_OFD_PROCESS_MS: '1h' });
      children.push(ttlChild);
      const ttlPort = await ttlChild.port;
      const ttlToken = ((await getToken(ttlPort)).json() || {}).token;
      const slow = await submit(ttlPort, ttlToken, 'receipt', receiptBody({ document: { totalSum: 7 } }));
      await request(ttlPort, 'POST', '/mock/time', { advance: '+10m' });
      const slowStatus = (await api(ttlPort, 'GET', `${QUEUE}/status/${slow.requestId}`, ttlToken)).json() || {};
      check('MOCK_FIRST_OFD_PROCESS_MS=1h: заявка остаётся IN_PROGRESS до срока обработки', slowStatus.status === 'IN_PROGRESS');
      await request(ttlPort, 'POST', '/mock/time', { advance: '+50m' });
      const doneStatus = (await api(ttlPort, 'GET', `${QUEUE}/status/${slow.requestId}`, ttlToken)).json() || {};
      check('после +1h заявка обработана (задержка очереди на виртуальных часах)', doneStatus.status === 'COMPLETED');
      await request(ttlPort, 'POST', '/mock/time', { advance: '+25h' });
      checkProviderError('токен истёк через 24 ч виртуальных часов',
        await api(ttlPort, 'GET', `${QUEUE}/status/${slow.requestId}`, ttlToken),
        'invalid_token', 401);
      const freshToken = ((await getToken(ttlPort)).json() || {}).token;
      const afterRefresh = await api(ttlPort, 'GET', `${QUEUE}/status/${slow.requestId}`, freshToken);
      check('после истечения токена новый getToken восстанавливает доступ', afterRefresh.statusCode === 200);
    }
    {
      const singleChild = startChild({ MOCK_FIRST_OFD_TOKEN_SINGLE: '1' });
      children.push(singleChild);
      const singlePort = await singleChild.port;
      const firstToken = ((await getToken(singlePort)).json() || {}).token;
      await getToken(singlePort);
      const revoked = await api(singlePort, 'GET', `${QUEUE}/status/any`, firstToken);
      check('MOCK_FIRST_OFD_TOKEN_SINGLE=1: повторная выдача аннулирует прежний токен ([VERIFY]-режим)',
        revoked.statusCode === 401);
    }

    console.log('— env-парсеры и скрытие env-кредов');
    {
      const envChild = startChild({
        MOCK_FIRST_OFD_PROCESS_MS: '0',
        MOCK_FIRST_OFD_CALLBACK_MAX_ATTEMPTS: '0',
        MOCK_FIRST_OFD_CALLBACK_RETRY_MS: '1h',
        MOCK_FIRST_OFD_LOGIN: 'customsecretlogin',
        MOCK_FIRST_OFD_PASS: 'customsecretvalue',
        MOCK_FIRST_OFD_USER_GROUPS: '*',
      });
      children.push(envChild);
      const envPort = await envChild.port;
      const envHealth = (await request(envPort, 'GET', '/health')).json() || {};
      check('env parser: retry 1h → 3600000ms; attempts=0 нормализовано в 1; processMs=0 разрешён',
        envHealth.callbackRetryMs === 3600000 && envHealth.callbackMaxAttempts === 1 && envHealth.processMs === 0);
      check('env parser: MOCK_FIRST_OFD_USER_GROUPS=* принимает любую группу', envHealth.userGroups === '*');
      await envChild.waitForOutput(/creds: login=/);
      check('start log hides custom creds', !envChild.output().includes('customsecretvalue') && !envChild.output().includes('customsecretlogin')
        && envChild.output().includes('<задан через env, скрыт>'));
      const envToken = await getToken(envPort, { login: 'customsecretlogin', pass: 'customsecretvalue' });
      check('кастомные env-креды работают в getToken', envToken.statusCode === 200 && Boolean((envToken.json() || {}).token));
      const envAuthError = await api(envPort, 'POST', `${QUEUE}/transaction/receipt`, 'deadbeef', receiptBody({ metadata: { userGroup: 'ЛЮБАЯ' } }));
      check('auth DX response never echoes effective env creds', !envAuthError.body.includes('customsecretvalue') && !envAuthError.body.includes('customsecretlogin'));
      const anyGroup = await getToken(envPort, { login: 'customsecretlogin', pass: 'customsecretvalue' });
      const anyGroupRequest = await submit(envPort, (anyGroup.json() || {}).token, 'receipt', receiptBody({ metadata: { userGroup: 'ЛЮБАЯ-ГРУППА' } }));
      check('MOCK_FIRST_OFD_USER_GROUPS=* : заявка с произвольной группой принята', anyGroupRequest.response.statusCode === 200);
    }

    console.log('— сценарии, состояние и песочницы');
    const sandboxA = `firstofd-a-${Date.now().toString(36)}`;
    const sandboxHeaders = { 'X-Mock-Sandbox': sandboxA };
    const sandboxToken = ((await getToken(port, { headers: sandboxHeaders })).json() || {}).token;
    const sandboxRequest = await submit(port, sandboxToken, 'receipt', receiptBody({ document: { totalSum: 8 } }), sandboxHeaders);
    check('песочница: заявка создана в X-Mock-Sandbox', sandboxRequest.response.statusCode === 200 && Boolean(sandboxRequest.requestId));
    const defaultSees = await api(port, 'GET', `${QUEUE}/status/${sandboxRequest.requestId}`, token);
    check('default-песочница не видит чужую заявку (404)', defaultSees.statusCode === 404);
    await request(port, 'POST', '/mock/scenarios', { scenario: 'kkt-error', target: 'transaction', times: 1 }, sandboxHeaders);
    const rulesA = (await request(port, 'GET', '/mock/scenarios', null, sandboxHeaders)).json() || {};
    const rulesDefault = (await request(port, 'GET', '/mock/scenarios', null, { 'X-Mock-Sandbox': 'default' })).json() || {};
    check('правило сценария живёт в своей песочнице', (rulesA.rules || []).length >= 1 && (rulesDefault.rules || []).length === 0);
    await request(port, 'POST', '/mock/reset', {}, sandboxHeaders);
    const rulesAfterReset = (await request(port, 'GET', '/mock/scenarios', null, sandboxHeaders)).json() || {};
    check('/mock/reset очищает сценарии песочницы', (rulesAfterReset.rules || []).length === 0);

    console.log('— журнал и hosted control-plane');
    const journal = (await api(port, 'GET', '/admin/journal', token)).json() || {};
    check('журнал: записаны обращения к API очереди с curl и статусом',
      Array.isArray(journal.entries) && journal.entries.length >= 5
      && journal.entries.every((entry) => typeof entry.curl === 'string')
      && journal.entries.some((entry) => String(entry.path).includes('/api/external/queue/v1/transaction/receipt')));
    {
      const hostedChild = startChild({ MOCK_HOSTED: 'true', MOCK_ADMIN_TOKEN: 'adm1', MOCK_OPERATOR_TOKEN: 'op1' });
      children.push(hostedChild);
      const hostedPort = await hostedChild.port;
      check('hosted: /admin без токена закрыт', (await request(hostedPort, 'GET', '/admin')).statusCode === 401);
      check('hosted: /mock/time без токена закрыт, /health открыт',
        (await request(hostedPort, 'GET', '/mock/time')).statusCode === 401
        && (await request(hostedPort, 'GET', '/health')).statusCode === 200);
    }

    // #98: owned-режим + бизнес-контракт на Authorization: Bearer <токен очереди>.
    // Явный X-Sandbox-Token владельца не должен затеняться токеном очереди.
    console.log('— #98 owned: Bearer-адаптер — приоритет X-Sandbox-Token над Authorization: Bearer');
    {
      const ownedChild = startChild({
        MOCK_HOSTED: '1',
        MOCK_OPERATOR_TOKEN: 'op98',
        MOCK_FIRST_OFD_PROCESS_MS: '1',
      });
      children.push(ownedChild);
      const oPort = await ownedChild.port;
      const created = await request(oPort, 'POST', '/sandboxes', {});
      const createdJson = created.json() || {};
      const ownerToken = createdJson.ownerToken;
      const sbxId = createdJson.id;
      const sbxCreds = createdJson.creds || {};
      check('#98 hosted: POST /sandboxes — id, ownerToken и креды песочницы',
        created.statusCode === 201 && Boolean(sbxId) && Boolean(ownerToken) && Boolean(sbxCreds.login),
        JSON.stringify(createdJson).slice(0, 160));

      const HK = { 'X-Mock-Sandbox': sbxId, 'X-Sandbox-Token': ownerToken };
      const tokenRes = await getToken(oPort, { login: sbxCreds.login, pass: sbxCreds.pass, headers: HK });
      const queueToken = (tokenRes.json() || {}).token;
      check('#98 hosted: креды песочницы выдают токен очереди', Boolean(queueToken), tokenRes.body.slice(0, 160));

      // (а) бизнес-вызов: Bearer <токен очереди> + X-Sandbox-Token <owner-token> → заявка принята
      const owned = await submit(oPort, queueToken, 'receipt', receiptBody({ document: { totalSum: 12 } }), HK);
      check('#98 hosted: Bearer <токен очереди> + X-Sandbox-Token <owner-token> → 200 (было 401 «знание ID ≠ доступ»)',
        owned.response.statusCode === 200 && Boolean(owned.requestId),
        `HTTP ${owned.response.statusCode} ${owned.response.body.slice(0, 160)}`);
      // (а′) control-plane владельца (recordByOwnerToken) с тем же набором заголовков
      const ownerControl = await request(oPort, 'GET', '/mock/state', null, { ...HK, Authorization: `Bearer ${queueToken}` });
      check('#98 hosted: /mock/state владельца с бизнес-Bearer → 200 (control-plane не теряется)',
        ownerControl.statusCode === 200, `HTTP ${ownerControl.statusCode}`);

      // (б) битый/чужой X-Sandbox-Token → 401, токен очереди доступа не даёт
      const foreign = await submit(oPort, queueToken, 'receipt', receiptBody(), { 'X-Mock-Sandbox': sbxId, 'X-Sandbox-Token': 'sbx_foreign-token' });
      check('#98 hosted: чужой X-Sandbox-Token → 401 «знание ID ≠ доступ»', foreign.response.statusCode === 401,
        `HTTP ${foreign.response.statusCode}`);
      const idOnly = await submit(oPort, queueToken, 'receipt', receiptBody(), { 'X-Mock-Sandbox': sbxId });
      check('#98 hosted: только ID + токен очереди → 401 (бизнес-Bearer — не owner-token)',
        idOnly.response.statusCode === 401, `HTTP ${idOnly.response.statusCode}`);
      // ID песочницы в тексте 401 — это то, что клиент сам запросил; утечкой был бы state.
      const noLeak = await request(oPort, 'GET', '/mock/state', null, { 'X-Mock-Sandbox': sbxId, 'X-Sandbox-Token': 'sbx_foreign-token', Authorization: `Bearer ${queueToken}` });
      check('#98 hosted: чужой токен не открывает состояние песочницы (401, state не выдаётся)',
        noLeak.statusCode === 401 && !(noLeak.json() || {}).state && !noLeak.body.includes('totalSum'),
        `HTTP ${noLeak.statusCode}`);

      // (в) fallback сохранён: только Authorization: Bearer <owner-token> → /sandboxes/me отвечает
      const fallback = await request(oPort, 'GET', '/sandboxes/me', undefined, { Authorization: `Bearer ${ownerToken}` });
      check('#98 hosted: Bearer <owner-token> без явных заголовков → 200 (fallback сохранён)',
        fallback.statusCode === 200 && (fallback.json() || {}).sandbox, `HTTP ${fallback.statusCode}`);

      // (г) операторский путь не сломан: Bearer оператора узнаётся даже при затеняющем owner-заголовке
      const operator = await request(oPort, 'GET', '/mock/state', null, { 'X-Mock-Sandbox': sbxId, 'X-Sandbox-Token': 'sbx_foreign-token', Authorization: 'Bearer op98' });
      check('#98 hosted: оператор по Bearer обслужит песочницу даже с чужим X-Sandbox-Token',
        operator.statusCode === 200, `HTTP ${operator.statusCode}`);
    }
  } finally {
    for (const child of children) await child.stop();
    callbackReceiver.close();
  }

  console.log(`\nИТОГ: ${passed} passed, ${failed} failed · callback requests: ${callbackHits.length}`);
  if (failed > 0) {
    console.log('SELFTEST FAILED ✗');
    process.exit(1);
  }
  console.log('SELFTEST PASSED ✅');
}

main().catch((error) => {
  console.error('selftest crashed:', error);
  process.exit(1);
});
