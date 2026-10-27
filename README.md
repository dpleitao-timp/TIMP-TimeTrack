# Relógio de ponto facial — mockup PWA

React 19 + Vite, `@vladmandic/human` (modelos servidos de `public/models`, em cache pelo service worker),
IndexedDB (vetores cifrados com AES-GCM + fila offline), Supabase (tabela `punches` + Edge Function `register-punch`).

## Correr
```bash
npm install
npm run dev        # http://localhost:5173  (câmara exige HTTPS ou localhost)
npm run build && npm run preview   # PWA com service worker (teste offline)
```

## Ecrãs
- **Picar** (`#/kiosk`): modo quiosque com botões Entrada/Saída (a escolha fica guardada no dispositivo; sem alternância automática), deteção de vida (piscar/virar a cabeça), "Olá, <nome> — Entrada 08:02".
- **Registar** (`#/enrol`): captura guiada de 5 poses; só guarda vetores cifrados, nunca fotografias.
- **Picagens** (`#/punches`): vista local (este tablet) e cloud (login Supabase do chefe de equipa), resumo por trabalhador com picagens sem par, métricas do piloto.
- **Definições**: direção, limiar de confiança, deteção de vida, intervalo entre picagens, URL/chave Supabase, token do dispositivo.

## Supabase
1. Aplicar `supabase/migrations/001_punches.sql`.
2. Registar o dispositivo (instruções no fim do SQL; guarda-se o *hash* do token).
3. `supabase functions deploy register-punch`
4. No tablet, preencher URL, chave anon e token em Definições.

## Notas de desenho
- ID do evento = `dispositivo-contador` → reenvios idempotentes (`upsert ... ignoreDuplicates`).
- Hora = relógio do dispositivo, corrigido com o `serverTime` devolvido pela função quando há rede.
- A função rejeita horas >5 min no futuro ou >14 dias no passado, e IDs que não pertencem ao dispositivo.
- Picagens ficam só como registo (`status = pending`); a conversão em timesheets está por decidir.
- Cópia de utilizadores entre tablets: por agora, registar em ambos.

## Por validar (não testado sem câmara/Supabase reais)
Precisão e tempo (<2 s) em tablet real, taxa de aceitação falsa com foto/vídeo, contraluz, e a Edge Function contra um projeto Supabase.
RGPD: DPIA e validação com DPO/CNPD antes de qualquer uso com trabalhadores reais.
