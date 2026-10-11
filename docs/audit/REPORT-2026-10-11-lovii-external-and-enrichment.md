# Отчёт по брифу 2026-10-11: `mock-services` как внешний мок-контур Lovii + обогащение (0.4.0)

> **Дата:** 2026-10-11 · **Постановка:** [`docs/briefs/ARENA-2026-10-11-external-service-and-enrichment.md`](../briefs/ARENA-2026-10-11-external-service-and-enrichment.md)
> **База:** `main` @ `ee1992c` · **Рабочая ветка:** `arena/4ed29025-mock-services` · **Релиз:** `0.4.0`

---

## 1. Сводка результатов

Все задачи брифа (Работа 1 + Работа 2 + сопутствующие рекомендации аудита A-20/A-22/A-24) выполнены без внешних npm-зависимостей и с полным сохранением обратной совместимости существующих контрактов:

| Срез | Результат | Где смотреть |
|---|---|---|
| **Работа 1.1–1.2:** артефакт доставки + параметризация Caddy | Образ `ghcr.io/rucorp/mock-services` (`:0.4.0`, `:latest`, `:sha-*`) + внешний compose-модуль `docker-compose.include.yml` (профиль `mock`, имена `tbank-mock`/`kassa-mock`, `mem_limit: 128m`, healthcheck, пустые по умолчанию `MOCK_*_CADDY_DOMAIN`) | [`docker-compose.include.yml`](../../docker-compose.include.yml), [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) |
| **Работа 1.3:** вынос констант в env + защита админки | Поддержка `FERMA_LOGIN`/`FERMA_PASSWORD` наряду с `MOCK_FERMA_*`, параметризация `MOCK_OFD_INN`/`MOCK_FN_NUMBER`/`MOCK_ECR_RN`/`MOCK_OPERATOR`, опциональный `MOCK_ADMIN_TOKEN` (A-20) | [`services/kassa-mock/server.js`](../../services/kassa-mock/server.js), [`services/tbank-mock/server.js`](../../services/tbank-mock/server.js) |
| **Работа 1.4–1.5:** миграция `lovii-core` + матрица env `dev/staging/prod` | Пошаговая инструкция удаления встроенных копий и подключения внешнего образа/compose + полная таблица env по 3 контурам с гарантией чистоты прода | [`docs/integration/lovii.md`](../integration/lovii.md) |
| **Работа 1.6:** selftest против собранного образа | `scripts/compose-selftest.js` (`npm run test:compose`, 16 проверок) + запуск selftest-наборов внутри контейнера образа и проверка prod-isolation в CI | [`scripts/compose-selftest.js`](../../scripts/compose-selftest.js), [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) |
| **Работа 2.1:** полнота 54-ФЗ (этап 6) | `buy`/`buy_refund`/`buy_correction`, авансы и зачёты (`prepayment_external_id`, `payments[].type=2`), связка возвратов (`origin_external_id`), все ставки НДС (вкл. расчётные `vat5_105`…`vat22_122`), маркировка («Честный ЗНАК», `marking_code`, `mark_quantity`, `mark-fail`), очередь ОФД (`pending`/`sent`/`rejected`, `/possystem/v1/ofd/*`), валидация `payment_object`/`agent_info`/`supplier_info.inn` | [`services/kassa-mock/server.js`](../../services/kassa-mock/server.js), [`services/kassa-mock/selftest.js`](../../services/kassa-mock/selftest.js) |
| **Работа 2.2:** сценарное API + виртуальные часы (этап 7) | `createVirtualClock` (`MOCK_VIRTUAL_CLOCK`, `GET/POST/PUT /mock/time` со сдвигом `+7d`, `+60d`, `+36h`, `+13h`) + `createScenarioRegistry` (`GET/POST/DELETE /mock/scenarios` и `X-Mock-Scenario`: `chargeback-after:7d`, `partial-refund`, `webhook-drop`, `webhook-duplicate`) | [`packages/core/index.js`](../../packages/core/index.js), [`packages/core/selftest.js`](../../packages/core/selftest.js) |
| **Работа 2.3:** чарджбэк-сценарий банка end-to-end (T-024) | Машина состояний `DISPUTED` (`CHARGEBACK`/`PARTIAL_CHARGEBACK`) → `REPRESENTMENT` → `ARBITRATION` → `WON`/`LOST` (`POST /v2/Chargeback`, `POST /v2/Dispute`, `GET /v2/Dispute/:id`, кнопки в `/admin`, подписанные `Token` нотификации) + покрытие `/e2c` и `/av` в selftest | [`services/tbank-mock/server.js`](../../services/tbank-mock/server.js), [`services/tbank-mock/selftest.js`](../../services/tbank-mock/selftest.js) |

