© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# tbank-mock — мок-стенд Т-Банк Мультирасчеты (волна 1)

Локальный «банк» вместо тестового контура Т-Банка: тот же HTTP-контракт
(`/v2/*`), та же Token-подпись, платёжная форма с тестовыми картами, подписанные
http-нотификации с банковскими ретраями, книга сделок (SpAccumulation) и
админ-консоль. Исследовательская база и выбор методов —
`docs/reference/lovii/RES-007-tbank-multisplit-mock-stand.md`, публичные
конспекты — `docs/reference/tbank/*`.

Zero npm dependencies — чистый Node (>= 18), один файл `server.js`.

## Зачем

Реальный тестовый контур банка недоступен без договора + IP-whitelist и требует
запросов с боевого терминала (см. RES-007 §1). Мок даёт управляемые сценарии:
успех/frictionless, 3DS-challenge, недостаточно средств, отказы, частичные
возвраты, дубли и ретраи нотификаций, авто-подтверждение холда.

## Запуск

```bash
docker compose up -d tbank-mock          # порт 3100
# или голым node
MOCK_TERMINAL_KEY=TBANKMOCKTEST MOCK_TERMINAL_PASSWORD=mockpass123 node services/tbank-mock/server.js
```

Самотест (24 сценария: подписи, статусы, DX-ошибки, вебхук-ретраи, регрессы аудита):

```bash
npm run test:tbank
```

## Подключение lovii-core к моку

В `.env` ядра (локально — уже так, на staging — при включении стенда):

```env
PAYMENTS_ENABLED=true
PAYMENTS_FAKE=false                 # мок идёт через НАСТОЯЩИЙ TBankClient
TBANK_API_URL=http://tbank-mock:3100/v2   # внутри docker-сети; локально с хоста: http://localhost:3100/v2
TBANK_TERMINAL_KEY=TBANKMOCKTEST    # те же ключи видит мок
TBANK_TERMINAL_PASSWORD=mockpass123
TBANK_NOTIFICATION_URL=https://<домен ядра>/api/v1/payments/tbank/webhook
```

Код ядра не меняется: `TBankClient` ходит в мок как в банк, вебхуки приходят
снаружи, подпись проверяется по-настоящему (`HandleTBankNotificationAction`).
Внутрипроцессный `FakeTBankClient` (`PAYMENTS_FAKE=true`) остаётся для
дешёвых локальных прогонов без HTTP.

## API мока (волна 1)

| Метод | Поведение |
|---|---|
| `POST /v2/Init` | создаёт сессию (+ сделку при `CreateDealWithType=NN`); требует DealId/флаг сделки, как банк; повторный `OrderId` отклоняется (код 7), чужой `TerminalKey` — код 7 |
| `POST /v2/Confirm` | только из `AUTHORIZED`, сумма ≤ авторизованной → `CONFIRMED`; иначе код 32 |
| `POST /v2/Cancel` | переходы по таблице банка (`NEW→CANCELED`, `→REVERSED/PARTIAL_REVERSED`, `→REFUNDED/PARTIAL_REFUNDED`), идемпотентность по `ExternalRequestId`; `Amount` больше доступной суммы → код 7 |
| `POST /v2/GetState` | текущий статус/сумма; принимает `PaymentId` **или** `OrderId` |
| `POST /v2/CheckOrder` | все попытки по `OrderId` (+ `RRN`) |
| `POST /v2/Chargeback` · `POST /v2/Dispute` | машина состояний чарджбэка: `DISPUTED` (`CHARGEBACK` / `PARTIAL_CHARGEBACK`) → `REPRESENTMENT` → `ARBITRATION` (`ARB`) → `WON` / `LOST` + подписанные вебхуки |
| `GET /v2/Dispute/{id}` | карточка спора и история переходов |
| `GET /payment/{id}` | платёжная форма: тестовые карты-пресеты, ввод карты, «отклонить покупателем» |
| `POST /payment/{id}/pay` · `/otp` | сценарий по PAN (см. ниже), challenge → OTP `1qwezxc`, 3 неверных → отказ |
| `GET /mock/time` · `POST/PUT /mock/time` | виртуальные часы (`{"advance":"7d"}`, `{"advance":"60d"}`, `{"reset":true}`) |
| `GET /mock/scenarios` · `POST/DELETE /mock/scenarios` | сценарное API и журнал срабатываний; заголовок `X-Mock-Scenario: chargeback-after:7d, partial-refund:30%, webhook-drop, webhook-duplicate` |
| `GET /admin` | консоль: платежи/споры/сделки/нотификации/поступления/верификации, журнал запросов, кнопки сценариев (опц. защита `MOCK_ADMIN_TOKEN`) |
| `GET /admin/journal` | JSON-журнал последних API-запросов (метод, путь, поля, код, время); секреты, PAN и PII редактируются — `[REDACTED]`/маска, заголовки только из allowlist (`Content-Type`, `X-Mock-*`) |
| `GET /health` | health-check |

