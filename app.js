import { initializeApp } from "firebase/app";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut, updateProfile } from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc, updateDoc, collection, onSnapshot, deleteDoc, serverTimestamp } from "firebase/firestore";

// ─── CONFIGURAÇÃO FIREBASE ────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "SUA_API_KEY",
  authDomain:        "SEU_AUTH_DOMAIN",
  projectId:         "SEU_PROJECT_ID",
  storageBucket:     "SEU_STORAGE_BUCKET",
  messagingSenderId: "SEU_MESSAGING_SENDER_ID",
  appId:             "SEU_APP_ID"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// ─── CONSTANTES ───────────────────────────────────────────────────────────
const SALDO_INICIAL = 10.00;
const ADMIN_UID     = "SEU_UID_DE_ADMIN";
const PROXY_URL     = "https://SEU_PROXY.onrender.com";
const GEMINI_API_KEY = "SUA_CHAVE_GEMINI";
const $ = id => document.getElementById(id);
const fmt    = v => (v >= 0 ? "+" : "") + v.toFixed(2) + " €";
const fmtAbs = v => v.toFixed(2) + " €";

// ─── ESTADO LOCAL (cache dos dados do Firestore) ──────────────────────────
let allJogadores = {};
let allApostas   = {};
let currentUser  = null;
let tabAtual     = "leaderboard";
let chartInstance = null;
let geminiApostas = [];

// ─── TOAST ────────────────────────────────────────────────────────────────
function showToast(msg, tipo) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast toast-" + tipo;
  t.style.opacity = "1";
  setTimeout(() => t.style.opacity = "0", 3000);
}

// ─── LOGIN ────────────────────────────────────────────────────────────────
let loginTab = "entrar";

window.trocarLoginTab = function(tab) {
  loginTab = tab;
  $("ltab-entrar").classList.toggle("active", tab === "entrar");
  $("ltab-registar").classList.toggle("active", tab === "registar");
  $("login-nome").style.display = tab === "registar" ? "block" : "none";
  $("login-btn").textContent = tab === "entrar" ? "Entrar" : "Criar conta";
  $("login-error").style.display = "none";
};

window.fazerLogin = async function() {
  const email    = $("login-email").value.trim();
  const password = $("login-password").value;
  const nome     = $("login-nome").value.trim();
  const errEl    = $("login-error");
  errEl.style.display = "none";

  if (!email || !password) { errEl.textContent = "Preenche email e password."; errEl.style.display = "block"; return; }

  try {
    if (loginTab === "registar") {
      if (!nome) { errEl.textContent = "Introduz um nome de utilizador."; errEl.style.display = "block"; return; }
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: nome });
      // Cria perfil no Firestore
      await setDoc(doc(db, "jogadores", cred.user.uid), {
        uid:    cred.user.uid,
        nome:   nome,
        avatar: nome.slice(0, 2).toUpperCase(),
        saldo:  SALDO_INICIAL,
        email:  email
      });
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch(e) {
    const msgs = {
      "auth/email-already-in-use": "Este email já está registado.",
      "auth/invalid-email": "Email inválido.",
      "auth/weak-password": "Password demasiado curta (mín. 6 caracteres).",
      "auth/invalid-credential": "Email ou password incorretos.",
      "auth/user-not-found": "Utilizador não encontrado.",
      "auth/wrong-password": "Password incorreta."
    };
    errEl.textContent = msgs[e.code] || e.message;
    errEl.style.display = "block";
  }
};

window.fazerLogout = async function() {
  await signOut(auth);
};

// ─── AUTH STATE ───────────────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
  currentUser = user;
  if (user) {
    $("login-screen").classList.remove("visible");
    iniciarListeners();
    mostrarTab("leaderboard");
  } else {
    $("login-screen").classList.add("visible");
  }
});

// ─── LISTENERS FIRESTORE ──────────────────────────────────────────────────
let unsubJog = null, unsubAp = null;


// ─── JOGOS & RESOLUÇÃO AUTOMÁTICA ────────────────────────────────────────
let allJogos = [];

async function carregarEResolver() {
  try {
    const res  = await fetch(`${PROXY_URL}/jogos`);
    const data = await res.json();
    allJogos   = data.jogos || [];
    await resolverApostasAuto(allJogos);
  } catch(e) {
    console.warn("Proxy indisponível:", e.message);
  }
}

