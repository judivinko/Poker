// ====== /public/table.js ======
// Klijentski engine: učitavanje stanja, render, akcije, WS sync

(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // ---------- URL / TABLE ID ----------
  const params = new URLSearchParams(location.search);
  const TABLE_ID = parseInt(params.get("id") || "0", 10);

  // ---------- UI refs ----------
  const elTable = $("#table");
  const elBoard = $("#board");
  const elPot = $("#pot");
  const elStatus = $("#status");
  const elActions = $("#actions");
  const elBetBox = $("#bet-box");
  const elBetAmount = $("#bet-amount");

  // ---------- Local state ----------
  let ME = null;           // { id, email, avatar }
  let STATE = null;        // server table state snapshot
  let WS = null;

  // ---------- Helpers ----------
  function setStatus(t) { elStatus.textContent = t || ""; }

  function seatEl(i) {
    return $(`.seat[data-i="${i}"]`);
  }

  function hideExtraSeats(maxSeats) {
    // sakrij višak sjedala > maxSeats
    for (let i = 0; i < 9; i++) {
      const el = seatEl(i);
      if (!el) continue;
      el.style.display = i < maxSeats ? "flex" : "none";
    }
  }

  function setCard(el, code, faceUp = true) {
    // `code` je npr "As" / "Td" / "??"
    // render: ako faceUp i code != "??", koristimo prednju blank + overlay rank/suit text
    // minimalno: ako ne znamo, prikazat ćemo back/front blank
    el.className = "card";
    if (!faceUp || code === "??") {
      el.classList.add("back");
      return;
    }
    // koristimo front blank, stavimo text overlay (rank + suit)
    el.style.position = "relative";
    el.style.backgroundImage = "url('/card_front_blank.png')";
    let overlay = el.querySelector(".ov");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "ov";
      overlay.style.position = "absolute";
      overlay.style.inset = "4px";
      overlay.style.display = "flex";
      overlay.style.alignItems = "flex-start";
      overlay.style.justifyContent = "space-between";
      overlay.style.fontWeight = "900";
      overlay.style.fontSize = "16px";
      overlay.style.color = "#fff";
      el.appendChild(overlay);
    }
    const rank = code?.slice(0, 1) || "?";
    const suit = code?.slice(1, 2) || "?";
    const red = (suit === "h" || suit === "d");
    overlay.style.color = red ? "#ff6b6b" : "#e5e7eb";
    overlay.textContent = rank + suit;
  }

  function renderBoard(boardArr) {
    // boardArr je npr ["??","??","??","??","??"] ili ['Ah','Kd','7c','2d','Jc']
    elBoard.innerHTML = "";
    const a = boardArr || [];
    for (let i = 0; i < 5; i++) {
      const code = a[i] || "??";
      const card = document.createElement("div");
      card.className = "card";
      setCard(card, code, code !== "??");
      elBoard.appendChild(card);
    }
  }

  function badgeImg(src, cls) {
    const span = document.createElement("span");
    span.className = `badge img ${cls || ""}`;
    const img = document.createElement("img");
    img.src = src;
    span.appendChild(img);
    return span;
  }

  function renderSeats(state) {
    const { table, seats, dealer, sb_i, bb_i, acting, me_seat } = state;

    hideExtraSeats(table.seats);

    for (let i = 0; i < table.seats; i++) {
      const el = seatEl(i);
      if (!el) continue;

      const nick = $(".nick", el);
      const stack = $(".stack", el);
      const avatar = $(".avatar", el);
      const badges = $(".badges", el);

      badges.innerHTML = "";

      const s = seats.find(x => x.seat_index === i);
      if (!s || !s.user_id) {
        // empty
        avatar.src = "/seat_empty.png";
        nick.textContent = "";
        stack.textContent = "";
        continue;
      }

      avatar.src = s.avatar || "/avatar_1.png";
      nick.textContent = s.email || ("User#" + s.user_id);
      stack.textContent = (s.stack|0) + " čipova";

      if (i === dealer) badges.appendChild(badgeImg("/dealer_button.png", "dealer"));
      if (i === sb_i)    badges.appendChild(badgeImg("/small_blind.png", "sb"));
      if (i === bb_i)    badges.appendChild(badgeImg("/big_blind.png", "bb"));

      if (acting === i) {
        const turn = document.createElement("span");
        turn.className = "badge";
        turn.textContent = "TURN";
        badges.appendChild(turn);
      }

      if (me_seat === i) {
        const you = document.createElement("span");
        you.className = "badge";
        you.textContent = "YOU";
        badges.appendChild(you);
      }
    }
  }

  function renderPot(pot) {
    elPot.textContent = pot ? ("Pot: " + pot) : "—";
  }

  function updateActionBar(state) {
    // Pokaži/skrivaj tipke ovisno je li na potezu
    const myTurn = (state.me_seat === state.acting);
    elActions.classList.toggle("hidden", !myTurn);

    // Bet box samo kad server kaže da bet/raise postoji (min_bet > 0)
    const canBet = myTurn && (state.min_bet || 0) > 0;
    elBetBox.classList.toggle("hidden", !canBet);
    if (canBet) {
      elBetAmount.value = state.min_bet;
      elBetAmount.min = state.min_bet;
      elBetAmount.max = Math.max(state.min_bet, (state.max_bet || state.min_bet));
    }
  }

  function renderAll(state) {
    // glavni render
    renderBoard(state.board || []);
    renderSeats(state);
    renderPot(state.pot|0);
    updateActionBar(state);

    // status string
    const st = `${state.street?.toUpperCase() || "—"} • SB:${state.table.sb} BB:${state.table.bb}`;
    setStatus(st);
  }

  // ---------- API ----------
  async function apiMe() {
    const r = await fetch("/api/me", { credentials: "include" }).then(x => x.json()).catch(() => null);
    if (r?.ok) ME = r.user; else ME = null;
  }

  async function apiState() {
    const r = await fetch(`/api/table/state?id=${TABLE_ID}`, { credentials: "include" })
      .then(x => x.json()).catch(() => null);
    if (!r?.ok) return null;
    return r;
  }

  async function apiAction(kind, amount) {
    const body = { table_id: TABLE_ID, action: kind };
    if (typeof amount === "number") body.amount = amount|0;
    const r = await fetch("/api/table/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body)
    }).then(x => x.json()).catch(() => null);
    return r;
  }

  // ---------- Actions ----------
  window.sendFold = async () => {
    const r = await apiAction("fold");
    if (!r?.ok) return; await refresh();
  };
  window.sendCheck = async () => {
    const r = await apiAction("check");
    if (!r?.ok) return; await refresh();
  };
  window.sendCall = async () => {
    const r = await apiAction("call");
    if (!r?.ok) return; await refresh();
  };
  window.openBet = () => {
    elBetBox.classList.remove("hidden");
    elBetAmount.focus();
  };
  window.sendBet = async () => {
    const amt = parseInt(elBetAmount.value || "0", 10);
    if (!amt || amt < (STATE?.min_bet || 1)) return;
    const r = await apiAction("bet", amt);
    if (!r?.ok) return;
    elBetBox.classList.add("hidden");
    await refresh();
  };

  // ---------- WS ----------
  function connectWS() {
    try {
      WS = new WebSocket((location.protocol === "https:" ? "wss" : "ws") + "://" + location.host);
      WS.onopen = () => {
        WS.send(JSON.stringify({ type: "join-table", table_id: TABLE_ID }));
      };
      WS.onmessage = ev => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "update") {
            // server javio promjenu → refetch state
            refresh();
          }
        } catch {}
      };
      WS.onclose = () => setTimeout(connectWS, 1200);
    } catch {}
  }

  // ---------- Main refresh ----------
  async function refresh() {
    const st = await apiState();
    if (!st) {
      setStatus("Greška pri učitavanju stanja.");
      return;
    }
    STATE = st;
    renderAll(STATE);
  }

  // ---------- Boot ----------
  (async () => {
    if (!TABLE_ID) { setStatus("Nedostaje table id."); return; }
    await apiMe();
    await refresh();
    connectWS();
  })();

})();
