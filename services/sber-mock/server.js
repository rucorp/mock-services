// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * sber-mock — мок интернет-эквайринга Сбербанка, шлюз Ecom REST v1.1.11.1
 * (Stage 2, issue #81). Это не legacy Secure Payments API.
 *
 * Контракт: POST JSON на /ecomm/gw/partner/api/v1/*.do; userName/password в
 * каждом вызове; amount — целые копейки, currency=643, orderNumber уникален.
 * register.do/registerPreAuth.do возвращают orderId + formUrl. Итоговая
 * серверная сверка — getOrderStatusExtended.do: orderStatus 0…6 — состояние
 * заказа, actionCode — отдельный код результата операции; errorCode=0 означает
 * обработанный API-вызов, а не успешную оплату.
 *
 * Callback Ecom — POST JSON без подписи (legacy-подпись Secure Payments сюда
 * не переносится): mdOrder/orderNumber/operation/status и optional
 * additionalParams; ACK — ровно HTTP 200. Протокольные источники:
 * docs/reference/sber/01-payment-api.md и 02-callbacks-and-test.md.
 *
 * Не реализовано без merchant-разрешения: paymentOrder.do. Вне области:
 * SberPay/SBP Sandbox и моделирование orderBundle. Дефолтные креды — только
 * синтетические, тестовые реквизиты Сбербанка не зашиты в конфигурацию.
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

const log = core.createLog('sber-mock');

const {
  MOCK_HOST = '0.0.0.0',
  MOCK_PORT = '3105',
  MOCK_SBER_USERNAME = '',
  MOCK_SBER_PASSWORD = '',
  MOCK_SBER_PUBLIC_BASE_URL = '',
  MOCK_SBER_CALLBACK_URL = '',
  MOCK_SBER_CALLBACK_RETRY_MS = '60000',
  MOCK_SBER_CALLBACK_MAX_ATTEMPTS = '3',
  MOCK_SBER_SESSION_TIMEOUT_SECS = '1200',
  MOCK_SBER_TWO_STAGE = 'true',
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

const DEFAULT_USER_NAME = 'SBERMOCKTEST';
const DEFAULT_PASSWORD = 'mockpass123';
const USER_NAME_CRED = String(MOCK_SBER_USERNAME || DEFAULT_USER_NAME);
const PASSWORD_CRED = String(MOCK_SBER_PASSWORD || DEFAULT_PASSWORD);
const credLogView = (actual, dflt) => (actual === dflt ? dflt : '<задан через env, скрыт>');
const PUBLIC_BASE_URL = String(MOCK_SBER_PUBLIC_BASE_URL || '').trim()
  || `http://localhost:${MOCK_PORT}`;
const DEFAULT_CALLBACK_URL = String(MOCK_SBER_CALLBACK_URL || '').trim();
const TWO_STAGE = core.flagEnabled(MOCK_SBER_TWO_STAGE, true);
const MAX_PAYMENT_ATTEMPTS = 3;
const DEFAULT_ORDER_TTL_SECS = 1200;
const ORDER_NUMBER_MAX = 128; // mock safety cap; точная граница в срезе Ecom не зафиксирована.
const RETURN_URL_MAX = 2048;

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

const CALLBACK_RETRY_MS = envDurationMs('MOCK_SBER_CALLBACK_RETRY_MS', MOCK_SBER_CALLBACK_RETRY_MS, 60000);
const CALLBACK_MAX_ATTEMPTS = envPositiveInteger('MOCK_SBER_CALLBACK_MAX_ATTEMPTS', MOCK_SBER_CALLBACK_MAX_ATTEMPTS, 3);
const SESSION_TIMEOUT_SECS = envSeconds('MOCK_SBER_SESSION_TIMEOUT_SECS', MOCK_SBER_SESSION_TIMEOUT_SECS, DEFAULT_ORDER_TTL_SECS);
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

function createInitialSberState({ seed = 0 } = {}) {
  return {
    counters: { callbackId: 1 + seed * 1000000 },
    orders: Object.create(null),
    orderNumbers: Object.create(null),
    callbacks: Object.create(null),
    clockOffsetMs: 0,
  };
}

for (const [key, value] of Object.entries(createInitialSberState())) {
  if (defaultState[key] === undefined) defaultState[key] = value;
}

function countSberDocuments(snapshot) {
  return ['orders', 'callbacks'].reduce((n, key) => n + Object.keys(snapshot[key] || {}).length, 0);
}

function sberRetention(snapshot, now) {
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
  initialStateFactory: createInitialSberState,
  mode: TENANCY,
  stateFile: MOCK_STATE_FILE,
  sandboxFile: String(process.env.MOCK_SANDBOX_FILE || ''),
  ttlMs: SANDBOX_TTL_MS,
  maxSandboxes: SANDBOX_MAX,
  maxDocuments: SANDBOX_MAX_DOCUMENTS,
  maxStateBytes: parseMsOr(MOCK_SANDBOX_MAX_STATE_BYTES, null),
  globalMaxStateBytes: parseMsOr(MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES, null),
  documentCounter: countSberDocuments,
  retention: sberRetention,
  defaultOwnerToken: SANDBOX_OWNER_TOKEN,
  hostSuffix: SANDBOX_HOST_SUFFIX,
  operatorTokens: [MOCK_ADMIN_TOKEN, OPERATOR_TOKEN],
  createLimit: SANDBOX_CREATE_LIMIT,
  onSandboxRemoved: (record) => dropSandboxChildState(record),
  log: (message) => console.error(`[sber-mock] ${message}`),
});

const state = sandboxRuntime.state;
const persist = sandboxRuntime.persist;
const journal = core.createJournal({ size: 200, sandboxScope: () => sandboxRuntime.current() });
const sberUserName = () => sandboxRuntime.creds().userName || USER_NAME_CRED;
const sberPassword = () => sandboxRuntime.creds().password || PASSWORD_CRED;
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

/* --------------------------------------------------------- test-card profiles */

/* PAN/CVV/expiry are the synthetic test values in docs/reference/sber/02-callbacks-and-test.md.
 * Full PAN is used only for matching on the form; state, logs, and journal retain a mask. */
const CARDS = {
  '2202205000012424': { label: 'МИР · 3DS 2.0 frictionless', exp: '0535', cvv: '669', flow: 'frictionless', outcome: 'success' },
  '2202205300068092': { label: 'МИР · 3DS 2.0 challenge · лимит 100 ₽', exp: '1231', cvv: '583', flow: 'challenge', acs: '111111', outcome: 'success', maxAmountK: 10000 },
  '4006800900962514': { label: 'Visa · 3DS 1.0', exp: '0530', cvv: '706', flow: 'challenge', acs: '111111', outcome: 'success' },
  '5469980100048525': { label: 'Mastercard · 3DS 1.0', exp: '1231', cvv: '041', flow: 'challenge', acs: '111111', outcome: 'success' },
  '2202206100040083': { label: 'МИР · без 3DS', exp: '1231', cvv: '061', flow: 'frictionless', outcome: 'success' },
  '2202206000270541': { label: 'МИР · корпоративная · 3DS', exp: '0528', cvv: '123', flow: 'challenge', acs: '111111', outcome: 'success' },
  '2202205000060910': { label: 'МИР · повторяемая ошибка 116', exp: '0628', cvv: '810', flow: 'challenge', acs: '111111', outcome: 'decline', actionCode: 116, actionText: 'Недостаточно средств на карте' },
  '2202202107593166': { label: 'МИР · повторяемая ошибка 101 (просрочена)', exp: '0622', cvv: '123', flow: 'challenge', acs: '111111', outcome: 'decline', actionCode: 101, actionText: 'Карта просрочена' },
};
const ACS_PASSWORD = '111111';

/* ----------------------------------------------------- status/error catalog */

const ORDER_STATUSES = {
  0: 'Заказ зарегистрирован, не оплачен',
  1: 'Сумма захолдирована (двухстадийная схема)',
  2: 'Авторизация/оплата проведена',
  3: 'Авторизация отменена',
  4: 'По заказу проведён возврат',
  5: 'Начата аутентификация через ACS',
  6: 'Авторизация отклонена',
};

// Ecom-публичный срез фиксирует поля errorCode/errorMessage и errorCode=0, но
// не содержит полной таблицы кодов. Числовая карта 0…6 ниже — явная
// [FORK]/[VERIFY] интерпретация общего RBS-контракта; детали — в README.
const describeSberError = core.createErrorCatalog({
  provider: 'sber-ecom',
  docsBase: 'https://ecomtest.sberbank.ru/doc',
  codes: {
    1: { message: 'Номер заказа уже зарегистрирован', field: 'orderNumber', hint: 'orderNumber должен быть уникален в пределах магазина; повтор не является идемпотентным replay.' },
    2: { message: 'Merchant-логин не найден или неверный пароль', field: 'userName, password', hint: `Проверьте креды стенда: синтетические дефолты ${DEFAULT_USER_NAME}/${DEFAULT_PASSWORD}; переопределяются MOCK_SBER_USERNAME/MOCK_SBER_PASSWORD. Реальные тестовые креды выдаются банком индивидуально.` },
    3: { message: 'Заказ не найден или идентификатор некорректен', field: 'orderId, orderNumber', hint: 'Передайте orderId из регистрации либо orderNumber зарегистрированного заказа в той же песочнице.' },
    4: { message: 'Состояние заказа некорректно для операции', field: 'orderId', hint: 'Сверьте orderStatus через getOrderStatusExtended.do; не трактуйте actionCode как состояние заказа.' },
    5: { message: 'Операция отклонена', field: 'amount', hint: 'Проверьте обязательные поля, currency=643 и ограничения суммы операции.' },
    6: { message: 'Системная ошибка', hint: 'Повторите запрос после паузы и сверьте заказ через getOrderStatusExtended.do.' },
  },
});

function sberError(code, message, overrides = {}) {
  const detail = describeSberError(code, {
    ...(message ? { message } : {}),
    ...overrides,
  });
  const result = { errorCode: code, errorMessage: detail.message };
  if (detail.field) result.field = overrides.field || detail.field;
  if (detail.hint) result.hint = detail.hint;
  if (detail.doc) result.doc = detail.doc;
  return result;
}

function okBody(extra = {}) {
  return { errorCode: 0, errorMessage: '', ...extra };
}

function jsonRaw(res, statusCode, body) {
  return send(res, statusCode, typeof body === 'string' ? body : JSON.stringify(body), {
    'Content-Type': 'application/json; charset=utf-8',
  });
}

function errorOutcome(code, message, overrides = {}, status = 200) {
  return { status, body: sberError(code, message, overrides) };
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

function verifyCredentials(body) {
  const userName = body.userName === undefined || body.userName === null ? '' : String(body.userName).trim();
  const password = body.password === undefined || body.password === null ? '' : String(body.password);
  if (!constantTimeEqual(userName, sberUserName())) {
    log(`отказ авторизации: userName=${core.maskPiiValue('login', userName)} не найден`);
    return sberError(2, 'Merchant-логин не найден', {
      field: 'userName',
      hint: `userName не совпадает с кредами стенда. Синтетический дефолт ${DEFAULT_USER_NAME} действует, если не задан MOCK_SBER_USERNAME; реальные банковские тестовые креды в дефолты не включаются.`,
    });
  }
  if (!constantTimeEqual(password, sberPassword())) {
    log(`отказ авторизации: неверный password для userName=${core.maskPiiValue('login', userName)}`);
    return sberError(2, 'Неверный пароль', {
      field: 'password',
      hint: `password не совпадает с паролем стенда. Дефолт мока ${DEFAULT_PASSWORD} — синтетический; своё значение задайте в MOCK_SBER_PASSWORD.`,
    });
  }
  return null;
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

function validOrderNumber(raw) {
  const value = String(raw === undefined || raw === null ? '' : raw).trim();
  return value && value.length <= ORDER_NUMBER_MAX ? value : null;
}

function callbackUrlFor(order) {
  return String((order && order.callbackUrl) || DEFAULT_CALLBACK_URL || '').trim();
}

function safeAdditionalParams(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isPlainObject(value)) return { ok: false };
  let safe;
  try {
    safe = core.redactSecrets(value);
    if (Buffer.byteLength(JSON.stringify(safe)) > 4096) return { ok: false };
  } catch {
    return { ok: false };
  }
  return { ok: true, value: safe };
}

/* ------------------------------------------------------- callback delivery */

/* Ecom callback is POST JSON without signature/checksum; legacy Secure Payments
 * signature code is intentionally not imported or emulated here. */
const deliveryLog = (message) => log(core.redactSecretsInText(message));
const deliveryQueue = core.createDeliveryQueue({
  entries: () => state.callbacks,
  retryMs: CALLBACK_RETRY_MS,
  maxAttempts: CALLBACK_MAX_ATTEMPTS,
  persist,
  log: deliveryLog,
  now: () => clock.now(),
  request: (entry) => ({ url: entry.url, data: entry.payload, method: 'POST' }),
  isOk: (response) => response.statusCode === 200,
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

function scheduleCallback(order, operation, status, spec = null) {
  const target = callbackUrlFor(order);
  if (!target) return null;
  const suppressed = Boolean(spec && (spec.has('webhook-drop') || spec.has('no-webhook') || spec.has('no-callback')));
  const duplicate = Boolean(spec && (spec.has('webhook-duplicate') || spec.has('callback-duplicate')));
  const payload = {
    mdOrder: order.orderId,
    orderNumber: order.orderNumber,
    operation,
    status,
    ...(order.additionalParams ? { additionalParams: order.additionalParams } : {}),
  };
  const copies = duplicate && !suppressed ? 2 : 1;
  const ids = [];
  for (let index = 0; index < copies; index += 1) {
    const id = String(state.counters.callbackId++);
    state.callbacks[id] = {
      id,
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      operation,
      callbackStatus: status,
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
    log(`callback ${id} ${suppressed ? 'подавлен сценарием' : 'поставлен в очередь'}: ${operation} / ${order.orderId}`);
  }
  persist();
  return ids;
}

/* ---------------------------------------------------------- orders/status */

function findOrder(id) {
  return state.orders[String(id || '')] || null;
}

function resolveOrder(body) {
  const orderId = String(body.orderId === undefined || body.orderId === null ? '' : body.orderId).trim();
  const orderNumber = String(body.orderNumber === undefined || body.orderNumber === null ? '' : body.orderNumber).trim();
  if (!orderId && !orderNumber) {
    return { order: null, error: sberError(3, 'Не передан идентификатор заказа', { field: 'orderId, orderNumber', hint: 'Передайте orderId или orderNumber; достаточно одного.' }) };
  }
  const id = orderId || state.orderNumbers[orderNumber];
  const order = id ? findOrder(id) : null;
  if (!order) {
    return { order: null, error: sberError(3, 'Заказ не найден', { field: orderId ? 'orderId' : 'orderNumber', hint: 'Проверьте идентификатор и контекст песочницы; список заказов не разделяется между песочницами.' }) };
  }
  return { order, error: null };
}

function statusView(order) {
  // orderStatus — состояние заказа по контракту Ecom; actionCode — отдельная
  // причина/код ответа. Не выводить успех только из errorCode=0 или actionCode.
  return {
    errorCode: 0,
    errorMessage: '',
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    orderStatus: order.status,
    actionCode: order.actionCode,
    actionCodeDescription: order.actionCodeDescription || ORDER_STATUSES[order.status] || '',
    amount: order.amountK,
    currency: 643,
    date: order.createdAtMs,
    authorizedAmount: order.authorizedK || 0,
    depositedAmount: order.depositedK || 0,
    refundedAmount: order.refundedK || 0,
    paymentAttempts: order.attempts,
    maxPaymentAttempts: MAX_PAYMENT_ATTEMPTS,
    ...(order.cardMask ? { cardholderPan: order.cardMask } : {}),
    ...(order.authDate ? { authDate: order.authDate } : {}),
    ...(order.depositDate ? { depositDate: order.depositDate } : {}),
    ...(order.reverseDate ? { reverseDate: order.reverseDate } : {}),
    ...(order.refundDate ? { refundDate: order.refundDate } : {}),
    ...(order.declinedAt ? { declinedDate: order.declinedAt } : {}),
  };
}

function expireOrder(order) {
  if (!order || (order.status !== 0 && order.status !== 5) || !order.expiresAtMs || clock.now() < order.expiresAtMs) return false;
  order.status = 6;
  order.actionCode = null;
  order.actionCodeDescription = `Истёк срок жизни заказа (${order.sessionTimeoutSecs} с)`;
  order.pending3ds = null;
  order.declinedAt = clock.now();
  persist();
  scheduleCallback(order, 'declinedByTimeout', 0);
  log(`заказ ${order.orderId}: истёк TTL, orderStatus=6 / declinedByTimeout`);
  return true;
}

function tickSber() {
  const now = clock.now();
  for (const order of Object.values(state.orders)) {
    if ((order.status === 0 || order.status === 5) && order.expiresAtMs && now >= order.expiresAtMs) expireOrder(order);
  }
}

setInterval(() => {
  sandboxRuntime.tickAll(() => {
    tickSber();
    deliveryQueue.tick().catch((error) => log(`callback loop: ${error.message}`));
  });
}, 1000).unref();

if (SANDBOX_TTL_MS > 0 || SANDBOX_MAX_DOCUMENTS > 0 || SANDBOX_RETENTION_MS > 0) {
  setInterval(() => {
    const result = sandboxRuntime.sweep();
    if (result.expired) log(`sandbox sweep: удалено по TTL — ${result.expired}`);
  }, Math.max(1000, parseMsOr(process.env.MOCK_SANDBOX_SWEEP_MS, 60000))).unref();
}

function validateRegistration(body, twoStage) {
  if (twoStage && !TWO_STAGE) {
    return errorOutcome(5, 'Двухстадийная оплата не подключена для этого стенда', {
      field: 'registerPreAuth.do',
      hint: 'Доступность registerPreAuth.do зависит от merchant-разрешения; на стенде управляйте ею через MOCK_SBER_TWO_STAGE.',
    });
  }
  const quota = sandboxRuntime.checkDocuments();
  if (!quota.ok) {
    return errorOutcome(5, 'Лимит документов песочницы исчерпан', {
      field: 'orderNumber',
      hint: `${quota.kind === 'bytes' ? 'Исчерпана байтовая квота' : 'Исчерпана квота документов'} (${quota.used}/${quota.limit}); сбросьте эту песочницу или создайте новую.`,
    });
  }

  const orderNumber = validOrderNumber(body.orderNumber);
  if (!orderNumber) {
    return errorOutcome(3, 'orderNumber отсутствует или не укладывается в лимит стенда', {
      field: 'orderNumber',
      hint: `Передайте непустой уникальный orderNumber длиной не более ${ORDER_NUMBER_MAX} символов (ограничение длины — mock safety cap).`,
    });
  }
  const previousId = state.orderNumbers[orderNumber];
  if (previousId && state.orders[previousId]) {
    return errorOutcome(1, 'Номер заказа уже зарегистрирован', {
      field: 'orderNumber',
      hint: `orderNumber «${orderNumber.slice(0, 64)}» уже существует (orderStatus=${state.orders[previousId].status}). Возьмите новый номер; повтор не является replay.`,
    });
  }
  const amount = core.parseMoneyKopeks(body.amount, { field: 'amount' });
  if (!amount.ok) {
    return errorOutcome(5, amount.message, { field: 'amount', hint: 'amount — целое положительное число копеек; например 100.00 ₽ передаётся как 10000.' });
  }
  if (String(body.currency === undefined || body.currency === null ? '' : body.currency) !== '643') {
    return errorOutcome(5, 'Валюта не поддерживается', { field: 'currency', hint: 'Передайте currency=643 (RUB) числом или строкой.' });
  }
  if (!validHttpUrl(body.returnUrl)) {
    return errorOutcome(5, 'returnUrl отсутствует или некорректен', { field: 'returnUrl', hint: `Обязателен абсолютный http(s)-URL длиной не более ${RETURN_URL_MAX}; результат оплаты всё равно сверяется серверно.` });
  }
  const failUrl = body.failUrl === undefined || body.failUrl === null || body.failUrl === '' ? null : String(body.failUrl).trim();
  if (failUrl && !validHttpUrl(failUrl)) {
    return errorOutcome(5, 'failUrl некорректен', { field: 'failUrl', hint: 'Опциональный failUrl должен быть абсолютным http(s)-URL.' });
  }
  let timeoutSecs = SESSION_TIMEOUT_SECS;
  if (body.sessionTimeoutSecs !== undefined && body.sessionTimeoutSecs !== null && body.sessionTimeoutSecs !== '') {
    const text = String(body.sessionTimeoutSecs).trim();
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 1) {
      return errorOutcome(5, 'sessionTimeoutSecs некорректен', { field: 'sessionTimeoutSecs', hint: `Ожидается целое число секунд > 0; дефолт стенда — ${SESSION_TIMEOUT_SECS} (20 минут).` });
    }
    timeoutSecs = value;
  }
  let callbackUrl = '';
  if (body.dynamicCallbackUrl !== undefined && body.dynamicCallbackUrl !== null && body.dynamicCallbackUrl !== '') {
    if (!validHttpUrl(body.dynamicCallbackUrl)) {
      return errorOutcome(5, 'dynamicCallbackUrl некорректен', { field: 'dynamicCallbackUrl', hint: 'dynamicCallbackUrl должен быть абсолютным http(s)-URL без userinfo; в hosted-режиме исходящая цель проверяется SSRF-политикой.' });
    }
    callbackUrl = String(body.dynamicCallbackUrl).trim();
  }
  const additional = safeAdditionalParams(body.additionalParams);
  if (!additional.ok) {
    return errorOutcome(5, 'additionalParams должен быть JSON-объектом размером до 4 KiB', { field: 'additionalParams', hint: 'Передайте объект JSON или опустите optional-поле. Потенциальные секреты в сохранённом объекте редактируются.' });
  }
  return {
    status: 200,
    body: null,
    orderNumber,
    amountK: amount.value,
    twoStage,
    failUrl,
    timeoutSecs,
    callbackUrl,
    additionalParams: additional.value,
    description: body.description === undefined || body.description === null ? '' : String(body.description).slice(0, 512),
  };
}

function handleRegister(body, twoStage, spec) {
  const validated = validateRegistration(body, twoStage);
  if (validated.body) return validated;
  const orderId = crypto.randomUUID();
  const now = clock.now();
  const sandboxId = sandboxRuntime.currentId();
  const suffix = sandboxId === 'default' ? '' : `?sandbox=${encodeURIComponent(sandboxId)}`;
  const base = String(PUBLIC_BASE_URL).replace(/\/$/, '');
  const order = {
    orderId,
    orderNumber: validated.orderNumber,
    twoStage: validated.twoStage,
    status: 0,
    amountK: validated.amountK,
    currency: 643,
    authorizedK: 0,
    depositedK: 0,
    refundedK: 0,
    actionCode: null,
    actionCodeDescription: 'Заказ зарегистрирован; итог платежа ещё неизвестен',
    attempts: 0,
    createdAt: clock.iso(),
    createdAtMs: now,
    sessionTimeoutSecs: validated.timeoutSecs,
    expiresAtMs: now + validated.timeoutSecs * 1000,
    returnUrl: String(body.returnUrl).trim(),
    failUrl: validated.failUrl,
    description: validated.description,
    callbackUrl: validated.callbackUrl,
    additionalParams: validated.additionalParams,
    cardMask: null,
    authDate: null,
    depositDate: null,
    reverseDate: null,
    refundDate: null,
    declinedAt: null,
    pending3ds: null,
  };
  state.orders[orderId] = order;
  state.orderNumbers[order.orderNumber] = orderId;
  persist();
  scheduleCallback(order, 'created', 1, spec);
  log(`заказ зарегистрирован: ${orderId} orderNumber=${order.orderNumber} amount=${order.amountK} коп., схема=${twoStage ? 'preAuth' : 'обычная'}, TTL=${order.sessionTimeoutSecs}s`);
  return {
    status: 200,
    body: okBody({
      orderId,
      formUrl: `${base}/payment/${orderId}${suffix}`,
      hint: 'errorCode=0 означает, что запрос регистрации обработан; это НЕ подтверждение оплаты. После возврата проверьте orderStatus через getOrderStatusExtended.do.',
    }),
  };
}

function declinePaymentAttempt(order, actionCode, description) {
  order.pending3ds = null;
  order.actionCode = actionCode === undefined ? null : actionCode;
  order.actionCodeDescription = description;
  if (order.attempts >= MAX_PAYMENT_ATTEMPTS) {
    order.status = 6;
    order.declinedAt = clock.now();
  } else {
    // Ошибки 116/101 повторяемы: заказ остаётся orderStatus=0, пока не
    // исчерпаны три попытки. На третьем отказе состояние становится 6.
    order.status = 0;
  }
  persist();
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

function handleDeposit(body, spec) {
  const found = resolveOrder(body);
  if (found.error) return { status: 200, body: found.error };
  const order = found.order;
  expireOrder(order);
  if (!order.twoStage || order.status !== 1) {
    return errorOutcome(4, `Состояние заказа ${order.status} некорректно для deposit.do`, { field: 'orderId', hint: 'deposit.do доступен только для заказа registerPreAuth.do с orderStatus=1; иначе используйте register.do или сверьте статус.' });
  }
  const amount = core.parseMoneyKopeks(body.amount, { field: 'amount' });
  if (!amount.ok) return errorOutcome(5, amount.message, { field: 'amount', hint: 'amount для deposit — целое число положительных копеек не больше суммы холда.' });
  if (amount.value > order.authorizedK) {
    return errorOutcome(5, `deposit ${amount.value} коп. превышает авторизацию ${order.authorizedK} коп.`, { field: 'amount', hint: 'Сумма deposit не может превышать авторизованную сумму; мок допускает частичное подтверждение.' });
  }
  order.status = 2;
  order.depositedK = amount.value;
  order.depositDate = clock.now();
  order.actionCode = 0;
  order.actionCodeDescription = 'Списание проведено';
  persist();
  scheduleCallback(order, 'deposited', 1, spec);
  return { status: 200, body: okBody() };
}

function handleReverse(body, spec) {
  const found = resolveOrder(body);
  if (found.error) return { status: 200, body: found.error };
  const order = found.order;
  expireOrder(order);
  if (order.status !== 1 && order.status !== 2) {
    return errorOutcome(4, `Состояние заказа ${order.status} некорректно для reverse.do`, { field: 'orderId', hint: 'reverse.do отменяет холд orderStatus=1 либо заказ orderStatus=2 до взаиморасчётов; после списания используйте refund.do.' });
  }
  order.status = 3;
  order.reverseDate = clock.now();
  order.actionCode = 0;
  order.actionCodeDescription = 'Авторизация отменена';
  persist();
  scheduleCallback(order, 'reversed', 1, spec);
  return { status: 200, body: okBody() };
}

function handleRefund(body, spec) {
  const found = resolveOrder(body);
  if (found.error) return { status: 200, body: found.error };
  const order = found.order;
  if (order.status !== 2 && order.status !== 4) {
    return errorOutcome(4, `Состояние заказа ${order.status} некорректно для refund.do`, { field: 'orderId', hint: 'refund.do возвращает уже списанные средства: orderStatus=2 или предыдущие частичные возвраты orderStatus=4.' });
  }
  const amount = core.parseMoneyKopeks(body.amount, { field: 'amount' });
  if (!amount.ok) return errorOutcome(5, amount.message, { field: 'amount', hint: 'amount для refund — положительное целое число копеек.' });
  const remaining = order.depositedK - order.refundedK;
  if (amount.value > remaining) {
    return errorOutcome(5, `refund ${amount.value} коп. превышает доступный остаток ${remaining} коп.`, { field: 'amount', hint: 'Полный и частичный refund ограничен остатком depositedAmount минус refundedAmount.' });
  }
  order.refundedK += amount.value;
  order.status = 4;
  order.refundDate = clock.now();
  order.actionCode = 0;
  order.actionCodeDescription = 'Возврат проведён';
  persist();
  scheduleCallback(order, 'refunded', 1, spec);
  return { status: 200, body: okBody() };
}

function handleDecline(body) {
  const found = resolveOrder(body);
  if (found.error) return { status: 200, body: found.error };
  const order = found.order;
  expireOrder(order);
  if (order.status !== 0 || order.attempts !== 0) {
    return errorOutcome(4, `Состояние заказа ${order.status} некорректно для decline.do`, { field: 'orderId', hint: 'decline.do отменяет заказ только до начала ввода карточных данных (платёжных попыток ещё не было).' });
  }
  order.status = 6;
  order.actionCode = 0;
  order.actionCodeDescription = 'Заказ отменён decline.do до ввода карточных данных';
  order.declinedAt = clock.now();
  persist();
  // Ecom callback operation списка не содержит generic decline; мок не выдумывает
  // callback-событие. Регистрационное created уведомление уже могло быть отправлено.
  return { status: 200, body: okBody() };
}

const REST_BASE = '/ecomm/gw/partner/api/v1/';
const REST_METHODS = [
  'register.do',
  'registerPreAuth.do',
  'deposit.do',
  'reverse.do',
  'refund.do',
  'decline.do',
  'getOrderStatusExtended.do',
];

async function handleRest(req, res, p, raw, body) {
  const methodMatch = p.match(/^\/ecomm\/gw\/partner\/api\/v1\/([A-Za-z]+\.do)$/);
  const methodName = methodMatch ? methodMatch[1] : null;
  if (!methodName || !REST_METHODS.includes(methodName)) {
    return jsonRaw(res, 404, sberError(6, `Неизвестный Ecom REST-метод: ${p}`, {
      hint: `Поддерживаются POST ${REST_BASE}{${REST_METHODS.join(',')}}. paymentOrder.do намеренно не включён без merchant-разрешения.`,
    }));
  }
  if (req.method !== 'POST') {
    return jsonRaw(res, 405, sberError(6, `Метод ${req.method} не поддерживается: шлюз использует POST`, { field: 'method', hint: 'Ecom REST-вызовы отправляются POST с Content-Type: application/json.' }));
  }
  if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
    return jsonRaw(res, 415, sberError(6, 'Ecom REST принимает только application/json', { field: 'Content-Type', hint: 'Отправьте UTF-8 JSON с Content-Type: application/json.' }));
  }
  if (raw.trim()) {
    try { JSON.parse(raw); } catch {
      return jsonRaw(res, 400, sberError(6, 'Тело запроса не является валидным JSON', { field: 'body', hint: 'Проверьте синтаксис JSON и повторите запрос.' }));
    }
  }
  if (!isPlainObject(body)) {
    return jsonRaw(res, 400, sberError(6, 'JSON-тело должно быть объектом', { field: 'body' }));
  }
  const authError = verifyCredentials(body);
  if (authError) return jsonRaw(res, 200, authError);

  const target = methodName.replace(/\.do$/, '').toLowerCase();
  const spec = resolveRequestSpec(target, req, body, {
    orderNumber: String(body.orderNumber || ''),
    path: p,
  });
  if (spec.has('hang')) await new Promise(() => {});
  if (spec.has('fail')) {
    return jsonRaw(res, 200, sberError(6, 'Системная ошибка (смоделирована сценарием fail)', {
      hint: 'Сценарий fail не выполняет бизнес-операцию; повторите после паузы и сверьте статус через getOrderStatusExtended.do.',
    }));
  }

  let outcome;
  switch (methodName) {
    case 'register.do':
      outcome = handleRegister(body, false, spec);
      break;
    case 'registerPreAuth.do':
      outcome = handleRegister(body, true, spec);
      break;
    case 'deposit.do':
      outcome = handleDeposit(body, spec);
      break;
    case 'reverse.do':
      outcome = handleReverse(body, spec);
      break;
    case 'refund.do':
      outcome = handleRefund(body, spec);
      break;
    case 'decline.do':
      outcome = handleDecline(body);
      break;
    case 'getOrderStatusExtended.do': {
      const found = resolveOrder(body);
      if (found.error) {
        outcome = { status: 200, body: found.error };
        break;
      }
      expireOrder(found.order);
      outcome = { status: 200, body: statusView(found.order) };
      break;
    }
    default:
      outcome = errorOutcome(6, 'Метод не реализован');
  }
  return jsonRaw(res, outcome.status, outcome.body);
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
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Сбербанк Ecom · тестовая платёжная форма</title>
<style>
  body{font:16px/1.5 -apple-system,'Segoe UI',Roboto,sans-serif;background:#f3f5f8;margin:0;display:flex;justify-content:center;padding:24px 12px}
  .card{background:#fff;border-radius:16px;max-width:560px;width:100%;padding:24px;box-shadow:0 8px 30px rgba(16,38,63,.09)}
  .logo{font-weight:800;color:#fff;background:#21a038;display:inline-block;border-radius:8px;padding:2px 10px;margin-bottom:8px}
  h1{font-size:20px;margin:0 0 4px}.muted{color:#66717e;font-size:13px;margin-bottom:14px}.sum{font-size:28px;font-weight:700;margin:8px 0 16px}
  label{display:block;font-size:13px;color:#39424e;margin:10px 0 4px}input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d5dce4;border-radius:10px;font-size:16px}
  .cards{display:flex;flex-direction:column;gap:6px;margin:12px 0;border:1px dashed #dce3ea;border-radius:10px;padding:10px;max-height:220px;overflow:auto}.cards label{display:flex;gap:8px;align-items:flex-start;font-size:12px;margin:0;cursor:pointer}
  button{width:100%;margin-top:14px;padding:13px;border:0;border-radius:10px;background:#21a038;color:#fff;font-weight:700;font-size:16px;cursor:pointer}.button-muted{background:#edf1f5;color:#29313a}.err{color:#b42318;background:#fff2f0;padding:9px;border-radius:8px;margin:12px 0}
  code{overflow-wrap:anywhere}
</style></head><body><main class="card">${content}</main></body></html>`;
}

const esc = (value) => escapeHtml(value);
const rub = (kopecks) => `${(kopecks / 100).toFixed(2).replace('.', ',')} ₽`;

function sandboxSuffix() {
  const id = sandboxRuntime.currentId();
  return id === 'default' ? '' : `?sandbox=${encodeURIComponent(id)}`;
}

function formPage(order, errorMessage = '') {
  const options = Object.entries(CARDS).map(([pan, card]) => (
    `<label><input type="radio" name="preset" value="${pan}" onchange="document.getElementById('pan').value='${pan}';document.getElementById('exp').value='${card.exp}';document.getElementById('cvv').value='${card.cvv}'"> <span>${esc(card.label)}<br><code>${pan.slice(0, 6)}**${pan.slice(-4)} · ${card.exp.slice(0, 2)}/${card.exp.slice(-2)} · CVV ${card.cvv}</code></span></label>`
  )).join('');
  return page(`
    <span class="logo">Сбер Ecom · тестовый стенд</span>
    <h1>Оплата заказа</h1>
    <div class="muted">orderNumber <code>${esc(order.orderNumber)}</code> · orderId <code>${esc(order.orderId)}</code></div>
    <div class="sum">${esc(rub(order.amountK))}</div>
    ${order.description ? `<div class="muted">${esc(order.description)}</div>` : ''}
    <div class="muted">${order.twoStage ? 'После успешной авторизации сумма будет захолдирована; завершите её через deposit.do.' : 'После успешной авторизации сумма будет списана.'} Осталось ${Math.max(0, Math.ceil((order.expiresAtMs - clock.now()) / 1000))} с. Попыток оплаты: ${order.attempts}/${MAX_PAYMENT_ATTEMPTS}.</div>
    ${errorMessage ? `<div class="err">${esc(errorMessage)}</div>` : ''}
    <form method="POST" action="/payment/${encodeURIComponent(order.orderId)}/pay${sandboxSuffix()}">
      <div class="cards">${options}</div>
      <label>Номер тестовой карты</label><input type="text" id="pan" name="pan" value="2202205000012424" autocomplete="off" required>
      <label>Срок (MMYY)</label><input type="text" id="exp" name="exp" value="0535" autocomplete="off" required>
      <label>CVV</label><input type="password" id="cvv" name="cvv" value="669" autocomplete="off" required>
      <button type="submit">Продолжить оплату</button>
    </form>
    <div class="muted">Только официальные тестовые карты из таблицы ниже. PAN не журналируется и не сохраняется; в статусе остаётся только маска.</div>`);
}

function acsPage(order, errorMessage = '') {
  const pending = order.pending3ds || {};
  return page(`
    <span class="logo">Сбербанк · тестовый ACS</span>
    <h1>Подтверждение 3-D Secure</h1>
    <div class="muted">Заказ <code>${esc(order.orderNumber)}</code> · карта <code>${esc(pending.maskPan || '')}</code> · ${esc(pending.flow || '3DS challenge')}</div>
    <div class="muted">Пароль тестового ACS: <b>${ACS_PASSWORD}</b></div>
    ${errorMessage ? `<div class="err">${esc(errorMessage)}</div>` : ''}
    <form method="POST" action="/payment/${encodeURIComponent(order.orderId)}/3ds${sandboxSuffix()}">
      <label>Пароль ACS</label><input type="password" name="password" value="" autocomplete="off" required>
      <button type="submit">Подтвердить</button>
    </form>
    <form method="POST" action="/payment/${encodeURIComponent(order.orderId)}/3ds${sandboxSuffix()}">
      <input type="hidden" name="action" value="fail"><button class="button-muted" type="submit">Отказ ACS</button>
    </form>`);
}

function statusPage(order, message = '') {
  const title = order.status === 1 ? 'Авторизация удержана' : order.status === 2 ? 'Оплата проведена'
    : order.status === 3 ? 'Авторизация отменена' : order.status === 4 ? 'Возврат проведён'
      : order.status === 6 ? 'Оплата отклонена' : 'Заказ ожидает оплаты';
  return page(`
    <span class="logo">Сбер Ecom · тестовый стенд</span>
    <h1>${esc(title)}</h1>
    <div class="muted">Заказ <code>${esc(order.orderNumber)}</code> · orderId <code>${esc(order.orderId)}</code></div>
    <div class="sum">${esc(rub(order.amountK))}</div>
    <div class="muted">orderStatus=<b>${order.status}</b> (${esc(ORDER_STATUSES[order.status] || '')}) · actionCode=<b>${esc(order.actionCode === null ? 'n/a' : String(order.actionCode))}</b> (${esc(order.actionCodeDescription || '')})</div>
    ${message ? `<div class="err">${esc(message)}</div>` : ''}
    <div class="muted">Результат подтвердите серверным POST getOrderStatusExtended.do. errorCode=0 в REST-ответе не равен успеху оплаты.</div>`);
}

function maskPan(pan) {
  return `${pan.slice(0, 6)}**${pan.slice(-4)}`;
}

function completeCardAttempt(order, card, spec) {
  if (card.outcome === 'decline') {
    declinePaymentAttempt(order, card.actionCode, card.actionText);
    return order.status === 6
      ? { stage: 'done', html: statusPage(order, `${card.actionText}. Исчерпаны три попытки оплаты.`), redirect: order.failUrl || null }
      : { stage: 'retry', html: formPage(order, `${card.actionText}. Можно повторить оплату: ${order.attempts}/${MAX_PAYMENT_ATTEMPTS}.`) };
  }
  if (card.maxAmountK && order.amountK > card.maxAmountK) {
    declinePaymentAttempt(order, 116, 'Превышен тестовый лимит карты 100 ₽');
    return order.status === 6
      ? { stage: 'done', html: statusPage(order, 'Превышен тестовый лимит карты 100 ₽; исчерпаны три попытки.'), redirect: order.failUrl || null }
      : { stage: 'retry', html: formPage(order, 'Тестовая карта ограничена суммой 100 ₽; попробуйте подходящий тестовый сценарий.') };
  }
  if (order.pending3ds && order.pending3ds.maskPan) order.cardMask = order.pending3ds.maskPan;
  order.pending3ds = null;
  order.authDate = clock.now();
  order.authorizedK = order.amountK;
  order.actionCode = 0;
  order.actionCodeDescription = 'Авторизация одобрена';
  if (order.twoStage) {
    order.status = 1;
    persist();
    scheduleCallback(order, 'approved', 1, spec);
  } else {
    order.status = 2;
    order.depositedK = order.amountK;
    order.depositDate = clock.now();
    persist();
    scheduleCallback(order, 'deposited', 1, spec);
  }
  persist();
  return { stage: 'done', redirect: order.returnUrl };
}

function beginCardPay(order, body, req, spec) {
  const pan = String(body.pan || '').replace(/[\s-]/g, '');
  const exp = String(body.exp || '').trim();
  const cvv = String(body.cvv || '').trim();
  if (!/^\d{13,19}$/.test(pan)) return { stage: 'form', html: formPage(order, 'Номер карты должен содержать 13–19 цифр.') };
  const card = CARDS[pan];
  if (!card) return { stage: 'form', html: formPage(order, 'Принимаются только карты из списка официального тестового контура.') };
  if (exp !== card.exp || cvv !== card.cvv) {
    return { stage: 'form', html: formPage(order, 'Срок/CVV не совпадают с официальной таблицей этой тестовой карты.') };
  }
  if (order.attempts >= MAX_PAYMENT_ATTEMPTS) {
    return { stage: 'done', html: statusPage(order, 'Лимит из трёх попыток оплаты исчерпан.') };
  }
  order.attempts += 1;
  order.cardMask = maskPan(pan);
  if (spec.has('fail')) {
    declinePaymentAttempt(order, 101, 'Отказ платежа смоделирован X-Mock-Scenario: fail');
    persist();
    return order.status === 6
      ? { stage: 'done', html: statusPage(order, 'Сценарий fail: исчерпаны три попытки.'), redirect: order.failUrl || null }
      : { stage: 'retry', html: formPage(order, `Сценарий fail. Осталось попыток: ${MAX_PAYMENT_ATTEMPTS - order.attempts}.`) };
  }
  if (card.flow === 'challenge') {
    order.status = 5;
    order.actionCode = null;
    order.actionCodeDescription = 'Ожидается подтверждение тестового ACS';
    order.pending3ds = {
      maskPan: order.cardMask,
      flow: card.flow,
      acs: card.acs,
      outcome: card.outcome,
      actionCode: card.actionCode,
      actionText: card.actionText,
      maxAmountK: card.maxAmountK,
    };
    persist();
    return { stage: 'acs', html: acsPage(order) };
  }
  // frictionless/карта без 3DS завершает авторизацию на первом POST формы.
  order.pending3ds = { maskPan: order.cardMask };
  return completeCardAttempt(order, card, spec);
}

function finish3ds(order, body, spec) {
  const pending = order.pending3ds;
  if (!pending) return { stage: 'form', html: acsPage(order, 'Сессия ACS не найдена.') };
  if (String(body.action || '') === 'fail' || String(body.password || '').trim() !== ACS_PASSWORD) {
    declinePaymentAttempt(order, pending.actionCode, pending.actionText || 'Тестовый ACS отклонил аутентификацию');
    return order.status === 6
      ? { stage: 'done', html: statusPage(order, 'Аутентификация ACS отклонена; исчерпаны три попытки.'), redirect: order.failUrl || null }
      : { stage: 'retry', html: formPage(order, `Аутентификация ACS не пройдена. Осталось попыток: ${MAX_PAYMENT_ATTEMPTS - order.attempts}.`) };
  }
  const card = {
    outcome: pending.outcome,
    actionCode: pending.actionCode,
    actionText: pending.actionText,
    maxAmountK: pending.maxAmountK,
  };
  return completeCardAttempt(order, card, spec);
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
    userName: `SBRSBX${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
    password: core.randomToken(24),
  };
}

function handleSandboxApi(req, res, url, body) {
  const operator = sandboxRuntime.isOperatorRequest(req);
  if (req.method === 'GET') {
    if (TENANCY === 'owned' && !operator) {
      const own = sandboxRuntime.recordByOwnerToken(req);
      if (!own) return jsonRaw(res, 401, sberError(2, 'Список песочниц доступен владельцу или оператору', { field: 'X-Sandbox-Token', hint: 'Owner-token выдаётся один раз при POST /sandboxes.' }));
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
          profile: 'sber-ecom',
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
          hint: 'Сохраните ownerToken: он показывается один раз. Ecom callback не подписан; сверяйте его с getOrderStatusExtended.do.',
        }, 201);
      } catch (error) {
        if (core.sendSandboxStateQuotaError(res, error)) return;
        return jsonRaw(res, error.code === 'SANDBOX_EXISTS' ? 409 : 429, sberError(5, error.message, { hint: 'Проверьте MOCK_SANDBOX_MAX и MOCK_SANDBOX_CREATE_LIMIT.' }));
      }
    }
    const result = sandboxRuntime.switchActive((body && body.sandbox) || 'default');
    if (!result.ok) return jsonRaw(res, 400, sberError(5, `Не удалось выбрать песочницу: ${result.error}`));
    return sendJson(res, { ok: true, current: result.current, sandboxes: sandboxRuntime.list() });
  }
  if (req.method === 'DELETE') {
    const target = String((body && body.sandbox) || url.searchParams.get('sandbox') || '');
    if (!target) return jsonRaw(res, 400, sberError(3, 'Укажите sandbox для удаления'));
    const record = sandboxRuntime.find(target);
    if (!record) return jsonRaw(res, 404, sberError(3, `Песочница «${target}» не найдена`));
    if (TENANCY === 'owned' && !operator && !sandboxRuntime.recordAuthorized(record, req)) {
      return jsonRaw(res, 401, sberError(2, 'Удалить песочницу может её владелец или оператор'));
    }
    const result = sandboxRuntime.remove(target, req);
    if (!result.ok) return jsonRaw(res, result.error === 'unauthorized' ? 401 : 400, sberError(5, `Не удалось удалить песочницу: ${result.error}`));
    return sendJson(res, { ok: true, removed: result.removed });
  }
  return jsonRaw(res, 405, sberError(6, `Метод ${req.method} для /sandboxes не поддерживается`));
}

function handleSandboxMe(req, res, p) {
  const record = sandboxRuntime.recordByOwnerToken(req) || (TENANCY === 'owned' ? null : sandboxRuntime.current());
  if (!record) return jsonRaw(res, 401, sberError(2, 'Требуется owner-token песочницы', { field: 'X-Sandbox-Token', hint: 'Owner-token выдаётся при POST /sandboxes.' }));
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
    if (!result.ok) return jsonRaw(res, 400, sberError(5, 'default-песочницу удалить нельзя'));
    return sendJson(res, { ok: true, removed: result.removed });
  }
  return jsonRaw(res, 405, sberError(6, `Метод ${req.method} для ${p} не поддерживается`));
}

function sandboxPolicy(p) {
  if (p === '/health' || p === '/openapi.json' || p === '/sandboxes' || p.startsWith('/sandboxes/')) return 'public';
  if (p.startsWith('/admin') || p.startsWith('/mock/')) return 'control';
  if (p.startsWith(REST_BASE)) return 'business';
  if (p.startsWith('/payment/')) return 'form';
  return 'business';
}

function sendSandboxError(res, admission) {
  const id = admission.sandbox || 'default';
  if (admission.kind === 'not-found') return jsonRaw(res, 404, sberError(3, `Песочница «${id}» не найдена`, { hint: 'Создайте песочницу: POST /sandboxes.' }));
  if (admission.kind === 'unauthorized') return jsonRaw(res, 401, sberError(2, `Доступ к песочнице «${id}» ограничен: знание ID не является доступом`, { field: 'X-Sandbox-Token', hint: 'Передайте owner-token из POST /sandboxes: Authorization: Bearer <ownerToken>, X-Sandbox-Token или cookie (mock_sandbox_token=...). В hosted-режиме query-токены запрещены.' }));
  if (admission.kind === 'expired') return jsonRaw(res, 410, sberError(3, `Песочница «${id}» истекла по TTL`, { hint: 'Создайте новую песочницу через POST /sandboxes.' }));
  if (admission.kind === 'rate-limit' || admission.kind === 'limit') return jsonRaw(res, 429, sberError(5, 'Лимит создания песочниц исчерпан'));
  return jsonRaw(res, 500, sberError(6, 'Не удалось разрешить контекст песочницы'));
}

/* ---------------------------------------------------------- admin console */

function controlSurface(p) {
  if (p.startsWith('/admin')) return 'admin';
  if (p.startsWith('/mock/')) return 'operator';
  return null;
}

function adminButton(action, id, label, csrfToken, actionUrl) {
  return `<form method="POST" action="${esc(actionUrl)}" style="display:inline"><input type="hidden" name="_csrf" value="${esc(csrfToken)}"><input type="hidden" name="action" value="${esc(action)}"><input type="hidden" name="id" value="${esc(id)}"><button style="width:auto;padding:5px 8px;font-size:12px" type="submit">${esc(label)}</button></form>`;
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
    if (order.status === 1) actions.push(adminButton('deposit-order', order.orderId, 'deposit full', csrf, actionUrl), adminButton('reverse-order', order.orderId, 'reverse', csrf, actionUrl));
    if (order.status === 2) actions.push(adminButton('reverse-order', order.orderId, 'reverse', csrf, actionUrl));
    if (order.status === 0 || order.status === 5) actions.push(adminButton('expire-order', order.orderId, 'expire now', csrf, actionUrl));
    return `<tr><td><code>${esc(order.orderId.slice(0, 8))}</code></td><td>${esc(order.orderNumber)}</td><td>${order.status} · ${esc(ORDER_STATUSES[order.status])}</td><td>${esc(rub(order.amountK))}</td><td>${order.attempts}/${MAX_PAYMENT_ATTEMPTS}</td><td>${esc(order.cardMask || '—')}</td><td>${actions.join(' ') || '—'}</td></tr>`;
  }).join('') || '<tr><td colspan="7">заказов нет</td></tr>';
  const callbacks = Object.values(state.callbacks).sort((a, b) => Number(a.id) - Number(b.id)).slice(-20).reverse().map((entry) => {
    const status = entry.suppressed ? 'suppressed' : entry.dumped ? 'dumped' : entry.done ? 'delivered' : `retry@${entry.nextAttemptAt || 0}`;
    return `<tr><td>${esc(entry.id)}</td><td>${esc(entry.operation)}</td><td>${esc(entry.callbackStatus)}</td><td>${entry.attempts}</td><td>${esc(status)}</td><td>${esc(String(entry.lastStatus || '—'))}</td><td>${adminButton('duplicate-callback', entry.id, 'повторить', csrf, actionUrl)}</td></tr>`;
  }).join('') || '<tr><td colspan="7">callback не отправлялись</td></tr>';
  const journalRows = journal.list().slice(-15).reverse().map((entry) => (
    `<tr><td>${esc(String(entry.at).slice(11, 19))}</td><td>${esc(entry.method)}</td><td><code>${esc(entry.path)}</code></td><td>${entry.status}</td><td>${entry.ms} ms</td><td><code>${esc(String(entry.curl || '').slice(0, 100))}…</code></td></tr>`
  )).join('') || '<tr><td colspan="6">запросов ещё не было</td></tr>';
  return page(`
    <span class="logo">Сбер Ecom · mock</span>
    <h1>Консоль стенда</h1>
    <div class="muted">Синтетические креды: ${DEFAULT_USER_NAME} · two-stage=${TWO_STAGE} · callback: POST JSON без подписи · ретраи ${CALLBACK_RETRY_MS} ms × ${CALLBACK_MAX_ATTEMPTS} · виртуальное время ${esc(clock.iso())} · sandbox ${esc(sandboxId)}</div>
    <div class="err">Только тестовые карты. errorCode=0 ≠ успешная оплата; проверяйте getOrderStatusExtended.do. Полный PAN не сохраняется.</div>
    <h2>Заказы (последние 40)</h2><table style="width:100%;font-size:12px">${orders}</table>
    <h2>Callbacks (последние 20)</h2><table style="width:100%;font-size:12px">${callbacks}</table>
    <h2>Журнал Ecom REST — <a href="${esc(journalUrl)}">JSON</a></h2><table style="width:100%;font-size:12px">${journalRows}</table>`);
}

function adminAction(body) {
  const { action, id } = body || {};
  if (action === 'deposit-order') {
    const order = findOrder(id);
    if (order && order.status === 1) {
      order.status = 2; order.depositedK = order.authorizedK; order.depositDate = clock.now();
      order.actionCode = 0; order.actionCodeDescription = 'Списание проведено'; persist();
      scheduleCallback(order, 'deposited', 1);
    }
  } else if (action === 'reverse-order') {
    const order = findOrder(id);
    if (order && (order.status === 1 || order.status === 2)) {
      order.status = 3; order.reverseDate = clock.now(); order.actionCode = 0; order.actionCodeDescription = 'Авторизация отменена'; persist();
      scheduleCallback(order, 'reversed', 1);
    }
  } else if (action === 'expire-order') {
    const order = findOrder(id);
    if (order && (order.status === 0 || order.status === 5)) {
      order.expiresAtMs = clock.now(); expireOrder(order);
    }
  } else if (action === 'duplicate-callback') {
    const original = state.callbacks[String(id)];
    if (original) {
      const copy = { ...original, id: String(state.counters.callbackId++), payload: { ...original.payload }, attempts: 0, nextAttemptAt: 0, lastStatus: null, lastBody: null, finishedAt: null, done: false, dumped: false, suppressed: false, createdAt: clock.iso() };
      state.callbacks[copy.id] = copy; persist();
    }
  }
  return { redirect: '/admin' };
}

/* --------------------------------------------------------------- HTTP router */

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
function buildJsonCurl(req, p, raw) {
  const base = String(PUBLIC_BASE_URL).replace(/\/$/, '');
  const parts = [`curl -sS -X POST ${shellQuote(`${base}${p}`)}`, `-H ${shellQuote('Content-Type: application/json')}`];
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
    if (p === '/admin/login' && req.method === 'POST') {
      return core.handleAdminLogin(req, res, typeof raw !== 'undefined' ? raw : undefined, parseBody, send);
    }
    const access = checkControlAccess(req, { adminToken: MOCK_ADMIN_TOKEN, operatorToken: OPERATOR_TOKEN, surface, hosted: HOSTED });
    if (!access.allowed) {
      if (p === '/admin' && req.method === 'GET') {
        return core.html(res, core.adminLoginForm(req));
      }
      const envName = surface === 'admin' ? 'MOCK_ADMIN_TOKEN' : 'MOCK_OPERATOR_TOKEN';
      const message = access.reason === 'hosted-fail-closed'
        ? `${p} закрыт в hosted-режиме: задайте ${envName}`
        : `Для ${p} требуется управляющий токен ${envName}`;
      return jsonRaw(res, 401, sberError(2, message, { field: surface === 'admin' ? 'Authorization' : 'X-Operator-Token', hint: access.hint || `Передайте Authorization: Bearer <${envName}> или X-Operator-Token/X-Admin-Token.` }));
    }
  }

  const isRest = p.startsWith(REST_BASE);
  if (isRest) {
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
      return jsonRaw(res, chaos.abortStatus, sberError(6, chaos.abortMessage, { hint: 'X-Mock-Scenario смоделировал транспортный сбой до Ecom-операции; повторите запрос и сверьте состояние.' }));
    }
  }

  if (req.method === 'GET' && p === '/openapi.json') {
    const specPath = path.join(__dirname, '..', '..', 'docs', 'openapi', 'sber-mock.openapi.json');
    return sendJson(res, JSON.parse(fs.readFileSync(specPath, 'utf8')));
  }
  if (req.method === 'GET' && p === '/health') {
    const health = {
      ok: true,
      sandbox: sandboxRuntime.currentId(),
      tenancy: TENANCY,
      api: 'rest-json',
      base: REST_BASE,
      twoStage: TWO_STAGE,
      sessionTimeoutSecs: SESSION_TIMEOUT_SECS,
      callbackMethod: 'POST',
      callbackSignature: 'none',
      callbackRetryMs: CALLBACK_RETRY_MS,
      callbackMaxAttempts: CALLBACK_MAX_ATTEMPTS,
      maxPaymentAttempts: MAX_PAYMENT_ATTEMPTS,
    };
    if (TENANCY !== 'owned' || (admission.record.isDefault && !admission.record.ownerTokenHash) || admission.via === 'owner' || admission.via === 'operator') {
      Object.assign(health, {
        orders: Object.keys(state.orders).length,
        awaiting: Object.values(state.orders).filter((order) => order.status === 0 || order.status === 5).length,
        callbacks: Object.keys(state.callbacks).length,
      });
    }
    return sendJson(res, health);
  }
  if (req.method === 'GET' && p === '/admin/journal') return sendJson(res, { entries: journal.list() });

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
        try { JSON.parse(raw); } catch { return jsonRaw(res, 400, sberError(6, 'Снимок состояния не является валидным JSON', { field: 'state' })); }
      }
      const target = (body && body.sandbox) || admission.record.id;
      const snapshot = (body && body.state) || body || {};
      try {
        const imported = sandboxRuntime.importState(snapshot, target, req);
        if (!imported.ok) return sendSandboxError(res, { ok: false, kind: imported.error || 'unauthorized', sandbox: imported.sandbox || target });
        return sendJson(res, { ok: true, sandbox: imported.sandbox });
      } catch (error) {
        if (core.sendSandboxStateQuotaError(res, error)) return;
        return jsonRaw(res, 400, sberError(6, `Недопустимый снимок состояния: ${error.message}`, { field: 'state', hint: 'Опасные ключи __proto__, constructor и prototype запрещены.' }));
      }
    }
  }
  if (p === '/mock/time') {
    if (req.method === 'GET') return sendJson(res, clock.snapshot());
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        const snapshot = clock.set(body || {});
        tickSber();
        await deliveryQueue.tick();
        return sendJson(res, snapshot);
      } catch (error) {
        if (core.sendSandboxStateQuotaError(res, error)) return;
        return jsonRaw(res, 400, sberError(6, error.message, { field: 'advance|offset|iso', hint: 'Поля: advance (например "+20m"), offset (мс), iso (дата), reset (true).' }));
      }
    }
  }
  if (p === '/mock/scenarios') {
    if (req.method === 'GET') return sendJson(res, { rules: scenarios.listRules(), history: scenarios.listHistory() });
    if (req.method === 'POST') {
      try { return sendJson(res, { ok: true, rule: scenarios.addRule(body || {}) }); }
      catch (error) {
        const result = sberError(6, error.message, { field: 'scenario', hint: 'Поля: scenario, target (register/registerpreauth/deposit/reverse/refund/decline/getorderstatusextended/pay/3ds/*), match, times или persistent.' });
        if (error.code) result.code = error.code;
        return jsonRaw(res, 400, result);
      }
    }
    if (req.method === 'DELETE') {
      scenarios.clearRules(); scenarios.clearHistory();
      return sendJson(res, { ok: true, rules: [], history: [] });
    }
  }

  if (req.method === 'GET' && p === '/admin') return sendPage(res, adminPage(req));
  if (req.method === 'POST' && p === '/admin/action') {
    if (!core.isSameOriginRequest(req) || !core.verifyCsrfToken(body && body._csrf, ADMIN_CSRF_SECRET, sandboxRuntime.currentId())) {
      return jsonRaw(res, 403, sberError(2, 'Запрос заблокирован: отсутствует или неверен CSRF-токен', { field: '_csrf', hint: 'Откройте /admin и отправьте действие из формы консоли.' }));
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

  const formMatch = p.match(/^\/payment\/([A-Za-z0-9-]+)$/);
  if (formMatch && req.method === 'GET') {
    const order = findOrder(decodeURIComponent(formMatch[1]));
    if (!order) return sendPage(res, page('<span class="logo">Сбер Ecom · mock</span><h1>Заказ не найден</h1>'), 404);
    expireOrder(order);
    if (order.status === 0) return sendPage(res, formPage(order));
    if (order.status === 5) return sendPage(res, acsPage(order));
    return sendPage(res, statusPage(order));
  }
  const payMatch = p.match(/^\/payment\/([A-Za-z0-9-]+)\/pay$/);
  if (payMatch && req.method === 'POST') {
    const order = findOrder(decodeURIComponent(payMatch[1]));
    if (!order) return sendPage(res, page('<span class="logo">Сбер Ecom · mock</span><h1>Платёжная сессия не найдена</h1>'), 404);
    expireOrder(order);
    if (order.status !== 0) return sendPage(res, statusPage(order, 'Заказ уже не принимает карточные данные.'));
    const spec = resolveRequestSpec('pay', req, body, { orderId: order.orderId, orderNumber: order.orderNumber });
    const result = beginCardPay(order, body || {}, req, spec);
    if (result.redirect) return send(res, 302, '', { Location: result.redirect });
    if (result.stage === 'done') return sendPage(res, result.html);
    return sendPage(res, result.html);
  }
  const acsMatch = p.match(/^\/payment\/([A-Za-z0-9-]+)\/3ds$/);
  if (acsMatch && req.method === 'POST') {
    const order = findOrder(decodeURIComponent(acsMatch[1]));
    if (!order) return sendPage(res, page('<span class="logo">Сбер Ecom · mock</span><h1>ACS-сессия не найдена</h1>'), 404);
    expireOrder(order);
    if (order.status !== 5) return sendPage(res, statusPage(order, 'ACS-сессия уже закрыта.'));
    const spec = resolveRequestSpec('3ds', req, body, { orderId: order.orderId, orderNumber: order.orderNumber });
    const result = finish3ds(order, body || {}, spec);
    if (result.redirect) return send(res, 302, '', { Location: result.redirect });
    return sendPage(res, result.html);
  }

  if (isRest) return handleRest(req, res, p, raw, body);
  return jsonRaw(res, 404, sberError(6, `Неизвестный маршрут: ${req.method} ${p}`, { hint: 'Ecom REST начинается с /ecomm/gw/partner/api/v1/; форма оплаты — /payment/{orderId}.', doc: '' }));
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    if (core.sendSandboxStateQuotaError(res, error)) return;
    if (error && error.code === 'SANDBOX_EXPIRED') {
      try { sendSandboxError(res, { ok: false, kind: 'expired', sandbox: error.sandbox || 'default' }); } catch { /* headers sent */ }
      return;
    }
    if (error && error.code === 'BODY_TOO_LARGE') {
      try { jsonRaw(res, 413, sberError(6, 'Размер тела запроса превышает допустимый лимит', { field: 'body', hint: `Уменьшите тело до ${error.maxBytes} байт или менее.` })); } catch { /* headers sent */ }
      return;
    }
    log(`request error: ${error && error.message ? error.message : 'unknown error'}`);
    try { jsonRaw(res, 500, sberError(6, 'Внутренняя ошибка мок-стенда')); } catch { /* headers sent */ }
  });
});

