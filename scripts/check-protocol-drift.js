#!/usr/bin/env node
// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/**
 * scripts/check-protocol-drift.js
 *
 * Детектор дрейфа протоколов (Protocol Drift Checker, спека §10):
 * сверяет декларативные манифесты протоколов (`protocols/*.json`),
 * спецификации OpenAPI 3.1 (`docs/openapi/*.openapi.json`),
 * эталонные выжимки документации (`docs/reference/**`) и фактическую
 * реализацию в `services/tbank-mock/server.js`, `services/kassa-mock/server.js`,
 * `services/atol-mock/server.js`, `services/alfa-mock/server.js` и
 * `services/sber-mock/server.js`.
 *
 * Запуск:
 *   node scripts/check-protocol-drift.js [--json]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const jsonOutput = process.argv.includes('--json');

function readText(relPath) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`Файл не найден: ${relPath}`);
  }
  return fs.readFileSync(full, 'utf8');
}

function readJson(relPath) {
  return JSON.parse(readText(relPath));
}

function main() {
  const checks = [];
  const driftIssues = [];

  function assertCheck(category, item, ok, detail = '') {
    checks.push({ category, item, ok, detail });
    if (!ok) {
      driftIssues.push({ category, item, detail });
    }
  }

  // 1. Проверка Т-Банк (tbank-eacq.json <-> server.js <-> tbank-mock.openapi.json <-> docs/reference/tbank/*)
  const tbankManifest = readJson('protocols/tbank-eacq.json');
  const tbankServerCode = readText('services/tbank-mock/server.js');
  const tbankOpenApi = readJson('docs/openapi/tbank-mock.openapi.json');

  for (const docPath of tbankManifest.upstreamDocs || []) {
    const exists = fs.existsSync(path.join(ROOT, docPath));
    assertCheck('tbank:docs', docPath, exists, exists ? 'эталонный документ найден' : 'эталонный документ отсутствует');
  }

  for (const method of tbankManifest.v2Methods || []) {
    const inServer = tbankServerCode.includes(`${method}:`);
    const inOpenApi = Boolean(tbankOpenApi.paths && tbankOpenApi.paths[`/v2/${method}`]);
    assertCheck('tbank:v2-method', `/v2/${method}`, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }

  for (const route of [
    ...(tbankManifest.e2cMethods || []),
    ...(tbankManifest.partnerRoutes || []),
    ...(tbankManifest.avRoutes || []),
    ...(tbankManifest.mockControlRoutes || []),
  ]) {
    const inServer = tbankServerCode.includes(route);
    const inOpenApi = Boolean(tbankOpenApi.paths && tbankOpenApi.paths[route]);
    assertCheck('tbank:route', route, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }

  for (const st of tbankManifest.paymentStatuses || []) {
    const inServer = tbankServerCode.includes(`'${st}'`) || tbankServerCode.includes(`"${st}"`);
    assertCheck('tbank:status', st, inServer, inServer ? 'статус поддерживается' : 'статус не найден в server.js');
  }

  for (const pan of tbankManifest.testCards || []) {
    const inServer = tbankServerCode.includes(pan);
    assertCheck('tbank:test-card', pan, inServer, inServer ? 'тестовая карта поддерживается' : 'карта не найдена в server.js');
  }

  // 2. Проверка ОФД Ферма (ferma-ofd.json <-> server.js <-> kassa-mock.openapi.json <-> docs/reference/ferma/*)
  const fermaManifest = readJson('protocols/ferma-ofd.json');
  const kassaServerCode = readText('services/kassa-mock/server.js');
  const kassaOpenApi = readJson('docs/openapi/kassa-mock.openapi.json');

  for (const docPath of fermaManifest.upstreamDocs || []) {
    const exists = fs.existsSync(path.join(ROOT, docPath));
    assertCheck('ferma:docs', docPath, exists, exists ? 'эталонный документ найден' : 'эталонный документ отсутствует');
  }

  for (const op of fermaManifest.operations || []) {
    const inServer = kassaServerCode.includes(`'${op}'`) || kassaServerCode.includes(op);
    assertCheck('ferma:operation', op, inServer, inServer ? 'операция 54-ФЗ поддерживается' : 'операция отсутствует в server.js');
  }

  for (const route of [...(fermaManifest.routes || []), ...(fermaManifest.mockControlRoutes || [])]) {
    const inOpenApi = Boolean(kassaOpenApi.paths && kassaOpenApi.paths[route]);
    const cleanNeedle = route
      .replace('/{group}/{operation}', '')
      .replace('/possystem/v1/{group}/report/{uuid}', 'report');
    const inServer = kassaServerCode.includes(cleanNeedle);
    assertCheck('ferma:route', route, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }

  for (const vat of fermaManifest.vatTypes || []) {
    const inServer = kassaServerCode.includes(`${vat}:`) || kassaServerCode.includes(`'${vat}'`);
    assertCheck('ferma:vat', vat, inServer, inServer ? 'ставка НДС поддерживается' : 'ставка НДС отсутствует в server.js');
  }

  for (const pm of fermaManifest.paymentMethods || []) {
    const inServer = kassaServerCode.includes(`'${pm}'`);
    assertCheck('ferma:payment-method', pm, inServer, inServer ? 'признак способа расчёта поддерживается' : 'отсутствует в server.js');
  }

  for (const po of fermaManifest.paymentObjects || []) {
    const inServer = kassaServerCode.includes(`'${po}'`);
    assertCheck('ferma:payment-object', po, inServer, inServer ? 'признак предмета расчёта поддерживается' : 'отсутствует в server.js');
  }

  for (const code of fermaManifest.errorCodes || []) {
    const inServer = kassaServerCode.includes(`${code}:`);
    assertCheck('ferma:error-code', String(code), inServer, inServer ? 'код ошибки в каталоге DX' : 'код ошибки не найден в каталоге');
  }

  // 3. Проверка АТОЛ Онлайн v4 (atol-online.json <-> server.js <-> atol-mock.openapi.json <-> docs/integration/atol.md)
  const atolManifest = readJson('protocols/atol-online.json');
  const atolServerCode = readText('services/atol-mock/server.js');
  const atolOpenApi = readJson('docs/openapi/atol-mock.openapi.json');
  const atolGuide = readText('docs/integration/atol.md');

  for (const docPath of atolManifest.upstreamDocs || []) {
    const exists = fs.existsSync(path.join(ROOT, docPath));
    assertCheck('atol:docs', docPath, exists, exists ? 'эталонный документ найден' : 'эталонный документ отсутствует');
  }

  for (const op of atolManifest.operations || []) {
    const inServer = atolServerCode.includes(`'${op}'`);
    const inOpenApi = JSON.stringify(atolOpenApi.paths['/possystem/v4/{group}/{operation}'] || {}).includes(op);
    assertCheck('atol:operation', op, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }

  // Именованные маршруты ищутся в server.js как подстроки: параметрические части
  // в коде — регулярные выражения, поэтому для них берётся устойчивая часть пути.
  const atolNeedle = (route) => route
    .replace('/{group}/{operation}', '')
    .replace('/possystem/v4/{group}/report/{uuid}', 'report')
    .replace('/receipts/{uuid}', '/receipts/');

  for (const route of [...(atolManifest.routes || []), ...(atolManifest.mockRoutes || [])]) {
    const needle = atolNeedle(route);
    const inServer = atolServerCode.includes(needle);
    const inOpenApi = Boolean(atolOpenApi.paths && atolOpenApi.paths[route]);
    assertCheck('atol:route', route, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }

  for (const route of atolManifest.mockControlRoutes || []) {
    const inServer = atolServerCode.includes(route);
    const inOpenApi = Boolean(atolOpenApi.paths && atolOpenApi.paths[route]);
    assertCheck('atol:control-route', route, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }

  for (const vat of atolManifest.vatTypes || []) {
    const inServer = atolServerCode.includes(`${vat}:`) || atolServerCode.includes(`'${vat}'`);
    const inOpenApi = JSON.stringify(atolOpenApi.components || {}).includes(vat);
    assertCheck('atol:vat', vat, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }

  for (const t of atolManifest.paymentTypes || []) {
    const inServer = atolServerCode.includes(`${t}:`) && atolServerCode.includes(String(t));
    assertCheck('atol:payment-type', String(t), inServer, inServer ? 'форма расчёта (ФФД 1081) поддержана' : 'отсутствует в server.js');
  }

  for (const sno of atolManifest.snoTypes || []) {
    const inServer = atolServerCode.includes(`'${sno}'`);
    assertCheck('atol:sno', sno, inServer, inServer ? 'система налогообложения поддержана' : 'отсутствует в server.js');
  }

  for (const st of atolManifest.reportStatuses || []) {
    const inServer = atolServerCode.includes(`'${st}'`);
    const inOpenApi = JSON.stringify(atolOpenApi.paths['/possystem/v4/{group}/report/{uuid}'] || {}).includes(st);
    assertCheck('atol:status', st, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }

  for (const field of atolManifest.payloadFields || []) {
    const inServer = atolServerCode.includes(`${field}:`);
    assertCheck('atol:payload-field', field, inServer, inServer ? 'поле payload формируется' : 'поля нет в payload');
  }

  for (const code of atolManifest.errorCodes || []) {
    const inServer = atolServerCode.includes(`${code}:`);
    assertCheck('atol:error-code', String(code), inServer, inServer ? 'код ошибки в каталоге DX' : 'кода нет в каталоге');
  }

  // Инварианты контракта v4, отличающие его от Ferma (kassa-mock).
  const atolInvariants = [
    ['atol:invariant', 'auth: заголовок Token (не ?token=)', atolServerCode.includes('headers.token') && !atolServerCode.includes('tokenFromUrl')],
    ['atol:invariant', `auth: TTL токена ${atolManifest.auth.tokenTtlHours} ч`, atolServerCode.includes(`${atolManifest.auth.tokenTtlHours} * 60 * 60 * 1000`)],
    ['atol:invariant', 'идемпотентность: повтор external_id возвращает прежний uuid', atolServerCode.includes('X-Mock-Replayed') && atolServerCode.includes('второй чек не создаётся')],
    ['atol:invariant', `идемпотентность: external_id до ${atolManifest.idempotency.maxLength} символов`, atolServerCode.includes(`EXTERNAL_ID_MAX = ${atolManifest.idempotency.maxLength}`)],
    ['atol:invariant', 'callback берётся из service.callback_url', atolServerCode.includes('service.callback_url') || atolServerCode.includes('service && body.service.callback_url')],
    ['atol:invariant', 'v5/маркировка вне области стенда', atolServerCode.includes('v5') && atolServerCode.includes('маркировка')],
    ['atol:invariant', 'публичные тестовые реквизиты v4 — дефолты мока', atolServerCode.includes(atolManifest.testCredentials.login) && atolServerCode.includes(atolManifest.testCredentials.group)],
  ];
  for (const [category, item, ok] of atolInvariants) {
    assertCheck(category, item, Boolean(ok), ok ? 'инвариант соблюдён' : 'инвариант нарушен в server.js');
  }

  // Рекомендации по polling из конспекта должны доехать до публичного гайда.
  const polling = atolManifest.polling || {};
  for (const [key, value] of Object.entries(polling)) {
    const inGuide = atolGuide.includes(String(value));
    assertCheck('atol:polling-guide', `${key}=${value}`, inGuide, inGuide ? 'значение есть в docs/integration/atol.md' : 'гайд не упоминает рекомендацию v4');
  }

  // 4. Проверка Альфа-Банк (alfa-eacq.json <-> server.js <-> alfa-mock.openapi.json <-> docs/integration/alfa.md)
  const alfaManifest = readJson('protocols/alfa-eacq.json');
  const alfaServerCode = readText('services/alfa-mock/server.js');
  const alfaOpenApi = readJson('docs/openapi/alfa-mock.openapi.json');
  const alfaGuide = readText('docs/integration/alfa.md');

  for (const docPath of alfaManifest.upstreamDocs || []) {
    const exists = fs.existsSync(path.join(ROOT, docPath));
    assertCheck('alfa:docs', docPath, exists, exists ? 'эталонный документ найден' : 'эталонный документ отсутствует');
  }

  for (const method of alfaManifest.restMethods || []) {
    const inServer = alfaServerCode.includes(`'${method}'`);
    const inOpenApi = Boolean(alfaOpenApi.paths && alfaOpenApi.paths[`/payment/rest/${method}`]);
    assertCheck('alfa:rest-method', `/payment/rest/${method}`, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }

  // Параметрические form-маршруты ищутся по устойчивой части пути: в коде они
  // регулярные выражения (^\/payment\/([A-Za-z0-9-]+)\/pay$ и т.п.).
  const alfaNeedle = (route) => route
    .replace('/payment/{orderId}/pay', '/pay')
    .replace('/payment/{orderId}/3ds', '/3ds')
    .replace('/payment/{orderId}', '/payment/');

  // Вынесено в функции: те же предикаты используются негативным контролем
  // синтетического «пустого» контура (PC-17) — иначе контроль проверял бы
  // не то, что реально считает чекер.
  const alfaRouteDrift = (code, openApi, manifest) => [
    ...(manifest.routes || []), ...(manifest.formRoutes || []), ...(manifest.mockRoutes || []),
  ].map((route) => ({
    route,
    inServer: code.includes(alfaNeedle(route)),
    inOpenApi: Boolean(openApi.paths && openApi.paths[route]),
  }));
  const alfaControlRouteDrift = (code, openApi, manifest) => (manifest.mockControlRoutes || [])
    .map((route) => ({
      route,
      inServer: code.includes(route),
      inOpenApi: Boolean(openApi.paths && openApi.paths[route]),
    }));
  const alfaCallbackOperations = (code, openApi, manifest) => ((manifest.callback || {}).operations || [])
    .map((op) => ({
      op,
      inServer: code.includes(`'${op}'`),
      inOpenApi: JSON.stringify((openApi.components || {}).schemas || {}).includes(op),
    }));

  for (const { route, inServer, inOpenApi } of alfaRouteDrift(alfaServerCode, alfaOpenApi, alfaManifest)) {
    assertCheck('alfa:route', route, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }

  for (const { route, inServer, inOpenApi } of alfaControlRouteDrift(alfaServerCode, alfaOpenApi, alfaManifest)) {
    assertCheck('alfa:control-route', route, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }

  for (const st of Object.keys(alfaManifest.orderStatuses || {})) {
    const inServer = alfaServerCode.includes(`${st}: '`);
    const inOpenApi = JSON.stringify((alfaOpenApi.components || {}).schemas || {}).includes(`${st} — `);
    assertCheck('alfa:order-status', st, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }

  for (const code of alfaManifest.errorCodes || []) {
    const inServer = code === 0
      ? alfaServerCode.includes('errorCode: 0')
      : alfaServerCode.includes(`${code}: {`);
    assertCheck('alfa:error-code', String(code), inServer, inServer ? 'код ошибки в каталоге DX' : 'кода нет в каталоге');
  }

  for (const { op, inServer, inOpenApi } of alfaCallbackOperations(alfaServerCode, alfaOpenApi, alfaManifest)) {
    assertCheck('alfa:callback-operation', op, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }

  for (const pan of alfaManifest.testCards || []) {
    const inServer = alfaServerCode.includes(pan);
    assertCheck('alfa:test-card', pan, inServer, inServer ? 'тестовая карта поддержана' : 'карта не найдена в server.js');
  }

  for (const actionCode of alfaManifest.actionCodes || []) {
    const inServer = alfaServerCode.includes(String(actionCode));
    assertCheck('alfa:action-code', String(actionCode), inServer, inServer ? 'шлюзовой код поддержан' : 'кода нет в server.js');
  }

  // Инварианты контракта Альфа-Банка, отличающие его от Т-Банка и ЮKassa.
  const alfaInvariants = [
    ['alfa:invariant', 'callback: HTTP GET с query-параметрами (не POST)', alfaServerCode.includes("method: 'GET'") && alfaServerCode.includes('mdOrder')],
    ['alfa:invariant', 'checksum: симметричный HMAC-SHA256, hex в верхнем регистре', alfaServerCode.includes("createHmac('sha256'") && alfaServerCode.includes('.toUpperCase()')],
    ['alfa:invariant', 'checksum-строка name;value;…; без checksum/sign_alias', alfaServerCode.includes('${name};${params[name]};') && alfaServerCode.includes("name !== 'checksum' && name !== 'sign_alias'")],
    ['alfa:invariant', 'ACK callback — ровно HTTP 200', alfaServerCode.includes('res.statusCode === 200')],
    ['alfa:invariant', 'асимметричный checksum вне области (не домысливается)', alfaServerCode.includes('асимметрич') && alfaServerCode.includes('SHA-512')],
    ['alfa:invariant', 'дефолтные креды — синтетические (не банковские)', alfaServerCode.includes(alfaManifest.testCredentials.userName) && alfaServerCode.includes('синтетич')],
    ['alfa:invariant', 'orderNumber уникален: повтор -> errorCode 1 (не replay)', alfaServerCode.includes('aerr(1,') && alfaServerCode.includes('state.orderNumbers')],
    ['alfa:invariant', 'amount — копейки, строгий парсер (F-24)', alfaServerCode.includes('parseMoneyKopeks')],
    ['alfa:invariant', 'PAN не хранится: только маска first6**last4 (F-10)', alfaServerCode.includes('maskPan') && alfaServerCode.includes('first6**last4')],
    ['alfa:invariant', 'двухстадийная схема — env-флаг MOCK_TWO_STAGE', alfaServerCode.includes('MOCK_TWO_STAGE')],
    ['alfa:invariant', `ACS-пароль тестового контура ${alfaManifest.acsPassword}`, alfaServerCode.includes(alfaManifest.acsPassword)],
    ['alfa:invariant', 'ретраи callback — mock-конфиг (PDF параметры не задаёт)', alfaServerCode.includes('MOCK_CALLBACK_RETRY_MS') && alfaServerCode.includes('MOCK_CALLBACK_MAX_ATTEMPTS')],
    ['alfa:invariant', 'errorCode=0 — не эквивалент финального статуса оплаты', alfaServerCode.includes('не эквивалент финального статуса оплаты')],
    ['alfa:invariant', 'sessionTimeoutSecs -> declinedByTimeout по виртуальным часам', alfaServerCode.includes('sessionTimeoutSecs') && alfaServerCode.includes('declinedByTimeout')],
  ];
  for (const [category, item, ok] of alfaInvariants) {
    assertCheck(category, item, Boolean(ok), ok ? 'инвариант соблюдён' : 'инвариант нарушен в server.js');
  }

  // Ключевые оговорки конспекта обязаны доехать до публичного гайда.
  const alfaGuidePoints = [
    ['register.do', 'регистрация заказа'],
    ['getOrderStatusExtended.do', 'серверная сверка статуса'],
    ['mdOrder', 'параметр callback'],
    ['HMAC-SHA256', 'алгоритм симметричного checksum'],
    ['sign_alias', 'оговорка асимметричного режима'],
    ['12345678', 'ACS-пароль тестового контура'],
    ['declinedByTimeout', 'операция отказа по таймауту'],
    ['1200', 'дефолт sessionTimeoutSecs'],
    ['ALFAMOCKTEST', 'синтетические креды стенда'],
    ['SHA-512', 'оговорка: асимметричный режим вне области'],
  ];
  for (const [needle, label] of alfaGuidePoints) {
    const inGuide = alfaGuide.includes(needle);
    assertCheck('alfa:guide-point', `${label} (${needle})`, inGuide, inGuide ? 'есть в docs/integration/alfa.md' : 'гайд не упоминает оговорку');
  }

  // PC-17 (расширение PE-09/PE-01 на alfa): блоки limits/idempotency манифеста
  // сверяются с кодом адаптера (и с гайдом интегратора там, где гайд — источник).
  const alfaLimits = alfaManifest.limits || {};
  assertCheck('alfa:limits', `sessionTimeoutSecsDefault=${alfaLimits.sessionTimeoutSecsDefault}`,
    alfaServerCode.includes(`MOCK_SESSION_TIMEOUT_SECS = '${alfaLimits.sessionTimeoutSecsDefault}'`)
      && alfaGuide.includes(String(alfaLimits.sessionTimeoutSecsDefault)),
    'дефолт sessionTimeoutSecs сходится с env-дефолтом server.js и docs/integration/alfa.md');
  assertCheck('alfa:limits', `orderNumberMaxLength=${alfaLimits.orderNumberMaxLength}`,
    alfaServerCode.includes(`ORDER_NUMBER_MAX = ${alfaLimits.orderNumberMaxLength}`)
      && alfaGuide.includes(String(alfaLimits.orderNumberMaxLength)),
    'лимит orderNumber сходится с константой server.js и гайдом');
  assertCheck('alfa:limits', `currency=${alfaLimits.currency} (только RUB)`,
    alfaServerCode.includes(`'${alfaLimits.currency}'`) && alfaServerCode.includes('RUB'),
    'валюта 643/RUB проверяется в server.js');
  const alfaIdempotency = alfaManifest.idempotency || {};
  assertCheck('alfa:idempotency', `field=${alfaIdempotency.field}: уникальность ведётся в state`,
    alfaServerCode.includes('state.orderNumbers') && alfaServerCode.includes(`'${alfaIdempotency.field}'`),
    'индекс уникальности orderNumber жив в server.js');
  assertCheck('alfa:idempotency', 'onDuplicate: errorCode 1 «уже зарегистрирован» (не replay)',
    alfaServerCode.includes('aerr(1,') && /уже зарегистрирован/.test(alfaServerCode) && alfaGuide.includes('errorCode 1'),
    'поведение повтора зафиксировано в коде и гайде');

  // PC-17: негативный контроль — синтетический «пустой» контур обязан красить
  // маршруты и callback-операции, причём диагностика указывает сторону OpenAPI
  // (именно её маскировала копипаст-подстановка значения серверной проверки).
  const emptyRoutes = alfaRouteDrift('', { paths: {} }, alfaManifest);
  assertCheck('alfa:negative-control', 'пустой синтетический server/openapi красит все маршруты манифеста',
    emptyRoutes.length > 0 && emptyRoutes.every((r) => !r.inServer && !r.inOpenApi),
    `маршрутов в контроле: ${emptyRoutes.length}`);
  const emptyCallbackOps = alfaCallbackOperations(alfaServerCode, { components: {} }, alfaManifest);
  assertCheck('alfa:negative-control', 'пустой синтетический openapi красит callback-операции (openapi=false)',
    emptyCallbackOps.length > 0 && emptyCallbackOps.every((c) => c.inServer && !c.inOpenApi),
    `операций в контроле: ${emptyCallbackOps.length}`);

  // 5. Проверка Сбербанк Ecom REST (sber-ecom.json <-> server.js <-> OpenAPI <-> guide).
  const sberManifest = readJson('protocols/sber-ecom.json');
  const sberServerCode = readText('services/sber-mock/server.js');
  const sberOpenApi = readJson('docs/openapi/sber-mock.openapi.json');
  const sberGuide = readText(sberManifest.guide || 'docs/integration/sber.md');
  const sberReadme = readText(sberManifest.readme || 'services/sber-mock/README.md');

  for (const docPath of sberManifest.upstreamDocs || []) {
    const exists = fs.existsSync(path.join(ROOT, docPath));
    assertCheck('sber:docs', docPath, exists, exists ? 'эталонный Ecom reference найден' : 'эталонный reference отсутствует');
  }

  const sberRestPrefix = '/ecomm/gw/partner/api/v1/';
  const sberRouteNeedle = (route) => {
    if (route.startsWith(sberRestPrefix)) return route.slice(sberRestPrefix.length);
    if (route === '/payment/{orderId}/pay') return 'const payMatch = p.match';
    if (route === '/payment/{orderId}/3ds') return 'const acsMatch = p.match';
    if (route === '/payment/{orderId}') return 'const formMatch = p.match';
    return route;
  };
  const sberRouteDrift = (code, openApi, manifest) => [
    ...(manifest.routes || []), ...(manifest.formRoutes || []), ...(manifest.mockRoutes || []),
  ].map((route) => ({
    route,
    inServer: code.includes(sberRouteNeedle(route)),
    inOpenApi: Boolean(openApi.paths && openApi.paths[route]),
  }));
  const sberControlRouteDrift = (code, openApi, manifest) => (manifest.mockControlRoutes || [])
    .map((route) => ({
      route,
      inServer: code.includes(route),
      inOpenApi: Boolean(openApi.paths && openApi.paths[route]),
    }));
  const sberCallbackOperations = (code, openApi, manifest) => ((manifest.callback || {}).operations || [])
    .map((op) => ({
      op,
      inServer: code.includes(`'${op}'`),
      inOpenApi: JSON.stringify((openApi.components || {}).schemas || {}).includes(op),
    }));

  for (const { route, inServer, inOpenApi } of sberRouteDrift(sberServerCode, sberOpenApi, sberManifest)) {
    assertCheck('sber:route', route, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }
  for (const { route, inServer, inOpenApi } of sberControlRouteDrift(sberServerCode, sberOpenApi, sberManifest)) {
    assertCheck('sber:control-route', route, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }

  for (const method of sberManifest.restMethods || []) {
    const inServer = sberServerCode.includes(`'${method}'`);
    const inOpenApi = Boolean(sberOpenApi.paths && sberOpenApi.paths[`${sberRestPrefix}${method}`]);
    assertCheck('sber:rest-method', `${sberRestPrefix}${method}`, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }
  for (const status of Object.keys(sberManifest.orderStatuses || {})) {
    const inServer = sberServerCode.includes(`${status}: '`);
    const inOpenApi = JSON.stringify((sberOpenApi.components || {}).schemas || {}).includes(`${status} — `);
    assertCheck('sber:order-status', status, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }
  for (const code of sberManifest.errorCodes || []) {
    const inServer = code === 0
      ? sberServerCode.includes('errorCode: 0')
      : sberServerCode.includes(`${code}: {`);
    const inOpenApi = JSON.stringify((sberOpenApi.components || {}).schemas || {}).includes('errorCode');
    assertCheck('sber:error-code', String(code), inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }
  for (const { op, inServer, inOpenApi } of sberCallbackOperations(sberServerCode, sberOpenApi, sberManifest)) {
    assertCheck('sber:callback-operation', op, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }
  for (const pan of sberManifest.testCards || []) {
    const inServer = sberServerCode.includes(pan);
    assertCheck('sber:test-card', pan, inServer, inServer ? 'официальный test fixture поддержан' : 'test card отсутствует в server.js');
  }
  for (const actionCode of sberManifest.actionCodes || []) {
    const inServer = sberServerCode.includes(String(actionCode));
    assertCheck('sber:action-code', String(actionCode), inServer, inServer ? 'код результата присутствует в адаптере' : 'actionCode отсутствует в server.js');
  }

  const sberInvariants = [
    ['sber:invariant', 'Ecom REST — POST JSON по versioned API base', sberServerCode.includes("const REST_BASE = '/ecomm/gw/partner/api/v1/'") && sberServerCode.includes("req.method !== 'POST'") && sberServerCode.includes('application/json')],
    ['sber:invariant', 'errorCode=0 не считается подтверждением оплаты', sberServerCode.includes('НЕ подтверждение оплаты') && sberServerCode.includes('orderStatus')],
    ['sber:invariant', 'orderStatus и actionCode разделены', sberServerCode.includes('orderStatus — состояние заказа') && sberServerCode.includes('actionCode — отдельный')],
    ['sber:invariant', 'callback Ecom — POST JSON без legacy checksum/signature', sberServerCode.includes("method: 'POST'") && sberServerCode.includes('legacy Secure Payments') && sberServerCode.includes("callbackSignature: 'none'") && !sberServerCode.includes('payload.checksum')],
    ['sber:invariant', 'callback ACK — строго HTTP 200', sberServerCode.includes('response.statusCode === 200')],
    ['sber:invariant', 'callback operation/status поля формируются в JSON', sberServerCode.includes('mdOrder: order.orderId') && sberServerCode.includes('operation,') && sberServerCode.includes('status,')],
    ['sber:invariant', 'SSRF_BLOCKED терминален и без retry', sberServerCode.includes('ERR SSRF_BLOCKED') && sberServerCode.includes('терминальный отказ, без повторов')],
    ['sber:invariant', 'max payment attempts = 3', sberServerCode.includes('const MAX_PAYMENT_ATTEMPTS = 3')],
    ['sber:invariant', 'virtual clock применяется к order TTL и callback schedule', sberServerCode.includes('clock.now()') && sberServerCode.includes('nextAttemptAt = clock.now() + CALLBACK_RETRY_MS')],
    ['sber:invariant', 'ACS пароль синтетический и соответствует локальному test reference', sberServerCode.includes('111111')],
    ['sber:invariant', 'дефолтные merchant-креды помечены synthetic', sberServerCode.includes(sberManifest.testCredentials.userName) && sberServerCode.includes(sberManifest.testCredentials.password) && sberServerCode.includes('СИНТЕТИЧЕСКИЕ')],
    ['sber:invariant', 'карточные данные остаются в masked форме вне ввода формы', sberServerCode.includes('function maskPan') && sberServerCode.includes('cardMask: null')],
  ];
  for (const [category, item, ok] of sberInvariants) {
    assertCheck(category, item, Boolean(ok), ok ? 'инвариант соблюдён' : 'инвариант нарушен в server.js');
  }

  for (const [needle, label] of [
    ['register.do', 'регистрация Ecom'],
    ['getOrderStatusExtended.do', 'серверная сверка'],
    ['orderStatus', 'статус заказа'],
    ['actionCode', 'отдельный actionCode'],
    ['errorCode=0', 'errorCode semantics'],
    ['dynamicCallbackUrl', 'callback URL регистрации'],
    ['HTTP 200', 'callback ACK'],
    ['111111', 'ACS-пароль'],
    ['1200', 'order TTL default'],
    ['SBERMOCKTEST', 'синтетические креды'],
    ['[VERIFY]/[FORK]', 'оговорка о неполной таблице errorCode'],
    ['legacy Secure Payments', 'исключение legacy checksum'],
  ]) {
    const inGuide = sberGuide.includes(needle);
    assertCheck('sber:guide-point', `${label} (${needle})`, inGuide, inGuide ? 'есть в docs/integration/sber.md' : 'гайд не содержит обязательную оговорку');
  }

  const sberLimits = sberManifest.limits || {};
  assertCheck('sber:limits', `sessionTimeoutSecsDefault=${sberLimits.sessionTimeoutSecsDefault}`,
    sberServerCode.includes(`DEFAULT_ORDER_TTL_SECS = ${sberLimits.sessionTimeoutSecsDefault}`)
      && sberGuide.includes(String(sberLimits.sessionTimeoutSecsDefault)),
    'TTL default совпадает в манифесте, адаптере и guide');
  assertCheck('sber:limits', `maxPaymentAttempts=${sberLimits.maxPaymentAttempts}`,
    sberServerCode.includes(`MAX_PAYMENT_ATTEMPTS = ${sberLimits.maxPaymentAttempts}`)
      && sberGuide.includes(`${sberLimits.maxPaymentAttempts} попытки оплаты`),
    'лимит попыток совпадает в манифесте, адаптере и guide');
  assertCheck('sber:limits', `callback retry=${sberLimits.callbackAttemptsDefault}×${sberLimits.callbackRetryMsDefault}ms`,
    sberServerCode.includes(`MOCK_SBER_CALLBACK_RETRY_MS = '${sberLimits.callbackRetryMsDefault}'`)
      && sberServerCode.includes(`MOCK_SBER_CALLBACK_MAX_ATTEMPTS = '${sberLimits.callbackAttemptsDefault}'`)
      && sberGuide.includes(`${sberLimits.callbackAttemptsDefault} попытки с интервалом ${sberLimits.callbackRetryMsDefault / 1000} секунд`),
    'callback schedule совпадает в manifest, server.js и guide');
  assertCheck('sber:limits', `currency=${sberLimits.currency}`,
    sberServerCode.includes(`'${sberLimits.currency}'`) && sberGuide.includes(`currency=643`),
    'только RUB/643 проверяется в адаптере и guide');

  const emptySberRoutes = sberRouteDrift('', { paths: {} }, sberManifest);
  assertCheck('sber:negative-control', 'пустой server/openapi красит все business/form/mock routes',
    emptySberRoutes.length > 0 && emptySberRoutes.every((route) => !route.inServer && !route.inOpenApi),
    `routes в негативном контроле: ${emptySberRoutes.length}`);
  const emptySberControlRoutes = sberControlRouteDrift('', { paths: {} }, sberManifest);
  assertCheck('sber:negative-control', 'пустой server/openapi красит все control routes',
    emptySberControlRoutes.length > 0 && emptySberControlRoutes.every((route) => !route.inServer && !route.inOpenApi),
    `control routes в негативном контроле: ${emptySberControlRoutes.length}`);
  const emptySberCallbackOps = sberCallbackOperations(sberServerCode, { components: {} }, sberManifest);
  assertCheck('sber:negative-control', 'пустой OpenAPI красит callback operations (server остаётся отдельно зелёным)',
    emptySberCallbackOps.length > 0 && emptySberCallbackOps.every((entry) => entry.inServer && !entry.inOpenApi),
    `callback operations в негативном контроле: ${emptySberCallbackOps.length}`);
  assertCheck('sber:readme', 'сервисный README фиксирует POST JSON, unsigned callback и ограничения',
    sberReadme.includes('application/json') && sberReadme.includes('без подписи') && sberReadme.includes('paymentOrder.do'),
    'README должен объяснять транспорт, отсутствие подписи и границы scope');

  const summary = {
    ok: driftIssues.length === 0,
    checkedAt: new Date().toISOString(),
    totalChecks: checks.length,
    passedChecks: checks.length - driftIssues.length,
    driftCount: driftIssues.length,
    driftIssues,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`\n== Protocol Drift Check (tbank-eacq + ferma-ofd + atol-online + alfa-eacq + sber-ecom) ==`);
    console.log(`Проверено инвариантов контракта: ${summary.totalChecks}, пройдено: ${summary.passedChecks}, расхождений: ${summary.driftCount}`);
    if (driftIssues.length > 0) {
      console.error('\nОбнаружены расхождения (drift):');
      for (const issue of driftIssues) {
        console.error(`  ✗ [${issue.category}] ${issue.item} — ${issue.detail}`);
      }
    } else {
      console.log('Дрейф протоколов не обнаружен ✅\n');
    }
  }

  process.exit(driftIssues.length === 0 ? 0 : 1);
}

main();
