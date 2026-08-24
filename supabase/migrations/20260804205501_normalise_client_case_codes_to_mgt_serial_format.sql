-- Normalise clients.case_code to the MGT-CSnnn-CLTnnnn format.
--
-- Two groups are corrected here:
--   1. Legacy Airtable-era codes (JB110, VV-26, KG-26, FR-AB-26, CZ-LM-26)
--      and one typo (MGT-CS0001-CLT0030, four digits instead of three).
--   2. Two codes that conflicted with the resolver-generated serial on
--      brain_conversations: CLT0011 and CLT0012 carried CS002 and CS003,
--      but no such conversation exists. CS001 is the real case in both.
--
-- The previous value is appended to clients.notes so old email subjects
-- carrying the legacy code remain traceable.
--
-- Idempotent: the WHERE clause matches on the old value, so a second run
-- updates nothing and appends nothing.

with mapping(client_code, old_code, new_code) as (
  values
    ('CLT0008-IS', 'JB110',              'MGT-CS001-CLT0008'),
    ('CLT0009-NE', 'VV-26',              'MGT-CS001-CLT0009'),
    ('CLT0011-PL', 'MGT-CS002-CLT0011',  'MGT-CS001-CLT0011'),
    ('CLT0012-SP', 'MGT-CS003-CLT0012',  'MGT-CS001-CLT0012'),
    ('CLT0014-SE', 'KG-26',              'MGT-CS001-CLT0014'),
    ('CLT0016-FR', 'FR-AB-26',           'MGT-CS001-CLT0016'),
    ('CLT0026-PL', 'CZ-LM-26',           'MGT-CS001-CLT0026'),
    ('CLT0030-IS', 'MGT-CS0001-CLT0030', 'MGT-CS001-CLT0030')
)
update public.clients c
set
  case_code = m.new_code,
  notes = case
            when coalesce(nullif(btrim(c.notes), ''), '') = ''
              then 'Former case code: ' || m.old_code || ' (renamed 04/08/2026).'
            else c.notes || chr(10) || 'Former case code: ' || m.old_code || ' (renamed 04/08/2026).'
          end
from mapping m
where c.client_code = m.client_code
  and c.case_code = m.old_code;
