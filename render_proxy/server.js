const https  = require("https");
const http   = require("http");

const FOOTBALL_API_KEY   = process.env.FOOTBALL_API_KEY;   // football-data.org
const RAPIDAPI_KEY       = process.env.RAPIDAPI_KEY;        // api-football via RapidAPI
const FIREBASE_PROJECT_ID   = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY  = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const WC2026_ID_FD  = 2000;   // football-data.org World Cup ID
const WC2026_ID_AF  = 1;      // api-football World Cup ID (FIFA World Cup 2026)
const PORT = process.env.PORT || 3001;

// ── Firebase ────────────────────────────────────────────────────────────────
let db = null;
async function getDB() {
  if (db) return db;
  const { initializeApp, cert, getApps } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  if (!getApps().length) {
    initializeApp({ credential: cert({ projectId: FIREBASE_PROJECT_ID, clientEmail: FIREBASE_CLIENT_EMAIL, privateKey: FIREBASE_PRIVATE_KEY }) });
  }
  db = getFirestore();
  return db;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    }).on("error", reject);
  });
}

// ── Normalização ─────────────────────────────────────────────────────────────
function norm(s) {
  return (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9 ]/g,"").trim();
}
function similar(a, b) {
  a = norm(a); b = norm(b);
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const inter = a.split(" ").filter(w => w.length > 2 && b.includes(w));
  return inter.length ? 0.7 : 0;
}
function matchJogo(jogoStr, jogos) {
  const parts = jogoStr.split(/\s+vs\.?\s+/i);
  if (parts.length < 2) return null;
  const [casaStr, foraStr] = parts;
  let best = 0, found = null;
  for (const j of jogos) {
    const s = (Math.max(similar(casaStr, j.casa), similar(casaStr, j.casaShort||"")) +
               Math.max(similar(foraStr, j.fora), similar(foraStr, j.foraShort||""))) / 2;
    if (s > best) { best = s; found = j; }
  }
  return best >= 0.55 ? found : null;
}

// ── football-data.org — lista jogos ──────────────────────────────────────────
async function fetchJogosFD() {
  const url = `https://api.football-data.org/v4/competitions/${WC2026_ID_FD}/matches?status=SCHEDULED,LIVE,FINISHED`;
  const data = await fetchJSON(url, { "X-Auth-Token": FOOTBALL_API_KEY });
  return (data.matches || []).map(m => ({
    id:        m.id,
    idAF:      null, // será preenchido pelo match
    casa:      m.homeTeam.name,
    fora:      m.awayTeam.name,
    casaShort: m.homeTeam.shortName || m.homeTeam.tla || m.homeTeam.name,
    foraShort: m.awayTeam.shortName || m.awayTeam.tla || m.awayTeam.name,
    data:      m.utcDate,
    status:    m.status,
    golsCasa:  m.score?.fullTime?.home ?? null,
    golsFora:  m.score?.fullTime?.away ?? null,
    fase:      m.stage
  }));
}

// ── API-Football — detalhes de um jogo (marcadores, stats) ───────────────────
async function fetchDetalhesJogo(fixtureId) {
  const url = `https://api-football-v1.p.rapidapi.com/v3/fixtures?id=${fixtureId}`;
  const data = await fetchJSON(url, {
    "X-RapidAPI-Key":  RAPIDAPI_KEY,
    "X-RapidAPI-Host": "api-football-v1.p.rapidapi.com"
  });
  return data.response?.[0] || null;
}

// ── API-Football — busca fixture ID pelo nome das equipas ────────────────────
async function fetchFixtureId(casaNorm, foraNorm) {
  const url = `https://api-football-v1.p.rapidapi.com/v3/fixtures?league=${WC2026_ID_AF}&season=2026`;
  const data = await fetchJSON(url, {
    "X-RapidAPI-Key":  RAPIDAPI_KEY,
    "X-RapidAPI-Host": "api-football-v1.p.rapidapi.com"
  });
  const fixtures = data.response || [];
  let best = 0, found = null;
  for (const f of fixtures) {
    const s = (Math.max(similar(casaNorm, f.teams.home.name), similar(casaNorm, f.teams.home.shortName||"")) +
               Math.max(similar(foraNorm, f.teams.away.name), similar(foraNorm, f.teams.away.shortName||""))) / 2;
    if (s > best) { best = s; found = f; }
  }
  return best >= 0.55 ? found : null;
}

