© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Аудит-партия C — Инфраструктура доверия: CI, образы, скрипты проверок — 2026-10-12

> **Пакет:** [#43 — прогон агент-брифа и подготовка к глубокому аудиту](https://github.com/rucorp/mock-services/issues/43), §4.C [AUDIT-PREP-2026-10-12.md](AUDIT-PREP-2026-10-12.md)
> **База:** `main` @ `05696f3` · версия `0.5.0` · Node в песочнице `v24.21.0`
> **Режим:** только чтение. Код, CI, compose и манифесты не менялись; единственный добавляемый файл — этот отчёт. Единственное отступление — разрешённые координатором scratch-эксперименты: копия репозитория `/tmp/partyC-scratch` (`cp -a`), в которой внесены намеренные поломки; `/tmp/mock-services` не изменялся.
> **Документы связки:** [чек-лист партии](CHECKLIST-audit-party.md) · [аудит-преп §4.C](AUDIT-PREP-2026-10-12.md) · [реестр #15](REGISTRY-2026-10-11-code-sweep.md) · [AGENTS.md](../../AGENTS.md)

---

## 1. Итог

Главный вопрос партии — **«может ли CI остаться зелёным при реальной поломке?»** — ответ: **может, в двух слоях**.

1. **`check:drift` — декоративный к ряду поломок.** Сверка «манифест ↔ реализация» держится на
   `String.includes()` по тексту `server.js` (`scripts/check-protocol-drift.js:60-62,71-73`):
   маршрут, карта или статус, удалённые из реализации, но оставленные в комментарии или строке-подсказке,
   засчитываются как «реализовано». Экспериментально: удаление реализации `/mock/state` (E1) и **всех 12
   тестовых карт** (E3) оставляет чекер зелёным (221/221) при красном selftest сервиса. Обратное тоже
   верно: переформулировка комментария ломает «инвариант» без изменения кода (E5) — чекер меряет текст,
   а не поведение. Единственная реальная защита сквозного контура — selftest'ы сервисов.
2. **Compose/docker-контур вне `npm test`.** `test:docker`/`test:compose` не входят в обязательный
   локальный прогон (`package.json:7`); в CI контур закрыт job `docker`
   (`.github/workflows/ci.yml:42-93`), который стартует на `pull_request`/`push` — то есть
   PR-прогон compose покрывает, но локальный gate по AGENTS §2 — нет, а при недоступности
   Actions/`[skip ci]` контур непроверяем вообще.

Остальные чекеры: `check:links` слеп к `CHANGELOG.md`/`AGENTS.md`/`*.html` и к reference-style ссылкам
(E2/E4); `check:upstream` и weekly-workflow **всегда exit 0** — дрейф первоисточников физически не может
покрасить CI; `docker-smoke` прогоняет 2 из 4 сервисов и не исполняет healthcheck-пары 3102/3103;
`compose-selftest` глотает ошибки выделения песочниц и пропускает F-33-проверку при `tenancy=off`.

Слой публикации: `publish-ghcr` на каждый push `main` перетирает мутабельные `:0.5.0`/`:latest`
(`ci.yml:123-130`; дубль §1.1/MS-01), **никакой шаг CI не верифицирует** пин `MOCK_IMAGE_DIGEST`
в `docker-compose.include.yml:30,82,131,178` и не делает `pull` опубликованного тега —
расхождение пина с реальным образом накапливается молча (существование дайджеста из GHCR из песочницы
непроверяемо — см. §5). Git-тег `v*` вообще не сверяется с `package.json` version (PC-07).
Плюс новые мелочи: нет `concurrency` (гонки публикации, PC-05) и нет top-level `permissions` (PC-06).

**Статистика:** 16 новых находок (major ×1, minor ×13, info ×2), 6 дубликатов существующих пунктов (§4),
5 экспериментов-поломок + 1 контрольный замер (§2b).

**Предложения по усилению (списком, без правок):**

1. `check:drift`: матчить маршруты/методы по следам *регистрации* (`p === '…'`, `pathname.startsWith`, ключи карт), а не по любому вхождению подстроки; добавить в CI негативный контроль чекера (синтетический «пустой» сервер должен его красить — иначе регресс самого чекера незаметен).
2. `check:drift`: инварианты АТОЛ, привязанные к тексту комментария (`'второй чек не создаётся'`, арифметика TTL), перевести на проверку кода (именованные константы) или behavior-тест.
3. `check:links`: включить `CHANGELOG.md` (и по решению владельца `AGENTS.md`) в scope; поддержать reference-style `[x][y]`; якорную валидацию — по возможности.
4. Вернуть доверие к публикации: в `publish-ghcr` — шаг `docker pull` опубликованных тегов + сверка digest с `MOCK_IMAGE_DIGEST`; в `test` — гард соответствия git-тега `v*` и `package.json` version; `concurrency`-группы для всех workflow.
5. `sync-upstream`: добавить строгий режим (`--fail-on=changed`) или step-обвязку, краснящую CI по `--json`-отчёту; иначе weekly-сверка — лог в никуда.
6. `compose-selftest`: не глотать ошибку `provisionSandboxes` (fail-fast); исполнять F-33-проверку и в `tenancy=off` (warn → check).
7. `docker-smoke`: добавить контейнеры ЮKassa/АТОЛ (или отдельный прогон `docker-healthcheck.js` парами 3102/3103).

---

## 2. Реестр находок

Формат §2 REGISTRY-2026-10-11-code-sweep.md. Severity — для текущего кода на `05696f3`; находки,
дублирующие MS-/F-/A-, в реестр не заводились (см. §4).

| ID | модуль | файл:строка | категория | severity | суть | предлагаемая задача | зависимости |
|---|---|---|---|---|---|---|---|
| PC-01 | drift-чекер | `scripts/check-protocol-drift.js:60-62,71-73,77-83,97,126-127,190-196` | correctness | major | Сверка манифест↔реализация выполняется `String.includes()` по всему тексту `server.js`: совпадение в комментарии или строке-подсказке засчитывается как реализация маршрута/метода/статуса/карты/кода ошибки. Подтверждено экспериментами E1 (удалён `/mock/state`, чекер 221/221 зелёный, selftest красный) и E3 (удалены все 12 тестовых карт из `CARDS`, чекер зелёный). Инвариант «реализовано» держится на наличии литерала, а не на регистрации маршрута. | **Перевести дрейф-чекер на следы регистрации.** DoD: для каждого класса инвариантов задан паттерн места регистрации (`p === '…'`, ключ объекта, константа); в CI есть негативный контроль (чекер падает на синтетически вычищенном `server.js`); поломки E1/E3 красят `check:drift`. | MS-37, MS-18 (ЮKassa вне манифестов); AGENTS §8 фиксирует проблему без измерения |
| PC-02 | drift-чекер | `scripts/check-protocol-drift.js:200-208` | correctness | minor | «Инварианты» АТОЛ проверяются наличием текста **комментария** (`:203` — `'второй чек не создаётся'`; `:202` — арифметическая строка TTL `24 * 60 * 60 * 1000`). Переформулировка комментария даёт ложный drift при неизменном коде (E5: 220/221, exit 1); сохранение комментария при удалённой идемпотентности даёт ложный проход. | Заменить комментарий-якоря на поведенческие проверки (тест идемпотентности существует и зелёный) или именованные константы, разделяемые чекером и кодом. | PC-01; зона АТОЛ партии B |
| PC-03 | links-чекер | `scripts/check-docs-links.js:23,24,32,54-58` | dx | minor | Scope: только `README/CONTRIBUTING/SECURITY + docs/ services/ packages/` и только `.md`; `CHANGELOG.md`, `AGENTS.md`, `NOTICE`, `.github/**`, все `*.html` (в т.ч. `docs/reference/tbank-api/*.html`, 407 КБ) — вне проверки; regex `LINK_RE` не распознаёт reference-style `[текст][ref]` и `[текст]( путь )` с пробелом (E2: битая ссылка в CHANGELOG не замечена; E4: битая ref-style-ссылка в самом `README.md` не замечена). Якоря `#…` отбрасываются без валидации — по построению. | Расширить список корневых файлов минимум на `CHANGELOG.md`; добавить разбор reference-определений; критерий — E2/E4 красят чекер. | MS-07 (судьба `.html`-копий — партия E) |
| PC-04 | npm test / CI | `package.json:7`; `.github/workflows/ci.yml:42-93` | dx | minor | `test:docker` и `test:compose` не входят в `npm test`; compose-контур закрыт только job `docker`. События: `push` (main, `v*`) и `pull_request` — то есть в PR compose-селфтест **запускается** (`ci.yml:82-83`), но локальный обязательный прогон по AGENTS §2 compose не проверяет; при недоступности Actions, `[skip ci]` или удалении/переименовании job контур теряет защиту незаметно. | В CI — маркер-шаг «compose-контур активен» (или job-имя в конфиге чекеров); в документации первого экрана явно: `npm test` зелёный ≠ compose зелёный. | AGENTS §2 (зафиксировано), MS-33 |
| PC-05 | CI / publish | `.github/workflows/ci.yml:5-10` (нет `concurrency:`), `118-130` | resilience | minor | Ни один workflow не задаёт `concurrency`: два быстрых push в `main` дают параллельные `publish-ghcr`, одновременно пушащие одни и те же мутабельные теги `:0.5.0`/`:latest` (неатомарно, «кто последний»), плюс дублирующиеся прогоны `test`/`docker` без отмены устаревших. | `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }` для `test`/`docker`; для `publish-ghcr` — очередь без отмены. | PC-07; MS-01 |
| PC-06 | CI / permissions | `.github/workflows/ci.yml:11-17,100-102` | security | minor | Top-level `permissions:` в `ci.yml` нет — jobs `test`/`docker` работают с дефолтными правами `GITHUB_TOKEN` (в отличие от `publish-ghcr`: `contents: read` + `packages: write`, и от `sync-upstream.yml:10-11`: `contents: read` задан). | Добавить `permissions: { contents: read }` на верхнем уровне `ci.yml`; job-специфичные — как сейчас. | — |
| PC-07 | CI / релиз | `.github/workflows/ci.yml:8,98,114,123-130` | correctness | minor | Публикация триггерится git-тегом `v*`, но теги образа вычисляются из `package.json` (`VERSION`), без сверки `refs/tags/vX` ↔ `X`: пуш `v9.9.9` соберёт и опубликует образ с тегами `:0.5.0`/`:latest`; `:latest` двигается и от тегов, и от обычных push `main`. Расширение известного «мутабельного `:0.5.0`» (§4): источник несоответствия — отсутствие assertion. | Шаг-гард в `publish-ghcr`: при `refs/tags/v*` сверять тег с `package.json` version, иначе fail. | MS-01 |
| PC-08 | upstream-сверка | `scripts/sync-upstream.js:11-12,317`; `.github/workflows/sync-upstream.yml:23-24` | resilience | minor | `check:upstream` **всегда exit 0** (`return 0` независимо от статусов `changed`/`not-checked`; это заявлено в шапке «report-only»): еженедельный job может быть зелёным при полном дрейфе всех первоисточников — сигнал существует только как текст в логе, алертов нет; scheduled-workflow вдобавок автоотключается GitHub при 60 днях неактивности репозитория. | Явный контракт отчёта: step после прогона парсит `--json` и краснит при `changed`-строках (или отдельный строгий режим по расписанию, оставив мягкий в `npm test`). | MS-37; партия E |
| PC-09 | upstream-selftest | `scripts/sync-upstream-selftest.js:9-59` | correctness | minor | `test:upstream` (11 ассертов) покрывает `extractSourceUrls`, `classifyResult`, `fetchFingerprint` (моки), детерминизм `serializeSnapshot` — но не покрывает `readSnapshot` (валидация schema/дублей/режимов), `updateSnapshot`/`--update` (единственная пишущая ветка, `sync-upstream.js:222-244`) и лимит тела/timeout. Регресс в снапшот-логике не красит `npm test`. | Добавить кейсы: невалидный snapshot (schemaVersion/дубль URL/неизвестный mode → ошибка), `updateSnapshot` сохраняет skip-режим и старый отпечаток при не-check ответах, переполнение `MAX_BODY_BYTES`. | — |
| PC-10 | compose-selftest / F-33 | `scripts/compose-selftest.js:138-159,155-157,161-178,461-486,488-490` | correctness | minor | Изоляция F-33 хрупка: `provisionSandboxes` глотает ошибку выделения песочницы (`catch` → `console.warn` → сценарий идёт «как получится»); проверка «прогон не изменил default-счётчики» целиком **пропускается** при `tenancy=off` (`:471-486`) — ровно в режиме, где песочниц нет; fallback уборки при неудаче `DELETE /mock/sandboxes` — `POST /mock/reset` (`:174`), который при провалившейся изоляции сбрасывает **default**-состояние стенда. Счётчики сравниваются по 5/4/2/3 ключам, не по полному состоянию. | Fail-fast на ошибке provision (или явный check «песочница выделена»); при `tenancy=off` — предупреждение→check, а не тихий пропуск; заменить fallback-сброс на повторное удаление. | MS-27, MS-31 (дефолт tenancy) |
| PC-11 | healthcheck | `scripts/docker-healthcheck.js:20-29`; `scripts/docker-smoke.js:101-112` | correctness | minor | Пары 3102/`/health` (ЮKassa) и 3103/`/health` (АТОЛ) в `KNOWN_SERVICES` не исполняются ни одним CI-прогоном: smoke останавливает перебор на первой успешной паре (tbank→3100, kassa→3101), а compose/include используют inline-`healthcheck` с явной парой. Опечатка в третьей/четвёртой паре будет найдена только потребителем, запустившим сервис без `MOCK_PORT`. | В smoke добавить запуск yookassa/atol-контейнеров без env (или unit-тест `KNOWN_SERVICES` на соответствие парам из compose/include). | PC-12 |
| PC-12 | docker-smoke | `scripts/docker-smoke.js:95-151` | dx | minor | Smoke реально проверяет: healthy tbank (default CMD) и kassa (CMD из шапки), `mock:mock`/UID 10001, persist/restore при `--read-only` + volume, живой healthcheck под read-only. Не проверяет: ЮKassa/АТОЛ (2 из 4 сервисов), отдачу `/openapi.json`, поведение протокола (только health + Init + `/mock/state`), состав образа. | Расширить smoke контейнерами 3102/3103 (минимум health) — закрывает и PC-11; состав образа проверить `docker run --rm IMAGE ls` против ожидаемого списка. | PC-11; F-35/F-36 |
| PC-13 | CI / install | `.github/workflows/ci.yml:23-24` | resilience | info | В zero-dependency репозитории `npm install` создаёт сетевую зависимость job `test` от registry: недоступный npm красит CI при неповреждённом коде. Шаг нужен только «для npm-контекста» (комментарий `:23`) — ни один последующий шаг его не требует. | Убрать шаг `npm install` из job `test` (или зафиксировать lockfile — но `package-lock.json` в репо нет, PC-14). | — |
| PC-14 | package.json | `package.json:4,25-27,50-61` | dx | info | `private: true` делает `files`/`engines` декоративными: `npm pack --dry-run` — 39 файлов (E6), при этом `CHANGELOG.md` в пакет **не входит** (npm не авто-включает), а `scripts` кладётся целиком (7 файлов, рантайму нужен 1 — `docker-healthcheck.js`); `engines: >=18` разрешает EOL-рантаймы (дубль MS-40) и без `.npmrc` `engine-strict` не enforced. `package-lock.json` в репо нет — CI генерирует свой на каждом прогоне. | Зафиксировать назначение пакета: публикация (тогда `CHANGELOG.md` в `files`, `engines` на 22) или отказ (убрать мёртвые поля); решение владельца. | MS-40 |
| PC-15 | CI / матрица | `.github/workflows/ci.yml:14-17,37-40` | dx | info | `check:links` и `check:drift` исполняются во всех трёх узлах матрицы Node: битая ссылка/дрейф красит 3 job'а и не зависит от Node (частично признано в AGENTS §2). | Вынести docs-чеки в отдельный дешёвый job (или шаг с `if: matrix.node == '22'`). | — |
| PC-16 | links-чекер | `scripts/check-docs-links.js:24,40-50` | correctness | minor | `LINK_RE` сканирует сырой текст без учёта code-fence/inline-code: дословное цитирование примера битой ссылки в документации (в т.ч. в аудиторских отчётах) даёт **ложное срабатывание** чекера. Подтверждено этим отчётом дважды: (1) первая редакция с дословными цитатами команд E2 красила `check:links` (`:128,134`); (2) generic-плейсхолдер `[текст]( отн.путь )` в таблице §2a (`:90`) — тот же механизм. Оба сняты пробелом после `(` (не матчится `[^)\s]+`). | Фильтровать содержимое code-fence/inline-code перед матчингом; негатив-тест «цитата битой ссылки в блоке кода — зелёный». | PC-03 |

---

## 2a. Проверка → что реально детектирует

По всем 7 скриптам `scripts/`. Колонка «НЕ ловит» подкреплена экспериментами §2b, где применимо.

| Скрипт (запуск) | Что реально детектирует | Минимальная поломка, которую ЛОВИТ | Минимальная поломка, которую НЕ ловит |
|---|---|---|---|
| `check-protocol-drift.js` (`check:drift`) | Полное отсутствие литерала маршрута/метода/статуса/карты/кода в тексте `server.js` + отсутствие пути в OpenAPI JSON | Маршрут удалён из кода **и** нигде больше не упоминается; путь вычищен из `docs/openapi/*.json`; статус исчез вместе со всеми вхождениями | E1: маршрут удалён, литерал живёт в комментарии/подсказке; E3: все тестовые карты удалены из `CARDS`, PAN-строки в комментарии; E5 (ложный триггер): переформулирован комментарий при неизменном коде; весь контур ЮKassa (манифеста нет); семантика (порядок полей, значения) — по построению |
| `check-docs-links.js` (`check:links`) | Битые inline-ссылки `[текст]( отн.путь )` в 57 `.md`-файлах scope (README/CONTRIBUTING/SECURITY + docs/ services/ packages/) — включая цитаты внутри code-fence/inline-code (ложные срабатывания, PC-16) | E2-контроль: `[битая]( docs/integration/no-such-guide-inline.md )` в `README.md` → `README.md:173`, exit 1 | E2: битая ссылка в `CHANGELOG.md` (вне scope); E4: reference-style `[текст][ref-x]` даже внутри scope; `*.html` (в т.ч. копии Т-Банка), `AGENTS.md`, `NOTICE`, `.github/**`; якоря; `[текст]( путь )` с пробелом |
| `sync-upstream.js` (`check:upstream`) | Ничего не детектирует в смысле exit-кода: report-only, `return 0` всегда (`:317`); падает только на невалидном snapshot-файле или аргументах | (падение) Битый `protocols/upstream-snapshot.json` (schemaVersion≠1, дубль URL, неизвестный mode) — исключение → exit 1 | Дрейф/исчезновение всех первоисточников (`changed`/`not-checked` → текст в логе, exit 0); 401/403/429/5xx от источников; страницы в `mode: skip`; изменившееся тело при неизменном etag |
| `sync-upstream-selftest.js` (`test:upstream`) | Юнит-поведение extract/classify/fetch/serialize на моках (11 ассертов) | Поломка `extractSourceUrls` (нормализация/дедуп/сортировка), `classifyResult` (baseline-missing/skip/unchanged/changed), детерминизма сериализации | `readSnapshot`, `updateSnapshot`/`--update`, лимит `MAX_BODY_BYTES`, timeout-ветка (PC-09); реальный снапшот не участвует |
| `docker-smoke.js` (`test:docker`) | Healthy tbank (default CMD) и kassa (CMD из шапки) через встроенный HEALTHCHECK; `mock:mock`/UID 10001; persist/restore при `--read-only`+volume; живой healthcheck под read-only | Сломанный default CMD; отказ `/healthz` кассы; откат `USER` на root; поломка persist/restore; удаление HEALTHCHECK (таймаут 45 c → throw) | ЮKassa/АТОЛ (PC-12); протокол/эндпойнты (только health+Init+`/mock/state`); дрейф base-образа/дайджеста; порты 3900-3902 захардкожены (конфликт на занятом раннере → ложное падение, не проход) |
| `compose-selftest.js` (`test:compose`) | Чёрный ящик сквозных сценариев всех 4 сервисов: health, OpenAPI 3.1.0 (tbank/kassa), tbank-чарджбэк, Ferma-цепочка, ЮKassa payment→refund, АТОЛ v4 + негативы; неизменность default-счётчиков (F-33) при tenancy≠off | Умерший сервис/порт; сломанный сквозной сценарий; утечка прогона в default-состояние (при tenancy≠off); отсутствие `/openapi.json` (tbank/kassa) | Ошибка выделения песочницы (проглочена, PC-10); F-33 при `tenancy=off` (тихий пропуск); расхождение содержимого `/openapi.json` с `docs/openapi` (проверяется только `openapi==='3.1.0'` и наличие 1 пути); полнота default-состояния (ключи-подмножество); сборка образа (её делает job) |
| `docker-healthcheck.js` (HEALTHCHECK образа) | Доступность ровно одной пары порт/путь: `MOCK_PORT`/`MOCK_HEALTH_PATH` авторитетны, иначе перебор `KNOWN_SERVICES` до первого 200 | Падение процесса; порт не слушается; не-200 на health-пути (для 3100/3101 — подтверждено smoke) | Неверная пара 3102/3103 в `KNOWN_SERVICES` — ни один CI-прогон её не исполняет (PC-11); «здоровый» процесс с неверным `MOCK_HEALTH_PATH` (env авторитетны — by design) |

---

## 2b. Лог экспериментов (поломка → чекер → вердикт)

Все поломки вносились **только** в `/tmp/partyC-scratch` (`cp -a /tmp/mock-services /tmp/partyC-scratch`;
`git rev-parse --short HEAD` → `05696f3`). `/tmp/mock-services` не изменялся (проверка — §5).

**База (до поломок):**
```
$ cd /tmp/partyC-scratch && node scripts/check-protocol-drift.js | tail -3
Проверено инвариантов контракта: 221, пройдено: 221, расхождений: 0
Дрейф протоколов не обнаружен ✅
$ node scripts/check-docs-links.js
docs links OK: 57 файлов, битых ссылок нет
```

**E1 — drift-чекер не замечает удаления маршрута** (строка живёт в комментариях
`tbank server.js:315,1086`; реализация — `:2630`):
```
$ sed -i "2630s|/mock/state|/mock/stxte|" services/tbank-mock/server.js
$ node scripts/check-protocol-drift.js | tail -3
Проверено инвариантов контракта: 221, пройдено: 221, расхождений: 0
Дрейф протоколов не обнаружен ✅        ← exit 0, ложный проход
$ node services/tbank-mock/selftest.js | tail -2
SELFTEST FAILED ❌: SyntaxError: Unexpected token 'o', "not found" is not valid JSON
```
Вердикт: **поломка НЕ обнаружена check:drift — ложный проход подтверждён** (маршрут манифеста
`protocols/tbank-eacq.json:57 → mockControlRoutes` мёртв; ловит только selftest). Синтезированный
инвариант: «маршрут объявлен в манифесте и OpenAPI, но не реализован» — проходит `check:drift`.

**E2 — links-чекер не видит CHANGELOG.md:**
```
$ printf '\n0.6.0-plan\n- [несуществующая цель]( docs/integration/no-such-guide.md ) — намеренно битая относительная ссылка.\n' >> CHANGELOG.md
$ node scripts/check-docs-links.js
docs links OK: 57 файлов, битых ссылок нет    ← exit 0, ложный проход
```
Контроль в scope (тот же каталог цели, `README.md`):
```
$ printf '\nКонтроль: [битая inline-ссылка]( docs/integration/no-such-guide-inline.md ).\n' >> README.md
$ node scripts/check-docs-links.js; echo "exit=$?"
Битые относительные ссылки в документации:
  README.md:173 -> docs/integration/no-such-guide-inline.md
exit=1
```
Вердикт: **поломка НЕ обнаружена — ложный проход подтверждён** (scope слеп к CHANGELOG; контроль ловится).

Примечание к цитатам: в блоках выше после `(` добавлен пробел (реальные команды — без него):
первая версия отчёта с дословными цитатами команд красила сам `check:links` (`docs/audit/AUDIT-PARTY-C-2026-10-12.md:128,134`),
потому что regex не отличает цитаты в code-fence от живых ссылок — см. PC-16.

**E3 — drift-чекер не замечает удаления всех тестовых карт** (PAN-строки осознанно оставлены
в блочном комментарии, `CARDS = {}`):
```
$ node -e "…замена блока 'const CARDS = {…};' на '/* ЭКСПЕРИМЕНТ PC: … <оригинальный блок> */
const CARDS = {};'…"
CARDS заменён на пустой объект, PAN остались в блочном комментарии
$ node scripts/check-protocol-drift.js | tail -3
Проверено инвариантов контракта: 221, пройдено: 221, расхождений: 0
Дрейф протоколов не обнаружен ✅        ← exit 0, ложный проход
```
Вердикт: **поломка НЕ обнаружена — ложный проход подтверждён** (12 проверок `tbank:test-card`,
`check-protocol-drift.js:81-84`, прошли по комментариям).

**E4 — links-чекер не видит reference-style ссылку даже в scope:**
```
$ printf '\nКонтроль ref-style: [текст][ref-x]\n\n[ref-x]: docs/integration/no-such-guide-ref.md\n' >> README.md
$ node scripts/check-docs-links.js; echo "exit=$?"
Битые относительные ссылки в документации:
  README.md:173 -> docs/integration/no-such-guide-inline.md   ← только inline; ref-style молчит
exit=1
```
Вердикт: **поломка НЕ обнаружена — ложный проход подтверждён** (в одном прогоне inline пойман,
ref-style `[ref-x]: docs/integration/no-such-guide-ref.md` — нет; regex `check-docs-links.js:24`
не знает синтаксис).

**E5 — drift-чекер даёт ложную тревогу на переформулированный комментарий** (код идемпотентности
АТОЛ не менялся):
```
$ node -e "…s.replace('второй чек не создаётся', 'повтор external_id схлопывается в исходный чек')…"
$ node scripts/check-protocol-drift.js | tail -4
Проверено инвариантов контракта: 221, пройдено: 220, расхождений: 1
  ✗ [atol:invariant] идемпотентность: повтор external_id возвращает прежний uuid — инвариант нарушен в server.js
$ node scripts/check-protocol-drift.js >/dev/null 2>&1; echo "exit=$?"
exit=1
```
Вердикт: **ложное срабатывание подтверждено** — «инвариант» якорится к тексту комментария
(`check-protocol-drift.js:203`).

**E6 — состав npm-пакета (контрольный замер, поломки не требует):**
```
$ npm pack --dry-run | tail -6
npm notice total files: 39   ← LICENSE, NOTICE, README.md, docker-compose.include.yml,
                                docs/integration(5), docs/openapi(3), package.json,
                                packages/core(3), protocols(4), scripts(7), services(12)
```
Вердикт: `CHANGELOG.md` в пакет не входит; `scripts` кладётся целиком (PC-14).

---

## 3. Покрытие области

| Файл | строк | покрытие |
|---|---|---|
| `.github/workflows/ci.yml` | 130 | прочитан полностью (1-130) |
| `.github/workflows/sync-upstream.yml` | 24 | прочитан полностью (1-24) |
| `scripts/check-protocol-drift.js` | 247 | прочитан полностью (1-247) |
| `scripts/check-docs-links.js` | 67 | прочитан полностью (1-67) |
| `scripts/sync-upstream.js` | 339 | прочитан полностью (1-339) |
| `scripts/sync-upstream-selftest.js` | 64 | прочитан полностью (1-64) |
| `scripts/docker-smoke.js` | 158 | прочитан полностью (1-158) |
| `scripts/compose-selftest.js` | 495 | прочитан полностью (1-495) |
| `scripts/docker-healthcheck.js` | 43 | прочитан полностью (1-43) |
| `Dockerfile` | 55 | прочитан полностью (1-55) |
| `package.json` | 62 | прочитан полностью (1-62) |
| `docker-compose.include.yml` (пин образа) | 229 | прочитан полностью (в сопряжении с партией D) |
| `protocols/tbank-eacq.json` | 105 | прочитан полностью (для синтеза инвариантов E1/E3) |

Вне области партии (не читались, кроме точечных grep для экспериментов): `services/*/server.js`
(партии A/B), `docker-compose.yml`, env-поверхность (партия D), `docs/reference/**`/манифесты Ferma/АТОЛ
(партия E), реестр #15 (партия F).

**Непроверяемо из песочницы** (фиксируется как есть, без утверждений): фактическое состояние GHCR
(существует ли digest `sha256:5e2b03…` пина `docker-compose.include.yml:30`, публичность пакета) — GHCR
недоступен; любые docker/compose прогоны (нет Docker); поведение раннеров GitHub (форс Node 24,
миграция `ubuntu-latest` на Ubuntu 26 с 2026-10-19) — принято по логу прогона `38265251073`,
приведённому в брифе (MS-40).

---

## 4. Дубли и уже поставленное

Новые ID **не заводились** для:

| Факт | Дубль | Подтверждение по базе 05696f3 |
|---|---|---|
| Мутабельные теги `:0.5.0`/`:latest` на каждый push `main` | §1.1 AUDIT-PREP, **MS-01** | `ci.yml:114,123-130` — теги из `package.json`, пуш на каждый push без условий |
| Нет `pull`-проверки опубликованного тега / верификации пина `MOCK_IMAGE_DIGEST` | **MS-01** (пункт «в силе») | в `ci.yml` нет ни одного `docker pull`/inspect; пин `docker-compose.include.yml:30,82,131,178` ниоткуда не сверяется |
| Матрица Node 18/20 — оба EOL; раннеры форсируют Node 24 | **MS-40** `[DECISION]` | `ci.yml:17` = `['18','20','22']`, `package.json:26` = `>=18`, образ на 22 (`Dockerfile:20`); MS-40 предлагает (a) min 22 + CI 22/24, (b) 20/22/24, (c) оставить; партия C подтверждает данные брифа и дедлайн: `ubuntu-latest` мигрирует на Ubuntu 26 с 2026-10-19 → вариант (c) живёт не дольше недели |
| `COPY scripts` целиком в образе (из 7 скриптов нужен 1) | **MS-29** | `Dockerfile:28`; `HEALTHCHECK` вызывает только `scripts/docker-healthcheck.js` (`Dockerfile:50-51`) |
| `docker compose down -v` есть в CI, нет в документации | **MS-27** | `ci.yml:91-93` (`if: always()`); упоминаний в `*.md` — 0 |
| `check:drift` сверяет подстрокой (маршрут в комментарии = реализация) | AGENTS §8, **MS-37** (упомянуто без измерения) | PC-01 добавляет воспроизведение (E1/E3) и оценку major |

Связи с другими партиями: PC-02 — зона АТОЛ партии B; PC-03 — `.html`-вопрос MS-07 (партия E);
PC-10 — MS-31 (дефолт tenancy, партия D); PC-05/PC-07 — расширение MS-01, а не дубль (конкретные
дефекты: отсутствие assertion тега и concurrency-групп).

---

## 5. Прогоны

| # | Команда | Результат |
|---|---|---|
| 1 | `cd /tmp/mock-services && git rev-parse --short HEAD && git status --short` | `05696f3`; до партии — чисто; после — только новый файл отчёта `docs/audit/AUDIT-PARTY-C-2026-10-12.md` |
| 2 | scratch: `node scripts/check-protocol-drift.js` | база 221/221 ✅ → E1: 221/221 ✅ (ложный проход) → E3: 221/221 ✅ (ложный проход) → E5: 220/221 ✗ (exit 1, ложная тревога) |
| 3 | scratch: `node scripts/check-docs-links.js` | база: 57 файлов ✅ → E2: ✅ (ложный проход) → E2-контроль: ✗ `README.md:173` (exit 1) → E4: ✗, но ref-style не назван |
| 4 | scratch: `node services/tbank-mock/selftest.js` (контроль реальности E1) | `SELFTEST FAILED ❌` (маршрут мёртв) |
| 5 | scratch: `npm pack --dry-run` | 39 файлов; `CHANGELOG.md` вне пакета (E6) |
| 6 | `node -v` | v24.21.0 |
| 7 | `npm run check:links` в /tmp/mock-services после добавления отчёта | первая редакция — ✗ (цитаты E2 в code-fence, PC-16, `:128,134`); после изоляции цитат пробелом — «58 файлов, битых ссылок нет» ✅; `npm test` не запускался (docs-only, baseline зелёный по worklog координатора) |

Docker/GHCR-прогоны (`test:docker`, `test:compose`, `docker pull`) в песочнице невозможны — не выполнялись
ни в базовой, ни в scratch-копии; их состояние принято по зелёной job `docker` CI (run `38259475582`,
бриф MS-01).

---

## 6. Чек-боксы критериев приёмки (AUDIT-PREP §4.C)

- [x] Таблица «проверка → что реально детектирует → минимальная поломка, которую ловит / НЕ ловит» по всем 7 скриптам — §2a.
- [x] ≥3 намеренно внесённых поломки в рабочей копии (только локально, не в PR) с подтверждением «ловит/не ловит» — §2b: E1, E2 (+контроль), E3, E4, E5 (5 поломок) + E6 (замер).
- [x] Находки формата реестра — §2 (PC-01…PC-16: major ×1, minor ×13, info ×2).
- [x] Предложения по усилению — списком, без правок — §1.
- [x] Формат отчёта по чек-листу партии: шапка, §1 итог, §2 реестр, §2a/§2b, §3 покрытие, §4 дубли, §5 прогоны.
- [x] Режим партии: `/tmp/mock-services` — только создание отчёта; поломки — только в `/tmp/partyC-scratch`.
- [ ] Обновление §3/§6 AUDIT-PREP и §0.1 брифа — вне полномочий партии (координатору; партии C запрещено править чужие доки).
