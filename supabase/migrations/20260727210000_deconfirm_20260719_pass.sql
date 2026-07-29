-- 20260727210000_deconfirm_20260719_pass.sql
--
-- Repo: dimitriosg/portal-mygreektax  ->  supabase/migrations/
-- Database: igfwqgiscjpshxfsyunq
--
-- WHY
-- Five knowledge_base rows share updated_at 2026-07-19 20:39:37, from a single verification
-- pass. That pass recorded, on the E1 entry, that deadlines had been "independently confirmed
-- against AADE's official E1 page". The 24/07/2026 extension had already been announced at
-- that point and was missed, so the pass did not open the source it cited. Every confirmation
-- claim it wrote is therefore untrustworthy, whether or not the underlying fact happens to be
-- right. This migration removes those claims and marks the affected statements as unverified.
--
-- E1 was handled in 20260727200000_e1_playbook_deadline_correction.sql.
--
-- SCOPE
-- Three rows only: article-5a-non-dom-regime, article-5c-50-percent-reduction,
-- enfia-property-tax-and-reductions. All three are status='canonical', is_active=true,
-- visibility='client_safe', so all three are live in Brain injection right now.
--
-- digital-nomad-visa-tax is the fifth row from that pass and is deliberately NOT touched here.
-- It is status='draft', so it is not injected, and it needs a substantive rewrite (legal basis,
-- FEK A 17/06.02.2026, article 68 of Law 5038/2023, and the unresolved question of whether the
-- consulate-only rule predates Law 5275/2026) rather than a de-confirmation. That is a separate
-- migration once the article-level question is settled.
--
-- No DDL, so no `notify pgrst, 'reload schema'`.
-- Every UPDATE is qualified by slug and is a no-op on re-run.
--
-- RUN THE THREE BLOCKS SEPARATELY IN THE SQL EDITOR. Batched blocks in this project have
-- reported success while later statements never executed.


-- =====================================================================
-- BLOCK 1 of 3: article-5a-non-dom-regime
-- =====================================================================

do $$
declare v_hits int;
begin
    select count(*) into v_hits from public.knowledge_base
     where slug = 'article-5a-non-dom-regime'
       and content like '%mechanics above are AADE-primary-sourced%';  -- "are", not "were": the replacement text says "were", so this anchor cannot match it
    if v_hits <> 1 then
        raise notice 'article-5a: anchor not found (hits=%). Update below will no-op. Check manually.', v_hits;
    end if;
end $$;

update public.knowledge_base
set content = replace(
        content,
        $o$Eligibility, tax treatment, and application mechanics above are AADE-primary-sourced and confirmed. Individual eligibility, investment structuring, and treaty interaction remain partner-confirmation items before ever telling a client they qualify.$o$,
        $n$PROVENANCE (revised 2026-07-27). The line previously here asserted that the eligibility, tax treatment and application mechanics above were AADE-primary-sourced and confirmed. That assertion came from the verification pass of 2026-07-19, which is known to have recorded a confirmation it did not carry out. Treat the mechanics above as drafted from AADE guidance but NOT independently verified, in particular the 31 March application deadline, the 500,000 euro investment threshold, the 100,000 euro flat tax, the 20,000 euro per relative, the 15 year duration and the 7 of 8 years non-residence test. Individual eligibility, investment structuring and treaty interaction were always partner-confirmation items and remain so. Do not tell a client they qualify and do not quote them a figure.$n$
    ),
    source = source || $src$ CAUTION 2026-07-27: the confirmation recorded against this entry on 2026-07-19 came from a pass proven unreliable on the E1 entry. Figures here are unverified pending recheck.$src$,
    review_by = date '2026-08-31',
    updated_at = now()
where slug = 'article-5a-non-dom-regime';


-- =====================================================================
-- BLOCK 2 of 3: article-5c-50-percent-reduction
-- =====================================================================

do $$
declare v_hits int;
begin
    select count(*) into v_hits from public.knowledge_base
     where slug = 'article-5c-50-percent-reduction'
       and content like '%CONFIRMED RULE: DNV structurally cannot combine%';
    if v_hits <> 1 then
        raise notice 'article-5c: anchor not found (hits=%). Update below will no-op. Check manually.', v_hits;
    end if;
