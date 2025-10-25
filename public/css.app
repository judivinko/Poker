/* ============================
   TEXAS HOLD'EM • game.css (aligned to current index.html)
   - Mobile-first
   - Works with DOM structure in your latest index:
     .topbar .status, .wrap, .table[data-seats], .board .card.back,
     .seat[data-i] { .timer, .avatar.placeholder, .avatar.player, .badges, .nick, .stack }
   Assets (under /public):
     /images/ui/poker_table.png
     /images/ui/seat_empty.png
     /images/ui/dealer_button.png
     /images/ui/small_blind.png
     /images/ui/big_blind.png
     /images/cards/card_front_blank.png
     /images/cards/card_back.png
     /images/avatars/avatar_1.png … avatar_8.png
   ============================ */

/* ---- Base / Theme ---- */
:root{
  --bg:#0b0d13;
  --text:#e5e7eb;
  --muted:#9aa4b2;
  --ring-bg: rgba(255,255,255,.08);
  --ring-fg:#22d3ee;

  --table-w: min(96vw, 1080px);
  --table-ratio: 1.65;               /* width : height */
  --seat-size: clamp(48px, 8.2vw, 90px);
  --seat-hit: calc(var(--seat-size) * 1.25);
  --badge: clamp(18px, 3.2vw, 28px);
  --ring-w: max(3px, 0.5vw);

  --card-w: clamp(36px, 6.4vw, 64px);
  --card-ratio: 0.69;                 /* poker card aspect */
  --board-gap: clamp(6px, 1.2vw, 12px);
}

*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;background:var(--bg);color:var(--text);
  font:400 14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Arial,"Noto Sans",sans-serif;
}

/* Optional helpers used by index header */
.status{ color:var(--muted); font-size:12px; }

/* ---- Layout wrappers (used by index) ---- */
.wrap{ display:flex; flex-direction:column; gap:12px; align-items:center; padding:10px; }

/* ---- Table Canvas ---- */
.table{
  position:relative;
  width:var(--table-w);
  height:calc(var(--table-w) / var(--table-ratio));
  background:url("/images/ui/poker_table.png") center/contain no-repeat;
  user-select:none; touch-action:manipulation;
  border-radius:32px;
  outline:1px solid rgba(255,255,255,.06);
  box-shadow: 0 10px 40px rgba(0,0,0,.6) inset, 0 10px 28px rgba(0,0,0,.35);
}

/* ---- Board zone (flop/turn/river) ---- */
.board{
  position:absolute; left:50%; top:50%;
  transform:translate(-50%,-50%);
  display:flex; gap:var(--board-gap); align-items:center;
  padding:6px 8px; border-radius:10px;
  background:rgba(0,0,0,.18); outline:1px solid rgba(255,255,255,.07);
  backdrop-filter: blur(2px);
}
.board .card{
  width:var(--card-w);
  aspect-ratio: calc(1 / var(--card-ratio));
  border-radius:6px;
  background:url("/images/cards/card_front_blank.png") center/cover no-repeat;
  box-shadow: 0 2px 6px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.06) inset;
}
.board .card.back{
  background-image:url("/images/cards/card_back.png");
  filter:saturate(.9) contrast(1.05);
}

/* ---- Seat (avatar, nick, stack, badges, timer) ---- */
.seat{
  position:absolute; transform:translate(-50%,-50%);
  width:var(--seat-hit); height:var(--seat-hit);
  display:grid; place-items:center; text-align:center;
}
.seat .avatar{
  width:var(--seat-size); height:var(--seat-size);
  border-radius:999px; overflow:hidden;
  box-shadow: 0 4px 10px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.06) inset;
  background: rgba(255,255,255,.02);
  object-fit:cover; display:block;
}
.seat .avatar.placeholder{
  background:url("/images/ui/seat_empty.png") center/cover no-repeat, rgba(255,255,255,.02);
}
.seat .nick{
  margin-top:4px; font-size:12px; color:#dbe3ee; text-shadow:0 1px 0 rgba(0,0,0,.35);
}
.seat .stack{
  position:absolute; top:calc(100% - 2px); left:50%; transform:translate(-50%,0);
  background:rgba(0,0,0,.55);
  border:1px solid rgba(255,255,255,.12);
  color:var(--text); font-size:12px; padding:2px 6px; border-radius:999px; white-space:nowrap;
  backdrop-filter: blur(2px);
}

