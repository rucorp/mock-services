# Конспект: сделка, выплаты (e2c) и регистрация партнёров (acqapi)

Источники: `docs/multisplit.pdf` (описание продукта, 06.04.2026),
`docs/vyplaty-multisplit.pdf` («Протокол A2C_V2», выплаты),
`docs/api_reg_upd_multisplit.pdf` (регистрация, 16.06.2026). Конспект — неофициальный.

## Сделка (Deal / SpAccumulation)

Статусная модель: `Инициализация → Открыта → Частично отменена → Закрыта`.

| Статус | Когда |
|---|---|
| Открыта | есть успешные списания (CONFIRMED), финальной выплаты не было |
| Частично отменена | была хотя бы одна отмена/возврат на часть суммы сделки |
| Закрыта | успешная выплата с `FinalPayout=true` **или** метод `closeSpDeal` |

Баланс сделки = Σ списаний − Σ выплат. Валидации банка: выплата только по существующей
Сделке и только после успешного списания; сумма выплаты ≤ остатка; закрытие один раз;
возврат покупателю после закрытия запрещён. Срок жизни сделки задаётся договором
(по умолчанию авто-отмена оплат через 60 дней от авторизации, если сделка не закрыта;
при наличии выплат остаток возмещается площадке).

## Схема «N списаний : N выплат» (форма банка, не PCI DSS)

1. Первый платёж сделки: `POST /v2/Init` c `CreateDealWithType=NN` (вне блока DATA) —
   создаёт сделку; `DealId` в ответе **не** возвращается.
2. После холда — нотификация `AUTHORIZED` с параметром `SpAccumulationId` (= id сделки).
3. После оказания услуги — `POST /v2/Confirm` (стандартный, без сделочных параметров).
4. Выплата: `POST /e2c/v2/Init` (сумма ≤ суммы списаний, `DealId`; если выплата последняя —
   `FinalPayout=true` вне блока DATA) → `POST /e2c/v2/Payment` c `PaymentId` из ответа.
5. Повторные выплаты — пп. 4–5 в рамках остатка сделки (все условия одновременного
   повтора: без `FinalPayout=true` ранее, сделка не закрыта, баланс > суммы выплаты,
   срок жизни не истёк).
6. Новая сделка — снова `Init` c `CreateDealWithType=NN` без `DealId`; открытых сделок
   может быть любое количество.

Альтернативное управление: `POST /v2/createSpDeal` (`TerminalKey`, `SpDealType: NN`, `Token`
→ `SpAccumulationId`) и `POST /v2/closeSpDeal` (`TerminalKey`, `SpAccumulationId`, `Token`;
остаток баланса добавляется к вознаграждению площадки).

## Выплаты: `/e2c/v2/*`

| Контур | URL |
|---|---|
| Тест | `https://rest-api-test.tinkoff.ru/e2c/v2` (IP-WL, запросы с боевого терминала) |
| Боевой | `https://securepay.tinkoff.ru/e2c/v2` |

### Метод Init (`/e2c/v2/Init`) — инициирует выплату

Запрос: `TerminalKey`, `OrderId` (да), `Amount` (да, копейки; СБП-минимум 10 ₽), `DealId`
(да), `PaymentRecipientId` (да, ≤16 симв. — телефон/email/иной идентификатор получателя),
`Token` **или** набор `DigestValue`/`SignatureValue`/`X509SerialNumber`, плюс **канал выплаты**:

| Канал | Параметры |
|---|---|
| на привязанную карту | `CardId` (от AddCard/Init) |
| на карту по данным (PCI DSS) | `CardData` — `PAN=…;ExpDate=MMYY;CardHolder=…;CVV=…`, шифрование открытым ключом банка (X509 RSA 2048) → Base64 |
| по СБП | `Phone` (11 цифр) + `SbpMemberId` (банк-получатель из GetSbpMembers) — метод Payment не нужен |
| партнёру (ЮЛ, «перечисление третьему лицу») | `PartnerId` — код зарегистрированной точки (shopCode) |
| на иностранные карты | `senderAccountInfo` / `recipientAccountInfo` (AddressInfo/PersonInfo/PassportInfo) |

