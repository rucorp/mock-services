© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Интеграция: облачная касса OKassa (Первый ОФД) через mock (10 минут)

Мок воспроизводит **облачную кассу OKassa** Первого ОФД по официальной документации API и тестового стенда:
тестовый контур `external-api-farm.1-ofd-test.ru`, `getToken` → `Bearer`-токен,
**асинхронная очередь заявок на чек** `POST /api/external/queue/v1/transaction/{type}`
с `requestId` и статусами `IN_PROGRESS`/`COMPLETED`/`ERROR`.

> **Не drop-in для АТОЛ/Фермы и не часть `kassa-mock`.** У Первого ОФД другой
> транспорт и другая модель: токен выдаётся отдельным методом `getToken`,
> результат печати приходит асинхронно по `requestId`, а операции чека записаны
> как `INCOME`, `INCOME_RETURN`, `EXPENCE`, `EXPENCE_RETURN`. Тег
> **ATOL Online V5** из тестового swagger Первого ОФД — отдельный API и вне
> области этого адаптера.

## 1. Запустить

```bash
docker compose up -d first-ofd-mock    # http://localhost:3107
# или без контейнера (Node >= 18, зависимости не нужны):
npm run start:first-ofd
```

Дефолтные `firstofdmocktest` / `11111111-2222-4333-8444-555555555555` —
**синтетические креды мока**, а не реквизиты Первого ОФД: публичных тестовых
login/API-key UUID у провайдера нет, они выдаются в тестовом ЛК. Свои значения —
через env (`MOCK_FIRST_OFD_LOGIN` / `MOCK_FIRST_OFD_PASS`); фактические
env-секреты в стартовый лог не печатаются. Полная таблица настроек —
в [`services/first-ofd-mock/README.md`](../../services/first-ofd-mock/README.md).

## 2. Получить токен: `getToken`

Срез фиксирует транспорт `application/json; charset=utf-8` и тело
`{login, pass}`, где `pass` — API-ключ UUID:

```bash
curl -sS -X POST http://localhost:3107/getToken \
  -H 'Content-Type: application/json; charset=utf-8' \
  --data '{"login": "firstofdmocktest", "pass": "11111111-2222-4333-8444-555555555555"}'
```

```json
{"token": "5f2c…"}
```

Дальше каждый запрос несёт `Authorization: Bearer <token>`. **API-ключ UUID сам
по себе bearer-токеном не является** — это отдельный слой, и попытка передать
ключ в `Authorization` даёт `invalid_token`.

Токен живёт **86400** секунд (24 часа) на виртуальных часах стенда. Истечение
воспроизводится без ожидания суток:

```bash
curl -sS -X POST http://localhost:3107/mock/time -H 'Content-Type: application/json' --data '{"advance": "+25h"}'
# прежний Bearer теперь даёт 401 invalid_token — запросите новый getToken
```

**Расхождение среза:** в PDF под заголовком «успешный ответ» `getToken` приведён
объект `error` с кодом `0` и текстом «Неверный логин и пароль». Семантику `error`
требуется согласовать с провайдером, поэтому дефолтный успех мока отдаёт только
`{token}`, а сам пример воспроизводится отдельным сценарием
`getToken-error-quirk` — им удобно проверить, что ваш парсер не считает ответ
ошибкой `[VERIFY]`.

## 3. Создать заявку на чек

`POST /api/external/queue/v1/transaction/receipt` **не возвращает фискальный
результат** — только `requestId`; заявка обрабатывается в очереди (в моке —
2000 мс виртуальных часов). Обязательны `cashboxParameters.userInn`,
`requestMetadata.userGroup` и `document.operationType|items|totalSum`:

```bash
TOKEN=… # из шага 2
curl -sS -X POST http://localhost:3107/api/external/queue/v1/transaction/receipt \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "cashboxParameters": {"userInn": "7842223709"},
    "requestMetadata": {"userGroup": "MOCKGROUP", "externalId": "shop-order-0001"},
    "document": {
      "operationType": "INCOME",
      "items": [
        {"label": "Кофе", "measurementUnit": "шт", "price": 150.00, "quantity": 2, "vatCode": "VAT_22"}
      ],
      "totalSum": 300.00
    }
  }'
```

