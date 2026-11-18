# Deployment

How to run AI Work OS somewhere real. Written assuming you have deployed a
Node + Postgres application before.

---

## What you need

| Dependency | Required | Notes |
| --- | --- | --- |
| Node 20.10+ | Yes | Runtime for API, worker and the web build |
| Postgres 14+ with `pgvector` and `pg_trgm` | Yes | Managed Postgres is fine if it allows these extensions |
| Redis 6+ | Strongly recommended | Without it: job queues, cross-instance realtime and shared rate limits degrade |
| S3-compatible storage | Optional | Needed only for file attachments |
| SMTP | Optional | Invitations still work — the link is returned to the inviter |
| Anthropic (or OpenAI-compatible) API key | Optional | Chat, planning and transcript extraction |
| Voyage or OpenAI embeddings | Optional | Semantic search; falls back to full-text |

`pgvector` is the one extension that is not universally available. AWS RDS,
Google Cloud SQL, Azure Database, Neon, Supabase and Render all support it;
check before committing to a provider.

---

## 1. Build

```bash
npm ci
npm run build
```

Produces `packages/shared/dist`, `apps/api/dist` and `apps/web/dist`.

Migrations are `.sql` files read at runtime. `apps/api/src/db/migrator.ts`
resolves them from `dist/db/migrations` **or** `src/db/migrations`, so either
copy them into the build or ship `src` alongside `dist`:

```bash
cp -r apps/api/src/db/migrations apps/api/dist/db/migrations
```

`npm run migrate:status` verifies the runtime can see them.

---

## 2. Configure

Copy `.env.example` and set, at minimum:

```bash
NODE_ENV=production
PORT=4000
WEB_ORIGIN=https://app.example.com      # exact origin of the web app
API_BASE_URL=https://api.example.com    # used in OAuth redirect URIs and emails

SESSION_SECRET=<64 hex chars>
COOKIE_SECURE=true                      # required when serving over HTTPS

DATABASE_URL=postgres://user:pass@host:5432/workos
REDIS_URL=redis://host:6379

RUN_WORKERS_INLINE=false                # run the worker as its own process
```

Generate the secret properly:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Things that will bite you

**`SESSION_SECRET` is load-bearing beyond sessions.** The OAuth-token
encryption key is derived from it. Rotating it signs everyone out *and*
invalidates stored integration tokens — integrations will report that they need
reconnecting. That is the correct behaviour for a leaked secret, but do not
rotate it casually.

**`WEB_ORIGIN` must match exactly.** CORS compares it literally. A trailing
slash or `http` vs `https` mismatch produces blocked requests with a CORS error
in the browser console and nothing in the server log.

**Cookies are `SameSite=Lax` and first-party.** Serving the web app and API on
different registrable domains will not work as-is — the session cookie will not
be sent. Put them on the same domain (recommended: reverse-proxy `/api` and
`/ws` from the web origin) or switch to `SameSite=None` and accept the CSRF
implications.

**`trust proxy` is set to 1.** Correct behind exactly one proxy. Behind two
(CDN → load balancer), raise it, or client IPs will be wrong and the
IP-keyed sign-in limiter will bucket everyone together.

---

## 3. Run

Three processes.

### API

```bash
node apps/api/dist/index.js
```

Applies pending migrations before accepting traffic, so a deploy never serves
requests against an unexpected schema. On a Postgres connection failure it exits
with a one-line fix rather than a stack trace.

Stateless apart from WebSocket connections — scale horizontally. Realtime
fan-out goes through Redis pub/sub, so a client connected to instance A receives
events published by instance B.

### Worker

```bash
node apps/api/dist/worker.js
```

Requires Redis and refuses to start if migrations are pending. One is enough to
begin with; it processes embeddings, transcripts, health reports, emails and
webhook deliveries. Scale up if the `embeddings` queue backs up after a bulk
import.

Repeatable jobs are installed idempotently by whichever process starts first, so
running several workers does not duplicate the schedule.

### Web

`apps/web/dist` is static files. Serve them from a CDN, nginx, or any static
host, with a catch-all rewrite to `index.html` for client-side routing.

