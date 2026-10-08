'use strict';

/*
 * core — общие механизмы мок-сервисов (spec §2: «ядро»).
 *
 * Здесь нет протоколов провайдеров: подписи, машины статусов и форматы
 * полей — это адаптеры (services/*). Ядро даёт только инфраструктуру:
 *
 *   createStore()          — состояние + persist/restore (MOCK_STATE_FILE)
 *   createLog(tag)         — журналирование с таймстампом
 *   readBody/parseBody     — разбор тела запроса (json + form-urlencoded)
 *   send/sendJson/html     — ответы
 *   escapeHtml             — экранирование значений для HTML-страниц сервисов
 *   createJournal(size)    — журнал входящих запросов (последние N) для /admin
 *   postJson               — исходящий POST (http/https по схеме)
 *   createDeliveryQueue    — доставка вебхуков с ретраями (как у банков/ОФД):
 *                            очередь в состоянии сервиса, ретраи по расписанию,
 *                            лимит попыток, идемпотентный тик раз в секунду.
 *
 * Zero npm dependencies. Node >= 18.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ store */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Слияние восстановленного состояния «на месте»: объекты, на которые уже
 * ссылаются подсистемы (очередь вебхуков держит `state.notifications`,
 * админка — `state.receipts`), должны сохранить идентичность.
 *
 * Раньше использовался Object.assign: он ПОДМЕНЯЛ вложенные объекты, и после
 * рестарта с MOCK_STATE_FILE очередь продолжала смотреть в старый (пустой)
 * объект — недоставленные вебхуки молча терялись (дефект A-2 аудита).
 */
function mergeInto(target, source) {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];
  }
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(target[key]) && isPlainObject(value)) mergeInto(target[key], value);
    else target[key] = value;
  }
  return target;
}

function createStore({ stateFile = '', log = console.error } = {}) {
  const state = {};
  const persist = () => {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state));
    } catch (e) {
      log(`state persist failed: ${e.message}`);
    }
  };
  const restore = () => {
    if (!stateFile || !fs.existsSync(stateFile)) return;
    try {
      mergeInto(state, JSON.parse(fs.readFileSync(stateFile, 'utf8')));
      log(`state restored from ${stateFile}`);
    } catch (e) {
      log(`state restore failed: ${e.message}`);
    }
  };
  return { state, persist, restore };
}

/* -------------------------------------------------------------------- log */

const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function createLog(tag) {
  return (...args) => console.log(`[${tag} ${nowIso()}]`, ...args);
}

/* ------------------------------------------------------------------- http */

function readBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > maxBytes) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseBody(raw, contentType) {
  if (!raw) return {};
  if (String(contentType || '').includes('application/json')) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  const out = {};
  for (const pair of raw.split('&')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    out[decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '))] = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
  }
  return out;
}

function send(res, code, body, headers = {}) {
  const type = typeof body === 'string' && headers['Content-Type'] === undefined && !headers['content-type']
    ? { 'Content-Type': 'text/html; charset=utf-8' }
    : {};
  res.writeHead(code, { ...type, ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function sendJson(res, payload, code = 200, headers = {}) {
  send(res, code, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

function html(res, body, code = 200) {
  send(res, code, body, { 'Content-Type': 'text/html; charset=utf-8' });
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Экранирование для HTML-страниц сервисов (чек покупателю, /admin).
 * Данные приходят от интегратора (названия позиций, external_id, OrderId),
 * поэтому вставлять их в HTML «как есть» нельзя — это XSS даже на тестовом
 * стенде, а публичный стенд делает его опасным по-настоящему.
 */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/* ---------------------------------------------------------------- journal */

/**
 * Журнал входящих запросов (спека §2: «журнал запросов»): последние N
 * обращений к API с методом, путём, ключевыми полями, кодом ответа и
 * длительностью. Отдаётся в /admin/journal — интегратору видно, как мок
 * понял его запрос, без чтения логов контейнера.
 */
function createJournal({ size = 200 } = {}) {
  const entries = [];
  function record(entry) {
    entries.push({ at: new Date().toISOString(), ...entry });
    if (entries.length > size) entries.splice(0, entries.length - size);
  }
  return { record, list: () => entries.slice(), clear: () => { entries.length = 0; } };
}

/** POST JSON наружу (вебхук); http/https выбирается по схеме URL. */
function postJson(url, payload, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const transport = target.protocol === 'https:' ? require('https') : http;
    const req = transport.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/* --------------------------------------------------- webhook host guard */

const PRIVATE_HOST_RE = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;

/**
 * Грубая защита исходящих вебхуков от SSRF (дефект A-18 аудита): на публичном
 * стенде интегратор
 * задаёт NotificationURL/callback_url сам, и стенд становится прокси внутрь
 * чужой сети (метаданные облака, внутренние API, Redis и т.п.).
 *
 * Для локальной разработки приватные адреса — норма (стенд и приложение на
 * одной машине), поэтому защита включается явно: MOCK_BLOCK_PRIVATE_WEBHOOKS=1.
 * Это best-effort по имени хоста: полную защиту даёт сетевой egress-фильтр.
 */
function isPrivateHost(url) {
  try {
    const host = new URL(url).hostname;
    return PRIVATE_HOST_RE.test(host);
  } catch {
    return true; // нераспарсенный URL — отправлять некуда
  }
}

/* -------------------------------------------------------- delivery queue */

/**
 * Очередь исходящих вебхуков с ретраями. Провайдеры шлют уведомления
 * повторно, пока мерчант не подтвердит получение (или до лимита попыток) —
 * это поведение воспроизводится здесь, а не в адаптерах.
 *
 *   entries         — map в состоянии сервиса (переживает рестарт с MOCK_STATE_FILE)
 *   retryMs         — пауза между попытками
 *   maxAttempts     — предел попыток (после него запись уходит onFailure с attempts >= max)
 *   request(entry)  — {url, data} для отправки (data — строка или объект)
 *   isOk(res)       — критерий доставки (у Т-Банка: 200 + тело «OK»)
 *   prepare(entry)  — вызывается перед отправкой записи (инкремент attempts)
 *   onSuccess/onFailure(entry, res|error, id) — реакция адаптера
 *   due(entry)      — готова ли к отправке (по умолчанию: не done и nextAttemptAt <= now)
 *   awaitSequential — отправлять по одной и ждать (tbank) или пачкой (kassa)
 *   unref           — не держать процесс из-за таймера
 *   blockPrivateHosts — не отправлять на приватные адреса (SSRF-guard хоста)
 *
 * Гарантии (дефекты A-3/A-4 аудита):
 *   1. Запись, находящаяся «в полёте», не отправляется повторно: тик не ждёт
 *      медленный вебхук, и без защиты одна и та же нотификация уходила
 *      параллельно несколько раз (16 HTTP-запросов вместо 4 при таймауте).
 *   2. Доставленная запись помечается `entry.done = true` (а не Infinity,
 *      который в JSON превращался в null и после рестарта считался «пора
 *      слать снова»).
 *   3. Ошибка `request(entry)` (битый URL в состоянии) не роняет тик.
 */
function createDeliveryQueue({
  entries,
  retryMs,
  maxAttempts,
  persist = () => {},
  log = console.log,
  request,
  isOk = (res) => res.statusCode >= 200 && res.statusCode < 300,
  prepare = () => {},
  onSuccess = (entry) => { entry.done = true; entry.nextAttemptAt = null; },
  onFailure = (entry, status, body) => { entry.attempts += 1; entry.lastStatus = status; entry.lastBody = body; entry.nextAttemptAt = Date.now() + retryMs; },
  due = (entry) => !entry.done && Date.now() >= (entry.nextAttemptAt || 0) && entry.attempts < maxAttempts,
  awaitSequential = false,
  unref = false,
  blockPrivateHosts = false,
}) {
  // «В полёте» — рантайм-состояние, намеренно НЕ в state: после рестарта
  // процесса ничего не должно считаться отправленным «прямо сейчас».
  const inFlight = new Set();

  async function deliverOne(id, entry) {
    if (inFlight.has(id)) return;
    inFlight.add(id);
    try {
      const { url, data } = request(entry);
      if (blockPrivateHosts && isPrivateHost(url)) {
        throw new Error(`адрес ${url} — приватный (заблокирован MOCK_BLOCK_PRIVATE_WEBHOOKS)`);
      }
      const res = await postJson(url, data);
      entry.lastStatus = res.statusCode;
      entry.lastBody = res.body;
      if (isOk(res)) {
        onSuccess(entry, res, id);
        log(`webhook ${id} delivered -> ${url} (${entry.attempts} attempt(s))`);
      } else {
        onFailure(entry, res.statusCode, res.body, id);
        log(`webhook ${id} failed status=${res.statusCode}, retry in ${retryMs}ms`);
      }
    } catch (e) {
      onFailure(entry, `ERR ${e.message}`, e.message, id);
      log(`webhook ${id} error: ${e.message}, retry in ${retryMs}ms`);
    } finally {
      inFlight.delete(id);
      persist();
    }
  }

  async function tick() {
    const ids = Object.keys(entries);
    for (const id of ids) {
      const entry = entries[id];
      if (!entry || inFlight.has(id)) continue;
      if (!due(entry)) continue;
      prepare(entry);
      if (awaitSequential) await deliverOne(id, entry);
      else deliverOne(id, entry); // пачкой, без ожидания — как у Ferma-мока
    }
  }

  function start(intervalMs = 1000) {
    const t = setInterval(() => { tick().catch((e) => log('delivery loop:', e.message)); }, intervalMs);
    if (unref) t.unref();
    return t;
  }

  return { tick, start, deliverOne };
}


/* ---------------------------------------------------------- error catalog */

/**
 * Каталог ошибок провайдера — сердце DX-слоя (спека §6.2): ошибка — это не
 * голый код, а {код, объяснение, поле, рекомендация, ссылка на доку}.
 *
 *   const derr = createErrorCatalog({
 *     provider: 'tbank-eacq',
 *     docsBase: 'https://developer.tbank.ru/eacq',
 *     codes: { 7: { message: '...', field: 'Amount|OrderId', hint: '...', doc: '/api/init' } },
 *   });
 *   derr(7, { details: 'Amount=abc' })  // → готовая запись для ответа
 *
 * Адаптер решает, куда положить поля в СВОЁМ формате контракта (Т-Банк —
 * Details, Ferma — hint/doc внутри error), сам каталог — provider-agnostic.
 */
function createErrorCatalog({ provider, docsBase, codes = {} }) {
  return function describeError(code, overrides = {}) {
    const known = codes[code] || {};
    const docPath = overrides.doc || known.doc;
    return {
      provider,
      code,
      message: overrides.message || known.message || `Ошибка провайдера (код ${code})`,
      field: overrides.field || known.field || null,
      hint: overrides.hint || known.hint || null,
      doc: docPath ? `${String(docsBase).replace(/\/$/, '')}${docPath}` : (docsBase || null),
      ...overrides.details ? { details: overrides.details } : {},
    };
  };
}

module.exports = {
  createStore,
  createLog,
  nowIso,
  readBody,
  parseBody,
  send,
  sendJson,
  html,
  escapeHtml,
  isPrivateHost,
  createJournal,
  postJson,
  createDeliveryQueue,
  createErrorCatalog,
};
