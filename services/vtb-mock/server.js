// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * vtb-mock — мок SMB E-commerce API интернет-эквайринга ВТБ
 * (Stage 2, issue #87). Это НЕ legacy RBS (vtb.rbsuat.com, *.do).
 *
 * Контракт: JSON REST base /openapi/smb/efcp/e-commerce/v1/ (тестовый контур
 * test3.api.vtb.ru:8443); OAuth 2.0 client_credentials на отдельном token
 * endpoint (POST /passport/oauth2/token, form-urlencoded) → access_token с
 * expires_in ≈ 170 с — TTL живёт на виртуальных часах, обновление планируется
 * по expires_in. Бизнес-запросы: Authorization: Bearer + X-IBM-Client-Id
 * (client_id в нижнем регистре, без @ext.vtb.ru) + Content-Type: application/json.
 *
 * Ордера: POST /orders (уникальный merchant orderId, orderName, amount.value —
 * ДЕСЯТИЧНЫЕ рубли, code RUB) возвращает payUrl; повтор orderId идемпотентен.
 * Суммы — десятичные рубли (10.56), не копейки. Ордер живёт 20 минут (expire с
 * tz/мс). Статусы: ордер CREATED/PAID/REFUNDED/PARTIALLY_REFUNDED/CANCELED,
 * операции NEW/CONFIRMED/RECONCILED — status.value строго на своём уровне.
 *
 * Callback: POST JSON {"type":"PAYMENT|REFUND","object":{...}}; payload
 * сохраняется и доставляется КАК ЕСТЬ (в карточном примере платежа поле
 * статуса — `Status`, в примере возврата — `status`; нормализовать нельзя).
 * Подписи/ACK-кода/расписания ретраев в публичных SMB-доках нет — мок их не
 * выдумывает: доставка через core-очередь, ACK-условие «2xx» — локальная
 * договорённость мока [FORK], не утверждение протокола. Источник истины после
 * уведомления — GET /orders/{orderId} или GET /refunds/{refundId}.
 *
 * Официальная тестовая карта из SMB-доки (4111 1111 1111 1111, 12/24) истекла
 * до даты среза — на форме только синтетические мок-карты с [FORK]-пометкой.
 * PAN не хранится. Вне области: legacy RBS, СБП-QR стенды (qr-efcp.bankingapi.ru).
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const core = require('../../packages/core');
const {
  readBody,
  parseBody,
  send,
  sendJson,
  escapeHtml,
  checkControlAccess,
  parseScenarioSpec,
  applyRequestChaos,
  createSandboxRuntime,
  resolveTenancyMode,
  parseMsOr,
} = core;

const log = core.createLog('vtb-mock');

const {
  MOCK_HOST = '0.0.0.0',
  MOCK_PORT = '3106',
  MOCK_VTB_CLIENT_ID = '',
  MOCK_VTB_CLIENT_SECRET = '',
  MOCK_VTB_TOKEN_TTL_SECS = '170',
  MOCK_VTB_PUBLIC_BASE_URL = '',
  MOCK_VTB_CALLBACK_URL = '',
  MOCK_VTB_CALLBACK_RETRY_MS = '60000',
  MOCK_VTB_CALLBACK_MAX_ATTEMPTS = '3',
  MOCK_VTB_ORDER_TTL_SECS = '1200',
  MOCK_VTB_PREAUTH = 'true',
  MOCK_STATE_FILE = '',
  MOCK_BLOCK_PRIVATE_WEBHOOKS = '',
  MOCK_VIRTUAL_CLOCK = '',
  MOCK_ADMIN_TOKEN = '',
  MOCK_OPERATOR_TOKEN = '',
  MOCK_HOSTED = 'false',
  MOCK_TENANCY = '',
  MOCK_SANDBOX_TOKEN = '',
  MOCK_SANDBOX_TTL_MS = '',
  MOCK_SANDBOX_MAX = '',
  MOCK_SANDBOX_MAX_DOCUMENTS = '',
  MOCK_SANDBOX_MAX_STATE_BYTES = '',
  MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES = '',
  MOCK_SANDBOX_RETENTION_MS = '',
  MOCK_SANDBOX_HOST_SUFFIX = '',
  MOCK_SANDBOX_CREATE_LIMIT = '',
} = process.env;

const DEFAULT_CLIENT_ID = 'vtbmocktest';
const DEFAULT_CLIENT_SECRET = 'mockpass123';
const CLIENT_ID_CRED = String(MOCK_VTB_CLIENT_ID || DEFAULT_CLIENT_ID);
const CLIENT_SECRET_CRED = String(MOCK_VTB_CLIENT_SECRET || DEFAULT_CLIENT_SECRET);
const credLogView = (actual, dflt) => (actual === dflt ? dflt : '<задан через env, скрыт>');

/**
 * X-IBM-Client-Id — client_id в нижнем регистре, без @ext.vtb.ru.
 * Нормализация применяется и к кредам стенда, и к заголовку запроса:
 * сверяются именно канонические значения, а «грязный» заголовок отклоняется.
 */
function normalizeClientId(raw) {
  return String(raw === undefined || raw === null ? '' : raw)
    .trim()
    .toLowerCase()
    .replace(/@ext\.vtb\.ru$/, '');
}

const CLIENT_ID_HEADER_EXPECTED = normalizeClientId(CLIENT_ID_CRED);
const PUBLIC_BASE_URL = String(MOCK_VTB_PUBLIC_BASE_URL || '').trim()
  || `http://localhost:${MOCK_PORT}`;
const DEFAULT_CALLBACK_URL = String(MOCK_VTB_CALLBACK_URL || '').trim();
const PREAUTH_ENABLED = core.flagEnabled(MOCK_VTB_PREAUTH, true);
const REST_BASE = '/openapi/smb/efcp/e-commerce/v1/';
const TOKEN_PATH = '/passport/oauth2/token';
const ORDER_TTL_DEFAULT_SECS = 1200; // 20 минут по docs/reference/vtb/01-smb-ecommerce-api.md.
const TOKEN_TTL_DEFAULT_SECS = 170; // ≈170 с по тому же срезу.
const ORDER_ID_MAX = 128; // mock safety cap; точная граница в срезе не зафиксирована.
const ORDER_NAME_MAX = 256;
const DESCRIPTION_MAX = 512;
const RETURN_URL_MAX = 2048;
const MAX_AMOUNT_KOPEKS = 9999999999; // 99 999 999.99 ₽ — mock safety cap.
const MAX_ORDER_LIFETIME_SECS = 24 * 60 * 60; // mock safety cap для expire.

/** Числовой env читается целиком: суффикс времени поддержан, мусор не обрезается. */
function envDurationMs(name, raw, fallback, { min = 0 } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  const value = core.parseDuration(text);
  if (value === null || !Number.isFinite(value)) {
    log(`WARN ${name}=${JSON.stringify(text)} не разобран — используется ${fallback} мс (число или длительность, например '60s'/'1m')`);
    return fallback;
  }
  if (value < min) {
    log(`WARN ${name}=${value} мс меньше допустимого минимума ${min} — используется ${min}`);
    return min;
  }
  return value;
}

/** MOCK_*_SECS: целое число означает секунды, суффикс — длительность. */
function envSeconds(name, raw, fallback) {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    if (Number.isSafeInteger(seconds) && seconds >= 1) return seconds;
    log(`WARN ${name}=${JSON.stringify(text)}: срок меньше 1 с или вне диапазона — используется ${fallback} с`);
    return fallback;
  }
  const milliseconds = core.parseDuration(text);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1000) {
    log(`WARN ${name}=${JSON.stringify(text)} не разобран — используется ${fallback} с (секунды либо длительность вида '20m'/'1h')`);
    return fallback;
  }
  return Math.round(milliseconds / 1000);
}

function envPositiveInteger(name, raw, fallback) {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  if (!/^\d+$/.test(text)) {
    log(`WARN ${name}=${JSON.stringify(text)} не является целым числом — используется ${fallback}`);
    return fallback;
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) {
    log(`WARN ${name}=${JSON.stringify(text)}: число попыток меньше 1 не определено — используется 1`);
    return 1;
  }
  return value;
}

const CALLBACK_RETRY_MS = envDurationMs('MOCK_VTB_CALLBACK_RETRY_MS', MOCK_VTB_CALLBACK_RETRY_MS, 60000);
const CALLBACK_MAX_ATTEMPTS = envPositiveInteger('MOCK_VTB_CALLBACK_MAX_ATTEMPTS', MOCK_VTB_CALLBACK_MAX_ATTEMPTS, 3);
const TOKEN_TTL_SECS = envSeconds('MOCK_VTB_TOKEN_TTL_SECS', MOCK_VTB_TOKEN_TTL_SECS, TOKEN_TTL_DEFAULT_SECS);
const ORDER_TTL_SECS = envSeconds('MOCK_VTB_ORDER_TTL_SECS', MOCK_VTB_ORDER_TTL_SECS, ORDER_TTL_DEFAULT_SECS);
const HOSTED = core.flagEnabled(MOCK_HOSTED);
const OPERATOR_TOKEN = String(MOCK_OPERATOR_TOKEN || '');
const ADMIN_CSRF_SECRET = crypto.randomBytes(32).toString('hex');
const BLOCK_PRIVATE_WEBHOOKS = core.flagEnabled(MOCK_BLOCK_PRIVATE_WEBHOOKS, HOSTED);
const TENANCY = resolveTenancyMode(MOCK_TENANCY, HOSTED, (warning) => log(`WARN ${warning}`));
const SANDBOX_OWNER_TOKEN = String(MOCK_SANDBOX_TOKEN || '').trim();
const SANDBOX_TTL_MS = parseMsOr(MOCK_SANDBOX_TTL_MS, TENANCY === 'owned' ? 24 * 60 * 60 * 1000 : 0);
const SANDBOX_MAX = parseMsOr(MOCK_SANDBOX_MAX, TENANCY === 'owned' ? 100 : 256);
const SANDBOX_MAX_DOCUMENTS = parseMsOr(MOCK_SANDBOX_MAX_DOCUMENTS, TENANCY === 'owned' ? 5000 : 0);
const SANDBOX_RETENTION_MS = parseMsOr(MOCK_SANDBOX_RETENTION_MS, 0);
const SANDBOX_HOST_SUFFIX = String(MOCK_SANDBOX_HOST_SUFFIX || '').trim();
const SANDBOX_CREATE_LIMIT = parseMsOr(MOCK_SANDBOX_CREATE_LIMIT, TENANCY === 'owned' ? 20 : 0);

/* --------------------------------------------------------- per-sandbox state */

const store = core.createStore({ stateFile: MOCK_STATE_FILE, log: console.error });
const restore = store.restore;
const defaultState = store.state;

function createInitialVtbState({ seed = 0 } = {}) {
  return {
    counters: { callbackId: 1 + seed * 1000000, seq: 1 },
    orders: Object.create(null),
    refunds: Object.create(null),
    tokens: Object.create(null),
    callbacks: Object.create(null),
    clockOffsetMs: 0,
  };
}

for (const [key, value] of Object.entries(createInitialVtbState())) {
  if (defaultState[key] === undefined) defaultState[key] = value;
}

function countVtbDocuments(snapshot) {
  return ['orders', 'refunds', 'callbacks'].reduce((n, key) => n + Object.keys(snapshot[key] || {}).length, 0);
}