nginx, with the API on the same origin (the simplest correct setup):

```nginx
server {
  listen 443 ssl http2;
  server_name app.example.com;

  root /srv/workos/web;
  index index.html;

  # SPA routing
  location / {
    try_files $uri $uri/ /index.html;
  }

  location /api/ {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # WebSockets need the upgrade headers and a long read timeout
  location /ws {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
  }
}
```

With that layout, set `WEB_ORIGIN=https://app.example.com` and
`API_BASE_URL=https://app.example.com`.

> If your proxy's default read timeout is 60s it will cut WebSocket connections
> every minute. The client reconnects, so it looks like flakiness rather than
> misconfiguration. Set `proxy_read_timeout` explicitly.

---

## 4. Docker

The real, tested Dockerfiles live in the repo: [apps/api/Dockerfile](../apps/api/Dockerfile)
(also used for the worker — same image, `CMD ["node", "apps/api/dist/worker.js"]`)
and [apps/web/Dockerfile](../apps/web/Dockerfile). Both copy the whole repo
into the build stage before `npm ci`, because `packages/shared` has a
`prepare` script that compiles it on install, and that needs its source
present — copying only `package.json` files first breaks it. The runtime
stage sets `NODE_ENV=production` **after** `npm ci`, not before: npm treats
that env var as an implicit `--omit=dev` the moment it's present, and
`prepare` needs `tsc` (a devDependency) to run.

Rather than hand-rolling these, `npm run docker:up` builds and runs the real
images directly via `docker compose --profile app up -d --build` — this is
the same one-command self-host path described in the
[README](../README.md#self-host-the-whole-stack-with-one-command).

The included `docker-compose.yml`'s base services (Postgres, Redis,
S3-compatible storage) are tuned for **local development** — non-default
ports (55432, 56379, 59000) and no real credentials. For a real deployment,
either run the `app` profile's `api`/`worker`/`web` services with production
secrets injected via `.env`, or deploy the images to a host like
Railway/Render (see below) and point them at managed Postgres/Redis instead.

---

## 5. Storage

For attachments, create a bucket and set:

```bash
STORAGE_PROVIDER=s3
S3_ENDPOINT=                     # leave blank for AWS; set for MinIO/R2/Spaces/etc.
S3_REGION=eu-west-1
S3_BUCKET=workos-uploads
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=false        # true for MinIO or most self-hosted S3-compatible servers
```

The browser uploads directly with a presigned PUT, so the bucket needs CORS for
your web origin:

```json
[
  {
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3000
  }
]
```

Keep the bucket private. Downloads go through short-lived presigned GETs issued
after a membership check.

With storage unconfigured, the attachment UI explains what to set instead of
offering a button that fails.

---

## 6. AI configuration

```bash
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
LLM_MODEL=claude-opus-5-5
LLM_EFFORT=medium            # low | medium | high | xhigh | max
LLM_MAX_TOKENS=16000
```

`LLM_EFFORT` is the main cost/quality dial. `medium` is a reasonable default for
chat; planning requests `high` explicitly because sequencing a project benefits
from it. Blocker commentary uses `low` — it is one sentence per finding.

For an OpenAI-compatible endpoint (OpenAI, Azure, vLLM, OpenRouter, Ollama):

```bash
LLM_PROVIDER=openai-compatible
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=...
LLM_MODEL=gpt-4.1
```

### Embeddings

```bash
EMBEDDING_PROVIDER=voyage
VOYAGE_API_KEY=...
EMBEDDING_MODEL=voyage-3.5
```

Then build the index once:

```bash
node apps/api/dist/scripts/reindex.js        # or: npm run reindex
```

The `embedding_chunks.embedding` column is `vector(1024)` and both providers are
asked for 1024 dimensions. A model that cannot produce 1024 fails with the exact
remedy — add a migration altering the column, then reindex.

### Cost control

- AI endpoints have their own rate limit (20/minute/user) separate from the
  general write limit.
- Unchanged content is never re-embedded; `content_hash` gates it.
- The system prompt is marked for prompt caching, which matters in multi-turn
  agent loops.
