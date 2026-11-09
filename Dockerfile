# Realm Ledger game server (apps/server). Build from the repo root:
#   docker build -t realm-ledger-server .
FROM node:22-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.26.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/rules/package.json packages/rules/
COPY packages/verify/package.json packages/verify/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter @realm-ledger/server...
COPY packages/rules packages/rules
COPY packages/verify packages/verify
COPY apps/server apps/server
ENV NODE_ENV=production PORT=8080 DATA_DIR=/home/data
EXPOSE 8080
WORKDIR /app/apps/server
# The image tag this was built as (scripts/deploy-api.sh waits for /api/health to report it).
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
CMD ["node_modules/.bin/tsx", "src/main.ts"]
