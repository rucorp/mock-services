© 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
SPDX-License-Identifier: Apache-2.0

# Интеграция: ЮKassa через mock (10 минут)

Мок воспроизводит мерчантский API ЮKassa (https://yookassa.ru/developers):
Basic Auth + `Idempotence-Key` + REST `/v3` (платежи/возвраты), confirmation-
страница с тестовыми картами, вебхуки `{type,event,object}` без подписи
(ACK — ровно HTTP 200). Статусы — официальные:
`pending → waiting_for_capture → succeeded | canceled`.

## 1. Поднять стенд

```bash
docker compose up yookassa-mock      # http://localhost:3102
# или без docker: npm run start:yookassa
```

Стартовый лог печатает тестовые креды:

```
shopId=YOOKASSAMOCKTEST  secret=mockpass123
```

Вебхуки: приёмник вашего сервиса должен быть доступен со стенда. Для
локальной проверки задайте `MOCK_DEFAULT_WEBHOOK_URL=http://host.docker.internal:8080/yookassa/webhook`
на стенде (или `metadata.webhook_url` конкретного платежа — mock-расширение).

## 2. Базовый флоу (одностадийный платёж)

```bash
# 1. Создать платёж (Idempotence-Key обязателен для всех POST!)
curl -s http://localhost:3102/v3/payments \
  -u YOOKASSAMOCKTEST:mockpass123 \
  -H 'Content-Type: application/json' \
  -H 'Idempotence-Key: order-42-create' \
  -d '{
    "amount": { "value": "100.00", "currency": "RUB" },
    "capture": true,
    "confirmation": { "type": "redirect", "return_url": "https://myapp.test/return" },
    "description": "Order No. 42",
    "metadata": { "order_id": "42" }
  }'
# → { "id": "…uuid", "status": "pending", "test": true, "confirmation": { "confirmation_url": … } }
```

2. Откройте `confirmation_url` в браузере и нажмите пресет тестовой карты
(`4111111111111111` — успех без 3DS, `5555555555554477` — успех с 3DS;
код 3DS — любые ≥4 цифр; `5555555555554600` — `insufficient_funds`, и т.д.,
полная таблица в `документации ЮKassa`). Браузер получит
`302` на ваш `return_url`.

3. Проверить статус (idempotent GET, ключ не нужен):

```bash
curl -s -u YOOKASSAMOCKTEST:mockpass123 http://localhost:3102/v3/payments/<id>
# → status: "succeeded", paid: true, refundable: true, refunded_amount: { value: "0.00" }
```

Или дождаться вебхука `payment.succeeded`.

## 3. Two-stage (hold → capture) и возвраты

```bash
# холд: capture=false, после оплаты статус waiting_for_capture (+ вебхук)
# подтвердить (полный или частичный — amount ≤ авторизованного):
curl -s -X POST http://localhost:3102/v3/payments/<id>/capture \
  -u YOOKASSAMOCKTEST:mockpass123 -H 'Idempotence-Key: order-42-capture' \
  -H 'Content-Type: application/json' -d '{ "amount": { "value": "40.00", "currency": "RUB" } }'

# отменить (только pending|waiting_for_capture):
curl -s -X POST http://localhost:3102/v3/payments/<id>/cancel \
  -u YOOKASSAMOCKTEST:mockpass123 -H 'Idempotence-Key: order-42-cancel'

# возврат (по succeeded; amount ≤ amount − refunded_amount):
curl -s -X POST http://localhost:3102/v3/refunds \
  -u YOOKASSAMOCKTEST:mockpass123 -H 'Idempotence-Key: order-42-refund-1' \
  -H 'Content-Type: application/json' \
  -d '{ "payment_id": "<id>", "amount": { "value": "30.00", "currency": "RUB" } }'
# → { "id": "…", "status": "succeeded", … }  (+ вебхук refund.succeeded)
```

Сверка: `GET /v3/payments/{id}` (поле `refunded_amount`) и
`GET /v3/refunds/{id}`.

## 4. Что мок проверяет за вас (важно для отладки)

| Ошибка интегратора | Ответ мока |
|---|---|
| нет `Authorization` / не тот secret | `401 invalid_credentials` |
| нет `Idempotence-Key` на POST | `400 invalid_request`, `parameter: Idempotence-Key`, официальный текст |
| повтор того же ключа с другим телом | `400` «Idempotence key duplicated» |
| сумма числом, не строкой; `>2` знака; `currency ≠ RUB` | `400`, `parameter: amount.value` / `amount.currency` |
| `confirmation.type ≠ redirect`, нет `return_url` | `400`, `parameter: confirmation.*` |
| `capture` из `pending`/`succeeded`/`canceled` | `400` с описанием текущего статуса |
| capture-сумма больше авторизованной | `400`, `parameter: amount` |
| возврат не по `succeeded` / больше `refundable` | `400`, `parameter: payment_id` / `amount` |
| неизвестный `payment_id`/`refund_id` | `404 not_found`, официальный текст |
| битый JSON в теле | `400` «Request body is not valid JSON» |

Каждая ошибка — `{type:"error", id, code, description, parameter?}` + `hint`
(что поправить) и `doc` (раздел доков ЮKassa). Журнал запросов с curl —
`GET /admin/journal` (секреты отредактированы).

## 5. Вебхуки, сценарии, часы

- События `payment.waiting_for_capture`, `payment.succeeded`,
  `payment.canceled`, `refund.succeeded` — на каждый переход статуса.
  Приёмник отвечает **200**; до 200 мок повторяет (`MOCK_RETRY_MS` ×
  `MOCK_MAX_ATTEMPTS`, в selftest — 1 с). Подписи нет — проверять нечего;
  принимайте событие идемпотентно (дубль можно послать кнопкой в `/admin`
  или сценарием).
- `X-Mock-Scenario: fail|hang|webhook-drop|webhook-duplicate|http-500|latency:2s`
  на запросе или правило `POST /mock/scenarios`.
- Холд живёт 7 дней: `POST /mock/time {"advance":"+7d"}` → авто-отмена
  `expired_on_capture` с вебхуком `payment.canceled`.

## 6. Чеклист готовности к бою

- [ ] все POST идут с уникальным `Idempotence-Key` на логическую операцию
      (повтор ключа при таймауте возвращает исходный ответ, а не дубль)
- [ ] вебхуки принимаются с ответом ровно 200 и обрабатываются
      идемпотентно (мок умеет слать дубли и ретраи)
- [ ] статус сверяется и по `return_url` (GET /v3/payments/{id}), а не только
      по редиректу — браузер его может не догнать
- [ ] суммы везде decimal-строки, валюта `RUB`; часы/деньги не считаете на
      клиенте по своим правилам — сверяетесь с объектом платежа
- [ ] для two-stage считаете возвраты от `captured`, а не от `amount`
      (частичный capture уменьшает `refundable`)
- [ ] переход на бой = смена URL (`api.yookassa.ru`) и секретов в кабинете;
      контракт запросов не меняется

## 7. Ссылки

- Контракт сервиса, env и `/mock/*`: [`services/yookassa-mock/README.md`](../../services/yookassa-mock/README.md)
- OpenAPI 3.1: отдельной спецификации у сервиса нет — публичный контракт `/v3` воспроизведён по официальной
  документации, см. раздел «OpenAPI» в [`services/yookassa-mock/README.md`](../../services/yookassa-mock/README.md)
- Манифеста `protocols/*.json` у сервиса нет
- Общая инфраструктура адаптеров (часы, песочницы, вебхуки, SSRF): [`packages/core/README.md`](../../packages/core/README.md)
