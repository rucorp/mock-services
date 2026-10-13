// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * YooKassa API mock stand (issue #33, Stage 2 — первый внешний банк-адаптер).
 *
 * Emulates the YooKassa merchant API without the real test contour:
 *   - REST /v3: Basic Auth (shopId:secretKey), Idempotence-Key на POST
 *   - POST /v3/payments, GET /v3/payments[/{id}], capture, cancel
 *   - POST /v3/refunds, GET /v3/refunds[/{id}]
 *   - Статусы pending -> waiting_for_capture -> succeeded | canceled
 *   - Confirmation-страница /payment/{id} с тестовыми картами (03-testing.md)
 *   - Webhooks {type,event,object} через core-очередь (ретраи, SSRF-guard)
 *   - /mock/time (виртуальные часы), /mock/scenarios, /admin/journal (curl)
 *   - Sandbox runtime RFC-001 (X-Mock-Sandbox, owner-token, квоты)
 *
 * Ошибки — в формате ЮKassa ({type:"error", id, code, description, parameter})
 * + DX-слой мока: hint (ru) и doc (ссылка на раздел доков). Форк, зафиксированный
 * в README: 405/415 отдаются с ПУСТЫМ телом, как в официальной документации
 * response-handling (решение координатора), DX-слой их не покрывает.
 *
 * Zero npm dependencies. Config via environment, see README.md in this dir.
 * Секреты тестовые по определению; не выставляйте мок публично без защиты.
 */

const http = require('http');
const crypto = require('crypto');

const core = require('../../packages/core');
const {
  readBody, parseBody, send, sendJson, html, escapeHtml, checkControlAccess,
  parseScenarioSpec, applyRequestChaos, createSandboxRuntime, resolveTenancyMode, parseMsOr,
} = core;
const log = core.createLog('yookassa-mock');

const {
  MOCK_HOST = '0.0.0.0',
  MOCK_PORT = '3102',
  MOCK_SHOP_ID = '',
  YOOKASSA_SHOP_ID = '',
  MOCK_SECRET_KEY = '',
  YOOKASSA_SECRET_KEY = '',
  MOCK_PUBLIC_BASE_URL = 'http://localhost:3102',
  MOCK_DEFAULT_WEBHOOK_URL = '',
  MOCK_RETRY_MS = '60000',
  MOCK_MAX_ATTEMPTS = '24',
  MOCK_CAPTURE_TTL_MS = '',     // удержание waiting_for_capture (доки: 7 дней для карт)
  MOCK_PENDING_TTL_MS = '0',    // авто-отмена pending (0 — выключено)
  MOCK_REFUND_DELAY_MS = '0',   // 0 — возврат succeeded сразу (как в доке ЮKassa)
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
  MOCK_SANDBOX_RETENTION_MS = '',
  MOCK_SANDBOX_HOST_SUFFIX = '',
  MOCK_SANDBOX_CREATE_LIMIT = '',
} = process.env;

