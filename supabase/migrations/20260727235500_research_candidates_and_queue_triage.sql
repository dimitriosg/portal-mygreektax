-- 20260727235500_research_candidates_and_queue_triage.sql
--
-- Repo: dimitriosg/portal-mygreektax  ->  supabase/migrations/
-- Database: igfwqgiscjpshxfsyunq
--
-- WHY
-- Today's verification work closed several things and opened others. The corrections are in
-- knowledge_base. The open questions existed only in a chat window, which is the same failure
-- mode we spent the day fixing. This migration gives them a row.
--
-- It also clears eight rows from the pending queue that are not knowledge. The queue had 28
-- pending, none reviewed, roughly 12 distinct ideas. Left as-is it becomes unreadable and
-- stops being opened, which is the same outcome as not having it.
--
-- NOTE ON SCOPE
-- knowledge_candidates is NEVER read by the Brain. Nothing here reaches a client. These rows
-- are a research ledger for Jim. The client-facing warnings already live inside the relevant
-- knowledge_base entries, next to the rule they qualify.
--
-- DELIBERATELY NOT DONE HERE
-- The rows triaged for promotion are NOT marked 'approved'. Marking a row approved before its
-- content actually exists in knowledge_base creates a row that claims a promotion that never
-- happened. They flip to 'approved' in the same migration that writes them into knowledge_base,
-- not before.
--
-- CATEGORY
-- The category column is free text and currently holds ~15 different values across 28 rows.
-- All seven new rows use 'research_open' as a single controlled tag so they can be pulled as a
-- group. That is a deliberate 16th value, not another ad-hoc one.
--
-- No DDL. Both statements idempotent. RUN THEM SEPARATELY.


-- =====================================================================
-- STATEMENT 1 of 2: record the seven open research questions
-- Idempotent via NOT EXISTS on title. Re-running inserts nothing.
-- =====================================================================

