const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { WebSocketServer } = require("ws");
const { parse: parseCookie } = require("cookie");

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const ENV = process.env.NODE_ENV || "development";
const IS_PROD = ENV === "production";

const JWT_SECRET = process.env.JWT_SECRET || "change-this-in-prod";
const TOKEN_NAME = "token";
const ADMIN_KEY = process.env.ADMIN_KEY || "set-admin-key";

const TURN_TIMER_S = parseInt(process.env.TURN_TIMER_S || "15", 10);
const TIMEBANK_S = parseInt(process.env.TIMEBANK_S || "90", 10);
const DEFAULT_RAKE_PCT = parseInt(process.env.RAKE_PCT || "1", 10);
const DEFAULT_RAKE_CAP_S = parseInt(process.env.RAKE_CAP_S || "300", 10);

const ROOT = __dirname;
const PUB = path.join(ROOT, "public");
const IMG_ROOT = PUB;

const DB_FILE = process.env.DB_PATH || path.join(ROOT, "data", "poker.db");
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.mkdirSync(PUB, { recursive: true });

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use(express.static(PUB));

app.get("/", (_req, res) => {
  const idx = path.join(PUB, "index.html");
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.type("text").send("Poker server ready. Put your /public files.");
});

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");

const nowISO = () => new Date().toISOString();
const isEmail = (x)=> typeof x==="string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
const isPass  = (x)=> typeof x==="string" && x.length>=6;
const sToG = s => Math.floor((s|0)/100);
const gToS = g => (g|0)*100;

function signToken(u){ return jwt.sign({ uid:u.id, email:u.email }, JWT_SECRET, { expiresIn:"7d" }); }
function readToken(req){
  const t = req.cookies && req.cookies[TOKEN_NAME];
  if(!t) return null;
  try{ return jwt.verify(t, JWT_SECRET); }catch{ return null; }
}
function requireAuth(req){
  const tok = readToken(req);
  if (!tok) throw new Error("Not logged in");
  const u = db.prepare("SELECT id,is_disabled FROM users WHERE id=?").get(tok.uid);
  if (!u || u.is_disabled) throw new Error("Account disabled");
  return tok.uid;
}
function requireAdminKey(req, res, next){
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ ok:false, error:"Admin key required" });
  next();
}

function ensure(sql){ db.exec(sql); }
ensure(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_disabled INTEGER NOT NULL DEFAULT 0,
  balance_silver INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT
);`);
ensure(`
CREATE TABLE IF NOT EXISTS poker_tables(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  seats INTEGER NOT NULL CHECK(seats IN (6,9)),
  sb_s INTEGER NOT NULL,
  bb_s INTEGER NOT NULL,
  min_buyin_bb INTEGER NOT NULL,
  max_buyin_bb INTEGER NOT NULL,
  turn_timer_s INTEGER NOT NULL DEFAULT ${TURN_TIMER_S},
  timebank_s INTEGER NOT NULL DEFAULT ${TIMEBANK_S},
  rake_pct INTEGER NOT NULL DEFAULT ${DEFAULT_RAKE_PCT},
  rake_cap_s INTEGER NOT NULL DEFAULT ${DEFAULT_RAKE_CAP_S},
  status TEXT NOT NULL DEFAULT 'waiting',
  btn_pos INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);`);
ensure(`
CREATE TABLE IF NOT EXISTS poker_seats(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER NOT NULL,
  seat_index INTEGER NOT NULL,
  user_id INTEGER,
  stack_s INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'empty',
  in_hand INTEGER NOT NULL DEFAULT 0,
  last_action TEXT,
  UNIQUE(table_id, seat_index)
);`);
ensure(`
CREATE TABLE IF NOT EXISTS hands(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER NOT NULL,
  hand_no INTEGER NOT NULL,
  btn_seat INTEGER NOT NULL,
  sb_seat INTEGER NOT NULL,
  bb_seat INTEGER NOT NULL,
  state TEXT NOT NULL,
  deck_json TEXT,
  board TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(table_id, hand_no)
);`);
ensure(`
CREATE TABLE IF NOT EXISTS hand_actions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hand_id INTEGER NOT NULL,
  seat_index INTEGER NOT NULL,
  street TEXT NOT NULL,
  action TEXT NOT NULL,
  amount_s INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);`);
ensure(`
CREATE TABLE IF NOT EXISTS pots(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hand_id INTEGER NOT NULL,
  pot_index INTEGER NOT NULL,
  amount_s INTEGER NOT NULL DEFAULT 0
);`);
ensure(`
CREATE TABLE IF NOT EXISTS payouts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hand_id INTEGER NOT NULL,
  pot_index INTEGER NOT NULL,
  seat_index INTEGER NOT NULL,
  amount_s INTEGER NOT NULL,
  reason TEXT NOT NULL
);`);
ensure(`
CREATE TABLE IF NOT EXISTS poker_buyins(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  amount_s INTEGER NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL
);`);
ensure(`
CREATE TABLE IF NOT EXISTS admin_bonus_codes(
  slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 1 AND 5),
  code TEXT NOT NULL DEFAULT '',
  percent INTEGER NOT NULL DEFAULT 0,
  total_credited_silver INTEGER NOT NULL DEFAULT 0
);`);
ensure(`
CREATE TABLE IF NOT EXISTS admin_meta(
  key TEXT PRIMARY KEY,
  val TEXT NOT NULL
);`);
ensure(`
CREATE TABLE IF NOT EXISTS user_items(
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  tier INTEGER NOT NULL DEFAULT 1,
  qty INTEGER NOT NULL DEFAULT 1
);`);
ensure(`
CREATE TABLE IF NOT EXISTS user_recipes(
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  tier INTEGER NOT NULL DEFAULT 1,
  qty INTEGER NOT NULL DEFAULT 1
);`);

(function seedTable(){
  const any = db.prepare("SELECT id FROM poker_tables LIMIT 1").get();
  if (!any){
    db.prepare(`
      INSERT INTO poker_tables(name,seats,sb_s,bb_s,min_buyin_bb,max_buyin_bb,turn_timer_s,timebank_s,rake_pct,rake_cap_s,status,btn_pos,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run("Main 1/2", 9, 100, 200, 50, 100, TURN_TIMER_S, TIMEBANK_S, DEFAULT_RAKE_PCT, DEFAULT_RAKE_CAP_S, "waiting", 0, nowISO());
    const t = db.prepare("SELECT id,seats FROM poker_tables").get();
    for (let i=0;i<t.seats;i++){
      db.prepare("INSERT INTO poker_seats(table_id,seat_index,state) VALUES (?,?, 'empty')").run(t.id, i);
    }
  }
})();

