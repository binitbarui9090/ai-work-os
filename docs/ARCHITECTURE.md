# Architecture

Written for an engineer who has to change this code. It covers the shape of the
system, the data model, how the AI agent actually executes, and the decisions
that would be expensive to reverse — with the reasoning, so you can tell when a
constraint no longer applies.

---

## 1. Shape

```
                    ┌──────────────────────────────┐
                    │  apps/web   React 18 + Vite  │
                    │  CSS Modules, no UI library  │
                    └───────┬──────────────┬───────┘
                       REST │              │ WebSocket
                   (cookie session)        │
                    ┌───────▼──────────────▼───────┐
                    │  apps/api      Express       │
                    │                              │
                    │  middleware → module routes  │
                    │       → service → SQL        │
                    └──┬────────┬────────┬─────────┘
                       │        │        │
              ┌────────▼──┐ ┌───▼────┐ ┌─▼──────────┐
              │ Postgres  │ │ Redis  │ │ S3/MinIO   │
              │ +pgvector │ │ pubsub │ │ attachments│
              │ +pg_trgm  │ │ +BullMQ│ └────────────┘
              └───────────┘ └───┬────┘
                                │
                        ┌───────▼────────┐
                        │ BullMQ workers │
                        │ embeddings,    │
                        │ transcripts,   │
                        │ reports, email │
                        └───────┬────────┘
                                │
                   ┌────────────▼─────────────┐
                   │ LLM provider (pluggable) │
                   │ Anthropic | OpenAI-compat│
                   └──────────────────────────┘
```

`packages/shared` holds the Zod schemas and API types. The same schema object
validates a request on the server and a form in the browser, so a field cannot
drift between the two.

### Layering

Each domain module owns its routes, service and SQL:

```
modules/tasks/
  tasks.service.ts    business logic, SQL, events, audit
  tasks.routes.ts     HTTP: validate → call service → shape response
```

Routes never contain SQL; services never touch `req`/`res`. That boundary is
what lets the AI tools reuse the same services as the REST API — a tool calls
`createTask()` exactly as the endpoint does, so permission checks, activity
events, notifications and audit entries happen identically whether a human or
the agent is acting.

**No ORM.** SQL is written by hand against the `pg` driver. The schema uses
generated `tsvector` columns, partial unique indexes, lateral joins, recursive
CTEs and pgvector operators; an ORM would be a layer to fight rather than one
to lean on. Transactions use `AsyncLocalStorage`, so a service function joins an
ambient transaction without a `tx` parameter threaded through every signature,
and a nested `transaction()` becomes a savepoint rather than a second
connection.

---

## 2. Data model

33 tables. The ones worth knowing:

```
users ─┬─ sessions
       ├─ workspace_members ── workspaces ─┬─ invitations
       │        (role)                     │
       │                                   ├─ projects ─┬─ project_members
       │                                   │            ├─ milestones
       │                                   │            └─ tasks ─┬─ task_dependencies
       │                                   │                      ├─ task_labels
       │                                   │                      └─ (parent_task_id, self-ref)
       │                                   ├─ documents ── document_versions
       │                                   ├─ meetings ─┬─ transcript_segments
       │                                   │            └─ meeting_action_items ── tasks
       │                                   ├─ comments ── comment_mentions
       │                                   ├─ attachments
       │                                   ├─ ai_conversations ── ai_messages ── ai_actions
       │                                   ├─ embedding_chunks   (vector(1024), HNSW)
       │                                   ├─ index_state        (durable indexing queue)
       │                                   ├─ health_reports
       │                                   ├─ integrations ─┬─ integration_links
       │                                   │                └─ integration_events
       │                                   ├─ activity_events
       │                                   ├─ notifications
       │                                   └─ audit_logs
```

Every tenant-scoped table carries `workspace_id` directly, even where it could
be derived through a join. Tenant isolation then costs one predicate on the
table being queried rather than a join that a future refactor might drop.

### Invariants held by the database, not by application code

Anything the application could forget is enforced in the schema:

