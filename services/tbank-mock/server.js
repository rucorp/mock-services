'use strict';

/*
 * T-Bank Multisplit mock stand (wave 1: payments + notifications).
 *
 * Emulates the bank side of the EACQ Multisplit contract without the bank's
 * test contour: /v2/{Init,Confirm,Cancel,GetState,CheckOrder}, the hosted
 * payment form with test-card scenarios (PAN-driven), signed http
 * notifications to the merchant webhook with the bank retry policy, a deal
 * book (SpAccumulation) and a text admin console at /admin.
 *
 * Zero npm dependencies. Config via environment, see README.md in this dir.
 * Secrets are fake by definition; never expose this service publicly.
 */

const http = require('http');
const crypto = require('crypto');

const core = require('../../packages/core');
const { readBody, parseBody, send, sendJson, html, escapeHtml } = core;
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
} = process.env;

const TERMINAL_KEY = MOCK_TERMINAL_KEY || TBANK_TERMINAL_KEY || 'TBANKMOCKTEST';
const TERMINAL_PASSWORD = MOCK_TERMINAL_PASSWORD || TBANK_TERMINAL_PASSWORD || 'mockpass123';
const RETRY_MS = Math.max(1000, parseInt(MOCK_RETRY_MS, 10) || 60000);
const MAX_ATTEMPTS = Math.max(1, parseInt(MOCK_MAX_ATTEMPTS, 10) || 24);
const STRICT_TOKEN = String(MOCK_STRICT_TOKEN).toLowerCase() !== 'false';
// Bank auto-confirms holds after 4-7 days; here it is accelerated to N ms
// (0 = disabled, confirm via admin console button instead).
const AUTO_CONFIRM_MS = Math.max(0, parseInt(MOCK_AUTO_CONFIRM_MS, 10) || 0);
const ALLOW_DUPLICATE_ORDER_ID = String(MOCK_ALLOW_DUPLICATE_ORDER_ID).toLowerCase() === 'true';
// Провайдеро-нейтральность (аудит §3.1): plain — обычный эквайринг (дефолт,
// 99% интеграций), multisplit — профиль Lovii со сделками. В plain мульти-
// расчётные поля игнорируются, как незнакомые реальному банку без Мультирасчетов.
const PROFILE = String(MOCK_PROFILE).toLowerCase() === 'multisplit' ? 'multisplit' : 'plain';
// Для публичного стенда включайте принудительно: иначе мок становится
// SSRF-прокси (NotificationURL задаёт интегратор).
const BLOCK_PRIVATE_WEBHOOKS = String(MOCK_BLOCK_PRIVATE_WEBHOOKS).toLowerCase() === 'true';

/* ------------------------------------------------------------------ store */

const store = core.createStore({ stateFile: MOCK_STATE_FILE, log: console.error });
const persist = store.persist;
const restore = store.restore;
const { state } = store;

Object.assign(state, {
  // База счётчика платежей из времени старта: состояние в памяти, и после
  // рестарта контейнера счётчик с фиксированной базой начинал выдавать уже
  // использованные id (unique violation в payments.provider_payment_id).
  // Date.now()-база делает id уникальными для любого времени жизни процесса.
  counters: state.counters || { paymentId: Date.now(), dealId: 50000, cardId: 80000, notificationId: 1, verificationId: 7000000, incomingId: 1, payoutId: 900000 },
  payments: state.payments || {},   // paymentId -> payment
  deals: state.deals || {},         // spAccumulationId -> deal
  verifications: state.verifications || {}, // verificationId -> account verification round-trip
  incoming: state.incoming || {},   // incomingId -> поступление на спец-счёт (VER-платёж МСП)
  notifications: state.notifications || {}, // notificationId -> {payload, paymentId, attempts, nextAttemptAt, lastStatus, lastBody, dumped}
  externalRequests: state.externalRequests || {}, // ExternalRequestId -> {paymentId, status}
  payouts: state.payouts || {},     // payoutPaymentId -> выплата e2c (Б-5 репетиция; старые state.json без e2c)
});

