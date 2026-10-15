// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Проверка «правила пяти мест» для env-переменных (AGENTS.md §5):
 *
 *   services/<name>-mock/server.js  ← источник истины (что реально читается)
 *        ↕
 *   services/<name>-mock/README.md  ← документация сервиса (env-таблица)
 *        ↕
 *   docker-compose.yml · docker-compose.include.yml · docker-compose.staging.yml
 *        ↕
 *   SECURITY.md (переменные модели угроз)
 *
 * Что проверяется:
 *   1. env → README: каждая `MOCK_*`, которую читает сервис, описана в его
 *      README — точно или маской `MOCK_PREFIX_*` (общие переменные ядра);
 *   2. README → env: в README нет выдуманных `MOCK_*` — каждая либо читается
 *      сервисом, либо объявлена в compose/Dockerfile (обвязка контейнера);
 *   3. compose → env: каждый ключ `environment:` в compose читается тем
 *      сервисом, которому он задан (либо это контейнерная переменная из
 *      CONTAINER_ENV, например `MOCK_HEALTH_PATH` для Docker HEALTHCHECK);
 *   4. include-покрытие: переменная, которая читается сервисом, но не
 *      проброшена в `docker-compose.include.yml`, обязана быть в
 *      KNOWN_INCLUDE_DEBT — иначе это новый дрейф (незакрытый долг «пяти
 *      мест»). Устаревшая запись долга (переменная уже в include) — ошибка;
 *   5. root ⊆ include: набор environment-ключей и интерполяций `${MOCK_…}`
 *      корневого compose для сервиса не шире, чем в include-артефакте;
 *   6. покрытие сервисов: у каждого `services/*-mock` есть блок в include;
 *      отсутствие блока в корневом compose допускается только для сервисов
 *      из ROOT_COMPOSE_EXEMPT (с причиной);
 *   7. порты: published-порт compose, `MOCK_PORT` в environment, дефолт
 *      `MOCK_PORT` в server.js и дефолт `${MOCK_<SVC>_HOST_PORT:-…}` совпадают,
 *      порты сервисов уникальны;
 *   8. дефолты: литеральный дефолт в compose (`${VAR:-значение}`) совпадает с
 *      литеральным дефолтом server.js (только простые случаи: пустая строка,
 *      плейсхолдеры `<…>`, вычисляемые дефолты не сверяются);
 *   9. SECURITY.md: переменные модели угроз перечислены в SECURITY.md.
 *
 *   node scripts/check-env-parity.js   # 0 — env-контракт согласован
 *
 * Zero dependencies. Известный долг (переменные, которые читаются сервисами, но
 * не проброшены в include) — в KNOWN_INCLUDE_DEBT: он печатается в выводе
 * проверки, а новая переменная без include-строки и без записи в долг валит CI.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const problems = [];
const notes = [];
const stats = { defaults: 0, ports: 0, envKeys: 0, readmeVars: 0 };

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

/* ---------- источники истины: services/<name>/server.js ---------- */

/*
 * Читает переменные окружения адаптера:
 *   • деструктуризация `const { MOCK_X = 'def', MOCK_Y } = process.env;`
 *     (в том числе `= env;` — как в kontur/taxcom);
 *   • прямые обращения `process.env.MOCK_X` / `env.MOCK_X`.
 * Возвращает { reads: Set, defaults: Map } — дефолты только литеральные
 * (строка/число), вычисляемые выражения (`String(24 * 60 * 60 * 1000)`,
 * шаблонные строки) помечаются как null.
 */
