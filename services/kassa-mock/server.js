// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * kassa-mock — мок облачной кассы OFD Ferma (T-038, полный мок-стенд
 * «банк + касса»: tbank-mock + этот сервис).
 *
 * Emulates the Ferma cloud-cashbox contract per ofd.ru developer docs:
 *   POST /possystem/v1/getToken                                                  {login, pass} -> {token}
 *   POST /possystem/v1/{group}/sell|sell_refund|sell_correction|buy|buy_refund|buy_correction  ?token= -> {uuid, status:"wait"}
 *   GET  /possystem/v1/{group}/report/{uuid}                                     ?token= -> {status:done, ofd_status, payload:{ФД/ФП...}}
 *   GET  /possystem/v1/stats/cashboxes/extended                                  ?token= -> cashbox monitor (+ ofdQueueCount)
 *   GET  /possystem/v1/ofd/queue                                                 -> очередь документов в ОФД (pending/sent/rejected)
 *   POST /possystem/v1/ofd/mode                                                  -> {mode: "online"|"offline"|"reject", flush?: true}
 *   GET|POST|PUT /mock/time                                                      -> виртуальные часы (MOCK_VIRTUAL_CLOCK)
 *   GET|POST|DELETE /mock/scenarios                                              -> сценарное API + журнал срабатываний
 *
 * Zero npm dependencies. Config via environment; secrets are fake.
 * Never expose this service publicly without protection.
 */

const http = require('http');
const crypto = require('crypto');

const core = require('../../packages/core');
const {
  createLog, readBody, send, sendJson, escapeHtml, checkControlAccess,
  parseScenarioSpec, applyRequestChaos, createSandboxManager, verifyMerchantWebhook,
} = core;
// Журнал входящих запросов: интегратору видно в /admin/journal (спека §2).
const journal = core.createJournal({ size: 200 });

const {
  MOCK_HOST = '0.0.0.0',
  MOCK_PORT = '3101',
  MOCK_FERMA_LOGIN = '',
  MOCK_FERMA_PASSWORD = '',
  FERMA_LOGIN = '',
  FERMA_PASSWORD = '',
  MOCK_PROCESS_MS = '15000',
  MOCK_CALLBACK_RETRY_MS = '10000',
  MOCK_CALLBACK_MAX_ATTEMPTS = '24',
  MOCK_STATE_FILE = '',
  MOCK_TOKEN_TTL_MS = String(12 * 60 * 60 * 1000),
  MOCK_VALIDATE_RECEIPTS = 'true',
  MOCK_GROUPS = '',
  MOCK_BLOCK_PRIVATE_WEBHOOKS = 'false',
  MOCK_FERMA_DOWN = 'false',
  MOCK_FERMA_DOWN_MS = '0',
  MOCK_PUBLIC_BASE_URL = `http://localhost:${MOCK_PORT}`,
  MOCK_VIRTUAL_CLOCK = '',
  MOCK_ADMIN_TOKEN = '',
  MOCK_OPERATOR_TOKEN = '',
  MOCK_HOSTED = 'false',
  MOCK_OFD_MODE = 'online',
} = process.env;

// Креды кассы: приоритет MOCK_FERMA_* -> FERMA_* -> дефолт стенда
const FERMA_LOGIN_CRED = MOCK_FERMA_LOGIN || FERMA_LOGIN || 'loviitest';
const FERMA_PASSWORD_CRED = MOCK_FERMA_PASSWORD || FERMA_PASSWORD || 'mockpass123';

// ВАЖНО: не `parseInt(...) || 4000` — ноль (печатать мгновенно) тоже валидное
// значение; старый код превращал MOCK_PROCESS_MS=0 в 4 секунды (дефект A-10).
const parseMs = (raw, def) => {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
};
const PROCESS_MS = parseMs(MOCK_PROCESS_MS, 15000);
const TOKEN_TTL_MS = parseMs(MOCK_TOKEN_TTL_MS, 12 * 60 * 60 * 1000);
const VALIDATE_RECEIPTS = String(MOCK_VALIDATE_RECEIPTS).toLowerCase() !== 'false';
// MOCK_GROUPS=Main,Shop-1 — если задан, группа с опечаткой отклоняется (как в бою).
const GROUPS = String(MOCK_GROUPS).split(',').map((g) => g.trim()).filter(Boolean);
// F-07/F-08: hosted-режим включает fail-closed управляющей поверхности и
// SSRF-политику по умолчанию; env-флаг (1/true, 0/false) переопределяет.
const HOSTED = core.flagEnabled(MOCK_HOSTED);
const OPERATOR_TOKEN = MOCK_OPERATOR_TOKEN || '';
const BLOCK_PRIVATE_WEBHOOKS = core.flagEnabled(MOCK_BLOCK_PRIVATE_WEBHOOKS, HOSTED);
const CALLBACK_RETRY_MS = Math.max(1000, parseInt(MOCK_CALLBACK_RETRY_MS, 10) || 10000);
const CALLBACK_MAX_ATTEMPTS = Math.max(1, parseInt(MOCK_CALLBACK_MAX_ATTEMPTS, 10) || 24);

const store = core.createStore({ stateFile: MOCK_STATE_FILE, log: console.error });
const { state } = store;
const persist = store.persist;

const DEFAULT_FN_CAPACITY = Math.max(1, parseInt(process.env.MOCK_FN_CAPACITY || '250000', 10) || 250000);
const SHIFT_MAX_DURATION_MS = 24 * 60 * 60 * 1000;

function createInitialKassaState() {
  const defaultMode = ['online', 'offline', 'reject'].includes(String(MOCK_OFD_MODE).toLowerCase())
    ? String(MOCK_OFD_MODE).toLowerCase()
    : 'online';
  return {
    counters: { deviceId: 1001, uuid: Date.now(), fd: 50000, notification: 1 },
    tokens: {},
    receipts: {},
    externalIds: {},
    callbacks: {},
    ofdQueue: {},
    clockOffsetMs: 0,
    cashbox: {
      deviceId: 0,
      name: 'KASSA-MOCK-1',
      kktState: 'Готова к работе',
      tariffType: 'Безлимитный (mock)',
      checksCnt: 0,
      fnVolumePercent: 3,
      downUntil: 0,
      ofdMode: defaultMode,
    },
    shift: {
      status: 'open',
      shiftNumber: 77,
      openedAt: new Date().toISOString(),
      openedAtMs: 0,
      closedAt: null,
      receiptsCount: 0,
      sellTotal: 0,
      sellRefundTotal: 0,
      buyTotal: 0,
      buyRefundTotal: 0,
    },
    zReports: [],
    fn: {
      fnNumber: process.env.MOCK_FN_NUMBER || '9999078902001294',
      capacity: DEFAULT_FN_CAPACITY,
      used: 0,
      expiresAt: '2027-12-31T23:59:59.000Z',
    },
  };
}

const initDefaults = createInitialKassaState();
Object.assign(state, {
  counters: state.counters || initDefaults.counters,
  tokens: state.tokens || {},
  receipts: state.receipts || {},
  externalIds: state.externalIds || {},
  callbacks: state.callbacks || {},
  ofdQueue: state.ofdQueue || {}, // uuid -> { uuid, externalId, queuedAt, status: 'pending'|'rejected', error }
  clockOffsetMs: state.clockOffsetMs || 0,
  cashbox: state.cashbox || initDefaults.cashbox,
  shift: state.shift || initDefaults.shift,
  zReports: state.zReports || [],
  fn: state.fn || initDefaults.fn,
});

const sandboxManager = createSandboxManager({
  state,
  persist,
  initialStateFactory: createInitialKassaState,
});

const clock = core.createVirtualClock({
  initial: MOCK_VIRTUAL_CLOCK,
  getStateOffset: () => state.clockOffsetMs || 0,
  setStateOffset: (v) => { state.clockOffsetMs = v; persist(); },
});

const scenarios = core.createScenarioRegistry({ clock });
const log = createLog('kassa-mock');

/* ---------------------------------------------------------------- helpers */

function isDown() {
  return state.cashbox.downUntil > clock.now();
}

// DX-слой (спека §6.2): коды Ferma разложены на объяснение, поле,
// рекомендацию и ссылку на документацию.
const derr = core.createErrorCatalog({
  provider: 'ferma-ofd',
  docsBase: 'https://ferma.ofd.ru/documents/documentation',
  codes: {
    0: { message: 'Касса недоступна', hint: 'Включён сценарий MOCK_FERMA_DOWN или кнопкой в /admin. Касса сама вернётся в строй (downUntil) или снимите сценарий кнопкой.', doc: '#cashbox-status' },
    4: { message: 'Неверный формат запроса', field: 'body', hint: 'Тело запроса — не валидный JSON или нарушены инварианты чека 54-ФЗ. Проверьте Content-Type: application/json и структуру по docs/integration/ferma-ofd.md.', doc: '#receipt-validation' },
    5: { message: 'external_id обязателен', field: 'external_id', hint: 'Передайте свой уникальный идентификатор документа (до 36 символов). По нему работает дедупликация и повторные запросы.', doc: '#external-id' },
    10: { message: 'Документ не найден', field: 'uuid', hint: 'uuid не существует в этом стенде (или чек ещё не напечатан — страница /receipts отдаёт только done-чеки). Список документов: /admin.', doc: '#report' },
    11: { message: 'Не выполнена авторизация', field: 'token', hint: 'Передайте ?token=, полученный в getToken; токен живёт 12 часов. Один токен на все вызовы API.', doc: '#auth' },
    12: { message: 'Документ с таким external_id уже существует', field: 'external_id', hint: 'Дедупликация Ferma: повторите с новым external_id или запросите статус по report/{uuid} старого. В боевом контуре это защита от двойного чека.', doc: '#deduplication' },
    14: { message: 'Неверный логин или пароль', field: 'login, pass', hint: 'Креды стенда задаются env MOCK_FERMA_LOGIN / MOCK_FERMA_PASSWORD (или FERMA_LOGIN / FERMA_PASSWORD, по умолчанию loviitest / mockpass123).', doc: '#auth' },
    57: { message: 'Отказ печати по сценарию', field: 'external_id', hint: 'ExternalId с префиксом «fail-» или заголовок X-Mock-Scenario: fail — управляемый отказ ККТ. Уберите сценарий для нормального флоу.', doc: '#scenarios' },
    58: { message: 'Отказ проверки кода маркировки (Честный ЗНАК)', field: 'marking_code', hint: 'Код маркировки не прошёл проверку в ГИС МТ (сценарий X-Mock-Scenario: mark-fail или префикс FAIL- в коде). Проверьте КМ и статус товара.', doc: '#marking' },
    62: { message: 'Смена ККТ закрыта или превысила 24 часа (ст. 4.3 54-ФЗ)', field: 'shift', hint: 'По 54-ФЗ длительность кассовой смены не может превышать 24 часа. Закройте смену (POST /possystem/v1/shift/close) и откройте новую (POST /possystem/v1/shift/open).', doc: '#shifts' },
    63: { message: 'Исчерпан ресурс фискального накопителя (ФН переполнен)', field: 'fn', hint: 'Лимит фискальных документов в ФН исчерпан (POST /possystem/v1/fn/state для замены/сброса ФН или уберите сценарий fn-overflow).', doc: '#fn' },
    404: { message: 'Неизвестный маршрут', hint: 'Список маршрутов — /admin и README сервиса.', doc: '' },
    500: { message: 'Внутренняя ошибка мок-стенда', hint: 'Смотрите лог сервиса; воспроизводится — это дефект мока, заводите issue.', doc: '' },
  },
});

