#!/usr/bin/env node
/* © 2026 ООО «Аксиома» ИНН:7842223709 · Apache-2.0
 * SZ проба MS-04 (PR #115, ревизия fcd3b05e): graceful shutdown девяти сервисов
 * (installGracefulShutdown: SIGTERM/SIGINT → sync flush → close → closeAllConnections
 * → exit 0, fallback 1 с, идемпотентен) + контейнерный харденинг compose×3
 * (init/read_only/tmpfs /tmp/cap_drop ALL/no-new-privileges/pids_limit 256).
 * Пробный проход по сигналу координатора (#62); предрегистрация — DoD issue #110.
 * Zero-dep, Node >= 18.
 *
 * Ноги:
 *   A. SIGTERM/SIGINT → exit 0 за ≤2 с на живых сервисах (tbank/first-ofd/kontur-ofd/kassa)
 *      + идемпотентность (повторный сигнал не ломает shutdown).
 *   B. Отложенные записи (окно 150 мс): create + бизнес-запись → мгновенный SIGTERM →
 *      рестарт → песочница И отложенная запись состояния живы (graceful flush);
 *      негатив-контроль SIGKILL: create персистится немедленно, а отложенная запись
 *      состояния теряется в окне; default-маркер жив в обоих случаях (синхронные
 *      записи createStore.persist).
 *   C. Харденинг-инвариант трёх compose (jq-проверка в CI воспроизведена независимо:
 *      собственный mini-парсер YAML compose-подмножества; docker в песочнице нет,
 *      `docker compose config` недоступен — см. отчёт).
 *
 * Запуск: node sz-wave115-ms04-graceful-shutdown.js (из корня клона на fcd3b05e).
 */

'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function findRoot() {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, 'services', 'tbank-mock', 'server.js'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('не нашёл корень клона mock-services');
}
const ROOT = findRoot();

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(title) { console.log(`\n== ${title}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(port, method, urlPath, body, headers = {}, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: {
        ...(data !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT', body: '' }); });
    req.on('error', (e) => resolve({ status: `ERR:${e.code}`, body: '' }));
    if (data !== null) req.write(data);
    req.end();
  });
}

/* ---- дочерний стенд: MOCK_PORT=0, порт из стартовой строки (два формата логов) */
function startChild(serviceRel, extraEnv = {}) {
  const childEnv = {
    ...process.env,
    MOCK_HOST: '127.0.0.1',
    MOCK_PORT: '0',
    MOCK_STATE_FILE: '',
    MOCK_RETRY_MS: '1000',
    MOCK_PROFILE: 'plain',
    MOCK_ADMIN_TOKEN: '',
    MOCK_OPERATOR_TOKEN: '',
    MOCK_HOSTED: '',
    MOCK_TENANCY: '',
    MOCK_STRICT_TOKEN: 'false',
    MOCK_SANDBOX_FILE: '',
    MOCK_SANDBOX_TOKEN: '',
    MOCK_SANDBOX_TTL_MS: '',
    MOCK_SANDBOX_SWEEP_MS: '',
    MOCK_SANDBOX_MAX: '',
    MOCK_SANDBOX_MAX_DOCUMENTS: '',
    MOCK_SANDBOX_MAX_STATE_BYTES: '',
    MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES: '',
    MOCK_SANDBOX_RETENTION_MS: '',
    MOCK_SANDBOX_HOST_SUFFIX: '',
    MOCK_SANDBOX_CREATE_LIMIT: '',
    ...extraEnv,
  };
  const proc = spawn('node', ['--max-old-space-size=48', path.join(ROOT, serviceRel)], {
    cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  let exited = null;
  proc.stdout.on('data', (d) => { buf += String(d); });
  proc.stderr.on('data', (d) => { buf += String(d); });
  proc.on('exit', (code, signal) => { exited = { code, signal }; });
  const port = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${serviceRel}: порт не получен: ${buf.slice(0, 240)}`)), 7000);
    proc.stdout.on('data', () => {
      /* форматы: "on http://host:PORT" (tbank/first-ofd), "listening on :PORT" (kontur),
       * "on 127.0.0.1:PORT" (kassa) */
      const m = /on (?:https?:\/\/)?[^\s:]*:(\d+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
  });
  return {
    proc, port, output: () => buf,
    exited: () => exited,
    exitPromise: new Promise((resolve) => { if (exited) resolve(exited); else proc.once('exit', (c, s) => resolve({ code: c, signal: s })); }),
    kill: (sig = 'SIGKILL') => { try { proc.kill(sig); } catch { /* уже мёртв */ } },
  };
}

