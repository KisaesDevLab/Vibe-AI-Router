# Where your data goes — one page

Your firm's AI features run through one control point: the **Vibe AI Router**, on your own
appliance, using your own AI accounts. There is no intermediary AI service, no vendor pooling,
no training on your data by us — we never see it.

## The three tiers

Every AI task in the suite is assigned a data tier, enforced by the router on every single
request (not by app good manners):

| Tier | Meaning | Examples (defaults) |
| --- | --- | --- |
| **LOCAL** | Never leaves your appliance. Served by the on-box model server. | Trial-balance classification, W-9 extraction, payroll review, bank statement parsing, client document summaries |
| **SCRUBBED** | May use your cloud AI account, but only after an automatic scan proves the request carries no SSNs, EINs, bank routing/account numbers, or card numbers. A match blocks the request (default) or redacts it, per your setting. | Source-document field extraction, letter drafting |
| **CLOUD** | May use your cloud AI account directly — these tasks contain no client data by construction (e.g. summarizing public IRS guidance). | Tax research over public authority |

The current assignment of every task is visible in the admin console (Policies page) and can
be tightened by you at any time. Widening a tier is a deliberate admin action and is recorded
in the audit log.

## What is stored

- **Never stored anywhere:** the content of prompts and responses. Not in logs, not in the
  database, not in the audit trail. This is enforced by automated tests on every release.
- **Stored:** metadata — which app asked, which task, which model answered, token counts,
  cost, timestamps, and a cryptographic fingerprint (hash) used for correlation.
- **Your provider API keys:** encrypted (AES-256-GCM) on the appliance; there is no way to
  read them back out, even for an administrator.

## Zero-cloud option

The appliance is fully functional with no cloud provider configured at all. In that state the
console shows **FULLY LOCAL** and every AI task runs on your own hardware.
