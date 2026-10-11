© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# ВТБ — callback и тестирование

Источники: [официальная документация API](https://test-pay.vtb.ru/api-developer-docs/), [callback](https://test-pay.vtb.ru/api-developer-docs/#/services/callback), [PaymentCallback](https://test-pay.vtb.ru/api-developer-docs/#/services/payment_callback), [RefundCallback](https://test-pay.vtb.ru/api-developer-docs/#/services/refund_callback), [legacy sandbox REST docs](https://sandbox.vtb.ru/sandbox/ru/integration/api/rest.html), [SMB API-конспект](01-smb-ecommerce-api.md).

## Уведомления

Мерчант заранее сообщает callback URL представителю/в настройках ресурса; одному ресурсу соответствует один URL. Шлюз отправляет `POST` с JSON. В документации типами уведомления названы `PaymentCallback` и `RefundCallback`; фактическое тело имеет общую оболочку `{"type":"PAYMENT|REFUND","object":{...}}`.

- Для платежа `type` равен `PAYMENT`; `object` содержит `paymentId`, `paymentCode`, `orderId`, `orderCode`, `createdAt`, `description`, `amount: {value, code: "RUB"}`, `paymentData`, статус и, для СБП, `sbpParams`. В примере оплаты картой поле статуса написано `Status` (с заглавной буквы), в примере СБП — `status` (строчными); считать это расхождением публичных примеров и сохранять исходный payload без нормализации до сверки с реальными ответами. Статусы-примеры: `CONFIRMED` для карты, `RECONCILED` для СБП.
- Для возврата `type` равен `REFUND`; `object` включает `refundId`, `paymentId`, `paymentCode`, `orderId`, `orderCode`, `createdAt`, `amount`, `status`, а в СБП-сценарии — `sbpParams`. Примеры содержат `CONFIRMED` для карты и `RECONCILED` для СБП.

Официальная инструкция прямо советует после callback выполнить `GET /v1/orders/{orderId}` или `GET /v1/refunds/{refundId}`: уведомление нельзя считать единственным источником истины. В публичных SMB-инструкциях не обнаружены callback-подпись, обязательный ACK-код и расписание повторов; не придумывать их и не заимствовать legacy callback-правила.

## Тестовый контур

Перед каждым новым запросом к песочнице запросить актуальный access token. Официальный тестовый API host: `https://test3.api.vtb.ru:8443`; полный e-commerce base см. [API-конспект](01-smb-ecommerce-api.md). Доступ и client credentials выдаются банком. Тестирование — обязательный этап до допуска в Production.

Публичный SMB-раздел перечисляет карту `4111 1111 1111 1111`, срок `12/24`, CVV `123`; срок истёк до даты среза 2026-10-11, поэтому карта как опубликована непригодна для проверки. Не подставлять вместо неё карту из другого VTB API без подтверждения банка.

В legacy VTB sandbox REST-примере отдельно приведена карта `4000 0011 1111 1118`, 12/2030, CVC `123` для `paymentorder.do` на `vtb.rbsuat.com`. Это данные **только старой REST-песочницы**, не SMB API.

Для СБП тестовый портал предоставляет заглушки:

- `POST https://qr-efcp.bankingapi.ru/qr/success` — имитация успешной оплаты;
- `POST https://qr-efcp.bankingapi.ru/qr/fail` — имитация неуспешной оплаты.

В обоих запросах передать JSON `{"qrCodeLink":"<link, выданный при создании тестового QR>"}`. Портал предлагает извлечь точный link из запроса `sbp-link` в Network панели браузера; не подменять его произвольной ссылкой.

## Отличие от текущих моков

`tbank-mock` подписывает уведомление Token и моделирует точные статусы Т-Банка. Для ВТБ нужны другие callback JSON-типы и дополнительный GET статуса после уведомления. `kassa-mock` — фискальная касса Ferma и к банковским callback не относится.
