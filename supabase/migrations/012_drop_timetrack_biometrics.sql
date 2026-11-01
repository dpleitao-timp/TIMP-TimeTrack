-- A biometria deixou de sair dos tablets (a partilha entre tablets foi retirada: os vetores faciais ficam só no tablet que os registou).
-- Apaga as funções e as tabelas das migrações 009 e 011, e com elas os blobs cifrados e as lápides que lá estejam.
-- É IRREVERSÍVEL: o que estava nestas tabelas perde-se (eram só cópias cifradas; os vetores continuam nos tablets que os registaram).
-- Dados biométricos são de categoria especial (RGPD, art. 9.º): convém guardar o registo de que isto foi apagado e quando.
--
-- Ordem: publicar primeiro as funções novas (pull-punches e publish-roster, que já não usam estas tabelas) e só depois aplicar esta migração.
-- Aplicar no painel do Supabase (SQL Editor) ou com `supabase db push`.
drop function if exists public.timetrack_store_biometrics(jsonb);
drop function if exists public.timetrack_delete_biometrics(jsonb);
drop table if exists public.timetrack_biometrics;
drop table if exists public.timetrack_biometric_deletions;
