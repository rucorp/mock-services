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
      Object.assign(state, JSON.parse(fs.readFileSync(stateFile, 'utf8')));
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

/* -------------------------------------------------------- delivery queue */

/**
 * Очередь исходящих вебхуков с ретраями. Провайдеры шлют уведомления
 * повторно, пока мерчант не подтвердит получение (или до лимита попыток) —
 * это поведение воспроизводится здесь, а не в адаптерах.
 *
 *   entries         — map в состоянии сервиса (переживает рестарт с MOCK_STATE_FILE)
 *   retryMs         — пауза между попытками
 *   maxAttempts     — предел попыток (после него запись уходит onFailure с attempts >= max)
 *   request(entry)  — {url, data} для отправки (data — строка)
 *   isOk(res)       — критерий доставки (у Т-Банка: 200 + тело «OK»)
 *   prepare(entry)  — вызывается перед первой отправкой записи
 *   onSuccess/onFailure(entry, res|error, id) — реакция адаптера
 *   due(entry)      — готова ли к отправке (по умолчанию nextAttemptAt <= now)
 *   awaitSequential — отправлять по одной и ждать (tbank) или пачкой (kassa)
 *   unref           — не держать процесс из-за таймера
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
  onSuccess = (entry) => { entry.nextAttemptAt = Infinity; },
  onFailure = (entry, status, body) => { entry.attempts += 1; entry.lastStatus = status; entry.lastBody = body; entry.nextAttemptAt = Date.now() + retryMs; },
  due = (entry) => Date.now() >= entry.nextAttemptAt && entry.attempts < maxAttempts,
  awaitSequential = false,
  unref = false,
}) {
  async function deliverOne(id, entry) {
    const { url, data } = request(entry);
    let res = null;
    try {
      res = await postJson(url, data);
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
    }
    persist();
  }

  async function tick() {
    const now = Date.now();
    const ids = Object.keys(entries);
    for (const id of ids) {
      const entry = entries[id];
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
  postJson,
  createDeliveryQueue,
  createErrorCatalog,
};
