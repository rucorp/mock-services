// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * atol-mock — мок прямого API АТОЛ Онлайн v4 (issue #34, Stage 2 — первый
 * ВНЕШНИЙ касса-адаптер стенда).
 *
 * Контракт — прямой (direct) API АТОЛ Онлайн версии v4, ФФД 1.05:
 *   POST /possystem/v4/getToken
 *        {login, pass} -> {token}; токен живёт 24 часа и передаётся в заголовке Token
 *   POST /possystem/v4/{group}/{sell|sell_refund|sell_correction|buy|buy_refund|buy_correction}
 *        регистрация документа -> {uuid, status:"wait", ...}
 *   GET  /possystem/v4/{group}/report/{uuid}
 *        {uuid, status: wait|done|fail, error, payload(ФД/ФП, ФН/ККТ, ofd_receipt_url)}
 *   service.callback_url -> POST результата после обработки (done|fail)
 *
 * Источники (конспекты проекта):
 *   документации АТОЛ Онлайн v4
 *   документации АТОЛ Онлайн v4
 *   PDF API v4: https://atol.online/files/API_atol_online_v4.pdf (версия 5.15)
 *
 * ЧЕМ ОТЛИЧАЕТСЯ ОТ kassa-mock (Ferma) — НЕ drop-in, хотя часть имён похожа:
 *   1. база и версия маршрута: /possystem/v4/ (Ferma — /possystem/v1/);
 *   2. токен в заголовке `Token:` (Ferma — ?token= в query);
 *   3. токен живёт 24 часа (Ferma — 12);
 *   4. дедупликация external_id ВОЗВРАЩАЕТ ранее назначенный UUID, а не ошибку
 *      (Ferma-мок отвечает кодом 12 «уже существует»);
 *   5. суммы — decimal-рубли (Ferma-контракт — целые копейки);
 *   6. расчётные ставки НДС пишутся `vat120`/`vat122` (Ferma — `vat20_120`/`vat22_122`);
 *   7. callback: у v4 не документированы ни правило ACK, ни подпись, ни
 *      расписание повторов — обработчик обязан быть идемпотентным, а сверка
 *      идёт через report (у Ferma ACK/повторы описаны).
 *
 * ВНЕ ОБЛАСТИ (следующий шаг, не домысляем): v5 / ФФД 1.2, маркировка
 * «Честный ЗНАК», `permissive_mode`/`use_tspiot`/`tspiot_user_id`, проверка КМ.
 *
 * Ошибки — provider-shaped: {error:{code, text, type, error_id}} + DX-слой мока
 * (hint/field/doc). Zero npm dependencies. Конфигурация — env, см. README.md.
 * Все креды тестовые по построению; не выставляйте мок публично без защиты.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const core = require('../../packages/core');
const {
  readBody, parseBody, send, sendJson, escapeHtml, checkControlAccess,
  parseScenarioSpec, applyRequestChaos, createSandboxRuntime, resolveTenancyMode, parseMsOr,
} = core;

const log = core.createLog('atol-mock');

const {
  MOCK_HOST = '0.0.0.0',
  MOCK_PORT = '3103',
  MOCK_ATOL_LOGIN = '',
  ATOL_LOGIN = '',
  MOCK_ATOL_PASSWORD = '',
  ATOL_PASSWORD = '',
  MOCK_ATOL_GROUP = '',
  ATOL_GROUP = '',
  MOCK_GROUPS = '',
  // Токен v4 живёт 24 часа (0 — без истечения, только для отладки).
  MOCK_TOKEN_TTL_MS = String(24 * 60 * 60 * 1000),
  // Задержка wait -> done (очередь обработки документа на ККТ).
  MOCK_PROCESS_MS = '15000',
  MOCK_CALLBACK_RETRY_MS = '10000',
  MOCK_CALLBACK_MAX_ATTEMPTS = '24',
  MOCK_VALIDATE_RECEIPTS = 'true',
  MOCK_PUBLIC_BASE_URL = '',
  // Mock-расширение (не протокол): приёмник результата по умолчанию, если в
  // запросе нет service.callback_url. Полезно для compose-стенда.
  MOCK_DEFAULT_CALLBACK_URL = '',
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
  MOCK_SANDBOX_FILE = '',
} = process.env;

/*
 * Публичные тестовые реквизиты v4 (документации АТОЛ Онлайн v4,
 * https://atol.online/files/ffd/test_sreda.txt): login/pass/группа общего
 * тестового контура. Они открыты и предназначены только для тестов — поэтому
 * и взяты дефолтами мока; к production не применяются.
 */
const ATOL_LOGIN_CRED = MOCK_ATOL_LOGIN || ATOL_LOGIN || 'v4-online-atol-ru';
const ATOL_PASSWORD_CRED = MOCK_ATOL_PASSWORD || ATOL_PASSWORD || 'iGFFuihss';
const ATOL_GROUP_CRED = MOCK_ATOL_GROUP || ATOL_GROUP || 'v4-online-atol-ru_4179';
// Публичный адрес стенда: от него строится ofd_receipt_url в payload.
const PUBLIC_BASE_URL = String(MOCK_PUBLIC_BASE_URL || '').trim() || `http://localhost:${MOCK_PORT}`;

// ВАЖНО: не `parseInt(...) || N` — ноль (печатать мгновенно) тоже валидное
// значение (дефект A-10 в истории kassa-mock).
const parseMs = (raw, def) => {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
};
const TOKEN_TTL_MS = parseMs(MOCK_TOKEN_TTL_MS, 24 * 60 * 60 * 1000);
const PROCESS_MS = parseMs(MOCK_PROCESS_MS, 15000);
const CALLBACK_RETRY_MS = Math.max(1000, parseInt(MOCK_CALLBACK_RETRY_MS, 10) || 10000);
const CALLBACK_MAX_ATTEMPTS = Math.max(1, parseInt(MOCK_CALLBACK_MAX_ATTEMPTS, 10) || 24);
const VALIDATE_RECEIPTS = core.flagEnabled(MOCK_VALIDATE_RECEIPTS, true);

// Группа ККТ: дефолт — публичная тестовая группа v4; MOCK_GROUPS=Main,Shop-1
// разрешает несколько (опечатка в группе отклоняется, как на боевой кассе).
const GROUPS = [ATOL_GROUP_CRED, ...String(MOCK_GROUPS).split(',').map((g) => g.trim())]
  .filter(Boolean)
  .filter((g, i, all) => all.indexOf(g) === i);

// F-07/F-08: hosted включает fail-closed управляющей поверхности и SSRF-политику.
const HOSTED = core.flagEnabled(MOCK_HOSTED);
const OPERATOR_TOKEN = MOCK_OPERATOR_TOKEN || '';
const ADMIN_CSRF_SECRET = crypto.randomBytes(32).toString('hex');
const BLOCK_PRIVATE_WEBHOOKS = core.flagEnabled(MOCK_BLOCK_PRIVATE_WEBHOOKS, HOSTED);

// Фискальные реквизиты тестовой кассы (МГМ): документ не уходит в ФНС.
const FN_NUMBER = process.env.MOCK_FN_NUMBER || '9999078902001294';
const ECR_RN = process.env.MOCK_ECR_RN || '0001234567025896';
const OFD_INN = process.env.MOCK_OFD_INN || '7709359901';
const FNS_SITE = process.env.MOCK_FNS_SITE || 'www.nalog.gov.ru';
const OPERATOR_NAME = process.env.MOCK_OPERATOR || 'Кассир-мок';
const AGENT_LINE = process.env.MOCK_AGENT_LINE || 'ТЕСТОВАЯ КАССА АТОЛ (МОК)';
const AGENT_INN = process.env.MOCK_AGENT_INN || '5544332219';

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
 * Начальное состояние песочницы. `seed` уникален: числовые id (ФД/номер чека)
 * не совпадают между арендаторами.
 */
function createInitialAtolState({ seed = 0 } = {}) {
  return {
    counters: { fd: 50000 + seed * 1000000, check: 1 + seed * 1000, notification: 1 + seed * 1000 },
    tokens: {},        // token -> {login, createdAt}
    documents: {},     // uuid -> документ
    externalIds: {},   // `${group}\u0000${external_id}` -> uuid (дедуп в пределах группы)
    callbacks: {},     // id -> запись очереди callback
    clockOffsetMs: 0,
    kkt: {
      name: 'ATOL-MOCK-V4',
      shiftNumber: 12,
      ecrRegistrationNumber: ECR_RN,
      fnNumber: FN_NUMBER,
    },
  };
}

{
  const initial = createInitialAtolState();
  for (const key of Object.keys(initial)) {
    if (defaultState[key] === undefined) defaultState[key] = initial[key];
  }
}

/** Лимит документов песочницы (F-15): всё, что растёт от запросов интегратора. */
function countAtolDocuments(snapshot) {
  return ['documents', 'externalIds', 'callbacks', 'tokens']
    .reduce((sum, key) => sum + Object.keys(snapshot[key] || {}).length, 0);
}

/**
 * Retention (F-15, по умолчанию выключен): чистим только терминальные
 * диагностические записи (доставленные/исчерпанные callback) и мёртвые токены.
 * История документов — протокольная, её не удаляем.
 */
