// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * T-Bank EACQ / Multisplit mock stand.
 *
 * Emulates the bank side of the EACQ & Multisplit contract without the bank's
 * test contour:
 *   - /v2/{Init,Confirm,Cancel,GetState,CheckOrder,Chargeback,Dispute}
 *   - /e2c/v2/{Init,Payment,GetState}
 *   - /av/v1/{payment,verification}
 *   - /mock/time (GET/POST/PUT) — virtual clock (MOCK_VIRTUAL_CLOCK)
 *   - /mock/scenarios (GET/POST/DELETE) — scenario API + trigger history
 *   - Hosted payment form with test-card scenarios (PAN-driven)
 *   - Signed HTTP notifications with bank retry policy
 *   - End-to-end chargeback state machine: DISPUTED -> REPRESENTMENT -> ARBITRATION -> WON|LOST
 *
 * Zero npm dependencies. Config via environment, see README.md in this dir.
 * Secrets are fake by definition; never expose this service publicly without protection.
 */

const http = require('http');
const crypto = require('crypto');

const core = require('../../packages/core');
const {
  readBody, parseBody, send, sendJson, html, escapeHtml, checkControlAccess,
  parseScenarioSpec, applyRequestChaos, createSandboxRuntime, resolveTenancyMode, parseMsOr,
  verifyMerchantWebhook,
} = core;
const log = core.createLog('tbank-mock');
// Журнал входящих запросов: интегратору видно в /admin/journal, как мок понял
// запрос и что ответил (спека §2 — «журнал запросов»).
const journal = core.createJournal({ size: 200 });

const {
  MOCK_HOST = '0.0.0.0',
  MOCK_PORT = '3100',
  MOCK_TERMINAL_KEY = '',
  MOCK_TERMINAL_PASSWORD = '',
  TBANK_TERMINAL_KEY = '',
  TBANK_TERMINAL_PASSWORD = '',
  MOCK_PUBLIC_BASE_URL = 'http://localhost:3100',
  MOCK_DEFAULT_NOTIFICATION_URL = '',
  MOCK_RETRY_MS = '60000',
  MOCK_MAX_ATTEMPTS = '24',
  MOCK_AUTO_CONFIRM_MS = '0',
  MOCK_STRICT_TOKEN = 'true',
  MOCK_STATE_FILE = '',
  MOCK_PROFILE = 'plain',
  MOCK_ALLOW_DUPLICATE_ORDER_ID = 'false',
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
const DEFAULT_TERMINAL_KEY = MOCK_TERMINAL_KEY || TBANK_TERMINAL_KEY || 'TBANKMOCKTEST';
const DEFAULT_TERMINAL_PASSWORD = MOCK_TERMINAL_PASSWORD || TBANK_TERMINAL_PASSWORD || 'mockpass123';
const RETRY_MS = Math.max(1000, parseInt(MOCK_RETRY_MS, 10) || 60000);
const MAX_ATTEMPTS = Math.max(1, parseInt(MOCK_MAX_ATTEMPTS, 10) || 24);
const STRICT_TOKEN = String(MOCK_STRICT_TOKEN).toLowerCase() !== 'false';
// Bank auto-confirms holds after 4-7 days; here it can be accelerated via
// MOCK_AUTO_CONFIRM_MS or tested via virtual clock (/mock/time +7d).
const AUTO_CONFIRM_MS = Math.max(0, parseInt(MOCK_AUTO_CONFIRM_MS, 10) || 0);
const HOLD_AUTO_CONFIRM_VIRTUAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней по правилам банка
const DEAL_AUTO_CANCEL_VIRTUAL_MS = 60 * 24 * 60 * 60 * 1000; // 60 дней по правилам банка
const TDS_TIMEOUT_VIRTUAL_MS = 36 * 60 * 60 * 1000;           // 36 часов для 3DS_CHECKING
const ALLOW_DUPLICATE_ORDER_ID = String(MOCK_ALLOW_DUPLICATE_ORDER_ID).toLowerCase() === 'true';
// Провайдеро-нейтральность (аудит §3.1): plain — обычный эквайринг (дефолт,
// 99% интеграций), multisplit — профиль Lovii со сделками.
const PROFILE = String(MOCK_PROFILE).toLowerCase() === 'multisplit' ? 'multisplit' : 'plain';
// F-07/F-08: hosted-режим включает fail-closed управляющей поверхности и
// SSRF-политику по умолчанию; env-флаг MOCK_BLOCK_PRIVATE_WEBHOOKS (1/true)
// может включить её и в локальном режиме, значение 0/false — выключить явно.
const HOSTED = core.flagEnabled(MOCK_HOSTED);
const OPERATOR_TOKEN = MOCK_OPERATOR_TOKEN || '';
const ADMIN_CSRF_SECRET = crypto.randomBytes(32).toString('hex');
const BLOCK_PRIVATE_WEBHOOKS = core.flagEnabled(MOCK_BLOCK_PRIVATE_WEBHOOKS, HOSTED);

/* --------------------------------------------- мульти-аренда (RFC-001, F-12) */

// MOCK_TENANCY принимает owned/namespaces/off и legacy-флаги; дефолт —
// namespaces self-hosted и owned при MOCK_HOSTED=1, неизвестное значение warn + safe default.
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
const defaultState = store.state; // идентичность состояния default-песочницы (BC с self-hosted)

/**
 * Начальное состояние песочницы. `seed` уникален для каждой песочницы, поэтому
 * числовые id документов (PaymentId, DealId, …) не совпадают между арендаторами.
 */
function createInitialTbankState({ seed = 0 } = {}) {
  const offset = seed * 1000000;
  return {
    counters: {
      paymentId: Date.now() + offset,
      dealId: 50000 + offset,
      cardId: 80000 + offset,
      notificationId: 1,
      verificationId: 7000000 + offset,
      incomingId: 1,
      payoutId: 900000 + offset,
      disputeId: 30000 + offset,
      shopCode: 700100 + offset,
    },
    payments: {},            // paymentId -> payment
    deals: {},               // spAccumulationId -> deal
    verifications: {},       // verificationId -> account verification round-trip
    incoming: {},            // incomingId -> поступление на спец-счёт (VER-платёж МСП)
    notifications: {},       // notificationId -> {payload, paymentId, attempts, nextAttemptAt, lastStatus, lastBody, dumped}
    externalRequests: {},    // ExternalRequestId -> {paymentId, status}
    payouts: {},             // payoutPaymentId -> выплата e2c
    disputes: {},            // disputeId -> {disputeId, paymentId, orderId, amount, status, reasonCode, ...}
    customers: {},           // customerKey -> {customerKey, email, phone, createdAt}
    cards: {},               // cardId -> {cardId, customerKey, panMask, expDate, rebillId, status}
    shops: {},               // shopCode -> acqapi partner shop registration
    acqTokens: {},           // F-26: sha256(access_token) -> { scope, issuedAtMs, expiresAtMs }
    orderIndex: {},          // F-15: OrderId -> [PaymentId] (производный, без полных сканов)
    dealIndex: {},           // F-15: DealId -> { payments: [PaymentId], payouts: [PayoutId] }
    clockOffsetMs: 0,
  };
}

// Boot default-песочницы: снимок из MOCK_STATE_FILE + генератор кредов песочниц.
{
  const initial = createInitialTbankState();
  for (const key of Object.keys(initial)) {
    if (defaultState[key] === undefined) defaultState[key] = initial[key];
  }
}

/**
 * Лимит документов песочницы (F-15): сумма видимых истории коллекций.
 * `counters`/`clockOffsetMs` не считаются.
 */
function countTbankDocuments(snapshot) {
  return ['payments', 'deals', 'payouts', 'disputes', 'incoming', 'verifications', 'customers', 'cards', 'shops']
    .reduce((sum, key) => sum + Object.keys(snapshot[key] || {}).length, 0)
    + Object.keys(snapshot.notifications || {}).length;
}

/**
 * Retention (F-15, по умолчанию выключен): удаляем только диагностические
 * терминальные записи (доставленные/исчерпанные нотификации и завершённые
 * прогоны рубля) — протокольная история платежей/сделок/выплат не трогается.
 */
function tbankRetention(snapshot, ts) {
  if (!SANDBOX_RETENTION_MS) return 0;
  const deadline = ts - SANDBOX_RETENTION_MS;
  let pruned = 0;
  for (const [id, n] of Object.entries(snapshot.notifications || {})) {
    const finished = n && (n.done || n.dumped || n.suppressed);
    const at = Date.parse((n && (n.finishedAt || n.createdAt || n.updatedAt)) || '') || 0;
    if (finished && at && at <= deadline) {
      delete snapshot.notifications[id];
      pruned += 1;
    }
  }
  for (const [id, v] of Object.entries(snapshot.verifications || {})) {
    const at = Date.parse((v && v.updatedAt) || '') || 0;
    if (at && at <= deadline) {
      delete snapshot.verifications[id];
      pruned += 1;
    }
  }
  return pruned;
}

/**
 * Рантайм песочниц (RFC-001, F-11—F-15): request-local контекст, per-sandbox
 * state/creds/persist, owner-token в hosted, TTL/лимиты и квоты.
 */
const sandboxRuntime = createSandboxRuntime({
  state: defaultState,
  persist: store.persist,
  initialStateFactory: createInitialTbankState,
  mode: TENANCY,
  stateFile: MOCK_STATE_FILE,
  sandboxFile: String(process.env.MOCK_SANDBOX_FILE || ''),
  ttlMs: SANDBOX_TTL_MS,
  maxSandboxes: SANDBOX_MAX,
  maxDocuments: SANDBOX_MAX_DOCUMENTS,
  documentCounter: countTbankDocuments,
  retention: tbankRetention,
  defaultOwnerToken: SANDBOX_OWNER_TOKEN,
  hostSuffix: SANDBOX_HOST_SUFFIX,
  operatorTokens: [MOCK_ADMIN_TOKEN, OPERATOR_TOKEN],
  createLimit: SANDBOX_CREATE_LIMIT,
  log: (msg) => console.error(`[mock] ${msg}`),
});

// Фасад состояния/персистентности: внутри запроса резолвится в его песочницу.
const state = sandboxRuntime.state;
const persist = sandboxRuntime.persist;

/* --------------------------------------------------- креды песочницы (F-12) */

/**
 * В owned-режиме у каждой созданной песочницы свои TerminalKey/TerminalPassword
 * (интегратор проходит тот же путь, что в бою: «впиши свой ключ»). В остальных
 * режимах — креды стенда, поэтому self-hosted поведение не меняется.
 */
const terminalKey = () => sandboxRuntime.creds().terminalKey || DEFAULT_TERMINAL_KEY;
const terminalPassword = () => sandboxRuntime.creds().terminalPassword || DEFAULT_TERMINAL_PASSWORD;
const e2cTerminalKey = () => `${terminalKey()}E2C`;

// DEPRECATED-константы: креды default/self-hosted стенда (BC для тестов и /admin).
const TERMINAL_KEY = DEFAULT_TERMINAL_KEY;
const TERMINAL_PASSWORD = DEFAULT_TERMINAL_PASSWORD;
const E2C_TERMINAL_KEY = `${TERMINAL_KEY}E2C`;

const clock = core.createVirtualClock({
  initial: MOCK_VIRTUAL_CLOCK,
  getStateOffset: () => state.clockOffsetMs || 0,
  setStateOffset: (v) => { state.clockOffsetMs = v; persist(); },
});

const scenarios = core.createScenarioRegistry({ clock });

/* --------------------------------------------------------------- signature */

/**
 * Подпись запроса (как в банке): значения top-level скаляров кроме Token +
 * Password, сортировка по ключу. Пароль резолвится из контекста песочницы
 * (в owned-режиме у каждой он свой); явный `password` нужен инструментам
 * (тесты, активный экзаменатор), которые подписывают не от лица запроса.
 */
function tokenOf(payload, password = null) {
  const values = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'Token') continue;
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') continue; // DATA, Receipt, arrays
    values.push([key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)]);
  }
  values.push(['Password', password || terminalPassword()]);
  values.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256').update(values.map(([, v]) => v).join('')).digest('hex');
}

