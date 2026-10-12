© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Аудит-партия A-1a — Ядро 1–546: состояние, парсинг, редакция, html — 2026-10-12

> **База:** коммит `05696f3` (main, 0.5.0), Node в песочнице **v24.21.0**. Режим — **только чтение**:
> код, тесты, compose, CI и манифесты не менялись; единственный созданный файл — этот отчёт
> (скрипты-доказательства — в `/tmp/partyA1a-scratch/`, вне репозитория). Baseline `npm test` на
> `05696f3` — **зелёный** (по прогону координатора: core 41/41, tbank, kassa 141/141, yookassa
> 227/227, atol 202/202, upstream 11/11, links 57, drift 221/221); в песочнице не перезапускался.
>
> **Область:** [`packages/core/index.js`](../../packages/core/index.js) строки **1–546** целиком
> (env-флаги 35–52, store/safeStateSnapshot/merge 54–201, log 203–209, http/readBody/parseBody/
> send/html/escapeHtml 211–298, redaction 300–511, начало journal-блока 513–546: `SENSITIVE_QUERY_KEYS`,
> `redactQuerySecrets`, `shellQuote`). Хвост redact/curl-блока (546–612) и journal — зона A-1b;
> сценарии/auth/песочницы — зона A-2. Сопряжённо прочитаны: `module.exports` (2619+),
> `filterJournalHeaders`/`JOURNAL_LIMITS` (580–612), вызовы `parseBody`/`readBody` во всех 4 адаптерах,
> HTML-страницы сервисов (источники интерполяции), `sandboxRuntime.run` (2211–2214, зона A-2 — только
> для оценки трассы исключения).

---

## §1. Итог и ответы на вопросы партии

**Итог:** блок 1–546 — самый «выглаженный» кусок ядра: защита состояния от prototype pollution
работает (пробы §5-A), лимит тела и дренаж — по контракту (§5-E), редакция секретов по ключам —
полная для всех полей из брифа. Новых blocker/major **не найдено**. Найдено **9** несовершенств
уровня minor/info: пробелы *текстового* сканера редакции (Amex-PAN, короткие Bearer), три пути
обхода *форменной* редакции rawBody, URIError из `parseBody` → 500 вместо 400, молчаливая обрезка
массивов в снимках, отсутствие сверки Content-Length.

**Ответы на 5 вопросов:**

1. **safeStateSnapshot/mergeValidatedInto: протекают ли `__proto__`/`constructor`/`prototype`? — НЕТ.**
   Все входы идут через `safeStateSnapshot` (ядро: `mergeInto` → 175, песочницы → 1692–1697);
   `mergeValidatedInto` сам не валидирует, но определяет поля через `Object.defineProperty`
   (135–141, 163–169), а не присваиванием, и целевой объект получает `null`-прототип (154, 90).
   Пробы (§5-A): вложенные `{"a":{"__proto__":{...}}}`, `constructor.prototype`, `prototype`,
   top-level `__proto__`, `[{__proto__:1}]` — все отброшены с ошибкой «запрещён опасный ключ»,
   `Object.prototype` чист, восстановленный `state.a` — null-proto. JSON-ключ `__proto__` через
   `parseBody` — литеральный own-property, глобального загрязнения нет. **MS-17 (ядро) закрыт
   подтверждено; остаток MS-17 — только регресс-тест** (не дублирую, см. §4).

2. **parseBody — частично.** Mime-сниффинга нет: всё, что не `*application/json*`
   (`includes`, 260), парсится как form — `text/plain`, `multipart/form-data`, отсутствующий CT
   (проба §5-B; протокольная сторона для yookassa уже учтена PB-10). Лимита размера в самом
   `parseBody` нет (он и не должен: лимит — в `readBody`, 5 МБ). Дубли ключей `key=a&key=b` →
   **last-wins молча**; массивы `key[]=a` и вложенные `a[b][c]` — **литеральные ключи**, массивов/
   вложенности нет (пробы 6/7/8). JSON-глубина: 1000 — ок; 20 000 и даже 10⁶ — `JSON.parse`
   переживает (iterative parser V8), `RangeError` перехвачен `catch` → `{}` (261). **Prototype
   pollution: путей не найдено.** Form-ключ `__proto__=…` инертен, потому что значения form —
   всегда строки, а сеттер `__proto__` игнорирует не-объекты (проба 25); `__proto__[x]=1` —
   литеральный ключ; JSON-`__proto__` — own-property, не прототип. Другой найденный дефект пути —
   **`URIError` на битом %-энкоде** (`a=%zz`, сырой суррогат `%ED%A0%80`) — не перехвачен нигде в
   ядре (267), в адаптерах даёт 500 вместо 400 (PA-01, живая проба §5-F).