// Креды стенда (default-песочница и self-hosted): env -> дефолт мока.
const DEFAULT_SHOP_ID = MOCK_SHOP_ID || YOOKASSA_SHOP_ID || 'YOOKASSAMOCKTEST';
const DEFAULT_SECRET_KEY = MOCK_SECRET_KEY || YOOKASSA_SECRET_KEY || 'mockpass123';
const RETRY_MS = Math.max(1000, parseInt(MOCK_RETRY_MS, 10) || 60000);
const MAX_ATTEMPTS = Math.max(1, parseInt(MOCK_MAX_ATTEMPTS, 10) || 24);
// Холд по правилам ЮKassa: 7 дней для карт; иначе — авто-отмена по TTL.
const CAPTURE_TTL_MS = parseMsOr(MOCK_CAPTURE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
const PENDING_TTL_MS = Math.max(0, parseInt(MOCK_PENDING_TTL_MS, 10) || 0);
const REFUND_DELAY_MS = Math.max(0, parseInt(MOCK_REFUND_DELAY_MS, 10) || 0);
const IDEMPOTENCY_MAX_ENTRIES = 1000;
// F-07/F-08: hosted включает fail-closed и SSRF-политику по умолчанию.
const HOSTED = core.flagEnabled(MOCK_HOSTED);
const OPERATOR_TOKEN = MOCK_OPERATOR_TOKEN || '';
const ADMIN_CSRF_SECRET = crypto.randomBytes(32).toString('hex');
const BLOCK_PRIVATE_WEBHOOKS = core.flagEnabled(MOCK_BLOCK_PRIVATE_WEBHOOKS, HOSTED);

/* --------------------------------------------- мульти-аренда (RFC-001, F-12) */

const TENANCY = resolveTenancyMode(MOCK_TENANCY, HOSTED, (warning) => log(`WARN ${warning}`));
const SANDBOX_OWNER_TOKEN = String(MOCK_SANDBOX_TOKEN || '').trim();
const SANDBOX_TTL_MS = parseMsOr(MOCK_SANDBOX_TTL_MS, TENANCY === 'owned' ? 24 * 60 * 60 * 1000 : 0);
const SANDBOX_MAX = parseMsOr(MOCK_SANDBOX_MAX, TENANCY === 'owned' ? 100 : 256);
const SANDBOX_MAX_DOCUMENTS = parseMsOr(MOCK_SANDBOX_MAX_DOCUMENTS, TENANCY === 'owned' ? 5000 : 0);
const SANDBOX_RETENTION_MS = parseMsOr(MOCK_SANDBOX_RETENTION_MS, 0);
const SANDBOX_HOST_SUFFIX = String(MOCK_SANDBOX_HOST_SUFFIX || '').trim();
const SANDBOX_CREATE_LIMIT = parseMsOr(MOCK_SANDBOX_CREATE_LIMIT, TENANCY === 'owned' ? 20 : 0);

/* ------------------------------------------------------------------ store */

const store = core.createStore({ stateFile: MOCK_STATE_FILE, log: console.error });
const restore = store.restore;
const defaultState = store.state;

/**
 * Начальное состояние песочницы. `seed` уникален для каждой песочницы; id
 * документов — uuid, поэтому seed нужен только для счётчиков.
 */
function createInitialYookassaState({ seed = 0 } = {}) {
  return {
    counters: { notificationId: 1 + seed * 1000000 },
    payments: {},        // paymentId -> payment
    refunds: {},         // refundId -> refund
    notifications: {},   // notificationId -> {event, url, payload, attempts, ...}
    idempotency: {},     // Idempotence-Key -> {scope, hash, status, body, at}
    clockOffsetMs: 0,
  };
}

{
  const initial = createInitialYookassaState();
  for (const key of Object.keys(initial)) {
    if (defaultState[key] === undefined) defaultState[key] = initial[key];
  }
}

/** Лимит документов песочницы (F-15): сумма видимых исторических коллекций. */
function countYookassaDocuments(snapshot) {
  return ['payments', 'refunds']
    .reduce((sum, key) => sum + Object.keys(snapshot[key] || {}).length, 0)
    + Object.keys(snapshot.notifications || {}).length;
}

/**
 * Retention (F-15, по умолчанию выключен): чистим только терминальные
 * диагностические записи (доставленные/исчерпанные вебхуки). История
 * платежей и возвратов не трогается.
 */
function yookassaRetention(snapshot, ts) {
  if (!SANDBOX_RETENTION_MS) return 0;
  const deadline = ts - SANDBOX_RETENTION_MS;
  let pruned = 0;
  for (const [id, n] of Object.entries(snapshot.notifications || {})) {
    const finished = n && (n.done || n.dumped || n.suppressed);
    const at = Date.parse((n && (n.finishedAt || n.createdAt)) || '') || 0;
    if (finished && at && at <= deadline) {
      delete snapshot.notifications[id];
      pruned += 1;
    }
  }
  return pruned;
}

// Дочернее состояние записи песочницы (#52): сценарии и журнал создаются
// ниже; runtime зовёт этот hook при удалении/TTL записи, когда они уже готовы.
let dropSandboxChildState = () => {};
const sandboxRuntime = createSandboxRuntime({
  state: defaultState,
  persist: store.persist,
  initialStateFactory: createInitialYookassaState,
  mode: TENANCY,
  stateFile: MOCK_STATE_FILE,
  sandboxFile: String(process.env.MOCK_SANDBOX_FILE || ''),
  ttlMs: SANDBOX_TTL_MS,
  maxSandboxes: SANDBOX_MAX,
  maxDocuments: SANDBOX_MAX_DOCUMENTS,
  documentCounter: countYookassaDocuments,
  retention: yookassaRetention,
  defaultOwnerToken: SANDBOX_OWNER_TOKEN,
  hostSuffix: SANDBOX_HOST_SUFFIX,
  operatorTokens: [MOCK_ADMIN_TOKEN, OPERATOR_TOKEN],
  createLimit: SANDBOX_CREATE_LIMIT,
  onSandboxRemoved: (record) => dropSandboxChildState(record),
  log: (msg) => console.error(`[mock] ${msg}`),
});

const state = sandboxRuntime.state;
const persist = sandboxRuntime.persist;

// Журнал — per-sandbox раздел записи текущей песочницы (PB-13, #52).
const journal = core.createJournal({ size: 200, sandboxScope: () => sandboxRuntime.current() });

/* --------------------------------------------------- креды песочницы (F-12) */

/**
 * В owned-режиме у каждой песочницы свои shopId/secretKey (интегратор проходит
 * тот же путь, что в бою); в остальных режимах — креды стенда.
 */
const shopId = () => sandboxRuntime.creds().shopId || DEFAULT_SHOP_ID;
const secretKey = () => sandboxRuntime.creds().secretKey || DEFAULT_SECRET_KEY;

// DEPRECATED-константы: креды default/self-hosted стенда (BC для тестов и /admin).
const SHOP_ID = DEFAULT_SHOP_ID;
const SECRET_KEY = DEFAULT_SECRET_KEY;

const clock = core.createVirtualClock({
  initial: MOCK_VIRTUAL_CLOCK,
  getStateOffset: () => state.clockOffsetMs || 0,
  setStateOffset: (v) => { state.clockOffsetMs = v; persist(); },
});

const scenarios = core.createScenarioRegistry({ clock, sandboxScope: () => sandboxRuntime.current() });
dropSandboxChildState = (record) => { scenarios.dropScope(record); journal.dropScope(record); };
const clearSandboxChildState = (record) => {
  if (!record) return;
  scenarios.clearRulesFor(record);
  scenarios.clearHistoryFor(record);
  journal.clearFor(record);
};

/* ------------------------------------------------------------ test cards */

/**
 * Тестовые карты ЮKassa (docs/reference/yookassa/03-testing.md): успех +
 * отказы с честными cancellation_details. Сценарий выбирается по PAN один раз
 * на форме; в state попадают только first6/last4 (F-10, минимизация).
 */
const CARDS = {
  // Успех
  '5555555555554477': { outcome: 'success', tds: true, label: 'MC — успех (3DS)' },
  '5555555555554444': { outcome: 'success', tds: false, label: 'MC — успех' },
  '4793128161644804': { outcome: 'success', tds: true, label: 'Visa — успех (3DS)' },
  '4111111111111111': { outcome: 'success', tds: false, label: 'Visa — успех' },
  '4175001000000017': { outcome: 'success', tds: false, label: 'Visa Electron — успех' },
  // Отказы (MC-колонка таблицы; у каждой причины три карты — в доке)
  '5555555555554592': { outcome: 'decline', reason: '3d_secure_failed', tds: true, label: 'MC — отказ 3d_secure_failed' },
  '5555555555554535': { outcome: 'decline', reason: 'call_issuer', label: 'MC — отказ call_issuer' },
  '5555555555554543': { outcome: 'decline', reason: 'card_expired', label: 'MC — отказ card_expired' },
  '5555555555554568': { outcome: 'decline', reason: 'fraud_suspected', label: 'MC — отказ fraud_suspected' },
  '5555555555554527': { outcome: 'decline', reason: 'general_decline', label: 'MC — отказ general_decline' },
  '5555555555554600': { outcome: 'decline', reason: 'insufficient_funds', label: 'MC — отказ insufficient_funds' },
  '5555555555554618': { outcome: 'decline', reason: 'invalid_card_number', label: 'MC — отказ invalid_card_number' },
  '5555555555554626': { outcome: 'decline', reason: 'invalid_csc', label: 'MC — отказ invalid_csc' },
  '5555555555554501': { outcome: 'decline', reason: 'issuer_unavailable', label: 'MC — отказ issuer_unavailable' },
  '5555555555554576': { outcome: 'decline', reason: 'payment_method_limit_exceeded', label: 'MC — отказ payment_method_limit_exceeded' },
  '5555555555554550': { outcome: 'decline', reason: 'payment_method_restricted', label: 'MC — отказ payment_method_restricted' },
};

/**
 * party cancellation_details по официальной таблице declined-payments:
 *   merchant — отмена по API/форме, yoo_money — ЮKassa (истечение срока,
 *   блокировка по фроду), payment_network — прочие участники (эмитент/схема).
 */
function declineParty(reason) {
  if (reason === 'fraud_suspected') return 'yoo_money';
  return 'payment_network';
}

function luhnValid(pan) {
  let sum = 0;
  let alt = false;
  for (let i = pan.length - 1; i >= 0; i -= 1) {
    let d = pan.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return pan.length >= 12 && sum % 10 === 0;
}

function cardTypeOf(pan) {
  if (/^4/.test(pan)) return 'Visa';
  if (/^5[1-5]/.test(pan)) return 'MasterCard';
  if (/^2/.test(pan)) return 'Mir';
  return 'Unknown';
}

/* ------------------------------------------------------- money helpers */

const AMOUNT_STRING_RE = /^\d{1,9}(\.\d{1,2})?$/;

/** Копейки из decimal-строки "100.00" -> 10000; нормализация до 2 знаков. */
function normalizeAmountValue(rawValue) {
  if (typeof rawValue !== 'string' || !AMOUNT_STRING_RE.test(rawValue)) return null;
  const [intPart, fracRaw = ''] = rawValue.split('.');
  const frac = `${fracRaw}00`.slice(0, 2);
  const kopecks = parseInt(intPart, 10) * 100 + parseInt(frac, 10);
  if (!Number.isSafeInteger(kopecks) || kopecks <= 0) return null;
  return { value: (kopecks / 100).toFixed(2), kopecks };
}

function amountView(kopecks, currency = 'RUB') {
  return { value: (kopecks / 100).toFixed(2), currency };
}

/**
 * Валидация amount-объекта создателей (платеж/возврат). Возвращает
 * нормализованный `{amount, kopecks}` или `{error}` с provider-shaped ошибкой.
 */
function validateAmountObject(bodyAmount) {
  if (!bodyAmount || typeof bodyAmount !== 'object' || Array.isArray(bodyAmount)) {
    return {
      error: yerr('invalid_request', {
        description: 'Field amount is required and must be an object like {"value": "100.00", "currency": "RUB"}',
        parameter: 'amount',
        hint: 'amount.value — decimal-строка с точностью до 2 знаков (строка, не число); amount.currency — "RUB".',
        doc: '/payment-acceptance/getting-started/quick-start',
      }),
    };
  }
  if (bodyAmount.value === undefined || bodyAmount.value === null) {
    return {
      error: yerr('invalid_request', {
        description: 'Field amount.value is required',
        parameter: 'amount.value',
        hint: 'Передайте decimal-строку, например "100.00". Числовой JSON-тип не принимается.',
        doc: '/payment-acceptance/getting-started/quick-start',
      }),
    };
  }
  if (typeof bodyAmount.value !== 'string') {
    return {
      error: yerr('invalid_request', {
        description: 'Invalid parameter\'s value: amount.value must be a decimal string (for example "100.00"), not a number',
        parameter: 'amount.value',
        hint: 'API ЮKassa принимает суммы строкой: "100.00", а не 100 или 100.0.',
        doc: '/payment-acceptance/getting-started/quick-start',
      }),
    };
  }
  const normalized = normalizeAmountValue(bodyAmount.value);
  if (!normalized) {
    return {
      error: yerr('invalid_request', {
        description: 'Invalid parameter\'s value: amount.value must be a positive decimal with up to 2 fractional digits (for example "100.00")',
        parameter: 'amount.value',
        hint: 'Дробная часть — не длиннее 2 знаков; нулевая сумма невалидна.',
        doc: '/payment-acceptance/getting-started/quick-start',
      }),
    };
  }
  if (bodyAmount.currency === undefined || bodyAmount.currency === null) {
    return {
      error: yerr('invalid_request', {
        description: 'Field amount.currency is required',
        parameter: 'amount.currency',
        hint: 'Мок поддерживает только "RUB" (ISO-4217, заглавными).',
        doc: '/payment-acceptance/getting-started/quick-start',
      }),
    };
  }
  if (typeof bodyAmount.currency !== 'string' || bodyAmount.currency !== 'RUB') {
    return {
      error: yerr('invalid_request', {
        description: `Invalid parameter's value: amount.currency must be "RUB" (got ${JSON.stringify(bodyAmount.currency)})`,
        parameter: 'amount.currency',
        hint: 'Тестовый стенд ЮKassa работает только в рублях: amount.currency = "RUB".',
        doc: '/payment-acceptance/getting-started/quick-start',
      }),
    };
  }
  return { amount: { value: normalized.value, currency: 'RUB' }, kopecks: normalized.kopecks };
}

/* ----------------------------------------------------------- DX-ошибки */

const HTTP_BY_CODE = {
  invalid_request: 400,
  invalid_credentials: 401,
  forbidden: 403,
  not_found: 404,
  too_many_requests: 429,
  internal_server_error: 500,
};

const derr = core.createErrorCatalog({
  provider: 'yookassa',
  docsBase: 'https://yookassa.ru/developers',
  codes: {
    invalid_request: {
      message: 'Invalid parameter\'s value',
      hint: 'Проверьте обязательные поля и форматы (decimal-строка суммы, RUB, confirmation.type=redirect, Idempotence-Key на POST).',
      doc: '/using-api/response-handling/response-format',
    },
    invalid_credentials: {
      message: 'Request authentication data is invalid',
      field: 'Authorization',
      hint: 'Basic Auth: base64(shopId:secretKey). Дефолтные креды стенда печатаются в логе при старте.',
      doc: '/using-api/authorization',
    },
    forbidden: { message: 'Access to the resource is forbidden', doc: '/using-api/response-handling/http-codes' },
    not_found: {
      message: 'The requested resource could not be found',
      hint: 'Проверьте id: платежи/возвраты живут в состоянии стенда (MOCK_STATE_FILE), после рестарта с пустым файлом старые id недоступны.',
      doc: '/using-api/response-handling/http-codes',
    },
    too_many_requests: {
      message: 'Too many requests',
      hint: 'Лимит превышен — повторите позже (в моке не эмулируется).',
      doc: '/using-api/response-handling/http-codes',
    },
    internal_server_error: {
      message: 'Internal server error',
      hint: 'Смотрите лог сервиса; если воспроизводится — это дефект мока, заводите issue.',
      doc: '/using-api/response-handling/http-codes',
    },
  },
});

/**
 * Ошибка в формате ЮKassa: {type:"error", id, code, description, parameter}
 * + DX-слой мока: hint (ru) и doc (URL раздела доков).
 */
function yerr(code, { description, parameter, hint, doc, id } = {}) {
  const known = derr(code, { message: description, hint, doc, field: parameter });
  return {
    type: 'error',
    id: id || crypto.randomUUID(),
    code,
    description: description || known.message,
    ...(parameter ? { parameter } : {}),
    hint: hint || known.hint || undefined,
    doc: known.doc || undefined,
  };
}

function yerrStatus(body) {
  return HTTP_BY_CODE[body && body.code] || 400;
}

/** F-15: квота документов песочницы перед созданием нового документа. */
function ensureSandboxQuota() {
  const quota = sandboxRuntime.checkDocuments();
  if (quota.ok) return null;
  return yerr('invalid_request', {
    description: `${quota.kind === 'bytes' ? 'Sandbox state size limit reached (bytes: ' : 'Sandbox document limit reached ('}${quota.used}/${quota.limit}${quota.kind === 'bytes' ? ')' : ''}`,
    hint: `${quota.kind === 'bytes' ? 'Песочница ограничена по объёму состояния (байтовая квота, PD-02): сбросьте её (POST /sandboxes/me/reset) или создайте новую (POST /sandboxes).' : 'Песочница ограничена по объёму (MOCK_SANDBOX_MAX_DOCUMENTS): сбросьте её (POST /sandboxes/me/reset) или создайте новую (POST /sandboxes).'}`,
    doc: '',
  });
}

/* ------------------------------------------------------------ webhooks */

/**
 * Очередь доставки вебхуков (ядро: ретраи, SSRF-guard, дедуп-сценарии).
 * ACK по документации ЮKassa — ровно HTTP 200, тело ответа игнорируется;
 * до 200 (в т.ч. 2xx!) вебхук повторяется в течение 24 часов.
 */
const deliveryQueue = core.createDeliveryQueue({
  entries: () => state.notifications,
  retryMs: RETRY_MS,
  maxAttempts: MAX_ATTEMPTS,
  persist,
  log,
  now: () => clock.now(),
  request: (n) => ({ url: n.url, data: n.payload }),
  isOk: (res) => res.statusCode === 200,
  blockPrivateHosts: BLOCK_PRIVATE_WEBHOOKS,
  due: (n) => !n.done && !n.dumped && !n.suppressed && (n.nextAttemptAt || 0) <= clock.now(),
  prepare: (n) => { n.attempts += 1; },
  onFailure: (n, status, body) => {
    n.lastStatus = status;
    n.lastBody = body;
    if (n.attempts >= MAX_ATTEMPTS) {
      n.dumped = true;
      log(`webhook ${n.id} dumped after ${n.attempts} attempts`);
    } else {
      n.nextAttemptAt = clock.now() + RETRY_MS;
    }
  },
  onSuccess: (n, status) => {
    n.done = true;
    n.nextAttemptAt = null;
    n.lastStatus = status;
    n.finishedAt = clock.iso();
  },
});

/**
 * URL приёмника для платежа: mock-расширение metadata.webhook_url (если
 * задан) иначе MOCK_DEFAULT_WEBHOOK_URL, читаемый в момент постановки.
 */
function webhookUrlFor(payment) {
  const meta = payment && payment.metadata;
  const override = meta && typeof meta.webhook_url === 'string' ? meta.webhook_url.trim() : '';
  if (override) return override;
  return String(process.env.MOCK_DEFAULT_WEBHOOK_URL || MOCK_DEFAULT_WEBHOOK_URL || '').trim();
}

/**
 * Постановка события в очередь: {type:"notification", event, object}.
 * Событие ставится на каждый переход статуса; `spec` даёт сценарии
 * webhook-drop|no-webhook (подавить) и webhook-duplicate (две копии).
 */
function scheduleWebhook(event, object, { url, spec = null } = {}) {
  const target = String(url || '').trim();
  if (!target) {
    log(`${event}: no webhook URL, skip (${(object && object.id) || '-'})`);
    return [];
  }
  const suppressed = Boolean(spec && (spec.has('webhook-drop') || spec.has('no-webhook')));
  const duplicate = Boolean(spec && spec.has('webhook-duplicate'));
  const payload = {
    type: 'notification',
    event,
    object: JSON.parse(JSON.stringify(object)),
  };
  const count = duplicate && !suppressed ? 2 : 1;
  const created = [];
  for (let i = 0; i < count; i += 1) {
    const id = String(state.counters.notificationId++);
    state.notifications[id] = {
      id,
      event,
      url: target,
      payload,
      attempts: 0,
      nextAttemptAt: 0,
      lastStatus: suppressed ? 'SUPPRESSED' : null,
      lastBody: suppressed ? 'suppressed by webhook-drop scenario' : null,
      finishedAt: null,
      dumped: false,
      done: suppressed,
      suppressed,
      createdAt: clock.iso(),
    };
    created.push(id);
    log(`webhook ${id} ${suppressed ? 'SUPPRESSED (webhook-drop)' : 'queued'}: ${event} ${(object && object.id) || ''}`);
  }
  persist();
  return created;
}

/* ------------------------------------------------- payments & refunds IO */

/** Официальное «лицо» платежа (PaymentResponse); внутренние поля скрыты. */
function paymentView(p) {
  return {
    id: p.id,
    status: p.status,
    amount: { ...p.amount },
    ...(p.description ? { description: p.description } : {}),
    ...(p.recipient ? { recipient: p.recipient } : {}),
    ...(p.captured_at ? { captured_at: p.captured_at } : {}),
    created_at: p.created_at,
    ...(p.expires_at ? { expires_at: p.expires_at } : {}),
    confirmation: { ...p.confirmation },
    test: true,
    paid: p.paid,
    refundable: p.refundable,
    ...(p.status === 'succeeded' ? { refunded_amount: amountView(p.refundedKopecks || 0) } : {}),
    ...(p.metadata ? { metadata: { ...p.metadata } } : {}),
    ...(p.payment_method ? { payment_method: JSON.parse(JSON.stringify(p.payment_method)) } : {}),
    ...(p.authorization_details ? { authorization_details: JSON.parse(JSON.stringify(p.authorization_details)) } : {}),
    ...(p.cancellation_details ? { cancellation_details: { ...p.cancellation_details } } : {}),
  };
}

/** Официальное «лицо» возврата (RefundResponse). */
function refundView(r) {
  return {
    id: r.id,
    payment_id: r.payment_id,
    status: r.status,
    amount: { ...r.amount },
    created_at: r.created_at,
    ...(r.description ? { description: r.description } : {}),
    ...(r.refund_authorization_details ? { refund_authorization_details: { ...r.refund_authorization_details } } : {}),
    ...(r.metadata ? { metadata: { ...r.metadata } } : {}),
    ...(r.cancellation_details ? { cancellation_details: { ...r.cancellation_details } } : {}),
  };
}

function findPayment(id) {
  return state.payments[String(id || '')] || null;
}

function findRefund(id) {
  return state.refunds[String(id || '')] || null;
}

function paymentNotFound(id) {
  return yerr('not_found', {
    description: 'Incorrect payment_id. Payment doesn\'t exist or access denied.',
    parameter: 'payment_id',
    hint: 'Проверьте id платежа (GET /v3/payments/{id}); список — GET /v3/payments, состояние — /admin.',
    doc: '/using-api/resources/payment',
  });
}

function refundNotFound(id) {
  return yerr('not_found', {
    description: 'Incorrect refund_id. Refund doesn\'t exist or access denied.',
    parameter: 'refund_id',
    hint: 'Проверьте id возврата; список — GET /v3/refunds.',
    doc: '/using-api/resources/refund',
  });
}

/**
 * Переход платежа в canceled (общая точка для API-cancel, отказа на форме и
 * авто-истечения TTL): paid:false + cancellation_details + вебхук.
 */
function cancelPayment(payment, { party, reason }, { spec = null, url } = {}) {
  payment.status = 'canceled';
  payment.paid = false;
  payment.refundable = false;
  payment.cancellation_details = { party, reason };
  payment.canceled_at = clock.iso();
  persist();
  scheduleWebhook('payment.canceled', paymentView(payment), { url: url ?? webhookUrlFor(payment), spec });
  console.log(`[mock] payment ${payment.id} canceled: ${party}/${reason}`);
  return payment;
}

/** Успешное завершение (capture=true сразу либо POST .../capture). */
function succeedPayment(payment, kopecks, { spec = null } = {}) {
  payment.status = 'succeeded';
  payment.paid = true;
  payment.captured_at = clock.iso();
  payment.refundable = true;
  payment.capturedKopecks = kopecks;
  payment.refundedKopecks = payment.refundedKopecks || 0;
  payment.refunded_amount = amountView(payment.refundedKopecks);
  persist();
  scheduleWebhook('payment.succeeded', paymentView(payment), { url: webhookUrlFor(payment), spec });
  console.log(`[mock] payment ${payment.id} succeeded (captured ${(kopecks / 100).toFixed(2)} RUB)`);
  return payment;
}

/** Финализация возврата: pending -> succeeded (+ вебхук refund.succeeded). */
function finalizeRefund(refund) {
  if (refund.status !== 'pending') return refund;
  refund.status = 'succeeded';
  refund.finishedAt = clock.iso();
  persist();
  const payment = findPayment(refund.payment_id);
  scheduleWebhook('refund.succeeded', refundView(refund), { url: webhookUrlFor(payment) });
  console.log(`[mock] refund ${refund.id} succeeded for payment ${refund.payment_id}`);
  return refund;
}

/* --------------------------------------------------------- тик и TTL */

/**
 * Авто-переходы по виртуальным часам: истечение холда (7 дней по докам),
 * истечение pending (MOCK_PENDING_TTL_MS) и финализация отложенных возвратов.
 */
function tickYookassa() {
  const now = clock.now();
  for (const p of Object.values(state.payments)) {
    if (p.status === 'waiting_for_capture' && p.holdExpiresAtMs && now >= p.holdExpiresAtMs) {
      cancelPayment(p, { party: 'yoo_money', reason: 'expired_on_capture' });
    }
    if (p.status === 'pending' && p.pendingExpiresAtMs && now >= p.pendingExpiresAtMs) {
      cancelPayment(p, { party: 'yoo_money', reason: 'expired_on_confirmation' });
    }
  }
  for (const r of Object.values(state.refunds)) {
    if (r.status === 'pending' && r.finalizeAtMs && now >= r.finalizeAtMs) finalizeRefund(r);
  }
}

/* --------------------------------------------------------- auth/idempotence */

/** Basic Auth: base64(shopId:secretKey), сравнение в постоянном времени. */
function verifyBasicAuth(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Basic ')) {
    return yerr('invalid_credentials', {
      description: 'Request authentication data is invalid: Basic Authorization header is required',
      hint: 'Заголовок: Authorization: Basic base64(shopId:secretKey). Пример: curl -u YOOKASSAMOCKTEST:mockpass123.',
      doc: '/using-api/authorization',
    });
  }
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    decoded = '';
  }
  const sep = decoded.indexOf(':');
  const givenShop = sep >= 0 ? decoded.slice(0, sep) : '';
  const givenSecret = sep >= 0 ? decoded.slice(sep + 1) : '';
  const expectedShop = shopId();
  const expectedSecret = secretKey();
  const okShop = constantTimeEqual(givenShop, expectedShop);
  const okSecret = constantTimeEqual(givenSecret, expectedSecret);
  if (!okShop || !okSecret) {
    return yerr('invalid_credentials', {
      description: 'Invalid shopId or secret key',
      hint: 'Дефолтные креды стенда печатаются в лог при старте (MOCK_SHOP_ID/MOCK_SECRET_KEY переопределяют их).',
      doc: '/using-api/authorization',
    });
  }
  return null;
}

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Сравнение с самим собой, чтобы длина не утекала по времени.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