function verifyToken(payload) {
  if (!STRICT_TOKEN) return true;
  try {
    const given = payload && payload.Token;
    if (!given || typeof given !== 'string') return false;
    const expected = tokenOf(payload);
    // F-28: сравниваем БАЙТОВЫЕ длины буферов. JS string.length — это UTF-16
    // code units: multibyte-Token (например, 32 эмодзи = 64 units, 128 bytes)
    // проходил проверку длины, но timingSafeEqual бросал RangeError и маршрут
    // отвечал 5000 вместо ошибки подписи 13.
    const givenBuf = Buffer.from(given, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (givenBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(givenBuf, expectedBuf);
  } catch {
    // Мусор вместо Token — это отказ подписи (код 13), а не внутренняя ошибка 5000.
    return false;
  }
}

/* ------------------------------------------------------------ test cards */

const CARDS = {
  '2201382000000013': { scenario: 'success', label: '3DS2 frictionless — успех' },
  '2201382000000039': { scenario: 'success', label: '3DS2 attempts (A) — успех' },
  '2201382000000047': { scenario: 'challenge', label: '3DS2 challenge — OTP 1qwezxc' },
  '2201382000000005': { scenario: 'reject', code: '57', message: 'Эмитент отклонил аутентификацию' },
  '2201382000000021': { scenario: 'reject', code: '76', message: 'Карта не поддерживает 3DS' },
  '2201382000000831': { scenario: 'reject', code: '1051', message: 'Недостаточно средств на карте' },
  '5586200071492158': { scenario: 'success', label: '3DS1 — успех' },
  '5586200071499591': { scenario: 'insufficient_over_1000', label: '3DS1 — недостаточно средств при сумме > 1000 ₽' },
  '2200770239097761': { scenario: 'success', label: 'без 3DS — успех' },
  '4249170392197566': { scenario: 'reject', code: '1051', message: 'Недостаточно средств на карте' },
  '5586200071492075': { scenario: 'reject', code: '9999', message: 'Ошибка при списании' },
};

const maskPan = (pan) => `${pan.slice(0, 6)}**${pan.slice(-4)}`;

/* ------------------------------------------------------- e2c card data (F-10) */

/**
 * Тестовые карты выплат: сценарий выбирается по номеру карты один раз — в
 * `/e2c/v2/Init`; дальше в состоянии живёт только маска и тип сценария.
 */
const PAYOUT_CARD_SCENARIOS = new Map([
  // Официальный тестовый кейс: привязка успешна, Payment -> authRC 1057
  ['5000000000000553', 'reject-1057'],
]);

/**
 * Минимизация карточных данных выплаты (F-10): полный PAN не сохраняется
 * ни в state, ни в снимке `/mock/state`, ни в журнале. Возвращаем только
 * маску (BIN + последние 4) и выбранный тестовый сценарий.
 */
function resolvePayoutCard(...values) {
  const candidates = values.map((value) => String(value ?? '').trim()).filter(Boolean);
  const cardNumber = candidates.find((value) => core.looksLikePan(value)) || '';
  const scenarioSource = candidates.find((value) => PAYOUT_CARD_SCENARIOS.has(value));
  return {
    panMask: cardNumber ? maskPan(cardNumber) : null,
    cardScenario: scenarioSource ? PAYOUT_CARD_SCENARIOS.get(scenarioSource) : null,
  };
}

/**
 * Снимки состояния прежних версий содержат полный PAN в `payouts[*].pan`.
 * Вычищаем его при загрузке и импорте, чтобы старый state-файл не тащил
 * реквизиты (F-10).
 */
function scrubLegacyPan(targetState) {
  const payouts = targetState && targetState.payouts;
  if (!payouts || typeof payouts !== 'object') return 0;
  let scrubbed = 0;
  for (const payout of Object.values(payouts)) {
    if (!payout || typeof payout !== 'object' || !('pan' in payout)) continue;
    const resolved = resolvePayoutCard(payout.pan, payout.cardId);
    if (!payout.panMask && resolved.panMask) payout.panMask = resolved.panMask;
    if (!payout.cardScenario && resolved.cardScenario) payout.cardScenario = resolved.cardScenario;
    if (payout.cardId && core.looksLikePan(payout.cardId)) payout.cardId = maskPan(payout.cardId);
    delete payout.pan;
    scrubbed += 1;
  }
  return scrubbed;
}

/* ---------------------------------------- e2c payout validation (F-17…F-23) */

const PAYOUT_REF_DOC = '/e2c'; // путь в developer.tbank.ru/eacq (03-payouts-and-deals.md)

/** Непустая строка без внешних пробелов или null. */
function textOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/** Запись перехода статуса выплаты (в legacy-снимках истории может не быть). */
function pushPayoutStatus(payout, status) {
  const at = clock.iso();
  if (!Array.isArray(payout.statusHistory)) payout.statusHistory = [];
  payout.status = status;
  payout.statusHistory.push({ status, at });
  return at;
}

/**
 * Общие обязательные поля `/e2c/v2/Init` по reference 03-payouts-and-deals.md:
 * TerminalKey (проверяется отдельно), OrderId, Amount, DealId, PaymentRecipientId
 * (≤16 символов). Возвращает нормализованные значения или provider-shaped ошибку —
 * до выделения PaymentId и записи в state (F-17).
 */
function validatePayoutInitFields(body) {
  const money = core.parseMoneyKopeks(body.Amount, { field: 'Amount' });
  if (!money.ok) {
    return {
      error: err(7, `Обязательные параметры не заполнены или невалидны: ${money.message}`, null, {
        field: 'Amount',
        doc: PAYOUT_REF_DOC,
      }),
    };
  }
  const amount = money.value;
  const orderId = textOrNull(body.OrderId);
  const dealId = textOrNull(body.DealId);
  const recipientId = textOrNull(body.PaymentRecipientId);
  const missing = [];
  if (!orderId) missing.push('OrderId');
  if (!dealId) missing.push('DealId');
  if (!recipientId) missing.push('PaymentRecipientId');
  if (missing.length) {
    return {
      error: err(7, `Обязательные параметры не заполнены: ${missing.join(', ')}`, null, {
        field: missing.join(', '),
        doc: PAYOUT_REF_DOC,
        hint: 'Init выплаты требует TerminalKey, OrderId, Amount, DealId, PaymentRecipientId, подпись и ровно один канал выплаты (CardId/CardData, Phone+SbpMemberId или PartnerId).',
      }),
    };
  }
  if (recipientId.length > 16) {
    return {
      error: err(7, `PaymentRecipientId «${recipientId}» длиннее 16 символов`, null, {
        field: 'PaymentRecipientId',
        doc: PAYOUT_REF_DOC,
      }),
    };
  }
  return { amount, orderId, dealId, recipientId };
}

/**
 * Канал выплаты (F-17; reference 03-payouts-and-deals.md): у Init ровно один
 * из наборов —
 *   card    — `CardId` (карта из AddCard/Init) или `CardData`/`Pan` (карта по данным;
 *             в моке `Pan` — открытый shortcut вместо X509-блока, хранится только маска);
 *   sbp     — `Phone` (11 цифр) + `SbpMemberId` (банк-получатель из GetSbpMembers);
 *   partner — `PartnerId` = shopCode точки, зарегистрированной через acqapi.
 * Возвращает нормализованный канал (`recipientType`/`recipientId`) или ошибку.
 */
function resolvePayoutChannel(body, amount) {
  const partnerId = textOrNull(body.PartnerId);
  const phone = textOrNull(body.Phone);
  const sbpMemberId = textOrNull(body.SbpMemberId);
  const cardId = textOrNull(body.CardId);
  const cardData = textOrNull(body.CardData) || textOrNull(body.Pan);
  const used = [];
  if (partnerId) used.push('PartnerId');
  if (phone || sbpMemberId) used.push('Phone/SbpMemberId');
  if (cardId || cardData) used.push('CardId/CardData');

  if (used.length === 0) {
    return {
      error: err(7, 'Не передан канал выплаты: укажите ровно один набор — CardId|CardData (карта), Phone+SbpMemberId (СБП) или PartnerId (партнёр)', null, {
        field: 'PartnerId | Phone | CardId',
        doc: PAYOUT_REF_DOC,
      }),
    };
  }
  if (used.length > 1) {
    return {
      error: err(7, `Канал выплаты определён неоднозначно: переданы ${used.join(' и ')} (у Init выплаты ровно один канал)`, null, {
        field: used.join(', '),
        doc: PAYOUT_REF_DOC,
      }),
    };
  }

  if (partnerId) {
    const shop = state.shops[partnerId];
    if (!shop) {
      return {
        error: err(8, `Партнёр PartnerId=«${partnerId}» не найден: выплата партнёру идёт на shopCode зарегистрированной точки`, null, {
          field: 'PartnerId',
          doc: PAYOUT_REF_DOC,
          hint: 'Зарегистрируйте точку: POST /oauth/token → POST /sm-register/register; shopCode из ответа передаётся как PartnerId.',
        }),
      };
    }
    return { channel: { recipientType: 'partner', recipientId: partnerId, partnerId } };
  }

  if (phone || sbpMemberId) {
    if (!phone || !sbpMemberId) {
      return {
        error: err(7, `Канал СБП требует оба параметра: Phone (11 цифр) и SbpMemberId — не передан ${phone ? 'SbpMemberId' : 'Phone'}`, null, {
          field: phone ? 'SbpMemberId' : 'Phone',
          doc: PAYOUT_REF_DOC,
          hint: 'Список банков-получателей и их MemberId — POST /e2c/v2/GetSbpMembers.',
        }),
      };
    }
    const phoneDigits = phone.replace(/\D/g, '');
    if (!/^[+\d\s()-]+$/.test(phone) || !/^\d{11}$/.test(phoneDigits)) {
      return {
        error: err(7, `Phone «${phone}» должен содержать 11 цифр (например +79211234567)`, null, {
          field: 'Phone',
          doc: PAYOUT_REF_DOC,
        }),
      };
    }
    if (amount < 1000) {
      return {
        error: err(7, `Минимальная сумма выплаты по СБП — 10 ₽ (1000 коп.), передано ${amount} коп.`, null, {
          field: 'Amount',
          doc: PAYOUT_REF_DOC,
        }),
      };
    }
    return { channel: { recipientType: 'sbp', recipientId: phoneDigits, phone: phoneDigits, sbpMemberId } };
  }

  return { channel: { recipientType: 'card', recipientId: cardId } };
}

/* ------------------------------------------------------------ notifications */

const NOTIFIED_STATUSES = new Set([
  'AUTHORIZED',
  'CONFIRMED',
  'REVERSED',
  'PARTIAL_REVERSED',
  'REFUNDED',
  'PARTIAL_REFUNDED',
  'REJECTED',
  'CHARGEBACK',
  'PARTIAL_CHARGEBACK',
]);

function scheduleNotification(payment, status, extra = {}, options = {}) {
  if (!NOTIFIED_STATUSES.has(status)) return;
  const url = payment.notificationUrl || MOCK_DEFAULT_NOTIFICATION_URL;
  if (!url) {
    console.log(`[mock] ${payment.paymentId}: no notification URL, skip ${status}`);
    return;
  }
  const suppressed = Boolean(options.suppress || payment.suppressWebhooks);
  const duplicate = Boolean(options.duplicate || payment.duplicateWebhooks);
  const payload = {
    TerminalKey: terminalKey(),
    OrderId: payment.orderId,
    Success: status !== 'REJECTED',
    Status: status,
    PaymentId: payment.paymentId,
    ErrorCode: status === 'REJECTED' ? String(payment.failCode || '9999') : '0',
    Amount: currentAmount(payment),
    Pan: payment.panMask || undefined,
    ExpDate: payment.expDate || undefined,
    CardId: payment.cardId || undefined,
    SpAccumulationId: payment.dealId || undefined,
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || v === '') delete payload[k];
    else payload[k] = v;
  }
  payload.Token = tokenOf(payload);

  const count = duplicate && !suppressed ? 2 : 1;
  for (let i = 0; i < count; i += 1) {
    const id = String(state.counters.notificationId++);
    state.notifications[id] = {
      id,
      paymentId: payment.paymentId,
      url,
      payload,
      attempts: 0,
      nextAttemptAt: 0,
      lastStatus: suppressed ? 'SUPPRESSED' : null,
      lastBody: suppressed ? 'suppressed by webhook-drop scenario' : null,
      dumped: false,
      done: suppressed,
      suppressed,
    };
    console.log(`[mock] notification ${id} ${suppressed ? 'SUPPRESSED (webhook-drop)' : 'queued'}: ${payment.paymentId} -> ${status}`);
  }
  persist();
}

function currentAmount(payment) {
  if (payment.remaining !== null && payment.remaining !== undefined) return payment.remaining;
  return payment.amount;
}

const deliveryQueue = core.createDeliveryQueue({
  // Функция, а не объект: очередь резолвит state песочницы, в контексте которой
  // выполняется tick (каждая песочница доставляет свои нотификации, F-11).
  entries: () => state.notifications,
  retryMs: RETRY_MS,
  maxAttempts: MAX_ATTEMPTS,
  // F-29: нотификации Т-Банка обязаны уходить по одной и по порядку (контракт
  // очереди ядра, packages/core/README.md) — статусы одного платежа не должны
  // перепрыгивать друг друга при разной задержке приёмника.
  awaitSequential: true,
  persist,
  log,
  now: () => clock.now(),
  request: (n) => ({ url: n.url, data: n.payload }),
  isOk: (res) => res.statusCode === 200 && String(res.body || '').trim() === 'OK',
  blockPrivateHosts: BLOCK_PRIVATE_WEBHOOKS,
  due: (n) => !n.done && !n.dumped && !n.suppressed && (n.nextAttemptAt || 0) <= clock.now(),
  prepare: (n) => { n.attempts += 1; },
  onFailure: (n, status, body) => {
    n.lastStatus = status;
    n.lastBody = body;
    if (n.attempts >= MAX_ATTEMPTS) {
      n.dumped = true;
      log(`notification ${n.id} dumped after ${n.attempts} attempts`);
    } else {
      n.nextAttemptAt = clock.now() + RETRY_MS;
    }
  },
});

/* -------------------------------------------------------------- helpers */

const derr = core.createErrorCatalog({
  provider: 'tbank-eacq',
  docsBase: 'https://developer.tbank.ru/eacq',
  codes: {
    4: { message: 'Объект выплаты не найден', field: 'PaymentId', hint: 'Проверьте PaymentId выплаты (/e2c/v2/Init).', doc: '/e2c' },
    7: { message: 'Обязательные параметры не заполнены или невалидны', field: 'Amount, OrderId', hint: 'Проверьте: Amount — целое число в копейках больше нуля (100000 = 1000,00 ₽), OrderId — непустая строка и уникален для каждой операции (повторный Init с тем же OrderId отклоняется — как в банке), сумма Cancel/Confirm/Chargeback не больше доступной суммы платежа.', doc: '/api/init' },
    8: { message: 'Объект не найден', field: 'PaymentId | OrderId | DisputeId', hint: 'Платёж или спор не найден ни по PaymentId, ни по OrderId, ни по DisputeId. Платёжные сессии живут в состоянии стенда; после рестарта с пустым MOCK_STATE_FILE старые id недоступны.', doc: '/api/getstate' },
    13: { message: 'Неверный Token (подпись) запроса', field: 'Token', hint: 'Подпись = sha256(значения всех top-level скаляров кроме Token/null/\'\' + Password, отсортированные по ключу, в нижнем регистре для boolean). Сверьте с conspectus docs/reference/tbank/02-notifications-signature.md.', doc: '/intro/to-api' },
    32: { message: 'Операция недоступна в текущем статусе', field: 'PaymentId | DisputeId', hint: 'Переход запрещён машиной состояний: Confirm — только из AUTHORIZED; Cancel — из NEW (CANCELED), AUTHORIZED (REVERSED/PARTIAL_REVERSED), CONFIRMED (REFUNDED/PARTIAL_REFUNDED); Chargeback — только из CONFIRMED/PARTIAL_REFUNDED по цепочке DISPUTED -> REPRESENTMENT -> ARBITRATION -> WON|LOST.', doc: '/api/confirm' },
    501: { message: 'Метод не поддерживается мок-стендом', hint: 'Стенд реализует Init/Confirm/Cancel/GetState/CheckOrder/Chargeback/Dispute + e2c/AV.', doc: '' },
    500: { message: 'Сбой шлюза (сценарий мока)', field: 'X-Mock-Scenario', hint: 'Сценарий X-Mock-Scenario: http-500 имитирует 500 шлюза до банка: запрос не выполнен, побочных эффектов нет. Уберите сценарий и повторите.', doc: '' },
    504: { message: 'Таймаут шлюза (сценарий мока)', field: 'X-Mock-Scenario', hint: 'Сценарий X-Mock-Scenario: http-504 имитирует таймаут шлюза: запрос не выполнен, побочных эффектов нет. Для честной задержки используйте latency:<время>.', doc: '' },
    5000: { message: 'Внутренняя ошибка мок-стенда', hint: 'Смотрите лог сервиса; если воспроизводится — это дефект мока, заводите issue.', doc: '' },
  },
});

/** F-15: квота документов песочницы перед созданием нового документа. */
function ensureSandboxQuota() {
  const quota = sandboxRuntime.checkDocuments();
  if (quota.ok) return null;
  return err(7, `Лимит документов песочницы исчерпан (${quota.used}/${quota.limit})`, null, {
    field: 'OrderId',
    hint: 'Песочница ограничена по объёму (MOCK_SANDBOX_MAX_DOCUMENTS): сбросьте её (POST /sandboxes/me/reset) или создайте новую (POST /sandboxes).',
  });
}

function err(code, message, details, overrides = {}) {
  const desc = derr(code, { message: message || undefined, details, ...overrides });
  return {
    Success: false,
    ErrorCode: String(code),
    Message: desc.message,
    Details: {
      ...(details ? { Details: details } : {}),
      Field: desc.field || undefined,
      Hint: desc.hint || undefined,
      Doc: desc.doc || undefined,
    },
  };
}

function baseResponse(payment) {
  return {
    TerminalKey: terminalKey(),
    OrderId: payment.orderId,
    PaymentId: payment.paymentId,
    Amount: currentAmount(payment),
    Status: payment.status,
    Success: true,
    ErrorCode: '0',
    ...(payment.disputeId ? { DisputeId: payment.disputeId, DisputeStatus: payment.disputeStatus } : {}),
  };
}

function findDeal(id) {
  return id ? state.deals[String(id)] || null : null;
}

function setStatus(payment, status) {
  const nowIso = clock.iso();
  payment.status = status;
  payment.statusHistory.push({ status, at: nowIso });
  payment[statusCamel(status) + 'At'] = nowIso;
  payment[statusCamel(status) + 'AtMs'] = clock.now();
}

function statusCamel(s) {
  const parts = s.split('_').map((p) => p[0] + p.slice(1).toLowerCase());
  const out = parts.join('');
  return out[0].toLowerCase() + out.slice(1);
}

/* ------------------------------------------- индексы ссылок (F-15, RFC §9.2) */
/*
 * `orderIndex`/`dealIndex` — производные от `payments`/`payouts`: нужны, чтобы
 * Init/GetState/CheckOrder и `dealBalance` не сканировали всю историю песочницы
 * (N+1 на растущем state, в т.ч. для каждой строки /admin). Индексы
 * поддерживаются при создании документов и полностью перестраиваются из снимка
 * (`rebuildIndexes`) при boot/restore/import/reset; читатели сверяются с самим
 * state, поэтому отсутствующая запись индекса не создаёт «фантомных» ответов.
 */
function indexPayment(target, payment) {
  if (!payment) return;
  if (!target.orderIndex || !target.dealIndex) rebuildIndexes(target); // снимок из файла/импорта мог быть без индексов
  const paymentId = String(payment.paymentId);
  if (payment.orderId !== undefined && payment.orderId !== null && payment.orderId !== '') {
    const key = String(payment.orderId);
    const ids = target.orderIndex[key] || (target.orderIndex[key] = []);
    if (!ids.includes(paymentId)) ids.push(paymentId);
  }
  if (payment.dealId) {
    const key = String(payment.dealId);
    const bucket = target.dealIndex[key] || (target.dealIndex[key] = { payments: [], payouts: [] });
    if (!bucket.payments.includes(paymentId)) bucket.payments.push(paymentId);
  }
}

function indexPayout(target, payout) {
  if (!payout || !payout.dealId) return;
  if (!target.orderIndex || !target.dealIndex) rebuildIndexes(target);
  const key = String(payout.dealId);
  const bucket = target.dealIndex[key] || (target.dealIndex[key] = { payments: [], payouts: [] });
  const payoutId = String(payout.paymentId);
  if (!bucket.payouts.includes(payoutId)) bucket.payouts.push(payoutId);
}

/** Полная перестройка индексов из снимка (состояние могло прийти файлом/импортом). */
function rebuildIndexes(target) {
  target.orderIndex = {};
  target.dealIndex = {};
  for (const payment of Object.values(target.payments || {})) indexPayment(target, payment);
  for (const payout of Object.values(target.payouts || {})) indexPayout(target, payout);
}

/** Платежи заказа по индексу (fallback-скан — только если индекс отсутствует). */
function paymentsOfOrder(orderId) {
  const key = String(orderId);
  if (!state.orderIndex) return Object.values(state.payments).filter((p) => p.orderId === key);
  return (state.orderIndex[key] || []).map((id) => state.payments[id]).filter(Boolean);
}

/** Документы сделки по индексу (fallback-скан — только если индекс отсутствует). */
function documentsOfDeal(dealId) {
  if (!state.dealIndex) {
    return {
      payments: Object.values(state.payments).filter((p) => p.dealId === dealId),
      payouts: Object.values(state.payouts || {}).filter((po) => po.dealId === dealId),
    };
  }
  const bucket = state.dealIndex[String(dealId)] || { payments: [], payouts: [] };
  return {
    payments: (bucket.payments || []).map((id) => state.payments[id]).filter(Boolean),
    payouts: (bucket.payouts || []).map((id) => state.payouts[id]).filter(Boolean),
  };
}

function dealBalance(deal) {
  const docs = documentsOfDeal(deal.id);
  const incomingConfirmed = docs.payments
    .filter((p) => ['CONFIRMED', 'PARTIAL_REFUNDED', 'PARTIAL_CHARGEBACK'].includes(p.status))
    .reduce((acc, p) => acc + currentAmount(p), 0);
  const outgoingPaid = docs.payouts
    .filter((po) => ['CONFIRMED', 'COMPLETED'].includes(po.status))
    .reduce((acc, po) => acc + (po.amount || 0), 0);
  return Math.max(0, incomingConfirmed - outgoingPaid);
}

/** Применение сценарных директив (X-Mock-Scenario / DATA.mock_scenario / правила) к платежу. */
function applyScenarioToPayment(payment, spec) {
  if (!spec || !spec.items || !spec.items.length) return;
  if (spec.has('webhook-drop') || spec.has('no-webhook')) {
    payment.suppressWebhooks = true;
  }
  if (spec.has('webhook-duplicate')) {
    payment.duplicateWebhooks = true;
  }
  const cbAfter = spec.get('chargeback-after');
  if (cbAfter) {
    const delayMs = core.parseDuration(cbAfter === true ? '7d' : cbAfter);
    if (delayMs !== null && delayMs >= 0) {
      payment.chargebackAfterMs = delayMs;
      if (payment.status === 'CONFIRMED') {
        payment.scheduledChargebackAt = clock.now() + delayMs;
      }
    }
  }
  const autoConf = spec.get('auto-confirm');
  if (autoConf) {
    const delayMs = core.parseDuration(autoConf === true ? '7d' : autoConf);
    if (delayMs !== null && delayMs >= 0) {
      payment.customAutoConfirmMs = delayMs;
    }
  }
  const partRefund = spec.get('partial-refund');
  if (partRefund) {
    payment.partialRefundSpec = partRefund === true ? '50%' : String(partRefund);
  }
}

/**
 * Вычисление суммы для сценария partial-refund (процент или копейки).
 * F-24: копейки разбираются тем же строгим правилом, что и Amount в API —
 * мусор в сценарии («30000xyz») не превращается в сумму, а уходит в дефолт 50 %.
 */
function resolvePartialAmount(rawSpec, available) {
  if (!rawSpec || rawSpec === true) return Math.max(1, Math.floor(available / 2));
  const s = String(rawSpec).trim();
  if (s.endsWith('%')) {
    const pct = parseFloat(s.slice(0, -1));
    if (Number.isFinite(pct) && pct > 0 && pct < 100) {
      return Math.max(1, Math.round((available * pct) / 100));
    }
  }
  const money = core.parseMoneyKopeks(s, { field: 'partial-refund' });
  if (money.ok && money.value < available) return money.value;
  return Math.max(1, Math.floor(available / 2));
}

/* ------------------------------------------- Chargeback / Dispute machine */

/*
 * Машина состояний спора (чарджбэк Т-Банка / Lovii T-024):
 *   DISPUTED (инициация эмитентом из CONFIRMED / PARTIAL_REFUNDED)
 *     -> REPRESENTMENT (оспаривание мерчантом с доказательствами / ФД)
 *     -> ARBITRATION   (передача спора в арбитраж платёжной системы)
 *     -> WON           (спор выигран мерчантом: возврат средств в CONFIRMED / PARTIAL_REFUNDED)
 *     -> LOST          (спор проигран/признан: финальный CHARGEBACK / PARTIAL_CHARGEBACK)
 */
function findPaymentByRef(body) {
  if (body.PaymentId && state.payments[String(body.PaymentId)]) {
    return state.payments[String(body.PaymentId)];
  }
  if (body.OrderId) {
    const matches = paymentsOfOrder(body.OrderId).filter((p) => p.orderId === String(body.OrderId));
    if (matches.length === 1) return matches[0];
  }
  return null;
}

function openDispute(payment, { amount, reasonCode = '4853', comment = '', suppress = false, duplicate = false } = {}) {
  if (!['CONFIRMED', 'PARTIAL_REFUNDED', 'PARTIAL_CHARGEBACK'].includes(payment.status)) {
    return err(
      32,
      `Чарджбэк доступен только для подтверждённого платежа (CONFIRMED/PARTIAL_REFUNDED), сейчас ${payment.status}`,
      `PaymentId=${payment.paymentId}`,
      { field: 'PaymentId', doc: '/notifications/notification' },
    );
  }
  if (payment.disputeId && state.disputes[payment.disputeId] && !['WON', 'LOST'].includes(state.disputes[payment.disputeId].status)) {
    return err(
      32,
      `По платежу ${payment.paymentId} уже открыт активный спор ${payment.disputeId} в статусе ${state.disputes[payment.disputeId].status}`,
      `DisputeId=${payment.disputeId}`,
      { field: 'DisputeId' },
    );
  }

  const available = currentAmount(payment);
  let disputeAmount = available;
  if (amount !== undefined && amount !== null && amount !== '') {
    // F-24: строгий разбор суммы — «1000xyz»/«1000.9» не должны открывать спор на 1000 копеек.
    const money = core.parseMoneyKopeks(amount, { field: 'Amount' });
    if (!money.ok) {
      return { ...err(7, `Некорректная сумма чарджбэка: ${money.message}`), PaymentId: payment.paymentId, OrderId: payment.orderId };
    }
    const parsed = money.value;
    if (parsed > available) {
      return {
        ...err(7, `Сумма чарджбэка ${parsed} больше доступной суммы платежа ${available}`),
        PaymentId: payment.paymentId,
        OrderId: payment.orderId,
        OriginalAmount: available,
      };
    }
    disputeAmount = parsed;
  }

  const partial = disputeAmount < available;
  const targetPaymentStatus = partial ? 'PARTIAL_CHARGEBACK' : 'CHARGEBACK';
  const disputeId = 'DSP-' + String(++state.counters.disputeId);
  const nowIso = clock.iso();

  const dispute = {
    disputeId,
    paymentId: payment.paymentId,
    orderId: payment.orderId,
    originalAmount: available,
    amount: disputeAmount,
    partial,
    reasonCode: String(reasonCode || '4853'),
    comment: String(comment || ''),
    status: 'DISPUTED',
    paymentStatusBefore: payment.status,
    evidence: null,
    statusHistory: [{ status: 'DISPUTED', at: nowIso }],
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  state.disputes[disputeId] = dispute;
  payment.disputeId = disputeId;
  payment.disputeStatus = 'DISPUTED';
  payment.remaining = available - disputeAmount;
  setStatus(payment, targetPaymentStatus);
  persist();

  scheduleNotification(
    payment,
    targetPaymentStatus,
    {
      DisputeId: disputeId,
      DisputeStatus: 'DISPUTED',
      DisputeAmount: disputeAmount,
      ReasonCode: dispute.reasonCode,
    },
    { suppress, duplicate },
  );

  return {
    ...baseResponse(payment),
    DisputeId: disputeId,
    DisputeStatus: dispute.status,
    DisputeAmount: disputeAmount,
    OriginalAmount: available,
    NewAmount: payment.remaining,
    ReasonCode: dispute.reasonCode,
  };
}

function transitionDispute(dispute, action, body = {}, options = {}) {
  const act = String(action || '').toLowerCase();
  const payment = state.payments[dispute.paymentId];
  if (!payment) return err(8, 'Платёж спора не найден');
  const nowIso = clock.iso();

  if (act === 'representment' || act === 'challenge') {
    if (dispute.status !== 'DISPUTED') {
      return err(
        32,
        `Переход в REPRESENTMENT возможен только из статуса DISPUTED, сейчас ${dispute.status}`,
        `DisputeId=${dispute.disputeId}`,
        { field: 'DisputeId', hint: 'Цепочка чарджбэка: DISPUTED -> REPRESENTMENT -> ARBITRATION -> WON|LOST.' },
      );
    }
    dispute.status = 'REPRESENTMENT';
    dispute.evidence = {
      comment: String(body.Evidence || body.Comment || 'Предъявлены чеки 54-ФЗ и подтверждение выдачи заказа'),
      fiscalDocumentNumber: body.FiscalDocumentNumber ? String(body.FiscalDocumentNumber) : null,
      submittedAt: nowIso,
    };
    dispute.updatedAt = nowIso;
    dispute.statusHistory.push({ status: 'REPRESENTMENT', at: nowIso });
    payment.disputeStatus = 'REPRESENTMENT';
    payment.statusHistory.push({ status: 'REPRESENTMENT', at: nowIso });
    persist();

    scheduleNotification(
      payment,
      payment.status,
      {
        DisputeId: dispute.disputeId,
        DisputeStatus: 'REPRESENTMENT',
        DisputeAmount: dispute.amount,
      },
      options,
    );
  } else if (act === 'arbitration' || act === 'arb' || act === 'pre_arb') {
    if (dispute.status !== 'REPRESENTMENT') {
      return err(
        32,
        `Переход в ARBITRATION возможен только после REPRESENTMENT, сейчас ${dispute.status}`,
        `DisputeId=${dispute.disputeId}`,
        { field: 'DisputeId', hint: 'Сначала подайте доказательства (Action="representment"), затем переводите спор в арбитраж (Action="arbitration").' },
      );
    }
    dispute.status = 'ARBITRATION';
    dispute.updatedAt = nowIso;
    dispute.statusHistory.push({ status: 'ARBITRATION', at: nowIso });
    payment.disputeStatus = 'ARBITRATION';
    payment.statusHistory.push({ status: 'ARBITRATION', at: nowIso });
    persist();

    scheduleNotification(
      payment,
      payment.status,
      {
        DisputeId: dispute.disputeId,
        DisputeStatus: 'ARBITRATION',
        DisputeAmount: dispute.amount,
      },
      options,
    );
  } else if (['resolve', 'win', 'won', 'lose', 'lost', 'accept'].includes(act)) {
    if (!['DISPUTED', 'REPRESENTMENT', 'ARBITRATION'].includes(dispute.status)) {
      return err(
        32,
        `Спор ${dispute.disputeId} уже завершён в статусе ${dispute.status}`,
        `DisputeId=${dispute.disputeId}`,
        { field: 'DisputeId' },
      );
    }
    const rawOutcome = String(body.Outcome || (act === 'win' || act === 'won' ? 'WON' : (act === 'lose' || act === 'lost' || act === 'accept' ? 'LOST' : ''))).toUpperCase();
    if (!['WON', 'LOST'].includes(rawOutcome)) {
      return err(7, 'Для завершения спора укажите Outcome: "WON" или "LOST" (либо Action: "win"|"lose")', null, { field: 'Outcome' });
    }
    dispute.status = rawOutcome;
    dispute.resolvedAt = nowIso;
    dispute.updatedAt = nowIso;
    dispute.statusHistory.push({ status: rawOutcome, at: nowIso });
    payment.disputeStatus = rawOutcome;

    if (rawOutcome === 'WON') {
      // Спор выигран мерчантом: удержанная сумма возвращается в платёж/сделку
      payment.remaining = (payment.remaining || 0) + dispute.amount;
      const restoredStatus = payment.remaining < (payment.confirmedAmount || payment.amount)
        ? 'PARTIAL_REFUNDED'
        : 'CONFIRMED';
      setStatus(payment, restoredStatus);
      persist();
      scheduleNotification(
        payment,
        restoredStatus,
        {
          DisputeId: dispute.disputeId,
          DisputeStatus: 'WON',
          DisputeAmount: dispute.amount,
        },
        options,
      );
    } else {
      // LOST: финальное удержание чарджбэка
      const finalStatus = dispute.partial && payment.remaining > 0 ? 'PARTIAL_CHARGEBACK' : 'CHARGEBACK';
      setStatus(payment, finalStatus);
      persist();
      scheduleNotification(
        payment,
        finalStatus,
        {
          DisputeId: dispute.disputeId,
          DisputeStatus: 'LOST',
          DisputeAmount: dispute.amount,
        },
        options,
      );
    }
  } else if (act === 'state' || act === 'get') {
    // только чтение
  } else {
    return err(7, `Неизвестное действие по спору Action=«${action}» (допустимо: init, representment, arbitration, resolve/win/lose, state)`);
  }

  return {
    ...baseResponse(payment),
    DisputeId: dispute.disputeId,
    DisputeStatus: dispute.status,
    DisputeAmount: dispute.amount,
    OriginalAmount: dispute.originalAmount,
    NewAmount: currentAmount(payment),
    ReasonCode: dispute.reasonCode,
    Evidence: dispute.evidence || undefined,
    StatusHistory: dispute.statusHistory,
  };
}

function handleChargeback(body, reqHeaders = {}) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;

  const spec = scenarios.resolve({
    header: reqHeaders['x-mock-scenario'] || '',
    bodyScenario: (body.DATA && body.DATA.mock_scenario) || body.MockScenario || '',
    target: 'chargeback',
    context: { paymentId: body.PaymentId, orderId: body.OrderId, disputeId: body.DisputeId },
  });
  const options = {
    suppress: spec.has('webhook-drop') || spec.has('no-webhook'),
    duplicate: spec.has('webhook-duplicate'),
  };

  const action = String(body.Action || 'init').toLowerCase();
  if (action === 'init' || action === 'open') {
    const payment = findPaymentByRef(body);
    if (!payment) return err(8, 'Платёж для чарджбэка не найден (передайте PaymentId или OrderId)');
    return openDispute(payment, {
      amount: body.Amount,
      reasonCode: body.ReasonCode || '4853',
      comment: body.Comment || '',
      ...options,
    });
  }

  let dispute = body.DisputeId ? state.disputes[String(body.DisputeId)] : null;
  if (!dispute) {
    const payment = findPaymentByRef(body);
    if (payment && payment.disputeId) dispute = state.disputes[payment.disputeId];
  }
  if (!dispute) return err(8, 'Спор (DisputeId) не найден');
  return transitionDispute(dispute, action, body, options);
}

/* -------------------------------------- acqapi OAuth + регистрация партнёров */

/**
 * F-26: до 0.5.0 `/oauth/token` проверял только префикс `Basic `, bearer-токен
 * собирался из виртуального времени (предсказуем) и нигде не валидировался, а
 * GET/PATCH регистрации были доступны анонимно. Здесь — честная модель:
 *   • Basic-креды клиента сверяются с MOCK_ACQAPI_CLIENT_ID/SECRET (дефолт
 *     эталона — `partner:partner`, docs/reference/tbank/03-payouts-and-deals.md);
 *   • выдаётся opaque-токен (crypto random), в state лежит только его SHA-256
 *     с scope и TTL, поэтому токен не течёт через /mock/state и журнал;
 *   • каждая операция регистрации требует действующий bearer со scope partner.
 * TTL по умолчанию 1 час (как `expires_in: 3600` в эталоне), переопределяется
 * MOCK_ACQAPI_TOKEN_TTL_MS; отсчёт — по виртуальным часам, поэтому истечение
 * проверяется через POST /mock/time без ожидания.
 */
const ACQAPI_CLIENT_ID = String(process.env.MOCK_ACQAPI_CLIENT_ID || '').trim() || 'partner';
const ACQAPI_CLIENT_SECRET = String(process.env.MOCK_ACQAPI_CLIENT_SECRET || '').trim() || 'partner';
const ACQAPI_TOKEN_TTL_MS = parseMsOr(process.env.MOCK_ACQAPI_TOKEN_TTL_MS, 60 * 60 * 1000);
const ACQAPI_SCOPE = 'partner';
const ACQAPI_GRANT_TYPES = ['password', 'client_credentials'];

/** Разбор `Authorization: Basic ...` без привязки к регистру схемы. */
function parseBasicAuth(header) {
  const m = /^basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(String(header || '').trim());
  if (!m) return null;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return null;
  return { clientId: decoded.slice(0, sep), clientSecret: decoded.slice(sep + 1) };
}

/** Разбор `Authorization: Bearer ...` без привязки к регистру схемы. */
function parseBearerAuth(header) {
  const m = /^bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(String(header || '').trim());
  return m ? m[1] : null;
}

/** Старый state-файл может не знать о новой коллекции acqTokens. */
function acqapiTokenStore() {
  if (!isRecord(state.acqTokens)) state.acqTokens = Object.create(null);
  return state.acqTokens;
}

/** Выпуск opaque-токена: в state — только хэш, scope и TTL (F-26). */
function issueAcqapiToken() {
  const raw = core.randomToken(32);
  const issuedAtMs = clock.now();
  acqapiTokenStore()[core.hashSecret(raw)] = {
    scope: ACQAPI_SCOPE,
    issuedAtMs,
    expiresAtMs: issuedAtMs + ACQAPI_TOKEN_TTL_MS,
  };
  persist();
  return {
    access_token: raw,
    token_type: 'Bearer',
    expires_in: Math.max(1, Math.round(ACQAPI_TOKEN_TTL_MS / 1000)),
    scope: ACQAPI_SCOPE,
  };
}

/**
 * Проверка bearer-токена на каждой защищённой операции: наличие, срок жизни
 * (виртуальные часы), scope. Возвращает OAuth-shaped описание отказа или null.
 */
function checkAcqapiBearer(req, { scope = ACQAPI_SCOPE } = {}) {
  const raw = parseBearerAuth(req.headers && req.headers.authorization);
  if (!raw) {
    return { error: 'invalid_token', message: 'Требуется заголовок Authorization: Bearer <access_token> — получите токен в POST /oauth/token (Basic client credentials)' };
  }
  const hash = core.hashSecret(raw);
  const rec = acqapiTokenStore()[hash];
  if (!rec) {
    return { error: 'invalid_token', message: 'Bearer-токен неизвестен стенду: получите новый в POST /oauth/token (старые токены не переживают reset/перезапуск стенда)' };
  }
  const nowMs = clock.now();
  if (!Number.isFinite(rec.expiresAtMs) || rec.expiresAtMs <= nowMs) {
    return {
      error: 'invalid_token',
      message: `Bearer-токен истёк (TTL ${Math.round(ACQAPI_TOKEN_TTL_MS / 1000)} с) — получите новый в POST /oauth/token`,
      expires_at: rec.expiresAtMs,
    };
  }
  if (scope && rec.scope !== scope) {
    return { error: 'insufficient_scope', message: `Токену выдан scope «${rec.scope}», для этой операции нужен «${scope}»` };
  }
  return null;
}

function sendAcqapiAuthError(res, authError) {
  return sendJson(res, { error: authError.error, message: authError.message, ...(authError.expires_at !== undefined ? { expires_at: authError.expires_at } : {}) }, 401);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value, field, { maxLength = 0, pattern, patternHint = '' } = {}) {
  if (typeof value !== 'string' || !value.trim()) return { field, message: `${field} обязателен и должен быть непустой строкой` };
  const text = value.trim();
  if (maxLength && text.length > maxLength) return { field, message: `${field} длиннее допустимого максимума ${maxLength} символов` };
  if (pattern && !pattern.test(text)) return { field, message: `${field} имеет недопустимый формат${patternHint ? `: ${patternHint}` : ''}` };
  return null;
}

function validateAcqapiAddress(address, index) {
  const prefix = `addresses[${index}]`;
  if (!isRecord(address)) return { field: prefix, message: `${prefix} должен быть объектом` };
  const type = address.type || address.addressType || address.kind;
  let problem = requiredText(type, `${prefix}.type`, { pattern: /^(legal|actual|mailing|registration|other)$/i, patternHint: 'legal, actual, mailing, registration или other' });
  if (problem) return problem;
  problem = requiredText(address.zip, `${prefix}.zip`, { pattern: /^\d{6}$/, patternHint: 'шесть цифр индекса' });
  if (problem) return problem;
  problem = requiredText(address.country, `${prefix}.country`, { pattern: /^[A-Za-z]{3}$/, patternHint: 'ISO-3, например RUS' });
  if (problem) return problem;
  for (const field of ['city', 'street']) {
    problem = requiredText(address[field], `${prefix}.${field}`, { maxLength: 255 });
    if (problem) return problem;
  }
  return null;
}

function validateAcqapiBankAccount(account, field = 'bankAccount') {
  if (!isRecord(account)) return { field, message: `${field} обязателен и должен быть объектом` };
  const fields = [
    ['account', /^\d{20}$/, '20 цифр расчётного счёта'],
    ['korAccount', /^\d{20}$/, '20 цифр корреспондентского счёта'],
    ['bankName', null, 'название банка'],
    ['bik', /^\d{9}$/, '9 цифр БИК'],
    ['details', null, 'шаблон назначения платежа'],
  ];
  for (const [name, pattern, hint] of fields) {
    const problem = requiredText(account[name], `${field}.${name}`, { pattern, patternHint: hint });
    if (problem) return problem;
  }
  const hasKbk = account.kbk !== undefined && account.kbk !== null && account.kbk !== '';
  const hasOktmo = account.oktmo !== undefined && account.oktmo !== null && account.oktmo !== '';
  if (hasKbk !== hasOktmo) {
    return { field: `${field}.kbk|${field}.oktmo`, message: `${field}.kbk и ${field}.oktmo передаются парой` };
  }
  if (hasKbk) {
    const kbk = requiredText(String(account.kbk), `${field}.kbk`, { pattern: /^\d{20}$/, patternHint: '20 цифр КБК' });
    if (kbk) return kbk;
    const oktmo = requiredText(String(account.oktmo), `${field}.oktmo`, { pattern: /^\d{8,11}$/, patternHint: '8–11 цифр ОКТМО' });
    if (oktmo) return oktmo;
  }
  return null;
}

/**
 * Контрактная схема POST /sm-register/register (F-27). Схема намеренно
 * проверяется до выделения shopCode/квоты и до записи state: частичная заявка
 * не создаёт «магазин», который потом нельзя отличить от полноценного.
 */
function validateAcqapiRegistration(body) {
  if (!isRecord(body)) return { field: 'body', message: 'Тело регистрации должно быть JSON-объектом' };
  const textFields = [
    ['shopArticleId', { maxLength: 32, pattern: /^[A-Za-z0-9_.-]+$/, patternHint: 'латиница, цифры, точка, дефис, подчёркивание' }],
    ['billingDescriptor', { maxLength: 14, pattern: /^[A-Za-z0-9._ -]+$/, patternHint: 'латиница, цифры, точка, пробел, дефис, подчёркивание' }],
    ['fullName', { maxLength: 255, pattern: /[А-Яа-яЁё]/, patternHint: 'наименование с кириллическими буквами' }],
    ['name', { maxLength: 255, pattern: /[А-Яа-яЁё]/, patternHint: 'наименование с кириллическими буквами и ОПФ' }],
    ['email', { maxLength: 254, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternHint: 'email' }],
    ['siteUrl', { maxLength: 2048, pattern: /^https?:\/\/[^\s/$.?#].[^\s]*$/i, patternHint: 'URL с http:// или https://' }],
  ];
  for (const [field, options] of textFields) {
    const problem = requiredText(body[field], field, options);
    if (problem) return problem;
  }
  let problem = requiredText(body.inn, 'inn', { pattern: /^\d{10}(?:\d{2})?$/, patternHint: '10 или 12 цифр' });
  if (problem) return problem;
  // В эталонной фикстуре для точки без КПП используется «00000000»; реальные
  // российские КПП имеют 9 цифр, поэтому принимаем обе документированные формы.
  problem = requiredText(body.kpp, 'kpp', { pattern: /^\d{8,9}$/, patternHint: '8 или 9 цифр' });
  if (problem) return problem;
  problem = requiredText(body.ogrn, 'ogrn', { pattern: /^\d{13}(?:\d{2})?$/, patternHint: '13 или 15 цифр' });
  if (problem) return problem;

  if (!Array.isArray(body.addresses) || body.addresses.length === 0) {
    return { field: 'addresses', message: 'addresses обязателен: передайте хотя бы legal/actual-адрес' };
  }
  for (let index = 0; index < body.addresses.length; index += 1) {
    problem = validateAcqapiAddress(body.addresses[index], index);
    if (problem) return problem;
  }

  if (!isRecord(body.ceo)) return { field: 'ceo', message: 'ceo обязателен и должен быть объектом' };
  problem = requiredText(body.ceo.phone, 'ceo.phone', { pattern: /^\+?[0-9 ()-]{7,32}$/, patternHint: 'телефон' });
  if (problem) return problem;
  problem = requiredText(body.ceo.citizenship, 'ceo.citizenship', { maxLength: 64 });
  if (problem) return problem;

  if (!isRecord(body.founders) || !Array.isArray(body.founders.individuals) || body.founders.individuals.length === 0) {
    return { field: 'founders.individuals', message: 'founders.individuals обязателен и должен содержать хотя бы одного учредителя' };
  }
  for (let index = 0; index < body.founders.individuals.length; index += 1) {
    if (!isRecord(body.founders.individuals[index])) {
      return { field: `founders.individuals[${index}]`, message: `founders.individuals[${index}] должен быть объектом` };
    }
  }

  problem = validateAcqapiBankAccount(body.bankAccount);
  if (problem) return problem;
  if (body.mcc !== undefined && body.mcc !== null && body.mcc !== '') {
    problem = requiredText(String(body.mcc), 'mcc', { pattern: /^\d{4}$/, patternHint: '4 цифры MCC' });
    if (problem) return problem;
  }
  if (typeof body.nonResident !== 'boolean') {
    return { field: 'nonResident', message: 'nonResident обязателен и должен быть boolean (для этой фикстуры false)' };
  }
  return null;
}

/* ------------------------------------------------------------- API logic */

function checkTerminalKey(body) {
  return body && body.TerminalKey === terminalKey()
    ? null
    : err(7, `TerminalKey «${body && body.TerminalKey}» не соответствует стенду (ожидается «${terminalKey()}»)`);
}

/**
 * Терминал выплат (F-17/F-22): точное совпадение с ключом стенда или с
 * PAYOUT-терминалом зарегистрированной точки (`sm-register` отдаёт `${terminalKey()}E2C`).
 * Проверяется до поиска и мутации выплаты, чтобы подписанный запрос с чужим
 * TerminalKey не проходил по чужому телу.
 */
function checkE2cTerminalKey(body) {
  const given = body && body.TerminalKey;
  if (given === terminalKey() || given === e2cTerminalKey()) return null;
  return err(7, `TerminalKey «${given}» не соответствует стенду (ожидается «${terminalKey()}» или PAYOUT-терминал «${e2cTerminalKey()}»)`, null, {
    field: 'TerminalKey',
    doc: PAYOUT_REF_DOC,
  });
}

/**
 * Валидация RedirectDueDate (F-25, дока Init): срок жизни ссылки/QR — от 1 минуты
 * до 90 дней, формат ISO 8601. Границы включительные: ровно nowMs+1m и ровно
 * nowMs+90d допустимы. Возвращает текст ошибки или null.
 */
function validateRedirectDueDate(value, nowMs) {
  const dueTs = Date.parse(String(value));
  if (!Number.isFinite(dueTs)) {
    return `Некорректный формат RedirectDueDate «${value}» (ожидается ISO 8601)`;
  }
  if (dueTs <= nowMs) {
    return 'RedirectDueDate уже истёк — дата должна быть в будущем';
  }
  if (dueTs < nowMs + 60 * 1000) {
    return 'RedirectDueDate не может быть раньше чем через 1 минуту (минимальный срок жизни ссылки — 1 минута)';
  }
  if (dueTs > nowMs + 90 * 24 * 60 * 60 * 1000) {
    return 'RedirectDueDate превышает максимальный срок жизни ссылки 90 дней';
  }
  return null;
}

function handleInit(body, reqHeaders = {}) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  // F-24: строгий разбор суммы до любых проверок уникальности OrderId —
  // невалидный Amount не должен ни создавать платёж, ни «съедать» OrderId.
  const money = core.parseMoneyKopeks(body.Amount, { field: 'Amount' });
  if (!money.ok) {
    return err(7, `Обязательные параметры не заполнены или невалидны (Amount, OrderId): ${money.message}`, null, { field: 'Amount' });
  }
  const amount = money.value;
  if (!body.OrderId) {
    return err(7, 'Обязательные параметры не заполнены или невалидны (Amount, OrderId): OrderId обязателен', null, { field: 'OrderId' });
  }
  if (!ALLOW_DUPLICATE_ORDER_ID) {
    const existing = paymentsOfOrder(body.OrderId).find((p) => p.orderId === String(body.OrderId));
    if (existing) {
      return err(7, `OrderId «${body.OrderId}» уже использован (PaymentId=${existing.paymentId}, статус ${existing.status})`);
    }
  }

  // Валидация ограничений блока DATA по официальной доке Init (≤ 20 пар, ключ ≤ 20, значение ≤ 100)
  if (body.DATA && typeof body.DATA === 'object' && !Array.isArray(body.DATA)) {
    const entries = Object.entries(body.DATA);
    if (entries.length > 20) {
      return err(7, `Блок DATA содержит ${entries.length} пар (максимум 20 пар по документации Init)`, null, { field: 'DATA', doc: '/api/init' });
    }
    for (const [k, v] of entries) {
      if (String(k).length > 20) {
        return err(7, `Ключ DATA «${k}» длиннее 20 символов`, null, { field: `DATA.${k}`, doc: '/api/init' });
      }
      if (v !== null && v !== undefined && String(v).length > 100) {
        return err(7, `Значение DATA.${k} длиннее 100 символов`, null, { field: `DATA.${k}`, doc: '/api/init' });
      }
    }
  }

  // Валидация RedirectDueDate (1 минута ... 90 дней по доке Init, F-25: обе границы)
  if (body.RedirectDueDate !== undefined && body.RedirectDueDate !== null && body.RedirectDueDate !== '') {
    const dueError = validateRedirectDueDate(body.RedirectDueDate, clock.now());
    if (dueError) {
      return err(7, dueError, null, { field: 'RedirectDueDate', doc: '/api/init' });
    }
  }

  // Для рекуррентного платежа (Recurrent=Y) обязателен CustomerKey (или телефон/email в DATA)
  const isRecurrent = String(body.Recurrent || '').toUpperCase() === 'Y';
  if (isRecurrent && !body.CustomerKey && !(body.DATA && (body.DATA.Phone || body.DATA.Email))) {
    return err(7, 'Для рекуррентного платежа (Recurrent=Y) обязателен параметр CustomerKey (или DATA.Phone / DATA.Email)', null, { field: 'CustomerKey', doc: '/api/init' });
  }

  // F-16: в профиле Мультирасчетов PaymentRecipientId обязателен — «идентификатор
  // будущего получателя выплаты», ≤16 символов (01-payment-api.md). Проверка идёт
  // до создания платежа/сделки; plain-профиль требования не знает и не меняется.
  const recipientRaw = textOrNull(body.PaymentRecipientId);
  if (PROFILE === 'multisplit') {
    if (!recipientRaw) {
      return err(7, 'Для профиля Мультирасчетов обязателен PaymentRecipientId — идентификатор будущего получателя выплаты (телефон/email/иной, до 16 символов)', null, {
        field: 'PaymentRecipientId',
        doc: '/api/init',
        hint: 'PaymentRecipientId передаётся в Init и связывает платёж с будущей выплатой получателю; без него банк отклоняет Init.',
      });
    }
    if (recipientRaw.length > 16) {
      return err(7, `PaymentRecipientId «${recipientRaw}» длиннее 16 символов`, null, {
        field: 'PaymentRecipientId',
        doc: '/api/init',
      });
    }
  }

  let dealId = null;
  const createDeal = String(body.CreateDealWithType || '').toUpperCase() === 'NN';
  if (PROFILE === 'plain' && !body.DealId && !createDeal) {
    // plain-профиль: платёж без сделки
  } else if (body.DealId) {
    const deal = findDeal(body.DealId);
    if (!deal || deal.status === 'closed') {
      return err(7, 'Сделка не найдена или закрыта', `DealId=${body.DealId}`);
    }
    dealId = deal.id;
  } else if (createDeal) {
    dealId = String(state.counters.dealId++);
    const quotaDeal = ensureSandboxQuota();
    if (quotaDeal) return quotaDeal;
    state.deals[dealId] = { id: dealId, type: 'NN', status: 'open', createdAt: clock.iso(), createdAtMs: clock.now() };
  } else if (body.PaymentRecipientId) {
    return err(7, 'Не переданы DealId или CreateDealWithType=NN');
  }

  const paymentId = String(state.counters.paymentId++);
  const nowIso = clock.iso();
  const payment = {
    paymentId,
    orderId: String(body.OrderId),
    amount,
    status: 'NEW',
    statusHistory: [{ status: 'NEW', at: nowIso }],
    createdAt: nowIso,
    createdAtMs: clock.now(),
    dealId,
    recipientId: recipientRaw,
    customerKey: body.CustomerKey || null,
    recurrent: isRecurrent,
    rebillId: null,
    payType: String(body.PayType || 'T').toUpperCase() === 'O' ? 'O' : 'T',
    notificationUrl: body.NotificationURL || null,
    successUrl: body.SuccessURL || null,
    failUrl: body.FailURL || null,
    redirectDueDate: body.RedirectDueDate ? String(body.RedirectDueDate) : null,
    panMask: null,
    expDate: null,
    cardId: null,
    confirmedAmount: null,
    remaining: null,
    failCode: null,
    failMessage: null,
    otpAttempts: 0,
    disputeId: null,
    disputeStatus: null,
    suppressWebhooks: false,
    duplicateWebhooks: false,
    chargebackAfterMs: null,
    scheduledChargebackAt: null,
    customAutoConfirmMs: null,
    partialRefundSpec: null,
    closingReceipt: null,
  };

  const spec = scenarios.resolve({
    header: reqHeaders['x-mock-scenario'] || '',
    bodyScenario: (body.DATA && body.DATA.mock_scenario) || body.MockScenario || '',
    target: 'init',
    context: { orderId: payment.orderId, paymentId },
  });
  applyScenarioToPayment(payment, spec);

  const quotaPayment = ensureSandboxQuota();
  if (quotaPayment) return quotaPayment;
  state.payments[paymentId] = payment;
  indexPayment(state, payment);
  persist();

  // Браузерная форма — capability-ссылка: в owned-режиме добавляем селектор
  // песочницы, чтобы открытая страница оплаты не попала в другой контекст.
  const sandboxSelector = sandboxRuntime.currentId() === 'default' ? '' : `?sandbox=${encodeURIComponent(sandboxRuntime.currentId())}`;
  const paymentUrl = `${MOCK_PUBLIC_BASE_URL.replace(/\/$/, '')}/payment/${paymentId}${sandboxSelector}`;
  return {
    Success: true,
    ErrorCode: '0',
    Message: 'OK',
    TerminalKey: terminalKey(),
    OrderId: payment.orderId,
    PaymentId: paymentId,
    Amount: amount,
    Status: 'NEW',
    PaymentURL: paymentUrl,
  };
}

function handleGetState(body) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  let payment = body.PaymentId ? state.payments[String(body.PaymentId)] : null;
  if (!payment && body.OrderId) {
    const found = paymentsOfOrder(body.OrderId)
      .sort((a, b) => String(b.paymentId).localeCompare(String(a.paymentId)));
    if (found.length > 1) {
      return err(
        7,
        `По OrderId «${body.OrderId}» найдено платежей: ${found.length}; передайте PaymentId`,
        `PaymentIds: ${found.map((p) => p.paymentId).join(', ')}`,
      );
    }
    payment = found[0];
  }
  if (!payment) return err(8, 'Платёж не найден (ни по PaymentId, ни по OrderId)');
  return baseResponse(payment);
}

function handleCheckOrder(body) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const payments = paymentsOfOrder(body.OrderId);
  if (!payments.length) return err(8, 'Заказ не найден');
  return {
    Success: true,
    ErrorCode: '0',
    TerminalKey: terminalKey(),
    OrderId: String(body.OrderId),
    Payments: payments.map((p) => ({
      PaymentId: p.paymentId,
      Amount: currentAmount(p),
      Status: p.status,
      RRN: String(p.paymentId).slice(-12).padStart(12, '0'),
      Success: !['REJECTED', 'AUTH_FAIL', 'CANCELED', 'DEADLINE_EXPIRED'].includes(p.status),
      ErrorCode: p.status === 'REJECTED' ? String(p.failCode || '9999') : '0',
      Message: p.status === 'REJECTED' ? String(p.failMessage || 'Ошибка') : 'ok',
    })),
  };
}

function finalizeConfirm(payment, amount, options = {}) {
  setStatus(payment, 'CONFIRMING');
  payment.confirmedAmount = amount;
  payment.remaining = amount;
  setStatus(payment, 'CONFIRMED');
  if (payment.chargebackAfterMs !== null && payment.chargebackAfterMs !== undefined) {
    payment.scheduledChargebackAt = clock.now() + payment.chargebackAfterMs;
  }
  persist();
  scheduleNotification(payment, 'CONFIRMED', {}, options);
}

function handleConfirm(body, reqHeaders = {}) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const payment = state.payments[String(body.PaymentId)];
  if (!payment) return err(8, 'PaymentId не найден');
  if (payment.status !== 'AUTHORIZED') {
    return { ...err(32, `Подтверждение доступно только из статуса AUTHORIZED, сейчас ${payment.status}`), PaymentId: payment.paymentId, OrderId: payment.orderId };
  }
  let amount = payment.amount;
  if (body.Amount !== undefined && body.Amount !== null && body.Amount !== '') {
    // F-24: строгий разбор суммы подтверждения (частичный Confirm).
    const money = core.parseMoneyKopeks(body.Amount, { field: 'Amount' });
    if (!money.ok) {
      return { ...err(7, `Некорректная сумма подтверждения: ${money.message}`, null, { field: 'Amount' }), PaymentId: payment.paymentId };
    }
    amount = money.value;
    if (amount > payment.amount) {
      return { ...err(7, 'Сумма подтверждения больше суммы авторизации'), PaymentId: payment.paymentId };
    }
  }

  const spec = scenarios.resolve({
    header: reqHeaders['x-mock-scenario'] || '',
    bodyScenario: (body.DATA && body.DATA.mock_scenario) || body.MockScenario || '',
    target: 'confirm',
    context: { paymentId: payment.paymentId, orderId: payment.orderId },
  });
  applyScenarioToPayment(payment, spec);

  finalizeConfirm(payment, amount, {
    suppress: spec.has('webhook-drop') || spec.has('no-webhook'),
    duplicate: spec.has('webhook-duplicate'),
  });
  return baseResponse(payment);
}

