# mock-services — тестовые моки банков и касс по официальным протоколам

Открытый сервис, который имитирует **банк-эквайринг** и **облачную кассу/ОФД**
по их официальным протоколам, чтобы любой участник рынка (магазин, платформа,
интегратор) тестировал свою платёжную и фискальную интеграцию **до договора с
провайдером** — с честными схемами, кодами ошибок, сценариями отказов и
внятными подсказками «что не так в запросе и как это чинить».

> Статус: **alpha (0.5.0)**. Репозиторий готовится к публикации:
> см. [аудит](docs/audit/AUDIT-2026-10-08.md) и [дорожную карту](#дорожную-карту).
> Сегодня поддерживается: эквайринг Т-Банка (обычный + Мультирасчеты Wave 2, СБП QR, рекурренты `RebillId`/`Charge`, регистрация партнёров `acqapi`, чарджбэки e2e,
> выплаты e2c, верификация AV) и облачная касса OFD Ferma (полная матрица 54-ФЗ:
> `sell`/`buy` + возвраты и коррекции с позиционным контролем, авансы/зачёты, маркировка Честный ЗНАК,
> очередь ОФД, смены ККТ 24ч + Z-отчёты, ресурс ФН, dry-run валидация), а также мульти-песочницы (`X-Mock-Sandbox`), активный экзаменатор вебхуков (`/mock/verify-merchant`), OpenAPI 3.1 (`/openapi.json`) и детектор дрейфа протоколов (`npm run check:drift`). Обе модели — «как у провайдера»: переход на боевой контур =
> смена `TBANK_API_URL`/`FERMA_API_URL`, код интеграции не меняется.

## Зачем

1. Тестовые контуры банков/ОФД доступны только после договора — мок даёт
   рабочий протокол сразу.
2. Реальные шлюзы возвращают сухие коды — мок объясняет ошибку, указывает
   поле, даёт рекомендацию и ссылку на пункт документации.
3. Сценарии отказов (недостаток средств, таймаут, дубль вебхука, чарджбэк,
   отказ ККТ, недоступная касса) — переключателем, а не «ждём боевой инцидент».
4. Новые провайдеры добавляются адаптером-декларацией, без форка сервиса.
5. Журнал запросов (`/admin/journal`) показывает, **как мок понял ваш запрос**,
   и что он ответил.

## Быстрый старт

```bash
# 1. Стенд «банк + касса» целиком
docker compose up            # tbank-mock :3100, kassa-mock :3101

# 2. Без Docker (только Node >= 18, зависимостей нет)
npm run start:tbank          # http://localhost:3100
npm run start:kassa          # http://localhost:3101

# 3. Проверить сам стенд
npm test                     # selftest ядра + обоих адаптеров
```

Инструкции «интеграция за 10 минут»: [`docs/integration/tbank-eacq.md`](docs/integration/tbank-eacq.md)
(эквайринг), [`docs/integration/ferma-ofd.md`](docs/integration/ferma-ofd.md)
(касса/ОФД) и [`docs/integration/lovii.md`](docs/integration/lovii.md)
(подключение как внешнего сервиса в платформу Lovii). Контракты и переменные окружения — в README каждого сервиса
(`services/tbank-mock`, `services/kassa-mock`).

## Структура

```text
packages/core/           — ядро: состояние (persist/restore), очередь вебхуков
                           с ретраями, http-хелперы, каталог ошибок, журнал,
                           виртуальные часы и реестр сценариев; без протоколов провайдеров
services/
  tbank-mock/            — адаптер «Т-Банк эквайринг/Мультирасчеты» (Init/Confirm/Cancel/Chargeback/…)
  kassa-mock/            — адаптер «ОФД Ferma» (getToken/sell/buy/refund/correction/report/ofd/…)
scripts/
  compose-selftest.js    — black-box selftest против поднятого compose-стенда
docs/
  audit/                 — аудит 2026-10-08 и отчёты исполнения
  rfc/                   — проектные решения (RFC-001: изоляция песочниц)
  canon/                 — внутренние спеки и карточки проектов (источник истины)
  integration/           — инструкции «интеграция за 10 минут» + миграция Lovii
  reference/             — референсы для адаптеров (конспекты, снятые страницы доки)
.github/workflows/ci.yml — CI: selftest на Node 18/20/22 + compose-стенд + публикация GHCR
Dockerfile               — образ для обоих сервисов (выбор командой)
docker-compose.include.yml — внешний compose-модуль (профиль mock) для интеграции в core
```

## Что уже умеет мок

| Возможность | tbank-mock | kassa-mock |
|---|---|---|
| Протокол провайдера | `/v2/{Init,Confirm,Cancel,GetState,CheckOrder,Chargeback,Dispute}`, `/e2c/v2/*`, `/av/v1/*` | `/possystem/v1/{getToken,sell,sell_refund,sell_correction,buy,buy_refund,buy_correction,report,stats,ofd/*}` |
| Подпись/авторизация | Token = sha256 (как у банка), `TerminalKey` проверяется | `getToken` + TTL 12 ч |
| Вебхуки | подписанные нотификации, ответ ровно `OK`, ретраи, дамп, `webhook-drop`/`webhook-duplicate` | callback по документу, ретраи до 2xx, повтор кнопкой, `webhook-drop` |
| Машина состояний | NEW→…→AUTHORIZED/CONFIRMED/REVERSED/REFUNDED/CANCELED + чарджбэк DISPUTED→REPRESENTMENT→ARBITRATION→WON/LOST | ККТ: wait → done/fail; ОФД: pending → sent/rejected; связка авансов и возвратов |
| Негативные сценарии и часы | `X-Mock-Scenario` (`chargeback-after:7d`, `partial-refund`, `webhook-drop`), `/mock/scenarios`, `/mock/time` (`+7d`/`+60d`) | `X-Mock-Scenario` (`fail`, `hang`, `ofd-queue`, `ofd-reject`, `mark-fail`, `webhook-drop`), `/mock/time` |
| DX | ошибка = код + поле + подсказка + ссылка на официальную доку; OpenAPI 3.1 (`/openapi.json`); готовый `curl` в журнале | то же в формате Ferma (включая dry-run `/possystem/v1/validate`, валидацию 54-ФЗ, ставок НДС, ИНН, маркировки) |
| Песочницы и проверка интегратора | `X-Mock-Sandbox`, `/mock/sandboxes`, `/mock/reset`, `/mock/state`, активный экзаменатор `POST /mock/verify-merchant` | `X-Mock-Sandbox`, `/mock/sandboxes`, `/mock/reset`, `/mock/state`, `POST /mock/verify-merchant` |
| Наблюдаемость | `/admin` (+ журнал запросов с `curl`, опц. `MOCK_ADMIN_TOKEN`), `/health` | `/admin` (+ журнал запросов с `curl`, очередь ОФД), `/healthz`, чек покупателю |

## Дорожная карта

| Этап | Что | Статус |
|---|---|---|
| 0–3 | спека, перенос моков в репо, ядро, DX-слой с каталогом ошибок | ✅ |
| 4 | **аудит и исправление критичных дефектов** (потеря вебхуков после рестарта, дубли нотификаций, фискальные данные, XSS, валидации денег) + CI/Docker | ✅ 0.2.0 |
| 5 | провайдеро-нейтральный дефолт: `MOCK_PROFILE=plain` (обычный эквайринг, дефолт), профиль Мультирасчетов — конфигом; `X-Mock-Scenario` (kassa) — негативы заголовком запроса | ✅ 0.3.0 |
| 6 | полнота 54-ФЗ: `buy`/`buy_refund`, авансы и зачёты, все ставки НДС (в т.ч. расчётные), очередь ОФД (`pending`/`sent`/`rejected`), маркировка («Честный ЗНАК») | ✅ 0.4.0 |
| 7 | сценарное API (`/mock/scenarios`, `X-Mock-Scenario`) + виртуальные часы (`/mock/time`, `MOCK_VIRTUAL_CLOCK`: тесты «через 7 дней», «через 60 дней») + чарджбэки e2e (`dispute→representment→arb`) + внешний compose/GHCR | ✅ 0.4.0 |
| 8 | мульти-песочницы ([RFC-001](docs/rfc/RFC-001-multi-tenant-sandboxes.md): `X-Mock-Sandbox`, `/mock/state`), активный экзаменатор вебхуков (`/mock/verify-merchant`), хаос (`X-Mock-Latency`), `curl`-сниппеты | ✅ 0.5.0 |
| 9 | Т-Банк Wave 2 + СБП QR + рекурренты + `acqapi`; Касса: смены ККТ (24ч/Z-отчёт), ресурс ФН, позиционный возврат, dry-run `/validate`; OpenAPI 3.1 (`/openapi.json`) + детектор дрейфа протоколов (`npm run check:drift`) | ✅ 0.5.0 |

Детали, оценки и приоритеты — в [аудите](docs/audit/AUDIT-2026-10-08.md) §9.

## Тестирование

```bash
npm test              # всё (core + tbank + kassa + check:drift)
npm run test:core     # ядро (15 проверок): restore/очередь/каталог ошибок/часы/сценарии/песочницы/экзаменатор
npm run test:tbank    # 33 сценария контракта Т-Банка (вкл. чарджбэки e2e, Wave 2, СБП, рекурренты, acqapi)
npm run test:kassa    # 57 проверок контракта Ferma и 54-ФЗ (вкл. buy/авансы/маркировку/смены 24ч/ФН/dry-run)
npm run check:drift   # 134 инварианта: сверка protocols/*.json <-> server.js <-> OpenAPI 3.1 <-> docs/reference
npm run test:compose  # black-box selftest против контейнеров compose (:3100 и :3101)
```

CI гоняет то же на Node 18/20/22 и проверяет, что compose-стенд поднимается.

## Безопасность

Проект — **тестовый стенд**: все креды фейковые, платежи идут только по
тестовым картам, реальные данные использовать нельзя. `/admin` по умолчанию
без аутентификации (локальный DX) — перед публикацией стенда прочитайте
[`SECURITY.md`](SECURITY.md). Для публичного размещения включайте
`MOCK_BLOCK_PRIVATE_WEBHOOKS=1` и изоляцию песочниц (RFC-001).

## Участие

Issues и PR приветствуются: [`CONTRIBUTING.md`](CONTRIBUTING.md). Полезнее всего:
расхождения с официальной докой провайдера (со ссылкой на раздел), новые
сценарии отказов, новые адаптеры.

## Лицензия

Apache-2.0 (см. `LICENSE`, `NOTICE`). Протоколы провайдеров воспроизводятся
по их публичной документации; товарные знаки принадлежат их владельцам и
использованы только для обозначения совместимости.
