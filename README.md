© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).
SPDX-License-Identifier: Apache-2.0

# mock-services — тестовые моки банков и касс по официальным протоколам

Открытый сервис, который имитирует **банк-эквайринг** и **облачную кассу/ОФД**
по их официальным протоколам, чтобы любой участник рынка (магазин, платформа,
интегратор) тестировал свою платёжную и фискальную интеграцию **до договора с
провайдером** — с честными схемами, кодами ошибок, сценариями отказов и
внятными подсказками «что не так в запросе и как это чинить».

> Статус: **alpha (0.7.0)**. Репозиторий готовится к публикации:
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
> `orderStatus 0…6`, `sessionTimeoutSecs` → `declinedByTimeout`), **Сбербанк Ecom REST v1.1.11.1**
> (`/ecomm/gw/partner/api/v1/*.do` JSON: `register`/`registerPreAuth`, форма и ACS `111111`,
> `deposit`/`reverse`/`refund`/`decline`, `orderStatus 0…6`, callback без подписи —
> HTTP POST JSON с ACK ровно 200 и retry 3×60s; `paymentOrder.do` не включён без merchant-разрешения),
> **ВТБ SMB E-commerce API** (`/openapi/smb/efcp/e-commerce/v1/` JSON: OAuth 2.0
> `client_credentials` + `X-IBM-Client-Id`, `orders`/`preauth`/`complete`/`cancel`/`refunds`,
> `amount.value` — десятичные рубли, `status.value` ордера/операции раздельно, ордер живёт 20 минут,
> callback `{"type":"PAYMENT|REFUND","object":{…}}` без подписи с сохранением `Status`/`status` как есть;
> legacy RBS не используется), **Первый ОФД — облачная касса OKassa**
> (`/api/external/queue/v1/`: `getToken` `{login, pass}` → Bearer-токен на 24 ч, асинхронная очередь
> заявок `transaction/{type}` (`receipt`/`receiptCorrection`/`openShift`/`closeShift`/`currentStateReport`)
> → `requestId`, статусы `IN_PROGRESS → COMPLETED|ERROR` с раздельными слоями ошибок API/ККТ,
> операции `INCOME`/`INCOME_RETURN`/`EXPENCE`/`EXPENCE_RETURN` — написание как в схеме,
> `/receipts` за период, callback без подписи, сверка через `status/{requestId}`),
> **Контур.ОФД** (`kontur-ofd-mock` :3108: read/reconciliation, Sid + API key,
> организации/кассы/ФД, суммы в копейках; без создания чека и callback),
> **Такском** (`taxcom-mock` :3109: read-only кабинет/ОФД, API v2 —
> `POST /API/v2/Login` с `Integrator-ID` → `Session-Token` на 5 минут sliding,
> `AccountList`, `NewDocuments` за 10 суток с курсором по `id`, ошибки 3106/2203;
> write API не моделируется),
> а также мульти-песочницы (`X-Mock-Sandbox`), активный экзаменатор вебхуков (`/mock/verify-merchant`), OpenAPI 3.1 (`/openapi.json`), детектор дрейфа протоколов (`npm run check:drift`) и report-only сверка ссылок первоисточников (`npm run check:upstream`).
> Каждый адаптер следует клиентскому контракту своего провайдера, но это не делает стенд
> совместимым с production автоматически: перед переключением проверьте
> конфигурацию, безопасность и условия интеграции; одной смены URL недостаточно.

Для read-only адаптеров ОФД: Контур.ОФД — [рецепт интеграции](docs/integration/kontur-ofd.md)
и [README сервиса](services/kontur-ofd-mock/README.md); Такском —
[рецепт интеграции](docs/integration/taxcom.md) и
[README сервиса](services/taxcom-mock/README.md). Такском зарегистрирован в корневом
и внешнем compose (профиль `mock`); pinned GHCR-релиз новый адаптер ещё не содержит —
публикация образа и pin отдельным решением владельца.

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
# 1. Стенд «банк + касса + ЮKassa + АТОЛ Онлайн + Альфа-Банк + Сбер Ecom + ВТБ SMB + Первый ОФД + Такском» целиком
docker compose up            # tbank-mock :3100, kassa-mock :3101, yookassa-mock :3102, atol-mock :3103, alfa-mock :3104, sber-mock :3105, vtb-mock :3106, first-ofd-mock :3107, taxcom-mock :3109
# Контейнеры харденированы (MS-04): read-only rootfs, tmpfs /tmp, cap_drop ALL,
# no-new-privileges, pids_limit 256, init; запись — только в volume /data.

# Порты root compose по умолчанию слушают только 127.0.0.1.
# Для осознанного сетевого доступа задайте bind отдельно для нужного сервиса:
MOCK_TBANK_BIND_IP=0.0.0.0 MOCK_KASSA_BIND_IP=0.0.0.0 MOCK_SBER_BIND_IP=0.0.0.0 docker compose up
# Не используйте 0.0.0.0 на публичном хосте без operator/admin auth, firewall и TLS.

