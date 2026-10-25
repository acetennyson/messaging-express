# syntax=docker/dockerfile:1
#
# Messaging Express: production image (runs `node dist/server.js`, Socket.IO capable).
# Build:  docker build -t messaging-express .
# One Node version, one lockfile (`npm ci`), Linux everywhere: no more "works on my machine".

ARG NODE_VERSION=22

# ---- base: pinned Node. Debian slim (glibc), NOT alpine: bcrypt, sharp and
# ---- firebase-admin ship glibc prebuilt binaries, alpine (musl) causes surprises.
FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---- deps: install exactly what package-lock.json says. Cached until a package.json/lockfile changes.
# `npm ci` FAILS if package.json and the lockfile disagree. That is the point: no silent resolution changes.
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/client/package.json packages/client/
RUN npm ci

# ---- build: next build + tsc for server.ts (what `npm run build` does).
# Route modules read DATABASE_URL / JWT_SECRET at import time, and `next build` imports them,
# so placeholders are needed here. They are set on this one command only: not stored in any
# image layer's ENV, and the runtime stage never sees them.
FROM deps AS build
COPY . .
RUN DATABASE_URL=postgres://build:build@localhost:5432/build \
    JWT_SECRET=build-time-placeholder \
    npm run build

# ---- runtime
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
# Full node_modules on purpose: `next start` loads next.config.ts, which needs `typescript`
# (a devDependency). Slimming this image is a later optimisation, not worth the risk now.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/next.config.ts ./next.config.ts
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
# `local` storage provider writes to <cwd>/.uploads; mount a volume here.
RUN mkdir -p /app/.uploads && chown node:node /app/.uploads
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# exec form: node is PID 1 and receives SIGTERM, so server.ts's graceful shutdown runs.
CMD ["node", "dist/server.js"]
