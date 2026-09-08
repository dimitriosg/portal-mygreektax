-- Redact stored credentials across the case stores, and stop new ones landing.
--
-- WHY
-- Clients type their TAXISnet login into email. Between 22/07/2026 and
-- 07/09/2026 at least five distinct credentials arrived that way, and because a
-- reply quotes the message it answers, each spread across a whole thread:
-- 76 occurrences over 73 rows of public.brain_events, plus derived copies in
-- case_notes, case_summaries and case_drafts.
--
-- Three shapes occur, and they are not one problem:
--
--   1. A client sends theirs   "My myAADE (Taxisnet) credentials are:
--                               Login: ...  Password: ..."
--   2. We quote it back        "Below is a summary of the details provided:
--                               ... Username : ..."
--   3. WE ORIGINATE ONE        "Your access is live. Here are your
--                               credentials. Username: ... Password: ..."
--
-- The third is a process problem this migration cannot fix, and is recorded
-- because a reader who saw only the redaction would conclude the system merely
-- relays what clients send it. It does not.
--
-- Every affected row is readable by any portal admin -- brain_events carries
-- RLS with a has_role(auth.uid(), 'admin') policy -- and is rendered in the
-- case thread, which keeps the full email exactly as imported.
--
-- WHAT THIS DOES
--   1. public.redact_credentials(text): replaces the value after a credential
--      label, leaving the label and everything else intact.
--   2. BEFORE INSERT OR UPDATE triggers applying it to brain_events
--      (body_text, subject), case_notes.body, case_summaries.summary and
--      case_drafts (proposed_draft, internal_notes).
--   3. A backfill over the rows that already carry one.
--   4. A targeted reset of two AI summaries that state a credential in prose,
--      which no label-keyed pattern can reach. See below.
--
-- WHY A TRIGGER HERE, WHEN 20260907160000 ARGUED AGAINST ONE
-- That migration guarded public.messages, where no schema function writes and a
-- single n8n workflow is the only producer, so a trigger would have defended a
-- door nobody uses. This is the opposite case: at least four producers -- two
-- webhooks, resolve_case_for_inbound, and the Brain's summarisation path -- and
-- it was the summarisation path, touching no webhook at all, that put a
-- credential into case_summaries. A guard in the webhooks alone would have
-- missed the row that proves the guard is needed. The TypeScript half lives in
-- src/lib/redact-credentials.ts, where a developer editing the webhooks will
-- see it; the trigger is what covers everything else.
--
-- MATCHING
-- Keys on the LABEL, never on a value. A pattern built from a secret would put
-- the secret in this file, in git history and in every checkout. Labels are the
-- ones that occur here -- Login, Username, Password, Passcode, KLEIDARITHMOS in
-- Latin as well as Greek -- and the qualifier list is deliberately short so
-- that "Κωδικός εργασίας: 0043", a job code the case page needs, is left alone
-- while "Κωδικός πρόσβασης" is caught.
--
-- THE VALUE MAY SIT ON THE NEXT LINE, WITH TWO RESTRICTIONS
-- The structured case note writes the label as a heading:
--
--     TAXISnet PASSWORD:
--     <value>
--
-- so the pattern allows exactly one newline after the separator. It refuses
-- when the following line begins with ">", because in quoted email the next
-- line is "> <value>" and a pattern that crossed into it would replace the
-- quote marker and leave the secret, having mangled the thread on the way. And
-- allowing only one newline stops a label followed by a blank line from
-- swallowing the first word of the next paragraph. All three behaviours are
-- asserted in src/lib/redact-credentials.test.ts and were checked against the
-- live rows before this file was written.
--
-- KNOWN COLLATERAL, accepted: one row carries a URL query string with
-- `username=` followed by an address, and the rewrite takes that parameter. It
-- is the portal owner's own address in a dead login link, and a pattern that
-- ignored `=` would stop catching `password=` in a URL, which is a real leak
-- shape. Losing the parameter is the cheaper error.
--
-- IDEMPOTENT. The marker matches the pattern and is replaced by an identical
-- marker, so the rewrite is a fixpoint, and each statement touches only rows it
-- would actually change. Re-running reports 0.
--
-- NOT REVERSIBLE. The originals remain in the Gmail mailbox these were imported
-- from; they are not recoverable from Supabase once this has run.

create or replace function public.redact_credentials(p_text text)
returns text
language sql
immutable
as $$
  select case
    when p_text is null then null
    else regexp_replace(
           p_text,
           '(\m(?:login|user(?:[[:blank:]]?name)?|pass(?:word|code)?|pwd|pin|otp'
        || '|κωδικ[^[:space:]:=]*|συνθηματικ[^[:space:]:=]*|κλειδ[αά]ριθμ[^[:space:]:=]*'
        || '|kleidarithmos'
        || '|[οό]νομα[[:blank:]]+χρ[ηή]στη)'
        || '(?:[[:blank:]]+(?:πρ[οό]σβασης|χρ[ηή]στη|εισ[οό]δου|ασφαλε[ιί]ας))?'
        || '[[:blank:]]*[:=][[:blank:]]*(?:\r?\n[[:blank:]]*)?)(?!>)(?!\[redacted)[^[:space:]]+',
           '\1[redacted]',
           'gi')
  end;
