© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Аудит-партия A — Ядро: вход, состояние, лимиты — 2026-10-12 (сводный отчёт)

> **База:** `main` @ `05696f3` · версия `0.5.0` · Node v24.21.0 · режим: только чтение.
> **Baseline:** `npm test` зелёный на `05696f3` (core 41/41, tbank PASSED, kassa 141/141, yookassa 227/227, atol 202/202, upstream 11/11, links 57, drift 221/221).
> **Методология:** [`CHECKLIST-audit-party.md`](CHECKLIST-audit-party.md), §4.A [`AUDIT-PREP-2026-10-12.md`](AUDIT-PREP-2026-10-12.md).
> **Исполнение:** партия выполнена тремя под-агентами по непересекающимся диапазонам `packages/core/index.js` (2670 строк) — детальные отчёты:
> [`AUDIT-PARTY-A1a-2026-10-12.md`](AUDIT-PARTY-A1a-2026-10-12.md) (строки 1–546),
> [`AUDIT-PARTY-A1b-2026-10-12.md`](AUDIT-PARTY-A1b-2026-10-12.md) (546–1335),
> [`AUDIT-PARTY-A2-2026-10-12.md`](AUDIT-PARTY-A2-2026-10-12.md) (1335–2670).
> Диапазоны ID: PA-01…PA-24 → A-1a, PA-25…PA-49 → A-1b, PA-50…PA-99 → A-2 (коллизий нет).

## §1. Итог

**30 находок: blocker ×1, major ×2, minor ×18, info ×9.** Каждый диапазон ядра прочитан полностью; все security-утверждения подтверждены прогонами `node -e` / живыми HTTP-пробами на `127.0.0.1:0`.

Ответы на вопросы партии (§4.A AUDIT-PREP):

1. **State-фасад вне контекста запроса:** вне контекста отдаются `activeId`/default (документировано). Обход `admit()`/policy — **да, есть**: все явные-id API рантайма (`exportState/importState/reset/updateCreds/remove`) не авторизуют target → **PA-50 (blocker)**; плюс байпас `public`/`form`-политик через `defaultOwnerToken` — PA-54.
2. **Обход admit()/policy:** PA-50, PA-54, гонка `switchActive` в namespaces — PA-55, `run()` при неуспешном admission — PA-56.
3. **Чужая песочница через retention/sweep/export:** sweep изоляцию не ломает; export/import/reset — **ломают** (PA-50, воспроизведено HTTP-пробой: владелец A читает и сбрасывает состояние B во всех 4 адаптерах). Export отдаёт весь state, включая notifications; owner-token'ов в нём нет.
4. **tickAll и чужие очереди:** утечки контента нет, но **starvation**: общий флаг `ticking` без await → за проход доставляется максимум одна песочница — **PA-52 (major)**.
5. **Unbounded-рост:** журнал — эвикция работает, но unknown-ключи обходят лимит (PA-27, до ~190 МБ); очередь вебхуков без eviction/капа, O(n) тик (PA-28); `rules` сценариев без cap (PA-51); state песочниц при TTL=0 растёт (дубль PD-07). createLog/journal/history — ограничены.
6. **safeEqual на не-ASCII:** корректен (байтовое сравнение, fail-closed на NFC/NFD); неточен только docstring о длине — PA-53.
7. **[VERIFY]-закрытие:** MS-08 — закрыт (таблица 28 входов `parseMsOr`: fallback/клампы; остаток: нет max-клампа — PA-30, дубль tbank `parseInt||0` — PF-03); MS-14 — закрыт (ровно 48 бит, 200k id, 0 коллизий; PaymentId монотонный, окна ±10 с перебираемы ~10k запросов, form-страницы без rate-limit); MS-17 — закрыт (prototype pollution НЕ подтверждена: `safeStateSnapshot` + null-proto + defineProperty; 5 форм загрязнения отброшены; остаток — регресс-тест); MS-20 — закрыт (Content-Length не сверяется — PA-05; остальное по брифу); MS-38 — закрыт (ни один сервис не передаёт `now` в рантайм, core:1913; полные следствия — PA-59).

## §2. Сводный реестр находок (полные формулировки и прогоны — в под-отчётах)

