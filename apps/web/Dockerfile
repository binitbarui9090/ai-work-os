# Static web build, served by nginx with /api and /ws proxied to the api
# container by its docker-compose service name. This is what makes the
# self-hosted stack work with zero VITE_API_BASE_URL configuration: inside
# the compose network the frontend and API share nginx as one effective
# origin, exactly like the dev proxy does.
#
# Build from the repo root: `docker build -f apps/web/Dockerfile .`

FROM node:22-slim AS build
WORKDIR /app

# Whole repo, not just package.json files — see apps/api/Dockerfile for why
# (packages/shared's `prepare` script needs its source present at install
# time, not copied in after).
COPY . .
RUN npm ci

RUN npm run build -w @workos/shared
RUN npm run build -w @workos/web

# ── Runtime ──────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
