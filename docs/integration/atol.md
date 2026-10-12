© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Интеграция: АТОЛ Онлайн direct API v4 через mock (10 минут)

Мок воспроизводит **прямой API АТОЛ Онлайн версии v4** (ФФД 1.05) по
официальной документации: `POST /possystem/v4/getToken` → токен на 24 часа в
заголовке `Token`, шесть операций фискализации, отчёт `wait → done|fail` с
фискальными данными (ФД/ФП, ФН/ККТ, `ofd_receipt_url`) и callback результата
на `service.callback_url`. Источники: [выбор протокола](https://help.atol.online/article/11244),
[PDF API v4, версия 5.15](https://atol.online/files/API_atol_online_v4.pdf),
[тестовые реквизиты](https://atol.online/files/ffd/test_sreda.txt).

> **Это не Ferma.** Маршрут `/possystem/v4/` (у Ferma `/possystem/v1/`), токен
> в **заголовке** `Token:` (у Ferma `?token=`), токен живёт **24 часа** (у Ferma
> 12), суммы — **decimal-рубли** (у Ferma целые копейки), расчётные ставки НДС
> пишутся слитно — `vat120`, а не `vat20_120`, а повтор `external_id`
> **возвращает прежний UUID**, а не ошибку. Мок ловит все эти переносы и
> объясняет их в `hint`.

**v5 (ФФД 1.2) и маркировка «Честный ЗНАК» в этот стенд не входят** — это
следующий шаг.

## 1. Поднять стенд

```bash
docker compose up -d atol-mock        # http://localhost:3103
# или без docker: npm run start:atol
```

Стартовый лог печатает публичные тестовые реквизиты v4 — они и есть дефолты мока:

```
v4 creds: login=v4-online-atol-ru pass=iGFFuihss group=v4-online-atol-ru_4179 (тестовый контур, не production)
```

Это общие креды тестовой среды АТОЛ: фискализация идёт на МГМ, документ **не
отправляется в ФНС**. Свои креды/группы — `MOCK_ATOL_LOGIN`,
`MOCK_ATOL_PASSWORD`, `MOCK_ATOL_GROUP` (или `MOCK_GROUPS=a,b`).

## 2. Получить токен

```bash
TOKEN=$(curl -s http://localhost:3103/possystem/v4/getToken \
  -H 'Content-Type: application/json; charset=utf-8' \
  -d '{"login":"v4-online-atol-ru","pass":"iGFFuihss"}' | jq -r .token)
```

Токен действует **24 часа** и передаётся заголовком: `Token: <token>`.
Неверные креды → `error.code=14`; пропавший/истёкший токен → `error.code=11`.

## 3. Зарегистрировать чек (приход)

```bash
curl -s -X POST "http://localhost:3103/possystem/v4/v4-online-atol-ru_4179/sell" \
  -H "Token: $TOKEN" -H 'Content-Type: application/json' -d '{
    "external_id": "order-42",
    "timestamp": "12.10.2026 10:00:00",
    "service": { "callback_url": "https://myapp.test/atol/callback" },
    "receipt": {
      "client":  { "email": "buyer@example.test" },
      "company": { "email": "kassa@example.test", "inn": "5544332219",
                   "payment_address": "https://v4.online.atol.ru", "sno": "usn_income" },
      "items": [{
        "name": "Кофе латте", "price": 120.50, "quantity": 2, "sum": 241.00,
        "payment_method": "full_payment", "payment_object": "commodity",
        "vat": "vat120"
      }],
      "payments": [{ "type": 1, "sum": 241.00 }],
      "total": 241.00
    }
  }'
# → { "uuid": "…", "status": "wait", "timestamp": "…", "error": null }
```

Операции: `sell`, `sell_refund`, `sell_correction`, `buy`, `buy_refund`,
`buy_correction` — один и тот же формат тела, меняется только маршрут.

Правила, которые мок проверяет за вас:

- `client` — **хотя бы** `email` или `phone`;
- `company` — `email`, `inn` (10/12 цифр), `payment_address`; `sno` — при
  нескольких системах налогообложения;
- `items[]` — `name`, `price`, `quantity`, `sum` в **рублях (decimal, ≤2 знака)**,
  `vat` (базовая или расчётная ставка), `payment_method`, `payment_object`;
- `payments[]` — `type` (ФФД 1081: `0` наличные, `1` электронными, `2` аванс,
  `3` кредит, `4` встречное предоставление) и `sum`;
- арифметика: `sum = price × quantity`, `Σ items.sum = total = Σ payments.sum`;
- `external_id` — строка ≤128 символов, уникальная **в пределах группы**;
- `timestamp` — `dd.mm.yyyy HH:MM:SS`.

## 4. Получить результат

```bash
curl -s "http://localhost:3103/possystem/v4/v4-online-atol-ru_4179/report/<uuid>" -H "Token: $TOKEN"
# → { "uuid": "…", "status": "done", "payload": {
#      "fiscal_document_number": 50001, "fiscal_document_attribute": "1395957919",
#      "fn_number": "9999078902001294", "ecr_registration_number": "0001234567025896",
#      "ofd_receipt_url": "http://localhost:3103/receipts/<uuid>", … }, "error": null }
```

Статусы: `wait` → `done` | `fail`. Сохраняйте **весь** ответ: ошибка приходит
в `error` (`code`, `text`, `type`, `error_id`), и сводить её к HTTP-коду нельзя.

Опрос по рекомендации v4: **не чаще 3 запросов отчёта в секунду**, после
системной ошибки — подождать **не менее 1 секунды**, а если callback не пришёл
в течение **300 секунд** — переходить на polling.

## 5. Callback

Если передан `service.callback_url`, после обработки документа мок шлёт туда
`POST` с тем же объектом, что и `report` (`uuid`, `external_id`, `status`,
`error`, `payload`).

Важно: в публичной документации v4 **не заданы** правило ACK, подпись и
расписание повторов. Поэтому:

- принимайте callback **идемпотентно** (мок умеет слать дубли и ретраи —
  кнопка «повторить» есть в `/admin`, сценарий `webhook-duplicate`);
- **не выдумывайте проверку подписи** — протокол её не предусматривает;
- основным каналом сверки считайте `report`, callback — ускорением.

## 6. Идемпотентность: повтор `external_id` — не ошибка

```bash
# тот же external_id ещё раз (например, ретрай после таймаута):
curl -s -X POST "…/v4-online-atol-ru_4179/sell" -H "Token: $TOKEN" -d '{"external_id":"order-42", …}'
# → { "uuid": "Т ТОТ ЖЕ", "status": "wait|done", "error": null, "hint": "…тело проигнорировано…" }
#   + заголовок X-Mock-Replayed: 1
```

Второй чек не создаётся, прежнее тело не перезаписывается. Это **главное
отличие от Ferma**, где дубль — ошибка `code=12`. Область уникальности —
группа: тот же `external_id` в другой группе — другой документ.

## 7. Что мок проверит вместо вас

| Ошибка интегратора | Ответ мока |
|---|---|
| неверный `login`/`pass` | `error.code=14` |
| нет заголовка `Token`, чужой или истёкший (24 ч) токен | `error.code=11` (с объяснением: v4 — заголовок, не `?token=`) |
| опечатка в коде группы | `error.code=4`, `field: group_code` |
| `client` без `email` и `phone` | `error.code=4`, `field: receipt.client` |
| битый `company.inn` / нет `payment_address` | `error.code=4`, `field: receipt.company.*` |
| неизвестная ставка НДС | `error.code=4`, `field: receipt.items[i].vat` |
| `vat20_120` (Ferma-синтаксис) | `error.code=4` + hint «в v4 это `vat120`» |
| `payments[].type = 5` (Ferma) | `error.code=4` + hint про ФФД 1081 (`0` — наличные) |
| `sum ≠ price × quantity`, `total ≠ Σ` | `error.code=4`, `field: receipt.items[i].sum` / `receipt.total` |
| сумма с 3 знаками после запятой | `error.code=4` (decimal в v4 — до 2 знаков) |
| нет `external_id` / длиннее 128 символов | `error.code=5` |
| неизвестный `uuid` или чужая группа в `report` | `error.code=10` |
| битый JSON в теле | `error.code=4` |

Каждая ошибка — `{code, text, type, error_id}` плюс DX-поля мока `field`,
`hint` (что поправить) и `doc` (раздел документации АТОЛ).

## 8. Сценарии отказов и время

```bash
# отказ печати: документ дойдёт до fail с error.code=57 и callback об отказе
curl -s -X POST "…/sell" -H "Token: $TOKEN" -H 'X-Mock-Scenario: fail' -d '{"external_id":"o-43", …}'
# либо просто external_id с префиксом fail- (hang- — вечный wait без callback)

# сетевой сбой до бизнес-логики и задержки
-H 'X-Mock-Scenario: http-500'      # и http-504
-H 'X-Mock-Latency: 2s'             # или X-Mock-Scenario: latency:2s

# подавить/удвоить callback
-H 'X-Mock-Scenario: webhook-drop'  # и webhook-duplicate

# правила без заголовка
curl -s -X POST localhost:3103/mock/scenarios -d '{"scenario":"fail","target":"sell","times":1}'

# виртуальные часы: напечатать очередь сразу и проверить истечение токена
curl -s -X POST localhost:3103/mock/time -d '{"advance":"+20s"}'
curl -s -X POST localhost:3103/mock/time -d '{"advance":"+25h"}'   # токен истёк
```

Журнал запросов с готовым `curl` (секреты и PII отредактированы) —
`GET /admin/journal`; консоль с документами и очередью callback — `GET /admin`.

## 9. Чеклист готовности к бою

- [ ] токен получаете в `getToken`, храните и **передаёте заголовком** `Token`,
      а не в URL; обновляете до истечения 24 часов
- [ ] повтор `external_id` трактуете как «уже зарегистрировано», а не как
      ошибку, и не создаёте второй чек (сохраняете прежний `uuid`)
- [ ] результат читаете из `report` целиком: `status`, `error` (код/текст/тип/
      идентификатор) и `payload` — не сводите к HTTP-коду
- [ ] callback принимаете идемпотентно и **без расчёта на подпись**; опрос —
      ≤3 rps, пауза ≥1 с после системной ошибки, polling при отсутствии
      callback за 300 с
- [ ] суммы — decimal-рубли с 2 знаками; арифметику `sum`/`total`/`payments`
      сверяете до отправки
- [ ] переход на бой = смена базы на `https://online.atol.ru/possystem/v4/`
      и своих кредов/группы из кабинета; контракт запросов не меняется
- [ ] если нужны маркированные товары или ФФД 1.2 — это **v5**, другой
      протокол; на этом стенде его нет
