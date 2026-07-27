# §7216 / engagement-letter language — DRAFT FOR ATTORNEY REVIEW

> **Not legal advice.** Hand this to the firm's attorney (14.7). Bracketed items are
> firm-specific. IRC §7216 and §6713 govern use/disclosure of tax return information by
> preparers; Rev. Proc. 2013-14 governs consent formats where consent is the chosen basis.

## Fact pattern this language assumes

The firm operates AI software **on its own equipment** ("the appliance"). Certain functions
may transmit limited, automatically-screened information to an AI service provider **engaged
directly by the firm** under the firm's own account: [PROVIDER LEGAL NAME, e.g. "OpenAI, LLC"
/ "Anthropic, PBC" / "Microsoft Corporation (Azure OpenAI)"]. No intermediary AI vendor exists;
the firm's screening software blocks Social Security numbers, employer identification numbers,
and financial account numbers from cloud transmission, and the firm retains audit records of
every transmission decision.

## Candidate engagement-letter paragraph (auxiliary-services / contractor basis)

> In performing our services, we use software tools operated on our own systems, including
> artificial-intelligence software. Where these tools involve processing by a third-party
> service provider, we engage [PROVIDER NAME] directly as our service provider, subject to
> contractual confidentiality restrictions and terms that prohibit use of our data to train
> that provider's models. Our systems automatically prevent taxpayer identification numbers
> and financial account numbers from being included in any such processing. We remain
> responsible for the confidentiality of your information in accordance with applicable law,
> including Internal Revenue Code §7216.

## Notes for counsel

1. Analyze whether the firm's use fits the §301.7216-2(d) auxiliary-services exception
   (disclosure to a contractor **in connection with programming, maintenance, repair, testing,
   or procurement of equipment or software**) or general tax-return-preparation assistance —
   if not squarely within an exception, a §7216 consent per Rev. Proc. 2013-14 is the
   conservative path for cloud-tier processing.
2. LOCAL-only configurations involve no third-party disclosure; the paragraph may be omitted
   or reduced to an on-premises software statement.
3. The appliance's audit log and tier configuration (SENSITIVITY-REVIEW.md, admin console
   Policies page) document exactly which functions can transmit and under what screening —
   useful exhibits for the firm's WISP (FTC Safeguards / IRS Pub 4557).
4. Update [PROVIDER NAME] if the firm changes providers; the admin console lists the active
   ones.
