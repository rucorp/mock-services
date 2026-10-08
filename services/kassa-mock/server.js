'use strict';

/*
 * kassa-mock — мок облачной кассы OFD Ferma (T-038, полный мок-стенд
 * «банк + касса»: tbank-mock + этот сервис).
 *
 * Emulates the Ferma cloud-cashbox contract per ofd.ru developer docs:
 *   POST /possystem/v1/getToken                  {login, pass} -> {token}
 *   POST /possystem/v1/{group}/sell|sell_refund  ?token= -> {uuid, status:"wait"}
 *   GET  /possystem/v1/{group}/report/{uuid}     ?token= -> {status:done, payload:{ФД/ФП...}}
 *   GET  /possystem/v1/stats/cashboxes/extended  ?token= -> cashbox monitor
 * Async delivery: after MOCK_PROCESS_MS the document "prints" and the result
 * is POSTed to receipt.receipts.service.callback_url (retries like the real
 * Ferma). The fiscal receipt itself is "delivered to the customer": the
 * body (positions, totals, ФД/ФП, ofd_receipt_url) is stored, logged in the
 * admin console and exposed via GET /admin (text console) + GET /receipts/:id.
 *
 * Failure scenarios (драйвер негативных кейсов):
 *   - ExternalId starting with "fail-"          -> document processed, status fail
 *   - ExternalId starting with "hang-"          -> stays "wait" forever (no callback)
 *   - MOCK_FERMA_DOWN=1                         -> /possystem/* returns 503 (касса недоступна)
 *   - MOCK_FERMA_DOWN_MS                        -> auto-recover after N ms
 *   - duplicate ExternalId                      -> error "уже существует" (как у Ferma)
 *   - bad/absent token                          -> {error:{code:11}}
 *
 * Zero npm dependencies. Config via environment; secrets are fake.
 * Never expose this service publicly.
 */

const http = require('http');
const crypto = require('crypto');

const core = require('../../packages/core');
const { createLog, readBody, send, sendJson, escapeHtml } = core;
// Журнал входящих запросов: интегратору видно в /admin/journal (спека §2).
const journal = core.createJournal({ size: 200 });

const {
  MOCK_HOST = '0.0.0.0',
  MOCK_PORT = '3101',
  MOCK_FERMA_LOGIN = 'loviitest',
  MOCK_FERMA_PASSWORD = 'mockpass123',
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
} = process.env;

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
const BLOCK_PRIVATE_WEBHOOKS = String(MOCK_BLOCK_PRIVATE_WEBHOOKS).toLowerCase() === 'true';
const CALLBACK_RETRY_MS = Math.max(1000, parseInt(MOCK_CALLBACK_RETRY_MS, 10) || 10000);
const CALLBACK_MAX_ATTEMPTS = Math.max(1, parseInt(MOCK_CALLBACK_MAX_ATTEMPTS, 10) || 24);

const store = core.createStore({ stateFile: MOCK_STATE_FILE, log: console.error });
const { state } = store;
const persist = store.persist;

Object.assign(state, {
  counters: state.counters || { deviceId: 1001, uuid: Date.now(), fd: 50000, notification: 1 },
  tokens: state.tokens || {},
  receipts: state.receipts || {},
  externalIds: state.externalIds || {},
  callbacks: state.callbacks || {},
  cashbox: state.cashbox || {
    deviceId: 0,
    name: 'KASSA-MOCK-1',
    kktState: 'Готова к работе',
    tariffType: 'Безлимитный (mock)',
    checksCnt: 0,
    fnVolumePercent: 3,
    downUntil: 0,
  },
});

const log = createLog('kassa-mock');

/* ---------------------------------------------------------------- helpers */

function isDown() {
  return state.cashbox.downUntil > Date.now();
}

