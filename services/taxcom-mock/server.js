// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * taxcom-mock — мок кабинета/ОФД «Такском», read-only API v2 (Stage 2, issue #112).
 *
 * Контракт (срез 2026-10-11, документации Такском*): API Help v2.17,
 * техническое описание от 30.12.2025. Тестовый host провайдера
 * https://api-tlk-ofd.taxcom.ru, production — https://api-lk-ofd.taxcom.ru;
 * общий путь методов /API/v2/.... Это ЧТЕНИЕ уже принятых ОФД фискальных
 * документов, а не печать чеков: не Ferma, не АТОЛ, не OKassa.
 *
 * Авторизация: POST /API/v2/Login с заголовком Integrator-ID и JSON-телом.
 * Срез ссылается на схему Login_Request из приложения к API Help, но поля
 * inline НЕ раскрывает, поэтому тело — консервативная форма {login, password}
 * (оба поля обязательны, неизвестные ключи отклоняются 400 с подсказкой)
 * с пометкой [VERIFY]: форму нужно пересверить при выдаче доступа к кабинету.
 * Ответ несёт временный marker {token}; далее все вызовы несут заголовок
 * Session-Token. TTL — 300 с (5 минут), sliding от последнего использования,
 * на ВИРТУАЛЬНЫХ часах стенда; просроченный токен → HTTP 401.
 * [FORK] Повторный Login выдаёт НОВЫЙ token, а прежний продолжает жить до
 * своего TTL: срез формулирует иначе («Повторный Login не выдаёт новый marker,
 * пока предыдущий действителен»), решение владельца зафиксировано как
 * документированный форк и требует пересверки.
 *
 * Методы чтения:
 *   GET /API/v2/AccountList  — договоры/личные кабинеты, доступные пользователю,
 *                              и его права;
 *   GET /API/v2/NewDocuments — поток новых ФД: последние 10 СУТОК, не более
 *                              10 000 за вызов, сортировка по времени приёма
 *                              Такскомом, курсор по id последнего полученного
 *                              документа (query an — номер договора, id — курсор).
 * Ошибки из среза: 3106 — нет доступной ККТ, 2203 — некорректный курсор;
 * хвост достигнут → пустой ответ (HTTP 200, []). Рекомендация опрашивать
 * «не чаще раза в минуту» — совет документации, не жёсткое правило мока.
 * Типы документов: открытие/закрытие смены, состояние расчётов, чек,
 * чек коррекции, БСО, БСО коррекции.
 *
 * Write API (создание/фискализация чека, возврат, callback печати) в публичном
 * срезе v2.17 НЕ найден и не моделируется: известный маршрут с другим методом
 * даёт 405, неизвестный /API/... — 404, обе с подсказкой. Исходящих HTTP-запросов
 * у сервиса нет (нет ни callback, ни webhook), поэтому очередь доставки ядра и
 * SSRF-политика к этому адаптеру не подключаются.
 *
 * [FORK] Локальная форма мока, а не утверждение о закрытой схеме провайдера:
 * имена полей ответа (token, an, inn, kpp, name, rights, id, type, receivedAt,
 * dateTime, fiscalDocumentNumber, fiscalSign, shiftNumber, operationType,
 * totalSum/cashSum/electronicSum, items), суммы в ЦЕЛЫХ КОПЕЙКАХ (конвенция
 * ФФД; срез Такском единицы не закрепляет), включённая нижняя граница окна
 * 10 суток, конверт ошибок {errorCodeId, message, field, hint, doc} и
 * соответствие 3106 → HTTP 403, 2203 → HTTP 400. Ставки НДС 22%/22-122 из
 * агрегатов смены v2.17 упомянуты срезом, но имена полей не раскрыты —
 * не моделируются ([VERIFY]).
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('../../packages/core');

const env = process.env;
const HOSTED = core.flagEnabled(env.MOCK_HOSTED);
const TENANCY = core.resolveTenancyMode(env.MOCK_TENANCY, HOSTED);
const PORT = Number(env.MOCK_PORT || 3109);
const PUBLIC_BASE_URL = env.MOCK_TAXCOM_PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const PROVIDER_DOC = 'https://lk-ofd.taxcom.ru/ApiHelp/';

