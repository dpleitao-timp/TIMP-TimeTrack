# Relógio de ponto facial — mockup PWA

React 19 + Vite, `@vladmandic/human` (modelos servidos de `public/models`, em cache pelo service worker),
IndexedDB (vetores cifrados com AES-GCM + fila offline), relay Cloudflare (Worker + D1) e Supabase (tabela `timetrack` + Edge Function `pull-punches`, que vai buscar as picagens ao relay).

## Correr
```bash
npm install
npm run dev        # http://localhost:5173  (câmara exige HTTPS ou localhost)
npm run build && npm run preview   # PWA com service worker (teste offline)
```

## Ecrãs
- **Picar** (`#/kiosk`): modo quiosque: primeiro escolhe-se Entrada ou Saída e só então a câmara liga; depois de picar (ou 45 s sem picar, ou "Voltar") a câmara desliga e volta à escolha. Deteção de vida (piscar/virar a cabeça), "Olá, <nome> — Entrada 08:02".
- **Registar** (`#/enrol`): registo por **SAGE ID + nome**, captura guiada de 5 poses (cada pose guarda a média de 5 fotogramas); só guarda vetores cifrados, nunca fotografias.
- **Picagens** (`#/punches`): picagens guardadas neste tablet (o Administrador pode apagar qualquer uma; se já tinha sido enviada, o pedido de apagar segue pelo relay e o Supabase apaga-a, ver "Apagar picagens já enviadas"), com resumo por trabalhador (picagens sem par) e métricas do piloto. O chefe de equipa vê as picagens na app de timesheets, alimentada pelo Supabase; o tablet não lê dados da cloud.
- **Definições**: obra (obrigatória: sem ela não se pica; vai em todas as picagens), função do tablet (entradas e saídas, só entradas ou só saídas), aspeto, limiar de confiança, deteção de vida, intervalo entre picagens, URL do relay e token do dispositivo.
- **Idiomas**: PT, FR, EN e DE (seletor sempre visível no cabeçalho; por omissão segue o idioma do navegador). As traduções estão em `src/lib/i18n.jsx`.

## Como as picagens chegam ao Supabase (o Supabase lê, o tablet só escreve)
```
Tablet ──POST /punch (token do dispositivo)──► Relay Cloudflare (Worker + D1) ◄── GET /pull + POST /ack (HMAC) ── Supabase (pg_cron + Edge Function)
```
O tablet **não lê nem escreve no Supabase**: não tem credenciais, chave nem endereço dele (nem o cliente do Supabase está na app). Só escreve no relay (acrescentar, idempotente por `eventId`).
O Supabase vai buscar as picagens ao relay a cada 15 minutos com pedidos assinados (HMAC-SHA256 + data), valida-as de novo, grava em `timetrack` e só depois confirma (o relay apaga).

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
1. Aplicar `supabase/migrations/001_punches.sql` e `004_rename_punches_to_timetrack.sql` (a tabela chamava-se `punches` e passou a `timetrack`).
2. `supabase secrets set RELAY_URL=https://<worker>.workers.dev PULL_SECRET=<o mesmo do relay> CRON_SECRET=<aleatório>`
3. `supabase functions deploy pull-punches --no-verify-jwt`
4. Criar no Vault `punch_pull_url` e `punch_cron_secret` e aplicar `supabase/migrations/002_pull_schedule.sql` (instruções no topo do ficheiro).

### 3. Tablet
Em Definições: URL do relay e token do dispositivo. Nada mais é preciso: o tablet nunca fala com o Supabase.

### 4. Chefe de equipa
Lê as picagens na app de timesheets/intranet, que consulta a tabela `timetrack` do Supabase (a policy `timetrack_select_authenticated`, criada na migração 001 com o nome antigo, dá acesso de leitura a utilizadores autenticados; convém restringi-la por obra/equipa).

## Arranque rápido
Os modelos de reconhecimento (≈13 MB, em cache no service worker e na IndexedDB) carregam em segundo plano logo que a app abre, em qualquer ecrã, e a consola regista o tempo ("Modelos de reconhecimento prontos em … ms"). No ecrã de escolha aparece "A preparar o reconhecimento…" até estarem prontos.

**Câmara sempre ligada:** a câmara abre-se no arranque e fica aberta (partilhada entre os ecrãs), por isso escolher Entrada/Saída já a encontra pronta. Só passa a ser analisada depois dessa escolha e, enquanto não se escolhe, não se mostra nem se processa nenhuma imagem (a luz da câmara fica acesa). Isto substitui a regra anterior "a câmara só liga depois de escolher" e deve constar da avaliação de impacto (DPIA).


### Apagar picagens já enviadas

O tablet não escreve no Supabase, por isso o pedido de apagar também passa pelo relay:

