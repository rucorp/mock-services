© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# kassa-mock — мок облачной кассы OFD Ferma (T-038)

Пара к `tbank-mock`: вместе они образуют локальный мок-стенд «банк + касса»
для тестирования платёжно-фискального контура по контракту Ferma. Стенд не
проксирует запросы в Ferma и не предназначен для боевых реквизитов; переключать
интеграцию на production нужно отдельно, не только заменой URL.

Node.js >= 18; внешние npm-зависимости не нужны. Сервер использует общий модуль
`packages/core` для HTTP, персистентности, sandbox и защитных helpers.

## Контракт (по документации Ferma)

| Метод | Поведение |
|---|---|
| `POST /possystem/v1/getToken` | `{login, pass}` → `{token}` (TTL 12 ч, `MOCK_TOKEN_TTL_MS`); неверные → `error.code=14`, истёкший токен → `error.code=11` |
| `POST /possystem/v1/{group}/sell` | чек прихода («Предоплата/Аванс/Полный расчёт/Зачёт аванса») → `{uuid, status:"wait"}`; дубли external_id → `error.code=12`; невалидный чек → `error.code=4` + `field` + `hint` |
| `POST /possystem/v1/{group}/sell_refund` | чек возврата прихода (опц. `origin_external_id` со сверкой остатка) |
| `POST /possystem/v1/{group}/sell_correction` | чек коррекции прихода (валидация `correction_info`) |
| `POST /possystem/v1/{group}/buy` | чек расхода (выплаты физлицам / агентские и неагентские схемы) |
| `POST /possystem/v1/{group}/buy_refund` | чек возврата расхода (опц. `origin_external_id` со сверкой остатка) |
| `POST /possystem/v1/{group}/buy_correction` | чек коррекции расхода |
| `GET /possystem/v1/{group}/report/{uuid}` | `{status: wait\|done\|fail, ofd_status: pending\|sent\|rejected, payload:{ФД/ФП, ofd_receipt_url, vat_amounts, marking_verified,…}}` |
| `GET /possystem/v1/ofd/queue` | очередь документов в ОФД (`ofdMode`, `count`, `items`) |
| `POST /possystem/v1/ofd/mode` | управление связью с ОФД (`{mode: "online"\|"offline"\|"reject", flush: true}`) |
| `GET /possystem/v1/stats/cashboxes/extended` | мониторинг кассы (kktState, тариф, счётчик чеков, `ofdMode`, `ofdQueueCount`) |
| `GET/POST/PUT /mock/time` | виртуальные часы (`{"advance":"13h"}`, `{"reset":true}`) |
| `GET/POST/DELETE /mock/scenarios` | сценарное API + заголовок `X-Mock-Scenario: fail\|hang\|ofd-queue\|ofd-reject\|mark-fail\|webhook-drop` |
| `GET /admin` | консоль: последние 50 документов, фискальные данные, статус ОФД, журнал запросов; формы действий защищены подписанным CSRF-токеном и same-origin проверкой |
| `GET /admin/journal` | JSON-журнал последних API-запросов; креды `getToken` (`login`/`pass`), токены и реквизиты покупателя редактируются — `[REDACTED]`/маска, заголовки только из allowlist |
| `GET /healthz` | ok/касса недоступна + `ofdMode` и `ofdQueueCount` |

Правила, история срабатываний и журнал `/admin/journal` принадлежат текущей песочнице (#52): другие песочницы их не видят и не очищают, `POST /mock/reset` действует только на целевую песочницу. Лимиты: до 200 правил на песочницу и до 8 KiB на правило (превышение — HTTP 400 с `code` `rule_cap_exceeded`/`rule_too_large`).

### Валидация чека (DX-слой)

До «печати» проверяются инварианты, которые в бою проверит касса/ФНС:

- `items[]` — непустой массив, у позиции `name`, `price`, `quantity`, `sum = price × quantity`;
- `total` = сумме позиций; Σ `payments[].sum` = `total`;
- `vat.type` — из справочника (`none, vat0, vat5, vat7, vat10, vat20, vat22`);
- `payment_method` — из справочника 54-ФЗ (`full_prepayment`, `advance`, `full_payment`, `consideration`, …);
- `payments[].type` — 1..5 (электронными/предоплата/постоплата/иная/наличные).

Ошибка приходит в формате Ferma с расширением DX:
`{"error":{"code":4,"field":"receipt.total","hint":"Итог 50000 ≠ сумме позиций 100…"}}`.
Отключается `MOCK_VALIDATE_RECEIPTS=false`.

Через `MOCK_PROCESS_MS` (по умолчанию 15 с; `0` — печатать мгновенно) документ
«печатается»: фиксируется время печати, присваивается уникальный номер чека за
смену, генерируются ФД/ФП/фискальный признак, в лог печатается текст чека,
результат POST'ом уходит на `receipts.service.callback_url` (ретраи, как у Ferma,
и **продолжение ретраев после рестарта** с `MOCK_STATE_FILE`). Чек покупателю
«доставляется» страницей `GET /receipts/{uuid}` (это и есть `ofd_receipt_url`).

