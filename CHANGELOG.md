© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версии — [SemVer](https://semver.org/lang/ru/).

## [Unreleased]

### Added
- **Второй внешний банк-адаптер: Альфа-Банк интернет-эквайринг REST (Stage 2, #41).**
  - `services/alfa-mock` — независимый zero-dep мок REST-интерфейса шлюза
    Альфа-Банка (платформа RBS, тестовый контур `alfa.rbsuat.com/payment/rest`)
    на :3104: `POST /payment/rest/{register,registerPreAuth,deposit,reverse,refund,
    getOrderStatus,getOrderStatusExtended}.do` с `application/x-www-form-urlencoded`
    (креды `userName`/`password` в каждом запросе, суммы в копейках, уникальный
    `orderNumber`), ответ регистрации `{orderId, formUrl}`, платёжная страница
    `/payment/{orderId}` с официальными тестовыми картами (3DS1/3DS2
    challenge+frictionless, МИР 18 цифр, отказы `-2011` PaRes=U и `116`
    недостаточно средств) и тестовым ACS (пароль `12345678`, Fail/неверные
    срок-CVV-пароль → `71015`); дефолты — **синтетические** креды
    `ALFAMOCKTEST`/`mockpass123` по образцу TBANKMOCKTEST (реальные тестовые
    креды банк выдаёт индивидуально — в конфиг не зашиваются), печатаются в
    стартовом логе;
  - машина состояний `orderStatus 0…6` (общая нумерация платформы RBS —
    документированная интерпретация): двухстадийная схема `registerPreAuth` →
    холд (1) → `deposit` ≤ авторизованной суммы (частичное подтверждение
    допустимо) → 2; `reverse` из 1/2 → 3; полный/частичный `refund` из 2/4 → 4
    с накоплением `refundedAmount`; отказ карты/истечение `sessionTimeoutSecs`
    → 6 с `actionCode`; `getOrderStatusExtended.do` различает состояние, суммы
    авторизации/списания/возврата и код шлюза; `errorCode=0` — результат
    API-вызова, не факт оплаты (DX-hint в ответе регистрации и в гайде);
  - **callback — HTTP GET с query-параметрами** (`mdOrder`, `orderNumber`,
    `operation` — `approved`/`deposited`/`reversed`/`refunded`/`declinedByTimeout`/
    `declinedCardpresent`, `status` 1/0, `amount`, `callbackCreationDate`) через
    core-очередь: **ACK ровно HTTP 200** (204 — неуспех), ретраи
    (`MOCK_CALLBACK_RETRY_MS` × `MOCK_CALLBACK_MAX_ATTEMPTS` — mock-конфиг: PDF
    параметры повторов не задаёт), `webhook-drop`/`webhook-duplicate`, повтор
    кнопкой в `/admin`; **симметричный checksum HMAC-SHA256**: без
    `checksum`/`sign_alias`, имена параметров алфавитно, строка `name;value;…;`,
    hex в верхнем регистре; режим без checksum (`MOCK_CALLBACK_CHECKSUM=false`)
    эмулирует оговорку PDF — неподписанное уведомление можно подделать, сверка
    через REST;
  - ошибки в форме шлюза `{errorCode, errorMessage}` (классическая таблица RBS
    1—6; протокольные ошибки с HTTP 200, инфраструктурные — с честными
    404/405/413/500/504) + DX-слой мока (`field`/`hint`/`doc`); негативы: чужие
    креды (2), повтор `orderNumber` (1), неизвестный заказ (3), операции не в
    том статусе (4), `deposit` > холда и `refund` > списанного, дробные копейки,
    битый `returnUrl`/`jsonParams`, валюта ≠ 643 (5);
  - слои ядра переиспользованы по паттерну yookassa/atol: сценарный реестр
    (`fail`/`hang`/`webhook-*`/`latency`/`http-500|504` + `/mock/scenarios`),
    виртуальные часы (`/mock/time`: истечение `sessionTimeoutSecs` →
    `declinedByTimeout`, ретраи callback), журнал `/payment/rest` с curl
    (form-urlencoded) и редакцией секретов/PII — форма не журналируется, PAN не
    хранится (только маска `first6**last4`, F-10), control-plane токены, sandbox
    runtime RFC-001 (собственные `userName`/`password`/`callbackSecret`
    песочницы), флаги контура `MOCK_TWO_STAGE`/`MOCK_PARTIAL_REFUND`/
    `MOCK_SSL_PERMITTED`;
  - ядро расширено **аддитивно**: `createDeliveryQueue`/`postJson` поддержали
    исходящий `GET` без тела (`request(entry).method`) — для GET-callback
    Альфа-Банка; POST-доставка существующих адаптеров не изменилась (core
    selftest 41 → **42**: регресс GET-доставки);
  - контракт описан декларативно: манифест `protocols/alfa-eacq.json` и OpenAPI
    3.1 `docs/openapi/alfa-mock.openapi.json` (`GET /openapi.json`),
    `scripts/check-protocol-drift.js` дополнен четвёртой секцией
    (221 → **316** инвариантов: маршруты и методы `*.do`, статусы, операции
    callback, тестовые карты, коды ошибок и `actionCode`, инварианты «GET +
    HMAC-SHA256 uppercase», «ACK ровно 200», «асимметричный режим вне области»,
    «синтетические креды», оговорки конспекта в гайде);
  - `selftest.js` (**287** проверок) включён в `npm test` (`test:alfa`), CI-шаг
    и прогон внутри образа; compose: сервис `alfa-mock :3104` с healthcheck в
    обоих compose-файлах, black-box сценарий (секция 6) в
    `scripts/compose-selftest.js` (43 → **65** проверок), `start:alfa`, `smoke`
    и `EXPOSE 3104` в Dockerfile; документация: `services/alfa-mock/README.md`,
    гайд `docs/integration/alfa.md`, обновлён корневой README;
  - **вне области #41**: асимметричный checksum (официальный PDF противоречив:
    описание — SHA-256, примеры Java/PHP — SHA-512; режим подтверждается банком,
    не домысливается), привязки карт (`bindingId`), моделирование `orderBundle`,
    `paymentOrder.do` и различия координат r-/i-логинов; таблицы `orderStatus` и
    `errorCode` в альфа-конспекте не зафиксированы — взяты общие таблицы
    платформы RBS с явной пометкой в README («Границы и форки») и отчёте PR;
  - контракты `tbank-mock`, `kassa-mock`, `yookassa-mock` и `atol-mock` не
    менялись (selftest: 48 / 129 / 227 / 202).
- **Первый внешний касса-адаптер: АТОЛ Онлайн direct API v4 (Stage 2, #34).**
  - `services/atol-mock` — независимый zero-dep мок прямого API АТОЛ Онлайн версии v4
    (ФФД 1.05) на :3103: `POST /possystem/v4/getToken` (`{login, pass}` → токен,
    TTL **24 часа**, далее **заголовок** `Token`), `POST /possystem/v4/{group}/{operation}`
    для шести операций (`sell`, `sell_refund`, `sell_correction`, `buy`, `buy_refund`,
    `buy_correction`), `GET /possystem/v4/{group}/report/{uuid}`
    (`wait → done|fail`, `payload` с ФД/ФП, ФН/ККТ, сменой, НДС и `ofd_receipt_url`),
    страница чека `/receipts/{uuid}`; дефолты — публичные тестовые реквизиты v4
    (login `v4-online-atol-ru`, группа `v4-online-atol-ru_4179`);
  - **идемпотентность `external_id` в пределах группы**: повтор возвращает ранее
    назначенный UUID и заголовок `X-Mock-Replayed` (второй чек не создаётся) —
    ключевое отличие от Ferma, где дубль даёт `error.code=12`;
  - **callback результата** на `service.callback_url`: тот же объект, что и `report`,
    через core-очередь (ретраи/дамп, SSRF-guard), `webhook-drop|no-callback`,
    `webhook-duplicate`, повтор кнопкой в `/admin`; ACK — любой 2xx, подпись не
    добавляется (в публичных руководствах v4 ни ACK, ни подпись, ни расписание
    повторов не заданы — задокументированный форк, приёмник обязан быть идемпотентным);
  - ошибки в форме v4 `{error:{code, text, type, error_id}}` + DX-слой мока
    (`field`/`hint`/`doc`); валидация реквизитов ФФД 1.05 (`client` — хотя бы email
    или телефон, `company` — email/ИНН/адрес расчётов, ставки НДС, формы расчёта
    по ФФД 1081, арифметика `sum`/`total`/`payments`, `timestamp` `dd.mm.yyyy HH:MM:SS`);
    суммы — **decimal-рубли** (≤2 знака), количество — до 3 знаков;
  - мок ловит перенос синтаксиса Ferma и объясняет его в `hint`: `vat20_120` → «в v4
    это `vat120`», `payments[].type = 5` → «в v4 наличные — `0`», `?token=` → «в v4
    токен передаётся заголовком `Token`»;
  - слои ядра переиспользованы по паттерну yookassa-mock: сценарный реестр
    (`fail`/`hang`/`webhook-*`/`latency`/`http-500|504` + `/mock/scenarios`),
    виртуальные часы (`/mock/time`: печать очереди и истечение токена через 24 ч),
    журнал `/possystem/v4` с curl и редакцией секретов/PII, control-plane токены,
    sandbox runtime RFC-001 (собственные login/pass/группа песочницы);
  - контракт описан декларативно: манифест `protocols/atol-online.json`
    и OpenAPI 3.1 `docs/openapi/atol-mock.openapi.json` (`GET /openapi.json`),
    `scripts/check-protocol-drift.js` дополнен третьей секцией
    (142 → **221** инвариант: маршруты, операции, ставки НДС, формы расчёта, СНО,
    статусы отчёта, поля payload, коды ошибок, инварианты «заголовок Token»,
    «TTL 24 ч», «дедуп возвращает прежний uuid», рекомендации polling в гайде);
  - `selftest.js` (**202** проверки) включён в `npm test` (`test:atol`), CI-шаг
    и прогон внутри образа; compose: сервис `atol-mock :3103` с healthcheck
    в обоих compose-файлах, black-box сценарий в `scripts/compose-selftest.js`
    (43 проверки), `start:atol`, `smoke` и `EXPOSE 3103` в Dockerfile;
    документация: `services/atol-mock/README.md`, гайд `docs/integration/atol.md`,
    обновлён корневой README;
  - **вне области #34**: v5/ФФД 1.2 и маркировка «Честный ЗНАК» (следующий шаг);
    числовая таблица кодов v4 в конспекте не снята — взята общая таблица кодов
    платформы АТОЛ/Ferma с явной пометкой в README и отчёте PR;
  - контракты `tbank-mock`, `kassa-mock` и `yookassa-mock` не менялись
    (selftest: 48 / 129 / 227).
- **Первый внешний банк-адаптер: ЮKassa end-to-end (Stage 2, #33).**
  - `services/yookassa-mock` — независимый zero-dep мок мерчантского API ЮKassa на :3102:
    REST `/v3` (Basic Auth `shopId:secretKey`, обязательный `Idempotence-Key` для POST с replay
    сохранённого ответа и отказом на конфликте ключа), `POST /v3/payments`,
    `GET /v3/payments[/{id}]`, `POST .../capture` (в т.ч. частичный) и `.../cancel`,
    `POST /v3/refunds`, `GET /v3/refunds[/{id}]`, списки `{type:"list", items, next_cursor}`;
    статусы `pending → waiting_for_capture → succeeded | canceled`, `test:true`,
    decimal-строки сумм, только `RUB`;
  - ошибки в официальном формате ЮKassa `{type:"error", id, code, description, parameter}`
    + DX-слой мока `hint`/`doc` (официальные тексты для Idempotence-Key и 404 `payment_id`;
    форк по решению координатора: `405`/`415` — пустое тело, как в response-handling);
  - confirmation-страница `/payment/{id}` с тестовыми картами из `03-testing.md`
    (успех/3DS/11 отказов), честные `cancellation_details` по официальной таблице
    declined-payments (`merchant|yoo_money|payment_network`), минимизация PAN (F-10);
  - вебхуки `{type:"notification", event, object}` без подписи (`payment.succeeded`,
    `payment.waiting_for_capture`, `payment.canceled`, `refund.succeeded`) через
    core-очередь: ACK ровно HTTP 200, ретраи/дамп, `webhook-drop|no-webhook`,
    `webhook-duplicate`; mock-расширение `metadata.webhook_url`;
  - слои ядра переиспользованы по паттерну tbank-mock: сценарный реестр
    (`fail`/`hang`/`latency`/`http-500|504` + `/mock/scenarios`), виртуальные часы
    (`/mock/time`, авто-истечение холда 7 дней → `expired_on_capture`, TTL pending),
    журнал `/v3` с curl и редакцией секретов, control-plane токены, sandbox runtime
    RFC-001 (собственные Basic-креды песочницы);
  - `selftest.js` (227 проверок) включён в `npm test` (`test:yookassa`), CI-шаг,
    compose: сервис `yookassa-mock :3102` с healthcheck в обоих compose-файлах,
    black-box сценарий в `scripts/compose-selftest.js`; документация:
    `services/yookassa-mock/README.md`, гайд `docs/integration/yookassa.md`,
    обновлены корневой README, Dockerfile и старт-скрипты.
  - контракты `tbank-mock` и `kassa-mock` не менялись; `/mock/verify-merchant`
    для ЮKassa не реализован (вебхуки без подписи, ветка ядра не применима —
    вопрос координатору вынесен в отчёт PR).
- **Изоляция песочниц: request-local контекст и hosted tenancy за env-флагом (#8, RFC-001, A-21, F-11—F-15).**
  - ядро `createSandboxRuntime`: контекст песочницы разрешается на каждый запрос ровно один раз
    (`X-Mock-Sandbox` → `?sandbox=` → поддомен при `MOCK_SANDBOX_HOST_SUFFIX`) и резолвится
    через `AsyncLocalStorage` — параллельные A/B-запросы не смешивают `state`, креды и
    `persist` между `await`, а запрос без селектора не остаётся в предыдущей песочнице (F-11);
  - режимы аренды `MOCK_TENANCY=off|namespaces|owned` (`MOCK_HOSTED=1` включает `owned`):
    у песочницы собственные креды терминала/Ferma и `ownerToken`, показываемый один раз;
    знание id без токена доступа не даёт — 401, чужой снимок состояния не читается (F-12);
  - API `POST /sandboxes`, `GET /sandboxes` (алиас `/mock/sandboxes`), `/sandboxes/me`
    (инфо, `reset`, `reset-creds`, удаление); `/mock/state` и `/mock/reset` принимают явный
    target и не переключают активную песочницу (F-13);
  - lifecycle (F-14): реестр песочниц пишется атомарно в `<MOCK_STATE_FILE>.sandboxes.json`
    (owner-токены — только хэши), TTL + sweep-воркер, лимит количества, запрет relabel
    чужого state как `default`;
  - квоты (F-15): `MOCK_SANDBOX_MAX_DOCUMENTS` и retention per sandbox, счётчики документов
    учитывают растущие коллекции; ссылочные индексы `OrderId`/`DealId` убирают полное
    сканирование истории на hot paths (Init/GetState/CheckOrder, баланс сделки) и
    пересобираются при загрузке файла/импорте снимка — старый state-файл без индексов
    обслуживается корректно; compose-selftest выполняется в одноразовой песочнице и
    убирает её за собой в `finally` — повторные прогоны не накапливают данные (F-33);
  - env песочниц (`MOCK_TENANCY`, `MOCK_SANDBOX_TOKEN`, TTL/лимиты) прокинуты в
    `docker-compose.include.yml`, копирайт-шапки §3 добавлены в тронутые `*.md`.
  - новые маршруты описаны в OpenAPI 3.1 и манифестах протоколов (дрейф 142/142).
- **Остаток minor-аудита #37: DX-проверки и docker-инструменты (F-35/F-38).**
  - `npm run check:links` — относительные ссылки markdown-документации обязаны
    разрешаться в существующие файлы (входит в `npm test` и CI);
  - `npm run test:docker` (`scripts/docker-smoke.js`) — image smoke: tbank-mock и
    kassa-mock становятся `healthy` со стандартным HEALTHCHECK образа (в т.ч. без
    переменных окружения), процессы идут от UID 10001, persist/restore переживает
    `--read-only` rootfs с volume `/data`;
  - `scripts/docker-healthcheck.js` — healthcheck образа сам перебирает известные
    пары сервисов (`3100/health`, `3101/healthz`, `3102/health`, `3103/health`);
  - канонический каталог документации адаптера зафиксирован как
    `docs/reference/<provider>/` — с примером шаблона в CONTRIBUTING.md.
- **Пакет подготовки к глубокому аудиту (#43, docs-only).**
  - [`docs/audit/AUDIT-PREP-2026-10-12.md`](docs/audit/AUDIT-PREP-2026-10-12.md) — карта
    покрытия всех top-level артефактов репо (с чем и на какой базе каждый проверялся),
    8 находок прогона с `файл:строка` (в т.ч. обход SSRF-гарда через нормализованный
    IPv4-mapped `[::ffff:7f00:1]` и 48-битная энтропия id песочницы) и **6 партий**
    глубокого аудита с рамками, вопросами, критериями приёмки и оценками;
  - [`docs/audit/CHECKLIST-audit-party.md`](docs/audit/CHECKLIST-audit-party.md) —
    чек-лист «как запускать аудит-партию»: область → критерии → формат находок →
    фиксация в реестр;
  - [`AGENTS.md`](AGENTS.md) — правила работы ИИ-агентов (zero-dependency, обязательные
    прогоны `npm test`/`check:drift`/`check:links`/`test:compose`, SPDX и стандартные
    шапки, правило «env в пяти местах», обязательный `Closes #N` в описании PR,
    запреты и специфичные для проекта ловушки);
  - [`docs/briefs/CLAUDE-2026-10-12-agent-brief.md`](docs/briefs/CLAUDE-2026-10-12-agent-brief.md) —
    §0.1: статусы MS-01…MS-40 по фактическому коду, все `[VERIFY]` подтверждены или
    опровергнуты с `файл:строка`; исправлены устаревшие формулировки (MS-01, MS-08,
    MS-11, MS-13, MS-19, MS-20, MS-26, MS-29, MS-33, MS-34, MS-38), сводка рисков (§7)
    и предлагаемая очередь волн (§9);
  - поведение сервисов, тесты, compose и CI не менялись.

### Fixed
- **Протокольная точность Мультирасчётов: Init recipient и CancelPayment (#25, F-16—F-23).**
  - `Init` в профиле `multisplit` требует `PaymentRecipientId` (≤16 символов) до создания платежа; `plain` не меняется.
  - `/e2c/v2/Init` валидирует общие поля (`OrderId`, `Amount`, `DealId`, `PaymentRecipientId`), ровно один канал выплаты (карта / СБП `Phone`+`SbpMemberId` / партнёр `PartnerId`) и сохраняет нормализованный канал; неполная выплата в state не попадает.
  - `/e2c/v2/CancelPayment` отменяет только `CONFIRMED`-выплату партнёру в открытой сделке, требует `DealId` и сверяет его с выплатой, проверяет `TerminalKey` до поиска; статусы `CREDIT_CANCELING` → `CREDIT_CANCELED`; при отказе выплата не меняется.
- **Остаток major-аудита #36 (F-05/F-06/F-24/F-26/F-27/F-34).** Виртуальные часы валидируют диапазон `Date` до записи state; chaos `http-500/http-504` согласован с core в T-Bank и Ferma и покрыт black-box selftest; денежные поля T-Bank разбираются строгим parser без prefix/trailing junk и дробей; acqapi проверяет Basic credentials, opaque Bearer с TTL и auth на POST/GET/PATCH; регистрация требует документированную схему и маппит `shopArticleId` в `shopCode`; root compose по умолчанию bind-ится на loopback с явным per-service override.
- **Minor-аудит #37 (F-25/F-28/F-29/F-30).**
  - `RedirectDueDate` в Init проверяет обе границы документированного диапазона
    «1 минута … 90 дней» (включительно): истёкшая дата и срок короче минуты
    отклоняются кодом 7, ISO-parsing сохранён (F-25);
  - multibyte `Token` той же JS-длины, что и digest, больше не роняет маршрут в
    общий `5000`: сравнение подписи идёт по байтовым длинам, любая ошибка формата
    — это код 13 (F-28);
  - нотификации Т-Банка уходят последовательно (`awaitSequential`): статусы одного
    платежа не могут прийти не по порядку даже при медленном приёмнике, наложение
    тиков доставки защищено в ядре, порядок и отсутствие повторов закреплены
    тестами (F-29);
  - денежные поля kassa-mock (`price`/`quantity`/`sum`/`total`/`pay.sum`) и
    произведение `price × quantity` ограничены безопасными целыми
    (`Number.isSafeInteger`, ≤ 2^53−1 копеек) — overflow отклоняется кодом 4 до
    создания документа, включая dry-run `/validate` и возвраты (F-30).

### Security
- **Изоляция сценариев, истории и журнала по песочницам (#52, PA-51, PG-04, PG-09, PB-13 — ядро и все 5 сервисов). Осознанное изменение поведения:** реестр сценариев (`createScenarioRegistry`) и журнал (`createJournal`) больше не являются process-global — правила, история срабатываний (как и раньше, последние 200) и записи журнала живут в разделе **записи текущей песочницы** во всех пяти адаптерах (`tbank-mock`, `kassa-mock`, `yookassa-mock`, `atol-mock`, `alfa-mock`, включая реплику PG-04 в alfa). Правило арендатора A не срабатывает на трафике B, история и журнал A не содержат идентификаторов B, `DELETE /mock/scenarios` и `POST /mock/reset` очищают только целевую песочницу (PG-09/PB-13). Введён cap **200 правил на песочницу** и лимит **8 KiB на правило** (сериализованный JSON, UTF-8 байты; проверка на create и update по `id`): превышение отклоняется существующим путём валидации как HTTP 400 с машиночитаемым `code` (`rule_cap_exceeded` / `rule_too_large`) и сообщением с лимитом и фактическим значением, без изменения состояния и без новых статусов у адаптеров. Разделы volatile (только память), привязаны к записи песочницы: удаление/TTL-истечение уносит их без сирот, пересоздание с тем же `id` начинается пустым, на диск ничего не пишется (персист дочернего состояния — вне области, #53). Lone-sandbox режим (`default` без селектора) ведёт себя как раньше.
- **Закрыт остаточный SSRF-контур исходящих вебхуков и DNS TOCTOU (#51, PF-01, PA-58, PA-25, PA-26, PG-11 / §7.3 — ядро и все 5 сервисов).**
  - **PF-01 (`kassa-mock`):** дефолт `MOCK_BLOCK_PRIVATE_WEBHOOKS` в `services/kassa-mock/server.js` выровнен с остальными четырьмя адаптерами (`''` вместо `'false'`), поэтому при `MOCK_HOSTED=1` SSRF-гард в `kassa-mock` включается по умолчанию (`block_private_webhooks=true`).
  - **PA-58 (`@mock-services/core`):** `createDeliveryQueue` и `verifyMerchantWebhook` по умолчанию используют `defaultBlockPrivateHosts()` (`flagEnabled(MOCK_BLOCK_PRIVATE_WEBHOOKS, flagEnabled(MOCK_HOSTED, false))`), согласуя поведение ядра с адаптерами.
  - **PA-25 (`@mock-services/core`):** в `postJson` сняты квадратные скобки вокруг IPv6-литералов в `target.hostname` перед передачей в сокет и DNS-резолвер (при сохранении скобок в заголовке `Host`), устраняя ложный `getaddrinfo ENOTFOUND [::1]` и цикл ретраев.
  - **PA-26 (`@mock-services/core`):** `isPrivateIPv4` / `isPrivateIPv6` блокируют спецдиапазоны RFC 5737 TEST-NET-1/2/3 (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, включая IPv4-mapped и NAT64), IPv6 multicast `ff00::/8` (RFC 4291), документационный префикс `2001:db8::/32` (RFC 3849) и локальный NAT64 `64:ff9b:1::/48` (включая `64:ff9b:1::/96`, RFC 8215).
  - **§7.3 / PG-11 (DNS TOCTOU):** `resolvePublicHost` выполняет единственное разрешение имени с проверкой всех записей и передаёт проверенный адрес в `lookup`-хук `http.request`/`https.request` (с fail-closed проверкой при перехвате `dns.lookup`), исключая обход гарда через DNS rebinding между проверкой и `connect()`.
- **Авторизация target песочницы и fail-closed при TTL-sweep во время `await` (#50, PA-50, PA-54—PA-56, PG-03, PG-10; все 5 сервисов).** В `createSandboxRuntime` операции с явным target (`exportState`, `importState`, `reset`, `updateCreds`, `remove`) проверяют, что вызывающий — оператор либо владелец именно целевой песочницы; автосоздание чужой песочницы через `importState`/`reset` закрыто. Все пять адаптеров (`tbank-mock`, `kassa-mock`, `yookassa-mock`, `atol-mock`, `alfa-mock`) передают контекст запроса для авторизации управляющих маршрутов. Контекст песочницы закреплён на всё время запроса: истечение TTL или удаление записи во время `await` завершает запрос `410 Gone` (`SANDBOX_EXPIRED`) без отката к глобальному `activeId` или чтения состояния другого арендатора. Политики `public`/`form` в owned-режиме fail-closed: `public` не раскрывает защищённое состояние, а `form` ограничен capability-путями и не открывает защищённую `default` в обход `MOCK_SANDBOX_TOKEN`; `switchActive` не меняет песочницу параллельных запросов без селектора, а `run()` не исполняется при неуспешном admission.
- **SSRF-обход через IPv4-mapped и NAT64 закрыт (#45, MS-09 — ядро).** `isPrivateAddress`
  снимал `::ffff:` и разбирал остаток только как dotted-IPv4, поэтому
  `new URL('http://[::ffff:127.0.0.1]/')` (hostname `[::ffff:7f00:1]`), адреса
  `::ffff:a9fe:a9fe` и `64:ff9b::7f00:1` (NAT64) проходили `assertPublicHost` как публичные.
  Теперь IPv6 приводится к 8 группам до классификации: IPv4-mapped решается по встроенному
  IPv4 в обеих формах, `::ffff:0:0/96` (4-частная SIIT-форма) блокируется целиком,
  `64:ff9b::/96` (NAT64) решается по встроенному IPv4. Побочно: имена из hex-символов без
  двоеточия (`dead`, `cafe`, `bee`) раньше считались публичным IPv6 и не проверялись через DNS.
  Регресс-тесты в `packages/core/selftest.js`. TOCTOU (lookup внутри подключения) не
  закрыт — остаётся в MS-09.
- **Редакция секретов в журналах и минимизация PAN (#24, F-09/F-10).** В ядро
  добавлен слой редакции: ключи-секреты (`Authorization`, `Cookie`, `token`,
  `pass`/`password`, `CVV`, `CardData`, `PAN`, `signature`, `login`) заменяются на
  `[REDACTED]` рекурсивно, PII (ИНН, телефон, e-mail, ФИО) маскируются частично,
  любая строка сканируется на PAN (13–19 цифр, префикс платёжной системы,
  контрольная сумма Luhn) и на `Basic`/`Bearer`-токены. Журнал `/admin/journal`
  обоих сервисов больше не хранит сырые заголовки (вместо них — allowlist
  `Content-Type`/`Content-Length`/`User-Agent`/`X-Mock-*`) и сырые креды
  `getToken`; длина полей и всей записи ограничена. Выплата `/e2c/v2/Init` не
  сохраняет полный PAN: остаются маска и тип сценария, снимки состояния прежних
  версий вычищаются при загрузке; тестовый кейс `5000000000000553` → `1057`
  работает без хранения номера карты.
- **Access-control управляющей поверхности (#22, F-07).** Управляющие и
  служебные маршруты обоих сервисов закрыты токенами: `/mock/*`, смены ККТ,
  ресурс ФН, режим/очередь ОФД и чтение спора `GET /v2/Dispute/{id}` —
  `MOCK_OPERATOR_TOKEN` (fallback — `MOCK_ADMIN_TOKEN`), `/admin*` — `MOCK_ADMIN_TOKEN`.
  Токены принимаются в `Authorization: Bearer`, `X-Operator-Token`/`X-Admin-Token`
  или query-параметре и сравниваются constant-time. Новый режим `MOCK_HOSTED=1`
  закрывает управляющую поверхность без настроенного секрета (fail-closed);
  локальный дефолт без токенов не изменился.
- **SSRF-политика исходящих вебхуков (#22, F-08).** `MOCK_BLOCK_PRIVATE_WEBHOOKS`
  теперь включает guard и при значении `1` (не только `true`), а `MOCK_HOSTED=1`
  включает его по умолчанию; защита действует и в очереди доставки, и в
  `/mock/verify-merchant`. Проверка усилена: приватные IPv4/IPv6-литералы,
  служебные имена и имена, которые резолвятся в приватные адреса, запрещены схемы
  кроме http/https; редиректы не отслеживаются.
- **Docker-образ: непривилегированный запуск и воспроизводимость (#37, F-35—F-37).**
  HEALTHCHECK согласован с обоими сервисами (kassa слушает `/healthz`) и без
  переменных сам находит известные health-пути; контейнеры работают от
  непривилегированного `mock:mock` (UID/GID 10001) с единственным записываемым
  каталогом `/data` (named volume наследует права; persist/restore проверен при
  `--read-only` rootfs); базовый образ `node:22-alpine` и релизный
  `ghcr.io/rucorp/mock-services:0.5.0` закреплены дайджестами — обновление
  security patches идёт только контролируемым bump (процесс в CONTRIBUTING.md).

## [0.5.0] — 2026-10-11

### Added
- **Блок 1 — Активный экзаменатор, мульти-песочницы, хаос и `curl` (`packages/core`, оба сервиса)**:
  - мульти-песочницы для параллельных CI-воркеров (`X-Mock-Sandbox: <id>`, `?sandbox=<id>`, `GET/POST/DELETE /mock/sandboxes`, `POST /mock/reset`, `GET/POST /mock/state`) с сохранением ссылочной целостности `state`;
  - активный экзаменатор вебхук-приёмника интегратора (`POST /mock/verify-merchant`): проверяет приём валидного вебхука (`200 OK`), идемпотентность при повторной доставке и отклонение поддельного `Token`;
  - инъекция сетевых задержек и сбоев (`X-Mock-Latency: 500ms`, `X-Mock-Scenario: latency:1s | http-500 | http-504`);
  - автоматическая генерация готовых `curl`-сниппетов для каждого запроса в `/admin/journal` и UI `/admin`.
- **Блок 2 — Полное покрытие протокола Т-Банка (`tbank-mock`)**:
  - **Мультирасчёты Wave 2**: `/v2/createSpDeal`, `/v2/closeSpDeal`, строгий контроль баланса сделки при выплатах `/e2c/v2/Init` и `/e2c/v2/Payment` (приходы − возвраты − чарджбэки − выплаты), автозакрытие сделки по `FinalPayout: true` с фиксацией `PlatformReward`, запрет возврата покупателю по закрытой сделке (`ErrorCode: "32"`), отмена выплаты `/e2c/v2/CancelPayment`, справочник банков СБП `/e2c/v2/GetSbpMembers`, тестовая карта ошибки выплаты `5000000000000553` → `REJECTED` с `ErrorCode: "1057"`;
  - **Регистрация партнёров `acqapi`**: `POST /oauth/token`, `POST /sm-register/register`, `GET /sm-register/register/shop/:shopCode`, `PATCH /sm-register/register/:shopCode` с валидацией `billingDescriptor` (≤14 символов латиницей) и ИНН;
  - **СБП QR и закрывающие чеки**: `/v2/GetQr` (`PAYLOAD` и `IMAGE` SVG, проверка минимальной суммы 1000 коп. = 10 ₽), `POST /payment/:id/sbp-pay`, `/v2/SendClosingReceipt`;
  - **Рекуррентные платежи и карты**: `Init` с `Recurrent=Y` и `CustomerKey`, выдача `RebillId` в вебхуке `AUTHORIZED`, автосписание `/v2/Charge`, управление покупателями и картами (`/v2/AddCustomer`, `GetCustomer`, `RemoveCustomer`, `AddCard`, `GetCardList`, `RemoveCard`), проверка лимитов `DATA` (≤20 пар, ключ ≤20, значение ≤100) и `RedirectDueDate` (≤90 дней).
- **Блок 3 — Полное покрытие 54-ФЗ и ККТ (`kassa-mock`)**:
  - **Смены ККТ и Z-отчёты**: `GET /possystem/v1/shift/status`, `POST /possystem/v1/shift/open`, `POST /possystem/v1/shift/close` (формирование Z-отчёта с итогами смены), контроль 24-часового лимита смены по ст. 4.3 54-ФЗ с виртуальными часами (`код 62`);
  - **Ресурс Фискального Накопителя (ФН)**: `GET/POST /possystem/v1/fn/state`, симуляция переполнения ФН (`код 63`) и замены/сброса ФН (`reset: true`);
  - **Позиционный контроль возвратов**: проверка остатка количества по каждой позиции чека (`receipt.items[i].quantity`) относительно исходного чека `origin_external_id`;
  - **Dry-run валидация**: `POST /possystem/v1/validate` (проверка структуры, сумм и ставок НДС без фискализации и без расхода ФД/ФН).
- **Блок 4 — OpenAPI 3.1 и детектор дрейфа протоколов (`docs/openapi/*`, `protocols/*`, `scripts/check-protocol-drift.js`)**:
  - спецификации OpenAPI 3.1.0 (`docs/openapi/tbank-mock.openapi.json`, `docs/openapi/kassa-mock.openapi.json`) и встроенный маршрут `GET /openapi.json` на обоих сервисах;
  - декларативные манифесты протоколов (`protocols/tbank-eacq.json`, `protocols/ferma-ofd.json`) и скрипт `npm run check:drift` (134 инварианта контракта).

## [0.4.0] — 2026-10-11

### Added
- **Внешний мок-контур для платформ (`docker-compose.include.yml` + GHCR + `docs/integration/lovii.md`)**:
  - `docker-compose.include.yml` с профилем `mock`, фиксированными именами `tbank-mock`/`kassa-mock`, лимитами памяти (`128m`), healthcheck-ами и параметризуемыми Caddy-лейблами (`MOCK_TBANK_CADDY_DOMAIN`, `MOCK_KASSA_CADDY_DOMAIN`);
  - пошаговая инструкция миграции `lovii-core` и полная матрица переменных окружения `dev / staging / prod` в `docs/integration/lovii.md`;
  - публикация образа `ghcr.io/rucorp/mock-services` (теги `:0.4.0`, `:latest`, `:sha-*`) и прогон selftest-ов против собранного образа и compose-стенда в `.github/workflows/ci.yml` + `scripts/compose-selftest.js` (`npm run test:compose`).
- **Полнота 54-ФЗ (этап 6, `kassa-mock`)**:
  - операции `buy`, `buy_refund`, `buy_correction` (наряду с `sell`, `sell_refund`, `sell_correction`) как для агентской, так и для неагентской схемы;
  - двухчековая схема авансов и зачётов (`full_prepayment` / `partial_prepayment` / `advance` → `full_payment` / `consideration`) со связкой по `prepayment_external_id` и контролем остатка аванса; связка возвратов по `origin_external_id` с контролем остатка суммы;
  - все ставки НДС по 54-ФЗ, включая расчётные ставки предоплаты (`vat5_105`, `vat7_107`, `vat10_110`, `vat20_120`, `vat22_122`) и расчёт `vat_amounts` в фискальном снимке;
  - маркировка («Честный ЗНАК», ФФД 1.2): `marking_code` / `nomenclature_code`, `mark_quantity` (дробная маркировка), `measure_unit`, обязательность КМ для `marked_commodity` / `marked_excise`, сценарий отказа `mark-fail` (код 58);
  - очередь ОФД и статусы `ofd_status: pending | sent | rejected`, маршруты `GET /possystem/v1/ofd/queue` и `POST /possystem/v1/ofd/mode`, сценарии `ofd-queue` и `ofd-reject`;
  - валидация `payment_object`, `agent_info.type`, ИНН поставщика (`supplier_info.inn` — 10/12 цифр) и `correction_info`.
- **Сценарное API и виртуальные часы (этап 7, `packages/core`, `tbank-mock`, `kassa-mock`)**:
  - `createVirtualClock` (`MOCK_VIRTUAL_CLOCK`) и HTTP API `GET/POST/PUT /mock/time` (`advance: "7d"`, `"60d"`, `"36h"`, `reset: true`) для мгновенной проверки авто-подтверждения холда (7 дней), авто-отмены заказа/сделки (60 дней), истечения 3DS (36 часов) и TTL токена кассы (12 часов);
  - `createScenarioRegistry` и HTTP API `GET/POST/DELETE /mock/scenarios` + расширенный заголовок `X-Mock-Scenario`: `chargeback-after:Nd`, `partial-refund:<sum|%>`, `webhook-drop` («вебхук не пришёл»), `webhook-duplicate`.
- **Чарджбэк-сценарий банка end-to-end (`tbank-mock`, T-024)**:
  - полная машина состояний спора `DISPUTED` (`CHARGEBACK` / `PARTIAL_CHARGEBACK`) → `REPRESENTMENT` → `ARBITRATION` (`ARB`) → `WON` / `LOST` через `POST /v2/Chargeback` (и `/v2/Dispute`), `GET /v2/Dispute/:id` и кнопки в `/admin`, с подписанными `Token` вебхуками и пересчётом баланса сделки;
  - опциональная защита `/admin*` токеном `MOCK_ADMIN_TOKEN` (A-20) и покрытие `/e2c/v2/*`, `/av/v1/*` в selftest (A-22).

### Fixed
- `services/kassa-mock/selftest.js`: гарантированная остановка дочернего процесса кассы перед `process.exit` (исключён `EADDRINUSE` на повторных локальных прогонах, A-22).

## [0.3.0] — 2026-10-08

### Added
- `MOCK_PROFILE=plain|multisplit` (tbank): провайдеро-нейтральный дефолт — классический эквайринг без сделок; профиль Lovii (Мультирасчеты) включается явно.
- `X-Mock-Scenario: fail|hang` (kassa): универсальный драйвер негативов заголовком запроса — для CI и внешних интеграторов.
- selftest: plain-флоу Init→pay→Confirm без SpAccumulationId (tbank №25); сценарии через заголовок (kassa 12b).

### Fixed
- selftest кассы: обязательный `sum` позиции для валидатора; тайминги печати 1200→2200 мс (гонка с секундным тиком).

## [0.2.0] — 2026-10-08

Аудит 2026-10-08 (`docs/audit/AUDIT-2026-10-08.md`) нашёл 24 дефекта; в этой
версии закрыты критичные и высокие (A-1…A-19), добавлены CI/Docker и
community-файлы.

### Исправлено — ядро

- **Потеря вебхуков после рестарта.** `createStore.restore()` подменял вложенные
  объекты состояния, а очередь держала ссылку на старый объект: недоставленные
  нотификации/колбэки исчезали навсегда. Теперь состояние сливается «на месте»
  (`mergeInto`), идентичность объектов сохраняется. (A-2)
- **Дубли вебхуков.** Тик очереди не ждал отправку: при медленном вебхуке одна
  нотификация уходила параллельными POST-ами (в замере — 16 запросов вместо 4).
  Добавлен guard «в полёте». (A-3)
- **Ложная переотправка после рестарта.** `nextAttemptAt = Infinity`
  сериализовался в `null` и запись считалась «пора слать снова»; терминальный
  статус теперь — флаг `done`. (A-4)
- Ошибка `request(entry)` в очереди больше не роняет тик; `persist()` вызывается
  в `finally`. (A-3)

### Добавлено — ядро

- `escapeHtml()` — экранирование данных интегратора на HTML-страницах. (A-14)
- `createJournal()` — журнал входящих запросов (последние N: метод, путь,
  ключевые поля, код, время). (A-19)
- `isPrivateHost()` + `blockPrivateHosts` в очереди — опциональная защита
  исходящих вебхуков от SSRF (`MOCK_BLOCK_PRIVATE_WEBHOOKS=1`). (A-18)
- `packages/core/selftest.js` — self-test ядра, подключён в `npm test`. (A-22)

### Исправлено — `tbank-mock`

- Короткий/битый `Token` отвечал «внутренняя ошибка 5000» (RangeError в
  `timingSafeEqual`) — теперь код 13. (A-5)
- Повторный `Init` с существующим `OrderId` создавал вторую сессию — теперь
  ошибка 7 (дока Init: `OrderId` уникален); выключается
  `MOCK_ALLOW_DUPLICATE_ORDER_ID=true`. (A-6)
- `Cancel` с `Amount` больше суммы платежа молча выполнял **полный** возврат с
  `Success: true` — теперь ошибка 7 с доступной суммой. (A-7)
- «Операция недоступна в статусе» отдаётся кодом 32, а не 8. (A-8)
- `GetState` принимает `OrderId` (и `PaymentId`). (A-9)
- Проверка `TerminalKey` во всех `/v2/*` (чужой терминал → ошибка 7). (A-15)
- Экранирование значений в `/admin` и на платёжной форме. (A-14)

### Исправлено — `kassa-mock`

- Чек с нарушенными инвариантами (суммы позиций/оплат/итога, неизвестные
  `vat.type`/`payment_method`/`payments[].type`) принимался — добавлен валидатор
  с DX-ошибкой (код 4 + `field` + `hint`); отключается
  `MOCK_VALIDATE_RECEIPTS=false`. (A-1)
- `MOCK_PROCESS_MS=0` превращался в 4 с (`parseInt(x) || 4000`) — теперь честный
  ноль; дефолт приведён к 15 с. (A-10)
- Токен авторизации (заявленный TTL 12 ч) не истекал никогда — добавлен TTL
  (`MOCK_TOKEN_TTL_MS`), истёкший токен → ошибка 11. (A-11)
- `receipt_datetime` в каждом чеке был `1970-01-01` (снимок до `processedAt`) —
  исправлен порядок. (A-12)
- `fiscal_receipt_number` совпадал у чеков, созданных до печати, — номер
  присваивается при печати и уникален в смене. (A-13)
- XSS в `/receipts/:uuid` и `/admin` (названия позиций, `external_id`) —
  экранирование. (A-14)
- Группа кассы не валидировалась — `MOCK_GROUPS=Main,Shop-1` отклоняет опечатку. (A-16)
- Лента чека печатала жёстко зашитый бренд и «НДС: без НДС» — шапка
  настраивается (`MOCK_AGENT_LINE`, `MOCK_AGENT_INN`), НДС считается по ставкам
  позиций (в т.ч. 5/7/22 %). (A-17)
- Добавлены журнал запросов (`/admin/journal`) и кнопка повторной отправки
  callback. (A-19)

### Тесты

- Т-Банк: +7 регресс-сценариев; касса: +11, включая вторую фазу с рестартом
  стенда на `MOCK_STATE_FILE` и проверкой TTL; ядро: 8 проверок.
- Selftest кассы больше не использует фиксированные порты во второй фазе. (A-22)

### Инфраструктура и документация

- CI (`.github/workflows/ci.yml`): Node 18/20/22 + сборка образа и smoke-тест compose. (A-23)
- `Dockerfile`, `.dockerignore`, healthcheck и volume состояния в `docker-compose.yml`. (A-23)
- `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, аудит `docs/audit/AUDIT-2026-10-08.md`. (A-24)
- README/интеграции обновлены под новое поведение; исправлены расхождения
  («13/13» → фактическое число, дефолт `MOCK_PROCESS_MS`). (A-24)

### Совместимость

- `MOCK_STATE_FILE` прошлых версий читается; доставленные ранее нотификации без
  флага `done` могут быть отправлены ещё раз однократно после обновления — если
  это нежелательно, очистите файл состояния.
- Уникальность `OrderId` и проверка `TerminalKey` теперь включены по умолчанию —
  интеграции, которые нарушали эти правила, начнут получать ошибку 7 (как в бою).

## [0.1.0] — 2026-10-08

- Стартовый пакет: спека `docs/canon/MOCK_SERVICES_SPEC.md`, карточки SZ-095/SZ-096, референсы провайдеров.
- Адаптеры `tbank-mock` (Init/Confirm/Cancel/GetState/CheckOrder, нотификации, платёжная форма, `/e2c`, `/av`) и `kassa-mock` (Ferma: getToken/sell/sell_refund/report/stats, callback с ретраями).
- Ядро `packages/core`: состояние, очередь вебхуков, http-хелперы, каталог ошибок.
- Selftest-ы, `docker-compose.yml`, инструкции интеграций.
