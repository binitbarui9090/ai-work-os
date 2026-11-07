-- ── Meetings, transcripts, extracted action items ──────────────────────────

CREATE TABLE meetings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id          uuid REFERENCES projects(id) ON DELETE SET NULL,
  title               text NOT NULL,
  starts_at           timestamptz,
  duration_minutes    integer,
  notes               text,
  transcript_text     text,
  transcript_source   text,
  -- AI-derived fields. Null until a transcript has actually been processed.
  summary             text,
  decisions           jsonb NOT NULL DEFAULT '[]'::jsonb,
  risks               jsonb NOT NULL DEFAULT '[]'::jsonb,
  processing_status   text NOT NULL DEFAULT 'none'
                        CHECK (processing_status IN ('none','queued','processing','completed','failed')),
  processing_error    text,
  processed_at        timestamptz,
  external_participants jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  search_tsv          tsvector GENERATED ALWAYS AS (
                        setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
                        setweight(to_tsvector('english', coalesce(summary,'')), 'B') ||
                        setweight(to_tsvector('english', coalesce(notes,'')), 'C') ||
                        setweight(to_tsvector('english', left(coalesce(transcript_text,''), 500000)), 'D')
                      ) STORED
);
CREATE INDEX meetings_workspace_idx ON meetings (workspace_id, starts_at DESC NULLS LAST);
CREATE INDEX meetings_project_idx ON meetings (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX meetings_search_idx ON meetings USING GIN (search_tsv);
CREATE TRIGGER meetings_updated_at BEFORE UPDATE ON meetings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE meeting_participants (
  meeting_id      uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, user_id)
);
CREATE INDEX meeting_participants_user_idx ON meeting_participants (user_id);

CREATE TABLE transcript_segments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id      uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  idx             integer NOT NULL,
  speaker         text,
  start_seconds   numeric(10,2),
  text            text NOT NULL
);
CREATE UNIQUE INDEX transcript_segments_key ON transcript_segments (meeting_id, idx);

CREATE TABLE meeting_action_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_id            uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  text                  text NOT NULL,
  -- Speaker name as it appeared in the transcript; may not map to a user.
  owner_hint            text,
  suggested_assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  due_hint              text,
  -- Set only once the item has actually been turned into a task.
  task_id               uuid REFERENCES tasks(id) ON DELETE SET NULL,
  converted_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_action_items_meeting_idx ON meeting_action_items (meeting_id);
CREATE INDEX meeting_action_items_workspace_idx ON meeting_action_items (workspace_id)
  WHERE task_id IS NULL;
