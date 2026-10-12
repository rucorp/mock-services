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
 *   redactSecrets/redactSecretsInText/redactRawBody/summarizeBody
 *                          — редакция секретов, PAN и PII до журнала и логов
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
const { AsyncLocalStorage } = require('async_hooks');

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

/* ------------------------------------------------- redaction (F-09, F-10) */

/**
 * Редакция секретов и карточных данных до журналирования, экспорта и логов.
 *
 * Мок видит реквизиты интегратора: подпись `Token` и `Password` терминала
 * (T-Bank), `login`/`pass` Ferma (Kassa), `Authorization: Basic/Bearer`
 * (acqapi), PAN в `e2c/v2/Init` и в форме оплаты. Журнал `/admin`, снимок
 * `/mock/state`, state-файл и console — не место для секретов: стенд
 * поднимают на публичных хостах, а снимки состояния пересылают в баг-репорты.
 *
 * Порядок правил (важен):
 *   1. ключ-секрет (token, pass, Authorization, cookie, CVV, CardData, PAN…) —
 *      значение заменяется целиком на `[REDACTED]`;
 *   2. ключ-PII (ИНН, телефон, e-mail, ФИО…) — значение маскируется частично,
 *      чтобы журнал оставался пригодным для отладки;
 *   3. любая строка дополнительно сканируется на PAN (префикс платёжной
 *      системы + контрольная сумма Luhn) и на `Basic`/`Bearer`-токены — так
 *      реквизиты не утекают через произвольное поле или бесструктурное тело.
 *
 * Редакция односторонняя: восстановить исходное значение из журнала нельзя.
 */
const REDACTED = '[REDACTED]';

/** Ключ считается секретным по точному совпадению… */
const SECRET_KEYS = new Set([
  // HTTP-креды и сессия
  'authorization', 'proxyauthorization', 'wwwauthenticate', 'cookie', 'cookie2', 'setcookie',
  // креды провайдеров (Ferma getToken, партнёрский пароль acqapi)
  'pass', 'password', 'credentials', 'credential', 'privatekey', 'sig', 'sign',
  'login', 'user', 'username',
  // карточные данные: полный PAN и CVV хранить нельзя даже в моке (PCI DSS)
  'pan', 'cardnumber', 'cardnum', 'cardno', 'carddata', 'cardholder', 'holder',
  'expdate', 'expirydate', 'expirationdate', 'expiredate',
]);

/** …или по суффиксу: `access_token`, `client_secret`, `x-api-key`, `CVV2`… */
const SECRET_KEY_SUFFIXES = [
  'token', 'secret', 'password', 'passwd', 'pwd', 'passcode', 'apikey',
  'signature', 'cvv', 'cvv2', 'cvc', 'cvc2',
];

/** PII: не секрет, но персональные данные — маскируем, а не показываем целиком. */
const PII_KEYS = new Set([
  'inn', 'kpp', 'ogrn', 'snils', 'passport', 'passportnumber', 'birthdate', 'birthday',
  'phone', 'phonenumber', 'mobile', 'tel', 'customerphone',
  'email', 'mail', 'customeremail',
  'fio', 'fullname', 'recipientname', 'payername', 'customername', 'cardholdername',
  'address', 'postaladdress',
]);

/** Суффиксы PII-ключей: `PayerInn`, `customer_phone`, `RecipientName`… */
const PII_KEY_SUFFIXES = [
  'inn', 'kpp', 'ogrn', 'snils', 'passport', 'birthdate', 'birthday',
  'phone', 'mobile', 'email', 'fio', 'fullname',
  'recipientname', 'payername', 'customername', 'cardholdername',
];

