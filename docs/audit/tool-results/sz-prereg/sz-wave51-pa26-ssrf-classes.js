#!/usr/bin/env node
// [sz/волна #51 · PA-26] fail-open классы SSRF-гарда ядра — дифференцирующая проба «до/после».
// Claim дельты #54 (PA-26, core:846-874 на момент находки): isPrivateIPv4/isPrivateIPv6
// пропускают ff00::/8, развёрнутый loopback ::0:1, TEST-NET×3 (RFC 5737), 2001:db8::/32,
// 64:ff9b:1::/96 — гард считает их «публичными».
// Фикс #68: fail-closed блокировка этих классов (+ mapped/NAT64-обёртки TEST-NET).
// Метод: core.assertPublicHost(url) на IP-литералах (DNS не вызывается, сеть не нужна).
//   «до» (до фикса):     дефектные классы РЕЗОЛВЯТСЯ (fail-open) — ДЕФЕКТ ВОСПРОИЗВЕДЁН;
//   «после» (#68 head):  дефектные классы отклоняются (throw code=SSRF_BLOCKED) — ЗАКРЫТО.
// Запуск: node docs/audit/tool-results/sz-prereg/sz-wave51-pa26-ssrf-classes.js [ /путь/к/репо ]
'use strict';

const path = require('node:path');
const REPO = process.argv[2] || path.resolve(__dirname, '..', '..', '..', '..');
const core = require(path.join(REPO, 'packages', 'core', 'index.js'));

// [подпись, url, ожидание-до-фикса: 'open'(fail-open дефект)|'blocked']
const CASES = [
  ['ff02::1 — multicast ff00::/8', 'http://[ff02::1]:9/x', 'open'],
  ['::0:1 — развёрнутый loopback', 'http://[0:0:0:0:0:0:0:1]:9/x', 'open'],
  ['192.0.2.1 — TEST-NET-1 (RFC 5737)', 'http://192.0.2.1:9/x', 'open'],
  ['198.51.100.7 — TEST-NET-2 (RFC 5737)', 'http://198.51.100.7:9/x', 'open'],
  ['203.0.113.9 — TEST-NET-3 (RFC 5737)', 'http://203.0.113.9:9/x', 'open'],
  ['::ffff:192.0.2.1 — mapped TEST-NET', 'http://[::ffff:192.0.2.1]:9/x', 'open'],
  ['2001:db8::1 — documentation IPv6 (RFC 3849)', 'http://[2001:db8::1]:9/x', 'open'],
  ['64:ff9b:1::1 — local-use NAT64 (RFC 8215)', 'http://[64:ff9b:1::1]:9/x', 'open'],
  ['64:ff9b::c000:201 — well-known NAT64 → TEST-NET', 'http://[64:ff9b::c000:201]:9/x', 'open'],
  ['2130706433 — десятичный v4 loopback (WHATWG нормализует)', 'http://2130706433:9/x', 'blocked'],
  // Контроли (обязаны вести себя одинаково до и после):
  ['КОНТРОЛЬ: 127.0.0.1 loopback', 'http://127.0.0.1:9/x', 'blocked'],
  ['КОНТРОЛЬ: ::1 loopback', 'http://[::1]:9/x', 'blocked'],
  ['КОНТРОЛЬ: 1.1.1.1 публичный (соединения нет — только guard)', 'http://1.1.1.1:443/x', 'public'],
  ['КОНТРОЛЬ: [2606:4700:4700::1111] публичный IPv6', 'http://[2606:4700:4700::1111]:443/x', 'public'],
];

(async () => {
  const results = [];
  for (const [label, url, expectBefore] of CASES) {
    let outcome;
    try {
      await core.assertPublicHost(url);
      outcome = 'resolved';
    } catch (e) {
      outcome = e && e.code === 'SSRF_BLOCKED' ? 'SSRF_BLOCKED' : `ERR(${(e && e.code) || (e && e.message || '').slice(0, 40)})`;
    }
    results.push({ label, url, outcome, expectBefore });
  }

  const defectOpen = results.filter((r) => r.outcome === 'resolved' && r.expectBefore === 'open');
  const controlsBroken = results.filter((r) => r.label.startsWith('КОНТРОЛЬ') && (
    (r.expectBefore === 'blocked' && r.outcome !== 'SSRF_BLOCKED') ||
    (r.expectBefore === 'public' && r.outcome !== 'resolved')));

  console.log('\n===== sz-wave51-pa26-ssrf-classes =====');
  for (const r of results) {
    console.log(`[${r.outcome}] ${r.label}  (до фикса ожидалось: ${r.expectBefore})`);
  }
  console.log(`\nДефектные классы, пропущенные гардом (resolved): ${defectOpen.length}`);
  console.log(`Контроли сломаны: ${controlsBroken.length}`);
  console.log(`ВЕРДИКТ: ${defectOpen.length === 0 && controlsBroken.length === 0 ? 'ЗАКРЫТО (fail-closed, классы заблокированы, контроли целы)' : defectOpen.length > 0 ? `ДЕФЕКТ ВОСПРОИЗВЕДЁН (fail-open ×${defectOpen.length})` : 'ПРОАНАЛИЗИРОВАТЬ (контроли?)'}`);
  if (controlsBroken.length) {
    for (const r of controlsBroken) console.log(`  !! контроль ${r.label}: ${r.outcome}`);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
