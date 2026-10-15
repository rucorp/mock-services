© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).
SPDX-License-Identifier: Apache-2.0

# taxcom-mock — Такском, read-only кабинет/ОФД (API v2)

Десятый сервис стенда, касса/ОФД №5, issue #112. **Только чтение** документов,
уже принятых ОФД: это не очередь печати, не Ferma, не АТОЛ и не OKassa.
Node ≥18, CommonJS, zero dependencies, общее ядро `packages/core` не изменено.

Источники (2026-10-11, API Help v2.17):
[авторизация и discovery](../../docs/reference/taxcom/01-api-auth-and-discovery.md),
[документы, частота опроса и границы](../../docs/reference/taxcom/02-documents-and-test-limits.md).
[Рецепт интеграции, curl, сценарии и полный список `[VERIFY]`/`[FORK]`](../../docs/integration/taxcom.md),
[OpenAPI](../../docs/openapi/taxcom-mock.openapi.json),
[drift-манифест](../../protocols/taxcom-ofd.json).

## Запуск

```bash
npm run start:taxcom        # :3109
npm run test:taxcom         # HTTP selftest на :0, без Docker
```

Публичных тестовых `login`/`password`/`Integrator-ID` Такском не публикует —
их выдаёт техподдержка/кабинет. В моке работают **синтетические** дефолты
`taxcommocktest` / `mockpass123` / `TAXCOMMOCKTEST`: они печатаются в стартовом
логе и не являются реквизитами провайдера. Заданные через env креды в логе
скрываются; production-реквизиты в код и compose не попадают. В owned-песочнице
креды генерируются при `POST /sandboxes`.

Docker: сервис есть в корневом `docker-compose.yml` (bind `127.0.0.1:3109` по
умолчанию) и в `docker-compose.include.yml` (профиль `mock`). Для include с
локальной сборкой:

```bash
docker build -t mock-services:taxcom-local .
MOCK_IMAGE=mock-services MOCK_IMAGE_TAG=taxcom-local MOCK_IMAGE_DIGEST='' \
  docker compose -f docker-compose.include.yml --profile mock up -d taxcom-mock
```

Закреплённый GHCR-релиз новый сервис ещё не содержит: образ и pin публикует
владелец отдельно.

## Контракт

| Метод | Назначение |
| --- | --- |
| `POST /API/v2/Login` | заголовок `Integrator-ID` + JSON-тело → `{token}` (временный marker) |
| `GET /API/v2/AccountList` | договоры/личные кабинеты и права пользователя |
| `GET /API/v2/NewDocuments?an=&id=` | поток новых ФД: 10 суток, ≤ 10 000 за вызов, курсор по `id` |
| `GET /health`, `GET /openapi.json` | healthcheck, OpenAPI 3.1 |
| `GET /admin`, `GET /admin/journal` | read-only консоль, журнал без секретов |
| `/mock/time`, `/mock/state`, `/mock/reset`, `/mock/scenarios` | часы, fixtures, reset, сценарии |
| `/sandboxes`, `/sandboxes/me`, `/sandboxes/me/reset`, `/sandboxes/me/reset-creds`, `/mock/sandboxes` | стандартный sandbox control plane |

`POST /API/v2/Login` требует заголовок `Integrator-ID` и JSON-тело.
**[VERIFY]** Официальная схема `Login_Request` в публичной HTML-части API Help
не раскрыта, поэтому реализована консервативная форма `{login, password}`: оба
поля обязательны, неизвестные ключи → `400` с пометкой
`verify: "Login_Request [VERIFY]"`. Имя поля ответа (`token`) — тоже **[VERIFY]**.

Все методы чтения требуют заголовок `Session-Token`. TTL маркера — **300 с
(5 минут)**, sliding от последнего использования, на **виртуальных часах**;
просроченный → `401`. **[FORK]** Повторный Login выдаёт новый маркер, прежний
живёт до своего TTL (срез формулирует иначе — см. гайд и манифест).

`NewDocuments` возвращает документы за последние **10 суток** (нижняя граница
включена), не более **10 000** за вызов, с сортировкой по времени приёма
`receivedAt` (не по фискальному `dateTime`). Первый вызов — без `id`; далее
передаётся `id` последнего полученного документа; пустой массив — хвост.
Ошибки среза: **3106** (нет доступной ККТ → HTTP 403) и **2203** (некорректный
курсор → HTTP 400); соответствие HTTP-статусам — **[VERIFY]**. Конверт ошибки
`{errorCodeId, message, field, hint, doc}`, для прочих случаев `errorCodeId`
равен статусу. Рекомендация опрашивать «не чаще раза в минуту» — совет
документации, не правило мока.

Типы: `openShift`, `closeShift`, `currentStateReport`, `receipt`,
`receiptCorrection`, `bso`, `bsoCorrection`. Демо-каталог каждой песочницы:
договор `1000001` (ККТ с доступом и без согласия), `1000002` (нет доступной
ККТ → 3106), `1000003` (нет согласия, скрыт из `AccountList`); 12 документов в
окне 10 суток, включая возврат прихода (`operationType=2`) и документ старше
окна (в выдачу не попадает). Суммы — **в целых копейках** (конвенция ФФД,
**[FORK]**). Демо-документы задаются смещением от базы стенда
(`MOCK_VIRTUAL_CLOCK` либо wall-clock), чтобы окно не устаревало **[FORK]**.

## Env

