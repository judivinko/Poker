// TEXAS HOLD'EM CASH GAME SERVER (FULL BASE)
// ===========================================
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

-- game state per table
CREATE TABLE IF NOT EXISTS game_state (
  table_id INTEGER PRIMARY KEY,
  dealer INTEGER,
  street TEXT,
  board TEXT,
  pot INTEGER,
  acting INTEGER
);
`);

// ---------- APP ----------
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

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

// ---------- AUTH ----------
app.post("/api/register",(req,res)=>{
  const { email,password } = req.body;
  if(!email || !password) return res.json({ ok:false,error:"missing" });
  try{
    const hash = bcrypt.hashSync(password,10);
    db.prepare("INSERT INTO users(email,pass) VALUES(?,?)")
      .run(email.toLowerCase(),hash);
    res.json({ ok:true });
  }catch{
    res.json({ ok:false,error:"exists" });
  }
});

app.post("/api/login",(req,res)=>{
  const { email,password } = req.body;
  const u = db.prepare("SELECT * FROM users WHERE email=?").get(email.toLowerCase());
  if(!u) return res.json({ ok:false,error:"bad" });
  if(!bcrypt.compareSync(password,u.pass)) return res.json({ ok:false,error:"bad" });
  if(u.disabled) return res.json({ ok:false,error:"banned" });
  res.cookie("uid",u.id,{ httpOnly:false });
  res.json({ ok:true });
});

app.get("/api/logout",(req,res)=>{
  res.clearCookie("uid");
  res.json({ ok:true });
});

app.get("/api/me",(req,res)=>{
  const u = currentUser(req);
  if(!u) return res.json({ ok:false });
  res.json({ ok:true, user:{
    id:u.id, email:u.email, balance:u.balance, avatar:u.avatar
  }});
});

// avatar lista
app.get("/api/avatars",(req,res)=>{
  const imgs = fs.readdirSync("./public").filter(f=>f.startsWith("avatar_"));
  res.json({ ok:true, avatars: imgs.map(a=>"/"+a) });
});
app.post("/api/me/avatar",(req,res)=>{
  const u = requireUser(req,res); if(!u) return;
  const { avatar } = req.body;
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
  const { email, amount } = req.body;
  db.prepare("UPDATE users SET balance=balance+? WHERE email=?")
    .run(amount|0, email.toLowerCase());
  res.json({ ok:true });
});
app.post("/api/admin/disable",(req,res)=>{
  if(req.headers["x-admin-key"]!==ADMIN_KEY) return res.json({ ok:false,error:"key" });
  const { email, flag } = req.body;
  db.prepare("UPDATE users SET disabled=? WHERE email=?").run(flag?1:0,email.toLowerCase());
  res.json({ ok:true });
});

// ---------- CREATE TABLE ----------
app.post("/api/table/create",(req,res)=>{
  const u = requireUser(req,res); if(!u) return;
  let { seats, sb, bb } = req.body;
  seats = Math.max(2,Math.min(9,seats|0));
  sb = sb|0; bb = bb|0;
  if(sb<1 || bb<2 || bb<=sb) return res.json({ ok:false, error:"bad blinds" });

  const info = db.prepare("INSERT INTO tables(seats,sb,bb,created_by,created_at) VALUES(?,?,?,?,datetime('now'))")
    .run(seats,sb,bb,u.id);
  const table_id = info.lastInsertRowid;

  // init game state
  db.prepare("INSERT INTO game_state(table_id,dealer,street,board,pot,acting) VALUES(?,?,?,?,?,?)")
    .run(table_id,0,"preflop","",0,0);

  res.json({ ok:true, table_id });
  broadcastLobby();
});

// ---------- TABLE LIST ----------
app.get("/api/tables",(req,res)=>{
  const t = db.prepare(`
    SELECT t.*,
    (SELECT COUNT(*) FROM seats s WHERE s.table_id=t.id) AS players
    FROM tables t
  `).all();
  res.json({ ok:true, tables:t });
});

// ---------- JOIN TABLE ----------
app.post("/api/table/join",(req,res)=>{
  const u = requireUser(req,res); if(!u) return;
  const { table_id, seat_index, buyin } = req.body;

  const t = db.prepare("SELECT * FROM tables WHERE id=?").get(table_id);
  if(!t) return res.json({ ok:false,error:"missing" });

  if(seat_index<0 || seat_index>=t.seats) return res.json({ ok:false,error:"bad seat" });

  const taken = db.prepare("SELECT * FROM seats WHERE table_id=? AND seat_index=?").get(table_id,seat_index);
  if(taken) return res.json({ ok:false,error:"taken" });

  const b = buyin|0;
  const minBuy = t.bb * 50;
  const maxBuy = t.bb * 200;
  if(b < minBuy || b > maxBuy) return res.json({ ok:false,error:`buyin ${minBuy}-${maxBuy}` });

  if(u.balance < b) return res.json({ ok:false,error:"no chips" });

  db.prepare("UPDATE users SET balance=balance-? WHERE id=?").run(b,u.id);
  db.prepare("INSERT INTO seats(table_id,seat_index,user_id,stack) VALUES(?,?,?,?)")
    .run(table_id,seat_index,u.id,b);

  broadcastLobby();
  broadcastTable(table_id);
  res.json({ ok:true });
});

// ---------- LEAVE ----------
app.post("/api/table/leave",(req,res)=>{
  const u = requireUser(req,res); if(!u) return;
  const { table_id } = req.body;
  const s = db.prepare("SELECT * FROM seats WHERE table_id=? AND user_id=?").get(table_id,u.id);
  if(!s) return res.json({ ok:false });

  db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(s.stack,u.id);
  db.prepare("DELETE FROM seats WHERE table_id=? AND user_id=?").run(table_id,u.id);

  broadcastLobby();
  broadcastTable(table_id);
  res.json({ ok:true });
});

// ---------- SERVE ----------
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

wss.on("connection",(ws,req)=>{
  ws.table_id = null;

  ws.on("message",(m)=>{
    try{
      const data = JSON.parse(m);
      if(data.type==="join-table"){
        ws.table_id = data.table_id;
      }
    }catch{}
  });
});

server.listen(PORT,()=>console.log("✅ Poker server running on",PORT));
