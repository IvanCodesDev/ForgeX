# FORGE·X 智造洞察 — 零 npm 依赖：无 install、无 build，拷入即运行。
# 适用 Fly.io / Railway / Zeabur / 自建 Docker 主机；Render 用原生 Node 环境更简单。
FROM node:20-alpine

WORKDIR /app
COPY . .

# 容器内必须监听 0.0.0.0；PORT 可被平台注入覆盖（server/config.js 会读取）
ENV HOST=0.0.0.0 \
    PORT=8787 \
    NODE_ENV=production

EXPOSE 8787
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