```json
{"requestId": "6f1d0c2a-…-000000000001"}
```

Что важно в схеме:

| Поле | Правило мока |
| --- | --- |
| `document.operationType` | `INCOME`, `INCOME_RETURN`, `EXPENCE`, `EXPENCE_RETURN` — **написание как в схеме**: `EXPENCE` не «исправляется» автоматически, а вариант `EXPENSE` отклоняется (`invalid_operation_type`) |
| `document.items` | **массив** элементов `Item` (OpenAPI); таблица manual трактует форму иначе — расхождение №2 среза `[VERIFY]` |
| `Item` | обязательны `label`, `measurementUnit`, `price`, `quantity`, `vatCode`; `price` — **десятичные рубли** (`150.00`), не копейки |
| `vatCode` | включает `VAT_22` и `VAT_22122`; полный enum среза не приведён — остальные коды помечены `[VERIFY]` |
| `requestMetadata` | в срезе противоречие: manual называет объект необязательным, OpenAPI держит его в `required`. Мок следует строгой схеме OpenAPI `[VERIFY]` |
| `requestMetadata.userGroup` | обязателен; синтетический каталог стенда — `MOCKGROUP`, `firstofd-mock` (или `*` без проверки) |
| `document.totalSum` | правила сверки с позициями срез не описывает — вне области; при расхождении мок только предупреждает в логе `[FORK]` |

Чек коррекции — отдельная схема и отдельный тип заявки
(`receiptCorrection`): в документе обязателен `correctionCause`, receipt-схема
для него не подходит.

## 4. Статус, результат и сверка

```bash
curl -sS http://localhost:3107/api/external/queue/v1/status/$REQUEST_ID -H "Authorization: Bearer $TOKEN"
```

```json
{
  "requestId": "6f1d0c2a-…",
  "transactionType": "receipt",
  "status": "COMPLETED",
  "errorCode": null,
  "errorType": null,
  "details": null,
  "payload": {"fiscalDocumentNumber": 1, "fiscalDocumentSign": "1000000001", "fiscalDriveNumber": "9999078900000001", "kkmRegId": "100000000000001", "totalSum": 300, "operationType": "INCOME"},
  "externalId": "shop-order-0001",
  "userGroup": "MOCKGROUP"
}
```

| Метод | Назначение |
| --- | --- |
| `GET .../transaction/{requestId}` | полная заявка (тело как принято) + `result` |
| `GET .../status/{requestId}` | текущий статус и результат |
| `GET .../statuses?externalId=…&groupId=…` | заявки по внешнему ID и группе; **оба параметра обязательны**, `status` — необязательный фильтр |
| `GET /api/external/receipts?from=…&to=…` | **фискальные документы** за период, не состояние заявок; фильтры `transactionType`, `groupId`, `kkmRegId`, `page`, `pageSize` (дефолт 20, максимум 100) |

Окно `from`/`to` сверяется с **виртуальными часами стенда**: документ попадает в
выборку по времени создания на виртуальных часах, поэтому после `POST /mock/time`
`to` из wall-clock может отрезать свежие документы — берите запас или текущее
время стенда.

Статусы очереди: `IN_PROGRESS` → `COMPLETED` | `ERROR`. `pending`-поля до
завершения обработки равны `null`. Заявка сразу после подачи:

```bash
curl -sS -X POST http://localhost:3107/mock/time -H 'Content-Type: application/json' --data '{"advance": "+5s"}'
```

**Два слоя ошибок.** Результат с ошибкой несёт `errorType`: `API` — ошибка слоя
API очереди, `KKT` — ошибка кассы/фискального накопителя; `errorCode` и
`details` описывают конкретную причину. Оба слоя сохраняются раздельно, как и
требует срез. Таблица кодов публично не зафиксирована, поэтому значения
каталогов — локальный `[FORK]` мока:

```json
{"status": "ERROR", "errorType": "KKT", "errorCode": "SHIFT_ALREADY_OPEN", "details": "Смена №1 уже открыта на кассе …"}
```

Сценарий `kkt-error` даёт ошибку слоя ККТ, `api-error` — слоя API, а естественные
правила стенда возвращают `SHIFT_ALREADY_OPEN`/`SHIFT_NOT_OPEN` при повторном
открытии/закрытии смены (правила ККТ-слоя в срезе не описаны — помечены `[FORK]`).

## 5. Смены и отчёт: `StateCommandRequest`

`openShift`, `closeShift` и `currentStateReport` принимают **другую** схему —
`StateCommandRequest`: receipt-тело (`document` с `operationType`/`items`/
`totalSum`) в них отклоняется, иначе получился бы «универсальный» объект из
разных схем. Мок требует документированный `requestMetadata.userGroup`;
остальной состав `StateCommandRequest` публично не раскрыт `[VERIFY]`.

```bash
curl -sS -X POST http://localhost:3107/api/external/queue/v1/transaction/openShift \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data '{"cashboxParameters": {"userInn": "7842223709"}, "requestMetadata": {"userGroup": "MOCKGROUP"}}'
```

Успешный ответ — `COMPLETED` с `payload.shiftState = OPEN`/`CLOSED`;
`currentStateReport` возвращает состояние смены и число документов, не являясь
фискальным документом (в `/api/external/receipts` он не попадает `[VERIFY]`).

## 6. `externalId`: идемпотентность не обещана

`externalId` — внешний идентификатор вызывающей стороны; **правила дедупликации
публично не подтверждены** `[VERIFY]`. Мок фиксирует детерминированное
поведение: повтор с тем же `externalId` в той же группе создаёт **новую** заявку
со своим `requestId` (ответ помечается `X-Mock-Duplicate-External-Id: 1`), а
обе заявки находятся через `statuses`:

```bash
curl -sS "http://localhost:3107/api/external/queue/v1/statuses?externalId=shop-order-0001&groupId=MOCKGROUP" \
  -H "Authorization: Bearer $TOKEN"
```

Для сверки всегда **сохраняйте выданный `requestId`** — он и есть ключ к
статусу и к фискальному документу.

## 7. Callback: JSON POST без подписи

Если в `requestMetadata.callbackUrl` передан URL, после обработки заявки мок
делает `POST` с JSON. **Публичный срез не закрепляет ни envelope, ни подпись, ни
обязательный ACK, ни расписание повторов** — поэтому подписи нет вовсе, а тело
уведомления совпадает с результатом заявки (плюс `externalId` и `userGroup`).
Форма тела, условие ACK «любой 2xx» и график повторов — локальная
договорённость стенда `[FORK]`, а не утверждение о протоколе Первого ОФД:

```json
{
  "requestId": "6f1d0c2a-…",
  "transactionType": "receipt",
  "status": "COMPLETED",
  "errorCode": null, "errorType": null, "details": null,
  "payload": {"fiscalDocumentNumber": 1},
  "externalId": "shop-order-0001",
  "userGroup": "MOCKGROUP"
}
```

Приёмник делайте **идемпотентным**, а результат подтверждайте методом статуса
`GET /api/external/queue/v1/status/{requestId}` — уведомление лишь сигнал.
Расхождение среза по схеме URL (`http://` в PDF против `https://` в примерах)
мок по умолчанию не выбирает: принимаются обе схемы, а строгий HTTPS включается
`MOCK_FIRST_OFD_CALLBACK_HTTPS_ONLY=1` `[VERIFY]`.

Локально мок повторяет доставку **3 попытки** с интервалом 60 секунд
(`MOCK_FIRST_OFD_CALLBACK_RETRY_MS` × `MOCK_FIRST_OFD_CALLBACK_MAX_ATTEMPTS`) —
это график мока `[FORK]`, публичного расписания у провайдера нет. Сценарии
`webhook-drop` (подавить уведомление) и `webhook-duplicate` (доставить дважды)
удобны для проверки приёмника; `POST /mock/time` `{"advance":"+60s"}` ускоряет
повтор. При включённой SSRF-политике приватный `callbackUrl` даёт терминальный
отказ `SSRF_BLOCKED` — без повторов и без утечки во внутреннюю сеть.