const IDEMPOTENCE_MISSING_TEXT =
  'Idempotence key is missing. Generate a unique key is specify it in the Idempotence-Key header';
const IDEMPOTENCE_TOO_LONG_TEXT =
  'Idempotence key is too long. Send the value in accordance with the documentation';

/** Проверка заголовка Idempotence-Key (обязателен для POST /v3). */
function idempotenceHeaderError(req) {
  const raw = req.headers['idempotence-key'];
  const key = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!key) {
    return {
      key,
      error: yerr('invalid_request', {
        description: IDEMPOTENCE_MISSING_TEXT,
        parameter: 'Idempotence-Key',
        hint: 'Ключ обязателен для POST /v3/*: уникальный на каждую логическую операцию, до 64 символов; повтор с тем же ключом вернёт сохранённый ответ.',
        doc: '/using-api/interaction-format',
      }),
    };
  }
  if (key.length > 64) {
    return {
      key,
      error: yerr('invalid_request', {
        description: IDEMPOTENCE_TOO_LONG_TEXT,
        parameter: 'Idempotence-Key',
        hint: 'Длина ключа — не более 64 символов (например, UUID v4).',
        doc: '/using-api/interaction-format',
      }),
    };
  }
  return { key, error: null };
}

function idempotencyScope(req, p) {
  return `${req.method} ${p}`;
}