async function resolverApostasAuto(jogos) {
  const terminados = jogos.filter(j => j.status === "FINISHED");
  if (!terminados.length) return;

  const pendentes = Object.values(allApostas).filter(a => a.estado === "pendente" && a.jogoId);
  if (!pendentes.length) return;

  for (const aposta of pendentes) {
    const jogo = terminados.find(j => j.id === aposta.jogoId);
    if (!jogo) continue;

    const resultado = jogo.golsCasa > jogo.golsFora ? "casa"
                    : jogo.golsFora > jogo.golsCasa ? "fora"
                    : "empate";
    const ganhou = aposta.previsaoSimples === resultado;
    const lucro  = ganhou
      ? +(aposta.valor * aposta.odd - aposta.valor).toFixed(2)
      : +(-aposta.valor).toFixed(2);

    await updateDoc(doc(db, "apostas", aposta.id), {
      estado: ganhou ? "ganha" : "perdida",
      lucro,
      resolvidaEm: serverTimestamp()
    });
    if (ganhou) {
      const jog = allJogadores[aposta.uid];
      if (jog) await updateDoc(doc(db, "jogadores", aposta.uid), {
        saldo: +(jog.saldo + aposta.valor * aposta.odd).toFixed(2)
      });
    }
  }
}

function iniciarListeners() {
  if (unsubJog) unsubJog();
  if (unsubAp)  unsubAp();

  // Carrega jogos e resolve apostas em background
  carregarEResolver();

  unsubJog = onSnapshot(collection(db, "jogadores"), snap => {
    allJogadores = {};
    snap.forEach(d => { allJogadores[d.id] = d.data(); });
    renderizarTudo();
  });

  unsubAp = onSnapshot(collection(db, "apostas"), snap => {
    allApostas = {};
    snap.forEach(d => { allApostas[d.id] = d.data(); });
    renderizarTudo();
    if (tabAtual === "grafico") renderGrafico();
  });
}

// ─── TABS ─────────────────────────────────────────────────────────────────
window.mostrarTab = function(tab) {
  tabAtual = tab;
  ["leaderboard","meu-perfil","todos","grafico"].forEach(t => {
    const tabEl = $(`tab-${t}`);
    const secEl = $(`section-${t}`);
    if (tabEl) tabEl.classList.toggle("active", t === tab);
    if (secEl) secEl.style.display = t === tab ? "block" : "none";
  });
  renderizarTudo();
  if (tab === "grafico") renderGrafico();
};

// ─── RENDER PRINCIPAL ─────────────────────────────────────────────────────
function renderizarTudo() {
  if (!currentUser) return;
  atualizarNavbar();
  if (tabAtual === "leaderboard") renderLeaderboard();
  else if (tabAtual === "meu-perfil") renderMeuPerfil();
  else if (tabAtual === "todos") renderTodos();
}

function atualizarNavbar() {
  const jog = allJogadores[currentUser?.uid];
  if (jog) {
    $("nav-avatar").textContent = jog.avatar;
    $("nav-nome").textContent   = jog.nome;
    $("nav-saldo").textContent  = fmtAbs(jog.saldo);
  }
}