# 2. Без Docker (только Node >= 18, зависимостей нет)
npm run start:tbank          # http://localhost:3100
npm run start:kassa          # http://localhost:3101
npm run start:yookassa       # http://localhost:3102
npm run start:atol           # http://localhost:3103
npm run start:alfa           # http://localhost:3104
npm run start:sber           # http://localhost:3105
npm run start:vtb            # http://localhost:3106
npm run start:first-ofd      # http://localhost:3107
# Контур.ОФД (креды только env; compose — через include):
npm run start:kontur-ofd     # http://localhost:3108
# Такском (read-only кабинет/ОФД, синтетические креды в стартовом логе):
npm run start:taxcom         # http://localhost:3109

# 3. Проверить сам стенд
npm test                     # selftest ядра + всех адаптеров
```

### Стенд «банк + касса» одной командой (без клонирования репозитория)

`docker-compose.staging.yml` — самодостаточный стенд из двух сервисов
(tbank-mock :3100 `/health` + kassa-mock/Ferma :3101 `/healthz`) из опубликованного
образа GHCR, закреплённого дайджестом:

```bash
curl -fsSLO https://raw.githubusercontent.com/rucorp/mock-services/main/docker-compose.staging.yml
docker compose -f docker-compose.staging.yml up -d
```

Приложение подключается consumer-ски: URL API банка → `http://<хост>:3100/v2`,
URL кассы Ferma → `http://<хост>:3101/possystem/v1`; публичные URL платёжных
страниц/чеков задаются `MOCK_TBANK_PUBLIC_BASE_URL`/`MOCK_KASSA_PUBLIC_BASE_URL`.
По умолчанию порты слушают только `127.0.0.1`; для общего хоста задайте
`MOCK_OPERATOR_TOKEN`/`MOCK_ADMIN_TOKEN` **до** первого запуска и поднимите
TLS-прокси — см. [`SECURITY.md`](SECURITY.md).

Инструкции «интеграция за 10 минут»: [`docs/integration/tbank-eacq.md`](docs/integration/tbank-eacq.md)
(эквайринг), [`docs/integration/ferma-ofd.md`](docs/integration/ferma-ofd.md)
(касса/ОФД Ferma), [`docs/integration/yookassa.md`](docs/integration/yookassa.md)
(ЮKassa), [`docs/integration/atol.md`](docs/integration/atol.md)
(АТОЛ Онлайн v4), [`docs/integration/alfa.md`](docs/integration/alfa.md)
(Альфа-Банк REST), [`docs/integration/sber.md`](docs/integration/sber.md)
(Сбербанк Ecom REST), [`docs/integration/vtb.md`](docs/integration/vtb.md)
(ВТБ SMB E-commerce API), [`docs/integration/first-ofd.md`](docs/integration/first-ofd.md)
(Первый ОФД — облачная касса OKassa), [`docs/integration/kontur-ofd.md`](docs/integration/kontur-ofd.md)
(Контур.ОФД — read/reconciliation), [`docs/integration/taxcom.md`](docs/integration/taxcom.md)
(Такском — read-only кабинет/ОФД, API v2) и [`docs/integration/lovii.md`](docs/integration/lovii.md)
(подключение как внешнего сервиса в платформу Lovii). Контракты и переменные окружения — в README каждого сервиса
(`services/tbank-mock`, `services/kassa-mock`, `services/yookassa-mock`, `services/atol-mock`, `services/alfa-mock`, `services/sber-mock`, `services/vtb-mock`, `services/first-ofd-mock`). Для acqapi Т-Банка тестовые Basic-креды по умолчанию `partner:partner`, а регистрация точки требует полной схемы реквизитов из `docs/reference/tbank/03-payouts-and-deals.md`. Дефолты alfa-mock (`ALFAMOCKTEST`/`mockpass123`) — синтетические креды мока, а не реквизиты банка: реальные тестовые креды Альфа-Банк выдаёт индивидуально. Дефолты sber-mock (`SBERMOCKTEST`/`mockpass123`) также синтетические; тестовые креды Сбербанка merchant получает отдельно. Дефолты vtb-mock (`vtbmocktest`/`mockpass123`) — синтетические; настоящие тестовые `client_id`/`client_secret` ВТБ выдаёт merchant отдельно. Дефолты first-ofd-mock (`firstofdmocktest` + синтетический UUID-ключ) также синтетические: публичных тестовых login/API-ключей Первого ОФД нет — реквизиты выдаются в тестовом ЛК.

### Контейнерный харденинг и graceful shutdown (MS-04)

Все три compose-файла задают один и тот же набор харденинг-флагов каждому
сервису (`docker-compose.yml` — 9 сервисов, `docker-compose.include.yml` — 10,
там же kontur-ofd-mock, `docker-compose.staging.yml` — tbank + kassa):

| Флаг | Значение | Зачем |
|---|---|---|
| `init` | `true` | tini как PID 1: сигналы доходят до Node, зомби-процессы не накапливаются |
| `read_only` | `true` | root filesystem только для чтения: запись — лишь в volume `/data` (состояние) и tmpfs `/tmp` |
| `tmpfs` | `["/tmp"]` | `/tmp` — в памяти: запись не требует изменения read-only rootfs |
| `cap_drop` | `["ALL"]` | все Linux capabilities сняты (порты 3100+ непривилегированные — не нужен `NET_BIND_SERVICE`) |
| `security_opt` | `["no-new-privileges:true"]` | запрет повышения привилегий |
| `pids_limit` | `256` | ограничение числа процессов |

