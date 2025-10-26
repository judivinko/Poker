// TEXAS HOLD'EM • SERVER (Express + WS + better-sqlite3)
// =====================================================
// - Auth: nick+password (JWT u http-only cookie)
// - Admin API: x-admin-key (users, chips +/- , disable/enable)
// - DB: users, tables, seats
// - Inicijalna 2 stola: small (0.2/0.5), big (1/2), buy-in 50–200 BB
// - Rake: 1% pota (spremno za engine; klijent trenutno demo, WS stub)
// - Brisanje fajlova u /public koji počinju s '0'
// - Health rute za Render
// =====================================================

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const jwt = require("jsonwebtoken");
const WebSocket = require("ws");

// ----------------- CONFIG -----------------
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const TOKEN_NAME = "token";

// Admin ključ za x-admin-key header (Admin UI)
const ADMIN_KEY = process.env.ADMIN_KEY || "admin123";

// Rake (1% pota) – čuvamo samo konfiguraciju, engine kasnije koristi
const RAKE_PERCENT = parseFloat(process.env.RAKE_PERCENT || "1"); // 1%

// Buy-in granice u BB
const MIN_BUYIN_BB = 50;
const MAX_BUYIN_BB = 200;

// ----------------- FILE PATHS -----------------
const PUBLIC_DIR = path.join(__dirname, "public");
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// ----------------- HELPER: obriši fajlove koji počinju s '0' -----------------
try {
  const names = fs.readdirSync(PUBLIC_DIR, { withFileTypes: true });
  for (const ent of names) {
    if (ent.name.startsWith("0")) {
      const p = path.join(PUBLIC_DIR, ent.name);
      try {
        if (ent.isDirectory()) {
          fs.rmSync(p, { recursive: true, force: true });
        } else {
          fs.unlinkSync(p);
        }
        console.log("🧹 Removed:", ent.name);
      } catch (e) {
        console.warn("⚠️ Cannot remove:", ent.name, e.message);
      }
    }
  }
} catch (e) {
  console.warn("⚠️ Cleanup public/ failed:", e.message);
}

// ----------------- DB INIT -----------------
const DB_FILE = path.join(__dirname, "data", "poker.db");
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);

// Users
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  nick TEXT UNIQUE,
  pass TEXT,
  avatar TEXT DEFAULT '/avatar_1.png',
  balance INTEGER DEFAULT 0,        -- chips
  disabled INTEGER DEFAULT 0,
  is_admin INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  last_seen  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_nick ON users(nick);