Нотификации: подписанный POST (Token покрывает `SpAccumulationId`) на
`NotificationURL` из Init; ответ должен быть ровно `OK`, иначе ретраи
(`MOCK_RETRY_MS` × `MOCK_MAX_ATTEMPTS`, по умолчанию 60 с × 24 — как у банка
«раз в час в течение суток», но сжато для тестов). Нотифицируемые статусы:
`AUTHORIZED, CONFIRMED, REVERSED, PARTIAL_REVERSED, REFUNDED, PARTIAL_REFUNDED, REJECTED`.

Надёжность очереди (после аудита 2026-10-08): одна нотификация = максимум один
POST «в полёте» (ретраи не накладываются), доставленные записи помечаются `done`
и не переотправляются, а **недоставленные переживают рестарт** с `MOCK_STATE_FILE`
и продолжают ретраиться.

## Песочницы и hosted tenancy (RFC-001, A-21)

Каждый запрос разрешает свою песочницу **один раз** и дальше видит только её
состояние, креды и персистентность: параллельные A/B-запросы не смешиваются
между `await`, а запрос без селектора всегда попадает в `default`, а не
остаётся в предыдущей песочнице. Селектор: `X-Mock-Sandbox: <id>` →
`?sandbox=<id>` → поддомен `<id>.<MOCK_SANDBOX_HOST_SUFFIX>` (если суффикс
задан). `PaymentURL` платежа в именованной песочнице уже содержит `?sandbox=<id>`.

| Режим | Включается | Поведение |
|---|---|---|
| `namespaces` | дефолт self-hosted | `X-Mock-Sandbox` создаёт изолированное пространство имён для параллельных CI-воркеров; креды и управляющие токены — общие |
| `owned` | `MOCK_TENANCY=1` или `MOCK_HOSTED=1` | hosted tenancy: у каждой песочницы свои креды и owner-token (показывается один раз); знание id без owner-token доступа не даёт (401), неизвестный id — 404, истёкший — 410 |
| `off` | `MOCK_TENANCY=0` | одна общая песочница `default`; селектор игнорируется |

API (в `owned` — с owner-token; в `namespaces` те же маршруты управляют
пространствами имён без owner-token):

| Запрос | Что делает |
|---|---|
| `POST /sandboxes` | создать песочницу: `id`, `url`, `creds` (свой TerminalKey/TerminalPassword) и `ownerToken` — показывается один раз |
| `GET /sandboxes` (алиас `GET /mock/sandboxes`) | список: владельцу — своя песочница, оператору (`MOCK_OPERATOR_TOKEN`) — все |
| `DELETE /sandboxes?sandbox=<id>` | удалить песочницу вместе с состоянием (владелец или оператор) |
| `GET /sandboxes/me` | своя песочница: состояние, креды, TTL, расход квоты; `POST /sandboxes/me/reset`, `POST /sandboxes/me/reset-creds`, `DELETE /sandboxes/me` |

Owner-token принимается в `Authorization: Bearer`, `X-Sandbox-Token` или
`?sandbox_token=`. Персистентность: реестр песочниц пишется атомарно в
`<MOCK_STATE_FILE>.sandboxes.json` (хэши owner-токенов + снимки состояния), а
`default` всегда восстанавливается только из `MOCK_STATE_FILE` — состояние
именованной песочницы не может быть выдано за `default` (F-14). Просроченные
песочницы удаляет sweep-воркер; квота документов (`MOCK_SANDBOX_MAX_DOCUMENTS`)
проверяется до создания платежа/сделки/выплаты и отвечает ошибкой 7 с подсказкой.

## Тестовые карты (как у банка, oplata_multisplit.pdf §7)

| PAN | Сценарий |
|---|---|
| `2201382000000013` | успех, frictionless |
| `2201382000000047` | успех, challenge (OTP `1qwezxc`, 3 попытки) |
| `2201382000000039` / `5586200071492158` / `2200770239097761` | успех (attempts / 3DS1 / без 3DS) |
| `2201382000000831` / `4249170392197566` | недостаточно средств |
| `5586200071499591` | недостаточно средств при сумме > 1000 ₽, иначе успех |
| `2201382000000021` / `2201382000000005` / `5586200071492075` | отказы |

