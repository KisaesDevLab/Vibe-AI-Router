-- Postgres cannot drop a single enum value; the type must be rebuilt, and the column must not
-- reference the value being removed. Reclassify any discovered rows to 'synced' first — this
-- is non-destructive (the model row and every policy that binds it survive; the next vendored
-- sync reconciles them), unlike 0003's down which deletes an entire provider kind. Downs in
-- this repo must ALWAYS run: reversibility is CI-gated (up -> down -> up) and test resets run
-- `migrate down` to zero.
UPDATE models SET source = 'synced' WHERE source = 'provider';

ALTER TYPE model_source RENAME TO model_source_old;
CREATE TYPE model_source AS ENUM ('synced', 'custom');
ALTER TABLE models ALTER COLUMN source TYPE model_source USING source::text::model_source;
DROP TYPE model_source_old;
