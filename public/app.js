/* global d3, topojson */
import {
  createRef, computeStats, computeFlags, statusOf, durMin, hm, estDur, hav, fnPretty, niceDate, airlineName, planeName, countryName,
  validate, DEFUNCT, CABINS, REASONS, MONTHS, todayISO, dayDiff,
} from "./lib/core.js";
import { createGlobe } from "./globe.js";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => Math.round(n).toLocaleString("en-US");
const TODAY = todayISO();
const INKS = ["#FF6F91", "#7CC4FF", "#F6C667", "#5FD6A8", "#A18CFF", "#FF8A5B"];

let REF, LAND = null, globe, me = { canWrite: false, features: {} };
let flights = [], tripData = { trips: [], home: null }, FLAGS = new Map(), GROUPS = [], PEOPLE = [{ id: "me", name: "Me" }];
const ui = { person: (() => { try { return localStorage.getItem("wander.person") || "me"; } catch { return "me"; } })(), tab: "overview", year: "all", airline: "all", showCancelled: false, q: "", status: "all", sort: "date", dir: -1, limit: 80, sel: null, editing: null, confirmDel: null, trip: null, replaying: false };

/* ---------------- helpers ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...opts, headers: { ...(opts.body && typeof opts.body === "string" && !opts.raw ? { "content-type": "application/json" } : {}), ...(opts.headers || {}) } });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (res.status === 401 && path !== "/api/login") { showLogin(); }
  if (!res.ok) {
    const gateway = [502, 503, 504, 520, 521, 522, 523, 524].includes(res.status);
    const msg = data?.error || (gateway ? `The connection to the Wander server dropped before it answered (HTTP ${res.status}). Try again in a moment; if it keeps happening, check the server logs.` : `Request failed (${res.status})`);
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return data;
}
function toast(msg, undo) {
  const t = $("#toast"); t.innerHTML = `<span>${esc(msg)}</span>`;
  if (undo) { const b = document.createElement("button"); b.textContent = "Undo"; b.onclick = () => { t.hidden = true; undo(); }; t.appendChild(b); }
  t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 5200);
}
const ap = c => REF.ap.get(c);
const flag = (cc, w = 40) => cc ? `<img src="https://flagcdn.com/w80/${esc(cc.toLowerCase())}.png" alt="" width="${w}" loading="lazy" data-fb="flag">` : "";
const logo = code => `<span class="logo-box"><img src="https://pics.avs.io/120/48/${esc(code)}.png" alt="${esc(code)}" loading="lazy" data-fb="logo" data-code="${esc(code)}"></span>`;
document.addEventListener("error", e => {
  const img = e.target; if (!(img instanceof HTMLImageElement) || !img.dataset.fb) return;
  if (img.dataset.fb === "logo") { const box = img.parentElement; box.classList.add("txt"); box.textContent = img.dataset.code; }
  else img.remove();
}, true);
const fmtLat = v => `${Math.abs(v).toFixed(2)}°${v >= 0 ? "N" : "S"}`, fmtLon = v => `${Math.abs(v).toFixed(2)}°${v >= 0 ? "E" : "W"}`;

/* ---------------- data views ---------------- */
/* ---------------- people ---------------- */
const whoOf = f => (Array.isArray(f.travellers) ? f.travellers : ["me"]);
const inView = f => (ui.person === "all" ? whoOf(f).length > 0 : whoOf(f).includes(ui.person));
const pColor = id => INKS[Math.max(0, PEOPLE.findIndex(p => p.id === id)) % INKS.length];
const pName = id => PEOPLE.find(p => p.id === id)?.name || id;
const initials = n => String(n).trim().split(/\s+/).map(w => w[0] || "").join("").slice(0, 2).toUpperCase();
const avatar = (id, sm) => `<span class="av${sm ? " sm" : ""}" style="--pc:${pColor(id)}" title="${esc(pName(id))}">${esc(initials(pName(id)))}</span>`;
const defaultWho = () => (ui.person === "all" || !PEOPLE.some(p => p.id === ui.person) ? ["me"] : [ui.person]);
const tripsUrl = () => `/api/trips?person=${encodeURIComponent(ui.person)}`;
function renderPeople() {
  const el = $("#people");
  if (PEOPLE.length < 2) { el.innerHTML = ""; return; }
  el.innerHTML = PEOPLE.map(p => `<button type="button" class="pchip" data-person="${esc(p.id)}" aria-pressed="${ui.person === p.id}" style="--pc:${pColor(p.id)}">${avatar(p.id)}${esc(p.name)}</button>`).join("")
    + `<button type="button" class="pchip" data-person="all" aria-pressed="${ui.person === "all"}"><span class="av fam"></span>Family</button>`;
}
async function setPerson(pid) {
  ui.person = pid; ui.trip = null; try { localStorage.setItem("wander.person", pid); } catch { /* private mode */ }
  globe.setHighlight(null); $("#focus").hidden = true;
  tripData = await api(tripsUrl()); renderPeople(); render(); focusVisible();
}
function renderWhoPick(selected) {
  $("#iWho").innerHTML = PEOPLE.map(p => `<label style="--pc:${pColor(p.id)}"><input type="checkbox" value="${esc(p.id)}"${selected.includes(p.id) ? " checked" : ""}>${avatar(p.id, true)}${esc(p.name)}</label>`).join("");
}
function openPeople() {
  const rows = () => $$(".people-list .prow").map(r => ({ id: r.dataset.id || "", name: r.querySelector("input").value.trim() }));
  const row = p => `<div class="prow" data-id="${esc(p.id)}">${avatar(p.id)}<input value="${esc(p.name)}" maxlength="40" aria-label="Name">${p.id === "me" ? '<span class="muted">you</span>' : '<button class="btn small ghost danger" type="button" data-rm>Remove</button>'}</div>`;
  openModal(`<div class="story"><p class="eyebrow">People</p><h2 id="modalTitle">Who travels with you</h2>
    <p class="muted">Flights can belong to any of these people. Switch between their maps from the buttons above the stats.</p>
    <div class="people-list">${PEOPLE.map(row).join("")}</div>
    <div class="inline"><input id="newPerson" placeholder="Add someone, e.g. Kruti" maxlength="40" style="height:36px;border-radius:10px;border:1px solid var(--line-2);background:var(--bg-2);padding:0 12px;flex:1"><button class="btn" type="button" id="addPerson">Add</button></div>
    <p class="err" id="peopleErr"></p><div class="row"><button class="btn primary" type="button" id="savePeople">Save</button></div></div>`);
  const list = $(".people-list");
  list.onclick = e => { if (e.target.closest("[data-rm]")) e.target.closest(".prow").remove(); };
  $("#addPerson").onclick = () => { const n = $("#newPerson").value.trim(); if (!n) return; list.insertAdjacentHTML("beforeend", `<div class="prow" data-id=""><span class="av">${esc(initials(n))}</span><input value="${esc(n)}" maxlength="40" aria-label="Name"><button class="btn small ghost danger" type="button" data-rm>Remove</button></div>`); $("#newPerson").value = ""; };
  $("#savePeople").onclick = async () => {
    try {
      const { people } = await api("/api/people", { method: "PUT", body: JSON.stringify({ people: rows().map(r => ({ id: r.id || r.name, name: r.name })) }) });
      PEOPLE = people; if (!PEOPLE.some(p => p.id === ui.person)) ui.person = "me";
      $("#modal").hidden = true; renderPeople(); await reload(); toast("People saved");
    } catch (e) { $("#peopleErr").textContent = e.message; }
  };
}

function visible(ignoreYear = false) {
  return flights.filter(f => inView(f) && (ignoreYear || ui.year === "all" || f.date.startsWith(ui.year)) && (ui.airline === "all" || f.airline === ui.airline) && (ui.showCancelled || statusOf(f) !== "cancelled"));
}
const flown = list => list.filter(f => statusOf(f) === "flown");

/* ---------------- boot ---------------- */
async function boot() {
  wire();
  me = await api("/api/me").catch(() => ({ canRead: false }));
  if (!me.canRead) { showLogin(); return; }
  document.body.classList.toggle("readonly", !me.canWrite);
  document.body.classList.toggle("ai", !!me.features?.ai);
  document.body.classList.toggle("lookup", !!me.features?.lookup);
  $("#signBtn").hidden = !(me.authEnabled && me.who === "owner");
  const [ref, w110, w50] = await Promise.all(["/data/ref.json", "/data/countries-110m.json", "/data/countries-50m.json"].map(u => fetch(u).then(r => r.json())));
  REF = createRef(ref); LAND = topojson.feature(w110, w110.objects.countries).features.map(f => ({ f, b: d3.geoBounds(f) }));
  globe = createGlobe($("#globe"), {
    world110: w110, world50: w50,
    onAirport: code => showAirport(code),
    onRoute: r => { ui.q = `${r.a.code} ${r.b.code}`; $("#q").value = ui.q; go("logbook"); renderTable(); },
    onHover: h => tip(h),
    onWheelHint: () => { const z = $("#zoomHint"); z.hidden = false; clearTimeout(z.t); z.t = setTimeout(() => (z.hidden = true), 1400); },
    isFree: () => isFullscreen(),
  });
  fillLists();
  await reload();
  resetForm();
  go((location.hash || "#overview").slice(1), true);
}
async function reload() {
  const [{ flights: fs }, { people }] = await Promise.all([api("/api/flights"), api("/api/people")]);
  PEOPLE = people; if (ui.person !== "all" && !PEOPLE.some(p => p.id === ui.person)) ui.person = "me";
  flights = fs; tripData = await api(tripsUrl());
  fillFilters(); renderPeople(); render();
}

