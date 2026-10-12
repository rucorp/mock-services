© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Аудит-партия B — Адаптеры-сироты: ЮKassa и АТОЛ — 2026-10-12

> **Issue партии:** [#43 — прогон агент-брифа и пакет подготовки к глубокому аудиту](https://github.com/rucorp/mock-services/issues/43), §4.B [AUDIT-PREP-2026-10-12.md](AUDIT-PREP-2026-10-12.md)
> **База:** `main` @ `05696f3` · версия `0.5.0` · Node v24.21.0 · `git status` чист (создан только этот отчёт)
> **Режим:** только чтение. Код, тесты, compose, CI и манифесты не менялись; единственный добавляемый файл — этот отчёт. Полный `npm test` не запускался (зелёная база зафиксирована координатором); точечные проверки — `node -e` и живые пробы на listener'ах `127.0.0.1:0`.
> **Чек-лист партии:** [CHECKLIST-audit-party.md](CHECKLIST-audit-party.md) · формат реестра — [REGISTRY-2026-10-11-code-sweep.md](REGISTRY-2026-10-11-code-sweep.md) §2

## Область партии (файлы с диапазонами строк)

| Файл | Диапазон | Глубина |
|---|---|---|
| [`services/yookassa-mock/server.js`](../../services/yookassa-mock/server.js) | 1–2115 | **прочитан полностью**, построчно |
| [`services/atol-mock/server.js`](../../services/atol-mock/server.js) | 1–1672 | **прочитан полностью**, построчно |
| [`services/yookassa-mock/selftest.js`](../../services/yookassa-mock/selftest.js) | 1–822 | покрытие оценено по перечню `check()` (все блоки сценариев/негативов); хелперы 1–216 просмотрены частично |
| [`services/atol-mock/selftest.js`](../../services/atol-mock/selftest.js) | 1–853 | аналогично; хелперы 1–250 частично |
| [`services/yookassa-mock/README.md`](../../services/yookassa-mock/README.md), [`services/atol-mock/README.md`](../../services/atol-mock/README.md) | целиком, включая разделы «Границы и документированные форки» | полностью |
| [`docs/integration/yookassa.md`](../integration/yookassa.md), [`docs/integration/atol.md`](../integration/atol.md) | целиком | полностью |
| [`docs/reference/yookassa/01–03`](../reference/yookassa/01-payments-and-refunds.md), [`docs/reference/atol-online/01–02`](../reference/atol-online/01-api-v4-v5.md) | целиком (5 конспектов) | полностью |
| [`packages/core/index.js`](../../packages/core/index.js) | выборочно: `parseBody/send/sendJson/html/escapeHtml` (258–298), `summarizeBody`/редакция (499–511), `createJournal`+redact (518–714), `parseScenarioSpec` (1377–1411), `admit/run` (2168–2214) | выборочно (ядро — зона партии A) |

**За рамками:** `packages/core/index.js` целиком (партия A), `check:drift`/CI/скрипты (партия C), compose/env/`SECURITY.md` (партия D), юридическая оценка конспектов (партия E), сверка реестра #15 (партия F), сверка конспектов с первоисточниками провайдеров (недоступно из песочницы), полная матрица `MOCK_*` (партия D).

---

## 1. Итог и трактовки

Проверены **все 42 маршрута** обоих сервисов (25 у ЮKassa, 17 у АТОЛ, включая fallback'и) против конспектов `docs/reference/**`. Общий вердикт: **обе «сироты» построены на тех же защитных слоях ядра, что tbank/kassa** — журналирование с редакцией (F-09, подтверждено живой пробой: `Token`, пароль и e-mail покупателя в журнале отсутствуют), `checkControlAccess` для `/admin` и `/mock/*` с fail-closed в hosted (F-07), admission песочниц (F-11/F-12), квоты документов (F-15), CSRF на `/admin/action`, SSRF-guard исходящих callback/webhook. Самотесты — самые плотные в репозитории (227 и 202 проверки, негативы почти на каждую ветку валидации).

Найдено **10 находок: 1 major, 5 minor, 4 info** (blocker нет).

Ключевое:

1. **PB-01 (major): дедупликация `external_id` АТОЛ ломается на значениях с пробелами** — ключ ищется по `trim()`-версии (`server.js:1545→1571`), а пишется без `trim()` (`server.js:946→986`). Живая проба: два идентичных запроса с `external_id=" ws-1 "` создали **два документа** (второй чек) — прямое нарушение контрактного обещания «повтор с тем же ID возвращает UUID уже созданной операции вместо второго чека» (`docs/reference/atol-online/01-api-v4-v5.md:31`).
2. **PB-02 (minor): 22 тестовые карты отказа из `docs/reference/yookassa/03-testing.md` (все Visa и все МИР) не реализованы** — в `CARDS` только MC-колонка (`server.js:202-221`); все 22 PAN Luhn-валидны (проверено скриптом) → мок отдаёт им `general_decline` вместо заявленной причины. Гайд при этом отправляет интегратора к «полной таблице» конспекта (`docs/integration/yookassa.md:50`) — форк, зафиксированный в комментарии кода (`server.js:209`), но не в доках.
3. **Гонок идемпотентности нет** (вопрос партии №3): в обоих сервисах между проверкой и записью нет ни одного `await` — критическая секция синхронна и атомарна. Подтверждено пробой: 40 параллельных `POST /v3/payments` с одним `Idempotence-Key` → **1 платёж**; 40 параллельных `sell` с одним `external_id` → **1 документ**.
4. **ACK вебхуков корректен** (вопрос №4): ЮKassa — ровно `200` (`server.js:435`), подтверждено пробой: `201/204/304` → ретрай, `200` → `done`. АТОЛ — любой 2xx (`server.js:811`) — задокументированный форк (правило ACK в v4 не опубликовано). При ненормальном ACK оба сервиса повторяют доставку `retryMs × maxAttempts`, затем `dumped`; адрес приёмника защищён SSRF-гардом (`blockPrivateHosts`).
5. **Манифест/OpenAPI ЮKassa** (вопрос №6): отсутствие подтверждено (`protocols/yookassa.json` нет в дереве; маршрута `/openapi.json` нет; `services/yookassa-mock/README.md:209` — оговорка) — для дрейф-чекера составлен проект из **50 инвариантов** (§2b), вход для MS-18/MS-37; реализация не выполнялась.
6. Защитные слои покрыты **симметрично** tbank/kassa за одним исключением по тестам: hosted-режим ЮKassa не покрыт selftest'ом вовсе (у АТОЛ есть полный hosted-блок) — PB-05.

Трактовки, зафиксированные для последующих партий:

- HTTP 200 для всех протокольных ошибок АТОЛ (включая коды 11/14) — **не находка**: соответствует конспекту (`01-api-v4-v5.md:47`, «не сводить все ошибки к HTTP-коду») и README (`atol-mock/README.md:126-129`); реальные HTTP-коды оставлены инфраструктурным слоям (404/405/413/500).
- Таблица числовых кодов ошибок v4 (4/5/10/11/14/57) взята из общей платформенной таблицы; сверка с PDF API v4 (5.15) из песочницы невозможна — задолженность зафиксирована в `atol-mock/README.md:219-224`; в будущий манифест АТОЛ коды входят с пометкой `[VERIFY]`.
- Поведение частичного capture у ЮKassa (`amount` объекта не меняется, `server.js:990-992`) — **PB-06**: ни конспект, ни README это не фиксируют; в инвариантах §2b закреплено как «сначала решить: форк или сверить».
- Строгость ЮKassa-мока (обязательный `confirmation`, только `redirect`) трактована как осознанное сужение scope #33 (README «Границы»), а не дрейф: реальный API допускает создание платежа без confirmation для части сценариев.

---

## 2. Реестр находок

Формат — §2 [REGISTRY-2026-10-11-code-sweep.md](REGISTRY-2026-10-11-code-sweep.md). Severity относится к текущему коду; `blocker` — блокер hosted/public deployment.

| ID | модуль | файл:строка | категория | severity | суть | предлагаемая задача | зависимости |
|---|---|---|---|---|---|---|---|
| PB-01 | atol-mock / идемпотентность | `services/atol-mock/server.js:1545,1571` (lookup по `trim()`) vs `:946,:986` (store без `trim()`) | protocol | **major** | Ключ дедупликации ищется как `${group}\u0000${externalId.trim()}`, а создаётся как `${group}\u0000${externalId}` (без trim). Для `external_id` с ведущими/хвостовыми пробелами повтор **того же тела** создаёт второй документ: проба на живом listener — `" ws-1 "` → uuid `1af5bcc5…`, повтор → `a95c23ff…`, `"ws-1"` → `236e640b…` (3 документа из 2 уникальных id, `X-Mock-Replayed` отсутствует). Нарушено `docs/reference/atol-online/01-api-v4-v5.md:31` и `atol-mock/README.md:100-106`. Selftest проверяет только id без пробелов. | **Унифицировать нормализацию `external_id`**: нормализовать один раз в обработчике и передавать уже нормализованное значение в `createDocument` (trim в обе стороны); добавить регресс в `selftest.js`: «повтор с пробелами возвращает прежний uuid» и «" a" и "a" — один документ». DoD: проба из §5 №4 выдаёт 1 документ и `X-Mock-Replayed: 1`. | Нет; задевает только ветку дедупа (до валидации), поведение для id без пробелов не меняется |
| PB-02 | yookassa-mock / тестовые карты | `services/yookassa-mock/server.js:202-221` (CARDS), `:1272-1281` (fallback), `docs/reference/yookassa/03-testing.md:24-38`, `docs/integration/yookassa.md:50` | docs | minor | В `CARDS` — 5 карт успеха и **только MC-колонка** отказов (11 PAN). Все 22 PAN отказов Visa/МИР из конспекта Luhn-валидны и попадают в fallback → `general_decline` вместо документированной причины (`4839 6654 9960 3842` должен давать `3d_secure_failed`, даёт `general_decline`). Код честно комментирует «MC-колонка» (`:209`), но README сервиса (`:133-136`, «и т.д.») и гайд предупреждают не там, где интегратор выбирает карту. | Либо дополнить `CARDS` колонками Visa/МИР (12×2 PAN из конспекта; в selftest — по 2 причины на колонку), либо явная оговорка в README «Границы» + в гайде «в моке реализована MC-колонка». DoD: негатив-тест одной Visa-карты отказа проходит с заявленной причиной, либо оговорка видна в обоих доках. | Нет |
| PB-03 | оба / env-парсинг | `services/yookassa-mock/server.js:73-78`, `services/atol-mock/server.js:117-118` | dx | minor | `MOCK_RETRY_MS`, `MOCK_PENDING_TTL_MS`, `MOCK_REFUND_DELAY_MS` (ЮKassa) и `MOCK_CALLBACK_RETRY_MS`, `MOCK_CALLBACK_MAX_ATTEMPTS` (АТОЛ) парсятся через `parseInt(x,10) || N` — та же ловушка из AGENTS.md §8 и A-10, ради которой в соседних строках atol введён `parseMs` (`atol server.js:109-114`). Эффекты: `MOCK_RETRY_MS=0` не выключает ретраи (мин. 1000 — семантика «0» не документирована); `MOCK_RETRY_MS=1h` молча даёт 1 с; `MOCK_PENDING_TTL_MS=500ms` → 500 без предупреждения. | Перевести все пять переменных на `parseMsOr`/`parseMs` с явной семантикой «0 валиден», зафиксировать поведение суффиксов/нуля в env-таблицах README; регресс в selftest («1h» → 3600000 или громкий отказ при старте). DoD: значения с суффиксами либо работают, либо отклоняются явно. | Нет; протокольные дефолты не менять |
| PB-04 | atol-mock / квоты | `services/atol-mock/server.js:188-191` (countAtolDocuments включает tokens), `:1522-1524` (getToken плодит токены без инвалидации), `:210-216` (чистка истёкших только при retention>0) | resilience | minor | В счётчик документов песочницы входят `tokens` и `externalIds`. Каждый `getToken` добавляет новый токен, не инвалидизируя прежние; истёкшие удаляются лениво (при использовании) или при `MOCK_SANDBOX_RETENTION_MS>0`. В owned-режиме цикл getToken (без продаж) выедает `MOCK_SANDBOX_MAX_DOCUMENTS` и блокирует регистрацию чеков кодом 4 «Лимит документов песочницы исчерпан». | Исключить `tokens` из `documentCounter` (считать только протокольные документы/externalIds/callbacks); регресс: 100×getToken не уменьшает доступную квоту чеков. DoD: после 100×getToken регистрация документа в owned-песочнице с малой квотой успешна. | Нет |
| PB-05 | оба / selftest-покрытие | `services/yookassa-mock/selftest.js` — нет hosted-блока (`MOCK_HOSTED` упомянут только в env-сбросе `:171`), нет тестов: `/sandboxes/me*` (`server.js:1494-1521`), CSRF `/admin/action` (`:1910-1917`), `POST /mock/state` импорт (`:1791-1821`), `GET /payment/{id}/done` (`:1894`), 413 (`:2065-2072`), ACK 201/204; `services/atol-mock/selftest.js` — нет: CSRF `/admin/action` (`:1469-1478`), `POST /mock/state` импорт (`:1397-1414`), 413 (`:1639-1643`), квоты документов (`:1598-1604`), `MOCK_VALIDATE_RECEIPTS=false` (`:1589`), негативов `measure`/`quantity≤0`/`name>128`/`correction_info.type`/`payments[].sum≤0` | dx | minor | Ядро-слои в обоих сервисах включены, но **не защищены регрессиями на уровне сервиса**: регрессия ядра может тихо сломать hosted-режим ЮKassa (самый дорогой пробел: у atol есть 20+ hosted-проверок `selftest.js:740-777`, у yookassa — ноль). Алиасы сценариев `kkt-fail`/`wait-forever`/`callback-duplicate` (`atol server.js:973-976`) работают (проверено `parseScenarioSpec`), но не описаны в README — таблица сценариев неполна. | Дополнить `selftest.js`: (1) yookassa — hosted-блок по образцу atol; (2) CSRF-негатив `/admin/action` в обоих; (3) импорт state с `__proto__` → 400; (4) 413; (5) atol — квота и `VALIDATE_RECEIPTS=false`; (6) дописать алиасы сценариев в README. DoD: каждая перечисленная ветка имеет ≥1 проверку; счётчики selftest растут без новых зависимостей. | Правило «без sleep»; часы ускорять через `/mock/time` |
| PB-06 | yookassa-mock / частичный capture | `services/yookassa-mock/server.js:990-992,1011-1023` (`payment.amount` не меняется; лимит возвратов = `capturedKopecks`) | protocol | info | Частичный capture: `amount` платёжного объекта остаётся авторизованным, `refunded_amount` считается от удержанного. В конспекте `01-payments-and-refunds.md` и README «Границах» поведение **не зафиксировано**; в официальном API ЮKassa `amount` после частичного capture равен удержанному (по общему знанию; из песочницы не сверить — `[VERIFY]`). Самотест фиксирует текущее поведение (`selftest.js:514-515`). | Зафиксировать в README «Границы» как форк/толерантность либо сверить с официальной докой и при расхождении завести протокольную задачу. В любом случае — пункт №32 манифеста §2b. | Сверка с первоисточником — вне песочницы |
| PB-07 | yookassa-mock / мёртвый маршрут | `services/yookassa-mock/server.js:1240-1246` (donePage: «return_url не задан — редиректа нет»), `:828-838` (return_url обязателен), `:1894-1898` | correctness | info | `GET /payment/{id}/done` недостижим из документированного флоу (return_url обязателен с создания; редирект всегда на `return_url`), а текст страницы противоречит валидации («return_url не задан»). Маршрут не покрыт selftest'ом. | Удалить маршрут или сделать честную страницу-заглушку; в selftest — тест либо строка в «Границах». DoD: поведение `/done` определено и протестировано. | Нет |
| PB-08 | yookassa-mock / 3DS-ветка | `services/yookassa-mock/server.js:1327` (`process3ds` может вернуть `stage:'form'` «Сессия 3DS не найдена»), `:1889-1891` (ветка не обрабатывается → 302) | correctness | info | Маршрут `/payment/{id}/3ds` трактует любой `stage!=='3ds'` как успех и шлёт 302 на `return_url`. Сейчас ветка `stage:'form'` недостижима (pending3ds существует, пока платёж pending), но контракт функции и маршрута расходятся: при будущих правках это станет тихим редиректом без финализации. | Обработать `stage:'form'` явно (рендер `formPage` с ошибкой) или сузить контракт `process3ds`; регресс «3DS без сессии». DoD: ветка либо удалена, либо протестирована. | Нет |
| PB-09 | atol-mock / формат отчёта | `services/atol-mock/server.js:919-937` (reportView добавляет `external_id`, `group_code`, `type`), `services/atol-mock/README.md:66`, `docs/reference/atol-online/01-api-v4-v5.md:47` | docs | info | Ответ `report` содержит эхо-поля `external_id/group_code/type`, которых нет в описании отчёта ни в README (таблица API), ни в конспекте (`uuid, status, error, payload`). Поле полезно для сверки callback↔report, но нигде не задекларировано как mock-расширение. | Описать эхо-поля в README как DX-расширение (или убрать из `reportView`, оставив в теле callback). DoD: README и конспект согласованы с фактическим ответом. | Нет |
| PB-10 | yookassa-mock / 415-гейт | `services/yookassa-mock/server.js:1953` (`if (isPost && contentType && …)` — пустой Content-Type пропускает 415), `:1957` (JSON-валидация тоже пропускается), `packages/core/index.js:258-270` (`parseBody` парсит как form) | protocol | minor | `POST /v3` **без заголовка Content-Type** обходит и 415, и валидацию JSON: тело парсится form-парсером ядра и уходит в бизнес-валидацию (проба: JSON без Content-Type → 400 «amount is required»; form-тело → 400; `text/plain` → 415). Сконструировать валидный платёж через form-encoding нельзя (объектные поля невыразимы — проверено), так что дежурит протокольная неточность: официальный API отклоняет не-JSON POST раньше. | Проверять Content-Type до ветвления: `isPost && !contentType.includes('application/json')` → 415 (включая пустой заголовок). DoD: пробы №1/№2 из §5 отвечают 415 пустым телом; selftest-кейс «POST без Content-Type». | Форк «415 без тела» (README:123) не меняется |

---

## 2a. Сверка маршрутов: маршрут мока → раздел доки → статус сверки → негатив-тест

Условия: ✅ — совпадает с конспектом/README; ⚠ — совпадает с оговоркой (ссылка на находку); N/A — проектный маршрут (вне протокола провайдера). «Негатив» — есть ли отрицательный тест в selftest сервиса.

### ЮKassa (`services/yookassa-mock/server.js`, 25 позиций)

| № | Метод + путь | файл:строка | Раздел истины | Сверка | Негатив-тест в selftest |
|---|---|---|---|---|---|
| 1 | GET /health | :1762 | N/A (проектный, общий для моков) | N/A | ✅ `health 200 ok` (:237) |
| 2 | GET /admin | :1900 | N/A (control-plane, F-07) | ✅ заголовки HTML — только здесь (дублирует §2.3) | ⚠ открытость без токена не тестируется (401 проверен только на `/admin/journal`, :756) |
| 3 | GET /admin/journal | :1772 | N/A; редакция F-09 | ✅ секреты/PAN не попадают (тест :696) | ✅ 401 без токена (:756) |
| 4 | POST /admin/action | :1910 | N/A; CSRF+same-origin | ✅ механика CSRF из ядра | ❌ CSRF-негатива нет (PB-05) |
| 5 | GET/POST/PUT /mock/state | :1791 | N/A; F-15, запрет `__proto__` | ✅ ядро валидирует снимок | ❌ POST/импорт сервисом не тестируется (PB-05) |
| 6 | GET/POST/PUT /mock/time | :1823 | N/A | ✅ тикает очередь и TTL | ✅ advance +7d (:678), сброс (:685) |
| 7 | GET/POST/DELETE /mock/scenarios | :1837 | N/A | ✅ | ✅ правило times:1, история, очистка (:656-665) |
| 8 | POST /mock/reset | :1782 | N/A | ✅ чистит только свою песочницу | ✅ (:718-719) |
| 9 | GET/POST/DELETE /sandboxes, /mock/sandboxes | :1775→:1432 | RFC-001 §6 | ✅ | ⚠ переключение/изоляция есть (:703-712); hosted-веток (ownerToken/409/429) **нет** (PB-05) |
| 10 | GET /sandboxes/me, POST …/reset, …/reset-creds, DELETE /sandboxes/me | :1494-1521 | RFC-001 §6 | ✅ | ❌ ни одного теста (PB-05) |
| 11 | GET /payment/{id} | :1857 | 03-testing.md (форма тестовых карт) | ✅ пресеты соответствуют (MC-колонка — PB-02) | ✅ (:379-385, 404 :385) |
| 12 | POST /payment/{id}/pay | :1865 | 03-testing.md | ✅ причины отказов; `party` — README:83-85 (конспект party-таблицу не фиксирует — `[VERIFY]`) | ✅ 302/отказы/форматные ошибки/просрочка (:388-466) |
| 13 | POST /payment/{id}/3ds | :1880 | 03-testing.md («код — произвольные цифры») | ⚠ ветка stage='form' не обрабатывается (PB-08) | ⚠ позитив есть (:419-423); «не цифры» — нет |
| 14 | GET /payment/{id}/done | :1894 | нет в reference | ⚠ недостижим, текст противоречит валидации (PB-07) | ❌ |
| 15 | POST /v3/payments | :1969→:780 | 01 §Платёжный поток п.1; interaction-format | ✅ amount decimal-строка/RUB; ⚠ confirmation обязателен (строже реального API — README «Границы»); capture default true (форк README:214) | ✅ 16 негативов (:252-318) |
| 16 | GET /v3/payments | :1970 | 01 п.5 | ⚠ без фильтров/пагинации, `next_cursor:null` — README:206 | ✅ (:368-371) |
| 17 | GET /v3/payments/{id} | :1986 | 01 п.5 | ✅ официальный текст 404 | ✅ (:359-366) |
| 18 | POST /v3/payments/{id}/capture | :1977→:993 | 01 п.3 | ✅ amount ≤ авторизованного; ⚠ частичный capture не меняет amount (PB-06) | ✅ over/no-key/число (:486-513) |
| 19 | POST /v3/payments/{id}/cancel | :1977→:1031 | 01 п.4 | ✅ merchant/canceled_by_merchant, только pending\|waiting | ✅ no-key (:523), статус-негативы |
| 20 | POST /v3/refunds | :1992→:1050 | 01 п.6 | ✅ только succeeded; amount ≤ refundable; валюта совпадает | ✅ 8 негативов (:545-583) |
| 21 | GET /v3/refunds | :1993 | 01 п.6 | ⚠ список без пагинации (README:206) | ✅ (:587-588) |
| 22 | GET /v3/refunds/{id} | :1999 | 01 п.6 | ✅ | ✅ 404 (:573-574) |
| 23 | 405 fallback /v3/payments\|refunds | :2006 | interaction-format (405 — пустое тело; README:123) | ✅ | ✅ PUT /v3/payments/{id} (:373) |
| 24 | 404 fallback /v3/* | :2011 | response-handling | ✅ provider-shaped JSON | ✅ (:317-318) |
| 25 | 415 POST /v3 (Content-Type) | :1953 | response-handling | ⚠ пустой Content-Type обходит (PB-10) | ✅ text/plain → 415 (:314); «без Content-Type» — нет |

### АТОЛ (`services/atol-mock/server.js`, 17 позиций)

| № | Метод + путь | файл:строка | Раздел истины | Сверка | Негатив-тест в selftest |
|---|---|---|---|---|---|
| 1 | GET /health | :1345 | N/A | ✅ api/ffd/groups/TTL | ✅ (:251-254) |
| 2 | GET /openapi.json | :1340 | docs/openapi/atol-mock.openapi.json | ✅ манифест+OpenAPI есть (в отличие от ЮKassa — §2.8) | ✅ (:257) |
| 3 | GET /admin | :1459 | N/A | ✅ заголовки (см. §2.3) | ⚠ консоль есть (:655); без токена — не проверен |
| 4 | POST /admin/action | :1469 | N/A; CSRF | ✅ | ❌ CSRF-негатива нет (PB-05) |
| 5 | GET /admin/journal | :1366 | N/A; F-09 | ✅ Token/пароль/e-mail не утекают (проба §5 №4 + тест :650-652) | ✅ 401 (:719) |
| 6 | GET/POST/DELETE /sandboxes, /mock/sandboxes | :1371→:1067 | RFC-001 §6 | ✅ | ✅ hosted-блок (:740-777): ownerToken, 401 по id, 14 на чужие креды; 409/429 не проверены |
| 7 | /sandboxes/me, …/reset, …/reset-creds, DELETE /sandboxes/me | :1134-1165 | RFC-001 §6 | ✅ | ⚠ hosted: владелец удаляет свою (:777); reset/reset-creds отдельных тестов нет |
| 8 | GET/POST/PUT /mock/state | :1391 | N/A; запрет `__proto__` | ✅ ядро валидирует | ⚠ GET есть (:673); POST/импорт — ❌ (PB-05) |
| 9 | GET/POST/PUT /mock/time | :1418 | N/A | ✅ печать очереди и TTL токена | ✅ +20s (:301), +25h (:826) |
| 10 | GET/POST/DELETE /mock/scenarios | :1436 | N/A | ✅ | ✅ (:624-639) |
| 11 | POST /mock/reset | :1378 | N/A | ✅ | ✅ (:676-677) |
| 12 | GET /receipts/{uuid} | :1494 | 01 §Получение результата (ofd_receipt_url); 02-testing | ✅ до печати объясняет статус; лента с ФД/ФП | ✅ (:296, :323); 404 неизвестного uuid — ❌ |
| 13 | POST /possystem/v4/getToken | :1510 | 01 §Авторизация | ✅ токен 24 ч, заголовок Token; 14 на неверные креды; HTTP 200 (README:126) | ✅ (:262-279) |
| 14 | POST /possystem/v4/{group}/{sell\|sell_refund\|sell_correction\|buy\|buy_refund\|buy_correction} | :1529→:944 | 01 §Регистрация документа, §Операции; 01 §НДС (vat22/vat122) | ✅ группы (:1556-1563), ФФД-реквизиты (:536-702), decimal-рубли; ⚠ дедуп external_id ломается на пробелах (PB-01) | ✅ все 6 операций + 20 негативов (:452-571); «пробелы в external_id» — ❌ (PB-01) |
| 15 | GET /possystem/v4/{group}/report/{uuid} | :1611 | 01 §Получение результата; 02-testing | ✅ wait\|done\|fail; error{code,text,type,error_id}; payload; чужая группа → 10; ⚠ эхо-поля не задекларированы (PB-09) | ✅ (:291-341, :561-565, :615-625) |
| 16 | 405 fallback /possystem/v4/* | :1631 | README:128 | ✅ | ✅ GET на регистрации (:567-568) |
| 17 | 404 fallback | :1637 | README:128 | ✅ | ✅ Ferma-маршрут /possystem/v1 (:570-571) |

**Покрытие таблицей: 42/42 маршрутов (100%).** Протокольные маршруты с негатив-тестами: ЮKassa 15/16, АТОЛ 13/14 (93–94%) — пробелы перечислены в PB-05 и строках с ❌/⚠.

---

## 2b. Проект `protocols/yookassa.json`: 50 инвариантов для дрейф-чекера

Это **проект, не реализация** (вход для MS-18/MS-37). Формат — по образцу `protocols/atol-online.json`: маршруты, коды, статусы, поля. «(Ф)» — документированный форк мока, который манифест должен фиксировать явно, чтобы `check:drift` ловил его регрессию; `[VERIFY]` — требует сверки с первоисточником.

**Транспорт и аутентификация**
1. Существуют ровно 8 /v3-маршрутов: `POST/GET /v3/payments`, `GET /v3/payments/{id}`, `POST /v3/payments/{id}/capture`, `/cancel`, `POST/GET /v3/refunds`, `GET /v3/refunds/{id}`; иных /v3-путей нет.
2. Все /v3 требуют `Basic base64(shopId:secretKey)`; отказ — 401 `invalid_credentials` + `WWW-Authenticate: Basic`.
3. POST /v3 без `Idempotence-Key` → 400, `parameter: Idempotence-Key`, текст `Idempotence key is missing. …`.
4. `Idempotence-Key` длиннее 64 символов → 400 `…too long…`.
5. Повтор ключа с тем же scope+raw-телом возвращает сохранённый ответ «как есть», бизнес не исполняется; помечается `X-Idempotence-Replayed: 1` (Ф).
6. Тот же ключ с другим телом/маршрутом → 400 `Idempotence key duplicated…`.
7. POST /v3 с Content-Type ≠ application/json → **415 с пустым телом** (Ф README:123) — включая отсутствующий заголовок (сейчас нарушено, PB-10).
8. Битый JSON в POST /v3 → 400 `Request body is not valid JSON`.
9. Известный /v3-ресурс с чужим методом → 405 пустое тело + `Allow: GET, POST` (Ф).
10. Неизвестный /v3-маршрут → 404 provider-shaped JSON.
11. HTTP-маппинг кодов: invalid_request→400, invalid_credentials→401, forbidden→403, not_found→404, too_many_requests→429, internal_server_error→500.
12. Тело ошибки: `{type:"error", id:<uuid>, code, description, parameter?}`; DX-поля `hint`/`doc` — вне протокола.

**Создание платежа (POST /v3/payments)**
13. `amount.value` — только decimal-строка: 1–9 цифр, ≤2 дробных знака, >0; JSON-число → 400.
14. `amount.currency` — только `"RUB"` (регистр значим).
15. `capture` — boolean; не передан → true (Ф: серверный дефолт ЮKassa не документирован).
16. `confirmation` обязателен, `type` только `"redirect"` (Ф-строгость), `return_url` обязателен, ≤2048 символов.
17. `description` — строка ≤128 байт UTF-8.
18. `metadata` — ≤16 ключей, ключ ≤32 символов, значение ≤512 байт, значения — строки/скаляры (не объекты).
19. `payment_token` / `payment_method_id` / `payment_method_data` взаимоисключающие (ровно один).
20. `payment_method_data.type` — только `bank_card`.
21. Ответ create: `status:"pending"`, `test:true`, `id` — UUID, `confirmation.confirmation_url = {base}/payment/{id}` (+`?sandbox=` вне default).
22. Ответ create не раскрывает внутренние поля (`kopecks`, `holdExpiresAtMs`, `pending3ds` и пр.).

**Машина статусов**
23. `pending → (форма, capture=true) → succeeded` (paid:true, refundable:true, captured_at).
24. `pending → (форма, capture=false) → waiting_for_capture` (paid:true, refundable:false, `expires_at`; TTL холда 7 дней по виртуальным часам).
25. `waiting_for_capture → capture → succeeded`; capture/cancel из иных статусов → 400 с описанием текущего статуса.
26. `waiting_for_capture → (TTL) → canceled {party:"yoo_money", reason:"expired_on_capture"}`.
27. `pending → (MOCK_PENDING_TTL_MS) → canceled {party:"yoo_money", reason:"expired_on_confirmation"}`.
28. `pending|waiting_for_capture → cancel → canceled {party:"merchant", reason:"canceled_by_merchant"}`; canceled терминален (paid:false, refundable:false).
29. Отказ карты на форме → `canceled` с `cancellation_details {party, reason}` по таблице declined (party-маппинг — `[VERIFY]`).
30. `succeeded`/`canceled` — терминальные; возвраты только из `succeeded`.

**Capture и возвраты**
31. capture amount > авторизованного → 400 (parameter: amount).
32. Частичный capture: succeeded, лимит возвратов = удержанная сумма; **amount объекта не меняется** (PB-06: сначала решить — форк или сверить).
33. Возврат по не-succeeded → 400; по неизвестному payment_id → 404 not_found.
34. Валюта возврата = валюте платежа; иначе 400.
35. Сумма возврата ≤ `captured − refunded`; нулевая → 400.
36. `refunded_amount` монотонно растёт; payment остаётся `succeeded` после возврата.
37. `refund_authorization_details.rrn` — 10–16 цифр; refund без `amount` → 400 «Field amount is required for a refund».

**Вебхуки**
38. События ровно: `payment.waiting_for_capture`, `payment.succeeded`, `payment.canceled`, `refund.succeeded` — по одному на каждый переход статуса.
39. Формат `{type:"notification", event, object}`; `object` = официальное «лицо» paymentView/refundView (без внутренних полей).
40. ACK — **ровно HTTP 200**; 201/204/304/4xx/5xx и таймаут → повтор (проба §5 №6).
41. Ретраи: `MOCK_RETRY_MS` × `MOCK_MAX_ATTEMPTS`, затем `dumped`; `webhook-drop|no-webhook` подавляют событие, `webhook-duplicate` кладёт ровно 2 копии.
42. Адрес приёмника: `MOCK_DEFAULT_WEBHOOK_URL` либо mock-расширение `metadata.webhook_url` (Ф).
43. Подписи вебхука нет — ядро не должно требовать `verifyMerchantWebhook` для yookassa (согласовано с README:211-213).

**Форма и тестовые карты**
44. Пресеты карт: 5 карт успеха (2 с 3DS-challenge «любые ≥4 цифры») + таблица отказов с честными `cancellation_details` (PB-02: зафиксировать реализованную колонку или дополнить Visa/МИР).
45. Неизвестная Luhn-валидная карта → `general_decline`; невалидная → `invalid_card_number`; истёкший срок → `card_expired`; форматные ошибки формы оставляют платёж `pending`.
46. `payment_method` хранит только first6/last4/expiry/card_type/title; полный PAN не попадает в state и журнал (F-10).

**Состояние, квоты, журнал**
47. Идемпотентность переживает рестарт (`MOCK_STATE_FILE`), FIFO-вытеснение на 1000 записей; ответы ≥500 не фиксируются (повтор доступен).
48. Квота документов песочницы = payments+refunds+notifications; исчерпание → 400 с DX-подсказкой.
49. Виртуальные часы управляют TTL холда/pending/финализацией возвратов; `POST /mock/time` тикает очередь вебхуков.
50. Журнал /v3 — с редакцией секретов (F-09): не-allowlist заголовки (включая `Authorization`, `Idempotence-Key`) отбрасываются, raw-тело через `redactRawBody` (проба §5 №4).

---

## 3. Покрытие области (честно)

**Прочитано полностью, построчно:**
- `services/yookassa-mock/server.js` — все 2115 строк; диапазоны в scope не пропускались.
- `services/atol-mock/server.js` — все 1672 строки.
- `services/yookassa-mock/README.md` (220 строк) и `services/atol-mock/README.md` (239) — целиком, включая «Границы».
- `docs/integration/yookassa.md` (131) и `docs/integration/atol.md` (198) — целиком.
- Все 5 конспектов `docs/reference/yookassa/**` и `docs/reference/atol-online/**` — целиком.

**Проверено выборочно (честные ограничения):**
- `selftest.js` обоих сервисов: все блоки бизнес-сценариев и негативов просмотрены через перечень `check()`/`checkError()` с адресацией по строкам (структура подтверждена чтением блоков 240–822 и 251–854); декларации/хелперы (yookassa 1–216, atol 1–250) — бегло, не построчно. Счётчики «227/202» не перепроверялись прогоном (инструкция «не запускать полный npm test»); взяты из baseline координатора.
- `packages/core/index.js` — только зоны, через которые оба адаптера реально вызывают ядро (таблица в шапке). Ядро целиком — партия A.
- `docker-compose*.yml`, `Dockerfile`, CI, `scripts/check-protocol-drift.js` — вне области (C/D); вывод «ЮKassa не покрыт check:drift» взят из §2.8 AUDIT-PREP и подтверждён отсутствием `protocols/yookassa.json` в дереве.
- Конспекты не сверялись с первоисточниками провайдеров (yookassa.ru, help.atol.online) — сеть/актуальность вне песочницы (партия E); такие пункты помечены `[VERIFY]`.

**Воспроизведения (команда → вывод):** §5. Все listener'ы — `127.0.0.1:0`; порты 3100–3103 не использовались; после проб процессы завершены.

---

## 4. Дубли / уже поставленное (новым ID не заводились)

| Уже поставлено | Связь с партией B |
|---|---|
| §2.3 `security-headers-partial` (medium) | Подтверждено в обоих сиротах: заголовки `X-Frame-Options/Referrer-Policy/CSP` только на `/admin` (yookassa `server.js:1900-1908`, atol `:1459-1467`); страницы `/payment/*` (yookassa) и `/receipts/*` (atol) отдаются через `core html()` (`packages/core/index.js:284-286`) без заголовков. `X-Content-Type-Options` отсутствует во всём репо (контекст координатора). |
| §2.8 `openapi-drift-yookassa` (medium) | Подтверждено: `protocols/yookassa.json` в дереве нет, `/openapi.json` в `services/yookassa-mock/server.js` нет; root `README.md:23` («OpenAPI 3.1 (/openapi.json)») против `services/yookassa-mock/README.md:209`. Проект инвариантов — §2b. |
| §2.6 `env-doc-drift` (low) | Частный случай подтверждён: `MOCK_SANDBOX_FILE` читается yookassa (`server.js:158`) и atol (`:94`), есть в README tbank/kassa, но отсутствует в env-таблицах yookassa/atol. Полная матрица env — партия D. |
| MS-09 (SSRF/`isPrivateAddress`) | Здесь не проверялся — ядро (партия A); оба сироты потребляют гард через `createDeliveryQueue({blockPrivateHosts})`. |
| §6.6 флак `test:yookassa` | Полный `npm test` не запускался по инструкции партии; подозреваемые тесты (`selftest.js:607,646`) — тайминговые, а не протокольные. Стабильность — зона партии A. |
| F-07/F-09/F-10/F-11/F-12/F-15 | Не дубли, а **подтверждение работы** слоёв в обоих адаптерах: контроль доступа (пробы 401), редакция журнала (проба: Token/пароль/e-mail отсутствуют), минимизация PAN (selftest:407), admission/изоляция (selftest), квоты (код; пробел в тестах — PB-04/PB-05). |

---

## 5. Прогоны

| # | Команда/проба | Результат | Вывод |
|---|---|---|---|
| 1 | `git rev-parse --short HEAD && node -p "require('./package.json').version" && git status --porcelain` | `05696f3`, `0.5.0`, чисто | база зафиксирована |
| 2 | `node -e` — граничные случаи `rublesToKopecks` (atol) | `'10.005'→null`, `0.1→10`, `4.1→410`, `'100000000000.00'→null`, `''/-5/null→null`, `0→0` | decimal-хелпер устойчив; цена 0 отбрасывается валидатором |
| 3 | `node -e` — Luhn по 22 PAN отказов Visa/МИР из конспекта | все Luhn-валидны → мок отдаст `general_decline` | подтверждение PB-02 |
| 4 | живая проба atol (listener 127.0.0.1:41781): два идентичных `sell` с `external_id=" ws-1 "` + один с `"ws-1"`; затем `GET /admin/journal` | 3 разных uuid, `X-Mock-Replayed` отсутствует; Token/пароль/e-mail в журнале не утекают | подтверждение PB-01; F-09 работает |
| 5 | `node -e` — `parseScenarioSpec('kkt-fail,wait-forever,no-callback,callback-duplicate,…')` | все алиасы распознаются ядром | алиасы atol живые, но не описаны в README (PB-05) |
| 6 | живая проба yookassa ACK: приёмники 200/201/204/304 | 200 → `done` за 1 попытку; 201/204/304 → `failed, retry in 1000ms` | ACK ровно 200 — соответствует `docs/reference/yookassa/02-webhooks.md:12` |
| 7 | живая проба гонок: 40 параллельных POST с одним `Idempotence-Key`; 40 sell с одним `external_id` | создан 1 платёж; 1 документ | гонки идемпотентности не воспроизводятся (критические секции атомарны) |
| 8 | живая проба Content-Type: POST /v3/payments без Content-Type (JSON и form), с `text/plain` | без Content-Type → 400 через form-parse (мимо 415); `text/plain` → 415 | подтверждение PB-10 |
| 9 | `npm test` | **не запускался** (инструкция партии; зелёная база зафиксирована координатором) | — |

После всех проб процессы завершены; `git status` не изменился (создан только этот отчёт).

---

## 6. Критерии приёмки партии (AUDIT-PREP §4.B) — чек-лист

- [x] **Таблица «маршрут мока → раздел доки → статус сверки» покрывает все маршруты обоих сервисов** — ✅ §2a: 25 (ЮKassa) + 17 (АТОЛ) = 42/42, включая fallback'и 404/405/415 и `/openapi.json`.
- [x] **Для каждого маршрута указано, есть ли негатив-тест** — ✅ §2a, колонка «Негатив-тест в selftest»; пробелы собраны в PB-05.
- [x] **Находки формата реестра** (ID · модуль · файл:строка · категория · severity · суть · задача · зависимости) — ✅ §2: PB-01…PB-10, без дублей §2.3/§2.8/§2.6 (см. §4).
- [x] **Список инвариантов для `protocols/yookassa.json` (проект, не реализация)** — ✅ §2b: 50 инвариантов с пометками (Ф) и `[VERIFY]`; реализация не выполнялась.
- [x] **Гонки идемпотентности проанализированы** — ✅ анализ кода (нет `await` между проверкой и записью; обработчики синхронны) + проба №7 (40 параллельных → 1 объект). Реальная проблема идемпотентности — не гонка, а несимметричный `trim` (PB-01).
- [x] **ACK вебхуков проверен** — ✅ ЮKassa ровно 200 (проба №6), АТОЛ любой 2xx (код + README, форк задокументирован), ненормальный ACK → ретраи → `dumped`.
- [x] **Защитные слои сирот сопоставлены с tbank/kassa** — ✅ §1/§4: контроль доступа, редакция, песочницы, CSRF, SSRF-guard присутствуют и подтверждены пробами; пробел — только в selftest-покрытии hosted (PB-05).
- [x] **Каждая security-утверждённая находка имеет воспроизведение** — ✅ PB-01 (проба №4), PB-10 (проба №8); остальные находки — docs/dx и сетевых доказательств не требуют.
- [x] **Режим только чтение соблюдён** — ✅ единственный созданный файл — этот отчёт; код/тесты/compose/CI/манифесты не менялись.

---

## 7. Что осталось непроверенным (для владельца)

1. Сверка party/reason-маппинга declined-платежей и поведения частичного capture с официальной документацией ЮKassa — вне песочницы (`[VERIFY]`, PB-06).
2. Таблица числовых кодов ошибок АТОЛ v4 против PDF API v4 5.15 — задолженность зафиксирована в `atol-mock/README.md:219-224`; сверка — партия E/владелец.
3. Стабильность `test:yookassa` (20 прогонов подряд) — зона партии A (§6.6 AUDIT-PREP).
4. Поведение под Node 18/20 (CI-matrix) не проверялось — прогоны партии выполнены на Node v24.21.0.