/* Синтетические дефолты: публичных тестовых login/password/Integrator-ID
 * Такском не публикует (документации Такском) —
 * их выдаёт техподдержка/кабинет. Значения ниже — креды МОКА, не реквизиты
 * провайдера; production-креды в коде/compose не публикуются. */
const DEFAULT_LOGIN = 'taxcommocktest';
const DEFAULT_PASSWORD = 'mockpass123';
const DEFAULT_INTEGRATOR_ID = 'TAXCOMMOCKTEST';
const credLogView = (actual, dflt) => (actual === dflt ? dflt : '<задан через env, скрыт>');

const SESSION_TTL_DEFAULT_SECS = 300;
const ttlRaw = env.MOCK_TAXCOM_SESSION_TTL_SECS || String(SESSION_TTL_DEFAULT_SECS);
if (!/^\d+$/.test(ttlRaw) || !Number.isSafeInteger(Number(ttlRaw)) || Number(ttlRaw) < 1
    || Number(ttlRaw) > 31536000) throw new Error('MOCK_TAXCOM_SESSION_TTL_SECS: integer seconds 1..31536000 required');
const SESSION_TTL_SECS = Number(ttlRaw);
// Границы из среза: окно 10 суток и не более 10 000 документов за вызов.
const WINDOW_DAYS = 10;
/* Лимиты тела: для методов провайдера тело крошечное (Login_Request), поэтому
 * 1 МиБ; импорт fixtures — mock-control и legitimately большой, поэтому 8 МиБ
 * (совпадает с дефолтным per-sandbox байтовым бюджетом состояния). */
const PROVIDER_BODY_LIMIT = 1024 * 1024;
const CONTROL_BODY_LIMIT = 8 * 1024 * 1024;
const PAGE_LIMIT_MAX = 10000;
const DOCUMENT_TYPES = [
  'openShift', 'closeShift', 'currentStateReport',
  'receipt', 'receiptCorrection', 'bso', 'bsoCorrection',
];
const API_ERRORS = {
  3106: 'Нет доступной ККТ',
  2203: 'Некорректный курсор',
};
// Литеральная таблица dispatch: drift сверяет её с OpenAPI НЕЗАВИСИМО.
const ROUTES = [
  ['POST', '/API/v2/Login'],
  ['GET', '/API/v2/AccountList'],
  ['GET', '/API/v2/NewDocuments'],
];
const MOCK_ROUTES = {
  '/health': ['GET'], '/openapi.json': ['GET'], '/admin': ['GET'], '/admin/journal': ['GET'],
  '/mock/time': ['GET', 'POST'], '/mock/state': ['GET', 'PUT'], '/mock/reset': ['POST'],
  '/mock/scenarios': ['GET', 'POST', 'DELETE'], '/mock/sandboxes': ['GET', 'POST', 'DELETE'],
  '/sandboxes': ['GET', 'POST', 'DELETE'], '/sandboxes/me': ['GET', 'DELETE'],
  '/sandboxes/me/reset': ['POST'], '/sandboxes/me/reset-creds': ['POST'],
};

/* Демо-фикстуры задаются СМЕЩЕНИЕМ от базы стенда, а не жёсткой датой: окно
 * NewDocuments — «последние 10 суток», поэтому абсолютные даты устарели бы
 * вместе со стендом. База — MOCK_VIRTUAL_CLOCK, иначе wall-clock. */
const FIXTURE_BASE_MS = (() => {
  const raw = String(env.MOCK_VIRTUAL_CLOCK || '').trim();
  if (!raw) return Date.now();
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.now();
})();
const at = (minutesAgo) => new Date(FIXTURE_BASE_MS - minutesAgo * 60000).toISOString();

