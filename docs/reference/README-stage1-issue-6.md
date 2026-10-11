© 2026 ООО «Аксиома» ИНН:7842223709 · https://github.com/rucorp/mock-services · все права защищены
Документ проекта mock-services (оригинал: rucorp/mock-services).

# Issue #6 — Stage 1: указатель на конспекты провайдеров

Результат исследования публичной официальной документации, срез на 2026-10-11. Конспекты находятся по темам в каталогах `docs/reference/<provider>/`. Источники первичные, если не помечены иначе; неоднозначные/закрытые детали отмечены явно, а не заполнены предположениями.

## Банки и эквайринг

- [Сбер — REST API](sber/01-payment-api.md), [callback и тестовые карты](sber/02-callbacks-and-test.md)
- [Альфа — REST API](alfa/01-payment-api.md), [callback и подпись](alfa/02-notifications-and-signature.md), [тестовый контур/карты](alfa/03-test-contour.md)
- [ВТБ — SMB e-commerce API](vtb/01-smb-ecommerce-api.md), [callback и тестирование](vtb/02-callbacks-and-testing.md)
- [ЮKassa — платежи и возвраты](yookassa/01-payments-and-refunds.md), [webhooks](yookassa/02-webhooks.md), [тестовые карты](yookassa/03-testing.md)

## Кассы и ОФД

- [АТОЛ Онлайн — API v4/v5](atol-online/01-api-v4-v5.md), [callback и тестовый контур](atol-online/02-testing-and-callbacks.md)
- [Первый ОФД / OKassa — API](first-ofd/01-okassa-api.md), [тестовый Swagger и расхождения](first-ofd/02-test-and-open-issues.md)
- [Такском API — авторизация и discovery](taxcom/01-api-auth-and-discovery.md), [документы, polling и границы](taxcom/02-documents-and-test-limits.md)
- [Контур.ОФД — auth/access](kontur-ofd/01-auth-and-access.md), [получение документов](kontur-ofd/02-document-retrieval.md)

## Покрытие и ограничения

- Т-Банк и OFD Ferma уже описаны в существующих `docs/reference/tbank/` и `docs/integration/ferma-ofd.md`; повторное исследование этих контрактов в рамках данного набора не выполнялось.
- Для агрегатора выбран ЮKassa (вместо Robokassa) как провайдер с открытой официальной API-документацией.
- Такском API и Контур.ОФД в изученной публичной части — чтение документов, а не API отправки чеков. Это явно отражено и не подменено протоколом кассы.
- Документальный Stage 1 не меняет сервисы, HTTP-контракты, зависимости или тесты. Stage 2 по issue #6 не начинается до подтверждения владельца после исследовательского PR.
