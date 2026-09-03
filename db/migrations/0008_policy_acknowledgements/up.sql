-- Q-100 (0.0.25 review): the third-party-hosted acknowledgement (Q-098) was a transient
-- per-save argument. Persisting it on the policy means (a) an operator who confirmed once is
-- not re-prompted on every unrelated edit, (b) exports carry the acknowledgement so imports can
-- require it instead of assuming it, and (c) policies that bind a model 0007 backfilled as
-- third-party-hosted — saved before anyone could have acknowledged — are detectable and
-- reported at boot and after every discovery run.
ALTER TABLE policies
  ADD COLUMN IF NOT EXISTS acknowledged_models text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