function handleCancel(body, reqHeaders = {}) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const payment = state.payments[String(body.PaymentId)];
  if (!payment) return err(8, 'PaymentId не найден');

  // Правило Мультирасчетов (03-payouts-and-deals.md §Сделка): возврат покупателю
  // после закрытия сделки запрещён банком.
  if (payment.dealId && state.deals[payment.dealId] && state.deals[payment.dealId].status === 'closed') {
    return {
      ...err(
        32,
        `Возврат по платежу ${payment.paymentId} запрещён: сделка ${payment.dealId} уже закрыта`,
        `DealId=${payment.dealId}`,
        { field: 'PaymentId', hint: 'В Мультирасчетах после FinalPayout=true или closeSpDeal возврат покупателю по сделке невозможен.' },
      ),
      PaymentId: payment.paymentId,
      OrderId: payment.orderId,
    };
  }

  const externalId = body.ExternalRequestId ? String(body.ExternalRequestId) : null;
  if (externalId && state.externalRequests[externalId]) {
    return { ...baseResponse(payment), OriginalAmount: currentAmount(payment), NewAmount: currentAmount(payment), ExternalRequestId: externalId };
  }

  const spec = scenarios.resolve({
    header: reqHeaders['x-mock-scenario'] || '',
    bodyScenario: (body.DATA && body.DATA.mock_scenario) || body.MockScenario || '',
    target: 'cancel',
    context: { paymentId: payment.paymentId, orderId: payment.orderId },
  });
  applyScenarioToPayment(payment, spec);

  const before = payment.status;
  const originalAmount = currentAmount(payment);
  let cancelAmount = originalAmount;
  if (before !== 'NEW' && body.Amount !== undefined && body.Amount !== null && body.Amount !== '') {
    // F-24: строгий разбор суммы возврата/отмены — без «1000xyz» и дробей.
    const money = core.parseMoneyKopeks(body.Amount, { field: 'Amount' });
    if (!money.ok) {
      return { ...err(7, `Некорректная сумма отмены: ${money.message}`, null, { field: 'Amount' }), PaymentId: payment.paymentId, OrderId: payment.orderId };
    }
    const a = money.value;
    if (a > originalAmount) {
      return {
        ...err(7, `Сумма отмены ${a} больше доступной суммы ${originalAmount}`),
        PaymentId: payment.paymentId,
        OrderId: payment.orderId,
        OriginalAmount: originalAmount,
      };
    }
    cancelAmount = a;
  } else if (before !== 'NEW' && (spec.has('partial-refund') || payment.partialRefundSpec)) {
    // Сценарий «возврат частичный» (этап 7, бриф §3.2): если Amount не передан,
    // но активен сценарий partial-refund, удерживаем/возвращаем долю от суммы.
    cancelAmount = resolvePartialAmount(spec.get('partial-refund') || payment.partialRefundSpec, originalAmount);
  }
  const partial = cancelAmount < originalAmount;

  const transitions = {
    NEW: ['CANCELED', null],
    AUTHORIZED: [partial ? 'PARTIAL_REVERSED' : 'REVERSED', partial ? 'PARTIAL_REVERSED' : 'REVERSED'],
    PARTIAL_REVERSED: [partial ? 'PARTIAL_REVERSED' : 'REVERSED', partial ? 'PARTIAL_REVERSED' : 'REVERSED'],
    CONFIRMED: [partial ? 'PARTIAL_REFUNDED' : 'REFUNDED', partial ? 'PARTIAL_REFUNDED' : 'REFUNDED'],
    PARTIAL_REFUNDED: [partial ? 'PARTIAL_REFUNDED' : 'REFUNDED', partial ? 'PARTIAL_REFUNDED' : 'REFUNDED'],
  };
  const t = transitions[before];
  if (!t) {
    return { ...err(32, `Отмена недоступна из статуса ${before}`), PaymentId: payment.paymentId, OrderId: payment.orderId };
  }
  if (before === 'NEW') {
    setStatus(payment, 'CANCELED'); // no notification per the contract
    payment.remaining = 0;
    persist();
    return { ...baseResponse(payment), OriginalAmount: payment.amount, NewAmount: 0 };
  }
  setStatus(payment, t[0]);
  payment.remaining = originalAmount - cancelAmount;
  persist();
  scheduleNotification(payment, t[1], {}, {
    suppress: spec.has('webhook-drop') || spec.has('no-webhook'),
    duplicate: spec.has('webhook-duplicate'),
  });
  if (externalId) state.externalRequests[externalId] = { paymentId: payment.paymentId, status: payment.status };
  return { ...baseResponse(payment), OriginalAmount: originalAmount, NewAmount: currentAmount(payment), ExternalRequestId: externalId || undefined };
}