function err(code, text, overrides = {}) {
  const desc = derr(code, { message: typeof text === 'string' ? text : undefined, ...overrides });
  return {
    error: {
      error_id: null,
      code,
      text: desc.message,
      type: overrides.type || 'system',
      field: desc.field || undefined,
      hint: desc.hint || undefined,
      doc: desc.doc || undefined,
    },
    timestamp: clock.iso(),
  };
}

function errBody(code, text, overrides = {}) {
  return JSON.stringify(err(code, text, overrides));
}

/** Ответ готовой JSON-строкой (errBody уже стрингифицирован). */
function jsonRaw(res, code, body) {
  send(res, code, body, { 'Content-Type': 'application/json; charset=utf-8' });
}

/* ------------------------------------------------------- валидация чека */

// Значения реквизитов по 54-ФЗ (приказы ФНС, ФФД 1.2):
const PAYMENT_METHODS = [
  'full_prepayment',
  'partial_prepayment',
  'advance',
  'full_payment',
  'partial_payment',
  'credit',
  'credit_payment',
  'consideration',
];

const PAYMENT_OBJECTS = [
  'commodity',
  'excise',
  'job',
  'service',
  'gambling_bet',
  'gambling_prize',
  'lottery',
  'lottery_prize',
  'intellectual_activity',
  'payment',
  'agent_commission',
  'composite',
  'another',
  'property_right',
  'non_operating_gain',
  'insurance_premium',
  'sales_tax',
  'resort_fee',
  'deposit',
  'expense',
  'pension_insurance_ip',
  'pension_insurance',
  'medical_insurance_ip',
  'medical_insurance',
  'social_insurance',
  'casino_payment',
  'marked_excise',
  'marked_commodity',
];

// Все ставки НДС по 54-ФЗ: базовые (none, vat0, vat5, vat7, vat10, vat20, vat22)
// и расчётные ставки предоплаты/аванса (vat5_105, vat7_107, vat10_110, vat20_120, vat22_122).
const VAT_TYPES = [
  'none',
  'vat0',
  'vat5',
  'vat7',
  'vat10',
  'vat20',
  'vat22',
  'vat5_105',
  'vat7_107',
  'vat10_110',
  'vat20_120',
  'vat22_122',
];

const AGENT_TYPES = [
  'bank_paying_agent',
  'bank_paying_subagent',
  'paying_agent',
  'paying_subagent',
  'attorney',
  'commission_agent',
  'another',
];

const MEASURE_UNITS = [0, 10, 11, 12, 20, 21, 22, 30, 31, 32, 40, 41, 42, 50, 51, 70, 71, 72, 73, 80, 81, 82, 83, 255];

const PAYMENT_TYPES = [1, 2, 3, 4, 5]; // 1 безнал, 2 зачёт предоплаты/аванса, 3 кредит/постоплата, 4 иная (встречное предоставление), 5 наличные

const OPERATIONS = ['sell', 'sell_refund', 'sell_correction', 'buy', 'buy_refund', 'buy_correction'];

const isInt = (v) => Number.isInteger(v);
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isValidInn = (inn) => typeof inn === 'string' && /^(\d{10}|\d{12})$/.test(inn.trim());

/** Извлечение кода маркировки из позиции (marking_code или nomenclature_code). */
function extractMarkingCode(item) {
  if (!item || typeof item !== 'object') return null;
  const mc = item.marking_code !== undefined ? item.marking_code : item.nomenclature_code;
  if (mc === undefined || mc === null) return null;
  if (typeof mc === 'string') return mc.trim();
  if (typeof mc === 'object') {
    const code = mc.code || mc.raw || mc.hex || mc.gtin || '';
    return String(code).trim();
  }
  return '';
}

/**
 * Проверка инвариантов фискального чека ДО «печати» (этап 6 роадмапа: полнота 54-ФЗ).
 * Возвращает описание ошибки в формате DX (код 4 + поле + подсказка + ссылка) или null.
 */