function deleteZeroPrefixedImages(dir) {
  try{
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries){
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()){
        deleteZeroPrefixedImages(full);
      } else {
        const lower = ent.name.toLowerCase();
        const isImage = /\.(png|jpg|jpeg|webp|gif|svg)$/.test(lower);
        if (isImage && ent.name.startsWith("0")) {
          try{ fs.unlinkSync(full); }catch{}
        }
      }
    }
  }catch{}
}
deleteZeroPrefixedImages(IMG_ROOT);

const SUITS = ["S","H","D","C"];
const RANKS = ["A","K","Q","J","T","9","8","7","6","5","4","3","2"];
const RVAL = Object.fromEntries(RANKS.map((r,i)=>[r, 14 - i]));
function deck52(){ const d=[]; for (const s of SUITS) for (const r of RANKS) d.push(r+s); return d; }
function shuffle(a){ for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function* combos5(arr){ const n=arr.length; for(let a=0;a<n-4;a++)for(let b=a+1;b<n-3;b++)for(let c=b+1;c<n-2;c++)for(let d=c+1;d<n-1;d++)for(let e=d+1;e<n;e++)yield [arr[a],arr[b],arr[c],arr[d],arr[e]]; }
function handRank5(cards){
  const r=cards.map(c=>c[0]); const s=cards.map(c=>c[1]);
  const rv=r.map(x=>RVAL[x]).sort((a,b)=>b-a);
  const counts={}; r.forEach(x=>counts[x]=(counts[x]||0)+1);
  const groups=Object.entries(counts).map(([rank,c])=>({rank:RVAL[rank],c}));
  groups.sort((a,b)=> b.c===a.c ? b.rank-a.rank : b.c-a.c);
  const flush = SUITS.some(S=>s.filter(x=>x===S).length===5);
  const uniq = Array.from(new Set(rv));
  const isWheel = JSON.stringify(uniq) === JSON.stringify([14,5,4,3,2]);
  let straightHigh = 0;
  if (uniq.length===5 && (rv[0]-rv[4]===4 || isWheel)) straightHigh = isWheel ? 5 : rv[0];
  if (flush && straightHigh){ if (straightHigh===14) return [9]; return [8, straightHigh]; }
  if (groups[0].c===4){ const four=groups[0].rank, kicker=groups[1].rank; return [7, four, kicker]; }
  if (groups[0].c===3 && groups[1].c===2){ return [6, groups[0].rank, groups[1].rank]; }
  if (flush){ return [5, ...rv]; }
  if (straightHigh){ return [4, straightHigh]; }
  if (groups[0].c===3){ const kick=groups.slice(1).map(g=>g.rank).sort((a,b)=>b-a); return [3, groups[0].rank, ...kick]; }
  if (groups[0].c===2 && groups[1].c===2){ const pairHi=Math.max(groups[0].rank,groups[1].rank); const pairLo=Math.min(groups[0].rank,groups[1].rank); const kicker=groups[2].rank; return [2, pairHi, pairLo, kicker]; }
  if (groups[0].c===2){ const kick=groups.slice(1).map(g=>g.rank).sort((a,b)=>b-a); return [1, groups[0].rank, ...kick]; }
  return [0, ...rv];
}
function cmpRank(a,b){ const L=Math.max(a.length,b.length); for(let i=0;i<L;i++){ const va=a[i]??0, vb=b[i]??0; if (va>vb) return 1; if (va<vb) return -1; } return 0; }
function best5of7(seven){ let best=null; for (const five of combos5(seven)){ const rank=handRank5(five); if (!best || cmpRank(rank,best)>0){ best=rank; } } return { rank:best }; }

const RT = new Map();

function tableRow(tableId){ return db.prepare("SELECT * FROM poker_tables WHERE id=?").get(tableId); }
function tableSeats(tableId){ return db.prepare("SELECT * FROM poker_seats WHERE table_id=? ORDER BY seat_index").all(tableId); }
function activePlayers(tableId){ return db.prepare("SELECT seat_index,stack_s,user_id,state FROM poker_seats WHERE table_id=? AND user_id IS NOT NULL AND state='occupied' AND stack_s>0").all(tableId); }
function writeSeat(seat){ db.prepare("UPDATE poker_seats SET user_id=?, stack_s=?, state=?, in_hand=?, last_action=? WHERE id=?").run(seat.user_id, seat.stack_s, seat.state, seat.in_hand, seat.last_action, seat.id); }
function nextOccupiedIndex(list, start, seatsCount){ if (!list.length) return -1; for (let k=1;k<=seatsCount;k++){ const idx=(start+k)%seatsCount; if (list.some(s=>s.seat_index===idx)) return idx; } return -1; }

function wsBroadcast(type, data){
  for (const ws of wss.clients){ if (ws.readyState===ws.OPEN){ ws.send(JSON.stringify({ type, ...data })); } }
}
function send(ws, type, data){ if (ws.readyState===ws.OPEN) ws.send(JSON.stringify({ type, ...data })); }

function sendTableState(tableId){
  const t = tableRow(tableId);
  const seats = db.prepare("SELECT seat_index,user_id,stack_s,state,in_hand,last_action FROM poker_seats WHERE table_id=? ORDER BY seat_index").all(tableId);
  wsBroadcast("table_state", { table_id: tableId, table: t, seats });
  const lobby = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM poker_seats s WHERE s.table_id=t.id AND s.user_id IS NOT NULL) AS players
    FROM poker_tables t ORDER BY t.id ASC
  `).all();
  wsBroadcast("lobby_update", { tables: lobby });
}

function setActing(tableId, seatIndex){
  const t = tableRow(tableId);
  const rt = RT.get(tableId); if (!rt) return;
  rt.toAct = seatIndex;
  const until = Date.now() + (t.turn_timer_s*1000);
  rt.timers.deadline = until;
  if (rt.timers.handle) clearTimeout(rt.timers.handle);
  rt.timers.handle = setTimeout(()=> onTimeout(tableId), t.turn_timer_s*1000);
  wsBroadcast("action_required", { table_id: tableId, seat_index: seatIndex, ms_left: t.turn_timer_s*1000 });
}

function startIfCan(tableId){
  const t = tableRow(tableId);
  const occ = activePlayers(tableId);
  if (occ.length<2) return;
  const seatsCount = t.seats|0;

  let btn = t.btn_pos|0;
  let sb = nextOccupiedIndex(occ, btn, seatsCount); if (sb<0) return;
  let bb = nextOccupiedIndex(occ, sb, seatsCount); if (bb<0) return;

  const deck = shuffle(deck52());
  const handNo = (db.prepare("SELECT COALESCE(MAX(hand_no),0)+1 AS n FROM hands WHERE table_id=?").get(tableId).n)|0;

  const seats = tableSeats(tableId);
  for (const s of seats){
    if (s.user_id && s.state==="occupied" && s.stack_s>0){ s.in_hand=1; writeSeat(s); }
    else { s.in_hand=0; writeSeat(s); }
  }

  const sbSeat = db.prepare("SELECT * FROM poker_seats WHERE table_id=? AND seat_index=?").get(tableId, sb);
  const bbSeat = db.prepare("SELECT * FROM poker_seats WHERE table_id=? AND seat_index=?").get(tableId, bb);
  const toSB = Math.min(sbSeat.stack_s, t.sb_s);
  const toBB = Math.min(bbSeat.stack_s, t.bb_s);
  db.prepare("UPDATE poker_seats SET stack_s=stack_s-? WHERE id=?").run(toSB, sbSeat.id);
  db.prepare("UPDATE poker_seats SET stack_s=stack_s-? WHERE id=?").run(toBB, bbSeat.id);

  const handId = db.prepare(`
    INSERT INTO hands(table_id,hand_no,btn_seat,sb_seat,bb_seat,state,deck_json,board,started_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(tableId, handNo, btn, sb, bb, "preflop", JSON.stringify(deck), "", nowISO()).lastInsertRowid;

  db.prepare(`INSERT INTO hand_actions(hand_id,seat_index,street,action,amount_s,at) VALUES (?,?,?,?,?,?)`)
    .run(handId, sb, "preflop", "post_sb", toSB, nowISO());
  db.prepare(`INSERT INTO hand_actions(hand_id,seat_index,street,action,amount_s,at) VALUES (?,?,?,?,?,?)`)
    .run(handId, bb, "preflop", "post_bb", toBB, nowISO());

  RT.set(tableId, {
    tableId, handId, state: "preflop", deck, board: [],
    pots: [], toAct: null, minRaise: t.bb_s, currentBet: t.bb_s,
    streetBets: new Map(), acted: new Set(),
    timers: { deadline: 0, handle: null, timebank: new Map() }
  });

  db.prepare("UPDATE poker_tables SET btn_pos=? WHERE id=?").run(bb, tableId);

  const first = nextOccupiedIndex(occ, bb, seatsCount);
  setActing(tableId, first);
  sendTableState(tableId);
}

function onTimeout(tableId){
  const rt = RT.get(tableId); if (!rt) return;
  const t = tableRow(tableId);
  const seat = db.prepare("SELECT * FROM poker_seats WHERE table_id=? AND seat_index=?").get(tableId, rt.toAct);
  const left = (rt.timers.timebank.get(seat.user_id)||t.timebank_s);
  if (left>0){
    const spend = Math.min(left, t.turn_timer_s);
    rt.timers.timebank.set(seat.user_id, left - spend);
    rt.timers.handle = setTimeout(()=> onTimeout(tableId), spend*1000);
    wsBroadcast("action_required", { table_id: tableId, seat_index: seat.seat_index, ms_left: spend*1000, timebank_left_s: left-spend });
    return;
  }
  const need = (rt.currentBet - (rt.streetBets.get(seat.seat_index)||0))|0;
  if (need<=0) applyAction(tableId, seat.seat_index, "check", 0, true);
  else applyAction(tableId, seat.seat_index, "fold", 0, true);
}

function calcPots(tableId){
  const rt = RT.get(tableId); if (!rt) return [];
  const contrib = new Map();
  const rows = db.prepare("SELECT seat_index,amount_s FROM hand_actions WHERE hand_id=? AND action IN ('post_sb','post_bb','bet','call','raise','allin')").all(rt.handId);
  rows.forEach(r=> contrib.set(r.seat_index, (contrib.get(r.seat_index)||0) + (r.amount_s|0)));
  const entries = Array.from(contrib.entries()).filter(([_,v])=>v>0).sort((a,b)=>a[1]-b[1]);
  const pots=[]; let prev=0;
  for (let i=0;i<entries.length;i++){
    const level = entries[i][1];
    const eligible = entries.slice(i).map(e=>e[0]);
    const size = (level - prev) * eligible.length;
    if (size>0) pots.push({ amount_s: size, eligible });
    prev = level;
  }
  rt.pots = pots;
  return pots;
}
function allFoldExceptOne(tableId){
  const alive = db.prepare("SELECT seat_index FROM poker_seats WHERE table_id=? AND in_hand=1").all(tableId);
  return alive.length===1 ? alive[0].seat_index : -1;
}
function dealBoard(tableId, count){
  const rt = RT.get(tableId); if (!rt) return;
  for(let i=0;i<count;i++){ const card = rt.deck.pop(); rt.board.push(card); }
  db.prepare("UPDATE hands SET board=? WHERE id=?").run(rt.board.join(","), rt.handId);
  wsBroadcast("board_update", { table_id: tableId, board: rt.board });
}
function advanceStreet(tableId){
  const rt = RT.get(tableId); if (!rt) return;
  const t = tableRow(tableId);
  rt.acted.clear(); rt.streetBets = new Map(); rt.currentBet = 0; rt.minRaise = t.bb_s;
  if (rt.state==="preflop"){ rt.state="flop"; dealBoard(tableId,3); }
  else if (rt.state==="flop"){ rt.state="turn"; dealBoard(tableId,1); }
  else if (rt.state==="turn"){ rt.state="river"; dealBoard(tableId,1); }
  else { rt.state="showdown"; return showdown(tableId); }
  db.prepare("UPDATE hands SET state=? WHERE id=?").run(rt.state, rt.handId);
  const btn = db.prepare("SELECT btn_seat FROM hands WHERE id=?").get(rt.handId).btn_seat|0;
  const occ = activePlayers(tableId);
  const next = nextOccupiedIndex(occ, btn, t.seats);
  setActing(tableId, next);
  sendTableState(tableId);
}
function streetComplete(tableId){
  const rt = RT.get(tableId); if (!rt) return false;
  const t = tableRow(tableId);
  const occ = activePlayers(tableId).map(s=>s.seat_index);
  const needers = occ.filter(si => (rt.streetBets.get(si)||0) < rt.currentBet);
  const alive = db.prepare("SELECT COUNT(*) AS c FROM poker_seats WHERE table_id=? AND in_hand=1").get(tableId).c|0;
  return (needers.length===0) || (alive<=1);
}
function showdown(tableId){
  const rt = RT.get(tableId); if (!rt) return;
  const t = tableRow(tableId);
  const pots = calcPots(tableId);
  const board = rt.board.slice();

  const holeBySeat = {};
  const dealRows = db.prepare("SELECT seat_index, action FROM hand_actions WHERE hand_id=? AND action LIKE 'deal:%'").all(rt.handId);
  if (dealRows.length===0){
    const seats = db.prepare("SELECT seat_index FROM poker_seats WHERE table_id=? AND in_hand=1 ORDER BY seat_index").all(tableId);
    for (const s of seats){
      const a = rt.deck.pop(), b = rt.deck.pop();
      const act = `deal:${a},${b}`;
      db.prepare("INSERT INTO hand_actions(hand_id,seat_index,street,action,amount_s,at) VALUES (?,?,?,?,?,?)")
        .run(rt.handId, s.seat_index, "preflop", act, 0, nowISO());
      holeBySeat[s.seat_index]=[a,b];
    }
  } else {
    for (const r of dealRows){ const parts = r.action.slice(5).split(","); holeBySeat[r.seat_index]=parts; }
  }

  const results=[];
  for (let p=0;p<pots.length;p++){
    const pot=pots[p];
    let bestRank=null, winners=[];
    for (const si of pot.eligible){
      const alive = db.prepare("SELECT in_hand FROM poker_seats WHERE table_id=? AND seat_index=?").get(tableId, si);
      if (!alive || !alive.in_hand) continue;
      const seven = (holeBySeat[si]||[]).concat(board);
      const { rank } = best5of7(seven);
      if (!bestRank || cmpRank(rank,bestRank)>0){ bestRank = rank; winners = [si]; }
      else if (cmpRank(rank,bestRank)===0){ winners.push(si); }
    }
    if (winners.length===0) continue;
    const share = Math.floor(pot.amount_s / winners.length);
    for (const si of winners){
      db.prepare("INSERT INTO payouts(hand_id,pot_index,seat_index,amount_s,reason) VALUES (?,?,?,?,?)")
        .run(rt.handId, p, si, share, winners.length>1?"split":"win");
      db.prepare("UPDATE poker_seats SET stack_s=stack_s+? WHERE table_id=? AND seat_index=?").run(share, tableId, si);
      results.push({ pot:p, seat_index: si, amount_s: share });
    }
  }

  const totalPot = pots.reduce((a,b)=>a+(b.amount_s|0),0);
  const rake = Math.min(Math.floor(totalPot * (t.rake_pct/100)), t.rake_cap_s|0);
  if (rake>0 && results[0]){
    db.prepare("UPDATE poker_seats SET stack_s=stack_s-? WHERE table_id=? AND seat_index=?").run(rake, tableId, results[0].seat_index);
    db.prepare("INSERT INTO payouts(hand_id,pot_index,seat_index,amount_s,reason) VALUES (?,?,?,?,?)")
      .run(rt.handId, 0, results[0].seat_index, -rake, "rake");
  }

  db.prepare("UPDATE hands SET state=?, ended_at=?").run("paid", nowISO());
  wsBroadcast("showdown", { table_id: tableId, board, results });
  sendTableState(tableId);

  setTimeout(()=> {
    const seats = tableSeats(tableId);
    for (const s of seats){ s.in_hand=0; writeSeat(s); }
    RT.delete(tableId);
    startIfCan(tableId);
  }, 1500);
}
function advanceToNextActor(tableId){
  const rt = RT.get(tableId); if (!rt) return;
  const t = tableRow(tableId);
  const occ = activePlayers(tableId);
  const only = allFoldExceptOne(tableId);
  if (only>=0){
    calcPots(tableId);
    const total = rt.pots.reduce((a,b)=>a+(b.amount_s|0),0);
    db.prepare("UPDATE poker_seats SET stack_s=stack_s+? WHERE table_id=? AND seat_index=?").run(total, tableId, only);
    db.prepare("INSERT INTO payouts(hand_id,pot_index,seat_index,amount_s,reason) VALUES (?,?,?,?,?)").run(rt.handId, 0, only, total, "win");
    db.prepare("UPDATE hands SET state=?, ended_at=?").run("paid", nowISO());
    wsBroadcast("payouts", { table_id: tableId, payouts:[{seat_index:only,amount_s:total}] });
    sendTableState(tableId);
    setTimeout(()=>{ RT.delete(tableId); startIfCan(tableId); }, 1000);
    return;
  }
  if (streetComplete(tableId)) return advanceStreet(tableId);
  const seatsCount = t.seats|0;
  const cur = rt.toAct|0;
  const next = nextOccupiedIndex(occ, cur, seatsCount);
  setActing(tableId, next);
}
function applyAction(tableId, seatIndex, action, amountS, auto=false){
  const rt = RT.get(tableId); if (!rt) return { ok:false, error:"No active hand" };
  const t = tableRow(tableId);
  const seat = db.prepare("SELECT * FROM poker_seats WHERE table_id=? AND seat_index=?").get(tableId, seatIndex);
  if (!seat || !seat.in_hand) return { ok:false, error:"Not in hand" };
  if (rt.toAct!==seatIndex) return { ok:false, error:"Not your turn" };

  const placed = (rt.streetBets.get(seatIndex)||0);
  const need = Math.max(0, rt.currentBet - placed);

  if (action==="fold"){
    db.prepare("UPDATE poker_seats SET in_hand=0 WHERE id=?").run(seat.id);
    db.prepare("INSERT INTO hand_actions(hand_id,seat_index,street,action,amount_s,at) VALUES (?,?,?,?,?,?)").run(rt.handId, seatIndex, rt.state, "fold", 0, nowISO());
    wsBroadcast("player_action", { table_id: tableId, seat_index, action:"fold", auto });
    return advanceToNextActor(tableId);
  }
  if (action==="check"){
    if (need>0) return { ok:false, error:"Cannot check" };
    db.prepare("INSERT INTO hand_actions(hand_id,seat_index,street,action,amount_s,at) VALUES (?,?,?,?,?,?)").run(rt.handId, seatIndex, rt.state, "check", 0, nowISO());
    wsBroadcast("player_action", { table_id: tableId, seat_index, action:"check", auto });
    return advanceToNextActor(tableId);
  }
  if (action==="call"){
    if (need<=0) return { ok:false, error:"Nothing to call" };
    const toPut = Math.min(need, seat.stack_s);
    db.prepare("UPDATE poker_seats SET stack_s=stack_s-? WHERE id=?").run(toPut, seat.id);
    db.prepare("INSERT INTO hand_actions(hand_id,seat_index,street,action,amount_s,at) VALUES (?,?,?,?,?,?)").run(rt.handId, seatIndex, rt.state, toPut===seat.stack_s?"allin":"call", toPut, nowISO());
    rt.streetBets.set(seatIndex, placed + toPut);
    wsBroadcast("player_action", { table_id: tableId, seat_index, action: toPut===seat.stack_s?"allin":"call", amount_s: toPut, auto });
    return advanceToNextActor(tableId);
  }
  if (action==="bet" || action==="raise" || action==="allin"){
    let toPut = Math.max(0, amountS|0);
    if (toPut<=0) return { ok:false, error:"Bad amount" };
    if (toPut > seat.stack_s) toPut = seat.stack_s;
    const newPlaced = placed + toPut;
    const wasBet = rt.currentBet|0;
    const newBet = Math.max(rt.currentBet, newPlaced);
    if (action!=="allin"){
      const isBet = wasBet===0;
      if (!isBet){
        const raiseSize = newBet - wasBet;
        if (raiseSize < rt.minRaise) return { ok:false, error:"Min raise not met" };
      }
    }
    db.prepare("UPDATE poker_seats SET stack_s=stack_s-? WHERE id=?").run(toPut, seat.id);
    db.prepare("INSERT INTO hand_actions(hand_id,seat_index,street,action,amount_s,at) VALUES (?,?,?,?,?,?)")
      .run(rt.handId, seatIndex, rt.state, action==="allin"?"allin":(wasBet===0?"bet":"raise"), toPut, nowISO());
    rt.streetBets.set(seatIndex, newPlaced);
    const raiseSize = newBet - wasBet;
    if (newBet>rt.currentBet){
      if (wasBet===0) rt.minRaise = newBet; else if (raiseSize>0) rt.minRaise = raiseSize;
      rt.currentBet = newBet; rt.acted.clear();
    }
    wsBroadcast("player_action", { table_id: tableId, seat_index, action:(action==="allin"?"allin":(wasBet===0?"bet":"raise")), amount_s: toPut, auto });
    return advanceToNextActor(tableId);
  }
  return { ok:false, error:"Unknown action" };
}

app.post("/api/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!isEmail(email)) return res.status(400).json({ ok:false, error:"Bad email" });
    if (!isPass(password)) return res.status(400).json({ ok:false, error:"Password too short" });
    const exists = db.prepare("SELECT id FROM users WHERE lower(email)=lower(?)").get(String(email).toLowerCase());
    if (exists) return res.status(409).json({ ok:false, error:"Email taken" });
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(`INSERT INTO users(email,pass_hash,created_at,is_admin,is_disabled,balance_silver,last_seen) VALUES (?,?,?,?,?,?,?)`)
      .run(String(email).toLowerCase(), hash, nowISO(), 0, 0, 0, nowISO());
    return res.json({ ok:true });
  } catch { return res.status(500).json({ ok:false, error:"Register failed" }); }
});
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!isEmail(email)) return res.status(400).json({ ok:false, error:"Bad email" });
    const u = db.prepare("SELECT * FROM users WHERE lower(email)=lower(?)").get(String(email).toLowerCase());
    if (!u) return res.status(404).json({ ok:false, error:"User not found" });
    if (u.is_disabled) return res.status(403).json({ ok:false, error:"Account disabled" });
    const ok = bcrypt.compareSync(password || "", u.pass_hash);
    if (!ok) return res.status(401).json({ ok:false, error:"Wrong password" });
    const token = signToken(u);
    res.cookie(TOKEN_NAME, token, { httpOnly:true, sameSite:"lax", secure:IS_PROD, path:"/" });
    db.prepare("UPDATE users SET last_seen=? WHERE id=?").run(nowISO(), u.id);
    res.json({ ok:true, user:{ id:u.id, email:u.email, gold:sToG(u.balance_silver), silver: u.balance_silver%100 } });
  } catch { res.status(500).json({ ok:false, error:"Login failed" }); }
});
app.get("/api/logout", (req, res) => { res.clearCookie(TOKEN_NAME, { httpOnly:true, sameSite:"lax", secure:IS_PROD, path:"/" }); res.json({ ok:true }); });
app.get("/api/me", (req,res)=>{
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false });
  const u = db.prepare("SELECT id,email,is_admin,balance_silver,last_seen FROM users WHERE id=?").get(tok.uid);
  if (!u) return res.status(401).json({ ok:false });
  res.json({ ok:true, user:{ id:u.id, email:u.email, is_admin:!!u.is_admin, gold:sToG(u.balance_silver), silver:u.balance_silver%100 } });
});