function atolRetention(snapshot, ts) {
  if (!SANDBOX_RETENTION_MS) return 0;
  const deadline = ts - SANDBOX_RETENTION_MS;
  let pruned = 0;
  for (const [id, cb] of Object.entries(snapshot.callbacks || {})) {
    const finished = cb && (cb.done || cb.dumped || cb.suppressed);
    const at = Date.parse((cb && (cb.finishedAt || cb.createdAt)) || '') || 0;
    if (finished && at && at <= deadline) {
      delete snapshot.callbacks[id];
      pruned += 1;
    }
  }
  for (const [token, meta] of Object.entries(snapshot.tokens || {})) {
    const createdAt = (meta && meta.createdAt) || 0;
    if (createdAt && TOKEN_TTL_MS > 0 && createdAt + TOKEN_TTL_MS <= ts - SANDBOX_RETENTION_MS) {
      delete snapshot.tokens[token];
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
  initialStateFactory: createInitialAtolState,
  mode: TENANCY,
  hosted: HOSTED,
  stateFile: MOCK_STATE_FILE,
  sandboxFile: String(MOCK_SANDBOX_FILE || ''),
  ttlMs: SANDBOX_TTL_MS,
  maxSandboxes: SANDBOX_MAX,
  maxDocuments: SANDBOX_MAX_DOCUMENTS,
  maxStateBytes: parseMsOr(MOCK_SANDBOX_MAX_STATE_BYTES, null),
  globalMaxStateBytes: parseMsOr(MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES, null),
  documentCounter: countAtolDocuments,
  retention: atolRetention,
  defaultOwnerToken: SANDBOX_OWNER_TOKEN,
  hostSuffix: SANDBOX_HOST_SUFFIX,
  operatorTokens: [MOCK_ADMIN_TOKEN, OPERATOR_TOKEN],
  createLimit: SANDBOX_CREATE_LIMIT,
  onSandboxRemoved: (record) => dropSandboxChildState(record),
  log: (msg) => console.error(`[atol-mock] ${msg}`),
});

const state = sandboxRuntime.state;
const persist = sandboxRuntime.persist;

// Журнал — per-sandbox раздел записи текущей песочницы (PB-13, #52).
const journal = core.createJournal({ size: 200, sandboxScope: () => sandboxRuntime.current() });

/* --------------------------------------------------- креды песочницы (F-12) */

/**
 * В owned-режиме у каждой песочницы свои login/pass/группа АТОЛ (интегратор
 * проходит тот же путь, что в бою: «впиши свои реквизиты кабинета»). В
 * остальных режимах — реквизиты стенда, поэтому self-hosted поведение не меняется.
 */
const atolLogin = () => sandboxRuntime.creds().atolLogin || ATOL_LOGIN_CRED;
const atolPassword = () => sandboxRuntime.creds().atolPassword || ATOL_PASSWORD_CRED;
const atolGroup = () => sandboxRuntime.creds().atolGroup || null;

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

/* ------------------------------------------------- реквизиты ФФД 1.05 (v4) */

// Признак способа расчёта (ФФД тег 1214).
const PAYMENT_METHODS = [
  'full_prepayment', 'partial_prepayment', 'advance', 'full_payment',
  'partial_payment', 'credit', 'credit_payment', 'consideration',
];

// Признак предмета расчёта (ФФД тег 1212). Маркировочные значения в v4 не
// обрабатываем: код маркировки и проверка КМ — это v5/ФФД 1.2 (вне задачи).
const PAYMENT_OBJECTS = [
  'commodity', 'excise', 'job', 'service', 'gambling_bet', 'gambling_prize',
  'lottery', 'lottery_prize', 'intellectual_activity', 'payment',
  'agent_commission', 'composite', 'another', 'property_right',
  'non_operating_gain', 'insurance_premium', 'sales_tax', 'resort_fee',
  'deposit', 'expense', 'pension_insurance_ip', 'pension_insurance',
  'medical_insurance_ip', 'medical_insurance', 'social_insurance',
  'casino_payment',
];

/**
 * Ставки НДС v4 (ФФД 1.05). Базовые — vat0/vat5/vat7/vat10/vat20 и `none`;
 * расчётные (НДС в составе суммы) у АТОЛ пишутся БЕЗ подчёркивания:
 * `vat105` (5/105), `vat107` (7/107), `vat110` (10/110), `vat120` (20/120),
 * `vat122` (22/122) — см. документации АТОЛ Онлайн v4 и
 * https://help.atol.online/article/26152. Синтаксис Ferma (`vat20_120`) в v4
 * не принимается — мок объясняет это в hint.
 */
const VAT_META = {
  none: { rate: 0, calc: false, label: 'без НДС' },
  vat0: { rate: 0, calc: false, label: '0%' },
  vat5: { rate: 5, calc: false, label: '5%' },
  vat7: { rate: 7, calc: false, label: '7%' },
  vat10: { rate: 10, calc: false, label: '10%' },
  vat20: { rate: 20, calc: false, label: '20%' },
  vat22: { rate: 22, calc: false, label: '22%' },
  vat105: { rate: 5, calc: true, label: '5/105' },
  vat107: { rate: 7, calc: true, label: '7/107' },
  vat110: { rate: 10, calc: true, label: '10/110' },
  vat120: { rate: 20, calc: true, label: '20/120' },
  vat122: { rate: 22, calc: true, label: '22/122' },
};
const VAT_TYPES = Object.keys(VAT_META);
// Ferma-подобный синтаксис расчётных ставок — для внятного отказа, не для приёма.
const VAT_FERMA_SYNTAX = ['vat5_105', 'vat7_107', 'vat10_110', 'vat20_120', 'vat22_122'];

/**
 * Форма расчёта `payments[].type` — ФФД тег 1081:
 * 0 наличные, 1 электронными, 2 предварительная оплата (аванс),
 * 3 постоплата (кредит), 4 встречное предоставление.
 */
const PAYMENT_TYPES = [0, 1, 2, 3, 4];
const PAYMENT_TYPE_LABELS = {
  0: 'НАЛИЧНЫМИ',
  1: 'ЭЛЕКТРОННЫМИ',
  2: 'ПРЕДОПЛАТА (АВАНС)',
  3: 'ПОСТОПЛАТА (КРЕДИТ)',
  4: 'ВСТРЕЧНОЕ ПРЕДОСТАВЛЕНИЕ',
};

// Система налогообложения (ФФД тег 1055).
const SNO_TYPES = ['osn', 'usn_income', 'usn_income_outcome', 'envd', 'esn', 'patent'];

const OPERATIONS = ['sell', 'sell_refund', 'sell_correction', 'buy', 'buy_refund', 'buy_correction'];

const OPERATION_LABELS = {
  sell: 'КАССОВЫЙ ЧЕК · ПРИХОД',
  sell_refund: 'КАССОВЫЙ ЧЕК · ВОЗВРАТ ПРИХОДА',
  sell_correction: 'ЧЕК КОРРЕКЦИИ · ПРИХОД',
  buy: 'КАССОВЫЙ ЧЕК · РАСХОД',
  buy_refund: 'КАССОВЫЙ ЧЕК · ВОЗВРАТ РАСХОДА',
  buy_correction: 'ЧЕК КОРРЕКЦИИ · РАСХОД',
};

const PAYMENT_METHOD_LABELS = {
  full_prepayment: 'ПРЕДОПЛАТА 100%',
  partial_prepayment: 'ПРЕДОПЛАТА',
  advance: 'АВАНС',
  full_payment: 'ПОЛНЫЙ РАСЧЁТ',
  partial_payment: 'ЧАСТИЧНЫЙ РАСЧЁТ И КРЕДИТ',
  credit: 'КРЕДИТ',
  credit_payment: 'ВЫПЛАТА ПО КРЕДИТУ',
  consideration: 'ЗАЧЁТ АВАНСА',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?\d{10,15}$/;
const INN_RE = /^\d{10}$|^\d{12}$/;
// `timestamp` внешней системы: dd.mm.yyyy HH:MM:SS.
const TIMESTAMP_RE = /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/;
const DECIMAL2_RE = /^\d{1,9}(\.\d{1,2})?$/;
const DECIMAL3_RE = /^\d{1,7}(\.\d{1,3})?$/;
const EXTERNAL_ID_MAX = 128;
const ITEM_NAME_MAX = 128;

/* ------------------------------------------------------ decimal-рубли (v4) */

/**
 * Сумма в рублях -> копейки. v4 принимает decimal («в рублях с копейками»);
 * JSON-число и decimal-строка равноправны — это осознанная толерантность мока,
 * задокументирована в README («Границы и форки»). Больше 2 знаков — отказ.
 */
function rublesToKopecks(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    const scaled = raw * 100;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-6) return null;
    const k = Math.round(scaled);
    return Number.isSafeInteger(k) ? k : null;
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!DECIMAL2_RE.test(s)) return null;
    const [intPart, fracRaw = ''] = s.split('.');
    const k = parseInt(intPart, 10) * 100 + parseInt(`${fracRaw}00`.slice(0, 2), 10);
    return Number.isSafeInteger(k) ? k : null;
  }
  return null;
}

/** Количество позиции: до 3 знаков (вес/объём), строго > 0. */
function parseQuantity(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const scaled = raw * 1000;
    return Math.abs(scaled - Math.round(scaled)) > 1e-6 ? null : raw;
  }
  if (typeof raw === 'string' && DECIMAL3_RE.test(raw.trim())) {
    const v = parseFloat(raw.trim());
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  return null;
}

const rubles = (kopecks) => (kopecks / 100).toFixed(2);

/* ----------------------------------------------------------- DX-ошибки v4 */

/*
 * ФОРМАТ: {error:{code, text, type, error_id}} — как описано в конспекте
 * («Ошибка передаётся в error: код, текст, тип и идентификатор»).
 *
 * ЧИСЛОВЫЕ КОДЫ: в снятом конспекте v4 таблица кодов НЕ приведена. Мок
 * использует общую таблицу кодов платформы АТОЛ/Ferma — ту же, что реализована
 * в kassa-mock (4/5/10/11/14/57). Сверка с PDF API v4 (версия 5.15) не
 * проводилась: это зафиксировано в README («Границы и форки») и в отчёте PR.
 */
const derr = core.createErrorCatalog({
  provider: 'atol-online-v4',
  docsBase: 'https://help.atol.online',
  codes: {
    4: {
      message: 'Неверный формат запроса',
      field: 'body',
      hint: 'Тело — не валидный JSON либо нарушены реквизиты ФФД 1.05 (client, company, items, payments, total, НДС). Сверьтесь с docs/integration/atol.md и PDF API v4.',
      doc: '/article/11244',
    },
    5: {
      message: 'Не передан обязательный параметр',
      field: 'external_id',
      hint: 'Передайте external_id — строковый идентификатор вашей системы, уникальный в пределах группы (до 128 символов). По нему работает дедупликация.',
      doc: '/article/11244',
    },
    10: {
      message: 'Документ не найден',
      field: 'uuid',
      hint: 'uuid не существует в этой группе. Отчёт доступен только по UUID, полученному при регистрации документа: GET /possystem/v4/{group}/report/{uuid}.',
      doc: '/article/11244',
    },
    11: {
      message: 'Не выполнена авторизация',
      field: 'Token',
      hint: 'Получите токен (POST /possystem/v4/getToken) и передавайте его заголовком `Token: <token>`. Токен живёт 24 часа — по истечении нужен новый getToken.',
      doc: '/article/11244',
    },
    14: {
      message: 'Неверный логин или пароль',
      field: 'login, pass',
      hint: 'Тестовые реквизиты v4: login/pass/группа из документации АТОЛ Онлайн v4 Дефолты стенда печатаются в стартовом логе; переопределяются MOCK_ATOL_LOGIN / MOCK_ATOL_PASSWORD.',
      doc: '/article/11254',
    },
    57: {
      message: 'Отказ печати фискального документа',
      field: 'external_id',
      hint: 'Управляемый отказ ККТ: external_id с префиксом «fail-» или заголовок X-Mock-Scenario: fail. Снимите сценарий для нормального флоу.',
      doc: '/article/11244',
    },
    404: { message: 'Неизвестный маршрут', hint: 'Список маршрутов — /admin и README сервиса.', doc: '' },
    500: { message: 'Внутренняя ошибка мок-стенда', hint: 'Смотрите лог сервиса; воспроизводится — это дефект мока, заводите issue.', doc: '' },
  },
});

/**
 * Ошибка в форме v4. `type` — business (отказ по данным/авторизации) или
 * system (внутренний сбой); точный набор типов в конспекте не снят — см. README.
 */
function aerr(code, text, overrides = {}) {
  const desc = derr(code, { message: typeof text === 'string' ? text : undefined, ...overrides });
  return {
    error: {
      code,
      text: desc.message,
      type: overrides.type || (code === 500 ? 'system' : 'business'),
      error_id: crypto.randomUUID(),
      field: desc.field || undefined,
      hint: desc.hint || undefined,
      doc: desc.doc || undefined,
    },
    timestamp: clock.iso(),
  };
}

