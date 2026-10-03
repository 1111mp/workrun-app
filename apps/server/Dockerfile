# syntax=docker/dockerfile:1.4
FROM ghcr.io/pnpm/pnpm:12 AS base
RUN pnpm runtime set node 24 -g

FROM base AS build

WORKDIR /app

COPY . .

RUN --mount=type=cache,id=pnpm,target=/var/cache/pnpm \
    pnpm install --store-dir /var/cache/pnpm --frozen-lockfile
RUN pnpm --filter=workrun-server build
# deploy creates a portable production dependency tree; dist is ignored by the app's .gitignore.
RUN pnpm --filter=workrun-server --prod deploy /prod/server && \
    cp -R apps/server/dist /prod/server/dist

FROM base AS runner

ENV NODE_ENV=production
ENV SERVER_PORT=3000

WORKDIR /app

RUN addgroup --system nestjs && adduser --system --ingroup nestjs nestjs

COPY --chown=nestjs:nestjs --from=build /prod/server ./

# The default LOG_DIR is relative to the application directory and must be writable at runtime.
RUN mkdir logs && chown nestjs:nestjs logs

USER nestjs

EXPOSE 3000

CMD ["node", "dist/main.js"]