// ── Lógica de resolução automática ───────────────────────────────────────────
function resolverSelecao(sel, jogo, detalhes) {
  const prev = norm(sel.previsao || "");
  const golsCasa = jogo.golsCasa ?? detalhes?.goals?.home ?? null;
  const golsFora = jogo.golsFora ?? detalhes?.goals?.away ?? null;

  if (golsCasa === null || golsFora === null) return null; // jogo não terminou

  const resultado = golsCasa > golsFora ? "casa" : golsFora > golsCasa ? "fora" : "empate";
  const casaNorm  = norm(sel.casaReal || jogo.casa || "");
  const foraNorm  = norm(sel.foraReal || jogo.fora || "");

  // ── 1. Vitória / Empate ──
  if (prev.includes("empate")) return resultado === "empate";
  if (prev.includes("tempo regulamentar") || prev.includes("resultado")) {
    if (prev.includes(casaNorm) || prev.includes("casa")) return resultado === "casa";
    if (prev.includes(foraNorm) || prev.includes("fora")) return resultado === "fora";
  }

  // ── 2. Ambas as equipas marcam ──
  if (prev.includes("ambas") && prev.includes("marc")) {
    const ambas = golsCasa > 0 && golsFora > 0;
    if (prev.includes("nao") || prev.includes("não")) return !ambas;
    return ambas;
  }

  // ── 3. Resultado correto ──
  const regCorreto = prev.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (regCorreto) {
    const gc = parseInt(regCorreto[1]);
    const gf = parseInt(regCorreto[2]);
    // Verifica qual equipa está primeiro na previsão
    const casaPrimeiro = prev.indexOf(casaNorm) < prev.indexOf(foraNorm) || prev.indexOf(casaNorm) !== -1;
    if (casaPrimeiro) return golsCasa === gc && golsFora === gf;
    return golsCasa === gf && golsFora === gc;
  }

  // ── 4. Mais de / Menos de golos ──
  const regMaisMenos = prev.match(/(mais|menos|over|under)\s*(?:de\s*)?(\d+(?:\.\d+)?)/);
  if (regMaisMenos) {
    const total = golsCasa + golsFora;
    const limite = parseFloat(regMaisMenos[2]);
    const mais = regMaisMenos[1].includes("mais") || regMaisMenos[1].includes("over");
    return mais ? total > limite : total < limite;
  }

  // ── 5. Handicap ──
  const regHandicap = prev.match(/\(([+-]?\d+(?:\.\d+)?)\)/);
  if (regHandicap) {
    const handicap = parseFloat(regHandicap[1]);
    const eqCasa = prev.includes(casaNorm);
    const golosCasaAdj = eqCasa ? golsCasa + handicap : golsCasa;
    const golosFora = eqCasa ? golsFora : golsFora + Math.abs(handicap);
    if (eqCasa) return golosCasaAdj > golsFora;
    return golsFora + handicap > golsCasa;
  }

  // ── 6. Marcador ──
  if (detalhes) {
    const eventos = detalhes.events || [];
    const golos   = eventos.filter(e => e.type === "Goal" && e.detail !== "Missed Penalty");
    const marcadores = golos.map(g => norm(g.player?.name || ""));

    // Extrai nome do marcador da previsão
    // Ex: "Cristiano Ronaldo Marcar" ou "R. Jiménez ou J. Quiñones marca o 2º golo"
    const palavrasChave = ["marcar", "marca", "marcar", "golo", "goal", "scorer"];
    let prevSemKeywords = prev;
    palavrasChave.forEach(p => { prevSemKeywords = prevSemKeywords.replace(new RegExp(p, "g"), ""); });
    prevSemKeywords = prevSemKeywords.replace(/\d+[ºª°]/g, "").trim();

    // Múltiplos marcadores com "ou"
    const candidatos = prevSemKeywords.split(/\s+ou\s+/).map(s => norm(s.trim()));

    // Verifica se algum candidato marcou
    const marcou = candidatos.some(candidato => {
      if (!candidato || candidato.length < 3) return false;
      return marcadores.some(m => similar(m, candidato) >= 0.7 ||
        // Tenta match só com apelido
        candidato.split(" ").some(parte => parte.length > 3 && m.includes(parte))
      );
    });

    // "Sem sofrer golos" / clean sheet
    if (prev.includes("sem sofrer") || prev.includes("clean sheet")) {
      const eqCasaCS = prev.includes(casaNorm);
      return eqCasaCS ? golsFora === 0 : golsCasa === 0;
    }

    return marcou;
  }

  return null; // não conseguiu resolver
}