| Invariant | Mechanism |
| --- | --- |
| Exactly one owner per workspace | Partial unique index on `workspace_members (workspace_id) WHERE role = 'owner'` |
| One live invitation per email per workspace | Partial unique index `WHERE accepted_at IS NULL AND revoked_at IS NULL` |
| Gapless task numbers | `UPDATE projects SET task_counter = task_counter + 1 RETURNING` — the row lock serialises concurrent inserts |
| `completed_at` matches `status` | `BEFORE INSERT OR UPDATE` trigger, so every write path agrees |
| No duplicate dependency | Unique index on `(blocking_task_id, blocked_task_id, type)` |
| No self-dependency, no self-parent | `CHECK` constraints |
| Notification de-duplication | Partial unique index on `(user_id, dedupe_key)` |
| AI action executed at most once | `UNIQUE (idempotency_key)` plus a conditional `UPDATE` claim |

Task numbering deserves a note. The obvious implementation — `SELECT max(number)
+ 1` — produces duplicates under concurrency. Incrementing a counter on the
project row takes a row lock for the duration of the transaction, which
serialises exactly the inserts that need it. `tests/tasks.test.ts` fires eight
concurrent creations and asserts the numbers are `1..8`.

### Migrations

Forward-only SQL files in `src/db/migrations`, applied in one transaction each
and recorded with a checksum. Editing an applied migration is an error, not a
warning: replayability is the whole point. A `pg_advisory_lock` serialises two
API instances booting at once.

---

## 3. Tenancy and permissions

Four roles. `ROLE_RANK` in `packages/shared` makes "at least this role"
comparable.

| Role | Scope |
| --- | --- |
| `owner` | Everything, including deleting the workspace. Exactly one. Transferred, never assigned. |
| `admin` | Members, invitations, settings, integrations, audit log, archiving |
| `member` | Create and change projects, tasks, documents, meetings; approve AI actions |
| `guest` | Read-only, and **only projects they are explicitly added to** |

Enforcement is anchored in two places:

1. `middleware/workspace.ts` resolves the tenant from the `:workspaceId` param
   or the `x-workspace-id` header and proves membership before any handler runs.
   **A non-member gets the same 404 as a non-existent workspace** — a 403 would
   confirm another tenant's data exists.
2. `modules/workspaces/access.ts` turns the guest rule into a reusable
   predicate. `visibleProjectIds()` returns `null` for "no restriction" or an
   array of ids; callers add `project_id = ANY($n)`. Returning `null` rather
   than every id keeps the common case a no-op.

The AI agent inherits this rather than bypassing it: `ToolContext.userId` is
the human the agent is acting for, so a guest's agent sees a guest's data. When
an approved action finally executes, it runs as the **requester**, not the
approver — approving does not lend your permissions.

---

## 4. The AI agent

The design goal is a specific one: **the agent must never be able to report
something it did not do.** Three mechanisms get there.

### 4.1 Writes are proposals

```
user message
     │
     ▼
runAgent()  ──────────────────────────────────┐
     │  bounded loop, max 8 provider calls    │
     ▼                                        │
provider.generate({ system, messages, tools })│
     │                                        │
     ├─ no tool calls ──────────► answer ─────┘
     │
     ▼
for each tool call:
     │
     ├─ validate input against its Zod schema
     │    └─ invalid → error tool_result, agent retries
     │
     ├─ READ tool  → execute now, return data
     │
     └─ WRITE tool → ai_actions row (pending_approval)
                     tool_result reads:
                     "PROPOSAL RECORDED — NOTHING HAS BEEN
                      CHANGED YET. Waiting for <name> to approve…
                      Do not say it has been done."
```

The agent is told, in the tool result it reads, that nothing happened. It is not
asked to be honest about this; it is given no basis for the alternative. The
system prompt reinforces it, and `tests/ai-approval.test.ts` asserts the
wording reaches the model and that no task exists afterwards.

### 4.2 Execution is claimed, not assumed

```
POST /ai/actions/:id/decision { decision: "approve" }
     │
     ├─ UPDATE … SET status='approved' WHERE status='pending_approval'
     │   └─ 0 rows → 409 (someone else already decided)
     │
     ▼
executeApprovedAction()
     │
     ├─ UPDATE … SET executed_at=now()
     │      WHERE status='approved' AND executed_at IS NULL
     │      RETURNING tool, payload, requested_by
     │   └─ no row → already running or done, return current state
     │
     ├─ re-validate the stored payload against the tool schema
     ├─ run the tool as `requested_by`
     │
     └─ status = 'executed' (+ result)  |  'failed' (+ error)
```

