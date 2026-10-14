// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Read/reconciliation по срезу 2026-10-11: docs/reference/kontur-ofd/*.md.
// Очередь фискализации и callback печати вне публичного контракта.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('../../packages/core');
const env = process.env;
const HOSTED = core.flagEnabled(env.MOCK_HOSTED);
const TENANCY = core.resolveTenancyMode(env.MOCK_TENANCY, HOSTED);
const PORT = Number(env.MOCK_PORT || 3108);
const PUBLIC_BASE_URL = env.MOCK_KONTUR_OFD_PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const SID_TTL_DEFAULT_SECS = 2592000;
const PAGE_LIMIT_MAX = 1000;
const ttlRaw = env.MOCK_KONTUR_OFD_SID_TTL_SECS || String(SID_TTL_DEFAULT_SECS);
if (!/^\d+$/.test(ttlRaw) || !Number.isSafeInteger(Number(ttlRaw)) || Number(ttlRaw) < 1
    || Number(ttlRaw) > 31536000) throw new Error('MOCK_KONTUR_OFD_SID_TTL_SECS: integer seconds 1..31536000 required');
const SID_TTL_SECS = Number(ttlRaw);
const DOCUMENT_TYPES = [
  'fiscalReport', 'fiscalReportCorrection', 'currentStateReport', 'openShift', 'closeShift',
  'receipt', 'bso', 'receiptCorrection', 'bsoCorrection', 'closeArchive',
];
// Литеральная таблица dispatch: drift сверяет её с OpenAPI НЕЗАВИСИМО.
const ROUTES = [
  ['POST', '/auth/authenticate-by-pass'],
  ['GET', '/v2/organizations'],
  ['GET', '/v2/organizations/{organizationId}/cashboxes'],
  ['GET', '/v2/organizations/{organizationId}/cashboxes/{kktRegId}/documents'],
  ['GET', '/v2/organizations/{organizationId}/cashboxes/{kktRegId}/documents/by-period'],
  ['GET', '/v2/organizations/{organizationId}/cashboxes/{kktRegId}/documents/{documentId}'],
];
const MOCK_ROUTES = {
  '/health': ['GET'], '/openapi.json': ['GET'], '/admin': ['GET'], '/admin/journal': ['GET'],
  '/mock/time': ['GET', 'POST'], '/mock/state': ['GET', 'PUT'], '/mock/reset': ['POST'],
  '/mock/scenarios': ['GET', 'POST', 'DELETE'], '/mock/sandboxes': ['GET', 'POST', 'DELETE'],
  '/sandboxes': ['GET', 'POST', 'DELETE'], '/sandboxes/me': ['GET', 'DELETE'],
  '/sandboxes/me/reset': ['POST'], '/sandboxes/me/reset-creds': ['POST'],
};