/* ---------------- render all ---------------- */
function render() {
  ({ groups: GROUPS, flags: FLAGS } = computeFlags(flights));
  const c = $("#rvCount"); c.hidden = !GROUPS.length; c.textContent = GROUPS.length;
  drawGlobeData(); hero(); years();
  const t = ui.tab;
  if (t === "overview") renderOverview();
  if (t === "trips") renderTrips();
  if (t === "insights") renderInsights();
  if (t === "logbook") renderTable();
  if (t === "review") renderReview();
}

function drawGlobeData() {
  const list = visible().filter(f => statusOf(f) !== "cancelled");
  const routes = new Map(), counts = new Map();
  for (const f of list) {
    const up = statusOf(f) === "upcoming", key = [f.from, f.to].sort().join("-") + (up ? "u" : "");
    const r = routes.get(key) || { a: ap(f.from), b: ap(f.to), n: 0, up, ids: [], first: f.date, km: f.distanceKm || 0 };
    r.n++; r.ids.push(f.id); if (f.date < r.first) r.first = f.date; routes.set(key, r);
    for (const c of [f.from, f.to]) { const x = counts.get(c) || { n: 0, ids: [] }; x.n++; x.ids.push(f.id); counts.set(c, x); }
  }
  const s = computeStats(flown(list), REF);
  const visitedIds = new Set(flown(list).flatMap(f => [ap(f.from)?.cc, ap(f.to)?.cc]).filter(Boolean).map(cc => REF.countries[cc]?.[1]));
  globe.setData({
    routes: [...routes.values()].filter(r => r.a && r.b).sort((a, b) => a.n - b.n),
    airports: [...counts.entries()].map(([c, x]) => ({ a: ap(c), n: x.n, ids: x.ids })).filter(d => d.a),
    visited: visitedIds, home: tripData.home || s.home,
  });
  if (!drawGlobeData.done && s.home) { drawGlobeData.done = true; const h = ap(s.home); globe.focusPoints([[h.lon, h.lat]], 10); }
}

