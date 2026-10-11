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
  readBody, parseBody, send, sendJson, html, escapeHtml, checkAdminAuth,
  parseScenarioSpec, applyRequestChaos, createSandboxManager, verifyMerchantWebhook,
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
  MOCK_BLOCK_PRIVATE_WEBHOOKS = 'false',
  MOCK_VIRTUAL_CLOCK = '',
  MOCK_ADMIN_TOKEN = '',
} = process.env;

const TERMINAL_KEY = MOCK_TERMINAL_KEY || TBANK_TERMINAL_KEY || 'TBANKMOCKTEST';
const TERMINAL_PASSWORD = MOCK_TERMINAL_PASSWORD || TBANK_TERMINAL_PASSWORD || 'mockpass123';
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
const BLOCK_PRIVATE_WEBHOOKS = String(MOCK_BLOCK_PRIVATE_WEBHOOKS).toLowerCase() === 'true';

/* ------------------------------------------------------------------ store */

const store = core.createStore({ stateFile: MOCK_STATE_FILE, log: console.error });
const persist = store.persist;
const restore = store.restore;
const { state } = store;

Object.assign(state, {
  counters: state.counters || {
    paymentId: Date.now(),
    dealId: 50000,
    cardId: 80000,
    notificationId: 1,
    verificationId: 7000000,
    incomingId: 1,
    payoutId: 900000,
    disputeId: 30000,
    shopCode: 700100,
  },
  payments: state.payments || {},             // paymentId -> payment
  deals: state.deals || {},                   // spAccumulationId -> deal
  verifications: state.verifications || {},   // verificationId -> account verification round-trip
  incoming: state.incoming || {},             // incomingId -> поступление на спец-счёт (VER-платёж МСП)
  notifications: state.notifications || {},   // notificationId -> {payload, paymentId, attempts, nextAttemptAt, lastStatus, lastBody, dumped}
  externalRequests: state.externalRequests || {}, // ExternalRequestId -> {paymentId, status}
  payouts: state.payouts || {},               // payoutPaymentId -> выплата e2c
  disputes: state.disputes || {},             // disputeId -> {disputeId, paymentId, orderId, amount, status, reasonCode, ...}
  customers: state.customers || {},           // customerKey -> {customerKey, email, phone, createdAt}
  cards: state.cards || {},                   // cardId -> {cardId, customerKey, panMask, expDate, rebillId, status}
  shops: state.shops || {},                   // shopCode -> acqapi partner shop registration
  clockOffsetMs: state.clockOffsetMs || 0,
});

const sandboxManager = core.createSandboxManager({
  state,
  persist,
  initialStateFactory: () => ({
    counters: {
      paymentId: Date.now(),
      dealId: 50000,
      cardId: 80000,
      notificationId: 1,
      verificationId: 7000000,
      incomingId: 1,
      payoutId: 900000,
      disputeId: 30000,
      shopCode: 700100,
    },
    payments: {},
    deals: {},
    verifications: {},
    incoming: {},
    notifications: {},
    externalRequests: {},
    payouts: {},
    disputes: {},
    customers: {},
    cards: {},
    shops: {},
    clockOffsetMs: 0,
  }),
});

const clock = core.createVirtualClock({
  initial: MOCK_VIRTUAL_CLOCK,
  getStateOffset: () => state.clockOffsetMs || 0,
  setStateOffset: (v) => { state.clockOffsetMs = v; persist(); },
});

const scenarios = core.createScenarioRegistry({ clock });

/* --------------------------------------------------------------- signature */

function tokenOf(payload) {
  const values = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'Token') continue;
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') continue; // DATA, Receipt, arrays
    values.push([key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)]);
  }
  values.push(['Password', TERMINAL_PASSWORD]);
  values.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256').update(values.map(([, v]) => v).join('')).digest('hex');
}

function verifyToken(payload) {
  if (!STRICT_TOKEN) return true;
  const given = payload && payload.Token;
  if (!given || typeof given !== 'string') return false;
  const expected = tokenOf(payload);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
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
    TerminalKey: TERMINAL_KEY,
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
  entries: state.notifications,
  retryMs: RETRY_MS,
  maxAttempts: MAX_ATTEMPTS,
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
    5000: { message: 'Внутренняя ошибка мок-стенда', hint: 'Смотрите лог сервиса; если воспроизводится — это дефект мока, заводите issue.', doc: '' },
  },
});

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
    TerminalKey: TERMINAL_KEY,
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

