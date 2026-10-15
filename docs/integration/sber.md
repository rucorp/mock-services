© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Интеграция: Сбербанк Ecom REST через mock (10 минут)

Мок воспроизводит шлюз **Сбербанк Ecom REST v1.1.11.1** по официальной документации REST API, callbacks и тестовых карт.
Это не legacy Secure Payments API: transport — JSON `POST
/ecomm/gw/partner/api/v1/*.do`, callback — JSON `POST` без checksum или иной
подписи. Ветка намеренно не включает `paymentOrder.do` (нужно разрешение
merchant), SberPay/SBP Sandbox, `orderBundle` и новый банк.

> **Не drop-in для Альфы, Т-Банка или Secure Payments.** У Сбера Ecom свой
> путь API, JSON-тела, `userName`/`password`, числовой `orderStatus` и
> unsigned JSON callback. Старый Secure Payments callback с контрольной
> суммой сюда не переносится.

## 1. Запустить

```bash
docker compose up -d sber-mock       # http://localhost:3105
# или без контейнера (Node >= 18, зависимости не нужны):
npm run start:sber
```

Дефолтные `SBERMOCKTEST` / `mockpass123` — **синтетические креды мока**, а не
учётные данные банка. Настоящие тестовые `userName`/`password` выдаются
подключённому merchant индивидуально. Свои значения задаются через env;
фактические env-секреты не печатаются в лог. Смотрите таблицу настроек в
[`services/sber-mock/README.md`](../../services/sber-mock/README.md).

## 2. Зарегистрировать заказ

Все Ecom REST методы — `POST`, JSON UTF-8, merchant-поля `userName` и
`password` передаются в каждом теле. `amount` — целое количество копеек,
`currency=643` — RUB, `orderNumber` уникален для магазина/песочницы.
`register.do` создаёт одностадийную оплату; `registerPreAuth.do` — заказ для
холда (функцию можно отключить настройкой стенда, потому что её доступность у
банка merchant-specific).

Пример использует **синтетические** креды только локального мока:

```bash
curl -sS -X POST http://localhost:3105/ecomm/gw/partner/api/v1/register.do \
  -H 'Content-Type: application/json' \
  --data '{
    "userName":"SBERMOCKTEST",
    "password":"mockpass123",
    "orderNumber":"shop-test-0001",
    "amount":15000,
    "currency":643,
    "returnUrl":"https://shop.test/sber/return",
    "failUrl":"https://shop.test/sber/fail",
    "sessionTimeoutSecs":1200,
    "dynamicCallbackUrl":"https://shop.test/sber/callback",
    "additionalParams":{"reference":"shop-test-0001"}
  }'
```

Ответ регистрации содержит `orderId` и `formUrl`:

```json
{
  "errorCode": 0,
  "errorMessage": "",
  "orderId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "formUrl": "http://localhost:3105/payment/3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "hint": "errorCode=0 означает, что запрос регистрации обработан; это НЕ подтверждение оплаты…"
}
```

Перенаправьте браузер на `formUrl`. Уникальный повтор `orderNumber` — ошибка,
а не replay первого заказа. Срок можно задать при регистрации; дефолт мока —
1200 секунд (20 минут), максимум — 3 попытки оплаты.

**`errorCode=0` — не успешный платёж.** Он означает, что REST-вызов
обработан. После возврата браузера, callback, таймаута или операции сверяйте
серверное состояние по `orderStatus`.

## 3. Hosted-форма, карты и ACS

Форма показывает официальные тестовые пресеты Сбербанка:
успешные frictionless/3DS-карты, две повторяемые отказные карты (`101`, `116`),
срок/CVV и masked PAN. Полные номера не дублируются в этом гайде. Для
challenge-потока тестовый ACS принимает пароль `111111`; заказ остаётся в
промежуточном `orderStatus=5`, пока ACS не завершится. Это состояние не надо
трактовать как финальный отказ или успех. Успешное завершение ведёт к `1`
(холд, для `registerPreAuth.do`) либо `2` (оплата для `register.do`).

Форма — локальная эмуляция браузерного пути; merchant после неё всё равно
должен использовать REST-сверку. Не отправляйте сюда реальные PAN, срок,
CVV, банковские креды или ПДн.

## 4. Сверить статус заказа

```bash
curl -sS -X POST http://localhost:3105/ecomm/gw/partner/api/v1/getOrderStatusExtended.do \
  -H 'Content-Type: application/json' \
  --data '{
    "userName":"SBERMOCKTEST",
    "password":"mockpass123",
    "orderId":"3fa85f64-5717-4562-b3fc-2c963f66afa6"
  }'
```

| `orderStatus` | Состояние в документированном срезе | Сценарий стенда |
| ---: | --- | --- |
| `0` | заказ зарегистрирован, не оплачен | до оплаты; повторяемые ошибки до исчерпания попыток |
| `1` | сумма захолдирована | успешная оплата `registerPreAuth.do` |
| `2` | полная авторизация/оплата проведена | успешная оплата `register.do` или `deposit.do` |
| `3` | авторизация отменена | `reverse.do` |
| `4` | по заказу проведён возврат | полный/частичный `refund.do` |
| `5` | начата аутентификация через ACS | challenge до результата ACS |
| `6` | авторизация отклонена | третий отказ, `decline.do` до оплаты или истечение TTL |

`actionCode` — отдельное поле: например, тестовые повторяемые ошибки карт
отдают `101` или `116`; оно не заменяет числовой `orderStatus`. Поля
расширенного ответа с суммами `authorizedAmount`, `depositedAmount` и
`refundedAmount` полезны для сверки суммы холда, списания и возврата.

