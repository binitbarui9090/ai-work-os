-- ── External integrations (OAuth connections, project links, webhooks) ──────

CREATE TABLE integrations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider            text NOT NULL CHECK (provider IN ('github','google_calendar')),
  status              text NOT NULL DEFAULT 'connected'
                        CHECK (status IN ('connected','disconnected','error')),
  account_label       text,
  -- AES-256-GCM ciphertext. Plaintext tokens never touch the database.
  access_token_enc    text,
  refresh_token_enc   text,
  token_expires_at    timestamptz,
  scopes              jsonb NOT NULL DEFAULT '[]'::jsonb,
  connected_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  connected_at        timestamptz NOT NULL DEFAULT now(),
  last_sync_at        timestamptz,
  last_error          text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX integrations_key ON integrations (workspace_id, provider);
CREATE TRIGGER integrations_updated_at BEFORE UPDATE ON integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE integration_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id  uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- e.g. "owner/repo" for GitHub, a calendar id for Google Calendar.
  external_ref    text NOT NULL,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX integration_links_key
  ON integration_links (integration_id, project_id, external_ref);
CREATE INDEX integration_links_ref_idx ON integration_links (external_ref);

-- Inbound webhook deliveries. The unique external id makes processing
-- idempotent when a provider retries a delivery.
CREATE TABLE integration_events (
  id              bigserial PRIMARY KEY,
  workspace_id    uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  external_id     text NOT NULL,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  processed_at    timestamptz,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX integration_events_key ON integration_events (provider, external_id);
CREATE INDEX integration_events_unprocessed_idx ON integration_events (created_at)
  WHERE processed_at IS NULL;

-- Short-lived CSRF state for the OAuth authorization code flow.
CREATE TABLE oauth_states (
  state           text PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  redirect_to     text,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_states_expiry_idx ON oauth_states (expires_at);
