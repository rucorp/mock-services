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
 * реализацию в `services/tbank-mock/server.js` и `services/kassa-mock/server.js`.
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
    console.log(`\n== Protocol Drift Check (tbank-eacq + ferma-ofd) ==`);
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