По `SIGTERM`/`SIGINT` (`docker stop`, `docker compose restart`, остановка
оркестратором) сервис перестаёт принимать новое, **синхронно сбрасывает
отложенные записи** состояния и очереди (окно debounce реестра песочниц — 150 мс),
закрывает соединения и выходит с кодом 0; страховочный таймер — 1 с, поэтому
остановка не упирается в десятисекундный SIGKILL. Хелпер — `installGracefulShutdown`
в `packages/core`; запуск без compose (`node services/<name>-mock/server.js`)
поведение не меняет.

Проверки: `npm run test:docker` — контейнер с полным набором флагов
(`docker stop` → exit 0 не дольше 2 с, отложенная запись переживает рестарт);
`npm run test:tbank` и `npm run test:kassa` — регресс «отложенная запись →
сигнал → рестарт с тем же state-файлом → данные на месте»; CI — шаг «Проверка
контейнерного харденинга» для всех трёх compose.

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
  sber-mock/             — адаптер «Сбербанк Ecom REST» (JSON /ecomm/gw/partner/api/v1/*.do, formUrl + ACS, unsigned JSON POST callback)
  vtb-mock/              — адаптер «ВТБ SMB E-commerce API» (JSON /openapi/smb/efcp/e-commerce/v1, OAuth2 client_credentials, unsigned POST callback {type,object})
  first-ofd-mock/        — адаптер «Первый ОФД — облачная касса OKassa» (JSON /api/external/queue/v1, getToken → Bearer 24 ч, асинхронная очередь заявок, unsigned callback)
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

| Возможность | tbank-mock | kassa-mock | yookassa-mock | atol-mock | alfa-mock | sber-mock | vtb-mock | first-ofd-mock |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Протокол провайдера | `/v2/{Init,Confirm,Cancel,GetState,CheckOrder,Chargeback,Dispute}`, `/e2c/v2/*`, `/av/v1/*` | `/possystem/v1/{getToken,sell,sell_refund,sell_correction,buy,buy_refund,buy_correction,report,stats,ofd/*}` | REST `/v3/{payments,refunds}` + `capture`/`cancel`, confirmation `/payment/{id}`, списки `{type:"list"}` | `/possystem/v4/{getToken, {group}/{sell,sell_refund,sell_correction,buy,buy_refund,buy_correction}, {group}/report/{uuid}}`, decimal-рубли, страница чека `/receipts/{uuid}` | `/payment/rest/{register,registerPreAuth,deposit,reverse,refund,getOrderStatus,getOrderStatusExtended}.do` (form-urlencoded), платёжная страница `/payment/{orderId}` с ACS 3DS1/3DS2, суммы в копейках | `/ecomm/gw/partner/api/v1/{register,registerPreAuth,deposit,reverse,refund,decline,getOrderStatusExtended}.do` (JSON POST), hosted form `/payment/{orderId}` + ACS | `/openapi/smb/efcp/e-commerce/v1/{orders,orders/preauth,orders/complete/{orderId},orders/{orderId}/cancel,refunds}`, GET `orders/{orderId}`/`refunds/{refundId}`, OAuth token `/passport/oauth2/token`, страница оплаты `/pay/{orderId}` | POST `/getToken` + `/api/external/queue/v1/{transaction/{type},transaction/{requestId},status/{requestId},statuses}` + `/api/external/receipts` (`application/json; charset=utf-8`, суммы — десятичные рубли) |
| Подпись/авторизация | Token = sha256 (как у банка), `TerminalKey` проверяется | `getToken` + TTL 12 ч | Basic Auth (`shopId:secretKey`) + обязательный `Idempotence-Key` на POST (replay того же ключа) | `getToken` → токен **в заголовке `Token`**, TTL **24 ч**; идемпотентность `external_id` **в пределах группы**: повтор возвращает прежний UUID (`X-Mock-Replayed`), а не ошибку | `userName`/`password` в каждом запросе (токенов нет; дефолты — **синтетические** `ALFAMOCKTEST`/`mockpass123`); `orderNumber` уникален в пределах магазина — повтор это `errorCode 1`, а не replay | `userName`/`password` в каждом JSON вызове; дефолты синтетические `SBERMOCKTEST`/`mockpass123`; `orderNumber` уникален, повтор — error | OAuth 2.0 `client_credentials` (form-urlencoded token endpoint, TTL ≈170 с по `expires_in`, обновление на виртуальных часах) + `Authorization: Bearer` и `X-IBM-Client-Id` (client_id lowercase, без `@ext.vtb.ru`); `Merchant-Authorization` опционален; дефолты синтетические `vtbmocktest`/`mockpass123`; `amount.value` — десятичные рубли | `POST /getToken` `{login, pass}` (pass — API-ключ UUID) → `{token}`; бизнес-вызовы `Authorization: Bearer <token>` (сам API-ключ bearer-токеном **не является**); TTL **24 ч на виртуальных часах** (`MOCK_FIRST_OFD_TOKEN_TTL_SECS`), режим `MOCK_FIRST_OFD_TOKEN_SINGLE=1` аннулирует прежние токены ([VERIFY]); синтетические дефолты `firstofdmocktest` + UUID-ключ; `requestMetadata.userGroup` сверяется с каталогом (`MOCK_FIRST_OFD_USER_GROUPS`, `*` — любой) |
| Вебхуки | подписанные нотификации, ответ ровно `OK`, ретраи, дамп, `webhook-drop`/`webhook-duplicate` | callback по документу, ретраи до 2xx, повтор кнопкой, `webhook-drop` | `{type,event,object}` без подписи, ACK **ровно 200**, ретраи/дамп, `webhook-drop`/`webhook-duplicate` | callback результата на `service.callback_url` (тот же объект, что и `report`); ACK/подпись/повторы протоколом v4 не заданы — мок шлёт без подписи, приёмник идемпотентен; `webhook-drop`/`webhook-duplicate` | **HTTP GET** с query (`mdOrder`, `operation`, `status=1/0`, `amount`, `checksum`), симметричный HMAC-SHA256 (hex uppercase, строка `name;value;…;`), ACK **ровно 200**, ретраи (параметры PDF не задаёт — mock-конфиг), режим без checksum (`MOCK_CALLBACK_CHECKSUM=false` — сверка через REST); `webhook-drop`/`webhook-duplicate` | JSON **HTTP POST** (`mdOrder`, `orderNumber`, `operation`, `status=1/0`) **без подписи/checksum**, ACK ровно 200, retry 3×60s, callback `created`/`approved`/… | JSON **HTTP POST** `{"type":"PAYMENT|REFUND","object":{…}}` **без подписи**; расхождение ключей `Status` (платёж) / `status` (возврат) сохраняется как есть; ACK-код и расписание ретраев публично не зафиксированы — мок принимает любой 2xx [FORK], retry 3×60s; `webhook-drop`/`webhook-duplicate` | unsigned POST JSON на `requestMetadata.callbackUrl` (fallback `MOCK_FIRST_OFD_CALLBACK_URL` [FORK]); envelope/подпись/ACK/расписание публично не зафиксированы — мок не выдумывает подпись, считает доставкой любой 2xx [FORK], повтор 3×60s; SSRF-политика ядра (`ERR SSRF_BLOCKED` терминален); сверка через `status/{requestId}`; `webhook-drop`/`webhook-duplicate` |
| Машина состояний | NEW→…→AUTHORIZED/CONFIRMED/REVERSED/REFUNDED/CANCELED + чарджбэк DISPUTED→REPRESENTMENT→ARBITRATION→WON/LOST | ККТ: wait → done/fail; ОФД: pending → sent/rejected; связка авансов и возвратов | `pending → waiting_for_capture → succeeded/canceled`, two-stage + частичный capture, возвраты (`refunded_amount`), `cancellation_details` по официальной таблице, холд 7 дней | очередь ККТ: `wait → done\|fail`; `done` — `payload` с ФД/ФП, ФН/ККТ, сменой, НДС и `ofd_receipt_url`; `fail` — `error{code,text,type,error_id}` | `orderStatus 0…6`: регистрация → форма/ACS (5) → холд (1) или списание (2) → reverse (3) / полный и частичный refund (4) / отказ (6, `actionCode` -2011/116/71015); `sessionTimeoutSecs` → `declinedByTimeout`; `getOrderStatusExtended` различает суммы авторизации/списания/возврата | `orderStatus 0…6`: ACS=5, холд=1, оплата/deposit=2, reverse=3, refund=4, отказ/TTL=6; `actionCode` отдельно; TTL 1200s, до 3 попыток | `status.value` строго на своём уровне: ордер `CREATED → PAID → REFUNDED/PARTIALLY_REFUNDED` (+ `CANCELED`); операция `NEW/CONFIRMED/RECONCILED`; preauth-холд = payment `NEW` до `complete` ≤ авторизации; ордер живёт 20 минут (`expire` с tz/мс); повтор `orderId` идемпотентен, дубль `refundId` — ошибка | очередь заявки `IN_PROGRESS → COMPLETED\|ERROR`; `errorType` — слой ошибки (API/KKT) + `errorCode`/`details`; `COMPLETED` несёт `payload` (ФД/ФП, ФН, смена, НДС, `totalSum`) или состояние смены; `openShift`/`closeShift`/`currentStateReport` — `StateCommandRequest`; повторный openShift → `ERROR` слоя KKT `SHIFT_ALREADY_OPEN` [FORK] |
| Негативные сценарии и часы | `X-Mock-Scenario` (`chargeback-after:7d`, `partial-refund`, `webhook-drop`), `/mock/scenarios`, `/mock/time` (`+7d`/`+60d`) | `X-Mock-Scenario` (`fail`, `hang`, `ofd-queue`, `ofd-reject`, `mark-fail`, `webhook-drop`), `/mock/time` | `X-Mock-Scenario` (`fail`, `hang`, `latency`, `http-500/504`, `webhook-drop`/`webhook-duplicate`), `/mock/scenarios`, `/mock/time` (истечение холда `expired_on_capture`) | `X-Mock-Scenario` (`fail`, `hang`, `webhook-drop`, `webhook-duplicate`, `latency`, `http-500/504`), префиксы `fail-`/`hang-`, `/mock/scenarios`, `/mock/time` (печать очереди, истечение токена через 24 ч) | `X-Mock-Scenario` (`fail`, `hang`, `webhook-drop`/`webhook-duplicate`, `latency`, `http-500/504`) на `*.do` и форме, `/mock/scenarios` (target `register`/`deposit`/`pay`/…), `/mock/time` (истечение `sessionTimeoutSecs` → `declinedByTimeout`, ретраи callback); отказные тестовые карты вместо префиксов | официальные повторяемые карты 101/116; `X-Mock-Scenario` (`fail`, `hang`, `latency`, `http-500/504`, webhook drop/duplicate), `/mock/time` для TTL/retry | `X-Mock-Scenario` (`fail`, `hang`, `latency`, `http-500/504`, `webhook-drop`/`webhook-duplicate`, `status-lowercase`, `reconciled`), `/mock/scenarios`, `/mock/time` (истечение токена по `expires_in`, TTL ордера 20 мин, retry callback); отказные синтетические [FORK]-карты (официальная тестовая карта ВТБ истекла) | `X-Mock-Scenario` (`fail`, `hang`, `latency`, `http-500`/`http-504`, `kkt-error`, `api-error`, `getToken-error-quirk`, `webhook-drop`/`webhook-duplicate`), `/mock/scenarios`, `/mock/time` (обработка очереди `MOCK_FIRST_OFD_PROCESS_MS`, истечение токена 24 ч, retry callback) |
| DX | ошибка = код + поле + подсказка + ссылка на официальную доку; OpenAPI 3.1 (`/openapi.json`); готовый `curl` в журнале | то же в формате Ferma (включая dry-run `/possystem/v1/validate`, валидацию 54-ФЗ, ставок НДС, ИНН, маркировки) | `{type:"error", id, code, description, parameter}` как у ЮKassa + `hint`/`doc`; официальные тексты (Idempotence-Key, 404 payment); `405`/`415` — пустое тело как в доке; `curl` в журнале | `{error:{code,text,type,error_id}}` как у платформы + `field`/`hint`/`doc`; ловит перенос синтаксиса Ferma (`vat20_120` → `vat120`, `type=5` → `0`, `?token=` → заголовок `Token`); OpenAPI 3.1; `curl` в журнале | `{errorCode,errorMessage}` как у шлюза RBS + `field`/`hint`/`doc`; напоминание «`errorCode=0` ≠ факт оплаты» в ответе регистрации; объяснение разницы схем (`deposit` на одностадийный заказ, `refund` на холд); OpenAPI 3.1; `curl` (form-urlencoded) в журнале | `{errorCode,errorMessage}` + mock `field`/`hint`/`doc`; errorCode 0 ≠ факт оплаты; кодировка ошибок 1…6 помечена [VERIFY]/[FORK]; OpenAPI 3.1 и REST-журнал | `{error, error_description}` + `field`/`hint`/`doc` (envelope бизнес-ошибок — [FORK]: публичный срез не фиксирует схему тела); OAuth-ошибки по RFC 6749; напоминание «callback — не источник истины»; OpenAPI 3.1; `curl` в журнале | `{error:{code,text,layer}}` + `field`/`hint`/`doc` (envelope — [FORK]: срез схему тела ошибки не фиксирует); заявка отвечает `requestId`, результат — отдельным методом статуса; подсказка «API-ключ UUID — не bearer-токен» и «написание `EXPENCE` не исправляется»; OpenAPI 3.1; `curl` в журнале |
| Песочницы и проверка интегратора | `X-Mock-Sandbox` (request-local, RFC-001), `POST /sandboxes` (hosted: owner-token, TTL, лимиты), `/sandboxes/me/*`, `/mock/sandboxes`, `/mock/reset`, `/mock/state`, активный экзаменатор `POST /mock/verify-merchant` | то же в формате Ferma: `X-Mock-Sandbox`, `POST /sandboxes` (креды и owner-token песочницы), `/sandboxes/me/*`, `/mock/sandboxes`, `/mock/reset`, `/mock/state`, `POST /mock/verify-merchant` | то же (без `verify-merchant`: вебхуки ЮKassa не подписаны, ветка ядра не применима — см. README сервиса «Границы») | то же: `X-Mock-Sandbox`, `POST /sandboxes` (собственные login/pass/группа АТОЛ и owner-token), `/sandboxes/me/*`, `/mock/sandboxes`, `/mock/reset`, `/mock/state` (без `verify-merchant`: callback v4 не подписан) | то же: `X-Mock-Sandbox`, `POST /sandboxes` (собственные `userName`/`password`/`callbackSecret` и owner-token), `/sandboxes/me/*`, `/mock/sandboxes`, `/mock/reset`, `/mock/state` (без `verify-merchant`: callback — GET query, экзаменатор ядра рассчитан на POST-JSON) | RFC-001 `X-Mock-Sandbox`, `/sandboxes`/`/sandboxes/me/*`, `/mock/state`/`reset`; сценарии, журнал и часы изолированы; без `verify-merchant` (callback unsigned) | RFC-001 `X-Mock-Sandbox` (токены и ордеры per-sandbox), `POST /sandboxes` (собственные `clientId`/`clientSecret` и owner-token), `/sandboxes/me/*`, `/mock/sandboxes`, `/mock/reset`, `/mock/state` (без `verify-merchant`: callback не подписан) | RFC-001 `X-Mock-Sandbox` (заявки, смены, сценарии и часы per-sandbox), `POST /sandboxes` (собственные `login`/`pass` и owner-token), `/sandboxes/me/*`, `/mock/sandboxes`, `/mock/reset`, `/mock/state` (без `verify-merchant`: callback не подписан) |
| Наблюдаемость | `/admin` (+ журнал запросов с `curl`), `/health`; управляющая поверхность — под `MOCK_OPERATOR_TOKEN`, админка — под `MOCK_ADMIN_TOKEN` | `/admin` (+ журнал запросов с `curl`, очередь ОФД), `/healthz`, чек покупателю; смены/ФН/ОФД/`/mock/*` — под `MOCK_OPERATOR_TOKEN` | `/admin` (+ журнал `/v3` с `curl`, платежи/возвраты/очередь вебхуков), `/health`; токены — как в tbank | `/admin` (+ журнал `/possystem/v4` с `curl`, документы и очередь callback), `/health`, `/openapi.json`; токены — как в tbank | `/admin` (+ журнал `/payment/rest` с `curl`, заказы/суммы/`actionCode` и очередь callback; форма не журналируется — PAN не попадает в журнал), `/health`, `/openapi.json`; токены — как в tbank | `/admin` + журнал JSON REST без формы/PAN, `/health`, `/openapi.json`; admin/operator control-токены как у остальных адаптеров | `/admin` (+ журнал `/openapi/smb` с `curl`, ордеры/возвраты/очередь callback без PAN), `/health`, `/openapi.json`; admin/operator control-токены как у остальных адаптеров | `/admin` (+ журнал очереди с `curl`, кнопки обработки/повтора callback), `/health`, `/openapi.json`; admin/operator control-токены как у остальных адаптеров |

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
| 10 | изоляция песочниц RFC-001 (A-21) за env-флагом: request-local контекст (F-11), hosted tenancy + owner-token (F-12), target в export/import (F-13), персистентность/TTL (F-14), квоты/retention (F-15), изоляция compose-селфтеста (F-33) | ✅ 0.6.0 |
| 11 | **Stage 2: первый внешний банк-адаптер — ЮKassa end-to-end** (#33): REST `/v3` (Basic Auth, `Idempotence-Key`, платежи/возвраты, two-stage + частичный capture), confirmation-страница с тестовыми картами и честными `cancellation_details`, вебхуки `{type,event,object}` без подписи (ACK 200, ретраи, дубли), сценарии/часы/журнал/песочницы через ядро; `test:yookassa` в `npm test`, compose + healthcheck :3102, гайд «за 10 минут» | ✅ 0.6.0 |

| 12 | **Stage 2: первый внешний касса-адаптер — АТОЛ Онлайн direct v4** (#34): `/possystem/v4/` (`getToken` с токеном на 24 ч в заголовке `Token`, шесть операций, отчёт `wait → done\|fail` с ФД/ФП и `ofd_receipt_url`, callback на `service.callback_url`), идемпотентность `external_id` в пределах группы (повтор возвращает прежний UUID — отличие от Ferma), валидация реквизитов ФФД 1.05 и decimal-рублей, сценарии/часы/журнал/песочницы через ядро; манифест `protocols/atol-online.json` и секция дрейф-чекера, `test:atol` в `npm test`, compose + healthcheck :3103, гайд «за 10 минут» | ✅ 0.6.0 |
| 13 | **Stage 2: второй внешний банк-адаптер — Альфа-Банк интернет-эквайринг REST** (#41): `/payment/rest/*.do` (form-urlencoded, `register`/`registerPreAuth` → `{orderId, formUrl}`, `deposit` ≤ холда, `reverse`, полный/частичный `refund`, `getOrderStatus(Extended)` с суммами авторизации/списания/возврата), платёжная страница с официальными тестовыми картами и ACS 3DS1/3DS2 (пароль `12345678`, отказы `-2011`/`116`/`71015`), callback **HTTP GET** с симметричным checksum HMAC-SHA256 и ACK ровно 200 (ретраи, дубли, режим без checksum — сверка через REST), `sessionTimeoutSecs` → `declinedByTimeout` на виртуальных часах, синтетические креды по образцу TBANKMOCKTEST; аддитивный GET в очереди доставки ядра, манифест `protocols/alfa-eacq.json` и секция дрейф-чекера, OpenAPI 3.1, `test:alfa` в `npm test`, compose + healthcheck :3104, гайд «за 10 минут». Асимметричный checksum вне области (PDF противоречив: SHA-256 vs SHA-512) | ✅ 0.6.0 |
| 14 | **Stage 2: третий внешний банк-адаптер — Сбербанк Ecom REST v1.1.11.1** (#81): JSON `/ecomm/gw/partner/api/v1/*.do`, `register`/`registerPreAuth`, hosted form/ACS `111111`, deposit/reverse/refund/decline/status 0…6, callbacks **POST JSON без подписи** (ACK 200, три попытки × 60s), TTL 20 минут/три оплаты, сценарии/часы/журнал/RFC-001; `protocols/sber-ecom.json` + drift, OpenAPI 3.1, `test:sber` в `npm test`, compose + healthcheck :3105, гайд «за 10 минут». `paymentOrder.do` не включён без разрешения; полный errorCode mapping помечен [VERIFY]/[FORK] | ✅ 0.6.0 |
| 15 | **Stage 2: четвёртый внешний банк-адаптер — ВТБ SMB E-commerce API** (#87): JSON `/openapi/smb/efcp/e-commerce/v1/` (OAuth 2.0 `client_credentials` + `X-IBM-Client-Id`), `orders`/`preauth`/`complete`/`cancel`/`refunds`, десятичные рубли, `status.value` ордера/операции, TTL ордера 20 мин, callbacks **POST JSON `{"type","object"}` без подписи** (Status/status не нормализуются), hosted-форма с синтетическими [FORK]-картами (официальная тестовая карта ВТБ истекла), сценарии/часы/журнал/RFC-001; `protocols/vtb-smb.json` + drift, OpenAPI 3.1, `test:vtb` в `npm test`, compose + healthcheck :3106, гайд «за 10 минут». legacy RBS и СБП-QR вне области; схема ошибок бизнес-уровня и ответы callback в публичных срезах не зафиксированы — помечены [FORK]/[VERIFY] | ✅ 0.6.0 |
| 16 | **Stage 2: второй внешний касса-адаптер — Первый ОФД (облачная касса OKassa API)** (#92): `POST /getToken` (`{login, pass}` — API-ключ UUID) → Bearer-токен на 24 ч виртуальных часов, асинхронная очередь `/api/external/queue/v1/transaction/{type}` (`receipt`/`receiptCorrection`/`openShift`/`closeShift`/`currentStateReport`) → `requestId`, строгие схемы `ReceiptRequest`/`ReceiptCorrectionRequest`/`StateCommandRequest` (без «универсального» объекта), операции `INCOME`/`INCOME_RETURN`/`EXPENCE`/`EXPENCE_RETURN` — написание **как в схеме**, статусы `IN_PROGRESS → COMPLETED\|ERROR` с раздельными слоями ошибок API/ККТ (`errorCode`/`errorType`/`details`/`payload`), сверка `transaction/{requestId}`, `status/{requestId}`, `statuses?externalId&groupId`, документы `/api/external/receipts` за период с пагинацией, unsigned callback на `requestMetadata.callbackUrl` (подпись/ACK/повторы не выдумываются, SSRF-политика ядра, сверка через статус), сценарии/часы/журнал/RFC-001-песочницы; `protocols/first-ofd-okassa.json` + drift, OpenAPI 3.1, `test:first-ofd` в `npm test`, compose + healthcheck :3107, гайд «за 10 минут». Расхождения среза (`requestMetadata` required vs optional, `items` массив vs объект, `http://` vs `https://` callback, квирк `getToken`, тег ATOL Online V5), идемпотентность `externalId` и production base не подтверждены — помечены [VERIFY]/[FORK] | ✅ Unreleased |
| 17 | **Stage 2: десятый сервис — Такском, read-only кабинет/ОФД (API v2)** (#112): `POST /API/v2/Login` (заголовок `Integrator-ID`, тело — консервативная форма `{login, password}` с пометкой [VERIFY]: схема `Login_Request` публично не раскрыта) → временный marker в `Session-Token` с TTL **300 с sliding** на виртуальных часах и `401` по истечении; `GET /API/v2/AccountList` (договоры и права), `GET /API/v2/NewDocuments` (последние **10 суток**, не более **10 000** за вызов, сортировка по времени приёма, курсор по `id`, хвост → пустой ответ, ошибки **3106** «нет доступной ККТ» и **2203** «некорректный курсор»), типы: смены, состояние расчётов, чек, чек коррекции, БСО, БСО коррекции; write API не моделируется (405/404 с подсказкой), сценарии/часы/журнал/RFC-001-песочницы; `protocols/taxcom-ofd.json` + drift, OpenAPI 3.1, `test:taxcom` в `npm test`, compose (root + include) + healthcheck :3109, гайд «за 10 минут». Повторный Login выдаёт новый marker ([FORK] против формулировки среза), HTTP-статусы 3106/2203, имена полей и суммы в копейках — [FORK]/[VERIFY] | ✅ Unreleased |

Детали, оценки и приоритеты — в [аудите](docs/audit/AUDIT-2026-10-08.md) §9.

## Тестирование

```bash
npm test              # всё (core + tbank + kassa + yookassa + atol + alfa + sber + vtb + first-ofd + kontur-ofd + taxcom + offline upstream selftest + check:links + check:drift)
npm run test:core     # ядро (42 проверки): restore/очередь (POST и GET-доставка)/каталог ошибок/часы/сценарии/песочницы RFC-001/экзаменатор/access-control/SSRF/tenancy/CSRF
npm run test:tbank    # 48 сценариев контракта Т-Банка (вкл. E2C TerminalKey, CSRF, чарджбэки, СБП, рекурренты, изоляцию песочниц)
npm run test:kassa    # 141 проверка Ferma/54-ФЗ (вкл. tenancy, CSRF, owner-token admin, ОФД/ФН, изоляцию песочниц)
npm run test:yookassa # 227 проверок ЮKassa /v3 (вкл. идемпотентность, карты/3DS, вебхуки ACK 200 + ретраи/дубли, сценарии, /mock/time, рестарт, control-plane)
npm run test:atol     # 202 проверки АТОЛ Онлайн v4 (вкл. дедуп external_id, callback/ретраи/дубли, реквизиты ФФД 1.05, истечение токена 24 ч, песочницы, рестарт)
npm run test:alfa     # 287 проверок Альфа-Банк REST (вкл. register/preAuth/deposit/reverse/refund, карты 3DS1/3DS2 и отказы -2011/116/71015, GET-callback + HMAC-SHA256 + ACK ровно 200, sessionTimeoutSecs, песочницы owned, рестарт, control-plane)
npm run test:sber     # selftest Сбер Ecom REST (register/preAuth, карты/ACS 101/116, операции, TTL, JSON callbacks/retry/SSRF, песочницы, control-plane)
npm run test:vtb      # selftest ВТБ SMB E-commerce (OAuth client_credentials + Bearer/X-IBM-Client-Id, orders/preauth/complete/cancel/refunds, decimal-рубли, идемпотентный orderId, payUrl/карты, callback {type,object} без нормализации Status/status, песочницы, control-plane)
npm run test:kontur-ofd # Контур.ОФД read/reconciliation: Sid/API key, документы, пагинация, ошибки, песочницы
npm run test:taxcom    # Такском read-only API v2: Login/Integrator-ID, Session-Token TTL 300 с sliding и 401, AccountList, NewDocuments (10 суток, курсор по id, хвост, лимит 10 000, 3106/2203, сортировка по времени приёма), read-only 405/404, песочницы owned, persist/restore
npm run test:first-ofd # selftest Первого ОФД/OKassa (getToken + TTL 24 ч на виртуальных часах, очередь transaction/{type} IN_PROGRESS → COMPLETED|ERROR, строгие схемы по типу, операции с написанием EXPENCE, смены StateCommandRequest, statuses/receipts, callback без подписи + сверка, песочницы, control-plane)
npm run check:links   # относительные ссылки markdown-документации разрешаются (docs/providers упразднён — канон docs/reference)
npm run check:drift   # 828 инвариантов: protocols/*.json <-> server.js <-> OpenAPI 3.1 <-> docs/reference/guide
npm run test:upstream  # офлайн selftest синхронизатора snapshot
npm --silent run check:upstream -- --json # JSON-отчёт; без --silent npm печатает служебный баннер
npm run check:upstream -- --update # явное обновление snapshot после просмотра
npm run test:docker  # image smoke (нужен docker): tbank/kassa/sber/vtb/first-ofd healthchecks, kontur-ofd/taxcom (эфемерный порт + selftest в контейнере), непривилегированный UID, persist/restore при --read-only rootfs, MS-04: харденированный контейнер + SIGTERM → exit 0 ≤ 2 с
npm run test:compose  # black-box selftest против контейнеров compose (:3100–:3107; kontur-ofd и taxcom покрываются image smoke и `test:kontur-ofd`/`test:taxcom`)
```

CI гоняет то же на Node 18/20/22 и проверяет, что compose-стенд поднимается. Отдельный weekly/ручной workflow сравнивает HTTP-отпечатки ссылок из `docs/reference/external-links.md` с `protocols/upstream-snapshot.json`; он только публикует отчёт, не создаёт issue и не ломает сборку при сетевых сбоях. Снимок изменяется только явной командой `npm run check:upstream -- --update` после просмотра отчёта. SPA-страницы и источник с обязательной авторизацией помечены `mode: "skip"` с причиной.

## Безопасность

Проект — **тестовый стенд**: все креды фейковые, платежи идут только по
тестовым картам, реальные данные использовать нельзя. `/admin` по умолчанию
без аутентификации (локальный DX) — перед публикацией стенда прочитайте
[`SECURITY.md`](SECURITY.md). Для публичного размещения задайте `MOCK_HOSTED=1`:
управляющая поверхность (`/mock/*`, смены/ФН/ОФД, чтение спора) закрывается
`MOCK_OPERATOR_TOKEN` (fail-closed, если токен не задан), админка — `MOCK_ADMIN_TOKEN`,
а исходящие вебхуки по умолчанию не ходят на приватные адреса. Без
`MOCK_SANDBOX_TOKEN` hosted-стенд не обслуживает `default`-песочницу (MS-12):
бизнес-маршруты отвечают 404, а арендаторам выдаются именованные песочницы через
`POST /sandboxes`. Управляющие токены не возвращаются в URL и HTML: после
`POST /admin/login` консоль работает по HttpOnly-cookie. Арендаторы
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

### Общий бюджет состояния песочниц (PD-02)

Все 10 адаптеров и `docker-compose.include.yml` поддерживают
`MOCK_SANDBOX_MAX_STATE_BYTES` (байты JSON одной песочницы; пусто — прежний
дефолт 8 МиБ при квоте документов, иначе без лимита) и
`MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES` (байты JSON всех песочниц одного сервиса,
включая `default`; дефолт **64 МиБ**). `0` выключает соответствующий лимит.
Квота per-sandbox ≠ память контейнера: общий бюджет сдерживает суммарный рост,
но не заменяет `mem_limit: 128m` и измерение RSS. Превышение глобального бюджета
на записи/импорте → HTTP 400 + `errorCode` + `sandbox_state_budget_exceeded`,
`kind: 'bytes'`, без частичного применения отклонённого состояния.
См. [байтовые квоты ядра](packages/core/README.md#байтовые-квоты-песочниц-pd-02-74)
и env-таблицы сервисов.
