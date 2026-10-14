# Подключение `mock-services` в платформу Lovii (внешний сервис вместо встроенных копий)

> Документ для сопровождающего `lovii-tech/lovii-core` и инфраструктуры стендов
> (dev CHUWI / `gostiny-bild` и `staging`).
> Версия `mock-services`: **0.4.0** · Образ: `ghcr.io/rucorp/mock-services:0.4.0`

---

## 1. Архитектурное решение: как доставляется мок-контур

Вместо хранения копий `lovii-core/tbank-mock/` и `lovii-core/kassa-mock/` с маунтами
`./tbank-mock:/srv:ro` и `./kassa-mock:/srv:ro` используются **оба взаимодополняющих артефакта** этого репозитория:

1. **Единый версионируемый Docker-образ `ghcr.io/rucorp/mock-services:<tag>`**
   (публикуется CI в GitHub Container Registry с тегами `:0.4.0`, `:latest`, `:sha-<short>`).
   Один легковесный образ (`node:22-alpine`, zero-dependency) содержит `packages/core`,
   `services/tbank-mock` и `services/kassa-mock`; роль контейнера выбирается `command`.
2. **Внешний compose-файл [`docker-compose.include.yml`](../../docker-compose.include.yml)**
   с фиксированными именами сервисов `tbank-mock` и `kassa-mock`, профилем `profiles: ["mock"]`,
   лимитами памяти (`128m`), штатными healthcheck-ами и параметризованными Caddy-лейблами.

### Почему выбрана связка «GHCR-образ + `docker-compose.include.yml`»

- **Ноль кода моков в `lovii-core`**: папки `tbank-mock/` и `kassa-mock/` удаляются из `lovii-core` целиком — исчезает рассинхрон версий.
- **Сетевые адреса внутри Docker-сети не меняются**: сервисы называются `tbank-mock` (`:3100`) и `kassa-mock` (`:3101`), поэтому `TBANK_API_URL=http://tbank-mock:3100/v2` и `FERMA_API_URL=http://kassa-mock:3101` в `lovii-core` остаются прежними.
- **Строгая изоляция прода (`prod-isolation`)**: оба сервиса помечены `profiles: ["mock"]`. В production-окружении профиль `mock` не включается — контейнеры не создаются, порты не открываются, мок-образы даже не пуллятся.
- **Провайдеро-нейтральность репо**: домены `*.lovii.ru`, бренд чека и креды не зашиты в код и compose — они подаются через переменные окружения стенда.

---

## 2. Пошаговая инструкция миграции `lovii-core`

### Шаг 1. Удалить встроенные копии моков из дерева `lovii-core`

В репозитории `lovii-tech/lovii-core`:

```bash
git rm -r tbank-mock/ kassa-mock/
```

Убедитесь, что в `.dockerignore` / `deploy`-скриптах `lovii-core` больше нет шагов
синхронизации папок `tbank-mock/` и `kassa-mock/` на сервер (`/opt/lovii-core-staging/*-mock`).

---

### Шаг 2. Обновить `docker-compose.staging-extras.yml` (и dev-compose на CHUWI)

Вы можете либо подключить готовый `docker-compose.include.yml` через директиву `include:`
(Docker Compose v2.20+), либо вставить приведённый ниже блок напрямую в `docker-compose.staging-extras.yml`.

#### Вариант А — через `include`

Скопируйте `docker-compose.include.yml` рядом с compose-файлами стенда (или подключите из git/пакета) и добавьте в `docker-compose.staging-extras.yml`:

```yaml
include:
  - path: ./docker-compose.include.yml
```

#### Вариант Б — прямая замена секций `tbank-mock` и `kassa-mock` в `docker-compose.staging-extras.yml`

Замените старые секции с `volumes: ["./tbank-mock:/srv:ro"]` / `["./kassa-mock:/srv:ro"]` на образ:

```yaml
services:
  tbank-mock:
    image: ghcr.io/rucorp/mock-services:${MOCK_IMAGE_TAG:-0.6.0}${MOCK_IMAGE_DIGEST-@sha256:8d0314fd5bf5f73edf1937553d069240cdf835026940e6ac3b6c5746b9df7987}
    profiles: ["mock"]
    working_dir: /app
    command: ["node", "services/tbank-mock/server.js"]
    ports:
      - "127.0.0.1:3100:3100"
    environment:
      MOCK_HOST: "0.0.0.0"
      MOCK_PORT: "3100"
      MOCK_PROFILE: "multisplit"
      MOCK_TERMINAL_KEY: "${MOCK_TERMINAL_KEY:-TBANKMOCKTEST}"
      MOCK_TERMINAL_PASSWORD: "${MOCK_TERMINAL_PASSWORD:-mockpass123}"
      MOCK_PUBLIC_BASE_URL: "${MOCK_TBANK_PUBLIC_BASE_URL:-http://localhost:3100}"
      MOCK_DEFAULT_NOTIFICATION_URL: "${MOCK_DEFAULT_NOTIFICATION_URL:-}"
      MOCK_RETRY_MS: "${MOCK_RETRY_MS:-60000}"
      MOCK_MAX_ATTEMPTS: "${MOCK_MAX_ATTEMPTS:-24}"
      MOCK_STATE_FILE: "/data/tbank-state.json"
    volumes:
      - mock-services-data:/data
    labels:
      caddy: "${MOCK_TBANK_CADDY_DOMAIN:-}"
      caddy.reverse_proxy: "{{upstreams 3100}}"
    mem_limit: 128m
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get({host:'127.0.0.1',port:3100,path:'/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 3s
    restart: unless-stopped

  kassa-mock:
    image: ghcr.io/rucorp/mock-services:${MOCK_IMAGE_TAG:-0.6.0}${MOCK_IMAGE_DIGEST-@sha256:8d0314fd5bf5f73edf1937553d069240cdf835026940e6ac3b6c5746b9df7987}
    profiles: ["mock"]
    working_dir: /app
    command: ["node", "services/kassa-mock/server.js"]
    ports:
      - "127.0.0.1:3101:3101"
    environment:
      MOCK_HOST: "0.0.0.0"
      MOCK_PORT: "3101"
      MOCK_FERMA_LOGIN: "${MOCK_FERMA_LOGIN:-loviitest}"
      MOCK_FERMA_PASSWORD: "${MOCK_FERMA_PASSWORD:-mockpass123}"
      MOCK_PROCESS_MS: "${MOCK_PROCESS_MS:-4000}"
      MOCK_GROUPS: "${MOCK_GROUPS:-Main}"
      MOCK_AGENT_LINE: "${MOCK_AGENT_LINE:-ООО «Аксиома» — торговый агент (ЛОVИ)}"
      MOCK_AGENT_INN: "${MOCK_AGENT_INN:-7842223709}"
      MOCK_PUBLIC_BASE_URL: "${MOCK_KASSA_PUBLIC_BASE_URL:-http://localhost:3101}"
      MOCK_STATE_FILE: "/data/kassa-state.json"
    volumes:
      - mock-services-data:/data
    labels:
      caddy: "${MOCK_KASSA_CADDY_DOMAIN:-}"
      caddy.reverse_proxy: "{{upstreams 3101}}"
    mem_limit: 128m
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get({host:'127.0.0.1',port:3101,path:'/healthz'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 3s
    restart: unless-stopped

volumes:
  mock-services-data:
```

> **Сеть Docker:** если в `lovii-core` сервисы сидят в именованной сети (например, `lovii-net` или `default`), добавьте ту же `networks:` секцию, что была у встроенных контейнеров, чтобы Caddy и `core-app` видели `tbank-mock:3100` и `kassa-mock:3101` по DNS.

---

### Шаг 3. Сброс dev-стенда (CHUWI / `gostiny-bild`) без загрязнения прод-конфигурации

На dev-стенде CHUWI сброс стенда накатывает свежий слепок прода. Чтобы моки работали на стенде, но никогда не попадали в прод-конфиг:

1. В основном `.env` прода нет `COMPOSE_PROFILES=mock` и нет `MOCK_*` переменных.
2. На CHUWI поверх копии кладётся стендовый `.env.dev-mock` (или override в systemd/скрипте сброса стенда `reset-stand.sh` после восстановления дампа):
   - включает `COMPOSE_PROFILES=mock`,
   - переключает `TBANK_API_URL=http://tbank-mock:3100/v2` и `FERMA_API_URL=http://kassa-mock:3101`,
   - выставляет `PAYMENTS_ENABLED=true`, `PAYMENTS_FAKE=false`, `FISCALIZATION_ENABLED=true`, `FISCALIZATION_PROVIDER=ferma`.
3. Caddy-домены (`MOCK_TBANK_CADDY_DOMAIN`, `MOCK_KASSA_CADDY_DOMAIN`) на локальном CHUWI оставляются пустыми, а `MOCK_TBANK_PUBLIC_BASE_URL` / `MOCK_KASSA_PUBLIC_BASE_URL` указывают на локальный адрес стенда (`http://localhost:3100` и `http://localhost:3101` или LAN-адрес CHUWI).

---

### Шаг 4. Проверочный чеклист после миграции

Выполните в директории `lovii-core`:

