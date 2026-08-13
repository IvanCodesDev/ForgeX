# syntax=docker/dockerfile:1.7

FROM node:22.13.1-alpine3.21 AS frontend-build
WORKDIR /src
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json
RUN npm ci --no-audit --no-fund
COPY frontend ./frontend
RUN npm run frontend:build

FROM node:22.13.1-alpine3.21 AS runtime
WORKDIR /app
ENV HOST=0.0.0.0 \
    PORT=8787 \
    NODE_ENV=production \
    DATA_DIR=/app/data

RUN mkdir -p /app/data && chown -R node:node /app
COPY --chown=node:node index.html README.md ./
COPY --chown=node:node server ./server
COPY --chown=node:node frontend/classic ./frontend/classic
COPY --chown=node:node contracts/profiles ./contracts/profiles
COPY --chown=node:node contracts/calibration ./contracts/calibration
COPY --chown=node:node contracts/validation ./contracts/validation
COPY --from=frontend-build --chown=node:node /src/dist/react ./dist/react

EXPOSE 8787
USER 1000:1000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