3. **Редакция секретов — таблица** (пруфы: прогоны §5-C; номера строк ядра):

   | Поле/заголовок | Редактируется? | Доказательство |
   |---|---|---|
   | `Authorization` (как ключ) | ✅ `[REDACTED]` | `SECRET_KEYS.authorization` ядро:327; проба §5-C |
   | `Authorization` (заголовок журнала) | ✅ отбрасывается целиком | `JOURNAL_HEADER_ALLOWLIST` ядро:580–582 (не в списке) — граница A-1b, сверено |
   | `Idempotence-Key` | ❌ не редактируется (`u1` проходит) | `classifyKey('idempotencekey')` → safe; не секрет (UUID); в журнале заголовок всё равно отброшен allowlist'ом |
   | `Token` (tbank) | ✅ `[REDACTED]` | суффикс `token` ядро:337–340; проба |
   | `Cookie` | ✅ `[REDACTED]` | ядро:327; проба |
   | query `admin_token` | ✅ `YOUR_TOKEN` | `SENSITIVE_QUERY_KEYS.admintoken` ядро:519; проба через `buildCurlCommand` |
   | query `sandbox_token` | ✅ `YOUR_TOKEN` | суффикс `token` ядро:534; проба |
   | query `operator_token` | ✅ `YOUR_TOKEN` | `operatortoken` ядро:519; проба |
   | тело `password` | ✅ `[REDACTED]` | exact+суффикс ядро:329,338; проба; **но `password_confirmation=p2` проходит** (PA-02) |
   | тело `secret` | ✅ `[REDACTED]` | суффикс ядро:338; проба |
   | тело `pan` | ✅ `[REDACTED]` по ключу | ядро:332; проба; в произвольном тексте — только префиксы 2/4/5/6 (PA-03) |
   | Ferma `Password` | ✅ `[REDACTED]` | регистр не влияет (`normalizeKey` 359); проба |
   | atol `Pass` | ✅ `[REDACTED]` | exact `pass` ядро:329; проба |
   | tbank `Password`/`Token` (в т.ч. `data.Data{}`) | ✅ `[REDACTED]` | проба вложенного `data.Data{Token,Password}` |
   | tbank `RebillId` | ❌ не редактируется (`123456` проходит) | `rebillid` → safe; идентификатор повторного списания — «секрет ли» на решение владельца |
   | `CardData`, CVV/CVC-суффиксы | ✅ `[REDACTED]` | ядро:332–334, 339 |
   | Массивы объектов | ✅ рекурсия работает | проба `[{token},{b:{password}}]` |
   | Глубина | ⚠️ >12 уровней → `'[…]'`; массивы >100 → обрезка молча | ядро:434–448; проба 150 → 100 (PA-04) |

   Рекурсия и массивы — да; цикл не вешает (глубинный предел 12), DoS глубиной невозможен.
   Пробелы — PA-02/PA-03 ниже.

4. **html/escapeHtml — да, с двумя оговорками (info).** `escapeHtml` (296–298) экранирует
   `& < > " '` — этого достаточно для текста и **кавычковых** атрибутов (проба: `" onmouseover="`
   → `&quot;…`). Оговорки: backtick не экранируется (важно только для *некавычковых* атрибутов,
   которых в кодовой базе нет) и `javascript:`-схема не нейтрализуется — но приёмник с URL
   интегратора в `href`/`src`/`action` не найден: все `href`/`action` — внутренние пути
   (`/admin/journal…`, `/payment/<id>…`), динамические части — через `esc()`/`escapeHtml`
   (yookassa:1637, atol:1172, tbank:2256) или серверные идентификаторы (`\d+`-регексы tbank:3317).
   Сырых интерполятов в `html()` не найдено (`html()` вызывается с конкатенатами страниц, где
   значения уже `esc()`-нуты или серверные). → PA-07 (info, «функция-экспорт для будущих страниц»).