/* --------------------------------------------------------------- signature */

// Mirrors the bank (and lovii-core TBankSignature): values of all top-level
// scalar parameters except Token, nested structures, null and ''; booleans in
// lowercase; sorted by key; concatenated; terminal password appended; sha256.
function tokenOf(payload) {
  const values = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'Token') continue;
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') continue; // DATA, Receipt, arrays
    values.push([key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)]);
  }
  // T-Bank spec (acb0db8, doc-пример Pan < Password < PaymentId): пара с
  // паролем участвует в сортировке наравне со всеми, пароль попадает в
  // середину конкатенации. Должно совпадать с lovii-core TBankSignature.
  values.push(['Password', TERMINAL_PASSWORD]);
  values.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256').update(values.map(([, v]) => v).join('')).digest('hex');
}

function verifyToken(payload) {
  if (!STRICT_TOKEN) return true;
  const given = payload && payload.Token;
  if (!given || typeof given !== 'string') return false;
  const expected = tokenOf(payload);
  // timingSafeEqual бросает RangeError на разной длине — голая проверка
  // превращала «Token: abc» в 5000 «внутренняя ошибка» вместо кода 13
  // (дефект A-5 аудита).
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/* ------------------------------------------------------------ test cards */

// Behavior keyed by PAN, mirroring the bank's test card list
// (oplata_multisplit.pdf §7): success / challenge / insufficient / reject.
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

const NOTIFIED_STATUSES = new Set(['AUTHORIZED', 'CONFIRMED', 'REVERSED', 'PARTIAL_REVERSED', 'REFUNDED', 'PARTIAL_REFUNDED', 'REJECTED', 'CHARGEBACK', 'PARTIAL_CHARGEBACK']);

function scheduleNotification(payment, status, extra = {}) {
  if (!NOTIFIED_STATUSES.has(status)) return;
  const url = payment.notificationUrl || MOCK_DEFAULT_NOTIFICATION_URL;
  if (!url) {
    console.log(`[mock] ${payment.paymentId}: no notification URL, skip ${status}`);
    return;
  }
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
  const id = String(state.counters.notificationId++);
  state.notifications[id] = {
    id,
    paymentId: payment.paymentId,
    url,
    payload,
    attempts: 0,
    nextAttemptAt: 0,
    lastStatus: null,
    lastBody: null,
    dumped: false,
  };
  persist();
  console.log(`[mock] notification ${id} queued: ${payment.paymentId} -> ${status}`);
}

function currentAmount(payment) {
  if (payment.remaining !== null && payment.remaining !== undefined) return payment.remaining;
  return payment.amount;
}

// Банк подтверждён, когда мерчант ответил 200 с телом «OK» (контракт).
// После MAX_ATTEMPTS попыток нотификация уходит в dumped (видна в /admin).
const deliveryQueue = core.createDeliveryQueue({
  entries: state.notifications,
  retryMs: RETRY_MS,
  maxAttempts: MAX_ATTEMPTS,
  persist,
  log,
  request: (n) => ({ url: n.url, data: n.payload }),
  isOk: (res) => res.statusCode === 200 && String(res.body || '').trim() === 'OK',
  blockPrivateHosts: BLOCK_PRIVATE_WEBHOOKS,
  due: (n) => !n.done && !n.dumped && (n.nextAttemptAt || 0) <= Date.now(),
  prepare: (n) => { n.attempts += 1; },
  onFailure: (n, status, body) => {
    n.lastStatus = status;
    n.lastBody = body;
    if (n.attempts >= MAX_ATTEMPTS) {
      n.dumped = true;
      log(`notification ${n.id} dumped after ${n.attempts} attempts`);
    } else {
      n.nextAttemptAt = Date.now() + RETRY_MS;
    }
  },
});

/* -------------------------------------------------------------- helpers */

// DX-слой (спека §6.2): известные коды ошибок разложены на объяснение,
// поле, рекомендацию и ссылку на раздел официальной документации.
const derr = core.createErrorCatalog({
  provider: 'tbank-eacq',
  docsBase: 'https://developer.tbank.ru/eacq',
  codes: {
    7: { message: 'Обязательные параметры не заполнены или невалидны', field: 'Amount, OrderId', hint: 'Проверьте: Amount — целое число в копейках больше нуля (100000 = 1000,00 ₽), OrderId — непустая строка и уникален для каждой операции (повторный Init с тем же OrderId отклоняется — как в банке), сумма Cancel/Confirm не больше доступной суммы платежа.', doc: '/api/init' },
    8: { message: 'Объект не найден', field: 'PaymentId | OrderId', hint: 'Платёж не найден ни по PaymentId, ни по OrderId (GetState принимает оба). Платёжные сессии живут в состоянии стенда; после рестарта с пустым MOCK_STATE_FILE старые id недоступны.', doc: '/api/getstate' },
    13: { message: 'Неверный Token (подпись) запроса', field: 'Token', hint: 'Подпись = sha256(значения всех top-level скаляров кроме Token/null/\'\' + Password, отсортированные по ключу, в нижнем регистре для boolean). Сверьте с conspectus docs/reference/tbank/02-notifications-signature.md.', doc: '/intro/to-api' },
    32: { message: 'Операция недоступна в текущем статусе', field: 'PaymentId', hint: 'Переход запрещён машиной состояний: Confirm — только из AUTHORIZED; Cancel — из NEW (CANCELED), AUTHORIZED (REVERSED/PARTIAL_REVERSED), CONFIRMED (REFUNDED/PARTIAL_REFUNDED). История статусов платежа — в /admin.', doc: '/api/confirm' },
    501: { message: 'Метод не поддерживается мок-стендом', hint: 'Стенд реализует волну 1: Init/Confirm/Cancel/GetState/CheckOrder + e2c/AV. Остальные методы — по мере надобности.', doc: '' },
    5000: { message: 'Внутренняя ошибка мок-стенда', hint: 'Смотрите лог сервиса; если воспроизводится — это дефект мока, заводите issue.', doc: '' },
  },
});

function err(code, message, details) {
  const desc = derr(code, { message: message || undefined, details });
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
  };
}

