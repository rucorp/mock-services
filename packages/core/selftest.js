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

  check('restore() сохраняет идентичность state.notifications (очередь видит восстановленные записи)', () => {
    assert.strictEqual(consumer.state.notifications, queueRef, 'объект подменён — очередь смотрит в пустой объект');
    assert.strictEqual(consumer.state.notifications['1'].url, 'http://x/');
  });

  check('restore() удаляет ключи, которых нет в файле (не тащит мусор прошлого процесса)', () => {
    const fresh = core.createStore({ stateFile, log: () => {} });
    fresh.state.notifications = { ghost: { id: 'ghost' } }; // «мусор» нового процесса
    fresh.restore();
    assert.ok(!fresh.state.notifications.ghost, 'ключ ghost должен исчезнуть');
    assert.ok(fresh.state.notifications['1'], 'запись из файла должна остаться');
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

  check('createErrorCatalog собирает код+поле+подсказку+ссылку (спека §6.2)', () => {
    const derr = core.createErrorCatalog({ provider: 'x', docsBase: 'https://docs.test/base/', codes: { 7: { message: 'M', field: 'F', hint: 'H', doc: '/api/init' } } });
    const e = derr(7);
    assert.strictEqual(e.message, 'M');
    assert.strictEqual(e.field, 'F');
    assert.strictEqual(e.doc, 'https://docs.test/base/api/init');
    assert.ok(derr(999).message.includes('999'));
  });

  hook.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nИТОГ: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('selftest crashed:', e); process.exit(1); });
