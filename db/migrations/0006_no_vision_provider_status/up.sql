-- Q-092 revision (post-review): the ledger originally bucketed the
-- no_vision_provider error under request_status 'capability_missing', which
-- conflated routine by-design skips (firm has no vision model yet) with
-- genuine misconfiguration in the canonical billing/reporting table. A
-- distinct enum value makes "how many vision skips this month" answerable
-- from usage_ledger alone. Runner wraps this in a transaction — allowed on
-- PG >= 12 as long as the same transaction never USES the new value.
ALTER TYPE request_status ADD VALUE IF NOT EXISTS 'no_vision_provider';