function aerrBody(code, text, overrides = {}) {
  return JSON.stringify(aerr(code, text, overrides));
}

/** Ответ готовой JSON-строкой (aerrBody уже стрингифицирован). */
function jsonRaw(res, code, body) {
  send(res, code, body, { 'Content-Type': 'application/json; charset=utf-8' });
}

/* ------------------------------------------------------- авторизация (v4) */

/**
 * Токен из заголовка `Token` — отличие v4 от Ferma (?token= в query).
 * Проверка живёт на виртуальных часах: TTL 24 часа, затем нужен новый getToken.
 */
function tokenFromHeader(req) {
  const raw = req.headers && req.headers.token;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || '').trim();
}

/** @returns {{ok:true, token:string} | {ok:false, reason:'missing'|'unknown'|'expired'}} */
function checkToken(req) {
  const token = tokenFromHeader(req);
  if (!token) return { ok: false, reason: 'missing' };
  const session = state.tokens[token];
  if (!session) return { ok: false, reason: 'unknown' };
  const age = clock.now() - (session.createdAt || 0);
  if (TOKEN_TTL_MS > 0 && age > TOKEN_TTL_MS) {
    delete state.tokens[token];
    persist();
    log(`токен истёк (возраст ${Math.round(age / 1000)} c > TTL ${Math.round(TOKEN_TTL_MS / 1000)} c) — нужен новый getToken`);
    return { ok: false, reason: 'expired', ageMs: age };
  }
  return { ok: true, token };
}

/** Ответ на отказ авторизации: код 11, но с разным DX-объяснением. */
function authErrorBody(reason, ageMs = 0) {
  if (reason === 'expired') {
    return aerrBody(11, 'Срок действия токена истёк (24 часа)', {
      field: 'Token',
      hint: `Токен прожил ${Math.round(ageMs / 3600000)} ч и истёк: запросите новый (POST /possystem/v4/getToken). На стенде это ускоряется виртуальными часами — POST /mock/time {"advance":"+25h"}.`,
    });
  }
  if (reason === 'unknown') {
    return aerrBody(11, 'Токен не найден или отозван', {
      field: 'Token',
      hint: 'Токен выдаётся только в POST /possystem/v4/getToken. После рестарта стенда с пустым MOCK_STATE_FILE старые токены недоступны — получите новый.',
    });
  }
  return aerrBody(11, 'Не передан заголовок Token', {
    field: 'Token',
    hint: 'В v4 токен передаётся ЗАГОЛОВКОМ `Token: <token>` (в отличие от Ferma, где токен идёт в ?token=). Получите его в POST /possystem/v4/getToken.',
  });
}

/* ------------------------------------------------------ валидация чека v4 */

/**
 * Валидация реквизитов ФФД 1.05 ДО регистрации документа: API валидирует
 * реквизиты чека, а не только JSON. Возвращает {field, hint, doc} или null.
 */
function validateReceipt(receipt, body = {}) {
  const bad = (field, hint, doc = '/article/11244') => ({ field, hint, doc });

  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return bad('receipt', 'Передайте объект receipt: {client, company, items[], payments[], total} (см. docs/integration/atol.md).');
  }

  /* -- timestamp внешней системы (необязательное поле, формат фиксирован) -- */
  if (body.timestamp !== undefined && body.timestamp !== null) {
    if (typeof body.timestamp !== 'string' || !TIMESTAMP_RE.test(body.timestamp.trim())) {
      return bad('timestamp', `timestamp внешней системы задаётся строкой «dd.mm.yyyy HH:MM:SS» (получено ${JSON.stringify(body.timestamp)}).`, '/article/11244');
    }
  }

  /* ----------------------------- client: хотя бы email или телефон (v4) -- */
  const client = receipt.client;
  if (client !== undefined && client !== null) {
    if (typeof client !== 'object' || Array.isArray(client)) {
      return bad('receipt.client', 'client — объект {email?, phone?, name?}.');
    }
    const email = client.email === undefined || client.email === null ? '' : String(client.email).trim();
    const phone = client.phone === undefined || client.phone === null ? '' : String(client.phone).trim();
    if (!email && !phone) {
      return bad('receipt.client', 'В v4 у покупателя обязателен хотя бы один контакт для доставки чека: client.email ИЛИ client.phone. Оба поля пустые.', '/article/11244');
    }
    if (email && !EMAIL_RE.test(email)) {
      return bad('receipt.client.email', `Некорректный e-mail покупателя «${email}». Проверьте формат — ОФД не доставит чек на битый адрес.`, '/article/11244');
    }
    if (phone && !PHONE_RE.test(phone.replace(/[\s()-]/g, ''))) {
      return bad('receipt.client.phone', `Некорректный телефон покупателя «${phone}». Ожидается 10–15 цифр, допустим ведущий «+».`, '/article/11244');
    }
  }

  /* ------------------------------------------- company: ИНН, адрес, e-mail -- */
  const company = receipt.company;
  if (!company || typeof company !== 'object' || Array.isArray(company)) {
    return bad('receipt.company', 'Передайте объект company: {email, inn, payment_address, sno?} — реквизиты юрлица/ИП из чека (ФФД 1018/1009).');
  }
  if (company.email === undefined || !EMAIL_RE.test(String(company.email || '').trim())) {
    return bad('receipt.company.email', 'company.email обязателен и должен быть валидным e-mail: на него ОФД отправляет копию чека.', '/article/11244');
  }
  if (typeof company.inn !== 'string' && typeof company.inn !== 'number') {
    return bad('receipt.company.inn', 'company.inn обязателен (ФФД тег 1018): 10 цифр для ЮЛ или 12 для ИП.', '/article/11244');
  }
  if (!INN_RE.test(String(company.inn).trim())) {
    return bad('receipt.company.inn', `ИНН «${company.inn}» должен состоять из 10 (ЮЛ) или 12 (ИП) цифр (ФФД тег 1018).`, '/article/11244');
  }
  if (!company.payment_address || typeof company.payment_address !== 'string' || !company.payment_address.trim()) {
    return bad('receipt.company.payment_address', 'company.payment_address обязателен (ФФД тег 1009): адрес расчётов, например «https://v4.online.atol.ru».');
  }
  if (company.sno !== undefined && company.sno !== null) {
    if (!SNO_TYPES.includes(company.sno)) {
      return bad('receipt.company.sno', `Неизвестная система налогообложения ${JSON.stringify(company.sno)}. Допустимо: ${SNO_TYPES.join(', ')} (ФФД тег 1055).`, '/article/11244');
    }
  }

  /* ------------------------------------------------------------- items[] -- */
  const items = receipt.items;
  if (!Array.isArray(items) || !items.length) {
    return bad('receipt.items', 'Нужен непустой массив позиций: [{name, price, quantity, sum, payment_method?, payment_object?, vat}]. Суммы — в рублях (decimal).');
  }

  let itemsSumK = 0;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i] || {};
    const at = `receipt.items[${i}]`;

    if (!it.name || typeof it.name !== 'string' || !it.name.trim()) {
      return bad(`${at}.name`, 'Название позиции — непустая строка (её увидит покупатель в чеке).');
    }
    if (it.name.length > ITEM_NAME_MAX) {
      return bad(`${at}.name`, `Название позиции длиннее ${ITEM_NAME_MAX} символов (${it.name.length}) — ККТ обрежет/отклонит реквизит.`);
    }

    const priceK = rublesToKopecks(it.price);
    if (priceK === null || priceK <= 0) {
      return bad(`${at}.price`, `Цена — decimal в рублях, не более 2 знаков и больше нуля (получено ${JSON.stringify(it.price)}). Пример: 100.00 или "100.00".`, '/article/11244');
    }

    const qty = parseQuantity(it.quantity);
    if (qty === null) {
      return bad(`${at}.quantity`, `Количество — число больше нуля, до 3 знаков (получено ${JSON.stringify(it.quantity)}).`);
    }

    const sumK = rublesToKopecks(it.sum);
    if (sumK === null) {
      return bad(`${at}.sum`, `Сумма позиции — decimal в рублях, не более 2 знаков (получено ${JSON.stringify(it.sum)}).`);
    }
    // Арифметику ККТ сверяет сама: допуск 1 копейка — округление при дробном количестве.
    if (Math.abs(sumK - priceK * qty) > 1) {
      return bad(`${at}.sum`, `Сумма позиции ${it.sum} ≠ price × quantity = ${rubles(Math.round(priceK * qty * 100) / 100)} (${priceK / 100} × ${qty}). Касса сверяет арифметику сама.`, '/article/11244');
    }

    const vatValue = it.vat && typeof it.vat === 'object' ? it.vat.type : it.vat;
    if (vatValue === undefined || vatValue === null || vatValue === '') {
      return bad(`${at}.vat`, `Укажите ставку НДС позиции. Допустимо: ${VAT_TYPES.join(', ')}.`, '/article/26152');
    }
    if (VAT_FERMA_SYNTAX.includes(vatValue)) {
      const mapped = vatValue.replace(/_(\d+)$/, '$1');
      return bad(`${at}.vat`, `«${vatValue}» — синтаксис облачных касс Ferma. В прямом API АТОЛ v4 расчётная ставка пишется слитно: «${mapped}» (например, 20/120 — это vat120).`, '/article/26152');
    }
    if (!VAT_TYPES.includes(vatValue)) {
      return bad(`${at}.vat`, `Неизвестная ставка НДС ${JSON.stringify(vatValue)}. Допустимо: ${VAT_TYPES.join(', ')} (базовые и расчётные вида vat110/vat120/vat122).`, '/article/26152');
    }

    if (it.payment_method !== undefined && !PAYMENT_METHODS.includes(it.payment_method)) {
      return bad(`${at}.payment_method`, `Неизвестный признак способа расчёта ${JSON.stringify(it.payment_method)}. Допустимо: ${PAYMENT_METHODS.join(', ')} (ФФД тег 1214).`, '/article/11244');
    }
    if (it.payment_object !== undefined && !PAYMENT_OBJECTS.includes(it.payment_object)) {
      return bad(`${at}.payment_object`, `Неизвестный признак предмета расчёта ${JSON.stringify(it.payment_object)}. Допустимо: ${PAYMENT_OBJECTS.join(', ')} (ФФД тег 1212).`, '/article/11244');
    }
    if (it.measure !== undefined && it.measure !== null && !['piece', 'gram', 'kilogram', 'ton', 'milliliter', 'liter', 'cubic_meter'].includes(it.measure)) {
      return bad(`${at}.measure`, `Неизвестная мера количества ${JSON.stringify(it.measure)}. Мок принимает: piece, gram, kilogram, ton, milliliter, liter, cubic_meter.`);
    }

    itemsSumK += sumK;
  }

  /* -------------------------------------------------------------- total -- */
  const totalK = rublesToKopecks(receipt.total);
  if (totalK === null || totalK <= 0) {
    return bad('receipt.total', 'Итог чека — decimal в рублях, не более 2 знаков и больше нуля.');
  }
  if (Math.abs(totalK - itemsSumK) > 1) {
    return bad('receipt.total', `Итог ${receipt.total} ≠ сумме позиций ${rubles(itemsSumK)}. Проверьте арифметику до отправки — касса сверяет суммы сама.`);
  }

  /* ---------------------------------------------------------- payments[] -- */
  const payments = receipt.payments;
  if (!Array.isArray(payments) || !payments.length) {
    return bad('receipt.payments', 'Нужен непустой массив оплат: [{type, sum}] — даже при оплате одним способом.');
  }
  let paymentsSumK = 0;
  for (let i = 0; i < payments.length; i += 1) {
    const pay = payments[i] || {};
    if (!PAYMENT_TYPES.includes(pay.type)) {
      if (pay.type === 5) {
        return bad(`receipt.payments[${i}].type`, 'type=5 (наличные) — синтаксис Ferma. В прямом API АТОЛ v4 форма расчёта — ФФД тег 1081: 0 наличные, 1 электронными, 2 аванс, 3 кредит, 4 встречное предоставление.', '/article/11244');
      }
      return bad(`receipt.payments[${i}].type`, `Неизвестная форма расчёта ${JSON.stringify(pay.type)}. ФФД тег 1081: ${PAYMENT_TYPES.map((t) => `${t} — ${PAYMENT_TYPE_LABELS[t].toLowerCase()}`).join(', ')}.`, '/article/11244');
    }
    const paySumK = rublesToKopecks(pay.sum);
    if (paySumK === null || paySumK <= 0) {
      return bad(`receipt.payments[${i}].sum`, 'Сумма оплаты — decimal в рублях, не более 2 знаков и больше нуля.');
    }
    paymentsSumK += paySumK;
  }
  if (Math.abs(paymentsSumK - totalK) > 1) {
    return bad('receipt.payments', `Σ оплат ${rubles(paymentsSumK)} ≠ итогу ${receipt.total}. Смешанная оплата (нал + карта, аванс + доплата) должна сходиться в копейку.`);
  }

  /* --------------------------------------------------------- correction -- */
  const corr = body.correction_info || receipt.correction_info;
  if (corr !== undefined && corr !== null) {
    if (typeof corr !== 'object' || Array.isArray(corr)) {
      return bad('correction_info', 'Для чека коррекции передайте объект correction_info: {type: "self"|"instruction", base_date: "dd.mm.yyyy", base_number?}.', '/article/11244');
    }
    if (corr.type !== undefined && !['self', 'instruction'].includes(corr.type)) {
      return bad('correction_info.type', `Неизвестный тип коррекции ${JSON.stringify(corr.type)}. Допустимо: 'self' (самостоятельно), 'instruction' (по предписанию ФНС).`, '/article/11244');
    }
    if (corr.base_date !== undefined && !/^\d{2}\.\d{2}\.\d{4}$/.test(String(corr.base_date || ''))) {
      return bad('correction_info.base_date', `Дата документа-основания — строка «dd.mm.yyyy» (получено ${JSON.stringify(corr.base_date)}).`, '/article/11244');
    }
  }

  return null;
}

