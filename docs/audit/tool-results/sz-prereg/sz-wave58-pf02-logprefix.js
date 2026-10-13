#!/usr/bin/env node
// [sz/#58 · PF-02] Префикс логов yookassa: [yookassa-mock] вместо обрезанного `ock]`.
// До фикса часть шаблонных литералов печаталась как `ock] …` (обломок `[yookassa-mock]`).
// Проверка: стартовый блок — каждая строка с префиксом [yookassa-mock]; runtime-строка
// sandbox-sweep (TTL-окружение) — с префиксом; статика исходника — литералов `ock]` нет.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(port, method, p, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers2 = { ...(data ? { 'Content-Length': Buffer.byteLength(data), 'Content-Type': 'application/json' } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: headers2, timeout: 5000 }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: buf, json: (() => { try { return JSON.parse(buf); } catch { return null; } })() }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

function startYookassa(env, label) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['services/yookassa-mock/server.js'], {
      cwd: REPO, env: { ...process.env, MOCK_HOST: '127.0.0.1', MOCK_PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let done = false;
    const onData = (c) => {
      out += c.toString();
      if (done) return;
      const m = out.match(/on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { done = true; resolve({ child, port: Number(m[1]), log: () => out }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`${label} exited early: ${code}\n${out}`)));
    setTimeout(() => { if (!done) reject(new Error(`${label}: порт не найден за 5с\n${out}`)); }, 5000);
  });
}

(async () => {
  let verdictA = 'не подтвердилось', evA = '';
  let verdictB = 'не подтвердилось', evB = '';
  let verdictC = 'не подтвердилось', evC = '';
  const children = [];
  try {
    /* ---- A: стартовый блок — все строки с префиксом ---- */
    const y = await startYookassa({ MOCK_SANDBOX_TTL_MS: '1200', MOCK_SANDBOX_SWEEP_MS: '1000' }, 'yookassa-pf02');
    children.push(y.child);
    await sleep(300);
    const bootLines = y.log().split('\n').filter((l) => l.trim());
    const bad = bootLines.filter((l) => !l.includes('[yookassa-mock]'));
    verdictA = bad.length === 0 && bootLines.length >= 7 ? 'ПОДТВЕРЖДЕНО (все строки префиксованы)' : 'ТРЕБУЕТ ВНИМАНИЯ';
    evA = `строк в стартовом блоке: ${bootLines.length}; без префикса: ${bad.length}${bad.length ? '\n' + bad.slice(0, 3).join('\n') : ''}`;

    /* ---- B: runtime-строка sandbox-sweep (TTL 1.2с, sweep каждые 1с) ---- */
    await req(y.port, 'POST', '/v3/payments', { body: { amount: { value: '100.00', currency: 'RUB' }, confirmation: { type: 'redirect', return_url: 'https://shop.test/ok' }, description: 'pf02' }, headers: { Authorization: 'Basic ' + Buffer.from('YOOKASSAMOCKTEST:mockpass123').toString('base64'), 'X-Mock-Sandbox': 'pf02x' } });
    let sweepLine = '';
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      sweepLine = (y.log().split('\n').find((l) => l.includes('sandbox sweep')) || '');
      if (sweepLine) break;
    }
    verdictB = sweepLine.includes('[yookassa-mock]') ? 'ПОДТВЕРЖДЕНО (runtime-строка префиксована)' : 'ТРЕБУЕТ ВНИМАНИЯ (sweep-строки нет или без префикса)';
    evB = sweepLine ? sweepLine.slice(0, 160) : '(строка sweep не появилась за 6с — проверить TTL-env)';

    /* ---- C: статика исходника — обломков `ock]` нет ---- */
    const src = fs.readFileSync(path.join(REPO, 'services', 'yookassa-mock', 'server.js'), 'utf8');
    const broken = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /(^|[^k])ock\]/.test(l) && !l.includes('[yookassa-mock]'));
    const prefixed = src.split('\n').filter((l) => l.includes('[yookassa-mock]')).length;
    verdictC = broken.length === 0 && prefixed >= 10 ? 'ПОДТВЕРЖДЕНО (литералов ock] нет, префикс растиражирован)' : 'ТРЕБУЕТ ВНИМАНИЯ';
    evC = `строк с [yookassa-mock]: ${prefixed}; обломков ock]: ${broken.length}${broken.length ? ' → строки ' + broken.slice(0, 5).map(([n]) => n).join(',') : ''}`;

    for (const [id, title, verdict, evidence] of [['PF-02a', 'стартовый блок yookassa — все строки [yookassa-mock]', verdictA, evA],
      ['PF-02b', 'runtime-строка sandbox-sweep — с префиксом', verdictB, evB],
      ['PF-02c', 'статика: обломков `ock]` в исходнике нет', verdictC, evC]]) {
      console.log(`\n=== ${id}: ${title} ===\nВЕРДИКТ: ${verdict}\n${evidence}`);
    }
    console.log('\n---- ИТОГ PF-02 ----');
    console.log('До фикса (#58): часть литералов печаталась как `ock] …` (обрезанный тег) — лог некликабелен и ломает парсеры.');
    console.log('После фикса: единый префикс [yookassa-mock] на старте и в runtime.');
  } finally {
    for (const c of children) { try { c.kill(); } catch {} }
  }
})().catch((e) => { console.error('ПРОБА УПАЛА:', e.message); process.exit(2); });
