# Конспект: экосистема GitHub вокруг API Т-Банка

Срез: 2026-09-19 (поиск GitHub repos/code по «tinkoff acquiring», «tbank api», полям
`CreateDealWithType`, `SpAccumulationId`, `securepay.tinkoff.ru/v2`, `e2c/v2/Payment`).
Звёздность на дату среза. Собственные проверки кода не проводились — ссылки «как есть».

## Готовых моков эквайринга не найдено

Поиск «tinkoff acquiring mock/stub» результатов не дал. Единственный найденный мок —
[yosbel-penate2/mock-tbank-api](https://github.com/yosbel-penate2/mock-tbank-api) —
это mock **T-Invest OpenAPI** (инвестиции/tbank-mcp), не эквайринг. Без лицензии.
→ Мок-стенд эквайринга/выплат каждый делает сам (см. notes/05-mock-stand.md).

## Машиночитаемые спецификации

- [m4tveevm/paygen](https://github.com/m4tveevm/paygen) (MIT) — генератор платёжных
  фикстур; содержит **OpenAPI «Массовые выплаты 1.46»** (`e2c/v2`, `a2c/sbp/v2`,
  GetAccountInfo v2/v3, привязка карт, сертификаты, GetOperationDetails,
  getConfirmOperation). Зеркало: `openapi/tbank-payouts-openapi.json` в этом репо.
  Готовая база для генерации мок-сервера (prism/wiremock).

## SDK (по языкам)

| SDK | Язык | Лицензия | Комментарий |
|---|---|---|---|
| [tinkoff-mobile-tech/tinkoff-asdk-ios](https://github.com/tinkoff-mobile-tech/tinkoff-asdk-ios) (44★) и android | Swift/Kotlin | Apache-2.0 | официальные мобильные SDK эквайринга |
| [jfkz/tinkoff-payment-sdk](https://github.com/jfkz/tinkoff-payment-sdk) (15★) | TypeScript | MIT | покрывает safe deal: `createSpDeal`, `closeSpDeal`, `Charge` (RebillId), Init с SpAccumulationId |
| [ai-iskuzhin/TBankAcquiringNet](https://github.com/ai-iskuzhin/TBankAcquiringNet) (1★) | C#/.NET | MIT | есть мультисплит-поля (`CreateDealWithType`), sample `DealIdSample`, design-doc |
| [nikita-vanyasin/tinkoff](https://github.com/nikita-vanyasin/tinkoff) (37★) | Go | MIT | клиент Acquiring API v2 |
| [JustCommunication-ru/tinkoff-acquiring-api-client](https://github.com/JustCommunication-ru/tinkoff-acquiring-api-client) (10★) | PHP | MIT | клиент интернет-эквайринга |
| [remils/tinkoff-acquiring-client](https://github.com/remils/tinkoff-acquiring-client) (7★) | PHP | MIT | клиент REST API |
| [dfiks/tbank-laravel](https://github.com/dfiks/tbank-laravel) (1★) | PHP/Laravel | MIT | Laravel-пакет интернет-эквайринга Т-Банка |
| [codex-team/tinkoff-api](https://github.com/codex-team/tinkoff-api) (5★) | Node.js | MIT | SDK Acquiring API |
| [MadBrains/Tinkoff-Acquiring-SDK-Flutter](https://github.com/MadBrains/Tinkoff-Acquiring-SDK-Flutter) (45★) | Dart/Flutter | — | Flutter SDK |
| [ReanSn0w/go-tinkoff-merchant](https://github.com/ReanSn0w/go-tinkoff-merchant) | Go | — | модели safe deal (`SpAccumulationId`) |

## Реальные реализации Мультисплита (маркетплейс-паттерн)

- [prukon/admin.k](https://github.com/prukon/admin.k) (без лицензии) — Laravel-админка
  с полным мультисплит-контуром: разбор платежа, `closeSpDeal(DealId, partnerId)`,
  создание и прогон выплаты (`PartnerId` = shopCode точки, `DealId`, `FinalPayout`),
  поллинг GetState, расчёт нетто к выплате (процент + фикс-минимум). Ближайший публичный
  аналог вертикали «оплата → сделка → выплата партнёру-ЮЛ».
- [pomuc/OpenMoney](https://github.com/pomuc/OpenMoney) (MIT) — продукт «безопасных
  сделок» на нескольких контурах (Т-Банк Мультирасчёты, Точка, ЮKassa safe_deal):
  процесс pay-in → hold → payout, деньги/чеки как раздельные контуры; C# SDK
  `OpenMoney.TBank` с выплатами `e2c`.

## CMS-интеграции (полезно как референс UX/статусов)

- [bezumkin/orbita](https://github.com/bezumkin/orbita) — сервис оплат T-Bank (MODX);
- [Teplitsa/Leyka](https://github.com/Teplitsa/Leyka) — Tinkoff-gateway для благотворительности (PHP);
- [octocart/tinkoffoctocart-plugin](https://github.com/octocart/tinkoffoctocart-plugin) — EACQ-плагин (PHP).

## Замечания

- Репозитории без лицензии (TbankLib, prukon/admin.k, mock-tbank-api) — только
  читать как референс, код не копировать.
- Публичные страницы developer.tbank.ru не полны относительно PDF-док Мультисплита:
  мультисплит-параметры Init (PaymentRecipientId/CreateDealWithType) и весь e2c-контур
  описаны только в PDF (см. `docs/`).
