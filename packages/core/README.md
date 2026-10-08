# packages/core — ядро mock-services

Инфраструктура, общая для адаптеров провайдеров. Протоколов здесь нет:
подписи, машины статусов, форматы полей и тестовые карты — в `services/*`.

## API

- `createStore({stateFile, log})` → `{state, persist, restore}` — состояние
  сервиса с опциональной персистентацией (`MOCK_STATE_FILE`).
- `createLog(tag)` — журналирование с таймстампом.
- `readBody(req, maxBytes)` / `parseBody(raw, contentType)` — входящие тела
  (JSON и form-urlencoded).
- `send(res, code, body, headers)` / `sendJson(res, payload, code, headers)` /
  `html(res, body, code)` — ответы.
- `postJson(url, payload, timeoutMs)` — исходящий POST (http/https по схеме).
- `createDeliveryQueue({...})` — очередь исходящих вебхуков с ретраями:
  запись живёт в состоянии сервиса (переживает рестарт), `retryMs`/`maxAttempts`
  настраиваются, критерий доставки — хук (`isOk`: у Т-Банка это 200 + тело «OK»,
  у Ferma — любой 2xx). Тик — раз в секунду; `awaitSequential` — доставлять
  по одной (Т-Банк) или пачкой (Ferma).

## Как добавить нового провайдера (спека §2)

1. Новый каталог в `services/<provider>-mock` с `server.js` на ядре.
2. В адаптере — только декларация протокола: маршруты, схемы, коды ошибок,
   машина состояний, тестовые реквизиты.
3. Selftest по образцу существующих: поднять сервер на эфемерном порту,
   прогнать все сценарии контракта end-to-end.