// ── Resolução automática de apostas ──────────────────────────────────────────
async function resolverApostas(jogos) {
  const { FieldValue } = require("firebase-admin/firestore");
  const db = await getDB();
  const terminados = jogos.filter(j => j.status === "FINISHED");
  if (!terminados.length) return { resolvidas: 0 };

  const snap = await db.collection("apostas").where("estado", "==", "pendente").get();
  if (snap.empty) return { resolvidas: 0 };

  // Cache de detalhes por jogoId para não repetir pedidos à API
  const detalhesCache = {};

  let resolvidas = 0;

  for (const apostaDoc of snap.docs) {
    const aposta = apostaDoc.data();
    if (!aposta.apostas || !Array.isArray(aposta.apostas)) continue;

    let todasResolvidas = true;
    let algumaPerdida   = false;

    const apostasAtualizadas = await Promise.all(aposta.apostas.map(async sel => {
      if (sel.estadoSel && sel.estadoSel !== "pendente") return sel;

      // Encontra o jogo
      const jogo = sel.jogoId
        ? terminados.find(j => j.id === sel.jogoId)
        : matchJogo(sel.jogo, terminados);

      if (!jogo) { todasResolvidas = false; return sel; }

      // Busca detalhes via API-Football se ainda não estiver em cache
      let detalhes = detalhesCache[jogo.id] || null;
      if (!detalhes && RAPIDAPI_KEY) {
        try {
          // Primeiro tenta encontrar o fixture ID
          if (!jogo.idAF) {
            const fixture = await fetchFixtureId(jogo.casa, jogo.fora);
            if (fixture) {
              jogo.idAF = fixture.fixture.id;
              detalhes  = fixture;
            }
          } else {
            detalhes = await fetchDetalhesJogo(jogo.idAF);
          }
          detalhesCache[jogo.id] = detalhes;
        } catch(e) {
          console.warn("API-Football error:", e.message);
        }
      }

      const ganhouSel = resolverSelecao(sel, jogo, detalhes);

      if (ganhouSel === null) { todasResolvidas = false; return sel; } // não resolvido
      if (!ganhouSel) algumaPerdida = true;

      return {
        ...sel,
        estadoSel: ganhouSel ? "ganha" : "perdida",
        golsCasa:  jogo.golsCasa,
        golsFora:  jogo.golsFora
      };
    }));

    const updates = { apostas: apostasAtualizadas };

    if (todasResolvidas) {
      const ganhouTudo = !algumaPerdida;
      const lucro = ganhouTudo
        ? +(aposta.valor * aposta.odd - aposta.valor).toFixed(2)
        : +(-aposta.valor).toFixed(2);
      updates.estado      = ganhouTudo ? "ganha" : "perdida";
      updates.lucro       = lucro;
      updates.resolvidaEm = FieldValue.serverTimestamp();
      if (ganhouTudo) {
        const jogRef  = db.collection("jogadores").doc(aposta.uid);
        const jogSnap = await jogRef.get();
        if (jogSnap.exists) {
          await jogRef.update({ saldo: +(jogSnap.data().saldo + aposta.valor * aposta.odd).toFixed(2) });
        }
      }
      console.log(`  ${ganhouTudo?"✅":"❌"} ${aposta.jogo}`);
      resolvidas++;
    }

    await apostaDoc.ref.update(updates);
  }

  return { resolvidas };
}

// ── Servidor ─────────────────────────────────────────────────────────────────
const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

http.createServer(async (req, res) => {
  Object.entries(cors).forEach(([k,v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // GET /jogos
  if (req.url === "/jogos" && req.method === "GET") {
    try {
      const jogos = await fetchJogosFD();
      res.writeHead(200); res.end(JSON.stringify({ jogos }));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // GET /atualizar
  if (req.url === "/atualizar" && req.method === "GET") {
    try {
      console.log(`[${new Date().toISOString()}] A atualizar...`);
      const jogos     = await fetchJogosFD();
      const resultado = await resolverApostas(jogos);
      console.log(`Resolvidas: ${resultado.resolvidas}`);
      res.writeHead(200); res.end(JSON.stringify({ ok: true, ...resultado, timestamp: new Date().toISOString() }));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // POST /match
  if (req.url === "/match" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { apostas } = JSON.parse(body);
        const jogos = await fetchJogosFD();
        const matches = apostas.map(jogoStr => {
          const match = matchJogo(jogoStr, jogos);
          return {
            jogoStr,
            jogoId:   match?.id    || null,
            casa:     match?.casa  || null,
            fora:     match?.fora  || null,
            data:     match?.data  || null,
            status:   match?.status|| null,
            golsCasa: match?.golsCasa ?? null,
            golsFora: match?.golsFora ?? null
          };
        });
        res.writeHead(200); res.end(JSON.stringify({ matches }));
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: "not found" }));

}).listen(PORT, () => console.log(`Proxy a correr na porta ${PORT}`));
