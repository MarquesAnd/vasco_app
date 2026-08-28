// ============================================================
// Vasco poller — Supabase Edge Function (Deno)
// - task 'live'     : lê /ao-vivo, detecta gol/vitória do Vasco e envia push
// - task 'standings': atualiza a tabela do Brasileirão
//
// Secrets necessários (supabase secrets set ...):
//   API_FUTEBOL_TOKEN, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
//   VAPID_SUBJECT (ex: mailto:voce@email.com), POLLER_SECRET,
//   SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (já vêm no ambiente da função)
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const API_BASE = "https://api.api-futebol.com.br/v1";
const BRASILEIRAO = 10; // campeonato_id
// const COPA_DO_BRASIL = 2; // se quiser cobrir a Copa, dá pra checar aqui também.

const env = (k: string) => Deno.env.get(k) ?? "";
const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

webpush.setVapidDetails(env("VAPID_SUBJECT"), env("VAPID_PUBLIC_KEY"), env("VAPID_PRIVATE_KEY"));

const isVasco = (t: any) =>
  t && (String(t.sigla).toUpperCase() === "VAS" ||
        String(t.nome_popular ?? t.nome ?? "").toLowerCase().includes("vasco"));

async function apiGet(path: string) {
  const r = await fetch(API_BASE + path, {
    headers: { Authorization: `Bearer ${env("API_FUTEBOL_TOKEN")}` },
  });
  if (!r.ok) throw new Error(`API ${path} -> ${r.status}`);
  return r.json();
}

// Só vale a pena consultar o /ao-vivo perto de um jogo do Vasco.
async function insideMatchWindow(): Promise<boolean> {
  const { data } = await supabase.from("fixtures").select("kickoff");
  if (!data || !data.length) return true; // sem fixtures cadastradas: não bloqueia
  const now = Date.now();
  return data.some((f: any) => {
    const k = new Date(f.kickoff).getTime();
    return now >= k - 10 * 60_000 && now <= k + 140 * 60_000; // -10min até +2h20
  });
}

async function sendPushAll(payload: Record<string, unknown>) {
  const { data: subs } = await supabase.from("push_subscriptions").select("*");
  if (!subs) return;
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (s: any) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
      );
    } catch (err: any) {
      // 404/410 = inscrição morta: limpa
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await supabase.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      }
    }
  }));
}

async function taskLive() {
  if (!(await insideMatchWindow())) return { skipped: "fora da janela de jogo" };

  const live = await apiGet("/ao-vivo"); // array de partidas em andamento
  const list: any[] = Array.isArray(live) ? live : (live?.partidas ?? []);
  const match = list.find((m) => isVasco(m.time_mandante) || isVasco(m.time_visitante));

  // Não há Vasco ao vivo agora: talvez o jogo tenha acabado.
  if (!match) {
    const { data: prev } = await supabase
      .from("live_state").select("*").eq("status", "andamento").limit(1);
    if (prev && prev[0]) {
      const p = prev[0];
      const won = p.vasco_goals > p.opp_goals;
      const drew = p.vasco_goals === p.opp_goals;
      await sendPushAll({
        title: won ? "🏆 VITÓRIA DO VASCO!" : drew ? "Fim de jogo" : "Fim de jogo",
        body: won
          ? `${p.home_name} ${p.score_home} × ${p.score_away} ${p.away_name} — é do Gigante!`
          : `${p.home_name} ${p.score_home} × ${p.score_away} ${p.away_name}`,
        win: won, tag: "vasco-ft", url: "./index.html",
      });
      await supabase.from("live_state").update({ status: "encerrada", updated_at: new Date().toISOString() })
        .eq("partida_id", p.partida_id);
    }
    return { live: false };
  }

  // Há Vasco ao vivo. Monta o estado atual.
  // OBS: confirme os nomes dos campos com a doc da API-Futebol; ajuste se necessário.
  const home = match.time_mandante, away = match.time_visitante;
  const sh = Number(match.placar_mandante ?? match.placar_casa ?? 0);
  const sa = Number(match.placar_visitante ?? match.placar_fora ?? 0);
  const vascoHome = isVasco(home);
  const vascoGoals = vascoHome ? sh : sa;
  const oppGoals = vascoHome ? sa : sh;
  const pid = String(match.partida_id ?? match.id ?? "vasco-live");

  const { data: prevRows } = await supabase.from("live_state").select("*").eq("partida_id", pid).limit(1);
  const prev = prevRows?.[0];

  // GOL DO VASCO?
  if (!prev || vascoGoals > (prev.vasco_goals ?? 0)) {
    if (prev) { // não notifica no primeiro registro (kickoff 0x0)
      await sendPushAll({
        title: "⚽ GOOOL DO VASCO!",
        body: `${home.nome_popular ?? home.nome} ${sh} × ${sa} ${away.nome_popular ?? away.nome}`,
        tag: "vasco-goal", url: "./index.html",
      });
    }
  }

  await supabase.from("live_state").upsert({
    partida_id: pid,
    competicao: match.campeonato?.nome ?? "Ao vivo",
    home_name: home.nome_popular ?? home.nome, home_sigla: (home.sigla ?? "").toUpperCase(),
    away_name: away.nome_popular ?? away.nome, away_sigla: (away.sigla ?? "").toUpperCase(),
    score_home: sh, score_away: sa,
    vasco_goals: vascoGoals, opp_goals: oppGoals,
    minuto: match.tempo ?? match.minuto ?? null,
    status: "andamento", updated_at: new Date().toISOString(),
  }, { onConflict: "partida_id" });

  return { live: true, sh, sa };
}

async function taskStandings() {
  const tab = await apiGet(`/campeonatos/${BRASILEIRAO}/tabela`);
  const rows: any[] = Array.isArray(tab) ? tab : (tab?.tabela ?? []);
  const now = new Date().toISOString();
  const mapped = rows.map((r: any) => ({
    pos: r.posicao ?? r.pos,
    team: r.time?.nome_popular ?? r.nome_time ?? r.time?.nome,
    sigla: (r.time?.sigla ?? r.sigla ?? "").toUpperCase(),
    played: r.jogos ?? r.pj,
    gd: String(r.saldo_gols ?? r.saldo_de_gols ?? r.sg ?? ""),
    points: r.pontos ?? r.pts,
    updated_at: now,
  })).filter((r) => r.pos);
  if (mapped.length) await supabase.from("standings").upsert(mapped, { onConflict: "pos" });
  return { standings: mapped.length };
}

Deno.serve(async (req) => {
  // proteção simples: cron manda o header secreto
  if (req.headers.get("x-poller-secret") !== env("POLLER_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  let task = "live";
  try { task = (await req.json())?.task ?? "live"; } catch (_) { /* default */ }

  try {
    const out = task === "standings" ? await taskStandings() : await taskLive();
    return new Response(JSON.stringify({ ok: true, task, ...out }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
