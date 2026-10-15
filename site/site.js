/* © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 *
 * Служебный слой сайта документации (docsify-плагины):
 *   - переключатель светлой/тёмной темы с сохранением выбора;
 *   - правая колонка «на этой странице» со слежением за прокруткой;
 *   - якоря у заголовков, кнопки «копировать» у блоков кода;
 *   - GFM-сноски (для документов вне публичного репозитория);
 *   - корректные ссылки на не-markdown файлы (OpenAPI/JSON/YAML → GitHub);
 *   - хлебные крошки, ссылка «на GitHub», навигация «назад/вперёд».
 *
 * Никаких внешних зависимостей: только вендоренный docsify (site/vendor/).
 */

(function () {
  'use strict';

  var REPO = 'rucorp/mock-services';
  var BRANCH = 'main';
  var THEME_KEY = 'mock-services.theme';

  var GITHUB_BLOB = 'https://github.com/' + REPO + '/blob/' + BRANCH + '/';
  var GITHUB_TREE = 'https://github.com/' + REPO + '/tree/' + BRANCH + '/';
  var GITHUB_EDIT = 'https://github.com/' + REPO + '/blob/' + BRANCH + '/';

  /* ----------------------------------------------------------
   * Утилиты
   * -------------------------------------------------------- */

  /* Слаг точно как у docsify, иначе не совпадут якоря заголовков. */
  function slugify(text) {
    return String(text)
      .toLowerCase()
      .trim()
      .replace(/<[!\/a-z].*?>/gi, '')
      .replace(/[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
      .replace(/\s/g, '-');
  }

  function el(tag, className, html) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /* Мини-разметка внутри сносок: `код`, **жирный**, [ссылка](url), *курсив*. */
  function inlineMarkdown(text) {
    var out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (all, label, href) {
      if (/^https?:/i.test(href)) {
        return '<a href="' + href + '" target="_blank" rel="noopener">' + label + '</a>';
      }
      return '<span class="doc-external-ref">' + label + '</span>';
    });
    out = out.replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    return out;
  }

  /* Разбор markdown на строки с учётом ограждённых блоков кода. */
  function mapLines(markdown, handler) {
    var lines = markdown.split('\n');
    var inFence = false;
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var fence = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        inFence = !inFence;
        out.push(line);
        continue;
      }
      out.push(inFence ? line : handler(line, i, lines));
    }
    return out.join('\n');
  }

  /* Ссылка на якорь внутри страницы в формате docsify (#/path?id=slug):
     «голый» #slug конфликтует с hash-роутером. */
  function pageAnchor(vm, id) {
    try {
      var file = (vm && vm.route && vm.route.file) || '';
      var path = '/' + file.replace(/^\//, '');
      if (vm && vm.router && vm.router.toURL) return vm.router.toURL(path, { id: id });
    } catch (e) { /* оставляем запасной вариант */ }
    return '#' + id;
  }

  function stripInlineCode(line) {
    var parts = line.split('`');
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      out += i % 2 === 0 ? parts[i] : '\u0000' + parts[i] + '\u0000';
    }
    return { line: out, restore: function (text) { return text.replace(/\u0000([\s\S]*?)\u0000/g, '`$1`'); } };
  }

  /* ----------------------------------------------------------
   * Тема
   * -------------------------------------------------------- */

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(theme, persist) {
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#14161c' : '#ffffff');
    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch (e) { /* приватный режим — просто не запоминаем */ }
    }
    var button = document.querySelector('.theme-toggle');
    if (button) {
      button.setAttribute('aria-label', theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему');
      button.setAttribute('title', theme === 'dark' ? 'Светлая тема' : 'Тёмная тема');
    }
  }

  function initTheme() {
    applyTheme(currentTheme(), false);

    document.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('.theme-toggle');
      if (!button) return;
      event.preventDefault();
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
    });

    if (window.matchMedia) {
      var query = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function (event) {
        var saved = null;
        try {
          saved = localStorage.getItem(THEME_KEY);
        } catch (e) { /* ignore */ }
        if (!saved) applyTheme(event.matches ? 'dark' : 'light', false);
      };
      if (query.addEventListener) query.addEventListener('change', onChange);
      else if (query.addListener) query.addListener(onChange);
    }
  }

  /* ----------------------------------------------------------
   * Сноски (GFM): [^id] + определения [^id]: текст
   * -------------------------------------------------------- */

  function installFootnotes(hook, vm) {
    hook.beforeEach(function (markdown) {
      if (markdown.indexOf('[^') === -1) return markdown;

      var definitions = [];
      var collected = 0;
      var lastIndex = -1;

      /* 1. Вынимаем определения из текста. */
      var body = mapLines(markdown, function (line) {
        var match = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
        if (!match) return line;
        definitions.push({ id: match[1], text: match[2] });
        collected = definitions.length - 1;
        lastIndex = 0;
        return '\u0000FN-DEF-' + (definitions.length - 1) + '\u0000';
      });

      /* Продолжения определения (строки с отступом) приклеиваем к последнему. */
      if (collected >= 0 && lastIndex >= 0) {
        body = body.replace(/\u0000FN-DEF-(\d+)\u0000\n((?:[ \t]{2,}[^\n]*\n?)+)/g, function (all, idx) {
          return '\u0000FN-DEF-' + idx + '\u0000';
        });
      }
      body = body.replace(/\u0000FN-DEF-\d+\u0000\n?/g, '');

      if (!definitions.length) return markdown;

      var used = {};
      var order = [];

      /* 2. Меняем ссылки [^id] на номера. */
      body = mapLines(body, function (line) {
        if (line.indexOf('[^') === -1) return line;
        var guarded = stripInlineCode(line);
        var replaced = guarded.line.replace(/\[\^([^\]\s]+)\]/g, function (all, id) {
          var index = definitions.findIndex(function (d) {
            return d.id === id;
          });
          if (index === -1) return all;
          var key = definitions[index].id;
          if (!used[key]) {
            used[key] = order.length + 1;
            order.push(key);
          }
          var num = used[key];
          return (
            '<sup class="footnote-ref" id="fnref-' + num + '">' +
            '<a href="' + pageAnchor(vm, 'fn-' + num) + '" aria-label="Сноска ' + num + '">' + num + '</a></sup>'
          );
        });
        return guarded.restore(replaced);
      });

      if (!order.length) return body;

      /* 3. Собираем список сносок в конце страницы. */
      var items = order
        .map(function (key, index) {
          var def = definitions.find(function (d) {
            return d.id === key;
          });
          return (
            '<li id="fn-' + (index + 1) + '">' + inlineMarkdown(def.text) +
            ' <a class="footnote-backref" href="' + pageAnchor(vm, 'fnref-' + (index + 1)) +
            '" aria-label="Назад к тексту">↩</a></li>'
          );
        })
        .join('');

      return (
        body +
        '\n\n<div class="footnotes"><p class="footnotes__title">Сноски</p><ol>' + items + '</ol></div>\n'
      );
    });
  }

  /* ----------------------------------------------------------
   * Ссылки: .md — страница docsify, остальное — GitHub / файл сайта
   * -------------------------------------------------------- */

  var FILE_EXT_RE = /\.[a-z0-9]{1,8}$/i;
  var IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico)$/i;
  var MD_LINK_RE = /(!?)\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*([^)\s]+?)(\s+"[^"]*")?\s*\)/g;

  /* Путь относительно корня репозитория — как в ссылках на GitHub. */
  function resolveRepoPath(fromFile, target) {
    var stack = String(fromFile || '').split('/');
    stack.pop(); /* имя самого файла */
    var parts = String(target).split('/');
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '' || parts[i] === '.') continue;
      if (parts[i] === '..') stack.pop();
      else stack.push(parts[i]);
    }
    return stack.join('/');
  }

  function siteOrigin() {
    return /^https?:$/i.test(location.protocol) ? location.origin : '';
  }

  /* Относительные ссылки в markdown приводим к однозначным адресам: docsify
     считает относительные ссылки маршрутами и дописывает к ним «.md»
     (docs/openapi/x.json → x.json.md → 404). Поэтому:
       .md           → маршрут от корня сайта (страница docsify);
       картинки/.html→ абсолютный адрес файла на этом же сайте;
       всё остальное → файл в GitHub (OpenAPI, manifests, yml, js). */
  function installLinkNormalization(hook, vm) {
    hook.beforeEach(function (markdown) {
      if (markdown.indexOf('](') === -1) return markdown;

      var file = (vm.route && vm.route.file) || '';
      var base = vm.router && vm.router.getBasePath ? vm.router.getBasePath() : '/';
      if (base.charAt(base.length - 1) !== '/') base += '/';
      var origin = siteOrigin();

      return mapLines(markdown, function (line) {
        if (line.indexOf('](') === -1) return line;
        var guarded = stripInlineCode(line);
        var replaced = guarded.line.replace(
          MD_LINK_RE,
          function (all, bang, label, target, title) {
            if (!target) return all;
            if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.charAt(0) === '#' || target.charAt(0) === '/') return all;

            var hash = '';
            var cut = target.search(/[?#]/);
            if (cut !== -1) {
              hash = target.slice(cut);
              target = target.slice(0, cut);
            }
            if (!target) return all;

            var resolved = resolveRepoPath(file, target);
            if (!resolved) return all;

            var attrs = title || '';
            if (/\.md$/i.test(resolved)) {
              return bang + '[' + label + '](/' + resolved + hash + attrs + ')';
            }
            if (IMAGE_EXT_RE.test(resolved) || /\.html$/i.test(resolved)) {
              if (!origin) return all;
              return bang + '[' + label + '](' + origin + base + resolved + hash + attrs + ')';
            }
            if (!FILE_EXT_RE.test(resolved)) {
              /* ссылка на каталог — на GitHub показываем дерево файлов */
              return '[' + label + '](' + GITHUB_TREE + resolved.replace(/\/$/, '') + attrs + ')';
            }
            return '[' + label + '](' + GITHUB_BLOB + resolved + hash + attrs + ')';
          }
        );
        return guarded.restore(replaced);
      });
    });
  }

  /* Ссылки из markdown docsify уже приводит к маршрутам (#/path); .md в них
     отбрасывается, поэтому «это страница документации» определяем по
     отсутствию расширения файла. Всё остальное (OpenAPI/JSON/YAML/…) уводим
     в GitHub, локальные HTML-снимки — на файл сайта. */
  function normalizeLink(anchor, basePathForPage, router) {
    var href = anchor.getAttribute('href');
    if (!href) return;

    if (anchor.getAttribute('title') === 'undefined') anchor.removeAttribute('title');

    if (/^https?:/i.test(href)) {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener');
      return;
    }
    if (/^(mailto|tel|data|javascript):/i.test(href)) return;

    var isRoute = href.charAt(0) === '#';
    var raw = isRoute ? href.slice(1) : href;
    if (!raw) return;

    var clean = raw.split('#')[0].split('?')[0];
    if (!clean) return;

    /* страница документации: .md-ссылка или маршрут без расширения */
    if (/\.md$/i.test(clean) || (isRoute && !FILE_EXT_RE.test(clean))) return;

    var base = router && router.getBasePath ? router.getBasePath() : '/';
    if (base.charAt(base.length - 1) !== '/') base += '/';

    var resolved;
    if (isRoute) {
      resolved = clean.replace(/^\//, '');
    } else if (clean.indexOf(base) === 0) {
      resolved = clean.slice(base.length);
    } else {
      resolved = resolveRepoPath(basePathForPage, clean);
    }
    if (!resolved) return;

    if (FILE_EXT_RE.test(resolved) === false) {
      anchor.setAttribute('href', GITHUB_TREE + resolved.replace(/\/$/, ''));
    } else if (/\.[a-z0-9]+$/i.test(resolved) && /\.html$/i.test(resolved)) {
      /* Локальные HTML-снимки документации провайдеров открываем как файл сайта. */
      anchor.setAttribute('href', base + resolved);
    } else {
      anchor.setAttribute('href', GITHUB_BLOB + resolved);
    }
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener');
    anchor.setAttribute('data-external-file', resolved);
  }

  /* ----------------------------------------------------------
   * Якоря: документы пишутся под GitHub (слаги в нижнем регистре), а docsify
   * кириллические заглавные не понижает («## Быстрый старт» → Быстрый-старт).
   * Сопоставляем якоря по «ключу» из букв и цифр и мягко прокручиваем.
   * -------------------------------------------------------- */

  function anchorKey(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^0-9a-zа-я]+/g, '');
  }

  function findAnchor(id) {
    var direct = id && document.getElementById(id);
    if (direct) return direct;
    var wanted = anchorKey(decodeURIComponent(String(id || '')));
    if (!wanted) return null;
    var nodes = document.querySelectorAll('.markdown-section [id], .footnotes [id]');
    for (var i = 0; i < nodes.length; i++) {
      if (anchorKey(nodes[i].id) === wanted) return nodes[i];
    }
    return null;
  }

  function scrollToAnchor(node) {
    if (!node) return;
    var root = parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
    var headerVar = window.getComputedStyle(document.documentElement).getPropertyValue('--header-h');
    var header = headerVar ? parseFloat(headerVar) * (/rem/.test(headerVar) ? root : 1) : 0;
    var top = node.getBoundingClientRect().top + window.pageYOffset - (header + root * 0.9);
    window.scrollTo({ top: top > 0 ? top : 0, behavior: 'auto' });
  }

  function fixAnchors(article, vm) {
    var file = (vm.route && vm.route.file) || '';
    if (!file) return;
    var filePath = '/' + file.replace(/^\//, '');

    /* ссылки на эту же страницу: «чужой» якорь правим на канонический id */
    Array.prototype.forEach.call(article.querySelectorAll('a[href^="#"]'), function (link) {
      var parts = (link.getAttribute('href') || '').slice(1).split('?id=');
      if (parts.length !== 2) return;
      if (normPath(parts[0]) !== normPath(filePath)) return;
      var id = decodeURIComponent(parts[1]);
      if (document.getElementById(id)) return;
      var node = findAnchor(id);
      if (node) link.setAttribute('href', vm.router.toURL(filePath, { id: node.id }));
    });

    /* ?id= в адресе: точное совпадение прокрутит docsify, мягкое — мы */
    var wanted = vm.route && vm.route.query ? vm.route.query.id : null;
    if (wanted && findAnchor(wanted) && !document.getElementById(decodeURIComponent(wanted))) {
      scrollToAnchor(findAnchor(wanted));
    }
  }

  /* ----------------------------------------------------------
   * Оглавление страницы, якоря, кнопки «копировать», таблицы
   * -------------------------------------------------------- */

  function buildPageToc(article, vm) {
    var old = article.querySelector('.page-toc');
    if (old) old.remove();

    var headings = Array.prototype.filter.call(
      article.querySelectorAll('h2, h3, h4'),
      function (heading) {
        return !heading.closest('.footnotes');
      }
    );
    if (headings.length < 2) return null;

    var title = article.querySelector('h1');
    var nav = el('nav', 'page-toc');
    nav.setAttribute('aria-label', 'На этой странице');
    nav.appendChild(el('p', 'page-toc__title', title ? title.textContent.trim() : 'На этой странице'));

    var list = el('ul', 'page-toc__list');
    var used = {};
    headings.forEach(function (heading) {
      var text = heading.textContent.replace(/¶/g, '').trim();
      if (!text) return;
      var id = heading.id;
      if (!id) {
        var base = slugify(text);
        var candidate = base;
        var counter = 2;
        while (used[candidate] || document.getElementById(candidate)) {
          candidate = base + '-' + counter++;
        }
        used[candidate] = true;
        id = candidate;
        heading.id = id;
      }
      var item = el('li', 'page-toc__item page-toc__item--' + heading.tagName.toLowerCase());
      var link = el('a', null, escapeHtml(text));
      link.setAttribute('href', pageAnchor(vm, id));
      item.appendChild(link);
      list.appendChild(item);
    });

    nav.appendChild(list);
    return nav;
  }

  /* Заголовки docsify уже оборачивает в <a class="anchor"> с id — своего
     якоря не добавляем, ¶ рисует CSS на :hover. Здесь только добираем
     отсутствующие id (заголовки внутри HTML-блоков) и чистим дубли иконок. */
  function prepareHeadings(article) {
    Array.prototype.forEach.call(article.querySelectorAll('h1, h2, h3, h4, h5, h6'), function (heading) {
      if (heading.closest('.footnotes')) return;
      if (!heading.id) {
        var text = heading.textContent.trim();
        if (!text) return;
        heading.id = slugify(text);
      }
    });
  }

  function addCodeCopyButtons(article) {
    Array.prototype.forEach.call(article.querySelectorAll('pre'), function (pre) {
      if (pre.querySelector('.copy-code-btn')) return;
      var button = el(
        'button',
        'copy-code-btn',
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>'
      );
      button.setAttribute('type', 'button');
      button.setAttribute('aria-label', 'Скопировать код');
      button.setAttribute('title', 'Скопировать');
      button.addEventListener('click', function () {
        var code = pre.querySelector('code');
        var text = code ? code.innerText : pre.innerText;
        copyText(text, function (ok) {
          if (!ok) return;
          button.classList.add('is-copied');
          button.setAttribute('title', 'Скопировано');
          setTimeout(function () {
            button.classList.remove('is-copied');
            button.setAttribute('title', 'Скопировать');
          }, 1600);
        });
      });
      pre.appendChild(button);
    });
  }

  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { done(true); },
        function () { done(legacyCopy(text)); }
      );
      return;
    }
    done(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch (e) {
      return false;
    }
  }

  function wrapTables(article) {
    Array.prototype.forEach.call(article.querySelectorAll('table'), function (table) {
      if (table.parentNode && table.parentNode.classList.contains('table-wrap')) return;
      var wrap = el('div', 'table-wrap');
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
  }

  /* ----------------------------------------------------------
   * Оглавление страницы: подсветка текущего раздела при прокрутке
   * -------------------------------------------------------- */

  var tocSpyFrame = null;

  function updateTocSpy() {
    tocSpyFrame = null;
    var toc = document.querySelector('.page-toc');
    if (!toc) return;
    var links = Array.prototype.slice.call(toc.querySelectorAll('a[href]'));
    if (!links.length) return;

    var offset = 96;
    var active = null;
    for (var i = 0; i < links.length; i++) {
      var id = decodeURIComponent((links[i].getAttribute('href') || '').split('?id=').pop());
      var target = document.getElementById(id);
      if (!target) continue;
      if (target.getBoundingClientRect().top - offset <= 0) active = links[i];
      else break;
    }
    links.forEach(function (link) {
      link.classList.toggle('is-active', link === active);
    });
  }

  function scheduleTocSpy() {
    if (tocSpyFrame !== null) return;
    if (typeof window.requestAnimationFrame === 'function') {
      tocSpyFrame = window.requestAnimationFrame(updateTocSpy);
    } else {
      tocSpyFrame = setTimeout(updateTocSpy, 60);
    }
  }

  /* ----------------------------------------------------------
   * Мета страницы: крошки, «на GitHub», навигация назад/вперёд
   * -------------------------------------------------------- */

  function sidebarLinks() {
    return Array.prototype.slice
      .call(document.querySelectorAll('.sidebar-nav a'))
      .filter(function (link) {
        return link.getAttribute('href') && link.getAttribute('href').indexOf('#') === 0;
      });
  }

  function linkPath(link) {
    var href = link.getAttribute('href').replace(/^#/, '');
    return href.split('?')[0].split('#')[0];
  }

  function buildPageMeta(article, vm) {
    var old = article.querySelector('.page-meta');
    if (old) old.remove();

    var routeFile = (vm.route && vm.route.file) || '';
    var current = normPath(routeFile);
    var links = sidebarLinks();
    var active = null;
    for (var i = 0; i < links.length; i++) {
      if (normPath(linkPath(links[i])) === current) {
        active = links[i];
        break;
      }
    }

    var meta = el('div', 'page-meta');
    var crumbs = [];
    crumbs.push('<a href="#/">Документация</a>');

    if (active) {
      var labels = [];
      var node = active.closest('li');
      while (node) {
        var parent = node.parentNode;
        while (parent && parent.classList && parent.classList.contains('app-sub-sidebar')) {
          parent = parent.parentNode;
        }
        if (parent && parent.classList && parent.classList.contains('sidebar-nav')) break;
        var holder = parent ? parent.closest('li') : null;
        if (holder) {
          var label = holder.querySelector(':scope > p, :scope > a');
          if (label && label.textContent.trim() && labels.indexOf(label.textContent.trim()) === -1) {
            labels.unshift(label.textContent.trim());
          }
          node = holder;
        } else {
          break;
        }
      }
      labels.forEach(function (label) {
        crumbs.push(escapeHtml(label));
      });
    }

    meta.innerHTML = crumbs.join('<span class="page-meta__sep">›</span>');
    meta.appendChild(
      el(
        'span',
        'page-meta__edit',
        '<a href="' + GITHUB_EDIT + routeFile + '" target="_blank" rel="noopener">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2z"/></svg>' +
          '<span>Открыть на GitHub</span></a>'
      )
    );
    article.insertBefore(meta, article.firstChild);
  }

  function buildPageNav(article, vm) {
    var old = article.querySelector('.page-nav');
    if (old) old.remove();

    var routeFile = (vm.route && vm.route.file) || '';
    var current = normPath(routeFile);
    var links = sidebarLinks();
    var seen = {};
    var flow = [];

    links.forEach(function (link) {
      var path = normPath(linkPath(link));
      if (!path || seen[path]) return;
      seen[path] = true;
      flow.push({ path: path, label: link.textContent.trim(), href: link.getAttribute('href') });
    });

    var index = -1;
    for (var i = 0; i < flow.length; i++) {
      if (flow[i].path === current) {
        index = i;
        break;
      }
    }
    if (index === -1) return;

    var prev = flow[index - 1];
    var next = flow[index + 1];
    if (!prev && !next) return;

    var nav = el('nav', 'page-nav');
    nav.setAttribute('aria-label', 'Навигация по документации');
    if (prev) {
      nav.appendChild(
        el(
          'a',
          'page-nav__link page-nav__link--prev',
          '<span class="page-nav__hint">← Назад</span><span class="page-nav__title">' +
            escapeHtml(prev.label) +
            '</span>'
        )
      );
      nav.lastChild.setAttribute('href', prev.href);
    }
    if (next) {
      nav.appendChild(
        el(
          'a',
          'page-nav__link page-nav__link--next',
          '<span class="page-nav__hint">Дальше →</span><span class="page-nav__title">' +
            escapeHtml(next.label) +
            '</span>'
        )
      );
      nav.lastChild.setAttribute('href', next.href);
    }
    article.appendChild(nav);
  }

  /* ----------------------------------------------------------
   * Сайдбар: активный пункт, сворачиваемые разделы и подсветка
   * -------------------------------------------------------- */

  function normPath(value) {
    /* docsify отбрасывает расширение .md в маршрутах — сравниваем без него */
    return ('/' + String(value || '').replace(/^[#/]+/, '')).replace(/\.md$/i, '');
  }

  /* Отмечаем текущую страницу в сайдбаре: li.active + раскрытый раздел. */
  function markActiveSidebar(vm) {
    var current = normPath((vm.route && vm.route.file) || '');
    var links = Array.prototype.slice.call(document.querySelectorAll('.sidebar-nav a'));
    var match = null;

    links.forEach(function (link) {
      link.parentNode.classList.remove('active');
      var href = link.getAttribute('href') || '';
      if (href.charAt(0) !== '#') return;
      var path = normPath(href.replace(/^#/, '').split('?')[0].split('#')[0]);
      if (path !== current) return;
      if (!match) match = link;
    });

    if (match) match.parentNode.classList.add('active');
    return match;
  }

  var SECTIONS_KEY = 'mock-services.sections';

  function readSections() {
    try {
      return JSON.parse(localStorage.getItem(SECTIONS_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function saveSections(state) {
    try {
      localStorage.setItem(SECTIONS_KEY, JSON.stringify(state));
    } catch (e) { /* ignore */ }
  }

  function decorateSidebar() {
    var root = document.querySelector('.sidebar-nav > ul');
    if (!root) return;

    var state = readSections();
    var items = Array.prototype.slice.call(root.children);

    items.forEach(function (item) {
      var label = item.querySelector(':scope > p');
      var list = item.querySelector(':scope > ul');
      if (!label || !list) return;
      if (label.classList.contains('nav-toggle')) return;

      var key = label.textContent.trim();
      label.classList.add('nav-toggle');
      item.classList.add('nav-section');
      label.setAttribute('role', 'button');
      label.setAttribute('tabindex', '0');

      var hasActive = !!item.querySelector('li.active');
      var collapsed;
      if (state.hasOwnProperty(key)) collapsed = state[key];
      else collapsed = !hasActive;

      item.classList.toggle('is-collapsed', collapsed);
      label.setAttribute('aria-expanded', String(!collapsed));

      var toggle = function () {
        var isCollapsed = !item.classList.contains('is-collapsed');
        item.classList.toggle('is-collapsed', isCollapsed);
        label.setAttribute('aria-expanded', String(!isCollapsed));
        state[key] = isCollapsed;
        saveSections(state);
      };

      label.addEventListener('click', toggle);
      label.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle();
        }
      });
    });

    var active = document.querySelector('.sidebar-nav li.active');
    if (active && active.scrollIntoView) {
      var aside = document.querySelector('.sidebar');
      var box = active.getBoundingClientRect();
      var asideBox = aside.getBoundingClientRect();
      if (box.top < asideBox.top + 40 || box.bottom > asideBox.bottom) {
        active.scrollIntoView({ block: 'center' });
      }
    }
  }

  /* ----------------------------------------------------------
   * Поиск: переносим поле из сайдбара в шапку
   * -------------------------------------------------------- */

  function relocateSearch() {
    var box = document.querySelector('.search');
    var slot = document.getElementById('site-search');
    if (box && slot && box.parentNode !== slot) slot.appendChild(box);
    var input = document.querySelector('.search input');
    if (input) input.setAttribute('aria-label', 'Поиск по документации');
  }

  /* ----------------------------------------------------------
   * Прочее: крошки, «наверх», маска, заголовок окна
   * -------------------------------------------------------- */

  function buildSidebarFooter() {
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar || sidebar.querySelector('.sidebar__footer')) return;
    var nav = sidebar.querySelector('.sidebar-nav');
    if (!nav) return;

    var footer = el(
      'div',
      'sidebar__footer',
      '<a href="https://github.com/' + REPO + '" target="_blank" rel="noopener">GitHub</a>' +
        ' · <a href="https://github.com/' + REPO + '/blob/' + BRANCH + '/LICENSE" target="_blank" rel="noopener">Apache-2.0</a>' +
        '<br>© 2026 ООО «Аксиома»'
    );
    if (nav.nextSibling) sidebar.insertBefore(footer, nav.nextSibling);
    else sidebar.appendChild(footer);
  }

  function initChrome() {
    buildSidebarFooter();

    var mask = document.querySelector('.mask');
    if (mask) {
      mask.addEventListener('click', function () {
        document.body.classList.remove('close');
      });
    }

    var top = el(
      'button',
      'back-to-top',
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l-8 8h5v8h6v-8h5z"/></svg>'
    );
    top.setAttribute('type', 'button');
    top.setAttribute('aria-label', 'Наверх');
    top.setAttribute('title', 'Наверх');
    top.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    document.body.appendChild(top);

    var onScroll = function () {
      top.classList.toggle('is-visible', window.scrollY > 600);
      scheduleTocSpy();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    document.addEventListener('keydown', function (event) {
      var target = event.target;
      var typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      if (typing) {
        if (event.key === 'Escape' && target.classList.contains('search-input')) target.blur();
        return;
      }
      if ((event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k'))) {
        var input = document.querySelector('.search input');
        if (input) {
          event.preventDefault();
          input.focus();
          input.select();
        }
      }
    });
  }

  /* ----------------------------------------------------------
   * Плагин docsify
   * -------------------------------------------------------- */

  function plugin(hook, vm) {
    installLinkNormalization(hook, vm);
    installFootnotes(hook, vm);

    hook.mounted(function () {
      relocateSearch();
      initChrome();
      if (document.body.classList.contains('close') === false && window.innerWidth < 1024) {
        document.body.classList.add('close');
      }
    });

    hook.doneEach(function () {
      var article = document.querySelector('.markdown-section');
      if (!article) return;
      try {
        renderPage(article, vm);
      } catch (error) {
        console.error('[mock-services] сбой отрисовки страницы:', error && error.message);
      }
    });
  }

  function renderPage(article, vm) {
      relocateSearch();
      prepareHeadings(article);
      wrapTables(article);
      addCodeCopyButtons(article);

      /* Оглавление держим первым блоком статьи: на широких экранах оно
         закрепляется справа через CSS. */
      var toc = buildPageToc(article, vm);
      var meta = article.querySelector('.page-meta');
      if (toc) article.insertBefore(toc, meta ? meta.nextSibling : article.firstChild);

      markActiveSidebar(vm);
      buildPageMeta(article, vm);
      buildPageNav(article, vm);
      decorateSidebar();
      scheduleTocSpy();

      /* Ссылки: не-markdown цели уводим в GitHub, внешние — в новую вкладку. */
      var page = (vm.route && vm.route.file) || '';
      Array.prototype.forEach.call(document.querySelectorAll('.markdown-section a[href]'), function (anchor) {
        normalizeLink(anchor, page, vm.router);
      });
      Array.prototype.forEach.call(document.querySelectorAll('.sidebar-nav a[href]'), function (anchor) {
        normalizeLink(anchor, '', vm.router);
      });

      var heading = article.querySelector('h1');
      var title = heading ? heading.textContent.trim() : 'Документация';
      document.title = title + ' — mock-services';

      fixAnchors(article, vm);

      var anchorId = vm.route && vm.route.query ? vm.route.query.id : null;
      if (!anchorId) window.scrollTo({ top: 0, behavior: 'auto' });
  }

  /* ----------------------------------------------------------
   * Конфигурация docsify
   * -------------------------------------------------------- */

  window.$docsify = {
    name: 'mock-services',
    nameLink: '#/',
    /* homepage не задаём: docsify подменяет им путь /README.md, а README должен открываться */
    alias: { '/': 'docs/overview' },
    loadSidebar: true,
    subMaxLevel: 0,
    maxLevel: 5,
    auto2top: true,
    notFoundPage: true,
    themeColor: '#673ab7',
    relativePath: true,
    search: {
      placeholder: 'Поиск по документации…',
      noData: 'Ничего не найдено. Попробуйте другое слово или посмотрите карту документации.',
      paths: 'auto',
      depth: 3,
      maxAge: 86400000,
      hideOtherSidebarContent: false
    },
    plugins: [plugin]
  };

  initTheme();

  window.__mockServices = { slugify: slugify, inlineMarkdown: inlineMarkdown };
})();
