# Таблицы документации

> Реестр всех markdown-таблиц репозитория. Файл собирается и проверяется скриптом `scripts/check-tables.js` (`npm run check:tables`). Не править вручную: после изменения таблиц выполните `node scripts/check-tables.js --write`.

Актуально на 2026-10-15. Всего таблиц: **66** в **25** файлах.

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
| [`packages/core/README.md`](/packages/core/README.md) | 2 | ✅ целы |
| [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 5 | ✅ целы |
| [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 5 | ✅ целы |
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
| 1 | [`AGENTS.md`](/AGENTS.md) | 31 | 2. Обязательные прогоны | 2 | 5 | ✅ |
| 2 | [`AGENTS.md`](/AGENTS.md) | 57 | 3. Структура и где что менять | 3 | 9 | ✅ |
| 3 | [`AGENTS.md`](/AGENTS.md) | 149 | 9. Что читать перед работой | 2 | 4 | ✅ |
| 4 | [`CONTRIBUTING.md`](/CONTRIBUTING.md) | 13 | Чем можно помочь | 2 | 5 | ✅ |
| 5 | [`CONTRIBUTING.md`](/CONTRIBUTING.md) | 74 | Гайды интеграции: шаблон | 3 | 9 | ✅ |
| 6 | [`README.md`](/README.md) | 36 | Документация | 2 | 8 | ✅ |
| 7 | [`README.md`](/README.md) | 99 | Рецепты «за 10 минут» | 5 | 10 | ✅ |
| 8 | [`SECURITY.md`](/SECURITY.md) | 20 | Что делать, если вы разворачиваете стенд | 2 | 4 | ✅ |
| 9 | [`docs/hardening.md`](/docs/hardening.md) | 14 | Флаги | 3 | 6 | ✅ |
| 10 | [`docs/integration/atol.md`](/docs/integration/atol.md) | 130 | 7. Что мок проверяет за вас | 2 | 13 | ✅ |
| 11 | [`docs/integration/first-ofd.md`](/docs/integration/first-ofd.md) | 96 | 3. Создать заявку на чек | 2 | 7 | ✅ |
| 12 | [`docs/integration/first-ofd.md`](/docs/integration/first-ofd.md) | 130 | 4. Статус, результат и сверка | 2 | 4 | ✅ |
| 13 | [`docs/integration/first-ofd.md`](/docs/integration/first-ofd.md) | 237 | 8. Что мок проверяет за вас: негативы и DX | 2 | 10 | ✅ |
| 14 | [`docs/integration/kontur-ofd.md`](/docs/integration/kontur-ofd.md) | 18 | 1. Адреса и запуск | 2 | 4 | ✅ |
| 15 | [`docs/integration/sber.md`](/docs/integration/sber.md) | 100 | 4. Сверить статус заказа | 3 | 7 | ✅ |
| 16 | [`docs/integration/taxcom.md`](/docs/integration/taxcom.md) | 19 | 1. Адреса и запуск | 2 | 3 | ✅ |
| 17 | [`docs/integration/taxcom.md`](/docs/integration/taxcom.md) | 170 | 4. NewDocuments — 10 суток, 10 000, курсор по id | 3 | 2 | ✅ |
| 18 | [`docs/integration/tbank-eacq.md`](/docs/integration/tbank-eacq.md) | 52 | 4. Что мок проверяет за вас (важно для отладки) | 2 | 6 | ✅ |
| 19 | [`docs/integration/vtb.md`](/docs/integration/vtb.md) | 59 | 3. Заголовки бизнес-запросов | 2 | 4 | ✅ |
| 20 | [`docs/integration/vtb.md`](/docs/integration/vtb.md) | 129 | 5. Сверить статус: status.value на своём уровне | 3 | 7 | ✅ |
| 21 | [`docs/integration/yookassa.md`](/docs/integration/yookassa.md) | 88 | 4. Что мок проверяет за вас (важно для отладки) | 2 | 10 | ✅ |
| 22 | [`docs/overview.md`](/docs/overview.md) | 45 | Банки — эквайринг | 4 | 5 | ✅ |
| 23 | [`docs/overview.md`](/docs/overview.md) | 55 | Кассы и ОФД | 4 | 5 | ✅ |
| 24 | [`docs/overview.md`](/docs/overview.md) | 69 | Как устроена документация | 3 | 7 | ✅ |
| 25 | [`packages/core/README.md`](/packages/core/README.md) | 116 | Песочницы (RFC-001): источники owner-token | 3 | 5 | ✅ |
| 26 | [`packages/core/README.md`](/packages/core/README.md) | 170 | Байтовые квоты песочниц | 3 | 2 | ✅ |
| 27 | [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 43 | API | 2 | 14 | ✅ |
| 28 | [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 80 | Состояния заказа (orderStatus) | 3 | 7 | ✅ |
| 29 | [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 100 | Ошибки (формат шлюза + DX) | 3 | 6 | ✅ |
| 30 | [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 189 | Переменные окружения | 3 | 25 | ✅ |
| 31 | [`services/alfa-mock/README.md`](/services/alfa-mock/README.md) | 270 | Байтовые квоты состояния | 3 | 2 | ✅ |
| 32 | [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 56 | API | 2 | 6 | ✅ |
| 33 | [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 125 | Ошибки (формат v4 + DX) | 2 | 6 | ✅ |
| 34 | [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 149 | Сценарии (X-Mock-Scenario и /mock/scenarios) | 2 | 6 | ✅ |
| 35 | [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 173 | Переменные окружения | 3 | 17 | ✅ |
| 36 | [`services/atol-mock/README.md`](/services/atol-mock/README.md) | 233 | Байтовые квоты состояния | 3 | 2 | ✅ |
| 37 | [`services/first-ofd-mock/README.md`](/services/first-ofd-mock/README.md) | 34 | Поддерживаемый поток OKassa | 2 | 10 | ✅ |
| 38 | [`services/first-ofd-mock/README.md`](/services/first-ofd-mock/README.md) | 146 | Переменные окружения | 3 | 26 | ✅ |
| 39 | [`services/first-ofd-mock/README.md`](/services/first-ofd-mock/README.md) | 185 | Байтовые квоты состояния | 3 | 2 | ✅ |
| 40 | [`services/kassa-mock/README.md`](/services/kassa-mock/README.md) | 15 | Контракт (по документации Ferma) | 2 | 16 | ✅ |
| 41 | [`services/kassa-mock/README.md`](/services/kassa-mock/README.md) | 113 | Конфиг (env) | 3 | 30 | ✅ |
| 42 | [`services/kassa-mock/README.md`](/services/kassa-mock/README.md) | 154 | Песочницы и hosted tenancy (RFC-001) | 3 | 3 | ✅ |
| 43 | [`services/kassa-mock/README.md`](/services/kassa-mock/README.md) | 163 | Песочницы и hosted tenancy (RFC-001) | 2 | 4 | ✅ |
| 44 | [`services/kassa-mock/README.md`](/services/kassa-mock/README.md) | 198 | Байтовые квоты состояния | 3 | 2 | ✅ |
| 45 | [`services/kontur-ofd-mock/README.md`](/services/kontur-ofd-mock/README.md) | 33 | Контракт | 2 | 10 | ✅ |
| 46 | [`services/kontur-ofd-mock/README.md`](/services/kontur-ofd-mock/README.md) | 67 | Env | 2 | 23 | ✅ |
| 47 | [`services/kontur-ofd-mock/README.md`](/services/kontur-ofd-mock/README.md) | 118 | Байтовые квоты состояния | 3 | 2 | ✅ |
| 48 | [`services/sber-mock/README.md`](/services/sber-mock/README.md) | 28 | Поддерживаемый Ecom-поток | 2 | 13 | ✅ |
| 49 | [`services/sber-mock/README.md`](/services/sber-mock/README.md) | 109 | Переменные окружения | 3 | 23 | ✅ |
| 50 | [`services/sber-mock/README.md`](/services/sber-mock/README.md) | 144 | Байтовые квоты состояния | 3 | 2 | ✅ |
| 51 | [`services/taxcom-mock/README.md`](/services/taxcom-mock/README.md) | 41 | Контракт | 2 | 7 | ✅ |
| 52 | [`services/taxcom-mock/README.md`](/services/taxcom-mock/README.md) | 83 | Env | 2 | 23 | ✅ |
| 53 | [`services/taxcom-mock/README.md`](/services/taxcom-mock/README.md) | 136 | Байтовые квоты состояния | 3 | 2 | ✅ |
| 54 | [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 55 | API мока | 2 | 14 | ✅ |
| 55 | [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 120 | Песочницы и hosted tenancy (RFC-001) | 3 | 3 | ✅ |
| 56 | [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 129 | Песочницы и hosted tenancy (RFC-001) | 2 | 4 | ✅ |
| 57 | [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 147 | Тестовые карты (как у банка, oplata_multisplit.pdf §7) | 2 | 6 | ✅ |
| 58 | [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 158 | Конфиг (env) | 3 | 27 | ✅ |
| 59 | [`services/tbank-mock/README.md`](/services/tbank-mock/README.md) | 204 | Байтовые квоты состояния | 3 | 2 | ✅ |
| 60 | [`services/vtb-mock/README.md`](/services/vtb-mock/README.md) | 29 | Поддерживаемый SMB-поток | 2 | 13 | ✅ |
| 61 | [`services/vtb-mock/README.md`](/services/vtb-mock/README.md) | 122 | Переменные окружения | 3 | 24 | ✅ |
| 62 | [`services/vtb-mock/README.md`](/services/vtb-mock/README.md) | 158 | Байтовые квоты состояния | 3 | 2 | ✅ |
| 63 | [`services/yookassa-mock/README.md`](/services/yookassa-mock/README.md) | 47 | API | 2 | 12 | ✅ |
| 64 | [`services/yookassa-mock/README.md`](/services/yookassa-mock/README.md) | 159 | Сценарии (X-Mock-Scenario и /mock/scenarios) | 2 | 6 | ✅ |
| 65 | [`services/yookassa-mock/README.md`](/services/yookassa-mock/README.md) | 184 | Переменные окружения | 3 | 12 | ✅ |
| 66 | [`services/yookassa-mock/README.md`](/services/yookassa-mock/README.md) | 222 | Байтовые квоты состояния | 3 | 2 | ✅ |
