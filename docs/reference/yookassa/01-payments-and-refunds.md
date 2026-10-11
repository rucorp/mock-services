© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# ЮKassa — платежи, статусы и возвраты

Срез официальных материалов на 2026-10-11. Для Stage 1 выбран агрегатор ЮKassa (не Robokassa) по критерию открытости публичной API-документации.

## Первичные источники

- [Формат взаимодействия с API](https://yookassa.ru/developers/using-api/interaction-format)
- [Процесс платежа](https://yookassa.ru/developers/payment-acceptance/getting-started/payment-process)
- [OpenAPI спецификация](https://yookassa.ru/developers/using-api/openapi-specification)

## Транспорт и аутентификация

- API base: `https://api.yookassa.ru/v3`.
- HTTPS, JSON; merchant `shopId` и секретный ключ в HTTP Basic Auth (`shopId:secretKey`). Для test-режима используются отдельные данные demo-магазина; base URL тот же.
- Для `POST` и `DELETE` передавать `Idempotence-Key`, уникальный для логической операции, длина до 64 символов. Повтор сетевого запроса должен сохранять этот ключ; новый ключ означает новую попытку/операцию.
- Денежное поле `amount.value` — десятичная строка (`"100.00"`), `amount.currency` — код ISO, обычно `RUB`. Не переводить в копейки по примеру Т-Банка.

## Платёжный поток

1. `POST /payments` создаёт платёж. Минимальная бизнес-модель: `amount`, `capture`, `confirmation` (например, `type: "redirect"`, `return_url`) и при необходимости `description`, `metadata`, `payment_method_data`, `receipt`. В ответе сохранять `id`, `status`, `confirmation.confirmation_url` и `test`.
2. Состояния: `pending` — ожидает действий/результата; `waiting_for_capture` — авторизован и ожидает capture при `capture=false`; `succeeded` — успешно списан; `canceled` — прекращён. Редирект покупателя не является финальным результатом.
3. `POST /payments/{payment_id}/capture` завершает двухстадийный платёж; запрос может содержать сумму не больше авторизованной.
4. `POST /payments/{payment_id}/cancel` отменяет платёж, пока это допускает его состояние (например, `pending`/`waiting_for_capture`).
5. `GET /payments/{payment_id}` — серверная проверка текущего состояния.
6. `POST /refunds` создаёт полный или частичный возврат к `payment_id`; сохранять `refund.id` и отслеживать результат отдельно. `GET /refunds/{refund_id}` — сверка.

Создание/захват/отмена/возврат — разные операции и разные объекты. Для каждой POST использовать собственный стабильный `Idempotence-Key`; сохранять банковский объект до ответа клиенту и сверять состояние после timeout.

## Отличие от существующего `tbank-mock`

T-Банк использует `Amount` в копейках, поле подписи `Token`, методы `Init/Confirm/Cancel` и статусы вроде `AUTHORIZED/CONFIRMED`. ЮKassa — REST `/v3`, Basic Auth, decimal-string RUB, `Idempotence-Key`, объект `payment`/`refund` и статусы `pending/waiting_for_capture/succeeded/canceled`. Прямой контрактной совместимости нет.