/* -------------------------------------------------- фискальный снимок (ФД) */

/** Итоги по ставкам НДС: сумма с НДС и налог (расчётные ставки — «в составе»). */
function computeVatBreakdown(items) {
  const acc = {};
  for (const item of items || []) {
    const type = (item.vat && typeof item.vat === 'object' ? item.vat.type : item.vat) || 'none';
    const sumK = rublesToKopecks(item.sum) || 0;
    acc[type] = (acc[type] || 0) + sumK;
  }
  return Object.entries(acc).map(([type, grossK]) => {
    const meta = VAT_META[type] || VAT_META.none;
    const taxK = meta.rate ? Math.round((grossK * meta.rate) / (100 + meta.rate)) : 0;
    return { type, rate: meta.rate, label: meta.label, gross: rubles(grossK), tax: rubles(taxK) };
  });
}

/**
 * payload успешного документа: ФД/ФП, номер ФН и ККТ, смена, ОФД-ссылка.
 * ofd_receipt_url ведёт на страницу чека мока (в именованной песочнице — с её
 * селектором, иначе в owned-режиме ссылка попала бы в default).
 */
function fiscalPayload(doc) {
  const items = doc.receipt.items || [];
  return {
    total: rubles(doc.totalK),
    operation: doc.operation,
    ofd_inn: OFD_INN,
    fns_site: FNS_SITE,
    fn_number: (state.kkt && state.kkt.fnNumber) || FN_NUMBER,
    ecr_registration_number: (state.kkt && state.kkt.ecrRegistrationNumber) || ECR_RN,
    shift_number: doc.shiftNumber,
    receipt_datetime: new Date(doc.processedAt).toISOString().slice(0, 19),
    fiscal_receipt_number: doc.fiscalReceiptNumber,
    fiscal_document_number: doc.fiscalDocumentNumber,
    fiscal_document_attribute: String(1000000000 + (doc.fiscalDocumentNumber * 7919) % 8999999999),
    fiscal_folder_number: String(100000000 + (doc.fiscalDocumentNumber % 899999999)),
    taxation_type: doc.receipt.company.sno || null,
    vat_amounts: computeVatBreakdown(items),
    ofd_receipt_url: `${PUBLIC_BASE_URL}/receipts/${doc.uuid}${sandboxRuntime.currentId() === 'default' ? '' : `?sandbox=${encodeURIComponent(sandboxRuntime.currentId())}`}`,
  };
}

/** Текстовая лента чека: печатается в лог и отдаётся страницей /receipts/{uuid}. */
function customerReceiptText(doc) {
  const r = doc.receipt;
  const line = '--------------------------------';
  const rows = [line, AGENT_LINE, `ИНН ${AGENT_INN}`, line];
  rows.push(OPERATION_LABELS[doc.operation] || doc.operation);
  if (r.company && r.company.sno) rows.push(`СНО: ${r.company.sno}`);
  rows.push(`Сайт ФНС: ${FNS_SITE}`, line);
  for (const it of r.items || []) {
    const priceK = rublesToKopecks(it.price) || 0;
    const sumK = rublesToKopecks(it.sum) || 0;
    const vatValue = (it.vat && typeof it.vat === 'object' ? it.vat.type : it.vat) || 'none';
    const meta = VAT_META[vatValue] || VAT_META.none;
    rows.push(String(it.name).slice(0, 42));
    rows.push(`  ${it.quantity} x ${rubles(priceK)} = ${rubles(sumK)}`);
    const bits = [];
    if (it.payment_method) bits.push(PAYMENT_METHOD_LABELS[it.payment_method] || it.payment_method);
    if (it.payment_object) bits.push(String(it.payment_object).toUpperCase());
    if (bits.length) rows.push(`  ${bits.join(' · ')}`);
    rows.push(`  НДС ${meta.label}`);
  }
  rows.push(line, `ИТОГО: ${rubles(doc.totalK)} р`);
  for (const pay of r.payments || []) {
    rows.push(`  ${PAYMENT_TYPE_LABELS[pay.type] || pay.type}: ${rubles(rublesToKopecks(pay.sum) || 0)} р`);
  }
  rows.push(line);
  for (const v of computeVatBreakdown(r.items)) {
    rows.push(Number(v.rate) ? `НДС ${v.label}: ${v.tax} р` : 'НДС: без НДС');
  }
  rows.push(line);
  if (doc.payload) {
    rows.push(
      `ФД: ${doc.payload.fiscal_document_number}  ФП: ${doc.payload.fiscal_document_attribute}`,
      `ФН: ${doc.payload.fn_number}  ККТ: ${doc.payload.ecr_registration_number}`,
      `Смена: ${doc.payload.shift_number}  Чек №: ${doc.payload.fiscal_receipt_number}`,
      doc.payload.receipt_datetime,
      line,
      `ОФД: ИНН ${OFD_INN}`,
      doc.payload.ofd_receipt_url,
    );
  }
  rows.push(line, 'НЕ ОТПРАВЛЯЕТСЯ В ФНС (тестовый контур МГМ)', line);
  return rows.join('\n');
}

/* ------------------------------------------------------------- callbacks */

/**
 * Очередь доставки результата на service.callback_url (ядро: ретраи, SSRF-guard).
 *
 * ФОРК (задокументирован): у v4 в публичных руководствах не найдено правила
 * для ACK, подписи и числа/интервалов повторов (документации АТОЛ Онлайн v4
 * 02-testing-and-callbacks.md). Мок принимает любой 2xx как ACK и повторяет
 * доставку по своим настройкам; подпись НЕ добавляется — выдумывать её нельзя.
 * Приёмник обязан быть идемпотентным, сверка — через report.
 */
const deliveryQueue = core.createDeliveryQueue({
  entries: () => state.callbacks,
  retryMs: CALLBACK_RETRY_MS,
  maxAttempts: CALLBACK_MAX_ATTEMPTS,
  persist,
  log,
  now: () => clock.now(),
  request: (entry) => ({ url: entry.url, data: entry.body }),
  isOk: (res) => res.statusCode >= 200 && res.statusCode < 300,
  prepare: (entry) => { entry.attempts += 1; },
  onFailure: (entry, status, body) => {
    entry.lastStatus = status;
    entry.lastBody = body;
    if (entry.attempts >= CALLBACK_MAX_ATTEMPTS) {
      entry.dumped = true;
      log(`callback ${entry.id} сброшен после ${entry.attempts} попыток`);
    } else {
      entry.nextAttemptAt = clock.now() + CALLBACK_RETRY_MS;
    }
  },
  onSuccess: (entry, status) => {
    entry.done = true;
    entry.nextAttemptAt = null;
    entry.lastStatus = status;
    entry.finishedAt = clock.iso();
  },
  blockPrivateHosts: BLOCK_PRIVATE_WEBHOOKS,
});

/**
 * Постановка результата в очередь. Сценарии: webhook-drop|no-webhook (подавить),
 * webhook-duplicate (две копии — приёмник должен быть идемпотентен).
 */
function scheduleCallback(doc, duplicate = false) {
  if (doc.callbackSuppressed) {
    log(`doc ${doc.uuid}: callback подавлен сценарием (webhook-drop)`);
    return;
  }
  const url = String(doc.callbackUrl || '').trim();
  if (!url) {
    log(`doc ${doc.uuid}: service.callback_url не передан — результат доступен только через report`);
    return;
  }
  const count = duplicate ? 2 : 1;
  for (let i = 0; i < count; i += 1) {
    const id = String(state.counters.notification++);
    state.callbacks[id] = {
      id,
      uuid: doc.uuid,
      url,
      body: doc.callbackBody,
      attempts: 0,
      nextAttemptAt: clock.now() + 300,
      lastStatus: null,
      createdAt: clock.iso(),
    };
  }
  persist();
  log(`doc ${doc.uuid}: callback поставлен -> ${url}${duplicate ? ' (дубль x2)' : ''}`);
}

/* ------------------------------------------------- очередь обработки (тик) */

/**
 * «Печать» документов: wait -> done|fail после MOCK_PROCESS_MS.
 * Обслуживает текущую песочницу — вызывается из tickAll в её контексте (F-11).
 */
