// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * alfa-mock — мок интернет-эквайринга Альфа-Банка (issue #41, Stage 2 —
 * второй ВНЕШНИЙ банк-адаптер стенда).
 *
 * Контракт — REST-интерфейс шлюза (платформа RBS), form-urlencoded:
 *   POST /payment/rest/register.do          одностадийная оплата -> {orderId, formUrl}
 *   POST /payment/rest/registerPreAuth.do   холд (двухстадийная схема; включается банком)
 *   POST /payment/rest/deposit.do           завершение холда (≤ авторизованной суммы)
 *   POST /payment/rest/reverse.do           отмена холда/оплаты до окончательного расчёта
 *   POST /payment/rest/refund.do            полный/частичный возврат списанного
 *   POST /payment/rest/getOrderStatus.do    статус заказа (серверная сверка)
 *   POST /payment/rest/getOrderStatusExtended.do — расширенный статус: состояние,
 *                                           суммы авторизации/списания/возврата, код шлюза
 *   креды userName/password в каждом запросе; amount — в копейках;
 *   orderNumber уникален в пределах магазина; errorCode=0 — результат
 *   API-вызова, НЕ эквивалент финального статуса оплаты.
 *
 * Callbacks — HTTP GET с query-параметрами (mdOrder, orderNumber, operation,
 * status=1/0, amount, callbackCreationDate, checksum), ACK — ровно HTTP 200,
 * ретраи до 200 (число попыток/интервал в официальном PDF НЕ указаны — это
 * mock-конфигурация, а не параметры банка). Checksum — СИММЕТРИЧНЫЙ режим
 * HMAC-SHA256: без checksum/sign_alias, имена параметров сортируются
 * алфавитно, строка «name;value;name;value;…;», hex в верхнем регистре.
 * Асимметричный режим НЕ реализован и не домысливается: официальное описание
 * говорит о SHA-256, а Java-пример (SHA512withRSA) и PHP-пример
 * (OPENSSL_ALGO_SHA512) — о SHA-512; режим подтверждается банком (вне #41).
 *
 * Источники (конспекты проекта):
 *   docs/reference/alfa/01-payment-api.md
 *   docs/reference/alfa/02-notifications-and-signature.md
 *   docs/reference/alfa/03-test-contour.md
 *
 * ЧЕМ ОТЛИЧАЕТСЯ ОТ tbank-mock — НЕ drop-in, хотя предметная модель похожа:
 *   1. база и маршруты: POST /payment/rest/*.do с form-параметрами (Т-Банк —
 *      JSON POST /v2/*);
 *   2. авторизация: userName/password в каждом запросе (Т-Банк — TerminalKey
 *      + подпись Token sha256);
 *   3. суммы: копейки в поле amount (как у Т-Банка), но ответ — {orderId,
 *      formUrl} с errorCode/errorMessage, а не {Success, Status, PaymentId};
 *   4. callback: GET с query и симметричным checksum HMAC-SHA256 (Т-Банк —
 *      подписанный POST с Token и телом-ACK «OK»);
 *   5. статусы: числовые orderStatus 0…6 (Т-Банк — строковые NEW/AUTHORIZED/…).
 *   Использовать tbank-маршруты или алгоритм подписи Token как совместимую
 *   замену нельзя (docs/reference/alfa/01-payment-api.md).
 *
 * ВНЕ ОБЛАСТИ (не домысляем): асимметричный checksum, привязки карт
 * (bindingId), orderBundle (принимается, но не моделируется),
 * paymentOrder.do и альтернативные каналы, различия r-/i-логинов.
 *
 * Ошибки — provider-shaped: {errorCode, errorMessage} + DX-слой мока
 * (field/hint/doc). Zero npm dependencies. Конфигурация — env, см. README.md.
 * ВАЖНО: дефолтные креды — СИНТЕТИЧЕСКИЕ (по образцу TBANKMOCKTEST); реальные
 * тестовые креды банка выдаются индивидуально и в дефолтах не используются.
 * Не выставляйте мок публично без защиты.
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

const log = core.createLog('alfa-mock');

const {
  MOCK_HOST = '0.0.0.0',
  MOCK_PORT = '3104',
  MOCK_ALFA_USERNAME = '',
  ALFA_USERNAME = '',
  MOCK_ALFA_PASSWORD = '',
  ALFA_PASSWORD = '',
  MOCK_ALFA_CALLBACK_SECRET = '',
  ALFA_CALLBACK_SECRET = '',
  MOCK_PUBLIC_BASE_URL = '',
  // Mock-расширение (не протокол): приёмник callback по умолчанию. В бою URL
  // уведомлений задаётся в настройках мерчанта банком — у мока это env.
  MOCK_DEFAULT_CALLBACK_URL = '',
  MOCK_CALLBACK_CHECKSUM = 'true',
  MOCK_CALLBACK_RETRY_MS = '10000',
  MOCK_CALLBACK_MAX_ATTEMPTS = '24',
  // Двухстадийная схема (registerPreAuth.do + deposit.do) включается банком —
  // на стенде env-флаг (docs/reference/alfa/01-payment-api.md).
  MOCK_TWO_STAGE = 'true',
  // Частичное возмещение — «в разрешённом контуре»; на стенде env-флаг.
  MOCK_PARTIAL_REFUND = 'true',
  // SSL-разрешение (операции без 3DS): карта 5555555555555599 успешна только
  // при включённом разрешении (docs/reference/alfa/03-test-contour.md).
  MOCK_SSL_PERMITTED = 'false',
  // Дефолт 20 минут — общая практика платформы RBS; в альфа-конспекте дефолт
  // не зафиксирован (см. protocols/alfa-eacq.json, limits.sessionTimeoutNote).
  MOCK_SESSION_TIMEOUT_SECS = '1200',
  MOCK_ALFA_TERMINAL_ID = 'ALFA-MOCK-1',
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

/*
 * Дефолты мока — СИНТЕТИЧЕСКИЕ креды по образцу TBANKMOCKTEST (требование #41):
 * реальные тестовые userName/password Альфа-Банка выдаёт индивидуально при
 * подключении, и ставить их в дефолты конфига нельзя
 * (docs/reference/alfa/03-test-contour.md).
 */
const DEFAULT_USER_NAME = 'ALFAMOCKTEST';
const DEFAULT_PASSWORD = 'mockpass123';
// Секрет симметричного checksum (HMAC-SHA256) — тоже синтетический.
const DEFAULT_CALLBACK_SECRET = 'mocksecret123';
const USER_NAME_CRED = MOCK_ALFA_USERNAME || ALFA_USERNAME || DEFAULT_USER_NAME;
const PASSWORD_CRED = MOCK_ALFA_PASSWORD || ALFA_PASSWORD || DEFAULT_PASSWORD;
const CALLBACK_SECRET_CRED = MOCK_ALFA_CALLBACK_SECRET || ALFA_CALLBACK_SECRET || DEFAULT_CALLBACK_SECRET;

/*
 * PG-01/PG-02: наружу (HTTP-ответы, hint, stdout) уходят ТОЛЬКО синтетические
 * дефолты DEFAULT_*. Фактические значения (env или per-sandbox creds) —
 * USER_NAME_CRED/PASSWORD_CRED/CALLBACK_SECRET_CRED, alfaUserName()/alfaPassword()
 * — используются лишь для сравнения и подписи checksum и нигде не печатаются.
 */
const credLogView = (actual, dflt) => (actual === dflt ? dflt : '<задан через env, скрыт>');

// Публичный адрес стенда: от него строится formUrl платёжной страницы.
const PUBLIC_BASE_URL = String(MOCK_PUBLIC_BASE_URL || '').trim() || `http://localhost:${MOCK_PORT}`;

const CHECKSUM_ENABLED = core.flagEnabled(MOCK_CALLBACK_CHECKSUM, true);
const TWO_STAGE = core.flagEnabled(MOCK_TWO_STAGE, true);
const PARTIAL_REFUND = core.flagEnabled(MOCK_PARTIAL_REFUND, true);
const SSL_PERMITTED = core.flagEnabled(MOCK_SSL_PERMITTED, false);
const TERMINAL_ID = String(MOCK_ALFA_TERMINAL_ID || 'ALFA-MOCK-1');

/**
 * PB-11/PG-05 (класс MS-08/PB-03/PF-03): числовые env — только через
 * каноничный парсер ядра. `parseInt(x, 10) || N` запрещён (AGENTS §8): он
 * молча съедает суффиксы (`'1h'` -> 1) и не даёт семантики нуля. Значение,
 * которое не разбирается, — WARN и фолбэк: тихий фолбэк и есть дефект класса.
 */
function envNumber(name, raw, fallback, { min = 0, unit = '' } = {}) {
  const text = String(raw ?? '').trim();
  if (text && core.parseDuration(text) === null) {
    log(`WARN ${name}=${JSON.stringify(text)} не разобран — используется ${fallback} (число${unit ? ` ${unit}` : ''} либо длительность вида '30s'/'1h')`);
    return fallback;
  }
  const value = parseMsOr(raw, fallback);
  if (value < min) {
    log(`WARN ${name}=${value}${unit ? ` ${unit}` : ''} меньше минимума ${min} — используется ${min}`);
    return min;
  }
  return value;
}

/**
 * Секунды: голое число — секунды (обратная совместимость:
 * `MOCK_SESSION_TIMEOUT_SECS=1200`), суффикс — длительность через
 * parseDuration ядра (`'1h'` -> 3600). Меньше секунды смысла не имеет.
 */
function envSeconds(name, raw, fallback) {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  if (/^\d+$/.test(text)) {
    const secs = parseInt(text, 10);
    if (secs >= 1) return secs;
    log(`WARN ${name}=${JSON.stringify(text)}: срок меньше 1 с не определён — используется ${fallback}`);
    return fallback;
  }
  const ms = core.parseDuration(text);
  if (ms === null || ms < 1000) {
    log(`WARN ${name}=${JSON.stringify(text)} не разобран — используется ${fallback} (число секунд либо длительность вида '20m'/'1h')`);
    return fallback;
  }
  return Math.round(ms / 1000);
}

// Ретраи callback: PDF не задаёт ни число попыток, ни интервал — это
// mock-конфигурация (не копировать параметры Т-Банка/Сбера как «родные»).
// Семантика нуля (PB-11) явная: RETRY_MS=0 — повтор без паузы (на следующем
// тике очереди), MAX_ATTEMPTS ниже 1 — не определён (WARN, ровно одна попытка
// без ретраев). Выключить уведомления целиком — сценарий webhook-drop, а не env.
const CALLBACK_RETRY_MS = envNumber('MOCK_CALLBACK_RETRY_MS', MOCK_CALLBACK_RETRY_MS, 10000, { unit: 'мс' });
const CALLBACK_MAX_ATTEMPTS = envNumber('MOCK_CALLBACK_MAX_ATTEMPTS', MOCK_CALLBACK_MAX_ATTEMPTS, 24, { min: 1 });
const SESSION_TIMEOUT_SECS = envSeconds('MOCK_SESSION_TIMEOUT_SECS', MOCK_SESSION_TIMEOUT_SECS, 1200);

// Лимит orderNumber — интерпретация мока по общей практике RBS (в конспекте
// не зафиксирован; см. protocols/alfa-eacq.json limits.orderNumberNote).
const ORDER_NUMBER_MAX = 64;
const RETURN_URL_MAX = 2048;

// F-07/F-08: hosted включает fail-closed управляющей поверхности и SSRF-политику.
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
 * Начальное состояние песочницы. `seed` уникален: счётчики callback не
 * совпадают между арендаторами (orderId — uuid, seed не нужен).
 */
function createInitialAlfaState({ seed = 0 } = {}) {
  return {
    counters: { callbackId: 1 + seed * 1000000 },
    orders: {},        // orderId -> заказ
    orderNumbers: {},  // orderNumber -> orderId (уникальность в пределах магазина)
    callbacks: {},     // id -> запись очереди callback
    clockOffsetMs: 0,
  };
}

{
  const initial = createInitialAlfaState();
  for (const key of Object.keys(initial)) {
    if (defaultState[key] === undefined) defaultState[key] = initial[key];
  }
}

/** Лимит документов песочницы (F-15): всё, что растёт от запросов интегратора. */
/**
 * Квота документов песочницы (PB-12, F-14/F-15): документы мерчанта — заказы
 * и записи очереди callback. `orderNumbers` — внутренний индекс уникальности
 * (orderNumber -> orderId), а не документ: его учёт давал двойное списание
 * квоты на одну регистрацию (заказ + индекс), поэтому индекс исключён —
 * «документ = заказ», как у tbank (`payments` + `notifications`).
 */
function countAlfaDocuments(snapshot) {
  return ['orders', 'callbacks']
    .reduce((sum, key) => sum + Object.keys(snapshot[key] || {}).length, 0);
}

/**
 * Retention (F-15, по умолчанию выключен): чистим только терминальные
 * диагностические записи (доставленные/исчерпанные callback). История
 * заказов — протокольная, её не удаляем.
 */
function alfaRetention(snapshot, ts) {
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
  return pruned;
}

// Дочернее состояние записи песочницы (#52): сценарии и журнал создаются
// ниже; runtime зовёт этот hook при удалении/TTL записи, когда они уже готовы.
let dropSandboxChildState = () => {};
const sandboxRuntime = createSandboxRuntime({
  state: defaultState,
  persist: store.persist,
  initialStateFactory: createInitialAlfaState,
  mode: TENANCY,
  stateFile: MOCK_STATE_FILE,
  sandboxFile: String(process.env.MOCK_SANDBOX_FILE || ''),
  ttlMs: SANDBOX_TTL_MS,
  maxSandboxes: SANDBOX_MAX,
  maxDocuments: SANDBOX_MAX_DOCUMENTS,
  maxStateBytes: parseMsOr(MOCK_SANDBOX_MAX_STATE_BYTES, null),
  globalMaxStateBytes: parseMsOr(MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES, null),
  documentCounter: countAlfaDocuments,
  retention: alfaRetention,
  defaultOwnerToken: SANDBOX_OWNER_TOKEN,
  hostSuffix: SANDBOX_HOST_SUFFIX,
  operatorTokens: [MOCK_ADMIN_TOKEN, OPERATOR_TOKEN],
  createLimit: SANDBOX_CREATE_LIMIT,
  onSandboxRemoved: (record) => dropSandboxChildState(record),
  log: (msg) => console.error(`[alfa-mock] ${msg}`),
});

const state = sandboxRuntime.state;
const persist = sandboxRuntime.persist;

// Журнал — per-sandbox раздел записи текущей песочницы (PB-13, #52).
const journal = core.createJournal({ size: 200, sandboxScope: () => sandboxRuntime.current() });

/* --------------------------------------------------- креды песочницы (F-12) */

/**
 * В owned-режиме у каждой песочницы свои userName/password/секрет checksum
 * (интегратор проходит тот же путь, что в бою: «впиши реквизиты кабинета»).
 * В остальных режимах — синтетические креды стенда.
 */
const alfaUserName = () => sandboxRuntime.creds().userName || USER_NAME_CRED;
const alfaPassword = () => sandboxRuntime.creds().password || PASSWORD_CRED;
const callbackSecret = () => sandboxRuntime.creds().callbackSecret || CALLBACK_SECRET_CRED;

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

/* ------------------------------------------------------- тестовые карты */

/**
 * Тестовые карты Альфа-Банка (docs/reference/alfa/03-test-contour.md):
 * 3DS1/SSL, 3DS2 challenge/frictionless, отказы -2011 (PaRes=U) и 116
 * (недостаточно средств). Срок/CVV из таблицы — тестовые данные; ACS-пароль
 * 12345678; неверный срок/CVV либо Fail на ACS — шлюзовой код 71015
 * («введённая информация неверна»). PAN в state не хранится (F-10): только
 * маска first6**last4.
 */
const CARDS = {
  // 3DS 1.0 / SSL
  '4111111111111111': { tds: '3ds1', outcome: 'success', exp: '1234', cvv: '123', label: 'Visa — 3DS1, успех' },
  '639002000000000003': { tds: '3ds1', outcome: 'success', exp: '1234', cvv: '123', label: 'МИР (18 цифр) — 3DS1, успех' },
  '5555555555555599': { tds: 'ssl', outcome: 'ssl', exp: '1234', cvv: '123', label: 'MC — без 3DS: успех только при SSL-разрешении' },
  '5555555555555557': { tds: '3ds1', outcome: 'decline', actionCode: -2011, actionText: 'Отказ 3DS: PaRes=U (аутентификация невозможна)', exp: '1234', cvv: '123', label: 'MC — 3DS1, отказ PaRes=U (-2011)' },
  '4444333322221111': { tds: '3ds1', outcome: 'decline', actionCode: -2011, actionText: 'Отказ 3DS: PaRes=U (аутентификация невозможна)', exp: '1234', cvv: '123', label: 'Visa — 3DS1, отказ PaRes=U (-2011)' },
  '5555555544444442': { tds: '3ds1', outcome: 'decline', actionCode: -2011, actionText: 'Отказ 3DS: PaRes=U (аутентификация невозможна)', exp: '1234', cvv: '123', label: 'MC — 3DS1, отказ PaRes=U (-2011)' },
  '5432543254325430': { tds: '3ds1', outcome: 'decline', actionCode: 116, actionText: 'Недостаточно средств на карте', exp: '1234', cvv: '521', label: 'MC — 3DS1, недостаточно средств (116)' },
  // 3DS 2.0
  '2201382000000021': { tds: '3ds2-challenge', outcome: 'success', exp: '1234', cvv: '123', label: 'МИР — 3DS2 challenge (подтверждение ACS)' },
  '2201382000000039': { tds: '3ds2-challenge', outcome: 'success', exp: '1234', cvv: '123', label: 'МИР — 3DS2 challenge (подтверждение ACS)' },
  '2201382000000013': { tds: '3ds2-challenge', outcome: 'success', exp: '1234', cvv: '123', label: 'МИР — 3DS2 challenge (подтверждение ACS)' },
  '2201382000000047': { tds: '3ds2-challenge', outcome: 'success', exp: '1234', cvv: '123', label: 'МИР — 3DS2 challenge (подтверждение ACS)' },
  '2201382000000054': { tds: '3ds2-challenge', outcome: 'success', exp: '1234', cvv: '123', label: 'МИР — 3DS2 challenge (подтверждение ACS)' },
  '2200000000000053': { tds: '3ds2-challenge', outcome: 'success', exp: '1234', cvv: '123', label: 'МИР — 3DS2 challenge (подтверждение ACS)' },
  '2201382000000062': { tds: '3ds2-frictionless', outcome: 'success', exp: '1234', cvv: '123', label: 'МИР — 3DS2 frictionless (без подтверждения)' },
};

// ACS-пароль тестового контура (docs/reference/alfa/03-test-contour.md).
const ACS_PASSWORD = '12345678';
// «Введённая информация неверна» — неверный срок/CVV либо Fail на ACS.
const ACTION_CODE_INVALID_INFO = 71015;
// Общий отказ эмитента (мок: неизвестная валидная карта, операция без 3DS
// при выключенном SSL-разрешении) — см. protocols/alfa-eacq.json actionCodeNote.
const ACTION_CODE_DO_NOT_HONOR = 5;

/** Контрольная сумма Луна: отличает случайные длинные числа от PAN. */
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

/* ------------------------------------------------ orderStatus (платформа RBS) */

/**
 * Состояния заказа (общая нумерация платформы RBS; таблица снята в
 * docs/reference/sber/01-payment-api.md для того же семейства шлюзов —
 * тестовый контур Альфы alfa.rbsuat.com. В альфа-конспекте своя таблица не
 * зафиксирована — это документированная интерпретация мока, см. README
 * «Границы и форки»).
 */
const ORDER_STATUSES = {
  0: 'Заказ зарегистрирован, не оплачен',
  1: 'Сумма захолдирована (двухстадийная схема)',
  2: 'Полная авторизация/оплата проведена',
  3: 'Авторизация отменена (reverse)',
  4: 'По заказу проведён возврат',
  5: 'Начата аутентификация через ACS эмитента',
  6: 'Авторизация отклонена',
};

/* ----------------------------------------------------------- DX-ошибки */

/*
 * ФОРМАТ: {errorCode, errorMessage} — как отвечает шлюз RBS; field/hint/doc —
 * DX-слой мока (не часть протокола). Числовая таблица кодов в альфа-конспекте
 * НЕ снята: используется классическая таблица платформы RBS (0—6), маппинг
 * частных случаев задокументирован в README и protocols/alfa-eacq.json.
 *
 * Протокольные ошибки отдаются с HTTP 200 (сводить их к HTTP-коду нельзя —
 * так отвечает шлюз); реальные HTTP-коды — у инфраструктуры (404/405/413/
 * 500/504), там errorCode=6 «системная ошибка» сопровождается честным статусом.
 */
const derr = core.createErrorCatalog({
  provider: 'alfa-eacq',
  docsBase: 'https://alfabank.ru/sme/payservice/internet-acquiring/docs/connection-options/api',
  codes: {
    1: {
      message: 'Номер заказа уже зарегистрирован',
      field: 'orderNumber',
      hint: 'orderNumber уникален в пределах магазина: повтор — ошибка (в отличие от идемпотентных контрактов вроде external_id у АТОЛ). Возьмите новый номер; состояние прежнего заказа — getOrderStatusExtended.do.',
      doc: '/rest/',
    },
    2: {
      message: 'Merchant-логин не найден или неверный пароль',
      field: 'userName, password',
      hint: 'Проверьте userName/password: дефолты стенда — синтетические (ALFAMOCKTEST/mockpass123), печатаются в стартовом логе; переопределяются MOCK_ALFA_USERNAME/MOCK_ALFA_PASSWORD. Реальные тестовые креды банк выдаёт индивидуально — в дефолтах мока они не используются.',
      doc: '/general-description/',
    },
    3: {
      message: 'Номер заказа некорректен',
      field: 'orderNumber',
      hint: 'Передайте orderNumber (строка ≤64 символов) при регистрации либо orderId/orderNumber существующего заказа.',
      doc: '/rest/',
    },
    4: {
      message: 'Состояние заказа некорректно',
      field: 'orderId',
      hint: 'Операция не разрешена в текущем orderStatus: сверьте состояние через getOrderStatusExtended.do (см. таблицу статусов в docs/integration/alfa.md).',
      doc: '/rest/',
    },
    5: {
      message: 'Операция отклонена',
      hint: 'Проверьте параметры (amount — целые копейки > 0, returnUrl — http(s)-URL, currency — 643) и лимиты сумм (deposit ≤ авторизации, refund ≤ списанного).',
      doc: '/rest/',
    },
    6: {
      message: 'Системная ошибка',
      hint: 'Повторите запрос после паузы и сверьте состояние заказа через getOrderStatusExtended.do; если воспроизводится — это дефект мока, заводите issue.',
      doc: '/rest/',
    },
  },
});

/**
 * Ошибка в форме шлюза: {errorCode, errorMessage} + DX-поля мока
 * (field/hint/doc). `message` переопределяет текст каталога.
 */
function aerr(code, message, overrides = {}) {
  const desc = derr(code, { message: typeof message === 'string' ? message : undefined, ...overrides });
  const body = { errorCode: code, errorMessage: desc.message };
  if (desc.field) body.field = overrides.field || desc.field;
  if (desc.hint) body.hint = desc.hint;
  if (desc.doc) body.doc = desc.doc;
  return body;
}

function aerrBody(code, message, overrides = {}) {
  return JSON.stringify(aerr(code, message, overrides));
}

/** Ответ готовой JSON-строкой (aerrBody уже стрингифицирован). */
function jsonRaw(res, code, body) {
  send(res, code, body, { 'Content-Type': 'application/json; charset=utf-8' });
}

/** Успешный ответ шлюза: errorCode=0 + пустое errorMessage + поля результата. */
function okBody(extra = {}) {
  return { errorCode: 0, errorMessage: '', ...extra };
}

/* -------------------------------------------------------- авторизация */

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

/**
 * Креды в каждом запросе (userName/password), сравнение в постоянном времени.
 * Возвращает JSON-строку ошибки (errorCode=2) или null.
 */
function verifyCreds(body) {
  const givenUser = String(body.userName === undefined || body.userName === null ? '' : body.userName).trim();
  const givenPass = String(body.password === undefined || body.password === null ? '' : body.password);
  if (!constantTimeEqual(givenUser, alfaUserName())) {
    log(`отказ авторизации: userName=${core.maskPiiValue('login', givenUser)} не найден`);
    return aerrBody(2, 'Merchant-логин не найден', {
      field: 'userName',
      hint: `userName не совпадает с кредами стенда (дефолт ${DEFAULT_USER_NAME} — синтетический, по образцу TBANKMOCKTEST; действует, только если не переопределён env). Свои креды — MOCK_ALFA_USERNAME/MOCK_ALFA_PASSWORD; в owned-песочнице — creds из POST /sandboxes. Реальные тестовые креды банка выдаются индивидуально и в дефолтах мока не используются.`,
    });
  }
  if (!constantTimeEqual(givenPass, alfaPassword())) {
    log(`отказ авторизации: неверный password для userName=${core.maskPiiValue('login', givenUser)}`);
    return aerrBody(2, 'Неверный пароль', {
      field: 'password',
      hint: `password не совпадает с паролем стенда. Дефолты мока — синтетические (${DEFAULT_USER_NAME}/${DEFAULT_PASSWORD} по образцу TBANKMOCKTEST; действуют, только если не переопределены env); переопределяются MOCK_ALFA_PASSWORD (в owned-песочнице — POST /sandboxes/me/reset-creds).`,
    });
  }
  return null;
}

/* --------------------------------------------- callback: GET + checksum */

/**
 * Каноническая строка checksum (docs/reference/alfa/02-notifications-and-signature.md):
 *   1. удалить checksum и sign_alias;
 *   2. отсортировать оставшиеся имена параметров в алфавитном порядке;
 *   3. построить строку «name;value;name;value;…;».
 */
function canonicalChecksumString(params) {
  return Object.keys(params)
    .filter((name) => name !== 'checksum' && name !== 'sign_alias')
    .sort()
    .map((name) => `${name};${params[name]};`)
    .join('');
}

/**
 * Симметричный режим: HMAC-SHA256 с общим секретным ключом, hex в ВЕРХНЕМ
 * регистре (в Java/PHP-примерах PDF сравнение без учёта регистра).
 *
 * Асимметричный режим (проверка публичным ключом сертификата) НЕ реализован:
 * общее описание PDF говорит о SHA-256, но примеры SHA512withRSA /
 * OPENSSL_ALGO_SHA512 — о SHA-512; выбор подтверждается банком по
 * merchant-аккаунту и sign_alias. Домысливать нельзя (вне области #41).
 */
function checksumOf(params, secret) {
  return crypto.createHmac('sha256', String(secret))
    .update(canonicalChecksumString(params))
    .digest('hex')
    .toUpperCase();
}

/**
 * Очередь доставки callback (ядро: ретраи, SSRF-guard, дедуп-сценарии).
 * Доставка — HTTP GET с query-параметрами; ACK — РОВНО HTTP 200 (любой иной
 * код считается неуспехом, и банк повторяет доставку до 200 либо до лимита
 * подряд неуспешных попыток; сами параметры ретраев PDF не задаёт —
 * MOCK_CALLBACK_RETRY_MS × MOCK_CALLBACK_MAX_ATTEMPTS это mock-конфигурация).
 */
const deliveryQueue = core.createDeliveryQueue({
  entries: () => state.callbacks,
  retryMs: CALLBACK_RETRY_MS,
  maxAttempts: CALLBACK_MAX_ATTEMPTS,
  persist,
  log,
  now: () => clock.now(),
  request: (entry) => ({ url: entry.url, method: 'GET' }),
  isOk: (res) => res.statusCode === 200,
  blockPrivateHosts: BLOCK_PRIVATE_WEBHOOKS,
  due: (entry) => !entry.done && !entry.dumped && !entry.suppressed && (entry.nextAttemptAt || 0) <= clock.now(),
  prepare: (entry) => { entry.attempts += 1; },
  onFailure: (entry, status, body) => {
    entry.lastStatus = status;
    entry.lastBody = body;
    // PG-07: отказ SSRF-политики — терминальное состояние, а не сетевой сбой.
    // Ядро ретраит любой throw (24×10 с по умолчанию), но приватность цели от
    // повтора не меняется: цикл только жжёт интервал и держит запись «в полёте».
    // Маркер ядро кладёт первым аргументом в формате `ERR <code>: <message>`
    // (deliverOne: `ERR ${e.code}: ${e.message}`), webhookDiagnosticBody его не
    // редактирует (лимит 1024 символа — не срабатывает). `due()` такие записи
    // (dumped) уже пропускает. Ядро createDeliveryQueue не трогаем (PG-07).
    if (String(status).includes('ERR SSRF_BLOCKED')) {
      entry.dumped = true;
      entry.nextAttemptAt = null;
      log(`callback ${entry.id} не доставлен: цель заблокирована политикой SSRF (${entry.url}) — повтор не имеет смысла, терминальный статус зафиксирован`);
      return;
    }
    if (entry.attempts >= CALLBACK_MAX_ATTEMPTS) {
      entry.dumped = true;
      log(`callback ${entry.id} сброшен после ${entry.attempts} попыток`);
    } else {
      entry.nextAttemptAt = clock.now() + CALLBACK_RETRY_MS;
    }
  },
  onSuccess: (entry) => {
    entry.done = true;
    entry.nextAttemptAt = null;
    // lastStatus/lastBody уже проставлены deliverOne (statusCode + тело ответа).
    entry.finishedAt = clock.iso();
  },
});

/**
 * URL приёмника уведомлений: в бою он задаётся в настройках мерчанта банком;
 * у мока — jsonParams.callback_url (mock-расширение) либо
 * MOCK_DEFAULT_CALLBACK_URL. Без адреса callback не уходит — сверка через
 * getOrderStatusExtended.do.
 */
function callbackUrlFor(order) {
  const override = order && order.callbackUrl;
  if (override) return String(override).trim();
  return String(process.env.MOCK_DEFAULT_CALLBACK_URL || MOCK_DEFAULT_CALLBACK_URL || '').trim();
}

/**
 * Постановка callback в очередь: GET с параметрами mdOrder, orderNumber,
 * operation, status (1 — операция успешна, 0 — завершилась ошибкой), amount,
 * callbackCreationDate и checksum (симметричный HMAC-SHA256; отключается
 * MOCK_CALLBACK_CHECKSUM=false — эмуляция неподписанного уведомления, которое
 * по PDF можно подделать: приёмник обязан сверять статус через REST).
 * Сценарии: webhook-drop|no-webhook|no-callback (подавить),
 * webhook-duplicate|callback-duplicate (две копии — приёмник идемпотентен).
 */
function scheduleCallback(order, operation, statusValue, amountK, { spec = null } = {}) {
  const target = callbackUrlFor(order);
  if (!target) {
    log(`${operation} ${order.orderId}: callback URL не задан (jsonParams.callback_url / MOCK_DEFAULT_CALLBACK_URL) — сверка через getOrderStatusExtended.do`);
    return [];
  }
  const suppressed = Boolean(spec && (spec.has('webhook-drop') || spec.has('no-webhook') || spec.has('no-callback')));
  const duplicate = Boolean(spec && (spec.has('webhook-duplicate') || spec.has('callback-duplicate')));
  const params = {
    mdOrder: order.orderId,
    orderNumber: order.orderNumber,
    operation,
    status: String(statusValue),
    amount: String(amountK),
    callbackCreationDate: String(clock.now()),
  };
  if (CHECKSUM_ENABLED) params.checksum = checksumOf(params, callbackSecret());
  const query = new URLSearchParams();
  for (const name of Object.keys(params).sort()) query.set(name, params[name]);
  const fullUrl = `${target}${target.includes('?') ? '&' : '?'}${query.toString()}`;
  const count = duplicate && !suppressed ? 2 : 1;
  const created = [];
  for (let i = 0; i < count; i += 1) {
    const id = String(state.counters.callbackId++);
    state.callbacks[id] = {
      id,
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      operation,
      callbackStatus: statusValue,
      url: fullUrl,
      query: query.toString(),
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
    log(`callback ${id} ${suppressed ? 'SUPPRESSED (webhook-drop)' : 'queued'}: GET ${operation} status=${statusValue} order=${order.orderId}`);
  }
  persist();
  return created;
}

/* --------------------------------------------------------- заказы (orders) */

function findOrder(id) {
  return state.orders[String(id || '')] || null;
}

/**
 * Поиск заказа по orderId ИЛИ orderNumber (RBS: один из двух параметров).
 * Возвращает {order} | {errorBody}: неизвестный/отсутствующий идентификатор —
 * errorCode 3 «Номер заказа некорректен».
 */
function resolveOrder(body) {
  const orderId = String(body.orderId === undefined || body.orderId === null ? '' : body.orderId).trim();
  const orderNumber = String(body.orderNumber === undefined || body.orderNumber === null ? '' : body.orderNumber).trim();
  if (!orderId && !orderNumber) {
    return {
      order: null,
      errorBody: aerr(3, 'Не передан идентификатор заказа', {
        field: 'orderId, orderNumber',
        hint: 'Передайте orderId (из ответа регистрации) или orderNumber (номер заказа в вашем магазине) — достаточно одного.',
      }),
    };
  }
  const order = orderId ? findOrder(orderId) : findOrder(state.orderNumbers[orderNumber]);
  if (!order) {
    return {
      order: null,
      errorBody: aerr(3, 'Заказ не найден', {
        field: orderId ? 'orderId' : 'orderNumber',
        hint: orderId
          ? `Заказ с orderId «${orderId.slice(0, 64)}» не зарегистрирован в этом стенде (после рестарта с пустым MOCK_STATE_FILE старые заказы недоступны).`
          : `Заказ с orderNumber «${orderNumber.slice(0, 64)}» не зарегистрирован в этом стенде.`,
      }),
    };
  }
  return { order, errorBody: null };
}

/** Общий ответ статуса (getOrderStatus.do / getOrderStatusExtended.do). */
function statusView(order, extended) {
  const base = {
    errorCode: 0,
    errorMessage: '',
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    orderStatus: order.status,
    actionCode: order.actionCode === null || order.actionCode === undefined ? 0 : order.actionCode,
    actionCodeDescription: order.actionCodeDescription || ORDER_STATUSES[order.status] || '',
    amount: order.amountK,
    date: order.createdAtMs,
    terminalId: TERMINAL_ID,
  };
  if (order.maskPan) base.maskPan = order.maskPan;
  if (order.cardAuthCode) base.cardAuthCode = order.cardAuthCode;
  if (order.description) base.orderDescription = order.description;
  if (!extended) return base;
  /*
   * Расширенный ответ различает состояние заказа, суммы авторизации/списания/
   * возврата и код ответа шлюза (docs/reference/alfa/01-payment-api.md).
   * Состав полей — интерпретация мока по требованию конспекта; точная схема
   * RBS-ответа в конспекте не снята (см. README «Границы и форки»).
   */
  return {
    ...base,
    authorizedAmount: order.authorizedK === null ? 0 : order.authorizedK,
    depositedAmount: order.depositedK || 0,
    refundedAmount: order.refundedK || 0,
    ...(order.authDate !== null ? { authDate: order.authDate } : {}),
    ...(order.depositDate !== null ? { depositDate: order.depositDate } : {}),
    ...(order.reverseDate !== null ? { reverseDate: order.reverseDate } : {}),
    ...(order.refundDate !== null ? { refundDate: order.refundDate } : {}),
    ...(order.declinedAt !== null ? { declinedDate: order.declinedAt } : {}),
  };
}

/* ---------------------------------------------- переходы состояния заказа */

/** Успех авторизации на форме: холд (two-stage) либо сразу списание. */
function finalizeSuccess(order, { maskPan, tds, spec = null }) {
  order.maskPan = maskPan;
  order.actionCode = 0;
  order.actionCodeDescription = 'Одобрено';
  order.cardAuthCode = String(crypto.randomInt(100000, 999999));
  order.authDate = clock.now();
  order.authorizedK = order.amountK;
  order.pending3ds = null;
  order.tdsApplied = Boolean(tds);
  if (order.twoStage) {
    order.status = 1;
    persist();
    scheduleCallback(order, 'approved', 1, order.authorizedK, { spec });
    log(`заказ ${order.orderId}: холд ${order.authorizedK} коп. (orderStatus=1, two-stage) — завершение через deposit.do`);
  } else {
    order.status = 2;
    order.depositedK = order.amountK;
    order.depositDate = clock.now();
    persist();
    scheduleCallback(order, 'deposited', 1, order.depositedK, { spec });
    log(`заказ ${order.orderId}: списание ${order.depositedK} коп. (orderStatus=2, одностадийная оплата)`);
  }
  persist();
}

/**
 * Отказ карточной авторизации: orderStatus=6 + actionCode шлюза (-2011, 116,
 * 71015, 5). Callback — операция declinedCardpresent со status=0 (семантика
 * операции в PDF не раскрыта — см. protocols/alfa-eacq.json operationNote;
 * источник истины — getOrderStatusExtended.do).
 */
function finalizeDecline(order, actionCode, description, { maskPan = null, spec = null } = {}) {
  if (maskPan) order.maskPan = maskPan;
  order.status = 6;
  order.actionCode = actionCode;
  order.actionCodeDescription = description;
  order.pending3ds = null;
  order.declinedAt = clock.now();
  persist();
  scheduleCallback(order, 'declinedCardpresent', 0, order.amountK, { spec });
  log(`заказ ${order.orderId}: ОТКЛОНЁН actionCode=${actionCode} (${description})`);
}

/** Истечение срока оплаты (sessionTimeoutSecs): orderStatus=6 + declinedByTimeout. */
function declineByTimeout(order) {
  order.status = 6;
  order.actionCode = 0;
  order.actionCodeDescription = `Истёк срок оплаты заказа (sessionTimeoutSecs=${order.sessionTimeoutSecs})`;
  order.pending3ds = null;
  order.declinedAt = clock.now();
  persist();
  scheduleCallback(order, 'declinedByTimeout', 0, order.amountK);
  log(`заказ ${order.orderId}: отклонён по таймауту сессии (declinedByTimeout)`);
}

/** Завершение холда (deposit.do / кнопка в /admin): orderStatus=2. */
function completeDeposit(order, amountK, { spec = null } = {}) {
  order.status = 2;
  order.depositedK = amountK;
  order.depositDate = clock.now();
  order.actionCode = 0;
  order.actionCodeDescription = 'Одобрено';
  persist();
  scheduleCallback(order, 'deposited', 1, amountK, { spec });
  log(`заказ ${order.orderId}: deposit ${amountK} коп. (авторизовано ${order.authorizedK} коп.) -> orderStatus=2`);
}

/** Отмена холда/оплаты (reverse.do / кнопка в /admin): orderStatus=3. */
function applyReverse(order, { spec = null } = {}) {
  const amountK = order.status === 1 ? (order.authorizedK || 0) : (order.depositedK || 0);
  order.status = 3;
  order.reverseDate = clock.now();
  order.actionCode = 0;
  order.actionCodeDescription = 'Авторизация отменена (reverse)';
  persist();
  scheduleCallback(order, 'reversed', 1, amountK, { spec });
  log(`заказ ${order.orderId}: reverse ${amountK} коп. -> orderStatus=3`);
}

/** Возврат списанного (refund.do): orderStatus=4, полный/частичный. */
function applyRefund(order, amountK, { spec = null } = {}) {
  order.refundedK = (order.refundedK || 0) + amountK;
  order.status = 4;
  order.refundDate = clock.now();
  order.actionCode = 0;
  order.actionCodeDescription = 'Проведён возврат';
  persist();
  scheduleCallback(order, 'refunded', 1, amountK, { spec });
  log(`заказ ${order.orderId}: refund ${amountK} коп. (всего возвращено ${order.refundedK} из ${order.depositedK}) -> orderStatus=4`);
}

/* --------------------------------------------------------- тик и таймауты */

/**
 * Авто-переходы по виртуальным часам: истечение срока оплаты
 * (sessionTimeoutSecs) для неоплаченных заказов и заказов в ACS —
 * declinedByTimeout (orderStatus=6 + callback).
 */
function tickAlfa() {
  const now = clock.now();
  for (const order of Object.values(state.orders)) {
    if ((order.status === 0 || order.status === 5) && order.expiresAtMs && now >= order.expiresAtMs) {
      declineByTimeout(order);
    }
  }
}

setInterval(() => {
  // Тик обслуживает КАЖДУЮ песочницу в её контексте (F-11).
  sandboxRuntime.tickAll(() => {
    tickAlfa();
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

/* ------------------------------------------------- валидация регистрации */

function validHttpUrl(raw) {
  const text = String(raw || '').trim();
  if (!text || text.length > RETURN_URL_MAX) return false;
  try {
    const u = new URL(text);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Регистрация заказа (register.do / registerPreAuth.do). Возвращает outcome
 * {status, body}; побочные эффекты (persist) — внутри. Обязательные поля:
 * уникальный orderNumber, amount (копейки), returnUrl (конспект 01).
 */
function handleRegister(body, spec, twoStage) {
  void spec; // регистрация не шлёт callback — сценарии нужны операциям перехода
  if (twoStage && !TWO_STAGE) {
    return {
      status: 200,
      body: aerr(5, 'Двухстадийная оплата не подключена для merchant-логина', {
        field: 'registerPreAuth.do',
        hint: 'Доступность двухстадийной схемы (registerPreAuth.do + deposit.do) включается банком отдельно. На стенде она управляется MOCK_TWO_STAGE (по умолчанию включена); используйте register.do для одностадийной оплаты.',
        doc: '/integration-schemes/',
      }),
    };
  }

  // F-15: квота песочницы — заказы не растут без границ (hosted).
  const quota = sandboxRuntime.checkDocuments();
  if (!quota.ok) {
    return {
      status: 200,
      body: aerr(5, `${quota.kind === 'bytes' ? 'Лимит объёма состояния песочницы исчерпан (байт: ' : 'Лимит документов песочницы исчерпан ('}${quota.used}/${quota.limit}${quota.kind === 'bytes' ? ')' : ''}`, {
        field: 'orderNumber',
        hint: `${quota.kind === 'bytes' ? 'Песочница ограничена по объёму состояния (байтовая квота, PD-02): сбросьте её (POST /sandboxes/me/reset) или создайте новую (POST /sandboxes).' : 'Песочница ограничена по объёму (MOCK_SANDBOX_MAX_DOCUMENTS): сбросьте её (POST /sandboxes/me/reset) или создайте новую (POST /sandboxes).'}`,
      }),
    };
  }

  /* -- orderNumber: обязателен, ≤64 символов, уникален в пределах магазина -- */
  const orderNumber = String(body.orderNumber === undefined || body.orderNumber === null ? '' : body.orderNumber).trim();
  if (!orderNumber) {
    return {
      status: 200,
      body: aerr(3, 'Номер заказа не передан', {
        field: 'orderNumber',
        hint: 'orderNumber — строковый номер заказа в вашем магазине, обязательное поле регистрации.',
      }),
    };
  }
  if (orderNumber.length > ORDER_NUMBER_MAX) {
    return {
      status: 200,
      body: aerr(3, `Номер заказа длиннее ${ORDER_NUMBER_MAX} символов (${orderNumber.length})`, {
        field: 'orderNumber',
        hint: `Сократите orderNumber до ${ORDER_NUMBER_MAX} символов (лимит мока по общей практике RBS).`,
      }),
    };
  }
  const knownId = state.orderNumbers[orderNumber];
  if (knownId && state.orders[knownId]) {
    const known = state.orders[knownId];
    return {
      status: 200,
      body: aerr(1, 'Номер заказа уже зарегистрирован', {
        field: 'orderNumber',
        hint: `Повтор orderNumber — ошибка, а не идемпотентный replay: заказ «${orderNumber}» уже зарегистрирован (orderId ${known.orderId}, orderStatus ${known.status}). Возьмите новый номер, а состояние прежнего заказа сверьте через getOrderStatusExtended.do.`,
      }),
    };
  }

  /* -- amount: минимальные единицы валюты (копейки), строгий parser (F-24) -- */
  const amountCheck = core.parseMoneyKopeks(body.amount, { field: 'amount' });
  if (!amountCheck.ok) {
    return {
      status: 200,
      body: aerr(5, amountCheck.message, {
        field: 'amount',
        hint: 'amount — целое число копеек больше нуля (100.00 ₽ = 10000). Дроби, знаки и мусор не принимаются: 1000.9 или «1000xyz» — ошибка.',
      }),
    };
  }

  /* -- returnUrl обязателен; failUrl опционален -- */
  if (!validHttpUrl(body.returnUrl)) {
    return {
      status: 200,
      body: aerr(5, 'returnUrl отсутствует или некорректен', {
        field: 'returnUrl',
        hint: `returnUrl — обязательный http(s)-URL (≤${RETURN_URL_MAX} символов), куда браузер покупателя вернётся после оплаты. Итог сверяйте серверно: getOrderStatusExtended.do или callback.`,
      }),
    };
  }
  const failUrlRaw = body.failUrl === undefined || body.failUrl === null ? '' : String(body.failUrl).trim();
  if (failUrlRaw && !validHttpUrl(failUrlRaw)) {
    return {
      status: 200,
      body: aerr(5, 'failUrl некорректен', {
        field: 'failUrl',
        hint: `failUrl — необязательный http(s)-URL (≤${RETURN_URL_MAX} символов) для редиректа при отказе; без него мок редиректит на returnUrl.`,
      }),
    };
  }

  /* -- currency: только RUB (643) -- */
  const currencyRaw = body.currency === undefined || body.currency === null ? '' : String(body.currency).trim();
  if (currencyRaw && currencyRaw !== '643' && currencyRaw.toUpperCase() !== 'RUB') {
    return {
      status: 200,
      body: aerr(5, `Валюта ${currencyRaw} не поддерживается стендом`, {
        field: 'currency',
        hint: 'Мок работает в RUB: currency=643 (числовой код ISO-4217) либо не передавайте валюту вовсе.',
      }),
    };
  }

  /* -- sessionTimeoutSecs: срок жизни заказа/платёжной сессии -- */
  let sessionTimeoutSecs = SESSION_TIMEOUT_SECS;
  const timeoutRaw = body.sessionTimeoutSecs === undefined || body.sessionTimeoutSecs === null ? '' : String(body.sessionTimeoutSecs).trim();
  if (timeoutRaw) {
    const parsed = Number(timeoutRaw);
    if (!/^\d+$/.test(timeoutRaw) || !Number.isSafeInteger(parsed) || parsed < 1) {
      return {
        status: 200,
        body: aerr(5, `sessionTimeoutSecs некорректен: ${timeoutRaw}`, {
          field: 'sessionTimeoutSecs',
          hint: 'sessionTimeoutSecs — целое положительное число секунд (дефолт стенда 1200 = 20 минут). По истечении заказ отклоняется: orderStatus=6 и callback declinedByTimeout.',
        }),
      };
    }
    sessionTimeoutSecs = parsed;
  }

  /* -- jsonParams: JSON-объект; mock-расширение callback_url -- */
  let callbackUrl = '';
  const jsonParamsRaw = body.jsonParams === undefined || body.jsonParams === null ? '' : String(body.jsonParams).trim();
  if (jsonParamsRaw) {
    let jsonParams;
    try {
      jsonParams = JSON.parse(jsonParamsRaw);
    } catch {
      return {
        status: 200,
        body: aerr(5, 'jsonParams не является валидным JSON', {
          field: 'jsonParams',
          hint: 'jsonParams — строка с JSON-объектом, например {"callback_url":"https://shop.test/alfa/callback"}. callback_url — mock-расширение: приёмник GET-callback для этого заказа.',
        }),
      };
    }
    if (!jsonParams || typeof jsonParams !== 'object' || Array.isArray(jsonParams)) {
      return {
        status: 200,
        body: aerr(5, 'jsonParams должен быть JSON-объектом', { field: 'jsonParams' }),
      };
    }
    if (jsonParams.callback_url !== undefined && jsonParams.callback_url !== null) {
      if (!validHttpUrl(jsonParams.callback_url)) {
        return {
          status: 200,
          body: aerr(5, 'jsonParams.callback_url некорректен', {
            field: 'jsonParams',
            hint: 'callback_url (mock-расширение) — http(s)-URL приёмника GET-callback, например https://shop.test/alfa/callback.',
          }),
        };
      }
      callbackUrl = String(jsonParams.callback_url).trim();
    }
  }

  const orderId = crypto.randomUUID();
  const nowMs = clock.now();
  const base = String(PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const sandboxSelector = sandboxRuntime.currentId() === 'default' ? '' : `?sandbox=${encodeURIComponent(sandboxRuntime.currentId())}`;
  const order = {
    orderId,
    orderNumber,
    twoStage,
    status: 0,
    amountK: amountCheck.value,
    currency: 643,
    authorizedK: null,
    depositedK: 0,
    refundedK: 0,
    actionCode: null,
    actionCodeDescription: null,
    createdAt: clock.iso(),
    createdAtMs: nowMs,
    sessionTimeoutSecs,
    expiresAtMs: nowMs + sessionTimeoutSecs * 1000,
    returnUrl: String(body.returnUrl).trim(),
    failUrl: failUrlRaw || null,
    description: body.description === undefined || body.description === null ? null : String(body.description),
    clientId: body.clientId === undefined || body.clientId === null ? null : String(body.clientId),
    email: body.email === undefined || body.email === null ? null : String(body.email),
    phone: body.phone === undefined || body.phone === null ? null : String(body.phone),
    callbackUrl,
    maskPan: null,
    cardAuthCode: null,
    tdsApplied: false,
    authDate: null,
    depositDate: null,
    reverseDate: null,
    refundDate: null,
    declinedAt: null,
    pending3ds: null,
  };

  state.orders[orderId] = order;
  state.orderNumbers[orderNumber] = orderId;
  persist();
  log(`заказ зарегистрирован: ${orderId} orderNumber=${orderNumber} amount=${order.amountK} коп. scheme=${twoStage ? 'two-stage (холд)' : 'one-stage'} timeout=${sessionTimeoutSecs}s`);
  return {
    status: 200,
    body: okBody({
      orderId,
      formUrl: `${base}/payment/${orderId}${sandboxSelector}`,
      // DX-слой (не протокол): ключевая ловушка контракта — errorCode=0 не
      // доказывает оплату (docs/reference/alfa/01-payment-api.md).
      hint: 'errorCode=0 — результат обработки API-вызова, не эквивалент финального статуса оплаты: перенаправьте покупателя на formUrl, а итог сверяйте через getOrderStatusExtended.do (или callback).',
    }),
  };
}

/* ------------------------------------------------------- deposit/reverse/refund */

function handleDeposit(body, spec) {
  const found = resolveOrder(body);
  if (found.errorBody) return { status: 200, body: found.errorBody };
  const order = found.order;
  if (order.status !== 1) {
    const hints = {
      0: 'Заказ ещё не оплачен: deposit завершает холд (orderStatus=1), который появляется после успешной авторизации на платёжной странице.',
      2: 'Холд уже завершён (orderStatus=2): повторный deposit не допускается. Для возврата списанного — refund.do.',
      3: 'Авторизация отменена (reverse, orderStatus=3): списывать нечего.',
      4: 'По заказу проведён возврат (orderStatus=4): deposit не допускается.',
      5: 'Идёт аутентификация в ACS (orderStatus=5): дождитесь её завершения и сверьте статус через getOrderStatusExtended.do.',
      6: 'Авторизация отклонена (orderStatus=6): холда нет. Зарегистрируйте новый заказ с другим orderNumber.',
    };
    return {
      status: 200,
      body: aerr(4, `Состояние заказа некорректно для deposit (orderStatus=${order.status})`, {
        field: 'orderId',
        hint: order.twoStage
          ? (hints[order.status] || 'deposit доступен только из orderStatus=1 (холд).')
          : 'Заказ создан через register.do (одностадийная схема): списание происходит при оплате, deposit.do не применяется. Холд — registerPreAuth.do.',
      }),
    };
  }
  const amountCheck = core.parseMoneyKopeks(body.amount, { field: 'amount' });
  if (!amountCheck.ok) {
    return {
      status: 200,
      body: aerr(5, amountCheck.message, {
        field: 'amount',
        hint: 'amount для deposit — целое число копеек больше нуля, не превышающее авторизованную сумму.',
      }),
    };
  }
  if (amountCheck.value > order.authorizedK) {
    return {
      status: 200,
      body: aerr(5, `Сумма подтверждения ${amountCheck.value} коп. превышает сумму авторизации ${order.authorizedK} коп.`, {
        field: 'amount',
        hint: 'deposit — в пределах авторизованной суммы; частичное подтверждение допустимо (остаток холда освобождается покупателю).',
      }),
    };
  }
  completeDeposit(order, amountCheck.value, { spec });
  return { status: 200, body: okBody() };
}

function handleReverse(body, spec) {
  const found = resolveOrder(body);
  if (found.errorBody) return { status: 200, body: found.errorBody };
  const order = found.order;
  if (order.status !== 1 && order.status !== 2) {
    const hints = {
      0: 'Заказ не оплачен (orderStatus=0): отменять нечего — не оплачивайте форму либо дождитесь declinedByTimeout.',
      3: 'Авторизация уже отменена (reverse, orderStatus=3): повторный reverse не допускается.',
      4: 'По заказу проведён возврат (orderStatus=4): после расчётов используйте refund.do, а не reverse.',
      5: 'Идёт аутентификация в ACS (orderStatus=5): дождитесь завершения и сверьте статус.',
      6: 'Авторизация отклонена (orderStatus=6): списания не было, отменять нечего.',
    };
    return {
      status: 200,
      body: aerr(4, `Состояние заказа некорректно для reverse (orderStatus=${order.status})`, {
        field: 'orderId',
        hint: hints[order.status] || 'reverse снимает холд (orderStatus=1) либо отменяет оплату до окончательного расчёта (orderStatus=2).',
      }),
    };
  }
  applyReverse(order, { spec });
  return { status: 200, body: okBody() };
}

function handleRefund(body, spec) {
  const found = resolveOrder(body);
  if (found.errorBody) return { status: 200, body: found.errorBody };
  const order = found.order;
  if (order.status !== 2 && order.status !== 4) {
    const hints = {
      0: 'Заказ не оплачен (orderStatus=0): возвращать нечего.',
      1: 'Средства захолдированы, но не списаны (orderStatus=1): сначала завершите холд (deposit.do), а для отмены холда используйте reverse.do.',
      3: 'Авторизация отменена (reverse, orderStatus=3): средства не списаны, возврат не применяется.',
      5: 'Идёт аутентификация в ACS (orderStatus=5): дождитесь завершения.',
      6: 'Авторизация отклонена (orderStatus=6): средства не списаны.',
    };
    return {
      status: 200,
      body: aerr(4, `Состояние заказа некорректно для refund (orderStatus=${order.status})`, {
        field: 'orderId',
        hint: hints[order.status] || 'refund возвращает уже списанные средства (orderStatus=2 или 4).',
      }),
    };
  }
  const amountCheck = core.parseMoneyKopeks(body.amount, { field: 'amount' });
  if (!amountCheck.ok) {
    return {
      status: 200,
      body: aerr(5, amountCheck.message, {
        field: 'amount',
        hint: 'amount для refund — целое число копеек больше нуля, не превышающее остаток списанного.',
      }),
    };
  }
  const remaining = (order.depositedK || 0) - (order.refundedK || 0);
  if (amountCheck.value > remaining) {
    return {
      status: 200,
      body: aerr(5, `Сумма возврата ${amountCheck.value} коп. превышает списанную: доступно ${remaining} коп.`, {
        field: 'amount',
        hint: 'refund — полный или частичный в пределах списанной суммы (depositedAmount минус refundedAmount из getOrderStatusExtended.do).',
      }),
    };
  }
  if (!PARTIAL_REFUND && amountCheck.value < remaining) {
    return {
      status: 200,
      body: aerr(5, 'Частичный возврат не разрешён в этом контуре', {
        field: 'amount',
        hint: `Доступно только полное возмещение (${remaining} коп.): частичные возвраты включаются банком в разрешённом контуре. На стенде флаг — MOCK_PARTIAL_REFUND (по умолчанию частичные разрешены).`,
      }),
    };
  }
  applyRefund(order, amountCheck.value, { spec });
  return { status: 200, body: okBody() };
}

/* ------------------------------------------------------- платёжная страница */

/**
 * PG-08/MS-16: HTML отдаётся с security-заголовками (XFO/CSP/Referrer-Policy/
 * nosniff + no-store): страница оплаты содержит формы, а `form-action 'self'`
 * закрывает подмену назначения отправки. Набор — тот же, что у `/admin`;
 * `Cache-Control: no-store, private` — чтобы карточные формы не залипали в
 * кэше посредника. Политика не задаёт default-src: inline-стили страниц
 * остаются рабочими.
 */
const PAGE_SECURITY_HEADERS = {
  'Cache-Control': 'no-store, private',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
};

function sendPage(res, body, code = 200) {
  return send(res, code, body, { 'Content-Type': 'text/html; charset=utf-8', ...PAGE_SECURITY_HEADERS });
}

function page(body) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Альфа-Эквайринг · Тестовая платёжная форма (мок)</title>
<style>
  body{font:16px/1.5 -apple-system,'Segoe UI',Roboto,sans-serif;background:#f4f4f6;margin:0;display:flex;justify-content:center;padding:32px 12px}
  .card{background:#fff;border-radius:16px;max-width:430px;width:100%;padding:24px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
  .logo{font-weight:800;color:#fff;background:#ef3124;display:inline-block;border-radius:8px;padding:2px 10px;margin-bottom:8px}
  h1{font-size:20px;margin:0 0 4px}
  .muted{color:#777;font-size:13px;margin-bottom:16px}
  .sum{font-size:28px;font-weight:700;margin-bottom:16px}
  label{display:block;font-size:13px;color:#555;margin:10px 0 4px}
  input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ddd;border-radius:10px;font-size:16px}
  .cards{display:flex;flex-direction:column;gap:5px;margin-bottom:8px;max-height:220px;overflow:auto;border:1px dashed #eee;border-radius:10px;padding:8px}
  .cards label{display:flex;gap:8px;align-items:center;font-size:12px;color:#333;margin:0;cursor:pointer}
  button{width:100%;margin-top:14px;padding:13px;border:0;border-radius:12px;background:#ef3124;color:#fff;font-weight:700;font-size:16px;cursor:pointer}
  button.gray{background:#ececee;color:#333}
  .err{color:#c0392b;font-size:14px;margin-top:10px}
  .ok{color:#1e8e3e;font-size:14px;margin-top:10px}
</style></head><body><div class="card">${body}</div></body></html>`;
}

const esc = (v) => escapeHtml(v);
const rub = (kopecks) => `${(kopecks / 100).toFixed(2).replace('.', ',')} ₽`;

/**
 * Селектор песочницы для action'ов платёжной формы: покупатель открывает
 * formUrl с ?sandbox=<id>, и POST формы обязан сохранить контекст песочницы
 * (иначе заказ «потеряется» в default-состоянии).
 */
function sandboxSuffix() {
  const id = sandboxRuntime.currentId();
  return id === 'default' ? '' : `?sandbox=${encodeURIComponent(id)}`;
}

function formPage(order, errorMsg) {
  const cardOptions = Object.entries(CARDS)
    .map(([pan, c]) => `<label><input type="radio" name="preset" value="${pan}" onchange="document.getElementById('pan').value='${pan}';document.getElementById('exp').value='${c.exp}';document.getElementById('cvv').value='${c.cvv}'"> ${esc(c.label)} <code>${pan.slice(0, 6)}**${pan.slice(-4)}</code></label>`)
    .join('');
  return page(`
    <span class="logo">А · мок банка</span>
    <h1>Оплата заказа</h1>
    <div class="muted">Тестовый стенд Альфа-Эквайринга · заказ <code>${esc(order.orderNumber)}</code> · mdOrder <code>${esc(order.orderId)}</code></div>
    <div class="sum">${esc(rub(order.amountK))}</div>
    ${order.description ? `<div class="muted">${esc(order.description)}</div>` : ''}
    <div class="muted">${order.twoStage ? 'Двухстадийная схема: после оплаты сумма будет захолдирована (deposit.do).' : 'Одностадийная схема: оплата списывается сразу.'} Осталось: ${Math.max(0, Math.round((order.expiresAtMs - clock.now()) / 1000))} с (sessionTimeoutSecs=${order.sessionTimeoutSecs}).</div>
    ${errorMsg ? `<div class="err">${esc(errorMsg)}</div>` : ''}
    <form method="POST" action="/payment/${order.orderId}/pay${sandboxSuffix()}">
      <div class="cards">${cardOptions}</div>
      <label>Владелец карты (минимум два слова латиницей)</label><input type="text" id="holder" name="cardholder" value="IVAN IVANOV" required>
      <label>Номер карты</label><input type="text" id="pan" name="pan" value="4111111111111111" required>
      <label>Срок (MMYY)</label><input type="text" id="exp" name="exp" value="1234" required>
      <label>CVV</label><input type="password" id="cvv" name="cvv" value="123" required>
      <button type="submit">Оплатить ${esc(rub(order.amountK))}</button>
    </form>
    <div class="muted">Платежи проводятся только по тестовым картам из списка (docs/reference/alfa/03-test-contour.md). ACS-пароль <b>12345678</b>. Форма — мок: данные карт не покидают стенд и не хранятся (только маска first6**last4).</div>`);
}

function acsPage(order, errorMsg) {
  const pending = order.pending3ds || {};
  return page(`
    <span class="logo">А · мок банка</span>
    <h1>Подтверждение 3-D Secure</h1>
    <div class="muted">Тестовый ACS · заказ <code>${esc(order.orderNumber)}</code> · карта <code>${esc(pending.maskPan || '')}</code> · ${esc(pending.tds === '3ds1' ? '3DS 1.0' : '3DS 2.0 (challenge)')}</div>
    <div class="muted">Пароль тестового ACS: <b>12345678</b>. Для проверки отказа выберите Fail — шлюзовой код 71015 («введённая информация неверна»).</div>
    ${errorMsg ? `<div class="err">${esc(errorMsg)}</div>` : ''}
    <form method="POST" action="/payment/${order.orderId}/3ds${sandboxSuffix()}">
      <label>Пароль ACS</label><input type="password" id="password" name="password" value="" required>
      <button type="submit">Подтвердить</button>
    </form>
    <form method="POST" action="/payment/${order.orderId}/3ds${sandboxSuffix()}">
      <input type="hidden" name="action" value="fail">
      <button type="submit" class="gray">Fail (эмуляция отказа ACS)</button>
    </form>`);
}

function statusPage(order, message) {
  const amounts = [];
  if (order.authorizedK) amounts.push(`авторизовано ${rub(order.authorizedK)}`);
  if (order.depositedK) amounts.push(`списано ${rub(order.depositedK)}`);
  if (order.refundedK) amounts.push(`возвращено ${rub(order.refundedK)}`);
  return page(`
    <span class="logo">А · мок банка</span>
    <h1>${order.status === 2 ? 'Оплата проведена' : order.status === 1 ? 'Сумма захолдирована' : order.status === 6 ? 'Оплата отклонена' : order.status === 3 ? 'Авторизация отменена' : order.status === 4 ? 'Проведён возврат' : 'Заказ не оплачен'}</h1>
    <div class="muted">Заказ <code>${esc(order.orderNumber)}</code> · mdOrder <code>${esc(order.orderId)}</code></div>
    <div class="sum">${esc(rub(order.amountK))}</div>
    <div class="muted">orderStatus=<b>${order.status}</b> (${esc(ORDER_STATUSES[order.status] || '')})${order.actionCode !== null && order.actionCode !== undefined ? ` · actionCode=<b>${esc(String(order.actionCode))}</b> (${esc(order.actionCodeDescription || '')})` : ''}${amounts.length ? ` · ${esc(amounts.join(', '))}` : ''}</div>
    ${message ? `<div class="err">${esc(message)}</div>` : ''}
    <div class="muted">Вернитесь в магазин: итог сверяйте серверно через POST /payment/rest/getOrderStatusExtended.do (errorCode=0 не доказывает оплату).</div>`);
}

/* ------------------------------------------------------- логика формы */

/**
 * Обработка введённых данных карты. Форматные ошибки (не цифры, кривой срок,
 * один латинский word в держателе) возвращаются как ошибка формы — заказ
 * остаётся неоплаченным; неверные срок/CVV на известной карте, Fail/неверный
 * пароль ACS и отказы тестовых карт финализируют заказ с actionCode шлюза.
 */
function processCardPay(order, body, spec) {
  const pan = String(body.pan || '').replace(/[\s-]/g, '');
  const exp = String(body.exp || '').trim();
  const cvv = String(body.cvv || '').trim();
  const holder = String(body.cardholder || '').trim();

  if (!/^\d{13,19}$/.test(pan)) return { stage: 'form', error: 'Номер карты: 13–19 цифр' };
  if (!/^[A-Za-z]{2,}(\s+[A-Za-z]{2,})+$/.test(holder)) {
    return { stage: 'form', error: 'Владелец карты — минимум два слова латиницей (требование тестового контура)' };
  }
  const expMatch = exp.match(/^(\d{2})(\d{2})$/);
  if (!expMatch) return { stage: 'form', error: 'Срок действия — 4 цифры (MMYY), например 1234' };
  const month = parseInt(expMatch[1], 10);
  if (!(month >= 1 && month <= 12)) return { stage: 'form', error: 'Неверный месяц срока действия' };
  if (!/^\d{3}$/.test(cvv)) return { stage: 'form', error: 'CVV — ровно 3 цифры' };
  const nowDate = new Date(clock.now());
  const expiryDate = new Date(2000 + parseInt(expMatch[2], 10), month, 1);
  if (expiryDate <= nowDate) {
    // Просроченная карта — «введённая информация неверна» (код 71015).
    return declineNow(order, ACTION_CODE_INVALID_INFO, 'Карта просрочена (введённая информация неверна)', pan, { spec });
  }

  const card = CARDS[pan];
  const maskPan = `${pan.slice(0, 6)}**${pan.slice(-4)}`;

  if (card) {
    // Известная тестовая карта: срок/CVV обязаны совпадать с таблицей —
    // иначе отказ 71015 (docs/reference/alfa/03-test-contour.md).
    if (exp !== card.exp || cvv !== card.cvv) {
      return declineNow(order, ACTION_CODE_INVALID_INFO, 'Введённая информация неверна (срок/CVV не совпадают с тестовой картой)', pan, { spec });
    }
    if (card.tds === 'ssl') {
      // Карта без 3DS: успех только при включённом SSL-разрешении мерчанта.
      if (SSL_PERMITTED) return finishNow(order, 'success', pan, { tds: false, spec });
      return declineNow(order, ACTION_CODE_DO_NOT_HONOR, 'Операция без 3DS отклонена: SSL-разрешение мерчанта не включено', pan, { spec });
    }
    if (card.tds === '3ds1' || card.tds === '3ds2-challenge') {
      // Отложить финализацию до POST /payment/{orderId}/3ds (challenge/ACS).
      order.status = 5;
      order.actionCode = null;
      order.actionCodeDescription = null;
      order.pending3ds = {
        maskPan,
        tds: card.tds,
        outcome: card.outcome,
        actionCode: card.actionCode === undefined ? null : card.actionCode,
        actionText: card.actionText || null,
      };
      persist();
      return { stage: '3ds' };
    }
    // 3ds2-frictionless — без подтверждения плательщика.
    if (card.outcome === 'success') return finishNow(order, 'success', pan, { tds: true, spec });
    return declineNow(order, card.actionCode, card.actionText, pan, { tds: true, spec });
  }

  if (!luhnValid(pan)) {
    return declineNow(order, ACTION_CODE_INVALID_INFO, 'Номер карты не проходит контрольную сумму (введённая информация неверна)', pan, { spec });
  }
  // Валидный, но не тестовый PAN: честный отказ эмитента.
  return declineNow(order, ACTION_CODE_DO_NOT_HONOR, 'Отклонено эмитентом: мок проводит оплату только по тестовым картам из списка', pan, { spec });
}

/** Отказ сразу (без ACS): маска PAN сохраняется, полный PAN — нет (F-10). */
function declineNow(order, actionCode, description, pan, { spec = null, tds = false } = {}) {
  void tds;
  finalizeDecline(order, actionCode, description, { maskPan: `${pan.slice(0, 6)}**${pan.slice(-4)}`, spec });
  return { stage: 'done', redirect: order.failUrl || order.returnUrl };
}

function finishNow(order, outcome, pan, { tds, spec = null } = {}) {
  void outcome;
  finalizeSuccess(order, { maskPan: `${pan.slice(0, 6)}**${pan.slice(-4)}`, tds, spec });
  return { stage: 'done', redirect: order.returnUrl };
}

/**
 * POST /payment/{orderId}/3ds: пароль тестового ACS 12345678 проводит
 * сценарий карты; Fail или неверный пароль — отказ 71015.
 */
function process3ds(order, body, spec) {
  const pending = order.pending3ds;
  if (!pending) return { stage: 'form', error: 'Сессия 3DS не найдена' };
  const action = String(body.action || '').trim();
  const password = String(body.password || '').trim();
  if (action === 'fail') {
    return declinePending(order, pending, ACTION_CODE_INVALID_INFO, 'Тестовый ACS: выбран Fail (введённая информация неверна)', spec);
  }
  if (password !== ACS_PASSWORD) {
    return declinePending(order, pending, ACTION_CODE_INVALID_INFO, 'Пароль ACS неверен (тестовый пароль 12345678)', spec);
  }
  if (pending.outcome === 'success') {
    finalizeSuccess(order, { maskPan: pending.maskPan, tds: true, spec });
    return { stage: 'done', redirect: order.returnUrl };
  }
  return declinePending(order, pending, pending.actionCode, pending.actionText, spec);
}

function declinePending(order, pending, actionCode, description, spec = null) {
  finalizeDecline(order, actionCode, description, { maskPan: pending.maskPan, spec });
  return { stage: 'done', redirect: order.failUrl || order.returnUrl };
}

/* ------------------------------------------------- scenario resolution */

/** Сценарий запроса: заголовок X-Mock-Scenario + правила /mock/scenarios. */
function resolveRequestSpec(target, req, body, context = {}) {
  const header = (req && req.headers && req.headers['x-mock-scenario']) || '';
  return scenarios.resolve({
    header,
    bodyScenario: body && typeof body.mock_scenario === 'string' ? body.mock_scenario : '',
    target,
    context,
  });
}

/* ----------------------------------------------------------- sandbox API */

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

/**
 * Креды песочницы (RFC-001 §4): свои userName/password и секрет checksum —
 * арендатор проходит тот же путь, что в бою («впиши реквизиты кабинета»).
 */
function generateSandboxCreds() {
  return {
    userName: `ALFASBX${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
    password: core.randomToken(24),
    callbackSecret: core.randomToken(24),
  };
}

function handleSandboxApi(req, res, url, body, admission) {
  const operator = sandboxRuntime.isOperatorRequest(req);
  if (req.method === 'GET') {
    if (TENANCY === 'owned' && !operator) {
      const own = sandboxRuntime.recordByOwnerToken(req);
      if (!own) {
        return jsonRaw(res, 401, aerrBody(2, 'Список песочниц доступен владельцу (owner-token) или оператору', {
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
          creds: generateSandboxCreds(),
          profile: 'alfa-eacq',
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
          hint: 'Сохраните ownerToken: он показывается один раз и даёт доступ к песочнице. creds.callbackSecret — секрет симметричного checksum (HMAC-SHA256) для проверки GET-callback.',
        }, 201);
      } catch (e) {
        if (core.sendSandboxStateQuotaError(res, e)) return;
        const status = e.code === 'SANDBOX_EXISTS' ? 409 : 429;
        return jsonRaw(res, status, aerrBody(5, e.message, {
          hint: 'Ограничения: MOCK_SANDBOX_MAX (количество), MOCK_SANDBOX_CREATE_LIMIT (созданий в час на IP).',
        }));
      }
    }
    const result = sandboxRuntime.switchActive((body && body.sandbox) || 'default');
    if (!result.ok) return jsonRaw(res, 400, aerrBody(5, `Не удалось выбрать песочницу: ${result.error}`));
    return sendJson(res, { ok: true, current: result.current, sandboxes: sandboxRuntime.list() });
  }
  if (req.method === 'DELETE') {
    const target = String((body && body.sandbox) || url.searchParams.get('sandbox') || '');
    if (!target) return jsonRaw(res, 400, aerrBody(3, 'Укажите песочницу для удаления: ?sandbox=<id> или {"sandbox":"<id>"}'));
    const record = sandboxRuntime.find(target);
    if (!record) return jsonRaw(res, 404, aerrBody(3, `Песочница «${target}» не найдена`));
    if (TENANCY === 'owned' && !operator && !sandboxRuntime.recordAuthorized(record, req)) {
      return jsonRaw(res, 401, aerrBody(2, `Удалить песочницу «${target}» может её владелец (owner-token) или оператор`));
    }
    const result = sandboxRuntime.remove(target, req);
    if (!result.ok) {
      if (result.error === 'unauthorized') {
        return jsonRaw(res, 401, aerrBody(2, `Удалить песочницу «${target}» может её владелец (owner-token) или оператор`));
      }
      return jsonRaw(res, 400, aerrBody(5, `Песочницу «${target}» удалить нельзя (default-стенд)`));
    }
    return sendJson(res, { ok: true, removed: result.removed });
  }
  return jsonRaw(res, 405, aerrBody(6, `Метод ${req.method} для /sandboxes не поддерживается`));
}

/** RFC-001 §6: /sandboxes/me — своя песочница по owner-token. */
function handleSandboxMe(req, res, p, body) {
  const record = sandboxRuntime.recordByOwnerToken(req) || (TENANCY === 'owned' ? null : sandboxRuntime.current());
  if (!record) {
    return jsonRaw(res, 401, aerrBody(2, 'Требуется owner-token песочницы', {
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
    // Смена кредов: owner-token не меняется, иначе арендатор потеряет доступ.
    const creds = generateSandboxCreds();
    sandboxRuntime.updateCreds(record.id, creds, req);
    return sendJson(res, { ok: true, sandbox: record.id, creds, ownerTokenChanged: false });
  }
  if (p === '/sandboxes/me' && req.method === 'DELETE') {
    const result = sandboxRuntime.remove(record.id, req);
    if (!result.ok) return jsonRaw(res, 400, aerrBody(5, 'default-песочницу стенда удалить нельзя'));
    return sendJson(res, { ok: true, removed: result.removed });
  }
  return jsonRaw(res, 405, aerrBody(6, `Метод ${req.method} для ${p} не поддерживается`));
}

/** Политика admission по маршруту (F-11/F-12, PA-54): неописанный маршрут — fail-closed 'business'. */
function alfaSandboxPolicy(p) {
  if (p === '/health' || p === '/openapi.json' || p === '/sandboxes' || p.startsWith('/sandboxes/')) return 'public';
  if (p.startsWith('/admin') || p.startsWith('/mock/')) return 'control';
  if (p.startsWith('/payment/rest/')) return 'business';
  if (p.startsWith('/payment/')) return 'form';
  return 'business';
}

/** DX-ответ на ошибку admission песочницы (F-12): знание ID ≠ доступ. */
function sendSandboxError(res, admission) {
  const id = admission.sandbox || 'default';
  if (admission.kind === 'not-found') {
    return jsonRaw(res, 404, aerrBody(3, `Песочница «${id}» не найдена`, {
      hint: 'Создайте песочницу: POST /sandboxes — в ответе будут id, creds (userName/password/callbackSecret) и ownerToken. Список — GET /mock/sandboxes.',
    }));
  }
  if (admission.kind === 'unauthorized') {
    return jsonRaw(res, 401, aerrBody(2, `Доступ к песочнице «${id}» ограничен: знание ID не является доступом`, {
      field: 'X-Sandbox-Token',
      hint: 'Передайте owner-token из ответа POST /sandboxes: Authorization: Bearer <ownerToken>, X-Sandbox-Token или cookie (mock_sandbox_token=...). В hosted-режиме query-токены запрещены.',
    }));
  }
  if (admission.kind === 'expired') {
    return jsonRaw(res, 410, aerrBody(3, `Песочница «${id}» истекла по TTL и удалена`, {
      hint: 'Песочницы живут ограниченное время; создайте новую: POST /sandboxes.',
    }));
  }
  if (admission.kind === 'rate-limit' || admission.kind === 'limit') {
    return jsonRaw(res, 429, aerrBody(5, 'Лимит создания песочниц исчерпан', {
      hint: 'Переиспользуйте существующий ID или поднимите MOCK_SANDBOX_CREATE_LIMIT / MOCK_SANDBOX_MAX.',
    }));
  }
  return jsonRaw(res, 500, aerrBody(6, 'Не удалось разрешить контекст песочницы'));
}

/* --------------------------------------------------------------- admin */

function controlSurface(p) {
  if (p.startsWith('/admin')) return 'admin';
  if (p.startsWith('/mock/')) return 'operator';
  return null;
}

function btn(action, id, label, csrfToken, actionUrl) {
  return `<form method="POST" action="${esc(actionUrl)}" style="display:inline"><input type="hidden" name="_csrf" value="${esc(csrfToken)}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="id" value="${esc(id)}"><button style="width:auto;margin:2px;padding:6px 10px;font-size:12px" type="submit">${esc(label)}</button></form>`;
}

function adminPage(req) {
  const currentSandbox = sandboxRuntime.currentId();
  const pageQuery = new URL(req.url, 'http://mock.local').searchParams;
  const adminQuery = new URLSearchParams();
  if (currentSandbox !== 'default') adminQuery.set('sandbox', currentSandbox);
      const adminSuffix = adminQuery.toString();
  const adminActionUrl = `/admin/action${adminSuffix ? `?${adminSuffix}` : ''}`;
  const adminJournalUrl = `/admin/journal${adminSuffix ? `?${adminSuffix}` : ''}`;
  const csrfToken = core.createCsrfToken(ADMIN_CSRF_SECRET, currentSandbox);

  const orders = Object.values(state.orders)
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, 50)
    .map((o) => {
      const actions = [];
      if (o.status === 1) {
        actions.push(btn('deposit-order', o.orderId, 'deposit (полный)', csrfToken, adminActionUrl));
        actions.push(btn('reverse-order', o.orderId, 'reverse', csrfToken, adminActionUrl));
      }
      if (o.status === 2) actions.push(btn('reverse-order', o.orderId, 'reverse', csrfToken, adminActionUrl));
      if (o.status === 0 || o.status === 5) actions.push(btn('expire-order', o.orderId, 'таймаут сейчас', csrfToken, adminActionUrl));
      const money = [];
      if (o.authorizedK) money.push(`автор. ${rub(o.authorizedK)}`);
      if (o.depositedK) money.push(`списано ${rub(o.depositedK)}`);
      if (o.refundedK) money.push(`возврат ${rub(o.refundedK)}`);
      const action = o.actionCode === null || o.actionCode === undefined
        ? '—'
        : `${esc(String(o.actionCode))} (${esc(o.actionCodeDescription || '')})`;
      return `<tr><td><code>${esc(o.orderId.slice(0, 8))}</code></td><td>${esc(o.orderNumber)}</td><td><b>${o.status}</b> ${esc(ORDER_STATUSES[o.status] || '')}</td><td>${esc(rub(o.amountK))}</td><td>${esc(money.join(' · ') || '—')}</td><td>${action}</td><td>${o.twoStage ? '2-stage' : '1-stage'}</td><td>${o.maskPan ? esc(o.maskPan) : '—'}</td><td>${actions.join(' ') || '—'}</td></tr>`;
    })
    .join('') || '<tr><td colspan="9">заказов нет</td></tr>';

  const callbacks = Object.values(state.callbacks)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .slice(-25)
    .reverse()
    .map((c) => {
      const st = c.suppressed ? 'suppressed' : c.dumped ? 'dumped' : c.done ? 'delivered' : `retry@${new Date(c.nextAttemptAt || clock.now()).toISOString().slice(11, 19)}`;
      return `<tr><td><code>${esc(c.id)}</code></td><td>${esc(c.operation)}</td><td><code>${esc(String(c.orderId).slice(0, 8))}</code></td><td>${c.callbackStatus}</td><td>${c.attempts}</td><td>${esc(st)}</td><td>${esc(c.lastStatus ?? '—')} ${esc(String(c.lastBody ?? '').slice(0, 40))}</td><td>${btn('duplicate-callback', c.id, 'повторить', csrfToken, adminActionUrl)}</td></tr>`;
    })
    .join('') || '<tr><td colspan="8">callback не отправлялись</td></tr>';

  const journalRows = journal.list().slice(-15).reverse()
    .map((e) => `<tr><td>${esc(String(e.at).slice(11, 19))}</td><td>${esc(e.method)}</td><td><code>${esc(e.path)}</code></td><td><code>${esc(Object.entries(e.body || {}).map(([k, v]) => `${k}=${v}`).join(' '))}</code></td><td>${e.status}</td><td>${e.ms} мс</td><td><code style="font-size:10px">${esc(String(e.curl || '').slice(0, 70))}…</code></td></tr>`)
    .join('') || '<tr><td colspan="7">запросов ещё не было</td></tr>';

  return page(`
    <span class="logo">А · мок</span>
    <h1 style="font-size:18px">Консоль стенда Альфа-Эквайринга</h1>
    <div class="muted">userName <code>${esc(alfaUserName())}</code> (синтетические креды мока) · two-stage ${TWO_STAGE ? 'включена' : 'ВЫКЛЮЧЕНА'} · partial refund ${PARTIAL_REFUND ? 'разрешён' : 'запрещён'} · SSL ${SSL_PERMITTED ? 'разрешён' : 'не разрешён'} · checksum ${CHECKSUM_ENABLED ? 'HMAC-SHA256' : 'ВЫКЛЮЧЕН'} · ретраи ${Math.round(CALLBACK_RETRY_MS / 1000)}с × ${CALLBACK_MAX_ATTEMPTS} · виртуальное время <code>${esc(clock.iso())}</code> · sandbox <code>${esc(currentSandbox)}</code></div>
    <div style="background:#fff8e1;border:1px solid #f0d47a;border-radius:10px;padding:8px 10px;margin-bottom:10px;font-size:13px">⚠ Оплата — <b>только по тестовым картам</b> со страницы заказа (пресеты есть на форме), ACS-пароль <b>12345678</b>. Креды и PAN в журнал не попадают. errorCode=0 ≠ финальный статус.</div>
    <div class="muted">POST /payment/rest/register.do|registerPreAuth.do|deposit.do|reverse.do|refund.do|getOrderStatus.do|getOrderStatusExtended.do · Негатив: X-Mock-Scenario: fail|hang|webhook-drop|webhook-duplicate|latency:2s|http-500|http-504</div>
    <h1 style="font-size:16px">Заказы (последние 50)</h1>
    <table border="0" cellpadding="4" style="font-size:13px;width:100%">${orders}</table>
    <h1 style="font-size:16px">Callback — GET (последние 25) · ACK ровно 200 · checksum симметричный HMAC-SHA256</h1>
    <table border="0" cellpadding="4" style="font-size:12px;width:100%">${callbacks}</table>
    <h1 style="font-size:16px">Журнал /payment/rest (последние 15) — <a href="${esc(adminJournalUrl)}">json</a></h1>
    <table border="0" cellpadding="4" style="font-size:12px;width:100%">${journalRows}</table>`);
}

function adminAction(body) {
  const { action, id } = body;
  if (action === 'deposit-order') {
    const order = findOrder(id);
    if (order && order.status === 1) completeDeposit(order, order.authorizedK);
  } else if (action === 'reverse-order') {
    const order = findOrder(id);
    if (order && (order.status === 1 || order.status === 2)) applyReverse(order);
  } else if (action === 'expire-order') {
    const order = findOrder(id);
    if (order && (order.status === 0 || order.status === 5)) declineByTimeout(order);
  } else if (action === 'duplicate-callback') {
    const c = state.callbacks[String(id)];
    if (c) {
      const copy = {
        ...c,
        id: String(state.counters.callbackId++),
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
      state.callbacks[copy.id] = copy;
      persist();
    }
  }
  return { redirect: '/admin' };
}

/* ------------------------------------------------------------------ http */

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

/**
 * curl-сниппет для form-urlencoded запроса (ядро строит сниппеты под JSON,
 * поэтому для *.do собираем свой). Тело редактирует core.redactRawBody:
 * userName/password в журнал не попадают (F-09).
 */
function buildFormCurl(req, p, raw) {
  const base = String(PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const parts = [`curl -sS -X POST ${shellQuote(`${base}${p}`)}`, `-H ${shellQuote('Content-Type: application/x-www-form-urlencoded')}`];
  const scenario = String((req.headers && req.headers['x-mock-scenario']) || '');
  if (scenario) parts.push(`-H ${shellQuote(`X-Mock-Scenario: ${core.redactSecretsInText(scenario)}`)}`);
  const sandbox = String((req.headers && req.headers['x-mock-sandbox']) || '');
  if (sandbox) parts.push(`-H ${shellQuote(`X-Mock-Sandbox: ${sandbox}`)}`);
  const safeRaw = core.redactRawBody(raw);
  if (safeRaw) parts.push(`--data ${shellQuote(safeRaw)}`);
  return parts.join(' ');
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const raw = await readBody(req);
  const body = parseBody(raw, req.headers['content-type']);

  // F-11/F-12: контекст песочницы резолвится один раз до бизнес-логики.
  const admission = sandboxRuntime.admit(req, alfaSandboxPolicy(p));
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
    if (p === '/admin/login' && req.method === 'POST') {
      return core.handleAdminLogin(req, res, typeof raw !== 'undefined' ? raw : undefined, parseBody, send);
    }
    const access = checkControlAccess(req, {
      adminToken: MOCK_ADMIN_TOKEN,
      operatorToken: OPERATOR_TOKEN,
      surface,
      hosted: HOSTED,
    });
    if (!access.allowed) {
      if (p === '/admin' && req.method === 'GET') {
        return core.html(res, core.adminLoginForm(req));
      }
      const envName = surface === 'admin' ? 'MOCK_ADMIN_TOKEN' : 'MOCK_OPERATOR_TOKEN';
      const message = access.reason === 'hosted-fail-closed'
        ? `Маршрут ${p} закрыт: hosted-режим (MOCK_HOSTED) требует ${envName} для управляющей поверхности`
        : `Доступ к управляющему маршруту ${p} ограничен: требуется ${envName}`;
      return jsonRaw(res, 401, aerrBody(2, message, {
        field: surface === 'admin' ? 'Authorization' : 'X-Operator-Token',
        hint: access.hint || `Передайте токен: Authorization: Bearer <${envName}> или X-Operator-Token/X-Admin-Token.`,
      }));
    }
  }

  const isRest = p.startsWith('/payment/rest/');

  // Журнал только REST-вызовов *.do (страницы формы и поллинг /admin не шумят;
  // PAN формы в журнал не попадают вовсе).
  if (isRest) {
    const started = Date.now();
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (code, ...rest) => {
      journal.record({
        method: req.method,
        path: p,
        status: code,
        ms: Date.now() - started,
        body: core.summarizeBody(body, { maxKeys: 8, maxValueLength: 60 }),
        rawBody: raw,
        headers: req.headers,
        baseUrl: PUBLIC_BASE_URL,
        curl: buildFormCurl(req, p, raw),
      });
      return originalWriteHead(code, ...rest);
    };

    // Сетевые сбои ядра: X-Mock-Latency / X-Mock-Scenario: latency, http-500, http-504.
    const chaosSpec = parseScenarioSpec(req.headers['x-mock-scenario'] || '');
    const chaosResult = await applyRequestChaos(req, chaosSpec);
    sandboxRuntime.current(); // PA-50 §7.2 / PG-10: fail-closed при истечении/удалении песочницы во время await
    if (chaosResult.abortStatus) {
      return jsonRaw(res, chaosResult.abortStatus, aerrBody(6, chaosResult.abortMessage, {
        hint: 'Сценарий X-Mock-Scenario: http-500|http-504 (сетевой сбой до бизнес-логики). Выдержите паузу и повторите; сверка состояния — getOrderStatusExtended.do.',
        doc: '',
      }));
    }
  }

  if (req.method === 'GET' && p === '/openapi.json') {
    const specFile = path.join(__dirname, '..', '..', 'docs', 'openapi', 'alfa-mock.openapi.json');
    return sendJson(res, JSON.parse(fs.readFileSync(specFile, 'utf8')));
  }

  if (req.method === 'GET' && p === '/health') {
    const health = {
      ok: true,
      sandbox: sandboxRuntime.currentId(),
      tenancy: TENANCY,
      api: 'rest',
      base: '/payment/rest',
      twoStage: TWO_STAGE,
      partialRefund: PARTIAL_REFUND,
      sslPermitted: SSL_PERMITTED,
      checksum: CHECKSUM_ENABLED ? 'HMAC-SHA256' : 'off',
      sessionTimeoutSecs: SESSION_TIMEOUT_SECS,
    };
    if (TENANCY !== 'owned' || (admission.record.isDefault && !admission.record.ownerTokenHash) || admission.via === 'owner' || admission.via === 'operator') {
      Object.assign(health, {
        orders: Object.keys(state.orders).length,
        awaiting: Object.values(state.orders).filter((o) => o.status === 0 || o.status === 5).length,
        callbacks: Object.keys(state.callbacks).length,
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
      if (resetName.error && resetName.error !== 'not-found') {
        return sendSandboxError(res, { ok: false, kind: resetName.error, sandbox: resetName.sandbox || target });
      }
      return jsonRaw(res, 404, aerrBody(3, `Песочница «${target}» не найдена`, {
        hint: 'Сбросить можно существующую песочницу: список — GET /sandboxes.',
      }));
    }
    clearSandboxChildState(sandboxRuntime.find(target));
    return sendJson(res, { ok: true, sandbox: resetName.sandbox || target, current: sandboxRuntime.currentId() });
  }

  if (p === '/mock/state') {
    if (req.method === 'GET') {
      const targetSandbox = url.searchParams.get('sandbox') || undefined;
      const snapshot = targetSandbox ? sandboxRuntime.exportState(targetSandbox, req) : sandboxRuntime.exportState(null, req);
      if (snapshot && snapshot.ok === false) {
        return sendSandboxError(res, { ok: false, kind: snapshot.error || 'unauthorized', sandbox: snapshot.sandbox || targetSandbox || admission.record.id });
      }
      return sendJson(res, { sandbox: snapshot.sandbox || admission.record.id, state: snapshot.state ? snapshot.state : snapshot });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      if (raw.trim() && String(req.headers['content-type'] || '').includes('application/json')) {
        try { JSON.parse(raw); } catch {
          return jsonRaw(res, 400, aerrBody(6, 'Снимок состояния не является валидным JSON', {
            field: 'state',
            hint: 'Передайте экспорт /mock/state без редактирования опасных ключей __proto__, constructor и prototype.',
          }));
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
        if (core.sendSandboxStateQuotaError(res, e)) return;
        return jsonRaw(res, 400, aerrBody(6, `Недопустимый снимок состояния: ${e.message}`, {
          field: 'state',
          hint: 'Исправьте снимок и повторите импорт; ключи __proto__, constructor и prototype запрещены.',
        }));
      }
    }
  }

  // Виртуальные часы: ускорение sessionTimeoutSecs (declinedByTimeout) и
  // ретраев callback без реального ожидания.
  if (p === '/mock/time') {
    if (req.method === 'GET') return sendJson(res, clock.snapshot());
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        const snap = clock.set(body || {});
        tickAlfa();
        await deliveryQueue.tick();
        return sendJson(res, snap);
      } catch (e) {
        if (core.sendSandboxStateQuotaError(res, e)) return;
        return jsonRaw(res, 400, aerrBody(6, e.message, { field: 'advance|offset|iso', hint: 'Поля: advance ("+30m"), offset (мс), iso (дата), reset (true).' }));
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
        const bodyErr = aerr(6, e.message, { field: 'scenario', hint: 'Поля: scenario (обязательно), target ("*", "register", "deposit", "pay"), match, times/persistent.' });
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

  /* ------------------------------------------------------ admin-консоль */

  if (req.method === 'GET' && p === '/admin') {
    return sendPage(res, adminPage(req));
  }

  if (req.method === 'POST' && p === '/admin/action') {
    if (!core.isSameOriginRequest(req)
        || !core.verifyCsrfToken(body && body._csrf, ADMIN_CSRF_SECRET, sandboxRuntime.currentId())) {
      return jsonRaw(res, 403, aerrBody(2, 'Запрос заблокирован: отсутствует или неверен CSRF-токен', {
        field: '_csrf',
        hint: 'Откройте /admin и отправьте действие из формы этой консоли.',
      }));
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

  /* ------------------------------------------- платёжная страница (formUrl) */

  const formMatch = p.match(/^\/payment\/([A-Za-z0-9-]+)$/);
  if (formMatch && req.method === 'GET') {
    const order = findOrder(decodeURIComponent(formMatch[1]));
    if (!order) return sendPage(res, page('<span class="logo">А · мок</span><h1>Заказ не найден</h1><div class="muted">Проверьте orderId в formUrl из ответа register.do.</div>'), 404);
    // Просрочка сессии до тика: отклоняем здесь же (declinedByTimeout).
    if ((order.status === 0 || order.status === 5) && order.expiresAtMs && clock.now() >= order.expiresAtMs) {
      declineByTimeout(order);
    }
    if (order.status === 0) return sendPage(res, formPage(order, null));
    if (order.status === 5) return sendPage(res, acsPage(order, null));
    return sendPage(res, statusPage(order, null));
  }

  const payMatch = p.match(/^\/payment\/([A-Za-z0-9-]+)\/pay$/);
  if (payMatch && req.method === 'POST') {
    const order = findOrder(decodeURIComponent(payMatch[1]));
    if (!order || order.status !== 0) return send(res, 404, 'Платёжная сессия не найдена или уже завершена');
    if (order.expiresAtMs && clock.now() >= order.expiresAtMs) {
      declineByTimeout(order);
      return sendPage(res, statusPage(order, 'Срок оплаты истёк (sessionTimeoutSecs) — заказ отклонён: declinedByTimeout.'));
    }
    const spec = resolveRequestSpec('pay', req, body, { orderId: order.orderId, orderNumber: order.orderNumber });
    if (spec.has('fail')) {
      finalizeDecline(order, ACTION_CODE_DO_NOT_HONOR, 'Отклонено эмитентом (смоделировано сценарием fail)', { spec });
      return send(res, 302, '', { Location: order.failUrl || order.returnUrl });
    }
    const result = processCardPay(order, body, spec);
    if (result.stage === 'form') return sendPage(res, formPage(order, result.error));
    if (result.stage === '3ds') return sendPage(res, acsPage(order, null));
    return send(res, 302, '', { Location: result.redirect });
  }

  const tdsMatch = p.match(/^\/payment\/([A-Za-z0-9-]+)\/3ds$/);
  if (tdsMatch && req.method === 'POST') {
    const order = findOrder(decodeURIComponent(tdsMatch[1]));
    if (!order || order.status !== 5) return send(res, 404, 'Сессия 3DS не найдена или уже завершена');
    if (order.expiresAtMs && clock.now() >= order.expiresAtMs) {
      declineByTimeout(order);
      return sendPage(res, statusPage(order, 'Срок оплаты истёк (sessionTimeoutSecs) — заказ отклонён: declinedByTimeout.'));
    }
    const spec = resolveRequestSpec('3ds', req, body, { orderId: order.orderId, orderNumber: order.orderNumber });
    const result = process3ds(order, body, spec);
    if (result.stage === 'form') return sendPage(res, acsPage(order, result.error));
    return send(res, 302, '', { Location: result.redirect });
  }

  /* ------------------------------------------------------ REST *.do */

  if (isRest) {
    return handleRest(req, res, p, body);
  }

  // Неизвестный маршрут — provider-shaped 404 (инфраструктурный сбой: код 6).
  return jsonRaw(res, 404, aerrBody(6, `Неизвестный маршрут: ${req.method} ${p}`, {
    hint: 'Реализованы: POST /payment/rest/{register,registerPreAuth,deposit,reverse,refund,getOrderStatus,getOrderStatusExtended}.do, платёжная страница /payment/{orderId}, /health, /openapi.json, /admin, /mock/*, /sandboxes*.',
    doc: '',
  }));
}

/** REST-методы шлюза (docs/reference/alfa/01-payment-api.md). */
const REST_METHODS = [
  'register.do',
  'registerPreAuth.do',
  'deposit.do',
  'reverse.do',
  'refund.do',
  'getOrderStatus.do',
  'getOrderStatusExtended.do',
];

/**
 * Маршрутизация /payment/rest/*.do: POST + form-urlencoded (толерантность
 * мока: JSON-тело тоже разбирается — см. README «Границы и форки»).
 * Очередность: метод -> креды -> сценарии fail/hang -> бизнес.
 * Протокольные ошибки — HTTP 200 + errorCode (как отвечает шлюз).
 */
async function handleRest(req, res, p, body) {
  const m = p.match(/^\/payment\/rest\/([A-Za-z]+)\.do$/);
  const methodName = m ? `${m[1]}.do` : null;
  if (!methodName || !REST_METHODS.includes(methodName)) {
    return jsonRaw(res, 404, aerrBody(6, `Неизвестный REST-метод: ${p}`, {
      hint: `Методы шлюза: ${REST_METHODS.join(', ')}. Все вызываются POST с form-параметрами (userName, password, …).`,
      doc: '',
    }));
  }
  if (req.method !== 'POST') {
    return send(res, 405, aerrBody(6, `Метод ${req.method} не поддерживается маршрутом ${p}`, {
      hint: 'REST-вызовы шлюза — только POST (application/x-www-form-urlencoded).',
    }), { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST' });
  }

  const credErr = verifyCreds(body);
  if (credErr) return jsonRaw(res, 200, credErr);

  const target = methodName.replace(/\.do$/, '').toLowerCase();
  const spec = resolveRequestSpec(target, req, body, {
    orderNumber: String(body.orderNumber === undefined || body.orderNumber === null ? '' : body.orderNumber),
    path: p,
  });

  // hang: запрос не должен получить ответа (клиент ждёт/таймаутит).
  if (spec.has('hang')) {
    await new Promise(() => {});
    return;
  }
  // fail: системная ошибка шлюза (бизнес не выполняется).
  if (spec.has('fail')) {
    return jsonRaw(res, 200, aerrBody(6, 'Системная ошибка (смоделирована сценарием fail)', {
      hint: 'Сценарий fail: мок сымитировал системную ошибку шлюза. Выдержите паузу и повторите; заказ при этом не создаётся/не меняется — сверка через getOrderStatusExtended.do.',
      doc: '',
    }));
  }

  let outcome;
  switch (methodName) {
    case 'register.do':
      outcome = handleRegister(body, spec, false);
      break;
    case 'registerPreAuth.do':
      outcome = handleRegister(body, spec, true);
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
    case 'getOrderStatus.do':
    case 'getOrderStatusExtended.do': {
      const found = resolveOrder(body);
      if (found.errorBody) {
        outcome = { status: 200, body: found.errorBody };
        break;
      }
      outcome = { status: 200, body: statusView(found.order, methodName === 'getOrderStatusExtended.do') };
      break;
    }
    default:
      outcome = { status: 404, body: aerr(6, `Неизвестный REST-метод: ${methodName}`) };
  }
  return jsonRaw(res, outcome.status, JSON.stringify(outcome.body));
}

/* --------------------------------------------------------- server/ticker */

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (core.sendSandboxStateQuotaError(res, e)) return;
    if (e && e.code === 'SANDBOX_EXPIRED') {
      try { sendSandboxError(res, { ok: false, kind: 'expired', sandbox: e.sandbox || 'default' }); } catch { /* headers sent */ }
      return;
    }
    if (e && e.code === 'BODY_TOO_LARGE') {
      try {
        jsonRaw(res, 413, aerrBody(6, 'Размер тела запроса превышает допустимый лимит', {
          field: 'body',
          hint: `Уменьшите тело запроса до ${e.maxBytes} байт или менее.`,
        }));
      } catch { /* headers sent */ }
      return;
    }
    log('request error: ' + (e && e.message));
    try { jsonRaw(res, 500, aerrBody(6, 'Внутренняя ошибка мок-стенда')); } catch { /* headers sent */ }
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
    log(`alfa-mock (Альфа-Банк, интернет-эквайринг REST /payment/rest/*.do) on http://${MOCK_HOST}:${port}`);
    // Синтетические креды мока — их нужно вписывать в интеграцию; реальные
    // тестовые креды банка выдаются индивидуально и в дефолтах НЕ используются.
    log(`creds: userName=${credLogView(USER_NAME_CRED, DEFAULT_USER_NAME)} password=${credLogView(PASSWORD_CRED, DEFAULT_PASSWORD)} callback_secret=${credLogView(CALLBACK_SECRET_CRED, DEFAULT_CALLBACK_SECRET)} (дефолты СИНТЕТИЧЕСКИЕ, по образцу TBANKMOCKTEST; значения, заданные через MOCK_ALFA_USERNAME/MOCK_ALFA_PASSWORD/MOCK_ALFA_CALLBACK_SECRET, не печатаются)`);
    log(`callbacks: GET + checksum ${CHECKSUM_ENABLED ? 'HMAC-SHA256 (симметричный; асимметричный вне области — см. README)' : 'ВЫКЛЮЧЕН (MOCK_CALLBACK_CHECKSUM=false)'} · retry ${CALLBACK_RETRY_MS}ms x${CALLBACK_MAX_ATTEMPTS} (ACK ровно 200; параметры ретраев PDF не задаёт — это mock-конфиг)${process.env.MOCK_DEFAULT_CALLBACK_URL ? ` · default ${process.env.MOCK_DEFAULT_CALLBACK_URL}` : ' · default none (jsonParams.callback_url или MOCK_DEFAULT_CALLBACK_URL)'}`);
    log(`two-stage=${TWO_STAGE} (MOCK_TWO_STAGE) partial-refund=${PARTIAL_REFUND} ssl-permitted=${SSL_PERMITTED} session_timeout=${SESSION_TIMEOUT_SECS}s terminal=${TERMINAL_ID}`);
    log(`tenancy=${TENANCY} public_base=${PUBLIC_BASE_URL} state=${MOCK_STATE_FILE || 'memory'}`);
    log(`control-plane: admin_token=${MOCK_ADMIN_TOKEN ? 'on' : 'off'} operator_token=${OPERATOR_TOKEN ? 'on' : 'off'} hosted=${HOSTED} block_private_webhooks=${BLOCK_PRIVATE_WEBHOOKS}`);
    log(`sandboxes: mode=${TENANCY} ttl_ms=${SANDBOX_TTL_MS} max=${SANDBOX_MAX} max_documents=${SANDBOX_MAX_DOCUMENTS} host_suffix=${SANDBOX_HOST_SUFFIX || '-'} registry=${sandboxRuntime.stats().file || 'memory'}${TENANCY === 'owned' && !SANDBOX_OWNER_TOKEN ? ' (default-песочница открыта: задайте MOCK_SANDBOX_TOKEN, чтобы закрыть)' : ''}`);
    log('вне области: асимметричный checksum (SHA-256/SHA-512 в PDF неоднозначны), привязки карт, моделирование orderBundle');
  });
}

module.exports = {
  server, state, clock, scenarios, sandboxRuntime, persist, restore, route,
  CARDS, ORDER_STATUSES, REST_METHODS, ACS_PASSWORD,
  USER_NAME_CRED, PASSWORD_CRED, CALLBACK_SECRET_CRED,
  canonicalChecksumString, checksumOf, statusView, tickAlfa,
};
