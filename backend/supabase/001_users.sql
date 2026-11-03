-- One row per person who signs in. Linked to their LSQ user by email; role and groups re-read from LSQ daily.
create table if not exists public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  name        text,
  lsq_user_id text not null unique,
  lsq_role    text not null,
  access      text not null check (access in ('associate', 'tl', 'manager')),
  groups      text[] not null default '{}',
  synced_at   timestamptz not null default now()
);

-- Only the backend (service role key) reads or writes this table.
alter table public.users enable row level security;