function tickAtol() {
  const now = clock.now();
  for (const doc of Object.values(state.documents)) {
    if (doc.status !== 'wait' || doc.hang) continue;
    if (now < doc.processAt) continue;

    doc.processedAt = now;
    if (doc.forceFail) {
      doc.status = 'fail';
      doc.error = {
        code: 57,
        text: 'ККТ-мок: отказ печати фискального документа по сценарию',
        type: 'system',
        error_id: crypto.randomUUID(),
      };
      log(`doc ${doc.uuid}: FAILED (сценарий fail)`);
    } else {
      doc.status = 'done';
      state.counters.check = (state.counters.check || 0) + 1;
      doc.fiscalReceiptNumber = state.counters.check;
      doc.payload = fiscalPayload(doc);
      log(`\n===== ЧЕК НАПЕЧАТАН (${doc.operation}) =====\n${customerReceiptText(doc)}\n============================================`);
    }
    // Результат уходит на callback в том же виде, что и report (сверка по report).
    doc.callbackBody = JSON.stringify(reportView(doc));
    persist();
    scheduleCallback(doc, doc.callbackDuplicate);
  }
}

setInterval(() => {
  sandboxRuntime.tickAll(() => {
    tickAtol();
    deliveryQueue.tick().catch((e) => log('callback loop: ' + e.message));
  });
}, 1000).unref();

// Воркер TTL/лимитов (RFC-001 §8).
const SANDBOX_SWEEP_MS = parseMsOr(process.env.MOCK_SANDBOX_SWEEP_MS, 60000);
if (SANDBOX_TTL_MS > 0 || SANDBOX_MAX_DOCUMENTS > 0 || SANDBOX_RETENTION_MS > 0) {
  setInterval(() => {
    const result = sandboxRuntime.sweep();
    if (result.expired) log(`sandbox sweep: удалено по TTL — ${result.expired}`);
  }, Math.max(1000, SANDBOX_SWEEP_MS)).unref();
}

/* --------------------------------------------------------- регистрация чека */

/** Ответ отчёта: {uuid, status, timestamp, error, payload} + эхо для DX. */
function reportView(doc) {
  return {
    uuid: doc.uuid,
    external_id: doc.externalId,
    group_code: doc.group,
    type: doc.operation,
    status: doc.status,
    timestamp: clock.iso(),
    error: doc.error
      ? {
        code: doc.error.code,
        text: doc.error.text,
        type: doc.error.type || 'business',
        error_id: doc.error.error_id,
      }
      : null,
    payload: doc.payload || null,
  };
}

/** Ответ регистрации документа: UUID + состояние очереди. */
function registeredView(doc) {
  return { uuid: doc.uuid, status: doc.status, timestamp: clock.iso(), error: null };
}

function createDocument(operation, group, body, spec) {
  const uuid = crypto.randomUUID();
  const externalId = String(body.external_id || '');
  const receipt = body.receipt || {};

  /*
   * callback_url: в v4 — `service.callback_url` (sibling объекта receipt).
   * Ferma кладёт его в receipt.service — принимаем и так (помогает
   * мигрирующим), это документированная толерантность мока. Если адреса нет
   * нигде, используется MOCK_DEFAULT_CALLBACK_URL — mock-расширение для
   * compose-стенда (в протоколе такого дефолта нет).
   */
  const callbackUrl = (body.service && body.service.callback_url)
    || (receipt.service && receipt.service.callback_url)
    || MOCK_DEFAULT_CALLBACK_URL
    || '';

  const doc = {
    uuid,
    externalId,
    group,
    operation,
    status: 'wait',
    createdAt: clock.now(),
    processAt: clock.now() + PROCESS_MS,
    processedAt: null,
    totalK: rublesToKopecks(receipt.total) || 0,
    receipt,
    callbackUrl: String(callbackUrl || '').trim(),
    forceFail: externalId.startsWith('fail-') || spec.has('fail') || spec.has('kkt-fail'),
    hang: externalId.startsWith('hang-') || spec.has('hang') || spec.has('wait-forever'),
    callbackSuppressed: spec.has('webhook-drop') || spec.has('no-callback') || spec.has('no-webhook'),
    callbackDuplicate: spec.has('webhook-duplicate') || spec.has('callback-duplicate'),
    shiftNumber: (state.kkt && state.kkt.shiftNumber) || 1,
    fiscalReceiptNumber: null,
    fiscalDocumentNumber: (state.counters.fd = (state.counters.fd || 50000) + 1),
    callbackBody: null,
    payload: null,
    error: null,
  };

  state.documents[uuid] = doc;
  state.externalIds[`${group}\u0000${externalId}`] = uuid;
  persist();
  log(`doc ${uuid} принят в очередь: ${operation} group=${group} external_id=${externalId} total=${receipt.total} items=${(receipt.items || []).length}`);
  return doc;
}

/* ------------------------------------------------------ control-plane/sandbox */

/**
 * Какая авторизация нужна маршруту (F-07):
 *   'admin'    — /admin* (консоль, журнал, действия);
 *   'operator' — управляющая поверхность (/mock/*);
 *   null       — контракт v4, страница чека, health.
 */
function controlSurface(p) {
  if (p.startsWith('/admin')) return 'admin';
  if (p.startsWith('/mock/')) return 'operator';
  return null;
}

/**
 * Политика admission по маршруту (F-11/F-12, PA-54): какие запросы требуют
 * контекст песочницы и owner-token в hosted-режиме. Неописанный маршрут
 * трактуется fail-closed как 'business'.
 */
function atolSandboxPolicy(p) {
  if (p === '/health' || p === '/openapi.json' || p === '/sandboxes' || p.startsWith('/sandboxes/')) return 'public';
  if (p.startsWith('/admin') || p.startsWith('/mock/')) return 'control';
  if (p.startsWith('/possystem/')) return 'business';
  if (p.startsWith('/receipts/')) return 'form';
  return 'business';
}

/** DX-ответ на ошибку admission песочницы (F-12): знание ID ≠ доступ. */
function sendSandboxError(res, admission) {
  const id = admission.sandbox || 'default';
  if (admission.kind === 'not-found') {
    return jsonRaw(res, 404, aerrBody(10, admission.message || `Песочница «${id}» не найдена`, {
      hint: admission.hint || 'Создайте песочницу: POST /sandboxes — в ответе будут id, creds (login/pass/группа АТОЛ) и ownerToken. Список: GET /mock/sandboxes.',
    }));
  }
  if (admission.kind === 'unauthorized') {
    return jsonRaw(res, 401, aerrBody(11, `Доступ к песочнице «${id}» ограничен: знание ID не является доступом`, {
      field: 'X-Sandbox-Token',
      hint: admission.hint || 'Передайте owner-token из ответа POST /sandboxes: Authorization: Bearer <ownerToken>, X-Sandbox-Token или cookie (mock_sandbox_token=...). Токены из query-строки в hosted/owned-режиме запрещены.',
    }));
  }
  if (admission.kind === 'expired') {
    return jsonRaw(res, 410, aerrBody(10, `Песочница «${id}» истекла по TTL и удалена`, {
      hint: 'Песочницы живут ограниченное время; создайте новую: POST /sandboxes.',
    }));
  }
  if (admission.kind === 'rate-limit' || admission.kind === 'limit') {
    return jsonRaw(res, 429, aerrBody(4, 'Лимит создания песочниц исчерпан', {
      hint: 'Переиспользуйте существующий ID или поднимите MOCK_SANDBOX_CREATE_LIMIT / MOCK_SANDBOX_MAX.',
    }));
  }
  return jsonRaw(res, 500, aerrBody(500, 'Не удалось разрешить контекст песочницы'));
}

