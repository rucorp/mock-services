#!/usr/bin/env node
// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

/**
 * Отчётная сверка отпечатков публичных первоисточников.
 * Источники перечисляются URL-ссылками в docs/reference/external-links.md;
 * ожидаемые отпечатки и намеренно неснимаемые страницы — в
 * protocols/upstream-snapshot.json. Скрипт ничего не меняет без --update,
 * никогда не создаёт issue и не завершает прогон ошибкой из-за сети.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LINKS_FILE = path.join(ROOT, 'docs/reference/external-links.md');
const SNAPSHOT_FILE = path.join(ROOT, 'protocols/upstream-snapshot.json');
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function normalizeUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/** Забирает уникальные HTTP(S)-URL в порядке документа; остальной текст не важен. */
function extractSourceUrls(markdown) {
  const found = new Set();
  const urls = [];
  const re = /https?:\/\/[^\s<>"'`()]+/gi;
  for (const match of String(markdown || '').matchAll(re)) {
    const normalized = normalizeUrl(match[0].replace(/[.,;:!?]+$/g, ''));
    if (!normalized || found.has(normalized)) continue;
    found.add(normalized);
    urls.push(normalized);
  }
  return urls.sort(compareText);
}

function normalizeFingerprint(fingerprint) {
  if (!fingerprint || typeof fingerprint !== 'object') return null;
  const result = { status: Number(fingerprint.status) };
  if (!Number.isInteger(result.status)) return null;
  result.etag = typeof fingerprint.etag === 'string' && fingerprint.etag ? fingerprint.etag : null;
  result.lastModified = typeof fingerprint.lastModified === 'string' && fingerprint.lastModified ? fingerprint.lastModified : null;
  result.sha256 = typeof fingerprint.sha256 === 'string' && fingerprint.sha256 ? fingerprint.sha256 : null;
  return result;
}

function fingerprintsEqual(left, right) {
  return JSON.stringify(normalizeFingerprint(left)) === JSON.stringify(normalizeFingerprint(right));
}

function classifyResult(baseline, current) {
  if (baseline && baseline.mode === 'skip') {
    return { status: 'not-fetchable', reason: String(baseline.reason || 'источник помечен как неснимаемый') };
  }
  if (!current || current.kind !== 'checked') {
    return {
      status: 'not-checked',
      reason: String((current && current.reason) || 'источник не удалось проверить'),
    };
  }
  const currentFingerprint = normalizeFingerprint(current.fingerprint);
  if (!currentFingerprint) {
    return { status: 'not-checked', reason: 'получен некорректный отпечаток' };
  }
  const baselineFingerprint = baseline && normalizeFingerprint(baseline.fingerprint);
  if (!baselineFingerprint) return { status: 'baseline-missing', current: currentFingerprint };
  return fingerprintsEqual(baselineFingerprint, currentFingerprint)
    ? { status: 'unchanged', baseline: baselineFingerprint, current: currentFingerprint }
    : { status: 'changed', baseline: baselineFingerprint, current: currentFingerprint };
}

async function cancelBody(response) {
  try {
    if (response && response.body && typeof response.body.cancel === 'function') await response.body.cancel();
  } catch { /* тело уже закрыто сервером */ }
}

async function hashResponseBody(response, maxBytes = MAX_BODY_BYTES) {
  if (!response || !response.body || typeof response.body.getReader !== 'function') {
    const bytes = Buffer.from(response ? await response.arrayBuffer() : []);
    if (bytes.length > maxBytes) return null;
    return crypto.createHash('sha256').update(bytes).digest('hex');
  }

  const reader = response.body.getReader();
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      hash.update(Buffer.from(value));
    }
    return hash.digest('hex');
  } catch {
    try { await reader.cancel(); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Делает GET и снимает стабильный отпечаток. Для SPA/закрытых страниц запись
 * snapshot с mode=skip обрабатывается до сетевого запроса.
 */
async function fetchFingerprint(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_BODY_BYTES,
} = {}) {
  if (typeof fetchImpl !== 'function') return { kind: 'not-checked', reason: 'fetch-unavailable' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'User-Agent': 'mock-services-upstream-sync/1.0',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.1',
      },
    });
    const status = Number(response && response.status);
    if (!Number.isInteger(status)) return { kind: 'not-checked', reason: 'invalid-response' };
    if (status === 401 || status === 403) {
      await cancelBody(response);
      return { kind: 'not-checked', reason: `http-${status}-restricted` };
    }
    if (status === 429 || status >= 500) {
      await cancelBody(response);
      return { kind: 'not-checked', reason: status === 429 ? 'http-429-rate-limited' : `http-${status}-temporary` };
    }

    const getHeader = (name) => response.headers && typeof response.headers.get === 'function'
      ? response.headers.get(name)
      : null;
    const etag = getHeader('etag');
    const lastModified = getHeader('last-modified');
    let sha256 = null;
    if (!etag && !lastModified && status >= 200 && status < 300) {
      sha256 = await hashResponseBody(response, maxBytes);
      if (!sha256) {
        return { kind: 'not-checked', reason: controller.signal.aborted ? 'timeout' : 'body-too-large-or-unreadable' };
      }
    } else {
      await cancelBody(response);
    }

    return {
      kind: 'checked',
      fingerprint: normalizeFingerprint({
        status,
        etag: etag || null,
        lastModified: lastModified || null,
        sha256,
      }),
    };
  } catch {
    return { kind: 'not-checked', reason: controller.signal.aborted ? 'timeout' : 'network-error' };
  } finally {
    clearTimeout(timeout);
  }
}

