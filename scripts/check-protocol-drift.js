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
 * конспекты провайдеров (приватный `mock-services-docs`) и фактическую
 * реализацию в `services/tbank-mock/server.js`, `services/kassa-mock/server.js`,
 * `services/atol-mock/server.js`, `services/alfa-mock/server.js`,
 * `services/sber-mock/server.js`, `services/vtb-mock/server.js`,
 * `services/first-ofd-mock/server.js`, `services/kontur-ofd-mock/server.js` и
 * `services/taxcom-mock/server.js`.
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

  // 1. Проверка Т-Банк (tbank-eacq.json <-> server.js <-> tbank-mock.openapi.json <-> конспект Т-Банка в приватном mock-services-docs)
  const tbankManifest = readJson('protocols/tbank-eacq.json');
  const tbankServerCode = readText('services/tbank-mock/server.js');
  const tbankOpenApi = readJson('docs/openapi/tbank-mock.openapi.json');

  // Конспекты upstream-доки выведены в приватный rucorp/mock-services-docs (2026-10-15);
  // проверяем provenance: путь в приватном репо или файл, оставшийся публичным.
  for (const docPath of tbankManifest.upstreamDocs || []) {
    assertCheck('tbank:docs', docPath, typeof docPath === 'string' && (docPath.startsWith('mock-services-docs/') || fs.existsSync(path.join(ROOT, docPath))), 'provenance points to private docs repo or existing public path');
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

  // 2. Проверка ОФД Ферма (ferma-ofd.json <-> server.js <-> kassa-mock.openapi.json <-> конспект Ferma в приватном mock-services-docs)
  const fermaManifest = readJson('protocols/ferma-ofd.json');
  const kassaServerCode = readText('services/kassa-mock/server.js');
  const kassaOpenApi = readJson('docs/openapi/kassa-mock.openapi.json');

  // Конспекты upstream-доки выведены в приватный rucorp/mock-services-docs (2026-10-15);
  // проверяем provenance: путь в приватном репо или файл, оставшийся публичным.
  for (const docPath of fermaManifest.upstreamDocs || []) {
    assertCheck('ferma:docs', docPath, typeof docPath === 'string' && (docPath.startsWith('mock-services-docs/') || fs.existsSync(path.join(ROOT, docPath))), 'provenance points to private docs repo or existing public path');
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

  // Конспекты upstream-доки выведены в приватный rucorp/mock-services-docs (2026-10-15);
  // проверяем provenance: путь в приватном репо или файл, оставшийся публичным.
  for (const docPath of atolManifest.upstreamDocs || []) {
    assertCheck('atol:docs', docPath, typeof docPath === 'string' && (docPath.startsWith('mock-services-docs/') || fs.existsSync(path.join(ROOT, docPath))), 'provenance points to private docs repo or existing public path');
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

  // Конспекты upstream-доки выведены в приватный rucorp/mock-services-docs (2026-10-15);
  // проверяем provenance: путь в приватном репо или файл, оставшийся публичным.
  for (const docPath of alfaManifest.upstreamDocs || []) {
    assertCheck('alfa:docs', docPath, typeof docPath === 'string' && (docPath.startsWith('mock-services-docs/') || fs.existsSync(path.join(ROOT, docPath))), 'provenance points to private docs repo or existing public path');
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

  // Конспекты upstream-доки выведены в приватный rucorp/mock-services-docs (2026-10-15);
  // проверяем provenance: путь в приватном репо или файл, оставшийся публичным.
  for (const docPath of sberManifest.upstreamDocs || []) {
    assertCheck('sber:docs', docPath, typeof docPath === 'string' && (docPath.startsWith('mock-services-docs/') || fs.existsSync(path.join(ROOT, docPath))), 'provenance points to private docs repo or existing public path');
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

  // 6. Проверка ВТБ SMB E-commerce (vtb-smb.json <-> server.js <-> OpenAPI <-> guide).
  const vtbManifest = readJson('protocols/vtb-smb.json');
  const vtbServerCode = readText('services/vtb-mock/server.js');
  const vtbOpenApi = readJson('docs/openapi/vtb-mock.openapi.json');
  const vtbGuide = readText(vtbManifest.guide || 'docs/integration/vtb.md');
  const vtbReadme = readText(vtbManifest.readme || 'services/vtb-mock/README.md');

  // Конспекты upstream-доки выведены в приватный rucorp/mock-services-docs (2026-10-15);
  // проверяем provenance: путь в приватном репо или файл, оставшийся публичным.
  for (const docPath of vtbManifest.upstreamDocs || []) {
    assertCheck('vtb:docs', docPath, typeof docPath === 'string' && (docPath.startsWith('mock-services-docs/') || fs.existsSync(path.join(ROOT, docPath))), 'provenance points to private docs repo or existing public path');
  }

  // Needle каждого маршрута — реальная строка server.js (не комментарий).
  const vtbRouteNeedle = (route) => {
    const map = {
      '/openapi/smb/efcp/e-commerce/v1/orders': 're: /^orders$/',
      '/openapi/smb/efcp/e-commerce/v1/orders/preauth': 'orders\\/preauth$',
      '/openapi/smb/efcp/e-commerce/v1/orders/complete/{orderId}': 'orders\\/complete\\/([A-Za-z0-9_.-]+)$',
      '/openapi/smb/efcp/e-commerce/v1/orders/{orderId}/cancel': '\\/cancel$/',
      '/openapi/smb/efcp/e-commerce/v1/orders/{orderId}': 'orders\\/([A-Za-z0-9_.-]+)$',
      '/openapi/smb/efcp/e-commerce/v1/refunds': 're: /^refunds$/',
      '/openapi/smb/efcp/e-commerce/v1/refunds/{refundId}': 'refunds\\/([A-Za-z0-9_.-]+)$',
      '/pay/{orderId}/pay': 'const paySubmitMatch',
      '/pay/{orderId}': 'const payMatch',
    };
    return map[route] || route;
  };
  const vtbRouteDrift = (code, openApi, manifest) => [
    ...(manifest.routes || []), ...(manifest.formRoutes || []), ...(manifest.mockRoutes || []),
  ].map((route) => ({
    route,
    inServer: code.includes(vtbRouteNeedle(route)),
    inOpenApi: Boolean(openApi.paths && openApi.paths[route]),
  }));
  const vtbControlRouteDrift = (code, openApi, manifest) => (manifest.mockControlRoutes || [])
    .map((route) => ({
      route,
      inServer: code.includes(route),
      inOpenApi: Boolean(openApi.paths && openApi.paths[route]),
    }));

  for (const { route, inServer, inOpenApi } of vtbRouteDrift(vtbServerCode, vtbOpenApi, vtbManifest)) {
    assertCheck('vtb:route', route, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }
  for (const { route, inServer, inOpenApi } of vtbControlRouteDrift(vtbServerCode, vtbOpenApi, vtbManifest)) {
    assertCheck('vtb:control-route', route, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }
  {
    const tokenRoute = vtbManifest.tokenRoute || '/passport/oauth2/token';
    assertCheck('vtb:token-route', tokenRoute,
      vtbServerCode.includes(`TOKEN_PATH = '${tokenRoute}'`) && Boolean(vtbOpenApi.paths && vtbOpenApi.paths[tokenRoute]),
      'token endpoint присутствует в server.js и OpenAPI');
    assertCheck('vtb:token-route', `POST ${tokenRoute} — form-urlencoded client_credentials`,
      vtbServerCode.includes('client_credentials') && vtbServerCode.includes('application/x-www-form-urlencoded'),
      'token endpoint принимает grant_type=client_credentials form-urlencoded');
  }

  for (const status of Object.keys(vtbManifest.orderStatuses || {})) {
    const inServer = vtbServerCode.includes(`${status}: '`);
    const inOpenApi = JSON.stringify((vtbOpenApi.components || {}).schemas || {}).includes(`${status} — `);
    assertCheck('vtb:order-status', status, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }
  for (const status of Object.keys(vtbManifest.operationStatuses || {})) {
    const inServer = vtbServerCode.includes(`${status}: '`);
    const inOpenApi = JSON.stringify((vtbOpenApi.components || {}).schemas || {}).includes(`${status} — `);
    assertCheck('vtb:operation-status', status, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }
  for (const type of (vtbManifest.callback || {}).types || []) {
    const inServer = vtbServerCode.includes(`'${type}'`);
    const inOpenApi = JSON.stringify((vtbOpenApi.components || {}).schemas || {}).includes(type);
    assertCheck('vtb:callback-type', type, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }
  for (const pan of vtbManifest.testCards || []) {
    const inServer = vtbServerCode.includes(pan);
    assertCheck('vtb:test-card', pan, inServer, inServer ? 'синтетическая [FORK]-карта поддерживается' : 'карта не найдена в server.js');
  }
  for (const code of vtbManifest.errorCodes || []) {
    const inServer = vtbServerCode.includes(`'${code}'`);
    const inOpenApi = JSON.stringify((vtbOpenApi.components || {}).schemas || {}).includes(code);
    assertCheck('vtb:error-code', code, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }

  const vtbInvariants = [
    ['vtb:invariant', 'SMB REST — JSON на versioned base /openapi/smb/efcp/e-commerce/v1/', vtbServerCode.includes("const REST_BASE = '/openapi/smb/efcp/e-commerce/v1/'") && vtbServerCode.includes('application/json')],
    ['vtb:invariant', 'OAuth2 client_credentials на отдельном token endpoint, обновление по expires_in', vtbServerCode.includes("TOKEN_PATH = '/passport/oauth2/token'") && vtbServerCode.includes('expires_in') && vtbServerCode.includes('client_credentials')],
    ['vtb:invariant', 'X-IBM-Client-Id — lowercase, без @ext.vtb.ru, только на API', vtbServerCode.includes('x-ibm-client-id') && vtbServerCode.includes('@ext.vtb.ru') && vtbServerCode.includes('toLowerCase')],
    ['vtb:invariant', 'amount.value — десятичные рубли, не копейки', vtbServerCode.includes('parseAmountRubles') && vtbServerCode.includes('ДЕСЯТИЧНЫЕ')],
    ['vtb:invariant', 'status.value ордера и операции разделены (не смешивать)', vtbServerCode.includes('ORDER_STATUSES') && vtbServerCode.includes('OPERATION_STATUSES') && vtbServerCode.includes('своём уровне')],
    ['vtb:invariant', 'callback payload сохраняется как есть: Status/status не нормализуются', vtbServerCode.includes("[lower ? 'status' : 'Status']") && vtbServerCode.includes('регистр ключа')],
    ['vtb:invariant', 'подпись/ACK не выдумываются: 2xx — локальный [FORK], signature none', vtbServerCode.includes("callbackSignature: 'none'") && vtbServerCode.includes('2xx') && vtbServerCode.includes('[FORK')],
    ['vtb:invariant', 'SSRF_BLOCKED терминален и без retry', vtbServerCode.includes('ERR SSRF_BLOCKED') && vtbServerCode.includes('терминальный отказ, без повторов')],
    ['vtb:invariant', 'token TTL живёт на виртуальных часах (expiresIn → expiresAtMs)', vtbServerCode.includes('TOKEN_TTL_DEFAULT_SECS = 170') && vtbServerCode.includes('expiresAtMs: now + TOKEN_TTL_SECS * 1000')],
    ['vtb:invariant', 'ордер живёт 20 минут (expire с tz/мс)', vtbServerCode.includes('ORDER_TTL_DEFAULT_SECS = 1200') && vtbServerCode.includes('toISOString()')],
    ['vtb:invariant', 'orderId идемпотентен (X-Mock-Replayed), дубль refundId — ошибка', vtbServerCode.includes('X-Mock-Replayed') && vtbServerCode.includes('duplicate_refund_id')],
    ['vtb:invariant', 'complete ≤ авторизации; refund ≤ списания', vtbServerCode.includes('превышает авторизацию') && vtbServerCode.includes('превышает остаток списания')],
    ['vtb:invariant', 'legacy RBS (payment/rest, *.do) не используется', !vtbServerCode.includes('/payment/rest/') && !vtbServerCode.includes('register.do')],
    ['vtb:invariant', 'дефолтные client_id/clientSecret помечены synthetic', vtbServerCode.includes(vtbManifest.testCredentials.clientId) && vtbServerCode.includes(vtbManifest.testCredentials.clientSecret) && vtbServerCode.includes('СИНТЕТИЧЕСКИЕ')],
    ['vtb:invariant', 'карточные данные остаются в masked форме', vtbServerCode.includes('function maskPan') && vtbServerCode.includes('cardMask')],
  ];
  for (const [category, item, ok] of vtbInvariants) {
    assertCheck(category, item, Boolean(ok), ok ? 'инвариант соблюдён' : 'инвариант нарушен в server.js');
  }

  for (const [needle, label] of [
    ['client_credentials', 'OAuth grant'],
    ['X-IBM-Client-Id', 'заголовок клиента'],
    ['@ext.vtb.ru', 'нормализация client_id'],
    ['expires_in', 'обновление токена'],
    ['10.56', 'десятичные рубли'],
    ['payUrl', 'страница оплаты'],
    ['twoStageParams', 'preauth'],
    ['cancelReason', 'отмена ордера'],
    ['duplicate_refund_id', 'дубль refundId'],
    ['GET /orders/{orderId}', 'GET-сверка'],
    ['4111', 'истёкшая официальная карта'],
    ['vtb.rbsuat.com', 'исключение legacy RBS'],
    ['qr-efcp.bankingapi.ru', 'СБП вне области'],
    ['[FORK]', 'мок-карты/ошибки'],
    ['[VERIFY]', 'неполные места среза'],
    ['170', 'token TTL default'],
    ['1200', 'order TTL default'],
  ]) {
    const inGuide = vtbGuide.includes(needle);
    assertCheck('vtb:guide-point', `${label} (${needle})`, inGuide, inGuide ? 'есть в docs/integration/vtb.md' : 'гайд не содержит обязательную оговорку');
  }

  const vtbLimits = vtbManifest.limits || {};
  assertCheck('vtb:limits', `tokenTtlSecsDefault=${vtbLimits.tokenTtlSecsDefault}`,
    vtbServerCode.includes(`TOKEN_TTL_DEFAULT_SECS = ${vtbLimits.tokenTtlSecsDefault}`)
      && vtbGuide.includes(String(vtbLimits.tokenTtlSecsDefault)),
    'TTL токена совпадает в манифесте, адаптере и guide');
  assertCheck('vtb:limits', `orderTtlSecsDefault=${vtbLimits.orderTtlSecsDefault}`,
    vtbServerCode.includes(`ORDER_TTL_DEFAULT_SECS = ${vtbLimits.orderTtlSecsDefault}`)
      && vtbGuide.includes(String(vtbLimits.orderTtlSecsDefault)),
    'TTL ордера совпадает в манифесте, адаптере и guide');
  assertCheck('vtb:limits', `callback retry=${vtbLimits.callbackAttemptsDefault}×${vtbLimits.callbackRetryMsDefault}ms`,
    vtbServerCode.includes(`MOCK_VTB_CALLBACK_RETRY_MS = '${vtbLimits.callbackRetryMsDefault}'`)
      && vtbServerCode.includes(`MOCK_VTB_CALLBACK_MAX_ATTEMPTS = '${vtbLimits.callbackAttemptsDefault}'`)
      && vtbGuide.includes(`${vtbLimits.callbackAttemptsDefault} попытки`),
    'callback schedule совпадает в manifest, server.js и guide');
  assertCheck('vtb:limits', `currency=${vtbLimits.currency}`,
    vtbServerCode.includes(`'${vtbLimits.currency}'`) && vtbGuide.includes('RUB'),
    'только RUB проверяется в адаптере и guide');

  const vtbIdempotency = vtbManifest.idempotency || {};
  assertCheck('vtb:idempotency', 'orders: повтор orderId возвращает существующий ордер',
    vtbServerCode.includes('X-Mock-Replayed') && vtbGuide.includes('идемпотентен'),
    'идемпотентность orderId закреплена в коде и guide');
  assertCheck('vtb:idempotency', 'refunds: повторный refundId — provider-shaped ошибка',
    vtbServerCode.includes('duplicate_refund_id') && vtbGuide.includes('duplicate_refund_id'),
    'контраст orderId/refundId закреплён в коде и guide');
  assertCheck('vtb:callback-quirk', `statusKeyQuirk: Status у платежа, status у возврата`,
    vtbServerCode.includes("[lower ? 'status' : 'Status']") && vtbGuide.includes('Status') && vtbGuide.includes('нормализ'),
    'quirk ключей статуса зафиксирован в адаптере и guide');

  const emptyVtbRoutes = vtbRouteDrift('', { paths: {} }, vtbManifest);
  assertCheck('vtb:negative-control', 'пустой server/openapi красит все business/form/mock routes',
    emptyVtbRoutes.length > 0 && emptyVtbRoutes.every((route) => !route.inServer && !route.inOpenApi),
    `routes в негативном контроле: ${emptyVtbRoutes.length}`);
  const emptyVtbControlRoutes = vtbControlRouteDrift('', { paths: {} }, vtbManifest);
  assertCheck('vtb:negative-control', 'пустой server/openapi красит все control routes',
    emptyVtbControlRoutes.length > 0 && emptyVtbControlRoutes.every((route) => !route.inServer && !route.inOpenApi),
    `control routes в негативном контроле: ${emptyVtbControlRoutes.length}`);
  const emptyVtbOpenApi = { components: {} };
  const emptyVtbCallbackTypes = ((vtbManifest.callback || {}).types || [])
    .map((type) => ({ type, inServer: vtbServerCode.includes(`'${type}'`), inOpenApi: JSON.stringify((emptyVtbOpenApi.components || {}).schemas || {}).includes(type) }));
  assertCheck('vtb:negative-control', 'пустой OpenAPI красит callback types (server остаётся отдельно зелёным)',
    emptyVtbCallbackTypes.length > 0 && emptyVtbCallbackTypes.every((entry) => entry.inServer && !entry.inOpenApi),
    `callback types в негативном контроле: ${emptyVtbCallbackTypes.length}`);
  assertCheck('vtb:readme', 'сервисный README фиксирует OAuth/JSON, Status-status quirk и границы legacy',
    vtbReadme.includes('client_credentials') && vtbReadme.includes('Status') && vtbReadme.includes('legacy'),
    'README должен объяснять авторизацию, quirk статусов и границы scope');

  // 7. Проверка Первого ОФД — облачная касса OKassa (first-ofd-okassa.json <-> server.js <-> OpenAPI <-> guide).
  const firstOfdManifest = readJson('protocols/first-ofd-okassa.json');
  const firstOfdServerCode = readText('services/first-ofd-mock/server.js');
  const firstOfdOpenApi = readJson('docs/openapi/first-ofd-mock.openapi.json');
  const firstOfdGuide = readText(firstOfdManifest.guide || 'docs/integration/first-ofd.md');
  const firstOfdReadme = readText(firstOfdManifest.readme || 'services/first-ofd-mock/README.md');
  const firstOfdSchemas = JSON.stringify((firstOfdOpenApi.components || {}).schemas || {});
  const firstOfdPaths = JSON.stringify(firstOfdOpenApi.paths || {});

  // Конспекты upstream-доки выведены в приватный rucorp/mock-services-docs (2026-10-15);
  // проверяем provenance: путь в приватном репо или файл, оставшийся публичным.
  for (const docPath of firstOfdManifest.upstreamDocs || []) {
    assertCheck('first-ofd:docs', docPath, typeof docPath === 'string' && (docPath.startsWith('mock-services-docs/') || fs.existsSync(path.join(ROOT, docPath))), 'provenance points to private docs repo or existing public path');
  }

  // Needle каждого маршрута — реальная строка server.js (не комментарий и не ссылка на docs).
  const firstOfdRouteNeedle = (route) => {
    const map = {
      '/api/external/queue/v1/transaction/{type}': 'rel.match(/^transaction\\/([^/]+)$/)',
      '/api/external/queue/v1/transaction/{requestId}': "matched.name === 'transaction-read'",
      '/api/external/queue/v1/status/{requestId}': "matched.name === 'status-read'",
      '/api/external/queue/v1/statuses': "rel === 'statuses'",
      '/api/external/receipts': 'p === RECEIPTS_PATH',
    };
    return map[route] || route;
  };
  const firstOfdRouteDrift = (code, openApi, manifest) => [
    ...(manifest.routes || []), ...(manifest.mockRoutes || []),
  ].map((route) => ({
    route,
    inServer: code.includes(firstOfdRouteNeedle(route)),
    inOpenApi: Boolean(openApi.paths && openApi.paths[route]),
  }));
  const firstOfdControlRouteDrift = (code, openApi, manifest) => (manifest.mockControlRoutes || [])
    .map((route) => ({
      route,
      inServer: code.includes(route),
      inOpenApi: Boolean(openApi.paths && openApi.paths[route]),
    }));

  for (const { route, inServer, inOpenApi } of firstOfdRouteDrift(firstOfdServerCode, firstOfdOpenApi, firstOfdManifest)) {
    assertCheck('first-ofd:route', route, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }
  for (const { route, inServer, inOpenApi } of firstOfdControlRouteDrift(firstOfdServerCode, firstOfdOpenApi, firstOfdManifest)) {
    assertCheck('first-ofd:control-route', route, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }
  {
    const tokenRoute = firstOfdManifest.tokenRoute || '/getToken';
    assertCheck('first-ofd:token-route', tokenRoute,
      firstOfdServerCode.includes(`TOKEN_PATH = '${tokenRoute}'`) && Boolean(firstOfdOpenApi.paths && firstOfdOpenApi.paths[tokenRoute]),
      'token endpoint присутствует в server.js и OpenAPI');
    assertCheck('first-ofd:token-route', 'POST /getToken — JSON charset=utf-8, {login,pass} → {token}',
      firstOfdServerCode.includes('application/json; charset=utf-8') && firstOfdServerCode.includes("  login:")
        && firstOfdServerCode.includes("pass") && firstOfdServerCode.includes('token'),
      'getToken принимает JSON-тело login+pass и отдаёт token');
    assertCheck('first-ofd:token-route', 'бизнес-вызовы — Authorization: Bearer, API-ключ UUID не bearer',
      firstOfdServerCode.includes('Authorization') && firstOfdServerCode.includes('API-ключ')
        && firstOfdGuide.includes('Bearer') && firstOfdGuide.includes('API-ключ'),
      'Bearer выдаёт getToken; ключ UUID сам по себе не токен');
  }

  for (const type of Object.keys(firstOfdManifest.transactionTypes || {})) {
    const inServer = firstOfdServerCode.includes('TRANSACTION_TYPES') && firstOfdServerCode.includes(`  ${type}: '`);
    const inOpenApi = firstOfdSchemas.includes(`"${type}"`) || firstOfdPaths.includes(`"${type}"`);
    assertCheck('first-ofd:transaction-type', type, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }
  for (const operation of Object.keys(firstOfdManifest.operations || {})) {
    const inServer = firstOfdServerCode.includes(`  ${operation}: '`);
    const inOpenApi = firstOfdSchemas.includes(`"${operation}"`);
    assertCheck('first-ofd:operation', operation, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }
  assertCheck('first-ofd:operation-spelling', 'EXPENCE/EXPENCE_RETURN — как в схеме, EXPENSE отклоняется',
    firstOfdServerCode.includes("EXPENCE: '") && firstOfdServerCode.includes("EXPENCE_RETURN: '")
      && !firstOfdServerCode.includes("EXPENSE: '") && firstOfdServerCode.includes('invalid_operation_type')
      && firstOfdGuide.includes('invalid_operation_type'),
    'написание операций не нормализуется: вариант EXPENSE — provider-shaped отказ');
  for (const vat of firstOfdManifest.vatCodes || []) {
    const inServer = firstOfdServerCode.includes(`  ${vat}: '`);
    const inOpenApi = firstOfdSchemas.includes(`"${vat}"`);
    assertCheck('first-ofd:vat-code', vat, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }
  for (const status of Object.keys(firstOfdManifest.queueStatuses || {})) {
    const inServer = firstOfdServerCode.includes(`  ${status}: '`);
    const inOpenApi = firstOfdSchemas.includes(`"${status}"`);
    assertCheck('first-ofd:queue-status', status, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }
  for (const layer of Object.keys(firstOfdManifest.errorLayers || {})) {
    const inServer = firstOfdServerCode.includes(`  ${layer}: '`) && firstOfdServerCode.includes('ERROR_LAYERS');
    const inOpenApi = firstOfdSchemas.includes(`"${layer}"`);
    assertCheck('first-ofd:error-layer', layer, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }
  for (const [layerName, codes] of Object.entries(firstOfdManifest.resultLayerCodes || {})) {
    for (const code of codes) {
      const inServer = (layerName === 'kkt' ? firstOfdServerCode.includes('KKT_ERROR_CODES') : firstOfdServerCode.includes('API_ERROR_CODES'))
        && firstOfdServerCode.includes(`  ${code}: '`);
      const inOpenApi = firstOfdSchemas.includes(`"${code}"`);
      assertCheck('first-ofd:result-code', `${layerName}/${code}`, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
    }
  }
  for (const code of firstOfdManifest.errorCodes || []) {
    const inServer = firstOfdServerCode.includes(`'${code}'`);
    const inOpenApi = firstOfdSchemas.includes(`"${code}"`);
    assertCheck('first-ofd:error-code', code, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }

  const firstOfdCallback = firstOfdManifest.callback || {};
  assertCheck('first-ofd:callback', 'подпись не выдумывается: signature=none, нет HMAC/RSA',
    firstOfdCallback.signature === 'none' && firstOfdServerCode.includes("callbackSignature: 'none'")
      && !/createHmac|createSign|RSA-SHA/.test(firstOfdServerCode)
      && firstOfdGuide.includes('без подписи'),
    'мок не добавляет подпись/checksum, которых нет в публичном срезе');
  assertCheck('first-ofd:callback', 'исходящий webhook firstOfdCallback зафиксирован в OpenAPI',
    Boolean((firstOfdOpenApi.webhooks || {}).firstOfdCallback) && firstOfdSchemas.includes('CallbackEnvelope'),
    'webhooks.firstOfdCallback + CallbackEnvelope присутствуют');
  assertCheck('first-ofd:callback', 'ACK 2xx и расписание повторов помечены mock-local [FORK]',
    firstOfdServerCode.includes('[FORK') && firstOfdGuide.includes('[FORK]') && firstOfdServerCode.includes('2xx'),
    'локальные правила ACK/retry честно помечены [FORK]');
  assertCheck('first-ofd:callback', 'SSRF_BLOCKED терминален и без повторов',
    firstOfdServerCode.includes('SSRF_BLOCKED') && firstOfdServerCode.includes('терминальн'),
    'приватный callbackUrl даёт терминальный отказ');
  assertCheck('first-ofd:callback', 'доставка через очередь ядра, сверка через status/{requestId}',
    firstOfdServerCode.includes('createDeliveryQueue') && firstOfdGuide.includes('status/{requestId}'),
    'callback — не единственный источник истины');

  const firstOfdInvariants = [
    ['first-ofd:invariant', 'getToken — JSON charset=utf-8, {login,pass} → {token}, TTL 24 ч на виртуальных часах',
      firstOfdServerCode.includes('application/json; charset=utf-8') && firstOfdServerCode.includes('TOKEN_TTL_DEFAULT_SECS = 86400')
        && firstOfdServerCode.includes('X-Mock-Token-Expires-At') && firstOfdServerCode.includes('clock.now()')],
    ['first-ofd:invariant', 'бизнес-вызовы — Authorization: Bearer из getToken, а не API-ключ UUID',
      firstOfdServerCode.includes('Authorization') && firstOfdServerCode.includes('API-ключ') && firstOfdServerCode.includes('invalid_token')],
    ['first-ofd:invariant', 'очередь асинхронная: POST transaction/{type} → requestId, результат только методом статуса',
      firstOfdServerCode.includes('function handleCreateTransaction') && firstOfdServerCode.includes('function handleGetStatus')
        && firstOfdServerCode.includes('function handleGetTransaction')],
    ['first-ofd:invariant', 'схемы строго по типу: receipt-тело в сменах отклоняется (StateCommandRequest)',
      firstOfdServerCode.includes('StateCommandRequest') && firstOfdServerCode.includes('Document с operationType/items/totalSum'),
      ],
    ['first-ofd:invariant', 'обязательные поля чека: cashboxParameters.userInn, requestMetadata.userGroup, document.operationType|items|totalSum',
      firstOfdServerCode.includes('userInn') && firstOfdServerCode.includes('userGroup') && firstOfdServerCode.includes('totalSum')],
    ['first-ofd:invariant', 'document.items — массив Item (расхождение №2 трактуется в пользу OpenAPI)',
      firstOfdServerCode.includes('document.items должен быть МАССИВОМ') && firstOfdGuide.includes('массив')],
    ['first-ofd:invariant', 'оба слоя ошибок разделяются: errorType=API|KKT с errorCode/details',
      firstOfdServerCode.includes('ERROR_LAYERS') && firstOfdServerCode.includes('KKT_ERROR_CODES')
        && firstOfdServerCode.includes('API_ERROR_CODES') && firstOfdServerCode.includes('errorType')],
    ['first-ofd:invariant', 'результат заявки несёт requestId/transactionType/errorCode/errorType/details/payload',
      ['requestId', 'transactionType', 'errorCode', 'errorType', 'details', 'payload'].every((key) => firstOfdServerCode.includes(key))],
    ['first-ofd:invariant', 'externalId не обещает идемпотентность: повтор помечается X-Mock-Duplicate-External-Id ([VERIFY])',
      firstOfdServerCode.includes('X-Mock-Duplicate-External-Id') && firstOfdGuide.includes('дедупликац')
        && firstOfdManifest.idempotency.externalId.includes('НЕ подтверждены')],
    ['first-ofd:invariant', 'суммы — десятичные рубли (не копейки), сверка totalSum только предупреждает',
      firstOfdServerCode.includes('ДЕСЯТИЧНЫЕ') && firstOfdGuide.includes('десятичные')],
    ['first-ofd:invariant', 'SSRF-политика callback — общая для стенда (MOCK_BLOCK_PRIVATE_WEBHOOKS)',
      firstOfdServerCode.includes('MOCK_BLOCK_PRIVATE_WEBHOOKS') && firstOfdServerCode.includes('createDeliveryQueue')],
    ['first-ofd:invariant', 'per-sandbox изоляция заявок/смен/сценариев (X-Mock-Sandbox)',
      firstOfdServerCode.includes('X-Mock-Sandbox') && firstOfdServerCode.includes('sandboxRuntime')],
    ['first-ofd:invariant', 'виртуальные часы, сценарии, chaos и журнал подключены из core',
      firstOfdServerCode.includes('core.createVirtualClock') && firstOfdServerCode.includes('createScenarioRegistry')
        && firstOfdServerCode.includes('applyRequestChaos') && firstOfdServerCode.includes("'/mock/time'")
        && firstOfdServerCode.includes('journal.record')],
    ['first-ofd:invariant', 'control-plane fail-closed в hosted (checkControlAccess)',
      firstOfdServerCode.includes('checkControlAccess') && firstOfdServerCode.includes('hosted-fail-closed')],
    ['first-ofd:invariant', 'дефолтные креды синтетические и маскируются в логе/ответах',
      firstOfdServerCode.includes('DEFAULT_LOGIN') && firstOfdServerCode.includes('DEFAULT_PASS') && firstOfdServerCode.includes('maskPiiValue')],
    ['first-ofd:invariant', 'чужой контракт не подмешивается: нет form-urlencoded, ATOL/Ferma-маршрутов',
      !firstOfdServerCode.includes('application/x-www-form-urlencoded') && !firstOfdServerCode.includes('atol-online')
        && !firstOfdServerCode.includes("'/v4/")],
  ];
  for (const [category, item, ok] of firstOfdInvariants) {
    assertCheck(category, item, Boolean(ok), ok ? 'инвариант соблюдён' : 'инвариант нарушен в server.js');
  }

  for (const [needle, label] of [
    ['application/json; charset=utf-8', 'JSON-транспорт getToken'],
    ['Bearer', 'авторизация бизнес-вызовов'],
    ['requestId', 'заявка вместо синхронного результата'],
    ['IN_PROGRESS', 'статус обработки'],
    ['COMPLETED', 'успешный результат'],
    ['EXPENCE', 'написание операций как в схеме'],
    ['VAT_22', 'подтверждённые ставки НДС'],
    ['statuses', 'сверка по externalId+groupId'],
    ['externalId', 'ключ сверки'],
    ['/api/external/receipts', 'документы за период'],
    ['86400', 'TTL токена 24 ч'],
    ['callbackUrl', 'адрес уведомления из заявки'],
    ['SSRF', 'политика приватных адресов'],
    ['[VERIFY]', 'незакрытые места среза'],
    ['[FORK]', 'локальные решения мока'],
    ['correctionCause', 'чек коррекции'],
    ['StateCommandRequest', 'смены и отчёт'],
    ['3107', 'порт стенда'],
  ]) {
    const inGuide = firstOfdGuide.includes(needle);
    assertCheck('first-ofd:guide-point', `${label} (${needle})`, inGuide, inGuide ? 'есть в docs/integration/first-ofd.md' : 'гайд не содержит обязательную оговорку');
  }

  const firstOfdLimits = firstOfdManifest.limits || {};
  assertCheck('first-ofd:limits', `tokenTtlSecsDefault=${firstOfdLimits.tokenTtlSecsDefault}`,
    firstOfdServerCode.includes(`TOKEN_TTL_DEFAULT_SECS = ${firstOfdLimits.tokenTtlSecsDefault}`)
      && firstOfdGuide.includes(String(firstOfdLimits.tokenTtlSecsDefault)),
    'TTL токена совпадает в манифесте, адаптере и guide');
  assertCheck('first-ofd:limits', `processMsDefault=${firstOfdLimits.processMsDefault}`,
    firstOfdServerCode.includes(`PROCESS_DEFAULT_MS = ${firstOfdLimits.processMsDefault}`)
      && firstOfdGuide.includes(String(firstOfdLimits.processMsDefault)),
    'задержка очереди совпадает в манифесте, адаптере и guide');
  assertCheck('first-ofd:limits', `callback retry=${firstOfdLimits.callbackAttemptsDefault}×${firstOfdLimits.callbackRetryMsDefault}ms`,
    firstOfdServerCode.includes(`CALLBACK_RETRY_MS_DEFAULT = ${firstOfdLimits.callbackRetryMsDefault}`)
      && firstOfdServerCode.includes(`CALLBACK_MAX_ATTEMPTS_DEFAULT = ${firstOfdLimits.callbackAttemptsDefault}`)
      && firstOfdGuide.includes(`${firstOfdLimits.callbackAttemptsDefault} попытки`)
      && firstOfdGuide.includes(`${firstOfdLimits.callbackRetryMsDefault / 1000} секунд`),
    'callback schedule совпадает в manifest, server.js и guide (mock-local [FORK])');
  assertCheck('first-ofd:limits', `receipts pageSize=${firstOfdLimits.receiptsPageSizeDefault}/${firstOfdLimits.receiptsPageSizeMax}`,
    firstOfdServerCode.includes(`RECEIPTS_PAGE_SIZE_DEFAULT = ${firstOfdLimits.receiptsPageSizeDefault}`)
      && firstOfdServerCode.includes(`RECEIPTS_PAGE_SIZE_MAX = ${firstOfdLimits.receiptsPageSizeMax}`)
      && firstOfdGuide.includes('pageSize') && firstOfdGuide.includes(String(firstOfdLimits.receiptsPageSizeMax)),
    'пагинация /receipts совпадает в манифесте, адаптере и guide');
  assertCheck('first-ofd:limits', `maxItemsPerReceipt=${firstOfdLimits.maxItemsPerReceipt}`,
    firstOfdServerCode.includes(`MAX_ITEMS = ${firstOfdLimits.maxItemsPerReceipt}`)
      && firstOfdGuide.includes(String(firstOfdLimits.maxItemsPerReceipt)),
    'safety cap позиций чека совпадает с guide');

  assertCheck('first-ofd:idempotency', 'externalId: повтор даёт новую заявку, идемпотентность не обещана',
    firstOfdServerCode.includes('X-Mock-Duplicate-External-Id') && firstOfdGuide.includes('X-Mock-Duplicate-External-Id')
      && firstOfdGuide.includes('[VERIFY]'),
    'поведение детерминировано и помечено [VERIFY]');
  assertCheck('first-ofd:idempotency', 'requestId — ключ transaction/{requestId} и status/{requestId}',
    firstOfdServerCode.includes('function handleGetTransaction') && firstOfdServerCode.includes('function handleGetStatus')
      && firstOfdGuide.includes('transaction/{requestId}'),
    'выданный requestId остаётся ключом сверки');

  const firstOfdDivergencePoints = [
    ['№1 requestMetadata: required в OpenAPI vs необязательное в manual',
      firstOfdGuide.includes('requestMetadata') && firstOfdGuide.includes('[VERIFY]') && firstOfdServerCode.includes('userGroup')],
    ['№2 document.items: массив в OpenAPI vs объект в таблице manual',
      firstOfdGuide.includes('массив') && firstOfdGuide.includes('№2')],
    ['№3 callbackUrl: http:// в PDF vs https:// в примерах',
      firstOfdGuide.includes('http://') && firstOfdGuide.includes('https://')
        && firstOfdGuide.includes('MOCK_FIRST_OFD_CALLBACK_HTTPS_ONLY')],
    ['№4 getToken: error с кодом 0 в «успешном» примере',
      firstOfdGuide.includes('Неверный логин и пароль') && firstOfdGuide.includes('getToken-error-quirk')],
    ['№5 тег ATOL Online V5 тестового swagger — вне области',
      firstOfdGuide.includes('V5') && (firstOfdManifest.outOfScope || []).some((item) => item.includes('ATOL Online V5'))],
  ];
  assertCheck('first-ofd:divergence', 'манифест фиксирует 5 расхождений среза',
    (firstOfdManifest.divergences || []).length === 5,
    `divergences=${(firstOfdManifest.divergences || []).length}`);
  for (const [item, ok] of firstOfdDivergencePoints) {
    assertCheck('first-ofd:divergence', item, Boolean(ok), ok ? 'расхождение помечено [VERIFY]/вне области' : 'расхождение не задокументировано');
  }

  const emptyFirstOfdRoutes = firstOfdRouteDrift('', { paths: {} }, firstOfdManifest);
  assertCheck('first-ofd:negative-control', 'пустой server/openapi красит все API/mock routes',
    emptyFirstOfdRoutes.length > 0 && emptyFirstOfdRoutes.every((route) => !route.inServer && !route.inOpenApi),
    `routes в негативном контроле: ${emptyFirstOfdRoutes.length}`);
  const emptyFirstOfdControlRoutes = firstOfdControlRouteDrift('', { paths: {} }, firstOfdManifest);
  assertCheck('first-ofd:negative-control', 'пустой server/openapi красит все control routes',
    emptyFirstOfdControlRoutes.length > 0 && emptyFirstOfdControlRoutes.every((route) => !route.inServer && !route.inOpenApi),
    `control routes в негативном контроле: ${emptyFirstOfdControlRoutes.length}`);
  const emptyFirstOfdTypes = Object.keys(firstOfdManifest.transactionTypes || {})
    .map((type) => ({ type, inServer: firstOfdServerCode.includes(`  ${type}: '`), inOpenApi: JSON.stringify({}).includes(`"${type}"`) }));
  assertCheck('first-ofd:negative-control', 'пустой OpenAPI красит типы заявок (server остаётся отдельно зелёным)',
    emptyFirstOfdTypes.length > 0 && emptyFirstOfdTypes.every((entry) => entry.inServer && !entry.inOpenApi),
    `типов заявок в негативном контроле: ${emptyFirstOfdTypes.length}`);
  assertCheck('first-ofd:readme', 'сервисный README фиксирует getToken/Bearer, очередь и границы [VERIFY]/[FORK]',
    firstOfdReadme.includes('getToken') && firstOfdReadme.includes('Bearer') && firstOfdReadme.includes('requestId')
      && firstOfdReadme.includes('[VERIFY]') && firstOfdReadme.includes('[FORK]') && firstOfdReadme.includes('3107'),
    'README должен объяснять авторизацию, асинхронность и известные пробелы среза');

  // Контур.ОФД read-only: independently inspect dispatch table and OpenAPI operations.
  const konturManifest = readJson('protocols/kontur-ofd.json');
  const konturServer = readText('services/kontur-ofd-mock/server.js');
  const konturOpenApi = readJson(konturManifest.openapi);
  const konturGuide = readText(konturManifest.guide);
  const konturReadme = readText(konturManifest.readme);
  const { verifyRoutes: konturRoutes } = require('../services/kontur-ofd-mock/drift');
  for (const route of konturRoutes(konturServer, konturOpenApi, konturManifest)) {
    assertCheck('kontur-ofd:route', `${route.method} ${route.path}`, route.inServer && route.inOpenApi,
      `server=${route.inServer}, openapi=${route.inOpenApi}`);
  }
  // Конспекты upstream-доки выведены в приватный rucorp/mock-services-docs (2026-10-15);
  // проверяем только целостность метаданных provenance, а не наличие файла в публичном репо.
  for (const doc of konturManifest.upstreamDocs) {
    assertCheck('kontur-ofd:reference', doc, typeof doc === 'string' && doc.startsWith('mock-services-docs/'), 'provenance points to private docs repo');
  }
  assertCheck('kontur-ofd:openapi', 'OpenAPI 3.1', konturOpenApi.openapi === '3.1.0');
  for (const type of konturManifest.documentTypes) {
    const inServer = konturServer.includes(`'${type}'`);
    const inOpenApi = konturOpenApi.components.schemas.Document.properties.type.enum.includes(type);
    assertCheck('kontur-ofd:type', type, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }
  const periodPath = '/v2/organizations/{organizationId}/cashboxes/{kktRegId}/documents/by-period';
  const periodParams = konturOpenApi.paths[periodPath].get.parameters;
  const cursorParam = periodParams.find((p) => p.name === konturManifest.pagination.requestCursor);
  const limitParam = periodParams.find((p) => p.name === 'limit');
  assertCheck('kontur-ofd:pagination', 'canonical offset; currentOffset rejected with explicit hint',
    cursorParam?.name === 'offset' && !periodParams.some((p) => p.name === 'currentOffset')
      && konturServer.includes("q.has('currentOffset')") && konturGuide.includes('[FORK]') && konturGuide.includes('currentOffset'));
  assertCheck('kontur-ofd:pagination', '1000 page cap/default independent server/OpenAPI',
    konturServer.includes(`PAGE_LIMIT_MAX = ${konturManifest.pagination.maximumLimit}`)
      && limitParam?.schema.maximum === konturManifest.pagination.maximumLimit
      && limitParam?.schema.default === konturManifest.pagination.defaultLimit);
  assertCheck('kontur-ofd:pagination', 'nextOffset includes null on exhaustion',
    konturOpenApi.components.schemas.DocumentPage.properties.paging.properties.nextOffset.type.includes('null')
      && konturServer.includes('nextOffset:') && konturGuide.includes('nextOffset'));
  assertCheck('kontur-ofd:auth', '30-day Sid on virtual clock',
    konturServer.includes(`SID_TTL_DEFAULT_SECS = ${konturManifest.auth.sidTtlSecsDefault}`)
      && konturServer.includes('session.expiresAt <= clock.now()') && konturGuide.includes('2592000'));
  assertCheck('kontur-ofd:auth', 'two independent authentication headers',
    konturOpenApi.components.securitySchemes.Sid.name === 'Authorization'
      && konturOpenApi.components.securitySchemes.ApiKey.name === konturManifest.auth.apiKeyHeader
      && konturServer.includes('x-kontur-ofd-apikey') && konturServer.includes('auth\\.sid'));
  for (const code of konturManifest.authErrorCodeIds) {
    assertCheck('kontur-ofd:error', String(code), konturServer.includes(String(code)) && konturGuide.includes(String(code)));
  }
  for (const route of konturManifest.routes.filter((r) => r.path.startsWith('/v2/'))) {
    const op = konturOpenApi.paths[route.path]?.[route.method.toLowerCase()];
    assertCheck('kontur-ofd:security', route.path, op?.security.some((s) => 'Sid' in s && 'ApiKey' in s));
    for (const code of konturManifest.errors) assertCheck('kontur-ofd:response', `${route.path}: ${code}`, Boolean(op?.responses[code]));
  }
  for (const field of ['totalSum', 'cashSum', 'electronicSum']) {
    assertCheck('kontur-ofd:amounts', `${field}: integer kopeks`,
      konturOpenApi.components.schemas.Document.properties[field].type === 'integer' && konturGuide.includes('копейках'));
  }
  for (const credential of konturManifest.auth.credentialsEnv) {
    assertCheck('kontur-ofd:credentials', credential, konturServer.includes(credential) && konturGuide.includes(credential));
  }
  assertCheck('kontur-ofd:scope', 'read-only routes (no creation/callback)',
    konturManifest.routes.filter((r) => r.path.startsWith('/v2/')).every((r) => r.method === 'GET')
      && konturGuide.includes('не моделируется') && konturReadme.includes('read/reconciliation'));
  assertCheck('kontur-ofd:negative-control', 'missing server fails independently of OpenAPI',
    konturRoutes('', konturOpenApi, konturManifest).every((r) => !r.inServer && r.inOpenApi));
  assertCheck('kontur-ofd:negative-control', 'missing OpenAPI fails independently of server',
    konturRoutes(konturServer, { paths: {} }, konturManifest).every((r) => r.inServer && !r.inOpenApi));
  assertCheck('kontur-ofd:registration', 'port 3108 exposed, compose profile mock and test script',
    /^EXPOSE .*\b3108\b/m.test(readText('Dockerfile'))
      && readText('docker-compose.include.yml').includes('services/kontur-ofd-mock/server.js')
      && readJson('package.json').scripts.test.includes('test:kontur-ofd'));

  // Такском read-only (taxcom-ofd.json <-> server.js <-> OpenAPI 3.1 <-> guide):
  // dispatch-таблица и OpenAPI сверяются НЕЗАВИСИМО (services/taxcom-mock/drift.js).
  const taxcomManifest = readJson('protocols/taxcom-ofd.json');
  const taxcomServer = readText('services/taxcom-mock/server.js');
  const taxcomOpenApi = readJson(taxcomManifest.openapi);
  const taxcomGuide = readText(taxcomManifest.guide);
  const taxcomReadme = readText(taxcomManifest.readme);
  const { verifyRoutes: taxcomRoutes } = require('../services/taxcom-mock/drift');

  for (const route of taxcomRoutes(taxcomServer, taxcomOpenApi, taxcomManifest)) {
    assertCheck('taxcom:route', `${route.method} ${route.path}`, route.inServer && route.inOpenApi,
      `server=${route.inServer}, openapi=${route.inOpenApi}`);
  }
  // Конспекты upstream-доки выведены в приватный rucorp/mock-services-docs (2026-10-15);
  // проверяем только целостность метаданных provenance, а не наличие файла в публичном репо.
  for (const doc of taxcomManifest.upstreamDocs) {
    assertCheck('taxcom:reference', doc, typeof doc === 'string' && doc.startsWith('mock-services-docs/'), 'provenance points to private docs repo');
  }
  assertCheck('taxcom:openapi', 'OpenAPI 3.1', taxcomOpenApi.openapi === '3.1.0');
  for (const { method, path: taxcomPath, errors } of taxcomManifest.routes) {
    const op = taxcomOpenApi.paths[taxcomPath]?.[method.toLowerCase()];
    for (const code of errors) {
      assertCheck('taxcom:response', `${taxcomPath}: ${code}`, Boolean(op?.responses[code]));
    }
  }
  assertCheck('taxcom:security', 'Login — заголовок Integrator-ID, чтение — Session-Token',
    taxcomOpenApi.paths['/API/v2/Login'].post.security.some((s) => 'IntegratorId' in s)
      && taxcomOpenApi.paths['/API/v2/AccountList'].get.security.some((s) => 'SessionToken' in s)
      && taxcomOpenApi.paths['/API/v2/NewDocuments'].get.security.some((s) => 'SessionToken' in s)
      && taxcomOpenApi.components.securitySchemes.IntegratorId.name === taxcomManifest.auth.integratorHeader
      && taxcomOpenApi.components.securitySchemes.SessionToken.name === taxcomManifest.auth.sessionHeader
      && taxcomServer.includes("req.headers['integrator-id']") && taxcomServer.includes("req.headers['session-token']"),
    'заголовки провайдера закреплены в OpenAPI и в server.js');
  for (const type of taxcomManifest.documentTypes) {
    const inServer = taxcomServer.includes(`'${type}'`);
    const inOpenApi = taxcomOpenApi.components.schemas.Document.properties.type.enum.includes(type);
    assertCheck('taxcom:type', type, inServer && inOpenApi, `server=${inServer}, openapi=${inOpenApi}`);
  }

  const taxcomInvariants = [
    ['taxcom:invariant', `Session-Token TTL ${taxcomManifest.auth.sessionTtlSecsDefault} с на виртуальных часах`,
      taxcomServer.includes(`SESSION_TTL_DEFAULT_SECS = ${taxcomManifest.auth.sessionTtlSecsDefault}`)
        && taxcomServer.includes('expiresAt: now + SESSION_TTL_SECS * 1000') && taxcomServer.includes('clock.now()')],
    ['taxcom:invariant', 'TTL sliding от последнего использования',
      taxcomServer.includes('session.expiresAt = clock.now() + SESSION_TTL_SECS * 1000')
        && taxcomServer.includes('Sliding') && taxcomGuide.includes('sliding')],
    ['taxcom:invariant', 'просроченный Session-Token → HTTP 401 и удаление сессии',
      taxcomServer.includes('session.expiresAt <= clock.now()') && taxcomServer.includes('delete state.sessions[token]')
        && taxcomServer.includes('истёк')],
    ['taxcom:invariant', '[VERIFY] тело Login_Request — консервативная форма {login, password}',
      taxcomServer.includes('[VERIFY] Форма тела Login_Request') && taxcomServer.includes("k !== 'login' && k !== 'password'")
        && taxcomOpenApi.components.schemas.LoginRequest.additionalProperties === false
        && taxcomOpenApi.components.schemas.LoginRequest.required.join(',') === 'login,password'],
    ['taxcom:invariant', '[FORK] повторный Login выдаёт новый marker, прежний живёт до TTL',
      taxcomServer.includes('[FORK] Новый marker при каждом Login') && taxcomServer.includes(' crypto.randomBytes(24)')
        && taxcomGuide.includes('Повторный Login') && taxcomGuide.includes('[FORK]')],
    ['taxcom:invariant', `окно NewDocuments — ${taxcomManifest.pagination.windowDays} суток (нижняя граница включена)`,
      taxcomServer.includes(`WINDOW_DAYS = ${taxcomManifest.pagination.windowDays}`)
        && taxcomServer.includes('received >= from && received <= now') && taxcomGuide.includes('10 суток')],
    ['taxcom:invariant', `не более ${taxcomManifest.pagination.maximumPerCall} документов за вызов`,
      taxcomServer.includes(`PAGE_LIMIT_MAX = ${taxcomManifest.pagination.maximumPerCall}`)
        && taxcomServer.includes('start + PAGE_LIMIT_MAX') && taxcomGuide.includes('10 000')],
    ['taxcom:invariant', 'сортировка по времени приёма (receivedAt), а не по фискальному dateTime',
      taxcomServer.includes('dateValue(a.receivedAt) - dateValue(b.receivedAt)') && taxcomGuide.includes('receivedAt')],
    ['taxcom:invariant', 'курсор по id последнего полученного документа, хвост → пустой ответ',
      taxcomServer.includes("selection.findIndex((d) => d.id === q.get('id'))") && taxcomServer.includes('start = index + 1')
        && taxcomGuide.includes('последнего полученного документа')],
    ['taxcom:invariant', `3106 «нет доступной ККТ» → HTTP ${taxcomManifest.apiErrorCodes['3106'].httpStatus}`,
      taxcomServer.includes(`error(res, ${taxcomManifest.apiErrorCodes['3106'].httpStatus}, API_ERRORS[3106], 3106`)
        && taxcomServer.includes('3106:') && taxcomGuide.includes('3106')],
    ['taxcom:invariant', `2203 «некорректный курсор» → HTTP ${taxcomManifest.apiErrorCodes['2203'].httpStatus}`,
      taxcomServer.includes(`error(res, ${taxcomManifest.apiErrorCodes['2203'].httpStatus}, API_ERRORS[2203], 2203`)
        && taxcomServer.includes('2203:') && taxcomGuide.includes('2203')],
    ['taxcom:invariant', 'write API не моделируется: 405 для известного маршрута, 404 с подсказкой для неизвестного',
      taxcomServer.includes("error(res, 405, 'Метод не поддерживается')")
        && taxcomServer.includes('write API не моделируется') && taxcomGuide.includes('не моделируется')],
    ['taxcom:invariant', 'нет исходящей поверхности: очередь доставки и SSRF-guard не подключаются',
      !taxcomServer.includes('createDeliveryQueue') && !taxcomServer.includes('postJson')
        && !taxcomServer.includes('MOCK_BLOCK_PRIVATE_WEBHOOKS') && taxcomReadme.includes('исходящих HTTP-запросов нет')],
    ['taxcom:invariant', 'синтетические креды по умолчанию, env переопределяет и скрывается в логе',
      taxcomServer.includes(`DEFAULT_LOGIN = '${taxcomManifest.testCredentials.login}'`)
        && taxcomServer.includes(`DEFAULT_PASSWORD = '${taxcomManifest.testCredentials.password}'`)
        && taxcomServer.includes(`DEFAULT_INTEGRATOR_ID = '${taxcomManifest.testCredentials.integratorId}'`)
        && taxcomServer.includes('credLogView') && taxcomServer.includes('не реквизиты Такском')],
    ['taxcom:invariant', 'журнал и экспорт состояния не раскрывают секреты',
      taxcomServer.includes('snapshot.state.sessions = {}')
        && taxcomServer.includes('Не журналируем тело Login (пароль), Session-Token, Integrator-ID')],
    ['taxcom:invariant', 'виртуальные часы, сценарии, chaos и журнал подключены из core',
      taxcomServer.includes('core.createVirtualClock') && taxcomServer.includes('createScenarioRegistry')
        && taxcomServer.includes('applyRequestChaos') && taxcomServer.includes('journal.record')],
    ['taxcom:invariant', 'control-plane fail-closed в hosted (checkControlAccess)',
      taxcomServer.includes('checkControlAccess')],
    ['taxcom:invariant', 'чужой контракт не подмешивается: нет Ferma/АТОЛ/OKassa/Контур-маршрутов и подписей',
      !taxcomServer.includes('/possystem/') && !taxcomServer.includes('/auth/authenticate-by-pass')
        && !taxcomServer.includes('/getToken') && !/createHmac|createSign/.test(taxcomServer)],
    ['taxcom:invariant', 'graceful shutdown общим хелпером ядра (MS-04)',
      taxcomServer.includes('core.installGracefulShutdown')],
  ];
  for (const [category, item, okFlag] of taxcomInvariants) {
    assertCheck(category, item, Boolean(okFlag), okFlag ? 'инвариант соблюдён' : 'инвариант нарушен в server.js');
  }

  for (const [needle, label] of [
    ['Integrator-ID', 'заголовок интегратора'],
    ['Session-Token', 'заголовок сессии'],
    ['Login_Request', 'пометка о нераскрытой схеме тела'],
    ['300', 'TTL маркера 5 минут'],
    ['10 суток', 'окно выдачи документов'],
    ['10 000', 'лимит документов за вызов'],
    ['3106', 'нет доступной ККТ'],
    ['2203', 'некорректный курсор'],
    ['api-tlk-ofd.taxcom.ru', 'тестовый host провайдера'],
    ['api-lk-ofd.taxcom.ru', 'production host провайдера'],
    ['не чаще раза в минуту', 'рекомендация частоты опроса'],
    ['AccountList', 'discovery договоров'],
    ['NewDocuments', 'поток новых документов'],
    ['копейках', 'единицы сумм'],
    ['22-122', 'ставки НДС v2.17 не раскрыты по именам полей'],
    ['[VERIFY]', 'незакрытые места среза'],
    ['[FORK]', 'локальные решения мока'],
    ['3109', 'порт стенда'],
  ]) {
    const inGuide = taxcomGuide.includes(needle);
    assertCheck('taxcom:guide-point', `${label} (${needle})`, inGuide, inGuide ? 'есть в docs/integration/taxcom.md' : 'гайд не содержит обязательную оговорку');
  }

  const taxcomLimits = taxcomManifest.limits || {};
  assertCheck('taxcom:limits', `sessionTtlSecsDefault=${taxcomLimits.sessionTtlSecsDefault}`,
    taxcomServer.includes(`SESSION_TTL_DEFAULT_SECS = ${taxcomLimits.sessionTtlSecsDefault}`)
      && taxcomGuide.includes(String(taxcomLimits.sessionTtlSecsDefault)),
    'TTL маркера совпадает в манифесте, адаптере и guide');
  assertCheck('taxcom:limits', `windowDays=${taxcomLimits.windowDays}`,
    taxcomServer.includes(`WINDOW_DAYS = ${taxcomLimits.windowDays}`) && taxcomGuide.includes('10 суток'),
    'окно 10 суток совпадает в манифесте, адаптере и guide');
  assertCheck('taxcom:limits', `pageMaxPerCall=${taxcomLimits.pageMaxPerCall}`,
    taxcomServer.includes(`PAGE_LIMIT_MAX = ${taxcomLimits.pageMaxPerCall}`) && taxcomGuide.includes('10 000'),
    'лимит 10 000 документов совпадает в манифесте, адаптере и guide');
  assertCheck('taxcom:verify', 'манифест фиксирует незакрытые места среза ([VERIFY])',
    (taxcomManifest.verify || []).length >= 5 && taxcomGuide.includes('[VERIFY]'),
    `verify=${(taxcomManifest.verify || []).length}`);

  assertCheck('taxcom:negative-control', 'missing server fails independently of OpenAPI',
    taxcomRoutes('', taxcomOpenApi, taxcomManifest).every((r) => !r.inServer && r.inOpenApi));
  assertCheck('taxcom:negative-control', 'missing OpenAPI fails independently of server',
    taxcomRoutes(taxcomServer, { paths: {} }, taxcomManifest).every((r) => r.inServer && !r.inOpenApi));
  assertCheck('taxcom:readme', 'сервисный README фиксирует Login/Session-Token, границы и порт',
    taxcomReadme.includes('Integrator-ID') && taxcomReadme.includes('Session-Token') && taxcomReadme.includes('3109')
      && taxcomReadme.includes('[VERIFY]') && taxcomReadme.includes('[FORK]'),
    'README должен объяснять авторизацию, read-only границы и известные пробелы среза');
  assertCheck('taxcom:registration', 'порт 3109: Dockerfile EXPOSE, healthcheck, оба compose и test:taxcom',
    /^EXPOSE .*\b3109\b/m.test(readText('Dockerfile'))
      && readText('scripts/docker-healthcheck.js').includes("['3109', '/health']")
      && readText('docker-compose.include.yml').includes('services/taxcom-mock/server.js')
      && readText('docker-compose.yml').includes('services/taxcom-mock/server.js')
      && readJson('package.json').scripts.test.includes('test:taxcom'),
    'регистрация сервиса в образе, healthcheck, compose и npm test');

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
    console.log(`\n== Protocol Drift Check (tbank-eacq + ferma-ofd + atol-online + alfa-eacq + sber-ecom + vtb-smb + first-ofd-okassa + kontur-ofd + taxcom-ofd) ==`);
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
