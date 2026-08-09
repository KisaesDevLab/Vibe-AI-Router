-- Auto-discovered models from a live provider /models endpoint get their own source value
-- (Q-082) so the vendored sync's vanish-check (which only deprecates 'synced') never touches
-- them, while still enriching them in place if a curated feed entry later ships. Runner wraps
-- this in a transaction — allowed on PG >= 12 as long as the same transaction never USES the
-- new value (it doesn't).
ALTER TYPE model_source ADD VALUE IF NOT EXISTS 'provider';