app.get("/api/admin/ping", requireAdminKey, (_req,res)=> res.json({ ok:true }));
app.get("/api/admin/users", requireAdminKey, (_req,res)=>{
  const rows = db.prepare("SELECT id,email,is_admin,is_disabled,balance_silver,created_at,last_seen FROM users").all();
  const users = rows.map(u=>({ id:u.id,email:u.email,is_admin:!!u.is_admin,is_disabled:!!u.is_disabled, gold:sToG(u.balance_silver), silver:u.balance_silver%100, created_at:u.created_at, last_seen:u.last_seen }));
  res.json({ ok:true, users });
});
app.post("/api/admin/adjust-balance", requireAdminKey, (req,res)=>{
  try{
    const { email, gold=0, silver=0, delta_silver } = req.body||{};
    if (!isEmail(email)) return res.status(400).json({ ok:false, error:"Bad email" });
    const u = db.prepare("SELECT id,balance_silver FROM users WHERE lower(email)=lower(?)").get(String(email).toLowerCase());
    if (!u) return res.status(404).json({ ok:false, error:"User not found" });
    let deltaS = (typeof delta_silver==="number") ? Math.trunc(delta_silver) : (Math.trunc(gold)*100 + Math.trunc(silver));
    if (!Number.isFinite(deltaS) || deltaS===0) return res.status(400).json({ ok:false, error:"No change" });
    const after = u.balance_silver + deltaS;
    if (after<0) return res.status(400).json({ ok:false, error:"Insufficient" });
    db.prepare("UPDATE users SET balance_silver=? WHERE id=?").run(after, u.id);
    res.json({ ok:true, balance_silver: after });
  }catch(e){ res.status(500).json({ ok:false, error:String(e.message||e) }); }
});
app.post("/api/admin/disable-user", requireAdminKey, (req,res)=>{
  const { email, disabled } = req.body||{};
  if (!isEmail(email)) return res.status(400).json({ ok:false, error:"Bad email" });
  const u = db.prepare("SELECT id FROM users WHERE lower(email)=lower(?)").get(String(email).toLowerCase());
  if (!u) return res.status(404).json({ ok:false, error:"User not found" });
  db.prepare("UPDATE users SET is_disabled=? WHERE id=?").run(disabled?1:0, u.id);
  res.json({ ok:true });
});
app.get("/api/admin/user/:id/inventory", requireAdminKey, (req,res)=>{
  const uid = parseInt(req.params.id,10);
  const items   = db.prepare("SELECT name,tier,qty FROM user_items WHERE user_id=?").all(uid);
  const recipes = db.prepare("SELECT name,tier,qty FROM user_recipes WHERE user_id=?").all(uid);
  res.json({ ok:true, items, recipes });
});
app.get("/api/admin/bonus-codes", requireAdminKey, (_req,res)=>{
  const rows = db.prepare("SELECT slot,code,percent,total_credited_silver FROM admin_bonus_codes ORDER BY slot ASC").all();
  const map = new Map(rows.map(r=>[r.slot,r]));
  const slots = [];
  for (let i=1;i<=5;i++){
    const r = map.get(i) || { slot:i, code:"", percent:0, total_credited_silver:0 };
    slots.push(r);
  }
  res.json({ ok:true, slots });
});
app.post("/api/admin/bonus-codes", requireAdminKey, (req,res)=>{
  try{
    const { slot, code="", percent=0 } = req.body||{};
    const s = Math.max(1, Math.min(5, parseInt(slot,10)||0));
    const cod = String(code||"").trim().toUpperCase().replace(/[^A-Z0-9_.-]/g,"").slice(0,32);
    const pct = Math.max(0, Math.min(100, parseInt(percent,10)||0));
    db.prepare(`
      INSERT INTO admin_bonus_codes(slot,code,percent,total_credited_silver)
      VALUES (?,?,?,COALESCE((SELECT total_credited_silver FROM admin_bonus_codes WHERE slot=?),0))
      ON CONFLICT(slot) DO UPDATE SET code=excluded.code, percent=excluded.percent
    `).run(s, cod, pct, s);
    const row = db.prepare("SELECT slot,code,percent,total_credited_silver FROM admin_bonus_codes WHERE slot=?").get(s);
    res.json({ ok:true, ...row });
  }catch(e){ res.status(400).json({ ok:false, error:String(e.message||e) }); }
});
app.post("/api/admin/set-bonus-gold", requireAdminKey, (req,res)=>{
  const bonus_gold = Math.max(0, parseInt(req.body?.bonus_gold||"0",10) || 0);
  db.prepare("INSERT INTO admin_meta(key,val) VALUES ('artefact_bonus_gold',?) ON CONFLICT(key) DO UPDATE SET val=excluded.val")
    .run(String(bonus_gold));
  res.json({ ok:true, bonus_gold });
});
app.post("/api/admin/cleanup-images", requireAdminKey, (_req,res)=>{
  deleteZeroPrefixedImages(IMG_ROOT);
  res.json({ ok:true, cleaned:true });
});