The conditional `UPDATE` is the authority. A double-clicked button, a retried
request and a replayed job all converge on one effect — tested by firing two
concurrent approvals and asserting one 200, one 409, and exactly one task.

A failure is stored as `failed` with the provider's or service's actual message.
There is no path that writes `executed` without the tool having returned `ok`.

### 4.3 Analysis is deterministic; only prose is generated

This is the split that makes the "intelligence" trustworthy:

| Layer | Source | Example |
| --- | --- | --- |
| Findings | SQL | "Waiting on ATL-2", "11 days past its due date" |
| Severity | Rules | `overdue > 14 ∨ (overdue > 3 ∧ fanOut ≥ 2) → critical` |
| Narrative | Model | "The backfill is the critical path; everything downstream is idle." |

`detectBlockers()` is one query plus a scoring function. Blocker detection,
health metrics, duplicate pairs and next-action scores all work with no AI
provider at all — the model adds commentary on findings that already exist and
cannot introduce a finding of its own. Health reports record
`generatedBy: 'ai' | 'rules'` and the UI labels them accordingly.

### 4.4 Tool schemas

Tool inputs need a JSON Schema (for the provider) and a Zod schema (for runtime
validation). `ai/agent/json-schema.ts` derives the former from the latter, so
they cannot drift. Every generated schema sets `additionalProperties: false`.

This matters more than it looks: the Anthropic provider sets
`eager_input_streaming: true` so large tool inputs stream as they are generated
rather than arriving in one burst. With that on, **the server no longer
validates tool input** — a truncated response yields malformed JSON. Every
input is therefore parsed against its Zod schema before execution, and a failure
becomes an error `tool_result` the agent can recover from. `tests/ai-agent.test.ts`
covers that path.

### 4.5 Conversation replay

A follow-up question should reuse what was already retrieved. That requires
replaying history exactly: a `tool_result` must follow the `tool_use` it answers,
with the same id, or the provider rejects the request. `ai_messages.raw_turn`
stores the provider-shaped content blocks for each assistant turn, and
`trimDanglingToolUse()` drops a trailing turn whose tool calls have no results —
which is what an interrupted turn leaves behind.

### 4.6 Provider independence

`ai/providers/types.ts` defines the contract: `generate()` for a tool-calling
turn, `generateStructured()` for schema-constrained JSON. Two implementations
ship (Anthropic, OpenAI-compatible). Nothing above the provider layer knows
which is in use.

`getLlm()` returns `null` when nothing is configured, so callers must handle
absence explicitly — that is what keeps unconfigured deployments from showing
invented output. `requireLlm()` throws a message naming the variable to set.

The Anthropic provider streams every turn (`messages.stream()` +
`finalMessage()`), which keeps long tool inputs and long answers off the HTTP
timeout and lets assistant text reach the browser as it is produced. Structured
generation uses `messages.parse()` with `zodOutputFormat`. Refusals
(`stop_reason: "refusal"`) are surfaced with their category rather than treated
as an empty answer.

### 4.7 Planning

Brief → plan is `generateStructured()` against a strict schema, then
`normalisePlan()` — a pure function that makes the plan safe to apply:

- duplicate `ref`s are de-duplicated, so dependencies stay unambiguous;
- dependencies on refs that are not in the plan are dropped;
- **cycles are broken by construction.** Each edge is added only if the target
  does not already reach the source, so the result is a DAG whatever the model
  produced;
- tasks naming an undeclared milestone are detached rather than inventing one;
- unparseable dates become `null`.

`applyPlan()` is deterministic and transactional: the whole plan lands or none
of it does. It is tested directly, including a three-node cycle.

---

## 5. Realtime

```
service write
     │
     ├─ publish(workspaceId, { channels, event })
     │        │
     │        ├─ local hub      → sockets on this instance
     │        └─ Redis pub/sub  → other instances → their hubs
     ▼
WebSocket clients, filtered by channel subscription
```

