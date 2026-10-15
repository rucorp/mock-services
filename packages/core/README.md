© 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
SPDX-License-Identifier: Apache-2.0

# packages/core — ядро mock-services

Инфраструктура, общая для адаптеров провайдеров. Протоколов здесь нет:
подписи, машины состояний, форматы полей и тестовые карты — в `services/*`.

Zero dependencies, Node >= 18. Self-test: `npm run test:core`.

## API

- `createStore({stateFile, log})` → `{state, persist, restore}` — состояние
  сервиса с опциональной персистентацией (`MOCK_STATE_FILE`).

  **Важно:** `restore()` сливает файл в состояние «на месте» (`mergeInto`) и
  **сохраняет идентичность вложенных объектов**. Подсистемы захватывают ссылки
  на `state.notifications`/`state.callbacks` при старте; подмена объекта
  приводила к тому, что после рестарта очередь вебхуков смотрела в пустой объект
  и молча теряла недоставленные уведомления (дефект A-2 аудита 2026-10-08).

- `installGracefulShutdown({server, flush, log, signals, timeoutMs, exit})` —
  общий обработчик SIGTERM/SIGINT для адаптеров (MS-04): синхронный `flush()`
  отложенных записей → `server.close()` → `closeAllConnections()` → `exit(0)`;
  страховочный таймер `timeoutMs` (по умолчанию 1 с, unref), повторный сигнал
  идемпотентен. Возвращает функцию `shutdown(signal)` с `dispose()` (снятие
  обработчиков — для selftest'ов). Сервисы зовут хелпер в
  `require.main === module`-блоке, передавая `flush: () => sandboxRuntime.flush()`.
- `createLog(tag)` — журналирование с таймстампом.
- `readBody(req, maxBytes)` / `parseBody(raw, contentType)` — входящие тела
  (JSON и form-urlencoded).
- `send(res, code, body, headers)` / `sendJson(res, payload, code, headers)` /
  `html(res, body, code)` — ответы.
- `escapeHtml(value)` — экранирование значений, пришедших от интегратора,
  на HTML-страницах сервисов (чек покупателю, `/admin`).
- `redactSecrets(value)` / `redactSecretsInText(text)` / `redactRawBody(raw)` /
  `summarizeBody(body, {maxKeys, maxValueLength})` — редакция секретов перед
  журналированием и логированием (F-09): ключи-секреты (`Authorization`, `Cookie`,
  `token`, `pass`/`password`, `CVV`, `CardData`, `PAN`, `signature`) заменяются на
  `[REDACTED]`, PII (ИНН, телефон, e-mail, ФИО) маскируются частично, а любая
  строка дополнительно сканируется на PAN (`looksLikePan`/`maskPan`: 13–19 цифр,
  префикс платёжной системы, контрольная сумма Luhn) и на `Basic`/`Bearer`-токены.
- `classifyKey(key)` → `'secret' | 'pii' | 'safe'` — класс поля по имени;
  `maskPiiValue(key, value)` — частичная маска PII.
- `createJournal({size, baseUrl, maxEntryChars, sandboxScope})` →
  `{record, list, clear, clearFor, dropScope}` —
  журнал входящих запросов для `/admin/journal`: метод, путь, ключевые поля, код
  ответа, длительность. Запись редактируется до сохранения (F-09): заголовки —
  через allowlist (`Content-Type`, `Content-Length`, `User-Agent`, `X-Mock-*`),
  тело и сырой payload — через `redactSecrets`/`redactRawBody`, длина полей и всей
  записи ограничена. С `sandboxScope` (адаптеры передают
  `() => sandboxRuntime.current()`) записи живут в разделе записи текущей
  песочницы (PB-13, #52); без него — прежний одиночный журнал.
- `createScenarioRegistry({clock, size, maxRules, maxRuleBytes, sandboxScope})` —
  реестр сценариев `X-Mock-Scenario` и правил `POST /mock/scenarios` с историей
  срабатываний. С `sandboxScope` правила и история изолированы по записи
  песочницы (PA-51/PG-04, #52); дефолтные лимиты — 200 правил на песочницу и
  8 KiB на правило (UTF-8 байты сериализованного JSON), превышение бросает
  ошибку с `code` `rule_cap_exceeded`/`rule_too_large` до мутации. Повторная
  запись с тем же `id` — update на месте. `clearRulesFor`/`clearHistoryFor`/
  `dropScope` оперируют разделом конкретной записи песочницы.
- `postJson(url, payload, timeoutMs, options)` — исходящий POST/GET (http/https по схеме;
  другие схемы отклоняются, редиректы не отслеживаются; для IPv6-литералов скобки
  `[...]` нормализуются перед подключением и сохраняются в заголовке `Host` — PA-25).
- `flagEnabled(value, fallback)` — разбор boolean-настроек из env: `1`/`true`/`yes`/`on`
  против `0`/`false`/`no`/`off`, пустое значение — `fallback` (F-08: `=1` больше не «молчит»).
- `defaultBlockPrivateHosts(env)` — дефолт SSRF-политики ядра, согласованный с адаптерами (PA-58):
  `flagEnabled(MOCK_BLOCK_PRIVATE_WEBHOOKS, flagEnabled(MOCK_HOSTED, false))`.
- `isPrivateAddress(ip)` / `isPrivateHost(url)` — классификация IP-литералов и
  URL («приватный/служебный адрес», включая `ff00::/8`, TEST-NET-1/2/3,
  `2001:db8::/32` и `64:ff9b:1::/48` — PA-26) для защиты вебхуков от SSRF.
- `resolvePublicHost(url, {lookup})` / `assertPublicHost(url, {lookup})` — async-проверка
  перед исходящим запросом: схема http/https, публичный IP, имя резолвится один
  раз только в публичные адреса и пиннится к сокету (защита от DNS TOCTOU / rebinding —
  §7.3, PG-11); бросает `Error` с `code === 'SSRF_BLOCKED'`.
- `checkControlAccess(req, {adminToken, operatorToken, surface, hosted})` —
  единый access-control управляющей поверхности (F-07): роли `admin`/`operator`,
  constant-time сравнение токена, fail-closed при `hosted` без секрета.
- `createDeliveryQueue({...})` — очередь исходящих вебхуков с ретраями:
  запись живёт в состоянии сервиса (переживает рестарт), `retryMs`/`maxAttempts`
  настраиваются, критерий доставки — хук (`isOk`: у Т-Банка это 200 + тело «OK»,
  у Ferma — любой 2xx). Тик — раз в секунду; `awaitSequential` — доставлять
  по одной (Т-Банк) или пачкой (Ferma). Дефолт `blockPrivateHosts` —
  `defaultBlockPrivateHosts()` (локально `false`, при `MOCK_HOSTED=1` — `true`, PA-58);
  то же правило действует в `verifyMerchantWebhook({...})`.

  Гарантии очереди (закреплены тестами):

  1. запись, находящаяся «в полёте», не отправляется повторно — ретраи идут
     строго по расписанию, даже если вебхук отвечает медленнее, чем тик
     (дефект A-3: без защиты одна нотификация уходила параллельными POST-ами);
  2. терминальный статус — флаг `entry.done` (а не `nextAttemptAt = Infinity`,
     который сериализовался в `null` и после рестарта считался «пора слать снова»,
     дефект A-4);
  3. `request(entry)`, бросивший исключение, не роняет тик — запись уходит в
     `onFailure` с текстом ошибки;
  4. при `blockPrivateHosts: true` (или по умолчанию в `MOCK_HOSTED=1`) отправка
     на приватные/служебные адреса и имена, которые в них резолвятся, блокируется
     с привязкой проверенного IP к соединению против DNS TOCTOU (дефекты A-18/F-08,
     #51 PF-01/PA-25/PA-26/PA-58/PG-11);
  5. `awaitSequential: true` — записи уходят строго по одной и в порядке
     очереди: следующая запись не стартует, пока предыдущая не завершилась,
     и новый тик не начинается поверх идущего (F-29: даже медленный приёмник
     не может получить статусы одного платежа не по порядку).
- `createErrorCatalog({provider, docsBase, codes})` — каталог ошибок DX-слоя:
  `{код, объяснение, поле, подсказка, ссылка на официальный раздел доки}`.

## Песочницы (RFC-001): источники owner-token

`createSandboxRuntime({mode, ...})` даёт адаптеру `admit`, `run`, `selector`,
`ownerTokenOf`, `isOperatorToken`, `isOperatorRequest`, `recordAuthorized`,
`recordByOwnerToken` и операции жизненного цикла песочниц. В `owned`-режиме
(включается `MOCK_HOSTED=1` или явным `MOCK_TENANCY=owned`) доступ к песочнице
даёт только её owner-token: **знание id доступа не даёт** (F-12).

`ownerTokenOf(req)` читает owner-token в строгом порядке (задача #98):

| # | Источник | Комментарий |
|---|---|---|
| 1 | `X-Sandbox-Token: <токен>` | явный заголовок владельца — самый приоритетный |
| 2 | `X-Owner-Token: <токен>` | синоним; уступает `X-Sandbox-Token` |
| 3 | cookie `mock_sandbox_token=<токен>` | сессионная cookie консоли; читается с декодированием (Ф-2, #121) |
| 4 | `Authorization: Bearer <токен>` | fallback для клиентов, знающих только Bearer |
| 5 | `?sandbox_token=<токен>` | только non-hosted `namespaces` (WARN об устаревании); в `owned` и в hosted отклоняется fail-closed (Ф-3, #121) |

Порядок важен: у адаптеров, чей бизнес-контракт сам ходит по
`Authorization: Bearer <токен>` (first-ofd — токен очереди, vtb — OAuth
`access_token`), Bearer приоритетнее явного заголовка означал, что ядро
принимало токен бизнес-авторизации за owner-token, владелец не находился и
получал 401 «знание ID не является доступом». Bearer оставлен как fallback, а не
убран: клиенты, передающие owner-token только в `Authorization`, продолжают
работать.

Правила, закреплённые тестами `packages/core/selftest.js`:

- источник с пустым или пробельным значением считается **отсутствующим** и не
  затеняет следующие источники;
- невалидный/чужой owner-token → `admit` отвечает `kind: 'unauthorized'`
  (HTTP 401), состояние песочницы не выдаётся;
- операторский путь (`MOCK_OPERATOR_TOKEN`) от этого порядка не зависит:
  `isOperatorRequest` дополнительно сверяет `tokenMatches` по самому
  `Authorization` / `X-Operator-Token` / query, поэтому оператор с Bearer
  узнаётся даже когда owner-заголовок занят чужим токеном;
- при `mode` `namespaces`/`off` (self-hosted) owner-token не требуется вовсе, и
  бизнес-заголовки адаптера не трактуются как owner-token.

Опция `hosted` (`MOCK_HOSTED=1`, MS-12, #121): при пустом `defaultOwnerToken`
песочница `default` **не обслуживается** — бизнес- и form-маршруты без селектора
получают `kind: 'not-found'` (адаптеры отдают 404 с точной причиной и хинтом),
публичная инфраструктура (`/health`, `/openapi.json`, `/sandboxes`) отдаётся
detached public record, именованные песочницы работают по owner-token.
Управляющая поверхность (`policy: 'control'`) MS-12 не перекрывает: у неё свой
fail-closed гейт MS-06. Без `MOCK_HOSTED` поведение `default` не меняется.

Диагностика `hosted`/self-hosted вынесена в `defaultSandboxStatus({ownerToken,
hosted, tenancy})` → `default=owner-token | default=closed (MS-12: …) |
default=open` — этой строкой адаптеры печатают статус при старте.

Сессионные cookie консоли (Ф-1, #121): `sessionCookieHeader(name, value)` (HttpOnly,
`SameSite=Strict`, `Path=/`, `Max-Age`), `sessionCookiesFromQuery(req, {...})`
(переносит принятые из query `admin_token`/`operator_token`/`sandbox_token` в
cookie; в hosted возвращает пустой список) и
`attachResponseCookies(res, cookies)` (добавляет `Set-Cookie`, не перетирая
собственные cookie ответа). `readCookieValue(req, name)` — чтение cookie с
декодированием (`%3D` → `=`, разделение по первому `=`).

## Байтовые квоты песочниц (PD-02, #74)

`createSandboxRuntime` принимает два независимых лимита (целые байты UTF-8
сериализованного JSON, не число документов):

| Опция / env всех 9 сервисов | По умолчанию | Значение `0` |
| --- | --- | --- |
| `maxStateBytes` / `MOCK_SANDBOX_MAX_STATE_BYTES` | пусто / `null` / `undefined`: 8 МиБ (`8388608`), если `maxDocuments > 0`, иначе без лимита | выключить per-sandbox квоту |
| `globalMaxStateBytes` / `MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES` | пусто / `null` / `undefined`: 64 МиБ (`67108864`), независимо от `maxDocuments` и tenancy | выключить глобальный бюджет |

Env задавайте целыми байтами, например `MOCK_SANDBOX_MAX_STATE_BYTES=4194304`.
Адаптеры используют существующий `parseMsOr`: пустое/невалидное значение
оставляет дефолт, явный `0` выключает соответствующий лимит.
`refreshStateQuota()` обновляет снимки отката и кэш размеров после startup-restore
и миграций адаптера (не вызывать после бизнес-мутации).
`stats()` возвращает эффективные `maxStateBytes` и `globalMaxStateBytes`.

Глобальный бюджет — сумма состояний **всех записей одного рантайма**, включая
`default`, а не бюджет всего compose-стенда. Размер соседей кэшируется по версии:
запись не сериализует весь реестр. Удаление/TTL освобождает бюджет, reset и
замена снимка учитывают новый размер вместо старого (без двойного учёта).
Создание учитывает начальное состояние песочницы; отказ не оставляет запись.

Проверки выполняются при `checkDocuments()` (до бизнес-записи), `persist()`
(глобальный бюджет после мутации) и `importState()` (оба байтовых лимита после
слияния). Существующая семантика per-sandbox бизнес-квоты сохранена: проверка
до записи, а импорт проверяется строго после слияния. Ровно лимит разрешён
при импорте/сохранении; следующая предварительная проверка откажет.
Превышение глобального бюджета или байтового лимита импорта возвращает
HTTP **400**, `errorCode: 400`, `kind: 'bytes'`, `used`, `limit`, `sandbox` и
`code: 'sandbox_state_budget_exceeded'` / `'sandbox_state_quota_exceeded'`.
В ядре это исключения `SANDBOX_STATE_BUDGET_EXCEEDED` / `SANDBOX_QUOTA_BYTES`;
адаптеры отображают их через `sendSandboxStateQuotaError(res, error)`.
Отклонённое состояние восстанавливается на месте из последнего принятого JSON,
не пишется на диск, соседние песочницы не меняются.

**Квота per-sandbox ≠ память контейнера.** 64 МиБ ограничивают накопление
JSON-состояния (~8 заполненных по 8 МиБ песочниц), оставляя часть `mem_limit: 128m`
под процесс. Это не гарантия RSS: JS-объекты, снимки отката, временные строки,
правила/история/журнал и очереди исполнения имеют дополнительные расходы.
Дочернее состояние остаётся volatile и в байтовый бюджет не входит.
Восстановление существующих файлов при старте не отбрасывает данные ради квоты;
после восстановления превышение блокирует следующие записи, пока оператор
не уменьшит состояние, не сбросит/удалит песочницы или не поднимет бюджет.
Для жёсткой защиты памяти сохраняйте контейнерный лимит и подбирайте бюджет
по измеренному RSS конкретного адаптера; `0` годится только для доверенного стенда.

## Как добавить нового провайдера (спека §2)

1. Новый каталог в `services/<provider>-mock` с `server.js` на ядре.
2. В адаптере — только декларация протокола: маршруты, схемы, коды ошибок,
   машина состояний, тестовые реквизиты. Ошибки — через `createErrorCatalog`
   (код + поле + подсказка + ссылка на официальную доку).
3. Журнал входящих запросов — `createJournal` + `GET /admin/journal`.
4. HTML-страницы (админка, чеки) — только через `escapeHtml`.
5. Selftest по образцу существующих: поднять сервер на эфемерном порту,
   прогнать все сценарии контракта end-to-end, включая негативные и
   «рестарт с `MOCK_STATE_FILE`». Флаки-тесты (`sleep`-ожидания, фиксированные
   порты) не принимаются — см. `CONTRIBUTING.md`.