function dealBalance(deal) {
  const incomingConfirmed = Object.values(state.payments)
    .filter((p) => p.dealId === deal.id && ['CONFIRMED', 'PARTIAL_REFUNDED', 'PARTIAL_CHARGEBACK'].includes(p.status))
    .reduce((acc, p) => acc + currentAmount(p), 0);
  const outgoingPaid = Object.values(state.payouts || {})
    .filter((po) => po.dealId === deal.id && ['CONFIRMED', 'COMPLETED'].includes(po.status))
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

/** Вычисление суммы для сценария partial-refund (процент или копейки). */
function resolvePartialAmount(rawSpec, available) {
  if (!rawSpec || rawSpec === true) return Math.max(1, Math.floor(available / 2));
  const s = String(rawSpec).trim();
  if (s.endsWith('%')) {
    const pct = parseFloat(s.slice(0, -1));
    if (Number.isFinite(pct) && pct > 0 && pct < 100) {
      return Math.max(1, Math.round((available * pct) / 100));
    }
  }
  const kop = parseInt(s, 10);
  if (Number.isFinite(kop) && kop > 0 && kop < available) return kop;
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
    const matches = Object.values(state.payments).filter((p) => p.orderId === String(body.OrderId));
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
    const parsed = parseInt(amount, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { ...err(7, 'Некорректная сумма чарджбэка: Amount должен быть целым числом > 0'), PaymentId: payment.paymentId, OrderId: payment.orderId };
    }
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

/* ------------------------------------------------------------- API logic */

function checkTerminalKey(body) {
  return body && body.TerminalKey === TERMINAL_KEY
    ? null
    : err(7, `TerminalKey «${body && body.TerminalKey}» не соответствует стенду (ожидается «${TERMINAL_KEY}»)`);
}

function handleInit(body, reqHeaders = {}) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const amount = parseInt(body.Amount, 10);
  if (!body.OrderId || !Number.isFinite(amount) || amount <= 0) {
    return err(7, 'Обязательные параметры не заполнены или невалидны (Amount, OrderId)');
  }
  if (!ALLOW_DUPLICATE_ORDER_ID) {
    const existing = Object.values(state.payments).find((p) => p.orderId === String(body.OrderId));
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

  // Валидация RedirectDueDate (1 минута ... 90 дней по доке Init)
  if (body.RedirectDueDate !== undefined && body.RedirectDueDate !== null && body.RedirectDueDate !== '') {
    const dueTs = Date.parse(String(body.RedirectDueDate));
    if (!Number.isFinite(dueTs)) {
      return err(7, `Некорректный формат RedirectDueDate «${body.RedirectDueDate}» (ожидается ISO 8601)`, null, { field: 'RedirectDueDate', doc: '/api/init' });
    }
    const maxDueTs = clock.now() + 90 * 24 * 60 * 60 * 1000;
    if (dueTs > maxDueTs) {
      return err(7, 'RedirectDueDate превышает максимальный срок жизни ссылки 90 дней', null, { field: 'RedirectDueDate', doc: '/api/init' });
    }
  }

  // Для рекуррентного платежа (Recurrent=Y) обязателен CustomerKey (или телефон/email в DATA)
  const isRecurrent = String(body.Recurrent || '').toUpperCase() === 'Y';
  if (isRecurrent && !body.CustomerKey && !(body.DATA && (body.DATA.Phone || body.DATA.Email))) {
    return err(7, 'Для рекуррентного платежа (Recurrent=Y) обязателен параметр CustomerKey (или DATA.Phone / DATA.Email)', null, { field: 'CustomerKey', doc: '/api/init' });
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
    recipientId: body.PaymentRecipientId || null,
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

  state.payments[paymentId] = payment;
  persist();

  const paymentUrl = `${MOCK_PUBLIC_BASE_URL.replace(/\/$/, '')}/payment/${paymentId}`;
  return {
    Success: true,
    ErrorCode: '0',
    Message: 'OK',
    TerminalKey: TERMINAL_KEY,
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
    const found = Object.values(state.payments)
      .filter((p) => p.orderId === String(body.OrderId))
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
  const payments = Object.values(state.payments).filter((p) => p.orderId === String(body.OrderId));
  if (!payments.length) return err(8, 'Заказ не найден');
  return {
    Success: true,
    ErrorCode: '0',
    TerminalKey: TERMINAL_KEY,
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
    amount = parseInt(body.Amount, 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ...err(7, 'Некорректная сумма подтверждения'), PaymentId: payment.paymentId };
    }
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
    const a = parseInt(body.Amount, 10);
    if (!Number.isFinite(a) || a <= 0) {
      return { ...err(7, 'Некорректная сумма отмены: Amount должен быть целым числом > 0'), PaymentId: payment.paymentId, OrderId: payment.orderId };
    }
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
    TerminalKey: TERMINAL_KEY,
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
    TerminalKey: TERMINAL_KEY,
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
    TerminalKey: TERMINAL_KEY,
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
    TerminalKey: TERMINAL_KEY,
    PaymentId: payment.paymentId,
  };
}

function handleAddCustomer(body) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const customerKey = String(body.CustomerKey || '').trim();
  if (!customerKey) return err(7, 'Обязательный параметр CustomerKey не заполнен', null, { field: 'CustomerKey' });
  state.customers[customerKey] = {
    customerKey,
    email: body.Email || null,
    phone: body.Phone || null,
    createdAt: clock.iso(),
  };
  persist();
  return { Success: true, ErrorCode: '0', TerminalKey: TERMINAL_KEY, CustomerKey: customerKey };
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
    TerminalKey: TERMINAL_KEY,
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
  return { Success: true, ErrorCode: '0', TerminalKey: TERMINAL_KEY, CustomerKey: customerKey };
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
    TerminalKey: TERMINAL_KEY,
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
    TerminalKey: TERMINAL_KEY,
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

function adminPage() {
  const payments = Object.values(state.payments)
    .sort((a, b) => b.paymentId.localeCompare(a.paymentId))
    .map((p) => {
      const deal = p.dealId ? ` · сделка ${esc(p.dealId)}` : '';
      const disp = p.disputeId ? ` · спор <code>${esc(p.disputeId)}</code> (${esc(p.disputeStatus)})` : '';
      const actions = [];
      if (p.status === 'AUTHORIZED') {
        actions.push(btn('auto-confirm-hold', p.paymentId, 'банк подтвердил холд'));
        actions.push(btn('cancel-payment', p.paymentId, 'отмена платформой (REVERSED)'));
      }
      if (p.status === 'CONFIRMED') actions.push(btn('cancel-payment', p.paymentId, 'возврат платформой (REFUNDED)'));
      if (p.status === 'CONFIRMED') actions.push(btn('chargeback-payment', p.paymentId, 'эмитент: чарджбэк (DISPUTED)'));
      if (p.disputeId && p.disputeStatus === 'DISPUTED') actions.push(btn('dispute-representment', p.disputeId, 'спор: representment'));
      if (p.disputeId && p.disputeStatus === 'REPRESENTMENT') actions.push(btn('dispute-arb', p.disputeId, 'спор: arb'));
      if (p.disputeId && ['DISPUTED', 'REPRESENTMENT', 'ARBITRATION'].includes(p.disputeStatus)) {
        actions.push(btn('dispute-won', p.disputeId, 'спор: WON'));
        actions.push(btn('dispute-lost', p.disputeId, 'спор: LOST'));
      }
      if (p.status === 'NEW') actions.push(btn('cancel-new', p.paymentId, 'отменить (NEW→CANCELED)'));
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
      return `<tr><td><code>${esc(n.id)}</code></td><td><code>${esc(n.paymentId)}</code></td><td>${esc(n.payload.Status)}</td><td>${n.attempts}</td><td>${esc(st)}</td><td>${esc(n.lastStatus ?? '—')} ${esc(String(n.lastBody ?? '').slice(0, 40))}</td><td>${btn('duplicate-notification', n.id, 'повторить')}</td></tr>`;
    })
    .join('') || '<tr><td colspan="7">нотификаций нет</td></tr>';

  const journalRows = journal.list().slice(-15).reverse()
    .map((e) => `<tr><td>${esc(e.at.slice(11, 19))}</td><td>${esc(e.method)}</td><td><code>${esc(e.path)}</code></td><td>${esc(Object.entries(e.body || {}).map(([k, v]) => `${k}=${v}`).join(' '))}</td><td>${e.status}</td><td>${e.ms} мс</td><td><code style="font-size:10px">${esc(String(e.curl || '').slice(0, 70))}…</code></td></tr>`)
    .join('') || '<tr><td colspan="7">запросов ещё не было</td></tr>';

  return page(`
    <span class="logo">T · мок банка</span>
    <h1>Консоль стенда</h1>
    <div class="muted">TerminalKey <code>${TERMINAL_KEY}</code> · профиль <code>${PROFILE}</code> · подпись ${STRICT_TOKEN ? 'строгая' : 'выключена'} · ретраи ${Math.round(RETRY_MS / 1000)}с × ${MAX_ATTEMPTS} · виртуальное время <code>${esc(clock.iso())}</code></div>
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
    <h1 style="font-size:16px">Журнал запросов к API (последние 15) — <a href="/admin/journal">json</a></h1>
    <table border="0" cellpadding="4" style="font-size:12px;width:100%">${journalRows}</table>`, true);
}

const esc = (v) => escapeHtml(v);

function btn(action, id, label) {
  return `<form method="POST" action="/admin/action" style="display:inline"><input type="hidden" name="action" value="${action}"><input type="hidden" name="id" value="${id}"><button style="width:auto;margin:2px;padding:6px 10px;font-size:12px" type="submit">${label}</button></form>`;
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

function bodySummary(body) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(body || {})) {
    if (n >= 8) break;
    if (k === 'Token' || k === 'Password') continue;
    if (v === null || v === undefined || typeof v === 'object') continue;
    out[k] = String(v).slice(0, 60);
    n += 1;
  }
  return out;
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const raw = await readBody(req);
  const body = parseBody(raw, req.headers['content-type']);

  // Мульти-тенантная изоляция песочниц (X-Mock-Sandbox или ?sandbox=)
  if (req.headers['x-mock-sandbox'] || url.searchParams.get('sandbox')) {
    sandboxManager.fromRequest(req);
  }

  // Опциональная защита /admin* по токену (A-20)
  if (p.startsWith('/admin') && !checkAdminAuth(req, MOCK_ADMIN_TOKEN)) {
    return sendJson(res, err(13, 'Доступ к /admin ограничен MOCK_ADMIN_TOKEN'), 401);
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

    // Инъекция задержек и сетевых сбоев (X-Mock-Latency, X-Mock-Scenario: latency:..., http-500, http-504)
    const chaosSpec = parseScenarioSpec(req.headers['x-mock-scenario'] || '');
    const chaosResult = await applyRequestChaos(req, chaosSpec);
    if (chaosResult.fault) {
      return sendJson(res, err(chaosResult.fault.status, chaosResult.fault.message), chaosResult.fault.status);
    }
  }

  if (req.method === 'GET' && p === '/health') {
    return sendJson(res, {
      ok: true,
      sandbox: sandboxManager.current(),
      payments: Object.keys(state.payments).length,
      deals: Object.keys(state.deals).length,
      payouts: Object.keys(state.payouts || {}).length,
      disputes: Object.keys(state.disputes || {}).length,
      shops: Object.keys(state.shops || {}).length,
    });
  }
  if (req.method === 'GET' && p === '/openapi.json') {
    const specFile = require('path').join(__dirname, '..', '..', 'docs', 'openapi', 'tbank-mock.openapi.json');
    const specObj = JSON.parse(require('fs').readFileSync(specFile, 'utf8'));
    return sendJson(res, specObj);
  }
  if (req.method === 'GET' && p === '/admin/journal') return sendJson(res, { entries: journal.list() });

  // Управление песочницами, сбросом и снимками состояния (RFC-001)
  if (p === '/mock/sandboxes') {
    if (req.method === 'GET') {
      return sendJson(res, { current: sandboxManager.current(), sandboxes: sandboxManager.list() });
    }
    if (req.method === 'POST') {
      const name = sandboxManager.switchTo((body && body.sandbox) || 'default');
      return sendJson(res, { ok: true, current: name, sandboxes: sandboxManager.list() });
    }
    if (req.method === 'DELETE') {
      const name = sandboxManager.reset((body && body.sandbox) || url.searchParams.get('sandbox') || undefined);
      return sendJson(res, { ok: true, reset: name, current: sandboxManager.current() });
    }
  }

  if (p === '/mock/reset' && req.method === 'POST') {
    const targetSandbox = (body && body.sandbox) || req.headers['x-mock-sandbox'] || undefined;
    const resetName = sandboxManager.reset(targetSandbox);
    scenarios.clearRules();
    scenarios.clearHistory();
    journal.clear();
    return sendJson(res, { ok: true, sandbox: resetName });
  }

  if (p === '/mock/state') {
    if (req.method === 'GET') {
      const targetSandbox = url.searchParams.get('sandbox') || undefined;
      return sendJson(res, {
        sandbox: targetSandbox || sandboxManager.current(),
        state: sandboxManager.exportState(targetSandbox),
      });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const targetSandbox = (body && body.sandbox) || undefined;
      const snapshot = (body && body.state) || body || {};
      const imported = sandboxManager.importState(snapshot, targetSandbox);
      return sendJson(res, { ok: true, sandbox: imported });
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
        terminalKey: TERMINAL_KEY,
        signPayload: (payload) => tokenOf(payload),
      });
      return sendJson(res, report);
    } catch (e) {
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
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Basic ')) {
      return sendJson(res, { error: 'invalid_client', error_description: 'Basic authorization header is required (Basic partner:password)' }, 401);
    }
    const token = 'mock-acqapi-bearer-' + Buffer.from(`${clock.now()}`).toString('base64').replace(/=/g, '');
    return sendJson(res, {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'sm-register',
    });
  }

  if (p === '/sm-register/register' && req.method === 'POST') {
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ')) {
      return sendJson(res, { error: 'unauthorized', message: 'Bearer token is required (получите токен в POST /oauth/token)' }, 401);
    }
    const descriptor = String(body.billingDescriptor || '').trim();
    if (!descriptor || descriptor.length > 14 || !/^[A-Za-z0-9._ -]+$/.test(descriptor)) {
      return sendJson(
        res,
        err(7, `billingDescriptor «${descriptor}» невалиден (до 14 символов: латиница, цифры, точка, пробел, дефис, подчёркивание)`, null, {
          field: 'billingDescriptor',
          doc: '03-payouts-and-deals.md',
        }),
        400,
      );
    }
    const inn = String(body.inn || (body.requisites && body.requisites.inn) || '').trim();
    if (!/^\d{10}(\d{2})?$/.test(inn)) {
      return sendJson(res, err(7, `ИНН партнёра «${inn}» должен содержать 10 или 12 цифр`, null, { field: 'inn' }), 400);
    }
    const shopCode = String(body.shopCode || (700000 + Object.keys(state.shops || {}).length + 1));
    const shop = {
      code: shopCode,
      shopCode,
      name: body.name || body.fullName || descriptor,
      inn,
      billingDescriptor: descriptor,
      email: body.email || null,
      bankAccount: body.bankAccount || body.requisites || {},
      status: 'ACTIVE',
      terminals: [
        { terminalKey: `${TERMINAL_KEY}`, type: 'ACQUIRING' },
        { terminalKey: `${TERMINAL_KEY}E2C`, type: 'PAYOUT' },
      ],
      createdAt: clock.iso(),
    };
    state.shops[shopCode] = shop;
    persist();
    return sendJson(res, shop);
  }

  const smGetMatch = p.match(/^\/sm-register\/register\/shop\/([A-Za-z0-9_-]+)$/);
  if (smGetMatch && req.method === 'GET') {
    const shop = state.shops[smGetMatch[1]];
    if (!shop) return sendJson(res, err(8, `Партнёр shopCode=«${smGetMatch[1]}» не найден`), 404);
    return sendJson(res, shop);
  }

  const smPatchMatch = p.match(/^\/sm-register\/register\/([A-Za-z0-9_-]+)$/);
  if ((smPatchMatch && req.method === 'PATCH') || (smPatchMatch && req.method === 'POST')) {
    const shop = state.shops[smPatchMatch[1]];
    if (!shop) return sendJson(res, err(8, `Партнёр shopCode=«${smPatchMatch[1]}» не найден`), 404);
    if (body.billingDescriptor !== undefined) {
      const descriptor = String(body.billingDescriptor).trim();
      if (!descriptor || descriptor.length > 14 || !/^[A-Za-z0-9._ -]+$/.test(descriptor)) {
        return sendJson(res, err(7, `billingDescriptor «${descriptor}» невалиден (до 14 символов латиницей)`, null, { field: 'billingDescriptor' }), 400);
      }
      shop.billingDescriptor = descriptor;
    }
    if (body.name) shop.name = body.name;
    if (body.email) shop.email = body.email;
    if (body.bankAccount) shop.bankAccount = { ...shop.bankAccount, ...body.bankAccount };
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
    const amount = parseInt(body.Amount, 10);
    const payerInn = String(body.PayerInn || '');
    const payerName = String(body.PayerName || '');
    if (!code || !Number.isFinite(amount) || amount <= 0 || !payerInn) {
      return sendJson(res, err(7, 'Обязательные параметры не заполнены (VerificationCode, Amount, PayerInn)'));
    }
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
    state.incoming[incomingId] = incoming;
    persist();
    console.log(`[mock] incoming ${incomingId}: ${code} ${amount}коп от ${payerInn}`);
    const webhookUrl = String(body.NotificationURL || MOCK_DEFAULT_NOTIFICATION_URL || '');
    if (webhookUrl) {
      const payload = {
        TerminalKey: TERMINAL_KEY,
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
    const amount = parseInt(body.Amount, 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      return sendJson(res, err(7, 'Обязательные параметры не заполнены (Amount)'));
    }
    const dealId = body.DealId !== undefined && body.DealId !== null && body.DealId !== '' ? String(body.DealId) : null;
    if (dealId) {
      const deal = findDeal(dealId);
      if (!deal) {
        return sendJson(res, err(8, `Сделка DealId=«${dealId}» не найдена`, null, { field: 'DealId' }));
      }
      if (deal.status !== 'open') {
        return sendJson(res, err(32, `Выплата по сделке «${dealId}» невозможна: сделка закрыта (status=${deal.status})`, null, { field: 'DealId' }));
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
    }
    const payoutPaymentId = 'P-' + String(state.counters.payoutId++);
    const finalPayout = body.FinalPayout === true || body.FinalPayout === 'true';
    state.payouts[payoutPaymentId] = {
      paymentId: payoutPaymentId,
      amount,
      orderId: String(body.OrderId || ''),
      customerKey: String(body.CustomerKey || ''),
      dealId,
      finalPayout,
      cardId: body.CardId ? String(body.CardId) : null,
      pan: body.Pan ? String(body.Pan) : null,
      phone: body.Phone ? String(body.Phone) : null,
      bankMemberId: body.BankMemberId ? String(body.BankMemberId) : null,
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
    persist();
    console.log(`[mock] e2c Init ${payoutPaymentId}: ${amount}коп, order=${body.OrderId || ''}${dealId ? `, deal=${dealId}` : ''}`);
    return sendJson(res, {
      Success: true,
      ErrorCode: '0',
      TerminalKey: body.TerminalKey || TERMINAL_KEY,
      PaymentId: payoutPaymentId,
      OrderId: String(body.OrderId || ''),
      Amount: amount,
      DealId: dealId || undefined,
      Status: 'NEW',
    });
  }

  if (p === '/e2c/v2/Payment' && req.method === 'POST') {
    if (!verifyToken(body)) return sendJson(res, err(13, 'Неверный Token (подпись) запроса'));
    const payout = state.payouts[String(body.PaymentId || '')];
    if (!payout) return sendJson(res, err(4, 'Выплата не найдена'));
    if (payout.status !== 'NEW' && payout.status !== 'CHECKED') {
      return sendJson(res, err(32, 'Неверный статус выплаты: ' + payout.status));
    }
    // Официальный тестовый кейс выплаты с ошибкой: карта 5000000000000553 -> REJECTED 1057
    if (payout.pan === '5000000000000553' || payout.cardId === '5000000000000553') {
      payout.status = 'REJECTED';
      payout.errorCode = '1057';
      payout.statusHistory.push({ status: 'REJECTED', at: clock.iso() });
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
    payout.status = 'CONFIRMED';
    payout.statusHistory.push({ status: 'CONFIRMED', at: clock.iso() });
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
    const payout = state.payouts[String(body.PaymentId || '')];
    if (!payout) return sendJson(res, err(4, 'Выплата не найдена'));
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

  if (p === '/e2c/v2/CancelPayment' && req.method === 'POST') {
    if (!verifyToken(body)) return sendJson(res, err(13, 'Неверный Token (подпись) запроса'));
    const payout = state.payouts[String(body.PaymentId || '')];
    if (!payout) return sendJson(res, err(4, 'Выплата не найдена'));
    if (payout.status === 'REJECTED' || payout.status === 'CANCELED') {
      return sendJson(res, err(32, `Выплата уже в статусе ${payout.status}`));
    }
    payout.status = 'CANCELED';
    payout.statusHistory.push({ status: 'CANCELED', at: clock.iso() });
    persist();
    return sendJson(res, {
      Success: true,
      ErrorCode: '0',
      PaymentId: payout.paymentId,
      Status: 'CANCELED',
      DealId: payout.dealId || undefined,
    });
  }

  if (p === '/e2c/v2/GetSbpMembers' && req.method === 'POST') {
    if (!verifyToken(body)) return sendJson(res, err(13, 'Неверный Token (подпись) запроса'));
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
    const amount = parseInt(body.Amount, 10);
    if (!code || !Number.isFinite(amount) || amount <= 0) {
      return sendJson(res, err(7, 'Обязательные параметры не заполнены (VerificationCode, Amount)'));
    }
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
    state.verifications[verificationId] = verification;
    persist();
    console.log(`[mock] account verification ${verificationId}: ${code} ${amount}коп — прогон завершён (RETURNED)`);
    return sendJson(res, {
      Success: true,
      ErrorCode: '0',
      TerminalKey: TERMINAL_KEY,
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
      console.log(`[mock] ${method} token FAIL. payload:`, JSON.stringify({ ...body, Token: `<${String(body.Token || '').slice(0, 8)}…>`, expected: `<${tokenOf(body).slice(0, 8)}…>` }));
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

  if (p === '/admin' && req.method === 'GET') return html(res, adminPage());

  if (p === '/admin/action' && req.method === 'POST') {
    const result = adminAction(body);
    return send(res, 302, '', { Location: result.redirect });
  }

  send(res, 404, 'not found');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    console.error('[mock] request error:', e);
    try { sendJson(res, err(5000, 'Внутренняя ошибка мок-стенда')); } catch { /* headers sent */ }
  });
});

setInterval(() => {
  deliveryQueue.tick().catch((e) => console.error('[mock] delivery loop:', e.message));
  tickBank();
}, 1000).unref();

restore();

if (require.main === module) {
  server.listen(parseInt(MOCK_PORT, 10), MOCK_HOST, () => {
    console.log(`[mock] T-Bank multisplit mock on http://${MOCK_HOST}:${MOCK_PORT}`);
    console.log(`[mock] terminal=${TERMINAL_KEY} strict_token=${STRICT_TOKEN} public_base=${MOCK_PUBLIC_BASE_URL}`);
    console.log(`[mock] notifications: retry ${RETRY_MS}ms x${MAX_ATTEMPTS}${MOCK_DEFAULT_NOTIFICATION_URL ? `, fallback ${MOCK_DEFAULT_NOTIFICATION_URL}` : ', fallback none'}`);
  });
}

module.exports = { server, state, clock, scenarios, tokenOf, CARDS, route, persist, restore, TERMINAL_KEY, TERMINAL_PASSWORD };
