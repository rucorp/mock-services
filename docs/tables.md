# Таблицы документации

> Реестр всех markdown-таблиц репозитория. Файл собирается и проверяется скриптом `scripts/check-tables.js` (`npm run check:tables`). Не править вручную: после изменения таблиц выполните `node scripts/check-tables.js --write`.

Актуально на 2026-10-15. Всего таблиц: **73** в **27** файлах.

## Сводка

| Файл | Таблиц | Статус |
|---|---:|---|
| [`AGENTS.md`](/AGENTS.md) | 3 | ✅ целы |
| [`CONTRIBUTING.md`](/CONTRIBUTING.md) | 1 | ✅ целы |
| [`README.md`](/README.md) | 5 | ✅ целы |
| [`SECURITY.md`](/SECURITY.md) | 1 | ✅ целы |
| [`docs/integration/atol.md`](/docs/integration/atol.md) | 1 | ✅ целы |
| [`docs/integration/first-ofd.md`](/docs/integration/first-ofd.md) | 3 | ✅ целы |
| [`docs/integration/kontur-ofd.md`](/docs/integration/kontur-ofd.md) | 1 | ✅ целы |
| [`docs/integration/lovii.md`](/docs/integration/lovii.md) | 1 | ✅ целы |
| [`docs/integration/sber.md`](/docs/integration/sber.md) | 1 | ✅ целы |
| [`docs/integration/taxcom.md`](/docs/integration/taxcom.md) | 2 | ✅ целы |
| [`docs/integration/tbank-eacq.md`](/docs/integration/tbank-eacq.md) | 1 | ✅ целы |
| [`docs/integration/vtb.md`](/docs/integration/vtb.md) | 2 | ✅ целы |
| [`docs/integration/yookassa.md`](/docs/integration/yookassa.md) | 1 | ✅ целы |
| [`docs/overview.md`](/docs/overview.md) | 3 | ✅ целы |
| [`docs/rfc/RFC-001-multi-tenant-sandboxes.md`](/docs/rfc/RFC-001-multi-tenant-sandboxes.md) | 2 | ✅ целы |
| [`packages/core/README.md`](/packages/core/README.md) | 2 | ✅ целы |
| [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 6 | ✅ целы |
| [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 6 | ✅ целы |
| [`services/first-ofd-mock/README.md`](/services/first-ofd-mock/README.md) | 3 | ✅ целы |
| [`services/kassa-mock/README.md`](/services/kassa-mock/README.md) | 5 | ✅ целы |
| [`services/kontur-ofd-mock/README.md`](/services/kontur-ofd-mock/README.md) | 3 | ✅ целы |
| [`services/sber-mock/README.md`](/services/sber-mock/README.md) | 3 | ✅ целы |
| [`services/taxcom-mock/README.md`](/services/taxcom-mock/README.md) | 3 | ✅ целы |
| [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 6 | ✅ целы |
| [`services/vtb-mock/README.md`](/services/vtb-mock/README.md) | 3 | ✅ целы |
| [`services/yookassa-mock/README.md`](/services/yookassa-mock/README.md) | 4 | ✅ целы |
| [`site/vendor/README-LICENSE.md`](/site/vendor/README-LICENSE.md) | 1 | ✅ целы |

## Реестр

| № | Файл | Строка | Раздел | Колонок | Строк данных | Статус |
|---:|---|---:|---|---:|---:|---|
| 1 | [`AGENTS.md`](/AGENTS.md) | 32 | 2. Обязательные прогоны | 2 | 5 | ✅ |
| 2 | [`AGENTS.md`](/AGENTS.md) | 54 | 3. Структура и где что менять | 3 | 9 | ✅ |
| 3 | [`AGENTS.md`](/AGENTS.md) | 142 | 9. Что читать перед работой | 2 | 5 | ✅ |
| 4 | [`CONTRIBUTING.md`](/CONTRIBUTING.md) | 16 | Чем можно помочь | 2 | 5 | ✅ |
| 5 | [`README.md`](/README.md) | 66 | Документация | 2 | 8 | ✅ |
| 6 | [`README.md`](/README.md) | 143 | Стенд «банк + касса» одной командой (без клонирования репозитория) | 5 | 11 | ✅ |
| 7 | [`README.md`](/README.md) | 170 | Контейнерный харденинг и graceful shutdown (MS-04) | 3 | 6 | ✅ |
| 8 | [`README.md`](/README.md) | 227 | Что уже умеет мок | 9 | 8 | ✅ |
| 9 | [`README.md`](/README.md) | 240 | Дорожная карта | 3 | 15 | ✅ |
| 10 | [`SECURITY.md`](/SECURITY.md) | 21 | Что делать, если вы разворачиваете стенд | 2 | 4 | ✅ |
| 11 | [`docs/integration/atol.md`](/docs/integration/atol.md) | 138 | 7. Что мок проверит вместо вас | 2 | 13 | ✅ |
| 12 | [`docs/integration/first-ofd.md`](/docs/integration/first-ofd.md) | 98 | 3. Создать заявку на чек | 2 | 7 | ✅ |
| 13 | [`docs/integration/first-ofd.md`](/docs/integration/first-ofd.md) | 132 | 4. Статус, результат и сверка | 2 | 4 | ✅ |
| 14 | [`docs/integration/first-ofd.md`](/docs/integration/first-ofd.md) | 239 | 8. Негативы и DX | 2 | 10 | ✅ |
| 15 | [`docs/integration/kontur-ofd.md`](/docs/integration/kontur-ofd.md) | 19 | 1. Адреса и запуск | 2 | 4 | ✅ |
| 16 | [`docs/integration/lovii.md`](/docs/integration/lovii.md) | 176 | 3. Матрица переменных окружения по контурам (dev / staging / prod) | 5 | 27 | ✅ |
| 17 | [`docs/integration/sber.md`](/docs/integration/sber.md) | 105 | 4. Сверить статус заказа | 3 | 7 | ✅ |
| 18 | [`docs/integration/taxcom.md`](/docs/integration/taxcom.md) | 21 | 1. Адреса и запуск | 2 | 3 | ✅ |
| 19 | [`docs/integration/taxcom.md`](/docs/integration/taxcom.md) | 173 | 4. NewDocuments — 10 суток, 10 000, курсор по id | 3 | 2 | ✅ |
| 20 | [`docs/integration/tbank-eacq.md`](/docs/integration/tbank-eacq.md) | 52 | 3. Что мок теперь проверяет за вас (важно для отладки) | 2 | 6 | ✅ |
| 21 | [`docs/integration/vtb.md`](/docs/integration/vtb.md) | 62 | 3. Заголовки бизнес-запросов | 2 | 4 | ✅ |
| 22 | [`docs/integration/vtb.md`](/docs/integration/vtb.md) | 132 | 5. Сверить статус: status.value на своём уровне | 3 | 7 | ✅ |
| 23 | [`docs/integration/yookassa.md`](/docs/integration/yookassa.md) | 88 | 4. Что мок теперь проверяет за вас (важно для отладки) | 2 | 10 | ✅ |
| 24 | [`docs/overview.md`](/docs/overview.md) | 25 | Банки — эквайринг | 4 | 5 | ✅ |
| 25 | [`docs/overview.md`](/docs/overview.md) | 35 | Кассы и ОФД | 4 | 5 | ✅ |
| 26 | [`docs/overview.md`](/docs/overview.md) | 49 | Как устроена документация | 3 | 7 | ✅ |
| 27 | [`docs/rfc/RFC-001-multi-tenant-sandboxes.md`](/docs/rfc/RFC-001-multi-tenant-sandboxes.md) | 51 | 3. Ключевая развилка: как клиент идентифицирует песочницу | 4 | 4 | ✅ |
| 28 | [`docs/rfc/RFC-001-multi-tenant-sandboxes.md`](/docs/rfc/RFC-001-multi-tenant-sandboxes.md) | 128 | 7. Безопасность | 2 | 7 | ✅ |
| 29 | [`packages/core/README.md`](/packages/core/README.md) | 118 | Песочницы (RFC-001): источники owner-token | 3 | 5 | ✅ |
| 30 | [`packages/core/README.md`](/packages/core/README.md) | 172 | Байтовые квоты песочниц (PD-02, #74) | 3 | 2 | ✅ |
| 31 | [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 44 | API | 2 | 14 | ✅ |
| 32 | [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 82 | Состояния заказа (orderStatus) | 3 | 7 | ✅ |
| 33 | [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 102 | Ошибки (формат шлюза + DX) | 3 | 6 | ✅ |
| 34 | [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 191 | Переменные окружения | 3 | 25 | ✅ |
| 35 | [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 221 | Отличия от tbank-mock и yookassa-mock — не drop-in | 4 | 7 | ✅ |
| 36 | [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 296 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 37 | [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 62 | API | 2 | 6 | ✅ |
| 38 | [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 131 | Ошибки (формат v4 + DX) | 2 | 6 | ✅ |
| 39 | [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 155 | Сценарии (X-Mock-Scenario и /mock/scenarios) | 2 | 6 | ✅ |
| 40 | [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 179 | Переменные окружения | 3 | 15 | ✅ |
| 41 | [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 199 | Отличия от Ferma (kassa-mock) — не drop-in | 3 | 8 | ✅ |
| 42 | [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 245 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 43 | [`services/first-ofd-mock/README.md`](/services/first-ofd-mock/README.md) | 36 | Поддерживаемый поток OKassa | 2 | 10 | ✅ |
| 44 | [`services/first-ofd-mock/README.md`](/services/first-ofd-mock/README.md) | 149 | Переменные окружения | 3 | 26 | ✅ |
| 45 | [`services/first-ofd-mock/README.md`](/services/first-ofd-mock/README.md) | 188 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 46 | [`services/kassa-mock/README.md`](/services/kassa-mock/README.md) | 16 | Контракт (по документации Ferma) | 2 | 16 | ✅ |
| 47 | [`services/kassa-mock/README.md`](/services/kassa-mock/README.md) | 113 | Конфиг (env) | 3 | 25 | ✅ |
| 48 | [`services/kassa-mock/README.md`](/services/kassa-mock/README.md) | 149 | Песочницы и hosted tenancy (RFC-001, A-21) | 3 | 3 | ✅ |
| 49 | [`services/kassa-mock/README.md`](/services/kassa-mock/README.md) | 158 | Песочницы и hosted tenancy (RFC-001, A-21) | 2 | 4 | ✅ |
| 50 | [`services/kassa-mock/README.md`](/services/kassa-mock/README.md) | 192 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 51 | [`services/kontur-ofd-mock/README.md`](/services/kontur-ofd-mock/README.md) | 36 | Контракт | 2 | 10 | ✅ |
| 52 | [`services/kontur-ofd-mock/README.md`](/services/kontur-ofd-mock/README.md) | 71 | Env | 2 | 23 | ✅ |
| 53 | [`services/kontur-ofd-mock/README.md`](/services/kontur-ofd-mock/README.md) | 122 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 54 | [`services/sber-mock/README.md`](/services/sber-mock/README.md) | 29 | Поддерживаемый Ecom-поток | 2 | 13 | ✅ |
| 55 | [`services/sber-mock/README.md`](/services/sber-mock/README.md) | 110 | Переменные окружения | 3 | 23 | ✅ |
| 56 | [`services/sber-mock/README.md`](/services/sber-mock/README.md) | 145 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 57 | [`services/taxcom-mock/README.md`](/services/taxcom-mock/README.md) | 46 | Контракт | 2 | 7 | ✅ |
| 58 | [`services/taxcom-mock/README.md`](/services/taxcom-mock/README.md) | 88 | Env | 2 | 23 | ✅ |
| 59 | [`services/taxcom-mock/README.md`](/services/taxcom-mock/README.md) | 141 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 60 | [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 58 | API мока | 2 | 14 | ✅ |
| 61 | [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 123 | Песочницы и hosted tenancy (RFC-001, A-21) | 3 | 3 | ✅ |
| 62 | [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 132 | Песочницы и hosted tenancy (RFC-001, A-21) | 2 | 4 | ✅ |
| 63 | [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 150 | Тестовые карты (как у банка, oplata_multisplit.pdf §7) | 2 | 6 | ✅ |
| 64 | [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 161 | Конфиг (env) | 3 | 26 | ✅ |
| 65 | [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 206 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 66 | [`services/vtb-mock/README.md`](/services/vtb-mock/README.md) | 30 | Поддерживаемый SMB-поток | 2 | 13 | ✅ |
| 67 | [`services/vtb-mock/README.md`](/services/vtb-mock/README.md) | 123 | Переменные окружения | 3 | 24 | ✅ |
| 68 | [`services/vtb-mock/README.md`](/services/vtb-mock/README.md) | 159 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 69 | [`services/yookassa-mock/README.md`](/services/yookassa-mock/README.md) | 49 | API | 2 | 12 | ✅ |
| 70 | [`services/yookassa-mock/README.md`](/services/yookassa-mock/README.md) | 161 | Сценарии (X-Mock-Scenario и /mock/scenarios) | 2 | 6 | ✅ |
| 71 | [`services/yookassa-mock/README.md`](/services/yookassa-mock/README.md) | 186 | Переменные окружения | 3 | 11 | ✅ |
| 72 | [`services/yookassa-mock/README.md`](/services/yookassa-mock/README.md) | 226 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 73 | [`site/vendor/README-LICENSE.md`](/site/vendor/README-LICENSE.md) | 3 | Вендоренные файлы сайта документации | 4 | 2 | ✅ |
