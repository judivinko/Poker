// ===== /public/table.js =====
// Prikaz stola + JOIN + TOP-UP + akcije + WS refresh (samo STO)
(()=>{
  const $ = (s, r=document)=>r.querySelector(s);

  const params = new URLSearchParams(location.search);
  const TABLE_ID = parseInt(params.get("id")||"0",10);

  const elBoard   = $("#board");
  const elPot     = $("#pot");
  const elStatus  = $("#status");
  const elActions = $("#actions");
  const elBetBox  = $("#bet-box");
  const elBetAmt  = $("#bet-amount");

  const topbar    = $("#topbar");
  const infoPill  = $("#info-pill");
  const btnOpenJoin  = $("#btn-open-join");
  const btnOpenTopup = $("#btn-open-topup");
  const btnLeave     = $("#btn-leave");

  // JOIN modal
  const joinBox   = $("#join-box");
  const joinId    = $("#join-id");
  const joinSeat  = $("#join-seat");
  const joinBuy   = $("#join-buy");
  const joinRange = $("#join-range");
  const joinMsg   = $("#join-msg");
  const btnJoinOk = $("#btn-join-confirm");
  const btnJoinClose = $("#btn-close-join");

  // TOPUP modal
  const topupBox   = $("#topup-box");
  const topupHint  = $("#topup-hint");
  const topupAmt   = $("#topup-amount");
  const topupMsg   = $("#topup-msg");
  const btnTopupOk = $("#btn-topup-confirm");
  const btnTopupClose = $("#btn-close-topup");

  let WS=null, STATE=null;

  function seatEl(i){ return document.querySelector(`.seat[data-i="${i}"]`); }
  function hideExtraSeats(n){
    for(let i=0;i<9;i++){ const e=seatEl(i); if(!e) continue; e.style.display = i<n ? "flex":"none"; }
  }

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

    // status/topbar info
    const txt = `${st.street.toUpperCase()} • SB:${st.table.sb} BB:${st.table.bb}`;
    elStatus.textContent = txt + (myTurn ? ` • Na potezu si (call ${st.call_amt||0})` : "");
    infoPill.textContent = txt;

    // pripremi bet box granice
    if(myTurn){
      elBetAmt.value = st.min_bet||st.table.bb;
      elBetAmt.min = st.min_bet||st.table.bb;
    }

    // topbar prikaz dugmadi
    topbar.classList.remove("hidden");
    btnOpenJoin.classList.toggle("hidden", st.me_seat>=0);  // Join dugme samo ako nisi sjeo
    btnOpenTopup.classList.toggle("hidden", st.me_seat<0);  // Top-up samo ako sjediš
    btnLeave.classList.toggle("hidden", st.me_seat<0);
  }

  function render(st){
    renderBoard(st.board||[]);
    renderSeats(st);
    elPot.textContent = st.pot ? ("Pot: "+st.pot) : "—";
    renderActions(st);

    // moje hole karte (tooltip)
    if(st.my_hole){
      const me = seatEl(st.me_seat);
      if(me){ me.title = "Tvoje karte: " + (st.my_hole.join(" ")); }
    }
  }

  async function fetchState(){
    const r = await fetch(`/api/table/state?id=${TABLE_ID}`,{credentials:"include"}).then(x=>x.json()).catch(()=>null);
    if(!r?.ok) return;
    STATE=r; render(STATE);
  }

  // --- ACTIONS (TURN) ---
  async function doAction(a, amount){
    const body={ table_id: TABLE_ID, action:a };
    if(typeof amount==="number") body.amount=amount|0;
    const r = await fetch("/api/table/action",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",body:JSON.stringify(body)}).then(x=>x.json()).catch(()=>null);
    if(!r?.ok){ return; }
    await fetchState();
  }
  $("#btn-fold").onclick = ()=>doAction("fold");
  $("#btn-check").onclick= ()=>doAction("check");
  $("#btn-call").onclick = ()=>doAction("call");
  $("#btn-open-bet").onclick= ()=>{ elBetBox.classList.remove("hidden"); elBetAmt.focus(); };
  $("#btn-send-bet").onclick = ()=>{ const v=parseInt(elBetAmt.value||"0",10); if(!v) return; doAction("bet",v); };

  // --- JOIN (sa table stranice) ---
  function openJoin(){
    if(!STATE) return;
    joinId.textContent = STATE.table.id;
    joinSeat.innerHTML = "";
    // napuni seats listu (sve pozicije, pa UI odluči)
    for(let i=0;i<STATE.table.seats;i++) joinSeat.innerHTML+=`<option value="${i}">Seat ${i+1}</option>`;
    // raspon
    const min = STATE.table.bb*50, max = STATE.table.bb*200;
    joinRange.textContent = `Buy-in: ${min} – ${max}`;
    joinBuy.value = min;
    joinBox.style.display="flex";
    joinMsg.textContent="";
  }
  btnOpenJoin.onclick = openJoin;
  $("#btn-close-join").onclick = ()=>{ joinBox.style.display="none"; };

  $("#btn-join-confirm").onclick = async ()=>{
    const seat_index = parseInt(joinSeat.value||"0",10);
    const buyin = parseInt(joinBuy.value||"0",10);
    const r = await fetch("/api/table/join",{
      method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",
      body:JSON.stringify({ table_id: TABLE_ID, seat_index, buyin })
    }).then(x=>x.json()).catch(()=>null);
    if(!r?.ok){ joinMsg.textContent = r?.error||"Greška"; return; }
    joinBox.style.display="none";
    await fetchState();
  };

  // --- TOP-UP ---
  function openTopup(){
    if(!STATE) return;
    const maxTotal = STATE.table.bb*200;
    const me = STATE.seats.find(x=>x.seat_index===STATE.me_seat);
    const current = me ? (me.stack|0) : 0;
    const canAdd = Math.max(0, maxTotal - current);
    topupHint.textContent = `Max ukupni stack: ${maxTotal} • Trenutno: ${current} • Možeš dodati do: ${canAdd}`;
    topupAmt.value = Math.min(STATE.table.bb, canAdd);
    topupAmt.max = canAdd;
    topupBox.style.display="flex";
    topupMsg.textContent="";
  }
  btnOpenTopup.onclick = openTopup;
  btnTopupClose.onclick = ()=>{ topupBox.style.display="none"; };

  btnTopupOk.onclick = async ()=>{
    const amount = parseInt(topupAmt.value||"0",10);
    if(!amount || amount<=0){ topupMsg.textContent="Unesi iznos > 0"; return; }
    const r = await fetch("/api/table/topup",{
      method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",
      body:JSON.stringify({ table_id: TABLE_ID, amount })
    }).then(x=>x.json()).catch(()=>null);
    if(!r?.ok){ topupMsg.textContent = r?.error||"Top-up nije podržan na serveru."; return; }
    topupBox.style.display="none";
    await fetchState();
  };

  // --- LEAVE (opcionalno, postojeća ruta) ---
  btnLeave.onclick = async ()=>{
    const r = await fetch("/api/table/leave",{
      method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",
      body:JSON.stringify({ table_id: TABLE_ID })
    }).then(x=>x.json()).catch(()=>null);
    if(r?.ok){ await fetchState(); }
  };

  // --- WS ---
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
