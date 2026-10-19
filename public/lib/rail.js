// Indian Railways helpers: ticket details on train legs, an IRCTC SMS reader, and quick links.
// Pure functions, shared by the browser and the server. No network: everything here works offline.

export const RAIL_CLASSES = { "1A": "First AC", "2A": "AC 2 Tier", "3A": "AC 3 Tier", "3E": "AC 3 Economy", EC: "Executive Chair", EA: "Executive Anubhuti", CC: "AC Chair Car", VS: "Vistadome", SL: "Sleeper", "2S": "Second Sitting", FC: "First Class" };
export const RAIL_QUOTAS = { GN: "General", TQ: "Tatkal", PT: "Premium Tatkal", LD: "Ladies", SS: "Senior citizen", HP: "Divyang", DF: "Defence", FT: "Foreign tourist" };
export const BERTH_TYPES = { LB: "Lower", MB: "Middle", UB: "Upper", SL: "Side lower", SU: "Side upper", WS: "Window", MS: "Middle seat", AS: "Aisle" };

// Major stations: code -> [name, nearest airport]. A train leg's ends are stored as airport codes (the map and the
// statistics work in airports), so a known station fills them in; the station code is kept for display.
export const STATIONS = {
  BCT: ["Mumbai Central", "BOM"], MMCT: ["Mumbai Central", "BOM"], CSMT: ["Mumbai CSMT", "BOM"], LTT: ["Lokmanya Tilak Terminus", "BOM"],
  BDTS: ["Bandra Terminus", "BOM"], DR: ["Dadar", "BOM"], DDR: ["Dadar", "BOM"], TNA: ["Thane", "BOM"], KYN: ["Kalyan", "BOM"], PNVL: ["Panvel", "BOM"],
  BSR: ["Vasai Road", "BOM"], BVI: ["Borivali", "BOM"],
  NDLS: ["New Delhi", "DEL"], DLI: ["Delhi Jn", "DEL"], NZM: ["Hazrat Nizamuddin", "DEL"], ANVT: ["Anand Vihar Terminal", "DEL"], DEE: ["Delhi Sarai Rohilla", "DEL"], GZB: ["Ghaziabad", "DEL"],
  MAS: ["Chennai Central", "MAA"], MS: ["Chennai Egmore", "MAA"], TBM: ["Tambaram", "MAA"],
  SBC: ["KSR Bengaluru", "BLR"], YPR: ["Yesvantpur", "BLR"], SMVB: ["SMVT Bengaluru", "BLR"], BNC: ["Bengaluru Cantt", "BLR"], KJM: ["Krishnarajapuram", "BLR"],
  HWH: ["Howrah", "CCU"], SDAH: ["Sealdah", "CCU"], KOAA: ["Kolkata", "CCU"], SHM: ["Shalimar", "CCU"],
  PUNE: ["Pune Jn", "PNQ"], ADI: ["Ahmedabad Jn", "AMD"], SBIB: ["Sabarmati", "AMD"],
  SC: ["Secunderabad", "HYD"], HYB: ["Hyderabad Deccan", "HYD"], KCG: ["Kacheguda", "HYD"], LPI: ["Lingampalli", "HYD"],
  JP: ["Jaipur Jn", "JAI"], LKO: ["Lucknow Charbagh", "LKO"], LJN: ["Lucknow Jn", "LKO"], BPL: ["Bhopal Jn", "BHO"], RKMP: ["Rani Kamalapati", "BHO"],
  CDG: ["Chandigarh", "IXC"], KLK: ["Kalka", "IXC"], MAO: ["Madgaon", "GOI"], KRMI: ["Karmali", "GOI"], THVM: ["Thivim", "GOI"], VSG: ["Vasco da Gama", "GOI"],
  ERS: ["Ernakulam Jn", "COK"], ERN: ["Ernakulam Town", "COK"], TVC: ["Thiruvananthapuram Central", "TRV"], CLT: ["Kozhikode", "CCJ"], CAN: ["Kannur", "CNN"],
  MAQ: ["Mangaluru Central", "IXE"], MAJN: ["Mangaluru Jn", "IXE"], CBE: ["Coimbatore Jn", "CJB"], MDU: ["Madurai Jn", "IXM"], TPJ: ["Tiruchchirappalli", "TRZ"],
  BBS: ["Bhubaneswar", "BBI"], PURI: ["Puri", "BBI"], VSKP: ["Visakhapatnam", "VTZ"], BZA: ["Vijayawada Jn", "VGA"], TPTY: ["Tirupati", "TIR"],
  NGP: ["Nagpur Jn", "NAG"], INDB: ["Indore Jn", "IDR"], UJN: ["Ujjain Jn", "IDR"], JBP: ["Jabalpur", "JLR"],
  PNBE: ["Patna Jn", "PAT"], RNC: ["Ranchi", "IXR"], BSB: ["Varanasi Jn", "VNS"], BSBS: ["Banaras", "VNS"], PRYJ: ["Prayagraj Jn", "IXD"], CNB: ["Kanpur Central", "KNU"],
  AGC: ["Agra Cantt", "AGR"], GWL: ["Gwalior", "GWL"], GHY: ["Guwahati", "GAU"], NJP: ["New Jalpaiguri", "IXB"],
  ASR: ["Amritsar Jn", "ATQ"], JAT: ["Jammu Tawi", "IXJ"], SVDK: ["SMVD Katra", "IXJ"], DDN: ["Dehradun", "DED"], HW: ["Haridwar", "DED"],
  UDZ: ["Udaipur City", "UDR"], JU: ["Jodhpur Jn", "JDH"], JSM: ["Jaisalmer", "JSA"], AII: ["Ajmer Jn", "KQH"],
  ST: ["Surat", "STV"], BRC: ["Vadodara Jn", "BDQ"], RJT: ["Rajkot Jn", "HSR"], NK: ["Nashik Road", "ISK"], CPSN: ["Chh. Sambhajinagar", "IXU"], AWB: ["Aurangabad", "IXU"],
  KOP: ["Kolhapur", "KLH"], MYS: ["Mysuru Jn", "MYQ"], UBL: ["Hubballi Jn", "HBX"], BGM: ["Belagavi", "IXG"],
  DBG: ["Darbhanga", "DBR"], GKP: ["Gorakhpur", "GOP"], SHC: ["Silchar", "IXS"], DMV: ["Dimapur", "DMU"], RPR: ["Raipur Jn", "RPR"], DURG: ["Durg", "RPR"], BSP: ["Bilaspur", "PAB"], SGNR: ["Sri Ganganagar", "SHA"],
};

