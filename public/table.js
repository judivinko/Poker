// ===== /public/table.js =====
// Prikaz stola + akcije + WS refresh
(()=>{
  const $ = (s, r=document)=>r.querySelector(s);

  const params = new URLSearchParams(location.search);
  const TABLE_ID = parseInt(params.get("id")||"0",10);

  const elBoard = $("#board");
  const elPot = $("#pot");
  const elStatus = $("#status");
  const elActions = $("#actions");
  const elBetBox = $("#bet-box");
  const elBetAmount = $("#bet-amount");

  let WS=null, STATE=null;

  function setCard(el, code){
    el.className="card";
    if(!code || code==="??"){ el.classList.add("back"); return; }
    el.style.position="relative";
    el.style.backgroundImage="url('/card_front_blank.png')";
    let o=el.querySelector(".ov");
    if(!o){ o=document.createElement("div"); o.className="ov"; Object.assign(o.style,{position:"absolute",inset:"4px",fontWeight:"900"}); el.appendChild(o); }
    const r=code[0], s=code[1], red=(s==="d"||s==="h");
    o.style.color = red ? "#ff6b6b" : "#e5e7eb";
    o.textContent = r+s;
  }

  function renderBoard(arr){
    elBoard.innerHTML="";
    for(let i=0;i<5;i++){
      const d=document.createElement("div");
      d.className="card";
      setCard(d, arr[i]||"??");
      elBoard.appendChild(d);
    }
  }

  function seatEl(i){ return document.querySelector(`.seat[data-i="${i}"]`); }
  function hideExtraSeats(n){
    for(let i=0;i<9;i++){ const e=seatEl(i); if(!e) continue; e.style.display = i<n ? "flex":"none"; }
  }

  function badgeImg(src, cls){
    const span=document.createElement("span"); span.className=`badge img ${cls||""}`;
    const img=document.createElement("img"); img.src=src; span.appendChild(img); return span;
  }

  function renderSeats(st){
    hideExtraSeats(st.table.seats);
    for(let i=0;i<st.table.seats;i++){
      const el=seatEl(i); if(!el) continue;
      const nick=$(".nick",el), stack=$(".stack",el), av=$(".avatar",el), badges=$(".badges",el);
      badges.innerHTML="";
      const s = st.seats.find(x=>x.seat_index===i);
      if(!s || !s.user_id){ av.src="/seat_empty.png"; nick.textContent=""; stack.textContent=""; continue; }
      av.src=s.avatar||"/avatar_1.png";
      nick.textContent=s.email||("User#"+s.user_id);
      stack.textContent=(s.stack|0)+" čipova";
      if(i===st.dealer) badges.appendChild(badgeImg("/dealer_button.png","dealer"));
      if(i===st.sb_i)  badges.appendChild(badgeImg("/small_blind.png","sb"));
      if(i===st.bb_i)  badges.appendChild(badgeImg("/big_blind.png","bb"));
      if(i===st.acting){ const t=document.createElement("span"); t.className="badge"; t.textContent="TURN"; badges.appendChild(t); }
      if(i===st.me_seat){ const y=document.createElement("span"); y.className="badge"; y.textContent="YOU"; badges.appendChild(y); }
    }
  }

  function renderActions(st){
    const myTurn = st.me_seat>=0 && st.acting===st.me_seat && st.street!=="waiting";
    elActions.classList.toggle("hidden", !myTurn);
    elBetBox.classList.add("hidden");

    // status
    elStatus.textContent = `${st.street.toUpperCase()} • SB:${st.table.sb} BB:${st.table.bb}` +
      (myTurn ? ` • Na potezu si (call ${st.call_amt||0})` : "");

    // pripremi bet box granice
    if(myTurn){
      elBetAmount.value = st.min_bet||st.table.bb;
      elBetAmount.min = st.min_bet||st.table.bb;
    }
  }

  function render(st){
    renderBoard(st.board||[]);
    renderSeats(st);
    elPot.textContent = st.pot ? ("Pot: "+st.pot) : "—";
    renderActions(st);

    // moje hole karte (ako si sjeo) — prikaži na mjestu mog seat-a preko avatara (tooltip)
    if(st.my_hole){
      const me = seatEl(st.me_seat);
      if(me){
        me.title = "Tvoje karte: " + (st.my_hole.join(" "));
      }
    }
  }

  async function fetchState(){
    const r = await fetch(`/api/table/state?id=${TABLE_ID}`,{credentials:"include"}).then(x=>x.json()).catch(()=>null);
    if(!r?.ok) return;
    STATE=r; render(STATE);
  }

  // actions
  async function doAction(a, amount){
    const body={ table_id: TABLE_ID, action:a };
    if(typeof amount==="number") body.amount=amount|0;
    const r = await fetch("/api/table/action",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",body:JSON.stringify(body)}).then(x=>x.json()).catch(()=>null);
    if(!r?.ok) return;
    await fetchState();
  }
  window.sendFold = ()=>doAction("fold");
  window.sendCheck = ()=>doAction("check");
  window.sendCall = ()=>doAction("call");
  window.openBet = ()=>{ elBetBox.classList.remove("hidden"); elBetAmount.focus(); };
  window.sendBet = ()=>{ const v=parseInt(elBetAmount.value||"0",10); if(!v) return; doAction("bet",v); };

  function connectWS(){
    try{
      const ws=new WebSocket((location.protocol==="https:"?"wss":"ws")+"://"+location.host);
      ws.onopen=()=>ws.send(JSON.stringify({type:"join-table",table_id:TABLE_ID}));
      ws.onmessage=ev=>{ try{ const m=JSON.parse(ev.data); if(m.type==="update") fetchState(); }catch{} };
      ws.onclose=()=>setTimeout(connectWS,1200);
      WS=ws;
    }catch{}
  }

  (async()=>{ await fetchState(); connectWS(); })();
})();