function validateReceipt(receipt, operation = 'sell', body = {}) {
  const bad = (field, hint, doc = '#receipt-validation') => ({ field, hint, doc });
  if (!receipt || typeof receipt !== 'object') {
    return bad('receipt', 'Передайте объект receipt с items, payments и total (см. docs/integration/ferma-ofd.md).');
  }

  // Валидация реквизитов чека коррекции (если передан correction_info)
  const corr = body.correction_info || receipt.correction_info;
  if (corr !== undefined) {
    if (!corr || typeof corr !== 'object') {
      return bad('correction_info', 'Для чека коррекции передайте объект correction_info: {type: "self"|"instruction", base_date: "YYYY-MM-DD", base_number?: "..."}.', '#correction');
    }
    if (!['self', 'instruction'].includes(corr.type)) {
      return bad('correction_info.type', `Неизвестный тип коррекции ${JSON.stringify(corr.type)}. Допустимо: 'self' (самостоятельно), 'instruction' (по предписанию ФНС).`, '#correction');
    }
    if (!corr.base_date || typeof corr.base_date !== 'string') {
      return bad('correction_info.base_date', 'Укажите дату документа-основания коррекции в поле correction_info.base_date (например, "2026-10-11").', '#correction');
    }
  }

  const items = receipt.items;
  if (!Array.isArray(items) || !items.length) {
    return bad('receipt.items', 'Нужен непустой массив позиций: [{name, price, quantity, sum, vat, payment_method, payment_object}].');
  }

  let itemsSum = 0;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i] || {};
    const at = `receipt.items[${i}]`;
    if (!it.name || typeof it.name !== 'string') {
      return bad(`${at}.name`, 'Название позиции — непустая строка (покупатель увидит её в чеке).');
    }
    if (!isPosInt(it.price)) {
      return bad(`${at}.price`, `Цена — целое число копеек > 0 (получено ${JSON.stringify(it.price)}). Бесплатная позиция оформляется нулевой ценой только через скидку/коррекцию.`);
    }
    if (!isPosInt(it.quantity)) {
      return bad(`${at}.quantity`, `Количество — целое > 0 (получено ${JSON.stringify(it.quantity)}). Для дробного количества используйте меру измерения и целые минорные единицы.`);
    }
    if (!isInt(it.sum)) {
      return bad(`${at}.sum`, 'Сумма позиции — целое число копеек (price × quantity).');
    }
    if (it.sum !== it.price * it.quantity) {
      return bad(`${at}.sum`, `Сумма позиции ${it.sum} ≠ price × quantity = ${it.price * it.quantity}. Касса ФНС отклонит такой чек.`);
    }
    if (!it.vat || !VAT_TYPES.includes(it.vat.type)) {
      return bad(`${at}.vat.type`, `Неизвестная ставка НДС ${JSON.stringify(it.vat && it.vat.type)}. Допустимо: ${VAT_TYPES.join(', ')}.`, '#vat');
    }
    if (it.payment_method !== undefined && !PAYMENT_METHODS.includes(it.payment_method)) {
      return bad(`${at}.payment_method`, `Неизвестный признак способа расчёта ${JSON.stringify(it.payment_method)}. Допустимо: ${PAYMENT_METHODS.join(', ')}. Для аванса — 'full_prepayment'/'advance', для зачёта аванса — 'full_payment'/'consideration'.`, '#payment-method');
    }
    if (it.payment_object !== undefined && !PAYMENT_OBJECTS.includes(it.payment_object)) {
      return bad(`${at}.payment_object`, `Неизвестный признак предмета расчёта ${JSON.stringify(it.payment_object)}. Допустимо: ${PAYMENT_OBJECTS.join(', ')}.`, '#payment-object');
    }
    if (it.measure_unit !== undefined && !MEASURE_UNITS.includes(it.measure_unit)) {
      return bad(`${at}.measure_unit`, `Неизвестный код меры количества (ФФД 1.2 тег 2108) ${JSON.stringify(it.measure_unit)}. Допустимо: ${MEASURE_UNITS.join(', ')} (0 — шт., 11 — кг, 41 — л и т.д.).`, '#measure-unit');
    }
    // Валидация агентских реквизитов (если переданы)
    if (it.agent_info !== undefined && it.agent_info !== null) {
      if (typeof it.agent_info !== 'object' || !AGENT_TYPES.includes(it.agent_info.type)) {
        return bad(`${at}.agent_info.type`, `Неизвестный тип агента ${JSON.stringify(it.agent_info && it.agent_info.type)}. Допустимо: ${AGENT_TYPES.join(', ')}.`, '#agent-info');
      }
    }
    if (it.supplier_info !== undefined && it.supplier_info !== null) {
      if (typeof it.supplier_info !== 'object') {
        return bad(`${at}.supplier_info`, 'supplier_info должен быть объектом {name, inn, phones?}.', '#supplier-info');
      }
      if (it.supplier_info.inn !== undefined && !isValidInn(String(it.supplier_info.inn))) {
        return bad(`${at}.supplier_info.inn`, `ИНН поставщика «${it.supplier_info.inn}» должен состоять из 10 (ЮЛ) или 12 (ИП) цифр (тег 1226 ФФД).`, '#supplier-info');
      }
    }
    // Валидация маркировки (Честный ЗНАК, ФФД 1.2)
    const isMarkedObject = it.payment_object === 'marked_commodity' || it.payment_object === 'marked_excise';
    const markCode = extractMarkingCode(it);
    if (isMarkedObject && !markCode) {
      return bad(`${at}.marking_code`, `Для предмета расчёта '${it.payment_object}' обязателен код маркировки в поле marking_code или nomenclature_code (ФФД 1.2, тег 1163).`, '#marking');
    }
    if (markCode !== null && markCode.length < 8) {
      return bad(`${at}.marking_code`, `Код маркировки слишком короткий (${markCode.length} симв.): передайте полный код DataMatrix / GS1 / GTIN+серийный номер (не менее 8 символов).`, '#marking');
    }
    if (it.mark_quantity !== undefined && it.mark_quantity !== null) {
      const mq = it.mark_quantity;
      if (typeof mq !== 'object' || !isPosInt(mq.numerator) || !isPosInt(mq.denominator) || mq.numerator >= mq.denominator) {
        return bad(`${at}.mark_quantity`, 'Дробное количество маркированного товара (тег 1291) задаётся объектом {numerator, denominator}, где 0 < numerator < denominator.', '#marking');
      }
    }

    itemsSum += it.sum;
  }

  if (!isPosInt(receipt.total)) return bad('receipt.total', 'Итог чека — целое число копеек > 0.');
  if (receipt.total !== itemsSum) {
    return bad('receipt.total', `Итог ${receipt.total} ≠ сумме позиций ${itemsSum}. Проверьте арифметику до отправки — касса сверяет суммы сама.`);
  }

  const payments = receipt.payments;
  if (!Array.isArray(payments) || !payments.length) {
    return bad('receipt.payments', 'Нужен непустой массив оплат: [{type: 1..5, sum}] (в т.ч. при оплате одним способом).');
  }
  let paymentsSum = 0;
  let prepaymentOffsetSum = 0;
  for (let i = 0; i < payments.length; i += 1) {
    const pay = payments[i] || {};
    if (!PAYMENT_TYPES.includes(pay.type)) {
      return bad(`receipt.payments[${i}].type`, `Неизвестный признак формы оплаты ${JSON.stringify(pay.type)}. Допустимо: ${PAYMENT_TYPES.join(', ')} (1 — электронными, 2 — зачёт предоплаты/аванса, 3 — постоплата/кредит, 4 — иная/встречное предоставление, 5 — наличными).`);
    }
    if (!isPosInt(pay.sum)) return bad(`receipt.payments[${i}].sum`, 'Сумма оплаты — целое число копеек > 0.');
    paymentsSum += pay.sum;
    if (pay.type === 2) prepaymentOffsetSum += pay.sum;
  }
  if (paymentsSum !== receipt.total) {
    return bad('receipt.payments', `Σ оплат ${paymentsSum} ≠ итогу ${receipt.total}. Смешанная оплата (например, зачёт аванса + доплата или баллы + карта) должна сходиться в копейку.`);
  }

  // Проверка связки зачёта предоплаты/аванса (prepayment_external_id)
  const prepayExtId = body.prepayment_external_id || receipt.prepayment_external_id;
  if (prepayExtId) {
    const prepayUuid = state.externalIds[String(prepayExtId)];
    const prepayDoc = prepayUuid ? state.receipts[prepayUuid] : null;
    if (!prepayDoc) {
      return bad('prepayment_external_id', `Исходный чек предоплаты с external_id «${prepayExtId}» не найден.`, '#prepayment');
    }
    const availablePrepay = prepayDoc.prepaymentRemaining !== undefined && prepayDoc.prepaymentRemaining !== null
      ? prepayDoc.prepaymentRemaining
      : (prepayDoc.receipt?.total || 0);
    const offsetNeed = prepaymentOffsetSum > 0 ? prepaymentOffsetSum : receipt.total;
    if (offsetNeed > availablePrepay) {
      return bad('receipt.payments', `Сумма зачёта предоплаты ${offsetNeed} больше доступного остатка аванса ${availablePrepay} по чеку «${prepayExtId}».`, '#prepayment');
    }
  }

  // Проверка связки чека возврата (origin_external_id): общая сумма + позиционный контроль количества
  const originExtId = body.origin_external_id || receipt.origin_external_id;
  if (originExtId) {
    const originUuid = state.externalIds[String(originExtId)];
    const originDoc = originUuid ? state.receipts[originUuid] : null;
    const expectedOriginOp = operation === 'buy_refund' ? 'buy' : 'sell';
    if (!originDoc || originDoc.operation !== expectedOriginOp) {
      return bad('origin_external_id', `Исходный чек (${expectedOriginOp}) с external_id «${originExtId}» не найден.`, '#refund');
    }
    const availableRefund = originDoc.refundableRemaining !== undefined && originDoc.refundableRemaining !== null
      ? originDoc.refundableRemaining
      : (originDoc.receipt?.total || 0);
    if (receipt.total > availableRefund) {
      return bad('receipt.total', `Сумма возврата ${receipt.total} больше доступного остатка ${availableRefund} по чеку «${originExtId}».`, '#refund');
    }
    if (originDoc.refundableItems && typeof originDoc.refundableItems === 'object') {
      const reqQtyByName = {};
      for (let i = 0; i < items.length; i += 1) {
        const it = items[i] || {};
        const key = String(it.name || '').trim();
        if (!key) continue;
        reqQtyByName[key] = (reqQtyByName[key] || 0) + Number(it.quantity || 0);
        if (originDoc.refundableItems[key] !== undefined && reqQtyByName[key] > originDoc.refundableItems[key] + 1e-9) {
          return bad(
            `receipt.items[${i}].quantity`,
            `Количество возврата по позиции «${key}» (${reqQtyByName[key]}) превышает доступный остаток к возврату (${originDoc.refundableItems[key]}) по чеку «${originExtId}».`,
            '#refund',
          );
        }
      }
    }
  }

  return null;
}