function serverEnv(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const reads = new Set();
  const defaults = new Map();

  const literalOf = (value) => {
    const cleaned = value.replace(/\/\/.*$/, '').trim().replace(/,$/, '').trim();
    const literal = cleaned.match(/^'([^']*)'$/) || cleaned.match(/^"([^"]*)"$/) || cleaned.match(/^(-?\d+)$/);
    return literal ? literal[1] : null;
  };

  /* Блоки деструктуризации: закрывающая строка `} = process.env;`. */
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\}\s*=\s*(?:process\.env|env)\s*;/.test(lines[i])) continue;
    let start = i;
    while (start > 0 && !/^\s*(?:const|let)\s*\{\s*$/.test(lines[start])) start--;
    if (!/^\s*(?:const|let)\s*\{\s*$/.test(lines[start])) continue;
    const block = lines.slice(start + 1, i).map((line) => line.replace(/\/\/.*$/, '')).join('\n');
    for (const part of block.split(/[,\n]/)) {
      const entry = part.match(/^\s*([A-Za-z0-9_]+)\s*(?::\s*([A-Za-z0-9_]+))?\s*=\s*(.*)$/);
      if (!entry) continue;
      const key = entry[2] || entry[1];
      if (!/^MOCK_/.test(key)) continue;
      reads.add(key);
      defaults.set(key, literalOf(entry[3] || ''));
    }
  }

  for (const match of text.matchAll(/(?:process\.)?env\.(MOCK_[A-Z0-9_]+)/g)) reads.add(match[1]);

  /* `env.MOCK_X || 'дефолт'` — прямой fallback. */
  for (const match of text.matchAll(/env\.(MOCK_[A-Z0-9_]+)\s*\|\|\s*('[^']*'|"[^"]*"|\d+)/g)) {
    reads.add(match[1]);
    if (!defaults.has(match[1])) defaults.set(match[1], literalOf(match[2]));
  }

  /*
   * Вычисляемые, но однозначные дефолты: `parseInt(MOCK_X, 10) || 60000`,
   * `parseMsOr(MOCK_X, 10000)`, `Number(MOCK_X) || 3108`. Сложные выражения
   * (`7 * 24 * 60 * 60 * 1000`) не разбираются — такие дефолты не сверяются.
   */
  for (const match of text.matchAll(/(?:parseInt|Number)\((?:process\.env\.|env\.)?(MOCK_[A-Z0-9_]+)\s*(?:,\s*10\s*)?\)\s*\|\|\s*(\d+)/g)) {
    reads.add(match[1]);
    if (!defaults.has(match[1])) defaults.set(match[1], match[2]);
  }
  for (const match of text.matchAll(/parseMsOr\((?:process\.env\.|env\.)?(MOCK_[A-Z0-9_]+)\s*,\s*(\d+)\s*\)/g)) {
    reads.add(match[1]);
    if (!defaults.has(match[1])) defaults.set(match[1], match[2]);
  }

  return { reads, defaults };
}

const services = {};
for (const entry of fs.readdirSync(path.join(ROOT, 'services'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const server = `services/${entry.name}/server.js`;
  if (!exists(server)) continue;
  services[entry.name] = serverEnv(path.join(ROOT, server));
  services[entry.name].name = entry.name;
  services[entry.name].readme = `services/${entry.name}/README.md`;
}

/*
 * README описывает общие переменные ядра масками (`MOCK_SANDBOX_*`,
 * `MOCK_VTB_*` и т.п.), поэтому «описано» = точное имя или покрывающая маска.
 */
function docsCoverage(text) {
  const exact = new Set();
  const masks = [];
  for (const match of text.matchAll(/\bMOCK_[A-Z0-9_]*\*?/g)) {
    if (match[0].endsWith('*')) masks.push(match[0].slice(0, -1));
    else exact.add(match[0]);
  }
  return { exact, masks, covers: (name) => exact.has(name) || masks.some((m) => name.startsWith(m)) };
}

/* ---------- compose-файлы ---------- */

const CONTAINER_ENV = new Set([
  // Опрашивается Docker HEALTHCHECK (scripts/docker-healthcheck.js), не адаптером.
  'MOCK_HEALTH_PATH',
]);

/*
 * Разбор compose без YAML-парсера: сервисы верхнего уровня внутри `services:`,
 * ключи `environment:` и порты. Значения `${VAR:-default}` разбираются и как
 * проброс (левая часть), и как интерполяция (правая часть).
 */
function parseCompose(rel) {
  const lines = read(rel).split('\n');
  const result = { services: {}, interpolation: new Set() };
  let inServices = false;
  let current = null;
  let mode = null;

  for (const line of lines) {
    for (const match of line.matchAll(/\$\{(MOCK_[A-Z0-9_]+)/g)) {
      result.interpolation.add(match[1]);
      if (current) result.services[current].interpolation.add(match[1]);
    }

    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (/^[A-Za-z_-]+:/.test(line)) inServices = false;
    if (!inServices) continue;

    const service = line.match(/^ {2}([a-z0-9-]+):\s*$/);
    if (service) {
      current = service[1];
      result.services[current] = { env: new Map(), ports: [], interpolation: new Set() };
      mode = null;
      continue;
    }
    if (!current) continue;

    if (/^ {4}environment:\s*$/.test(line)) { mode = 'env'; continue; }
    if (/^ {4}ports:\s*$/.test(line)) { mode = 'ports'; continue; }
    const inlinePorts = line.match(/^ {4}ports:\s*\[(.*)\]\s*$/);
    if (inlinePorts) {
      mode = null;
      for (const item of inlinePorts[1].split(',')) {
        const value = item.trim().replace(/^["']|["']$/g, '');
        if (value) result.services[current].ports.push(value);
      }
      continue;
    }
    if (/^ {4}\S/.test(line)) { mode = null; }

    if (mode === 'env') {
      const key = line.match(/^ {6}(MOCK_[A-Z0-9_]+):\s*(.*)$/);
      if (key) result.services[current].env.set(key[1], key[2].trim().replace(/^["']|["']$/g, ''));
    } else if (mode === 'ports') {
      const port = line.match(/^ {6}-\s*"(.*)"/);
      if (port) result.services[current].ports.push(port[1]);
    }
  }
  return result;
}

const COMPOSES = ['docker-compose.yml', 'docker-compose.include.yml', 'docker-compose.staging.yml']
  .filter(exists)
  .map((rel) => ({ rel, ...parseCompose(rel) }));
const root = COMPOSES.find((c) => c.rel === 'docker-compose.yml');
const include = COMPOSES.find((c) => c.rel === 'docker-compose.include.yml');

/* Переменные, объявленные в любом compose/Dockerfile (контейнерная обвязка). */
const containerVars = new Set([...CONTAINER_ENV]);
for (const compose of COMPOSES) {
  for (const variable of compose.interpolation) containerVars.add(variable);
  for (const svc of Object.values(compose.services)) for (const key of svc.env.keys()) containerVars.add(key);
}
if (exists('Dockerfile')) {
  for (const match of read('Dockerfile').matchAll(/\b(MOCK_[A-Z0-9_]+)\b/g)) containerVars.add(match[1]);
}

/* ---------- известный долг и исключения ---------- */

/*
 * Переменные, которые адаптеры читают, но которые сознательно НЕ проброшены в
 * docker-compose.include.yml: include — deployment artifact потребителей, его
 * набор env меняется только решением владельца (AGENTS.md §7). Долг ведётся
 * явно и по семействам: новая переменная без include-строки и без записи здесь
 * валит проверку, а устаревшая запись (переменная уже в include) — тоже.
 * Формат: переменная → сервисы, которым её не пробросили.
 */
const KNOWN_INCLUDE_DEBT = {
  MOCK_SANDBOX_FILE: ['alfa-mock', 'atol-mock', 'kassa-mock', 'tbank-mock', 'yookassa-mock'],
  MOCK_SANDBOX_SWEEP_MS: ['alfa-mock', 'atol-mock', 'kassa-mock', 'tbank-mock', 'yookassa-mock'],
  MOCK_SANDBOX_CREATE_LIMIT: ['atol-mock', 'kassa-mock', 'tbank-mock', 'yookassa-mock'],
  MOCK_SANDBOX_RETENTION_MS: ['atol-mock', 'kassa-mock', 'tbank-mock', 'yookassa-mock'],
  MOCK_OPERATOR: ['atol-mock', 'kassa-mock'],
  MOCK_FN_NUMBER: ['atol-mock', 'kassa-mock'],
  MOCK_ECR_RN: ['atol-mock', 'kassa-mock'],
  MOCK_OFD_INN: ['atol-mock', 'kassa-mock'],
  MOCK_FNS_SITE: ['atol-mock', 'kassa-mock'],
  MOCK_AGENT_LINE: ['atol-mock'],
  MOCK_AGENT_INN: ['atol-mock'],
  MOCK_FERMA_DOWN: ['kassa-mock'],
  MOCK_FERMA_DOWN_MS: ['kassa-mock'],
  MOCK_FN_CAPACITY: ['kassa-mock'],
  MOCK_OFD_MODE: ['kassa-mock'],
};

/* Долг для конкретного сервиса: Set переменных, которые include ему не отдаёт. */
function includeDebtFor(name) {
  const debt = new Set();
  for (const [variable, names] of Object.entries(KNOWN_INCLUDE_DEBT)) {
    if (names.includes(name)) debt.add(variable);
  }
  return debt;
}

/* Сервисы, которых сознательно нет в корневом compose (источник: их README). */
const ROOT_COMPOSE_EXEMPT = {
  'kontur-ofd-mock': 'services/kontur-ofd-mock/README.md: «Корневой docker-compose.yml намеренно не меняется»',
};

/*
 * Сознательные отличия дефолта compose от литерального дефолта адаптера.
 * Публичный/стейджинг-стенд печатает чек быстрее (4 с вместо 15 с), чтобы
 * интегратор получал результат без ожидания; это конфигурация include и
 * staging, а не дрейф. Значения меняются только решением владельца
 * (include — deployment artifact потребителей, AGENTS.md §7).
 * Формат: «сервис/переменная» → причина.
 */
const COMPOSE_DEFAULT_OVERRIDE = new Map([
  ['kassa-mock/MOCK_PROCESS_MS', 'на стенде печать занимает 4 с вместо дефолтных 15 с'],
  ['atol-mock/MOCK_PROCESS_MS', 'на стенде документ обрабатывается 4 с вместо дефолтных 15 с'],
]);

/* Переменные модели угроз: обязаны быть в SECURITY.md. */
const SECURITY_VARS = [
  'MOCK_HOSTED', 'MOCK_TENANCY', 'MOCK_ADMIN_TOKEN', 'MOCK_OPERATOR_TOKEN',
  'MOCK_SANDBOX_TOKEN', 'MOCK_BLOCK_PRIVATE_WEBHOOKS', 'MOCK_STATE_FILE',
  'MOCK_SANDBOX_RETENTION_MS',
];

/* ---------- 1. env → README ---------- */

for (const [name, info] of Object.entries(services)) {
  if (!exists(info.readme)) {
    problems.push(`services/${name}: нет README.md — документация сервиса обязательна`);
    continue;
  }
  const docs = docsCoverage(read(info.readme));
  stats.readmeVars += info.reads.size;
  for (const variable of [...info.reads].sort()) {
    if (!docs.covers(variable)) {
      problems.push(`${info.readme}: ${variable} читается services/${name}/server.js, `
        + 'но не описана в env-таблице (или маске вида MOCK_PREFIX_*)');
    }
  }
}

/* ---------- 2. README → env ---------- */

for (const [name, info] of Object.entries(services)) {
  if (!exists(info.readme)) continue;
  const text = read(info.readme);
  for (const match of text.matchAll(/\bMOCK_[A-Z0-9_]+\b(?![*])/g)) {
    const variable = match[0];
    if (info.reads.has(variable)) continue;
    if (containerVars.has(variable)) continue;
    problems.push(`${info.readme}: ${variable} описана, но не читается ни сервисом, `
      + 'ни контейнерной обвязкой (compose/Dockerfile)');
  }
}

/* ---------- 3. compose → env ---------- */

for (const compose of COMPOSES) {
  for (const [service, block] of Object.entries(compose.services)) {
    const info = services[service];
    if (!info) {
      problems.push(`${compose.rel}: блок ${service} без services/${service}/server.js`);
      continue;
    }
    for (const key of block.env.keys()) {
      stats.envKeys += 1;
      if (info.reads.has(key) || CONTAINER_ENV.has(key)) continue;
      problems.push(`${compose.rel}: ${service} получает ${key}, но сервис её не читает`);
    }
  }
}

/* ---------- 4. include-покрытие ---------- */

for (const [name, info] of Object.entries(services)) {
  const declared = include?.services[name]?.env;
  if (!declared) continue; // отсутствие блока — отдельная проверка (6)
  const debt = includeDebtFor(name);
  for (const variable of [...info.reads].sort()) {
    if (declared.has(variable)) continue;
    if (debt.has(variable)) continue;
    problems.push(`docker-compose.include.yml: ${variable} читается services/${name}/server.js, `
      + 'но не проброшена потребителям и не записана в KNOWN_INCLUDE_DEBT');
  }
  for (const variable of debt) {
    if (declared.has(variable)) {
      problems.push(`scripts/check-env-parity.js: устаревшая запись KNOWN_INCLUDE_DEBT — `
        + `${name}/${variable} уже есть в docker-compose.include.yml`);
    }
  }
}

/* Долг печатается по переменным: одна строка на семейство, а не на сервис. */
for (const [variable, names] of Object.entries(KNOWN_INCLUDE_DEBT)) {
  const missing = names.filter((name) => include?.services[name]?.env
    && !include.services[name].env.has(variable));
  if (missing.length) {
    notes.push(`долг: ${variable} не проброшена в include → ${missing.sort().join(', ')}`);
  }
}

/* ---------- 5. root ⊆ include ---------- */

if (root && include) {
  for (const [service, block] of Object.entries(root.services)) {
    const target = include.services[service];
    if (!target) continue;
    for (const key of block.env.keys()) {
      if (!target.env.has(key)) {
        problems.push(`docker-compose.yml: ${service}/${key} есть в корневом compose, `
          + 'но потеряна в docker-compose.include.yml (потребители не получат значение)');
      }
    }
    for (const variable of block.interpolation) {
      if (!target.interpolation.has(variable)) {
        problems.push(`docker-compose.yml: ${service} интерполирует ${variable}, `
          + 'а в docker-compose.include.yml этой переменной нет — ремап хоста/порта разъедется');
      }
    }
  }
}

/* ---------- 6. покрытие сервисов ---------- */

for (const name of Object.keys(services)) {
  if (!include?.services[name]) {
    problems.push(`docker-compose.include.yml: нет блока для services/${name}`);
    continue;
  }
  if (!root?.services[name]) {
    if (ROOT_COMPOSE_EXEMPT[name]) continue;
    problems.push(`docker-compose.yml: нет блока для services/${name}`);
  }
}

/* ---------- 7. порты и 8. дефолты ---------- */

const usedPorts = new Map();
for (const compose of COMPOSES) {
  for (const [service, block] of Object.entries(compose.services)) {
    const info = services[service];
    if (!info) continue;
    const serverPort = info.defaults.get('MOCK_PORT');
    const envPort = block.env.get('MOCK_PORT');
    for (const published of block.ports) {
      const internal = (published.match(/:(\d+)"?$/) || [])[1];
      // `${MOCK_{SVC}_HOST_PORT:-3100}` — точка ремапа хостового порта (MS-22):
      // бинд и хост-порт задаются переменными, внутренний порт фиксирован.
      const hostPort = published.match(/\$\{(MOCK_[A-Z0-9_]+_HOST_PORT):-(\d+)\}/);
      if (serverPort && internal && internal !== serverPort) {
        problems.push(`${compose.rel}: ${service} публикует ${internal}, `
          + `а дефолт MOCK_PORT в services/${service}/server.js — ${serverPort}`);
      }
      stats.ports += 1;
      if (hostPort && internal && internal !== hostPort[2]) {
        problems.push(`${compose.rel}: ${service} публикует ${internal}, `
          + `а дефолт ${hostPort[1]} — ${hostPort[2]}`);
      }
      if (!hostPort) {
        notes.push(`отличие: ${compose.rel} · ${service} публикует порт без `
          + '${MOCK_<SVC>_HOST_PORT:-…} — ремап порта на хосте не поддержан');
      }
      if (compose.rel === 'docker-compose.yml' && serverPort) {
        if (usedPorts.has(internal)) {
          problems.push(`${compose.rel}: порт ${internal} занят двумя сервисами `
            + `(${usedPorts.get(internal)} и ${service})`);
        }
        usedPorts.set(internal, service);
      }
    }
    if (envPort) {
      const literal = envPort.match(/^"(\d+)"$/) || envPort.match(/^(\d+)$/);
      if (literal && serverPort && literal[1] !== serverPort) {
        problems.push(`${compose.rel}: ${service}/MOCK_PORT=${literal[1]}, `
          + `а дефолт в services/${service}/server.js — ${serverPort}`);
      }
    }

    for (const [key, value] of block.env) {
      const forwarded = value.match(/^\$\{MOCK_[A-Z0-9_]+:-([^}]*)\}$/);
      if (!forwarded) continue;
      const literal = forwarded[1];
      if (!literal || literal.includes('<') || literal.includes('${')) continue;
      const serverDefault = info.defaults.get(key);
      if (serverDefault) stats.defaults += 1;
      if (serverDefault && serverDefault !== literal) {
        if (COMPOSE_DEFAULT_OVERRIDE.has(`${service}/${key}`)) {
          notes.push(`отличие: ${compose.rel} · ${service}/${key} = ${literal} `
            + `(${COMPOSE_DEFAULT_OVERRIDE.get(`${service}/${key}`)})`);
          continue;
        }
        problems.push(`${compose.rel}: ${service}/${key} по умолчанию «${literal}», `
          + `а литеральный дефолт server.js — «${serverDefault}»`);
      }
    }
  }
}

/* ---------- 9. SECURITY.md ---------- */

if (exists('SECURITY.md')) {
  const security = read('SECURITY.md');
  for (const variable of SECURITY_VARS) {
    if (!security.includes(variable)) {
      problems.push(`SECURITY.md: не описана переменная модели угроз ${variable}`);
    }
  }
} else {
  problems.push('SECURITY.md отсутствует');
}

/* ---------- Итог ---------- */

if (problems.length) {
  console.error('Проблемы env-контракта (AGENTS.md §5, «правило пяти мест»):');
  for (const problem of [...new Set(problems)]) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`env OK: ${Object.keys(services).length} сервисов, `
  + `${COMPOSES.length} compose-файла; сверено ${stats.readmeVars} чтений env с README, `
  + `${stats.envKeys} ключей environment, ${stats.ports} published-портов, `
  + `${stats.defaults} литеральных дефолтов; SECURITY.md в порядке`);
for (const note of notes) console.log(`  ${note}`);