| Переменная | Дефолт / назначение |
| --- | --- |
| `MOCK_HOST`, `MOCK_PORT` | `0.0.0.0`, `3109`; bind/порт сервера |
| `MOCK_HEALTH_PATH` | `/health` в compose; используется Docker healthcheck, маршрут сервиса фиксирован |
| `MOCK_TAXCOM_LOGIN` | `taxcommocktest`; синтетический логин default-песочницы |
| `MOCK_TAXCOM_PASSWORD` | `mockpass123`; синтетический пароль, не выводится в лог при override |
| `MOCK_TAXCOM_INTEGRATOR_ID` | `TAXCOMMOCKTEST`; синтетический ID интегратора для заголовка `Integrator-ID` |
| `MOCK_TAXCOM_SESSION_TTL_SECS` | `300`; целые секунды 1..31536000 на виртуальных часах, `0` запрещён |
| `MOCK_TAXCOM_PUBLIC_BASE_URL` | `http://localhost:${MOCK_TAXCOM_HOST_PORT:-3109}`; публичная база provisioning-ссылок |
| `MOCK_VIRTUAL_CLOCK` | пусто → текущее время; ISO/длительность начальных виртуальных часов |
| `MOCK_HOSTED` | `false`; hosted fail-closed для control endpoints |
| `MOCK_TENANCY` | `namespaces`, при hosted → `owned`; поддерживается `off` |
| `MOCK_ADMIN_TOKEN` | пусто; защита `/admin*`, также operator access |
| `MOCK_OPERATOR_TOKEN` | пусто; защита `/mock/*` |
| `MOCK_SANDBOX_TOKEN` | пусто; owner-token default-песочницы |
| `MOCK_SANDBOX_TTL_MS` | owned: `86400000`, иначе `0`; wall-clock TTL песочницы |
| `MOCK_SANDBOX_MAX` | `100`; максимум именованных песочниц |
| `MOCK_SANDBOX_MAX_DOCUMENTS` | owned: `5000`, иначе `0`; число ФД + живых сессий (квота ядра) |
| `MOCK_SANDBOX_HOST_SUFFIX` | пусто; host-selector ядра для песочниц |
| `MOCK_SANDBOX_CREATE_LIMIT` | `20`; создание owned-песочниц с IP за час, `0` без лимита |
| `MOCK_SANDBOX_SWEEP_MS` | `60000`; интервал wall-clock sweep, unref timer |
| `MOCK_STATE_FILE` | пусто; persist default state, compose `/data/taxcom-state.json` |
| `MOCK_SANDBOX_FILE` | по ядру из state path; compose `/data/taxcom-sandboxes.json` |
| `MOCK_TAXCOM_BIND_IP`, `MOCK_TAXCOM_HOST_PORT` | compose-only: `127.0.0.1`, `3109` |
| `MOCK_TAXCOM_CADDY_DOMAIN` | include-only: пусто; optional reverse proxy label |

В owned-запросах добавляйте `X-Mock-Sandbox` + `X-Sandbox-Token` **наряду с**
`Integrator-ID` (на Login) и `Session-Token` (на чтение). Чужие токены и знание
ID прав не дают. Control token в hosted обязателен; оператор управляет
песочницами, владелец — только своей. Reset/state import/ротация отзывают
маркеры; экспорт `/mock/state` их не раскрывает, `/sandboxes/me` не раскрывает
креды повторно. Persist files содержат mock-маркеры/креды: защищайте volume и не
храните реальные ФД и ПДн. [Модель угроз](../../SECURITY.md).

## Сценарии и ограничения

`X-Mock-Scenario: fail|hang|duplicate|latency:200ms|http-500|http-504`.
В `POST /mock/scenarios` доступны `target: auth|read|*`, `times`, `persistent`,
`match`; сценарии и журнал изолированы по песочницам. `duplicate` повторяет
первый документ (тот же `id`/ФД/ФП) до курсорной нарезки, лимит 10 000
сохраняется. Виртуальное время двигается `POST /mock/time`.

**Не моделируется:** создание/фискализация чека, возврат, callback печати,
очередь статусов, чтение одного ФД по ID (публичный URL не подтверждён),
статистика, агрегаты смены со ставками НДС 22%/22-122 (имена полей срезом не
раскрыты — **[VERIFY]**). Известный маршрут с другим методом → `405`,
неизвестный `/API/...` → `404`, обе с подсказкой. У сервиса нет ни callback, ни
webhook — исходящих HTTP-запросов нет, поэтому очередь доставки ядра и
SSRF-политика к этому адаптеру не подключаются. Локальные решения — `[VERIFY]`/`[FORK]` в гайде и
манифесте, а не гарантия соответствия стенду провайдера.

## Байтовые квоты состояния (PD-02)

| Env | Дефолт | Назначение |
| --- | --- | --- |
| `MOCK_SANDBOX_MAX_STATE_BYTES` | пусто: `8388608` (8 МиБ) при `maxDocuments > 0`, иначе без лимита | байты JSON одной песочницы; `0` выключает |
| `MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES` | `67108864` (64 МиБ) | сумма байт JSON всех песочниц рантайма, включая `default`; `0` выключает |

Значения задаются в целых байтах. Пусто сохраняет дефолты. Квота per-sandbox не
ограничивает память контейнера; общий бюджет меньше `mem_limit: 128m`, но не
равен RSS. Превышение глобального бюджета на записи или байтовых квот при
импорте `/mock/state` → HTTP 400, `errorCode: 400`, `kind: 'bytes'`,
`code: sandbox_state_budget_exceeded` / `sandbox_state_quota_exceeded`, с
откатом отклонённого состояния. Правила/история/журнал остаются volatile.
Подробности — [документация ядра](../../packages/core/README.md#байтовые-квоты-песочниц-pd-02-74).
