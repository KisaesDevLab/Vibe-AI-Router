-- local_ocr: second local-tier provider kind (R4/Q-075) — the shared GLM-OCR llama-server.
-- OpenAI wire shape, but its own kind because routing resolves the firm's provider BY KIND
-- (same rationale as digitalocean, Q-060); a second `local` row would be unreachable next
-- to vibellm. Runner wraps this in a transaction — allowed on PG >= 12 as long as the same
-- transaction never USES the new value (it doesn't).
ALTER TYPE provider_kind ADD VALUE IF NOT EXISTS 'local_ocr';
