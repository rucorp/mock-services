// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * first-ofd-mock — мок «облачной кассы OKassa» Первого ОФД (Stage 2, issue #92).
 *
 * Контракт (срез 2026-10-11, docs/reference/first-ofd/*): тестовый контур
 * https://external-api-farm.1-ofd-test.ru, асинхронная ОЧЕРЕДЬ заявок на чек.
 *
 * Аутентификация: POST /getToken с Content-Type: application/json; charset=utf-8
 * и телом {login, pass}; ответ {token}; далее Authorization: Bearer <token>.
 * Токен живёт 24 ч на ВИРТУАЛЬНЫХ часах стенда. API-ключ UUID сам по себе
 * bearer-токеном не является.
 *
 * Очередь: POST /api/external/queue/v1/transaction/{type} с
 * type ∈ {receipt, receiptCorrection, openShift, closeShift, currentStateReport}
 * возвращает requestId, а не финальный фискальный результат. Схема СТРОГО по
 * типу заявки: ReceiptRequest (обязательны cashboxParameters.userInn,
 * requestMetadata.userGroup, document.operationType|items|totalSum),
 * ReceiptCorrectionRequest (+ document.correctionCause) и StateCommandRequest
 * для смен/отчёта (receipt-тело в openShift/closeShift/currentStateReport
 * отклоняется). Операции чека — INCOME, INCOME_RETURN, EXPENCE,
 * EXPENCE_RETURN: написание сохранено КАК В СХЕМЕ (EXPENCE, не EXPENSE).
 * Ставки НДС включают VAT_22 и VAT_22122.
 *
 * Сверка: GET transaction/{requestId} (заявка + результат), GET status/{requestId}
 * (результат), GET statuses?externalId=&groupId=[&status], GET receipts?from=&to=
 * (фискальные документы за период, а не состояние заявки).
 * Статусы очереди: IN_PROGRESS → COMPLETED | ERROR. Результат содержит
 * requestId, transactionType, errorCode, errorType, details, payload; ошибки двух
 * слоёв (API очереди и ККТ) сохраняются раздельно. Обработка заявки занимает
 * MOCK_FIRST_OFD_PROCESS_MS на виртуальных часах.
 *
 * Callback: POST на requestMetadata.callbackUrl после обработки. Публичные
 * manual/OpenAPI НЕ фиксируют envelope, подпись, обязательный ACK и расписание
 * повторов — мок не выдумывает ни HMAC, ни RSA: подписи нет вообще, доставка
 * идёт через core-очередь, а условие ACK «2xx», график ретраев и форма
 * уведомления — локальная договорённость мока [FORK], а не утверждение о
 * протоколе. Источник истины после уведомления — GET status/{requestId}.
 *
 * externalId: правила дедупликации/срока хранения публично НЕ подтверждены.
 * Повтор с тем же externalId в той же группе создаёт НОВУЮ заявку (новый
 * requestId) — поведение мока зафиксировано детерминированно и помечено [VERIFY];
 * для сверки сохраняйте выданный requestId.
 *
 * Вне области: Ferma/АТОЛ-совместимость, тег ATOL Online V5 из тестового
 * swagger Первого ОФД, production base и реальные креды, подпись/ретраи
 * callback, правила сверки сумм, не описанные в схеме.
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

const log = core.createLog('first-ofd-mock');

const {
  MOCK_HOST = '0.0.0.0',
  MOCK_PORT = '3107',
  MOCK_FIRST_OFD_LOGIN = '',
  MOCK_FIRST_OFD_PASS = '',
  MOCK_FIRST_OFD_TOKEN_TTL_SECS = '86400',
  MOCK_FIRST_OFD_TOKEN_SINGLE = '',
  MOCK_FIRST_OFD_PROCESS_MS = '2000',
  MOCK_FIRST_OFD_PUBLIC_BASE_URL = '',
  MOCK_FIRST_OFD_CALLBACK_URL = '',
  MOCK_FIRST_OFD_CALLBACK_RETRY_MS = '60000',
  MOCK_FIRST_OFD_CALLBACK_MAX_ATTEMPTS = '3',
  MOCK_FIRST_OFD_CALLBACK_HTTPS_ONLY = '',
  MOCK_FIRST_OFD_USER_GROUPS = '',
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

/* Синтетические дефолты: реальные тестовые login/API-key Первого ОФД публично
 * не опубликованы (docs/reference/first-ofd/02-test-and-open-issues.md) и
 * выдаются в тестовом ЛК. Значения ниже — креды МОКА, не реквизиты провайдера. */
const DEFAULT_LOGIN = 'firstofdmocktest';
const DEFAULT_PASS = '11111111-2222-4333-8444-555555555555';
const LOGIN_CRED = String(MOCK_FIRST_OFD_LOGIN || DEFAULT_LOGIN);
const PASS_CRED = String(MOCK_FIRST_OFD_PASS || DEFAULT_PASS);
const credLogView = (actual, dflt) => (actual === dflt ? dflt : '<задан через env, скрыт>');

const PUBLIC_BASE_URL = String(MOCK_FIRST_OFD_PUBLIC_BASE_URL || '').trim()
  || `http://localhost:${MOCK_PORT}`;
const DEFAULT_CALLBACK_URL = String(MOCK_FIRST_OFD_CALLBACK_URL || '').trim();
const CALLBACK_HTTPS_ONLY = core.flagEnabled(MOCK_FIRST_OFD_CALLBACK_HTTPS_ONLY);
const TOKEN_SINGLE = core.flagEnabled(MOCK_FIRST_OFD_TOKEN_SINGLE);
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

/* Пути среза. Строки используются маршрутизатором, OpenAPI и check:drift. */
const API_BASE = '/api/external/';
const QUEUE_BASE = '/api/external/queue/v1/';
const TOKEN_PATH = '/getToken';
const RECEIPTS_PATH = '/api/external/receipts';

const TOKEN_TTL_DEFAULT_SECS = 86400;  // 24 ч — срок жизни токена по срезу.
const PROCESS_DEFAULT_MS = 2000;             // задержка очереди на виртуальных часах (мок).
const CALLBACK_RETRY_MS_DEFAULT = 60000;     // локальный график мока [FORK].
const CALLBACK_MAX_ATTEMPTS_DEFAULT = 3;     // локальный график мока [FORK].

/* Mock safety caps: точные upstream-границы в срезе не зафиксированы. */
const INN_LENGTHS = [10, 12];
const MAX_AMOUNT_KOPEKS = 99999999999; // 999 999 999.99 ₽
const MAX_ITEMS = 100;
const MAX_LABEL = 256;
const MAX_MEASUREMENT_UNIT = 64;
const MAX_QUANTITY_DECIMALS = 3;
const MAX_TEXT = 512;
const MAX_EXTERNAL_ID = 128;
const MAX_GROUP_ID = 128;
const CALLBACK_URL_MAX = 2048;
const RECEIPTS_PAGE_SIZE_DEFAULT = 20;
const RECEIPTS_PAGE_SIZE_MAX = 100;

/** Числовой env читается целиком: суффикс времени поддержан, мусор не обрезается. */
function envDurationMs(name, raw, fallback, { min = 0 } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  const value = core.parseDuration(text);
  if (value === null || !Number.isFinite(value)) {
    log(`WARN ${name}=${JSON.stringify(text)} не разобран — используется ${fallback} мс (число или длительность, например '2s'/'1m')`);
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
    log(`WARN ${name}=${JSON.stringify(text)} не разобран — используется ${fallback} с (секунды либо длительность вида '1h'/'24h')`);
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
    log(`WARN ${name}=${JSON.stringify(text)}: 0 попыток не определено — используется 1`);
    return 1;
  }
  return value;
}

const TOKEN_TTL_SECS = envSeconds('MOCK_FIRST_OFD_TOKEN_TTL_SECS', MOCK_FIRST_OFD_TOKEN_TTL_SECS, TOKEN_TTL_DEFAULT_SECS);
const PROCESS_MS = envDurationMs('MOCK_FIRST_OFD_PROCESS_MS', MOCK_FIRST_OFD_PROCESS_MS, PROCESS_DEFAULT_MS);
const CALLBACK_RETRY_MS = envDurationMs('MOCK_FIRST_OFD_CALLBACK_RETRY_MS', MOCK_FIRST_OFD_CALLBACK_RETRY_MS, CALLBACK_RETRY_MS_DEFAULT);
const CALLBACK_MAX_ATTEMPTS = envPositiveInteger('MOCK_FIRST_OFD_CALLBACK_MAX_ATTEMPTS', MOCK_FIRST_OFD_CALLBACK_MAX_ATTEMPTS, CALLBACK_MAX_ATTEMPTS_DEFAULT);

/* Кассовые группы: в реальном сервисе группы заведены в ЛК, а
 * requestMetadata.userGroup выбирает одну из них. Публичный срез значение не
 * фиксирует, поэтому мок принимает синтетический каталог; «*» отключает
 * проверку (любая непустая группа), пустое значение возвращает дефолт. */
const USER_GROUPS_RAW = String(MOCK_FIRST_OFD_USER_GROUPS ?? '').trim();
const USER_GROUPS_ANY = USER_GROUPS_RAW === '*';
const USER_GROUPS = USER_GROUPS_ANY
  ? []
  : (USER_GROUPS_RAW || 'MOCKGROUP,firstofd-mock').split(',').map((value) => value.trim()).filter(Boolean);

/* ------------------------------------------------------------------ срез/схема */

/** Типы заявок очереди — по OpenAPI тестового контура (срез 2026-10-11). */
const TRANSACTION_TYPES = {
  receipt: 'ReceiptRequest — чек (приход/возврат/расход)',
  receiptCorrection: 'ReceiptCorrectionRequest — чек коррекции (+ correctionCause)',
  openShift: 'StateCommandRequest — открытие смены',
  closeShift: 'StateCommandRequest — закрытие смены',
  currentStateReport: 'StateCommandRequest — отчёт о текущем состоянии расчётов',
};

/** Операции чека: написание EXPENCE — как в схеме, автоправка запрещена. */
const OPERATIONS = {
  INCOME: 'приход',
  INCOME_RETURN: 'возврат прихода',
  EXPENCE: 'расход',
  EXPENCE_RETURN: 'возврат расхода',
};

/** Ставки НДС. VAT_22/VAT_22122 подтверждены срезом; остальные — стандартные
 *  коды ФФД и помечены [VERIFY]: полный enum vatCode в публичном срезе не приведён. */
const VAT_CODES = {
  VAT_NONE: '[VERIFY] без НДС',
  VAT_0: '[VERIFY] 0 %',
  VAT_10: '[VERIFY] 10 %',
  VAT_20: '[VERIFY] 20 %',
  VAT_110: '[VERIFY] 10/110 (расчётная)',
  VAT_120: '[VERIFY] 20/120 (расчётная)',
  VAT_22: '22 % — ставка подтверждена срезом',
  VAT_22122: '22/122 (расчётная) — ставка подтверждена срезом',
};

/** Статусы очереди по срезу. */
const QUEUE_STATUSES = {
  IN_PROGRESS: 'заявка в очереди/обрабатывается',
  COMPLETED: 'заявка обработана успешно',
  ERROR: 'заявка обработана с ошибкой',
};

/** Слои ошибок результата: API очереди и ККТ разделяются (срез). */
const ERROR_LAYERS = {
  API: 'ошибка уровня API очереди',
  KKT: 'ошибка уровня ККТ/фискального накопителя',
};

/* Каталоги errorCode результата. Публичный срез фиксирует ПОЛЯ errorCode/
 * errorType/details, но не таблицу значений → это локальный [FORK] мока, а не
 * production-каталог Первого ОФД. */
const KKT_ERROR_CODES = {
  SHIFT_ALREADY_OPEN: 'смена уже открыта на этой кассе (mock-local правило ККТ [FORK])',
  SHIFT_NOT_OPEN: 'смена не открыта — закрывать нечего (mock-local правило ККТ [FORK])',
  KKT_UNAVAILABLE: 'ККТ недоступна/сбой фискального накопителя (сценарий kkt-error, [FORK])',
};
const API_ERROR_CODES = {
  DOCUMENT_REJECTED: 'заявка принята, но отклонена слоем API очереди (сценарий api-error, [FORK])',
};

/* HTTP-ошибки мока: envelope {error:{code,text,layer}} + DX {field,hint,doc}.
 * Публичный срез схему тела ошибки не фиксирует → явный [FORK] мока. */
const HTTP_ERROR_CODES = [
  'invalid_credentials',
  'invalid_token',
  'invalid_request',
  'invalid_amount',
  'invalid_vat_code',
  'invalid_operation_type',
  'invalid_item',
  'unknown_user_group',
  'unknown_transaction_type',
  'request_not_found',
  'missing_parameter',
  'invalid_callback_url',
  'limit_exceeded',
  'unsupported_method',
  'not_found',
  'system_error',
];

/* --------------------------------------------------------- per-sandbox state */

const store = core.createStore({ stateFile: MOCK_STATE_FILE, log: console.error });
const restore = store.restore;
const defaultState = store.state;

function createInitialFirstOfdState({ seed = 0 } = {}) {
  return {
    counters: {
      callbackId: 1 + seed * 1000000,
      documentNumber: 1 + seed * 1000000,
      groupNumber: 1 + seed * 1000000,
    },
    tokens: Object.create(null),
    requests: Object.create(null),  // requestId → заявка очереди (с результатом)
    documents: Object.create(null), // номер ФД → фискальный документ (для /receipts)
    groups: Object.create(null),    // userGroup → касса (РНМ, ФН, состояние смены)
    callbacks: Object.create(null),
    clockOffsetMs: 0,
  };
}

for (const [key, value] of Object.entries(createInitialFirstOfdState())) {
  if (defaultState[key] === undefined) defaultState[key] = value;
}

function countFirstOfdDocuments(snapshot) {
  return ['requests', 'documents', 'callbacks'].reduce((n, key) => n + Object.keys(snapshot[key] || {}).length, 0);
}

function firstOfdRetention(snapshot, now) {
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
  initialStateFactory: createInitialFirstOfdState,
  mode: TENANCY,
  stateFile: MOCK_STATE_FILE,
  sandboxFile: String(process.env.MOCK_SANDBOX_FILE || ''),
  ttlMs: SANDBOX_TTL_MS,
  maxSandboxes: SANDBOX_MAX,
  maxDocuments: SANDBOX_MAX_DOCUMENTS,
  documentCounter: countFirstOfdDocuments,
  retention: firstOfdRetention,
  defaultOwnerToken: SANDBOX_OWNER_TOKEN,
  hostSuffix: SANDBOX_HOST_SUFFIX,
  operatorTokens: [MOCK_ADMIN_TOKEN, OPERATOR_TOKEN],
  createLimit: SANDBOX_CREATE_LIMIT,
  onSandboxRemoved: (record) => dropSandboxChildState(record),
  log: (message) => console.error(`[first-ofd-mock] ${message}`),
});