const up = (v, n) => String(v ?? "").trim().toUpperCase().slice(0, n);
const txt = (v, n) => String(v ?? "").trim().slice(0, n);
const compact = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== undefined && v !== false && !(Array.isArray(v) && !v.length)));

/** A booking reference: 10 digits for Indian Railways, 6 characters for most airlines. */
export const cleanPnr = v => String(v ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 12);

/** Cleans the ticket details stored on a train leg. Returns undefined when there's nothing worth keeping. */
export function cleanRail(r) {
  if (!r || typeof r !== "object") return undefined;
  const pax = (Array.isArray(r.passengers) ? r.passengers : []).slice(0, 12).map(p => compact({
    who: txt(p?.who, 32).toLowerCase(), coach: up(p?.coach, 5).replace(/\s+/g, ""), berth: up(p?.berth, 4).replace(/\s+/g, ""),
    berthType: BERTH_TYPES[up(p?.berthType, 3)] ? up(p?.berthType, 3) : "", status: up(p?.status, 20),
  })).filter(p => Object.keys(p).length);
  const time = v => (/^\d{1,2}:\d{2}$/.test(String(v ?? "").trim()) ? String(v).trim().padStart(5, "0") : "");
  const out = compact({
    trainName: txt(r.trainName, 60), cls: RAIL_CLASSES[up(r.cls, 3)] ? up(r.cls, 3) : "", quota: RAIL_QUOTAS[up(r.quota, 3)] ? up(r.quota, 3) : "",
    fromStn: up(r.fromStn, 6).replace(/[^A-Z]/g, ""), toStn: up(r.toStn, 6).replace(/[^A-Z]/g, ""), arr: time(r.arr), arrDay: Math.max(0, Math.min(3, parseInt(r.arrDay, 10) || 0)) || "",
    platform: up(r.platform, 6), status: up(r.status, 24), chart: r.chart === true || r.chart === "true", updatedAt: txt(r.updatedAt, 30), passengers: pax,
  });
  return Object.keys(out).length ? out : undefined;
}