Channels are `workspace`, `project:<id>`, `task:<id>`, `document:<id>`,
`user:<id>` and `ai:<conversationId>`. A client may subscribe to any
workspace-scoped channel, but **`user:` is refused unless it is their own** —
otherwise one member could listen to another's notifications. Tested.

Authentication reuses the session cookie on the upgrade request, so a socket
cannot outlive or outrank its HTTP session. Membership is checked before the
upgrade completes.

Without Redis, delivery falls back to the local hub: correct for a single
instance, and the degradation is logged rather than silent. The client
reconnects with exponential backoff plus jitter, re-subscribes to its channels,
and the topbar shows "Reconnecting" instead of going quietly stale.

---

## 6. Search and RAG

Two paths, fused:

```
query
  ├─ keyword   searchable_content view (tsvector, GIN) → ts_rank_cd
  └─ semantic  embed(query) → embedding_chunks <=> vector (HNSW cosine)
                              one row per entity (best chunk)
          │
          ▼
  reciprocal rank fusion, k=60
```

RRF rather than score blending, because `ts_rank` and cosine distance are not on
a comparable scale; rank is.

`SearchResponse.mode` reports which path actually ran (`semantic`, `keyword` or
`hybrid`) and `notice` carries the reason when semantic was wanted but
unavailable. The UI shows that text. Keyword search uses
`websearch_to_tsquery`, which accepts human query syntax without throwing on
punctuation — tested with `"???"` and `oauth & | !`.

### Indexing is durable

A lost Redis job must not leave content unsearchable, so `index_state` is the
source of truth and the queue is only an accelerator:

```
write → markForIndexing()  → index_state (pending) + enqueue
worker → indexEntity()     → content_hash unchanged? skip
                           → else embed, replace chunks, mark indexed
maintenance (every 10 min) → sweep anything still pending or failed
```

Unchanged content is never re-embedded, so a retried job costs nothing. The
`embedding` column is `vector(1024)`; both providers are asked for 1024
dimensions, and a provider returning a different width fails loudly with the
exact fix rather than writing unusable vectors.

---

## 7. Background jobs

Seven BullMQ queues: `embeddings`, `transcript`, `plan`, `health`, `email`,
`integration`, `maintenance`. Repeatable jobs handle due-date notifications
(hourly), session and OAuth-state cleanup (daily), the index sweep (10 min), and
weekly health reports for active workspaces (Monday 08:00).

Every handler is re-runnable. `enqueueEmbedding` uses the entity as the job id
so a burst of edits collapses into one indexing job; `enqueuePlan` sets
`attempts: 1`, because silently retrying an LLM call would double-charge and
confuse the operator.

With Redis unavailable, `enqueue()` runs the registered handler in-process,
detached. Not durable — and logged as degraded — but a developer without Redis
still gets working transcript processing and search indexing.

In production run the worker separately (`npm run dev:worker`,
`RUN_WORKERS_INLINE=false`) so a burst of indexing cannot starve the request
path.

---

## 8. Security

| Concern | Approach |
| --- | --- |
| Passwords | `scrypt` (N=16384, r=8, p=1) from Node's stdlib — memory-hard, no native build step. Parameters are stored with the hash so they can be raised later. |
| Sessions | Random 32-byte token in an httpOnly, SameSite=Lax cookie. Only the **hash** is stored, so a database leak yields no usable sessions. Rolling expiry, throttled to one write per 5 minutes. |
| Login timing | A wrong password, an unknown account and a deactivated account return the same message, and the scrypt verification runs even when no user was found. |
| Invitations | Random token, hashed at rest, **bound to the invited email** — a forwarded link does not grant access. Tested. |
| OAuth tokens | AES-256-GCM, key derived from `SESSION_SECRET` via HKDF. Decrypted only in memory for an outbound call. A rotated secret marks the integration as needing reconnection rather than failing opaquely. |
| Webhooks | `x-hub-signature-256` verified with `timingSafeEqual` against the **raw** body, retained only on that path. An unset secret rejects deliveries rather than accepting unverifiable writes. |
| Uploads | Presigned S3 PUT — credentials never reach the client and bytes never pass through the API. Content-type allowlist; filenames stripped of path components. An attachment is `uploaded_at` only after a `HeadObject` confirms it exists. |
| Rate limits | Redis fixed-window, with an in-process fallback that degrades rather than failing open. Sign-in is keyed by IP; AI endpoints get their own budget. |
| SQL injection | Parameterised queries throughout. The only interpolation is of identifiers from our own config (database name in the test bootstrap, savepoint names). |
| Error leakage | One error middleware. Production returns a generic 500 message plus a request id that ties to the log. |
| Audit | Append-only `audit_logs` across human, AI and system actors, with the request id. Admin-only read. |