Прочие: `FinalPayout` (Boolean — закрыть сделку после выплаты), `LevelOfConfidence`,
`CustomerKey`, `DATA`, `Currency` (643).

### Метод Payment (`/e2c/v2/Payment`) — пополняет карту/счёт

Запрос: `TerminalKey`, `PaymentId` (из ответа Init), подпись. Не используется для СБП-выплат.
Временный статус `CREDIT_CHECKING` держится первые 10–20 минут — в это время конечный
статус уточняется через GetState.

### Метод GetState (`/e2c/v2/GetState`)

Запрос: `TerminalKey`, `PaymentId`, подпись. Ответ: `Success`, `Status`, `Amount`,
`OrderId`, `PaymentId`, `ErrorCode`.

Статусы выплаты: `NEW`, `CHECKING` (проверка данных), `CHECKED`, `COMPLETING`,
`COMPLETED` (успех), `REJECTED` (отклонена), `CREDIT_CHECKING` (обработка 10–20 мин).

### Метод CancelPayment (`/e2c/v2/CancelPayment`)

Отмена успешной выплаты **партнёру** в рамках открытой сделки; сумма = сумме выплаты.
Запрос: `TerminalKey`, `PaymentId`, `DealId`, подпись. Статусы: `CREDIT_CANCELING` →
`CREDIT_CANCELED`; при неуспехе остаётся `COMPLETED`.

### Метод GetSbpMembers (`/e2c/v2/GetSbpMembers`)

Список банков-участников СБП (идентификаторы `MemberId` для `SbpMemberId`).

## Регистрация и обновление точек партнёров (acqapi)

| Контур | URL |
|---|---|
| Тест | `https://acqapi-test.tinkoff.ru` |
| Боевой | `https://acqapi.tinkoff.ru` |

Требования: **mTLS-сертификат** для acqapi.tinkoff.ru (выпускается по инструкции банка;
TLS-сертификат НУЦ Минцифры), **IP-whitelist** (acq_help@tbank.ru).

1. **Авторизация:** `POST /oauth/token` — Basic-авторизация клиента `partner:partner`
   (постоянные значения на тесте и в бою), тело form-data: `grant_type=password`,
   `username`/`password` — логин/пароль, выданные банком. Ответ: `access_token` (Bearer),
   `expires_in`, `scope: partner`.
2. **Регистрация точки:** `POST /sm-register/register` (JSON) — реквизиты ЮЛ:
   `shopArticleId` (код точки у площадки, ≤32), `billingDescriptor`, `fullName`, `name`
   (кириллица, с ОПФ), `inn`, `kpp` (если нет — `00000000`), `ogrn`, `addresses[]`
   (legal/actual/…: zip, country ISO-3, city, street), `ceo` (телефон и гражданство
   обязательны), `founders.individuals[]`, `email`, `siteUrl`, `bankAccount` (account,
   korAccount, bankName, bik, kbk/oktmo — парные, `details` — шаблон назначения платежа,
   например `Перевод средств по договору № … по Реестру Операций от $(date). Сумма
   комиссии $(rub) руб. $(kop) коп.`), `mcc` (иначе берётся MCC торговой группы
   merchantId), `nonResident: false`.
   Ответ: `{code, shopCode, terminals: []}` — `shopCode` далее используется как
   **`PartnerId`** при выплате партнёру.
3. **Получение информации:** `GET /sm-register/register/shop/{shopCode}` — merchantIds,
   terminalIds, mcc, реквизиты, `userDefinedFees` (правила комиссий), `feeType` (UP/DOWN),
   `disableReimbursement`, `paymentSystemAttributes` (mid/tid).
4. **Обновление:** `PATCH /sm-register/register/{shopCode}` — банк-реквизиты для возмещения
   (`bankAccount.account/bankName/bik/details` обязательны при передаче блока) и др.
