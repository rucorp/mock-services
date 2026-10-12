© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Аудит-партия A-1b — Ядро 546–1335: журнал, postJson, SSRF, очередь, числа, часы — 2026-10-12

> **База:** `main` @ `05696f3` · версия `0.5.0` · Node v24.21.0 (песочница).
> **Режим:** только чтение. Код, тесты, compose, CI и манифесты не менялись; единственный добавляемый файл — этот отчёт.
> **Baseline:** `npm test` зелёный (core 41/41, tbank PASSED, kassa 141/141, yookassa 227/227, atol 202/202, upstream 11/11, links 57, drift 221/221) — зафиксирован координатором; по правилам партии не перезапускался.
> **Область:** [`packages/core/index.js`](../../packages/core/index.js) строки **546–1335** (хвост redact/парсинга 546–612, `createJournal` 613–724, `postJson` 725–845, SSRF-гард 846–972, очередь 980–1090, `parseMsOr`/`parseDuration`/`checkClockOffset` 1107–1183, `createVirtualClock` 1195–1335; попутно прочитан блок `createErrorCatalog` 1091–1105). Остальное — партии A-1a/A-2, не тронуто. Сопряжённо читались `flagEnabled` (core:46 — вне диапазона), `resolveTenancyMode` (core:1851 — вне диапазона, зона A-2), `verifyMerchantWebhook` (core:2460–2475 — зона A-2), вызовы адаптеров.
> **Связка:** [чек-лист партии](CHECKLIST-audit-party.md) · [аудит-преп §4.A](AUDIT-PREP-2026-10-12.md) · [реестр #15](REGISTRY-2026-10-11-code-sweep.md) · отчёты [A-2](AUDIT-PARTY-A2-2026-10-12.md), [B](AUDIT-PARTY-B-2026-10-12.md), [C](AUDIT-PARTY-C-2026-10-12.md), [D](AUDIT-PARTY-D-2026-10-12.md), [E](AUDIT-PARTY-E-2026-10-12.md), [F](AUDIT-PARTY-F-2026-10-12.md).

---

## 1. Итог и ответы на вопросы партии

Найдено **9 находок**: 0 blocker/major, **6 minor, 3 info**. Ядро 546–1335 в целом добротное (эвикция журнала работает, редиректы не выполняются, схема fail-closed, часы валидируются до записи, очередь переживает poison и не дублирует доставку). Основные риски — **классовые дыры в `isPrivateAddress`** (PA-26), **поломанная доставка на любые IPv6-литералы** в `postJson` (PA-25) и **обход лимита записи журнала через unknown-ключи** (PA-27).

**Ответы на 7 вопросов:**

1. **createJournal (613–724).** Эвикция по `size` работает (проба: 1000 записей → ровно 200), `size=0` → журнал пуст. Редакция живая: `Authorization` не проходит allowlist, `?password=` → `REDACTED`, PAN маскируется. Большие тела: `rawBody` ≤ 1024, значения body ≤ 120 символов/16 ключей, `curl` ≤ 2048 — запись при rawBody=1 МБ ужимается до 2385 символов. **НО:** «финальная гарантия размера» (`fitJournalEntry`, 632–658) ужимает только `rawBody`/`curl`/`body`/`path`; unknown-ключи записи (705–707) проходят через `redactSecrets` **без ограничения длины** — 200 записей × 1 МБ unknown-ключ ≈ **190 МБ памяти журнала** (PA-27). `at` записи — wall-clock (PA-33).
2. **postJson (725–845).** Таймауты: два контура — socket-inactivity (`timeout`, WEBHOOK_SOCKET_TIMEOUT, проба: 300 мс) и общий deadline (WEBHOOK_DEADLINE_EXCEEDED, проба: `deadlineMs:0` → мгновенный обрыв); при `deadlineMs=1e21` Node превращает таймер в 1 мс (PA-30). Лимит тела ответа работает и по `Content-Length`, и по факту чанков (0 → блокирует всё; −5 → клампится в 0). Редиректы **не** выполняются (302 возвращается как результат). Socket-ошибки (ECONNREFUSED/ECONNRESET) → reject с кодом, тик очереди не роняют. `Content-Length` запроса корректен на многобайтовом теле (кириллица: 12 байт). Креды userinfo (`user:pass@`) **не отправляются** (нет Authorization), но полный URL пишется в лог очереди без редакции (PA-31). **IPv6-литералы не доставляются вовсе:** `hostname` из `new URL` содержит скобки, options-форма `http.request` уходит в DNS (`getaddrinfo ENOTFOUND [::1]`), тогда как URL-форма того же адреса коннектится — любой IPv6-мерчант недостижим (PA-25).
3. **SSRF-гард (846–972).** Все «трюковые» IPv4-формы (**`2130706433`, `0177.0.0.1`, `0x7f000001`, `127.1`, `127.0.0.1.`**) закрываются **WHATWG-нормализацией**: `new URL` приводит их к `127.0.0.1` ещё до `isPrivateHost` → BLOCKED. Zone-формы Node 24 вообще отвергает (`Invalid URL`) → `isPrivateHost` fail-closed. В списке приватных: `0.0.0.0`, CGNAT 100.64/10, benchmark 198.18/15, `192.0.0.0/24`, multicast/reserved/`255.255.255.255`, ULA fc00::/7, link-local fe80::/10 — да; **нет**: IPv6-мультикаст ff00::/8 (`[ff02::1]` проходит `assertPublicHost` → PASS), развёрнутый loopback `::0:1`/`0:0:0:0:0:0:0:1`, десятичный v4-литерал `2130706433` (standalone → false), TEST-NET 192.0.2/24+198.51.100/24+203.0.113/24, `2001:db8::/32`, local-use NAT64 `64:ff9b:1::/96` (PA-26; NAT64 `64:ff9b::/96` и mapped — известное §2.1, дублировано). Проверка ДО resolve: да — публичный IP-литерал → `return true` без DNS (927); приватный/резолв-ошибка → блок **до** соединения (e2e-проба: 0 доставок, `SSRF_BLOCKED` в lastStatus). TOCTOU: `assertPublicHost` резолвит (931), затем `postJson`/`http.request` резолвит **второй раз** (770–773) без пиннинга адреса — MS-09 остаток (код-уровень подтверждён; end-to-end rebinding в песочнице невоспроизводим).
4. **Очередь (980–1090).** Ретраи: **фиксированный** `retryMs` без экспоненты/джиттера (E2), кап `maxAttempts` (после него tbank/yookassa/atol ставят `dumped`; **ядро** дефолтным `onFailure` терминального маркера не ставит). Poison-сообщения (битый URL в state) тик не роняют (E1), но запись остаётся в `entries` навсегда — у kassa (нет `onFailure`) без всякого маркера. Потеря при рестарте: entries персистится адаптером (`persist` в finally, 1042); `inFlight`/`ticking` — runtime-only по построению (1008–1016) → семантика at-least-once, `done` после рестарта не пересылается. Дубли внутри инстанса — нет (`inFlight`, E6). Переполнение: **капа/eviction записей в ядре нет**, каждый тик — `Object.keys` по всем id (200001 записей → ~52 мс/тик) (PA-28). Часы: `now` инжектируется; **все четыре адаптера передают `clock.now()`** (tbank:577, kassa:775, yookassa:433, atol:809) — advance часов ускоряет ретраи (E3); дефолт ядра — `Date.now`.
5. **parseDuration/parseMsOr (1134–1162) [VERIFY MS-08].** Таблица в §5 (проба A): `''`/`null`/`undefined`/мусор → fallback; `'0'`, 0, `'+0'` → 0 (выключение работает); `-5`, `'-5s'` → **0 (кламп к min, не fallback)**; `'1e3'`, `'0x10'`, `'1_000'`, `'1h30m'` → fallback; `'  500  '` → 500; `'1d 12h'`/`'+36h'` → ок. **Единого min/max-клампа нет**: min есть (`Math.max(0,…)` в parseMsOr), max отсутствует — `parseMsOr('999…9')=1e21`, а Node-таймеры > 2^31−1 превращаются в 1 мс (PA-30; закрывает остаток MS-08 таблицей + задачей). Вызовы parseMsOr: MOCK_SANDBOX_TTL_MS/MAX/MAX_DOCUMENTS/RETENTION_MS/CREATE_LIMIT/SWEEP_MS во всех 4 сервисах (tbank:98-103/3395, kassa:98-103/941, yookassa:90-95/2089, atol:146-151/908), MOCK_CAPTURE_TTL_MS (yookassa:76), MOCK_ACQAPI_TOKEN_TTL_MS (tbank:1094), начальный сдвиг часов (core:1198). Ретраи очередей идут **мимо** parseMsOr (Math.max(1000, parseInt||N), tbank:71, kassa:104, yookassa:73, atol:117).
6. **createVirtualClock (1195–1335).** `advance('-1h')` — валиден (отрицательный сдвиг допустим, «-100000000d» тоже — в пределах ±8.64e15); `advance(NaN/'abc'/'+999y')` → THROW до изменения состояния; `'+0'` — no-op; `'+999999999d'` → THROW (checkClockOffset, MAX_DATE_OFFSET_MS) — **overflow не сохраняется в state** (F-05 подтверждён). `set({offsetMs:NaN/Infinity})`, `set({offset:'1e3'})`, битая ISO → THROW. Env-путь: невалидный `MOCK_VIRTUAL_CLOCK` → warn + offset 0, старт не падает; `true/false/0` → 0 (при `true` флаг `virtual:true` при нулевом offset — косметика); env **переопределяет** сохранённый state-сдвиг при старте. Битый сдвиг из state (1e18) → warn + откат на локальное значение. Очередь на часы реагирует (E3, адаптеры передают `clock.now()`); offset хранится per-sandbox (`state.clockOffsetMs`, tbank:239). Монотонность: `now() = Date.now() + offset` — немонотонна при скачках системных часов (семья wall-clock PA-59/MS-38, не дублирую).
7. **Флаги.** `flagEnabled` (core:46) и `resolveTenancyMode` (core:1851) **вне диапазона A-1b** (зоны A-1a/A-2; дефолты tenancy уже зафиксированы партией D, fail-open `flagEnabled('false', true)`→false — PF-01). Таблица флагов/умолчаний моей зоны — §2a.

---

## 2. Реестр находок

| ID | модуль | файл:строка | категория | severity | суть | предлагаемая задача | зависимости |
|---|---|---|---|---|---|---|---|
| PA-25 | postJson | `packages/core/index.js:770-772` | correctness | minor | `postJson` передаёт `hostname: target.hostname` со **скобками** (`'[::1]'`); options-форма `http.request` не снимает их → `getaddrinfo ENOTFOUND [::1]`, тогда как URL-форма того же адреса коннектится (проба C 2/2b/2c/2d). Итог: **любой IPv6-литерал (в т.ч. публичный) недостижим** для вебхуков — очередь пережжёт `maxAttempts` и отправит в `dumped`. Побочно это случайно экранирует обходы §2.1 (гард пропускает, соединение не состоялось) | Передавать в `http.request` URL-строку (`href`) или снимать скобки + `family`; регресс «доставка на IPv6 listener» и «IPv6-литерал в вебхуке». DoD: доставка на `[::1]` listener работает; вебхук на публичный IPv6-литерал не теряется молча | Чинить совместно с §2.1/MS-09: после снятия скобок mapped/multicast-обход становится реально эксплуатируемым |
| PA-26 | SSRF-гард | `packages/core/index.js:846-874` | security | minor | `isPrivateAddress` fail-open на классах (проба B): `'2130706433'` → false (десятичный v4-литерал матчится hex-regex как «публичный IPv6»); `'::0:1'`, `'0:0:0:0:0:0:0:1'` → false (развёрнутый loopback); `'ff02::1'`, `'ff0e::1'` → false (**IPv6-мультикаст ff00::/8 отсутствует** — `[ff02::1]` проходит `assertPublicHost` целиком); `'192.0.2.1'`, `'198.51.100.1'`, `'203.0.113.1'` → false (TEST-NET); `'2001:db8::1'` → false; `'64:ff9b:1::7f00:1'` → false (local-use NAT64, расширение §2.1). Через `isPrivateHost`/`assertPublicHost` IPv4-формы закрыты WHATWG-нормализацией, но экспортируемый `isPrivateAddress` наследуется любым новым потребителем (риск (б) §2.1) | Разбирать адрес через `net.isIP` + канонизацию (собственная функция без зависимостей): decimal/hex v4, развёрнутый IPv6, ff00::/8, TEST-NET, 64:ff9b:1::/96 → private; регресс-таблица в selftest ядра | §2.1 (mapped/`64:ff9b::/96` — дубли не заводить), MS-09; связан с PA-25 |
| PA-27 | createJournal | `packages/core/index.js:705-707`, `:636-658` | resilience | minor | Unknown-ключи записи (`safeEntry[key] = redactSecrets(value)`) не ограничены по длине, а `fitJournalEntry` ужимает только `rawBody`/`curl`/`body`/`path` — проба D3: запись с `customNote=1МБ` = 1 000 202 символа; 200 записей ≈ **190 МБ памяти журнала**; «финальная гарантия размера записи» (JSDoc 632–635) не выполняется; при `maxEntryChars=10` запись остаётся 485 символов (маркер заменяет только body). Живые адаптеры пока передают только известные ключи — дыра для будущих вызовов exported API | Ограничить unknown-ключи (truncate до N/отбрасывать), финальный фолбэк — замена всей записи маркером при превышении; регресс «запись с 1 МБ unknown-ключом ≤ maxEntryChars» | F-09 |
| PA-28 | createDeliveryQueue | `packages/core/index.js:1000-1072` | resilience | minor | Нет капа и eviction записей: дефолтный `onSuccess` оставляет запись в `entries`, дефолтный `onFailure` после исчерпания `maxAttempts` не ставит терминального маркера (проба E1: attempts=3, done=undefined, запись в entries); каждый тик — `Object.keys` по всем id (проба E5: 200001 записей → ~52 мс/тик). У kassa (без `onFailure`, kassa:767-779) неудачные записи не удаляются и не помечаются вовсе. Уточняет A-2 §1.4 (рост state) и PD-02 (стоимость persist) на уровне механизма очереди | Опция `maxEntries`/eviction + авто-удаление терминальных (`done`/`dumped`/attempts≥max) записей по настраиваемому TTL, пропуск `done` в скане; регресс на счётчик итераций тика | A-2 §1.4, PD-02, PA-52 (одна очередь на песочницу) |
| PA-29 | createDeliveryQueue | `packages/core/index.js:956`, `:1002-1007` | correctness | minor | Контракт счётчика попыток противоречив: JSDoc (956) рекомендует инкремент `attempts` в `prepare`, но дефолтный `onFailure` (1003) тоже инкрементирует → комбинация «prepare(+1) + дефолтный onFailure» даёт ×2: проба E4 — attempts=2 после **одной** доставки, при `maxAttempts=2` лимит исчерпан одной попыткой. Живые адаптеры не задеты (tbank/yookassa/atol — кастомный onFailure без инкремента; kassa — ни того, ни другого) | Убрать инкремент из дефолтного onFailure (или из рекомендации prepare), зафиксировать контракт в JSDoc; регресс «prepare+дефолт: ровно maxAttempts попыток» | — |
| PA-30 | parseMsOr/parseDuration + postJson deadline | `packages/core/index.js:1134-1162`, `:736-741`, `:827-831` | resilience | minor | Максимума нет: `parseMsOr('999999999999999999999') = 1e21` (проба A); Node-таймеры > 2^31−1 → `TimeoutOverflowWarning` → **1 мс** (проба A-хвост; `postJson` с `deadlineMs=1e21` → WEBHOOK_DEADLINE_EXCEEDED через 1 мс — «отключить таймаут» превращается в мгновенный обрыв). Интервалы sweep сейчас защищены ad-hoc `Math.max(1000, …)` на местах (tbank:3400, kassa:946, yookassa:2094, atol:913), ретраи очередей — `Math.max(1000, parseInt‖N)`; контракт клампа не закреплён в ядре (остаток MS-08) | Единый кламп длительностей (0..2^31−1 или свой MAX) в `parseMsOr`/потребителях + warn при усечении; регресс-таблица MS-08 в selftest ядра | MS-08 |
| PA-31 | очередь/логи | `packages/core/index.js:1030`, `:1039` | dx | info | Лог очереди пишет **полный URL** (`webhook N delivered -> ${url}`) без редакции: userinfo (`user:pass@`) и query-токены приёмника попадают в stdout/контейнерные логи; журнальный путь при этом query редактирует (675). URL интегратора — его собственные креды, но стенд их размножает в логи | Прогонять URL через `redactSecretsInText`/`redactQuerySecrets` перед логом; регресс в selftest ядра | F-09 |
| PA-32 | parseDuration | `packages/core/index.js:1148-1160` | dx | info | Склейка единиц без разделителей не парсится: `'1h30m'` → null (после `'h'` нет `\b` перед `'3'`, хвост `'1h'` не удаляется) → **тихий fallback**: env вида `MOCK_SANDBOX_TTL_MS=1h30m` молча получают дефолт 24 ч; `'1e3'` → fallback тоже (осознанно, но нигде не задокументировано). `'1h 30m'` — работает | Поддержать склейку (допустить границу цифра-после-юнита) или логировать warn при непустом остатке; таблицу поведения — в README пакета | MS-08 |
| PA-33 | createJournal | `packages/core/index.js:694` | correctness | info | `at` записи — wall-clock (`new Date().toISOString()`), не `clock.now()`: при `advance` время записей журнала остаётся реальным; для сквозных сценариев «журнал показывает виртуальное время» рассинхрон | Передавать `at` из адаптеров (или опция `now`) либо задокументировать wall-clock семантику журнала | PA-59/MS-38 (семья wall-clock) |

### 2a. Таблица флагов/умолчаний зоны A-1b (fail-open/fail-closed)

| Флаг / параметр | Где (файл:строка) | Дефолт | Поведение | Оценка |
|---|---|---|---|---|
| `blockPrivateHosts` очереди | core:994 (парам. `createDeliveryQueue`), адаптеры tbank:580/kassa:778/yookassa:436/atol:829 | **false** | Ядро fail-open; адаптеры передают `flagEnabled(MOCK_BLOCK_PRIVATE_WEBHOOKS, HOSTED)` → hosted: fail-closed, self-hosted: осознанно open | Тот же класс, что PA-58 (экзаминатор) — дубль-класс, новый ID не завожу |
| `MOCK_BLOCK_PRIVATE_WEBHOOKS` (kassa) | kassa:50,90 | **строка 'false'** | Перебивает HOSTED-фолбэк → гард выключен даже в hosted | Дубль PF-01 (партия F) |
| Схема исходящего запроса | core:728-731, 921-923 | — | всё кроме http/https → reject/blocked | fail-closed |
| Нераспарсенный URL / пустой хост | core:896-897, 892 | — | `isPrivateHost` → true | fail-closed |
| Пустая строка / битый v4-литерал (>255) в `isPrivateAddress` | core:848, 856 | — | true (private) | fail-closed |
| Десятичный v4-литерал, развёрнутый loopback, IPv6-мультикаст, TEST-NET, `2001:db8::/32`, `64:ff9b:1::/96` | core:868-872 | — | false (public) | **fail-open — PA-26** |
| Ошибка DNS в `assertPublicHost` | core:932-934 | — | blocked | fail-closed |
| Лимит тела ответа `maxResponseBytes` | core:733-735 | 64 КБ | `0` → блокировать всё; отрицательный → кламп в 0 | fail-closed |
| `deadlineMs` / socket-таймаут | core:736-741 | 10000 | `0` → мгновенный abort; >2^31−1 → Node превращает в 1 мс | fail-open по намерению → **PA-30** |
| `parseMsOr`: пусто/мусор → fallback; `0` → 0; отрицательные → 0 (не fallback) | core:1134-1138 | fallback=0 | «выключить нулём» работает (A-10/F-24) | ok; max-клампа нет — PA-30 |
| `MOCK_VIRTUAL_CLOCK` невалидный | core:1242-1251 | offset 0 | warn + старт на wall-clock | fail-open осознанный (с логом) |
| Сдвиг часов вне диапазона Date | core:1174-1183 | — | THROW до записи в state | fail-closed (F-05, подтверждено F7/F20) |
| Заголовки в журнал | core:577-595 | allowlist | unknown → отброшен | fail-closed |
| `flagEnabled` (core:46, вне диапазона — для полноты) | core:37-53 | fallback | unknown-строка → fallback; `1/true/yes/on`, `0/false/no/off` | нейтрально; `('false', true)→false` — PF-01 |

---

## 3. Покрытие строк 546–1335

`packages/core/index.js` (2670 строк): **строки 546–1335 прочитаны полностью, без пропусков** (фактически 540–1344 с контекстом). Блоки:

| Блок | Строки | Статус |
|---|---|---|
| `shellQuote`, `buildCurlCommand`, `JOURNAL_HEADER_ALLOWLIST`, `filterJournalHeaders`, `JOURNAL_LIMITS` | 546–612 | ✅ прочитан (редакция — пробы D2b/D4) |
| `truncateText`, `capJournalBody`, `fitJournalEntry`, `createJournal` + list/clear | 613–714 | ✅ (PA-27, PA-33; эвикция/лимиты — проба D) |
| `postJson` + константы | 721–836 | ✅ (PA-25, PA-30, PA-31; пробы C/C2) |
| `PRIVATE_NAME_RE`, `isPrivateAddress`, `isPrivateHost`, `assertPublicHost` | 840–942 | ✅ (PA-26; пробы B/G1) |
| `webhookDiagnosticBody`, `createDeliveryQueue` | 973–1072 | ✅ (PA-28, PA-29; пробы E/E5/E6, G2) |
| `createErrorCatalog` (внутри диапазона, вне списка вопросов) | 1091–1105 | ✅ прочитан; дефектов не найдено |
| `DURATION_UNITS`, `parseMsOr`, `parseDuration`, `MAX_DATE_OFFSET_MS`, `checkClockOffset` | 1109–1183 | ✅ (PA-30, PA-32; пробы A, F) |
| `createVirtualClock` | 1195–1311 | ✅ (проба F, ответ 6) |
| Начало `parseMoneyKopeks` (граница с A-2) | 1313–1335 | ✅ прочитан; глубже не разбирал (зона A-2/адаптеров) |

Сопряжённо (вне диапазона, для проверки следствий): `flagEnabled`/`FLAG_TRUTHY|FALSY` (37–53), redact-хвост (425–544), `createStore.persist` (181–189), `resolveTenancyMode` (1851–1870), `verifyMerchantWebhook` (2460–2475), `tickAll`/`persist` рантайма (2418–2450), конфиги очередей всех 4 адаптеров (tbank:565–596, kassa:767–779, yookassa:427–455, atol:795–830), `Math.max(1000,…)` клампы (grep), journal.record вызовы адаптеров (tbank:2562, kassa:1272, yookassa:1737, atol:1290).

За рамками (честно): строки 1–545 (партия A-1a), 1335–2670 (партия A-2); selftest ядра не анализировался построчно; Docker/CI — партии C/D.

---

## 4. Дубли и уже поставленное

* **§2.1 AUDIT-PREP (SSRF-mapped-bypass)** — воспроизведён (проба B: `http://[::ffff:127.0.0.1]/` → hostname `[::ffff:7f00:1]`, `isPrivateHost=false`, assertPublicHost PASS; `[64:ff9b::7f00:1]` → PASS). Новый ID не заведён; PA-26 заводит только **новые** классы (multicast/TEST-NET/десятичный v4/`64:ff9b:1::/96`), PA-25 — отдельный дефект доставки.
* **MS-09 (hostname-only + TOCTOU + egress)** — TOCTOU подтверждён по коду (`assertPublicHost` резолвит core:931, `postJson` резолвит повторно core:770–773, без пиннинга); end-to-end rebinding в песочнице невоспроизводим. Остаток за MS-09, нового ID нет.
* **PA-58 (A-2: дефолт `blockPrivateHosts=false` в экзаменаторе, порт не ограничен)** — для очереди ядро имеет тот же fail-open дефолт (core:994); один класс дефекта, новый ID не заведён (записан в §2a).
* **PF-01 (F: kassa `MOCK_BLOCK_PRIVATE_WEBHOOKS='false'`)** — подтверждён (kassa:50,90), не дублировал.
* **PA-52 (A-2: общий `ticking` + tickAll)** — подтверждён по коду (core:1016, 1047), не дублировал.
* **PA-59/MS-38 (wall-clock)** — очередь и часы примыкают (дефолт `Date.now` core:995; немонотонность `now()`); у адаптеров `clock.now()` уже передаётся (AUDIT-PREP §2.4) — в реестр вынесен только wall-clock журнала (PA-33).
* **PD-08 (D: глотание ошибок persist)** — смежный путь очереди проверен: `persist()` в finally (core:1042) не может крашнуть доставку (createStore.persist глотает, core:186-188; runtime-persist core:2423), unhandled rejection от persist исключён — остаётся в PD-08.
* **PD-02 (D: write-амплификация persist)** — `advance` часов тоже триггерит полную запись (`setStateOffset → persist`, tbank:239) — подтверждение PD-02, не новый ID.
* **MS-08 [VERIFY]** — закрыт таблицей пробы A (§5); остаток «единый max-кламп + таблица-тест» → PA-30/PA-32.
* **MS-14/MS-38 [VERIFY]** — вне диапазона, закрыты партией A-2 (не проверял повторно).
* **MS-17/MS-20 [VERIFY]** — вне диапазона (parseBody 258–271, серверные таймауты) — за партией A-1a.
* **Партия B** — ACK-семантика очередей (200 ровно/любой 2xx) и `dumped` подтверждены её пробами; поведение ядра (`isOk`-контракт) не дублирую.

---

## 5. Прогоны (команды + вывод)

Скрипты-доказательства: `/tmp/partyA1b-scratch/{probe-duration,probe-ssrf,probe-postjson,probe-postjson2,probe-journal,probe-queue,probe-clock,probe-guard-e2e}.*`. Сетевые listener'ы — только `127.0.0.1:0`. `npm test` не запускался (baseline зелёный по брифу).

**A. parseDuration/parseMsOr (MS-08):** `node /tmp/partyA1b-scratch/probe-duration.js`

```
"" null 7777 | "0" 0 0 | 0 0 0 | "abc" null 7777 | -5 -5 0 | "-5s" -5000 0
"1e3" null 7777 | "0x10" null 7777 | "1_000" null 7777 | Infinity null 7777
"1000ms" 1000 | "2h" 7200000 | "1d" 86400000 | null/undefined null 7777
"  500  " 500 | "+0" 0 | "1.5h" 5400000 | "1h30m" null 7777 | "5ss"/"30x" null
"999999999999999999999" 1e+21 1e+21 | "9007199254740993" 9007199254740992
parseMsOr("999…9")=1e+21 > 2^31-1: true
TimeoutOverflowWarning: 1e+21 does not fit into a 32-bit signed integer. Timeout duration was set to 1.
```

**B. SSRF-гард:** `node /tmp/partyA1b-scratch/probe-ssrf.js`

```
2130706433 false | 0177.0.0.1 null | 0x7f000001 null | 127.1 null | 0.0.0.0 true
100.64.0.1 true | 198.18.0.1 true | 192.0.0.9 true | 192.0.2.1 false | 198.51.100.1 false
203.0.113.1 false | 240.0.0.1 true | 169.254.169.254 true | ff02::1 false | ff0e::1 false
0:0:0:0:0:0:0:1 false | ::0:1 false | 64:ff9b::7f00:1 false | 64:ff9b:1::7f00:1 false
::ffff:7f00:1 false (§2.1) | 2001:db8::1 false
URL: http://2130706433/ → hostname=127.0.0.1 BLOCKED; 0177.0.0.1 → 127.0.0.1 BLOCKED;
0x7f000001 → 127.0.0.1 BLOCKED; 127.1 → 127.0.0.1 BLOCKED; 127.0.0.1. → 127.0.0.1 BLOCKED
[::1%25lo] → Invalid URL → BLOCKED (fail-closed); [0:0:0:0:0:0:0:1] → [::1] BLOCKED
[ff02::1] → isPrivateHost=false PASS(без lookup)  ← PA-26
[64:ff9b::7f00:1] → PASS (§2.1); [::ffff:127.0.0.1] → [::ffff:7f00:1] PASS (§2.1)
```

**C. postJson (арность `postJson(url, payload, timeoutMs, options)`):** `node /tmp/partyA1b-scratch/probe-postjson.js` + `probe-postjson2.js`

```
1)  happy path 200 body="OK"; Content-Length=7; кириллица: content-length=12, байт=12 (корректно)
2)  postJson http://[::1]:PORT/ → REJECT ENOTFOUND getaddrinfo ENOTFOUND [::1]   ← PA-25
2b) http.request{hostname:'[::1]'} → ENOTFOUND | 2c) http.request('http://[::1]:…') → ECONNREFUSED
2d) http.request{hostname:'::1'} → ECONNREFUSED   (скобки в options-форме ломают доставку)
3)  user:pass@ → 200, Authorization header отправлен? false (креды не уходят)
4)  302 → OK statusCode=302 (редирект не следует)
5-7) opts{maxResponseBytes:0} → WEBHOOK_RESPONSE_TOO_LARGE (CL=0, тело 200Б, chunked — всё блокируется)
8)  opts{deadlineMs:0} /hang → WEBHOOK_DEADLINE_EXCEEDED after 0ms
9)  opts{deadlineMs:1e21} → TimeoutOverflowWarning → deadline сработал мгновенно ← PA-30
10) timeoutMs=300 /hang → WEBHOOK_SOCKET_TIMEOUT (socket inactive for 300ms)
11) timeoutMs=300 /slow-drip → WEBHOOK_SOCKET_TIMEOUT (неактивность 300 мс)
12) file:// → отклонён (схема file: не поддерживается); 13) порт 70000 → ERR_INVALID_URL
14) maxResponseBytes=-5 → кламп в 0
```

**D. createJournal:** `node /tmp/partyA1b-scratch/probe-journal.js`

```
D1) 1000 записей, size=200 → 200 (эвикция)
D2) rawBody=1МБ + body=500КБ → длина JSON записи 2385 ≤ 8192; authorization не утекает
D3) unknown-ключ 1МБ → запись 1 000 202 символа > 8192 (fitJournalEntry не ужимает) ← PA-27
D3b) 200 записей × 1МБ unknown-ключ ≈ 190.8 МБ памяти журнала
D4) ?password= → REDACTED; PAN → 411111**1111; body password → [REDACTED]
D6) maxEntryChars=10 → запись 485 символов (маркер заменяет только body)
D7) size=0 → 0 записей
```

**E. Очередь:** `node /tmp/partyA1b-scratch/probe-queue.cjs`

```
E1) poison (битый URL): attempts=3, done=undefined, dumped-маркера в ядре нет, запись осталась ← PA-28
E2) nextAttemptAt-now=59951мс — фиксированный retryMs, без экспоненты
E3) после advance +1h attempts=2 — ретрай ускорился виртуальными часами (now инжектируется)
E4) prepare(+1)+дефолт onFailure(+1): attempts=2 после ОДНОЙ доставки (maxAttempts=2 исчерпан) ← PA-29
E5) 5 тиков поверх 200001 записей (200000 done): 258.5 мс (~52 мс/тик) ← PA-28
E6) параллельные тики по одной записи → один send (дубля нет, inFlight работает)
```

**F. createVirtualClock:** `node /tmp/partyA1b-scratch/probe-clock.cjs`

```
F1 advance('-1h') OK offset=-3600000 | F2 advance('-100000000d') OK (в пределах ±8.64e15)
F3 advance(NaN)/F4 'abc'/F6 '+999y' → THROW (state не менялся)
F5 advance('+0') → no-op | F7 '+999999999d' → THROW (диапазон Date) | F9 9007199254740992 OK (в диапазоне)
F10/F11 offsetMs NaN/Infinity → THROW | F12 offset '1e3' → THROW | F15 битая дата → THROW
F13/F14 ISO 9999/0001 → OK | F17 reset → 0
F20 MOCK_VIRTUAL_CLOCK=+999999999d → LOG «игнорирован», offset=0 (старт не павший)
F21 'garbage' → 0 | F22 'true' → offset=0, virtual=true (косметика)
F24 state offset=1e18 → LOG «игнорирован», откат на локальное значение
```

**G. e2e через очередь (listener 127.0.0.1:0):** `node /tmp/partyA1b-scratch/probe-guard-e2e.cjs`

```
G1) blockPrivateHosts=true, URL=127.0.0.1:PORT/hook → доставок: 0, lastStatus "ERR SSRF_BLOCKED: …"
G2) blockPrivateHosts=false → доставлено, n1.done=true, attempts=0
```

---

## 6. Чек-боксы критериев AUDIT-PREP §4.A (в части A-1b)

* [x] **Критерий 1 — по каждой зоне находки `файл:строка` + прогон-доказательство:** журнал (PA-27/PA-33, проба D), postJson (PA-25/PA-30/PA-31, пробы C/C2), SSRF (PA-26, пробы B/G), очередь (PA-28/PA-29, пробы E/G2), числа (PA-30/PA-32, проба A), часы (проба F, ответ 6), флаги (таблица §2a).
* [x] **Критерий 2 — [VERIFY] MS-08 закрыт:** таблица пробы A (§5) + остаток переведён в PA-30/PA-32; MS-14/MS-38 — закрыты A-2; MS-17/MS-20 — вне диапазона A-1b (зоны A-1a), помечены в §4.
* [x] **Критерий 3 — находки «чужая песочница»:** в зоне 546–1335 не обнаружены (зона auth/policy — A-2, там blocker PA-50); в моей зоне уровнем выше — только латентные fail-open классы (PA-26, minor).
* [x] **Критерий 4 — ни одного изменения поведения:** репозиторий изменён только добавлением этого отчёта; скрипты-пробы — в `/tmp/partyA1b-scratch/`.
* [x] Чек-лист партии §0–§2: база зафиксирована (`05696f3`, 0.5.0, Node v24.21.0, git status — только отчёты партий), область и «за рамками» перечислены (§3), все security-утверждения — с прогонами, `[VERIFY]`-пункты зоны закрыты.
