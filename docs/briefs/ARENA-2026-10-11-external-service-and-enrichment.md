# Бриф для арены: mock-services как внешний мок-контур Lovii + обогащение сервиса

> Дата: 2026-10-11 · Постановка: владелец · База: `main` @ `2a8d16c` (0.3.0)
> Исполнитель: Arena Agent Mode (работа в фичевых ветках `arena/<краткий-срез>-<тема>`,
> результат — PR в `main` + отчёт в этом брифе или отдельном файле `docs/audit/`).

## 0. Задача в одном абзаце

Довести mock-services до роли **единственного мок-контура платформы Lovii**:
dev-стенд (CHUWI) и staging должны потреблять банк+кассу как **внешний сервис**
(образ/compose этого репо), а не как встроенные копии `tbank-mock/` и
`kassa-mock/` в lovii-core. Попутно — обогатить сервис тем, что нужно этим
двум контурам (полнота 54-ФЗ, сценарное API), не ломая ни один существующий
selftest и не трогая настройку прода (моки в прод не поднимаются и прод-env
не задевают).

## 1. Контекст Lovii (что за потребитель)

Платформа lovii.ru: core API (Laravel) ходит в моки двумя клиентами:

1. **Эквайринг Т-Банка** — платежи заказов, верификация МСП (1 ₽), чарджбэки,
   e2c-выплаты (частично). Конфиг: `TBANK_API_URL` (staging:
   `http://tbank-mock:3100/v2`), публичная форма staging —
   `https://mock-pay-staging.lovii.ru` (Caddy-лейблы в
   `docker-compose.staging-extras.yml`), `MOCK_PUBLIC_BASE_URL`.
2. **ОФД Ferma** — фискализация чеков 54-ФЗ (T-038). Конфиг:
   `FISCALIZATION_PROVIDER=ferma` + `FERMA_API_URL`
   (`http://kassa-mock:3101`), публичный чек покупателю —
   `https://mock-kassa-staging.lovii.ru`.

Сейчас оба сервиса подключены в lovii-core как **встроенные копии**
(`lovii-core/tbank-mock/`, `lovii-core/kassa-mock/`, маунты `./…:/srv:ro`,
профиль compose `mock`). Копии в core **старее** этого репо (до рефакторинга
`packages/core`, 0.3.0) — источником истины является это репо.

Контуры:

| Контур | Что нужно |
|---|---|
| dev-стенд (CHUWI, gostiny-bild) | банк+касса локально, платежи включаются флагом; сброс стенда = свежая копия прода, моки не должны попадать в прод-конфигурацию |
| staging | банк+касса как сейчас (публичные домены mock-pay/mock-kassa через Caddy), но код — из этого репо |
| prod | **моков нет и быть не должно**: боевой Т-Банк, боевой OFD; никакие mock-* сервисы, env-ключи и домены не должны требоваться для подъёма прода |

## 2. Работа 1 (главная): внешний сервис вместо встроенных копий

Цель — lovii-core перестаёт носить код моков. Правила:

1. **Артефакт доставки** — Docker-образ (публикация в GHCR
   `ghcr.io/rucorp/mock-services`, теги по semver + `latest`) и/или
   `docker-compose.include.yml` этого репо, который lovii-core подключает
   как внешний compose-файл. Выбери вариант (или оба) и обоснуй в отчёте.
   Требования: фиксированные имена сервисов `tbank-mock`/`kassa-mock`
   (чтобы `TBANK_API_URL`/`FERMA_API_URL` в core не менялись), healthcheck-и
   как сейчас, лимиты памяти как сейчас, профиль `mock` сохраняется.
2. **Публичные домены staging** (`mock-pay-staging.lovii.ru`,
   `mock-kassa-staging.lovii.ru`) — Caddy-лейблы должны остаться
   конфигурируемыми снаружи (не хардкодить lovii-домены в этом репо:
   параметризуй через переменные, значения по умолчанию — без доменов).
3. **Lovii-специфика — наружу из кода.** Проверь, что в сервисе не осталось
   lovii-констант, которые должны быть env (бренд чека уже параметризован
   аудитом A-17 — сверь; креды/терминалы — env).
4. **Миграция lovii-core** (описать в `docs/integration/lovii.md` как
   пошаговую инструкцию для сопровождающего, сам core менять **не нужно** —
   это отдельная задача в lovii-tech/lovii-core): удалить `tbank-mock/`,
   `kassa-mock/` из дерева core, заменить маунты на образ, обновить
   `docker-compose.staging-extras.yml`, проверить, что `COMPOSE_PROFILES`
   без `mock` (прод-путь) не тянет ничего мокового.
5. **Матрица env по контурам** (dev/staging/prod) — таблица в
   `docs/integration/lovii.md`: какие `TBANK_*`, `FERMA_*`,
   `FISCALIZATION_*`, `MOCK_*` где живут; в prod-колонке — пусто/боевые.
6. **Selftest против собранного образа** (не только исходников) — добавить
   в CI прогон selftest-ов против контейнеров из compose.

Критерий приёмки: стенд Lovii можно поднять, не имея в дереве core ни
строки мок-кода; прод-подъём (профиль без `mock`) не меняется вообще.

