-- 20260727230000_article_5a_statute_check.sql
--
-- Repo: dimitriosg/portal-mygreektax  ->  supabase/migrations/
-- Database: igfwqgiscjpshxfsyunq
--
-- WHY
-- 20260727210000 flagged article-5a-non-dom-regime as unverified. The entry has now been
-- checked line by line against the codified text of article 5A of the Income Tax Code
-- (Law 4172/2013), read 2026-07-27. Most figures hold. One does not, and it is the one
-- most likely to be said to a prospective client.
--
-- THE FINDING
-- The entry states the application is filed "by 31 March of the relevant tax year".
-- The codified text of paragraph 3 no longer contains any date. Paragraph 10 now lists
-- "the deadline for submitting the application of paragraph 3" among the matters set by
-- decision of the Governor of AADE. The deadline has moved out of the statute and into a
-- Governor's decision. Two older renderings of the same article (a search engine cache of
-- the same page, and a PDF dated December 2025) still show the 31 March wording, so the
-- change is recent. The amending law has NOT been identified. Until it is, and until the
-- current Governor's decision is read, no date may be quoted.
--
-- ALSO CORRECTED: three material omissions found in the statute and absent from the entry.
--
-- CONFIRMED AGAINST THE STATUTE and left as-is: 7 of 8 years non-residence; 500,000 euro
-- minimum; completion within 3 years of the application; 100,000 euro flat annual tax;
-- 20,000 euro per relative; 15 tax years maximum, non-extendable; the two revocation
-- triggers; the waiver for holders of an investment-activity residence permit.
--
-- No DDL. Single qualified UPDATE. No-op on re-run.

do $$
declare v_hits int;
begin
    select count(*) into v_hits from public.knowledge_base
     where slug = 'article-5a-non-dom-regime'
       and content like '%to the competent KEFODE service by 31 March%';
    if v_hits <> 1 then
        raise notice 'article-5a: 31 March anchor not found (hits=%). Check manually.', v_hits;
    end if;
end $$;

update public.knowledge_base
set content =
    replace(
      replace(
        replace(
          replace(
            content,
            $o1$- Eligibility: the person must NOT have been a Greek tax resident for 7 of the 8 tax years before the move, AND must invest at least 500,000 euro in Greek real estate, businesses, securities, or shares (directly or via a controlled entity), completed within 3 years of applying. The investment condition is waived for holders of an "investment activity" residence permit under Article 16 of Law 4251/2014.$o1$,
            $n1$- Eligibility (CONFIRMED against the codified statute, read 2026-07-27), cumulative: (a) not a Greek tax resident in 7 of the 8 years before the transfer; and (b) proof of investment of at least 500,000 euro in Greek real estate, businesses, securities, shares or holdings in entities seated in Greece. IMPORTANT, previously missing here: the investment may be made by the person THEMSELVES, by a RELATIVE within the meaning of article 2(f), or through a legal person or entity in which they hold the majority of shares or holdings. The investment must be completed within 3 years of the date the application is submitted. The investment condition does not apply to a person who has obtained and maintains a residence permit for investment activity under article 16 of Law 4251/2014, as in force. CAUTION on that cross-reference: the statute still points at Law 4251/2014, which has been superseded as the Migration Code by Law 5038/2023. Whether a permit issued under the newer code satisfies this condition is an open question and is exactly the point raised by the pending FIP D1 visa candidates. Partner question, do not answer it from this entry.$n1$
          ),
          $o2$- The tax: a fixed annual tax of 100,000 euro on all foreign-source income, whatever the actual amount, for up to 15 tax years. An additional 20,000 euro per year applies for each qualifying relative included (spouse, direct ascendants/descendants, civil partners).$o2$,
          $n2$- The tax (CONFIRMED against the codified statute, read 2026-07-27): a flat 100,000 euro per tax year on foreign-arising income, irrespective of its amount. An extra 20,000 euro per tax year for each relative the regime is extended to, and for those relatives the gift, inheritance and parental-gift tax provisions do not apply. Duration is 15 tax years and cannot be extended beyond that. Extension to a relative may be requested at the outset or later, and then runs only for the years remaining of the 15. PAYMENT MECHANICS, previously missing here and asked by every client: the flat tax is paid each tax year in ONE instalment by the last working day of December. It cannot be offset against other tax liabilities or against any credit balance. Tax paid abroad on the income covered by the regime is NOT creditable against any Greek tax liability. The exact scope of "relative" is defined by article 2(f), which has not been read; the parenthetical gloss previously given here (spouse, ascendants, descendants, civil partners) is unverified.$n2$
        ),
        $o3$- Application: filed via myAADE (My Requests) to the competent KEFODE service by 31 March of the relevant tax year, with evidence the required capital was transferred to a Greek financial institution.$o3$,
        $n3$- Application: filed via myAADE (My Requests) to the competent KEFODE service, accompanied by proof that the minimum investment amount has been transferred to an account at a financial institution established in Greece. A person who already transferred their tax residence to Greece during the PREVIOUS tax year may also apply. DEADLINE CONTESTED, DO NOT QUOTE A DATE (flagged 2026-07-27): this entry previously stated 31 March of the relevant tax year. The codified text of paragraph 3 no longer contains any date, and paragraph 10 now delegates "the deadline for submitting the application of paragraph 3" to a decision of the Governor of AADE. Older renderings of the article still show 31 March, so the change is recent, but the amending law has not been identified and the current Governor's decision has not been read. Until both are, tell the client the deadline is early in the tax year and that we are confirming the exact date with the licensed partner. Never state a date.$n3$
      ),
      $o4$PROVENANCE (revised 2026-07-27). The line previously here asserted that the eligibility, tax treatment and application mechanics above were AADE-primary-sourced and confirmed. That assertion came from the verification pass of 2026-07-19, which is known to have recorded a confirmation it did not carry out. Treat the mechanics above as drafted from AADE guidance but NOT independently verified, in particular the 31 March application deadline, the 500,000 euro investment threshold, the 100,000 euro flat tax, the 20,000 euro per relative, the 15 year duration and the 7 of 8 years non-residence test. Individual eligibility, investment structuring and treaty interaction were always partner-confirmation items and remain so. Do not tell a client they qualify and do not quote them a figure.$o4$,
      $n4$PROVENANCE (checked 2026-07-27 against the codified text of article 5A of Law 4172/2013). The figures above are now statute-verified: the 7 of 8 years test, the 500,000 euro minimum, completion within 3 years, the 100,000 euro flat tax, the 20,000 euro per relative, the 15 year cap, the December single payment, the non-creditability of foreign tax, and both revocation triggers. The application deadline is NOT verified and is flagged separately above. The article 2(f) definition of relative and the article 16 / Law 5038/2023 cross-reference question are also open. Individual eligibility, investment structuring and treaty interaction were always partner-confirmation items and remain so: a statute-verified figure is not a determination that a particular client qualifies. Do not tell a client they qualify.$n4$
    ),
    source = source || $src$ UPDATE 2026-07-27: checked line by line against the codified text of art. 5A Law 4172/2013. Figures verified. Application deadline found NOT to be in the statute any more (delegated to an AADE Governor decision by para 10) and flagged as contested. Amending law not yet identified.$src$,
    updated_at = now()
where slug = 'article-5a-non-dom-regime';

-- review_by stays 2026-08-31. The deadline question is open and needs closing before then.
