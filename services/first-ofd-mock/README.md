© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# first-ofd-mock — облачная касса OKassa (Первый ОФД)

Третий внешний касса-адаптер Stage 2 (issue #92, «добор kassa/OFD»), восьмой
сервис стенда. Реализован по локальным срезам
[OKassa API](../../docs/reference/first-ofd/01-okassa-api.md) и
[тестового стенда/расхождений](../../docs/reference/first-ofd/02-test-and-open-issues.md)
(срез 2026-10-11): тестовый контур `external-api-farm.1-ofd-test.ru`,
`getToken` → `Authorization: Bearer`, **асинхронная очередь заявок на чек**
`POST /api/external/queue/v1/transaction/{type}` → `requestId`, статусы
`IN_PROGRESS`/`COMPLETED`/`ERROR`.

Это **не Ferma (`kassa-mock`) и не АТОЛ**: другой транспорт, другая модель
(очередь заявок, а не синхронный вызов), операции записаны как `INCOME`,
`INCOME_RETURN`, `EXPENCE`, `EXPENCE_RETURN`. Тег ATOL Online V5 из тестового
swagger Первого ОФД (`/api/external/possystem/v5/…`) — отдельный API и вне
области адаптера.

## Быстрый старт

```bash
npm run start:first-ofd    # http://localhost:3107
# или общий локальный стенд:
docker compose up -d first-ofd-mock
```

Node ≥ 18, zero npm dependencies. Синтетические дефолты —
`firstofdmocktest` / `11111111-2222-4333-8444-555555555555`; это **не** реквизиты
Первого ОФД: публичных тестовых login/API-key UUID у провайдера нет, они
выдаются в тестовом ЛК. Фактические env-значения при запуске скрыты в логах
(`<задан через env, скрыт>`). Реальные тестовые креды не помещайте в код, тесты,
fixtures или общий compose-файл.

## Поддерживаемый поток OKassa

| Маршрут | Назначение |
| --- | --- |
| `POST /getToken` | авторизация: `Content-Type: application/json; charset=utf-8`, тело `{login, pass}` → `{token}`; `pass` — API-ключ UUID, bearer-токеном не является |
| `POST /api/external/queue/v1/transaction/{type}` | поставить заявку в очередь → `requestId`; `type` ∈ `receipt`, `receiptCorrection`, `openShift`, `closeShift`, `currentStateReport` |
| `GET /api/external/queue/v1/transaction/{requestId}` | полная заявка (тело как принято) + `result` |
| `GET /api/external/queue/v1/status/{requestId}` | текущий статус и результат (метод сверки после callback) |
| `GET /api/external/queue/v1/statuses?externalId=&groupId=` | заявки по внешнему ID и группе; `externalId` и `groupId` обязательны, `status` — необязательный фильтр |
| `GET /api/external/receipts?from=&to=` | фискальные документы за период (фильтры `transactionType`, `groupId`, `kkmRegId`, `page`, `pageSize`) |
| `GET /health`, `GET /openapi.json` | healthcheck и OpenAPI 3.1 |
| `GET /admin`, `GET /admin/journal`, `POST /admin/action` | консоль заявок/групп/callback и журнала; действия защищены same-origin + CSRF |
| `/mock/time`, `/mock/scenarios`, `/mock/state`, `/mock/reset` | виртуальные часы, сценарии/хаос и состояние песочницы |
| `/sandboxes*`, `/mock/sandboxes` | RFC-001 sandbox/control-plane API |

Схема тела **строго по типу заявки**: `receipt` → `ReceiptRequest`,
`receiptCorrection` → `ReceiptCorrectionRequest` (+ обязательный
`document.correctionCause`), `openShift`/`closeShift`/`currentStateReport` →
`StateCommandRequest`. Receipt-тело (`document` с `operationType`/`items`/
`totalSum`) в командах смены отклоняется — «универсальный» объект из схем разных
провайдеров не собирается. Состав обязательных полей `StateCommandRequest`
публично не раскрыт `[VERIFY]`: мок требует документированный
`requestMetadata.userGroup`.

## Авторизация и токен

`POST /getToken` принимает JSON с `login` и `pass` (API-ключ UUID из ЛК
«Облачные кассы → Интеграции → Ключи к Кассовому API»). Успех — `{token}` +
заголовки `X-Mock-Token-TTL-Secs`/`X-Mock-Token-Expires-At`; ошибки —
`invalid_credentials` (401) или `invalid_request` (400). Дальше запросы несут
`Authorization: Bearer <token>`.

Токен живёт **86400** секунд (24 часа) на **виртуальных часах**:
`POST /mock/time {"advance":"+25h"}` делает прежний токен невалидным, новый
`getToken` — снова рабочим. Повторная выдача по умолчанию не аннулирует прежний
токен (срез об этом молчит — `[VERIFY]`); режим `MOCK_FIRST_OFD_TOKEN_SINGLE=1`
включает аннулирование, чтобы проверить и такое поведение.

**Квирк примера PDF.** Под заголовком успешного ответа `getToken` в PDF приведён
объект `error` с кодом `0` и текстом «Неверный логин и пароль» (расхождение №4
среза): по HTTP 200 нельзя однозначно судить об успехе. Мок не угадывает
семантику — дефолтный успех отдаёт только `{token}`, а документированный квирк
воспроизводится сценарием `getToken-error-quirk`.

## Очередь, статусы и деньги

`POST transaction/{type}` возвращает `requestId` — **не финальный фискальный
результат**: заявка сначала `IN_PROGRESS`, затем `COMPLETED` или `ERROR`
(в моке обработка занимает `MOCK_FIRST_OFD_PROCESS_MS`, по умолчанию 2000 мс
виртуальных часов). Объект результата несёт `requestId`, `transactionType`,
`errorCode`, `errorType`, `details`, `payload`; `pending`-поля равны `null`.

Ошибки двух слоёв сохраняются раздельно: `errorType=API` — слой API очереди,
`errorType=KKT` — слой ККТ/фискального накопителя. Таблица значений публично не
зафиксирована, поэтому каталоги `KKT_ERROR_CODES`/`API_ERROR_CODES` — явный
`[FORK]` мока.

Денежные значения (`price`, `totalSum`, `vatSums`, `ecashSums`) — **десятичные
рубли** (`150.00`), не копейки; внутри стенд считает в целых копейках. Операции
`INCOME`/`INCOME_RETURN`/`EXPENCE`/`EXPENCE_RETURN` и ставки НДС включая
`VAT_22`/`VAT_22122` — как в схеме; написание `EXPENCE` мок не «исправляет», а
вариант `EXPENSE` отклоняет с подсказкой. Правила сверки `totalSum` с позициями
срез не описывает — это вне области, мок лишь предупреждает в логе.

## Callback

Если в `requestMetadata.callbackUrl` передан URL (или задан
`MOCK_FIRST_OFD_CALLBACK_URL` — fallback мока `[FORK]`), после обработки заявки
уходит `POST` с JSON-телом результата плюс `externalId`/`userGroup`.

**Публичный срез не закрепляет ни envelope, ни подпись, ни обязательный ACK, ни
расписание повторов** — мок не выдумывает HMAC/RSA: подписи нет вовсе. Тело
уведомления, условие «любой 2xx = доставлено» и график повторов
`MOCK_FIRST_OFD_CALLBACK_RETRY_MS` × `MOCK_FIRST_OFD_CALLBACK_MAX_ATTEMPTS`
(дефолт 3 × 60 с) — локальная договорённость стенда `[FORK]`, а не утверждение о
протоколе Первого ОФД. Приёмник должен быть идемпотентным, результат
подтверждается методом статуса. Расхождение по схеме URL (`http://` в PDF против
`https://` в примерах) по умолчанию не разрешается в чью-то пользу: принимаются
обе схемы, строгий HTTPS включается `MOCK_FIRST_OFD_CALLBACK_HTTPS_ONLY=1`.
Приватный `callbackUrl` при `MOCK_BLOCK_PRIVATE_WEBHOOKS` даёт терминальный
`SSRF_BLOCKED` без повторов.

## Идемпотентность и `externalId`

`externalId` — внешний идентификатор вызывающей стороны. Правила дедупликации и
срок хранения публично **не подтверждены** `[VERIFY]`. Мок фиксирует
детерминированное поведение: повтор с тем же `externalId` в той же группе
создаёт **новую** заявку со своим `requestId` (ответ помечается
`X-Mock-Duplicate-External-Id: 1`), обе находятся через `statuses`. Для сверки
сохраняйте выданный `requestId` — это ключ к статусу и фискальному документу.

## Сценарии, часы и диагностика

`X-Mock-Scenario`/`/mock/scenarios` поддерживают `fail` (HTTP 500 на вызове),
`hang`, `latency`, `http-500`/`http-504`, `kkt-error` и `api-error` (завершение
заявки ошибкой слоя ККТ/API), `getToken-error-quirk`, `webhook-drop`/
`no-callback`, `webhook-duplicate`/`callback-duplicate`. Естественные правила
стенда возвращают `SHIFT_ALREADY_OPEN`/`SHIFT_NOT_OPEN` при повторном
открытии/закрытии смены (правила ККТ-слоя срезом не описаны — `[FORK]`).
`POST /mock/time` принимает `{"advance":"+5s"}` (обработка очереди),
`{"advance":"+25h"}` (истечение токена) и `{"advance":"+60s"}` (retry callback).
Сценарии, история, токены, журнал и состояние изолируются по `X-Mock-Sandbox`.
Журнал redacts чувствительные поля; в hosted-режиме SSRF-проверка исходящих
callback включена по умолчанию.

В `owned`-модели (`MOCK_HOSTED=1`) доступ к своей песочнице даёт owner-token
(`X-Sandbox-Token`). Наблюдаемое ограничение стенда `[VERIFY]`: если в одном
запросе есть и `Authorization: Bearer <токен очереди>`, и `X-Sandbox-Token`, ядро
(RFC-001) читает owner-token из `Authorization` и отвечает 401 «знание ID не
является доступом» — поведение общее для Bearer-адаптеров, воспроизводится и на
`vtb-mock`. Для локальных сценариев внутри одной песочницы используйте
`namespaces` (self-hosted дефолт) или `MOCK_TENANCY=off`.

## Переменные окружения

| Переменная | Default | Назначение |
| --- | --- | --- |
| `MOCK_HOST` / `MOCK_PORT` | `0.0.0.0` / `3107` | адрес и порт HTTP-сервера |
| `MOCK_FIRST_OFD_LOGIN` | `firstofdmocktest` | синтетический `login` организации |
| `MOCK_FIRST_OFD_PASS` | `11111111-2222-4333-8444-555555555555` | синтетический API-ключ UUID (`pass`) |
| `MOCK_FIRST_OFD_TOKEN_TTL_SECS` | `86400` | срок токена в секундах (24 ч); поддерживает длительность (`24h`); TTL живёт на виртуальных часах |
| `MOCK_FIRST_OFD_TOKEN_SINGLE` | `false` | `true` — повторный `getToken` аннулирует прежние токены (`[VERIFY]`-режим среза) |
| `MOCK_FIRST_OFD_PROCESS_MS` | `2000` | задержка обработки заявки в очереди на виртуальных часах; поддерживает длительность (`1h`), `0` разрешён |
| `MOCK_FIRST_OFD_PUBLIC_BASE_URL` | `http://localhost:${MOCK_FIRST_OFD_HOST_PORT:-3107}` | внешний base URL стенда (журнал, sandbox URL) |
| `MOCK_FIRST_OFD_CALLBACK_URL` | пусто | fallback callback URL, когда заявка не передала `requestMetadata.callbackUrl` (`[FORK]` мока) |
| `MOCK_FIRST_OFD_CALLBACK_RETRY_MS` | `60000` (`60s`) | интервал retry; число в миллисекундах либо длительность (`60s`, `1m`) |
| `MOCK_FIRST_OFD_CALLBACK_MAX_ATTEMPTS` | `3` | максимум доставок; значение меньше 1 нормализуется в 1 |
| `MOCK_FIRST_OFD_CALLBACK_HTTPS_ONLY` | `false` | `true` — отклонять `http://` в `callbackUrl` (строгое чтение PDF; расхождение №3 среза) |
| `MOCK_FIRST_OFD_USER_GROUPS` | `MOCKGROUP,firstofd-mock` | синтетический каталог `requestMetadata.userGroup`; `*` отключает проверку группы |
| `MOCK_STATE_FILE` | пусто | сохранение доменного состояния/очереди между рестартами |
| `MOCK_SANDBOX_FILE` | `<MOCK_STATE_FILE>.sandboxes.json` | база RFC-001 реестра песочниц |
| `MOCK_SANDBOX_SWEEP_MS` | `60000` | интервал sweep TTL/retention, когда worker включён |
| `MOCK_BLOCK_PRIVATE_WEBHOOKS` | `false` (hosted → `true`) | запрет исходящих callback в private/reserved адреса; SSRF-отказ терминален |
| `MOCK_VIRTUAL_CLOCK` | текущее время | начальное значение виртуальных часов |
| `MOCK_ADMIN_TOKEN` / `MOCK_OPERATOR_TOKEN` | пусто | защита управляющих `/admin*` и `/mock/*` |
| `MOCK_HOSTED` | `false` | `true` включает hosted fail-closed для управляющих поверхностей и default SSRF-защиту |
| `MOCK_TENANCY` | авто | sandbox-модель RFC-001 (`off`, `namespaces`, `owned`) |
| `MOCK_SANDBOX_TOKEN` | пусто | owner-token default sandbox в `owned`-модели |
| `MOCK_SANDBOX_TTL_MS` / `MOCK_SANDBOX_MAX` | `owned: 24h` / `owned: 100` | аренда и число песочниц |
| `MOCK_SANDBOX_MAX_DOCUMENTS` | `owned: 5000` | квота заявок + документов + callback-записей на sandbox |
| `MOCK_SANDBOX_RETENTION_MS` | `0` | retention терминальных callback-записей; заявки и документы не удаляются |
| `MOCK_SANDBOX_HOST_SUFFIX` | пусто | опциональный hostname-формат sandbox URL |
| `MOCK_SANDBOX_CREATE_LIMIT` | `owned: 20` | rate-limit создания sandbox на IP |

## Протокольные файлы и тесты

- Манифест drift-проверки: [`protocols/first-ofd-okassa.json`](../../protocols/first-ofd-okassa.json).
- OpenAPI: [`docs/openapi/first-ofd-mock.openapi.json`](../../docs/openapi/first-ofd-mock.openapi.json), также `GET /openapi.json`.
- Selftest (getToken/TTL, очередь и оба слоя ошибок, смены, `statuses`/`receipts`, callback без подписи, SSRF, RFC-001): `npm run test:first-ofd`.
- Гайд «за 10 минут»: [`docs/integration/first-ofd.md`](../../docs/integration/first-ofd.md).
- Ограничения безопасности общие с проектом: [`SECURITY.md`](../../SECURITY.md).
