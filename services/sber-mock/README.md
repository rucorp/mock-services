© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# sber-mock — Сбербанк Ecom REST v1.1.11.1

Третий внешний банк-адаптер Stage 2 (issue #81). Реализован по локальным
конспектам [Ecom REST](../../docs/reference/sber/01-payment-api.md) и
[callback/тестового контура](../../docs/reference/sber/02-callbacks-and-test.md).
Это новый Ecom JSON API, не legacy Secure Payments: `POST
/ecomm/gw/partner/api/v1/*.do`, `userName`/`password` в теле каждого вызова,
регистрация → `formUrl` → hosted-форма/ACS → серверная сверка
`getOrderStatusExtended.do`.

## Быстрый старт

```bash
npm run start:sber          # http://localhost:3105
# или общий локальный стенд:
docker compose up -d sber-mock
```

Node ≥ 18, zero npm dependencies. Синтетические дефолты —
`SBERMOCKTEST` / `mockpass123`; это не тестовые креды банка. Фактические env
значения при запуске скрыты в логах. Банк выдаёт реальные тестовые
`userName`/`password` подключённому merchant отдельно; не помещайте их в код,
тесты, fixtures или общий compose-файл.

## Поддерживаемый Ecom-поток

| Маршрут | Назначение |
| --- | --- |
| `POST /ecomm/gw/partner/api/v1/register.do` | регистрация одностадийного заказа → `{orderId, formUrl}` |
| `POST /ecomm/gw/partner/api/v1/registerPreAuth.do` | регистрация заказа с холдом; контролируется `MOCK_SBER_TWO_STAGE` |
| `POST /ecomm/gw/partner/api/v1/deposit.do` | списание суммы, не выше авторизованной; частичное подтверждение поддержано |
| `POST /ecomm/gw/partner/api/v1/reverse.do` | отмена холда/доступной для reversal оплаты |
| `POST /ecomm/gw/partner/api/v1/refund.do` | полный/частичный refund в пределах ещё не возвращённого списания |
| `POST /ecomm/gw/partner/api/v1/decline.do` | отмена до первой попытки ввода карточных данных |
| `POST /ecomm/gw/partner/api/v1/getOrderStatusExtended.do` | серверная сверка заказа; `orderStatus` — отдельный от `actionCode` статус |
| `GET /payment/{orderId}` | тестовая hosted-форма с карточными пресетами |
| `POST /payment/{orderId}/pay`, `POST /payment/{orderId}/3ds` | тестовая форма и ACS; ACS-пароль `111111` |
| `GET /health`, `GET /openapi.json` | healthcheck и OpenAPI 3.1 |
| `GET /admin`, `GET /admin/journal`, `POST /admin/action` | консоль заказов, очереди callback и журнала; действия защищены same-origin + CSRF |
| `/mock/time`, `/mock/scenarios`, `/mock/state`, `/mock/reset` | виртуальные часы, хаос/сценарии и состояние песочницы |
| `/sandboxes*`, `/mock/sandboxes` | RFC-001 sandbox/control-plane API |

`paymentOrder.do` не реализован: это прямой карточный server-to-server флоу, доступность которого требует merchant-разрешения; выносить его за scope без владельца нельзя. SberPay/SBP Sandbox, СБП и `orderBundle` также не входят в адаптер.

REST-тело — JSON UTF-8 (`Content-Type: application/json`), валюта только RUB
`643`, суммы — целые копейки. Merchant `orderNumber` уникален в рамках
песочницы; повтор не переигрывает исходный запрос. По умолчанию заказ живёт
1200 секунд и имеет не более трёх попыток оплаты. Детальные примеры
регистрации, оплаты, deposit/refund и callback находятся в
[гайде интегратора](../../docs/integration/sber.md).

`errorCode=0` означает, что обработан конкретный REST-вызов, а не то, что
платёж успешен. Источник истины по заказу — числовой `orderStatus` 0…6;
`actionCode`/`actionCodeDescription` описывают результат/причину операции и не
подменяют состояние заказа. Состояния и переходы сведены в
[конспекте протокола](../../docs/reference/sber/01-payment-api.md).

## Callback Ecom

Исходящее Ecom callback — HTTP `POST` JSON без подписи или checksum, с `mdOrder`, `orderNumber`,
`operation`, числовым `status` (`1`/`0`) и опциональным `additionalParams`.
Поддержанные операции: `created`, `approved`, `deposited`, `reversed`,
`refunded`, `declinedByTimeout`. Только HTTP 200 считается ACK. По умолчанию
очередь делает три попытки с интервалом 60 секунд; локальные виртуальные часы
ускоряют retry. Для регистрации callback URL задаётся в `dynamicCallbackUrl`,
либо глобально через `MOCK_SBER_CALLBACK_URL`.

**Подписи/`checksum` в Ecom callback нет.** Мок не использует и не эмулирует
подпись legacy Secure Payments. Неподписанный callback — сигнал к повторной
серверной сверке `getOrderStatusExtended.do`, а не доказательство успешной
оплаты. В отсутствии callback URL очередь не создаётся.

## Ошибки и протокольные оговорки

Ответы бизнес-ошибок моделируются как HTTP 200 + `{errorCode,errorMessage}`;
`field`, `hint` и `doc` — диагностическое расширение мока. HTTP 400/404/405/413/
415/500 применяется к транспортным/инфраструктурным ошибкам. Числа 1…6 и
частные соответствия (дубликат, авторизация, неизвестный заказ, неверное
состояние, сумма/валидация, системная ошибка) — **[VERIFY]/[FORK]**: локальный
срез Ecom фиксирует envelope и отдельные описанные ошибки, но не полный
merchant-каталог `errorCode`. Не используйте эти маппинги как обещание
production-шлюза; перед точным контрактным тестом их нужно сверить с
подключённым Ecom merchant и владельцем проекта.

`orderStatus` 0…6 документирован в reference для общего семейства Ecom/RBS.
Повторяемые test-card action codes 101 и 116 — сценарии официальных тестовых
карт. Всё прочее, где публичный Ecom-срез неполон, остаётся явным мок-форком,
а не добавляется под видом подтверждённого протокола.

## Сценарии, часы и диагностика

`X-Mock-Scenario`/`/mock/scenarios` поддерживают `fail`, `hang`, `latency`,
`http-500`, `http-504`, `webhook-drop`/`no-callback` и
`webhook-duplicate`/`callback-duplicate`. REST chaos с `abortStatus` происходит
до бизнес-операции. Карточные отказы выбираются официальными тестовыми
пресетами. `POST /mock/time` принимает, например,
`{"advance":"+20m"}` для истечения заказа или `{"advance":"+60s"}` для
повторной доставки callback.

Сценарии, их история, журнал и состояние изолируются по `X-Mock-Sandbox`.
Журнал redacts чувствительные поля; PAN не пишется в REST-журнал и не
сохраняется в заказе — в заказе остаётся только маска `first6**last4`. В
hosted-режиме SSRF-проверка исходящих callback включается по умолчанию;
`SSRF_BLOCKED` — терминальный отказ без повтора.

## Переменные окружения

| Переменная | Default | Назначение |
| --- | --- | --- |
| `MOCK_HOST` / `MOCK_PORT` | `0.0.0.0` / `3105` | адрес и порт HTTP-сервера |
| `MOCK_SBER_USERNAME` | `SBERMOCKTEST` | синтетический merchant-логин |
| `MOCK_SBER_PASSWORD` | `mockpass123` | синтетический пароль |
| `MOCK_SBER_PUBLIC_BASE_URL` | `http://localhost:${MOCK_SBER_HOST_PORT:-3105}` | внешний base URL, используемый в `formUrl` |
| `MOCK_SBER_CALLBACK_URL` | пусто | callback URL стенда по умолчанию; `dynamicCallbackUrl` регистрации приоритетнее |
| `MOCK_SBER_CALLBACK_RETRY_MS` | `60000` (`60s`) | интервал retry; число в миллисекундах либо длительность (`60s`, `1m`) |
| `MOCK_SBER_CALLBACK_MAX_ATTEMPTS` | `3` | максимум доставок; значение меньше 1 нормализуется в 1 |
| `MOCK_SBER_SESSION_TIMEOUT_SECS` | `1200` | срок нового заказа в секундах; поддерживает длительность (`20m`, `1h`); registration field `sessionTimeoutSecs` переопределяет его для конкретного заказа |
| `MOCK_SBER_TWO_STAGE` | `true` | разрешить `registerPreAuth.do` в локальном стенде |
| `MOCK_STATE_FILE` | пусто | сохранение доменного состояния/очереди между рестартами |
| `MOCK_SANDBOX_FILE` | `<MOCK_STATE_FILE>.sandboxes.json` | база RFC-001 реестра песочниц (обычно следует суффиксу файла состояния) |
| `MOCK_SANDBOX_SWEEP_MS` | `60000` | интервал sweep TTL/retention, когда worker включён |
| `MOCK_BLOCK_PRIVATE_WEBHOOKS` | `false` (hosted → `true`) | запрет исходящих callback в private/reserved адреса; SSRF-отказ терминален |
| `MOCK_VIRTUAL_CLOCK` | текущее время | начальное значение виртуальных часов |
| `MOCK_ADMIN_TOKEN` / `MOCK_OPERATOR_TOKEN` | пусто | защита управляющих `/admin*` и `/mock/*` |
| `MOCK_HOSTED` | `false` | `true` включает hosted fail-closed для управляющих поверхностей и default SSRF-защиту |
| `MOCK_TENANCY` | авто | sandbox-модель RFC-001 (`off`, `namespaces`, `owned`) |
| `MOCK_SANDBOX_TOKEN` | пусто | owner-token default sandbox в `owned`-модели |
| `MOCK_SANDBOX_TTL_MS` / `MOCK_SANDBOX_MAX` | `owned: 24h` / `owned: 100` | аренда и число песочниц; shared sandbox-настройки ядра |
| `MOCK_SANDBOX_MAX_DOCUMENTS` | `owned: 5000` | квота заказов + callback-документов на sandbox |
| `MOCK_SANDBOX_RETENTION_MS` | `0` | retention терминальных callback-записей; заказы не удаляются |
| `MOCK_SANDBOX_HOST_SUFFIX` | пусто | опциональный hostname-формат sandbox URL |
| `MOCK_SANDBOX_CREATE_LIMIT` | `owned: 20` | rate-limit создания sandbox на IP |

## Протокольные файлы и тесты

- Манифест drift-проверки: [`protocols/sber-ecom.json`](../../protocols/sber-ecom.json).
- OpenAPI: [`docs/openapi/sber-mock.openapi.json`](../../docs/openapi/sber-mock.openapi.json), также `GET /openapi.json`.
- Selftest (callback/retry/SSRF, RFC-001 и доменные ветки): `npm run test:sber`.
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
