© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# alfa-mock — мок интернет-эквайринга Альфа-Банка (REST `*.do`)

Второй **внешний банк-адаптер** стенда (issue #41, Stage 2): мок воспроизводит
REST-интерфейс шлюза Альфа-Банка (платформа RBS) —
`https://alfa.rbsuat.com/payment/rest` (тестовый контур) — по публичной
документации: регистрация заказа form-параметрами, платёжная страница `formUrl`
с тестовыми картами и ACS (3DS1/3DS2), статусы `getOrderStatus(Extended).do`,
двухстадийная схема (`registerPreAuth` → `deposit`), `reverse`, полный/частичный
`refund` и callback-уведомления **HTTP GET** с симметричным checksum
**HMAC-SHA256**. Источники — конспекты
[`docs/reference/alfa/`](../../docs/reference/alfa/01-payment-api.md);
интеграционный гайд — [`docs/integration/alfa.md`](../../docs/integration/alfa.md).

## Зачем

- прогнать интеграцию с Альфа-Банком от `register.do` до callback и сверки
  статуса, не подключаясь к банку (тестовые креды банк выдаёт индивидуально);
- отработать ловушки контракта: `errorCode=0` ≠ факт оплаты, уникальный
  `orderNumber` (повтор — ошибка, не replay), суммы в копейках, ACK callback
  ровно HTTP 200, неподписанные уведомления (сверка через REST),
  `sessionTimeoutSecs` → `declinedByTimeout`;
- проверить негативные ветки: неверные креды, `deposit` больше холда, `refund`
  больше списанного, операции не в том статусе, отказы карт (-2011, 116,
  71015) и сетевые сбои (500/504/latency/hang).

## Запуск

```bash
npm run start:alfa          # http://localhost:3104
# или в общем стенде:
docker compose up -d        # alfa-mock на :3104
```

Zero npm dependencies, Node ≥ 18. Стартовый лог печатает **синтетические
дефолты** кредов (если значение задано через env — `<задан через env, скрыт>`,
фактическое значение не печатается), режим checksum, флаги двухстадийной схемы и
ретраев.

## API

| Маршрут | Назначение |
| --- | --- |
| `POST /payment/rest/register.do` | регистрация заказа (одностадийная оплата) → `{orderId, formUrl}` |
| `POST /payment/rest/registerPreAuth.do` | регистрация с холдом (двухстадийная схема) |
| `POST /payment/rest/deposit.do` | завершение холда, сумма ≤ авторизованной |
| `POST /payment/rest/reverse.do` | отмена холда/оплаты до окончательного расчёта |
| `POST /payment/rest/refund.do` | полный/частичный возврат списанного |
| `POST /payment/rest/getOrderStatus.do` | статус заказа (серверная сверка) |
| `POST /payment/rest/getOrderStatusExtended.do` | расширенный статус: суммы авторизации/списания/возврата, код шлюза |
| `GET /payment/{orderId}` | платёжная страница (`formUrl`): тестовые карты, ACS |
| `POST /payment/{orderId}/pay`, `/3ds` | отправка данных карты и пароля ACS (эмуляция формы) |
| `GET /health`, `GET /openapi.json` | живость/счётчики и спецификация OpenAPI 3.1 |
| `GET /admin`, `GET /admin/journal` | консоль (заказы, callback, журнал с curl) |
| `POST /admin/action` | действие консоли (`deposit-order`, `reverse-order`, `expire-order`, `duplicate-callback`); same-origin + CSRF `_csrf` из формы `/admin`, иначе 403 |
| `/mock/time`, `/mock/scenarios`, `/mock/state`, `/mock/reset` | виртуальные часы, сценарии, снимок состояния |
| `/sandboxes*`, `/mock/sandboxes` | песочницы RFC-001 (свои креды на арендатора) |

Транспорт: `POST` c `application/x-www-form-urlencoded` (креды `userName` и
`password` — в каждом запросе, токенов нет). Протокольные ошибки отдаются с
**HTTP 200** и `{errorCode, errorMessage}` — как отвечает шлюз; реальные
HTTP-коды (404/405/413/500/504) — у инфраструктурных сбоев.

## Креды — синтетические, не банковские

Дефолты стенда: `userName=ALFAMOCKTEST`, `password=mockpass123`, секрет
checksum `mocksecret123`. Они **сконструированы по образцу TBANKMOCKTEST** и не
имеют отношения к Альфа-Банку: реальные тестовые реквизиты банк выдаёт
индивидуально при подключении, и зашивать их в дефолты конфига нельзя
(`docs/reference/alfa/03-test-contour.md`). Переопределение —
`MOCK_ALFA_USERNAME`, `MOCK_ALFA_PASSWORD`, `MOCK_ALFA_CALLBACK_SECRET`;
в owned-песочницах у каждого арендатора свои креды (`POST /sandboxes`).

Фактические креды (env или per-sandbox) **не попадают ни в HTTP-ответы, ни в
stdout**: hint ошибки `errorCode=2` называет только синтетические дефолты
(PG-01/PG-02).

## Состояния заказа (`orderStatus`)

| Код | Значение | Как получается в моке |
| --- | --- | --- |
| 0 | зарегистрирован, не оплачен | `register.do` / `registerPreAuth.do` |
| 1 | сумма захолдирована | оплата формы после `registerPreAuth.do` |
| 2 | оплата проведена | оплата формы после `register.do` либо `deposit.do` |
| 3 | авторизация отменена | `reverse.do` из 1 или 2 |
| 4 | проведён возврат | `refund.do` из 2 или 4 |
| 5 | начата аутентификация ACS | отправка 3DS-карты на форме |
| 6 | авторизация отклонена | отказ карты, Fail/неверный пароль ACS, истёк `sessionTimeoutSecs` |

`actionCode` — код ответа шлюза: `0` одобрено, `-2011` (3DS PaRes=U), `116`
(недостаточно средств), `71015` («введённая информация неверна» — неверный
срок/CVV либо Fail на ACS), `5` (общий отказ эмитента: неизвестная валидная
карта, операция без 3DS при выключенном SSL-разрешении).

## Ошибки (формат шлюза + DX)

Ответ ошибки: `{errorCode, errorMessage}` плюс DX-поля мока `field`, `hint`,
`doc` (не часть протокола). Коды — классическая таблица платформы RBS:

| errorCode | Смысл | Типовые причины в моке |
| --- | --- | --- |
| 1 | номер заказа уже зарегистрирован | повтор `orderNumber` |
| 2 | merchant-логин не найден / неверный пароль | чужие креды (в owned-песочнице — креды другой песочницы) |
| 3 | номер заказа некорректен | нет/длиннее 64 символов `orderNumber`, неизвестный `orderId`/`orderNumber` |
| 4 | состояние заказа некорректно | `deposit` не по холду, `refund` до списания, повторный `reverse` |
| 5 | операция отклонена | дробный/отрицательный `amount`, `deposit` > холда, `refund` > списанного, битый `returnUrl`/`jsonParams`, валюта ≠ 643, двухстадийная схема выключена |
| 6 | системная ошибка | сценарий `fail`, неизвестный REST-метод, инфраструктурные сбои (с честными HTTP 404/405/413/500/504) |

## Callback: HTTP GET + checksum HMAC-SHA256

Уведомление доставляется **GET-запросом с query-параметрами**: `mdOrder`
(= `orderId`), `orderNumber`, `operation`, `status` (`1` успех / `0` ошибка),
`amount` (копейки), `callbackCreationDate` (epoch-мс) и `checksum`. Операции:
`approved` (холд), `deposited` (списание), `reversed` (отмена), `refunded`
(возврат), `declinedByTimeout` (истёк срок оплаты), `declinedCardpresent`
(отказ карточной авторизации — см. «Границы и форки»).

- **ACK — ровно HTTP 200**: любой иной код (включая 204) считается неуспехом,
  доставка повторяется. Число попыток и интервал официальный PDF **не задаёт** —
  `MOCK_CALLBACK_RETRY_MS` × `MOCK_CALLBACK_MAX_ATTEMPTS` это mock-конфиг,
  а не параметры банка.
- **Checksum (симметричный режим)**: удалить `checksum` и `sign_alias`,
  отсортировать имена параметров в алфавитном порядке, построить строку
  `name;value;name;value;…;`, HMAC-SHA256 с общим секретом, hex **в верхнем
  регистре**. Пример проверки — в [`docs/integration/alfa.md`](../../docs/integration/alfa.md).
- **Callback без checksum возможен** (`MOCK_CALLBACK_CHECKSUM=false` эмулирует
  этот режим): неподписанное уведомление можно подделать — приёмник обязан
  сверять статус через `getOrderStatusExtended.do`, а не менять состояние заказа
  по одному факту уведомления.
- **Асимметричный режим НЕ реализован**: официальное описание говорит о SHA-256,
  а примеры кода (Java `SHA512withRSA`, PHP `OPENSSL_ALGO_SHA512`) — о SHA-512;
  режим подтверждается банком по merchant-аккаунту. Домысливать алгоритм
  нельзя — вне области #41.
- Адрес приёмника: в бою задаётся в настройках мерчанта банком; у мока —
  `jsonParams.callback_url` (mock-расширение) или `MOCK_DEFAULT_CALLBACK_URL`.
  Без адреса уведомления не уходят — сверка через REST.

## Тестовые карты и ACS

Платёжная страница содержит пресеты карт из официального списка
(`docs/reference/alfa/03-test-contour.md`): успех — `4111111111111111` (3DS1),
`639002000000000003` (МИР, 18 цифр), `2201382000000062` (3DS2 frictionless),
`2200000000000053` и `2201382000000021/13/39/47/54` (3DS2 challenge); отказы —
`5555555555555557`, `4444333322221111`, `5555555544444442` (PaRes=U, `-2011`),
`5432543254325430` (CVV `521`, недостаточно средств, `116`),
`5555555555555599` (без 3DS: успех только при `MOCK_SSL_PERMITTED=true`).
Срок/CVV по умолчанию `1234`/`123`, **пароль тестового ACS — `12345678`**,
владелец карты — минимум два слова латиницей. Неверный срок/CVV, неверный
пароль ACS или кнопка Fail — шлюзовой код `71015`. Оплата проходит только по
тестовым картам: неизвестный валидный PAN отклоняется (`actionCode 5`),
PAN с битой контрольной суммой Луна — `71015`. **PAN не хранится**: в заказе и
журнале остаётся только маска `first6**last4` (F-10), платёжная форма не
журналируется.

## Сценарии (X-Mock-Scenario и /mock/scenarios)

Заголовок `X-Mock-Scenario` (или поле `mock_scenario`, или правила
`POST /mock/scenarios` с `target`): `fail` (системная ошибка, `errorCode 6`),
`hang` (ответ не приходит), `webhook-drop`/`no-callback` (callback подавлен),
`webhook-duplicate`/`callback-duplicate` (две копии уведомления),
`latency:2s`, `http-500`, `http-504` (сетевой сбой до бизнес-логики, честные
HTTP-коды), `X-Mock-Latency: 500ms`. Цели правил: `register`,
`registerpreauth`, `deposit`, `reverse`, `refund`, `getorderstatus`,
`getorderstatusextended`, `pay`, `3ds`, `*`.

Правила, история срабатываний и журнал `/admin/journal` принадлежат текущей песочнице (#52): другие песочницы их не видят и не очищают, `POST /mock/reset` действует только на целевую песочницу. Лимиты: до 200 правил на песочницу и до 8 KiB на правило (превышение — HTTP 400 с `code` `rule_cap_exceeded`/`rule_too_large`).

## Виртуальные часы

`GET/POST /mock/time` (`{"advance":"+25m"}`, `{"offset":60000}`, `{"reset":true}`)
ускоряют истечение `sessionTimeoutSecs` (заказы переходят в `orderStatus=6`
с callback `declinedByTimeout`) и ретраи callback — без реального ожидания.

## Песочницы (RFC-001)

`MOCK_TENANCY=namespaces` (default): изоляция по заголовку `X-Mock-Sandbox`
или `?sandbox=`. `MOCK_TENANCY=owned` (+ `MOCK_SANDBOX_TOKEN` закрывает
default-стенд): `POST /sandboxes` выдаёт песочницу с **своими** кредами
(`userName`, `password`, `callbackSecret` — секрет checksum) и `ownerToken`
(показывается один раз); знание id без owner-token доступа не даёт. Свои
эндпоинты — `/sandboxes/me`, `/sandboxes/me/reset`, `/sandboxes/me/reset-creds`
(ownerToken сохраняется). Лимиты — `MOCK_SANDBOX_MAX`,
`MOCK_SANDBOX_MAX_DOCUMENTS`, `MOCK_SANDBOX_CREATE_LIMIT`, TTL —
`MOCK_SANDBOX_TTL_MS`, retention терминальных callback —
`MOCK_SANDBOX_RETENTION_MS`.

## Переменные окружения

| Переменная | Default | Смысл |
| --- | --- | --- |
| `MOCK_HOST` / `MOCK_PORT` | `0.0.0.0` / `3104` | адрес стенда |
| `MOCK_ALFA_USERNAME` / `ALFA_USERNAME` | `ALFAMOCKTEST` | синтетический merchant-логин |
| `MOCK_ALFA_PASSWORD` / `ALFA_PASSWORD` | `mockpass123` | синтетический пароль |
| `MOCK_ALFA_CALLBACK_SECRET` / `ALFA_CALLBACK_SECRET` | `mocksecret123` | секрет симметричного checksum |
| `MOCK_TWO_STAGE` | `true` | двухстадийная схема (в бою включается банком) |
| `MOCK_PARTIAL_REFUND` | `true` | частичные возвраты («разрешённый контур») |
| `MOCK_SSL_PERMITTED` | `false` | SSL-разрешение на операции без 3DS (карта `5555555555555599`) |
| `MOCK_CALLBACK_CHECKSUM` | `true` | `false` — неподписанные callback (эмуляция оговорки PDF) |
| `MOCK_SESSION_TIMEOUT_SECS` | `1200` | дефолтный срок жизни заказа (переопределяется `sessionTimeoutSecs`); число секунд либо длительность (`'20m'`, `'1h'`), `0`/непарсимое — WARN и `1200` |
| `MOCK_ALFA_TERMINAL_ID` | `ALFA-MOCK-1` | `terminalId` в ответах статуса |
| `MOCK_PUBLIC_BASE_URL` | `http://localhost:3104` | база для `formUrl` |
| `MOCK_DEFAULT_CALLBACK_URL` | — | приёмник GET-callback по умолчанию (mock-расширение) |
| `MOCK_CALLBACK_RETRY_MS` / `MOCK_CALLBACK_MAX_ATTEMPTS` | `10000` / `24` | ретраи доставки — **mock-конфиг** (PDF параметры не задаёт); интервал — мс или длительность (`'1h'`), `0` — повтор без паузы; число попыток < 1 — WARN и 1 попытка |
| `MOCK_STATE_FILE` | — | персистентность состояния между рестартами |
| `MOCK_BLOCK_PRIVATE_WEBHOOKS` | `false` (hosted → `true`) | SSRF-защита исходящих callback |
| `MOCK_VIRTUAL_CLOCK` | — | стартовое смещение виртуальных часов |
| `MOCK_ADMIN_TOKEN` / `MOCK_OPERATOR_TOKEN` | — | токены `/admin*` и `/mock/*` |
| `MOCK_HOSTED` | `false` | `1` — fail-closed управляющей поверхности + SSRF-защита |
| `MOCK_SANDBOX_TTL_MS` / `MOCK_SANDBOX_MAX` | `0` / `owned: 100` | TTL песочницы и лимит их числа (RFC-001) |
| `MOCK_SANDBOX_MAX_DOCUMENTS` | `5000` в `owned`, иначе `0` (выкл.) | квота документов песочницы: заказ + запись очереди callback; внутренний индекс `orderNumbers` документом не считается |
| `MOCK_SANDBOX_CREATE_LIMIT` | `20` в `owned`, иначе `0` (выкл.) | лимит создания песочниц на IP в час |
| `MOCK_SANDBOX_RETENTION_MS` | `0` (выкл.) | retention терминальных записей callback (история заказов не удаляется) |
| `MOCK_SANDBOX_FILE` | `<MOCK_STATE_FILE>.sandboxes.json` | база реестра песочниц: поштучные файлы в каталоге `<база без .json>.records/` (owner-токены — только хэши); в include не проброшена (долг «пяти мест», §2.6 AUDIT-PREP) |
| `MOCK_SANDBOX_SWEEP_MS` | `60000` | интервал воркера TTL/retention; воркер стартует при `TTL>0`, квоте документов `>0` или `RETENTION_MS>0` (в дефолтном `namespaces` не стартует — просрочка удаляется «по касанию»); в include не проброшена (тот же долг) |
| `MOCK_TENANCY`, `MOCK_SANDBOX_*` | — | песочницы RFC-001 (см. выше) |

## Отличия от `tbank-mock` и `yookassa-mock` — не drop-in

| | Т-Банк | ЮKassa | Альфа-Банк |
| --- | --- | --- | --- |
| Транспорт | JSON `POST /v2/*` | JSON `POST /v3/*` + Basic Auth | form-urlencoded `POST /payment/rest/*.do` |
| Авторизация | `TerminalKey` + подпись `Token` (sha256) | `shopId:secretKey` Basic | `userName`/`password` в каждом запросе |
| Идентификатор заказа | `OrderId`/`PaymentId` | `payment_id`/`idempotence_key` | `orderNumber`/`orderId` (`mdOrder`) |
| Ответ регистрации | `{Success, Status, PaymentId, FormUrl}` | `{id, status, confirmation}` | `{errorCode, errorMessage, orderId, formUrl}` |
| Статусы | строковые `NEW/AUTHORIZED/CONFIRMED/…` | `pending/waiting_for_capture/succeeded/…` | числовые `orderStatus 0…6` |
| Callback | подписанный POST, ACK-тело `OK` | POST JSON, ACK 200 | **GET query + checksum HMAC-SHA256**, ACK ровно 200 |
| Идемпотентность | `OrderId` уникален | `Idempotence-Key` | `orderNumber` уникален, повтор — ошибка `errorCode 1` |

Переносить tbank-маршруты, алгоритм подписи `Token` или юKassa-схемы на
Альфу нельзя (`docs/reference/alfa/01-payment-api.md` — «не совместим с
Т-Банком»).

## Границы и документированные форки

Интерпретации мока там, где публичные материалы неполны или противоречивы
(все зафиксированы также в `protocols/alfa-eacq.json` и отчёте PR #41):

1. **Асимметричный checksum не реализован** — официальная PDF-спецификация
   противоречива (описание: SHA-256; примеры Java/PHP: SHA-512), режим
   подтверждается банком. Только симметричный HMAC-SHA256; `sign_alias` не
   отправляется.
2. **Таблица `orderStatus 0…6`** взята из общей нумерации платформы RBS
   (снята в `docs/reference/sber/01-payment-api.md` для того же семейства
   шлюзов; тестовый контур Альфы — `alfa.rbsuat.com`); в альфа-конспекте своя
   таблица не зафиксирована.
3. **Таблица `errorCode 0…6`** — классическая таблица RBS (в альфа-конспекте
   не снята). Маппинг мока: неизвестный заказ → 3; лимиты сумм и некорректные
   параметры → 5; недоступная двухстадийная схема → 5; системные и
   инфраструктурные сбои → 6 (с честными HTTP-кодами 404/405/413/500/504).
4. **`declinedCardpresent`** перечислена в PDF без детальной семантики: мок
   отправляет её при отказе карточной авторизации (форма/ACS) со `status=0`.
   Источник истины — `getOrderStatusExtended.do` (`orderStatus=6`, `actionCode`).
5. **`callbackCreationDate`** — epoch-миллисекунды (формат в конспекте не
   зафиксирован).
6. **Ретраи callback** — собственная конфигурация мока (PDF не задаёт ни число
   попыток, ни интервал; копировать параметры Т-Банка/Сбера как «родные»
   нельзя).
7. **Дефолт `sessionTimeoutSecs` 1200 с (20 минут)** — общая практика
   платформы RBS; лимит `orderNumber` ≤ 64 символов — интерпретация по той же
   практике. В альфа-конспекте оба значения не зафиксированы.
8. **Состав полей `getOrderStatusExtended.do`** (authorized/deposited/
   refundedAmount + даты) — интерпретация по требованию конспекта «различать
   состояние, суммы и код шлюза»; точная схема RBS-ответа публично не снята.
9. **Неизвестный валидный PAN → `actionCode 5`** (общий отказ эмитента),
   **операция без 3DS при выключенном SSL-разрешении → `actionCode 5`** —
   коды отказов для этих веток в конспекте не приведены.
10. **JSON-тело на `*.do` принимается** (толерантность мока для отладки);
    контракт — form-urlencoded.
11. **`/mock/verify-merchant` не реализован**: экзаменатор ядра рассчитан на
    POST-JSON вебхуки (tbank/ferma), а callback Альфы — GET с query;
    алгоритм проверки checksum дан в гайде. Решение как в atol-mock/yookassa
    (#33).
12. **Вне области**: привязки карт (`bindingId`), моделирование `orderBundle`
    (принимается, но не влияет на флоу), `paymentOrder.do` и альтернативные
    каналы, различия координат r-/i-логинов, лимит числа платёжных попыток
    на заказ (в платформе RBS — 3; в альфа-конспекте не зафиксирован).

## Контракты стенда не менялись

Ядро (`packages/core`) расширено **аддитивно**: очередь доставки и `postJson`
научились исходящему `GET` без тела (`request(entry).method`) — для callback
Альфа-Банка; поведение POST-доставки tbank/kassa/yookassa/atol не изменилось
(их selftest'ы проходят без правок). Порты существующих сервисов, их API и
переменные окружения не тронуты; alfa-mock занял следующий свободный порт
**3104**.

Selftest: `npm run test:alfa` (входит в `npm test`); black-box прогон стенда —
`npm run test:compose` (секция 6). Манифест протокола —
`protocols/alfa-eacq.json` (проверяется `npm run check:drift`), спецификация —
`docs/openapi/alfa-mock.openapi.json`.
