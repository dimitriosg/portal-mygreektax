-- Adds intake_channel to public.clients.
-- source stays as "how they heard about us" (Google, referral, AI, word of mouth).
-- intake_channel is "how the record arrived" (chat_widget, contact_form, email, manual).

alter table public.clients
  add column if not exists intake_channel text;

comment on column public.clients.intake_channel is
  'How this record arrived: chat_widget, contact_form, email, manual. Distinct from source, which is how the person heard about MGT.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'clients_intake_channel_check'
  ) then
    alter table public.clients
      add constraint clients_intake_channel_check
      check (intake_channel is null or intake_channel in
        ('chat_widget','contact_form','email','manual'));
  end if;
end $$;

create index if not exists clients_intake_channel_idx
  on public.clients (intake_channel);

notify pgrst, 'reload schema';
