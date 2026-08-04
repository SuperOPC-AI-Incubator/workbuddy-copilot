# WorkBuddy Copilot — Zeabur 一体化镜像
# 构建期 ARG（Zeabur 服务变量同名自动传入）：VITE_SUPABASE_URL /
# VITE_SUPABASE_PUBLISHABLE_KEY / VITE_SUPABASE_PROJECT_ID —— Vite 会把它们内联进前端包。
# 运行时变量：SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SERVICE_ROLE_KEY /
# WORKBUDDY_INGEST_SECRET / DOMAIN_PACK / AI_PROVIDER_*（或 DEEPSEEK_API_KEY）/ PORT（Zeabur 注入）。

FROM oven/bun:1.3.10 AS build
WORKDIR /app
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_SUPABASE_PROJECT_ID
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_SUPABASE_PROJECT_ID=$VITE_SUPABASE_PROJECT_ID
COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
RUN bun install --frozen-lockfile --registry=https://registry.npmjs.org
COPY . .
RUN bun run build

FROM node:22-slim
ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/.output ./.output
EXPOSE 8080
CMD ["node", ".output/server/index.mjs"]