/** Ключ к нормализованному виду: регистр и разделители не влияют на класс. */
const normalizeKey = (key) => String(key ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Класс ключа: 'secret' | 'pii' | 'safe'. */
function classifyKey(key) {
  const normalized = normalizeKey(key);
  if (!normalized) return 'safe';
  if (SECRET_KEYS.has(normalized) || SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return 'secret';
  if (PII_KEYS.has(normalized) || PII_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return 'pii';
  return 'safe';
}

/** Контрольная сумма Луна: отсекает случайные длинные числа (id, таймстампы). */
function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Похоже ли значение на PAN: 13–19 цифр (пробелы/дефисы допустимы), префикс
 * платёжной системы (2 — «Мир», 4 — Visa, 5/6 — Mastercard/Maestro) и валидная
 * контрольная сумма. Требование Луна нужно, чтобы не маскировать длинные
 * идентификаторы и суммы в журнале.
 */
function looksLikePan(value) {
  const digits = String(value ?? '').replace(/[\s-]/g, '');
  return /^\d{13,19}$/.test(digits) && /^[2456]/.test(digits) && luhnValid(digits);
}

/** Маска PAN в формате стенда: первые 6 (BIN) и последние 4 цифры. */
function maskPan(value) {
  const digits = String(value ?? '').replace(/[\s-]/g, '');
  if (!/^\d{10,}$/.test(digits)) return REDACTED;
  return `${digits.slice(0, 6)}**${digits.slice(-4)}`;
}

/** Частичная маска PII: по ключу выбираем, сколько исходного значения оставить. */
function maskPiiValue(key, value) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  if (!text) return REDACTED;
  const normalized = normalizeKey(key);
  if (normalized.includes('email') || normalized === 'mail') {
    const at = text.indexOf('@');
    return at > 0 ? `${text.slice(0, Math.min(2, at))}***${text.slice(at)}` : `${text.slice(0, 2)}***`;
  }
  if (normalized.includes('phone') || normalized === 'mobile' || normalized === 'tel') {
    const digits = text.replace(/\D/g, '');
    return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
  }
  if (/(inn|kpp|ogrn|snils)$/.test(normalized)) {
    return /^\d{4}/.test(text) ? `${text.slice(0, 4)}${'*'.repeat(Math.max(0, text.length - 4))}` : '***';
  }
  // Прочие PII (ФИО, адрес, логин): короткий префикс, чтобы запись осталась различимой.
  return text.length <= 3 ? '***' : `${text.slice(0, 2)}***`;
}

/** PAN целиком (в т.ч. с разделителями) и токены в произвольном тексте. */
const PAN_IN_TEXT_RE = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;

/** Редакция произвольной строки: журнала, тела без структуры, строки лога. */
function redactSecretsInText(text) {
  return String(text ?? '')
    .replace(/\b(Basic|Bearer)([ \t]+)([A-Za-z0-9+/=._-]{8,})/gi, (_match, scheme, space) => `${scheme}${space}${REDACTED}`)
    .replace(PAN_IN_TEXT_RE, (match) => (looksLikePan(match) ? maskPan(match) : match));
}

const REDACT_MAX_DEPTH = 12;
const REDACT_MAX_ARRAY_ITEMS = 100;

/**
 * Рекурсивная редакция JSON-дерева: объекты, массивы и строки. Глубина и
 * длина массивов ограничены, опасные ключи (F-01) в результат не переносятся.
 */
function redactSecrets(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    if (depth >= REDACT_MAX_DEPTH) return '[…]';
    return value.slice(0, REDACT_MAX_ARRAY_ITEMS).map((item) => redactSecrets(item, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= REDACT_MAX_DEPTH) return '[…]';
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (DANGEROUS_STATE_KEYS.has(key)) continue;
      const kind = classifyKey(key);
      if (kind === 'secret') out[key] = REDACTED;
      else if (kind === 'pii' && (item === null || typeof item !== 'object')) out[key] = maskPiiValue(key, item);
      else out[key] = redactSecrets(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return redactSecretsInText(value);
  return value;
}

/**
 * Редакция сырого тела запроса: JSON разбираем и правим по ключам,
 * form-urlencoded — по параметрам, остальное — как текст (PAN/токены).
 */
function redactRawBody(raw) {
  const text = String(raw ?? '');
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    try {
      return JSON.stringify(redactSecrets(JSON.parse(trimmed)));
    } catch { /* не JSON — ниже обработаем как текст */ }
  }
  if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(trimmed)) {
    // Пары не перекодируем: ключ остаётся как пришёл, правится только значение.
    return trimmed.split('&').map((pair) => {
      const eq = pair.indexOf('=');
      const key = eq < 0 ? pair : pair.slice(0, eq);
      const value = eq < 0 ? '' : pair.slice(eq + 1);
      const kind = classifyKey(key);
      if (kind === 'secret') return `${key}=${REDACTED}`;
      if (kind === 'pii') {
        let decoded = value;
        try { decoded = decodeURIComponent(value); } catch { /* битый escape — маскируем как есть */ }
        return `${key}=${maskPiiValue(key, decoded)}`;
      }
      return `${key}=${redactSecretsInText(value)}`;
    }).join('&');
  }
  return redactSecretsInText(text);
}

/**
 * Выжимка тела запроса для журнала: только скаляры, не больше `maxKeys` полей,
 * значения до `maxValueLength` символов, секреты и PII — по правилам редакции.
 */
function summarizeBody(body, { maxKeys = 8, maxValueLength = 60 } = {}) {
  const out = {};
  let shown = 0;
  for (const [key, value] of Object.entries(body || {})) {
    if (shown >= maxKeys) break;
    if (value === null || value === undefined || typeof value === 'object') continue;
    const kind = classifyKey(key);
    const safe = kind === 'secret' ? REDACTED : (kind === 'pii' ? maskPiiValue(key, value) : redactSecretsInText(String(value)));
    out[key] = String(safe).slice(0, maxValueLength);
    shown += 1;
  }
  return out;
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
 * заменяются на безопасные placeholder-ы до формирования команды, а тело
 * проходит редакцию (F-09): PAN, креды и токены в сниппет не попадают —
 * интегратор подставляет свои реквизиты вместо `[REDACTED]`.
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
    parts.push(`-H ${shellQuote(`${canonical}: ${redactSecretsInText(String(value))}`)}`);
  }
  const payloadStr = rawBody
    ? redactRawBody(rawBody)
    : (body && Object.keys(body).length ? JSON.stringify(redactSecrets(body)) : '');
  if (payloadStr) parts.push(`-d ${shellQuote(payloadStr)}`);
  return parts.join(' ');
}

/** Заголовки, которые безопасно показывать в журнале (всё остальное отбрасывается). */
const JOURNAL_HEADER_ALLOWLIST = new Set([
  'contenttype', 'contentlength', 'useragent', 'xmockscenario', 'xmocksandbox', 'xmocklatency',
]);

/**
 * Allowlist заголовков для журнала (F-09): `Authorization`, `Cookie` и прочие
 * креды в запись не попадают вовсе, служебные `X-Mock-*` остаются для отладки.
 */
function filterJournalHeaders(headers, { maxValueLength = 256 } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const normalized = normalizeKey(key);
    if (!(JOURNAL_HEADER_ALLOWLIST.has(normalized) || (normalized.startsWith('xmock') && classifyKey(key) === 'safe'))) continue;
    if (value === undefined || value === null || value === '') continue;
    const text = Array.isArray(value) ? value.join(', ') : String(value);
    out[String(key).toLowerCase()] = redactSecretsInText(text).slice(0, maxValueLength);
  }
  return out;
}

/**
 * Ограничение длины одной записи журнала (F-09): без него одна запись с телом
 * на мегабайт превращает /admin/journal в способ уронить стенд. Пределы
 * подобраны так, что обычная запись помещается в `entry` без потерь.
 */
const JOURNAL_LIMITS = {
  path: 256,
  key: 48,
  keys: 16,
  value: 120,
  headerValue: 256,
  rawBody: 1024,
  curl: 2048,
  entry: 8192,
};

