-- Postgres cannot drop a single enum value; the type must be rebuilt with nothing
-- referencing it. Same destructive-down contract as 0003 (downs must ALWAYS run — CI-gated).
-- Improvement over 0003's down: local_ocr model ids are also stripped from policy
-- allowed_model_ids/fallback_chain arrays (plain uuid[] with no FK), so no dangling
-- references survive the rollback.
UPDATE usage_ledger SET provider_id = NULL
  WHERE provider_id IN (SELECT id FROM providers WHERE kind = 'local_ocr');
DELETE FROM policies
  WHERE default_model_id IN (SELECT id FROM models WHERE provider_kind = 'local_ocr');
UPDATE policies SET
  allowed_model_ids = COALESCE(
    (SELECT array_agg(x ORDER BY ord)
       FROM unnest(allowed_model_ids) WITH ORDINALITY AS t(x, ord)
      WHERE x NOT IN (SELECT id FROM models WHERE provider_kind = 'local_ocr')),
    '{}'::uuid[]),
  fallback_chain = COALESCE(
    (SELECT array_agg(x ORDER BY ord)
       FROM unnest(fallback_chain) WITH ORDINALITY AS t(x, ord)
      WHERE x NOT IN (SELECT id FROM models WHERE provider_kind = 'local_ocr')),
    '{}'::uuid[]);
DELETE FROM providers WHERE kind = 'local_ocr';
DELETE FROM models WHERE provider_kind = 'local_ocr';

ALTER TYPE provider_kind RENAME TO provider_kind_old;
CREATE TYPE provider_kind AS ENUM ('openai_compat', 'anthropic', 'local', 'digitalocean');
ALTER TABLE providers ALTER COLUMN kind TYPE provider_kind USING kind::text::provider_kind;
ALTER TABLE models ALTER COLUMN provider_kind TYPE provider_kind USING provider_kind::text::provider_kind;
DROP TYPE provider_kind_old;