function vtbRetention(snapshot, now) {
  if (!SANDBOX_RETENTION_MS) return 0;
  const deadline = now - SANDBOX_RETENTION_MS;
  let removed = 0;
  for (const [id, entry] of Object.entries(snapshot.callbacks || {})) {
    const finished = entry && (entry.done || entry.dumped || entry.suppressed);
    const at = Date.parse((entry && (entry.finishedAt || entry.createdAt)) || '') || 0;
    if (finished && at && at <= deadline) {
      delete snapshot.callbacks[id];
      removed += 1;
    }
  }
  return removed;
}

let dropSandboxChildState = () => {};
const sandboxRuntime = createSandboxRuntime({
  state: defaultState,
  persist: store.persist,
  initialStateFactory: createInitialVtbState,
  mode: TENANCY,
  stateFile: MOCK_STATE_FILE,
  sandboxFile: String(process.env.MOCK_SANDBOX_FILE || ''),
  ttlMs: SANDBOX_TTL_MS,
  maxSandboxes: SANDBOX_MAX,
  maxDocuments: SANDBOX_MAX_DOCUMENTS,
  maxStateBytes: parseMsOr(MOCK_SANDBOX_MAX_STATE_BYTES, null),
  globalMaxStateBytes: parseMsOr(MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES, null),
  documentCounter: countVtbDocuments,
  retention: vtbRetention,
  defaultOwnerToken: SANDBOX_OWNER_TOKEN,
  hostSuffix: SANDBOX_HOST_SUFFIX,
  operatorTokens: [MOCK_ADMIN_TOKEN, OPERATOR_TOKEN],
  createLimit: SANDBOX_CREATE_LIMIT,
  onSandboxRemoved: (record) => dropSandboxChildState(record),
  log: (message) => console.error(`[vtb-mock] ${message}`),
});

const state = sandboxRuntime.state;
const persist = sandboxRuntime.persist;
const journal = core.createJournal({ size: 200, sandboxScope: () => sandboxRuntime.current() });
const vtbClientId = () => sandboxRuntime.creds().clientId || CLIENT_ID_CRED;
const vtbClientSecret = () => sandboxRuntime.creds().clientSecret || CLIENT_SECRET_CRED;
const clock = core.createVirtualClock({
  initial: MOCK_VIRTUAL_CLOCK,
  getStateOffset: () => state.clockOffsetMs || 0,
  setStateOffset: (value) => { state.clockOffsetMs = value; persist(); },
});
const scenarios = core.createScenarioRegistry({ clock, sandboxScope: () => sandboxRuntime.current() });
dropSandboxChildState = (record) => { scenarios.dropScope(record); journal.dropScope(record); };

function clearSandboxChildState(record) {
  if (!record) return;
  scenarios.clearRulesFor(record);
  scenarios.clearHistoryFor(record);
  journal.clearFor(record);
}

/* ----------------------------------------------------- synthetic test cards */

/* Официальная тестовая карта SMB-доки (4111 1111 1111 1111, 12/24, CVV 123)
 * истекла до даты среза 2026-10-11 и непригодна для проверки. Карты ниже —
 * СИНТЕТИЧЕСКИЙ [FORK] мока (не карты ВТБ и не legacy-карта 4000 0011 1111 1118
 * из vtb.rbsuat.com). PAN используется только для matching на форме; в состоянии,
 * журнале и callback остаётся маска. */
const CARDS = {
  '4242424242424242': { label: '[FORK] синтетическая · успешная оплата', exp: '1234', cvv: '123', outcome: 'success' },
  '5555555555554444': { label: '[FORK] синтетическая · Mastercard · успех', exp: '1234', cvv: '123', outcome: 'success' },
  '4000000000000002': { label: '[FORK] синтетическая · повторяемый отказ эмитента', exp: '1234', cvv: '123', outcome: 'decline', reason: 'Отказ эмитента (тестовый сценарий)' },
  '4000000000009995': { label: '[FORK] синтетическая · недостаточно средств', exp: '1234', cvv: '123', outcome: 'decline', reason: 'Недостаточно средств (тестовый сценарий)' },
  '4000000000000069': { label: '[FORK] синтетическая · просроченная карта (expire-сценарий)', exp: '0120', cvv: '123', outcome: 'decline', reason: 'Карта просрочена (expire-сценарий мока)' },
};

/* ----------------------------------------------------------- status catalog */

// Статусы ордера — свой уровень status.value; статусами операций не являются.
const ORDER_STATUSES = {
  CREATED: 'ордер создан, не оплачен',
  PAID: 'ордер оплачен',
  REFUNDED: 'по ордеру проведён полный возврат',
  PARTIALLY_REFUNDED: 'по ордеру проведён частичный возврат',
  CANCELED: 'ордер отменён',
};

// Статусы операций (платёж/возврат) — тоже свой уровень status.value.
const OPERATION_STATUSES = {
  NEW: 'операция создана (для preauth — сумма удержана)',
  CONFIRMED: 'операция подтверждена',
  RECONCILED: 'операция сверена',
};

/* Ошибки бизнес-слоя. Публичный SMB-срез фиксирует HTTP-транспорт, но не
 * полную схему тела ошибки: envelope {error, error_description} + mock DX
 * {field, hint, doc} — явный [FORK] мока (по образцу errorCode-форка Сбера),
 * не утверждение о production-каталоге ВТБ. OAuth-ошибки token endpoint
 * следуют RFC 6749 §5.2 — это уже не форк. */
function vtbError(error, description, { field, hint, doc = 'docs/reference/vtb/01-smb-ecommerce-api.md' } = {}) {
  const body = { error, error_description: String(description || '') };
  if (field) body.field = field;
  if (hint) body.hint = hint;
  if (doc) body.doc = doc;
  return body;
}

function errorOutcome(status, error, description, extras = {}) {
  return { status, body: vtbError(error, description, extras) };
}

function jsonRaw(res, statusCode, body, headers = {}) {
  return send(res, statusCode, typeof body === 'string' ? body : JSON.stringify(body), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/* --------------------------------------------------------------- money (RUB)

 * amount.value — десятичные рубли (10.56), не копейки. Внутри — целые копейки,
 * чтобы не носить float-ошибки по суммам. Валидация decimal: положительное
 * число (или цифровая строка) максимум с двумя знаками после точки. */

function parseAmountRubles(raw, { field = 'amount.value' } = {}) {
  const reject = (message) => ({ ok: false, message });
  if (raw === undefined || raw === null || raw === '') {
    return reject(`${field} обязателен: десятичные рубли (например 10.56), не копейки`);
  }
  let text;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return reject(`${field} должен быть конечным числом`);
    text = String(raw);
  } else if (typeof raw === 'string') {
    text = raw.trim();
  } else {
    return reject(`${field} должен быть числом или цифровой строкой, получено ${typeof raw}`);
  }
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return reject(`${field}=${JSON.stringify(raw)} — не десятичная сумма рублей: допустимы цифры, точка и максимум 2 знака после точки (10.56); «10,56», экспоненты и лишние знаки дробной части отклоняются`);
  }
  const [whole, fraction = ''] = text.split('.');
  const kopecks = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(kopecks) || kopecks <= 0) {
    return reject(`${field}=${JSON.stringify(raw)} должен быть больше нуля`);
  }
  if (kopecks > MAX_AMOUNT_KOPEKS) {
    return reject(`${field}=${JSON.stringify(raw)} превышает допустимый максимум мок-стенда ${MAX_AMOUNT_KOPEKS / 100}`);
  }
  return { ok: true, kopecks };
}

function money(kopecks) {
  return { value: kopecks / 100, code: 'RUB' };
}

function parseAmountObject(raw, { field = 'amount' } = {}) {
  if (!isPlainObject(raw)) {
    return { ok: false, message: `${field} должен быть объектом {value, code: "RUB"}` };
  }
  const code = String(raw.code === undefined || raw.code === null ? '' : raw.code).trim().toUpperCase();
  if (code !== 'RUB') {
    return { ok: false, message: `${field}.code="${code || '—'}" не поддерживается: стенд работает только с RUB` };
  }
  return parseAmountRubles(raw.value, { field: `${field}.value` });
}

/* ---------------------------------------------------------------- time utils */

/** ISO с миллисекундами и tz (Z) — формат полей expire/createdAt из среза. */
function isoWithMs(ms) {
  return new Date(ms).toISOString();
}

