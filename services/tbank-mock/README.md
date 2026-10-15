© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# tbank-mock — мок-стенд Т-Банк: эквайринг, Мультирасчёты и E2C

Локальный тестовый банк с HTTP-контрактами `/v2/*`, E2C-выплатами, проверкой
счёта, рекуррентными платежами, СБП/QR, партнёрской регистрацией, Token-подписью,
платёжной формой, подписанными нотификациями и админ-консолью. Профиль
`plain` (по умолчанию) моделирует обычный эквайринг; `multisplit` добавляет
обязательные поля и балансовые правила Мультирасчётов. Исследовательская база —
`docs/reference/lovii/RES-007-tbank-multisplit-mock-stand.md`; публичные
конспекты — `docs/reference/tbank/*`.

Node.js >= 18; внешние npm-зависимости не нужны. Сервер использует общий модуль
`packages/core` для HTTP, персистентности, sandbox и защитных helpers.

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

Самотест (48 сценариев: контракты эквайринга/Мультирасчётов/E2C, TerminalKey и CSRF, песочницы, подписи и webhook-ретраи; все процессы слушают ephemeral-порты):

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

## API мока

| Маршрут | Поведение |
|---|---|
| `POST /v2/Init` | создаёт платёж; профиль `plain` допускает обычный эквайринг без сделки, `multisplit` валидирует `DealId`/`CreateDealWithType` и `PaymentRecipientId`; повторный `OrderId` отклоняется, если явно не разрешён |
| `POST /v2/Confirm`, `Cancel`, `GetState`, `CheckOrder` | подтверждение, отмена/возврат, поиск по `PaymentId` или `OrderId`, история попыток по заказу |
| `POST /v2/Chargeback`, `Dispute`; `GET /v2/Dispute/{id}` | dispute/chargeback transitions (`DISPUTED` → `REPRESENTMENT` → `ARBITRATION` → `WON`/`LOST`) с подписанными нотификациями |
| `POST /v2/createSpDeal`, `closeSpDeal` | создание/закрытие сделки Мультирасчётов (также поддерживаются имена `CreateSpDeal`/`CloseSpDeal`) |
| `POST /e2c/v2/Init`, `Payment`, `GetState`, `CancelPayment`, `GetSbpMembers` | payout по карте, СБП или партнёру; баланс сделки, `FinalPayout`, отмена партнёрской выплаты и список участников СБП. Все запросы подписываются и проверяют допустимый `TerminalKey` |
| `POST /v2/GetQr`; `POST /payment/{id}/sbp-pay` | QR СБП и тестовая оплата через СБП |
| `POST /v2/Charge`, `AddCustomer`, `GetCustomer`, `RemoveCustomer`, `AddCard`, `GetCardList`, `RemoveCard` | рекуррентные платежи и управление тестовыми картами покупателя |
| `POST /v2/SendClosingReceipt` | тестовый закрывающий чек |
| `POST /av/v1/payment`, `/av/v1/verification` | account verification: «прогон рубля» и проверка счёта |
| `POST /oauth/token`, `/sm-register/register*` | тестовая OAuth-регистрация партнёра/магазина для E2C partner payouts |
| `GET /payment/{id}`; `POST /payment/{id}/pay`, `/otp`, `/done`, `/reject` | HTML-форма и тестовые сценарии карт; challenge использует OTP `1qwezxc` |
| `GET /mock/time`; `POST/PUT /mock/time`; `GET /mock/scenarios`; `POST/DELETE /mock/scenarios` | виртуальные часы, сценарные правила и история срабатываний; для разового запроса — `X-Mock-Scenario` |
| `GET /admin` | консоль платежей, споров, сделок, уведомлений, поступлений и верификаций; действия форм защищены подписанным CSRF-токеном и same-origin проверкой |
| `GET /admin/journal`, `GET /openapi.json`, `GET /health` | журнал API с редактированием секретов/PII, OpenAPI 3.1 и health-check |