## 8. Что мок проверяет за вас: негативы и DX

Ошибки мока — provider-shaped: `{"error": {"code", "text", "layer"}}` плюс
`field`, `hint` и `doc` со ссылкой на раздел среза `[FORK]`:

| Ситуация | Ответ |
| --- | --- |
| нет/битый `Bearer` | 401 `invalid_token` |
| неверные `login`/`pass` в `getToken` | 401 `invalid_credentials` |
| отсутствует обязательное поле схемы | 400 `invalid_request` (+ `field`) |
| `items` не массив | 400 `invalid_request` — подсказка про расхождение №2 |
| неизвестный `vatCode` | 400 `invalid_vat_code` со списком допустимых |
| `userGroup` вне каталога | 400 `unknown_user_group` |
| `EXPENSE` вместо `EXPENCE` | 400 `invalid_operation_type` |
| receipt-тело в `openShift` | 400 `invalid_request` — «смешивать схемы нельзя» |
| `statuses` без `groupId` | 400 `missing_parameter` |
| неизвестный `requestId` | 404 `request_not_found` |

## 9. Сценарии, часы и песочницы

- `GET /health`, `GET /openapi.json` — состояние стенда и OpenAPI 3.1.
- `X-Mock-Scenario` и `POST /mock/scenarios`: `fail`, `hang`, `latency`,
  `http-500`/`http-504`, `kkt-error`, `api-error`, `getToken-error-quirk`,
  `webhook-drop`, `webhook-duplicate`; `POST /mock/time` двигает виртуальное
  время (TTL токена, задержка очереди, повторы callback).
- `X-Mock-Sandbox` изолирует заявки, фискальные документы, токены, очередь
  callback, сценарии, часы и журнал — состояние не пересекается между песочницами.
- В `owned`-модели (`MOCK_HOSTED=1`) доступ к песочнице даёт owner-token
  (`X-Sandbox-Token`); общая для Bearer-адаптеров особенность стенда: совмещать
  его с `Authorization: Bearer <токен очереди>` в одном запросе нельзя — отказ
  «знание ID не является доступом» (воспроизводится и на `vtb-mock`) `[VERIFY]`.
- `/admin` — консоль: заявки, кассовые группы, callbacks, журнал; в hosted-режиме
  задайте управляющие токены (`MOCK_ADMIN_TOKEN`/`MOCK_OPERATOR_TOKEN`).
- `npm run test:first-ofd` — end-to-end selftest без Docker.

## 10. Известная неопределённость

Публичный срез фиксирует транспорт `getToken`, структуру заявки, поля результата
(`requestId`, `transactionType`, `errorCode`, `errorType`, `details`, `payload`)
и набор методов сверки, но **не** фиксирует: production base, тестовые креды,
полный enum `vatCode`/`operationType`-справочников, состав
`StateCommandRequest`, envelope callback и подпись, ACK и расписание повторов,
таблицу `errorCode` результата, правила дедупликации `externalId` и сроки
хранения. Все такие места помечены `[VERIFY]`, а локальные решения мока —
`[FORK]`. Перед переносом в production сверяйте спецификацию подключённой
кассы и согласуйте отличия с владельцем проекта.

## 11. Ссылки

- Контракт сервиса, env и `/mock/*`: [`services/first-ofd-mock/README.md`](../../services/first-ofd-mock/README.md)
- OpenAPI 3.1: [`docs/openapi/first-ofd-mock.openapi.json`](../openapi/first-ofd-mock.openapi.json)
- Манифест протокола для `npm run check:drift`: [`protocols/first-ofd-okassa.json`](../../protocols/first-ofd-okassa.json)
- Общая инфраструктура адаптеров (часы, песочницы, вебхуки, SSRF): [`packages/core/README.md`](../../packages/core/README.md)