function validHttpUrl(raw) {
  const text = String(raw || '').trim();
  if (!text || text.length > RETURN_URL_MAX) return false;
  try {
    const url = new URL(text);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------- callback delivery */

/* SMB callback — POST JSON {"type","object"} без подписи; ACK-код публичный
 * срез не фиксирует — isOk «2xx» это локальная договорённость мока [FORK].
 * Наследие legacy RBS (подписи, ACK-коды) сюда не переносится. */
const deliveryLog = (message) => log(core.redactSecretsInText(message));
const deliveryQueue = core.createDeliveryQueue({
  entries: () => state.callbacks,
  retryMs: CALLBACK_RETRY_MS,
  maxAttempts: CALLBACK_MAX_ATTEMPTS,
  persist,
  log: deliveryLog,
  now: () => clock.now(),
  request: (entry) => ({ url: entry.url, data: entry.payload, method: 'POST' }),
  isOk: (response) => response.statusCode >= 200 && response.statusCode < 300,
  blockPrivateHosts: BLOCK_PRIVATE_WEBHOOKS,
  due: (entry) => !entry.done && !entry.dumped && !entry.suppressed && (entry.nextAttemptAt || 0) <= clock.now(),
  prepare: (entry) => { entry.attempts += 1; },
  onFailure: (entry, status, body) => {
    entry.lastStatus = status;
    entry.lastBody = body;
    if (String(status).includes('ERR SSRF_BLOCKED')) {
      entry.dumped = true;
      entry.nextAttemptAt = null;
      entry.finishedAt = clock.iso();
      log(`callback ${entry.id} заблокирован политикой SSRF — терминальный отказ, без повторов`);
      return;
    }
    if (entry.attempts >= CALLBACK_MAX_ATTEMPTS) {
      entry.dumped = true;
      entry.nextAttemptAt = null;
      entry.finishedAt = clock.iso();
      log(`callback ${entry.id} сброшен после ${entry.attempts} попыток`);
      return;
    }
    entry.nextAttemptAt = clock.now() + CALLBACK_RETRY_MS;
  },
  onSuccess: (entry) => {
    entry.done = true;
    entry.nextAttemptAt = null;
    entry.finishedAt = clock.iso();
  },
});

/**
 * Постановка callback в очередь. payload формируется и сохраняется КАК ЕСТЬ:
 * ключ статуса платежа — `Status` (карточный пример среза), ключ статуса
 * возврата — `status` (пример возврата); нормализация регистра запрещена.
 * Сценарий `status-lowercase` намеренно отдаёт SBP-вариант `status` у платежа
 * (как в СБП-примере среза) — для проверки merchant-парсеров, не «исправление».
 */
function scheduleCallback(type, object, spec = null) {
  const target = DEFAULT_CALLBACK_URL;
  if (!target) return null;
  const suppressed = Boolean(spec && (spec.has('webhook-drop') || spec.has('no-webhook') || spec.has('no-callback')));
  const duplicate = Boolean(spec && (spec.has('webhook-duplicate') || spec.has('callback-duplicate')));
  const payload = { type, object };
  const copies = duplicate && !suppressed ? 2 : 1;
  const ids = [];
  for (let index = 0; index < copies; index += 1) {
    const id = String(state.counters.callbackId++);
    state.callbacks[id] = {
      id,
      type,
      orderId: object.orderId || '',
      refundId: object.refundId || '',
      paymentId: object.paymentId || '',
      url: target,
      payload,
      attempts: 0,
      nextAttemptAt: 0,
      lastStatus: suppressed ? 'SUPPRESSED' : null,
      lastBody: suppressed ? 'suppressed by webhook-drop scenario' : null,
      finishedAt: suppressed ? clock.iso() : null,
      done: suppressed,
      dumped: false,
      suppressed,
      createdAt: clock.iso(),
    };
    ids.push(id);
    log(`callback ${id} ${suppressed ? 'подавлен сценарием' : 'поставлен в очередь'}: ${type} / ${object.orderId}`);
  }
  persist();
  return ids;
}

function paymentCallbackObject(payment, order, spec) {
  const lower = Boolean(spec && spec.has('status-lowercase'));
  return {
    paymentId: payment.paymentId,
    paymentCode: payment.paymentCode,
    orderId: order.orderId,
    orderCode: order.orderCode,
    createdAt: isoWithMs(payment.confirmedAtMs || payment.createdAtMs),
    description: order.description || order.orderName,
    amount: money(payment.amountK),
    paymentData: payment.cardMask ? { cardMask: payment.cardMask } : {},
    // Карточный пример среза пишет `Status` (заглавная); СБП-пример — `status`.
    // Нормализовать регистр ключа нельзя; lowercase — только явным сценарием.
    [lower ? 'status' : 'Status']: { value: payment.status },
  };
}

function refundCallbackObject(refund, order) {
  return {
    refundId: refund.refundId,
    paymentId: refund.paymentId,
    paymentCode: refund.paymentCode,
    orderId: order.orderId,
    orderCode: order.orderCode,
    createdAt: isoWithMs(refund.confirmedAtMs || refund.createdAtMs),
    amount: money(refund.amountK),
    // Пример возврата в срезе использует `status` (строчные) — оставляем как есть.
    status: { value: refund.status },
  };
}

/* ---------------------------------------------------------- orders/refunds */

function findOrder(id) {
  return state.orders[String(id || '')] || null;
}

function findRefund(id) {
  return state.refunds[String(id || '')] || null;
}

function orderView(order) {
  return {
    orderId: order.orderId,
    orderName: order.orderName,
    ...(order.description ? { description: order.description } : {}),
    amount: money(order.amountK),
    status: { value: order.status },
    createdAt: order.createdAt,
    expire: order.expire,
    payUrl: `${String(PUBLIC_BASE_URL).replace(/\/$/, '')}/pay/${encodeURIComponent(order.orderId)}${sandboxSuffix()}`,
    ...(order.twoStageParams ? { twoStageParams: order.twoStageParams } : {}),
    ...(order.returnUrl ? { returnUrl: order.returnUrl } : {}),
    ...(order.cancelReason ? { cancelReason: order.cancelReason } : {}),
    ...(order.cardMask ? { paymentData: { cardMask: order.cardMask } } : {}),
    payments: order.payments.map((payment) => ({
      paymentId: payment.paymentId,
      paymentCode: payment.paymentCode,
      amount: money(payment.amountK),
      status: { value: payment.status },
      createdAt: payment.createdAt,
      ...(payment.voided ? { voided: true } : {}),
      ...(payment.cardMask ? { paymentData: { cardMask: payment.cardMask } } : {}),
    })),
    refunds: order.refunds.map((refund) => ({
      refundId: refund.refundId,
      paymentId: refund.paymentId,
      amount: money(refund.amountK),
      status: { value: refund.status },
      createdAt: refund.createdAt,
    })),
  };
}

function refundView(refund) {
  const order = findOrder(refund.orderId);
  return {
    refundId: refund.refundId,
    paymentId: refund.paymentId,
    ...(order ? { orderId: order.orderId, orderCode: order.orderCode } : {}),
    amount: money(refund.amountK),
    status: { value: refund.status },
    createdAt: refund.createdAt,
  };
}

/** Ордер истекает через 20 минут (expire): незакрытая CREATED-оплата → CANCELED. */
function expireOrder(order) {
  if (!order || order.status !== 'CREATED') return false;
  if (order.payments.length > 0) return false; // холд/оплата уже есть — TTL исчерпан оплатой.
  if (!order.expiresAtMs || clock.now() < order.expiresAtMs) return false;
  order.status = 'CANCELED';
  order.cancelReason = 'order expired';
  order.canceledAtMs = clock.now();
  persist();
  log(`ордер ${order.orderId}: истёк TTL (${ORDER_TTL_SECS} c) → CANCELED; callback-типа для истечения в срезе нет, уведомление не создаётся`);
  return true;
}

function tickVtb() {
  const now = clock.now();
  for (const order of Object.values(state.orders)) {
    if (order.status === 'CREATED' && order.payments.length === 0 && order.expiresAtMs && now >= order.expiresAtMs) expireOrder(order);
  }
  // Истёкшие токены вычищаются лениво: TTL токена живёт на виртуальных часах.
  for (const [token, record] of Object.entries(state.tokens || {})) {
    if (record.expiresAtMs <= now) delete state.tokens[token];
  }
}

setInterval(() => {
  sandboxRuntime.tickAll(() => {
    tickVtb();
    deliveryQueue.tick().catch((error) => log(`callback loop: ${error.message}`));
  });
}, 1000).unref();

if (SANDBOX_TTL_MS > 0 || SANDBOX_MAX_DOCUMENTS > 0 || SANDBOX_RETENTION_MS > 0) {
  setInterval(() => {
    const result = sandboxRuntime.sweep();
    if (result.expired) log(`sandbox sweep: удалено по TTL — ${result.expired}`);
  }, Math.max(1000, parseMsOr(process.env.MOCK_SANDBOX_SWEEP_MS, 60000))).unref();
}

/* -------------------------------------------------------------------- auth */

function issueToken() {
  // «Перед каждым новым запросом к песочнице запрашивается актуальный access
  // token» (срез) — мок выдаёт новый токен на каждый client_credentials.
  for (const [token, record] of Object.entries(state.tokens || {})) {
    if (record.expiresAtMs <= clock.now()) delete state.tokens[token];
  }
  const accessToken = crypto.randomBytes(24).toString('hex');
  const now = clock.now();
  state.tokens[accessToken] = {
    clientId: normalizeClientId(vtbClientId()),
    createdAtMs: now,
    expiresAtMs: now + TOKEN_TTL_SECS * 1000,
  };
  persist();
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL_SECS,
  };
}

function handleTokenEndpoint(req, res, raw, body) {
  if (req.method !== 'POST') {
    return jsonRaw(res, 405, {
      error: 'unsupported_method',
      error_description: `Token endpoint принимает POST, получено ${req.method}`,
      hint: `Отправьте POST ${TOKEN_PATH} с form-urlencoded телом grant_type=client_credentials&client_id=...&client_secret=...`,
    });
  }
  if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/x-www-form-urlencoded')) {
    return jsonRaw(res, 415, {
      error: 'invalid_request',
      error_description: 'Token endpoint принимает application/x-www-form-urlencoded',
      hint: 'OAuth 2.0 client_credentials: Content-Type: application/x-www-form-urlencoded (RFC 6749 §4.4.2).',
    });
  }
  const params = new URLSearchParams(raw);
  const grantType = params.get('grant_type') || '';
  if (grantType !== 'client_credentials') {
    return jsonRaw(res, 400, {
      error: 'unsupported_grant_type',
      error_description: `Поддерживается только grant_type=client_credentials, получено «${grantType || '—'}» (RFC 6749 §5.2)`,
      hint: 'Для SMB API ВТБ используется только client_credentials; другие grant types не поддерживаются.',
    });
  }
  const clientId = params.get('client_id') || '';
  const clientSecret = params.get('client_secret') || '';
  if (!constantTimeEqual(clientId, vtbClientId()) || !constantTimeEqual(clientSecret, vtbClientSecret())) {
    log(`token endpoint: отказ авторизации client_id=${core.maskPiiValue('login', clientId)}`);
    return jsonRaw(res, 401, {
      error: 'invalid_client',
      error_description: 'client_id/client_secret не совпадают с кредами стенда (RFC 6749 §5.2)',
      hint: `Синтетические дефолты стенда — ${DEFAULT_CLIENT_ID}/${DEFAULT_CLIENT_SECRET}; свои значения задаются MOCK_VTB_CLIENT_ID/MOCK_VTB_CLIENT_SECRET. Реальные тестовые креды выдаёт банк — они не входят в дефолты.`,
    });
  }
  return sendJson(res, issueToken());
}

/** Bearer + X-IBM-Client-Id для бизнес-запросов SMB API. */
function verifyBusinessAuth(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return errorOutcome(401, 'invalid_token', 'Заголовок Authorization: Bearer <access_token> отсутствует или malformed', {
      field: 'Authorization',
      hint: `Получите access_token через POST ${TOKEN_PATH} (grant_type=client_credentials) и передайте Authorization: Bearer <token>.`,
    });
  }
  const record = state.tokens[match[1].trim()];
  if (!record || record.expiresAtMs <= clock.now()) {
    return errorOutcome(401, 'invalid_token', record ? 'Срок действия access_token истёк' : 'Неизвестный access_token', {
      field: 'Authorization',
      hint: `Токен живёт expires_in=${TOKEN_TTL_SECS} с (виртуальные часы стенда); запросите новый по client_credentials и планируйте обновление по expires_in.`,
    });
  }
  const clientIdHeader = String(req.headers['x-ibm-client-id'] || '');
  if (!clientIdHeader || clientIdHeader !== CLIENT_ID_HEADER_EXPECTED) {
    return errorOutcome(401, 'invalid_client', 'X-IBM-Client-Id отсутствует или не совпадает с client_id стенда', {
      field: 'X-IBM-Client-Id',
      hint: 'X-IBM-Client-Id — client_id в НИЖНЕМ регистре, БЕЗ суффикса @ext.vtb.ru (например vtbmocktest). Заголовок отправляется только на API, не на token endpoint.',
    });
  }
  return null;
}

/* ------------------------------------------------------- business handlers */