## Негативные сценарии (драйвер Фазы 4)

- `external_id` с префиксом **`fail-`** → документ обрабатывается, статус
  `fail` + `error` → ядро получает callback с ошибкой, джоба ретраит;
- префикс **`hang-`** → вечный `wait`, callback не отправляется (зависший чек);
- `MOCK_FERMA_DOWN=1` (опц. `MOCK_FERMA_DOWN_MS=N` для авто-восстановления)
  → все `/possystem/*` отвечают 503 «касса недоступна» — сценарий
  «приняли деньги, касса легла»;
- неверный логин/пароль/токен → ошибки контракта (14/11);
- чек с нарушенными инвариантами → ошибка 4 с указанием поля (см. выше);
- кнопка «callback» в `/admin` — повторная доставка результата (проверка
  идемпотентности на стороне интегратора).

> Префиксы `fail-`/`hang-` — удобная конвенция, если вы контролируете
> `external_id`. Для произвольных идентификаторов используйте заголовок
> `X-Mock-Scenario` или программируемые правила сценариев `/mock/scenarios`;
> административные кнопки работают только через форму с CSRF-токеном.

## Запуск

```bash
docker compose up -d kassa-mock      # порт 3101
# или голым node
MOCK_FERMA_LOGIN=loviitest MOCK_FERMA_PASSWORD=mockpass123 node services/kassa-mock/server.js
```

Самотест (129 проверок: контракт Ferma и 54-ФЗ, сценарии ОФД/маркировки,
управляющие токены и CSRF, песочницы, динамические ephemeral-порты,
ожидание состояний вместо фиксированных sleep и рестарт callback-очереди):

```bash
npm run test:kassa
```

## Подключение lovii-core

В `.env` ядра:

```env
FISCALIZATION_ENABLED=true
FISCALIZATION_PROVIDER=ferma            # не mock: тот же FermaProvider, что в бою
FERMA_API_URL=http://kassa-mock:3101    # внутри docker-сети
FERMA_LOGIN=loviitest
FERMA_PASSWORD=mockpass123
FERMA_GROUP=Main
FERMA_CALLBACK_URL=https://<домен ядра>/api/v1/fiscal/callback?secret=<FERMA_CALLBACK_SECRET>
FERMA_CALLBACK_SECRET=<секрет>
```

Код ядра не меняется: `FermaFiscalProvider` ходит в мок как в боевую кассу,
результат приходит callback'ом (проверка секрета — в `FiscalCallbackController`,
заголовок `X-Lovii-Signature` ИЛИ `?secret=`).

## Конфиг (env)

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `MOCK_PORT` / `MOCK_HOST` | `3101` / `0.0.0.0` | прослушивание |
| `MOCK_FERMA_LOGIN` / `MOCK_FERMA_PASSWORD` | `loviitest` / `mockpass123` | креды стенда |
| `MOCK_TOKEN_TTL_MS` | 12 ч | срок жизни токена (контракт Ferma) |
| `MOCK_PROCESS_MS` | `15000` | задержка «печати»; `0` — мгновенно |
| `MOCK_VALIDATE_RECEIPTS` | `true` | проверять инварианты чека |
| `MOCK_GROUPS` | — (любая) | список разрешённых групп кассы, напр. `Main,Shop-1` |
| `MOCK_CALLBACK_RETRY_MS` / `MOCK_CALLBACK_MAX_ATTEMPTS` | `10000` / `24` | политика доставки callback'ов |
| `MOCK_PUBLIC_BASE_URL` | `http://localhost:${MOCK_KASSA_HOST_PORT:-3101}` | база для `ofd_receipt_url` (виден покупателю!) |
| `MOCK_AGENT_LINE` / `MOCK_AGENT_INN` | «ТЕСТОВАЯ КАССА (МОК)» / `7800000000` | шапка ленты чека (без бренда владельца стенда) |
| `MOCK_BLOCK_PRIVATE_WEBHOOKS` | `false` (в `MOCK_HOSTED=1` — `true`) | не отправлять callback'и на приватные адреса и имена, которые в них резолвятся (`1`/`true`; `0`/`false` выключает явно) |
| `MOCK_OPERATOR_TOKEN` | — | токен управляющей поверхности: `/mock/*`, смены ККТ, `/fn/state`, `/ofd/*` (fallback — `MOCK_ADMIN_TOKEN`) |
| `MOCK_ADMIN_TOKEN` | — | токен админки `/admin*`; query-токен и owner-token в `owned` tenancy сохраняются в action URL/redirect, POST дополнительно требует CSRF-токен и same-origin |
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
| `MOCK_SANDBOX_RETENTION_MS` | `0` (выкл.) | retention диагностических записей (отправленные ОФД-записи, истёкшие токены) |
| `MOCK_FERMA_DOWN` / `MOCK_FERMA_DOWN_MS` | `false` / `0` | старт «касса недоступна» и авто-восстановление |
| `MOCK_STATE_FILE` | — | файл персистентности; без него состояние в памяти |

