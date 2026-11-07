# Status

What is built, what is verified, and what is not done. Checked against a
running instance, not against intent.

Last verified: all 127 API tests passing, full typecheck clean, production
build boots and serves.

---

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | Clean across `shared`, `api`, `web` |
| `npm test` | **127 passed**, 8 files, against a real Postgres database |
| `npm run build` | API, worker and web all build; migrations copied into `dist` |
| `node apps/api/dist/index.js` | Boots in production mode, migrates, serves, authenticates |
| `npm run dev` | API :4000 and web :5173, Vite proxying `/api` and `/ws` |
| `npm run seed -- --reset` | Recreates the demo workspace |
| WebSocket end-to-end | 12 tests: handshake, auth refusal, fan-out, tenant isolation |
| `npm run audit:contrast` | No failures: every text-on-surface pair in both themes |

---

## The original quality bar

The questions this was meant to answer, each with how it was checked.

| Question | Answer | Evidence |
| --- | --- | --- |
| Can users register and log in? | Yes | `tests/auth.test.ts` — 8 tests incl. duplicate email, weak password, identical failure messages, logout, password change ending other sessions |
| Can users create workspaces? | Yes | At signup or afterwards; slug collisions resolved |
| Can they invite and manage members? | Yes | Invitations bound to the invited email, revocable, with role changes and ownership transfer. `tests/tenancy.test.ts` |
| Can they create and manage projects? | Yes | CRUD, archive, members, milestones, board/list/calendar |
| Do tasks and dependencies persist? | Yes | `tests/tasks.test.ts` — 20 tests incl. gapless numbering under 8 concurrent creates, cycle rejection (direct and transitive), reload assertions |
| Does real-time collaboration work? | Yes | `tests/realtime.test.ts` — real HTTP server + sockets, verified fan-out and isolation |
| Can AI understand workspace information? | Yes | Tool-use loop over real services, with citations. `tests/ai-agent.test.ts` |
| Can AI generate project plans? | Yes | Strict-schema planner; `applyPlan` creates project, milestones, tasks, dependency graph. `tests/planner.test.ts` |
| Can AI detect blockers? | Yes | Deterministic SQL; works with no AI configured at all |
| Are AI actions approval-gated? | Yes | 13 tests in `tests/ai-approval.test.ts`, incl. racing approvals executing once |
| Are tenant permissions enforced? | Yes | Cross-workspace reads return 404 not 403; guest writes refused; sockets isolated |
| Do important workflows have tests? | Yes | 127 tests, no mocked repositories |
| Can another developer install and run it? | Yes | `npm run setup && npm run dev`, verified from a clean `node_modules` |

---

## Built

### Workspace and identity
- [x] Multi-tenant workspaces; switching; one owner enforced by a partial unique index
- [x] Four roles with guests scoped to their own projects
- [x] Email-bound invitations, hashed at rest, revocable; link always returned to the inviter
- [x] Session auth: scrypt passwords, hashed rolling session tokens, httpOnly cookie
- [x] Ownership transfer; member removal unassigns open work rather than deleting it
- [x] Profile, theme (light/dark/system, persisted server-side), password change

### Projects and tasks
- [x] Projects with keys, status, colour, lead, dates, members, milestones
- [x] Kanban board with drag-and-drop and fractional ranks
- [x] List view with grouping; calendar view grouped by due date
- [x] Tasks: status, priority, assignee, dates, estimate, labels, subtasks
- [x] Dependencies with cycle detection; `isBlocked` derived, not stored
- [x] Gapless per-project task references (`APOLLO-14`)
- [x] Live project rollups (progress, overdue, blocked) computed in SQL
- [x] Unblock notifications when the last blocker completes

### Collaboration
- [x] Comments on tasks, documents, meetings and projects
- [x] `@mentions` re-resolved server-side; client-supplied ids verified as members
- [x] Notifications with de-duplication and optional email
- [x] Activity feed labelling AI actions
- [x] Presence and typing indicators
- [x] WebSockets with Redis fan-out, backoff reconnect, visible connection state

### Knowledge
- [x] Block editor: headings, lists, todos, code, quotes, dividers
- [x] Versioned on every save; version history
- [x] Optimistic concurrency — a stale save is a 409, not an overwrite
- [x] Markdown import/export; `markdownToBlocks` used by the AI document tool
- [x] Search across tasks, documents, meetings and projects

