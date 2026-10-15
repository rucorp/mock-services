// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const manifest = require('./site-manifest.cjs');
const SITE_BUILD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SITE_BUILD_DIR, '..');
const OUTPUTS = [
  { directory: path.join(ROOT, 'dist'), base: '/mock-services/' },
  { directory: path.join(ROOT, 'dist-root'), base: '/' },
];
const problems = [];

function fail(message) {
  problems.push(message);
}

function htmlForSource(directory, sourcePath) {
  const outputPath = manifest.getOutputMarkdownPath(sourcePath).replace(/\.md$/i, '');
  const candidates = outputPath === 'index'
    ? [path.join(directory, 'index.html')]
    : [
      path.join(directory, ...outputPath.split('/'), 'index.html'),
      path.join(directory, ...`${outputPath}.html`.split('/')),
    ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function listFiles(directory, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) listFiles(absolute, out);
    else if (entry.isFile()) out.push(absolute);
  }
  return out;
}

function readMeta(html, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = html.match(new RegExp(`<meta\\s+[^>]*name=["']${escapedName}["'][^>]*>`, 'i'))?.[0];
  return tag?.match(/content=["']([^"']*)["']/i)?.[1] || '';
}

function readCanonical(html) {
  const tag = html.match(/<link\s+[^>]*rel=["']canonical["'][^>]*>/i)?.[0];
  return tag?.match(/href=["']([^"']*)["']/i)?.[1] || '';
}

function sourceRoute(sourcePath) {
  return manifest.getRouteForSource(sourcePath);
}

function hrefsAndSrcs(html) {
  const values = [];
  for (const match of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) values.push(match[1]);
  return values;
}

function localFileForUrl(directory, base, urlPath) {
  if (!urlPath.startsWith(base)) return null;
  const relative = decodeURIComponent(urlPath.slice(base.length)).replace(/^\/+/, '');
  const candidate = path.resolve(directory, relative);
  if (candidate !== directory && !candidate.startsWith(`${directory}${path.sep}`)) return null;
  const candidates = [candidate];
  if (urlPath.endsWith('/') || !path.extname(candidate)) {
    candidates.push(path.join(candidate, 'index.html'));
    if (!path.extname(candidate)) candidates.push(`${candidate}.html`);
  }
  return candidates.find((file) => fs.existsSync(file)) || null;
}

function checkInternalReferences(directory, base, pageFiles) {
  const samplePage = pageFiles[0];
  for (const htmlFile of pageFiles) {
    const html = fs.readFileSync(htmlFile, 'utf8');
    const relative = path.relative(directory, htmlFile).split(path.sep).join('/');
    const pageRoute = relative === 'index.html'
      ? ''
      : relative.replace(/(?:\/index)?\.html$/, '').replace(/index\.html$/, '');
    const pageUrl = new URL(`${base}${pageRoute}`, 'https://docs.example.test');

    for (const reference of hrefsAndSrcs(html)) {
      if (/^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(reference)) continue;
      const resolved = new URL(reference, pageUrl);
      if (resolved.origin !== 'https://docs.example.test') continue;
      const file = localFileForUrl(directory, base, resolved.pathname);
      if (!file) {
        fail(`${path.relative(ROOT, htmlFile)}: внутренняя ссылка/ресурс не найден: ${reference}`);
      }
    }
  }
  if (!samplePage) fail(`${path.relative(ROOT, directory)}: нет HTML-файлов`);
}

function createStaticServer(directory, base) {
  return http.createServer((request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    } catch (error) {
      response.writeHead(400).end('bad request');
      return;
    }
    if (!pathname.startsWith(base)) {
      response.writeHead(404).end('not found');
      return;
    }

    let relative = pathname.slice(base.length).replace(/^\/+/, '');
    let candidate = path.resolve(directory, relative || 'index.html');
    if (candidate !== directory && !candidate.startsWith(`${directory}${path.sep}`)) {
      response.writeHead(404).end('not found');
      return;
    }
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) candidate = path.join(candidate, 'index.html');
    if (!fs.existsSync(candidate) && !path.extname(candidate)) {
      const alternatives = [path.join(candidate, 'index.html'), `${candidate}.html`];
      candidate = alternatives.find((file) => fs.existsSync(file)) || candidate;
    }
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      response.writeHead(404).end('not found');
      return;
    }

    const extension = path.extname(candidate).toLowerCase();
    const contentType = extension === '.html' ? 'text/html; charset=utf-8'
      : extension === '.js' ? 'text/javascript; charset=utf-8'
        : extension === '.css' ? 'text/css; charset=utf-8'
          : extension === '.svg' ? 'image/svg+xml'
            : 'application/octet-stream';
    response.writeHead(200, { 'content-type': contentType });
    fs.createReadStream(candidate).pipe(response);
  });
}

