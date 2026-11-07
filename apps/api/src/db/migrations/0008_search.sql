-- ── Cross-entity keyword search ────────────────────────────────────────────
-- One view over every searchable entity so the keyword path is a single query
-- and stays consistent with the semantic path's result shape.

CREATE VIEW searchable_content AS
  SELECT
    'task'::text          AS entity_type,
    t.id                  AS entity_id,
    t.workspace_id,
    t.project_id,
    t.project_id          AS scope_project_id,
    (p.key || '-' || t.number || ' ' || t.title) AS title,
    coalesce(t.description, '')                  AS body,
    t.search_tsv,
    t.updated_at
  FROM tasks t
  JOIN projects p ON p.id = t.project_id

  UNION ALL
  SELECT
    'document'::text,
    d.id,
    d.workspace_id,
    d.project_id,
    d.project_id,
    d.title,
    d.plain_text,
    d.search_tsv,
    d.updated_at
  FROM documents d
  WHERE d.archived_at IS NULL

  UNION ALL
  SELECT
    'meeting'::text,
    m.id,
    m.workspace_id,
    m.project_id,
    m.project_id,
    m.title,
    concat_ws(E'\n', m.summary, m.notes, left(coalesce(m.transcript_text, ''), 20000)),
    m.search_tsv,
    m.updated_at
  FROM meetings m

  UNION ALL
  SELECT
    'project'::text,
    p.id,
    p.workspace_id,
    p.id,
    p.id,
    p.name,
    coalesce(p.description, ''),
    setweight(to_tsvector('english', coalesce(p.name, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(p.description, '')), 'B'),
    p.updated_at
  FROM projects p
  WHERE p.archived_at IS NULL;