function countUp(el, to, dur = 1400) {
  const from = +el.dataset.v || 0; el.dataset.v = to;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = now => { const t = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - t, 3); el.textContent = fmt(from + (to - from) * e); if (t < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function hero() {
  const list = visible(), fl = flown(list), s = computeStats(fl, REF);
  countUp($("#heroKm"), s.km);
  const days = s.min / 1440;
  const who = PEOPLE.length < 2 || ui.person === "me" ? "" : ui.person === "all" ? "Family · " : `${pName(ui.person)} · `;
  $("#heroEyebrow").textContent = who + (ui.year === "all" ? (s.first ? `Since ${MONTHS[+s.first.date.slice(5, 7) - 1]} ${s.first.date.slice(0, 4)}` : "Flights") : `In ${ui.year}`);
  $("#heroSub").innerHTML = s.n ? `<b>${(s.km / 40075).toFixed(1)}×</b> around the Earth, and <b>${days >= 1 ? days.toFixed(1) + " days" : hm(s.min) + " hours"}</b> in the air.` : "Nothing flown in this view yet.";
  const up = list.filter(f => statusOf(f) === "upcoming").length;
  $("#heroStats").innerHTML = [["Flights", s.n], ["Airports", s.airports.size], ["Countries", s.countries.size], [up ? "Upcoming" : "Airlines", up || s.carriers.size]]
    .map(([k, v]) => `<div class="stat"><b>${fmt(v)}</b><span>${k}</span></div>`).join("");
}
function years() {
  const base = flights.filter(f => (ui.airline === "all" || f.airline === ui.airline) && statusOf(f) !== "cancelled");
  const ys = base.map(f => +f.date.slice(0, 4)); if (!ys.length) { $("#years").innerHTML = ""; return; }
  const range = d3.range(Math.min(...ys), Math.max(...ys, +TODAY.slice(0, 4)) + 1);
  const cnt = new Map(range.map(y => [y, { f: 0, u: 0 }]));
  base.forEach(f => { const c = cnt.get(+f.date.slice(0, 4)); statusOf(f) === "upcoming" ? c.u++ : c.f++; });
  const max = Math.max(1, ...[...cnt.values()].map(c => c.f + c.u));
  $("#years").classList.toggle("filtered", ui.year !== "all");
  $("#yAll").setAttribute("aria-pressed", String(ui.year === "all"));
  $("#years").innerHTML = range.map(y => {
    const c = cnt.get(y), hf = c.f / max * 52, hu = c.u / max * 52;
    return `<button type="button" class="yr${ui.year === String(y) ? " on" : ""}" data-y="${y}" title="${y}: ${c.f} flown${c.u ? `, ${c.u} upcoming` : ""}">
      ${c.u ? `<i class="up" style="height:${hu}px"></i>` : ""}<i style="height:${Math.max(hf, c.f ? 3 : 2)}px;${c.f ? "" : "opacity:.25"}"></i><span>${String(y).slice(2)}</span></button>`;
  }).join("");
}
function setYear(y) { ui.year = y; ui.trip = null; globe.setHighlight(null); $("#focus").hidden = true; render(); focusVisible(); }
function focusVisible() {
  const pts = [...new Set(flown(visible()).flatMap(f => [f.from, f.to]))].map(ap).filter(Boolean).map(a => [a.lon, a.lat]);
  if (pts.length) globe.focusPoints(pts);
}

/* ---------------- globe tooltip & airport card ---------------- */
function tip(h) {
  const t = $("#tip");
  if (!h) { t.hidden = true; return; }
  if (h.kind === "airport") { const d = h.data; t.innerHTML = `<b>${d.a.code}</b> ${esc(d.a.city || "")}<br>${esc(d.a.name)}<br>${d.n} visit${d.n > 1 ? "s" : ""}`; }
  else { const r = h.data; t.innerHTML = `<b>${r.a.code} ⇄ ${r.b.code}</b><br>${esc(r.a.city)} – ${esc(r.b.city)}<br>${r.n} flight${r.n > 1 ? "s" : ""} · ${fmt(hav(r.a, r.b))} km${r.up ? " · upcoming" : ""}`; }
  t.hidden = false;
  const wrap = $("#globeWrap").getBoundingClientRect();
  t.style.left = Math.min(h.x + 14, wrap.width - t.offsetWidth - 6) + "px"; t.style.top = Math.max(6, h.y - t.offsetHeight - 10) + "px";
}
function showAirport(code) {
  const a = ap(code), fs = flown(visible()).filter(f => f.from === code || f.to === code).sort((x, y) => x.date.localeCompare(y.date));
  const partners = new Map(); fs.forEach(f => { const o = f.from === code ? f.to : f.from; partners.set(o, (partners.get(o) || 0) + 1); });
  const top = [...partners.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([c, n]) => `${c} ×${n}`).join(", ");
  const el = $("#focus"); el.hidden = false;
  el.innerHTML = `<button class="btn ghost small x" type="button" aria-label="Close">✕</button>
    <p class="eyebrow">${flag(a.cc, 18)} ${esc(countryName(REF, a.cc))}</p><h3>${code} · ${esc(a.city || "")}</h3><div class="muted">${esc(a.name)}</div>
    <dl><dt>Visits</dt><dd class="mono">${fs.length}</dd><dt>First</dt><dd>${fs[0] ? niceDate(fs[0].date) : "—"}</dd><dt>Latest</dt><dd>${fs.length ? niceDate(fs.at(-1).date) : "—"}</dd><dt>Most with</dt><dd class="mono">${top || "—"}</dd><dt>Position</dt><dd class="mono">${fmtLat(a.lat)} ${fmtLon(a.lon)}</dd></dl>
    <div class="row"><button class="btn small" type="button" data-show="${code}">Show flights</button>${me.canWrite ? `<button class="btn small ghost" type="button" data-wrong>Wrong airport?</button>` : ""}</div>
    <form class="fix" hidden><label class="muted" for="fixTo">Replace ${code} with</label><div class="inline"><input id="fixTo" list="apList" placeholder="e.g. HKG" maxlength="40" autocomplete="off"><button class="btn small primary" type="submit">Replace in ${flights.filter(f => f.from === code || f.to === code).length} flights</button></div><span class="hint" id="fixHint"></span></form>`;
  el.querySelector(".x").onclick = () => { el.hidden = true; globe.setHighlight(null); };
  const wrong = el.querySelector("[data-wrong]"), fix = el.querySelector(".fix");
  if (wrong) wrong.onclick = () => { fix.hidden = false; fix.querySelector("input").focus(); };
  if (fix) {
    fix.querySelector("input").oninput = e => { const c = e.target.value.trim().slice(0, 3).toUpperCase(), b = ap(c); $("#fixHint").textContent = c.length === 3 ? (b ? `${b.city || b.name}, ${countryName(REF, b.cc)}` : "Unknown airport code") : ""; };
    fix.onsubmit = async e => {
      e.preventDefault();
      const to = fix.querySelector("input").value.trim().slice(0, 3).toUpperCase();
      try {
        const r = await api("/api/airports/replace", { method: "POST", body: JSON.stringify({ from: code, to }) });
        el.hidden = true; await reload();
        toast(`Replaced ${code} with ${to} on ${r.replaced} flight${r.replaced > 1 ? "s" : ""}`, async () => { await api("/api/airports/replace", { method: "POST", body: JSON.stringify({ from: to, to: code, ids: r.ids }) }); await reload(); });
      } catch (err) { $("#fixHint").textContent = err.message; }
    };
  }
  el.querySelector("[data-show]").onclick = () => { ui.q = code; $("#q").value = code; go("logbook"); renderTable(); };
  globe.setHighlight(new Set(fs.map(f => f.id)));
}

/* ---------------- overview ---------------- */
function meter(obj, keys, colors, labels) {
  const tot = keys.reduce((a, k) => a + (obj[k] || 0), 0) || 1, ks = keys.filter(k => obj[k]);
  return `<div class="meter">${ks.map(k => `<i style="width:${(obj[k] / tot * 100).toFixed(2)}%;background:${colors[keys.indexOf(k)]}" title="${labels[keys.indexOf(k)]}: ${obj[k]}"></i>`).join("")}</div>
  <div class="mkey">${ks.map(k => `<span><i style="background:${colors[keys.indexOf(k)]}"></i>${labels[keys.indexOf(k)]} <b>${Math.round(obj[k] / tot * 100)}%</b></span>`).join("")}</div>`;
}
const C5 = ["#FF6F91", "#7CC4FF", "#F6C667", "#A18CFF", "#3A4A6B"];
function miniArc(a, b) {
  if (!a || !b) return "";
  return `<svg class="arc" viewBox="0 0 120 60" aria-hidden="true"><defs><linearGradient id="ga${a.code}${b.code}" x1="0" x2="1"><stop offset="0" stop-color="#FF8A5B"/><stop offset="1" stop-color="#FF4D8D"/></linearGradient></defs><path d="M10 52 Q60 -8 110 52" fill="none" stroke="url(#ga${a.code}${b.code})" stroke-width="2.5" stroke-linecap="round"/><circle cx="10" cy="52" r="3.5" fill="#EEF2F8"/><circle cx="110" cy="52" r="3.5" fill="#EEF2F8"/></svg>`;
}
function renderOverview() {
  const el = $("#p-overview"), list = visible(), fl = flown(list), s = computeStats(fl, REF);
  if (!fl.length) { el.innerHTML = emptyState(); return; }
  const countries = [...s.countries.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const visits = new Map(); fl.forEach(f => new Set([ap(f.from)?.cc, ap(f.to)?.cc]).forEach(cc => cc && visits.set(cc, (visits.get(cc) || 0) + 1)));
  const homeCC = ap(s.home)?.cc;
  const stamps = countries.map(([cc, d], i) => `<div class="stamp${i % 3 === 2 ? " sq" : ""}" style="--ink-c:${INKS[i % INKS.length]};--rot:${((i * 37) % 13) - 6}deg">
      ${flag(cc)}<b>${esc(countryName(REF, cc))}</b><span>${MONTHS[+d.slice(5, 7) - 1].toUpperCase()} ${d.slice(0, 4)}</span><small>${cc === homeCC ? "home" : `${visits.get(cc) || 0} flight${visits.get(cc) === 1 ? "" : "s"}`}</small></div>`).join("");
  const rec = (label, big, sub, arc) => `<div class="card rec"><h3>${label}</h3><div class="big">${big}</div><p>${sub}</p>${arc || ""}</div>`;
  const R = f => f ? `<span class="mono">${f.from}→${f.to}</span>` : "—";
  const als = [...s.carriers.entries()].sort((a, b) => b[1] - a[1]);
  el.innerHTML = `
  <div class="sec"><div class="sec-head"><h2>Passport <em>· ${s.countries.size} countries</em></h2><p>Stamped in the order you first arrived.</p></div><div class="stamps">${stamps}</div></div>

  <div class="sec"><div class="sec-head"><h2>Records</h2></div><div class="records">
    ${rec("Longest flight", `${fmt(s.longest.distanceKm)} <small class="muted">km</small>`, `${R(s.longest)} · ${fnPretty(s.longest)} · ${niceDate(s.longest.date)}`, miniArc(ap(s.longest.from), ap(s.longest.to)))}
    ${rec("Shortest flight", `${fmt(s.shortest.distanceKm)} <small class="muted">km</small>`, `${R(s.shortest)} · ${fnPretty(s.shortest)} · ${niceDate(s.shortest.date)}`)}
    ${rec("Furthest from home", s.far ? `<span class="mono">${s.far.a.code}</span> ${esc(s.far.a.city)}` : "—", s.far ? `${fmt(s.far.k)} km from ${s.home}` : "")}
    ${rec("Home base", `<span class="mono">${s.home}</span> ${esc(ap(s.home)?.city || "")}`, `${Math.round((s.homeShare || 0) * 100)}% of your flights start or end here`)}
    ${rec("Northernmost", `<span class="mono">${s.north.code}</span> ${esc(s.north.city)}`, fmtLat(s.north.lat))}
    ${rec("Southernmost", `<span class="mono">${s.south.code}</span> ${esc(s.south.city)}`, fmtLat(s.south.lat))}
    ${rec("Easternmost", `<span class="mono">${s.east.code}</span> ${esc(s.east.city)}`, fmtLon(s.east.lon))}
    ${rec("Westernmost", `<span class="mono">${s.west.code}</span> ${esc(s.west.city)}`, fmtLon(s.west.lon))}
  </div></div>

  <div class="sec"><div class="sec-head"><h2>Airlines <em>· ${s.carriers.size}</em></h2></div><div class="airlines">
    ${als.map(([c, n]) => `<div class="al">${logo(c)}<div><b>${esc(airlineName(REF, c))}</b><small>${DEFUNCT[c] ? `<span class="tag gone" title="${esc(DEFUNCT[c])}">${/Merged/.test(DEFUNCT[c]) ? "merged" : "defunct"} ${DEFUNCT[c].slice(-4)}</span>` : `${Math.round(n / s.n * 100)}% of flights`}</small></div><span class="n">${n}</span></div>`).join("")}
  </div></div>

  <div class="sec ai-only"><div class="sec-head"><h2>Where next <em>· ideas from Gemini</em></h2><p>Places you haven't been, reachable from ${esc(s.home)}.</p><button class="btn" type="button" id="nextBtn">Suggest destinations</button></div><div id="ideas"></div></div>

  <div class="sec"><div class="sec-head"><h2>The numbers</h2><p>The same figures OpenFlights shows, and a few more.</p></div><div class="grid">
    <div class="card"><h3>Unique</h3><dl class="kv"><dt>Airports</dt><dd>${s.airports.size}</dd><dt>Airlines</dt><dd>${s.carriers.size}</dd><dt>Countries</dt><dd>${s.countries.size}</dd><dt>Aircraft types</dt><dd>${s.planes.size}</dd><dt>Routes</dt><dd>${s.routes.size}</dd></dl></div>
    <div class="card"><h3>Distance</h3><dl class="kv"><dt>Total flown</dt><dd>${fmt(s.km)} km</dd><dt>Around the world</dt><dd>${(s.km / 40075).toFixed(2)}×</dd><dt>To the Moon</dt><dd>${(s.km / 384400).toFixed(3)}×</dd><dt>To Mars</dt><dd>${(s.km / 56e6).toFixed(4)}×</dd><dt>Average flight</dt><dd>${fmt(s.km / s.n)} km <small>· ${hm(s.min / s.n)}</small></dd></dl></div>
    <div class="card"><h3>Seat & cabin</h3>${meter(s.seat, ["window", "middle", "aisle", "unknown"], C5.slice(0, 3).concat(C5[4]), ["Window", "Middle", "Aisle", "Not recorded"])}${meter(s.cabin, CABINS, C5, ["Economy", "Premium", "Business", "First"])}</div>
    <div class="card"><h3>Reason & reach</h3>${meter(s.reason, REASONS, C5, ["Leisure", "Business", "Crew", "Other"])}${meter({ d: s.dom, i: s.intl }, ["d", "i"], C5, ["Domestic", "International"])}</div>
  </div></div>`;
  const nb = $("#nextBtn"); if (nb) nb.onclick = whereNext;
}
async function whereNext() {
  const b = $("#nextBtn"), box = $("#ideas"); b.disabled = true; b.textContent = "Thinking…";
  try {
    const { ideas } = await api("/api/ai/next", { method: "POST", body: "{}" });
    box.innerHTML = `<div class="ideas">${ideas.map(i => `<div class="idea"><span class="tag ai">${esc(i.iata)}</span><h3>${esc(i.city)}</h3><p>${esc(i.why)}</p><div class="meta"><span>${esc(i.country)}</span><span>✈ ${esc(i.flightTime || "")}</span><span>Best: ${esc(i.bestMonths || "")}</span></div></div>`).join("")}</div>`;
    b.textContent = "Suggest again";
  } catch (e) { box.innerHTML = `<div class="empty-ai">${esc(e.message)}</div>`; b.textContent = "Try again"; }
  b.disabled = false;
}
function emptyState() {
  return `<div class="empty"><h2>No flights here yet</h2><p>${me.canWrite ? "Add one, paste a booking into Smart add, or import an OpenFlights CSV from the Logbook." : "Nothing to show for this filter."}</p></div>`;
}

/* ---------------- trips ---------------- */
function tripSvg(t) {
  const pts = t.flights.map(id => flights.find(f => f.id === id)).filter(Boolean).flatMap(f => [ap(f.from), ap(f.to)]).filter(Boolean);
  const P = d3.geoNaturalEarth1().fitExtent([[10, 10], [122, 74]], { type: "MultiPoint", coordinates: pts.map(p => [p.lon, p.lat]) });
  if (P.scale() > 2400) P.scale(2400);
  const path = d3.geoPath(P);
  const legs = t.flights.map(id => flights.find(f => f.id === id)).filter(Boolean);
  const arcs = legs.map(f => { const a = ap(f.from), b = ap(f.to); return `<path d="${path({ type: "LineString", coordinates: [[a.lon, a.lat], [b.lon, b.lat]] })}" fill="none" stroke="${statusOf(f) === "upcoming" ? "#7CC4FF" : "url(#tg)"}" stroke-width="1.8" stroke-linecap="round"${statusOf(f) === "upcoming" ? ' stroke-dasharray="3 3"' : ""}/>`; }).join("");
  const dots = [...new Map(pts.map(p => [p.code, p])).values()].map(p => { const [x, y] = P([p.lon, p.lat]); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${p.code === tripData.home ? 3.2 : 2.4}" fill="${p.code === tripData.home ? "#F6C667" : "#EEF2F8"}"/>`; }).join("");
  const lons = pts.map(p => p.lon), lats = pts.map(p => p.lat), pad = 25;
  const box = [Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad];
  const near = (LAND || []).filter(({ b: [[x0, y0], [x1, y1]] }) => x1 >= box[0] && x0 <= box[2] && y1 >= box[1] && y0 <= box[3] && x1 - x0 < 300);
  const land = near.length ? `<path d="${near.map(({ f }) => path(f)).join("")}" fill="#1A2743" stroke="#26365A" stroke-width=".4"/>` : "";
  return `<svg class="mini" viewBox="0 0 132 84" aria-hidden="true"><defs><linearGradient id="tg" x1="0" x2="1"><stop offset="0" stop-color="#FF8A5B"/><stop offset="1" stop-color="#FF4D8D"/></linearGradient><clipPath id="mc"><rect width="132" height="84" rx="10"/></clipPath></defs><g clip-path="url(#mc)">${land}${arcs}${dots}</g></svg>`;
}
function renderTrips() {
  const el = $("#p-trips");
  const base = tripData.trips.filter(t => (ui.year === "all" || t.start.startsWith(ui.year)) && (ui.airline === "all" || t.flights.some(id => flights.find(f => f.id === id)?.airline === ui.airline)));
  if (!ui.tripKind) ui.tripKind = base.filter(t => t.international).length >= 5 ? "abroad" : "all";
  const ts = base.filter(t => ui.tripKind === "all" || (ui.tripKind === "abroad") === t.international);
  if (!ts.length) { el.innerHTML = emptyState(); return; }
  const unnamed = tripData.trips.filter(t => !t.ai).length;
  const byYear = d3.group(ts, t => t.start.slice(0, 4));
  const nAb = base.filter(t => t.international).length;
  el.innerHTML = `<div class="sec-head"><h2>Trips <em>· ${ts.length}</em></h2><p>Flights stitched into journeys: each trip leaves ${esc(tripData.home || "home")} and ends when you land back.</p>
    <div class="seg" role="group" aria-label="Trip type">${[["abroad", `Abroad ${nAb}`], ["domestic", `Domestic ${base.length - nAb}`], ["all", "All"]].map(([k, l]) => `<button type="button" data-kind="${k}" aria-pressed="${ui.tripKind === k}">${l}</button>`).join("")}</div>
    ${me.features?.ai && me.canWrite && unnamed ? `<button class="btn" id="nameBtn" type="button"><span class="spark">✦</span> Name ${unnamed > 40 ? "40" : unnamed} trips with Gemini</button>` : ""}</div>
  <div class="tl">${[...byYear].map(([y, list]) => {
    const km = list.reduce((a, t) => a + t.km, 0), abroad = list.filter(t => t.international).length;
    return `<div class="tl-year"><h3>${y}</h3><span class="meta">${list.length} trip${list.length > 1 ? "s" : ""} · ${abroad} abroad · ${fmt(km)} km</span>${me.features?.ai ? `<button class="btn small" type="button" data-story="${y}"><span class="spark">✦</span> ${y} in review</button>` : ""}</div>` +
    list.map(t => {
      const legs = t.flights.map(id => flights.find(f => f.id === id)).filter(Boolean);
      const chain = legs.map((f, i) => `${i === 0 ? `<b>${f.from}</b>` : f.from !== legs[i - 1].to ? `<i title="Leg not logged">⋯</i><b>${f.from}</b>` : ""}<i>→</i><b>${f.to}</b>`).join("");
      return `<article class="trip${ui.trip === t.id ? " sel" : ""}" data-trip="${esc(t.id)}" tabindex="0">
        ${tripSvg(t)}
        <div><div class="when">${t.when.toUpperCase()} · ${t.days} DAY${t.days > 1 ? "S" : ""}${t.upcoming ? ' · <span class="tag up">upcoming</span>' : ""}</div>
          <h4>${esc(t.ai?.name || t.name)}</h4>${t.ai?.summary ? `<p class="sum">${esc(t.ai.summary)}</p>` : ""}<div class="chain">${chain}</div>
        ${me.canWrite && PEOPLE.length > 1 ? `<div class="who-row"><span class="muted">Who went</span>${PEOPLE.map(p => `<button type="button" class="who-tog" data-who="${esc(p.id)}" data-tripid="${esc(t.id)}" aria-pressed="${legs.every(f => whoOf(f).includes(p.id))}" style="--pc:${pColor(p.id)}">${avatar(p.id, true)}${esc(p.name)}</button>`).join("")}</div>` : ""}</div>
        <div class="side"><span class="km">${fmt(t.km)} <small class="muted">km</small></span><span class="flags">${t.countries.filter(c => c !== ap(tripData.home)?.cc).slice(0, 5).map(c => flag(c, 20)).join("")}</span><span class="muted">${legs.length} flight${legs.length > 1 ? "s" : ""}</span></div>
      </article>`;
    }).join("");
  }).join("")}</div>`;
  const nb = $("#nameBtn"); if (nb) nb.onclick = async () => {
    nb.disabled = true; nb.textContent = "Naming…";
    try { await api("/api/ai/trips", { method: "POST", body: JSON.stringify({ person: ui.person }) }); tripData = await api(tripsUrl()); renderTrips(); toast("Trips named"); }
    catch (e) { toast(e.message); nb.disabled = false; nb.textContent = "Try again"; }
  };
}
function selectTrip(id) {
  const t = tripData.trips.find(x => x.id === id); if (!t) return;
  ui.trip = ui.trip === id ? null : id;
  $$(".trip").forEach(a => a.classList.toggle("sel", a.dataset.trip === ui.trip));
  if (!ui.trip) { globe.setHighlight(null); return; }
  globe.setHighlight(new Set(t.flights));
  const pts = t.flights.map(i => flights.find(f => f.id === i)).filter(Boolean).flatMap(f => [ap(f.from), ap(f.to)]).map(a => [a.lon, a.lat]);
  globe.focusPoints(pts);
  $(".hero").scrollIntoView({ behavior: "smooth", block: "start" });
}
async function story(year) {
  openModal(`<div class="story"><p class="eyebrow">${year} in review</p><h2>Writing your year…</h2><p class="muted">Gemini is reading ${flights.filter(f => f.date.startsWith(year) && statusOf(f) !== "cancelled").length} flights.</p></div>`);
  try {
    const s = await api("/api/ai/story", { method: "POST", body: JSON.stringify({ year }) });
    openModal(`<div class="story"><p class="eyebrow"><span class="spark">✦</span> ${year} in review</p><h2>${esc(s.title)}</h2><p>${esc(s.story)}</p><ul>${(s.highlights || []).map(h => `<li>${esc(h)}</li>`).join("")}</ul></div>`);
  } catch (e) { openModal(`<div class="story"><h2>Couldn't write it</h2><p>${esc(e.message)}</p></div>`); }
}
function openModal(html) { $("#modalBody").innerHTML = html; $("#modal").hidden = false; }

/* ---------------- insights ---------------- */
function bars(vals, labels, { w = 560, h = 170, hi = -1, color = "url(#bg1)", label = "" } = {}) {
  const pad = { t: 20, b: 22 }, n = vals.length, bw = w / n, max = Math.max(...vals, 1), sc = v => v / max * (h - pad.t - pad.b);
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}"><defs><linearGradient id="bg1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF8A5B"/><stop offset="1" stop-color="#FF4D8D"/></linearGradient><linearGradient id="bg2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9FD6FF"/><stop offset="1" stop-color="#5E8BFF"/></linearGradient></defs>
    <line class="gl" x1="0" x2="${w}" y1="${h - pad.b}" y2="${h - pad.b}"/>
    ${vals.map((v, i) => { const x = i * bw + bw * .16, bwid = bw * .68, bh = sc(v);
      return `<rect x="${x}" y="${h - pad.b - bh}" width="${bwid}" height="${bh}" rx="3" fill="${color}" opacity="${hi < 0 || hi === i ? 1 : .45}"><title>${labels[i]}: ${v}</title></rect>` +
        (v ? `<text class="v" x="${x + bwid / 2}" y="${h - pad.b - bh - 6}" text-anchor="middle">${v}</text>` : "") + `<text x="${x + bwid / 2}" y="${h - 6}" text-anchor="middle">${labels[i]}</text>`; }).join("")}</svg>`;
}
function hbars(rows) {
  const max = Math.max(1, ...rows.map(r => r.n));
  return `<div class="hbars">${rows.map(r => `<div class="hbar"><span class="t" title="${esc(r.title || "")}">${r.label}</span><span class="b"><i style="width:${(r.n / max * 100).toFixed(1)}%"></i></span><span class="n">${r.n}</span></div>`).join("")}</div>`;
}
function heatmap(fl) {
  const ys = [...new Set(fl.map(f => f.date.slice(0, 4)))].sort(); if (!ys.length) return "";
  const years = d3.range(+ys[0], +ys.at(-1) + 1).map(String);
  const c = new Map(); fl.forEach(f => { const k = f.date.slice(0, 7); c.set(k, (c.get(k) || 0) + 1); });
  const max = Math.max(1, ...c.values());
  const color = v => v ? d3.interpolateRgb("#3B2A55", "#FF6F91")(Math.sqrt(v / max)) : "";
  return `<div class="heat" style="grid-template-columns:3.2em repeat(12,minmax(0,1fr))"><span></span>${MONTHS.map(m => `<span class="ml">${m[0]}</span>`).join("")}
    ${years.map(y => `<span class="lbl">${y}</span>${MONTHS.map((m, i) => { const k = `${y}-${String(i + 1).padStart(2, "0")}`, v = c.get(k) || 0; return `<span class="c" style="${v ? `background:${color(v)}` : ""}" title="${m} ${y}: ${v} flight${v === 1 ? "" : "s"}"></span>`; }).join("")}`).join("")}</div>`;
}
function renderInsights() {
  const el = $("#p-insights"), fl = flown(visible()), s = computeStats(fl, REF);
  if (!fl.length) { el.innerHTML = emptyState(); return; }
  const yrs = [...s.years.keys()].sort(), yearsAll = d3.range(+yrs[0], +yrs.at(-1) + 1).map(String);
  const peakM = s.months.indexOf(Math.max(...s.months)), peakD = s.dows.indexOf(Math.max(...s.dows));
  const busiest = [...s.years.entries()].sort((a, b) => b[1].n - a[1].n)[0];
  const co2 = s.km * 0.1 / 1000;
  el.innerHTML = `
  <div class="lead">
    <div><b>${fmt(s.km / Math.max(1, s.years.size))}</b><span>km in an average year</span></div>
    <div><b>${busiest[0]}</b><span>busiest year · ${busiest[1].n} flights</span></div>
    <div><b>${MONTHS[peakM]}</b><span>month you fly most</span></div>
    <div><b>${fmt(s.min / 60)} h</b><span>in the air</span></div>
    <div><b>${co2.toFixed(1)} t</b><span>CO₂, rough estimate</span></div>
  </div>
  <div class="grid">
    <div class="card span2"><h3>Flights by year</h3>${bars(yearsAll.map(y => s.years.get(y)?.n || 0), yearsAll.map(y => "’" + y.slice(2)), { label: "Flights per year" })}</div>
    <div class="card"><h3>Every month you've flown</h3>${heatmap(fl)}<p class="muted" style="margin-top:10px">Brighter squares mean more flights that month.</p></div>
    <div class="card"><h3>Top routes</h3>${hbars([...s.routes.values()].sort((a, b) => b.n - a.n).slice(0, 10).map(r => ({ label: `<span class="mono">${r.a[0]} ⇄ ${r.a[1]}</span>`, n: r.n })))}</div>
    <div class="card"><h3>Top airports</h3>${hbars([...s.airports.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, n]) => ({ label: `<span class="mono">${c}</span> ${esc(ap(c)?.city || "")}`, n })))}</div>
    <div class="card"><h3>Aircraft</h3>${meter(s.fam, ["Airbus", "Boeing", "Regional", "Other", "Unknown"], C5, ["Airbus", "Boeing", "Regional", "Other", "Not recorded"])}${hbars([...s.planes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, n]) => ({ label: `<span class="mono">${esc(c)}</span> ${esc(planeName(REF, c).replace(/^(Airbus|Boeing) /, ""))}`, title: planeName(REF, c), n })))}</div>
    <div class="card"><h3>Month</h3>${bars(s.months, MONTHS.map(m => m[0]), { w: 320, h: 150, hi: peakM, label: "Flights by month" })}<h3 style="margin-top:14px">Weekday</h3>${bars(s.dows, ["M", "T", "W", "T", "F", "S", "S"], { w: 320, h: 130, hi: peakD, color: "url(#bg2)", label: "Flights by weekday" })}</div>
    <div class="card"><h3>Haul</h3>${meter({ a: s.bands[0], b: s.bands[1], c: s.bands[2], d: s.bands[3] }, ["a", "b", "c", "d"], C5, ["< 800 km", "800–2,500", "2,500–5,000", "> 5,000"])}
      <dl class="kv"><dt>Domestic</dt><dd>${s.dom}</dd><dt>International</dt><dd>${s.intl}</dd><dt>Longest gap</dt><dd>${s.gap ? s.gap.d + " days" : "—"}</dd><dt>First flight logged</dt><dd>${s.first ? niceDate(s.first.date) : "—"}</dd><dt>Days since last flight</dt><dd>${s.last ? Math.max(0, dayDiff(s.last.date, TODAY)) : "—"}</dd></dl></div>
    <div class="card span2"><h3>New airports each year</h3>${bars(yearsAll.map(y => s.newAp.get(y) || 0), yearsAll.map(y => "’" + y.slice(2)), { h: 140, color: "url(#bg2)", label: "First-time airports per year" })}</div>
  </div>`;
}

/* ---------------- logbook ---------------- */
function sortVal(f, k) { switch (k) { case "route": return f.from + f.to; case "dur": return durMin(f); case "airline": return airlineName(REF, f.airline); case "status": return statusOf(f); case "who": return whoOf(f).join(","); default: return f[k] ?? ""; } }
function renderTable() {
  const terms = ui.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let list = (ui.status === "cancelled" ? flights.filter(f => statusOf(f) === "cancelled" && (inView(f) || !whoOf(f).length)) : ui.status === "unassigned" ? flights.filter(f => !whoOf(f).length) : visible()).filter(f => {
    if (ui.status === "flagged" && !FLAGS.has(f.id)) return false;
    if (!["all", "flagged", "cancelled", "unassigned"].includes(ui.status) && statusOf(f) !== ui.status) return false;
    if (!terms.length) return true;
    const hay = [f.date, f.flight, fnPretty(f), f.from, f.to, ap(f.from)?.city, ap(f.to)?.city, airlineName(REF, f.airline), f.aircraft, planeName(REF, f.aircraft), f.seat, f.trip, f.note, f.registration].join(" ").toLowerCase();
    return terms.every(t => hay.includes(t));
  });
  list.sort((a, b) => { const x = sortVal(a, ui.sort), y = sortVal(b, ui.sort); return (x > y ? 1 : x < y ? -1 : 0) * ui.dir || b.date.localeCompare(a.date); });
  const shown = list.slice(0, ui.limit);
  $("#tbody").innerHTML = shown.length ? shown.map(f => {
    const st = statusOf(f), fl = FLAGS.get(f.id);
    return `<tr data-id="${esc(f.id)}" class="${st === "cancelled" ? "cx" : ""}${ui.sel === f.id ? " sel" : ""}">
      <td class="mono">${f.date}</td><td class="mono">${esc(fnPretty(f))}</td><td class="route"><b>${f.from}</b><i>→</i><b>${f.to}</b></td>
      <td><span class="al-cell"><img src="https://pics.avs.io/120/48/${esc(f.airline)}.png" alt="" loading="lazy" data-fb="img">${esc(airlineName(REF, f.airline))}</span></td>
      <td class="r mono">${fmt(f.distanceKm || 0)}</td><td class="r mono">${hm(durMin(f))}</td><td class="mono" title="${esc(planeName(REF, f.aircraft))}">${esc(f.aircraft || "")}</td><td class="mono">${esc(f.seat || "")}</td>
      <td><span class="whos">${whoOf(f).map(id => avatar(id, true)).join("") || '<span class="tag warn">unassigned</span>'}</span></td>
      <td class="st">${st === "cancelled" ? '<span class="tag warn">not flown</span>' : st === "upcoming" ? '<span class="tag up">upcoming</span>' : '<span class="tag ok">flown</span>'}${fl ? `<span class="dot" title="${esc(fl[0].msg)}"></span>` : ""}</td>
      <td class="act owner-only">${st === "cancelled" ? '<button class="btn small" data-a="restore" type="button">Restore</button>' : '<button class="btn small" data-a="cancel" type="button" title="Booked but not flown">Not flown</button>'}
        <button class="btn small ghost" data-a="edit" type="button">Edit</button>${ui.confirmDel === f.id ? '<button class="btn small danger" data-a="del2" type="button">Confirm</button>' : '<button class="btn small ghost danger" data-a="del" type="button" aria-label="Delete">✕</button>'}</td></tr>`;
  }).join("") : `<tr><td colspan="11" style="text-align:center;padding:30px;color:var(--ink-3)">No flights match.</td></tr>`;
  $("#more").innerHTML = list.length > ui.limit ? `<button class="btn" id="moreBtn" type="button">Show ${Math.min(100, list.length - ui.limit)} more</button>` : `<span class="muted">${list.length} flight${list.length === 1 ? "" : "s"}</span>`;
  const mb = $("#moreBtn"); if (mb) mb.onclick = () => { ui.limit += 100; renderTable(); };
  $$("th[data-k]").forEach(th => { th.textContent = th.textContent.replace(/ [▲▼]$/, ""); if (th.dataset.k === ui.sort) th.textContent += ui.dir > 0 ? " ▲" : " ▼"; });
}
async function act(id, a) {
  const f = flights.find(x => x.id === id); if (!f) return;
  const patch = async body => { const doc = await api(`/api/flights/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }); Object.assign(f, doc); };
  try {
    if (a === "cancel") { await patch({ status: "cancelled" }); toast(`${fnPretty(f) || f.from + "→" + f.to} marked not flown`, () => act(id, "restore")); }
    else if (a === "restore") { await patch({ status: "flown" }); toast("Flight restored"); }
    else if (a === "keep") { await patch({ reviewed: true }); toast("Kept as flown", () => patch({ reviewed: false }).then(render)); }
    else if (a === "edit") { loadForm(f); go("add"); return; }
    else if (a === "del") { ui.confirmDel = id; renderTable(); return; }
    else if (a === "del2") {
      await api(`/api/flights/${encodeURIComponent(id)}`, { method: "DELETE" }); flights = flights.filter(x => x.id !== id); ui.confirmDel = null;
      const { id: _i, ...doc } = f; toast("Flight deleted", async () => { await api("/api/flights", { method: "POST", body: JSON.stringify(doc) }); reload(); });
    }
    tripData = await api(tripsUrl()); render();
  } catch (e) { toast(e.message); }
}