function handleCreateSpDeal(body) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const dealType = String(body.SpDealType || 'NN').toUpperCase();
  if (dealType !== 'NN') {
    return err(7, `Неподдерживаемый тип сделки SpDealType=«${body.SpDealType}» (ожидается NN)`, null, { field: 'SpDealType' });
  }
  const dealId = String(state.counters.dealId++);
  const quotaDeal = ensureSandboxQuota();
  if (quotaDeal) return quotaDeal;
  state.deals[dealId] = {
    id: dealId,
    type: 'NN',
    status: 'open',
    createdAt: clock.iso(),
    createdAtMs: clock.now(),
  };
  persist();
  return {
    Success: true,
    ErrorCode: '0',
    TerminalKey: terminalKey(),
    SpAccumulationId: dealId,
  };
}

function handleCloseSpDeal(body) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const dealId = String(body.SpAccumulationId || body.DealId || '');
  const deal = findDeal(dealId);
  if (!deal) return err(8, `Сделка «${dealId}» не найдена`, null, { field: 'SpAccumulationId' });
  if (deal.status === 'closed') {
    return err(32, `Сделка «${dealId}» уже закрыта (повторное закрытие запрещено банком)`, null, { field: 'SpAccumulationId' });
  }
  const reward = dealBalance(deal);
  deal.status = 'closed';
  deal.closedAt = clock.iso();
  deal.platformReward = reward;
  persist();
  return {
    Success: true,
    ErrorCode: '0',
    TerminalKey: terminalKey(),
    SpAccumulationId: deal.id,
    Status: 'CLOSED',
    PlatformReward: reward,
  };
}

function handleGetQr(body) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const payment = state.payments[String(body.PaymentId || '')];
  if (!payment) return err(8, 'PaymentId не найден');
  if (!['NEW', 'FORM_SHOWED'].includes(payment.status)) {
    return err(32, `Генерация QR СБП доступна только в статусе NEW/FORM_SHOWED, сейчас ${payment.status}`);
  }
  // Дока Т-Банка (01-payment-api.md): минимальная сумма операции СБП — 10 ₽ (1000 коп.)
  if (payment.amount < 1000) {
    return err(
      7,
      `Сумма платежа ${payment.amount} коп. меньше минимальной суммы операции СБП (1000 коп. = 10,00 ₽)`,
      `Amount=${payment.amount}`,
      { field: 'Amount', doc: '/api/init' },
    );
  }
  const dataType = String(body.DataType || 'PAYLOAD').toUpperCase();
  if (!['PAYLOAD', 'IMAGE'].includes(dataType)) {
    return err(7, `DataType «${body.DataType}» не поддерживается (ожидается PAYLOAD или IMAGE)`, null, { field: 'DataType' });
  }
  const qrPayload = `https://qr.nspk.ru/AD1000${payment.paymentId}?type=02&bank=100000000004&sum=${payment.amount}&cur=RUB&crc=AB12`;
  const data = dataType === 'IMAGE'
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#fff"/><text x="10" y="60" font-size="10">SBP:${payment.paymentId}</text></svg>`
    : qrPayload;
  payment.qrData = qrPayload;
  persist();
  return {
    Success: true,
    ErrorCode: '0',
    Message: 'OK',
    TerminalKey: terminalKey(),
    OrderId: payment.orderId,
    PaymentId: payment.paymentId,
    Data: data,
    RequestKey: `QR-${payment.paymentId}`,
  };
}

