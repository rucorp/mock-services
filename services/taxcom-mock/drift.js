// © 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Читаем dispatch-таблицы НЕ из OpenAPI: OpenAPI проверяется независимо.
// Selftest удаляет каждую сторону отдельно, исключая тавтологическую проверку.
function verifyRoutes(serverSource, openapi, manifest) {
  const serverRoutes = new Set();
  for (const m of serverSource.matchAll(/\['(GET|POST|PUT|DELETE)',\s*'([^']+)'\]/g)) serverRoutes.add(`${m[1]} ${m[2]}`);
  const table = /const MOCK_ROUTES = \{([\s\S]*?)\n\};/.exec(serverSource)?.[1] || '';
  for (const m of table.matchAll(/'([^']+)':\s*\[([^\]]+)\]/g)) {
    for (const method of m[2].matchAll(/'(GET|POST|PUT|DELETE)'/g)) serverRoutes.add(`${method[1]} ${m[1]}`);
  }
  return [...manifest.routes, ...manifest.mockRoutes].map(({ method, path }) => ({
    method, path, inServer: serverRoutes.has(`${method} ${path}`),
    inOpenApi: Boolean(openapi.paths?.[path]?.[method.toLowerCase()]),
  }));
}
module.exports = { verifyRoutes };
