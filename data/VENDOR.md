# Vendored data provenance

## litellm-prices.json

- Source: `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
- Retrieved: 2026-07-26
- Filtered to: `litellm_provider ∈ {openai, azure, anthropic, groq, deepseek, ollama}`, `mode == chat` (291 entries)
- SHA-256 (filtered file): `0ccb07babec672798d9a95663f497a162b1b7a14e7a25cbbba4f81119199de97`

The catalog syncs from THIS vendored file (supply-chain-safe, works offline on the appliance).
Refreshing it is a release-time action: re-run the filter, update the checksum here, commit
(Q-017).

The upstream URL is also read LIVE, but only to price models that arrived by provider
discovery and that this file does not carry (Q-101, `CATALOG_PRICING_FEED_URL`, see
`src/catalog/live-pricing.ts`). It never creates, deprecates, or re-prices anything listed
here, and the fetched payload's sha256 is recorded in the audit log
(`catalog_live_pricing_applied`). An earlier revision of this note described a
`CATALOG_SYNC_URL` variable; it was never implemented.
