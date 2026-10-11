© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Контур.ОФД — организации, кассы и фискальные документы

Официальные разделы: [доступные методы](https://docs-ofd-api.kontur.ru/Methods.html), [organizations](https://docs-ofd-api.kontur.ru/http/organizations.html), [cashboxes](https://docs-ofd-api.kontur.ru/http/cashboxes.html), [documents/by-period](https://docs-ofd-api.kontur.ru/http/documents-by-period.html), [documents за дату](https://docs-ofd-api.kontur.ru/http/documents.html), [структура receipt/BSO](https://docs-ofd-api.kontur.ru/Structures/ReceiptBSO.html), [коды ошибок](https://docs-ofd-api.kontur.ru/Responses.html).

## Обычная последовательность

Все запросы к data endpoint содержат `Authorization: auth.sid <Sid>` и `X-Kontur-Ofd-ApiKey`. JSON; метод чтения — GET.

1. `GET /v2/organizations` — массив доступных организаций; сохранять `id`, `inn`, `kpp`, названия.
2. `GET /v2/organizations/{organizationId}/cashboxes` — кассы; сохранять `regNumber` (РН ККТ), текущий/исторические адреса, модель, ФН и границы периода доступа.
3. `GET /v2/organizations/{organizationId}/cashboxes/{kktRegId}/documents?date=YYYY-MM-DD&types=...` — все документы кассы за дату; `types` можно задать несколькими значениями через запятую.
4. `GET /v2/organizations/{organizationId}/cashboxes/{kktRegId}/documents/by-period?dateFrom=YYYY-MM-DDTHH:mm:ss&dateTo=YYYY-MM-DDTHH:mm:ss&types=...&offset=...&limit=...` — документы за период; максимум 1000 за страницу (`limit` по умолчанию/максимум 1000). В ответе `documents[]` и `paging.nextOffset`; продолжать страницами до пустой страницы/исчерпания cursor.
5. `GET /v2/organizations/{organizationId}/cashboxes/{kktRegId}/documents/{documentId}` — отдельный JSON-документ по `id`, полученному из списка.

Фильтры `types`: `fiscalReport`, `fiscalReportCorrection`, `currentStateReport`, `openShift`, `closeShift`, `receipt`, `bso`, `receiptCorrection`, `bsoCorrection`, `closeArchive`. Для чеков в JSON есть код документа, дата/смена, `operationType`, `items`, суммы наличных/безналичных, `fiscalDocumentNumber`, `fiscalSign`, `id`; суммы указываются в копейках. Возвратные документы приходят как уже сформированные фискальные документы, API не запускает сам возврат.

### Несовпадение имени параметра cursor в справке

В шаблоне URL и примерах query поле названо `offset`; в пояснительном списке параметров встречается `currentOffset`, при этом ответ называет курсор `nextOffset`. Использовать имя, подтверждённое текущей тестовой схемой/ответом; не переименовывать параметр молча.

## Ошибки и статусная модель

Положительный запрос — HTTP 200 с данными; пустой период возвращает пустой список. Это **не** очередь печати и не набор статусов `wait/done/fail`. Документация перечисляет HTTP 400/401/403/404/500 с `errorCodeId`; например, 401002 — отсутствует/истёк auth.sid, 401003 — отсутствует/неизвестен API key, 403 — нет прав на организацию/кассу, 404 — организация или документ не найдены. Поле `errorCode` помечено устаревающим; ориентироваться на `errorCodeId`.

## Callback и создание/возврат чека

В публичной документации API Контур.ОФД не обнаружено API для постановки чека/чека возврата на фискализацию, callback-уведомлений о печати или polling статуса команды печати. Доступна выдача уже принятых ОФД документов и статистики. Для будущего адаптера на этой основе моделировать можно только read/reconciliation-контракт, если владелец отдельно не получит закрытый write API.
