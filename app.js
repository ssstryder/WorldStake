import { initializeApp } from "firebase/app";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut, updateProfile } from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc, updateDoc, collection, onSnapshot, deleteDoc, serverTimestamp, getDocs, query, orderBy, limit } from "firebase/firestore";

// ─── CONFIGURAÇÃO FIREBASE ────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_AUTH_DOMAIN",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_STORAGE_BUCKET",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId:             "YOUR_APP_ID"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// ─── CONSTANTES ───────────────────────────────────────────────────────────
const SALDO_INICIAL = 10.00;
const ADMIN_UID     = "SEU_UID_DE_ADMIN";
const PROXY_URL = "https://YOUR_PROXY.onrender.com";
const GEMINI_API_KEY     = "YOUR_GEMINI_API_KEY";
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

  const pendentes = Object.values(allApostas).filter(a => a.estado === "pendente");
  if (!pendentes.length) return;

  for (const aposta of pendentes) {
    if (!aposta.apostas || !Array.isArray(aposta.apostas)) continue;

    // Atualiza estado de cada seleção individualmente
    let todasResolvidas = true;
    let algumaPerdida   = false;
    const apostasAtualizadas = aposta.apostas.map(sel => {
      if (!sel.jogoId) { todasResolvidas = false; return sel; }
      const jogo = terminados.find(j => j.id === sel.jogoId);
      if (!jogo) { todasResolvidas = false; return sel; }

      // Determina se a seleção ganhou (simplificado: vitória casa/fora/empate)
      const resultado = jogo.golsCasa > jogo.golsFora ? "casa"
                      : jogo.golsFora > jogo.golsCasa ? "fora"
                      : "empate";
      const previsaoNorm = (sel.previsao || "").toLowerCase();
      let ganhouSel = false;
      if (previsaoNorm.includes("empate")) ganhouSel = resultado === "empate";
      else if (previsaoNorm.includes("não") || previsaoNorm.includes("nao")) {
        // "Não ambas marcam" etc — admin resolve manualmente
        todasResolvidas = false;
        return sel;
      } else {
        const casa = (sel.casaReal || sel.jogo.split(" vs ")[0] || "").toLowerCase();
        ganhouSel = resultado === "casa"
          ? previsaoNorm.includes(casa)
          : resultado === "fora";
      }

      if (!ganhouSel) algumaPerdida = true;
      return { ...sel, estadoSel: ganhouSel ? "ganha" : "perdida", golsCasa: jogo.golsCasa, golsFora: jogo.golsFora };
    });

    const updates = { apostas: apostasAtualizadas };

    // Se todas as seleções estão resolvidas, fecha a aposta múltipla
    if (todasResolvidas) {
      const ganhouTudo = !algumaPerdida;
      const lucro = ganhouTudo
        ? +(aposta.valor * aposta.odd - aposta.valor).toFixed(2)
        : +(-aposta.valor).toFixed(2);
      updates.estado      = ganhouTudo ? "ganha" : "perdida";
      updates.lucro       = lucro;
      updates.resolvidaEm = serverTimestamp();
      if (ganhouTudo) {
        const jog = allJogadores[aposta.uid];
        if (jog) await updateDoc(doc(db, "jogadores", aposta.uid), {
          saldo: +(jog.saldo + aposta.valor * aposta.odd).toFixed(2)
        });
      }
    }

    await updateDoc(doc(db, "apostas", aposta.id), updates);
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
    // Pequeno delay para garantir que allApostas também está atualizado
    setTimeout(() => renderizarTudo(), 100);
  });

  unsubAp = onSnapshot(collection(db, "apostas"), snap => {
    const anterior = { ...allApostas };
    allApostas = {};
    snap.forEach(d => { allApostas[d.id] = d.data(); });

    // Deteta mudanças para notificações e feed
    snap.docChanges().forEach(change => {
      const aposta = change.doc.data();
      const ant    = anterior[change.doc.id];
      if (change.type === "modified" && ant) {
        // Aposta resolvida agora
        if (ant.estado === "pendente" && aposta.estado !== "pendente") {
          const jog = allJogadores[aposta.uid];
          const ganhou = aposta.estado === "ganha";
          mostrarNotificacao(
            ganhou ? "🎉 Aposta ganha!" : "❌ Aposta perdida",
            `${jog?.nome || "?"} — ${aposta.jogo}${ganhou ? " +" + aposta.lucro?.toFixed(2) + " €" : ""}`,
            ganhou ? "ganha" : "perdida"
          );
          adicionarFeed(aposta, "resolvida");
          // Flash row na leaderboard
          setTimeout(() => {
            const rows = document.querySelectorAll(".lb-row");
            rows.forEach(row => {
              const nomeEl = row.querySelector(".lb-nome");
              if (nomeEl && nomeEl.textContent.includes(jog?.nome || "")) {
                row.classList.add(ganhou ? "flash-g" : "flash-r");
                setTimeout(() => row.classList.remove("flash-g","flash-r"), 1000);
              }
            });
          }, 300);
        }
        // Nova aposta criada
      } else if (change.type === "added" && !ant && aposta.criadaEm) {
        adicionarFeed(aposta, "nova");
      }
    });

    renderizarTudo();
    if (tabAtual === "grafico") renderGrafico();
    if (tabAtual === "leaderboard") renderFeed();
  });
}

// ─── TABS ─────────────────────────────────────────────────────────────────
window.mostrarTab = function(tab) {
  tabAtual = tab;
  ["leaderboard","meu-perfil","todos","anteriores","grafico"].forEach(t => {
    const tabEl = $(`tab-${t}`);
    const secEl = $(`section-${t}`);
    if (tabEl) tabEl.classList.toggle("active", t === tab);
    if (secEl) secEl.style.display = t === tab ? "block" : "none";
  });
  renderizarTudo();
  if (tab === "grafico")    renderGrafico();
  if (tab === "anteriores") renderAnteriores();
};

// ─── RENDER PRINCIPAL ─────────────────────────────────────────────────────
function renderizarTudo() {
  if (!currentUser) return;
  atualizarNavbar();
  if (tabAtual === "leaderboard")  renderLeaderboard();
  else if (tabAtual === "meu-perfil")  renderMeuPerfil();
  else if (tabAtual === "todos")       renderTodos();
  else if (tabAtual === "anteriores")  renderAnteriores();
}

function atualizarNavbar() {
  const jog = allJogadores[currentUser?.uid];
  if (jog) {
    $("nav-avatar").textContent = jog.avatar;
    $("nav-nome").textContent   = jog.nome;
    $("nav-saldo").textContent  = fmtAbs(jog.saldo);
  }
}

// ─── NOTIFICAÇÕES NO SITE ─────────────────────────────────────────────────
const notificacoes = [];

