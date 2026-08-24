-- 20260823023453_stage_sync_respects_deposit_gate.sql
--
-- recompute_client_stage() promoted a case to Active whenever any
-- non-cancelled job was unsettled -- including a job that merely records a
-- quoted price and has never been started. Creating a job therefore crossed
-- the deposit gate with no money involved.
--
-- This was not theoretical. activity_events records it 14 times in three
-- weeks, tagged via=job_sync, including Scott Hubbard going Potential ->
-- Active and skipping Quoted entirely. Three of the affected cases were
-- subsequently moved back to Quoted by hand.
--
-- The amount model added on 22 Aug (20260822220637) made this systematic
-- rather than occasional: jobs.client_fee became the only place a price
-- lives, so recording a quote now REQUIRES creating a job, which fires this
-- trigger. The previous escape hatch -- a quote_amount with no job -- is gone.
--
-- Split the two authorities along the line each is actually about:
--
--   payment   gates ENTRY to Active                    -> confirm_payment()
--   job flow  governs Active -> Delivered -> Complete   -> here
--
-- The only behavioural change: skip when every counted job is still Pending
-- or To Assign, which is precisely the state "quoted, not started". The row
-- lock, the settled/completed arithmetic and the activity_events audit entry
-- are all unchanged from the original.
--
-- Idempotent: create or replace. Signature, owner, volatility and search_path
-- match the function it replaces.

create or replace function public.recompute_client_stage(p_client_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_client public.clients%rowtype;
  v_total int;
  v_completed int;
  v_settled int;
  v_notstarted int;
  v_new text;
begin
  if p_client_id is null then
    return;
  end if;

  -- Lock the client row first so concurrent job writes for the same client
  -- serialize their recomputations instead of aggregating stale snapshots
  -- (e.g. two transactions each completing one of the last two open jobs).
  select * into v_client from public.clients where id = p_client_id for update;
  if not found then
    return;  -- client mid-deletion: nothing to sync
  end if;

  select count(*),
         count(*) filter (where status = 'Completed'),
         count(*) filter (where status in ('Delivered', 'Invoiced', 'Completed')),
         count(*) filter (where status in ('Pending', 'To Assign'))
    into v_total, v_completed, v_settled, v_notstarted
    from public.jobs
   where client_id = p_client_id
     and status is distinct from 'Cancelled / NMF';

  if v_total = 0 then
    return;  -- no counted jobs: stage stays manually managed
  end if;

  -- Every counted job is still Pending or To Assign: the work is quoted, not
  -- started. Entry to Active belongs to the deposit gate, not to this trigger.
  -- Without this, minting a quote promotes an unpaid case to Active.
  if v_notstarted = v_total then
    return;
  end if;

  v_new := case
    when v_settled < v_total then 'Active'
    when v_completed = v_total then 'Complete'
    else 'Delivered'
  end;

  if v_new is distinct from v_client.stage then
    update public.clients set stage = v_new where id = p_client_id;

    insert into public.activity_events
      (event_type, actor_user_id, actor_email, actor_name, subject_label, metadata)
    values
      ('lead_stage_changed', null, null, 'System — job sync',
       coalesce(v_client.full_name, p_client_id::text),
       jsonb_build_object(
         'leadId', p_client_id::text,
         'field', 'Stage',
         'from', v_client.stage,
         'to', v_new,
         'via', 'job_sync'));
  end if;
end;
$$;

notify pgrst, 'reload schema';
