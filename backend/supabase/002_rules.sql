-- Which LSQ user leads each LSQ sales group. Set by managers: LSQ itself doesn't mark TLs.
create table if not exists public.team_leads (
  group_name  text primary key,
  lsq_user_id text not null,
  set_by      uuid references public.users(id),
  updated_at  timestamptz not null default now()
);
create index if not exists team_leads_lsq_user_idx on public.team_leads (lsq_user_id);

-- A rule: from start_time (IST) on the given weekdays, this associate or group dials this LSQ dynamic List.
create table if not exists public.rules (
  id          uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('user', 'group')),
  target_id   text not null,               -- lsq_user_id for 'user', group name for 'group'
  list_id     text not null,
  list_name   text not null,
  start_time  time not null,
  days        int[] not null check (days <@ array[0,1,2,3,4,5,6] and cardinality(days) > 0), -- 0 = Sunday
  created_by  uuid references public.users(id),
  updated_at  timestamptz not null default now()
);
create index if not exists rules_target_idx on public.rules (target_type, target_id);

-- One row per dial. The queue skips leads already dialed under the same rule today.
create table if not exists public.dial_attempts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id),
  rule_id      uuid references public.rules(id) on delete set null,
  prospect_id  text not null,
  phone        text,
  outcome      text,
  talk_seconds int,
  started_at   timestamptz not null default now(),
  note         text
);
create index if not exists dial_attempts_user_rule_idx on public.dial_attempts (user_id, rule_id, started_at);

-- Only the backend (service role key) reads or writes these tables.
alter table public.team_leads enable row level security;
alter table public.rules enable row level security;
alter table public.dial_attempts enable row level security;
