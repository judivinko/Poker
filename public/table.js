const tableId = new URLSearchParams(location.search).get("id");
let me = null;
let state = null;

async function loadMe(){
  const r = await fetch("/api/me").then(r=>r.json());
  if(r.ok) me = r.user;
}
async function loadState(){
  const r = await fetch(`/api/table/${tableId}/state`).then(r=>r.json());
  if(!r.ok) return;
  state = r.state;
  render();
}

async function join(){
  await fetch(`/api/table/${tableId}/join`,{method:"POST"}).then(r=>r.json());
  loadState();
}

function render(){
  const t = document.getElementById("table");
  t.dataset.seats = state.seats.length;
  document.getElementById("status").textContent = `Stol #${tableId}`;

  state.seats.forEach(s=>{
    const seat = document.querySelector(`.seat[data-i="${s.index}"]`);
    if(!seat) return;
    const avatar = seat.querySelector(".avatar");
    const nick = seat.querySelector(".nick");
    const stack = seat.querySelector(".stack");
    if(!s.user){
      seat.className="seat empty";
      avatar.className="avatar placeholder";
      nick.textContent="";
      stack.textContent="";
    } else {
      seat.className="seat player" + (s.user.id===me.id ? " me" : "");
      avatar.className="avatar player";
      avatar.src="/images/avatars/avatar_1.png";
      nick.textContent=s.user.email.split("@")[0];
      stack.textContent=s.stack + "♠";
    }
  });

  const board = document.getElementById("board");
  board.innerHTML="";
  state.board.forEach(c=>{
    const card=document.createElement("div");
    card.className="card";
    card.style.backgroundImage=`url(/images/cards/${c}.png)`;
    board.appendChild(card);
  });
}

function fold(){ action("fold"); }
function check(){ action("check"); }
function call(){ action("call"); }
function bet(){ let x=prompt("Koliko čipova?"); action("bet",parseInt(x)) }

async function action(type,amount=0){
  await fetch(`/api/table/${tableId}/action`,{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({type,amount})
  });
}

loadMe().then(join).then(loadState);
setInterval(loadState,1500);
