# Apps with no router integration (surveyed)

Recorded so "every Vibe app" has an explicit disposition. Source: the 2026-07-29 call-site
survey (`docs/router-option-addendum.md`) and the Round J review. None of these need any
provisioning step today.

| App | Disposition |
| --- | --- |
| **Vibe-1099** | **No AI code** — MIG-3 is a no-op. The pack's `v1099_*` classes (payee match, W-9 extract, correspondence) are reserved. If an AI feature ships: W-9 extraction is LOCAL by definition (full TINs) — never widen; a vision-capable local model (or `glm/GLM-OCR` via R4) is the natural binding. |
| **Vibe-Connect** | **No AI code** — MIG-5 is a no-op. `connect_doc_summarize` (pack, local_only) reserved for client-upload summarization. |
| Vibe-Vault, Vibe-Printer, Vibe-Admin, Vibe-Appliance, Vibe-License-Server, VibeMyFirm, Vibe-Investments, Vibe-Job-Proposals, Vibe-ReadingLine, ownertrack, vibe-entity | No AI call sites; nothing to integrate. |
| Vibe-Shield | Scrapped concept — superseded by this router. Historical only. |

If any of these grows an AI feature: follow `docs/migration-playbook.md` and the shared
provisioning sequence in this folder's README — declare classes at boot (they start
`local_only`), mint the token under the app's registration identity, bind policies, run the
universal verification gate — then add a runbook file here.