// [FORK] Синтетический каталог; запрещённые объекты отличают 403/3106 от 404.
// Даты мока — UTC: timezone провайдера публичным срезом не закреплён.
function initialState() {
  const accounts = [
    { an: '1000001', inn: '7700000000', kpp: '770001001', name: 'Демо кабинет Такском', accessible: true },
    { an: '1000002', inn: '7800000000', kpp: '780001001', name: 'Кабинет без доступной ККТ', accessible: true },
    { an: '1000003', inn: '7900000000', kpp: '790001001', name: 'Нет согласия на данные', accessible: false },
  ];
  const kkt = [
    { an: '1000001', regNumber: '0000000000000001', model: 'MOCK-KKT',
      fiscalDriveNumber: '9999078900000001', address: 'Тестовый адрес, 1', accessible: true },
    { an: '1000001', regNumber: '0000000000000002', model: 'MOCK-KKT',
      fiscalDriveNumber: '9999078900000002', address: 'Нет согласия на кассу', accessible: false },
    { an: '1000002', regNumber: '0000000000000003', model: 'MOCK-KKT',
      fiscalDriveNumber: '9999078900000003', address: 'Касса без прав', accessible: false },
  ];
  const cash = { operationType: 1, totalSum: 12345, cashSum: 0, electronicSum: 12345,
    items: [{ name: 'Тестовый товар', price: 12345, quantity: 1, sum: 12345 }] };
  const doc = (n, minutesAgo, type, extra = {}) => ({
    id: `doc-${String(n).padStart(4, '0')}`, an: '1000001', kktRegNumber: '0000000000000001',
    type, receivedAt: at(minutesAgo), dateTime: at(minutesAgo + 3),
    fiscalDocumentNumber: n, fiscalSign: String(1000000000 + n), shiftNumber: 1, ...extra,
  });
  const documents = [
    doc(1, 12960, 'openShift'),
    doc(2, 12955, 'receipt', cash),
    doc(3, 12780, 'currentStateReport'),
    doc(4, 8700, 'receipt', { ...cash, operationType: 2 }),
    doc(5, 7260, 'bso', cash),
    doc(6, 5820, 'receiptCorrection', { ...cash, correctionCause: 0 }),
    doc(7, 4380, 'bsoCorrection', { ...cash, correctionCause: 0 }),
    doc(8, 2940, 'receipt', cash),
    doc(9, 960, 'closeShift'),
    doc(10, 180, 'openShift'),
    // Документы, которые не должны попасть в выдачу: касса без согласия,
    // договор без доступной ККТ и документ старше окна 10 суток.
    { ...doc(11, 150, 'receipt', cash), kktRegNumber: '0000000000000002' },
    { ...doc(12, 140, 'receipt', cash), an: '1000002', kktRegNumber: '0000000000000003' },
    // receivedAt раньше, а dateTime позже, чем у doc-0014: сортировка — по приёму.
    { ...doc(13, 120, 'receipt', cash), dateTime: at(60) },
    { ...doc(14, 60, 'currentStateReport'), dateTime: at(200) },
    doc(15, 36000, 'receipt', cash),
  ];
  return { accounts, kkt, documents, sessions: {}, clockOffsetMs: 0 };
}