const state = sandboxRuntime.state;
const persist = sandboxRuntime.persist;
const journal = core.createJournal({ size: 200, sandboxScope: () => sandboxRuntime.current() });
const firstOfdLogin = () => sandboxRuntime.creds().login || LOGIN_CRED;
const firstOfdPass = () => sandboxRuntime.creds().pass || PASS_CRED;
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

/* ------------------------------------------------------------- базовые утилиты */

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

/** ISO с миллисекундами и tz — формат полей времени среза. */
function isoWithMs(ms) {
  return new Date(ms).toISOString();
}

function text(value) {
  return value === undefined || value === null ? '' : String(value);
}

function firstOfdError(code, message, { field, hint, doc = 'docs/reference/first-ofd/01-okassa-api.md', layer = 'API' } = {}) {
  const body = { error: { code: String(code), text: String(message || ''), layer } };
  if (field) body.field = field;
  if (hint) body.hint = hint;
  if (doc) body.doc = doc;
  return body;
}

function errorOutcome(status, code, message, extras = {}) {
  return { status, body: firstOfdError(code, message, extras) };
}

function jsonRaw(res, statusCode, body, headers = {}) {
  return send(res, statusCode, typeof body === 'string' ? body : JSON.stringify(body), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
}

/* ------------------------------------------------------------ валидация суммы */

/**
 * Денежное значение чека — ДЕСЯТИЧНЫЕ рубли (например 100.00), не копейки:
 * внутри храним целые копейки, чтобы не носить float-ошибки по суммам.
 */
function parseMoneyValue(raw, { field, allowZero = true } = {}) {
  const reject = (message) => ({ ok: false, message });
  if (raw === undefined || raw === null || raw === '') {
    return reject(`${field} обязателен: десятичные рубли (например 100.00), не копейки`);
  }
  let value;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return reject(`${field} должен быть конечным числом`);
    value = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
      return reject(`${field}=${JSON.stringify(raw)} — не десятичная сумма рублей: цифры, точка и максимум 2 знака после точки (100.00)`);
    }
    value = Number(trimmed);
  } else {
    return reject(`${field} должен быть числом или цифровой строкой, получено ${typeof raw}`);
  }
  if (!Number.isFinite(value)) return reject(`${field} должен быть конечным числом`);
  const kopecks = Math.round(value * 100);
  if (Math.abs(value * 100 - kopecks) > 1e-6) {
    return reject(`${field}=${JSON.stringify(raw)}: больше 2 знаков после точки не поддерживается`);
  }
  if (kopecks < 0) return reject(`${field}=${JSON.stringify(raw)} не может быть отрицательной`);
  if (!allowZero && kopecks === 0) return reject(`${field}=${JSON.stringify(raw)} должен быть больше нуля`);
  if (kopecks > MAX_AMOUNT_KOPEKS) {
    return reject(`${field}=${JSON.stringify(raw)} превышает допустимый максимум мок-стенда ${MAX_AMOUNT_KOPEKS / 100}`);
  }
  return { ok: true, kopecks, rubles: kopecks / 100 };
}

function parseQuantity(raw, { field = 'document.items[].quantity' } = {}) {
  const reject = (message) => ({ ok: false, message });
  if (raw === undefined || raw === null || raw === '') {
    return reject(`${field} обязателен (количество предмета расчёта)`);
  }
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return reject(`${field} должен быть числом`);
  }
  if (value <= 0) return reject(`${field}=${JSON.stringify(raw)} должен быть больше нуля`);
  const scaled = value * 10 ** MAX_QUANTITY_DECIMALS;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    return reject(`${field}=${JSON.stringify(raw)}: больше ${MAX_QUANTITY_DECIMALS} знаков после точки не поддерживается (mock safety cap)`);
  }
  return { ok: true, value };
}

function parseInn(raw, { field } = {}) {
  const value = text(raw).trim();
  if (!value) return { ok: false, message: `${field} обязателен: ИНН 10 или 12 цифр` };
  if (!/^\d+$/.test(value) || !INN_LENGTHS.includes(value.length)) {
    return { ok: false, message: `${field}=${JSON.stringify(raw)} — ИНН должен состоять из 10 или 12 цифр` };
  }
  return { ok: true, value };
}

function parseText(raw, { field, max = MAX_TEXT, required = true, min = 1 } = {}) {
  const value = text(raw).trim();
  if (!value) {
    return required ? { ok: false, message: `${field} обязателен (непустая строка)` } : { ok: true, value: '' };
  }
  if (value.length < min || value.length > max) {
    return { ok: false, message: `${field} должен быть строкой длиной ${min}…${max} символов, получено ${value.length} (mock safety cap)` };
  }
  return { ok: true, value };
}

/* -------------------------------------------------------------------- auth */

function issueToken() {
  const now = clock.now();
  for (const [token, record] of Object.entries(state.tokens || {})) {
    if (record.expiresAtMs <= now) delete state.tokens[token];
  }
  // Повторная выдача — сценарий: по умолчанию прежние токены остаются живыми
  // до TTL (срез молчит о том, аннулируется ли предыдущий токен; [VERIFY]).
  if (TOKEN_SINGLE) state.tokens = Object.create(null);
  const token = crypto.randomBytes(24).toString('hex');
  state.tokens[token] = {
    login: firstOfdLogin(),
    createdAtMs: now,
    createdAt: isoWithMs(now),
    expiresAtMs: now + TOKEN_TTL_SECS * 1000,
  };
  persist();
  return token;
}

/**
 * POST /getToken: Content-Type application/json; charset=utf-8, тело {login, pass}.
 *
 * Квирк примера из PDF: под заголовком «успешный ответ» приведён объект error с
 * кодом 0 и текстом «Неверный логин и пароль». Семантика error провайдером не
 * согласована (02-test-and-open-issues.md §4), поэтому:
 *   • дефолтный успех мока — только {token} (без объекта error) — [VERIFY];
 *   • сценарий `getToken-error-quirk` воспроизводит пример PDF КАК ЕСТЬ
 *     ({token, error:{code:0,text:'Неверный логин и пароль'}}), чтобы интегратор
 *     проверил свой парсер на документированной неоднозначности.
 */
function handleGetToken(req, res, raw, body, spec) {
  if (req.method !== 'POST') {
    return jsonRaw(res, 405, firstOfdError('unsupported_method', `getToken принимает POST, получено ${req.method}`, {
      field: 'method',
      hint: `Отправьте POST ${TOKEN_PATH} с телом {"login": "…", "pass": "…"}.`,
    }));
  }
  if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
    return jsonRaw(res, 415, firstOfdError('invalid_request', 'getToken принимает application/json; charset=utf-8', {
      field: 'Content-Type',
      hint: 'Срез фиксирует Content-Type: application/json; charset=utf-8 для getToken.',
    }));
  }
  if (raw.trim()) {
    try { JSON.parse(raw); } catch {
      return jsonRaw(res, 400, firstOfdError('invalid_request', 'Тело getToken не является валидным JSON', { field: 'body' }));
    }
  }
  if (!isPlainObject(body)) {
    return jsonRaw(res, 400, firstOfdError('invalid_request', 'Тело getToken должно быть объектом {login, pass}', { field: 'body' }));
  }
  const login = text(body.login).trim();
  const pass = text(body.pass).trim();
  if (!login || !pass) {
    return jsonRaw(res, 400, firstOfdError('invalid_request', 'login и pass обязательны', {
      field: !login ? 'login' : 'pass',
      hint: 'login — идентификатор организации; pass — API-ключ UUID из ЛК «Облачные кассы → Интеграции».',
    }));
  }
  if (!constantTimeEqual(login, firstOfdLogin()) || !constantTimeEqual(pass, firstOfdPass())) {
    log(`getToken: отказ авторизации login=${core.maskPiiValue('login', login)}`);
    return jsonRaw(res, 401, firstOfdError('invalid_credentials', 'Неверный логин и пароль', {
      field: 'login',
      hint: `Синтетические дефолты стенда — ${DEFAULT_LOGIN}/${DEFAULT_PASS}; свои значения задаются MOCK_FIRST_OFD_LOGIN/MOCK_FIRST_OFD_PASS. Реальные тестовые креды Первого ОФД публично не опубликованы.`,
    }));
  }
  const token = issueToken();
  const record = state.tokens[token];
  const payload = { token };
  if (spec && spec.has('getToken-error-quirk')) {
    // Дословный квирк примера PDF: error с кодом 0 и текстом про неверный логин.
    payload.error = { code: 0, text: 'Неверный логин и пароль' };
  }
  log(`getToken: токен выдан, TTL ${TOKEN_TTL_SECS} с (виртуальные часы)${TOKEN_SINGLE ? ', прежние токены аннулированы (MOCK_FIRST_OFD_TOKEN_SINGLE)' : ''}`);
  return jsonRaw(res, 200, payload, {
    'X-Mock-Token-TTL-Secs': String(TOKEN_TTL_SECS),
    'X-Mock-Token-Expires-At': isoWithMs(record.expiresAtMs),
  });
}

