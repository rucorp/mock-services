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

Через `MOCK_PROCESS_MS` (по умолчанию 15 с; в compose — серверный дефолт)
документ «печатается»: статус → `done`, генерируются ФД/ФП/фискальный
признак, результат POST'ом уходит на `callback_url` (ретраи как у Ferma),
покупателю — человекочитаемый чек по ссылке `ofd_receipt_url`
(`/receipts/{uuid}`). Статус можно и опрашивать: `GET /possystem/v1/mygroup/report/{uuid}`.

## 3. Сценарии отказов

- `external_id` с префиксом **`fail-`** — отказ ККТ (статус fail + error);
- префикс **`hang-`** — вечный `wait` без callback (зависший документ);
- дубликат `external_id` — ошибка 12 (как у Ferma, защита от двойного чека);
- кнопки в `/admin`: «касса недоступна (5 мин)», «вернуть в строй»,
  «сбросить реестр external_id».

## 4. Ошибки (DX)

Каждая ошибка Ferma-формата несёт `field` (какое поле), `hint` (рекомендация)
и `doc` (ссылка на документацию). Известные коды: 4 (формат), 5 (нет
external_id), 10 (не найден), 11 (авторизация), 12 (дубль), 14 (креды),
57 (отказ по сценарию).

## 5. Чеклист готовности к бою

- [ ] callback обрабатывается идемпотентно (доставка повторяется до 2xx)
- [ ] статусы `wait → done|fail` обрабатываются, `hang` детектируется таймаутом
- [ ] дубли external_id не приводят к попытке второго чека
- [ ] агентская схема чека (агент/поставщик) заполнена по вашей модели —
      пример в моке: «ООО „Аксиома" — торговый агент» + supplier_info
- [ ] переключение на бой = смена `FERMA_API_URL` и кредов, код не меняется