/* ---------------- review ---------------- */
function renderReview() {
  const el = $("#p-review");
  if (!GROUPS.length) { el.innerHTML = `<div class="empty"><h2>All clear</h2><p>Duplicates, codeshares logged twice and itineraries that don't connect will show up here.</p></div>`; return; }
  const sevName = { high: "Likely error", med: "Check this", low: "Worth a look" };
  el.innerHTML = `<div class="sec-head"><h2>Review <em>· ${GROUPS.length}</em></h2></div>
  <p class="intro">Wander checks each person's flights for ones that probably didn't happen: codeshares logged under two flight numbers, rebooked tickets whose original was never removed, and days where the flights can't form one journey. Mark those as <b>not flown</b>: they stay in the log but leave every statistic. Flights that aren't assigned to anyone wait here until you say who flew them.</p>
  <div class="rv">${GROUPS.map(g => {
    const others = PEOPLE.filter(p => p.id !== "me");
    const assign = g.kind === "unassigned" ? `<div class="assign owner-only" data-ids="${esc(g.items.map(f => f.id).join(","))}">
      ${PEOPLE.map(p => `<button class="btn small" type="button" data-assign="${esc(p.id)}">${avatar(p.id, true)} ${esc(p.name)}</button>`).join("")}
      ${others.length > 1 ? `<button class="btn small" type="button" data-assign="${esc(others.map(p => p.id).join(","))}">${esc(others.map(p => p.name).join(" & "))}</button>` : ""}
      ${PEOPLE.length > 1 ? `<button class="btn small" type="button" data-assign="${esc(PEOPLE.map(p => p.id).join(","))}">Everyone</button>` : ""}
      <button class="btn small ghost" type="button" data-assign-cancel>None of us flew these</button></div>` : "";
    return `<div class="rvg ${g.sev === "high" ? "high" : g.sev === "low" ? "low" : ""}"><p class="eyebrow">${sevName[g.sev]}${g.person && PEOPLE.length > 1 ? `<span class="person-tag">${esc(pName(g.person))}</span>` : ""}</p><h4>${esc(g.title)}</h4><p>${esc(g.msg)}</p>${assign}
    ${g.items.map(f => `<div class="rvrow" data-id="${esc(f.id)}"><span class="mono">${f.date}</span><b class="mono">${esc(fnPretty(f))}</b><span class="mono">${f.from} → ${f.to}</span><span>${esc(airlineName(REF, f.airline))}</span>
      <span class="sp">${g.suggest === f.id ? '<span class="tag warn">suggested</span>' : ""}<span class="owner-only"><button class="btn small" data-a="cancel" type="button">Not flown</button>${g.kind === "unassigned" ? "" : ' <button class="btn small ghost" data-a="keep" type="button">Flown</button>'}</span></span></div>`).join("")}</div>`;
  }).join("")}</div>`;
}

