# Таблицы документации

> Реестр всех markdown-таблиц репозитория. Файл собирается и проверяется скриптом `scripts/check-tables.js` (`npm run check:tables`). Не править вручную: после изменения таблиц выполните `node scripts/check-tables.js --write`.

Актуально на 2026-10-15. Всего таблиц: **71** в **27** файлах.

## Сводка

| Файл | Таблиц | Статус |
|---|---:|---|
| [`AGENTS.md`](/AGENTS.md) | 3 | ✅ целы |
| [`CONTRIBUTING.md`](/CONTRIBUTING.md) | 2 | ✅ целы |
| [`README.md`](/README.md) | 2 | ✅ целы |
| [`SECURITY.md`](/SECURITY.md) | 1 | ✅ целы |
| [`docs/hardening.md`](/docs/hardening.md) | 1 | ✅ целы |
| [`docs/integration/atol.md`](/docs/integration/atol.md) | 1 | ✅ целы |
| [`docs/integration/first-ofd.md`](/docs/integration/first-ofd.md) | 3 | ✅ целы |
| [`docs/integration/kontur-ofd.md`](/docs/integration/kontur-ofd.md) | 1 | ✅ целы |
| [`docs/integration/sber.md`](/docs/integration/sber.md) | 1 | ✅ целы |
| [`docs/integration/taxcom.md`](/docs/integration/taxcom.md) | 2 | ✅ целы |
| [`docs/integration/tbank-eacq.md`](/docs/integration/tbank-eacq.md) | 1 | ✅ целы |
| [`docs/integration/vtb.md`](/docs/integration/vtb.md) | 2 | ✅ целы |
| [`docs/integration/yookassa.md`](/docs/integration/yookassa.md) | 1 | ✅ целы |
| [`docs/overview.md`](/docs/overview.md) | 3 | ✅ целы |
| [`docs/rfc/RFC-001-multi-tenant-sandboxes.md`](/docs/rfc/RFC-001-multi-tenant-sandboxes.md) | 2 | ✅ целы |
| [`docs/roadmap.md`](/docs/roadmap.md) | 1 | ✅ целы |
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

## Реестр

