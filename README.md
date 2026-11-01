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
Tablet ──POST /punch (assinado com a chave do tablet)──► Relay Cloudflare (Worker + D1) ◄── GET /pull + POST /ack (HMAC) ── Supabase (pg_cron + Edge Function)
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
node scripts/add-device.mjs dev-entrada OBRA   # gera o CÓDIGO DE INSTALAÇÃO (uso único) e o SQL para o registar (e para o revogar); a obra é obrigatória e fica fixa no relay
```
Em `wrangler.jsonc`, trocar `ALLOWED_ORIGIN` pelo endereço da PWA. Teste local: `npx wrangler dev --local` e `node relay/scripts/smoke-test.mjs` (ver cabeçalho do ficheiro).

### 2. Supabase
1. Aplicar `supabase/migrations/001_punches.sql` e `004_rename_punches_to_timetrack.sql` (a tabela chamava-se `punches` e passou a `timetrack`).
2. `supabase secrets set RELAY_URL=https://<worker>.workers.dev PULL_SECRET=<o mesmo do relay> CRON_SECRET=<aleatório>`
3. `supabase functions deploy pull-punches --no-verify-jwt`
4. Criar no Vault `punch_pull_url` e `punch_cron_secret` e aplicar `supabase/migrations/002_pull_schedule.sql` (instruções no topo do ficheiro).

### 3. Tablet
Em Definições: URL do relay e o **código de instalação** (uso único, dado por `add-device.mjs`). Ao guardar, o tablet gera uma chave própria que não sai dele (ECDSA P-256, não exportável), regista a parte pública no relay e apaga o código; a partir daí assina cada pedido e já não há nenhum token guardado. Nada mais é preciso: o tablet nunca fala com o Supabase. Migração `relay/migrations/008_device_keys.sql`; os tablets das versões anteriores ligam-se sozinhos com o token que já têm, uma só vez.

### 4. Chefe de equipa
Lê as picagens na intranet (modal Time Tracker do Timesheets), que as consulta por funções no servidor (`security definer`, com autenticação forte e permissões por pessoa). **Ninguém lê nem altera a tabela `timetrack` diretamente**: a migração `013_timetrack_no_direct_access.sql` retirou o acesso a `anon` e `authenticated` (só a Edge Function `pull-punches`, com a service role, e essas funções lhe mexem).

