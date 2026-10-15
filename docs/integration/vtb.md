© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Интеграция: ВТБ SMB E-commerce API через mock (10 минут)

Мок воспроизводит **SMB E-commerce API** интернет-эквайринга ВТБ по официальной документации REST API и callback/тестирования.
Это **не legacy RBS**: transport — JSON REST на versioned base
`/openapi/smb/efcp/e-commerce/v1/`, авторизация — короткоживущий OAuth Bearer +
`X-IBM-Client-Id`, суммы — десятичные рубли. Legacy-контракт
`vtb.rbsuat.com` (`/payment/rest/`, `register.do`, `userName/password`) —
другая система и не является альтернативной базой для этого API.

> **Не drop-in для Т-Банка, Сбера или Альфы.** У ВТБ свой OAuth token endpoint,
> заголовок `X-IBM-Client-Id`, рублёвый объект суммы `{value, code}` и отдельные
> сущности order/payment/refund со своими уровнями `status.value`. СБП-QR стенды
> (`qr-efcp.bankingapi.ru`) в эту ветку не входят.

## 1. Запустить

```bash
docker compose up -d vtb-mock       # http://localhost:3106
# или без контейнера (Node >= 18, зависимости не нужны):
npm run start:vtb
```

Дефолтные `vtbmocktest` / `mockpass123` — **синтетические креды мока**, а не
учётные данные банка. Настоящие тестовые `client_id`/`client_secret` ВТБ выдаёт
подключённому merchant индивидуально; в конфиг стенда и документацию они не
попадают. Свои значения — через env (`MOCK_VTB_CLIENT_ID`/`MOCK_VTB_CLIENT_SECRET`),
фактические env-секреты в лог не печатаются. Таблица настроек — в
[`services/vtb-mock/README.md`](../../services/vtb-mock/README.md).

## 2. Получить access_token (OAuth 2.0 client_credentials)

Токен запрашивается отдельно от бизнес-вызовов — form-urlencoded POST на token
endpoint (в моке он смонтирован на том же порту, путь повторяет тестовый контур):

```bash
curl -sS -X POST http://localhost:3106/passport/oauth2/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'grant_type=client_credentials&client_id=vtbmocktest&client_secret=mockpass123'
```

```json
{
  "access_token": "6c4f…",
  "token_type": "Bearer",
  "expires_in": 170
}
```

Срок токена — около **170** секунд; планируйте обновление по `expires_in` и
запрашивайте новый токен перед новым запросом к песочнице. Истечение проверяется
на виртуальных часах стенда: `POST /mock/time` с `{"advance":"+171s"}` делает
прежний токен невалидным, повторный `client_credentials` — снова рабочим.
`X-IBM-Client-Id` и `Merchant-Authorization` на token endpoint **не** отправляются.

## 3. Заголовки бизнес-запросов

Каждый запрос к `/openapi/smb/efcp/e-commerce/v1/*` несёт:

| Заголовок | Значение |
| --- | --- |
| `Authorization` | `Bearer <access_token>` |
| `X-IBM-Client-Id` | `client_id` в **нижнем регистре, без `@ext.vtb.ru`** (для дефолта — `vtbmocktest`) |
| `Content-Type` | `application/json` |
| `Merchant-Authorization` | опционален: для одного ресурса не обязателен (одна политика) |

Суффикс `@ext.vtb.ru` и верхний регистр в `X-IBM-Client-Id` — ошибка
(`invalid_client`, HTTP 401): заголовок обязан быть каноническим. Проверка
строгая намеренно — так ловится типичная интеграционная опечатка.

## 4. Создать ордер и оплатить

`POST /orders` принимает уникальный merchant `orderId`, `orderName` и
`amount: {"value": 10.56, "code": "RUB"}` — **десятичные рубли**, не копейки
(`10.56` — это десять рублей пятьдесят шесть копеек). Строка `10,56`,
экспоненты и больше двух знаков после точки отклоняются. Повтор того же
`orderId` **идемпотентен**: вернётся существующий ордер (заголовок
`X-Mock-Replayed: 1`), а не второй.

```bash
TOKEN=… # из шага 2
curl -sS -X POST http://localhost:3106/openapi/smb/efcp/e-commerce/v1/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H 'X-IBM-Client-Id: vtbmocktest' \
  -H 'Content-Type: application/json' \
  --data '{
    "orderId": "shop-order-0001",
    "orderName": "Заказ №1",
    "amount": {"value": 10.56, "code": "RUB"},
    "description": "тестовый заказ",
    "returnUrl": "https://shop.test/vtb/return"
  }'
```