/** Базовый URL песочницы для ответа POST /sandboxes (RFC-001 §6). */
function sandboxPublicUrl(id) {
  const base = String(PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (SANDBOX_HOST_SUFFIX) {
    try {
      const u = new URL(base || 'http://localhost');
      return `${u.protocol}//${id}.${SANDBOX_HOST_SUFFIX}`;
    } catch { /* ignore */ }
  }
  return `${base}/?sandbox=${encodeURIComponent(id)}`;
}

/** Креды песочницы (RFC-001 §4): login/pass/группа АТОЛ у каждой свои. */
function generateSandboxCreds(body = {}) {
  return {
    atolLogin: `v4-sbx${crypto.randomBytes(4).toString('hex')}`,
    atolPassword: core.randomToken(24),
    atolGroup: String(body.group || `sbx-${crypto.randomBytes(3).toString('hex')}`),
  };
}

/** GET/POST/DELETE /sandboxes (алиас /mock/sandboxes). */
async function handleSandboxApi(req, res, parsedUrl, admission) {
  let body = {};
  if (req.method === 'POST' || req.method === 'DELETE') {
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { body = {}; }
  }
  const operator = sandboxRuntime.isOperatorRequest(req);
  if (req.method === 'GET') {
    if (TENANCY === 'owned' && !operator) {
      const own = sandboxRuntime.recordByOwnerToken(req);
      if (!own) {
        return jsonRaw(res, 401, aerrBody(11, 'Список песочниц в hosted-режиме доступен владельцу (owner-token) или оператору', {
          field: 'X-Sandbox-Token',
          hint: 'Owner-token выдаётся один раз при создании: POST /sandboxes.',
        }));
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
          profile: 'atol-online-v4',
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
        if (core.sendSandboxStateQuotaError(res, e)) return;
        const status = e.code === 'SANDBOX_EXISTS' ? 409 : 429;
        return jsonRaw(res, status, aerrBody(4, e.message, {
          hint: 'Ограничения: MOCK_SANDBOX_MAX (количество), MOCK_SANDBOX_CREATE_LIMIT (созданий в час на IP).',
        }));
      }
    }
    // namespaces/off — BC: выбрать (и при необходимости создать) активную песочницу.
    const result = sandboxRuntime.switchActive((body && body.sandbox) || 'default');
    if (!result.ok) return jsonRaw(res, 400, aerrBody(4, `Не удалось выбрать песочницу: ${result.error}`));
    return sendJson(res, { ok: true, current: result.current, sandboxes: sandboxRuntime.list() });
  }
  if (req.method === 'DELETE') {
    const target = String((body && body.sandbox) || parsedUrl.searchParams.get('sandbox') || '');
    if (!target) return jsonRaw(res, 400, aerrBody(4, 'Укажите песочницу для удаления: ?sandbox=<id> или {"sandbox":"<id>"}'));
    const record = sandboxRuntime.find(target);
    if (!record) return jsonRaw(res, 404, aerrBody(10, `Песочница «${target}» не найдена`));
    if (TENANCY === 'owned' && !operator && !sandboxRuntime.recordAuthorized(record, req)) {
      return jsonRaw(res, 401, aerrBody(11, `Удалить песочницу «${target}» может её владелец (owner-token) или оператор`));
    }
    const result = sandboxRuntime.remove(target, req);
    if (!result.ok) {
      if (result.error === 'unauthorized') {
        return jsonRaw(res, 401, aerrBody(11, `Удалить песочницу «${target}» может её владелец (owner-token) или оператор`));
      }
      return jsonRaw(res, 400, aerrBody(4, `Песочницу «${target}» удалить нельзя (default-стенд)`));
    }
    return sendJson(res, { ok: true, removed: result.removed });
  }
  return jsonRaw(res, 405, aerrBody(4, `Метод ${req.method} для /sandboxes не поддерживается`));
}

/** RFC-001 §6: /sandboxes/me — своя песочница по owner-token. */
async function handleSandboxMe(req, res, p) {
  let body = {};
  if (req.method === 'POST') {
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { body = {}; }
  }
  const record = sandboxRuntime.recordByOwnerToken(req) || (TENANCY === 'owned' ? null : sandboxRuntime.current());
  if (!record) {
    return jsonRaw(res, 401, aerrBody(11, 'Требуется owner-token песочницы', {
      field: 'X-Sandbox-Token',
      hint: 'Owner-token выдаётся один раз при создании: POST /sandboxes.',
    }));
  }
  if (p === '/sandboxes/me' && req.method === 'GET') {
    return sendJson(res, { ok: true, mode: TENANCY, sandbox: sandboxRuntime.describe(record), creds: record.creds || null });
  }
  if (p === '/sandboxes/me/reset' && req.method === 'POST') {
    const result = sandboxRuntime.reset(record.id, req);
    return sendJson(res, { ok: true, sandbox: result.sandbox });
  }
  if (p === '/sandboxes/me/reset-creds' && req.method === 'POST') {
    // Смена кредов: owner-token не меняется, иначе интегратор потеряет доступ.
    const creds = generateSandboxCreds(body || {});
    sandboxRuntime.updateCreds(record.id, creds, req);
    return sendJson(res, { ok: true, sandbox: record.id, creds, ownerTokenChanged: false });
  }
  if (p === '/sandboxes/me' && req.method === 'DELETE') {
    const result = sandboxRuntime.remove(record.id, req);
    if (!result.ok) return jsonRaw(res, 400, aerrBody(4, 'default-песочницу стенда удалить нельзя'));
    return sendJson(res, { ok: true, removed: result.removed });
  }
  return jsonRaw(res, 405, aerrBody(4, `Метод ${req.method} для ${p} не поддерживается`));
}

/* ------------------------------------------------------------------ admin */

const esc = (v) => escapeHtml(v);

function btn(action, id, label, csrfToken, actionUrl) {
  return `<form method="POST" action="${esc(actionUrl)}" style="display:inline"><input type="hidden" name="_csrf" value="${esc(csrfToken)}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="id" value="${esc(id)}"><button style="width:auto;margin:2px;padding:2px 6px;font-size:11px" type="submit">${esc(label)}</button></form>`;
}

function adminPage(req) {
  const currentSandbox = sandboxRuntime.currentId();
  const adminQuery = new URLSearchParams();
  if (currentSandbox !== 'default') adminQuery.set('sandbox', currentSandbox);
      const adminSuffix = adminQuery.toString();
  const adminActionUrl = `/admin/action${adminSuffix ? `?${adminSuffix}` : ''}`;
  const adminJournalUrl = `/admin/journal${adminSuffix ? `?${adminSuffix}` : ''}`;
  const csrfToken = core.createCsrfToken(ADMIN_CSRF_SECRET, currentSandbox);

  const docs = Object.values(state.documents).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50)
    .map((d) => `<tr>
      <td><code>${esc(d.uuid.slice(0, 8))}</code></td><td>${esc(d.operation)}</td><td>${esc(d.externalId)}</td><td>${esc(d.group)}</td>
      <td><b>${esc(d.status)}</b></td>
      <td>${d.payload ? `ФД №${esc(d.payload.fiscal_document_number)} ФП ${esc(d.payload.fiscal_document_attribute)}` : (d.error ? esc(d.error.text) : '—')}</td>
      <td>${rubles(d.totalK)} р</td>
      <td>${d.callbackUrl ? esc(d.callbackUrl) : '—'}</td>
      <td>${d.callbackBody ? btn('resend-callback', d.uuid, 'callback', csrfToken, adminActionUrl) : '—'}</td>
      <td>${btn('print-receipt', d.uuid, 'чек', csrfToken, adminActionUrl)}</td></tr>`).join('')
    || '<tr><td colspan="10">документов нет</td></tr>';

  const callbacks = Object.values(state.callbacks).sort((a, b) => Number(a.id) - Number(b.id)).slice(-20).reverse()
    .map((c) => {
      const st = c.suppressed ? 'suppressed' : c.dumped ? 'dumped' : c.done ? 'delivered' : `retry@${new Date(c.nextAttemptAt || clock.now()).toISOString().slice(11, 19)}`;
      return `<tr><td><code>${esc(c.id)}</code></td><td><code>${esc(String(c.uuid).slice(0, 8))}</code></td><td>${c.attempts}</td><td>${esc(st)}</td><td>${esc(c.lastStatus ?? '—')} ${esc(String(c.lastBody ?? '').slice(0, 40))}</td><td>${btn('duplicate-callback', c.id, 'повторить', csrfToken, adminActionUrl)}</td></tr>`;
    }).join('') || '<tr><td colspan="6">callback не отправлялись</td></tr>';

  const journalRows = journal.list().slice(-15).reverse()
    .map((e) => `<tr><td>${esc(String(e.at).slice(11, 19))}</td><td>${esc(e.method)}</td><td><code>${esc(e.path)}</code></td><td><code>${esc(Object.entries(e.body || {}).map(([k, v]) => `${k}=${v}`).join(' '))}</code></td><td>${e.status}</td><td>${e.ms} мс</td><td><code style="font-size:10px">${esc(String(e.curl || '').slice(0, 70))}…</code></td></tr>`).join('')
    || '<tr><td colspan="7">запросов ещё не было</td></tr>';

  return `<html><head><meta charset="utf-8"><title>atol-mock</title><style>
body{font-family:monospace;background:#111;color:#ddd;margin:20px}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #444;padding:4px 8px;font-size:13px}th{background:#222}
h1{font-size:18px}h2{font-size:15px}a{color:#8cf}code{color:#9d9}</style></head><body>
<h1>atol-mock — АТОЛ Онлайн direct API v4 (ФФД 1.05)</h1>
<p>группы: ${esc(GROUPS.join(', '))} · документов: ${Object.keys(state.documents).length} · external_id: ${Object.keys(state.externalIds).length} · токен TTL: ${Math.round(TOKEN_TTL_MS / 3600000)} ч · sandbox <code>${esc(currentSandbox)}</code></p>
<p>POST /possystem/v4/getToken · POST /possystem/v4/{group}/sell|sell_refund|sell_correction|buy|buy_refund|buy_correction · GET /possystem/v4/{group}/report/{uuid}</p>
<p>Негатив: X-Mock-Scenario: <b>fail</b> / <b>hang</b> / <b>webhook-drop</b> / <b>webhook-duplicate</b> / <b>latency:2s</b> / <b>http-500</b> / <b>http-504</b>; external_id с префиксом <b>fail-</b> / <b>hang-</b>.</p>
<p>Виртуальное время: ${esc(clock.iso())} · задержка печати: ${PROCESS_MS} мс · ретраи callback: ${Math.round(CALLBACK_RETRY_MS / 1000)} с × ${CALLBACK_MAX_ATTEMPTS}</p>
<p>${btn('clear-external-ids', '-', 'Сбросить реестр external_id', csrfToken, adminActionUrl)} ${btn('process-now', '-', 'Напечатать всё сейчас', csrfToken, adminActionUrl)}</p>
<h2>Документы (последние 50)</h2>
<table><tr><th>uuid</th><th>op</th><th>external_id</th><th>group</th><th>status</th><th>фискальные данные</th><th>сумма</th><th>callback_url</th><th colspan="2">действия</th></tr>${docs}</table>
<h2>Callback (последние 20) — ACK любой 2xx, подпись не предусмотрена протоколом v4</h2>
<table><tr><th>id</th><th>uuid</th><th>попыток</th><th>статус</th><th>последний ответ</th><th>действия</th></tr>${callbacks}</table>
<h2>Журнал /possystem/v4 (последние 15) — <a href="${esc(adminJournalUrl)}">json</a></h2>
<table><tr><th>время</th><th>метод</th><th>путь</th><th>поля</th><th>код</th><th>время</th><th>curl</th></tr>${journalRows}</table>
</body></html>`;
}

function adminAction(body) {
  const { action, id } = body;
  if (action === 'resend-callback') {
    const doc = state.documents[id];
    if (doc && doc.callbackBody) scheduleCallback(doc);
  } else if (action === 'duplicate-callback') {
    const cb = state.callbacks[String(id)];
    if (cb) {
      const copy = {
        ...cb,
        id: String(state.counters.notification++),
        attempts: 0,
        nextAttemptAt: 0,
        lastStatus: null,
        lastBody: null,
        finishedAt: null,
        dumped: false,
        done: false,
        createdAt: clock.iso(),
      };
      state.callbacks[copy.id] = copy;
      persist();
    }
  } else if (action === 'print-receipt') {
    const doc = state.documents[id];
    if (doc) log(`\n===== ЧЕК ${doc.uuid} =====\n${customerReceiptText(doc)}\n===========================`);
  } else if (action === 'clear-external-ids') {
    const n = Object.keys(state.externalIds).length;
    state.externalIds = {};
    log(`реестр external_id очищен (${n} записей)`);
    persist();
  } else if (action === 'process-now') {
    for (const doc of Object.values(state.documents)) doc.processAt = Math.min(doc.processAt, clock.now());
    tickAtol();
  }
}

/**
 * Выжимка запроса для журнала: скаляры, не более 6 полей, значения до 60
 * символов. Редакцию секретов и PII делает ядро (F-09): `pass`, `token`,
 * e-mail и телефон покупателя в журнал не попадают.
 */
function bodySummary(body) {
  return core.summarizeBody(body, { maxKeys: 6, maxValueLength: 60 });
}

