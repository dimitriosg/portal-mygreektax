-- 20260727200000_e1_playbook_deadline_correction.sql
--
-- Repo: dimitriosg/portal-mygreektax  ->  supabase/migrations/
-- Database: igfwqgiscjpshxfsyunq
--
-- WHY
-- knowledge_base row 'e1-filing-2026-playbook' is canonical + is_active + client_safe,
-- so it is currently injected into every Brain prompt. It states 15/07/2026 as the final
-- E1 filing deadline for individuals. That deadline was extended to 24/07/2026 23:59:59
-- for both individuals and legal persons by AADE Decision A.1140/2026.
--
-- The row also carries a line asserting the deadlines were "independently confirmed
-- against AADE's official E1 page" on 2026-07-19. The extension had already been
-- announced by then, so that assertion is false and the pass that wrote it did not
-- open the source it cited. The same pass (updated_at 2026-07-19 20:39:37) also touched
-- article-5a-non-dom-regime, article-5c-50-percent-reduction, digital-nomad-visa-tax and
-- enfia-property-tax-and-reductions. Those are handled in later migrations.
--
-- SCOPE
-- Data only. No DDL, so no `notify pgrst, 'reload schema'` needed.
-- Qualified UPDATE against a single slug. Safe to re-run: replace() is a no-op once applied.

-- Pre-flight: warn (do not fail) if the expected anchor text is missing.
do $$
declare
    v_hits int;
begin
    select count(*)
      into v_hits
      from public.knowledge_base
     where slug = 'e1-filing-2026-playbook'
       and content like '%15/07/2026: final filing deadline for individuals%';

    if v_hits <> 1 then
        raise notice 'e1-filing-2026-playbook: anchor text not found (hits=%). Either already corrected or the content has drifted. The UPDATE below will be a no-op on that fragment. Verify manually.', v_hits;
    end if;
end $$;

update public.knowledge_base
set
    content = replace(
                replace(
                  replace(
                    content,
                    $o1$- 15/07/2026: final filing deadline for individuals, and the 2 percent discount tier.$o1$,
                    $n1$- 15/07/2026: ORIGINAL final filing deadline for individuals. SUPERSEDED. Extended to 24/07/2026 23:59:59, for both individuals and legal persons, by AADE Decision A.1140/2026. The 2 percent full-payment discount attaches to filing by 24/07/2026 with the whole liability paid in one sum by 31/07/2026. Never quote 15/07/2026 to a client as the tax year 2025 deadline.$n1$
                  ),
                  $o2$- 31/07/2026: filing deadline for individuals participating in legal entities with single-entry books;$o2$,
                  $n2$- 31/07/2026: filing deadline for individuals participating in legal entities with single-entry books (UNVERIFIED after the 24/07 extension, which moved several downstream dates. Confirm against AADE before stating this to anyone);$n2$
                ),
                $o3$Deadlines above independently confirmed against AADE's official E1 page and AADE instructions (verified 2026-07-19): 15/07 final individual deadline, 31/07 for single-entry-book participants, 8 monthly instalments starting last working day of July, discount tiers 4%/3%/2% by 30/04, 15/06, 15/07 respectively.$o3$,
                $n3$PROVENANCE WARNING (recorded 2026-07-27). The line previously in this position claimed these deadlines had been independently confirmed against AADE's official E1 page on 2026-07-19. That claim was false: the 24/07/2026 extension had already been announced before that date and was missed, so the verification pass did not open the source it named. Treat every unmarked date in this entry as unverified until individually rechecked against a primary AADE source. CONFIRMED as at 2026-07-27: the extension to 24/07/2026 (AADE Decision A.1140/2026) and the 31/07/2026 first-instalment date. NOT RECHECKED: the 31/07 single-entry-book participant deadline, the 8-instalment schedule, the 31/12/2026 amended-return deadline, and the 4%/3%/2% discount tiers as they applied earlier in the season.$n3$
              ),
    source = $src$Internal playbook v3.2 (2026-06-23). Filing deadline corrected 2026-07-27 against AADE Decision A.1140/2026 (extension to 24/07/2026). Brackets per Law 4172/2013 codified by Law 4799/2021. A.1062/2026 retained as the source of the original schedule. CAUTION: the "independent confirmation" previously recorded against this entry on 2026-07-19 was unreliable, see the provenance warning in the content.$src$,
    review_by = date '2026-08-31',
    updated_at = now()
where slug = 'e1-filing-2026-playbook';

-- Status deliberately left as 'canonical'.
-- The workflow, code set, brackets and intake sections are internal playbook material and
-- remain useful. Demoting to 'draft' would pull the whole entry out of Brain injection and
-- leave back-year and amended-return cases with no E1 guidance at all. The unreliable parts
-- are now marked in place instead. Revisit at review_by.
