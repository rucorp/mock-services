# Полный набор проверок SZ — verification suite (2026-10-13)

База: main `7471db5` (волны #52/#53/#60 смержены: squash #71/#72/#77; статусы #52 — PR #73). Автор: SZ (независимый параллельный рецензент, read-only по коду; артефакты — только через PR в `docs/audit/**`).

---

## 0. Зачем этот документ (ответ на «провести полный аудит ещё раз?»)

Повторный полный аудит **не требуется и нецелесообразен**:

1. **Все 109 позиций задокументированы с рефами**: 90 дельты (§1 консолидированного отчёта, партии A–F) + 8 новых (§2: PB-11…14, PC-17, PD-12, PE-19, PF-06) + 11 серии PG (AUDIT-SZ-ALFA §1/§7). Отчёты приняты владельцем (`6d13b81`).
2. **Волновая верификация с предрегистрацией сильнее повторного аудита**: ожидания «после фикса» зафиксированы **до** фиксов (README alfa-probes + prereg-бандл #64), пробы дифференцирующие («до»-контроль на дефектной ревизии сохраняет доказательную силу), правило статуса — только по воспроизведённой пробе, а не по осмотру диффа.
3. Повторный аудит дублировал бы реестр и стирал бы предрегистрационное свойство (новые пробы после фиксов уже не «пред-», а «пост-»-hoc).

Вместо этого — единый набор проверок: регресс-контур (§1), пробный контур (§2), матрица волн (§3), покрытие всех серий (§4), процедура волны (§5).

---

## 1. Регресс-контур — обязателен на каждой волне

| проверка | команда | базлайн main `4d70201` |
|---|---|---|
| юнит/самтесты | `npm test` | core **53** · tbank **PASSED** · kassa **149** · yookassa **235** · atol **210** · alfa **295** |
| upstream-сверка | `npm run check:upstream` | 11/0 (report-only — сама PC-08) |
| ссылки в доках | `npm run check:links` | 72 файла |
| протокольный дрейф | `npm run check:drift` | 316/316 |
| CI | push/PR (18/20/22 + docker) | зелёный |

Правила:
- Волна закрывается только при базлайне «зелёный + числа ≥ базлайна»; прирост объясняется тестами fix-PR (иначе — разбор до вердиктов).
- Расхождение с базлайном сигнала координатора фиксируется и разбирается до выставления статусов.
- Свежий клон main на каждый прогон; `/tmp`-клоны эфемерны — номера считать на месте, не наследовать.

Исторические базлайны для сравнения:

| ревизия | core | tbank | kassa | yookassa | atol | alfa | sber | vtb | first-ofd | kontur-ofd | upstream | links | drift |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `f89f76f` (до фиксов, база спец-аудита alfa) | 48 | PASSED | 141 | 227 | 202 | 287 | — | — | — | — | 11 | 69 | 316/316 |
| `f6e7cf3e` = `4d70201` (волна #50) | **53** | PASSED | **149** | **235** | **210** | **295** | — | — | — | — | 11/0 | **72** | 316/316 |
| `4edb30a6` (head PR #68, волна #51) | 57 | PASSED | 152 | 236 | 211 | 297 | — | — | — | — | 11/0 | 72 | 316/316 |
| `97dcb71` (волна #51 смержена: #68 + docs #67/#69) | **57** | PASSED | **152** | **236** | **211** | **297** | — | — | — | — | 11/0 | **74** | 316/316 |
| `8b3304b` (волна #52 смержена: squash #71) | **60** | PASSED | **161** | **245** | **220** | **305** | — | — | — | — | 11/0 | **74** | 316/316 |
| `e8d9f93` (волна #53 смержена: squash #72) | **65** | PASSED | **161** | **245** | **220** | **307** | — | — | — | — | 11/0 | **74** | 316/316 |
| `7471db5` (волна #60 смержена: squash #77) | **65** | PASSED | **161** | **245** | **220** | **337** | — | — | — | — | 11/0 | **74** | 316/316 |
| `6fe35a4` (волна #58 смержена: squash #78) | **65** | PASSED | **161** | **246** | **220** | **360** | — | — | — | — | 11/0 | **74** | **324/324** |
| `3f4dea2` (волна #81: sber-mock #84 + CI #85) | **65** | PASSED | **161** | **246** | **220** | **360** | **67** | — | — | — | 11/0 | **76** | **420/420** |
| `1132955` (волна #87: vtb-mock #89) | **65** | PASSED | **161** | **246** | **220** | **360** | **67** | **72** | — | — | 11/0 | **78** | **521/521** |
| `6b01501` (волна #92: first-ofd-mock #94) | **65** | PASSED | **161** | **246** | **220** | **360** | **67** | **72** | **94** | — | 11/0 | **80** | **644/644** |
| `72627cd` (волна #97: kontur-ofd-mock #99) | **65** | PASSED | **161** | **246** | **220** | **360** | **67** | **72** | **94** | **109** | 11/0 | **82** | **732/732** |
| `c4d5a82` (волна #98: owned-token приоритет #100) | **68** | PASSED | **161** | **246** | **224** | **364** | **67** | **81** | **103** | **109** | 11/0 | **82** | **732/732** |
| `01254d7` (PD-02: env-квоты + глобальный бюджет #105) | **73** | PASSED | **161** | **246** | **224** | **371** | **67** | **81** | **103** | **109** | 11/0 | **82** | **732/732** |
| `fcd3b05e` (MS-04: graceful shutdown #115) | **77** | PASSED | **166** | **246** | **224** | **371** | **67** | **81** | **104** | **109** | 11/0 | **82** | **732/732** |
| `cc6761b` (MS-06: токены из query в заголовки/cookie #116) | **77** | PASSED | **167** | **246** | **224** | **371** | **67** | **81** | **104** | **109** | 11/0 | **82** | **732/732** |

Промежуточная `6d13b81` ≡ `e133a6b` (отчёты приняты): npm-срез отдельно не фиксировался (контроль пробами); `check:links` на ней — 71 файл (72 после CHANGELOG #65). Рост 72→74 на `97dcb71` — docs-PR #67/#69 (README prereg-бандла + VERIFICATION-SUITE). При потребности — пересчитать на месте.

Базлайн `6fe35a4` сошёлся поле-в-поле с приёмкой координатора (независимый полный прогон SZ: core 65 · tbank PASSED · kassa 161 · yookassa 246 · atol 220 · alfa 360 · upstream 11/0 · links 74 · drift 324/324). Дельты к `7471db5`: yookassa 245→246 (check PF-02 selftest), alfa 337→360 (PB-14/PG-07/PG-08: check-вызовы selftest 206→225), drift 316→324 (+8: блоки limits/idempotency alfa + негативный контроль PC-17, PE-19 route в mockRoutes). HEAD `f456dff` (tbank-флейк #76, squash #80) счётчиков не меняет; независимый spot-check tbank на HEAD — 5/5 PASSED (серии 20/20 координатора по #56/#76 учтены: флейки закрыты). CI ревизии — зелёный по сигналу.

Базлайн `3f4dea2` сошёлся поле-в-поле с сигналом волны #81 (комментарий 6152069533; независимый полный прогон SZ: core 65 · tbank PASSED · kassa 161 · yookassa 246 · atol 220 · alfa 360 · **sber 67** · upstream 11/0 · links 76 · drift **420/420**, включая sber-ecom). Дельты к `6fe35a4`: sber 0→67 (новый selftest `services/sber-mock`, #84), links 74→76 (`docs/integration/sber.md` + `docs/openapi/sber-mock.openapi.json`), drift 324→420 (+96 — `protocols/sber-ecom.json` в контуре `check:drift`). CI ревизии — 5/5 success (test 20/22/24 + docker + GHCR: матрица [20,22,24] #85 подтверждена независимо). Сводка — `wave81-3f4dea2/baseline-summary-3f4dea2.txt`.

Базлайн `1132955` сошёлся поле-в-поле с сигналом волны #87 (комментарий 6153478615; независимый полный прогон SZ: core 65 · tbank PASSED · kassa 161 · yookassa 246 · atol 220 · alfa 360 · sber 67 · **vtb 72** · upstream 11/0 · links 78 · drift **521/521**, включая vtb-smb). Дельты к `3f4dea2`: vtb 0→72 (новый selftest `services/vtb-mock`, #89), links 76→78 (`docs/integration/vtb.md` + `docs/openapi/vtb-mock.openapi.json`), drift 420→521 (+101 — `protocols/vtb-smb.json` в контуре `check:drift`). HEAD main `49f5997` (#91 pin/tag) поверх `b1f3c40` (#90 release v0.6.0) — docs/infra-дельта поверх сигнала, прогоны не трогает (срез — на ревизии сигнала `1132955`). CI ревизии — 5/5 success (test 20/22/24 + docker + GHCR — сверено независимо по API). Сводка — `wave87-1132955/baseline-summary-1132955.txt`.

Базлайн `6b01501` (волна #92, независимый полный прогон SZ, exit 0): core **65** · tbank PASSED · kassa **161** · yookassa **246** · atol **220** · alfa **360** · sber **67** · vtb **72** · **first-ofd 94** · upstream **11/0** · links **80** · drift **644/644** (включая first-ofd-okassa). Дельты к `1132955`: first-ofd 0→94 (новый selftest `services/first-ofd-mock`, #94), links 78→80 (`docs/integration/first-ofd.md` + `docs/openapi/first-ofd-mock.openapi.json`), drift 521→644 (+123 — `protocols/first-ofd-okassa.json` в контуре `check:drift`). Поверх сигнала в main ушли 2 не-поведенческих коммита (`8c076c9` selftest-ожидание alfa #95, `f6161f2` pin/EXPOSE #96) — срез пробы и вердикт строго на ревизии сигнала `6b01501` (команда: «вердикт — только по воспроизведённой пробе на ревизии, не по диффу»). Сводка — `wave92-6b01501/` (проба + полный npm-test).

Базлайн `72627cd` (волна #97, независимый полный прогон SZ, exit 0) сошёлся поле-в-поле с независимым прогоном координатора: core **65** · tbank PASSED · kassa **161** · yookassa **246** · atol **220** · alfa **360** · sber **67** · vtb **72** · first-ofd **94** · **kontur-ofd 109** · upstream **11/0** · links **82/0** · drift **732/732** (включая kontur-ofd). Дельты к `6b01501`: kontur-ofd 0→109 (новый selftest `services/kontur-ofd-mock`, #99), links 80→82 (`docs/integration/kontur-ofd.md` + `docs/openapi/kontur-ofd-mock.openapi.json`), drift 644→732 (+88 — `protocols/kontur-ofd.json` в контуре `check:drift`). CI ревизии — success по сигналу (run 38541092864). Самтест адаптера на ревизии — **109/109**. Сводка — `wave97-72627cd/` (проба + полный npm-test).

Базлайн `c4d5a82` (волна #98, merge PR #100 — приоритет `X-Sandbox-Token`/`X-Owner-Token` над `Authorization: Bearer` в `ownerTokenOf`, правка ядра 12 строк; независимый полный прогон SZ, exit 0) — поле-в-поле с прогоном координатора: core **68** (+3) · tbank PASSED · kassa **161** · yookassa **246** · atol **224** (+4) · alfa **364** (+4) · sber **67** · vtb **81** (+9) · first-ofd **103** (+9) · kontur-ofd **109** · upstream **11/0** · links **82** · drift **732/732** (прирост 29 проверок = DoD-проверки приоритета в selftest'ах core/atol/alfa/vtb/first-ofd). Поверх сигнала в main ушли 2 CI-коммита (`d168d45` раннер, `d146d8b` docker-джоб) — не поведенческие, прогоны не трогают. CI ревизии — success по сигналу (run 38544762059). Сводка — `wave98-c4d5a82/` (проба + полный npm-test).

Базлайн `01254d7` (PD-02, squash #105 — байтовая квота `MOCK_SANDBOX_MAX_STATE_BYTES` во всех 9 адаптерах + глобальный бюджет `MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES`, запись/импорт сверх бюджета → 400 с полным откатом; независимый полный прогон SZ, exit 0) — поле-в-поле с сигналом координатора: core **73** (+5) · tbank PASSED · kassa **161** · yookassa **246** · atol **224** · alfa **371** (+7) · sber **67** · vtb **81** · first-ofd **103** · kontur-ofd **109** · upstream **11/0** · links **82** · drift **732/732**. Дельты к `c4d5a82`: core +5, alfa +7 (env-сценарии квот в selftest'ах) и блок `testStateByteEnv` в tbank — прирост объяснён волной. Срез строго на ревизии сигнала (поверх в main ушли PR #113/#114/#115 — доки/батч/MS-04; срез их не включает). Сводка — `wave105-01254d7/` (проба + полный npm-test).

Базлайн `fcd3b05e` (MS-04, squash #115 — `installGracefulShutdown` на девяти сервисах (SIGTERM/SIGINT → sync flush → close → closeAllConnections → exit 0, fallback 1 с, идемпотентен) + контейнерный харденинг compose×3 (init/read_only/tmpfs /tmp/cap_drop ALL/no-new-privileges/pids_limit 256); независимый полный прогон SZ, exit 0) — поле-в-поле с сигналом: core **77** · tbank PASSED · kassa **166** · yookassa **246** · atol **224** · alfa **371** · sber **67** · vtb **81** · first-ofd **104** · kontur-ofd **109** · upstream **11/0** · links **82** · drift **732/732**. Между ревизиями PD-02 и MS-04 в main легли merged PR #113 (аудит-материалы SZ — только доки) и батч #114 (эхо request для StateCommandRequest и др.) — прирост selftest'ов (kassa +5, first-ofd +1, core +4) закреплён этим базлайном. Сводка — `wave115-fcd3b05e/` (проба + полный npm-test).

Базлайн `cc6761b` (MS-06, squash #116 — миграция управляющих токенов из query в заголовки/cookie: `tokenMatches`/`checkControlAccess` — Bearer / `X-Mock-Admin-Token` (+легаси `X-Admin-Token`) / `X-Operator-Token` / cookie (`mock_admin_token`/`mock_operator_token`/`mock_sandbox_token`); query — non-hosted приём с WARN, hosted admin/operator fail-closed + hint, `sandbox_token` в owned fail-closed; `POST /admin/login` → 302 + `Set-Cookie` HttpOnly/SameSite=Strict; независимый полный прогон SZ, exit 0) — поле-в-поле с сигналом координатора: core **77** · tbank PASSED · kassa **167** · yookassa **246** · atol **224** · alfa **371** · sber **67** · vtb **81** · first-ofd **104** · kontur-ofd **109** · upstream **11/0** · links **82** · drift **732/732**. Дельты к `fcd3b05e`: kassa 166→**167** (+1 — cookie/login-регресс selftest kassa), прочие без изменений. Поверх сигнала в main ушли PR #117 (аудит-материалы SZ — доки) и #118 (Такском) — срез строго на ревизии сигнала `cc6761b`. Сводка — `wave116-cc6761b/` (проба + добивки + полный npm-test).

---

## 2. Пробный контур alfa — P1–P9 + дифференцирующие волновые пробы

Запуск: `node docs/audit/tool-results/alfa-probes/<скрипт>.js` из корня репо (пути от `__dirname`); prereg-пробы — `docs/audit/tool-results/sz-prereg/<скрипт>.js` (PR #67). Node ≥ 20, сеть не нужна, listener'ы только на `127.0.0.1:0`.

### 2.1. Серия P (предрегистрация — README alfa-probes, §5 AUDIT-SZ-ALFA)

| скрипт → пробы | находки | волна | предрегистрация «после» | статус |
|---|---|---|---|---|
| `alfa-probes.js` → **P1** | PG-01 (hint с фактическими кредами) | #60 | hint не содержит фактических кредов | ✅ **закрыто** на `7471db5` (hint errorCode=2 называет только синтетические дефолты `ALFAMOCKTEST/mockpass123`; `customuser`/`CUSTOM-SECRET-2026` отсутствуют в hint и логах; auth фактическими кредами работает; логи отказов чистые — P1 + `sz-wave60-creds-faces.js`) |
| `alfa-probes2.js` → **P1b** | PG-02 (креды в стартовом логе) | #60 | стартовый лог без userName/password/секрета | ✅ **закрыто** на `7471db5` (env-креды -> `<задан через env, скрыт>`; без env текст прежний — дефолты как есть; `credLogView` — поле-в-поле с сигналом) |
| `alfa-probes.js` → **P2** (a/b/c) | PA-50, PG-03 (треугольник read/reset/import) | #50 | отказ 401/403/404, канарейки нет | ✅ **закрыто** на `f6e7cf3e` |
| `alfa-probes.js` → **P3**, `alfa-probes2.js` → **P3b***, `alfa-probe3c.js` → **P3c** | PA-51, PG-04 (правило A на трафике B; orderId B в истории A) | #52 | правило A не срабатывает на B; orderId B не виден A | ✅ **закрыто** на `8b3304b` (P3: register B errorCode=0, orderNumber B в истории A=false; P3c после исправления cwd пробы: orderId B в истории A=false, история A пуста; \*P3b — артефакт, §6; \*\*P3c — артефакт cwd, §6) |
| `alfa-probes.js` → **P4** (`%`-энкод → 500) | PA-01 (alfa-инстанс) | вне волн (core-хвост) | 400 вместо 500 | ⬜ дефект в силе |
| `alfa-probes.js` → **P5**, `alfa-probes2.js` → **P5** | PG-05 ≡ PB-11 (`'1h'` → 1000 мс; `'0'` → 1200 с) | #58 | `1h` ≠ 1000 мс | ✅ **закрыто** на `6fe35a4` (P5/P5b «не подтвердилось»: `'1h'` → 3600 с / 3600000 мс — честный разбор суффиксов, как в адаптированной prereg; `'0'` срока сессии → WARN + 1200; `'0'` ретрая → `retry 0ms x24` «повтор без паузы»; контроль `'3600'/'60000'` цел — `pb11-env-timeout.js` 3/3) |
| `alfa-probes.js` → **P6** | PG-07 (SSRF-блок переживает ретрай-цикл) | #58 | терминальный статус без ретраев | ✅ **закрыто** на `6fe35a4` (P6 зелёная: гард on, доставок 0; специализированная `sz-wave58-pg07-terminal.js`: attempts 1→1 заморожены, `dumped=true`, терминальный лог ×1, остаточный «retry in …» ×1; «до» `7471db5` — attempts 1→2, dumped=false, лога нет) |
| `alfa-probes.js` → **P7** | PG-07 (позитив: редакция журнала) | #58 | пароль не читаем | ✅ редакция работает на `8b3304b` (NB: фактический P7 в бандле — редакция журнала, НЕ scope сброса; транспорт PG-09 исправлен на pb13+extras-R) |
| `pb13-journal-cross.js` + `sz-wave52-extras.js` → **R** | PG-09 + PB-13 (reset/journal скоупятся в целевую запись) | #52 | сброс A не задевает правила/историю/журнал B; правило B живо на трафике B | ✅ **закрыто** на `8b3304b` (pb13a/b «не подтвердилось»; extras-R: B rules=1/history=1/журнал цел, register B2 errorCode=6, A очищен; «до»-контроль 4d70201 — B стёрт глобальным clear) |
| `alfa-ttl-race.js` → **P8** | PG-10 (TTL-sweep-рейс §7.2) | #50 | рейс-фаза = контроль: `errorCode:3`, канарейки жертвы нет | ✅ **закрыто** на `f6e7cf3e` |
| `alfa-dns-toctou.js` → **P9** | PG-11, PA-25 (alfa-грань; DNS TOCTOU §7.3) | #51 | `fixtureHits:0`, блок при CONNECT; контроль `SSRF_BLOCKED` цел | ✅ **закрыто** на `97dcb71` (fixtureHits:0, блок при CONNECT, attempts:1; контроль цел) |

### 2.2. Дифференцирующие волновые пробы (заведены по ходу волн)

| скрипт | находки | волна | «до» → «после» | статус |
|---|---|---|---|---|
| `sz-wave50-pa54-56.js` (PR #69) | PA-54 (байпас public/form-политик), PA-55 (гонка `switchActive`), PA-56 (`run()` fail-open) | #50 | воспроизводятся → throw `SANDBOX_ADMISSION_FAILED` / без глобального переключения / fail-closed | ✅ **закрыто** на `f6e7cf3e` |
| `sz-wave51-pa26-ssrf-classes.js` (PR #67) | PA-26 (классы IPv6/TEST-NET/NAT64 мимо гарда) | #51 | `e133a6b`: 8/9 классов fail-open → head: 9/9 `SSRF_BLOCKED` | ✅ **закрыто** на `97dcb71` (9/9 `SSRF_BLOCKED`, десятичный v4 блокирован, контроли целы: 0/0) |
| `pf01-kassa-guard-hosted.js` (PR #67) | PF-01 (`'false'` глушит SSRF-гард в hosted) | #51 | доставка на loopback → блок, доставок 0 | ✅ **закрыто** на `97dcb71` (PF-01a статика: литерал `'false'` отсутствует; PF-01b: hosted-дефолт true, доставок 0; контроль PF-01c цел) |
| `pa58-core-ssrf-default.js` (PR #67) | PA-58 (`blockPrivateHosts` по умолчанию false) | #51 | hosted-дефолт fail-open → `true`, доставок 0, контроль цел | ✅ **закрыто** на `97dcb71` (MOCK_HOSTED=1: `defaultBlockPrivateHosts()=true`, доставок 0, done:false; контроль цел; локальный дефолт false — осознанная семантика, ИНФО) |
| `sz-wave52-extras.js` (PR #73) | PG-09 (scope сброса), жизненный цикл, cap правил | #52 | «до» `4d70201`: R ❌ (глобальный clear), L ❌ (наследование), CAP ❌ (без лимитов) → «после» `8b3304b`: R ✅ / L ✅ / CAP ✅ | ✅ **дифференцирующая тройка подтверждена** (reset A чистит только A; пересоздание id — пустые разделы; 201-е правило → 400 `rule_cap_exceeded`, >8KiB → 400 `rule_too_large`, без новых статусов) |
| `sz-wave53-persist-scope.js` (PR #78) | PD-02 (per-file scope, миграция, квота) | #53 | S: мутация B не трогает файл A; M: legacy-реестр (с заказом) -> `.migrated` + records, заказ переживает; Q: переполнение -> `SANDBOX_QUOTA_BYTES` + откат, сосед цел | ✅ **S/M/Q закрыты** на `e8d9f93` (M — end-to-end от реестра, записанного ДО-кодом `4d70201`; Q — core-уровень с малым `maxStateBytes`, т.к. через HTTP переполнение 8МиБ недостижимо при капе тела 5МиБ) |
| `sz-wave58-pg07-terminal.js` + `sz-wave58-pg08-headers.js` + `sz-wave58-pf02-logprefix.js` (волна #58) | PG-07 (терминальность SSRF-блока), PG-08 (security-заголовки страниц оплаты/ACS/404), PF-02 (префикс логов yookassa) | #58 | «до» `7471db5`: attempts 1→2/dumped=false/терминального лога нет; заголовков нет 5/5 страниц; `ock]` — 7/7 строк старта + 17 в исходнике → «после» `6fe35a4`: attempts заморожены/dumped/лог ×1; 5/5 страниц с XFO/CSP/Referrer/nosniff/no-store; 7/7 строк старта и runtime-sweep префиксованы, `ock]` 0 | ✅ **дифференцирующая тройка: «до» ❌ → «после» ✅** |

### 2.3. Prereg-бандл #64 — «до»-пробы хвостов дельты (PR #67, вне волновой очереди)

`pa52-queue-starvation.js` (PA-52) · `pb11-env-timeout.js` (PB-11) · `pb12-quota-docs.js` (PB-12) · `pb13-journal-cross.js` (PB-13) · `pc17-drift-diagnostic.js` (PC-17) · `pd02-persist-amplification.js` (PD-02) · `pe19-admin-action-doc.js` (PE-19). Прогоняются при закрытии соответствующих задач (DoD-проверка «после»), ожидания — в README бандла.

### 2.4. Позиции без живых проб (честная граница)

| находка | чем проверяется при закрытии |
|---|---|
| PG-06 (env-doc-дрифт include↔README↔SECURITY.md) | grep-контроль трёх мест + `check:links` — ✅ **выполнен** на `6fe35a4` (README alfa `:202,206,213-215`; include `:253,267-268`; SECURITY.md `:66-67,73`; links 74/0) |
| PG-08 (security-заголовки страниц оплаты) | ~~инспекция заголовков~~ — ✅ **живая проба** `sz-wave58-pg08-headers.js` на `6fe35a4`: 5/5 страниц (форма, ACS POST /pay, ACS GET status=5, 404, /admin) с XFO/CSP/Referrer-Policy/nosniff/no-store; «до» `7471db5` — заголовков нет |
| PA-02/PA-03/PA-07/PA-09 (редакция) | DoD-регрессы fix-PR + selftest (core) — core-хвост, вне волновой очереди |

### 2.5. Sber-mock — пробный проход волны #81 (новый 7-й сервис)

Транспорт: `sz-wave81-sber-baseline.js` (`__dirname`-резолв), три серверных ноги: non-hosted (env-креды, `MOCK_SBER_CALLBACK_RETRY_MS=300`), non-hosted с дефолтами (retry 60s + виртуальные часы), hosted (`MOCK_HOSTED=1`). Запуск: `node docs/audit/tool-results/sz-prereg/sz-wave81-sber-baseline.js`.

| инвариант (сигнал 6152069533) | ожидание | статус на `3f4dea2` |
|---|---|---|
| креды-hint | env-креды скрыты в стартовом логе; auth фактическими кредами работает; отказ без утечки | ✅ (`<задан через env, скрыт>` ×2; register errorCode=0; errorCode=2 без секрета в теле) |
| callbacks ACK/ретраи | unsigned JSON (без signature/checksum), ACK только 200, дефолт 3×60s, часы ускоряют ретрай | ✅ (`created` ACK → ровно 1 доставка; deposited 500→ретрай→ACK; `+60s` → попытка 2; ровно 3 доставки, 4-й нет) |
| форк errorCode 1..6 | HTTP 200 + envelope {errorCode,errorMessage,field,hint,doc}; частные соответствия | ✅ (1 дубликат / 2 авторизация / 3 неизвестный заказ / 4 неверное состояние / 5 валидация / 6 сценарий fail; `errorCode=0` ≠ успех — hint предупреждает прямо) |
| отсутствие PAN | PAN не хранится/не логируется; маска first6**last4 | ✅ (REST-ответы/журнал/callbacks/лог без PAN; маска `400680**2514` в заказе; каталог пресетов на hosted-страницах — документированные публичные тестовые карты, не хранение) |
| SSRF-терминальность | hosted: доставка на private/reserved → терминальный отказ без повтора | ✅ (metadata + loopback: доставок 0; лог «заблокирован политикой SSRF — терминальный отказ, без повторов»; после `+60s` — по-прежнему 0; контроль: non-hosted доставка на 127.0.0.1 работает — дефолт `false` задокументирован) |

Дополнительно покрыто: одностадийный и двухстадийный флоу (preAuth → approved/холд `orderStatus=1` → частичный deposit 6000/9000 → `orderStatus=2`), reverse после deposit легален до взаиморасчётов (`orderStatus=3`, `reversed`-callback), повторный reverse → errorCode=4, TTL 20m (`+20m` → `orderStatus=6` + `declinedByTimeout`), 3 попытки ACS (третья неудача → `orderStatus=6`). Итог пробы: **46/46, 0 failed** (лог — `wave81-3f4dea2/sz-wave81-baseline-3f4dea2.txt`). Это пробный проход инвариантов нового адаптера, не волновая верификация закрытых позиций.

### 2.6. Vtb-mock — пробный проход волны #87 (новый 8-й сервис)

Транспорт: `sz-wave87-vtb-baseline.js` (`__dirname`-резолв), четыре серверных ноги: non-hosted (env-креды `MOCK_VTB_CLIENT_ID/SECRET`, `MOCK_VTB_CALLBACK_RETRY_MS=300`, admin-token), non-hosted с дефолтами (retry 60s + виртуальные часы, контрольный контур без токена), hosted (`MOCK_HOSTED=1`, callback-URL → metadata), без callback URL (`MOCK_VTB_PREAUTH=false`). Запуск: `node docs/audit/tool-results/sz-prereg/sz-wave87-vtb-baseline.js`.

| инвариант (сигнал 6153478615) | ожидание | статус на `1132955` |
|---|---|---|
| OAuth TTL/истечение/обновление | client_credentials → {access_token, token_type=Bearer, expires_in≈170}; TTL на виртуальных часах; обновление по expires_in | ✅ (expires_in=170; `+171s` → 401 invalid_token — hint про expires_in; повторный client_credentials → новый токен; RFC 6749 §5.2: invalid_client / unsupported_grant_type) |
| Bearer + X-IBM-Client-Id | строго lowercase client_id без `@ext.vtb.ru`; нарушения → invalid_client | ✅ (без заголовка и «SzClient@ext.vtb.ru» → 401 invalid_client с DX-hint; корректные заголовки → 200) |
| идемпотентность orderId vs refundId | повтор orderId — replay (`X-Mock-Replayed`), повтор refundId — ошибка | ✅ (orderId: 200 + `X-Mock-Replayed:1` + тот же orderCode; refundId: 409 `duplicate_refund_id`, replay-заголовка нет, hint «ошибка, а не идемпотентный replay») |
| decimal-рубли | `{value, code:"RUB"}` — не копейки; >2 знаков / не-RUB → invalid_amount | ✅ (10.56 echo {value:10.56, code:RUB}; 10.567 и USD → 400 invalid_amount) |
| callback payload как есть | PAYMENT → `Status` (заглавная), REFUND → `status` (строчные), без нормализации; ACK = любой 2xx [FORK]; дефолт 3×60s на часах | ✅ (ключи сверены поле-в-поле в обе стороны; 500 → ретрай (env 300ms) → ACK; ACK 200 → ровно 1 доставка; дефолты: попытка 1 immediate, `+60s` → 2 и 3, ровно 3 доставки, 4-й нет; сценарии status-lowercase/reconciled отдают СБП-вариант/RECONCILED) |
| отсутствие PAN | PAN не хранится/не логируется; маска first6**last4 | ✅ (REST-ответы/журнал/callbacks/лог без PAN; маска `424242**4242` в заказе и callback; каталог [FORK]-пресетов на hosted-страницах — документированные публичные синтетические данные, не хранение — урок #81 §6) |
| SSRF-терминальность | hosted: доставка на private/reserved → терминальный отказ без повтора | ✅ (callback на metadata 169.254.169.254: доставок 0; лог «заблокирован политикой SSRF — терминальный отказ, без повторов»; после `+60s` — по-прежнему 0; контроль: non-hosted доставка на 127.0.0.1 работает — дефолт `false` задокументирован) |
| [FORK]-карты | официальная тестовая карта ВТБ (4111 1111 1111 1111, 12/24) истекла; синтетические пресеты мока | ✅ (официальная → форма «истекла», ордер не оплачен, payments пуст; пресеты: успех → 302 на returnUrl / отказ эмитента → форма с причиной / сверка exp-CVV) |

Дополнительно покрыто: preauth-холд (payment NEW на своём уровне, ордер остаётся CREATED, PAYMENT-callback только после complete — «в срезе нет типа события холда»), частичный complete 5/9 (остаток холда снимается), повторный complete → 409 invalid_order_state, cancel preauth до complete → CANCELED + холд `voided` (статуса reversal в словаре операций нет — [VERIFY] честно), complete по отменённому → 409, TTL ордера +20m → CANCELED «order expired» (callback-типа истечения в срезе нет), MOCK_VTB_PREAUTH=false → 403 preauth_disabled, «без callback URL очередь не создаётся», /admin/journal и /mock/time без токена в non-hosted (документированная модель). Итог пробы: **62/62, 0 failed** (лог — `wave87-1132955/sz-wave87-baseline-1132955.txt`). Это пробный проход инвариантов нового адаптера, не волновая верификация закрытых позиций.

### 2.7. First-ofd-mock — закрытие пробной верификации волны #92 (OKassa, 8-й сервис, :3107)

Транспорт: `sz-wave92-firstofd-dod.js` (`__dirname`-резолв; 5 серверных ног: main non-hosted namespaces, callback+ретраи, SSRF `MOCK_BLOCK_PRIVATE_WEBHOOKS=1`, `MOCK_FIRST_OFD_TOKEN_SINGLE=1`, owned `MOCK_HOSTED=1` — наблюдение для #98). Вердикт — только по воспроизведённой пробе на ревизии `6b01501` (команда координатора), не по диффу PR #94. Запуск: `node docs/audit/tool-results/sz-prereg/sz-wave92-firstofd-dod.js`.

| группа DoD (issue #92) | ожидание | статус на `6b01501` |
|---|---|---|
| getToken: выдача | 200 + `{token}` + `X-Mock-Token-TTL-Secs: 86400`/`X-Mock-Token-Expires-At`; bad creds → 401 `invalid_credentials`; пустое тело → 400 | ✅ (токен 48 симв.; квирк примера PDF воспроизводится сценарием `getToken-error-quirk`: 200 + `error{code:0}` — расхождение №4 среза) |
| getToken: истечение 24 ч/повтор | TTL на виртуальных часах: `+25h` → 401 `invalid_token`; повторная выдача не аннулирует прежний токен; после истечения новая выдача рабочая | ✅ (оба токена 401 после `+25h` — lazy-purge тиком, текст «Неизвестный токен», урок §6; `t1!==t2`, оба живы до истечения; `MOCK_FIRST_OFD_TOKEN_SINGLE=1` — прежний аннулирован) |
| очередь transaction/{type} → requestId → status/transaction | 5 типов по строгим схемам: receipt-тело в StateCommandRequest отклоняется; `IN_PROGRESS` → `COMPLETED/ERROR` по виртуальным часам; результат `{requestId, transactionType, errorCode, errorType, details, payload}` | ✅ (все 5 типов: openShift/closeShift/currentStateReport + receipt INCOME/INCOME_RETURN/EXPENCE/EXPENCE_RETURN + receiptCorrection(+correctionCause); операции написания сохранены КАК В СХЕМЕ (`EXPENCE`, вариант `EXPENSE` → 400 с подсказкой); суммы — десятичные рубли числами; отчёт состояния — не фискальный документ ([VERIFY])) |
| statuses по externalId+groupId | оба параметра обязательны → 400 `missing_parameter`; повтор externalId в группе — НОВАЯ заявка + `X-Mock-Duplicate-External-Id: 1` ([VERIFY] зафиксировано); фильтр status | ✅ (обе заявки в списке; без параметров 400; плохой фильтр 400) |
| /receipts за период (+пагинация) | from/to обязательны; envelope `{items,total,page,pageSize}` (локальная форма [FORK]/[VERIFY]); page/pageSize; фильтры transactionType/groupId/kkmRegId; пустой период = пустой список | ✅ (8 ФД поле-в-поле с ledger пробы; пагинация 4+4+0 без пересечений и потерь, ASC по documentDate; фильтры точечные; from>to → 400; pageSize>100 → 400 (mock cap); пустой период 200+[] — не ошибка) |
| оба слоя ошибок (API vs KKT) | сценарии `kkt-error`/`api-error` → `ERROR` + `errorType`/`errorCode`/`details` разных слоёв; ERROR-заявка не создаёт ФД; правила смен `SHIFT_ALREADY_OPEN`/`SHIFT_NOT_OPEN` ([FORK] мока) | ✅ (KKT_UNAVAILABLE vs DOCUMENT_REJECTED — слои раздельны; payload=null у ERROR; повторный openShift/closeShift → KKT-ошибки) |
| негативы | bad/чужой/non-Bearer → 401; отсутствующие обязательные поля (userInn/userGroup/requestMetadata/document/correctionCause) → 400 с field/hint; неизвестный userGroup → 400 `unknown_user_group`; vatCode → 400 `invalid_vat_code`; неизвестный requestId → 404 `request_not_found` | ✅ (все ветки воспроизведены; field/hint — top-level envelope `{error:{code,text,layer}, field, hint, doc}`) |
| «знание ID ≠ доступ» | namespaces: чужой requestId → 404, statuses чужой песочницы пусты, токен песочницы B на дефолтной → 401; owned: битый `X-Sandbox-Token` → 401; Bearer<очередь>+`X-Sandbox-Token` → 401 (задокументированное ограничение, вводные #98) | ✅ (изоляция песочниц поле-в-поле; legE: 401 «знание ID не является доступом» при Bearer+X-Sandbox-Token; только Bearer<owner-token> → 200 — fallback ядра; после #98 — сохранение поведения) |
| callback + сверка статусом | POST на `requestMetadata.callbackUrl` без подписи; тело = результат + externalId/userGroup; ACK любой 2xx; ретраи `RETRY_MS × MAX_ATTEMPTS` (3×60s дефолт, env-ускорение); SSRF — терминальный отказ без повторов | ✅ (доставка на 127.0.0.1: 1 попытка, без signature/HMAC-заголовков; сверка статусом COMPLETED; 500 → 3 попытки по графику, заявка остаётся COMPLETED; SSRF-блок: заявка COMPLETED, доставка dumped терминально, после `+65s` второй попытки нет) |

Дополнительно покрыто: окно периода для `/receipts` от `GET /mock/time` → `snapshot.now` (виртуальные часы), эхо-тело заявки в `GET transaction/{id}` для receipt-типов (`rawRequest`), заявка при SSRF-блоке сама COMPLETED (блокирует только доставка). Итог пробы: **92/92, 0 failed** (лог — `wave92-6b01501/sz-wave92-probe-6b01501.txt`; полный npm-test — `wave92-6b01501/npm-test-6b01501.txt`). Это закрытие пробной верификации по DoD issue #92 на ревизии сигнала; формальные статусы закрытых позиций реестра не менялись (новый адаптер, не волновые фиксы).

Наблюдения владельцу (ИНФО, не блокеры DoD):
1. `transactionView` для StateCommandRequest (openShift/closeShift/currentStateReport) не отдаёт эхо-тело `request` (rawRequest сохраняется только для receipt/receiptCorrection) — README обещает «полная заявка (тело как принято)» для всех типов; грань DX, поведение детерминировано.
2. Вводные для #98 подтверждены независимым воспроизведением на first-ofd: Bearer<очередь>+X-Sandbox-Token → 401 «знание ID не является доступом»; только X-Sandbox-Token → 200; битый X-Sandbox-Token → 401; только Bearer<owner-token> → 200 (fallback ядра и до, и после фикса); self-hosted — без изменений.

### 2.8. Kontur-ofd-mock — закрытие пробной верификации волны #97 (Контур.ОФД read-only, 9-й сервис, :3108)

Транспорт: `sz-wave97-kontur-ofd.js` (zero-dep, Node ≥ 18; ноги: main non-hosted namespaces + owned `MOCK_HOSTED=1` — legB). Вердикт — только по воспроизведённой пробе на ревизии сигнала `72627cd` (merge PR #99); ожидания зафиксированы предрегистрацией «до» (комментарий 6169546061, до старта Арены). Самтест адаптера на ревизии: **109 passed, 0 failed**. Запуск: `node docs/audit/tool-results/sz-prereg/sz-wave97-kontur-ofd.js` из корня worktree/клона (проба резолвит `services/**` от `__dirname`).

| группа (предрегистрация) | вердикт | доказательство на `72627cd` |
|---|---|---|
| K1 auth: два уровня доступа (Sid + API-key) | ✅ | `POST /auth/authenticate-by-pass?login=` (пароль UTF-8 body) → 200 `{Sid}` (48 симв.); неверный пароль/login → 401 `errorCodeId=401002`; без Sid / только ApiKey → 401 401002; только Sid без ключа / неверный ключ → 401 **401003** (не путаются); Sid+ApiKey → 200; envelope несёт `errorCodeId` (ориентир), message/field/hint/doc |
| K2 Sid TTL на виртуальных часах (30 дней) | ✅ | Sid жив; сдвиг `+31d` → истёк: 401 401002 «получить новую сессию»; повторный authenticate → новый Sid (sid2≠sid1), рабочий |
| K3 organizations | ✅ | только доступные (`org-restricted` скрыт); поля id/inn/kpp/name, без служебных |
| K4 cashboxes + 403/404 | ✅ | org-demo: касса с regNumber/модель/ФН/адреса/период доступа; организация без согласия → **403** (знание ID ≠ доступ), неизвестная → **404**; то же на кассах (403/404) |
| K5 documents за дату (+types, пустой день) | ✅ | демо-каталог 2026-10-11: 12 ФД, все **10 типов** среза; `types=receipt` → 3 (1 возврат); types списком → 4; неизвестный type → 400 field=types; пустой день → 200 + пустой список; невозможная дата (02-30) → 400 |
| K6 by-period: пагинация ≤1000, `paging.nextOffset`, [FORK] offset | ✅ | страницы 5+5+2, `nextOffset` 5→10→**null** (терминальный курсор); обход без потерь/пересечений (12 уникальных), ASC-порядок; без offset/limit → 12 (дефолт 1000); limit=0/1001 → 400; `[FORK] currentOffset` → 400 с подсказкой «используйте offset»; пустой период → 200 пустой список; dateFrom>dateTo / нечитаемая дата → 400; фильтр types в периоде → 2 |
| K7 документ по ID | ✅ | receipt → 200 (fdn/fiscalSign/operationType); возврат прихода operationType=2; неизвестный documentId → 404 |
| K8 суммы в целых копейках | ✅ | totalSum/cashSum/electronicSum и items[].price/sum — копейки (контраст с банковскими decimal-рублями) |
| K9 write-путь не моделируется | ✅ | POST на read-маршрут → 405; POST документа (фискализация) → 405; неизвестный write-маршрут → 404 «write API не моделируется» |
| K10 сценарии | ✅ | duplicate до пагинации: страница держит лимит 5, без лимита 13 строк (12+повтор первой); fail → 500; http-504 → 504 |
| K11 журнал без секретов | ✅ | журнал читаем в namespaces; записи at/method/path/status/ms, body/headers пустые; пароля/Sid/API-key нет; curl без секретов и без query-login |
| K12 изоляция / «знание ID ≠ доступ» | ✅ | Sid песочницы B на дефолтной → 401 401002 (сессии изолированы); владелец внутри B читает своё → 200; чужие объекты — 403/404 |
| legB owned (`MOCK_HOSTED=1`) | ✅ | POST /sandboxes → 201 {ownerToken, creds, expiresAt}; auth по кредам песочницы с owner-заголовками → Sid; Bearer+owner → 200; **без X-Sandbox-Token (знание sandbox id) → 401**; битый X-Sandbox-Token → 401; без Sid (owner-token сам не авторизация данных) → 401 401002; /sandboxes/me не раскрывает креды; экспорт state без Sid; rotation кредов отзывает старый Sid (после → 401 401002) |

Расхождений с предрегистрацией нет. Дополнительно: CI ревизии — по сигналу (run 38541092864, success). Положение `#98` на момент пробы: core-фикс приоритета `X-Sandbox-Token`/`X-Owner-Token` уже в main (`2a6cacd`) — «после»-контроль legE-матрицы снят отдельно на `c4d5a82` (§2.9). Итог пробы: **71/71, 0 failed** (лог — `wave97-72627cd/sz-wave97-probe-72627cd.txt`; полный npm-test — `wave97-72627cd/npm-test-72627cd.txt`). Формальные статусы закрытых позиций реестра не менялись (новый адаптер, не волновые фиксы).

### 2.9. Ядро RFC-001/owned — приоритет X-Sandbox-Token/X-Owner-Token над Authorization: Bearer (волна #98, `c4d5a82`)

Транспорт: `sz-wave98-owned-priority.js` (zero-dep; ноги: first-ofd owned / vtb owned / atol owned — `MOCK_HOSTED=1`). Вердикт — по воспроизведённой пробе на ревизии сигнала `c4d5a82` (merge PR #100; поверх сигнала в main — только CI-инфра `d168d45`/`d146d8b`, поведение не трогают). «До»-контроль снят legE пробы волны #92 на `6b01501`: Bearer<очередь>+X-Sandbox-Token → **401** «знание ID не является доступом» (дефект, symptoms-текст совпал дословно). Запуск: `node docs/audit/tool-results/sz-prereg/sz-wave98-owned-priority.js` из корня worktree/клона (проба резолвит `services/**` от `__dirname`).

| угол (предрегистрация #98) | «после» — доказательство на `c4d5a82` |
|---|---|
| (а) owned: Bearer<очередь> + X-Sandbox-Token<owner> | ✅ **200** (first-ofd; «до» на `6b01501` — 401, дефект закрыт) |
| (б) битый X-Sandbox-Token при валидном Bearer | ✅ 401 `invalid_token`, текст «знание ID не является доступом» дословно |
| (в) fallback: только Bearer<owner-token> | ✅ 200 на `/mock/state`; зеркальный контроль: только Bearer<очередь> на state → 401 (бизнес-токен — не owner) |
| (г) оператор по Bearer | ✅ Bearer<operator> + чужой X-Sandbox-Token → 200 (`isOperatorRequest` по самому Bearer — не сломан) |
| X-Owner-Token (2-й источник) | ✅ Bearer<очередь> + X-Owner-Token<owner> → 200 на бизнес и state |
| query `sandbox_token` (4-й источник) | ✅ без Authorization → 200; **пустой Bearer + query → 200** (единообразие — принятая развилка); непустой Bearer<очередь> + query<owner> → 401 (затеняет, доступ не ослаблен); невалидный query → 401 |
| порядок явных источников | ✅ X-Sandbox-Token валид + X-Owner-Token битый → 200; X-Sandbox-Token битый + X-Owner-Token валид → 401 (непустой затеняет); X-Sandbox-Token пустой + X-Owner-Token валид → 200 (пустой = «отсутствует») |
| vtb (Bearer-класс, кросс) | ✅ Bearer<OAuth access> + X-Sandbox-Token → **200** («до» — 401); без явного owner → 401 |
| atol (не-Bearer, кросс) | ✅ X-Sandbox-Token → 200, битый → 401 — регресса нет |
| self-hosted (namespaces/off) | ✅ полный npm-регресс exit 0, числа §1 байт-в-байт |

Расхождений с предрегистрацией #98 нет. Формальные статусы закрытых позиций реестра не менялись (правка ядра 12 строк, не волновые фиксы). Наблюдение (ИНФО): `/getToken` в hosted fail-closed требует owner-заголовок — ожидаемое поведение (урок §6). Итог пробы: **19/19, 0 failed** (лог — `wave98-c4d5a82/sz-wave98-probe-c4d5a82.txt`, перегенерирован на `c4d5a82` — байт-в-байт с исходным прогоном; полный npm-test — `wave98-c4d5a82/npm-test-c4d5a82.txt`).

---

### 2.10. Байтовые квоты песочниц + глобальный бюджет (PD-02, `01254d7`)

Транспорт: `sz-wave105-pd02-state-bytes.js` (zero-dep, Node ≥ 18; tbank namespaces + first-ofd owned). Вердикт — по воспроизведённой пробе на ревизии сигнала `01254d7` (squash #105). Запуск: `node docs/audit/tool-results/sz-prereg/sz-wave105-pd02-state-bytes.js` из корня клона (ROOT-резолв с подъёмом от `__dirname`). Урок #53 (дефолт 8 МиБ > капы тела 5 МиБ) не мешает: граница достигается явным env (2048/4096/60000).

| нога (чек-лист сигнала) | доказательство на `01254d7` |
|---|---|
| env-матрица (пусто/мусор/0/−5) | ✅ импорт 100 КиБ проходит во всех вариантах: пусто/мусор → безопасный дефолт (tbank `maxDocuments=0` → без лимита), `0` и `−5` → выключено |
| точная граница per-sandbox | ✅ used==2048 → 200; used==2049 → 400 `sandbox_state_quota_exceeded` (errorCode 400, kind=bytes, used/limit/sandbox в теле); полный откат (состояние == последний принятый JSON); кэш размера жив: сразу после отката корректный импорт проходит |
| глобальный бюджет (сумма default+A+B) | ✅ 25000+20000+20000 → 400 `sandbox_state_budget_exceeded`, used==65000/limit==60000 (точная сумма), default и B не тронуты (частичного применения нет) |
| отказ на записи (глобальный) | ✅ бизнес-запись при used==limit → 400 `sandbox_state_budget_exceeded` ДО мутации (throw в pre-check `checkDocuments`), incoming пуст |
| освобождение бюджета | ✅ remove (`DELETE /sandboxes`), reset (`POST /mock/reset`), TTL-выселение (доступ к истёкшей → 410) — каждый механизм освобождает бюджет: импорт прежнего размера снова проходит; исчерпание перед каждым освобождением — бинпоиском до ровно 60000 |
| восстановленный default | ✅ рестарт с `MOCK_STATE_FILE`: маркер+байты сохранены; сверхлимитный импорт → 400 с откатом к ВОССТАНОВЛЕННОМУ состоянию (не `{}`) |
| owned/hosted + namespaces | ✅ first-ofd `MOCK_HOSTED=1`: граница 4096 (used==limit → 200, +1 байт → 400 used==4097); знание ID без owner-токена → 401 (квота доступ не открывает) |
| независимость квот | ✅ A/B/default независимо достигают собственной границы 2048 при GBL=0 — перекоса нет |
| бизнес-путь per-sandbox | ⚠️ находки Ф-1/Ф-2 ниже (не блокируют чек-лист сигнала: импорт и глобальный бюджет — строго по контракту) |

Находки (владельцу):

- **Ф-1 — дефект (латентный с `e8d9f93`/#72, не регресс #105)**: tbank, per-sandbox pre-check при used≥limit на инлайн-маршрутах — `if (quotaX) return quotaX;` возвращает err-объект в `route().catch`, где он отбрасывается: **ответ не отправляется вовсе** (клиент висит до таймаута, сервер молчит, в логе пусто). Подтверждено висящим запросом: `/av/v1/payment`, `/av/v1/verification`; тот же паттерн за более ранними валидациями: `/e2c/v2/Init`, `/sm-register/register`. Хелпер-маршруты `/v2/*` отвечают корректно (provider-shaped err(7) HTTP 200 «Лимит объёма состояния песочницы исчерпан (байт: 2048/2048)»). Предложение: отвечать `sendJson` (или единый 400 `sandbox_state_quota_exceeded` через `sendSandboxStateQuotaError`).
- **Ф-2 — семантика (ИНФО)**: per-sandbox квота на бизнес-записях — pre-check (used≥limit, включительно) + мягкое пересечение: запись, впервые превышающая лимит, принимается (2047 байт → 2261 байт прошло при лимите 2048). Строгая проверка (`persistRecord(rec, true, true)`) — только на импорте `/mock/state`. Контракт README («запись/импорт сверх бюджета → 400») фактически строг только для импорта.
- **Ф-3 — контракт (ИНФО)**: импорт — восстановление снимка: `mergeValidatedInto` удаляет ключи, отсутствующие в снимке (replace-семантика, пре-существующая); откат при отказе — к последнему принятому JSON (снимок до импорта в `rememberState`). В пробах пад добавлять в ПОЛНЫЙ снимок, иначе теряются ключи сервиса.

Итог пробы: **49/49, 0 failed** (лог — `wave105-01254d7/sz-wave105-probe-01254d7.txt`; полный npm-test — `wave105-01254d7/npm-test-01254d7.txt`).

---

### 2.11. Graceful shutdown + контейнерный харденинг (MS-04, `fcd3b05e`)

Транспорт: `sz-wave115-ms04-graceful-shutdown.js` (zero-dep, Node ≥ 18; ноги A/B/C). Предрегистрация — DoD issue #110 (написан ДО кода; по сигналу координатора опираемся на него). Запуск: `node docs/audit/tool-results/sz-prereg/sz-wave115-ms04-graceful-shutdown.js` из корня клона.

| нога (чек-лист сигнала) | доказательство на `fcd3b05e` |
|---|---|
| SIGTERM/SIGINT → exit 0 за ≤2 с | ✅ 8/8 прогонов (tbank/first-ofd/kontur-ofd/kassa × TERM/INT на живых стендах): exit 0 за 2–4 мс |
| идемпотентность shutdown | ✅ двойной SIGTERM в окне остановки → exit 0 без исключений |
| отложенная запись (окно 150 мс) — позитив | ✅ create + бизнес-запись (incoming) → мгновенный SIGTERM → рестарт: песочница жива, отложенная запись состояния спасена flush-ом |
| негатив-контроль SIGKILL | ✅ тот же сценарий с SIGKILL: песочница жива (create персистится немедленно — `persistRecord(rec, true)`), отложенная запись состояния ПОТЕРЯНА (окно 150 мс), default-маркер жив (синхронные записи `createStore.persist`) — полный контраст всех трёх уровней |
| харденинг compose×3 | ✅ 19 сервисов (default 8 / staging 2 / include 9): init+read_only+tmpfs /tmp+cap_drop ALL+no-new-privileges:true+pids_limit 256 — воспроизведено независимо mini-парсером YAML; кросс-проверка pyyaml согласна; jq-инвариант CI (#115) покрывает то же на `docker compose config` |
| docker stop → exit 0 ≤2 с | ☑ docker-нога в песочнице не воспроизводима (Docker нет — граница §7): `docker stop` шлёт SIGTERM на PID 1 — эквивалент покрыт ногой A (8/8 exit 0 ≤2 с); полный docker-smoke (секция 5) — за CI |
| отсутствие регрессий базлайна | ✅ core 77 · kassa 166 · first-ofd 104 · drift 732/732 (§1, поле-в-поле с сигналом) |

Итог пробы: **26/26, 0 failed** (лог — `wave115-fcd3b05e/sz-wave115-probe-fcd3b05e.txt`; полный npm-test — `wave115-fcd3b05e/npm-test-fcd3b05e.txt`).

### 2.12. Токены из query в заголовки/cookie (MS-06, `cc6761b`)

Транспорт: `sz-wave116-ms06-token-migration.js` (zero-dep, Node ≥ 18; 5 инстансов: tbank hosted-owned, tbank non-hosted с токеном `adm.eq=3x`, first-ofd owned, tbank hosted-namespaces, sber non-hosted) + добивки `sz-wave116-fixups.js`/`sz-wave116-fixups2.js`. Вердикт — по воспроизведённой пробе на ревизии сигнала `cc6761b` (squash #116). Уроки харнесса v1→v2/v3 (5 позиций переформулированы, не «провалены»; см. §6): в owned admission-слой закрывает `/admin` и `/admin/login` ДО логин-формы (Ф-5); формы с `_csrf` рендерятся только на реальных записях; в namespaces `POST /sandboxes` — switch-active (BC), не create.

| нога (чек-лист сигнала) | доказательство на `cc6761b` |
|---|---|
| hosted: query не даёт доступа; header/cookie работают | ✅ namespaces: `/admin` без кредов → 200 форма; `/admin?admin_token` → форма (не консоль); `/admin/journal?admin_token` → 401 + hint «Токены в query запрещены в hosted-режиме»; `/mock/sandboxes?operator_token` → 401. Доступ: cookie / `X-Mock-Admin-Token` / легаси `X-Admin-Token` / Bearer → консоль; `/admin/journal` по заголовку → 200; `POST /admin/login` → 302 + Set-Cookie → cookie дают консоль. В owned `/admin` без кредов → 401 admission (Ф-5) |
| cookie-атрибуты + CSRF-контур | ✅ `Set-Cookie: HttpOnly; SameSite=Strict; Path=/` (admin+operator); CSRF: без токена → 403 «invalid or missing CSRF token»; с `_csrf` из консоли (платёж создан валидным Init) + same-origin → 302 — контур жив, PB-14 не сломан |
| non-hosted: совместимость query + WARN | ✅ `/admin?admin_token` → консоль + WARN «приём … из query-строки устарел» в stderr; header → консоль без WARN; header с токеном, содержащим `=`, работает (`/admin/journal` → 200) |
| sandbox_token: cookie читается, в owned query отклоняется | ✅ owned tbank+first-ofd: `?sandbox_token` → 401 «знание ID не является доступом»; `X-Sandbox-Token` → admission пройден (Init с валидной подписью → 200 `PaymentId`); Cookie `mock_sandbox_token` → admission пройден. hosted-namespaces: `?sandbox_token` → принимается с WARN (нюанс Ф-3) |
| регресс базлайна | ✅ core 77 · kassa 167 · first-ofd 104 · drift 732/732 (§1, поле-в-поле с сигналом) |

**Находки владельцу** (чек-лист сигнала не блокируют):

- **Ф-1 — дефект (частичная миграция MS-06): токены возвращаются в URL, 8/9 адаптеров** (чист только kontur-ofd). (a) `POST /admin/action` redirect: `admin_token` (и `sandbox_token`) из query POST'а прокидываются в `Location` — tbank `:3401-3406`, kassa `:1976-1979`, yookassa `:1965-1968`, atol `:1524-1527`, alfa `:1983-1986`; живая проба: 302 `Location: /admin?admin_token=…`. (b) adminPage sber `:1177-1179` / vtb `:1279-1281` / first-ofd `:1688-1690`: `admin_token` из query, а в owned — **фактический owner-токен** (`ownerTokenOf(req)`) вставляются в ссылки консоли; live: HTML содержит `sandbox_token=<owner>` (first-ofd) и `admin_token=<токен>` (sber). Противоречит цели MS-06 (токены в URL → логи/Referer/история); в hosted это ещё и бесполезно — следующий запрос с query отклоняется. Формулировка PR #116 «action urls no longer retain query tokens» выполняется не полностью.
- **Ф-2 — дефект (minor): cookie encode/decode асимметрия** — `POST /admin/login` пишет `encodeURIComponent` (`adm.eq%3D3x`), `tokenMatches`/`ownerTokenOf` сравнивают RAW → закодированная cookie НЕ авторизует, сырая — авторизует; header/query работают. Токены с `=`, `;`, `&` через форму входа невозможны (ядро `:2018-2019`, `:2759` против `:3614-3621`).
- **Ф-3 — нюанс (ИНФО): hosted-NAMESPACES принимает query `sandbox_token` с WARN** — отклонение только в `mode === 'owned'` (ядро `:2769-2777`); live: `/v2/Init?sandbox_token` → 200 + WARN. Формула сигнала «hosted/owned — fail-closed» для sandbox_token верна только в owned; DX-хинт tbank `:2525` «В hosted-режиме query-токены запрещены» для hosted-namespaces неточен. Косметика: сентинел `FAIL_QUERY_TOKEN_REJECTED` (`:2773`) возвращается как «токен» и может попадать в журналы.
- **Ф-4 — латент (ИНФО): `core.checkAdminAuth` зовёт `tokenMatches` без `hosted`** — query-токен пропускает (`checkAdminAuth({url:'/admin?admin_token=k'}, 'k') === true`); адаптеры `checkAdminAuth` не используют (гейт везде `checkControlAccess`) — латентное API, стоит выровнять с fail-closed или пометить deprecated.
- **Ф-5 — наблюдение (ИНФО): в owned admission закрывает `/admin` и `/admin/login` до логин-формы** (401 admission вместо 200 формы) — форма входа в owned недостижима, header/cookie-пути работают; спот-проба координатора «/admin — форма» относится к hosted-namespaces (там подтверждено). Fail-closed безопаснее формы — не блокер.

Итог пробы: **37 проверок суммарно: v1 23/28 (5 — причины харнесса, переформулированы в v2/v3), v2 7/8, v3 1/1 — все позиции чек-листа сигнала зелёные** (логи — `wave116-cc6761b/sz-wave116-probe-cc6761b.txt`, `sz-wave116-fixups-v2.txt`, `sz-wave116-fixups-v3.txt`; полный npm-test — `wave116-cc6761b/npm-test-cc6761b.txt`; stderr-срезы WARN — `wave116-cc6761b/stderr-*.txt`).

---

## 3. Матрица волн — очередь и статусы

| волна | позиции | транспорт | статус |
|---|---|---|---|
| **#50** | PA-50, PA-54/55/56, PG-03, PG-10 | P2, P8, wave50-проба | ✅ **6/6 закрыто** на `f6e7cf3e` (issuecomment-6136181670; артефакты — PR #69) |
| **#51** | PG-11, PA-25(alfa), PF-01, PA-58, PA-26 | P9, wave51-проба, pf01/pa58 | ✅ **5/5 закрыто** на `97dcb71` (CI 5/5; логи — `docs/audit/tool-results/sz-prereg/wave51-97dcb71/`; pre-merge приёмка — issuecomment-6136335651 в PR #68) |
| **#52** | PA-51, PG-04, PG-09, PB-13 (расширение владельца) | P3/P3c, pb13, extras (R/L/CAP) | ✅ **4/4 закрыто** на `8b3304b` (CI 5/5; логи — `docs/audit/tool-results/sz-prereg/wave52-8b3304b/`; дополнения владельца: cap 200/8KiB → 400 `rule_cap_exceeded`/`rule_too_large` без новых статусов, жизненный цикл без наследования — extras L/CAP ✅) |
| **#53** | PD-02, PA-52 | pa52-b/c; PD-02: bench `wave-53` + `sz-wave53-persist-scope.js` (S/M/Q) | ✅ **2/2 закрыто** на `e8d9f93` (CI success; логи — `docs/audit/tool-results/sz-prereg/wave53-e8d9f93/`; prereg-pd02 выведена из эксплуатации — §6; PB-12 вне скоупа волны, дефект в силе, проба готова) |
| **#58** | PB-11≡PG-05, PB-12, PB-14, PC-17, PD-12, PE-19, PF-06, PG-06, PG-07, PG-08, PF-02 | pb11/pb12/pc17(адапт. владельцем)/pe19, P5(+P5b)/P6, wave58-тройка, статика (selftest-дифф, compose, SECURITY, реестр F) | ✅ **11/11 закрыто** на `6fe35a4` (расхождений с предрегистрацией нет; pc17-адаптация владельца подтверждена: 17a «не подтвердилось», 17b контроль 324/324, 17c диагностика честная `server=true, openapi=false`; PB-14 статика: ветки 413/CSRF/proto/410/429/квота 0→покрыто, check-вызовы 206→225; PD-12 include `:253`; PF-06 — приложение §7 отчёта F; логи — `docs/audit/tool-results/sz-prereg/wave58-6fe35a4/`) |
| **#60** | PG-01, PG-02 | P1, P1b, `sz-wave60-creds-faces.js` | ✅ **2/2 закрыто** на `7471db5` (CI 5/5; логи — `docs/audit/tool-results/sz-prereg/wave60-7471db5/`; sentinel-selftest #77 в регрессе — alfa 337) |
| **#81** | sber-mock (новый 7-й сервис): креды-hint, callbacks 3×60s+ACK, форк errorCode 1..6, PAN, SSRF-терминальность | `sz-wave81-sber-baseline.js` (5 инвариантов, 46/46) + npm-базлайн | ✅ **пробный проход 5/5** на `3f4dea2` (CI 5/5 — матрица #85; логи — `docs/audit/tool-results/sz-prereg/wave81-3f4dea2/`; sber введён 7-м сервисом в §1, см. §2.5) |
| **#87** | vtb-mock (новый 8-й сервис): OAuth TTL/истечение/обновление, Bearer + X-IBM-Client-Id (lowercase), идемпотентность orderId vs refundId, decimal-рубли, callbacks без нормализации (`Status`/`status`), PAN, SSRF-терминальность, [FORK]-карты | `sz-wave87-vtb-baseline.js` (8 групп инвариантов V1–V12, 62/62) + npm-базлайн | ✅ **пробный проход 8/8** на `1132955` (CI 5/5; логи — `docs/audit/tool-results/sz-prereg/wave87-1132955/`; vtb введён 8-м сервисом в §1, см. §2.6; банки РФ 5/5 верифицированы) |
| **#92** | first-ofd-mock (OKassa, 8-й сервис, :3107) — DoD issue #92: getToken (выдача/24ч/повтор), очередь transaction/{type} → requestId → status/transaction, statuses по externalId+groupId, /receipts за период (+пагинация), оба слоя ошибок API vs KKT, негативы, «знание ID ≠ доступ», callback+сверка | `sz-wave92-firstofd-dod.js` (8 групп DoD, 92/92) + npm-базлайн | ✅ **пробная верификация закрыта** на `6b01501` (вердикт по воспроизведённой пробе, не по диффу — команда координатора; логи — `docs/audit/tool-results/sz-prereg/wave92-6b01501/`; first-ofd введён в §1, см. §2.7; owned-наблюдение — вводные #98) |
| **#97** | kontur-ofd-mock (Контур.ОФД read-only, 9-й сервис, :3108): auth Sid+API-key (401002 ≠ 401003), Sid TTL 30 дней на виртуальных часах, organizations/cashboxes/documents (+types, пустой день), by-period (пагинация ≤1000, `paging.nextOffset`, [FORK] offset), документ по ID, суммы в копейках, write-путь 405/404, сценарии duplicate/fail/504, журнал без секретов, изоляция, legB owned | `sz-wave97-kontur-ofd.js` (12 групп K + legB, 71/71) + npm-базлайн | ✅ **пробная верификация закрыта** на `72627cd` (ожидания — предрегистрацией «до», расхождений нет; логи — `docs/audit/tool-results/sz-prereg/wave97-72627cd/`; kontur-ofd введён в §1, см. §2.8; самтест адаптера 109/109) |
| **#98** | ядро RFC-001/owned: приоритет `X-Sandbox-Token`/`X-Owner-Token` над `Authorization: Bearer` (ownerTokenOf, 12 строк) | `sz-wave98-owned-priority.js` (8 углов + кросс-классы, 19/19) + npm-базлайн | ✅ **пробная верификация закрыта** на `c4d5a82` («до»-контроль legE на `6b01501` — 401 дефект, «после» — 200; логи — `docs/audit/tool-results/sz-prereg/wave98-c4d5a82/`; см. §2.9) |
| **PD-02** (#105) | расширение закрытой в #53 позиции: env-квота `MOCK_SANDBOX_MAX_STATE_BYTES` (9 адаптеров) + глобальный бюджет `MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES`; границы env (пусто/число/0/мусор), отказ на записи и импорте, откат, освобождение (remove/reset/TTL), кэш размеров, дефолт, owned+namespaces | `sz-wave105-pd02-state-bytes.js` (8 ног, 49/49) + npm-базлайн | ✅ **пробный проход** на `01254d7` (базлайн поле-в-поле с сигналом; находки владельцу Ф-1/Ф-2/Ф-3 — §2.10; логи — `docs/audit/tool-results/sz-prereg/wave105-01254d7/`) |
| **MS-04** (#110/#115) | graceful shutdown (`installGracefulShutdown`: SIGTERM/SIGINT → sync flush → close → closeAllConnections → exit 0, fallback 1 с, идемпотентен) на девяти сервисах + compose-харденинг ×3 (init/read_only/tmpfs/cap_drop/no-new-privileges/pids_limit) | `sz-wave115-ms04-graceful-shutdown.js` (3 ноги, 26/26) + npm-базлайн | ✅ **пробный проход** на `fcd3b05e` (предрегистрация — DoD #110; базлайн поле-в-поле; docker-нога — CI (граница §7); логи — `docs/audit/tool-results/sz-prereg/wave115-fcd3b05e/`) |
| **MS-06** (#111/#116) | миграция управляющих токенов из query в заголовки/cookie: `tokenMatches` (Bearer / `X-Mock-Admin-Token` / легаси `X-Admin-Token` / `X-Operator-Token` / cookie), hosted fail-closed query + hint, `POST /admin/login` → HttpOnly/SameSite=Strict cookie, `sandbox_token` cookie/owned-отказ, CSRF-контур цел | `sz-wave116-ms06-token-migration.js` (5 ног A–E, 5 инстансов) + добивки `fixups`/`fixups2` + npm-базлайн | ✅ **пробный проход** на `cc6761b` (базлайн поле-в-поле; находки владельцу Ф-1…Ф-5 — §2.12; логи — `docs/audit/tool-results/sz-prereg/wave116-cc6761b/`) |
| core-хвост | PA-01 и не-alfa остаток партии A (PA-02…PA-33, PA-57, PA-59…PA-61) | DoD fix-PR + `npm test` (core) + точечные пробы | ⬜ по очереди владельца (§7 консолидированного отчёта) |

---

## 4. Покрытие всех серий (109 позиций: 90 дельты + 8 новых + 11 PG)

| серия | объём | чем верифицируется при закрытии |
|---|---|---|
| **PA** (core/рантайм) | 30 (+PA-54/55/56 пробой волны #50) | DoD fix-PR (колонка «предлагаемая задача» §2.1 консолидированного) + core-тесты + пробные позиции §2 (PA-50/51/54/55/56, PA-25/26/58) |
| **PB** (сироты ЮKassa/АТОЛ/alfa) | 14 | DoD fix-PR + kassa/atol/alfa самтесты; PB-11 — пробой `pb11-env-timeout.js` |
| **PC** (чекеры/CI/скрипты) | 17 | сами чекеры (`check:links/drift/upstream`), CI-прогоны; PC-17 — негативный контроль чекера |
| **PD** (compose/env) | 12 | compose-selftest + docker-smoke (в песочнице SZ Docker нет — верифицируется CI; в вердикте помечается) |
| **PE** (манифесты/OpenAPI/право) | 19 | `check:drift` + `check:links` + осмотр; PE-19 — пробой `pe19-admin-action-doc.js` |
| **PF** (хвосты 08.10) | 6 | PF-01 — пробой; PF-02…06 — grep/тесты/реестр |
| **PG** (alfa спец-аудит) | 11 | пробы P1–P9 + волновые (§2) — полный охват |
| **Итого** | **109** | каждая позиция имеет предписанный верификационный транспорт |

Границы: не-alfa позиции SZ верифицирует через DoD-регрессы владельца + регресс-контур §1; собственные живые пробы — там, где заведены (alfa целиком + kassa-гард + core-единицы). Это осознанное разделение: пробы SZ — независимый контроль, дублирующий selftest владельца не 1:1, а по граничным случаям.

---

## 5. Процедура волны (чек-лист SZ)

1. **Сигнал** координатора в #62: ревизия (хеш) + позиции волны.
2. **Свежий клон main**, checkout ревизии (если сигнал даёт не-HEAD хеш).
3. **«После»-прогон** проб волны (§2) → сравнение с предрегистрацией поле-в-поле.
4. При расхождении — **«до»-контроль** на дефектной ревизии (`e133a6b` для alfa-безопасности, `f89f76f` для базовых), различие артефакта харнесса и поведения сервера фиксируется явно.
5. **Полный регресс-контур** (§1), сверка с базлайном сигнала.
6. **Статусы** комментарием в #62 (таблица: позиция · проба · статус · доказательство); артефакты логов — PR в `docs/audit/tool-results/`.
7. Формальный ✅ — только по воспроизведённой пробе на фиксированной ревизии; осмотр диффа статуса не создаёт.

## 6. Особенности харнесса (учитывать при трактовке логов)

- **startAlfa** (`alfa-probes.js`, PR #69): слушатели stdout/stderr держатся до конца процесса, резолв +300 мс после детекта порта — boot-блок (креды/callbacks/control-plane) гарантированно в буфере. На ревизиях **до** адаптации P1/P5/P6-логи слепы (`undefined`) — артефакт харнесса, не сервера.
- `/health` **никогда** не содержал `guardOn` ни на одной ревизии — гипотеза сигнала #50 опровергнута; источник истины для P6 — стартовый лог.
- «До»-пробы pf01 на исправленном дереве падают по таймауту доставки — это и есть «после»-поведение; флип-логика вердикта учтена в prereg-бандле.
- **P3b** (`alfa-probes2.js`): на ruleless-флоу история сценариев пуста на ЛЮБОЙ ревизии — контроль `f89f76f` vs `4d70201` дал идентичный `false`. Операционная проба грани «orderId B в истории A» — **P3c** (с правилом `webhook-drop`, дифференцирующая). Для волны #52 ожидание P3b не применяется; «после»-вердикт — по P3+P3c.
- **P3c — артефакт cwd** (волна #52, `8b3304b`): `alfa-probe3c.js` спавнит сервер с захардкоженным `cwd: '/tmp/mock-services-alfa'` (старый клон `3c23641` — код ДО #71), вопреки конвенции README (резолв от `__dirname`, как в `alfa-probes.js`/`pb13-journal-cross.js`). Первый прогон дал «orderId B в истории A: true» на устаревшем коде; повтор с cwd на клон `8b3304b` — `false`. Вердикт — по корректному прогону; предложение владельцу: заменить хардкод на REPO-резолв (однострочный фикс пробы). Лог-пара — `wave52-8b3304b/` (`P3c-artifact-stale-cwd-3c23641.log` / `P3c-8b3304b-fixedcwd.log`).
- **Register-триггеры в истории ядра не содержат orderId/orderNumber** (schema записи: `{at, scenario, source, target}`) — грань «orderId B в истории A» эксплуатируется только через pay/3ds-контекст (P3c); для register-target изоляция доказывается отсутствием кросс-матча (P3: errorCode=0) и партициями (extras-R).
- **PA-52a (статика) — артефакт**: prereg-проба `pa52-queue-starvation.js` фаза-a ищет старый паттерн `let ticking=false` и на `e8d9f93` отчиталась «ПОДТВЕРЖДЕНО» при фактическом per-sandbox `WeakSet`-флаге — вшитое «до»-ожидание без флип-логики (родственник P3b). Вердикт волны — по динамике: PA-52b (медленный приёмник: 3/3 в одном проходе, старты [9,10,10]мс) + контроль PA-52c цел.
- **PD-02: prereg-проба выведена из эксплуатации** (`pd02-persist-amplification.js` после #72 падает по построению — `ENOENT registry.json`, единый файл упразднён; лог в `wave53-e8d9f93/`). Предложение координатора (сигнал 6143074896) принято владельцем prereg: транспорт PD-02 = бенч `wave-53/pd02-persist-bench.js` (симметрично: core `8b3304b` vs `e8d9f93` — 253 430 695 Б -> 24 980 Б на 100 мутаций, ~10⁴×; блокировка event-loop 9.42 -> 0.33 мс) + `sz-wave53-persist-scope.js` (S/M/Q).
- **Байтовая квота PD-02 — граница HTTP**: дефолт 8 МиБ > капы тела `readBody` 5 МиБ — переполнение импортом через HTTP недостижимо; ветка `SANDBOX_QUOTA_BYTES`+откат покрыта самотестом #72 и независимым core-репродом SZ (persist-scope Q, `maxStateBytes=2000`). Семантика импорта — replace-на-каждом-уровне (`mergeValidatedInto`, 8 вхождений уже в `8b3304b`) — пре-существующая, вне скоупа волны.
- **Debounce персиста 150 мс — пре-существующий** (`saveDelayMs` уже в `4d70201:2000`); SIGTERM-хендлера нет — мутации последнего окна <150 мс теряются при жёстком kill (ИНФО, вне скоупа волн; для мока некритично).
- **Волна #58 — уроки наблюдаемости** (`sz-wave58-pg07-terminal.js`): (1) `/mock/state` в hosted — управляющая поверхность с fail-closed (`MOCK_ADMIN_TOKEN` + `Authorization: Bearer` обязательны; probes2 P6 так и делал); (2) deposited-callback планируется только после завершения оплаты — доставочные пробы обязаны проводить полный флоу register→pay→3ds, иначе записи в `/mock/state` нет (первый прогон pg07-пробы); (3) терминальность PG-07 наблюдаема и по логу (`цель заблокирована политикой SSRF … ×1`, остаточный `retry in …` ≤1), и по записи (`dumped=true`, attempts заморожены).
- **PF-02 косметика (владельцу)**: sweep-строка печатается с двойным префиксом — `[yookassa-mock ts] [yookassa-mock] sandbox sweep: …`: хелпер `log()` уже тегирует строку, литерал в сообщении дублирует тег. Не дефект PF-02 (обломок `ock]` устранён), но шумно; аналогично проверить `log()`-обёртки alfa/kassa.
- **MS-06 харнесс (v1→v2/v3, `wave116-cc6761b/`)**: (1) в owned admission закрывает `/admin` и `/admin/login` ДО логин-формы (401 вместо 200-формы) — форму входа проверять в hosted-namespaces; (2) кнопки с `_csrf` рендерятся только на реальных записях (пустая консоль без форм) — для позитивного CSRF сначала создать платёж валидным Init (подпись `tokenOf`: sha256 скаляров top-level + Password, сортировка по ключу — воспроизведена в пробе); (3) в namespaces `POST /sandboxes` — switch-active (BC), не create (ownerToken наружу не отдаётся) — нюанс Ф-3 проверять прямым запросом с `?sandbox_token`.
- **PB-14 счётная грань**: заявка владельца «+65 проверок» — в терминах веток/под-проверок; наблюдаемые SZ числа: alfa selftest +19 check-вызовов (206→225), ИТОГ 337→360 (+23), дифф selftest +189/−3 строк. Все классы из prereg (413/CSRF/proto/410/429/квота/не-REST-сценарий) покрыты ≥1 check'ом (grep-дельта 0→3/0→6/0→6/2→5/0→2/1→3/13→15).
- **Sber-проба #81 — уроки харнесса и контракта** (§2.5): (1) `returnUrl` обязателен — его отсутствие даёт errorCode=5 с внятным hint (документированное расширение мока; первые регистры без него дали ложные «не errorCode=0»); (2) успешный ACS завершается **302 redirect на `returnUrl`**, не 200 — сверять код+Location; (3) `approved`-callback шлётся только в двухстадийном preAuth-флоу — одностадийный идёт straight to `deposited` (сервер корректен, ожидание пробы было неверным); (4) reverse после deposit легален до взаиморасчётов (`orderStatus=3`) — «неверное состояние» (errorCode=4) начинается только на повторных операциях; (5) лог-маркер SSRF — «заблокирован политикой SSRF» (литерал `SSRF_BLOCKED` в лог не попадает); (6) PAN-скан хранения — только REST-ответы/журнал/callbacks/лог: hosted-страницы содержат статичный каталог официальных тестовых карт (публичные синтетические данные); (7) `waitFor` в пробах обязан await'ить async-предикаты (health-поллинг), иначе старт сервера не ждётся; осиротевшие процессы прошлого прогона дают EADDRINUSE/EPIPE — чистый kill перед прогоном.
- **Vtb-проба #87 — уроки харнесса и контракта** (§2.6): (1) `tickVtb()` раз в секунду лениво удаляет истёкшие токены — 401 приходит с «Неизвестный access_token», а не «Срок действия access_token истёк» (вариант зависит от тика; инвариант — invalid_token именно от виртуальных часов, hint про expires_in); (2) крупный сдвиг часов (`+20m`) истекает и обновлённый токен (170s < 1200s) — после сдвига клиент обязан снова перевыпустить токен по expires_in, иначе бизнес-GET возвращает error-envelope (краш пробы на первом прогоне); (3) успех оплаты — **302 redirect на `returnUrl`** (как у Сбера — сверять код+Location); (4) PAYMENT-callback при preauth-холде НЕ уходит до complete — пробы холда обязаны завершать complete до ожидания доставки.
- **First-ofd-проба #92 — уроки харнесса и контракта** (§2.7): (1) lazy-purge токенов (`tickFirstOfd` раз в секунду + любой POST `/mock/time`) — после истечения 401 приходит с «Неизвестный токен», а не «Срок действия токена истёк» (родственник урока VTB; инвариант — invalid_token от виртуальных часов); (2) окно `/receipts` строить от `GET /mock/time` → `snapshot.now` (виртуальные часы), не от `Date.now()` — после сдвигов (+25h) реальное время даёт пустой каталог (первый прогон: total=0 при 8 ФД); (3) деньги в payload — десятичные рубли ЧИСЛАМИ (totalSum 200, price 100), строка «200.00» — только форма запроса; (4) `correctionCause` обязателен для receiptCorrection (без него 400 `field=document.correctionCause`); (5) field/hint в HTTP-error envelope — top-level (`{error:{code,text,layer}, field, hint, doc}`), не внутри `error`; (6) маркеры SSRF в логе — «заблокирован политикой SSRF» и терминальная строка «— терминальный отказ, без повторов» (литерал `SSRF_BLOCKED` в лог не попадает — урок #81), а строка `retry in …` от ядра печатается и для терминальных записей — считать попытки по строкам `webhook N error/failed`, не по «retry»; (7) `GET transaction/{id}` отдаёт эхо-тело только для receipt-типов (rawRequest), для StateCommandRequest — без поля request; (8) приёмник callback обязан стартовать ДО перевода часов: доставка идёт тиком очереди после обработки заявки.
- **Kontur-проба #97 — уроки харнесса и контракта** (§2.8): (1) два уровня 401 не путаются: `401002` = сессия (нет/истёк Sid), `401003` = API-ключ (нет/неверный ключ даже с валидным Sid); инвариант — по `errorCodeId` (ориентир), envelope несёт message/field/hint/doc; (2) пароль `authenticate-by-pass` — UTF-8 body (в query только login); (3) пагинация by-period: курсор — `paging.nextOffset`, `null` = терминальный (страницы 5+5+2 без потерь/пересечений, ASC); [FORK] разрешён в пользу `offset` — `currentOffset` → 400 с подсказкой «используйте offset», limit=0/1001 → 400; (4) пустой день/период = 200 + пустой список — НЕ ошибка; (5) суммы — целые копейки (totalSum/cashSum/electronicSum, items[].price/sum) — контраст с банковскими decimal-рублями (#81/#87): парсеры рублей переиспользовать нельзя; (6) write-путь не моделируется: POST на read-маршрут → 405, неизвестный write-маршрут → 404 «write API не моделируется» — проверять 405/404, а не «успешное создание»; (7) журнал redacted: записи at/method/path/status/ms, body/headers пустые, пароля/Sid/API-key нет; (8) legB owned: rotation кредов отзывает старый Sid (→ 401 401002); owner-token сам не авторизация данных (без Sid → 401 401002); `/sandboxes/me` не раскрывает креды; экспорт state без Sid.
- **Owned-проба #98 — уроки харнесса и контракта** (§2.9): (1) в hosted fail-closed owner-заголовок обязателен уже на `/getToken` — бизнес-токен очереди без owner не получить (ожидаемое поведение fail-closed, наблюдение владельцу ИНФО); (2) fallback-угол «только Bearer<owner-token>» проверять на `/mock/state`, не на бизнес-эндпоинте: там Bearer<owner> даёт 401 бизнес-слоя — это не отказ fallback; (3) «пустой/пробельный источник = отсутствует»: `X-Sandbox-Token: '  '` + валидный `X-Owner-Token` → 200; непустой источник затеняет последующие; (4) query-затенение: непустой Bearer затеняет query (401), пустой `Authorization: Bearer` — не затеняет (200, единообразие); (5) кросс-классы: Bearer-класс (first-ofd/vtb) — углы (а)/(h) 200 «после»; не-Bearer (atol) — X-Sandbox-Token без регресса; прирост 29 проверок npm-базлайна = DoD-проверки приоритета (core +3, atol +4, alfa +4, vtb +9, first-ofd +9).
- **PD-02-проба #105 — уроки харнесса и контракта** (§2.10): (1) учёт байт — `Buffer.byteLength(JSON.stringify(rec.state))` с кэшем по версии записи; в пробах размер снимать по `GET /mock/state` (tbank — двойная обёртка `{sandbox, state:{…,state}}`, first-ofd — одноуровневая `{sandbox, state}`); (2) импорт = replace-снимок (Ф-3): пад добавлять в ПОЛНЫЙ снимок — иначе `mergeValidatedInto` удаляет ключи сервиса и бизнес-путь падает 5000 (counters undefined); (3) пад-арифметика `bytes({…snap, pad:'x'.repeat(n)}) = bytes({…snap, pad:''}) + n`; factory-состояния дрейфуют на ±1 байт (seed в `initialStateFactory`) — пад калибровать от фактического снимка, не переиспользовать между песочницами; границы надёжнее бинпоиском (max-пад → 200, +1 байт → 400 used==limit+1); (4) env-парсер `parseMsOr` — duration-парсер: `'1024'` → 1024 байта, но `'1h'` → 3600000 «байт» (молчаливое принятие единиц времени — наблюдение владельцу DX); пусто/мусор → fallback `null` → дефолт (8 МиБ при `maxDocuments>0`, иначе без лимита); `'-5'` → `Math.max(0,…)` → 0 (выключено); (5) глобальный бюджет — сумма по ВСЕМ песочницам включая default; выселение TTL ленивое (по доступу) + sweep раз в минуту — TTL в пробах держать с запасом к длительности ног.
- **MS-04-проба #115 — уроки харнесса и контракта** (§2.11): (1) персистентная асимметрия: create песочницы — `persistRecord(rec, true)` немедленно, бизнес-записи — `scheduleRegistrySave(150 мс)`; SIGKILL в окне теряет только отложенные записи состояния — негатив-контроль строить вокруг бизнес-записи, не вокруг create; (2) порты из логов: три формата стартовой строки («on http://host:PORT», «listening on :PORT» — kontur, «on 127.0.0.1:PORT» — kassa) — единый regex `on (?:https?:\/\/)?[^\s:]*:(\d+)`; (3) compose-инвариант без docker: mini-парсер YAML (flow-массивы, комментарии вне кавычек, отступы 2/4) согласован с pyyaml на всех 19 сервисах — CI-jq воспроизводим без docker-окружения; (4) `createStore.persist` синхронный — default-состояние переживает SIGKILL; контраст «sync default / deferred registry» — встроенный контроль негативных ног.

## 7. Что этот набор НЕ делает

- Не заменяет selftest владельца (правило: DoD fix-PR первичен, проба SZ — независимый контроль).
- Не покрывает docker/compose-пути живьём (нет Docker в песочнице) — только через CI.
- Не проводит повторный полный аудит: новые находки вне волновой очереди заводятся отдельным аддендумом по прецеденту §2 консолидированного отчёта.
