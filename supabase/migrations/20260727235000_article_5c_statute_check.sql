-- 20260727235000_article_5c_statute_check.sql
--
-- Repo: dimitriosg/portal-mygreektax  ->  supabase/migrations/
-- Database: igfwqgiscjpshxfsyunq
--
-- WHY
-- 20260727210000 flagged article-5c-50-percent-reduction as unverified. Checked 2026-07-27
-- against the codified text of article 5C of the Income Tax Code (Law 4172/2013).
--
-- TWO FINDINGS, both in the client-facing direction
--
-- 1. TEKMIRIA EXEMPTION. The entry promises exemption from imputed expenditure (tekmiria)
--    on residences and private cars for the 7 years. Paragraph 6 of the codified article
--    renders as "6. ...................", the conventional marking for a repealed provision,
--    while every other paragraph renders in full. The tekmiria wording that commentary
--    attributes to article 5C does not appear anywhere in the current text. The benefit may
--    have been repealed. Not asserted either way here, but it must not be promised.
--
-- 2. THE "12 MONTHS" LOSS-OF-STATUS RULE DOES NOT EXIST. The entry says inclusion ends if
--    qualifying activity stops for more than 12 months. Paragraph 5 says that if in ANY tax
--    year conditions (c) and (d) of paragraph 1 are not met, inclusion ends from that tax
--    year. There is no grace period. This error runs in the dangerous direction: it tells a
--    client they have room they do not have.
--
-- CONFIRMED and left standing: 5 of 6 years non-residence; transfer from an EU/EEA state or
-- a state with an administrative tax-cooperation agreement; employment with a Greek entity or
-- the Greek permanent establishment of a foreign business; declared intent to stay two years;
-- 50% exemption; 7 tax years, non-extendable; the 2 July pivot; extension by analogy to
-- individual business activity.
--
-- STILL UNVERIFIED after this pass: the combination rules with 5A and 5B, which appear in
-- both the 5A and the 5C entries and are sourced to neither statute.
--
-- No DDL. Single qualified UPDATE. No-op on re-run.

do $$
declare v_hits int;
begin
    select count(*) into v_hits from public.knowledge_base
     where slug = 'article-5c-50-percent-reduction'
       and content like '%stops for more than 12 months%';
    if v_hits <> 1 then
        raise notice 'article-5c: 12-month anchor not found (hits=%). Check manually.', v_hits;
    end if;
end $$;