/* ---------------- add / edit ---------------- */
function fillLists() {
  $("#apList").innerHTML = [...REF.ap.values()].map(a => `<option value="${a.code}">${esc(a.city || "")} · ${esc(a.name)} (${a.cc})</option>`).join("");
  $("#acList").innerHTML = Object.entries(REF.planes).map(([c, n]) => `<option value="${esc(c)}">${esc(n)}</option>`).join("");
}
function fillFilters() {
  const al = new Map(); flights.forEach(f => f.airline && al.set(f.airline, (al.get(f.airline) || 0) + 1));
  $("#fAirline").innerHTML = `<option value="all">All airlines</option>` + [...al.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `<option value="${esc(c)}">${esc(airlineName(REF, c))} (${n})</option>`).join("");
  $("#fAirline").value = al.has(ui.airline) ? ui.airline : "all";
}
function formVals() {
  const v = id => $(id).value.trim();
  return { date: v("#iDate"), time: v("#iTime"), flight: v("#iFlight").replace(/\s+/g, "").toUpperCase(), from: v("#iFrom").slice(0, 3).toUpperCase(), to: v("#iTo").slice(0, 3).toUpperCase(),
    duration: v("#iDur"), aircraft: v("#iAircraft").toUpperCase(), seat: v("#iSeat").toUpperCase(), seatType: v("#iSeatType"), cabin: v("#iCabin"), reason: v("#iReason"),
    registration: v("#iReg").toUpperCase(), trip: v("#iTrip"), note: v("#iNote"), travellers: $$("#iWho input:checked").map(i => i.value) };
}
function formHints() {
  const f = formVals(), a = ap(f.from), b = ap(f.to);
  $("#hFrom").textContent = f.from ? (a ? `${a.city || a.name}, ${countryName(REF, a.cc)}` : "Unknown airport code") : "";
  $("#hTo").textContent = f.to ? (b ? `${b.city || b.name}, ${countryName(REF, b.cc)}` : "Unknown airport code") : "";
  const code = f.flight.slice(0, 2);
  let fh = f.flight.length >= 3 ? (REF.airlines[code] ? airlineName(REF, code) : "Airline code not recognised") : "";
  const prev = f.flight.length >= 3 && flights.filter(x => x.flight === f.flight).sort((x, y) => y.date.localeCompare(x.date))[0];
  if (prev) fh += ` · flown before: ${prev.from}→${prev.to}`;
  $("#hFlight").textContent = fh;
  if (prev && !f.from && !f.to && !ui.editing) { $("#iFrom").value = prev.from; $("#iTo").value = prev.to; if (!f.aircraft && prev.aircraft) $("#iAircraft").value = prev.aircraft; if (!f.duration && prev.duration) $("#iDur").value = prev.duration; return formHints(); }
  $("#hDur").textContent = a && b ? `${fmt(hav(a, b))} km · about ${hm(estDur(hav(a, b)))}` : "";
  $("#hAircraft").textContent = f.aircraft ? planeName(REF, f.aircraft) : "";
}
function resetForm() { $("#form").reset(); ui.editing = null; $("#formTitle").textContent = "Log a flight"; $("#saveBtn").textContent = "Save flight"; $("#formErr").textContent = ""; $("#iDate").value = TODAY; renderWhoPick(defaultWho()); formHints(); }
function loadForm(f) {
  resetForm(); ui.editing = f.id || null;
  if (f.id) { $("#formTitle").textContent = `Edit ${fnPretty(f) || "flight"} · ${f.date}`; $("#saveBtn").textContent = "Save changes"; }
  const set = (id, v) => ($(id).value = v || "");
  set("#iDate", f.date); set("#iTime", f.time); set("#iFlight", fnPretty(f)); set("#iFrom", f.from); set("#iTo", f.to); set("#iDur", f.duration); set("#iAircraft", f.aircraft); set("#iSeat", f.seat);
  set("#iSeatType", f.seatType); set("#iCabin", f.cabin || "economy"); set("#iReason", f.reason || "leisure"); set("#iReg", f.registration); set("#iTrip", f.trip); set("#iNote", f.note);
  renderWhoPick(Array.isArray(f.travellers) ? f.travellers : defaultWho());
  formHints();
}
async function saveForm(e) {
  e.preventDefault();
  const f = formVals(), err = validate(f, REF) || (f.travellers.length ? "" : "Choose who flew."); $("#formErr").textContent = err; if (err) return;
  const btn = $("#saveBtn"); btn.disabled = true;
  try {
    if (ui.editing) { const old = flights.find(x => x.id === ui.editing); await api(`/api/flights/${encodeURIComponent(ui.editing)}`, { method: "PUT", body: JSON.stringify({ ...f, status: old?.status === "cancelled" ? "cancelled" : undefined, reviewed: old?.reviewed }) }); toast("Changes saved"); }
    else { const doc = await api("/api/flights", { method: "POST", body: JSON.stringify(f) }); ui.sel = doc.id; toast(`${f.from}→${f.to} added`); }
    resetForm(); await reload();
  } catch (e2) { $("#formErr").textContent = e2.message; }
  btn.disabled = false;
}
async function lookup() {
  const f = formVals(); const b = $("#lookupBtn");
  if (!f.flight || !f.date) { $("#formErr").textContent = "Enter a flight number and date first."; return; }
  b.disabled = true; b.textContent = "…";
  try {
    const { results } = await api(`/api/lookup?flight=${encodeURIComponent(f.flight)}&date=${f.date}`);
    const r = results[0];
    if (!r) $("#formErr").textContent = "No schedule found for that flight on that date.";
    else { $("#iFrom").value = r.from; $("#iTo").value = r.to; if (r.time) $("#iTime").value = r.time; if (r.duration) $("#iDur").value = r.duration; if (r.registration) $("#iReg").value = r.registration; $("#formErr").textContent = ""; $("#formSub").textContent = `Found: ${r.airline} · ${r.aircraftModel || "aircraft not listed"}${r.status ? ` · ${r.status}` : ""}`; formHints(); }
  } catch (e) { $("#formErr").textContent = e.message; }
  b.disabled = false; b.textContent = "Look up";
}

