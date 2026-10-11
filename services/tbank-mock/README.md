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
| `GET /admin/journal` | JSON-журнал последних API-запросов (метод, путь, поля, код, время) |
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
| `MOCK_BLOCK_PRIVATE_WEBHOOKS` | `false` | не отправлять нотификации на приватные адреса (включать на публичном стенде) |
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