/** Токен из query (?token=) — как в контракте Ferma. */
function tokenFromUrl(url) {
  const m = /[?&]token=([^&]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * Проверка токена с TTL (контракт: токен живёт 12 часов, затем нужен новый
 * getToken). Использует виртуальные часы (clock.now()).
 */
function checkToken(url) {
  const token = tokenFromUrl(url);
  if (!token) return false;
  const session = state.tokens[token];
  if (!session) return false;
  const age = clock.now() - (session.createdAt || 0);
  if (TOKEN_TTL_MS > 0 && age > TOKEN_TTL_MS) {
    delete state.tokens[token];
    persist();
    log(`[kassa-mock] токен истёк (возраст ${Math.round(age / 1000)} c > TTL ${Math.round(TOKEN_TTL_MS / 1000)} c) — нужен новый getToken`);
    return false;
  }
  return true;
}

/* ------------------------------------------------------- document pipeline */

function shortSupplierName(name) {
  if (typeof name !== 'string' || !name.trim()) return name;
  const ip = name.match(/^ИП\s+(\S+)/);
  if (ip) return `ИП ${ip[1]}`;
  const quoted = name.match(/«([^»]+)»/);
  if (quoted) return quoted[1];
  return name.replace(/^(ООО|АО|ЗАО|ПАО|ОАО)\s+/i, '').trim() || name;
}

const AGENT_LINE = process.env.MOCK_AGENT_LINE || 'ТЕСТОВАЯ КАССА (МОК)';
const AGENT_INN = process.env.MOCK_AGENT_INN || '7800000000';
const OFD_INN = process.env.MOCK_OFD_INN || '7800000000';
const FN_NUMBER = process.env.MOCK_FN_NUMBER || '9999078902001294';
const ECR_RN = process.env.MOCK_ECR_RN || '0001234567025896';
const OPERATOR_NAME = process.env.MOCK_OPERATOR || 'Кассир-мок';
const FNS_SITE = process.env.MOCK_FNS_SITE || 'www.nalog.gov.ru';

// Ставки и подписи НДС для ленты чека и фискального снимка (включая расчётные ставки аванса)
const VAT_META = {
  none: { rate: 0, calc: false, label: 'без НДС' },
  vat0: { rate: 0, calc: false, label: '0%' },
  vat5: { rate: 5, calc: false, label: '5%' },
  vat7: { rate: 7, calc: false, label: '7%' },
  vat10: { rate: 10, calc: false, label: '10%' },
  vat20: { rate: 20, calc: false, label: '20%' },
  vat22: { rate: 22, calc: false, label: '22%' },
  vat5_105: { rate: 5, calc: true, label: '5/105' },
  vat7_107: { rate: 7, calc: true, label: '7/107' },
  vat10_110: { rate: 10, calc: true, label: '10/110' },
  vat20_120: { rate: 20, calc: true, label: '20/120' },
  vat22_122: { rate: 22, calc: true, label: '22/122' },
};

function computeVatBreakdown(items) {
  const acc = {};
  for (const item of items || []) {
    const type = (item.vat && item.vat.type) || 'none';
    acc[type] = (acc[type] || 0) + (item.sum || 0);
  }
  return Object.entries(acc).map(([type, gross]) => {
    const meta = VAT_META[type] || VAT_META.none;
    const tax = meta.rate ? Math.round((gross * meta.rate) / (100 + meta.rate)) : 0;
    return { type, rate: meta.rate, label: meta.label, gross, tax };
  });
}

/** Строки НДС по позициям: «НДС 20%: 16.67 р», «НДС 20/120: 16.67 р» либо «НДС: без НДС». */
function vatLines(items) {
  const breakdown = computeVatBreakdown(items);
  if (!breakdown.length || breakdown.every((b) => !b.rate && b.type === 'none')) return ['НДС: без НДС'];
  return breakdown.map((b) => {
    if (b.rate) return `НДС ${b.label}: ${(b.tax / 100).toFixed(2)} р`;
    return `НДС ${b.type}: без НДС (${(b.gross / 100).toFixed(2)} р)`;
  });
}

function fiscalSnapshot(doc) {
  const items = doc.receipt?.items || [];
  const markedItems = items.filter((it) => extractMarkingCode(it));
  return {
    total: doc.receipt.total,
    operation: doc.operation,
    ofd_inn: OFD_INN,
    fns_site: FNS_SITE,
    fn_number: (state.fn && state.fn.fnNumber) || FN_NUMBER,
    ecr_registration_number: ECR_RN,
    shift_number: doc.shiftNumber || (state.shift && state.shift.shiftNumber) || 77,
    receipt_datetime: new Date(doc.processedAt).toISOString().slice(0, 19),
    fiscal_receipt_number: doc.fiscalReceiptNumber,
    fiscal_document_number: doc.fiscalDocumentNumber,
    fiscal_document_attribute: String(1000000000 + (doc.fiscalDocumentNumber * 7919) % 8999999999),
    ofd_receipt_url: `${MOCK_PUBLIC_BASE_URL}/receipts/${doc.uuid}`,
    ofd_status: doc.ofdStatus || 'sent',
    operator: OPERATOR_NAME,
    taxation_type: doc.receipt.company?.sno || 'ОСН',
    vat_amounts: computeVatBreakdown(items),
    ...(markedItems.length ? {
      marked_items_count: markedItems.length,
      marking_verified: true,
    } : {}),
  };
}

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
  credit: 'ПЕРЕДАЧА В КРЕДИТ',
  credit_payment: 'ОПЛАТА КРЕДИТА',
  consideration: 'ЗАЧЁТ ПРЕДОПЛАТЫ (АВАНСА)',
};

const PAYMENT_TYPE_LABELS = {
  1: 'БЕЗНАЛИЧНЫМИ',
  2: 'ПРЕДОПЛАТА (ЗАЧЁТ АВАНСА)',
  3: 'ПОСТОПЛАТА (КРЕДИТ)',
  4: 'ИНАЯ (БАЛЛЫ / ВСТРЕЧНОЕ)',
  5: 'НАЛИЧНЫМИ',
};

function customerReceiptText(doc) {
  const p = doc.payload;
  const lines = [];
  lines.push('================================');
  lines.push(AGENT_LINE);
  lines.push(`ИНН: ${AGENT_INN}`);
  lines.push(OPERATION_LABELS[doc.operation] || `ЧЕК (${doc.operation})`);
  if (doc.hasSupplier || doc.supplierLabel !== '—' || doc.supplierInnLabel !== '—') {
    lines.push(`Поставщик: ${doc.supplierLabel}`);
    lines.push(`ИНН поставщика: ${doc.supplierInnLabel}`);
  }
  lines.push('--------------------------------');
  for (const item of doc.receipt.items) {
    const mc = extractMarkingCode(item);
    const markPrefix = mc ? '[М] ' : '';
    const pmLabel = item.payment_method && PAYMENT_METHOD_LABELS[item.payment_method]
      ? ` [${PAYMENT_METHOD_LABELS[item.payment_method]}]`
      : '';
    lines.push(`${String(markPrefix + item.name).slice(0, 30).padEnd(30)} ${((item.price * item.quantity) / 100).toFixed(2)} р${pmLabel}`);
    if (mc) lines.push(`  КМ: ${mc.slice(0, 32)}`);
  }
  lines.push('--------------------------------');
  for (const pay of doc.receipt.payments || []) {
    lines.push(`${PAYMENT_TYPE_LABELS[pay.type] || 'НАЛИЧНЫМИ'}: ${(pay.sum / 100).toFixed(2)} р`);
  }
  lines.push(`ИТОГ: ${(p.total / 100).toFixed(2)} р`);
  for (const vat of vatLines(doc.receipt.items)) lines.push(vat);
  lines.push(`Дата: ${p.receipt_datetime.replace('T', ' ')}`);
  lines.push(`ФД №${p.fiscal_document_number} ФН №${p.fn_number}`);
  lines.push(`ФП: ${p.fiscal_document_attribute}`);
  lines.push(`Статус ОФД: ${doc.ofdStatus || 'sent'}`);
  lines.push(`Чек: ${p.ofd_receipt_url}`);
  lines.push(`Проверка: ${FNS_SITE}`);
  lines.push('================================');
  return lines.join('\n');
}

const deliveryQueue = core.createDeliveryQueue({
  entries: state.callbacks,
  retryMs: CALLBACK_RETRY_MS,
  maxAttempts: CALLBACK_MAX_ATTEMPTS,
  persist,
  log,
  now: () => clock.now(),
  request: (entry) => ({ url: entry.url, data: entry.body }),
  onSuccess: (entry, res, id) => { delete state.callbacks[id]; },
  blockPrivateHosts: BLOCK_PRIVATE_WEBHOOKS,
});

function scheduleCallback(doc, duplicate = false) {
  if (doc.callbackSuppressed) {
    log(`[kassa-mock] doc ${doc.uuid}: callback suppressed by scenario (webhook-drop)`);
    return;
  }
  const url = doc.receipt.receipts?.service?.callback_url
    || doc.receipt.service?.callback_url
    || (doc.receipt.receipts ? doc.receipt.receipts.service && doc.receipt.receipts.service.callback_url : null);

  if (!url) {
    log(`[kassa-mock] doc ${doc.uuid}: no callback_url, result available via /report only`);
    return;
  }

  const count = duplicate ? 2 : 1;
  for (let i = 0; i < count; i += 1) {
    const id = state.counters.notification++;
    state.callbacks[id] = {
      uuid: doc.uuid,
      url,
      body: doc.callbackBody,
      attempts: 0,
      nextAttemptAt: clock.now() + 500,
      lastStatus: null,
    };
  }
  persist();
  log(`[kassa-mock] doc ${doc.uuid}: callback scheduled -> ${url}${duplicate ? ' (duplicate x2)' : ''}`);
}

/** Применение режима ОФД к напечатанному чеку. */
function processOfdDelivery(doc) {
  const mode = doc.ofdScenarioMode || state.cashbox.ofdMode || 'online';
  if (mode === 'offline' || mode === 'queue' || mode === 'pending') {
    doc.ofdStatus = 'pending';
    doc.ofdError = null;
    state.ofdQueue[doc.uuid] = {
      uuid: doc.uuid,
      externalId: doc.externalId,
      operation: doc.operation,
      total: doc.receipt?.total || 0,
      queuedAt: new Date(clock.now()).toISOString(),
      status: 'pending',
    };
  } else if (mode === 'reject' || mode === 'rejected') {
    doc.ofdStatus = 'rejected';
    doc.ofdError = { code: 61, text: 'ОФД отклонил фискальный документ (сценарий ofd-reject)' };
    state.ofdQueue[doc.uuid] = {
      uuid: doc.uuid,
      externalId: doc.externalId,
      operation: doc.operation,
      total: doc.receipt?.total || 0,
      queuedAt: new Date(clock.now()).toISOString(),
      status: 'rejected',
      error: doc.ofdError,
    };
  } else {
    doc.ofdStatus = 'sent';
    doc.ofdSentAt = new Date(clock.now()).toISOString();
    doc.ofdError = null;
    delete state.ofdQueue[doc.uuid];
  }
  if (doc.payload) {
    doc.payload.ofd_status = doc.ofdStatus;
    if (doc.ofdError) doc.payload.ofd_error = doc.ofdError;
  }
}

/** Отправка накопленной очереди ОФД при восстановлении связи. */
function flushOfdQueue() {
  let flushed = 0;
  for (const [uuid, q] of Object.entries(state.ofdQueue)) {
    if (q.status !== 'pending') continue;
    const doc = state.receipts[uuid];
    if (doc) {
      doc.ofdStatus = 'sent';
      doc.ofdSentAt = new Date(clock.now()).toISOString();
      doc.ofdError = null;
      if (doc.payload) doc.payload.ofd_status = 'sent';
    }
    delete state.ofdQueue[uuid];
    flushed += 1;
  }
  if (flushed > 0) persist();
  return flushed;
}

function tickKassa() {
  const now = clock.now();

  // «Печать чеков» из очереди wait -> done/fail
  for (const doc of Object.values(state.receipts)) {
    if (doc.status !== 'wait' || doc.hang) continue;
    if (now < doc.processAt) continue;

    if (doc.forceMarkFail) {
      doc.status = 'fail';
      doc.ofdStatus = 'rejected';
      doc.error = { code: 58, text: 'Касса-мок: отказ проверки кода маркировки в ГИС МТ «Честный ЗНАК»' };
      doc.processedAt = now;
      log(`[kassa-mock] doc ${doc.uuid}: FAILED (mark-fail)`);
    } else if (doc.forceFail) {
      doc.status = 'fail';
      doc.ofdStatus = 'rejected';
      doc.error = { code: 57, text: 'Касса-мок: отказ по сценарию (forceFail)' };
      doc.processedAt = now;
      log(`[kassa-mock] doc ${doc.uuid}: FAILED (сценарий fail-)`);
    } else {
      doc.processedAt = now;
      state.cashbox.checksCnt += 1;
      doc.fiscalReceiptNumber = state.cashbox.checksCnt;
      doc.status = 'done';
      if (state.shift) {
        state.shift.receiptsCount = (state.shift.receiptsCount || 0) + 1;
        const tot = doc.receipt?.total || 0;
        if (doc.operation === 'sell' || doc.operation === 'sell_correction') state.shift.sellTotal = (state.shift.sellTotal || 0) + tot;
        else if (doc.operation === 'sell_refund') state.shift.sellRefundTotal = (state.shift.sellRefundTotal || 0) + tot;
        else if (doc.operation === 'buy' || doc.operation === 'buy_correction') state.shift.buyTotal = (state.shift.buyTotal || 0) + tot;
        else if (doc.operation === 'buy_refund') state.shift.buyRefundTotal = (state.shift.buyRefundTotal || 0) + tot;
      }
      if (state.fn) {
        state.fn.used = (state.fn.used || 0) + 1;
        state.cashbox.fnVolumePercent = Math.min(100, Math.max(1, Math.round((state.fn.used / Math.max(1, state.fn.capacity)) * 100)));
      }
      processOfdDelivery(doc);
      doc.payload = fiscalSnapshot(doc);
      log(`\n[kassa-mock] ===== ЧЕК НАПЕЧАТАТАН (${doc.operation}) =====\n${customerReceiptText(doc)}\n============================================`);
    }
    doc.callbackBody = JSON.stringify({
      uuid: doc.uuid,
      external_id: doc.externalId,
      group_code: doc.group,
      type: doc.operation,
      status: doc.status,
      ofd_status: doc.ofdStatus,
      timestamp: new Date(now).toISOString(),
      error: doc.error,
      payload: doc.payload,
    });
    persist();
    scheduleCallback(doc, doc.callbackDuplicate);
  }

  deliveryQueue.tick();

  // Авто-восстановление «недоступной кассы»
  if (state.cashbox.downUntil && now >= state.cashbox.downUntil) {
    state.cashbox.downUntil = 0;
    log('[kassa-mock] касса снова готова к работе');
  }
}

setInterval(() => {
  tickKassa();
}, 1000).unref();

/* ------------------------------------------------------------- request API */

function createDocument(operation, group, body, scenarioHeader = '', preResolvedSpec = null) {
  const uuid = crypto.randomUUID();
  const externalId = String(body.external_id || '');
  const spec = preResolvedSpec || scenarios.resolve({
    header: scenarioHeader,
    bodyScenario: body.mock_scenario || body.receipt?.mock_scenario || '',
    target: operation,
    context: { externalId, group, operation },
  });

  const items = body.receipt?.items || [];
  const hasFailMarking = items.some((it) => {
    const mc = extractMarkingCode(it);
    return mc && mc.toUpperCase().startsWith('FAIL-');
  });

  const isPrepaymentDoc = items.some((it) => ['full_prepayment', 'partial_prepayment', 'advance'].includes(it.payment_method));
  const prepayExtId = body.prepayment_external_id || body.receipt?.prepayment_external_id || null;
  const originExtId = body.origin_external_id || body.receipt?.origin_external_id || null;

  let ofdScenarioMode = null;
  if (spec.has('ofd-queue') || spec.has('ofd-pending')) ofdScenarioMode = 'queue';
  else if (spec.has('ofd-reject') || spec.has('ofd-fail')) ofdScenarioMode = 'reject';
  else if (spec.has('ofd-sent') || spec.has('ofd-online')) ofdScenarioMode = 'online';

  const supplierObj = items.find((it) => it && it.supplier_info)?.supplier_info || null;

  let refundableItems = null;
  if (['sell', 'buy'].includes(operation)) {
    refundableItems = {};
    for (const it of items) {
      const k = String(it?.name || '').trim();
      if (k) refundableItems[k] = (refundableItems[k] || 0) + Number(it.quantity || 0);
    }
  }

  const doc = {
    uuid,
    externalId,
    group,
    operation, // sell | sell_refund | sell_correction | buy | buy_refund | buy_correction
    status: 'wait',
    ofdStatus: 'pending',
    ofdScenarioMode,
    ofdError: null,
    createdAt: clock.now(),
    processAt: clock.now() + PROCESS_MS,
    processedAt: null,
    forceFail: externalId.startsWith('fail-') || spec.has('fail') || spec.has('kkt-fail'),
    forceMarkFail: hasFailMarking || spec.has('mark-fail'),
    hang: externalId.startsWith('hang-') || spec.has('hang'),
    callbackSuppressed: spec.has('webhook-drop') || spec.has('no-webhook'),
    callbackDuplicate: spec.has('webhook-duplicate'),
    receipt: body.receipt,
    hasSupplier: Boolean(supplierObj),
    supplierLabel: shortSupplierName(supplierObj?.name) || '—',
    supplierInnLabel: supplierObj?.inn || '—',
    prepaymentExternalId: prepayExtId ? String(prepayExtId) : null,
    originExternalId: originExtId ? String(originExtId) : null,
    prepaymentRemaining: isPrepaymentDoc ? (body.receipt?.total || 0) : null,
    refundableRemaining: ['sell', 'buy'].includes(operation) ? (body.receipt?.total || 0) : null,
    refundableItems,
    shiftNumber: (state.shift && state.shift.shiftNumber) || 77,
    fiscalReceiptNumber: null, // присваивается при печати
    fiscalDocumentNumber: ++state.counters.fd,
    callbackBody: null,
    payload: null,
    error: null,
  };

  // Списываем зачтённый аванс у исходного чека предоплаты
  if (prepayExtId && !doc.forceFail && !doc.forceMarkFail) {
    const prepayUuid = state.externalIds[String(prepayExtId)];
    const prepayDoc = prepayUuid ? state.receipts[prepayUuid] : null;
    if (prepayDoc) {
      const offsetPayments = (body.receipt?.payments || [])
        .filter((p) => p.type === 2)
        .reduce((acc, p) => acc + p.sum, 0);
      const deduct = offsetPayments > 0 ? offsetPayments : (body.receipt?.total || 0);
      prepayDoc.prepaymentRemaining = Math.max(0, (prepayDoc.prepaymentRemaining ?? prepayDoc.receipt.total) - deduct);
    }
  }

  // Списываем сумму и попозиционное количество возврата у исходного чека прихода/расхода
  if (originExtId && !doc.forceFail && !doc.forceMarkFail) {
    const originUuid = state.externalIds[String(originExtId)];
    const originDoc = originUuid ? state.receipts[originUuid] : null;
    if (originDoc) {
      originDoc.refundableRemaining = Math.max(0, (originDoc.refundableRemaining ?? originDoc.receipt.total) - (body.receipt?.total || 0));
      if (originDoc.refundableItems && typeof originDoc.refundableItems === 'object') {
        for (const it of items) {
          const k = String(it?.name || '').trim();
          if (k && originDoc.refundableItems[k] !== undefined) {
            originDoc.refundableItems[k] = Math.max(0, originDoc.refundableItems[k] - Number(it.quantity || 0));
          }
        }
      }
    }
  }

  if (doc.hang) {
    log(`[kassa-mock] doc ${uuid}: сценарий hang- — останется в wait без callback`);
    return doc;
  }

  state.receipts[uuid] = doc;
  state.externalIds[externalId] = uuid;
  persist();
  log(`[kassa-mock] doc ${uuid} queued: ${operation} external_id=${externalId} total=${body.receipt?.total} items=${body.receipt?.items?.length}`);
  return doc;
}

/**
 * Выжимка запроса для журнала: скаляры, не более 6 полей, значения до 60
 * символов. Редакцию секретов и PII делает ядро (F-09): `token`, `pass`,
 * реквизиты покупателя (телефон/e-mail) и PAN в журнал не попадают.
 */
function bodySummary(body) {
  return core.summarizeBody(body, { maxKeys: 6, maxValueLength: 60 });
}

/**
 * Какая авторизация нужна маршруту (F-07):
 *   'admin'    — /admin* (консоль, журнал и действия);
 *   'operator' — управляющая поверхность: /mock/*, смены ККТ, ресурс ФН и
 *                режим/очередь ОФД;
 *   null       — контракт Ferma (getToken/sell/report/stats) и страницы чека.
 */
function controlSurface(url) {
  if (url.startsWith('/admin')) return 'admin';
  if (url.startsWith('/mock/')) return 'operator';
  if (/^\/possystem\/v1\/(shift\/(open|close|status)|fn\/state|ofd\/(mode|queue))$/.test(url)) return 'operator';
  return null;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, 'http://x');
  const url = parsedUrl.pathname;

  if (req.headers['x-mock-sandbox'] || parsedUrl.searchParams.get('sandbox')) {
    sandboxManager.fromRequest(req);
  }

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
        baseUrl: MOCK_PUBLIC_BASE_URL,
      });
      return originalWriteHead(code, ...rest);
    };

    // Инъекция задержек и сетевых сбоев (X-Mock-Latency, X-Mock-Scenario: latency:..., http-500, http-504)
    const chaosSpec = parseScenarioSpec(req.headers['x-mock-scenario'] || '');
    const chaosResult = await applyRequestChaos(req, chaosSpec);
    if (chaosResult.fault) {
      return jsonRaw(res, chaosResult.fault.status, errBody(chaosResult.fault.status, chaosResult.fault.message));
    }
  }

  try {
    // Единый access-control управляющей поверхности (F-07, A-20):
    // /admin* — MOCK_ADMIN_TOKEN; /mock/*, смены/ФН/ОФД — MOCK_OPERATOR_TOKEN
    // (с fallback на админ-токен). В hosted-режиме без секрета — fail-closed.
    const surface = controlSurface(url);
    if (surface) {
      const access = checkControlAccess(req, {
        adminToken: MOCK_ADMIN_TOKEN,
        operatorToken: OPERATOR_TOKEN,
        surface,
        hosted: HOSTED,
      });
      if (!access.allowed) {
        const envName = surface === 'admin' ? 'MOCK_ADMIN_TOKEN' : 'MOCK_OPERATOR_TOKEN';
        const message = access.reason === 'hosted-fail-closed'
          ? `Маршрут ${url} закрыт: hosted-режим (MOCK_HOSTED) требует ${envName} для управляющей поверхности`
          : `Доступ к управляющему маршруту ${url} ограничен: требуется ${envName}`;
        return jsonRaw(res, 401, errBody(11, message, {
          field: surface === 'admin' ? 'Authorization' : 'X-Operator-Token',
          hint: `Передайте токен в заголовке Authorization: Bearer <${envName}> или X-Operator-Token/X-Admin-Token.`,
        }));
      }
    }

    if (req.method === 'GET' && url === '/openapi.json') {
      const specFile = require('path').join(__dirname, '..', '..', 'docs', 'openapi', 'kassa-mock.openapi.json');
      const specObj = JSON.parse(require('fs').readFileSync(specFile, 'utf8'));
      return sendJson(res, specObj);
    }

    if (req.method === 'GET' && url === '/admin/journal') {
      return sendJson(res, { entries: journal.list() });
    }

    if (req.method === 'GET' && url === '/healthz') {
      return sendJson(res, {
        ok: !isDown(),
        sandbox: sandboxManager.current(),
        checks: state.cashbox.checksCnt,
        ofdMode: state.cashbox.ofdMode || 'online',
        ofdQueueCount: Object.keys(state.ofdQueue || {}).length,
        shiftStatus: state.shift ? state.shift.status : 'open',
        fnUsed: state.fn ? state.fn.used : 0,
        fnCapacity: state.fn ? state.fn.capacity : DEFAULT_FN_CAPACITY,
      });
    }

    // Управление песочницами, сбросом и снимками состояния (RFC-001)
    if (url === '/mock/sandboxes') {
      if (req.method === 'GET') {
        return sendJson(res, { current: sandboxManager.current(), sandboxes: sandboxManager.list() });
      }
      if (req.method === 'POST') {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
        const name = sandboxManager.switchTo(body.sandbox || 'default');
        return sendJson(res, { ok: true, current: name, sandboxes: sandboxManager.list() });
      }
      if (req.method === 'DELETE') {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
        const resReset = sandboxManager.reset(body.sandbox || parsedUrl.searchParams.get('sandbox') || undefined);
        return sendJson(res, { ...resReset, current: sandboxManager.current() });
      }
    }

    if (url === '/mock/reset' && req.method === 'POST') {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      const targetSandbox = body.sandbox || req.headers['x-mock-sandbox'] || undefined;
      const resReset = sandboxManager.reset(targetSandbox);
      scenarios.clearRules();
      scenarios.clearHistory();
      journal.clear();
      return sendJson(res, resReset);
    }

    if (url === '/mock/state') {
      if (req.method === 'GET') {
        return sendJson(res, sandboxManager.exportState());
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {
          return jsonRaw(res, 400, errBody(4, 'Некорректный JSON снимка состояния', {
            field: 'state',
            hint: 'Передайте экспорт /mock/state без редактирования опасных ключей __proto__, constructor и prototype.',
          }));
        }
        try {
          return sendJson(res, sandboxManager.importState(body));
        } catch (e) {
          return jsonRaw(res, 400, errBody(4, 'Недопустимый снимок состояния: ' + e.message, {
            field: 'state',
            hint: 'Исправьте снимок и повторите импорт; ключи __proto__, constructor и prototype запрещены на всех уровнях.',
          }));
        }
      }
    }

    if (url === '/mock/verify-merchant' && req.method === 'POST') {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { return jsonRaw(res, 400, errBody(4, 'Некорректный JSON')); }
      const targetUrl = String(body.url || body.callback_url || '').trim();
      if (!targetUrl) {
        return jsonRaw(res, 400, errBody(4, 'Передайте url обработчика callback фискализации', { field: 'url' }));
      }
      try {
        const report = await verifyMerchantWebhook({
          url: targetUrl,
          provider: 'ferma-ofd',
          blockPrivateHosts: BLOCK_PRIVATE_WEBHOOKS,
        });
        return sendJson(res, report);
      } catch (e) {
        if (e && e.code === 'SSRF_BLOCKED') {
          return jsonRaw(res, 403, errBody(4, e.message, {
            field: 'url',
            hint: 'Для активной проверки укажите публично доступный приёмник. Приватные адреса разрешены только при MOCK_BLOCK_PRIVATE_WEBHOOKS=0 на локальном стенде.',
          }));
        }
        return jsonRaw(res, 500, errBody(500, e.message));
      }
    }

    // Виртуальные часы (этап 7, бриф §3.2)
    if (url === '/mock/time') {
      if (req.method === 'GET') return sendJson(res, clock.snapshot());
      if (req.method === 'POST' || req.method === 'PUT') {
        const raw = await readBody(req);
        let spec = {};
        try { spec = JSON.parse(raw || '{}'); } catch { return jsonRaw(res, 400, errBody(4, 'Некорректный JSON для /mock/time')); }
        try {
          const snap = clock.set(spec);
          if (spec.reset && state.shift && state.shift.openedAtMs) {
            state.shift.openedAtMs = 0;
          }
          tickKassa();
          return sendJson(res, snap);
        } catch (e) {
          return jsonRaw(res, 400, errBody(4, e.message, { field: 'advance|offset|iso' }));
        }
      }
    }

    // Сценарное API (этап 7, бриф §3.2)
    if (url === '/mock/scenarios') {
      if (req.method === 'GET') {
        return sendJson(res, { rules: scenarios.listRules(), history: scenarios.listHistory() });
      }
      if (req.method === 'POST') {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { return jsonRaw(res, 400, errBody(4, 'Некорректный JSON для /mock/scenarios')); }
        try {
          const rule = scenarios.addRule(body);
          return sendJson(res, { ok: true, rule });
        } catch (e) {
          return jsonRaw(res, 400, errBody(4, e.message, { field: 'scenario' }));
        }
      }
      if (req.method === 'DELETE') {
        scenarios.clearRules();
        scenarios.clearHistory();
        return sendJson(res, { ok: true, rules: [], history: [] });
      }
    }

    // Смены ККТ и Z-отчёты (ст. 4.3 54-ФЗ: длительность смены ≤ 24 часа)
    if (req.method === 'GET' && url === '/possystem/v1/shift/status') {
      const sh = state.shift || initDefaults.shift;
      const durationMs = sh.status === 'open' && sh.openedAtMs > 0
        ? Math.max(0, clock.now() - sh.openedAtMs)
        : 0;
      const expired = sh.status === 'open' && durationMs > SHIFT_MAX_DURATION_MS;
      return sendJson(res, {
        status: sh.status,
        shiftNumber: sh.shiftNumber,
        openedAt: sh.openedAt,
        closedAt: sh.closedAt || null,
        durationMs,
        maxDurationMs: SHIFT_MAX_DURATION_MS,
        expired,
        receiptsCount: sh.receiptsCount || 0,
        totals: {
          sell: sh.sellTotal || 0,
          sell_refund: sh.sellRefundTotal || 0,
          buy: sh.buyTotal || 0,
          buy_refund: sh.buyRefundTotal || 0,
        },
        zReportsCount: (state.zReports || []).length,
        lastZReport: (state.zReports && state.zReports.length) ? state.zReports[state.zReports.length - 1] : null,
      });
    }

    if (req.method === 'POST' && url === '/possystem/v1/shift/open') {
      const raw = await readBody(req);
      res.__mockBody = raw;
      if (!state.shift) state.shift = { ...initDefaults.shift };
      if (state.shift.status === 'open' && state.shift.openedAtMs > 0) {
        return jsonRaw(res, 200, errBody(62, `Смена ККТ №${state.shift.shiftNumber} уже открыта`, {
          field: 'shift',
          hint: 'Закройте текущую смену через POST /possystem/v1/shift/close перед открытием новой.',
        }));
      }
      if (state.shift.status === 'closed') {
        state.shift.shiftNumber = (state.shift.shiftNumber || 77) + 1;
      }
      state.shift.status = 'open';
      state.shift.openedAt = clock.iso();
      state.shift.openedAtMs = clock.now();
      state.shift.closedAt = null;
      state.shift.receiptsCount = 0;
      state.shift.sellTotal = 0;
      state.shift.sellRefundTotal = 0;
      state.shift.buyTotal = 0;
      state.shift.buyRefundTotal = 0;
      persist();
      return sendJson(res, {
        ok: true,
        status: state.shift.status,
        shiftNumber: state.shift.shiftNumber,
        openedAt: state.shift.openedAt,
        fdNumber: ++state.counters.fd,
      });
    }

    if (req.method === 'POST' && url === '/possystem/v1/shift/close') {
      const raw = await readBody(req);
      res.__mockBody = raw;
      if (!state.shift || state.shift.status === 'closed') {
        return jsonRaw(res, 200, errBody(62, 'Смена ККТ уже закрыта', {
          field: 'shift',
          hint: 'Откройте новую смену через POST /possystem/v1/shift/open.',
        }));
      }
      const fdNumber = ++state.counters.fd;
      if (state.fn) state.fn.used = (state.fn.used || 0) + 1;
      const closedAt = clock.iso();
      const zReport = {
        shiftNumber: state.shift.shiftNumber,
        fdNumber,
        fpd: String(1000000000 + (fdNumber * 7919) % 8999999999),
        fnNumber: (state.fn && state.fn.fnNumber) || FN_NUMBER,
        openedAt: state.shift.openedAt,
        closedAt,
        receiptsCount: state.shift.receiptsCount || 0,
        totals: {
          sell: state.shift.sellTotal || 0,
          sell_refund: state.shift.sellRefundTotal || 0,
          buy: state.shift.buyTotal || 0,
          buy_refund: state.shift.buyRefundTotal || 0,
        },
        ofdQueueCount: Object.keys(state.ofdQueue || {}).length,
      };
      state.shift.status = 'closed';
      state.shift.closedAt = closedAt;
      if (!Array.isArray(state.zReports)) state.zReports = [];
      state.zReports.push(zReport);
      persist();
      return sendJson(res, { ok: true, status: 'closed', zReport });
    }

    // Ресурс Фискального Накопителя (ФН)
    if (url === '/possystem/v1/fn/state') {
      if (!state.fn) state.fn = { ...initDefaults.fn };
      if (req.method === 'GET') {
        const used = state.fn.used || 0;
        const capacity = Math.max(1, state.fn.capacity || DEFAULT_FN_CAPACITY);
        return sendJson(res, {
          fnNumber: state.fn.fnNumber,
          used,
          capacity,
          remaining: Math.max(0, capacity - used),
          volumePercent: Math.min(100, Math.round((used / capacity) * 100)),
          overflow: used >= capacity,
          expiresAt: state.fn.expiresAt,
        });
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        const raw = await readBody(req);
        res.__mockBody = raw;
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { return jsonRaw(res, 400, errBody(4, 'Некорректный JSON')); }
        if (body.reset) {
          state.fn.used = 0;
          if (body.fnNumber) state.fn.fnNumber = String(body.fnNumber);
          if (body.capacity !== undefined) state.fn.capacity = Math.max(1, parseInt(body.capacity, 10) || DEFAULT_FN_CAPACITY);
        } else {
          if (body.capacity !== undefined) state.fn.capacity = Math.max(1, parseInt(body.capacity, 10) || DEFAULT_FN_CAPACITY);
          if (body.used !== undefined) state.fn.used = Math.max(0, parseInt(body.used, 10) || 0);
          if (body.fnNumber) state.fn.fnNumber = String(body.fnNumber);
        }
        state.cashbox.fnVolumePercent = Math.min(100, Math.round(((state.fn.used || 0) / Math.max(1, state.fn.capacity)) * 100));
        persist();
        return sendJson(res, {
          ok: true,
          fnNumber: state.fn.fnNumber,
          used: state.fn.used,
          capacity: state.fn.capacity,
          remaining: Math.max(0, state.fn.capacity - state.fn.used),
          volumePercent: state.cashbox.fnVolumePercent,
          overflow: state.fn.used >= state.fn.capacity,
        });
      }
    }

    // Dry-run валидация чека без фискализации и без создания документа (POST /possystem/v1/validate)
    const validateMatch = /^\/possystem\/v1\/(?:([^/]+)\/)?validate$/.exec(url);
    if (req.method === 'POST' && validateMatch) {
      const raw = await readBody(req);
      res.__mockBody = raw;
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return jsonRaw(res, 200, errBody(4, 'Неверный формат запроса')); }
      const operation = String(body.operation || body.type || 'sell');
      const receipt = body.receipt || body;
      const problem = validateReceipt(receipt, operation, body);
      if (problem) {
        return sendJson(res, {
          valid: false,
          operation,
          ...err(4, `Чек не прошёл проверку кассы: ${problem.field}`, problem),
        });
      }
      return sendJson(res, {
        valid: true,
        error: null,
        operation,
        total: receipt.total,
        itemsCount: (receipt.items || []).length,
        vatBreakdown: computeVatBreakdown(receipt.items || []),
      });
    }
    if (req.method === 'GET' && url === '/possystem/v1/ofd/queue') {
      const items = Object.values(state.ofdQueue || {});
      return sendJson(res, {
        ofdMode: state.cashbox.ofdMode || 'online',
        count: items.length,
        items,
      });
    }

    if (req.method === 'POST' && url === '/possystem/v1/ofd/mode') {
      const raw = await readBody(req);
      res.__mockBody = raw;
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { return jsonRaw(res, 400, errBody(4, 'Некорректный JSON')); }
      if (body.mode !== undefined) {
        const nextMode = String(body.mode).toLowerCase();
        if (!['online', 'offline', 'reject'].includes(nextMode)) {
          return jsonRaw(res, 200, errBody(4, `Неизвестный режим ОФД «${body.mode}»`, {
            field: 'mode',
            hint: "Допустимые режимы ОФД: 'online' (отправка сразу), 'offline' (копить в очереди pending), 'reject' (отказ ОФД).",
          }));
        }
        state.cashbox.ofdMode = nextMode;
      }
      let flushed = 0;
      if (body.flush || state.cashbox.ofdMode === 'online') {
        flushed = flushOfdQueue();
      }
      persist();
      return sendJson(res, {
        ok: true,
        ofdMode: state.cashbox.ofdMode,
        flushed,
        ofdQueueCount: Object.keys(state.ofdQueue || {}).length,
      });
    }

    // Текстовая админ-консоль
    if (req.method === 'GET' && url === '/admin') {
      const docs = Object.values(state.receipts).sort((a, b) => b.createdAt - a.createdAt);
      const rows = docs.slice(0, 50).map((d) => `<tr>
        <td>${escapeHtml(d.uuid.slice(0, 8))}</td><td>${escapeHtml(d.operation)}</td><td>${escapeHtml(d.externalId)}</td>
        <td>${escapeHtml(d.status)} / ОФД: <b>${escapeHtml(d.ofdStatus || '—')}</b></td><td>${d.payload ? `ФД №${escapeHtml(d.payload.fiscal_document_number)} ФП ${escapeHtml(d.payload.fiscal_document_attribute)}` : (d.error ? escapeHtml(d.error.text) : '—')}</td>
        <td>${((d.receipt?.total || 0) / 100).toFixed(2)} р</td>
        <td>${d.callbackBody ? `<form method="POST" action="/admin/action" style="display:inline"><input type="hidden" name="action" value="resend-callback"><input type="hidden" name="uuid" value="${escapeHtml(d.uuid)}"><button style="width:auto;padding:2px 6px;font-size:11px">callback</button></form>` : '—'}</td></tr>`).join('');
      const journalRows = journal.list().slice(-15).reverse()
        .map((e) => `<tr><td>${escapeHtml(e.at.slice(11, 19))}</td><td>${escapeHtml(e.method)}</td><td><code>${escapeHtml(e.path)}</code></td><td>${escapeHtml(Object.entries(e.body || {}).map(([k, v]) => `${k}=${v}`).join(' '))}</td><td>${e.status}</td><td>${e.ms} мс</td><td><code style="font-size:10px">${escapeHtml(String(e.curl || '').slice(0, 70))}…</code></td></tr>`)
        .join('') || '<tr><td colspan="7">запросов ещё не было</td></tr>';
      return send(res, 200, `<html><head><meta charset="utf-8"><title>kassa-mock</title><style>
body{font-family:monospace;background:#111;color:#ddd;margin:20px}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #444;padding:4px 8px;font-size:13px}th{background:#222}
h1{font-size:18px} a{color:#8cf}</style></head><body>
<h1>kassa-mock — Ferma cloud-cashbox mock (${escapeHtml(state.cashbox.kktState)}, чеков: ${state.cashbox.checksCnt}, ОФД: ${escapeHtml(state.cashbox.ofdMode || 'online')}, очередь ОФД: ${Object.keys(state.ofdQueue || {}).length})</h1>
<p>POST /possystem/v1/getToken · POST /possystem/v1/{group}/sell|sell_refund|sell_correction|buy|buy_refund|buy_correction · GET /possystem/v1/{group}/report/&#123;uuid&#125; · GET /possystem/v1/stats/cashboxes/extended</p>
<p>Негатив: X-Mock-Scenario: <b>fail</b> / <b>hang</b> / <b>webhook-drop</b> / <b>ofd-queue</b> / <b>ofd-reject</b> / <b>mark-fail</b>; ExternalId с префиксом <b>fail-</b> / <b>hang-</b>.</p>
<form method="POST" action="/admin/action" style="display:inline">
  <input type="hidden" name="action" value="kassa-down">
  <input type="hidden" name="ms" value="300000">
  <button type="submit">Касса недоступна (5 мин)</button>
</form>
<form method="POST" action="/admin/action" style="display:inline">
  <input type="hidden" name="action" value="kassa-up">
  <button type="submit">Вернуть в строй</button>
</form>
<form method="POST" action="/admin/action" style="display:inline">
  <input type="hidden" name="action" value="ofd-offline">
  <button type="submit">ОФД: оффлайн (копить очередь)</button>
</form>
<form method="POST" action="/admin/action" style="display:inline">
  <input type="hidden" name="action" value="ofd-online">
  <button type="submit">ОФД: онлайн (отправить очередь)</button>
</form>
<form method="POST" action="/admin/action" style="display:inline">
  <input type="hidden" name="action" value="clear-external-ids">
  <button type="submit">Сбросить реестр external_id</button>
</form>
<p>Статус: ${isDown() ? `НЕДОСТУПНА до ${new Date(state.cashbox.downUntil).toISOString()}` : 'готова'} · external_id в реестре: ${Object.keys(state.externalIds).length} · Виртуальное время: ${escapeHtml(clock.iso())}</p>
<table><tr><th>uuid</th><th>op</th><th>external_id</th><th>status</th><th>фискальные данные</th><th>сумма</th><th>действия</th></tr>${rows}</table>
<h2 style="font-size:15px">Журнал запросов к API (последние 15) — <a href="/admin/journal">json</a></h2>
<table><tr><th>время</th><th>метод</th><th>путь</th><th>поля</th><th>код</th><th>время</th></tr>${journalRows}</table>
</body></html>`, { 'Content-Type': 'text/html; charset=utf-8' });
    }

    // «Касса недоступна» — все possystem-роуты 503
    if (url.startsWith('/possystem/') && isDown()) {
      return jsonRaw(res, 503, errBody(0, 'Касса недоступна (MOCK_FERMA_DOWN)'));
    }

    if (req.method === 'POST' && url === '/possystem/v1/getToken') {
      const raw = await readBody(req);
      res.__mockBody = raw;
      let creds = {};
      try { creds = JSON.parse(raw || '{}'); } catch { /* fallthrough */ }
      // F-09: креды Ferma не пишутся в лог целиком — только различимый префикс.
      const loginLabel = core.maskPiiValue('login', creds.login);
      if (creds.login !== FERMA_LOGIN_CRED || creds.pass !== FERMA_PASSWORD_CRED) {
        log(`[kassa-mock] getToken DENIED for login=${loginLabel}`);
        return jsonRaw(res, 200, errBody(14, 'Неверный логин или пароль'));
      }
      const token = crypto.randomBytes(16).toString('hex');
      state.tokens[token] = { login: loginLabel, createdAt: clock.now() };
      persist();
      log(`[kassa-mock] getToken OK for ${loginLabel}`);
      return sendJson(res, { error: null, timestamp: clock.iso(), token });
    }

    const opMatch = /^\/possystem\/v1\/([^/]+)\/(sell|sell_refund|sell_correction|buy|buy_refund|buy_correction)$/.exec(url);
    if (req.method === 'POST' && opMatch) {
      if (!checkToken(req.url)) return jsonRaw(res, 200, errBody(11, 'Не выполнена авторизация'));
      const raw = await readBody(req);
      res.__mockBody = raw;
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return jsonRaw(res, 200, errBody(4, 'Неверный формат запроса')); }

      const groupCode = opMatch[1];
      const operation = opMatch[2];
      const externalId = String(body.external_id || '');
      if (!externalId) return jsonRaw(res, 200, errBody(5, 'external_id обязателен'));
      // A-16: опечатка в группе отклоняется
      if (GROUPS.length && !GROUPS.includes(groupCode)) {
        return jsonRaw(res, 200, errBody(4, `Группа «${groupCode}» не зарегистрирована на стенде`, {
          field: 'group_code',
          hint: `Разрешённые группы задаются env MOCK_GROUPS: ${GROUPS.join(', ')}. Опечатка в группе на боевой кассе = отказ регистрации документа.`,
        }));
      }
      if (state.externalIds[externalId]) {
        return jsonRaw(res, 200, errBody(12, `Идентификатор счёта (external_id) «${externalId}» уже существует`));
      }

      const opSpec = scenarios.resolve({
        header: req.headers['x-mock-scenario'] || '',
        bodyScenario: body.mock_scenario || body.receipt?.mock_scenario || '',
        target: operation,
        context: { externalId, group: groupCode, operation },
      });

      // Проверка ресурса Фискального Накопителя (ФН) — код 63
      if (opSpec.has('fn-overflow') || (state.fn && state.fn.used >= state.fn.capacity)) {
        return jsonRaw(res, 200, errBody(63, `Исчерпан ресурс фискального накопителя ФН №${(state.fn && state.fn.fnNumber) || FN_NUMBER} (${state.fn ? state.fn.used : 0}/${state.fn ? state.fn.capacity : DEFAULT_FN_CAPACITY})`));
      }

      // Проверка смены ККТ (ст. 4.3 54-ФЗ: не более 24 часов и смена должна быть открыта) — код 62
      if (state.shift && state.shift.status === 'closed') {
        return jsonRaw(res, 200, errBody(62, 'Смена ККТ закрыта — откройте новую смену (POST /possystem/v1/shift/open) перед фискализацией чека'));
      }
      if (opSpec.has('shift-expired') || (state.shift && state.shift.openedAtMs > 0 && clock.now() - state.shift.openedAtMs > SHIFT_MAX_DURATION_MS)) {
        return jsonRaw(res, 200, errBody(62, `Превышена максимальная продолжительность кассовой смены 24 часа (ст. 4.3 54-ФЗ, смена №${state.shift ? state.shift.shiftNumber : 77}) — закройте смену Z-отчётом (POST /possystem/v1/shift/close)`));
      }

      if (VALIDATE_RECEIPTS) {
        const problem = validateReceipt(body.receipt, operation, body);
        if (problem) {
          log(`[kassa-mock] ${operation} REJECTED (validation): ${problem.field} — ${externalId}`);
          return jsonRaw(res, 200, errBody(4, `Чек не прошёл проверку кассы: ${problem.field}`, problem));
        }
      }

      const doc = createDocument(operation, groupCode, body, req.headers['x-mock-scenario'], opSpec);
      if (doc.hang) {
        state.receipts[doc.uuid] = doc;
        state.externalIds[externalId] = doc.uuid;
        persist();
      } else if (PROCESS_MS === 0) {
        // При мгновенной печати (MOCK_PROCESS_MS=0) сразу выполняем тик
        tickKassa();
      }
      return sendJson(res, { uuid: doc.uuid, timestamp: clock.iso(), error: null, status: 'wait' });
    }

    const reportMatch = /^\/possystem\/v1\/([^/]+)\/report\/([^/]+)$/.exec(url);
    if (req.method === 'GET' && reportMatch) {
      if (!checkToken(req.url)) return jsonRaw(res, 200, errBody(11, 'Не выполнена авторизация'));
      const doc = state.receipts[reportMatch[2]];
      if (!doc) return jsonRaw(res, 200, errBody(10, 'Документ не найден'));
      const out = {
        uuid: doc.uuid,
        external_id: doc.externalId,
        group_code: doc.group,
        type: doc.operation,
        status: doc.status,
        ofd_status: doc.ofdStatus || (doc.status === 'done' ? 'sent' : 'pending'),
        ...(doc.ofdError ? { ofd_error: doc.ofdError } : {}),
        timestamp: clock.iso(),
        error: doc.error,
        payload: doc.payload,
      };
      return sendJson(res, out);
    }

    if (req.method === 'GET' && url === '/possystem/v1/stats/cashboxes/extended') {
      if (!checkToken(req.url)) return jsonRaw(res, 200, errBody(11, 'Не выполнена авторизация'));
      return sendJson(res, {
        Status: isDown() ? 'Fail' : 'Success',
        Data: [{
          deviceId: state.counters.deviceId,
          deviceName: state.cashbox.name,
          kktState: isDown() ? 'Авария' : state.cashbox.kktState,
          tariffType: state.cashbox.tariffType,
          checksCnt: state.cashbox.checksCnt,
          fnVolumePercent: state.cashbox.fnVolumePercent,
          ofdMode: state.cashbox.ofdMode || 'online',
          ofdQueueCount: Object.keys(state.ofdQueue || {}).length,
          tariffExpires: '2036-01-01T00:00:00',
        }],
        Errors: [],
      });
    }

    // «Доставка чека покупателю»: человекочитаемая страница чека
    const receiptMatch = /^\/receipts\/([^/]+)$/.exec(url);
    if (req.method === 'GET' && receiptMatch) {
      const doc = state.receipts[receiptMatch[1]];
      if (!doc || doc.status !== 'done') return jsonRaw(res, 404, errBody(10, 'Чек не найден'));
      return send(res, 200, `<html><head><meta charset="utf-8"><title>Чек ${escapeHtml(doc.payload.fiscal_document_number)}</title></head>
<body style="font-family:monospace;background:#eee"><pre>${escapeHtml(customerReceiptText(doc))}</pre></body></html>`, { 'Content-Type': 'text/html; charset=utf-8' });
    }

    if (req.method === 'POST' && url === '/admin/action') {
      const raw = await readBody(req);
      const body = {};
      for (const pair of raw.split('&')) {
        const i = pair.indexOf('=');
        if (i > 0) body[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
      }
      if (body.action === 'kassa-down') {
        state.cashbox.downUntil = clock.now() + Math.max(0, parseInt(body.ms, 10) || 300000);
        log(`сценарий: касса недоступна до ${new Date(state.cashbox.downUntil).toISOString()}`);
        persist();
      } else if (body.action === 'kassa-up') {
        state.cashbox.downUntil = 0;
        log('сценарий: касса снова готова к работе');
        persist();
      } else if (body.action === 'ofd-offline') {
        state.cashbox.ofdMode = 'offline';
        log('сценарий: связь с ОФД отключена (документы копятся в очереди)');
        persist();
      } else if (body.action === 'ofd-online') {
        state.cashbox.ofdMode = 'online';
        const flushed = flushOfdQueue();
        log(`сценарий: связь с ОФД восстановлена (отправлено из очереди: ${flushed})`);
        persist();
      } else if (body.action === 'resend-callback') {
        const doc = state.receipts[body.uuid];
        if (doc && doc.callbackBody) {
          scheduleCallback(doc);
          log(`сценарий: повторный callback для ${body.uuid}`);
        }
      } else if (body.action === 'clear-external-ids') {
        const n = Object.keys(state.externalIds).length;
        state.externalIds = {};
        log(`сценарий: реестр external_id очищен (${n} записей)`);
        persist();
      }
      return send(res, 302, '', { Location: '/admin' });
    }

    return jsonRaw(res, 404, errBody(404, 'Неизвестный маршрут'));
  } catch (e) {
    if (e && e.code === 'BODY_TOO_LARGE') {
      return jsonRaw(res, 413, errBody(4, 'Размер тела запроса превышает допустимый лимит', {
        field: 'body',
        hint: `Уменьшите тело запроса до ${e.maxBytes} байт или менее.`,
      }));
    }
    log('[kassa-mock] handler error:', e.message);
    return jsonRaw(res, 500, errBody(500, e.message));
  }
});

