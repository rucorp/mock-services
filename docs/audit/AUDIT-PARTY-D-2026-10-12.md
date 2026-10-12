© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Аудит-партия D — Контур размещения: compose, env, hosted — 2026-10-12

> **Пакет:** [#43 — прогон агент-брифа и подготовка к глубокому аудиту](https://github.com/rucorp/mock-services/issues/43), §4.D [AUDIT-PREP-2026-10-12.md](AUDIT-PREP-2026-10-12.md)
> **База:** `main` @ `05696f3` · версия `0.5.0` · Node в песочнице `v24.21.0`
> **Режим:** только чтение. Код, тесты, compose, CI и манифесты не менялись; единственный добавляемый файл — этот отчёт. Docker в песочнице **недоступен** — всё через анализ кода и точечные `node -e` (порты 3100–3103 не поднимались, `npm test` не запускался по инструкции координатора).
> **Область (файлы: строки):** `docker-compose.yml` (1–122), `docker-compose.include.yml` (1–228), все `MOCK_*` env (60 имён, читаемых серверами + `MOCK_HEALTH_PATH`), `SECURITY.md` (1–113), `docs/rfc/RFC-001-multi-tenant-sandboxes.md` (1–160), env-таблицы и разделы hosted в `services/{tbank,kassa,yookassa,atol}-mock/README.md` (прочитаны полностью: 199/185/220/239 строк), `scripts/docker-healthcheck.js` (1–43), `Dockerfile` (1–55), env-блоки и точки использования в `services/*/server.js` и `packages/core/index.js` (фрагменты построчно, см. §3).
> **За рамками:** построчная вычитка тел 4 адаптеров (зоны партий A/B), `scripts/compose-selftest.js` и `docker-smoke.js` (зона C — PC-04/PC-10/PC-11/PC-12), CI-workflows (зона C), юридический блок `docs/reference/**` (зона E, MS-07), GHCR/registry-факты.
> **Документы связки:** [чек-лист партии](CHECKLIST-audit-party.md) · [аудит-преп §4.D](AUDIT-PREP-2026-10-12.md) · [реестр #15](REGISTRY-2026-10-11-code-sweep.md) · отчёты [B](AUDIT-PARTY-B-2026-10-12.md)/[C](AUDIT-PARTY-C-2026-10-12.md)/[E](AUDIT-PARTY-E-2026-10-12.md)/[F](AUDIT-PARTY-F-2026-10-12.md) · [SECURITY.md](../../SECURITY.md) · [RFC-001](../rfc/RFC-001-multi-tenant-sandboxes.md)

---

## 1. Итог

Ответ на главный вопрос партии («можно ли включать `MOCK_HOSTED=1` на голом железе?»): **на публичный стенд — сегодня нельзя; на loopback/периметре для dev/staging — можно**. Полный чек-лист go/no-go — §2b; кратко:

1. **Блокер публичного стенда №1 — унаследованный PF-01** (партия F): дефолт кассы `MOCK_BLOCK_PRIVATE_WEBHOOKS = 'false'` отключает SSRF-гард даже при `MOCK_HOSTED=1` (`services/kassa-mock/server.js:50,90`).
2. **Новый major — PD-02**: реестр песочниц перезаписывается **целиком** (`writeFileSync`) на каждую мутацию любой песочницы с debounce 150 мс; байтовых квот нет (`maxDocuments` считает количество, тело запроса до 5 МБ), `mem_limit` в include — 128 МБ. Один арендатор с большим чеком/платежём превращает каждое сохранение в write-амплификацию O(суммарное состояние всех 100 песочниц) и/OOM-kill контейнера.
3. Из 61 env-имени env-поверхности **13 отсутствуют в include-файле** (уточнение §2.6: точная сверка по границам слова даёт 13, а не 14), **3 не документированы нигде** (`MOCK_FN_CAPACITY`, `MOCK_OFD_MODE`, `MOCK_OPERATOR`-кассир), `MOCK_HEALTH_PATH` не читается ни одним сервером (только healthcheck-скриптом).
4. Ответ на вопрос брифа «какие env прочитаны и проигнорированы»: `MOCK_SANDBOX_SWEEP_MS` мёртвая в дефолтном `namespaces`-режиме (sweep-воркер не стартует при TTL=0/квоте=0/retention=0 — PD-03); `MOCK_SANDBOX_HOST_SUFFIX` живая, но **без wildcard DNS/TLS не срабатывает никогда** и молча выдаёт в `POST /sandboxes` URL несуществующего домена; `MOCK_SANDBOX_MAX_DOCUMENTS` вопреки опасению брифа **работает и при ttl=0** (квота проверяется при создании документа независимо от sweep, а условие запуска sweep включает `MAX_DOCUMENTS > 0`).
5. docker-compose.yml и include — **поведенчески эквивалентны на дефолтах** (проверено построчным сравнением env), но неэквивалентны по поверхности: root compose не пропускает `MOCK_HOSTED`/токены/tenancy (PD-01), поэтому совет `README.md:150` «задайте MOCK_HOSTED=1» с root-файлом просто не срабатывает. «Канонический» для hosted — include (MS-24 подтверждена: 4×дублирование healthcheck, без якорей).
6. Healthcheck-пары портов/путей **согласованы во всех трёх местах** (root compose, include, `KNOWN_SERVICES` в `docker-healthcheck.js`) и совпадают с фактическими маршрутами серверов; остаток — PC-11 (пары 3102/3103 не исполняются ни одним CI-прогоном).
7. SECURITY.md ↔ код расходится минимально (формулировки аккуратные), RFC-001 ↔ код — существенно (дефолт tenancy, модель хранения, окно rate-лимита, `/metrics`, RPS-квоты) — MS-31 подтверждена и расширена (PD-10).

Сводка реестра: **11 находок — major ×1, minor ×10**; дубли/подтверждения — §4.

## 2. Реестр находок

Формат — §2 [REGISTRY-2026-10-11-code-sweep.md](REGISTRY-2026-10-11-code-sweep.md). Severity относится к текущему коду; `blocker`/`major` — применительно к hosted/public deployment.

| ID | модуль | файл:строка | категория | severity | суть | предлагаемая задача | зависимости |
|---|---|---|---|---|---|---|---|
| PD-01 | root compose / hosted-поверхность | `docker-compose.yml:14-26,44-51,69-79,97-110` vs `docker-compose.include.yml:55-65,106-114,153-161,204-211`; `README.md:150-156`; `SECURITY.md:24` | dx | minor | `docker-compose.yml` не пропускает в контейнеры ни `MOCK_HOSTED`, ни `MOCK_ADMIN_TOKEN`/`MOCK_OPERATOR_TOKEN`, ни `MOCK_TENANCY`/`MOCK_SANDBOX_*` (environment фиксирован; `MOCK_BLOCK_PRIVATE_WEBHOOKS` — только закомментированный комментарий). `MOCK_HOSTED=1 docker compose up` молча игнорируется: compose `environment:` не транзитивен к env хоста. Совет «Для публичного размещения задайте `MOCK_HOSTED=1`» ([README.md:150](../../README.md)) и строка «rate limit, TTL» в [SECURITY.md:24](../../SECURITY.md) **не работают с root-файлом как есть** — требуется правка файла или переход на include. В include переменные пропущены корректно. | Дописать в README (раздел «Безопасность») и в шапку root compose явное разграничение: «для hosted-контура используйте include или свой compose с транзитивными env; root compose — локальный дев-стенд»; либо добавить в root compose транзитивные строки с пустыми дефолтами. DoD: `MOCK_HOSTED=1 docker compose up tbank-mock` даёт в логах `hosted=true` без правки файлов. | MS-24 |
| PD-02 | core / реестр песочниц | `packages/core/index.js:1954-1997` (registryPayload/flushRegistry), `:1999-2006` (persistRecord → debounce 150 мс), `:2130-2136` (checkDocuments — счёт без байтов); `services/kassa-mock/server.js:433-460` (без лимита `items.length`); `docker-compose.include.yml:72,121,168,218` (`mem_limit: 128m`) | resilience | **major** (для hosted; minor для self-hosted) | Каждая мутация состояния **любой** песочницы планирует перезапись **всего** реестра (JSON со состояниями всех песочниц) синхронным `writeFileSync`. Квота `MOCK_SANDBOX_MAX_DOCUMENTS` ограничивает число документов, но не их размер (тело запроса до 5 МБ, `readBody` `packages/core/index.js:206`; чек Ferma не ограничивает `items.length`), а `maxDocuments` в owned = 5000/песочница × 100 песочниц. Итог: под hosted-нагрузкой каждая регистрация документа вызывает синхронную запись файла размером O(суммарное состояние всех песочниц) прямо в event-loop; с `mem_limit: 128m` — прямая дорога к OOM-kill или деградации latency всей ноды. RFC-001 §4 предлагал «один JSON-файл на песочницу» — консолидация в один реестр и создала амплификацию. | Ограничить стоимость сохранения: per-sandbox файлы (как в RFC §4) или байтовую квоту на состояние/документ (`maxStateBytes`), либо персистить только затронутую песочницу. Добавить регресс: 1000×`sell` с чеком на 1000 позиций не вырождает latency и не превышает бюджет записи. DoD: замер «размер записи × мутаций» линеен по затронутой песочнице. | Возможен дубль с партией A (зона core); MS-13 (квоты), MS-25 (mem_limit) |
| PD-03 | env-семантика / sweep | `services/tbank-mock/server.js:3395-3401`, `services/kassa-mock/server.js:941-947`, `services/yookassa-mock/server.js:2089-2095`, `services/atol-mock/server.js:908-914`; README: `services/tbank-mock/README.md:182`, `services/kassa-mock/README.md` (строка `MOCK_SANDBOX_SWEEP_MS`) | correctness | minor | `MOCK_SANDBOX_SWEEP_MS` — «прочитана и проигнорирована» в дефолтном режиме: sweep-воркер стартует только при `SANDBOX_TTL_MS > 0 || SANDBOX_MAX_DOCUMENTS > 0 || SANDBOX_RETENTION_MS > 0`, а в `namespaces` (дефолт include при незаданном `MOCK_HOSTED`) все три равны 0. Просроченные песочницы при этом удаляются «по касанию» (`packages/core/index.js:2196-2199`), но никогда — если к ним не обращаются (мусор остаётся в реестре и занимает cap 256, переживая рестарты). README описывает переменную как «интервал воркера TTL/retention» без условия запуска. | Задокументировать условие («воркер стартует при TTL>0, квоте>0 или retention>0») в env-таблицах; рассмотреть предупреждение при старте, если `MOCK_SANDBOX_SWEEP_MS` задан, но ни одно из трёх условий не выполнено. DoD: строка в README + лог-подсказка. | §2.6 env-doc-drift |
| PD-04 | healthcheck / env | `scripts/docker-healthcheck.js:27-29` vs `services/tbank-mock/server.js:2588`, `services/kassa-mock/server.js:1336`, `services/yookassa-mock/server.js:1762`, `services/atol-mock/server.js:1345`; compose: `docker-compose.yml:16,46,71,99`, `docker-compose.include.yml:39,91,140,187` | dx | minor | `MOCK_HEALTH_PATH` — единственная переменная env-поверхности, которую **не читает ни один сервер**: health-маршруты захардкожены (`/health` у tbank/yookassa/atol, `/healthz` у kassa). При `docker run -e MOCK_PORT=3100 -e MOCK_HEALTH_PATH=/ping` healthcheck сначала пробует `/ping` (404), затем `/healthz` (404) → healthy-сервис объявляется unhealthy. В compose значения согласованы (три места совпадают, §3), но переменная обещает конфигурируемость, которой у серверов нет, и не описана ни в одном README. | Либо вынести health-путь в сервер (читать `MOCK_HEALTH_PATH` как алиас маршрута), либо в README/Dockerfile пометить «путь не меняется; переменная — только для скрипта healthcheck». DoD: поведение зафиксировано документом; `MOCK_HEALTH_PATH=/ping` больше не даёт unhealthy-контейнер при живом сервисе. | PC-11 (неисполняемые пары) |
| PD-05 | include / naming | `docker-compose.include.yml:192` (`MOCK_GROUPS: "${MOCK_ATOL_GROUPS:-}"`) vs `:99` (kassa: `MOCK_GROUPS: "${MOCK_GROUPS:-${FERMA_GROUP:-Main}}"`); `services/atol-mock/README.md:182` | dx | minor | Pass-through групп непоследователен: для kassa глобальная `MOCK_GROUPS` из окружения потребителя доходит до контейнера, для atol — **нет** (только через `MOCK_ATOL_GROUPS`, которая не документирована нигде, включая README atol, где документирована именно `MOCK_GROUPS`). Потребитель, следующий README atol и задавший `MOCK_GROUPS`, изменит kassa, но не atol. | В include:192 передавать `MOCK_GROUPS` напрямую (`"${MOCK_GROUPS:-${MOCK_ATOL_GROUPS:-}}"`), `MOCK_ATOL_GROUPS` задокументировать как алиас (или удалить). DoD: `MOCK_GROUPS=Main,Shop-1` меняет разрешённые группы в обоих контейнерах; строка в README atol. | MS-02 |
| PD-06 | env-документация кассы | `services/kassa-mock/server.js:110,151,58,628-632`; `services/atol-mock/server.js:134-140`; README: `services/kassa-mock/README.md` (env-таблица), `services/atol-mock/README.md:181-184`; `docker-compose.include.yml` (отсутствие строк) | docs | minor | Уточнение §2.6 (env-doc-drift) по кассовому контуру: живые переменные, не описанные **нигде**: `MOCK_FN_CAPACITY` (kassa:110, ёмкость ФН в `/fn/state` и заполненность), `MOCK_OFD_MODE` (kassa:58→:114, стартовый режим ОФД), `MOCK_OPERATOR` (kassa:631, atol:138 — имя кассира в чеке; не путать с `MOCK_OPERATOR_TOKEN`). Живые, описанные только в README atol, но не проходящие через include: `MOCK_FN_NUMBER`, `MOCK_ECR_RN`, `MOCK_OFD_INN`, `MOCK_FNS_SITE` (kassa-экземпляры :629-632 не описаны вовсе), `MOCK_AGENT_LINE`/`MOCK_AGENT_INN` (у atol include-строки нет). | В README кассы добавить строки для `MOCK_FN_CAPACITY`, `MOCK_OFD_MODE`, `MOCK_OPERATOR`, `MOCK_FN_NUMBER`, `MOCK_ECR_RN`, `MOCK_OFD_INN`, `MOCK_FNS_SITE`; в include — либо строки для всех 7 кассовых реквизитов обоих сервисов, либо явный комментарий «задаются через свой compose». DoD: каждая env из §2a имеет непустую колонку «документация». | §2.6; AGENTS §5 («правило пяти мест») |
| PD-07 | namespaces на сетевом стенде | `packages/core/index.js:2178-2195` (авто-создание; `createLimitFor` при `createLimit=0` — без лимита), `:99-103` в адаптерах (дефолт `0` при namespaces); `services/tbank-mock/server.js:2395` (листинг без токена), `:2429-2438` (DELETE без токена в namespaces); `docker-compose.include.yml:37,89,138,185` (`MOCK_HOST=0.0.0.0`); `SECURITY.md:22-24` | security | minor | Дефолтный режим include — `namespaces` (`MOCK_TENANCY` пуст, `MOCK_HOSTED=false`). На сетевом/публичном стенде (потребитель задал `MOCK_*_BIND_IP=0.0.0.0` или поднял Caddy по меткам): любой клиент создаёт песочницы заголовком `X-Mock-Sandbox` **без лимита** (`MOCK_SANDBOX_CREATE_LIMIT` дефолт 0 в namespaces), до cap 256, с TTL 0 — бессрочно и с персистентностью в реестре (cap сохраняется после рестарта); `GET /sandboxes` отдаёт список всех id без токена, `DELETE /sandboxes?sandbox=` — без токена (проверка owner только в ветке `owned`). SECURITY-матрица «Доступен команде по сети» про tenancy молчит. | В SECURITY.md в строку «Доступен команде по сети» добавить «для нескольких арендаторов задайте `MOCK_TENANCY=owned` (или `MOCK_HOSTED=1`) и токены»; в include — комментарий к блоку RFC-001, что namespaces предназначен для доверенного периметра. DoD: SECURITY описывает режим; чек-лист §2b ссылается на строку. | MS-13 (лимит), MS-31 (дефолт tenancy), PC-10 |
| PD-08 | core / персистентность | `packages/core/index.js:181-190` (createStore.persist — catch → log), `:1985-1987` (flushRegistry — catch → log) | resilience | minor | Ошибки записи состояния и реестра **глотаются** (лог в stderr) — при недописываемом `/data` (bind-mount, принадлежащий root; заполненный диск; read-only volume без tmpfs) сервис продолжает работать в памяти, healthcheck зелёный, всё состояние теряется при рестарте без какого-либо сигнала, кроме строки в логах при каждой мутации. Это молчаливая деградация гарантии «переживает рестарт» (`services/tbank-mock/README.md:107-110`). | При неудачном persist — разовый WARN-баннер + счётчик, видимый в `/admin` (или fail-fast при старте: пробная запись рядом с `restore()` в `services/tbank-mock/server.js:3403`). DoD: тест «read-only /data → WARN и/или подсказка, а не тишина». | MS-04 (hardening) |
| PD-09 | include / образ | `docker-compose.include.yml:30,82,131,178` (`image: ${MOCK_IMAGE:-…}:${MOCK_IMAGE_TAG:-0.5.0}${MOCK_IMAGE_DIGEST-@sha256:5e2b…}`); `CONTRIBUTING.md:89-90` | dx | minor | `MOCK_IMAGE_TAG` и `MOCK_IMAGE_DIGEST` независимы: при bump тега (`MOCK_IMAGE_TAG=0.6.0`) без обновления дайджеста Docker резолвит образ **по дайджесту** (тег игнорируется) — потребителю кажется, что он обновился до 0.6.0, а фактически остаётся 0.5.0. Проверки/предупреждения о рассинхроне нет; CONTRIBUTING описывает только штатный порядок bump (тег и дайджест вместе). `[не подтверждено прогоном Docker — по документации Docker; песочница без Docker]`. | В CONTRIBUTING («Обновление базового образа») добавить анти-паттерн «bump тега без дайджеста — тег декоративен при пине» и/или в compose-selftest — контроль соответствия тега в `MOCK_IMAGE_TAG` тегу внутри пина. DoD: документировано; проверка ловит рассинхрон. | F-37; PC-12 (расширение smoke) |
| PD-10 | RFC-001 ↔ код | `docs/rfc/RFC-001-multi-tenant-sandboxes.md:79-81` (§4 «один JSON-файл на песочницу `/data/sandboxes/<id>.json`»), `:126` (§7 quota `{rps, maxDocuments, maxBodyBytes, ttlMs}`), `:154` (§10 «лимит 3 песочницы/IP/сутки») vs `packages/core/index.js:1919` (единый реестр `<stateFile>.sandboxes.json`), `:2138-2148` (окно 1 час, дефолт 20/час в owned), 0 совпадений RPS-квоты | docs | minor | Расширение MS-31 (та же болезнь, другие строки): (а) §4 обещает per-sandbox файлы — реализован единый реестр (это же источник PD-02); (б) §7 обещает RPS-квоту на песочницу — её нет вовсе (0 совпадений; MS-13 фиксирует «RPS — нет», но без привязки к RFC §7); (в) §10 «3 песочницы/IP/сутки» ≠ реализация «20/час» (окно `60*60*1000`) и ≠ README tbank:180 «в час». | В RFC-001 привести §4/§7/§10 к реализованному (статусная плашка «реализовано иначе/отклонено»), либо завести задачи на per-sandbox storage и RPS. DoD: строки RFC сверяются с `файл:строка` кода, как это сделано для статуса в шапке RFC. | MS-31, MS-13, PD-02 |
| PD-11 | include / caddy ↔ public URL | `docker-compose.include.yml:69-71,118-120,165-167,215-217` (caddy-метки через `MOCK_<SVC>_CADDY_DOMAIN`) vs `:46,102,143,199` (`MOCK_<SVC>_PUBLIC_BASE_URL`); стартовые логи `services/tbank-mock/server.js:3423` и аналоги | dx | minor | Caddy-домен и покупательский базовый URL — две независимые переменные без перекрёстной проверки: задав только `MOCK_TBANK_CADDY_DOMAIN`, потребитель получает публичный домен, но `PaymentURL`/`ofd_receipt_url`/`confirmation_url` продолжают строиться от `http://localhost:310x` (дефолт) — покупательский флоу сломан, предупреждения при старте нет (лог печатает `public_base`, но не сопоставляет с метками). Смежно с MS-22 (localhost ≠ HOST_PORT) и MS-28 (пустые метки), но сам вектор «домен задан — URL нет» нигде не зафиксирован. | В стартовый лог (или DX-предупреждение при `MOCK_HOSTED=1`) добавить сверку: если `MOCK_<SVC>_CADDY_DOMAIN` задан, а `MOCK_<SVC>_PUBLIC_BASE_URL` не задан — WARN. DoD: проба «только домен» пишет WARN с подсказкой. | MS-22, MS-28 |

## 2a. Полная таблица env (критерий приёмки №1)

Метод: `rg 'MOCK_[A-Z0-9_]+'` по `services/*/server.js` + `packages/core/index.js` (артефакты конкатенации `MOCK_FERMA_`/`MOCK_OPERATOR_` исключены — проверено контекстом: `MOCK_FERMA_` встречается только как префикс `MOCK_FERMA_LOGIN/PASSWORD/DOWN/DOWN_MS`, «`MOCK_OPERATOR_`» не существует); имя считается «живым», если есть и чтение, и использование в ветвлении/передаче в рантайм. Сверка документации — по границам слова (`MOCK_OPERATOR` ≠ `MOCK_OPERATOR_TOKEN`).

**Счёт:** 61 имя env-поверхности = 60 читается серверами (+ `createVirtualClock` читает `MOCK_VIRTUAL_CLOCK` в core) + 1 (`MOCK_HEALTH_PATH`) только `scripts/docker-healthcheck.js`. Из 60: **13 отсутствуют в include** (уточнение §2.6, где «14» — методическая разница: `MOCK_HEALTH_PATH` в include есть), **3 не документированы нигде**, `MOCK_VIRTUAL_CLOCK` отсутствует в README всех 4 сервисов.

Сокращения: `t`=tbank-mock, `k`=kassa-mock, `y`=yookassa-mock, `a`=atol-mock, `с`=core; «README×4» — все четыре README сервисов. Вердикты: **живая** / **живая (условно)** / **мёртвая при дефолте** / **недокументированная**.

| Переменная | Где читается (файл:строка) → использование | Дефолт | Задокументирована | compose.yml | include.yml | Вердикт |
|---|---|---|---|---|---|---|
| `MOCK_HOST` | t:38 k:37 y:41 a:60 → `server.listen(MOCK_HOST…)` (t:3420 и аналоги) | `0.0.0.0` | README×4; Dockerfile:42; include:37,89,138,185 | — (ENV образа) | Y | живая |
| `MOCK_PORT` | t:39 k:38 y:42 a:61 → listen + стартовый лог | `3100/3101/3102/3103` | README×4; compose | Y (жёстко) | Y | живая |
| `MOCK_PUBLIC_BASE_URL` | t:44 k:53 y:47 a:76 → PaymentURL / `ofd_receipt_url` / `confirmation_url` | `http://localhost:310x` (k/y — от MOCK_PORT) | README×4 | Y (захардкожено, MS-22) | Y (с per-service override) | живая; MS-22 |
| `MOCK_STATE_FILE` | t:50 k:46 y:54 a:80 → `createStore` (с:179) | `''` (память) | README×4; SECURITY:25,66 | Y | Y | живая |
| `MOCK_ADMIN_TOKEN` | t:55 k:55 y:57 a:83 → `checkControlAccess` (с:1643-1654) | `''` (открыто; в hosted fail-closed) | README×4; SECURITY:33 | — | Y | живая |
| `MOCK_OPERATOR_TOKEN` | t:56 k:56 y:58 a:84 → там же | `''` (fallback ADMIN) | README×4; SECURITY:31 | — | Y | живая |
| `MOCK_HOSTED` | t:57 k:57 y:59 a:85 → `flagEnabled` (с:46-52) | `false` | README×4; SECURITY:24; README.md:150 | — (PD-01) | Y (default `false`) | живая |
| `MOCK_TENANCY` | t:58 k:59 y:60 a:86 → `resolveTenancyMode` (с:1851-1875) | `''` → `namespaces` (`owned` при HOSTED) | README×4; SECURITY:43; RFC §2 (неверно: «off», MS-31) | — | Y | живая; RFC-дрифт |
| `MOCK_BLOCK_PRIVATE_WEBHOOKS` | t:53 k:50 y:55 a:81 → `flagEnabled(value, HOSTED)` | `''`→HOSTED; **k: `'false'`→всегда false** | README×4 (README kassa:122 обещает иначе — PF-01); SECURITY:23,94 | комментарий | Y | живая; **PF-01** |
| `MOCK_VIRTUAL_CLOCK` | t:54 k:54 y:56 a:82 + с:1195 (`createVirtualClock`) | `''` (wall-clock; мусор → WARN + 0) | README.md:115 (+CHANGELOG, lovii.md); README сервисов — **нет** | — | Y (×4) | живая; недокументирована в README сервисов (§2.6) |
| `MOCK_SANDBOX_TOKEN` | t:59 k:60 y:61 a:87 → `defaultOwnerToken` (с:1945) | `''` | SECURITY:57; README t:175/k | — | Y | живая (условно: enforcement только в `owned`, в `namespaces` — косметика `owned:true` в describe; описана как hosted-only) |
| `MOCK_SANDBOX_TTL_MS` | t:60 k:61 y:62 a:88 → `ttlMs` (с:2157, 2196) | 24 ч owned / 0 | SECURITY:54; README t:176/k | — | Y | живая |
| `MOCK_SANDBOX_MAX` | t:61 k:62 y:63 a:89 → `maxSandboxes` (с:2151) | 100 owned / 256 | SECURITY:54; README t:177/k | — | Y | живая |
| `MOCK_SANDBOX_MAX_DOCUMENTS` | t:62 k:63 y:64 a:90 → `maxDocuments` (с:2130-2136); точки проверки: t:614-620 (+9 вызовов :1421,1475,1684,1829,1880,2801,2901,2971,3202), k:1814, y:411, a:1598 | 5000 owned / 0 | SECURITY:54; README t:178/k; y/a — catch-all «`MOCK_SANDBOX_*`» | — | Y | живая; **работает и при ttl=0** (условие запуска sweep включает её; проверка квоты — на создании документа) |
| `MOCK_SANDBOX_HOST_SUFFIX` | t:64 k:65 y:66 a:92 → `hostSuffix` (с:1920, 2063-2070), `sandboxPublicUrl` (t:2355-2364) | `''` | README t:179/k; RFC §3 | — | Y | живая (условно): без wildcard DNS/TLS selector никогда не срабатывает, `POST /sandboxes` отдаёт URL несуществующего домена |
| `MOCK_SANDBOX_CREATE_LIMIT` | t:65 k:66 y:67 a:93 → `createLimit` (с:2138-2148: окно **1 час**) | 20 owned / 0 | README t:180/k; SECURITY — **нет** (MS-13); RFC §10 («сутки») — расходится | — | **НЕТ** | живая (owned); в namespaces дефолт 0 (авто-создание без лимита, PD-07) |
| `MOCK_SANDBOX_FILE` | t:202, k:67→:220, y:158, a:94→:226 → `registryFile` (с:1919) | `<stateFile>.sandboxes.json` | README t:181/k | — | **НЕТ** | живая |
| `MOCK_SANDBOX_SWEEP_MS` | t:3395, k:941, y:2089, a:908 → интервал воркера | `60000` | README t:182/k (без условия запуска) | — | **НЕТ** | **мёртвая при дефолте** (`namespaces`: sweep не стартует, PD-03) |
| `MOCK_SANDBOX_RETENTION_MS` | t:63→:170-190, k:64→:189-208, y:65→:137-150, a:91→:198-218 | 0 (выкл.) | README t:183/k | — | **НЕТ** | живая (значение >0 само запускает sweep) |
| `MOCK_PROFILE` | t:51→:83 | `plain` | README t:161; README.md:113 | — | Y | живая |
| `MOCK_TERMINAL_KEY` | t:40→:69 | `TBANK_TERMINAL_KEY` → `TBANKMOCKTEST` | README t:162 | — | Y (:44, MS-02) | живая |
| `MOCK_TERMINAL_PASSWORD` | t:41→:70 | `TBANK_TERMINAL_PASSWORD` → `mockpass123` | README t:162 | — | Y (:45, MS-02) | живая |
| `MOCK_ACQAPI_CLIENT_ID` | t:1092 | `partner` | README t:78,164 | Y | Y | живая |
| `MOCK_ACQAPI_CLIENT_SECRET` | t:1093 | `partner` | README t:78,164 | Y | Y | живая |
| `MOCK_ACQAPI_TOKEN_TTL_MS` | t:1094 | 1 ч | README t:81,165 | Y | Y | живая |
| `MOCK_DEFAULT_NOTIFICATION_URL` | t:45 → fallback очереди нотификаций | `''` | README t:166 | — | Y (:47 + `TBANK_NOTIFICATION_URL`, MS-02) | живая |
| `MOCK_RETRY_MS` | t:71 (также y:73) | 60000; `0` не работает (PB-03) | README t:167, y:151 | — | Y | живая; PB-03 |
| `MOCK_MAX_ATTEMPTS` | t:72 (также y:74) | 24 | README t:167, y:151 | — | Y | живая |
| `MOCK_AUTO_CONFIRM_MS` | t:76 | 0 (выкл.) | README t:184 | — | Y | живая |
| `MOCK_STRICT_TOKEN` | t:73 | `true` | README t:168 | — | Y | живая |
| `MOCK_ALLOW_DUPLICATE_ORDER_ID` | t:80 | `false` | README t:169 | — | Y | живая |
| `MOCK_FERMA_LOGIN` | k:71 | `FERMA_LOGIN` → `loviitest` | README k; include:92 (MS-02); compose-selftest:33 (MS-07) | — | Y | живая |
| `MOCK_FERMA_PASSWORD` | k:72 | `FERMA_PASSWORD` → `mockpass123` | README k | — | Y (:93) | живая |
| `MOCK_PROCESS_MS` | k:80 (также a:116) | 15000 (`0` — мгновенно, A-10) | README k+a | — | Y (:94, :194) | живая |
| `MOCK_TOKEN_TTL_MS` | k:81, a:115 | 12 ч / 24 ч (`0` у a — без истечения) | README k+a | — | Y (:97, :193) | живая |
| `MOCK_VALIDATE_RECEIPTS` | k:82, a:119 (`flagEnabled(…, true)`) | `true` | README k+a | — | Y (:98, :197) | живая |
| `MOCK_GROUPS` | k:84, a:123 | `''` (любая группа) | README k+a; root compose k=`"Main"` | Y (k) | Y для k (:99); для a — **только через `MOCK_ATOL_GROUPS`** (:192, PD-05) | живая; PD-05 |
| `MOCK_CALLBACK_RETRY_MS` | k:104, a:117 | 10000; `0` не работает (PB-03) | README k+a | — | Y | живая; PB-03 |
| `MOCK_CALLBACK_MAX_ATTEMPTS` | k:105, a:118 | 24 | README k+a | — | Y | живая |
| `MOCK_AGENT_LINE` | k:626, a:139 | «ТЕСТОВАЯ КАССА (МОК)» / «ТЕСТОВАЯ КАССА АТОЛ (МОК)» | README k+a | — | Y только для k (:100); для a — **НЕТ** | живая; atol — нет в include |
| `MOCK_AGENT_INN` | k:627, a:140 | `7800000000` / `5544332219` | README k+a | — | Y только для k (:101) | живая; atol — нет в include |
| `MOCK_FN_CAPACITY` | k:110 → `state.fn.capacity`:152; отчёты :1346, :1564-1571 | `250000` | **НЕТ нигде** | — | **НЕТ** | живая; **недокументированная** (PD-06) |
| `MOCK_FN_NUMBER` | k:151, a:134 | `9999078902001294` | README a (k — **нет**) | — | **НЕТ** | живая; k — недокументированная |
| `MOCK_OFD_MODE` | k:58→:114-116 → `state.cashbox.ofdMode` | `online` | **НЕТ нигде** | — | **НЕТ** | живая; **недокументированная** (PD-06) |
| `MOCK_OFD_INN` | k:628, a:136 | `7800000000` / `7709359901` | README a (k — **нет**) | — | **НЕТ** | живая |
| `MOCK_ECR_RN` | k:630, a:135 | `0001234567025896` | README a (k — **нет**) | — | **НЕТ** | живая |
| `MOCK_OPERATOR` (кассир) | k:631 → `OPERATOR_NAME` в ленте чека (:692), a:138 | «Кассир-мок» | **НЕТ нигде** (совпадения в доках — только `MOCK_OPERATOR_TOKEN`) | — | **НЕТ** | живая; **недокументированная** (PD-06) |
| `MOCK_FNS_SITE` | k:632, a:137 | `www.nalog.gov.ru` | README a (k — **нет**) | — | **НЕТ** | живая |
| `MOCK_FERMA_DOWN` | k:1950 (старт-сценарий), :268, :1738 | `false` | README k | — | **НЕТ** | живая |
| `MOCK_FERMA_DOWN_MS` | k:1951 | `0` | README k | — | **НЕТ** | живая |
| `MOCK_SHOP_ID` | y:71 | `YOOKASSA_SHOP_ID` → `YOOKASSAMOCKTEST` | README y:184 | — | Y (:141, MS-02) | живая |
| `MOCK_SECRET_KEY` | y:72 | `YOOKASSA_SECRET_KEY` → `mockpass123` | README y:184 | — | Y (:142) | живая |
| `MOCK_DEFAULT_WEBHOOK_URL` | y:48 → :465 | `''` | README y:187 | Y | Y (:144) | живая |
| `MOCK_CAPTURE_TTL_MS` | y:76 | 7 дней | README y:188 | — | Y (:147) | живая |
| `MOCK_PENDING_TTL_MS` | y:77 | 0; `0` не работает (PB-03) | README y:189 | — | Y | живая; PB-03 |
| `MOCK_REFUND_DELAY_MS` | y:78 | 0 | README y:190 | — | Y | живая |
| `MOCK_ATOL_LOGIN` | a:103 | `ATOL_LOGIN` → `v4-online-atol-ru` | README a:178 | — | Y (:189, MS-02) | живая |
| `MOCK_ATOL_PASSWORD` | a:104 | `ATOL_PASSWORD` → `iGFFuihss` | README a:179 | — | Y (:190) | живая |
| `MOCK_ATOL_GROUP` | a:105 | `ATOL_GROUP` → `v4-online-atol-ru_4179` | README a:180 | Y | Y (:191) | живая |
| `MOCK_DEFAULT_CALLBACK_URL` | a:79 | `''` | README a:184 | Y | Y (:198) | живая |
| `MOCK_ATOL_GROUPS` (compose-level) | — (раскрывается в `MOCK_GROUPS` для a) | `''` | **НЕТ нигде** | — | Y (:192) | живая; недокументированная (PD-05) |
| `MOCK_HEALTH_PATH` | **только** `scripts/docker-healthcheck.js:27-29` (серверы не читают) | `/health` | нет в README; Dockerfile:3-15; compose | Y | Y | «мёртвая» для серверов (PD-04) |

Потребительские алиасы без префикса `MOCK_` (env-поверхность include, MS-02): `TBANK_TERMINAL_KEY/PASSWORD` (t:42-43), `TBANK_NOTIFICATION_URL` (include:47), `FERMA_LOGIN/PASSWORD` (k:41-42), `FERMA_GROUP` (include:99), `YOOKASSA_SHOP_ID/SECRET_KEY` (y:44-46), `ATOL_LOGIN/PASSWORD/GROUP` (a:63-67). Итого 11 fallback-строк include:44,45,47,92,93,99,141,142,189,190,191 — MS-02 подтверждена.

## 2b. Чек-лист «hosted go/no-go» (критерий приёмки №2)

Обозначения: **[стоп]** — не включать публичный стенд до устранения; **[осторожно]** — включать только с компенсирующей мерой; **[ок]** — проверено, препятствий нет.

1. **[стоп]** SSRF-гард кассы выключен в hosted дефолтом: `flagEnabled('false', HOSTED) → false` (прогон `node -e`) — `services/kassa-mock/server.js:50,90`; README kassa:122 обещает обратное. **PF-01.**
2. **[стоп для публичного]** Default-песочница в owned открыта без `MOCK_SANDBOX_TOKEN`: `defaultRecord.ownerTokenHash = null` (`packages/core/index.js:1939-1949`), только WARN при старте (`services/tbank-mock/server.js:3426`, k:1962, y:2108, a:1662). **MS-12.** Компенсация: задать `MOCK_SANDBOX_TOKEN`.
3. **[осторожно]** Управляющие токены принимаются из query и переживают redirect: `core:1614-1631` (`admin_token`/`operator_token`), `:2075-2085` (`sandbox_token`), `/admin/action` перекладывает токены в Location (`services/tbank-mock/server.js:3352-3360`); поведение закреплено тестами (`services/kassa-mock/selftest.js:646-662`). **MS-06.** Компенсация: TLS-прокси + не логировать query (SECURITY:102-103).
4. **[осторожно]** Лимит создания песочниц: окно 1 час (`core:2141`), IP = `req.socket.remoteAddress` (`core:2191`, t:2404, k:1180, y:1454, a:1093); `X-Forwarded-For`/`MOCK_TRUST_PROXY` — 0 совпадений. За reverse-прокси (caddy-метки include) все посетители делят один бакет: один посетитель исчерпывает 20/час для всех (DoS создания), и наоборот, атакующего не изолировать. **MS-13** (сущность известна; следствие «общий бакет за прокси» зафиксировано здесь впервые).
5. **[осторожно]** RPS-квот нет (0 совпадений по `rps` в `services/` и `packages/`) — единственные ограничители: 5 МБ тело, 5000 документов/песочница, 200 записей журнала. **MS-13 остаток.**
6. **[стоп для hosted до исправления]** PD-02: полная перезапись реестра на каждую мутацию + отсутствие байтовых квот + `mem_limit: 128m` — риск OOM/деградации под нагрузкой.
7. **[ок при настройке]** TTL/quota/лимиты в owned включены дефолтами (24 ч / 5000 / 100 / 20-в-час): `t:98-103` и аналоги; sweep стартует автоматически (`t:3396`).
8. **[осторожно]** `MOCK_SANDBOX_HOST_SUFFIX` без wildcard DNS/TLS не работает: selector требует `Host: <id>.<suffix>` (`core:2063-2070`); `POST /sandboxes` вернёт URL несуществующего поддомена (`t:2357-2362`). Компенсация: оставить пустым — работают `?sandbox=`/заголовок.
9. **[осторожно]** Для hosted-контура использовать include (или свой compose с транзитивными env): root compose не пропускает `MOCK_HOSTED`/токены (PD-01).
10. **[ок]** Управляющая поверхность fail-closed в hosted без секрета: `checkControlAccess` `core:1643-1654`; но `/sandboxes` — `public` by design (`t:2482`), создание публичное с лимитом на IP — осознанно; описать в SECURITY (см. PD-07).
11. **[ок для стенда; желательно]** Hardening отсутствует: `read_only`/`init`/`tmpfs`/`cap_drop`/`security_opt`/`pids_limit` — 0 совпадений в обоих compose; `process.on('SIGTERM')` — 0 в серверах: `docker stop` → SIGTERM игнорируется (PID 1) → 10 с → SIGKILL, теряется debounced-запись реестра (окно до 150 мс, `core:1990-1997`). Запись идёт только в `/data` (`с:184-185, 1981-1984`) → `read_only: true` + volume **ничего не ломает** (по коду; живой прогон — docker-smoke:123-148, PC-12). **MS-04.**
12. **[ок]** Healthcheck-пары согласованы в трёх местах и совпадают с маршрутами (§3, п.3); остаток — PC-11.
13. **[осторожно]** `MOCK_PUBLIC_BASE_URL` по умолчанию `localhost:310x`: покупательские ссылки сломаны на публичном стенде, если не задать per-service override (MS-22) и не связать с caddy-доменом (PD-11).
14. **[осторожно]** Наблюдаемости нет: `/metrics` — 0 совпадений в `services/*/server.js` (RFC §8, MS-31); логи — единственный источник (и в них «ock]» — PF-02).
15. **[ок]** Образ: дайджест-пин base (Dockerfile:20) и релиза (include:30, F-37); непривилегированный UID 10001, единственная записываемая точка `/data` (Dockerfile:33-39).

**Вердикт:** включать `MOCK_HOSTED=1` **сегодня** можно только на loopback/доверенном периметре (dev/staging, include-файл, заданные токены). Публичный стенд — после закрытия PF-01, PD-02, обязательного `MOCK_SANDBOX_TOKEN` (MS-12), решения по MS-06 (query-токены) и сетевого egress-фильтра.

## 3. Покрытие

| Файл | Прочитано | Что проверено |
|---|---|---|
| `docker-compose.yml` | 122/122, полностью | env-наборы, ports/healthcheck/volumes, отсутствие транзитивных env (PD-01), отсутствие hardening (MS-04), захардкоженный PUBLIC_BASE_URL (MS-22) |
| `docker-compose.include.yml` | 228/228, полностью | те же + profiles, image-пин, caddy-метки, RFC-001 блок, MOCK_ATOL_GROUPS (PD-05), 11 fallback-строк (MS-02) |
| `SECURITY.md` | 113/113, полностью | сверка «обещано ↔ код»: fail-closed (с:1643-1654), SSRF best-effort (с:877-942), предупреждение о default (т:3426…), отсутствие `MOCK_SANDBOX_CREATE_LIMIT`/SWEEP/FILE/RETENTION/HOST_SUFFIX/VIRTUAL_CLOCK (MS-13, §2.6) |
| `docs/rfc/RFC-001-multi-tenant-sandboxes.md` | 160/160, полностью | сверка §2/§4/§6/§7/§8/§10 с кодом: tenancy-дефолт (с:1851-1856; прогон `resolveTenancyMode('', false) = 'namespaces'`), хранение (с:1919), RPS (0), `/metrics` (0), окно лимита (с:2141) — MS-31 + PD-10 |
| `services/tbank-mock/README.md` | 199/199, полностью | env-таблица (27 строк) сверена с кодом; раздел «Песочницы и hosted tenancy» |
| `services/kassa-mock/README.md` | 185/185 (env-таблица и hosted-раздел полностью) | 27 строк env; отсутствие FN_/OFD_ реквизитов (PD-06) |
| `services/yookassa-mock/README.md` | 220/220 (env-раздел :182-196) | 11 строк; catch-all `MOCK_SANDBOX_*` |
| `services/atol-mock/README.md` | 239/239 (env-раздел :175-193) | 15 строк; `MOCK_GROUPS` без упоминания include-посредника (PD-05) |
| `scripts/docker-healthcheck.js` | 43/43, полностью | KNOWN_SERVICES ↔ compose ↔ маршруты серверов |
| `Dockerfile` | 55/55, полностью | USER 10001, `/data` chown, VOLUME, HEALTHCHECK, дайджест base |
| `services/*/server.js` | env-блоки деструктурирования (t:37-66, k:36-68, y:40-68, a:59-95) + все точки чтения `process.env.MOCK_*` + хвосты (t:3372-3431, k:935-950/1949-1966, y:2085-2116, a:904-915/1660-1673) + sandbox/handlers (t:2350-2540) | живость env, условия sweep, авторизация `/sandboxes`, предупреждения MS-12 |
| `packages/core/index.js` | фрагменты построчно: 30-69, 179-208, 846-1000, 1188-1260, 1520-1660, 1841-2453 | flagEnabled/parseMsOr/tenancy/runtime/селектор/лимиты/sweep/реестр |

Сверки по вопросам партии:

1. **docker-compose.yml vs include (вопрос 3).** Различия: `build: .` + локальный образ против пина `ghcr.io/rucorp/mock-services:0.5.0@sha256:5e2b…` через `MOCK_IMAGE(_TAG/_DIGEST)`; `profiles: ["mock"]` только в include; include транзитит hosted/tenancy/tokens/`MOCK_VIRTUAL_CLOCK`, root — нет (PD-01); caddy-метки только в include; имя volume `mock-data` vs `mock-services-data`; root фиксирует kassa `MOCK_GROUPS="Main"`, include — через `FERMA_GROUP`. На дефолтах поведение одинаковое (env-значения эквивалентны code-defaults). «Канонический» для развертывания — include (AGENTS §3: «include — artifact потребителей»); root — дев-стенд; MS-24 подтверждена: 4×дублирование healthcheck-блоков + HEALTHCHECK в образе, без якорей `x-mock-common`.
2. **`/data` + `read_only` + `init` + непривилегированный UID (вопрос 4).** Записи на диск — только `/data/<svc>-state.json` и `<stateFile>.sandboxes.json`(+`.tmp`) (с:184-185, 1981-1984; rg по `fs.write*` — других 0; atol читает OpenAPI с read-only `/app` — a:1342). `/data` chown mock:mock в образе (Dockerfile:38-39) → named volume наследует при первом монтировании. Вывод: `read_only: true` ломается только при bind-mount root-owned каталога — и тогда не «падает», а **молча теряет персистентность** (PD-08). `init: true` ничего не ломает и закрывает хвост SIGTERM (MS-04); tmpfs не нужен (временных файлов вне `/data` нет — tmp-файл реестра пишется в тот же каталог).
3. **Healthcheck-пары (вопрос 5).** Проверены все три места + серверы: tbank `3100 /health` (compose:13,29; include:35,74; healthcheck:21; маршрут т:2588), kassa `3101 /healthz` (compose:43,55; include:87,123; healthcheck:22; маршрут k:1336), yookassa `3102 /health` (compose:68,83; include:136,170; healthcheck:23; маршрут y:1762), atol `3103 /health` (compose:96,114; include:183,220; healthcheck:24; маршрут a:1345). **Расхождений нет.** Остатки: PC-11 (пары 3102/3103 не исполняются CI) и PD-04 (MOCK_HEALTH_PATH не серверная).
4. **Прочее:** caddy-метки пустые дефолтом, caddy-сервиса в include нет (MS-28); `host.docker.internal` рекомендуется в 4 местах `docs/integration/*` без `extra_hosts`/`host-gateway` в compose (MS-23); `mem_limit` есть, `cpus`/`NODE_OPTIONS` нет (MS-25); реестры `<stateFile>.sandboxes.json` уникальны на сервис (MS-26 опровергнута); `MOCK_WEBHOOK_ALLOW_CIDRS` — 0 (MS-10); шлюза `/sandboxes` нет — 4 копии `handleSandboxApi` (t:2382, k:1154, y:1432, a:1067 — MS-32).

## 4. Дубли и уже поставленное (новых ID не заводить)

| Сущность | Статус в партии D |
|---|---|
| **PF-01** (kassa SSRF-дефолт в hosted) | Подтверждена независимо: `k:50` деструктурирует `'false'`, `k:90` `flagEnabled(..., HOSTED)`; прогон `node -e`. Главный блокер go/no-go §2b.1 |
| **MS-02** (11 fallback-строк include) | Подтверждены все 11 (§2a, последний блок) |
| **MS-04** (init/read_only/tmpfs/cap_drop/pids_limit; SIGTERM) | Подтверждена: 0 совпадений в compose; 0 `process.on` в серверах; анализ «что сломается» — §3.2 |
| **MS-06** (query-токены) | Подтверждена по всем трём якорям брифа (§2b.3) |
| **MS-10** (`MOCK_WEBHOOK_ALLOW_CIDRS`) | Подтверждена: 0 совпадений |
| **MS-12** (default-песочница, warn-only) | Подтверждена по 4 сервисам (§2b.2) |
| **MS-13** (createLimit окно час, IP=socket, XFF/TRUST_PROXY=0, тестов нет, нет в SECURITY) | Подтверждена; новое следствие «общий бакет за прокси» вписано в §2b.4, не новый ID |
| **MS-22** (PUBLIC_BASE_URL vs HOST_PORT) | Подтверждена (root compose:23,49,75,103; include:46,102,143,199) |
| **MS-23** (host.docker.internal без extra_hosts) | Подтверждена |
| **MS-24** (дубли compose без якорей) | Подтверждена; «канонический» зафиксирован (§3.1) |
| **MS-25** (mem_limit без NODE_OPTIONS/cpus) | Подтверждена; усугубляется PD-02 |
| **MS-26** (затирание реестров) | Опровергнута брифом — подтверждено: файлы уникальны |
| **MS-28** (пустые caddy-метки, нет public.yml/Caddyfile) | Подтверждена; смежный вектор — PD-11 |
| **MS-31** (RFC-001: tenancy=off ≠ namespaces; §6/§8 не реализованы; rate limit без переменной; `MOCK_SANDBOX_CREATE_LIMIT` не в SECURITY) | Подтверждена полностью + расширена PD-10 (§4/§7/§10) |
| **MS-32** (нет шлюза песочниц) | Подтверждена (4 копии `handleSandboxApi`) |
| **PC-04** (compose вне npm test), **PC-10** (F-33 provision/tenancy=off), **PC-11** (пары 3102/3103 вне CI), **PC-12** (smoke 2 из 4) | Приняты без пересмотра; дополнительных фактов в зоне D не дали, кроме §3.3 |
| **PF-02** (логи «ock]») | Расширение: тот же класс в yookassa — `services/yookassa-mock/server.js:2106-2108` (`ock] ttls:`, `ock] control-plane:`, `ock] sandboxes:`) |
| **§2.4** sandbox-ttl-off-virtual-clock (аудит-преп) | Подтверждено по core:1913 (`now = () => Date.now()`); на env-поверхность не влияет |
| **§2.6** env-doc-drift (14 env, MOCK_VIRTUAL_CLOCK) | Уточнено: точная сверка по границам слова даёт **13** отсутствующих в include + `MOCK_OPERATOR`-кассир; полный список — §2a |

