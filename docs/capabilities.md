© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).
SPDX-License-Identifier: Apache-2.0

# Что уже умеет мок — матрица возможностей

Полная матрица по всем 10 адаптерам. Короткая версия — в [README](../README.md#что-уже-умеет-мок),
детали — в README каждого сервиса и в гайдах «за 10 минут».

> Пометки: см. [легенду VERIFY/FORK](overview.md#пометки-verify-и-fork) — места, где
> публичная документация провайдера не раскрывает деталь (VERIFY) или мок сознательно
> отличается (FORK).

## Банки — эквайринг

### tbank-mock :3100

- **Протокол:** `/v2/{Init,Confirm,Cancel,GetState,CheckOrder,Chargeback,Dispute}`, `/e2c/v2/*`, `/av/v1/*`
- **Auth:** Token = sha256, `TerminalKey` проверяется
- **Вебхуки:** подписанные, ответ `OK`, ретраи, `webhook-drop`/`duplicate`
- **Состояния:** NEW→AUTHORIZED/CONFIRMED/REVERSED/REFUNDED/CANCELED + чарджбэк
- **Сценарии:** `X-Mock-Scenario` (`chargeback-after:7d`, `partial-refund`), `/mock/time`
- **DX:** код + поле + подсказка + ссылка на доку, OpenAPI 3.1, curl в журнале
- **Песочницы:** `X-Mock-Sandbox`, `POST /sandboxes`, `verify-merchant`

### yookassa-mock :3102

- **Протокол:** REST `/v3/{payments,refunds}` + capture/cancel, confirmation страница
- **Auth:** Basic Auth + `Idempotence-Key` (replay того же ключа)
- **Вебхуки:** `{type,event,object}` без подписи, ACK 200, ретраи
- **Состояния:** `pending → waiting_for_capture → succeeded/canceled`, two-stage
- **Сценарии:** `fail`, `hang`, `latency`, `http-500/504`, webhook drop/duplicate
- **DX:** `{type:error, code, description}` + hint/doc, 405/415 пустое тело как у провайдера
- **Песочницы:** `X-Mock-Sandbox`, без `verify-merchant` (вебхуки не подписаны)

### alfa-mock :3104

- **Протокол:** `/payment/rest/{register,registerPreAuth,deposit,reverse,refund,getOrderStatus}.do`, form-urlencoded, `formUrl` + ACS 3DS1/3DS2
- **Auth:** `userName`/`password` в каждом запросе, синтетические `ALFAMOCKTEST`/`mockpass123`, `orderNumber` уникален → `errorCode 1`
- **Вебхуки:** HTTP GET с checksum HMAC-SHA256, ACK 200, ретраи (PDF не задаёт — mock-конфиг)
- **Состояния:** `orderStatus 0…6`, `sessionTimeoutSecs` → `declinedByTimeout`
- **Сценарии:** `X-Mock-Scenario` на `*.do` и форме, отказные карты вместо префиксов
- **DX:** `{errorCode,errorMessage}` + field/hint/doc, OpenAPI 3.1
- **Песочницы:** `X-Mock-Sandbox`, без `verify-merchant` (GET query)

### sber-mock :3105

- **Протокол:** `/ecomm/gw/partner/api/v1/{register,registerPreAuth,deposit,reverse,refund,decline}.do` JSON, hosted form + ACS `111111`
- **Auth:** `userName`/`password` JSON, синтетические `SBERMOCKTEST`/`mockpass123`
- **Вебхуки:** JSON POST без подписи, ACK 200, retry 3×60s
- **Состояния:** `orderStatus 0…6`, TTL 1200s, до 3 попыток оплаты
- **Сценарии:** официальные карты 101/116, `X-Mock-Scenario`, `/mock/time` для TTL
- **DX:** `{errorCode,errorMessage}` + field/hint/doc, errorCode mapping [VERIFY]/[FORK]
- **Песочницы:** RFC-001, без `verify-merchant`

### vtb-mock :3106

- **Протокол:** `/openapi/smb/efcp/e-commerce/v1/{orders,preauth,complete,cancel,refunds}`, OAuth token endpoint
- **Auth:** OAuth 2.0 `client_credentials` + `Authorization: Bearer` + `X-IBM-Client-Id`, синтетические `vtbmocktest`/`mockpass123`, `amount.value` — decimal рубли
- **Вебхуки:** POST `{"type":"PAYMENT|REFUND","object":{…}}` без подписи, любой 2xx считается доставкой [FORK], retry 3×60s
- **Состояния:** ордер `CREATED → PAID → REFUNDED`, операция `NEW/CONFIRMED/RECONCILED`, TTL 20 мин
- **Сценарии:** `status-lowercase`, `reconciled`, синтетические [FORK]-карты (официальная истекла)
- **DX:** `{error, error_description}` + field/hint/doc, envelope [FORK]
- **Песочницы:** `X-Mock-Sandbox` per-sandbox токены и ордеры

## Кассы и ОФД

### kassa-mock :3101 (OFD Ferma)

- **Протокол:** `/possystem/v1/{getToken,sell,sell_refund,sell_correction,buy,buy_refund,buy_correction,report,stats,ofd/*}`
- **Auth:** `getToken` + TTL 12 ч
- **Вебхуки:** callback по документу, ретраи до 2xx
- **Состояния:** ККТ wait→done/fail, ОФД pending→sent/rejected, авансы/возвраты
- **Сценарии:** `fail`, `hang`, `ofd-queue`, `ofd-reject`, `mark-fail`
- **DX:** формат Ferma + dry-run `/validate`, 54-ФЗ, НДС, маркировка
- **Песочницы:** `X-Mock-Sandbox`, `verify-merchant`

### atol-mock :3103

- **Протокол:** `/possystem/v4/{getToken, {group}/{operation}, {group}/report/{uuid}}`, decimal-рубли, страница чека `/receipts/{uuid}`
- **Auth:** `getToken` → токен в заголовке `Token`, TTL 24 ч, идемпотентность `external_id` в пределах группы (replay возвращает прежний UUID)
- **Вебхуки:** callback на `service.callback_url`, без подписи, приёмник идемпотентен
- **Состояния:** очередь `wait → done|fail`, `payload` с ФД/ФП, ФН/ККТ
- **Сценарии:** `fail-`/`hang-` префиксы, `webhook-drop`, `/mock/time` для истечения токена
- **DX:** `{error:{code,text,type,error_id}}` + field/hint/doc
- **Песочницы:** собственные login/pass/группа АТОЛ per-sandbox

### first-ofd-mock :3107 (OKassa)

- **Протокол:** `POST /getToken` + `/api/external/queue/v1/{transaction/{type},transaction/{requestId},status/{requestId},statuses}` + `/api/external/receipts`
- **Auth:** `{login, pass}` (API-ключ UUID) → Bearer-токен 24 ч на виртуальных часах, `requestMetadata.userGroup` сверяется с каталогом, дефолты синтетические
- **Вебхуки:** unsigned POST на `requestMetadata.callbackUrl`, fallback `MOCK_FIRST_OFD_CALLBACK_URL` [FORK], любой 2xx = доставка [FORK], retry 3×60s, SSRF-политика ядра
- **Состояния:** `IN_PROGRESS → COMPLETED|ERROR`, `errorType` — слой ошибки, повторный openShift → `SHIFT_ALREADY_OPEN` [FORK]
- **Сценарии:** `kkt-error`, `api-error`, `getToken-error-quirk`, `webhook-drop`
- **DX:** `{error:{code,text,layer}}` + field/hint/doc, подсказка про `EXPENCE`
- **Песочницы:** заявки, смены, сценарии и часы per-sandbox

### kontur-ofd-mock :3108

- **Протокол:** read/reconciliation — организации, кассы, ФД, суммы в копейках, без создания чека и callback
- **Auth:** Sid + API key, креды только через env (в коде нет)
- **Вебхуки:** нет (read-only)
- **Состояния:** документы уже приняты ОФД, пагинация cursor
- **Сценарии:** синтетический каталог [FORK], cursor — неотрицательный индекс
- **DX:** ошибки как у провайдера, DX-поля — [FORK]
- **Песочницы:** `X-Mock-Sandbox`, каталог независимо копируется per-sandbox

### taxcom-mock :3109

- **Протокол:** `POST /API/v2/Login` с `Integrator-ID` → `Session-Token` TTL 300s sliding, `GET AccountList`, `GET NewDocuments` (10 суток, лимит 10 000, курсор по id, ошибки 3106/2203), write API не моделируется (405/404)
- **Auth:** синтетические `taxcommocktest`/`mockpass123`/`TAXCOMMOCKTEST`, форма тела [VERIFY], повторный Login выдаёт новый marker [FORK]
- **Вебхуки:** нет
- **Состояния:** фискальные документы (смены, состояние расчётов, чеки, БСО), демо-документы по смещению от базы стенда [FORK]
- **Сценарии:** хвост → пустой ответ, 3106 «нет доступной ККТ», 2203 «некорректный курсор»
- **DX:** конверт ошибки [VERIFY], поля ответа [FORK]
- **Песочницы:** owned-режим генерирует собственные mock-реквизиты

## Общие возможности ядра

- **Песочницы:** `X-Mock-Sandbox` (request-local, RFC-001), `POST /sandboxes` (hosted: owner-token, TTL, лимиты), `/sandboxes/me/*`, `/mock/sandboxes`, `/mock/reset`, `/mock/state`
- **Экзаменатор:** `POST /mock/verify-merchant` — активный экзаменатор вебхуков (там, где подпись применима)
- **Часы:** `POST /mock/time` (`+7d`, `+60d`) — TTL токенов, смены 24 ч, ФН, retry
- **Журнал:** `/admin/journal` с готовым `curl`, как мок понял запрос
- **Наблюдаемость:** `/admin` (+ журнал), `/health`/`/healthz`, OpenAPI 3.1 `/openapi.json`, управляющая поверхность под `MOCK_OPERATOR_TOKEN`, админка под `MOCK_ADMIN_TOKEN`
