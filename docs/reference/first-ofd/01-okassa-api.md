© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Первый ОФД — облачная касса OKassa API

Срез официальной документации на 2026-10-11. Основной первоисточник — [руководство OKassa, редакция 23.07.2026](https://help.1-ofd.ru/upload/medialibrary/docs/oblachnaya_kassa_opisanie_api.pdf); рядом опубликована [тестовая OpenAPI 3.1 спецификация, версия 26.13.3](https://external-api-farm.1-ofd-test.ru/api/v3/spec). В тестовой спецификации есть отдельный тег ATOL Online V5 API — это другой API; не смешивать с OKassa.

## Базы и аутентификация

- Тестовый host: `https://external-api-farm.1-ofd-test.ru`.
- `POST /getToken` с `Content-Type: application/json; charset=utf-8` и `{ "login": "<login>", "pass": "<API key UUID>" }`. `login` — идентификатор организации; `pass` — API-ключ UUID из ЛК «Облачные кассы → Интеграции → Ключи к Кассовому API».
- Токен живёт 24 часа; в остальных запросах передаётся как `Authorization: Bearer <token>` согласно OpenAPI security scheme. Не использовать API-ключ UUID как bearer token.
- В открытой документации не подтверждены production API base и публичные тестовые login/API-key; получить реквизиты в соответствующем ЛК/у поддержки.

## Создание заявки на чек

```text
POST /api/external/queue/v1/transaction/{type}
```

Вызов добавляет заявку в очередь и возвращает `requestId`, а не финальный фискальный результат. `type` из OpenAPI: `receipt`, `receiptCorrection`, `openShift`, `closeShift`, `currentStateReport`. Все три корневых объекта для чека — `cashboxParameters`, `requestMetadata`, `document`.

| Объект | Поля, зафиксированные в тестовой OpenAPI |
|---|---|
| `cashboxParameters` | Для `ReceiptRequest` обязателен `userInn`; доступны теги группы для выбора кассовой группы. |
| `requestMetadata` | `userGroup` обязателен; схема также содержит `timestamp`, `timeZone`, `externalId`, `callbackUrl`. |
| `document` (тип `Receipt`) | Обязательны `operationType`, `items`, `totalSum`; доступны `taxationType`, `cashier`, `cashierInn`, `retailAddress`, `retailPlace`, `sendCheckTo`, `buyer`, `industryProps`, `vatSums`, `ecashSums`, `timeZone` и другие поля ФФД. |
| `document.items[]` | В `Item` обязательны `label`, `measurementUnit`, `price`, `quantity`, `vatCode`; другие реквизиты (агент, маркировка и т. п.) описаны отдельными схемами. |

Для `receiptCorrection` применяется отдельный `ReceiptCorrectionRequest`; в публичной OpenAPI у его `document` есть обязательный `correctionCause`. Для `openShift`, `closeShift` и `currentStateReport` схема указывает `StateCommandRequest`, а не receipt body. Передавать поля строго по отдельной схеме типа, не собирать один «универсальный» объект из примеров разных провайдеров.

Операции чека перечислены в OpenAPI как `INCOME` (приход), `INCOME_RETURN` (возврат прихода), `EXPENCE` (расход), `EXPENCE_RETURN` (возврат расхода). Значения `EXPENCE` в протоколе написаны именно так — не исправлять регистр/орфографию автоматически. Ставки НДС включают `VAT_22` и `VAT_22122`.

`externalId` — внешний идентификатор, создаваемый вызывающей стороной; по нему доступен поиск статусов. В доступной OAS не подтверждены правила дедупликации и срок хранения этого ID: для сверки сохранять выданный `requestId`; не считать повтор с тем же `externalId` гарантированно идемпотентным до ответа провайдера.

## Статусы, поиск и reconciliation

| Метод | Назначение |
|---|---|
| `GET /api/external/queue/v1/transaction/{requestId}` | Полная заявка печати и результат. |
| `GET /api/external/queue/v1/status/{requestId}` | Текущий статус обработки документа. |
| `GET /api/external/queue/v1/statuses?externalId=...&groupId=...` | Заявки по внешнему ID и группе; `externalId` и `groupId` обязательны, `status` необязателен. |
| `GET /api/external/receipts?from=...&to=...` | Документы за период; `from`/`to` обязательны, доступны фильтры `transactionType`, `groupId`, `kkmRegId`, `page`, `pageSize`. |

Статусы очереди: `IN_PROGRESS`, `COMPLETED`, `ERROR`; объект результата также включает `requestId`, `transactionType`, `errorCode`, `errorType`, `details`, `payload`. Ошибка может прийти от API или ККТ — сохранять оба слоя. Поиск `/receipts` возвращает фискальные документы, а не состояние заявки. Список документов за период появился в руководстве 23.07.2026.

## Callback

При переданном `requestMetadata.callbackUrl` система посылает POST после обработки заявки. Публичный manual/OpenAPI не закрепляет однозначную envelope-схему callback, подпись, обязательный HTTP ACK или расписание повторов. Реализация callback-приёмника должна быть идемпотентной, а результат при необходимости подтверждать методом статуса; не добавлять HMAC/RSA или retry policy без письменного подтверждения провайдера.

## Отличие от `kassa-mock` Ferma

Текущий мок воспроизводит Ferma `/possystem/v1/{group}/sell|sell_refund/report`, токен-строку Ferma и статусы `wait/done/fail`. OKassa — Bearer-токен, другая структура `cashboxParameters/requestMetadata/document`, асинхронная очередь, `requestId`, статусы `IN_PROGRESS/COMPLETED/ERROR` и дополнительные операции смены/отчётов. Совпадение предметной области и наличия callback не означает совместимость.