update public.knowledge_base
set content =
  replace(
    replace(
      replace(
        replace(
          replace(
            content,
            $o1$- Eligibility, all cumulatively: (a) not Greek tax resident in 5 of the 6 years before the move; (b) transfer tax residence from an EU/EEA state or a state with an administrative tax-cooperation agreement with Greece; (c) either take up employment with a Greek entity or the Greek permanent establishment of a foreign company, OR start individual business activity in Greece; (d) declare intent to stay in Greece at least 2 years.$o1$,
            $n1$- Eligibility (CONFIRMED against the codified statute, read 2026-07-27), all cumulatively: (a) not a Greek tax resident in 5 of the 6 years before the transfer; (b) transfer of tax residence from an EU or EEA member state, or from a state with an administrative tax-cooperation agreement in force with Greece; (c) provision of services in Greece under an employment relationship within the meaning of article 12(2), exercised either in a Greek legal person or entity or in the Greek permanent establishment of a foreign business; (d) a declaration that they will remain in Greece for at least two years. PRECISION: the individual-business-activity route is not a fourth limb of (c). It comes from paragraph 7, which applies paragraphs 1 to 5 by analogy to a person transferring residence in order to carry on individual business activity in Greece, with "taking up service" read as commencement of activity.$n1$
          ),
          $o2$- The benefit: for 7 tax years, exemption from income tax on 50% of Greek-source employment and/or business income (only the other 50% is taxed on normal brackets). Also for those 7 years, exemption from the objective/imputed expenditure (tekmiria) for main and secondary residences and private passenger cars.$o2$,
          $n2$- The benefit (CONFIRMED): exemption from income tax AND from the special solidarity contribution of article 43A on 50% of Greek employment income for the tax year, with the other 50% taxed on normal brackets. Under paragraph 7 the same 50% exemption applies to Greek business income for 7 consecutive tax years. TEKMIRIA EXEMPTION WITHDRAWN FROM THIS ENTRY, DO NOT PROMISE IT (flagged 2026-07-27): this entry previously stated that imputed expenditure on residences and private cars was disapplied for the 7 years. That provision is not in the codified text. Paragraph 6 of article 5C renders as a repealed provision while every other paragraph renders in full, which suggests the tekmiria rule was repealed. This has not been run to ground and the repealing instrument has not been identified. Until it is, do not tell a client the tekmiria exemption applies, and do not build it into a quote or a projection.$n2$
        ),
        $o3$- Application: via myAADE, "Submit an application for inclusion in the special method of taxation (Article 5C ITC)" (standard online route as of Oct 2025). Inclusion year depends on start of the new employment/business: if it begins on or before 2 July, the application can relate to that same tax year; if after 2 July, generally the following tax year.$o3$,
        $n3$- Application (CONFIRMED and expanded against the statute): filed via myAADE. TIMING, which is more precise and more forgiving than previously recorded here: if service is taken up on or before 2 July of a year, the application is submitted for that year and by the end of that year, and it may ALSO be submitted during the following year, in which case it is judged for inclusion in that following year. If service is taken up after 2 July, the application is submitted for the year following and by the end of that year. The Tax Administration decides within 60 days. DOCUMENT CURE, previously missing and worth knowing: if the required supporting documents are produced by 31 March of the year after the application, a rejection issued for failure to produce them is revoked, the application is re-examined, and a new decision issues within 60 days. Under paragraph 8 the Minister and the Governor of AADE may extend the paragraph 3 and paragraph 7 deadlines and may establish a pre-approval procedure, so check whether either is in force for the year in question.$n3$
      ),
      $o4$- Loss of status: if qualifying Greek employment or individual business activity stops for more than 12 months, or the person no longer intends to stay 2 years, inclusion ends and all income is taxed under general rules from the relevant year.$o4$,
      $n4$- Loss of status (CORRECTED 2026-07-27, the previous version was wrong in the dangerous direction): paragraph 5 provides that if in ANY tax year the person does not meet conditions (c) and (d) of paragraph 1, they cease to be covered FROM THAT TAX YEAR and are taxed on the whole of their Greek employment income under general rules. There is NO 12-month grace period. The figure of 12 months previously stated here does not appear anywhere in the article and its origin is unknown. Never tell a client they have a year of leeway between jobs.$n4$
    ),
    $o5$COMBINATION: 5C can be combined with 5A or 5B, provided each article's conditions are met, even if regimes overlap in the same calendar year.$o5$,
    $n5$COMBINATION (UNVERIFIED, flagged 2026-07-27): this entry and the 5A entry both state that 5C can be combined with 5A or 5B where each article's conditions are met, and that 5A cannot be combined with 5B. Neither statutory text says anything about combination. The claim is presumably from AADE guidance, which has not been read. The two entries agreeing with each other is not corroboration, they came from the same pass. Route combination questions to the partner.$n5$
  ),
  source = source || $src$ UPDATE 2026-07-27: checked against the codified text of art. 5C Law 4172/2013. Conditions, 50% exemption, 7 years and the 2 July pivot verified; art. 43A solidarity exemption, 60-day decision and 31 March document cure added. Tekmiria exemption withdrawn (para 6 appears repealed). "12 months" loss-of-status rule removed as unfounded. Combination rules flagged unverified.$src$,
  updated_at = now()
where slug = 'article-5c-50-percent-reduction';

-- review_by stays 2026-08-31. The tekmiria repeal and the combination rules are both open.
