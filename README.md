# AI Work OS

A team workspace — projects, tasks, documents, meetings — with an AI agent that
reads it before answering and asks before changing anything.

It is a working application, not a prototype: real Postgres persistence, real
session auth with role-based access control, real WebSocket collaboration,
background workers, and an agent whose every mutation goes through a human
approval gate recorded in an audit log.

Open source under the [MIT license](LICENSE) — clone it, self-host it, change it.

**Live demo (frontend only):** <https://ai-work-os-nine.vercel.app>
This is the static web app with no backend behind it yet, so sign-in will show
a "could not reach the server" error — it's there to look at the UI, not to
use. For a fully working instance (sign-in, AI chat, realtime, everything),
run it yourself: one command, no account needed, see below.

---

## What it does

**Projects and tasks.** Kanban board with drag-and-drop, list and calendar
views, subtasks, milestones, labels, and dependencies with cycle detection.
Task references (`APOLLO-14`) are gapless per project and safe under concurrent
creation.

**AI project intelligence.**

| Feature | How it works |
| --- | --- |
| Brief → plan | A strict schema turns a messy brief into milestones, tasks, estimates and a dependency graph. Produces a *proposal*; nothing is written until approved. |
| Workspace chat | A bounded tool-use loop over your data. Cites what it read. Mutating tool calls become approval records, and the agent is told, truthfully, that nothing was applied. |
| Blocker detection | Entirely deterministic SQL — open dependencies, overdue work, stalled tasks, unowned work due soon. Every finding lists its reasons. The model only adds commentary. |
| Health reports | Metrics are SQL aggregates; risk is rule-based. The narrative is model-written and labelled `generatedBy: "ai"` vs `"rules"`, so a rules-only report is never passed off as AI. |
| Duplicate detection | pgvector cosine similarity when embeddings are configured, `pg_trgm` on titles otherwise. The method used is always reported. |
| Meeting intelligence | Transcript segmentation is deterministic parsing. Summary, decisions and action items need a model; action items are *suggestions* until a person converts them to tasks. |
| Semantic search | pgvector HNSW + Postgres full-text, fused with reciprocal rank. Reports which path actually ran. |

**Collaboration.** Live task, comment, document and presence updates over
WebSockets; `@mentions` resolved server-side; notifications with email
delivery; a workspace activity feed that labels AI actions.

**Security.** Workspace-scoped tenancy enforced in one middleware, four roles
(owner / admin / member / guest) with guests restricted to their own projects,
scrypt password hashing, hashed session tokens, AES-256-GCM encryption for
OAuth tokens at rest, HMAC-verified GitHub webhooks, and an append-only audit
log covering human, AI and system actors.

### What it does not do

Stated plainly, because the alternative is pretending:

- **No AI without credentials.** With no API key, chat, planning and transcript
  extraction are disabled and the UI says which variable to set. They do not
  degrade into canned responses.
- **Semantic search needs an embedding provider.** Without one, search falls
  back to full-text and says so in the response.
- **GitHub and Google Calendar need OAuth apps.** Unconfigured providers show
  the variables to set instead of a connect button that cannot work.
- **Merging a PR does not close a task.** The GitHub integration comments and
  moves a task to *in review*. Deciding work is finished stays with a person.
- **Document editing is last-write-wins with detection, not CRDT.** Concurrent
  saves are rejected with a 409 and the UI offers to reload, rather than
  silently overwriting.

---

## Running it

Two ways to run the whole thing on your own machine. Pick one — you don't
need both.

### Option A — one command, just Docker

The easiest path if you don't want Node installed at all: Docker builds and
runs the API, the background worker, the web app, Postgres, Redis and
S3-compatible storage together, as real containers, not a demo stub.

You need **Docker** (Docker Desktop on Mac/Windows, Docker Engine on Linux).

```bash
git clone https://github.com/binitbarui9090/ai-work-os.git
cd ai-work-os
npm run docker:up      # builds the images and starts everything (first run takes a few minutes)
```

Open <http://localhost:8090> and sign in as **`maya@northwind.test`** with
password **`demo-password-1`** — the sign-in page has a button that fills
this in. The demo data seeds itself automatically the first time the API
starts.

```bash
npm run docker:logs    # follow logs from every service
npm run docker:down    # stop everything
npm run docker:reset   # wipe the database/volumes and start fresh
```

This doesn't require `npm install` on your machine at all — everything
happens inside the containers. (The `npm run docker:*` commands are just
thin wrappers around `docker compose`, so if you don't have Node/npm either,
run the equivalent `docker compose --profile app up -d --build` directly.)

### Option B — local dev, with hot reload

Better if you're going to actually edit the code: both the API and the web
app rebuild on save instead of needing a container rebuild.

You need **Node 20.10+** and **Docker** (for Postgres/Redis/storage only).

```bash
git clone https://github.com/binitbarui9090/ai-work-os.git
cd ai-work-os
cp .env.example .env
npm install
npm run setup     # starts Postgres + Redis + storage, migrates, seeds demo data
npm run dev       # API on :4000, web on :5173
```

Open <http://localhost:5173> and sign in the same way as above.

### Either way

The seed creates a workspace with six members, three projects at different
stages, a real dependency graph (including deliberately blocked and overdue
work), documents, and a meeting with an unprocessed transcript. The guest
account `pat@contractor.test` can only see one project — useful for checking
that project-level permissions hold.

### How to use it, once you're in

- **Projects** (left sidebar) → pick one to see its **board**. Drag cards
  between columns, or switch to the list/calendar view from the tabs at the
  top.