5. **readBody — да, контракт выполняется; два дополнения.** Дефолт 5 МБ; граница точная
   (5 242 880 ок, +1 → 413 `BODY_TOO_LARGE` + дренаж, AGENTS §8 подтверждён); `maxBytes` 0/−1 →
   лимит 0 → 413 на любое непустое тело; `NaN`/`Infinity` → fallback 5 МБ; строка `'100'` → 100;
   chunked — 1000 кусков собираются; разорванный по чанкам многобайтный UTF-8 склеивается корректно;
   невалидный UTF-8 → replacement-символы (без ошибки). Несоответствие Content-Length: **не
   сверяется вообще** — раннего 413 по объявленному размеру нет, дренаж идёт до серверного
   `requestTimeout` (PA-05, дополнение к MS-20, не дубль); сам `readBody` заголовков не получает
   (арность 1+1). Обработчик обрыва — deprecated-событие `aborted` (253) — PA-06 (info).

---

## §2. Реестр находок

| ID | Модуль | файл:строка | Категория | Severity | Суть | Предлагаемая задача | Зависимости |
|---|---|---|---|---|---|---|---|
| PA-01 | parseBody | `packages/core/index.js:267` | resilience | minor | `decodeURIComponent` без защиты: тело формы с битым %-энкодом (`a=%zz&b=1`, сырой суррогат `%ED%A0%80`) бросает `URIError` из ядра. Живая проба: kassa `POST /admin/action` → **500** + `[kassa-mock] handler error: URI malformed` вместо 400 «неверное тело». Ошибка клиента классифицируется как ошибка сервера; yookassa/tbank — 500 через `.catch` (yookassa:2073). | Оборачивать `decodeURIComponent` в try/catch: битая пара → оставить сырое значение (как уже делает `redactRawBody`:486) либо ответ 400. Регресс-тест на `a=%zz`. | MS-17-регресс; PB-10 (гейт Content-Type) |
| PA-02 | redactRawBody | `packages/core/index.js:476–491`, `:359`, `:337–340` | security | minor | Три пути утечки **форменного** rawBody мимо редакции: (1) пустая пара/двойной `&&` ломает regex формы → тело уходит в text-режим, где ключ-секреты не редактируются: `a=1&&password=x` остаётся как есть (проба); (2) ключи с %-энкодом не декодируются (`token%5F2=t` → normalize `token5f2` → safe), хотя `parseBody` ключи декодирует — расхождение parse/redact; (3) `password_confirmation=p2` не матчится: `passwordconfirmation` не заканчивается на `password` — значение (сам пароль) пишется в журнал открыто. | Классифицировать по декодированному ключу (fallback к сырому), в `SECRET_KEYS`/`SECRET_KEY_SUFFIXES` добавить confirm/repeat-варианты (`confirmpassword`, `password2`, `repeatpassword`), regex формы — устойчивый к пустым парам. Регресс: `a=1&&password=x`, `token%5F2=t`, `password_confirmation` — без секретов в выходе. | F-09 (закрыт, не reopen — расширение) |
| PA-03 | redactSecretsInText | `packages/core/index.js:394`, `:430` | security | minor | Текстовый сканер: (1) PAN с префиксом **3** (Amex/JCB/Diners) не маскируется — проба `378282246310005` (Luhn валиден, 15 цифр) проходит без изменений, тогда как тот же PAN по ключу `pan` → `[REDACTED]`; (2) `Basic`/`Bearer`-токен короче 8 символов не редактируется (`Bearer abc`, regex `{8,}`). JSDoc (386–391) объявляет 2/4/5/6 сознательно — но расхождение «ключ vs текст» и отсутствие 3-префикса не задокументированы. | Добавить префикс 3 в `looksLikePan` (или явную строку в SECURITY.md «Amex/JCB не покрываются»), снизить порог токена; регресс на Amex-PAN в тексте. | F-09 |
| PA-04 | redactSecrets | `packages/core/index.js:445`, `:448` | correctness | minor | Снимок/журнал молча теряет данные: массив >100 элементов обрезается без маркера (`value.slice(0, 100)`, проба: 150 → 100), объект глубже 12 заменяется строкой `'[…]'`. Для диагностики чека >100 позиций `/admin` покажет усечённый чек без признака усечения — «тихая ложь» при отладке. | Добавлять маркер обрезки (хвостовой `[…+N]` или поле), либо поднять константы; регресс на массив 150. | PA-27 (A-1b — unknown-ключи журнала; отдельная механика, не дубль) |
| PA-05 | readBody | `packages/core/index.js:213–256` | resilience | minor | Content-Length не сверяется: объявленное `Content-Length` > лимита не даёт раннего 413 (до 5 МБ реально получаемых байтов + полный дренаж остатка), тело без конца держит promise до серверного `requestTimeout` (Node-дефолт 300 с). На hosted-стенде — дешёвый способ занять память/сокеты (усиление MS-20; сам MS-20 про таймауты сервера — не дубль). | При `Content-Length > maxBytes` — отклонять 413 до чтения (с сохранением дренажа по AGENTS §8); сверять `received !== declared` при `end` → 400. | MS-20 (переформулировка) |
| PA-06 | readBody | `packages/core/index.js:253` | dx | info | Обработка обрыва клиента — событие `aborted`, помеченное в Node как deprecated (с 17-й линии; Node 24 ещё доставляет — пробы зелёные). Молчаливая деградация при будущих версиях Node: promise зависнет вместо reject. | Добавить параллельный обработчик `close` с проверкой `req.complete`; проверить на Node 22/24 в CI-матрице. | MS-40 (EOL-матрица) |
| PA-07 | escapeHtml | `packages/core/index.js:296–298` | dx | info | `escapeHtml` не экранирует backtick (риск только для некавычковых атрибутов — в кодовой базе отсутствуют) и не нейтрализует `javascript:`-схемы (проба: строка проходит как есть). Живых sink-ов с URL интегратора в `href`/`src` сейчас нет (проверено по всем 4 сервисам), но функция — публичный экспорт для будущих страниц админок. | Для новых страниц: в href/action — только внутренние пути; задокументировать в packages/core/README контракт «escapeHtml ≠ URL-sanitizer» (при необходимости — отдельный `safeUrl`). | A-14 (закрыт, расширяет контракт) |
| PA-08 | parseBody | `packages/core/index.js:258–270` | docs | info | Поведение парсера не задокументировано (код — единственная истина): дубли ключей — last-wins; массивов `key[]` и вложенности `a[b]` нет (литеральные ключи); любой не-JSON Content-Type (`text/plain`, `multipart/form-data`, пустой) парсится как form; JSON с BOM → `{}` → 400 «пустое тело» (проба). Интегратор с BOM/multipart получает неочевидный отказ. | Строка в `packages/core/README.md` + сверка README сервисов о допустимых Content-Type; регресс на BOM. | PB-10 |
| PA-09 | redactQuerySecrets | `packages/core/index.js:523–544` | security | info | Редакция query не заходит в fragment: `#token=LEAK` и псевдо-query после `#` (`x?a=1#frag?sandbox_token=NOPE`) остаются без изменений (пробы через `buildCurlCommand`). Для реального HTTP безопасно (fragment не отправляется на сервер), но `buildCurlCommand` принимает произвольный `path` — сгенерировать curl с секретом возможно. | Распространить замену на fragment либо отбрасывать fragment в `buildCurlCommand`. | F-04 (закрыт) |

