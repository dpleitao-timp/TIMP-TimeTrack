-- Dados de reconhecimento de cada picagem, para afinar o sistema (limiar, margem, anti-foto).
-- Colunas TEMPORÁRIAS na própria timetrack; quando já não forem precisas:
--   alter table public.timetrack drop column second_similarity, drop column antispoof_real, drop column antispoof_live;
--
--   second_similarity = semelhança do 2º trabalhador mais parecido (null se só há um registado no tablet)
--   antispoof_real / antispoof_live = médias dos modelos anti-foto na janela de fotogramas
-- A semelhança do mais parecido (o trabalhador picado) já está em timetrack.confidence.
--
-- ORDEM: aplicar esta migração ANTES de publicar a nova pull-punches (ela grava estas colunas).
alter table public.timetrack
  add column if not exists second_similarity numeric(4,3),
  add column if not exists antispoof_real    numeric(4,3),
  add column if not exists antispoof_live    numeric(4,3);

comment on column public.timetrack.second_similarity is 'Temporária: semelhança do 2º mais parecido no reconhecimento (para afinar o limiar)';
comment on column public.timetrack.antispoof_real is 'Temporária: média do modelo anti-foto "real" na janela de reconhecimento';
comment on column public.timetrack.antispoof_live is 'Temporária: média do modelo anti-foto "live" na janela de reconhecimento';
