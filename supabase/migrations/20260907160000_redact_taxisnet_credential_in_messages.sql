-- Redact the one plaintext TAXISnet credential stored in public.messages.
--
-- WHY
-- public.messages holds Gmail headers plus a body, written today by n8n workflow
-- uSQOKDb9YLNxiIIT ("20 · Sync Gmail to messages"), which caps body at the first
-- 300 characters of the Gmail snippet. Seven rows dated 05/07/2026 predate that
-- workflow and carry full message bodies from an earlier import. One of those
-- seven -- Gmail message 19f279951856aa83, an inbound client reply timestamped
-- 03/07/2026 13:49 UTC -- contains a TAXISnet username and password that the
-- client typed into an email in plaintext.
--
-- It is readable from the portal in two places, both admin-only: the lead dialog
-- on /leads has rendered messages.body since long before this migration
-- (src/lib/leads.functions.ts selects *, src/routes/leads.tsx renders the body),
-- and public.v_case_messages surfaces the same row on the correspondence page.
-- Neither is a new exposure. The credential simply should not be in the database.
--
-- WHAT THIS DOES
-- Replaces the value following each "Username:" / "Password:" label on that one
-- row with a redaction marker, leaving the rest of the message intact so the
-- thread stays readable in both surfaces above.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--
--   * It does not match on the credential value. A pattern built from the secret
--     would put the secret into this file, into git history, and into every
--     checkout of this repository -- which is the problem, not the fix. The
--     pattern keys on the label instead, so this file is safe to read.
--
--   * It does not widen beyond this row. A keyword sweep of the table on
--     taxisnet / password / κωδικ / συνθηματικ returns nine other rows, and a
--     wider sweep adding κλειδάριθμ, credential, username, login, pin, otp and
--     πρόσβασ returns one more. All ten were read individually on 07/09/2026 and
--     none holds a credential: they discuss passwords ("I'm not sure how to
--     complete the step on TAXISnet"), request them ("TAXISnet credentials
--     (username, password), and your consent"), refer to a job code
--     ("Κωδικός εργασίας"), state that someone already holds codes
--     ("ΕΧΩ ΚΩΔΙΚΟΥΣ"), or are an AADE one-time email-confirmation code and an
--     Instagram login notice. Rewriting those would destroy readable
--     correspondence and protect nothing.
--
--   * It does not touch the AFM and AMKA in the same message. Those are
--     identifiers, not credentials, and public.clients already stores the AFM as
--     ordinary case data.
--
--   * It adds no trigger. Nothing in public writes to this table from SQL -- no
--     function in the schema inserts into public.messages -- so the write path
--     to guard is the n8n workflow, which is where the masking went instead.
--
-- IDEMPOTENT
-- The update applies only where the rewrite would actually change the row, so a
-- re-run is a no-op. The rewrite is a fixpoint by construction: applying it to
-- an already-redacted body reproduces that body exactly, because the marker
-- itself matches the pattern and is replaced by an identical marker. Verified
-- against the live row before this file was written.
--
-- NOT REVERSIBLE, by design. The original text remains in the Gmail mailbox the
-- sync reads from, but it is not recoverable from Supabase once this has run.
--
-- No schema object changes here, so there is no `notify pgrst` at the end. This
-- migration is DML only and PostgREST has nothing to reload.

update public.messages as m
   set body = r.new_body
  from (
         select id,
                regexp_replace(
                  body,
                  '((?:username|password)[[:blank:]]*:[[:blank:]]*)[^\r\n]*',
                  '\1[redacted 2026-09-07]',
                  'gi'
                ) as new_body
           from public.messages
          where message_id = '19f279951856aa83'
       ) as r
 where m.id = r.id
   and m.body is distinct from r.new_body;
