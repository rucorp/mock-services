# Образ для моков (tbank-mock, kassa-mock, yookassa-mock): выбирается командой.
# Сборка:  docker build -t mock-services .
# Банк:    docker run -p 3100:3100 mock-services node services/tbank-mock/server.js
# Касса:   docker run -p 3101:3101 mock-services node services/kassa-mock/server.js
# ЮKassa:  docker run -p 3102:3102 mock-services node services/yookassa-mock/server.js
FROM node:22-alpine

WORKDIR /app

# Только рантайм-файлы: без node_modules (зависимостей нет), без доков и тестов.
COPY package.json ./
COPY packages ./packages
COPY services ./services
COPY scripts ./scripts
COPY protocols ./protocols
COPY docs/integration ./docs/integration
COPY docs/openapi ./docs/openapi

ENV NODE_ENV=production \
    MOCK_HOST=0.0.0.0

# Порт по умолчанию — банк; для кассы переопределяется MOCK_PORT=3101,
# для ЮKassa — MOCK_PORT=3102.
EXPOSE 3100 3101 3102

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD node -e "const p=process.env.MOCK_PORT||'3100';require('http').get({host:'127.0.0.1',port:p,path:process.env.MOCK_HEALTH_PATH||'/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "services/tbank-mock/server.js"]
