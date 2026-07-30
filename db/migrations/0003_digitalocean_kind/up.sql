-- DigitalOcean Gradient serverless inference as a first-class provider kind (Q-060).
-- It speaks the OpenAI wire protocol but must be its own kind: routing picks the
-- firm's provider BY KIND, so a second openai_compat row would be unreachable next
-- to OpenAI/Groq. Runner wraps this in a transaction — allowed on PG >= 12 as long
-- as the same transaction never USES the new value (it doesn't).
ALTER TYPE provider_kind ADD VALUE IF NOT EXISTS 'digitalocean';