function verifyBearer(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return errorOutcome(401, 'invalid_token', 'Заголовок Authorization: Bearer <token> отсутствует или malformed', {
      field: 'Authorization',
      hint: `Получите токен через POST ${TOKEN_PATH} (тело {login, pass}) и передайте Authorization: Bearer <token>. API-ключ UUID сам по себе bearer-токеном не является.`,
    });
  }
  const token = match[1].trim();
  const record = state.tokens[token];
  if (!record || record.expiresAtMs <= clock.now()) {
    return errorOutcome(401, 'invalid_token', record ? 'Срок действия токена истёк' : 'Неизвестный токен', {
      field: 'Authorization',
      hint: `Токен живёт ${TOKEN_TTL_SECS} с (24 ч на виртуальных часах стенда); запросите новый через POST ${TOKEN_PATH}.`,
    });
  }
  return null;
}

/* -------------------------------------------------------- схема заявки по типу */

function validateItem(raw, index) {
  const field = `document.items[${index}]`;
  if (!isPlainObject(raw)) {
    return { ok: false, message: `${field} должен быть объектом Item` };
  }
  const label = parseText(raw.label, { field: `${field}.label`, max: MAX_LABEL });
  if (!label.ok) return label;
  // Форма measurementUnit в публичном срезе не раскрыта (строка кода меры/«шт»):
  // мок принимает непустую строку и не подменяет её таблицей [VERIFY].
  const measurementUnit = parseText(raw.measurementUnit, { field: `${field}.measurementUnit`, max: MAX_MEASUREMENT_UNIT });
  if (!measurementUnit.ok) return measurementUnit;
  const price = parseMoneyValue(raw.price, { field: `${field}.price` });
  if (!price.ok) {
    return { ok: false, message: price.message, field: `${field}.price`, hint: 'price — ДЕСЯТИЧНЫЕ рубли (например 100.00), не копейки; до 2 знаков после точки.' };
  }
  const quantity = parseQuantity(raw.quantity, { field: `${field}.quantity` });
  if (!quantity.ok) {
    return { ok: false, message: quantity.message, field: `${field}.quantity`, hint: 'quantity — положительное число (до 3 знаков после точки, mock safety cap); дробное количество допустимо.' };
  }
  const vatCode = text(raw.vatCode).trim();
  if (!vatCode) {
    return {
      ok: false,
      message: `${field}.vatCode обязателен`,
      hint: `Ставка НДС обязательна для позиции Item. Доступные коды: ${Object.keys(VAT_CODES).join(', ')} (VAT_22 и VAT_22122 подтверждены срезом).`,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(VAT_CODES, vatCode)) {
    return {
      ok: false,
      code: 'invalid_vat_code',
      message: `${field}.vatCode=${JSON.stringify(raw.vatCode)} не поддерживается`,
      hint: `Доступные коды НДС: ${Object.keys(VAT_CODES).join(', ')}. VAT_22 и VAT_22122 подтверждены срезом; прочие коды — [VERIFY].`,
      field: `${field}.vatCode`,
    };
  }
  return {
    ok: true,
    item: {
      label: label.value,
      measurementUnit: measurementUnit.value,
      price: price.rubles,
      priceK: price.kopecks,
      quantity: quantity.value,
      vatCode,
    },
  };
}

function validateMoneyMap(raw, { field, keys = null } = {}) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!isPlainObject(raw)) {
    return { ok: false, message: `${field} должен быть объектом вида {КЛЮЧ: сумма}, получено ${Array.isArray(raw) ? 'массив' : typeof raw}` };
  }
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (keys && !Object.prototype.hasOwnProperty.call(keys, key)) {
      // Каталог ключей в срезе не зафиксирован — неизвестный ключ не отклоняется,
      // но попадает в предупреждение оператору ([VERIFY]).
      log(`WARN ${field}.${key} отсутствует в синтетическом каталоге — значение сохранено как есть ([VERIFY])`);
    }
    const money = parseMoneyValue(value, { field: `${field}.${key}` });
    if (!money.ok) return money;
    result[key] = money.rubles;
  }
  return { ok: true, value: result };
}

function validateContact(raw, { field } = {}) {
  const value = text(raw).trim();
  if (!value) return { ok: false, message: `${field} обязателен (непустая строка)` };
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
  const phone = /^\+?[\d\s()-]{6,}$/.test(value);
  if (!email && !phone) {
    return { ok: false, message: `${field}=${JSON.stringify(raw)} не похож ни на e-mail, ни на телефон получателя чека` };
  }
  return { ok: true, value };
}

function validateCallbackUrl(raw) {
  const value = text(raw).trim();
  if (!value) return { ok: true, value: '' };
  if (value.length > CALLBACK_URL_MAX) {
    return { ok: false, message: `requestMetadata.callbackUrl длиннее ${CALLBACK_URL_MAX} символов (mock safety cap)` };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: `requestMetadata.callbackUrl=${JSON.stringify(raw)} не разобран как абсолютный URL` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      message: `requestMetadata.callbackUrl=${JSON.stringify(raw)}: поддерживаются только http:// и https://`,
      hint: 'PDF говорит о префиксе http://, примеры PDF и OpenAPI используют https:// — расхождение среза; по умолчанию мок принимает обе схемы, строгий HTTPS включается MOCK_FIRST_OFD_CALLBACK_HTTPS_ONLY.',
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      message: 'requestMetadata.callbackUrl не должен содержать userinfo (логин/пароль в URL)',
      hint: 'Передайте чистый http(s)-URL без логина и пароля; подпись и авторизация callback публичным срезом не закреплены.',
    };
  }
  if (CALLBACK_HTTPS_ONLY && url.protocol === 'http:') {
    return {
      ok: false,
      message: 'requestMetadata.callbackUrl со схемой http:// отклонён: включён MOCK_FIRST_OFD_CALLBACK_HTTPS_ONLY',
      hint: 'PDF требует префикс http://, примеры PDF и OpenAPI используют https:// — это расхождение среза; режим строгого HTTPS включается env-флагом и по умолчанию выключен.',
    };
  }
  return { ok: true, value };
}

function validateCashboxParameters(raw, { requireUserInn }) {
  if (!isPlainObject(raw)) {
    return { ok: false, message: 'cashboxParameters должен быть объектом', field: 'cashboxParameters' };
  }
  const inn = text(raw.userInn).trim();
  if (!inn) {
    if (requireUserInn) {
      return {
        ok: false,
        message: 'cashboxParameters.userInn обязателен для заявки на чек',
        field: 'cashboxParameters.userInn',
        hint: 'userInn — ИНН организации/ИП (10 или 12 цифр); по срезу поле обязательно для ReceiptRequest.',
      };
    }
    return { ok: true, value: { userInn: '', raw } };
  }
  const parsed = parseInn(raw.userInn, { field: 'cashboxParameters.userInn' });
  if (!parsed.ok) {
    return {
      ok: false,
      message: parsed.message,
      field: 'cashboxParameters.userInn',
      hint: 'userInn — ИНН организации (10 цифр) или ИП/физлица (12 цифр); по срезу поле обязательно для ReceiptRequest.',
    };
  }
  return { ok: true, value: { userInn: parsed.value, raw } };
}

function validateUserGroup(raw) {
  const value = text(raw).trim();
  if (!value) {
    return {
      ok: false,
      message: 'requestMetadata.userGroup обязателен',
      field: 'requestMetadata.userGroup',
      hint: 'userGroup выбирает кассовую группу; по срезу поле обязательное (расхождение manual vs OpenAPI — см. docs/reference/first-ofd/02-test-and-open-issues.md §1).',
    };
  }
  if (value.length > MAX_GROUP_ID) {
    return { ok: false, message: `requestMetadata.userGroup длиннее ${MAX_GROUP_ID} символов (mock safety cap)`, field: 'requestMetadata.userGroup' };
  }
  if (!USER_GROUPS_ANY && !USER_GROUPS.includes(value)) {
    return {
      ok: false,
      code: 'unknown_user_group',
      message: `Кассовая группа «${value}» не найдена`,
      field: 'requestMetadata.userGroup',
      hint: `Синтетический каталог стенда: ${USER_GROUPS.join(', ')}. Задайте свои группы через MOCK_FIRST_OFD_USER_GROUPS или «*», чтобы принимать любую непустую группу.`,
    };
  }
  return { ok: true, value };
}

function validateRequestMetadata(raw) {
  // Расхождение среза №1: manual называет requestMetadata необязательным, а
  // OpenAPI держит его в required. Мок использует строгую схему OpenAPI и
  // фиксирует выбор как [VERIFY] — см. docs/reference/first-ofd/02-*.md §1.
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'requestMetadata обязателен (строгая схема OpenAPI: manual расходится, см. [VERIFY])',
      field: 'requestMetadata',
      hint: 'Передайте объект {userGroup, externalId?, callbackUrl?, timestamp?, timeZone?}.',
    };
  }
  const userGroup = validateUserGroup(raw.userGroup);
  if (!userGroup.ok) return userGroup;
  const externalId = text(raw.externalId).trim();
  if (externalId && externalId.length > MAX_EXTERNAL_ID) {
    return { ok: false, message: `requestMetadata.externalId длиннее ${MAX_EXTERNAL_ID} символов (mock safety cap)`, field: 'requestMetadata.externalId' };
  }
  const callbackUrl = validateCallbackUrl(raw.callbackUrl);
  if (!callbackUrl.ok) return { ok: false, message: callbackUrl.message, field: 'requestMetadata.callbackUrl', hint: callbackUrl.hint };
  if (raw.timestamp !== undefined && raw.timestamp !== null && raw.timestamp !== '') {
    const asNumber = typeof raw.timestamp === 'number' ? raw.timestamp : Number.NaN;
    const asDate = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : Number.NaN;
    if (!Number.isFinite(asNumber) && !Number.isFinite(asDate)) {
      return {
        ok: false,
        message: 'requestMetadata.timestamp должен быть числом (unix) или строкой ISO 8601',
        field: 'requestMetadata.timestamp',
        hint: 'Точная форма timestamp в публичном срезе не зафиксирована ([VERIFY]); мок принимает unix-число или ISO 8601.',
      };
    }
  }
  if (raw.timeZone !== undefined && raw.timeZone !== null && raw.timeZone !== '') {
    const tz = parseText(raw.timeZone, { field: 'requestMetadata.timeZone', max: 32 });
    if (!tz.ok) return { ok: false, message: tz.message, field: 'requestMetadata.timeZone' };
  }
  return { ok: true, value: { userGroup: userGroup.value, externalId, callbackUrl: callbackUrl.value, raw } };
}

