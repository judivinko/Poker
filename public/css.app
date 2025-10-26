/* ====== /public/game.css  ======
   Poker Table layout + seats + board + HUD
   (radi uz /public/table.html i /public/table.js)
*/

/* Global */
:root{
  --bg:#0b0d13;
  --panel:#111722;
  --muted:#94a3b8;
  --br:#243041;
  --accent:#22d3ee;
  --seat-w:92px;
  --card-w:56px;
  --card-h:80px;
}
html,body{height:100%;margin:0;background:var(--bg);color:#e5e7eb;font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;}

/* Stage */
.wrap{
  position:relative;
  width:100vw;height:100vh;overflow:hidden;
  display:flex;align-items:center;justify-content:center;
}
#table{
  position:relative;
  width:min(100vw,100vh);
  height:min(100vw,100vh);
  background:url('/poker_table.png') center/contain no-repeat;
}

/* Board (5 community cards) */
#board{
  position:absolute;
  top:50%;left:50%;
  transform:translate(-50%,-50%);
  display:flex;gap:10px;align-items:center;justify-content:center;
}
.card{
  width:var(--card-w);height:var(--card-h);
  background-image:url('/card_front_blank.png');
  background-size:cover;background-position:center;
  border-radius:8px;border:1px solid rgba(255,255,255,.08);
  box-shadow:0 2px 10px rgba(0,0,0,.35);
}
.card.back{ background-image:url('/card_back.png'); }

/* Pot + status */
#pot{
  position:absolute;top:50%;left:50%;
  transform:translate(-50%,-120%);
  font-weight:700;opacity:.9;text-shadow:0 1px 2px #000;
}
#status{
  position:absolute;bottom:8%;left:50%;transform:translateX(-50%);
  opacity:.85;font-size:15px;text-align:center;
}

/* Actions */
#actions{
  position:absolute;bottom:5%;left:50%;transform:translateX(-50%);
  display:flex;gap:10px;
}
#actions button{
  padding:10px 18px;border:none;border-radius:8px;
  background:var(--accent);color:#000;font-weight:800;cursor:pointer;
}
#actions button.secondary{ background:#2b3445;color:#e5e7eb; }
#actions button.danger{ background:#b91c1c;color:#fff; }

#bet-box{
  position:absolute;bottom:18%;left:50%;transform:translateX(-50%);
  display:flex;gap:8px;align-items:center;
}
#bet-box input{
  width:100px;padding:8px;border-radius:8px;
  background:#0b1220;border:1px solid var(--br);color:#e5e7eb;
  text-align:center;font-weight:700;
}

/* Seats */
.seat{
  position:absolute;width:var(--seat-w);transform:translate(-50%,-50%);
  text-align:center;display:flex;flex-direction:column;align-items:center;
  gap:2px;pointer-events:auto;
}
.seat .avatar{
  width:50px;height:50px;border-radius:999px;object-fit:cover;
  border:2px solid #233047;background:#0b1220;
}
.seat .nick{font-size:13px;line-height:1.1;}
.seat .stack{font-size:12px;opacity:.9;}
.badges{display:flex;gap:4px;margin-top:2px;align-items:center;justify-content:center;}
.badge{
  font-size:11px;background:var(--accent);color:#000;
  padding:1px 6px;border-radius:999px;font-weight:800;
}
.badge.img{ background:transparent;padding:0; }
.badge.img img{ display:block;width:18px;height:18px; }

/* Dealer / Blinds icons (use images if želiš) */
.badge.dealer.img img{ content:url('/dealer_button.png'); }
.badge.sb.img img{ content:url('/small_blind.png'); }
.badge.bb.img img{ content:url('/big_blind.png'); }

/* Seat positions for 9-max (relative to square table area) */
.seat[data-i="0"]{ left:50%; top:88%; }
.seat[data-i="1"]{ left:75%; top:80%; }
.seat[data-i="2"]{ left:88%; top:60%; }
.seat[data-i="3"]{ left:86%; top:35%; }
.seat[data-i="4"]{ left:70%; top:18%; }
.seat[data-i="5"]{ left:30%; top:18%; }
.seat[data-i="6"]{ left:14%; top:35%; }
.seat[data-i="7"]{ left:12%; top:60%; }
.seat[data-i="8"]{ left:25%; top:80%; }

/* 6-max suggested visibility (table.js može sakriti viškove) */
/* .seat[data-i="1"], .seat[data-i="7"] { display:none; } */
/* .seat[data-i="3"], .seat[data-i="5"] { display:none; } */

/* Responsive tweaks */
@media (max-width: 760px){
  :root{ --seat-w:80px; --card-w:48px; --card-h:70px; }
  .seat .avatar{ width:44px; height:44px; }
  #actions button{ padding:8px 12px; font-size:13px; }
  #bet-box input{ width:84px; }
}

/* Utility */
.hidden{ display:none !important; }
