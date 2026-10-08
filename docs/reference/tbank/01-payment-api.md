# Конспект: приём платежей (EACQ Мультирасчеты)

Источник: `docs/oplata_multisplit.pdf` («Протокол EACQ Мультирасчеты», 21.03.2025) +
`docs/multisplit.pdf` (описание продукта, 06.04.2026). Конспект — неофициальный.

## Базовые URL

| Контур | URL | Требования |
|---|---|---|
| Тест | `https://rest-api-test.tinkoff.ru/v2` | IP-whitelist через acq_help@tbank.ru; **запросы слать с боевого терминала** |
| Боевой | `https://securepay.tinkoff.ru/v2` | — |

Все методы `POST`, `Content-Type: application/json`; параметры чувствительны к регистру,
порядок не важен. Суммы — в копейках.

## Метод Init (`/v2/Init`)

Инициирует платежную сессию; возвращает `PaymentURL` (ссылка на платёжную форму).

Ключевые параметры запроса:

| Параметр | Тип | Обяз. | Описание |
|---|---|---|---|
| `TerminalKey` | String | да | ключ терминала от банка |
| `Amount` | Number | да | сумма в копейках |
| `OrderId` | String | да | номер заказа в системе площадки |
| `Token` | String | нет* | подпись (см. notes/02); обязательность включается банком |
| `PaymentRecipientId` | String | **да** | идентификатор будущего получателя выплаты (телефон/email/иной, ≤16 симв.) |
| `DealId` | Number | нет, если `CreateDealWithType` | идентификатор существующей сделки |
| `CreateDealWithType` | String | нет | `NN` — создать сделку при этом запросе |
| `LevelOfConfidence` | String | нет | уровень проверки получателя выплаты (`low`/`moderate`/`high`), по согласованию с банком |
| `Currency` | Number | нет | ISO 4217, в текущей версии только 643 (RUB) |
| `CustomerKey` | String | нет | идентификатор покупателя (привязка карт, сохранение карт на форме) |
| `Recurrent` | String | нет | `Y` — рекуррентный платёж (в нотификации AUTHORIZED придёт `RebillId` для `Charge`) |
| `PayType` | String | нет | `O` — одностадийный, `T` — двухстадийный (холд + Confirm) |
| `Language` | String | нет | `ru`/`en` |
| `NotificationURL` | String | нет | куда слать http-нотификации (только порт 443) |
| `SuccessURL` / `FailURL` | String | нет | редирект покупателя после формы |
| `RedirectDueDate` | String | нет | срок жизни ссылки/QR: формат `YYYY-MM-DDTHH24:MI:SS+GMT`, мин. 1 мин, макс. 90 дней; по умолчанию 24 ч для платежа (настройка `REDIRECT_TIMEOUT` терминала) |
| `DATA` | Object | нет | доп. параметры: до 20 пар (ключ ≤20, значение ≤100 симв.); мультисплит-поля `StartSpAccumulation: NN`, `SpAccumulationId`, `BasicFieldKey` (получатель выплаты), `Confidant`; `Phone` обязателен для MCC 4814; `DefaultCard`, `TinkoffPayWeb`, `YandexPayWeb` |
| `Descriptor` | String | нет | динамический дескриптор точки |

Минимальная сумма операции СБП — 10 ₽.

**Идентификатор сделки:** в схеме с формой банка (не PCI DSS) `DealId` в ответе Init
не возвращается — он приходит **в нотификации `AUTHORIZED` параметром `SpAccumulationId`**
(участвует в подписи Token!). В PCI DSS-схеме DealId возвращается в ответах
`FinishAuthorize` / `Submit3DSAuthorization(V2)`.

## Метод Confirm (`/v2/Confirm`)

Списание заблокированных средств (двухстадийная схема). Только для платежей в статусе
`AUTHORIZED`; перед разблокировкой статус становится `CONFIRMING`.

Запрос: `TerminalKey`, `PaymentId` (да), `Token` (да), `IP`, `Amount` (необяз. — ≤ суммы
авторизации), `Receipt` (необяз.). Ответ: `Success`, `ErrorCode` (`0` — успех), `Status`
(`CONFIRMED`), `PaymentId`, `OrderId`, `Message`, `Details`.

## Метод Cancel (`/v2/Cancel`)

| Начальный статус | Статус после операции |
|---|---|
| `NEW` | `CANCELED` (Amount игнорируется, отмена на полную сумму) |
| `AUTHORIZED` | `REVERSED` / `PARTIAL_REVERSED` (разблокировка холда) |
| `CONFIRMED` | `REFUNDED` / `PARTIAL_REFUNDED` (возврат на карту) |

Запрос: `TerminalKey`, `PaymentId`, `Token`, `IP`, `Amount` (частичная сумма),
`QrMemberId` (возврат по СБП в банк-участник), `ExternalRequestId` — идемпотентность
возвратов: повторный запрос с тем же `ExternalRequestId` вернёт текущее состояние,
новую отмену не создаст. Ответ добавляет `OriginalAmount`, `NewAmount`.

## Метод GetState (`/v2/GetState`)

Источник истины о статусе. Запрос: `TerminalKey`, `PaymentId`, `Token`, `IP`.
Ответ: `Success`, `Status`, `OrderId`, `PaymentId`, `Amount`, `ErrorCode`, `Message`, `Details`.

## Метод CheckOrder (`/v2/CheckOrder`)

Все попытки платежа по `OrderId`. Ответ: `Payments[]` с `{PaymentId, Amount, Status, RRN,
Success, ErrorCode, Message}` — удобно для сверок и разбора отказов.

## Статусы платежа

| Статус | Промежуточный | Смысл |
|---|---|---|
| `NEW` | нет | сессия создана, обработка не начата |
| `FORM_SHOWED` | нет | покупатель открыл платёжную форму |
| `AUTHORIZING`, `3DS_CHECKING`, `3DS_CHECKED`, `AUTH_FAIL` | да/нет/да/нет | аутентификация; 3DS_CHECKING > 36 ч автозакрывается |
| `AUTHORIZED` | нет | средства захолдированы; ожидается Confirm |
| `PAY_CHECKING` | да | обрабатывается (до 60 мин до конечного) |
| `CONFIRMING`, `CONFIRM_CHECKING` | да | идёт списание |
| `CONFIRMED` | нет | средства списаны |
| `REVERSING` → `REVERSED` / `PARTIAL_REVERSED` | да→нет | отмена холда |
| `REFUNDING`, `ASYNC_REFUNDING` → `REFUNDED` / `PARTIAL_REFUNDED` | да→нет | возврат по подтверждённому |
| `CANCELED` | нет | отменён продавцом |
| `DEADLINE_EXPIRED` | нет | истёк срок жизни ссылки / 3DS-сессии |
| `REJECTED` | нет | банк отклонил платёж |

## Автоматика банка по сделке (описание продукта §4.1)

- банк **авто-подтверждает** холд по истечении 4 дней (Visa Electron) / 7 дней (MC, МИР, Visa);
- банк **авто-отменяет** заказ по истечении x дней (по умолчанию 60 от авторизации),
  если площадка не закрыла Сделку;
- валидации сделки: выплата только по существующей Сделке, только после успешного
  списания, сумма ≤ остатка сделки, закрытие один раз, возврат после закрытия запрещён.