function validateReceiptDocument(raw, { correction }) {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: 'document должен быть объектом Receipt (ReceiptCorrectionRequest для коррекции)',
      field: 'document',
      hint: 'Для чека обязательны document.operationType, document.items[] и document.totalSum; для смен/отчёта используйте StateCommandRequest без document.',
    };
  }
  const operationType = text(raw.operationType).trim();
  if (!operationType) {
    return { ok: false, message: 'document.operationType обязателен', field: 'document.operationType' };
  }
  if (!Object.prototype.hasOwnProperty.call(OPERATIONS, operationType)) {
    const mixed = operationType.toUpperCase().replace(/^EXPENSE/, 'EXPENCE');
    return {
      ok: false,
      code: 'invalid_operation_type',
      message: `document.operationType=${JSON.stringify(raw.operationType)} не поддерживается`,
      field: 'document.operationType',
      hint: `Допустимые операции: ${Object.keys(OPERATIONS).join(', ')}. Написание EXPENCE/EXPENCE_RETURN сохранено как в схеме — не «исправляйте» его автоматически${mixed !== operationType ? ` (получено ${JSON.stringify(mixed)})` : ''}.`,
    };
  }
  const items = raw.items;
  if (!Array.isArray(items)) {
    return {
      ok: false,
      message: 'document.items должен быть МАССИВОМ элементов Item (срез: таблица manual трактует форму иначе — расхождение №2)',
      field: 'document.items',
      hint: 'OpenAPI описывает items как массив; таблица manual — как объект. Мок следует строгой OpenAPI-схеме тестового контура [VERIFY].',
    };
  }
  if (!items.length) {
    return { ok: false, message: 'document.items не может быть пустым массивом', field: 'document.items' };
  }
  if (items.length > MAX_ITEMS) {
    return { ok: false, message: `document.items: ${items.length} позиций превышает mock safety cap ${MAX_ITEMS}`, field: 'document.items' };
  }
  const validatedItems = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = validateItem(items[index], index);
    if (!item.ok) {
      return { ok: false, code: item.code || 'invalid_item', message: item.message, field: item.field || `document.items[${index}]`, hint: item.hint };
    }
    validatedItems.push(item.item);
  }
  if (raw.totalSum === undefined || raw.totalSum === null || raw.totalSum === '') {
    return {
      ok: false,
      message: 'document.totalSum обязателен',
      field: 'document.totalSum',
      hint: 'totalSum — итог чека в ДЕСЯТИЧНЫХ рублях (например 100.00), не копейки. Сверку totalSum с позициями срез не описывает — мок её не требует ([FORK], вне области).',
    };
  }
  const totalSum = parseMoneyValue(raw.totalSum, { field: 'document.totalSum' });
  if (!totalSum.ok) {
    return {
      ok: false,
      message: totalSum.message,
      field: 'document.totalSum',
      hint: 'totalSum — ДЕСЯТИЧНЫЕ рубли (например 100.00): цифры, точка и максимум 2 знака после точки.',
    };
  }
  if (correction) {
    if (raw.correctionCause === undefined || raw.correctionCause === null || text(raw.correctionCause).trim() === '') {
      return {
        ok: false,
        message: 'document.correctionCause обязателен для ReceiptCorrectionRequest',
        field: 'document.correctionCause',
        hint: 'document.correctionCause обязателен для ReceiptCorrectionRequest. Значения основания коррекции в публичном срезе не перечислены ([VERIFY]): мок принимает непустую строку или число и не подменяет её каталогом.',
      };
    }
  }
  const taxationType = text(raw.taxationType).trim();
  const cashier = text(raw.cashier).trim();
  const cashierInn = text(raw.cashierInn).trim();
  if (cashierInn && !parseInn(cashierInn, { field: 'document.cashierInn' }).ok) {
    return {
      ok: false,
      message: 'document.cashierInn должен состоять из 10 или 12 цифр',
      field: 'document.cashierInn',
      hint: 'cashierInn — ИНН кассира (10 или 12 цифр); вместе с cashier он опционален для ReceiptRequest.',
    };
  }
  const vatSums = validateMoneyMap(raw.vatSums, { field: 'document.vatSums', keys: VAT_CODES });
  if (!vatSums.ok) return { ok: false, message: vatSums.message, field: 'document.vatSums' };
  const ecashSums = validateMoneyMap(raw.ecashSums, { field: 'document.ecashSums' });
  if (!ecashSums.ok) return { ok: false, message: ecashSums.message, field: 'document.ecashSums' };
  if (raw.sendCheckTo !== undefined && raw.sendCheckTo !== null && raw.sendCheckTo !== '') {
    const targets = Array.isArray(raw.sendCheckTo) ? raw.sendCheckTo : [raw.sendCheckTo];
    if (!targets.length) {
      return { ok: false, message: 'document.sendCheckTo не может быть пустым', field: 'document.sendCheckTo' };
    }
    for (const target of targets) {
      const contact = validateContact(target, { field: 'document.sendCheckTo' });
      if (!contact.ok) return { ok: false, message: contact.message, field: 'document.sendCheckTo' };
    }
  }
  if (raw.buyer !== undefined && raw.buyer !== null && !isPlainObject(raw.buyer)) {
    return { ok: false, message: 'document.buyer должен быть объектом реквизитов покупателя', field: 'document.buyer' };
  }
  if (raw.industryProps !== undefined && raw.industryProps !== null
    && !isPlainObject(raw.industryProps) && !Array.isArray(raw.industryProps)) {
    return { ok: false, message: 'document.industryProps должен быть объектом или массивом отраслевых реквизитов', field: 'document.industryProps' };
  }
  // Сверка totalSum с позициями НЕ является правилом протокола и в срезе не
  // описана (вне области задачи): мок не отклоняет заявку, но предупреждает.
  const computed = validatedItems.reduce((sum, item) => sum + Math.round(item.priceK * item.quantity), 0);
  if (computed !== totalSum.kopecks) {
    log(`WARN document.totalSum=${totalSum.rubles} ≠ Σ(price×quantity)=${computed / 100}: правило сверки сумм в срезе не описано, заявка принята как есть ([FORK], вне области)`);
  }
  return {
    ok: true,
    value: {
      operationType,
      items: validatedItems,
      totalSum: totalSum.rubles,
      totalSumK: totalSum.kopecks,
      correctionCause: correction ? (typeof raw.correctionCause === 'number' ? raw.correctionCause : text(raw.correctionCause).trim()) : null,
      taxationType,
      cashier,
      cashierInn,
      retailAddress: text(raw.retailAddress).trim(),
      retailPlace: text(raw.retailPlace).trim(),
      sendCheckTo: raw.sendCheckTo === undefined || raw.sendCheckTo === null ? null : raw.sendCheckTo,
      buyer: raw.buyer || null,
      industryProps: raw.industryProps || null,
      vatSums: vatSums.value,
      ecashSums: ecashSums.value,
      timeZone: text(raw.timeZone).trim(),
      raw,
    },
  };
}

/**
 * Схема заявки строго по типу: receipt/receiptCorrection — ReceiptRequest/
 * ReceiptCorrectionRequest, смены и отчёт — StateCommandRequest. Смешивать
 * типы нельзя: receipt-тело в openShift и state-команда в receipt отклоняются.
 */
function validateTransactionRequest(type, body) {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, code: 'invalid_request', message: 'Тело заявки должно быть JSON-объектом', field: 'body' };
  }
  const isReceipt = type === 'receipt' || type === 'receiptCorrection';
  const cashbox = validateCashboxParameters(body.cashboxParameters, { requireUserInn: isReceipt });
  if (!cashbox.ok) {
    return { ok: false, status: 400, code: cashbox.code || 'invalid_request', message: cashbox.message, field: cashbox.field, hint: cashbox.hint };
  }
  const metadata = validateRequestMetadata(body.requestMetadata);
  if (!metadata.ok) {
    return { ok: false, status: 400, code: metadata.code || 'invalid_request', message: metadata.message, field: metadata.field, hint: metadata.hint };
  }
  if (!isReceipt) {
    // StateCommandRequest: состав публично не раскрыт, поэтому мок требует только
    // документированный requestMetadata.userGroup и ОТКЛОНЯЕТ receipt-тело
    // (иначе будет собран «универсальный» объект из разных схем) — [VERIFY].
    if (body.document !== undefined && body.document !== null) {
      return {
        ok: false,
        status: 400,
        code: 'invalid_request',
        message: `Тип «${type}» принимает StateCommandRequest и не принимает document (receipt-тело)`,
        field: 'document',
        hint: `Document с operationType/items/totalSum отправляйте в POST ${QUEUE_BASE}transaction/receipt. Состав StateCommandRequest в публичном срезе не зафиксирован ([VERIFY]) — см. docs/reference/first-ofd/01-okassa-api.md.`,
      };
    }
    return {
      ok: true,
      value: {
        cashboxParameters: cashbox.value,
        requestMetadata: metadata.value,
        document: null,
      },
    };
  }
  const document = validateReceiptDocument(body.document, { correction: type === 'receiptCorrection' });
  if (!document.ok) {
    return {
      ok: false,
      status: 400,
      code: document.code || 'invalid_request',
      message: document.message,
      field: document.field,
      hint: document.hint,
    };
  }
  return {
    ok: true,
    value: {
      cashboxParameters: cashbox.value,
      requestMetadata: metadata.value,
      document: document.value,
      rawRequest: body,
    },
  };
}

/* ------------------------------------------------------------- касса и ФД */

function groupState(userGroup) {
  if (!state.groups[userGroup]) {
    const index = state.counters.groupNumber++;
    state.groups[userGroup] = {
      groupId: userGroup,
      // Синтетические РНМ/ФН: реальные значения кассы в срез не входят.
      kkmRegId: String(100000000000000 + index),          // 15 цифр, РНМ
      fiscalDriveNumber: String(9999078900000000 + index), // 16 цифр, номер ФН
      shiftNumber: 0,
      shiftOpen: false,
      shiftOpenedAtMs: 0,
      documentsInShift: 0,
      createdAtMs: clock.now(),
    };
  }
  return state.groups[userGroup];
}

function nextFiscalDocument(group, { transactionType, operationType, totalSum, shiftNumber }) {
  const number = state.counters.documentNumber++;
  group.documentsInShift += 1;
  return {
    fiscalDocumentNumber: number,
    // ФПД — синтетический 10-значный (реальный алгоритм в срез не входит).
    fiscalDocumentSign: String(1000000000 + (number % 900000000)),
    fiscalDriveNumber: group.fiscalDriveNumber,
    kkmRegId: group.kkmRegId,
    shiftNumber,
    documentDate: isoWithMs(clock.now()),
    transactionType,
    operationType: operationType || null,
    totalSum: totalSum === undefined ? null : totalSum,
  };
}

/* ----------------------------------------------------------------- очередь */

