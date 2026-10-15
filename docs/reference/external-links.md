# external-links.md — официальные доки провайдеров: что снято, что где

Срез 2026-10-08. Снимки делались `curl`; `developer.tbank.ru` — SPA, страницы
без контента не сохранялись (см. «за рендером»).

## Т-Банк эквайринг

- Официальный портал: https://developer.tbank.ru/eacq
- Снято в [`tbank-api/`](tbank-api/api-init.html) (HTML с полным текстом):
  - [`api-init.html`](tbank-api/api-init.html) — POST /Init (создание платежа)
  - [`api-confirm.html`](tbank-api/api-confirm.html) — POST /Confirm (подтверждение холда)
  - [`api-cancel.html`](tbank-api/api-cancel.html) — POST /Cancel (отмена/возврат)
- За рендером (SPA-заглушки в curl, читать в браузере):
  - GetState — https://developer.tbank.ru/eacq/api/getstate
  - Нотификации — https://developer.tbank.ru/eacq/notifications/notification
- Конспекты (проверены на моке): [`tbank/01…06-*.md`](tbank/01-payment-api.md)
  (платёжный API, подпись нотификаций, выплаты/книга сделок, тестовые карты).

## ОФД Ferma

- Доки за авторизацией: https://ferma.ofd.ru/documents/documentation (401
  без личного кабинета) — снять при наличии доступа у владельца.
- Контракт зафиксирован на моке: [`README-kassa-mock.md`](README-kassa-mock.md)
  (getToken/sell/sell_refund/report/stats) + карточка 54-ФЗ[^t038].

## Следующие адаптеры (кандидаты)

- АТОЛ Онлайн: https://online.atol.ru/ (доки API — поз. «АТОЛ Онлайн»,
  v4/v5) — снимать при старте SZ-096 Фазы 2.
- Сбер/ЮKassa — после развилки §5 спеки.

<!-- Документы вне публичного репозитория -->

[^t038]: `docs/canon/T-038-fiscalization-54fz.md` — внутренняя карточка проекта по 54-ФЗ
    (во внутреннем репозитории `mock-services-docs`); публичный обзор контракта —
    `docs/integration/ferma-ofd.md`.
