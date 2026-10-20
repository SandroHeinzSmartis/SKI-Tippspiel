// Pistentipp: Tippspiel für den FIS Ski-Alpin-Weltcup 2026/27.
// Daten: data/season.json + data/venues/*.json (von scripts/fis-sync.mjs aus FIS erzeugt),
// Spieler und Tipps: Supabase (Funktionen in supabase/migrations/).

const CFG = window.PISTENTIPP_CONFIG || {};
const DISC = {DH:"Abfahrt", SG:"Super-G", GS:"Riesenslalom", SL:"Slalom"};
const DISC_ORDER = ["DH","SG","GS","SL"];
const GEN = {W:"Damen", M:"Herren"};
const SCORE = {
  race:    {exact:5,  podium:2,  perfect:5},
  disc:    {exact:15, podium:6,  perfect:10},
  overall: {exact:25, podium:10, perfect:15},
  wmFactor: 2
};
const TZ = "Europe/Zurich";
const IOC2ISO = {SUI:"CH",AUT:"AT",ITA:"IT",FRA:"FR",GER:"DE",NOR:"NO",SWE:"SE",USA:"US",CAN:"CA",SLO:"SI",CRO:"HR",SVK:"SK",CZE:"CZ",POL:"PL",
  FIN:"FI",AND:"AD",BRA:"BR",GBR:"GB",NZL:"NZ",AUS:"AU",ESP:"ES",BEL:"BE",NED:"NL",ALB:"AL",LAT:"LV",BUL:"BG",MON:"MC",JPN:"JP",KOR:"KR",
  CHN:"CN",ARG:"AR",CHI:"CL",LIE:"LI",GRE:"GR",HUN:"HU",ISL:"IS",DEN:"DK",EST:"EE",UKR:"UA",BIH:"BA",MNE:"ME",SRB:"RS",ROU:"RO",TUR:"TR",
  ISR:"IL",IRL:"IE",LUX:"LU",POR:"PT",MEX:"MX",KAZ:"KZ",LTU:"LT",GEO:"GE",ARM:"AM",IRI:"IR",IND:"IN",RUS:"RU"};
const flag = ioc => { const c = IOC2ISO[ioc]; return c ? String.fromCodePoint(...[...c].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65)) : ""; };

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/ß/g,"ss").replace(/[øØ]/g,"o").replace(/[łŁ]/g,"l")
  .toLowerCase().replace(/[^a-z\s-]/g," ").replace(/-/g," ").replace(/\s+/g," ").trim();
