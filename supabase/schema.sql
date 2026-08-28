-- ============================================================
-- Vasco PWA — schema do Supabase
-- Rode isto no SQL Editor do seu projeto Supabase.
-- ============================================================

-- Extensões para agendar e chamar a Edge Function
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---- Inscrições de push (um registro por aparelho/navegador) ----
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  endpoint   text unique not null,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz default now()
);

-- ---- Estado do jogo ao vivo (o app lê isto em tempo real) ----
create table if not exists public.live_state (
  partida_id  text primary key,
  competicao  text,
  home_name   text,
  home_sigla  text,
  away_name   text,
  away_sigla  text,
  score_home  int default 0,
  score_away  int default 0,
  vasco_goals int default 0,
  opp_goals   int default 0,
  minuto      text,
  status      text default 'andamento',   -- 'andamento' | 'encerrada'
  updated_at  timestamptz default now()
);

-- ---- Tabela do Brasileirão (o app lê isto; atualizada pela função) ----
create table if not exists public.standings (
  pos        int primary key,
  team       text,
  sigla      text,
  played     int,
  gd         text,
  points     int,
  updated_at timestamptz default now()
);

-- ---- Próximos jogos do Vasco (janela para o poller só rodar em dia de jogo) ----
create table if not exists public.fixtures (
  id          bigserial primary key,
  competicao  text,
  opponent    text,
  is_home     boolean,
  kickoff     timestamptz not null,
  status      text default 'agendado'
);

-- Semente com os próximos jogos conhecidos (ajuste os horários se mudarem)
insert into public.fixtures (competicao, opponent, is_home, kickoff) values
  ('Brasileirão',    'Cruzeiro',   true,  '2026-08-29 21:20-03'),
  ('Copa do Brasil', 'Vitória',    false, '2026-09-02 21:30-03'),
  ('Brasileirão',    'Fluminense', false, '2026-09-05 21:00-03')
on conflict do nothing;

-- ============================================================
-- RLS: navegador (anon) só pode inserir a própria inscrição e ler dados públicos
-- ============================================================
alter table public.push_subscriptions enable row level security;
alter table public.live_state        enable row level security;
alter table public.standings         enable row level security;

-- anon pode registrar push
create policy "anon insere push" on public.push_subscriptions
  for insert to anon with check (true);

-- anon pode ler placar e tabela
create policy "anon lê live"      on public.live_state for select to anon using (true);
create policy "anon lê standings" on public.standings  for select to anon using (true);

-- A Edge Function usa a service_role key, que ignora RLS (faz os writes).

-- Realtime no placar
alter publication supabase_realtime add table public.live_state;

-- ============================================================
-- Agendamento (pg_cron) — chama a Edge Function
-- Troque <PROJECT_REF> e <POLLER_SECRET> pelos seus valores.
-- ============================================================

-- A cada 30s durante os jogos (a própria função sai rápido se não houver jogo na janela)
select cron.schedule('vasco-poller-live', '30 seconds', $$
  select net.http_post(
    url:='https://<PROJECT_REF>.functions.supabase.co/vasco-poller',
    headers:=jsonb_build_object('Content-Type','application/json','x-poller-secret','<POLLER_SECRET>'),
    body:=jsonb_build_object('task','live')
  );
$$);

-- Tabela do Brasileirão a cada 30 min
select cron.schedule('vasco-poller-standings', '*/30 * * * *', $$
  select net.http_post(
    url:='https://<PROJECT_REF>.functions.supabase.co/vasco-poller',
    headers:=jsonb_build_object('Content-Type','application/json','x-poller-secret','<POLLER_SECRET>'),
    body:=jsonb_build_object('task','standings')
  );
$$);

-- Para remover um agendamento depois, se precisar:
-- select cron.unschedule('vasco-poller-live');
-- select cron.unschedule('vasco-poller-standings');