function findDeal(id) {
  return id ? state.deals[String(id)] || null : null;
}

function setStatus(payment, status) {
  payment.status = status;
  payment.statusHistory.push({ status, at: new Date().toISOString() });
  payment[statusCamel(status) + 'At'] = new Date().toISOString();
}

function statusCamel(s) {
  const parts = s.split('_').map((p) => p[0] + p.slice(1).toLowerCase());
  const out = parts.join('');
  return out[0].toLowerCase() + out.slice(1);
}

function dealBalance(deal) {
  return Object.values(state.payments)
    .filter((p) => p.dealId === deal.id)
    .reduce((acc, p) => acc + currentAmount(p), 0);
}

/* ------------------------------------------------------------- API logic */

function checkTerminalKey(body) {
  // Правильный TerminalKey — половина успешной интеграции; банк отвечает
  // ошибкой на чужой терминал, мок раньше принимал любой (дефект A-15).
  return body && body.TerminalKey === TERMINAL_KEY ? null : err(7, `TerminalKey «${body && body.TerminalKey}» не соответствует стенду (ожидается «${TERMINAL_KEY}»)`);
}

function handleInit(body) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const amount = parseInt(body.Amount, 10);
  if (!body.OrderId || !Number.isFinite(amount) || amount <= 0) {
    return err(7, 'Обязательные параметры не заполнены или невалидны (Amount, OrderId)');
  }
  // Официальная дока Init: «OrderId… Должен быть уникальным для каждой
  // операции». Банк отклоняет повторный Init с тем же OrderId, а мок раньше
  // молча создавал вторую сессию (дефект A-6 аудита): CheckOrder возвращал
  // «две попытки» там, где в бою была бы одна, и ломались идемпотентные
  // повторы Init на ретраях сети.
  if (!ALLOW_DUPLICATE_ORDER_ID) {
    const existing = Object.values(state.payments).find((p) => p.orderId === String(body.OrderId));
    if (existing) {
      return err(7, `OrderId «${body.OrderId}» уже использован (PaymentId=${existing.paymentId}, статус ${existing.status})`);
    }
  }
  let dealId = null;
  const createDeal = String(body.CreateDealWithType || '').toUpperCase() === 'NN';
  if (PROFILE === 'plain' && !body.DealId && !createDeal) {
    // plain-профиль: сделочные поля не приходят — платёж без сделки, как в
    // классическом эквайринге. PaymentRecipientId/CreateDealWithType не
    // являются ошибкой (банк без Мультирасчетов просто не знает этих полей).
  } else if (body.DealId) {
    const deal = findDeal(body.DealId);
    if (!deal || deal.status === 'closed') {
      return err(7, 'Сделка не найдена или закрыта', `DealId=${body.DealId}`);
    }
    dealId = deal.id;
  } else if (createDeal) {
    dealId = String(state.counters.dealId++);
    state.deals[dealId] = { id: dealId, type: 'NN', status: 'open', createdAt: new Date().toISOString() };
  } else if (body.PaymentRecipientId) {
    // Multisplit requires either an existing deal or deal creation flag.
    return err(7, 'Не переданы DealId или CreateDealWithType=NN');
  }

  const paymentId = String(state.counters.paymentId++);
  const payment = {
    paymentId,
    orderId: String(body.OrderId),
    amount,
    status: 'NEW',
    statusHistory: [{ status: 'NEW', at: new Date().toISOString() }],
    createdAt: new Date().toISOString(),
    dealId,
    recipientId: body.PaymentRecipientId || null,
    customerKey: body.CustomerKey || null,
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
  };
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
  // Дока GetState допускает идентификацию платежа как PaymentId, так и
  // OrderId; мок понимал только PaymentId, а подсказка ошибки обещала оба
  // (дефект A-9 аудита).
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
      Success: !['REJECTED', 'AUTH_FAIL', 'CANCELED', 'DEADLINE_EXPIRED'].includes(p.status),
      ErrorCode: p.status === 'REJECTED' ? String(p.failCode || '9999') : '0',
      Message: p.status === 'REJECTED' ? String(p.failMessage || 'Ошибка') : 'ok',
    })),
  };
}