$$;

comment on function public.redact_credentials(text) is
  'Replaces the value after a credential label (Password:, Κωδικός πρόσβασης:, KLEIDARITHMOS:, …) with [redacted]. Keys on the label, never on a value. Takes a value on the next line unless that line is quoted. Idempotent. Mirrored in TypeScript at src/lib/redact-credentials.ts.';

create or replace function public.tg_redact_brain_events()
returns trigger language plpgsql as $$
begin
  new.body_text := public.redact_credentials(new.body_text);
  new.subject   := public.redact_credentials(new.subject);
  return new;
end;
$$;

create or replace function public.tg_redact_case_notes()
returns trigger language plpgsql as $$
begin
  new.body := public.redact_credentials(new.body);
  return new;
end;
$$;

create or replace function public.tg_redact_case_summaries()
returns trigger language plpgsql as $$
begin
  new.summary := public.redact_credentials(new.summary);
  return new;
end;
$$;

create or replace function public.tg_redact_case_drafts()
returns trigger language plpgsql as $$
begin
  new.proposed_draft := public.redact_credentials(new.proposed_draft);
  new.internal_notes := public.redact_credentials(new.internal_notes);
  return new;
end;
$$;

drop trigger if exists redact_credentials_before_write on public.brain_events;
create trigger redact_credentials_before_write
  before insert or update on public.brain_events
  for each row execute function public.tg_redact_brain_events();

drop trigger if exists redact_credentials_before_write on public.case_notes;
create trigger redact_credentials_before_write
  before insert or update on public.case_notes
  for each row execute function public.tg_redact_case_notes();

drop trigger if exists redact_credentials_before_write on public.case_summaries;
create trigger redact_credentials_before_write
  before insert or update on public.case_summaries
  for each row execute function public.tg_redact_case_summaries();

drop trigger if exists redact_credentials_before_write on public.case_drafts;
create trigger redact_credentials_before_write
  before insert or update on public.case_drafts
  for each row execute function public.tg_redact_case_drafts();

-- Backfill. Each statement is qualified to the rows the rewrite would change,
-- so a second run reports 0.

update public.brain_events
   set body_text = public.redact_credentials(body_text),
       subject   = public.redact_credentials(subject)
 where body_text is distinct from public.redact_credentials(body_text)
    or subject   is distinct from public.redact_credentials(subject);

update public.case_notes
   set body = public.redact_credentials(body)
 where body is distinct from public.redact_credentials(body);

update public.case_drafts
   set proposed_draft = public.redact_credentials(proposed_draft),
       internal_notes = public.redact_credentials(internal_notes)
 where proposed_draft is distinct from public.redact_credentials(proposed_draft)
    or internal_notes is distinct from public.redact_credentials(internal_notes);

-- THE ONE CASE THE PATTERN CANNOT REACH
--
-- Two AI summaries state a credential in prose, with no separator at all:
--
--     "TAXISnet now live: username <value>, password <value>, kleidarithmos
--      <value>. Client has given written consent for us to hold credentials."
--
-- A label-keyed rewrite needs a ":" or "=" and there is none, and a rule that
-- masked the token after a bare label word would rewrite ordinary prose --
-- "username and password" becomes "username [redacted] password" -- across
-- every summary in the table. Two of the four summaries that match such a rule
-- are exactly that, plain English, and mangling them protects nothing.
--
-- So these two rows are reset instead of rewritten. A case summary is a DERIVED
-- artifact: /webhooks/summarize-case regenerates it from the case, and after
-- the backfill above the events it reads are already redacted, so a regenerated
-- summary cannot restate the credential. Nothing is lost that does not come
-- back, which is why this is a reset and not a redaction.
--
-- Selection is by value SHAPE, never by value: a credential label followed by a
-- token of six or more characters containing a digit. That picks the two rows
-- holding real credentials and leaves the two that merely contain the words.
-- summary is NOT NULL, so the row is replaced rather than deleted, which also
-- leaves the case page something to explain itself with.

update public.case_summaries
   set summary = 'Summary cleared on 2026-09-08: it stated a client credential in prose, which no redaction pattern can safely remove. Press Summarise on the case to regenerate it from the (now redacted) history.',
       event_count = null
 where summary ~* '\m(?:login|username|password|passcode|kleidarithmos|κλειδάριθμος|συνθηματικό)[[:blank:]]+(?=[^[:space:],;.]*[0-9])[^[:space:],;.]{6,}';

notify pgrst, 'reload schema';
