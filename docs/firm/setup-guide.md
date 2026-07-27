# Firm setup guide

Time required: about ten minutes. You need: the admin console URL
(`https://airouter.<your-domain>`), your admin login, and — only if you want cloud AI — an API
key from your chosen provider (OpenAI, Anthropic, Azure OpenAI, Groq, or DeepSeek).

## 1. Sign in

Your appliance installer set the admin email and password. The dashboard shows the data
boundary lamp: **FULLY LOCAL** until you add a cloud provider.

## 2. (Optional) Add a cloud provider

Providers → **Add provider** → pick your provider → paste your API key. The wizard runs a live
connection test before finishing. Your key is encrypted immediately and can never be viewed
again — only replaced.

Azure OpenAI: also enter your deployment mapping on the connection step
(`azure/gpt-4o-mini = your-deployment-name`).

## 3. Review policies

Policies shows every AI task with its data tier badge (LOCAL / SCRUBBED / CLOUD). Sensible
local-first defaults ship out of the box. To let a SCRUBBED or CLOUD task use your new
provider, edit that task and pick the cloud model as default or fallback — the editor only
offers models that actually support what the task needs.

## 4. Set guardrails (recommended)

Firm settings:

- **Scrubber mode** — leave on **block** unless you have a reason to soften it.
- **Firm monthly budget** — a hard dollar cap on AI spend; a warning shows at 80%.

## 5. Verify

Dashboard → **Send a test prompt** on any task. You'll see the answer, which model served it,
and a new line in the audit log. That request also appears in spend reporting — everything you
just did is the same path your Vibe apps use.

## If something fails

- Provider test fails → re-check the key and URL; see the Providers page status.
- A task says "unconfigured — requests blocked" → it has no valid model yet; edit its policy.
- A request is blocked with "protected data" → the scrubber found an SSN/EIN/account/card
  number in a cloud-bound request. That's it working. Use a LOCAL-tier task for that data, or
  review the source document.
