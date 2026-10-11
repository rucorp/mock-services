// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
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
const https = require('https');
const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------- env flags */

const FLAG_TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FLAG_FALSY = new Set(['0', 'false', 'no', 'off']);

/**
 * Разбор boolean-настроек из env (F-08): принимает и `1`, и `true` (а также
 * yes/on и их отрицания), при пустом значении возвращает fallback. Раньше
 * `MOCK_BLOCK_PRIVATE_WEBHOOKS=1` молча не включал защиту — сравнение шло
 * только с 'true'.
 */
function flagEnabled(value, fallback = false) {
  const raw = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (!raw) return Boolean(fallback);
  if (FLAG_TRUTHY.has(raw)) return true;
  if (FLAG_FALSY.has(raw)) return false;
  return Boolean(fallback);
}

/* ------------------------------------------------------------------ store */

const isPlainObject = (v) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const DANGEROUS_STATE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Снимок состояния — только JSON-дерево с безопасными словарями. Любой объект
 * копируется в словарь без прототипа, а ключи, способные менять цепочку
 * прототипов, отклоняются до того, как снимок попадёт в live state.
 */
function safeStateSnapshot(value, label = 'state', requireObjectRoot = true) {
  if (requireObjectRoot && !isPlainObject(value)) {
    throw new Error(`${label}: ожидается JSON-объект состояния`);
  }

  const active = new WeakSet();
  const stack = [];
  let root;

  function allocate(node, nodePath, assign) {
    if (node === null || typeof node === 'string' || typeof node === 'boolean'
        || (typeof node === 'number' && Number.isFinite(node))) {
      assign(node);
      return;
    }
    if (Array.isArray(node)) {
      const copy = new Array(node.length);
      assign(copy);
      stack.push({ source: node, target: copy, path: nodePath, array: true });
      return;
    }
    if (isPlainObject(node)) {
      const copy = Object.create(null);
      assign(copy);
      stack.push({ source: node, target: copy, path: nodePath, array: false });
      return;
    }
    throw new Error(`${label}: недопустимое значение по пути ${nodePath} (ожидался JSON)`);
  }

  allocate(value, label, (copy) => { root = copy; });
  while (stack.length) {
    const item = stack.pop();
    if (item.exit) {
      active.delete(item.source);
      continue;
    }
    const { source, target, path: nodePath, array } = item;
    if (active.has(source)) throw new Error(`${label}: циклическая ссылка по пути ${nodePath}`);
    active.add(source);
    stack.push({ source, exit: true });

    if (array) {
      const keys = Object.keys(source);
      if (keys.length !== source.length || keys.some((key, index) => key !== String(index))) {
        throw new Error(`${label}: недопустимый массив по пути ${nodePath}`);
      }
      for (let index = 0; index < source.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          throw new Error(`${label}: недопустимое значение по пути ${nodePath}[${index}]`);
        }
        allocate(descriptor.value, `${nodePath}[${index}]`, (copy) => { target[index] = copy; });
      }
      continue;
    }

    for (const key of Object.keys(source)) {
      const keyPath = `${nodePath}.${JSON.stringify(key)}`;
      if (DANGEROUS_STATE_KEYS.has(key)) {
        throw new Error(`${label}: запрещён опасный ключ ${JSON.stringify(key)} по пути ${keyPath}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new Error(`${label}: недопустимое значение по пути ${keyPath}`);
      }
      allocate(descriptor.value, keyPath, (copy) => {
        Object.defineProperty(target, key, {
          value: copy,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      });
    }
  }
  return root;
}

/**
 * Слияние восстановленного состояния «на месте»: объекты, на которые уже
 * ссылаются подсистемы (очередь вебхуков держит `state.notifications`,
 * админка — `state.receipts`), должны сохранить идентичность. Перед слиянием
 * снимок целиком проверяется, а изменяемые state-объекты получают null-proto.
 */
function mergeValidatedInto(target, source) {
  if (Object.getPrototypeOf(target) !== null) Object.setPrototypeOf(target, null);
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) delete target[key];
  }
  for (const [key, value] of Object.entries(source)) {
    if (Object.prototype.hasOwnProperty.call(target, key)
        && isPlainObject(target[key]) && isPlainObject(value)) {
      mergeValidatedInto(target[key], value);
    } else {
      Object.defineProperty(target, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return target;
}

function mergeInto(target, source) {
  const safeSource = safeStateSnapshot(source);
  return mergeValidatedInto(target, safeSource);
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
      const snapshot = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      mergeInto(state, snapshot);
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
    const byteLimit = Number.isFinite(Number(maxBytes)) ? Math.max(0, Math.floor(Number(maxBytes))) : 5 * 1024 * 1024;
    let chunks = [];
    let storedBytes = 0;
    let tooLarge = false;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', (chunk) => {
      // После отказа продолжаем читать/дренировать поток, но больше ничего не
      // копируем и не накапливаем — клиент может продолжать отправку тела.
      if (tooLarge || settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const chunkBytes = Buffer.byteLength(buffer);
      if (storedBytes + chunkBytes > byteLimit) {
        tooLarge = true;
        chunks = [];
        storedBytes = 0;
        const error = new Error(`Размер тела запроса превышает лимит ${byteLimit} байт`);
        error.code = 'BODY_TOO_LARGE';
        error.statusCode = 413;
        error.maxBytes = byteLimit;
        fail(error);
        return;
      }
      chunks.push(buffer);
      storedBytes += chunkBytes;
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, storedBytes).toString('utf8'));
      chunks = [];
    });
    req.on('aborted', () => fail(new Error('request aborted')));
    req.on('error', fail);
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
 * Генерация готовой команды curl для воспроизведения запроса из журнала (/admin).
 */
const SENSITIVE_QUERY_KEYS = new Set([
  'token', 'admintoken', 'operatortoken', 'accesstoken', 'refreshtoken',
  'password', 'passwd', 'secret', 'clientsecret', 'apikey', 'authorization', 'signature', 'sig',
]);

function redactQuerySecrets(value) {
  const raw = String(value || '');
  const queryIndex = raw.indexOf('?');
  if (queryIndex < 0) return raw;
  const hashIndex = raw.indexOf('#', queryIndex);
  const queryEnd = hashIndex < 0 ? raw.length : hashIndex;
  const query = raw.slice(queryIndex + 1, queryEnd);
  const params = new URLSearchParams(query);
  let changed = false;
  for (const key of new Set(params.keys())) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
    const tokenKey = normalized.endsWith('token');
    const sensitive = SENSITIVE_QUERY_KEYS.has(normalized) || tokenKey
      || normalized.endsWith('password') || normalized.endsWith('secret') || normalized.endsWith('apikey');
    if (sensitive) {
      params.set(key, tokenKey ? 'YOUR_TOKEN' : 'REDACTED');
      changed = true;
    }
  }
  if (!changed) return raw;
  return `${raw.slice(0, queryIndex + 1)}${params.toString()}${raw.slice(queryEnd)}`;
}

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

/**
 * Генерация готовой команды curl для воспроизведения запроса из журнала (/admin).
 * Все динамические части заключаются в shell single quotes; секреты query
 * заменяются на безопасные placeholder-ы до формирования команды.
 */
function buildCurlCommand({ baseUrl = 'http://localhost:3100', method = 'POST', path: reqPath = '/', headers = {}, rawBody = '', body = null }) {
  const fullUrl = redactQuerySecrets(`${String(baseUrl).replace(/\/$/, '')}${reqPath}`);
  const parts = [`curl -sS -X ${shellQuote(method)} ${shellQuote(fullUrl)}`];
  parts.push(`-H ${shellQuote('Content-Type: application/json')}`);
  const allowedHeaders = new Map([
    ['x-mock-scenario', 'X-Mock-Scenario'],
    ['x-mock-sandbox', 'X-Mock-Sandbox'],
    ['x-mock-latency', 'X-Mock-Latency'],
  ]);
  for (const [key, value] of Object.entries(headers || {})) {
    const canonical = allowedHeaders.get(key.toLowerCase());
    if (!canonical || value === undefined || value === null || value === '') continue;
    parts.push(`-H ${shellQuote(`${canonical}: ${String(value)}`)}`);
  }
  const payloadStr = rawBody
    ? String(rawBody)
    : (body && Object.keys(body).length ? JSON.stringify(body) : '');
  if (payloadStr) parts.push(`-d ${shellQuote(payloadStr)}`);
  return parts.join(' ');
}

/**
 * Журнал входящих запросов (спека §2: «журнал запросов»): последние N
 * обращений к API с методом, путём, ключевыми полями, кодом ответа,
 * длительностью и готовой командой curl для воспроизведения.
 */
function createJournal({ size = 200, baseUrl = '' } = {}) {
  const entries = [];
  function record(entry) {
    const requestPath = entry.path || '/';
    const curl = entry.curl || buildCurlCommand({
      baseUrl: entry.baseUrl || baseUrl || 'http://localhost:3100',
      method: entry.method || 'POST',
      path: requestPath,
      headers: entry.headers || {},
      rawBody: entry.rawBody || '',
      body: entry.body || null,
    });
    const safeEntry = { ...entry, path: redactQuerySecrets(requestPath) };
    if (safeEntry.baseUrl) safeEntry.baseUrl = redactQuerySecrets(safeEntry.baseUrl);
    entries.push({ at: new Date().toISOString(), ...safeEntry, curl });
    if (entries.length > size) entries.splice(0, entries.length - size);
  }
  return { record, list: () => entries.slice(), clear: () => { entries.length = 0; } };
}

/**
 * POST JSON наружу (вебхук); http/https выбирается по схеме URL.
 * Редиректы не отслеживаются (Node-клиент их не выполняет) — для SSRF-политики
 * это безопасное поведение по умолчанию; схема кроме http/https отклоняется.
 */
const DEFAULT_WEBHOOK_RESPONSE_MAX_BYTES = 64 * 1024;
const DEFAULT_WEBHOOK_DEADLINE_MS = 10000;
const WEBHOOK_LAST_BODY_MAX_CHARS = 1024;

function postJson(url, payload, timeoutMs = DEFAULT_WEBHOOK_DEADLINE_MS, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      reject(new Error(`Исходящий запрос на «${url}» отклонён: схема ${target.protocol} не поддерживается (разрешены http/https)`));
      return;
    }
    const settings = options && typeof options === 'object' ? options : {};
    const maxResponseBytes = Number.isFinite(Number(settings.maxResponseBytes))
      ? Math.max(0, Math.floor(Number(settings.maxResponseBytes)))
      : DEFAULT_WEBHOOK_RESPONSE_MAX_BYTES;
    const deadlineMs = Number.isFinite(Number(settings.deadlineMs))
      ? Math.max(0, Math.floor(Number(settings.deadlineMs)))
      : (Number.isFinite(Number(timeoutMs)) ? Math.max(0, Math.floor(Number(timeoutMs))) : DEFAULT_WEBHOOK_DEADLINE_MS);
    const inactivityTimeoutMs = Number.isFinite(Number(timeoutMs))
      ? Math.max(0, Math.floor(Number(timeoutMs)))
      : DEFAULT_WEBHOOK_DEADLINE_MS;
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const transport = target.protocol === 'https:' ? https : http;
    let settled = false;
    let deadlineTimer;
    let response;
    let responseBytes = 0;
    const chunks = [];

    const clearDeadline = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = null;
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      reject(error);
    };
    const abort = (error) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      if (response && !response.destroyed) response.destroy();
      if (req && !req.destroyed) req.destroy(error);
      reject(error);
    };

    let req;
    req = transport.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: inactivityTimeoutMs,
    }, (res) => {
      response = res;
      res.on('data', (chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const chunkBytes = Buffer.byteLength(buffer);
        if (responseBytes + chunkBytes > maxResponseBytes) {
          const error = new Error(`webhook response exceeds ${maxResponseBytes} byte limit`);
          error.code = 'WEBHOOK_RESPONSE_TOO_LARGE';
          error.maxBytes = maxResponseBytes;
          abort(error);
          return;
        }
        responseBytes += chunkBytes;
        chunks.push(buffer);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearDeadline();
        resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks, responseBytes).toString('utf8') });
      });
      res.on('aborted', () => {
        const error = new Error('webhook response aborted before completion');
        error.code = 'WEBHOOK_RESPONSE_ABORTED';
        fail(error);
      });
      res.on('error', fail);
      res.on('close', () => {
        if (!settled && !res.complete) {
          const error = new Error('webhook response closed before completion');
          error.code = 'WEBHOOK_RESPONSE_ABORTED';
          fail(error);
        }
      });

      const declaredLength = Number(res.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        const error = new Error(`webhook response exceeds ${maxResponseBytes} byte limit`);
        error.code = 'WEBHOOK_RESPONSE_TOO_LARGE';
        error.maxBytes = maxResponseBytes;
        abort(error);
      }
    });
    req.on('timeout', () => {
      const error = new Error(`webhook socket inactive for ${inactivityTimeoutMs}ms`);
      error.code = 'WEBHOOK_SOCKET_TIMEOUT';
      abort(error);
    });
    req.on('error', fail);
    deadlineTimer = setTimeout(() => {
      const error = new Error(`webhook deadline exceeded after ${deadlineMs}ms`);
      error.code = 'WEBHOOK_DEADLINE_EXCEEDED';
      abort(error);
    }, deadlineMs);
    if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
    req.write(data);
    req.end();
  });
}

/* --------------------------------------------------- webhook host guard */

const PRIVATE_NAME_RE = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i;

/**
 * Классификация IP-литерала: true — приватный/служебный, false — публичный,
 * null — это не IP-литерал (имя хоста).
 */
function isPrivateAddress(ip) {
  let addr = String(ip === undefined || ip === null ? '' : ip).trim().toLowerCase();
  if (!addr) return true;
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  if (addr.includes('%')) addr = addr.split('%')[0]; // zone id: fe80::1%eth0
  if (addr.startsWith('::ffff:')) addr = addr.slice(7); // IPv4-mapped IPv6

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return true; // битый литерал — не рисковать
    if (a === 0 || a === 10 || a === 127) return true;                       // this-net, private, loopback
    if (a === 100 && b >= 64 && b <= 127) return true;                       // CGNAT 100.64/10
    if (a === 169 && b === 254) return true;                                 // link-local (169.254.169.254 — метаданные облака)
    if (a === 172 && b >= 16 && b <= 31) return true;                        // private 172.16/12
    if (a === 192 && b === 168) return true;                                 // private
    if (a === 192 && b === 0 && c === 0) return true;                        // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true;                    // benchmarking 198.18/15
    if (a >= 224) return true;                                               // multicast, reserved, broadcast
    return false;
  }

  if (/^[0-9a-f:]+$/.test(addr)) {
    if (addr === '::' || addr === '::1') return true;                        // unspecified, loopback
    if (/^f[cd][0-9a-f]{0,2}:/.test(addr)) return true;                      // unique local fc00::/7
    if (/^fe[89ab][0-9a-f]{0,2}:/.test(addr)) return true;                   // link-local fe80::/10
    return false;
  }
  return null;
}

/**
 * Грубая защита исходящих вебхуков от SSRF (дефект A-18 аудита, политика F-08):
 * на публичном стенде интегратор задаёт NotificationURL/callback_url сам, и
 * стенд становится прокси внутрь чужой сети (метаданные облака, внутренние
 * API, Redis и т.п.).
 *
 * Для локальной разработки приватные адреса — норма (стенд и приложение на
 * одной машине), поэтому защита включается явно: MOCK_BLOCK_PRIVATE_WEBHOOKS=1
 * (или MOCK_HOSTED=1 — тогда по умолчанию). Полную защиту даёт egress-фильтр.
 */
function isPrivateHost(url) {
  try {
    const target = new URL(String(url));
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return true;
    const host = target.hostname;
    if (!host) return true;
    if (isPrivateAddress(host) === true) return true;
    return PRIVATE_NAME_RE.test(host);
  } catch {
    return true; // нераспарсенный URL — отправлять некуда
  }
}

/**
 * Усиленная проверка адреса перед исходящим запросом (F-08):
 *   1) схема — только http/https;
 *   2) литеральный приватный/служебный адрес запрещён;
 *   3) имя хоста резолвится в приватный адрес (внутренние имена, DNS-rebinding).
 *
 * Бросает Error с `code = 'SSRF_BLOCKED'` — адаптеры превращают его в DX-ответ.
 * `lookup` инжектируется для тестов.
 */
async function assertPublicHost(url, { lookup = dns.promises.lookup } = {}) {
  const blocked = (reason) => {
    const e = new Error(`Исходящий запрос на «${url}» заблокирован политикой SSRF: ${reason}. Приватные адреса запрещены (MOCK_BLOCK_PRIVATE_WEBHOOKS).`);
    e.code = 'SSRF_BLOCKED';
    return e;
  };
  let target;
  try {
    target = new URL(String(url));
  } catch {
    throw blocked('некорректный URL');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw blocked(`схема ${target.protocol} не поддерживается`);
  }
  if (isPrivateHost(url)) throw blocked('приватный или локальный адрес');

  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateAddress(host) === false) return true; // публичный IP-литерал — резолвить нечего

  let resolved;
  try {
    resolved = await lookup(host, { all: true });
  } catch (e) {
    throw blocked(`имя хоста не разрешается (${e && e.code ? e.code : 'DNS error'})`);
  }
  const list = Array.isArray(resolved) ? resolved : [resolved];
  if (!list.length) throw blocked('имя хоста не разрешается');
  for (const item of list) {
    const address = item && item.address;
    if (isPrivateAddress(address) === true) throw blocked(`имя ${host} разрешается в приватный адрес ${address}`);
  }
  return true;
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
 *   blockPrivateHosts — не отправлять на приватные адреса и хосты, которые в
 *                       них резолвятся (SSRF-guard, assertPublicHost)
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
function webhookDiagnosticBody(value) {
  const text = String(value ?? '');
  if (text.length <= WEBHOOK_LAST_BODY_MAX_CHARS) return text;
  const suffix = '… [truncated]';
  return `${text.slice(0, WEBHOOK_LAST_BODY_MAX_CHARS - suffix.length)}${suffix}`;
}

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
  onFailure,
  due,
  awaitSequential = false,
  unref = false,
  blockPrivateHosts = false,
  now = () => Date.now(),
}) {
  const isDue = due || ((entry) => !entry.done && now() >= (entry.nextAttemptAt || 0) && entry.attempts < maxAttempts);
  const onFail = onFailure || ((entry, status, body) => {
    entry.attempts += 1;
    entry.lastStatus = status;
    entry.lastBody = body;
    entry.nextAttemptAt = now() + retryMs;
  });
  // «В полёте» — рантайм-состояние, намеренно НЕ в state: после рестарта
  // процесса ничего не должно считаться отправленным «прямо сейчас».
  const inFlight = new Set();

  async function deliverOne(id, entry) {
    if (inFlight.has(id)) return;
    inFlight.add(id);
    try {
      const { url, data } = request(entry);
      if (blockPrivateHosts) await assertPublicHost(url);
      const res = await postJson(url, data);
      const diagnosticBody = webhookDiagnosticBody(res.body);
      entry.lastStatus = res.statusCode;
      entry.lastBody = diagnosticBody;
      if (isOk(res)) {
        onSuccess(entry, res, id);
        log(`webhook ${id} delivered -> ${url} (${entry.attempts} attempt(s))`);
      } else {
        onFail(entry, res.statusCode, diagnosticBody, id);
        log(`webhook ${id} failed status=${res.statusCode}, retry in ${retryMs}ms`);
      }
    } catch (e) {
      const diagnostic = webhookDiagnosticBody(e.message);
      const status = webhookDiagnosticBody(`ERR ${e.code ? `${e.code}: ` : ''}${e.message}`);
      onFail(entry, status, diagnostic, id);
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
      if (!isDue(entry)) continue;
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

/* ---------------------------------------------------------- virtual clock */

const DURATION_UNITS = {
  ms: 1,
  s: 1000,
  sec: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  h: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

/**
 * Разбор длительности в миллисекунды:
 *   parseDuration(5000)      -> 5000
 *   parseDuration("7d")      -> 604800000
 *   parseDuration("+36h")    -> 129600000
 *   parseDuration("1d 12h")  -> 129600000
 *   parseDuration("bad")     -> null
 */
function parseDuration(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number' && Number.isFinite(input)) return Math.round(input);
  const raw = String(input).trim();
  if (!raw) return null;
  if (/^[+-]?\d+$/.test(raw)) return parseInt(raw, 10);
  const sign = raw.startsWith('-') ? -1 : 1;
  const cleaned = raw.replace(/^[+-]/, '').trim();
  const tokenRe = /(\d+(?:\.\d+)?)\s*(ms|sec|s|min|m|hr|h|days|day|d)\b/gi;
  let total = 0;
  let matched = 0;
  let m;
  while ((m = tokenRe.exec(cleaned)) !== null) {
    const val = parseFloat(m[1]);
    const unit = DURATION_UNITS[m[2].toLowerCase()];
    if (!Number.isFinite(val) || !unit) return null;
    total += val * unit;
    matched += m[0].length;
  }
  const compactRest = cleaned.replace(tokenRe, '').trim();
  if (!matched || compactRest.length > 0) return null;
  return Math.round(sign * total);
}

/**
 * Виртуальные часы (этап 7 роадмапа, бриф §3.2):
 * позволяют мгновенно сдвигать время стенда на «+7d» / «+60d» / «+36h» без
 * ожидания реальных суток. Инициализируются из MOCK_VIRTUAL_CLOCK (смещение
 * вида "+7d", миллисекунды или ISO-дата) и могут храниться в state-файле.
 */
function createVirtualClock({ initial = process.env.MOCK_VIRTUAL_CLOCK || '', getStateOffset, setStateOffset } = {}) {
  let localOffsetMs = 0;
  if (initial && String(initial).trim() !== '0' && String(initial).toLowerCase() !== 'false' && String(initial).toLowerCase() !== 'true') {
    const dur = parseDuration(initial);
    if (dur !== null) {
      localOffsetMs = dur;
    } else {
      const parsedDate = Date.parse(String(initial));
      if (Number.isFinite(parsedDate)) localOffsetMs = parsedDate - Date.now();
    }
  }

  const readOffset = () => {
    if (typeof getStateOffset === 'function') {
      const v = getStateOffset();
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return localOffsetMs;
  };

  const writeOffset = (next) => {
    const normalized = Math.round(Number(next) || 0);
    localOffsetMs = normalized;
    if (typeof setStateOffset === 'function') setStateOffset(normalized);
    return normalized;
  };

  if (localOffsetMs !== 0) writeOffset(localOffsetMs);

  function now() {
    return Date.now() + readOffset();
  }

  function iso(ts = now()) {
    return new Date(ts).toISOString();
  }

  function snapshot() {
    const currentOffset = readOffset();
    const currentNow = Date.now() + currentOffset;
    return {
      now: currentNow,
      iso: new Date(currentNow).toISOString(),
      offsetMs: currentOffset,
      virtual: currentOffset !== 0 || Boolean(initial),
    };
  }

  function advance(delta) {
    const ms = parseDuration(delta);
    if (ms === null) throw new Error(`Некорректный формат сдвига времени: ${JSON.stringify(delta)} (ожидается, например, "7d", "60d", "36h", "30m" или число мс)`);
    writeOffset(readOffset() + ms);
    return snapshot();
  }

  function reset() {
    writeOffset(0);
    return snapshot();
  }

  function set(spec = {}) {
    if (spec.reset) return reset();
    if (spec.advance !== undefined && spec.advance !== null && spec.advance !== '') {
      return advance(spec.advance);
    }
    if (spec.offset !== undefined && spec.offset !== null && spec.offset !== '') {
      const ms = parseDuration(spec.offset);
      if (ms === null) throw new Error(`Некорректный формат offset: ${JSON.stringify(spec.offset)}`);
      writeOffset(ms);
      return snapshot();
    }
    if (spec.offsetMs !== undefined && spec.offsetMs !== null && spec.offsetMs !== '') {
      const ms = Number(spec.offsetMs);
      if (!Number.isFinite(ms)) throw new Error(`Некорректный offsetMs: ${JSON.stringify(spec.offsetMs)}`);
      writeOffset(ms);
      return snapshot();
    }
    if (spec.iso || spec.time) {
      const ts = Date.parse(String(spec.iso || spec.time));
      if (!Number.isFinite(ts)) throw new Error(`Некорректная ISO-дата: ${JSON.stringify(spec.iso || spec.time)}`);
      writeOffset(ts - Date.now());
      return snapshot();
    }
    return snapshot();
  }

  return { now, iso, advance, set, reset, snapshot, parseDuration };
}

/* ----------------------------------------------------- scenario registry */

/**
 * Разбор строки сценариев из заголовка X-Mock-Scenario или поля DATA.mock_scenario.
 * Примеры:
 *   "fail"
 *   "chargeback-after:7d, webhook-drop"
 *   "partial-refund:30000"
 */
function parseScenarioSpec(raw) {
  const str = String(raw || '').trim();
  const items = [];
  if (str) {
    for (const part of str.split(/[,;]+/)) {
      const token = part.trim();
      if (!token) continue;
      const colonIdx = token.indexOf(':');
      const eqIdx = token.indexOf('=');
      const sepIdx = colonIdx >= 0 && eqIdx >= 0 ? Math.min(colonIdx, eqIdx) : Math.max(colonIdx, eqIdx);
      if (sepIdx > 0) {
        items.push({
          name: token.slice(0, sepIdx).trim().toLowerCase(),
          arg: token.slice(sepIdx + 1).trim(),
          raw: token,
        });
      } else {
        items.push({ name: token.toLowerCase(), arg: null, raw: token });
      }
    }
  }
  const find = (name) => {
    const n = String(name || '').toLowerCase();
    return items.find((i) => i.name === n) || null;
  };
  return {
    raw: str,
    items,
    has: (name) => Boolean(find(name)),
    get: (name) => {
      const item = find(name);
      return item ? (item.arg !== null ? item.arg : true) : null;
    },
  };
}

/**
 * Единый реестр сценариев (этап 7 роадмапа, бриф §3.2):
 * объединяет сценарии из заголовка `X-Mock-Scenario`, поля запроса и
 * программируемых правил (`POST /mock/scenarios`), плюс ведёт журнал
 * срабатываний для отладки в CI.
 */
function createScenarioRegistry({ clock, size = 200 } = {}) {
  const nowIsoFn = () => (clock && typeof clock.iso === 'function' ? clock.iso() : new Date().toISOString());
  const rules = [];
  const history = [];
  let seq = 1;

  function addRule(rule = {}) {
    const scenario = String(rule.scenario || '').trim();
    if (!scenario) throw new Error('Поле scenario обязательно (например, "chargeback-after:7d", "webhook-drop", "fail")');
    const entry = {
      id: rule.id ? String(rule.id) : `sc-${seq++}`,
      target: rule.target ? String(rule.target).toLowerCase() : '*',
      match: rule.match && typeof rule.match === 'object' ? { ...rule.match } : null,
      scenario,
      times: rule.times === null || rule.times === undefined || rule.times === -1
        ? (rule.persistent ? null : 1)
        : Math.max(1, parseInt(rule.times, 10) || 1),
      createdAt: nowIsoFn(),
    };
    rules.push(entry);
    return entry;
  }

  function matchRule(target, context = {}) {
    const normTarget = String(target || '*').toLowerCase();
    for (let i = 0; i < rules.length; i += 1) {
      const r = rules[i];
      if (r.target !== '*' && r.target !== normTarget) continue;
      if (r.match) {
        let ok = true;
        for (const [k, v] of Object.entries(r.match)) {
          if (String(context[k] ?? '') !== String(v)) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
      }
      if (typeof r.times === 'number') {
        r.times -= 1;
        if (r.times <= 0) rules.splice(i, 1);
      }
      return r;
    }
    return null;
  }

  function recordTrigger(event = {}) {
    const entry = { at: nowIsoFn(), ...event };
    history.push(entry);
    if (history.length > size) history.splice(0, history.length - size);
    return entry;
  }

  function resolve({ header = '', bodyScenario = '', target = '*', context = {} } = {}) {
    const parts = [];
    let source = null;
    if (header && String(header).trim()) {
      parts.push(String(header).trim());
      source = 'header';
    }
    if (bodyScenario && String(bodyScenario).trim()) {
      parts.push(String(bodyScenario).trim());
      source = source ? `${source}+body` : 'body';
    }
    const matchedRule = matchRule(target, context);
    if (matchedRule) {
      parts.push(matchedRule.scenario);
      source = source ? `${source}+rule:${matchedRule.id}` : `rule:${matchedRule.id}`;
    }
    const spec = parseScenarioSpec(parts.join(','));
    if (spec.items.length) {
      recordTrigger({
        scenario: spec.raw,
        source,
        target,
        ...(context.orderId ? { orderId: context.orderId } : {}),
        ...(context.paymentId ? { paymentId: context.paymentId } : {}),
        ...(context.externalId ? { externalId: context.externalId } : {}),
      });
    }
    return spec;
  }

  function clearRules() {
    rules.length = 0;
  }

  function clearHistory() {
    history.length = 0;
  }

  return {
    addRule,
    matchRule,
    resolve,
    recordTrigger,
    listRules: () => rules.slice(),
    listHistory: () => history.slice(),
    clearRules,
    clearHistory,
    parseScenarioSpec,
  };
}

/**
 * Опциональная защита /admin* по токену (рекомендация аудита A-20):
 * если задан MOCK_ADMIN_TOKEN, требует заголовок Authorization: Bearer <token>,
 * X-Admin-Token: <token> или query-параметр ?admin_token=<token>.
 * По умолчанию пустой — локальный DX и существующие тесты не меняются.
 */
function checkAdminAuth(req, adminToken = process.env.MOCK_ADMIN_TOKEN || '') {
  const expected = String(adminToken || '').trim();
  if (!expected) return true;
  return tokenMatches(req, expected);
}

/** Сравнение секретов без утечки длины по таймингу (constant-time). */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** Токен из Authorization: Bearer, X-(Admin|Operator)-Token или query. */
function tokenMatches(req, expected) {
  const wanted = String(expected || '');
  if (!wanted) return false;
  const headers = (req && req.headers) || {};
  const auth = String(headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ') && safeEqual(auth.slice(7).trim(), wanted)) return true;
  if (safeEqual(String(headers['x-admin-token'] || '').trim(), wanted)) return true;
  if (safeEqual(String(headers['x-operator-token'] || '').trim(), wanted)) return true;
  try {
    const u = new URL((req && req.url) || '/', 'http://localhost');
    if (safeEqual(String(u.searchParams.get('admin_token') || ''), wanted)) return true;
    if (safeEqual(String(u.searchParams.get('operator_token') || ''), wanted)) return true;
  } catch { /* ignore */ }
  return false;
}

/**
 * Единый access-control управляющей поверхности (F-07, задача #22).
 *
 *   surface='admin'    — /admin*: токен MOCK_ADMIN_TOKEN;
 *   surface='operator' — /mock/*, смены/ФН/ОФД кассы и служебные чтения:
 *                        MOCK_OPERATOR_TOKEN, с fallback на MOCK_ADMIN_TOKEN.
 *
 * Пока токены не заданы, локальный стенд остаётся открытым (обратная
 * совместимость и DX). В hosted-режиме (MOCK_HOSTED=1) без настроенного секрета
 * управляющая поверхность закрыта — fail-closed.
 *
 * Возвращает { allowed, role, reason }: адаптер сам выбирает формат DX-ответа.
 */
function checkControlAccess(req, { adminToken = '', operatorToken = '', surface = 'operator', hosted = false } = {}) {
  const admin = String(adminToken || '').trim();
  const operator = String(operatorToken || '').trim();
  const expected = surface === 'admin' ? admin : (operator || admin);
  if (!expected) {
    return hosted
      ? { allowed: false, role: null, reason: 'hosted-fail-closed', token: null }
      : { allowed: true, role: 'open', reason: 'no-token-configured', token: null };
  }
  if (tokenMatches(req, expected)) return { allowed: true, role: surface, reason: null, token: null };
  return { allowed: false, role: null, reason: 'invalid-token', token: null };
}


/* ------------------------------------------- chaos / latency / sandboxes */

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Извлечение управляемой задержки и сетевых сбоев из заголовков/сценариев:
 *   X-Mock-Latency: 250 (или X-Mock-Scenario: latency:250ms) -> ждёт 250 мс
 *   X-Mock-Scenario: http-500 / timeout-504 -> возвращает код сбоя шлюза
 */
async function applyRequestChaos(req, scenarioSpec = null) {
  const spec = scenarioSpec || parseScenarioSpec(req.headers && req.headers['x-mock-scenario']);
  const headerLat = req.headers && req.headers['x-mock-latency'];
  const scLat = spec.get('latency') || spec.get('delay');
  const delayMs = parseDuration(headerLat || (scLat && scLat !== true ? scLat : null));
  if (delayMs && delayMs > 0) {
    await sleepMs(Math.min(delayMs, 30000));
  }
  if (spec.has('http-500') || spec.has('gateway-500')) {
    return { abortStatus: 500, abortMessage: 'Simulated gateway 500 error (X-Mock-Scenario: http-500)' };
  }
  if (spec.has('http-504') || spec.has('gateway-timeout')) {
    return { abortStatus: 504, abortMessage: 'Simulated gateway 504 timeout (X-Mock-Scenario: http-504)' };
  }
  return { abortStatus: null, delayMs: delayMs || 0 };
}

/**
 * Управление состоянием и изолированными песочницами (RFC-001):
 *   - сохраняет идентичность ссылок вложенных коллекций state (чтобы очередь
 *     вебхуков не теряла ссылку при reset/import/переключении песочницы);
 *   - поддерживает X-Mock-Sandbox (или ?sandbox=): у каждой песочницы свой
 *     изолированный срез состояния, при этом без заголовка используется
 *     дефолтная песочница ('default') — 100% обратная совместимость.
 */
function createSandboxManager({ state, persist = () => {}, initialStateFactory }) {
  const initialSnapshot = safeStateSnapshot(state, 'initial state');
  mergeValidatedInto(state, initialSnapshot);
  const sandboxes = new Map();
  let activeId = 'default';

  const clone = (obj) => safeStateSnapshot(JSON.parse(JSON.stringify(obj)), 'sandbox snapshot', false);

  function clearAndMergeInPlace(target, source) {
    // Валидация/копирование завершаются до первой модификации live state.
    const safeSource = safeStateSnapshot(source, 'state snapshot');
    mergeValidatedInto(target, safeSource);
  }

  function resolveSandboxId(req) {
    if (!req || !req.headers) return 'default';
    const hdr = String(req.headers['x-mock-sandbox'] || '').trim();
    if (hdr) return hdr.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64) || 'default';
    try {
      const u = new URL(req.url || '/', 'http://localhost');
      const q = u.searchParams.get('sandbox');
      if (q) return String(q).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64) || 'default';
    } catch { /* ignore */ }
    return 'default';
  }

  function switchTo(sandboxId = 'default') {
    const id = String(sandboxId || 'default');
    if (id === activeId) {
      if (!sandboxes.has(id)) {
        sandboxes.set(id, { id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), snapshot: clone(state) });
      }
      return id;
    }
    // Сохраняем текущую активную песочницу
    sandboxes.set(activeId, {
      id: activeId,
      createdAt: (sandboxes.get(activeId) && sandboxes.get(activeId).createdAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      snapshot: clone(state),
    });
    // Загружаем целевую или создаём чистую
    if (!sandboxes.has(id)) {
      const fresh = typeof initialStateFactory === 'function' ? initialStateFactory() : {};
      sandboxes.set(id, { id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), snapshot: clone(fresh) });
    }
    const targetSnap = sandboxes.get(id).snapshot;
    clearAndMergeInPlace(state, targetSnap);
    activeId = id;
    return activeId;
  }

  function reset(sandboxId = activeId) {
    const id = String(sandboxId || activeId || 'default');
    const fresh = typeof initialStateFactory === 'function' ? initialStateFactory() : {};
    if (id === activeId) {
      clearAndMergeInPlace(state, fresh);
      persist();
    }
    sandboxes.set(id, {
      id,
      createdAt: (sandboxes.get(id) && sandboxes.get(id).createdAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      snapshot: clone(fresh),
    });
    return { ok: true, sandbox: id };
  }

  function exportState() {
    return {
      sandbox: activeId,
      exportedAt: new Date().toISOString(),
      state: clone(state),
    };
  }

  function importState(payload = {}) {
    const nextState = payload && payload.state && isPlainObject(payload.state) ? payload.state : payload;
    if (!isPlainObject(nextState)) throw new Error('Ожидается JSON-объект состояния');
    clearAndMergeInPlace(state, nextState);
    persist();
    return { ok: true, sandbox: activeId };
  }

  function list() {
    sandboxes.set(activeId, {
      id: activeId,
      createdAt: (sandboxes.get(activeId) && sandboxes.get(activeId).createdAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      snapshot: clone(state),
    });
    return Array.from(sandboxes.values()).map((s) => ({
      id: s.id,
      active: s.id === activeId,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  }

  return {
    resolveSandboxId,
    fromRequest: (req) => switchTo(resolveSandboxId(req)),
    switchTo,
    reset,
    exportState,
    importState,
    list,
    getActiveId: () => activeId,
    current: () => activeId,
    getCurrent: () => activeId,
  };
}

/**
 * Активный экзаменатор вебхуков интегратора (спека §1.4 «Контракт-тесты как продукт»):
 * прогоняет серию проб против webhook-эндпоинта мерчанта и выдаёт отчёт о
 * готовности обработчика вебхуков к боевому контуру.
 */
async function verifyMerchantWebhook({
  url,
  provider = 'tbank-eacq',
  terminalKey = 'TBANKMOCKTEST',
  signPayload = null,
  blockPrivateHosts = false,
} = {}) {
  if (!url || typeof url !== 'string') {
    throw new Error('Передайте url вебхука мерчанта для проверки (например, {"url":"http://localhost:8000/webhook"})');
  }
  if (blockPrivateHosts) await assertPublicHost(url);

  const checks = [];
  const probeOrderId = `mock-verify-${Date.now()}`;
  const probePaymentId = String(990000000 + Math.floor(Math.random() * 9000000));

  if (provider === 'tbank-eacq' || provider === 'tbank') {
    const basePayload = {
      TerminalKey: terminalKey,
      OrderId: probeOrderId,
      Success: true,
      Status: 'AUTHORIZED',
      PaymentId: probePaymentId,
      ErrorCode: '0',
      Amount: 10000,
      Pan: '220138**0013',
      ExpDate: '1227',
    };
    const validToken = typeof signPayload === 'function' ? signPayload(basePayload) : '0'.repeat(64);
    const validEvent = { ...basePayload, Token: validToken };

    // 1. Валидная подписанная нотификация -> ожидаем 200 и тело "OK"
    try {
      const r1 = await postJson(url, validEvent, 5000);
      const isOk = r1.statusCode === 200 && String(r1.body || '').trim() === 'OK';
      checks.push({
        id: 'valid_signed_webhook',
        title: 'Приём валидной подписанной нотификации и ответ ровно "OK"',
        passed: isOk,
        statusCode: r1.statusCode,
        responseBody: String(r1.body || '').slice(0, 120),
        hint: isOk ? null : 'Обработчик нотификаций Т-Банка обязан вернуть HTTP 200 с телом ровно "OK" (без JSON-обёрток), иначе банк уйдёт в 24-часовые ретраи.',
      });
    } catch (e) {
      checks.push({
        id: 'valid_signed_webhook',
        title: 'Приём валидной подписанной нотификации и ответ ровно "OK"',
        passed: false,
        error: e.message,
        hint: 'Эндпоинт недоступен или превысил таймаут 5 с.',
      });
    }

    // 2. Дубль той же самой нотификации (проверка идемпотентности) -> ожидаем 200 "OK" без 500
    try {
      const r2 = await postJson(url, validEvent, 5000);
      const isOk = r2.statusCode === 200 && String(r2.body || '').trim() === 'OK';
      checks.push({
        id: 'duplicate_idempotency',
        title: 'Идемпотентная обработка повторной нотификации (дубль вебхука)',
        passed: isOk,
        statusCode: r2.statusCode,
        responseBody: String(r2.body || '').slice(0, 120),
        hint: isOk ? null : 'Повторная доставка уже обработанного события должна идемпотентно возвращать 200 "OK", не вызывая 500 и не дублируя проводку.',
      });
    } catch (e) {
      checks.push({
        id: 'duplicate_idempotency',
        title: 'Идемпотентная обработка повторной нотификации (дубль вебхука)',
        passed: false,
        error: e.message,
      });
    }

    // 3. Поддельная подпись Token -> мерчант ОБЯЗАН отклонить (не 200 "OK")
    try {
      const badEvent = { ...basePayload, Amount: 99999900, Token: 'f'.repeat(64) };
      const r3 = await postJson(url, badEvent, 5000);
      const rejected = r3.statusCode >= 400 || String(r3.body || '').trim() !== 'OK';
      checks.push({
        id: 'invalid_signature_rejected',
        title: 'Отклонение вебхука с поддельным Token (защита от подделки оплаты)',
        passed: rejected,
        statusCode: r3.statusCode,
        responseBody: String(r3.body || '').slice(0, 120),
        hint: rejected ? null : 'КРИТИЧНО: ваш обработчик ответил 200 "OK" на вебхук с неверным Token! Проверяйте sha256-подпись до изменения статуса заказа.',
      });
    } catch (e) {
      checks.push({
        id: 'invalid_signature_rejected',
        title: 'Отклонение вебхука с поддельным Token',
        passed: false,
        error: e.message,
      });
    }
  } else {
    // Ferma OFD callback verification
    const probeUuid = `00000000-0000-4000-8000-${String(Date.now()).slice(-12).padStart(12, '0')}`;
    const callbackPayload = {
      uuid: probeUuid,
      external_id: probeOrderId,
      group_code: 'Main',
      type: 'sell',
      status: 'done',
      ofd_status: 'sent',
      timestamp: new Date().toISOString(),
      error: null,
      payload: {
        total: 10000,
        fiscal_document_number: 59999,
        fiscal_document_attribute: '1234567890',
        fn_number: '9999078902001294',
        receipt_datetime: new Date().toISOString().slice(0, 19),
      },
    };
    try {
      const r1 = await postJson(url, callbackPayload, 5000);
      const r2 = await postJson(url, callbackPayload, 5000);
      const ok1 = r1.statusCode >= 200 && r1.statusCode < 300;
      const ok2 = r2.statusCode >= 200 && r2.statusCode < 300;
      checks.push({
        id: 'valid_fiscal_callback',
        title: 'Приём callback фискализации Ferma (HTTP 2xx)',
        passed: ok1,
        statusCode: r1.statusCode,
        responseBody: String(r1.body || '').slice(0, 120),
        hint: ok1 ? null : 'Обработчик фискального callback должен возвращать 2xx.',
      });
      checks.push({
        id: 'duplicate_fiscal_callback',
        title: 'Идемпотентный приём повторного callback того же чека',
        passed: ok2,
        statusCode: r2.statusCode,
        responseBody: String(r2.body || '').slice(0, 120),
        hint: ok2 ? null : 'Повторная доставка callback того же uuid/external_id не должна приводить к ошибке 500.',
      });
    } catch (e) {
      checks.push({
        id: 'valid_fiscal_callback',
        title: 'Приём callback фискализации Ferma',
        passed: false,
        error: e.message,
      });
    }
  }

  const passedCount = checks.filter((c) => c.passed).length;
  return {
    ok: true,
    provider,
    targetUrl: url,
    passed: passedCount,
    total: checks.length,
    readyForProd: passedCount === checks.length && checks.length > 0,
    checks,
    steps: checks,
  };
}

module.exports = {
  createStore,
  createLog,
  nowIso,
  flagEnabled,
  readBody,
  parseBody,
  send,
  sendJson,
  html,
  escapeHtml,
  isPrivateHost,
  isPrivateAddress,
  assertPublicHost,
  buildCurlCommand,
  createJournal,
  postJson,
  createDeliveryQueue,
  createErrorCatalog,
  parseDuration,
  createVirtualClock,
  parseScenarioSpec,
  createScenarioRegistry,
  checkAdminAuth,
  checkControlAccess,
  applyRequestChaos,
  createSandboxManager,
  verifyMerchantWebhook,
};
