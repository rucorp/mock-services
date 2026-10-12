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

  /* ------------------------------------------------------- GET-доставка */
  await acheck('delivery queue доставляет GET-callback без тела (request(entry).method — для Альфа-Банка)', async () => {
    const seen = [];
    const fixture = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body, contentType: req.headers['content-type'] || null });
        res.writeHead(200);
        res.end('OK');
      });
    });
    const fixturePort = await listen(fixture);
    try {
      const entries = {
        g: { url: `http://127.0.0.1:${fixturePort}/callback?mdOrder=abc&checksum=DEADBEEF`, attempts: 0, nextAttemptAt: 0 },
      };
      const queue = core.createDeliveryQueue({
        entries,
        retryMs: 100,
        maxAttempts: 2,
        log: () => {},
        request: (e) => ({ url: e.url, method: 'GET' }),
      });
      await queue.tick();
      await sleep(250);
      assert.strictEqual(entries.g.done, true, 'GET-доставка не помечена done');
      assert.strictEqual(seen.length, 1, `ожидался ровно один GET, получено ${seen.length}`);
      assert.strictEqual(seen[0].method, 'GET');
      assert.strictEqual(seen[0].url, '/callback?mdOrder=abc&checksum=DEADBEEF', 'query-параметры должны сохраниться');
      assert.strictEqual(seen[0].body, '', 'GET обязан отправляться без тела');
      assert.strictEqual(seen[0].contentType, null, 'GET без Content-Type: application/json');
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

  await acheck('HTTP 413 корректно отвечает и дренирует тело, отправленное после внутреннего отказа (F-02)', async () => {
    const received = { bytes: 0, ended: false };
    let resolveDrained;
    let resolveRefused;
    const drained = new Promise((resolve) => { resolveDrained = resolve; });
    const refused = new Promise((resolve) => { resolveRefused = resolve; });
    const limitedServer = http.createServer((req, res) => {
      req.on('data', (chunk) => { received.bytes += Buffer.byteLength(chunk); });
      req.on('end', () => { received.ended = true; resolveDrained(); });
      core.readBody(req, 8).then(
        (body) => core.sendJson(res, { body }),
        (error) => {
          resolveRefused();
          // Даём клиенту отправить остаток уже после reject readBody, пока
          // ответ ещё не закрывает его write-side (поведение одинаково в Node 18+).
          setTimeout(() => core.sendJson(res, { code: error.code }, error.statusCode || 500), 50);
        },
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
        });
        req.on('error', reject);
        req.write(Buffer.alloc(9, 'a'));
        refused.then(() => {
          try {
            req.write(Buffer.alloc(64 * 1024, 'x'));
            req.end();
            sentAfterRefusal = true;
          } catch (error) { reject(error); }
        }, reject);
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

  check('createVirtualClock валидирует Date-диапазон до записи state и восстанавливается после отказа (F-05)', () => {
    let savedOffset = 0;
    const clock = core.createVirtualClock({
      getStateOffset: () => savedOffset,
      setStateOffset: (v) => { savedOffset = v; },
      log: () => {},
    });
    for (const spec of [
      { offsetMs: Number.MAX_VALUE },
      { offset: '9999999999999d' },
      { advance: '9999999999999d' },
    ]) {
      assert.throws(() => clock.set(spec), /вне диапазона|представимо Date/);
      assert.strictEqual(savedOffset, 0, `невалидный offset не должен persist-иться: ${JSON.stringify(spec)}`);
      assert.strictEqual(clock.snapshot().offsetMs, 0);
    }
    assert.strictEqual(clock.advance('7d').offsetMs, 7 * 86400000);
    assert.strictEqual(savedOffset, 7 * 86400000);
    assert.strictEqual(clock.reset().offsetMs, 0);

    let poisoned = Number.MAX_VALUE;
    const restored = core.createVirtualClock({ getStateOffset: () => poisoned, setStateOffset: (v) => { poisoned = v; }, log: () => {} });
    assert.strictEqual(restored.snapshot().offsetMs, 0, 'старый невалидный state не должен ломать snapshot');
    assert.strictEqual(restored.advance('1h').offsetMs, 3600000, 'после восстановления часы снова работают');
  });

  check('parseMoneyKopeks строго принимает целые копейки и отклоняет prefix/trailing junk и дроби (F-24)', () => {
    assert.deepStrictEqual(core.parseMoneyKopeks('1000'), { ok: true, value: 1000 });
    assert.deepStrictEqual(core.parseMoneyKopeks(1000), { ok: true, value: 1000 });
    for (const raw of ['1000xyz', '1000.9', '+1000', ' 1000', '0x10', 1000.9, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      assert.strictEqual(core.parseMoneyKopeks(raw).ok, false, `должно быть отклонено: ${JSON.stringify(raw)}`);
    }
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

  check('resolveTenancyMode принимает литералы и legacy-флаги, а неизвестное значение безопасно откатывает с warn (#31)', () => {
    const warnings = [];
    const parse = (value, hosted = false) => core.resolveTenancyMode(value, hosted, (message) => warnings.push(message));
    for (const value of ['1', 'on', 'true', 'yes', 'owned', 'OWNED']) assert.strictEqual(parse(value), 'owned', `${value} → owned`);
    for (const value of ['0', 'off', 'false', 'no']) assert.strictEqual(parse(value), 'off', `${value} → off`);
    assert.strictEqual(parse('namespaces'), 'namespaces');
    assert.strictEqual(parse('  '), 'namespaces', 'пустое значение self-hosted → namespaces');
    assert.strictEqual(parse('', true), 'owned', 'пустое значение hosted → owned');
    assert.strictEqual(parse('typo'), 'namespaces', 'неизвестное значение self-hosted → безопасный default');
    assert.strictEqual(parse('typo', true), 'owned', 'неизвестное значение hosted → безопасный default');
    assert.strictEqual(warnings.length, 2, 'warn только для двух неизвестных значений');
    assert.ok(warnings.every((message) => message.includes('MOCK_TENANCY')));
    assert.ok(warnings[1].includes('owned'));
  });

  check('CSRF-токены подписаны, истекают и привязаны к контексту; Origin режет cross-site формы (A-20)', () => {
    const secret = 'selftest-csrf-secret';
    const token = core.createCsrfToken(secret, 'sandbox-a', 1000, 10);
    assert.strictEqual(core.verifyCsrfToken(token, secret, 'sandbox-a', 1009), true);
    assert.strictEqual(core.verifyCsrfToken(token, secret, 'sandbox-b', 1009), false);
    assert.strictEqual(core.verifyCsrfToken(token, 'wrong-secret', 'sandbox-a', 1009), false);
    assert.strictEqual(core.verifyCsrfToken(`${token}x`, secret, 'sandbox-a', 1009), false);
    assert.strictEqual(core.verifyCsrfToken(token, secret, 'sandbox-a', 1010), false, 'токен истекает на границе TTL');
    assert.strictEqual(core.isSameOriginRequest({ headers: { host: 'mock.test:3100', origin: 'http://mock.test:3100' } }), true);
    assert.strictEqual(core.isSameOriginRequest({ headers: { host: 'mock.test:3100', origin: 'https://attacker.test' } }), false);
    assert.strictEqual(core.isSameOriginRequest({ headers: { host: 'mock.test:3100', 'sec-fetch-site': 'cross-site' } }), false);
    assert.strictEqual(core.isSameOriginRequest({ headers: { host: 'mock.test:3100', 'sec-fetch-site': 'same-site' } }), false);
    assert.strictEqual(core.isSameOriginRequest({
      headers: {
        host: 'mock.test:3100', origin: 'https://attacker.test',
        'x-forwarded-host': 'attacker.test', 'x-forwarded-proto': 'https',
      },
    }), false, 'нельзя подменить target через untrusted X-Forwarded-Host');
    assert.strictEqual(core.isSameOriginRequest({ headers: { host: 'mock.test:3100' } }), true, 'CLI без Origin опирается на CSRF-токен');
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

  check('isPrivateAddress: IPv4-mapped в dotted и hex форме и 4-частная SIIT-форма (#45, SSRF-обход)', () => {
    // dotted и hex — обе формы, в которых WHATWG-парсер отдаёт адрес (new URL нормализует в hex)
    for (const ip of [
      '::ffff:127.0.0.1', '::ffff:7f00:1',
      '::ffff:169.254.169.254', '::ffff:a9fe:a9fe',
      '::ffff:10.0.0.1', '::ffff:0a00:1',
      '::ffff:192.168.0.1', '::ffff:c0a8:1',
      '0:0:0:0:0:ffff:7f00:1', '[::ffff:7f00:1]',
      '::ffff:0:7f00:1', '::ffff:0:127.0.0.1', '::ffff:0:a9fe:a9fe', // 4-частная (SIIT ::ffff:0:0/96)
      '::ffff:0:0', '::ffff:0:1:2',
    ]) {
      assert.strictEqual(core.isPrivateAddress(ip), true, `${ip} должен быть приватным`);
    }
    for (const ip of ['::ffff:8.8.8.8', '::ffff:808:808']) {
      assert.strictEqual(core.isPrivateAddress(ip), false, `${ip}: встроенный публичный IPv4 — публичный адрес`);
    }
  });

  check('isPrivateAddress: NAT64 64:ff9b::/96 решается по встроенному IPv4 (#45)', () => {
    for (const ip of ['64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::a00:1', '64:ff9b::127.0.0.1', '[64:ff9b::a9fe:a9fe]']) {
      assert.strictEqual(core.isPrivateAddress(ip), true, `${ip} должен быть приватным`);
    }
    // DNS64 отдаёт так IPv4-only хосты публичных сетей — они не должны блокироваться
    assert.strictEqual(core.isPrivateAddress('64:ff9b::808:808'), false, 'NAT64 к публичному IPv4 — публичный');
  });

  check('isPrivateAddress: публичные IPv6 не задеты, hex-подобные имена — это имена (#45)', () => {
    for (const ip of ['2606:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::1', '2400:cb00::1', '::ffff:0:0:0:1']) {
      assert.strictEqual(core.isPrivateAddress(ip), false, `${ip} должен быть публичным`);
    }
    // Имена из hex-символов без двоеточия раньше классифицировались как публичный IPv6 и не проверялись DNS
    for (const name of ['dead', 'cafe', 'bee', 'add', 'face']) {
      assert.strictEqual(core.isPrivateAddress(name), null, `${name} — имя хоста, не IP-литерал`);
    }
    // Битый IPv6-литерал — блок (fail-closed), как и битый IPv4
    for (const ip of ['1:2:3:4:5:6:7:8:9', '1::2::3', ':1', '::ffff:999.1.1.1']) {
      assert.strictEqual(core.isPrivateAddress(ip), true, `${ip}: битый литерал — блок`);
    }
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

  await acheck('assertPublicHost: URL со скобками (IPv4-mapped, NAT64) → SSRF_BLOCKED (#45)', async () => {
    const blocked = async (url) => {
      try {
        await core.assertPublicHost(url);
      } catch (e) {
        assert.strictEqual(e.code, 'SSRF_BLOCKED', `${url}: ожидался SSRF_BLOCKED, получено ${e.code}`);
        return;
      }
      assert.fail(`${url} должен быть заблокирован`);
    };
    // Обе формы: WHATWG отдаёт hex, пользователь может написать dotted
    await blocked('http://[::ffff:127.0.0.1]:3100/webhook');
    await blocked('http://[::ffff:7f00:1]:3100/webhook');
    await blocked('http://[::ffff:169.254.169.254]/latest/meta-data/');
    await blocked('http://[::ffff:a9fe:a9fe]/latest/meta-data/');
    await blocked('http://[::ffff:0:7f00:1]/webhook');
    await blocked('http://[64:ff9b::7f00:1]/webhook');
    await blocked('http://[64:ff9b::a9fe:a9fe]/latest/meta-data/');
    // Публичный IPv6-литерал по-прежнему проходит без DNS
    assert.strictEqual(await core.assertPublicHost('http://[2606:4700::1111]:8080/hook'), true);
  });

  await acheck('assertPublicHost: hex-подобное имя проходит через DNS-проверку (#45)', async () => {
    let calls = 0;
    const lookup = async (host) => {
      calls += 1;
      assert.strictEqual(host, 'dead');
      return [{ address: '10.0.0.5', family: 4 }];
    };
    await assert.rejects(
      () => core.assertPublicHost('http://dead:8080/hook', { lookup }),
      (e) => e.code === 'SSRF_BLOCKED',
    );
    assert.strictEqual(calls, 1, 'имя dead должно разрешаться и проверяться');
  });

  await acheck('verifyMerchantWebhook с blockPrivateHosts: IPv4-mapped цель не получает ни одного соединения (#45, регресс)', async () => {
    // Живой listener на эфемерном порту: доказываем, что запрос до него не дошёл
    let hits = 0;
    const server = http.createServer((req, res) => { res.end('OK'); });
    server.on('connection', () => { hits += 1; });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address();
      await assert.rejects(
        () => core.verifyMerchantWebhook({ url: `http://[::ffff:127.0.0.1]:${port}/hook`, blockPrivateHosts: true }),
        (e) => e.code === 'SSRF_BLOCKED',
      );
      assert.strictEqual(hits, 0, 'соединение с приватным адресом не должно открываться');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
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
    // F-28: multibyte-токен той же JS-длины, что и секрет, — сравнение идёт по
    // байтам и не бросает RangeError в timingSafeEqual
    const multiToken = '⚡'.repeat('op-secret'.length);
    assert.strictEqual(multiToken.length, 'op-secret'.length);
    assert.notStrictEqual(Buffer.byteLength(multiToken), 'op-secret'.length);
    assert.strictEqual(core.checkControlAccess(req({ authorization: `Bearer ${multiToken}` }), opts).allowed, false);
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

  check('redactSecrets рекурсивно скрывает секреты, PAN и PII, не трогая обычные поля (F-09)', () => {
    const sentinelPass = `sentinel-pass-${process.pid}`;
    const redacted = core.redactSecrets({
      Authorization: 'Basic cGFydG5lcjpzZWNyZXQ=',
      Cookie: 'session=abc123',
      login: 'loviitest',
      pass: sentinelPass,
      access_token: 'mock-acqapi-bearer-1234567890',
      CardData: { PAN: '5000000000000553', CVV: '123', ExpDate: '1227' },
      Description: 'выплата на карту 5000 0000 0000 0553 или 2201382000000013',
      PayerInn: '7801111111',
      Phone: '+79211234567',
      Email: 'ivan@example.com',
      Amount: '20000',
      nested: [{ Password: 'x', note: 'без секретов' }],
    });
    assert.strictEqual(redacted.Authorization, core.REDACTED);
    assert.strictEqual(redacted.Cookie, core.REDACTED);
    assert.strictEqual(redacted.login, core.REDACTED);
    assert.strictEqual(redacted.pass, core.REDACTED);
    assert.strictEqual(redacted.access_token, core.REDACTED);
    assert.strictEqual(redacted.CardData, core.REDACTED, 'CardData — контейнер реквизитов, скрывается целиком');
    assert.strictEqual(redacted.Description, 'выплата на карту 500000**0553 или 220138**0013');
    assert.strictEqual(redacted.PayerInn, '7801******');
    assert.strictEqual(redacted.Phone, '***4567');
    assert.strictEqual(redacted.Email, 'iv***@example.com');
    assert.strictEqual(redacted.Amount, '20000', 'не секрет — остаётся для отладки');
    assert.strictEqual(redacted.nested[0].Password, core.REDACTED);
    assert.strictEqual(redacted.nested[0].note, 'без секретов');
    const serialized = JSON.stringify(redacted);
    assert.ok(!serialized.includes(sentinelPass), 'пароль не должен остаться в дереве');
    assert.ok(!serialized.includes('5000000000000553'), 'PAN не должен остаться в дереве');
  });

  check('redactSecrets не переносит __proto__ и ограничивает глубину (F-01/F-09)', () => {
    const pollutedKey = `f09_redact_${process.pid}`;
    const dirty = JSON.parse(`{"__proto__":{"${pollutedKey}":true},"safe":"значение"}`);
    const clean = core.redactSecrets(dirty);
    assert.strictEqual(Object.prototype[pollutedKey], undefined);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, pollutedKey), false);
    assert.strictEqual(clean.safe, 'значение');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(clean, '__proto__'), false);

    let deep = {};
    const tail = deep;
    for (let i = 0; i < 30; i += 1) { deep.next = { level: i }; deep = deep.next; }
    const flat = JSON.stringify(core.redactSecrets(tail));
    assert.ok(flat.length < 2000, `глубина должна быть ограничена: ${flat.length}`);
    assert.ok(flat.includes('[…]'), 'на предельной глубине — маркер, не рекурсия');
  });

  check('PAN-сканер маскирует только номера карт: Luhn + префикс платёжной системы (F-10)', () => {
    assert.strictEqual(core.looksLikePan('5000000000000553'), true);
    assert.strictEqual(core.looksLikePan('5000 0000 0000 0553'), true);
    assert.strictEqual(core.looksLikePan('2201382000000013'), true);
    assert.strictEqual(core.looksLikePan('1234567890123456'), false, 'не платёжный префикс');
    assert.strictEqual(core.looksLikePan(String(Date.now())), false, '13-значный таймстамп — не PAN');
    assert.strictEqual(core.maskPan('5000000000000553'), '500000**0553');
    assert.strictEqual(
      core.redactSecretsInText('карта 5000000000000553, заказ 1234567890123456'),
      'карта 500000**0553, заказ 1234567890123456',
    );
    assert.strictEqual(core.redactSecretsInText('Bearer mock-acqapi-bearer-1234567890'), 'Bearer [REDACTED]');
  });

  check('redactRawBody понимает JSON, form-urlencoded и произвольный текст (F-09)', () => {
    assert.strictEqual(
      core.redactRawBody('{"login":"loviitest","pass":"secret-value"}'),
      '{"login":"[REDACTED]","pass":"[REDACTED]"}',
    );
    assert.strictEqual(
      core.redactRawBody('pan=5000000000000553&exp=1227&cvv=123&amount=100'),
      'pan=[REDACTED]&exp=1227&cvv=[REDACTED]&amount=100',
    );
    assert.strictEqual(
      core.redactRawBody('свободный текст с картой 2201382000000013'),
      'свободный текст с картой 220138**0013',
    );
    assert.strictEqual(core.redactRawBody(''), '');
  });

  check('createJournal: креды и PAN не попадают в запись, JSON и curl; запись ограничена по длине (F-09)', () => {
    const sentinelPass = `sentinel-pass-${process.pid}`;
    const j = core.createJournal({ baseUrl: 'http://localhost:3101' });
    j.record({
      method: 'POST',
      path: '/possystem/v1/getToken',
      status: 200,
      ms: 4,
      body: { error: null, timestamp: '2026-10-11T00:00:00Z', token: 'issued-token-123456' },
      rawBody: JSON.stringify({ login: 'loviitest', pass: sentinelPass }),
      headers: {
        authorization: 'Basic cGFydG5lcjpzZWNyZXQ=',
        cookie: 'sid=abc',
        'content-type': 'application/json',
        'x-mock-scenario': 'fail',
      },
    });
    j.record({
      method: 'POST',
      path: '/e2c/v2/Init',
      status: 200,
      ms: 6,
      body: core.summarizeBody({ TerminalKey: 'T', Amount: '20000', Pan: '5000000000000553', OrderId: 'p-1' }),
      headers: { authorization: 'Bearer mock-acqapi-bearer-1234567890', 'content-type': 'application/json' },
    });

    const serialized = JSON.stringify(j.list());
    assert.ok(!serialized.includes(sentinelPass), 'пароль Ferma не должен храниться в журнале');
    assert.ok(!serialized.includes('loviitest'), 'логин Ferma не должен храниться в журнале');
    assert.ok(!serialized.includes('cGFydG5lcjpzZWNyZXQ'), 'Authorization не должен храниться в журнале');
    assert.ok(!serialized.includes('mock-acqapi-bearer'), 'Bearer-токен не должен храниться в журнале');
    assert.ok(!serialized.includes('5000000000000553'), 'PAN не должен храниться в журнале');
    assert.ok(!serialized.includes('issued-token-123456'), 'выданный токен не должен храниться в журнале');

    const [getTokenEntry, initEntry] = j.list();
    assert.strictEqual(getTokenEntry.headers.authorization, undefined, 'allowlist заголовков должен отбросить Authorization');
    assert.strictEqual(getTokenEntry.headers.cookie, undefined);
    assert.strictEqual(getTokenEntry.headers['x-mock-scenario'], 'fail', 'служебные X-Mock-* остаются для отладки');
    assert.strictEqual(getTokenEntry.body.token, core.REDACTED);
    assert.strictEqual(getTokenEntry.rawBody, '{"login":"[REDACTED]","pass":"[REDACTED]"}');
    assert.ok(getTokenEntry.curl.includes('"pass":"[REDACTED]"'), getTokenEntry.curl);
    assert.strictEqual(initEntry.body.Pan, core.REDACTED);
    assert.strictEqual(initEntry.body.OrderId, 'p-1', 'не секретные поля остаются читаемыми');

    const capped = core.createJournal({ baseUrl: 'http://localhost:3101', maxEntryChars: 600 });
    capped.record({
      method: 'POST',
      path: `/possystem/v1/Main/sell?${'q'.repeat(4000)}`,
      status: 200,
      ms: 1,
      body: { note: 'x'.repeat(4000) },
      rawBody: `{"note":"${'y'.repeat(5000)}"}`,
    });
    const cappedEntry = capped.list()[0];
    const cappedLength = JSON.stringify(cappedEntry).length;
    assert.ok(cappedLength <= 600, `длина записи должна быть ограничена 600, получено ${cappedLength}`);
    assert.ok(cappedEntry.path.length <= 513, 'путь ограничен');
    assert.ok(cappedEntry.rawBody.length < 1100, 'сырое тело ограничено');
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

  /* --- #8 (F-11—F-15): request-local песочницы RFC-001 -------------------- */

  await acheck('createSandboxRuntime: запросы A/B не смешивают state между await', async () => {
    const raw = { payments: {}, notifications: {} };
    const rt = core.createSandboxRuntime({
      state: raw,
      initialStateFactory: () => ({ payments: {}, notifications: {} }),
      mode: 'namespaces',
      log: () => {},
    });
    const state = rt.state;
    const job = (id, orderId) => {
      const admission = rt.admit({ headers: { 'x-mock-sandbox': id }, url: '/' }, 'business');
      return rt.run(admission, async () => {
        await sleep(20);
        state.payments[orderId] = { orderId };
        return rt.currentId();
      });
    };
    const [a, b] = await Promise.all([job('ci-a', 'p-a'), job('ci-b', 'p-b')]);
    assert.strictEqual(a, 'ci-a');
    assert.strictEqual(b, 'ci-b');
    const admitA = rt.admit({ headers: { 'x-mock-sandbox': 'ci-a' }, url: '/' }, 'business');
    const admitB = rt.admit({ headers: { 'x-mock-sandbox': 'ci-b' }, url: '/' }, 'business');
    rt.run(admitA, () => assert.deepStrictEqual(Object.keys(state.payments), ['p-a']));
    rt.run(admitB, () => assert.deepStrictEqual(Object.keys(state.payments), ['p-b']));
    // запрос без селектора не остаётся в предыдущей песочнице
    const plain = rt.admit({ headers: {}, url: '/' }, 'business');
    assert.strictEqual(plain.record.id, 'default');
    rt.run(plain, () => assert.deepStrictEqual(Object.keys(state.payments), []));
  });

  await acheck('createSandboxRuntime: owned-режим — owner-token, знание ID ≠ доступ', () => {
    const rt = core.createSandboxRuntime({
      state: {},
      initialStateFactory: () => ({ payments: {} }),
      mode: 'owned',
      operatorTokens: ['op-secret'],
      log: () => {},
    });
    const created = rt.create({ id: 'owned-a', creds: { terminalKey: 'K', terminalPassword: 'P' } });
    assert.ok(created.ownerToken && created.ownerToken.startsWith('sbx_'));
    assert.strictEqual(created.creds.terminalKey, 'K');
    const idOnly = rt.admit({ headers: { 'x-mock-sandbox': 'owned-a' }, url: '/' }, 'business');
    assert.strictEqual(idOnly.ok, false);
    assert.strictEqual(idOnly.kind, 'unauthorized');
    const wrong = rt.admit({ headers: { 'x-mock-sandbox': 'owned-a', 'x-sandbox-token': 'nope' }, url: '/' }, 'business');
    assert.strictEqual(wrong.kind, 'unauthorized');
    const right = rt.admit({ headers: { 'x-mock-sandbox': 'owned-a', authorization: `Bearer ${created.ownerToken}` }, url: '/' }, 'business');
    assert.strictEqual(right.ok, true);
    assert.strictEqual(right.via, 'owner');
    const operator = rt.admit({ headers: { 'x-mock-sandbox': 'owned-a', authorization: 'Bearer op-secret' }, url: '/' }, 'business');
    assert.strictEqual(operator.via, 'operator');
    const unknown = rt.admit({ headers: { 'x-mock-sandbox': 'ghost' }, url: '/' }, 'business');
    assert.strictEqual(unknown.kind, 'not-found');
    rt.run(right, () => assert.strictEqual(rt.creds().terminalKey, 'K'));
  });

  await acheck('createSandboxRuntime: TTL-очистка и персистентность реестра без relabel default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-sbx-'));
    const stateFile = path.join(dir, 'state.json');
    try {
      const first = core.createSandboxRuntime({
        state: { payments: {} },
        initialStateFactory: () => ({ payments: {} }),
        mode: 'namespaces',
        stateFile,
        log: () => {},
      });
      const admission = first.admit({ headers: { 'x-mock-sandbox': 'kept' }, url: '/' }, 'business');
      first.run(admission, () => { first.state.payments.kept = { id: 'kept' }; first.persist(); });
      first.flush();
      assert.ok(fs.existsSync(`${stateFile}.sandboxes.json`), 'реестр песочниц должен быть записан');

      const second = core.createSandboxRuntime({
        state: { payments: {} },
        initialStateFactory: () => ({ payments: {} }),
        mode: 'namespaces',
        stateFile,
        log: () => {},
      });
      assert.deepStrictEqual(Object.keys(second.find('kept').state.payments), ['kept']);
      assert.deepStrictEqual(Object.keys(second.find('default').state.payments), [], 'чужой state не должен приписываться default');
      assert.strictEqual(second.list().filter((s) => s.id === 'default').length, 1);
      assert.deepStrictEqual(second.importState({ payments: { x: {} } }, 'target').sandbox, 'target');
      assert.deepStrictEqual(Object.keys(second.find('kept').state.payments), ['kept'], 'соседние песочницы не меняются');

      const ttl = core.createSandboxRuntime({
        state: {},
        initialStateFactory: () => ({}),
        mode: 'namespaces',
        ttlMs: 10,
        log: () => {},
      });
      ttl.admit({ headers: { 'x-mock-sandbox': 'short' }, url: '/' }, 'business');
      return sleep(30).then(() => {
        assert.strictEqual(ttl.sweep().expired, 1);
        assert.strictEqual(ttl.find('short'), null);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await acheck('createDeliveryQueue: entries-функция отправляет записи каждой песочницы', async () => {
    const hits = [];
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => { hits.push(JSON.parse(raw || '{}').mark); res.writeHead(200); res.end('OK'); });
    });
    const port = await listen(srv);
    const first = { n1: { id: 'n1', url: `http://127.0.0.1:${port}/hook`, payload: { mark: 'first' }, attempts: 0, nextAttemptAt: 0 } };
    const second = { n2: { id: 'n2', url: `http://127.0.0.1:${port}/hook`, payload: { mark: 'second' }, attempts: 0, nextAttemptAt: 0 } };
    let current = first;
    const queue = core.createDeliveryQueue({
      entries: () => current,
      retryMs: 1000,
      maxAttempts: 3,
      awaitSequential: true, // в тесте ждём доставку целиком, без гонки с tick
      log: () => {},
      request: (entry) => ({ url: entry.url, data: entry.payload }),
      isOk: () => true,
    });
    await queue.tick();
    current = second;
    await queue.tick();
    assert.deepStrictEqual(hits.sort(), ['first', 'second']);
    srv.close();
  });

  await acheck('createDeliveryQueue: awaitSequential — порядок без повторов при медленном первом вебхуке (F-29)', async () => {
    // Приёмник задерживает ОТВЕТ на первую запись дольше, чем любой интервал
    // тиков: вторая запись не должна начать уходить, пока первая «в полёте» —
    // ни внутри тика, ни при наложении следующего тика.
    const events = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const { mark } = JSON.parse(raw || '{}');
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        events.push(`${mark}:arrive`);
        setTimeout(() => {
          concurrent -= 1;
          events.push(`${mark}:respond`);
          res.writeHead(200);
          res.end('OK');
        }, mark === 'first' ? 250 : 0);
      });
    });
    const port = await listen(srv);
    const entries = {
      n1: { id: 'n1', url: `http://127.0.0.1:${port}/hook`, payload: { mark: 'first' }, attempts: 0, nextAttemptAt: 0 },
      n2: { id: 'n2', url: `http://127.0.0.1:${port}/hook`, payload: { mark: 'second' }, attempts: 0, nextAttemptAt: 0 },
    };
    const queue = core.createDeliveryQueue({
      entries,
      retryMs: 1000,
      maxAttempts: 3,
      awaitSequential: true,
      log: () => {},
      request: (entry) => ({ url: entry.url, data: entry.payload }),
      isOk: () => true,
      prepare: (entry) => { entry.attempts += 1; },
    });
    // Наложившиеся тики не должны ни ускорить вторую запись, ни продублировать первую
    await Promise.all([queue.tick(), queue.tick(), queue.tick()]);
    assert.deepStrictEqual(events, ['first:arrive', 'first:respond', 'second:arrive', 'second:respond'], 'вторая запись ждёт завершения первой, порядок сохраняется');
    assert.strictEqual(maxConcurrent, 1, 'параллельных POST быть не должно');
    assert.strictEqual(entries.n1.attempts, 1, 'первая запись отправлена ровно один раз');
    assert.strictEqual(entries.n2.attempts, 1, 'вторая запись отправлена ровно один раз');
    assert.strictEqual(entries.n1.done && entries.n2.done, true, 'обе записи завершены');
    srv.close();
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
