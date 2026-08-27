# R6 — Region pinning and policy reporting

| | |
| --- | --- |
| **Status** | Proposed — raised by Vibe 1040, awaiting scheduling |
| **Estimate** | **M** — 3–4 d router-side, 0 d app-side (the caller is already written) |
| **Depends on** | Nothing. The capability matrix (R2) and sensitivity tiers already exist |
| **Blocks** | Vibe 1040 P14. Tracked there as QUESTIONS.md Q11 |
| **Touches an invariant** | Adds one: a region-constrained task class may never resolve to an out-of-region provider |
| **Raised by** | Vibe 1040, 2026-08-26, against router v0.0.24 |

## 1. Problem

**The router has no concept of where inference physically happens.** `grep -i region`
across `src/`, `docs/`, and `db/` returns nothing. There is no region column on `providers`
or `policies`, no check at routing time, and no way for a caller to ask.

That is fine for most task classes. It is not fine for Vibe 1040, whose compliance position
depends on it.

Vibe 1040 performs data capture on 1040 source documents and makes no substantive
determination about filing status, income characterization, deductions, or credits. That
keeps its inference within the **auxiliary service provider** treatment of Treas. Reg.
§301.7216-2(d), which does not require separate written taxpayer consent — **but only while
processing stays inside the United States.** Cross-border processing moves the same activity
into territory that does require consent the firm has not collected.

Two facts make this urgent rather than theoretical:

1. Vibe 1040's task classes are registered `cloud_deidentified`, so cloud binding is
   possible by configuration.
2. The scrubber rewrites text content parts only (`src/protect/scrub.ts:225`); image parts
   pass through verbatim. Those images are W-2s and 1099s, so **unredacted SSNs and EINs
   leave the box** on any cloud-bound request. That exposure is accepted (Q-087, and again
   by Vibe 1040 on 2026-08-26), which means region pinning is not one control among
   several — it is the only remaining technical control on where that data lands.

The app is already written against this feature. `src/router/client.ts` probes
`GET /v1/policy/regions` at startup and **refuses to boot** when it gets no usable answer,
which today is always. Deployments are therefore running with the assertion disabled, which
is exactly the state nobody wants during filing season.

## 2. Non-goals

- **Not data residency for storage.** This is about where a *request* is served, not where
  anything is stored. The router stores no request bodies.
- **Not per-request region selection.** The caller does not get to choose a region. Policy
  chooses, the caller asserts. A caller that could pick its own region could pick wrong.
- **Not a geo-IP or latency feature.** Region here is a compliance attribute of a
  configured provider, declared by the operator, not measured.
- **Not a replacement for the DPA.** The contractual control and the technical control are
  both required; neither substitutes for the other.

## 3. Where the control lives

**On the provider, asserted by the policy, enforced in `modelViolation`.**

Region is a property of *where a provider runs*, not of *what the work is*. A task class
does not have a region; it has a requirement about one. So:

- `providers.region` — operator-declared, e.g. `us-east`, `us-central`, `eu-west`,
  `local`. Nullable, meaning "undeclared".
- `policies.requiredRegionPrefix` — nullable text, e.g. `us`. Null means unconstrained,
  which is every existing policy, so this ships inert.

Enforcement goes in `src/policy/engine.ts` alongside the sensitivity check, which is the
existing precedent for a hard, non-substitutable invariant:

```ts
// engine.ts, modelViolation(), immediately after the local_only check (line ~116)
const required = effective.policy.requiredRegionPrefix;
if (required) {
  const region = effective.providersById.get(model.providerId)?.region;
  if (!region || !region.toLowerCase().startsWith(required.toLowerCase())) {
    return {
      code: 'policy_blocked',
      reason:
        `task class ${effective.taskClass.key} requires a ${required}* region; ` +
        `model ${model.canonicalId} runs in ${region ?? 'an undeclared region'}`,
    };
  }
}
```

Three properties follow from putting it there, and all three matter:

- **It fails closed on undeclared.** A provider whose region the operator never set cannot
  serve a constrained class. Silence is not consent.
- **It is not substitutable.** `selectModel` only searches for substitutes on
  `capability_missing`; `policy_blocked` propagates. A region-blocked class cannot quietly
  fall back to a compliant-looking model in the wrong place.
