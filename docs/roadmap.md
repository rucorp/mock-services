© 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
SPDX-License-Identifier: Apache-2.0

# Дорожная карта

Краткая история этапов. Детали, оценки и приоритеты — во внутреннем аудите проекта[^audit] (закрытый репозиторий команды).

> Пометки [VERIFY]/[FORK] — см. [легенду](overview.md#пометки-verify-и-fork).

| Этап | Что | Статус |
|---|---|---|
| 0–3 | спека, перенос моков в репо, ядро, DX-слой с каталогом ошибок | ✅ |
| 4 | аудит и исправление критичных дефектов (потеря вебхуков после рестарта, дубли, фискальные данные, XSS, валидации денег) + CI/Docker | ✅ 0.2.0 |
| 5 | провайдеро-нейтральный дефолт: `MOCK_PROFILE=plain`, профиль Мультирасчетов конфигом; `X-Mock-Scenario` (kassa) | ✅ 0.3.0 |
| 6 | полнота 54-ФЗ: `buy`/`buy_refund`, авансы и зачёты, все ставки НДС, очередь ОФД, маркировка Честный ЗНАК | ✅ 0.4.0 |
| 7 | сценарное API (`/mock/scenarios`, `X-Mock-Scenario`) + виртуальные часы (`/mock/time`) + чарджбэки e2e + внешний compose/GHCR | ✅ 0.4.0 |
| 8 | мульти-песочницы ([RFC-001](rfc/RFC-001-multi-tenant-sandboxes.md)), экзаменатор вебхуков (`/mock/verify-merchant`), хаос (`X-Mock-Latency`), curl-сниппеты | ✅ 0.5.0 |
| 9 | Т-Банк Wave 2 + СБП QR + рекурренты + `acqapi`; Касса: смены 24ч/Z-отчёт, ресурс ФН, позиционный возврат, dry-run `/validate`; OpenAPI 3.1 + drift-детектор | ✅ 0.5.0 |
| 10 | изоляция песочниц RFC-001 за env-флагом: request-local, hosted tenancy + owner-token, TTL, квоты, изоляция compose-теста | ✅ 0.6.0 |
| 11 | Stage 2: ЮKassa end-to-end (#33): REST `/v3`, Basic Auth + `Idempotence-Key`, two-stage + partial capture, confirmation-страница, вебхуки без подписи (ACK 200) | ✅ 0.6.0 |
| 12 | Stage 2: АТОЛ Онлайн direct v4 (#34): `/possystem/v4/`, `getToken` в заголовке `Token` 24ч, 6 операций, `wait → done\|fail`, идемпотентность `external_id` | ✅ 0.6.0 |
| 13 | Stage 2: Альфа-Банк REST (#41): `/payment/rest/*.do` form-urlencoded, `formUrl` + ACS 3DS1/3DS2, GET-callback HMAC-SHA256 ACK 200, `sessionTimeoutSecs` | ✅ 0.6.0 |
| 14 | Stage 2: Сбербанк Ecom REST v1.1.11.1 (#81): JSON `/ecomm/gw/partner/api/v1/*.do`, hosted form ACS `111111`, JSON callbacks без подписи retry 3×60s, TTL 20 мин | ✅ 0.6.0 |
| 15 | Stage 2: ВТБ SMB E-commerce (#87): JSON `/openapi/smb/efcp/e-commerce/v1/`, OAuth 2.0 `client_credentials` + `X-IBM-Client-Id`, decimal рубли, TTL 20 мин | ✅ 0.6.0 |
| 16 | Stage 2: Первый ОФД OKassa (#92): `POST /getToken` → Bearer 24ч, асинхронная очередь `transaction/{type}` → `requestId`, статусы `IN_PROGRESS → COMPLETED\|ERROR`, unsigned callback | ✅ Unreleased |
| 17 | Stage 2: Такском read-only (#112): `POST /API/v2/Login` с `Integrator-ID` → `Session-Token` TTL 300s sliding, `AccountList`, `NewDocuments` 10 суток, курсор по id, 3106/2203 | ✅ Unreleased |

Детали по каждому адаптеру — в [CHANGELOG](../CHANGELOG.md) и в гайдах:

- [Т-Банк](integration/tbank-eacq.md) · [ЮKassa](integration/yookassa.md) · [Альфа](integration/alfa.md) · [Сбер](integration/sber.md) · [ВТБ](integration/vtb.md)
- [Ferma](integration/ferma-ofd.md) · [АТОЛ](integration/atol.md) · [Первый ОФД](integration/first-ofd.md) · [Контур.ОФД](integration/kontur-ofd.md) · [Такском](integration/taxcom.md)

[^audit]: `docs/audit/AUDIT-2026-10-08.md` — аудит репозитория перед публикацией (находки, оценки, приоритеты).