### Meetings
- [x] Meeting records with participants and external attendees
- [x] Deterministic transcript segmentation (4 recognised formats, continuation lines)
- [x] AI summary, decisions, risks, action items
- [x] Action items are suggestions until a person converts them; conversion is idempotent
- [x] Owner names matched to members only when unambiguous

### AI
- [x] Provider-independent interface; Anthropic and OpenAI-compatible implementations
- [x] Agent: bounded loop, 13 tools, citations, streamed text
- [x] Every mutation approval-gated, with editable payloads and exactly-once execution
- [x] Brief → plan with cycle-free normalisation and transactional application
- [x] Deterministic blockers, health metrics, duplicates, next-action scoring
- [x] Health reports labelled `ai` or `rules`
- [x] RAG: pgvector HNSW + full-text, RRF fusion, durable `index_state`
- [x] Honest degradation everywhere, with the variable to set named in the UI

### Integrations
- [x] GitHub: OAuth, repo listing, project links, HMAC-verified webhooks, PR/commit → task comment, PR open → in review
- [x] Google Calendar: OAuth with refresh, calendar and event listing, event → meeting import with attendee matching
- [x] OAuth tokens encrypted with AES-256-GCM; single-use state rows
- [x] Email via SMTP, with a `console` provider that says it did not send

### Data visualisation
- [x] Validated chart palette: computed against CVD, lightness, chroma and contrast checks in both themes
- [x] Task-stage distribution as a thin segmented bar (ordinal ramp + reserved status colour for blocked)
- [x] Throughput chart: created vs completed per day, two series on one axis
- [x] Stat tiles with deltas and sparklines, proportional figures
- [x] Every chart has a table view, a legend, and an accessible name
- [x] Contrast audit over the design tokens, gating the build

### Platform
- [x] 33 tables, 9 forward-only checksummed migrations
- [x] 7 BullMQ queues plus repeatable maintenance; in-process fallback without Redis
- [x] Redis rate limiting with a local fallback that does not fail open
- [x] Presigned S3 uploads with confirmation against `HeadObject`
- [x] Audit log across human, AI and system actors
- [x] `/api/health` reporting every dependency
- [x] Centralised error handling with request-id correlation
- [x] Seed data exercising every feature, including deliberately broken states
- [x] Content-shaped loading skeletons; refetch dims the previous render rather than flashing
- [x] Board drag-and-drop with a real insertion indicator, plus inline task capture

---

## Not done

Honest list. Nothing here is hidden behind a stub that pretends otherwise.

**Collaborative document editing is conflict-detecting, not conflict-free.**
Two people editing the same document get a 409 and a reload prompt. A CRDT or
OT layer is the real answer; this is the correct interim behaviour rather than
silent data loss.

**No frontend test suite.** The API has 127 tests. The web app is covered by
TypeScript, a production build, and per-module transform checks. Component and
end-to-end tests are the obvious next addition.

**Embedding dimensions are fixed at 1024** by the column type. Switching model
families needs a migration plus `npm run reindex`. The code fails loudly with
that instruction rather than writing unusable vectors.

**GitHub is one-directional.** Webhooks in, comments out. No issue creation, no
pushing task state back.

**Google Calendar is read-only** by design — `*.readonly` scopes, nothing
written back.

**Calendar view groups by date rather than rendering a month grid**, because a
grid hides undated work, which is most of a backlog.

**Rate limits are per-instance during a Redis outage**, so the effective limit
multiplies by the instance count until it returns.

**No file preview.** Attachments download; images are not rendered inline.

**Notifications are in-app and email only.** No push, no Slack.

---

## If I continued

In the order I would actually do it:

1. **Frontend tests.** The largest coverage gap. Component tests for the board,
   the approval card and the editor; Playwright for sign-in → plan → approve.
2. **Document CRDT.** The one place the product's concurrency story is weaker
   than the rest of it.
3. **Streaming the agent loop's tool phase.** Text streams today, but tool calls
   appear only when the turn completes. Showing "searching…" live would make a
   multi-step answer feel much faster.
4. **Per-workspace AI budgets.** Rate limits bound requests, not spend. Token
   accounting per workspace with a configurable ceiling.
5. **Saved views and filters.** Users will want "my overdue work in Atlas" as a
   bookmark, not a filter they reconstruct.
6. **Richer GitHub two-way sync**, behind explicit per-project opt-in.
