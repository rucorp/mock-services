# tbank-mock — мок-стенд Т-Банк Мультирасчеты (волна 1)

Локальный «банк» вместо тестового контура Т-Банка: тот же HTTP-контракт
(`/v2/*`), та же Token-подпись, платёжная форма с тестовыми картами, подписанные
http-нотификации с банковскими ретраями, книга сделок (SpAccumulation) и
текстовая админ-консоль. Исследовательская база и выбор методов —
`lovii_docs/artifacts/RES-007-tbank-multisplit-mock-stand.md`, публичные
конспекты — `lovii-ru/lovii-docs` → `tbank/notes/`.

Zero npm dependencies — чистый Node (>= 18), один файл `server.js`.

## Зачем

Реальный тестовый контур банка недоступен без договора + IP-whitelist и требует
запросов с боевого терминала (см. RES-007 §1). Мок даёт управляемые сценарии:
успех/frictionless, 3DS-challenge, недостаточно средств, отказы, частичные
возвраты, дубли и ретраи нотификаций, авто-подтверждение холда.

## Запуск

```bash
# локально (dev compose уже содержит сервис tbank-mock на :3100)
docker compose up -d tbank-mock

# или голым node
MOCK_TERMINAL_KEY=TBANKMOCKTEST MOCK_TERMINAL_PASSWORD=mockpass123 node tbank-mock/server.js
```

Самотест (17 сценариев, включая подписи и вебхук-доставку):

```bash
node tbank-mock/selftest.js
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
| `POST /v2/Init` | создаёт сессию (+ сделку при `CreateDealWithType=NN`); требует DealId/флаг сделки, как банк |
| `POST /v2/Confirm` | только из `AUTHORIZED`, сумма ≤ авторизованной → `CONFIRMED` |
| `POST /v2/Cancel` | переходы по таблице банка (`NEW→CANCELED`, `→REVERSED/PARTIAL_REVERSED`, `→REFUNDED/PARTIAL_REFUNDED`), идемпотентность по `ExternalRequestId` |
| `POST /v2/GetState` | текущий статус/сумма |
| `POST /v2/CheckOrder` | все попытки по `OrderId` |
| `GET /payment/{id}` | платёжная форма: тестовые карты-пресеты, ввод карты, «отклонить покупателем» |
| `POST /payment/{id}/pay` · `/otp` | сценарий по PAN (см. ниже), challenge → OTP `1qwezxc`, 3 неверных → отказ |
| `GET /admin` | консоль: платежи/сделки/нотификации, «банк подтвердил холд», дублирование нотификации |
| `GET /health` | health-check |

Нотификации: подписанный POST (Token покрывает `SpAccumulationId`) на
`NotificationURL` из Init; ответ ядра должен быть ровно `OK`, иначе ретраи
(`MOCK_RETRY_MS` × `MOCK_MAX_ATTEMPTS`, по умолчанию 60 с × 24 — как у банка
«раз в час в течение суток», но сжато для тестов). Нотифицируемые статусы:
`AUTHORIZED, CONFIRMED, REVERSED, PARTIAL_REVERSED, REFUNDED, PARTIAL_REFUNDED, REJECTED`.

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
| `MOCK_PUBLIC_BASE_URL` | `http://localhost:${MOCK_TBANK_HOST_PORT:-3100}` | база для `PaymentURL` (виден покупателю!) |
| `MOCK_DEFAULT_NOTIFICATION_URL` | — | куда слать нотификации, если Init без `NotificationURL` |
| `MOCK_RETRY_MS` / `MOCK_MAX_ATTEMPTS` | `60000` / `24` | политика ретраев нотификаций |
| `MOCK_STRICT_TOKEN` | `true` | отклонять запросы без валидного Token |
| `MOCK_STATE_FILE` | — | файл персистентности (JSON); без него состояние в памяти |

## Ограничения (осознанные)

- Волна 2 (`/e2c/v2/*` выплаты, баланс сделки как валидатор) и волна 3
  (createSpDeal/closeSpDeal, рекуррент, СБП) пока не реализованы — см. RES-007 §8.
- Receipt/54-ФЗ не эмулируются; `DATA` передаётся сквозь, но не валидируется.
- Состояние в памяти (опционально — JSON-файл): рестарт контейнера сбрасывает сессии.
- Мок должен быть недоступен из интернета; в production-контуре не включается
  (`TBANK_API_URL` боевой по умолчанию).
