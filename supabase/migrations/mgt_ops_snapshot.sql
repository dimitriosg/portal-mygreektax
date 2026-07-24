create or replace function public.mgt_ops_snapshot()
returns jsonb
language sql
stable
as $$
  with last_ev as (
    select distinct on (be.conversation_id)
           be.conversation_id, be.direction, be.occurred_at
    from public.brain_events be
    order by be.conversation_id, be.occurred_at desc
  ),
  pending as (
    select bc.case_serial_id, le.occurred_at
    from last_ev le
    join public.brain_conversations bc on bc.id = le.conversation_id
    where le.direction = 'inbound' and bc.archived_at is null
  )
  select jsonb_build_object(
    'generated_at', now(),
    'leads_new_24h', (select count(*) from public.clients where created_at > now() - interval '24 hours'),
    'leads_new_7d',  (select count(*) from public.clients where created_at > now() - interval '7 days'),
    'leads_by_status', coalesce((select jsonb_object_agg(coalesce(status,'unset'), c)
                                 from (select status, count(*) c from public.clients group by status) s), '{}'::jsonb),
    'jobs_by_status',  coalesce((select jsonb_object_agg(coalesce(status,'unset'), c)
                                 from (select status, count(*) c from public.jobs group by status) s), '{}'::jsonb),
    'cases_awaiting_reply', (select count(*) from pending),
    'cases_awaiting_reply_list', coalesce((select jsonb_agg(x) from
        (select * from pending order by occurred_at asc limit 10) x), '[]'::jsonb),
    'email_sent_24h', (select count(*) from public.email_send_log where created_at > now() - interval '24 hours'),
    'email_failures_24h', (select count(*) from public.email_send_log
                           where created_at > now() - interval '24 hours' and status ilike '%fail%'),
    'knowledge_candidates_pending', (select count(*) from public.knowledge_candidates where reviewed_at is null),
    'newsletter_subs_7d', (select count(*) from public.newsletter_subscribers where created_at > now() - interval '7 days')
  );
$$;

revoke all on function public.mgt_ops_snapshot() from public, anon, authenticated;
grant execute on function public.mgt_ops_snapshot() to service_role;
