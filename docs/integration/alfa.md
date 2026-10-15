© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Интеграция: интернет-эквайринг Альфа-Банка через mock (10 минут)

Мок воспроизводит **REST-интерфейс шлюза Альфа-Банка** (`/payment/rest/*.do`,
платформа RBS) по публичной документации: регистрация заказа с
form-параметрами, платёжная страница `formUrl` с тестовыми картами и ACS,
статусы `getOrderStatus(Extended).do`, двухстадийная схема
(`registerPreAuth` → `deposit`), `reverse`, полный/частичный `refund` и
callback-уведомления **HTTP GET** с симметричным checksum **HMAC-SHA256**.
Источники: официальные разделы — [REST-интерфейс](https://alfabank.ru/sme/payservice/internet-acquiring/docs/connection-options/api/rest/),
[тестовые карты](https://alfabank.ru/sme/payservice/internet-acquiring/docs/connection-options/api/test-cards/).

> **Это не Т-Банк и не drop-in.** Маршруты — `POST /payment/rest/*.do` с
> `application/x-www-form-urlencoded` (у Т-Банка JSON `POST /v2/*`), креды —
> `userName`/`password` в каждом запросе (у Т-Банка `TerminalKey` + подпись
> `Token`), ответ регистрации — `{orderId, formUrl}` с `errorCode`/`errorMessage`
> (у Т-Банка `{Success, Status, PaymentId}`), callback — **GET с query**
> (у Т-Банка подписанный POST), статусы — числовые `orderStatus 0…6`
> (у Т-Банка строковые `NEW/AUTHORIZED/…`). Перенос кода между банками
> неизбежен; мок подсказывает расхождения в `hint`.

**Вне области стенда:** асимметричный режим checksum (официальный PDF
противоречив: описание говорит SHA-256, примеры `SHA512withRSA` /
`OPENSSL_ALGO_SHA512` — **SHA-512**; режим подтверждается банком, поэтому не
домысливается), привязки карт (`bindingId`), моделирование `orderBundle`.

## 1. Поднять стенд

```bash
docker compose up -d alfa-mock        # http://localhost:3104
# или без docker: npm run start:alfa
```

Стартовый лог печатает синтетические дефолты стенда (значения, заданные через env, скрыты — `<задан через env, скрыт>`):

```
creds: userName=ALFAMOCKTEST password=mockpass123 callback_secret=mocksecret123 (дефолты СИНТЕТИЧЕСКИЕ, по образцу TBANKMOCKTEST; ...)
```

**Это синтетические креды мока, а не реквизиты банка.** Реальные тестовые
`userName`/`password` Альфа-Банк выдаёт индивидуально при подключении — поэтому
в дефолты конфига они не зашиты (и не должны). Свои значения —
`MOCK_ALFA_USERNAME`, `MOCK_ALFA_PASSWORD`, `MOCK_ALFA_CALLBACK_SECRET`.

## 2. Зарегистрировать заказ

`register.do` — одностадийная оплата; `registerPreAuth.do` — холд
(двухстадийная схема, включается банком; на стенде — `MOCK_TWO_STAGE`, по
умолчанию включена). Параметры — form-urlencoded: обязательны `userName`,
`password`, уникальный `orderNumber`, `amount` **в копейках**, `returnUrl`.

```bash
curl -sS -X POST http://localhost:3104/payment/rest/register.do \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'userName=ALFAMOCKTEST' \
  --data-urlencode 'password=mockpass123' \
  --data-urlencode 'orderNumber=demo-0001' \
  --data-urlencode 'amount=10000' \
  --data-urlencode 'returnUrl=https://shop.test/alfa/return' \
  --data-urlencode 'failUrl=https://shop.test/alfa/fail' \
  --data-urlencode 'sessionTimeoutSecs=1200' \
  --data-urlencode 'jsonParams={"callback_url":"https://shop.test/alfa/callback"}'
```

```json
{
  "errorCode": 0,
  "errorMessage": "",
  "orderId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "formUrl": "http://localhost:3104/payment/3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "hint": "errorCode=0 — результат обработки API-вызова, не эквивалент финального статуса оплаты…"
}
```

Перенаправьте покупателя на `formUrl`. Ключевые ловушки, которые мок
воспроизводит как банк:

- **`orderNumber` уникален в пределах магазина**: повтор — `errorCode 1`,
  а не идемпотентный replay прежним заказом;
- **`amount` — копейки** (100.00 ₽ = `10000`); дроби и «1000.9» — `errorCode 5`;
- **`errorCode=0` — результат API-вызова, не факт оплаты**: финальный статус
  только через `getOrderStatusExtended.do` или callback;
- `sessionTimeoutSecs` (дефолт стенда `1200` = 20 минут): по истечении заказ
  отклоняется — `orderStatus=6` и callback `declinedByTimeout`.
- `jsonParams.callback_url` — **mock-расширение** (в бою приёмник уведомлений
  задаётся в настройках мерчанта банком); альтернатива на стенде —
  `MOCK_DEFAULT_CALLBACK_URL`.

## 3. Оплатить на форме (тестовые карты)

На `formUrl` — пресеты тестовых карт
([официальный список тестовых карт](https://alfabank.ru/sme/payservice/internet-acquiring/docs/connection-options/api/test-cards/)): успех
`4111111111111111` (3DS1), `639002000000000003` (МИР 3DS1), 3DS2-frictionless
`2201382000000062`, 3DS2-challenge `2200000000000053` и другие; отказы
`-2011` (3DS PaRes=U: `5555555555555557`, `4444333322221111`,
`5555555544444442`), `116` (недостаточно средств: `5432543254325430`,
CVV `521`), без-3DS карта `5555555555555599` (успех только при
`MOCK_SSL_PERMITTED=true`). **Пароль тестового ACS — `12345678`**; владелец
карты — минимум два слова латиницей. Неверный срок/CVV или кнопка Fail на ACS —
шлюзовой код `71015` («введённая информация неверна»). Данные карт не
хранятся: в заказе остаётся только маска `first6**last4`.

## 4. Сверить статус (серверная сверка)

```bash
curl -sS -X POST http://localhost:3104/payment/rest/getOrderStatusExtended.do \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'userName=ALFAMOCKTEST' \
  --data-urlencode 'password=mockpass123' \
  --data-urlencode 'orderId=3fa85f64-5717-4562-b3fc-2c963f66afa6'
```

`orderStatus` (общая нумерация платформы RBS): `0` — зарегистрирован, не
оплачен; `1` — холд; `2` — оплата проведена; `3` — reverse; `4` — возврат;
`5` — ACS; `6` — отказ. Расширенный ответ различает суммы
`authorizedAmount` / `depositedAmount` / `refundedAmount` и код шлюза
`actionCode` с описанием. Вместо `orderId` можно передать `orderNumber`.

## 5. Двухстадийная схема, reverse и refund

- `registerPreAuth.do` → оплата на форме → **холд** (`orderStatus=1`,
  callback `approved`);
- `deposit.do` с `amount` **не больше авторизованной суммы** (частичное
  подтверждение допустимо, остаток холда освобождается) → `orderStatus=2`,
  callback `deposited`. `deposit` больше холда — `errorCode 5`, повторный
  `deposit` — `errorCode 4`;
- `reverse.do` — отмена холда (`1`) или оплаты до окончательного расчёта
  (`2`) → `orderStatus=3`, callback `reversed`;
- `refund.do` — полный/частичный возврат **списанного** (`2`/`4`), сумма ≤
  `depositedAmount − refundedAmount` → `orderStatus=4`, callback `refunded`.
  Возврат больше списанного — `errorCode 5`; частичные возвраты отключаются
  флагом `MOCK_PARTIAL_REFUND=false` («разрешённый контур»).

## 6. Callback: HTTP GET + checksum HMAC-SHA256

Уведомление приходит **GET-запросом с query-параметрами**: `mdOrder`
(= `orderId`), `orderNumber`, `operation` (`approved`, `deposited`,
`reversed`, `refunded`, `declinedByTimeout`, `declinedCardpresent`),
`status` (`1` — операция успешна, `0` — завершилась ошибкой), `amount`
(копейки), `callbackCreationDate` и `checksum`.

**ACK — ровно HTTP 200.** Любой другой код (включая 204 и 3xx) банк считает
неуспехом и повторяет доставку; число попыток и интервал в официальном PDF не
указаны — на стенде это `MOCK_CALLBACK_RETRY_MS` × `MOCK_CALLBACK_MAX_ATTEMPTS`
(mock-конфигурация, не параметры банка).

Проверка checksum (симметричный режим): удалить `checksum` и `sign_alias`,
отсортировать оставшиеся имена параметров **в алфавитном порядке**, построить
строку `name;value;name;value;…;`, вычислить HMAC-SHA256 с общим секретным
ключом и сравнить hex **в верхнем регистре**:

```js
const crypto = require('crypto');
function verifyAlfaCallback(query, secret) {
  const params = Object.fromEntries(new URLSearchParams(query));
  const received = params.checksum;
  delete params.checksum;
  delete params.sign_alias;
  const canonical = Object.keys(params).sort().map((k) => `${k};${params[k]};`).join('');
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest('hex').toUpperCase();
  return received !== undefined && received.toUpperCase() === expected;
}
```

Две оговорки, которые обязан закрывать ваш код (и которые мок умеет
эмулировать):

1. **Callback может прийти без checksum** (`MOCK_CALLBACK_CHECKSUM=false`):
   неподписанное уведомление можно подделать — не меняйте по нему состояние
   заказа, сверяйтесь через `getOrderStatusExtended.do`;
2. **`declinedCardpresent`** в опубликованном PDF перечислена без детальной
   семантики — мок отправляет её при отказе карточной авторизации со
   `status=0`; источник истины — расширенный статус (`orderStatus=6`,
   `actionCode`).

Асимметричный режим (проверка подписи публичным ключом сертификата, признак —
`sign_alias`) стендом **не реализуется**: официальный PDF противоречив
(SHA-256 в описании против SHA-512 в примерах кода), а угадывать алгоритм
подписи нельзя.

## 7. Что мок проверит вместо вас

- неверные `userName`/`password` — `errorCode 2` с подсказкой, где взять креды
  стенда (реальные банковские креды в дефолты не зашиты);
- повтор `orderNumber` — `errorCode 1` (уникальность в пределах магазина);
- некорректные `amount`/`returnUrl`/`currency`/`jsonParams` — `errorCode 5` с
  `field` и `hint`;
- операции не в том статусе (`deposit` без холда, `refund` до списания,
  повторный `reverse`) — `errorCode 4` с объяснением по текущему `orderStatus`;
- неизвестный заказ — `errorCode 3`;
- сетевые сбои до бизнес-логики: `X-Mock-Scenario: http-500|http-504`
  (честные HTTP-коды) и `latency:2s`;
- системный сбой шлюза: `X-Mock-Scenario: fail` — `errorCode 6` c HTTP 200;
- `hang` — ответ не приходит вовсе (проверка ваших клиентских таймаутов);
- ретраи и дубли callback: приёмник, отвечающий не-200, получает повторы
  (`webhook-drop`/`webhook-duplicate` — сценарии подачи/подавления).

Журнал запросов с curl-сниппетами — `GET /admin/journal` (креды в нём
редактируются, PAN не попадает вовсе); сценарные правила —
`/mock/scenarios`; ускорение времени (таймауты сессий, ретраи) —
`POST /mock/time {"advance":"+25m"}`.

## 8. Песочницы и арендаторы

`POST /sandboxes` (режим `MOCK_TENANCY=owned`) выдаёт изолированную песочницу с
**своими** кредами: `userName`, `password` и `callbackSecret` (секрет checksum)
плюс `ownerToken` (показывается один раз). Дальше — заголовок
`X-Sandbox-Token: <ownerToken>` или `?sandbox=`. Сброс —
`POST /sandboxes/me/reset`, перевыпуск кредов — `POST /sandboxes/me/reset-creds`
(ownerToken сохраняется).

## 9. Чеклист готовности к бою

- [ ] координаты сверены с банком: production-адрес **не** всегда
      `https://payment.alfabank.ru/payment/rest` — для части merchant-логинов и
      схем (без префикса, r-, i-) URL и инструкции различаются;
- [ ] тестовые `userName`/`password` получены от банка индивидуально (синтетика
      стенда — только для локальной разработки);
- [ ] `orderNumber` уникален в пределах магазина, `amount` — в копейках;
- [ ] после возврата браузера статус сверяется серверно
      (`getOrderStatusExtended.do`), `errorCode=0` не трактуется как оплата;
- [ ] приёмник callback отвечает ровно HTTP 200, идемпотентен (дубли
      возможны) и проверяет checksum;
- [ ] неподписанные callback (без `checksum`) не меняют состояние заказа —
      только сверка через REST;
- [ ] режим checksum (симметричный/асимметричный) подтверждён банком; при
      асимметричном — уточнён алгоритм (SHA-256 или SHA-512) и `sign_alias`;
- [ ] двухстадийная схема и частичные возвраты согласованы с банком
      (на стенде — `MOCK_TWO_STAGE`, `MOCK_PARTIAL_REFUND`);
- [ ] HTTPS-приёмника: доверенный сертификат, RSA ≥ 2048, хеш ≥ SHA-256;
- [ ] обработаны отказы: `-2011` (PaRes=U), `116` (недостаточно средств),
      `71015` (неверные данные/ACS Fail), `declinedByTimeout` (истёк
      `sessionTimeoutSecs`);
- [ ] нагрузки на тестовый контур не создаётся (нагрузочное тестирование
      договором запрещено).
