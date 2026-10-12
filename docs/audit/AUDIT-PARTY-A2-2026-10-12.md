© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Аудит-партия A-2 — Ядро, часть 2 (строки 1335–2670): сценарии, auth/CSRF, песочницы, экзаменатор — 2026-10-12

> **База:** `main` @ `05696f3` · версия `0.5.0` · Node v24.21.0 (песочница).
> **Режим:** только чтение. Код, тесты, compose, CI и манифесты не менялись; единственный добавляемый файл — этот отчёт.
> **Baseline:** `npm test` зелёный (core 41/41, tbank SELFTEST PASSED, kassa 141/141, yookassa 227/227, atol 202/202, upstream 11/11, links 57, drift 221/221) — зафиксирован координатором; по правилам партии не перезапускался.
> **Область:** `packages/core/index.js` строки 1335–2670 (файл 2670 строк; строки 1–1335 — партия A-1). Сопряжённо читались вызовы адаптеров (`services/*/server.js`) и смежные блоки ядра 600–1100, 1195–1334 для проверки следствий.
> **Связка:** [чек-лист партии](CHECKLIST-audit-party.md) · [аудит-преп §4.A](AUDIT-PREP-2026-10-12.md) · [реестр #15](REGISTRY-2026-10-11-code-sweep.md) · отчёты партий B/C/D/E/F.

---

## 1. Итог и ответы на вопросы партии

Найдено **12 находок**: 1 blocker (кросс-арендаторское чтение/запись/уничтожение чужой песочницы через управляющие API рантайма), 2 major (глобальный реестр сценариев между арендаторами; голодание очередей вебхуков при `tickAll`), 7 minor, 2 info. Самая тяжёлая зона — `createSandboxRuntime`: `admit()` защищает контекст запроса хорошо, но все «явные-id» API управления (`exportState`/`importState`/`reset`/`updateCreds`/`remove`/`switchActive`) авторизации не имеют вовсе, и адаптеры подставляют туда target из query/body.

Ответы на 10 вопросов:

1. **State-фасад (Proxy, 2385–2418).** Вне контекста запроса (`als.getStore() === null` или запись удалена sweep'ем — `currentRecord()` core:2112–2116) фасад отдаёт `activeId`/`default` — это задокументировано (AGENTS §8) и проявляется в трёх местах: (а) `run(admission, fn)` исполняет `fn` **даже при неуспешном admission** (core:2211–2214) — адаптеры страхуются проверкой `admission.ok`, но контракт ядра молчит (PA-56); (б) модульные таймеры корректно завёрнуты в `tickAll` (tbank:3386–3391); (в) `persist()` (core:2423) вне запроса пишет `currentRecord()`. Обход `admit()`/policy: **все exported-методы управления с явным id** (`exportState(id)`, `importState(payload, targetId)`, `reset(id)`, `updateCreds`, `remove`, `switchActive`, `find`, `list`) не проходят admit и не проверяют owner-token — через них любой владелец одной песочницы управляет чужими (PA-50, blocker). Дополнительно policy `'public'` и `'form'` в owned-режиме обходят `defaultOwnerToken`/owner-token полностью (core:2175–2177, 2202; PA-54), а `sandboxPolicy` fail-open: неописанный маршрут автоматически получает `'public'`+default (tbank:2486).
2. **retention/sweep/exportState.** `sweep()` (core:2342–2365) ходит по всем песочницам напрямую по `rec.state` — чужой контекст не утекает, retention получает именно свой snapshot. Но `exportState(id)`/`importState(payload, targetId)`/`reset(id)` (core:2299–2339) принимают **любой** id **без** авторизации: в owned-режиме владелец A читает, перезаписывает и сбрасывает песочницу B (HTTP-прогон: 200 + платежи B в ответе; reset уничтожил платёж B). В export попадает **весь state** песочницы, включая записи очереди вебхуков (`notifications` с payload и масками карт), журнал-объекты и проиндексированные коллекции; owner-token в state не хранится (только хеш в record), но `creds` песочницы (terminal/ferma-пароли) лежат в state-файлах открыто (PA-57). Секретов владельцев (owner-token) в export нет — они не в state.
3. **tickAll и чужие арендаторы.** Утечки содержимого между песочницами нет: `tickAll` (core:2368–2376) прогоняет `fn` в `als.run(rec, …)` каждой песочницы, `entries()` очереди резолвится через фасад. Но найдено **голодание**: у очереди один общий флаг `ticking` (core:1016), а `tickAll` не ждёт async-тик — при `awaitSequential: true` (tbank:574) первый непустой тик держит флаг, тики остальных песочниц **молча скипаются** (core:1047); за один `tickAll` доставляется максимум одна песочница (PA-52, прогон-доказательство). В produção-цикле 1 с это систематические задержки доставки вебхуков чужих арендаторов.
4. **Unbounded-рост.** `createLog`-Map лимитов создания — ограничен (очистка при >10000 ключей, core:2146; массив на ключ ограничен `createLimit`) — но эвикция «всё или ничего». `createScenarioRegistry.history` — cap 200 (core:1469) — ок; **`rules` — без cap** (core:1438) и никогда не истекают: владелец может добавить десятки тысяч правил, `matchRule` линейный на каждый запрос (прогон: 30 003 правила, resolve ×20000 = 2,2 с) — PA-51. `sandboxes` Map ограничен `maxSandboxes` (core:2151) в обоих режимах (100/256 по умолчанию), но в namespaces TTL=0 и sweep-интервал не запускается (PD-07/PD-03). `journal` — cap 200 (core:711). Растёт без предела при отсутствии TTL: state песочниц (платежи/notifications) — чистится только ручным reset/retention.
5. **safeEqual на не-ASCII.** Функция (core:1537–1542) сравнивает байты UTF-8 — корректно: кириллица/эмодзи совпадают байт-в-байт, NFC≠NFD не принимаются (fail-closed), пустые строки не равны непустым. Проблема одна: docstring «без утечки длины по таймингу (constant-time)» неточен — при несовпадении длины ранний `return false` (core:1540) раскрывает **длину** ожидаемого секрета (PA-53, minor; стандартный фикс — сравнение HMAC-ей). Комментарий tbank:270–273 (F-28) эту же семантику подтверждает для verifyToken.
6. **isSameOriginRequest/CSRF.** Новых обходов не найдено. null-origin (любой регистр/пробелы) — false; поддомен — false (`same-site` отклоняется); массив Origin — fail-closed; uppercase схема/хост нормализуются корректно; порт учитывается; `X-Forwarded-Host` игнорируется намеренно (core:1597–1598), `X-Forwarded-Proto` меняет только ожидаемый протокол и при честном браузере не управляем. Два замечания: отсутствие `sec-fetch-site` и Origin/Referer → `true` (CLI-путь, CSRF-токен остаётся обязателен — как задокументировано core:1582–1585); DNS-rebinding (Host+Origin совпадают у атакующего) проходит same-origin-проверку, но без CSRF-токена бесполезен — классовое ограничение, не дефект реализации. Токены в query (`admin_token`/`operator_token`, core:1624–1625) — известное MS-06, нового сверх него нет. CSRF-токены: HMAC+TTL 4ч+привязка к контексту песочницы и длине nonce ≥32 — прогоны подтверждены (чужой контекст/секрет/просрочка/подделка → false).
7. **generateSandboxId [VERIFY MS-14].** Подтверждено: 16×16×`randomBytes(5)` = **ровно 48 бит**; прогон 200 000 id — 0 коллизий (ожидаемо 0,00007); sanitize режет всё вне `[a-zA-Z0-9_.-]` до 64 символов. RFC-001 §7 (≥96 бит) не выполнен — MS-14 остаётся в силе. Оценка перебора: `/payment/{id}` и `/receipts/{uuid}` — capability только по id (policy `form`, core:2200–2204), rate-limit на них отсутствует; `PaymentId` = монотонный `Date.now() + seed*1e6` (tbank:115–119; в прогоне PaymentId=1791824311033), т.е. окно ±10 с создания = ~10 000 запросов — технически перебираемо; 48-битный sandbox-id — нет. Уточнение MS-14 в §4.
8. **createSandboxRuntime [VERIFY MS-38].** Подтверждено: ни один из 4 адаптеров не передаёт `now` (tbank:196–213, kassa:214–231, yookassa:152–169, atol:220–237), дефолт `() => Date.now()` (core:1913). Все следствия перечислены в PA-59: `expiresAt`/TTL (core:2157), проверка `expired` в admit (core:2196), `sweep()`/retention ts (core:2343, 2357), окно `createLimitFor` (core:2141), `isoNow()` для createdAt/updatedAt реестра (core:1931) — всё на wall-clock; при этом записи внутри state штампуются виртуальными часами → при advance retention сравнивает wall с «будущими» датами и не чистит.
9. **verifyMerchantWebhook.** Гард применяется **только при явном** `blockPrivateHosts: true` (core:2465, 2470 → `assertPublicHost`); дефолт на уровне ядра — false: прогон показал 3 POST-прострела в loopback без флага (PA-58; адаптеры передают `BLOCK_PRIVATE_WEBHOOKS`, kassa-квирк — PF-01). Подписи **самого** запроса нет и не нужно: экзаменатор проверяет **мерчанта** — (1) приём валидной подписанной нотификации + тело ровно `OK`, (2) идемпотентность дубля, (3) отклонение поддельного `Token` (tbank-ветка; ferma-ветка — 2×2xx). ACK: строго `200`+`OK` (tbank) / любой 2xx (ferma). Ретраев внутри экзаменатора нет (по одному POST на пробу, таймаут 5 с). Схемы: `postJson` отклоняет всё кроме http/https (core:728; прогон `file://` → отказ), редиректы не выполняются (Node-клиент, core:717–719) — редирект-обхода нет. Остаток MS-09: TOCTOU (резолв в assertPublicHost и повторный в postJson) и mapped-bypass §2.1; порт не ограничивается — POST-проба портов на публичном хосте.
10. **createSandboxManager + hosted-tenancy.** Legacy `createSandboxManager` (core:1691–1802) адаптерами не используется (только selftest ядра) — экспортированный singleton-switcher, риск только для внешних потребителей пакета (PA-61, info). Hosted: `POST /sandboxes` публичен по дизайну RFC-001 §6 (демо-создание, лимит 20/час/IP, tbank:2379–2422); owner-token `sbx_`+192 бита (core:2253), выдаётся один раз, хранится **хешем** (core:2158, 1966 — прогон подтверждает), а вот `creds` песочниц persistятся открытым текстом (PA-57). TTL/квоты: `expiresAt` проверяется в admit (core:2196) и sweep'ем; enforcement лимитов работает (прогон rate-limit/`SANDBOX_LIMIT`). DELETE чужой песочницы: проверка `recordAuthorized(record)` (tbank:2434) — владелец A не может удалить B (хеш не совпадёт), но при `record = null` из `find()` `recordAuthorized` упал бы — адаптеры проверяют `!record` раньше (tbank:2433). В namespaces DELETE/GET без токена — PD-07.

---

## 2. Реестр находок

| ID | модуль | файл:строка | категория | severity | суть | предлагаемая задача | зависимости |
|---|---|---|---|---|---|---|---|
| PA-50 | sandbox runtime — управление | `packages/core/index.js:2299-2339` (`reset`/`exportState`/`importState`), `:2269-2285` (`updateCreds`/`remove`), `:2235-2237` (`find`) | security | **blocker** | Явные-id API рантайма не авторизуют target: владелец любой песочницы читает/перезаписывает/сбрасывает чужую. Адаптеры подставляют `?sandbox=`/`body.sandbox` в `GET/POST /mock/state` и `POST /mock/reset` без повторной проверки owner-token (tbank:2619-2638, 2649-2652; kassa:1358-1391; yookassa:1782-1819; atol:1378-1410) — обход: `X-Mock-Sandbox: <свой id>` + `?sandbox=<чужой>` (см. §2.1). Гард `recordAuthorized` живёт только в `admit()` (core:2202) | Авторизовать target на уровне ядра: в `exportState/importState/reset/updateCreds/remove` принимать `{req}`/`authorized` и сверять `recordAuthorized(rec, req)` (operator — исключение); в адаптерах запретить `target ≠ admission.record.id` без operator-токена. DoD: HTTP-регресс во всех 4 selftest («A не читает/не пишет/не сбрасывает B → 401») | MS-12, PD-02; ревизия §2.1/§2.2 AUDIT-PREP |
| PA-51 | scenario registry | `packages/core/index.js:1419-1522` (rules без cap `:1438`, matchRule `:1442-1464`, recordTrigger `:1466-1471`); tbank:241, 2717-2734; kassa:254, 1436-1451; yookassa:193, 1837-1849; atol:259, 1436-1449 | security | **major** | Реестр сценариев один на процесс: правило владельца A срабатывает на трафике B (matchRule не знает про песочницы; HTTP-прогон: `chargeback-after:1h` от A попал в платёж B); `GET /mock/scenarios` отдаёт A историю с orderId/paymentId песочницы B (утечка идентификаторов); `DELETE /mock/reset` и `DELETE /mock/scenarios` стирают правила/историю всех арендаторов; `rules` не ограничены → линейный `matchRule` на каждый запрос (30k правил → +~108 мкс/запрос всем) | Per-sandbox реестры (внутри state песочницы или Map по sandbox-id с квотой на песочницу + cap на правила), history с ограничением и фильтром по арендатору; очистка только своей песочницы. DoD: правило A не матчит B; история A не содержит orderId B | PA-50 (один класс «явный target без авторизации») |
| PA-52 | delivery queue + tickAll | `packages/core/index.js:1016,1046-1063` (общий `ticking`), `:2368-2376` (`tickAll` не await'ит async-тик); tbank:574 (`awaitSequential: true`), 3386-3391 | resilience | **major** | За один `tickAll` доставляется максимум одна непустая очередь: первый async-тик держит общий флаг `ticking`, тики остальных песочниц скипаются (прогон: после 1-го прохода sbx-1 доставлен, sbx-2 — нет). При ретраях/медленном мерчанте у «ранней» песочницы очереди остальных голодают на каждом интервале 1 с | Вынести владение флагом в контекст песочницы (per-sandbox ticker / очередь на песочницу) либо ключ `ticking` по `rec.id`; в tickAll — собирать и дожидаться промисов. DoD: прогон из §2.3 доставляет обе песочницы за один tickAll | MS-38 (общий источник времени), PD-07 |
| PA-53 | auth-примитивы | `packages/core/index.js:1536-1542` | correctness | minor | `safeEqual` возвращает `false` до `timingSafeEqual` при разной длине буферов — docstring «без утечки длины по таймингу» неточен: длина ожидаемого секрета наблюдаема. Семантика на не-ASCII корректна (байтово; NFC≠NFD не принимаются) | Сравнивать HMAC обоих значений (длина выравнивается) либо честно описать ограничение в docstring; регресс-тест на длину | MS-19 (токены/длины) |
| PA-54 | admit/policy | `packages/core/index.js:2172-2208` (`public` `:2175-2177`, `form` `:2200-2204`), tbank:2481-2487, kassa:1090-1097 | security | minor | В owned-режиме policy `public` и `form` не проходят `recordAuthorized`: даже при заданном `MOCK_SANDBOX_TOKEN` (defaultOwnerToken) публичные маршруты и capability-страницы отвечают из default/чужой песочницы без токена (прогон §2.4); дефолт `sandboxPolicy` для неописанных маршрутов — `public` (fail-open): будущий маршрут адаптера автоматически публичен; `via:'owner'` при отсутствии токена вводит в заблуждение (core:2205-2207) | Развести `public` (анонимно, но вне state) и `capability` (form — state по id с rate-limit); fail-closed дефолт для неописанных маршрутов; честный `via:'form'`. DoD: `/payment/{id}` с чужим id и без токена — по политике владельца/с лимитом | MS-12, MS-14 |
| PA-55 | namespaces / switchActive | `packages/core/index.js:2287-2297`, tbank:2425, kassa/yookassa/atol (POST /sandboxes) | correctness | minor | `POST /sandboxes {"sandbox":"x"}` в namespaces глобально переключает `activeId`; параллельный запрос без селектора (fallback `activeId`, core:2178, 2115) исполняется/пишет в чужую песочницу — гонка CI-воркеров (прогон §2.5) | Не менять глобальный `activeId` на POST (только явный selector), либо документировать «селектор обязателен» и отвечать ошибкой на безселекторные записи при активной аренде. DoD: тест двух параллельных воркеров без взаимных записей | PD-07 |
| PA-56 | sandbox runtime — run() | `packages/core/index.js:2211-2214` | correctness | minor | `run(admission, fn)` при `admission.ok === false` молча исполняет `fn` в `currentRecord()` (default/активная) — прогон §2.6: not-found → fn выполнен в default. Контракт тихий; защита — целиком на адаптерах | Бросать/игнорировать при `!admission.ok` (или вернуть маркер); описать контракт в JSDoc. DoD: selftest «run с неуспешным admission не исполняет fn» | — |
| PA-57 | персистентность кредов | `packages/core/index.js:1954-1972` (`registryPayload` creds), `:2158`, tbank:2367-2375 (`generateSandboxCreds`), 2400-2412 | security | minor | `creds` песочниц (terminalPassword/fermaPassword, randomToken(24)) persistятся в `MOCK_SANDBOX_FILE` открытым текстом (прогон §2.7: `"sup3r-s3cret-pw"` в файле), файл с umask-правами 664; owner-token при этом хеширован — ок. Права на state-файлы нигде не ограничиваются | Минимум: `fs.writeFileSync(file, data, { mode: 0o600 })` для state/registry; в доке — где лежат креды. Вариант: шифровать creds ключом из env. DoD: файл после старта читается только владельцем процесса | PD-02, MS-12 |
| PA-58 | webhook examinator | `packages/core/index.js:2460-2470` (дефолт `blockPrivateHosts=false`), `:2606-2616` | security | minor | На уровне ядра `verifyMerchantWebhook` по умолчанию НЕ применяет SSRF-гард: прогон — 3 POST в loopback без флага (адаптеры передают флаг явно; риск — любой новый вызывающий). Порт URL не ограничивается (POST-проба портов публичного хоста); итог всегда `ok:true` — сигнал только `readyForProd` | Дефолт `blockPrivateHosts` fail-closed или обязательный параметр; ограничить порты (80/443/8443 — настраиваемо); вернуть `ok: readyForProd`. DoD: вызов без флага в hosted блокирует 127.0.0.1 | §2.1 (mapped-bypass), MS-09 (TOCTOU), PF-01 |
| PA-59 | MS-38: следствия wall-clock | `packages/core/index.js:1913,1931,2141-2148,2157,2196,2343,2357` | correctness | minor | Полный список следствий отсутствия `now` в `createSandboxRuntime` (§2.4 закрывала только TTL): `expiresAt` и `expired`-проверка admit, ts sweep/retention (сравнение wall с «будущими» виртуальными датами записей — retention при advance не чистит), окно rate-limit `createLimitFor`, `createdAt/updatedAt` реестра — всё wall-clock (прогон §2.8: при часах +30d TTL не истёк, retention получил wall-ts) | Пробросить `now: () => clock.now()` во все 4 адаптера + передавать сдвиг песочницы в рантайм; регресс «advance +TTL истекает песочницу». DoD: TTL/retention/квота ускоряются `/mock/time` | MS-38, PD-03 |
| PA-60 | scenario registry — парсинг | `packages/core/index.js:1433-1435` | correctness | info | `times: 0` и мусорная строка тихо превращаются в 1 (`parseInt || 1`); `times: -1` без `persistent` — тоже 1 (по коду). История cap 200 — ок | Документировать семантику times (0/-1/undefined) в README `/mock/scenarios` или принимать 0 как «выключено» | — |
| PA-61 | legacy API | `packages/core/index.js:1691-1802, 2662` | dx | info | `createSandboxManager` (singleton-switch) экспортируется, адаптерами не используется; смешение с runtime-фасадом даёт кросс-контекстные записи (AGENTS §8 предупреждает) | Пометить `@deprecated` в JSDoc с отсылкой к `createSandboxRuntime`; удалить в мажорной версии | MS-31 |

### 2.1 Воспроизведение PA-50 (blocker: кросс-арендаторская изоляция)

Уровень ядра (`node -e`, owned-режим):

```console
$ node -e "…createSandboxRuntime({mode:'owned'})…; rt.exportState('tenant-b')"   # владелец A, без токена B
exportState("tenant-b") владельцем A БЕЗ токена B -> видит p-1? true (утечка)
importState(.., "tenant-b") владельцем A -> payments.hacked в B? ДА (запись)
reset("tenant-b") владельцем A -> {"ok":true,"sandbox":"tenant-b"}
B после reset: payments = {} (уничтожено)
КОНТРОЛЬ admit(B-селектор, токен A) -> отклонён: unauthorized <- гард есть только в admit
```

Уровень HTTP (живой `services/tbank-mock/server.js`, `MOCK_HOSTED=1`, listener 127.0.0.1:0; скрипт `/tmp/partyA2-scratch/http-proof2.js`):

```console
[reset-до]    GetState B PaymentId=1791824349269: Status=NEW
[reset-после] POST /mock/reset {sandbox:B} от владельца A: http=200;
              GetState того же платежа: http=200 Success=false Message=Платёж не найден (ни по PaymentId, ни по OrderId)
[rule]        правило владельца A (target:init) на платеже B: chargebackAfterMs=3600000 (не null = сработало)
```

и (первый прогон, чтение): `GET /mock/state?sandbox=tenant-b` с заголовками `X-Mock-Sandbox: tenant-a` + `Authorization: Bearer <A>` → **200** с платежами B; контроль без заголовка `X-Mock-Sandbox` → **401** (admission), то есть байпас — именно split «заголовок = свой контекст, query = чужой target».

### 2.2 Воспроизведение PA-51 (глобальный реестр сценариев)

```console
$ node /tmp/partyA2-scratch/http-proof2.js   # шаг [rule] выше
[rule] правило владельца A (target:init) на платеже B: chargebackAfterMs=3600000
$ node -e "…reg.addRule({scenario:'fail',target:'init'}) ×30000… resolve×20000"
правил в реестре после 30002 addRule: 30003 (cap отсутствует)
resolve x20000 поверх 30k правил: 2167 мс (линейный деград)
```

Утечка идентификаторов: `GET /mock/scenarios` владельцем A → `history orderId=["ord-B-2"]` — orderId песочницы B (первый прогон, шаг [6]).

### 2.3 Воспроизведение PA-52 (голодание очередей)

`node /tmp/partyA2-scratch/tickall-proof.js` — runtime (namespaces) + `createDeliveryQueue({awaitSequential:true})` + медленный listener (300 мс) на 127.0.0.1:0:

```console
до тика           : sbx-1: attempts=0 done=false | sbx-2: attempts=0 done=false
после 1-го tickAll: sbx-1: attempts=0 done=true  | sbx-2: attempts=0 done=false   <- скипнута
после 2-го tickAll: sbx-1: attempts=0 done=true  | sbx-2: attempts=0 done=true
```

### 2.4 Воспроизведение PA-54 (public/form обходят defaultOwnerToken)

```console
$ node -e "…createSandboxRuntime({mode:'owned', defaultOwnerToken:'topsecret-default-token'})…"
business без токена : {"ok":false,"kind":"unauthorized","sandbox":"default"}
public  БЕЗ токена  : {"ok":true,"via":"public","sandbox":"default"}  <- defaultOwnerToken не проверяется
form    БЕЗ токена  : {"ok":true,"via":"owner","sandbox":"default"}
form  ЧУЖАЯ песочница без токена: {"ok":true,"via":"owner","sandbox":"tenant-x"}
```

### 2.5 Воспроизведение PA-55 (глобальная гонка namespaces)

```console
$ node -e "…mode:'namespaces'; switchActive('ci-b'); admit({headers:{}}…)…"
запрос без селектора попал в: ci-b | через run() фасад state.payments = {"pb-1":"B-данные"}
```

### 2.6 Воспроизведение PA-56 (run с неуспешным admission)

```console
admission ok? false (kind: not-found)
run(bad, fn) всё равно выполнился, context = default
```

### 2.7 Воспроизведение PA-57 (plaintext creds в реестре)

```console
$ node -e "…createSandboxRuntime({stateFile:'/tmp/…/reg-test.json'}); rt.create({id:'acme', creds:{terminalPassword:'sup3r-s3cret-pw',…}}); rt.flush()"
в файле реестра: ownerTokenHash = 32a57a4d119bc7d9...(хеш, ок)
в файле реестра: creds.terminalPassword в ОТКРЫТОМ виде = "sup3r-s3cret-pw"
права файла: 664 (umask-дефолт, group/other читают)
```

### 2.8 Воспроизведение PA-58/PA-59

```console
$ node /tmp/partyA2-scratch/verify-webhook-proof.js
--- 1. ДЕФОЛТ (blockPrivateHosts не передан):
readyForProd=false, запросов дошло до loopback-listener: 3
checks: valid_signed_webhook=true, duplicate_idempotency=true, invalid_signature_rejected=false
--- 2. Явный blockPrivateHosts:true -> Error code=SSRF_BLOCKED
--- 3. Схема file:// -> "схема file: не поддерживается (разрешены http/https)"
$ node -e "…clock.advance('30d'); rt.sweep()…"
  retention вызван с ts = 1791822532929 (wall, часы виртуально +30d)
  sweep() с expiresAt в будущем wall: песочница жива? true (TTL не ускоряется — MS-38)
createdAt записи (wall iso): 2026-10-12T16:28:52.927Z | clock.iso() сейчас: 2026-11-11T16:28:52.930Z
```

---

## 3. Покрытие области (строки 1335–2670)

| Блок | Диапазон | Прочитан полностью? | Примечание |
|---|---|:--:|---|
| Хвост parseMoneyKopeks | 1335–1366 | ✅ | F-24, инварианты целые |
| Реестр сценариев | 1368–1522 | ✅ | PA-51, PA-60 |
| checkAdminAuth | 1524–1534 | ✅ | делегирует tokenMatches |
| safeEqual / CSRF-токены | 1536–1580 | ✅ | PA-53; прогоны §1.6 |
| isSameOriginRequest | 1582–1611 | ✅ | новых обходов нет |
| tokenMatches / checkControlAccess | 1613–1654 | ✅ | MS-06 подтверждён |
| chaos/latency | 1656–1681 | ✅ | cap 30 с, http-500/504 |
| createSandboxManager (legacy) | 1683–1802 | ✅ | PA-61 |
| generateSandboxId/sanitize/hash/randomToken | 1804–1839 | ✅ | MS-14 подтверждён (§5.2) |
| resolveTenancyMode | 1841–1875 | ✅ | прогоны; PD-10 сверка RFC |
| createSandboxRuntime: шапка/конфиг | 1877–1950 | ✅ | MS-38 (core:1913) |
| Персистентность реестра | 1952–2050 | ✅ | PD-02 подтверждена; PA-57 |
| Селектор/owner-token/records | 2052–2116 | ✅ | байпас — split заголовок/query |
| Лимиты/квоты/createRecord | 2118–2166 | ✅ | createLog ограничен; MS-14 (2151) |
| admit/run | 2168–2214 | ✅ | PA-54, PA-56 |
| Управление (describe…switchActive) | 2216–2297 | ✅ | PA-50, PA-55 |
| reset/exportState/importState | 2299–2339 | ✅ | PA-50 |
| sweep/tickAll/creds | 2341–2380 | ✅ | PA-52, PA-59 |
| state-фасад Proxy | 2382–2416 | ✅ | инварианты trap'ов целы |
| restoreRegistry-вызов/возврат API | 2418–2453 | ✅ | — |
| verifyMerchantWebhook | 2455–2617 | ✅ | PA-58; MS-09 остаток |
| Хвост: module.exports | 2619–2670 | ✅ | 50 экспортов сверены |

Строки 1335–2670 прочитаны полностью, пропусков нет. Сопряжённо (вне зоны, для следствий): core 600–1100 (journal/postJson/SSRF/queue), 1195–1334 (clock); tbank 40–120, 196–260, 560–620, 1296–1310, 2340–2740, 3378–3427; kassa 1079–1108, 1355–1414; yookassa 1780–1819; atol 998–1010, 1378–1410.

## 4. Дубли и пересечения (новых ID не заводить)

- **§2.1 AUDIT-PREP (SSRF-mapped-bypass)** — подтверждает актуальность для `verifyMerchantWebhook` (core:2470); не дублируется, PA-58 фиксирует только слой «дефолт флага» и остаток MS-09 (TOCTOU).
- **§2.2/MS-14 (48 бит)** — VERIFY закрыт прогоном (§5.2): 2^48 ровно, 0 коллизий на 200k. Дополнено оценкой перебора PaymentId (монотонный `Date.now()+seed*1e6`, tbank:115–119; form-страницы без rate-limit) — остаётся в MS-14, новый ID не заведён.
- **§2.4/MS-38 (wall-clock в runtime)** — VERIFY закрыт прогоном (§2.8/PA-59); полный список следствий — PA-59 (расширяет MS-38, как PD-10 расширяет MS-31).
- **PD-02 (write-амплификация реестра)** — подтверждена: `flushRegistry` пишет весь реестр на каждую мутацию (core:1974–1988: writeFileSync + rename, без байтовых квот); уточнение от A-2: в payload входят `creds` открытым текстом (PA-57) и полные state песочниц.
- **PD-07 (namespaces: авто-создание, TTL=0, GET/DELETE без токена)** — подтверждено (дефолты tbank:98–103; handleSandboxApi tbank:2385–2395, 2429–2439); гонка `switchActive` вынесена отдельно в PA-55, так как о другом классе (глобальный activeId, а не отсутствие auth).
- **PF-01 (kassa flagEnabled)** — вне зоны A-2; для tbank сверено `BLOCK_PRIVATE_WEBHOOKS = flagEnabled(env, HOSTED)` (tbank:90) — дефолт hosted вкнутри, локально выключен.
- **F-07/F-11/F-12/F-13/F-14/F-15** — механики подтверждены по коду (checkControlAccess core:1643–1654; admit/run; экспорт без переключения; restore без default-подмены core:2013–2050; лимиты/retention). PA-50 не опровергает F-13 — она о **авторизации target**, а не о механике.
- **MS-06 (токены в query)** — подтверждено в `tokenMatches` (core:1622–1626), нового сверх закреплённого тестами нет.
- **MS-09 (SSRF TOCTOU)** — остаток жив: резолв в `assertPublicHost` и повторный в `postJson`; см. §2.1 AUDIT-PREP.
- **MS-12 (default-песочница без токена)** — подтверждено; PA-54 — расширение: даже С токеном public/form-маршруты его не проверяют.
- **MS-19 (длина токенов)** — проверок длины в `tokenMatches`/`recordAuthorized` нет — остаётся в MS-19.
- **A-20/A-21 (аудит 08.10)** — закрыты ранее; подтверждаю актуальность `checkAdminAuth`/`admit()` без регрессий.

## 5. Прогоны (node -e / скрипты)

1. **safeEqual через checkControlAccess (не-ASCII, query-токены):**

```console
$ node -e "const c=require('/tmp/mock-services/packages/core'); …checkControlAccess({headers:{…},url}, {operatorToken})"
ascii eq: true | ascii neq: false | кириллица eq: true | ё vs е: false
NFC vs NFD (й vs и+breve): false | emoji eq: true | emoji vs ab: false | len mismatch: false
query-токен кириллица (encoded): true | без encode: true
$ node -e "…resolveTenancyMode…"
'' → namespaces; '' hosted → owned; '1' → owned; '0' hosted → off; 'true' → owned; 'мусор' → namespaces (+warn)
```

2. **generateSandboxId 200 000 итераций [MS-14]:**

```console
$ node -e "const c=require('/tmp/mock-services/packages/core'); …200000 генераций…"
N=200000 уникальных=200000 коллизий=0 мс=666
пространство: 16 прилаг. * 16 сущ. * 2^40 hex = 281474976710656 === 2^48 = 281474976710656
ожидаемых коллизий по парадоксу дней рождения: 0.00007105391830464214
пример id: bold-gecko-ce036e1ad4 | длина: 21
sanitizeSandboxId: '../../etc/passwd'->'....etcpasswd'; 'a×100'->обрезано до 64; '.'/'..'->''; 'рус'->''
```

3. **Реестр сценариев [PA-51/PA-60]:**

```console
times:0 -> 1 | times:'abc' -> 1 | times:-1 без persistent -> 1
правил после 30002 addRule: 30003 (cap отсутствует)
resolve x20000 поверх 30k правил: 2167 мс (линейный деград)
```

4. **admit/export/import/reset (PA-50/PA-54) — вывод в §2.1/§2.4.**

5. **namespaces-гонка и run() (PA-55/PA-56) — вывод в §2.5/§2.6.**

6. **HTTP-пробы tbank (PA-50/PA-51)** — `node /tmp/partyA2-scratch/http-proof.js` и `http-proof2.js` (сервер на `127.0.0.1:0`, `MOCK_HOSTED=1`, песочницы `tenant-a/tenant-b`) — вывод в §2.1/§2.2.

7. **Голодание tickAll (PA-52)** — `node /tmp/partyA2-scratch/tickall-proof.js` — вывод в §2.3.

8. **verifyMerchantWebhook (PA-58)** и **wall-clock (PA-59)** — вывод в §2.8.

9. **Реестр песочниц на диске (PA-57)** — вывод в §2.7.

Все сетевые пробы — listener строго на `127.0.0.1:0`; `npm test`/`npm run test:*` не запускались (запрет партии); scratch-скрипты в `/tmp/partyA2-scratch/` (вне репозитория), репозиторий не изменён.

## 6. Чек-боксы критериев приёмки §4.A (в части A-2)

- [x] (1) По зонам области — находки `файл:строка` + прогон-доказательства: сценарии (PA-51/PA-60, §5.3), auth/CSRF (PA-53, §5.1), sandboxes-manager/runtime (PA-50/PA-54–PA-57, §2.1–2.7), лимиты/retention (§1.4, PA-59 §2.8), экзаменатор (PA-58, §2.8), state-фасад/tickAll (PA-52/PA-55/PA-56).
- [x] (2) `[VERIFY]` из брифа в зоне A-2 закрыты прогонами: **MS-14** — 48 бит подтверждены (§5.2); **MS-38** — wall-clock подтверждён + полный список следствий (PA-59). MS-08/MS-17/MS-20/MS-09/MS-06/MS-12/MS-19 — вне зоны A-2 (строки 1–1335/адаптеры), сверены по статусам брифа без новых ID (§4).
- [x] (3) Находка уровня «можно прочитать чужую песочницу» воспроизведена скриптом: HTTP-прогон на живом tbank (§2.1) + core-прогон.
- [x] (4) Ни одного изменения поведения: git status — только untracked-отчёты партий; скрипты доказательств в /tmp.
- [x] Формат отчёта — чек-лист + таблица реестра (§2), покрытие (§3), дубли (§4), прогоны (§5).
- [ ] Обновить §3/§6 AUDIT-PREP и бриф §0.1/§7 — оставлено координатору (партия ограничена одним файлом отчёта).