| № | Файл | Строка | Раздел | Колонок | Строк данных | Статус |
|---:|---|---:|---|---:|---:|---|
| 1 | [`AGENTS.md`](/AGENTS.md) | 32 | 2. Обязательные прогоны | 2 | 5 | ✅ |
| 2 | [`AGENTS.md`](/AGENTS.md) | 56 | 3. Структура и где что менять | 3 | 9 | ✅ |
| 3 | [`AGENTS.md`](/AGENTS.md) | 149 | 9. Что читать перед работой | 2 | 5 | ✅ |
| 4 | [`CONTRIBUTING.md`](/CONTRIBUTING.md) | 16 | Чем можно помочь | 2 | 5 | ✅ |
| 5 | [`CONTRIBUTING.md`](/CONTRIBUTING.md) | 80 | Гайды интеграции: шаблон | 3 | 9 | ✅ |
| 6 | [`README.md`](/README.md) | 34 | Документация | 2 | 10 | ✅ |
| 7 | [`README.md`](/README.md) | 100 | Рецепты «за 10 минут» | 5 | 10 | ✅ |
| 8 | [`SECURITY.md`](/SECURITY.md) | 20 | Что делать, если вы разворачиваете стенд | 2 | 4 | ✅ |
| 9 | [`docs/hardening.md`](/docs/hardening.md) | 14 | Флаги | 3 | 6 | ✅ |
| 10 | [`docs/integration/atol.md`](/docs/integration/atol.md) | 138 | 7. Что мок проверяет за вас | 2 | 13 | ✅ |
| 11 | [`docs/integration/first-ofd.md`](/docs/integration/first-ofd.md) | 98 | 3. Создать заявку на чек | 2 | 7 | ✅ |
| 12 | [`docs/integration/first-ofd.md`](/docs/integration/first-ofd.md) | 132 | 4. Статус, результат и сверка | 2 | 4 | ✅ |
| 13 | [`docs/integration/first-ofd.md`](/docs/integration/first-ofd.md) | 239 | 8. Что мок проверяет за вас: негативы и DX | 2 | 10 | ✅ |
| 14 | [`docs/integration/kontur-ofd.md`](/docs/integration/kontur-ofd.md) | 18 | 1. Адреса и запуск | 2 | 4 | ✅ |
| 15 | [`docs/integration/sber.md`](/docs/integration/sber.md) | 105 | 4. Сверить статус заказа | 3 | 7 | ✅ |
| 16 | [`docs/integration/taxcom.md`](/docs/integration/taxcom.md) | 20 | 1. Адреса и запуск | 2 | 3 | ✅ |
| 17 | [`docs/integration/taxcom.md`](/docs/integration/taxcom.md) | 172 | 4. NewDocuments — 10 суток, 10 000, курсор по id | 3 | 2 | ✅ |
| 18 | [`docs/integration/tbank-eacq.md`](/docs/integration/tbank-eacq.md) | 52 | 4. Что мок проверяет за вас (важно для отладки) | 2 | 6 | ✅ |
| 19 | [`docs/integration/vtb.md`](/docs/integration/vtb.md) | 62 | 3. Заголовки бизнес-запросов | 2 | 4 | ✅ |
| 20 | [`docs/integration/vtb.md`](/docs/integration/vtb.md) | 132 | 5. Сверить статус: status.value на своём уровне | 3 | 7 | ✅ |
| 21 | [`docs/integration/yookassa.md`](/docs/integration/yookassa.md) | 88 | 4. Что мок проверяет за вас (важно для отладки) | 2 | 10 | ✅ |
| 22 | [`docs/overview.md`](/docs/overview.md) | 45 | Банки — эквайринг | 4 | 5 | ✅ |
| 23 | [`docs/overview.md`](/docs/overview.md) | 55 | Кассы и ОФД | 4 | 5 | ✅ |
| 24 | [`docs/overview.md`](/docs/overview.md) | 69 | Как устроена документация | 3 | 7 | ✅ |
| 25 | [`docs/rfc/RFC-001-multi-tenant-sandboxes.md`](/docs/rfc/RFC-001-multi-tenant-sandboxes.md) | 51 | 3. Ключевая развилка: как клиент идентифицирует песочницу | 4 | 4 | ✅ |
| 26 | [`docs/rfc/RFC-001-multi-tenant-sandboxes.md`](/docs/rfc/RFC-001-multi-tenant-sandboxes.md) | 128 | 7. Безопасность | 2 | 7 | ✅ |
| 27 | [`docs/roadmap.md`](/docs/roadmap.md) | 10 | Дорожная карта | 3 | 15 | ✅ |
| 28 | [`packages/core/README.md`](/packages/core/README.md) | 118 | Песочницы (RFC-001): источники owner-token | 3 | 5 | ✅ |
| 29 | [`packages/core/README.md`](/packages/core/README.md) | 172 | Байтовые квоты песочниц (PD-02, #74) | 3 | 2 | ✅ |
| 30 | [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 44 | API | 2 | 14 | ✅ |
| 31 | [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 82 | Состояния заказа (orderStatus) | 3 | 7 | ✅ |
| 32 | [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 102 | Ошибки (формат шлюза + DX) | 3 | 6 | ✅ |
| 33 | [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 191 | Переменные окружения | 3 | 25 | ✅ |
| 34 | [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 221 | Отличия от tbank-mock и yookassa-mock — не drop-in | 4 | 7 | ✅ |
| 35 | [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 296 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 36 | [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 62 | API | 2 | 6 | ✅ |
| 37 | [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 131 | Ошибки (формат v4 + DX) | 2 | 6 | ✅ |
| 38 | [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 155 | Сценарии (X-Mock-Scenario и /mock/scenarios) | 2 | 6 | ✅ |
| 39 | [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 179 | Переменные окружения | 3 | 17 | ✅ |
| 40 | [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 201 | Отличия от Ferma (kassa-mock) — не drop-in | 3 | 8 | ✅ |
| 41 | [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 247 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 42 | [`services/first-ofd-mock/README.md`](/services/first-ofd-mock/README.md) | 36 | Поддерживаемый поток OKassa | 2 | 10 | ✅ |
| 43 | [`services/first-ofd-mock/README.md`](/services/first-ofd-mock/README.md) | 149 | Переменные окружения | 3 | 26 | ✅ |
| 44 | [`services/first-ofd-mock/README.md`](/services/first-ofd-mock/README.md) | 188 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 45 | [`services/kassa-mock/README.md`](/services/kassa-mock/README.md) | 16 | Контракт (по документации Ferma) | 2 | 16 | ✅ |
| 46 | [`services/kassa-mock/README.md`](/services/kassa-mock/README.md) | 114 | Конфиг (env) | 3 | 30 | ✅ |
| 47 | [`services/kassa-mock/README.md`](/services/kassa-mock/README.md) | 155 | Песочницы и hosted tenancy (RFC-001, A-21) | 3 | 3 | ✅ |
| 48 | [`services/kassa-mock/README.md`](/services/kassa-mock/README.md) | 164 | Песочницы и hosted tenancy (RFC-001, A-21) | 2 | 4 | ✅ |
| 49 | [`services/kassa-mock/README.md`](/services/kassa-mock/README.md) | 198 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 50 | [`services/kontur-ofd-mock/README.md`](/services/kontur-ofd-mock/README.md) | 35 | Контракт | 2 | 10 | ✅ |
| 51 | [`services/kontur-ofd-mock/README.md`](/services/kontur-ofd-mock/README.md) | 70 | Env | 2 | 23 | ✅ |
| 52 | [`services/kontur-ofd-mock/README.md`](/services/kontur-ofd-mock/README.md) | 121 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 53 | [`services/sber-mock/README.md`](/services/sber-mock/README.md) | 29 | Поддерживаемый Ecom-поток | 2 | 13 | ✅ |
| 54 | [`services/sber-mock/README.md`](/services/sber-mock/README.md) | 110 | Переменные окружения | 3 | 23 | ✅ |
| 55 | [`services/sber-mock/README.md`](/services/sber-mock/README.md) | 145 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 56 | [`services/taxcom-mock/README.md`](/services/taxcom-mock/README.md) | 45 | Контракт | 2 | 7 | ✅ |
| 57 | [`services/taxcom-mock/README.md`](/services/taxcom-mock/README.md) | 87 | Env | 2 | 23 | ✅ |
| 58 | [`services/taxcom-mock/README.md`](/services/taxcom-mock/README.md) | 140 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 59 | [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 56 | API мока | 2 | 14 | ✅ |
| 60 | [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 121 | Песочницы и hosted tenancy (RFC-001, A-21) | 3 | 3 | ✅ |
| 61 | [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 130 | Песочницы и hosted tenancy (RFC-001, A-21) | 2 | 4 | ✅ |
| 62 | [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 148 | Тестовые карты (как у банка, oplata_multisplit.pdf §7) | 2 | 6 | ✅ |
| 63 | [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 159 | Конфиг (env) | 3 | 27 | ✅ |
| 64 | [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 205 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 65 | [`services/vtb-mock/README.md`](/services/vtb-mock/README.md) | 30 | Поддерживаемый SMB-поток | 2 | 13 | ✅ |
| 66 | [`services/vtb-mock/README.md`](/services/vtb-mock/README.md) | 123 | Переменные окружения | 3 | 24 | ✅ |
| 67 | [`services/vtb-mock/README.md`](/services/vtb-mock/README.md) | 159 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
| 68 | [`services/yookassa-mock/README.md`](/services/yookassa-mock/README.md) | 49 | API | 2 | 12 | ✅ |
| 69 | [`services/yookassa-mock/README.md`](/services/yookassa-mock/README.md) | 161 | Сценарии (X-Mock-Scenario и /mock/scenarios) | 2 | 6 | ✅ |
| 70 | [`services/yookassa-mock/README.md`](/services/yookassa-mock/README.md) | 186 | Переменные окружения | 3 | 12 | ✅ |
| 71 | [`services/yookassa-mock/README.md`](/services/yookassa-mock/README.md) | 227 | Байтовые квоты состояния (PD-02) | 3 | 2 | ✅ |