function renderLeaderboard() {
  const sorted = Object.values(allJogadores).sort((a, b) => b.saldo - a.saldo);
  const apostas = Object.values(allApostas);

  $("stat-apostas").textContent   = apostas.length;
  $("stat-pendentes").textContent = apostas.filter(a => a.estado === "pendente").length;
  $("stat-jogadores").textContent = sorted.length;
  const melhor = apostas.filter(a => a.lucro !== undefined).sort((a,b) => b.lucro - a.lucro)[0];
  $("stat-melhor").textContent = melhor ? fmt(melhor.lucro) : "—";

  if (!sorted.length) {
    $("leaderboard-lista").innerHTML = "<p class='empty'>Ainda não há jogadores registados.</p>";
    return;
  }
  $("leaderboard-lista").innerHTML = sorted.map((j, i) => {
    const diff  = +(j.saldo - SALDO_INICIAL).toFixed(2);
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i+1}`;
    const isMe  = currentUser && j.uid === currentUser.uid;
    const minhas = apostas.filter(a => a.uid === j.uid);
    const ganhas = minhas.filter(a => a.estado === "ganha").length;
    const total  = minhas.filter(a => a.estado !== "pendente").length;
    const taxa   = total ? Math.round(ganhas/total*100) : 0;
    return `<div class="lb-row ${isMe ? "lb-me" : ""}">
      <div class="lb-rank">${medal}</div>
      <div class="lb-avatar">${j.avatar}</div>
      <div class="lb-info">
        <div class="lb-nome">${j.nome}${isMe ? ' <span class="tag-eu">tu</span>' : ""}</div>
        <div class="lb-meta">${ganhas}/${total} apostas · ${taxa}% acerto</div>
      </div>
      <div class="lb-saldo">
        <div class="lb-val">${fmtAbs(j.saldo)}</div>
        <div class="lb-diff ${diff >= 0 ? "pos" : "neg"}">${fmt(diff)}</div>
      </div>
    </div>`;
  }).join("");
}

function isAdmin() { return currentUser?.uid === ADMIN_UID; }

function renderMeuPerfil() {
  if (!currentUser) return;
  const jog = allJogadores[currentUser.uid];
  if (!jog) return;

  const diff = +(jog.saldo - SALDO_INICIAL).toFixed(2);
  $("perfil-avatar").textContent = jog.avatar;
  $("perfil-nome").textContent   = jog.nome;
  $("perfil-saldo").textContent  = fmtAbs(jog.saldo);
  $("perfil-diff").textContent   = fmt(diff);
  $("perfil-diff").className     = "lb-diff " + (diff >= 0 ? "pos" : "neg");

  const minhas = Object.values(allApostas)
    .filter(a => a.uid === currentUser.uid)
    .sort((a,b) => (b.criadaEm?.seconds||0) - (a.criadaEm?.seconds||0));
  $("perfil-stat-g").textContent    = minhas.filter(a => a.estado === "ganha").length;
  $("perfil-stat-p").textContent    = minhas.filter(a => a.estado === "perdida").length;
  $("perfil-stat-pend").textContent = minhas.filter(a => a.estado === "pendente").length;

  // Painel admin
  const adminPanel = $("admin-panel");
  if (adminPanel) adminPanel.style.display = isAdmin() ? "block" : "none";
  if (isAdmin()) renderAdminPanel();

  $("perfil-apostas").innerHTML = minhas.length ? minhas.map(a => `
    <div class="aposta-row">
      <div class="aposta-jogo">
        <span class="aposta-times">${a.jogo}</span>
        <span class="aposta-prev">${a.previsao} · odd ${a.odd?.toFixed ? a.odd.toFixed(2) : a.odd}</span>
      </div>
      <div class="aposta-dir">
        <span class="aposta-val">${fmtAbs(a.valor)}</span>
        <span class="chip chip-${a.estado}">${labelEstado(a.estado, a.lucro)}</span>
        <button onclick="removerAposta('${a.id}')" style="background:none;border:none;cursor:pointer;font-size:16px;color:#534AB7;padding:2px 4px;border-radius:4px;transition:color .2s" title="Remover aposta" onmouseover="this.style.color='#f87171'" onmouseout="this.style.color='#534AB7'">🗑</button>
      </div>
    </div>`).join("") : "<p class='empty'>Ainda não fizeste nenhuma aposta.</p>";
}

window.removerAposta = async function(id) {
  const aposta = allApostas[id];
  if (!aposta) return;
  if (!confirm(`Remover a aposta "${aposta.jogo}"?`)) return;

  const jog = allJogadores[aposta.uid];
  if (jog) {
    let novoSaldo = jog.saldo;
    if (aposta.estado === "pendente")       novoSaldo = +(novoSaldo + aposta.valor).toFixed(2);
    else if (aposta.estado === "ganha")     novoSaldo = +(novoSaldo - aposta.valor * aposta.odd).toFixed(2);
    else if (aposta.estado === "perdida")   novoSaldo = +(novoSaldo + aposta.valor).toFixed(2);
    await updateDoc(doc(db, "jogadores", aposta.uid), { saldo: novoSaldo });
  }
  await deleteDoc(doc(db, "apostas", id));
  showToast("Aposta removida e saldo atualizado.", "sucesso");
};

function renderTodos() {
  const apostas = Object.values(allApostas);
  if (!apostas.length) {
    $("todos-lista").innerHTML = "<p class='empty'>Ainda não há apostas.</p>"; return;
  }
  const grupos = {};
  apostas.forEach(a => {
    if (!grupos[a.jogo]) grupos[a.jogo] = [];
    grupos[a.jogo].push(a);
  });
  $("todos-lista").innerHTML = Object.entries(grupos).map(([jogo, bets]) => `
    <div class="grupo-jogo">
      <div class="grupo-titulo">${jogo}</div>
      ${bets.map(a => {
        const jog = Object.values(allJogadores).find(j => j.uid === a.uid);
        const temDetalhe = a.apostas && a.apostas.length > 0;
        const idDetalhe = "det_" + a.id;
        return `<div class="aposta-row" style="flex-direction:column;align-items:stretch;gap:0">
          <div style="display:flex;align-items:center;gap:10px">
            <div class="aposta-jogo" style="display:flex;align-items:center;gap:8px;flex:1">
              <div class="av-mini">${jog ? jog.avatar : "?"}</div>
              <div>
                <span class="aposta-times">${jog ? jog.nome : "?"}</span>
                <span class="aposta-prev">${a.previsao.length > 60 ? a.previsao.slice(0,60)+"…" : a.previsao} · odd ${a.odd?.toFixed ? a.odd.toFixed(2) : a.odd}</span>
              </div>
            </div>
            <div class="aposta-dir">
              <span class="aposta-val">${fmtAbs(a.valor)}</span>
              <span class="chip chip-${a.estado}">${labelEstado(a.estado, a.lucro)}</span>
            </div>
            ${temDetalhe ? `<button onclick="toggleDetalhe('${idDetalhe}')" style="background:none;border:none;cursor:pointer;color:#7F77DD;font-size:18px;padding:4px;transition:transform .2s;flex-shrink:0" id="btn_${idDetalhe}" title="Ver boletim">▼</button>` : ""}
          </div>
          ${temDetalhe ? `
          <div id="${idDetalhe}" style="display:none;margin-top:10px;padding:10px 12px;background:#0e0e1a;border-radius:8px;border:1px solid #2e2b54">
            <div style="font-size:11px;font-weight:700;color:#534AB7;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px">Boletim · ${a.apostas.length} seleção${a.apostas.length > 1 ? "ões" : ""}</div>
            ${a.apostas.map(s => `
              <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:7px 0;border-bottom:1px solid #2e2b54">
                <div>
                  <div style="font-size:13px;font-weight:600;color:#e8e7f8">${s.jogo}</div>
                  <div style="font-size:12px;color:#7F77DD;margin-top:2px">${s.previsao}</div>
                </div>
                <div style="font-size:13px;font-weight:700;color:#AFA9EC;flex-shrink:0;margin-left:12px">× ${s.odd}</div>
              </div>`).join("")}
            <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:13px">
              <span style="color:#7F77DD">Odd total</span>
              <strong style="color:#e8e7f8">${a.odd?.toFixed ? a.odd.toFixed(2) : a.odd}</strong>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:13px">
              <span style="color:#7F77DD">Apostado</span>
              <strong style="color:#e8e7f8">${fmtAbs(a.valor)}</strong>
            </div>
            ${a.valor && a.odd ? `<div style="display:flex;justify-content:space-between;margin-top:4px;font-size:13px">
              <span style="color:#7F77DD">Ganhos potenciais</span>
              <strong style="color:#7F77DD">${(a.valor * a.odd).toFixed(2)} €</strong>
            </div>` : ""}
          </div>` : ""}
        </div>`;
      }).join("")}
    </div>`).join("");
}

window.toggleDetalhe = function(id) {
  const el  = $(id);
  const btn = $("btn_" + id);
  if (!el) return;
  const aberto = el.style.display !== "none";
  el.style.display  = aberto ? "none" : "block";
  btn.style.transform = aberto ? "" : "rotate(180deg)";
}

function labelEstado(est, lucro) {
  if (est === "pendente") return "Pendente";
  if (est === "ganha")    return "Ganha " + (lucro !== undefined ? fmt(lucro) : "");
  if (est === "perdida")  return "Perdida " + (lucro !== undefined ? fmt(lucro) : "");
  return est;
}

// ─── MODAL NOVA APOSTA ────────────────────────────────────────────────────
function abrirModalAposta() {
  const jog = allJogadores[currentUser?.uid];
  if (!jog) return showToast("Seleciona o teu perfil primeiro.", "erro");
  $("modal-saldo-disp").textContent = fmtAbs(jog.saldo);
  $("modal-aposta").style.display = "flex";
}
function fecharModalAposta() {
  $("modal-aposta").style.display = "none";
  ["inp-jogo","inp-previsao","inp-odd","inp-valor"].forEach(id => $(id).value = "");
}
window.submeterAposta = async function() {
  const jog = allJogadores[currentUser?.uid];
  if (!jog) return;
  const jogo     = $("inp-jogo").value.trim();
  const previsao = $("inp-previsao").value.trim();
  const odd      = parseFloat($("inp-odd").value);
  const valor    = parseFloat($("inp-valor").value);
  if (!jogo || !previsao || isNaN(odd) || isNaN(valor) || valor <= 0)
    return showToast("Preenche todos os campos.", "erro");
  if (valor > jog.saldo)
    return showToast("Saldo insuficiente.", "erro");

  const id = `${currentUser.uid}_${Date.now()}`;
  await setDoc(doc(db, "apostas", id), {
    id, uid: currentUser.uid,
    jogo, previsao, odd, valor,
    estado: "pendente",
    criadaEm: serverTimestamp()
  });
  await updateDoc(doc(db, "jogadores", currentUser.uid), {
    saldo: +(jog.saldo - valor).toFixed(2)
  });
  fecharModalAposta();
  showToast("Aposta registada!", "sucesso");
}

// ─── MODAL IMPORTAR PRINT (GEMINI) ────────────────────────────────────────


window.abrirModalImagem = function() {
  if (!currentUser) return showToast("Precisas de fazer login primeiro.", "erro");
  $("modal-imagem").style.display = "flex";
  $("gemini-preview").innerHTML = "";
  $("gemini-resultado").innerHTML = "";
  $("inp-imagem").value = "";
  geminiApostas = [];
  // Restaura chave guardada
  $("inp-gemini-key").value = GEMINI_API_KEY;
}
window.fecharModalImagem = function() {
  $("modal-imagem").style.display = "none";
}

window.lerImagemGemini = async function() {
  const file = $("inp-imagem").files[0];
  if (!file) return showToast("Escolhe uma imagem.", "erro");
  const chave = GEMINI_API_KEY;
  if (!chave || chave === "COLOCA_AQUI_A_TUA_CHAVE_GEMINI") return showToast("Chave Gemini não configurada.", "erro");

  const reader = new FileReader();
  reader.onload = e => {
    $("gemini-preview").innerHTML = `<img src="${e.target.result}" style="width:100%;border-radius:8px;margin-bottom:1rem">`;
  };
  reader.readAsDataURL(file);
  $("gemini-resultado").innerHTML = `<div class="gemini-loading">⚽ A analisar o boletim...</div>`;

  const base64 = await new Promise(res => {
    const r = new FileReader();
    r.onload = e => res(e.target.result.split(",")[1]);
    r.readAsDataURL(file);
  });

  const prompt = `Analisa esta imagem de um boletim de apostas desportivas.
Extrai TODAS as apostas e devolve APENAS um array JSON valido, sem texto extra, sem backticks, sem markdown.
Cada objeto deve ter:
- "jogo": string "Equipa A vs Equipa B"
- "previsao": string com o que foi apostado
- "odd": numero
- "valor": numero em euros (null se nao visivel)
- "ganhos_potenciais": numero em euros (null se nao visivel)
Devolve APENAS o array JSON.`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${chave}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: file.type, data: base64 } }] }] })
      }
    );
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const texto = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const match = texto.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (!match) throw new Error("Resposta inesperada: " + texto.slice(0, 150));
    geminiApostas = JSON.parse(match[0]);
    mostrarPreviewGemini(geminiApostas);
  } catch(e) {
    $("gemini-resultado").innerHTML = `<div class="gemini-erro">Erro: ${e.message}</div>`;
  }
}

window.mostrarPreviewGemini = function(apostas) {
  if (!apostas.length) {
    $("gemini-resultado").innerHTML = `<div class="gemini-erro">Nenhuma aposta encontrada.</div>`; return;
  }
  const jog = allJogadores[currentUser?.uid];
  const saldo = jog ? jog.saldo : 0;
  const valor = apostas[0]?.valor || null;
  const ganhos = apostas[0]?.ganhos_potenciais || null;
  const semSaldo = valor && valor > saldo;
  $("gemini-resultado").innerHTML = `
    <div class="gemini-titulo">Encontrei ${apostas.length} aposta${apostas.length > 1 ? "s" : ""}:</div>
    ${apostas.map(a => `<div class="gemini-aposta">
      <div class="gemini-jogo">${a.jogo}</div>
      <div class="gemini-det">${a.previsao} · odd <strong>${a.odd}</strong></div>
    </div>`).join("")}
    <div class="gemini-resumo" style="margin-top:.75rem">
      <div style="width:100%">
        <label class="form-label" style="margin-bottom:4px">Valor apostado (€)</label>
        <input id="gemini-valor" type="number" class="form-input" style="margin-bottom:.5rem"
          placeholder="ex: 2.00" min="0.10" step="0.10"
          value="${valor ? valor.toFixed(2) : ""}"
          oninput="atualizarGanhosPrevistos()">
      </div>
      <div style="width:100%;background:var(--verde-l);border-radius:var(--rad-sm);padding:10px 14px;font-size:14px;color:var(--verde2)">
        💰 Ganhos potenciais: <strong id="gemini-ganhos-prev">${ganhos ? ganhos.toFixed(2) + " €" : "—"}</strong>
        <span style="font-size:12px;color:var(--cinza3);margin-left:6px" id="gemini-odd-total"></span>
      </div>
    </div>
    ${semSaldo ? `<div class="gemini-erro" style="margin-top:.5rem">Saldo insuficiente (tens ${saldo.toFixed(2)} €)</div>` : ""}
    <div style="display:flex;gap:8px;margin-top:1rem">
      <button class="btn-primary" onclick="confirmarApostasGemini()">Confirmar e registar</button>
      <button class="btn-secondary" onclick="fecharModalImagem()">Cancelar</button>
    </div>`;
}

window.atualizarGanhosPrevistos = function() {
  const valor = parseFloat($("gemini-valor")?.value);
  if (isNaN(valor) || valor <= 0) {
    $("gemini-ganhos-prev").textContent = "—";
    $("gemini-odd-total").textContent = "";
    return;
  }
  const oddTotal = +geminiApostas.reduce((acc, a) => acc * a.odd, 1).toFixed(2);
  const ganhos   = +(valor * oddTotal).toFixed(2);
  const lucro    = +(ganhos - valor).toFixed(2);
  $("gemini-ganhos-prev").textContent = ganhos.toFixed(2) + " €";
  $("gemini-odd-total").textContent   = `(odd total: ${oddTotal} · lucro: +${lucro.toFixed(2)} €)`;
}

window.confirmarApostasGemini = async function() {
  if (!geminiApostas.length) return;
  const jog = allJogadores[currentUser?.uid];
  if (!jog) return;
  const inputValor = parseFloat($("gemini-valor")?.value);
  const valor = !isNaN(inputValor) && inputValor > 0 ? inputValor : (geminiApostas[0]?.valor || 0);
  if (!valor || valor <= 0) return showToast("Introduz o valor apostado.", "erro");
  if (valor > jog.saldo) return showToast("Saldo insuficiente.", "erro");
  const odd   = +geminiApostas.reduce((acc, a) => acc * a.odd, 1).toFixed(2);
  const jogo  = geminiApostas.length === 1
    ? geminiApostas[0].jogo
    : `Múltipla (${geminiApostas.length}) — ${geminiApostas[0].jogo}...`;
  const previsao = geminiApostas.map(a => `${a.jogo}: ${a.previsao}`).join(" | ");

  const id = `${currentUser.uid}_${Date.now()}`;
  await setDoc(doc(db, "apostas", id), {
    id, uid: currentUser.uid,
    jogo, previsao, odd, valor,
    apostas: geminiApostas,
    estado: "pendente",
    criadaEm: serverTimestamp(),
    fonte: "gemini"
  });
  await updateDoc(doc(db, "jogadores", currentUser.uid), {
    saldo: +(jog.saldo - valor).toFixed(2)
  });
  fecharModalImagem();
  showToast("Aposta registada!", "sucesso");
}

// ─── RESOLVER APOSTAS (TESTE) ─────────────────────────────────────────────
function renderTesteApostas() {
  const pendentes = Object.values(allApostas).filter(a => a.uid === currentUser?.uid && a.estado === "pendente");
  const lista = $("teste-apostas-lista");
  if (!lista) return;
  if (!pendentes.length) {
    lista.innerHTML = "<p style='font-size:13px;color:#534AB7;text-align:center;padding:.5rem'>Não tens apostas pendentes.</p>";
    return;
  }
  lista.innerHTML = pendentes.map(a => `
    <div style="background:#16162a;border:1px solid #2e2b54;border-radius:8px;padding:10px 12px;margin-bottom:8px">
      <div style="font-size:13px;font-weight:600;color:#e8e7f8;margin-bottom:4px">${a.jogo}</div>
      <div style="font-size:12px;color:#7F77DD;margin-bottom:8px">${a.previsao.slice(0,80)}${a.previsao.length>80?"…":""} · odd ${a.odd?.toFixed?a.odd.toFixed(2):a.odd}</div>
      <div style="display:flex;gap:6px">
        <button onclick="resolverAposta('${a.id}', true)"
          style="flex:1;background:#065f46;color:#fff;border:none;border-radius:6px;padding:7px;font-size:12px;font-weight:600;cursor:pointer">
          ✅ Ganha
        </button>
        <button onclick="resolverAposta('${a.id}', false)"
          style="flex:1;background:#7f1d1d;color:#fff;border:none;border-radius:6px;padding:7px;font-size:12px;font-weight:600;cursor:pointer">
          ❌ Perdida
        </button>
      </div>
    </div>`).join("");
}







// ─── SUBTABS LEADERBOARD ──────────────────────────────────────────────────
window.mostrarSubtab = function(sub) {
  ["ranking","historico"].forEach(s => {
    $("subtab-" + s).classList.toggle("active", s === sub);
    $("subview-" + s).style.display = s === sub ? "block" : "none";
  });
  if (sub === "historico") renderHistorico();
};

function renderHistorico() {
  const apostas = estado.apostas.filter(a => a.estado !== "pendente" && a.criadaEm);

  if (!apostas.length) {
    $("historico-lista").innerHTML = "<p class='empty'>Ainda não há apostas resolvidas.</p>";
    return;
  }

  // Agrupa por dia
  const porDia = {};
  apostas.forEach(a => {
    const data = new Date(a.criadaEm);
    const chave = data.toLocaleDateString("pt-PT", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
    if (!porDia[chave]) porDia[chave] = {};
    if (!porDia[chave][a.uid]) porDia[chave][a.uid] = { ganho: 0, apostas: 0 };
    porDia[chave][a.uid].ganho   += a.lucro || 0;
    porDia[chave][a.uid].apostas += 1;
  });

  // Ordena dias do mais recente
  const diasOrdenados = Object.keys(porDia).sort((a, b) => {
    const da = apostas.find(ap => new Date(ap.criadaEm).toLocaleDateString("pt-PT", { weekday:"short",day:"2-digit",month:"short",year:"numeric" }) === a);
    const db = apostas.find(ap => new Date(ap.criadaEm).toLocaleDateString("pt-PT", { weekday:"short",day:"2-digit",month:"short",year:"numeric" }) === b);
    return (db?.criadaEm || 0) - (da?.criadaEm || 0);
  });

  $("historico-lista").innerHTML = diasOrdenados.map(dia => {
    const jogsDia = Object.entries(porDia[dia]).sort((a, b) => b[1].ganho - a[1].ganho);
    const totalDia = jogsDia.reduce((acc, [, v]) => acc + v.ganho, 0);
    return `<div class="dia-bloco">
      <div class="dia-header">
        <span>${dia}</span>
        <span class="${totalDia >= 0 ? "pos" : "neg"}" style="font-size:13px">${fmt(totalDia)} total</span>
      </div>
      ${jogsDia.map(([uid, dados]) => {
        const jog = Object.values(allJogadores).find(j => j.uid === uid);
        return `<div class="dia-row">
          <div class="dia-avatar">${jog ? jog.avatar : "?"}</div>
          <div class="dia-nome">${jog ? jog.nome : "?"}</div>
          <div class="dia-apostas">${dados.apostas} aposta${dados.apostas > 1 ? "s" : ""}</div>
          <div class="dia-valor ${dados.ganho >= 0 ? "pos" : "neg"}">${fmt(dados.ganho)}</div>
        </div>`;
      }).join("")}
    </div>`;
  }).join("");
}

// ─── GRÁFICO ──────────────────────────────────────────────────────────────

function renderGrafico() {
  if (!window.Chart) return;

  const apostasResolvidas = Object.values(allApostas).filter(a => a.estado !== "pendente" && a.criadaEm && a.lucro !== undefined);
  const jogadores = Object.values(allJogadores);

  if (!apostasResolvidas.length || !jogadores.length) {
    const canvas = $("grafico-canvas");
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#534AB7";
      ctx.font = "14px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Ainda não há apostas resolvidas para mostrar.", canvas.width / 2, 80);
    }
    return;
  }

  // Recolhe todos os dias únicos ordenados
  const diasSet = new Set();
  apostasResolvidas.forEach(a => {
    const ts = a.criadaEm?.seconds ? new Date(a.criadaEm.seconds*1000) : new Date(a.criadaEm);
    diasSet.add(ts.toISOString().slice(0, 10));
  });
  const dias = Array.from(diasSet).sort();

  // Paleta de cores para cada jogador
  const cores = [
    { line: "#7F77DD", fill: "rgba(127,119,221,0.15)" },
    { line: "#1D9E75", fill: "rgba(29,158,117,0.15)" },
    { line: "#D85A30", fill: "rgba(216,90,48,0.15)"  },
    { line: "#c9a84c", fill: "rgba(201,168,76,0.15)" },
    { line: "#AFA9EC", fill: "rgba(175,169,236,0.15)"},
    { line: "#5DCAA5", fill: "rgba(93,202,165,0.15)" },
  ];

  // Para cada jogador, calcula o saldo acumulado por dia
  const datasets = jogadores.map((jog, i) => {
    const cor = cores[i % cores.length];
    let saldo = 10.00;
    const pontos = dias.map(dia => {
      const apostasNoDia = apostasResolvidas.filter(a => {
        const ts = a.criadaEm?.seconds ? new Date(a.criadaEm.seconds*1000) : new Date(a.criadaEm);
        const d = ts.toISOString().slice(0, 10);
        return a.uid === (jog.uid || jog.id) && d === dia;
      });
      apostasNoDia.forEach(a => { saldo = +(saldo + a.lucro).toFixed(2); });
      return saldo;
    });
    // Prepend ponto inicial (antes do primeiro dia)
    return {
      label: jog.nome,
      data: [10, ...pontos],
      borderColor: cor.line,
      backgroundColor: cor.fill,
      borderWidth: 2.5,
      pointBackgroundColor: cor.line,
      pointRadius: 5,
      pointHoverRadius: 7,
      tension: 0.35,
      fill: false,
    };
  });

  const labels = ["Início", ...dias.map(d => {
    const [y, m, dd] = d.split("-");
    return `${dd}/${m}`;
  })];

  // Legenda custom
  $("grafico-legenda").innerHTML = jogadores.map((jog, i) => {
    const cor = cores[i % cores.length];
    return `<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#AFA9EC">
      <div style="width:12px;height:12px;border-radius:50%;background:${cor.line};flex-shrink:0"></div>
      ${jog.nome}
    </div>`;
  }).join("");

  // Destrói chart anterior se existir
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

  const ctx = $("grafico-canvas").getContext("2d");
  chartInstance = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 2,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#16162a",
          borderColor: "#534AB7",
          borderWidth: 1,
          titleColor: "#AFA9EC",
          bodyColor: "#e8e7f8",
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)} €`
          }
        }
      },
      scales: {
        x: {
          grid: { color: "#2e2b54" },
          ticks: { color: "#7F77DD", font: { size: 12 } }
        },
        y: {
          grid: { color: "#2e2b54" },
          ticks: {
            color: "#7F77DD",
            font: { size: 12 },
            callback: v => v.toFixed(2) + " €"
          },
          suggestedMin: 0,
        }
      }
    }
  });
}

