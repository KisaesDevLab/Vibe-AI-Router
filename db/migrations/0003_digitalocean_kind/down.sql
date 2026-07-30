-- Postgres cannot drop a single enum value; the type must be rebuilt, which requires that
-- nothing references the value. Rolling back the migration that introduced the kind
-- necessarily removes everything of that kind (same contract as 0001's down, which drops
-- the schema outright — downs in this repo are destructive and must ALWAYS run, because
-- reversibility is CI-gated and test resets run `migrate down` to zero).
--
-- Removed: digitalocean provider rows (provider_credentials cascade), digitalocean model
-- rows (model_pricing history cascades), and policies whose default model is one of those
-- rows. Kept: ledger/audit history (usage_ledger.provider_id is nulled; models there are text).
UPDATE usage_ledger SET provider_id = NULL
  WHERE provider_id IN (SELECT id FROM providers WHERE kind = 'digitalocean');
DELETE FROM policies
  WHERE default_model_id IN (SELECT id FROM models WHERE provider_kind = 'digitalocean');
DELETE FROM providers WHERE kind = 'digitalocean';
DELETE FROM models WHERE provider_kind = 'digitalocean';

ALTER TYPE provider_kind RENAME TO provider_kind_old;
CREATE TYPE provider_kind AS ENUM ('openai_compat', 'anthropic', 'local');
ALTER TABLE providers ALTER COLUMN kind TYPE provider_kind USING kind::text::provider_kind;
ALTER TABLE models ALTER COLUMN provider_kind TYPE provider_kind USING provider_kind::text::provider_kind;
DROP TYPE provider_kind_old;
