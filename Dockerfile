# Образ для моков (tbank-mock, kassa-mock, yookassa-mock, atol-mock): выбор командой.
# Сборка:  docker build -t mock-services .
# Банк:    docker run -p 3100:3100 -e MOCK_PORT=3100 -e MOCK_HEALTH_PATH=/health \
#            mock-services node services/tbank-mock/server.js
# Касса:   docker run -p 3101:3101 -e MOCK_PORT=3101 -e MOCK_HEALTH_PATH=/healthz \
#            mock-services node services/kassa-mock/server.js
# ЮKassa:  docker run -p 3102:3102 -e MOCK_PORT=3102 -e MOCK_HEALTH_PATH=/health \
#            mock-services node services/yookassa-mock/server.js
# АТОЛ:    docker run -p 3103:3103 -e MOCK_PORT=3103 -e MOCK_HEALTH_PATH=/health \
#            mock-services node services/atol-mock/server.js
#
# F-35: HEALTHCHECK опрашивает MOCK_PORT по MOCK_HEALTH_PATH (у кассы — /healthz).
#   Без переменных скрипт healthcheck сам перебирает известные пары сервисов
#   (3100/health, 3101/healthz, 3102/health, 3103/health); переменные — когда
#   сервис поднят на своём порту/пути явно (как в compose).
# F-36: сервисы работают от непривилегированного пользователя mock (UID/GID 10001);
#   состояние пишется в /data — при --read-only примонтируйте сюда volume/tmpfs.
# F-37: базовый образ закреплён дайджестом; обновление security patches — только
#   контролируемым bump (см. «Обновление базового образа» в CONTRIBUTING.md).
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

WORKDIR /app

# Только рантайм-файлы: без node_modules (зависимостей нет), без доков и тестов.
COPY package.json ./
COPY packages ./packages
COPY services ./services
COPY scripts ./scripts
COPY protocols ./protocols
COPY docs/integration ./docs/integration
COPY docs/openapi ./docs/openapi

# F-36: runtime-пользователь и единственное записываемое место — /data (state
# persist/restore). Права закреплены в образе: named volume наследует их при
# первом монтировании; /app остаётся read-only (root-owned, world-readable).
RUN addgroup -S -g 10001 mock \
 && adduser -S -u 10001 -G mock -h /home/mock mock \
 && mkdir -p /data \
 && chown mock:mock /data

ENV NODE_ENV=production \
    MOCK_HOST=0.0.0.0

# Порт по умолчанию — банк; для кассы переопределяется MOCK_PORT=3101,
# для ЮKassa — MOCK_PORT=3102, для АТОЛ Онлайн — MOCK_PORT=3103.
EXPOSE 3100 3101 3102 3103

VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD ["node", "scripts/docker-healthcheck.js"]

USER mock:mock

CMD ["node", "services/tbank-mock/server.js"]
