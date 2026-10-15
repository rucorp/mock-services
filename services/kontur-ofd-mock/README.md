© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).
SPDX-License-Identifier: Apache-2.0

# kontur-ofd-mock — Контур.ОФД, read/reconciliation

Девятый сервис стенда, касса/ОФД №4, issue #97. **Только чтение** уже
фискализированных документов: это не очередь печати, не Ferma и не OKassa.
Node ≥18, CommonJS, zero dependencies, общее ядро `packages/core` не изменено.

Источник (2026-10-11): официальная документация Контур.ОФД (auth/access, документы).
[Рецепт интеграции, curl, сценарии и полный список `[FORK]`](../../docs/integration/kontur-ofd.md),
[OpenAPI](../../docs/openapi/kontur-ofd-mock.openapi.json),
[drift-манифест](../../protocols/kontur-ofd.json).

## Запуск

```bash
# Сначала задайте синтетические env по рецепту интеграции (см. ссылку выше).
npm run start:kontur-ofd    # :3108
npm run test:kontur-ofd     # HTTP selftest на :0, без Docker
```

Дефолтных login/password/API key **нет**. Без env default-auth закрыт;
в owned-песочнице реквизиты генерируются при `POST /sandboxes`.
Это `[FORK]`: публичных статических тестовых кредов провайдера нет,
выданные ему реквизиты не коммитить и не использовать на mock-стенде.

Docker: `docker build -t mock-services:kontur-local .`, затем
`MOCK_IMAGE=mock-services MOCK_IMAGE_TAG=kontur-local MOCK_IMAGE_DIGEST='' docker compose -f docker-compose.include.yml --profile mock up -d kontur-ofd-mock`.
Старый pinned GHCR-релиз 0.6.0 **не содержит новый сервис**; образ и pin
публикует владелец отдельно. Корневой `docker-compose.yml` намеренно не меняется.

## Контракт

| Метод | Назначение |
| --- | --- |
| `POST /auth/authenticate-by-pass?login=<email>` | UTF-8 plaintext password в body → `{Sid}` |
| `GET /v2/organizations` | доступные организации |
| `GET /v2/organizations/{organizationId}/cashboxes` | кассы, regNumber, модель/ФН, адреса, период доступа |
| `GET .../cashboxes/{kktRegId}/documents?date=YYYY-MM-DD&types=...` | массив документов за день |
| `GET .../documents/by-period?dateFrom=...&dateTo=...&offset=0&limit=1000` | `{documents[],paging.nextOffset}` |
| `GET .../documents/{documentId}` | отдельный документ |
| `GET /health`, `GET /openapi.json` | healthcheck, OpenAPI 3.1 |
| `GET /admin`, `GET /admin/journal` | read-only консоль, журнал без секретов |
| `/mock/time`, `/mock/state`, `/mock/reset`, `/mock/scenarios` | часы, fixtures, reset, сценарии |
| `/sandboxes`, `/sandboxes/me`, `/sandboxes/me/reset`, `/sandboxes/me/reset-creds`, `/mock/sandboxes` | стандартный sandbox control plane |

Все `/v2/...` требуют `Authorization: auth.sid <Sid>` **и**
`X-Kontur-Ofd-ApiKey`. Sid живёт 30 дней на виртуальных часах; при отсутствии,
истечении/отзыве → 401 `errorCodeId=401002`. Пропущенный/неизвестный ключ →
401 `401003`. При ошибках ориентироваться на `errorCodeId`, не на устаревшее
`errorCode`. Неправильные даты/параметры: 400; нет согласия: 403; неизвестный
объект: 404; `fail`: 500. Пустой период → 200, пустой список.

Документы: все 10 типов из среза; суммы **в целых копейках**; в receipt
`items`, `operationType`, `fiscalDocumentNumber`, `fiscalSign`, `id`.
Демо-каталог каждой песочницы: `org-demo`, касса `0000000000000001`,
12 ФД за **2026-10-11**, включая три receipt, один из них возврат.
Демо не меняется от виртуального времени. Фикстуры синтетические, имена
неполностью раскрытых полей и FFD-операции — `[FORK]`.

**[FORK] offset/currentOffset:** каноничен `offset`, `currentOffset` даёт 400
с подсказкой; `nextOffset=null` завершает обход. Выбор согласован с владельцем
до кода по URL-примерам и подтверждён **локальной** OpenAPI/selftest;
подтверждение тестовой схемой провайдера **не получено**. Предел страницы —
1000. UTC без timezone и включённые обе границы периода — `[FORK]`.

