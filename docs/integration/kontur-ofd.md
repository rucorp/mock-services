© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).
SPDX-License-Identifier: Apache-2.0

# Контур.ОФД — интеграция чтения фискальных данных

Срез 2026-10-11: [доступ и auth](../reference/kontur-ofd/01-auth-and-access.md),
[организации, кассы, документы и ошибки](../reference/kontur-ofd/02-document-retrieval.md).
[Манифест](../../protocols/kontur-ofd.json),
[OpenAPI 3.1](../openapi/kontur-ofd-mock.openapi.json),
[README сервиса и env](../../services/kontur-ofd-mock/README.md).

**Это read/reconciliation, не очередь печати.** Чтение документов, уже принятых
ОФД, не создаёт новый чек и не запускает возврат. Write-путь / создание чека /
callback печати **не моделируется**: публичный контракт для них не опубликован.
Статусов `wait/done` и webhook-подписи у этого адаптера нет.

## 1. Адреса и запуск

| Назначение | База |
| --- | --- |
| Пользовательская авторизация | `https://api.kontur.ru` |
| Production data API | `https://ofd-api.kontur.ru` |
| Тестовый data API | `https://ofd-project.kontur.ru:11002` |
| Локальный мок auth + data | `http://localhost:3108` |

У настоящего провайдера auth и данные находятся на разных hosts; у мока —
один сервис. В адаптере приложения настраивайте обе базы отдельно и не
отправляйте настоящий пароль в локальный мок.

Публичных статических тестовых login/password/API key нет. Они выдаются
провайдером отдельно. **[FORK]** Дефолтных секретов в коде/compose нет:
задайте свои синтетические значения только через env, например в локальной
оболочке (не коммитьте `.env`):

```bash
export MOCK_KONTUR_OFD_LOGIN='reader@example.invalid'
export MOCK_KONTUR_OFD_PASSWORD="$(node -p 'require("crypto").randomBytes(24).toString("hex")')"
export MOCK_KONTUR_OFD_API_KEY="$(node -p 'require("crypto").randomBytes(24).toString("hex")')"
npm run start:kontur-ofd
```

Без env авторизация default-песочницы закрыта. В `owned`-режиме
`POST /sandboxes` выдаёт случайные **mock-only** реквизиты отдельной песочницы
и owner-token. Они не являются реквизитами тестового стенда Контур.ОФД.

### Docker / внешний include

Новый сервис зарегистрирован **в include**, а не в корневом `docker-compose.yml`.
Публикация GHCR-образа и смена release pin — отдельный процесс владельца.
Текущий закреплённый релиз `0.6.0` ещё не содержит этот новый адаптер: для
проверки ветки соберите локальный образ и явно снимите digest override:

```bash
docker build -t mock-services:kontur-local .
MOCK_IMAGE=mock-services MOCK_IMAGE_TAG=kontur-local MOCK_IMAGE_DIGEST='' \
  docker compose -f docker-compose.include.yml --profile mock up -d kontur-ofd-mock
```

Bind по умолчанию `127.0.0.1:3108`, внутри контейнера `0.0.0.0:3108`;
`Dockerfile` содержит `EXPOSE 3108`. В приложении из другого контейнера
используйте `http://kontur-ofd-mock:3108`, а не его `localhost`.
Для удалённого доступа задавайте внешний `MOCK_KONTUR_OFD_PUBLIC_BASE_URL`
и TLS/reverse proxy; не выставляйте открытые control endpoints в интернет.

## 2. Sid + ключ интегратора

```bash
BASE=http://localhost:3108
SID=$(curl -fsS -X POST "$BASE/auth/authenticate-by-pass" \
  --url-query "login=$MOCK_KONTUR_OFD_LOGIN" \
  -H 'Content-Type: text/plain; charset=utf-8' \
  --data-binary "$MOCK_KONTUR_OFD_PASSWORD" | node -pe 'JSON.parse(fs.readFileSync(0,"utf8")).Sid')

curl -fsS "$BASE/v2/organizations" \
  -H "Authorization: auth.sid $SID" \
  -H "X-Kontur-Ofd-ApiKey: $MOCK_KONTUR_OFD_API_KEY"
```

Пароль — **текст UTF-8**, не JSON и не `password=...`. Sid и API key —
разные секреты. Синтаксис `Bearer` вместо `auth.sid` не подходит.
`POST /auth/authenticate-by-pass?login=<email>` возвращает `{Sid}`;
все `/v2/...` требуют **оба** заголовка.

Срок Sid по умолчанию **2592000 секунд / 30 дней** на виртуальных часах,
настройка `MOCK_KONTUR_OFD_SID_TTL_SECS` (целые секунды 1..31536000).
При `401 errorCodeId=401002` получите новую сессию, затем повторите чтение;
не путайте это с `401003` — отсутствующим/неизвестным API key.
Повторная авторизация сохраняет предыдущие Sid до TTL **[FORK]**:
публичный срез не задаёт правила повторной выдачи.
Отзыв Sid воспроизводится reset/import/rotation песочницы.