insert into public.knowledge_candidates (case_id, title, content, category, rationale, status)
select v.case_id, v.title, v.content, v.category, v.rationale, 'pending'
from (values

(null::uuid,
 $t$Article 5A application deadline: removed from the statute, now set by AADE Governor decision$t$,
 $c$The knowledge base stated for months that the Article 5A application is filed by 31 March of the relevant tax year. Checked 2026-07-27 against the codified text of article 5A of Law 4172/2013: paragraph 3 no longer contains any date, and paragraph 10 now lists "the deadline for submitting the application of paragraph 3" among the matters determined by decision of the Governor of AADE. Older renderings of the same article (a search engine cache of the same page, and a PDF dated December 2025) still show the 31 March wording, so the change is recent. OPEN: (a) which law removed the date from paragraph 3; (b) which Governor's decision currently sets the deadline and what date it sets. Until both are answered the 5A entry carries a DEADLINE CONTESTED marker and no date may be quoted to a client.$c$,
 $cat$research_open$cat$,
 $r$Article 5A is a Tier 4 service with a single annual application window. Quoting a deadline that has moved does not cost a client a deadline, it costs them a full tax year in the regime at 100,000 euro per year. This is the highest-value unanswered question in the knowledge base.$r$),

(null::uuid,
 $t$Article 5A investment waiver: does a Law 5038/2023 investment permit satisfy the reference to article 16 of Law 4251/2014$t$,
 $c$Article 5A paragraph 1 waives the 500,000 euro investment condition for a person who has obtained and maintains a residence permit for investment activity under article 16 of Law 4251/2014, "as in force". Law 4251/2014 has since been superseded as the Migration Code by Law 5038/2023, where investment-purpose permits sit at articles 96 to 100. The statute still points at the old code. OPEN: whether a permit issued under Law 5038/2023 satisfies the article 5A condition, and whether the D1 Financial Independence Programme visa falls within it at all. Partner question, interpretive, not a citation lookup.$c$,
 $cat$research_open$cat$,
 $r$Four separate pending candidates (1d1e4da6, b6bbea29, 987d41e2, 4bf87f59) all reduce to this one question. FIP D1 holders with passive foreign income are a recurring inbound profile and currently every one of them has to be escalated. A single confirmed answer closes all four and removes a repeated escalation.$r$),

(null::uuid,
 $t$Article 5C tekmiria exemption: paragraph 6 appears repealed, instrument unidentified$t$,
 $c$The knowledge base promised that a person under Article 5C is exempt from imputed expenditure (tekmiria) on residences and private passenger cars for the seven years. Checked 2026-07-27 against the codified text of article 5C: paragraph 6 renders as "6. ..................", the conventional marking for a repealed provision, while every other paragraph renders in full. The tekmiria wording that commentary (e-forologia and others) attributes to article 5C appears nowhere in the current text. OPEN: whether paragraph 6 was in fact repealed, by which instrument, and from which tax year. The 5C entry now carries a DO NOT PROMISE IT marker.$c$,
 $cat$research_open$cat$,
 $r$This changes what can be offered to every inbound EU freelancer, which is a core target segment. A benefit promised in a quote and then absent on the return is a refund conversation and a reputational problem, not a correction.$r$),

(null::uuid,
 $t$Combination rules between Articles 5A, 5B and 5C: asserted in two entries, sourced to neither statute$t$,
 $c$Both the 5A entry and the 5C entry state that 5A cannot be combined with 5B, and that 5C can be combined with 5A or 5B where each article's conditions are independently met, even where regimes overlap in the same calendar year. Neither statutory text says anything about combination. The claim presumably comes from AADE guidance which has not been read. The two entries agreeing is not corroboration: they were written in the same 2026-07-19 pass, which is the pass proven unreliable on the E1 entry. OPEN: the source of the combination rules, and whether they are still current.$c$,
 $cat$research_open$cat$,
 $r$Combination questions arise in exactly the high-value cases (a relocating retiree with foreign pension and Greek activity, a 5A applicant taking Greek employment). Getting this wrong shapes an engagement worth several thousand euro.$r$),

(null::uuid,
 $t$Digital Nomad Visa: legal basis, amending article of Law 5275/2026, and when the consulate-only rule actually took effect$t$,
 $c$Three connected gaps in the digital-nomad-visa-tax entry (status draft, so not injected). (a) LEGAL BASIS: the entry cites Law 4825/2021 via an accounting-firm summary. The operative provision is article 68 of Law 5038/2023, "Digital nomads (residence title Z.1)", confirmed 2026-07-27. (b) AMENDING ARTICLE: Law 5275/2026 is published at Government Gazette A 17 of 06.02.2026, confirmed. Which article of it amends article 68 of Law 5038/2023 is NOT identified, nor whether there is a transitional provision for applications pending at that date. Article 69 of Law 5275/2026 (entry into force) has not been read. (c) TIMING CONTRADICTION: a 2023 commentary states that from 01/01/2024 the only route was a national entry visa from a Greek consulate, with in-country application by persons already in Greece on tourist status abolished. A February 2026 law-firm note presents the same abolition as newly introduced by Law 5275/2026. Either the restriction is two years older than we record, or the position changed twice.$c$,
 $cat$research_open$cat$,
 $r$Point (c) directly affects back-year cases: what we tell a client about what was possible in 2024 and 2025 depends on it, and pending candidate d5f6f29f (DNV holder over 183 days, retrospective residency) sits on top of it. The entry cannot move from draft to canonical until all three are closed.$r$),

(null::uuid,
 $t$ENFIA: 31/01/2026 E9 deadline and A.1063/2026 small-settlement thresholds not traced to primary text$t$,
 $c$Two items in enfia-property-tax-and-reductions remain unverified after the 2026-07-27 pass, which confirmed the 31/07/2026 penalty-free amended-E9 window and the capital gains suspension. (a) The 31/01/2026 standard deadline for entering 2025 property changes in the original E9 was addressed by no source consulted. (b) The small-settlement population thresholds (up to 1,500 residents nationwide including Attica islands but excluding other Attica settlements; up to 1,700 in Western Macedonia, Evros and specified border municipalities) are attributed to decision A.1063/2026 but come from press and commentary, not from the Government Gazette text. The conditions attached (primary residence in the E1 for tax year 2024, Greek tax residence as at 01/01/2026, taxable value up to 400,000 euro) share that provenance.$c$,
 $cat$research_open$cat$,
 $r$The thresholds decide who qualifies for a 50 percent ENFIA reduction, and reporting suggests full abolition from 2027 for qualifying primary residences. Foreign owners of Greek property in small settlements are a core segment. Getting the threshold wrong means telling someone they do or do not qualify on a number we read in a newspaper.$r$),

(null::uuid,
 $t$E1 filing year 2026: sub-items not rechecked after the 24/07 extension$t$,
 $c$The e1-filing-2026-playbook entry was corrected on 2026-07-27 for the extension of the individual filing deadline to 24/07/2026 by AADE Decision A.1140/2026. Confirmed at the same time: the 31/07/2026 first-instalment date, and that the 2 percent full-payment discount attaches to filing by 24/07 with the whole liability paid by 31/07. NOT rechecked and still carrying the marking of the discredited 2026-07-19 pass: the 31/07 deadline for individuals participating in legal entities with single-entry books, which may have shifted as a knock-on effect of the extension; the eight-instalment schedule; the 31/12/2026 penalty-free amended-return deadline for retroactive prior-year payments; and the 4 percent and 3 percent discount tiers as they applied earlier in the season.$c$,
 $cat$research_open$cat$,
 $r$The 31/12/2026 amended-return deadline is the one with a live consequence: it is the route for clients who received retroactive payments attributable to earlier years, and it is five months away. The single-entry-book deadline matters for any client with a stake in a Greek entity.$r$)

) as v(case_id, title, content, category, rationale)
where not exists (
    select 1 from public.knowledge_candidates k where k.title = v.title
);


-- =====================================================================
-- STATEMENT 2 of 2: reject the eight rows that are not knowledge
--
-- Five credential rows: incidents plus a template defect. The rule already exists as a
--   canonical entry (exousiodotisi-access-principle). A sixth restatement of a rule does not
--   fix a template that violates it. The fix is in the outbound templates, not here.
-- Two triage rows: a bug in the inbound pipeline. Belongs in an issue.
-- One pricing row: an incident. The rule already exists in services-catalog.
--
-- Idempotent: the status = 'pending' guard means a re-run touches nothing.
-- =====================================================================

update public.knowledge_candidates
set status = 'rejected',
    reviewed_at = now()
where status = 'pending'
  and id in (
    '7595caa1-1c74-4229-b113-85974b7e780f',  -- credential-sharing language, QC gap
    'fc8cfec5-3bfe-4027-8507-b577345f4b46',  -- outbound email offered to accept credentials
    'd4725812-7882-4010-9006-cd9273be2d29',  -- credential-sharing language, compliance risk
    '2fe91f71-40c7-41f7-bd41-fd93ec035064',  -- intake template contains credential language
    '2518cc5a-668a-4e70-ba18-ba9f6e58f830',  -- credentials requested and sent in plain text
    '1564d85e-4811-4886-bfa2-a9224a64c8b9',  -- repeated triage acks, no client content
    'eadd3498-8071-447f-9afd-dd8e0132a9c6',  -- triage events without source message
    'c518b94b-31ee-4a54-817c-b36d60ed2b95'   -- price range quoted in operator email
  );