function mostrarNotificacao(titulo, corpo, tipo = "info") {
  // Guarda na lista
  notificacoes.unshift({ titulo, corpo, tipo, ts: Date.now(), lida: false });
  if (notificacoes.length > 30) notificacoes.pop();
  atualizarBadge();
  renderNotifPanel();

  // Toast popup temporário
  const n = document.createElement("div");
  const cor = tipo === "ganha" ? "#1D9E75" : tipo === "perdida" ? "#7f1d1d" : "#16261f";
  const borda = tipo === "ganha" ? "var(--grn)" : tipo === "perdida" ? "var(--red)" : "rgba(255,255,255,0.2)";
  n.style.cssText = `position:fixed;top:56px;right:16px;z-index:998;background:var(--bg2);border:1px solid ${borda};border-radius:var(--rad);padding:12px 16px;max-width:280px;box-shadow:0 8px 24px rgba(0,0,0,.5);animation:slideInRight .3s ease;cursor:pointer;`;
  n.innerHTML = `<div style="font-size:13px;font-weight:700;color:#fff;margin-bottom:3px">${titulo}</div><div style="font-size:12px;color:rgba(255,255,255,0.6)">${corpo}</div>`;
  n.onclick = () => n.remove();
  document.body.appendChild(n);
  setTimeout(() => { n.style.opacity="0"; n.style.transition="opacity .5s"; setTimeout(()=>n.remove(), 500); }, 5000);
}

function atualizarBadge() {
  const badge = $("notif-badge");
  if (!badge) return;
  const naoLidas = notificacoes.filter(n => !n.lida).length;
  if (naoLidas > 0) {
    badge.style.display = "flex";
    badge.textContent = naoLidas > 9 ? "9+" : naoLidas;
  } else {
    badge.style.display = "none";
  }
}

function renderNotifPanel() {
  const lista = $("notif-lista");
  if (!lista) return;
  if (!notificacoes.length) {
    lista.innerHTML = "<p style='font-size:13px;color:rgba(255,255,255,0.3);text-align:center;padding:1.5rem'>Sem notificações.</p>";
    return;
  }
  lista.innerHTML = notificacoes.map(n => {
    const ic  = n.tipo === "ganha" ? "✅" : n.tipo === "perdida" ? "❌" : "🔔";
    const ago = tempoPassado(n.ts);
    return `<div style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.05);${n.lida?"opacity:.5":""}">
      <div style="font-size:13px;font-weight:600;color:#fff">${ic} ${n.titulo}</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:2px">${n.corpo}</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.25);margin-top:3px">${ago}</div>
    </div>`;
  }).join("");
}

window.toggleNotifPanel = function() {
  const panel = $("notif-panel");
  if (!panel) return;
  const aberto = panel.style.display !== "none";
  panel.style.display = aberto ? "none" : "block";
  if (!aberto) {
    // Marca todas como lidas
    notificacoes.forEach(n => n.lida = true);
    atualizarBadge();
    renderNotifPanel();
  }
};

window.limparNotificacoes = function() {
  notificacoes.length = 0;
  atualizarBadge();
  renderNotifPanel();
};

// Fecha painel ao clicar fora
document.addEventListener("click", e => {
  const panel = $("notif-panel");
  const btn   = $("btn-notif");
  if (panel && btn && !panel.contains(e.target) && !btn.contains(e.target)) {
    panel.style.display = "none";
  }
});

// ─── FEED DE ATIVIDADE ────────────────────────────────────────────────────
function adicionarFeed(aposta, tipo) {
  // Já não precisa de fazer nada — renderFeed lê diretamente das apostas
  if (tabAtual === "leaderboard") renderFeed();
}

function renderFeed() {
  const el = $("feed-atividade");
  if (!el) return;

  // Usa as apostas reais ordenadas por data (novas + recém resolvidas)
  const todas = Object.values(allApostas)
    .filter(a => a.criadaEm)
    .sort((a, b) => {
      const tsA = a.resolvidaEm?.seconds || a.criadaEm?.seconds || 0;
      const tsB = b.resolvidaEm?.seconds || b.criadaEm?.seconds || 0;
      return tsB - tsA;
    })
    .slice(0, 15);

  if (!todas.length) {
    el.innerHTML = "<p class='empty' style='padding:1rem'>Sem atividade recente.</p>";
    return;
  }

  el.innerHTML = todas.map(a => {
    const jog  = allJogadores[a.uid];
    if (!jog) return "";

    // Usa resolvidaEm se resolvida, senão criadaEm
    const tsRaw = a.estado !== "pendente" && a.resolvidaEm?.seconds
      ? a.resolvidaEm.seconds * 1000
      : a.criadaEm?.seconds
      ? a.criadaEm.seconds * 1000
      : Date.now();

    const ago = tempoPassado(tsRaw);

    let ic, desc;
    if (a.estado === "pendente") {
      ic   = "📋";
      desc = `apostou <span class="fd">${a.valor?.toFixed(2)} €</span> em ${a.jogo}`;
    } else if (a.estado === "ganha") {
      ic   = "✅";
      desc = `ganhou <span class="fg">+${a.lucro?.toFixed(2)} €</span> em ${a.jogo}`;
    } else {
      ic   = "❌";
      desc = `perdeu <span class="fr">${a.valor?.toFixed(2)} €</span> em ${a.jogo}`;
    }

    return `<div class="feed-row">
      <div class="feed-av">${jog.avatar}</div>
      <div class="feed-txt">${ic} <b>${jog.nome}</b> ${desc}</div>
      <div class="feed-time">${ago}</div>
    </div>`;
  }).filter(Boolean).join("");
}

function tempoPassado(ts) {
  const data = new Date(ts);
  const hora = data.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60)   return `agora · ${hora}`;
  if (diff < 3600) return `há ${Math.floor(diff/60)} min · ${hora}`;
  if (diff < 86400) return `há ${Math.floor(diff/3600)} h · ${hora}`;
  const dia = data.toLocaleDateString("pt-PT", { day: "2-digit", month: "short" });
  return `${dia} · ${hora}`;
}



