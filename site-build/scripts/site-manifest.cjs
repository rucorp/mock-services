// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const ROOT_DOCUMENTS = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'AGENTS.md',
  'CHANGELOG.md',
];
const PUBLIC_DIRECTORIES = ['docs', 'services', 'packages'];

function listMarkdown(directory, out = []) {
  if (!fs.existsSync(directory)) return out;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) listMarkdown(absolute, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(path.relative(ROOT, absolute).split(path.sep).join('/'));
    }
  }
  return out;
}

function getPublicDocuments() {
  const documents = [...ROOT_DOCUMENTS];
  for (const directory of PUBLIC_DIRECTORIES) {
    documents.push(...listMarkdown(path.join(ROOT, directory)));
  }
  return documents.sort((left, right) => left.localeCompare(right, 'en'));
}

function markdownTargetToRoute(target) {
  const trimmed = String(target || '').trim();
  if (/^(?:https?:)?\/\//i.test(trimmed) || /^(?:mailto:|tel:)/i.test(trimmed)) return trimmed;

  const hashIndex = trimmed.indexOf('#');
  const pathPart = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
  const anchor = hashIndex === -1 ? '' : trimmed.slice(hashIndex);
  const sourcePath = pathPart.replace(/^\/+/, '').replace(/\.md$/i, '');
  const route = sourcePath === 'README' || sourcePath === 'index' || !sourcePath
    ? '/'
    : `/${sourcePath.replace(/\/$/, '')}/`;
  return `${route}${anchor}`;
}

function parseSidebar(sidebarText = fs.readFileSync(path.join(ROOT, '_sidebar.md'), 'utf8')) {
  const roots = [];
  const stack = [{ indent: -1, items: roots }];

  for (const line of sidebarText.split(/\r?\n/)) {
    const match = line.match(/^(\s*)-\s+(.+?)\s*$/);
    if (!match) continue;

    const indent = match[1].replace(/\t/g, '  ').length;
    const content = match[2];
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].items;
    const linkMatch = content.match(/^\[([^\]]+)\]\(([^)]+)\)$/);

    if (linkMatch) {
      parent.push({ text: linkMatch[1], link: markdownTargetToRoute(linkMatch[2]) });
      continue;
    }

    const label = content.match(/^\*\*(.+)\*\*$/)?.[1] || content.replace(/`/g, '');
    const group = { text: label, items: [] };
    parent.push(group);
    stack.push({ indent, items: group.items });
  }

  return roots;
}

function getOutputMarkdownPath(sourcePath) {
  return sourcePath === 'README.md' ? 'index.md' : sourcePath;
}

function getRouteForSource(sourcePath) {
  if (sourcePath === 'README.md') return '/';
  return `/${sourcePath.replace(/\.md$/i, '')}/`;
}

module.exports = {
  ROOT,
  getPublicDocuments,
  getOutputMarkdownPath,
  getRouteForSource,
  markdownTargetToRoute,
  parseSidebar,
};
