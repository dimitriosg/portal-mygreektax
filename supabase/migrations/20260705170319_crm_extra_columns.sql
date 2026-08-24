alter table public.clients          add column if not exists client_visible_note text;
alter table public.clients          add column if not exists thread_id text;
alter table public.service_catalog  add column if not exists notes text;
alter table public.accountants      add column if not exists partner_progress_notes text;
alter table public.accountants      add column if not exists current_workload numeric;
