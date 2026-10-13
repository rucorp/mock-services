© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# yookassa-mock — мок-стенд ЮKassa (REST /v3)

Первый внешний банк-адаптер стенда (issue #33, Stage 2): мок воспроизводит
мерчантский API ЮKassa по официальной документации
(https://yookassa.ru/developers) — Basic Auth, `Idempotence-Key`, платежи
`pending → waiting_for_capture → succeeded | canceled`, возвраты,
confirmation-страница с тестовыми картами и вебхуки `{type, event, object}`
без подписи (ACK — ровно HTTP 200). Исходная исследовательская база —
`docs/reference/yookassa/*`; публичный гайд — `docs/integration/yookassa.md`.

Node.js >= 18; внешние npm-зависимости не нужны. Все слои переиспользованы из
`packages/core` по паттерну tbank-mock: журнал с редакцией секретов и curl,
очередь доставки вебхуков (ретраи, SSRF-guard), сценарный реестр, виртуальные
часы, control-plane токены, sandbox runtime RFC-001.

## Зачем

Реальный тестовый контур ЮKassa требует договора и секретных ключей в кабинете.
Мок даёт управляемые локальные сценарии: two-stage-холд с частичным capture,
отказы карт с честными `cancellation_details`, ретраи/дубли вебхуков, истечение
холда по виртуальным часам — всё без обращения к боевому API.

## Запуск

```bash
docker compose up -d yookassa-mock       # порт 3102
# или голым node
npm run start:yookassa
```

Стартовый лог печатает дефолтные тестовые креды:

```
[yookassa-mock] basic auth: shopId=YOOKASSAMOCKTEST secret=mockpass123 (тестовые креды, MOCK_SHOP_ID/MOCK_SECRET_KEY переопределяют)
```

Самотест (246 проверок: контракт /v3, идемпотентность, карты, вебхуки,
сценарии, часы, песочницы, рестарт, control-plane):

```bash
npm run test:yookassa
```

## API

| Маршрут | Поведение |
|---|---|
| `POST /v3/payments` | создаёт платёж: `amount` (decimal-строка, только `RUB`), `capture` (не передан → `true`), `confirmation.type=redirect` + `return_url`, `description` ≤128, `metadata` ≤16 ключей. Ответ — объект платежа `pending` + `confirmation.confirmation_url` |
| `GET /v3/payments` | `{type:"list", items, next_cursor}` (без фильтров/пагинации — см. «Границы») |
| `GET /v3/payments/{id}` | объект платежа; неизвестный id → `404 not_found` c `parameter: payment_id` |
| `POST /v3/payments/{id}/capture` | принимает hold: без `amount` — полный, с `amount` ≤ авторизованного — частичный (лимит возвратов = удержанная сумма). Только из `waiting_for_capture` |
| `POST /v3/payments/{id}/cancel` | отмена мерчантом: `cancellation_details {party:"merchant", reason:"canceled_by_merchant"}`. Только из `pending`/`waiting_for_capture` |
| `POST /v3/refunds` | возврат по `succeeded`-платежу: `payment_id` + `amount`; `MOCK_REFUND_DELAY_MS=0` (дефолт) — сразу `succeeded`, как в официальных примерах; иначе `pending` → `succeeded` по тику |
| `GET /v3/refunds` | `{type:"list", items, next_cursor}` |
| `GET /v3/refunds/{id}` | объект возврата; неизвестный id → `404 not_found` c `parameter: refund_id` |
| `GET /payment/{id}` | confirmation-страница (тестовые карты, пресеты) |
| `POST /payment/{id}/pay`, `/3ds` | оплата картой, 3DS-challenge; успех и отказ ведут `302` на `return_url` |
| `GET /health`, `GET /admin`, `GET /admin/journal` | healthcheck и админ-консоль с curl-сниппетами |
| `/mock/time`, `/mock/scenarios`, `/mock/state`, `/mock/reset`, `/sandboxes*` | общий control-plane (см. `packages/core/README.md`) |

Успешный ответ всех операций — **HTTP 200** с объектом (как у ЮKassa).

## Машинка статусов

```
pending ──оплата capture=true──► succeeded ──► возвраты (refunded_amount растёт)
   │                               ▲
   │ оплата capture=false          │ capture (полный/частичный)
   ▼                               │
waiting_for_capture ───────────────┘
   │
   ├── cancel (merchant) ───────────────► canceled
   ├── истечение холда (7 дней) ────────► canceled {yoo_money, expired_on_capture}
pending
   ├── отказ карты на форме ────────────► canceled {party/ reason из таблицы}
   ├── cancel (merchant) ───────────────► canceled {merchant, canceled_by_merchant}
   └── MOCK_PENDING_TTL_MS > 0, истёк ──► canceled {yoo_money, expired_on_confirmation}
```

`party` для отказов карт — по официальной таблице declined-payments:
`payment_network` (эмитент/схема: insufficient_funds, call_issuer, …),
`yoo_money` (fraud_suspected — блокировка ЮKassa), `merchant` (API-отмена).

## Auth и идемпотентность

- **Basic Auth** на все `/v3/*`: `Authorization: Basic base64(shopId:secretKey)`.
  Дефолт `YOOKASSAMOCKTEST:mockpass123`; переопределяется `MOCK_SHOP_ID` /
  `MOCK_SECRET_KEY` (или `YOOKASSA_*`). Неверные креды → `401 invalid_credentials`.
- **`Idempotence-Key` обязателен для POST /v3** (≤64 символов):
  - ключа нет → `400 invalid_request`, `parameter: Idempotence-Key`,
    официальный текст `Idempotence key is missing. …`;
  - повтор того же ключа с тем же endpoint и телом → сохранённый ответ
    «как есть» (заголовок `X-Idempotence-Replayed: 1`), повтор не создаёт
    второй платёж;
  - тот же ключ с другим телом → `400 invalid_request` «Idempotence key duplicated»;
  - хэш считается по raw-телу; ключи живут в state (переживают рестарт), FIFO
    на `1000` записей;
  - GET ключ не требует.

## Ошибки (формат ЮKassa + DX)

```json
{
  "type": "error",
  "id": "2b6…uuid",
  "code": "invalid_request",
  "description": "Invalid parameter's value: amount.value must be …",
  "parameter": "amount.value",
  "hint": "…человекочитаемое объяснение на русском…",
  "doc": "https://yookassa.ru/developers/…"
}
```

HTTP-маппинг (как в официальном response-handling): `400 invalid_request`,
`401 invalid_credentials`, `403 forbidden`, `404 not_found`,
`429 too_many_requests`, `500 internal_server_error`. Поля `hint` и `doc` —
DX-слой мока (не часть протокола ЮKassa): каждое отклонение объясняет, что
поправить и где это описано в документации.

**Форк (решение координатора):** `405`/`415` отдаются с **пустым телом** —
как в официальной документации ЮKassa; DX-слой эти два кода не покрывает.

## Confirmation-страница и тестовые карты

`confirmation.confirmation_url` ведёт на `/payment/{id}` — страница с пресетами
тестовых карт (`docs/reference/yookassa/03-testing.md`):

- успех: `5555555555554444`, `4111111111111111`, `4175001000000017` (без 3DS),
  `5555555555554477`, `4793128161644804` (3DS-challenge, код — любые ≥4 цифр);
- отказы по причинам: `5555555555554600` → `insufficient_funds`,
  `5555555555554618` → `invalid_card_number`, `5555555555554592` →
  `3d_secure_failed`, `5555555555554568` → `fraud_suspected` и т.д. (в README
  гайда — полная таблица);
- неизвестная Luhn-валидная карта → `general_decline`; невалидный Luhn →
  `invalid_card_number`; просроченный срок → `card_expired`;
- форматные ошибки формы (не цифры, кривой CVC) показываются на странице и
  **не** меняют платёж.

В state попадают только `first6`/`last4`/срок — полный PAN не хранится и не
попадает в журнал (F-10).

## Вебхуки

`{ "type": "notification", "event": "…", "object": {…} }` на
`MOCK_DEFAULT_WEBHOOK_URL` (или mock-расширение `metadata.webhook_url` у
платежа — переопределяет адрес). События: `payment.succeeded`,
`payment.waiting_for_capture`, `payment.canceled`, `refund.succeeded` — на
каждый переход статуса. Подписи нет (протокол ЮKassa её не предусматривает —
проверять нечего, «изобретать» не нужно). ACK — **ровно HTTP 200**, тело
игнорируется: до 200 доставка повторяется (`MOCK_RETRY_MS` ×
`MOCK_MAX_ATTEMPTS`); очередь, ретраи, SSRF-guard — ядро
(`createDeliveryQueue`). Сценарии `webhook-drop|no-webhook` подавляют
событие, `webhook-duplicate` кладёт две копии (приёмник должен быть
идемпотентен — кнопка «повторить» есть в `/admin`).

## Сценарии (X-Mock-Scenario и /mock/scenarios)

| Сценарий | Эффект |
|---|---|
| `fail` | POST /v3 → `500 internal_server_error` в формате ЮKassa, бизнес не выполняется |
| `hang` | запрос не получает ответа (проверяйте таймауты клиента) |
| `latency:2s`, `X-Mock-Latency` | задержка ответа (ядро) |
| `http-500`, `http-504` | сетевой сбой до бизнес-логики (ядро, `abortStatus`) |
| `webhook-drop`, `no-webhook` | подавить вебхуки перехода |
| `webhook-duplicate` | две копии события |

Правила без заголовка — `POST /mock/scenarios {scenario, target, match, times}`.
История триггеров — `GET /mock/scenarios`.

Правила, история срабатываний и журнал `/admin/journal` принадлежат текущей песочнице (#52): другие песочницы их не видят и не очищают, `POST /mock/reset` действует только на целевую песочницу. Лимиты: до 200 правил на песочницу и до 8 KiB на правило (превышение — HTTP 400 с `code` `rule_cap_exceeded`/`rule_too_large`).

## Виртуальные часы и TTL

- холд `waiting_for_capture`: 7 дней (`MOCK_CAPTURE_TTL_MS`, как в докам для
  карт) → авто-отмена `expired_on_capture`; ускоряется `POST /mock/time
  {"advance":"+7d"}` — проверка в selftest;
- `pending`: `MOCK_PENDING_TTL_MS` (0 — выключено) → `expired_on_confirmation`;
- `MOCK_REFUND_DELAY_MS` — задержка финализации возврата (0 — сразу
  `succeeded`, дефолт как в официальных примерах).

## Переменные окружения

| Переменная | Дефолт | Назначение |
|---|---|---|
| `MOCK_PORT` | `3102` | порт |
| `MOCK_SHOP_ID` / `MOCK_SECRET_KEY` | `YOOKASSAMOCKTEST` / `mockpass123` | Basic-креды (алиасы `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY`) |
| `MOCK_PUBLIC_BASE_URL` | `http://localhost:3102` | база `confirmation_url` |
| `MOCK_DEFAULT_WEBHOOK_URL` | — | приёмник вебхуков магазина |
| `MOCK_RETRY_MS` / `MOCK_MAX_ATTEMPTS` | `60000` / `24` | ретраи вебхуков (в selftest — 1000) |
| `MOCK_CAPTURE_TTL_MS` | 7 дней | удержание `waiting_for_capture` |
| `MOCK_PENDING_TTL_MS` | `0` | авто-отмена `pending` (0 — выкл.) |
| `MOCK_REFUND_DELAY_MS` | `0` | задержка финализации возврата |
| `MOCK_STATE_FILE` | — | файл состояния (compose: `/data/yookassa-state.json`) |
| `MOCK_BLOCK_PRIVATE_WEBHOOKS` | с `MOCK_HOSTED` | SSRF-guard исходящих вебхуков |
| `MOCK_ADMIN_TOKEN`, `MOCK_OPERATOR_TOKEN`, `MOCK_HOSTED`, `MOCK_TENANCY`, `MOCK_SANDBOX_*` | — | общий control-plane (см. README ядра) |

## Границы и документированные форки

Что мок **не** делает (осознанно, вне scope #33):

- `receipt` принимается и хранится как есть, но **не валидируется** и не
  фискализируется (54-ФЗ — в `kassa-mock`);
- `save_payment_method`, рекурренты, `transfers`/`deal`, `payment_token`
  (Checkout.js) не моделируются;
- списки `GET /v3/payments|refunds` — без фильтров и курсорной пагинации
  (`next_cursor: null`);
- confirmation кроме `redirect` (`embedded` и др.) → `400` с hint;
- `/openapi.json` и манифест `protocols/yookassa.json` не ведутся (не в DoD
  #33; дрейф-чекер их не покрывает);
- `/mock/verify-merchant` не реализован: вебхуки ЮKassa не подписаны, ветка
  ядра `verifyMerchantWebhook` умеет tbank/ferma, а правка ядра требует
  санкции координатора (вопрос вынесен в отчёт PR);
- `405`/`415` — пустое тело (официальная семантика; см. выше), `capture` при
  создании не передан → `true` (простой сценарий quick-start; серверный
  дефолт ЮKassa официально не документирован);
- `metadata.webhook_url` — mock-расширение для подмены адреса приёмника
  конкретного платежа (в бою metadata — «чёрный ящик», протокол не нарушает).

Контракты `tbank-mock` и `kassa-mock` не менялись (selftest: 38/48+129/0).
