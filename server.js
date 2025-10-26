// ===== PRVI DIO =====
// TEXAS HOLD'EM CASH GAME — FULL SERVER (AUTH + ADMIN + LOBBY + ENGINE)
// =====================================================================
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

// --- CONFIG (Render-friendly) ---
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_KEY = process.env.ADMIN_KEY || "admin123";

// --- DB ---
fs.mkdirSync("./data", { recursive: true });
const db = new Database("./data/poker.db");
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
  PRIMARY KEY(table_id,seat_index)
);
CREATE TABLE IF NOT EXISTS game_state (
  table_id INTEGER PRIMARY KEY,
  dealer INTEGER,      -- indeks sjedala dealera (-1 = waiting)
  street TEXT,         -- waiting|preflop|flop|turn|river|showdown
  board TEXT,          -- "Ah,Kd,7c,2d,Jc"
  pot INTEGER,
  acting INTEGER       -- seat na potezu (-1 ako niko)
);
`);
// ===== DRUGI DIO =====
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

// --- Aliasi za nazive slika (radi razmaka u card_ bach.png) ---
app.get("/card_back.png",(req,res)=>{
  const p = path.join(__dirname,"public","card_ bach.png");
  if(fs.existsSync(p)) return res.sendFile(p);
  return res.sendFile(path.join(__dirname,"public","card_back.png"));
});
app.get("/app.css",(req,res)=>{
  const p = path.join(__dirname,"public","css.app");
  if(fs.existsSync(p)) return res.sendFile(p);
  return res.sendFile(path.join(__dirname,"public","app.css"));
});

// ---------- HELPERS ----------
function currentUser(req){
  if(!req.cookies.uid) return null;
  return db.prepare("SELECT * FROM users WHERE id=?").get(req.cookies.uid);
}
function requireUser(req,res){
  const u = currentUser(req);
  if(!u){ res.json({ ok:false, error:"login" }); return null; }
  if(u.disabled){ res.json({ ok:false, error:"banned" }); return null; }
  return u;
}
const SUITS = ["c","d","h","s"];
const RANKS = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
function newDeck(){
  const d=[];
  for(const r of RANKS) for(const s of SUITS) d.push(r+s);
  for(let i=d.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [d[i],d[j]]=[d[j],d[i]]; }
  return d;
}
function parseBoard(s){ return s? s.split(",").filter(Boolean):[]; }
function boardStr(a){ return (a&&a.length)? a.join(",") : ""; }
// ===== TREĆI DIO =====
// --- In-memory game runtime (po stolu) ---
/* Struktura:
GAME[table_id] = {
  deck: [...], board:[...],
  hole: { seatIndex: [c1,c2], ... },
  dealer, street, acting,
  toAct: [seatIndex,...],
  yetToAct: Set([...]),
  sb_i, bb_i,
  bet: 0,
  minRaise: 0,
  committed: { seatIndex: amount },
  stacks: { seatIndex: stack },
  allin: Set([...]),
  pot: 0
}
*/
const GAME = Object.create(null);

function liveSeats(table_id){
  const rows = db.prepare("SELECT seat_index,user_id,stack FROM seats WHERE table_id=? ORDER BY seat_index ASC").all(table_id);
  return rows.filter(r=>r.user_id);
}
function nextOccupiedIndex(order, from){
  const n = order.length;
  if(n===0) return -1;
  let idx = order.indexOf(from);
  if(idx<0) idx = 0;
  for(let k=1;k<=n;k++){
    const cand = order[(idx+k)%n];
    if(cand!==-1) return cand;
  }
  return -1;
}
function activeOrder(table_id){
  const rows = liveSeats(table_id);
  return rows.map(r=>r.seat_index);
}

function initHand(table){
  // kreiraj novo GAME stanje za stol
  const order = activeOrder(table.id);
  if(order.length < 2) return null;

  const g = GAME[table.id] || (GAME[table.id]={});
  g.deck = newDeck();
  g.board = [];
  g.hole = {};
  g.pot = 0;
  g.allin = new Set();
  g.street = "preflop"; // <<< VAŽNO: memorijska faza odmah postavljena

  // dealer rotacija
  let dealer = (db.prepare("SELECT dealer FROM game_state WHERE table_id=?").get(table.id)?.dealer ?? -1);
  dealer = (dealer+1) % table.seats;
  // odaberi prvog sljedećeg koji je stvarno tu
  if(!order.includes(dealer)){
    const sorted = order.slice().sort((a,b)=>a-b);
    dealer = sorted.find(i=>i>=dealer) ?? sorted[0];
  }
  g.dealer = dealer;
  g.sb_i = order[(order.indexOf(dealer)+1)%order.length];
  g.bb_i = order[(order.indexOf(dealer)+2)%order.length];

  // mirror stacks
  g.stacks = {};
  for(const s of liveSeats(table.id)) g.stacks[s.seat_index] = s.stack|0;

  // auto post SB/BB
  const sbAmt = Math.min(table.sb, g.stacks[g.sb_i]||0);
  const bbAmt = Math.min(table.bb, g.stacks[g.bb_i]||0);
  g.committed = {};
  g.committed[g.sb_i] = sbAmt;
  g.committed[g.bb_i] = bbAmt;
  g.stacks[g.sb_i] -= sbAmt;
  g.stacks[g.bb_i] -= bbAmt;
  if(g.stacks[g.sb_i]===0) g.allin.add(g.sb_i);
  if(g.stacks[g.bb_i]===0) g.allin.add(g.bb_i);

  g.bet = bbAmt;
  g.minRaise = table.bb;

  // podjela hole karata
  for(const i of order){
    const c1 = g.deck.pop(), c2 = g.deck.pop();
    g.hole[i] = [c1,c2];
  }

  // acting red preflop: next nakon BB
  const afterBB = order[(order.indexOf(g.bb_i)+1)%order.length];
  g.toAct = order.slice(order.indexOf(afterBB)).concat(order.slice(0,order.indexOf(afterBB)]);
  g.yetToAct = new Set(g.toAct);

  // persist osnovnog GS
  db.prepare("UPDATE game_state SET dealer=?, street=?, board=?, pot=?, acting=? WHERE table_id=?")
    .run(g.dealer, "preflop", "", 0, afterBB, table.id);

  return g;
}

function roundAllCalledOrAllIn(g){
  for(const i of g.toAct){
    if(g.allin.has(i)) continue;
    const need = (g.bet - (g.committed[i]||0));
    if(need>0 && (g.stacks[i]||0)>0) return false;
  }
  return true;
}

function advanceStreet(table, g){
  if(g.street==="preflop"){
    g.board.push(g.deck.pop(), g.deck.pop(), g.deck.pop());
    g.street = "flop";
  } else if(g.street==="flop"){
    g.board.push(g.deck.pop());
    g.street = "turn";
  } else if(g.street==="turn"){
    g.board.push(g.deck.pop());
    g.street = "river";
  } else {
    g.street = "showdown";
  }

  // reset runde
  g.bet = 0;
  g.minRaise = table.bb;
  g.committed = {};
  g.toAct = activeOrder(table.id);
  if(g.street!=="preflop"){
    const afterDealer = nextOccupiedIndex(g.toAct, g.dealer);
    g.toAct = g.toAct.slice(g.toAct.indexOf(afterDealer))
             .concat(g.toAct.slice(0,g.toAct.indexOf(afterDealer)));
  }
  g.yetToAct = new Set(g.toAct.filter(i=>!g.allin.has(i)));

  // update GS
  db.prepare("UPDATE game_state SET street=?, board=?, pot=?, acting=? WHERE table_id=?")
    .run(g.street, boardStr(g.board), g.pot|0, g.toAct[0] ?? -1, table.id);
}

function pushPotFromCommitted(g){
  const sum = Object.values(g.committed||{}).reduce((a,b)=>a+(b|0),0);
  g.pot += sum;
  g.committed = {};
}

function seatFold(table_id, seat_index){
  const g = GAME[table_id]; if(!g) return;
  g.toAct = g.toAct.filter(i=>i!==seat_index);
  g.yetToAct.delete(seat_index);
  if(g.committed[seat_index]){ g.pot += g.committed[seat_index]; delete g.committed[seat_index]; }
}

function everyoneFoldedExceptOne(g){
  const alive = g.toAct.filter(i=>!g.allin.has(i));
  return alive.length<=1;
}
// ===== ČETVRTI DIO =====
// --- HAND EVALUATOR (7 → 5 best) ---
function rankToVal(r){ return "23456789TJQKA".indexOf(r); }
function isStraight(vals){
  const v = Array.from(new Set(vals)).sort((a,b)=>a-b);
  const wheel = [0,1,2,3,12];
  let best = -1;
  for(let i=0;i<=v.length-5;i++){
    const slice = v.slice(i,i+5);
    if(slice[4]-slice[0]===4){ best = Math.max(best, slice[4]); }
  }
  const hasWheel = wheel.every(x=>v.includes(x));
  if(hasWheel) best = Math.max(best, 3);
  return best;
}
function handScore7(cards7){
  const ranks = cards7.map(c=>rankToVal(c[0])).sort((a,b)=>a-b);
  const suits = cards7.map(c=>c[1]);
  const byRank = {};
  for(const c of cards7){
    const v=rankToVal(c[0]);
    (byRank[v] ||= []).push(c);
  }
  const bySuit = {};
  for(const c of cards7){
    const s = c[1];
    (bySuit[s] ||= []).push(c);
  }
  let flushSuit = null;
  for(const s of SUITS){ if((bySuit[s]?.length||0)>=5){ flushSuit=s; break; } }
  const valsAsc = ranks;
  const straightHigh = isStraight(valsAsc);
  let straightFlushHigh = -1;
  if(flushSuit){
    const valsFlush = bySuit[flushSuit].map(c=>rankToVal(c[0])).sort((a,b)=>a-b);
    const sfh = isStraight(valsFlush);
    if(sfh>=0) straightFlushHigh = sfh;
  }
  const groups = Object.entries(byRank).map(([v,arr])=>({v:parseInt(v,10), n:arr.length})).sort((a,b)=>{
    if(b.n!==a.n) return b.n-a.n;
    return b.v-a.v;
  });
  if(straightFlushHigh>=0) return [8, straightFlushHigh];
  if(groups[0]?.n===4){
    const four=groups[0].v;
    const kick = Math.max(...valsAsc.filter(v=>v!==four));
    return [7, four, kick];
  }
  if(groups[0]?.n===3 && groups[1]?.n>=2){
    const trips=groups[0].v;
    const pair=groups[1].v;
    return [6, trips, pair];
  }
  if(flushSuit){
    const top = bySuit[flushSuit].map(c=>rankToVal(c[0])).sort((a,b)=>b-a).slice(0,5);
    return [5, ...top];
  }
  if(straightHigh>=0) return [4, straightHigh];
  if(groups[0]?.n===3){
    const trips=groups[0].v;
    const kicks = valsAsc.filter(v=>v!==trips).sort((a,b)=>b-a).slice(0,2);
    return [3, trips, ...kicks];
  }
  if(groups[0]?.n===2 && groups[1]?.n===2){
    const hp = Math.max(groups[0].v, groups[1].v);
    const lp = Math.min(groups[0].v, groups[1].v);
    const kick = Math.max(...valsAsc.filter(v=>v!==hp && v!==lp));
    return [2, hp, lp, kick];
  }
  if(groups[0]?.n===2){
    const p = groups[0].v;
    const kicks = valsAsc.filter(v=>v!==p).sort((a,b)=>b-a).slice(0,3);
    return [1, p, ...kicks];
  }
  const highs = valsAsc.slice().sort((a,b)=>b-a).slice(0,5);
  return [0, ...highs];
}
function compareScore(a,b){
  const n=Math.max(a.length,b.length);
  for(let i=0;i<n;i++){
    const aa=a[i]??0, bb=b[i]??0;
    if(aa!==bb) return aa-bb;
  }
  return 0;
}

function showdownAndPayout(table, g){
  const order = activeOrder(table.id);
  const contenders = order.filter(i => (g.hole[i] && ((g.stacks[i]||0)>0 || (g.committed[i]||0)>0 || g.allin.has(i)) ) );
  if(contenders.length===0){ g.pot += Object.values(g.committed||{}).reduce((a,b)=>a+(b|0),0); g.committed={}; return; }
  pushPotFromCommitted(g);
  const board5 = g.board.slice(0,5);
  const scored = [];
  for(const i of contenders){
    const seven = [ ...board5, ...(g.hole[i]||[]) ];
    const score = handScore7(seven);
    scored.push({ i, score });
  }
  scored.sort((A,B)=>compareScore(A.score,B.score));
  const best = scored[scored.length-1].score;
  const winners = scored.filter(x=>compareScore(x.score,best)===0).map(x=>x.i);
  const share = Math.floor((g.pot||0)/winners.length);
  for(const i of winners){ g.stacks[i] = (g.stacks[i]||0) + share; }
  const remainder = (g.pot||0) - share*winners.length;
  if(remainder>0) g.stacks[winners[0]] += remainder;
  g.pot = 0;
  const upd = db.prepare("UPDATE seats SET stack=? WHERE table_id=? AND seat_index=?");
  for(const i of Object.keys(g.stacks)){ upd.run(g.stacks[i|0], table.id, i|0); }
}
// ===== PETI DIO =====
// ---------- AUTH ----------
app.post("/api/register",(req,res)=>{
  const { email,password } = req.body||{};
  if(!email || !password || password.length<6) return res.json({ ok:false,error:"missing" });
  try{
    const hash=bcrypt.hashSync(password,10);
    db.prepare("INSERT INTO users(email,pass) VALUES(?,?)").run(email.toLowerCase(),hash);
    res.json({ ok:true });
  }catch{ res.json({ ok:false,error:"exists" }); }
});
app.post("/api/login",(req,res)=>{
  const { email,password } = req.body||{};
  const u=db.prepare("SELECT * FROM users WHERE email=?").get((email||"").toLowerCase());
  if(!u) return res.json({ ok:false,error:"bad" });
  if(!bcrypt.compareSync(password||"",u.pass)) return res.json({ ok:false,error:"bad" });
  if(u.disabled) return res.json({ ok:false,error:"banned" });
  res.cookie("uid",u.id,{ httpOnly:false, sameSite:"lax" });
  res.json({ ok:true });
});
app.get("/api/logout",(req,res)=>{ res.clearCookie("uid"); res.json({ ok:true }); });
app.get("/api/me",(req,res)=>{
  const u=currentUser(req);
  if(!u) return res.json({ ok:false });
  res.json({ ok:true, user:{ id:u.id, email:u.email, balance:u.balance, avatar:u.avatar }});
});
// Avatari
app.get("/api/avatars",(req,res)=>{
  const list = fs.readdirSync(path.join(__dirname,"public")).filter(f=>/^avatar_\d+\.png$/i.test(f));
  res.json({ ok:true, avatars:list.map(x=>"/"+x) });
});
app.post("/api/me/avatar",(req,res)=>{
  const u=requireUser(req,res); if(!u) return;
  const { avatar } = req.body||{};
  if(!avatar) return res.json({ ok:false,error:"missing" });
  db.prepare("UPDATE users SET avatar=? WHERE id=?").run(avatar,u.id);
  res.json({ ok:true });
});
// ===== ŠESTI DIO =====
// ---------- ADMIN (NE DIRAMO) ----------
app.get("/api/admin/users",(req,res)=>{
  if(req.headers["x-admin-key"]!==ADMIN_KEY) return res.json({ ok:false,error:"key" });
  const rows=db.prepare("SELECT * FROM users ORDER BY id DESC").all();
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
// ===== SEDMI DIO =====
// ---------- TABLES / LOBBY ----------
app.post("/api/table/create",(req,res)=>{
  const u=requireUser(req,res); if(!u) return;
  let { seats,sb,bb } = req.body||{};
  seats=Math.max(2,Math.min(9,seats|0));
  sb=sb|0; bb=bb|0;
  if(sb<1 || bb<2 || bb<=sb) return res.json({ ok:false,error:"bad blinds" });

  const info=db.prepare("INSERT INTO tables(seats,sb,bb,created_by,created_at) VALUES(?,?,?,?,datetime('now'))")
    .run(seats,sb,bb,u.id);
  const table_id=info.lastInsertRowid;
  db.prepare("INSERT INTO game_state(table_id,dealer,street,board,pot,acting) VALUES(?,?,?,?,?,?)")
    .run(table_id,-1,"waiting","",0,-1);
  res.json({ ok:true, table_id });
  broadcastLobby();
});
app.get("/api/tables",(req,res)=>{
  const t=db.prepare(`
    SELECT t.*,(SELECT COUNT(*) FROM seats s WHERE s.table_id=t.id) AS players
    FROM tables t ORDER BY t.id DESC
  `).all();
  res.json({ ok:true, tables:t });
});
app.post("/api/table/join",(req,res)=>{
  const u=requireUser(req,res); if(!u) return;
  const { table_id, seat_index, buyin } = req.body||{};
  const t=db.prepare("SELECT * FROM tables WHERE id=?").get(table_id);
  if(!t) return res.json({ ok:false,error:"missing" });
  if(seat_index<0 || seat_index>=t.seats) return res.json({ ok:false,error:"bad seat" });
  const taken=db.prepare("SELECT 1 FROM seats WHERE table_id=? AND seat_index=?").get(table_id,seat_index);
  if(taken) return res.json({ ok:false,error:"taken" });
  const sit=db.prepare("SELECT 1 FROM seats WHERE table_id=? AND user_id=?").get(table_id,u.id);
  if(sit) return res.json({ ok:false,error:"already" });
  const b=buyin|0, min=t.bb*50, max=t.bb*200;
  if(b<min || b>max) return res.json({ ok:false,error:`buyin ${min}-${max}` });
  if(u.balance<b) return res.json({ ok:false,error:"no chips" });

  db.prepare("UPDATE users SET balance=balance-? WHERE id=?").run(b,u.id);
  db.prepare("INSERT INTO seats(table_id,seat_index,user_id,stack) VALUES(?,?,?,?)").run(table_id,seat_index,u.id,b);

  ensureGameRunning(t.id);
  broadcastLobby(); broadcastTable(t.id);
  res.json({ ok:true });
});
app.post("/api/table/leave",(req,res)=>{
  const u=requireUser(req,res); if(!u) return;
  const { table_id } = req.body||{};
  const s=db.prepare("SELECT * FROM seats WHERE table_id=? AND user_id=?").get(table_id,u.id);
  if(!s) return res.json({ ok:false });
  db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(s.stack,u.id);
  db.prepare("DELETE FROM seats WHERE table_id=? AND user_id=?").run(table_id,u.id);
  broadcastLobby(); broadcastTable(table_id);
  res.json({ ok:true });
});

// ---------- GAME STATE / ACTIONS ----------
app.get("/api/table/state",(req,res)=>{
  const id=(req.query.id|0);
  const t=db.prepare("SELECT * FROM tables WHERE id=?").get(id);
  if(!t) return res.json({ ok:false,error:"missing" });

  const gs=db.prepare("SELECT * FROM game_state WHERE table_id=?").get(id) || { dealer:-1,street:"waiting",board:"",pot:0,acting:-1 };
  const board=parseBoard(gs.board);
  const seats=db.prepare(`
    SELECT s.seat_index,s.user_id,s.stack,u.email,u.avatar
    FROM seats s LEFT JOIN users u ON u.id=s.user_id
    WHERE s.table_id=?
    ORDER BY s.seat_index ASC
  `).all(id);

  const u=currentUser(req);
  let me_seat=-1, my_hole=["??","??"];
  const g = GAME[id] || null;
  if(u){
    const ms=db.prepare("SELECT seat_index FROM seats WHERE table_id=? AND user_id=?").get(id,u.id);
    if(ms){ me_seat=ms.seat_index|0; if(g && g.hole && g.hole[me_seat]) my_hole = g.hole[me_seat]; }
  }

  // izračun call/min raise za action bar
  let min_bet=0, call_amt=0, min_raise=0, can_check=false;
  if(g && gs.street!=="waiting" && me_seat>=0){
    const myComm = g.committed[me_seat]||0;
    call_amt = Math.max(0, (g.bet - myComm));
    can_check = (call_amt===0);
    min_raise = Math.max(g.minRaise, (g.bet||0));
    min_bet = call_amt ? (g.bet + g.minRaise) : Math.max(g.minRaise, (g.bet||0));
  }

  const min_buy = t.bb * 50;
  const max_buy = t.bb * 200;

  res.json({
    ok:true,
    table:{ id:t.id, seats:t.seats, sb:t.sb, bb:t.bb },
    street: gs.street, board, pot:gs.pot|0,
    dealer: gs.dealer|0,
    acting: gs.acting|0,
    sb_i: g ? g.sb_i : -1,
    bb_i: g ? g.bb_i : -1,
    seats: seats.map(x=>({ seat_index:x.seat_index, user_id:x.user_id||null, stack:x.stack|0, email:x.email||null, avatar:x.avatar||null })),
    me_seat, my_hole,
    call_amt, min_bet, min_raise, can_check,
    min_buy, max_buy
  });
});

app.post("/api/table/action",(req,res)=>{
  const u=requireUser(req,res); if(!u) return;
  const { table_id, action, amount } = req.body||{};
  const t=db.prepare("SELECT * FROM tables WHERE id=?").get(table_id);
  if(!t) return res.json({ ok:false,error:"missing" });

  const ms=db.prepare("SELECT seat_index,stack FROM seats WHERE table_id=? AND user_id=?").get(table_id,u.id);
  if(!ms) return res.json({ ok:false,error:"not seated" });

  const gs=db.prepare("SELECT * FROM game_state WHERE table_id=?").get(table_id);
  if(!gs || gs.street==="waiting") return res.json({ ok:false,error:"waiting" });

  const g = GAME[table_id];
  if(!g) return res.json({ ok:false,error:"no game" });
  if(gs.acting!==ms.seat_index) return res.json({ ok:false,error:"not your turn" });

  const seat = ms.seat_index;
  g.stacks[seat] = db.prepare("SELECT stack FROM seats WHERE table_id=? AND seat_index=?").get(table_id,seat).stack|0;

  const nextAct = ()=> {
    g.yetToAct.delete(seat);
    const idx = g.toAct.indexOf(seat);
    let next = -1;
    for(let k=1;k<=g.toAct.length;k++){
      const cand = g.toAct[(idx+k)%g.toAct.length];
      if(g.allin.has(cand)) continue;
      next = cand; break;
    }
    if(next===-1) next = seat;
    db.prepare("UPDATE game_state SET acting=? WHERE table_id=?").run(next, table_id);
  };

  // CALL/CHECK/BET/RAISE/FOLD
  if(action==="fold"){
    seatFold(table_id, seat);
    if(everyoneFoldedExceptOne(g)){
      pushPotFromCommitted(g);
      g.street="showdown";
      showdownAndPayout(t,g);
      db.prepare("UPDATE game_state SET street=?, board=?, pot=?, acting=? WHERE table_id=?")
        .run("waiting","",0,-1,table_id);
      delete GAME[table_id];
      res.json({ ok:true }); broadcastTable(table_id); return;
    }
    nextAct();
    res.json({ ok:true }); broadcastTable(table_id); return;
  }

  const myComm = g.committed[seat]||0;
  const needCall = Math.max(0, g.bet - myComm);

  if(action==="check"){
    if(needCall>0) return res.json({ ok:false,error:"cannot check" });
    nextAct();
    if(roundAllCalledOrAllIn(g)){
      pushPotFromCommitted(g);
      const gs2=db.prepare("SELECT * FROM game_state WHERE table_id=?").get(table_id);
      const board=parseBoard(gs2.board);
      g.board = board.length? board : g.board;
      g.street = gs2.street; // sync prije advance
      advanceStreet(t,g);
      if(g.street==="showdown"){
        showdownAndPayout(t,g);
        db.prepare("UPDATE game_state SET street=?, board=?, pot=?, acting=? WHERE table_id=?")
          .run("waiting","",0,-1,table_id);
        delete GAME[table_id];
      }
    }
    res.json({ ok:true }); broadcastTable(table_id); return;
  }

  if(action==="call"){
    let pay = Math.min(needCall, g.stacks[seat]||0);
    g.stacks[seat]-=pay;
    g.committed[seat]=(g.committed[seat]||0)+pay;
    if(g.stacks[seat]===0) g.allin.add(seat);
    nextAct();
    if(roundAllCalledOrAllIn(g)){
      pushPotFromCommitted(g);
      const gs2=db.prepare("SELECT * FROM game_state WHERE table_id=?").get(table_id);
      g.board = parseBoard(gs2.board);
      g.street = gs2.street; // <<< DODANO: osiguraj tačan street
      advanceStreet(t,g);
      if(g.street==="showdown"){
        showdownAndPayout(t,g);
        db.prepare("UPDATE game_state SET street=?, board=?, pot=?, acting=? WHERE table_id=?")
          .run("waiting","",0,-1,table_id);
        delete GAME[table_id];
      }
    }
    res.json({ ok:true }); broadcastTable(table_id); return;
  }

  if(action==="bet" || action==="raise"){
    const reqAmt = Math.max(0, amount|0);
    const currentBet = g.bet|0;
    const baseMinRaise = Math.max(g.minRaise|0, t.bb|0);

    let targetBet;
    if(action==="bet"){
      if(reqAmt < t.bb) return res.json({ ok:false, error:`min bet ${t.bb}` });
      targetBet = reqAmt;                 // bet je direktno ciljani bet
      g.minRaise = Math.max(baseMinRaise, t.bb);
    }else{ // raise
      const raiseSize = Math.max(reqAmt, baseMinRaise);
      targetBet = currentBet + raiseSize;
      g.minRaise = raiseSize;             // minRaise = veličina zadnjeg raise-a
    }

    const toPutRaw = Math.max(0, targetBet - myComm);
    let toPut = Math.min(toPutRaw, g.stacks[seat]||0); // all-in dozvoljen
    if(toPut<=0) return res.json({ ok:false, error:"no chips" });

    g.stacks[seat]-=toPut;
    g.committed[seat]=(g.committed[seat]||0)+toPut;
    if(g.stacks[seat]===0) g.allin.add(seat);

    g.bet = Math.max(g.bet|0, g.committed[seat]|0);

    // svi ostali opet imaju pravo igrati (osim all-in)
    g.yetToAct = new Set(g.toAct.filter(i=>i!==seat && !g.allin.has(i)));

    nextAct();
    res.json({ ok:true }); broadcastTable(table_id); return;
  }

  return res.json({ ok:false,error:"unknown action" });
});

// TOP-UP (Dodaj čipove) — cap 200×BB total stack
app.post("/api/table/topup",(req,res)=>{
  const u = requireUser(req,res); if(!u) return;
  const { table_id, amount } = req.body||{};
  const t = db.prepare("SELECT * FROM tables WHERE id=?").get(table_id);
  if(!t) return res.json({ ok:false, error:"missing" });

  const s = db.prepare("SELECT * FROM seats WHERE table_id=? AND user_id=?").get(table_id,u.id);
  if(!s) return res.json({ ok:false, error:"not seated" });

  const want = Math.max(0, amount|0);
  if(want<=0) return res.json({ ok:false, error:"bad amount" });

  const cap = t.bb * 200;             // max total stack
  const current = s.stack|0;
  if(current >= cap) return res.json({ ok:false, error:"at cap" });

  const allowed = Math.max(0, cap - current);
  const add = Math.min(want, allowed);
  if(add<=0) return res.json({ ok:false, error:"bad amount" });

  // provjeri balance
  const freshU = db.prepare("SELECT balance FROM users WHERE id=?").get(u.id);
  if(!freshU || (freshU.balance|0) < add) return res.json({ ok:false, error:"no chips" });

  // skidanje s user balansa i dodavanje na stack
  db.prepare("UPDATE users SET balance=balance-? WHERE id=?").run(add, u.id);
  db.prepare("UPDATE seats SET stack=stack+? WHERE table_id=? AND user_id=?").run(add, table_id, u.id);

  broadcastTable(table_id);
  res.json({ ok:true });
});

// Auto start hand kad je stol spreman
function ensureGameRunning(table_id){
  const t=db.prepare("SELECT * FROM tables WHERE id=?").get(table_id);
  if(!t) return;
  const gs=db.prepare("SELECT * FROM game_state WHERE table_id=?").get(table_id);
  const players = liveSeats(table_id);
  if(players.length<2) return;

  if(!gs || gs.street==="waiting"){
    const g = initHand(t);
    if(!g) return;
    db.prepare("UPDATE game_state SET pot=?, acting=? WHERE table_id=?")
      .run(g.pot|0, g.toAct[0] ?? -1, table_id);
  }
}
// ===== OSMI DIO =====
// ---------- PAGES ----------
app.get("/", (req, res) => {
  const idx = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(idx)) return res.sendFile(idx);

  // Fallback da root UVIJEK radi i kad index.html fali ili je krivo imenovan
  res
    .status(200)
    .type("html")
    .send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Poker Lobby</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body style="background:#0b1220;color:#e5e7eb;font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif">
  <div style="max-width:760px;margin:40px auto;padding:16px">
    <h1 style="margin:0 0 12px">Poker server je online ✅</h1>
    <p>Frontend <code>/public/index.html</code> nije pronađen. Ali server radi. Brzi linkovi:</p>
    <ul>
      <li><a href="/healthz">/healthz</a> — health</li>
      <li><a href="/health">/health</a> — health JSON</li>
      <li><a href="/admin">/admin</a></li>
      <li><a href="/table">/table</a></li>
      <li><a href="/api/tables">/api/tables</a></li>
    </ul>
  </div>
</body>
</html>`);
});

app.get("/table", (req, res) => {
  const p = path.join(__dirname, "public", "table.html");
  if (fs.existsSync(p)) return res.sendFile(p);
  res.status(404).send("table.html not found in /public");
});

app.get("/admin", (req, res) => {
  const p = path.join(__dirname, "public", "admin.html");
  if (fs.existsSync(p)) return res.sendFile(p);
  res.status(404).send("admin.html not found in /public");
});

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
  const data=JSON.stringify({type:"lobby"});
  wss.clients.forEach(c=>c.readyState===1 && c.send(data));
}
function broadcastTable(table_id){
  roomBroadcast(table_id,{type:"update"});
}
wss.on("connection",(ws)=>{
  ws.table_id=null;
  ws.on("message",(m)=>{
    try{
      const d=JSON.parse(m);
      if(d.type==="join-table") ws.table_id=d.table_id|0;
    }catch{}
  });
});

// --- Health check (Render) ---
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/health",  (_req, res) => res.json({ ok:true, ts: Date.now() }));

// --- Start server ---
server.listen(PORT, HOST, () => {
  console.log(`✅ Poker server running at http://${HOST}:${PORT}`);
});