---

## 9. Frontend

React 18 + Vite, CSS Modules, no UI framework. ~400 KB of JS before gzip
(~113 KB after) with the AI screens code-split.

**Design tokens.** `styles/tokens.css` defines colour, type, space, radius,
shadow and motion. Components reference semantic aliases (`--surface`,
`--text`, `--border`), so dark mode is a redefinition of aliases rather than a
parallel stylesheet. No component contains a hex value.

**Data loading.** `useAsync` aborts the in-flight request when its dependencies
change, so a slow earlier response cannot overwrite a newer one. `useMutation`
tracks pending and error state, which is what makes "Saving…" and inline errors
consistent across screens.

**Loading, empty and error states are components**, not ad-hoc markup.
`ErrorState` shows the server's own message, because the API is written to
return actionable ones — including `not_configured`, which tells the operator
what to set.

**Optimism where the outcome is predictable.** A board drag moves the card
immediately and reconciles with the server's response; a rejected move snaps
back and raises a toast, rather than leaving the UI lying about where the card
is.

---

## 10. Decisions and their reasoning

**No ORM.** The schema leans on Postgres features an ORM abstracts away. The
cost is hand-written SQL; the benefit is that generated columns, partial
indexes, recursive CTEs and pgvector operators are all directly available.

**404, not 403, across tenants.** A 403 confirms the resource exists. For a
multi-tenant product that is a real leak.

**Approval gate on by default.** `require_ai_approval` defaults to true. It can
be turned off, which is audited separately as
`workspace.ai_approval_disabled` — but even then every action is still recorded,
so the audit trail is identical and only the decision point differs.

**Deterministic analysis, generated prose.** A model asked to find blockers will
confidently produce plausible ones. SQL will not. Keeping the finding in SQL and
the explanation in the model is what makes the feature defensible.

**Fractional board ranks.** A drag rewrites one row rather than renumbering a
column, and the server computes the rank from neighbour ids — so two people
dragging at once converge instead of fighting. Ranks are renormalised when
neighbours get too close to avoid float exhaustion.

**`index_state` separate from the queue.** Redis is a cache; losing it must not
make content permanently unsearchable. The durable table plus a sweep is the
recovery path.

**Explicit degradation everywhere.** Each optional dependency has a named
disabled reason that reaches the UI verbatim. "Semantic search is off
(EMBEDDING_PROVIDER=disabled)" is more useful than quietly worse results, and
it is the difference between a product that is honest and one that is not.

---

## 11. Known limitations

- **Document editing is last-write-wins with conflict detection**, not
  operational transforms. Two people editing the same document get a 409 and a
  reload prompt. A CRDT would be the next step.
- **Calendar view groups by due date** rather than rendering a month grid,
  because a grid hides everything undated — which in practice is most of a
  backlog.
- **Embedding dimensions are fixed at 1024** by the column type. Changing model
  families needs a migration plus `npm run reindex`; the code fails loudly with
  that instruction rather than writing bad vectors.
- **The GitHub integration is one-directional.** It reads webhooks and comments
  on tasks; it does not create issues or push state back.
- **Google Calendar is read-only** by design (`*.readonly` scopes). Importing an
  event creates a meeting record; nothing is written to the calendar.
- **No frontend test suite.** The API has 127 tests; the web app is covered by
  TypeScript, a production build, and manual verification. Component tests
  would be the next addition.
- **Rate limits are per-instance when Redis is down**, so the effective limit
  multiplies by the instance count during a Redis outage.