function scheduleCallback(request, statusObject) {
  const target = request.callbackUrl || DEFAULT_CALLBACK_URL;
  if (!target) return null;
  const spec = parseScenarioSpec(request.scenarios || '');
  const suppressed = spec.has('webhook-drop') || spec.has('no-webhook') || spec.has('no-callback');
  const duplicate = spec.has('webhook-duplicate') || spec.has('callback-duplicate');
  const copies = duplicate && !suppressed ? 2 : 1;
  const ids = [];
  for (let index = 0; index < copies; index += 1) {
    const id = String(state.counters.callbackId++);
    state.callbacks[id] = {
      id,
      requestId: request.requestId,
      transactionType: request.transactionType,
      externalId: request.externalId,
      url: target,
      // Envelope уведомления публично не зафиксирован: мок отправляет результат
      // заявки как есть, без подписи. Форма — локальная договорённость [FORK].
      payload: { ...statusObject, externalId: request.externalId, userGroup: request.userGroup },
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
    log(`callback ${id} ${suppressed ? 'подавлен сценарием' : 'поставлен в очередь'}: ${request.transactionType} / ${request.requestId}`);
  }
  persist();
  return ids;
}

function resultObject(request) {
  return {
    requestId: request.requestId,
    transactionType: request.transactionType,
    status: request.status,
    errorCode: request.error ? request.error.errorCode : null,
    errorType: request.error ? request.error.errorType : null,
    details: request.error ? request.error.details : null,
    payload: request.payload || null,
  };
}

function statusView(request) {
  return {
    ...resultObject(request),
    externalId: request.externalId || null,
    userGroup: request.userGroup,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

function transactionView(request) {
  return {
    requestId: request.requestId,
    status: request.status,
    transactionType: request.transactionType,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    request: request.request.rawRequest,
    result: resultObject(request),
  };
}

function failRequest(request, { errorType, errorCode, details }) {
  request.status = 'ERROR';
  request.error = { errorType, errorCode, details };
  request.payload = null;
  request.finishedAtMs = clock.now();
  request.updatedAt = isoWithMs(request.finishedAtMs);
  persist();
  log(`заявка ${request.requestId} (${request.transactionType}): ERROR, слой ${errorType}, errorCode=${errorCode}, details=${JSON.stringify(details)}`);
  scheduleCallback(request, resultObject(request));
}

/** Завершение заявки очереди: ККТ-слой, затем успех с фискальным документом. */
function finishRequest(request) {
  const spec = parseScenarioSpec(request.scenarios || '');
  const group = groupState(request.userGroup);
  if (spec.has('kkt-error') || spec.has('ofd-reject') || spec.has('kkt-fail')) {
    return failRequest(request, {
      errorType: 'KKT',
      errorCode: 'KKT_UNAVAILABLE',
      details: 'ККТ недоступна (сценарий kkt-error): заявка обработана, фискальный документ не напечатан',
    });
  }
  if (spec.has('api-error') || spec.has('queue-reject')) {
    return failRequest(request, {
      errorType: 'API',
      errorCode: 'DOCUMENT_REJECTED',
      details: 'Заявка отклонена слоем API очереди (сценарий api-error)',
    });
  }
  if (request.transactionType === 'openShift') {
    if (group.shiftOpen) {
      return failRequest(request, {
        errorType: 'KKT',
        errorCode: 'SHIFT_ALREADY_OPEN',
        details: `Смена №${group.shiftNumber} уже открыта на кассе ${group.kkmRegId}`,
      });
    }
    group.shiftOpen = true;
    group.shiftNumber += 1;
    group.shiftOpenedAtMs = clock.now();
    group.documentsInShift = 0;
    const document = nextFiscalDocument(group, { transactionType: 'openShift', operationType: null, totalSum: null, shiftNumber: group.shiftNumber });
    return completeRequest(request, { ...document, shiftState: 'OPEN' });
  }
  if (request.transactionType === 'closeShift') {
    if (!group.shiftOpen) {
      return failRequest(request, {
        errorType: 'KKT',
        errorCode: 'SHIFT_NOT_OPEN',
        details: `Смена не открыта на кассе ${group.kkmRegId} — закрывать нечего`,
      });
    }
    const documents = group.documentsInShift;
    group.shiftOpen = false;
    group.shiftOpenedAtMs = 0;
    group.documentsInShift = 0;
    const document = nextFiscalDocument(group, { transactionType: 'closeShift', operationType: null, totalSum: null, shiftNumber: group.shiftNumber });
    return completeRequest(request, { ...document, shiftState: 'CLOSED', documentsInShift: documents });
  }
  if (request.transactionType === 'currentStateReport') {
    // Отчёт о текущем состоянии расчётов не является фискальным документом
    // ФФД и не попадает в /receipts ([VERIFY]: срез этого не уточняет).
    return completeRequest(request, {
      kkmRegId: group.kkmRegId,
      fiscalDriveNumber: group.fiscalDriveNumber,
      shiftNumber: group.shiftOpen ? group.shiftNumber : null,
      shiftState: group.shiftOpen ? 'OPEN' : 'CLOSED',
      documentsInShift: group.documentsInShift,
      reportDate: isoWithMs(clock.now()),
      responseType: 'CURRENT_STATE_REPORT',
    }, { fiscal: false });
  }
  const doc = request.request.document;
  const shiftNumber = group.shiftOpen ? group.shiftNumber : null;
  const document = nextFiscalDocument(group, {
    transactionType: request.transactionType,
    operationType: doc.operationType,
    totalSum: doc.totalSum,
    shiftNumber,
  });
  return completeRequest(request, {
    ...document,
    userInn: request.request.cashboxParameters.userInn,
    taxationType: doc.taxationType || null,
    correctionCause: doc.correctionCause,
    itemsCount: doc.items.length,
    items: doc.items.map((item) => ({
      label: item.label,
      measurementUnit: item.measurementUnit,
      price: item.price,
      quantity: item.quantity,
      vatCode: item.vatCode,
    })),
  });
}

function completeRequest(request, payload, { fiscal = true } = {}) {
  request.status = 'COMPLETED';
  request.error = null;
  request.payload = payload;
  request.finishedAtMs = clock.now();
  request.updatedAt = isoWithMs(request.finishedAtMs);
  if (fiscal) {
    state.documents[String(payload.fiscalDocumentNumber)] = {
      ...payload,
      requestId: request.requestId,
      externalId: request.externalId || null,
      userGroup: request.userGroup,
      createdAtMs: request.finishedAtMs,
    };
    request.documentNumber = payload.fiscalDocumentNumber;
  }
  persist();
  log(`заявка ${request.requestId} (${request.transactionType}): COMPLETED${fiscal ? `, ФД №${payload.fiscalDocumentNumber}` : ''}`);
  scheduleCallback(request, resultObject(request));
  return true;
}

/** Обработка «созревших» заявок. Вызывается тиком и лениво — на чтениях. */
function processDueRequests() {
  const now = clock.now();
  let processed = 0;
  for (const request of Object.values(state.requests)) {
    if (request.status !== 'IN_PROGRESS') continue;
    if (!request.dueAtMs || request.dueAtMs > now) continue;
    finishRequest(request);
    processed += 1;
  }
  return processed;
}

function tickFirstOfd() {
  const now = clock.now();
  // Истёкшие токены вычищаются лениво: TTL токена живёт на виртуальных часах.
  for (const [token, record] of Object.entries(state.tokens || {})) {
    if (record.expiresAtMs <= now) delete state.tokens[token];
  }
  return processDueRequests();
}

setInterval(() => {
  sandboxRuntime.tickAll(() => {
    tickFirstOfd();
    deliveryQueue.tick().catch((error) => log(`callback loop: ${error.message}`));
  });
}, 1000).unref();

if (SANDBOX_TTL_MS > 0 || SANDBOX_MAX_DOCUMENTS > 0 || SANDBOX_RETENTION_MS > 0) {
  setInterval(() => {
    const result = sandboxRuntime.sweep();
    if (result.expired) log(`sandbox sweep: удалено по TTL — ${result.expired}`);
  }, Math.max(1000, parseMsOr(process.env.MOCK_SANDBOX_SWEEP_MS, 60000))).unref();
}

/* ------------------------------------------------------- callback delivery */

/* Публичный срез НЕ фиксирует подпись, ACK и расписание повторов callback.
 * Мок не выдумывает HMAC/RSA: подписи нет вовсе; условие ACK «любой 2xx» и
 * график MOCK_FIRST_OFD_CALLBACK_RETRY_MS × _MAX_ATTEMPTS — локальная
 * договорённость мока [FORK], а не утверждение о протоколе Первого ОФД. */
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

/* ---------------------------------------------------- бизнес-обработчики */

function findRequest(requestId) {
  return state.requests[text(requestId)] || null;
}

function handleCreateTransaction(type, body, spec) {
  const quota = sandboxRuntime.checkDocuments();
  if (!quota.ok) {
    return errorOutcome(429, 'limit_exceeded', 'Лимит документов песочницы исчерпан', {
      field: 'requestId',
      hint: `${quota.kind === 'bytes' ? 'Исчерпана байтовая квота' : 'Исчерпана квота документов'} (${quota.used}/${quota.limit}); сбросьте эту песочницу или создайте новую.`,
    });
  }
  if (!Object.prototype.hasOwnProperty.call(TRANSACTION_TYPES, type)) {
    return errorOutcome(400, 'unknown_transaction_type', `Тип заявки «${type}» не поддерживается`, {
      field: 'type',
      hint: `Доступные типы: ${Object.keys(TRANSACTION_TYPES).join(', ')}. ATOL Online V5 (/api/external/possystem/v5/…) — другой API из тестового swagger, он вне области мока.`,
    });
  }
  const validated = validateTransactionRequest(type, body);
  if (!validated.ok) {
    return errorOutcome(validated.status, validated.code, validated.message, {
      field: validated.field,
      hint: validated.hint,
    });
  }
  const { requestMetadata } = validated.value;
  const previous = requestMetadata.externalId
    ? Object.values(state.requests).filter((entry) => entry.externalId === requestMetadata.externalId && entry.userGroup === requestMetadata.userGroup)
    : [];
  const now = clock.now();
  const requestId = crypto.randomUUID();
  const request = {
    requestId,
    transactionType: type,
    userGroup: requestMetadata.userGroup,
    externalId: requestMetadata.externalId,
    callbackUrl: requestMetadata.callbackUrl || '',
    status: 'IN_PROGRESS',
    error: null,
    payload: null,
    createdMs: now,
    createdAt: isoWithMs(now),
    updatedAt: isoWithMs(now),
    dueAtMs: now + PROCESS_MS,
    finishedAtMs: 0,
    documentNumber: null,
    scenarios: spec ? spec.raw : '',
    request: validated.value,
  };
  state.requests[requestId] = request;
  persist();
  // externalId: дедупликация публично НЕ подтверждена — мок не «схлопывает»
  // повторы: каждый вызов создаёт новую заявку со своим requestId ([VERIFY]).
  if (previous.length) {
    log(`заявка ${requestId}: externalId=${requestMetadata.externalId} уже встречался в группе ${requestMetadata.userGroup} (${previous.length} шт.) — мок создаёт НОВУЮ заявку; идемпотентность externalId не подтверждена [VERIFY]`);
  }
  log(`заявка ${requestId} принята: ${type}, группа ${requestMetadata.userGroup}, обработка через ${PROCESS_MS} мс виртуальных часов (статус IN_PROGRESS)`);
  return {
    status: 200,
    body: { requestId },
    headers: previous.length ? { 'X-Mock-Duplicate-External-Id': '1' } : {},
  };
}

function handleGetTransaction(requestId) {
  const request = findRequest(requestId);
  if (!request) {
    return errorOutcome(404, 'request_not_found', `Заявка «${requestId}» не найдена`, {
      field: 'requestId',
      hint: 'requestId выдаётся в ответе POST transaction/{type}; заявки не разделяются между песочницами.',
    });
  }
  processDueRequests();
  return { status: 200, body: transactionView(request) };
}

function handleGetStatus(requestId) {
  const request = findRequest(requestId);
  if (!request) {
    return errorOutcome(404, 'request_not_found', `Заявка «${requestId}» не найдена`, {
      field: 'requestId',
      hint: `Статус читается по requestId из ответа POST ${QUEUE_BASE}transaction/{type}.`,
    });
  }
  processDueRequests();
  return { status: 200, body: statusView(request) };
}

function handleGetStatuses(url) {
  const externalId = text(url.searchParams.get('externalId')).trim();
  const groupId = text(url.searchParams.get('groupId')).trim();
  const statusFilter = text(url.searchParams.get('status')).trim();
  // externalId и groupId обязательны по срезу.
  if (!externalId || !groupId) {
    return errorOutcome(400, 'missing_parameter', 'statuses требует обязательные параметры externalId и groupId', {
      field: externalId ? 'groupId' : 'externalId',
      hint: 'GET /api/external/queue/v1/statuses?externalId=…&groupId=… — оба параметра обязательны; status необязателен.',
    });
  }
  if (statusFilter && !Object.prototype.hasOwnProperty.call(QUEUE_STATUSES, statusFilter)) {
    return errorOutcome(400, 'invalid_request', `Параметр status=${JSON.stringify(statusFilter)} не поддерживается`, {
      field: 'status',
      hint: `Допустимые статусы очереди: ${Object.keys(QUEUE_STATUSES).join(', ')}.`,
    });
  }
  processDueRequests();
  const matched = Object.values(state.requests)
    .filter((entry) => entry.externalId === externalId && entry.userGroup === groupId)
    .filter((entry) => !statusFilter || entry.status === statusFilter)
    .sort((a, b) => a.createdMs - b.createdMs);
  // Envelope списка публично не зафиксирован: мок отдаёт массив статусов,
  // сохранять requestId для сверки ([VERIFY]).
  return { status: 200, body: matched.map((entry) => statusView(entry)) };
}

/** Дата/время фильтра: unix-число (с или мс) либо строка ISO 8601 [VERIFY]. */
function parseTimeParam(raw, { field }) {
  const value = text(raw).trim();
  if (!value) return { ok: false, message: `Параметр ${field} обязателен` };
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    const ms = numeric >= 1e12 ? numeric : numeric * 1000;
    if (!Number.isFinite(ms)) return { ok: false, message: `Параметр ${field}=${JSON.stringify(raw)} вне диапазона` };
    return { ok: true, ms };
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return {
      ok: false,
      message: `Параметр ${field}=${JSON.stringify(raw)} не разобран: ожидается unix-время или строка ISO 8601`,
      hint: 'Точная форма from/to в публичном срезе не зафиксирована ([VERIFY]); мок принимает unix и ISO 8601.',
    };
  }
  return { ok: true, ms: parsed };
}

function parsePageParam(raw, { field, fallback, max = 0 }) {
  const value = text(raw).trim();
  if (!value) return { ok: true, value: fallback };
  if (!/^\d+$/.test(value)) {
    return { ok: false, message: `Параметр ${field}=${JSON.stringify(raw)} должен быть целым положительным числом` };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return { ok: false, message: `Параметр ${field} должен быть не меньше 1` };
  }
  if (max && parsed > max) {
    return { ok: false, message: `Параметр ${field}=${parsed} превышает mock safety cap ${max}` };
  }
  return { ok: true, value: parsed };
}

function handleGetReceipts(url) {
  const from = parseTimeParam(url.searchParams.get('from'), { field: 'from' });
  if (!from.ok) {
    return errorOutcome(400, 'missing_parameter', from.message, {
      field: 'from',
      hint: 'GET /api/external/receipts?from=…&to=… — оба параметра обязательны; доступны фильтры transactionType, groupId, kkmRegId, page, pageSize.',
    });
  }
  const to = parseTimeParam(url.searchParams.get('to'), { field: 'to' });
  if (!to.ok) {
    return errorOutcome(400, 'missing_parameter', to.message, {
      field: 'to',
      hint: 'GET /api/external/receipts?from=…&to=… — оба параметра обязательны.',
    });
  }
  if (from.ms > to.ms) {
    return errorOutcome(400, 'invalid_request', 'Параметр from больше to', { field: 'from', hint: 'Диапазон задаётся как from ≤ to.' });
  }
  const transactionType = text(url.searchParams.get('transactionType')).trim();
  if (transactionType && !Object.prototype.hasOwnProperty.call(TRANSACTION_TYPES, transactionType)) {
    return errorOutcome(400, 'unknown_transaction_type', `Фильтр transactionType=${JSON.stringify(transactionType)} не поддерживается`, {
      field: 'transactionType',
      hint: `Доступные типы: ${Object.keys(TRANSACTION_TYPES).join(', ')}.`,
    });
  }
  const groupId = text(url.searchParams.get('groupId')).trim();
  const kkmRegId = text(url.searchParams.get('kkmRegId')).trim();
  const page = parsePageParam(url.searchParams.get('page'), { field: 'page', fallback: 1 });
  if (!page.ok) return errorOutcome(400, 'invalid_request', page.message, { field: 'page' });
  const pageSize = parsePageParam(url.searchParams.get('pageSize'), { field: 'pageSize', fallback: RECEIPTS_PAGE_SIZE_DEFAULT, max: RECEIPTS_PAGE_SIZE_MAX });
  if (!pageSize.ok) {
    return errorOutcome(400, 'invalid_request', pageSize.message, {
      field: 'pageSize',
      hint: `Дефолт мока — ${RECEIPTS_PAGE_SIZE_DEFAULT}, максимум — ${RECEIPTS_PAGE_SIZE_MAX} (mock safety cap).`,
    });
  }
  processDueRequests();
  const all = Object.values(state.documents)
    .filter((document) => document.createdAtMs >= from.ms && document.createdAtMs <= to.ms)
    .filter((document) => !transactionType || document.transactionType === transactionType)
    .filter((document) => !groupId || document.userGroup === groupId)
    .filter((document) => !kkmRegId || document.kkmRegId === kkmRegId)
    .sort((a, b) => a.createdAtMs - b.createdAtMs || a.fiscalDocumentNumber - b.fiscalDocumentNumber);
  const offset = (page.value - 1) * pageSize.value;
  const items = all.slice(offset, offset + pageSize.value).map((document) => ({
    requestId: document.requestId,
    externalId: document.externalId,
    userGroup: document.userGroup,
    transactionType: document.transactionType,
    fiscalDocumentNumber: document.fiscalDocumentNumber,
    fiscalDocumentSign: document.fiscalDocumentSign,
    fiscalDriveNumber: document.fiscalDriveNumber,
    kkmRegId: document.kkmRegId,
    shiftNumber: document.shiftNumber,
    documentDate: document.documentDate,
    operationType: document.operationType || null,
    totalSum: document.totalSum === undefined ? null : document.totalSum,
  }));
  // Envelope списка документов публично не зафиксирован: форма {items,total,…} —
  // локальная договорённость мока [FORK]/[VERIFY].
  return {
    status: 200,
    body: { items, total: all.length, page: page.value, pageSize: pageSize.value },
  };
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
    login: `firstofdsbx${crypto.randomBytes(4).toString('hex')}`,
    pass: crypto.randomUUID(),
  };
}

function handleSandboxApi(req, res, url, body) {
  const operator = sandboxRuntime.isOperatorRequest(req);
  if (req.method === 'GET') {
    if (TENANCY === 'owned' && !operator) {
      const own = sandboxRuntime.recordByOwnerToken(req);
      if (!own) return jsonRaw(res, 401, firstOfdError('invalid_token', 'Список песочниц доступен владельцу или оператору', { field: 'X-Sandbox-Token', hint: 'Owner-token выдаётся один раз при POST /sandboxes.' }));
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
          profile: 'first-ofd-okassa',
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
          hint: `Сохраните ownerToken и креды песочницы: они показываются один раз. Токен очереди живёт ${TOKEN_TTL_SECS} с; callback не подписан — сверяйте его методом статуса.`,
        }, 201);
      } catch (error) {
        return jsonRaw(res, error.code === 'SANDBOX_EXISTS' ? 409 : 429, firstOfdError('limit_exceeded', error.message, { hint: 'Проверьте MOCK_SANDBOX_MAX и MOCK_SANDBOX_CREATE_LIMIT.' }));
      }
    }
    const result = sandboxRuntime.switchActive((body && body.sandbox) || 'default');
    if (!result.ok) return jsonRaw(res, 400, firstOfdError('invalid_request', `Не удалось выбрать песочницу: ${result.error}`));
    return sendJson(res, { ok: true, current: result.current, sandboxes: sandboxRuntime.list() });
  }
  if (req.method === 'DELETE') {
    const target = String((body && body.sandbox) || url.searchParams.get('sandbox') || '');
    if (!target) return jsonRaw(res, 400, firstOfdError('invalid_request', 'Укажите sandbox для удаления'));
    const record = sandboxRuntime.find(target);
    if (!record) return jsonRaw(res, 404, firstOfdError('invalid_request', `Песочница «${target}» не найдена`));
    if (TENANCY === 'owned' && !operator && !sandboxRuntime.recordAuthorized(record, req)) {
      return jsonRaw(res, 401, firstOfdError('invalid_token', 'Удалить песочницу может её владелец или оператор'));
    }
    const result = sandboxRuntime.remove(target, req);
    if (!result.ok) return jsonRaw(res, result.error === 'unauthorized' ? 401 : 400, firstOfdError('invalid_request', `Не удалось удалить песочницу: ${result.error}`));
    return sendJson(res, { ok: true, removed: result.removed });
  }
  return jsonRaw(res, 405, firstOfdError('unsupported_method', `Метод ${req.method} для /sandboxes не поддерживается`));
}