```json
{
  "orderId": "shop-order-0001",
  "orderName": "Заказ №1",
  "amount": {"value": 10.56, "code": "RUB"},
  "status": {"value": "CREATED"},
  "createdAt": "2026-10-13T18:00:00.000Z",
  "expire": "2026-10-13T18:20:00.000Z",
  "payUrl": "http://localhost:3106/pay/shop-order-0001",
  "payments": [],
  "refunds": []
}
```

Перенаправьте браузер на `payUrl`. Ордер живёт **1200** секунд (20 минут) —
поле `expire` возвращается с timezone и миллисекундами; своё значение можно
задать при создании (ISO 8601 с timezone). Поле `returnUrl` — mock-расширение
[FORK]: в публичном SMB-срезе его нет, после оплаты мок возвращает браузер
именно туда.

**Официальная тестовая карта ВТБ (`4111 1111 1111 1111`, `12/24`) истекла** до
даты среза и непригодна для проверки; legacy-карта `4000 0011 1111 1118`
относится только к старой REST-песочнице `vtb.rbsuat.com`. На форме мока —
синтетические [FORK]-карты (успех `4242…0002`-подобные пресеты, отказ,
недостаточно средств, просроченная карта); PAN не сохраняется — только маска.
Выбор карты — пресеты формы; просроченная карта отрабатывает expire-сценарий.

## 5. Сверить статус: status.value на своём уровне

```bash
curl -sS http://localhost:3106/openapi/smb/efcp/e-commerce/v1/orders/shop-order-0001 \
  -H "Authorization: Bearer $TOKEN" \
  -H 'X-IBM-Client-Id: vtbmocktest'
```

| Уровень | `status.value` | Сценарий стенда |
| --- | --- | --- |
| ордер | `CREATED` | создан, не оплачен |
| ордер | `PAID` | успешная оплата или `complete` |
| ордер | `REFUNDED` / `PARTIALLY_REFUNDED` | полный/частичный `/refunds` |
| ордер | `CANCELED` | `cancel` или истечение 20-минутного TTL |
| операция (платёж/возврат) | `NEW` | платёж создан; для preauth — сумма удержана |
| операция | `CONFIRMED` | операция подтверждена (оплата/complete/возврат) |
| операция | `RECONCILED` | операция сверена (в карточном срезе — через сценарий `reconciled`) |

Статусы ордера и операции **не смешиваются**: у платежа в блоке `payments` и
возврата в `refunds` — свой `status.value`. Источник истины — серверный
`GET /orders/{orderId}` (и `GET /refunds/{refundId}` для возвратов), а не
redirect браузера и не уведомление.

## 6. Preauth, complete и cancel

`POST /orders/preauth` создаёт ордер с предавторизацией: обязателен объект
`twoStageParams` (его форма в публичном срезе не зафиксирована — [VERIFY];
мок сохраняет объект как есть). Доступность — «отдельное разрешение банка»:
на стенде её даёт `MOCK_VTB_PREAUTH=true`, без флага — `preauth_disabled`.
После оплаты такого ордера `payment.status.value=NEW` (холд), ордер остаётся
`CREATED`; завершить холд:

```bash
curl -sS -X POST http://localhost:3106/openapi/smb/efcp/e-commerce/v1/orders/complete/shop-order-0002 \
  -H "Authorization: Bearer $TOKEN" -H 'X-IBM-Client-Id: vtbmocktest' \
  -H 'Content-Type: application/json' \
  --data '{"amount": {"value": 10.56, "code": "RUB"}}'
```

Сумма `complete` не может превышать авторизацию (частичное подтверждение
допустимо, остаток холда снимается); превышение — `amount_exceeds_limit` (409).
`POST /orders/{orderId}/cancel` с опциональным `cancelReason` отменяет
неоплаченный ордер или preauth до `complete`; отмена холда помечает платёж
`voided` — статуса reversal в словаре операций среза нет [VERIFY]. После оплаты
отмена недоступна — используйте `/refunds`.

## 7. Возвраты

