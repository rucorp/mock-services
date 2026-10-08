# kassa-mock — мок облачной кассы OFD Ferma (T-038)

Пара к `tbank-mock`: вместе они образуют полный мок-стенд «банк + касса» для
платёжно-фискального контура (план «Чеки 54-ФЗ», Фаза 3). Контракт — по
документации ofd.ru (Ferma), поэтому переключение стенда на боевую кассу —
только смена `FERMA_API_URL` и кредов в `.env` ядра; код не меняется.

Zero npm dependencies — чистый Node (>= 18), один файл `server.js`.

## Контракт (по документации Ferma)

| Метод | Поведение |
|---|---|
| `POST /possystem/v1/getToken` | `{login, pass}` → `{token}` (TTL 12 ч, `MOCK_TOKEN_TTL_MS`); неверные → `error.code=14`, истёкший токен → `error.code=11` |
| `POST /possystem/v1/{group}/sell` | чек «Предоплата/Полный расчёт» → `{uuid, status:"wait"}`; дубли external_id → `error.code=12`; невалидный чек → `error.code=4` + `field` + `hint` |
| `POST /possystem/v1/{group}/sell_refund` | чек возврата — тот же жизненный цикл |
| `POST /possystem/v1/{group}/sell_correction` | чек коррекции (роут есть; спец-поля коррекции пока не валидируются) |
| `GET /possystem/v1/{group}/report/{uuid}` | `{status: wait\|done\|fail, payload:{ФД/ФП, ofd_receipt_url,…}}` |
| `GET /possystem/v1/stats/cashboxes/extended` | мониторинг кассы (kktState, тариф, счётчик чеков) |
| `GET /admin` | консоль: последние 50 документов, фискальные данные, журнал запросов, кнопки сценариев |
| `GET /admin/journal` | JSON-журнал последних API-запросов |
| `GET /healthz` | ok/касса недоступна |

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

> Префиксы `fail-`/`hang-` — конвенция Lovii и работают только если вы
> контролируете `external_id`. Для произвольных идентификаторов используйте
> кнопки `/admin`; программируемый сценарный API — в роадмапе (аудит §3.3).

## Запуск

```bash
docker compose up -d kassa-mock      # порт 3101
# или голым node
MOCK_FERMA_LOGIN=loviitest MOCK_FERMA_PASSWORD=mockpass123 node services/kassa-mock/server.js
```

Самотест (25 проверок: токен/TTL, sell, дубли, отчёт, callback, fail-/hang-,
валидации, дата и номер чека, XSS, НДС, `MOCK_PROCESS_MS=0`, рестарт с
недоставленным callback, статистика):

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
| `MOCK_PUBLIC_BASE_URL` | `http://localhost:3101` | база для `ofd_receipt_url` (виден покупателю!) |
| `MOCK_AGENT_LINE` / `MOCK_AGENT_INN` | «ТЕСТОВАЯ КАССА (МОК)» / `7800000000` | шапка ленты чека (без бренда владельца стенда) |
| `MOCK_BLOCK_PRIVATE_WEBHOOKS` | `false` | не отправлять callback'и на приватные адреса (публичный стенд) |
| `MOCK_FERMA_DOWN` / `MOCK_FERMA_DOWN_MS` | `false` / `0` | старт «касса недоступна» и авто-восстановление |
| `MOCK_STATE_FILE` | — | файл персистентности; без него состояние в памяти |

## staging

Сервис в `compose-core-staging-extras.yml` (профиль `mock`, порт 3101 на
localhost). Админ-консоль: `curl http://localhost:3101/admin` с сервера.

## Ограничения (осознанные)

- Только `sell`/`sell_refund`/`sell_correction`; `buy`/`buy_refund`, смены и
  Z-отчёты, очередь ОФД, маркировка, отраслевые реквизиты — в роадмапе (аудит §5).
- Статусы документа: `wait → done|fail`; стадии «отправлен в ОФД», «доставлен
  покупателю», «прочитан» не разделены.
- Контракт воспроизведён по интеграции Lovii: документация Ferma закрыта личным
  кабинетом — до сверки с первоисточником считать коды/поля приближенными
  (аудит §5.4).