function handleSandboxMe(req, res, p) {
  const record = sandboxRuntime.recordByOwnerToken(req) || (TENANCY === 'owned' ? null : sandboxRuntime.current());
  if (!record) return jsonRaw(res, 401, firstOfdError('invalid_token', 'Требуется owner-token песочницы', { field: 'X-Sandbox-Token', hint: 'Owner-token выдаётся при POST /sandboxes.' }));
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
    if (!result.ok) return jsonRaw(res, 400, firstOfdError('invalid_request', 'default-песочницу удалить нельзя'));
    return sendJson(res, { ok: true, removed: result.removed });
  }
  return jsonRaw(res, 405, firstOfdError('unsupported_method', `Метод ${req.method} для ${p} не поддерживается`));
}

function sandboxPolicy(p) {
  if (p === '/health' || p === '/openapi.json' || p === '/sandboxes' || p.startsWith('/sandboxes/')) return 'public';
  if (p.startsWith('/admin') || p.startsWith('/mock/')) return 'control';
  if (p.startsWith(API_BASE) || p === TOKEN_PATH) return 'business';
  return 'business';
}

function sendSandboxError(res, admission) {
  const id = admission.sandbox || 'default';
  if (admission.kind === 'not-found') return jsonRaw(res, 404, firstOfdError('invalid_request', `Песочница «${id}» не найдена`, { hint: 'Создайте песочницу: POST /sandboxes.' }));
  if (admission.kind === 'unauthorized') return jsonRaw(res, 401, firstOfdError('invalid_token', `Доступ к песочнице «${id}» ограничен: знание ID не является доступом`, { field: 'X-Sandbox-Token', hint: 'Передайте owner-token из POST /sandboxes: Authorization: Bearer <ownerToken>, X-Sandbox-Token или ?sandbox_token=.' }));
  if (admission.kind === 'expired') return jsonRaw(res, 410, firstOfdError('invalid_request', `Песочница «${id}» истекла по TTL`, { hint: 'Создайте новую песочницу через POST /sandboxes.' }));
  if (admission.kind === 'rate-limit' || admission.kind === 'limit') return jsonRaw(res, 429, firstOfdError('limit_exceeded', 'Лимит создания песочниц исчерпан'));
  return jsonRaw(res, 500, firstOfdError('system_error', 'Не удалось разрешить контекст песочницы'));
}

