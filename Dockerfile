# 构建产物是纯 JS（esbuild 打包 + 静态前端），构建阶段用本机架构，跨平台构建时不必走模拟
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY server server
COPY web web
RUN pnpm --filter server build && pnpm --filter web build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIST=/app/web \
    PORT=8787
COPY --from=build /src/server/dist ./dist
COPY --from=build /src/web/dist ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "dist/index.js"]
