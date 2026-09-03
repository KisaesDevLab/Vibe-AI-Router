-- Reversible: acknowledgements are re-collected by the console on the next save of each
-- affected policy; dropping them loses an audit convenience, not a binding.
ALTER TABLE policies
  DROP COLUMN IF EXISTS acknowledged_at,
  DROP COLUMN IF EXISTS acknowledged_models;