- **New task** from the board's `+` button. Add subtasks, a milestone, labels
  and dependencies from the task's detail panel — try making two tasks depend
  on each other, the UI will refuse the cycle.
- **AI → Plan from a brief**, in the sidebar: paste a rough description of a
  project and it proposes milestones/tasks/estimates. Nothing is written
  until you review and approve it.
- **AI → Chat**: ask about the workspace in plain language ("what's blocked
  on the mobile launch?"). It cites what it read; any action it wants to take
  shows up as a pending approval instead of happening immediately.
- **Documents** and **Meetings** work the same way — meeting transcripts get
  summarized and turned into suggested action items, which you convert to
  real tasks yourself.
- Everything updates live for everyone else in the workspace — open the app
  in two browser windows signed in as different demo users to see it.
- AI features need an API key (see below) — without one the UI tells you
  which environment variable to set instead of silently doing nothing.

### Turning on AI

Everything above works without AI. To enable chat, planning and transcript
extraction, put an Anthropic API key in `.env` and restart:

```bash
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
LLM_MODEL=claude-opus-5-5
```

For semantic search, add an embedding provider and build the index:

```bash
EMBEDDING_PROVIDER=voyage     # or `openai`
VOYAGE_API_KEY=...
```

```bash
npm run reindex
```

`GET /api/health` reports exactly what is and is not configured.

### Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API and web, both watching |
| `npm run dev:worker` | Background workers as a separate process |
| `npm test` | 134 API tests against a real Postgres database |
| `npm run typecheck` | TypeScript across all three packages |
| `npm run build` | Production build |
| `npm run migrate` | Apply pending migrations |
| `npm run migrate:status` | Show migration state |
| `npm run seed -- --reset` | Recreate the demo workspace |
| `npm run reindex` | Rebuild the semantic index |
| `npm run infra:up` / `infra:down` | Postgres/Redis/storage only (for local dev) |
| `npm run infra:reset` | Wipe those volumes and start fresh |
| `npm run docker:up` / `docker:down` | The whole app, containerized (Option A above) |
| `npm run docker:reset` | Wipe the containerized stack's volumes and rebuild |
| `npm run docker:logs` | Follow logs from the containerized stack |

---

## How it is built

```
packages/shared     Zod schemas + API types, imported by both sides
apps/api            Express, Postgres, Redis, BullMQ, WebSockets
apps/web            React 18 + Vite, CSS Modules, no UI framework
```

The API is organised by domain module (`modules/tasks`, `modules/ai`, …), each
owning its service, routes and SQL. AI lives under `src/ai`: a
provider-independent LLM interface, the agent and its tools, RAG indexing, and
the deterministic analysers.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the data model, the
agent's execution path, and the reasoning behind the load-bearing decisions.
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** covers running it in production;
**[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)** covers the OAuth setup; and
**[docs/STATUS.md](docs/STATUS.md)** lists what is built, what is verified, and
what is deliberately not done.

### Testing

127 tests run against a real Postgres database — no mocked repositories, so the
SQL, the constraints and the triggers are all exercised:

```bash
npm test
```

The AI paths are tested with a scripted stub provider, which lets the suite
assert the properties that actually matter without spending tokens:

- a mutating tool call creates a pending action and writes nothing;
- the tool result tells the model, in words, that nothing was applied;
- approving executes exactly once, even when two approvals race;
- a failed execution is recorded as `failed` with the real error;
- with no provider configured, the API reports why instead of inventing output.

Tenancy and realtime get the same treatment: cross-workspace reads return 404
rather than 403, guest writes are refused, and a socket cannot receive another
workspace's events or another user's notifications.

---

## Deploying it for real

This app has a persistent WebSocket server and background workers, so it
doesn't fit a pure serverless platform end-to-end. The practical split:

**Frontend (`apps/web`) → Vercel.** This repo's [vercel.json](vercel.json)
already builds and deploys it (`npm run build -w @workos/shared && npm run
build -w @workos/web`, output `apps/web/dist`). If the frontend is on a
different origin than the API, set these two build-time environment
variables in the Vercel project settings before building:

```bash
VITE_API_BASE_URL=https://your-api.example.com
VITE_WS_BASE_URL=wss://your-api.example.com
```

**Backend (`apps/api` + worker) → Railway, Render, Fly.io, or any Docker
host.** Build [apps/api/Dockerfile](apps/api/Dockerfile) once, run it twice —
once as the API (`CMD ["node", "apps/api/dist/index.js"]`, the Dockerfile's
default) and once as the worker (override the command to `["node",
"apps/api/dist/worker.js"]`). Both need `DATABASE_URL` and `REDIS_URL`
pointing at real managed Postgres (with the `pgvector` and `pg_trgm`
extensions available) and Redis. Set `WEB_ORIGIN`/`API_BASE_URL` to wherever
the frontend actually lives, and if that's a different origin, also set
`COOKIE_SAME_SITE=none` and `COOKIE_SECURE=true` — the API refuses to start
in production with `SameSite=none` and an insecure cookie, since that
combination silently breaks sign-in over plain HTTP.

**Or skip the split entirely** and self-host the whole thing with
`npm run docker:up` (see Option A above) on any VM or server that can run
Docker — nginx fronts the web app and proxies `/api`/`/ws` to the API
container, so it's one origin and none of the cross-origin cookie setup
above is needed.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full walkthrough,
including a sample nginx config for same-origin hosting and the storage/CORS
setup for file uploads.

---

## License

MIT