function renderAnteriores() {
  const lista = $("anteriores-lista");
  if (!lista) return;

  const apostas = Object.values(allApostas).filter(a => a.estado !== "pendente");
  if (!apostas.length) {
    lista.innerHTML = "<p class='empty'>Ainda não há apostas resolvidas.</p>";
    return;
  }

  const porJogador = {};
  apostas.forEach(a => {
    if (!porJogador[a.uid]) porJogador[a.uid] = [];
    porJogador[a.uid].push(a);
  });

  const jogadoresOrdenados = Object.values(allJogadores).sort((a,b) => b.saldo - a.saldo);

  lista.innerHTML = jogadoresOrdenados.map(jog => {
    const bets = (porJogador[jog.uid] || []).sort((a,b) => (b.criadaEm?.seconds||0) - (a.criadaEm?.seconds||0));
    if (!bets.length) return "";

    const ganhas  = bets.filter(b => b.estado === "ganha").length;
    const perdidas = bets.filter(b => b.estado === "perdida").length;
    const lucroTotal = bets.reduce((acc, b) => acc + (b.lucro || 0), 0);

    // Separar ganhas e perdidas
    const betsGanhas  = bets.filter(b => b.estado === "ganha");
    const betsPerdidas = bets.filter(b => b.estado === "perdida");

    const renderBet = (a) => {
      const temDetalhe = a.apostas && a.apostas.length > 0;
      const idDetalhe  = "ant_" + a.id;
      const lucro = a.lucro || 0;
      return `<div class="aposta-row" style="flex-direction:column;align-items:stretch;gap:0">
        <div style="display:flex;align-items:center;gap:10px">
          <div class="aposta-jogo" style="flex:1">
            <span class="aposta-times">${a.jogo}</span>
            <span class="aposta-prev">${a.previsao.length>60?a.previsao.slice(0,60)+"…":a.previsao} · odd ${a.odd?.toFixed?a.odd.toFixed(2):a.odd}</span>
          </div>
          <div class="aposta-dir">
            <span class="aposta-val">${fmtAbs(a.valor)}</span>
            <span class="chip chip-${a.estado}">${labelEstado(a.estado, a.lucro)}</span>
          </div>
          ${temDetalhe ? `<button onclick="window.toggleDetalhe('${idDetalhe}')" id="btn_${idDetalhe}" style="background:none;border:none;cursor:pointer;color:var(--t3);font-size:16px;padding:4px;transition:transform .2s;flex-shrink:0">▼</button>` : ""}
        </div>
        ${temDetalhe ? `<div id="${idDetalhe}" style="display:none;margin:0 16px 8px;padding:10px 12px;background:var(--bg3);border-radius:var(--rad-xs);border:1px solid var(--line)">
          ${a.apostas.map(s => {
            const st  = s.estadoSel || (a.estado === "ganha" ? "ganha" : "perdida");
            const cor = st === "ganha" ? "var(--grn)" : "var(--red)";
            const ic  = st === "ganha" ? "✅" : "❌";
            return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line2)">
              <div>
                <div style="font-size:12px;font-weight:500;color:${cor}">${ic} ${s.jogo}</div>
                <div style="font-size:11px;color:var(--t4);margin-top:1px">${s.previsao}</div>
              </div>
              <div style="font-size:11px;color:var(--t4);flex-shrink:0;margin-left:12px">×${s.odd}</div>
            </div>`;
          }).join("")}
          <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:12px">
            <span style="color:var(--t4)">Apostado</span><strong>${fmtAbs(a.valor)}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:12px">
            <span style="color:var(--t4)">Resultado</span>
            <strong style="color:${lucro>=0?"var(--grn)":"var(--red)"}">${lucro>=0?"+":""}${lucro.toFixed(2)} €</strong>
          </div>
        </div>` : ""}
      </div>`;
    };

    return `<div style="margin-bottom:0">
      <!-- Header do jogador -->
      <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--bg2)">
        <div class="av-mini" style="width:28px;height:28px;font-size:11px;flex-shrink:0">${jog.avatar}</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:500;color:var(--t1)">${jog.nome}</div>
          <div style="font-size:11px;color:var(--t4);margin-top:1px">${ganhas} ganhas · ${perdidas} perdidas · <span style="color:${lucroTotal>=0?"var(--grn)":"var(--red)"};font-weight:500">${lucroTotal>=0?"+":""}${lucroTotal.toFixed(2)} €</span></div>
        </div>
      </div>

      ${betsGanhas.length ? `
      <!-- Ganhas -->
      <div style="padding:6px 16px 4px;border-bottom:1px solid var(--line2);background:rgba(48,209,88,.04)">
        <span style="font-size:9px;font-weight:600;color:var(--grn);text-transform:uppercase;letter-spacing:.06em">✅ Ganhas (${betsGanhas.length})</span>
      </div>
      ${betsGanhas.map(renderBet).join("")}` : ""}

      ${betsPerdidas.length ? `
      <!-- Perdidas -->
      <div style="padding:6px 16px 4px;border-bottom:1px solid var(--line2);background:rgba(255,69,58,.04)">
        <span style="font-size:9px;font-weight:600;color:var(--red);text-transform:uppercase;letter-spacing:.06em">❌ Perdidas (${betsPerdidas.length})</span>
      </div>
      ${betsPerdidas.map(renderBet).join("")}` : ""}
    </div>`;
  }).filter(Boolean).join("");
}

// ─── INIT ─────────────────────────────────────────────────────────────────
// Auth state handles initialization
// ─── SUBTABS LEADERBOARD ──────────────────────────────────────────────────
window.mostrarSubtab = function(sub) {
  ["ranking","historico"].forEach(s => {
    const btn  = $(`subtab-${s}`);
    const view = $(`subview-${s}`);
    if (btn)  btn.classList.toggle("active", s === sub);
    if (view) view.style.display = s === sub ? "block" : "none";
  });
  if (sub === "historico") renderHistorico();
};

function renderLeaderboard() {
  const sorted = Object.values(allJogadores).sort((a, b) => b.saldo - a.saldo);
  const apostas = Object.values(allApostas);

  $("stat-apostas").textContent   = apostas.length;
  $("stat-pendentes").textContent = apostas.filter(a => a.estado === "pendente").length;
  $("stat-jogadores").textContent = sorted.length;
  const melhor = apostas.filter(a => a.lucro !== undefined).sort((a,b) => b.lucro - a.lucro)[0];
  const melhorEl = $("stat-melhor");
  if (melhorEl) { melhorEl.textContent = melhor ? fmt(melhor.lucro) : "—"; melhorEl.className = "stat-val" + (melhor && melhor.lucro > 0 ? " pos" : ""); }

  if (!sorted.length) {
    $("leaderboard-lista").innerHTML = "<p class='empty'>Ainda não há jogadores registados.</p>";
    return;
  }
  const maxSaldo = sorted.length ? sorted[0].saldo : 10;
  const prevPos  = window._prevPositions || {};
  const newPos   = {};
  sorted.forEach((j, i) => { newPos[j.uid] = i; });

  renderFeed();
  $("leaderboard-lista").innerHTML = sorted.map((j, i) => {
    const diff     = +(j.saldo - SALDO_INICIAL).toFixed(2);
    const medal    = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i+1}`;
    const isMe     = currentUser && j.uid === currentUser.uid;
    const minhas   = apostas.filter(a => a.uid === j.uid);
    const ganhas   = minhas.filter(a => a.estado === "ganha").length;
    const total    = minhas.filter(a => a.estado !== "pendente").length;
    const taxa     = total ? Math.round(ganhas/total*100) : 0;
    const pct      = maxSaldo > 0 ? Math.round((j.saldo / maxSaldo) * 100) : 0;
    const temLive  = minhas.some(a =>
      a.estado === "pendente" && a.apostas?.some(s =>
        s.status === "IN_PLAY" || s.status === "PAUSED"
      )
    );
    const oldPos   = prevPos[j.uid];
    const posChange = oldPos !== undefined ? oldPos - i : 0;
    const arrowHTML = posChange > 0 ? `<span class="arrow-up">↑${posChange}</span>`
                    : posChange < 0 ? `<span class="arrow-dn">↓${Math.abs(posChange)}</span>` : "";
    const liveHTML  = temLive ? `<span class="live-chip"><span class="live-dot"></span>LIVE</span>` : "";
    return `<div class="lb-row ${isMe ? "lb-me" : ""}">
      <div class="lb-bar" style="width:${pct}%"></div>
      <div class="lb-rank">${medal}</div>
      <div class="lb-avatar">${j.avatar}</div>
      <div class="lb-info">
        <div class="lb-nome ${i===0?"gold":i>3?"dim":""}">${j.nome}${isMe ? ' <span class="tag-eu">tu</span>' : ""} ${arrowHTML} ${liveHTML}</div>
        <div class="lb-meta">${ganhas}/${total} apostas · ${taxa}% acerto</div>
      </div>
      <div class="lb-saldo">
        <div class="lb-val ${i>4?"dim":""}">${fmtAbs(j.saldo)}</div>
        <div class="lb-diff ${diff >= 0 ? "pos" : "neg"}">${fmt(diff)}</div>
      </div>
    </div>`;
  }).join("");

  window._prevPositions = newPos;
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
  $("perfil-diff").className     = "perfil-diff " + (diff >= 0 ? "pos" : "neg");

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
        <button onclick="removerAposta('${a.id}')" style="background:none;border:none;cursor:pointer;font-size:16px;color:var(--acc);padding:2px 4px;border-radius:4px;transition:color .2s" title="Remover aposta" onmouseover="this.style.color='#f87171'" onmouseout="this.style.color='var(--acc)'">🗑</button>
      </div>
    </div>`).join("") : "<p class='empty'>Ainda não fizeste nenhuma aposta.</p>";

  // Histórico de saldo
  renderHistoricoSaldo(minhas);
}

function renderHistoricoSaldo(apostas) {
  const el = $("perfil-historico-saldo");
  if (!el || !window.Chart) return;

  const resolvidas = apostas
    .filter(a => a.estado !== "pendente" && a.criadaEm && a.lucro !== undefined)
    .sort((a,b) => (a.criadaEm?.seconds||0) - (b.criadaEm?.seconds||0));

  if (!resolvidas.length) {
    el.innerHTML = "<p style='font-size:13px;color:rgba(255,255,255,0.25);text-align:center;padding:1rem'>Sem apostas resolvidas ainda.</p>";
    return;
  }

  // Calcula saldo acumulado
  let saldo = 10;
  const labels = ["Início"];
  const dados  = [10];
  resolvidas.forEach(a => {
    saldo = +(saldo + (a.estado === "ganha" ? a.valor * a.odd : 0)).toFixed(2);
    const ts = a.criadaEm?.seconds ? new Date(a.criadaEm.seconds*1000) : new Date();
    labels.push(ts.toLocaleDateString("pt-PT", {day:"2-digit",month:"short"}));
    dados.push(saldo);
  });

  el.innerHTML = '<canvas id="canvas-saldo" style="max-height:200px"></canvas>';

  if (window._saldoChart) { window._saldoChart.destroy(); }
  const ctx = $("canvas-saldo").getContext("2d");
  window._saldoChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        data: dados,
        borderColor: "#D4A017",
        backgroundColor: "rgba(212,160,23,0.08)",
        borderWidth: 2,
        pointBackgroundColor: "#D4A017",
        pointRadius: 4,
        tension: 0.3,
        fill: true
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false }, tooltip: {
        backgroundColor: "#16261f", borderColor: "#1D9E75", borderWidth: 1,
        titleColor: "rgba(255,255,255,0.5)", bodyColor: "#fff",
        callbacks: { label: c => ` ${c.parsed.y.toFixed(2)} €` }
      }},
      scales: {
        x: { grid: { color: "rgba(255,255,255,0.07)" }, ticks: { color: "rgba(255,255,255,0.45)", font: { size: 12 } } },
        y: { grid: { color: "rgba(255,255,255,0.07)" }, ticks: { color: "rgba(255,255,255,0.45)", font: { size: 12 }, callback: v => v.toFixed(2)+" €" }, suggestedMin: 0 }
      }
    }
  });
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
  const apostas = Object.values(allApostas).filter(a => a.estado === "pendente");
  if (!apostas.length) {
    $("todos-lista").innerHTML = "<p class='empty'>Não há apostas ativas de momento.</p>"; return;
  }

  // Agrupa por jogador
  const porJogador = {};
  apostas.forEach(a => {
    if (!porJogador[a.uid]) porJogador[a.uid] = [];
    porJogador[a.uid].push(a);
  });

  const jogadoresOrdenados = Object.values(allJogadores).sort((a,b) => b.saldo - a.saldo);

  $("todos-lista").innerHTML = jogadoresOrdenados.map(jog => {
    const bets = (porJogador[jog.uid] || []).sort((a,b) => (b.criadaEm?.seconds||0) - (a.criadaEm?.seconds||0));
    if (!bets.length) return "";
    const ganhas = bets.filter(b => b.estado === "ganha").length;
    const total  = bets.filter(b => b.estado !== "pendente").length;
    const taxa   = total ? Math.round(ganhas/total*100) : 0;
    const diff   = +(jog.saldo - 10).toFixed(2);

    return `<div style="margin-bottom:1.5rem">
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:2px solid rgba(255,255,255,.06);margin-bottom:4px">
        <div class="av-mini" style="width:32px;height:32px;font-size:12px;flex-shrink:0">${jog.avatar}</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:500;color:var(--t1)">${jog.nome}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.3);margin-top:1px">${bets.length} apostas · ${taxa}% acerto</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:15px;font-weight:700;color:#fff">${fmtAbs(jog.saldo)}</div>
          <div style="font-size:11px;font-weight:600;${diff>=0?"color:var(--grn)":"color:var(--red)"}">${fmt(diff)}</div>
        </div>
      </div>
      ${bets.map(a => {
        const temDetalhe = a.apostas && a.apostas.length > 0;
        const idDetalhe  = "det_" + a.id;
        return `<div class="aposta-row" style="flex-direction:column;align-items:stretch;gap:0;overflow:visible">
          <div style="display:flex;align-items:center;gap:10px">
            <div class="aposta-jogo" style="flex:1">
              <span class="aposta-times">${a.jogo}</span>
              <span class="aposta-prev">${a.previsao.length>60?a.previsao.slice(0,60)+"…":a.previsao} · odd ${a.odd?.toFixed?a.odd.toFixed(2):a.odd}</span>
            </div>
            <div class="aposta-dir">
              <span class="aposta-val">${fmtAbs(a.valor)}</span>
              <span class="chip chip-${a.estado}">${labelEstado(a.estado, a.lucro)}</span>
            </div>
            ${temDetalhe ? `<button onclick="window.toggleDetalhe('${idDetalhe}')" id="btn_${idDetalhe}" style="background:none;border:none;cursor:pointer;color:var(--t3);font-size:16px;padding:4px;transition:transform .2s;flex-shrink:0">▼</button>` : ""}
          </div>
          ${temDetalhe ? `
          <div id="${idDetalhe}" style="display:none;margin:0 16px 8px;padding:10px 12px;background:var(--bg3);border-radius:var(--rad-xs);border:1px solid var(--line)">
            <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.3);letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px">Boletim · ${a.apostas.length} seleção${a.apostas.length>1?"ões":""}</div>
            ${a.apostas.map(s => {
              const st=s.estadoSel||"pendente";
              const cor=st==="ganha"?"var(--grn)":st==="perdida"?"var(--red)":"var(--t2)";
              const ic=st==="ganha"?"✅":st==="perdida"?"❌":"⏳";
              const resultado = (s.golsCasa !== null && s.golsCasa !== undefined)
                ? `${s.golsCasa} - ${s.golsFora}` : null;
              return `<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
                <div style="flex:1">
                  <div style="font-size:12px;font-weight:500;color:${cor}">${ic} ${s.jogo}</div>
                  <div style="font-size:11px;color:var(--t4);margin-top:1px">${s.previsao}</div>
                  ${resultado ? `<div style="font-size:11px;color:rgba(255,255,255,0.25);margin-top:2px">Resultado: ${resultado}</div>` : ""}
                </div>
                <div style="font-size:11px;color:var(--t4);flex-shrink:0;margin-left:12px">× ${s.odd}</div>
              </div>`;
            }).join("")}
            <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:13px">
              <span style="color:rgba(255,255,255,0.3)">Odd total</span><strong style="color:#fff">${a.odd?.toFixed?a.odd.toFixed(2):a.odd}</strong>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:13px">
              <span style="color:rgba(255,255,255,0.3)">Apostado</span><strong style="color:#fff">${fmtAbs(a.valor)}</strong>
            </div>
            ${a.valor&&a.odd?`<div style="display:flex;justify-content:space-between;margin-top:4px;font-size:13px">
              <span style="color:rgba(255,255,255,0.3)">Ganhos potenciais</span><strong style="color:var(--grn)">${(a.valor*a.odd).toFixed(2)} €</strong>
            </div>`:""}
          </div>` : ""}
        </div>`;
      }).join("")}
    </div>`;
  }).filter(Boolean).join("");
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
      <div style="width:100%;background:rgba(48,209,88,.1);border-radius:var(--rad-xs);padding:10px 14px;font-size:14px;color:var(--grn)">
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
  await registarLog(`Nova aposta: ${currentUser.uid} — ${jogoNome} · ${valor?.toFixed(2)} €`);
  fecharModalImagem();
  showToast("Aposta registada!", "sucesso");
}

// ─── RESOLVER APOSTAS (TESTE) ─────────────────────────────────────────────
function renderTesteApostas() {
  const pendentes = Object.values(allApostas).filter(a => a.uid === currentUser?.uid && a.estado === "pendente");
  const lista = $("teste-apostas-lista");
  if (!lista) return;
  if (!pendentes.length) {
    lista.innerHTML = "<p style='font-size:13px;color:var(--acc);text-align:center;padding:.5rem'>Não tens apostas pendentes.</p>";
    return;
  }
  lista.innerHTML = pendentes.map(a => `
    <div style="background:#16162a;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:8px">
      <div style="font-size:13px;font-weight:600;color:#e8e7f8;margin-bottom:4px">${a.jogo}</div>
      <div style="font-size:12px;color:var(--acc);margin-bottom:8px">${a.previsao.slice(0,80)}${a.previsao.length>80?"…":""} · odd ${a.odd?.toFixed?a.odd.toFixed(2):a.odd}</div>
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
      ctx.fillStyle = "var(--acc)";
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
    { line: "#30d158", fill: "rgba(48,209,88,0.12)"   },  // verde
    { line: "#6b9bd2", fill: "rgba(107,155,210,0.12)" },  // azul
    { line: "#ff9f0a", fill: "rgba(255,159,10,0.12)"  },  // laranja
    { line: "#bf5af2", fill: "rgba(191,90,242,0.12)"  },  // roxo
    { line: "#ff453a", fill: "rgba(255,69,58,0.12)"   },  // vermelho
    { line: "#ffd60a", fill: "rgba(255,214,10,0.12)"  },  // amarelo
    { line: "#5ac8fa", fill: "rgba(90,200,250,0.12)"  },  // azul claro
    { line: "#ff6b6b", fill: "rgba(255,107,107,0.12)" },  // coral
    { line: "#4ecdc4", fill: "rgba(78,205,196,0.12)"  },  // teal
    { line: "#a8e6cf", fill: "rgba(168,230,207,0.12)" },  // verde claro
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
    // Adiciona o saldo real atual como último ponto se for diferente
    const ultimoPonto = pontos.length ? pontos[pontos.length - 1] : 10;
    const saldoReal   = jog.saldo;
    const dadosFinais = saldoReal !== ultimoPonto ? [...pontos, saldoReal] : pontos;
    const labelsExtra = saldoReal !== ultimoPonto ? [...dias, "Agora"] : dias;
    window._grafLabels = ["Início", ...labelsExtra.map(d => {
      if (d === "Agora") return "Agora";
      const [y, m, dd] = d.split("-"); return `${dd}/${m}`;
    })];

    return {
      label: jog.nome,
      data: [10, ...dadosFinais],
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

  const labels = window._grafLabels || ["Início", ...dias.map(d => {
    const [y, m, dd] = d.split("-");
    return `${dd}/${m}`;
  })];

  // Legenda custom
  $("grafico-legenda").innerHTML = jogadores.map((jog, i) => {
    const cor = cores[i % cores.length];
    return `<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--t2)">
      <div style="width:12px;height:12px;border-radius:50%;background:${cor.line};flex-shrink:0"></div>
      ${jog.nome}
    </div>`;
  }).join("");

  // Destrói chart anterior se existir
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

  // Plugin para fundo do chart
  const bgPlugin = {
    id: "customBg",
    beforeDraw(chart) {
      const ctx = chart.ctx;
      ctx.save();
      ctx.fillStyle = "#1c1c1e";
      ctx.fillRect(0, 0, chart.width, chart.height);
      ctx.restore();
    }
  };

  const ctx = $("grafico-canvas").getContext("2d");
  chartInstance = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    plugins: [bgPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 2,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#2c2c2e",
          borderColor: "rgba(255,255,255,0.15)",
          borderWidth: 1,
          titleColor: "rgba(255,255,255,0.5)",
          bodyColor: "#ffffff",
          padding: 10,
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)} €`
          }
        }
      },
      scales: {
        x: {
          grid: { color: "rgba(255,255,255,0.08)" },
          ticks: { color: "rgba(255,255,255,0.5)", font: { size: 12 } },
          border: { color: "rgba(255,255,255,0.1)" }
        },
        y: {
          grid: { color: "rgba(255,255,255,0.08)" },
          ticks: {
            color: "rgba(255,255,255,0.5)",
            font: { size: 12 },
            callback: v => v.toFixed(2) + " €"
          },
          border: { color: "rgba(255,255,255,0.1)" },
          suggestedMin: 0,
        }
      }
    }
  });
}


// ─── PAINEL ADMIN ─────────────────────────────────────────────────────────
window.adminTab = function(tab) {
  ["apostas","corrigir","bloquear","saldos","historico-admin","log"].forEach(t => {
    const btn  = $(`admin-tab-${t}`);
    const view = $(`admin-view-${t}`);
    if (btn)  btn.classList.toggle("active", t === tab);
    if (view) view.style.display = t === tab ? "block" : "none";
  });
  if (tab === "corrigir")  renderAdminCorrigir();
  if (tab === "bloquear")       renderAdminBloquear();
  if (tab === "saldos")    renderAdminSaldos();
  if (tab === "historico-admin") renderAdminHistorico();
  if (tab === "log")       renderAdminLog();
};

// ── Corrigir apostas resolvidas ────────────────────────────────────────────
function renderAdminCorrigir() {
  const lista = $("admin-view-corrigir");
  if (!lista) return;

  const resolvidas = Object.values(allApostas)
    .filter(a => a.estado !== "pendente")
    .sort((a,b) => (b.resolvidaEm?.seconds||b.criadaEm?.seconds||0) - (a.resolvidaEm?.seconds||a.criadaEm?.seconds||0));

  if (!resolvidas.length) {
    lista.innerHTML = "<p class='empty'>Sem apostas resolvidas.</p>";
    return;
  }

  lista.innerHTML = resolvidas.map(a => {
    const jog    = allJogadores[a.uid];
    const ganhou = a.estado === "ganha";
    const stClass = ganhou ? "won" : "lost";
    const stIcon  = ganhou ? "ti-check" : "ti-x";
    const tipo    = a.apostas?.length > 1 ? `Múltipla ${a.apostas.length}×` : "Simples";

    return `<div class="adm-bet-card">
      <div class="adm-bet-head">
        <div class="adm-bet-av">${jog?.avatar||"?"}</div>
        <div class="adm-bet-player">${jog?.nome||"?"}</div>
        <span class="adm-bet-type">${tipo}</span>
        <div class="adm-sel-ic ${stClass}" style="margin-left:auto;width:20px;height:20px">
          <i class="ti ${stIcon}" style="font-size:10px" aria-hidden="true"></i>
        </div>
        <span style="font-size:11px;color:${ganhou?"var(--grn)":"var(--red)"};">${a.estado}</span>
      </div>
      <div class="adm-bet-body">
        <div class="adm-sel-game" style="font-size:13px;margin-bottom:2px">${a.jogo}</div>
        <div class="adm-sel-pred" style="margin-bottom:10px">${a.previsao.slice(0,70)}${a.previsao.length>70?"…":""} · odd ${a.odd?.toFixed?a.odd.toFixed(2):a.odd} · ${a.valor?.toFixed(2)} €</div>
        <div class="adm-bet-actions">
          <button onclick="window.corrigirAposta(this.dataset.id, true)"  data-id="${a.id}" class="adm-btn-win">Marcar como ganha</button>
          <button onclick="window.corrigirAposta(this.dataset.id, false)" data-id="${a.id}" class="adm-btn-lose">Marcar como perdida</button>
        </div>
      </div>
    </div>`;
  }).join("");
}

window.corrigirAposta = async function(id, ganhou) {
  if (!isAdmin()) return;
  const aposta = allApostas[id];
  if (!aposta) return;
  const jog = allJogadores[aposta.uid];
  if (!jog) return;

  // Recalcula o saldo revertendo o estado anterior e aplicando o novo
  let saldo = jog.saldo;

  // Lógica:
  // Quando a aposta foi criada, o valor foi sempre descontado do saldo.
  // Quando foi marcada como ganha, valor*odd foi adicionado.
  // Portanto:
  //   - Se era GANHA e vamos corrigir para PERDIDA: remove valor*odd
  //   - Se era PERDIDA e vamos corrigir para GANHA: adiciona valor*odd
  //   - Se era GANHA e vamos marcar GANHA outra vez: não faz nada (já está certo)
  //   - Se era PERDIDA e vamos marcar PERDIDA outra vez: não faz nada

  const lucro = ganhou
    ? +(aposta.valor * aposta.odd - aposta.valor).toFixed(2)
    : +(-aposta.valor).toFixed(2);

  if (aposta.estado === "ganha" && !ganhou) {
    // Era ganha, passa a perdida — remove os ganhos
    saldo = +(saldo - aposta.valor * aposta.odd).toFixed(2);
  } else if (aposta.estado === "perdida" && ganhou) {
    // Era perdida, passa a ganha — adiciona os ganhos
    saldo = +(saldo + aposta.valor * aposta.odd).toFixed(2);
  }
  // Se o estado não muda, o saldo fica igual

  await updateDoc(doc(db, "apostas", id), {
    estado: ganhou ? "ganha" : "perdida",
    lucro,
    resolvidaEm: serverTimestamp()
  });
  await updateDoc(doc(db, "jogadores", aposta.uid), { saldo });
  await registarLog(`Aposta corrigida: ${jog.nome} — ${aposta.jogo} → ${ganhou ? "ganha ✅" : "perdida ❌"} (saldo: ${saldo.toFixed(2)} €)`);

  // Atualiza a vista sem precisar de F5
  renderAdminCorrigir();
  showToast(`Aposta corrigida — saldo de ${jog.nome}: ${saldo.toFixed(2)} €`, "sucesso");
};

// ── Bloquear jogos ─────────────────────────────────────────────────────────
async function renderAdminBloquear() {
  const lista = $("admin-bloquear-lista");
  if (!lista) return;
  const snap = await getDoc(doc(db, "config", "jogos_bloqueados"));
  const bloqueados = snap.exists() ? (snap.data().ids || []) : [];

  // Agrupa apostas por jogo para mostrar jogos únicos
  const jogos = {};
  Object.values(allApostas).forEach(a => {
    if (!jogos[a.jogo]) jogos[a.jogo] = a.jogo;
  });
  const jogosUnicos = Object.keys(jogos);

  if (!jogosUnicos.length) {
    lista.innerHTML = "<p style='font-size:13px;color:var(--acc);text-align:center;padding:.75rem'>Ainda não há jogos com apostas.</p>";
    return;
  }

  lista.innerHTML = jogosUnicos.map(jogo => {
    const id = btoa(jogo).slice(0, 20);
    const bloqueado = bloqueados.includes(id);
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)">
      <span style="font-size:13px;color:#e8e7f8">${jogo}</span>
      <button onclick="toggleBloquear('${id}', '${jogo.replace(/'/g,"\'")}')"
        style="background:${bloqueado ? "#065f46" : "#7f1d1d"};color:#fff;border:none;border-radius:6px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer">
        ${bloqueado ? "🔓 Desbloquear" : "🔒 Bloquear"}
      </button>
    </div>`;
  }).join("");
}

