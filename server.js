// TEXAS HOLD'EM — Jedan server (Lobby + Stolovi + Admin + WS)
// ============================================================
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const Database = require("better-sqlite3");
const { WebSocketServer } = require("ws");

// ---- Config (Render-friendly) ----
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_KEY = process.env.ADMIN_KEY || "admin123";

// ---- Public cleanup: obriši sve što počinje s '0' ----
(function purgeZeroPrefixed() {
  const pub = path.join(__dirname, "public");
  if (!fs.existsSync(pub)) return;
  for (const name of fs.readdirSync(pub)) {
    if (!name || name[0] !== "0") continue;
    const p = path.join(pub, name);
    try {
      const stat = fs.lstatSync(p);
      if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
      console.log("🧹 removed", name);
    } catch (e) {
      console.warn("🧹 failed removing", name, e.message);
    }
  }
})();

// ---- DB ----
fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
const db = new Database(path.join(__dirname, "data", "poker.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  pass TEXT,
  nick TEXT,
  avatar TEXT DEFAULT '/avatar_1.png',
  balance INTEGER DEFAULT 0,      -- čipovi u "chip" jedinici (KM * 100 ako želiš), ovdje: KM*100
  disabled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

function chipsFromKM(km) { return Math.round(km * 100); }
function kmFromChips(ch) { return (ch / 100); }

// ---- Express ----
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ---- Static ----
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// ---- Auth (register/login/logout/me) ----
app.post("/api/auth/register", (req, res) => {
  let { email, password, nick, avatar } = req.body || {};
  email = (email || "").trim().toLowerCase();
  nick = (nick || "").trim().slice(0, 24);
  avatar = (avatar || "/avatar_1.png");

  if (!email || !password || !nick) {
    return res.status(400).json({ ok: false, error: "Email, lozinka i nick su obavezni." });
  }
  const pass = bcrypt.hashSync(password, 10);
  try {
    const st = db.prepare("INSERT INTO users (email, pass, nick, avatar, balance) VALUES (?, ?, ?, ?, ?)");
    // start balans 0 (po želji možeš dati bonus)
    st.run(email, pass, nick, avatar, 0);
  } catch (e) {
    return res.status(400).json({ ok: false, error: "Email postoji." });
  }
  const u = db.prepare("SELECT id,email,nick,avatar,balance,disabled FROM users WHERE email=?").get(email);
  res.cookie("uid", String(u.id), { httpOnly: false, sameSite: "lax" });
  res.json({ ok: true, user: u });
});

app.post("/api/auth/login", (req, res) => {
  let { email, password } = req.body || {};
  email = (email || "").trim().toLowerCase();
  const u = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!u) return res.status(400).json({ ok: false, error: "Neispravan email/lozinka." });
  if (u.disabled) return res.status(403).json({ ok: false, error: "Korisnik je onemogućen." });
  if (!bcrypt.compareSync(password || "", u.pass)) {
    return res.status(400).json({ ok: false, error: "Neispravan email/lozinka." });
  }
  res.cookie("uid", String(u.id), { httpOnly: false, sameSite: "lax" });
  res.json({ ok: true, user: { id:u.id, email:u.email, nick:u.nick, avatar:u.avatar, balance:u.balance, disabled:u.disabled } });
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("uid");
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const uid = parseInt(req.cookies.uid || "0", 10);
  if (!uid) return res.json({ ok: false });
  const u = db.prepare("SELECT id,email,nick,avatar,balance,disabled FROM users WHERE id=?").get(uid);
  if (!u) return res.json({ ok: false });
  res.json({ ok: true, user: u });
});

// ---- Admin API (x-admin-key) ----
function requireAdmin(req, res, next) {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

app.get("/api/admin/users", requireAdmin, (_req, res) => {
  const list = db.prepare("SELECT id,email,nick,avatar,balance,disabled FROM users ORDER BY id DESC").all();
  res.json({ ok: true, users: list });
});

app.post("/api/admin/chips", requireAdmin, (req, res) => {
  const { email, amount } = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE email=?").get((email || "").toLowerCase());
  if (!u) return res.json({ ok:false, error:"Korisnik ne postoji." });
  const newBal = (u.balance|0) + parseInt(amount|0, 10);
  db.prepare("UPDATE users SET balance=? WHERE id=?").run(newBal, u.id);
  res.json({ ok:true, balance:newBal });
});

app.post("/api/admin/disable", requireAdmin, (req, res) => {
  const { email, flag } = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE email=?").get((email || "").toLowerCase());
  if (!u) return res.json({ ok:false, error:"Korisnik ne postoji." });
  db.prepare("UPDATE users SET disabled=? WHERE id=?").run(flag?1:0, u.id);
  res.json({ ok:true });
});

// ---- Stolovi (in-memory; 2 stola) ----
function freshTable(cfg) {
  return {
    id: cfg.id, name: cfg.name, seatsCount: 9,
    sb: cfg.sb, bb: cfg.bb, minBB: cfg.minBB, maxBB: cfg.maxBB, currency: "KM",
    seats: Array(9).fill(null), // { uid, nick, stackChips, avatar, sitout }
    dealer: 0, potChips: 0, board: [], stage: "idle", toAct: null, lastUpdated: Date.now()
  };
}
const TABLES = {
  small: freshTable({ id:"small", name:"Mali sto", sb:0.2, bb:0.5, minBB:50, maxBB:100 }),
  big:   freshTable({ id:"big",   name:"Veliki sto", sb:1.0, bb:2.0, minBB:50, maxBB:100 })
};

function sanitizeTable(t) {
  return {
    id: t.id, name: t.name, sb: t.sb, bb: t.bb, minBB: t.minBB, maxBB: t.maxBB, currency: t.currency,
    seats: t.seats.map(s => s ? ({ nick:s.nick, stack: kmFromChips(s.stackChips), avatar:s.avatar }) : null),
    dealer: t.dealer, pot: kmFromChips(t.potChips), board: t.board, stage: t.stage, toAct: t.toAct, lastUpdated: t.lastUpdated
  };
}

function broadcastTable(tableId) {
  const t = TABLES[tableId];
  const payload = JSON.stringify({ type: "state", table: sanitizeTable(t) });
  for (const [ws, sess] of SESS.entries()) {
    if (sess.tableId === tableId && ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function leaveSeat(tableId, seatIndex) {
  const t = TABLES[tableId];
  if (!t) return;
  const s = t.seats[seatIndex];
  if (s) {
    // refund preostali stack u korisnikov balans
    const u = db.prepare("SELECT id,balance FROM users WHERE id=?").get(s.uid);
    if (u) db.prepare("UPDATE users SET balance=? WHERE id=?").run((u.balance|0) + (s.stackChips|0), u.id);
  }
  t.seats[seatIndex] = null;
  t.lastUpdated = Date.now();
}

// ---- WS session map ----
const SESS = new Map(); // ws -> { uid, tableId, seatIndex }

// ---- WebSocket ----
wss.on("connection", (ws, req) => {
  // parse cookies
  const cookies = Object.fromEntries((req.headers.cookie || "").split(";").map(x => x.trim().split("=")).filter(a => a[0]));
  const uid = parseInt(cookies.uid || "0", 10);
  const me = uid ? db.prepare("SELECT id,email,nick,avatar,balance,disabled FROM users WHERE id=?").get(uid) : null;

  if (!me) {
    ws.send(JSON.stringify({ type: "error", msg: "Niste prijavljeni." }));
    ws.close(); return;
  }
  if (me.disabled) {
    ws.send(JSON.stringify({ type: "error", msg: "Račun je onemogućen." }));
    ws.close(); return;
  }

  SESS.set(ws, { uid: me.id, tableId: null, seatIndex: null });

  ws.send(JSON.stringify({
    type: "hello",
    me,
    tables: { small: sanitizeTable(TABLES.small), big: sanitizeTable(TABLES.big) }
  }));

  ws.on("message", (buf) => {
    let msg = null;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    const sess = SESS.get(ws); if (!sess) return;

    if (msg.type === "selectTable") {
      const { tableId } = msg;
      if (!TABLES[tableId]) return;
      sess.tableId = tableId;
      ws.send(JSON.stringify({ type: "selected", table: sanitizeTable(TABLES[tableId]) }));
      return;
    }

    if (msg.type === "join") {
      const { tableId, seatIndex, buyinKM } = msg;
      const t = TABLES[tableId];
      if (!t) return ws.send(JSON.stringify({ type:"error", msg:"Nepoznat sto." }));
      if (seatIndex < 0 || seatIndex >= t.seatsCount) return ws.send(JSON.stringify({ type:"error", msg:"Neispravno sjedalo." }));
      if (t.seats[seatIndex]) return ws.send(JSON.stringify({ type:"error", msg:"Sjedalo zauzeto." }));

      const minKM = t.bb * t.minBB;
      const maxKM = t.bb * t.maxBB;
      if (typeof buyinKM !== "number" || buyinKM < minKM || buyinKM > maxKM) {
        return ws.send(JSON.stringify({ type:"error", msg:`Buy-in mora biti ${t.minBB}–${t.maxBB}BB (${minKM.toFixed(2)}–${maxKM.toFixed(2)} KM)` }));
      }

      const u = db.prepare("SELECT id,balance,nick,avatar,disabled FROM users WHERE id=?").get(sess.uid);
      if (!u || u.disabled) return ws.send(JSON.stringify({ type:"error", msg:"Korisnik nije dozvoljen." }));

      const needChips = chipsFromKM(buyinKM);
      if ((u.balance|0) < needChips) {
        return ws.send(JSON.stringify({ type:"error", msg:"Nedovoljno čipova na računu." }));
      }

      // ako već sjedi negdje, digni ga (refund)
      if (sess.tableId && sess.seatIndex !== null) {
        leaveSeat(sess.tableId, sess.seatIndex);
        broadcastTable(sess.tableId);
      }

      // skini buyin
      db.prepare("UPDATE users SET balance=? WHERE id=?").run((u.balance|0) - needChips, u.id);

      // posadi
      t.seats[seatIndex] = {
        uid: u.id, nick: u.nick, stackChips: needChips, avatar: u.avatar, sitout: false
      };
      t.lastUpdated = Date.now();

      sess.tableId = tableId;
      sess.seatIndex = seatIndex;

      broadcastTable(tableId);
      return;
    }

    if (msg.type === "leave") {
      if (sess.tableId && sess.seatIndex !== null) {
        leaveSeat(sess.tableId, sess.seatIndex);
        broadcastTable(sess.tableId);
        sess.seatIndex = null;
      }
      return;
    }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
  });

  ws.on("close", () => {
    const sess = SESS.get(ws);
    if (sess && sess.tableId && sess.seatIndex !== null) {
      leaveSeat(sess.tableId, sess.seatIndex);
      broadcastTable(sess.tableId);
    }
    SESS.delete(ws);
  });
});

// ---- Health (Render) ----
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/health",  (_req, res) => res.json({ ok:true, ts: Date.now() }));

// ---- Start ----
server.listen(PORT, HOST, () => {
  console.log(`✅ Poker server running at http://${HOST}:${PORT}`);
});