function handleConfirm(body) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const payment = state.payments[String(body.PaymentId)];
  if (!payment) return err(8, 'PaymentId не найден');
  if (payment.status !== 'AUTHORIZED') {
    // A-8: раньше здесь возвращался код 8 («объект не найден») — интегратор
    // искал несуществующий платёж вместо нарушения порядка статусов.
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
  setStatus(payment, 'CONFIRMING');
  payment.confirmedAmount = amount;
  payment.remaining = amount;
  setStatus(payment, 'CONFIRMED');
  persist();
  scheduleNotification(payment, 'CONFIRMED');
  return baseResponse(payment);
}

function handleCancel(body) {
  const badTerminal = checkTerminalKey(body);
  if (badTerminal) return badTerminal;
  const payment = state.payments[String(body.PaymentId)];
  if (!payment) return err(8, 'PaymentId не найден');

  const externalId = body.ExternalRequestId ? String(body.ExternalRequestId) : null;
  if (externalId && state.externalRequests[externalId]) {
    // Idempotent refund: return current state without a new operation.
    return { ...baseResponse(payment), OriginalAmount: currentAmount(payment), NewAmount: currentAmount(payment), ExternalRequestId: externalId };
  }

  const before = payment.status;
  const originalAmount = currentAmount(payment);
  if (before === 'NEW' && body.Amount !== undefined && body.Amount !== null && body.Amount !== '') {
    // Дока /Cancel: «При отмене операции в статусе NEW поле Amount
    // игнорируется… Отмена проводится на полную сумму» — так и делаем.
  }
  let cancelAmount = originalAmount;
  if (body.Amount !== undefined && body.Amount !== null && body.Amount !== '') {
    const a = parseInt(body.Amount, 10);
    if (!Number.isFinite(a) || a <= 0) {
      return { ...err(7, 'Некорректная сумма отмены: Amount должен быть целым числом > 0'), PaymentId: payment.paymentId, OrderId: payment.orderId };
    }
    // Раньше Amount больше суммы платежа молча игнорировался и выполнялся
    // ПОЛНЫЙ возврат с Success=true (дефект A-7 аудита) — баг интегратора
    // («вернули больше, чем приняли») выглядел как успешная операция.
    if (a > originalAmount) {
      return {
        ...err(7, `Сумма отмены ${a} больше доступной суммы ${originalAmount}`),
        PaymentId: payment.paymentId,
        OrderId: payment.orderId,
        OriginalAmount: originalAmount,
      };
    }
    cancelAmount = a;
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
  scheduleNotification(payment, t[1]);
  if (externalId) state.externalRequests[externalId] = { paymentId: payment.paymentId, status: payment.status };
  return { ...baseResponse(payment), OriginalAmount: originalAmount, NewAmount: currentAmount(payment), ExternalRequestId: externalId || undefined };
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
    <div class="muted">Тестовый стенд Т-Банк Мультирасчеты · сессия ${payment.paymentId}</div>
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
  if (due !== null && Number.isFinite(due) && due < Date.now()) {
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
  setStatus(payment, payment.payType === 'O' ? 'CONFIRMED' : 'AUTHORIZED');
  if (payment.payType === 'O') payment.confirmedAmount = payment.amount;
  persist();
  if (payment.payType === 'O') scheduleNotification(payment, 'CONFIRMED');
  else scheduleNotification(payment, 'AUTHORIZED');
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

/* -------------------------------------------------------------- admin */

function adminPage() {
  const payments = Object.values(state.payments)
    .sort((a, b) => b.paymentId.localeCompare(a.paymentId))
    .map((p) => {
      const deal = p.dealId ? ` · сделка ${esc(p.dealId)}` : '';
      const actions = [];
      if (p.status === 'AUTHORIZED') {
        actions.push(btn('auto-confirm-hold', p.paymentId, 'банк подтвердил холд'));
        actions.push(btn('cancel-payment', p.paymentId, 'отмена платформой (REVERSED)'));
      }
      if (p.status === 'CONFIRMED') actions.push(btn('cancel-payment', p.paymentId, 'возврат платформой (REFUNDED)'));
      if (p.status === 'CONFIRMED') actions.push(btn('chargeback-payment', p.paymentId, 'эмитент зафиксировал чарджбэк (CHARGEBACK)'));
      if (p.status === 'NEW') actions.push(btn('cancel-new', p.paymentId, 'отменить (NEW→CANCELED)'));
      const hist = p.statusHistory.map((h) => `${h.status}<span style="color:#bbb">@${h.at.slice(11, 19)}</span>`).join('<span style="color:#ccc"> → </span>');
      return `<tr><td><code>${esc(p.paymentId)}</code></td><td>${esc(p.orderId)}<div style="font-size:10px;color:#888;margin-top:3px">${hist}</div></td><td>${(p.amount / 100).toFixed(2)}</td><td><b>${esc(p.status)}</b></td><td>${deal}</td><td>${actions.join(' ')}</td></tr>`;
    })
    .join('') || '<tr><td colspan="6">платежей нет</td></tr>';

  const deals = Object.values(state.deals)
    .map((d) => `<tr><td><code>${esc(d.id)}</code></td><td>${esc(d.status)}</td><td>${(dealBalance(d) / 100).toFixed(2)} ₽</td></tr>`)
    .join('') || '<tr><td colspan="3">сделок нет</td></tr>';

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
      const st = n.dumped ? 'dumped' : n.done ? 'delivered' : `retry@${new Date(n.nextAttemptAt || Date.now()).toISOString().slice(11, 19)}`;
      return `<tr><td><code>${esc(n.id)}</code></td><td><code>${esc(n.paymentId)}</code></td><td>${esc(n.payload.Status)}</td><td>${n.attempts}</td><td>${esc(st)}</td><td>${esc(n.lastStatus ?? '—')} ${esc(String(n.lastBody ?? '').slice(0, 40))}</td><td>${btn('duplicate-notification', n.id, 'повторить')}</td></tr>`;
    })
    .join('') || '<tr><td colspan="7">нотификаций нет</td></tr>';

  const journalRows = journal.list().slice(-15).reverse()
    .map((e) => `<tr><td>${esc(e.at.slice(11, 19))}</td><td>${esc(e.method)}</td><td><code>${esc(e.path)}</code></td><td>${esc(Object.entries(e.body || {}).map(([k, v]) => `${k}=${v}`).join(' '))}</td><td>${e.status}</td><td>${e.ms} мс</td></tr>`)
    .join('') || '<tr><td colspan="6">запросов ещё не было</td></tr>';

  return page(`
    <span class="logo">T · мок банка</span>
    <h1>Консоль стенда</h1>
    <div class="muted">TerminalKey <code>${TERMINAL_KEY}</code> · подпись ${STRICT_TOKEN ? 'строгая' : 'выключена'} · ретраи ${Math.round(RETRY_MS / 1000)}с × ${MAX_ATTEMPTS} · авто-обновление 2 с</div>
    <div style="background:#fff8e1;border:1px solid #f0d47a;border-radius:10px;padding:8px 10px;margin-bottom:10px;font-size:13px">⚠ Платежи проводятся <b>только по тестовым картам</b> из списка ниже — любая другая карта отклоняется (решение владельца 19.09). Пресеты — на форме оплаты.</div>
    <div class="muted">Обновлено ${new Date().toLocaleTimeString('ru-RU')}</div>
    <h1 style="font-size:16px">Платежи</h1>
    <table border="0" cellpadding="4" style="font-size:13px;width:100%">${payments}</table>
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
      // Bank-side auto-confirmation of the hold (Visa Electron 4d / other 7d).
      payment.confirmedAmount = payment.amount;
      setStatus(payment, 'CONFIRMED');
      persist();
      scheduleNotification(payment, 'CONFIRMED');
    }
  } else if (action === 'cancel-new') {
    const payment = state.payments[String(id)];
    if (payment && payment.status === 'NEW') {
      setStatus(payment, 'CANCELED');
      persist();
    }
  } else if (action === 'cancel-payment') {
    // Platform calls POST /v2/Cancel: AUTHORIZED→REVERSED, CONFIRMED→REFUNDED.
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
    // Эмитент/банк зафиксировал чарджбэк по подтверждённому платежу:
    // состояние банка становится CHARGEBACK, ядро узнаёт по нотификации и
    // переспрашивает GetState (подпись обязательна — контракт §4.2).
    const payment = state.payments[String(id)];
    if (payment && payment.status === 'CONFIRMED') {
      setStatus(payment, 'CHARGEBACK');
      payment.remaining = 0;
      persist();
      scheduleNotification(payment, 'CHARGEBACK');
      console.log(`[mock] issuer chargeback: ${payment.paymentId} -> CHARGEBACK`);
    }
  } else if (action === 'duplicate-notification') {
    const n = state.notifications[String(id)];
    if (n) {
      // Duplicate delivery for merchant idempotency checks.
      const copy = { ...n, id: String(state.counters.notificationId++), attempts: 0, nextAttemptAt: 0, lastStatus: null, lastBody: null, dumped: false };
      state.notifications[copy.id] = copy;
      persist();
    }
  }
  return { redirect: '/admin' };
}

/* ------------------------------------------------------------------ http */


/** Короткая выжимка запроса для журнала: скаляры, без подписи и вложений. */
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

  // Журналируем только API-вызовы (не страницы формы и не поллинг /admin).
  if (/^\/(v2|e2c\/v2|av\/v1)\//.test(p)) {
    const started = Date.now();
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (code, ...rest) => {
      journal.record({ method: req.method, path: p, status: code, ms: Date.now() - started, body: bodySummary(body) });
      return originalWriteHead(code, ...rest);
    };
  }

  if (req.method === 'GET' && p === '/health') return sendJson(res, { ok: true, payments: Object.keys(state.payments).length, deals: Object.keys(state.deals).length, payouts: Object.keys(state.payouts || {}).length });
  if (req.method === 'GET' && p === '/admin/journal') return sendJson(res, { entries: journal.list() });

  // Платёжное поручение МСП на сумму верификации: банк создаёт поступление
  // на спец-счёт платформы (VER-код в назначении) и уведомляет платформу.
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
      createdAt: new Date().toISOString(),
    };
    state.incoming[incomingId] = incoming;
    persist();
    console.log(`[mock] incoming ${incomingId}: ${code} ${amount}коп от ${payerInn}`);
    // Вебхук поступления платформе — подписанный, ретраи как у нотификаций.
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

  // ── E2C-выплаты (Б-5, репетиция реестров без банка; OpenAPI Массовые выплаты)
  // Init → Payment → GetState. Мок исполняет выплату сразу (синхронно),
  // реквизиты получателя — прозрачно для мока (в бою это маршрут до получателя).
  if (p === '/e2c/v2/Init' && req.method === 'POST') {
    if (!verifyToken(body)) return sendJson(res, err(13, 'Неверный Token (подпись) запроса'));
    const amount = parseInt(body.Amount, 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      return sendJson(res, err(7, 'Обязательные параметры не заполнены (Amount)'));
    }
    const payoutPaymentId = 'P-' + String(state.counters.payoutId++);
    state.payouts[payoutPaymentId] = {
      paymentId: payoutPaymentId,
      amount,
      orderId: String(body.OrderId || ''),
      customerKey: String(body.CustomerKey || ''),
      recipient: {
        account: String(body.Account || ''),
        bank: String(body.Bank || ''),
        inn: String(body.PayerInn || body.RecipientInn || ''),
        name: String(body.RecipientName || ''),
      },
      status: 'NEW',
      statusHistory: [{ status: 'NEW', at: new Date().toISOString() }],
      createdAt: new Date().toISOString(),
    };
    persist();
    console.log(`[mock] e2c Init ${payoutPaymentId}: ${amount}коп, order=${body.OrderId || ''}`);
    return sendJson(res, { Success: true, ErrorCode: '0', PaymentId: payoutPaymentId, Status: 'NEW' });
  }

  if (p === '/e2c/v2/Payment' && req.method === 'POST') {
    if (!verifyToken(body)) return sendJson(res, err(13, 'Неверный Token (подпись) запроса'));
    const payout = state.payouts[String(body.PaymentId || '')];
    if (!payout) return sendJson(res, err(4, 'Выплата не найдена'));
    if (payout.status !== 'NEW') return sendJson(res, err(32, 'Неверный статус выплаты: ' + payout.status));
    payout.status = 'CONFIRMED';
    payout.statusHistory.push({ status: 'CONFIRMED', at: new Date().toISOString() });
    persist();
    console.log(`[mock] e2c Payment ${payout.paymentId}: CONFIRMED ${payout.amount}коп`);
    return sendJson(res, { Success: true, ErrorCode: '0', PaymentId: payout.paymentId, Status: 'CONFIRMED' });
  }

  if (p === '/e2c/v2/GetState' && req.method === 'POST') {
    if (!verifyToken(body)) return sendJson(res, err(13, 'Неверный Token (подпись) запроса'));
    const payout = state.payouts[String(body.PaymentId || '')];
    if (!payout) return sendJson(res, err(4, 'Выплата не найдена'));
    return sendJson(res, {
      Success: true,
      ErrorCode: '0',
      PaymentId: payout.paymentId,
      Status: payout.status,
      Amount: payout.amount,
      OrderId: payout.orderId,
    });
  }

  // Account verification: платформа просит банк сделать «прогон рубля» по
  // счёту МСП — банк зачисляет Amount и сразу возвращает его (финальный
  // статус RETURNED, деньги нигде не остаются). Синхронный контракт: ответ
  // приходит, когда прогон уже завершён.
  if (p === '/av/v1/verification' && req.method === 'POST') {
    if (!verifyToken(body)) return sendJson(res, err(13, 'Неверный Token (подпись) запроса'));
    const code = String(body.VerificationCode || '');
    const amount = parseInt(body.Amount, 10);
    if (!code || !Number.isFinite(amount) || amount <= 0) {
      return sendJson(res, err(7, 'Обязательные параметры не заполнены (VerificationCode, Amount)'));
    }
    const verificationId = String(state.counters.verificationId++);
    const now = () => new Date().toISOString();
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
    const handlers = { Init: handleInit, GetState: handleGetState, Confirm: handleConfirm, Cancel: handleCancel, CheckOrder: handleCheckOrder };
    const handler = handlers[method];
    if (!handler) return sendJson(res, err(501, `Метод ${method} мок-стендом пока не поддерживается`));
    if (!verifyToken(body)) {
      console.log(`[mock] ${method} token FAIL. payload:`, JSON.stringify({ ...body, Token: `<${String(body.Token || '').slice(0, 8)}…>`, expected: `<${tokenOf(body).slice(0, 8)}…>` }));
      return sendJson(res, err(13, 'Неверный Token (подпись) запроса'));
    }
    return sendJson(res, handler(body));
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
  if (AUTO_CONFIRM_MS > 0) {
    const deadline = Date.now() - AUTO_CONFIRM_MS;
    for (const payment of Object.values(state.payments)) {
      if (payment.status !== 'AUTHORIZED' || !payment.authorizedAt || Date.parse(payment.authorizedAt) > deadline) continue;
      payment.confirmedAmount = payment.amount;
      payment.remaining = payment.amount;
      setStatus(payment, 'CONFIRMED');
      persist();
      scheduleNotification(payment, 'CONFIRMED');
      console.log(`[mock] auto-confirmed hold ${payment.paymentId} after ${AUTO_CONFIRM_MS}ms (bank does this in 4-7 days)`);
    }
  }
}, 1000);

restore();

if (require.main === module) {
  server.listen(parseInt(MOCK_PORT, 10), MOCK_HOST, () => {
    console.log(`[mock] T-Bank multisplit mock on http://${MOCK_HOST}:${MOCK_PORT}`);
    console.log(`[mock] terminal=${TERMINAL_KEY} strict_token=${STRICT_TOKEN} public_base=${MOCK_PUBLIC_BASE_URL}`);
    console.log(`[mock] notifications: retry ${RETRY_MS}ms x${MAX_ATTEMPTS}${MOCK_DEFAULT_NOTIFICATION_URL ? `, fallback ${MOCK_DEFAULT_NOTIFICATION_URL}` : ', fallback none'}`);
  });
}

module.exports = { server, state, tokenOf, CARDS, route, persist, restore, TERMINAL_KEY, TERMINAL_PASSWORD };
