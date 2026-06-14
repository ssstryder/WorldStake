// scripts/atualizar-resultados.js
// Corre via GitHub Actions — vai buscar resultados à football-data.org
// e resolve automaticamente as apostas pendentes no Firestore

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

// ── Firebase Admin ──────────────────────────────────────────────────────────
initializeApp({
  credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  }),
});
const db = getFirestore();

// ── Configuração ────────────────────────────────────────────────────────────
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;
const WC2026_ID        = 2000;

// ── Fetch jogos ─────────────────────────────────────────────────────────────
async function fetchJogos() {
  const url = `https://api.football-data.org/v4/competitions/${WC2026_ID}/matches?status=FINISHED,LIVE`;
  const res = await fetch(url, {
    headers: { "X-Auth-Token": FOOTBALL_API_KEY }
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.matches || []).map(m => ({
    id:       m.id,
    casa:     m.homeTeam.name,
    fora:     m.awayTeam.name,
    status:   m.status,
    golsCasa: m.score?.fullTime?.home ?? null,
    golsFora: m.score?.fullTime?.away ?? null,
  }));
}

// ── Normalizar nome para fuzzy match ────────────────────────────────────────
function norm(s) {
  return (s || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, "").trim();
}
function similar(a, b) {
  a = norm(a); b = norm(b);
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const wa = new Set(a.split(" ").filter(w => w.length > 2));
  const wb = new Set(b.split(" ").filter(w => w.length > 2));
  const inter = [...wa].filter(w => wb.has(w));
  return inter.length ? 0.7 : 0;
}
function matchJogo(jogoStr, jogos) {
  const parts = jogoStr.split(/\s+vs\.?\s+/i);
  if (parts.length < 2) return null;
  const [casaStr, foraStr] = parts;
  let best = 0, found = null;
  for (const j of jogos) {
    const s = (similar(casaStr, j.casa) + similar(foraStr, j.fora)) / 2;
    if (s > best) { best = s; found = j; }
  }
  return best >= 0.6 ? found : null;
}

// ── Resolver apostas ─────────────────────────────────────────────────────────
async function resolverApostas(jogos) {
  const terminados = jogos.filter(j => j.status === "FINISHED");
  if (!terminados.length) { console.log("Sem jogos terminados."); return; }

  const apostasSnap = await db.collection("apostas").where("estado", "==", "pendente").get();
  if (apostasSnap.empty) { console.log("Sem apostas pendentes."); return; }

  let resolvidas = 0;

  for (const apostaDoc of apostasSnap.docs) {
    const aposta = apostaDoc.data();

    // Aposta sem seleções individuais (simples ou legacy)
    if (!aposta.apostas || !Array.isArray(aposta.apostas)) {
      if (!aposta.jogoId) continue;
      const jogo = terminados.find(j => j.id === aposta.jogoId);
      if (!jogo) continue;
      const resultado = jogo.golsCasa > jogo.golsFora ? "casa"
                      : jogo.golsFora > jogo.golsCasa ? "fora" : "empate";
      const ganhou = aposta.previsaoSimples === resultado;
      const lucro  = ganhou ? +(aposta.valor * aposta.odd - aposta.valor).toFixed(2) : +(-aposta.valor).toFixed(2);
      await apostaDoc.ref.update({ estado: ganhou ? "ganha" : "perdida", lucro, resolvidaEm: FieldValue.serverTimestamp() });
      if (ganhou) await atualizarSaldo(aposta.uid, aposta.valor * aposta.odd);
      resolvidas++;
      continue;
    }

    // Aposta com seleções (múltipla)
    let todasResolvidas = true;
    let algumaPerdida   = false;

    const apostasAtualizadas = aposta.apostas.map(sel => {
      if (sel.estadoSel && sel.estadoSel !== "pendente") return sel; // já resolvida

      // Tenta encontrar o jogo pelo jogoId ou por fuzzy match
      const jogo = sel.jogoId
        ? terminados.find(j => j.id === sel.jogoId)
        : matchJogo(sel.jogo, terminados);

      if (!jogo) { todasResolvidas = false; return sel; }

      // Determina resultado simples (vitória/empate)
      const resultado  = jogo.golsCasa > jogo.golsFora ? "casa"
                       : jogo.golsFora > jogo.golsCasa ? "fora" : "empate";
      const prevNorm   = norm(sel.previsao);
      const casaNorm   = norm(sel.casaReal || sel.jogo.split(" vs ")[0] || "");
      const foraNorm   = norm(sel.foraReal || sel.jogo.split(" vs ")[1] || "");

      let ganhouSel = false;
      if (prevNorm.includes("empate")) {
        ganhouSel = resultado === "empate";
      } else if (prevNorm.includes("nao") || prevNorm.includes("não")) {
        // Tipos especiais (não ambas marcam, handicap, marcador) — deixa para o admin
        todasResolvidas = false;
        return sel;
      } else if (resultado === "casa") {
        ganhouSel = prevNorm.includes(casaNorm) || prevNorm.includes("casa");
      } else if (resultado === "fora") {
        ganhouSel = prevNorm.includes(foraNorm) || prevNorm.includes("fora");
      }

      if (!ganhouSel) algumaPerdida = true;
      return { ...sel, estadoSel: ganhouSel ? "ganha" : "perdida", golsCasa: jogo.golsCasa, golsFora: jogo.golsFora };
    });

    const updates = { apostas: apostasAtualizadas };

    if (todasResolvidas) {
      const ganhouTudo = !algumaPerdida;
      const lucro = ganhouTudo
        ? +(aposta.valor * aposta.odd - aposta.valor).toFixed(2)
        : +(-aposta.valor).toFixed(2);
      updates.estado      = ganhouTudo ? "ganha" : "perdida";
      updates.lucro       = lucro;
      updates.resolvidaEm = FieldValue.serverTimestamp();
      if (ganhouTudo) await atualizarSaldo(aposta.uid, aposta.valor * aposta.odd);
      resolvidas++;
      console.log(`  ${ganhouTudo ? "✅" : "❌"} Aposta de uid:${aposta.uid} — ${aposta.jogo}`);
    }

    await apostaDoc.ref.update(updates);
  }

  console.log(`\nTotal resolvidas: ${resolvidas}`);
}

async function atualizarSaldo(uid, ganho) {
  const ref  = db.collection("jogadores").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return;
  await ref.update({ saldo: +(snap.data().saldo + ganho).toFixed(2) });
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n=== Atualização ${new Date().toISOString()} ===`);
  try {
    console.log("A buscar jogos...");
    const jogos = await fetchJogos();
    console.log(`${jogos.length} jogos encontrados, ${jogos.filter(j=>j.status==="FINISHED").length} terminados`);
    await resolverApostas(jogos);
    console.log("=== Concluído ===\n");
    process.exit(0);
  } catch(e) {
    console.error("Erro:", e.message);
    process.exit(1);
  }
})();
