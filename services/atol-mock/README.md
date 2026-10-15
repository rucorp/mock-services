© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# atol-mock — мок прямого API АТОЛ Онлайн v4 (ФФД 1.05)

Первый **внешний касса-адаптер** стенда (issue #34, Stage 2): мок воспроизводит
прямой (direct) API АТОЛ Онлайн версии **v4** —
`https://testonline.atol.ru/possystem/v4/` — по публичной документации:
`getToken` с токеном на 24 часа в заголовке `Token`, шесть операций
фискализации, отчёт `wait → done|fail` с `payload` (ФД/ФП, ФН/ККТ,
`ofd_receipt_url`), callback результата на `service.callback_url` и
идемпотентность `external_id` **в пределах группы**.

Исходная исследовательская база — `документации АТОЛ Онлайн v4*`; публичный
гайд — [`docs/integration/atol.md`](../../docs/integration/atol.md); манифест
контракта — `protocols/atol-online.json` (проверяется `npm run check:drift`).

Node.js >= 18; внешние npm-зависимости не нужны. Инфраструктура — из
`packages/core` по паттерну yookassa-mock: журнал с редакцией секретов и curl,
очередь доставки callback (ретраи, SSRF-guard), сценарный реестр, виртуальные
часы, control-plane токены, sandbox runtime RFC-001.

> **Не путать с `kassa-mock`.** Там контракт облачных касс Ferma
> (`/possystem/v1/`), и он **не** drop-in совместим с АТОЛ — см. ниже
> «Отличия от Ferma».

## Зачем

Боевой и тестовый контуры АТОЛ Онлайн требуют договора и кабинета; публичные
креды общей тестовой среды годятся только для «пощупать». Мок даёт управляемые
локальные сценарии: отказ печати с честным `error`, зависший `wait` без
callback, ретраи и дубли callback, истечение токена через 24 часа, битые
реквизиты ФФД — всё с объяснением «что не так и как починить».

## Запуск

```bash
docker compose up -d atol-mock        # порт 3103
# или голым node
npm run start:atol
```

Стартовый лог печатает публичные тестовые реквизиты v4 — они же дефолты мока:

```
v4 creds: login=v4-online-atol-ru pass=iGFFuihss group=v4-online-atol-ru_4179 (тестовый контур, не production)
```

Это общие креды тестовой среды АТОЛ
(https://atol.online/files/ffd/test_sreda.txt): фискализация идёт на МГМ,
документ **не отправляется в ФНС**. К production они неприменимы.

Самотест (202 проверки: контракт v4, идемпотентность, callback, реквизиты ФФД,
сценарии, часы, песочницы, рестарт, control-plane):

```bash
npm run test:atol
```

## API

| Маршрут | Поведение |
|---|---|
| `POST /possystem/v4/getToken` | `{login, pass}` → `{token}`; TTL **24 часа**; неверные креды → `error.code=14` |
| `POST /possystem/v4/{group}/{operation}` | регистрация документа → `{uuid, status:"wait", timestamp, error:null}`. Операции: `sell`, `sell_refund`, `sell_correction`, `buy`, `buy_refund`, `buy_correction`. Заголовок `Token` обязателен |
| `GET /possystem/v4/{group}/report/{uuid}` | `{uuid, status: wait\|done\|fail, timestamp, error, payload}`; `done` — `payload` с ФД/ФП, ФН/ККТ, сменой, НДС и `ofd_receipt_url` |
| `GET /receipts/{uuid}` | страница чека покупателю (цель `ofd_receipt_url`) |
| `GET /health`, `GET /openapi.json`, `GET /admin`, `GET /admin/journal` | healthcheck, OpenAPI 3.1, консоль, журнал запросов с curl |
| `/mock/time`, `/mock/scenarios`, `/mock/state`, `/mock/reset`, `/sandboxes*` | общий control-plane (см. `packages/core/README.md`) |

Авторизация: **заголовок `Token: <token>`** на всех операциях и отчётах.
Отсутствие/чужой/истёкший токен → `error.code=11` (HTTP 200, как у платформы).

### Тело документа

```jsonc
{
  "external_id": "order-42",              // ≤128 символов, уникален в группе
  "timestamp": "12.10.2026 10:00:00",      // dd.mm.yyyy HH:MM:SS
  "service": { "callback_url": "https://…" },
  "receipt": {
    "client":  { "email": "buyer@example.test" },   // email ИЛИ phone
    "company": { "email": "…", "inn": "5544332219",
                 "payment_address": "https://v4.online.atol.ru", "sno": "usn_income" },
    "items": [{ "name": "…", "price": 120.50, "quantity": 2, "sum": 241.00,
                "payment_method": "full_payment", "payment_object": "commodity",
                "vat": "vat120" }],
    "payments": [{ "type": 1, "sum": 241.00 }],
    "total": 241.00
  }
}
```

Суммы — **decimal-рубли** (не более 2 знаков; JSON-число и строка равноправны),
`quantity` — до 3 знаков. `payments[].type` — ФФД тег 1081: `0` наличные,
`1` электронными, `2` аванс, `3` кредит, `4` встречное предоставление.
Ставки НДС: `none`, `vat0`, `vat5`, `vat7`, `vat10`, `vat20`, `vat22` и
расчётные `vat105`, `vat107`, `vat110`, `vat120`, `vat122`.

## Идемпотентность `external_id` — ключевое отличие

Повтор с тем же `external_id` **в той же группе** — **не ошибка**: возвращается
ранее назначенный `uuid`, второй чек не создаётся, тело повтора
игнорируется (об этом говорит `hint` и заголовок `X-Mock-Replayed: 1`).
Область уникальности — группа: тот же `external_id` в другой группе — другой
документ. Ferma на дубль отвечает `error.code=12`; АТОЛ v4 — нет.

## Ошибки (формат v4 + DX)

```json
{
  "error": {
    "code": 4,
    "text": "Реквизиты чека не прошли проверку: receipt.items[0].vat",
    "type": "business",
    "error_id": "2b6…uuid",
    "field": "receipt.items[0].vat",
    "hint": "«vat20_120» — синтаксис облачных касс Ferma. В прямом API АТОЛ v4 расчётная ставка пишется слитно: «vat120»…",
    "doc": "https://help.atol.online/article/26152"
  },
  "timestamp": "2026-10-12T10:00:00.000Z"
}
```

`code`/`text`/`type`/`error_id` — протокольная часть; `field`/`hint`/`doc` —
DX-слой мока. Ошибки протокола отдаются с **HTTP 200** (сводить их к HTTP-коду
нельзя — так делает платформа); реальные HTTP-коды — у инфраструктуры
(`404` неизвестный маршрут, `405` метод, `413` большое тело, `500/504` сценарии
сбоя, `401` управляющая поверхность).

| Код | Когда |
|---|---|
| `4` | неверный формат запроса / реквизиты ФФД / неизвестная группа |
| `5` | не передан (или слишком длинный) `external_id` |
| `10` | документ не найден (или лежит в другой группе) |
| `11` | нет заголовка `Token`, чужой токен, токен истёк (24 ч) |
| `14` | неверный `login`/`pass` |
| `57` | отказ печати по сценарию (`fail`, префикс `fail-`) |

## Callback (`service.callback_url`)

После перехода в `done` или `fail` мок шлёт `POST` с тем же объектом, что и
`report`. Основной канал сверки — `report`; callback — ускорение.

**Форк (задокументирован):** в публичных руководствах v4 не найдено правила для
ACK, подписи и расписания повторов (`документации АТОЛ Онлайн v4`).
Поэтому мок: принимает **любой 2xx** как ACK; **не добавляет подпись** (её нет
в протоколе — выдумывать нельзя); повторяет доставку
`MOCK_CALLBACK_RETRY_MS × MOCK_CALLBACK_MAX_ATTEMPTS`. Приёмник обязан быть
идемпотентным: сценарий `webhook-duplicate` и кнопка «повторить» в `/admin`
шлют вторую копию.

## Сценарии (X-Mock-Scenario и /mock/scenarios)

| Сценарий | Эффект |
|---|---|
| `fail` (или `external_id` с префиксом `fail-`) | документ доходит до `fail`, `error.code=57`, callback об отказе |
| `hang` (или префикс `hang-`) | вечный `wait`, callback не уходит |
| `webhook-drop` / `no-callback` | подавить callback (результат — через `report`) |
| `webhook-duplicate` | две копии результата |
| `latency:2s`, `X-Mock-Latency` | задержка ответа (ядро) |
| `http-500`, `http-504` | сетевой сбой до бизнес-логики (ядро, `abortStatus`) |

Правила без заголовка — `POST /mock/scenarios {scenario, target, match, times}`;
история — `GET /mock/scenarios`.

Правила, история срабатываний и журнал `/admin/journal` принадлежат текущей песочнице (#52): другие песочницы их не видят и не очищают, `POST /mock/reset` действует только на целевую песочницу. Лимиты: до 200 правил на песочницу и до 8 KiB на правило (превышение — HTTP 400 с `code` `rule_cap_exceeded`/`rule_too_large`).

## Виртуальные часы

- `MOCK_PROCESS_MS` — задержка очереди `wait → done` (дефолт 15 с);
- `POST /mock/time {"advance":"+20s"}` — напечатать очередь сейчас (так
  работают selftest и compose-прогон, без реального ожидания);
- `POST /mock/time {"advance":"+25h"}` — токен истёк (TTL 24 ч), нужен новый
  `getToken`; `{"reset":true}` — сброс смещения.

## Переменные окружения

| Переменная | Дефолт | Назначение |
|---|---|---|
| `MOCK_PORT` | `3103` | порт |
| `MOCK_ATOL_LOGIN` / `MOCK_ATOL_PASSWORD` | `v4-online-atol-ru` / `iGFFuihss` | креды стенда (алиасы `ATOL_LOGIN`, `ATOL_PASSWORD`) |
| `MOCK_ATOL_GROUP` | `v4-online-atol-ru_4179` | группа по умолчанию (алиас `ATOL_GROUP`) |
| `MOCK_GROUPS` | — | дополнительные разрешённые группы через запятую (алиас: `MOCK_ATOL_GROUPS`) |
| `MOCK_TOKEN_TTL_MS` | 24 ч | TTL токена (`0` — без истечения) |
| `MOCK_PROCESS_MS` | `15000` | задержка `wait → done` |
| `MOCK_CALLBACK_RETRY_MS` / `MOCK_CALLBACK_MAX_ATTEMPTS` | `10000` / `24` | ретраи callback |
| `MOCK_VALIDATE_RECEIPTS` | `true` | валидация реквизитов ФФД (`false` — принимать как есть) |
| `MOCK_DEFAULT_CALLBACK_URL` | — | **mock-расширение**: приёмник по умолчанию, если в запросе нет `service.callback_url` |
| `MOCK_PUBLIC_BASE_URL` | `http://localhost:${MOCK_ATOL_HOST_PORT:-3103}` | база `ofd_receipt_url` |
| `MOCK_FN_NUMBER` / `MOCK_ECR_RN` / `MOCK_OFD_INN` / `MOCK_FNS_SITE` | тестовые | реквизиты ФН/ККТ/ОФД в `payload` |
| `MOCK_AGENT_LINE` / `MOCK_AGENT_INN` | «ТЕСТОВАЯ КАССА АТОЛ (МОК)» / `5544332219` | шапка ленты чека |
| `MOCK_STATE_FILE` | — | файл состояния (compose: `/data/atol-state.json`) |
| `MOCK_BLOCK_PRIVATE_WEBHOOKS` | `false` (`true` при `MOCK_HOSTED=1`) | SSRF-guard исходящих callback |
| `MOCK_ADMIN_TOKEN`, `MOCK_OPERATOR_TOKEN`, `MOCK_HOSTED`, `MOCK_TENANCY`, `MOCK_SANDBOX_*` | — | общий control-plane и песочницы RFC-001 |

## Отличия от Ferma (`kassa-mock`) — не drop-in

| | АТОЛ direct v4 | Ferma (`kassa-mock`) |
|---|---|---|
| база/версия | `/possystem/v4/` | `/possystem/v1/` |
| токен | заголовок `Token: …`, TTL 24 ч | `?token=…` в query, TTL 12 ч |
| повтор `external_id` | возвращает прежний `uuid` | `error.code=12` |
| суммы | decimal-рубли | целые копейки |
| расчётная ставка НДС | `vat120`, `vat122` | `vat20_120`, `vat22_122` |
| форма расчёта | `0…4` (ФФД 1081) | `1…5` |
| callback | ACK/подпись/повторы не документированы | правило ACK и ретраи описаны |
| смена/ФН/очередь ОФД | нет в direct API v4 (в моке не моделируются) | mock-расширения `kassa-mock` |

Мок ловит перенос синтаксиса Ferma и объясняет его в `hint`: `vat20_120` →
«в v4 это `vat120`», `payments[].type = 5` → «в v4 наличные — `0`», `?token=`
→ «в v4 токен передаётся заголовком».

## Границы и документированные форки

Что мок **не** делает (осознанно, вне scope #34):

- **v5 / ФФД 1.2 и маркировка «Честный ЗНАК»** — отдельный шаг;
  `permissive_mode`, `use_tspiot`, `tspiot_user_id`, коды маркировки и проверка
  КМ не моделируются, неопределённости v5 из конспекта не домысляются;
- **числовые коды ошибок** — в снятом конспекте v4 таблица кодов отсутствует.
  Мок использует **общую таблицу кодов платформы АТОЛ/Ferma** (те же коды, что
  в `kassa-mock`: 4/5/10/11/14/57). Сверка с PDF API v4 (версия 5.15) не
  проводилась — расхождение возможно, фиксируется issue-шаблоном
  «расхождение с протоколом». То же относится к набору `type` (`business` /
  `system`) и к нумерации `payments[].type` (взята из ФФД тег 1081);
- **строже реального API в двух местах**: `company.inn` и
  `company.payment_address` обязательны (ФФД 1018/1009), `company.email` —
  по конспекту v4. Если ваша боевая касса подставляет их из регистрации —
  выключите проверку `MOCK_VALIDATE_RECEIPTS=false`;
- **толерантнее реального API в двух местах**: суммы принимаются и JSON-числом,
  и decimal-строкой; `service.callback_url` читается и из `receipt.service`
  (Ferma-совместимость). Арифметика сверяется с допуском 1 копейка
  (округление при дробном количестве);
- смены ККТ, ресурс ФН, очередь ОФД, dry-run `validate` и `/mock/verify-merchant`
  не реализованы: в прямом API v4 их нет, а callback не подписан — проверять
  экзаменатору нечего (тот же рулинг, что для ЮKassa в #33);
- `MOCK_DEFAULT_CALLBACK_URL` — mock-расширение (в протоколе дефолта нет).

Контракты `tbank-mock`, `kassa-mock` и `yookassa-mock` не менялись
(selftest: 48 / 129 / 227).

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