## Песочницы и hosted tenancy (RFC-001, A-21)

Каждый запрос разрешает свою песочницу **один раз** и дальше видит только её
состояние, креды и персистентность: параллельные A/B-запросы не смешиваются
между `await` (включая токены `getToken`), а запрос без селектора всегда
попадает в `default`. Селектор: `X-Mock-Sandbox: <id>` → `?sandbox=<id>` →
поддомен `<id>.<MOCK_SANDBOX_HOST_SUFFIX>` (если суффикс задан).

| Режим | Включается | Поведение |
|---|---|---|
| `namespaces` | дефолт self-hosted; `MOCK_TENANCY=namespaces` | `X-Mock-Sandbox` создаёт изолированное пространство имён для параллельных CI-воркеров; креды и управляющие токены — общие |
| `owned` | `MOCK_HOSTED=1` по умолчанию; `MOCK_TENANCY=owned` (legacy `1`/`on`/`true`/`yes`) | у каждой песочницы свои креды Ferma и owner-token (показывается один раз); знание id без owner-token доступа не даёт (401, код 11), неизвестный id — 404 (код 10), истёкший — 410 |
| `off` | `MOCK_TENANCY=off` (legacy `0`/`false`/`no`) | одна общая песочница `default`; селектор игнорируется |

API (в `owned` — с owner-token; в `namespaces` те же маршруты управляют
пространствами имён без owner-token):

| Запрос | Что делает |
|---|---|
| `POST /sandboxes` | создать песочницу: `id`, `url`, `creds` (свой логин/пароль/группа Ferma) и `ownerToken` — показывается один раз |
| `GET /sandboxes` (алиас `GET /mock/sandboxes`) | список: владельцу — своя песочница, оператору (`MOCK_OPERATOR_TOKEN`) — все |
| `DELETE /sandboxes?sandbox=<id>` | удалить песочницу вместе с состоянием (владелец или оператор) |
| `GET /sandboxes/me` | своя песочница: состояние, креды, TTL, расход квоты; `POST /sandboxes/me/reset`, `POST /sandboxes/me/reset-creds`, `DELETE /sandboxes/me` |

Owner-token принимается в `Authorization: Bearer`, `X-Sandbox-Token` или
`?sandbox_token=`. Персистентность: реестр песочниц пишется атомарно и поштучно —
по файлу `<MOCK_STATE_FILE>.sandboxes.records/<id>.json` на песочницу (хэши owner-токенов +
снимки состояния; мутация переписывает только свою песочницу, PD-02), а
`default` всегда восстанавливается только из `MOCK_STATE_FILE` — состояние
именованной песочницы не может быть выдано за `default` (F-14). Просроченные
песочницы удаляет sweep-воркер; квота документов (`MOCK_SANDBOX_MAX_DOCUMENTS`,
F-15) проверяется до фискализации и отвечает ошибкой 4 с подсказкой.

## staging

Сервис в `compose-core-staging-extras.yml` (профиль `mock`, порт 3101 на
localhost). Админ-консоль: `curl http://localhost:3101/admin` с сервера.

## Границы симуляции

- Маршруты, перечисленные выше, реализуют тестовую модель; это не облачная
  касса и запросы не отправляются в ОФД или ФНС. Не используйте реальные
  учётные записи, чеки и персональные данные.
- Статусы печати `wait → done|fail` и статусы ОФД (`pending|sent|rejected`)
  моделируются локально; `ofd_receipt_url` указывает на страницу мока.
- Контракт восстановлен по опубликованным материалам и интеграции проекта;
  сверяйте поведение с актуальной документацией Ferma перед изменением
  production-интеграции.

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
