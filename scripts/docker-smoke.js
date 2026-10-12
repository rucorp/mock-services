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
 *      HEALTHCHECK образа — F-35 (kassa слушает /healthz, а не /health);
 *   2. процессы идут от непривилегированного UID 10001 — F-36;
 *   3. persist/restore переживает --read-only rootfs с volume /data: Init
 *      до рестарта виден после рестарта — F-36;
 *   4. healthcheck продолжает работать при --read-only rootfs — F-35/F-36.
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
const NAME_RO = `${PREFIX}-ro`;
const VOLUME = `${PREFIX}-data`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

function request(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: p,
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
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
  for (const name of [NAME_TBANK, NAME_KASSA, NAME_RO]) {
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

  // 3. Непривилегированный runtime-пользователь (F-36).
  const user = docker(['inspect', '--format', '{{.Config.User}}', NAME_TBANK]);
  assertEqual(user, 'mock:mock', 'Dockerfile должен запускать сервисы от mock:mock');
  assertEqual(docker(['exec', NAME_TBANK, 'id', '-u']), '10001', 'UID runtime-пользователя');
  assertEqual(docker(['exec', NAME_KASSA, 'id', '-u']), '10001', 'UID runtime-пользователя (kassa)');
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

  console.log(`\nIMAGE SMOKE PASSED ✅ (${IMAGE})`);
}

main()
  .catch((e) => {
    console.error(`\nIMAGE SMOKE FAILED ❌ ${e.message}`);
    process.exitCode = 1;
  })
  .finally(cleanup);
