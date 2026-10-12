#!/usr/bin/env node
// SZ-ALFA аддендум (post-#55): §7.2 TTL-sweep-рейс воспроизводится на ПЯТОМ адаптере (alfa-mock).
// Механизм (core 2188-2195, 2422-2444, 2468+): sweep удаляет admission-запись in-flight запроса ->
// currentRecord() фолбэчит на sandboxes.get(activeId) -> фасад state читает ЧУЖОЙ state.
// Жертва = persisted registry activeId (expiresAt:0 — sweep пропускает); гость = target /mock/reset
// (маршрут PA-50, создаёт запись без owner-token). Запрос: getOrderStatus.do c x-mock-latency > TTL.
'use strict';
process.env.MOCK_HOSTED = '1';
process.env.MOCK_TENANCY = 'owned';
process.env.MOCK_SANDBOX_MAX = '10';
process.env.MOCK_SANDBOX_TTL_MS = '500';
process.env.MOCK_SANDBOX_SWEEP_MS = '1000';
process.env.MOCK_SANDBOX_CREATE_LIMIT = '0';
process.env.MOCK_STATE_FILE = '';

const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http');
const REPO = require('node:path').resolve(__dirname, '..', '..', '..', '..');
const core = require(REPO + '/packages/core');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alfa-ttl-race-'));
const file = path.join(dir, 'sandboxes.json');
const orderId = 'alfa-race-victim-order', orderNumber = 'RACE-VICTIM-CANARY';
fs.writeFileSync(file, JSON.stringify({
  activeId: 'alfa-victim',
  sandboxes: [{
    id: 'alfa-victim', expiresAt: 0,
    ownerTokenHash: core.hashSecret('victim-owner-token'),
    state: {
      counters: { callbackId: 1 },
      orders: { [orderId]: { orderId, orderNumber, status: 2, amountK: 123456, createdAtMs: 1, actionCode: null, actionCodeDescription: '', authorizedK: 123456 } },
      orderNumbers: { [orderNumber]: orderId },
      callbacks: {},
      clockOffsetMs: 0,
    },
  }],
}));
process.env.MOCK_SANDBOX_FILE = file;
const svc = require(REPO + '/services/alfa-mock/server.js');

function req(port, method, url, headers = {}, body = '', contentType = null) {
  return new Promise((resolve, reject) => {
    const data = body || null;
    const h = { ...headers };
    if (data) { h['Content-Length'] = Buffer.byteLength(data); h['Content-Type'] = contentType || 'application/json'; }
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h, timeout: 8000 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    if (data) r.write(data); r.end();
  });
}

(async () => {
  await new Promise((ok) => svc.server.listen(0, '127.0.0.1', ok));
  const port = svc.server.address().port;

  // 1. владелец A (owner-token)
  const control = await req(port, 'POST', '/sandboxes', {}, JSON.stringify({ id: 'race-controller' }));
  const ownerToken = JSON.parse(control.body).ownerToken;

  // 2. PA-50 маршрут: /mock/reset с target=gost создаёт запись без owner-token (TTL 500 мс)
  const reset = await req(port, 'POST', '/mock/reset',
    { 'x-mock-sandbox': 'race-controller', 'x-sandbox-token': ownerToken },
    JSON.stringify({ sandbox: 'race-ghost' }));
  const ghost = svc.sandboxRuntime.find('race-ghost');

  // 3a. КОНТРОЛЬ: тот же запрос БЕЗ задержки — гость ещё жив, своего заказа нет -> errorCode 3
  const form = new URLSearchParams({ userName: 'ALFAMOCKTEST', password: 'mockpass123', orderNumber }).toString();
  const immediate = await req(port, 'POST', '/payment/rest/getOrderStatus.do',
    { 'x-mock-sandbox': 'race-ghost' }, form, 'application/x-www-form-urlencoded');

  // 3b. РЕЙС: тот же запрос с задержкой 2500 мс > TTL 500 мс; sweep (1000 мс) удаляет гостя mid-await
  const response = await req(port, 'POST', '/payment/rest/getOrderStatus.do',
    { 'x-mock-sandbox': 'race-ghost', 'x-mock-latency': '2500' }, form, 'application/x-www-form-urlencoded');

  console.log(JSON.stringify({
    controllerStatus: control.status,
    resetStatus: reset.status,
    ghostOwnerTokenHash: (ghost && ghost.ownerTokenHash) || null,
    ghostHasTtl: Boolean(ghost && ghost.expiresAt),
    control_noDelay: { status: immediate.status, orderNotFound: immediate.body.includes('"errorCode":3') },
    race_delayed: {
      status: response.status,
      ghostExistsAfter: Boolean(svc.sandboxRuntime.find('race-ghost')),
      activeIdAfter: svc.sandboxRuntime.activeId(),
      victimOrderReturned: response.body.includes(orderNumber) && response.body.includes(orderId),
    },
    responseSnippet: response.body.slice(0, 300),
  }));
  svc.server.closeAllConnections && svc.server.closeAllConnections();
  await new Promise((ok) => svc.server.close(ok));
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exitCode = 1; });