```bash
# 1. В дереве core не осталось мок-кода
test ! -d tbank-mock && test ! -d kassa-mock && echo "OK: мок-папки удалены"

# 2. Прод-путь (без профиля mock) не включает ни одного мок-сервиса
COMPOSE_PROFILES="" docker compose -f docker-compose.yml -f docker-compose.staging-extras.yml config --services \
  | grep -E "tbank-mock|kassa-mock" && echo "FAIL: моки видны без профиля!" || echo "OK: prod чист"

# 3. Стенд-путь (с профилем mock) поднимает оба сервиса и проходит healthcheck
COMPOSE_PROFILES=mock docker compose -f docker-compose.yml -f docker-compose.staging-extras.yml up -d tbank-mock kassa-mock
curl -fsS http://127.0.0.1:3100/health
curl -fsS http://127.0.0.1:3101/healthz
```

---

## 3. Матрица переменных окружения по контурам (`dev / staging / prod`)

В колонке **`prod`** нет ни одной переменной `MOCK_*` и профиль `mock` выключен:
боевой контур ходит только в боевой Т-Банк и боевую OFD Ferma.

| Переменная | Кто читает | `dev` (CHUWI / `gostiny-bild`) | `staging` | `prod` (боевой контур) |
|---|---|---|---|---|
| `COMPOSE_PROFILES` | Docker Compose | `mock` (когда включён платёжный стенд) | `mock` | **не задан** (пусто — моки не поднимаются) |
| `MOCK_IMAGE` | Compose | `ghcr.io/rucorp/mock-services` | `ghcr.io/rucorp/mock-services` | — *(не используется)* |
| `MOCK_IMAGE_TAG` | Compose | `0.6.0` | `0.6.0` | — *(не используется)* |
| `MOCK_IMAGE_DIGEST` | Compose | пусто (pin по умолчанию в compose-модуле) | пусто (pin по умолчанию) | — *(не используется)* |
| `PAYMENTS_ENABLED` | `lovii-core` | `true` (флагом стенда) | `true` | `true` |
| `PAYMENTS_FAKE` | `lovii-core` | `false` (через HTTP в `tbank-mock`) | `false` | `false` |
| `TBANK_API_URL` | `lovii-core` | `http://tbank-mock:3100/v2` | `http://tbank-mock:3100/v2` | `https://securepay.tinkoff.ru/v2` |
| `TBANK_TERMINAL_KEY` | `lovii-core` + `tbank-mock` | `TBANKMOCKTEST` | `TBANKMOCKTEST` | `<боевой TerminalKey банка>` |
| `TBANK_TERMINAL_PASSWORD` | `lovii-core` + `tbank-mock` | `mockpass123` | `mockpass123` | `<боевой пароль терминала>` |
| `TBANK_NOTIFICATION_URL` | `lovii-core` + `tbank-mock` | `http://app:8000/api/v1/payments/tbank/webhook` | `https://api-staging.lovii.ru/api/v1/payments/tbank/webhook` | `https://api.lovii.ru/api/v1/payments/tbank/webhook` |
| `FISCALIZATION_ENABLED` | `lovii-core` | `true` | `true` | `true` |
| `FISCALIZATION_PROVIDER` | `lovii-core` | `ferma` | `ferma` | `ferma` |
| `FERMA_API_URL` | `lovii-core` | `http://kassa-mock:3101` | `http://kassa-mock:3101` | `https://ferma.ofd.ru` |
| `FERMA_LOGIN` | `lovii-core` + `kassa-mock` | `loviitest` | `loviitest` | `<боевой логин OFD Ferma>` |
| `FERMA_PASSWORD` | `lovii-core` + `kassa-mock` | `mockpass123` | `mockpass123` | `<боевой пароль OFD Ferma>` |
| `FERMA_GROUP` | `lovii-core` + `kassa-mock` | `Main` | `Main` | `<боевая группа ККТ>` |
| `FERMA_CALLBACK_URL` | `lovii-core` | `http://app:8000/api/v1/fiscal/callback?secret=...` | `https://api-staging.lovii.ru/api/v1/fiscal/callback?secret=...` | `https://api.lovii.ru/api/v1/fiscal/callback?secret=...` |
| `MOCK_TBANK_PROFILE` | `tbank-mock` | `multisplit` | `multisplit` | — |
| `MOCK_TBANK_PUBLIC_BASE_URL` | `tbank-mock` | `http://localhost:3100` (или LAN URL CHUWI) | `https://mock-pay-staging.lovii.ru` | — |
| `MOCK_KASSA_PUBLIC_BASE_URL` | `kassa-mock` | `http://localhost:3101` (или LAN URL CHUWI) | `https://mock-kassa-staging.lovii.ru` | — |
| `MOCK_TBANK_CADDY_DOMAIN` | Caddy (staging) | *(пусто)* | `mock-pay-staging.lovii.ru` | — |
| `MOCK_KASSA_CADDY_DOMAIN` | Caddy (staging) | *(пусто)* | `mock-kassa-staging.lovii.ru` | — |
| `MOCK_AGENT_LINE` | `kassa-mock` | `ООО «Аксиома» — торговый агент (ЛОVИ)` | `ООО «Аксиома» — торговый агент (ЛОVИ)` | — |
| `MOCK_AGENT_INN` | `kassa-mock` | `7842223709` | `7842223709` | — |
| `MOCK_PROCESS_MS` | `kassa-mock` | `1000` (быстрая печать для dev) | `4000` | — |
| `MOCK_VIRTUAL_CLOCK` | оба мока | *(пусто, управляется `/mock/time`)* | *(пусто)* | — |
| `MOCK_ADMIN_TOKEN` | оба мока | *(пусто)* | `<токен доступа к /admin на staging>` | — |