## 5. Двухстадийная оплата, reverse и refund

Для двухстадийного потока регистрируйте `registerPreAuth.do`, проводите
покупателя через ту же форму и после успешной авторизации подтвердите сумму,
не превышающую холд:

```bash
curl -sS -X POST http://localhost:3105/ecomm/gw/partner/api/v1/deposit.do \
  -H 'Content-Type: application/json' \
  --data '{"userName":"SBERMOCKTEST","password":"mockpass123","orderId":"…","amount":6000}'
```

Мок поддерживает частичный `deposit`; например, 6000 копеек допустимы при
холде 9000, 9001 — нет. `reverse.do` отменяет допустимую авторизацию. Для
уже списанного заказа используйте `refund.do`: полный и частичный возврат
ограничены остатком `depositedAmount - refundedAmount`; повторный возврат сверх
остатка отклоняется. `decline.do` доступен только до первой попытки оплаты.

## 6. Callback: JSON POST без подписи

Уведомление Ecom отправляется только если задан `dynamicCallbackUrl` в
регистрации либо `MOCK_SBER_CALLBACK_URL` в окружении. Пример тела:

```json
{
  "mdOrder": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "orderNumber": "shop-test-0001",
  "operation": "deposited",
  "status": 1,
  "additionalParams": {"reference":"shop-test-0001"}
}
```

Поддерживаются операции `created`, `approved`, `deposited`, `reversed`,
`refunded`, `declinedByTimeout`; `status` равен числу `1` (операция успешна)
или `0` (операция завершилась ошибкой). Приёмник подтверждает доставку ответом **HTTP 200 (и только 200)**; `204` и
другие статусы считаются неуспешной доставкой. По умолчанию — 3 попытки с интервалом 60 секунд. В тесте используйте виртуальное
время: `POST /mock/time` с `{"advance":"+60s"}` запускает ожидаемый retry без
минутной задержки.

Ecom callback из reference **не содержит подписи или checksum**. Не переносите
сюда HMAC/проверку старого Secure Payments или подпись Т-Банка. Любой callback
может быть подделан: используйте событие как сигнал и сверьте заказ REST-методом.
Поведение доставки соответствует локальному Ecom-конспекту; опциональные
режимы дублирования и drop существуют только как сценарии мока.

## 7. Песочницы, сценарии и OpenAPI

- `GET /health`, `GET /openapi.json` — состояние стенда и OpenAPI 3.1.
- `X-Mock-Sandbox` изолирует заказы, callback queue, сценарии, часы и журнал.
- `POST /mock/scenarios` и `X-Mock-Scenario` моделируют ошибки/latency/HTTP-
  abort, сброс callback и доставку дубля; `/mock/time` двигает доменное время.
- `/admin` показывает masked PAN и диагностические записи; в hosted-режиме
  настройте управляющие токены. При `MOCK_HOSTED=1` SSRF-защита private/reserved
  callback targets включена по умолчанию и terminal-отказ не ретраится.
- `npm run test:sber` запускает отдельный end-to-end selftest без Docker.

## 8. Что мок проверяет за вас

- креды `userName`/`password` — синтетические дефолты стенда (`SBERMOCKTEST`/`mockpass123`),
  неверные дают отказ с подсказкой, где взять свои;
- `amount` — целые копейки, `currency=643`, `orderNumber` уникален для магазина
  (повтор — ошибка, а не replay первого заказа);
- переходы: `deposit` не выше холда (частичный поддерживается), `refund` не выше
  `depositedAmount − refundedAmount`, `reverse` только по авторизации, `decline` —
  до первой попытки оплаты;
- ACS: тестовый пароль `111111`, `orderStatus=5` держится до завершения challenge;
- callback: доставкой считается **только HTTP 200** (`204` — неуспех), по умолчанию
  3 попытки с интервалом 60 с, ускоряются `POST /mock/time {"advance":"+60s"}`;
- сценарии `X-Mock-Scenario` (`fail`, `hang`, `latency`, `http-500`/`http-504`,
  `webhook-drop`, `webhook-duplicate`) и `X-Mock-Sandbox` для изоляции;
- в hosted (`MOCK_HOSTED=1`) управляющие токены fail-closed, а приватные
  callback-адреса отсекаются SSRF-политикой (`SSRF_BLOCKED`, без повторов).

Локальные `errorCode` 1…6 — пометки `[VERIFY]/[FORK]`, а не обещание боевого
каталога ошибок Сбербанка (см. §9).

## 9. Известная неопределённость

Локальные reference-срезы не фиксируют полный merchant-specific каталог
`errorCode` и полную схему всех ответных полей `getOrderStatusExtended.do`.
Коды ошибок 1…6, отдельные mock diagnostic fields и агрегированные суммы —
явно помеченная [VERIFY]/[FORK] реализация мока, а не заявление о точной
таблице production Сбербанка. Перед переносом в production сверяйте исходную спецификацию
подключённого merchant и согласуйте отличия с владельцем проекта.

## 10. Ссылки

- Контракт сервиса, env и `/mock/*`: [`services/sber-mock/README.md`](../../services/sber-mock/README.md)
- OpenAPI 3.1: [`docs/openapi/sber-mock.openapi.json`](../openapi/sber-mock.openapi.json)
- Манифест протокола для `npm run check:drift`: [`protocols/sber-ecom.json`](../../protocols/sber-ecom.json)
- Общая инфраструктура адаптеров (часы, песочницы, вебхуки, SSRF): [`packages/core/README.md`](../../packages/core/README.md)
