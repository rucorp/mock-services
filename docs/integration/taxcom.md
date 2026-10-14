© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).
SPDX-License-Identifier: Apache-2.0

# Такском — интеграция чтения фискальных данных (API v2)

Срез 2026-10-11: [авторизация и discovery](../reference/taxcom/01-api-auth-and-discovery.md),
[документы, частота опроса и границы](../reference/taxcom/02-documents-and-test-limits.md).
[Манифест](../../protocols/taxcom-ofd.json),
[OpenAPI 3.1](../openapi/taxcom-mock.openapi.json),
[README сервиса и env](../../services/taxcom-mock/README.md).

**Это чтение кабинета/ОФД, не печать чеков.** Такском API v2.17 отдаёт
фискальные документы, уже принятые ОФД. Создание/фискализация чека, возврат и
callback печати в публичном срезе не найдены, поэтому write API
**не моделируется**: известный маршрут с другим методом даёт `405`, неизвестный
`/API/...` — `404`, обе с подсказкой. Это не Ferma, не АТОЛ Онлайн и не OKassa — не подменяйте их
контракты именем Такском.

## 1. Адреса и запуск

| Назначение | База |
| --- | --- |
| Production | `https://api-lk-ofd.taxcom.ru` |
| Тестовый контур | `https://api-tlk-ofd.taxcom.ru` |
| Локальный мок (auth + данные) | `http://localhost:3109` |

Общий путь методов — `/API/v2/...`. У провайдера авторизация и данные идут по
одной базе, у мока — тоже один сервис, поэтому в адаптере достаточно одной базы.

Публичных тестовых `login`/`password`/`Integrator-ID` Такском **не публикует**:
их выдаёт техподдержка/кабинет (**[VERIFY]**). В моке работают синтетические
дефолты — они печатаются в стартовом логе и **не являются реквизитами
провайдера**:

```text
taxcom-mock synthetic credentials (не реквизиты Такском):
  login=taxcommocktest password=mockpass123 Integrator-ID=TAXCOMMOCKTEST;
  Session-Token TTL 300s sliding (virtual clock)
```

```bash
npm run start:taxcom       # :3109, креды по умолчанию — синтетические
npm run test:taxcom        # HTTP selftest на эфемерном порту, без Docker
```

Свои синтетические значения задаются env (`MOCK_TAXCOM_LOGIN`,
`MOCK_TAXCOM_PASSWORD`, `MOCK_TAXCOM_INTEGRATOR_ID`); заданные через env креды
в логе скрываются. В `owned`-режиме `POST /sandboxes` генерирует собственные
mock-реквизиты песочницы. Production-креды не коммитьте и не отправляйте в мок.

### Docker / compose

Сервис зарегистрирован в корневом `docker-compose.yml` (профиль по умолчанию,
bind `127.0.0.1:3109`) и во внешнем `docker-compose.include.yml` (профиль
`mock`). `Dockerfile` содержит `EXPOSE 3109`, healthcheck опрашивает
`:3109/health`. Публикация GHCR-образа и смена release pin — отдельный процесс
владельца: закреплённый релиз ещё не содержит этот адаптер, поэтому для include
соберите локальный образ и снимите digest override:

```bash
docker build -t mock-services:taxcom-local .
MOCK_IMAGE=mock-services MOCK_IMAGE_TAG=taxcom-local MOCK_IMAGE_DIGEST='' \
  docker compose -f docker-compose.include.yml --profile mock up -d taxcom-mock
```

В приложении из другого контейнера используйте `http://taxcom-mock:3109`, а не
его `localhost`. Для удалённого доступа задайте
`MOCK_TAXCOM_PUBLIC_BASE_URL` и TLS/reverse proxy; control endpoints в интернет
не выставляйте.

## 2. Login → Session-Token (5 минут, sliding)

```bash
BASE=http://localhost:3109
TOKEN=$(curl -fsS -X POST "$BASE/API/v2/Login" \
  -H 'Content-Type: application/json' \
  -H 'Integrator-ID: TAXCOMMOCKTEST' \
  -d '{"login":"taxcommocktest","password":"mockpass123"}' \
  | node -pe 'JSON.parse(fs.readFileSync(0,"utf8")).token')

curl -fsS "$BASE/API/v2/AccountList" -H "Session-Token: $TOKEN"
```

- `Integrator-ID` — **заголовок**, обязателен на `POST /API/v2/Login`; без него
  и с неизвестным значением — `401` с `field: Integrator-ID`.
- Тело — JSON. **[VERIFY]** Официальная схема `Login_Request` (приложение к
  API Help) в публичной HTML-части не раскрыта, поэтому реализована
  консервативная форма `{"login": "...", "password": "..."}`: оба поля
  обязательны, неизвестные ключи отклоняются `400` с пометкой
  `verify: "Login_Request [VERIFY]"`. Не подставляйте сюда поля из сторонних
  SDK — при выдаче доступа форму нужно пересверить.
- Ответ несёт временный marker в поле `token` (**[VERIFY]** имя поля тоже не
  раскрыто срезом). Далее все вызовы несут заголовок `Session-Token`;
  `Authorization: Bearer` не подходит.