function sameAthlete(a, b){
  const x = norm(a), y = norm(b);
  if(!x || !y) return false;
  if(x === y) return true;
  const xs = x.split(" "), ys = y.split(" ");
  if(xs.at(-1) !== ys.at(-1)) return false;
  if(xs.length === 1 || ys.length === 1) return true;
  return xs[0][0] === ys[0][0];
}
const slotNames = slot => String(slot || "").split("/").map(s => s.trim()).filter(Boolean);
function scorePodium(tip, result, w){
  if(!tip || !result) return null;
  let pts = 0, exact = 0, pod = 0;
  const all = result.flatMap(slotNames);
  for(let i = 0; i < 3; i++){
    const t = tip[i]; if(!t) continue;
    if(slotNames(result[i]).some(n => sameAthlete(n, t))){ pts += w.exact; exact++; }
    else if(all.some(n => sameAthlete(n, t))){ pts += w.podium; pod++; }
  }
  if(exact === 3) pts += w.perfect;
  return {pts, exact, pod};
}
const fmt = (d, o) => new Date(d).toLocaleString("de-CH", {timeZone:TZ, ...o});
const fmtDay = d => fmt(d, {day:"2-digit", month:"2-digit"});
const fmtWd = d => fmt(d, {weekday:"short"}).replace(".", "");
const fmtTime = d => fmt(d, {hour:"2-digit", minute:"2-digit"});
const fmtLong = d => fmt(d, {weekday:"long", day:"numeric", month:"long"});
const fmtMonth = d => fmt(d, {month:"long", year:"numeric"});
const now = () => Date.now();
const isLocked = r => now() >= Date.parse(r.start);
function ls(k, v){ try{ if(v === undefined) return localStorage.getItem(k); if(v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }catch{ return null; } }
function toast(msg){ const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 2600); }
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- API ---------- */
async function rpc(fn, args){
  if(!CFG.supabaseUrl || !CFG.supabaseAnonKey) throw new Error("Die App ist noch nicht mit der Datenbank verbunden (config.js).");
  const res = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/${fn}`, {method:"POST",
    // Neue Supabase-Keys (sb_publishable_…) gehören nur in den apikey-Header, alte JWT-Keys auch in Authorization.
    headers:{apikey:CFG.supabaseAnonKey, ...(CFG.supabaseAnonKey.startsWith("sb_") ? {} : {authorization:`Bearer ${CFG.supabaseAnonKey}`}), "content-type":"application/json"},
    body:JSON.stringify(args)});
  const body = await res.json().catch(() => null);
  if(!res.ok) throw new Error(body?.message || `Serverfehler (${res.status})`);
  if(body && body.error) throw new Error(body.error);
  return body;
}

/* ---------- state ---------- */
const S = {
  data:null, venues:{}, session:JSON.parse(ls("pt.session") || "null"),
  players:[], tips:[], gender: ls("pt.gender") === "M" ? "M" : "W",
  tab: ["rennen","saison","rangliste","profil"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "rennen",
  filter:"all", sheets:[]
};
const races = g => (S.data?.races || []).filter(r => !g || r.gender === g).sort((a,b) => a.start.localeCompare(b.start));
const raceById = id => (S.data?.races || []).find(r => r.id === id);
const myId = () => S.session?.id;
const tipOf = (pid, kind, key) => S.tips.find(t => t.p === pid && t.k === kind && t.key === key);
const playerName = id => S.players.find(p => p.id === id)?.name || "?";
function cupDeadline(key){
  const [g, d] = key.split("_");
  return races(g).find(r => r.status !== "cancelled" && !r.wm && (d === "OVR" || r.disc === d))?.start || null;
}
function cupFinal(key){
  const [g, d] = key.split("_");
  const rel = races(g).filter(r => !r.wm && r.status !== "cancelled" && (d === "OVR" || r.disc === d));
  if(!rel.length || rel.some(r => r.status !== "done")) return null;
  const st = S.data.standings?.cur?.[g]?.[d] || [];
  return st.length >= 3 ? st.slice(0, 3).map(a => a.name) : null;
}
// Vorschläge: aktueller Weltcupstand der Disziplin, aufgefüllt mit der Vorsaison
function suggestions(g, d){
  const cur = S.data.standings?.cur?.[g]?.[d] || [];
  const prev = S.data.standings?.prev?.[g]?.[d] || [];
  const out = cur.map((a, i) => ({...a, rank:i + 1, src:"cur"}));
  for(const a of prev){ if(out.length >= 30) break; if(!out.some(x => sameAthlete(x.name, a.name))) out.push({...a, rank:null, prevRank:prev.indexOf(a) + 1, src:"prev"}); }
  return out.slice(0, 30);
}
function allAthletes(g){ return (S.data.athletes?.[g] || []).map(([name, nat]) => ({name, nat})); }
async function venue(key){
  if(!key) return [];
  if(!S.venues[key]) S.venues[key] = fetch(`data/venues/${key}.json`).then(r => r.ok ? r.json() : []).catch(() => []);
  return S.venues[key];
}

async function loadData(){
  const res = await fetch("data/season.json", {cache:"no-cache"});
  if(!res.ok) throw new Error("Kalender konnte nicht geladen werden.");
  S.data = await res.json();
}
async function loadState(){
  if(!S.session) return;
  try{
    const st = await rpc("get_state", {p_token:S.session.token});
    S.players = st.players; S.tips = st.tips;
  }catch(e){
    if(/neu an/.test(e.message)){ S.session = null; ls("pt.session", null); }
    else toast(e.message);
  }
}

/* ---------- scoring ---------- */
function standings(){
  const rows = Object.fromEntries(S.players.map(p => [p.id, {id:p.id, total:0, race:0, wm:0, disc:0, overall:0, exact:0}]));
  for(const r of S.data.races){
    if(r.status !== "done" || !r.podium) continue;
    for(const t of S.tips.filter(t => t.k === "race" && t.key === r.id)){
      const s = scorePodium(t.picks, r.podium, SCORE.race); if(!s || !rows[t.p]) continue;
      const pts = s.pts * (r.wm ? SCORE.wmFactor : 1);
      rows[t.p].total += pts; rows[t.p][r.wm ? "wm" : "race"] += pts; rows[t.p].exact += s.exact;
    }
  }
  for(const g of ["W","M"]) for(const d of ["OVR", ...DISC_ORDER]){
    const key = `${g}_${d}`, fin = cupFinal(key); if(!fin) continue;
    for(const t of S.tips.filter(t => t.k === "cup" && t.key === key)){
      const s = scorePodium(t.picks, fin, d === "OVR" ? SCORE.overall : SCORE.disc); if(!s || !rows[t.p]) continue;
      rows[t.p].total += s.pts; rows[t.p][d === "OVR" ? "overall" : "disc"] += s.pts; rows[t.p].exact += s.exact;
    }
  }
  return Object.values(rows).sort((a,b) => b.total - a.total || b.exact - a.exact);
}

/* ---------- icons ---------- */
const MTN = `<svg class="mountains" viewBox="0 0 400 150" preserveAspectRatio="none" aria-hidden="true">
  <path class="far" d="M-20 150 L40 70 L70 92 L120 38 L165 88 L205 58 L250 100 L300 46 L345 86 L380 64 L430 110 L430 150Z"/>
  <path class="mid" d="M-20 150 L30 104 L80 120 L140 66 L190 112 L235 84 L290 124 L340 80 L420 128 L420 150Z"/>
  <path class="snowcap" d="M140 66 L124 81 L134 79 L141 86 L150 77 L157 80Z M340 80 L326 93 L335 91 L342 97 L350 89 L356 92Z M235 84 L224 94 L232 93 L238 98Z"/>
  <path class="near" d="M-20 150 L-20 138 C60 126 120 140 200 132 C280 124 330 138 420 128 L420 150Z"/></svg>`;
const ICON = {
  rennen:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 21V4"/><path d="M5 4h10l-2 3 2 3H5"/><path d="M19 21V11"/></svg>`,
  saison:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="9" r="6"/><path d="M8 20h8M12 15v5M9.5 7.5a3 3 0 0 1 3-2"/></svg>`,
  rangliste:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 20h18M9 20V8h6v12M3 20v-7h6M15 20v-5h6v5"/></svg>`,
  profil:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2l1.8 4.6L18 4l-2.6 4.2L20 10l-4.6 1.8L18 16l-4.2-2.6L12 18l-1.8-4.6L6 16l2.6-4.2L4 10l4.6-1.8L6 4l4.2 2.6z"/></svg>`
};
// Torflaggen: Speed blau, Technik rot, Slalom rot/blau
function gateIcon(d){
  const c = {DH:["#1f6fe5"], SG:["#1f6fe5","#7b5cff"], GS:["#e2323f"], SL:["#e2323f","#1f6fe5"]}[d];
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="2" width="2" height="20" rx="1" fill="#8aa0b8"/>
    <path d="M5 3h12l-3 4 3 4H5z" fill="${c[0]}"/>${c[1] ? `<rect x="19" y="8" width="2" height="14" rx="1" fill="#8aa0b8"/><path d="M19 9h-6l1.5 2.5L13 14h6z" fill="${c[1]}"/>` : ""}</svg>`;
}

/* ---------- views ---------- */
function render(){
  const app = $("#app");
  if(!S.data) return;
  if(!S.session){ app.innerHTML = loginView(); bindLogin(); return; }
  app.innerHTML = heroView() + `<main id="main">${tabView()}</main>` + tabbar();
  startCountdown();
  if(S.tab === "rennen" && !render.scrolled){ render.scrolled = true; requestAnimationFrame(() => $(".race.next")?.scrollIntoView({block:"center"})); }
}
function heroView(){
  const nx = races(S.gender).find(r => r.status !== "cancelled" && !isLocked(r));
  const mine = nx && tipOf(myId(), "race", nx.id);
  return `<header class="hero">
    <div class="hero-top"><span class="logo">Pisten<b>tipp</b></span><span class="season-pill">WC 26/27</span><span class="me-pill">${esc(S.session.name)}</span></div>
    <div class="gender" role="group" aria-label="Damen oder Herren">
      <button data-gender="W" aria-pressed="${S.gender === "W"}">Damen</button><button data-gender="M" aria-pressed="${S.gender === "M"}">Herren</button></div>
    <div class="next">${nx ? `
      <div class="next-label">Nächstes Rennen · ${GEN[nx.gender]}</div>
      <div class="next-title">${esc(nx.place)} · ${DISC[nx.disc]}</div>
      <div class="next-meta">${fmtLong(nx.start)}, ${fmtTime(nx.start)} Uhr${nx.wm ? " · WM zählt doppelt" : ""}</div>
      <div class="countdown" data-until="${nx.start}"></div>
      <button class="next-cta ${mine ? "done" : ""}" data-race="${nx.id}">${mine ? "Tipp ansehen" : "Jetzt tippen"} →</button>`
      : `<div class="next-title">Saison beendet</div><div class="next-meta">Schau in die Rangliste.</div>`}
    </div>${MTN}</header>`;
}
let cdTimer;
function startCountdown(){
  clearInterval(cdTimer);
  const el = $(".countdown"); if(!el) return;
  const tick = () => {
    const ms = Date.parse(el.dataset.until) - now();
    if(ms <= 0){ clearInterval(cdTimer); render(); return; }
    const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1e3) % 60;
    el.innerHTML = [[d,"Tage"],[h,"Std"],[m,"Min"],[s,"Sek"]].map(([v,l]) => `<div class="cd"><b>${String(v).padStart(2,"0")}</b><span>${l}</span></div>`).join("");
  };
  tick(); cdTimer = setInterval(tick, 1000);
}
function tabbar(){
  const t = [["rennen","Rennen"],["saison","Saison"],["rangliste","Rangliste"],["profil","Regeln"]];
  return `<nav class="tabbar" role="tablist">${t.map(([k,l]) => `<button role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${ICON[k]}${l}</button>`).join("")}</nav>`;
}
function tabView(){
  if(S.tab === "saison") return seasonView();
  if(S.tab === "rangliste") return leaderboardView();
  if(S.tab === "profil") return rulesView();
  return racesView();
}

function racesView(){
  const all = races(S.gender);
  const f = S.filter;
  const list = all.filter(r => f === "all" || (f === "WM" ? r.wm : r.disc === f));
  const nextId = all.find(r => r.status !== "cancelled" && !isLocked(r))?.id;
  const done = all.filter(r => r.status === "done").length;
  let out = `<div class="section-h"><h2>${GEN[S.gender]}-Kalender</h2><span class="hint">${done} von ${all.length} gefahren</span></div>
    <div class="filters">${[["all","Alle"],["DH","Abfahrt"],["SG","Super-G"],["GS","Riesenslalom"],["SL","Slalom"],["WM","WM"]]
      .map(([k,l]) => `<button class="chipbtn" data-filter="${k}" aria-pressed="${f === k}">${l}</button>`).join("")}</div>`;
  if(!list.length) return out + `<div class="empty"><b>Keine Rennen</b>Für diesen Filter steht nichts im Kalender.</div>`;
  out += `<div class="course">`;
  let month = "";
  for(const r of list){
    const m = fmtMonth(r.start);
    if(m !== month){ month = m; out += `<div class="month">${m}</div>`; }
    out += raceRow(r, r.id === nextId);
  }
  return out + `</div>${S.data.bootstrap ? `<p class="hint">Vorläufiger Kalender. Sobald der FIS-Abgleich gelaufen ist, stehen hier die offiziellen Termine.</p>` : `<p class="hint">FIS-Daten von ${fmt(S.data.updated, {day:"numeric", month:"numeric", hour:"2-digit", minute:"2-digit"})}</p>`}`;
}
function raceRow(r, isNext){
  const mine = tipOf(myId(), "race", r.id);
  let state;
  if(r.status === "cancelled") state = `<span class="r-state closed">abgesagt</span>`;
  else if(r.status === "done"){
    const s = mine ? scorePodium(mine.picks, r.podium, SCORE.race) : null;
    state = `<span class="r-state closed">${s ? `<span class="pts">${s.pts * (r.wm ? SCORE.wmFactor : 1)}</span>Punkte` : "kein Tipp"}</span>`;
  } else if(isLocked(r)) state = `<span class="r-state closed">${mine ? "getippt" : "kein Tipp"}<br>läuft</span>`;
  else state = mine ? `<span class="r-state tipped">✓ getippt</span>` : `<span class="r-state open">tippen<br>bis ${fmtTime(r.start)}</span>`;
  return `<div class="race ${isNext ? "next" : ""} ${r.status === "cancelled" ? "cancelled" : ""}">
    <span class="gate">${gateIcon(r.disc)}</span>
    <button class="race-card" data-race="${r.id}">
      <span class="r-date"><b>${fmtDay(r.start)}</b><span>${fmtWd(r.start)}</span></span>
      <span class="r-main"><span class="r-place">${esc(r.place)}</span>
        <span class="r-meta">${DISC[r.disc]} ${flag(r.nation)}${r.wm ? ` <span class="tag wm">WM ×2</span>` : ""}${r.timeKnown === false ? ` <span class="tag est">Zeit offen</span>` : ""}</span>
        ${r.status === "done" ? `<span class="mini-podium">${r.podium.map((n,i) => `<span><span class="medal m${i+1}">${i+1}</span>${esc(n)}</span>`).join("")}</span>` : ""}
      </span>${state}
    </button></div>`;
}

function seasonView(){
  const g = S.gender;
  let out = `<div class="section-h"><h2>Kristallkugeln</h2><span class="hint">${GEN[g]}</span></div>
    <p class="hint">Tippe die Top 3 jeder Weltcup-Wertung. Tippschluss ist das erste Rennen der Wertung, für den Gesamtweltcup der Saisonstart.</p>`;
  for(const d of ["OVR", ...DISC_ORDER]){
    const key = `${g}_${d}`, dl = cupDeadline(key), lk = dl && now() >= Date.parse(dl);
    const mine = tipOf(myId(), "cup", key), fin = cupFinal(key), w = d === "OVR" ? SCORE.overall : SCORE.disc;
    const s = fin && mine ? scorePodium(mine.picks, fin, w) : null;
    out += `<button class="card race-card" style="grid-template-columns:auto 1fr auto;margin-bottom:10px" data-cup="${key}">
      <span class="gate" style="position:static">${d === "OVR" ? ICON.saison : gateIcon(d)}</span>
      <span class="r-main"><span class="r-place">${d === "OVR" ? "Gesamtweltcup" : DISC[d]}</span>
        <span class="r-meta">${mine ? mine.picks.map(esc).join(" · ") : "noch kein Tipp"}</span></span>
      <span class="r-state ${s ? "closed" : lk ? "closed" : mine ? "tipped" : "open"}">${s ? `<span class="pts">${s.pts}</span>Punkte` : lk ? "zu" : dl ? `bis ${fmtDay(dl)}` : ""}</span>
    </button>`;
  }
  return out;
}

function leaderboardView(){
  const rows = standings();
  if(!rows.length) return `<div class="empty"><b>Noch leer</b>Sobald jemand mitspielt, erscheint hier die Rangliste.</div>`;
  const max = Math.max(1, ...rows.map(r => r.total));
  const done = S.data.races.filter(r => r.status === "done").length;
  return `<div class="section-h"><h2>Rangliste</h2><span class="hint">${done} Rennen gewertet</span></div>
    <div class="card">${rows.map((r, i) => `<div class="lb-row ${i < 3 ? "top" + (i+1) : ""} ${r.id === myId() ? "me" : ""}">
      <span class="lb-rank">${i + 1}</span>
      <span><span class="lb-name">${esc(playerName(r.id))}</span><div class="lb-bar"><i style="width:${(r.total / max * 100).toFixed(1)}%;animation-delay:${i * 60}ms"></i></div>
        <span class="hint">Rennen ${r.race} · WM ${r.wm} · Kugeln ${r.disc + r.overall} · ${r.exact} exakt</span></span>
      <span class="lb-pts">${r.total}<small>Pkt</small></span></div>`).join("")}</div>
    <p class="hint">Damen und Herren zusammen. Bei Punktgleichheit entscheidet die Zahl exakter Treffer.</p>`;
}

function rulesView(){
  const r = SCORE.race, d = SCORE.disc, o = SCORE.overall;
  return `<div class="section-h"><h2>Regeln</h2></div>
  <div class="card rules"><h3>Jedes Rennen</h3><dl>
    <dt>Richtige Person, richtiger Platz</dt><dd>${r.exact}</dd><dt>Auf dem Podest, falscher Platz</dt><dd>${r.podium}</dd>
    <dt>Ganzes Podest exakt</dt><dd>+${r.perfect}</dd><dt>Maximum</dt><dd>${3*r.exact + r.perfect}</dd></dl>
    <h3>WM Crans-Montana</h3><dl><dt>Alle Punkte</dt><dd>×${SCORE.wmFactor}</dd><dt>Maximum pro Rennen</dt><dd>${(3*r.exact + r.perfect) * SCORE.wmFactor}</dd></dl>
    <h3>Disziplinen-Weltcup</h3><dl><dt>Richtiger Platz</dt><dd>${d.exact}</dd><dt>Auf dem Podest</dt><dd>${d.podium}</dd><dt>Alle drei exakt</dt><dd>+${d.perfect}</dd><dt>Maximum</dt><dd>${3*d.exact + d.perfect}</dd></dl>
    <h3>Gesamtweltcup</h3><dl><dt>Richtiger Platz</dt><dd>${o.exact}</dd><dt>Auf dem Podest</dt><dd>${o.podium}</dd><dt>Alle drei exakt</dt><dd>+${o.perfect}</dd><dt>Maximum</dt><dd>${3*o.exact + o.perfect}</dd></dl>
    <p class="hint">Tippschluss ist der Start des 1. Laufs. Die Tipps der anderen siehst du erst danach. Resultate kommen direkt von der FIS, meist kurz nach dem Rennen.</p>
  </div>
  <div class="card"><h3>Auf den Homescreen</h3>
    <p style="margin:4px 0 0">iPhone: In Safari auf Teilen tippen, dann „Zum Home-Bildschirm“. Android: Im Chrome-Menü „App installieren“.</p></div>
  <div class="card"><h3>Angemeldet als ${esc(S.session.name)}</h3>
    <p class="hint" style="margin:4px 0 10px">Auf einem anderen Gerät meldest du dich mit Gruppencode, deinem Namen und deiner PIN an.</p>
    <button class="btn ghost" data-act="logout">Abmelden</button></div>`;
}

/* ---------- login ---------- */
function loginView(){
  return `<div class="login">
    <div class="login-top"><h1>Pisten<b>tipp</b><br>26/27</h1>
      <p>Das Tippspiel für den Ski-Weltcup. Tippe jedes Podest, die Kristallkugeln und die WM in Crans-Montana.</p></div>
    ${MTN}
    <form class="login-form" id="login" autocomplete="on">
      <div class="field"><label for="code">Gruppencode</label><input id="code" autocomplete="off" autocapitalize="characters" required value="${esc(new URLSearchParams(location.search).get("code") || ls("pt.code") || "")}"></div>
      <div class="field"><label for="name">Dein Name</label><input id="name" autocomplete="nickname" maxlength="30" required></div>
      <div class="field"><label for="pin">PIN (4 Ziffern)</label><input id="pin" class="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password" required></div>
      <div class="err" id="login-err"></div>
      <button class="btn red block" type="submit">Mitspielen</button>
      <p class="hint" style="margin:0">Neu? Wähle einfach Name und PIN. Schon dabei? Gleicher Name, gleiche PIN.</p>
    </form></div>`;
}
function bindLogin(){
  $("#login").addEventListener("submit", async e => {
    e.preventDefault();
    const btn = e.target.querySelector("button"); btn.disabled = true; $("#login-err").textContent = "";
    try{
      const code = $("#code").value.trim().toUpperCase();
      const r = await rpc("join_or_login", {p_code:code, p_name:$("#name").value, p_pin:$("#pin").value});
      S.session = {token:r.token, id:r.id, name:r.name}; ls("pt.session", JSON.stringify(S.session)); ls("pt.code", code);
      await loadState(); render(); toast(r.created ? `Willkommen, ${r.name}!` : `Hallo ${r.name}`);
    }catch(err){ $("#login-err").textContent = err.message; btn.disabled = false; }
  });
}

/* ---------- sheets ---------- */
function openSheet(html, {plain = false, onMount} = {}){
  const top = S.sheets.length > 0;
  const bd = document.createElement("div"); bd.className = "sheet-backdrop" + (top ? " top" : "");
  const sh = document.createElement("div"); sh.className = "sheet" + (top ? " top" : ""); sh.setAttribute("role", "dialog"); sh.setAttribute("aria-modal", "true");
  sh.innerHTML = html.replace('class="sheet-head', `class="sheet-head${plain ? " plain" : ""}`);
  $("#sheet-root").append(bd, sh);
  const entry = {bd, sh};
  S.sheets.push(entry);
  bd.addEventListener("click", () => closeSheet(entry));
  sh.querySelector(".sheet-close")?.addEventListener("click", () => closeSheet(entry));
  requestAnimationFrame(() => { bd.classList.add("on"); sh.classList.add("on"); });
  document.body.style.overflow = "hidden";
  onMount?.(sh);
  return entry;
}
function closeSheet(entry = S.sheets.at(-1)){
  if(!entry) return;
  S.sheets = S.sheets.filter(s => s !== entry);
  entry.bd.classList.remove("on"); entry.sh.classList.remove("on");
  setTimeout(() => { entry.bd.remove(); entry.sh.remove(); }, 320);
  if(!S.sheets.length) document.body.style.overflow = "";
}
const head = (title, sub) => `<div class="sheet-head"><div class="grab"></div><button class="sheet-close" aria-label="Schliessen">×</button>
  <h2 class="sheet-title">${title}</h2>${sub ? `<div class="sheet-sub">${sub}</div>` : ""}</div>`;