end $$;

update public.knowledge_base
set content = replace(
        content,
        $o$CONFIRMED RULE: DNV structurally cannot combine with 5C at the visa level (5C requires Greek employment/business activity, DNV prohibits it). Never tell a DNV holder they qualify for 5C based on the visa alone; 5C could only become live if they later change status and independently meet 5C's employment/business conditions.$o$,
        $n$RULE (label downgraded 2026-07-27, previously marked CONFIRMED). DNV and 5C are structurally inconsistent at the visa level, because 5C requires Greek employment or Greek individual business activity while the DNV prohibits both. That follows from reading the two regimes together rather than from a source stating it outright, and the CONFIRMED label it previously carried came from the unreliable 2026-07-19 pass. The operational instruction is unchanged and is safe whichever way the legal question falls: never tell a DNV holder they qualify for 5C on the basis of the visa alone. Whether a person who later changes status can then qualify is not settled and must go to the partner.$n$
    ),
    source = source || $src$ CAUTION 2026-07-27: the CONFIRMED label on the DNV interaction came from a pass proven unreliable on the E1 entry. The eligibility conditions and the 7 year duration in this entry are unverified pending recheck.$src$,
    review_by = date '2026-08-31',
    updated_at = now()
where slug = 'article-5c-50-percent-reduction';


-- =====================================================================
-- BLOCK 3 of 3: enfia-property-tax-and-reductions
-- Two replacements: the E9 deadline paragraph and the capital gains line.
-- =====================================================================

do $$
declare v_e9 int; v_cg int;
begin
    select count(*) into v_e9 from public.knowledge_base
     where slug = 'enfia-property-tax-and-reductions'
       and content like '%E9 CORRECTION DEADLINES (reconciled)%';
    select count(*) into v_cg from public.knowledge_base
     where slug = 'enfia-property-tax-and-reductions'
       and content like '%PROPERTY CAPITAL GAINS: AADE notes%';
    if v_e9 <> 1 then raise notice 'enfia: E9 anchor not found (hits=%).', v_e9; end if;
    if v_cg <> 1 then raise notice 'enfia: capital gains anchor not found (hits=%).', v_cg; end if;
end $$;

update public.knowledge_base
set content = replace(
        replace(
            content,
            $o1$E9 CORRECTION DEADLINES (reconciled): 31/01/2026 was the standard deadline to record 2025 property changes in the original E9 for ENFIA 2026. 31/07/2026 is a separate, later penalty-free amended-E9 window specifically to correct data errors (e.g. electricity-supply-number mismatches) blocking reductions such as the small-settlement 50%. Not a conflict, two different deadlines for two different purposes.$o1$,
            $n1$E9 CORRECTION DEADLINES (UNVERIFIED, flagged 2026-07-27): recorded as 31/01/2026 for the standard deadline to enter 2025 property changes in the original E9 for ENFIA 2026, and 31/07/2026 for a separate penalty-free amended-E9 window to correct data errors (e.g. electricity-supply-number mismatches) that block reductions such as the small-settlement 50%. The word "reconciled" previously attached here came from the 2026-07-19 pass, which is known to have recorded confirmations it did not carry out. Neither date has been independently checked. 31/07/2026 is imminent, so if a live case turns on it, verify on myAADE before saying anything to the client.$n1$
        ),
        $o2$PROPERTY CAPITAL GAINS: AADE notes tax on transfers of immovable property for consideration is suspended until 31 December 2026 under Article 41 of the Income Tax Code.$o2$,
        $n2$PROPERTY CAPITAL GAINS (UNVERIFIED, flagged 2026-07-27): recorded as suspended until 31 December 2026 under Article 41 of the Income Tax Code. This suspension has been extended repeatedly in past years and the current end date has not been checked against a primary source. It gets stated to clients who are selling, which makes it one of the higher risk lines in the knowledge base. Verify before use.$n2$
    ),
    source = source || $src$ CAUTION 2026-07-27: E9 deadline reconciliation and small-settlement scope came from a pass proven unreliable on the E1 entry. Capital gains suspension end date unverified.$src$,
    review_by = date '2026-08-31',
    updated_at = now()
where slug = 'enfia-property-tax-and-reductions';
