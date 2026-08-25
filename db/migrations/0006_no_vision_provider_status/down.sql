-- Postgres cannot drop a single enum value; rebuild the type (same contract as
-- 0003's down). Rows carrying the value are remapped to the pre-0006 bucket
-- 'capability_missing' first, so no ledger history is lost.
UPDATE usage_ledger SET status = 'capability_missing' WHERE status = 'no_vision_provider';

ALTER TYPE request_status RENAME TO request_status_old;
CREATE TYPE request_status AS ENUM (
  'ok',
  'provider_error',
  'policy_blocked',
  'scrubber_blocked',
  'budget_exceeded',
  'rate_limited',
  'capability_missing',
  'client_abort',
  'error'
);
ALTER TABLE usage_ledger ALTER COLUMN status TYPE request_status USING status::text::request_status;
DROP TYPE request_status_old;
