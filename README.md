© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).
SPDX-License-Identifier: Apache-2.0

# mock-services — тестовые моки банков и касс по официальным протоколам

Открытый сервис, который имитирует **банк-эквайринг** и **облачную кассу/ОФД**
по их официальным протоколам, чтобы магазин, платформа или интегратор тестировал
платёжную и фискальную интеграцию **до договора с провайдером** — с честными
схемами, кодами ошибок, сценариями отказов и подсказками «что не так в запросе».

> Статус: **alpha (0.7.0)**. См. [дорожную карту](docs/roadmap.md).
> Каждый адаптер следует клиентскому контракту провайдера, но одной смены URL
> для перехода в production недостаточно — проверьте конфигурацию и безопасность.

Поддерживается 10 адаптеров:

- **Банки:** Т-Банк EACQ (Мультирасчеты Wave 2, СБП QR, рекурренты, чарджбэки) :3100,
  ЮKassa REST `/v3` :3102, АТОЛ Онлайн v4 :3103, Альфа-Банк REST :3104,
  Сбер Ecom REST v1.1.11.1 :3105, ВТБ SMB E-commerce :3106
- **Кассы/ОФД:** OFD Ferma 54-ФЗ :3101, Первый ОФД OKassa :3107,
  Контур.ОФД read/reconciliation :3108, Такском API v2 read-only :3109
- **Общее:** мульти-песочницы (`X-Mock-Sandbox`), экзаменатор вебхуков
  (`/mock/verify-merchant`), OpenAPI 3.1 (`/openapi.json`), детектор дрейфа
  (`npm run check:drift`), виртуальные часы (`/mock/time`)

Для read-only ОФД: Контур.ОФД — [гайд](docs/integration/kontur-ofd.md) и
[README сервиса](services/kontur-ofd-mock/README.md); Такском —
[гайд](docs/integration/taxcom.md) и [README сервиса](services/taxcom-mock/README.md).

## Документация

Полный сайт: **<https://rucorp.github.io/mock-services/>** (статический HTML из Markdown, контент доступен без JavaScript).

| Что нужно | Где |
|---|---|
| Карта документов и быстрый старт | [`docs/overview.md`](docs/overview.md) |
| Интеграция «за 10 минут» | [`docs/integration/`](docs/integration/) |
| Что уже умеет мок (матрица) | [`docs/capabilities.md`](docs/capabilities.md) |
| Дорожная карта | [`docs/roadmap.md`](docs/roadmap.md) |
| Контейнерный харденинг | [`docs/hardening.md`](docs/hardening.md) |
| Контракт сервиса и env | [`services/<service>/README.md`](services/) |
| OpenAPI 3.1 | [`docs/openapi/`](docs/openapi/) |
| Проектные решения | [`docs/rfc/`](docs/rfc/) |
| Контрибуция, безопасность, агенты | [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`SECURITY.md`](SECURITY.md) · [`AGENTS.md`](AGENTS.md) |
| История изменений | [`CHANGELOG.md`](CHANGELOG.md) |

