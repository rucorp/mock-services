© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Подготовка к глубокому аудиту — 2026-10-12

> **Issue:** [#43 — прогон агент-брифа и пакет подготовки к глубокому аудиту](https://github.com/rucorp/mock-services/issues/43)
> **База:** `main` @ `59470a7` · версия `0.5.0` · охват прогона: 96 файлов (43 — код, манифесты, OpenAPI, контейнеры, CI; 53 — `docs/**`)
> **Режим:** только чтение. Поведение сервисов не менялось; правки MS-01…MS-40 не реализованы (будущие волны).
> **Прогоны:** `npm test` ✅ — core 41/41, tbank `SELFTEST PASSED`, kassa 141/141, yookassa 227/227, atol 202/202, `test:upstream` 11/11, `check:links` 57 файлов, `check:drift` 221/221; каждый шаг пакета заканчивался полным зелёным прогоном (последний — `c4a7e5d`). Одно разовое падение `test:yookassa` при нагрузке зафиксировано и не воспроизведено: §6, п.6.
> **Документы связки:** [бриф MS-01…MS-40 со статусами](../briefs/CLAUDE-2026-10-12-agent-brief.md) · [реестр code sweep #15](REGISTRY-2026-10-11-code-sweep.md) · [аудит 2026-10-08](AUDIT-2026-10-08.md) · [чек-лист партии](CHECKLIST-audit-party.md)

---

## 1. Резюме

Прогон брифа по фактическому коду (`main` @ `59470a7`) закрыт для всех 40 задач; статусы с
`файл:строка` — в §0.1 брифа. Здесь — сводка и то, что меняет план аудита.

| Статус | Кол-во | ID |
|---|---:|---|
| выполнено → закрывать | 4 | MS-03, MS-17, MS-26 (опровергнут), MS-34 |
| частично (есть остаток) | 11 | MS-01, MS-08, MS-13, MS-16, MS-20, MS-27, MS-30, MS-33, MS-35, MS-36, MS-38 |
| в силе (актуально как поставлено) | 20 | MS-02, MS-04, MS-06, MS-09, MS-10, MS-11, MS-12, MS-14, MS-15, MS-18, MS-19, MS-22, MS-23, MS-24, MS-25, MS-28, MS-29, MS-31, MS-37, MS-39 |
| [DECISION] владельца | 5 | MS-05, MS-07, MS-21, MS-32, MS-40 |

Из 10 `[VERIFY]`-пометок в задачах: **4 опровергнуты** (MS-08 — числа, MS-16 — атрибуты,
MS-17 — `parseBody`, MS-26 — общий реестр), **5 подтверждены** (MS-04, MS-13, MS-14, MS-20,
MS-28), **1 подтверждена с отягощением** (MS-09: найден рабочий обход, §2.1). Из 5
`[DECISION]` три требуют только ответа владельца (MS-05, MS-07-п.5, MS-40), два — вариантов
и оценки (MS-21, MS-32). 6 из 8 «непросмотренных» аудитом зон (§8 брифа) проверены; GHCR и
история git — непроверяемы из песочницы (§6).

**Важное для владельца:** три пункта брифа оказались неточны по факту кода, и один — недооценён по критичности.

1. **MS-26 `[VERIFY]` — опровергнут.** Коллизии общего volume нет: реестр песочниц лежит в `<MOCK_STATE_FILE>.sandboxes.json` ([`packages/core/index.js:1919`](../../packages/core/index.js)), а `MOCK_STATE_FILE` у четырёх сервисов разный ([`docker-compose.yml:22,47,73,101`](../../docker-compose.yml), [`docker-compose.include.yml:65,113,160,207`](../../docker-compose.include.yml)). Задачу закрывать тестом/заметкой, а не правкой.
2. **MS-08 `[VERIFY]` — опровергнут в части «числа ломаются на пустой строке».** Аналог `numEnv` в ядре уже есть: `parseDuration`/`parseMsOr` ([`packages/core/index.js:1134-1170`](../../packages/core/index.js)) дают fallback на `''`/мусор и допускают `0`; используются всеми четырьмя сервисами ([`services/tbank-mock/server.js:98-103`](../../services/tbank-mock/server.js) и аналоги). Остаток — единый `min/max`-кламп и таблица-тест.
3. **MS-20 — часть требований невыполнима:** `maxHeadersCount` в Node.js не существует (проверено на Node 22.22.3: `http.createServer()` имеет `headersTimeout=60000`, `requestTimeout=300000`, `keepAliveTimeout=5000`, `maxHeaderSize=16384`, поля `maxHeadersCount` нет). Формулировку надо переписать на явную установку трёх таймаутов + `--max-http-header-size`.
4. **MS-09 — критичнее, чем в брифе: SSRF-гард обходится уже сегодня** (см. §2.1). Это единственная находка прогона, которую стоит вынести из «P1 перед hosted» в «P0 перед любым сетевым доступом».

### 1.1 Подтверждённая ревизия координатора

| Утверждение координатора | Вердикт | Доказательство |
|---|---|---|
| MS-03 выполнено в #37 (`USER mock:mock`, UID 10001, `/data`, digest-пин, bump в CONTRIBUTING) | **подтверждено** | [`Dockerfile:20,36-40,48,53`](../../Dockerfile), [`CONTRIBUTING.md:74-88`](../../CONTRIBUTING.md), регрессия [`scripts/docker-smoke.js:115-116`](../../scripts/docker-smoke.js) |
| MS-04 `[VERIFY]` снят: обработчиков сигналов в сервисах нет | **подтверждено** | `grep process.on` по `*.js` даёт только `child.proc.kill('SIGTERM')` в тестах ([`services/atol-mock/selftest.js:692,706`](../../services/atol-mock/selftest.js), [`services/yookassa-mock/selftest.js:731,744`](../../services/yookassa-mock/selftest.js)) — в `services/*/server.js` обработчиков нет ни одного |
| MS-13 частично: лимит на IP, `MOCK_SANDBOX_MAX`, TTL/sweep есть; нет RPS и `X-Forwarded-For` | **подтверждено + уточнение** | [`packages/core/index.js:2138-2148`](../../packages/core/index.js) — окно `60 * 60 * 1000`, т.е. **час**, а не «сутки», как в брифе и RFC §10.1 ([`docs/rfc/RFC-001-multi-tenant-sandboxes.md:154`](../rfc/RFC-001-multi-tenant-sandboxes.md)); RPS-квоты и `MOCK_TRUST_PROXY` в репо нет (0 совпадений) |
| MS-17 в основном выполнено (#23), остаток `parseBody` | **подтверждено + уточнение** | фильтр опасный ключей: [`packages/core/index.js:61,153-172,447`](../../packages/core/index.js); `parseBody` ([`:258-271`](../../packages/core/index.js)) **не** мутирует `Object.prototype` — проверено прогоном: form-ключ `__proto__[x]=1` становится литеральным ключом, JSON-ключ остаётся own-свойством и отсекается `safeStateSnapshot`. Остаток — только тест, фиксирующий это |
| MS-27 частично: CI `down -v`, compose-селфтест в одноразовой песочнице | **подтверждено** | [`.github/workflows/ci.yml:93`](../../.github/workflows/ci.yml), [`scripts/compose-selftest.js:16-19`](../../scripts/compose-selftest.js); упоминаний `down -v` в `*.md` — 0, т.е. документальной формализации нет |
| MS-31 подтверждено: RFC §2 `MOCK_TENANCY=off` ≠ дефолт `namespaces` | **подтверждено + расширено** | [`docs/rfc/RFC-001-multi-tenant-sandboxes.md:38`](../rfc/RFC-001-multi-tenant-sandboxes.md) vs [`packages/core/index.js:1851-1856`](../../packages/core/index.js); дополнительно расходятся §6 (лендинг `/`), §7 (`/metrics`), §8 (метрики Prometheus) — ни того, ни другого в коде нет |
| MS-36: открытых issue — 4 (#41/#13/#6/#2), PR — 0 | **устарело** | на 2026-10-12 открыто **5** issue: #43, #41, #13, #6, #2 (`gh issue list`); PR — 0. Счётчик сдвинул сам #43 |
| MS-05 — «все права защищены» есть 32 файла, это стандарт владельца | **подтверждено** | 32 файла с `все права защищены` и 32 файла с `оригинал: rucorp/mock-services`; при этом SPDX закрыт: **17/17** `.js` имеют `// SPDX-License-Identifier: Apache-2.0` (например [`packages/core/index.js:1-2`](../../packages/core/index.js)) |
| MS-01: «последний прогон `38258456468`» | **устарело** | последний прогон `main` — `38259475582` (коммит `59470a7`, успех); `38258456468` — прогон волны #37 |
| MS-40 «вероятно, Node 20 вышел из LTS (проверить на nodejs.org)» | **подтверждено + есть свидетельство в логе CI** | EOL-справка: Node 18 — 2025-04-30, Node 20 — 2026-04-30; лог `run 38265251073`, job `test (20)`: `Node.js 20 is deprecated… forced to run on Node.js 24` для `actions/checkout`/`actions/setup-node` и `ubuntu-latest` → Ubuntu 26 с 2026-10-19 (через 7 дней после этого прогона) |
| MS-01: отсутствие тег-релиза | **подтверждено** | `git tag` — пусто, `gh release list` — пусто, [`package.json:3`](../../package.json) = `0.5.0`, [`.github/workflows/ci.yml:114,123-130`](../../.github/workflows/ci.yml) пушит `:0.5.0` на каждый push `main` → **тег `0.5.0` мутабельный**: следующий publish перезапишет его новым digest, и пин `MOCK_IMAGE_DIGEST` ([`docker-compose.include.yml:30`](../../docker-compose.include.yml)) разойдётся с тегом |

---

## 2. Находки прогона, которых не было в брифе

Формат: severity · зона · суть · доказательство. Это **не** исправления — это входные данные для партий §4 и для решения владельца.

### 2.1 `SSRF-mapped-bypass` — `high` (кандидат в P0)

`isPrivateAddress` снимает префикс `::ffff:` и пытается разобрать остаток как IPv4 ([`packages/core/index.js:851-853`](../../packages/core/index.js)). Но WHATWG-парсер `new URL()` **нормализует** IPv4-mapped-адрес в шестнадцатеричную форму, и после снятия префикса остаётся `7f00:1`, что проходит как «публичный IPv6»:

```
new URL('http://[::ffff:127.0.0.1]:43015/').hostname      → '[::ffff:7f00:1]'
core.isPrivateAddress('::ffff:7f00:1')                     → false   (ожидалось true)
core.isPrivateAddress('::ffff:a9fe:a9fe')   // 169.254.169.254 → false (ожидалось true)
core.isPrivateAddress('64:ff9b::7f00:1')   // NAT64           → false (ожидалось true)
core.assertPublicHost('http://[::ffff:127.0.0.1]:43015/')  → true    (ожидался SSRF_BLOCKED)
```

Проверено прогоном на Node 22.22.3 против живого listener на `127.0.0.1`: гард пропускает запрос (`assertPublicHost` → `true`). Фактической доставки до приложения не произошло: `postJson` передаёт в `http.request` hostname со скобками ([`packages/core/index.js:767-773`](../../packages/core/index.js)) и получает `ENOTFOUND` — то есть **обход проверки подтверждён, эксплуатация через `postJson` заблокирована случайностью формата hostname**. Риск остаётся: (а) `SECURITY.md:92-103` утверждает, что блокируются «приватные IP-литералы (IPv4/IPv6)»; (б) любой новый потребитель `isPrivateAddress`/`isPrivateHost` (а их вызывают и `verifyMerchantWebhook`, [`packages/core/index.js:2470`](../../packages/core/index.js)) наследует дыру; (в) `64:ff9b::/96` (NAT64) и `::ffff:0:96/96` вообще не в списке диапазонов брифа.

Существующий тест покрывает только «dotted»-форму `::ffff:192.168.0.1` ([`packages/core/selftest.js:484-498`](../../packages/core/selftest.js)), поэтому CI зелёный.

**Что с этим делать:** это ядро MS-09 (пункт 2 «покрыть диапазоны» + пункт 1 «lookup, проверяющий IP внутри callback»). Предлагаем владельцу поднять MS-09 из P1 в P0 и добавить в критерии приёмки: нормализованный `hostname` обязан проходить через `isPrivateAddress` в обеих формах.

### 2.2 `sandbox-id-entropy` — `high` (MS-14)

`generateSandboxId` = 16 прилагательных × 16 существительных × 5 случайных байт ([`packages/core/index.js:1818-1822`](../../packages/core/index.js)) = **ровно 48 бит** энтропии (проверено: теоретическое пространство 2^48, 200 000 id — без коллизий). RFC §7 требует ≥96 бит ([`docs/rfc/RFC-001-multi-tenant-sandboxes.md:122`](../rfc/RFC-001-multi-tenant-sandboxes.md)). При этом страницы `form`-политики (`/payment/{id}`, `/receipts/{uuid}`) защищены **только** секретностью идентификатора ([`packages/core/index.js:2200-2204`](../../packages/core/index.js)), а `PaymentId` Т-Банка — монотонный `Date.now() + offset` ([`services/tbank-mock/server.js:119`](../../services/tbank-mock/server.js)). Теста на перебор id нет ни в одном selftest.

### 2.3 `security-headers-partial` — `medium` (уточняет MS-16)

`X-Frame-Options`/`Referrer-Policy`/`CSP` выставлены **только** на `/admin` ([`services/tbank-mock/server.js:3334-3341`](../../services/tbank-mock/server.js), kassa `:1726-1733`, yookassa `:1900-1907`, atol `:1459-1466]). `core.html()` заголовков не добавляет ([`packages/core/index.js:284-286`](../../packages/core/index.js)), поэтому покупательские страницы и страницы чеков идут без них: [`services/tbank-mock/server.js:3290,3301,3313,3321`](../../services/tbank-mock/server.js), [`services/yookassa-mock/server.js:1861-1897`](../../services/yookassa-mock/server.js), [`services/kassa-mock/server.js:1877-1880`](../../services/kassa-mock/server.js), [`services/atol-mock/server.js:1503-1505`](../../services/atol-mock/server.js). `X-Content-Type-Options: nosniff` — 0 совпадений во всём репо.
Позитив: `escapeHtml` экранирует `"` и `'` ([`packages/core/index.js:296-298`](../../packages/core/index.js)), поэтому атрибутные контексты защищены; единственная сырая интерполяция в атрибут — `value="${pan}"` из статического списка тестовых карт ([`services/tbank-mock/server.js:1967`](../../services/tbank-mock/server.js)), значений интегратора там нет → `[VERIFY]` про атрибуты **снят**.

### 2.4 `sandbox-ttl-off-virtual-clock` — `medium` (уточняет MS-38)

Все четыре сервиса передают виртуальные часы в очереди вебхуков (`now: () => clock.now()`: [`services/tbank-mock/server.js:577`](../../services/tbank-mock/server.js), kassa `:775`, yookassa `:433`, atol `:809`), но **не** передают их в `createSandboxRuntime` ([`services/tbank-mock/server.js:196-213`](../../services/tbank-mock/server.js), kassa `:214-231`, yookassa `:152-169`, atol `:220-237]), где дефолт — `() => Date.now()` ([`packages/core/index.js:1913`](../../packages/core/index.js)). Следствие: `POST /mock/time {"advance":"+7d"}` не может ускорить истечение TTL песочницы и retention — `/mock/time`-сценарии для hosted-лайфсайла недоступны, а тесты это зафиксировать не могут.

### 2.5 `auth-query-token-locked-by-tests` — `info` (риск волны MS-06)

Поведение «токен в query» закреплено тестами как контрактом: [`services/kassa-mock/selftest.js:646-662`](../../services/kassa-mock/selftest.js) прямо проверяет `GET /admin?admin_token=…` → 200 и `Location: /admin?admin_token=…`. Кроме того, `/admin/action` сам перекладывает `admin_token`/`sandbox_token` из query в redirect ([`services/tbank-mock/server.js:3352-3360`](../../services/tbank-mock/server.js)). Значит MS-06 — не «добавить отказ в hosted», а **миграция с переписыванием 4+ selftest'ов и страницы `/admin`**; в реестре волн это надо учесть.

### 2.6 `env-doc-drift` — `low` (правило §2.6 брифа не выполняется)

Сервисы читают **61** переменную `MOCK_*`; **14** из них отсутствуют в `docker-compose.include.yml`, в т.ч. `MOCK_SANDBOX_CREATE_LIMIT`, `MOCK_SANDBOX_FILE`, `MOCK_SANDBOX_RETENTION_MS`, `MOCK_SANDBOX_SWEEP_MS`, `MOCK_FN_CAPACITY`, `MOCK_OFD_MODE` (метод: сопоставление `MOCK_[A-Z0-9_]+` в `services/*/server.js` с include-файлом; `MOCK_FERMA_`/`MOCK_OPERATOR` — артефакты конкатенации строк в коде, их исключить при повторной проверке). Документация распределена неровно: `MOCK_SANDBOX_*` описаны только в README `tbank` и `kassa` (по 1 строке), в `yookassa` (11 строк env-таблицы) и `atol` (15) — 0; `MOCK_VIRTUAL_CLOCK` нет **ни в одном** README сервиса и нет в `SECURITY.md` (упоминания — только [`README.md:115`](../../README.md), [`CHANGELOG.md:220`](../../CHANGELOG.md), [`docs/integration/lovii.md:203`](../integration/lovii.md)).

### 2.7 `third-party-doc-copies` — `high` (юридический, MS-07)

В репозитории лежат **полные сохранённые страницы портала провайдера**: [`docs/reference/tbank-api/api-init.html`](../reference/tbank-api/api-init.html) (161 942 байта), `api-confirm.html` (122 226), `api-cancel.html` (123 589) — Docusaurus-разметка `<title>Инициировать платеж | T-Bank Dev Portal</title>`, `og:url = developer.tinkoff.ru/eacq/api/init`. Это 407 757 байт чужого контента без указания лицензии; остальные `docs/reference/**` — собственные конспекты (`.md`, с шапкой проекта). Остаток MS-07: удалить/заменить ссылкой, либо получить разрешение. Отдельно: `NOTICE:3` содержит «бренд LOVII», а `lovi` упоминается в **29 файлах** (включая дефолт `loviitest` в [`docker-compose.include.yml:92`](../../docker-compose.include.yml) и [`scripts/compose-selftest.js:33`](../../scripts/compose-selftest.js)) → пункт 5 `[DECISION]` открыт широко, а не только в `docs/integration/lovii.md`.
**Скан истории git не выполнен:** песочница — shallow-клон (один коммит, `.git/shallow`), поэтому вывод «история чиста» дать невозможно; в-tree проверка секретов прошла чисто (0 кандидатов, кроме заведомо фейковых `selftest-csrf-secret` и `mock-acqapi-bearer-…`). Скан полной истории — задача владельца/CI (`gitleaks` в песочнице отсутствует).

### 2.8 `openapi-drift-yookassa` — `medium` (покрывает MS-18/MS-37)

`check:drift` сверяет манифест ↔ `server.js` ↔ OpenAPI для **трёх** адаптеров ([`scripts/check-protocol-drift.js:49,86,130`](../../scripts/check-protocol-drift.js)); ЮKassa не имеет ни `protocols/yookassa.json`, ни `docs/openapi/yookassa-mock.openapi.json`, ни маршрута `/openapi.json` — расхождение задокументировано в [`services/yookassa-mock/README.md:209`](../../services/yookassa-mock/README.md), но при этом [`README.md:23`](../../README.md) заявляет «OpenAPI 3.1 (`/openapi.json`)» без оговорки, а в матрице `README.md:105` колонка ЮKасса тоже молчит о `/openapi.json`. Следствие: 2115 строк `services/yookassa-mock/server.js` не покрыты ни дрейф-чекером, ни манифестом — только selftest'ом. Это же блокирует MS-18 «составить список секретных полей из `protocols/*.json`» для ЮKassa: манифеста нет.

---

## 3. Карта покрытия

Обозначения: **A** — разбор построчно (аудит-реестр #15), **S** — selftest-набор, **D** — `check:drift`, **L** — `check:links`, **C** — CI-проверка конфига, **P** — Docker smoke/compose, **—** не проверялось глубоко.

### 3.1 Исходники и конфигурация

| Артефакт | Строк | A (база `e3316f0`) | S | D | L/C | Глубина сегодня | Что НЕ проверялось |
|---|---:|:--:|:--:|:--:|:--:|---|---|
| `packages/core/index.js` | 2670 | ✅ 1–1036 | ✅ 45 | — | — | реестр закрывал 38% файла; волны #22–#40 правили ядро | `createSandboxRuntime` (1896–2460), `createVirtualClock` (1195–1335), `createScenarioRegistry`, `verifyMerchantWebhook` (2460–2617), CSRF/`isSameOriginRequest` (1547–1613) |
| `services/tbank-mock/server.js` | 3430 | ✅ 1–2282 | ✅ 1871 | ✅ | — | крупнейший файл репо, +1148 строк после базы | acqapi-partner (`/acqapi/*`), `e2c` после 2282, `/admin`-рендер (2171–2300), dispute/chargeback-flow (816–1092), `POST /sandboxes*` (2380–2470) |
| `services/kassa-mock/server.js` | 1966 | ✅ 1–1558 | ✅ 1136 | ✅ | — | +408 строк | dry-run/валидация 54-ФЗ, `retention`, `/admin/action` (1900–1955), страницы чеков |
| `services/yookassa-mock/server.js` | 2115 | **—** | ✅ 822 | **—** | — | **ни разу не был в области аудита** | весь файл: Basic Auth, идемпотентность, partial capture, `cancellation_details`, metadata-лимиты, `/admin`, редиректы (1861–1930) |
| `services/atol-mock/server.js` | 1672 | **—** | ✅ 853 | ✅ (манифест) | — | **ни разу не был в области аудита** (добавлен в #34) | весь файл: `getToken`/TTL, идемпотентность `external_id`, валидация ФФД 1.05, callback-очередь, `/receipts/{uuid}` |
| `packages/core/selftest.js` | 982 | ✅ 1–256 | — | — | — | вырос в 3.8× | качество ассертов: есть ли проверки «отрицательных» границ (см. партии) |
| `services/{yookassa,atol}-mock/selftest.js` | 822 / 853 | **—** | — | — | — | не проверялись | полнота покрытия протокола, изоляция песочниц |
| `services/{tbank,kassa}-mock/selftest.js` | 1871 / 1136 | ✅ (tbank 1–703) | — | — | — | tbank-база устарела в 2.7× | flake-риск, фиксированные порты, `sleep` |
| `scripts/check-protocol-drift.js` | 247 | **—** | — | сам чекер | — | чекер никто не проверял на «слепоту» | ложные проходы: `inServer = code.includes(строка)` → совпадение с комментарием засчитывается как реализация |
| `scripts/compose-selftest.js` | 495 | ✅ 1–214 | — | — | — | +281 строка, 4 сервиса | корректность изоляции F-33, очистка в `finally` |
| `scripts/{sync-upstream,check-docs-links,docker-smoke,docker-healthcheck}.js` | 339/67/158/43 | **—** | ✅ (upstream) | — | — | не проверялись | парсинг snapshot, `--read-only` контур, экранирования |
| `Dockerfile` | 55 | ✅ 1–27 | — | — | C | закрыт #37 (F-35/F-36/F-37) | `COPY scripts` лишний (см. MS-29), OCI-лейблы, мультиарх |
| `docker-compose.yml` | 122 | ✅ 1–54 | ✅ (`test:compose`) | — | C | +68 строк | hardening (MS-04), `MOCK_PUBLIC_BASE_URL` vs host-port (MS-22) |
| `docker-compose.include.yml` | 228 | ✅ 1–102 | — | — | C | +126 строк | fallback на env потребителя (MS-02), caddy-метки (MS-28), дубли (MS-24) |
| `package.json` | 62 | ✅ 1–53 | — | — | — | `engines: >=18` | `files`-лист против реального состава образа; MS-40 |
| `.github/workflows/ci.yml` | 130 | ✅ 1–110 | — | — | — | +20 строк | publish: мутабельность `:0.5.0`, отсутствие `pull`-проверки, Node 18/20 (MS-40) |
| `.github/workflows/sync-upstream.yml` | 24 | **—** | — | — | — | не проверялся | permissions, `secrets.*`, частота |
| `protocols/*.json` | 397 (4 файла) | **—** | — | сам источник D | — | манифесты — источник истины дрейфа | достоверность манифеста vs `docs/reference/**`; отсутствие `yookassa.json` |
| `docs/openapi/*.json` | 3 файла | **—** | — | ✅ (участие в D) | — | — | валидность OpenAPI 3.1 (нет валидатора), синхрон с `routes` |

### 3.2 Документация и правовое

| Артефакт | Покрытие | Статус |
|---|---|---|
| `README.md` (172 строки) | A ✅ 1–129 | сверить разделы «Статус»/«Дорожная карта» с фактом: строки 23 (OpenAPI для всех) и 105 (матрица) против `yookassa README:209` (§2.8) |
| `SECURITY.md` (113) | A ✅ 1–43, +70 строк после | таблицы «сценарии/меры» надо перепроверить против кода: `MOCK_SANDBOX_CREATE_LIMIT` там не упомянут, «rate limit» обещан без переменной |
| `CONTRIBUTING.md` (91) | A ✅ 1–59 | согласован со скриптами; не хватает `test:compose`, `AGENTS.md`, правила «env → все 5 мест» |
| `CHANGELOG.md` (333) | ✅ (текстовое) | нет раздела «ломающие изменения мока» (MS-35) |
| `NOTICE`, `LICENSE` | A ✅ | `NOTICE:3` — «бренд LOVII»; `LICENSE` — полный Apache-2.0 |
| `docs/canon/**` (4 файла) | ручной просмотр этого прогона | имён клиентов/контактов/цен/внутренних URL не найдено; есть ссылки на Lovii-карточки (SZ-095/SZ-096/T-038) |
| `docs/reference/**` (24 `.md` + 3 `.html`) | **не проверялось** | 3 `.html` — копии портала Т-Банка (§2.7); конспекты 8 провайдеров (alfa/sber/vtb/taxcom/kontur/first-ofd/atol-online/yookassa) — точность и «срок годности» не верифицированы |
| `docs/integration/**` (5 файлов) | L ✅ (ссылки) | содержание «интеграция за 10 минут» vs фактические маршруты — не сверялось; `lovii.md` — 32 упоминания |
| `docs/rfc/RFC-001…` (161) | ✅ прогона | см. MS-31 (4 точки расхождения) |
| `docs/audit/**` | — | реестр #15: 38/38 закрыто на базе `e3316f0`; `AUDIT-2026-10-08.md` §2 «карта дефектов A-1…A-24» — построчной сверки «закрыто/не закрыто» после волн #22–#40 не делалось → партия F |
| `.github/ISSUE_TEMPLATE/**` (3 файла) | — | нет шаблона «новый провайдер» (MS-36) |

### 3.3 Итог по зонам

Глубоко **не** проверялись (в порядке объёма): `services/yookassa-mock/**` (2937 строк), `services/atol-mock/**` (2525), «хвосты» `tbank-mock`/`kassa-mock` (1556), вторая половина `packages/core` (1634), `scripts/check-protocol-drift.js` + `scripts/{docker-smoke,sync-upstream,check-docs-links,docker-healthcheck}.js` (607), `docs/reference/**` (кроме ссылок), `docs/integration/**` (кроме ссылок), `.github/workflows/sync-upstream.yml`. Это и есть предмет партий §4.

---

## 4. Партии глубокого аудита

Партии независимы, каждая — read-only + один отчёт в `docs/audit/AUDIT-PARTY-<id>-<дата>.md`. Порядок: A → B → C → D → E → F; E и F можно запускать параллельно с A/B.

### A. «Ядро: вход, состояние, лимиты» — `packages/core/index.js` целиком

* **Область:** [`packages/core/index.js`](../../packages/core/index.js), строки 1–2670 (реестр #15 покрывал 1–1036). Приоритетные блоки: `safeStateSnapshot`/`mergeValidatedInto` (68–178), `readBody`/`parseBody` (213–271), редакция (300–546), `createJournal` (613–724), `postJson` (725–845), SSRF-гард (846–972), очередь (980–1090), часы (1195–1335), сценарии (1377–1530), auth/CSRF (1530–1658), `createSandboxManager` (1691–1806), `createSandboxRuntime` (1896–2460), `verifyMerchantWebhook` (2460–2617).
* **Вопросы партии:** где `state`-фасад (`Proxy`, 2385–2418) отдаёт доступ вне контекста запроса? кто обходит `admit()`/`policy`? может ли `retention`/`sweep`/`exportState` прочитать чужую песочницу? что делает `tickAll` с очередями чужих арендаторов? есть ли unbounded-рост (`createLog`-Map, `scenarios`, `journal`)? корректен ли `safeEqual` на не-ASCII (см. комментарий `services/tbank-mock/server.js:271`)?
* **Критерии приёмки:** (1) по каждой из 6 зон — список находок `файл:строка` + прогон-доказательство (`node -e` или selftest); (2) `[VERIFY]`-пункты MS-08/MS-14/MS-17/MS-20/MS-38 закрыты или переведены в задачи; (3) находка уровня «можно прочитать чужую песочницу» воспроизведена скриптом; (4) ни одного изменения поведения в PR партии.
* **Формат отчёта:** чек-лист партии ([`CHECKLIST-audit-party.md`](CHECKLIST-audit-party.md)) + таблица реестра (ID · модуль · файл:строка · категория · severity · суть · предлагаемая задача · зависимости), как в [`REGISTRY-2026-10-11-code-sweep.md`](REGISTRY-2026-10-11-code-sweep.md) §2.
* **Оценка:** 1–2 дня. **Риск:** высокий (здесь живут все защитные механизмы, которые адаптеры только «вызывают»).

### B. «Адаптеры-сироты: ЮKassa и АТОЛ» — 4800 строк без аудита

* **Область:** [`services/yookassa-mock/server.js`](../../services/yookassa-mock/server.js) (1–2115), [`services/atol-mock/server.js`](../../services/atol-mock/server.js) (1–1672), их `selftest.js` (822/853), README-«Границы», [`docs/integration/yookassa.md`](../integration/yookassa.md), [`docs/integration/atol.md`](../integration/atol.md).
* **Вопросы партии:** совпадает ли машина статусов/кодов ошибок с `docs/reference/yookassa/01-payments-and-refunds.md` и `atol-online/01-api-v4-v5.md`; где идемпотеность (`Idempotence-Key`, `external_id`) допускает гонку; корректен ли ACK вебхука (`200` ровно / любой 2xx); покрыты ли `mock`-маршруты теми же защитными слоями, что tbank/kassa (редакция, control access, sandboxes, HTML-заголовки — см. §2.3); почему у ЮKassa нет манифеста/OpenAPI и сколько это «стоящих» инвариантов (ср. 221 у трёх других).
* **Критерии приёмки:** (1) таблица «маршрут мока → раздел доки → статус сверки» покрывает **все** маршруты обоих сервисов; (2) для каждого маршрута указано, есть ли негатив-тест; (3) находки формата реестра; (4) список инвариантов, которые должен был бы проверить дрейф-чекер, если завести `protocols/yookassa.json` (это вход для MS-18/MS-37, но **не** реализация).
* **Оценка:** 2 дня. **Риск:** высокий (полностью непроявленная зона; ЮKassa — единственный адаптер без D-покрытия).

### C. «Инфраструктура доверия: CI, образы, скрипты проверок»

* **Область:** [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), [`.github/workflows/sync-upstream.yml`](../../.github/workflows/sync-upstream.yml), [`scripts/check-protocol-drift.js`](../../scripts/check-protocol-drift.js), [`scripts/check-docs-links.js`](../../scripts/check-docs-links.js), [`scripts/sync-upstream.js`](../../scripts/sync-upstream.js), [`scripts/docker-smoke.js`](../../scripts/docker-smoke.js), [`scripts/compose-selftest.js`](../../scripts/compose-selftest.js), [`scripts/docker-healthcheck.js`](../../scripts/docker-healthcheck.js), [`Dockerfile`](../../Dockerfile), [`package.json`](../../package.json) (`files`, `engines`, `scripts`).
* **Вопросы партии:** может ли CI остаться зелёным при реальной поломке (главный вопрос): `check:drift` сверяет подстрокой (`code.includes(route)`) → совпадение с комментарием/README-ссылкой засчитывается как «реализовано»; `check:links` сканирует только `README/CONTRIBUTING/SECURITY + docs/ services/ packages/` ([`scripts/check-docs-links.js:23,54-58`](../../scripts/check-docs-links.js)) → `CHANGELOG.md`, `AGENTS.md`, `NOTICE` и все `.html` вне проверки; `test:docker` и `test:compose` не входят в `npm test` → compose-контур в PR-прогоне покрыт отдельной job; `publish-ghcr` перетирает `:0.5.0` на каждый push (§1.1); нет `pull`-проверки опубликованного тега; matrix 18/20 — EOL-рантаймы (§1.1); `sync-upstream.yml` — права/секреты/частота.
* **Критерии приёмки:** (1) таблица «проверка → что реально детектирует → минимальная поломка, которую она ловит» по всем 7 скриптам; (2) ≥3 намеренно внесённых «поломки» в рабочей копии (только локально, не в PR) с подтверждением, что CI их ловит/не ловит; (3) находки формата реестра; (4) предложения по усилению — списком, без правок.
* **Оценка:** 1 день. **Риск:** средний, но «мультипликатор»: слабые чекеры занижают уверенность во всех остальных партиях.

### D. «Контур размещения: compose, env, hosted-поверхность»

* **Область:** [`docker-compose.yml`](../../docker-compose.yml), [`docker-compose.include.yml`](../../docker-compose.include.yml), все `MOCK_*` env (61 переменная), [`SECURITY.md`](../../SECURITY.md), [`docs/rfc/RFC-001-multi-tenant-sandboxes.md`](../rfc/RFC-001-multi-tenant-sandboxes.md), `services/*/README.md` (env-таблицы), MS-02/04/10/12/13/19/21/22–29.
* **Вопросы партии:** какие env реально меняют поведение, а какие «прочитаны и проигнорированы» (например `MOCK_SANDBOX_MAX_DOCUMENTS` при `ttl=0`, `MOCK_SANDBOX_HOST_SUFFIX` без wildcard DNS); что произойдёт при включённом `MOCK_HOSTED=1` на голом железе (перечислить векторы: default-песочница §MS-12, query-токены §MS-06, лимит-час вместо суток, отсутствие RPS); чем отличается `docker-compose.yml` от include-набора и какой из двух «канонический» (MS-24);
`/data` + `read_only` + init — что ломается (MS-04); корректны ли healthcheck-пары (3100/`/health`, 3101/`/healthz`, 3102/`/health`, 3103/`/health`) во всех трёх местах (compose, include, `docker-healthcheck.js`).
* **Критерии приёмки:** (1) полная таблица env: `переменная → где читается (файл:строка) → дефолт → где задокументирована → где в compose` с пометкой «нет в include/нет в README» (это закрывает §2.6 как частный случай); (2) чек-лист «hosted go/no-go» из 10–15 пунктов, привязанных к коду; (3) находки формата реестра; (4) ни одной правки compose в PR партии.
* **Оценка:** 1–2 дня. **Риск:** высокий для публичного стенда (это партия, которая решает, можно ли вообще включать `MOCK_HOSTED=1`).

### E. «Протокольное соответствие: манифесты, OpenAPI, конспекты провайдеров»

* **Область:** [`protocols/tbank-eacq.json`](../../protocols/tbank-eacq.json), [`protocols/ferma-ofd.json`](../../protocols/ferma-ofd.json), [`protocols/atol-online.json`](../../protocols/atol-online.json), [`protocols/upstream-snapshot.json`](../../protocols/upstream-snapshot.json), `docs/openapi/*.openapi.json`, `docs/reference/{tbank,yookassa,atol-online,ferma?}/**`, `docs/reference/external-links.md`, `docs/integration/**`.
* **Вопросы партии:** где манифест «шире» или «уже» реального `server.js` (сверка маршрутов/кодов/статусов вручную, не подстрокой); все ли `errorCodes` есть в DX-каталогах адаптеров; совпадает ли `docs/reference/tbank/04-test-cards.md` со списком `CARDS` ([`services/tbank-mock/server.js:286-300`](../../services/tbank-mock/server.js)); датированы ли сверки и что из конспектов устарело (таблица «дата сверки» в каждом файле); не являются ли конспекты дословными копиями (юридический хвост §2.7 — 24 `.md` + 8 провайдеров).
* **Критерии приёмки:** (1) расхождения манифест ↔ сервер ↔ OpenAPI перечислены построчно с цитатой доки; (2) для ЮKassa — список из ≥40 инвариантов, которые могли бы быть в `protocols/yookassa.json` (проект, не реализация); (3) правовая сводка «что удаляем/переписываем/ссылаемся» для владельца (вход MS-07); (4) находки формата реестра.
* **Оценка:** 2 дня. **Риск:** средний технически, высокий юридически.

### F. «Закрытие хвостов: реестр #15, аудит 08.10, бриф-волны»

* **Область:** [`REGISTRY-2026-10-11-code-sweep.md`](REGISTRY-2026-10-11-code-sweep.md) (F-01…F-38), [`AUDIT-2026-10-08.md`](AUDIT-2026-10-08.md) (§2 карта дефектов A-1…A-24, §4.2/§5.2 «чего не хватает»), [бриф MS-01…MS-40](../briefs/CLAUDE-2026-10-12-agent-brief.md).
* **Вопросы партии:** действительно ли закрыты F- и A-пункты (реестр объявляет 38/38 закрытыми на базе, которая на 2/3 меньше текущей); не «закрыл» ли реестр что-то ссылкой на волну, которая потом сделала иначе; какие пункты §4.2 (недостающая протокольная полнота Т-Банка) и §5.2 (матрица 54-ФЗ) так и не реализованы, но больше не отслеживаются; нет ли задач, которые волны #22–#40 поставили дважды.
* **Критерии приёмки:** (1) таблица «ID находки → где закрыта (PR/коммит/тест) → проверено в коде (файл:строка) → вердикт»; (2) список «закрыто, но регрессировало / закрыто не полностью»; (3) список дублей MS/F/A с предложением, какой ID оставить; (4) все расхождения перенесены в раздел «Открытые» этого документа.
* **Оценка:** 1 день. **Риск:** низкий технически, но без него нельзя объявлять «аудит пройден».

### Матрица «партия → задачи брифа»

| Партия | MS-задачи, которые она закрывает или подтверждает |
|---|---|
| A | MS-08, MS-09, MS-14, MS-16, MS-17, MS-18, MS-19, MS-20, MS-38, MS-39 |
| B | MS-11, MS-16, MS-18, MS-21, MS-30, MS-34, MS-37 (+ первые собственные находки по этим сервисам) |
| C | MS-01, MS-03(остаток), MS-27, MS-29, MS-36, MS-38(CI-lint), MS-40 |
| D | MS-02, MS-04, MS-05, MS-06, MS-10, MS-12, MS-13, MS-15, MS-22, MS-23, MS-24, MS-25, MS-26, MS-28, MS-31, MS-32 |
| E | MS-18, MS-37, MS-07, MS-33, MS-34, MS-35 |
| F | все «выполнено» + MS-15, MS-33 |

---

## 5. Развилки владельца (ничего не решаем за владельца)

| # | Вопрос | Варианты | Цена/риск |
|---|---|---|---|
| 1 | Лицензионные шапки (MS-05) | (a) оставить «все права защищены» как стандарт владельца и **снять** задачу; (b) заменить на `Copyright 2026 ООО «Аксиома». Licensed under the Apache License 2.0.` в 32 файлах; (c) заменить только в публичных (`README/SECURITY/CHANGELOG`), внутренние доки не трогать | (b) — чисто механический PR, но 32 файла и конфликт с будущими волнами; (a) — противоречие Apache-2.0 остаётся |
| 2 | Lovii (MS-07 #5) | (a) согласовать публикацию; (b) заменить `loviitest`/`lovii-core`-комментарии на `MOCKTEST` в 29 файлах; (c) заменить только в `docker-compose.include.yml`, `scripts/` и `README`, исторические доки (`docs/audit`, `docs/canon`, `docs/briefs`) оставить | (b) задевает selftest'ы (дефолт `FERMA_LOGIN`), (c) — минимальный диф |
| 3 | Копии доки Т-Банка (`docs/reference/tbank-api/*.html`) | (a) удалить → ссылка + собственный конспект; (b) оставить с явной пометкой «локальная копия, дата снятия, не для редистрибуции»; (c) вынести в release artifacts | (a) ломает `docs/reference/external-links.md`-навигацию? нет — там внешние URL; (b) оставляет риск |
| 4 | Журнал арендаторам (MS-21) | (a) не отдавать; (b) `GET /sandboxes/me/journal` с редакцией и лимитом; (c) статистика без записей | (b) требует новой редакции «только своя песочница» и тестов изоляции |
| 5 | Единый стенд (MS-32) | (a) 4 песочницы на 4 домена (как сейчас); (b) тонкий шлюз, создающий 4 песочницы одной операцией; (c) отдельный «contour-compose» | (b) — новая surface + свой аудит безопасности |
| 6 | Node (MS-40) | (a) минимум 22, CI 22+24; (b) 20+22+24; (c) оставить 18/20/22 | по состоянию на 2026-10-12 Node 18 EOL с 2025-04-30, Node 20 EOL с 2026-04-30; Node 24 — Active LTS до 2026-10-20, Node 26 становится LTS 2026-10-28; **дополнительный аргумент:** раннеры уже принудительно исполняют наши job на Node 24 (депрекейшн-предупреждение в логе `38265251073`), а `ubuntu-latest` мигрирует на Ubuntu 26 с 2026-10-19 → (c) живёт не дольше недели |
| 7 | Приоритет SSRF-обхода (§2.1) | (a) поднять MS-09 в P0 (до любого сетевого релиза); (b) оставить P1, но закрыть точечно `isPrivateAddress` + тесты до публикации | (b) — минимальный фикс на ~15 строк ядра без смены протокольного поведения |
| 8 | `sandbox-id` энтропия (§2.2) | (a) `randomToken`-стиль ≥96 бит + человекочитаемый алиас; (b) сохранить читаемое имя, но закрыть `form`-страницы owner-token'ом | (a) ломает читаемость логов; (b) меняет DX hosted |

---

## 6. Открытые (не закрытые прогоном #43) вопросы

1. Публичность пакета GHCR и «образ содержит все 4 сервиса» — **не подтверждается из песочницы**: `gh api orgs/rucorp/packages/container/mock-services` → `403 Resource not accessible by integration`, docker в песочнице отсутствует. Требуется прогон владельца (`docker pull ghcr.io/rucorp/mock-services:0.5.0`) или job в CI.
2. Скан полной истории git (MS-07 #3) — невозможен в shallow-клоне (§2.7).
3. Настройки репозитория (Private vulnerability reporting, видимость issues/PR-шаблонов, правила веток) — не сверялись.
4. `test:docker` и `test:compose` локально не запускались (нет Docker) — полагаемся на зелёную job `docker` в `38259475582`.
5. Точность 8 конспектов провайдеров (`alfa`, `sber`, `vtb`, `taxcom`, `kontur-ofd`, `first-ofd`, `atol-online`, `yookassa`) не проверялась против первоисточников — партия E.
6. **Флак `test:yookassa`:** при первом прогоне `npm test` зафиксирован `ИТОГ: 226 passed, 1 failed` (вебхуки: «недоставленный вебхук ретраится…», `X-Mock-Latency 300ms выдержан` — `services/yookassa-mock/selftest.js:607,646`); следующие 3 полных прогона, 9 одиночных прогонов selftest и 3 параллельных прогона под CPU-нагрузкой зелёные. Причина не установлена (предположительно гонка delivery-таймера при загрузке). **Не находка мока, а находка тестов:** партия A обязана прогнать `test:yookassa` 20× подряд и зафиксировать стабильность (`CONTRIBUTING.md` п.5 требует не-флакости).

---

## 7. Как обновлять этот документ

* После каждой закрытой MS-задачи — править статус **в брифе** ([`docs/briefs/CLAUDE-2026-10-12-agent-brief.md`](../briefs/CLAUDE-2026-10-12-agent-brief.md), §0.1), здесь — только §3 (покрытие) и §6 (открытые вопросы).
* Найденное в партиях — в реестр партии, затем строка в §2 этого документа.
* Перед публикацией/анонсом — прогнать §5 «Развилки»: ни один пункт не должен остаться без решения владельца.
* Проверка актуальности «чисел» документа: `git rev-list --count HEAD`, `wc -l` по §3.1, `npm run check:links`.

---

## 8. Истинный источник

Статусы MS-задач живут **в брифе** ([§0.1 и инлайн-заметки](../briefs/CLAUDE-2026-10-12-agent-brief.md));
реестр находок — в [REGISTRY-2026-10-11-code-sweep.md](REGISTRY-2026-10-11-code-sweep.md).
Этот документ — производный: он отвечает на три вопроса — *что уже проверено*, *что осталось*
и *как это проверять*. Все утверждения «чисел» (длины файлов, счётчики тестов, строки) сверены
с базой `59470a7` прогоном #43; при изменении базы сначала проверяй `wc -l` / `git rev-list --count HEAD`,
потом правь.