/* ============================================================ Leg A */

async function legA_signals() {
  section('A. SIGTERM/SIGINT → exit 0 за ≤2 с (живые сервисы, graceful shutdown)');
  const targets = [
    { name: 'tbank-mock', rel: 'services/tbank-mock/server.js' },
    { name: 'first-ofd-mock', rel: 'services/first-ofd-mock/server.js' },
    { name: 'kontur-ofd-mock', rel: 'services/kontur-ofd-mock/server.js' },
    { name: 'kassa-mock', rel: 'services/kassa-mock/server.js' },
  ];
  for (const t of targets) {
    for (const sig of ['SIGTERM', 'SIGINT']) {
      const child = startChild(t.rel);
      try {
        const port = await child.port;
        const health = await request(port, 'GET', '/healthz').status === undefined
          ? await request(port, 'GET', '/health').catch(() => ({}))
          : null;
        void health;
        const t0 = Date.now();
        child.kill(sig);
        const exit = await Promise.race([
          child.exitPromise,
          sleep(4000).then(() => null),
        ]);
        const ms = Date.now() - t0;
        check(`A ${t.name} ${sig} → exit 0 за ≤2000мс`,
          exit !== null && exit.code === 0 && ms <= 2000,
          `code=${exit ? exit.code : 'timeout'}, signal=${exit ? exit.signal : '-'}, ${ms}мс`);
      } finally { child.kill('SIGKILL'); }
    }
  }

  section('A+. Идемпотентность: повторный SIGTERM не ломает shutdown');
  {
    const child = startChild('services/tbank-mock/server.js');
    try {
      const port = await child.port;
      child.kill('SIGTERM');
      await sleep(40);
      child.kill('SIGTERM'); /* второй сигнал в окне остановки */
      const exit = await Promise.race([child.exitPromise, sleep(4000).then(() => null)]);
      check('A+ двойной SIGTERM → exit 0 без исключений', exit !== null && exit.code === 0,
        `code=${exit ? exit.code : 'timeout'}, signal=${exit ? exit.signal : '-'}`);
    } finally { child.kill('SIGKILL'); }
  }
}

/* ============================================================ Leg B */

