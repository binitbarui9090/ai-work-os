# API + worker image.
#
# One image, two entrypoints (`dist/index.js` for the API, `dist/worker.js`
# for the background worker) — docker-compose picks which with `command:`.
# Build from the repo root: `docker build -f apps/api/Dockerfile .`
# (the api package depends on packages/shared, so the context has to include
# both).

FROM node:22-slim AS build
WORKDIR /app

# The whole repo, not just package.json files: `packages/shared` has a
# `prepare` script that builds it on `npm ci`, and that needs its tsconfig
# and source present at install time — copying package.json files first and
# source in later (the usual Docker caching trick) breaks that script.
COPY . .
RUN npm ci

RUN npm run build -w @workos/shared
RUN npm run build -w @workos/api

# ── Runtime ──────────────────────────────────────────────────────────────
# A second full `npm ci` (rather than pruning the build stage's node_modules)
# so this stage never silently inherits anything from the build stage by
# accident.
#
# `NODE_ENV=production` is set *after* installing, not before: npm treats
# that env var as an implicit `--omit=dev` the moment it's present, dev flag
# or not. `packages/shared`'s `prepare` script needs `tsc` — a
# devDependency — so omitting dev deps here breaks the install outright
# ("tsc: not found"). The extra ~150MB from keeping devDependencies in the
# final image is the better trade.
FROM node:22-slim AS runtime
WORKDIR /app

COPY . .
RUN npm ci

ENV NODE_ENV=production

# Overwrite with the real build output from the stage above.
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist

EXPOSE 4000
# Overridden by docker-compose's `command:` for the worker service.
CMD ["node", "apps/api/dist/index.js"]
