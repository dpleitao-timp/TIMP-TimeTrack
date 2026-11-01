-- Saída para almoço/jantar e entrada de almoço/jantar: duas direções novas, opcionais por tablet (Definições → Almoço/jantar).
--   'meal_out' = saída para almoço/jantar     'meal_in' = entrada de almoço/jantar
-- APLICAR ANTES de publicar o relay e a app novos, e de publicar a função pull-punches atualizada: uma picagem com uma direção
-- desconhecida é descartada (e confirmada ao relay), por isso perderia-se.
-- A intranet que lê `timetrack` tem de saber tratar estes dois valores (não são entrada nem saída da obra).
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.timetrack'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%direction%'
  loop
    execute format('alter table public.timetrack drop constraint %I', c);
  end loop;
end $$;

alter table public.timetrack
  add constraint timetrack_direction_check check (direction in ('in', 'out', 'meal_out', 'meal_in'));