---

## 2. Покрытие тестами (selftest)

| Набор | Команда | Было (0.3.0) | Стало (0.4.0) | Статус |
|---|---|---|---|---|
| Ядро (`packages/core`) | `npm run test:core` | 8 проверок | **12 проверок** (+ `parseDuration`, `createVirtualClock`, `createScenarioRegistry`, `checkAdminAuth`) | ✅ 12/12 |
| Банк (`services/tbank-mock`) | `npm run test:tbank` | 25 сценариев | **28 сценариев** (+ e2e чарджбэк `dispute→representment→arb→won/lost`, `webhook-drop`, `partial-refund`, `chargeback-after:7d`, `/mock/time` `+7d`/`+60d`, `/e2c/v2/*`, `/av/v1/*`) | ✅ PASSED |
| Касса (`services/kassa-mock`) | `npm run test:kassa` | 27 проверок | **45 проверок** (+ `buy`/`buy_refund`, аванс `vat20_120` → зачёт `type=2`, ИНН поставщика, маркировка КМ + `mark_quantity` + `mark-fail`, очередь ОФД `pending`/`sent`/`rejected`, `/mock/time` `+13h`) | ✅ 45/45 |
| Стенд (`compose-selftest`) | `npm run test:compose` | — | **16 проверок** против живых контейнеров `:3100` и `:3101` | ✅ 16/16 |

---

## 3. Что не менялось намеренно (соблюдение ограничений §4 брифа)

- Ни один существующий маршрут, код ошибки или поле ответа не переименованы.
- Zero npm dependencies сохранены (`Node >= 18`, один файл `server.js` на каждый сервис + общее ядро `packages/core/index.js`).
- Дефолты `docker-compose.yml` и `docker-compose.include.yml` не требуют доменов `*.lovii.ru`, секретов или боевого окружения.
- В `docker-compose.include.yml` оба сервиса изолированы в профиле `mock`: запуск без `COMPOSE_PROFILES=mock` (прод-путь) не поднимает ни одного мок-контейнера.

---

## 4. Что решить / выполнить владельцу

1. **Принять PR в `main`** этого репозитория (`rucorp/mock-services`) — после мержа в `main` GitHub Actions автоматически соберёт и опубликует образ `ghcr.io/rucorp/mock-services:0.4.0` и `:latest`.
2. **Выполнить миграцию в `lovii-tech/lovii-core`** по пошаговой инструкции [`docs/integration/lovii.md`](../integration/lovii.md):
   - удалить встроенные папки `tbank-mock/` и `kassa-mock/`;
   - переключить `docker-compose.staging-extras.yml` и стенд CHUWI на внешний образ `ghcr.io/rucorp/mock-services:0.4.0` / `docker-compose.include.yml`.
3. **Опционально для staging:** задать `MOCK_ADMIN_TOKEN` в `.env` staging-стенда, чтобы закрыть веб-консоли `/admin` на публичных поддоменах `mock-pay-staging.lovii.ru` и `mock-kassa-staging.lovii.ru`.