## 5. Прогоны

`npm test` не запускался (инструкция координатора; baseline зелёный зафиксирован координатором на 05696f3). Docker/compose-прогоны невозможны (Docker в песочнице нет). Выполнены точечные проверки:

1. `node -e "const c=require('./packages/core'); …"`:
   - `resolveTenancyMode('', false)` → `namespaces`; `('', true)` → `owned`; `('off', true)` → `off`; `('abc', true)` → `owned` (warn) — база для §2a (MOCK_TENANCY) и подтверждения MS-31;
   - `flagEnabled('false', true)` → `false`; `flagEnabled('', true)` → `true` — PF-01;
   - `parseMsOr('1h',0)` → `3600000`; `parseMsOr('', 86400000)` → `86400000`; `parseMsOr('0', 86400000)` → `0`; `parseMsOr('500ms',0)` → `500`; `parseMsOr('abc',7)` → `7` (мусор → тихий fallback) — дефолты §2a;
2. Инвентаризация env скриптом (`matchAll` по 4 server.js, артефакты конкатенации отсечены): UNION=60; word-boundary сверка include/root и 9 документов — колонки §2a; MISSING_IN_INCLUDE=13.
3. `rg`-сверки: `fs.write*` в серверах/core (только `/data`); `process.on('SIGTERM')` = 0; `read_only|tmpfs|init:|cap_drop|security_opt|pids_limit|user:` в compose = 0; `rps` в services/core = 0 (только `SANDBOX_RATE_LIMIT`); `X-Forwarded-For|trust.proxy` = 0 (кроме намеренно игнорируемого `X-Forwarded-Host` в с:1597-1599); health-маршруты и пары трёх мест.

## 6. Критерии приёмки AUDIT-PREP §4.D

- [x] **(1)** Полная таблица env «переменная → где читается → дефолт → где задокументирована → где в compose → вердикт» — §2a (61 имя; закрывает §2.6 как частный случай с уточнением 14→13+`MOCK_OPERATOR`).
- [x] **(2)** Чек-лист «hosted go/no-go» из 10–15 пунктов, привязанных к коду — §2b (15 пунктов + вердикт).
- [x] **(3)** Находки формата реестра — §2 (PD-01…PD-11: major ×1, minor ×10).
- [x] **(4)** Ни одной правки compose/кода в партии — подтверждено: изменён только этот отчёт.
- [x] Ограничения честно зафиксированы: Docker-прогоны, GHCR и поведение `image: tag@digest` — вне песочницы (PD-09 помечен `[не подтверждено прогоном Docker]`).