function bodyHash(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

/**
 * Повтор того же ключа: тот же scope + то же тело -> сохранённый ответ
 * «как есть»; другой запрос с тем же ключом -> provider-shaped отказ
 * (документированный форк: настоящий ЮKassa ведёт себя так же при
 * конфликте идемпотентности — см. README «Форки»).
 */
function idempotencyLookup(key, scope, raw) {
  const rec = state.idempotency[key];
  if (!rec) return { replay: null, error: null };
  if (rec.scope !== scope || rec.hash !== bodyHash(raw)) {
    return {
      replay: null,
      error: yerr('invalid_request', {
        description: 'Idempotence key duplicated. The same Idempotence-Key was already used for a different request.',
        parameter: 'Idempotence-Key',
        hint: 'Один ключ = одна логическая операция (тот же endpoint и тело). Для новой операции сгенерируйте новый ключ.',
        doc: '/using-api/interaction-format',
        id: undefined,
      }),
    };
  }
  return { replay: { status: rec.status, body: rec.body }, error: null };
}

function idempotencyStore(key, scope, raw, outcome) {
  if (!key) return;
  if (outcome.status >= 500) return; // серверные сбои не фиксируем — повтор попробует ещё раз
  state.idempotency[key] = {
    scope,
    hash: bodyHash(raw),
    status: outcome.status,
    body: outcome.body,
    at: clock.iso(),
  };
  const keys = Object.keys(state.idempotency);
  if (keys.length > IDEMPOTENCY_MAX_ENTRIES) {
    // FIFO-вытеснение: старейший ключ (порядок вставки объекта сохраняется).
    for (const old of keys.slice(0, keys.length - IDEMPOTENCY_MAX_ENTRIES)) {
      delete state.idempotency[old];
    }
  }
  persist();
}

/* ---------------------------------------------------- business: payments */

/**
 * POST /v3/payments — валидация и создание платежа. Возвращает outcome
 * {status, body}; побочные эффекты (persist) — внутри.
 */
function handleCreatePayment(body, spec) {
  void spec; // create не шлёт вебхуков — spec нужен только операциям перехода
  const quota = ensureSandboxQuota();
  if (quota) return { status: 400, body: quota };

  const amountCheck = validateAmountObject(body.amount);
  if (amountCheck.error) return { status: 400, body: amountCheck.error };

  // capture: bool; не передан -> true (простой сценарий, как в quick-start).
  let capture = true;
  if (body.capture !== undefined) {
    if (typeof body.capture !== 'boolean') {
      return {
        status: 400,
        body: yerr('invalid_request', {
          description: 'Invalid parameter\'s value: capture must be a boolean (true or false)',
          parameter: 'capture',
          hint: 'capture=true — списание сразу после оплаты; capture=false — two-stage (hold + POST .../capture).',
          doc: '/payment-acceptance/getting-started/payment-process',
        }),
      };
    }
    capture = body.capture;
  }

  const confirmation = body.confirmation;
  if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation)) {
    return {
      status: 400,
      body: yerr('invalid_request', {
        description: 'Field confirmation is required. Specify the confirmation scenario for the payment',
        parameter: 'confirmation',
        hint: 'Мок поддерживает redirect-сценарий: {"confirmation": {"type": "redirect", "return_url": "https://..."}}.',
        doc: '/payment-acceptance/getting-started/quick-start',
      }),
    };
  }
  if (confirmation.type !== 'redirect') {
    return {
      status: 400,
      body: yerr('invalid_request', {
        description: `Invalid parameter's value: confirmation.type must be "redirect" (got ${JSON.stringify(confirmation.type)})`,
        parameter: 'confirmation.type',
        hint: 'Встроенные/платёжные виджеты (embedded и др.) мок не реализует — используйте redirect и откройте confirmation_url.',
        doc: '/payment-acceptance/getting-started/quick-start',
      }),
    };
  }
  if (typeof confirmation.return_url !== 'string' || !confirmation.return_url.trim()) {
    return {
      status: 400,
      body: yerr('invalid_request', {
        description: 'Field confirmation.return_url is required',
        parameter: 'confirmation.return_url',
        hint: 'return_url — куда браузер покупателя вернётся после оплаты (проверяйте статус GET-ом или вебхуком).',
        doc: '/payment-acceptance/getting-started/quick-start',
      }),
    };
  }
  if (confirmation.return_url.length > 2048) {
    return {
      status: 400,
      body: yerr('invalid_request', {
        description: 'Invalid parameter\'s value: confirmation.return_url is too long',
        parameter: 'confirmation.return_url',
        hint: 'Длина URL — не более 2048 символов.',
        doc: '/payment-acceptance/getting-started/quick-start',
      }),
    };
  }

  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string' || Buffer.byteLength(body.description, 'utf8') > 128) {
      return {
        status: 400,
        body: yerr('invalid_request', {
          description: 'Invalid parameter\'s value: description must be a string no longer than 128 characters',
          parameter: 'description',
          hint: 'Описание видно в кабинете и покупателю на форме оплаты; лимит 128 символов.',
          doc: '/payment-acceptance/getting-started/quick-start',
        }),
      };
    }
  }

  if (body.metadata !== undefined && body.metadata !== null) {
    const badMetadata = validateMetadata(body.metadata);
    if (badMetadata) return { status: 400, body: badMetadata };
  }

  // Ровно один способ оплаты из списка (взаимоисключающие поля).
  const methodFields = ['payment_token', 'payment_method_id', 'payment_method_data']
    .filter((f) => body[f] !== undefined && body[f] !== null);
  if (methodFields.length > 1) {
    return {
      status: 400,
      body: yerr('invalid_request', {
        description: `Invalid request: fields ${methodFields.join(', ')} are mutually exclusive, send only one of them`,
        parameter: methodFields[1],
        hint: 'Передайте ровно один способ оплаты (или ничего — покупатель выберет карту на confirmation-странице).',
        doc: '/payment-acceptance/getting-started/quick-start',
      }),
    };
  }
  if (body.payment_method_data && typeof body.payment_method_data === 'object'
      && body.payment_method_data.type !== undefined && body.payment_method_data.type !== 'bank_card') {
    return {
      status: 400,
      body: yerr('invalid_request', {
        description: `Payment method is not available: ${JSON.stringify(body.payment_method_data.type)}`,
        parameter: 'payment_method_data.type',
        hint: 'Тестовый стенд принимает только bank_card (покупатель вводит карту на confirmation-странице).',
        doc: '/payment-acceptance/getting-started/quick-start',
      }),
    };
  }

  const id = crypto.randomUUID();
  const nowMs = clock.now();
  const nowIso = clock.iso();
  const base = String(MOCK_PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const sandboxSelector = sandboxRuntime.currentId() === 'default' ? '' : `?sandbox=${encodeURIComponent(sandboxRuntime.currentId())}`;
  const payment = {
    id,
    status: 'pending',
    amount: amountCheck.amount,
    description: typeof body.description === 'string' ? body.description : null,
    metadata: body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? { ...body.metadata } : null,
    // Внутренние поля (не входят в официальный ответ):
    kopecks: amountCheck.kopecks,
    captureRequested: capture,
    capturedKopecks: null,
    refundedKopecks: 0,
    createdAtMs: nowMs,
    pendingExpiresAtMs: PENDING_TTL_MS > 0 ? nowMs + PENDING_TTL_MS : null,
    holdExpiresAtMs: null,
    canceled_at: null,
    canceled_at_ms: null,
    // Опциональные эхо-поля запроса (прозрачность, не валидируются —
    // receipt/сохранённые методы мок не моделирует, см. README «Границы»):
    receipt: body.receipt && typeof body.receipt === 'object' ? JSON.parse(JSON.stringify(body.receipt)) : null,
    payment_method: null,
    authorization_details: null,
    cancellation_details: null,
    created_at: nowIso,
    expires_at: PENDING_TTL_MS > 0 ? clock.iso(nowMs + PENDING_TTL_MS) : undefined,
    confirmation: {
      type: 'redirect',
      return_url: confirmation.return_url,
      confirmation_url: `${base}/payment/${id}${sandboxSelector}`,
    },
    paid: false,
    refundable: false,
  };
  if (payment.expires_at === undefined) delete payment.expires_at;
  state.payments[id] = payment;
  persist();
  console.log(`[mock] payment created: ${id} ${(amountCheck.kopecks / 100).toFixed(2)} RUB capture=${capture}`);
  return { status: 200, body: paymentView(payment) };
}

function validateMetadata(metadata) {
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    return yerr('invalid_request', {
      description: 'Invalid parameter\'s value: metadata must be an object of key-value pairs',
      parameter: 'metadata',
      hint: 'metadata: до 16 ключей, ключ ≤32 символов, значение ≤512 символов (строки UTF-8).',
      doc: '/payment-acceptance/getting-started/quick-start',
    });
  }
  const keys = Object.keys(metadata);
  if (keys.length > 16) {
    return yerr('invalid_request', {
      description: 'Invalid parameter\'s value: metadata must not contain more than 16 keys',
      parameter: 'metadata',
      hint: 'Лимиты metadata: 16 ключей, ключ ≤32 символов, значение ≤512 символов.',
      doc: '/payment-acceptance/getting-started/quick-start',
    });
  }
  for (const key of keys) {
    const value = metadata[key];
    if (key.length > 32 || (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 512)) {
      return yerr('invalid_request', {
        description: 'Invalid parameter\'s value: metadata key must be ≤32 chars and value ≤512 chars',
        parameter: 'metadata',
        hint: 'Лимиты metadata: 16 ключей, ключ ≤32 символов, значение ≤512 символов.',
        doc: '/payment-acceptance/getting-started/quick-start',
      });
    }
    if (value !== null && typeof value === 'object' || typeof value === 'function') {
      return yerr('invalid_request', {
        description: 'Invalid parameter\'s value: metadata values must be strings',
        parameter: 'metadata',
        hint: 'Сериализуйте сложные данные в строку перед отправкой.',
        doc: '/payment-acceptance/getting-started/quick-start',
      });
    }
  }
  return null;
}

/** GET /v3/payments/{id}. */
function handleGetPayment(id) {
  const payment = findPayment(id);
  if (!payment) return { status: 404, body: paymentNotFound(id) };
  return { status: 200, body: paymentView(payment) };
}

/**
 * POST /v3/payments/{id}/capture — приём удержания (полный или частичный).
 * Частичный: amount ≤ authorised; платёж становится succeeded, удержанная
 * сумма = capturedKopecks (лимит возвратов), amount объекта не меняется.
 */
function handleCapturePayment(payment, body, spec) {
  if (payment.status !== 'waiting_for_capture') {
    return {
      status: 400,
      body: yerr('invalid_request', {
        description: `Payment cannot be captured in the current status "${payment.status}"`,
        parameter: 'payment_id',
        hint: 'capture доступен только из waiting_for_capture; pending — сначала оплатите на confirmation-странице, succeeded/canceled — терминальные статусы.',
        doc: '/payment-acceptance/getting-started/payment-process',
      }),
    };
  }

  let kopecks = payment.kopecks;
  if (body.amount !== undefined && body.amount !== null) {
    const amountCheck = validateAmountObject(body.amount);
    if (amountCheck.error) return { status: 400, body: amountCheck.error };
    kopecks = amountCheck.kopecks;
    if (kopecks > payment.kopecks) {
      return {
        status: 400,
        body: yerr('invalid_request', {
          description: `Invalid parameter's value: capture amount ${amountCheck.amount.value} exceeds the authorized amount ${payment.amount.value}`,
          parameter: 'amount',
          hint: 'Подтвердить можно не больше авторизованной суммы; частичный capture — допустим (сумма меньше, остаток вернётся покупателю).',
          doc: '/payment-acceptance/getting-started/payment-process',
        }),
      };
    }
  }
  succeedPayment(payment, kopecks, { spec });
  return { status: 200, body: paymentView(payment) };
}

/**
 * POST /v3/payments/{id}/cancel — отмена merchant'ом (party: merchant,
 * reason: canceled_by_merchant). Доступна из pending и waiting_for_capture.
 */
function handleCancelPayment(payment, spec) {
  if (payment.status !== 'pending' && payment.status !== 'waiting_for_capture') {
    return {
      status: 400,
      body: yerr('invalid_request', {
        description: `Payment cannot be canceled in the current status "${payment.status}"`,
        parameter: 'payment_id',
        hint: 'Отменить можно только pending или waiting_for_capture. Для succeeded используйте возврат: POST /v3/refunds.',
        doc: '/payment-acceptance/after-the-payment/refunds',
      }),
    };
  }
  cancelPayment(payment, { party: 'merchant', reason: 'canceled_by_merchant' }, { spec });
  return { status: 200, body: paymentView(payment) };
}

/* ------------------------------------------------------ business: refunds */

/** POST /v3/refunds — возврат (полный/частичный) по succeeded-платежу. */
function handleCreateRefund(body, spec) {
  const quota = ensureSandboxQuota();
  if (quota) return { status: 400, body: quota };

  const paymentId = body.payment_id;
  if (paymentId === undefined || paymentId === null || String(paymentId).trim() === '') {
    return {
      status: 400,
      body: yerr('invalid_request', {
        description: 'Field payment_id is required',
        parameter: 'payment_id',
        hint: 'Укажите id платежа, по которому оформляется возврат.',
        doc: '/payment-acceptance/after-the-payment/refunds',
      }),
    };
  }
  const payment = findPayment(paymentId);
  if (!payment) {
    return { status: 404, body: paymentNotFound(paymentId) };
  }
  if (payment.status !== 'succeeded') {
    return {
      status: 400,
      body: yerr('invalid_request', {
        description: `Payment cannot be refunded in the current status "${payment.status}"`,
        parameter: 'payment_id',
        hint: 'Возврат возможен только по платежу в статусе succeeded (после capture).',
        doc: '/payment-acceptance/after-the-payment/refunds',
      }),
    };
  }

  const amountCheck = validateAmountObject(body.amount);
  if (amountCheck.error) {
    // Явное требование: amount обязателен для refund.
    if (body.amount === undefined || body.amount === null) {
      return {
        status: 400,
        body: yerr('invalid_request', {
          description: 'Field amount is required for a refund',
          parameter: 'amount',
          hint: 'Передайте {"value": "100.00", "currency": "RUB"}; для полного возврата — остаток refundable.',
          doc: '/payment-acceptance/after-the-payment/refunds',
        }),
      };
    }
    return { status: 400, body: amountCheck.error };
  }
  if (amountCheck.amount.currency !== payment.amount.currency) {
    return {
      status: 400,
      body: yerr('invalid_request', {
        description: 'Invalid parameter\'s value: refund currency must match the payment currency',
        parameter: 'amount.currency',
        hint: `Платёж в ${payment.amount.currency}; возврат должен быть в той же валюте.`,
        doc: '/payment-acceptance/after-the-payment/refunds',
      }),
    };
  }

  const authorized = payment.capturedKopecks ?? payment.kopecks;
  const refundable = authorized - (payment.refundedKopecks || 0);
  if (amountCheck.kopecks > refundable) {
    return {
      status: 400,
      body: yerr('invalid_request', {
        description: `Invalid parameter's value: refund amount ${amountCheck.amount.value} exceeds the refundable amount ${(refundable / 100).toFixed(2)}`,
        parameter: 'amount',
        hint: `Доступно к возврату: ${(refundable / 100).toFixed(2)} RUB (авторизовано минус уже возвращено). Частичные возвраты разрешены.`,
        doc: '/payment-acceptance/after-the-payment/refunds',
      }),
    };
  }

  if (body.description !== undefined && body.description !== null
      && (typeof body.description !== 'string' || Buffer.byteLength(body.description, 'utf8') > 128)) {
    return {
      status: 400,
      body: yerr('invalid_request', {
        description: 'Invalid parameter\'s value: description must be a string no longer than 128 characters',
        parameter: 'description',
        hint: 'Комментарий возврата — до 128 символов.',
        doc: '/payment-acceptance/after-the-payment/refunds',
      }),
    };
  }

  const nowMs = clock.now();
  const refund = {
    id: crypto.randomUUID(),
    payment_id: payment.id,
    status: REFUND_DELAY_MS > 0 ? 'pending' : 'succeeded',
    amount: amountCheck.amount,
    description: typeof body.description === 'string' ? body.description : null,
    metadata: body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? { ...body.metadata } : null,
    created_at: clock.iso(),
    refund_authorization_details: {
      rrn: String(crypto.randomInt(100000000000, 999999999999)),
    },
    // внутренние:
    kopecks: amountCheck.kopecks,
    finalizeAtMs: REFUND_DELAY_MS > 0 ? nowMs + REFUND_DELAY_MS : null,
    finishedAt: REFUND_DELAY_MS > 0 ? null : clock.iso(),
  };
  payment.refundedKopecks = (payment.refundedKopecks || 0) + amountCheck.kopecks;
  payment.refunded_amount = amountView(payment.refundedKopecks);
  state.refunds[refund.id] = refund;
  persist();
  console.log(`[mock] refund created: ${refund.id} -> payment ${payment.id} ${(amountCheck.kopecks / 100).toFixed(2)} RUB status=${refund.status}`);
  if (refund.status === 'succeeded') {
    scheduleWebhook('refund.succeeded', refundView(refund), { url: webhookUrlFor(payment), spec });
  }
  return { status: 200, body: refundView(refund) };
}