/* ---------------------------------------------------------- admin console */

function controlSurface(p) {
  if (p.startsWith('/admin')) return 'admin';
  if (p.startsWith('/mock/')) return 'operator';
  return null;
}

function page(content) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>first-ofd-mock — консоль</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:24px;background:#101418;color:#e8eef5}
h1,h2{font-weight:600}h2{margin-top:28px;font-size:16px;color:#9fc4ff}table{border-collapse:collapse;margin-top:8px}
td,th{border-bottom:1px solid #24303c;padding:4px 8px;text-align:left;vertical-align:top}code{background:#1b2430;padding:1px 4px;border-radius:4px}
.muted{color:#8fa3b8;font-size:13px}.err{color:#ffb4a2;font-size:13px;margin-top:6px}.logo{color:#7fd1ae;font-size:13px;letter-spacing:.08em;text-transform:uppercase}
button{width:auto;padding:5px 8px;font-size:12px;cursor:pointer}</style></head><body>${content}</body></html>`;
}

function sendPage(res, html, statusCode = 200) {
  return send(res, statusCode, html, { 'Content-Type': 'text/html; charset=utf-8' });
}

const esc = (value) => escapeHtml(value);

function adminButton(action, id, label, csrfToken, actionUrl) {
  return `<form method="POST" action="${esc(actionUrl)}" style="display:inline"><input type="hidden" name="_csrf" value="${esc(csrfToken)}"><input type="hidden" name="action" value="${esc(action)}"><input type="hidden" name="id" value="${esc(id)}"><button type="submit">${esc(label)}</button></form>`;
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
  const requests = Object.values(state.requests)
    .sort((a, b) => b.createdMs - a.createdMs)
    .slice(0, 40)
    .map((request) => {
      const actions = request.status === 'IN_PROGRESS'
        ? adminButton('process-request', request.requestId, 'обработать', csrf, actionUrl)
        : adminButton('redeliver-callback', request.requestId, 'callback', csrf, actionUrl);
      return `<tr><td><code>${esc(request.requestId.slice(0, 8))}</code></td><td>${esc(request.transactionType)}</td><td>${esc(request.userGroup)}</td><td>${esc(request.status)}</td><td>${esc(request.error ? `${request.error.errorType}/${request.error.errorCode}` : (request.documentNumber ? `ФД №${request.documentNumber}` : '—'))}</td><td><code>${esc(request.externalId || '—')}</code></td><td>${actions}</td></tr>`;
    }).join('') || '<tr><td colspan="7">заявок нет</td></tr>';
  const callbacks = Object.values(state.callbacks)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .slice(-20)
    .reverse()
    .map((entry) => {
      const state_ = entry.suppressed ? 'suppressed' : entry.dumped ? 'dumped' : entry.done ? 'delivered' : `retry@${entry.nextAttemptAt || 0}`;
      return `<tr><td>${esc(entry.id)}</td><td><code>${esc(entry.requestId.slice(0, 8))}</code></td><td>${esc(entry.transactionType)}</td><td>${entry.attempts}</td><td>${esc(state_)}</td><td>${esc(String(entry.lastStatus || '—'))}</td><td>${adminButton('duplicate-callback', entry.id, 'повторить', csrf, actionUrl)}</td></tr>`;
    }).join('') || '<tr><td colspan="7">callback не отправлялись</td></tr>';
  const groups = Object.values(state.groups).map((group) => (
    `<tr><td>${esc(group.groupId)}</td><td><code>${esc(group.kkmRegId)}</code></td><td><code>${esc(group.fiscalDriveNumber)}</code></td><td>${group.shiftNumber || '—'}</td><td>${group.shiftOpen ? 'OPEN' : 'CLOSED'}</td><td>${group.documentsInShift}</td></tr>`
  )).join('') || '<tr><td colspan="6">кассовых групп ещё не было</td></tr>';
  const journalRows = journal.list().slice(-15).reverse().map((entry) => (
    `<tr><td>${esc(String(entry.at).slice(11, 19))}</td><td>${esc(entry.method)}</td><td><code>${esc(entry.path)}</code></td><td>${entry.status}</td><td>${entry.ms} ms</td><td><code>${esc(String(entry.curl || '').slice(0, 100))}…</code></td></tr>`
  )).join('') || '<tr><td colspan="6">запросов ещё не было</td></tr>';
  return page(`
    <span class="logo">Первый ОФД · облачная касса OKassa · mock</span>
    <h1>Консоль стенда</h1>
    <div class="muted">Синтетические креды: ${esc(DEFAULT_LOGIN)} · токен TTL ${TOKEN_TTL_SECS} с (виртуальные часы) · обработка заявки ${PROCESS_MS} мс · callback: POST без подписи, ACK-условие 2xx [FORK] · ретраи ${CALLBACK_RETRY_MS} ms × ${CALLBACK_MAX_ATTEMPTS} · виртуальное время ${esc(clock.iso())} · sandbox ${esc(sandboxId)}</div>
    <div class="err">Операции INCOME / INCOME_RETURN / EXPENCE / EXPENCE_RETURN — написание EXPENCE как в схеме. Callback не подписан: сверяйте результат через GET status/{requestId}. externalId не гарантирует идемпотентность [VERIFY].</div>
    <h2>Заявки (последние 40)</h2><table style="width:100%;font-size:12px">${requests}</table>
    <h2>Кассовые группы (userGroup)</h2><table style="width:100%;font-size:12px">${groups}</table>
    <h2>Callbacks (последние 20)</h2><table style="width:100%;font-size:12px">${callbacks}</table>
    <h2>Журнал API — <a href="${esc(journalUrl)}">JSON</a></h2><table style="width:100%;font-size:12px">${journalRows}</table>`);
}

function adminAction(body) {
  const { action, id } = body || {};
  if (action === 'process-request') {
    const request = findRequest(id);
    if (request && request.status === 'IN_PROGRESS') {
      request.dueAtMs = clock.now() - 1;
      processDueRequests();
    }
  } else if (action === 'redeliver-callback') {
    const request = findRequest(id);
    if (request && request.status !== 'IN_PROGRESS') scheduleCallback(request, resultObject(request));
  } else if (action === 'duplicate-callback') {
    const original = state.callbacks[String(id)];
    if (original) {
      const copy = {
        ...original,
        id: String(state.counters.callbackId++),
        payload: { ...original.payload },
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

/* ------------------------------------------------------------- HTTP router */

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
function buildJsonCurl(req, p, raw) {
  const base = String(PUBLIC_BASE_URL).replace(/\/$/, '');
  const parts = [`curl -sS -X ${req.method} ${shellQuote(`${base}${p}`)}`, `-H ${shellQuote('Content-Type: application/json; charset=utf-8')}`];
  const auth = String((req.headers && req.headers.authorization) || '');
  if (auth) parts.push(`-H ${shellQuote(`Authorization: ${core.redactSecretsInText(auth)}`)}`);
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

function resolveRequestSpec(target, req, body, context = {}) {
  const header = (req && req.headers && req.headers['x-mock-scenario']) || '';
  return scenarios.resolve({
    header,
    bodyScenario: body && typeof body.mock_scenario === 'string' ? body.mock_scenario : '',
    target,
    context,
  });
}

function apiRoute(p, method) {
  if (p === RECEIPTS_PATH) return { name: 'receipts' };
  if (!p.startsWith(QUEUE_BASE)) return null;
  const rel = p.slice(QUEUE_BASE.length);
  if (rel === 'statuses') return { name: 'statuses' };
  const transaction = rel.match(/^transaction\/([^/]+)$/);
  if (transaction) {
    const value = decodeURIComponent(transaction[1]);
    if (method === 'POST') return { name: 'transaction-create', type: value };
    if (method === 'GET') return { name: 'transaction-read', id: value };
    return { name: 'transaction-any', value };
  }
  const status = rel.match(/^status\/([^/]+)$/);
  if (status) {
    const value = decodeURIComponent(status[1]);
    if (method === 'GET') return { name: 'status-read', id: value };
    return { name: 'status-any', value };
  }
  return { name: 'queue-unknown', rel };
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
      return jsonRaw(res, 401, firstOfdError('invalid_token', message, {
        field: surface === 'admin' ? 'Authorization' : 'X-Operator-Token',
        hint: `Передайте Authorization: Bearer <${envName}> или X-Operator-Token/X-Admin-Token.`,
      }));
    }
  }

  const isBusiness = p.startsWith(API_BASE) || p === TOKEN_PATH;
  if (isBusiness) {
    const originalWriteHead = res.writeHead.bind(res);
    const started = Date.now();
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
      return jsonRaw(res, chaos.abortStatus, firstOfdError('system_error', chaos.abortMessage, {
        hint: 'X-Mock-Scenario смоделировал транспортный сбой до операции с очередью; повторите запрос и сверьте состояние методом статуса.',
      }));
    }
  }

  if (req.method === 'GET' && p === '/openapi.json') {
    const specPath = path.join(__dirname, '..', '..', 'docs', 'openapi', 'first-ofd-mock.openapi.json');
    return sendJson(res, JSON.parse(fs.readFileSync(specPath, 'utf8')));
  }
  if (req.method === 'GET' && p === '/health') {
    const health = {
      ok: true,
      sandbox: sandboxRuntime.currentId(),
      tenancy: TENANCY,
      api: 'okassa-queue',
      base: QUEUE_BASE,
      tokenPath: TOKEN_PATH,
      tokenTtlSecs: TOKEN_TTL_SECS,
      tokenSingle: TOKEN_SINGLE,
      processMs: PROCESS_MS,
      transactionTypes: Object.keys(TRANSACTION_TYPES),
      queueStatuses: Object.keys(QUEUE_STATUSES),
      operations: Object.keys(OPERATIONS),
      callbackMethod: 'POST',
      callbackSignature: 'none',
      callbackRetryMs: CALLBACK_RETRY_MS,
      callbackMaxAttempts: CALLBACK_MAX_ATTEMPTS,
      callbackHttpsOnly: CALLBACK_HTTPS_ONLY,
      userGroups: USER_GROUPS_ANY ? '*' : USER_GROUPS,
    };
    if (TENANCY !== 'owned' || (admission.record.isDefault && !admission.record.ownerTokenHash) || admission.via === 'owner' || admission.via === 'operator') {
      Object.assign(health, {
        requests: Object.keys(state.requests).length,
        awaiting: Object.values(state.requests).filter((request) => request.status === 'IN_PROGRESS').length,
        documents: Object.keys(state.documents).length,
        callbacks: Object.keys(state.callbacks).length,
      });
    }
    return sendJson(res, health);
  }
  if (req.method === 'GET' && p === '/admin/journal') return sendJson(res, { entries: journal.list() });

  if (p === TOKEN_PATH) {
    const spec = resolveRequestSpec('token', req, body, {});
    if (spec.has('hang')) await new Promise(() => {});
    if (spec.has('fail')) {
      return jsonRaw(res, 500, firstOfdError('system_error', 'Системная ошибка getToken (смоделирована сценарием fail)', {
        hint: 'Сценарий fail не выдаёт токен; повторите запрос.',
      }));
    }
    return handleGetToken(req, res, raw, body, spec);
  }

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
        try { JSON.parse(raw); } catch { return jsonRaw(res, 400, firstOfdError('invalid_request', 'Снимок состояния не является валидным JSON', { field: 'state' })); }
      }
      const target = (body && body.sandbox) || admission.record.id;
      const snapshot = (body && body.state) || body || {};
      try {
        const imported = sandboxRuntime.importState(snapshot, target, req);
        if (!imported.ok) return sendSandboxError(res, { ok: false, kind: imported.error || 'unauthorized', sandbox: imported.sandbox || target });
        return sendJson(res, { ok: true, sandbox: imported.sandbox });
      } catch (error) {
        return jsonRaw(res, 400, firstOfdError('invalid_request', `Недопустимый снимок состояния: ${error.message}`, { field: 'state', hint: 'Опасные ключи __proto__, constructor и prototype запрещены.' }));
      }
    }
  }
  if (p === '/mock/time') {
    if (req.method === 'GET') return sendJson(res, clock.snapshot());
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        const snapshot = clock.set(body || {});
        tickFirstOfd();
        await deliveryQueue.tick();
        return sendJson(res, snapshot);
      } catch (error) {
        return jsonRaw(res, 400, firstOfdError('invalid_request', error.message, { field: 'advance|offset|iso', hint: 'Поля: advance (например "+2s"), offset (мс), iso (дата), reset (true).' }));
      }
    }
  }
  if (p === '/mock/scenarios') {
    if (req.method === 'GET') return sendJson(res, { rules: scenarios.listRules(), history: scenarios.listHistory() });
    if (req.method === 'POST') {
      try { return sendJson(res, { ok: true, rule: scenarios.addRule(body || {}) }); } catch (error) {
        const result = firstOfdError('invalid_request', error.message, { field: 'scenario', hint: 'Поля: scenario, target (transaction/receipt/receiptCorrection/openShift/closeShift/currentStateReport/token/status/statuses/receipts/*), match, times или persistent. Особые: kkt-error, api-error, getToken-error-quirk, webhook-drop, webhook-duplicate.' });
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
      return jsonRaw(res, 403, firstOfdError('invalid_token', 'Запрос заблокирован: отсутствует или неверен CSRF-токен', { field: '_csrf', hint: 'Откройте /admin и отправьте действие из формы консоли.' }));
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

  /* -------------------------------------------------------- OKassa API */
  if (p.startsWith(API_BASE)) {
    const matched = apiRoute(p, req.method);
    if (!matched || matched.name === 'queue-unknown') {
      return jsonRaw(res, 404, firstOfdError('not_found', `Неизвестный маршрут OKassa API: ${req.method} ${p}`, {
        hint: `Очередь — ${QUEUE_BASE}transaction/{type}, ${QUEUE_BASE}status/{requestId}, ${QUEUE_BASE}statuses; документы — ${RECEIPTS_PATH}.`,
        doc: '',
      }));
    }
    if (matched.name === 'transaction-create') {
      const spec = resolveRequestSpec('transaction', req, body, { type: matched.type, transactionType: matched.type });
      if (spec.has('hang')) await new Promise(() => {});
      if (spec.has('fail')) {
        return jsonRaw(res, 500, firstOfdError('system_error', 'Системная ошибка API очереди (смоделирована сценарием fail)', {
          hint: 'Сценарий fail не создаёт заявку; повторите запрос. Для ошибки обработки используйте сценарии kkt-error/api-error.',
        }));
      }
      const authError = verifyBearer(req);
      if (authError) return jsonRaw(res, authError.status, authError.body);
      const outcome = handleCreateTransaction(matched.type, body, spec);
      return jsonRaw(res, outcome.status, outcome.body, outcome.headers || {});
    }
    if (matched.name === 'transaction-read') {
      const authError = verifyBearer(req);
      if (authError) return jsonRaw(res, authError.status, authError.body);
      const outcome = handleGetTransaction(matched.id);
      return jsonRaw(res, outcome.status, outcome.body);
    }
    if (matched.name === 'status-read') {
      const authError = verifyBearer(req);
      if (authError) return jsonRaw(res, authError.status, authError.body);
      const outcome = handleGetStatus(matched.id);
      return jsonRaw(res, outcome.status, outcome.body);
    }
    if (matched.name === 'status-any') {
      return jsonRaw(res, 405, firstOfdError('unsupported_method', `Метод ${req.method} не поддерживается для status/{requestId}`, {
        hint: `Текущий статус читается GET ${QUEUE_BASE}status/{requestId}.`,
      }));
    }
    if (matched.name === 'transaction-any') {
      return jsonRaw(res, 405, firstOfdError('unsupported_method', `Метод ${req.method} не поддерживается для transaction/{type|requestId}`, {
        hint: `Создание заявки — POST ${QUEUE_BASE}transaction/{type}; чтение заявки — GET ${QUEUE_BASE}transaction/{requestId}.`,
      }));
    }
    if (matched.name === 'statuses') {
      if (req.method !== 'GET') {
        return jsonRaw(res, 405, firstOfdError('unsupported_method', `Метод ${req.method} не поддерживается для statuses`, {
          hint: `Список заявок по externalId и groupId читается GET ${QUEUE_BASE}statuses?externalId=…&groupId=….`,
        }));
      }
      const authError = verifyBearer(req);
      if (authError) return jsonRaw(res, authError.status, authError.body);
      const outcome = handleGetStatuses(url);
      return jsonRaw(res, outcome.status, outcome.body);
    }
    if (matched.name === 'receipts') {
      if (req.method !== 'GET') {
        return jsonRaw(res, 405, firstOfdError('unsupported_method', `Метод ${req.method} не поддерживается для /api/external/receipts`, {
          hint: `Документы за период читаются GET ${RECEIPTS_PATH}?from=…&to=….`,
        }));
      }
      const authError = verifyBearer(req);
      if (authError) return jsonRaw(res, authError.status, authError.body);
      const outcome = handleGetReceipts(url);
      return jsonRaw(res, outcome.status, outcome.body);
    }
  }

  return jsonRaw(res, 404, firstOfdError('not_found', `Неизвестный маршрут: ${req.method} ${p}`, {
    hint: `OKassa API начинается с ${API_BASE}; токен — POST ${TOKEN_PATH}; консоль — /admin.`,
    doc: '',
  }));
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    if (error && error.code === 'SANDBOX_EXPIRED') {
      try { sendSandboxError(res, { ok: false, kind: 'expired', sandbox: error.sandbox || 'default' }); } catch { /* headers sent */ }
      return;
    }
    if (error && error.code === 'BODY_TOO_LARGE') {
      try { jsonRaw(res, 413, firstOfdError('invalid_request', 'Размер тела запроса превышает допустимый лимит', { field: 'body', hint: `Уменьшите тело до ${error.maxBytes} байт или менее.` })); } catch { /* headers sent */ }
      return;
    }
    log(`request error: ${error && error.message ? error.message : 'unknown error'}`);
    try { jsonRaw(res, 500, firstOfdError('system_error', 'Внутренняя ошибка мок-стенда')); } catch { /* headers sent */ }
  });
});

restore();

if (require.main === module) {
  const port = Number(MOCK_PORT);
  server.listen(Number.isFinite(port) && port >= 0 ? port : 3107, MOCK_HOST, () => {
    const actualPort = server.address().port;
    log(`first-ofd-mock (Первый ОФД, облачная касса OKassa API) on http://${MOCK_HOST}:${actualPort}`);
    log(`creds: login=${credLogView(LOGIN_CRED, DEFAULT_LOGIN)} pass=${credLogView(PASS_CRED, DEFAULT_PASS)} (дефолты СИНТЕТИЧЕСКИЕ; фактические значения MOCK_FIRST_OFD_LOGIN/MOCK_FIRST_OFD_PASS в лог не попадают)`);
    log(`auth: POST ${TOKEN_PATH} (application/json; charset=utf-8, {login, pass}) → {token}; далее Authorization: Bearer <token>; TTL ${TOKEN_TTL_SECS} с на виртуальных часах${TOKEN_SINGLE ? '; повторная выдача аннулирует прежние токены' : ''}`);
    log(`queue: POST ${QUEUE_BASE}transaction/{${Object.keys(TRANSACTION_TYPES).join('|')}} → requestId; обработка ${PROCESS_MS} мс виртуальных часов; статусы ${Object.keys(QUEUE_STATUSES).join('/')}`);
    log(`read: GET ${QUEUE_BASE}transaction/{requestId}, GET ${QUEUE_BASE}status/{requestId}, GET ${QUEUE_BASE}statuses (externalId+groupId), GET ${RECEIPTS_PATH} (from+to)`);
    log(`callback: POST JSON без подписи на requestMetadata.callbackUrl; ACK-условие 2xx [FORK, не протокол] · retry ${CALLBACK_RETRY_MS}ms × ${CALLBACK_MAX_ATTEMPTS} (график — локальная договорённость мока)`);
    log(`operations: ${Object.keys(OPERATIONS).join(', ')} (написание EXPENCE как в схеме) · vatCode: ${Object.keys(VAT_CODES).join(', ')} · userGroup: ${USER_GROUPS_ANY ? 'любая непустая группа (MOCK_FIRST_OFD_USER_GROUPS=*)' : USER_GROUPS.join(', ')}`);
    log(`tenancy=${TENANCY} · hosted=${HOSTED} · block_private_webhooks=${BLOCK_PRIVATE_WEBHOOKS} · callback_https_only=${CALLBACK_HTTPS_ONLY}`);
    log('вне области: Ferma/АТОЛ-совместимость, тег ATOL Online V5 из тестового swagger Первого ОФД, production base и реальные креды, подпись/ретраи callback ([VERIFY])');
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
  processDueRequests,
  tickFirstOfd,
  API_BASE,
  QUEUE_BASE,
  TOKEN_PATH,
  RECEIPTS_PATH,
  TRANSACTION_TYPES,
  OPERATIONS,
  VAT_CODES,
  QUEUE_STATUSES,
  ERROR_LAYERS,
  HTTP_ERROR_CODES,
  KKT_ERROR_CODES,
  API_ERROR_CODES,
  statusView,
  transactionView,
};
