# AI Work OS

A team workspace — projects, tasks, documents, meetings — with an AI agent that
reads it before answering and asks before changing anything.

It is a working application, not a prototype: real Postgres persistence, real
session auth with role-based access control, real WebSocket collaboration,
background workers, and an agent whose every mutation goes through a human
approval gate recorded in an audit log.

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

You need **Node 20.10+** and **Docker**.

```bash
git clone <this repo> && cd "AI WORK OS"
cp .env.example .env
npm install
npm run setup     # starts Postgres + Redis + MinIO, migrates, seeds demo data
npm run dev       # API on :4000, web on :5173
```

Open <http://localhost:5173> and sign in as **`maya@northwind.test`** with
password **`demo-password-1`**. The sign-in page has a button that fills this in.

The seed creates a workspace with six members, three projects at different
stages, a real dependency graph (including deliberately blocked and overdue
work), documents, and a meeting with an unprocessed transcript. The guest
account `pat@contractor.test` can only see one project — useful for checking
that project-level permissions hold.

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
| `npm test` | 127 API tests against a real Postgres database |
| `npm run typecheck` | TypeScript across all three packages |
| `npm run build` | Production build |
| `npm run migrate` | Apply pending migrations |
| `npm run migrate:status` | Show migration state |
| `npm run seed -- --reset` | Recreate the demo workspace |
| `npm run reindex` | Rebuild the semantic index |
| `npm run infra:up` / `infra:down` | Docker services |
| `npm run infra:reset` | Wipe the volumes and start fresh |

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

## License

MIT