function validateCreateOrder(body, { requireTwoStage }) {
  const quota = sandboxRuntime.checkDocuments();
  if (!quota.ok) {
    return errorOutcome(429, 'limit_exceeded', 'Лимит документов песочницы исчерпан', {
      field: 'orderId',
      hint: `${quota.kind === 'bytes' ? 'Исчерпана байтовая квота' : 'Исчерпана квота документов'} (${quota.used}/${quota.limit}); сбросьте эту песочницу или создайте новую.`,
    });
  }
  const orderId = String(body.orderId === undefined || body.orderId === null ? '' : body.orderId).trim();
  if (!orderId || orderId.length > ORDER_ID_MAX) {
    return errorOutcome(400, 'invalid_request', 'orderId отсутствует или не укладывается в лимит стенда', {
      field: 'orderId',
      hint: `Передайте непустой уникальный merchant orderId длиной не более ${ORDER_ID_MAX} символов (ограничение — mock safety cap).`,
    });
  }
  const orderName = String(body.orderName === undefined || body.orderName === null ? '' : body.orderName).trim();
  if (!orderName || orderName.length > ORDER_NAME_MAX) {
    return errorOutcome(400, 'invalid_request', 'orderName отсутствует или не укладывается в лимит стенда', {
      field: 'orderName',
      hint: `Передайте непустой orderName длиной не более ${ORDER_NAME_MAX} символов.`,
    });
  }
  const amount = parseAmountObject(body.amount);
  if (!amount.ok) {
    return errorOutcome(400, 'invalid_amount', amount.message, {
      field: 'amount.value',
      hint: 'amount.value — ДЕСЯТИЧНЫЕ рубли ({"value": 10.56, "code": "RUB"}), не целые копейки; code строго "RUB".',
    });
  }
  if (requireTwoStage) {
    if (!PREAUTH_ENABLED) {
      return errorOutcome(403, 'preauth_disabled', 'Предавторизация не подключена для этого стенда', {
        field: 'twoStageParams',
        hint: 'POST /orders/preauth требует отдельного разрешения банка; в локальном стенде включается MOCK_VTB_PREAUTH=true.',
      });
    }
    if (!isPlainObject(body.twoStageParams)) {
      return errorOutcome(400, 'invalid_request', 'twoStageParams обязателен для preauth-ордера', {
        field: 'twoStageParams',
        hint: 'Передайте объект twoStageParams (форма объекта в публичном срезе не зафиксирована — [VERIFY]); без него используйте POST /orders.',
      });
    }
  }
  let expiresAtMs = clock.now() + ORDER_TTL_SECS * 1000;
  let expireIso = isoWithMs(expiresAtMs);
  if (body.expire !== undefined && body.expire !== null && body.expire !== '') {
    const parsed = Date.parse(String(body.expire));
    if (!Number.isFinite(parsed)) {
      return errorOutcome(400, 'invalid_request', 'expire не разобран как дата ISO 8601', {
        field: 'expire',
        hint: 'Опциональный expire — ISO 8601 с timezone и миллисекундами (например 2026-10-13T18:40:00.000+03:00); без него ордер живёт 20 минут.',
      });
    }
    if (parsed <= clock.now()) {
      return errorOutcome(400, 'invalid_request', 'expire должен быть в будущем', { field: 'expire' });
    }
    if (parsed > clock.now() + MAX_ORDER_LIFETIME_SECS * 1000) {
      return errorOutcome(400, 'invalid_request', `expire дальше ${MAX_ORDER_LIFETIME_SECS / 3600} ч от текущего времени стенда`, {
        field: 'expire',
        hint: `Максимум ${MAX_ORDER_LIFETIME_SECS / 3600} ч — mock safety cap; дефолтный TTL ордера — ${ORDER_TTL_SECS} с (20 минут).`,
      });
    }
    expiresAtMs = parsed;
    expireIso = isoWithMs(parsed);
  }
  let returnUrl = '';
  if (body.returnUrl !== undefined && body.returnUrl !== null && body.returnUrl !== '') {
    if (!validHttpUrl(body.returnUrl)) {
      return errorOutcome(400, 'invalid_request', 'returnUrl некорректен', {
        field: 'returnUrl',
        hint: 'returnUrl — опциональное mock-расширение [FORK]: абсолютный http(s)-URL; в SMB-срезе поля returnUrl нет.',
      });
    }
    returnUrl = String(body.returnUrl).trim();
  }
  return {
    ok: true,
    orderId,
    orderName,
    amountK: amount.kopecks,
    description: String(body.description === undefined || body.description === null ? '' : body.description).slice(0, DESCRIPTION_MAX),
    twoStageParams: requireTwoStage ? body.twoStageParams : null,
    expiresAtMs,
    expireIso,
    returnUrl,
  };
}

function handleCreateOrder(body, spec, { requireTwoStage }) {
  const orderId = String(body.orderId === undefined || body.orderId === null ? '' : body.orderId).trim();
  const existing = orderId ? findOrder(orderId) : null;
  if (existing) {
    // Повтор orderId идемпотентен: возвращается существующий ордер, новый не создаётся.
    expireOrder(existing);
    return {
      status: 200,
      body: orderView(existing),
      replayed: true,
    };
  }
  const validated = validateCreateOrder(body, { requireTwoStage });
  if (!validated.ok) return validated;
  const now = clock.now();
  const order = {
    orderId: validated.orderId,
    orderName: validated.orderName,
    orderCode: String(100000 + state.counters.seq++),
    description: validated.description,
    amountK: validated.amountK,
    twoStageParams: validated.twoStageParams,
    status: 'CREATED',
    createdAt: isoWithMs(now),
    createdAtMs: now,
    expire: validated.expireIso,
    expiresAtMs: validated.expiresAtMs,
    returnUrl: validated.returnUrl,
    cancelReason: null,
    canceledAtMs: null,
    cardMask: null,
    payments: [],
    refunds: [],
  };
  state.orders[order.orderId] = order;
  persist();
  log(`ордер создан: ${order.orderId} amount=${order.amountK} коп. (${money(order.amountK).value} ₽), схема=${requireTwoStage ? 'preauth' : 'одностадийная'}, expire=${order.expire}`);
  return { status: 200, body: orderView(order) };
}

function handleGetOrder(orderId) {
  const order = findOrder(orderId);
  if (!order) {
    return errorOutcome(404, 'order_not_found', `Ордер «${orderId}» не найден`, {
      field: 'orderId',
      hint: 'Проверьте merchant orderId и контекст песочницы; список ордеров не разделяется между песочницами.',
    });
  }
  expireOrder(order);
  return { status: 200, body: orderView(order) };
}

function handleComplete(orderId, body, spec) {
  const order = findOrder(orderId);
  if (!order) {
    return errorOutcome(404, 'order_not_found', `Ордер «${orderId}» не найден`, { field: 'orderId' });
  }
  expireOrder(order);
  if (order.status === 'CANCELED') {
    return errorOutcome(409, 'invalid_order_state', `Ордер «${orderId}» отменён (${order.cancelReason || 'canceled'})`, {
      field: 'orderId',
      hint: 'Завершить холд можно только для живого preauth-ордера; сверьте GET /orders/{orderId}.',
    });
  }
  if (order.status !== 'CREATED') {
    return errorOutcome(409, 'invalid_order_state', `Статус ордера ${order.status} не допускает complete`, {
      field: 'orderId',
      hint: 'complete доступен для preauth-ордера с удержанием (payment.status.value=NEW); статусы ордера и операции не смешиваются.',
    });
  }
  const held = order.payments.find((payment) => payment.status === 'NEW' && !payment.voided);
  if (!held) {
    return errorOutcome(409, 'invalid_order_state', 'У ордера нет удержания для завершения', {
      field: 'orderId',
      hint: 'Сначала оплатите preauth-ордер через payUrl (payment переводится в NEW=hold), затем вызывайте complete.',
    });
  }
  const amount = parseAmountObject(body.amount);
  if (!amount.ok) {
    return errorOutcome(400, 'invalid_amount', amount.message, {
      field: 'amount.value',
      hint: 'amount — десятичные рубли {value, code:"RUB"}; сумма complete не может превышать авторизацию.',
    });
  }
  if (amount.kopecks > held.amountK) {
    return errorOutcome(409, 'amount_exceeds_limit', `Сумма complete ${amount.kopecks / 100} ₽ превышает авторизацию ${held.amountK / 100} ₽`, {
      field: 'amount.value',
      hint: 'Сумма завершения ≤ авторизованной (complete ≤ авторизации); частичное подтверждение поддержано, остаток холда снимается.',
    });
  }
  const authorizedK = held.amountK;
  held.status = spec.has('reconciled') ? 'RECONCILED' : 'CONFIRMED';
  held.amountK = amount.kopecks;
  held.confirmedAtMs = clock.now();
  order.status = 'PAID';
  order.cardMask = held.cardMask;
  persist();
  scheduleCallback('PAYMENT', paymentCallbackObject(held, order, spec), spec);
  log(`complete ${order.orderId}: списано ${amount.kopecks / 100} ₽ ≤ холда ${authorizedK / 100} ₽, payment ${held.paymentId} → ${held.status}`);
  return { status: 200, body: orderView(order) };
}

function handleCancel(orderId, body) {
  const order = findOrder(orderId);
  if (!order) {
    return errorOutcome(404, 'order_not_found', `Ордер «${orderId}» не найден`, { field: 'orderId' });
  }
  expireOrder(order);
  if (order.status !== 'CREATED') {
    return errorOutcome(409, 'invalid_order_state', `Статус ордера ${order.status} не допускает cancel`, {
      field: 'orderId',
      hint: 'Отменить можно неоплаченный ордер (CREATED) либо preauth-ордер до complete; после оплаты используйте /refunds.',
    });
  }
  const reason = String(body && body.cancelReason === undefined ? '' : (body && body.cancelReason) || '').trim();
  order.status = 'CANCELED';
  order.cancelReason = reason || 'canceled by merchant';
  order.canceledAtMs = clock.now();
  // Отмена preauth-ордера снимает холд. Словарь операций среза (NEW/CONFIRMED/
  // RECONCILED) не содержит статуса reversal — мок помечает платёж voided и не
  // выдумывает новое значение status.value [VERIFY].
  for (const payment of order.payments) {
    if (payment.status === 'NEW') {
      payment.voided = true;
      payment.voidedAtMs = clock.now();
    }
  }
  persist();
  // Типов PAYMENT|REFUND для отмены в срезе нет — callback не создаётся (не выдумываем).
  log(`ордер ${order.orderId} отменён: ${order.cancelReason}; callback-типа cancel в срезе нет`);
  return { status: 200, body: orderView(order) };
}