function handleCharge(body, reqHeaders = {}) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const payment = state.payments[String(body.PaymentId || '')];
  if (!payment) return err(8, 'PaymentId не найден');
  if (payment.status !== 'NEW') {
    return err(32, `Метод Charge доступен только для платежа в статусе NEW, сейчас ${payment.status}`);
  }
  const rebillId = String(body.RebillId || '');
  if (!rebillId) return err(7, 'Передайте RebillId для рекуррентного списания', null, { field: 'RebillId' });
  const card = Object.values(state.cards || {}).find((c) => c.rebillId === rebillId && c.status === 'A');
  if (!card) {
    return err(8, `Активная карта с RebillId=«${rebillId}» не найдена (привяжите карту через Init с Recurrent=Y или AddCard)`, null, { field: 'RebillId' });
  }
  payment.cardId = card.cardId;
  payment.panMask = card.panMask;
  payment.expDate = card.expDate;
  payment.rebillId = rebillId;
  payment.confirmedAmount = payment.amount;
  payment.remaining = payment.amount;
  setStatus(payment, 'CONFIRMED');
  persist();
  const spec = scenarios.resolve({
    header: reqHeaders['x-mock-scenario'] || '',
    target: 'charge',
    context: { paymentId: payment.paymentId, orderId: payment.orderId },
  });
  scheduleNotification(payment, 'CONFIRMED', { RebillId: rebillId }, {
    suppress: spec.has('webhook-drop') || spec.has('no-webhook'),
    duplicate: spec.has('webhook-duplicate'),
  });
  return {
    ...baseResponse(payment),
    RebillId: rebillId,
  };
}

function handleSendClosingReceipt(body) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const payment = state.payments[String(body.PaymentId || '')];
  if (!payment) return err(8, 'PaymentId не найден');
  if (!['CONFIRMED', 'PARTIAL_REFUNDED'].includes(payment.status)) {
    return err(32, `Отправка закрывающего чека доступна только для подтверждённого платежа (CONFIRMED), сейчас ${payment.status}`);
  }
  if (!body.Receipt || typeof body.Receipt !== 'object' || !Array.isArray(body.Receipt.Items) || !body.Receipt.Items.length) {
    return err(7, 'Передайте объект Receipt с непустым массивом Items (ФФД 1.2)', null, { field: 'Receipt.Items' });
  }
  payment.closingReceipt = body.Receipt;
  persist();
  return {
    Success: true,
    ErrorCode: '0',
    Message: 'OK',
    TerminalKey: terminalKey(),
    PaymentId: payment.paymentId,
  };
}

function handleAddCustomer(body) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const customerKey = String(body.CustomerKey || '').trim();
  if (!customerKey) return err(7, 'Обязательный параметр CustomerKey не заполнен', null, { field: 'CustomerKey' });
  const quotaCustomer = ensureSandboxQuota();
  if (quotaCustomer) return quotaCustomer;
  state.customers[customerKey] = {
    customerKey,
    email: body.Email || null,
    phone: body.Phone || null,
    createdAt: clock.iso(),
  };
  persist();
  return { Success: true, ErrorCode: '0', TerminalKey: terminalKey(), CustomerKey: customerKey };
}

function handleGetCustomer(body) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const customerKey = String(body.CustomerKey || '').trim();
  const cust = state.customers[customerKey];
  if (!cust) return err(8, `Покупатель CustomerKey=«${customerKey}» не найден`, null, { field: 'CustomerKey' });
  return {
    Success: true,
    ErrorCode: '0',
    TerminalKey: terminalKey(),
    CustomerKey: cust.customerKey,
    Email: cust.email || undefined,
    Phone: cust.phone || undefined,
  };
}

function handleRemoveCustomer(body) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const customerKey = String(body.CustomerKey || '').trim();
  if (!state.customers[customerKey]) return err(8, `Покупатель CustomerKey=«${customerKey}» не найден`);
  delete state.customers[customerKey];
  for (const [cid, c] of Object.entries(state.cards || {})) {
    if (c.customerKey === customerKey) delete state.cards[cid];
  }
  persist();
  return { Success: true, ErrorCode: '0', TerminalKey: terminalKey(), CustomerKey: customerKey };
}

function handleAddCard(body) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const customerKey = String(body.CustomerKey || '').trim();
  if (!customerKey) return err(7, 'Обязательный параметр CustomerKey не заполнен', null, { field: 'CustomerKey' });
  if (!state.customers[customerKey]) {
    state.customers[customerKey] = { customerKey, createdAt: clock.iso() };
  }
  const cardId = String(state.counters.cardId++);
  const rebillId = `REB-${cardId}`;
  const quotaCard = ensureSandboxQuota();
  if (quotaCard) return quotaCard;
  state.cards[cardId] = {
    cardId,
    customerKey,
    panMask: '220138**0013',
    expDate: '1227',
    rebillId,
    status: 'A',
    createdAt: clock.iso(),
  };
  persist();
  return {
    Success: true,
    ErrorCode: '0',
    TerminalKey: terminalKey(),
    CustomerKey: customerKey,
    RequestKey: `REQ-${cardId}`,
    CardId: cardId,
    RebillId: rebillId,
    PaymentURL: `${MOCK_PUBLIC_BASE_URL.replace(/\/$/, '')}/add-card/${cardId}`,
  };
}

function handleGetCardList(body) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const customerKey = String(body.CustomerKey || '').trim();
  if (!customerKey) return err(7, 'Обязательный параметр CustomerKey не заполнен', null, { field: 'CustomerKey' });
  const list = Object.values(state.cards || {})
    .filter((c) => c.customerKey === customerKey && c.status !== 'D')
    .map((c) => ({
      CardId: c.cardId,
      Pan: c.panMask,
      ExpDate: c.expDate,
      CardType: 0,
      Status: c.status,
      RebillId: c.rebillId,
    }));
  return list;
}

function handleRemoveCard(body) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const cardId = String(body.CardId || '');
  const card = state.cards[cardId];
  if (!card) return err(8, `Карта CardId=«${cardId}» не найдена`);
  card.status = 'D';
  persist();
  return {
    Success: true,
    ErrorCode: '0',
    TerminalKey: terminalKey(),
    CustomerKey: card.customerKey,
    CardId: card.cardId,
    Status: 'D',
    CardType: 0,
  };
}

/* -------------------------------------------------------- payment form UI */

