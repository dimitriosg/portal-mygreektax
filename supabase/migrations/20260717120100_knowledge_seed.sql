-- Seed: initial knowledge_base entries for the MyGreekTax Brain
-- Built from the internal playbook v3.2 (2026-06-23) and the AFM service playbook (2026-06-26).
-- All entries are born status = 'draft'. Nothing is injected until promoted.
-- Deliberately excluded from this seed, per the operating rules:
--   pricing of any kind (retail, wholesale, margins), client names and case IDs,
--   partner pipeline assessments, competitor and strategy notes,
--   and the unverified AI research document (MyGreekTax_AI_Context_2026).
-- Rerun-safe: on conflict (slug) do nothing, so manual edits are never overwritten.
-- Save this file to supabase/migrations/ in the repo after running it.

insert into knowledge_base
  (slug, title, content, category, visibility, status, source, tax_year, review_by, is_active)
values
(
  'e1-filing-2026-playbook',
  'E1 filing playbook: tax year 2025, filing year 2026',
  $s1$Always label deliverables "tax year 2025, filing year 2026", never just a single year.

SCHEDULED 2026 DATES (statuses as recorded 2026-06-23; Greek deadlines are frequently extended late in the season, so verify the live status on AADE or myAADE before stating any deadline to a client):
- 16/03/2026: myAADE platform opened for E1, E2, E3 (tax year 2025). Confirmed by AADE.
- 16/04/2026: auto-submission of pre-filled returns for taxpayers who took no action. Passed.
- 30/04/2026: 4 percent full-payment discount deadline. Passed.
- 15/06/2026: 3 percent full-payment discount deadline. Passed.
- 15/07/2026: final filing deadline for individuals, and the 2 percent discount tier.
- 31/07/2026: filing deadline for individuals participating in legal entities with single-entry books; first instalment due; full-payment discount cutoff. Liability is payable in full by this date (with the earned discount) or in up to 8 monthly instalments as shown in myAADE.
- 31/12/2026: deadline for amended returns covering retroactive 2025 payments attributable to prior years, penalty-free if filed by then.

NEW FOR TAX YEAR 2025 (form changes clients rarely know):
- Code 079: adult unmarried children up to 25 in higher education, registered with DYPA, or in military service.
- Codes 045 and 046: new mothers in professional activity exempt from living expense indicators (tekmiria) for the year of birth plus two following years.
- Codes 877, 878, 879: dependent children's tax ID numbers, new column.
- Tekmiria significantly reduced, which can surface refunds or lower liabilities.
- Updated minimum net business income methodology on E3.
- Pre-filled coverage expanded (about 1.36M returns); pre-filled returns still need manual review.
- Non-resident verification tightened: country of tax residence, foreign TIN, and full address in Latin characters are required.

STANDARD WORKFLOW:
1. Written quote approved by the client before any work starts.
2. Document collection: prior-year return, employer certificates, bank interest summaries, rental contracts, business records, foreign income proof, property documents.
3. Client grants a scoped exousiodotisi through myAADE, limited to this filing. The client never shares a TAXISnet password.
4. Pre-filled audit: open the return in myAADE and review every pre-filled field against source documents. Common error sources: bank interest, employer adjustments, rental amounts, foreign-source figures, dependents.
5. Forms in order: E2 first (if rentals), then E3 (if business activity), then E1.
6. Apply the 2025-specific codes where applicable.
7. Validation pass across the eight critical fields: income, withholding, bank interest, rentals (E2 against E1), business results (E3 against E1), dependents with tax IDs, IBAN active and in the client's name, foreign tax credits.
8. Submit and capture confirmation: download E1, E2, E3 and the ekkatharistiko (act of administrative tax determination).
9. Plain-English summary to the client: what was filed, what it means, what is owed or refunded, when payment is due, how to pay.

QUALITY CONTROL RULES:
- Greek tax residents declare worldwide income, not just Greek-source.
- Non-residents: confirm Latin-character address, foreign TIN, country of tax residence.
- Never assume a deadline; verify current AADE announcements each time.
- Never submit an E1 while code 319 (foreign tax resident filing in Greece) is ticked if the facts say the client should be a Greek tax resident for the year. Resolve residency first, then file. See the tax residency transfer procedure.
- Never request, accept, or store TAXISnet passwords.
- If the situation reveals an Article 5A or Digital Nomad Visa angle that was not quoted, pause and re-scope in writing before proceeding.

WORKING CODE SET (recurs in real cases):
045/046 new mothers tekmiria exemption; 049 e-payments coverage; 059/060 donations (20 percent tax credit); 079 adult children in education; 103 to 216 real estate and residence fields; 301/302 salary income (taxpayer/spouse); 315 tax withheld on salary; 319 foreign tax resident filing in Greece; 401 to 426 business and freelance income; 627/628 Article 39B expenses (require ATAK); 750/840 vehicle block; 781/782 amounts checkable against prior years; 877 to 879 dependent children's tax IDs.
Legal liability-reduction checklist: complete employer certificates, donations into 059/060, Article 39B expenses into 627/628 with ATAK, own-paid insurance and union fees, then check 781/782 for carry-overs.

TAX BRACKETS, TAX YEAR 2025 (Law 4172/2013, codified by Law 4799/2021):
0 to 10,000 euro at 9 percent; 10,001 to 20,000 at 22 percent; 20,001 to 30,000 at 28 percent; 30,001 to 40,000 at 36 percent; above 40,000 at 44 percent.
Worked example: taxable 11,000 euro gives tax 1,120 euro (10,000 at 9 percent is 900, plus 1,000 at 22 percent is 220).

DEPENDANTS TAX REDUCTION (employees and pensioners), base reduction off computed tax:
0 dependants 777 euro; 1 gives 900; 2 gives 1,120; 3 gives 1,340; 4 gives 1,580; 5 gives 1,780; above 5 add 220 euro per extra dependant.
Income taper (fewer than 5 dependants): if taxable income exceeds 12,000 euro, reduce the base by 20 euro per 1,000 euro above 12,000. Final reduction is the base minus the taper, floored at zero.

INTAKE FACTS TO COLLECT before quoting or filing: AFM (or route to AFM registration first); TAXISnet access working; days in Greece in 2025 (183-day test); residency claimed for 2025 (resident, non-resident, mid-year transfer); special regime (none, Article 5A, DNV, other); marital status and dependents with tax IDs; all 2025 income types including foreign and crypto; retroactive prior-year payments received in 2025; Greek property held and ownership form; prior years filed or gaps; outstanding AADE letters; IBAN registered in myAADE, active, in the client's name.

WATCHPOINTS for the rest of 2026: retroactive-payment amended-return platform (deadline 31/12/2026, penalty-free); ENFIA 2026 assessments published early March, instalments per myAADE; reduced tax prepayments for freelancers via EFKA adjustments; the 2026 bracket reform applies to 2026 income only (see the separate forward-rules entry).$s1$,
  'rules',
  'client_safe',
  'draft',
  'Internal playbook v3.2 (2026-06-23), dates verified against AADE announcements and AADE Decision A.1062/2026; brackets per Law 4172/2013 codified by Law 4799/2021.',
  2025,
  '2026-07-31',
  true
),
(
  'tax-year-2026-forward-rules',
  'Tax year 2026 reforms (Law 5246/2025): forward planning only',
  $s2$SCOPE WARNING: everything here applies to income earned from 01/01/2026, declared in the 2027 filing season. None of it changes a tax year 2025 return. Never apply these brackets or scales to a 2025 return.

2026 GENERAL SCALE (employment, pensions, business profits):
0 to 10,000 euro at 9 percent; 10,001 to 20,000 at 20 percent (was 22); 20,001 to 30,000 at 26 percent (was 28); 30,001 to 40,000 at 34 percent (was 36); 40,001 to 60,000 at 39 percent (new band); above 60,000 at 44 percent (previously from 40,001). The 777 euro base credit and the dependants reduction continue to apply. Business profits do not get the employee and pension tax reductions.

AGE-BASED RATES (new): up to age 25, 0 percent on income up to 20,000 euro. Ages 26 to 30, 9 percent on the 10,001 to 20,000 band instead of 20 percent. Households with four or more dependent children, 0 percent up to 20,000 euro regardless of age.

2026 RENTAL SCALE (separate from the general scale): 0 to 12,000 euro at 15 percent; 12,001 to 24,000 at 25 percent (previously jumped to 35); 24,001 to 36,000 at 35 percent; above 36,000 at 45 percent. The standard 5 percent flat allowance on gross rents still applies before the scale, subject to the bank-only rent condition below.

LONG-TERM LEASE EXEMPTION (already running, ends 31/12/2026): income from long-term renting a residence up to 120 square meters is exempt for 36 months where the lease runs at least three years, is signed between 08/09/2024 and 31/12/2026, and the property was vacant or in short-term rental (for example Airbnb) in the prior period. A live planning lever for owners shifting a unit to a long lease. Verify per-case conditions before advising.

30 PERCENT ELECTRONIC-SPENDING RULE (ongoing since 2020, extended through 2026, not a 2026 novelty): Greek tax residents must incur electronic-payment expenses of at least 30 percent of actual income from employment, pensions, business activity, and immovable property, capped at 20,000 euro of required spend per year. Payments must be made within the EU or EEA. Missing the threshold adds 22 percent of the shortfall to the scale tax. Scope limits: it does not apply to non-Greek tax residents filing on Greek-source income only, and does not apply to Greek tax residents who reside or work abroad. The practical trap is everyday spending through non-EU/EEA cards or processors, which does not count; steering eligible spend through EU/EEA instruments is the fix. Frame this in consultation, not in a pre-deposit email.

BANK-ONLY RENT MANDATE (Law 5222/2025, not yet in force as of June 2026): all residential and commercial rent must be paid into a landlord-owned bank account registered with AADE; cash is treated as non-payment. Originally set for 01/01/2026, moved to 01/04/2026, and per the latest reporting postponed to October 2026. Confirm the live date before advising anyone; it has moved twice. Consequences once live: a landlord accepting cash loses the automatic 5 percent allowance (tax falls on 100 percent of rent); a tenant paying cash loses housing subsidies and the annual rent allowance; rent must reach the registered account in the owner's name within the first days of the month, third-party accounts are not recognised, and co-owners each register a separate IBAN; rental inflows do not get the salary seizure-protection floor. A declared, AADE-visible lease is load-bearing for both a business seat (edra) and the 5 percent allowance; short-term contracts under 60 days cannot establish a Greek business seat.$s2$,
  'rules',
  'client_safe',
  'draft',
  'Law 5246/2025 per Greek Ministry of Finance guide, KPMG Greece update 20/11/2025, PwC Worldwide Tax Summaries, OECD Taxing Wages 2026, verified June 2026. Rent mandate: Law 5222/2025 with postponement per Greek press reporting.',
  2026,
  '2026-10-01',
  true
),
(
  'tax-residency-transfer-procedure',
  'Tax residency transfer: operational procedure, both directions',
  $s3$TRANSFER INTO GREECE (foreign to Greek tax residence).
Trigger: the client has their center of vital interests in Greece, or has been physically present more than 183 days, but is still flagged as non-resident in AADE.
Operational rule when suspected mid-engagement: if the draft E1 has code 319 ticked (foreign tax resident obliged to file in Greece) but the facts say the client should be a Greek tax resident, do not submit. Hold the filing, run the residency-transfer request, wait for AADE acceptance, then untick 319 and re-run the E1. A draft assessment showing tax due that would not apply under resident status is a flag, not a green light. Anonymized reference: a non-resident-flagged draft showed a few hundred euro due that should have been close to zero under resident treatment.
Request name: Metavoli forologikis katoikias (apo exoteriko se Ellada).
Channels: myAADE, under Ta Aitimata mou (preferred), or physical protocol to the competent DOY Katoikon Exoterikou when the myAADE path is blocked.
Document set: myAADE-registered lease covering the relevant year; proof of presence and links (work contract, utility bills, transport tickets, school enrolment for dependents); foreign tax certificate if available (helps when the prior jurisdiction wants to keep the client on its books); ID or passport and AFM.
After acceptance: the client files as Greek tax resident from the relevant year onward; worldwide income reporting applies with foreign tax credit where a double-taxation treaty applies; special regimes (Article 5A, the 50 percent relocation exemption, DNV) may apply, re-scope if so.

TRANSFER OUT OF GREECE (Greek to foreign tax residence).
Trigger: the client is leaving Greece permanently or has already left.
Authorisation pattern: a scoped power of attorney, separate from the filing exousiodotisi, authorising the accountant partner to act exclusively in matters related to changing fiscal residence and fiscal exit from Greece before AADE, the competent DOY, and myAADE. It grants powers to submit applications, declarations, notifications and clarifications; deposit, send and receive documents, certificates and acts; respond to requests for clarification; monitor progress; and perform necessary procedural actions. The authorisation must explicitly state it applies only to the stated case and not to unrelated general tax matters.

VERIFY WITH THE PARTNER before stating as final: split-year treatment, treaty (SADF) interpretation, and any case with multi-country income. These remain partner-confirmation territory.$s3$,
  'rules',
  'client_safe',
  'draft',
  'Internal playbook v3.2 section 11 (2026-06-23), operational procedure from live cases. Split-year treatment pending partner sign-off; primary POL and treaty sources not yet ingested.',
  null,
  '2026-12-31',
  true
),
(
  'afm-and-setup-procedure',
  'AFM registration and TAXISnet setup: routes and failure points',
  $s4$Two service variants: AFM Basic (AFM number only, for example a remote property purchase, no system access) and AFM plus Setup (AFM, kleidarithmos, TAXISnet and myAADE activation, for a client settling in Greece).

THE CORE ACCESS PROBLEM: granting a scoped exousiodotisi through myAADE requires the client to already have TAXISnet, so the initial setup can never use the myAADE delegation route. It always runs on an authorisation document plus a certified signature. The only real variable is where the client physically is.

ROUTE BY SITUATION:
- Client physically in Greece, no TAXISnet: KEP for gnisio ypografis on the exousiodotisi (client attends with passport or ID), or a myAADElive video session, which can do AFM, kleidarithmos and TAXISnet activation in a single remote session. After that, later certifications can go digital through gov.gr.
- Client abroad, no TAXISnet: Greek consulate or embassy (certifies signatures on Ypefthines Diloseis and exousiodotiseis; note it cannot do notarial plirexousia, which require a notary), or a local notary plus Apostille plus official translation into Greek. Confirm the exact instrument with the accountant partner per case: a certified exousiodotisi may be enough, or a notarial plirexousio may be required. The instrument for a Greek national abroad without TAXISnet is awaiting partner confirmation.

NATIONALITY FLAGS:
- Non-EU national: proof of entry into Greece is needed for the AFM. Since the EU Entry/Exit System went live in April 2026 there are no passport stamps, so the route is the EES digital record or a police entry certificate. A small local police station may not be set up to pull the digital record, so confirm the issuing authority with the partner before sending the client.
- EU or Greek national: no entry-proof issue.

DOCUMENTS TYPICALLY NEEDED: passport or national ID; proof of address abroad in Latin characters; Greek mobile number (typically required for the kleidarithmos step); parents' full names including the mother's family name at birth (registry requirement); foreign TIN; the certified authorisation per the route above; non-EU only, the entry proof. Watch: the passport booklet number and the national ID or TIN are different fields entered separately; do not let them get merged.

WORKFLOW: written quote approved, then deposit (default 50 percent to begin, 50 percent before delivery); partner prepares the exousiodotisi; client certifies the signature via the right route; client returns the certified document plus supporting documents; forward to the partner; AFM and kleidarithmos issuance, then TAXISnet and myAADE activation, confirming EMEp registration is handled during activation; collect final payment; deliver access details. Registered email on the client's myAADE account: hello@mygreektax.eu, so AADE notifications route to us per the concierge model, with a clean way to forward the client anything they personally need to see.

KNOWN FAILURE POINTS: the DOY can reject a submission and require resubmission with extra documents, so build slack into deadline-driven cases; a wrong field on a partner-prepared document forces the client to redo the in-person certification, so double-check partner documents before they reach the client; the kleidarithmos step may require a Greek SIM; for a client abroad, the certification route adds real time (consulate appointments, or notary plus Apostille plus translation), which is not the same SLA as a KEP visit in Greece.$s4$,
  'sops',
  'client_safe',
  'draft',
  'Internal AFM service playbook (2026-06-26), routes partner-confirmed, EES entry-proof pattern from live case experience.',
  null,
  '2026-12-31',
  true
),
(
  'exousiodotisi-access-principle',
  'Access principle: exousiodotisi always, credentials never',
  $s5$We never request, accept, or store a client's TAXISnet or myAADE password, under any circumstances. All accountant-partner access happens through a scoped exousiodotisi granted by the client through myAADE, limited to the specific filing or service. One exception exists by necessity: a brand-new client with no TAXISnet yet cannot grant a myAADE delegation, so initial AFM and TAXISnet setup runs on a certified authorisation document instead (see the AFM and setup procedure). When explaining this to clients, frame it as a protection: they stay in control, access is limited in scope, and nothing about their credentials ever changes hands.$s5$,
  'sops',
  'client_safe',
  'draft',
  'MyGreekTax operating rules; myAADE delegation workflow.',
  null,
  '2027-06-30',
  true
),
(
  'services-catalog',
  'Service catalog and intake triggers (no prices)',
  $s6$Trigger to service mapping, used to recognise adjacent needs during any conversation:
- Client has no AFM: AFM Registration (Basic, or plus TAXISnet setup).
- No working TAXISnet or needs a kleidarithmos: TAXISnet and myAADE Activation.
- AADE letter received, untranslated: Tax Authority Letters (translation and response).
- Property rented out in Greece: Rental Income Declaration (E2).
- Property owner, ENFIA confusion: ENFIA management.
- Missing previous Greek tax years: Back-Year Declarations.
- Working remotely from Greece, not registered: Freelancer Setup (EFKA and AADE).
- Digital Nomad Visa holder with incomplete tax setup: DNV Tax Setup.
- Self-employed, ongoing needs: Annual Freelancer Retainer.
- Sole trader or IKE formation: Business Setup, quoted on request after a free structure consultation.
- Just moved to Greece or leaving Greece: Tax Residency Transfer (the flagship service, both directions).
- High-net-worth relocator with foreign income: Article 5A Non-Dom regime support.
- Low-to-middle income renting: Rent Allowance (Epidoma Enoikiou). Heating costs: Heating Allowance. Children in Greece: Child Benefit (A21).
- Annual Tax Return (E1) is the core recurring service.

PRICING RULE FOR DRAFTS: never state any price, fee, or total in a draft. If cost is clearly on the client's mind, say that pricing is listed transparently on mygreektax.eu as starting points for straightforward cases, and that the exact scope and fee are confirmed in writing after review. No exceptions.$s6$,
  'services',
  'client_safe',
  'draft',
  'mygreektax.eu live catalogue, June 2026. Price figures intentionally excluded from the knowledge base by design.',
  null,
  '2026-12-31',
  true
)
on conflict (slug) do nothing;
