# Relógio de ponto facial — mockup PWA

React 19 + Vite, `@vladmandic/human` (modelos servidos de `public/models`, em cache pelo service worker),
IndexedDB (vetores cifrados com AES-GCM + fila offline), relay Cloudflare (Worker + D1) e Supabase (tabela `punches` + Edge Function `pull-punches`, que vai buscar as picagens ao relay).

## Correr
```bash
npm install
npm run dev        # http://localhost:5173  (câmara exige HTTPS ou localhost)
npm run build && npm run preview   # PWA com service worker (teste offline)
```

## Ecrãs
- **Picar** (`#/kiosk`): modo quiosque: primeiro escolhe-se Entrada ou Saída e só então a câmara liga; depois de picar (ou 45 s sem picar, ou "Voltar") a câmara desliga e volta à escolha. Deteção de vida (piscar/virar a cabeça), "Olá, <nome> — Entrada 08:02".
- **Registar** (`#/enrol`): registo por **SAGE ID + nome**, captura guiada de 5 poses; só guarda vetores cifrados, nunca fotografias.
- **Picagens** (`#/punches`): vista local (este tablet) e cloud (login Supabase do chefe de equipa), resumo por trabalhador com picagens sem par, métricas do piloto.
- **Definições**: direção, limiar de confiança, deteção de vida, intervalo entre picagens, URL do relay e token do dispositivo, Supabase (só leitura) para o chefe de equipa.

## Como as picagens chegam ao Supabase (o Supabase lê, o tablet só escreve)
```
Tablet ──POST /punch (token do dispositivo)──► Relay Cloudflare (Worker + D1) ◄── GET /pull + POST /ack (HMAC) ── Supabase (pg_cron + Edge Function)
```
O tablet **não tem credenciais nem endereço do Supabase**. Só escreve no relay (acrescentar, idempotente por `eventId`).
O Supabase vai buscar as picagens ao relay a cada minuto com pedidos assinados (HMAC-SHA256 + data), valida-as de novo, grava em `punches` e só depois confirma (o relay apaga).

### 1. Relay (Cloudflare)
```bash
cd relay
npx wrangler d1 create timp-punch-relay        # copiar o database_id para wrangler.jsonc
npx wrangler d1 execute timp-punch-relay --remote --file=schema.sql
npx wrangler secret put PULL_SECRET             # segredo longo e aleatório (o mesmo vai para o Supabase)
npx wrangler deploy
node scripts/add-device.mjs dev-entrada         # gera o token do tablet e o SQL para o registar (e para o revogar)
```
Em `wrangler.jsonc`, trocar `ALLOWED_ORIGIN` pelo endereço da PWA. Teste local: `npx wrangler dev --local` e `node relay/scripts/smoke-test.mjs` (ver cabeçalho do ficheiro).

### 2. Supabase
1. Aplicar `supabase/migrations/001_punches.sql`.
2. `supabase secrets set RELAY_URL=https://<worker>.workers.dev PULL_SECRET=<o mesmo do relay> CRON_SECRET=<aleatório>`
3. `supabase functions deploy pull-punches --no-verify-jwt`
4. Criar no Vault `punch_pull_url` e `punch_cron_secret` e aplicar `supabase/migrations/002_pull_schedule.sql` (instruções no topo do ficheiro).

### 3. Tablet
Em Definições: URL do relay e token do dispositivo. Para a vista do chefe de equipa (só leitura, com login) preencher também URL e chave anon do Supabase.

## Perfis
- **Registar, Picagens e Definições** só aparecem a um **Administrador**. Desbloqueia-se em Picar → "🔒 Administração" (reconhecimento facial + deteção de vida); a sessão termina com "Terminar sessão" ou após 5 min sem atividade.
- O **primeiro trabalhador registado é sempre Administrador** (fica com a sessão aberta nesse momento). Enquanto não houver Administrador utilizável, a administração está aberta para o registar.
- Pode haver **vários Administradores**: um Administrador regista outros (interruptor "Perfil de Administrador") ou promove/remove o perfil na lista. O único Administrador não pode ser apagado nem despromovido enquanto houver outros trabalhadores registados.
- É um controlo de interface no tablet (não impede quem tenha acesso às ferramentas do navegador); a segurança real dos dados está do lado do Supabase.

## Notas de desenho
- O trabalhador é identificado pelo **SAGE ID** (único por tablet). Para o Supabase só vão o SAGE ID e os dados do movimento (evento, direção, hora, dispositivo, confiança); o nome fica só no tablet.
- ID do evento = `dispositivo-contador` → reenvios idempotentes (`upsert ... ignoreDuplicates`).
- Hora = relógio do dispositivo, corrigido com o `serverTime` devolvido pela função quando há rede.
- A função rejeita horas >5 min no futuro ou >14 dias no passado, e IDs que não pertencem ao dispositivo.
- Picagens ficam só como registo (`status = pending`); a conversão em timesheets está por decidir.
- Cópia de utilizadores entre tablets: por agora, registar em ambos.

## Por validar (não testado sem câmara/Supabase reais)
Precisão e tempo (<2 s) em tablet real, taxa de aceitação falsa com foto/vídeo, contraluz, e o relay e a Edge Function `pull-punches` contra contas Cloudflare/Supabase reais (o relay foi testado em local com `smoke-test.mjs`).
RGPD: DPIA e validação com DPO/CNPD antes de qualquer uso com trabalhadores reais.