function handleCreateRefund(body, spec) {
  const refundId = String(body.refundId === undefined || body.refundId === null ? '' : body.refundId).trim();
  if (!refundId || refundId.length > ORDER_ID_MAX) {
    return errorOutcome(400, 'invalid_request', 'refundId отсутствует или не укладывается в лимит стенда', {
      field: 'refundId',
      hint: `Передайте непустой уникальный merchant refundId длиной не более ${ORDER_ID_MAX} символов.`,
    });
  }
  // В отличие от orderId, refundId не идемпотентен: повтор — ошибка, а не replay.
  if (findRefund(refundId)) {
    return errorOutcome(409, 'duplicate_refund_id', `Возврат «${refundId}» уже существует`, {
      field: 'refundId',
      hint: 'Идентификаторы возврата должны быть уникальны: повторный refundId — ошибка, а не идемпотентный replay (в отличие от orderId в POST /orders).',
    });
  }
  const paymentId = String(body.paymentId === undefined || body.paymentId === null ? '' : body.paymentId).trim();
  const paymentInfo = findPayment(paymentId);
  if (!paymentInfo) {
    return errorOutcome(404, 'payment_not_found', `Платёж «${paymentId}» не найден`, {
      field: 'paymentId',
      hint: 'paymentId берётся из GET /orders/{orderId} (блок payments) или из PAYMENT-callback; возврат привязан к конкретному платежу.',
    });
  }
  const { order, payment } = paymentInfo;
  if (payment.status === 'NEW' || payment.voided) {
    return errorOutcome(409, 'invalid_order_state', `Платёж ${paymentId} ещё не списан (status.value=NEW${payment.voided ? ', холд снят отменой' : ''})`, {
      field: 'paymentId',
      hint: 'Возвращать можно только списанные средства (payment.status.value=CONFIRMED/RECONCILED); для preauth сначала complete.',
    });
  }
  const amount = parseAmountObject(body.amount);
  if (!amount.ok) {
    return errorOutcome(400, 'invalid_amount', amount.message, {
      field: 'amount.value',
      hint: 'amount — десятичные рубли {value, code:"RUB"}; возврат бывает полным и частичным.',
    });
  }
  const refundedOnPayment = order.refunds
    .filter((entry) => entry.paymentId === paymentId)
    .reduce((sum, entry) => sum + entry.amountK, 0);
  const remaining = payment.amountK - refundedOnPayment;
  if (amount.kopecks > remaining) {
    return errorOutcome(409, 'amount_exceeds_limit', `Сумма возврата ${amount.kopecks / 100} ₽ превышает остаток списания ${remaining / 100} ₽`, {
      field: 'amount.value',
      hint: 'Возврат ограничен списанием по платежу за вычетом уже возвращённого (refund ≤ списания); полный возврат = остатку.',
    });
  }
  const now = clock.now();
  const refund = {
    refundId,
    paymentId,
    paymentCode: payment.paymentCode,
    orderId: order.orderId,
    amountK: amount.kopecks,
    status: spec.has('reconciled') ? 'RECONCILED' : 'CONFIRMED',
    createdAt: isoWithMs(now),
    createdAtMs: now,
    confirmedAtMs: now,
  };
  state.refunds[refundId] = refund;
  order.refunds.push(refund);
  const refundedTotal = order.refunds.reduce((sum, entry) => sum + entry.amountK, 0);
  const capturedTotal = order.payments.reduce((sum, entry) => sum + (entry.status === 'NEW' ? 0 : entry.amountK), 0);
  order.status = capturedTotal > 0 && refundedTotal >= capturedTotal ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  persist();
  scheduleCallback('REFUND', refundCallbackObject(refund, order), spec);
  log(`возврат ${refundId}: ${amount.kopecks / 100} ₽ по платежу ${paymentId}, статус ордера → ${order.status}`);
  return { status: 200, body: refundView(refund) };
}

function findPayment(paymentId) {
  const key = String(paymentId || '');
  for (const order of Object.values(state.orders)) {
    const payment = order.payments.find((entry) => entry.paymentId === key);
    if (payment) return { order, payment };
  }
  return null;
}

function handleGetRefund(refundId) {
  const refund = findRefund(refundId);
  if (!refund) {
    return errorOutcome(404, 'refund_not_found', `Возврат «${refundId}» не найден`, {
      field: 'refundId',
      hint: 'Проверьте merchant refundId из POST /refunds; список возвратов не разделяется между песочницами.',
    });
  }
  return { status: 200, body: refundView(refund) };
}

/* ----------------------------------------------------------- payment form */

const PAGE_SECURITY_HEADERS = {
  'Cache-Control': 'no-store, private',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
};

function sendPage(res, html, statusCode = 200) {
  return send(res, statusCode, html, { 'Content-Type': 'text/html; charset=utf-8', ...PAGE_SECURITY_HEADERS });
}

