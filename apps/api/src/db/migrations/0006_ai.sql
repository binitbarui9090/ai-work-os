-- ── AI conversations, approval-gated actions, embeddings, health reports ────

CREATE TABLE ai_conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id      uuid REFERENCES projects(id) ON DELETE SET NULL,
  title           text NOT NULL DEFAULT 'New conversation',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_conversations_user_idx ON ai_conversations (workspace_id, user_id, updated_at DESC);
CREATE TRIGGER ai_conversations_updated_at BEFORE UPDATE ON ai_conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ai_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user','assistant','system')),
  content         text NOT NULL DEFAULT '',
  -- Sources the answer drew on, so claims are traceable.
  citations       jsonb NOT NULL DEFAULT '[]'::jsonb,
  tool_calls      jsonb NOT NULL DEFAULT '[]'::jsonb,
  input_tokens    integer,
  output_tokens   integer,
  model           text,
  -- Populated when the provider call failed; the UI shows it verbatim.
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_messages_conversation_idx ON ai_messages (conversation_id, created_at);

CREATE TABLE ai_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES ai_conversations(id) ON DELETE SET NULL,
  message_id      uuid REFERENCES ai_messages(id) ON DELETE SET NULL,
  tool            text NOT NULL,
  summary         text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending_approval'
                    CHECK (status IN ('pending_approval','approved','rejected','executed','failed')),
  requested_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  decision_note   text,
  -- What actually happened. Written only after execution returns.
  result          jsonb,
  error           text,
  -- Makes approve-execute retry-safe: a second execution is a no-op.
  idempotency_key text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  executed_at     timestamptz
);
CREATE INDEX ai_actions_workspace_idx ON ai_actions (workspace_id, created_at DESC);
CREATE INDEX ai_actions_pending_idx ON ai_actions (workspace_id)
  WHERE status = 'pending_approval';

ALTER TABLE tasks
  ADD CONSTRAINT tasks_ai_action_fk
  FOREIGN KEY (ai_action_id) REFERENCES ai_actions(id) ON DELETE SET NULL;

-- One row per chunk of indexable content. 1024 dimensions matches the default
-- embedding model; both supported providers can be asked for 1024 outputs.
-- Changing EMBEDDING_DIMENSIONS requires a migration that alters this column.
CREATE TABLE embedding_chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type     text NOT NULL CHECK (entity_type IN ('task','document','meeting','project')),
  entity_id       uuid NOT NULL,
  project_id      uuid REFERENCES projects(id) ON DELETE CASCADE,
  chunk_index     integer NOT NULL,
  title           text NOT NULL DEFAULT '',
  content         text NOT NULL,
  -- Hash of the source content; unchanged content is never re-embedded.
  content_hash    text NOT NULL,
  model           text NOT NULL,
  embedding       vector(1024) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX embedding_chunks_key
  ON embedding_chunks (entity_type, entity_id, chunk_index);
CREATE INDEX embedding_chunks_workspace_idx ON embedding_chunks (workspace_id);
-- HNSW over cosine distance. Built empty; pgvector fills it incrementally.
CREATE INDEX embedding_chunks_vector_idx ON embedding_chunks
  USING hnsw (embedding vector_cosine_ops);

-- Tracks what still needs embedding, independent of the queue, so a lost
-- Redis job never silently leaves content unsearchable.
CREATE TABLE index_state (
  entity_type     text NOT NULL CHECK (entity_type IN ('task','document','meeting','project')),
  entity_id       uuid NOT NULL,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_hash    text,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','indexed','failed','skipped')),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  queued_at       timestamptz NOT NULL DEFAULT now(),
  indexed_at      timestamptz,
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX index_state_pending_idx ON index_state (status, queued_at)
  WHERE status IN ('pending','failed');

CREATE TABLE health_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id      uuid REFERENCES projects(id) ON DELETE CASCADE,
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  risk_level      text NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
  -- Computed from the database, never from the model.
  metrics         jsonb NOT NULL,
  narrative       text,
  highlights      jsonb NOT NULL DEFAULT '[]'::jsonb,
  concerns        jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommendations jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 'rules' when no LLM was available; the UI labels it accordingly.
  generated_by    text NOT NULL DEFAULT 'rules' CHECK (generated_by IN ('ai','rules')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX health_reports_workspace_idx ON health_reports (workspace_id, created_at DESC);
CREATE INDEX health_reports_project_idx ON health_reports (project_id, created_at DESC)
  WHERE project_id IS NOT NULL;