/* ---- Acting timer ring (uses --p from JS 0..100) ---- */
.seat .timer{
  position:absolute; inset:calc((var(--seat-hit) - var(--seat-size)) / -2);
  border-radius:999px; pointer-events:none;
}
.seat .timer::before{
  content:""; position:absolute; inset:0;
  border-radius:inherit;
  padding:var(--ring-w);
  background:
    conic-gradient(var(--ring-fg) var(--p,0%), transparent 0) content-box,
    radial-gradient(closest-side, var(--ring-bg) 98%, transparent) border-box;
  -webkit-mask:
    radial-gradient(farthest-side, transparent calc(100% - var(--ring-w)), #000 calc(100% - var(--ring-w)));
          mask:
    radial-gradient(farthest-side, transparent calc(100% - var(--ring-w)), #000 calc(100% - var(--ring-w)));
  transition: --p .2s linear;
  opacity:.95;
}
.seat.turn .timer{ animation: ringPulse 1s ease-in-out infinite alternate; }
@keyframes ringPulse{ from{transform:scale(1)} to{transform:scale(1.03)} }

/* ---- Per-seat badges (BTN/SB/BB) ---- */
.seat .badges{
  position:absolute; top:calc(100% - 8px); left:50%; transform:translate(-50%,0);
  display:flex; gap:6px; align-items:center; pointer-events:none;
}
.seat .badge{
  width:var(--badge); height:var(--badge);
  background: center/contain no-repeat;
  filter: drop-shadow(0 2px 4px rgba(0,0,0,.5));
}
.seat .badge.btn{ background-image:url("/images/ui/dealer_button.png"); }
.seat .badge.sb { background-image:url("/images/ui/small_blind.png"); }
.seat .badge.bb { background-image:url("/images/ui/big_blind.png"); }

/* ---- Helpers by state ---- */
.seat.empty .stack{ display:none; }
.seat.sitout .avatar{ filter:grayscale(.8) opacity(.7); }
.seat.folded .avatar{ filter:grayscale(1) opacity(.55); }
.seat.me .avatar{ box-shadow: 0 0 0 2px rgba(34,211,238,.75), 0 6px 18px rgba(0,0,0,.5); }

/* ---- Seat coordinates (match index seats 0..8) ---- */
/* Default (fallback: 9-max) */
.table{
  --s0x:50%; --s0y:88%;
  --s1x:76%; --s1y:80%;
  --s2x:88%; --s2y:60%;
  --s3x:84%; --s3y:38%;
  --s4x:67%; --s4y:22%;
  --s5x:33%; --s5y:22%;
  --s6x:16%; --s6y:38%;
  --s7x:12%; --s7y:60%;
  --s8x:24%; --s8y:80%;
}
/* 6-max layout */
.table[data-seats="6"]{
  --s0x:50%; --s0y:88%;
  --s1x:80%; --s1y:72%;
  --s2x:82%; --s2y:36%;
  --s3x:50%; --s3y:16%;
  --s4x:18%; --s4y:36%;
  --s5x:20%; --s5y:72%;
}
.seat[data-i="0"]{ left:var(--s0x); top:var(--s0y); }
.seat[data-i="1"]{ left:var(--s1x); top:var(--s1y); }
.seat[data-i="2"]{ left:var(--s2x); top:var(--s2y); }
.seat[data-i="3"]{ left:var(--s3x); top:var(--s3y); }
.seat[data-i="4"]{ left:var(--s4x); top:var(--s4y); }
.seat[data-i="5"]{ left:var(--s5x); top:var(--s5y); }
.seat[data-i="6"]{ left:var(--s6x); top:var(--s6y); }
.seat[data-i="7"]{ left:var(--s7x); top:var(--s7y); }
.seat[data-i="8"]{ left:var(--s8x); top:var(--s8y); }

/* ---- Responsive tweaks ---- */
@media (min-width: 760px){
  :root{
    --seat-size: clamp(58px, 7.2vw, 100px);
    --ring-w: max(3px, 0.4vw);
  }
}
@media (max-width: 420px){
  :root{
    --seat-size: clamp(44px, 16vw, 74px);
    --badge: clamp(16px, 4.2vw, 24px);
    --card-w: clamp(34px, 18vw, 58px);
  }
  .status{ font-size:11px; }
}

/* ---- Utility ---- */
.hidden{ display:none !important; }
.muted{ color:var(--muted) !important; }