// Tipp-Sheet für Rennen und Kristallkugeln
async function openTip(kind, key){
  const race = kind === "race" ? raceById(key) : null;
  const [g, d] = race ? [race.gender, race.disc] : key.split("_");
  const deadline = race ? race.start : cupDeadline(key);
  const locked = race ? isLocked(race) : (deadline && now() >= Date.parse(deadline));
  const mine = tipOf(myId(), kind, key);
  const draft = mine ? [...mine.picks] : [null, null, null];
  const result = race ? (race.status === "done" ? race.podium : null) : cupFinal(key);
  const title = race ? `${esc(race.place)} ${flag(race.nation)}` : (d === "OVR" ? "Gesamtweltcup" : `${DISC[d]}-Weltcup`);
  const sub = race ? `${DISC[d]} ${GEN[g]} · ${fmtLong(race.start)}, ${fmtTime(race.start)} Uhr${race.wm ? " · WM ×2" : ""}`
                   : `${GEN[g]} · ${deadline ? `Tippschluss ${fmtLong(deadline)}, ${fmtTime(deadline)}` : "noch kein Rennen im Kalender"}`;
  const w = race ? SCORE.race : d === "OVR" ? SCORE.overall : SCORE.disc;
  const factor = race?.wm ? SCORE.wmFactor : 1;

  const sheet = openSheet(head(title, sub) + `<div class="sheet-body">
      <div id="tip-zone"></div>
      ${race ? `<div class="section-h"><h2>Podeste der letzten 5 Jahre</h2></div><div class="card" id="hist"><span class="hint">Historie wird geladen …</span></div>` : ""}
    </div>`);
  const zone = $("#tip-zone", sheet.sh);

  const podiumHTML = (names, {editable, cls = ""}) => `<div class="podium ${cls}">${[1,0,2].map(i => `<div class="step">
      <button class="slot ${names[i] ? "filled" : ""}" data-slot="${i}" ${editable ? "" : "disabled"}>
        ${names[i] ? `<span class="nm">${esc(names[i])}</span>` : `<span class="ph">${editable ? "Wählen" : "–"}</span>`}</button>
      <div class="block p${i+1}">${i+1}</div></div>`).join("")}</div>`;

  function paint(){
    let h = "";
    if(result){
      h += `<div class="card"><h3>Resultat</h3>${podiumHTML(result, {editable:false, cls:"rise"})}</div>`;
    }
    if(!locked){
      h += `<div class="card"><h3>Dein Tipp</h3><p class="hint" style="margin:0">Tippe auf einen Platz und wähle die Fahrerin oder den Fahrer.</p>
        ${podiumHTML(draft, {editable:true})}
        <button class="btn red block" id="save" ${draft.every(Boolean) ? "" : "disabled"}>${mine ? "Tipp ändern" : "Tipp abgeben"}</button>
        <p class="hint" style="margin:8px 0 0">Bis ${fmtWd(deadline)} ${fmtDay(deadline)} ${fmtTime(deadline)} änderbar. Die Tipps der anderen siehst du danach.</p></div>`;
    } else {
      h += `<div class="card"><h3>Alle Tipps</h3>${othersTable(kind, key, result, w, factor, deadline)}
        ${!result ? `<p class="hint" style="margin:8px 0 0">Punkte gibt es, sobald das Resultat da ist.</p>` : ""}</div>`;
    }
    zone.innerHTML = h;
    zone.querySelectorAll("[data-slot]").forEach(b => b.addEventListener("click", () => openPicker({g, d, race, draft, slot:+b.dataset.slot, onPick:paint})));
    $("#save", zone)?.addEventListener("click", async e => {
      e.target.disabled = true;
      try{
        await rpc("save_tip", {p_token:S.session.token, p_kind:kind, p_key:key, p_picks:draft});
        await loadState(); toast("Tipp gespeichert"); snowBurst(e.target); closeSheet(sheet); render();
      }catch(err){ toast(err.message); e.target.disabled = false; }
    });
  }
  paint();
  if(race) venue(race.venue).then(list => {
    const past = list.filter(x => x.s < S.data.season && x.r.length >= 3).slice(0, 5);
    $("#hist", sheet.sh).innerHTML = past.length ? past.map(x => `<div class="hist-year"><span class="y">${x.d.slice(0,4)}${x.wm ? "<br>WM" : ""}</span>
        <span class="hist-names">${[1,2,3].map(p => x.r.filter(a => a[0] === p).map(a => `<span><span class="medal m${p}">${p}</span>${esc(a[1])} ${flag(a[2])}</span>`).join("")).join("")}</span></div>`).join("")
      : `<span class="hint">Hier gab es in den letzten Jahren kein ${DISC[d]}-Rennen der ${GEN[g]}.</span>`;
  });
}
function othersTable(kind, key, result, w, factor, deadline){
  const tips = S.tips.filter(t => t.k === kind && t.key === key);
  if(!tips.length) return `<p class="hint">Niemand hat getippt.</p>`;
  const rows = tips.map(t => ({t, s: result ? scorePodium(t.picks, result, w) : null})).sort((a,b) => (b.s?.pts ?? -1) - (a.s?.pts ?? -1));
  const mark = (n, i) => {
    if(!result) return esc(n);
    if(slotNames(result[i]).some(x => sameAthlete(x, n))) return `<span class="hit">${esc(n)}</span>`;
    if(result.flatMap(slotNames).some(x => sameAthlete(x, n))) return `<span class="near">${esc(n)}</span>`;
    return esc(n);
  };
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Wer</th><th>1 · 2 · 3</th><th class="num">Pkt</th></tr></thead><tbody>
    ${rows.map(({t, s}) => `<tr class="${t.p === myId() ? "me" : ""}"><td>${esc(playerName(t.p))}</td><td>${t.picks.map(mark).join(" · ")}</td>
      <td class="num">${s ? s.pts * factor : "–"}</td></tr>`).join("")}</tbody></table></div>`;
}

// Fahrerwahl mit Top 30 und Historie am Ort
function openPicker({g, d, race, draft, slot, onPick}){
  const list = suggestions(g, d);
  const extra = allAthletes(g);
  const label = d === "OVR" ? "Gesamtweltcup" : DISC[d];
  const src = list.some(a => a.src === "cur") ? `Stand ${label}-Weltcup 26/27` : `Top 30 ${label} Saison 25/26`;
  const sheet = openSheet(head(`Platz ${slot + 1} wählen`, `${src}${race ? ` · tippe auf einen Namen für die Historie in ${esc(race.place)}` : ""}`) +
    `<div class="sheet-body"><div class="search"><input id="q" type="search" placeholder="Name suchen" autocomplete="off"></div><div id="ath-list"></div></div>`, {plain:true});
  const box = $("#ath-list", sheet.sh);
  let openName = null;
  function rows(q){
    const nq = norm(q);
    let items = list;
    if(nq){
      const pool = [...list, ...extra.filter(a => !list.some(x => sameAthlete(x.name, a.name)))];
      items = pool.filter(a => norm(a.name).includes(nq));
      if(!items.some(a => norm(a.name) === nq)) items.push({name:q.trim(), nat:null, custom:true});
    }
    box.innerHTML = items.map(a => {
      const taken = draft.some((n, i) => i !== slot && n && sameAthlete(n, a.name));
      return `<div class="ath ${taken ? "taken" : ""}" data-name="${esc(a.name)}">
        <button class="ath-row" data-toggle="${esc(a.name)}">
          <span class="ath-rank">${a.rank ?? (a.prevRank ? `<small>${a.prevRank}</small>` : "")}</span>
          <span class="ath-name">${flag(a.nat)} ${esc(a.name)}${a.custom ? "<small>eigener Eintrag</small>" : taken ? "<small>schon getippt</small>" : ""}</span>
          <span class="ath-pts">${a.pts ? a.pts + " P" : ""}</span></button>
        ${openName === a.name ? `<div class="ath-detail" data-detail></div>` : ""}</div>`;
    }).join("") || `<p class="hint">${nq ? "Keine Treffer." : "Die Weltcup-Ränge sind noch nicht geladen. Tippe einen Namen ins Suchfeld."}</p>`;
    if(openName) fillDetail();
  }
  async function fillDetail(){
    const el = $("[data-detail]", box); if(!el) return;
    const name = openName;
    let hist = "";
    if(race){
      el.innerHTML = `<p class="hint">Historie wird geladen …</p>`;
      const v = await venue(race.venue);
      if(openName !== name) return;
      const res = v.map(x => ({y:x.d.slice(0,4), wm:x.wm, hit:x.r.find(a => sameAthlete(a[1], name))})).filter(x => x.hit);
      hist = res.length ? `<div class="hist">${res.map(x => `<span class="res-chip ${x.hit[0] <= 3 ? "p" + x.hit[0] : ""}">${x.y}${x.wm ? " WM" : ""}: ${x.hit[0]}.</span>`).join("")}</div>
          <p class="hint" style="margin:0 0 10px">${res.length} Resultate in ${esc(race.place)}, bestes: ${Math.min(...res.map(x => x.hit[0]))}.</p>`
        : `<p class="hint">Noch kein Resultat in ${esc(race.place)} (${DISC[d]}) in den letzten 10 Jahren.</p>`;
    }
    el.innerHTML = hist + `<div class="place-btns">${[0,1,2].map(i => `<button class="btn ${i === slot ? "red" : "ghost"}" data-set="${i}">Platz ${i+1}</button>`).join("")}</div>`;
    el.querySelectorAll("[data-set]").forEach(b => b.addEventListener("click", () => choose(name, +b.dataset.set)));
  }
  function choose(name, i){
    for(let k = 0; k < 3; k++) if(k !== i && draft[k] && sameAthlete(draft[k], name)) draft[k] = null;
    draft[i] = name; onPick(); closeSheet(sheet);
  }
  box.addEventListener("click", e => {
    const t = e.target.closest("[data-toggle]"); if(!t) return;
    const n = t.dataset.toggle;
    if(!race){ choose(n, slot); return; }        // ohne Rennen keine Historie: direkt übernehmen
    openName = openName === n ? null : n; rows($("#q", sheet.sh).value);
  });
  $("#q", sheet.sh).addEventListener("input", e => rows(e.target.value));
  rows("");
}

/* ---------- events ---------- */
document.addEventListener("click", e => {
  const t = e.target.closest("[data-tab],[data-gender],[data-filter],[data-race],[data-cup],[data-act]");
  if(!t || t.closest(".sheet")) return;
  if(t.dataset.tab){ S.tab = t.dataset.tab; try{ history.replaceState(null, "", "#" + S.tab); }catch{} render(); scrollTo({top:0}); }
  else if(t.dataset.gender){ S.gender = t.dataset.gender; ls("pt.gender", S.gender); render.scrolled = false; render(); }
  else if(t.dataset.filter){ S.filter = t.dataset.filter; render(); }
  else if(t.dataset.race) openTip("race", t.dataset.race);
  else if(t.dataset.cup) openTip("cup", t.dataset.cup);
  else if(t.dataset.act === "logout"){ S.session = null; ls("pt.session", null); render(); }
});
document.addEventListener("keydown", e => { if(e.key === "Escape") closeSheet(); });
document.addEventListener("visibilitychange", async () => {
  if(document.visibilityState === "visible" && S.session){ await Promise.all([loadData().catch(() => {}), loadState()]); if(!S.sheets.length) render(); }
});

/* ---------- Schnee ---------- */
const snow = (() => {
  const c = $("#snow"), ctx = c.getContext("2d");
  let flakes = [], w, h, dpr;
  function size(){ dpr = Math.min(2, devicePixelRatio || 1); w = c.width = innerWidth * dpr; h = c.height = innerHeight * dpr; }
  function make(n){ for(let i = 0; i < n; i++) flakes.push({x:Math.random() * w, y:Math.random() * h, r:(Math.random() * 2 + .6) * dpr, s:Math.random() * .6 + .3, o:Math.random() * Math.PI * 2}); }
  function frame(t){
    ctx.clearRect(0, 0, w, h);
    const limit = (document.querySelector(".hero, .login")?.getBoundingClientRect().bottom ?? 0) * dpr;
    ctx.fillStyle = "rgba(255,255,255,.85)";
    for(const f of flakes){
      f.y += f.s * dpr; f.x += Math.sin(t / 1500 + f.o) * .3 * dpr;
      if(f.y > limit || f.y > h){ f.y = -5; f.x = Math.random() * w; }
      if(f.y < limit){ ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 7); ctx.fill(); }
    }
    requestAnimationFrame(frame);
  }
  if(!reduceMotion){ size(); make(90); addEventListener("resize", size); requestAnimationFrame(frame); }
})();
function snowBurst(el){
  if(reduceMotion || !el) return;
  const r = el.getBoundingClientRect();
  for(let i = 0; i < 14; i++){
    const s = document.createElement("span"); s.className = "burst"; s.textContent = "❄";
    s.style.left = r.left + r.width / 2 + "px"; s.style.top = r.top + "px"; document.body.append(s);
    const a = Math.random() * Math.PI * 2, dist = 60 + Math.random() * 80;
    s.animate([{transform:"translate(0,0) scale(1)", opacity:1}, {transform:`translate(${Math.cos(a) * dist}px,${Math.sin(a) * dist - 40}px) scale(.4) rotate(180deg)`, opacity:0}],
      {duration:900 + Math.random() * 400, easing:"cubic-bezier(.2,.8,.2,1)"}).onfinish = () => s.remove();
  }
}

/* ---------- start ---------- */
(async () => {
  try{ await loadData(); }
  catch(e){ $("#app").innerHTML = `<div class="boot"><div class="boot-mark">Pistentipp</div><div class="boot-sub">${esc(e.message)} Prüfe die Verbindung und lade neu.</div></div>`; return; }
  await loadState();
  render();
  if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