/* ---------------- smart add ---------------- */
let smartImage = null, parsed = [];
async function shrink(file) {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) { return new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); }); }
  const s = Math.min(1, 1800 / Math.max(bmp.width, bmp.height)), c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s); c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.88);
}
async function smartGo() {
  const text = $("#smartText").value.trim(), st = $("#smartStatus");
  if (!text && !smartImage) { st.textContent = "Paste booking text or add an image first."; return; }
  st.textContent = "Reading your booking…"; $("#smartGo").disabled = true;
  try {
    const { flights: rows } = await api("/api/ai/extract", { method: "POST", body: JSON.stringify({ text, image: smartImage }) });
    parsed = rows; st.textContent = rows.length ? `Found ${rows.length} flight${rows.length > 1 ? "s" : ""}. Check them, then add.` : "No flights found in that.";
  } catch (e) { st.textContent = e.message; }
  $("#smartGo").disabled = false; renderParsed();
}
function renderParsed() {
  const ok = parsed.filter(r => !r.error).length;
  $("#parsed").innerHTML = parsed.map((r, i) => `<div class="pc" data-i="${i}"><span class="mono">${esc(r.date || "no date")}</span><b class="mono">${esc(fnPretty(r))}</b><span class="mono">${esc(r.from)} → ${esc(r.to)}</span>${r.seat ? `<span class="mono">${esc(r.seat)}</span>` : ""}${r.note ? `<span class="muted mono">${esc(r.note)}</span>` : ""}
    ${r.error ? `<span class="tag warn" title="${esc(r.error)}">needs fixing</span>` : ""}<span class="sp"><button class="btn small" data-p="edit" type="button">Edit</button>${r.error ? "" : '<button class="btn small primary" data-p="add" type="button">Add</button>'}</span></div>`).join("")
    + (ok > 1 ? `<div class="row"><button class="btn primary" id="addAll" type="button">Add all ${ok}</button></div>` : "");
  const aa = $("#addAll"); if (aa) aa.onclick = async () => { aa.disabled = true; for (let i = parsed.length - 1; i >= 0; i--) if (!parsed[i].error) await addParsed(i, true); toast("Flights added"); await reload(); };
}
async function addParsed(i, quiet) {
  const r = parsed[i];
  try { await api("/api/flights", { method: "POST", body: JSON.stringify({ ...r, travellers: defaultWho() }) }); parsed.splice(i, 1); renderParsed(); if (!quiet) { toast(`${r.from}→${r.to} added`); await reload(); } }
  catch (e) { toast(e.message); }
}

