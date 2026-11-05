-- HR or Sales: chosen once at setup, then locked (a manager can reset it, see CLAUDE.md).
alter table public.users add column if not exists mode text check (mode in ('hr', 'sales'));

-- Each person's own LSQ API keys, AES-256-GCM encrypted by the backend (LSQ_KEYS_SECRET), so activities show them
-- as Created By. Its own table so keys never load with the user's profile.
create table if not exists public.user_lsq_keys (
  user_id        uuid primary key references public.users(id) on delete cascade,
  access_key_enc text not null,
  secret_key_enc text not null,
  verified_at    timestamptz, -- first post confirmed LSQ credits this person; null until then
  updated_at     timestamptz not null default now()
);

-- Only the backend (service role key) reads or writes this table.
alter table public.user_lsq_keys enable row level security;
