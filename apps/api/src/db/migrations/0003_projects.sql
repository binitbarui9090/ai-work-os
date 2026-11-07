-- ── Projects, milestones, labels, tasks, dependencies ──────────────────────

CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key             text NOT NULL,
  name            text NOT NULL,
  description     text,
  status          text NOT NULL DEFAULT 'planning'
                    CHECK (status IN ('planning','active','paused','completed','archived')),
  color           text NOT NULL DEFAULT '#6366f1',
  start_date      date,
  target_date     date,
  lead_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_ai   boolean NOT NULL DEFAULT false,
  -- Monotonic per-project counter behind task references like APOLLO-14.
  task_counter    integer NOT NULL DEFAULT 0,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX projects_key_key ON projects (workspace_id, upper(key));
CREATE INDEX projects_workspace_idx ON projects (workspace_id, status);
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE project_members (
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('lead','contributor','viewer')),
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_idx ON project_members (user_id);

CREATE TABLE milestones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  due_date        date,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX milestones_project_idx ON milestones (project_id);
CREATE TRIGGER milestones_updated_at BEFORE UPDATE ON milestones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE labels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            text NOT NULL,
  color           text NOT NULL DEFAULT '#64748b',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX labels_name_key ON labels (workspace_id, lower(name));

CREATE TABLE tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number            integer NOT NULL,
  title             text NOT NULL,
  description       text,
  status            text NOT NULL DEFAULT 'todo'
                      CHECK (status IN ('backlog','todo','in_progress','in_review','blocked','done','canceled')),
  priority          text NOT NULL DEFAULT 'none'
                      CHECK (priority IN ('none','low','medium','high','urgent')),
  -- Fractional rank inside a status column, so a drag only rewrites one row.
  position          double precision NOT NULL DEFAULT 0,
  assignee_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  parent_task_id    uuid REFERENCES tasks(id) ON DELETE CASCADE,
  milestone_id      uuid REFERENCES milestones(id) ON DELETE SET NULL,
  due_date          date,
  start_date        date,
  estimate_hours    numeric(8,2),
  completed_at      timestamptz,
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  created_by_ai     boolean NOT NULL DEFAULT false,
  ai_action_id      uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  search_tsv        tsvector GENERATED ALWAYS AS (
                      setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
                      setweight(to_tsvector('english', coalesce(description,'')), 'B')
                    ) STORED,
  CONSTRAINT tasks_no_self_parent CHECK (parent_task_id IS NULL OR parent_task_id <> id)
);
CREATE UNIQUE INDEX tasks_project_number_key ON tasks (project_id, number);
CREATE INDEX tasks_workspace_idx ON tasks (workspace_id);
CREATE INDEX tasks_project_status_idx ON tasks (project_id, status, position);
CREATE INDEX tasks_assignee_idx ON tasks (assignee_id, status) WHERE assignee_id IS NOT NULL;
CREATE INDEX tasks_due_idx ON tasks (workspace_id, due_date) WHERE due_date IS NOT NULL;
CREATE INDEX tasks_parent_idx ON tasks (parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX tasks_milestone_idx ON tasks (milestone_id) WHERE milestone_id IS NOT NULL;
CREATE INDEX tasks_search_idx ON tasks USING GIN (search_tsv);
CREATE INDEX tasks_title_trgm_idx ON tasks USING GIN (title gin_trgm_ops);
CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Keeps completed_at / status_changed_at consistent with status in one place,
-- so every write path (REST, AI tools, jobs, seeds) behaves the same.
CREATE OR REPLACE FUNCTION tasks_status_timestamps() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'done' AND NEW.completed_at IS NULL THEN
      NEW.completed_at = now();
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status <> OLD.status THEN
    NEW.status_changed_at = now();
    IF NEW.status = 'done' THEN
      NEW.completed_at = coalesce(NEW.completed_at, now());
    ELSE
      NEW.completed_at = NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER tasks_status_timestamps_trg BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_status_timestamps();

CREATE TABLE task_labels (
  task_id         uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id        uuid NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);
CREATE INDEX task_labels_label_idx ON task_labels (label_id);

CREATE TABLE task_dependencies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- blocking_task must reach a terminal status before blocked_task can proceed.
  blocking_task_id  uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_task_id   uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type              text NOT NULL DEFAULT 'blocks'
                      CHECK (type IN ('blocks','relates_to','duplicates')),
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_ai     boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_dependencies_distinct CHECK (blocking_task_id <> blocked_task_id)
);
CREATE UNIQUE INDEX task_dependencies_key
  ON task_dependencies (blocking_task_id, blocked_task_id, type);
CREATE INDEX task_dependencies_blocked_idx ON task_dependencies (blocked_task_id);
CREATE INDEX task_dependencies_workspace_idx ON task_dependencies (workspace_id);
