-- Extensions used across the schema.
--   pgcrypto : gen_random_uuid()
--   pg_trgm  : trigram similarity for fuzzy/duplicate detection
--   vector   : pgvector, semantic search embeddings
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- Keeps updated_at honest without application code having to remember.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
