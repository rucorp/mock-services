# Интеграция: облачная касса OFD Ferma через mock (10 минут)

Мок воспроизводит контракт Ferma (ofd.ru): getToken → sell/sell_refund →
report → callback, «печать» чека с ФД/ФП и доставкой покупателю.

## 1. Поднять стенд

```bash
docker compose up kassa-mock     # http://localhost:3101
# или: npm run start:kassa
```

## 2. Базовый флоу

```bash
# Токен (TTL 12 ч)
curl -s http://localhost:3101/possystem/v1/getToken -H 'Content-Type: application/json' \
  -d '{"login":"loviitest","pass":"mockpass123"}'

# Чек «Полный расчёт» (суммы — в копейках)
curl -s "http://localhost:3101/possystem/v1/mygroup/sell?token=<TOKEN>" -H 'Content-Type: application/json' -d '{
  "external_id": "order-1-full",
  "receipt": {
    "client": {"email": "buyer@test.ru"},
    "company": {"sno": "ОСН", "payment_address": "https://myapp.test"},
    "items": [{
      "name": "Кофе", "price": 100000, "quantity": 1, "amount": 100000,
      "vat": {"type": "none"}, "payment_method": "full_payment",
      "payment_object": "commodity",
      "supplier_info": {"name": "ООО «Ромашка»", "inn": "7800000001"}
    }],
    "payments": [{"type": 1, "sum": 100000}],
    "total": 100000,
    "service": {"callback_url": "http://host.docker.internal:8080/fiscal/callback"}
  }
}'
# → { uuid, status: "wait" }
```

Через `MOCK_PROCESS_MS` (дефолт адаптера — 15 с; в `docker-compose.include.yml` и
staging-стенде — 4 с, чтобы публичный контур отвечал быстрее)
документ «печатается»: статус → `done`, генерируются ФД/ФП/фискальный
признак, результат POST'ом уходит на `callback_url` (ретраи как у Ferma),
покупателю — человекочитаемый чек по ссылке `ofd_receipt_url`
(`/receipts/{uuid}`). Статус можно и опрашивать: `GET /possystem/v1/mygroup/report/{uuid}`.

## 3. Что мок проверяет за вас (валидация чека до боевой кассы)

Перед «печатью» мок проверяет инварианты, на которых в бою падает ФНС/касса:

- `sum = price × quantity` в каждой позиции, `total` = сумме позиций,
  Σ `payments[].sum` = `total`;
- `vat.type` из справочника (`none, vat0, vat5, vat7, vat10, vat20, vat22`);
- `payment_method` из справочника 54-ФЗ; `payments[].type` = 1..5;
- группа кассы, если задан `MOCK_GROUPS` (опечатка в группе отклоняется).

Ответ — в формате Ferma с DX-расширением:

```json
{"error":{"code":4,"text":"Чек не прошёл проверку кассы: receipt.total",
          "field":"receipt.total",
          "hint":"Итог 50000 ≠ сумме позиций 100. Проверьте арифметику до отправки."}}
```

Отключается `MOCK_VALIDATE_RECEIPTS=false` (например, если нужно протестировать
поведение интеграции на «странном» чеке).

## 4. Токен, время печати и наблюдение

- Токен живёт 12 часов (`MOCK_TOKEN_TTL_MS`); истёкший → `error.code=11`.
- `MOCK_PROCESS_MS=0` — печатать мгновенно (удобно для CI); по умолчанию 15 с.
- В фискальном снимке `receipt_datetime` — реальное время печати,
  `fiscal_receipt_number` уникален в смене и продолжается после рестарта.
- `GET /admin/journal` — журнал запросов (что мок получил и что ответил);
  кнопка «callback» в `/admin` — повторная доставка результата документа
  (проверка идемпотентности на вашей стороне).
- Рестарт с `MOCK_STATE_FILE`: напечатанные документы сохраняются, а
  **незавершённые callback'и продолжают ретраиться** (раньше терялись).

## 5. Сценарии отказов

Два равноправных способа:

- **заголовок `X-Mock-Scenario: fail` или `hang`** на самом запросе sell —
  универсальный способ для CI и внешних интеграторов (external_id любой);

- `external_id` с префиксом **`fail-`** — отказ ККТ (статус fail + error),
  соглашение совместимости с профилем Lovii;
- префикс **`hang-`** — вечный `wait` без callback (зависший документ);
- дубликат `external_id` — ошибка 12 (как у Ferma, защита от двойного чека);
- кнопки в `/admin`: «касса недоступна (5 мин)», «вернуть в строй»,
  «сбросить реестр external_id».

## 6. Ошибки (DX)

Каждая ошибка Ferma-формата несёт `field` (какое поле), `hint` (рекомендация)
и `doc` (ссылка на документацию). Известные коды: 4 (формат), 5 (нет
external_id), 10 (не найден), 11 (авторизация), 12 (дубль), 14 (креды),
57 (отказ по сценарию).

## 7. Чеклист готовности к бою

- [ ] callback обрабатывается идемпотентно (доставка повторяется до 2xx)
- [ ] статусы `wait → done|fail` обрабатываются, `hang` детектируется таймаутом
- [ ] дубли external_id не приводят к попытке второго чека
- [ ] агентская схема чека (агент/поставщик) заполнена по вашей модели —
      пример в моке: «ООО „Аксиома" — торговый агент» + supplier_info
- [ ] чек проходит проверку инвариантов (суммы позиций/оплат/итога, справочники)
- [ ] callback переживает рестарт стенда (`MOCK_STATE_FILE`) и повтор (кнопка «callback»)
- [ ] переключение на бой = смена `FERMA_API_URL` и кредов, код не меняется

## 8. Ссылки

- Контракт сервиса, env и `/mock/*`: [`services/kassa-mock/README.md`](../../services/kassa-mock/README.md)
- OpenAPI 3.1: [`docs/openapi/kassa-mock.openapi.json`](../openapi/kassa-mock.openapi.json)
- Манифест протокола для `npm run check:drift`: [`protocols/ferma-ofd.json`](../../protocols/ferma-ofd.json)
- Общая инфраструктура адаптеров (часы, песочницы, вебхуки, SSRF): [`packages/core/README.md`](../../packages/core/README.md)
