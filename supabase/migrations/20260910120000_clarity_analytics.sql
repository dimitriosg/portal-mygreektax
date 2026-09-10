-- Clarity analytics history for MyGreekTax
-- Two tables: raw API snapshots (lossless) + a flattened daily rollup for charting.
-- Written daily by n8n via the n8n_readonly role; read by the portal admin area.
-- No sensitive columns here, so table-level grants rather than column-level.

-- 1. Raw snapshots -----------------------------------------------------------

create table if not exists public.clarity_snapshots (
  id            uuid primary key default gen_random_uuid(),
  clarity_project text not null default 'x8lw4ctc0a',
  captured_for  date not null,                  -- the day the data covers
  num_of_days   smallint not null default 1,    -- Clarity numOfDays param
  dimensions    text not null default '',       -- '' | 'URL' | 'Source,Medium,Campaign'
  payload       jsonb not null,                 -- verbatim API response
  fetched_at    timestamptz not null default now()
);

create unique index if not exists clarity_snapshots_uniq
  on public.clarity_snapshots (clarity_project, captured_for, num_of_days, dimensions);

create index if not exists clarity_snapshots_captured_for_idx
  on public.clarity_snapshots (captured_for desc);

-- 2. Flattened daily rollup --------------------------------------------------
-- url = '' means the site-wide total for that day.

create table if not exists public.clarity_daily (
  captured_for               date not null,
  url                        text not null default '',
  sessions                   integer,
  bot_sessions               integer,
  distinct_users             integer,
  pages_per_session          numeric,
  avg_scroll_depth           numeric,
  engagement_total_seconds   integer,
  engagement_active_seconds  integer,
  dead_clicks                integer,
  dead_click_session_pct     numeric,
  rage_clicks                integer,
  quickback_clicks           integer,
  script_errors              integer,
  error_clicks               integer,
  excessive_scrolls          integer,
  updated_at                 timestamptz not null default now(),
  primary key (captured_for, url)
);

create index if not exists clarity_daily_url_idx
  on public.clarity_daily (url, captured_for desc);

-- 3. RLS ---------------------------------------------------------------------

alter table public.clarity_snapshots enable row level security;
alter table public.clarity_daily     enable row level security;

-- n8n writes both tables (insert + update for upsert, select to check what exists)

grant select, insert, update on public.clarity_snapshots to n8n_readonly;
grant select, insert, update on public.clarity_daily     to n8n_readonly;

drop policy if exists n8n_readonly_select_clarity_snapshots on public.clarity_snapshots;
create policy n8n_readonly_select_clarity_snapshots
  on public.clarity_snapshots for select to n8n_readonly using (true);

drop policy if exists n8n_readonly_insert_clarity_snapshots on public.clarity_snapshots;
create policy n8n_readonly_insert_clarity_snapshots
  on public.clarity_snapshots for insert to n8n_readonly with check (true);

drop policy if exists n8n_readonly_update_clarity_snapshots on public.clarity_snapshots;
create policy n8n_readonly_update_clarity_snapshots
  on public.clarity_snapshots for update to n8n_readonly using (true) with check (true);

drop policy if exists n8n_readonly_select_clarity_daily on public.clarity_daily;
create policy n8n_readonly_select_clarity_daily
  on public.clarity_daily for select to n8n_readonly using (true);

drop policy if exists n8n_readonly_insert_clarity_daily on public.clarity_daily;
create policy n8n_readonly_insert_clarity_daily
  on public.clarity_daily for insert to n8n_readonly with check (true);

drop policy if exists n8n_readonly_update_clarity_daily on public.clarity_daily;
create policy n8n_readonly_update_clarity_daily
  on public.clarity_daily for update to n8n_readonly using (true) with check (true);

-- Portal admin area reads the rollup (and the raw table, for debugging)

grant select on public.clarity_snapshots to authenticated;
grant select on public.clarity_daily     to authenticated;

drop policy if exists admin_select_clarity_snapshots on public.clarity_snapshots;
create policy admin_select_clarity_snapshots
  on public.clarity_snapshots for select to authenticated
  using (public.has_role(auth.uid(), 'admin'::app_role));

drop policy if exists admin_select_clarity_daily on public.clarity_daily;
create policy admin_select_clarity_daily
  on public.clarity_daily for select to authenticated
  using (public.has_role(auth.uid(), 'admin'::app_role));

notify pgrst, 'reload schema';