window.toggleBloquear = async function(id, jogo) {
  const ref  = doc(db, "config", "jogos_bloqueados");
  const snap = await getDoc(ref);
  let ids    = snap.exists() ? (snap.data().ids || []) : [];
  if (ids.includes(id)) {
    ids = ids.filter(i => i !== id);
    await setDoc(ref, { ids });
    await registarLog(`Jogo desbloqueado: ${jogo}`);
    showToast(`🔓 ${jogo} desbloqueado.`, "sucesso");
  } else {
    ids.push(id);
    await setDoc(ref, { ids });
    await registarLog(`Jogo bloqueado: ${jogo}`);
    showToast(`🔒 ${jogo} bloqueado.`, "sucesso");
  }
  renderAdminBloquear();
};

// Verifica se um jogo está bloqueado antes de aceitar apostas
async function jogoEstaBloqueado(jogoNome) {
  const snap = await getDoc(doc(db, "config", "jogos_bloqueados"));
  if (!snap.exists()) return false;
  const id = btoa(jogoNome).slice(0, 20);
  return (snap.data().ids || []).includes(id);
}

// ── Ajustar saldos ──────────────────────────────────────────────────────────
function renderAdminSaldos() {
  const lista = $("admin-saldos-lista");
  if (!lista) return;
  const jogadores = Object.values(allJogadores);
  if (!jogadores.length) { lista.innerHTML = "<p style='font-size:13px;color:var(--acc);text-align:center;padding:.75rem'>Sem jogadores.</p>"; return; }

  lista.innerHTML = jogadores.map(j => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
      <div style="width:28px;height:28px;border-radius:50%;background:var(--bg3);border:1px solid var(--acc);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--t2);flex-shrink:0">${j.avatar}</div>
      <span style="flex:1;font-size:13px;font-weight:600;color:#e8e7f8">${j.nome}</span>
      <span style="font-size:13px;color:var(--acc);margin-right:8px">${j.saldo.toFixed(2)} €</span>
      <input id="adj-${j.uid}" type="number" step="0.10" placeholder="ex: +2 ou -1"
        style="width:100px;padding:5px 8px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:#e8e7f8;font-size:12px;outline:none">
      <button onclick="ajustarSaldo('${j.uid}', '${j.nome}')"
        style="background:var(--acc);color:#fff;border:none;border-radius:6px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer">Aplicar</button>
    </div>`).join("");
}

window.ajustarSaldo = async function(uid, nome) {
  const input = $(`adj-${uid}`);
  const delta = parseFloat(input?.value);
  if (isNaN(delta) || delta === 0) return showToast("Introduz um valor válido.", "erro");
  const jog = allJogadores[uid];
  if (!jog) return;
  const novoSaldo = +(jog.saldo + delta).toFixed(2);
  await updateDoc(doc(db, "jogadores", uid), { saldo: novoSaldo });
  await registarLog(`Saldo ajustado: ${nome} ${delta > 0 ? "+" : ""}${delta.toFixed(2)} € → ${novoSaldo.toFixed(2)} €`);
  if (input) input.value = "";
  showToast(`Saldo de ${nome} ajustado para ${novoSaldo.toFixed(2)} €`, "sucesso");
};

// ── Histórico de apostas ────────────────────────────────────────────────────
function renderAdminHistorico() {
  const lista = $("admin-historico-lista");
  if (!lista) return;
  const apostas = Object.values(allApostas)
    .sort((a, b) => (b.criadaEm?.seconds || 0) - (a.criadaEm?.seconds || 0));

  if (!apostas.length) { lista.innerHTML = "<p style='font-size:13px;color:var(--acc);text-align:center;padding:.75rem'>Sem apostas.</p>"; return; }

  lista.innerHTML = apostas.map(a => {
    const jog  = allJogadores[a.uid];
    const ts   = a.criadaEm?.seconds ? new Date(a.criadaEm.seconds * 1000) : new Date(a.criadaEm);
    const data = ts.toLocaleString("pt-PT", { day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit" });
    return `<div style="padding:8px 0;border-bottom:1px solid var(--line)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
        <div style="width:22px;height:22px;border-radius:50%;background:var(--bg3);border:1px solid var(--acc);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:var(--t2);flex-shrink:0">${jog?.avatar||"?"}</div>
        <span style="font-size:12px;font-weight:600;color:var(--t2)">${jog?.nome||"?"}</span>
        <span style="font-size:11px;color:var(--acc);margin-left:auto">${data}</span>
        <span class="chip chip-${a.estado}" style="font-size:10px;padding:2px 7px">${a.estado}</span>
      </div>
      <div style="font-size:13px;color:#e8e7f8;padding-left:30px">${a.jogo}</div>
      <div style="font-size:11px;color:var(--acc);padding-left:30px">${a.previsao.slice(0,80)}${a.previsao.length>80?"…":""} · odd ${a.odd?.toFixed?a.odd.toFixed(2):a.odd} · ${a.valor?.toFixed(2)} €</div>
    </div>`;
  }).join("");
}

// ── Log de atividade ────────────────────────────────────────────────────────
async function registarLog(mensagem) {
  const id = `log_${Date.now()}`;
  await setDoc(doc(db, "logs", id), {
    mensagem,
    uid:  currentUser?.uid,
    nome: allJogadores[currentUser?.uid]?.nome || "Admin",
    criadaEm: serverTimestamp()
  });
}

async function renderAdminLog() {
  const lista = $("admin-log-lista");
  if (!lista) return;
  lista.innerHTML = "<p style='font-size:13px;color:var(--acc);text-align:center;padding:.75rem'>A carregar...</p>";
  try {
    const snap = await getDocs(query(collection(db, "logs"), orderBy("criadaEm", "desc"), limit(50)));
    if (snap.empty) { lista.innerHTML = "<p style='font-size:13px;color:var(--acc);text-align:center;padding:.75rem'>Sem registos.</p>"; return; }
    lista.innerHTML = snap.docs.map(d => {
      const log  = d.data();
      const ts   = log.criadaEm?.seconds ? new Date(log.criadaEm.seconds * 1000) : new Date();
      const data = ts.toLocaleString("pt-PT", { day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit" });
      return `<div style="display:flex;align-items:flex-start;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)">
        <span style="font-size:11px;color:var(--acc);flex-shrink:0;margin-top:2px">${data}</span>
        <span style="font-size:13px;color:#e8e7f8">${log.mensagem}</span>
      </div>`;
    }).join("");
  } catch(e) {
    lista.innerHTML = `<p style='font-size:13px;color:#f87171;padding:.75rem'>${e.message}</p>`;
  }
}


function renderAdminPanel() {
  const pendentes = Object.values(allApostas).filter(a => a.estado === "pendente");
  const lista = $("admin-apostas-lista");
  if (!lista) return;

  if (!pendentes.length) {
    lista.innerHTML = "<p style='font-size:13px;color:var(--acc);text-align:center;padding:.75rem'>Não há apostas pendentes.</p>";
    return;
  }

  lista.innerHTML = pendentes.map(a => {
    const jog     = allJogadores[a.uid];
    const temSels = a.apostas && a.apostas.length > 0;
    const tipo    = a.apostas?.length > 1 ? `Múltipla ${a.apostas.length}×` : "Simples";

    const selsHTML = temSels ? a.apostas.map((s, i) => {
      const st      = s.estadoSel || "pendente";
      const icClass = st === "ganha" ? "ti-check" : st === "perdida" ? "ti-x" : "ti-clock";
      const stClass = st === "ganha" ? "won" : st === "perdida" ? "lost" : "pend";
      const btns    = st === "pendente" ? `
        <button onclick="window.resolverSelecao('${a.id}',${i},true)"  class="sel-btn-win">✓</button>
        <button onclick="window.resolverSelecao('${a.id}',${i},false)" class="sel-btn-lose">✗</button>` : `<div style="width:60px"></div>`;
      return `<div class="adm-sel-row">
        <div class="adm-sel-ic ${stClass}"><i class="ti ${icClass}" style="font-size:9px" aria-hidden="true"></i></div>
        <div class="adm-sel-info">
          <div class="adm-sel-game">${s.jogo}</div>
          <div class="adm-sel-pred">${s.previsao}</div>
        </div>
        <div class="adm-sel-odd">×${s.odd}</div>
        <div class="adm-sel-btns">${btns}</div>
      </div>`;
    }).join("") : `<div class="adm-sel-row">
      <div class="adm-sel-ic pend"><i class="ti ti-clock" style="font-size:9px" aria-hidden="true"></i></div>
      <div class="adm-sel-info">
        <div class="adm-sel-game">${a.jogo}</div>
        <div class="adm-sel-pred">${a.previsao?.slice(0,80)}${(a.previsao?.length||0)>80?"…":""}</div>
      </div>
      <div class="adm-sel-odd">×${a.odd?.toFixed?a.odd.toFixed(2):a.odd}</div>
      <div class="adm-sel-btns">
        <button onclick="resolverAposta('${a.id}',true)"  class="sel-btn-win">✓</button>
        <button onclick="resolverAposta('${a.id}',false)" class="sel-btn-lose">✗</button>
      </div>
    </div>`;

    return `<div class="adm-bet-card">
      <div class="adm-bet-head">
        <div class="adm-bet-av">${jog?.avatar||"?"}</div>
        <div class="adm-bet-player">${jog?.nome||"?"}</div>
        <span class="adm-bet-type">${tipo}</span>
        <div class="adm-bet-val">${a.valor?.toFixed(2)} € · odd ${a.odd?.toFixed?a.odd.toFixed(2):a.odd}</div>
      </div>
      <div class="adm-bet-body">
        ${selsHTML}
        <div class="adm-bet-actions">
          <button onclick="resolverAposta('${a.id}',true)"  class="adm-btn-win">Toda ganha</button>
          <button onclick="resolverAposta('${a.id}',false)" class="adm-btn-lose">Perdida</button>
        </div>
      </div>
    </div>`;
  }).join("")

window.resolverSelecao = async function(apostaId, selIdx, ganhou) {
  if (!isAdmin()) return;
  const ap = Object.values(allApostas).find(a => a.id === apostaId);
  if (!ap || !ap.apostas) return;

  const apostasAtualizadas = ap.apostas.map((s, i) =>
    i === selIdx ? { ...s, estadoSel: ganhou ? "ganha" : "perdida" } : s
  );

  // Verifica se todas estão resolvidas
  const todasResolvidas = apostasAtualizadas.every(s => s.estadoSel && s.estadoSel !== "pendente");
  const algumaPerdida   = apostasAtualizadas.some(s => s.estadoSel === "perdida");

  const updates = { apostas: apostasAtualizadas };

  if (todasResolvidas) {
    const ganhouTudo = !algumaPerdida;
    const lucro = ganhouTudo
      ? +(ap.valor * ap.odd - ap.valor).toFixed(2)
      : +(-ap.valor).toFixed(2);
    updates.estado      = ganhouTudo ? "ganha" : "perdida";
    updates.lucro       = lucro;
    updates.resolvidaEm = serverTimestamp();
    if (ganhouTudo) {
      const jog = allJogadores[ap.uid];
      if (jog) await updateDoc(doc(db, "jogadores", ap.uid), {
        saldo: +(jog.saldo + ap.valor * ap.odd).toFixed(2)
      });
    }
    await registarLog(`Múltipla ${ganhouTudo ? "ganha ✅" : "perdida ❌"}: ${Object.values(allJogadores).find(j=>j.uid===ap.uid)?.nome} — ${ap.jogo}`);
    showToast(ganhouTudo ? "✅ Múltipla ganha!" : "❌ Múltipla perdida.", ganhouTudo ? "sucesso" : "erro");
  } else {
    showToast(ganhou ? "✅ Seleção marcada como ganha" : "❌ Seleção marcada como perdida", ganhou ? "sucesso" : "erro");
  }

  await updateDoc(doc(db, "apostas", ap.id), updates);
};

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
  await registarLog(`Aposta ${ganhou ? "ganha ✅" : "perdida ❌"}: ${jog.nome} — ${aposta.jogo} (${lucro > 0 ? "+" : ""}${lucro.toFixed(2)} €)`);
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

