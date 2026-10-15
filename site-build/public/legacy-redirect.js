// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

(function () {
  var legacyHash = window.location.hash || '';
  if (!legacyHash.startsWith('#/')) return;

  var script = document.currentScript;
  var base = script && script.getAttribute('data-base') || '/mock-services/';
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.endsWith('/')) base += '/';

  var route = legacyHash.slice(2);
  var anchor = '';
  var nestedHash = route.indexOf('#');
  if (nestedHash !== -1) {
    anchor = route.slice(nestedHash + 1);
    route = route.slice(0, nestedHash);
  }

  var queryIndex = route.indexOf('?');
  if (queryIndex !== -1) {
    var query = new URLSearchParams(route.slice(queryIndex + 1));
    anchor = anchor || query.get('id') || query.get('anchor') || '';
    route = route.slice(0, queryIndex);
  }

  try {
    route = decodeURIComponent(route);
    anchor = decodeURIComponent(anchor);
  } catch (error) {
    window.location.replace(base);
    return;
  }

  route = route.replace(/^\/+|\/+$/g, '').replace(/\.md$/i, '').replace(/\.html$/i, '');
  var aliases = {
    'guide/tbank': 'docs/integration/tbank-eacq',
    'guide/tbank-eacq': 'docs/integration/tbank-eacq',
    'guide/yookassa': 'docs/integration/yookassa',
    'guide/alfa': 'docs/integration/alfa',
    'guide/sber': 'docs/integration/sber',
    'guide/vtb': 'docs/integration/vtb',
    'guide/ferma-ofd': 'docs/integration/ferma-ofd',
    'guide/atol': 'docs/integration/atol',
    'guide/first-ofd': 'docs/integration/first-ofd',
    'guide/kontur-ofd': 'docs/integration/kontur-ofd',
    'guide/taxcom': 'docs/integration/taxcom',
  };
  route = aliases[route] || route;

  if (route === 'README' || route === 'index') route = '';
  else if (!route) route = 'docs/overview';
  if (route.split('/').some(function (segment) { return segment === '..'; })) {
    window.location.replace(base);
    return;
  }

  var destination = base + (route ? `${route}/` : '');
  if (anchor) destination += `#${encodeURIComponent(anchor)}`;
  window.location.replace(destination);
})();
