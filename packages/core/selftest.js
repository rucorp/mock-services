// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Self-test ядра (packages/core) — проверяет механизмы, общие для адаптеров,
 * на которых уже были дефекты (аудит 2026-10-08, A-2…A-4):
 *
 *   1. createStore.restore() сохраняет идентичность вложенных объектов —
 *      иначе очередь вебхуков после рестарта смотрит в старый объект и молча
 *      теряет недоставленные уведомления;
 *   2. доставленная запись помечается done и не переотправляется (в т.ч.
 *      после сериализации в state-файл: раньше Infinity превращался в null и
 *      запись считалась «пора слать снова»);
 *   3. запись «в полёте» не отправляется параллельно (медленный вебхук раньше
 *      порождал N одновременных POST'ов на одну нотификацию);
 *   4. escapeHtml экранирует данные интегратора на HTML-страницах сервисов.
 *
 * Zero dependencies. Запуск: node packages/core/selftest.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const core = require('./index.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function acheck(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

async function main() {
  console.log('\n== core selftest ==\n');

  /* ---------------------------------------------- store: идентичность */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-core-'));
  const stateFile = path.join(dir, 'state.json');

  const producer = core.createStore({ stateFile, log: () => {} });
  producer.state.notifications = {};
  producer.state.notifications['1'] = { id: '1', attempts: 0, nextAttemptAt: 0, url: 'http://x/' };
  producer.persist();

  // Как в адаптерах: сервис инициализирует state ДО restore()
  const consumer = core.createStore({ stateFile, log: () => {} });
  consumer.state.notifications = {};
  const queueRef = consumer.state.notifications;
  consumer.restore();

  check('restore() сохраняет ссылку очереди и восстанавливает словарь без прототипа', () => {
    assert.strictEqual(consumer.state.notifications, queueRef, 'объект подменён — очередь смотрит в пустой объект');
    assert.strictEqual(consumer.state.notifications['1'].url, 'http://x/');
    assert.strictEqual(Object.getPrototypeOf(consumer.state.notifications), null, 'state-map должен быть безопасным словарём');
  });

  check('restore() удаляет ключи, которых нет в файле (не тащит мусор прошлого процесса)', () => {
    const fresh = core.createStore({ stateFile, log: () => {} });
    fresh.state.notifications = { ghost: { id: 'ghost' } }; // «мусор» нового процесса
    fresh.restore();
    assert.ok(!fresh.state.notifications.ghost, 'ключ ghost должен исчезнуть');
    assert.ok(fresh.state.notifications['1'], 'запись из файла должна остаться');
  });

  {
    const pollutedKey = `f01_restore_${process.pid}`;
    const unsafeFile = path.join(dir, 'unsafe-state.json');
    const logs = [];
    fs.writeFileSync(unsafeFile, JSON.stringify({ payments: JSON.parse(`{"__proto__":{"${pollutedKey}":true}}`) }));
    const guarded = core.createStore({ stateFile: unsafeFile, log: (message) => logs.push(message) });
    guarded.state.payments = { keep: { id: 'keep' } };
    const paymentsRef = guarded.state.payments;
    guarded.restore();
    check('restore() целиком отклоняет __proto__ до merge: прототип чист, state не изменён и есть DX-лог', () => {
      assert.strictEqual(Object.prototype[pollutedKey], undefined);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, pollutedKey), false);
      assert.strictEqual(guarded.state.payments, paymentsRef);
      assert.deepStrictEqual(Object.keys(guarded.state.payments), ['keep']);
      assert.ok(logs.some((message) => message.includes('__proto__') && message.includes('state restore failed')));
    });
    delete Object.prototype[pollutedKey];
  }

  check('createSandboxManager отклоняет опасные ключи без частичного импорта', () => {
    const pollutedKey = `f01_import_${process.pid}`;
    const state = { payments: { keep: { id: 'keep' } }, notifications: {} };
    const paymentsRef = state.payments;
    const manager = core.createSandboxManager({ state, initialStateFactory: () => ({ payments: {}, notifications: {} }) });
    const unsafe = JSON.parse(`{"payments":{"__proto__":{"${pollutedKey}":true}}}`);
    assert.throws(() => manager.importState(unsafe), /__proto__/);
    assert.strictEqual(Object.prototype[pollutedKey], undefined);
    assert.strictEqual(state.payments, paymentsRef);
    assert.deepStrictEqual(Object.keys(state.payments), ['keep']);
    delete Object.prototype[pollutedKey];
  });

  check('safe state schema rejects constructor and prototype at every nesting level', () => {
    const manager = core.createSandboxManager({ state: { payments: {}, notifications: {} }, initialStateFactory: () => ({ payments: {}, notifications: {} }) });
    for (const key of ['constructor', 'prototype']) {
      const unsafe = JSON.parse(`{"payments":{"entry":{"${key}":{"polluted":true}}}}`);
      assert.throws(() => manager.importState(unsafe), new RegExp(key));
    }
    assert.strictEqual(Object.prototype.polluted, undefined);
  });

  /* ------------------------------------------------ delivery queue */
  const hits = { ok: 0, slow: 0 };
  const slowState = { concurrent: 0, maxConcurrent: 0 };
  const hook = http.createServer((req, res) => {
    if (req.url === '/slow') {
      hits.slow += 1;
      slowState.concurrent += 1;
      slowState.maxConcurrent = Math.max(slowState.maxConcurrent, slowState.concurrent);
      setTimeout(() => {
        slowState.concurrent -= 1;
        res.writeHead(500); res.end('no');
      }, 700); // отвечает медленнее, чем тик
    } else {
      hits.ok += 1;
      res.writeHead(200); res.end('OK');
    }
  });
  const hookPort = await listen(hook);

  const okEntries = {};
  okEntries.a = { url: `http://127.0.0.1:${hookPort}/ok`, attempts: 0, nextAttemptAt: 0 };
  const okQueue = core.createDeliveryQueue({
    entries: okEntries, retryMs: 200, maxAttempts: 5, log: () => {},
    request: (e) => ({ url: e.url, data: { ping: true } }),
  });
  await okQueue.tick();
  await okQueue.tick();
  await sleep(600);

  check('успешная доставка помечается done и не повторяется (в т.ч. после сериализации)', () => {
    assert.strictEqual(okEntries.a.done, true, 'нет терминального флага done');
    const roundTripped = JSON.parse(JSON.stringify(okEntries.a)); // как state-файл
    assert.strictEqual(roundTripped.done, true);
    assert.strictEqual(roundTripped.nextAttemptAt, null);
  });
  check('после успеха запись не переотправляется (1 попадание)', () => {
    assert.strictEqual(hits.ok, 1, `доставок: ${hits.ok}, ожидалась 1`);
  });

  const slowEntries = {};
  slowEntries.a = { url: `http://127.0.0.1:${hookPort}/slow`, attempts: 0, nextAttemptAt: 0 };
  const slowQueue = core.createDeliveryQueue({
    entries: slowEntries, retryMs: 400, maxAttempts: 5, log: () => {},
    request: (e) => ({ url: e.url, data: { ping: true } }),
    isOk: () => false, // всегда «не доставлено» — гоняем ретраи
  });
  const stop = setInterval(() => { slowQueue.tick(); }, 100); // тик чаще, чем длится отправка
  await sleep(2600);
  clearInterval(stop);

  check('медленный вебхук не порождает параллельных дублей (одна запись — один POST в полёте)', () => {
    assert.strictEqual(slowState.maxConcurrent, 1, `одновременных POST на одну запись: ${slowState.maxConcurrent}`);
    assert.ok(hits.slow >= 2, `ретраев не было: ${hits.slow} POST за 2.6 с`);
    assert.ok(slowEntries.a.attempts <= hits.slow, 'attempts не может превышать число отправок');
  });

  await acheck('postJson обрывает слишком большой ответ и применяет абсолютный deadline к trickle-response (F-03)', async () => {
    const fixture = http.createServer((req, res) => {
      req.resume();
      if (req.url === '/large') {
        const body = Buffer.alloc(70 * 1024, 'L');
        res.writeHead(200, { 'Content-Length': body.length });
        res.end(body);
        return;
      }
      if (req.url === '/trickle') {
        res.writeHead(200);
        const timer = setInterval(() => res.write('x'), 35);
        res.on('close', () => clearInterval(timer));
        return;
      }
      if (req.url === '/medium') {
        const body = Buffer.alloc(16 * 1024, 'M');
        res.writeHead(500, { 'Content-Length': body.length });
        res.end(body);
        return;
      }
      res.writeHead(200);
      res.end('OK');
    });
    const fixturePort = await listen(fixture);
    try {
      await assert.rejects(
        () => core.postJson(`http://127.0.0.1:${fixturePort}/large`, { ping: true }, 500, { maxResponseBytes: 32, deadlineMs: 500 }),
        (error) => error.code === 'WEBHOOK_RESPONSE_TOO_LARGE',
      );
      await assert.rejects(
        () => core.postJson(`http://127.0.0.1:${fixturePort}/trickle`, { ping: true }, 1000, { maxResponseBytes: 4096, deadlineMs: 150 }),
        (error) => error.code === 'WEBHOOK_DEADLINE_EXCEEDED',
      );

      let completed = 0;
      let resolveCompleted;
      const completedThreeTimes = new Promise((resolve) => { resolveCompleted = resolve; });
      const entries = {
        oversized: { url: `http://127.0.0.1:${fixturePort}/large`, attempts: 0, nextAttemptAt: 0 },
        medium: { url: `http://127.0.0.1:${fixturePort}/medium`, attempts: 0, nextAttemptAt: 0 },
        healthy: { url: `http://127.0.0.1:${fixturePort}/ok`, attempts: 0, nextAttemptAt: 0 },
      };
      const queue = core.createDeliveryQueue({
        entries,
        retryMs: 100,
        maxAttempts: 3,
        log: () => {},
        persist: () => { completed += 1; if (completed === 3) resolveCompleted(); },
        request: (entry) => ({ url: entry.url, data: { ping: true } }),
      });
      await queue.tick();
      await withTimeout(completedThreeTimes, 1500, 'delivery queue не завершил callback после abort');
      assert.strictEqual(entries.healthy.done, true, 'успешный callback после abort должен выполниться');
      assert.ok(String(entries.oversized.lastStatus).includes('WEBHOOK_RESPONSE_TOO_LARGE'));
      assert.ok(entries.oversized.lastBody.length <= 1024, 'error lastBody ограничен по длине');
      assert.strictEqual(entries.medium.lastStatus, 500);
      assert.ok(entries.medium.lastBody.length <= 1024, 'даже большой отказной body сохраняется только усечённым');
    } finally {
      fixture.close();
    }
  });

  /* --------------------------------------------------------- helpers */
  check('escapeHtml экранирует данные интегратора', () => {
    assert.strictEqual(core.escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.strictEqual(core.escapeHtml(`'"&`), '&#39;&quot;&amp;');
    assert.strictEqual(core.escapeHtml(null), '');
  });

  check('parseBody понимает json и form-urlencoded', () => {
    assert.deepStrictEqual(core.parseBody('{"a":1}', 'application/json'), { a: 1 });
    assert.deepStrictEqual(core.parseBody('a=1&b=%D0%B4', 'application/x-www-form-urlencoded'), { a: '1', b: 'д' });
    assert.deepStrictEqual(core.parseBody('', 'application/json'), {});
  });

  await acheck('readBody считает байты, точно принимает лимит и после 413 больше не копит chunks (F-02)', async () => {
    const { EventEmitter } = require('events');
    const exactReq = new EventEmitter();
    const exactBody = core.readBody(exactReq, 4);
    exactReq.emit('data', Buffer.from('1234'));
    exactReq.emit('end');
    assert.strictEqual(await exactBody, '1234');

    const plusOneReq = new EventEmitter();
    const plusOne = assert.rejects(core.readBody(plusOneReq, 4), (error) => error.code === 'BODY_TOO_LARGE' && error.statusCode === 413);
    plusOneReq.emit('data', Buffer.from('12345'));
    plusOneReq.emit('data', Buffer.alloc(1024 * 1024)); // данные после отказа только дренируются
    plusOneReq.emit('end');
    await plusOne;

    const utf8Req = new EventEmitter();
    const multibyte = assert.rejects(core.readBody(utf8Req, 3), (error) => error.code === 'BODY_TOO_LARGE');
    utf8Req.emit('data', Buffer.from('éé', 'utf8')); // 2 code units, но 4 байта
    utf8Req.emit('end');
    await multibyte;
  });

  await acheck('HTTP 413 сразу отвечает и продолжает дренировать тело после отказа (F-02)', async () => {
    const received = { bytes: 0, ended: false };
    let resolveDrained;
    const drained = new Promise((resolve) => { resolveDrained = resolve; });
    const limitedServer = http.createServer((req, res) => {
      req.on('data', (chunk) => { received.bytes += Buffer.byteLength(chunk); });
      req.on('end', () => { received.ended = true; resolveDrained(); });
      core.readBody(req, 8).then(
        (body) => core.sendJson(res, { body }),
        (error) => core.sendJson(res, { code: error.code }, error.statusCode || 500),
      );
    });
    const port = await listen(limitedServer);
    try {
      const result = await new Promise((resolve, reject) => {
        let req;
        let sentAfterRefusal = false;
        req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/limited',
          method: 'POST',
          headers: { 'Transfer-Encoding': 'chunked' },
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ statusCode: res.statusCode, body, sentAfterRefusal }));
          try {
            req.write(Buffer.alloc(64 * 1024, 'x'));
            req.end();
            sentAfterRefusal = true;
          } catch (error) { reject(error); }
        });
        req.on('error', reject);
        req.write(Buffer.alloc(9, 'a'));
      });
      await withTimeout(drained, 1500, 'запрос не был дренирован');
      assert.strictEqual(result.statusCode, 413);
      assert.strictEqual(JSON.parse(result.body).code, 'BODY_TOO_LARGE');
      assert.strictEqual(result.sentAfterRefusal, true);
      assert.strictEqual(received.ended, true);
      assert.strictEqual(received.bytes, 9 + 64 * 1024);
    } finally {
      limitedServer.close();
    }
  });

  check('createErrorCatalog собирает код+поле+подсказку+ссылку (спека §6.2)', () => {
    const derr = core.createErrorCatalog({ provider: 'x', docsBase: 'https://docs.test/base/', codes: { 7: { message: 'M', field: 'F', hint: 'H', doc: '/api/init' } } });
    const e = derr(7);
    assert.strictEqual(e.message, 'M');
    assert.strictEqual(e.field, 'F');
    assert.strictEqual(e.doc, 'https://docs.test/base/api/init');
    assert.ok(derr(999).message.includes('999'));
  });

  check('parseDuration разбирает дни/часы/минуты/мс (этап 7)', () => {
    assert.strictEqual(core.parseDuration('7d'), 7 * 86400000);
    assert.strictEqual(core.parseDuration('+60d'), 60 * 86400000);
    assert.strictEqual(core.parseDuration('36h'), 36 * 3600000);
    assert.strictEqual(core.parseDuration('1d 12h'), 36 * 3600000);
    assert.strictEqual(core.parseDuration(1500), 1500);
    assert.strictEqual(core.parseDuration('invalid'), null);
  });

  check('createVirtualClock сдвигает виртуальное время на +7d / +60d и сбрасывает (этап 7)', () => {
    let savedOffset = 0;
    const clock = core.createVirtualClock({
      initial: '+1h',
      getStateOffset: () => savedOffset,
      setStateOffset: (v) => { savedOffset = v; },
    });
    assert.strictEqual(clock.snapshot().offsetMs, 3600000);
    clock.advance('7d');
    assert.strictEqual(clock.snapshot().offsetMs, 3600000 + 7 * 86400000);
    clock.set({ offset: '60d' });
    assert.strictEqual(clock.snapshot().offsetMs, 60 * 86400000);
    clock.reset();
    assert.strictEqual(clock.snapshot().offsetMs, 0);
  });

  check('createScenarioRegistry объединяет заголовок X-Mock-Scenario, правила и журнал срабатываний', () => {
    const reg = core.createScenarioRegistry();
    reg.addRule({ target: 'init', match: { orderId: 'ord-1' }, scenario: 'chargeback-after:7d', times: 1 });
    const spec = reg.resolve({ header: 'webhook-drop', target: 'init', context: { orderId: 'ord-1' } });
    assert.strictEqual(spec.has('webhook-drop'), true);
    assert.strictEqual(spec.get('chargeback-after'), '7d');
    assert.strictEqual(reg.listRules().length, 0, 'одноразовое правило должно списаться');
    assert.strictEqual(reg.listHistory().length, 1, 'срабатывание должно попасть в журнал');
  });

  check('checkAdminAuth пропускает по умолчанию и проверяет токен при MOCK_ADMIN_TOKEN (A-20)', () => {
    assert.strictEqual(core.checkAdminAuth({ headers: {}, url: '/admin' }, ''), true);
    assert.strictEqual(core.checkAdminAuth({ headers: {}, url: '/admin' }, 'sec-1'), false);
    assert.strictEqual(core.checkAdminAuth({ headers: { authorization: 'Bearer sec-1' }, url: '/admin' }, 'sec-1'), true);
    assert.strictEqual(core.checkAdminAuth({ headers: { 'x-admin-token': 'sec-1' }, url: '/admin' }, 'sec-1'), true);
    assert.strictEqual(core.checkAdminAuth({ headers: {}, url: '/admin?admin_token=sec-1' }, 'sec-1'), true);
  });

  /* --- #22: access-control управляющей поверхности и SSRF-политика ------- */

  check('flagEnabled принимает 1/true и различает явное false (F-08)', () => {
    assert.strictEqual(core.flagEnabled('1'), true);
    assert.strictEqual(core.flagEnabled('true'), true);
    assert.strictEqual(core.flagEnabled('TRUE'), true);
    assert.strictEqual(core.flagEnabled('0'), false);
    assert.strictEqual(core.flagEnabled('false'), false);
    assert.strictEqual(core.flagEnabled(''), false);
    assert.strictEqual(core.flagEnabled('', true), true, 'пустое значение — fallback (hosted-политика)');
    assert.strictEqual(core.flagEnabled('0', true), false, 'явное 0 перебивает fallback');
  });

  check('isPrivateAddress/isPrivateHost различают приватные IPv4/IPv6 и служебные имена (F-08)', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:192.168.0.1']) {
      assert.strictEqual(core.isPrivateAddress(ip), true, `${ip} должен быть приватным`);
    }
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111']) {
      assert.strictEqual(core.isPrivateAddress(ip), false, `${ip} должен быть публичным`);
    }
    assert.strictEqual(core.isPrivateAddress('example.com'), null, 'имя хоста — не IP-литерал');
    assert.strictEqual(core.isPrivateHost('http://[::1]:3100/hook'), true);
    assert.strictEqual(core.isPrivateHost('http://localhost:3100/hook'), true);
    assert.strictEqual(core.isPrivateHost('http://kassa.internal/hook'), true);
    assert.strictEqual(core.isPrivateHost('http://93.184.216.34/hook'), false);
    assert.strictEqual(core.isPrivateHost('file:///etc/passwd'), true, 'чужая схема — блок');
  });

  await acheck('assertPublicHost блокирует приватные адреса, имена и опасные схемы (F-08)', async () => {
    const blocked = async (url, opts) => {
      try {
        await core.assertPublicHost(url, opts);
      } catch (e) {
        assert.strictEqual(e.code, 'SSRF_BLOCKED', `${url}: ожидался код SSRF_BLOCKED, получено ${e.code}`);
        return;
      }
      assert.fail(`${url} должен быть заблокирован`);
    };
    await blocked('http://10.0.0.1/webhook');
    await blocked('http://[::1]:3100/webhook');
    await blocked('http://169.254.169.254/latest/meta-data/');
    await blocked('http://localhost:3100/webhook');
    await blocked('http://mock.local/webhook');
    await blocked('file:///etc/passwd');
    // Имя хоста, разрешающееся в приватный адрес (DNS-rebinding / внутренние имена)
    await blocked('http://internal.example.com/hook', { lookup: async () => [{ address: '10.9.8.7', family: 4 }] });
    await blocked('http://sneaky.example.com/hook', { lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }] });
    await blocked('http://nxdomain.example.com/hook', { lookup: async () => { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; } });
    // Публичные адреса и имена проходят
    assert.strictEqual(await core.assertPublicHost('http://93.184.216.34:8080/hook'), true);
    assert.strictEqual(
      await core.assertPublicHost('https://merchant.example.com/hook', { lookup: async () => [{ address: '93.184.216.34', family: 4 }] }),
      true,
    );
  });

  await acheck('postJson отклоняет не-http(s) схемы до открытия сокета (F-08)', async () => {
    await assert.rejects(() => core.postJson('file:///etc/passwd', { ping: true }), /схема/);
    await assert.rejects(() => core.postJson('gopher://127.0.0.1:11211/_x', { ping: true }), /схема/);
  });

  await acheck('delivery queue с blockPrivateHosts не отправляет на приватный адрес и не роняет цикл (F-08)', async () => {
    let hits = 0;
    const target = http.createServer((req, res) => { hits += 1; res.end('OK'); });
    const targetPort = await listen(target);
    const entries = {
      a: { url: `http://127.0.0.1:${targetPort}/ok`, attempts: 0, nextAttemptAt: 0 },
    };
    const queue = core.createDeliveryQueue({
      entries, retryMs: 200, maxAttempts: 3, log: () => {},
      request: (e) => ({ url: e.url, data: { ping: true } }),
      blockPrivateHosts: true,
    });
    await queue.tick();
    await queue.tick();
    assert.strictEqual(hits, 0, 'запрос на приватный адрес не должен уходить');
    assert.ok(String(entries.a.lastStatus).startsWith('ERR'), `lastStatus должен фиксировать отказ, получено ${entries.a.lastStatus}`);
    assert.ok(String(entries.a.lastStatus).includes('SSRF'), 'причина отказа должна быть явной (SSRF)');
    target.close();
  });

  check('checkControlAccess: роли admin/operator, fallback и hosted fail-closed (F-07)', () => {
    const req = (headers = {}, url = '/mock/state') => ({ headers, url });
    // Локальный режим без токенов — открыт (обратная совместимость)
    assert.strictEqual(core.checkControlAccess(req(), { hosted: false }).allowed, true);
    // Hosted-режим без секрета — fail-closed
    const closed = core.checkControlAccess(req(), { hosted: true });
    assert.strictEqual(closed.allowed, false);
    assert.strictEqual(closed.reason, 'hosted-fail-closed');
    // Operator-поверхность: неверный и верный токен
    const opts = { adminToken: 'adm-secret', operatorToken: 'op-secret', surface: 'operator' };
    assert.strictEqual(core.checkControlAccess(req({ authorization: 'Bearer wrong' }), opts).allowed, false);
    assert.strictEqual(core.checkControlAccess(req({ authorization: 'Bearer op-secret' }), opts).allowed, true);
    assert.strictEqual(core.checkControlAccess(req({ 'x-operator-token': 'op-secret' }), opts).allowed, true);
    assert.strictEqual(core.checkControlAccess(req({}, '/mock/time?operator_token=op-secret'), opts).allowed, true);
    // Fallback: только админ-токен настроен -> он же закрывает operator-поверхность
    assert.strictEqual(core.checkControlAccess(req({ authorization: 'Bearer adm-secret' }), { ...opts, operatorToken: '' }).allowed, true);
    // Admin-поверхность операторским токеном не открывается
    assert.strictEqual(core.checkControlAccess(req({ authorization: 'Bearer op-secret' }), { ...opts, surface: 'admin' }).allowed, false);
    assert.strictEqual(core.checkControlAccess(req({ authorization: 'Bearer adm-secret' }), { ...opts, surface: 'admin' }).allowed, true);
    // Пустой токен при заданном секрете не проходит
    assert.strictEqual(core.checkControlAccess(req({ authorization: 'Bearer ' }), opts).allowed, false);
  });

  check('createJournal формирует curl, shell-экранирует динамику и скрывает query-токены (F-04)', () => {
    const j = core.createJournal({ baseUrl: 'http://localhost:3100' });
    j.record({ method: 'POST', path: '/v2/Init', status: 200, ms: 5, body: { OrderId: 'o-1', Amount: '1000' }, headers: { 'x-mock-scenario': 'webhook-drop' } });
    const entry = j.list()[0];
    assert.ok(entry.curl.includes("curl -sS -X 'POST' 'http://localhost:3100/v2/Init'"));
    assert.ok(entry.curl.includes("-H 'X-Mock-Scenario: webhook-drop'"));

    const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
    const maliciousPath = "/v1/'$(printf injected)";
    const maliciousMethod = "PO'ST$(printf method)";
    const command = core.buildCurlCommand({
      baseUrl: 'http://example.test',
      method: maliciousMethod,
      path: maliciousPath,
      headers: { 'x-mock-scenario': "drop'$(printf header)" },
      rawBody: "{\"value\":\"'$(printf body)\"}",
    });
    assert.ok(command.includes(quote(maliciousMethod)), 'method должен быть shell-quoted');
    assert.ok(command.includes(quote(`http://example.test${maliciousPath}`)), "path с ' и $() должен оставаться внутри shell quotes");
    assert.ok(command.includes(quote("X-Mock-Scenario: drop'$(printf header)")), 'динамический header должен быть shell-quoted');
    assert.ok(command.includes(quote("{\"value\":\"'$(printf body)\"}")), 'body должен быть shell-quoted');

    const secretJournal = core.createJournal({ baseUrl: 'http://localhost:3101' });
    secretJournal.record({ method: 'GET', path: '/possystem/v1/report/id?token=ferma-secret&view=full' });
    const tokenEntry = secretJournal.list()[0];
    assert.ok(tokenEntry.path.includes('token=YOUR_TOKEN'), tokenEntry.path);
    assert.ok(tokenEntry.curl.includes('token=YOUR_TOKEN'), tokenEntry.curl);
    assert.ok(!tokenEntry.path.includes('ferma-secret') && !tokenEntry.curl.includes('ferma-secret'));
  });

  check('createSandboxManager изолирует песочницы по X-Mock-Sandbox и сохраняет ссылки state', () => {
    const st = { payments: {}, notifications: {} };
    const notifRef = st.notifications;
    const sb = core.createSandboxManager({
      state: st,
      initialStateFactory: () => ({ payments: {}, notifications: {} }),
    });
    assert.strictEqual(Object.getPrototypeOf(st.payments), null, 'state dictionary должен быть null-prototype даже до import/restore');
    st.payments.p1 = { id: 'p1' };
    sb.switchTo('ci-run-2');
    assert.strictEqual(st.notifications, notifRef, 'идентичность ссылок должна сохраняться при переключении песочницы');
    assert.strictEqual(Object.keys(st.payments).length, 0, 'новая песочница чистая');
    st.payments.p2 = { id: 'p2' };
    sb.switchTo('default');
    assert.ok(st.payments.p1 && !st.payments.p2, 'песочница default сохранила p1');
  });

  // Проверка активного экзаменатора вебхуков мерчанта (verifyMerchantWebhook)
  const merchSrv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const payload = JSON.parse(raw || '{}');
      if (payload.Token === 'f'.repeat(64)) {
        res.writeHead(403);
        res.end('BAD_SIGN');
        return;
      }
      res.writeHead(200);
      res.end('OK');
    });
  });
  const merchPort = await listen(merchSrv);
  const examReport = await core.verifyMerchantWebhook({
    url: `http://127.0.0.1:${merchPort}/webhook`,
    provider: 'tbank-eacq',
    signPayload: () => 'a'.repeat(64),
  });
  check('verifyMerchantWebhook проверяет валидный вебхук, дубль и отклонение поддельного Token', () => {
    assert.strictEqual(examReport.readyForProd, true);
    assert.strictEqual(examReport.passed, 3);
    assert.strictEqual(examReport.total, 3);
  });
  merchSrv.close();

  hook.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nИТОГ: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('selftest crashed:', e); process.exit(1); });