/* ------------------------------------------------------------------- http */

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, 'http://x');
  const url = parsedUrl.pathname;

  // F-11/F-12: контекст песочницы разрешается ровно один раз до бизнес-логики.
  const admission = sandboxRuntime.admit(req, atolSandboxPolicy(url));
  if (!admission.ok) return sendSandboxError(res, admission);
  return sandboxRuntime.run(admission, async () => {
    try {
    if (url.startsWith('/possystem/')) {
      const started = Date.now();
      const originalWriteHead = res.writeHead.bind(res);
      res.writeHead = (code, ...rest) => {
        const parsed = (() => { try { return JSON.parse(res.__mockBody || '{}'); } catch { return {}; } })();
        journal.record({
          method: req.method,
          path: req.url || url,
          status: code,
          ms: Date.now() - started,
          body: bodySummary(parsed),
          rawBody: res.__mockBody || '',
          headers: req.headers,
          baseUrl: PUBLIC_BASE_URL,
        });
        return originalWriteHead(code, ...rest);
      };

      // Сетевой хаос ядра: X-Mock-Latency, X-Mock-Scenario: latency/http-500/http-504.
      // v4 рекомендует после системной ошибки подождать не менее секунды —
      // эти сценарии и проверяют поведение интегратора на таком сбое.
      const chaosSpec = parseScenarioSpec(req.headers['x-mock-scenario'] || '');
      const chaosResult = await applyRequestChaos(req, chaosSpec);
      sandboxRuntime.current(); // PA-50 §7.2: fail-closed при истечении/удалении песочницы во время await
      if (chaosResult.abortStatus) {
        return jsonRaw(res, chaosResult.abortStatus, aerrBody(500, chaosResult.abortMessage, {
          type: 'system',
          hint: 'Сценарий X-Mock-Scenario: http-500|http-504 (сетевой сбой до бизнес-логики). По v4 после системной ошибки выдержите паузу не менее 1 с и повторите, а сверку сделайте через report.',
          doc: '',
        }));
      }
    }

      /* ------------------------------------------- управляющая поверхность */
      const surface = controlSurface(url);
    const ownerRec = sandboxRuntime.recordByOwnerToken(req);
    const ownerSurface = surface === 'operator'
      && Boolean(ownerRec && admission.record && ownerRec.id === admission.record.id);
    if (surface && admission.via !== 'owner' && !ownerSurface) {
        if (url === '/admin/login' && req.method === 'POST') {
      return core.handleAdminLogin(req, res, typeof raw !== 'undefined' ? raw : undefined, parseBody, send);
    }
    const access = checkControlAccess(req, {
          adminToken: MOCK_ADMIN_TOKEN,
          operatorToken: OPERATOR_TOKEN,
          surface,
          hosted: HOSTED,
        });
        if (!access.allowed) {
      if (url === '/admin' && req.method === 'GET') {
        return core.html(res, core.adminLoginForm(req));
      }
          const envName = surface === 'admin' ? 'MOCK_ADMIN_TOKEN' : 'MOCK_OPERATOR_TOKEN';
          const message = access.reason === 'hosted-fail-closed'
            ? `Маршрут ${url} закрыт: hosted-режим (MOCK_HOSTED) требует ${envName} для управляющей поверхности`
            : `Доступ к управляющему маршруту ${url} ограничен: требуется ${envName}`;
          return jsonRaw(res, 401, aerrBody(11, message, {
            field: surface === 'admin' ? 'Authorization' : 'X-Operator-Token',
            hint: access.hint || `Передайте токен в заголовке Authorization: Bearer <${envName}> или X-Operator-Token/X-Admin-Token.`,
          }));
        }

              }

    // Ф-1 (#121): принятый из query управляющий токен переносим в сессионную
    // cookie — дальше консоль, ссылки и формы работают без токенов в URL.
    core.attachResponseCookies(res, core.sessionCookiesFromQuery(req, {
      adminToken: MOCK_ADMIN_TOKEN,
      operatorToken: OPERATOR_TOKEN,
      sandboxToken: sandboxRuntime.recordByOwnerToken(req) ? sandboxRuntime.ownerTokenOf(req) : '',
      hosted: HOSTED,
    }));

      if (req.method === 'GET' && url === '/openapi.json') {
        const specFile = path.join(__dirname, '..', '..', 'docs', 'openapi', 'atol-mock.openapi.json');
        return sendJson(res, JSON.parse(fs.readFileSync(specFile, 'utf8')));
      }

      if (req.method === 'GET' && url === '/health') {
        const health = {
          ok: true,
          sandbox: sandboxRuntime.currentId(),
          tenancy: TENANCY,
          api: 'v4',
          ffd: '1.05',
          groups: GROUPS,
          tokenTtlHours: Math.round(TOKEN_TTL_MS / 3600000),
          processMs: PROCESS_MS,
        };
        if (TENANCY !== 'owned' || (admission.record.isDefault && !admission.record.ownerTokenHash) || admission.via === 'owner' || admission.via === 'operator') {
          Object.assign(health, {
            documents: Object.keys(state.documents).length,
            waiting: Object.values(state.documents).filter((d) => d.status === 'wait').length,
            callbacks: Object.keys(state.callbacks).length,
          });
        }
        return sendJson(res, health);
      }

      if (req.method === 'GET' && url === '/admin/journal') {
        return sendJson(res, { entries: journal.list() });
      }

      // ── RFC-001 §6: управление песочницами ──
      if (url === '/sandboxes' || url === '/mock/sandboxes') {
        return await handleSandboxApi(req, res, parsedUrl, admission);
      }
      if (url.startsWith('/sandboxes/')) {
        return await handleSandboxMe(req, res, url);
      }

      if (url === '/mock/reset' && req.method === 'POST') {
        // F-11/F-13/PA-50: сбрасываем ровно ту песочницу, на которую авторизован запрос.
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
        const target = (body && body.sandbox) || admission.record.id;
        const result = sandboxRuntime.reset(target, req);
        if (!result.ok) {
          return sendSandboxError(res, { ok: false, kind: result.error || 'unauthorized', sandbox: result.sandbox || target });
        }
        clearSandboxChildState(sandboxRuntime.find(target));
        return sendJson(res, { ...result, current: sandboxRuntime.currentId() });
      }

      if (url === '/mock/state') {
        if (req.method === 'GET') {
          const targetSandbox = parsedUrl.searchParams.get('sandbox') || undefined;
          const snapshot = targetSandbox ? sandboxRuntime.exportState(targetSandbox, req) : sandboxRuntime.exportState(null, req);
          if (snapshot && snapshot.ok === false) {
            return sendSandboxError(res, { ok: false, kind: snapshot.error || 'unauthorized', sandbox: snapshot.sandbox || targetSandbox || admission.record.id });
          }
          return sendJson(res, { ...snapshot, current: admission.record.id });
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          const raw = await readBody(req);
          let body = {};
          try { body = JSON.parse(raw || '{}'); } catch {
            return jsonRaw(res, 400, aerrBody(4, 'Некорректный JSON снимка состояния', {
              field: 'state',
              hint: 'Передайте экспорт /mock/state без редактирования опасных ключей __proto__, constructor и prototype.',
            }));
          }
          try {
            const targetSandbox = (body && body.sandbox) || admission.record.id;
            const imported = sandboxRuntime.importState(body, targetSandbox, req);
            if (!imported.ok) {
              return sendSandboxError(res, { ok: false, kind: imported.error || 'unauthorized', sandbox: imported.sandbox || targetSandbox });
            }
            return sendJson(res, imported);
          } catch (e) {
            if (core.sendSandboxStateQuotaError(res, e)) return;
            return jsonRaw(res, 400, aerrBody(4, `Недопустимый снимок состояния: ${e.message}`, {
              field: 'state',
              hint: 'Исправьте снимок и повторите импорт; ключи __proto__, constructor и prototype запрещены на всех уровнях.',
            }));
          }
        }
      }

      // Виртуальные часы: ускорение wait -> done и проверка истечения токена (24 ч).
      if (url === '/mock/time') {
        if (req.method === 'GET') return sendJson(res, clock.snapshot());
        if (req.method === 'POST' || req.method === 'PUT') {
          const raw = await readBody(req);
          let spec = {};
          try { spec = JSON.parse(raw || '{}'); } catch { return jsonRaw(res, 400, aerrBody(4, 'Некорректный JSON для /mock/time')); }
          try {
            const snap = clock.set(spec);
            tickAtol();
            await deliveryQueue.tick();
            return sendJson(res, snap);
          } catch (e) {
            if (core.sendSandboxStateQuotaError(res, e)) return;
            return jsonRaw(res, 400, aerrBody(4, e.message, { field: 'advance|offset|iso' }));
          }
        }
      }

      // Сценарное API: правила без заголовка (fail/hang/webhook-*).
      if (url === '/mock/scenarios') {
        if (req.method === 'GET') {
          return sendJson(res, { rules: scenarios.listRules(), history: scenarios.listHistory() });
        }
        if (req.method === 'POST') {
          const raw = await readBody(req);
          let body = {};
          try { body = JSON.parse(raw || '{}'); } catch { return jsonRaw(res, 400, aerrBody(4, 'Некорректный JSON для /mock/scenarios')); }
          try {
            return sendJson(res, { ok: true, rule: scenarios.addRule(body) });
          } catch (e) {
            const bodyErr = aerr(4, e.message, { field: 'scenario' });
            if (e && e.code) bodyErr.code = e.code;
            return jsonRaw(res, 400, JSON.stringify(bodyErr));
          }
        }
        if (req.method === 'DELETE') {
          scenarios.clearRules();
          scenarios.clearHistory();
          return sendJson(res, { ok: true, rules: [], history: [] });
        }
      }

      /* ------------------------------------------------------- admin-консоль */

      if (req.method === 'GET' && url === '/admin') {
        return send(res, 200, adminPage(req), {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, private',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        });
      }

      if (req.method === 'POST' && url === '/admin/action') {
        const raw = await readBody(req);
        const body = parseBody(raw, req.headers['content-type']);
        if (!core.isSameOriginRequest(req)
            || !core.verifyCsrfToken(body && body._csrf, ADMIN_CSRF_SECRET, sandboxRuntime.currentId())) {
          return jsonRaw(res, 403, aerrBody(11, 'Запрос заблокирован: отсутствует или неверен CSRF-токен', {
            field: '_csrf',
            hint: 'Откройте /admin и отправьте действие из формы этой консоли.',
          }));
        }
        adminAction(body);
        const redirectQuery = new URLSearchParams();
        const currentSandbox = sandboxRuntime.currentId();
        if (currentSandbox !== 'default') redirectQuery.set('sandbox', currentSandbox);
        // Ф-1 (#121): токены НЕ возвращаются в URL — навигацию держит сессионная
        // cookie (control-блок выше), заголовок или cookie клиента.
        const redirectSuffix = redirectQuery.toString();
        return send(res, 302, '', { Location: `/admin${redirectSuffix ? `?${redirectSuffix}` : ''}` });
      }

      /* ----------------------------------------------- «доставка чека» */

      const receiptMatch = /^\/receipts\/([^/]+)$/.exec(url);
      if (req.method === 'GET' && receiptMatch) {
        const doc = state.documents[decodeURIComponent(receiptMatch[1])];
        if (!doc) return jsonRaw(res, 404, aerrBody(10, 'Чек не найден'));
        if (doc.status !== 'done') {
          return jsonRaw(res, 200, aerrBody(10, `Документ ещё не напечатан (status=${doc.status})`, {
            field: 'uuid',
            hint: 'Страница чека доступна после перехода в done. Ускорьте печать виртуальными часами: POST /mock/time {"advance":"+20s"}.',
          }));
        }
        return send(res, 200, `<html><head><meta charset="utf-8"><title>Чек ${esc(doc.payload.fiscal_document_number)}</title></head>
<body style="font-family:monospace;background:#eee"><pre>${esc(customerReceiptText(doc))}</pre></body></html>`, { 'Content-Type': 'text/html; charset=utf-8' });
      }

      /* ---------------------------------------------- прямой API v4 */

      if (req.method === 'POST' && url === '/possystem/v4/getToken') {
        const raw = await readBody(req);
        res.__mockBody = raw;
        let creds = {};
        try { creds = JSON.parse(raw || '{}'); } catch { creds = {}; }
        // F-09: креды не пишутся в лог целиком — только различимая маска.
        const loginLabel = core.maskPiiValue('login', creds.login);
        if (typeof creds.login !== 'string' || typeof creds.pass !== 'string'
            || creds.login !== atolLogin() || creds.pass !== atolPassword()) {
          log(`getToken DENIED for login=${loginLabel}`);
          return jsonRaw(res, 200, aerrBody(14, 'Неверный логин или пароль'));
        }
        const token = crypto.randomBytes(16).toString('hex');
        state.tokens[token] = { login: loginLabel, createdAt: clock.now() };
        persist();
        log(`getToken OK for ${loginLabel}`);
        return sendJson(res, { token, timestamp: clock.iso(), error: null });
      }

      const opMatch = /^\/possystem\/v4\/([^/]+)\/(sell|sell_refund|sell_correction|buy|buy_refund|buy_correction)$/.exec(url);
      if (req.method === 'POST' && opMatch) {
        const auth = checkToken(req);
        if (!auth.ok) return jsonRaw(res, 200, authErrorBody(auth.reason, auth.ageMs));

        const raw = await readBody(req);
        res.__mockBody = raw;
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { return jsonRaw(res, 200, aerrBody(4, 'Неверный формат запроса: тело не является валидным JSON')); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return jsonRaw(res, 200, aerrBody(4, 'Неверный формат запроса: ожидается JSON-объект документа'));
        }

        const groupCode = decodeURIComponent(opMatch[1]);
        const operation = opMatch[2];

        const externalId = String(body.external_id === undefined || body.external_id === null ? '' : body.external_id).trim();
        if (!externalId) return jsonRaw(res, 200, aerrBody(5, 'external_id обязателен'));
        if (externalId.length > EXTERNAL_ID_MAX) {
          return jsonRaw(res, 200, aerrBody(5, `external_id длиннее ${EXTERNAL_ID_MAX} символов (${externalId.length})`, {
            field: 'external_id',
            hint: `Сократите идентификатор до ${EXTERNAL_ID_MAX} символов: в v4 он строковый и уникальный в пределах группы.`,
          }));
        }

        // Группа ККТ: опечатка отклоняется, как на боевой кассе. В owned-режиме
        // у песочницы своя группа — она добавляется к разрешённым.
        const sandboxGroup = atolGroup();
        const allowedGroups = sandboxGroup && !GROUPS.includes(sandboxGroup) ? [...GROUPS, sandboxGroup] : GROUPS;
        if (allowedGroups.length && !allowedGroups.includes(groupCode)) {
          return jsonRaw(res, 200, aerrBody(4, `Группа «${groupCode}» не зарегистрирована в кабинете`, {
            field: 'group_code',
            hint: `Разрешённые группы стенда: ${allowedGroups.join(', ')} (env MOCK_ATOL_GROUP / MOCK_GROUPS). Дефолт — публичная тестовая группа v4 из конспекта.`,
          }));
        }

        /*
         * ДЕДУПЛИКАЦИЯ v4 — главное отличие от Ferma: повтор с тем же
         * external_id в той же группе НЕ ошибка, а возврат UUID уже созданной
         * операции (второй чек не появляется). Тело повтора игнорируется —
         * об этом честно говорит DX-hint и заголовок X-Mock-Replayed.
         */
        const knownUuid = state.externalIds[`${groupCode}\u0000${externalId}`];
        if (knownUuid && state.documents[knownUuid]) {
          const existing = state.documents[knownUuid];
          log(`doc ${knownUuid}: повтор external_id=${externalId} — возвращаю ранее назначенный UUID (второй чек не создаётся)`);
          res.setHeader('X-Mock-Replayed', '1');
          return sendJson(res, {
            ...registeredView(existing),
            hint: `Документ с external_id «${externalId}» уже зарегистрирован в группе «${groupCode}»: возвращён прежний uuid, второй чек не создан. Тело этого запроса проигнорировано; актуальный результат — GET /possystem/v4/${groupCode}/report/${knownUuid}.`,
          });
        }

        const spec = scenarios.resolve({
          header: req.headers['x-mock-scenario'] || '',
          bodyScenario: typeof body.mock_scenario === 'string' ? body.mock_scenario : '',
          target: operation,
          context: { externalId, group: groupCode, operation },
        });

        if (VALIDATE_RECEIPTS) {
          const problem = validateReceipt(body.receipt, body);
          if (problem) {
            log(`${operation} REJECTED (валидация реквизитов): ${problem.field} — external_id=${externalId}`);
            return jsonRaw(res, 200, aerrBody(4, `Реквизиты чека не прошли проверку: ${problem.field}`, problem));
          }
        }

        // F-15: квота песочницы — документы не растут без границ (hosted).
        const quota = sandboxRuntime.checkDocuments();
        if (!quota.ok) {
          return jsonRaw(res, 200, aerrBody(4, `${quota.kind === 'bytes' ? 'Лимит объёма состояния песочницы исчерпан (байт: ' : 'Лимит документов песочницы исчерпан ('}${quota.used}/${quota.limit}${quota.kind === 'bytes' ? ')' : ''}`, {
            field: 'external_id',
            hint: `${quota.kind === 'bytes' ? 'Песочница ограничена по объёму состояния (байтовая квота, PD-02): сбросьте её (POST /sandboxes/me/reset) или создайте новую (POST /sandboxes).' : 'Песочница ограничена по объёму (MOCK_SANDBOX_MAX_DOCUMENTS): сбросьте её (POST /sandboxes/me/reset) или создайте новую (POST /sandboxes).'}`,
          }));
        }

        const doc = createDocument(operation, groupCode, body, spec);
        if (PROCESS_MS === 0) tickAtol(); // мгновенная печать: сразу выполняем тик
        return sendJson(res, registeredView(doc));
      }

      const reportMatch = /^\/possystem\/v4\/([^/]+)\/report\/([^/]+)$/.exec(url);
      if (req.method === 'GET' && reportMatch) {
        const auth = checkToken(req);
        if (!auth.ok) return jsonRaw(res, 200, authErrorBody(auth.reason, auth.ageMs));
        const groupCode = decodeURIComponent(reportMatch[1]);
        const uuid = decodeURIComponent(reportMatch[2]);
        const doc = state.documents[uuid];
        // Документ живёт в группе: чужой group_code — «не найден» (как в бою).
        if (!doc || doc.group !== groupCode) {
          return jsonRaw(res, 200, aerrBody(10, `Документ не найден в группе «${groupCode}»`, {
            field: 'uuid',
            hint: doc && doc.group !== groupCode
              ? `Документ ${uuid} зарегистрирован в группе «${doc.group}»: отчёт доступен только в своей группе.`
              : 'Проверьте UUID из ответа регистрации документа и группу в URL.',
          }));
        }
        return sendJson(res, reportView(doc));
      }

      // Известный ресурс v4, но не тот метод.
      if (/^\/possystem\/v4\//.test(url)) {
        return jsonRaw(res, 405, aerrBody(4, `Метод ${req.method} не поддерживается маршрутом ${url}`, {
          hint: 'getToken и регистрация документа — POST; отчёт — GET /possystem/v4/{group}/report/{uuid}.',
        }));
      }

      return jsonRaw(res, 404, aerrBody(404, 'Неизвестный маршрут'));
    } catch (e) {
      if (core.sendSandboxStateQuotaError(res, e)) return;
      if (e && e.code === 'SANDBOX_EXPIRED') {
        return sendSandboxError(res, { ok: false, kind: 'expired', sandbox: e.sandbox || admission.record.id });
      }
      if (e && e.code === 'BODY_TOO_LARGE') {
        return jsonRaw(res, 413, aerrBody(4, 'Размер тела запроса превышает допустимый лимит', {
          field: 'body',
          hint: `Уменьшите тело запроса до ${e.maxBytes} байт или менее.`,
        }));
      }
      log('handler error:', e.message);
      return jsonRaw(res, 500, aerrBody(500, e.message));
    }
  });
});