/** "CNF", "RAC 12", "WL 34" -> ok | rac | wl | "" for the colour of a status chip. */
export function statusKind(s) {
  const t = up(s, 30);
  if (!t) return "";
  if (/\b(CAN|CANCEL)/.test(t)) return "wl";
  if (/WL\b|WL\s*\d|^W\/L/.test(t)) return "wl";
  if (/^RAC|\bRAC\b/.test(t)) return "rac";
  if (/CNF|CONFIRM|^[A-Z]{1,2}\d{1,2}\s*[,/ ]?\s*\d+/.test(t)) return "ok";
  return "";
}

/**
 * Reads an IRCTC booking or chart SMS (or the top of an e-ticket) and returns what it can:
 * { pnr, train, date: YYYY-MM-DD, time, cls, fromStn, toStn, from, to, party, passengers: [{coach, berth, berthType, status}] }.
 * IRCTC has used a few layouts over the years; this is deliberately tolerant and never throws.
 */
export function parseIrctc(text, today = new Date().toISOString().slice(0, 10)) {
  const s = String(text || "").replace(/\s+/g, " ").trim(), U = s.toUpperCase(), out = { passengers: [] };
  const m = (re, i = 1) => { const x = re.exec(U); return x ? x[i] : ""; };
  out.pnr = m(/PNR\s*(?:NO\.?)?\s*[:\-.]?\s*(\d{10})\b/) || m(/\b(\d{10})\b/);
  out.train = m(/\b(?:TRN|TRAIN(?:\s*NO)?|TR\s*NO)\s*[:\-.]?\s*(\d{5})\b/) || "";
  const d = /\b(?:DOJ|DT|DATE(?:\s*OF\s*JOURNEY)?)\s*[:\-.]?\s*(\d{1,2})[-/.](\d{1,2}|[A-Z]{3})[-/.](\d{2,4})\b/.exec(U);
  if (d) {
    const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const mo = /\d/.test(d[2]) ? +d[2] : months.indexOf(d[2]) + 1, yr = d[3].length === 2 ? 2000 + +d[3] : +d[3];
    if (mo >= 1 && mo <= 12) out.date = `${yr}-${String(mo).padStart(2, "0")}-${String(+d[1]).padStart(2, "0")}`;
  }
  const t = /\b(?:DP|DEP|DEPARTURE|TIME|SCH(?:EDULED)?\s*DEP)\s*[:\-.]?\s*(\d{1,2}):(\d{2})\b/.exec(U);
  if (t) out.time = `${t[1].padStart(2, "0")}:${t[2]}`;
  out.cls = m(/\b(?:CLS|CLASS)\s*[:\-.]?\s*(1A|2A|3A|3E|EC|EA|CC|VS|SL|2S|FC)\b/) || m(/(?:^|[,\s])(1A|2A|3A|3E|EC|EA|CC|SL|2S)(?=[,\s]|$)/);
  if (/\bTATKAL\b|\bTQ\b/.test(U)) out.quota = /PREMIUM/.test(U) ? "PT" : "TQ";
  // Route: "BCT-NDLS", "FRM BCT TO NDLS", "FROM BCT TO NDLS"
  const r = /\bFR(?:O)?M\s*[:\-]?\s*([A-Z]{2,5})\s+TO\s*[:\-]?\s*([A-Z]{2,5})\b/.exec(U) || /(?:^|[,\s])([A-Z]{2,5})\s*-\s*([A-Z]{2,5})(?=[,\s]|$)/.exec(U.replace(/\bPNR[^,]*|\bTRN[^,]*|\bDOJ[^,]*/g, ""));
  if (r) { out.fromStn = r[1]; out.toStn = r[2]; }
  for (const k of ["fromStn", "toStn"]) { const st = STATIONS[out[k]]; if (st) out[k === "fromStn" ? "from" : "to"] = st[1]; }
  const party = /[A-Z][A-Z .']{1,40}\+\s*(\d{1,2})\b/.exec(U);
  out.party = party ? +party[1] + 1 : undefined;
  // Seats: "B4 34 LB", "S5,34", "P1-B4,34", "CNF/B4/34/LB"; waitlist and RAC: "WL 12", "RLWL 5", "RAC 23", "P2-WL 7".
  const seatRe = /(?:P\d+\s*[-:]\s*)?(?:CNF\s*\/\s*)?\b([A-Z]{1,2}\d{1,2}|H[A-Z]?\d?|A\d)\s*[ ,/]\s*(\d{1,3})(?:\s*[ ,/]\s*(LB|MB|UB|SL|SU|WS|MS|AS))?\b/g;
  const wlRe = /(?:P\d+\s*[-:]\s*)?\b(RLWL|PQWL|GNWL|TQWL|RSWL|RQWL|WL|RAC)\s*[ /]?\s*(\d{1,4})\b/g;
  const found = [];
  const skip = new Set([out.train, out.pnr].filter(Boolean));
  for (const x of U.matchAll(seatRe)) {
    if (/^\d/.test(x[1]) || skip.has(x[2])) continue;
    found.push({ at: x.index, p: { coach: x[1], berth: x[2], ...(x[3] ? { berthType: x[3] } : {}), status: "CNF" } });
  }
  for (const x of U.matchAll(wlRe)) found.push({ at: x.index, p: { status: `${x[1]} ${x[2]}` } });
  if (/CHART\s*(?:IS\s*)?PREPARED/.test(U)) out.chart = true;
  out.passengers = found.sort((a, b) => a.at - b.at).map(f => f.p).slice(0, 12);
  if (!out.date && out.pnr) out.date = today;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)));
}

/** Quick links for a leg. None needs an API key; the official ones are marked. */
export function legLinks(f) {
  const g = q => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  if (f.mode === "train") {
    const train = (f.flight || "").replace(/\D/g, "").slice(0, 5), pnr = f.pnr;
    return [
      pnr && { label: "PNR status", href: "https://www.indianrail.gov.in/enquiry/PNR/PnrEnquiry.html?locale=en", official: true, copy: pnr },
      pnr && { label: "SMS PNR to 139", href: `sms:139?&body=${encodeURIComponent(`PNR ${pnr}`)}`, note: "works without data" },
      train && { label: "Live running status", href: g(`${train} train live running status`) },
      { label: "NTES (official)", href: "https://enquiry.indianrail.gov.in/mntes/", official: true },
      train && { label: "Coach position", href: g(`${train} coach position`) },
      { label: "Call 139", href: "tel:139", note: "Rail enquiry & help" },
    ].filter(Boolean);
  }
  if (f.mode === "air" || !f.mode) {
    const fl = (f.flight || "").toUpperCase();
    return [fl && { label: "Flight status", href: g(`${fl.slice(0, 2)} ${fl.slice(2)} flight status`) }].filter(Boolean);
  }
  return [];
}