## 3. Работа 2: обогащение сервиса (роадмап 6–7, срез под Lovii)

В порядке приоритета (каждый пункт — самостоятельный коммит-набор с
selftest-ами):

1. **Полнота 54-ФЗ (этап 6):** `buy`/`buy_refund` (не только агентская схема),
   авансы/зачёты аванса, ставки НДС все, маркировка (код товара) —
   контракт Ferma; очередь ОФД и статусы «ждёт/передан/отказ».
2. **Сценарное API + виртуальные часы (этап 7):** уже есть `X-Mock-Scenario`
   (kassa) и PAN-сценарии (tbank) — добить до общего механизма: сценарии
   «чарджбэк через N дней», «возврат частичный», «вебхук не пришёл»,
   виртуальное время (`MOCK_VIRTUAL_CLOCK`) для проверок «через 7/60 дней».
3. **Чарджбэк-сценарий банка** end-to-end: dispute → representment →
   arb (машина состояний как у Т-Банка), т.к. Lovii T-024 гоняет чарджбэки
   через internal API и мок должен уметь то же самое снаружи.

Каждое расширение — по официальной доке (папка `docs/reference/`), со
ссылками на разделы в ответах об ошибках (как принято в DX-слое).

## 4. Ограничения и грабли (обязательны)

- **Ничего не ломать в существующих selftest-ах**: `npm test` зелёный до и
  после; новые фичи — с новыми selftest-ами.
- **Zero-dependency** (Node ≥ 18, один файл на сервис) — не тащить npm-пакеты.
- **Провайдеро-нейтральность** (0.3.0): lovii-профили — только через env,
  дефолты не должны знать про Lovii.
- Prod-isolation: любые дефолты compose не должны требовать lovii-доменов,
  секретов или профиля `mock`.
- Не переименовывать существующие маршруты/поля/коды ошибок — внешние
  потребители (core-клиенты, инструкция integration/) завязаны на контракт.
- Работа — ветками `arena/…`, PR в `main`; CI зелёный обязателен.
- В отчёте: что сделано, что нет, где смотреть (selftest/compose-команды),
  что решить владельцу.

## 5. Что уже сделано (не переделывать)

- Аудит 2026-10-08 (§2): A-1…A-19 исправлены, см. §10 аудита.
- `MOCK_PROFILE=plain|multisplit`, `X-Mock-Scenario`, журнал `/admin/journal`,
  CI (Node 18/20/22 + compose-стенд), Dockerfile, community-файлы — 0.2/0.3.
- Открытые рекомендации аудита: A-20 (аутентификация админки), A-21
  (изоляция песочниц, RFC-001), A-22-хвосты (покрытие /e2c, /av,
  duplicate-notification), A-24 (расхождения доки и кода) — можно брать
  в работу попутно, приоритет ниже Работ 1–2.

---

## 6. Отчёт об исполнении (2026-10-11, версия 0.4.0)

> Детальный инженерный отчёт: [`docs/audit/REPORT-2026-10-11-lovii-external-and-enrichment.md`](../audit/REPORT-2026-10-11-lovii-external-and-enrichment.md)
> Ветка: `arena/4ed29025-mock-services`

### 6.1 Что сделано по Работе 1 (внешний сервис вместо встроенных копий)

1. **Артефакты доставки (реализованы оба варианта в связке):**
   - **Docker-образ в GHCR (`ghcr.io/rucorp/mock-services`)**: в `.github/workflows/ci.yml` добавлен job `publish-ghcr`, публикующий при пуше в `main` или теге `v*` теги `:<semver>` (`:0.4.0`), `:latest`, `:sha-<short>`.
   - **Внешний compose-модуль [`docker-compose.include.yml`](../../docker-compose.include.yml)**:
     - фиксированные имена сервисов `tbank-mock` (`:3100`) и `kassa-mock` (`:3101`) — `TBANK_API_URL` и `FERMA_API_URL` в `lovii-core` не меняются;
     - строгий профиль `profiles: ["mock"]` — без `COMPOSE_PROFILES=mock` в прод-контуре не поднимается ни один мок-контейнер (автоматически проверяется в CI);
     - лимиты памяти `mem_limit: ${MOCK_MEM_LIMIT:-128m}` и штатные healthcheck-и (`/health`, `/healthz`);
     - параметризованные Caddy-лейблы (`MOCK_TBANK_CADDY_DOMAIN`, `MOCK_KASSA_CADDY_DOMAIN`), по умолчанию пустые — домены `*.lovii.ru` в репо не захардкожены.
2. **Вынос констант в env:**
   - `kassa-mock` принимает как `MOCK_FERMA_LOGIN`/`MOCK_FERMA_PASSWORD`, так и `FERMA_LOGIN`/`FERMA_PASSWORD` из env ядра (аналогично `TBANK_TERMINAL_*` в `tbank-mock`), плюс параметризованы `MOCK_OFD_INN`, `MOCK_FN_NUMBER`, `MOCK_ECR_RN`, `MOCK_OPERATOR`, `MOCK_FNS_SITE`;
   - в обоих сервисах добавлена опциональная защита `/admin*` токеном `MOCK_ADMIN_TOKEN` (рекомендация аудита A-20).
