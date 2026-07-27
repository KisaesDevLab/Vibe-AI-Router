# FAQ — peer review, insurers, and client questions

**Q: Does any client data go to an AI vendor?**
Only what you explicitly permit, tier by tier. LOCAL-tier tasks (the default for anything
identifying) never leave the appliance. SCRUBBED-tier requests are machine-scanned for SSNs,
EINs, bank routing/account numbers, and card numbers before any cloud call; matches are
redacted to `[TYPE]` tokens before transmission (or block the request entirely, per firm
setting). CLOUD-tier tasks contain no client data by construction. Enforcement is server-side
and logged.

**Q: Which AI company processes our data when cloud is used?**
The provider *your firm* chose, under *your firm's own account and terms* (e.g. your OpenAI or
Anthropic account). There is no intermediary — the router is software on your appliance, not a
service that sees your traffic.

**Q: Is our data used to train AI models?**
Under OpenAI's and Anthropic's standard API terms, API data is not used for training. That is
a term of *your* agreement with *your* provider; the router adds the guarantee that only
permitted, scrubbed-or-clean requests reach them at all.

**Q: What records exist for review?**
An append-only audit trail (every request decision, every configuration change, tamper-proof
at the database level) and a complete usage ledger (who, which task, which model, tokens,
cost). Both export to CSV. Prompt contents are never stored — there is nothing to subpoena or
breach on that axis.

**Q: What about §7216?**
Where a cloud tier is enabled, the firm's engagement-letter/consent language should name the
firm's chosen provider as a contractor/service provider. A draft language template is included
(`engagement-letter-language.md`) — have your attorney adapt it. LOCAL-only firms generally
need no disclosure at all since no disclosure to a third party occurs.

**Q: What happens if the internet is down?**
LOCAL-tier tasks keep working (they never used the internet). SCRUBBED/CLOUD tasks fail over
per policy or return a clear error. Nothing queues client data for later transmission.

**Q: Can staff bypass the controls?**
No. Apps authenticate with scoped tokens and have no provider keys to leak; policies, tiers,
budgets, and the scrubber run inside the router regardless of what any app or user asks for.
Role-level restrictions per task are available.

**Q: Who can change the data tiers?**
Only a firm admin, in the console, and every change is recorded with before/after values in
the immutable audit log.
