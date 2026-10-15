// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Image smoke для docker-образа моков (F-35/F-36/F-37).
 *
 *   node scripts/docker-smoke.js                          # сборка + проверки
 *   MOCK_SMOKE_IMAGE=mock-services:local MOCK_SMOKE_SKIP_BUILD=1 node scripts/docker-smoke.js
 *
 * Что проверяется (всё то, что нельзя увидеть из compose-стенда):
 *   1. tbank-mock (CMD по умолчанию) и kassa-mock (команда из шапки Dockerfile,
 *      БЕЗ переменных healthcheck) становятся healthy со стандартным
 *      HEALTHCHECK образа — F-35 (kassa слушает /healthz, а не /health); sber-mock
 *      на :3105, vtb-mock на :3106 и first-ofd-mock на :3107 также проверяются
 *      с явными портовыми парами, kontur-ofd-mock (:3108) и taxcom-mock (:3109) —
 *      с эфемерным host-портом и прогоном HTTP selftest внутри контейнера;
 *   2. процессы идут от непривилегированного UID 10001 — F-36;
 *   3. persist/restore переживает --read-only rootfs с volume /data: Init
 *      до рестарта виден после рестарта — F-36;
 *   4. healthcheck продолжает работать при --read-only rootfs — F-35/F-36;
 *   5. MS-04: контейнер с полным набором харденинг-флагов compose
 *      (--init --read-only --tmpfs /tmp --cap-drop ALL --security-opt
 *      no-new-privileges --pids-limit 256) здоров, по SIGTERM (`docker stop`)
 *      выходит сам с кодом 0 не дольше 2 с, а отложенная (debounced) запись
 *      состояния песочницы переживает рестарт того же контейнера.
 *
 * Zero dependencies. Нужен docker CLI и демон. Код возврата 0 — всё зелёное.
 */

const { execFileSync } = require('child_process');
const http = require('http');

const IMAGE = process.env.MOCK_SMOKE_IMAGE || 'mock-services:smoke';
const SKIP_BUILD = /^(1|true|yes|on)$/i.test(process.env.MOCK_SMOKE_SKIP_BUILD || '');
const PREFIX = `mock-smoke-${process.pid}`;
const NAME_TBANK = `${PREFIX}-tbank`;
const NAME_KASSA = `${PREFIX}-kassa`;
const NAME_SBER = `${PREFIX}-sber`;
const NAME_VTB = `${PREFIX}-vtb`;
const NAME_FIRST_OFD = `${PREFIX}-first-ofd`;
const NAME_KONTUR_OFD = `${PREFIX}-kontur-ofd`;
const NAME_TAXCOM = `${PREFIX}-taxcom`;
const NAME_RO = `${PREFIX}-ro`;
const NAME_HARDENED = `${PREFIX}-hardened`;
const VOLUME = `${PREFIX}-data`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

function request(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: p,
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error(`HTTP timeout ${method} ${p}`)));
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Host-порт опубликованного порта контейнера. У эфемерного маппинга
 * (`-p 127.0.0.1::3100`) порт выделяется при КАЖДОМ старте контейнера, поэтому
 * после `docker start`/`docker restart` его обязательно читать заново: старый
 * порт после рестарта отдаёт ECONNREFUSED (реальный отказ CI-прогона MS-04).
 */
function hostPort(name, containerPort) {
  const format = `{{(index (index .NetworkSettings.Ports "${containerPort}/tcp") 0).HostPort}}`;
  const raw = docker(['inspect', '--format', format, name]);
  if (!/^\d+$/.test(raw)) throw new Error(`контейнер ${name}: порт ${containerPort}/tcp не опубликован (${raw})`);
  return Number(raw);
}

/** HTTP-запрос с повторами: контейнер уже healthy, но маппинг порта может «доехать». */
async function requestRetry(port, method, p, body, headers = {}, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await request(port, method, p, body, headers);
    } catch (e) {
      if (Date.now() >= deadline) throw e;
      await sleep(500);
    }
  }
}