- Plan jobs do not auto-retry (`attempts: 1`) — a retry would double-charge.
- Weekly health reports only run for workspaces with activity in the last 14
  days.
- Turning AI off per workspace (**Settings → Workspace**) stops all model calls
  for that tenant while leaving the deterministic insights working.

---

## 7. Monitoring

`GET /api/health` returns 200 when Postgres is reachable and 503 when it is
not. Everything else is reported as degraded rather than failing the check,
because the application genuinely still works without it:

```json
{
  "status": "ok",
  "websocketConnections": 12,
  "checks": {
    "database":   { "ok": true },
    "redis":      { "ok": true },
    "llm":        { "ok": true, "detail": "anthropic/claude-opus-5-5" },
    "embeddings": { "ok": false, "detail": "not configured — search falls back to full text" },
    "storage":    { "ok": true }
  }
}
```

Point your load balancer at it. Alert on `status != "ok"`; treat
`checks.redis.ok === false` as a warning worth paging on in business hours,
since job processing stops being durable.

Logs are JSON (pino) with `requestId` on every line. The same id is returned in
the `x-request-id` response header and recorded in `audit_logs`, so a user
report maps to a request, its logs and its audit entries. Cookies,
authorization headers, passwords and tokens are redacted by the logger
configuration.

Queries over 500 ms are logged with a squashed SQL fragment.

---

## 8. Backup and recovery

Postgres holds everything that matters. Nothing else is a source of truth:

| Store | Contains | On loss |
| --- | --- | --- |
| Postgres | All application data | Total loss — back this up |
| Redis | Queues, rate limits, presence | Degraded until jobs re-enqueue; the index sweep recovers pending work |
| S3 | Attachment bytes | Attachments break; database rows remain |

```bash
pg_dump --format=custom --no-owner "$DATABASE_URL" > workos-$(date +%F).dump
```

`embedding_chunks` is derived data and the largest table. Excluding it from
backups is reasonable if you can afford to run `reindex` afterwards (which costs
embedding API calls):

```bash
pg_dump --format=custom --exclude-table-data=embedding_chunks "$DATABASE_URL" > workos.dump
```

To restore:

```bash
pg_restore --dbname="$DATABASE_URL" --no-owner --clean workos.dump
node apps/api/dist/index.js      # applies any newer migrations
npm run reindex                  # only if you excluded embeddings
```

---

## 9. Upgrading

```bash
git pull && npm ci && npm run build
# restart API — it migrates on boot
# restart worker
```

Migrations are forward-only and applied inside a transaction each. There is no
automated rollback: to revert a schema change, write a new migration. Take a
dump before a deploy that includes migrations.

A `pg_advisory_lock` serialises concurrent migrators, so a rolling restart of
several API instances is safe.

Zero-downtime deploys need the usual discipline — make a migration compatible
with both the old and new code (add a nullable column, deploy, backfill, then
tighten in a later migration) rather than renaming a column in place.

---

## 10. Troubleshooting

**`Could not reach Postgres at …`** — the API refuses to start without the
database. Check `DATABASE_URL` and that the extensions can be created; the first
migration runs `CREATE EXTENSION IF NOT EXISTS vector`, which needs the
extension available and sufficient privileges.

**`redis unavailable` on every request** — Redis is down. The app keeps working
with in-process fallbacks. If `RUN_WORKERS_INLINE=false`, background jobs are
not running at all until it returns.

**WebSocket connects then drops every ~60s** — proxy read timeout. See the
nginx note above.

**CORS errors in the browser** — `WEB_ORIGIN` does not exactly match the origin
serving the app.

**"Your session has expired" immediately after signing in** — `COOKIE_SECURE=true`
while serving over plain HTTP, so the browser discards the cookie.

**AI features show a configuration message** — working as intended. `/api/health`
names the missing variable.

**Semantic search returns nothing after configuring embeddings** — the index is
built asynchronously. Check **Settings → AI & search** for indexed/pending
counts, or run `npm run reindex` to do it synchronously with per-entity errors.

**Migration checksum error** — an applied migration file was edited. Restore the
original and add a new migration instead; replayability is the point.
