-- Picagens do relógio de ponto facial. Separado dos timesheets.
-- A cloud só recebe: trabalhador, hora, direção, dispositivo (nunca imagens nem vetores).

create table if not exists public.punch_devices (
  id          text primary key,                       -- ex.: dev-a1b2c3d4
  name        text not null,
  site        text,
  token_hash  text not null,                          -- sha256 hex do token do dispositivo
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.punches (
  event_id     text primary key,                      -- dispositivo + contador => idempotência
  device_id    text not null references public.punch_devices(id),
  worker_id    text not null,
  worker_name  text,
  direction    text not null check (direction in ('in', 'out')),
  punched_at   timestamptz not null,                  -- hora do dispositivo (corrigida por offset do servidor)
  received_at  timestamptz not null default now(),
  confidence   numeric(5,3),
  status       text not null default 'pending' check (status in ('pending', 'validated', 'rejected')),
  validated_by uuid references auth.users(id),
  validated_at timestamptz
);

create index if not exists punches_punched_at_idx on public.punches (punched_at desc);
create index if not exists punches_worker_idx on public.punches (worker_id, punched_at);

alter table public.punch_devices enable row level security;
alter table public.punches enable row level security;

-- Sem policies para anon: só a Edge Function (service role) escreve.
-- Chefes de equipa (utilizadores autenticados) leem e validam.
-- TODO: restringir por obra/equipa quando houver essa relação no modelo da intranet.
create policy "punches_select_authenticated" on public.punches
  for select to authenticated using (true);

create policy "punches_validate_authenticated" on public.punches
  for update to authenticated using (true) with check (status in ('pending', 'validated', 'rejected'));

create policy "devices_select_authenticated" on public.punch_devices
  for select to authenticated using (true);

-- Registar um dispositivo (substituir o token por um valor aleatório longo):
-- insert into public.punch_devices (id, name, site, token_hash)
-- values ('dev-a1b2c3d4', 'Tablet Entrada', 'Obra X', encode(digest('TOKEN_AQUI', 'sha256'), 'hex'));
-- (requer extensão pgcrypto: create extension if not exists pgcrypto;)
