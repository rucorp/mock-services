© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# SZ-отчёт: независимый аудит alfa-mock — AUDIT-SZ-ALFA-2026-10-12

> **База:** main @ `7d7f7e7` (клон свежий, 41 коммит; альфа-адаптер вошёл в `9d2ee4b`/#47, SSRF-фикс ядра — `d957b2f`/#46, отчёты партий A–F — `7d7f7e7`/#49). Аддендум §7 (post-#55): ре-проверка на main @ `f89f76f` (дельта 9d2ee4b..f89f76f — docs-only, код тождественен).
> **Режим:** только чтение; создан только этот отчёт. Пробы — живые listener'ы исключительно `127.0.0.1:0`; параллельно задаче #54 (пересечения сведены в §4).
> **Ответ на ключевой вопрос #54 (п.1): PA-50 в альфа-адаптере РАСТИРАЖИРОВАН и подтверждён живыми пробами — чтение, сброс и перезапись чужой песочницы владельцем другой (PG-03, §2).** Реплики PA-51 (PG-04) тоже подтверждены. PF-01 и PE-01 в альфе НЕ растиражированы (§2a).
> **Аддендум (§7): §7.2 TTL-рейс Arena воспроизведён на альфе (PG-10, без явных-target маршрутов); §7.3 DNS TOCTOU доставлен live через альфа-delivery при включённом гарде (PG-11); с §7.4 полной согласованность с PG-03; для #56 профилактика отрицательная — альфа-selftest не содержит флакогенного окна.

## §1. Итог

| sev | count | ID |
|---|---|---|
| blocker | 1 | PG-03 (репликация PA-50) |
| major | 2 | PG-01, PG-04 |
| minor | 3 | PG-02, PG-05, PG-06 |
| info | 3 | PG-07, PG-08, PG-09 |
| **всего** | **9** | серия PG (новая, партия G = «второй внешний банк-адаптер»); **+ аддендум §7: PG-10, PG-11 → всего 11** |

Сводка: новый адаптер протокольно аккуратен (uuid orderId, строгий money-парсер, PAN только маской, checksum по конспекту, ACK=200, OpenAPI есть и сверяется, форки задокументированы — лучше среднего по стенду). Все находки уровня «перенос паттернов»: tenant-isolation и DX-долг ядра/старых сервисов воспроизведены в новом коде, плюс одна новая утечка (PG-01). Baseline прогоны на `7d7f7e7`: npm test зелёный — core 48 · tbank PASSED · kassa 141 · yookassa 227 · atol 202 · **alfa 287** · upstream 11 · links 69 · drift 316/316 (совпадает с baseline владельца).

## §2. Реестр находок

| ID | sev | суть | файл:строка | доказательство |
|---|---|---|---|---|
| **PG-01** | **major** | Утечка кредов в hint ошибки errorCode=2: hint интерполирует **фактические** `USER_NAME_CRED`/`PASSWORD_CRED` (не только дефолты) — неаутентифицированный вызыватель получает кастомные userName+password по сети. При env-кредах это полный обход авторизации всех `/payment/rest` (register/deposit/refund). В owned-режиме per-sandbox креды НЕ утекают (hint использует stand-уровень) — смягчение, но self-hosted с кастомными кредами скомпрометирован полностью | `services/alfa-mock/server.js:443-452` | Проба P1: register.do с неверным паролем → `"hint":"…Дефолты мока — синтетические (customuser/CUSTOM-SECRET-2026 …)"` — пароль из env в ответе |
| **PG-02** | **minor** | Стартовый лог печатает **фактические** креды (userName/password/callback_secret) безусловно, при любых env; README:37-38 обещает печать «синтетических». Требует доступа к хосту/логам, поэтому minor — но в контейнере пароль уходит в docker logs навсегда | `services/alfa-mock/server.js:2042` vs `services/alfa-mock/README.md:37-38` | Проба P1b: `creds: userName=customuser password=CUSTOM-SECRET-2026 …` в логе при кастомных env |
| **PG-03** | **blocker** | **Репликация PA-50 в альфа-адаптере**: явный target без авторизации target'а — POST /mock/reset (`body.sandbox`), GET /mock/state (`?sandbox=`), POST/PUT /mock/state (`body.sandbox` → importState). Admission авторизует только выбранную (свою) песочницу; хендлеры берут target из query/body напрямую. Владелец A читает/уничтожает/перезаписывает B. Чинить той же задачей, что PA-50 (гард target в ядре или единая обёртка), иначе фикс PA-50 оставит пятый адаптер дырявым | `services/alfa-mock/server.js:1757-1768, 1771-1775, 1786-1790`; родитель: PA-50 (core:2299-2339) | Пробы P2a (чтение state B → 200 + заказы B), P2b (reset B владельцем A → заказы B уничтожены), P2c (import в B → crafted-заказ появился, заказ B2 стёрт) |
| **PG-04** | **major** | **Репликация PA-51 в альфа-адаптере**: реестр сценариев один на процесс — правило арендатора A (POST /mock/scenarios) срабатывает на трафике B (register → errorCode 6); orderId песочницы B попадает в историю, читаемую A (через контекст pay/3ds — core `recordTrigger` разливает `context.orderId`). Плюс наследованные свойства: rules без cap, DELETE /mock/scenarios глобален | `services/alfa-mock/server.js:265, 1357-1365, 1816-1832`; родитель: PA-51 (core:1419-1522) | Пробы P3 (register B3 → errorCode 6 от правила A) и P3c (`"history":[{"scenario":"webhook-drop","source":"rule:sc-1","target":"pay","orderId":"<orderId B>"}]`) |
| **PG-05** | **minor** | env-парсинг мимо каноничных парсеров: `MOCK_CALLBACK_RETRY_MS`/`MOCK_CALLBACK_MAX_ATTEMPTS` — `Math.max(1000, parseInt(x,10) \|\| 10000)` (запрещённый AGENTS §8 паттерн, класс MS-08/PB-03/PF-03); `MOCK_SESSION_TIMEOUT_SECS` — свой Number-чек. Тихие fallback: `'1h'` → **1000 мс** (parseInt съедает 'h', Math.max тянет к 1000 — тихое сокращение в 10×), `'0'` → 1200 с. Заменить на `parseMsOr` с семантикой «0 валиден» + таблица-тест, единым остатком MS-08 | `services/alfa-mock/server.js:143-149` | Проба P5: стартовый лог `retry 1000ms` при env `MOCK_CALLBACK_RETRY_MS='1h'`; `session_timeout=1200s` при `'0'` |
| **PG-06** | **minor** | env-док-дрифт альфы (правило пяти мест AGENTS §5): `MOCK_SANDBOX_RETENTION_MS` и `MOCK_SANDBOX_CREATE_LIMIT` документированы в README альфы, но отсутствуют в docker-compose.include.yml (не настроить через include; наследует §2.6); `MOCK_SANDBOX_FILE` читается (`:232`), нигде не документирован; SECURITY.md в дельте #47 не менялся — альфа-env, влияющие на модель угроз (`MOCK_BLOCK_PRIVATE_WEBHOOKS`, `MOCK_ALFA_*`), в SECURITY.md не отражены | `services/alfa-mock/README.md:177-178` vs `docker-compose.include.yml:228-277`; `server.js:118,171,232` | grep: RETENTION_MS/CREATE_LIMIT отсутствуют во всём include; `git diff 05696f3..7d7f7e7 -- SECURITY.md` пуст |
| **PG-07** | **info** | SSRF-блокированные callback переживают полный ретрай-цикл (24×10 с) вместо терминального статуса: блок политики — не отличие от сетевого сбоя, запись крутится в очереди до исчерпания attempts (шум в логах, лишние тики). Предложение: помечать `blockPrivateHosts`-отказ терминальным маркером | `services/alfa-mock/server.js:496-524` + ядро очереди | Проба P6: `webhook 1000001 error: …SSRF…, retry in 10000ms` — повтор каждые 10 с |
| **PG-08** | **info** | Security-заголовки (X-Frame-Options/Referrer-Policy/CSP) только на /admin; платёжная форма/ACS/статус отдаются через ядро `html()` без заголовков — тестовую форму можно iframe'ить (clickjacking «Оплатить»). Класс §2.3 аудита-препа | `services/alfa-mock/server.js:1837-1844` vs `packages/core/index.js` (`html()`) | Инспекция; негативного влияния на протокол нет |
| **PG-09** | **info** | POST /mock/reset стирает глобально: правила и историю сценариев всех арендаторов + общий журнал (`scenarios.clearRules/clearHistory`, `journal.clear()`). Усилитель PG-03 (сброс своей песочницы — сам по себе кросс-тенантный жест) и отдельная развилка «scope сброса» | `services/alfa-mock/server.js:1765-1767` | Инспекция кода; в owned-режиме ownerSurface достаточно для вызова |

## §2a. Ответы на вопросы #54 (по альфа-части)

1. **PA-50 растиражирован в альфа-адаптере? ДА** — треугольник чтение/сброс/перезапись воспроизведён живыми пробами (PG-03). Точка входа из рекомендации подтверждена: гард target вне `admit` отсутствует, `?sandbox=B` при своём `X-Mock-Sandbox: A` работает на всех трёх маршрутах `/mock/reset`, `/mock/state` (GET/POST).
2. **PA-51 тоже растиражирован** (PG-04): правило + orderId-утечка в истории — обе пробы зелёные.
3. **PF-01 в альфе НЕ растиражирован**: дефолт `MOCK_BLOCK_PRIVATE_WEBHOOKS=''` + `flagEnabled(…, HOSTED)` (server.js:106,160) — правильный контраст с кассой. Проба P6 в MOCK_HOSTED=1: `block_private_webhooks=true`, callback на `127.0.0.1` и на mapped-IPv6 `http://[::ffff:127.0.0.1]:…` → **SSRF_BLOCKED, 0 доставок** (заодно подтверждён фикс #46 на альфа-поверхности).
4. **PE-01 в альфе НЕ растиражирован**: цикл по `errorCodes` для альфы в drift-чекере есть (`scripts/check-protocol-drift.js:263`); мёртвых кодов в манифесте нет (0…6 все эмитятся). OpenAPI существует и сверяется чекером (закрывает для альфы класс §2.8).

## §3. Покрытие

- `services/alfa-mock/server.js` — **2058 строк, прочитаны полностью** (4 прохода: креды/очередь; заказы/переходы; форма/3DS; sandboxes/admin/маршруты/HTTP).
- `services/alfa-mock/selftest.js` (1055 строк) — структура + все 174 check-кейса; `README.md` (277) — полностью; `protocols/alfa-eacq.json` (185) — полностью.
- Сопряжённо: `docker-compose.include.yml` (блок альфы 228-277), `docker-compose.yml` (блок альфы), `.github/workflows/ci.yml` (3 точки альфы), `scripts/check-protocol-drift.js` (альфа-секция), `docs/integration/alfa.md` (checksum-раздел), `docs/openapi/alfa-mock.openapi.json` (paths), ядро точечно: `admit`/`selector`/`ownerTokenOf`/`summarizeBody`/`history`/SSRF-фикс `d957b2f`.
- Дельта ядра #46 прочитана (mapped/NAT64/hex-имена закрыты, +6 регрессов) — на альфа-поверхности подтверждена пробой P6.

## §4. Дубли (без новых ID)

| Дубль | Где у альфы | Примечание |
|---|---|---|
| PA-01 (core) | parseBody в route → битый `%zz` → HTTP 500 | Проба P4: 500 «Внутренняя ошибка» вместо 400; чинится PA-01 |
| PA-52 (core) | `sandboxRuntime.tickAll` без await, `:783` | Наследуется ядром; фикс в PA-52 |
| PD-02 (core) | persist-амплификация: двойной `persist()` в finalizeSuccess (`:685/692` + `:696`) на каждую мутацию | Инстанс класса writeFileSync-реестра |
| PD-01 | root `docker-compose.yml` альфа-блок: комментарий «Для публичного размещения включите защиту… `MOCK_BLOCK_PRIVATE_WEBHOOKS: "1"`» при нетранзитивных env; `MOCK_HOSTED=1` молча игнорируется | Расширение поверхности PD-01, чинится той же задачей |
| §2.6 env-doc-drift | include без RETENTION_MS/CREATE_LIMIT — общий для всех сервисов | Альфа-специфика выделена в PG-06 (по прецеденту PD-06) |
| MS-06 | `admin_token`/`sandbox_token` в query URL админки (`:1537-1542, 1860-1863`) | Закреплено тестами, меняет волна MS-06 |
| MS-13 | нет RPS/egress-квот на /payment/rest | Наследуется |
| PC-01 | альфа-инварианты drift-чекера тоже подстрокой (`:232,246,252`) | Чинится PC-01 (чекер единый) |
| §1.1 | include альфы: мутабельный тег `0.5.0` + digest-пин | Наследуется MS-01-классом |

## §5. Прогоны

| # | что | результат |
|---|---|---|
| 1 | `npm test` на 7d7f7e7 | зелёный: core 48 · tbank PASSED · kassa 141 · yookassa 227 · atol 202 · alfa 287 · upstream 11 · links 69 · drift 316/316 |
| 2 | `npm run test:compose` локально | красный ECONNREFUSED :3100 — ожидаемо без Docker (вне `npm test`, PC-04); секция альфы :3104 в списке присутствует |
| 3 | Пробы P1/P1b (креды) | PG-01, PG-02 подтверждены (скрипт сохранён у координатора) |
| 4 | Пробы P2a/P2b/P2c (owned, 2 песочницы) | PG-03 подтверждён: чтение → 200; reset → уничтожение; import → подмена |
| 5 | Пробы P3/P3c (сценарии) | PG-04 подтверждён: правило A на B + orderId B в истории A |
| 6 | Проба P4 (%-энкод) | PA-01 инстанс: HTTP 500 |
| 7 | Проба P5 (env) | PG-05 подтверждён: `'1h'`→1000 мс, `'0'`→1200 с |
| 8 | Проба P6 (hosted SSRF) | PF-01 не растиражирован; фикс #46 работает; fail-closed /mock/* в hosted (401 без токена) |
| 9 | Проба P7 (журнал) | редакция ядра работает: `password:"[REDACTED]"`, PAN отсутствует |
| 10 | Проба P8 (§7.2-аддендум): TTL-рейс на альфе, f89f76f | PG-10 подтверждён: контроль `errorCode:3`, с задержкой 2500>TTL 500 — HTTP 200 + канарейка жертвы; скрипт `tool-results/alfa-ttl-race.js` |
| 11 | Проба P9 (§7.3-аддендум): DNS TOCTOU на альфа-delivery, f89f76f | PG-11 подтверждён: доставка на 127.0.0.1 при `blockPrivateHosts:true` (guard 1 lookup, connect 1 lookup); контроль прямой loopback → `ERR SSRF_BLOCKED`; скрипт `tool-results/alfa-dns-toctou.js` |
| 12 | Превентива #56 (§7.5) | альфа-selftest :463-464 ждёт `done` через waitForCondition(8 с) — окна yookassa :410→:412 нет; отрицательный результат |

## §6. Чек-боксы приёмки

- [x] Область (#41 Stage 2: альфа-адаптер) прочитана полностью, файл:строка у каждой находки
- [x] Все security-утверждения подтверждены живыми пробами на `127.0.0.1:0`, а не осмотром диффа
- [x] Пересечения с #54 размечены (§2a, §4); новые ID только в серии PG, существующие серии не переиспользуются
- [x] `npm test` на базе зелёный; код/тесты/compose/CI не менялись — создан только этот отчёт
- [ ] Свести PG-03/PG-04 с задачей PA-50/PA-51 P0-волны (#50/#52) — решение владельца
- [x] Аддендум §7 (post-#55): пробы P8/P9 на f89f76f, read-only; дельта коммита docs-only (проверено `git diff --stat 9d2ee4b..f89f76f`)
- [ ] Включить PG-10 в DoD PA-50 (тест §7.2 «fail-closed mid-await») и PG-11 в DoD PA-25/MS-09 — решение владельца

## §7. Аддендум post-#55: кросс-чек ре-базированной партии A на альфа-поверхности (f89f76f)

База аддендума: main @ `f89f76f` (PR #55). Дельта `9d2ee4b..f89f76f` — только docs/audit (10 файлов), исполняемый код тождественен базе исходного отчёта — обе пробы валидны для кодовой базы. Прочитан ре-базированный `AUDIT-PARTY-A-2026-10-12.md` §7.1–7.5 полностью. Новые ID продолжают серию PG; дубликатов со схемами Arena нет.

### §7.1. Сверка с §7.4 Arena (PA-50 в альфе) — полная согласованность

HTTP-проба Arena на альфе (victim-b: чтение `GET /mock/state?sandbox=`, перезапись `POST /mock/state`, сброс `POST /mock/reset`) независимо подтверждает мой PG-03 (пробы P2a/P2b/P2c на 7d7f7e7): те же маршруты (`server.js:1757-1790`), тот же результат, включая семантику `current` в ответе reset. Расхождений нет. Дополнительный процент-энкод вариант PA-02 (`pass%77ord`) Arena подтвердила на альфе без нового ID — согласуется с моей P7 (декодированное поле маскируется в `summarizeBody`, rawBody открыт); учтено, в дубли не выношу (см. §4, строка PA-02 отсутствует — вариант закрыт родителем).

### §7.2 → PG-10 (класс PA-50, blocker): TTL-sweep-рейс §7.2 воспроизведён на ПЯТОМ адаптере

Arena гоняла §7.2 на T-Bank + ALS-harness ядра; в альфе до этого аддендума рейс не воспроизводился. Воспроизведён живой пробой P8 (`tool-results/alfa-ttl-race.js`, Mock HOSTED=1, owned, TTL=500 мс, sweep=1000 мс):

- жертва: persisted-registry `activeId=alfa-victim` (`expiresAt:0` — sweep пропускает falsy, core:2426-2427), в state канарейка-заказ; гость `race-ghost` создан PA-50-маршрутом `/mock/reset` владельцем A (`body.sandbox`, запись без owner-token — `ghostOwnerTokenHash:null`);
- **контроль** (тот же запрос без задержки, гость жив): `errorCode:3` «Заказ не найден» — изоляция цела, канарейки нет;
- **рейс** (`POST /payment/rest/getOrderStatus.do`, `x-mock-latency:2500` > TTL): `HTTP 200, errorCode:0` с канарейкой жертвы (`orderId alfa-race-victim-order`, `orderStatus:2`, `amount:123456`); гость удалён sweep'ом mid-await, `activeId` остался `alfa-victim`.

Механика ядра та же, что в §7.2: `run()` держит запись в ALS (core:2291-2294; альфа-обёртка `server.js:1658-1660`), sweep удаляет её из Map (core:2422-2444; альфа-таймер `:790-795`), `currentRecord()` фолбэчит на `sandboxes.get(activeId)` (core:2192-2195), фасад `state` (альфа: `:245`) читает чужую запись в `resolveOrder` (`:619`). Специфика альфы против T-Bank: задержка `applyRequestChaos` (:1710) применяется **до** бизнес-диспетча, поэтому после фолбэка пересчитываются и `verifyCreds` (`alfaUserName() = creds().userName || …`, `:255-256`), и `resolveOrder` — чтение чужого state происходит при дефолтных кредах жертвы.

Граница (по Arena, §7.2, воспроизведена): жертва с per-sandbox кредами отклонит запрос по errorCode=2 — утечка через рейс требует отсутствия кастомных кредов у жертвы (persisted/namespace-записи) либо знания их; per-sandbox креды через hint (PG-01) не утекают.

**Нового самостоятельного DoD не создаёт — чинить одной задачей с PA-50/PG-03; в DoD владельца добавить тест §7.2 «истечение/удаление admission-записи mid-await → fail-closed, без фолбэка на другой tenant» и прогнать его на всех пяти адаптерах.**

### §7.3 → PG-11 (класс PA-25/MS-09, minor): DNS TOCTOU доставлен live через альфа-delivery при включённом гарде

Arena воспроизвела §7.3 на harness'е ядра; здесь — на живом пайплайне альфы (проба P9, `tool-results/alfa-dns-toctou.js`): MOCK_HOSTED=1 → `blockPrivateHosts:true` (`server.js:160,505`), callback через `core.createDeliveryQueue` (`:496-521`) → core `postJson` (781-788):

- фаза TOCTOU (подмена resolver'а в одном процессе): `guardLookups:1 → 93.184.216.34 (allowed)`, `connectLookups:1 → 127.0.0.1`, **webhook доставлен на локальный фикстур** (`fixtureHits:1`, запись `done:true, attempts:1`; лог сервера: `webhook 1 delivered → http://rebind.audit.test:41327/hook?…`);
- **контроль** (честный DNS, прямой `http://127.0.0.1:…` в `callback_url`): `ERR SSRF_BLOCKED`, запись `done:false` (и дальше ретраится — согласуется с PG-07).

То есть §7.3 наследуется альфа-delivery end-to-end: гард включён и честные литералы блокирует, но TOCTOU между `assertPublicHost` и `http.request` доставляет на приватный адрес. Корень и фикс — в ядре (одна резолюция / пиннинг результата гарда на соединение), отдельной альфа-работы не требует; включить PG-11-пробу в DoD PA-25/MS-09 как регресс-пример пятого адаптера.

### §7.4. Профилактика по §7.5/#56 — отрицательная

Флак yookassa (`selftest.js:412` «уведомление done после ACK 200») эксплуатирует окно «HTTP-хит фикстурой увиден (wait :410) → assert done (:412) без ожидания done». В альфа-selftest аналог (`:463-464`) устроен иначе: `waitForCondition(() => cbEntry1.done === true, 'ACK 200 -> done')` (8 с) — assert проверяет `done && attempts===1` **после** ожидания самого `done`. Окна нет; падение возможно только при реальной недоставке (другой класс отказа). Для #56 по альфе действий не требуется.

### §7.5. Регистр аддендума

| ID | sev | суть | файл:строка | доказательство |
|---|---|---|---|---|
| **PG-10** | **blocker (класс PA-50)** | TTL-sweep-рейс §7.2 на альфе: межарендаторское чтение state БЕЗ явных-target маршрутов — TTL-истечение гостя mid-await, фолбэк `currentRecord()` на `activeId` жертвы, чтение чужих заказов в `resolveOrder`. Расширяет PG-03 (там — явный target) | core:2192-2195, 2422-2444, 2291-2294; альфа: `server.js:1658-1660, 245, 619, 790-795` | Проба P8: контроль `errorCode:3` → рейс `errorCode:0` + канарейка жертвы; скрипт `tool-results/alfa-ttl-race.js` |
| **PG-11** | **minor (класс PA-25/MS-09)** | DNS TOCTOU §7.3 на живой альфа-delivery: двухшаговая резолюция (гард → соединение), доставка на приватный адрес при `blockPrivateHosts:true`. Корень и фикс — ядро; альфа-проба — регресс-пример | core:781-788, 984-1016; альфа: `server.js:160, 496-521 (505)` | Проба P9: доставка `done:true` при подмене DNS; контроль `ERR SSRF_BLOCKED`; скрипт `tool-results/alfa-dns-toctou.js` |