3. **Инструкция миграции `lovii-core` и матрица env по контурам:**
   - оформлена в [`docs/integration/lovii.md`](../integration/lovii.md): пошаговое удаление `tbank-mock/` и `kassa-mock/` из `lovii-core`, замена на внешний образ/compose, настройка dev-стенда CHUWI и staging, чеклист проверки prod-isolation и полная таблица переменных окружения `dev / staging / prod`.
4. **Selftest против собранного образа и compose-стенда:**
   - добавлен [`scripts/compose-selftest.js`](../../scripts/compose-selftest.js) (`npm run test:compose`, 16 сквозных проверок снаружи по HTTP против контейнеров `:3100` и `:3101`);
   - в `.github/workflows/ci.yml` в job `docker` добавлены проверка prod-изоляции `docker-compose.include.yml`, прогон `npm run test:compose` против живого compose-стенда и запуск всех selftest-наборов внутри собранного контейнера (`docker compose exec`).

### 6.2 Что сделано по Работе 2 (обогащение сервиса, этапы 6–7 роадмапа)

1. **Полнота 54-ФЗ (этап 6, `services/kassa-mock`):**
   - поддержка `buy`, `buy_refund`, `buy_correction` (наряду с `sell`, `sell_refund`, `sell_correction`) как в агентской, так и в неагентской схеме;
   - двухчековая схема авансов и зачётов (`full_prepayment` / `partial_prepayment` / `advance` → `full_payment` / `consideration`) со связкой `prepayment_external_id` и контролем остатка аванса; связка возвратов `origin_external_id` с контролем остатка суммы исходного чека;
   - все ставки НДС по 54-ФЗ (`none`, `vat0`, `vat5`, `vat7`, `vat10`, `vat20`, `vat22` + расчётные ставки предоплаты `vat5_105`, `vat7_107`, `vat10_110`, `vat20_120`, `vat22_122`) с расчётом `payload.vat_amounts` и печатной ленты;
   - маркировка («Честный ЗНАК», ФФД 1.2): `marking_code` / `nomenclature_code`, дробное количество `mark_quantity: {numerator, denominator}`, `measure_unit`, обязательность КМ для `marked_commodity`/`marked_excise`, сценарий отказа `X-Mock-Scenario: mark-fail` (код 58);
   - очередь ОФД и статусы `ofd_status: pending | sent | rejected`, маршруты `GET /possystem/v1/ofd/queue` и `POST /possystem/v1/ofd/mode` (`online`/`offline`/`reject` + `flush`), сценарии `ofd-queue` и `ofd-reject`;
   - валидация `payment_object`, `agent_info.type`, ИНН поставщика (`supplier_info.inn` — 10/12 цифр) и `correction_info`.
2. **Сценарное API + виртуальные часы (этап 7, `packages/core`, `tbank-mock`, `kassa-mock`):**
   - `createVirtualClock` (`MOCK_VIRTUAL_CLOCK`) и HTTP API `GET/POST/PUT /mock/time` (`advance: "7d"`, `"60d"`, `"36h"`, `"13h"`, `reset: true`);
   - `createScenarioRegistry` и HTTP API `GET/POST/DELETE /mock/scenarios` + заголовок `X-Mock-Scenario`: `chargeback-after:7d`, `partial-refund:<sum|%>`, `webhook-drop` («вебхук не пришёл»), `webhook-duplicate`, `ofd-queue`, `ofd-reject`, `mark-fail`.
3. **Чарджбэк-сценарий банка end-to-end (`services/tbank-mock`, T-024):**
   - машина состояний спора `DISPUTED` (`CHARGEBACK` / `PARTIAL_CHARGEBACK`) → `REPRESENTMENT` → `ARBITRATION` (`ARB`) → `WON` / `LOST` через `POST /v2/Chargeback` (и `/v2/Dispute`), `GET /v2/Dispute/:id` и кнопки в `/admin`, с подписанными `Token` нотификациями и восстановлением суммы при `WON`;
   - покрыты в selftest также `/e2c/v2/{Init,Payment,GetState}` и `/av/v1/{payment,verification}` (рекомендация A-22).

### 6.3 Команды проверки

```bash
npm test              # core (12/12) + tbank (28 сценариев) + kassa (45 проверок)
npm run test:compose  # black-box прогон против контейнеров на :3100 и :3101 (16/16)
```

### 6.4 Что остаётся за владельцем / сопровождающим `lovii-core`

1. В репозитории `lovii-tech/lovii-core` выполнить миграцию по инструкции [`docs/integration/lovii.md`](../integration/lovii.md) (`git rm -r tbank-mock/ kassa-mock/` и переключение `docker-compose.staging-extras.yml` на `ghcr.io/rucorp/mock-services:0.4.0`).
2. При необходимости публичного мульти-арендаторского хостинга — этап 8 роадмапа ([RFC-001](../rfc/RFC-001-multi-tenant-sandboxes.md): изоляция песочниц и квоты).