1. Em Picagens, o Administrador apaga a picagem. Se ainda não foi enviada, desaparece do tablet. Se já foi, fica marcada como apagada (deixa de aparecer e de contar para o intervalo mínimo) e o tablet envia `POST /punch/delete` ao relay (token do dispositivo; só aceita IDs do próprio dispositivo). Se não houver rede, tenta de novo no ciclo seguinte.
2. O relay guarda o pedido na tabela `deletions` (migração `relay/migrations/003_deletions.sql`) e tira a picagem do `outbox` se o Supabase ainda não a tinha lido.
3. A Edge Function `pull-punches` lê os pedidos (`GET /pull-deletions`, assinado), chama `timetrack_apply_deletions` (migração `supabase/migrations/007_timetrack_deletions.sql`) e confirma (`POST /ack-deletions`). Processa primeiro as picagens e depois os pedidos.
4. Cada picagem apagada fica em `timetrack_deletions` (linha completa em JSON, com `outcome`). **Uma picagem que o chefe de equipa já validou (`status = 'validated'`) não é apagada**: o pedido fica registado como `kept_validated`.

Ordem de publicação: migração 003 no relay, `npm run deploy:relay`, migração 007 no Supabase, `pull-punches` publicada de novo, e por fim a app.


## Lista de trabalhadores da obra (Supabase → relay → tablet)
O Registar deixa de ser texto livre: o tablet mostra os trabalhadores da **sua obra**, com pesquisa por nome ou SAGE ID e a lista de quem **falta registar**.
```
Supabase ──POST /roster (assinado)──► Relay ◄──GET /roster (token do dispositivo)── Tablet
```
- **Supabase:** a função `publish-roster` lê a vista `timetrack_roster` (migração 005, sobre `workers`, `worker_work_sites`, `work_sites` e, para os **outsourced**, `workers_others` com o seu `punch_code` de 6 caracteres, criado pelo `db/313` da intranet, que **tem de ser aplicado antes**; só a service role a lê) e publica no relay de 6 em 6 horas (migrações 005 e 006). Só vão os ativos, e só SAGE ID, nome e obra.
- **Relay:** tabela `roster` + `GET/POST /roster` (migração `relay/migrations/002_roster.sql`). Se o dispositivo tiver **obra** no relay, só recebe os dessa obra: `node relay/scripts/add-device.mjs dev-entrada <obra>` ou `UPDATE devices SET obra = '<obra>' WHERE id = 'dev-entrada'`. Sem obra no relay usa a que o tablet indica.
- **Tablet:** sincroniza ao arrancar, a cada 5 min e quando a rede volta; Definições → Lista de trabalhadores mostra quantos e quando, com "Atualizar lista agora". Se o SAGE ID escrito à mão não estiver na lista, aparece um aviso (não bloqueia). Os trabalhadores já registados no tablet que deixaram de estar na lista (saíram da obra ou ainda não entraram) aparecem com a etiqueta "fora da lista da obra" e um resumo por cima, para o Administrador os apagar; é só um aviso, a picagem não é bloqueada.
- O relay passa a guardar **nomes** (dados pessoais): constar da avaliação de RGPD; só se enviam os trabalhadores ativos e cada tablet lê só os da sua obra.

## Versão
O canto inferior direito mostra `v<versão> · <commit> · <data>` (a versão vem do `package.json`; o `+` depois do commit indica que a compilação tinha alterações por commitar). Serve para confirmar que o tablet já tem a versão publicada.

## Intervalo mínimo entre picagens
O intervalo (Definições, em segundos) é calculado a partir das picagens guardadas no tablet, por isso sobrevive a recargas, atualizações e reinícios. Aplica-se ao mesmo trabalhador, em qualquer direção, **neste tablet**: dois tablets (entrada e saída) não partilham a lista, por isso um intervalo entre os dois terá de ser verificado no Supabase/intranet. Apagar uma picagem (enviada ou não) deixa o trabalhador picar logo outra vez.

## Velocidade do reconhecimento
- **Decisão antecipada:** com 3 fotogramas já decide se a correspondência for muito forte (limiar +0,15 e margem de 0,10 sobre o segundo); se não, espera pela janela completa de 5.
- **Falhas momentâneas do detetor:** se o rosto deixar de ser detetado durante menos de 0,8 s (acontece muito ao piscar, com os olhos fechados), a janela de fotogramas, o piscar já feito e a identidade mantêm-se; só se recomeça se o rosto desaparecer mesmo. Se a identidade mudar a meio, o piscar e o movimento de quem estava antes deixam de valer.
- **Rosto inclinado:** a rotação do detetor está ligada por omissão (Definições → Rosto inclinado): o Human alinha o rosto antes de o analisar, por isso reconhece com a cabeça inclinada. É um pouco mais lento e só tem efeito no backend WebGL (o Human ignora-a noutros). Os registos existentes continuam válidos; se a semelhança descer com a cabeça direita, desligue-a.
- **Diagnóstico:** com "debug" ligado, o tablet guarda em memória os últimos 400 fotogramas da última leitura (tempo de deteção, se viu rosto, estado, semelhança, abertura do olho, piscar). Definições → "Copiar diagnóstico" copia-os como texto, para analisar a sequência real quando algo oscila. Nada sai do tablet.
- **Piscar relativo:** além do limiar do Human, deteta quedas de 35% na abertura dos olhos (apanha pestanejos parciais que a taxa de fotogramas não apanha). Era a principal causa de ter de piscar várias vezes.
- **Sem o modelo da íris** (não é usado: piscar e rotação saem da malha facial): menos dois modelos por fotograma.
- **Menos renderizações** no ecrã de picar: o aviso só se atualiza quando muda.
- **Modo rápido de vida** (Definições, desligado por omissão): dispensa o piscar quando a média do anti-foto do modelo é ≥ 0,8. Menos seguro; testar com o modo diagnóstico.