function truncateText(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Тело записи журнала: плоская выжимка с лимитом на число и длину полей. */
function capJournalBody(body, { maxKeys = JOURNAL_LIMITS.keys, maxKeyLength = JOURNAL_LIMITS.key, maxValueLength = JOURNAL_LIMITS.value } = {}) {
  if (body === null || body === undefined || typeof body !== 'object') return {};
  const out = {};
  let shown = 0;
  for (const [key, value] of Object.entries(body)) {
    if (shown >= maxKeys) break;
    const text = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
    out[truncateText(key, maxKeyLength)] = truncateText(text, maxValueLength);
    shown += 1;
  }
  return out;
}

/**
 * Финальная гарантия размера записи: урезаем сырое тело, сниппет, значения и
 * путь; если и этого мало — тело заменяется явным маркером.
 */
function fitJournalEntry(entry, maxChars) {
  const tooBig = () => JSON.stringify(entry).length > maxChars;
  const shrinkField = (key) => {
    if (typeof entry[key] !== 'string') return;
    let limit = entry[key].length;
    while (limit > 32 && tooBig()) {
      limit = Math.floor(limit / 2);
      entry[key] = truncateText(entry[key], limit);
    }
  };
  if (!tooBig()) return entry;
  shrinkField('rawBody');
  shrinkField('curl');
  if (tooBig() && entry.body && typeof entry.body === 'object') {
    let limit = Object.values(entry.body).reduce((max, value) => Math.max(max, String(value ?? '').length), 0);
    while (limit > 16 && tooBig()) {
      limit = Math.floor(limit / 2);
      for (const [key, value] of Object.entries(entry.body)) entry.body[key] = truncateText(value, limit);
    }
  }
  shrinkField('path');
  if (tooBig()) entry.body = { journal: `запись сокращена: превышен лимит ${maxChars} символов` };
  return entry;
}

/**
 * Журнал входящих запросов (спека §2: «журнал запросов»): последние N
 * обращений к API с методом, путём, ключевыми полями, кодом ответа,
 * длительностью и готовой командой curl для воспроизведения.
 *
 * F-09: запись редактируется до сохранения — заголовки через allowlist, тело и
 * сырой payload через `redactSecrets`, значения и вся запись ограничены по
 * длине. Журнал живёт в памяти процесса, но показывается в /admin (JSON и
 * HTML) и попадает в баг-репорты, поэтому секретов в нём быть не должно.
 */
function createJournal({ size = 200, baseUrl = '', maxEntryChars = JOURNAL_LIMITS.entry } = {}) {
  const entries = [];
  const KNOWN_ENTRY_KEYS = new Set(['at', 'method', 'path', 'status', 'ms', 'body', 'headers', 'rawBody', 'baseUrl', 'curl']);
  function record(entry = {}) {
    const safePath = redactQuerySecrets(truncateText(redactSecretsInText(entry.path || '/'), JOURNAL_LIMITS.path));
    const safeBaseUrl = entry.baseUrl ? redactQuerySecrets(truncateText(entry.baseUrl, JOURNAL_LIMITS.path)) : '';
    const safeHeaders = filterJournalHeaders(entry.headers, { maxValueLength: JOURNAL_LIMITS.headerValue });
    const safeBody = entry.body === undefined || entry.body === null
      ? {}
      : capJournalBody(redactSecrets(entry.body));
    const safeRawBody = entry.rawBody === undefined || entry.rawBody === null
      ? ''
      : truncateText(redactRawBody(entry.rawBody), JOURNAL_LIMITS.rawBody);
    const safeCurl = truncateText(entry.curl || buildCurlCommand({
      baseUrl: entry.baseUrl || baseUrl || 'http://localhost:3100',
      method: entry.method || 'POST',
      path: safePath,
      headers: entry.headers || {},
      rawBody: safeRawBody,
      body: safeBody,
    }), JOURNAL_LIMITS.curl);

    const safeEntry = {
      at: new Date().toISOString(),
      method: entry.method,
      path: safePath,
      status: entry.status,
      ms: entry.ms,
      body: safeBody,
      headers: safeHeaders,
    };
    if (safeRawBody) safeEntry.rawBody = safeRawBody;
    if (safeBaseUrl) safeEntry.baseUrl = safeBaseUrl;
    // Прочие поля записи (если адаптер что-то добавил) — тоже через редакцию.
    for (const [key, value] of Object.entries(entry)) {
      if (!KNOWN_ENTRY_KEYS.has(key)) safeEntry[key] = redactSecrets(value);
    }
    safeEntry.curl = safeCurl;

    entries.push(fitJournalEntry(safeEntry, maxEntryChars));
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
  // `entries` может быть объектом (как раньше) или функцией: в этом случае она
  // резолвится на каждом тике — так очередь работает с состоянием песочницы,
  // в контексте которой запущен tick (F-11/F-14).
  const entriesOf = () => (typeof entries === 'function' ? entries() : entries);
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
  // F-29: защита от перекрывающихся тиков. setInterval не ждёт async tick(), и
  // пока медленный вебхук держит «последовательный» тик, следующий тик мог бы
  // отправить следующую запись параллельно — порядок доставки ломался бы даже
  // при awaitSequential. Пока тик идёт, новый просто пропускается (записи
  // доберутся следующим тиком).
  let ticking = false;

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
    if (ticking) return;
    ticking = true;
    try {
      const currentEntries = entriesOf() || {};
      const ids = Object.keys(currentEntries);
      for (const id of ids) {
        const entry = currentEntries[id];
        if (!entry || inFlight.has(id)) continue;
        if (!isDue(entry)) continue;
        prepare(entry);
        if (awaitSequential) await deliverOne(id, entry);
        else deliverOne(id, entry); // пачкой, без ожидания — как у Ferma-мока
      }
    } finally {
      ticking = false;
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
/**
 * Разбор длительности из env/JSON с fallback: '' / мусор -> fallback, «0» -> 0.
 * Отличается от `parseInt(...) || default`, который не даёт выключить лимит нулём (A-10).
 */
function parseMsOr(raw, fallback = 0) {
  const parsed = parseDuration(raw);
  if (parsed === null) return fallback;
  return Math.max(0, parsed);
}

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

// Максимальный сдвиг даты, представимый Date (±100 000 000 суток от epoch):
// за его пределами new Date(ts).toISOString() бросает RangeError.
const MAX_DATE_OFFSET_MS = 8.64e15;

/**
 * Проверка сдвига виртуальных часов ДО записи (F-05). Возвращает текст ошибки
 * или null. Смещение должно оставаться конечным числом, а «текущее время +
 * смещение» — попадать в диапазон Date, иначе snapshot()/toISOString() падают
 * уже после того, как невалидный offset сохранён в state.
 */
function checkClockOffset(offsetMs, baseMs = Date.now()) {
  if (typeof offsetMs !== 'number' || !Number.isFinite(offsetMs)) {
    return `Некорректный сдвиг виртуальных часов: ${JSON.stringify(offsetMs)} (ожидается конечное число миллисекунд)`;
  }
  const target = baseMs + offsetMs;
  if (!Number.isFinite(target) || Math.abs(target) > MAX_DATE_OFFSET_MS) {
    return `Сдвиг виртуальных часов ${offsetMs} мс вне диапазона дат: текущее время + сдвиг не представимо Date (|сдвиг| ≤ ${MAX_DATE_OFFSET_MS} мс от текущего времени)`;
  }
  return null;
}

/**
 * Виртуальные часы (этап 7 роадмапа, бриф §3.2):
 * позволяют мгновенно сдвигать время стенда на «+7d» / «+60d» / «+36h» без
 * ожидания реальных суток. Инициализируются из MOCK_VIRTUAL_CLOCK (смещение
 * вида "+7d", миллисекунды или ISO-дата) и могут храниться в state-файле.
 *
 * F-05: любое изменение смещения валидируется до записи в state и до
 * изменения локального значения — при ошибке сохранённое время не меняется,
 * а wall-clock операции continue работать на прежнем смещении.
 */
function createVirtualClock({ initial = process.env.MOCK_VIRTUAL_CLOCK || '', getStateOffset, setStateOffset, log = console.error } = {}) {
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

  // Восстановление после отказа (F-05): если в state уже лежит сдвиг, который
  // нельзя представить Date (например, из state-файла старой версии), часы
  // работают на безопасном локальном значении, а не падают на toISOString().
  let warnedAboutStoredOffset = false;
  const readOffset = () => {
    if (typeof getStateOffset === 'function') {
      const v = getStateOffset();
      if (typeof v === 'number' && Number.isFinite(v)) {
        const problem = checkClockOffset(v);
        if (!problem) return v;
        if (!warnedAboutStoredOffset) {
          warnedAboutStoredOffset = true;
          log(`[core] сохранённый сдвиг виртуальных часов игнорирован: ${problem}`);
        }
        return localOffsetMs;
      }
    }
    return localOffsetMs;
  };

  /**
   * Атомарная запись сдвига: сначала проверка диапазона Date, затем локальное
   * значение и внешнее состояние. Ошибка валидации не меняет ни то, ни другое.
   */
  const writeOffset = (next) => {
    const normalized = Math.round(Number(next) || 0);
    const problem = checkClockOffset(normalized);
    if (problem) {
      throw new Error(problem);
    }
    localOffsetMs = normalized;
    if (typeof setStateOffset === 'function') setStateOffset(normalized);
    return normalized;
  };

  // Дефолт из MOCK_VIRTUAL_CLOCK: невалидное значение не должно ронять старт
  // сервиса — фиксируем предупреждение и работаем на нулевом сдвиге.
  if (localOffsetMs !== 0) {
    try {
      writeOffset(localOffsetMs);
    } catch (e) {
      log(`[core] MOCK_VIRTUAL_CLOCK=${JSON.stringify(initial)} игнорирован: ${e.message}`);
      localOffsetMs = 0;
    }
  }

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

/* ------------------------------------------------------------ money input */

/**
 * Верхняя граница денежной суммы в копейках для мок-стенда (F-24): только
 * безопасные целые Number. Это не добавляет искусственный лимит провайдера:
 * граница ровно соответствует диапазону, в котором JS-арифметика сохраняет
 * точность целых чисел.
 */
const MAX_MONEY_KOPEKS = Number.MAX_SAFE_INTEGER;

/**
 * Строгий разбор денежной суммы в копейках (F-24).
 *
 * `parseInt` принимает мусор (`"1000xyz"` → 1000, `"1000.9"` → 1000, `"0x10"` → 16)
 * и подменяет сумму в подписанном запросе. Здесь принимаются только:
 *   • JSON-number без дробной части (1000, 1e3);
 *   • строка из одних десятичных цифр ("1000").
 * Отклоняются дроби (`"1000.9"`, 1000.9), знаки/пробелы/шестнадцатеричный вид
 * (`"+1000"`, `" 1000"`, `"0x10"`), trailing junk (`"1000xyz"`), нечисловые типы,
 * сумма 0/отрицательная, значения вне [1 … MAX_MONEY_KOPEKS].
 *
 * Возвращает { ok: true, value } | { ok: false, reason, message }.
 */
function parseMoneyKopeks(raw, { field = 'Amount', required = true, max = MAX_MONEY_KOPEKS } = {}) {
  const reject = (reason, message) => ({ ok: false, reason, field, message });
  if (raw === undefined || raw === null || raw === '') {
    return required
      ? reject('missing', `${field} обязателен: целое число копеек больше нуля`)
      : reject('missing', `${field} не передан`);
  }
  let value;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return reject('not-finite', `${field} должен быть конечным числом копеек`);
    if (!Number.isInteger(raw)) {
      return reject('fraction', `${field}=${JSON.stringify(raw)} — дробное значение; передайте целое число копеек (1000.9 → 100090)`);
    }
    value = raw;
  } else if (typeof raw === 'string') {
    if (!/^\d+$/.test(raw)) {
      return reject('format', `${field}=${JSON.stringify(raw)} — не целое число копеек: допустимы только цифры без знака, пробелов и мусора`);
    }
    value = Number(raw);
  } else {
    return reject('type', `${field} должен быть целым числом копеек (string или number), получено ${typeof raw}`);
  }
  if (!Number.isSafeInteger(value)) {
    return reject('not-safe', `${field}=${JSON.stringify(raw)} больше безопасного целочисленного диапазона`);
  }
  if (value <= 0) return reject('non-positive', `${field} должен быть больше нуля`);
  if (value > max) {
    return reject('out-of-range', `${field}=${value} превышает допустимый максимум мок-стенда ${max} копеек`);
  }
  return { ok: true, value };
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

const CSRF_TOKEN_TTL_MS = 4 * 60 * 60 * 1000;

/** Выпускает короткоживущий, подписанный синхронизирующий токен для HTML-форм. */
function createCsrfToken(secret, context = '', now = Date.now(), ttlMs = CSRF_TOKEN_TTL_MS) {
  const key = String(secret || '');
  if (!key) throw new Error('createCsrfToken: нужен секрет подписи');
  const ttl = Number.isFinite(Number(ttlMs)) ? Math.max(1, Number(ttlMs)) : CSRF_TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    context: String(context || ''),
    expiresAt: Math.floor(Number(now) + ttl),
    nonce: crypto.randomBytes(24).toString('base64url'),
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

/** Проверяет подпись, срок жизни и привязку CSRF-токена к контексту/песочнице. */
function verifyCsrfToken(token, secret, context = '', now = Date.now()) {
  const key = String(secret || '');
  const parts = String(token || '').split('.');
  if (!key || parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [payload, signature] = parts;
  const expected = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return decoded.version === 1
      && decoded.context === String(context || '')
      && Number.isSafeInteger(decoded.expiresAt)
      && decoded.expiresAt > Number(now)
      && typeof decoded.nonce === 'string'
      && decoded.nonce.length >= 32;
  } catch {
    return false;
  }
}

/**
 * Проверка browser-origin для операций из cookie-авторизуемых HTML-форм.
 * Отсутствующий Origin/Referer допускается для CLI-клиентов — CSRF-токен
 * остаётся обязательным; явно cross-site запрос всегда запрещён.
 */
function isSameOriginRequest(req) {
  const headers = (req && req.headers) || {};
  const fetchSite = String(headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin') return false;

  const sourceValue = headers.origin || headers.referer;
  if (!sourceValue) return true;
  if (String(sourceValue).trim().toLowerCase() === 'null') return false;

  const firstHeaderValue = (value) => String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();
  // X-Forwarded-Host is intentionally ignored: it is often client-controlled
  // unless every proxy in front of the app is explicitly trusted/configured.
  const requestHost = firstHeaderValue(headers.host);
  const forwardedProto = firstHeaderValue(headers['x-forwarded-proto']).toLowerCase();
  const requestProto = forwardedProto || ((req && req.socket && req.socket.encrypted) ? 'https' : 'http');
  if (!requestHost || !['http', 'https'].includes(requestProto)) return false;

  try {
    const source = new URL(String(sourceValue));
    const target = new URL(`${requestProto}://${requestHost}`);
    return ['http:', 'https:'].includes(source.protocol) && source.origin === target.origin;
  } catch {
    return false;
  }
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

/* ------------------------------------- request-local песочницы (RFC-001, A-21) */

const SANDBOX_ID_UNSAFE = /[^a-zA-Z0-9_.-]/g;
const SANDBOX_ID_MAX = 64;
const SANDBOX_WORDS_ADJ = [
  'swift', 'calm', 'brave', 'lucky', 'quiet', 'bright', 'kind', 'bold',
  'clever', 'gentle', 'happy', 'silent', 'warm', 'neat', 'rapid', 'solid',
];
const SANDBOX_WORDS_NOUN = [
  'fox', 'heron', 'otter', 'lynx', 'finch', 'raven', 'panda', 'bison',
  'koi', 'moth', 'crane', 'gecko', 'walrus', 'wren', 'ibis', 'yak',
];

/** Человекочитаемый, но не подбираемый ID песочницы (RFC-001 §4/§7). */
function generateSandboxId() {
  const adj = SANDBOX_WORDS_ADJ[crypto.randomInt(SANDBOX_WORDS_ADJ.length)];
  const noun = SANDBOX_WORDS_NOUN[crypto.randomInt(SANDBOX_WORDS_NOUN.length)];
  return `${adj}-${noun}-${crypto.randomBytes(5).toString('hex')}`;
}

function sanitizeSandboxId(raw) {
  const id = String(raw === undefined || raw === null ? '' : raw)
    .trim()
    .replace(SANDBOX_ID_UNSAFE, '')
    .slice(0, SANDBOX_ID_MAX);
  return id === '.' || id === '..' ? '' : id;
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** URL-safe секрет: owner-token, креды песочницы (≥192 бит энтропии). */
function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Режим мульти-аренды (F-12, RFC-001 §2/§9):
 *   'off'        — одна общая песочница `default` (селектор игнорируется);
 *   'namespaces' — именованные песочницы-пространства имён для параллельных
 *                  CI-воркеров (дефолт self-hosted, владелец не проверяется);
 *   'owned'      — hosted-режим: каждая песочница имеет владельца и owner-token,
 *                  знание ID не даёт доступ (MOCK_HOSTED=1 или MOCK_TENANCY=1).
 * MOCK_TENANCY принимает имена режимов и legacy-флаги; мусорное значение
 * вызывает warn и безопасно сводится к default для hosted/self-hosted.
 */
function resolveTenancyMode(value, hosted = false, warn = (message) => console.warn(message)) {
  const raw = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  const safeDefault = hosted ? 'owned' : 'namespaces';
  if (!raw) return safeDefault;

  const aliases = {
    owned: 'owned',
    namespaces: 'namespaces',
    off: 'off',
    '1': 'owned',
    on: 'owned',
    true: 'owned',
    yes: 'owned',
    '0': 'off',
    false: 'off',
    no: 'off',
  };
  if (Object.prototype.hasOwnProperty.call(aliases, raw)) return aliases[raw];

  const printable = raw.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').slice(0, 80);
  if (typeof warn === 'function') {
    warn(`Неизвестное значение MOCK_TENANCY=${JSON.stringify(printable)}; безопасный режим по умолчанию: ${safeDefault}.`);
  }
  return safeDefault;
}

/**
 * Request-local изоляция песочниц (RFC-001, находки F-11—F-15).
 *
 * В отличие от `createSandboxManager` (legacy, «переключает» singleton state),
 * рантайм держит отдельное состояние у каждой песочницы, а модульный `state` —
 * это фасад-прокси, который резолвится из контекста текущего запроса
 * (AsyncLocalStorage). Один запрос = один контекст: запрос без селектора
 * получает default/активную песочницу, а не остатки предыдущего арендатора;
 * параллельные A/B-запросы не видят state друг друга даже между `await`.
 *
 * Гарантии:
 *   - селектор: `X-Mock-Sandbox` > `?sandbox=` > поддомен (только если задан
 *     `hostSuffix`, чтобы не путать поддомены хостинга с ID песочницы);
 *   - `owned`: изоляция по owner-token (создание отдаёт токен один раз),
 *     чужие креды/состояние недоступны; в остальных режимах — совместимость;
 *   - экспорт/импорт принимают явный target и не переключают активную песочницу;
 *   - TTL + автоочистка + лимит количества; состояние персистится только JSON-снимком
 *     через `safeStateSnapshot` (null-proto словари, #23).
 */
function createSandboxRuntime({
  state,
  persist = () => {},
  initialStateFactory,
  mode = 'namespaces',
  stateFile = '',
  sandboxFile = '',
  ttlMs = 0,
  maxSandboxes = 0,
  maxDocuments = 0,
  documentCounter = null,
  retention = null,
  defaultOwnerToken = '',
  hostSuffix = '',
  operatorTokens = [],
  createLimit = 0,
  log = () => {},
  now = () => Date.now(),
  saveDelayMs = 150,
} = {}) {
  if (!isPlainObject(state)) throw new Error('createSandboxRuntime: state должен быть JSON-объектом');
  const tenancy = ['off', 'namespaces', 'owned'].includes(mode) ? mode : 'namespaces';
  const defaultPersist = typeof persist === 'function' ? persist : () => {};
  const registryFile = String(sandboxFile || (stateFile ? `${stateFile}.sandboxes.json` : ''));
  const suffix = String(hostSuffix || '').trim().toLowerCase().replace(/^\./, '');
  const operators = (Array.isArray(operatorTokens) ? operatorTokens : [operatorTokens])
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  const als = new AsyncLocalStorage();
  const sandboxes = new Map();
  const createLog = new Map(); // ip -> [timestamps] — лимит создания (RFC-001 §7)
  let activeId = 'default';
  let serial = 0;
  let saveTimer = null;

  const isoNow = () => new Date(now()).toISOString();

  function freshState(id) {
    const seed = (serial += 1);
    const fresh = typeof initialStateFactory === 'function' ? initialStateFactory({ id, seed }) : {};
    return isPlainObject(fresh) ? fresh : {};
  }

  const defaultRecord = {
    id: 'default',
    isDefault: true,
    createdAt: isoNow(),
    updatedAt: isoNow(),
    expiresAt: 0,
    ownerTokenHash: defaultOwnerToken ? hashSecret(defaultOwnerToken) : null,
    creds: null,
    profile: null,
    state,
  };
  sandboxes.set('default', defaultRecord);

  /* --------------------------------------------------- персистентность (F-14) */

  function registryPayload() {
    return {
      version: 1,
      activeId,
      savedAt: isoNow(),
      sandboxes: Array.from(sandboxes.values())
        .filter((rec) => !rec.isDefault)
        .map((rec) => ({
          id: rec.id,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          expiresAt: rec.expiresAt || 0,
          ownerTokenHash: rec.ownerTokenHash || null,
          creds: rec.creds || null,
          profile: rec.profile || null,
          state: rec.state,
        })),
    };
  }

  function flushRegistry() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!registryFile) return;
    try {
      fs.mkdirSync(path.dirname(registryFile), { recursive: true });
      const tmp = `${registryFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(registryPayload()));
      fs.renameSync(tmp, registryFile); // атомарная замена: файл не бывает полузаписан
    } catch (e) {
      log(`sandbox registry persist failed: ${e.message}`);
    }
  }

  function scheduleRegistrySave() {
    if (!registryFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flushRegistry();
    }, Math.max(0, saveDelayMs));
    if (typeof saveTimer.unref === 'function') saveTimer.unref();
  }

  function persistRecord(rec, immediate = false) {
    if (!rec || rec.isDefault) {
      defaultPersist();
      return;
    }
    if (immediate) flushRegistry();
    else scheduleRegistrySave();
  }

  /**
   * Восстановление реестра песочниц. Запись с id `default` из файла намеренно
   * игнорируется: состояние именованной песочницы нельзя выдать за default
   * (F-14), default всегда восстанавливается только из MOCK_STATE_FILE.
   */
  function restoreRegistry() {
    if (!registryFile || !fs.existsSync(registryFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      const items = raw && Array.isArray(raw.sandboxes) ? raw.sandboxes : [];
      for (const item of items) {
        const id = sanitizeSandboxId(item && item.id);
        if (!id || id === 'default' || sandboxes.has(id)) continue;
        let stored;
        try {
          stored = safeStateSnapshot(item.state || {}, `sandbox ${id}`, false);
        } catch (e) {
          log(`sandbox ${id} restore skipped: ${e.message}`);
          continue;
        }
        const restored = freshState(id);
        mergeValidatedInto(restored, stored);
        sandboxes.set(id, {
          id,
          isDefault: false,
          createdAt: item.createdAt || isoNow(),
          updatedAt: item.updatedAt || isoNow(),
          expiresAt: Number(item.expiresAt) || 0,
          ownerTokenHash: item.ownerTokenHash || null,
          creds: item.creds || null,
          profile: item.profile || null,
          state: restored,
        });
      }
      const restoredActive = sanitizeSandboxId(raw && raw.activeId);
      if (restoredActive && (restoredActive === 'default' || sandboxes.has(restoredActive))) {
        activeId = restoredActive;
      }
      log(`sandboxes restored from ${registryFile}: ${sandboxes.size - 1}`);
    } catch (e) {
      log(`sandbox registry restore failed: ${e.message}`);
    }
  }

  /* ------------------------------------------------------- разбор селектора */

  function selector(req) {
    const headers = (req && req.headers) || {};
    const hdr = sanitizeSandboxId(headers['x-mock-sandbox']);
    if (hdr) return { id: hdr, source: 'header' };
    try {
      const u = new URL((req && req.url) || '/', 'http://mock.local');
      const q = sanitizeSandboxId(u.searchParams.get('sandbox'));
      if (q) return { id: q, source: 'query' };
    } catch { /* ignore */ }
    if (suffix) {
      const host = String(headers.host || '').split(':')[0].toLowerCase().replace(/\.$/, '');
      if (host.endsWith(`.${suffix}`)) {
        const prefix = host.slice(0, -(suffix.length + 1));
        const labels = prefix.split('.').filter(Boolean);
        const sub = sanitizeSandboxId(labels[labels.length - 1]);
        if (sub && sub !== 'www') return { id: sub, source: 'host' };
      }
    }
    return { id: '', source: null };
  }

  function ownerTokenOf(req) {
    const headers = (req && req.headers) || {};
    const auth = String(headers.authorization || '');
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    const direct = headers['x-sandbox-token'] || headers['x-owner-token'];
    if (direct) return String(direct).trim();
    try {
      const u = new URL((req && req.url) || '/', 'http://mock.local');
      return String(u.searchParams.get('sandbox_token') || '').trim();
    } catch {
      return '';
    }
  }

  function isOperatorToken(token) {
    return Boolean(token) && operators.some((expected) => safeEqual(token, expected));
  }

  function recordAuthorized(rec, req) {
    if (!rec.ownerTokenHash) return true;
    const token = ownerTokenOf(req);
    if (!token) return false;
    if (isOperatorToken(token)) return true;
    return safeEqual(hashSecret(token), rec.ownerTokenHash);
  }

  /** Песочница, которой соответствует предъявленный owner-token (для /sandboxes/me). */
  function recordByOwnerToken(req) {
    const token = ownerTokenOf(req);
    if (!token || isOperatorToken(token)) return null;
    const hash = hashSecret(token);
    for (const rec of sandboxes.values()) {
      if (rec.ownerTokenHash && safeEqual(hash, rec.ownerTokenHash)) return rec;
    }
    return null;
  }

  function currentRecord() {
    const rec = als.getStore();
    if (rec && sandboxes.get(rec.id) === rec) return rec;
    return sandboxes.get(activeId) || defaultRecord;
  }

  /* ---------------------------------------------- лимиты и квоты (F-14/F-15) */

  function documents(rec = currentRecord()) {
    if (typeof documentCounter !== 'function') return null;
    try {
      const used = documentCounter(rec.state);
      return Number.isFinite(used) ? used : 0;
    } catch {
      return 0;
    }
  }

  function checkDocuments() {
    const used = documents();
    if (maxDocuments > 0 && used !== null && used >= maxDocuments) {
      return { ok: false, used, limit: maxDocuments };
    }
    return { ok: true, used, limit: maxDocuments };
  }

  function createLimitFor(ip) {
    if (!createLimit) return { ok: true };
    const key = String(ip || 'unknown');
    const winStart = now() - 60 * 60 * 1000;
    const hits = (createLog.get(key) || []).filter((ts) => ts >= winStart);
    if (hits.length >= createLimit) return { ok: false, retryAfterMs: hits[0] + 60 * 60 * 1000 - now() };
    hits.push(now());
    createLog.set(key, hits);
    if (createLog.size > 10000) createLog.clear();
    return { ok: true };
  }

  function createRecord(id, { creds = null, profile = null, ttl = null, ownerToken = null } = {}) {
    if (maxSandboxes > 0 && sandboxes.size - 1 >= maxSandboxes) return null;
    const rec = {
      id,
      isDefault: false,
      createdAt: isoNow(),
      updatedAt: isoNow(),
      expiresAt: ttl && ttl > 0 ? now() + ttl : 0,
      ownerTokenHash: ownerToken ? hashSecret(ownerToken) : null,
      creds: creds || null,
      profile: profile || null,
      state: freshState(id),
    };
    sandboxes.set(id, rec);
    persistRecord(rec, true);
    return rec;
  }

  /**
   * Разрешение контекста запроса ровно один раз (F-11).
   * policy: 'business' | 'control' | 'form' | 'public'.
   */
  function admit(req, policy = 'business') {
    const sel = selector(req);
    if (tenancy === 'off') return { ok: true, record: defaultRecord, selector: sel, via: 'off' };
    if (tenancy === 'owned' && policy === 'public') {
      return { ok: true, record: defaultRecord, selector: sel, via: 'public' };
    }
    const fallback = tenancy === 'owned' ? 'default' : (activeId || 'default');
    const id = sel.id || fallback;
    let rec = sandboxes.get(id);
    if (!rec) {
      if (tenancy === 'owned') {
        return {
          ok: false,
          kind: 'not-found',
          sandbox: id,
          selector: sel,
          hint: 'Создайте песочницу: POST /sandboxes — в ответе будут id, creds и ownerToken.',
        };
      }
      const limit = createLimitFor(req && req.socket && req.socket.remoteAddress);
      if (!limit.ok) return { ok: false, kind: 'rate-limit', sandbox: id, selector: sel };
      rec = createRecord(id, { ttl: ttlMs });
      if (!rec) return { ok: false, kind: 'limit', sandbox: id, selector: sel };
    }
    if (rec.expiresAt && rec.expiresAt <= now()) {
      remove(rec.id);
      return { ok: false, kind: 'expired', sandbox: rec.id, selector: sel };
    }
    // 'form' — capability-ссылки покупателя (форма оплаты, страница чека): сам
    // объект доступа (PaymentId/UUID) и есть секрет, owner-token не требуется.
    if (tenancy === 'owned' && policy !== 'form' && !recordAuthorized(rec, req)) {
      return { ok: false, kind: 'unauthorized', sandbox: rec.id, selector: sel };
    }
    const via = !rec.ownerTokenHash
      ? (rec.isDefault ? 'default' : 'namespace')
      : (isOperatorToken(ownerTokenOf(req)) ? 'operator' : 'owner');
    return { ok: true, record: rec, selector: sel, via };
  }

  function run(admission, fn) {
    const rec = admission && admission.ok ? admission.record : currentRecord();
    return als.run(rec, fn);
  }

  /* ------------------------------------------------------------- управление */

  function describe(rec) {
    return {
      id: rec.id,
      active: rec.id === activeId,
      default: Boolean(rec.isDefault),
      owned: Boolean(rec.ownerTokenHash),
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      expiresAt: rec.expiresAt || 0,
      documents: documents(rec),
    };
  }

  function list() {
    return Array.from(sandboxes.values()).map(describe);
  }

  function find(id) {
    return sandboxes.get(sanitizeSandboxId(id)) || null;
  }

  function create({ id = '', creds = null, profile = null, ttlMs: ttlOverride = null, ip = '', owner = true } = {}) {
    const rate = createLimitFor(ip);
    if (!rate.ok) {
      const e = new Error(`Слишком много созданных песочниц: лимит ${createLimit}/час на адрес`);
      e.code = 'SANDBOX_RATE_LIMIT';
      e.retryAfterMs = rate.retryAfterMs;
      throw e;
    }
    const wanted = sanitizeSandboxId(id) || generateSandboxId();
    if (wanted === 'default' || sandboxes.has(wanted)) {
      const e = new Error(`Песочница «${wanted}» уже существует`);
      e.code = 'SANDBOX_EXISTS';
      throw e;
    }
    const ownerToken = owner && tenancy === 'owned' ? `sbx_${randomToken(24)}` : null;
    const rec = createRecord(wanted, {
      creds,
      profile,
      ttl: ttlOverride === null ? ttlMs : ttlOverride,
      ownerToken,
    });
    if (!rec) {
      const e = new Error(`Достигнут лимит песочниц (${maxSandboxes}); удалите неиспользуемые или поднимите MOCK_SANDBOX_MAX`);
      e.code = 'SANDBOX_LIMIT';
      throw e;
    }
    return { ...describe(rec), ownerToken, creds: rec.creds || null, profile: rec.profile || null };
  }

  /** Смена кредов песочницы (RFC-001 §6, reset-creds): owner-token сохраняется. */
  function updateCreds(id, creds) {
    const rec = sandboxes.get(sanitizeSandboxId(id));
    if (!rec || rec.isDefault) return { ok: false, error: 'not-found' };
    rec.creds = creds || null;
    rec.updatedAt = isoNow();
    persistRecord(rec, true);
    return { ok: true, sandbox: rec.id, creds: rec.creds };
  }

  function remove(id) {
    const rec = sandboxes.get(sanitizeSandboxId(id));
    if (!rec || rec.isDefault) return { ok: false, removed: null };
    sandboxes.delete(rec.id);
    if (activeId === rec.id) activeId = 'default';
    flushRegistry();
    return { ok: true, removed: rec.id };
  }

  function switchActive(id = 'default') {
    const wanted = sanitizeSandboxId(id) || 'default';
    if (tenancy === 'owned') return { ok: false, error: 'owned-mode', current: activeId };
    if (!sandboxes.has(wanted)) {
      const rec = createRecord(wanted, { ttl: ttlMs });
      if (!rec) return { ok: false, error: 'limit', current: activeId };
    }
    activeId = wanted;
    flushRegistry();
    return { ok: true, current: activeId };
  }

  function reset(id = null) {
    const rec = id === null || id === undefined ? currentRecord() : (sandboxes.get(sanitizeSandboxId(id)) || createRecord(sanitizeSandboxId(id), { ttl: ttlMs }));
    if (!rec) return { ok: false, sandbox: id || null, error: 'not-found' };
    const fresh = freshState(rec.id);
    mergeValidatedInto(rec.state, safeStateSnapshot(fresh, 'fresh sandbox state'));
    rec.updatedAt = isoNow();
    persistRecord(rec, true);
    return { ok: true, sandbox: rec.id };
  }

  function exportState(id = null) {
    const rec = id === null || id === undefined ? currentRecord() : sandboxes.get(sanitizeSandboxId(id));
    if (!rec) return { sandbox: sanitizeSandboxId(id) || null, exportedAt: isoNow(), state: {}, error: 'not-found' };
    return {
      sandbox: rec.id,
      exportedAt: isoNow(),
      state: safeStateSnapshot(JSON.parse(JSON.stringify(rec.state)), 'exported state'),
    };
  }

  /**
   * Импорт снимка в явно указанную песочницу (F-13): активная (текущая) песочница
   * не переключается, соседние состояния не меняются.
   */
  function importState(payload = {}, targetId = null) {
    let rec;
    if (targetId === null || targetId === undefined) {
      rec = currentRecord();
    } else {
      const wanted = sanitizeSandboxId(targetId);
      rec = sandboxes.get(wanted) || createRecord(wanted, { ttl: ttlMs });
      if (!rec) throw new Error(`Песочница «${wanted}» не найдена`);
    }
    const next = payload && isPlainObject(payload.state) ? payload.state : payload;
    if (!isPlainObject(next)) throw new Error('Ожидается JSON-объект состояния');
    const safe = safeStateSnapshot(next, 'imported state');
    mergeValidatedInto(rec.state, safe);
    rec.updatedAt = isoNow();
    persistRecord(rec, true);
    return { ok: true, sandbox: rec.id };
  }

  /** TTL + retention + лимиты: фоновый воркер вызывается раз в минуту. */
  function sweep() {
    const ts = now();
    let expired = 0;
    let pruned = 0;
    for (const rec of Array.from(sandboxes.values())) {
      if (rec.isDefault) continue;
      if (rec.expiresAt && rec.expiresAt <= ts) {
        sandboxes.delete(rec.id);
        if (activeId === rec.id) activeId = 'default';
        log(`sandbox ${rec.id} expired (TTL) and removed`);
        expired += 1;
        continue;
      }
      if (typeof retention === 'function') {
        try {
          pruned += retention(rec.state, ts) || 0;
        } catch (e) {
          log(`sandbox ${rec.id} retention failed: ${e.message}`);
        }
      }
    }
    if (expired || pruned) flushRegistry();
    return { expired, pruned };
  }

  /** Прогон fn в контексте каждой песочницы (очереди вебхуков, bank-timers). */
  function tickAll(fn) {
    for (const rec of Array.from(sandboxes.values())) {
      try {
        als.run(rec, fn);
      } catch (e) {
        log(`sandbox tick failed (${rec.id}): ${e.message}`);
      }
    }
  }

  function creds() {
    return currentRecord().creds || {};
  }

  /**
   * Модульный фасад состояния: резолвится из контекста запроса, а вне запроса —
   * в активную (default для owned) песочницу. Идентичность объекта сохранена,
   * поэтому подсистемы, держащие ссылки (`state.notifications`), продолжают
   * работать внутри контекста.
   */
  const stateProxy = new Proxy(Object.create(null), {
    get(_target, prop) {
      const rec = currentRecord();
      if (prop === '__sandboxId') return rec.id;
      const value = rec.state[prop];
      if (value !== undefined || prop in rec.state) return value;
      const fallback = Object.prototype[prop];
      return typeof fallback === 'function' ? fallback : undefined;
    },
    set(_target, prop, value) {
      currentRecord().state[prop] = value;
      return true;
    },
    has(_target, prop) {
      return prop in currentRecord().state;
    },
    deleteProperty(_target, prop) {
      delete currentRecord().state[prop];
      return true;
    },
    ownKeys() {
      return Reflect.ownKeys(currentRecord().state);
    },
    getOwnPropertyDescriptor(_target, prop) {
      const descriptor = Object.getOwnPropertyDescriptor(currentRecord().state, prop);
      if (!descriptor) return undefined;
      return { ...descriptor, configurable: true };
    },
  });

  restoreRegistry();

  return {
    mode: tenancy,
    state: stateProxy,
    persist: () => persistRecord(currentRecord(), false),
    admit,
    run,
    selector,
    ownerTokenOf,
    isOperatorToken,
    recordAuthorized,
    currentId: () => currentRecord().id,
    recordByOwnerToken,
    current: () => currentRecord(),
    list,
    find,
    describe,
    create,
    updateCreds,
    remove,
    switchActive,
    reset,
    exportState,
    importState,
    sweep,
    tickAll,
    creds,
    documents,
    checkDocuments,
    activeId: () => activeId,
    stats: () => ({ mode: tenancy, activeId, count: sandboxes.size - 1, file: registryFile || null }),
    flush: flushRegistry,
    restore: restoreRegistry,
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
  REDACTED,
  classifyKey,
  looksLikePan,
  maskPan,
  maskPiiValue,
  redactSecrets,
  redactSecretsInText,
  redactRawBody,
  summarizeBody,
  filterJournalHeaders,
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
  checkClockOffset,
  parseMoneyKopeks,
  MAX_MONEY_KOPEKS,
  parseMsOr,
  parseScenarioSpec,
  createScenarioRegistry,
  checkAdminAuth,
  checkControlAccess,
  createCsrfToken,
  verifyCsrfToken,
  isSameOriginRequest,
  applyRequestChaos,
  createSandboxManager,
  createSandboxRuntime,
  resolveTenancyMode,
  generateSandboxId,
  sanitizeSandboxId,
  hashSecret,
  randomToken,
  verifyMerchantWebhook,
};