Severity-сводка: **blocker ×0, major ×0, minor ×5 (PA-01…PA-05), info ×4 (PA-06…PA-09).**

---

## §3. Покрытие строк 1–546

Прочитано **целиком, без пропусков** (546 строк; файл 2670 строк — остальное вне зоны):

| Блок | Строки ядра | Статус | Пробы |
|---|---|---|---|
| Шапка/SPDX/комментарий-оглавление, requires | 1–33 | ✅ | — |
| env-флаги `flagEnabled` | 35–52 | ✅ | сопряжённо (F-08/PF-01 закрыты, A-1b) |
| store: `isPlainObject`, `DANGEROUS_STATE_KEYS` | 54–61 | ✅ | §5-A |
| `safeStateSnapshot` | 63–145 | ✅ | §5-A (5 форм загрязнения + массивы/глубина) |
| `mergeValidatedInto` / `mergeInto` / `createStore` | 147–201 | ✅ | §5-A (restore ×5, null-proto) |
| `createLog`/`nowIso` | 203–209 | ✅ | — |
| `readBody` | 211–256 | ✅ | §5-E (10 кейсов) |
| `parseBody` | 258–270 | ✅ | §5-B/§5-D (25 кейсов) |
| `send`/`sendJson`/`html` | 272–286 | ✅ | чтение + вызовы адаптеров |
| `escapeHtml` | 288–298 | ✅ | §5-C1 (9 кейсов + 5 МБ perf 363 мс) |
| redaction: ключи/PII/Луна/PAN-маски | 300–432 | ✅ | §5-C (28 кейсов) |
| `redactSecrets`/`redactRawBody`/`summarizeBody` | 434–511 | ✅ | §5-C (глубина 22, массив 150, цикл, формы ×9) |
| journal-начало: `SENSITIVE_QUERY_KEYS`, `redactQuerySecrets`, `shellQuote` | 513–546 | ✅ | §5-C (query ×7 через `buildCurlCommand`) |

