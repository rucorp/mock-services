// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * HEALTHCHECK для docker-образа (F-35). Один образ несёт все сервисы, а их
 * health-пути различаются (tbank/yookassa/atol/alfa/sber/vtb/first-ofd — `/health`,
 * kassa — `/healthz`),
 * поэтому:
 *   • заданные MOCK_PORT / MOCK_HEALTH_PATH — авторитетная пара (как в
 *     рекомендованных командах Dockerfile и compose);
 *   • без переменных опрашиваются известные пары сервисов (порт + его
 *     health-путь) — generic-запуск `docker run ... node services/kassa-mock/server.js`
 *     не должен помечаться unhealthy только из-за другого пути.
 *
 * Exit 0 — один из запросов вернул 200; иначе exit 1.
 */

const http = require('http');

const KNOWN_SERVICES = [
  ['3100', '/health'],   // tbank-mock
  ['3101', '/healthz'],  // kassa-mock
  ['3102', '/health'],   // yookassa-mock
  ['3103', '/health'],   // atol-mock
  ['3104', '/health'],   // alfa-mock
  ['3105', '/health'],   // sber-mock
  ['3106', '/health'],   // vtb-mock
  ['3107', '/health'],   // first-ofd-mock
  ['3108', '/health'],   // kontur-ofd-mock
];

const PROBES = process.env.MOCK_PORT
  ? [[process.env.MOCK_PORT, process.env.MOCK_HEALTH_PATH || '/health'], [process.env.MOCK_PORT, '/healthz']]
  : KNOWN_SERVICES;

function probe(i) {
  if (i >= PROBES.length) process.exit(1);
  const [port, p] = PROBES[i];
  const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    res.resume();
    if (res.statusCode === 200) process.exit(0);
    probe(i + 1);
  });
  req.setTimeout(1500, () => req.destroy(new Error('health probe timeout')));
  req.on('error', () => probe(i + 1));
}

probe(0);
