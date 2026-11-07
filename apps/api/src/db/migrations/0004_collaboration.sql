-- ── Comments, mentions, attachments, documents, activity, notifications ─────

CREATE TABLE comments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type       text NOT NULL CHECK (entity_type IN ('task','document','meeting','project')),
  entity_id         uuid NOT NULL,
  -- Denormalised so project-scoped permission checks and feeds stay one query.
  project_id        uuid REFERENCES projects(id) ON DELETE CASCADE,
  body              text NOT NULL,
  author_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  author_is_ai      boolean NOT NULL DEFAULT false,
  parent_comment_id uuid REFERENCES comments(id) ON DELETE CASCADE,
  edited_at         timestamptz,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_entity_idx ON comments (entity_type, entity_id, created_at);
CREATE INDEX comments_workspace_idx ON comments (workspace_id, created_at DESC);
CREATE INDEX comments_search_idx ON comments
  USING GIN (to_tsvector('english', coalesce(body,'')));

CREATE TABLE comment_mentions (
  comment_id      uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX comment_mentions_user_idx ON comment_mentions (user_id);

CREATE TABLE attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type     text CHECK (entity_type IN ('task','document','meeting','project')),
  entity_id       uuid,
  filename        text NOT NULL,
  content_type    text NOT NULL,
  size_bytes      bigint NOT NULL,
  storage_key     text NOT NULL UNIQUE,
  -- Set once the client confirms the upload completed.
  uploaded_at     timestamptz,
  uploaded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_entity_idx ON attachments (entity_type, entity_id);
CREATE INDEX attachments_workspace_idx ON attachments (workspace_id);

CREATE TABLE documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id      uuid REFERENCES projects(id) ON DELETE SET NULL,
  parent_id       uuid REFERENCES documents(id) ON DELETE CASCADE,
  title           text NOT NULL,
  icon            text,
  -- Portable block array; see DocBlock in @workos/shared.
  content         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Flattened text kept in sync by the application, for FTS and AI context.
  plain_text      text NOT NULL DEFAULT '',
  version         integer NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_ai   boolean NOT NULL DEFAULT false,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  search_tsv      tsvector GENERATED ALWAYS AS (
                    setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
                    setweight(to_tsvector('english', coalesce(plain_text,'')), 'B')
                  ) STORED,
  CONSTRAINT documents_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX documents_workspace_idx ON documents (workspace_id, updated_at DESC);
CREATE INDEX documents_project_idx ON documents (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX documents_parent_idx ON documents (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX documents_search_idx ON documents USING GIN (search_tsv);
CREATE TRIGGER documents_updated_at BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE document_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version         integer NOT NULL,
  title           text NOT NULL,
  content         jsonb NOT NULL,
  plain_text      text NOT NULL DEFAULT '',
  author_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX document_versions_key ON document_versions (document_id, version);

CREATE TABLE activity_events (
  id              bigserial PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id      uuid REFERENCES projects(id) ON DELETE CASCADE,
  entity_type     text NOT NULL CHECK (entity_type IN ('task','document','meeting','project')),
  entity_id       uuid NOT NULL,
  action          text NOT NULL,
  summary         text NOT NULL,
  actor_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type      text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','ai','system')),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_workspace_idx ON activity_events (workspace_id, id DESC);
CREATE INDEX activity_project_idx ON activity_events (project_id, id DESC) WHERE project_id IS NOT NULL;
CREATE INDEX activity_entity_idx ON activity_events (entity_type, entity_id, id DESC);

CREATE TABLE notifications (
  id              bigserial PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            text NOT NULL,
  title           text NOT NULL,
  body            text,
  entity_type     text CHECK (entity_type IN ('task','document','meeting','project')),
  entity_id       uuid,
  url             text,
  actor_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Collapses repeat notifications (e.g. "due soon" re-checked every hour).
  dedupe_key      text,
  read_at         timestamptz,
  emailed_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX notifications_dedupe_key ON notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE TABLE audit_logs (
  id              bigserial PRIMARY KEY,
  workspace_id    uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_type      text NOT NULL CHECK (actor_type IN ('user','ai','system')),
  actor_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  action          text NOT NULL,
  entity_type     text,
  entity_id       uuid,
  request_id      text,
  ip              text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_workspace_idx ON audit_logs (workspace_id, id DESC);
CREATE INDEX audit_actor_idx ON audit_logs (actor_type, id DESC);
CREATE INDEX audit_action_idx ON audit_logs (action, id DESC);
