-- 20260727220000_enfia_verified_e9_and_capital_gains.sql
--
-- Repo: dimitriosg/portal-mygreektax  ->  supabase/migrations/
-- Database: igfwqgiscjpshxfsyunq
--
-- WHY
-- 20260727210000_deconfirm_20260719_pass.sql marked two paragraphs of
-- enfia-property-tax-and-reductions as UNVERIFIED, because they originated in the
-- discredited 2026-07-19 pass. Both have now been checked and both hold. This migration
-- replaces the unverified flags with the sourcing that was missing.
--
-- This is the intended cycle: flag as unverified, check, then upgrade WITH the citation.
-- Never upgrade without naming what was read.
--
-- WHAT WAS CHECKED (2026-07-27)
--   E9 31/07/2026 penalty-free amended-declaration window: multiple independent Greek
--   outlets reporting AADE's opening of the E9 application after the ENFIA 2026 clearance,
--   consistent on the date, the electricity-supply-number cause, and the re-clearance
--   mechanism. Press-corroborated, not primary. Labelled as such below.
--
--   Capital gains suspension to 31/12/2026: Law 5162/2024 article 90, amending para 33 of
--   article 72 of the Income Tax Code, suspending article 41. Corroborated by a Hellenic
--   Parliament committee report on that bill and by the government housing policy portal
--   stegasi.gov.gr. Primary-grade.
--
-- STILL NOT VERIFIED, deliberately left flagged: the 31/01/2026 standard E9 deadline, and
-- the small-settlement population thresholds from A.1063/2026.
--
-- No DDL. Single qualified UPDATE. No-op on re-run.

do $$
declare v_e9 int; v_cg int;
begin
    select count(*) into v_e9 from public.knowledge_base
     where slug = 'enfia-property-tax-and-reductions'
       and content like '%E9 CORRECTION DEADLINES (UNVERIFIED%';
    select count(*) into v_cg from public.knowledge_base
     where slug = 'enfia-property-tax-and-reductions'
       and content like '%PROPERTY CAPITAL GAINS (UNVERIFIED%';
    if v_e9 <> 1 then raise notice 'enfia: E9 unverified-flag anchor not found (hits=%). Did 20260727210000 run?', v_e9; end if;
    if v_cg <> 1 then raise notice 'enfia: capital gains unverified-flag anchor not found (hits=%). Did 20260727210000 run?', v_cg; end if;
end $$;

update public.knowledge_base
set content = replace(
        replace(
            content,
            $o1$E9 CORRECTION DEADLINES (UNVERIFIED, flagged 2026-07-27): recorded as 31/01/2026 for the standard deadline to enter 2025 property changes in the original E9 for ENFIA 2026, and 31/07/2026 for a separate penalty-free amended-E9 window to correct data errors (e.g. electricity-supply-number mismatches) that block reductions such as the small-settlement 50%. The word "reconciled" previously attached here came from the 2026-07-19 pass, which is known to have recorded confirmations it did not carry out. Neither date has been independently checked. 31/07/2026 is imminent, so if a live case turns on it, verify on myAADE before saying anything to the client.$o1$,
            $n1$E9 CORRECTION DEADLINES. 31/07/2026 CONFIRMED (checked 2026-07-27, press-corroborated across multiple independent Greek outlets reporting AADE's reopening of the E9 application after the ENFIA 2026 clearance; not traced to an AADE decision number, so treat as strongly corroborated rather than primary). After ENFIA 2026 assessments were posted, AADE reopened the E9 application for both initial and amended declarations. Owners may file an amended E9 for 2026 WITHOUT PENALTY up to 31/07/2026. The headline use case: the small-settlement 50% reduction was granted automatically only where the property declared in E9 could be matched to the primary residence declared in E1, and a wrong or missing electricity supply number in E9 breaks that match. HOW THE MONEY COMES BACK: for small-settlement cases, through a new central re-clearance once the correct electricity supply number is entered; for other cases, if the request is accepted, a fresh tax determination act is issued and notified electronically. OTHER ERRORS THAT COST MONEY, worth checking in the same pass: wrong square metres on storage and parking removes the 90% reduction; undeclared semi-finished buildings removes the 60% reduction; mis-recorded rights in rem inflate the assessment. 31/01/2026 as the standard deadline for entering 2025 property changes in the original E9 REMAINS UNVERIFIED; no source consulted on 2026-07-27 addressed it.$n1$
        ),
        $o2$PROPERTY CAPITAL GAINS (UNVERIFIED, flagged 2026-07-27): recorded as suspended until 31 December 2026 under Article 41 of the Income Tax Code. This suspension has been extended repeatedly in past years and the current end date has not been checked against a primary source. It gets stated to clients who are selling, which makes it one of the higher risk lines in the knowledge base. Verify before use.$o2$,
        $n2$PROPERTY CAPITAL GAINS. CONFIRMED (checked 2026-07-27, primary-grade). Article 41 of the Income Tax Code, which taxes the gain on transfer of immovable property, is suspended until 31 December 2026. The instrument is Law 5162/2024 article 90, which amended paragraph 33 of article 72 of the Income Tax Code to move the suspension end date out by two years. Corroborated by a Hellenic Parliament committee report on that bill and by the government housing policy portal. STANDING CAUTION: this suspension has been rolled forward repeatedly (previously to 31/12/2022, then 31/12/2024, now 31/12/2026). A further extension covering 2027 is plausible but is NOT enacted. For a client selling in 2027 or later, say that the suspension currently runs to end-2026 and that the position beyond that is not yet legislated. Never state that the gain is untaxed indefinitely.$n2$
    ),
    source = source || $src$ UPDATE 2026-07-27: E9 31/07/2026 penalty-free window confirmed (press-corroborated). Capital gains suspension confirmed to 31/12/2026 via Law 5162/2024 art. 90 amending ITC art. 72 para 33 (primary-grade). Still unverified: 31/01/2026 standard E9 deadline; A.1063/2026 small-settlement thresholds.$src$,
    updated_at = now()
where slug = 'enfia-property-tax-and-reductions';

-- review_by deliberately left at 2026-08-31. Two items in this entry are still unverified.