// [FORK] Синтетический каталог; запрещённые объекты отличают 403 от 404.
// Даты мока — UTC: timezone провайдера не закреплён публичным срезом.
function initialState() {
  const organizations = [
    { id: 'org-demo', inn: '7700000000', kpp: '770001001', name: 'Демо организация', accessible: true },
    { id: 'org-restricted', inn: '7800000000', kpp: '780001001', name: 'Нет согласия', accessible: false },
  ];
  const cashboxes = [
    { organizationId: 'org-demo', regNumber: '0000000000000001', model: 'MOCK-KKT',
      fiscalDriveNumber: '9999078900000001', address: 'Тестовый адрес, 1',
      addresses: [{ address: 'Тестовый адрес, 1', dateFrom: '2026-01-01T00:00:00Z', dateTo: null }],
      accessPeriod: { dateFrom: '2026-01-01T00:00:00Z', dateTo: '2027-01-01T00:00:00Z' }, accessible: true },
    { organizationId: 'org-demo', regNumber: '0000000000000002', model: 'MOCK-KKT',
      fiscalDriveNumber: '9999078900000002', address: 'Нет согласия', addresses: [],
      accessPeriod: { dateFrom: null, dateTo: null }, accessible: false },
  ];
  const documents = DOCUMENT_TYPES.flatMap((type, i) => Array.from({ length: type === 'receipt' ? 3 : 1 }, (_, n) => ({
    id: `doc-${i + 1}-${n + 1}`, organizationId: 'org-demo', kktRegId: cashboxes[0].regNumber,
    type, date: `2026-10-11T12:${String(i).padStart(2, '0')}:${String(n).padStart(2, '0')}Z`,
    fiscalDocumentNumber: i * 10 + n + 1, fiscalSign: String(1000000000 + i * 10 + n),
    shiftNumber: 1,
    ...(['receipt', 'bso', 'receiptCorrection', 'bsoCorrection'].includes(type) ? {
      operationType: n === 1 ? 2 : 1, totalSum: 12345, cashSum: 0, electronicSum: 12345,
      items: [{ name: 'Тестовый товар', price: 12345, quantity: 1, sum: 12345 }],
    } : {}),
  })));
  return { organizations, cashboxes, documents, sessions: {}, clockOffsetMs: 0 };
}
const store = core.createStore({ stateFile: env.MOCK_STATE_FILE || '' });
Object.assign(store.state, initialState());
store.restore();
let clearChild = () => {};
const sandboxRuntime = core.createSandboxRuntime({
  state: store.state, persist: store.persist, initialStateFactory: initialState,
  mode: TENANCY, stateFile: env.MOCK_STATE_FILE || '', sandboxFile: env.MOCK_SANDBOX_FILE || '',
  ttlMs: core.parseMsOr(env.MOCK_SANDBOX_TTL_MS, TENANCY === 'owned' ? 86400000 : 0),
  maxSandboxes: core.parseMsOr(env.MOCK_SANDBOX_MAX, 100),
  maxDocuments: core.parseMsOr(env.MOCK_SANDBOX_MAX_DOCUMENTS, TENANCY === 'owned' ? 5000 : 0),
  maxStateBytes: core.parseMsOr(env.MOCK_SANDBOX_MAX_STATE_BYTES, null),
  globalMaxStateBytes: core.parseMsOr(env.MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES, null),
  documentCounter: (s) => s.documents.length + Object.keys(s.sessions).length,
  defaultOwnerToken: env.MOCK_SANDBOX_TOKEN || '', hostSuffix: env.MOCK_SANDBOX_HOST_SUFFIX || '',
  operatorTokens: [env.MOCK_ADMIN_TOKEN, env.MOCK_OPERATOR_TOKEN],
  createLimit: core.parseMsOr(env.MOCK_SANDBOX_CREATE_LIMIT, 20),
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
const credentials = () => {
  const own = sandboxRuntime.creds();
  return { login: own.login || env.MOCK_KONTUR_OFD_LOGIN || '',
    password: own.password || env.MOCK_KONTUR_OFD_PASSWORD || '',
    apiKey: own.apiKey || env.MOCK_KONTUR_OFD_API_KEY || '' };
};
function freshCredentials() {
  return { login: `mock-${crypto.randomUUID()}@example.invalid`,
    password: crypto.randomBytes(24).toString('hex'), apiKey: crypto.randomBytes(24).toString('hex') };
}
function equal(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function error(res, status, message, errorCodeId = status, extra = {}) {
  const hint = errorCodeId === 401002 ? 'Получите Sid через POST /auth/authenticate-by-pass?login=<email> (UTF-8 password в body).'
    : errorCodeId === 401003 ? 'Передайте выданный X-Kontur-Ofd-ApiKey; это не Sid.'
      : status === 403 ? 'Проверьте согласие владельца организации/кассы на передачу данных.'
        : status === 404 ? 'Используйте ID из списка доступных организаций, касс и документов.'
          : 'Проверьте параметры по OpenAPI и инструкции docs/integration/kontur-ofd.md.';
  return core.sendJson(res, { errorCodeId, message, field: 'request', hint,
    doc: 'https://docs-ofd-api.kontur.ru/Responses.html', ...extra }, status);
}
function sandboxError(res, result) {
  const kind = result.kind || result.error;
  return error(res, kind === 'expired' ? 410 : kind === 'not-found' ? 404 : 401,
    `Sandbox: ${kind}; знание ID не является доступом`);
}
function publicObject(o) {
  const { accessible, organizationId, kktRegId, ...rest } = o;
  return rest;
}
function authenticateData(req, res) {
  const sid = /^auth\.sid (\S+)$/i.exec(req.headers.authorization || '')?.[1];
  const session = sid && Object.hasOwn(state.sessions, sid) && state.sessions[sid];
  if (!session || session.expiresAt <= clock.now()) {
    error(res, 401, 'Получите новую сессию', 401002); return false;
  }
  if (!credentials().apiKey || !equal(req.headers['x-kontur-ofd-apikey'], credentials().apiKey)) {
    error(res, 401, 'Неизвестный или отсутствующий API key', 401003); return false;
  }
  return true;
}
function matchRoute(p) {
  for (const [method, template] of ROUTES) {
    const names = [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    const match = new RegExp(`^${template.replace(/\{[^}]+\}/g, '([^/]+)')}$`).exec(p);
    if (match) return { method, template, params: Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(match[i + 1])])) };
  }
  return null;
}
function dateValue(text, day = false) {
  const pattern = day ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/;
  if (!pattern.test(text || '')) return NaN;
  if (!day && (Number(text.slice(11, 13)) > 23 || Number(text.slice(14, 16)) > 59 || Number(text.slice(17, 19)) > 59)) return NaN;
  const normalized = day ? `${text}T00:00:00Z` : /(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? text : `${text}Z`;
  const ms = Date.parse(normalized);
  // Date.parse нормализует 2026-02-30: явно отклоняем невозможные даты.
  const calendar = text.slice(0, 10);
  const dayMs = Date.parse(`${calendar}T00:00:00Z`);
  if (!Number.isFinite(dayMs) || new Date(dayMs).toISOString().slice(0, 10) !== calendar) return NaN;
  return ms;
}
function validFixture(snapshot) {
  const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const string = (v) => typeof v === 'string' && v.length > 0;
  if (!object(snapshot) || !['organizations', 'cashboxes', 'documents'].every((k) => Array.isArray(snapshot[k]))) return false;
  if (snapshot.clockOffsetMs !== undefined && !Number.isFinite(snapshot.clockOffsetMs)) return false;
  if (!snapshot.organizations.every((o) => object(o) && string(o.id) && typeof o.accessible === 'boolean')) return false;
  if (!snapshot.cashboxes.every((c) => object(c) && string(c.organizationId) && string(c.regNumber) && typeof c.accessible === 'boolean')) return false;
  return snapshot.documents.every((d) => object(d) && string(d.id) && string(d.organizationId)
    && string(d.kktRegId) && DOCUMENT_TYPES.includes(d.type) && Number.isFinite(dateValue(d.date))
    && Number.isSafeInteger(d.fiscalDocumentNumber) && d.fiscalDocumentNumber > 0 && string(d.fiscalSign)
    && ['totalSum', 'cashSum', 'electronicSum'].every((k) => d[k] === undefined || (Number.isSafeInteger(d[k]) && d[k] >= 0))
    && (d.items === undefined || (Array.isArray(d.items) && d.items.every((item) => object(item)
      && typeof item.name === 'string' && Number.isSafeInteger(item.price) && item.price >= 0
      && Number.isSafeInteger(item.sum) && item.sum >= 0 && Number.isFinite(item.quantity) && item.quantity > 0))));
}
function integerQuery(q, name, fallback, min, max) {
  if (!q.has(name)) return fallback;
  const text = q.get(name);
  if (!/^\d+$/.test(text)) return NaN;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : NaN;
}
function readData(res, url, matched, spec) {
  const { organizationId, kktRegId, documentId } = matched.params;
  if (!organizationId) return core.sendJson(res, state.organizations.filter((o) => o.accessible).map(publicObject));
  const org = state.organizations.find((o) => o.id === organizationId);
  if (!org) return error(res, 404, 'Организация не найдена');
  if (!org.accessible) return error(res, 403, 'Нет прав на организацию');
  const boxes = state.cashboxes.filter((c) => c.organizationId === organizationId);
  if (!kktRegId) return core.sendJson(res, boxes.filter((c) => c.accessible).map(publicObject));
  const box = boxes.find((c) => c.regNumber === kktRegId);
  if (!box) return error(res, 404, 'Касса не найдена');
  if (!box.accessible) return error(res, 403, 'Нет прав на кассу');
  const all = state.documents.filter((d) => d.organizationId === organizationId && d.kktRegId === kktRegId);
  if (documentId) {
    const doc = all.find((d) => d.id === documentId);
    return doc ? core.sendJson(res, publicObject(doc)) : error(res, 404, 'Документ не найден');
  }
  const q = url.searchParams;
  if (q.has('currentOffset')) return error(res, 400, '[FORK] Используйте offset, не currentOffset', 400, { field: 'currentOffset' });
  const types = q.has('types') ? q.get('types').split(',') : DOCUMENT_TYPES;
  if (types.some((t) => !DOCUMENT_TYPES.includes(t))) return error(res, 400, 'Неизвестный types', 400, { field: 'types' });
  const period = matched.template.endsWith('/by-period');
  const from = dateValue(q.get(period ? 'dateFrom' : 'date'), !period);
  const to = period ? dateValue(q.get('dateTo')) : from + 86400000 - 1;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return error(res, 400, 'Некорректная дата/период');
  const offset = period ? integerQuery(q, 'offset', 0, 0, Number.MAX_SAFE_INTEGER) : 0;
  const limit = period ? integerQuery(q, 'limit', PAGE_LIMIT_MAX, 1, PAGE_LIMIT_MAX) : Infinity;
  if (!Number.isFinite(offset) || (period && !Number.isFinite(limit))) return error(res, 400, 'offset ≥ 0, limit = 1..1000');
  const selected = all.filter((d) => types.includes(d.type) && Date.parse(d.date) >= from && Date.parse(d.date) <= to)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id));
  // [FORK] Повтор строки ДО пагинации: тот же ФД/ФП, лимит страницы сохраняется.
  if (spec.has('duplicate') && selected.length) selected.push({ ...selected[0] });
  const docs = selected.slice(offset, offset + limit).map(publicObject);
  return core.sendJson(res, period ? { documents: docs, paging: {
    nextOffset: offset + limit < selected.length ? offset + limit : null,
  } } : docs);
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
      creds: freshCredentials(), profile: 'kontur-ofd', ip: req.socket.remoteAddress });
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
    const raw = await core.readBody(req, 1024 * 1024);
    let body = {};
    if (raw && p !== '/auth/authenticate-by-pass') {
      try { body = JSON.parse(raw); } catch { return error(res, 400, 'Некорректный JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return error(res, 400, 'Ожидается JSON-объект');
    }
    if (p === '/health') return core.sendJson(res, { ok: true, service: 'kontur-ofd-mock', tenancy: TENANCY });
    if (p === '/openapi.json') return core.sendJson(res, JSON.parse(fs.readFileSync(path.join(__dirname,
      '../../docs/openapi/kontur-ofd-mock.openapi.json'), 'utf8')));
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
        // Sid — секрет: экспорт его не раскрывает. После restore нужен новый auth.
        snapshot.state.sessions = {};
        return core.sendJson(res, snapshot);
      }
      try {
        const snapshot = body.state || body;
        if (!validFixture(snapshot)) return error(res, 400, 'Недопустимый fixture: organizations[], cashboxes[], documents[]; суммы целыми копейками');
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
        organizations: state.organizations.map(publicObject), cashboxes: state.cashboxes.map(publicObject),
        documents: state.documents.map(publicObject), scenarios: scenarios.listRules(), requests: journal.list().length };
      return core.send(res, 200, `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Контур.ОФД</title><h1>Контур.ОФД — read/reconciliation</h1><p>Read-only консоль. Создание чека и callback не моделируются.</p><pre>${core.escapeHtml(JSON.stringify(view, null, 2))}</pre></html>`,
        { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    }
    // Не журналируем plaintext password, Sid, API key, login query и raw headers.
    const started = Date.now();
    res.once('finish', () => journal.record({ method: req.method, path: matched.template,
      status: res.statusCode, ms: Date.now() - started }));
    if (p.startsWith('/v2/') && !authenticateData(req, res)) return;
    const spec = scenarios.resolve({ header: req.headers['x-mock-scenario'] || '',
      target: p === '/auth/authenticate-by-pass' ? 'auth' : 'read', context: matched.params });
    const chaos = await core.applyRequestChaos(req, spec);
    sandboxRuntime.current(); // Проверка аренды после await, без fallback в default.
    if (chaos.abortStatus) return error(res, chaos.abortStatus, chaos.abortMessage);
    if (spec.has('hang')) return new Promise((resolve) => res.once('close', resolve));
    if (spec.has('fail')) return error(res, 500, 'Смоделированная ошибка');
    if (p === '/auth/authenticate-by-pass') {
      const creds = credentials();
      if (!creds.login || !creds.password) return error(res, 401, 'Задайте MOCK_KONTUR_OFD_LOGIN/PASSWORD', 401002);
      if (!equal(url.searchParams.get('login'), creds.login) || !equal(raw, creds.password)) return error(res, 401, 'Неверные реквизиты', 401002);
      const now = clock.now();
      for (const [sid, session] of Object.entries(state.sessions)) if (session.expiresAt <= now) delete state.sessions[sid];
      const quota = sandboxRuntime.checkDocuments();
      if (!quota.ok) return error(res, 429, 'Лимит сессий песочницы');
      const Sid = crypto.randomBytes(24).toString('hex');
      state.sessions[Sid] = { expiresAt: now + SID_TTL_SECS * 1000 };
      persist();
      return core.sendJson(res, { Sid });
    }
    return readData(res, url, matched, spec);
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
  const shutdown = () => {
    sandboxRuntime.flush(); // Сохранить отложенные namespace/owned записи до SIGTERM.
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.listen(PORT, env.MOCK_HOST || '0.0.0.0', () => {
    console.log(`kontur-ofd-mock listening on :${server.address().port}; credentials only via env/owned sandbox (hidden)`);
  });
}
module.exports = { server, state, sandboxRuntime, clock, ROUTES, MOCK_ROUTES, DOCUMENT_TYPES, SID_TTL_DEFAULT_SECS, PAGE_LIMIT_MAX };