app.get("/api/poker/lobby", (_req,res)=>{
  const rows = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM poker_seats s WHERE s.table_id=t.id AND s.user_id IS NOT NULL) AS players
    FROM poker_tables t ORDER BY t.id ASC
  `).all();
  res.json({ ok:true, tables: rows });
});
app.get("/api/poker/table/:id/state", (req,res)=>{
  const tid = parseInt(req.params.id,10);
  const t = db.prepare("SELECT * FROM poker_tables WHERE id=?").get(tid);
  if (!t) return res.status(404).json({ ok:false, error:"Table not found" });
  const seats = db.prepare("SELECT seat_index,user_id,stack_s,state,in_hand,last_action FROM poker_seats WHERE table_id=? ORDER BY seat_index").all(tid);
  const h = db.prepare("SELECT id,hand_no,state,btn_seat,sb_seat,bb_seat,board,started_at,ended_at FROM hands WHERE table_id=? ORDER BY id DESC LIMIT 1").get(tid);
  res.json({ ok:true, table:t, seats, hand:h||null });
});
function firstFreeSeat(tableId){
  const r = db.prepare("SELECT seat_index FROM poker_seats WHERE table_id=? AND (user_id IS NULL OR state='empty') ORDER BY seat_index ASC").get(tableId);
  return r ? r.seat_index : -1;
}
app.post("/api/poker/table/:id/join", (req,res)=>{
  try{
    const uid = requireAuth(req);
    const table = db.prepare("SELECT * FROM poker_tables WHERE id=?").get(parseInt(req.params.id,10));
    if (!table) return res.status(404).json({ ok:false, error:"Table not found" });
    const buyinBB = Math.max(1, Math.trunc(req.body?.buyin_bb|0));
    if (buyinBB < table.min_buyin_bb || buyinBB > table.max_buyin_bb)
      return res.status(400).json({ ok:false, error:`Buy-in ${table.min_buyin_bb}-${table.max_buyin_bb} BB` });

    const user = db.prepare("SELECT id,balance_silver,is_disabled FROM users WHERE id=?").get(uid);
    if (!user || user.is_disabled) return res.status(403).json({ ok:false, error:"Account issue" });

    const amountS = buyinBB * (table.bb_s|0);
    if ((user.balance_silver|0) < amountS) return res.status(400).json({ ok:false, error:"Insufficient funds" });

    const requestedSeat = Number.isInteger(req.body?.seat_index) ? (req.body.seat_index|0) : -1;
    const seatIdx = (requestedSeat>=0) ? requestedSeat : firstFreeSeat(table.id);
    if (seatIdx<0) return res.status(409).json({ ok:false, error:"No free seats" });

    const tx = db.transaction(()=>{
      const s = db.prepare("SELECT * FROM poker_seats WHERE table_id=? AND seat_index=?").get(table.id, seatIdx);
      if (!s) throw new Error("Seat not found");
      if (s.user_id!=null && s.user_id!==user.id) throw new Error("Seat taken");
      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?").run(amountS, user.id);
      if (s.user_id==null){
        db.prepare("UPDATE poker_seats SET user_id=?, stack_s=?, state='occupied', in_hand=0, last_action=NULL WHERE id=?")
          .run(user.id, amountS, s.id);
      } else {
        db.prepare("UPDATE poker_seats SET stack_s=stack_s+?, state='occupied' WHERE id=?").run(amountS, s.id);
      }
      db.prepare("INSERT INTO poker_buyins(table_id,user_id,amount_s,type,created_at) VALUES (?,?,?,?,?)")
        .run(table.id, user.id, amountS, "buyin", nowISO());
      return {
        seat_index: seatIdx,
        stack_s: db.prepare("SELECT stack_s FROM poker_seats WHERE id=?").get(s.id).stack_s,
        balance_silver: db.prepare("SELECT balance_silver FROM users WHERE id=?").get(user.id).balance_silver
      };
    });
    const out = tx();
    res.json({ ok:true, ...out });
    sendTableState(table.id);
    startIfCan(table.id);
  }catch(e){ res.status(400).json({ ok:false, error:String(e.message||e) }); }
});
app.post("/api/poker/table/:id/rebuy", (req,res)=>{
  try{
    const uid=requireAuth(req);
    const table = db.prepare("SELECT * FROM poker_tables WHERE id=?").get(parseInt(req.params.id,10));
    if (!table) return res.status(404).json({ ok:false, error:"Table not found" });
    const buyinBB = Math.max(1, Math.trunc(req.body?.buyin_bb|0));
    if (buyinBB < table.min_buyin_bb || buyinBB > table.max_buyin_bb)
      return res.status(400).json({ ok:false, error:`Rebuy ${table.min_buyin_bb}-${table.max_buyin_bb} BB` });

    const seat = db.prepare("SELECT * FROM poker_seats WHERE table_id=? AND user_id=?").get(table.id, uid);
    if (!seat) return res.status(404).json({ ok:false, error:"Not seated" });

    const user = db.prepare("SELECT id,balance_silver,is_disabled FROM users WHERE id=?").get(uid);
    if (!user || user.is_disabled) return res.status(403).json({ ok:false, error:"Account issue" });

    const amountS = buyinBB * (table.bb_s|0);
    if ((user.balance_silver|0) < amountS) return res.status(400).json({ ok:false, error:"Insufficient funds" });

    const tx = db.transaction(()=>{
      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?").run(amountS, user.id);
      db.prepare("UPDATE poker_seats SET stack_s=stack_s+? WHERE id=?").run(amountS, seat.id);
      db.prepare("INSERT INTO poker_buyins(table_id,user_id,amount_s,type,created_at) VALUES (?,?,?,?,?)")
        .run(table.id, user.id, amountS, "rebuy", nowISO());
      return {
        seat_index: seat.seat_index,
        stack_s: db.prepare("SELECT stack_s FROM poker_seats WHERE id=?").get(seat.id).stack_s,
        balance_silver: db.prepare("SELECT balance_silver FROM users WHERE id=?").get(user.id).balance_silver
      };
    });
    const out = tx();
    res.json({ ok:true, ...out });
    sendTableState(table.id);
  }catch(e){ res.status(400).json({ ok:false, error:String(e.message||e) }); }
});
app.post("/api/poker/table/:id/sitout", (req,res)=>{
  try{
    const uid=requireAuth(req);
    const tableId=parseInt(req.params.id,10);
    const seat=db.prepare("SELECT * FROM poker_seats WHERE table_id=? AND user_id=?").get(tableId, uid);
    if (!seat) return res.status(404).json({ ok:false, error:"Not seated" });
    db.prepare("UPDATE poker_seats SET state='sitout' WHERE id=?").run(seat.id);
    res.json({ ok:true }); sendTableState(tableId);
  }catch(e){ res.status(400).json({ ok:false, error:String(e.message||e) }); }
});
app.post("/api/poker/table/:id/sitin", (req,res)=>{
  try{
    const uid=requireAuth(req);
    const tableId=parseInt(req.params.id,10);
    const seat=db.prepare("SELECT * FROM poker_seats WHERE table_id=? AND user_id=?").get(tableId, uid);
    if (!seat) return res.status(404).json({ ok:false, error:"Not seated" });
    db.prepare("UPDATE poker_seats SET state='occupied' WHERE id=?").run(seat.id);
    res.json({ ok:true }); sendTableState(tableId); startIfCan(tableId);
  }catch(e){ res.status(400).json({ ok:false, error:String(e.message||e) }); }
});
app.post("/api/poker/table/:id/leave", (req,res)=>{
  try{
    const uid=requireAuth(req);
    const tableId=parseInt(req.params.id,10);
    const seat=db.prepare("SELECT * FROM poker_seats WHERE table_id=? AND user_id=?").get(tableId, uid);
    if (!seat) return res.status(404).json({ ok:false, error:"Not seated" });
    const out = db.transaction(()=>{
      const stack=seat.stack_s|0;
      if (stack>0){
        db.prepare("UPDATE users SET balance_silver=balance_silver+? WHERE id=?").run(stack, uid);
        db.prepare("INSERT INTO poker_buyins(table_id,user_id,amount_s,type,created_at) VALUES (?,?,?,?,?)")
          .run(tableId, uid, stack, "cashout", nowISO());
      }
      db.prepare("UPDATE poker_seats SET user_id=NULL, stack_s=0, state='empty', in_hand=0, last_action=NULL WHERE id=?").run(seat.id);
      return { returned_s: stack, balance_silver: db.prepare("SELECT balance_silver FROM users WHERE id=?").get(uid).balance_silver };
    })();
    res.json({ ok:true, ...out }); sendTableState(tableId);
  }catch(e){ res.status(400).json({ ok:false, error:String(e.message||e) }); }
});

app.get("/health", (_req,res)=> res.json({ ok:true, ts:Date.now() }));
app.get("/metrics", (_req,res)=>{
  const tables = db.prepare("SELECT COUNT(*) c FROM poker_tables").get().c|0;
  const hands  = db.prepare("SELECT COUNT(*) c FROM hands").get().c|0;
  res.json({ ok:true, tables, hands, ts:Date.now() });
});

function wsUserIdFromReq(req){
  try{
    const cookies = parseCookie(req.headers.cookie || "");
    const tok = cookies[TOKEN_NAME]; if (!tok) return null;
    const p = jwt.verify(tok, JWT_SECRET);
    return p?.uid || null;
  }catch{ return null; }
}
wss.on("connection", (ws, req)=>{
  ws.uid = wsUserIdFromReq(req) || null;
  send(ws,"connection_open",{ ts:Date.now(), env:ENV, uid: ws.uid });
  ws.on("message", raw=>{
    let msg; try{ msg=JSON.parse(raw.toString()); }catch{ return send(ws,"error",{code:"BAD_JSON"}); }
    const { type, payload } = msg||{};
    if (type==="ping") return send(ws,"pong",{ ts:Date.now() });
    if (type==="player_action"){
      if (!ws.uid) return send(ws,"error",{code:"AUTH",message:"Login required"});
      const { table_id, seat_index } = payload||{};
      const seat = db.prepare("SELECT user_id,in_hand FROM poker_seats WHERE table_id=? AND seat_index=?").get(table_id|0, seat_index|0);
      if (!seat || seat.user_id !== ws.uid) return send(ws,"error",{code:"SEAT_OWNERSHIP", message:"Not your seat"});
      const out = applyAction(table_id|0, seat_index|0, String(payload.action||"").toLowerCase(), payload.amount_s|0, false);
      if (out && out.ok===false) send(ws,"error", { code:"ACTION", message: out.error });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`POKER server listening at http://${HOST}:${PORT}`);
});
