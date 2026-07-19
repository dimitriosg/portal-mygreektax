-- Seed: knowledge_base entries built from sourced Deep Research (accessed 2026-07-19).
-- All born status = 'draft'. Review each, then promote to 'canonical' to inject.
-- Uncertainties from the research are encoded as explicit VERIFY flags, never as
-- stated fact. No prices, no client data. Sources named per entry (R2 rule).
-- Rerun-safe via on conflict (slug) do nothing.

insert into knowledge_base
  (slug, title, content, category, visibility, status, source, tax_year, review_by, is_active)
values
(
  'article-5a-non-dom-regime',
  'Article 5A non-dom regime (foreign-source income)',
  $s$Article 5A of Law 4172/2013 is an alternative way to tax the FOREIGN-source income of an individual who moves their tax residence to Greece. Commonly called the non-dom regime. This is complex, high-value, and case-specific: use this entry to frame the conversation and set expectations, but every individual eligibility and figure must be confirmed with the licensed partner before it is stated to a client as applying to them.

CORE MECHANICS (per AADE guidance):
- Eligibility: the person must NOT have been a Greek tax resident for 7 of the 8 tax years before the move, AND must invest at least 500,000 euro in Greek real estate, businesses, securities, or shares (directly or via a controlled entity), completed within 3 years of applying. The investment condition is waived for holders of an "investment activity" residence permit under Article 16 of Law 4251/2014.
- The tax: a fixed annual tax of 100,000 euro on all foreign-source income, whatever the actual amount, for up to 15 tax years. An additional 20,000 euro per year applies for each qualifying relative included (spouse, direct ascendants/descendants, civil partners).
- Effect: foreign-source income under 5A is not declared in the annual return. Subject to detailed conditions, exemption from inheritance and gift tax on movable property abroad may apply (amendments via Law 5222/2025). Greek-source income is taxed normally.
- Application: filed via myAADE (My Requests) to the competent KEFODE service by 31 March of the relevant tax year, with evidence the required capital was transferred to a Greek financial institution.
- Revocation: if the lump-sum tax is not fully paid in a year, or the investment is not completed within 3 years, the regime is revoked and the person is taxed on worldwide income under normal rules from that year.

COMBINATION RULES: 5A cannot be combined with 5B (pensioners). 5A CAN be combined with 5C, provided each article's conditions are met.

WHAT TO DO IN A DRAFT: confirm the client is asking about foreign-source income and a move to Greece, note that 5A is a specialised regime handled with the licensed partner, and gather the facts the partner needs (years of prior non-residence, nature and location of income, whether a 500k investment is realistic, family members to include). Do not tell a client they qualify or quote their tax; that is a partner determination.$s$,
  'rules',
  'client_safe',
  'draft',
  'AADE "Tax Incentives for Attracting New Tax Residents under Articles 5A/5B/5C of Law 4172/2013" (11 Nov 2025); AADE FAQs for Greeks Abroad and Non-Residents (25 Nov 2025); Law 4172/2013 art. 5A; Law 5222/2025 amendments. Accessed 2026-07-19.',
  2026,
  '2026-12-31',
  true
),
(
  'article-5c-50-percent-reduction',
  'Article 5C 50% reduction regime (new-resident inbound workers)',
  $s$Article 5C of Law 4172/2013 is a special way to tax the GREEK-source employment and business income of inbound workers and entrepreneurs who become Greek tax residents. This is the regime often (mis)advertised as a "digital nomad tax break"; see the caution below. Individual eligibility must be confirmed with the licensed partner.

CORE MECHANICS (per AADE guidance):
- Eligibility, all cumulatively: (a) not Greek tax resident in 5 of the 6 years before the move; (b) transfer tax residence from an EU/EEA state or a state with an administrative tax-cooperation agreement with Greece; (c) either take up employment with a Greek entity or the Greek permanent establishment of a foreign company, OR start individual business activity in Greece; (d) declare intent to stay in Greece at least 2 years.
- The benefit: for 7 tax years, exemption from income tax on 50% of Greek-source employment and/or business income (only the other 50% is taxed on normal brackets). Also for those 7 years, exemption from the objective/imputed expenditure (tekmiria) for main and secondary residences and private passenger cars.
- Application: via myAADE, "Submit an application for inclusion in the special method of taxation (Article 5C ITC)" (standard online route as of Oct 2025). Inclusion year depends on start of the new employment/business: if it begins on or before 2 July, the application can relate to that same tax year; if after 2 July, generally the following tax year.
- Loss of status: if qualifying Greek employment or individual business activity stops for more than 12 months, or the person no longer intends to stay 2 years, inclusion ends and all income is taxed under general rules from the relevant year.

COMBINATION: 5C can be combined with 5A or 5B, provided each article's conditions are met, even if regimes overlap in the same calendar year.

IMPORTANT CAUTION (recurring client misconception): many migration-marketing sites present the 5C 50% reduction as a general "digital nomad tax break", or conflate it with a "7% flat tax for 15 years". This is not supported by AADE guidance and is misleading. 5C applies to GREEK-source employment or self-employment income. Pure FOREIGN-source remote income (the typical digital nomad case) generally does NOT qualify. If a client cites a 50% break for their foreign remote work, gently flag that this needs checking and route to the partner rather than confirming it.$s$,
  'rules',
  'client_safe',
  'draft',
  'AADE "Tax Incentives... Articles 5A/5B/5C" (11 Nov 2025); Law 4714/2020; AADE Decision A.1087/2021; Law 4172/2013 art. 5C. Marketing-misconception caution per RelocateNomad/Nomadlex guides (2026). Accessed 2026-07-19.',
  2026,
  '2026-12-31',
  true
),
(
  'digital-nomad-visa-tax',
  'Digital Nomad Visa: residence and tax treatment',
  $s$The Digital Nomad Visa (DNV) lets third-country nationals live in Greece while working remotely for foreign employers or clients. It is a migration status, not a tax regime; tax treatment follows the general residency rules.

CORE MECHANICS:
- Legal basis: introduced by Law 4825/2021 (per EY summary). A 2026 reform (reported as Law 5275/2026) abolished in-country conversion: applicants must now obtain the visa at a Greek consulate ABROAD before entering Greece. VERIFY the current application route with the migration authority, as this changed in 2026.
- Activity restriction: DNV holders are explicitly NOT permitted to perform dependent employment or business (professional) activity IN Greece.
- Income requirement: proof of sufficient resources of at least 3,500 euro per month, with uplifts for family members (commonly cited as +20% spouse, +15% per child). UNCERTAIN: sources conflict on whether the 3,500 figure is net or gross; the underlying official text could not be conclusively verified in 2026. Treat the exact figure and its net/gross basis as needing confirmation.
- Validity: initially up to 12 months, with the option to apply for a 2-year digital-nomad residence permit (renewable) before expiry.

TAX RESIDENCY: the migration law does not set tax residency. Under AADE general rules, a person becomes a Greek tax resident if present in Greece more than 183 days in any 12-month period, unless the stay is purely for tourism/medical/similar private purposes and does not exceed 365 days. Once tax resident, worldwide income is taxable unless a special regime applies.

5C INTERACTION (flag, do not resolve): Article 5C requires Greek employment or Greek individual business activity, which the DNV explicitly prohibits. So at the level of the legal texts, a DNV title and 5C are structurally inconsistent. Whether someone who entered on a DNV could later change status and then qualify for 5C is NOT settled in the AADE guidance reviewed. Treat as uncertain and route to the partner; do not tell a DNV client they can get the 5C 50% reduction.$s$,
  'rules',
  'client_safe',
  'draft',
  'EY Greece "Greece introduces Digital Nomad Visa" (Law 4825/2021 summary, 10 Dec 2025); AADE FAQs for Greeks Abroad and Non-Residents (25 Nov 2025); 2026 reform (reported Law 5275/2026) per nomad-visa guides. Income net/gross basis flagged uncertain. Accessed 2026-07-19.',
  2026,
  '2026-06-30',
  true
),
(
  'enfia-property-tax-and-reductions',
  'ENFIA property tax and 2026 reductions',
  $s$ENFIA (Unified Property Tax) is charged annually by AADE on rights in Greek real estate declared in the E9 property register. Owners of Greek property, INCLUDING foreign tax residents, must file the E9 from the year following acquisition, then pay ENFIA assessed on that data. Rental income from property is reported separately in the income tax return (E1).

2026 PAYMENT: ENFIA 2026 assessment acts were posted on myAADE in March 2026. Payment is allowed in full or in up to 12 monthly instalments, the first due 31 March 2026 and the last in February 2027. Always confirm the live instalment dates on myAADE for the specific case.

INSURED-RESIDENCE REDUCTION (a concrete, usable relief): a natural person whose residence is insured against earthquake, fire, and flood, for at least 3 months in the year before assessment and at full reconstruction value, may get an ENFIA reduction of 20% if the taxable ENFIA value does not exceed 500,000 euro, or 10% above that value, with proportional relief for shorter insurance periods. Applied via myAADE (myPROPERTY, ENFIA reduction for insured residences), with insurer/taxpayer deadlines in January and February. If not applied automatically, it can be granted by the local DOY on formal request with supporting documents.

SMALL-SETTLEMENT REDUCTION (flag, scope unverified): AADE press for ENFIA 2026 also mentions a 50% reduction for primary residences in certain small settlements under Article 17(3) of the ENFIA law (Law 5219/2025), with reporting of full abolition from 2027 for qualifying primary residences in such settlements. The detailed geographic, population, and income/value criteria were NOT fully verifiable in the sources reviewed. Note the relief exists but confirm exact eligibility from AADE's 2026 implementing decisions before telling a client they qualify.

OTHER RELIEFS (confirm per case): additional 50% reduction or full exemption for low-income households, large families, and persons with disability above 80%, subject to strict income, area, and asset thresholds.

E9 CORRECTION DEADLINES (conflicting sources): one source says amended E9 declarations for 2025 data could be filed until 31 January 2026; another says the E9 platform closed 19 February 2026 with later corrections only adjusting future instalments. Both are secondary. Confirm the exact deadline on myAADE for the specific tax year.

PROPERTY CAPITAL GAINS: AADE notes tax on transfers of immovable property for consideration is suspended until 31 December 2026 under Article 41 of the Income Tax Code.$s$,
  'rules',
  'client_safe',
  'draft',
  'AADE/myAADE ENFIA 2026 announcements (Mar 2026); AADE "Unified Property Tax (ENFIA)" guide; Gov.gr "ENFIA reduction for insured home" (24 Aug 2023); AADE decisions A.1005/2026, A.1063/2026; Law 5219/2025 art. 17(3); Law 4172/2013 art. 41. Small-settlement scope and E9 deadlines flagged. Accessed 2026-07-19.',
  2026,
  '2026-12-31',
  true
),
(
  'efka-freelancer-contributions',
  'EFKA freelancer / non-salaried social security',
  $s$Freelancers, self-employed professionals, and farmers register with e-EFKA as NON-SALARIED contributors, separately from AADE tax registration. Registration produces a pre-registration certificate (bebaiosi proengrafis) via gov.gr, used when starting professional activity.

SEQUENCING (flag, uncertain): the official pages do not state clearly whether EFKA registration must legally precede AADE "commencement of activities" (enarxi) or can run in parallel. Do not assert an order to a client; confirm with the partner or current administrative practice. This matters for freelancer-setup cases.

CONTRIBUTIONS (new insurance system): contributions are decoupled from taxable income. Non-salaried insured persons CHOOSE one of six contribution categories for main pension and health, plus optional three-category schemes for supplementary pension and lump-sum benefits. Amounts are set annually by ministerial act, tracking the average annual consumer-price index change (legal basis: Law 4670/2020 arts. 31, 35, 36, 37, 45; Law 5255/2025 art. 55).

2026 SPECIFICS: contribution amounts rose for 2026, driven by the maximum insurable-earnings ceiling increasing to 7,761.14 euro (from 7,562.62 euro in 2025), about +2.63%. Category choice is mandatory and binds the insured for the whole of 2026 unless changed via the electronic application by 31 January 2026; failing to submit a change leaves the prior year's category in force. Exact per-category monthly amounts change yearly, so quote them only from current e-EFKA figures, not from memory.

WHAT TO DO IN A DRAFT: for a freelancer-setup enquiry, explain that EFKA registration is a required, separate step from tax registration, that the person selects a contribution category, and that the specifics (category amounts, sequencing with enarxi) are confirmed during setup with the licensed partner. Do not state exact contribution figures unless taken from current e-EFKA data.$s$,
  'sops',
  'client_safe',
  'draft',
  'e-EFKA "Eleftheroi Epaggelmaties kai Aftoapasholoumenoi" (2026 categories); Gov.gr non-salaried registration service; e-EFKA Circular A.15/1865 / MD D.15/D/1865 (23 Jan 2026); PwC Greece Legal Flash (Nov 2025); Arvanitis Tax summary (Feb 2026); Law 4670/2020; Law 5255/2025. Sequencing flagged uncertain. Accessed 2026-07-19.',
  2026,
  '2026-12-31',
  true
)
on conflict (slug) do nothing;
