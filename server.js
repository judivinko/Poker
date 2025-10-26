// TEXAS HOLD'EM CASH GAME SERVER — BASE + STATE ENDPOINTS
// =======================================================
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "admin123";

fs.mkdirSync("./data", { recursive: true });
const db = new Database("./data/poker.db");

// ---------- DB ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  pass TEXT,
  balance INTEGER DEFAULT 0,
  disabled INTEGER DEFAULT 0,
  avatar TEXT DEFAULT '/avatar_1.png'
);

CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seats INTEGER,
  sb INTEGER,
  bb INTEGER,
  created_by INTEGER,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS seats (
  table_id INTEGER,
  seat_index INTEGER,
  user_id INTEGER,
  stack INTEGER,
  PRIMARY KEY(table_id, seat_index)
);

CREATE TABLE IF NOT EXISTS game_state (
  table_id INTEGER PRIMARY KEY,
  dealer INTEGER,   -- -1 kada nitko ne dijeli (waiting)
  street TEXT,      -- waiting|preflop|flop|turn|river|showdown
  board TEXT,       -- npr "Ah,Kd,7c,2d,Jc" ili "" kad nema
  pot INTEGER,
  acting INTEGER    -- seat koji je na potezu; -1 ako niko
);
`);

// ---------- STATIC ----------
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

// Alias podrška (da NE moraš mijenjati imena fajlova u repo-u)
app.get("/card_back.png", (req, res) => {
  // ako imaš tipfeler "card_ bach.png" ostavi tako — ovo ga mapira
  const p = path.join(__dirname, "public", "card_ bach.png");
  if (fs.existsSync(p)) return res.sendFile(p);
  return res.sendFile(path.join(__dirname, "public", "card_back.png"));
});
app.get("/app.css", (req, res) => {
  const p = path.join(__dirname, "public", "css.app");
  if (fs.existsSync(p)) return res.sendFile(p);
  return res.sendFile(path.join(__dirname, "public", "app.css"));
});

// ---------- HELPERS ----------
function currentUser(req){
  if (!req.cookies.uid) return null;
  return db.prepare("SELECT * FROM users WHERE id=?").get(req.cookies.uid);
}
function requireUser(req,res){
  const u = currentUser(req);
  if (!u) return res.json({ ok:false, error:"login" });
  if (u.disabled) return res.json({ ok:false, error:"banned" });
  return u;
}
function parseBoard(s){
  if (!s) return [];
  return s.split(",").filter(Boolean);
}
function boardString(arr){
  if (!arr || !arr.length) return "";
  return arr.join(",");
}

// ---------- AUTH ----------
app.post("/api/register",(req,res)=>{
  const { email,password } = req.body||{};
  if(!email || !password || password.length<6) return res.json({ ok:false,error:"missing" });
  try{
    const hash = bcrypt.hashSync(password,10);
    db.prepare("INSERT INTO users(email,pass) VALUES(?,?)").run(email.toLowerCase(),hash);
    res.json({ ok:true });
  }catch{
    res.json({ ok:false,error:"exists" });
  }
});
app.post("/api/login",(req,res)=>{
  const { email,password } = req.body||{};
  const u = db.prepare("SELECT * FROM users WHERE email=?").get((email||"").toLowerCase());
  if(!u) return res.json({ ok:false,error:"bad" });
  if(!bcrypt.compareSync(password||"",u.pass)) return res.json({ ok:false,error:"bad" });
  if(u.disabled) return res.json({ ok:false,error:"banned" });
  res.cookie("uid",u.id,{ httpOnly:false, sameSite:"lax" });
  res.json({ ok:true });
});
app.get("/api/logout",(req,res)=>{ res.clearCookie("uid"); res.json({ ok:true }); });
app.get("/api/me",(req,res)=>{
  const u = currentUser(req);
  if(!u) return res.json({ ok:false });
  res.json({ ok:true, user:{ id:u.id, email:u.email, balance:u.balance, avatar:u.avatar }});
});

// Avatari
app.get("/api/avatars",(req,res)=>{
  const list = fs.readdirSync(path.join(__dirname,"public")).filter(f=>/^avatar_\d+\.png$/i.test(f));
  res.json({ ok:true, avatars:list.map(x=>"/"+x) });
});
app.post("/api/me/avatar",(req,res)=>{
  const u = requireUser(req,res); if(!u) return;
  const { avatar } = req.body||{};
  if(!avatar) return res.json({ ok:false, error:"missing" });
  db.prepare("UPDATE users SET avatar=? WHERE id=?").run(avatar,u.id);
  res.json({ ok:true });
});

// ---------- ADMIN ----------
app.get("/api/admin/users",(req,res)=>{
  if(req.headers["x-admin-key"]!==ADMIN_KEY) return res.json({ ok:false,error:"key" });
  const rows = db.prepare("SELECT * FROM users ORDER BY id DESC").all();
  res.json({ ok:true, users: rows });
});
app.post("/api/admin/chips",(req,res)=>{
  if(req.headers["x-admin-key"]!==ADMIN_KEY) return res.json({ ok:false,error:"key" });
  const { email, amount } = req.body||{};
  if(!email || !amount) return res.json({ ok:false,error:"missing" });
  db.prepare("UPDATE users SET balance=balance+? WHERE email=?").run(amount|0, email.toLowerCase());
  res.json({ ok:true });
});
app.post("/api/admin/disable",(req,res)=>{
  if(req.headers["x-admin-key"]!==ADMIN_KEY) return res.json({ ok:false,error:"key" });
  const { email, flag } = req.body||{};
  if(!email) return res.json({ ok:false,error:"missing" });
  db.prepare("UPDATE users SET disabled=? WHERE email=?").run(flag?1:0, email.toLowerCase());
  res.json({ ok:true });
});

// ---------- TABLES ----------
app.post("/api/table/create",(req,res)=>{
  const u = requireUser(req,res); if(!u) return;
  let { seats, sb, bb } = req.body||{};
  seats = Math.max(2, Math.min(9, seats|0));
  sb = sb|0; bb = bb|0;
  if (sb<1 || bb<2 || bb<=sb) return res.json({ ok:false, error:"bad blinds" });

  const info = db.prepare("INSERT INTO tables(seats,sb,bb,created_by,created_at) VALUES(?,?,?,?,datetime('now'))")
    .run(seats,sb,bb,u.id);
  const table_id = info.lastInsertRowid;

  // inicijalni state: waiting (nema handa)
  db.prepare("INSERT INTO game_state(table_id,dealer,street,board,pot,acting) VALUES(?,?,?,?,?,?)")
    .run(table_id,-1,"waiting","",0,-1);

  res.json({ ok:true, table_id });
  broadcastLobby();
});
app.get("/api/tables",(req,res)=>{
  const t = db.prepare(`
    SELECT t.*,
    (SELECT COUNT(*) FROM seats s WHERE s.table_id=t.id) AS players
    FROM tables t ORDER BY t.id DESC
  `).all();
  res.json({ ok:true, tables:t });
});
app.post("/api/table/join",(req,res)=>{
  const u = requireUser(req,res); if(!u) return;
  const { table_id, seat_index, buyin } = req.body||{};
  const t = db.prepare("SELECT * FROM tables WHERE id=?").get(table_id);
  if(!t) return res.json({ ok:false,error:"missing" });
  if(seat_index<0 || seat_index>=t.seats) return res.json({ ok:false,error:"bad seat" });

  const taken = db.prepare("SELECT 1 FROM seats WHERE table_id=? AND seat_index=?").get(table_id, seat_index);
  if(taken) return res.json({ ok:false,error:"taken" });

  const already = db.prepare("SELECT 1 FROM seats WHERE table_id=? AND user_id=?").get(table_id, u.id);
  if(already) return res.json({ ok:false,error:"already" });

  const b = buyin|0;
  const minBuy = t.bb*50, maxBuy = t.bb*200;
  if (b<minBuy || b>maxBuy) return res.json({ ok:false,error:`buyin ${minBuy}-${maxBuy}` });
  if (u.balance < b) return res.json({ ok:false,error:"no chips" });

  db.prepare("UPDATE users SET balance=balance-? WHERE id=?").run(b,u.id);
  db.prepare("INSERT INTO seats(table_id,seat_index,user_id,stack) VALUES(?,?,?,?)")
    .run(table_id,seat_index,u.id,b);

  broadcastLobby();
  broadcastTable(table_id);
  res.json({ ok:true });
});
app.post("/api/table/leave",(req,res)=>{
  const u = requireUser(req,res); if(!u) return;
  const { table_id } = req.body||{};
  const s = db.prepare("SELECT * FROM seats WHERE table_id=? AND user_id=?").get(table_id,u.id);
  if(!s) return res.json({ ok:false });

  db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(s.stack,u.id);
  db.prepare("DELETE FROM seats WHERE table_id=? AND user_id=?").run(table_id,u.id);

  broadcastLobby();
  broadcastTable(table_id);
  res.json({ ok:true });
});

// ---------- TABLE STATE (za render na /table) ----------
app.get("/api/table/state",(req,res)=>{
  const id = (req.query.id|0);
  const t = db.prepare("SELECT * FROM tables WHERE id=?").get(id);
  if(!t) return res.json({ ok:false, error:"missing" });

  const gs = db.prepare("SELECT * FROM game_state WHERE table_id=?").get(id) || {
    dealer:-1, street:"waiting", board:"", pot:0, acting:-1
  };
  const seats = db.prepare(`
    SELECT s.table_id, s.seat_index, s.user_id, s.stack,
           u.email, u.avatar
    FROM seats s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.table_id=?
  `).all(id);

  // ME & my seat
  const u = currentUser(req);
  let me_seat = -1;
  if (u) {
    const ms = db.prepare("SELECT seat_index FROM seats WHERE table_id=? AND user_id=?").get(id,u.id);
    if (ms) me_seat = ms.seat_index|0;
  }

  const result = {
    ok:true,
    table: { id:t.id, seats:t.seats, sb:t.sb, bb:t.bb },
    street: gs.street || "waiting",
    board: parseBoard(gs.board),
    pot: gs.pot|0,
    dealer: gs.dealer|0,
    acting: gs.acting|0,
    sb_i: (gs.dealer>=0? (gs.dealer+1)%t.seats : -1),
    bb_i: (gs.dealer>=0? (gs.dealer+2)%t.seats : -1),
    seats: seats.map(x=>({
      seat_index:x.seat_index,
      user_id:x.user_id||null,
      stack:x.stack|0,
      email:x.email||null,
      avatar:x.avatar||null
    })),
    me_seat,
    min_bet: 0,    // dok ne uvedemo betting runde
    max_bet: 0
  };
  res.json(result);
});

// ---------- ACTIONS (stub – za sada samo acknowledge) ----------
app.post("/api/table/action",(req,res)=>{
  const u = requireUser(req,res); if(!u) return;
  const { table_id, action, amount } = req.body||{};
  const t = db.prepare("SELECT * FROM tables WHERE id=?").get(table_id);
  if(!t) return res.json({ ok:false,error:"missing" });

  // Ovdje će ići prava betting logika. Za sada samo potvrdi i pošalji update.
  // (UI neće pucati; dugmad će raditi bez efekta.)
  res.json({ ok:true });
  broadcastTable(table_id);
});

// ---------- PAGES ----------
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"public/index.html")));
app.get("/table",(req,res)=>res.sendFile(path.join(__dirname,"public/table.html")));
app.get("/admin",(req,res)=>res.sendFile(path.join(__dirname,"public/admin.html")));

// ---------- WS ----------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function roomBroadcast(table_id,msg){
  const data = JSON.stringify(msg);
  wss.clients.forEach(c=>{
    if(c.table_id===table_id && c.readyState===1) c.send(data);
  });
}
function broadcastLobby(){
  const data = JSON.stringify({ type:"lobby" });
  wss.clients.forEach(c=>c.readyState===1 && c.send(data));
}
function broadcastTable(table_id){
  roomBroadcast(table_id,{ type:"update" });
}

wss.on("connection",(ws)=>{
  ws.table_id = null;
  ws.on("message",(m)=>{
    try{
      const data = JSON.parse(m);
      if(data.type==="join-table"){
        ws.table_id = data.table_id|0;
      }
    }catch{}
  });
});

server.listen(PORT,()=>console.log("✅ Poker server running on",PORT));