## Arranque rápido
Os modelos de reconhecimento (≈11 MB, em cache no service worker e na IndexedDB) carregam em segundo plano logo que a app abre, em qualquer ecrã, e a consola regista o tempo ("Modelos de reconhecimento prontos em … ms"). No ecrã de escolha aparece "A preparar o reconhecimento…" até estarem prontos.

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
Supabase ──POST /roster (assinado)──► Relay ◄──GET /roster (assinado pelo tablet)── Tablet
```
- **Supabase:** a função `publish-roster` lê a vista `timetrack_roster` (migração 005, sobre `workers`, `worker_work_sites`, `work_sites` e, para os **outsourced**, `workers_others` com o seu `punch_code` de 6 caracteres, criado pelo `db/313` da intranet, que **tem de ser aplicado antes**; só a service role a lê) e publica no relay de 6 em 6 horas (migrações 005 e 006). Só vão os ativos, e só SAGE ID, nome e obra.
- **Relay:** tabela `roster` + `GET/POST /roster` (migração `relay/migrations/002_roster.sql`). Cada dispositivo tem uma **obra fixa no relay** (obrigatória): `node relay/scripts/add-device.mjs dev-entrada <obra>` ou `UPDATE devices SET obra = '<obra>' WHERE id = 'dev-entrada'`. É essa obra, e não a que o tablet indica, que decide a lista, a biometria e as lápides que recebe, e em que obra pode picar; sem obra, o relay responde 403. A migração `007_roster_seen.sql` guarda quem já esteve na lista de cada obra (400 dias), para o tablet poder apagar a biometria de quem saiu da obra.
- **Tablet:** sincroniza ao arrancar, a cada 5 min e quando a rede volta; Definições → Lista de trabalhadores mostra quantos e quando, com "Atualizar lista agora". Se o SAGE ID escrito à mão não estiver na lista, aparece um aviso (não bloqueia). Os trabalhadores já registados no tablet que deixaram de estar na lista (saíram da obra ou ainda não entraram) aparecem com a etiqueta "fora da lista da obra" e um resumo por cima, para o Administrador os apagar; é só um aviso, a picagem não é bloqueada.
- O relay passa a guardar **nomes** (dados pessoais): constar da avaliação de RGPD; só se enviam os trabalhadores ativos e cada tablet lê só os da sua obra.

## Versão
O canto inferior direito mostra `v<versão> · <commit> · <data>` (a versão vem do `package.json`; o `+` depois do commit indica que a compilação tinha alterações por commitar). Serve para confirmar que o tablet já tem a versão publicada.

## Intervalo mínimo entre picagens
O intervalo (Definições, em segundos) é calculado a partir das picagens guardadas no tablet, por isso sobrevive a recargas, atualizações e reinícios. Aplica-se ao mesmo trabalhador, em qualquer direção, **neste tablet**: dois tablets (entrada e saída) não partilham a lista, por isso um intervalo entre os dois terá de ser verificado no Supabase/intranet. Apagar uma picagem (enviada ou não) deixa o trabalhador picar logo outra vez.

## Velocidade do reconhecimento
- **Decisão antecipada:** com 3 fotogramas já decide se a correspondência for muito forte (limiar +0,15 e margem de 0,10 sobre o segundo); se não, espera pela janela completa de 5.
- **Falhas momentâneas do detetor:** se o rosto deixar de ser detetado durante menos de 0,8 s (acontece muito ao piscar, com os olhos fechados), a janela de fotogramas, o piscar já feito e a identidade mantêm-se; só se recomeça se o rosto desaparecer mesmo. Se a identidade mudar a meio, o piscar e o movimento de quem estava antes deixam de valer.
- **Rosto inclinado:** a rotação do detetor está sempre ligada (não é uma definição): o Human alinha o rosto antes de o analisar, por isso reconhece com a cabeça inclinada. Os vetores guardados são calculados com esse alinhamento, e é por isso que não se pode desligar sem refazer o registo de todos. Só tem efeito no backend WebGL.
- **Dados para afinar o reconhecimento:** cada picagem leva, além da semelhança do trabalhador reconhecido (`confidence`), a do **2º mais parecido** e as médias do anti-foto (`real`, `live`). Chegam ao Supabase em colunas temporárias de `timetrack` (`second_similarity`, `antispoof_real`, `antispoof_live`, migração 008, aplicar **antes** de publicar a nova `pull-punches`). A margem é `confidence - second_similarity`: margens pequenas indicam pessoas parecidas. Quando já não forem precisas: `alter table public.timetrack drop column second_similarity, drop column antispoof_real, drop column antispoof_live`.
- **Movimento repetido:** se o trabalhador já tem hoje (neste tablet; o dia de trabalho vai das 05:00 às 05:00 do dia seguinte, para o turno da noite) o tipo de movimento que escolheu, o ecrã de leitura pergunta qual o movimento e só propõe os que ainda não tem, para não ficarem dois do mesmo tipo no mesmo dia.
- **Almoço/jantar (opcional, por tablet):** em Definições → Dispositivo, "Almoço/jantar" mostra no ecrã de escolha "Saída para almoço/jantar" e "Entrada de almoço/jantar" (valores `meal_out` e `meal_in`). Antes de publicar o relay e a app, aplicar no Supabase a migração `supabase/migrations/010_timetrack_meal_directions.sql` e a função `pull-punches`; a intranet tem de saber tratar os dois valores.
- **A biometria não sai do tablet.** Os vetores faciais ficam só no tablet que os registou, cifrados (AES-GCM, chave que não se exporta). Cada rosto regista-se em cada tablet onde a pessoa pica, e apagar um trabalhador apaga-o só nesse tablet. A partilha entre tablets (relay → Supabase → tablets, com chave da frota) existiu durante um dia e foi **retirada** por segurança: ver `docs/branches/26.0.0.md` (secção 9.2). Migrações que apagam o que ela deixou: `relay/migrations/009_drop_biometrics.sql` e `supabase/migrations/012_drop_timetrack_biometrics.sql`.
- **Repouso (sempre, sem definições):** o tablet está sempre em repouso: ecrã preto com a frase "Toque no ecrã para ativar durante 5 minutos" e a data e a hora no canto inferior esquerdo, e a câmara fechada. **Um toque (ou escrever) ativa-o durante 5 minutos** e cada toque prolonga; ao abrir a app também fica 5 minutos ativo. Ao adormecer a câmara fecha, termina a sessão de Administrador e volta ao ecrã de picar. Não depende da hora nem do dia da semana. Enquanto está ativo pede-se ao sistema que mantenha o ecrã aceso (Wake Lock); em repouso solta-se, e o sistema pode apagá-lo. Poupa bateria, calor e privacidade. (O horário de funcionamento e o desligar ao sábado e ao domingo foram retirados.)
- **Ecrã de leitura:** mostra no canto superior direito a **obra ativa** e no inferior esquerdo a **data e hora** (a hora corrigida pelo servidor, a mesma que se grava na picagem).
- **Moldura de luz adaptativa (Definições, cartão da Câmara):** o ecrã serve de luz de apoio sobre o rosto. Mede-se a luminosidade da cara (0 a 255): se for inferior a 95 a moldura branca **cresce depressa** (chega ao máximo em cerca de 3 s no escuro); se for superior a 125 **encolhe devagar** até ao mínimo (3 vmin, igual a ter a moldura desligada); entre 95 e 125 não mexe. As laterais crescem 2,8 vezes mais do que o topo e a base (no máximo 22% da largura de cada lado; em ecrã vertical são iguais). A espessura fica guardada no tablet, mesmo depois de recarregar a app, e a **mesma moldura aparece no ecrã de Registar** (mais pequena), para os vetores serem tirados com a luz que o ecrã dá na leitura. Nos testes só ajuda com luz fraca (cara abaixo de uns 90): com luz normal não melhora o reconhecimento e baixa um pouco o `live`, por isso só atua quando é preciso. Desligada, fica fixa em 3 vmin. O diagnóstico regista a luz da cara e a espessura da moldura.
- **Orientação do ecrã (Definições, Dispositivo):** botão Automática, Horizontal ou Vertical. Fixa a orientação com `screen.orientation.lock` onde o aparelho o permitir (Chrome em Android e alguns computadores, por vezes só em ecrã inteiro; ao tocar a app tenta entrar em ecrã inteiro se for preciso). **No iPad o Safari não o suporta**: aí o ecrã mostra o aviso e a orientação é a do suporte onde o aparelho está montado, mais o bloqueio de rotação do sistema (Centro de Controlo). A escolha guarda-se logo ao tocar e volta a aplicar-se ao abrir a app.
- **Diagnóstico:** com "debug" ligado, o tablet guarda em memória os últimos 400 fotogramas da última leitura (tempo de deteção, se viu rosto, estado, semelhança, abertura do olho, piscar). Definições → "Copiar diagnóstico" copia-os como texto, para analisar a sequência real quando algo oscila. Nada sai do tablet. Cada fotograma regista também o **ruído** da imagem (quanto cada pixel difere da média dos vizinhos, numa janela de 64x64 pixels da cara, em percentagem da luz dessa janela; mais alto, mais ruído por unidade de luz) e o RESUMO mostra a média, para comparar configurações (moldura ligada ou tapada, exposição).
- **Piscar relativo:** além do limiar do Human, deteta quedas de 35% na abertura dos olhos (apanha pestanejos parciais que a taxa de fotogramas não apanha). Era a principal causa de ter de piscar várias vezes.
- **Sem o modelo da íris** (não é usado: piscar e rotação saem da malha facial): menos dois modelos por fotograma.
- **Menos renderizações** no ecrã de picar: o aviso só se atualiza quando muda.
- **Modo rápido de vida** (Definições, desligado por omissão): dispensa o piscar quando a média do anti-foto do modelo é ≥ 0,8. Menos seguro; testar com o modo diagnóstico.

## Aceleração gráfica (experimental)
Em Definições → Reconhecimento: `WebGL` (por omissão) ou `WebGPU`; se o aparelho não suportar WebGPU, o Human usa WebGL. A app recarrega ao guardar. Com o **modo diagnóstico** ligado, o ecrã de picar mostra o backend e o tempo da deteção por fotograma (`ms`).

**Motor SFace (experimental):** em Definições → Avançado pode escolher o motor de reconhecimento: `FaceRes` (por omissão) ou `SFace` (modelo OpenCV Zoo, Apache-2.0, família ArcFace, 128 valores, corre com `onnxruntime-web` em WebAssembly). O SFace tem limiar próprio (cosseno) e, ao mudar de motor, a app recarrega e é preciso registar de novo todos os rostos. Em Definições → Avaliação do reconhecimento mede-se a semelhança entre os rostos registados (pessoas diferentes e mesma pessoa) para escolher o limiar. O modelo e o WASM só se descarregam quando se usa o SFace. O modelo é o **fp32** (~39 MB): o int8, mais pequeno, era cerca de 9 vezes mais lento nos CPU testados. Com o modo diagnóstico ligado, o ecrã de picar mostra `det Nms (SFace Mms)`; no PC de teste o SFace fp32 mede ~40 ms por vetor em WebAssembly. Medir também no tablet real.

**Motor MobileFaceNet (removido):** foi experimentado e retirado depois de, com o limiar de confiança a 0,8, reconhecer uma filha como o pai (aceitação falsa). O reconhecimento usa só o FaceRes. Cada registo continua a guardar o motor com que foi feito: registos de um motor antigo ficam obsoletos (não reconhecem) até se usar "atualizar biometria", e se o único Administrador ficar obsoleto a administração abre-se para o poder atualizar.

## Capacete e óculos de proteção
- **Adicionar capturas (luz e EPI):** em Registar, "adicionar capturas" junta ao trabalhador 3 capturas feitas nas condições reais de uso (a luz do local e, se os usa, capacete e óculos), de frente e virando para cada lado, sem apagar as anteriores. O reconhecimento usa o melhor de todos os vetores, por isso reconhece com e sem equipamento e com luz diferente. Convém fazê-lo à luz em que o tablet vai trabalhar: a semelhança desce quando há pouca luz e os vetores só foram tirados de dia.
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