// ─── PAINEL ADMIN ─────────────────────────────────────────────────────────
function renderAdminPanel() {
  const pendentes = Object.values(allApostas).filter(a => a.estado === "pendente");
  const lista = $("admin-apostas-lista");
  if (!lista) return;

  if (!pendentes.length) {
    lista.innerHTML = "<p style='font-size:13px;color:#534AB7;text-align:center;padding:.75rem'>Não há apostas pendentes.</p>";
    return;
  }

  lista.innerHTML = pendentes.map(a => {
    const jog = allJogadores[a.uid];
    return `<div style="background:#0e0e1a;border:1px solid #2e2b54;border-radius:8px;padding:10px 12px;margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <div style="width:24px;height:24px;border-radius:50%;background:#26215C;border:1px solid #534AB7;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#AFA9EC;flex-shrink:0">${jog?.avatar || "?"}</div>
        <span style="font-size:12px;font-weight:600;color:#AFA9EC">${jog?.nome || "?"}</span>
      </div>
      <div style="font-size:13px;font-weight:600;color:#e8e7f8;margin-bottom:2px">${a.jogo}</div>
      <div style="font-size:12px;color:#7F77DD;margin-bottom:8px">${a.previsao.slice(0,80)}${a.previsao.length>80?"…":""} · odd ${a.odd?.toFixed?a.odd.toFixed(2):a.odd} · ${a.valor?.toFixed(2)} €</div>
      <div style="display:flex;gap:6px">
        <button onclick="resolverAposta('${a.id}',true)" style="flex:1;background:#065f46;color:#fff;border:none;border-radius:6px;padding:7px;font-size:12px;font-weight:600;cursor:pointer">✅ Ganha</button>
        <button onclick="resolverAposta('${a.id}',false)" style="flex:1;background:#7f1d1d;color:#fff;border:none;border-radius:6px;padding:7px;font-size:12px;font-weight:600;cursor:pointer">❌ Perdida</button>
      </div>
    </div>`;
  }).join("");
}