async function legB_delayedRegistry() {
  section('B. Отложенные записи (окно 150 мс): graceful flush спасает, SIGKILL теряет');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sz-ms04-'));
  const stateFile = path.join(dir, 'state.json');
  const sandboxFile = path.join(dir, 'sandboxes.json');
  const env = { MOCK_STATE_FILE: stateFile, MOCK_SANDBOX_FILE: sandboxFile };
  const payBody = { VerificationCode: '1', Amount: '100', PayerInn: '7800000000' };

  /* 1. create + бизнес-запись (отложенная) + мгновенный SIGTERM */
  {
    const child = startChild('services/tbank-mock/server.js', env);
    try {
      const port = await child.port;
      const create = await request(port, 'POST', '/sandboxes', { sandbox: 'persist-me' });
      check('B.1 create песочницы → ок', create.status === 200, `HTTP ${create.status}`);
      const marker = await request(port, 'POST', '/mock/state', { state: { szMarker: 'ms04' } });
      check('B.2 default-маркер записан (синхронный persist)', marker.status === 200, `HTTP ${marker.status}`);
      const pay = await request(port, 'POST', '/av/v1/payment', payBody, { 'X-Mock-Sandbox': 'persist-me' });
      check('B.2b бизнес-запись на песочницу (incoming; persist отложен на 150 мс)',
        pay.status === 200 && /"Success":true/.test(pay.body), `HTTP ${pay.status}`);
      const t0 = Date.now();
      child.kill('SIGTERM'); /* сразу после записи: внутри окна 150 мс */
      const exit = await Promise.race([child.exitPromise, sleep(4000).then(() => null)]);
      check('B.3 SIGTERM → exit 0 (graceful flush отработал)', exit !== null && exit.code === 0,
        `code=${exit ? exit.code : 'timeout'}, ${Date.now() - t0}мс`);
    } finally { child.kill('SIGKILL'); }
  }

  /* 2. рестарт → песочница + отложенная запись состояния живы */
  {
    const child = startChild('services/tbank-mock/server.js', env);
    try {
      const port = await child.port;
      const list = await request(port, 'GET', '/sandboxes');
      let ids = [];
      try { ids = JSON.parse(list.body).sandboxes.map((s) => s.id); } catch { /* пусто */ }
      check('B.4 после рестарта песочница persist-me жива', ids.includes('persist-me'), `sandboxes=[${ids.join(', ')}]`);
      const st = JSON.parse((await request(port, 'GET', '/mock/state?sandbox=persist-me')).body).state.state;
      check('B.5 отложенная запись состояния спасена flush-ом: incoming в песочнице жив',
        st && Object.keys(st.incoming || {}).length === 1, `incoming=${st ? Object.keys(st.incoming || {}).length : '?'}`);
      const dst = JSON.parse((await request(port, 'GET', '/mock/state')).body).state.state;
      check('B.6 default-маркер пережил рестарт', dst && dst.szMarker === 'ms04', `marker=${dst && dst.szMarker}`);
    } finally { child.kill('SIGKILL'); }
  }

  /* 3. негатив-контроль: SIGKILL внутри окна 150 мс → отложенная запись теряется */
  {
    const killState = path.join(dir, 'state-kill.json');
    const killSbx = path.join(dir, 'sandboxes-kill.json');
    const child = startChild('services/tbank-mock/server.js', {
      MOCK_STATE_FILE: killState, MOCK_SANDBOX_FILE: killSbx,
    });
    try {
      const port = await child.port;
      await request(port, 'POST', '/sandboxes', { sandbox: 'kill-me' });
      await request(port, 'POST', '/mock/state', { state: { szMarker: 'kill-window' } });
      await request(port, 'POST', '/av/v1/payment', payBody, { 'X-Mock-Sandbox': 'kill-me' });
      child.kill('SIGKILL'); /* мгновенно: окно 150 мс не истекло */
      const exit = await Promise.race([child.exitPromise, sleep(3000).then(() => null)]);
      check('B.7 SIGKILL → процесс убит сигналом (exit code null)',
        exit !== null && exit.code === null && exit.signal === 'SIGKILL',
        `code=${exit ? exit.code : 'timeout'}, signal=${exit ? exit.signal : '-'}`);
    } finally { child.kill('SIGKILL'); }
    {
      const child2 = startChild('services/tbank-mock/server.js', {
        MOCK_STATE_FILE: killState, MOCK_SANDBOX_FILE: killSbx,
      });
      try {
        const port = await child2.port;
        const list = await request(port, 'GET', '/sandboxes');
        let ids = [];
        try { ids = JSON.parse(list.body).sandboxes.map((s) => s.id); } catch { /* пусто */ }
        check('B.8 контраст: сама песочница kill-me жива даже после SIGKILL (create персистится немедленно)',
          ids.includes('kill-me'), `sandboxes=[${ids.join(', ')}]`);
        const st = JSON.parse((await request(port, 'GET', '/mock/state?sandbox=kill-me')).body).state.state;
        check('B.9 негатив: отложенная запись состояния (incoming) потеряна в окне 150 мс',
          st && Object.keys(st.incoming || {}).length === 0, `incoming=${st ? Object.keys(st.incoming || {}).length : '?'}`);
        const dst = JSON.parse((await request(port, 'GET', '/mock/state')).body).state.state;
        check('B.10 контраст: default-маркер жив и после SIGKILL (синхронные записи состояния)',
          dst && dst.szMarker === 'kill-window', `marker=${dst && dst.szMarker}`);
      } finally { child2.kill('SIGKILL'); }
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ============================================================ Leg C */

/* mini-парсер YAML-подмножества compose: services → поля харденинга */
function stripComment(line) {
  let inS = false; let inD = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (ch === '#' && !inS && !inD && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) return line.slice(0, i);
  }
  return line;
}
function parseFlowArray(text) {
  const inner = text.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  return inner.split(',').map((x) => x.trim().replace(/^["']|["']$/g, ''));
}
function parseComposeHardening(text) {
  const out = {};
  let inServices = false;
  let svc = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).replace(/\t/g, '  ');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indent === 0) {
      inServices = trimmed === 'services:';
      if (!inServices) svc = null;
      continue;
    }
    if (!inServices) continue;
    if (indent === 2) {
      const m = /^([^:]+):\s*$/.exec(trimmed);
      if (m) { svc = m[1].trim(); out[svc] = {}; }
      continue;
    }
    if (!svc || indent !== 4) continue;
    const m = /^([\w-]+):\s*(.*)$/.exec(trimmed);
    if (!m) continue;
    const [, key, val] = m;
    if (!['init', 'read_only', 'tmpfs', 'cap_drop', 'security_opt', 'pids_limit'].includes(key)) continue;
    if (val.startsWith('[')) out[svc][key] = parseFlowArray(val);
    else if (val === 'true') out[svc][key] = true;
    else if (val === 'false') out[svc][key] = false;
    else if (/^\d+$/.test(val)) out[svc][key] = Number(val);
    else out[svc][key] = val.replace(/^["']|["']$/g, '');
  }
  return out;
}
function hardeningOk(svc) {
  return svc
    && svc.init === true
    && svc.read_only === true
    && Array.isArray(svc.tmpfs) && svc.tmpfs.includes('/tmp')
    && Array.isArray(svc.cap_drop) && svc.cap_drop.includes('ALL')
    && Array.isArray(svc.security_opt) && svc.security_opt.includes('no-new-privileges:true')
    && svc.pids_limit === 256;
}

async function legC_composeHardening() {
  section('C. Харденинг-инвариант трёх compose (независимое воспроизведение CI-проверки)');
  const files = ['docker-compose.yml', 'docker-compose.staging.yml', 'docker-compose.include.yml'];
  for (const f of files) {
    const full = path.join(ROOT, f);
    const text = fs.readFileSync(full, 'utf8');
    const services = parseComposeHardening(text);
    const names = Object.keys(services);
    const bad = names.filter((n) => !hardeningOk(services[n]));
    check(`C ${f}: все ${names.length} сервис(ов) с init/read_only/tmpfs/cap_drop/no-new-privileges/pids_limit=256`,
      names.length > 0 && bad.length === 0,
      bad.length ? `нарушители: ${bad.join(', ')}` : names.join(', '));
    check(`C ${f}: tbank-mock и kassa-mock присутствуют и захарденены`,
      hardeningOk(services['tbank-mock']) && hardeningOk(services['kassa-mock']));
  }
}

/* ============================================================ main */

async function main() {
  console.log('SZ проба MS-04 (fcd3b05e): graceful shutdown + контейнерный харденинг');
  console.log(`ROOT: ${ROOT}`);
  await legA_signals();
  await legB_delayedRegistry();
  await legC_composeHardening();
  console.log(`\nИТОГ: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('PROBE CRASH:', e.message);
  process.exit(2);
});
