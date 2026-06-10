const https = require("https");
const http  = require("http");

const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY || "COLOCA_AQUI_A_TUA_CHAVE";
const WC2026_ID        = 2000;
const PORT             = process.env.PORT || 3001;

function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error("JSON parse error")); }
      });
    }).on("error", reject);
  });
}

http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    res.writeHead(204); res.end(); return;
  }

  if (req.url === "/jogos") {
    try {
      const url  = `https://api.football-data.org/v4/competitions/${WC2026_ID}/matches?status=SCHEDULED,LIVE,FINISHED`;
      const data = await fetchJSON(url, { "X-Auth-Token": FOOTBALL_API_KEY });
      const jogos = (data.matches || []).map(m => ({
        id:        m.id,
        casa:      m.homeTeam.name,
        fora:      m.awayTeam.name,
        casaShort: m.homeTeam.shortName || m.homeTeam.name,
        foraShort: m.awayTeam.shortName || m.awayTeam.name,
        data:      m.utcDate,
        status:    m.status,
        golsCasa:  m.score?.fullTime?.home ?? null,
        golsFora:  m.score?.fullTime?.away ?? null,
        fase:      m.stage
      }));
      res.writeHead(200);
      res.end(JSON.stringify({ jogos }));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "not found" }));

}).listen(PORT, () => console.log(`Proxy a correr na porta ${PORT}`));