function page(body, autoRefresh = false) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
${autoRefresh ? '<meta http-equiv="refresh" content="2">' : ''}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Т-Банк · Тестовая платёжная форма (мок)</title>
<style>
  body{font:16px/1.5 -apple-system,'Segoe UI',Roboto,sans-serif;background:#f4f4f6;margin:0;display:flex;justify-content:center;padding:32px 12px}
  .card{background:#fff;border-radius:16px;max-width:420px;width:100%;padding:24px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
  .logo{font-weight:800;color:#ffdd2d;background:#1a1a1a;display:inline-block;border-radius:8px;padding:2px 10px;margin-bottom:8px}
  h1{font-size:20px;margin:0 0 4px}
  .muted{color:#777;font-size:13px;margin-bottom:16px}
  .sum{font-size:28px;font-weight:700;margin-bottom:16px}
  label{display:block;font-size:13px;color:#555;margin:10px 0 4px}
  input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ddd;border-radius:10px;font-size:16px}
  .cards{display:flex;flex-direction:column;gap:6px;margin-bottom:8px}
  .cards label{display:flex;gap:8px;align-items:center;font-size:13px;color:#333;margin:0;cursor:pointer}
  button{width:100%;margin-top:14px;padding:13px;border:0;border-radius:12px;background:#ffdd2d;color:#111;font-weight:700;font-size:16px;cursor:pointer}
  button.gray{background:#ececee}
  .err{color:#c0392b;font-size:14px;margin-top:10px}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function formPage(payment, errorMsg) {
  const cardOptions = Object.entries(CARDS)
    .map(([pan, c]) => `<label><input type="radio" name="preset" value="${pan}" onchange="document.getElementById('pan').value='${pan}';document.getElementById('exp').value='1227';document.getElementById('cvv').value='123'"> ${c.label} <code>${maskPan(pan)}</code></label>`)
    .join('');
  return page(`
    <span class="logo">T · мок банка</span>
    <h1>Оплата заказа</h1>
    <div class="muted">Тестовый стенд Т-Банк · сессия ${payment.paymentId}</div>
    <div class="sum">${(payment.amount / 100).toFixed(2).replace('.', ',')} ₽</div>
    <div class="muted">Заказ: ${esc(payment.orderId)}${payment.dealId ? ` · сделка ${esc(payment.dealId)}` : ''} · PayType ${esc(payment.payType)}</div>
    ${errorMsg ? `<div class="err">${errorMsg}</div>` : ''}
    <form method="POST" action="/payment/${payment.paymentId}/pay">
      <div class="cards">${cardOptions}</div>
      <label>Номер карты</label><input type="text" id="pan" name="pan" value="2201382000000013" required>
      <label>Срок (MMYY)</label><input type="text" id="exp" name="exp" value="1227" required>
      <label>CVV</label><input type="password" id="cvv" name="cvv" value="123" required>
      <button type="submit">Оплатить ${(payment.amount / 100).toFixed(0)} ₽</button>
    </form>
    <form method="POST" action="/payment/${payment.paymentId}/reject"><button type="submit" class="gray">Отклонить покупателем</button></form>`);
}

function otpPage(payment, errorMsg) {
  return page(`
    <span class="logo">T · мок банка</span>
    <h1>Подтверждение 3-D Secure</h1>
    <div class="muted">Сессия ${payment.paymentId} · тестовый ACS, код <b>1qwezxc</b></div>
    ${errorMsg ? `<div class="err">${errorMsg} (осталось попыток: ${3 - payment.otpAttempts})</div>` : ''}
    <form method="POST" action="/payment/${payment.paymentId}/otp">
      <label>Одноразовый пароль</label><input type="password" name="code" autofocus required>
      <button type="submit">Подтвердить</button>
    </form>`);
}

function paymentPage(payment) {
  if (payment.status === '3DS_CHECKING') return otpPage(payment, null);
  return formPage(payment, null);
}

function redirectUrl(payment, kind) {
  const raw = kind === 'success' ? payment.successUrl : payment.failUrl;
  if (!raw) return `/payment/${payment.paymentId}/done?result=${kind}`;
  return raw.replace('{order_id}', encodeURIComponent(payment.orderId));
}

/* ------------------------------------------------------------- form logic */

function processPay(payment, pan, exp) {
  const due = payment.redirectDueDate ? Date.parse(payment.redirectDueDate) : null;
  if (due !== null && Number.isFinite(due) && due < clock.now()) {
    setStatus(payment, 'DEADLINE_EXPIRED');
    persist();
    return { status: 'DEADLINE_EXPIRED' };
  }
  const card = CARDS[pan] || { scenario: 'reject', code: '1236', message: 'Отклонено: мок проводит платежи только по тестовым картам (см. список на форме)' };
  payment.panMask = maskPan(pan);
  payment.expDate = exp || null;

  if (card.scenario === 'success') return authorize(payment);
  if (card.scenario === 'insufficient_over_1000') {
    return payment.amount > 100000
      ? reject(payment, '1051', 'Недостаточно средств на карте')
      : authorize(payment);
  }
  if (card.scenario === 'challenge') {
    setStatus(payment, '3DS_CHECKING');
    payment.otpAttempts = 0;
    persist();
    return { status: '3DS_CHECKING' };
  }
  return reject(payment, card.code, card.message);
}

function authorize(payment) {
  payment.cardId = String(state.counters.cardId++);
  let extra = {};
  if (payment.recurrent) {
    const rebillId = `REB-${payment.cardId}`;
    payment.rebillId = rebillId;
    extra = { RebillId: rebillId };
    if (payment.customerKey && !state.customers[payment.customerKey]) {
      state.customers[payment.customerKey] = { customerKey: payment.customerKey, createdAt: clock.iso() };
    }
    state.cards[payment.cardId] = {
      cardId: payment.cardId,
      customerKey: payment.customerKey || 'default',
      panMask: payment.panMask || '220138**0013',
      expDate: payment.expDate || '1227',
      rebillId,
      status: 'A',
      createdAt: clock.iso(),
    };
  }
  setStatus(payment, payment.payType === 'O' ? 'CONFIRMED' : 'AUTHORIZED');
  if (payment.payType === 'O') {
    payment.confirmedAmount = payment.amount;
    payment.remaining = payment.amount;
    if (payment.chargebackAfterMs !== null && payment.chargebackAfterMs !== undefined) {
      payment.scheduledChargebackAt = clock.now() + payment.chargebackAfterMs;
    }
  }
  persist();
  if (payment.payType === 'O') {
    if (payment.recurrent) {
      // По доке Рекуррентных платежей: RebillId возвращается в нотификации AUTHORIZED
      scheduleNotification(payment, 'AUTHORIZED', extra);
    }
    scheduleNotification(payment, 'CONFIRMED', extra);
  } else {
    scheduleNotification(payment, 'AUTHORIZED', extra);
  }
  return { status: payment.status };
}

function reject(payment, code, message) {
  payment.failCode = code;
  payment.failMessage = message;
  setStatus(payment, 'REJECTED');
  persist();
  scheduleNotification(payment, 'REJECTED');
  return { status: 'REJECTED' };
}

function processOtp(payment, code) {
  if (String(code) === '1qwezxc') return authorize(payment);
  payment.otpAttempts += 1;
  if (payment.otpAttempts >= 3) return reject(payment, '86', 'Не пройдена проверка 3-D Secure');
  persist();
  return { status: '3DS_CHECKING' };
}

/* ------------------------------------------------------ background ticker */

function tickBank() {
  const now = clock.now();
  const virtualShiftActive = (state.clockOffsetMs || 0) > 0;

  for (const payment of Object.values(state.payments)) {
    // 1. Запланированный чарджбэк по сценарию chargeback-after:Nd
    if (
      payment.scheduledChargebackAt
      && now >= payment.scheduledChargebackAt
      && ['CONFIRMED', 'PARTIAL_REFUNDED'].includes(payment.status)
    ) {
      payment.scheduledChargebackAt = null;
      openDispute(payment, { reasonCode: '4853', comment: 'Авто-чарджбэк по сценарию chargeback-after' });
      console.log(`[mock] scheduled chargeback triggered for payment ${payment.paymentId}`);
      continue;
    }

    // 2. Авто-закрытие 3DS_CHECKING старше 36 часов
    if (payment.status === '3DS_CHECKING') {
      const started = payment['3dsCheckingAtMs'] || Date.parse(payment.createdAt);
      if (Number.isFinite(started) && now - started >= TDS_TIMEOUT_VIRTUAL_MS) {
        setStatus(payment, 'DEADLINE_EXPIRED');
        persist();
        console.log(`[mock] 3DS session expired (>36h) for payment ${payment.paymentId}`);
        continue;
      }
    }

    // 3. Авто-отмена неоплаченного/незакрытого заказа через 60 дней (или по RedirectDueDate)
    if (['NEW', 'FORM_SHOWED'].includes(payment.status)) {
      const due = payment.redirectDueDate ? Date.parse(payment.redirectDueDate) : null;
      const created = payment.createdAtMs || Date.parse(payment.createdAt);
      if ((due && Number.isFinite(due) && now >= due) || (virtualShiftActive && Number.isFinite(created) && now - created >= DEAL_AUTO_CANCEL_VIRTUAL_MS)) {
        setStatus(payment, 'DEADLINE_EXPIRED');
        persist();
        console.log(`[mock] payment ${payment.paymentId} expired -> DEADLINE_EXPIRED`);
        continue;
      }
    }

    // 4. Авто-подтверждение холда (AUTHORIZED -> CONFIRMED) через MOCK_AUTO_CONFIRM_MS,
    //    customAutoConfirmMs или через 7 дней виртуального времени, либо авто-отмена через 60 дней
    if (payment.status === 'AUTHORIZED') {
      const authAt = payment.authorizedAtMs || Date.parse(payment.authorizedAt || payment.createdAt);
      const effectiveAutoConfirmMs = payment.customAutoConfirmMs !== null && payment.customAutoConfirmMs !== undefined
        ? payment.customAutoConfirmMs
        : (AUTO_CONFIRM_MS > 0 ? AUTO_CONFIRM_MS : (virtualShiftActive ? HOLD_AUTO_CONFIRM_VIRTUAL_MS : 0));

      if (effectiveAutoConfirmMs > 0 && Number.isFinite(authAt) && now - authAt >= effectiveAutoConfirmMs) {
        finalizeConfirm(payment, payment.amount);
        console.log(`[mock] auto-confirmed hold ${payment.paymentId} after ${effectiveAutoConfirmMs}ms`);
      }
    }

    // 5. Авто-отмена незакрытой сделки через 60 дней (если сделка открыта, а платёж CONFIRMED > 60 дней без закрытия)
    if (virtualShiftActive && payment.dealId && payment.status === 'CONFIRMED') {
      const deal = state.deals[payment.dealId];
      const authAt = payment.authorizedAtMs || payment.confirmedAtMs || payment.createdAtMs || Date.parse(payment.createdAt);
      if (deal && deal.status === 'open' && Number.isFinite(authAt) && now - authAt >= DEAL_AUTO_CANCEL_VIRTUAL_MS) {
        setStatus(payment, 'REFUNDED');
        payment.remaining = 0;
        deal.status = 'expired';
        persist();
        scheduleNotification(payment, 'REFUNDED');
        console.log(`[mock] deal ${deal.id} / payment ${payment.paymentId} auto-refunded after 60d`);
      }
    }
  }
}

/* -------------------------------------------------------------- admin */

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
    .sort((a, b) => b.paymentId.localeCompare(a.paymentId))
    .map((p) => {
      const deal = p.dealId ? ` · сделка ${esc(p.dealId)}` : '';
      const disp = p.disputeId ? ` · спор <code>${esc(p.disputeId)}</code> (${esc(p.disputeStatus)})` : '';
      const actions = [];
      if (p.status === 'AUTHORIZED') {
        actions.push(btn('auto-confirm-hold', p.paymentId, 'банк подтвердил холд', csrfToken, adminActionUrl));
        actions.push(btn('cancel-payment', p.paymentId, 'отмена платформой (REVERSED)', csrfToken, adminActionUrl));
      }
      if (p.status === 'CONFIRMED') actions.push(btn('cancel-payment', p.paymentId, 'возврат платформой (REFUNDED)', csrfToken, adminActionUrl));
      if (p.status === 'CONFIRMED') actions.push(btn('chargeback-payment', p.paymentId, 'эмитент: чарджбэк (DISPUTED)', csrfToken, adminActionUrl));
      if (p.disputeId && p.disputeStatus === 'DISPUTED') actions.push(btn('dispute-representment', p.disputeId, 'спор: representment', csrfToken, adminActionUrl));
      if (p.disputeId && p.disputeStatus === 'REPRESENTMENT') actions.push(btn('dispute-arb', p.disputeId, 'спор: arb', csrfToken, adminActionUrl));
      if (p.disputeId && ['DISPUTED', 'REPRESENTMENT', 'ARBITRATION'].includes(p.disputeStatus)) {
        actions.push(btn('dispute-won', p.disputeId, 'спор: WON', csrfToken, adminActionUrl));
        actions.push(btn('dispute-lost', p.disputeId, 'спор: LOST', csrfToken, adminActionUrl));
      }
      if (p.status === 'NEW') actions.push(btn('cancel-new', p.paymentId, 'отменить (NEW→CANCELED)', csrfToken, adminActionUrl));
      const hist = p.statusHistory.map((h) => `${h.status}<span style="color:#bbb">@${h.at.slice(11, 19)}</span>`).join('<span style="color:#ccc"> → </span>');
      return `<tr><td><code>${esc(p.paymentId)}</code></td><td>${esc(p.orderId)}<div style="font-size:10px;color:#888;margin-top:3px">${hist}</div></td><td>${(currentAmount(p) / 100).toFixed(2)}</td><td><b>${esc(p.status)}</b>${disp}</td><td>${deal}</td><td>${actions.join(' ')}</td></tr>`;
    })
    .join('') || '<tr><td colspan="6">платежей нет</td></tr>';

  const deals = Object.values(state.deals)
    .map((d) => `<tr><td><code>${esc(d.id)}</code></td><td>${esc(d.status)}</td><td>${(dealBalance(d) / 100).toFixed(2)} ₽</td></tr>`)
    .join('') || '<tr><td colspan="3">сделок нет</td></tr>';

  const disputes = Object.values(state.disputes || {})
    .sort((a, b) => b.disputeId.localeCompare(a.disputeId))
    .map((d) => `<tr><td><code>${esc(d.disputeId)}</code></td><td><code>${esc(d.paymentId)}</code></td><td>${(d.amount / 100).toFixed(2)} ₽</td><td><b>${esc(d.status)}</b></td><td>${esc(d.reasonCode)}</td></tr>`)
    .join('') || '<tr><td colspan="5">споров (чарджбэков) нет</td></tr>';

  const incoming = Object.values(state.incoming)
    .sort((a, b) => b.incomingId.localeCompare(a.incomingId))
    .map((v) => `<tr><td><code>${esc(v.incomingId)}</code></td><td>${esc(v.code)}</td><td>${(v.amount / 100).toFixed(2)} ₽</td><td>${esc(v.payer.inn)}</td><td>${esc(v.payer.name)}</td><td>${esc(v.payer.bank)} · ${esc(v.payer.account)}</td><td><b>${esc(v.status)}</b></td></tr>`)
    .join('') || '<tr><td colspan="7">поступлений нет</td></tr>';

  const verifs = Object.values(state.verifications)
    .sort((a, b) => b.verificationId.localeCompare(a.verificationId))
    .map((v) => `<tr><td><code>${esc(v.verificationId)}</code></td><td>${esc(v.code)}</td><td>${(v.amount / 100).toFixed(2)} ₽</td><td><b>${esc(v.status)}</b></td><td>${esc(v.account || '—')}</td></tr>`)
    .join('') || '<tr><td colspan="5">прогонов нет</td></tr>';

  const notifs = Object.values(state.notifications)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .slice(-25)
    .map((n) => {
      const st = n.suppressed ? 'suppressed' : n.dumped ? 'dumped' : n.done ? 'delivered' : `retry@${new Date(n.nextAttemptAt || clock.now()).toISOString().slice(11, 19)}`;
      return `<tr><td><code>${esc(n.id)}</code></td><td><code>${esc(n.paymentId)}</code></td><td>${esc(n.payload.Status)}</td><td>${n.attempts}</td><td>${esc(st)}</td><td>${esc(n.lastStatus ?? '—')} ${esc(String(n.lastBody ?? '').slice(0, 40))}</td><td>${btn('duplicate-notification', n.id, 'повторить', csrfToken, adminActionUrl)}</td></tr>`;
    })
    .join('') || '<tr><td colspan="7">нотификаций нет</td></tr>';

  const journalRows = journal.list().slice(-15).reverse()
    .map((e) => `<tr><td>${esc(e.at.slice(11, 19))}</td><td>${esc(e.method)}</td><td><code>${esc(e.path)}</code></td><td>${esc(Object.entries(e.body || {}).map(([k, v]) => `${k}=${v}`).join(' '))}</td><td>${e.status}</td><td>${e.ms} мс</td><td><code style="font-size:10px">${esc(String(e.curl || '').slice(0, 70))}…</code></td></tr>`)
    .join('') || '<tr><td colspan="7">запросов ещё не было</td></tr>';

  return page(`
    <span class="logo">T · мок банка</span>
    <h1>Консоль стенда</h1>
    <div class="muted">TerminalKey <code>${terminalKey()}</code> · профиль <code>${PROFILE}</code> · подпись ${STRICT_TOKEN ? 'строгая' : 'выключена'} · ретраи ${Math.round(RETRY_MS / 1000)}с × ${MAX_ATTEMPTS} · виртуальное время <code>${esc(clock.iso())}</code></div>
    <div style="background:#fff8e1;border:1px solid #f0d47a;border-radius:10px;padding:8px 10px;margin-bottom:10px;font-size:13px">⚠ Платежи проводятся <b>только по тестовым картам</b> из списка ниже — любая другая карта отклоняется (тестовый стенд: реальные карты не принимаются). Пресеты — на форме оплаты.</div>
    <div class="muted">Обновлено ${new Date(clock.now()).toLocaleTimeString('ru-RU')}</div>
    <h1 style="font-size:16px">Платежи</h1>
    <table border="0" cellpadding="4" style="font-size:13px;width:100%">${payments}</table>
    <h1 style="font-size:16px">Споры / Чарджбэки (DISPUTED → REPRESENTMENT → ARBITRATION → WON/LOST)</h1>
    <table border="0" cellpadding="4" style="font-size:13px;width:100%">${disputes}</table>
    <h1 style="font-size:16px">Сделки (баланс = Σ списаний − Σ возвратов)</h1>
    <table border="0" cellpadding="4" style="font-size:13px;width:100%">${deals}</table>
    <h1 style="font-size:16px">Поступления на спец-счёт (VER-платежи МСП)</h1>
    <table border="0" cellpadding="4" style="font-size:12px;width:100%">${incoming}</table>
    <h1 style="font-size:16px">Верификация счетов (прогон рубля)</h1>
    <table border="0" cellpadding="4" style="font-size:13px;width:100%">${verifs}</table>
    <h1 style="font-size:16px">Нотификации (последние 25)</h1>
    <table border="0" cellpadding="4" style="font-size:12px;width:100%">${notifs}</table>
    <h1 style="font-size:16px">Журнал запросов к API (последние 15) — <a href="${esc(adminJournalUrl)}">json</a></h1>
    <table border="0" cellpadding="4" style="font-size:12px;width:100%">${journalRows}</table>`, true);
}

const esc = (v) => escapeHtml(v);

function btn(action, id, label, csrfToken, actionUrl) {
  return `<form method="POST" action="${esc(actionUrl)}" style="display:inline"><input type="hidden" name="_csrf" value="${esc(csrfToken)}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="id" value="${id}"><button style="width:auto;margin:2px;padding:6px 10px;font-size:12px" type="submit">${label}</button></form>`;
}

function adminAction(body) {
  const { action, id } = body;
  if (action === 'auto-confirm-hold') {
    const payment = state.payments[String(id)];
    if (payment && payment.status === 'AUTHORIZED') {
      finalizeConfirm(payment, payment.amount);
    }
  } else if (action === 'cancel-new') {
    const payment = state.payments[String(id)];
    if (payment && payment.status === 'NEW') {
      setStatus(payment, 'CANCELED');
      persist();
    }
  } else if (action === 'cancel-payment') {
    const payment = state.payments[String(id)];
    if (payment && (payment.status === 'AUTHORIZED' || payment.status === 'CONFIRMED')) {
      const target = payment.status === 'AUTHORIZED' ? 'REVERSED' : 'REFUNDED';
      setStatus(payment, target);
      payment.remaining = 0;
      persist();
      scheduleNotification(payment, target);
      console.log(`[mock] platform Cancel: ${payment.paymentId} -> ${target}`);
    }
  } else if (action === 'chargeback-payment') {
    const payment = state.payments[String(id)];
    if (payment && ['CONFIRMED', 'PARTIAL_REFUNDED'].includes(payment.status)) {
      openDispute(payment, { reasonCode: '4853' });
      console.log(`[mock] issuer chargeback: ${payment.paymentId} -> CHARGEBACK`);
    }
  } else if (action === 'dispute-representment') {
    const d = state.disputes[String(id)];
    if (d) transitionDispute(d, 'representment');
  } else if (action === 'dispute-arb') {
    const d = state.disputes[String(id)];
    if (d) transitionDispute(d, 'arbitration');
  } else if (action === 'dispute-won') {
    const d = state.disputes[String(id)];
    if (d) transitionDispute(d, 'win');
  } else if (action === 'dispute-lost') {
    const d = state.disputes[String(id)];
    if (d) transitionDispute(d, 'lose');
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
        dumped: false,
        done: false,
        suppressed: false,
      };
      state.notifications[copy.id] = copy;
      persist();
    }
  }
  return { redirect: '/admin' };
}

/* ------------------------------------------------------------------ http */

/**
 * Выжимка запроса для журнала: скаляры, не более 8 полей, значения до 60
 * символов. Редакцию секретов и PII делает ядро (F-09): `Token`, `Password`,
 * `Pan`, `CardData`, `CVV`, ИНН/телефон/e-mail и ФИО в журнал не попадают.
 */
function bodySummary(body) {
  return core.summarizeBody(body, { maxKeys: 8, maxValueLength: 60 });
}

/**
 * Какая авторизация нужна маршруту (F-07):
 *   'admin'    — /admin* (журнал, консоль и действия);
 *   'operator' — управляющая поверхность: /mock/* (sandboxes/reset/state/time/
 *                scenarios/verify-merchant) и служебное чтение спора
 *                GET /v2/Dispute/{id};
 *   null       — платёжный API и публичные страницы.
 */
function controlSurface(p) {
  if (p.startsWith('/admin')) return 'admin';
  if (p.startsWith('/mock/')) return 'operator';
  if (/^\/v2\/Dispute\/[A-Za-z0-9_-]+$/.test(p)) return 'operator';
  return null;
}

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

/** Генерация кредов песочницы (RFC-001 §4): подпись Т-Банка зависит от пароля. */
function generateSandboxCreds(body = {}) {
  return {
    terminalKey: `SBX${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
    terminalPassword: core.randomToken(24),
    fermaLogin: `sbx${crypto.randomBytes(4).toString('hex')}`,
    fermaPassword: core.randomToken(24),
    fermaGroup: String(body.group || 'Main'),
  };
}

/**
 * GET/POST/DELETE /sandboxes (алиас /mock/sandboxes): список, создание и
 * удаление песочниц. В owned-режиме создание публичное (демо) с лимитом на IP,
 * список/удаление — владельцу (owner-token) или оператору (F-12, RFC-001 §6/§7).
 */
function handleSandboxApi(req, res, url, body, admission) {
  const operator = sandboxRuntime.isOperatorToken(sandboxRuntime.ownerTokenOf(req));
  if (req.method === 'GET') {
    if (TENANCY === 'owned' && !operator) {
      const own = sandboxRuntime.recordByOwnerToken(req);
      if (!own) {
        return sendJson(res, err(13, 'Список песочниц в hosted-режиме доступен владельцу (owner-token) или оператору', null, {
          field: 'X-Sandbox-Token',
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
          profile: PROFILE,
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
        return sendJson(res, err(7, e.message, e.code || null, {
          hint: 'Ограничения: MOCK_SANDBOX_MAX (количество), MOCK_SANDBOX_CREATE_LIMIT (созданий в час на IP).',
        }), status);
      }
    }
    // namespaces/off — BC: выбрать (и при необходимости создать) активную песочницу стенда.
    const result = sandboxRuntime.switchActive((body && body.sandbox) || 'default');
    if (!result.ok) return sendJson(res, err(7, `Не удалось выбрать песочницу: ${result.error}`), 400);
    return sendJson(res, { ok: true, current: result.current, sandboxes: sandboxRuntime.list() });
  }
  if (req.method === 'DELETE') {
    const target = String((body && body.sandbox) || url.searchParams.get('sandbox') || '');
    if (!target) return sendJson(res, err(7, 'Укажите песочницу для удаления: ?sandbox=<id> или {"sandbox":"<id>"}'), 400);
    const record = sandboxRuntime.find(target);
    if (!record) return sendJson(res, err(8, `Песочница «${target}» не найдена`), 404);
    if (TENANCY === 'owned' && !operator && !sandboxRuntime.recordAuthorized(record, req)) {
      return sendJson(res, err(13, `Удалить песочницу «${target}» может её владелец (owner-token) или оператор`), 401);
    }
    const result = sandboxRuntime.remove(target);
    if (!result.ok) return sendJson(res, err(7, `Песочницу «${target}» удалить нельзя (default-стенд)`), 400);
    return sendJson(res, { ok: true, removed: result.removed });
  }
  return sendJson(res, err(501, `Метод ${req.method} для /sandboxes не поддерживается`), 405);
}

/**
 * RFC-001 §6: /sandboxes/me — своя песочница по owner-token (в namespaces-режиме
 * — песочница текущего запроса). reset/reset-creds/DELETE работают только с ней.
 */
function handleSandboxMe(req, res, p, body) {
  const record = sandboxRuntime.recordByOwnerToken(req) || (TENANCY === 'owned' ? null : sandboxRuntime.current());
  if (!record) {
    return sendJson(res, err(13, 'Требуется owner-token песочницы', null, {
      field: 'X-Sandbox-Token',
      hint: 'Owner-token выдаётся один раз при создании: POST /sandboxes.',
    }), 401);
  }
  if (p === '/sandboxes/me' && req.method === 'GET') {
    return sendJson(res, { ok: true, mode: TENANCY, sandbox: sandboxRuntime.describe(record), creds: record.creds || null });
  }
  if (p === '/sandboxes/me/reset' && req.method === 'POST') {
    const result = sandboxRuntime.reset(record.id);
    return sendJson(res, { ok: true, sandbox: result.sandbox });
  }
  if (p === '/sandboxes/me/reset-creds' && req.method === 'POST') {
    // Смена кредов песочницы: owner-token не меняется, иначе интегратор потеряет доступ.
    const creds = generateSandboxCreds(body || {});
    sandboxRuntime.updateCreds(record.id, creds);
    return sendJson(res, { ok: true, sandbox: record.id, creds, ownerTokenChanged: false });
  }
  if (p === '/sandboxes/me' && req.method === 'DELETE') {
    const result = sandboxRuntime.remove(record.id);
    if (!result.ok) return sendJson(res, err(7, 'default-песочницу стенда удалить нельзя'), 400);
    return sendJson(res, { ok: true, removed: result.removed });
  }
  return sendJson(res, err(501, `Метод ${req.method} для ${p} не поддерживается`), 405);
}

/**
 * Политика admission по маршруту (F-11/F-12): какие запросы требуют контекст
 * песочницы и owner-token в hosted-режиме.
 */
function sandboxPolicy(p) {
  if (p.startsWith('/sandboxes')) return 'public'; // управление песочницами решает свои проверки само
  if (p.startsWith('/admin') || p.startsWith('/mock/')) return 'control';
  if (p.startsWith('/payment/')) return 'form';    // ссылка на оплату — capability, как форма банка
  if (/^\/(v2|e2c\/v2|av\/v1|oauth|sm-register)\//.test(p)) return 'business';
  return 'public';
}

/** DX-ответ на ошибку admission песочницы (F-12): знание ID ≠ доступ. */
function sendSandboxError(res, admission) {
  const id = admission.sandbox || 'default';
  if (admission.kind === 'not-found') {
    return sendJson(res, err(8, `Песочница «${id}» не найдена`, null, {
      hint: 'Создайте песочницу: POST /sandboxes — в ответе будут id, creds и ownerToken. Список доступных — GET /mock/sandboxes.',
    }), 404);
  }
  if (admission.kind === 'unauthorized') {
    return sendJson(res, err(13, `Доступ к песочнице «${id}» ограничен: знание ID не является доступом`, `${admission.kind}: owner-token не предъявлен или неверен`, {
      field: 'X-Sandbox-Token',
      hint: 'Передайте owner-token из ответа POST /sandboxes: Authorization: Bearer <ownerToken>, X-Sandbox-Token или ?sandbox_token=.',
    }), 401);
  }
  if (admission.kind === 'expired') {
    return sendJson(res, err(8, `Песочница «${id}» истекла по TTL и удалена`, null, {
      hint: 'Песочницы живут ограниченное время; создайте новую: POST /sandboxes.',
    }), 410);
  }
  if (admission.kind === 'rate-limit' || admission.kind === 'limit') {
    return sendJson(res, err(7, `Лимит создания песочниц исчерпан`, admission.kind, {
      hint: 'Переиспользуйте существующий ID или поднимите MOCK_SANDBOX_CREATE_LIMIT / MOCK_SANDBOX_MAX.',
    }), 429);
  }
  return sendJson(res, err(5000, 'Не удалось разрешить контекст песочницы'), 500);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const raw = await readBody(req);
  const body = parseBody(raw, req.headers['content-type']);

  // F-11/F-12: контекст песочницы разрешается ровно один раз до бизнес-логики.
  // Внутри run() все обработчики (включая очереди, запущенные из запроса) видят
  // state/creds/persist именно своей песочницы; module-singleton не переключается.
  const admission = sandboxRuntime.admit(req, sandboxPolicy(p));
  if (!admission.ok) return sendSandboxError(res, admission);
  return sandboxRuntime.run(admission, () => routeRequest(req, res, url, p, raw, body, admission));
}

async function routeRequest(req, res, url, p, raw, body, admission) {
  // Единый access-control управляющей поверхности (F-07, A-20):
  // /admin* — MOCK_ADMIN_TOKEN; /mock/* и служебные чтения — MOCK_OPERATOR_TOKEN
  // (с fallback на админ-токен). В hosted-режиме без секрета — fail-closed.
  const surface = controlSurface(p);
  // F-12: owner-token песочницы — равноправный доступ к её управляющей
  // поверхности (RFC-001 §6), в т.ч. к алиасу /mock/sandboxes.
  const ownerSurface = surface === 'operator' && Boolean(sandboxRuntime.recordByOwnerToken(req));
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
        ? `Маршрут ${p} закрыт: hosted-режим (MOCK_HOSTED) требует ${envName} для управляющей поверхности`
        : `Доступ к управляющему маршруту ${p} ограничен: требуется ${envName}`;
      return sendJson(res, err(13, message, `${surface}: ${access.reason}`, {
        field: surface === 'admin' ? 'Authorization' : 'X-Operator-Token',
        hint: `Передайте токен в заголовке Authorization: Bearer <${envName}> или X-Operator-Token/X-Admin-Token. Подробности — docs/rfc/RFC-001-multi-tenant-sandboxes.md.`,
      }), 401);
    }
  }

  // Журналируем только API-вызовы (не страницы формы и не поллинг /admin).
  if (/^\/(v2|e2c\/v2|av\/v1|oauth|sm-register)\//.test(p)) {
    const started = Date.now();
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (code, ...rest) => {
      journal.record({
        method: req.method,
        path: p,
        status: code,
        ms: Date.now() - started,
        body: bodySummary(body),
        headers: req.headers,
        baseUrl: MOCK_PUBLIC_BASE_URL,
      });
      return originalWriteHead(code, ...rest);
    };

    // Инъекция задержек и сетевых сбоев (X-Mock-Latency, X-Mock-Scenario: latency:..., http-500, http-504).
    // F-06: контракт ядра — { abortStatus, abortMessage }; сбой шлюза отдаётся
    // provider-shaped ошибкой с HTTP-статусом сценария и без побочных эффектов
    // (handler запроса не вызывается вовсе).
    const chaosSpec = parseScenarioSpec(req.headers['x-mock-scenario'] || '');
    const chaosResult = await applyRequestChaos(req, chaosSpec);
    if (chaosResult.abortStatus) {
      return sendJson(res, err(chaosResult.abortStatus, chaosResult.abortMessage, null, {
        field: 'X-Mock-Scenario',
        hint: 'Сценарий X-Mock-Scenario: http-500|http-504 имитирует сбой шлюза — запрос не дошёл до банка. Задержка — latency:<время>, например latency:250ms.',
      }), chaosResult.abortStatus);
    }
  }

  if (req.method === 'GET' && p === '/health') {
    const health = { ok: true, sandbox: sandboxRuntime.currentId(), tenancy: TENANCY };
    // Чужие счётчики не раскрываем: в owned-режиме health отвечает по default-стенду
    // и не показывает состояние именованных песочниц других арендаторов.
    if (TENANCY !== 'owned' || admission.record.isDefault) {
      Object.assign(health, {
        payments: Object.keys(state.payments).length,
        deals: Object.keys(state.deals).length,
        payouts: Object.keys(state.payouts || {}).length,
        disputes: Object.keys(state.disputes || {}).length,
        shops: Object.keys(state.shops || {}).length,
      });
      // Управляющие токены стенда делает видимыми startup-лог, не health.
    }
    return sendJson(res, health);
  }
  if (req.method === 'GET' && p === '/openapi.json') {
    const specFile = require('path').join(__dirname, '..', '..', 'docs', 'openapi', 'tbank-mock.openapi.json');
    const specObj = JSON.parse(require('fs').readFileSync(specFile, 'utf8'));
    return sendJson(res, specObj);
  }
  if (req.method === 'GET' && p === '/admin/journal') return sendJson(res, { entries: journal.list() });

  // ── RFC-001 §6: управление песочницами (создание, инфо, reset, удаление) ──
  if (p === '/sandboxes' || p === '/mock/sandboxes') {
    return handleSandboxApi(req, res, url, body, admission);
  }
  if (p.startsWith('/sandboxes/')) {
    return handleSandboxMe(req, res, p, body);
  }

  if (p === '/mock/reset' && req.method === 'POST') {
    // F-11/F-13: сбрасываем ровно ту песочницу, в контексте которой пришёл запрос
    // (selector/owner-token уже разрешены admission), без переключения singleton.
    const target = (body && body.sandbox) || admission.record.id;
    const resetName = sandboxRuntime.reset(target);
    scenarios.clearRules();
    scenarios.clearHistory();
    journal.clear();
    return sendJson(res, { ok: true, sandbox: resetName.sandbox || target });
  }

  if (p === '/mock/state') {
    if (req.method === 'GET') {
      // F-13: target читается из query явно; active при этом не переключается.
      const targetSandbox = url.searchParams.get('sandbox') || undefined;
      const snapshot = targetSandbox ? sandboxRuntime.exportState(targetSandbox) : sandboxRuntime.exportState();
      return sendJson(res, {
        sandbox: snapshot.sandbox || admission.record.id,
        state: snapshot,
      });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      if (raw.trim() && String(req.headers['content-type'] || '').includes('application/json')) {
        try { JSON.parse(raw); } catch {
          return sendJson(res, err(7, 'Некорректный JSON снимка состояния', null, {
            field: 'state',
            hint: 'Передайте экспорт /mock/state без редактирования опасных ключей __proto__, constructor и prototype.',
          }), 400);
        }
      }
      const targetSandbox = (body && body.sandbox) || admission.record.id;
      const snapshot = (body && body.state) || body || {};
      try {
        const imported = sandboxRuntime.importState(snapshot, targetSandbox);
        // F-10: импортированный снимок тоже не должен оставлять полный PAN;
        // F-15: снимок мог быть сделан до появления ссылочных индексов — индексы
        // пересобираются из фактического state, а не принимаются на веру.
        const scrubbed = sandboxRuntime.run({ ok: true, record: sandboxRuntime.find(imported.sandbox) }, () => {
          const pan = scrubLegacyPan(state);
          rebuildIndexes(state);
          return pan;
        });
        if (scrubbed) {
          log(`[mock] из импортированного снимка удалён полный PAN у ${scrubbed} выплат(ы) (F-10)`);
          sandboxRuntime.flush();
        }
        return sendJson(res, { ok: true, sandbox: imported.sandbox, panScrubbed: scrubbed || undefined });
      } catch (e) {
        return sendJson(res, err(7, 'Недопустимый снимок состояния', e.message, {
          field: 'state',
          hint: 'Исправьте снимок и повторите импорт; ключи __proto__, constructor и prototype запрещены на всех уровнях.',
        }), 400);
      }
    }
  }

  // Активный экзаменатор вебхук-приёмника мерчанта
  if (p === '/mock/verify-merchant' && req.method === 'POST') {
    const targetUrl = String((body && (body.url || body.NotificationURL)) || MOCK_DEFAULT_NOTIFICATION_URL || '').trim();
    if (!targetUrl) {
      return sendJson(res, err(7, 'Передайте url приёмника вебхуков для активной проверки', null, { field: 'url' }), 400);
    }
    try {
      const report = await verifyMerchantWebhook({
        url: targetUrl,
        provider: 'tbank',
        terminalKey: terminalKey(),
        signPayload: (payload) => tokenOf(payload),
        blockPrivateHosts: BLOCK_PRIVATE_WEBHOOKS,
      });
      return sendJson(res, report);
    } catch (e) {
      if (e && e.code === 'SSRF_BLOCKED') {
        return sendJson(res, err(7, e.message, `url=${targetUrl}`, {
          field: 'url',
          hint: 'Для активной проверки укажите публично доступный приёмник. Приватные адреса разрешены только при MOCK_BLOCK_PRIVATE_WEBHOOKS=0 на локальном стенде.',
        }), 403);
      }
      return sendJson(res, err(500, `Ошибка проверки вебхук-приёмника: ${e.message}`), 500);
    }
  }

  // Виртуальные часы (этап 7, бриф §3.2)
  if (p === '/mock/time') {
    if (req.method === 'GET') return sendJson(res, clock.snapshot());
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        const snap = clock.set(body || {});
        tickBank();
        await deliveryQueue.tick();
        return sendJson(res, snap);
      } catch (e) {
        return sendJson(res, err(7, e.message, null, { field: 'advance|offset|iso' }), 400);
      }
    }
  }

  // Сценарное API (этап 7, бриф §3.2)
  if (p === '/mock/scenarios') {
    if (req.method === 'GET') {
      return sendJson(res, { rules: scenarios.listRules(), history: scenarios.listHistory() });
    }
    if (req.method === 'POST') {
      try {
        const rule = scenarios.addRule(body || {});
        return sendJson(res, { ok: true, rule });
      } catch (e) {
        return sendJson(res, err(7, e.message, null, { field: 'scenario' }), 400);
      }
    }
    if (req.method === 'DELETE') {
      scenarios.clearRules();
      scenarios.clearHistory();
      return sendJson(res, { ok: true, rules: [], history: [] });
    }
  }

  // ── acqapi: OAuth 2.0 + Регистрация партнёров (/sm-register/register*)
  if (p === '/oauth/token' && req.method === 'POST') {
    // F-26: Basic-креды клиента берутся из конфигурации стенда (эталон: partner:partner).
    const basic = parseBasicAuth(req.headers.authorization);
    if (!basic || basic.clientId !== ACQAPI_CLIENT_ID || basic.clientSecret !== ACQAPI_CLIENT_SECRET) {
      return sendJson(res, {
        error: 'invalid_client',
        error_description: `Basic-авторизация клиента обязательна и сверяется с MOCK_ACQAPI_CLIENT_ID/MOCK_ACQAPI_CLIENT_SECRET (эталон: partner:partner); передавайте заголовок Authorization: Basic base64(clientId:clientSecret)`,
      }, 401);
    }
    const grantType = String((body && body.grant_type) || 'client_credentials').trim();
    if (!ACQAPI_GRANT_TYPES.includes(grantType)) {
      return sendJson(res, {
        error: 'unsupported_grant_type',
        error_description: `grant_type «${grantType}» не поддерживается мок-стендом; допустимо: ${ACQAPI_GRANT_TYPES.join(', ')}`,
      }, 400);
    }
    return sendJson(res, issueAcqapiToken());
  }

  if (p === '/sm-register/register' && req.method === 'POST') {
    const authError = checkAcqapiBearer(req);
    if (authError) return sendAcqapiAuthError(res, authError);
    const schemaError = validateAcqapiRegistration(body);
    if (schemaError) {
      return sendJson(res, err(7, `Регистрация партнёра не прошла проверку схемы: ${schemaError.message}`, null, {
        field: schemaError.field,
        doc: '/e2c',
        hint: 'Передайте обязательные shopArticleId, реквизиты ЮЛ, addresses[], ceo, founders.individuals[], bankAccount и nonResident по docs/reference/tbank/03-payouts-and-deals.md.',
      }), 400);
    }
    const descriptor = body.billingDescriptor.trim();
    const inn = body.inn.trim();
    // F-27: shopArticleId — внешний код точки у площадки — является shopCode
    // мока и далее тем же PartnerId в выплате; случайный код больше не генерируется.
    const shopCode = body.shopArticleId.trim();
    if (!isRecord(state.shops)) state.shops = Object.create(null);
    if (Object.prototype.hasOwnProperty.call(state.shops, shopCode)) {
      return sendJson(res, err(7, `Партнёр shopArticleId/shopCode «${shopCode}» уже зарегистрирован`, null, { field: 'shopArticleId' }), 409);
    }
    const shop = {
      code: shopCode,
      shopCode,
      shopArticleId: shopCode,
      name: body.name.trim(),
      fullName: body.fullName.trim(),
      inn,
      kpp: body.kpp.trim(),
      ogrn: body.ogrn.trim(),
      billingDescriptor: descriptor,
      email: body.email.trim(),
      siteUrl: body.siteUrl.trim(),
      addresses: body.addresses,
      ceo: body.ceo,
      founders: body.founders,
      bankAccount: body.bankAccount,
      mcc: body.mcc === undefined || body.mcc === null || body.mcc === '' ? null : String(body.mcc),
      nonResident: body.nonResident,
      status: 'ACTIVE',
      terminals: [
        { terminalKey: `${terminalKey()}`, type: 'ACQUIRING' },
        { terminalKey: e2cTerminalKey(), type: 'PAYOUT' },
      ],
      createdAt: clock.iso(),
    };
    const quotaShop = ensureSandboxQuota();
    if (quotaShop) return quotaShop;
    state.shops[shopCode] = shop;
    persist();
    return sendJson(res, shop);
  }

  const smGetMatch = p.match(/^\/sm-register\/register\/shop\/([A-Za-z0-9_.-]+)$/);
  if (smGetMatch && req.method === 'GET') {
    const authError = checkAcqapiBearer(req);
    if (authError) return sendAcqapiAuthError(res, authError);
    const shop = state.shops && state.shops[smGetMatch[1]];
    if (!shop) return sendJson(res, err(8, `Партнёр shopCode=«${smGetMatch[1]}» не найден`), 404);
    return sendJson(res, shop);
  }

  const smPatchMatch = p.match(/^\/sm-register\/register\/([A-Za-z0-9_.-]+)$/);
  if ((smPatchMatch && req.method === 'PATCH') || (smPatchMatch && req.method === 'POST')) {
    const authError = checkAcqapiBearer(req);
    if (authError) return sendAcqapiAuthError(res, authError);
    const shop = state.shops && state.shops[smPatchMatch[1]];
    if (!shop) return sendJson(res, err(8, `Партнёр shopCode=«${smPatchMatch[1]}» не найден`), 404);
    if (body.billingDescriptor !== undefined) {
      const descriptorProblem = requiredText(body.billingDescriptor, 'billingDescriptor', {
        maxLength: 14,
        pattern: /^[A-Za-z0-9._ -]+$/,
        patternHint: 'латиница, цифры, точка, пробел, дефис, подчёркивание',
      });
      if (descriptorProblem) return sendJson(res, err(7, descriptorProblem.message, null, { field: descriptorProblem.field }), 400);
      shop.billingDescriptor = body.billingDescriptor.trim();
    }
    if (body.name !== undefined) {
      const nameProblem = requiredText(body.name, 'name', { maxLength: 255, pattern: /[А-Яа-яЁё]/, patternHint: 'кириллическое наименование' });
      if (nameProblem) return sendJson(res, err(7, nameProblem.message, null, { field: nameProblem.field }), 400);
      shop.name = body.name.trim();
    }
    if (body.fullName !== undefined) {
      const fullNameProblem = requiredText(body.fullName, 'fullName', { maxLength: 255, pattern: /[А-Яа-яЁё]/, patternHint: 'кириллическое наименование' });
      if (fullNameProblem) return sendJson(res, err(7, fullNameProblem.message, null, { field: fullNameProblem.field }), 400);
      shop.fullName = body.fullName.trim();
    }
    if (body.email !== undefined) {
      const emailProblem = requiredText(body.email, 'email', { maxLength: 254, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternHint: 'email' });
      if (emailProblem) return sendJson(res, err(7, emailProblem.message, null, { field: emailProblem.field }), 400);
      shop.email = body.email.trim();
    }
    if (body.siteUrl !== undefined) {
      const urlProblem = requiredText(body.siteUrl, 'siteUrl', { maxLength: 2048, pattern: /^https?:\/\/[^\s/$.?#].[^\s]*$/i, patternHint: 'URL с http:// или https://' });
      if (urlProblem) return sendJson(res, err(7, urlProblem.message, null, { field: urlProblem.field }), 400);
      shop.siteUrl = body.siteUrl.trim();
    }
    if (body.bankAccount !== undefined) {
      const bankProblem = validateAcqapiBankAccount(body.bankAccount);
      if (bankProblem) return sendJson(res, err(7, bankProblem.message, null, { field: bankProblem.field }), 400);
      shop.bankAccount = body.bankAccount;
    }
    if (body.addresses !== undefined) {
      if (!Array.isArray(body.addresses) || body.addresses.length === 0) return sendJson(res, err(7, 'addresses должен быть непустым массивом', null, { field: 'addresses' }), 400);
      for (let index = 0; index < body.addresses.length; index += 1) {
        const addressProblem = validateAcqapiAddress(body.addresses[index], index);
        if (addressProblem) return sendJson(res, err(7, addressProblem.message, null, { field: addressProblem.field }), 400);
      }
      shop.addresses = body.addresses;
    }
    shop.updatedAt = clock.iso();
    persist();
    return sendJson(res, shop);
  }

  // GET /v2/Dispute/:id — быстрое чтение карточки спора
  const disputeGetMatch = p.match(/^\/v2\/Dispute\/([A-Za-z0-9_-]+)$/);
  if (disputeGetMatch && req.method === 'GET') {
    const dispute = state.disputes[disputeGetMatch[1]];
    if (!dispute) return sendJson(res, err(8, 'Спор не найден'));
    return sendJson(res, transitionDispute(dispute, 'state'));
  }

  // Платёжное поручение МСП на сумму верификации
  if (p === '/av/v1/payment' && req.method === 'POST') {
    if (!verifyToken(body)) return sendJson(res, err(13, 'Неверный Token (подпись) запроса'));
    const code = String(body.VerificationCode || '');
    const payerInn = String(body.PayerInn || '');
    const payerName = String(body.PayerName || '');
    // F-24: строгая сумма «прогона рубля» — до счётчика поступлений и state.
    const money = core.parseMoneyKopeks(body.Amount, { field: 'Amount' });
    if (!code || !money.ok || !payerInn) {
      const moneyPart = money.ok ? '' : `: ${money.message}`;
      return sendJson(res, err(7, `Обязательные параметры не заполнены (VerificationCode, Amount, PayerInn)${moneyPart}`, null, money.ok ? undefined : { field: 'Amount' }));
    }
    const amount = money.value;
    const incomingId = 'IN-' + String(state.counters.incomingId++);
    const account = '40702810' + String(Math.floor(1e12 + Math.random() * 9e12));
    const incoming = {
      incomingId,
      code,
      amount,
      payer: { inn: payerInn, name: payerName, account, bank: 'АО «Т-Банк»' },
      status: 'RECEIVED',
      createdAt: clock.iso(),
    };
    const quotaIncoming = ensureSandboxQuota();
    if (quotaIncoming) return quotaIncoming;
    state.incoming[incomingId] = incoming;
    persist();
    console.log(`[mock] incoming ${incomingId}: ${code} ${amount}коп от ${payerInn}`);
    const webhookUrl = String(body.NotificationURL || MOCK_DEFAULT_NOTIFICATION_URL || '');
    if (webhookUrl) {
      const payload = {
        TerminalKey: terminalKey(),
        Type: 'INCOMING',
        VerificationCode: code,
        Amount: amount,
        PayerInn: payerInn,
        PayerName: payerName,
        PayerAccount: account,
        PayerBank: incoming.payer.bank,
        DocNumber: incomingId,
        DocDate: incoming.createdAt,
      };
      payload.Token = tokenOf(payload);
      const id = String(state.counters.notificationId++);
      state.notifications[id] = { id, paymentId: incomingId, url: webhookUrl, payload, attempts: 0, nextAttemptAt: 0, lastStatus: null, lastBody: null, dumped: false };
      persist();
    }
    return sendJson(res, {
      Success: true,
      ErrorCode: '0',
      IncomingId: incomingId,
      Status: 'RECEIVED',
    });
  }

  // ── E2C-выплаты (Init → Payment → GetState / CancelPayment / GetSbpMembers)
  if (p === '/e2c/v2/Init' && req.method === 'POST') {
    if (!verifyToken(body)) return sendJson(res, err(13, 'Неверный Token (подпись) запроса'));
    // F-17: общие обязательные поля, ровно один канал выплаты и сделка — до
    // выделения PaymentId; неполная выплата в state не попадает.
    const badTerminal = checkE2cTerminalKey(body);
    if (badTerminal) return sendJson(res, badTerminal);
    const fields = validatePayoutInitFields(body);
    if (fields.error) return sendJson(res, fields.error);
    const { amount, orderId, dealId, recipientId } = fields;
    const resolvedChannel = resolvePayoutChannel(body, amount);
    if (resolvedChannel.error) return sendJson(res, resolvedChannel.error);
    const channel = resolvedChannel.channel;

    const deal = findDeal(dealId);
    if (!deal) {
      return sendJson(res, err(8, `Сделка DealId=«${dealId}» не найдена`, null, { field: 'DealId', doc: PAYOUT_REF_DOC }));
    }
    if (deal.status !== 'open') {
      return sendJson(res, err(32, `Выплата по сделке «${dealId}» невозможна: сделка закрыта (status=${deal.status})`, null, { field: 'DealId', doc: PAYOUT_REF_DOC }));
    }
    const available = dealBalance(deal);
    if (amount > available) {
      return sendJson(
        res,
        err(
          32,
          `Сумма выплаты ${amount} коп. превышает доступный остаток по сделке ${dealId} (${available} коп.)`,
          `Amount=${amount}, DealBalance=${available}`,
          { field: 'Amount', hint: 'Баланс сделки = сумма подтверждённых приходов минус возвраты, чарджбэки и ранее проведённые выплаты.' },
        ),
      );
    }
    const payoutPaymentId = 'P-' + String(state.counters.payoutId++);
    const finalPayout = body.FinalPayout === true || body.FinalPayout === 'true';
    // F-10: полный PAN не сохраняем — только маска и выбранный тестовый сценарий.
    const card = resolvePayoutCard(body.Pan, body.CardId, body.CardData);
    const rawCardId = textOrNull(body.CardId);
    const quotaPayout = ensureSandboxQuota();
    if (quotaPayout) return quotaPayout;
    state.payouts[payoutPaymentId] = {
      paymentId: payoutPaymentId,
      amount,
      orderId,
      customerKey: String(body.CustomerKey || ''),
      dealId,
      finalPayout,
      // F-20: нормализованный канал/получатель — по нему CancelPayment решает,
      // партнёрская ли это выплата.
      recipientType: channel.recipientType,
      recipientId,
      partnerId: channel.partnerId || null,
      cardId: rawCardId && core.looksLikePan(rawCardId) ? maskPan(rawCardId) : rawCardId,
      panMask: card.panMask,
      cardScenario: card.cardScenario,
      phone: channel.phone || null,
      sbpMemberId: channel.sbpMemberId || null,
      recipient: {
        account: String(body.Account || ''),
        bank: String(body.Bank || ''),
        inn: String(body.PayerInn || body.RecipientInn || ''),
        name: String(body.RecipientName || ''),
      },
      status: 'NEW',
      statusHistory: [{ status: 'NEW', at: clock.iso() }],
      createdAt: clock.iso(),
    };
    indexPayout(state, state.payouts[payoutPaymentId]);
    persist();
    console.log(`[mock] e2c Init ${payoutPaymentId}: ${amount}коп, order=${orderId}, deal=${dealId}, канал=${channel.recipientType}`);
    return sendJson(res, {
      Success: true,
      ErrorCode: '0',
      TerminalKey: terminalKey(),
      PaymentId: payoutPaymentId,
      OrderId: orderId,
      Amount: amount,
      DealId: dealId,
      Status: 'NEW',
    });
  }

  if (p === '/e2c/v2/Payment' && req.method === 'POST') {
    if (!verifyToken(body)) return sendJson(res, err(13, 'Неверный Token (подпись) запроса'));
    const badTerminal = checkE2cTerminalKey(body);
    if (badTerminal) return sendJson(res, badTerminal);
    const payout = state.payouts[String(body.PaymentId || '')];
    if (!payout) return sendJson(res, err(4, 'Выплата не найдена', null, { field: 'PaymentId', doc: PAYOUT_REF_DOC }));
    if (payout.status !== 'NEW' && payout.status !== 'CHECKED') {
      return sendJson(res, err(32, 'Неверный статус выплаты: ' + payout.status));
    }
    // Официальный тестовый кейс выплаты с ошибкой: карта 5000000000000553 -> REJECTED 1057.
    // Сценарий выбран в Init; PAN в состоянии не хранится (F-10).
    if (payout.cardScenario === 'reject-1057') {
      payout.errorCode = '1057';
      pushPayoutStatus(payout, 'REJECTED');
      persist();
      return sendJson(res, {
        Success: false,
        ErrorCode: '1057',
        Message: 'Ваша карта не может быть использована для выплат',
        Details: 'Используйте другую карту',
        PaymentId: payout.paymentId,
        Status: 'REJECTED',
      });
    }
    // Повторная проверка баланса сделки перед проведением выплаты
    if (payout.dealId) {
      const deal = findDeal(payout.dealId);
      if (!deal || deal.status !== 'open') {
        return sendJson(res, err(32, `Сделка ${payout.dealId} уже закрыта или не существует`));
      }
      const available = dealBalance(deal);
      if (payout.amount > available) {
        return sendJson(res, err(32, `Недостаточно средств в сделке ${payout.dealId}: доступно ${available} коп., запрошено ${payout.amount} коп.`));
      }
    }
    pushPayoutStatus(payout, 'CONFIRMED');
    // Если FinalPayout=true — сделка автоматически переходит в closed, остаток становится вознаграждением площадки
    let dealClosed = false;
    let platformReward;
    if (payout.finalPayout && payout.dealId && state.deals[payout.dealId]) {
      const deal = state.deals[payout.dealId];
      platformReward = dealBalance(deal);
      deal.status = 'closed';
      deal.closedAt = clock.iso();
      deal.platformReward = platformReward;
      dealClosed = true;
    }
    persist();
    console.log(`[mock] e2c Payment ${payout.paymentId}: CONFIRMED ${payout.amount}коп${dealClosed ? ` (deal ${payout.dealId} closed)` : ''}`);
    return sendJson(res, {
      Success: true,
      ErrorCode: '0',
      PaymentId: payout.paymentId,
      Status: 'CONFIRMED',
      DealId: payout.dealId || undefined,
      DealClosed: dealClosed || undefined,
      PlatformReward: platformReward,
    });
  }

  if (p === '/e2c/v2/GetState' && req.method === 'POST') {
    if (!verifyToken(body)) return sendJson(res, err(13, 'Неверный Token (подпись) запроса'));
    const badTerminal = checkE2cTerminalKey(body);
    if (badTerminal) return sendJson(res, badTerminal);
    const payout = state.payouts[String(body.PaymentId || '')];
    if (!payout) return sendJson(res, err(4, 'Выплата не найдена', null, { field: 'PaymentId', doc: PAYOUT_REF_DOC }));
    return sendJson(res, {
      Success: true,
      ErrorCode: payout.errorCode || '0',
      PaymentId: payout.paymentId,
      Status: payout.status,
      Amount: payout.amount,
      OrderId: payout.orderId,
      DealId: payout.dealId || undefined,
    });
  }

  // Отмена выплаты: только успешная (CONFIRMED) выплата партнёру в открытой сделке
  // (reference 03-payouts-and-deals.md §CancelPayment; трактовки координатора #15).
  // Любой отказ возвращается до мутации — выплата остаётся в исходном статусе (F-18—F-22).
  if (p === '/e2c/v2/CancelPayment' && req.method === 'POST') {
    if (!verifyToken(body)) return sendJson(res, err(13, 'Неверный Token (подпись) запроса'));
    // F-22: точный TerminalKey — до поиска выплаты и любой мутации.
    const badTerminal = checkE2cTerminalKey(body);
    if (badTerminal) return sendJson(res, badTerminal);
    // F-21: DealId обязателен в запросе и сверяется со сделкой выплаты.
    const requestDealId = textOrNull(body.DealId);
    if (!requestDealId) {
      return sendJson(res, err(7, 'Обязательный параметр DealId не передан', null, {
        field: 'DealId',
        doc: PAYOUT_REF_DOC,
        hint: 'CancelPayment отменяет выплату в рамках сделки: DealId обязателен и должен совпадать со сделкой выплаты.',
      }));
    }
    const payout = state.payouts[String(body.PaymentId || '')];
    if (!payout) return sendJson(res, err(4, 'Выплата не найдена', null, { field: 'PaymentId', doc: PAYOUT_REF_DOC }));
    if (String(payout.dealId || '') !== requestDealId) {
      return sendJson(res, err(7, `DealId «${requestDealId}» не совпадает со сделкой выплаты (${payout.dealId || 'сделка не указана'})`, null, {
        field: 'DealId',
        doc: PAYOUT_REF_DOC,
      }));
    }
    // F-18: отменяется только успешная выплата (в модели мока успех — CONFIRMED).
    if (payout.status !== 'CONFIRMED') {
      return sendJson(res, err(32, `Отменить можно только успешную выплату (CONFIRMED), текущий статус — ${payout.status}`, null, {
        field: 'PaymentId',
        doc: PAYOUT_REF_DOC,
        hint: 'CancelPayment в банке отменяет успешную выплату; незавершённые/отклонённые выплаты не отменяются.',
      }));
    }
    // F-19: сделка выплаты существует и открыта.
    const deal = findDeal(payout.dealId);
    if (!deal) {
      return sendJson(res, err(8, `Сделка «${payout.dealId}» выплаты не найдена`, null, { field: 'DealId', doc: PAYOUT_REF_DOC }));
    }
    if (deal.status !== 'open') {
      return sendJson(res, err(32, `Сделка «${payout.dealId}» закрыта (status=${deal.status}): отмена выплаты невозможна`, null, {
        field: 'DealId',
        doc: PAYOUT_REF_DOC,
      }));
    }
    // F-20: только партнёрский канал («перечисление третьему лицу»).
    if (payout.recipientType !== 'partner') {
      return sendJson(res, err(32, `Отмена доступна только для выплаты партнёру (PartnerId), канал выплаты — ${payout.recipientType || 'не определён'}`, null, {
        field: 'PartnerId',
        doc: PAYOUT_REF_DOC,
        hint: 'Канал выплаты фиксируется в /e2c/v2/Init: для отмены нужен партнёрский канал (PartnerId = shopCode).',
      }));
    }
    // F-23: статусная модель отмены — CREDIT_CANCELING → CREDIT_CANCELED.
    const canceledAt = pushPayoutStatus(payout, 'CREDIT_CANCELING');
    pushPayoutStatus(payout, 'CREDIT_CANCELED');
    payout.canceledAt = canceledAt;
    persist();
    console.log(`[mock] e2c CancelPayment ${payout.paymentId}: CREDIT_CANCELED (${payout.amount}коп, deal=${payout.dealId})`);
    return sendJson(res, {
      Success: true,
      ErrorCode: '0',
      PaymentId: payout.paymentId,
      Status: 'CREDIT_CANCELED',
      DealId: payout.dealId,
    });
  }

  if (p === '/e2c/v2/GetSbpMembers' && req.method === 'POST') {
    if (!verifyToken(body)) return sendJson(res, err(13, 'Неверный Token (подпись) запроса'));
    const badTerminal = checkE2cTerminalKey(body);
    if (badTerminal) return sendJson(res, badTerminal);
    return sendJson(res, {
      Success: true,
      ErrorCode: '0',
      Members: [
        { MemberId: '100000000004', MemberName: 'Т-Банк', MemberNameRus: 'АО «Т-Банк»' },
        { MemberId: '100000000111', MemberName: 'Sberbank', MemberNameRus: 'ПАО Сбербанк' },
        { MemberId: '100000000008', MemberName: 'Alfa-Bank', MemberNameRus: 'АО «Альфа-Банк»' },
        { MemberId: '100000000005', MemberName: 'VTB', MemberNameRus: 'Банк ВТБ (ПАО)' },
      ],
    });
  }

  // Account verification («прогон рубля»)
  if (p === '/av/v1/verification' && req.method === 'POST') {
    if (!verifyToken(body)) return sendJson(res, err(13, 'Неверный Token (подпись) запроса'));
    const code = String(body.VerificationCode || '');
    // F-24: строгая сумма верификации счёта — до счётчика verificationId и state.
    const money = core.parseMoneyKopeks(body.Amount, { field: 'Amount' });
    if (!code || !money.ok) {
      const moneyPart = money.ok ? '' : `: ${money.message}`;
      return sendJson(res, err(7, `Обязательные параметры не заполнены (VerificationCode, Amount)${moneyPart}`, null, money.ok ? undefined : { field: 'Amount' }));
    }
    const amount = money.value;
    const verificationId = String(state.counters.verificationId++);
    const now = () => clock.iso();
    const verification = {
      verificationId,
      code,
      amount,
      account: String(body.Account || ''),
      status: 'RETURNED',
      statusHistory: [
        { status: 'NEW', at: now() },
        { status: 'CREDITING', at: now() },
        { status: 'CREDITED', at: now() },
        { status: 'RETURNING', at: now() },
        { status: 'RETURNED', at: now() },
      ],
    };
    const quotaVerification = ensureSandboxQuota();
    if (quotaVerification) return quotaVerification;
    state.verifications[verificationId] = verification;
    persist();
    console.log(`[mock] account verification ${verificationId}: ${code} ${amount}коп — прогон завершён (RETURNED)`);
    return sendJson(res, {
      Success: true,
      ErrorCode: '0',
      TerminalKey: terminalKey(),
      VerificationId: verificationId,
      VerificationCode: code,
      Amount: amount,
      Status: 'RETURNED',
    });
  }

  const api = p.match(/^\/v2\/(\w+)$/);
  if (api && req.method === 'POST') {
    const method = api[1];
    const handlers = {
      Init: handleInit,
      GetState: handleGetState,
      Confirm: handleConfirm,
      Cancel: handleCancel,
      CheckOrder: handleCheckOrder,
      Chargeback: handleChargeback,
      Dispute: handleChargeback,
      createSpDeal: handleCreateSpDeal,
      CreateSpDeal: handleCreateSpDeal,
      closeSpDeal: handleCloseSpDeal,
      CloseSpDeal: handleCloseSpDeal,
      GetQr: handleGetQr,
      Charge: handleCharge,
      SendClosingReceipt: handleSendClosingReceipt,
      AddCustomer: handleAddCustomer,
      GetCustomer: handleGetCustomer,
      RemoveCustomer: handleRemoveCustomer,
      AddCard: handleAddCard,
      GetCardList: handleGetCardList,
      RemoveCard: handleRemoveCard,
    };
    const handler = handlers[method];
    if (!handler) return sendJson(res, err(501, `Метод ${method} мок-стендом пока не поддерживается`));
    if (!verifyToken(body)) {
      // Диагностический payload — через редакцию ядра (F-09/F-10): в console не
      // должно быть ни PAN, ни прочих реквизитов из тела запроса. Префиксы
      // подписи вынесены в отдельные поля, чтобы диагностика осталась полезной.
      const safePayload = core.redactSecrets({
        ...body,
        Token: core.REDACTED,
        tokenReceived: `<${String(body.Token || '').slice(0, 8)}…>`,
        tokenExpected: `<${tokenOf(body).slice(0, 8)}…>`,
      });
      console.log(`[mock] ${method} token FAIL. payload:`, JSON.stringify(safePayload));
      return sendJson(res, err(13, 'Неверный Token (подпись) запроса'));
    }
    return sendJson(res, handler(body, req.headers));
  }

  // POST /payment/:id/sbp-pay — симуляция оплаты по QR-коду СБП в приложении банка
  const sbpPayMatch = p.match(/^\/payment\/(\d+)\/sbp-pay$/);
  if (sbpPayMatch && req.method === 'POST') {
    const payment = state.payments[sbpPayMatch[1]];
    if (!payment || !['NEW', 'FORM_SHOWED'].includes(payment.status)) {
      return sendJson(res, err(8, 'Платёжная сессия СБП не найдена или уже завершена'), 404);
    }
    payment.panMask = 'SBP**0004';
    payment.confirmedAmount = payment.amount;
    payment.remaining = payment.amount;
    setStatus(payment, 'CONFIRMED');
    persist();
    scheduleNotification(payment, 'CONFIRMED', { PaymentMethod: 'SBP' });
    return sendJson(res, {
      Success: true,
      ErrorCode: '0',
      PaymentId: payment.paymentId,
      OrderId: payment.orderId,
      Amount: payment.amount,
      Status: 'CONFIRMED',
    });
  }

  const formMatch = p.match(/^\/payment\/(\d+)$/);
  if (formMatch && req.method === 'GET') {
    const payment = state.payments[formMatch[1]];
    if (!payment) return send(res, 404, 'сессия не найдена');
    if (payment.status === 'NEW') setStatus(payment, 'FORM_SHOWED');
    if (payment.status === 'DEADLINE_EXPIRED' || payment.status === 'REJECTED' || payment.status === 'CANCELED' || payment.status === 'AUTH_FAIL') {
      return html(res, page(`<h1>Платёж недоступен</h1><div class="muted">Статус сессии: ${payment.status}</div>`));
    }
    persist();
    return html(res, paymentPage(payment));
  }

  const payMatch = p.match(/^\/payment\/(\d+)\/pay$/);
  if (payMatch && req.method === 'POST') {
    const payment = state.payments[payMatch[1]];
    if (!payment || !['NEW', 'FORM_SHOWED'].includes(payment.status)) return send(res, 404, 'сессия не найдена или уже завершена');
    const result = processPay(payment, String(body.pan || '').trim(), String(body.exp || '').trim());
    if (result.status === '3DS_CHECKING') return html(res, otpPage(payment, null));
    if (result.status === 'REJECTED' || result.status === 'DEADLINE_EXPIRED') {
      return send(res, 302, '', { Location: redirectUrl(payment, 'fail') });
    }
    return send(res, 302, '', { Location: redirectUrl(payment, 'success') });
  }

  const otpMatch = p.match(/^\/payment\/(\d+)\/otp$/);
  if (otpMatch && req.method === 'POST') {
    const payment = state.payments[otpMatch[1]];
    if (!payment || payment.status !== '3DS_CHECKING') return send(res, 404, 'сессия не найдена');
    const result = processOtp(payment, body.code);
    if (result.status === '3DS_CHECKING') return html(res, otpPage(payment, 'Неверный код'));
    if (result.status === 'REJECTED') return send(res, 302, '', { Location: redirectUrl(payment, 'fail') });
    return send(res, 302, '', { Location: redirectUrl(payment, 'success') });
  }

  const doneMatch = p.match(/^\/payment\/(\d+)\/done$/);
  if (doneMatch && req.method === 'GET') {
    const payment = state.payments[doneMatch[1]];
    return html(res, page(`<h1>Готово</h1><div class="muted">Сессия ${doneMatch[1]} · статус: ${payment ? payment.status : 'неизвестен'}</div>`));
  }

  const rejectMatch = p.match(/^\/payment\/(\d+)\/reject$/);
  if (rejectMatch && req.method === 'POST') {
    const payment = state.payments[rejectMatch[1]];
    if (payment && ['NEW', 'FORM_SHOWED'].includes(payment.status)) {
      const r = reject(payment, '103', 'Отменено покупателем на платёжной форме');
      if (r.status === 'REJECTED') return send(res, 302, '', { Location: redirectUrl(payment, 'fail') });
    }
    return send(res, 404, 'сессия не найдена');
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

  send(res, 404, 'not found');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (e && e.code === 'BODY_TOO_LARGE') {
      try {
        sendJson(res, err(7, 'Размер тела запроса превышает допустимый лимит', e.message, {
          field: 'body',
          hint: `Уменьшите тело запроса до ${e.maxBytes} байт или менее.`,
        }), 413);
      } catch { /* headers sent */ }
      return;
    }
    console.error('[mock] request error:', e);
    try { sendJson(res, err(5000, 'Внутренняя ошибка мок-стенда')); } catch { /* headers sent */ }
  });
});

// Тик обслуживает КАЖДУЮ песочницу в её собственном контексте: очередь вебхуков
// и bank-таймеры (hold/3DS/сделки) не смешивают состояния арендаторов (F-11).
setInterval(() => {
  sandboxRuntime.tickAll(() => {
    deliveryQueue.tick().catch((e) => console.error('[mock] delivery loop:', e.message));
    tickBank();
  });
}, 1000).unref();

// Воркер TTL/лимитов (RFC-001 §8): просроченные песочницы удаляются, retention
// подчищает диагностические записи; интервал настраивается через MOCK_SANDBOX_SWEEP_MS.
const SANDBOX_SWEEP_MS = parseMsOr(process.env.MOCK_SANDBOX_SWEEP_MS, 60000);
if (SANDBOX_TTL_MS > 0 || SANDBOX_MAX_DOCUMENTS > 0 || SANDBOX_RETENTION_MS > 0) {
  setInterval(() => {
    const result = sandboxRuntime.sweep();
    if (result.expired) log(`[mock] sandbox sweep: удалено по TTL — ${result.expired}`);
  }, Math.max(1000, SANDBOX_SWEEP_MS)).unref();
}

restore();

// После загрузки во всех песочницах (default из MOCK_STATE_FILE, named — из
// реестра) перестраиваем ссылочные индексы (F-15): файл мог быть записан до их
// появления, а читатели не должны сканировать историю. Заодно выполняем F-10:
// state-файлы, сохранённые до минимизации карточных данных, могут содержать
// полный PAN в payouts — вычищаем сразу после загрузки.
sandboxRuntime.tickAll(() => {
  rebuildIndexes(state);
  const scrubbed = scrubLegacyPan(state);
  if (scrubbed) {
    log(`[mock] из состояния удалён полный PAN у ${scrubbed} выплат(ы) — хранится только маска (F-10)`);
    persist();
  }
});

if (require.main === module) {
  server.listen(parseInt(MOCK_PORT, 10), MOCK_HOST, () => {
    const port = server.address().port; // MOCK_PORT=0 -> реальный порт (освобождает тесты от фиксированных номеров)
    console.log(`[mock] T-Bank multisplit mock on http://${MOCK_HOST}:${port}`);
    console.log(`[mock] tenancy=${TENANCY} terminal=${TERMINAL_KEY} strict_token=${STRICT_TOKEN} public_base=${MOCK_PUBLIC_BASE_URL}`);
    console.log(`[mock] notifications: retry ${RETRY_MS}ms x${MAX_ATTEMPTS}${MOCK_DEFAULT_NOTIFICATION_URL ? `, fallback ${MOCK_DEFAULT_NOTIFICATION_URL}` : ', fallback none'}`);
    console.log(`[mock] control-plane: admin_token=${MOCK_ADMIN_TOKEN ? 'on' : 'off'} operator_token=${OPERATOR_TOKEN ? 'on' : 'off'} hosted=${HOSTED} block_private_webhooks=${BLOCK_PRIVATE_WEBHOOKS}`);
    console.log(`[mock] sandboxes: mode=${TENANCY} ttl_ms=${SANDBOX_TTL_MS} max=${SANDBOX_MAX} max_documents=${SANDBOX_MAX_DOCUMENTS} host_suffix=${SANDBOX_HOST_SUFFIX || '-'} registry=${sandboxRuntime.stats().file || 'memory'}${TENANCY === 'owned' && !SANDBOX_OWNER_TOKEN ? ' (default-песочница открыта: задайте MOCK_SANDBOX_TOKEN, чтобы закрыть)' : ''}`);
  });
}

module.exports = { server, state, clock, scenarios, tokenOf, CARDS, route, persist, restore, sandboxRuntime, validateRedirectDueDate, TERMINAL_KEY, TERMINAL_PASSWORD };