restore();

// После restore/startup-миграций снимок отката должен содержать восстановленные данные.
sandboxRuntime.refreshStateQuota();

if (require.main === module) {
  const port = Number(MOCK_PORT);
  server.listen(Number.isFinite(port) && port >= 0 ? port : 3105, MOCK_HOST, () => {
    const actualPort = server.address().port;
    log(`sber-mock (Сбербанк Ecom REST v1.1.11.1) on http://${MOCK_HOST}:${actualPort}`);
    log(`creds: userName=${credLogView(USER_NAME_CRED, DEFAULT_USER_NAME)} password=${credLogView(PASSWORD_CRED, DEFAULT_PASSWORD)} (дефолты СИНТЕТИЧЕСКИЕ; фактические значения MOCK_SBER_USERNAME/MOCK_SBER_PASSWORD в лог не попадают)`);
    log(`callback: POST JSON без подписи · ACK ровно 200 · retry ${CALLBACK_RETRY_MS}ms × ${CALLBACK_MAX_ATTEMPTS} (дефолт контракта 60s × 3)`);
    log(`order TTL=${SESSION_TIMEOUT_SECS}s · max payment attempts=${MAX_PAYMENT_ATTEMPTS} · twoStage=${TWO_STAGE} · tenancy=${TENANCY} · hosted=${HOSTED} · block_private_webhooks=${BLOCK_PRIVATE_WEBHOOKS}`);
    log('вне области: paymentOrder.do (требует разрешения мерчанта), SberPay/SBP Sandbox, моделирование orderBundle; legacy Secure Payments callback signature не используется');
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
  REST_BASE,
  REST_METHODS,
  statusView,
  tickSber,
};