store.restore();

// MOCK_FERMA_DOWN_MS: авто-восстановление задаётся и при старте
if (process.env.MOCK_FERMA_DOWN === 'true' || process.env.MOCK_FERMA_DOWN === '1') {
  const ms = Math.max(0, parseInt(MOCK_FERMA_DOWN_MS, 10) || 0);
  state.cashbox.downUntil = clock.now() + ms;
  log(`[kassa-mock] старт в режиме «касса недоступна»${ms ? `, восстановление через ${ms} мс` : ' (до MOCK_FERMA_DOWN=0)'}`);
}

if (require.main === module) {
  server.listen(parseInt(MOCK_PORT, 10), MOCK_HOST, () => {
    const port = server.address().port; // MOCK_PORT=0 -> реальный порт
    log(`kassa-mock (Ferma cloud-cashbox mock) on ${MOCK_HOST}:${port}`);
    log(`login=${core.maskPiiValue('login', FERMA_LOGIN_CRED)} process_delay=${PROCESS_MS}ms state=${MOCK_STATE_FILE || 'memory'}`);
    log(`control-plane: admin_token=${MOCK_ADMIN_TOKEN ? 'on' : 'off'} operator_token=${OPERATOR_TOKEN ? 'on' : 'off'} hosted=${HOSTED} block_private_webhooks=${BLOCK_PRIVATE_WEBHOOKS}`);
  });
}

module.exports = { server, state, clock, scenarios, OPERATIONS };