async function smokeHttp(directory, base) {
  const server = createStaticServer(directory, base);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const samples = [
    { route: '/', phrase: 'моки банков' },
    { route: '/docs/overview/', phrase: 'Банки — эквайринг' },
    { route: '/docs/integration/tbank-eacq/', phrase: 'Init' },
    { route: '/docs/integration/taxcom/', phrase: 'AccountList' },
    { route: '/services/tbank-mock/README/', phrase: 'tbank-mock' },
  ];

  try {
    for (const sample of samples) {
      const response = await fetch(`http://127.0.0.1:${port}${base}${sample.route.replace(/^\//, '')}`);
      assert.equal(response.status, 200, `${base}${sample.route} вернул HTTP ${response.status}`);
      const html = await response.text();
      assert.match(html, /<h1\b/i, `${base}${sample.route}: нет статического h1`);
      assert.ok(html.includes(sample.phrase), `${base}${sample.route}: отсутствует текст «${sample.phrase}»`);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function checkLegacyRedirect() {
  const source = fs.readFileSync(path.join(SITE_BUILD_DIR, 'public', 'legacy-redirect.js'), 'utf8');
  const cases = [
    { base: '/mock-services/', hash: '#/guide/tbank', expected: '/mock-services/docs/integration/tbank-eacq/' },
    { base: '/mock-services/', hash: '#/docs/integration/taxcom.md?id=accountlist', expected: '/mock-services/docs/integration/taxcom/#accountlist' },
    { base: '/mock-services/', hash: '#/', expected: '/mock-services/docs/overview/' },
    { base: '/', hash: '#/', expected: '/docs/overview/' },
    { base: '/mock-services/', hash: '#/README', expected: '/mock-services/' },
  ];

  for (const testCase of cases) {
    let destination = '';
    const context = {
      URLSearchParams,
      decodeURIComponent,
      encodeURIComponent,
      document: { currentScript: { getAttribute: () => testCase.base } },
      window: {
        location: {
          hash: testCase.hash,
          replace: (value) => { destination = value; },
        },
      },
    };
    vm.runInNewContext(source, context);
    assert.equal(destination, testCase.expected, `legacy redirect ${testCase.hash}`);
  }
}

function checkOutput({ directory, base }) {
  if (!fs.existsSync(directory)) {
    fail(`${path.relative(ROOT, directory)} отсутствует; запустите сборку site-build`);
    return;
  }

  const allFiles = listFiles(directory);
  const htmlFiles = allFiles.filter((file) => file.endsWith('.html'));
  const pages = [];
  const titles = new Map();
  const descriptions = new Map();
  const canonicals = new Map();
  const expectedDocuments = manifest.getPublicDocuments();

  for (const sourcePath of expectedDocuments) {
    const htmlFile = htmlForSource(directory, sourcePath);
    if (!htmlFile) {
      fail(`${path.relative(ROOT, directory)}: для ${sourcePath} не создан HTML`);
      continue;
    }
    pages.push(htmlFile);
    const html = fs.readFileSync(htmlFile, 'utf8');
    const title = html.match(/<title>([^<]*)<\/title>/i)?.[1] || '';
    const description = readMeta(html, 'description');
    const canonical = readCanonical(html);
    const relative = path.relative(ROOT, htmlFile);

    if (!/<h1\b/i.test(html)) fail(`${relative}: статическая HTML-страница без h1`);
    const staticToc = html.match(/<nav class="doc-static-toc"[^>]*>[\s\S]*?<\/nav>/i)?.[0] || '';
    if (!staticToc) fail(`${relative}: нет статического оглавления в HTML`);
    const headingIds = new Set([...html.matchAll(/<h[1-3]\b[^>]*\bid="([^"]+)"/gi)].map((match) => match[1]));
    const tocLinks = [...staticToc.matchAll(/class="doc-static-toc__link"\s+href="#([^"]+)"/g)];
    if (tocLinks.length === 0) fail(`${relative}: статическое оглавление не перечисляет заголовки h1–h3`);
    const tocTargets = new Set(tocLinks.map((link) => link[1]));
    for (const link of tocLinks) {
      if (!headingIds.has(link[1])) fail(`${relative}: оглавление ведёт к отсутствующему якорю #${link[1]}`);
    }
    for (const headingId of headingIds) {
      if (!tocTargets.has(headingId)) fail(`${relative}: оглавление не содержит заголовок #${headingId}`);
    }
    if (!title.trim()) fail(`${relative}: нет непустого title`);
    if (!description.trim()) fail(`${relative}: нет непустого meta description`);
    if (!canonical.startsWith('https://rucorp.github.io/mock-services/')) {
      fail(`${relative}: отсутствует canonical URL проекта`);
    }
    if (!html.includes('Редактировать на GitHub') || !html.includes('Исходник (.md)')) {
      fail(`${relative}: нет ссылок на редактирование и исходник Markdown`);
    }
    if (!/class="prev-next"/.test(html) || !/class="VPLink link pager-link (?:prev|next)"/.test(html)) {
      fail(`${relative}: нет статической навигации на предыдущую/следующую страницу`);
    }
    if (/href=["']#\//i.test(html)) fail(`${relative}: обнаружена старая ссылка docsify href="#/"`);
    for (const reference of hrefsAndSrcs(html)) {
      if (/https?:\/\/(?:localhost|127\.0\.0\.1)(?=[:/"'])/i.test(reference)) {
        fail(`${relative}: localhost используется как href/src: ${reference}`);
      }
    }
    if (!html.includes(`data-base="${base}"`)) fail(`${relative}: скрипт legacy-route не получил base=${base}`);

    for (const [value, map, label] of [
      [title, titles, 'title'],
      [description, descriptions, 'description'],
      [canonical, canonicals, 'canonical'],
    ]) {
      const previous = map.get(value);
      if (previous) fail(`${relative}: ${label} дублируется с ${path.relative(ROOT, previous)}`);
      else map.set(value, htmlFile);
    }
  }

  if (pages.length !== expectedDocuments.length) {
    fail(`${path.relative(ROOT, directory)}: найдено ${pages.length}/${expectedDocuments.length} страниц Markdown`);
  }
  checkInternalReferences(directory, base, htmlFiles);
  return { directory, base, pages };
}

async function main() {
  try {
    checkLegacyRedirect();
  } catch (error) {
    fail(`проверка legacy redirect: ${error.message}`);
  }

  const outputs = OUTPUTS.map(checkOutput).filter(Boolean);
  for (const output of outputs) {
    try {
      await smokeHttp(output.directory, output.base);
    } catch (error) {
      fail(`HTTP smoke для base=${output.base}: ${error.message}`);
    }
  }

  if (problems.length) {
    console.error('Проверка статической сборки сайта:');
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
    return;
  }

  const pageCount = outputs[0]?.pages.length || 0;
  console.log(`site build OK: ${pageCount} страниц Markdown; HTTP без JS: base=/mock-services/ и base=/; legacy routes OK`);
}

await main();