## 3. Организации и кассы

`GET /v2/organizations` → массив `{id, inn, kpp, name}` доступных организаций.
Далее `GET /v2/organizations/{organizationId}/cashboxes` → массив касс.
Сохраняйте как минимум `regNumber`, `model`, `fiscalDriveNumber` (ФН),
`address`, историю `addresses`, границы `accessPeriod.dateFrom/dateTo`.

Синтетический каталог **[FORK]**, независимо скопированный в каждую песочницу:

- `org-demo`, касса `0000000000000001`, документы за **2026-10-11**;
- `org-restricted` известна, но без согласия: 403 при адресном чтении;
- касса `0000000000000002` известна, но без прав: 403;
- неизвестные организации/кассы/документы: 404.

Запрещённые объекты отсутствуют в списках. Адресные запросы позволяют отличить
отсутствие прав от неизвестного ID. Поля `accessible`, `organizationId`,
`kktRegId` — внутренние связи fixture, в provider-ответах они не выдаются.
Границы доступа сохраняются как метаданные; сложная историческая модель
согласий и обрезание периода по ним не моделируются.

## 4. Документы и пагинация

```bash
DOCS="$BASE/v2/organizations/org-demo/cashboxes/0000000000000001/documents"
curl -fsS "$DOCS?date=2026-10-11&types=receipt,bso" \
  -H "Authorization: auth.sid $SID" \
  -H "X-Kontur-Ofd-ApiKey: $MOCK_KONTUR_OFD_API_KEY"

curl -fsS "$DOCS/by-period?dateFrom=2026-10-11T00:00:00&dateTo=2026-10-11T23:59:59&types=receipt&offset=0&limit=2" \
  -H "Authorization: auth.sid $SID" \
  -H "X-Kontur-Ofd-ApiKey: $MOCK_KONTUR_OFD_API_KEY"
```

За дату ответ — массив; за период — `{documents: [...], paging: {nextOffset}}`.
Алгоритм сверки:

1. Начните с `offset=0`, задайте `limit` от 1 до **1000** (дефолт 1000).
2. Сохраняйте документ по его `id` и фискальной идентичности, а не по номеру
   страницы; повторное чтение не создаёт новые документы.
3. Если `nextOffset !== null` и страница не пуста — повторите запрос с
   `offset=nextOffset`, не меняя период/фильтры/песочницу.
4. Пустая страница или `nextOffset=null` означает завершение.
5. `GET .../documents/{documentId}` отдаёт отдельный JSON-документ.

**[FORK] Развилка cursor:** в URL-примерах справки — `offset`, в списке
параметров — `currentOffset`, в ответе — `nextOffset`. С согласия владельца
до кода выбран **offset**. `currentOffset` **отклоняется HTTP 400 с подсказкой**,
не переименовывается молча. Выбор подтверждён **локальными** OpenAPI и selftest
(включая 1001 документ, cursor и негативные контроли drift). **Тестовая схема
провайдера не получена, проверка на его стенде не выполнена**; этот форк нужно
пересверить при выдаче доступа.

**[FORK]** Cursor мока — неотрицательный целый индекс; `nextOffset=null` при
исчерпании. Период включает обе границы; сортировка по времени и затем `id`.
Timezone-less `YYYY-MM-DDTHH:mm:ss` трактуется как UTC, разрешены также `Z`
и числовой offset (плюс в query кодируйте `%2B`). Дата дня — UTC.
Невалидные даты (включая 30 февраля), обратный период, неизвестный `types`,
дробный/отрицательный cursor, `limit=0` или `>1000` дают 400.
Пустой день — `[]`, пустой период — `{documents:[],paging:{nextOffset:null}}`,
**HTTP 200**, не ошибка и не «чек ещё печатается».

Все типы из публичного среза:
`fiscalReport`, `fiscalReportCorrection`, `currentStateReport`, `openShift`,
`closeShift`, `receipt`, `bso`, `receiptCorrection`, `bsoCorrection`, `closeArchive`.
`types` — значения через запятую; без него — все типы.

В чеке есть `id`, `type`, `date`, `fiscalDocumentNumber`, `fiscalSign`,
`shiftNumber`, `operationType`, `items`, `totalSum`, `cashSum`, `electronicSum`.
**Суммы в целых копейках**, включая `items[].price` и `items[].sum`:
`12345` = 123,45 рубля. Возврат — уже существующий ФД с `operationType=2`.
Числовые операции 1/2/3/4 (приход/возврат прихода/расход/возврат расхода),
имена полей адресов/ФН/сумм и полный fixture-envelope — локальная форма
**[FORK]** по конвенциям ФФД там, где срез не закрепляет полную схему.
Это не утверждение, что закрытая схема провайдера побайтно совпадает с моком.

## 5. Ошибки, сценарии и часы