function page(content) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ВТБ SMB E-commerce · тестовая платёжная страница</title>
<style>
  body{font:16px/1.5 -apple-system,'Segoe UI',Roboto,sans-serif;background:#f3f5f8;margin:0;display:flex;justify-content:center;padding:24px 12px}
  .card{background:#fff;border-radius:16px;max-width:560px;width:100%;padding:24px;box-shadow:0 8px 30px rgba(0,55,155,.09)}
  .logo{font-weight:800;color:#fff;background:#0a3ea5;display:inline-block;border-radius:8px;padding:2px 10px;margin-bottom:8px}
  h1{font-size:20px;margin:0 0 4px}.muted{color:#66717e;font-size:13px;margin-bottom:14px}.sum{font-size:28px;font-weight:700;margin:8px 0 16px}
  label{display:block;font-size:13px;color:#39424e;margin:10px 0 4px}input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d5dce4;border-radius:10px;font-size:16px}
  .cards{display:flex;flex-direction:column;gap:6px;margin:12px 0;border:1px dashed #dce3ea;border-radius:10px;padding:10px;max-height:220px;overflow:auto}.cards label{display:flex;gap:8px;align-items:flex-start;font-size:12px;margin:0;cursor:pointer}
  button{width:100%;margin-top:14px;padding:13px;border:0;border-radius:10px;background:#0a3ea5;color:#fff;font-weight:700;font-size:16px;cursor:pointer}.button-muted{background:#edf1f5;color:#29313a}
  .err{color:#b42318;background:#fff2f0;padding:9px;border-radius:8px;margin:12px 0}
  code{overflow-wrap:anywhere}
</style></head><body><main class=\"card\">${content}</main></body></html>`;
}

const esc = (value) => escapeHtml(value);
const rub = (kopecks) => `${(kopecks / 100).toFixed(2).replace('.', ',')} ₽`;

function sandboxSuffix() {
  const id = sandboxRuntime.currentId();
  return id === 'default' ? '' : `?sandbox=${encodeURIComponent(id)}`;
}

function maskPan(pan) {
  return `${pan.slice(0, 6)}**${pan.slice(-4)}`;
}

function payPage(order, errorMessage = '') {
  const options = Object.entries(CARDS).map(([pan, card]) => (
    `<label><input type="radio" name="preset" value="${pan}" onchange="document.getElementById('pan').value='${pan}';document.getElementById('exp').value='${card.exp}';document.getElementById('cvv').value='${card.cvv}'"> <span>${esc(card.label)}<br><code>${pan.slice(0, 6)}**${pan.slice(-4)} · ${card.exp.slice(0, 2)}/${card.exp.slice(-2)} · CVV ${card.cvv}</code></span></label>`
  )).join('');
  return page(`
    <span class=\"logo\">ВТБ SMB · [FORK] тестовая страница</span>
    <h1>Оплата ордера</h1>
    <div class=\"muted\">orderId <code>${esc(order.orderId)}</code> · orderName <code>${esc(order.orderName)}</code></div>
    <div class=\"sum\">${esc(rub(order.amountK))}</div>
    ${order.description ? `<div class=\"muted\">${esc(order.description)}</div>` : ''}
    <div class=\"muted\">${order.twoStageParams ? 'После успешной авторизации сумма будет удержана (payment NEW); завершите её через POST /orders/complete/{orderId}.' : 'После успешной авторизации сумма будет списана.'} Ордер истекает ${esc(order.expire)}.</div>
    ${errorMessage ? `<div class=\"err\">${esc(errorMessage)}</div>` : ''}
    <form method=\"POST\" action=\"/pay/${encodeURIComponent(order.orderId)}/pay${sandboxSuffix()}\">
      <div class=\"cards\">${options}</div>
      <label>Номер тестовой карты</label><input type=\"text\" id=\"pan\" name=\"pan\" value=\"4242424242424242\" autocomplete=\"off\" required>
      <label>Срок (MMYY)</label><input type=\"text\" id=\"exp\" name=\"exp\" value=\"1234\" autocomplete=\"off\" required>
      <label>CVV</label><input type=\"password\" id=\"cvv\" name=\"cvv\" value=\"123\" autocomplete=\"off\" required>
      <button type=\"submit\">Оплатить</button>
    </form>
    <div class=\"muted\">Только синтетические [FORK]-карты мока: официальная тестовая карта ВТБ (4111 1111 1111 1111, 12/24) истекла и непригодна; legacy-карта RBS сюда не относится. PAN не журналируется и не сохраняется.</div>`);
}

function payStatusPage(order, message = '') {
  const title = order.status === 'PAID' ? 'Ордер оплачен'
    : order.status === 'CANCELED' ? 'Ордер отменён'
      : order.status === 'REFUNDED' ? 'Возврат проведён'
        : order.status === 'PARTIALLY_REFUNDED' ? 'Частичный возврат проведён' : 'Ордер ожидает оплаты';
  return page(`
    <span class=\"logo\">ВТБ SMB · [FORK] тестовая страница</span>
    <h1>${esc(title)}</h1>
    <div class=\"muted\">orderId <code>${esc(order.orderId)}</code> · orderName <code>${esc(order.orderName)}</code></div>
    <div class=\"sum\">${esc(rub(order.amountK))}</div>
    <div class=\"muted\">order status.value=<b>${esc(order.status)}</b>${order.payments.length ? ` · payment status.value=<b>${esc(order.payments[order.payments.length - 1].status)}</b>` : ''}</div>
    ${message ? `<div class=\"err\">${esc(message)}</div>` : ''}
    <div class=\"muted\">Результат подтвердите серверным GET /orders/{orderId}: уведомление — не единственный источник истины.</div>`);
}

function completeCardAttempt(order, card, spec, cardMask) {
  if (card.outcome === 'decline') {
    persist();
    return {
      stage: 'form',
      html: payPage(order, `${card.reason}. Попробуйте другую синтетическую карту — лимита попыток у SMB-контракта нет, действует TTL ордера.`),
    };
  }
  const now = clock.now();
  const payment = {
    paymentId: crypto.randomUUID(),
    paymentCode: String(100000 + state.counters.seq++),
    amountK: order.amountK,
    status: order.twoStageParams ? 'NEW' : (spec.has('reconciled') ? 'RECONCILED' : 'CONFIRMED'),
    createdAt: isoWithMs(now),
    createdAtMs: now,
    confirmedAtMs: order.twoStageParams ? null : now,
    cardMask,
  };
  order.payments.push(payment);
  order.cardMask = cardMask;
  if (order.twoStageParams) {
    // Холд: payment NEW на своём уровне; ордер остаётся CREATED до complete.
    persist();
    log(`preauth-холд ${order.orderId}: payment ${payment.paymentId} NEW = ${payment.amountK / 100} ₽; PAYMENT-callback будет после complete (в срезе нет типа события холда)`);
    return { stage: 'done', redirect: order.returnUrl || null, html: payStatusPage(order, 'Сумма удержана. Завершите холд через POST /orders/complete/{orderId}.') };
  }
  order.status = 'PAID';
  persist();
  scheduleCallback('PAYMENT', paymentCallbackObject(payment, order, spec), spec);
  log(`оплата ${order.orderId}: payment ${payment.paymentId} ${payment.status} = ${payment.amountK / 100} ₽`);
  return { stage: 'done', redirect: order.returnUrl || null, html: payStatusPage(order) };
}

function beginCardPay(order, body, spec) {
  const pan = String(body.pan || '').replace(/[\s-]/g, '');
  const exp = String(body.exp || '').trim();
  const cvv = String(body.cvv || '').trim();
  if (!/^\d{13,19}$/.test(pan)) return { stage: 'form', html: payPage(order, 'Номер карты должен содержать 13–19 цифр.') };
  const card = CARDS[pan];
  if (!card) {
    return {
      stage: 'form',
      html: payPage(order, 'Принимаются только синтетические [FORK]-карты мока; официальная тестовая карта ВТБ истекла, legacy-карты RBS не действуют.'),
    };
  }
  if (exp !== card.exp || cvv !== card.cvv) {
    return { stage: 'form', html: payPage(order, 'Срок/CVV не совпадают с таблицей этой тестовой карты.') };
  }
  if (spec.has('fail')) {
    return completeCardAttempt(order, { outcome: 'decline', reason: 'Отказ платежа смоделирован X-Mock-Scenario: fail' }, spec, maskPan(pan));
  }
  return completeCardAttempt(order, card, spec, maskPan(pan));
}

/* ----------------------------------------------------------- sandbox API */

function sandboxPublicUrl(id) {
  if (SANDBOX_HOST_SUFFIX) {
    try {
      const base = new URL(PUBLIC_BASE_URL);
      return `${base.protocol}//${id}.${SANDBOX_HOST_SUFFIX}`;
    } catch { /* use path fallback */ }
  }
  return `${String(PUBLIC_BASE_URL).replace(/\/$/, '')}/?sandbox=${encodeURIComponent(id)}`;
}

function generateSandboxCreds() {
  return {
    clientId: `vtbsbx${crypto.randomBytes(5).toString('hex')}`,
    clientSecret: core.randomToken(24),
  };
}

function handleSandboxApi(req, res, url, body) {
  const operator = sandboxRuntime.isOperatorRequest(req);
  if (req.method === 'GET') {
    if (TENANCY === 'owned' && !operator) {
      const own = sandboxRuntime.recordByOwnerToken(req);
      if (!own) return jsonRaw(res, 401, vtbError('invalid_client', 'Список песочниц доступен владельцу или оператору', { field: 'X-Sandbox-Token', hint: 'Owner-token выдаётся один раз при POST /sandboxes.' }));
      return sendJson(res, { mode: TENANCY, current: own.id, sandboxes: [sandboxRuntime.describe(own)] });
    }
    return sendJson(res, { mode: TENANCY, current: sandboxRuntime.currentId(), sandboxes: sandboxRuntime.list() });
  }
  if (req.method === 'POST') {
    if (TENANCY === 'owned') {
      try {
        const created = sandboxRuntime.create({
          id: String((body && (body.sandbox || body.id)) || ''),
          creds: generateSandboxCreds(),
          profile: 'vtb-smb',
          ip: (req.socket && req.socket.remoteAddress) || '',
        });
        return sendJson(res, {
          ok: true,
          mode: TENANCY,
          id: created.id,
          url: sandboxPublicUrl(created.id),
          ownerToken: created.ownerToken,
          creds: created.creds,
          expiresAt: created.expiresAt || null,
          ttlMs: SANDBOX_TTL_MS,
          hint: 'Сохраните ownerToken: он показывается один раз. SMB callback не подписан; сверяйте его с GET /orders/{orderId}.',
        }, 201);
      } catch (error) {
        if (core.sendSandboxStateQuotaError(res, error)) return;
        return jsonRaw(res, error.code === 'SANDBOX_EXISTS' ? 409 : 429, vtbError('limit_exceeded', error.message, { hint: 'Проверьте MOCK_SANDBOX_MAX и MOCK_SANDBOX_CREATE_LIMIT.' }));
      }
    }
    const result = sandboxRuntime.switchActive((body && body.sandbox) || 'default');
    if (!result.ok) return jsonRaw(res, 400, vtbError('invalid_request', `Не удалось выбрать песочницу: ${result.error}`));
    return sendJson(res, { ok: true, current: result.current, sandboxes: sandboxRuntime.list() });
  }
  if (req.method === 'DELETE') {
    const target = String((body && body.sandbox) || url.searchParams.get('sandbox') || '');
    if (!target) return jsonRaw(res, 400, vtbError('invalid_request', 'Укажите sandbox для удаления'));
    const record = sandboxRuntime.find(target);
    if (!record) return jsonRaw(res, 404, vtbError('invalid_request', `Песочница «${target}» не найдена`));
    if (TENANCY === 'owned' && !operator && !sandboxRuntime.recordAuthorized(record, req)) {
      return jsonRaw(res, 401, vtbError('invalid_client', 'Удалить песочницу может её владелец или оператор'));
    }
    const result = sandboxRuntime.remove(target, req);
    if (!result.ok) return jsonRaw(res, result.error === 'unauthorized' ? 401 : 400, vtbError('invalid_request', `Не удалось удалить песочницу: ${result.error}`));
    return sendJson(res, { ok: true, removed: result.removed });
  }
  return jsonRaw(res, 405, vtbError('unsupported_method', `Метод ${req.method} для /sandboxes не поддерживается`));
}

function handleSandboxMe(req, res, p) {
  const record = sandboxRuntime.recordByOwnerToken(req) || (TENANCY === 'owned' ? null : sandboxRuntime.current());
  if (!record) return jsonRaw(res, 401, vtbError('invalid_client', 'Требуется owner-token песочницы', { field: 'X-Sandbox-Token', hint: 'Owner-token выдаётся при POST /sandboxes.' }));
  if (p === '/sandboxes/me' && req.method === 'GET') return sendJson(res, { ok: true, mode: TENANCY, sandbox: sandboxRuntime.describe(record), creds: record.creds || null });
  if (p === '/sandboxes/me/reset' && req.method === 'POST') {
    const result = sandboxRuntime.reset(record.id, req);
    return sendJson(res, { ok: Boolean(result.ok), sandbox: result.sandbox });
  }
  if (p === '/sandboxes/me/reset-creds' && req.method === 'POST') {
    const creds = generateSandboxCreds();
    sandboxRuntime.updateCreds(record.id, creds, req);
    return sendJson(res, { ok: true, sandbox: record.id, creds, ownerTokenChanged: false });
  }
  if (p === '/sandboxes/me' && req.method === 'DELETE') {
    const result = sandboxRuntime.remove(record.id, req);
    if (!result.ok) return jsonRaw(res, 400, vtbError('invalid_request', 'default-песочницу удалить нельзя'));
    return sendJson(res, { ok: true, removed: result.removed });
  }
  return jsonRaw(res, 405, vtbError('unsupported_method', `Метод ${req.method} для ${p} не поддерживается`));
}

function sandboxPolicy(p) {
  if (p === '/health' || p === '/openapi.json' || p === '/sandboxes' || p.startsWith('/sandboxes/')) return 'public';
  if (p.startsWith('/admin') || p.startsWith('/mock/')) return 'control';
  if (p.startsWith(REST_BASE) || p === TOKEN_PATH) return 'business';
  if (p.startsWith('/pay/')) return 'form';
  return 'business';
}

function sendSandboxError(res, admission) {
  const id = admission.sandbox || 'default';
  if (admission.kind === 'not-found') return jsonRaw(res, 404, vtbError('invalid_request', `Песочница «${id}» не найдена`, { hint: 'Создайте песочницу: POST /sandboxes.' }));
  if (admission.kind === 'unauthorized') return jsonRaw(res, 401, vtbError('invalid_client', `Доступ к песочнице «${id}» ограничен: знание ID не является доступом`, { field: 'X-Sandbox-Token', hint: 'Передайте owner-token из POST /sandboxes: Authorization: Bearer <ownerToken>, X-Sandbox-Token или ?sandbox_token=.' }));
  if (admission.kind === 'expired') return jsonRaw(res, 410, vtbError('invalid_request', `Песочница «${id}» истекла по TTL`, { hint: 'Создайте новую песочницу через POST /sandboxes.' }));
  if (admission.kind === 'rate-limit' || admission.kind === 'limit') return jsonRaw(res, 429, vtbError('limit_exceeded', 'Лимит создания песочниц исчерпан'));
  return jsonRaw(res, 500, vtbError('system_error', 'Не удалось разрешить контекст песочницы'));
}

/* ---------------------------------------------------------- admin console */

function controlSurface(p) {
  if (p.startsWith('/admin')) return 'admin';
  if (p.startsWith('/mock/')) return 'operator';
  return null;
}

function adminButton(action, id, label, csrfToken, actionUrl) {
  return `<form method=\"POST\" action=\"${esc(actionUrl)}\" style=\"display:inline\"><input type=\"hidden\" name=\"_csrf\" value=\"${esc(csrfToken)}\"><input type=\"hidden\" name=\"action\" value=\"${esc(action)}\"><input type=\"hidden\" name=\"id\" value=\"${esc(id)}\"><button style=\"width:auto;padding:5px 8px;font-size:12px\" type=\"submit\">${esc(label)}</button></form>`;
}

function adminPage(req) {
  const sandboxId = sandboxRuntime.currentId();
  const query = new URL(req.url, 'http://mock.local').searchParams;
  const carry = new URLSearchParams();
  if (sandboxId !== 'default') carry.set('sandbox', sandboxId);
  if (query.get('admin_token')) carry.set('admin_token', query.get('admin_token'));
  const sandboxToken = TENANCY === 'owned' ? sandboxRuntime.ownerTokenOf(req) : '';
  if (sandboxToken) carry.set('sandbox_token', sandboxToken);
  const suffix = carry.toString();
  const actionUrl = `/admin/action${suffix ? `?${suffix}` : ''}`;
  const journalUrl = `/admin/journal${suffix ? `?${suffix}` : ''}`;
  const csrf = core.createCsrfToken(ADMIN_CSRF_SECRET, sandboxId);
  const orders = Object.values(state.orders).sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 40).map((order) => {
    const actions = [];
    if (order.status === 'CREATED') actions.push(adminButton('expire-order', order.orderId, 'expire now', csrf, actionUrl));
    return `<tr><td><code>${esc(order.orderId.slice(0, 12))}</code></td><td>${esc(order.orderName)}</td><td>${esc(order.status)}</td><td>${esc(rub(order.amountK))}</td><td>${order.payments.length}/${order.refunds.length}</td><td>${esc(order.cardMask || '—')}</td><td>${actions.join(' ') || '—'}</td></tr>`;
  }).join('') || '<tr><td colspan=\"7\">ордеров нет</td></tr>';
  const refunds = Object.values(state.refunds).slice(-10).reverse().map((refund) => (
    `<tr><td><code>${esc(refund.refundId)}</code></td><td><code>${esc(refund.paymentId.slice(0, 8))}</code></td><td>${esc(refund.status)}</td><td>${esc(rub(refund.amountK))}</td><td><code>${esc(refund.orderId.slice(0, 12))}</code></td></tr>`
  )).join('') || '<tr><td colspan=\"5\">возвратов нет</td></tr>';
  const callbacks = Object.values(state.callbacks).sort((a, b) => Number(a.id) - Number(b.id)).slice(-20).reverse().map((entry) => {
    const status = entry.suppressed ? 'suppressed' : entry.dumped ? 'dumped' : entry.done ? 'delivered' : `retry@${entry.nextAttemptAt || 0}`;
    return `<tr><td>${esc(entry.id)}</td><td>${esc(entry.type)}</td><td>${esc(String((entry.payload.object || {}).refundId || (entry.payload.object || {}).paymentId || ''))}</td><td>${entry.attempts}</td><td>${esc(status)}</td><td>${esc(String(entry.lastStatus || '—'))}</td><td>${adminButton('duplicate-callback', entry.id, 'повторить', csrf, actionUrl)}</td></tr>`;
  }).join('') || '<tr><td colspan=\"7\">callback не отправлялись</td></tr>';
  const journalRows = journal.list().slice(-15).reverse().map((entry) => (
    `<tr><td>${esc(String(entry.at).slice(11, 19))}</td><td>${esc(entry.method)}</td><td><code>${esc(entry.path)}</code></td><td>${entry.status}</td><td>${entry.ms} ms</td><td><code>${esc(String(entry.curl || '').slice(0, 100))}…</code></td></tr>`
  )).join('') || '<tr><td colspan=\"6\">запросов ещё не было</td></tr>';
  return page(`
    <span class=\"logo\">ВТБ SMB · mock</span>
    <h1>Консоль стенда</h1>
    <div class=\"muted\">Синтетические креды: ${DEFAULT_CLIENT_ID} · preauth=${PREAUTH_ENABLED} · token TTL ${TOKEN_TTL_SECS} с · callback: POST JSON {"type","object"} без подписи · ACK-условие 2xx [FORK] · ретраи ${CALLBACK_RETRY_MS} ms × ${CALLBACK_MAX_ATTEMPTS} · виртуальное время ${esc(clock.iso())} · sandbox ${esc(sandboxId)}</div>
    <div class=\"err\">Только синтетические [FORK]-карты. Уведомление — не источник истины: сверяйте GET /orders/{orderId}. status.value ордера и операции не смешиваются.</div>
    <h2>Ордеры (последние 40)</h2><table style=\"width:100%;font-size:12px\">${orders}</table>
    <h2>Возвраты (последние 10)</h2><table style=\"width:100%;font-size:12px\">${refunds}</table>
    <h2>Callbacks (последние 20)</h2><table style=\"width:100%;font-size:12px\">${callbacks}</table>
    <h2>Журнал SMB REST — <a href=\"${esc(journalUrl)}\">JSON</a></h2><table style=\"width:100%;font-size:12px\">${journalRows}</table>`);
}

function adminAction(body) {
  const { action, id } = body || {};
  if (action === 'expire-order') {
    const order = findOrder(id);
    if (order && order.status === 'CREATED' && order.payments.length === 0) {
      order.expiresAtMs = clock.now();
      expireOrder(order);
    }
  } else if (action === 'duplicate-callback') {
    const original = state.callbacks[String(id)];
    if (original) {
      const copy = {
        ...original,
        id: String(state.counters.callbackId++),
        payload: { type: original.payload.type, object: { ...original.payload.object } },
        attempts: 0,
        nextAttemptAt: 0,
        lastStatus: null,
        lastBody: null,
        finishedAt: null,
        done: false,
        dumped: false,
        suppressed: false,
        createdAt: clock.iso(),
      };
      state.callbacks[copy.id] = copy;
      persist();
    }
  }
  return { redirect: '/admin' };
}

/* --------------------------------------------------------------- HTTP router */

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
function buildJsonCurl(req, p, raw) {
  const base = String(PUBLIC_BASE_URL).replace(/\/$/, '');
  const parts = [`curl -sS -X ${req.method} ${shellQuote(`${base}${p}`)}`, `-H ${shellQuote('Content-Type: application/json')}`];
  const auth = String((req.headers && req.headers.authorization) || '');
  if (auth) parts.push(`-H ${shellQuote(`Authorization: ${core.redactSecretsInText(auth)}`)}`);
  const clientId = String((req.headers && req.headers['x-ibm-client-id']) || '');
  if (clientId) parts.push(`-H ${shellQuote(`X-IBM-Client-Id: ${clientId}`)}`);
  const scenario = String((req.headers && req.headers['x-mock-scenario']) || '');
  if (scenario) parts.push(`-H ${shellQuote(`X-Mock-Scenario: ${core.redactSecretsInText(scenario)}`)}`);
  const sandbox = String((req.headers && req.headers['x-mock-sandbox']) || '');
  if (sandbox) parts.push(`-H ${shellQuote(`X-Mock-Sandbox: ${sandbox}`)}`);
  const safeRaw = core.redactRawBody(raw);
  if (safeRaw) parts.push(`--data ${shellQuote(safeRaw)}`);
  return parts.join(' ');
}

async function route(req, res) {
  const url = new URL(req.url, 'http://mock.local');
  const p = url.pathname;
  const raw = await readBody(req);
  const body = parseBody(raw, req.headers['content-type']);
  const admission = sandboxRuntime.admit(req, sandboxPolicy(p));
  if (!admission.ok) return sendSandboxError(res, admission);
  return sandboxRuntime.run(admission, () => routeRequest(req, res, url, p, raw, body, admission));
}

async function routeRequest(req, res, url, p, raw, body, admission) {
  const surface = controlSurface(p);
  const owner = sandboxRuntime.recordByOwnerToken(req);
  const ownerSurface = surface === 'operator' && Boolean(owner && admission.record && owner.id === admission.record.id);
  if (surface && admission.via !== 'owner' && !ownerSurface) {
    const access = checkControlAccess(req, { adminToken: MOCK_ADMIN_TOKEN, operatorToken: OPERATOR_TOKEN, surface, hosted: HOSTED });
    if (!access.allowed) {
      const envName = surface === 'admin' ? 'MOCK_ADMIN_TOKEN' : 'MOCK_OPERATOR_TOKEN';
      const message = access.reason === 'hosted-fail-closed'
        ? `${p} закрыт в hosted-режиме: задайте ${envName}`
        : `Для ${p} требуется управляющий токен ${envName}`;
      return jsonRaw(res, 401, vtbError('invalid_token', message, { field: surface === 'admin' ? 'Authorization' : 'X-Operator-Token', hint: `Передайте Authorization: Bearer <${envName}> или X-Operator-Token/X-Admin-Token.` }));
    }
  }

  const isRest = p.startsWith(REST_BASE);
  if (isRest || p === TOKEN_PATH) {
    const started = Date.now();
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (code, ...args) => {
      journal.record({
        method: req.method,
        path: p,
        status: code,
        ms: Date.now() - started,
        body: core.summarizeBody(body, { maxKeys: 8, maxValueLength: 60 }),
        rawBody: raw,
        headers: req.headers,
        baseUrl: PUBLIC_BASE_URL,
        curl: buildJsonCurl(req, p, raw),
      });
      return originalWriteHead(code, ...args);
    };
    const chaos = await applyRequestChaos(req, parseScenarioSpec(req.headers['x-mock-scenario'] || ''));
    sandboxRuntime.current(); // fail-closed, если аренда истекла во время await.
    if (chaos.abortStatus) {
      return jsonRaw(res, chaos.abortStatus, vtbError('system_error', chaos.abortMessage, { hint: 'X-Mock-Scenario смоделировал транспортный сбой до SMB-операции; повторите запрос и сверьте состояние.' }));
    }
  }

  if (req.method === 'GET' && p === '/openapi.json') {
    const specPath = path.join(__dirname, '..', '..', 'docs', 'openapi', 'vtb-mock.openapi.json');
    return sendJson(res, JSON.parse(fs.readFileSync(specPath, 'utf8')));
  }
  if (req.method === 'GET' && p === '/health') {
    const health = {
      ok: true,
      sandbox: sandboxRuntime.currentId(),
      tenancy: TENANCY,
      api: 'smb-ecommerce-json',
      base: REST_BASE,
      tokenPath: TOKEN_PATH,
      tokenTtlSecs: TOKEN_TTL_SECS,
      orderTtlSecs: ORDER_TTL_SECS,
      preauth: PREAUTH_ENABLED,
      callbackMethod: 'POST',
      callbackSignature: 'none',
      callbackRetryMs: CALLBACK_RETRY_MS,
      callbackMaxAttempts: CALLBACK_MAX_ATTEMPTS,
    };
    if (TENANCY !== 'owned' || (admission.record.isDefault && !admission.record.ownerTokenHash) || admission.via === 'owner' || admission.via === 'operator') {
      Object.assign(health, {
        orders: Object.keys(state.orders).length,
        refunds: Object.keys(state.refunds).length,
        awaiting: Object.values(state.orders).filter((order) => order.status === 'CREATED').length,
        callbacks: Object.keys(state.callbacks).length,
      });
    }
    return sendJson(res, health);
  }
  if (req.method === 'GET' && p === '/admin/journal') return sendJson(res, { entries: journal.list() });

  if (p === TOKEN_PATH) return handleTokenEndpoint(req, res, raw, body);

  if (p === '/sandboxes' || p === '/mock/sandboxes') return handleSandboxApi(req, res, url, body);
  if (p.startsWith('/sandboxes/')) return handleSandboxMe(req, res, p);

  if (p === '/mock/reset' && req.method === 'POST') {
    const target = (body && body.sandbox) || admission.record.id;
    const result = sandboxRuntime.reset(target, req);
    if (!result.ok) return sendSandboxError(res, { ok: false, kind: result.error || 'not-found', sandbox: target });
    clearSandboxChildState(sandboxRuntime.find(target));
    return sendJson(res, { ok: true, sandbox: result.sandbox, current: sandboxRuntime.currentId() });
  }
  if (p === '/mock/state') {
    if (req.method === 'GET') {
      const target = url.searchParams.get('sandbox') || undefined;
      const snapshot = target ? sandboxRuntime.exportState(target, req) : sandboxRuntime.exportState(null, req);
      if (snapshot && snapshot.ok === false) return sendSandboxError(res, { ok: false, kind: snapshot.error || 'unauthorized', sandbox: snapshot.sandbox || target || admission.record.id });
      return sendJson(res, { sandbox: snapshot.sandbox || admission.record.id, state: snapshot.state ? snapshot.state : snapshot });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      if (raw.trim() && String(req.headers['content-type'] || '').includes('application/json')) {
        try { JSON.parse(raw); } catch { return jsonRaw(res, 400, vtbError('invalid_request', 'Снимок состояния не является валидным JSON', { field: 'state' })); }
      }
      const target = (body && body.sandbox) || admission.record.id;
      const snapshot = (body && body.state) || body || {};
      try {
        const imported = sandboxRuntime.importState(snapshot, target, req);
        if (!imported.ok) return sendSandboxError(res, { ok: false, kind: imported.error || 'unauthorized', sandbox: imported.sandbox || target });
        return sendJson(res, { ok: true, sandbox: imported.sandbox });
      } catch (error) {
        if (core.sendSandboxStateQuotaError(res, error)) return;
        return jsonRaw(res, 400, vtbError('invalid_request', `Недопустимый снимок состояния: ${error.message}`, { field: 'state', hint: 'Опасные ключи __proto__, constructor и prototype запрещены.' }));
      }
    }
  }
  if (p === '/mock/time') {
    if (req.method === 'GET') return sendJson(res, clock.snapshot());
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        const snapshot = clock.set(body || {});
        tickVtb();
        await deliveryQueue.tick();
        return sendJson(res, snapshot);
      } catch (error) {
        if (core.sendSandboxStateQuotaError(res, error)) return;
        return jsonRaw(res, 400, vtbError('invalid_request', error.message, { field: 'advance|offset|iso', hint: 'Поля: advance (например "+20m"), offset (мс), iso (дата), reset (true).' }));
      }
    }
  }
  if (p === '/mock/scenarios') {
    if (req.method === 'GET') return sendJson(res, { rules: scenarios.listRules(), history: scenarios.listHistory() });
    if (req.method === 'POST') {
      try { return sendJson(res, { ok: true, rule: scenarios.addRule(body || {}) }); } catch (error) {
        const result = vtbError('invalid_request', error.message, { field: 'scenario', hint: 'Поля: scenario, target (orders/orderspreauth/orderscomplete/orderscancel/refunds/getorder/getrefund/token/pay/*), match, times или persistent. Особые: status-lowercase, reconciled.' });
        if (error.code) result.code = error.code;
        return jsonRaw(res, 400, result);
      }
    }
    if (req.method === 'DELETE') {
      scenarios.clearRules();
      scenarios.clearHistory();
      return sendJson(res, { ok: true, rules: [], history: [] });
    }
  }

  if (req.method === 'GET' && p === '/admin') return sendPage(res, adminPage(req));
  if (req.method === 'POST' && p === '/admin/action') {
    if (!core.isSameOriginRequest(req) || !core.verifyCsrfToken(body && body._csrf, ADMIN_CSRF_SECRET, sandboxRuntime.currentId())) {
      return jsonRaw(res, 403, vtbError('invalid_token', 'Запрос заблокирован: отсутствует или неверен CSRF-токен', { field: '_csrf', hint: 'Откройте /admin и отправьте действие из формы консоли.' }));
    }
    const result = adminAction(body);
    const query = new URL(req.url, 'http://mock.local').searchParams;
    const carry = new URLSearchParams();
    const sandboxId = sandboxRuntime.currentId();
    if (sandboxId !== 'default') carry.set('sandbox', sandboxId);
    if (query.get('admin_token')) carry.set('admin_token', query.get('admin_token'));
    if (query.get('sandbox_token')) carry.set('sandbox_token', query.get('sandbox_token'));
    const suffix = carry.toString();
    return send(res, 302, '', { Location: `${result.redirect}${suffix ? `?${suffix}` : ''}` });
  }

  /* ------------------------------------------------------- hosted pay page */
  const payMatch = p.match(/^\/pay\/([A-Za-z0-9_.-]+)$/);
  if (payMatch && req.method === 'GET') {
    const order = findOrder(decodeURIComponent(payMatch[1]));
    if (!order) return sendPage(res, page('<span class=\"logo\">ВТБ SMB · mock</span><h1>Ордер не найден</h1>'), 404);
    expireOrder(order);
    if (order.status === 'CREATED' && order.payments.length === 0) return sendPage(res, payPage(order));
    return sendPage(res, payStatusPage(order));
  }
  const paySubmitMatch = p.match(/^\/pay\/([A-Za-z0-9_.-]+)\/pay$/);
  if (paySubmitMatch && req.method === 'POST') {
    const order = findOrder(decodeURIComponent(paySubmitMatch[1]));
    if (!order) return sendPage(res, page('<span class=\"logo\">ВТБ SMB · mock</span><h1>Ордер не найден</h1>'), 404);
    expireOrder(order);
    if (order.status !== 'CREATED' || order.payments.length > 0) {
      return sendPage(res, payStatusPage(order, 'Ордер уже не принимает карточные данные.'));
    }
    const spec = resolveRequestSpec('pay', req, body, { orderId: order.orderId });
    const result = beginCardPay(order, body || {}, spec);
    if (result.redirect) return send(res, 302, '', { Location: result.redirect });
    return sendPage(res, result.html);
  }

  /* ------------------------------------------------------- SMB REST router */
  if (isRest) return handleRest(req, res, p, raw, body);
  return jsonRaw(res, 404, vtbError('not_found', `Неизвестный маршрут: ${req.method} ${p}`, {
    hint: `SMB REST начинается с ${REST_BASE}; token endpoint — ${TOKEN_PATH}; тестовая страница — /pay/{orderId}.`,
    doc: '',
  }));
}

function resolveRequestSpec(target, req, body, context = {}) {
  const header = (req && req.headers && req.headers['x-mock-scenario']) || '';
  return scenarios.resolve({
    header,
    bodyScenario: body && typeof body.mock_scenario === 'string' ? body.mock_scenario : '',
    target,
    context,
  });
}

function requireJsonBody(req, raw, body) {
  if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
    return errorOutcome(415, 'invalid_request', 'SMB API принимает только application/json', {
      field: 'Content-Type',
      hint: 'Отправьте UTF-8 JSON с Content-Type: application/json.',
    });
  }
  if (raw.trim()) {
    try { JSON.parse(raw); } catch {
      return errorOutcome(400, 'invalid_request', 'Тело запроса не является валидным JSON', { field: 'body', hint: 'Проверьте синтаксис JSON и повторите запрос.' });
    }
  }
  if (!isPlainObject(body)) {
    return errorOutcome(400, 'invalid_request', 'JSON-тело должно быть объектом', { field: 'body' });
  }
  return null;
}

async function handleRest(req, res, p, raw, body) {
  const rel = p.slice(REST_BASE.length);
  const routes = [
    { method: 'POST', re: /^orders$/, target: 'orders' },
    { method: 'POST', re: /^orders\/preauth$/, target: 'orderspreauth' },
    { method: 'POST', re: /^orders\/complete\/([A-Za-z0-9_.-]+)$/, target: 'orderscomplete' },
    { method: 'POST', re: /^orders\/([A-Za-z0-9_.-]+)\/cancel$/, target: 'orderscancel' },
    { method: 'GET', re: /^orders\/([A-Za-z0-9_.-]+)$/, target: 'getorder' },
    { method: 'POST', re: /^refunds$/, target: 'refunds' },
    { method: 'GET', re: /^refunds\/([A-Za-z0-9_.-]+)$/, target: 'getrefund' },
  ];
  const matched = routes.find((entry) => entry.method === req.method && entry.re.test(rel));
  if (!matched) {
    const anyMethod = routes.find((entry) => entry.re.test(rel));
    if (anyMethod) {
      return jsonRaw(res, 405, vtbError('unsupported_method', `Метод ${req.method} не поддерживается для /${rel}`, {
        hint: `Для этого маршрута используется ${anyMethod.method}; SMB API — JSON REST.`,
      }));
    }
    return jsonRaw(res, 404, vtbError('not_found', `Неизвестный SMB REST-метод: ${p}`, {
      hint: `Поддерживаются POST ${REST_BASE}{orders,orders/preauth,orders/complete/{orderId},orders/{orderId}/cancel,refunds} и GET ${REST_BASE}{orders/{orderId},refunds/{refundId}}.`,
    }));
  }
  const bodyError = req.method === 'GET' ? null : requireJsonBody(req, raw, body);
  if (bodyError) return jsonRaw(res, bodyError.status, bodyError.body);
  const authError = verifyBusinessAuth(req);
  if (authError) return jsonRaw(res, authError.status, authError.body);

  const [, idParam] = rel.match(matched.re) || [];
  const spec = resolveRequestSpec(matched.target, req, body, { orderId: idParam || String((body && body.orderId) || ''), path: p });
  if (spec.has('hang')) await new Promise(() => {});
  if (spec.has('fail')) {
    return jsonRaw(res, 500, vtbError('system_error', 'Системная ошибка (смоделирована сценарием fail)', {
      hint: 'Сценарий fail не выполняет бизнес-операцию; повторите после паузы и сверьте состояние через GET /orders/{orderId}.',
    }));
  }

  let outcome;
  switch (matched.target) {
    case 'orders':
      outcome = handleCreateOrder(body, spec, { requireTwoStage: false });
      break;
    case 'orderspreauth':
      outcome = handleCreateOrder(body, spec, { requireTwoStage: true });
      break;
    case 'orderscomplete':
      outcome = handleComplete(idParam, body, spec);
      break;
    case 'orderscancel':
      outcome = handleCancel(idParam, body);
      break;
    case 'getorder':
      outcome = handleGetOrder(idParam);
      break;
    case 'refunds':
      outcome = handleCreateRefund(body, spec);
      break;
    case 'getrefund':
      outcome = handleGetRefund(idParam);
      break;
    default:
      outcome = errorOutcome(500, 'system_error', 'Метод не реализован');
  }
  const headers = outcome.replayed ? { 'X-Mock-Replayed': '1' } : {};
  return jsonRaw(res, outcome.status, outcome.body, headers);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    if (core.sendSandboxStateQuotaError(res, error)) return;
    if (error && error.code === 'SANDBOX_EXPIRED') {
      try { sendSandboxError(res, { ok: false, kind: 'expired', sandbox: error.sandbox || 'default' }); } catch { /* headers sent */ }
      return;
    }
    if (error && error.code === 'BODY_TOO_LARGE') {
      try { jsonRaw(res, 413, vtbError('invalid_request', 'Размер тела запроса превышает допустимый лимит', { field: 'body', hint: `Уменьшите тело до ${error.maxBytes} байт или менее.` })); } catch { /* headers sent */ }
      return;
    }
    log(`request error: ${error && error.message ? error.message : 'unknown error'}`);
    try { jsonRaw(res, 500, vtbError('system_error', 'Внутренняя ошибка мок-стенда')); } catch { /* headers sent */ }
  });
});

restore();

// После restore/startup-миграций снимок отката должен содержать восстановленные данные.
sandboxRuntime.refreshStateQuota();

if (require.main === module) {
  const port = Number(MOCK_PORT);
  server.listen(Number.isFinite(port) && port >= 0 ? port : 3106, MOCK_HOST, () => {
    const actualPort = server.address().port;
    log(`vtb-mock (ВТБ SMB E-commerce API) on http://${MOCK_HOST}:${actualPort}`);
    log(`creds: clientId=${credLogView(CLIENT_ID_CRED, DEFAULT_CLIENT_ID)} clientSecret=${credLogView(CLIENT_SECRET_CRED, DEFAULT_CLIENT_SECRET)} (дефолты СИНТЕТИЧЕСКИЕ; фактические значения MOCK_VTB_CLIENT_ID/MOCK_VTB_CLIENT_SECRET в лог не попадают)`);
    log(`auth: POST ${TOKEN_PATH} (client_credentials) → expires_in=${TOKEN_TTL_SECS}s на виртуальных часах; бизнес-заголовки Authorization: Bearer + X-IBM-Client-Id (lowercase, без @ext.vtb.ru)`);
    log(`callback: POST JSON {type,object} без подписи · ACK-условие 2xx [FORK, не протокол] · retry ${CALLBACK_RETRY_MS}ms × ${CALLBACK_MAX_ATTEMPTS} (график — локальная договорённость мока)`);
    log(`order TTL=${ORDER_TTL_SECS}s (expire с tz/мс) · preauth=${PREAUTH_ENABLED} · amount.value — десятичные рубли · tenancy=${TENANCY} · hosted=${HOSTED} · block_private_webhooks=${BLOCK_PRIVATE_WEBHOOKS}`);
    log('вне области: legacy RBS (vtb.rbsuat.com, *.do), СБП-QR стенды qr-efcp.bankingapi.ru; официальная тестовая карта SMB-доки истекла — на форме синтетические [FORK]-карты');
  });
}

module.exports = {
  server,
  state,
  clock,
  scenarios,
  sandboxRuntime,
  persist,
  restore,
  route,
  CARDS,
  ORDER_STATUSES,
  OPERATION_STATUSES,
  REST_BASE,
  TOKEN_PATH,
  orderView,
  tickVtb,
};
