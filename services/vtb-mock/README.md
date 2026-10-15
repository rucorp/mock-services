© 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
SPDX-License-Identifier: Apache-2.0

# vtb-mock — ВТБ SMB E-commerce API

Четвёртый внешний банк-адаптер Stage 2 (issue #87). Реализован по официальной
документации SMB E-commerce API и callback/тестирования ВТБ.
Это SMB API интернет-эквайринга, **не legacy RBS** (`vtb.rbsuat.com`, `*.do`):
JSON REST base `/openapi/smb/efcp/e-commerce/v1/`, OAuth 2.0
`client_credentials` (POST `/passport/oauth2/token`) → `Authorization: Bearer` +
`X-IBM-Client-Id` (client_id в нижнем регистре, без `@ext.vtb.ru`), суммы —
десятичные рубли `{value, code: "RUB"}`.

## Быстрый старт

```bash
npm run start:vtb          # http://localhost:3106
# или общий локальный стенд:
docker compose up -d vtb-mock
```

Node ≥ 18, zero npm dependencies. Синтетические дефолты —
`vtbmocktest` / `mockpass123`; это не тестовые креды банка. Фактические env
значения при запуске скрыты в логах. Банк выдаёт реальные тестовые
`client_id`/`client_secret` подключённому merchant отдельно; не помещайте их в
код, тесты, fixtures или общий compose-файл.

## Поддерживаемый SMB-поток

| Маршрут | Назначение |
| --- | --- |
| `POST /passport/oauth2/token` | OAuth 2.0 client_credentials → `{access_token, token_type, expires_in}` (≈170 с; обновление по `expires_in`) |
| `POST /openapi/smb/efcp/e-commerce/v1/orders` | создать ордер (уникальный merchant `orderId`, `orderName`, `amount` в десятичных рублях) → `payUrl`; повтор `orderId` идемпотентен (`X-Mock-Replayed`) |
| `GET /openapi/smb/efcp/e-commerce/v1/orders/{orderId}` | ордер + транзакции платежей/возвратов; `status.value` на своём уровне |
| `POST /openapi/smb/efcp/e-commerce/v1/orders/preauth` | ордер с предавторизацией (`twoStageParams` обязателен); доступность — `MOCK_VTB_PREAUTH` («отдельное разрешение банка») |
| `POST /openapi/smb/efcp/e-commerce/v1/orders/complete/{orderId}` | завершить холд суммой ≤ авторизации (частичное подтверждение поддержано) |
| `POST /openapi/smb/efcp/e-commerce/v1/orders/{orderId}/cancel` | отмена неоплаченного ордера/preauth до complete, опциональный `cancelReason` |
| `POST /openapi/smb/efcp/e-commerce/v1/refunds` | полный/частичный возврат (`refundId`, `paymentId`, `amount`); `refundId` уникален — повтор это ошибка, не replay |
| `GET /openapi/smb/efcp/e-commerce/v1/refunds/{refundId}` | статус возврата |
| `GET /pay/{orderId}`, `POST /pay/{orderId}/pay` | тестовая hosted-страница оплаты (payUrl) с синтетическими [FORK]-картами |
| `GET /health`, `GET /openapi.json` | healthcheck и OpenAPI 3.1 |
| `GET /admin`, `GET /admin/journal`, `POST /admin/action` | консоль ордеров/возвратов/очереди callback и журнала; действия защищены same-origin + CSRF |
| `/mock/time`, `/mock/scenarios`, `/mock/state`, `/mock/reset` | виртуальные часы, хаос/сценарии и состояние песочницы |
| `/sandboxes*`, `/mock/sandboxes` | RFC-001 sandbox/control-plane API |

Legacy RBS (`vtb.rbsuat.com`, `/payment/rest/`, `register.do`/`paymentorder.do`,
`userName/password`, form-urlencoded) **не реализуется и не является
альтернативной базой** для `/openapi/smb/…`. СБП-QR стенды
(`qr-efcp.bankingapi.ru`) и ветка `sbpParams` — вне области.

## OAuth и заголовки

Токен выдаётся form-urlencoded `POST /passport/oauth2/token`
(`grant_type=client_credentials`); ошибки token endpoint — RFC 6749 §5.2
(`invalid_client`, `unsupported_grant_type`). TTL токена (дефолт 170 с) живёт
на виртуальных часах: `POST /mock/time {"advance":"+171s"}` истекает токен,
клиент запрашивает новый по `expires_in`. Бизнес-запросы несут
`Authorization: Bearer <token>` и `X-IBM-Client-Id` — строго client_id в
нижнем регистре без `@ext.vtb.ru` (суффикс/регистр → `invalid_client`).
`Merchant-Authorization` опционален (одна политика: для одного ресурса не
обязателен).

## Суммы, статусы и идемпотентность

`amount.value` — **десятичные рубли** (`10.56`), не копейки: принимается число
или цифровая строка максимум с двумя знаками после точки, `code` строго `RUB`.
Статусы живут строго на своём уровне `status.value`: ордер
`CREATED/PAID/REFUNDED/PARTIALLY_REFUNDED/CANCELED`, операция (платёж/возврат)
`NEW/CONFIRMED/RECONCILED` — не смешивать. Ордер по умолчанию живёт 20 минут
(`expire` возвращается с timezone и миллисекундами; своё — при создании);
по истечении незакрытый ордер переходит в `CANCELED` ([VERIFY]: явного статуса
истечения в срезе нет). Повтор `orderId` в `POST /orders` идемпотентен и
возвращает существующий ордер; повторный `refundId` — provider-shaped ошибка
`duplicate_refund_id` (409) с DX-подсказкой.

## Callback SMB

Исходящее уведомление — HTTP `POST` JSON `{"type":"PAYMENT|REFUND","object":{…}}`
на `MOCK_VTB_CALLBACK_URL` (один URL на ресурс). **Payload сохраняется и
доставляется как есть:** в карточном примере платежа поле статуса — `Status`
(заглавная), в примере возврата — `status` (строчные); мок не нормализует
регистр ключа. Сценарий `status-lowercase` отдаёт СБП-вариант `status` у
платежа (для проверки парсеров), `reconciled` — `RECONCILED` вместо `CONFIRMED`.

**Подписи, обязательного ACK-кода и расписания ретраев в публичных SMB-доках
нет — мок их не выдумывает и не переносит legacy-правила RBS.** Локально
доставкой считается любой HTTP 2xx ([FORK] — договорённость стенда, не
утверждение протокола); график повторов задаётся `MOCK_VTB_CALLBACK_RETRY_MS` ×
`MOCK_VTB_CALLBACK_MAX_ATTEMPTS` (дефолт 3 × 60 с). Уведомление — не источник
истины: после callback выполняйте `GET /orders/{orderId}` либо
`GET /refunds/{refundId}`. В отсутствии callback URL очередь не создаётся.

## Ошибки и протокольные оговорки

Бизнес-ошибки — HTTP 400/401/404/409/429 + тело
`{error, error_description, field, hint, doc}`; коды `invalid_request`,
`invalid_token`, `invalid_client`, `invalid_amount`, `order_not_found`,
`payment_not_found`, `refund_not_found`, `duplicate_refund_id`,
`amount_exceeds_limit`, `invalid_order_state`, `preauth_disabled` и др.
Публичный SMB-срез фиксирует HTTP-статусы и примеры, но **не полную схему тела
бизнес-ошибок** — envelope и словарь кодов это явный **[FORK]** мока (по образцу
errorCode-форка Сбера), а не production-каталог ВТБ. Точно так же [FORK]/[VERIFY]
являются: синтетические карты взамен истёкшей официальной (`4111 1111 1111 1111`,
12/24), форма `twoStageParams`/`paymentData`/`paymentCode`, объект
`{"value": …}` внутри callback-статуса, mock-поле `returnUrl`, пометка `voided`
у снятого холда (статуса reversal в словаре операций нет).

## Сценарии, часы и диагностика

`X-Mock-Scenario`/`/mock/scenarios` поддерживают `fail`, `hang`, `latency`,
`http-500`, `http-504`, `webhook-drop`/`no-callback`,
`webhook-duplicate`/`callback-duplicate`, `status-lowercase`, `reconciled`.
`POST /mock/time` принимает `{"advance":"+20m"}` (истечение ордера),
`{"advance":"+171s"}` (истечение токена) и `{"advance":"+60s"}` (retry
callback). Сценарии, история, токены, журнал и состояние изолируются по
`X-Mock-Sandbox`. Журнал redacts чувствительные поля; PAN не пишется в журнал и
не сохраняется в ордере — только маска `first6**last4`. В hosted-режиме
SSRF-проверка исходящих callback включена по умолчанию; `SSRF_BLOCKED` —
терминальный отказ без повторов.

## Переменные окружения

| Переменная | Default | Назначение |
| --- | --- | --- |
| `MOCK_HOST` / `MOCK_PORT` | `0.0.0.0` / `3106` | адрес и порт HTTP-сервера |
| `MOCK_VTB_CLIENT_ID` | `vtbmocktest` | синтетический client_id (в `X-IBM-Client-Id` — lowercase, без `@ext.vtb.ru`) |
| `MOCK_VTB_CLIENT_SECRET` | `mockpass123` | синтетический client_secret |
| `MOCK_VTB_TOKEN_TTL_SECS` | `170` | срок access_token в секундах; поддерживает длительность (`2m`); TTL живёт на виртуальных часах |
| `MOCK_VTB_PUBLIC_BASE_URL` | `http://localhost:${MOCK_VTB_HOST_PORT:-3106}` | внешний base URL, используемый в `payUrl` |
| `MOCK_VTB_CALLBACK_URL` | пусто | callback URL ресурса (один на ресурс); без него очередь не создаётся |
| `MOCK_VTB_CALLBACK_RETRY_MS` | `60000` (`60s`) | интервал retry; число в миллисекундах либо длительность (`60s`, `1m`) |
| `MOCK_VTB_CALLBACK_MAX_ATTEMPTS` | `3` | максимум доставок; значение меньше 1 нормализуется в 1 |
| `MOCK_VTB_ORDER_TTL_SECS` | `1200` | срок нового ордера (20 минут); поле `expire` запроса переопределяет его для конкретного ордера |
| `MOCK_VTB_PREAUTH` | `true` | разрешить `POST /orders/preauth` в локальном стенде (upstream — отдельное разрешение банка) |
| `MOCK_STATE_FILE` | пусто | сохранение доменного состояния/очереди между рестартами |
| `MOCK_SANDBOX_FILE` | `<MOCK_STATE_FILE>.sandboxes.json` | база RFC-001 реестра песочниц |
| `MOCK_SANDBOX_SWEEP_MS` | `60000` | интервал sweep TTL/retention, когда worker включён |
| `MOCK_BLOCK_PRIVATE_WEBHOOKS` | `false` (hosted → `true`) | запрет исходящих callback в private/reserved адреса; SSRF-отказ терминален |
| `MOCK_VIRTUAL_CLOCK` | текущее время | начальное значение виртуальных часов |
| `MOCK_ADMIN_TOKEN` / `MOCK_OPERATOR_TOKEN` | пусто | защита управляющих `/admin*` и `/mock/*` |
| `MOCK_HOSTED` | `false` | `true` включает hosted fail-closed для управляющих поверхностей и default SSRF-защиту |
| `MOCK_TENANCY` | авто | sandbox-модель RFC-001 (`off`, `namespaces`, `owned`) |
| `MOCK_SANDBOX_TOKEN` | пусто | owner-token default sandbox в `owned`-модели; при `MOCK_HOSTED=1` без него `default` не обслуживается (MS-12) |
| `MOCK_SANDBOX_TTL_MS` / `MOCK_SANDBOX_MAX` | `owned: 24h` / `owned: 100` | аренда и число песочниц |
| `MOCK_SANDBOX_MAX_DOCUMENTS` | `owned: 5000` | квота ордеров + возвратов + callback-документов на sandbox |
| `MOCK_SANDBOX_RETENTION_MS` | `0` | retention терминальных callback-записей; ордеры не удаляются |
| `MOCK_SANDBOX_HOST_SUFFIX` | пусто | опциональный hostname-формат sandbox URL |
| `MOCK_SANDBOX_CREATE_LIMIT` | `owned: 20` | rate-limit создания sandbox на IP |

## Протокольные файлы и тесты

- Манифест drift-проверки: [`protocols/vtb-smb.json`](../../protocols/vtb-smb.json).
- OpenAPI: [`docs/openapi/vtb-mock.openapi.json`](../../docs/openapi/vtb-mock.openapi.json), также `GET /openapi.json`.
- Selftest (OAuth/TTL, orders/refunds/preauth, Status-status callback, SSRF, RFC-001): `npm run test:vtb`.
- Ограничения безопасности общие с проектом: [`SECURITY.md`](../../SECURITY.md).

## Байтовые квоты состояния (PD-02)

| Env | Дефолт | Назначение |
| --- | --- | --- |
| `MOCK_SANDBOX_MAX_STATE_BYTES` | пусто: `8388608` (8 МиБ) при `maxDocuments > 0`, иначе без лимита | байты JSON одной песочницы; `0` выключает |
| `MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES` | `67108864` (64 МиБ) | сумма байт JSON всех песочниц рантайма, включая `default`; `0` выключает |

Значения задаются в целых байтах. Пусто сохраняет дефолты. Квота per-sandbox
не ограничивает память контейнера; общий бюджет меньше `mem_limit: 128m`, но
не равен RSS. Превышение глобального бюджета на записи или байтовых квот при
импорте `/mock/state` → HTTP 400, `errorCode: 400`, `kind: 'bytes'`,
`code: sandbox_state_budget_exceeded` / `sandbox_state_quota_exceeded`,
с откатом отклонённого состояния. Правила/история/журнал остаются volatile.
Подробности и границы — [документация ядра](../../packages/core/README.md#байтовые-квоты-песочниц-pd-02-74).
