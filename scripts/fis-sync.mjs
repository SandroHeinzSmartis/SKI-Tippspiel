// Holt Kalender, Resultate und Historie von fis-ski.com und schreibt sie nach data/.
// Läuft als GitHub-Action (siehe .github/workflows/fis-sync.yml), lokal: node scripts/fis-sync.mjs
import { load } from "cheerio";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = path.join(ROOT, "data");
const CACHE = path.join(DATA, "cache");
const SEASON = Number(process.env.SEASON || 2027);          // FIS-Saisoncode: 2027 = Winter 2026/27
const HISTORY_SEASONS = Number(process.env.HISTORY_SEASONS || 10);
const DEBUG = !!process.env.DEBUG;
const BASE = "https://www.fis-ski.com/DB";

const DISC = [
  [/super[\s-]?g/i, "SG"], [/giant/i, "GS"], [/downhill/i, "DH"], [/^(?!.*parallel)(?!.*combined).*slalom/i, "SL"],
];
const WC_POINTS = [100,80,60,50,45,40,36,32,29,26,24,22,20,18,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1];
const TZ_BY_NATION = {AUT:"Europe/Vienna",SUI:"Europe/Zurich",ITA:"Europe/Rome",FRA:"Europe/Paris",GER:"Europe/Berlin",SLO:"Europe/Ljubljana",
  SVK:"Europe/Bratislava",AND:"Europe/Andorra",NOR:"Europe/Oslo",SWE:"Europe/Stockholm",FIN:"Europe/Helsinki",CZE:"Europe/Prague",
  BUL:"Europe/Sofia",ESP:"Europe/Madrid",KOR:"Asia/Seoul",CHN:"Asia/Shanghai",CAN:"America/Toronto",USA:"America/Denver"};
const TZ_BY_PLACE = {killington:"America/New_York", "palisades tahoe":"America/Los_Angeles", "sun valley":"America/Boise", "lake louise":"America/Edmonton"};
const PLACE_ALIAS = {"val gardena groeden":"groeden","val gardena":"groeden","garmisch partenkirchen":"garmisch partenkirchen","st moritz":"st moritz",
  "kronplatz":"kronplatz","plan de corones":"kronplatz","cortina d ampezzo":"cortina d ampezzo","courchevel meribel":"courchevel","alta badia":"alta badia"};

