-- 20260819195806_payment_tokens_signals_payments.sql
--
-- Payment page, slice 1. Creates the three tables behind /pay/$token.
--
--   payment_tokens   one row per payment link you mint. Carries the amount.
--   payments         bank truth. Ships EMPTY and UNUSED until the balance poll
--                    exists; created now so payment_signals can carry its FK.
--   payment_signals  fast, untrusted pings: page views and "I've paid" taps.
--
-- Scope notes:
--   * Nothing here writes to or alters `clients`. This migration cannot affect
--     the pipeline.
--   * RLS is enabled with NO policies on all three tables. That is deliberate:
--     the anon and authenticated roles get nothing through PostgREST, and the
--     service role (which the portal Worker uses) bypasses RLS. Do not add a
--     policy without deciding who is meant to read these rows.
--   * Idempotent throughout; safe to re-run.
--
-- Ref: claude/payment-slice-1-scope.md, claude/payment-page-and-signals-plan.md

-- ---------------------------------------------------------------- tokens ----

create table if not exists public.payment_tokens (
  token                   text primary key,
  client_id               uuid not null references public.clients(id),
  case_code               text,
  amount                  numeric(12,2) not null,
  currency                text not null default 'EUR',
  kind                    text not null,
  note                    text,
  created_at              timestamptz not null default now(),
  created_by              uuid,
  expires_at              timestamptz,
  revoked_at              timestamptz,
  paid_at                 timestamptz,
  regenerated_from_token  text references public.payment_tokens(token),
  open_count              integer not null default 0,
  first_opened_at         timestamptz,
  last_opened_at          timestamptz,
  last_country            text
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payment_tokens_amount_positive') then
    alter table public.payment_tokens
      add constraint payment_tokens_amount_positive check (amount > 0);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payment_tokens_kind_check') then
    alter table public.payment_tokens
      add constraint payment_tokens_kind_check check (kind in ('deposit','balance','other'));
  end if;
end $$;

create index if not exists payment_tokens_client_id_idx on public.payment_tokens (client_id);
create index if not exists payment_tokens_case_code_idx on public.payment_tokens (case_code);
create index if not exists payment_tokens_open_idx on public.payment_tokens (created_at desc)
  where revoked_at is null and paid_at is null;

comment on table public.payment_tokens is
  'One payment link. amount is set at mint time because clients.deposit means "already paid", not "expected".';
comment on column public.payment_tokens.note is
  'Text prefilled into the Revolut.me note param. Case serial FIRST, field truncates around 64 chars.';

-- -------------------------------------------------------------- payments ----

create table if not exists public.payments (
  id                  uuid primary key default gen_random_uuid(),
  external_id         text not null,
  source              text not null,
  account_id          text,
  amount              numeric(12,2) not null,
  currency            text not null default 'EUR',
  received_at         timestamptz not null,
  payer_name          text,
  payer_reference     text,
  raw                 jsonb not null default '{}'::jsonb,
  client_id           uuid references public.clients(id),
  token               text references public.payment_tokens(token),
  match_confidence    text not null default 'none',
  kind                text,
  status              text not null default 'pending',
  reserved_at         timestamptz,
  confirmed_at        timestamptz,
  telegram_message_id bigint,
  created_at          timestamptz not null default now()
);

create unique index if not exists payments_external_id_key on public.payments (external_id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payments_source_check') then
    alter table public.payments
      add constraint payments_source_check check (source in ('poll','manual','stripe','tasker'));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payments_match_confidence_check') then
    alter table public.payments
      add constraint payments_match_confidence_check check (match_confidence in ('exact','probable','none'));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payments_status_check') then
    alter table public.payments
      add constraint payments_status_check check (status in ('pending','confirmed','ignored'));
  end if;
end $$;

create index if not exists payments_client_id_idx on public.payments (client_id);
create index if not exists payments_received_at_idx on public.payments (received_at desc);
create index if not exists payments_status_idx on public.payments (status) where status = 'pending';

comment on table public.payments is
  'Bank truth: one row per confirmed real transaction. external_id unique is the entire idempotency story. Empty until the balance poll is built.';

-- --------------------------------------------------------------- signals ----

create table if not exists public.payment_signals (
  id                  uuid primary key default gen_random_uuid(),
  source              text not null,
  token               text references public.payment_tokens(token),
  client_id           uuid references public.clients(id),
  amount              numeric(12,2),
  currency            text,
  metadata            jsonb not null default '{}'::jsonb,
  seen_at             timestamptz not null default now(),
  resolved_payment_id uuid references public.payments(id),
  notified_at         timestamptz
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payment_signals_source_check') then
    alter table public.payment_signals
      add constraint payment_signals_source_check
      check (source in ('portal_view','portal_claim','tasker','tasker_heartbeat'));
  end if;
end $$;

create index if not exists payment_signals_token_idx on public.payment_signals (token);
create index if not exists payment_signals_seen_at_idx on public.payment_signals (seen_at desc);
create index if not exists payment_signals_unresolved_idx on public.payment_signals (seen_at desc)
  where resolved_payment_id is null;

comment on table public.payment_signals is
  'Fast, untrusted, disposable. A signal is NEVER a payment and must never move a stage. Links to a payment via resolved_payment_id once the poll catches up.';

-- ------------------------------------------------------------------- RLS ----
-- Enabled with no policies: anon and authenticated get nothing, service role
-- bypasses. These tables are reachable only from the Worker and n8n.

alter table public.payment_tokens  enable row level security;
alter table public.payments        enable row level security;
alter table public.payment_signals enable row level security;

-- ------------------------------------------------------------------------ --

notify pgrst, 'reload schema';