- **It composes with `local_only` for free.** A local provider declares `region: 'local'`,
  which does not start with `us`, so a firm wanting local-only should keep using the
  sensitivity tier. If a deployment genuinely wants "local or US", that is
  `requiredRegionPrefix` plus the local tier — express it, don't infer it.

## 4. Reporting endpoint

```
GET /v1/policy/regions
Authorization: Bearer <app token>

200 {
  "classes": [
    { "key": "v1040_layout", "regions": ["us-east", "us-central"], "enforced": true },
    { "key": "tb_classification", "regions": [], "enforced": false }
  ]
}
```

`regions` is the set of regions the class's **currently reachable** models could actually
resolve to — default model plus allowed set plus fallback chain — not the declared
constraint. That distinction is the whole value of the endpoint: a caller asserting
"US-pinned" wants to know where this request could really land, not what the operator
intended.

`enforced` reports whether `requiredRegionPrefix` is set, so a caller can tell "constrained
and every candidate is US" from "unconstrained and every candidate happens to be US today".
Vibe 1040 must treat the second as a failure; it is one policy edit away from not being
true.

Scoped to the calling app's own classes. An app token should not enumerate another app's
policy.

## 5. Audit

Every routing decision for a region-constrained class already writes a ledger row; add
`region` to it. That log is what substantiates the §7216 position if anyone asks, and
"we believe it was US" is not an answer. Region belongs in the routing audit record next to
task class, model, and provider.

## 6. Failure policy

Fail closed, everywhere:

- Unknown or undeclared provider region + constrained class → `policy_blocked`.
- Reporting endpoint unavailable → the *caller* refuses to start. Vibe 1040 already does.
- Region constraint removed from a policy while a class is bound to a cloud provider →
  `config_change` audit event, because that is a compliance-relevant edit and should be
  visible in a review rather than discovered later.

## 7. Console

- Provider edit: a region field, with a clear note that leaving it blank makes the provider
  ineligible for region-constrained classes rather than universally eligible.
- Policy edit: the constraint, plus a live list of which currently-configured models would
  become ineligible if it were applied. An operator should see what a constraint costs
  before saving it, not after a task class stops routing in March.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Operator sets the constraint, forgets to declare provider regions, everything stops routing | Console shows the impact before save; the error names the undeclared provider explicitly |
| Region strings drift (`us-east` vs `useast` vs `US-EAST`) | Prefix match is case-insensitive; document the convention and validate against a known list at save time |
| A provider silently moves a model between regions | Out of scope technically — this is a contractual matter. The audit log at least records what the router believed at the time |
| Ships inert and nobody enables it | Vibe 1040 refuses to start without it, which is the forcing function |

## 9. Scope

**In:** `providers.region`, `policies.requiredRegionPrefix`, the `modelViolation` check,
`GET /v1/policy/regions`, the ledger field, the two console fields, migration, tests.

**Out:** region-aware load balancing, per-request region hints, storage residency,
automatic region discovery from provider APIs.

## 10. Acceptance

1. A task class with `requiredRegionPrefix: 'us'` **cannot** be routed to a provider
   declaring `eu-west`, by any configuration path — not as a default, not through the
   allowed set, not through the fallback chain, and not through capability substitution.
2. The same class cannot be routed to a provider with **no** declared region.
3. `GET /v1/policy/regions` returns the reachable-region set and the enforcement flag, and
   reflects a policy edit without a restart.
4. Vibe 1040 starts successfully against a correctly-pinned router, and refuses to start
   when the constraint is removed. This is the real end-to-end test and the caller is
   already written for it.
5. Existing task classes with no constraint behave exactly as before — verified by the
   current suite passing unchanged.
6. Every routing decision for a constrained class records its region in the ledger.

## 11. Decision needed

None. Unlike D7 this is not a trade-off — the feature is required by a compliance position
the firm has already taken, and the only open question is when it lands relative to Vibe
1040 processing live client data.

**Recommended:** schedule before Vibe 1040's first live bundle on a cloud-bound task class.
The two can also be sequenced trivially — Vibe 1040 can run against local models
indefinitely, and this becomes urgent only at the moment someone widens its classes in the
admin UI. That moment is worth a checklist item.