`POST /refunds` принимает merchant `refundId`, `paymentId` (из `payments` ордера)
и `amount`. Возврат бывает полным и частичным, ограничен остатком списания по
платежу; сверх остатка — `amount_exceeds_limit` (409). **`refundId` должен быть
уникален: повтор — ошибка `duplicate_refund_id` (409), а не идемпотентный
replay** — в отличие от `orderId` в `POST /orders`. Статус возврата —
`GET /refunds/{refundId}`.

## 8. Callback: JSON POST без подписи

Callback URL — один на ресурс: мерчант сообщает его представителю банка; в моке
это `MOCK_VTB_CALLBACK_URL`. Шлюз отправляет `POST` с JSON-оболочкой
`{"type":"PAYMENT|REFUND","object":{...}}`. Тело платежа — поля карточного
примера среза (`paymentId`, `paymentCode`, `orderId`, `orderCode`, `createdAt`,
`description`, `amount`, `paymentData`), тело возврата — `refundId`, `paymentId`,
`paymentCode`, `orderId`, `orderCode`, `createdAt`, `amount`.

**Расхождение публичных примеров сохраняется как есть:** у платежа (карта) поле
статуса записано `Status` (заглавная), у возврата — `status` (строчные). Мок не
нормализует регистр ключа; СБП-вариант `status` у платежа можно получить
сценарием `status-lowercase` и проверить merchant-парсеры на оба написания.
Пример тела платежа:

```json
{
  "type": "PAYMENT",
  "object": {
    "paymentId": "9f0d…",
    "paymentCode": "100042",
    "orderId": "shop-order-0001",
    "orderCode": "100001",
    "createdAt": "2026-10-13T18:01:02.000Z",
    "description": "тестовый заказ",
    "amount": {"value": 10.56, "code": "RUB"},
    "paymentData": {"cardMask": "424242**4242"},
    "Status": {"value": "CONFIRMED"}
  }
}
```

**В публичных SMB-инструкциях нет callback-подписи, обязательного ACK-кода и
расписания повторов** — мок их не выдумывает и не переносит legacy-правила RBS.
Локально мок считает доставкой любой HTTP 2xx (это договорённость стенда
[FORK], не утверждение протокола) и повторяет по своему графику: 3 попытки с
интервалом 60 секунд (настраиваются `MOCK_VTB_CALLBACK_RETRY_MS` /
`MOCK_VTB_CALLBACK_MAX_ATTEMPTS`, ускоряются `POST /mock/time`
`{"advance":"+60s"}`). `webhook-drop`/`webhook-duplicate` — сценарии мока.

Любой callback может быть подделан: официальная инструкция прямо рекомендует
после уведомления выполнить `GET /orders/{orderId}` или `GET /refunds/{refundId}`.
Уведомление — сигнал, а не источник истины.

## 9. Песочницы, сценарии и OpenAPI

- `GET /health`, `GET /openapi.json` — состояние стенда и OpenAPI 3.1.
- `X-Mock-Sandbox` изолирует ордеры, возвраты, токены, callback queue, сценарии,
  часы и журнал; токен выдаётся в контексте своей песочницы.
- `POST /mock/scenarios` и `X-Mock-Scenario`: `fail`, `hang`, `latency`,
  `http-500`/`http-504`, `webhook-drop`/`webhook-duplicate`, `status-lowercase`,
  `reconciled`; `/mock/time` двигает доменное время (TTL токена/ордера, retry).
- `/admin` — консоль с masked PAN; в hosted-режиме задайте управляющие токены.
  При `MOCK_HOSTED=1` SSRF-защита исходящих callback включена по умолчанию,
  `SSRF_BLOCKED` — терминальный отказ без повторов.
- `npm run test:vtb` — end-to-end selftest без Docker.

## 10. Известная неопределённость

Публичный SMB-срез фиксирует HTTP-транспорт и примеры, но не полную схему тел
бизнес-ошибок, форму `twoStageParams`/`paymentData`/`paymentCode` и точный
формат статуса внутри callback (`{"value": …}` против строки). Envelope ошибок
`{error, error_description, field, hint, doc}`, `[FORK]`-карты, `returnUrl`,
`voided`-холд и переход TTL → `CANCELED` — явно помечённая реализация мока
(по образцу errorCode-форка Сбера), а не заявление о production-контракте ВТБ.
Перед переносом в production сверяйте спецификацию подключённого merchant и
согласуйте отличия с владельцем проекта.