## Конфиг (env)

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `MOCK_PORT` / `MOCK_HOST` | `3100` / `0.0.0.0` | прослушивание |
| `MOCK_TERMINAL_KEY` / `MOCK_TERMINAL_PASSWORD` | `TBANK_TERMINAL_*` из env ядра, иначе `TBANKMOCKTEST`/`mockpass123` | ключи терминала мока |
| `MOCK_PUBLIC_BASE_URL` | `http://localhost:3100` | база для `PaymentURL` (виден покупателю!) |
| `MOCK_DEFAULT_NOTIFICATION_URL` | — | куда слать нотификации, если Init без `NotificationURL` |
| `MOCK_RETRY_MS` / `MOCK_MAX_ATTEMPTS` | `60000` / `24` | политика ретраев нотификаций |
| `MOCK_STRICT_TOKEN` | `true` | отклонять запросы без валидного Token |
| `MOCK_ALLOW_DUPLICATE_ORDER_ID` | `false` | разрешить повторный Init с тем же OrderId (по умолчанию — ошибка 7, как в банке) |
| `MOCK_BLOCK_PRIVATE_WEBHOOKS` | `false` (в `MOCK_HOSTED=1` — `true`) | не отправлять нотификации на приватные адреса и имена, которые в них резолвятся (`1`/`true`; `0`/`false` выключает явно) |
| `MOCK_OPERATOR_TOKEN` | — | токен управляющей поверхности: `/mock/*` и `GET /v2/Dispute/{id}` (fallback — `MOCK_ADMIN_TOKEN`) |
| `MOCK_ADMIN_TOKEN` | — | токен админки `/admin*` |
| `MOCK_HOSTED` | `false` | hosted-режим: управляющая поверхность fail-closed без токена, SSRF-политика по умолчанию |
| `MOCK_TENANCY` | `owned` при `MOCK_HOSTED=1`, иначе `namespaces` | режим аренды: `1`/`on` — hosted tenancy с owner-token, `0`/`off` — одна общая песочница (селектор игнорируется) |
| `MOCK_SANDBOX_TOKEN` | — | owner-token default-песочницы в hosted; без него `default` открыт (при старте пишется предупреждение) |
| `MOCK_SANDBOX_TTL_MS` | 24 ч в hosted, иначе 0 (бессрочно) | TTL именованной песочницы; истёкшие удаляет sweep-воркер |
| `MOCK_SANDBOX_MAX` | `100` в hosted, иначе `256` | максимум именованных песочниц |
| `MOCK_SANDBOX_MAX_DOCUMENTS` | `5000` в hosted, иначе `0` (без лимита) | квота документов песочницы (F-15) |
| `MOCK_SANDBOX_HOST_SUFFIX` | — | суффикс поддоменов песочниц, напр. `mock-services.dev`: `<id>.mock-services.dev` |
| `MOCK_SANDBOX_CREATE_LIMIT` | `20` в hosted, иначе `0` | лимит создания песочниц на IP в час |
| `MOCK_SANDBOX_FILE` | `<MOCK_STATE_FILE>.sandboxes.json` | файл реестра песочниц (owner-токены — только хэши) |
| `MOCK_SANDBOX_SWEEP_MS` | `60000` | интервал воркера TTL/retention |
| `MOCK_SANDBOX_RETENTION_MS` | `0` (выкл.) | retention диагностических записей (доставленные нотификации, завершённые верификации) |
| `MOCK_AUTO_CONFIRM_MS` | `0` (выкл.) | авто-подтверждение холда через N мс (банк делает это через 4/7 дней) |
| `MOCK_STATE_FILE` | — | файл персистентности (JSON); без него состояние в памяти |

## Ограничения (осознанные)

- Волна 2 (`/e2c/v2/*` выплаты) и волна 3 (`createSpDeal`/`closeSpDeal`,
  рекуррент, СБП) реализованы частично: маршруты `/e2c/v2/{Init,Payment,GetState}`
  есть, но баланс сделки не валидируется, `CancelPayment`/`GetSbpMembers`/
  `FinalPayout` отсутствуют; рекуррент и СБП не эмулируются — см. RES-007 §8.
- Receipt/54-ФЗ в запросах банка не эмулируются и не валидируются; `DATA`
  передаётся сквозь.
- `FinishAuthorize` (схема PCI DSS без формы банка) не реализован — доступен
  только путь «форма банка».
- Default `PayType` — как у банка (`T`, двухстадийный), но обычный эквайринг без
  сделки (`DealId`/`CreateDealWithType` не переданы) текущая версия **требует**
  профиль Мультирасчетов — см. аудит §4.2 (P0).
- Состояние в памяти (опционально — JSON-файл): рестарт без `MOCK_STATE_FILE`
  сбрасывает сессии.
- Мок должен быть недоступен из интернета без защиты (`SECURITY.md`); в
  production-контуре не включается (`TBANK_API_URL` боевой по умолчанию).