restore();

// После restore/startup-миграций снимок отката должен содержать восстановленные данные.
sandboxRuntime.refreshStateQuota();

if (require.main === module) {
  // MS-04: SIGTERM/SIGINT (docker stop/restart) — синхронно сбросить отложенный
  // реестр песочниц и выйти 0; fallback-таймер 1 с — в packages/core.
  core.installGracefulShutdown({ server, flush: () => sandboxRuntime.flush(), log });
  server.listen(parseInt(MOCK_PORT, 10), MOCK_HOST, () => {
    const port = server.address().port; // MOCK_PORT=0 -> реальный порт
    log(`atol-mock (АТОЛ Онлайн direct API v4, ФФД 1.05) on http://${MOCK_HOST}:${port}`);
    // Публичные тестовые реквизиты v4 — их и нужно вписывать в интеграцию.
    log(`v4 creds: login=${ATOL_LOGIN_CRED} pass=${ATOL_PASSWORD_CRED} group=${GROUPS.join(',')} (тестовый контур, не production)`);
    log(`tenancy=${TENANCY} public_base=${PUBLIC_BASE_URL} token_ttl=${Math.round(TOKEN_TTL_MS / 3600000)}h process_delay=${PROCESS_MS}ms validate=${VALIDATE_RECEIPTS} state=${MOCK_STATE_FILE || 'memory'}`);
    log(`callback: retry ${CALLBACK_RETRY_MS}ms x${CALLBACK_MAX_ATTEMPTS} (ACK — любой 2xx, подпись протоколом v4 не предусмотрена)${MOCK_DEFAULT_CALLBACK_URL ? `, default ${MOCK_DEFAULT_CALLBACK_URL}` : ', default none (только service.callback_url из запроса)'}`);
    log(`control-plane: admin_token=${MOCK_ADMIN_TOKEN ? 'on' : 'off'} operator_token=${OPERATOR_TOKEN ? 'on' : 'off'} hosted=${HOSTED} block_private_webhooks=${BLOCK_PRIVATE_WEBHOOKS}`);
    log(`sandboxes: mode=${TENANCY} ttl_ms=${SANDBOX_TTL_MS} max=${SANDBOX_MAX} max_documents=${SANDBOX_MAX_DOCUMENTS} host_suffix=${SANDBOX_HOST_SUFFIX || '-'} registry=${sandboxRuntime.stats().file || 'memory'} ${core.defaultSandboxStatus({ ownerToken: SANDBOX_OWNER_TOKEN, hosted: HOSTED, tenancy: TENANCY })}`);
    log('вне области: v5/ФФД 1.2 и маркировка «Честный ЗНАК» — отдельный шаг (#34 → next)');
  });
}

module.exports = {
  server, state, clock, scenarios, sandboxRuntime, persist, restore,
  OPERATIONS, VAT_TYPES, PAYMENT_TYPES, SNO_TYPES, GROUPS,
  ATOL_LOGIN_CRED, ATOL_PASSWORD_CRED, ATOL_GROUP_CRED,
  reportView, tickAtol, validateReceipt, rublesToKopecks,
};