- TTL — **300 секунд (5 минут)**, sliding от последнего успешного использования,
  на **виртуальных часах** стенда. Просроченный маркер → `HTTP 401`
  (`errorCodeId: 401`), сессия удаляется. Настройка —
  `MOCK_TAXCOM_SESSION_TTL_SECS` (целые секунды 1..31536000, `0` запрещён).
- **[FORK]** Повторный Login выдаёт **новый** marker, а прежний продолжает
  действовать до своего TTL. Срез формулирует иначе: «Повторный Login не выдаёт
  новый marker, пока предыдущий действителен». Решение владельца зафиксировано
  как документированный форк и требует пересверки на стенде провайдера.
- Mock-only заголовки ответа Login: `X-Mock-Token-Expires-At`,
  `X-Mock-Token-Ttl-Secs` — удобно для тестов TTL без ожидания.
- Отзыв маркера воспроизводится reset'ом песочницы, импортом `/mock/state` и
  ротацией кредов (`/sandboxes/me/reset-creds`).

## 3. AccountList — договоры и права

`GET /API/v2/AccountList` → массив договоров/личных кабинетов, доступных
пользователю, и его права. Синтетический каталог **[FORK]** (независимо
копируется в каждую песочницу):

- `an=1000001` — «Демо кабинет Такском»: ККТ `0000000000000001` с доступом и
  ККТ `0000000000000002` без согласия (её документы в выдачу не попадают);
- `an=1000002` — «Кабинет без доступной ККТ»: договор виден, но `NewDocuments`
  с этим `an` даёт **3106**;
- `an=1000003` — «Нет согласия на данные»: в `AccountList` отсутствует, адресный
  запрос — `404`.

Поля ответа (`an`, `inn`, `kpp`, `name`, `rights`) — локальная форма **[FORK]**:
срез подтверждает «договоры/личные кабинеты и права пользователя», но схему не
раскрывает. Внутренний признак `accessible` наружу не выдаётся.

## 4. NewDocuments — 10 суток, 10 000, курсор по id

```bash
curl -fsS "$BASE/API/v2/NewDocuments" -H "Session-Token: $TOKEN"
curl -fsS "$BASE/API/v2/NewDocuments?an=1000001&id=doc-0013" -H "Session-Token: $TOKEN"
```

Query: `an` — необязательный номер договора, `id` — курсор. Алгоритм обхода:

1. Первый вызов — **без `id`**.
2. Ответ — JSON-массив документов, отсортированный по **времени приёма
   Такскомом** (`receivedAt`), а не по фискальному `dateTime`.
3. Запомните `id` последнего полученного документа и передайте его в `id`
   следующего запроса; период/фильтры/песочницу не меняйте.
4. Пустой массив (`[]`, `HTTP 200`) — хвост достигнут, обход завершён.
5. За вызов возвращается не более **10 000** документов; метод отдаёт только
   документы, принятые за последние **10 суток** (нижняя граница окна включена —
   **[FORK]**).
6. Провайдер рекомендует опрашивать **не чаще раза в минуту**. Это совет
   документации, а не жёсткое правило мока: мок не throttles запросы, но и
   новые документы сам не печатает — демо-набор фиксирован.

```text
[
  {
    "id": "doc-0002", "an": "1000001", "kktRegNumber": "0000000000000001",
    "type": "receipt",
    "receivedAt": "2026-10-02T09:05:00.000Z", "dateTime": "2026-10-02T09:08:00.000Z",
    "fiscalDocumentNumber": 2, "fiscalSign": "1000000002", "shiftNumber": 1,
    "operationType": 1, "totalSum": 12345, "cashSum": 0, "electronicSum": 12345,
    "items": [{ "name": "Тестовый товар", "price": 12345, "quantity": 1, "sum": 12345 }]
  }
]
```

Типы документов из среза: открытие смены (`openShift`), закрытие смены
(`closeShift`), состояние расчётов (`currentStateReport`), чек (`receipt`), чек
коррекции (`receiptCorrection`), БСО (`bso`), БСО коррекции (`bsoCorrection`).
Имена типов и полей — **[FORK]** (схема `NewDocuments_Response`, Приложение №12,
в HTML-части не отображается). **Суммы — в целых копейках** (конвенция ФФД:
`12345` = 123,45 ₽); срез Такском единицы не закрепляет, поэтому это локальная
договорённость **[FORK]**. Возврат прихода — уже существующий ФД с
`operationType=2`. **[VERIFY]** Ставки НДС `22%` и `22-122` в агрегатах смены
(новое в v2.17) срезом упомянуты, но имена полей не раскрыты — в моке не
моделируются.

Ошибки из среза:

| Код | HTTP | Когда |
| --- | --- | --- |
| `3106` | 403 | Нет доступной ККТ (например, `an` договора без видимых касс) |
| `2203` | 400 | Некорректный курсор `id`, в том числе документ вне окна 10 суток |

Соответствие кодов HTTP-статусам срезом не закреплено — это **[VERIFY]**/[FORK]
мока; конверт ошибки `{errorCodeId, message, field, hint, doc}` локальный, для
остальных случаев `errorCodeId` равен HTTP-статусу.

