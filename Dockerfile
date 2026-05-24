FROM oven/bun:1.3.5 AS builder

WORKDIR /app

ARG NPM_CONFIG_HUGEICONS_KEY
ARG API_URL=http://localhost:3001
ARG VITE_API_URL=http://localhost:3001
ARG VITE_DATABUDDY_CLIENT_ID
ARG WEB_URL

ENV NPM_CONFIG_HUGEICONS_KEY=$NPM_CONFIG_HUGEICONS_KEY
ENV API_URL=$API_URL
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_DATABUDDY_CLIENT_ID=$VITE_DATABUDDY_CLIENT_ID
ENV WEB_URL=$WEB_URL
ENV NODE_ENV=production
ENV PROD=true

COPY package.json bun.lock ./
COPY .npmrc ./

COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/
COPY apps/discord-bot/package.json ./apps/discord-bot/
COPY packages/db/package.json ./packages/db/
COPY packages/lib/package.json ./packages/lib/
COPY packages/hooks/package.json ./packages/hooks/

RUN bun install

COPY packages ./packages
COPY apps/web ./apps/web
COPY apps/api ./apps/api
COPY apps/discord-bot ./apps/discord-bot

WORKDIR /app/apps/api
RUN bun build src/index.ts --outdir dist --target bun --minify

WORKDIR /app/apps/web
RUN bun run build

FROM oven/bun:1.3.5-alpine

WORKDIR /app

RUN apk add --no-cache wget

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/web/.output ./apps/web/.output
COPY --from=builder /app/apps/web/package.json ./apps/web/package.json
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/apps/discord-bot ./apps/discord-bot

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3000 3001

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