Provider-ошибка имеет `errorCodeId`, `message`; устаревающее `errorCode`
не выдаётся. HTTP: 400 (запрос), 401 (доступ), 403 (нет согласия), 404
(не найдено), 500 (сценарий fail). Коды 401002/401003 закреплены срезом.
Остальные `errorCodeId=HTTP status`, тексты и DX-поля — **[FORK]** мока.

- `X-Mock-Scenario: fail` → HTTP 500 без изменения данных;
- `hang` → ожидание до закрытия соединения клиентом, задавайте timeout;
- `duplicate` → повтор первой строки с **тем же id/ФД/ФП** в конце выбранного
  списка **до** пагинации; лимит страницы не нарушается, cursor учитывает
  повтор как строку **[FORK]**. Для устойчивой пагинации задавайте этот
  сценарий на всех запросах одного обхода;
- `latency:200ms`, `http-500`, `http-504` — общий транспортный chaos ядра;
- `POST /mock/scenarios` `{"scenario":"fail","target":"read","times":1}` —
  одноразовый отказ; targets `auth`, `read`, `*`; есть `persistent` и `match`;
- `GET/DELETE /mock/scenarios` — правила/история и очистка;
- `POST /mock/time` `{"advance":"+31d"}` — истечение Sid без ожидания месяца.

Часы Sid, документы/fixtures, сценарии и журнал изолируются `X-Mock-Sandbox`.
TTL **самой песочницы** остаётся на wall-clock ядра, а не на виртуальных часах.
Демо-документы фиксированы на 2026-10-11: перевод часов не печатает новые ФД.
`GET /admin` — read-only консоль, `/admin/journal` — журнал без raw body,
Authorization, Sid, API key и login query. Никаких callback URL/доставок нет.

## 6. Песочницы и mock control (не API провайдера)

В self-hosted режиме без токенов control открыт локально. Для hosted:
`MOCK_HOSTED=1`, tenancy по умолчанию `owned`; `/admin` fail-closed без
`MOCK_ADMIN_TOKEN`, `/mock/*` — без operator/admin/собственного owner-token.
`GET /health`, `/openapi.json` и создание песочницы публичны.

`POST /sandboxes` с JSON `{"id":"reader-a"}` в owned выдаёт `ownerToken`
и `creds: {login,password,apiKey}`. В каждом запросе передавайте:

```text
X-Mock-Sandbox: reader-a
X-Sandbox-Token: <ownerToken>
Authorization: auth.sid <Sid этой песочницы>
X-Kontur-Ofd-ApiKey: <creds.apiKey этой песочницы>
```

В отличие от Bearer-адаптеров, `auth.sid` не конфликтует с owner-token в
`X-Sandbox-Token` (проверяется hosted-selftest). Знание sandbox ID само по себе
не даёт доступа. Чужой Sid и чужой owner-token отклоняются независимо.

`GET /sandboxes/me` — метаданные без повторного раскрытия кредов;
`POST /sandboxes/me/reset` — восстановить fixtures, отозвать Sid и очистить
сценарии/журнал; `POST /sandboxes/me/reset-creds` — новые mock-креды и отзыв
Sid, owner-token остаётся прежним; `DELETE /sandboxes/me` — удалить песочницу.
`/mock/sandboxes` — operator alias для списка/выбора/удаления.

`GET /mock/state` экспортирует внутренние fixtures (**без Sid**).
`PUT /mock/state` импортирует snapshot `{organizations:[], cashboxes:[],
documents:[], clockOffsetMs:0}` (или `{state: snapshot}`), отзывает сессии.
Для добавления fixtures используйте экспорт как шаблон: сохраняйте внутренние
связи `organizationId`, `kktRegId`, `accessible`, обязательные фискальные поля,
валидные даты и целочисленные суммы. Не импортируйте реальные чеки/ПДн.
Это **только mock-control**, не выдуманный provider endpoint создания чека.
`POST /mock/reset` сбрасывает текущую песочницу; попытка сбросить чужую
песочницу owner-token-ом запрещена. Стандартные квоты/TTLs — в README.
State files содержат Sid/сгенерированные mock-креды: ограничьте доступ к volume.

## 7. Границы и проверка

`npm run test:kontur-ofd` — zero-dep HTTP selftest на эфемерных портах:
доступ, каталог, все types, копейки, даты, чтение detail, пагинация 1000/1001,
400/401002/401003/403/404/500, fail/hang/duplicate, TTL, namespaces, owned,
rotation/reset, секреты, persist/restore и независимые негативные drift-контроли.
Он включён в `npm test`; `check:drift` сравнивает отдельную таблицу dispatch
с OpenAPI, а не присваивает `inOpenApi=inServer`.

Не покрыто: реальный тестовый контур/его схема, Cookie `auth.sid`, статистика,
история отзывов согласий, ограничение исторических данных периодом доступа,
прочие закрытые методы. Write/create/refund/printing callback **не моделируется**.
Сначала согласуйте закрытые контракты с владельцем, не заменяйте их поведением
Ferma/АТОЛ/Первого ОФД. Все локальные решения перечислены как `[FORK]` выше и
в манифесте, проверка provider conformity не заявляется.
