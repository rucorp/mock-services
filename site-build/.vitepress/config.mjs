// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'vitepress';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));
const SITE_BUILD_DIR = path.resolve(CONFIG_DIR, '..');
const ROOT = path.resolve(SITE_BUILD_DIR, '..');
const WORK_DIR = path.join(SITE_BUILD_DIR, '.work');
const CONTENT_DIR = path.join(WORK_DIR, 'content');
const sourceMap = JSON.parse(fs.readFileSync(path.join(WORK_DIR, 'source-map.json'), 'utf8'));
const sidebar = JSON.parse(fs.readFileSync(path.join(WORK_DIR, 'sidebar.json'), 'utf8'));
const base = process.env.SITE_BASE || '/mock-services/';
const outputDir = process.env.SITE_OUT_DIR || path.resolve(ROOT, 'dist');
const canonicalBase = '/mock-services/';
const canonicalOrigin = 'https://rucorp.github.io';

function sourceFor(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  return sourceMap[normalized] || normalized;
}

function firstHeading(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+?)\s*#*\s*$/m);
  if (!match) return fallback;
  return match[1]
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function plainText(markdown) {
  return markdown
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/^\s*#{1,6}\s+.*$/gm, ' ')
    .replace(/^\s*>\s?/gm, ' ')
    .replace(/^\s*(?:[-*+]\s+|\d+\.\s+)/gm, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pageDescription(markdown, title, sourcePath) {
  const body = markdown.replace(/^#\s+.+?\s*#*\s*$/m, ' ');
  const summary = plainText(body).slice(0, 220);
  const uniqueTitle = title || sourcePath;
  const description = summary ? `${uniqueTitle}. ${summary}` : `Документация mock-services: ${uniqueTitle}.`;
  return description.slice(0, 300);
}

function publicCanonical(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  const route = normalized === 'index.md'
    ? ''
    : `${normalized.replace(/\.md$/i, '')}/`;
  return `${canonicalOrigin}${canonicalBase}${route}`;
}

/* Сохраняем прежние Markdown-якоря docsify; внутренние ссылки не меняют смысл. */
function slugifyHeading(text) {
  return String(text)
    .trim()
    .replace(/[A-Z]+/g, (match) => match.toLowerCase())
    .replace(/<[^>]+>/g, '')
    .replace(/[\u2000-\u206F\u2E00-\u7E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
    .replace(/\s/g, '-')
    .replace(/-+/g, '-')
    .replace(/^(\d)/, '_$1');
}

export default defineConfig({
  lang: 'ru',
  title: 'mock-services',
  description: 'Документация тестовых моков банков, касс и ОФД проекта mock-services.',
  base,
  srcDir: CONTENT_DIR,
  outDir: outputDir,
  cleanUrls: true,
  lastUpdated: false,
  markdown: {
    languageAlias: { env: 'shell' },
    anchor: {
      slugify: slugifyHeading,
    },
    headers: {
      level: [1, 2, 3],
      slugify: slugifyHeading,
    },
  },
  head: [
    ['link', { rel: 'icon', href: `${base}favicon.svg`, type: 'image/svg+xml' }],
    ['script', { src: `${base}legacy-redirect.js`, 'data-base': base }],
  ],
  themeConfig: {
    siteTitle: 'mock-services',
    nav: [
      { text: 'Главная', link: '/' },
      { text: 'Карта документации', link: '/docs/overview' },
    ],
    sidebar,
    outline: { level: [1, 3], label: 'На этой странице' },
    docFooter: { prev: 'Предыдущая', next: 'Следующая' },
  },
  transformPageData(pageData) {
    const stagedPath = pageData.relativePath.replaceAll('\\', '/');
    const sourcePath = sourceFor(stagedPath);
    const markdown = fs.readFileSync(path.join(ROOT, ...sourcePath.split('/')), 'utf8');
    const fallback = path.basename(sourcePath, '.md');
    const title = firstHeading(markdown, fallback);
    pageData.title = title;
    pageData.description = pageDescription(markdown, title, sourcePath);
    pageData.frontmatter = pageData.frontmatter || {};
    pageData.frontmatter.sourcePath = sourcePath;
    return pageData;
  },
  transformHead({ pageData }) {
    return [
      ['link', { rel: 'canonical', href: publicCanonical(pageData.relativePath) }],
    ];
  },
});
