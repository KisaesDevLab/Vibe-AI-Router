-- Q-098 (Vibe 1040 follow-up E2): DigitalOcean's /models list also serves commercial
-- Anthropic and OpenAI models, and discovery inserted them as ordinary digitalocean/… rows.
-- Their retention terms are the upstream vendor's, not DigitalOcean's (Claude Fable carries a
-- mandatory 30-day retention), so binding one must be a VISIBLE choice: the row is flagged,
-- the console shows the note, and the policy save requires an explicit acknowledgement.
-- Discovery keeps admitting them — a firm may legitimately want Claude on DO for a class
-- whose WISP names Anthropic. Tag, never filter.
ALTER TABLE models
  ADD COLUMN IF NOT EXISTS third_party_hosted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS retention_note text;

-- Backfill rows discovered before this migration. Same predicate as
-- src/catalog/discovery.ts THIRD_PARTY_HOSTED: anthropic-* and openai-* EXCEPT the open-weight
-- openai-gpt-oss-* family, which DigitalOcean hosts itself.
UPDATE models
SET third_party_hosted = true,
    retention_note = 'Hosted by DigitalOcean but served under Anthropic''s terms: zero retention, EXCEPT Claude Fable 5.1 / Fable 5, which require a mandatory 30-day retention of prompts and completions for trust-and-safety review (docs.digitalocean.com data-privacy page, 2026-09-03). Confirm against the firm''s WISP before binding.'
WHERE provider_kind = 'digitalocean'
  AND canonical_id LIKE 'digitalocean/anthropic-%'
  AND third_party_hosted = false;

UPDATE models
SET third_party_hosted = true,
    retention_note = 'Hosted by DigitalOcean but served under OpenAI''s terms. DigitalOcean''s data-privacy page (2026-09-03) states OpenAI''s zero-data-retention policy applies and excludes customer content from abuse-monitoring logs; those are OpenAI''s terms, not DigitalOcean''s. Confirm against the firm''s WISP before binding.'
WHERE provider_kind = 'digitalocean'
  AND canonical_id LIKE 'digitalocean/openai-%'
  AND canonical_id NOT LIKE 'digitalocean/openai-gpt-oss-%'
  AND third_party_hosted = false;
