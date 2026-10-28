-- Obra onde foi feita a picagem (vem do tablet, em cada linha).
alter table public.punches add column if not exists obra text;

create index if not exists punches_obra_idx on public.punches (obra, punched_at);

comment on column public.punches.obra is 'Código ou nome da obra definido no tablet no momento da picagem';
