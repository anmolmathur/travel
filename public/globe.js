/* global d3, topojson */
// Canvas globe / flat map with animated routes. Uses the d3 and topojson globals.

const TAU = Math.PI * 2;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

export function createGlobe(canvas, { world110, world50, onAirport, onRoute, onHover }) {
  const ctx = canvas.getContext("2d");
  const land110 = topojson.feature(world110, world110.objects.countries).features;
  const land50 = topojson.feature(world50, world50.objects.countries).features;
  const borders110 = topojson.mesh(world110, world110.objects.countries, (a, b) => a !== b);
  const borders50 = topojson.mesh(world50, world50.objects.countries, (a, b) => a !== b);
  const graticule = d3.geoGraticule10();
  const sphere = { type: "Sphere" };

  let W = 0, H = 0, dpr = 1;
  let mode = "globe";
  let rot = [-60, -18], k = 1, tx = 0, ty = 0;
  let routes = [], airports = [], visited = new Set(), home = null;
  let highlight = null, cutoff = null, freshFrom = null;
  let lastInteract = 0, anim = null, hoverAp = null;
  const base = document.createElement("canvas"), bctx = base.getContext("2d");
  let baseKey = "";

  const proj = () => {
    if (mode === "globe") {
      const r = Math.min(W, H) / 2 * 0.86;
      return d3.geoOrthographic().clipAngle(90).precision(0.4).rotate(rot).scale(r * k).translate([W / 2, H / 2]);
    }
    const p = d3.geoNaturalEarth1().rotate([rot[0], 0]).precision(0.3);
    p.fitExtent([[6, 6], [W - 6, H - 6]], sphere);
    const s = p.scale(), t = p.translate();
    return p.scale(s * k).translate([t[0] + tx, t[1] + ty]);
  };
  const visible = (P, lonlat) => mode !== "globe" || d3.geoDistance(lonlat, [-rot[0], -rot[1]]) < Math.PI / 2 - 0.015;

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(10, r.width); H = Math.max(10, r.height);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    base.width = canvas.width; base.height = canvas.height;
    baseKey = "";
  }

  /* ---------- drawing ---------- */
  function drawBase(P) {
    const key = [mode, W, H, rot[0].toFixed(2), rot[1].toFixed(2), k.toFixed(3), tx.toFixed(1), ty.toFixed(1), visited.size].join("|");
    if (key === baseKey) return;
    baseKey = key;
    const c = bctx; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
    const path = d3.geoPath(P, c);
    const [cx, cy] = P.translate(), r = P.scale();
    const hi = mode === "globe" && k < 2.2;
    if (mode === "globe") {
      const g = c.createRadialGradient(cx, cy, r * 0.9, cx, cy, r * 1.22);
      g.addColorStop(0, "rgba(124,196,255,0.22)"); g.addColorStop(0.35, "rgba(124,160,255,0.08)"); g.addColorStop(1, "rgba(124,160,255,0)");
      c.fillStyle = g; c.beginPath(); c.arc(cx, cy, r * 1.22, 0, TAU); c.fill();
      const o = c.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
      o.addColorStop(0, "#14284C"); o.addColorStop(1, "#060D1D");
      c.fillStyle = o; c.beginPath(); path(sphere); c.fill();
    } else {
      c.fillStyle = "#081226"; c.beginPath(); path(sphere); c.fill();
    }
    c.strokeStyle = "rgba(140,170,230,0.07)"; c.lineWidth = 0.6; c.beginPath(); path(graticule); c.stroke();
    const feats = hi ? land110 : land50;
    c.fillStyle = "#18253F"; c.beginPath(); for (const f of feats) if (!visited.has(f.id)) path(f); c.fill();
    const vg = c.createLinearGradient(0, 0, W, H); vg.addColorStop(0, "#2E4C8A"); vg.addColorStop(1, "#3D3A86");
    c.fillStyle = vg; c.beginPath(); for (const f of feats) if (visited.has(f.id)) path(f); c.fill();
    c.strokeStyle = "rgba(150,180,235,0.16)"; c.lineWidth = 0.5; c.beginPath(); path(hi ? borders110 : borders50); c.stroke();
    if (mode === "globe") {
      const s = c.createRadialGradient(cx - r * 0.45, cy - r * 0.5, r * 0.05, cx, cy, r * 1.02);
      s.addColorStop(0, "rgba(255,255,255,0.07)"); s.addColorStop(0.55, "rgba(255,255,255,0)"); s.addColorStop(0.9, "rgba(0,0,0,0.18)"); s.addColorStop(1, "rgba(0,0,0,0.45)");
      c.fillStyle = s; c.beginPath(); path(sphere); c.fill();
      c.strokeStyle = "rgba(124,196,255,0.25)"; c.lineWidth = 1; c.beginPath(); path(sphere); c.stroke();
    }
  }

  function frame(now) {
    if (!W) return;
    if (anim) {
      const t = Math.max(0, Math.min(1, (now - anim.t0) / anim.dur)), e = d3.easeCubicInOut(t);
      rot = anim.rot(e); k = anim.k(e); if (anim.tx) { tx = anim.tx(e); ty = anim.ty(e); }
      if (t >= 1) anim = null;
    } else if (mode === "globe" && !reduceMotion && now - lastInteract > 3500 && !highlight) {
      rot = [rot[0] + 0.035, rot[1]];
    }
    const P = proj();
    drawBase(P);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const path = d3.geoPath(P, ctx);
    const zoomW = Math.pow(k, 0.35);

    // routes
    ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round";
    const shown = routes.filter(r => !cutoff || r.first <= cutoff);
    for (const r of shown) {
      const lit = !highlight || r.ids.some(id => highlight.has(id));
      const fresh = freshFrom && r.first >= freshFrom;
      const w = (0.7 + Math.sqrt(r.n) * 0.55) * zoomW * (highlight && lit ? 1.6 : 1);
      const pa = P([r.a.lon, r.a.lat]) || [0, 0], pb = P([r.b.lon, r.b.lat]) || [W, H];
      let stroke;
      if (r.up) stroke = "rgba(124,196,255,0.9)";
      else if (fresh) stroke = "rgba(246,198,103,0.95)";
      else { const g = ctx.createLinearGradient(pa[0], pa[1], pb[0], pb[1]); g.addColorStop(0, "rgba(255,138,91,0.95)"); g.addColorStop(1, "rgba(255,77,141,0.95)"); stroke = g; }
      ctx.globalAlpha = lit ? 1 : 0.07;
      ctx.setLineDash(r.up ? [4, 5] : []);
      ctx.beginPath(); path(r.geo);
      ctx.strokeStyle = stroke; ctx.lineWidth = w * 4.5; ctx.globalAlpha = (lit ? 0.07 : 0.01); ctx.stroke();
      ctx.lineWidth = w; ctx.globalAlpha = lit ? (r.up ? 0.9 : 0.78) : 0.07; ctx.stroke();
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;

    // planes gliding along routes
    if (!reduceMotion) {
      const movers = shown.filter(r => !r.up && (!highlight || r.ids.some(id => highlight.has(id)))).sort((a, b) => b.n - a.n).slice(0, 70);
      for (const r of movers) {
        const period = 2200 + r.km * 0.9, count = Math.min(3, Math.ceil(r.n / 8));
        for (let j = 0; j < count; j++) {
          const t = ((now / period) + r.seed + j / count) % 1;
          for (let s = 0; s < 6; s++) {
            const tt = t - s * 0.012; if (tt < 0) continue;
            const pt = r.interp(r.dir ? tt : 1 - tt);
            if (!visible(P, pt)) continue;
            const p = P(pt); if (!p) continue;
            ctx.globalAlpha = (1 - s / 6) * (s ? 0.45 : 1);
            ctx.fillStyle = s ? "#FF9A7A" : "#FFF1E0";
            ctx.beginPath(); ctx.arc(p[0], p[1], (s ? 1.3 : 1.9) * zoomW, 0, TAU); ctx.fill();
          }
        }
      }
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = "source-over";

    // airports
    const labelMin = airports.length > 24 ? (airports[Math.min(13, airports.length - 1)]?.n || 1) : 1;
    ctx.font = `700 ${10.5}px "B612 Mono", ui-monospace, monospace`; ctx.textBaseline = "middle";
    for (const d of airports) {
      const ll = [d.a.lon, d.a.lat];
      if (!visible(P, ll)) continue;
      const p = P(ll); if (!p) continue;
      const lit = !highlight || d.ids.some(id => highlight.has(id));
      const rr = (1.6 + Math.sqrt(d.n) * 0.55) * zoomW;
      ctx.globalAlpha = lit ? 1 : 0.25;
      if (d.a.code === home) {
        const pulse = reduceMotion ? 0.5 : (now % 2400) / 2400;
        ctx.strokeStyle = `rgba(246,198,103,${0.7 * (1 - pulse)})`; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p[0], p[1], rr + 3 + pulse * 14, 0, TAU); ctx.stroke();
        ctx.fillStyle = "#F6C667"; ctx.shadowColor = "#F6C667"; ctx.shadowBlur = 14;
      } else { ctx.fillStyle = hoverAp === d.a.code ? "#FFFFFF" : "#DCE6FA"; ctx.shadowBlur = 0; }
      ctx.beginPath(); ctx.arc(p[0], p[1], rr, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
      if (lit && (d.n >= labelMin || k >= 2.4 || hoverAp === d.a.code || (highlight && lit))) {
        ctx.lineWidth = 3; ctx.strokeStyle = "rgba(6,10,19,0.85)"; ctx.strokeText(d.a.code, p[0] + rr + 4, p[1]);
        ctx.fillStyle = d.a.code === home ? "#F6C667" : "rgba(238,242,248,0.9)"; ctx.fillText(d.a.code, p[0] + rr + 4, p[1]);
      }
    }
    ctx.globalAlpha = 1;
  }

  let raf = 0;
  const loop = now => { frame(now); raf = requestAnimationFrame(loop); };
  document.addEventListener("visibilitychange", () => { cancelAnimationFrame(raf); if (!document.hidden) raf = requestAnimationFrame(loop); });

  /* ---------- interaction ---------- */
  const pointers = new Map(); let drag = null, pinch = null, moved = 0;
  const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener("pointerdown", e => {
    canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, local(e)); lastInteract = performance.now(); anim = null; moved = 0;
    if (pointers.size === 1) drag = { p: local(e), rot: [...rot], tx, ty };
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), k }; drag = null; }
  });
  canvas.addEventListener("pointermove", e => {
    const p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch && pointers.size === 2) { const [a, b] = [...pointers.values()]; setK(pinch.k * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d); lastInteract = performance.now(); return; }
    if (drag) {
      const dx = p[0] - drag.p[0], dy = p[1] - drag.p[1]; moved = Math.max(moved, Math.hypot(dx, dy));
      if (mode === "globe") rot = [drag.rot[0] + dx * 0.28 / k, Math.max(-85, Math.min(85, drag.rot[1] - dy * 0.28 / k))];
      else { tx = drag.tx + dx; ty = drag.ty + dy; }
      lastInteract = performance.now(); onHover?.(null); return;
    }
    hover(p, e);
  });
  const end = e => {
    pointers.delete(e.pointerId);
    if (drag && moved < 5) click(local(e));
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) drag = null;
  };
  canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", () => { hoverAp = null; onHover?.(null); });
  canvas.addEventListener("wheel", e => { e.preventDefault(); setK(k * Math.exp(-e.deltaY * 0.0015)); lastInteract = performance.now(); }, { passive: false });
  const setK = v => { k = Math.max(mode === "globe" ? 0.7 : 1, Math.min(mode === "globe" ? 9 : 14, v)); };

  function hitAirport(p) {
    const P = proj(); let best = null, bd = 12;
    for (const d of airports) {
      const ll = [d.a.lon, d.a.lat]; if (!visible(P, ll)) continue;
      const q = P(ll); if (!q) continue;
      const dist = Math.hypot(q[0] - p[0], q[1] - p[1]); if (dist < bd) { bd = dist; best = d; }
    }
    return best;
  }
  function hitRoute(p) {
    const P = proj(), gp = d3.geoPath(P);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.lineWidth = 9;
    let hit = null;
    for (const r of [...routes].reverse()) {
      if (cutoff && r.first > cutoff) continue;
      const s = gp(r.geo); if (!s) continue;
      if (ctx.isPointInStroke(new Path2D(s), p[0], p[1])) { hit = r; break; }
    }
    ctx.restore(); return hit;
  }
  let hoverT = 0;
  function hover(p, e) {
    const now = performance.now(); if (now - hoverT < 40) return; hoverT = now;
    const a = hitAirport(p);
    hoverAp = a?.a.code || null;
    if (a) return onHover?.({ kind: "airport", data: a, x: p[0], y: p[1] });
    const r = hitRoute(p);
    onHover?.(r ? { kind: "route", data: r, x: p[0], y: p[1] } : null);
    canvas.style.cursor = r ? "pointer" : "";
  }
  function click(p) {
    const a = hitAirport(p); if (a) return onAirport?.(a.a.code);
    const r = hitRoute(p); if (r) onRoute?.(r);
  }

  /* ---------- public API ---------- */
  function setData(d) {
    routes = d.routes.map((r, i) => ({
      ...r, geo: { type: "LineString", coordinates: [[r.a.lon, r.a.lat], [r.b.lon, r.b.lat]] },
      interp: d3.geoInterpolate([r.a.lon, r.a.lat], [r.b.lon, r.b.lat]), seed: (i * 0.618) % 1, dir: i % 2 === 0,
    }));
    airports = [...d.airports].sort((a, b) => b.n - a.n);
    visited = d.visited; home = d.home; baseKey = "";
  }
  function focusPoints(points, dur = 1100) {
    if (!points.length) return;
    const mp = { type: "MultiPoint", coordinates: points };
    const [lon, lat] = d3.geoCentroid(mp);
    const spread = Math.max(0.05, ...points.map(p => d3.geoDistance(p, [lon, lat])));
    const r0 = [...rot], k0 = k, tx0 = tx, ty0 = ty;
    if (mode === "globe") {
      const k1 = points.length < 2 || spread < 0.06 ? 1.1 : Math.max(0.95, Math.min(3.6, 0.62 / Math.sin(Math.min(Math.PI / 2, spread + 0.12))));
      const r1 = [-lon, Math.max(-60, Math.min(60, -lat))];
      if (r1[0] - r0[0] > 180) r0[0] += 360; if (r0[0] - r1[0] > 180) r0[0] -= 360;
      anim = { t0: performance.now(), dur, rot: d3.interpolate(r0, r1), k: d3.interpolate(k0, k1) };
    } else {
      k = 1; tx = 0; ty = 0; const P = proj();
      const xy = points.map(p => P(p)).filter(Boolean);
      const [x0, x1] = d3.extent(xy, p => p[0]), [y0, y1] = d3.extent(xy, p => p[1]);
      const k1 = Math.max(1, Math.min(10, 0.8 / Math.max((x1 - x0 + 40) / W, (y1 - y0 + 40) / H)));
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      k = k0; tx = tx0; ty = ty0;
      anim = { t0: performance.now(), dur, rot: () => rot, k: d3.interpolate(k0, k1), tx: d3.interpolate(tx0, (W / 2 - cx) * k1), ty: d3.interpolate(ty0, (H / 2 - cy) * k1) };
    }
    lastInteract = performance.now();
  }
  function setMode(m) {
    mode = m; k = 1; tx = 0; ty = 0; baseKey = ""; resize();
    if (m === "flat" && home) { const h = airports.find(a => a.a.code === home); if (h) rot = [-h.a.lon + 10, rot[1]]; }
  }

  new ResizeObserver(() => resize()).observe(canvas);
  resize();
  raf = requestAnimationFrame(loop);
  return {
    setData, focusPoints, setMode,
    setHighlight(ids) { highlight = ids && ids.size ? ids : null; },
    setCutoff(date, fresh) { cutoff = date; freshFrom = fresh || null; },
    project: ll => proj()(ll),
  };
}
