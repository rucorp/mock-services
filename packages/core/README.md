# packages/core — ядро mock-services

Инфраструктура, общая для адаптеров провайдеров. Протоколов здесь нет:
подписи, машины состояний, форматы полей и тестовые карты — в `services/*`.

Zero dependencies, Node >= 18. Self-test: `npm run test:core`.

## API

- `createStore({stateFile, log})` → `{state, persist, restore}` — состояние
  сервиса с опциональной персистентацией (`MOCK_STATE_FILE`).

  **Важно:** `restore()` сливает файл в состояние «на месте» (`mergeInto`) и
  **сохраняет идентичность вложенных объектов**. Подсистемы захватывают ссылки
  на `state.notifications`/`state.callbacks` при старте; подмена объекта
  приводила к тому, что после рестарта очередь вебхуков смотрела в пустой объект
  и молча теряла недоставленные уведомления (дефект A-2 аудита 2026-10-08).

- `createLog(tag)` — журналирование с таймстампом.
- `readBody(req, maxBytes)` / `parseBody(raw, contentType)` — входящие тела
  (JSON и form-urlencoded).
- `send(res, code, body, headers)` / `sendJson(res, payload, code, headers)` /
  `html(res, body, code)` — ответы.
- `escapeHtml(value)` — экранирование значений, пришедших от интегратора,
  на HTML-страницах сервисов (чек покупателю, `/admin`).
- `redactSecrets(value)` / `redactSecretsInText(text)` / `redactRawBody(raw)` /
  `summarizeBody(body, {maxKeys, maxValueLength})` — редакция секретов перед
  журналированием и логированием (F-09): ключи-секреты (`Authorization`, `Cookie`,
  `token`, `pass`/`password`, `CVV`, `CardData`, `PAN`, `signature`) заменяются на
  `[REDACTED]`, PII (ИНН, телефон, e-mail, ФИО) маскируются частично, а любая
  строка дополнительно сканируется на PAN (`looksLikePan`/`maskPan`: 13–19 цифр,
  префикс платёжной системы, контрольная сумма Luhn) и на `Basic`/`Bearer`-токены.
- `classifyKey(key)` → `'secret' | 'pii' | 'safe'` — класс поля по имени;
  `maskPiiValue(key, value)` — частичная маска PII.
- `createJournal({size, baseUrl, maxEntryChars})` → `{record, list, clear}` —
  журнал входящих запросов для `/admin/journal`: метод, путь, ключевые поля, код
  ответа, длительность. Запись редактируется до сохранения (F-09): заголовки —
  через allowlist (`Content-Type`, `Content-Length`, `User-Agent`, `X-Mock-*`),
  тело и сырой payload — через `redactSecrets`/`redactRawBody`, длина полей и всей
  записи ограничена.
- `postJson(url, payload, timeoutMs, options)` — исходящий POST/GET (http/https по схеме;
  другие схемы отклоняются, редиректы не отслеживаются; для IPv6-литералов скобки
  `[...]` нормализуются перед подключением и сохраняются в заголовке `Host` — PA-25).
- `flagEnabled(value, fallback)` — разбор boolean-настроек из env: `1`/`true`/`yes`/`on`
  против `0`/`false`/`no`/`off`, пустое значение — `fallback` (F-08: `=1` больше не «молчит»).
- `defaultBlockPrivateHosts(env)` — дефолт SSRF-политики ядра, согласованный с адаптерами (PA-58):
  `flagEnabled(MOCK_BLOCK_PRIVATE_WEBHOOKS, flagEnabled(MOCK_HOSTED, false))`.
- `isPrivateAddress(ip)` / `isPrivateHost(url)` — классификация IP-литералов и
  URL («приватный/служебный адрес», включая `ff00::/8`, TEST-NET-1/2/3,
  `2001:db8::/32` и `64:ff9b:1::/48` — PA-26) для защиты вебхуков от SSRF.
- `resolvePublicHost(url, {lookup})` / `assertPublicHost(url, {lookup})` — async-проверка
  перед исходящим запросом: схема http/https, публичный IP, имя резолвится один
  раз только в публичные адреса и пиннится к сокету (защита от DNS TOCTOU / rebinding —
  §7.3, PG-11); бросает `Error` с `code === 'SSRF_BLOCKED'`.
- `checkControlAccess(req, {adminToken, operatorToken, surface, hosted})` —
  единый access-control управляющей поверхности (F-07): роли `admin`/`operator`,
  constant-time сравнение токена, fail-closed при `hosted` без секрета.
- `createDeliveryQueue({...})` — очередь исходящих вебхуков с ретраями:
  запись живёт в состоянии сервиса (переживает рестарт), `retryMs`/`maxAttempts`
  настраиваются, критерий доставки — хук (`isOk`: у Т-Банка это 200 + тело «OK»,
  у Ferma — любой 2xx). Тик — раз в секунду; `awaitSequential` — доставлять
  по одной (Т-Банк) или пачкой (Ferma). Дефолт `blockPrivateHosts` —
  `defaultBlockPrivateHosts()` (локально `false`, при `MOCK_HOSTED=1` — `true`, PA-58);
  то же правило действует в `verifyMerchantWebhook({...})`.

  Гарантии очереди (закреплены тестами):

  1. запись, находящаяся «в полёте», не отправляется повторно — ретраи идут
     строго по расписанию, даже если вебхук отвечает медленнее, чем тик
     (дефект A-3: без защиты одна нотификация уходила параллельными POST-ами);
  2. терминальный статус — флаг `entry.done` (а не `nextAttemptAt = Infinity`,
     который сериализовался в `null` и после рестарта считался «пора слать снова»,
     дефект A-4);
  3. `request(entry)`, бросивший исключение, не роняет тик — запись уходит в
     `onFailure` с текстом ошибки;
  4. при `blockPrivateHosts: true` (или по умолчанию в `MOCK_HOSTED=1`) отправка
     на приватные/служебные адреса и имена, которые в них резолвятся, блокируется
     с привязкой проверенного IP к соединению против DNS TOCTOU (дефекты A-18/F-08,
     #51 PF-01/PA-25/PA-26/PA-58/PG-11);
  5. `awaitSequential: true` — записи уходят строго по одной и в порядке
     очереди: следующая запись не стартует, пока предыдущая не завершилась,
     и новый тик не начинается поверх идущего (F-29: даже медленный приёмник
     не может получить статусы одного платежа не по порядку).
- `createErrorCatalog({provider, docsBase, codes})` — каталог ошибок DX-слоя:
  `{код, объяснение, поле, подсказка, ссылка на официальный раздел доки}`.

## Как добавить нового провайдера (спека §2)

1. Новый каталог в `services/<provider>-mock` с `server.js` на ядре.
2. В адаптере — только декларация протокола: маршруты, схемы, коды ошибок,
   машина состояний, тестовые реквизиты. Ошибки — через `createErrorCatalog`
   (код + поле + подсказка + ссылка на официальную доку).
3. Журнал входящих запросов — `createJournal` + `GET /admin/journal`.
4. HTML-страницы (админка, чеки) — только через `escapeHtml`.
5. Selftest по образцу существующих: поднять сервер на эфемерном порту,
   прогнать все сценарии контракта end-to-end, включая негативные и
   «рестарт с `MOCK_STATE_FILE`». Флаки-тесты (`sleep`-ожидания, фиксированные
   порты) не принимаются — см. `CONTRIBUTING.md`.
