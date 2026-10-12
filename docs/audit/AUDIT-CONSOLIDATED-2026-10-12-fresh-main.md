© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Консолидированный аудит по свежему main — delta 90 позиций + новый слой alfa-mock — 2026-10-12

> **Issue:** [#54 — Арена \[P1\]: полный аудит по свежему main](https://github.com/rucorp/mock-services/issues/54)
> **База:** `main` @ `f89f76f` (после #46, #47 и док-прохода партии A / PR #55) · версия `0.5.0` · Node v22.22.3 · npm 10.9.8 · `git status` чист на старте
> **Режим:** только чтение. Код, тесты, compose, CI, манифесты и OpenAPI не менялись; добавлен единственный файл — этот отчёт.
> **Прежний консолидированный отчёт-предшественник:** [AUDIT-CONSOLIDATED-2026-10-12.md](AUDIT-CONSOLIDATED-2026-10-12.md) — **не перезаписывался**; настоящий файл — его delta по текущему дереву, а не замена.
> **Партии-источники:** [A](AUDIT-PARTY-A-2026-10-12.md) · [A1a](AUDIT-PARTY-A1a-2026-10-12.md) · [A1b](AUDIT-PARTY-A1b-2026-10-12.md) · [A2](AUDIT-PARTY-A2-2026-10-12.md) · [B](AUDIT-PARTY-B-2026-10-12.md) · [C](AUDIT-PARTY-C-2026-10-12.md) · [D](AUDIT-PARTY-D-2026-10-12.md) · [E](AUDIT-PARTY-E-2026-10-12.md) · [F](AUDIT-PARTY-F-2026-10-12.md); рамка — [AUDIT-PREP-2026-10-12.md](AUDIT-PREP-2026-10-12.md), чек-лист — [CHECKLIST-audit-party.md](CHECKLIST-audit-party.md), формат реестра — [REGISTRY-2026-10-11-code-sweep.md](REGISTRY-2026-10-11-code-sweep.md)

## 0. Что сделано и главный вывод

1. **Все 90 позиций** консолидированного реестра (A 30, B 10, C 16, D 11, E 18, F 5) повторно проверены на `f89f76f`
   по коду и докам; 25 позиций подтверждены **новыми живыми пробами** (HTTP-листенеры на `127.0.0.1:0`), рефы
   пересчитаны по текущему дереву. **Закрытых нет; все 90 остаются актуальными**; у 22 позиций строки сдвинулись
   (ядро после #46, скрипты/CI после док-прохода) — новые рефы в таблицах §1.
2. **Полный аудит `alfa-mock` по рамкам партии B** (§3): маршруты ↔ README ↔ манифест ↔ OpenAPI, идемпотентность,
   callback-ACK/checksum, редакция журнала, контроль доступа/CSRF, квоты и TTL, покрытие selftest. Базовые слои
   ядра (редакция, CSRF, fail-closed hosted, admission песочниц) в alfa работают; PA-50 в alfa подтверждён
   повторно (§3.5), как и в §7.4 партии A.
3. **Новые находки: 8** — PB-11…PB-14 (alfa), PC-17 (drift-чекер), PD-12 (include/alfa env), PE-19 (alfa,
   недоказанные маршруты/доки), PF-06 (реестр вердиктов 08.10 без строки alfa). Плюс три **расширения**
   существующих находок без новых ID: MS-16 (alfa: страницы оплаты без заголовков), PD-03/PD-06 (alfa env),
   PF-02 (тот же `[mock]`-префикс в yookassa).
4. **Коллизия ID:** запрошенная серия «PB-07…» занята (PB-07…PB-10 уже в партии B); новые ID начаты с **PB-11**.
   То же по PC/PD/PE/PF — серии продолжены с первого свободного номера.
5. `npm test` на базе и после работы — зелёный (§5.1). Кода не касались.

Приоритеты публичного стенда **не меняются**: P0-волна = PA-50 → PF-01 → MS-09 → PA-51 (см. §7).

---

## 1. Delta по 90 позициям

Формат строки: `ID · суть · статус на f89f76f · актуальный реф`.
Статусы: **актуальна** — подтверждена на текущем дереве (реф совпал либо уточнён), **актуальна (сдвиг)** —
подтверждена, строка сдвинулась относительно исходного отчёта, **актуальна (проба)** — подтверждена новой
живой пробой в этом проходе. Закрытых позиций нет — поэтому в таблицах их не помечаем.

### 1.1. Партия A — core/рантайм (PA-01…PA-09, PA-25…PA-33, PA-50…PA-61; 30 позиций)

Партия A уже обновляла реестр на этом же коде (PR #55, §7); здесь — сверка рефов и выборочные повторные пробы
по alfa-mock (пятый адаптер, добавленный #47 после исходной базы B–F).

| ID | Суть (кратко) | Статус | Актуальный реф |
|---|---|---|---|
| PA-01 | битый `%`-энкод в form-теле → необработанный URIError → HTTP 500 вместо 400 | актуальна (проба) | [`packages/core/index.js`](../../packages/core/index.js):258-267; проба: `POST /payment/rest/register.do` с `userName=%zz` → `500 {errorCode 6}` |
| PA-02 | утечки form-`rawBody` в журнал: `password_confirmation`, `a=1&&password=`, `token%5F2`; проба добавила `pass%77ord` | актуальна (проба) | core:467-498; [`services/alfa-mock/server.js`](../../services/alfa-mock/server.js):1686-1701 |
| PA-03 | PAN-сканер/редактор пропускает Amex (3-префикс) и короткий `Bearer` | актуальна (проба) | core:371-397; проба `redactRawBody`: Amex `378282246310005` и `Bearer abc123` не редактируются, Visa `4111…` — редактируется |
| PA-04 | молчаливая обрезка: массивы > 100, глубина > 12, без маркера | актуальна (проба) | core:428-466 (`REDACT_MAX_ARRAY_ITEMS=100`, `REDACT_MAX_DEPTH=12`) |
| PA-05 | `Content-Length` не сверяется с фактическим телом | актуальна (проба) | core:213-256; проба: заявлено 5000 байт, отправлено 56 — ответа нет (запрос висит), лечится только destroy |
| PA-06 | deprecated-событие `'aborted'` у потока запроса | актуальна | core:253 |
| PA-07 | `escapeHtml` не трогает backtick и `javascript:` (sink'ов не найдено) | актуальна (проба) | core:284-298 |
| PA-08 | `parseBody`: last-wins, литеральный `k[]`, BOM остаётся в имени ключа | актуальна (проба) | core:258-271 |
| PA-09 | fragment `#token=…` не редактируется в curl-генераторе и остаётся в `path` | актуальна (проба) | core:523-543, 555-575; проба: curl содержит `#token=FRAGMENT-SECRET-9` |
| PA-25 | hostname в скобках IPv6 → `ENOTFOUND`, 24 попытки сжигаются | актуальна | core:729-790 |
| PA-26 | guard пропускает `ff00::/8`, TEST-NET, `2001:db8::/32`, local-use NAT64; `::0:1` и decimal IPv4 блокируются | актуальна (проба §7.4 A) | core:865-882, 919-950, 984-1016 |
| PA-27 | unknown-ключи обходят per-entry byte cap журнала (до ~1 МБ на запись) | актуальна | core:671-728 |
| PA-28 | очередь доставки без eviction/капа, O(n) tick, poison без terminal-маркера | актуальна | core:1057-1152 |
| PA-29 | `prepare(+1)` + `onFailure(+1)` → attempts ×2, лимит исчерпывается одной попыткой | актуальна | core:1065-1080, 1130-1140 |
| PA-30 | `parseMsOr` без finite max-клампа: `maxSandboxes: Infinity` принимается | актуальна (§7.4 A) | core:1214-1245 |
| PA-31 | полный URL (userinfo/query) в логах очереди без редакции | актуальна | core:1108-1120 |
| PA-32 | `'1h30m'`/`'1e3'` → тихий fallback к дефолту | актуальна | core:1214-1245 |
| PA-33 | `at` записи журнала по wall-clock (а не виртуальным часам) | актуальна | core:671-700 |
| PA-50 | явные-id API песочниц не авторизуют target: владелец A читает/перезаписывает/сбрасывает песочницу B | актуальна (проба §3.5, §7.4 A) | core:2192-2195, 2422-2444, 2468-2479; alfa:1757-1795 (control-plane `/mock/*`) |
| PA-51 | реестр сценариев один на процесс (правило A срабатывает на B), `rules` без капа | актуальна | core:1499-1601 |
| PA-52 | общий флаг `ticking` + `tickAll` без await → за проход доставляется ≤1 песочница, голодание чужих очередей | актуальна | core:1085-1143, 2448-2456 |
| PA-53 | `safeEqual` docstring неточен при разной длине; Unicode сравнивается байт-в-байт (fail-closed) | актуальна | core:1617-1644 |
| PA-54 | `public`/`form`-политики в owned обходят заданный `MOCK_SANDBOX_TOKEN` | актуальна | core:2252-2288 |
| PA-55 | гонка переключения `activeId` в namespaces-режиме | актуальна | core:2367-2377 |
| PA-56 | `run()` выполняется даже при неуспешном admission | актуальна | core:2291-2294 |
| PA-57 | creds песочниц открытым текстом в registry-файле (owner-token — только hash); файл создаётся с umask, mode не задаётся | актуальна (проба §3.5) | core:2034-2051, 2061-2065; в alfa дополнительно `callbackSecret` — `POST /sandboxes` (alfa:1393-1454) |
| PA-58 | `createDeliveryQueue` по умолчанию `blockPrivateHosts=false`; `verifyMerchantWebhook` без флага не гардится | актуальна | core:1057-1073, 1103-1104, 2540-2560 |
| PA-59 | TTL/sweep/create-limit живут в wall-clock; ни один из 5 сервисов не передаёт `now` в runtime | актуальна | core:1993, 2218-2227, 2237, 2276, 2422-2444 + все 5 сервисов |
| PA-60 | `times:0` превращается в 1 | актуальна | core:1513-1515 |
| PA-61 | мёртвая legacy-ветка менеджера песочниц (не используется новым runtime) | актуальна | core:1771-1882 |

### 1.2. Партия B — «сироты» ЮKassa/АТОЛ (PB-01…PB-10; 10 позиций)

| ID | Суть (кратко) | Статус | Актуальный реф |
|---|---|---|---|
| PB-01 | АТОЛ: ключ дедупа `external_id` ищется с `trim()`, пишется без — повтор с пробелами создаёт второй чек | актуальна | [`services/atol-mock/server.js`](../../services/atol-mock/server.js):944-946, 986 vs :1545, 1571 |
| PB-02 | ЮKassa: в `CARDS` только MC-колонка отказов (22 Visa/МИР PAN из конспекта → `general_decline`) | актуальна | [`services/yookassa-mock/server.js`](../../services/yookassa-mock/server.js):202-222, 1272-1281 |
| PB-03 | `parseInt(x,10) \|\| N` у ЮKassa (`MOCK_RETRY_MS`, `MOCK_PENDING_TTL_MS`, `MOCK_REFUND_DELAY_MS`) и АТОЛ (`MOCK_CALLBACK_*`) | актуальна (расширена: alfa, PB-11) | yookassa:73-78; atol:117-118 |
| PB-04 | АТОЛ: `countAtolDocuments` считает `tokens`; цикл `getToken` выедает квоту документов | актуальна | atol:186-191, 210-216, 1522-1524 |
| PB-05 | selftest-покрытие: у ЮKassa нет hosted-блока и негативов (CSRF/413/import); у АТОЛ — CSRF/413/import/квоты | актуальна (расширена: alfa, PB-14) | yookassa selftest: `MOCK_HOSTED` — 1 совпадение, `413`/`csrf`/`proto` — 0; atol selftest: 2 / 0 / 0 |
| PB-06 | ЮKassa: при частичном capture `amount` объекта не меняется (не зафиксировано ни в конспекте, ни в README) | актуальна | yookassa:990-992, 1011-1023 |
| PB-07 | ЮKassa: `GET /payment/{id}/done` недостижим из флоу, текст противоречит валидации, теста нет | актуальна | yookassa:1240-1246, 1894-1898 |
| PB-08 | ЮKassa: `process3ds` может вернуть `stage:'form'`, а маршрут трактует любой не-`3ds` как успех → 302 | актуальна | yookassa:1323-1330, 1880-1892 |
| PB-09 | АТОЛ: `report` возвращает незадекларированные эхо-поля `external_id/group_code/type` | актуальна | atol:919-937 vs [`services/atol-mock/README.md`](../../services/atol-mock/README.md):66 |
| PB-10 | ЮKassa: пустой `Content-Type` обходит 415-гейт и JSON-валидацию | актуальна | yookassa:1953-1958 |

### 1.3. Партия C — чекеры, CI, скрипты (PC-01…PC-16; 16 позиций)

| ID | Суть (кратко) | Статус | Актуальный реф |
|---|---|---|---|
| PC-01 | drift-чекер сверяет манифест↔код через `String.includes()` по всему тексту (комментарии/подсказки засчитываются как реализация) | актуальна (расширена на alfa-секцию) | [`scripts/check-protocol-drift.js`](../../scripts/check-protocol-drift.js):60-62, 71-73, 77-83, 228-240 |
| PC-02 | «инварианты» АТОЛ держатся на тексте комментария и арифметической строке | актуальна | check-protocol-drift.js:200-208 |
| PC-03 | links-чекер: вне scope `CHANGELOG.md`, reference-style ссылки и пробелы после `(` не разбираются | актуальна | [`scripts/check-docs-links.js`](../../scripts/check-docs-links.js):23-24, 54-58 |
| PC-04 | `test:docker`/`test:compose` не входят в `npm test` | актуальна | [`package.json`](../../package.json):7, 10, 18 |
| PC-05 | нет `concurrency:` ни в одном workflow | актуальна | [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml):5-10 |
| PC-06 | нет top-level `permissions:` в `ci.yml` | актуальна | ci.yml:11-17 vs :104 |
| PC-07 | публикация по тегу `v*` не сверяется с `package.json` version | актуальна | ci.yml:98, 114, 123-130 |
| PC-08 | `check:upstream` всегда exit 0 (report-only) | актуальна | [`scripts/sync-upstream.js`](../../scripts/sync-upstream.js):317 |
| PC-09 | `test:upstream` не покрывает `readSnapshot`/`updateSnapshot`/лимит тела | актуальна | [`scripts/sync-upstream-selftest.js`](../../scripts/sync-upstream-selftest.js) (64 строки) |
| PC-10 | compose-selftest глотает ошибку выделения песочницы; F-33 молча пропускается при `tenancy=off`; fallback-сброс бьёт по default | актуальна | [`scripts/compose-selftest.js`](../../scripts/compose-selftest.js):158-195, 461-490, 548-590 |
| PC-11 | пары 3102/3103 в `KNOWN_SERVICES` не исполняются ни одним CI-прогоном | актуальна (дополнено: 3104/alfa) | [`scripts/docker-healthcheck.js`](../../scripts/docker-healthcheck.js):20-30 |
| PC-12 | docker-smoke проверяет только tbank и kassa (2 из 5 сервисов) | актуальна (alfa тоже вне smoke) | [`scripts/docker-smoke.js`](../../scripts/docker-smoke.js):29-30, 95-151 |
| PC-13 | `npm install` в zero-dependency job — сетевая зависимость CI | актуальна | ci.yml:23-24 |
| PC-14 | `private: true` делает `files`/`engines` декоративными; `CHANGELOG.md` не в пакете; lock-файла нет | актуальна | package.json:4, 25-27, 50-61 |
| PC-15 | docs-чеки исполняются во всех трёх узлах матрицы | актуальна | ci.yml:14-17, 37-40 |
| PC-16 | `LINK_RE` сканирует code-fence/inline-code → ложные срабатывания на цитатах | актуальна | check-docs-links.js:24, 40-50 |

### 1.4. Партия D — deployment/compose/env (PD-01…PD-11; 11 позиций)

| ID | Суть (кратко) | Статус | Актуальный реф |
|---|---|---|---|
| PD-01 | root compose не пропускает `MOCK_HOSTED`/токены/tenancy: `MOCK_HOSTED=1 docker compose up` молча игнорируется | актуальна | [`docker-compose.yml`](../../docker-compose.yml):14-26, 129-147; [`README.md`](../../README.md):150-156 |
| PD-02 | каждая мутация песочницы перезаписывает весь реестр синхронно; квота не ограничивает размер; `mem_limit: 128m` | актуальна | core:1954-2006, 2130-2136; [`docker-compose.include.yml`](../../docker-compose.include.yml):73, 122, 169, 219, 272; [`services/kassa-mock/server.js`](../../services/kassa-mock/server.js):433-460 |
| PD-03 | `MOCK_SANDBOX_SWEEP_MS` прочитана, но воркер не стартует без TTL/квоты/retention (дефолт namespaces) | актуальна (расширена: alfa — нет строки в README) | tbank:3396, kassa:942, yookassa:2090, atol:909, alfa:791 |
| PD-04 | `MOCK_HEALTH_PATH` не читает ни один сервер (только healthcheck-скрипт) | актуальна | docker-healthcheck.js:27-30 vs сервисы |
| PD-05 | include: для atol группы проходят только через недокументированную `MOCK_ATOL_GROUPS` | актуальна | include:100 vs :193 |
| PD-06 | живые env без документации: `MOCK_FN_CAPACITY`, `MOCK_OFD_MODE`, `MOCK_OPERATOR`, `MOCK_FN_NUMBER`, `MOCK_ECR_RN`, `MOCK_OFD_INN`, `MOCK_FNS_SITE` | актуальна (расширена: alfa `MOCK_SANDBOX_FILE`/`MOCK_SANDBOX_SWEEP_MS`) | kassa:58, 110, 628-632; atol:134-140; alfa:232, 790 |
| PD-07 | namespaces на сетевом стенде: авто-создание песочниц без лимита (createLimit=0), список/удаление без токена, TTL 0 | актуальна | core:2178-2195, 2218-2223; tbank:2382-2397, 2427-2441; include:37, 89, 138, 185, 236 |
| PD-08 | ошибки persist состояния/реестра глотаются (catch → log) → молчаливая потеря персистентности | актуальна | core:181-190, 2054-2070 |
| PD-09 | `MOCK_IMAGE_TAG`/`MOCK_IMAGE_DIGEST` независимы: bump тега без дайджеста декоративен | актуальна | include:31, 83, 132, 179; [`CONTRIBUTING.md`](../../CONTRIBUTING.md):77-90 |
| PD-10 | RFC-001 обещает per-sandbox файлы, RPS-квоту и «3 песочницы/IP/сутки» — реализовано иначе (единый реестр, 20/час) | актуальна | [`docs/rfc/RFC-001-multi-tenant-sandboxes.md`](../rfc/RFC-001-multi-tenant-sandboxes.md):79-81, 126, 154 vs core:1919, 2138-2148 |
| PD-11 | `MOCK_*_CADDY_DOMAIN` и `MOCK_*_PUBLIC_BASE_URL` не сверяются: «только домен» ломает покупательский флоу без WARN | актуальна | include:47, 71, 103, 120, 144, 167, 200, 217, 245, 265 |

### 1.5. Партия E — манифесты/OpenAPI/юридический слой (PE-01…PE-18; 18 позиций)

| ID | Суть (кратко) | Статус | Актуальный реф |
|---|---|---|---|
| PE-01 | у Т-Банка нет цикла сверки `errorCodes` (есть у Ferma/АТОЛ/alfa) | актуальна | check-protocol-drift.js:125, 194, 263 (tbank отсутствует) |
| PE-02 | `errorCodes` манифеста Т-Банка содержит неэмитируемый `1054` | актуальна | [`protocols/tbank-eacq.json`](../../protocols/tbank-eacq.json):104 |
| PE-03 | DX-каталог Т-Банка: 9 кодов против 13 в манифесте (нет 0, 86, 103, 1051, 1057) | актуальна | [`services/tbank-mock/server.js`](../../services/tbank-mock/server.js):597-611 |
| PE-04 | манифест Т-Банка: `partnerRoutes` = 2, сервер реализует ещё `GET /sm-register/register/shop/{shopCode}` и `PATCH\|POST /sm-register/register/{shopCode}` | актуальна | tbank server:2808, 2817 vs манифест:40-43 |
| PE-05 | статусная модель выплат мока (успех `CONFIRMED`) расходится с конспектом (`COMPLETED`) | актуальна | tbank server:3040-3052, 3145-3146 vs `docs/reference/tbank/03-payouts-and-deals.md`:76-77 |
| PE-06 | карта выплат `5000000000000447` из конспекта отсутствует в манифесте и сервере | актуальна | `docs/reference/tbank/04-test-cards.md`:37; tbank server:286-298, 308-311 |
| PE-07 | в `routes` Ferma нет `GET /receipts/{uuid}` и `/healthz` | актуальна | [`protocols/ferma-ofd.json`](../../protocols/ferma-ofd.json):18-30; kassa server:1336, 1874 |
| PE-08 | OpenAPI Т-Банка (40 путей) не документирует `/health`, `/admin`, `/admin/journal`, `/admin/action`, форму оплаты | актуальна (дополнено alfa — PE-19) | [`docs/openapi/tbank-mock.openapi.json`](../../docs/openapi/tbank-mock.openapi.json) |
| PE-09 | блоки `limits` манифестов (9+3+5 значений) чекером не проверяются | актуальна (расширена alfa) | check-protocol-drift.js (0 совпадений `limits`); манифесты:79-89, 80-84, 154-160 |
| PE-10 | справочники гайдов уже манифестов (vat-типы, коды ошибок) | актуальна | [`docs/integration/ferma-ofd.md`](../integration/ferma-ofd.md):52, 96-98; [`docs/integration/tbank-eacq.md`](../integration/tbank-eacq.md):73-75 |
| PE-11 | 14 `.md` в `docs/reference/**` и `docs/integration/**` без стандартной шапки проекта | актуальна (пересчитано: ровно 14) | `docs/integration/{ferma-ofd,lovii,tbank-eacq}.md`, `docs/reference/{README-kassa-mock,README-tbank-mock,external-links}.md`, `docs/reference/lovii/*` (2), `docs/reference/tbank/01-06` (6) |
| PE-12 | `README-tbank-mock.md`/`README-kassa-mock.md` — устаревшие внутренние доки волны-1 (в т.ч. источник истины манифеста Ferma) | актуальна | `docs/reference/README-tbank-mock.md`:7-8, 98-100; `docs/reference/README-kassa-mock.md`:74-78; ferma-ofd.json:6 |
| PE-13 | источники конспектов Т-Банка — локальные PDF, которых нет в репозитории | актуальна | `docs/reference/tbank/01-payment-api.md`:3-4 (и 02/03/04); `find docs -name '*.pdf'` — пусто |
| PE-14 | `external-links.md` — срез 2026-10-08, «Сбер/ЮKassa — после развилки», alfa/vtb/taxcom/kontur/first-ofd не упомянуты | актуальна | `docs/reference/external-links.md`:3, 26-30 |
| PE-15 | `protocols/upstream-snapshot.json`: единственный `check`-источник (АТОЛ) без отпечатка, остальные — `skip` | актуальна | [`protocols/upstream-snapshot.json`](../../protocols/upstream-snapshot.json):24-29 |
| PE-16 | публичные креды АТОЛ в манифесте без поля `pass` | актуальна | `protocols/atol-online.json`:163-169 |
| PE-17 | конспекты VTB/Сбер фиксируют непригодные (просроченные) тестовые карты | актуальна | `docs/reference/vtb/02-callbacks-and-testing.md`:21; `docs/reference/sber/02-callbacks-and-test.md`:31 |
| PE-18 | код `0` Ferma = «Касса недоступна» (503) без пометки `[FORK]` | актуальна | kassa server:1737-1740; `protocols/ferma-ofd.json`:85 |

### 1.6. Партия F — хвосты вердиктов 08.10 (PF-01…PF-05; 5 позиций)

| ID | Суть (кратко) | Статус | Актуальный реф |
|---|---|---|---|
| PF-01 | kassa: `MOCK_BLOCK_PRIVATE_WEBHOOKS = 'false'` отключает SSRF-гард даже в `MOCK_HOSTED=1`; README обещает обратное | актуальна | [`services/kassa-mock/server.js`](../../services/kassa-mock/server.js):50, 90; `services/kassa-mock/README.md`:122 |
| PF-02 | tbank: 26 строк с префиксом `[mock]` вместо `[tbank-mock]` (grep по `[tbank-mock]` в логах пуст); расширение: тот же префикс в yookassa (17 строк) | актуальна (расширена) | tbank server:32, 212, 515-555 и др.; yookassa server:35, 168, 590-937 |
| PF-03 | tbank: `MOCK_AUTO_CONFIRM_MS` — запрещённый `parseInt(x,10) \|\| N` | актуальна | tbank server:76 |
| PF-04 | kassa: опечатка «ЧЕК НАПЕЧАТАТАН» в логе | актуальна | kassa server:907 |
| PF-05 | семантика `GetState.Amount` = остаток после частичного возврата нигде не задокументирована | актуальна | tbank server:527, 560, 643 vs `services/tbank-mock/README.md` (0 совпадений «остаток/текущая сумма») |

---

## 2. Новые находки

Реестр в формате §2 REGISTRY. Все — в серии партийных ID; PB-серия продолжена с первого свободного номера
(коллизия с PB-07…PB-10, зафиксирована во вводной части).

| ID | модуль | файл:строка | категория | severity | суть | предлагаемая задача | зависимости |
|---|---|---|---|---|---|---|---|
| PB-11 | alfa-mock / env-парсинг | `services/alfa-mock/server.js:143-152`; README env-таблица | correctness | minor | Три env-переменные парсятся через `parseInt(x,10)` (два экземпляра — паттерн `\|\| N`, запрещённый AGENTS.md §8): `MOCK_CALLBACK_RETRY_MS`, `MOCK_CALLBACK_MAX_ATTEMPTS`, `MOCK_SESSION_TIMEOUT_SECS`. Суффиксы молча трактуются неверно: проба `MOCK_SESSION_TIMEOUT_SECS=1h` дала `sessionTimeoutSecs=1` (заказ истекает через секунду — `declaredByTimeout`), `MOCK_CALLBACK_RETRY_MS=0` (выключить ретраи) даёт 10000. Класс PB-03/PF-03, новый адаптер. | Перевести три переменные на общий `parseMsOr`/секундный парсер с явной семантикой «0 валиден, суффиксы поддержаны», добавить строку-тест в selftest (`MOCK_SESSION_TIMEOUT_SECS=1h` → 3600). DoD: `1h` не даёт 1 с; `0` у ретраев имеет определённую семантику. | PB-03, PF-03, MS-08 |
| PB-12 | alfa-mock / квоты песочницы | `services/alfa-mock/server.js:201-204`, `:835-838`; `packages/core/index.js:2201-2215` | correctness | minor | Счётчик документов песочницы суммирует `orders` + `orderNumbers` + `callbacks`: каждая регистрация расходует два юнита (заказ + индекс), а откат по квоте не освобождает индекс. Проба `MOCK_SANDBOX_MAX_DOCUMENTS=2`: коды ответов `[0, 5, 5]` — принят **один** заказ, второй уже «Лимит документов песочницы исчерпан (2/2)». Класс PB-04 (tokens у АТОЛ), другой механизм. | Исключить индекс `orderNumbers` из `documentCounter` (считать заказы+callback'и, как у tbank) либо документировать «документ = заказ + индекс» и поднимать дефолт. Регресс: при лимите N регистрируется N заказов. DoD: `MOCK_SANDBOX_MAX_DOCUMENTS=2` → 2 успешных `register.do`. | PB-04, MS-13 |
| PB-13 | alfa-mock / изоляция журнала (расширяет PA-50/PA-51) | `services/alfa-mock/server.js:75`, `:1686-1701`, `:1747`, `:1757-1768`; тот же паттерн: tbank:35, kassa:33, yookassa:38, atol:57 | security | minor | Журнал создаётся один на процесс и не привязан к песочнице: `journal.record()` пишет все `/payment/rest/*` любых арендаторов, `GET /admin/journal` отдаёт общий список, а `POST /mock/reset` вызывает `journal.clear()` — сброс чужого журнала. Проба (owned): владелец A видит в своём журнале запись с `MARKER-B-1` чужой песочницы B (`aSeesForeignMarker=true`), после `POST /mock/reset` от A журнал B пуст (0 записей). Секретов/PAN в записях нет (редакция работает), утечка — поведенческая + разрушительная. | Скоупить журнал по песочнице: `createJournal` в адаптере хранить с ключом sandbox-id (или фильтровать при чтении по `admission.record.id`), `journal.clear()` — только для своей песочницы. DoD: A не видит и не чистит записи B; регресс в selftest. | PA-50 (по духу), PA-51, MS-12 |
| PB-14 | alfa-mock / selftest-покрытие | `services/alfa-mock/selftest.js` (нет блоков); env-сброс `:238-250` | dx | minor | Ядро-слои alfa покрыты (287 проверок), но **нет ни одной регрессии** на: 413 (лимит тела), негатив CSRF `/admin/action`, `POST /mock/state` с `__proto__`/`constructor`, TTL-песочницу → 410, `MOCK_SANDBOX_CREATE_LIMIT` → 429, исчерпание квоты (`MAX_DOCUMENTS`), `X-Mock-Scenario` на не-REST маршрутах. Все ветки живые (проверены пробами, §5.3), но ломающий рефакторинг ядра пройдёт незамеченным. Расширение PB-05 на пятый адаптер. | Добавить 6 проверок по образцу atol/yookassa-блоков (CSRF-негатив, 413, import-негатив, TTL/410, 429, квота). DoD: каждая перечисленная ветка имеет ≥1 check; число проверок alfa растёт с 287. | PB-05, MS-17 |
| PC-17 | drift-чекер | `scripts/check-protocol-drift.js:273` | correctness | info | Диагностика alfa-инварианта `callback-operation` печатает `openapi=${inServer}` (копипаст): при расхождении OpenAPI сообщение подсовывает значение серверной проверки и маскирует причину. Плюс alfa-секция не проверяет `limits`, `idempotency`, `registerFields`/`registerOptionalFields`, `callback.ack/retries` (расширение PE-09/PE-01 на alfa). | Исправить подстановку (`openapi=${inOpenApi}`), добавить негативный контроль чекера (синтетический «пустой» сервер должен красить); включить блоки `limits`/`idempotency` в сверку. | PC-01, PC-02, PE-09 |
| PD-12 | include ↔ README alfa | `docker-compose.include.yml:228-280` vs `services/alfa-mock/README.md` (env-таблица) | docs | info | `MOCK_ALFA_TERMINAL_ID` документирован в README сервиса, но не проходит через include (в блоке alfa-mock его нет): потребитель, задавший переменную в окружении хоста, молча получит `ALFA-MOCK-1`. Расширение PD-06 на пятый сервис (у atol аналогичные `MOCK_AGENT_LINE`/`MOCK_AGENT_INN` уже зафиксированы). | Либо строка в include (`MOCK_ALFA_TERMINAL_ID: "${MOCK_ALFA_TERMINAL_ID:-}"`), либо пометка в README «для include задаётся своим compose». DoD: переменная либо доходит, либо явно исключена документом. | PD-06, «правило пяти мест» (AGENTS §5) |
| PE-19 | alfa-mock / манифест и доки | `protocols/alfa-eacq.json:74-79`; `docs/openapi/alfa-mock.openapi.json` (23 пути); `services/alfa-mock/README.md` (таблица API) | docs | info | `POST /admin/action` (реальная ручка админ-консоли с CSRF и same-origin, alfa server:1847-1868) не задекларирована ни в `mockRoutes` манифеста, ни в OpenAPI, ни в таблице API README — чекер дрейфа её не видит по построению (сверяет только перечисленное). Аналогичный пробел зафиксирован для Т-Банка (PE-08), для alfa не заводился. | Дописать `/admin/action` (POST) в `mockRoutes` манифеста, OpenAPI и таблицу README; заодно перечислить форк «`/mock/verify-merchant` не реализован» в манифесте как `outOfScope`. DoD: маршрут виден чекеру и документу. | PE-08, PC-01 |
| PF-06 | реестр вердиктов 08.10 | `docs/audit/AUDIT-2026-10-08.md` §4 (таблицы F-01…F-38, A-1…A-24) | docs | info | Пятый адаптер (`alfa-mock`, #47) не покрыт таблицами вердиктов аудита 08.10 и партии F: строки alfa нет ни для F-09 (редакция), F-10 (PAN), F-15 (retention), F-33 (изоляция), F-35/F-36 (образ/healthcheck). В этом отчёте верификация для alfa выполнена (§3.6), но реестр-источник остаётся без строки — при следующем «прогоне вердиктов» alfa снова выпадет. | Добавить в реестр/бриф строку alfa со статусами F-09/F-10/F-15/F-33/F-35/F-36 по §3.6 настоящего отчёта (без правок кода). DoD: у каждого из перечисленных F-пункта есть вердикт для alfa. | PF-01…PF-05, §3.6 |

**Расширения существующих находок (без новых ID):**

* **MS-16** (security-headers-partial, [AUDIT-PREP](AUDIT-PREP-2026-10-12.md) §2.3): подтверждено для alfa — заголовки
  `X-Frame-Options: DENY` / `Referrer-Policy` / CSP стоят только на `/admin` (alfa server:1835-1843), а страницы
  оплаты (`/payment/{id}`, `/pay`, `/3ds`) и 404-страница заказа отдаются через `core.html()` без заголовков
  (alfa:1878-1898; `X-Content-Type-Options` — 0 совпадений по репо). Проба: `GET /payment/{orderId}` → 200
  `text/html`, `x-frame-options=null`, CSP `null`.
* **PD-03/PD-06**: alfa не документирует `MOCK_SANDBOX_FILE` и `MOCK_SANDBOX_SWEEP_MS` (читаются: alfa:232, 790) —
  тот же класс, что у kassa/tbank.
* **PF-02**: тот же `[mock]`-префикс и в yookassa (17 строк: `services/yookassa-mock/server.js`:168, 590-937 и др.)
  — расширение находки на второй сервис.
* **PB-03**: alfa добавляет третий файл с паттерном `parseInt(...) || N` (см. PB-11).
* **PA-50**: alfa подтверждён повторно (§3.5) — новых ID не заводилось (правило дедупликации).

---

## 3. Полный аудит `alfa-mock` по рамкам партии B

### 3.1. Область, глубина чтения

| Файл | Диапазон | Глубина |
|---|---|---|
| [`services/alfa-mock/server.js`](../../services/alfa-mock/server.js) | 1-2057 | прочитан полностью, построчно |
| [`services/alfa-mock/README.md`](../../services/alfa-mock/README.md) | 1-278 | полностью (включая «Границы и документированные форки», 12 пунктов) |
| [`services/alfa-mock/selftest.js`](../../services/alfa-mock/selftest.js) | 1-1055 | каркас + все блоки проверок (каталог из ~200 check-сайтов, 287 исполняемых проверок), точечно — тела проверок |
| [`protocols/alfa-eacq.json`](../../protocols/alfa-eacq.json), [`docs/openapi/alfa-mock.openapi.json`](../../docs/openapi/alfa-mock.openapi.json) | целиком | полностью |
| [`docs/integration/alfa.md`](../integration/alfa.md) | — | проверен `check:drift`-циклом (ссылки/инварианты), построчно не перечитывался (зона партии E) |
| [`packages/core/index.js`](../../packages/core/index.js) | `readBody`/`parseBody`/`send*`/`escapeHtml` 213-298, редакция 325-575, `createJournal` 671-735, `admit/export/import/reset` 2178-2220, 2422-2479, quota 2196-2215 | выборочно (ядро — зона партии A) |

**За рамками:** ядро целиком (партия A), скрипты/CI (C), compose/env-матрица и SECURITY.md (D), юридическая
оценка конспектов (E), сверка конспектов Альфы с первоисточниками (нет доступа из песочницы), реализация правок.

### 3.2. Маршруты и декларации (вопрос «полнота поверхности»)

Сервер реализует **24 маршрута**: 7 REST `*.do`; 3 страницы формы (`GET /payment/{id}`, `POST /pay`, `POST /3ds`);
`/health`, `/openapi.json`; `/admin`, `/admin/journal`, `POST /admin/action`; 5 control (`/mock/time`,
`/mock/scenarios`, `/mock/reset`, `/mock/state`, `/mock/sandboxes`); 4 sandbox (`/sandboxes`, `/sandboxes/me`,
`/sandboxes/me/reset`, `/sandboxes/me/reset-creds`). Манифест перечисляет 23 из 24 (нет `/admin/action` — PE-19);
OpenAPI — те же 23 пути; README перечисляет маршруты строками-группами и тоже не упоминает `POST /admin/action`.

Сверка манифест↔код↔OpenAPI↔гайд выполняется `check:drift` в объёме: `upstreamDocs`, `restMethods`, `routes`,
`formRoutes`, `mockRoutes`, `mockControlRoutes`, `orderStatuses`, `errorCodes`, `callback.operations`, `testCards`,
`actionCodes`, 13+ инвариантов; **не** проверяются `limits`, `idempotency`, `registerFields`,
`registerOptionalFields`, `callback.ack/retries/unsignedNote`, `testCredentials`, `productionNote` (PC-17/PE-09).

### 3.3. Идемпотентность и гонки (ramki PB, вопрос №3)

* `orderNumber` нормализуется **симметрично**: `trim()` в регистрации (`server.js:842`) и в поиске (`:609`),
  запись индекса — тем же значением (`:1010`). Аналога PB-01 у alfa **нет** (проверено чтением; регресс-теста
  на пробелы, впрочем, тоже нет — расширение PB-14).
* Между проверкой и записью нет `await`: критическая секция `register` синхронна. Проба: 40 параллельных
  `register.do` с одним `orderNumber` → **1** `errorCode 0` + 39 `errorCode 1` (второй чек/заказ не создаются).
* Callback-очередь живёт на ядре и наследует PA-52/PA-59 (starvation, wall-clock) — новых дефектов уровня
  адаптера не найдено; `webhook-duplicate`/`webhook-drop` работают штатно (selftest).

### 3.4. Callback, ACK, checksum

* Доставка — HTTP **GET** с query (`mdOrder, orderNumber, operation, status, amount, callbackCreationDate,
  checksum`); ACK — ровно 200 (204 засчитывается как неуспех и дожимается ретраями) — подтверждено чтением и
  selftest-блоком.
* Checksum — симметричный HMAC-SHA256, канонизация `name;value;…;` без `checksum`/`sign_alias`, hex в верхнем
  регистре; selftest проверяет **независимой реализацией** (не переиспользует серверную функцию). Асимметричный
  режим не реализован и честно задокументирован (форк №1 README/манифест) — трактуется как осознанная граница,
  не находка.
* `MOCK_CALLBACK_CHECKSUM=false` (неподписанные уведомления) покрыт selftest'ом и README; поведение
  («сверять через REST») совпадает с предупреждением конспекта.

### 3.5. Контроль доступа и песочницы (вопрос «нет ли лишней поверхности»)

| Проверка | Результат | Доказательство |
|---|---|---|
| `/admin`, `/admin/journal`, `/mock/*` без токенов (hosted) | **401 fail-closed** | проба №2: `GET /mock/time` 401, `/admin` 401, `/health` 200, `/sandboxes` без токена 401 |
| CSRF `/admin/action` | **работает**: без токена и с неверным — 403 | проба №2 (было 403 в обоих случаях), `server.js:1847-1868` |
| `POST /sandboxes` (owned) | 201 `{id, url, ownerToken, creds}`; лимит создания 2/час на адрес → третий запрос 429 | проба №2 `s1=201, s2=201, s3=429` |
| `/sandboxes` (own) | без owner-token 401; со своим токеном видна **только своя** песочница | проба №1 |
| Чужие данные: `?sandbox=` в `/mock/state`, `/mock/reset` | **PA-50 подтверждён**: владелец A читает (`readForeignOrder=true`), перезаписывает (`ok:true`), сбрасывает (`resetCleared=true`) песочницу B | проба №1; совпадает с §7.4 партии A |
| TTL песочницы | по истечении — 410 `errorCode 3` «истекла по TTL и удалена», запись исчезает | проба №2 (TTL 400 мс) |
| Квота документов | **PB-12**: лимит 2 = 1 заказ (двойной счёт) | проба №3 `[0,5,5]` |
| Журнал между песочницами | **PB-13**: общий список; A видит и чистит записи B | проба №4 |
| `POST /mock/state` с `__proto__`/`constructor` | 400 «запрещён опасный ключ», загрязнения нет | проба №3 (сырой JSON-текст) |
| Редакция журнала | `password` → `[REDACTED]`; `Authorization`/`Cookie`/`X-Sandbox-Token` в запись не попадают; query-ключи, оканчивающиеся на `token`, заменяются на `YOUR_TOKEN`; PAN в state/журнале нет (маска `first6**last4`) | проба №2 (записи без утечек) + чтение `filterJournalHeaders`/`redactQuerySecrets` (core:523-543, 577-595) |
| Редакция «сложных» ключей | **PA-02 подтверждён на alfa**: `pass%77ord`, `password_confirmation`, `a=1&&password`, `tok%5Fen` сохраняются в `rawBody` (и в curl) | проба №2 (`journalLeaks`), §5.3 |
| HTML-экранирование | XSS не найден: `formPage`/`adminPage`/журнал экранируют пользовательские значения; статические пресеты карт — константы | чтение `formPage` (alfa:1180-1220), `adminPage` (1532-1595) |
| Заголовки страниц | **MS-16-расширение**: у страниц оплаты нет XFO/CSP/Referrer-Policy/nosniff (у `/admin` — есть) | проба №1 (`formPageHeaders`) |

Дополнительно: `POST /sandboxes` в owned-режиме не требует `MOCK_SANDBOX_TOKEN` (по дизайну RFC-001), но
дефолтная песочница без `MOCK_SANDBOX_TOKEN` остаётся открытой — предупреждение печатается в стартовом логе
(`server.js:2047`), в SECURITY-матрице явной строки нет (класс PD-07).

### 3.6. Вердикты «наследственных» пунктов 08.10 для alfa (вклад в PF-06)

| Пункт 08.10 | Вердикт для alfa | Реф |
|---|---|---|
| F-09 (редакция журнала) | выполнен частично: ключи-секреты маскируются, но percent-encoded/дублирующиеся ключи утекают (PA-02) | alfa:1686-1701; core:467-498 |
| F-10 (PAN не хранится) | выполнен: в state — `maskPan`/`first6**last4`, форма не журналируется | alfa:640-706; selftest-блок «в состоянии нет полных PAN» |
| F-15 (retention/квоты) | реализовано (`MOCK_SANDBOX_MAX_DOCUMENTS`, `MOCK_SANDBOX_RETENTION_MS`), но квота двойного счёта (PB-12) и переменные не проброшены в include/README | alfa:168-169, 201-204, 791 |
| F-33 (изоляция прогонов) | в compose-селфтесте alfa-секция участвует в проверке неизменности default-счётчиков | compose-selftest.js:589-590 |
| F-35/F-36 (образ/healthcheck) | healthcheck в include и root compose для 3104 присутствует, UID/образ — общие с остальными | include:277-280; docker-compose.yml:147-152 |
| Единый образ/персистентность | `/data/alfa-state.json`, тот же паттерн, что у остальных | include:270 |

### 3.7. Итог по alfa

Сервис построен на тех же защитных слоях ядра, что и остальные четыре, и не повторяет известных дефектов
(симметричная нормализация `orderNumber` — анти-пример PB-01; CSRF и fail-closed покрыты selftest'ом, в отличие
от ЮKassa и АТОЛ). Найдено четыре новых дефекта уровня адаптера (PB-11…PB-14) и два пробела деклараций
(PE-19, PD-12); критичных (blocker/major) — нет. PA-50 и PA-57 проявляются в alfa так же, как в остальных
адаптерах, и остаются задачами P0-волны.

---

## 4. Delta по закрытым задачам #46/#47

* **#46 (SSRF mapped-bypass, commit `d957b2f`)**: закрыт — decimal IPv4 (`2130706433`), `::ffff:127.0.0.1`,
  NAT64-префиксы `64:ff9b::/96` и `64:ff9b:1::/48` блокируются (прогон §7.4 партии A на текущем коде).
  **Остаток** (не закрыт #46, заведён хвостом): `ff00::/8`, TEST-NET (`192.0.2.0/24`, `198.51.100.0/24`,
  `203.0.113.0/24`), `2001:db8::/32` проходят guard (PA-26); TOCTOU-резолв (MS-09) и fail-open дефолт
  `createDeliveryQueue.blockPrivateHosts=false` (PA-58) сохраняются.
* **#47 (alfa-mock, `9d2ee4b`)**: аддитивное расширение ядра (`postJson` умеет исходящий GET для callback'ов) не
  изменило поведение четырёх прежних адаптеров — их selftest'ы зелёные. Новый код дал 4 находки (PB-11…PB-14) и
  2 пробела деклараций (PE-19, PD-12); контрактные слои (манифест/OpenAPI/гайд) согласованы с кодом на 23 из 24
  маршрутов.

---

## 5. Прогоны и доказательства

### 5.1. `npm test`

До работы (база `f89f76f`) и после (после добавления этого отчёта): **exit 0**.

```
core: 48 passed, 0 failed
tbank: SELFTEST PASSED
kassa: 141 passed, 0 failed
yookassa: 227 passed, 0 failed (26 вебхуков доставлено)
atol: 202 passed, 0 failed (8 callback'ов)
alfa: 287 passed, 0 failed (29 callback-доставок)
upstream: 11 passed, 0 failed
check:links: 70 файлов (69 до добавления отчёта), битых ссылок нет
check:drift: проверено 316, пройдено 316, расхождений 0
```

### 5.2. Пробы alfa: дефолтный режим (`/tmp/alfa-probe-default.js`, вне репозитория)

```
adminNoToken: /admin 200, XFO/CSP/Referrer присутствуют только у /admin
formPageHeaders: GET /payment/{orderId} → 200 text/html; xfo=null, csp=null, referrer=null, nosniff=null
journal: password=[REDACTED], но pass%77ord=/password_confirmation=/a=1&&password=/tok%5Fen= сохранены в rawBody
scenarios: http-500 → HTTP 500 {errorCode 6}; http-504 → HTTP 504 {errorCode 6}
tooBig: тело > 5 MiB → HTTP 413 {errorCode 6}
race: 40×register с одним orderNumber → {ok:1, dup:39, other:[]}
jsonNoContentType: JSON без Content-Type → разобран как form → errorCode 2
```

### 5.3. Пробы alfa: owned-режим и границы (скрипты под `$HOME/.arena/`, вне репозитория)

```
[alfa-probe-owned] PA-50 (владелец A → песочница B):
  readStatus=200 readForeignOrder=true writeStatus=200 writeResult={ok:true,sandbox:tenant-b}
  afterWriteCanary=true resetStatus=200 resetCleared=true
  registry: fileMode=644 credsPlaintext=true callbackSecretPlaintext=true ownerTokenHashInFile=true
  hosted без токенов: /mock/time 401, /admin 401, /health 200, /sandboxes 401; A видит только tenant-a

[alfa-probe-pa] core-хвосты на alfa:
  pa01_parseBody="URIError: URI malformed"; pa01_http=500 {errorCode 6}
  pa03_amex=true pa03_bearer=true pa03_visa=false
  pa04_deep=true pa04_arr150: обрезка без маркера (100 из 150)
  pa05_shortBody={hung:true} — ответа нет за 500 мс при заявленных 5000 байтах
  pa08_lastWins="2"; pa08_bom={"﻿a":"1"}; pa08_literalBracket={"k[]":"1"}
  pa07_backtick="`"; pa07_js="javascript:alert(1)"

[alfa-probe-pa2] журнал: capJournalBody режет массивы (>100 → ~3 элемента + маркер) и глубину >12;
  но core.redactSecrets(arr150) → 600 символов (тихая обрезка до 100 без маркера);
  curl: 'http://localhost:3100/page#token=FRAGMENT-SECRET-9' — fragment не редактируется (PA-09)

[alfa-probe-p2] CSRF: нет/неверный токен → 403; create-limit=2 → s1=201 s2=201 s3=429 (errorCode 5);
  journal: count=1, QUERY-SECRET-77/AUTH-SECRET-88/пароль песочницы отсутствуют;
  tooBig 413; stateProto={status:200,polluted:clean}(литерал __proto__ не стал own-ключом);
  TTL 400 мс → 410 {errorCode 3}; после истечения список по старому токену → 401

[alfa-probe-p3] MAX_DOCUMENTS=2 → коды register [0,5,5]; чтения квоту не расходуют (0);
  raw-JSON import: __proto__ → 400 «запрещён опасный ключ», constructor → 400, загрязнения нет;
  /health: {ok:true, sandbox:default, tenancy:namespaces, api:rest, base:/payment/rest,
  twoStage:true, partialRefund:true, sslPermitted:false, checksum:HMAC-SHA256, sessionTimeoutSecs:1200}

[alfa-probe-p4] журнал общий: aSeesOwnMarker=true, aSeesForeignMarker=true (журнал B виден из A);
  POST /mock/reset от A → записей в журнале B: 0;
  MOCK_SESSION_TIMEOUT_SECS=1h → /health sessionTimeoutSecs=1
```

### 5.4. Чекеры

```
node scripts/check-docs-links.js   → docs links OK: 69 файлов, битых ссылок нет
node scripts/check-protocol-drift.js → 316/316, расхождений 0
```

---

## 6. Ограничения и открытые вопросы

1. **Docker недоступен в песочнице** — PD-09 (тег vs дайджест), docker-smoke/docker-smoke-расширения и compose-прогон
   не исполнялись; выводы по compose/Dockerfile — по чтению файлов и CI-конфига (как и в партии D).
2. **GHCR/история git**: репозиторий — shallow-снимок в 1 коммит; проверки «когда появился дефект» и «что реально
   опубликовано в GHCR» непроверяемы; в отчёте такие утверждения не делались.
3. **Первоисточники провайдеров** недоступны из песочницы: сверка конспектов Альфы (и Т-Банка) с публичными
   доками/PDF не выполнялась; трактовки мока берутся из README/манифеста и помечены как форки.
4. **ЮKassa-flake** (PA-follow-up): 16 PASS / 4 FAIL в 20 последовательных прогонах `test:yookassa` (всегда
   `services/yookassa-mock/selftest.js:412`) — остаётся follow-up владельцу; в этом проходе полный `npm test`
   прошёл зелёным, отдельные 20 прогонов не повторялись (по требованию §7.5 партии A они уже сделаны).
5. **Коллизия ID «PB-07…»**: запрошенная серия занята; новые PB-ID начинаются с PB-11 — вопрос к владельцу о
   нумерации не блокирует работу.
6. **`docs/audit/AUDIT-CONSOLIDATED-2026-10-12.md`** сохранён как исторический; настоящий отчёт — его delta.

---

## 7. Предлагаемая очередь работ (без правок кода)

Порядок P0-волны не меняется (согласован ранее): **#50 (PA-50) → #51 (PF-01) → #52 (MS-09) → #53 (PA-51)**.
Новые находки этого прохода — после P0, по убыванию:

1. **PB-13** (журнал не изолирован по песочнице; воспроизводится во всех пяти сервисах) — кандидат в один
   fix-пакет с PA-50/PA-51: те же границы «чужой арендатор не читает и не чистит».
2. **PB-12** (двойной счёт квоты документов) — однострочная правка `documentCounter` + регресс.
3. **PB-11** (env-парсинг alfa: `1h` → 1 с) — правка 3 мест + регресс; сюда же остаток MS-08 по kassa (`PD-06`).
4. **PB-14** (selftest-покрытие alfa), **PC-17** (диагностика чекера), **PD-12**/**PE-19** (декларации alfa) —
   мелкие docs/test-правки одним пакетом.
5. **PF-06** (строка alfa в реестре вердиктов) — доковая правка реестра/брифа.

Критерии готовности и DoD — в колонках «предлагаемая задача» §2.
