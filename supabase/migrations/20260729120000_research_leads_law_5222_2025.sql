-- 20260729120000_research_leads_law_5222_2025.sql
--
-- Repo: dimitriosg/portal-mygreektax  ->  supabase/migrations/
-- Database: igfwqgiscjpshxfsyunq
--
-- WHY
-- A search pass on 2026-07-29 surfaced a strong lead on two of the seven research_open
-- questions recorded by 20260727235500: Law 5222/2025 (National Customs Code and other
-- provisions, Government Gazette A 134 of 28.07.2025, the same omnibus law whose article 210
-- carries the rent payment mandate) appears to amend articles 5A, 5B and 5C of the Income
-- Tax Code. This migration appends dated LEAD notes to the two affected ledger rows so the
-- lead survives the session.
--
-- PROVENANCE, READ THIS BEFORE TRUSTING ANYTHING BELOW
-- The session that wrote this could not open any primary source: the execution environment
-- blocked all direct page fetches, and only search result snippets were available. Every
-- statement in these notes is snippet-grade. Nothing here upgrades any knowledge_base entry
-- and nothing here may be quoted to a client. The leads exist to make the next session with
-- browser access faster, not to settle anything.
--
-- SCOPE
-- knowledge_candidates only, which is never read by the Brain. Two UPDATE statements, each
-- appending to content, each guarded so a re-run is a no-op. The guard phrase 'LEAD
-- (2026-07-29' does not appear in the content written by 20260727235500, checked against
-- that file before writing this one.
--
-- No DDL. RUN THE TWO STATEMENTS SEPARATELY.


-- =====================================================================
-- STATEMENT 1 of 2: lead on the Article 5A application deadline question
-- =====================================================================

update public.knowledge_candidates
set content = content || $lead$

LEAD (2026-07-29, snippet-grade, sources NOT opened; the session recording this had no direct page access). Search results indicate that Law 5222/2025 (National Customs Code and other provisions, Government Gazette A 134 of 28.07.2025, the same law whose article 210 carries the rent payment mandate) amends articles 5A, 5B and 5C of the ITC, and that its article 206 amends paragraphs 2, 3, 4 and 8 of article 5A. That pattern fits the finding that the application deadline moved out of paragraph 3 and into a Governor's decision, and makes Law 5222/2025 article 206 the prime candidate for the amending law in open item (a). UNRESOLVED WRINKLE: a kodiko.gr PDF export dated December 2025 still shows the 31 March wording, which sits badly with a July 2025 amendment unless the export was stale or entry into force was deferred; do not treat the identification as settled. ALSO NOTED: AADE circular E.2053/2025 covers only the customs part of Law 5222/2025, so the tax-side explanatory circular, if one exists, is still unidentified. NEXT STEP: open the Gazette text of Law 5222/2025 article 206, then locate the current Governor's decision setting the deadline, which remains open item (b).$lead$
where title = 'Article 5A application deadline: removed from the statute, now set by AADE Governor decision'
  and content not like '%LEAD (2026-07-29%';


-- =====================================================================
-- STATEMENT 2 of 2: lead on the Article 5C paragraph 6 repeal question
-- =====================================================================

update public.knowledge_candidates
set content = content || $lead$

LEAD (2026-07-29, snippet-grade, sources NOT opened; the session recording this had no direct page access). Search results indicate that Law 5222/2025 (Government Gazette A 134 of 28.07.2025) also amended article 5C, including a repeal of paragraph 6, and that the repeal expressly covers applications pending before the Tax Administration at the date of publication. CAUTION: one generated summary described the repealed paragraph 6 as the new-job-position condition rather than the tekmiria exemption, so either that summary is garbled or the paragraph numbering shifted at some point; the identification of paragraph 6 with tekmiria is NOT confirmed by this lead. ALSO NOTED: AADE decision A.1138/2025 concerns inclusion under article 5C and post-dates the law; it may reflect the amended procedure. NEXT STEP: open the Gazette text of Law 5222/2025 (the articles amending 5C), confirm what paragraph 6 contained immediately before repeal, identify the effective tax year, and read A.1138/2025.$lead$
where title = 'Article 5C tekmiria exemption: paragraph 6 appears repealed, instrument unidentified'
  and content not like '%LEAD (2026-07-29%';