| ID | sev | модуль | файл:строка | суть (кратко) | отчёт |
|---|---|---|---|---|---|
| PA-50 | **blocker** | sandbox runtime | core:2299-2339, 2269-2285, 2235-2237 | Явные-id API (`exportState/importState/reset/updateCreds/remove`) без авторизации target: владелец любой песочницы читает/перезаписывает/сбрасывает чужую; паттерн один во всех 4 адаптерах; HTTP-проба подтверждена | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-51 | **major** | scenario registry | core:1419-1522 | Реестр сценариев один на процесс: правило A срабатывает на трафике B; история A содержит orderId B; rules без cap (30k → +108 мкс/запрос всем) | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-52 | **major** | queue + tickAll | core:1016, 2368-2376 | Общий флаг `ticking` + tickAll без await → за проход доставляется ≤1 песочница; голодание очередей чужих арендаторов | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-53 | minor | auth | core (safeEqual) | docstring врёт про поведение на разной длине; байтово корректен, fail-closed на NFC/NFD | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-54 | minor | sandbox policy | core:2175-2177, 2200-2204 | `public`/`form`-политики в owned обходят заданный `MOCK_SANDBOX_TOKEN`; дефолт fail-open | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-55 | minor | sandbox manager | core (switchActive) | гонка переключения активной песочницы в namespaces | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-56 | minor | sandbox runtime | core (run) | `run()` выполняется при неуспешном admission | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-57 | minor | sandbox persist | core:1954-1972 | creds песочниц (terminal/ferma-пароли) в `MOCK_STATE_FILE` открытым текстом, права 664; owner-token хеширован — ок | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-58 | minor | queue SSRF | core:994 | дефолт `blockPrivateHosts=false` в ядре (fail-open) — класс PF-01 | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-59 | minor | virtual clock | core:1913 + все сервисы | полные следствия wall-clock в рантайме песочниц: TTL, expired-admit, sweep/retention ts, окно createLimit, createdAt | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-60 | info | sandbox runtime | core (times) | `times:0` превращается в 1 | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-61 | info | legacy | core (createSandboxManager) | legacy-ветка менеджера песочниц | [A2](AUDIT-PARTY-A2-2026-10-12.md) |
| PA-25 | minor | postJson | core:770-772 | hostname со скобками IPv6 → `ENOTFOUND`: вебхуки на IPv6-мерчанта пережигают 24 попытки; после снятия скобок mapped-обход §2.1 становится эксплуатируемым | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) |
| PA-26 | minor | SSRF-гард | core:846-874 | fail-open классы: ff00::/8, развёрнутый loopback `::0:1`, десятичный v4 `2130706433` (закрыт WHATWG), TEST-NET×3, 2001:db8::/32, 64:ff9b:1::/96 | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) |
| PA-27 | minor | journal | core:705-707 | unknown-ключи обходят «гарантию размера» записи (проба: 1 002 022 симв.) | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) |
| PA-28 | minor | queue | core (queue) | без eviction/капа; O(n) тик (52 мс @200k); poison без терминального маркера | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) |
| PA-29 | minor | queue | core (prepare) | prepare(+1) + onFailure(+1) → attempts ×2, maxAttempts исчерпывается одной попыткой | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) |
| PA-30 | minor | parseMsOr | core:1134-1170 | нет max-клампа: `1e21` → таймер 1 мс, `deadlineMs=1e21` → мгновенный abort (остаток MS-08) | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) |
| PA-31 | info | queue logs | core | полный URL (userinfo/query) в логах очереди без редакции | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) |
| PA-32 | info | parseMsOr | core | `'1h30m'`/`'1e3'` → тихий fallback | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) |
| PA-33 | info | journal | core | `at` записи журнала по wall-clock | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) |
| PA-01 | minor | parseBody | core:267 | битый %-энкод → не пойманный URIError → 500 вместо 400 (живая проба kassa `/admin/action`) | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) |
| PA-02 | minor | redact | core:476, 337-340 | три утечки форменного rawBody мимо редакции: `password_confirmation`, `a=1&&password=x`, `token%5F2` | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) |
| PA-03 | minor | redact | core:394 | PAN-сканер пропускает Amex (3-префикс) и Bearer<8 | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) |
| PA-04 | minor | redact | core | молчаливая обрезка: массивы >100, глубина >12 → `'[…]'` | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) |
| PA-05 | minor | readBody | core | Content-Length не сверяется с фактическим телом (дополнение MS-20) | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) |
| PA-06 | info | readBody | core | deprecated `aborted` | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) |
| PA-07 | info | escapeHtml | core:284-298 | backtick/`javascript:` не обрабатываются; sink-ов не найдено | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) |
| PA-08 | info | parseBody | core | недокументированное поведение: last-wins, литеральные `key[]`, BOM→{} | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) |
| PA-09 | info | redact | core | fragment `#token=` не редактируется в curl-генераторе | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) |

## §3. Покрытие

| Диапазон | Прочитан полностью | Отчёт |
|---|---|---|
| core 1–546 | ✅ | [A1a](AUDIT-PARTY-A1a-2026-10-12.md) §3 |
| core 546–1335 | ✅ | [A1b](AUDIT-PARTY-A1b-2026-10-12.md) §3 |
| core 1335–2670 | ✅ | [A2](AUDIT-PARTY-A2-2026-10-12.md) §3 |

## §4. Дубли/уже поставленное

`§2.1/§2.2/§2.4` AUDIT-PREP (SSRF-mapped-bypass, entropy, clock) — подтверждены прогонами, новых ID не завели; PA-58 — класс PF-01; PA-30/PF-03 — остаток MS-08; PA-59 — детализация MS-38; PD-02/PD-07 (партия D) — не дублировались; PD-02 примыкает к зоне core (реестр песочниц) — ведётся в партии D.

## §5. Прогоны

Baseline координатора — зелёный (шапка). Прогоны-доказательства каждой под-партии — в её §5 (`node -e` команды + вывод, HTTP-пробы на `127.0.0.1:0`); scratch-доказательные базы: `/tmp/partyA1a-scratch/`, `/tmp/partyA1b-scratch/`.

## §6. Критерии приёмки §4.A

- [x] По каждой из 6 зон — находки `файл:строка` + прогон-доказательство
- [x] `[VERIFY]`-пункты MS-08/MS-14/MS-17/MS-20/MS-38 закрыты (§1 п.7)
- [x] Находка уровня «можно прочитать чужую песочницу» воспроизведена скриптом (PA-50, HTTP-проба)
- [x] Ни одного изменения поведения (read-only; единственные файлы — отчёты)
