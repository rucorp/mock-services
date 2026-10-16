© 2026 ООО «Аксиома» ИНН:7842223709 · mock-services · Apache-2.0
SPDX-License-Identifier: Apache-2.0

# Контейнерный харденинг и graceful shutdown

Все три compose-файла задают одинаковый набор харденинг-флагов каждому сервису:

- `docker-compose.yml` — 10 сервисов (весь контур, из исходников)
- `docker-compose.include.yml` — 10 сервисов (включая kontur-ofd-mock)
- `docker-compose.staging.yml` — 2 сервиса (tbank + kassa)

## Флаги

| Флаг | Значение | Зачем |
|---|---|---|
| `init` | `true` | tini как PID 1: сигналы доходят до Node, зомби не накапливаются |
| `read_only` | `true` | rootfs только для чтения: запись — лишь в volume `/data` и tmpfs `/tmp` |
| `tmpfs` | `["/tmp"]` | `/tmp` в памяти, не требует изменения read-only rootfs |
| `cap_drop` | `["ALL"]` | все Linux capabilities сняты (порты 3100+ непривилегированные) |
| `security_opt` | `["no-new-privileges:true"]` | запрет повышения привилегий |
| `pids_limit` | `256` | ограничение числа процессов |

## Graceful shutdown

По `SIGTERM`/`SIGINT` (`docker stop`, `docker compose restart`) сервис:

1. перестаёт принимать новое,
2. синхронно сбрасывает отложенные записи состояния и очереди (окно debounce 150 мс),
3. закрывает соединения и выходит с кодом 0.

Страховочный таймер — 1 с, поэтому остановка не упирается в 10-секундный SIGKILL.

Хелпер — `installGracefulShutdown` в `packages/core`.

Запуск без compose (`node services/<name>-mock/server.js`) поведение не меняет.

## Проверки

- `npm run test:docker` — контейнер с полным набором флагов (`docker stop` → exit 0 ≤ 2 с, отложенная запись переживает рестарт)
- `npm run test:tbank` и `npm run test:kassa` — регресс «отложенная запись → сигнал → рестарт с тем же state-файлом»
- CI — шаг «Проверка контейнерного харденинга» для всех трёх compose

## Порты и bind

- Root compose по умолчанию слушает только `127.0.0.1`.
- Для осознанного сетевого доступа задайте bind отдельно: `MOCK_TBANK_BIND_IP=0.0.0.0 docker compose up`
- Не используйте `0.0.0.0` на публичном хосте без `MOCK_OPERATOR_TOKEN`/`MOCK_ADMIN_TOKEN`, firewall и TLS — см. [SECURITY](../SECURITY.md).

## Лимиты состояния

Все 10 адаптеров и `docker-compose.include.yml` поддерживают:

- `MOCK_SANDBOX_MAX_STATE_BYTES` — байты JSON одной песочницы (пусто — дефолт 8 МиБ при квоте документов, иначе без лимита)
- `MOCK_SANDBOX_GLOBAL_MAX_STATE_BYTES` — байты JSON всех песочниц одного сервиса, включая `default` (дефолт 64 МиБ). `0` выключает лимит.

Квота per-sandbox ≠ память контейнера: общий бюджет сдерживает суммарный рост, но не заменяет `mem_limit: 128m` и измерение RSS.

Превышение глобального бюджета на записи/импорте → HTTP 400 + `errorCode` + `sandbox_state_budget_exceeded`, `kind: 'bytes'`, без частичного применения.

См. [байтовые квоты ядра](../packages/core/README.md#байтовые-квоты-песочниц) и env-таблицы сервисов.