`);

// Tables
db.exec(`
CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  seats INTEGER,
  sb REAL,
  bb REAL,
  min_buyin_bb INTEGER,
  max_buyin_bb INTEGER
);
`);

// Seats (jednostavno mapiranje — detaljan engine poslije)
db.exec(`
CREATE TABLE IF NOT EXISTS seats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER,
  seat_index INTEGER,      -- 0..8
  user_id INTEGER,         -- null = free
  stack INTEGER DEFAULT 0, -- chips na stolu
  in_hand INTEGER DEFAULT 0,
  FOREIGN KEY(table_id) REFERENCES tables(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_seats_table ON seats(table_id);
`);

// Inicijalizuj 2 stola ako ne postoje
const hasTables = db.prepare(`SELECT COUNT(*) AS c FROM tables`).get().c > 0;
if (!hasTables) {
  const insT = db.prepare(`
    INSERT INTO tables(name,seats,sb,bb,min_buyin_bb,max_buyin_bb)
    VALUES (@name,@seats,@sb,@bb,@minbb,@maxbb)
  `);
  const small = insT.run({ name: "small", seats: 9, sb: 0.2, bb: 0.5, minbb: MIN_BUYIN_BB, maxbb: MAX_BUYIN_BB }).lastInsertRowid;
  const big   = insT.run({ name: "big",   seats: 9, sb: 1.0, bb: 2.0, minbb: MIN_BUYIN_BB, maxbb: MAX_BUYIN_BB }).lastInsertRowid;

  const insS = db.prepare(`INSERT INTO seats(table_id, seat_index, user_id, stack, in_hand) VALUES (?,?,?,?,0)`);
  for (let i = 0; i < 9; i++) insS.run(small, i, null, 0);
  for (let i = 0; i < 9; i++) insS.run(big,   i, null, 0);

  console.log("🧱 Tables initialized: small & big");
}

// ----------------- APP/HTTP/WS -----------------
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// -------------- Middleware --------------
app.use(express.json());
app.use(cookieParser());

// Static
app.use(express.static(PUBLIC_DIR, {
  index: false, // front ima svoje index.html i admin.html
}));

// Alias za card_bach.png ako je datoteka slučajno "card_ bach.png"
app.get("/card_bach.png", (req, res, next) => {
  const normal = path.join(PUBLIC_DIR, "card_bach.png");
  const spaced = path.join(PUBLIC_DIR, "card_ bach.png");
  if (fs.existsSync(normal)) return res.sendFile(normal);
  if (fs.existsSync(spaced)) return res.sendFile(spaced);
  return res.status(404).end();
});

// Serve frontove (ako otvara direktno / ili /admin)
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));

// -------------- Auth helpers --------------
function makeToken(u) {
  return jwt.sign({ uid: u.id, nick: u.nick }, JWT_SECRET, { expiresIn: "30d" });
}
function readToken(req) {
  const t = req.cookies?.[TOKEN_NAME];
  if (!t) return null;
  try { return jwt.verify(t, JWT_SECRET); } catch { return null; }
}
function authRequired(req, res, next) {
  const p = readToken(req);
  if (!p) return res.status(401).json({ ok: false, error: "unauthorized" });
  req.user = p;
  next();
}
function adminKeyRequired(req, res, next) {
  const key = req.header("x-admin-key");
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "bad_admin_key" });
  next();
}

// -------------- AUTH API --------------
// Register (email opcionalno; front ga šalje, start_balance = 0)
app.post("/api/register", (req, res) => {
  const { email, nick, pass } = req.body || {};
  if (!nick || !pass) return res.json({ ok: false, error: "nick_and_pass_required" });

  const already = db.prepare(`SELECT id FROM users WHERE nick = ?`).get(nick);
  if (already) return res.json({ ok: false, error: "nick_exists" });

  const hash = bcrypt.hashSync(String(pass), 10);
  const avatar = "/avatar_1.png"; // default
  const info = db.prepare(`
    INSERT INTO users(email,nick,pass,avatar,balance,disabled,is_admin)
    VALUES (?,?,?,?,0,0,0)
  `).run(email || null, nick, hash, avatar);

  const user = db.prepare(`SELECT id,nick,avatar,balance,disabled FROM users WHERE id = ?`).get(info.lastInsertRowid);
  const token = makeToken(user);
  res.cookie(TOKEN_NAME, token, { httpOnly: true, sameSite: "lax", secure: false, maxAge: 30 * 24 * 3600 * 1000 });
  return res.json({ ok: true, user: { id: user.id, nick: user.nick, avatar: user.avatar, balance: user.balance } });
});

// Login (NICK + PASSWORD)
app.post("/api/login", (req, res) => {
  const { nick, pass } = req.body || {};
  if (!nick || !pass) return res.json({ ok: false, error: "nick_and_pass_required" });

  const u = db.prepare(`SELECT * FROM users WHERE nick = ?`).get(nick);
  if (!u) return res.json({ ok: false, error: "invalid_credentials" });
  if (u.disabled) return res.json({ ok: false, error: "user_disabled" });

  const ok = bcrypt.compareSync(String(pass), u.pass || "");
  if (!ok) return res.json({ ok: false, error: "invalid_credentials" });

  const token = makeToken(u);
  db.prepare(`UPDATE users SET last_seen = datetime('now') WHERE id = ?`).run(u.id);

  res.cookie(TOKEN_NAME, token, { httpOnly: true, sameSite: "lax", secure: false, maxAge: 30 * 24 * 3600 * 1000 });
  return res.json({ ok: true, user: { id: u.id, nick: u.nick, avatar: u.avatar, balance: u.balance } });
});

app.get("/api/me", authRequired, (req, res) => {
  const u = db.prepare(`SELECT id,nick,avatar,balance,disabled FROM users WHERE id = ?`).get(req.user.uid);
  if (!u) return res.json({ ok: false, error: "not_found" });
  return res.json({ ok: true, user: u });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie(TOKEN_NAME);
  return res.json({ ok: true });
});

// -------------- ADMIN API --------------
app.get("/api/admin/users", adminKeyRequired, (_req, res) => {
  const rows = db.prepare(`SELECT id,email,nick,avatar,balance,disabled FROM users ORDER BY id DESC`).all();
  // Admin UI sortira po klijentu; vraćamo sve
  res.json({ ok: true, users: rows });
});

app.post("/api/admin/chips", adminKeyRequired, (req, res) => {
  const { email, nick, amount } = req.body || {};
  const delta = parseInt(amount, 10);
  if (!Number.isFinite(delta) || delta === 0) return res.json({ ok: false, error: "bad_amount" });

  // Možemo dozvoliti target po emailu ili po nicku (front šalje email, ali dodajem i nick fallback)
  let u = null;
  if (email) u = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  if (!u && nick) u = db.prepare(`SELECT * FROM users WHERE nick = ?`).get(nick);
  if (!u) return res.json({ ok: false, error: "user_not_found" });

  if (u.disabled) return res.json({ ok: false, error: "user_disabled" });

  const newBal = Math.max(0, (u.balance | 0) + delta); // bez minusa ispod nule
  db.prepare(`UPDATE users SET balance = ?, last_seen = datetime('now') WHERE id = ?`).run(newBal, u.id);
  return res.json({ ok: true, balance: newBal });
});

app.post("/api/admin/disable", adminKeyRequired, (req, res) => {
  const { email, nick, flag } = req.body || {};
  let u = null;
  if (email) u = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  if (!u && nick) u = db.prepare(`SELECT * FROM users WHERE nick = ?`).get(nick);
  if (!u) return res.json({ ok: false, error: "user_not_found" });

  const f = flag ? 1 : 0;
  db.prepare(`UPDATE users SET disabled = ? WHERE id = ?`).run(f, u.id);
  return res.json({ ok: true, disabled: f });
});

// -------------- TABLE / BUY-IN API (minimalno za sada) --------------
// Helper: vrati stol po nazivu ("small" | "big")
function getTableByName(name) {
  return db.prepare(`SELECT * FROM tables WHERE name = ?`).get(name);
}

// Sjedanje: validira buy-in (50–200 BB) i skida s user balance-a
app.post("/api/table/sit", authRequired, (req, res) => {
  const { table: tableName, seat_index, buyin } = req.body || {};
  if (typeof seat_index !== "number" || seat_index < 0 || seat_index > 8) {
    return res.json({ ok: false, error: "bad_seat" });
  }
  const t = getTableByName(tableName || "small");
  if (!t) return res.json({ ok: false, error: "table_not_found" });

  const minChips = Math.round(t.bb * MIN_BUYIN_BB);
  const maxChips = Math.round(t.bb * MAX_BUYIN_BB);
  const amount = Math.floor(Number(buyin || 0));
  if (!Number.isFinite(amount) || amount < minChips || amount > maxChips) {
    return res.json({ ok: false, error: `buyin_${minChips}_${maxChips}` });
  }

  const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.uid);
  if (!u) return res.json({ ok: false, error: "user_not_found" });
  if (u.disabled) return res.json({ ok: false, error: "user_disabled" });
  if ((u.balance | 0) < amount) return res.json({ ok: false, error: "not_enough_chips" });

  const seat = db.prepare(`SELECT * FROM seats WHERE table_id = ? AND seat_index = ?`).get(t.id, seat_index);
  if (!seat) return res.json({ ok: false, error: "seat_not_found" });
  if (seat.user_id) return res.json({ ok: false, error: "seat_taken" });

  const tx = db.transaction(() => {
    db.prepare(`UPDATE users SET balance = balance - ? WHERE id = ?`).run(amount, u.id);
    db.prepare(`UPDATE seats SET user_id = ?, stack = ? WHERE id = ?`).run(u.id, amount, seat.id);
  });
  tx();

  return res.json({ ok: true, table: t.name, seat_index, stack: amount });
});

// -------------- WS (stub) --------------
// Za sada samo ping/pong; engine i privatne hole-karte dodajemo poslije
wss.on("connection", (socket, req) => {
  socket.isAlive = true;
  socket.on("pong", () => (socket.isAlive = true));
  socket.on("message", (msg) => {
    // očekivano kasnije: {type:'join', table:'small'}, {type:'action', action:'CALL', ...}
    // trenutno samo echo nazad
    try {
      const data = JSON.parse(msg.toString());
      socket.send(JSON.stringify({ ok: true, echo: data }));
    } catch {
      socket.send(JSON.stringify({ ok: false, error: "bad_json" }));
    }
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000); // 30s

// ---- Health (Render) ----
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/health",  (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---- Start ----
server.listen(PORT, HOST, () => {
  console.log(`✅ Poker server running at http://${HOST}:${PORT}`);
});
