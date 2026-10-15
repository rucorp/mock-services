// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const manifest = require('./site-manifest.cjs');
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SITE_BUILD_DIR = path.resolve(SCRIPT_DIR, '..');
const ROOT = path.resolve(SITE_BUILD_DIR, '..');
const WORK_DIR = path.join(SITE_BUILD_DIR, '.work');
const PUBLIC_DIR = path.join(SITE_BUILD_DIR, 'public');

function option(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function normalizeBase(value) {
  const base = String(value || '/mock-services/');
  if (!base.startsWith('/') || base.includes('..') || base.includes('?') || base.includes('#')) {
    throw new Error(`Некорректная база сайта: ${base}`);
  }
  return base.endsWith('/') ? base : `${base}/`;
}

function resolveRepositoryTarget(sourcePath, target) {
  const cleanTarget = target.split(/[?#]/, 1)[0];
  const repositoryPath = cleanTarget.startsWith('/')
    ? cleanTarget.replace(/^\/+/, '')
    : path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), cleanTarget));
  if (repositoryPath === '..' || repositoryPath.startsWith('../')) return null;
  return repositoryPath;
}

function rewriteNonMarkdownLinks(markdown, sourcePath, publicDocuments) {
  const lines = markdown.split('\n');
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;

    return line.replace(/(\]\()([^)]+)(\))/g, (whole, prefix, rawTarget, suffix) => {
      const match = rawTarget.match(/^(\S+)([\s\S]*)$/);
      if (!match) return whole;
      const target = match[1].replace(/^<|>$/g, '');
      const tail = match[2];
      if (/^(?:https?:|mailto:|tel:|data:|#|\/\/)/i.test(target)) return whole;

      const repositoryPath = resolveRepositoryTarget(sourcePath, target);
      if (!repositoryPath) return whole;
      const absolutePath = path.join(ROOT, ...repositoryPath.split('/'));
      if (!fs.existsSync(absolutePath)) return whole;

      const markdownTarget = /\.md(?:$|[?#])/i.test(target);
      if (markdownTarget && repositoryPath === 'README.md') {
        const fragment = target.match(/([?#].*)$/)?.[1] || '';
        return `${prefix}/${fragment}${tail}${suffix}`;
      }
      if (markdownTarget && publicDocuments.has(repositoryPath)) return whole;

      const kind = fs.statSync(absolutePath).isDirectory() || target.endsWith('/') ? 'tree' : 'blob';
      const fragment = target.match(/([?#].*)$/)?.[1] || '';
      const githubPath = repositoryPath.split('/').map(encodeURIComponent).join('/');
      return `${prefix}https://github.com/rucorp/mock-services/${kind}/main/${githubPath}${fragment}${tail}${suffix}`;
    });
  }).join('\n');
}

function removeHtmlComments(markdown) {
  return markdown.replace(/<!--[\s\S]*?-->/g, '');
}

function escapeLiteralAnglePlaceholders(markdown) {
  const htmlTags = new Set([
    'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'div', 'em', 'h1', 'h2', 'h3',
    'hr', 'i', 'img', 'input', 'kbd', 'li', 'ol', 'p', 'pre', 's', 'small', 'span', 'strong',
    'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul',
  ]);
  const lines = markdown.split('\n');
  let fenceMarker = '';

  return lines.map((line) => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (!fenceMarker) fenceMarker = fence[1][0];
      else if (fence[1][0] === fenceMarker) fenceMarker = '';
      return line;
    }
    if (fenceMarker) return line;

    let output = '';
    let codeTicks = 0;
    for (let index = 0; index < line.length;) {
      if (line[index] === '`') {
        let end = index + 1;
        while (line[end] === '`') end++;
        const count = end - index;
        if (codeTicks === 0) codeTicks = count;
        else if (codeTicks === count) codeTicks = 0;
        output += line.slice(index, end);
        index = end;
        continue;
      }

      if (line[index] === '<' && codeTicks === 0) {
        const close = line.indexOf('>', index + 1);
        if (close !== -1) {
          const inner = line.slice(index + 1, close);
          const tagName = inner.match(/^\/?([a-z][a-z0-9-]*)/i)?.[1]?.toLowerCase();
          const looksLikeHtml = tagName && htmlTags.has(tagName)
            && /^\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?$/i.test(inner);
          const isAutolink = /^(?:https?:\/\/|mailto:)/i.test(inner);
          if (!looksLikeHtml && !isAutolink) output += `&lt;${inner}&gt;`;
          else output += line.slice(index, close + 1);
          index = close + 1;
          continue;
        }
      }

      output += line[index];
      index++;
    }
    return output;
  }).join('\n');
}

function preserveVueLikeInlineCode(markdown) {
  const lines = markdown.split('\n');
  let fenceMarker = '';
  return lines.map((line) => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (!fenceMarker) fenceMarker = fence[1][0];
      else if (fence[1][0] === fenceMarker) fenceMarker = '';
      return line;
    }
    if (fenceMarker) return line;
    return line.replace(/`([^`]*\{\{[^`]*\}\}[^`]*)`/g, (_whole, code) => {
      const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<code v-pre>${escaped}</code>`;
    });
  }).join('\n');
}

function markdownHeadingSlug(text) {
  return String(text)
    .trim()
    .replace(/[A-Z]+/g, (match) => match.toLowerCase())
    .replace(/<[^>]+>/g, '')
    .replace(/[\u2000-\u206F\u2E00-\u7E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
    .replace(/\s/g, '-')
    .replace(/-+/g, '-')
    .replace(/^(\d)/, '_$1');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function buildStaticTableOfContents(markdown) {
  const headings = [];
  const slugCounts = new Map();
  const lines = markdown.split('\n');
  let fenceMarker = '';
  let firstTitleIndex = -1;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (!fenceMarker) fenceMarker = fence[1][0];
      else if (fence[1][0] === fenceMarker) fenceMarker = '';
      continue;
    }
    if (fenceMarker) continue;

    const match = line.match(/^\s{0,3}(#{1,3})\s+(.*?)\s*$/);
    if (!match) continue;
    const title = match[2]
      .replace(/\s+#+\s*$/, '')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\*([^*]*)\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .trim();
    const slugBase = markdownHeadingSlug(title);
    const duplicate = slugCounts.get(slugBase) || 0;
    slugCounts.set(slugBase, duplicate + 1);
    const level = match[1].length;
    headings.push({ level, title, slug: duplicate ? `${slugBase}-${duplicate}` : slugBase });
    if (level === 1 && firstTitleIndex === -1) firstTitleIndex = lineIndex;
  }

  if (!headings.length) return markdown;
  const items = headings.map(({ level, title, slug }) => (
    `    <li class="doc-static-toc__item doc-static-toc__item--${level}"><a class="doc-static-toc__link" href="#${escapeHtml(slug)}">${escapeHtml(title)}</a></li>`
  ));
  const nav = [
    '<nav class="doc-static-toc" v-pre aria-label="Оглавление">',
    '  <p class="doc-static-toc__title">Оглавление</p>',
    '  <ul>',
    ...items,
    '  </ul>',
    '</nav>',
  ].join('\n');

  if (firstTitleIndex === -1) return `${nav}\n\n${markdown}`;
  lines.splice(firstTitleIndex + 1, 0, '', nav, '');
  return lines.join('\n');
}

function copyDirectoryContents(source, destination) {
  if (!fs.existsSync(source)) return;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyDirectoryContents(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function walkHtml(directory, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walkHtml(absolute, out);
    else if (entry.isFile() && entry.name.endsWith('.html')) out.push(absolute);
  }
  return out;
}

/* VitePress emits <route>.html; GitHub Pages clean URLs need <route>/index.html. */
function convertHtmlFilesToDirectoryRoutes(outputDir) {
  for (const htmlFile of walkHtml(outputDir)) {
    const relative = path.relative(outputDir, htmlFile).split(path.sep).join('/');
    if (relative === 'index.html' || relative === '404.html') continue;
    const destination = path.join(path.dirname(htmlFile), path.basename(htmlFile, '.html'), 'index.html');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(htmlFile, destination);
  }
}

function build() {
  const base = normalizeBase(option('base', process.env.SITE_BASE));
  const outputArgument = option('out', base === '/' ? '../dist-root' : '../dist');
  const outputDir = path.resolve(SITE_BUILD_DIR, outputArgument);
  const contentDir = path.join(WORK_DIR, 'content');
  const workPublicDir = path.join(contentDir, 'public');

  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(workPublicDir, { recursive: true });

  const sourceMap = {};
  const publicDocuments = new Set(manifest.getPublicDocuments());
  for (const sourcePath of publicDocuments) {
    const sourceFile = path.join(ROOT, ...sourcePath.split('/'));
    const outputPath = manifest.getOutputMarkdownPath(sourcePath);
    const stagedFile = path.join(contentDir, ...outputPath.split('/'));
    fs.mkdirSync(path.dirname(stagedFile), { recursive: true });
    const markdown = fs.readFileSync(sourceFile, 'utf8');
    const withoutComments = removeHtmlComments(markdown);
    const escapedPlaceholders = escapeLiteralAnglePlaceholders(withoutComments);
    const withStaticToc = buildStaticTableOfContents(escapedPlaceholders);
    const stagedMarkdown = rewriteNonMarkdownLinks(withStaticToc, sourcePath, publicDocuments);
    fs.writeFileSync(stagedFile, preserveVueLikeInlineCode(stagedMarkdown), 'utf8');
    sourceMap[outputPath] = sourcePath;
  }

  fs.writeFileSync(path.join(WORK_DIR, 'source-map.json'), JSON.stringify(sourceMap, null, 2));
  fs.writeFileSync(path.join(WORK_DIR, 'sidebar.json'), JSON.stringify(manifest.parseSidebar(), null, 2));
  copyDirectoryContents(PUBLIC_DIR, workPublicDir);
  fs.copyFileSync(path.join(ROOT, 'site', 'favicon.svg'), path.join(workPublicDir, 'favicon.svg'));
  fs.copyFileSync(path.join(ROOT, '.nojekyll'), path.join(workPublicDir, '.nojekyll'));

  const vitepressCli = path.join(SITE_BUILD_DIR, 'node_modules', 'vitepress', 'bin', 'vitepress.js');
  if (!fs.existsSync(vitepressCli)) {
    throw new Error('VitePress не установлен. Выполните `npm ci` в site-build/.');
  }

  console.log(`Сборка сайта: base=${base}, output=${path.relative(ROOT, outputDir)}`);
  const result = spawnSync(process.execPath, [vitepressCli, 'build', SITE_BUILD_DIR], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      SITE_BASE: base,
      SITE_OUT_DIR: outputDir,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  convertHtmlFilesToDirectoryRoutes(outputDir);
  console.log(`Статический сайт собран: ${path.relative(ROOT, outputDir)}`);
}

try {
  build();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