const store = core.createStore({ stateFile: env.MOCK_STATE_FILE || '' });
Object.assign(store.state, initialState());
store.restore();
let clearChild = () => {};
const sandboxRuntime = core.createSandboxRuntime({
  state: store.state, persist: store.persist, initialStateFactory: initialState,
  mode: TENANCY, hosted: HOSTED, stateFile: env.MOCK_STATE_FILE || '', sandboxFile: env.MOCK_SANDBOX_FILE || '',
  ttlMs: core.parseMsOr(env.MOCK_SANDBOX_TTL_MS, TENANCY === 'owned' ? 86400000 : 0),
  maxSandboxes: core.parseMsOr(env.MOCK_SANDBOX_MAX, 100),
  maxDocuments: core.parseMsOr(env.MOCK_SANDBOX_MAX_DOCUMENTS, TENANCY === 'owned' ? 5000 : 0),
  maxStateBytes: core.parseMsOr(env.MOCK_SANDBOX_MAX_STATE_BYTES, null),
  globalMaxStateBytes: core.parseMsOr(env.MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES, null),
  documentCounter: (s) => s.documents.length + Object.keys(s.sessions).length,
  defaultOwnerToken: env.MOCK_SANDBOX_TOKEN || '', hostSuffix: env.MOCK_SANDBOX_HOST_SUFFIX || '',
  operatorTokens: [env.MOCK_ADMIN_TOKEN, env.MOCK_OPERATOR_TOKEN],
  createLimit: core.parseMsOr(env.MOCK_SANDBOX_CREATE_LIMIT, 20),
  // #121: диагностика ядра (WARN query-токенов, сбои persist/restore) не
  // должна быть заглушена — тегированный лог, как у остальных адаптеров.
  log: (msg) => console.error(`[taxcom-mock] ${msg}`),
  onSandboxRemoved: (record) => clearChild(record),
});
const state = sandboxRuntime.state;
const persist = sandboxRuntime.persist;
const clock = core.createVirtualClock({ initial: env.MOCK_VIRTUAL_CLOCK,
  getStateOffset: () => state.clockOffsetMs || 0,
  setStateOffset: (value) => { state.clockOffsetMs = value; persist(); },
});
const scenarios = core.createScenarioRegistry({ clock, sandboxScope: () => sandboxRuntime.current() });
const journal = core.createJournal({ size: 200, sandboxScope: () => sandboxRuntime.current() });
clearChild = (record) => { scenarios.dropScope(record); journal.dropScope(record); };
function clearRecord(record) {
  scenarios.clearRulesFor(record); scenarios.clearHistoryFor(record); journal.clearFor(record);
}
function credentials() {
  const own = sandboxRuntime.creds();
  return { login: own.login || env.MOCK_TAXCOM_LOGIN || DEFAULT_LOGIN,
    password: own.password || env.MOCK_TAXCOM_PASSWORD || DEFAULT_PASSWORD,
    integratorId: own.integratorId || env.MOCK_TAXCOM_INTEGRATOR_ID || DEFAULT_INTEGRATOR_ID };
}
function freshCredentials() {
  return { login: `mock-${crypto.randomUUID()}@example.invalid`,
    password: crypto.randomBytes(24).toString('hex'),
    integratorId: `mock-integrator-${crypto.randomBytes(8).toString('hex')}` };
}
function equal(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function error(res, status, message, errorCodeId = status, extra = {}) {
  const hint = errorCodeId === 401 ? 'Получите token через POST /API/v2/Login (заголовок Integrator-ID) и передавайте его в Session-Token.'
    : errorCodeId === 3106 ? 'Проверьте доступные договоры и ККТ через GET /API/v2/AccountList; у пользователя нет видимой ККТ.'
      : errorCodeId === 2203 ? 'Передайте id последнего полученного документа из предыдущего ответа или уберите параметр id.'
        : status === 405 ? 'Метод не поддерживается: публичный срез v2.17 read-only, write API не моделируется.'
          : status === 404 ? 'Маршрут не найден. Чтение: /API/v2/AccountList и /API/v2/NewDocuments; создание/фискализация чека не моделируется.'
            : 'Проверьте параметры по OpenAPI и инструкции docs/integration/taxcom.md.';
  return core.sendJson(res, { errorCodeId, message, field: 'request', hint, doc: PROVIDER_DOC, ...extra }, status);
}
function sandboxError(res, result) {
  const kind = result.kind || result.error;
  const status = kind === 'expired' ? 410 : kind === 'not-found' ? 404 : 401;
  // MS-12 (#121): отказ может нести точную причину и хинт от ядра
  // (закрытая default в hosted и т.п.) — не подменяем их общей формулировкой.
  return error(res, status, result.message || `Sandbox: ${kind}; знание ID не является доступом`, status,
    result.hint ? { hint: result.hint } : {});
}
function publicObject(o) {
  const { accessible, ...rest } = o;
  return rest;
}
function matchRoute(p) {
  for (const [method, template] of ROUTES) if (template === p) return { method, template };
  return null;
}
function dateValue(text) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text || '')) return NaN;
  if (Number(text.slice(11, 13)) > 23 || Number(text.slice(14, 16)) > 59 || Number(text.slice(17, 19)) > 59) return NaN;
  const ms = Date.parse(text);
  // Date.parse нормализует 2026-02-30: явно отклоняем невозможные даты.
  const calendar = text.slice(0, 10);
  const dayMs = Date.parse(`${calendar}T00:00:00Z`);
  if (!Number.isFinite(dayMs) || new Date(dayMs).toISOString().slice(0, 10) !== calendar) return NaN;
  return ms;
}
function validFixture(snapshot) {
  const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const string = (v) => typeof v === 'string' && v.length > 0;
  if (!object(snapshot) || !['accounts', 'kkt', 'documents'].every((k) => Array.isArray(snapshot[k]))) return false;
  if (snapshot.clockOffsetMs !== undefined && !Number.isFinite(snapshot.clockOffsetMs)) return false;
  if (!snapshot.accounts.every((a) => object(a) && string(a.an) && typeof a.accessible === 'boolean')) return false;
  if (!snapshot.kkt.every((c) => object(c) && string(c.an) && string(c.regNumber) && typeof c.accessible === 'boolean')) return false;
  return snapshot.documents.every((d) => object(d) && string(d.id) && string(d.an) && string(d.kktRegNumber)
    && DOCUMENT_TYPES.includes(d.type) && Number.isFinite(dateValue(d.receivedAt))
    && Number.isFinite(dateValue(d.dateTime)) && Number.isSafeInteger(d.fiscalDocumentNumber)
    && d.fiscalDocumentNumber > 0 && string(d.fiscalSign)
    && ['totalSum', 'cashSum', 'electronicSum'].every((k) => d[k] === undefined || (Number.isSafeInteger(d[k]) && d[k] >= 0))
    && (d.items === undefined || (Array.isArray(d.items) && d.items.every((item) => object(item)
      && typeof item.name === 'string' && Number.isSafeInteger(item.price) && item.price >= 0
      && Number.isSafeInteger(item.sum) && item.sum >= 0 && Number.isFinite(item.quantity) && item.quantity > 0))));
}
// Session-Token: единственная проверка доступа к /API/v2/AccountList и NewDocuments.
function authenticate(req, res) {
  const token = String(req.headers['session-token'] || '').trim();
  const session = token && Object.hasOwn(state.sessions, token) ? state.sessions[token] : null;
  if (!session) {
    error(res, 401, 'Session-Token отсутствует или неизвестен', 401, { field: 'Session-Token' }); return false;
  }
  if (session.expiresAt <= clock.now()) {
    // Просроченная сессия удаляется сразу: повторное использование невозможно.
    delete state.sessions[token]; persist();
    error(res, 401, `Session-Token истёк (TTL ${SESSION_TTL_SECS} с, sliding)`, 401, { field: 'Session-Token' });
    return false;
  }
  // Sliding: TTL считается от последнего успешного использования.
  session.expiresAt = clock.now() + SESSION_TTL_SECS * 1000;
  persist();
  return true;
}
function readAccountList(res) {
  return core.sendJson(res, state.accounts.filter((a) => a.accessible)
    .map((a) => ({ ...publicObject(a), rights: ['documents:read'] })));
}
function readNewDocuments(res, url, spec) {
  const q = url.searchParams;
  const accessible = state.accounts.filter((a) => a.accessible);
  const an = q.has('an') ? String(q.get('an')) : '';
  if (an && !accessible.some((a) => a.an === an)) {
    return error(res, 404, 'Договор не найден или недоступен', 404, { field: 'an' });
  }
  const scope = an ? accessible.filter((a) => a.an === an) : accessible;
  const regNumbers = state.kkt.filter((c) => c.accessible && scope.some((a) => a.an === c.an)).map((c) => c.regNumber);
  if (!regNumbers.length) return error(res, 403, API_ERRORS[3106], 3106, { field: 'an' });
  const now = clock.now();
  const from = now - WINDOW_DAYS * 86400000;
  // Окно 10 суток и сортировка по времени приёма; дубликат id — по первому вхождению.
  const selection = state.documents
    .filter((d) => regNumbers.includes(d.kktRegNumber))
    .filter((d) => {
      const received = dateValue(d.receivedAt);
      return Number.isFinite(received) && received >= from && received <= now;
    })
    .sort((a, b) => dateValue(a.receivedAt) - dateValue(b.receivedAt) || a.id.localeCompare(b.id));
  // [FORK] Повтор строки ДО курсорной нарезки: тот же id/ФД/ФП, лимит страницы сохраняется.
  if (spec.has('duplicate') && selection.length) selection.splice(1, 0, { ...selection[0] });
  let start = 0;
  if (q.has('id')) {
    const index = selection.findIndex((d) => d.id === q.get('id'));
    if (index < 0) return error(res, 400, API_ERRORS[2203], 2203, { field: 'id' });
    start = index + 1;
  }
  return core.sendJson(res, selection.slice(start, start + PAGE_LIMIT_MAX).map(publicObject));
}

