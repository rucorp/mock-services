# kassa-mock — мок облачной кассы OFD Ferma (T-038)

Пара к `tbank-mock`: вместе они образуют полный мок-стенд «банк + касса» для
платёжно-фискального контура (план «Чеки 54-ФЗ», Фаза 3). Контракт — по
документации ofd.ru (Ferma), поэтому переключение стенда на боевую кассу —
только смена `FERMA_API_URL` и кредов в `.env` ядра; код не меняется.

Zero npm dependencies — чистый Node (>= 18), один файл `server.js`.

## Контракт (по документации Ferma)

| Метод | Поведение |
|---|---|
| `POST /possystem/v1/getToken` | `{login, pass}` → `{token}` (TTL 12 ч); неверные → `error.code=14` |
| `POST /possystem/v1/{group}/sell` | чек «Предоплата/Полный расчёт» → `{uuid, status:"wait"}`; дубли external_id → `error.code=12` |
| `POST /possystem/v1/{group}/sell_refund` | чек возврата — тот же жизненный цикл |
| `GET /possystem/v1/{group}/report/{uuid}` | `{status: wait|done|fail, payload:{ФД/ФП, ofd_receipt_url,...}}` |
| `GET /possystem/v1/stats/cashboxes/extended` | мониторинг кассы (kktState, тариф, счётчик чеков) |
| `GET /admin` | текстовая консоль: последние 50 документов, фискальные данные |
| `GET /healthz` | ok/касса недоступна |

Через `MOCK_PROCESS_MS` (по умолчанию 4 с) документ «печатается»: генерируются
ФД/ФП/фискальный признак, в админ-лог печатается текст чека (с агентом
«ООО „Аксиома"», поставщиком = Лицензиат, суммами и ФД/ФП), результат POST'ом
уходит на `receipts.service.callback_url` (ретраи, как у Ferma). Чек покупателю
«доставляется» страницей `GET /receipts/{uuid}` (ofd_receipt_url в чеке).

## Негативные сценарии (драйвер Фазы 4)

- `external_id` с префиксом **`fail-`** → документ обрабатывается, статус
  `fail` + `error` → ядро получает callback с ошибкой, джоба ретраит;
- префикс **`hang-`** → вечный `wait`, callback не отправляется (зависший чек);
- `MOCK_FERMA_DOWN=1` (опц. `MOCK_FERMA_DOWN_MS=N` для авто-восстановления)
  → все `/possystem/*` отвечают 503 «касса недоступна» — сценарий
  «приняли деньги, касса легла»;
- неверный логин/пароль/токен → ошибки контракта (14/11).

## Запуск

```bash
# локально (dev compose содержит сервис kassa-mock на :3101)
docker compose up -d kassa-mock

# или голым node
MOCK_FERMA_LOGIN=loviitest MOCK_FERMA_PASSWORD=mockpass123 node kassa-mock/server.js
```

Самотест (13 сценариев: токен, sell, дубль, отчёт, callback, fail-/hang-,
статистика, чек покупателю):

```bash
node kassa-mock/selftest.js
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

## staging

Сервис в `compose-core-staging-extras.yml` (профиль `mock`, порт 3101 на
localhost), исходник синкуется в `/opt/lovii-core-staging/kassa-mock/`.
Админ-консоль: `curl http://localhost:3101/admin` с сервера.