// DX-слой (спека §6.2): коды Ferma разложены на объяснение, поле,
// рекомендацию и ссылку на документацию (контур доков Ferma закрыт личным
// кабинетом — ссылка ведёт на раздел документации в ЛК + на наш конспект).
const derr = core.createErrorCatalog({
  provider: 'ferma-ofd',
  docsBase: 'https://ferma.ofd.ru/documents/documentation',
  codes: {
    0: { message: 'Касса недоступна', hint: 'Включён сценарий MOCK_FERMA_DOWN или кнопкой в /admin. Касса сама вернётся в строй (downUntil) или снимите сценарий кнопкой.', doc: '' },
    4: { message: 'Неверный формат запроса', field: 'body', hint: 'Тело запроса — не валидный JSON. Проверьте Content-Type: application/json и структуру по конспекту docs/reference/tbank/* (для кассы — README-kassa-mock.md).', doc: '' },
    5: { message: 'external_id обязателен', field: 'external_id', hint: 'Передайте свой уникальный идентификатор документа (до 36 символов). По нему работает дедупликация и повторные запросы.', doc: '' },
    10: { message: 'Документ не найден', field: 'uuid', hint: 'uuid не существует в этом стенде (или чек ещё не напечатан — страница /receipts отдаёт только done-чеки). Список документов: /admin.', doc: '' },
    11: { message: 'Не выполнена авторизация', field: 'token', hint: 'Передайте ?token=, полученный в getToken; токен живёт 12 часов. Один токен на все вызовы API.', doc: '' },
    12: { message: 'Документ с таким external_id уже существует', field: 'external_id', hint: 'Дедупликация Ferma: повторите с новым external_id или запросите статус по report/{uuid} старого. В боевом контуре это защита от двойного чека.', doc: '' },
    14: { message: 'Неверный логин или пароль', field: 'login, pass', hint: 'Креды стенда задаются env MOCK_FERMA_LOGIN / MOCK_FERMA_PASSWORD (по умолчанию loviitest / mockpass123).', doc: '' },
    57: { message: 'Отказ печати по сценарию', field: 'external_id', hint: 'ExternalId с префиксом «fail-» — управляемый отказ ККТ. Переименуйте документ без префикса для нормального флоу.', doc: '' },
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
    timestamp: new Date().toISOString(),
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

// Значения реквизитов по 54-ФЗ (приказы ФНС): неизвестное значение — почти
// всегда опечатка интегратора, и её дешевле поймать на моке, чем на боевой
// кассе (в бою документ уйдёт в ОФД с неверным признаком).
const PAYMENT_METHODS = ['full_prepayment', 'partial_prepayment', 'advance', 'full_payment', 'partial_payment', 'credit', 'credit_payment', 'consideration'];
const VAT_TYPES = ['none', 'vat0', 'vat5', 'vat7', 'vat10', 'vat20', 'vat22'];
const PAYMENT_TYPES = [1, 2, 3, 4, 5]; // 1 безнал, 2 предоплата, 3 постоплата, 4 иная, 5 наличные

const isInt = (v) => Number.isInteger(v);
const isPosInt = (v) => Number.isInteger(v) && v > 0;

/**
 * Проверка инвариантов фискального чека ДО «печати». Возвращает описание
 * ошибки в формате DX (код 4 + поле + подсказка) или null.
 *
 * Дефект A-1 аудита: мок принимал чек с total=50000 при позициях на 100 копеек
 * и без контакта покупателя — невозможный чек «печатался» успешно.
 *
 * Правила (все — воспроизведение требований кассы, а не придирки мока):
 *   receipt.items[]      — непустой массив, у позиции есть name, price,
 *                          quantity и sum = price × quantity;
 *   receipt.total        — равен сумме позиций;
 *   receipt.payments[]   — известный тип, суммы положительные, Σ payments = total;
 *   payment_method/vat   — из списка допустимых значений (опечатка видна сразу).
 */
function validateReceipt(receipt) {
  const bad = (field, hint) => ({ field, hint });
  if (!receipt || typeof receipt !== 'object') return bad('receipt', 'Передайте объект receipt с items, payments и total (см. docs/integration/ferma-ofd.md).');

  const items = receipt.items;
  if (!Array.isArray(items) || !items.length) return bad('receipt.items', 'Нужен непустой массив позиций: [{name, price, quantity, sum, vat, payment_method, payment_object}].');

  let itemsSum = 0;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i] || {};
    const at = `receipt.items[${i}]`;
    if (!it.name || typeof it.name !== 'string') return bad(`${at}.name`, 'Название позиции — непустая строка (покупатель увидит её в чеке).');
    if (!isPosInt(it.price)) return bad(`${at}.price`, `Цена — целое число копеек > 0 (получено ${JSON.stringify(it.price)}). Бесплатная позиция оформляется нулевой ценой только через скидку/коррекцию.`);
    if (!isPosInt(it.quantity)) return bad(`${at}.quantity`, `Количество — целое > 0 (получено ${JSON.stringify(it.quantity)}). Для дробного количества используйте меру измерения и целые минорные единицы.`);
    if (!isInt(it.sum)) return bad(`${at}.sum`, 'Сумма позиции — целое число копеек (price × quantity).');
    if (it.sum !== it.price * it.quantity) return bad(`${at}.sum`, `Сумма позиции ${it.sum} ≠ price × quantity = ${it.price * it.quantity}. Касса ФНС отклонит такой чек.`);
    if (!it.vat || !VAT_TYPES.includes(it.vat.type)) {
      return bad(`${at}.vat.type`, `Неизвестная ставка НДС ${JSON.stringify(it.vat && it.vat.type)}. Допустимо: ${VAT_TYPES.join(', ')}.`);
    }
    if (it.payment_method !== undefined && !PAYMENT_METHODS.includes(it.payment_method)) {
      return bad(`${at}.payment_method`, `Неизвестный признак способа расчёта ${JSON.stringify(it.payment_method)}. Допустимо: ${PAYMENT_METHODS.join(', ')}. Для аванса — 'full_prepayment', для зачёта аванса — 'full_payment', для зачёта предоплаты — 'consideration'.`);
    }
    itemsSum += it.sum;
  }

  if (!isPosInt(receipt.total)) return bad('receipt.total', 'Итог чека — целое число копеек > 0.');
  if (receipt.total !== itemsSum) return bad('receipt.total', `Итог ${receipt.total} ≠ сумме позиций ${itemsSum}. Проверьте арифметику до отправки — касса сверяет суммы сама.`);

  const payments = receipt.payments;
  if (!Array.isArray(payments) || !payments.length) return bad('receipt.payments', 'Нужен непустой массив оплат: [{type: 1..5, sum}] (в т.ч. при оплате одним способом).');
  let paymentsSum = 0;
  for (let i = 0; i < payments.length; i += 1) {
    const pay = payments[i] || {};
    if (!PAYMENT_TYPES.includes(pay.type)) return bad(`receipt.payments[${i}].type`, `Неизвестный признак формы оплаты ${JSON.stringify(pay.type)}. Допустимо: ${PAYMENT_TYPES.join(', ')} (1 — электронными, 2 — предоплата, 3 — постоплата, 4 — иная/баллы, 5 — наличными).`);
    if (!isPosInt(pay.sum)) return bad(`receipt.payments[${i}].sum`, 'Сумма оплаты — целое число копеек > 0.');
    paymentsSum += pay.sum;
  }
  if (paymentsSum !== receipt.total) return bad('receipt.payments', `Σ оплат ${paymentsSum} ≠ итогу ${receipt.total}. Смешанная оплата (например, баллы + карта) должна сходиться в копейку.`);

  return null;
}

/** Токен из query (?token=) — как в контракте Ferma. */
function tokenFromUrl(url) {
  const m = /[?&]token=([^&]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * Проверка токена с TTL (контракт: токен живёт 12 часов, затем нужен новый
 * getToken). Раньше срок не проверялся вообще — «вечный» токен маскировал
 * целый класс ошибок интеграции (дефект A-11).
 */
function checkToken(url) {
  const token = tokenFromUrl(url);
  if (!token) return false;
  const session = state.tokens[token];
  if (!session) return false;
  const age = Date.now() - (session.createdAt || 0);
  if (TOKEN_TTL_MS > 0 && age > TOKEN_TTL_MS) {
    delete state.tokens[token];
    persist();
    log(`[kassa-mock] токен истёк (возраст ${Math.round(age / 1000)} c > TTL ${Math.round(TOKEN_TTL_MS / 1000)} c) — нужен новый getToken`);
    return false;
  }
  return true;
}

/* ------------------------------------------------------- document pipeline */

// Короткое имя поставщика для печатной ленты: «ООО «Ромашка Трейд»» →
// «Ромашка Трейд», «ИП Иванов Иван» → «ИП Иванов». Полное legal_name
// остаётся в JSON чека (/receipts/:uuid — поле supplier_info).
function shortSupplierName(name) {
  if (typeof name !== 'string' || !name.trim()) return name;
  const ip = name.match(/^ИП\s+(\S+)/);
  if (ip) return `ИП ${ip[1]}`;
  const quoted = name.match(/«([^»]+)»/);
  if (quoted) return quoted[1];
  return name.replace(/^(ООО|АО|ЗАО|ПАО|ОАО)\s+/i, '').trim() || name;
}

function fiscalSnapshot(doc) {
  return {
    total: doc.receipt.total,
    ofd_inn: '7800000000',
    fns_site: 'www.nalog.gov.ru',
    fn_number: '9999078902001294',
    ecr_registration_number: '0001234567025896',
    shift_number: 77,
    receipt_datetime: new Date(doc.processedAt).toISOString().slice(0, 19),
    fiscal_receipt_number: doc.fiscalReceiptNumber,
    fiscal_document_number: doc.fiscalDocumentNumber,
    fiscal_document_attribute: String(1000000000 + (doc.fiscalDocumentNumber * 7919) % 8999999999),
    ofd_receipt_url: `${MOCK_PUBLIC_BASE_URL}/receipts/${doc.uuid}`,
    operator: 'Кассир-мок',
    taxation_type: doc.receipt.company?.sno || 'ОСН',
  };
}

// Лента чека: шапка настраивается, чтобы публичный стенд не печатал бренд
// владельца стенда (дефект A-17: в исходном моке было жёстко «ЛОВИ» и строка
// «НДС: без НДС» независимо от ставок в позициях).
const AGENT_LINE = process.env.MOCK_AGENT_LINE || 'ТЕСТОВАЯ КАССА (МОК)';
const AGENT_INN = process.env.MOCK_AGENT_INN || '7800000000';

// Ставки и подписи для ленты чека (НДС включён в цену — так считает касса).
const VAT_RATES = { none: 0, vat0: 0, vat5: 5, vat7: 7, vat10: 10, vat20: 20, vat22: 22 };

/** Строки НДС по позициям: «НДС 20%: 16.67» либо «НДС: без НДС». */
function vatLines(items) {
  const acc = {};
  for (const item of items || []) {
    const type = (item.vat && item.vat.type) || 'none';
    acc[type] = (acc[type] || 0) + (item.sum || 0);
  }
  const types = Object.keys(acc);
  if (!types.length || types.every((t) => !VAT_RATES[t])) return ['НДС: без НДС'];
  return types.map((t) => {
    const rate = VAT_RATES[t] || 0;
    const gross = acc[t];
    const tax = rate ? Math.round(gross - gross / (1 + rate / 100)) : 0;
    return rate ? `НДС ${rate}%: ${(tax / 100).toFixed(2)} р` : `НДС ${t}: без НДС (${(gross / 100).toFixed(2)} р)`;
  });
}

function customerReceiptText(doc) {
  const p = doc.payload;
  const lines = [];
  lines.push('================================');
  lines.push(AGENT_LINE);
  lines.push(`ИНН: ${AGENT_INN}`);
  lines.push(`Поставщик: ${doc.supplierLabel}`);
  lines.push(`ИНН поставщика: ${doc.supplierInnLabel}`);
  lines.push('--------------------------------');
  for (const item of doc.receipt.items) {
    lines.push(`${String(item.name).slice(0, 30).padEnd(30)} ${((item.price * item.quantity) / 100).toFixed(2)} р`);
  }
  lines.push('--------------------------------');
  for (const pay of doc.receipt.payments || []) {
    lines.push(`${pay.type === 1 ? 'БЕЗНАЛИЧНЫМИ' : pay.type === 2 ? 'ПРЕДОПЛАТА (аванс)' : pay.type === 4 ? 'ИНАЯ (баллы)' : 'НАЛИЧНЫМИ'}: ${(pay.sum / 100).toFixed(2)} р`);
  }
  lines.push(`ИТОГ: ${(p.total / 100).toFixed(2)} р`);
  for (const vat of vatLines(doc.receipt.items)) lines.push(vat);
  lines.push(`Дата: ${p.receipt_datetime.replace('T', ' ')}`);
  lines.push(`ФД №${p.fiscal_document_number} ФН №${p.fn_number}`);
  lines.push(`ФП: ${p.fiscal_document_attribute}`);
  lines.push(`Чек: ${p.ofd_receipt_url}`);
  lines.push('Проверка: www.nalog.gov.ru');
  lines.push('================================');
  return lines.join('\n');
}

const deliveryQueue = core.createDeliveryQueue({
  entries: state.callbacks,
  retryMs: CALLBACK_RETRY_MS,
  maxAttempts: CALLBACK_MAX_ATTEMPTS,
  persist,
  log,
  request: (entry) => ({ url: entry.url, data: entry.body }),
  onSuccess: (entry, res, id) => { delete state.callbacks[id]; },
  blockPrivateHosts: BLOCK_PRIVATE_WEBHOOKS,
});

function scheduleCallback(doc) {
  const url = doc.receipt.receipts?.service?.callback_url
    || doc.receipt.service?.callback_url
    || (doc.receipt.receipts ? doc.receipt.receipts.service && doc.receipt.receipts.service.callback_url : null);

  if (!url) {
    log(`[kassa-mock] doc ${doc.uuid}: no callback_url, result available via /report only`);
    return;
  }

  const id = state.counters.notification++;
  state.callbacks[id] = {
    uuid: doc.uuid,
    url,
    body: doc.callbackBody,
    attempts: 0,
    nextAttemptAt: Date.now() + 500,
    lastStatus: null,
  };
  persist();
  log(`[kassa-mock] doc ${doc.uuid}: callback scheduled -> ${url}`);
}

// Тик раз в секунду: «печать чеков» + доставка колбэков (ретраи как у Ferma).
setInterval(() => {
  const now = Date.now();

  // «Печать чеков» из очереди wait -> done/fail
  for (const doc of Object.values(state.receipts)) {
    if (doc.status !== 'wait') continue;
    if (now < doc.processAt) continue;

    if (doc.forceFail) {
      doc.status = 'fail';
      doc.error = { code: 57, text: 'Касса-мок: отказ по сценарию (forceFail)' };
      doc.processedAt = now;
      log(`[kassa-mock] doc ${doc.uuid}: FAILED (сценарий fail-)`);
    } else {
      // Порядок важен: processedAt выставляется ДО снимка (иначе в чеке
      // оставался receipt_datetime = 1970-01-01, дефект A-12 аудита), а номер
      // чека за смену присваивается в момент печати — иначе у двух чеков,
      // созданных до печати, совпадал fiscal_receipt_number (дефект A-13).
      doc.processedAt = now;
      state.cashbox.checksCnt += 1;
      doc.fiscalReceiptNumber = state.cashbox.checksCnt;
      doc.status = 'done';
      doc.payload = fiscalSnapshot(doc);
      log(`\n[kassa-mock] ===== ЧЕК НАПЕЧАТАН (${doc.operation}) =====\n${customerReceiptText(doc)}\n============================================`);
    }
    // Тело callback в формате Ferma (контракт): статус + payload/error.
    doc.callbackBody = JSON.stringify({
      uuid: doc.uuid,
      external_id: doc.externalId,
      group_code: doc.group,
      type: doc.operation,
      status: doc.status,
      timestamp: new Date(now).toISOString(),
      error: doc.error,
      payload: doc.payload,
    });
    persist();
    scheduleCallback(doc);
  }

  deliveryQueue.tick();

  // Авто-восстановление «недоступной кассы»
  if (state.cashbox.downUntil && now >= state.cashbox.downUntil) {
    state.cashbox.downUntil = 0;
    log('[kassa-mock] касса снова готова к работе');
  }
}, 1000).unref();

/* ------------------------------------------------------------- request API */

function createDocument(operation, group, body, scenarioHeader = '') {
  const uuid = crypto.randomUUID();
  const externalId = String(body.external_id || '');
  // Универсальный драйвер негативов (аудит §3.1): заголовок X-Mock-Scenario
  // (fail|hang) на самом запросе — для CI и внешних интеграторов, чьи
  // external_id не начинаются с префиксов fail-/hang- (соглашение Lovii,
  // остаётся для совместимости).
  const scenario = String(scenarioHeader || '').trim().toLowerCase();
  const doc = {
    uuid,
    externalId,
    group,
    operation,                       // sell | sell_refund
    status: 'wait',
    createdAt: Date.now(),
    processAt: Date.now() + PROCESS_MS,
    processedAt: null,
    forceFail: externalId.startsWith('fail-') || scenario === 'fail',
    hang: externalId.startsWith('hang-') || scenario === 'hang',
    receipt: body.receipt,
    supplierLabel: shortSupplierName(body.receipt?.items?.[0]?.supplier_info?.name) || '—',
    supplierInnLabel: body.receipt?.items?.[0]?.supplier_info?.inn || '—',
    fiscalReceiptNumber: null,       // присваивается при печати (см. тик)
    fiscalDocumentNumber: ++state.counters.fd,
    callbackBody: null,
    payload: null,
    error: null,
  };

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

/** Выжимка запроса для журнала: скаляры без token/pass, значения до 60 символов. */
function bodySummary(body) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(body || {})) {
    if (n >= 6) break;
    if (k === 'token' || k === 'pass' || k === 'password' || v === null || v === undefined || typeof v === 'object') continue;
    out[k] = String(v).slice(0, 60);
    n += 1;
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (url.startsWith('/possystem/')) {
    const started = Date.now();
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (code, ...rest) => {
      const parsed = (() => { try { return JSON.parse(res.__mockBody || '{}'); } catch { return {}; } })();
      journal.record({ method: req.method, path: url, status: code, ms: Date.now() - started, body: bodySummary(parsed) });
      return originalWriteHead(code, ...rest);
    };
  }

  try {
    if (req.method === 'GET' && url === '/admin/journal') {
      return sendJson(res, { entries: journal.list() });
    }

    if (req.method === 'GET' && url === '/healthz') {
      return sendJson(res, { ok: !isDown(), checks: state.cashbox.checksCnt });
    }

    // Текстовая админ-консоль (как у tbank-mock).
    // Все значения экранируются: данные приходят от интегратора, а страница
    // публичная — без экранирования это XSS (дефект A-14 аудита).
    if (req.method === 'GET' && url === '/admin') {
      const docs = Object.values(state.receipts).sort((a, b) => b.createdAt - a.createdAt);
      const rows = docs.slice(0, 50).map((d) => `<tr>
        <td>${escapeHtml(d.uuid.slice(0, 8))}</td><td>${escapeHtml(d.operation)}</td><td>${escapeHtml(d.externalId)}</td>
        <td>${escapeHtml(d.status)}</td><td>${d.payload ? `ФД №${escapeHtml(d.payload.fiscal_document_number)} ФП ${escapeHtml(d.payload.fiscal_document_attribute)}` : (d.error ? escapeHtml(d.error.text) : '—')}</td>
        <td>${((d.receipt?.total || 0) / 100).toFixed(2)} р</td>
        <td>${d.callbackBody ? `<form method="POST" action="/admin/action" style="display:inline"><input type="hidden" name="action" value="resend-callback"><input type="hidden" name="uuid" value="${escapeHtml(d.uuid)}"><button style="width:auto;padding:2px 6px;font-size:11px">callback</button></form>` : '—'}</td></tr>`).join('');
      const journalRows = journal.list().slice(-15).reverse()
        .map((e) => `<tr><td>${escapeHtml(e.at.slice(11, 19))}</td><td>${escapeHtml(e.method)}</td><td><code>${escapeHtml(e.path)}</code></td><td>${escapeHtml(Object.entries(e.body || {}).map(([k, v]) => `${k}=${v}`).join(' '))}</td><td>${e.status}</td><td>${e.ms} мс</td></tr>`)
        .join('') || '<tr><td colspan="6">запросов ещё не было</td></tr>';
      return send(res, 200, `<html><head><meta charset="utf-8"><title>kassa-mock</title><style>
body{font-family:monospace;background:#111;color:#ddd;margin:20px}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #444;padding:4px 8px;font-size:13px}th{background:#222}
h1{font-size:18px} a{color:#8cf}</style></head><body>
<h1>kassa-mock — Ferma cloud-cashbox mock (${state.cashbox.kktState}, чеков: ${state.cashbox.checksCnt})</h1>
<p>POST /possystem/v1/getToken · POST /possystem/v1/{group}/sell|sell_refund · GET /possystem/v1/{group}/report/&#123;uuid&#125; · GET /possystem/v1/stats/cashboxes/extended</p>
<p>Негатив: ExternalId с префиксом <b>fail-</b> (отказ печати) / <b>hang-</b> (вечный wait); env MOCK_FERMA_DOWN=1 — касса недоступна при старте.</p>
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
  <input type="hidden" name="action" value="clear-external-ids">
  <button type="submit">Сбросить реестр external_id</button>
</form>
<p>Статус: ${isDown() ? `НЕДОСТУПНА до ${new Date(state.cashbox.downUntil).toISOString()}` : 'готова'} · external_id в реестре: ${Object.keys(state.externalIds).length}</p>
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
      if (creds.login !== MOCK_FERMA_LOGIN || creds.pass !== MOCK_FERMA_PASSWORD) {
        log(`[kassa-mock] getToken DENIED for login=${creds.login}`);
        return jsonRaw(res, 200, errBody(14, 'Неверный логин или пароль'));
      }
      const token = crypto.randomBytes(16).toString('hex');
      state.tokens[token] = { login: creds.login, createdAt: Date.now() };
      log(`[kassa-mock] getToken OK for ${creds.login}`);
      return sendJson(res, { error: null, timestamp: new Date().toISOString(), token });
    }

    const sellMatch = /^\/possystem\/v1\/([^/]+)\/(sell|sell_refund|sell_correction)$/.exec(url);
    if (req.method === 'POST' && sellMatch) {
      if (!checkToken(req.url)) return jsonRaw(res, 200, errBody(11, 'Не выполнена авторизация'));
      const raw = await readBody(req);
      res.__mockBody = raw;
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return jsonRaw(res, 200, errBody(4, 'Неверный формат запроса')); }

      const externalId = String(body.external_id || '');
      if (!externalId) return jsonRaw(res, 200, errBody(5, 'external_id обязателен'));
      // A-16: опечатка в группе раньше проходила молча, в бою это отказ кассы.
      if (GROUPS.length && !GROUPS.includes(sellMatch[1])) {
        return jsonRaw(res, 200, errBody(4, `Группа «${sellMatch[1]}» не зарегистрирована на стенде`, {
          field: 'group_code',
          hint: `Разрешённые группы задаются env MOCK_GROUPS: ${GROUPS.join(', ')}. Опечатка в группе на боевой кассе = отказ регистрации документа.`,
        }));
      }
      if (state.externalIds[externalId]) {
        return jsonRaw(res, 200, errBody(12, `Идентификатор счёта (external_id) «${externalId}» уже существует`));
      }
      if (VALIDATE_RECEIPTS) {
        const problem = validateReceipt(body.receipt);
        if (problem) {
          log(`[kassa-mock] sell REJECTED (validation): ${problem.field} — ${externalId}`);
          return jsonRaw(res, 200, errBody(4, `Чек не прошёл проверку кассы: ${problem.field}`, problem));
        }
      }

      const doc = createDocument(sellMatch[2], sellMatch[1], body, req.headers['x-mock-scenario']);
      if (doc.hang) {
        // Документ «завис»: в очередь не попал, но externalId занят — как
        // реальный «принят, не обработан».
        state.receipts[doc.uuid] = doc;
        state.externalIds[externalId] = doc.uuid;
        persist();
      }
      return sendJson(res, { uuid: doc.uuid, timestamp: new Date().toISOString(), error: null, status: 'wait' });
    }

    const reportMatch = /^\/possystem\/v1\/([^/]+)\/report\/([^/]+)$/.exec(url);
    if (req.method === 'GET' && reportMatch) {
      if (!checkToken(req.url)) return jsonRaw(res, 200, errBody(11, 'Не выполнена авторизация'));
      const doc = state.receipts[reportMatch[2]];
      if (!doc) return jsonRaw(res, 200, errBody(10, 'Документ не найден'));
      const out = { uuid: doc.uuid, external_id: doc.externalId, group_code: doc.group, type: doc.operation, status: doc.status, timestamp: new Date().toISOString(), error: doc.error, payload: doc.payload };
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
        state.cashbox.downUntil = Date.now() + Math.max(0, parseInt(body.ms, 10) || 300000);
        log(`сценарий: касса недоступна до ${new Date(state.cashbox.downUntil).toISOString()}`);
        persist();
      } else if (body.action === 'kassa-up') {
        state.cashbox.downUntil = 0;
        log('сценарий: касса снова готова к работе');
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
    log('[kassa-mock] handler error:', e.message);
    return jsonRaw(res, 500, errBody(500, e.message));
  }
});

store.restore();

// MOCK_FERMA_DOWN_MS: авто-восстановление задаётся и при старте
if (process.env.MOCK_FERMA_DOWN === 'true' || process.env.MOCK_FERMA_DOWN === '1') {
  const ms = Math.max(0, parseInt(MOCK_FERMA_DOWN_MS, 10) || 0);
  state.cashbox.downUntil = Date.now() + ms;
  log(`[kassa-mock] старт в режиме «касса недоступна»${ms ? `, восстановление через ${ms} мс` : ' (до MOCK_FERMA_DOWN=0)'}`);
}

server.listen(parseInt(MOCK_PORT, 10), MOCK_HOST, () => {
  log(`kassa-mock (Ferma cloud-cashbox mock) on ${MOCK_HOST}:${MOCK_PORT}`);
  log(`login=${MOCK_FERMA_LOGIN} process_delay=${PROCESS_MS}ms state=${MOCK_STATE_FILE || 'memory'}`);
});