function handleSandboxes(req, res, url, body, p) {
  const operator = sandboxRuntime.isOperatorRequest(req);
  if (p.startsWith('/sandboxes/me')) {
    const record = sandboxRuntime.recordByOwnerToken(req) || (TENANCY === 'owned' ? null : sandboxRuntime.current());
    if (!record) return error(res, 401, 'Требуется X-Sandbox-Token');
    if (p === '/sandboxes/me' && req.method === 'GET') return core.sendJson(res, { sandbox: sandboxRuntime.describe(record) });
    if (p === '/sandboxes/me/reset-creds') {
      const creds = freshCredentials();
      const result = sandboxRuntime.updateCreds(record.id, creds, req);
      if (!result.ok) return sandboxError(res, result);
      // Rotation отзывает пользовательские сессии; /me не раскрывает креды.
      const snapshot = sandboxRuntime.exportState(record.id, req);
      if (!snapshot.ok) return sandboxError(res, snapshot);
      snapshot.state.sessions = {};
      const imported = sandboxRuntime.importState(snapshot.state, record.id, req);
      if (!imported.ok) return sandboxError(res, imported);
      return core.sendJson(res, { ok: true, creds, ownerTokenChanged: false });
    }
    const result = p.endsWith('/reset') ? sandboxRuntime.reset(record.id, req) : sandboxRuntime.remove(record.id, req);
    if (!result.ok) return sandboxError(res, result);
    clearRecord(record);
    return core.sendJson(res, result);
  }
  if (req.method === 'GET') {
    const own = sandboxRuntime.recordByOwnerToken(req);
    if (TENANCY === 'owned' && !operator && !own) return error(res, 401, 'Требуется owner-token');
    return core.sendJson(res, { mode: TENANCY, sandboxes: TENANCY === 'owned' && !operator
      ? [sandboxRuntime.describe(own)] : sandboxRuntime.list() });
  }
  if (req.method === 'POST') {
    if (TENANCY !== 'owned') {
      const result = sandboxRuntime.switchActive(body.sandbox || 'default');
      return result.ok ? core.sendJson(res, result) : error(res, 400, result.error);
    }
    const created = sandboxRuntime.create({ id: String(body.id || body.sandbox || ''),
      creds: freshCredentials(), profile: 'taxcom', ip: req.socket.remoteAddress });
    return core.sendJson(res, { id: created.id, ownerToken: created.ownerToken, creds: created.creds,
      expiresAt: created.expiresAt, url: `${PUBLIC_BASE_URL}/?sandbox=${encodeURIComponent(created.id)}` }, 201);
  }
  const result = sandboxRuntime.remove(body.sandbox || url.searchParams.get('sandbox'), req);
  return result.ok ? core.sendJson(res, result) : sandboxError(res, result);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://mock.local');
  const p = url.pathname;
  const policy = ['/health', '/openapi.json', '/sandboxes'].includes(p) || p.startsWith('/sandboxes/')
    ? 'public' : p.startsWith('/mock/') || p.startsWith('/admin') ? 'control' : 'business';
  const admission = sandboxRuntime.admit(req, policy);
  if (!admission.ok) return sandboxError(res, admission);
  return sandboxRuntime.run(admission, async () => {
    const surface = p.startsWith('/admin') ? 'admin' : p.startsWith('/mock/') ? 'operator' : null;
    const owner = sandboxRuntime.recordByOwnerToken(req);
    if (surface && !(surface === 'operator' && owner?.id === admission.record.id)) {
      const access = core.checkControlAccess(req, { adminToken: env.MOCK_ADMIN_TOKEN,
        operatorToken: env.MOCK_OPERATOR_TOKEN, surface, hosted: HOSTED });
      if (!access.allowed) return error(res, 401, `Control access: ${access.reason}`);
    }
    const matched = matchRoute(p);
    const methods = matched ? [matched.method] : MOCK_ROUTES[p];
    if (!methods) return error(res, 404, 'Маршрут не найден; write API не моделируется');
    if (!methods.includes(req.method)) return error(res, 405, 'Метод не поддерживается');
    const raw = await core.readBody(req, p === '/mock/state' ? CONTROL_BODY_LIMIT : PROVIDER_BODY_LIMIT);
    let body = {};
    if (raw) {
      try { body = JSON.parse(raw); } catch { return error(res, 400, 'Некорректный JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return error(res, 400, 'Ожидается JSON-объект');
    }
    if (p === '/health') return core.sendJson(res, { ok: true, service: 'taxcom-mock', tenancy: TENANCY });
    if (p === '/openapi.json') return core.sendJson(res, JSON.parse(fs.readFileSync(path.join(__dirname,
      '../../docs/openapi/taxcom-mock.openapi.json'), 'utf8')));
    if (p === '/sandboxes' || p === '/mock/sandboxes' || p.startsWith('/sandboxes/')) return handleSandboxes(req, res, url, body, p);
    if (p === '/mock/time') {
      try { return core.sendJson(res, req.method === 'GET' ? clock.snapshot() : clock.set(body)); }
      catch (e) {
        if (core.sendSandboxStateQuotaError(res, e)) return;
        return error(res, 400, e.message);
      }
    }
    if (p === '/mock/reset') {
      const target = body.sandbox || admission.record.id;
      const result = sandboxRuntime.reset(target, req);
      if (!result.ok) return sandboxError(res, result);
      clearRecord(sandboxRuntime.find(target));
      return core.sendJson(res, result);
    }
    if (p === '/mock/state') {
      if (req.method === 'GET') {
        const snapshot = sandboxRuntime.exportState(null, req);
        if (!snapshot.ok) return sandboxError(res, snapshot);
        // Session-Token — секрет: экспорт его не раскрывает. После restore нужен новый Login.
        snapshot.state.sessions = {};
        return core.sendJson(res, snapshot);
      }
      try {
        const snapshot = body.state || body;
        if (!validFixture(snapshot)) return error(res, 400, 'Недопустимый fixture: accounts[], kkt[], documents[]; receivedAt/dateTime — ISO, суммы целыми копейками');
        const result = sandboxRuntime.importState({ ...snapshot, sessions: {} }, admission.record.id, req);
        return result.ok ? core.sendJson(res, result) : sandboxError(res, result);
      } catch (e) {
        if (core.sendSandboxStateQuotaError(res, e)) return;
        return error(res, 400, e.message);
      }
    }
    if (p === '/mock/scenarios') {
      if (req.method === 'GET') return core.sendJson(res, { rules: scenarios.listRules(), history: scenarios.listHistory() });
      if (req.method === 'DELETE') { scenarios.clearRules(); scenarios.clearHistory(); return core.sendJson(res, { ok: true }); }
      try { return core.sendJson(res, { ok: true, rule: scenarios.addRule(body) }); }
      catch (e) { return error(res, 400, e.message); }
    }
    if (p === '/admin/journal') return core.sendJson(res, { entries: journal.list() });
    if (p === '/admin') {
      const view = { sandbox: sandboxRuntime.currentId(), time: clock.iso(),
        accounts: state.accounts.map(publicObject), kkt: state.kkt.map(publicObject),
        documents: state.documents.map(publicObject), liveSessions: Object.keys(state.sessions).length,
        scenarios: scenarios.listRules(), requests: journal.list().length };
      return core.send(res, 200, `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Такском</title><h1>Такском — read-only кабинет/ОФД (API v2)</h1><p>Чтение принятых ОФД документов. Создание/фискализация чека и callback печати не моделируются.</p><pre>${core.escapeHtml(JSON.stringify(view, null, 2))}</pre></html>`,
        { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    }
    // Не журналируем тело Login (пароль), Session-Token, Integrator-ID и raw headers.
    const started = Date.now();
    res.once('finish', () => journal.record({ method: req.method, path: matched.template,
      status: res.statusCode, ms: Date.now() - started }));
    const spec = scenarios.resolve({ header: req.headers['x-mock-scenario'] || '',
      target: p === '/API/v2/Login' ? 'auth' : 'read', context: matched.template === '/API/v2/NewDocuments'
        ? { an: url.searchParams.get('an') || '' } : {} });
    const chaos = await core.applyRequestChaos(req, spec);
    sandboxRuntime.current(); // Проверка аренды после await, без fallback в default.
    if (chaos.abortStatus) return error(res, chaos.abortStatus, chaos.abortMessage);
    if (spec.has('hang')) return new Promise((resolve) => res.once('close', resolve));
    if (spec.has('fail')) return error(res, 500, 'Смоделированная ошибка');
    if (p === '/API/v2/Login') {
      const creds = credentials();
      const integratorId = String(req.headers['integrator-id'] || '').trim();
      if (!integratorId) return error(res, 401, 'Заголовок Integrator-ID обязателен', 401, { field: 'Integrator-ID' });
      if (!equal(integratorId, creds.integratorId)) return error(res, 401, 'Неизвестный Integrator-ID', 401, { field: 'Integrator-ID' });
      // [VERIFY] Форма тела Login_Request публично не раскрыта: строго {login, password}.
      const keys = Object.keys(body);
      if (keys.some((k) => k !== 'login' && k !== 'password')) {
        return error(res, 400, 'Неизвестные поля тела Login_Request', 400,
          { field: keys.find((k) => k !== 'login' && k !== 'password'), verify: 'Login_Request [VERIFY]' });
      }
      if (typeof body.login !== 'string' || typeof body.password !== 'string' || !body.login || !body.password) {
        return error(res, 400, 'Ожидается {"login": string, "password": string}', 400, { field: 'login' });
      }
      if (!equal(body.login, creds.login) || !equal(body.password, creds.password)) {
        return error(res, 401, 'Неверные реквизиты', 401, { field: 'login' });
      }
      const now = clock.now();
      for (const [token, session] of Object.entries(state.sessions)) if (session.expiresAt <= now) delete state.sessions[token];
      const quota = sandboxRuntime.checkDocuments();
      if (!quota.ok) return error(res, 429, 'Лимит сессий песочницы');
      // [FORK] Новый marker при каждом Login; прежние живут до своего TTL.
      const token = crypto.randomBytes(24).toString('hex');
      state.sessions[token] = { expiresAt: now + SESSION_TTL_SECS * 1000, issuedAt: now };
      persist();
      return core.sendJson(res, { token }, 200, {
        'X-Mock-Token-Expires-At': new Date(now + SESSION_TTL_SECS * 1000).toISOString(),
        'X-Mock-Token-Ttl-Secs': String(SESSION_TTL_SECS),
      });
    }
    if (!authenticate(req, res)) return;
    return p === '/API/v2/AccountList' ? readAccountList(res) : readNewDocuments(res, url, spec);
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  route(req, res).catch((e) => {
    if (res.headersSent || res.destroyed) return;
    if (core.sendSandboxStateQuotaError(res, e)) return;
    const status = e.code === 'BODY_TOO_LARGE' ? 413 : e.code === 'SANDBOX_EXPIRED' ? 410
      : e.code === 'SANDBOX_EXISTS' ? 409 : e.code?.startsWith('SANDBOX_') ? 429 : e instanceof URIError ? 400 : 500;
    error(res, status, status === 500 ? 'Внутренняя ошибка мока' : e.message);
  });
});
const sweep = setInterval(() => sandboxRuntime.sweep(), core.parseMsOr(env.MOCK_SANDBOX_SWEEP_MS, 60000) || 60000);
sweep.unref();
server.on('close', () => { clearInterval(sweep); sandboxRuntime.flush(); });
if (require.main === module) {
  // MS-04: общий хелпер ядра (flush → server.close → closeAllConnections → exit 0).
  core.installGracefulShutdown({ server, flush: () => sandboxRuntime.flush(), log: console.log });
  server.listen(PORT, env.MOCK_HOST || '0.0.0.0', () => {
    const creds = credentials();
    // Синтетические дефолты печатаются явно; заданные через env — скрываются.
    console.log(`taxcom-mock listening on :${server.address().port}; read-only /API/v2 (Login, AccountList, NewDocuments)`);
    console.log(`taxcom-mock synthetic credentials (не реквизиты Такском): login=${credLogView(creds.login, DEFAULT_LOGIN)} `
      + `password=${credLogView(creds.password, DEFAULT_PASSWORD)} Integrator-ID=${credLogView(creds.integratorId, DEFAULT_INTEGRATOR_ID)}; `
      + `Session-Token TTL ${SESSION_TTL_SECS}s sliding (virtual clock)`);
  });
}
module.exports = { server, state, sandboxRuntime, clock, ROUTES, MOCK_ROUTES, DOCUMENT_TYPES,
  SESSION_TTL_DEFAULT_SECS, WINDOW_DAYS, PAGE_LIMIT_MAX, DEFAULT_LOGIN, DEFAULT_PASSWORD,
  DEFAULT_INTEGRATOR_ID };
