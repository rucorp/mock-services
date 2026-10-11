© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Альфа-Банк — интернет-эквайринг REST

Срез официальных материалов на 2026-10-11. Альфа-портал показывает разные инструкции в зависимости от типа merchant-логина; адреса и набор включённых функций нужно брать для конкретной учётной записи.

## Первичные источники

- [Интерфейс REST и спецификации запросов](https://alfabank.ru/sme/payservice/internet-acquiring/docs/connection-options/api/rest/)
- [Описание способов взаимодействия и координаты подключения](https://alfabank.ru/sme/payservice/internet-acquiring/docs/connection-options/api/general-description/)
- [Схемы интеграции](https://alfabank.ru/sme/payservice/internet-acquiring/docs/connection-options/api/integration-schemes/)

## Транспорт и доступ

| Контур | REST base |
|---|---|
| Тест | `https://alfa.rbsuat.com/payment/rest` |
| Production | `https://payment.alfabank.ru/payment/rest` (для части merchant-логинов/схем URL отличается) |

Методы вызываются `POST`; запросы REST передают именованные параметры формы, ответы — JSON. Основные merchant credentials — `userName` и `password`; логин без префикса, `r-логин` и `i-логин` могут иметь разные координаты и инструкции. Сумма передаётся в минимальных единицах валюты (для RUB — копейки). `orderNumber` должен быть уникальным в пределах магазина.

## Создание и проведение платежа

| Метод | Назначение |
|---|---|
| `register.do` | Создать заказ для одностадийной оплаты; обязательные данные включают `userName`, `password`, `orderNumber`, `amount`, `returnUrl`. Для двухстадийной схемы/связанного сценария могут быть нужны `failUrl`, `clientId`, `email`, `phone`, `sessionTimeoutSecs`, `jsonParams` и/или `orderBundle`. |
| `registerPreAuth.do` | Создать заказ с предавторизацией (холд); доступность двухстадийной схемы включается банком. |
| `deposit.do` | Завершить холд и списать сумму в пределах авторизованной. |
| `reverse.do` | Снять холд/отменить оплату до окончательного расчёта. |
| `refund.do` | Вернуть уже списанные средства; возможно частичное возмещение в разрешённом контуре. |
| `getOrderStatus.do` / `getOrderStatusExtended.do` | Получить текущий/расширенный статус сервер-сервер. |

Успешная регистрация возвращает `orderId` и `formUrl`; пользователя перенаправляют на платёжную страницу. `errorCode = 0` — результат обработки API-вызова, не эквивалент финального статуса оплаты. После возврата браузера, таймаута или callback сверять `orderId` через метод статуса. В расширенном ответе различать состояние заказа, сумму авторизации/списания/возврата и код ответа шлюза.

## Отличие от имеющегося `tbank-mock`

`services/tbank-mock` реализует JSON `POST /v2/*`, подпись Token и статусы Т-Банка. Альфа использует REST base с `*.do`, форму запроса, `userName/password`, `orderId/formUrl` и собственную настройку callback/подписи. Похожи только бизнес-операции; использовать tbank-маршруты или алгоритм подписи Token как совместимую замену нельзя.