Навигация — [`_sidebar.md`](_sidebar.md), проверка — `npm run check:site`.
Пометки `[VERIFY]`/`[FORK]` — см. [легенду в overview](docs/overview.md#пометки-verify-и-fork).

## Зачем

1. Тестовые контуры банков/ОФД доступны только после договора — мок даёт протокол сразу.
2. Реальные шлюзы возвращают сухие коды — мок объясняет ошибку, поле и ссылку на доку.
3. Сценарии отказов (недостаток средств, таймаут, дубль вебхука, чарджбэк, отказ ККТ) — переключателем.
4. Новые провайдеры добавляются адаптером-декларацией, без форка сервиса.
5. Журнал (`/admin/journal`) показывает, как мок понял запрос и что ответил.

## Быстрый старт

```bash
# 1. Все 10 сервисов целиком
docker compose up            # :3100 tbank, :3101 kassa, :3102 yookassa, :3103 atol, :3104 alfa, :3105 sber, :3106 vtb, :3107 first-ofd, :3108 kontur-ofd, :3109 taxcom
# Харденинг (MS-04): read-only rootfs, tmpfs /tmp, cap_drop ALL, no-new-privileges, pids_limit 256, init

# Порты по умолчанию слушают 127.0.0.1. Для сети:
MOCK_TBANK_BIND_IP=0.0.0.0 docker compose up
# Не используйте 0.0.0.0 публично без operator/admin токенов и TLS.

# 2. Без Docker (Node >= 18, зависимостей нет)
npm run start:tbank          # :3100
npm run start:kassa          # :3101
npm run start:yookassa       # :3102
npm run start:atol           # :3103
npm run start:alfa           # :3104
npm run start:sber           # :3105
npm run start:vtb            # :3106
npm run start:first-ofd      # :3107
npm run start:kontur-ofd     # :3108
npm run start:taxcom         # :3109

# 3. Проверить
npm test
```

### Стенд одной командой (без клонирования)

`docker-compose.staging.yml` — tbank-mock :3100 `/health` + kassa-mock :3101 `/healthz` из GHCR-образа с digest:

```bash
curl -fsSLO https://raw.githubusercontent.com/rucorp/mock-services/main/docker-compose.staging.yml
docker compose -f docker-compose.staging.yml up -d
```

URL: `http://<хост>:3100/v2` и `http://<хост>:3101/possystem/v1`.
Публичные URL страниц — `MOCK_TBANK_PUBLIC_BASE_URL`/`MOCK_KASSA_PUBLIC_BASE_URL`.
Для общего хоста задайте `MOCK_OPERATOR_TOKEN`/`MOCK_ADMIN_TOKEN` и TLS — см. [SECURITY.md](SECURITY.md).

### Рецепты «за 10 минут»

| Провайдер | Сервис | Порт | Рецепт | Контракт |
|---|---|---|---|---|
| Т-Банк — эквайринг, Мультирасчеты, СБП QR | `tbank-mock` | 3100 | [tbank-eacq](docs/integration/tbank-eacq.md) | [README](services/tbank-mock/README.md) |
| OFD Ferma — облачная касса 54-ФЗ | `kassa-mock` | 3101 | [ferma-ofd](docs/integration/ferma-ofd.md) | [README](services/kassa-mock/README.md) |
| ЮKassa REST `/v3` | `yookassa-mock` | 3102 | [yookassa](docs/integration/yookassa.md) | [README](services/yookassa-mock/README.md) |
| АТОЛ Онлайн v4 | `atol-mock` | 3103 | [atol](docs/integration/atol.md) | [README](services/atol-mock/README.md) |
| Альфа-Банк REST | `alfa-mock` | 3104 | [alfa](docs/integration/alfa.md) | [README](services/alfa-mock/README.md) |
| Сбербанк Ecom REST | `sber-mock` | 3105 | [sber](docs/integration/sber.md) | [README](services/sber-mock/README.md) |
| ВТБ SMB E-commerce | `vtb-mock` | 3106 | [vtb](docs/integration/vtb.md) | [README](services/vtb-mock/README.md) |
| Первый ОФД OKassa | `first-ofd-mock` | 3107 | [first-ofd](docs/integration/first-ofd.md) | [README](services/first-ofd-mock/README.md) |
| Контур.ОФД read | `kontur-ofd-mock` | 3108 | [kontur-ofd](docs/integration/kontur-ofd.md) | [README](services/kontur-ofd-mock/README.md) |
| Такском API v2 read | `taxcom-mock` | 3109 | [taxcom](docs/integration/taxcom.md) | [README](services/taxcom-mock/README.md) |

Креды всех моков синтетические: `alfa-mock` (`ALFAMOCKTEST`/`mockpass123`),
`sber-mock` (`SBERMOCKTEST`/`mockpass123`), `vtb-mock` (`vtbmocktest`/`mockpass123`),
`first-ofd-mock` (`firstofdmocktest` + UUID), `kontur-ofd-mock` и `taxcom-mock` — через env/лог.

## Структура

```text
packages/core/           — ядро: состояние (persist/restore), очередь вебхуков
                           с ретраями, http-хелперы, каталог ошибок, журнал,
                           виртуальные часы и реестр сценариев
services/
  tbank-mock/            — Т-Банк эквайринг/Мультирасчеты (Init/Confirm/Cancel/Chargeback/…)
  kassa-mock/            — OFD Ferma (getToken/sell/buy/refund/correction/report/ofd/…)
  yookassa-mock/         — ЮKassa (REST /v3: payments/capture/cancel/refunds, confirmation)
  atol-mock/             — АТОЛ Онлайн v4 (getToken/{group}/{operation}/report, callback)
  alfa-mock/             — Альфа-Банк (REST /payment/rest/*.do, formUrl + ACS, GET-callback HMAC-SHA256)
  sber-mock/             — Сбер Ecom REST (JSON /ecomm/gw/partner/api/v1/*.do, formUrl + ACS)
  vtb-mock/              — ВТБ SMB (JSON /openapi/smb/efcp/e-commerce/v1, OAuth2, callback {type,object})
  first-ofd-mock/        — Первый ОФД OKassa (queue /api/external/queue/v1, Bearer 24ч)
  kontur-ofd-mock/       — Контур.ОФД read/reconciliation (Sid + API key, организации/кассы/ФД)
  taxcom-mock/           — Такском read-only API v2 (Login + Integrator-ID → Session-Token 300s, AccountList/NewDocuments)
scripts/
  compose-selftest.js    — black-box selftest против compose-стенда
  check-site.js          — проверка сайта документации и упоминания services/* в README
  check-docs-links.js    — проверка относительных ссылок
  check-protocol-drift.js— детектор дрейфа protocols/*.json ↔ server.js ↔ OpenAPI
docs/
  overview.md            — карта документации и легенда VERIFY/FORK
  capabilities.md        — матрица возможностей по всем адаптерам
  hardening.md           — контейнерный харденинг и graceful shutdown
  roadmap.md             — дорожная карта
  rfc/                   — проектные решения (RFC-001 песочницы)
  integration/           — гайды «за 10 минут»
  openapi/               — OpenAPI 3.1 спецификации
site/                    — сайт документации (docsify без сборки)
index.html               — точка входа сайта (GitHub Pages)
_sidebar.md              — навигация сайта
.github/workflows/ci.yml — CI: selftest Node 18/20/22 + compose + GHCR
Dockerfile               — образ для всех сервисов
docker-compose.yml       — root compose (9 сервисов, kontur-ofd в include)
docker-compose.include.yml — внешний compose-модуль (профиль mock, 10 сервисов)
docker-compose.staging.yml — стенд одной командой (tbank + kassa)
```

## Что уже умеет мок

Кратко: все адаптеры поддерживают протоколы провайдеров, подписи/авторизацию,
вебхуки с ретраями, машины состояний, негативные сценарии (`X-Mock-Scenario`),
виртуальные часы (`/mock/time`), песочницы RFC-001 и журнал с curl.

Полная матрица — в [docs/capabilities.md](docs/capabilities.md) (по 10 сервисам,
без огромных строк в README).

## Дорожная карта

Этапы 0–17: от ядра и DX до 10 внешних адаптеров (ЮKassa, АТОЛ, Альфа, Сбер, ВТБ,
Первый ОФД, Контур.ОФД, Такском) + мульти-песочницы, часы, OpenAPI, drift-детектор.

Подробно — в [docs/roadmap.md](docs/roadmap.md) и [CHANGELOG.md](CHANGELOG.md).

## Контейнерный харденинг

`init`, `read_only`, `tmpfs /tmp`, `cap_drop ALL`, `no-new-privileges`, `pids_limit 256`,
graceful shutdown с синхронным сбросом состояния (150 мс debounce) и exit 0 ≤ 2 с.

Подробно — в [docs/hardening.md](docs/hardening.md) и [SECURITY.md](SECURITY.md).

## Тестирование

```bash
npm test              # всё: core + 10 адаптеров + check:links + check:site + check:drift
npm run test:core     # ядро: restore/очередь/ошибки/часы/сценарии/песочницы/SSRF/CSRF
npm run test:tbank    # Т-Банк: E2C, чарджбэки, СБП, рекурренты, песочницы
npm run test:kassa    # Ferma: 54-ФЗ, ОФД/ФН, смены, маркировка, песочницы
npm run test:yookassa # ЮKassa: идемпотентность, карты/3DS, вебхуки ACK 200
npm run test:atol     # АТОЛ: дедуп external_id, callback, ФФД 1.05, токен 24ч
npm run test:alfa     # Альфа: register/preAuth/deposit/reverse/refund, 3DS, GET-callback HMAC
npm run test:sber     # Сбер: register/preAuth, карты ACS, TTL, JSON callbacks
npm run test:vtb      # ВТБ: OAuth, orders/preauth/complete/cancel/refunds, callback {type,object}
npm run test:first-ofd # Первый ОФД: getToken 24ч, очередь IN_PROGRESS→COMPLETED|ERROR, callback
npm run test:kontur-ofd # Контур.ОФД: Sid/API key, документы, пагинация, песочницы
npm run test:taxcom    # Такском: Login/Integrator-ID, Session-Token 300s, AccountList/NewDocuments
npm run check:links   # относительные ссылки markdown
npm run check:drift   # 828 инвариантов protocols ↔ server.js ↔ OpenAPI
npm run test:docker   # image smoke (нужен docker): healthchecks, persist/restore при read-only rootfs
npm run test:compose  # black-box selftest против compose (:3100–:3109)
```

CI гоняет то же на Node 20/22/24.

## Безопасность

Тестовый стенд: все креды фейковые, платежи по тестовым картам.
`/admin` без аутентификации по умолчанию (локальный DX) — см. [SECURITY.md](SECURITY.md).
Для публичного размещения: `MOCK_HOSTED=1`, `MOCK_OPERATOR_TOKEN`, `MOCK_ADMIN_TOKEN`,
`MOCK_SANDBOX_TOKEN` (без него `default`-песочница отвечает 404), TLS и egress-фильтр.
Токены не возвращаются в URL/HTML — после `POST /admin/login` HttpOnly-cookie.
Песочницы изолированы по [RFC-001](docs/rfc/RFC-001-multi-tenant-sandboxes.md).

## Участие

Issues и PR приветствуются: [CONTRIBUTING.md](CONTRIBUTING.md).
Полезнее всего: расхождения с официальной докой (со ссылкой), новые сценарии отказов,
новые адаптеры. Правила для ИИ-агентов — [AGENTS.md](AGENTS.md).

## Ограничения и лимиты

Общий бюджет состояния песочниц (PD-02): `MOCK_SANDBOX_MAX_STATE_BYTES` (per-sandbox,
дефолт 8 МиБ при квоте документов) и `MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES` (все песочницы,
дефолт 64 МиБ). `0` выключает лимит. Превышение → 400 + `sandbox_state_budget_exceeded`.
См. [ядро](packages/core/README.md#байтовые-квоты-песочниц-pd-02-74) и env-таблицы сервисов.

## Лицензия

Apache-2.0 (см. `LICENSE`, `NOTICE`). Протоколы провайдеров воспроизводятся по их
публичной документации; товарные знаки принадлежат их владельцам.

<!-- Внутренние документы: закрытый репозиторий команды `mock-services-docs` — см. docs/overview.md -->
