-- "Open on laptop" requests from the app. The Chrome extension, signed in as the same person, listens over
-- Supabase Realtime and opens the lead in LSQ. The backend inserts with the service key; people only read their own.
create table if not exists public.laptop_opens (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.users(id) on delete cascade,
  prospect_id text not null,
  created_at  timestamptz not null default now()
);
create index if not exists laptop_opens_user_time on public.laptop_opens (user_id, created_at desc);

alter table public.laptop_opens enable row level security;
drop policy if exists "own opens" on public.laptop_opens;
create policy "own opens" on public.laptop_opens for select to authenticated using (user_id = auth.uid());

alter publication supabase_realtime add table public.laptop_opens;
