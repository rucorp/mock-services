© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# АТОЛ Онлайн — прямой API v4 и v5

Срез на 2026-10-11. Не путать direct API АТОЛ Онлайн с протоколом облачных касс Ferma, даже если у них похожие названия полей.

## Первичные источники

- [Официальный выбор протокола](https://help.atol.online/article/11244): v5 (ФФД 1.2) для маркированных товаров; v4 (ФФД 1.05) — в остальных случаях.
- [API v4, полный PDF](https://atol.online/files/API_atol_online_v4.pdf), версия документа 5.15.
- [API v5 (ФФД 1.2)](https://atol.online/api_v5), протокол версии 3.16 от 2026-08-21.
- [Обновление VAT 22/22-122](https://help.atol.online/article/26152).

## Версии и адреса

| Версия | Формат | Production base | Test base |
|---|---|---|---|
| v4 | ФФД 1.05 | `https://online.atol.ru/possystem/v4/` | `https://testonline.atol.ru/possystem/v4/` |
| v5 | ФФД 1.2 | `https://online.atol.ru/possystem/v5/` | `https://testonline.atol.ru/possystem/v5/` |

## Авторизация

`POST /getToken` с `Content-Type: application/json; charset=utf-8`, JSON `{ "login": "...", "pass": "..." }` (опционально `source`). Ответ при успехе содержит `token`; он действует 24 часа. Передавать его далее в заголовке `Token: <token>`. Не отправлять пароль в URL, хотя PDF описывает GET-вариант `getToken?login=...&pass=...`.

## Регистрация документа

`POST /<group_code>/<operation>` с `Token` и JSON. Базовые поля:

- `timestamp` — время внешней системы `dd.mm.yyyy HH:MM:SS`;
- `external_id` — строковый ID, уникальный в группе; до 128 символов. Повтор с тем же ID возвращает UUID уже созданной операции вместо второго чека;
- `receipt` — `client`, `company`, `items[]`, `payments[]`, `total` и дополнительные реквизиты ФФД;
- необязательный `service.callback_url` — результат после обработки документа.

По v4 `client` требует хотя бы email или телефон; в `company` есть `email`, `inn`, `payment_address`, а `sno` обязателен, если у юрлица больше одной системы налогообложения. Позиции содержат `name`, `price`, `quantity`, `sum` в рублях с копейками (decimal), `payment_method`, `payment_object`, `vat`; `payments[].type` и `sum`; `total` — итог. API валидирует реквизиты чека, не только JSON.

### Операции

v4 документирует: `sell` (приход), `sell_refund` (возврат прихода), `sell_correction`, `buy` (расход), `buy_refund` (возврат расхода), `buy_correction`. Для v5 применять актуальную таблицу операций/схем ФФД 1.2 из PDF версии 3.16; не считать её тождественной отдельному встроенному API АТОЛ внутри тестового Swagger Первого ОФД.

### НДС и ФФД 1.2

В `vat`/`vats` к ставкам добавлены `vat22` и `vat122` (22% и расчётная 22/122). Версия v5 также содержит реквизиты маркировки, `permissive_mode`, `use_tspiot`, `tspiot_user_id` и проверку КМ. Это существенно отличается от простого набора ставок, реализованного текущим `kassa-mock`.

## Получение результата

`GET /<group_code>/report/<uuid>` с тем же Token. Статусы: `wait` → `done` или `fail`; успешный `done` содержит `payload` с ФД/ФП, номером ФН/ККТ и `ofd_receipt_url`. Ошибка передаётся в `error` (код, текст, тип и идентификатор); сохранять полный ответ, не сводить все ошибки к HTTP-коду.

## Отличие от имеющегося `kassa-mock`

`services/kassa-mock` — контракт Ferma: `/possystem/v1/getToken`, `/possystem/v1/{group}/sell|sell_refund`, `report/{uuid}`, токен в query-параметре и callback из `receipt.service`. ATOL direct API требует явной версии v4/v5, другой base, заголовок `Token`, полный список операций и свою политику групповой идемпотентности. Совпадение `wait/done/fail` и части полей не делает его drop-in совместимым.