async function waitForHealth(name, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let status = 'unknown';
  while (Date.now() < deadline) {
    let state = '';
    let health = '';
    try {
      // Контейнер мог упасть — различаем «не здоров» и «процесс мёртв».
      [state, health] = docker(['inspect', '--format', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', name]).split(/\s+/);
    } catch {
      state = 'missing';
      health = 'missing';
    }
    status = health;
    if (health === 'healthy') return health;
    if (health === 'unhealthy' || health === 'missing' || state === 'exited' || state === 'dead' || state === 'missing') break;
    await sleep(1000);
  }
  let logs = '';
  try { logs = docker(['logs', name]).split('\n').slice(-15).join('\n'); } catch { /* нет логов */ }
  throw new Error(`контейнер ${name} не стал healthy (status=${status})\n${logs}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: получено ${JSON.stringify(actual)}, ожидалось ${JSON.stringify(expected)}`);
}

function cleanup() {
  for (const name of [NAME_TBANK, NAME_KASSA, NAME_SBER, NAME_VTB, NAME_FIRST_OFD, NAME_KONTUR_OFD, NAME_TAXCOM, NAME_RO, NAME_HARDENED]) {
    try { docker(['rm', '-f', name]); } catch { /* не создан */ }
  }
  try { docker(['volume', 'rm', '-f', VOLUME]); } catch { /* не создан */ }
}

async function main() {
  if (!SKIP_BUILD) {
    console.log(`[smoke] docker build -t ${IMAGE} .`);
    docker(['build', '-t', IMAGE, '.']);
  }

  // 1. T-Bank: CMD по умолчанию, без переменных — должен стать healthy (F-35).
  console.log('[smoke] tbank-mock: default CMD, healthcheck без переменных');
  docker(['run', '-d', '--name', NAME_TBANK, '-p', '127.0.0.1:3900:3100', IMAGE]);
  await waitForHealth(NAME_TBANK);
  console.log('[smoke] tbank-mock: healthy ✅');

  // 2. Kassa: команда из шапки Dockerfile, БЕЗ переменных: слушает /healthz на
  //    3101 — generic healthcheck обязан это найти (F-35, регресс исходного бага).
  console.log('[smoke] kassa-mock: CMD из шапки Dockerfile, healthcheck без переменных');
  docker(['run', '-d', '--name', NAME_KASSA, '-p', '127.0.0.1:3901:3101', IMAGE, 'node', 'services/kassa-mock/server.js']);
  await waitForHealth(NAME_KASSA);
  console.log('[smoke] kassa-mock: healthy ✅');

  // 2b. Sber Ecom на выделенном порту :3105; Docker healthcheck берёт пару из env.
  console.log('[smoke] sber-mock: порт :3105 + /health');
  docker(['run', '-d', '--name', NAME_SBER, '-p', '127.0.0.1:3903:3105', '-e', 'MOCK_PORT=3105', '-e', 'MOCK_HEALTH_PATH=/health', IMAGE, 'node', 'services/sber-mock/server.js']);
  await waitForHealth(NAME_SBER);
  const sberHealth = await request(3903, 'GET', '/health');
  assertEqual(sberHealth.statusCode, 200, 'sber-mock /health');
  const sberOpenApi = await request(3903, 'GET', '/openapi.json');
  if (JSON.parse(sberOpenApi.body).openapi !== '3.1.0') throw new Error('sber-mock /openapi.json недоступен в image');
  console.log('[smoke] sber-mock: healthy + OpenAPI ✅');

  // 2c. ВТБ SMB E-commerce на выделенном порту :3106.
  console.log('[smoke] vtb-mock: порт :3106 + /health');
  docker(['run', '-d', '--name', NAME_VTB, '-p', '127.0.0.1:3904:3106', '-e', 'MOCK_PORT=3106', '-e', 'MOCK_HEALTH_PATH=/health', IMAGE, 'node', 'services/vtb-mock/server.js']);
  await waitForHealth(NAME_VTB);
  const vtbHealth = await request(3904, 'GET', '/health');
  assertEqual(vtbHealth.statusCode, 200, 'vtb-mock /health');
  const vtbOpenApi = await request(3904, 'GET', '/openapi.json');
  if (JSON.parse(vtbOpenApi.body).openapi !== '3.1.0') throw new Error('vtb-mock /openapi.json недоступен в image');
  console.log('[smoke] vtb-mock: healthy + OpenAPI ✅');

  // 2d. Первый ОФД (облачная касса OKassa) на выделенном порту :3107.
  console.log('[smoke] first-ofd-mock: порт :3107 + /health');
  docker(['run', '-d', '--name', NAME_FIRST_OFD, '-p', '127.0.0.1:3905:3107', '-e', 'MOCK_PORT=3107', '-e', 'MOCK_HEALTH_PATH=/health', IMAGE, 'node', 'services/first-ofd-mock/server.js']);
  await waitForHealth(NAME_FIRST_OFD);
  const firstOfdHealth = await request(3905, 'GET', '/health');
  assertEqual(firstOfdHealth.statusCode, 200, 'first-ofd-mock /health');
  const firstOfdOpenApi = await request(3905, 'GET', '/openapi.json');
  if (JSON.parse(firstOfdOpenApi.body).openapi !== '3.1.0') throw new Error('first-ofd-mock /openapi.json недоступен в image');
  console.log('[smoke] first-ofd-mock: healthy + OpenAPI ✅');

  // 2e. Контур.ОФД: generic healthcheck без MOCK_PORT, эфемерный host port.
  console.log('[smoke] kontur-ofd-mock: :3108, generic health + OpenAPI + HTTP selftest');
  const exposed = JSON.parse(docker(['image', 'inspect', '--format', '{{json .Config.ExposedPorts}}', IMAGE]));
  if (!Object.hasOwn(exposed, '3108/tcp')) throw new Error('Dockerfile не публикует EXPOSE 3108');
  docker(['run', '-d', '--name', NAME_KONTUR_OFD, '-p', '127.0.0.1::3108', IMAGE, 'node', 'services/kontur-ofd-mock/server.js']);
  await waitForHealth(NAME_KONTUR_OFD);
  const konturPort = hostPort(NAME_KONTUR_OFD, 3108);
  assertEqual((await request(konturPort, 'GET', '/health')).statusCode, 200, 'kontur-ofd-mock /health');
  const konturApi = await request(konturPort, 'GET', '/openapi.json');
  assertEqual(JSON.parse(konturApi.body).openapi, '3.1.0', 'kontur-ofd-mock OpenAPI в image');
  console.log(docker(['exec', NAME_KONTUR_OFD, 'node', 'services/kontur-ofd-mock/selftest.js']));
  console.log('[smoke] kontur-ofd-mock: healthy + OpenAPI + selftest ✅');

  // 2f. Такском: read-only кабинет/ОФД на :3109, generic healthcheck без MOCK_PORT.
  //     Selftest гоняется внутри контейнера БЕЗ mem_limit: проверка лимита
  //     10 000 документов на фикстуре даёт пиковый RSS выше compose-лимита 128m.
  console.log('[smoke] taxcom-mock: :3109, generic health + OpenAPI + HTTP selftest');
  if (!Object.hasOwn(exposed, '3109/tcp')) throw new Error('Dockerfile не публикует EXPOSE 3109');
  docker(['run', '-d', '--name', NAME_TAXCOM, '-p', '127.0.0.1::3109', IMAGE, 'node', 'services/taxcom-mock/server.js']);
  await waitForHealth(NAME_TAXCOM);
  const taxcomPort = hostPort(NAME_TAXCOM, 3109);
  assertEqual((await request(taxcomPort, 'GET', '/health')).statusCode, 200, 'taxcom-mock /health');
  const taxcomApi = await request(taxcomPort, 'GET', '/openapi.json');
  assertEqual(JSON.parse(taxcomApi.body).openapi, '3.1.0', 'taxcom-mock OpenAPI в image');
  console.log(docker(['exec', NAME_TAXCOM, 'node', 'services/taxcom-mock/selftest.js']));
  console.log('[smoke] taxcom-mock: healthy + OpenAPI + selftest ✅');

  // 3. Непривилегированный runtime-пользователь (F-36).

  const user = docker(['inspect', '--format', '{{.Config.User}}', NAME_TBANK]);
  assertEqual(user, 'mock:mock', 'Dockerfile должен запускать сервисы от mock:mock');
  assertEqual(docker(['exec', NAME_TBANK, 'id', '-u']), '10001', 'UID runtime-пользователя');
  assertEqual(docker(['exec', NAME_KASSA, 'id', '-u']), '10001', 'UID runtime-пользователя (kassa)');
  assertEqual(docker(['exec', NAME_SBER, 'id', '-u']), '10001', 'UID runtime-пользователя (sber)');
  assertEqual(docker(['exec', NAME_VTB, 'id', '-u']), '10001', 'UID runtime-пользователя (vtb)');
  assertEqual(docker(['exec', NAME_FIRST_OFD, 'id', '-u']), '10001', 'UID runtime-пользователя (first-ofd)');
  assertEqual(docker(['exec', NAME_KONTUR_OFD, 'id', '-u']), '10001', 'UID runtime-пользователя (kontur-ofd)');
  assertEqual(docker(['exec', NAME_TAXCOM, 'id', '-u']), '10001', 'UID runtime-пользователя (taxcom)');
  console.log('[smoke] непривилегированный пользователь mock (10001) ✅');

  // 4. persist/restore при --read-only rootfs (F-36): Init до рестарта виден
  //    после рестарта; healthcheck жив (F-35).
  console.log('[smoke] read-only rootfs: persist/restore + healthcheck');
  docker([
    'run', '-d', '--name', NAME_RO,
    '--read-only', '--tmpfs', '/tmp',
    '-v', `${VOLUME}:/data`,
    '-p', '127.0.0.1:3902:3100',
    '-e', 'MOCK_STATE_FILE=/data/state.json',
    '-e', 'MOCK_STRICT_TOKEN=false',
    IMAGE,
  ]);
  await waitForHealth(NAME_RO);
  const init = await request(3902, 'POST', '/v2/Init', { TerminalKey: 'TBANKMOCKTEST', Amount: '1000', OrderId: 'smoke-readonly-1' });
  const initJson = JSON.parse(init.body);
  if (initJson.Success !== true) throw new Error(`Init в read-only контейнере не прошёл: ${init.body}`);
  docker(['restart', NAME_RO]);
  await waitForHealth(NAME_RO);
  const snapshot = await request(3902, 'GET', '/mock/state');
  const stateJson = JSON.parse(snapshot.body);
  // GET /mock/state отдаёт { sandbox, state: exportState() }, а exportState сам
  // возвращает { sandbox, exportedAt, state } — платежи лежат в state.state.payments.
  const inner = (stateJson.state && stateJson.state.state) || stateJson.state || {};
  const payments = Object.values(inner.payments || {});
  if (!payments.some((p) => p.orderId === 'smoke-readonly-1')) {
    throw new Error(`состояние не пережило рестарт (persist/restore): ${snapshot.body.slice(0, 500)}`);
  }
  console.log('[smoke] read-only rootfs: persist/restore ✅');

  // 5. MS-04: харденинг compose + graceful shutdown.
  //    Тот же образ, но все флаги, которые compose ставит сервисам:
  //    init (tini как PID 1), read-only rootfs, tmpfs /tmp, снятые capabilities,
  //    no-new-privileges и лимит PID. Сервис обязан остаться рабочим, а SIGTERM
  //    от `docker stop` — дать самостоятельный exit 0 ≤ 2 с и не потерять
  //    отложенную (debounced, окно 150 мс) запись состояния песочницы.
  console.log('[smoke] MS-04: харденинг (init/read_only/tmpfs/cap_drop/no-new-privileges/pids_limit) + SIGTERM');
  docker([
    'run', '-d', '--name', NAME_HARDENED,
    '--init', '--read-only', '--tmpfs', '/tmp',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '256',
    '-v', `${VOLUME}:/data`,
    // Эфемерный host-порт: фиксированные 390x на разделяемом раннере могут
    // быть заняты (PC-12) — порт читаем из inspect, как у kontur-ofd выше.
    '-p', '127.0.0.1::3100',
    // Свой state-файл: не пересекаемся с read-only контейнером выше (у него
    // /data/state.json), рестарт проверяет именно отложенную запись песочницы.
    '-e', 'MOCK_STATE_FILE=/data/hardened-state.json',
    '-e', 'MOCK_STRICT_TOKEN=false',
    IMAGE,
  ]);
  await waitForHealth(NAME_HARDENED);
  let hardenedPort = hostPort(NAME_HARDENED, 3100);
  // Запись в именованную песочницу: её реестр сбрасывается debounce'ом, поэтому
  // SIGTERM отправляется сразу после ответа Init — до истечения окна 150 мс.
  const hardenedInit = await requestRetry(hardenedPort, 'POST', '/v2/Init',
    { TerminalKey: 'TBANKMOCKTEST', Amount: '1000', OrderId: 'smoke-sigterm-1' },
    { 'X-Mock-Sandbox': 'smoke-sigterm' });
  const hardenedInitJson = JSON.parse(hardenedInit.body);
  if (hardenedInitJson.Success !== true) {
    throw new Error(`MS-04: Init в харденированном контейнере не прошёл: ${hardenedInit.body}`);
  }
  const stopStarted = Date.now();
  docker(['stop', '--timeout', '3', NAME_HARDENED]);
  const stopMs = Date.now() - stopStarted;
  const hardenedExit = Number(docker(['inspect', '--format', '{{.State.ExitCode}}', NAME_HARDENED]));
  assertEqual(hardenedExit, 0, 'MS-04: docker stop (SIGTERM) -> exit code 0');
  if (stopMs > 2000) {
    throw new Error(`MS-04: контейнер остановился за ${stopMs} мс (> 2000): SIGTERM обрабатывается не сразу`);
  }
  console.log(`[smoke] MS-04: docker stop -> exit 0 за ${stopMs} мс ✅`);
  // Рестарт того же контейнера с тем же volume: отложенная запись на месте.
  docker(['start', NAME_HARDENED]);
  await waitForHealth(NAME_HARDENED);
  // Эфемерный host-порт выделяется при каждом старте: после рестарта он другой,
  // поэтому читаем его заново, а не переиспользуем до-reстартный (CI MS-04).
  hardenedPort = hostPort(NAME_HARDENED, 3100);
  const hardenedState = JSON.parse((await requestRetry(hardenedPort, 'GET', '/mock/state?sandbox=smoke-sigterm')).body);
  const hardenedInner = (hardenedState.state && hardenedState.state.state) || hardenedState.state || {};
  const restored = Object.values(hardenedInner.payments || {}).some((p) => p.orderId === 'smoke-sigterm-1');
  if (!restored) {
    throw new Error(`MS-04: отложенная запись не пережила SIGTERM+рестарт: ${JSON.stringify(hardenedState).slice(0, 400)}`);
  }
  console.log('[smoke] MS-04: отложенная запись пережила SIGTERM/рестарт ✅');

  console.log(`\nIMAGE SMOKE PASSED ✅ (${IMAGE})`);
}

main()
  .catch((e) => {
    console.error(`\nIMAGE SMOKE FAILED ❌ ${e.message}`);
    process.exitCode = 1;
  })
  .finally(cleanup);
