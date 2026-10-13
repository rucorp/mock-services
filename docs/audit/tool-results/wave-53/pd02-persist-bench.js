// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/*
 * Замер PD-02 (#53): стоимость записи реестра песочниц на мутацию.
 * N соседних песочниц держат состояние по FILL байт; одна «горячая» песочница
 * получает K мелких мутаций. Считаем байты, записанные в каталог реестра, и
 * максимальную блокировку event-loop на одну мутацию.
 *
 * Запуск (до/после):
 *   node docs/audit/tool-results/wave-53/pd02-persist-bench.js /path/to/core/index.js
 *   до:    git show 8b3304b:packages/core/index.js > /tmp/base-core/index.js
 *          node .../pd02-persist-bench.js /tmp/base-core/index.js
 * Переменные: N (50), K (100), FILL (50000).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const corePath = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..', '..', 'packages', 'core', 'index.js'));
const core = require(corePath);
const N = Number(process.env.N || 50);
const K = Number(process.env.K || 100);
const FILL = Number(process.env.FILL || 50000);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd02-bench-'));
const stateFile = path.join(dir, 'state.json');
let written = 0;
let writeCalls = 0;
const origWrite = fs.writeFileSync;
fs.writeFileSync = function (p, data, ...rest) {
  if (String(p).startsWith(dir)) {
    written += Buffer.byteLength(data);
    writeCalls += 1;
  }
  return origWrite.call(fs, p, data, ...rest);
};

try {
  const rt = core.createSandboxRuntime({ state: {}, mode: 'namespaces', stateFile, log: () => {} });
  const big = 'x'.repeat(FILL);
  for (let i = 0; i < N; i += 1) {
    const imp = rt.importState({ state: { blob: big } }, `bulk-${i}`);
    if (!imp.ok) throw new Error(`подготовка: импорт bulk-${i} отклонён`);
  }
  rt.create({ id: 'hot' });
  rt.flush();
  written = 0;
  writeCalls = 0;
  let maxBlockNs = 0n;
  for (let k = 0; k < K; k += 1) {
    const t = process.hrtime.bigint();
    rt.importState({ state: { [`k${k}`]: { small: `mut-${k}` } } }, 'hot');
    const d = process.hrtime.bigint() - t;
    if (d > maxBlockNs) maxBlockNs = d;
  }
  rt.flush();
  console.log(JSON.stringify({
    core: corePath,
    sandboxes: N,
    fillBytesPerSandbox: FILL,
    mutations: K,
    registryBytesWritten: written,
    registryMB: Math.round((written / 1048576) * 100) / 100,
    bytesPerMutation: Math.round(written / K),
    writeCalls,
    maxSingleMutationMs: Math.round((Number(maxBlockNs) / 1e6) * 100) / 100,
  }));
} finally {
  fs.writeFileSync = origWrite;
  fs.rmSync(dir, { recursive: true, force: true });
}