function handleGetRefund(id) {
  const refund = findRefund(id);
  if (!refund) return { status: 404, body: refundNotFound(id) };
  return { status: 200, body: refundView(refund) };
}

/* ------------------------------------------------------- confirmation page */

function page(body) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ЮKassa · Тестовая платежная форма (мок)</title>
<style>
  body{font:16px/1.5 -apple-system,'Segoe UI',Roboto,sans-serif;background:#f4f4f6;margin:0;display:flex;justify-content:center;padding:32px 12px}
  .card{background:#fff;border-radius:16px;max-width:430px;width:100%;padding:24px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
  .logo{font-weight:800;color:#fff;background:#f5474c;display:inline-block;border-radius:8px;padding:2px 10px;margin-bottom:8px}
  h1{font-size:20px;margin:0 0 4px}
  .muted{color:#777;font-size:13px;margin-bottom:16px}
  .sum{font-size:28px;font-weight:700;margin-bottom:16px}
  label{display:block;font-size:13px;color:#555;margin:10px 0 4px}
  input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ddd;border-radius:10px;font-size:16px}
  .cards{display:flex;flex-direction:column;gap:5px;margin-bottom:8px;max-height:220px;overflow:auto;border:1px dashed #eee;border-radius:10px;padding:8px}
  .cards label{display:flex;gap:8px;align-items:center;font-size:12px;color:#333;margin:0;cursor:pointer}
  button{width:100%;margin-top:14px;padding:13px;border:0;border-radius:12px;background:#f5474c;color:#fff;font-weight:700;font-size:16px;cursor:pointer}
  button.gray{background:#ececee;color:#333}
  .err{color:#c0392b;font-size:14px;margin-top:10px}
  .ok{color:#1e8e3e;font-size:14px;margin-top:10px}
</style></head><body><div class="card">${body}</div></body></html>`;
}

const esc = (v) => escapeHtml(v);

function sandboxFormSuffix() {
  const id = sandboxRuntime.currentId();
  return id && id !== 'default' ? `?sandbox=${encodeURIComponent(id)}` : '';
}

function formPage(payment, errorMsg) {
  const sfx = sandboxFormSuffix();
  const cardOptions = Object.entries(CARDS)
    .map(([pan, c]) => `<label><input type="radio" name="preset" value="${pan}" onchange="document.getElementById('pan').value='${pan}';document.getElementById('exp').value='1229';document.getElementById('cvv').value='123'"> ${esc(c.label)} <code>${pan.slice(0, 6)}**${pan.slice(-4)}</code></label>`)
    .join('');
  return page(`
    <span class="logo">Ю · мок</span>
    <h1>Оплата заказа</h1>
    <div class="muted">Тестовый стенд ЮKassa · платёж <code>${esc(payment.id)}</code></div>
    <div class="sum">${esc(payment.amount.value)} ₽</div>
    ${payment.description ? `<div class="muted">${esc(payment.description)}</div>` : ''}
    ${errorMsg ? `<div class="err">${esc(errorMsg)}</div>` : ''}
    <form method="POST" action="/payment/${payment.id}/pay${sfx}">
      <div class="cards">${cardOptions}</div>
      <label>Номер карты</label><input type="text" id="pan" name="pan" value="5555555555554444" required>
      <label>Срок (MMYY)</label><input type="text" id="exp" name="exp" value="1229" required>
      <label>CVC/CVV</label><input type="password" id="cvv" name="cvv" value="123" required>
      <button type="submit">Оплатить ${esc(payment.amount.value)} ₽</button>
    </form>
    <div class="muted">Платежи проводятся только по тестовым картам из списка. Форма — мок: данные карт не покидают стенд.</div>`);
}

function tdsPage(payment, errorMsg) {
  const sfx = sandboxFormSuffix();
  return page(`
    <span class="logo">Ю · мок</span>
    <h1>Подтверждение 3-D Secure</h1>
    <div class="muted">Платёж <code>${esc(payment.id)}</code> · тестовый ACS: любые цифры (≥4) проходят</div>
    ${errorMsg ? `<div class="err">${esc(errorMsg)}</div>` : ''}
    <form method="POST" action="/payment/${payment.id}/3ds${sfx}">
      <label>Код из SMS</label><input type="text" id="code" name="code" value="1234" required>
      <button type="submit">Подтвердить</button>
    </form>`);
}

function statusPage(payment) {
  const reason = payment.cancellation_details ? ` (${payment.cancellation_details.party}/${payment.cancellation_details.reason})` : '';
  return page(`
    <span class="logo">Ю · мок</span>
    <h1>${payment.status === 'succeeded' ? 'Оплата прошла успешно' : payment.status === 'waiting_for_capture' ? 'Средства удержаны' : 'Платёж завершён'}</h1>
    <div class="muted">Платёж <code>${esc(payment.id)}</code> · статус <b>${esc(payment.status)}</b>${esc(reason)}</div>
    <div class="sum">${esc(payment.amount.value)} ₽</div>
    <div class="muted">Вернитесь в магазин: статус можно проверить GET /v3/payments/${esc(payment.id)} или вебхуком.</div>`);
}

function donePage(payment) {
  return page(`
    <span class="logo">Ю · мок</span>
    <h1>Готово</h1>
    <div class="muted">Платёж <code>${esc(payment ? payment.id : '-')}</code>${payment ? ` · статус <b>${esc(payment.status)}</b>` : ''}</div>
    <div class="muted">return_url не задан — редиректа нет. Проверьте статус GET-ом или вебхуком.</div>`);
}

/* ------------------------------------------------------- form logic (pay) */

/**
 * Обработка введённых данных карты. Форматные ошибки (не цифры, кривой
 * срок/CVC) возвращаются как ошибка формы — платёж остаётся pending;
 * отказы по тестовым картам финализируют платёж с cancellation_details.
 */
function processCardPay(payment, rawPan, rawExp, rawCvv, spec) {
  const pan = String(rawPan || '').replace(/[\s-]/g, '');
  const exp = String(rawExp || '').trim();
  const cvv = String(rawCvv || '').trim();

  if (!/^\d{12,19}$/.test(pan)) return { stage: 'form', error: 'Номер карты: 12–19 цифр' };
  const expMatch = exp.match(/^(\d{2})(\d{2})$/);
  if (!expMatch) return { stage: 'form', error: 'Срок действия — 4 цифры (MMYY)' };
  const month = parseInt(expMatch[1], 10);
  if (!(month >= 1 && month <= 12)) return { stage: 'form', error: 'Неверный месяц срока действия' };
  if (!/^\d{3}$/.test(cvv)) return { stage: 'form', error: 'CVC/CVV — ровно 3 цифры' };
  const nowDate = new Date(clock.now());
  const expiryDate = new Date(2000 + parseInt(expMatch[2], 10), month, 1);
  if (expiryDate <= nowDate) {
    return finalizeDecline(payment, { party: 'payment_network', reason: 'card_expired', pan, month, year: expMatch[2], tds: false, spec });
  }

  const card = CARDS[pan];
  let outcome;
  if (card) {
    outcome = { ...card };
  } else if (luhnValid(pan)) {
    // Валидный, но не тестовый PAN: честный general_decline.
    outcome = { outcome: 'decline', reason: 'general_decline', tds: false };
  } else {
    outcome = { outcome: 'decline', reason: 'invalid_card_number', tds: false };
  }

  const cardData = {
    pan,
    month,
    year: expMatch[2],
    type: cardTypeOf(pan),
    tds: Boolean(outcome.tds),
    outcome: outcome.outcome,
    reason: outcome.reason || null,
  };

  if (cardData.tds) {
    // Отложить финализацию до POST /payment/{id}/3ds (challenge).
    payment.pending3ds = {
      pan: cardData.pan.slice(0, 6),
      last4: cardData.pan.slice(-4),
      month: cardData.month,
      year: cardData.year,
      type: cardData.type,
      outcome: cardData.outcome,
      reason: cardData.reason,
      tds: true,
      specRaw: spec ? spec.raw || '' : '',
    };
    persist();
    return { stage: '3ds' };
  }

  if (outcome.outcome === 'success') return finalizeSuccess(payment, cardData, { tds: false, spec });
  return finalizeDecline(payment, {
    party: declineParty(outcome.reason),
    reason: outcome.reason,
    pan: cardData.pan,
    month: cardData.month,
    year: cardData.year,
    tds: false,
    spec,
  });
}

/** POST /payment/{id}/3ds: ≥4 цифры — успех сценария карты. */
function process3ds(payment, rawCode, spec) {
  const code = String(rawCode || '').trim();
  if (!/^\d{4,}$/.test(code)) return { stage: '3ds', error: 'Код из SMS — минимум 4 цифры' };
  const pending = payment.pending3ds;
  if (!pending) return { stage: 'form', error: 'Сессия 3DS не найдена' };
  payment.pending3ds = null;
  // Сценарии webhook-drop/duplicate действовали на исходной оплате (форма);
  // для 3DS-запроса берём заголовок его собственного вызова.
  const effectiveSpec = spec && spec.raw ? spec : resolveRequestSpec({ target: 'pay', context: { paymentId: payment.id } }, null);

  if (pending.outcome === 'success') {
    return finalizeSuccess(payment, {
      pan: `${pending.pan}00000000${pending.last4}`,
      month: pending.month,
      year: pending.year,
      type: pending.type,
    }, { tds: true, spec: effectiveSpec });
  }
  // Отказная карта после аутентификации — по её честной причине.
  return finalizeDecline(payment, {
    party: declineParty(pending.reason),
    reason: pending.reason,
    pan: `${pending.pan}00000000${pending.last4}`,
    month: pending.month,
    year: pending.year,
    tds: true,
    spec: effectiveSpec,
  });
}

function buildPaymentMethod(pan, month, year) {
  const last4 = pan.slice(-4);
  return {
    type: 'bank_card',
    id: crypto.randomUUID(),
    saved: false,
    card: {
      first6: pan.slice(0, 6),
      last4,
      expiry_month: String(month).padStart(2, '0'),
      expiry_year: String(year),
      card_type: cardTypeOf(pan),
    },
    title: `Bank card *${last4}`,
  };
}

function finalizeSuccess(payment, { pan, month, year }, { tds, spec = null }) {
  payment.payment_method = buildPaymentMethod(pan, month, year);
  payment.authorization_details = {
    rrn: String(crypto.randomInt(100000000000, 999999999999)),
    auth_code: String(crypto.randomInt(100000, 999999)),
    three_d_secure: {
      applied: Boolean(tds),
      ...(tds ? { method_completed: true, challenge_completed: true } : {}),
    },
  };
  if (payment.captureRequested) {
    succeedPayment(payment, payment.kopecks, { spec });
  } else {
    payment.status = 'waiting_for_capture';
    payment.paid = true;
    payment.refundable = false;
    payment.holdExpiresAtMs = clock.now() + CAPTURE_TTL_MS;
    payment.expires_at = clock.iso(payment.holdExpiresAtMs);
    persist();
    scheduleWebhook('payment.waiting_for_capture', paymentView(payment), { url: webhookUrlFor(payment), spec });
    console.log(`[mock] payment ${payment.id} waiting_for_capture (hold until ${payment.expires_at})`);
  }
  return { stage: 'done', redirect: payment.confirmation.return_url };
}

function finalizeDecline(payment, { party, reason, pan, month, year, tds, spec = null }) {
  payment.payment_method = buildPaymentMethod(pan, month, year);
  if (tds) payment.authorization_details = { three_d_secure: { applied: true, method_completed: true, challenge_completed: false } };
  cancelPayment(payment, { party, reason }, { spec });
  return { stage: 'done', redirect: payment.confirmation.return_url };
}

/* ------------------------------------------------- scenario resolution */

/** Сценарий запроса: заголовок X-Mock-Scenario + правила /mock/scenarios. */
function resolveRequestSpec({ target, context = {} }, req = null) {
  const header = (req && req.headers && req.headers['x-mock-scenario']) || '';
  return scenarios.resolve({ header, target, context });
}

/* ----------------------------------------------------------- sandbox API */

/** Базовый URL песочницы для ответа POST /sandboxes (RFC-001 §6). */
function sandboxPublicUrl(id) {
  const base = String(MOCK_PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (SANDBOX_HOST_SUFFIX) {
    try {
      const u = new URL(base || 'http://localhost');
      return `${u.protocol}//${id}.${SANDBOX_HOST_SUFFIX}`;
    } catch { /* ignore */ }
  }
  return `${base}/?sandbox=${encodeURIComponent(id)}`;
}

/** Генерация кредов песочницы (RFC-001 §4): свои Basic-учётки у арендатора. */
function generateSandboxCreds(body = {}) {
  return {
    shopId: `SBX${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
    secretKey: core.randomToken(24),
  };
}

function handleSandboxApi(req, res, url, body, admission) {
  const operator = sandboxRuntime.isOperatorRequest(req);
  if (req.method === 'GET') {
    if (TENANCY === 'owned' && !operator) {
      const own = sandboxRuntime.recordByOwnerToken(req);
      if (!own) {
        return sendJson(res, yerr('invalid_credentials', {
          description: 'Sandbox list is available to the owner (owner-token) or operator only',
          hint: 'Owner-token выдаётся один раз при создании: POST /sandboxes.',
        }), 401);
      }
      return sendJson(res, { mode: TENANCY, current: own.id, sandboxes: [sandboxRuntime.describe(own)] });
    }
    return sendJson(res, { mode: TENANCY, current: sandboxRuntime.currentId(), sandboxes: sandboxRuntime.list() });
  }
  if (req.method === 'POST') {
    if (TENANCY === 'owned') {
      try {
        const created = sandboxRuntime.create({
          id: String((body && (body.sandbox || body.id)) || ''),
          creds: generateSandboxCreds(body || {}),
          profile: 'yookassa',
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
          hint: 'Сохраните ownerToken: он показывается один раз и даёт доступ к песочнице.',
        }, 201);
      } catch (e) {
        const status = e.code === 'SANDBOX_EXISTS' ? 409 : 429;
        return sendJson(res, yerr('invalid_request', {
          description: e.message,
          hint: 'Ограничения: MOCK_SANDBOX_MAX (количество), MOCK_SANDBOX_CREATE_LIMIT (созданий в час на IP).',
        }), status);
      }
    }
    const result = sandboxRuntime.switchActive((body && body.sandbox) || 'default');
    if (!result.ok) return sendJson(res, yerr('invalid_request', { description: `Failed to select sandbox: ${result.error}` }), 400);
    return sendJson(res, { ok: true, current: result.current, sandboxes: sandboxRuntime.list() });
  }
  if (req.method === 'DELETE') {
    const target = String((body && body.sandbox) || url.searchParams.get('sandbox') || '');
    if (!target) return sendJson(res, yerr('invalid_request', { description: 'Specify the sandbox to delete: ?sandbox=<id> or {"sandbox":"<id>"}' }), 400);
    const record = sandboxRuntime.find(target);
    if (!record) return sendJson(res, yerr('not_found', { description: `Sandbox "${target}" not found` }), 404);
    if (TENANCY === 'owned' && !operator && !sandboxRuntime.recordAuthorized(record, req)) {
      return sendJson(res, yerr('invalid_credentials', { description: `Only the sandbox owner (owner-token) or operator can delete "${target}"` }), 401);
    }
    const result = sandboxRuntime.remove(target, req);
    if (!result.ok) {
      if (result.error === 'unauthorized') {
        return sendJson(res, yerr('invalid_credentials', { description: `Only the sandbox owner (owner-token) or operator can delete "${target}"` }), 401);
      }
      return sendJson(res, yerr('invalid_request', { description: `Sandbox "${target}" cannot be deleted (default stand)` }), 400);
    }
    return sendJson(res, { ok: true, removed: result.removed });
  }
  return sendJson(res, yerr('invalid_request', { description: `Method ${req.method} is not supported for /sandboxes` }), 405);
}

/** RFC-001 §6: /sandboxes/me — своя песочница по owner-token. */
function handleSandboxMe(req, res, p, body) {
  const record = sandboxRuntime.recordByOwnerToken(req) || (TENANCY === 'owned' ? null : sandboxRuntime.current());
  if (!record) {
    return sendJson(res, yerr('invalid_credentials', {
      description: 'Sandbox owner-token is required',
      hint: 'Owner-token выдаётся один раз при создании: POST /sandboxes.',
    }), 401);
  }
  if (p === '/sandboxes/me' && req.method === 'GET') {
    return sendJson(res, { ok: true, mode: TENANCY, sandbox: sandboxRuntime.describe(record), creds: record.creds || null });
  }
  if (p === '/sandboxes/me/reset' && req.method === 'POST') {
    const result = sandboxRuntime.reset(record.id, req);
    return sendJson(res, { ok: true, sandbox: result.sandbox });
  }
  if (p === '/sandboxes/me/reset-creds' && req.method === 'POST') {
    const creds = generateSandboxCreds(body || {});
    sandboxRuntime.updateCreds(record.id, creds, req);
    return sendJson(res, { ok: true, sandbox: record.id, creds, ownerTokenChanged: false });
  }
  if (p === '/sandboxes/me' && req.method === 'DELETE') {
    const result = sandboxRuntime.remove(record.id, req);
    if (!result.ok) return sendJson(res, yerr('invalid_request', { description: 'The default sandbox cannot be deleted' }), 400);
    return sendJson(res, { ok: true, removed: result.removed });
  }
  return sendJson(res, yerr('invalid_request', { description: `Method ${req.method} is not supported for ${p}` }), 405);
}

/** Политика admission по маршруту (F-11/F-12, PA-54): неописанный маршрут — fail-closed 'business'. */
function sandboxPolicy(p) {
  if (p === '/health' || p === '/openapi.json' || p === '/sandboxes' || p.startsWith('/sandboxes/')) return 'public';
  if (p.startsWith('/admin') || p.startsWith('/mock/')) return 'control';
  if (p.startsWith('/payment/')) return 'form';
  if (p.startsWith('/v3/')) return 'business';
  return 'business';
}

/** DX-ответ на ошибку admission песочницы (F-12). */
function sendSandboxError(res, admission) {
  const id = admission.sandbox || 'default';
  if (admission.kind === 'not-found') {
    return sendJson(res, yerr('not_found', {
      description: `Sandbox "${id}" not found`,
      hint: 'Создайте песочницу: POST /sandboxes — в ответе будут id, creds и ownerToken. Список — GET /mock/sandboxes.',
    }), 404);
  }
  if (admission.kind === 'unauthorized') {
    return sendJson(res, yerr('invalid_credentials', {
      description: `Access to sandbox "${id}" is limited: knowing the id is not enough`,
      hint: 'Передайте owner-token: Authorization: Bearer <ownerToken>, X-Sandbox-Token или ?sandbox_token=.',
    }), 401);
  }
  if (admission.kind === 'expired') {
    return sendJson(res, yerr('not_found', {
      description: `Sandbox "${id}" has expired by TTL and was removed`,
      hint: 'Песочницы живут ограниченное время; создайте новую: POST /sandboxes.',
    }), 410);
  }
  if (admission.kind === 'rate-limit' || admission.kind === 'limit') {
    return sendJson(res, yerr('too_many_requests', {
      description: 'Sandbox creation limit reached',
      hint: 'Переиспользуйте существующий ID или поднимите MOCK_SANDBOX_CREATE_LIMIT / MOCK_SANDBOX_MAX.',
    }), 429);
  }
  return sendJson(res, yerr('internal_server_error', { description: 'Failed to resolve sandbox context' }), 500);
}

/* --------------------------------------------------------------- admin */

function controlSurface(p) {
  if (p.startsWith('/admin')) return 'admin';
  if (p.startsWith('/mock/')) return 'operator';
  return null;
}

function adminPage(req) {
  const currentSandbox = sandboxRuntime.currentId();
  const pageQuery = new URL(req.url, 'http://mock.local').searchParams;
  const adminQuery = new URLSearchParams();
  if (currentSandbox !== 'default') adminQuery.set('sandbox', currentSandbox);
  const adminToken = pageQuery.get('admin_token');
  if (adminToken) adminQuery.set('admin_token', adminToken);
  const sandboxToken = TENANCY === 'owned' ? sandboxRuntime.ownerTokenOf(req) : '';
  if (sandboxToken) adminQuery.set('sandbox_token', sandboxToken);
  const adminSuffix = adminQuery.toString();
  const adminActionUrl = `/admin/action${adminSuffix ? `?${adminSuffix}` : ''}`;
  const adminJournalUrl = `/admin/journal${adminSuffix ? `?${adminSuffix}` : ''}`;
  const csrfToken = core.createCsrfToken(ADMIN_CSRF_SECRET, currentSandbox);

  const payments = Object.values(state.payments)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 50)
    .map((p) => {
      const actions = [];
      if (p.status === 'pending') actions.push(btn('cancel-payment', p.id, 'отменить (merchant)', csrfToken, adminActionUrl));
      if (p.status === 'waiting_for_capture') {
        actions.push(btn('capture-payment', p.id, 'подтвердить (capture)', csrfToken, adminActionUrl));
        actions.push(btn('cancel-payment', p.id, 'отменить (merchant)', csrfToken, adminActionUrl));
      }
      const refundInfo = p.refundedKopecks ? ` · возвраты ${(p.refundedKopecks / 100).toFixed(2)}` : '';
      const cancelInfo = p.cancellation_details ? ` · ${esc(p.cancellation_details.party)}/${esc(p.cancellation_details.reason)}` : '';
      return `<tr><td><code>${esc(p.id)}</code></td><td>${esc(p.created_at)}</td><td>${esc(p.amount.value)} ${esc(p.amount.currency)}</td><td><b>${esc(p.status)}</b>${cancelInfo}${refundInfo}</td><td>${p.paid ? 'да' : 'нет'}</td><td>${actions.join(' ')}</td></tr>`;
    })
    .join('') || '<tr><td colspan="6">платежей нет</td></tr>';

  const refunds = Object.values(state.refunds)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 30)
    .map((r) => `<tr><td><code>${esc(r.id)}</code></td><td><code>${esc(r.payment_id)}</code></td><td>${esc(r.amount.value)} ${esc(r.amount.currency)}</td><td><b>${esc(r.status)}</b></td><td>${esc(r.created_at)}</td></tr>`)
    .join('') || '<tr><td colspan="5">возвратов нет</td></tr>';

  const notifs = Object.values(state.notifications)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .slice(-25)
    .reverse()
    .map((n) => {
      const st = n.suppressed ? 'suppressed' : n.dumped ? 'dumped' : n.done ? 'delivered' : `retry@${new Date(n.nextAttemptAt || clock.now()).toISOString().slice(11, 19)}`;
      return `<tr><td><code>${esc(n.id)}</code></td><td>${esc(n.event)}</td><td>${n.attempts}</td><td>${esc(st)}</td><td>${esc(n.lastStatus ?? '—')} ${esc(String(n.lastBody ?? '').slice(0, 40))}</td><td>${btn('duplicate-notification', n.id, 'повторить', csrfToken, adminActionUrl)}</td></tr>`;
    })
    .join('') || '<tr><td colspan="6">вебхуков нет</td></tr>';

  const journalRows = journal.list().slice(-15).reverse()
    .map((e) => `<tr><td>${esc(String(e.at).slice(11, 19))}</td><td>${esc(e.method)}</td><td><code>${esc(e.path)}</code></td><td><code>${esc(Object.entries(e.body || {}).map(([k, v]) => `${k}=${v}`).join(' '))}</code></td><td>${e.status}</td><td>${e.ms} мс</td><td><code style="font-size:10px">${esc(String(e.curl || '').slice(0, 70))}…</code></td></tr>`)
    .join('') || '<tr><td colspan="7">запросов ещё не было</td></tr>';

  return page(`
    <span class="logo">Ю · мок</span>
    <h1>Консоль стенда ЮKassa</h1>
    <div class="muted">shopId <code>${esc(shopId())}</code> · ретраи ${Math.round(RETRY_MS / 1000)}с × ${MAX_ATTEMPTS} · виртуальное время <code>${esc(clock.iso())}</code> · sandbox <code>${esc(currentSandbox)}</code></div>
    <div style="background:#fff8e1;border:1px solid #f0d47a;border-radius:10px;padding:8px 10px;margin-bottom:10px;font-size:13px">⚠ Оплата — <b>только по тестовым картам</b> со страницы платежа (пресеты есть на форме). Секреты и PAN в журнал не попадают.</div>
    <div class="muted">Обновлено ${new Date(clock.now()).toLocaleTimeString('ru-RU')}</div>
    <h1 style="font-size:16px">Платежи (последние 50)</h1>
    <table border="0" cellpadding="4" style="font-size:13px;width:100%">${payments}</table>
    <h1 style="font-size:16px">Возвраты (последние 30)</h1>
    <table border="0" cellpadding="4" style="font-size:13px;width:100%">${refunds}</table>
    <h1 style="font-size:16px">Вебхуки (последние 25)</h1>
    <table border="0" cellpadding="4" style="font-size:12px;width:100%">${notifs}</table>
    <h1 style="font-size:16px">Журнал /v3 (последние 15) — <a href="${esc(adminJournalUrl)}">json</a></h1>
    <table border="0" cellpadding="4" style="font-size:12px;width:100%">${journalRows}</table>`, true);
}

function btn(action, id, label, csrfToken, actionUrl) {
  return `<form method="POST" action="${esc(actionUrl)}" style="display:inline"><input type="hidden" name="_csrf" value="${esc(csrfToken)}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="id" value="${esc(id)}"><button style="width:auto;margin:2px;padding:6px 10px;font-size:12px" type="submit">${esc(label)}</button></form>`;
}

function adminAction(body) {
  const { action, id } = body;
  if (action === 'cancel-payment') {
    const payment = findPayment(id);
    if (payment && (payment.status === 'pending' || payment.status === 'waiting_for_capture')) {
      cancelPayment(payment, { party: 'merchant', reason: 'canceled_by_merchant' });
    }
  } else if (action === 'capture-payment') {
    const payment = findPayment(id);
    if (payment && payment.status === 'waiting_for_capture') {
      succeedPayment(payment, payment.capturedKopecks ?? payment.kopecks);
    }
  } else if (action === 'duplicate-notification') {
    const n = state.notifications[String(id)];
    if (n) {
      const copy = {
        ...n,
        id: String(state.counters.notificationId++),
        attempts: 0,
        nextAttemptAt: 0,
        lastStatus: null,
        lastBody: null,
        finishedAt: null,
        dumped: false,
        done: false,
        suppressed: false,
        createdAt: clock.iso(),
      };
      state.notifications[copy.id] = copy;
      persist();
    }
  }
  return { redirect: '/admin' };
}

/** Выжимка запроса для журнала (секреты/PAN редактирует ядро). */
function bodySummary(body) {
  if (!body || typeof body !== 'object') return {};
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(body)) {
    if (count >= 8) break;
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      out[key] = Array.isArray(value) ? `[${value.length}]` : '{…}';
    } else {
      out[key] = String(value).slice(0, 60);
    }
    count += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ http */

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const raw = await readBody(req);
  const body = parseBody(raw, req.headers['content-type']);

  // F-11/F-12: контекст песочницы резолвится один раз до бизнес-логики.
  const admission = sandboxRuntime.admit(req, sandboxPolicy(p));
  if (!admission.ok) return sendSandboxError(res, admission);
  return sandboxRuntime.run(admission, () => routeRequest(req, res, url, p, raw, body, admission));
}

async function routeRequest(req, res, url, p, raw, body, admission) {
  // Единый access-control управляющей поверхности (F-07, PA-50).
  const surface = controlSurface(p);
  const ownerRec = sandboxRuntime.recordByOwnerToken(req);
  const ownerSurface = surface === 'operator'
    && Boolean(ownerRec && admission.record && ownerRec.id === admission.record.id);
  if (surface && admission.via !== 'owner' && !ownerSurface) {
    const access = checkControlAccess(req, {
      adminToken: MOCK_ADMIN_TOKEN,
      operatorToken: OPERATOR_TOKEN,
      surface,
      hosted: HOSTED,
    });
    if (!access.allowed) {
      const envName = surface === 'admin' ? 'MOCK_ADMIN_TOKEN' : 'MOCK_OPERATOR_TOKEN';
      const message = access.reason === 'hosted-fail-closed'
        ? `Route ${p} is closed: hosted mode (MOCK_HOSTED) requires ${envName} for the control surface`
        : `Access to the control route ${p} is restricted: ${envName} is required`;
      return sendJson(res, yerr('invalid_credentials', {
        description: message,
        hint: `Передайте токен: Authorization: Bearer <${envName}> или X-Operator-Token/X-Admin-Token.`,
      }), 401);
    }
  }

  const isV3 = p.startsWith('/v3');

  // Журнал только /v3-вызовов (страницы формы и поллинг /admin не шумят).
  if (isV3) {
    const started = Date.now();
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (code, ...rest) => {
      journal.record({
        method: req.method,
        path: p,
        status: code,
        ms: Date.now() - started,
        body: bodySummary(body),
        rawBody: raw,
        headers: req.headers,
        baseUrl: MOCK_PUBLIC_BASE_URL,
      });
      return originalWriteHead(code, ...rest);
    };

    // Сетевые сбои ядра: X-Mock-Latency / X-Mock-Scenario: latency, http-500, http-504.
    const chaosSpec = parseScenarioSpec(req.headers['x-mock-scenario'] || '');
    const chaosResult = await applyRequestChaos(req, chaosSpec);
    sandboxRuntime.current(); // PA-50 §7.2: fail-closed при истечении/удалении песочницы во время await
    if (chaosResult.abortStatus) {
      return sendJson(res, yerr('internal_server_error', {
        description: chaosResult.abortMessage,
        hint: 'Сценарий X-Mock-Scenario: http-500|http-504 (сеть/шлюз) — задержки: latency:<время>.',
        doc: '',
      }), chaosResult.abortStatus);
    }
  }

  if (req.method === 'GET' && p === '/health') {
    const health = { ok: true, sandbox: sandboxRuntime.currentId(), tenancy: TENANCY };
    if (TENANCY !== 'owned' || (admission.record.isDefault && !admission.record.ownerTokenHash) || admission.via === 'owner' || admission.via === 'operator') {
      Object.assign(health, {
        payments: Object.keys(state.payments).length,
        refunds: Object.keys(state.refunds).length,
      });
    }
    return sendJson(res, health);
  }
  if (req.method === 'GET' && p === '/admin/journal') return sendJson(res, { entries: journal.list() });

  // ── RFC-001 §6: управление песочницами ──
  if (p === '/sandboxes' || p === '/mock/sandboxes') {
    return handleSandboxApi(req, res, url, body, admission);
  }
  if (p.startsWith('/sandboxes/')) {
    return handleSandboxMe(req, res, p, body);
  }

  if (p === '/mock/reset' && req.method === 'POST') {
    const target = (body && body.sandbox) || admission.record.id;
    const resetName = sandboxRuntime.reset(target, req);
    if (!resetName.ok) {
      return sendSandboxError(res, { ok: false, kind: resetName.error || 'unauthorized', sandbox: resetName.sandbox || target });
    }
    clearSandboxChildState(sandboxRuntime.find(target));
    return sendJson(res, { ok: true, sandbox: resetName.sandbox || target });
  }

  if (p === '/mock/state') {
    if (req.method === 'GET') {
      const targetSandbox = url.searchParams.get('sandbox') || undefined;
      const snapshot = targetSandbox ? sandboxRuntime.exportState(targetSandbox, req) : sandboxRuntime.exportState(null, req);
      if (snapshot && snapshot.ok === false) {
        return sendSandboxError(res, { ok: false, kind: snapshot.error || 'unauthorized', sandbox: snapshot.sandbox || targetSandbox || admission.record.id });
      }
      return sendJson(res, {
        sandbox: snapshot.sandbox || admission.record.id,
        state: snapshot,
      });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      if (raw.trim() && String(req.headers['content-type'] || '').includes('application/json')) {
        try { JSON.parse(raw); } catch {
          return sendJson(res, yerr('invalid_request', {
            description: 'The state snapshot body is not valid JSON',
            hint: 'Передайте экспорт /mock/state без редактирования опасных ключей __proto__, constructor и prototype.',
          }), 400);
        }
      }
      const targetSandbox = (body && body.sandbox) || admission.record.id;
      const snapshot = (body && body.state) || body || {};
      try {
        const imported = sandboxRuntime.importState(snapshot, targetSandbox, req);
        if (!imported.ok) {
          return sendSandboxError(res, { ok: false, kind: imported.error || 'unauthorized', sandbox: imported.sandbox || targetSandbox });
        }
        return sendJson(res, { ok: true, sandbox: imported.sandbox });
      } catch (e) {
        return sendJson(res, yerr('invalid_request', {
          description: `Invalid state snapshot: ${e.message}`,
          hint: 'Исправьте снимок и повторите импорт; ключи __proto__, constructor и prototype запрещены.',
        }), 400);
      }
    }
  }

  if (p === '/mock/time') {
    if (req.method === 'GET') return sendJson(res, clock.snapshot());
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        const snap = clock.set(body || {});
        tickYookassa();
        await deliveryQueue.tick();
        return sendJson(res, snap);
      } catch (e) {
        return sendJson(res, yerr('invalid_request', { description: e.message, hint: 'Поля: advance ("+7d"), offset (мс), iso (дата).' }), 400);
      }
    }
  }

  if (p === '/mock/scenarios') {
    if (req.method === 'GET') {
      return sendJson(res, { rules: scenarios.listRules(), history: scenarios.listHistory() });
    }
    if (req.method === 'POST') {
      try {
        const rule = scenarios.addRule(body || {});
        return sendJson(res, { ok: true, rule });
      } catch (e) {
        return sendJson(res, yerr(e && e.code ? e.code : 'invalid_request', { description: e.message, hint: 'Поля: scenario (обязательно), target ("*"), match, times/persistent.' }), 400);
      }
    }
    if (req.method === 'DELETE') {
      scenarios.clearRules();
      scenarios.clearHistory();
      return sendJson(res, { ok: true, rules: [], history: [] });
    }
  }

  // ── confirmation-страница (hosted payment form, capability-ссылка) ──
  const formMatch = p.match(/^\/payment\/([A-Za-z0-9-]+)$/);
  if (formMatch && req.method === 'GET') {
    const payment = findPayment(decodeURIComponent(formMatch[1]));
    if (!payment) return send(res, 404, 'Платёж не найден');
    if (payment.status === 'pending') return html(res, payment.pending3ds ? tdsPage(payment, null) : formPage(payment, null));
    return html(res, statusPage(payment));
  }

  const payMatch = p.match(/^\/payment\/([A-Za-z0-9-]+)\/pay$/);
  if (payMatch && req.method === 'POST') {
    const payment = findPayment(decodeURIComponent(payMatch[1]));
    if (!payment || payment.status !== 'pending') return send(res, 404, 'Сессия оплаты не найдена или уже завершена');
    const spec = scenarios.resolve({
      header: req.headers['x-mock-scenario'] || '',
      target: 'pay',
      context: { paymentId: payment.id },
    });
    const result = processCardPay(payment, body.pan, body.exp, body.cvv, spec);
    if (result.stage === 'form') return html(res, formPage(payment, result.error));
    if (result.stage === '3ds') return html(res, tdsPage(payment, null));
    return send(res, 302, '', { Location: result.redirect });
  }

  const tdsMatch = p.match(/^\/payment\/([A-Za-z0-9-]+)\/3ds$/);
  if (tdsMatch && req.method === 'POST') {
    const payment = findPayment(decodeURIComponent(tdsMatch[1]));
    if (!payment || payment.status !== 'pending') return send(res, 404, 'Сессия оплаты не найдена или уже завершена');
    const spec = scenarios.resolve({
      header: req.headers['x-mock-scenario'] || '',
      target: 'pay',
      context: { paymentId: payment.id },
    });
    const result = process3ds(payment, body.code, spec);
    if (result.stage === '3ds') return html(res, tdsPage(payment, result.error));
    return send(res, 302, '', { Location: result.redirect });
  }

  const doneMatch = p.match(/^\/payment\/([A-Za-z0-9-]+)\/done$/);
  if (doneMatch && req.method === 'GET') {
    const payment = findPayment(decodeURIComponent(doneMatch[1]));
    return html(res, donePage(payment));
  }

  if (p === '/admin' && req.method === 'GET') {
    return send(res, 200, adminPage(req), {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, private',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
  }

  if (p === '/admin/action' && req.method === 'POST') {
    if (!core.isSameOriginRequest(req)
        || !core.verifyCsrfToken(body && body._csrf, ADMIN_CSRF_SECRET, sandboxRuntime.currentId())) {
      return send(res, 403, 'Forbidden: invalid or missing CSRF token', {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    }
    const result = adminAction(body);
    const postQuery = new URL(req.url, 'http://mock.local').searchParams;
    const redirectQuery = new URLSearchParams();
    const currentSandbox = sandboxRuntime.currentId();
    if (currentSandbox !== 'default') redirectQuery.set('sandbox', currentSandbox);
    const adminToken = postQuery.get('admin_token');
    if (adminToken) redirectQuery.set('admin_token', adminToken);
    const sandboxToken = postQuery.get('sandbox_token');
    if (sandboxToken) redirectQuery.set('sandbox_token', sandboxToken);
    const redirectSuffix = redirectQuery.toString();
    return send(res, 302, '', { Location: `${result.redirect}${redirectSuffix ? `?${redirectSuffix}` : ''}` });
  }

  // ── YooKassa API /v3 ──
  if (isV3) {
    return handleV3(req, res, p, raw, body);
  }

  return send(res, 404, 'not found');
}

/**
 * Маршрутизация /v3: Basic Auth -> 415 -> роутинг -> (POST) идемпотентность
 * -> сценарии fail/hang -> бизнес. Ошибки — в формате ЮKassa; 405/415 —
 * пустое тело (официальный response-handling; см. шапку файла).
 */
async function handleV3(req, res, p, raw, body) {
  const authError = verifyBasicAuth(req);
  if (authError) {
    res.setHeader('WWW-Authenticate', 'Basic realm="api.yookassa.ru", charset="UTF-8"');
    return sendJson(res, authError, 401);
  }

  const isPost = req.method === 'POST';
  const contentType = String(req.headers['content-type'] || '');
  if (isPost && contentType && !contentType.includes('application/json')) {
    // Официально 415 без тела; DX-слой эти два кода не покрывает (решение координатора).
    return send(res, 415, '', { 'Content-Type': 'application/json; charset=utf-8' });
  }
  if (isPost && raw.trim() && String(req.headers['content-type'] || '').includes('application/json')) {
    try { JSON.parse(raw); } catch {
      return sendJson(res, yerr('invalid_request', {
        description: 'Request body is not valid JSON',
        hint: 'Content-Type: application/json и корректный JSON в теле; пустое тело для POST не принимается.',
        doc: '/using-api/interaction-format',
      }), 400);
    }
  }

  /* --------- маршруты --------- */

  if (p === '/v3/payments' && isPost) return sendV3(req, res, p, raw, body, 'payments', handleCreatePayment, body);
  if (p === '/v3/payments' && req.method === 'GET') {
    const items = Object.values(state.payments)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map(paymentView);
    return sendJson(res, { type: 'list', items, next_cursor: null });
  }

  const payOp = p.match(/^\/v3\/payments\/([^/]+)\/(capture|cancel)$/);
  if (payOp && isPost) {
    const payment = findPayment(decodeURIComponent(payOp[1]));
    if (!payment) return sendJson(res, paymentNotFound(payOp[1]), 404);
    if (payOp[2] === 'capture') {
      return sendV3(req, res, p, raw, body, 'capture', handleCapturePayment, payment, body);
    }
    return sendV3(req, res, p, raw, body, 'cancel', handleCancelPayment, payment);
  }
  const payGet = p.match(/^\/v3\/payments\/([^/]+)$/);
  if (payGet && req.method === 'GET') {
    const result = handleGetPayment(decodeURIComponent(payGet[1]));
    return sendJson(res, result.body, result.status);
  }

  if (p === '/v3/refunds' && isPost) return sendV3(req, res, p, raw, body, 'refunds', handleCreateRefund, body);
  if (p === '/v3/refunds' && req.method === 'GET') {
    const items = Object.values(state.refunds)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map(refundView);
    return sendJson(res, { type: 'list', items, next_cursor: null });
  }
  const refGet = p.match(/^\/v3\/refunds\/([^/]+)$/);
  if (refGet && req.method === 'GET') {
    const result = handleGetRefund(decodeURIComponent(refGet[1]));
    return sendJson(res, result.body, result.status);
  }

  // Известный ресурс, но не тот метод — официально 405 с пустым телом.
  if (/^\/v3\/payments(\/|$)/.test(p) || /^\/v3\/refunds(\/|$)/.test(p)) {
    return send(res, 405, '', { Allow: 'GET, POST', 'Content-Type': 'application/json; charset=utf-8' });
  }

  // Неизвестный маршрут — provider-shaped 404 (JSON, как в документации).
  return sendJson(res, yerr('not_found', {
    description: `Unknown API path: ${req.method} ${p}`,
    hint: 'Реализованы: POST/GET /v3/payments[/{id}], POST .../capture|cancel, POST/GET /v3/refunds[/{id}].',
    doc: '/using-api',
  }), 404);
}

/**
 * Общий конвейер POST /v3: идемпотентность (заголовок, replay, запись),
 * сценарии fail/hang, вызов обработчика, отправка ответа.
 */
async function sendV3(req, res, p, raw, body, target, handler, ...handlerArgs) {
  const idem = idempotenceHeaderError(req);
  if (idem.error) return sendJson(res, idem.error, 400);

  const scope = idempotencyScope(req, p);
  const lookup = idempotencyLookup(idem.key, scope, raw);
  if (lookup.error) return sendJson(res, lookup.error, 400);
  if (lookup.replay) {
    res.setHeader('X-Idempotence-Replayed', '1');
    return sendJson(res, lookup.replay.body, lookup.replay.status);
  }

  const spec = scenarios.resolve({
    header: req.headers['x-mock-scenario'] || '',
    bodyScenario: typeof body.mock_scenario === 'string' ? body.mock_scenario : '',
    target,
    context: { path: p },
  });

  // hang: запрос не должен получить ответа (клиент ждёт/таймаутит).
  if (spec.has('hang')) {
    await new Promise(() => {});
    return;
  }
  // fail: provider-shaped 500 (бизнес не выполняется).
  if (spec.has('fail')) {
    const failure = yerr('internal_server_error', {
      description: 'Simulated failure (X-Mock-Scenario: fail)',
      hint: 'Сценарий fail: мок сымитировал внутреннюю ошибку провайдера.',
      doc: '',
    });
    return sendJson(res, failure, 500);
  }

  const final = await handler(...handlerArgs, spec);
  idempotencyStore(idem.key, scope, raw, final);
  return sendJson(res, final.body, final.status);
}

/* --------------------------------------------------------- server/ticker */

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (e && e.code === 'SANDBOX_EXPIRED') {
      try { sendSandboxError(res, { ok: false, kind: 'expired', sandbox: e.sandbox || 'default' }); } catch { /* headers sent */ }
      return;
    }
    if (e && e.code === 'BODY_TOO_LARGE') {
      try {
        sendJson(res, yerr('invalid_request', {
          description: 'Request body exceeds the size limit',
          hint: `Уменьшите тело запроса до ${e.maxBytes} байт или менее.`,
        }), 413);
      } catch { /* headers sent */ }
      return;
    }
    console.error('[mock] request error:', e);
    try { sendJson(res, yerr('internal_server_error', { description: 'Internal server error' }), 500); } catch { /* headers sent */ }
  });
});

// Тик обслуживает КАЖДУЮ песочницу в её контексте: очередь вебхуков,
// TTL холдов/pending и финализация возвратов не смешивают состояния (F-11).
setInterval(() => {
  sandboxRuntime.tickAll(() => {
    deliveryQueue.tick().catch((e) => console.error('[mock] delivery loop:', e.message));
    tickYookassa();
  });
}, 1000).unref();

// Воркер TTL/лимитов (RFC-001 §8).
const SANDBOX_SWEEP_MS = parseMsOr(process.env.MOCK_SANDBOX_SWEEP_MS, 60000);
if (SANDBOX_TTL_MS > 0 || SANDBOX_MAX_DOCUMENTS > 0 || SANDBOX_RETENTION_MS > 0) {
  setInterval(() => {
    const result = sandboxRuntime.sweep();
    if (result.expired) log(`[mock] sandbox sweep: удалено по TTL — ${result.expired}`);
  }, Math.max(1000, SANDBOX_SWEEP_MS)).unref();
}

restore();

if (require.main === module) {
  server.listen(parseInt(MOCK_PORT, 10), MOCK_HOST, () => {
    const port = server.address().port; // MOCK_PORT=0 -> реальный порт
    console.log(`[mock] YooKassa mock on http://${MOCK_HOST}:${port}`);
    console.log(`[mock] basic auth: shopId=${SHOP_ID} secret=${SECRET_KEY} (тестовые креды, MOCK_SHOP_ID/MOCK_SECRET_KEY переопределяют)`);
    console.log(`[mock] tenancy=${TENANCY} public_base=${MOCK_PUBLIC_BASE_URL}`);
    console.log(`[mock] webhooks: retry ${RETRY_MS}ms x${MAX_ATTEMPTS}${process.env.MOCK_DEFAULT_WEBHOOK_URL ? `, default ${process.env.MOCK_DEFAULT_WEBHOOK_URL}` : ', default none'} (ACK=200)`);
    console.log(`[mock] ttls: hold=${CAPTURE_TTL_MS}ms pending=${PENDING_TTL_MS}ms refund_delay=${REFUND_DELAY_MS}ms`);
    console.log(`[mock] control-plane: admin_token=${MOCK_ADMIN_TOKEN ? 'on' : 'off'} operator_token=${OPERATOR_TOKEN ? 'on' : 'off'} hosted=${HOSTED} block_private_webhooks=${BLOCK_PRIVATE_WEBHOOKS}`);
    console.log(`[mock] sandboxes: mode=${TENANCY} ttl_ms=${SANDBOX_TTL_MS} max=${SANDBOX_MAX} max_documents=${SANDBOX_MAX_DOCUMENTS} host_suffix=${SANDBOX_HOST_SUFFIX || '-'} registry=${sandboxRuntime.stats().file || 'memory'}${TENANCY === 'owned' && !SANDBOX_OWNER_TOKEN ? ' (default-песочница открыта: задайте MOCK_SANDBOX_TOKEN, чтобы закрыть)' : ''}`);
  });
}

module.exports = {
  server, state, clock, scenarios, route, persist, restore, sandboxRuntime,
  SHOP_ID, SECRET_KEY, CARDS, handleV3, tickYookassa,
};