function readSnapshot() {
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.sources)) {
    throw new Error('protocols/upstream-snapshot.json: ожидается schemaVersion=1 и массив sources');
  }
  const entries = new Map();
  for (const item of snapshot.sources) {
    const url = normalizeUrl(item && item.url);
    if (!url) throw new Error('upstream-snapshot.json содержит невалидный URL');
    if (entries.has(url)) throw new Error(`upstream-snapshot.json содержит повтор URL: ${url}`);
    const mode = item.mode || 'check';
    if (!['check', 'skip'].includes(mode)) throw new Error(`upstream-snapshot.json содержит неизвестный mode для ${url}`);
    const entry = { url, mode };
    if (mode === 'skip') {
      entry.reason = String(item.reason || 'источник намеренно не снимается через curl');
    } else {
      entry.fingerprint = normalizeFingerprint(item.fingerprint);
      if (item.reason) entry.reason = String(item.reason);
    }
    entries.set(url, entry);
  }
  return entries;
}

function serializeSnapshot(entries) {
  const sources = Array.from(entries.values())
    .sort((a, b) => compareText(a.url, b.url))
    .map((entry) => entry.mode === 'skip'
      ? { url: entry.url, mode: 'skip', reason: entry.reason }
      : {
        url: entry.url,
        mode: 'check',
        fingerprint: normalizeFingerprint(entry.fingerprint),
        ...(entry.reason ? { reason: entry.reason } : {}),
      });
  return `${JSON.stringify({ schemaVersion: 1, sources }, null, 2)}\n`;
}

function updateSnapshot(sourceUrls, oldEntries, results) {
  const next = new Map();
  for (const url of sourceUrls) {
    const old = oldEntries.get(url);
    if (old && old.mode === 'skip') {
      next.set(url, old);
      continue;
    }
    const result = results.get(url);
    if (result && result.kind === 'checked') {
      next.set(url, { url, mode: 'check', fingerprint: normalizeFingerprint(result.fingerprint) });
      continue;
    }
    next.set(url, {
      url,
      mode: 'check',
      fingerprint: old ? old.fingerprint : null,
      ...(old && old.reason ? { reason: old.reason } : {}),
    });
  }
  fs.writeFileSync(SNAPSHOT_FILE, serializeSnapshot(next));
  return next;
}

async function buildReport(sourceUrls, baselines, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const entries = await Promise.all(sourceUrls.map(async (url) => {
    const baseline = baselines.get(url) || null;
    const current = baseline && baseline.mode === 'skip'
      ? { kind: 'not-checked', reason: baseline.reason }
      : await fetchFingerprint(url, { fetchImpl, timeoutMs });
    return { url, baseline, current, ...classifyResult(baseline, current) };
  }));
  return entries.sort((a, b) => compareText(a.url, b.url));
}

function formatFingerprint(fingerprint) {
  if (!fingerprint) return 'нет отпечатка';
  const detail = [`HTTP ${fingerprint.status}`];
  if (fingerprint.etag) detail.push(`ETag ${JSON.stringify(fingerprint.etag)}`);
  if (fingerprint.lastModified) detail.push(`Last-Modified ${JSON.stringify(fingerprint.lastModified)}`);
  if (fingerprint.sha256) detail.push(`SHA-256 ${fingerprint.sha256}`);
  return detail.join('; ');
}

function textStatus(status) {
  return status === 'not-checked' ? 'не проверено'
    : status === 'not-fetchable' ? 'не снимается'
      : status === 'baseline-missing' ? 'нет baseline'
        : status;
}

function printTextReport(results, updated = false) {
  console.log('== Сверка upstream-источников (report-only; snapshot меняется только с --update) ==');
  for (const result of results) {
    let detail = result.reason ? ` — ${result.reason}` : '';
    if (result.status === 'changed') {
      detail = ` — baseline: ${formatFingerprint(result.baseline)}; current: ${formatFingerprint(result.current)}`;
    } else if (result.status === 'baseline-missing') {
      detail = ` — нет сохранённого отпечатка; current: ${formatFingerprint(result.current)}`;
    }
    console.log(`[${textStatus(result.status)}] ${result.url}${detail}`);
  }
  if (updated) console.log(`Снимок обновлён по явному запросу: ${path.relative(ROOT, SNAPSHOT_FILE)}`);
}

async function main(argv = process.argv.slice(2)) {
  const jsonOutput = argv.includes('--json');
  const update = argv.includes('--update');
  const linksText = fs.readFileSync(LINKS_FILE, 'utf8');
  const sourceUrls = extractSourceUrls(linksText);
  const oldEntries = readSnapshot();
  const timeoutArg = argv.find((arg) => arg.startsWith('--timeout-ms='));
  const timeoutMs = timeoutArg ? Number(timeoutArg.slice('--timeout-ms='.length)) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('--timeout-ms должен быть положительным числом');

  const results = await buildReport(sourceUrls, oldEntries, { timeoutMs });
  if (update) {
    const resultMap = new Map(results.map((result) => [result.url, result.current]));
    updateSnapshot(sourceUrls, oldEntries, resultMap);
  }

  const report = {
    reportOnly: true,
    snapshotUpdated: update,
    sources: results.map((result) => ({
      url: result.url,
      status: result.status,
      ...(result.status === 'not-checked' ? { message: 'не проверено' } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.baseline && result.baseline.fingerprint ? { baseline: result.baseline.fingerprint } : {}),
      ...(result.current && result.current.kind === 'checked' ? { current: result.current.fingerprint } : {}),
    })),
  };
  if (jsonOutput) console.log(JSON.stringify(report, null, 2));
  else printTextReport(results, update);
  return 0;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[upstream-sync] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  extractSourceUrls,
  normalizeFingerprint,
  fingerprintsEqual,
  classifyResult,
  hashResponseBody,
  fetchFingerprint,
  readSnapshot,
  serializeSnapshot,
  updateSnapshot,
  buildReport,
  main,
};