Сопряжённо (вне диапазона, для следствий/дублей): `filterJournalHeaders`/`JOURNAL_HEADER_ALLOWLIST`/
`JOURNAL_LIMITS` (576–612 — граница с A-1b), `module.exports` (2619–2670), вызовы `parseBody`
(kassa:1884, yookassa:1699, tbank:2520, atol:1471), обёртки ошибок `route` (yookassa:2063–2073,
kassa:1257+, tbank:2516+), `sandboxRuntime.run` (ядро:2211–2214, зона A-2), HTML-источники
интерполяции в 4 сервисах (grep `href=|action=|src=`).

---

## §4. Дубли и уже поставленное

| Сущность | Чей пункт | Статус по A-1a | Решение |
|---|---|---|---|
| F-01 prototype pollution | REGISTRY #5 | закрыто подтверждено (пробы §5-A) | новый ID не заводить; остаток MS-17 — регресс-тест (бриф §0.1), не дублировать |
| F-02 лимит тела/413 | REGISTRY #6 | закрыто подтверждено (§5-E) | не дублировать; Content-Length-аспект выделен в PA-05 как дополнение к MS-20 |
| F-09 редакция журналов | REGISTRY #7 | закрыто подтверждено для ключей/заголовков | пробелы форм/текст-сканера — PA-02/PA-03 (расширение, не reopen) |
| F-04 curl/`redactQuerySecrets` | REGISTRY #30 | закрыто подтверждено | fragment-хвост — PA-09 (info) |
| A-14 escapeHtml | аудит 08.10 §5.2 | закрыто подтверждено | PA-07 — контракт на будущее, не дефект реализации |
| MS-17 остаток «регресс-тест» | бриф §0.1/§7 | подтверждено (form/JSON пути чисты) | остаётся за волной PR-C, ID не нужен |
| MS-20 таймауты сервера | бриф §0.1 | вне зоны (серверные опции) | PA-05 — смежное дополнение, помечено |
| PB-10 (B-партия) 415-гейт | AUDIT-PARTY-B §2 | не дубль | PB-10 — Content-Type-гейт yookassa; PA-08 — недокументированность парсера ядра |
| PA-27 (A-1b) unknown-ключи журнала | AUDIT-PARTY-A1b §2 | не дубль | PA-27 — растущий журнал; PA-04 — обрезка массивов/глубины в redactSecrets |
| PA-31 (A-1b) URL в логах очереди | AUDIT-PARTY-A1b §2 | не дубль | PA-09 — fragment в curl-генераторе ядра |
| PD-02/PD-08 (D-партия) persist | AUDIT-PARTY-D §2 | вне зоны | — |

---

## §5. Прогоны (команды + вывод)

Все скрипты — `/tmp/partyA1a-scratch/` (вне репозитория). `npm test` не запускался (запрещён
постановкой партии; baseline зелёный по брифу координатора). Сетевых обращений, кроме loopback-пробы
§5-F, не было; порты 3100–3103 не использовались (listener — 127.0.0.1:0, эфемерный порт).

**§5-A. Q1 — состояние (p1-state.js).** Команда: `node /tmp/partyA1a-scratch/p1-state.js`

```
nested __proto__: restore ok=true, polluted=false, keys=
nested constructor: restore ok=true, polluted=false, keys=
nested prototype: restore ok=true, polluted=false, keys=
top __proto__: restore ok=true, polluted=false, keys=
array elem __proto__: restore ok=true, polluted=false, keys=
restore simple ok, proto of state.a = null
stderr: state restore failed: state: запрещён опасный ключ "__proto__" по пути state."a"."__proto__" (и 4 аналогичных)
```

**§5-B. Q2 — parseBody (p2-parsebody.js, p2c.js, p2d.js).** Ключевые строки вывода:

```
1 form __proto__[x]: {"__proto__[x]":"1"}            ← литеральный ключ
3 constructor[polluted]=1: proto clean=true          4 prototype key: {"prototype":"1","x":"2"}
5 dup keys key=a&key=b: {"key":"b"}                  ← last-wins
6 key[]=a&key[]=b: {"key[]":"b"}                     ← массивов нет
7/8 a[b][c]=d: {"a[b][c]":"d"}                       ← вложенности нет
12 json depth 1000: ok (len 2006); depth 20000 и 1e6: JSON.parse ok, RangeError перехвачен catch → {}
14 json __proto__: own-key=true, global polluted=false
16/17/18: text/plain, multipart, без CT → парсятся как form
21 malformed %: parseBody THROWS URIError — не перехвачено в ядре (PA-01)
22 utf8: {"a":"б"}   23 BOM+json: {}   24 lone surrogate %ED%A0%80: THROWS URIError
25 form __proto__={"x":1}: строка-значение, own-key отсутствует, прототип не менялся
200k пар формы: 200000 ключей за 250 мс
```