/* ---------- http ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
async function get(url, tries = 6){
  for(let i = 0; i < tries; i++){
    let wait = 2000 * (i + 1);
    try{
      const res = await fetch(url, {headers:{"user-agent":"ski-tippspiel/1.0 (private friends game; daily sync)","accept-language":"en"}});
      if(res.ok) return await res.text();
      if(res.status === 404) return null;
      if(res.status === 429) wait = 15000 * (i + 1);     // FIS drosselt: lange warten
      console.warn(`HTTP ${res.status} ${url}`);
    }catch(e){ console.warn(`fetch failed ${url}: ${e.message}`); }
    await sleep(wait);
  }
  failures++;
  console.warn("Giving up on " + url);
  if(failures > 25) throw new Error("Zu viele Fehler bei FIS, Abbruch.");
  return null;
}
async function pool(items, n, fn){
  const out = []; let i = 0;
  await Promise.all(Array.from({length:n}, async () => {
    while(i < items.length){ const k = i++; out[k] = await fn(items[k], k); await sleep(700); }
  }));
  return out;
}

/* ---------- parsing ---------- */
const clean = s => String(s || "").replace(/\s+/g, " ").trim();
const placeKey = p => { const k = clean(p).normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[^a-z]+/g," ").trim(); return (PLACE_ALIAS[k] || k).replace(/ /g,"-"); };
// FIS schreibt "ODERMATT Marco" / "VON ALLMEN Franjo" -> "Marco Odermatt" / "Franjo von Allmen"
function niceName(raw){
  const parts = clean(raw).split(" ");
  const sur = [], first = [];
  for(const p of parts){ (first.length === 0 && p === p.toUpperCase() && /\p{L}/u.test(p) ? sur : first).push(p); }
  if(!first.length) return clean(raw);
  const cap = w => w.split(/([-'])/).map(x => x.length > 1 ? x[0] + x.slice(1).toLowerCase() : x).join("");
  const surname = sur.map(w => ["VON","VAN","DE","DI","DA","DER","DEN"].includes(w) ? w.toLowerCase() : cap(w)).join(" ")
    .replace(/\bMc([a-z])/g, (_, c) => "Mc" + c.toUpperCase());
  return `${first.join(" ")} ${surname}`;
}
function parseDate(text){
  const m = clean(text).match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/) || clean(text).match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s+(\d{4})/);
  if(!m) return null;
  const mon = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  let d, mo, y;
  if(/^\d/.test(m[1])){ d = +m[1]; mo = mon.indexOf(m[2].toLowerCase()); y = +m[3]; } else { mo = mon.indexOf(m[1].toLowerCase()); d = +m[2]; y = +m[3]; }
  if(mo < 0) return null;
  return `${y}-${String(mo+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
}
function seasonOf(date){ const [y, m] = date.split("-").map(Number); return m >= 7 ? y + 1 : y; }

async function eventIds(season, cat){
  const url = `${BASE}/alpine-skiing/calendar-results.html?eventselection=&place=&sectorcode=AL&seasoncode=${season}&categorycode=${cat}&disciplinecode=&gendercode=&racedate=&racecodex=&nationcode=&seasonmonth=X-${season}&saveselection=-1&seasonselection=`;
  const html = await get(url);
  const ids = [...new Set([...(html || "").matchAll(/eventid=(\d+)/g)].map(m => m[1]))];
  if(DEBUG || !ids.length) console.log(`calendar ${season} ${cat}: ${ids.length} events`, ids.length ? "" : (html || "").slice(0, 1500));
  return ids;
}
// Pro Event: Renn-IDs mit Status und Startzeit, soweit ablesbar.
async function eventRaces(eventId){
  const html = await get(`${BASE}/general/event-details.html?sectorcode=AL&eventid=${eventId}`);
  if(!html) return [];
  const $ = load(html);
  const out = new Map();
  $("a[href*='raceid=']").each((_, a) => {
    const id = ($(a).attr("href").match(/raceid=(\d+)/) || [])[1];
    if(!id || out.has(id)) return;
    const row = $(a).closest(".table-row").length ? $(a).closest(".table-row") : $(a).parent();
    const text = clean(row.text());
    const time = (text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/) || [])[0] || null;
    out.set(id, {raceid:id, eventId, time, cancelled:/cancel/i.test(text)});
    if(DEBUG && !eventRaces.shown){ eventRaces.shown = true; console.log("first event row:", text); }
  });
  if(DEBUG) console.log(`event ${eventId}: ${out.size} races`);
  return [...out.values()];
}
async function raceDetails(raceid){
  const html = await get(`${BASE}/general/results.html?sectorcode=AL&raceid=${raceid}`);
  if(!html) return null;
  const $ = load(html);
  const head = clean($(".event-header__name h1").first().text() || $("h1").first().text());
  const kind = clean($(".event-header__kind").text());
  const sub = clean($(".event-header__subtitle").text());
  const pm = head.match(/^(.*?)\s*\(([A-Z]{3})\)/);
  const place = pm ? clean(pm[1]) : head;
  const nation = pm ? pm[2] : null;
  const tzd = $(".event-header__date .timezone-date").first();
  const iso = tzd.attr("data-iso-date") || null;
  const date = tzd.attr("data-date") || parseDate($(".date__full").first().text()) || parseDate($(".event-header").text()) || parseDate($("body").text().slice(0, 4000));
  const gender = /\b(men|man)'?s?\b/i.test(kind) && !/women|ladies/i.test(kind) ? "M" : /women|ladies/i.test(kind) ? "W" : null;
  const disc = /training|qualif/i.test(kind) ? null : (DISC.find(([re]) => re.test(kind)) || [])[1] || null;
  const wm = /championships/i.test(sub + " " + kind);
  const res = [];
  $("a.table-row").each((_, a) => {
    const row = $(a);
    const nameEl = row.find(".justify-left.bold").first();
    const name = clean(nameEl.text());
    if(!name) return;
    // Blatt-Divs der Zeile: das erste ist der Rang (leer bei DNF/DSQ)
    const cells = row.find("div").filter((_, c) => $(c).children("div").length === 0).map((_, c) => clean($(c).text())).get();
    const rank = /^\d+$/.test(cells[0] || "") ? Number(cells[0]) : null;
    const nat = clean(row.find(".country__name-short").first().text()) || null;
    res.push([rank, niceName(name), nat]);
    if(DEBUG && !raceDetails.shown){ raceDetails.shown = true; console.log("first result row:", cells, name, nat, $.html(a).slice(0, 2500)); }
  });
  const finishers = res.filter(r => r[0]).sort((a,b) => a[0] - b[0]);
  if(DEBUG) console.log(`race ${raceid}: place="${place}" ${nation} kind="${kind}" sub="${sub}" date=${date} iso=${iso} rows=${res.length} finishers=${finishers.length}`);
  if(!kind) console.log(`race ${raceid}: Kopfzeile nicht erkannt`, html.slice(0, 800));
  return {raceid, place, nation, date, iso, gender, disc, wm, kind, results: finishers};
}

/* ---------- cache ---------- */
async function readJson(p, fallback){ try{ return JSON.parse(await fs.readFile(p, "utf8")); }catch{ return fallback; } }
async function writeJson(p, v, pretty){ await fs.mkdir(path.dirname(p), {recursive:true}); await fs.writeFile(p, JSON.stringify(v, null, pretty ? 1 : 0)); }

async function seasonRaces(season, {refresh}){
  const cats = ["WC", "WSC"];
  const events = (await Promise.all(cats.map(c => eventIds(season, c)))).flat();
  const raceStubs = (await pool([...new Set(events)], 2, eventRaces)).flat();
  const today = new Date().toISOString().slice(0, 10);
  return (await pool(raceStubs, 2, async stub => {
    const cp = path.join(CACHE, "races", `${stub.raceid}.json`);
    let r = await readJson(cp, null);
    // Neu laden: fehlt, Rennen rund um heute ohne fertiges Resultat, oder Zukunftsrennen älter als 1 Tag im Cache
    const near = r?.date && r.date >= addDays(today, -3) && r.date <= addDays(today, 7);
    const old = !r?.fetchedAt || Date.now() - Date.parse(r.fetchedAt) > 20 * 36e5;
    const stale = !r || (refresh && (near || (old && !(r.results || []).length)));
    if(stale){
      const fresh = await raceDetails(stub.raceid);
      if(fresh){ r = {...fresh, fetchedAt:new Date().toISOString()}; await writeJson(cp, r); }
    }
    return r ? {...r, time: stub.time, cancelled: stub.cancelled && !(r.results || []).length} : null;
  })).filter(r => r && r.gender && r.disc && r.date);
}
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);

/* ---------- time zones ---------- */
function zonedToUtc(date, time, tz){
  // date "YYYY-MM-DD", time "HH:MM" in Zeitzone tz -> ISO UTC
  const guess = new Date(`${date}T${time}:00Z`);
  const f = new Intl.DateTimeFormat("en-CA", {timeZone:tz, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23"});
  const parts = Object.fromEntries(f.formatToParts(guess).map(p => [p.type, p.value]));
  const asTz = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
  return new Date(guess.getTime() - (asTz - guess.getTime())).toISOString();
}

/* ---------- main ---------- */
async function main(){
  if(process.env.RACE_TEST){
    const r = await raceDetails(process.env.RACE_TEST);
    console.log(JSON.stringify({...r, results: r.results.slice(0, 5)}, null, 1));
    const html = await get(`${BASE}/general/results.html?sectorcode=AL&raceid=${process.env.RACE_TEST}`);
    const i = html.indexOf('class="table-row"'); console.log(html.slice(i - 200, i + 3000));
    return;
  }
  const seeds = await readJson(path.join(DATA, "start-times.json"), {});
  const overrides = await readJson(path.join(DATA, "overrides.json"), {});
  const seasons = Array.from({length:HISTORY_SEASONS + 1}, (_, i) => SEASON - i);
  const all = [];
  for(const s of seasons){
    const list = await seasonRaces(s, {refresh: s === SEASON});
    console.log(`season ${s}: ${list.length} races (${list.filter(r => r.results.length).length} with results)`);
    all.push(...list);
  }

  // Aktuelle Saison -> Rennliste der App
  const cur = all.filter(r => seasonOf(r.date) === SEASON).sort((a,b) => a.date.localeCompare(b.date));
  const races = cur.map(r => {
    // Die FIS-Renn-ID bleibt stabil, auch wenn ein Rennen verschoben wird.
    const id = String(r.raceid);
    const seedKey = `${r.gender}-${r.date}-${r.disc}${r.wm ? "-WM" : ""}`;
    const tz = TZ_BY_PLACE[placeKey(r.place).replace(/-/g," ")] || TZ_BY_NATION[r.nation] || "Europe/Zurich";
    // FIS liefert im Rennkopf Datum, Ortszeit und Zeitzone (data-iso-date)
    const start = r.iso ? new Date(r.iso).toISOString() : seeds[seedKey] || zonedToUtc(r.date, r.time || "10:00", tz);
    const podium = r.results.length >= 3 ? [1,2,3].map(p => r.results.filter(x => x[0] === p).map(x => x[1]).join(" / ") || null) : null;
    const race = {id, raceid:r.raceid, gender:r.gender, disc:r.disc, place:r.place, nation:r.nation, date:r.date, start,
      timeKnown: !!r.iso || !!r.time, wm:r.wm, kind:r.kind, venue:`${r.gender}-${r.disc}-${placeKey(r.place)}`,
      status: r.cancelled ? "cancelled" : podium && podium.every(Boolean) ? "done" : "scheduled",
      podium: podium && podium.every(Boolean) ? podium : null,
      podiumNat: podium ? [1,2,3].map(p => (r.results.find(x => x[0] === p) || [])[2] || null) : null};
    return Object.assign(race, overrides[id] || {});
  });

  // Weltcup-Stände aus Resultaten (FIS-Punkteschema), aktuelle und letzte Saison
  const standings = {};
  for(const [label, s] of [["cur", SEASON], ["prev", SEASON - 1]]){
    const st = {W:{}, M:{}};
    for(const r of all.filter(r => seasonOf(r.date) === s && !r.wm && !r.cancelled)){
      for(const [rank, name, nat] of r.results){
        const pts = WC_POINTS[rank - 1]; if(!pts) continue;
        for(const k of [r.disc, "OVR"]){
          const m = (st[r.gender][k] ||= {});
          (m[name] ||= {name, nat, pts:0}).pts += pts;
        }
      }
    }
    for(const g of ["W","M"]) for(const k in st[g]) st[g][k] = Object.values(st[g][k]).sort((a,b) => b.pts - a.pts).slice(0, 40);
    standings[label] = st;
  }

  // Historie pro Ort/Disziplin/Geschlecht
  const venues = {};
  for(const r of all){
    if(!r.results.length) continue;
    const key = `${r.gender}-${r.disc}-${placeKey(r.place)}`;
    (venues[key] ||= []).push({d:r.date, s:seasonOf(r.date), wm:r.wm, r:r.results.map(([k,n,c]) => [k,n,c])});
  }
  await fs.rm(path.join(DATA, "venues"), {recursive:true, force:true});
  for(const [k, list] of Object.entries(venues)) await writeJson(path.join(DATA, "venues", `${k}.json`), list.sort((a,b) => b.d.localeCompare(a.d)));

  // Fahrerliste für Vorschläge (alle, die in den letzten 2 Saisons gepunktet haben)
  const athletes = {W:{}, M:{}};
  for(const r of all.filter(r => seasonOf(r.date) >= SEASON - 1)) for(const [rank, name, nat] of r.results) if(rank <= 30) athletes[r.gender][name] = nat;

  const out = {updated:new Date().toISOString(), season:SEASON, races, standings,
    athletes:{W:Object.entries(athletes.W).map(([n,c]) => [n,c]), M:Object.entries(athletes.M).map(([n,c]) => [n,c])},
    venues:Object.keys(venues)};
  await writeJson(path.join(DATA, "season.json"), out, true);
  console.log(`wrote ${races.length} races, ${Object.keys(venues).length} venue histories`);
  for(const r of races) console.log(`${r.id.padEnd(22)} ${r.place.padEnd(24)} ${r.start} ${r.timeKnown ? "" : "(Zeit geschätzt)"} ${r.status} ${r.podium ? r.podium.join(", ") : ""}`);

  if(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY){
    const rows = races.map(r => ({id:r.id, gender:r.gender, disc:r.disc, place:r.place, start:r.start, wm:r.wm, status:r.status}));
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/races?on_conflict=id`, {method:"POST",
      headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY, ...(process.env.SUPABASE_SERVICE_ROLE_KEY.startsWith("sb_") ? {} : {authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`}),
        "content-type":"application/json", prefer:"resolution=merge-duplicates,return=minimal"}, body:JSON.stringify(rows)});
    console.log(`supabase races upsert: ${res.status} ${res.ok ? "" : await res.text()}`);
    if(!res.ok) process.exitCode = 1;
  } else console.log("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY fehlen: Renn-Deadlines nicht synchronisiert.");
}
main().catch(e => { console.error(e); process.exit(1); });