## Env

| Переменная | Дефолт / назначение |
| --- | --- |
| `MOCK_HOST`, `MOCK_PORT` | `0.0.0.0`, `3108`; bind/порт сервера |
| `MOCK_HEALTH_PATH` | `/health` в include; используется Docker healthcheck, маршрут сервиса фиксирован |
| `MOCK_KONTUR_OFD_LOGIN` | пусто; синтетический email default-песочницы |
| `MOCK_KONTUR_OFD_PASSWORD` | пусто; UTF-8 plaintext password, не выводится в лог |
| `MOCK_KONTUR_OFD_API_KEY` | пусто; дополнительный ключ data API, не выводится в лог |
| `MOCK_KONTUR_OFD_SID_TTL_SECS` | `2592000`; целые секунды 1..31536000 на виртуальных часах |
| `MOCK_KONTUR_OFD_PUBLIC_BASE_URL` | `http://localhost:${MOCK_KONTUR_OFD_HOST_PORT:-3108}`; публичная база provisioning-ссылок |
| `MOCK_VIRTUAL_CLOCK` | пусто → текущее время; ISO начальных виртуальных часов |
| `MOCK_HOSTED` | `false`; hosted fail-closed для control endpoints |
| `MOCK_TENANCY` | `namespaces`, при hosted → `owned`; поддерживается `off` |
| `MOCK_ADMIN_TOKEN` | пусто; защита `/admin*`, также operator access |
| `MOCK_OPERATOR_TOKEN` | пусто; защита `/mock/*` |
| `MOCK_SANDBOX_TOKEN` | пусто; owner-token default-песочницы; при `MOCK_HOSTED=1` без него `default` не обслуживается (MS-12) |
| `MOCK_SANDBOX_TTL_MS` | owned: `86400000`, иначе `0`; wall-clock TTL песочницы |
| `MOCK_SANDBOX_MAX` | `100`; максимум именованных песочниц |
| `MOCK_SANDBOX_MAX_DOCUMENTS` | owned: `5000`, иначе `0`; число ФД + сессий (квота ядра) |
| `MOCK_SANDBOX_HOST_SUFFIX` | пусто; host-selector ядра для песочниц |
| `MOCK_SANDBOX_CREATE_LIMIT` | `20`; создание owned-песочниц с IP за час, `0` без лимита |
| `MOCK_SANDBOX_SWEEP_MS` | `60000`; интервал wall-clock sweep, unref timer |
| `MOCK_STATE_FILE` | пусто; persist default state, compose `/data/kontur-ofd-state.json` |
| `MOCK_SANDBOX_FILE` | по ядру из state path; compose `/data/kontur-ofd-sandboxes.json` |
| `MOCK_KONTUR_OFD_BIND_IP`, `MOCK_KONTUR_OFD_HOST_PORT` | include-only: `127.0.0.1`, `3108` |
| `MOCK_KONTUR_OFD_CADDY_DOMAIN` | include-only: пусто; optional reverse proxy label |

В owned запросах добавляйте `X-Mock-Sandbox` + `X-Sandbox-Token` **наряду с**
`Authorization: auth.sid ...` и API key. Чужие токены и знание ID не дают прав.
Control token в hosted обязателен; оператор может управлять песочницами,
владелец — только своей. Reset/state import/rotation отзывают Sid;
экспорт `/mock/state` не раскрывает Sid, `/sandboxes/me` не раскрывает креды.
Persist files содержат mock-сессии/креды; защищайте volume и не храните реальные
чеки/ПДн. [Модель угроз](../../SECURITY.md).

## Сценарии и ограничения

`X-Mock-Scenario: fail|hang|duplicate|latency:200ms|http-500|http-504`.
В `POST /mock/scenarios` доступны `target: auth|read|*`, `times`, `persistent`,
`match`; сценарии и журнал изолированы по песочницам. `duplicate` повторяет
тот же ФД перед пагинацией, не создаёт чек. `hang` завершается закрытием
соединения клиентом. Виртуальное время двигается `POST /mock/time`.

**Не моделируется:** создание/фискализация чека, запуск возврата, callback
печати, очередь статусов, Cookie auth.sid, статистика, сложная история согласий
и фильтрация по их периодам. Объединение двух удалённых hosts в один локальный
сервис, numeric cursor/null, fixture-envelope, UTC, повторные Sid, error messages
и сценарии — явно документированные `[FORK]`, не гарантия провайдера.
Проверка реального тестового контура/закрытой схемы не выполнена.

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