**§5-C. Q3 — редакция (run1.js, run2.js).** Сводка (полная таблица — §1/Q3):

```
Authorization/Token/Cookie/password/secret/pan/Password/Pass/CardData → [REDACTED]
data.Data{Token,Password} → оба [REDACTED]; массив объектов → рекурсия ок
Idempotence-Key → "u1" (не редактируется); RebillId → "123456" (не редактируется)
text Visa PAN → 411111**1111; text Amex 378282246310005 → без изменений (PA-03); Mir 2200… → 220000**0004
Bearer jwt → [REDACTED]; «Bearer abc» → без изменений (PA-03)
depth 22 → "[…]" на 12-м уровне; array 150 → 100 элементов (PA-04); цикл — не зависает
form admin_token/sandbox_token/operator_token → [REDACTED]; comment=4111111111111111 → 411111**1111
form «a=1&&password=x» → без изменений (PA-02); token%5F2=t → без изменений (PA-02); password_confirmation=p2 → без изменений (PA-02)
query admin_token/sandbox_token/operator_token/ACESSTOKEN → YOUR_TOKEN; Password= → REDACTED
query «/x?a=1#frag?sandbox_token=NOPE» и «/x#token=LEAK» → без изменений (PA-09)
summarizeBody: password/pan → [REDACTED], note → 411111**1111, вложенные объекты скрыты целиком
```

**§5-C1. Q4 — escapeHtml (p4.js):**

```
" onmouseover=" → &quot;…; ' → &#39;; <script> → &lt;script&gt;; a&b → a&amp;b
null/undefined → ""; 0 → 0; NaN → NaN; Symbol → "Symbol(x)"
backtick → без изменений (PA-07); javascript:alert(1) → без изменений (PA-07)
5 МБ строки → 26 000 000 симв. за 363 мс (линейно)
```

**§5-E. Q5 — readBody (p5-readbody.js, p5b.js):**

```
5 242 880 байт: ок; 5 242 881: BODY_TOO_LARGE 413; maxBytes=0/−1 → 413 на "a";
maxBytes=NaN/Infinity/'100'/undefined → resolve (NaN/Inf → fallback 5 МБ, '100' → 100)
chunked 1000×1B → 1000; разорванный по чанкам utf8 «б»×1000 → ровно 1000 символов;
невалидный utf8 → "\ufffd\ufffd"; readBody.length=1 (заголовки недоступны — PA-05)
```

**§5-F. Живая проба PA-01 (listener 127.0.0.1:0, эфемерный порт):**

```
MOCK_PORT=0 MOCK_HOST=127.0.0.1 node services/kassa-mock/server.js  →  127.0.0.1:37031
GET /admin → 200
POST /admin/action, тело «a=%zz&b=1» → 500 (лог: «handler error: URI malformed»); процесс жив
```

**Чек-боксы §4.A чек-листа — в части A-1a:**

- [x] Отчёт `docs/audit/AUDIT-PARTY-A1a-2026-10-12.md` создан по структуре §4 чек-листа (§1 итог → §2 реестр → §3 покрытие → §4 дубли → §5 прогоны).
- [x] Новые задачи — только строками «предлагаемая задача» в реестре §2 (issue не создавались).
- [x] Запреты §5 чек-листа соблюдены: код/тесты/compose/CI/манифесты не менялись (git status — только этот отчёт); реальные PAN/секреты не использовались (все номера — тестовые Luhn-примеры: 4111…, 3782…, 2200…).
- [x] Утверждения — с `файл:строка` и выводом команд; GHCR/Docker-поведение не проверялось (непроверяемо из песочницы) — таких утверждений нет.
- [ ] Обновление §3/§6 AUDIT-PREP и §0.1/§7 брифа — не выполнялось (read-only партия; сводка передана координатору через worklog).
- [x] `npm run check:links` после добавления отчёта — **зелёный**: «docs links OK: 65 файлов, битых ссылок нет» (65 = 64 предыдущих + этот отчёт).