window.resolverAposta = async function(id, ganhou) {
  const aposta = allApostas[id];
  if (!aposta || !isAdmin()) return;
  const jog = allJogadores[aposta.uid];
  if (!jog) return;

  const lucro = ganhou
    ? +(aposta.valor * aposta.odd - aposta.valor).toFixed(2)
    : +(-aposta.valor).toFixed(2);

  await updateDoc(doc(db, "apostas", id), {
    estado: ganhou ? "ganha" : "perdida",
    lucro,
    resolvidaEm: serverTimestamp()
  });
  if (ganhou) {
    await updateDoc(doc(db, "jogadores", aposta.uid), {
      saldo: +(jog.saldo + aposta.valor * aposta.odd).toFixed(2)
    });
  }
  showToast(ganhou ? `✅ Aposta de ${jog.nome} marcada como ganha!` : `❌ Aposta de ${jog.nome} marcada como perdida.`, ganhou ? "sucesso" : "erro");
};

window.resetarTudo = async function() {
  if (!isAdmin()) return;
  if (!confirm("Tens a certeza? Isto apaga TODAS as apostas e repõe todos os saldos a €10.")) return;
  for (const id of Object.keys(allApostas)) await deleteDoc(doc(db, "apostas", id));
  for (const id of Object.keys(allJogadores)) await updateDoc(doc(db, "jogadores", id), { saldo: 10.00 });
  showToast("Reset feito — saldos a €10 e apostas limpas.", "sucesso");
};

window.eliminarPerfis = async function() {
  if (!isAdmin()) return;
  if (!confirm("Tens a certeza? Isto elimina TODOS os jogadores e apostas permanentemente.")) return;
  for (const id of Object.keys(allApostas))   await deleteDoc(doc(db, "apostas", id));
  for (const id of Object.keys(allJogadores)) await deleteDoc(doc(db, "jogadores", id));
  await signOut(auth);
  showToast("Todos os perfis eliminados.", "sucesso");
};

// ─── INIT ─────────────────────────────────────────────────────────────────
// Auth state handles initialization