Правила, история срабатываний и журнал `/admin/journal` принадлежат текущей песочнице (#52): другие песочницы их не видят и не очищают, `POST /mock/reset` действует только на целевую песочницу. Лимиты: до 200 правил на песочницу и до 8 KiB на правило (превышение — HTTP 400 с `code` `rule_cap_exceeded`/`rule_too_large`).

### acqapi: OAuth и регистрация точки

`POST /oauth/token` принимает только фактический Basic-клиент: по умолчанию
`partner:partner`, либо `MOCK_ACQAPI_CLIENT_ID` + `MOCK_ACQAPI_CLIENT_SECRET`.
Поддерживаются `grant_type=password` (документированный контур) и
`client_credentials`; ответ выдаёт случайный opaque Bearer со `scope=partner` и
TTL 3600 секунд (переопределяется `MOCK_ACQAPI_TOKEN_TTL_MS`). Токен проверяется
на POST/GET/PATCH `/sm-register/register*`; произвольная строка Bearer, истёкший
токен и запрос без Authorization возвращают 401.

Регистрация требует полную JSON-схему из `docs/reference/tbank/03-payouts-and-deals.md`:
`shopArticleId` (латиница/цифры/`._-`, до 32 символов), `billingDescriptor`,
`fullName`, `name`, `inn`, `kpp`, `ogrn`, непустые `addresses[]` (`type`, `zip`,
`country` ISO-3, `city`, `street`), `ceo.phone`/`ceo.citizenship`,
`founders.individuals[]`, `email`, `siteUrl`, `bankAccount` (`account`,
`korAccount`, `bankName`, `bik`, `details`) и boolean `nonResident`. `kbk` и
`oktmo` при передаче обязательны парой; `mcc` допускается как 4-значный override.
`shopArticleId` без генерации маппится в `shopCode`, который используется как
`PartnerId` в e2c-выплате. Валидация выполняется до записи state.

Терминал проверяется вместе с подписью во всех payout-операциях, включая
`Payment`, `GetState`, `GetSbpMembers` и `CancelPayment`; неверный или отсутствующий
`TerminalKey` возвращает provider-shaped ошибку до поиска/изменения выплаты.
`MOCK_ADMIN_TOKEN` ограничивает консоль, а native POST-формы передают CSRF-токен
и сохраняют query-token админки и owner-token `owned`-песочницы при отправке/redirect.

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
| `namespaces` | дефолт self-hosted; `MOCK_TENANCY=namespaces` | `X-Mock-Sandbox` создаёт изолированное пространство имён для параллельных CI-воркеров; креды и управляющие токены — общие |
| `owned` | `MOCK_HOSTED=1` по умолчанию; `MOCK_TENANCY=owned` (legacy `1`/`on`/`true`/`yes`) | у каждой песочницы свои креды и owner-token (показывается один раз); знание id без owner-token доступа не даёт (401), неизвестный id — 404, истёкший — 410 |
| `off` | `MOCK_TENANCY=off` (legacy `0`/`false`/`no`) | одна общая песочница `default`; селектор игнорируется |

API (в `owned` — с owner-token; в `namespaces` те же маршруты управляют
пространствами имён без owner-token):

| Запрос | Что делает |
|---|---|
| `POST /sandboxes` | создать песочницу: `id`, `url`, `creds` (свой TerminalKey/TerminalPassword) и `ownerToken` — показывается один раз |
| `GET /sandboxes` (алиас `GET /mock/sandboxes`) | список: владельцу — своя песочница, оператору (`MOCK_OPERATOR_TOKEN`) — все |
| `DELETE /sandboxes?sandbox=<id>` | удалить песочницу вместе с состоянием (владелец или оператор) |
| `GET /sandboxes/me` | своя песочница: состояние, креды, TTL, расход квоты; `POST /sandboxes/me/reset`, `POST /sandboxes/me/reset-creds`, `DELETE /sandboxes/me` |

Owner-token принимается в `Authorization: Bearer`, `X-Sandbox-Token` или
`?sandbox_token=`. Персистентность: реестр песочниц пишется атомарно и поштучно —
по файлу `<MOCK_STATE_FILE>.sandboxes.records/<id>.json` на песочницу (хэши owner-токенов +
снимки состояния; мутация переписывает только свою песочницу, PD-02), а
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
| `MOCK_PROFILE` | `plain` | `plain` — обычный эквайринг; `multisplit` — требования Мультирасчётов и валидация сделок |
| `MOCK_TERMINAL_KEY` / `MOCK_TERMINAL_PASSWORD` | `TBANK_TERMINAL_*` из env ядра, иначе `TBANKMOCKTEST`/`mockpass123` | ключи терминала мока |
| `MOCK_PUBLIC_BASE_URL` | `http://localhost:${MOCK_TBANK_HOST_PORT:-3100}` | база для `PaymentURL` (виден покупателю!) |
| `MOCK_ACQAPI_CLIENT_ID` / `MOCK_ACQAPI_CLIENT_SECRET` | `partner` / `partner` | фактические Basic-креды acqapi; секрет не печатается и не хранится в state |
| `MOCK_ACQAPI_TOKEN_TTL_MS` | `3600000` (1 ч) | TTL Bearer-токена acqapi; виртуальные часы применяются для проверки истечения |
| `MOCK_DEFAULT_NOTIFICATION_URL` | — | куда слать нотификации, если Init без `NotificationURL` |
| `MOCK_RETRY_MS` / `MOCK_MAX_ATTEMPTS` | `60000` / `24` | политика ретраев нотификаций |
| `MOCK_STRICT_TOKEN` | `true` | отклонять запросы без валидного Token |
| `MOCK_ALLOW_DUPLICATE_ORDER_ID` | `false` | разрешить повторный Init с тем же OrderId (по умолчанию — ошибка 7, как в банке) |
| `MOCK_BLOCK_PRIVATE_WEBHOOKS` | `false` (в `MOCK_HOSTED=1` — `true`) | не отправлять нотификации на приватные адреса и имена, которые в них резолвятся (`1`/`true`; `0`/`false` выключает явно) |
| `MOCK_OPERATOR_TOKEN` | — | токен управляющей поверхности: `/mock/*` и `GET /v2/Dispute/{id}` (fallback — `MOCK_ADMIN_TOKEN`) |
| `MOCK_ADMIN_TOKEN` | — | токен админки `/admin*`; query-токен из страницы сохраняется в action URL, POST дополнительно требует CSRF-токен и same-origin |
| `MOCK_HOSTED` | `false` | hosted-режим: управляющая поверхность fail-closed без токена, SSRF-политика по умолчанию |
| `MOCK_TENANCY` | `owned` при `MOCK_HOSTED=1`, иначе `namespaces` | `owned`/`namespaces`/`off`; legacy `1`/`on`/`true`/`yes` → `owned`, `0`/`false`/`no` → `off`; неизвестное непустое значение пишет WARN и безопасно возвращается к default |
| `MOCK_SANDBOX_TOKEN` | — | owner-token default-песочницы. При `MOCK_HOSTED=1` без него `default` не обслуживается (MS-12: бизнес/form → 404, стартовый лог `default=closed`); в self-hosted `default` открыта с предупреждением при старте |
| `MOCK_SANDBOX_TTL_MS` | 24 ч в hosted, иначе 0 (бессрочно) | TTL именованной песочницы; истёкшие удаляет sweep-воркер |
| `MOCK_SANDBOX_MAX` | `100` в hosted, иначе `256` | максимум именованных песочниц |
| `MOCK_SANDBOX_MAX_DOCUMENTS` | `5000` в hosted, иначе `0` (без лимита) | квота документов песочницы (F-15) |
| `MOCK_SANDBOX_HOST_SUFFIX` | — | суффикс поддоменов песочниц, напр. `mock-services.dev`: `<id>.mock-services.dev` |
| `MOCK_SANDBOX_CREATE_LIMIT` | `20` в hosted, иначе `0` | лимит создания песочниц на IP в час |
| `MOCK_SANDBOX_FILE` | `<MOCK_STATE_FILE>.sandboxes.json` | база реестра песочниц: поштучные файлы в каталоге `<база без .json>.records/` (owner-токены — только хэши); legacy-файл `<база>` переносится при старте и переименовывается в `.migrated` |
| `MOCK_SANDBOX_SWEEP_MS` | `60000` | интервал воркера TTL/retention |
| `MOCK_SANDBOX_RETENTION_MS` | `0` (выкл.) | retention диагностических записей (доставленные нотификации, завершённые верификации) |
| `MOCK_AUTO_CONFIRM_MS` | `0` (выкл.) | авто-подтверждение холда через N мс (банк делает это через 4/7 дней) |
| `MOCK_STATE_FILE` | — | файл персистентности (JSON); без него состояние в памяти |

## Границы симуляции

- Это локальный mock server, а не тестовый/боевой контур банка: платежи,
  выплаты, СБП и account verification имеют только синтетическое состояние;
  реальные карты, ключи и персональные данные использовать нельзя.
- Поддерживаются только маршруты и конечные автоматы, перечисленные выше.
  Не реализованные методы возвращают provider-shaped ошибку «501»; наличие
  тестового ответа не означает сертификацию или полную эквивалентность API банка.
- Список SBP-участников и карточные сценарии статические. Состояние хранится
  в памяти, если не задан `MOCK_STATE_FILE`; никакие операции не проводят
  реальные денежные средства.
- Перед изменением production-интеграции сверяйте поля и статусы с актуальной
  документацией Т-Банка и согласованным профилем (`plain`/`multisplit`).

## Байтовые квоты состояния (PD-02)

| Env | Дефолт | Назначение |
| --- | --- | --- |
| `MOCK_SANDBOX_MAX_STATE_BYTES` | пусто: `8388608` (8 МиБ) при `maxDocuments > 0`, иначе без лимита | байты JSON одной песочницы; `0` выключает |
| `MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES` | `67108864` (64 МиБ) | сумма байт JSON всех песочниц рантайма, включая `default`; `0` выключает |

Значения задаются в целых байтах. Пусто сохраняет дефолты. Квота per-sandbox
не ограничивает память контейнера; общий бюджет меньше `mem_limit: 128m`, но
не равен RSS. Превышение глобального бюджета на записи или байтовых квот при
импорте `/mock/state` → HTTP 400, `errorCode: 400`, `kind: 'bytes'`,
`code: sandbox_state_budget_exceeded` / `sandbox_state_quota_exceeded`,
с откатом отклонённого состояния. Правила/история/журнал остаются volatile.
Подробности и границы — [документация ядра](../../packages/core/README.md#байтовые-квоты-песочниц-pd-02-74).
