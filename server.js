// TEXAS HOLD'EM — FULL BASIC SERVER
// ===================================================
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "admin123";

// ---------- DATABASE ----------
fs.mkdirSync("./data", { recursive: true });
const db = new Database("./data/poker.db");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  pass TEXT,
  balance INTEGER DEFAULT 1000,
  disabled INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seats INTEGER,
  created_by INTEGER,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS seats (
  table_id INTEGER,
  seat_index INTEGER,
  user_id INTEGER,
  stack INTEGER,
  PRIMARY KEY(table_id,seat_index)
);
`);

// ---------- DELETE IMAGES STARTING WITH "0" ----------
const publicPath = path.join(__dirname, "public");
if (fs.existsSync(publicPath)) {
  for (const f of fs.readdirSync(publicPath)) {
    if (f.startsWith("0")) fs.unlinkSync(path.join(publicPath, f));
  }
}

// ---------- APP ----------
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

// ---------- HELPERS ----------
function currentUser(req) {
  if (!req.cookies.uid) return null;
  return db.prepare("SELECT * FROM users WHERE id=?").get(req.cookies.uid);
}
function requireUser(req, res) {
  const u = currentUser(req);
  if (!u) return res.json({ ok: false, error: "login" });
  if (u.disabled) return res.json({ ok: false, error: "banned" });
  return u;
}

// ---------- AUTH ----------
app.post("/api/register", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ ok:false,error:"missing" });
  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare("INSERT INTO users(email,pass) VALUES(?,?)")
      .run(email.toLowerCase(), hash);
    res.json({ ok:true });
  } catch {
    res.json({ ok:false,error:"exists" });
  }
});

app.post("/api/login", (req,res)=>{
  const { email, password } = req.body;
  const u = db.prepare("SELECT * FROM users WHERE email=?").get(email.toLowerCase());
  if (!u) return res.json({ ok:false,error:"bad" });
  if (!bcrypt.compareSync(password, u.pass)) return res.json({ ok:false,error:"bad" });
  if (u.disabled) return res.json({ ok:false,error:"banned" });
  res.cookie("uid", u.id, { httpOnly:false });
  res.json({ ok:true, balance: u.balance });
});

app.get("/api/logout", (req,res)=>{
  res.clearCookie("uid");
  res.json({ ok:true });
});

// ---------- ADMIN ----------
app.post("/api/admin/chips", (req,res)=>{
  const key = req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) return res.json({ ok:false,error:"key" });

  const { email, amount } = req.body;
  db.prepare("UPDATE users SET balance = balance + ? WHERE email=?")
    .run(amount|0, email.toLowerCase());
  res.json({ ok:true });
});

app.post("/api/admin/disable", (req,res)=>{
  const key = req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) return res.json({ ok:false,error:"key" });

  const { email, flag } = req.body;
  db.prepare("UPDATE users SET disabled=? WHERE email=?")
    .run(flag?1:0, email.toLowerCase());
  res.json({ ok:true });
});

// ---------- TABLE CREATE ----------
app.post("/api/table/create", (req,res)=>{
  const u = requireUser(req,res); if (!u) return;
  let { seats } = req.body;
  seats = Math.max(2, Math.min(9, seats|0));

  const info = db.prepare("INSERT INTO tables(seats,created_by,created_at) VALUES(?,?,datetime('now'))")
    .run(seats, u.id);
  const table_id = info.lastInsertRowid;

  // creator sits seat 0 with 0 chips (buy-in later)
  db.prepare("INSERT INTO seats(table_id,seat_index,user_id,stack) VALUES(?,?,?,0)")
    .run(table_id, 0, u.id);

  broadcastLobby();
  res.json({ ok:true, table_id });
});

// ---------- TABLE LIST ----------
app.get("/api/tables", (req,res)=>{
  const t = db.prepare(`
    SELECT t.*,
    (SELECT COUNT(*) FROM seats s WHERE s.table_id=t.id) AS players
    FROM tables t
  `).all();
  res.json({ ok:true, tables:t });
});

// ---------- TABLE STATE ----------
app.get("/api/table/state", (req,res)=>{
  const id = req.query.id|0;
  const t = db.prepare("SELECT * FROM tables WHERE id=?").get(id);
  if (!t) return res.json({ ok:false,error:"missing" });
  
  const seatRows = db.prepare("SELECT * FROM seats WHERE table_id=?").all(id);
  let seats = [];
  for(let i=0;i<t.seats;i++){
    const s = seatRows.find(x=>x.seat_index===i) || { seat_index:i,user_id:null,stack:0 };
    if (s.user_id){
      const u = db.prepare("SELECT email FROM users WHERE id=?").get(s.user_id);
      s.email = u.email;
    }
    seats.push(s);
  }
  res.json({ ok:true, seats });
});

// ---------- JOIN ----------
app.post("/api/table/join", (req,res)=>{
  const u = requireUser(req,res); if (!u) return;
  const { table_id, seat_index, buyin } = req.body;

  const t = db.prepare("SELECT * FROM tables WHERE id=?").get(table_id);
  if(!t) return res.json({ ok:false,error:"missing" });

  if (seat_index<0 || seat_index>=t.seats) return res.json({ ok:false,error:"bad seat" });

  const taken = db.prepare("SELECT * FROM seats WHERE table_id=? AND seat_index=?")
    .get(table_id, seat_index);
  if (taken) return res.json({ ok:false,error:"taken" });

  const sit = db.prepare("SELECT * FROM seats WHERE table_id=? AND user_id=?")
    .get(table_id, u.id);
  if (sit) return res.json({ ok:false,error:"already" });

  const b = Math.max(1, buyin|0);
  if (u.balance < b) return res.json({ ok:false,error:"no chips" });

  db.prepare("UPDATE users SET balance=balance-? WHERE id=?").run(b, u.id);
  db.prepare("INSERT INTO seats(table_id,seat_index,user_id,stack) VALUES(?,?,?,?)")
    .run(table_id, seat_index, u.id, b);

  broadcastTable(table_id);
  broadcastLobby();
  res.json({ ok:true });
});

// ---------- LEAVE ----------
app.post("/api/table/leave", (req,res)=>{
  const u = requireUser(req,res); if (!u) return;
  const { table_id } = req.body;

  const s = db.prepare("SELECT * FROM seats WHERE table_id=? AND user_id=?")
    .get(table_id, u.id);
  if(!s) return res.json({ ok:false });

  db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(s.stack,u.id);
  db.prepare("DELETE FROM seats WHERE table_id=? AND user_id=?").run(table_id, u.id);

  broadcastTable(table_id);
  broadcastLobby();
  res.json({ ok:true });
});

// ---------- SERVE PAGES ----------
app.get("/", (req,res)=>res.sendFile(path.join(publicPath,"index.html")));
app.get("/table", (req,res)=>res.sendFile(path.join(publicPath,"table.html")));
app.get("/admin", (req,res)=>res.sendFile(path.join(publicPath,"admin.html")));

// ---------- WEBSOCKET ----------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function broadcastLobby(){
  const tables = db.prepare(`
    SELECT t.*,
    (SELECT COUNT(*) FROM seats s WHERE s.table_id=t.id) AS players
    FROM tables t
  `).all();
  sendAll({ type:"lobby", tables });
}

function broadcastTable(table_id){
  const t = db.prepare("SELECT * FROM tables WHERE id=?").get(table_id);
  if(!t) return;
  const seatRows = db.prepare("SELECT * FROM seats WHERE table_id=?").all(table_id);
  let seats = [];
  for(let i=0;i<t.seats;i++){
    const s = seatRows.find(x=>x.seat_index===i) || { seat_index:i,user_id:null,stack:0 };
    seats.push(s);
  }
  sendAll({ type:"table", table_id, seats });
}

function sendAll(msg){
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => c.readyState === 1 && c.send(data));
}

server.listen(PORT, ()=>console.log("✅ Poker server running on port",PORT));