## Aceleração gráfica (experimental)
Em Definições → Reconhecimento: `WebGL` (por omissão) ou `WebGPU`; se o aparelho não suportar WebGPU, o Human usa WebGL. A app recarrega ao guardar. Com o **modo diagnóstico** ligado, o ecrã de picar mostra o backend e o tempo da deteção por fotograma (`ms`).

**Motor MobileFaceNet (removido):** foi experimentado e retirado depois de, com o limiar de confiança a 0,8, reconhecer uma filha como o pai (aceitação falsa). O reconhecimento usa só o FaceRes. Cada registo continua a guardar o motor com que foi feito: registos de um motor antigo ficam obsoletos (não reconhecem) até se usar "atualizar biometria", e se o único Administrador ficar obsoleto a administração abre-se para o poder atualizar.

## Capacete e óculos de proteção
- **Registo com EPI:** em Registar, "adicionar com EPI" junta ao trabalhador 3 capturas feitas **com o capacete e os óculos postos** (de frente e virando para cada lado), sem apagar as anteriores. O reconhecimento usa o melhor de todos os vetores, por isso reconhece com e sem equipamento.
- **Deteção mais tolerante:** a confiança mínima da deteção do rosto baixou para 0,40 (ajustável em Definições; recarrega ao guardar).
- **Vida sem piscar:** os óculos de proteção podem esconder o piscar (reflexos, lentes escuras). Passou a contar também um **movimento da cabeça** (virar ou acenar ≥ ~12°) como prova de vida.
- Se o anti-fotografia do modelo rejeitar rostos reais com equipamento, o modo diagnóstico mostra `real`/`live`; baixe o limiar anti-foto ou use o modo rápido de vida só depois de testar.

## Perfis
- **Registar, Picagens e Definições** só aparecem a um **Administrador**. Desbloqueia-se em Picar → "🔒 Administração" (reconhecimento facial + deteção de vida); a sessão termina com "Terminar sessão" ou após 5 min sem atividade.
- O **primeiro trabalhador registado é sempre Administrador** (fica com a sessão aberta nesse momento). Enquanto não houver Administrador utilizável, a administração está aberta para o registar.
- Pode haver **vários Administradores**: um Administrador regista outros (interruptor "Perfil de Administrador") ou promove/remove o perfil na lista. **Tem de ficar sempre pelo menos um Administrador ativo**: o último não pode ser apagado nem despromovido (a regra está na camada de dados, não só no botão). Única exceção: se o Administrador for a única pessoa registada, pode apagar-se (a pedir o SAGE ID) e o tablet volta ao estado inicial. A biometria de qualquer trabalhador pode ser refeita com "atualizar biometria" (mantém SAGE ID e perfil). Um registo de Administrador ilegível não conta como ativo e pode ser apagado.
- É um controlo de interface no tablet (não impede quem tenha acesso às ferramentas do navegador); a segurança real dos dados está do lado do Supabase.

## Notas de desenho
- O trabalhador é identificado pelo **SAGE ID** (único por tablet). Para o Supabase só vão o SAGE ID e os dados do movimento (evento, obra, direção, hora, dispositivo, confiança); o nome fica só no tablet.
- ID do evento = `dispositivo-contador` → reenvios idempotentes (`upsert ... ignoreDuplicates`).
- Hora = relógio do dispositivo, corrigido com o `serverTime` devolvido pela função quando há rede.
- A função rejeita horas >5 min no futuro ou >14 dias no passado, e IDs que não pertencem ao dispositivo.
- Picagens ficam só como registo (`status = pending`); a conversão em timesheets está por decidir.
- Cópia de utilizadores entre tablets: por agora, registar em ambos.

## Por validar (não testado sem câmara/Supabase reais)
Precisão e tempo (<2 s) em tablet real, taxa de aceitação falsa com foto/vídeo, contraluz, e o relay e a Edge Function `pull-punches` contra contas Cloudflare/Supabase reais (o relay foi testado em local com `smoke-test.mjs`).
RGPD: DPIA e validação com DPO/CNPD antes de qualquer uso com trabalhadores reais.
