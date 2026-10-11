© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# ВТБ — SMB API интернет-эквайринга

Срез публичного developer-портала ВТБ на 2026-10-11. Описанный здесь SMB API не следует смешивать с legacy RBS REST API из старой инструкции v7.

## Первичные источники

- [Публичный портал API интернет-эквайринга ВТБ](https://test-pay.vtb.ru/api-developer-docs/) — разделы [тестовой среды](https://test-pay.vtb.ru/api-developer-docs/#/where_to_start/test_environment), [промышленной среды](https://test-pay.vtb.ru/api-developer-docs/#/where_to_start/prod_environment), [аутентификации](https://test-pay.vtb.ru/api-developer-docs/#/where_to_start/auth_headers), [операций с ордерами](https://test-pay.vtb.ru/api-developer-docs/#/api-ecomm/orders).
- [Уведомление (callback)](https://test-pay.vtb.ru/api-developer-docs/#/services/callback), [payment callback](https://test-pay.vtb.ru/api-developer-docs/#/services/payment_callback), [refund callback](https://test-pay.vtb.ru/api-developer-docs/#/services/refund_callback).
- [Старая инструкция API v7 для мерчанта (PDF)](https://db.vtb.ru/fe-lk-internet-acquiring/docs/docs/%D0%98%D0%BD%D1%81%D1%82%D1%80%D1%83%D0%BA%D1%86%D0%B8%D1%8F_%D0%BF%D0%BE_API_%D0%BF%D0%BB%D0%B0%D1%82%D1%91%D0%B6%D0%BD%D0%BE%D0%B3%D0%BE_%D1%88%D0%BB%D1%8E%D0%B7%D0%B0_%D0%B4%D0%BB%D1%8F_%D0%BC%D0%B5%D1%80%D1%87%D0%B0%D0%BD%D1%82%D0%B0_v7_20230620.pdf) — только для legacy-контракта.

## Доступ и транспорт

| Контур | E-commerce API base |
|---|---|
| Test | `https://test3.api.vtb.ru:8443/openapi/smb/efcp/e-commerce/v1/` |
| Production | `https://gw.api.vtb.ru/openapi/smb/efcp/e-commerce/v1/` |

Для **test** OAuth 2.0 Client Credentials: `POST https://epa-ift-sbp.vtb.ru:443/passport/oauth2/token`, `Content-Type: application/x-www-form-urlencoded`, тело `grant_type=client_credentials&client_id=...&client_secret=...`. Ответ содержит `access_token`, `token_type=Bearer`, `expires_in`; срок обычно около 170 секунд, планировать обновление по `expires_in`. Для production получить адрес менеджера доступа из production-инструкции/настроек банка; не переиспользовать тестовые credentials или выводить production auth URL из тестового.

Для бизнес-запросов передавать `Authorization: Bearer <access_token>`, `X-IBM-Client-Id` (значение client_id в нижнем регистре, без `@ext.vtb.ru`) и `Content-Type: application/json`. `Merchant-Authorization` необязателен для одного ресурса, обязателен при нескольких ресурсах согласно настройке банка. `X-IBM-Client-Id` и `Merchant-Authorization` отправляются только на API, не в token endpoint. Секреты/идентификаторы ресурса — конфиденциальные.

## Ордеры, платежи и возвраты

Пути в таблице относительны соответствующему API base выше (включая `/v1/`).

| Метод | Путь | Назначение |
|---|---|---|
| `POST` | `/orders` | Создать ордер; обязательны уникальный merchant `orderId`, `orderName`, `amount: {value, code: "RUB"}`. Может возвращать `payUrl`. Повтор с тем же `orderId` идемпотентен и возвращает существующий ордер. |
| `GET` | `/orders/{orderId}` | Получить ордер, транзакции платежей/возвратов и статусы. |
| `POST` | `/orders/preauth` | Создать ордер с предавторизацией; нужно отдельное разрешение банка и объект `twoStageParams`. |
| `POST` | `/orders/complete/{orderId}` | Завершить холд, передав сумму `{value, code}` (не больше авторизованной). |
| `POST` | `/orders/{orderId}/cancel` | Отменить ордер; допускается `cancelReason`. |
| `POST` | `/refunds` | Полный/частичный возврат: merchant `refundId`, `paymentId`, `amount`. Идентификаторы возврата следует делать уникальными. |
| `GET` | `/refunds/{refundId}` | Получить статус возврата. |

Сумма передаётся десятичным значением в рублях, например `{ "value": 10.56, "code": "RUB" }`, а не целым числом копеек. Ордер по умолчанию истекает через 20 минут; при создании можно задать `expire` с timezone и миллисекундами. Операции возврата могут быть частичными.

В примерах и моделях встречаются статусы ордера `CREATED`, `PAID`, `REFUNDED`, `PARTIALLY_REFUNDED`, `CANCELED`; у операции/платежа свои статусы (`NEW`, `CONFIRMED`, `RECONCILED` в примерах). Обрабатывать поле `status.value` на том уровне объекта, к которому оно относится, а не смешивать статус ордера, платежа и возврата.

## Не путать с legacy

Legacy endpoints `https://vtb.rbsuat.com/payment/rest/` и production-адрес из старой инструкции относятся к другой RBS REST схеме, с `userName/password`, `application/x-www-form-urlencoded` и именами `register.do`, `paymentorder.do` и т. п. Это не альтернативная база для SMB `/openapi/smb/...`.

## Отличие от имеющегося `tbank-mock`

У Т-Банка JSON `/v2/*`, подпись Token и копеечные `Amount`. В SMB API ВТБ — короткоживущий OAuth Bearer + `X-IBM-Client-Id`, versioned `/orders`/`/refunds`, рублёвый объект суммы и отдельные сущности order/payment/refund. Переиспользовать tbank request validator или коды статусов нельзя.
