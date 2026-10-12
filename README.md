© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# mock-services — тестовые моки банков и касс по официальным протоколам

Открытый сервис, который имитирует **банк-эквайринг** и **облачную кассу/ОФД**
по их официальным протоколам, чтобы любой участник рынка (магазин, платформа,
интегратор) тестировал свою платёжную и фискальную интеграцию **до договора с
провайдером** — с честными схемами, кодами ошибок, сценариями отказов и
внятными подсказками «что не так в запросе и как это чинить».

> Статус: **alpha (0.5.0)**. Репозиторий готовится к публикации:
> см. [аудит](docs/audit/AUDIT-2026-10-08.md) и [дорожную карту](#дорожную-карту).
> Сегодня поддерживается: эквайринг Т-Банка (обычный + Мультирасчеты Wave 2, СБП QR, рекурренты `RebillId`/`Charge`, регистрация партнёров `acqapi`, чарджбэки e2e,
> выплаты e2c, верификация AV), облачная касса OFD Ferma (полная матрица 54-ФЗ:
> `sell`/`buy` + возвраты и коррекции с позиционным контролем, авансы/зачёты, маркировка Честный ЗНАК,
> очередь ОФД, смены ККТ 24ч + Z-отчёты, ресурс ФН, dry-run валидация), **ЮKassa**
> (REST `/v3`: Basic Auth + `Idempotence-Key`, two-stage с частичным capture, возвраты,
> confirmation-страница с тестовыми картами, вебхуки без подписи с ACK 200)
> и **АТОЛ Онлайн direct API v4** (ФФД 1.05: `getToken` с токеном на 24 ч в заголовке `Token`,
> шесть операций фискализации, идемпотентность `external_id` в пределах группы —
> повтор возвращает прежний UUID, отчёт `wait → done|fail` с ФД/ФП и `ofd_receipt_url`,
> callback результата, decimal-рубли), **Альфа-Банк интернет-эквайринг REST**
> (`/payment/rest/*.do` form-urlencoded: `register`/`registerPreAuth` → `formUrl`
> с тестовыми картами и ACS 3DS1/3DS2, `deposit` ≤ холда, `reverse`, полный/частичный
> `refund`, `getOrderStatus(Extended)` с суммами авторизации/списания/возврата,
> callback **HTTP GET** с симметричным checksum HMAC-SHA256 и ACK ровно 200,
> `orderStatus 0…6`, `sessionTimeoutSecs` → `declinedByTimeout`), а также мульти-песочницы (`X-Mock-Sandbox`), активный экзаменатор вебхуков (`/mock/verify-merchant`), OpenAPI 3.1 (`/openapi.json`), детектор дрейфа протоколов (`npm run check:drift`) и report-only сверка ссылок первоисточников (`npm run check:upstream`).
> Обе модели следуют клиентскому контракту провайдера, но это не делает стенд
> совместимым с production автоматически: перед переключением проверьте
> конфигурацию, безопасность и условия интеграции; одной смены URL недостаточно.

## Зачем

1. Тестовые контуры банков/ОФД доступны только после договора — мок даёт
   рабочий протокол сразу.
2. Реальные шлюзы возвращают сухие коды — мок объясняет ошибку, указывает
   поле, даёт рекомендацию и ссылку на пункт документации.
3. Сценарии отказов (недостаток средств, таймаут, дубль вебхука, чарджбэк,
   отказ ККТ, недоступная касса) — переключателем, а не «ждём боевой инцидент».
4. Новые провайдеры добавляются адаптером-декларацией, без форка сервиса.
5. Журнал запросов (`/admin/journal`) показывает, **как мок понял ваш запрос**,
   и что он ответил.

## Быстрый старт

```bash
# 1. Стенд «банк + касса + ЮKassa + АТОЛ Онлайн + Альфа-Банк» целиком
docker compose up            # tbank-mock :3100, kassa-mock :3101, yookassa-mock :3102, atol-mock :3103, alfa-mock :3104

# Порты root compose по умолчанию слушают только 127.0.0.1.
# Для осознанного сетевого доступа задайте bind отдельно для нужного сервиса:
MOCK_TBANK_BIND_IP=0.0.0.0 MOCK_KASSA_BIND_IP=0.0.0.0 docker compose up
# Не используйте 0.0.0.0 на публичном хосте без operator/admin auth, firewall и TLS.

# 2. Без Docker (только Node >= 18, зависимостей нет)
npm run start:tbank          # http://localhost:3100
npm run start:kassa          # http://localhost:3101
npm run start:yookassa       # http://localhost:3102
npm run start:atol           # http://localhost:3103
npm run start:alfa           # http://localhost:3104

# 3. Проверить сам стенд
npm test                     # selftest ядра + всех адаптеров
```

Инструкции «интеграция за 10 минут»: [`docs/integration/tbank-eacq.md`](docs/integration/tbank-eacq.md)
(эквайринг), [`docs/integration/ferma-ofd.md`](docs/integration/ferma-ofd.md)
(касса/ОФД Ferma), [`docs/integration/yookassa.md`](docs/integration/yookassa.md)
(ЮKassa), [`docs/integration/atol.md`](docs/integration/atol.md)
(АТОЛ Онлайн v4), [`docs/integration/alfa.md`](docs/integration/alfa.md)
(Альфа-Банк REST) и [`docs/integration/lovii.md`](docs/integration/lovii.md)
(подключение как внешнего сервиса в платформу Lovii). Контракты и переменные окружения — в README каждого сервиса
(`services/tbank-mock`, `services/kassa-mock`, `services/yookassa-mock`, `services/atol-mock`, `services/alfa-mock`). Для acqapi Т-Банка тестовые Basic-креды по умолчанию `partner:partner`, а регистрация точки требует полной схемы реквизитов из `docs/reference/tbank/03-payouts-and-deals.md`. Дефолты alfa-mock (`ALFAMOCKTEST`/`mockpass123`) — синтетические креды мока, а не реквизиты банка: реальные тестовые креды Альфа-Банк выдаёт индивидуально.

## Структура

```text
packages/core/           — ядро: состояние (persist/restore), очередь вебхуков
                           с ретраями, http-хелперы, каталог ошибок, журнал,
                           виртуальные часы и реестр сценариев; без протоколов провайдеров
services/
  tbank-mock/            — адаптер «Т-Банк эквайринг/Мультирасчеты» (Init/Confirm/Cancel/Chargeback/…)
  kassa-mock/            — адаптер «ОФД Ferma» (getToken/sell/buy/refund/correction/report/ofd/…)
  yookassa-mock/         — адаптер «ЮKassa» (REST /v3: payments/capture/cancel/refunds, confirmation, вебхуки)
  atol-mock/             — адаптер «АТОЛ Онлайн direct API v4» (getToken/{group}/{operation}/report, callback, ФФД 1.05)
  alfa-mock/             — адаптер «Альфа-Банк интернет-эквайринг» (REST /payment/rest/*.do, formUrl + ACS, GET-callback с HMAC-SHA256)
scripts/
  compose-selftest.js    — black-box selftest против поднятого compose-стенда
docs/
  audit/                 — аудит 2026-10-08 и отчёты исполнения
  rfc/                   — проектные решения (RFC-001: изоляция песочниц)
  canon/                 — внутренние спеки и карточки проектов (источник истины)
  integration/           — инструкции «интеграция за 10 минут» + миграция Lovii
  reference/             — референсы и документация адаптеров: `docs/reference/<provider>/`
                           (канонический каталог доки провайдера, см. CONTRIBUTING.md)
.github/workflows/ci.yml — CI: selftest на Node 18/20/22 + compose-стенд + публикация GHCR
Dockerfile               — образ для всех сервисов (выбор командой)
docker-compose.include.yml — внешний compose-модуль (профиль mock) для интеграции в core
```

## Что уже умеет мок

| Возможность | tbank-mock | kassa-mock | yookassa-mock | atol-mock | alfa-mock |
|---|---|---|---| ---| ---|
| Протокол провайдера | `/v2/{Init,Confirm,Cancel,GetState,CheckOrder,Chargeback,Dispute}`, `/e2c/v2/*`, `/av/v1/*` | `/possystem/v1/{getToken,sell,sell_refund,sell_correction,buy,buy_refund,buy_correction,report,stats,ofd/*}` | REST `/v3/{payments,refunds}` + `capture`/`cancel`, confirmation `/payment/{id}`, списки `{type:"list"}` | `/possystem/v4/{getToken, {group}/{sell,sell_refund,sell_correction,buy,buy_refund,buy_correction}, {group}/report/{uuid}}`, decimal-рубли, страница чека `/receipts/{uuid}` | `/payment/rest/{register,registerPreAuth,deposit,reverse,refund,getOrderStatus,getOrderStatusExtended}.do` (form-urlencoded), платёжная страница `/payment/{orderId}` с ACS 3DS1/3DS2, суммы в копейках |
| Подпись/авторизация | Token = sha256 (как у банка), `TerminalKey` проверяется | `getToken` + TTL 12 ч | Basic Auth (`shopId:secretKey`) + обязательный `Idempotence-Key` на POST (replay того же ключа) | `getToken` → токен **в заголовке `Token`**, TTL **24 ч**; идемпотентность `external_id` **в пределах группы**: повтор возвращает прежний UUID (`X-Mock-Replayed`), а не ошибку | `userName`/`password` в каждом запросе (токенов нет; дефолты — **синтетические** `ALFAMOCKTEST`/`mockpass123`); `orderNumber` уникален в пределах магазина — повтор это `errorCode 1`, а не replay |
| Вебхуки | подписанные нотификации, ответ ровно `OK`, ретраи, дамп, `webhook-drop`/`webhook-duplicate` | callback по документу, ретраи до 2xx, повтор кнопкой, `webhook-drop` | `{type,event,object}` без подписи, ACK **ровно 200**, ретраи/дамп, `webhook-drop`/`webhook-duplicate` | callback результата на `service.callback_url` (тот же объект, что и `report`); ACK/подпись/повторы протоколом v4 не заданы — мок шлёт без подписи, приёмник идемпотентен; `webhook-drop`/`webhook-duplicate` | **HTTP GET** с query (`mdOrder`, `operation`, `status=1/0`, `amount`, `checksum`), симметричный HMAC-SHA256 (hex uppercase, строка `name;value;…;`), ACK **ровно 200**, ретраи (параметры PDF не задаёт — mock-конфиг), режим без checksum (`MOCK_CALLBACK_CHECKSUM=false` — сверка через REST); `webhook-drop`/`webhook-duplicate` |
| Машина состояний | NEW→…→AUTHORIZED/CONFIRMED/REVERSED/REFUNDED/CANCELED + чарджбэк DISPUTED→REPRESENTMENT→ARBITRATION→WON/LOST | ККТ: wait → done/fail; ОФД: pending → sent/rejected; связка авансов и возвратов | `pending → waiting_for_capture → succeeded/canceled`, two-stage + частичный capture, возвраты (`refunded_amount`), `cancellation_details` по официальной таблице, холд 7 дней | очередь ККТ: `wait → done\|fail`; `done` — `payload` с ФД/ФП, ФН/ККТ, сменой, НДС и `ofd_receipt_url`; `fail` — `error{code,text,type,error_id}` | `orderStatus 0…6`: регистрация → форма/ACS (5) → холд (1) или списание (2) → reverse (3) / полный и частичный refund (4) / отказ (6, `actionCode` -2011/116/71015); `sessionTimeoutSecs` → `declinedByTimeout`; `getOrderStatusExtended` различает суммы авторизации/списания/возврата |
| Негативные сценарии и часы | `X-Mock-Scenario` (`chargeback-after:7d`, `partial-refund`, `webhook-drop`), `/mock/scenarios`, `/mock/time` (`+7d`/`+60d`) | `X-Mock-Scenario` (`fail`, `hang`, `ofd-queue`, `ofd-reject`, `mark-fail`, `webhook-drop`), `/mock/time` | `X-Mock-Scenario` (`fail`, `hang`, `latency`, `http-500/504`, `webhook-drop`/`webhook-duplicate`), `/mock/scenarios`, `/mock/time` (истечение холда `expired_on_capture`) | `X-Mock-Scenario` (`fail`, `hang`, `webhook-drop`, `webhook-duplicate`, `latency`, `http-500/504`), префиксы `fail-`/`hang-`, `/mock/scenarios`, `/mock/time` (печать очереди, истечение токена через 24 ч) | `X-Mock-Scenario` (`fail`, `hang`, `webhook-drop`/`webhook-duplicate`, `latency`, `http-500/504`) на `*.do` и форме, `/mock/scenarios` (target `register`/`deposit`/`pay`/…), `/mock/time` (истечение `sessionTimeoutSecs` → `declinedByTimeout`, ретраи callback); отказные тестовые карты вместо префиксов |
| DX | ошибка = код + поле + подсказка + ссылка на официальную доку; OpenAPI 3.1 (`/openapi.json`); готовый `curl` в журнале | то же в формате Ferma (включая dry-run `/possystem/v1/validate`, валидацию 54-ФЗ, ставок НДС, ИНН, маркировки) | `{type:"error", id, code, description, parameter}` как у ЮKassa + `hint`/`doc`; официальные тексты (Idempotence-Key, 404 payment); `405`/`415` — пустое тело как в доке; `curl` в журнале | `{error:{code,text,type,error_id}}` как у платформы + `field`/`hint`/`doc`; ловит перенос синтаксиса Ferma (`vat20_120` → `vat120`, `type=5` → `0`, `?token=` → заголовок `Token`); OpenAPI 3.1; `curl` в журнале | `{errorCode,errorMessage}` как у шлюза RBS + `field`/`hint`/`doc`; напоминание «`errorCode=0` ≠ факт оплаты» в ответе регистрации; объяснение разницы схем (`deposit` на одностадийный заказ, `refund` на холд); OpenAPI 3.1; `curl` (form-urlencoded) в журнале |
| Песочницы и проверка интегратора | `X-Mock-Sandbox` (request-local, RFC-001), `POST /sandboxes` (hosted: owner-token, TTL, лимиты), `/sandboxes/me/*`, `/mock/sandboxes`, `/mock/reset`, `/mock/state`, активный экзаменатор `POST /mock/verify-merchant` | то же в формате Ferma: `X-Mock-Sandbox`, `POST /sandboxes` (креды и owner-token песочницы), `/sandboxes/me/*`, `/mock/sandboxes`, `/mock/reset`, `/mock/state`, `POST /mock/verify-merchant` | то же (без `verify-merchant`: вебхуки ЮKassa не подписаны, ветка ядра не применима — см. README сервиса «Границы») | то же: `X-Mock-Sandbox`, `POST /sandboxes` (собственные login/pass/группа АТОЛ и owner-token), `/sandboxes/me/*`, `/mock/sandboxes`, `/mock/reset`, `/mock/state` (без `verify-merchant`: callback v4 не подписан) | то же: `X-Mock-Sandbox`, `POST /sandboxes` (собственные `userName`/`password`/`callbackSecret` и owner-token), `/sandboxes/me/*`, `/mock/sandboxes`, `/mock/reset`, `/mock/state` (без `verify-merchant`: callback — GET query, экзаменатор ядра рассчитан на POST-JSON) |
| Наблюдаемость | `/admin` (+ журнал запросов с `curl`), `/health`; управляющая поверхность — под `MOCK_OPERATOR_TOKEN`, админка — под `MOCK_ADMIN_TOKEN` | `/admin` (+ журнал запросов с `curl`, очередь ОФД), `/healthz`, чек покупателю; смены/ФН/ОФД/`/mock/*` — под `MOCK_OPERATOR_TOKEN` | `/admin` (+ журнал `/v3` с `curl`, платежи/возвраты/очередь вебхуков), `/health`; токены — как в tbank | `/admin` (+ журнал `/possystem/v4` с `curl`, документы и очередь callback), `/health`, `/openapi.json`; токены — как в tbank | `/admin` (+ журнал `/payment/rest` с `curl`, заказы/суммы/`actionCode` и очередь callback; форма не журналируется — PAN не попадает в журнал), `/health`, `/openapi.json`; токены — как в tbank |

## Дорожная карта

| Этап | Что | Статус |
|---|---|---|
| 0–3 | спека, перенос моков в репо, ядро, DX-слой с каталогом ошибок | ✅ |
| 4 | **аудит и исправление критичных дефектов** (потеря вебхуков после рестарта, дубли нотификаций, фискальные данные, XSS, валидации денег) + CI/Docker | ✅ 0.2.0 |
| 5 | провайдеро-нейтральный дефолт: `MOCK_PROFILE=plain` (обычный эквайринг, дефолт), профиль Мультирасчетов — конфигом; `X-Mock-Scenario` (kassa) — негативы заголовком запроса | ✅ 0.3.0 |
| 6 | полнота 54-ФЗ: `buy`/`buy_refund`, авансы и зачёты, все ставки НДС (в т.ч. расчётные), очередь ОФД (`pending`/`sent`/`rejected`), маркировка («Честный ЗНАК») | ✅ 0.4.0 |
| 7 | сценарное API (`/mock/scenarios`, `X-Mock-Scenario`) + виртуальные часы (`/mock/time`, `MOCK_VIRTUAL_CLOCK`: тесты «через 7 дней», «через 60 дней») + чарджбэки e2e (`dispute→representment→arb`) + внешний compose/GHCR | ✅ 0.4.0 |
| 8 | мульти-песочницы ([RFC-001](docs/rfc/RFC-001-multi-tenant-sandboxes.md): `X-Mock-Sandbox`, `/mock/state`), активный экзаменатор вебхуков (`/mock/verify-merchant`), хаос (`X-Mock-Latency`), `curl`-сниппеты | ✅ 0.5.0 |
| 9 | Т-Банк Wave 2 + СБП QR + рекурренты + `acqapi`; Касса: смены ККТ (24ч/Z-отчёт), ресурс ФН, позиционный возврат, dry-run `/validate`; OpenAPI 3.1 (`/openapi.json`) + детектор дрейфа протоколов (`npm run check:drift`) | ✅ 0.5.0 |
| 10 | изоляция песочниц RFC-001 (A-21) за env-флагом: request-local контекст (F-11), hosted tenancy + owner-token (F-12), target в export/import (F-13), персистентность/TTL (F-14), квоты/retention (F-15), изоляция compose-селфтеста (F-33) | ✅ Unreleased |
| 11 | **Stage 2: первый внешний банк-адаптер — ЮKassa end-to-end** (#33): REST `/v3` (Basic Auth, `Idempotence-Key`, платежи/возвраты, two-stage + частичный capture), confirmation-страница с тестовыми картами и честными `cancellation_details`, вебхуки `{type,event,object}` без подписи (ACK 200, ретраи, дубли), сценарии/часы/журнал/песочницы через ядро; `test:yookassa` в `npm test`, compose + healthcheck :3102, гайд «за 10 минут» | ✅ Unreleased |

| 12 | **Stage 2: первый внешний касса-адаптер — АТОЛ Онлайн direct v4** (#34): `/possystem/v4/` (`getToken` с токеном на 24 ч в заголовке `Token`, шесть операций, отчёт `wait → done\|fail` с ФД/ФП и `ofd_receipt_url`, callback на `service.callback_url`), идемпотентность `external_id` в пределах группы (повтор возвращает прежний UUID — отличие от Ferma), валидация реквизитов ФФД 1.05 и decimal-рублей, сценарии/часы/журнал/песочницы через ядро; манифест `protocols/atol-online.json` и секция дрейф-чекера, `test:atol` в `npm test`, compose + healthcheck :3103, гайд «за 10 минут» | ✅ Unreleased |
| 13 | **Stage 2: второй внешний банк-адаптер — Альфа-Банк интернет-эквайринг REST** (#41): `/payment/rest/*.do` (form-urlencoded, `register`/`registerPreAuth` → `{orderId, formUrl}`, `deposit` ≤ холда, `reverse`, полный/частичный `refund`, `getOrderStatus(Extended)` с суммами авторизации/списания/возврата), платёжная страница с официальными тестовыми картами и ACS 3DS1/3DS2 (пароль `12345678`, отказы `-2011`/`116`/`71015`), callback **HTTP GET** с симметричным checksum HMAC-SHA256 и ACK ровно 200 (ретраи, дубли, режим без checksum — сверка через REST), `sessionTimeoutSecs` → `declinedByTimeout` на виртуальных часах, синтетические креды по образцу TBANKMOCKTEST; аддитивный GET в очереди доставки ядра, манифест `protocols/alfa-eacq.json` и секция дрейф-чекера, OpenAPI 3.1, `test:alfa` в `npm test`, compose + healthcheck :3104, гайд «за 10 минут». Асимметричный checksum вне области (PDF противоречив: SHA-256 vs SHA-512) | ✅ Unreleased |

Детали, оценки и приоритеты — в [аудите](docs/audit/AUDIT-2026-10-08.md) §9.

## Тестирование

```bash
npm test              # всё (core + tbank + kassa + yookassa + atol + alfa + offline upstream selftest + check:links + check:drift)
npm run test:core     # ядро (42 проверки): restore/очередь (POST и GET-доставка)/каталог ошибок/часы/сценарии/песочницы RFC-001/экзаменатор/access-control/SSRF/tenancy/CSRF
npm run test:tbank    # 48 сценариев контракта Т-Банка (вкл. E2C TerminalKey, CSRF, чарджбэки, СБП, рекурренты, изоляцию песочниц)
npm run test:kassa    # 141 проверка Ferma/54-ФЗ (вкл. tenancy, CSRF, owner-token admin, ОФД/ФН, изоляцию песочниц)
npm run test:yookassa # 227 проверок ЮKassa /v3 (вкл. идемпотентность, карты/3DS, вебхуки ACK 200 + ретраи/дубли, сценарии, /mock/time, рестарт, control-plane)
npm run test:atol     # 202 проверки АТОЛ Онлайн v4 (вкл. дедуп external_id, callback/ретраи/дубли, реквизиты ФФД 1.05, истечение токена 24 ч, песочницы, рестарт)
npm run test:alfa     # 287 проверок Альфа-Банк REST (вкл. register/preAuth/deposit/reverse/refund, карты 3DS1/3DS2 и отказы -2011/116/71015, GET-callback + HMAC-SHA256 + ACK ровно 200, sessionTimeoutSecs, песочницы owned, рестарт, control-plane)
npm run check:links   # относительные ссылки markdown-документации разрешаются (docs/providers упразднён — канон docs/reference)
npm run check:drift   # 316 инвариантов: сверка protocols/*.json <-> server.js <-> OpenAPI 3.1 <-> docs/reference
npm run test:upstream  # офлайн selftest синхронизатора snapshot
npm --silent run check:upstream -- --json # JSON-отчёт; без --silent npm печатает служебный баннер
npm run check:upstream -- --update # явное обновление snapshot после просмотра
npm run test:docker  # image smoke (нужен docker): tbank-mock и kassa-mock становятся healthy, непривилегированный UID, persist/restore при --read-only rootfs
npm run test:compose  # black-box selftest против контейнеров compose (:3100, :3101, :3102, :3103, :3104)
```

CI гоняет то же на Node 18/20/22 и проверяет, что compose-стенд поднимается. Отдельный weekly/ручной workflow сравнивает HTTP-отпечатки ссылок из `docs/reference/external-links.md` с `protocols/upstream-snapshot.json`; он только публикует отчёт, не создаёт issue и не ломает сборку при сетевых сбоях. Снимок изменяется только явной командой `npm run check:upstream -- --update` после просмотра отчёта. SPA-страницы и источник с обязательной авторизацией помечены `mode: "skip"` с причиной.

## Безопасность

Проект — **тестовый стенд**: все креды фейковые, платежи идут только по
тестовым картам, реальные данные использовать нельзя. `/admin` по умолчанию
без аутентификации (локальный DX) — перед публикацией стенда прочитайте
[`SECURITY.md`](SECURITY.md). Для публичного размещения задайте `MOCK_HOSTED=1`:
управляющая поверхность (`/mock/*`, смены/ФН/ОФД, чтение спора) закрывается
`MOCK_OPERATOR_TOKEN` (fail-closed, если токен не задан), админка — `MOCK_ADMIN_TOKEN`,
а исходящие вебхуки по умолчанию не ходят на приватные адреса. Арендаторы
изолированы по RFC-001: `POST /sandboxes` выдаёт песочницу с собственными кредами,
owner-token (знание id доступа не даёт), TTL и квотами — см.
[`docs/rfc/RFC-001-multi-tenant-sandboxes.md`](docs/rfc/RFC-001-multi-tenant-sandboxes.md).

## Участие

Issues и PR приветствуются: [`CONTRIBUTING.md`](CONTRIBUTING.md). Полезнее всего:
расхождения с официальной докой провайдера (со ссылкой на раздел), новые
сценарии отказов, новые адаптеры. Правила для ИИ-агентов — [`AGENTS.md`](AGENTS.md);
план доработок перед публикацией и статусы задач —
[`docs/briefs/CLAUDE-2026-10-12-agent-brief.md`](docs/briefs/CLAUDE-2026-10-12-agent-brief.md),
подготовка к глубокому аудиту — [`docs/audit/AUDIT-PREP-2026-10-12.md`](docs/audit/AUDIT-PREP-2026-10-12.md).

## Лицензия

Apache-2.0 (см. `LICENSE`, `NOTICE`). Протоколы провайдеров воспроизводятся
по их публичной документации; товарные знаки принадлежат их владельцам и
использованы только для обозначения совместимости.