## 5. Сценарии, часы и журнал

- `X-Mock-Scenario: fail` → `HTTP 500` без изменения данных;
- `hang` → ожидание до закрытия соединения клиентом, задавайте timeout;
- `duplicate` → повтор первой строки с **тем же `id`/ФД/ФП** до курсорной
  нарезки; лимит 10 000 сохраняется, курсор разрешается по **первому** вхождению
  `id` **[FORK]**. Задавайте сценарий на всех запросах одного обхода;
- `latency:200ms`, `http-500`, `http-504` — общий транспортный chaos ядра;
- `POST /mock/scenarios` `{"scenario":"fail","target":"read","times":1}` —
  одноразовый отказ; targets `auth`, `read`, `*`; есть `persistent` и `match`;
- `GET/DELETE /mock/scenarios` — правила/история и очистка;
- `POST /mock/time` `{"advance":"+6m"}` — истечение `Session-Token` без ожидания
  пяти минут; `{"advance":"+11d"}` — документы выпадают из окна 10 суток, и
  `NewDocuments` возвращает пустой массив.

Часы, fixtures, сценарии и журнал изолируются `X-Mock-Sandbox`. TTL **самой
песочницы** остаётся на wall-clock ядра. Демо-документы задаются смещением от
базы стенда (`MOCK_VIRTUAL_CLOCK` либо wall-clock), поэтому окно 10 суток не
«устаревает» вместе со стендом **[FORK]**. `GET /admin` — read-only консоль,
`/admin/journal` — журнал без тела Login, `Session-Token`, `Integrator-ID` и raw
headers. Исходящих запросов у сервиса нет: ни callback, ни webhook, поэтому
очередь доставки ядра и SSRF-политика к адаптеру не подключаются.

## 6. Песочницы и mock control (не API провайдера)

В self-hosted режиме без токенов control открыт локально. Для hosted:
`MOCK_HOSTED=1`, tenancy по умолчанию `owned`; `/admin` fail-closed без
`MOCK_ADMIN_TOKEN`, `/mock/*` — без operator/admin-токена или собственного
owner-token. `GET /health`, `/openapi.json` и создание песочницы публичны.

`POST /sandboxes` с `{"id":"reader-a"}` в owned выдаёт `ownerToken` и
`creds: {login, password, integratorId}`. В каждом запросе передавайте:

```text
X-Mock-Sandbox: reader-a
X-Sandbox-Token: <ownerToken>
Integrator-ID: <creds.integratorId этой песочницы>   # на Login
Session-Token: <token этой песочницы>                # на чтение
```

Знание sandbox ID доступа не даёт; чужой owner-token и чужой `Session-Token`
отклоняются независимо. `GET /sandboxes/me` — метаданные без повторного
раскрытия кредов; `POST /sandboxes/me/reset` — восстановить fixtures и отозвать
маркеры; `POST /sandboxes/me/reset-creds` — новые mock-креды и отзыв маркеров
(owner-token сохраняется); `DELETE /sandboxes/me` — удалить песочницу.
`/mock/sandboxes` — operator alias.

`GET /mock/state` экспортирует fixtures (**без маркеров**). `PUT /mock/state`
импортирует snapshot `{accounts:[], kkt:[], documents:[], clockOffsetMs:0}` (или
`{state: snapshot}`) и отзывает сессии: используйте экспорт как шаблон, сохраняя
`an`/`kktRegNumber`/`accessible`, валидные ISO-даты `receivedAt`/`dateTime` и
целочисленные суммы в копейках. Не импортируйте реальные ФД и ПДн. Это
**только mock-control**, не выдуманный provider endpoint создания чека.
`POST /mock/reset` сбрасывает текущую песочницу; сброс чужой — запрещён.
State files содержат маркеры и сгенерированные mock-креды: ограничьте доступ к
volume. [Модель угроз](../../SECURITY.md).

## 7. Границы и проверка

`npm run test:taxcom` — zero-dep HTTP selftest на эфемерных портах: Login
(`Integrator-ID`, **[VERIFY]**-форма тела, неверные креды), sliding TTL 300 с и
`401` по истечении, `AccountList`, `NewDocuments` (окно 10 суток, сортировка по
`receivedAt`, курсор, хвост → пустой ответ, лимит 10 000 на 10 001 документе,
3106/2203, неизвестный `an`), read-only границы 405/404, сценарии, изоляция
песочниц, owned-режим и ротация кредов, квота сессий, persist/restore, секреты и
независимые негативные drift-контроли. Он включён в `npm test`; `check:drift`
сверяет отдельную таблицу dispatch с OpenAPI, а не присваивает
`inOpenApi=inServer`.

Не покрыто: реальный тестовый контур и его закрытые схемы, метод чтения одного
ФД по ID (публичный URL не подтверждён), статистика, агрегаты смены со ставками
22%/22-122, права/роли в полном объёме. Write API, печать и callback **не
моделируются**. Все локальные решения перечислены как `[VERIFY]`/`[FORK]` выше и
в манифесте; проверка соответствия стенду провайдера не заявляется.