---

## 4. Как гонять сценарии Lovii (T-038 и T-024) против внешнего сервиса

### 4.1 Чарджбэки end-to-end (T-024): `dispute → representment → arb → won/lost`

Все вызовы подписываются тем же `Token` (алгоритм sha256 Т-Банка) и ходят на `POST /v2/Chargeback` (или `POST /v2/Dispute`):

```bash
# 1. Инициация чарджбэка эмитентом (полный или частичный Amount) -> статус DISPUTED
#    Мок переводит платёж в CHARGEBACK / PARTIAL_CHARGEBACK и шлёт подписанный вебхук в core
POST /v2/Chargeback
{"TerminalKey":"TBANKMOCKTEST","PaymentId":"...","Amount":80000,"ReasonCode":"4853","Token":"..."}

# 2. Оспаривание платформой (Representment) с приложением чека 54-ФЗ -> статус REPRESENTMENT
POST /v2/Chargeback
{"TerminalKey":"TBANKMOCKTEST","DisputeId":"DSP-30001","Action":"representment","FiscalDocumentNumber":"50001","Comment":"Чек полного расчёта + акт выдачи","Token":"..."}

# 3. Передача в арбитраж платёжной системы -> статус ARBITRATION
POST /v2/Chargeback
{"TerminalKey":"TBANKMOCKTEST","DisputeId":"DSP-30001","Action":"arbitration","Token":"..."}

# 4. Финальное решение арбитража (Outcome: "WON" возвращает деньги в CONFIRMED, "LOST" фиксирует CHARGEBACK)
POST /v2/Chargeback
{"TerminalKey":"TBANKMOCKTEST","DisputeId":"DSP-30001","Action":"resolve","Outcome":"WON","Token":"..."}
```

Те же переходы доступны кнопками в веб-консоли `GET /admin` (`эмитент: чарджбэк`, `спор: representment`, `спор: arb`, `спор: WON`, `спор: LOST`).

### 4.2 Сценарное API и виртуальные часы («через 7 / 60 дней»)

- **Заголовок `X-Mock-Scenario`** (или поле `DATA.mock_scenario` / `POST /mock/scenarios`):
  - `chargeback-after:7d` — запланировать автоматический чарджбэк через 7 дней после `CONFIRMED`;
  - `partial-refund:30%` (или `partial-refund:50000`) — частичный возврат;
  - `webhook-drop` — операция проводится в банке/кассе, но вебхук намеренно не отправляется (проверка фолбэка через `GetState` / `report`);
  - `webhook-duplicate` — дублирование вебхука (проверка идемпотентности);
  - `ofd-queue` / `ofd-reject` / `mark-fail` (в `kassa-mock`) — задержка чека в очереди ОФД, отказ ОФД, отказ проверки кода маркировки в «Честном ЗНАКе».
- **Сдвиг виртуального времени (`POST /mock/time`)**:
  ```bash
  # Сдвинуть часы банка на +7 дней (срабатывает авто-подтверждение холда AUTHORIZED->CONFIRMED и chargeback-after:7d)
  curl -s http://localhost:3100/mock/time -H 'Content-Type: application/json' -d '{"advance":"7d"}'

  # Сдвинуть часы банка на +60 дней (истекают брошенные заказы NEW->DEADLINE_EXPIRED и незакрытые сделки)
  curl -s http://localhost:3100/mock/time -H 'Content-Type: application/json' -d '{"advance":"60d"}'

  # Сбросить виртуальные часы в реальное время
  curl -s http://localhost:3100/mock/time -H 'Content-Type: application/json' -d '{"reset":true}'
  ```