/* ---------------- ask ---------------- */
const SUGGEST = ["How many times have I flown to Delhi?", "Which airline did I fly most in 2023?", "What was my longest trip abroad?", "Which months do I travel most, and why might that be?", "How many new countries did I visit after 2020?"];
function openAsk() {
  $("#drawer").hidden = false; $("#askInput").focus();
  $("#suggest").innerHTML = SUGGEST.map(s => `<button type="button">${esc(s)}</button>`).join("");
  if (!$("#chat").children.length) $("#chat").innerHTML = `<div class="msg ai">Ask anything about your ${flights.length} flights: counts, records, patterns, comparisons between years.</div>`;
}
async function ask(q) {
  if (!q.trim()) return;
  const chat = $("#chat");
  chat.insertAdjacentHTML("beforeend", `<div class="msg me">${esc(q)}</div><div class="msg ai wait">Thinking…</div>`);
  chat.scrollTop = chat.scrollHeight; $("#askInput").value = "";
  const w = chat.lastElementChild;
  try { const { answer } = await api("/api/ai/ask", { method: "POST", body: JSON.stringify({ question: q }) }); w.classList.remove("wait"); w.textContent = answer; }
  catch (e) { w.classList.remove("wait"); w.textContent = e.message; }
  chat.scrollTop = chat.scrollHeight;
}

/* ---------------- replay ---------------- */
async function replay() {
  if (ui.replaying) { ui.replaying = false; return; }
  const ys = [...new Set(flown(visible(true)).map(f => f.date.slice(0, 4)))].sort(); if (!ys.length) return;
  ui.replaying = true; const btn = $("#replayBtn span"); btn.textContent = "Stop";
  const prevYear = ui.year; ui.year = "all"; render();
  const all = flown(visible()); focusVisible();
  for (const y of ys) {
    if (!ui.replaying) break;
    globe.setCutoff(`${y}-12-31`, `${y}-01-01`);
    const upto = all.filter(f => f.date <= `${y}-12-31`), s = computeStats(upto, REF);
    $("#heroEyebrow").textContent = `Up to ${y}`; countUp($("#heroKm"), s.km, 700);
    $$(".yr").forEach(b => b.classList.toggle("on", b.dataset.y === y)); $("#years").classList.add("filtered");
    await new Promise(r => setTimeout(r, 1300));
  }
  globe.setCutoff(null); ui.replaying = false; btn.textContent = "Replay the years"; ui.year = prevYear; render();
}

