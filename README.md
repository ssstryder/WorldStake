# ⚽ Mundial 2026 — Apostas entre amigos

Site de apostas desportivas para o Mundial 2026, feito para usar entre amigos. Cada jogador começa com €10 e o objetivo é ver quem termina com mais dinheiro.

## Funcionalidades

- **Login por email e password** — cada amigo cria a sua conta
- **Importar boletim por print** — tira uma screenshot do teu boletim do Betclic, Bet365, etc. e o Gemini AI lê automaticamente as apostas
- **Leaderboard em tempo real** — classificação atualizada para toda a gente em simultâneo
- **Histórico de apostas** — cada um vê as suas apostas e o histórico de saldo
- **Vista de todos** — qualquer pessoa pode ver as apostas de todos (só leitura)
- **Gráfico de evolução** — linha temporal do saldo de cada jogador ao longo do torneio
- **Painel de admin** — o administrador resolve as apostas como ganhas ou perdidas
- **Resolução automática** — integração com football-data.org via proxy para resolver apostas automaticamente quando os jogos terminam

## Stack

- **Frontend:** HTML, CSS, JavaScript (ES Modules)
- **Base de dados:** Firebase Firestore
- **Autenticação:** Firebase Auth (email/password)
- **Hosting:** Firebase Hosting
- **AI para leitura de prints:** Google Gemini API
- **Proxy para resultados:** Node.js no Render.com

---

## Configuração

### 1. Firebase

1. Cria um projeto em [console.firebase.google.com](https://console.firebase.google.com)
2. Ativa **Authentication → Email/Password**
3. Cria uma base de dados **Firestore** em modo de teste
4. Vai a **Configurações do projeto → As tuas apps → Config** e copia os valores

No ficheiro `app.js`, substitui os placeholders:

```js
const firebaseConfig = {
  apiKey:            "SUA_API_KEY",
  authDomain:        "SEU_AUTH_DOMAIN",
  projectId:         "SEU_PROJECT_ID",
  storageBucket:     "SEU_STORAGE_BUCKET",
  messagingSenderId: "SEU_MESSAGING_SENDER_ID",
  appId:             "SEU_APP_ID"
};
```

### 2. Admin

Faz login no site uma vez, vai ao Firebase Console → Authentication → Users e copia o teu UID. Substitui em `app.js`:

```js
const ADMIN_UID = "SEU_UID_DE_ADMIN";
```

### 3. Gemini API

1. Regista-te em [aistudio.google.com](https://aistudio.google.com/apikey)
2. Cria uma chave de API gratuita
3. Substitui em `app.js`:

```js
const GEMINI_API_KEY = "SUA_CHAVE_GEMINI";
```

### 4. Proxy para resultados (Render.com)

O proxy resolve o problema de CORS ao chamar a football-data.org a partir do browser.

1. Regista-te em [football-data.org](https://www.football-data.org) para obteres uma chave gratuita
2. Cria um repositório no GitHub com os ficheiros da pasta `render_proxy/`
3. Em [render.com](https://render.com), cria um **Web Service** ligado a esse repositório
4. Adiciona a variável de ambiente: `FOOTBALL_API_KEY` = a tua chave
5. Copia o URL do serviço (ex: `https://mundial-proxy-xxxx.onrender.com`) e substitui em `app.js`:

```js
const PROXY_URL = "https://SEU_PROXY.onrender.com";
```

### 5. Deploy

```bash
npm install -g firebase-tools
firebase login
firebase deploy
```

---

## Regras do Firestore (recomendado)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /jogadores/{uid} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == uid;
    }
    match /apostas/{betId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null && request.resource.data.uid == request.auth.uid;
      allow update: if request.auth != null &&
        (resource.data.uid == request.auth.uid || request.auth.uid == "SEU_UID_DE_ADMIN");
    }
  }
}
```

---

## Estrutura de ficheiros

```
├── index.html          # Estrutura HTML
├── style.css           # Estilos
├── app.js              # Lógica JavaScript + Firebase
├── firebase.json       # Configuração Firebase Hosting
├── render_proxy/
│   ├── server.js       # Proxy Node.js para football-data.org
│   └── package.json
└── README.md
```

---

## Notas

- O plano gratuito do Render adormece após 15 minutos de inatividade — a primeira visita do dia pode demorar ~30 segundos a carregar os jogos
- A chave Gemini gratuita tem limite de 15 pedidos por minuto — suficiente para uso entre amigos
- A football-data.org gratuita tem limite de 10 pedidos por minuto
