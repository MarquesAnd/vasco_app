# Vasco da Gama — PWA ao vivo com alertas de gol

App instalável no celular que mostra o **placar do Vasco ao vivo** (atualiza sozinho) e
**notifica gol e vitória mesmo com o app fechado**. Os dados vêm de uma API de futebol,
processados por um backend no Supabase.

> O emblema e os grafismos são uma **interpretação original** inspirada na estética do
> clube (preto/branco + carmim), para não reproduzir o escudo oficial, que é marca registrada.

## Como funciona (arquitetura)

```
API-Futebol  ──►  Edge Function (Supabase, roda a cada 30s no jogo)
                      │  detecta gol/vitória do Vasco
                      ├──►  tabela live_state  ──(Realtime)──►  app (placar atualiza sozinho)
                      └──►  Web Push (VAPID)   ─────────────►  celular (notificação, app fechado)
```

O celular **não** fica vigiando o jogo sozinho — quem vigia é a Edge Function. Por isso o
backend é obrigatório para o push funcionar com o app fechado.

## O que você vai precisar (contas gratuitas)

1. **API-Futebol** — https://dash.api-futebol.com.br (crie a conta, gere a chave). Plano free serve para testar.
2. **Supabase** — https://supabase.com (projeto free).
3. **Chaves VAPID** — geradas por você (passo 3).
4. Um lugar para hospedar os arquivos estáticos com **HTTPS** (obrigatório p/ PWA/push): GitHub Pages, Netlify, Vercel, Cloudflare Pages.

---

## Passo 1 — Banco (Supabase)

No painel do Supabase: **SQL Editor** → cole e rode o `supabase/schema.sql`.
Antes de rodar, troque no final do arquivo:
- `<PROJECT_REF>` → o ref do seu projeto (está na URL, ex: `abcd1234`)
- `<POLLER_SECRET>` → invente uma senha longa (a mesma do passo 4)

## Passo 2 — Edge Function

Instale a CLI e faça deploy da função:

```bash
npm i -g supabase
supabase login
supabase link --project-ref SEU_PROJECT_REF
supabase functions deploy vasco-poller --no-verify-jwt
```

## Passo 3 — Gerar chaves VAPID

```bash
npx web-push generate-vapid-keys
```
Guarde a **Public Key** e a **Private Key**.

## Passo 4 — Secrets da função

```bash
supabase secrets set \
  API_FUTEBOL_TOKEN="sua_chave_api_futebol" \
  VAPID_PUBLIC_KEY="sua_vapid_public" \
  VAPID_PRIVATE_KEY="sua_vapid_private" \
  VAPID_SUBJECT="mailto:seu@email.com" \
  POLLER_SECRET="a_mesma_senha_do_schema"
```
(`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já existem no ambiente da função.)

## Passo 5 — Ligar o app às chaves

No topo do `index.html`, preencha:
```js
const SUPABASE_URL      = "https://SEU_PROJECT_REF.supabase.co";
const SUPABASE_ANON_KEY = "sua_anon_key";           // Supabase → Project Settings → API
const VAPID_PUBLIC_KEY  = "sua_vapid_public";
```

## Passo 6 — Publicar com HTTPS

Suba a pasta inteira (`index.html`, `sw.js`, `manifest.webmanifest`, `icons/`) para GitHub
Pages / Netlify / Vercel. Push **não funciona** em `file://` nem em `http://` — precisa de HTTPS.

## Passo 7 — Instalar e ativar

1. Abra a URL no celular.
2. **Adicionar à tela inicial** (no iPhone é obrigatório para o push; iOS 16.4+).
3. Abra pelo ícone e toque em **“Ativar alertas de gol e vitória”**.

Pronto. Em dia de jogo o placar atualiza sozinho e a notificação chega a cada gol e no fim, se vencer.

---

## Realidades e limites (importante)

- **“Tempo real” ≈ 30 segundos** (intervalo do poller). Quase junto com a TV, não instantâneo.
  Para reduzir, você pode agendar dois jobs defasados em 15s.
- **Cota da API**: o poller só chama a API **dentro da janela dos jogos** (tabela `fixtures`),
  justamente para não estourar o plano free. Mantenha os próximos jogos cadastrados em `fixtures`.
- **Campos da API**: o `index.ts` usa nomes prováveis (`placar_mandante`, `time_mandante.sigla`…).
  Confirme na doc da API-Futebol e ajuste se algum vier diferente — deixei comentado onde olhar.
- **iPhone**: push por PWA exige o app na tela inicial (iOS 16.4+). Android é mais tranquilo.
- **Fim de jogo**: o placar final usado na notificação de vitória é o do último ciclo antes do
  apito (a partida sai do `/ao-vivo` ao encerrar). Em 99% dos casos é o placar correto.

## Extensões fáceis depois

- Cobrir também a **Copa do Brasil** (campeonato_id 2) no mesmo poller.
- Notificar **gol do adversário** e **cartão vermelho**.
- Auto-popular a tabela `fixtures` a partir da API (endpoint de rodadas), em vez de cadastrar à mão.
- Botão de “silenciar” alertas por jogo.