/* ---------------- routing & wiring ---------------- */
function go(tab, initial) {
  if (!["overview", "trips", "insights", "logbook", "review", "add"].includes(tab)) tab = "overview";
  if (tab === "add" && !me.canWrite) tab = "overview";
  ui.tab = tab; document.body.dataset.tab = tab;
  $$(".nav a").forEach(a => a.toggleAttribute("aria-current", a.dataset.tab === tab)); $$(".nav a[aria-current]").forEach(a => a.setAttribute("aria-current", "page"));
  $$(".panel").forEach(p => (p.hidden = p.id !== "p-" + tab));
  if (location.hash !== "#" + tab) history.replaceState(null, "", "#" + tab);
  if (!initial || REF) render();
}
function isFullscreen() { return document.fullscreenElement === $("#hero") || $("#hero").classList.contains("pseudo-fs"); }
async function toggleFullscreen() {
  const hero = $("#hero");
  if (document.fullscreenElement) { await document.exitFullscreen().catch(() => {}); return; }
  if (hero.classList.contains("pseudo-fs")) { hero.classList.remove("pseudo-fs"); document.body.style.overflow = ""; return; }
  try { await hero.requestFullscreen(); }
  catch { hero.classList.add("pseudo-fs"); document.body.style.overflow = "hidden"; } // iPhone Safari has no element full screen
}
function showLogin() { $("#login").hidden = false; $("#pw").focus(); }

function wire() {
  window.addEventListener("hashchange", () => go(location.hash.slice(1)));
  $("#loginForm").addEventListener("submit", async e => {
    e.preventDefault(); $("#loginErr").textContent = "";
    try { await api("/api/login", { method: "POST", body: JSON.stringify({ password: $("#pw").value }) }); location.reload(); }
    catch (err) { $("#loginErr").textContent = err.message; }
  });
  $("#signBtn").onclick = async () => { await api("/api/logout", { method: "POST", body: "{}" }); location.reload(); };
  $("#yAll").onclick = () => setYear("all");
  $("#years").onclick = e => { const b = e.target.closest("[data-y]"); if (b) setYear(ui.year === b.dataset.y ? "all" : b.dataset.y); };
  $("#fAirline").onchange = e => { ui.airline = e.target.value; render(); focusVisible(); };
  $("#fCancelled").onchange = e => { ui.showCancelled = e.target.checked; render(); };
  $$(".seg button").forEach(b => b.onclick = () => {
    $$(".seg button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    $("#globeWrap").classList.toggle("flat", b.dataset.view === "flat"); requestAnimationFrame(() => { globe.setMode(b.dataset.view); focusVisible(); });
  });
  $("#replayBtn").onclick = replay;
  $("#fsBtn").onclick = toggleFullscreen;
  $("#zIn").onclick = () => globe.zoomBy(1.5);
  $("#zOut").onclick = () => globe.zoomBy(1 / 1.5);
  $("#zFit").onclick = () => focusVisible();
  $("#scrollCue").onclick = e => { e.preventDefault(); window.scrollTo({ top: $("#hero").offsetHeight, behavior: "smooth" }); };
  document.addEventListener("keydown", e => { if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey && !/input|textarea|select/i.test(document.activeElement?.tagName || "")) toggleFullscreen(); });
  document.addEventListener("fullscreenchange", () => $("#hero").classList.toggle("is-fs", isFullscreen()));
  const setBar = () => document.documentElement.style.setProperty("--bar-h", $(".bar").offsetHeight + "px");
  new ResizeObserver(setBar).observe($(".bar")); setBar();
  $("#addBtn").onclick = () => { resetForm(); go("add"); $("#iFlight").focus(); };
  $("#askBtn").onclick = openAsk; $("#drawerClose").onclick = () => ($("#drawer").hidden = true);
  $("#askForm").addEventListener("submit", e => { e.preventDefault(); ask($("#askInput").value); });
  $("#suggest").onclick = e => { const b = e.target.closest("button"); if (b) ask(b.textContent); };
  $("#modalX").onclick = () => ($("#modal").hidden = true);
  $("#modal").onclick = e => { if (e.target.id === "modal") $("#modal").hidden = true; };
  document.addEventListener("keydown", e => { if (e.key === "Escape") { $("#modal").hidden = true; $("#drawer").hidden = true; } });
  let qt; $("#q").oninput = e => { clearTimeout(qt); qt = setTimeout(() => { ui.q = e.target.value; ui.limit = 80; renderTable(); }, 120); };
  $("#fStatus").onchange = e => { ui.status = e.target.value; ui.limit = 80; renderTable(); };
  $$("th[data-k]").forEach(th => th.onclick = () => { const k = th.dataset.k; ui.dir = ui.sort === k ? -ui.dir : (["date", "distanceKm", "dur"].includes(k) ? -1 : 1); ui.sort = k; renderTable(); });
  $("#tbody").onclick = e => {
    const tr = e.target.closest("tr[data-id]"); if (!tr) return;
    const b = e.target.closest("button[data-a]"); if (b) { act(tr.dataset.id, b.dataset.a); return; }
    ui.confirmDel = null; ui.sel = ui.sel === tr.dataset.id ? null : tr.dataset.id;
    const f = flights.find(x => x.id === ui.sel);
    globe.setHighlight(f ? new Set([f.id]) : null);
    if (f) { globe.focusPoints([[ap(f.from).lon, ap(f.from).lat], [ap(f.to).lon, ap(f.to).lat]]); $(".hero").scrollIntoView({ behavior: "smooth" }); }
    renderTable();
  };
  $("#people").onclick = e => { const b = e.target.closest("[data-person]"); if (b && b.dataset.person !== ui.person) setPerson(b.dataset.person); };
  $("#peopleBtn").onclick = openPeople;
  $("#p-review").onclick = async e => {
    const box = e.target.closest(".assign");
    if (box) {
      const ids = box.dataset.ids.split(","), b = e.target.closest("button"); if (!b) return;
      b.disabled = true;
      try {
        if (b.hasAttribute("data-assign-cancel")) { for (const id of ids) await api(`/api/flights/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) }); toast(`${ids.length} flight${ids.length > 1 ? "s" : ""} marked not flown`); }
        else { const who = b.dataset.assign.split(","); await api("/api/flights/travellers", { method: "POST", body: JSON.stringify({ ids, travellers: who }) }); toast(`Assigned to ${who.map(pName).join(" & ")}`, async () => { await api("/api/flights/travellers", { method: "POST", body: JSON.stringify({ ids, travellers: [] }) }); await reload(); }); }
        await reload();
      } catch (err) { toast(err.message); b.disabled = false; }
      return;
    }
    const b = e.target.closest("button[data-a]"), r = e.target.closest("[data-id]"); if (b && r) act(r.dataset.id, b.dataset.a);
  };
  $("#p-trips").onclick = async e => {
    const wb = e.target.closest("[data-who]");
    if (wb) {
      const t = tripData.trips.find(x => x.id === wb.dataset.tripid); if (!t) return;
      const on = wb.getAttribute("aria-pressed") === "true", pid = wb.dataset.who;
      try { await api("/api/flights/travellers", { method: "POST", body: JSON.stringify({ ids: t.flights, [on ? "remove" : "add"]: [pid] }) }); await reload(); toast(`${pName(pid)} ${on ? "removed from" : "added to"} this trip`); }
      catch (err) { toast(err.message); }
      return;
    }
    const kb = e.target.closest("[data-kind]"); if (kb) { ui.tripKind = kb.dataset.kind; renderTrips(); return; } const s = e.target.closest("[data-story]"); if (s) { story(s.dataset.story); return; } const t = e.target.closest("[data-trip]"); if (t) selectTrip(t.dataset.trip); };
  $("#p-trips").onkeydown = e => { if (e.key === "Enter") { const t = e.target.closest("[data-trip]"); if (t) selectTrip(t.dataset.trip); } };
  $("#form").addEventListener("submit", saveForm);
  ["#iFlight", "#iFrom", "#iTo", "#iAircraft", "#iDur"].forEach(id => $(id).addEventListener("input", formHints));
  $("#resetBtn").onclick = resetForm; $("#lookupBtn").onclick = lookup;
  $("#importBtn").onclick = () => $("#importFile").click();
  $("#importFile").onchange = async e => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    try { const r = await api("/api/import", { method: "POST", body: await f.text(), raw: true, headers: { "content-type": "text/csv" } }); toast(`Imported ${r.added}${r.skipped ? `, skipped ${r.skipped} duplicates` : ""}${r.failed ? `, ${r.failed} couldn't be read` : ""}.`); await reload(); }
    catch (err) { toast(err.message); }
  };
  const drop = $("#drop"), pick = async f => { if (!f || !/^image\//.test(f.type)) { $("#smartStatus").textContent = "Choose an image file."; return; } smartImage = await shrink(f); drop.classList.add("on"); $("#dropText").textContent = `Image ready: ${f.name}. Click to replace.`; };
  $("#smartImg").onchange = e => pick(e.target.files[0]);
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("on"); });
  drop.addEventListener("dragleave", () => { if (!smartImage) drop.classList.remove("on"); });
  drop.addEventListener("drop", e => { e.preventDefault(); pick(e.dataTransfer.files[0]); });
  drop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#smartImg").click(); } });
  $("#smartGo").onclick = smartGo;
  $("#parsed").onclick = e => {
    const b = e.target.closest("button[data-p]"), c = e.target.closest("[data-i]"); if (!b || !c) return;
    const i = +c.dataset.i; if (b.dataset.p === "add") addParsed(i); else { loadForm({ ...parsed[i], id: null }); parsed.splice(i, 1); renderParsed(); $("#iDate").focus(); }
  };
}

boot();
