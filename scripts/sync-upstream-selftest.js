// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const sync = require('./sync-upstream');

async function main() {
  const urls = sync.extractSourceUrls(`
    Primary: https://example.test/api. Duplicate: https://example.test/api
    SPA: https://developer.example.test/state (read in browser).
  `);
  assert.deepStrictEqual(urls, ['https://developer.example.test/state', 'https://example.test/api']);

  const initial = { mode: 'check', fingerprint: null };
  const missing = sync.classifyResult(initial, { kind: 'checked', fingerprint: { status: 200, sha256: 'a'.repeat(64) } });
  assert.strictEqual(missing.status, 'baseline-missing');
  assert.strictEqual(sync.classifyResult({ mode: 'skip', reason: 'SPA' }, null).status, 'not-fetchable');
  assert.strictEqual(sync.classifyResult(initial, { kind: 'not-checked', reason: 'timeout' }).status, 'not-checked');

  const oldFingerprint = { status: 200, etag: 'W/"one"', lastModified: null, sha256: null };
  assert.strictEqual(sync.classifyResult({ mode: 'check', fingerprint: oldFingerprint }, { kind: 'checked', fingerprint: { ...oldFingerprint } }).status, 'unchanged');
  assert.strictEqual(sync.classifyResult({ mode: 'check', fingerprint: oldFingerprint }, { kind: 'checked', fingerprint: { ...oldFingerprint, etag: '"two"' } }).status, 'changed');

  const withEtag = await sync.fetchFingerprint('https://example.test/etag', {
    fetchImpl: async () => new Response('ignored when ETag is present', { status: 200, headers: { ETag: '"v1"' } }),
  });
  assert.deepStrictEqual(withEtag, {
    kind: 'checked',
    fingerprint: { status: 200, etag: '"v1"', lastModified: null, sha256: null },
  });

  const body = 'stable upstream body';
  const withHash = await sync.fetchFingerprint('https://example.test/body', {
    fetchImpl: async () => new Response(body, { status: 200 }),
  });
  assert.strictEqual(withHash.kind, 'checked');
  assert.strictEqual(withHash.fingerprint.sha256, crypto.createHash('sha256').update(body).digest('hex'));

  const restricted = await sync.fetchFingerprint('https://example.test/private', {
    fetchImpl: async () => new Response('unauthorized', { status: 401 }),
  });
  assert.deepStrictEqual(restricted, { kind: 'not-checked', reason: 'http-401-restricted' });

  const networkFailure = await sync.fetchFingerprint('https://example.test/down', {
    fetchImpl: async () => { throw new Error('network details are not stable across Node versions'); },
  });
  assert.deepStrictEqual(networkFailure, { kind: 'not-checked', reason: 'network-error' });

  const entriesA = new Map([
    ['https://z.test/', { url: 'https://z.test/', mode: 'skip', reason: 'SPA' }],
    ['https://a.test/', { url: 'https://a.test/', mode: 'check', fingerprint: null }],
  ]);
  const entriesB = new Map(Array.from(entriesA.entries()).reverse());
  assert.strictEqual(sync.serializeSnapshot(entriesA), sync.serializeSnapshot(entriesB), 'serialization sorts URLs deterministically');

  console.log('sync-upstream selftest: 11 passed, 0 failed');
}

main().catch((error) => {
  console.error('sync-upstream selftest failed:', error);
  process.exitCode = 1;
});
