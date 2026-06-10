# ⚽ WorldStake — FIFA World Cup 2026 Betting Tracker

A real-time betting tracker for friend groups during the 2026 FIFA World Cup. Each player starts with €10 and competes to finish with the most money.

## Features

- **Email & password login** — each friend creates their own account
- **AI-powered bet slip scanning** — take a screenshot of your Betclic, Bet365, etc. slip and Gemini AI reads the bets automatically
- **Real-time leaderboard** — standings update live for everyone simultaneously
- **Bet history** — each player sees their own bets and balance history
- **All bets view** — anyone can see everyone's bets (read-only)
- **Evolution chart** — timeline of each player's balance throughout the tournament
- **Admin panel** — the administrator marks bets as won or lost
- **Automatic resolution** — integration with football-data.org via proxy to resolve bets automatically when matches finish

## Stack

- **Frontend:** HTML, CSS, JavaScript (ES Modules)
- **Database:** Firebase Firestore
- **Authentication:** Firebase Auth (email/password)
- **Hosting:** Firebase Hosting
- **AI for bet slip reading:** Google Gemini API
- **Results proxy:** Node.js on Render.com

---

## Setup

### 1. Firebase

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable **Authentication → Email/Password**
3. Create a **Firestore** database in test mode
4. Go to **Project settings → Your apps → Config** and copy the values

In `app.js`, replace the placeholders:

```js
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_AUTH_DOMAIN",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_STORAGE_BUCKET",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId:             "YOUR_APP_ID"
};
```

### 2. Admin

Log in to the site once, go to Firebase Console → Authentication → Users and copy your UID. Replace in `app.js`:

```js
const ADMIN_UID = "YOUR_ADMIN_UID";
```

### 3. Gemini API

1. Sign up at [aistudio.google.com](https://aistudio.google.com/apikey)
2. Create a free API key
3. Replace in `app.js`:

```js
const GEMINI_API_KEY = "YOUR_GEMINI_API_KEY";
```

### 4. Results Proxy (Render.com)

The proxy solves the CORS issue when calling football-data.org from the browser.

1. Sign up at [football-data.org](https://www.football-data.org) for a free API key
2. Create a GitHub repository with the files from the `render_proxy/` folder
3. On [render.com](https://render.com), create a **Web Service** linked to that repository
4. Add the environment variable: `FOOTBALL_API_KEY` = your key
5. Copy the service URL (e.g. `https://your-proxy.onrender.com`) and replace in `app.js`:

```js
const PROXY_URL = "https://YOUR_PROXY.onrender.com";
```

### 5. Deploy

```bash
npm install -g firebase-tools
firebase login
firebase deploy
```

---

## Firestore Rules (recommended)

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
        (resource.data.uid == request.auth.uid || request.auth.uid == "YOUR_ADMIN_UID");
    }
  }
}
```

---

## File Structure

```
├── index.html          # HTML structure
├── style.css           # Styles
├── app.js              # JavaScript logic + Firebase
├── firebase.json       # Firebase Hosting config
├── render_proxy/
│   ├── server.js       # Node.js proxy for football-data.org
│   └── package.json
└── README.md
```

---

## Notes

- Render's free plan sleeps after 15 minutes of inactivity — the first visit of the day may take ~30 seconds to load match data
- The free Gemini API key has a limit of 15 requests per minute — more than enough for friend groups
- The free football-data.org plan has a limit of 10 requests per minute
