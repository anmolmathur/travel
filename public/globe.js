/* global d3, topojson */
// Canvas globe / flat map with animated routes. Uses the d3 and topojson globals.

const TAU = Math.PI * 2;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Ground legs: a colour and dash per mode, so a train line reads differently from a road.
export const GROUND_STYLE = {
  train: { color: "#5FD6A8", rgb: "95,214,168", dash: [9, 3] },
  car: { color: "#B7A4FF", rgb: "183,164,255", dash: [3, 3] },
  bus: { color: "#F6C667", rgb: "246,198,103", dash: [3, 3] },
  ferry: { color: "#6FB8FF", rgb: "111,184,255", dash: [1, 4] },
};

// Little top-down figures that travel along the routes, drawn pointing along +x in a ~16-unit box.
const PLANE = new Path2D("M8 0C8-.9 7-1.3 5.5-1.3H1.6L-2.4-7.4H-4.2L-2.2-1.3H-5.6L-7-3.4H-8.2L-7.4 0-8.2 3.4H-7L-5.6 1.3H-2.2L-4.2 7.4H-2.4L1.6 1.3H5.5C7 1.3 8 .9 8 0Z");
const FERRY = new Path2D("M7 0 3.5-3H-6.5V3H3.5Z");
function carShape(c, len, wid, color, windows) {
  c.fillStyle = color; c.beginPath(); if (c.roundRect) c.roundRect(-len / 2, -wid / 2, len, wid, wid * 0.42); else c.rect(-len / 2, -wid / 2, len, wid); c.fill();
  c.fillStyle = "rgba(8,14,28,0.72)";
  if (windows === "car") { c.fillRect(len * 0.1, -wid * 0.36, len * 0.16, wid * 0.72); c.fillRect(-len * 0.34, -wid * 0.34, len * 0.12, wid * 0.68); }
  else if (windows === "bus") { c.fillRect(len * 0.36, -wid * 0.36, len * 0.08, wid * 0.72); for (let x = -len * 0.4; x < len * 0.3; x += len * 0.14) { c.fillRect(x, -wid * 0.5, len * 0.09, wid * 0.16); c.fillRect(x, wid * 0.34, len * 0.09, wid * 0.16); } }
  else if (windows === "loco") { c.fillRect(len * 0.28, -wid * 0.34, len * 0.12, wid * 0.68); }
  else if (windows === "coach") { for (let x = -len * 0.36; x < len * 0.36; x += len * 0.24) c.fillRect(x, -wid * 0.26, len * 0.14, wid * 0.52); }
}

export function createGlobe(canvas, { world110, world50, onAirport, onRoute, onHover, onWheelHint, isFree = () => false }) {
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

  // Wide screens: push the globe right, clear of the stats panel. Narrow screens: push it down.
  const offset = () => (W >= 900 ? [W * 0.13, 0] : [0, H * 0.06]);
  const proj = () => {
    if (mode === "globe") {
      const [ox, oy] = offset();
      const r = Math.min(W - 2 * ox, H - 2 * oy - (W >= 900 ? 110 : 150)) / 2 * 0.94;
      return d3.geoOrthographic().clipAngle(90).precision(0.4).rotate(rot).scale(Math.max(60, r) * k).translate([W / 2 + ox, H / 2 + oy - (W >= 900 ? 30 : 10)]);
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
      const gs = GROUND_STYLE[r.mode];
      const w = (0.7 + Math.sqrt(r.n) * 0.55) * zoomW * (highlight && lit ? 1.6 : 1) * (gs ? 0.9 : 1);
      const pa = P([r.a.lon, r.a.lat]) || [0, 0], pb = P([r.b.lon, r.b.lat]) || [W, H];
      let stroke;
      if (gs) stroke = `rgba(${gs.rgb},${r.up ? 0.7 : 0.95})`;
      else if (r.up) stroke = "rgba(124,196,255,0.9)";
      else if (fresh) stroke = "rgba(246,198,103,0.95)";
      else { const g = ctx.createLinearGradient(pa[0], pa[1], pb[0], pb[1]); g.addColorStop(0, "rgba(255,138,91,0.95)"); g.addColorStop(1, "rgba(255,77,141,0.95)"); stroke = g; }
      ctx.globalAlpha = lit ? 1 : 0.07;
      ctx.setLineDash(gs ? gs.dash.map(x => x * zoomW) : r.up ? [4, 5] : []);
      ctx.beginPath(); path(r.geo);
      ctx.strokeStyle = stroke; ctx.lineWidth = w * 4.5; ctx.globalAlpha = (lit ? 0.07 : 0.01); ctx.stroke();
      ctx.lineWidth = w; ctx.globalAlpha = lit ? (r.up ? 0.9 : 0.78) : 0.07; ctx.stroke();
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;

    ctx.globalCompositeOperation = "source-over";

    // planes, trains, cars, buses and ferries travelling along their routes (parked mid-route with reduced motion)
    {
      const lit = r => !highlight || r.ids.some(id => highlight.has(id));
      const live = shown.filter(r => !r.up && lit(r));
      const movers = [...live.filter(r => r.mode === "air").sort((a, b) => b.n - a.n).slice(0, 60), ...live.filter(r => r.mode !== "air").slice(0, 40)];
      const at = (r, t) => { const pt = r.interp(r.dir ? t : 1 - t); return visible(P, pt) ? P(pt) : null; };
      const size = Math.min(1.5, 0.62 * zoomW + 0.18), gsize = Math.min(2, size * 1.35); // ground figures are smaller shapes: draw them larger
      for (const r of movers) {
        const pa = P([r.a.lon, r.a.lat]), pb = P([r.b.lon, r.b.lat]);
        const span = pa && pb ? Math.max(20, Math.hypot(pb[0] - pa[0], pb[1] - pa[1])) : 200;
        // Ground legs move at a steadier, slower pace than flights; long flights take longer to cross.
        const period = r.mode === "air" ? 2600 + r.km * 0.9 : 5200 + span * 18;
        const count = reduceMotion ? (r.mode === "air" ? 0 : 1) : r.mode === "air" ? Math.min(3, Math.ceil(r.n / 8)) : 1;
        for (let j = 0; j < count; j++) {
          const t = reduceMotion ? 0.5 : ((now / period) + r.seed + j / count) % 1;
          const edge = Math.min(1, t / 0.06, (1 - t) / 0.06);
          const p = at(r, t), q = at(r, Math.min(1, t + 0.01)), q0 = at(r, Math.max(0, t - 0.01));
          if (!p) continue;
          const ang = q && q0 ? Math.atan2(q[1] - q0[1], q[0] - q0[0]) : 0;
          ctx.save(); ctx.globalAlpha = edge;
          if (r.mode === "air") {
            // a soft vapour trail, then the plane
            for (let s = 1; s < 7; s++) {
              const tp = at(r, Math.max(0, t - s * 0.012)); if (!tp) continue;
              ctx.globalAlpha = edge * (1 - s / 7) * 0.4; ctx.fillStyle = "#FF9A7A";
              ctx.beginPath(); ctx.arc(tp[0], tp[1], 1.2 * zoomW, 0, TAU); ctx.fill();
            }
            ctx.globalAlpha = edge; ctx.translate(p[0], p[1]); ctx.rotate(ang); ctx.scale(size, size);
            ctx.shadowColor = "rgba(255,210,170,0.9)"; ctx.shadowBlur = 8; ctx.fillStyle = "#FFF4E6"; ctx.fill(PLANE);
          } else if (r.mode === "train") {
            // a locomotive and two coaches, each following the curve of the line
            const gap = 8.5 * gsize / span;
            for (let c = 2; c >= 0; c--) {
              const tc = t - c * gap; if (tc < 0) continue;
              const pc = at(r, tc), qc = at(r, Math.min(1, tc + 0.01)), qc0 = at(r, Math.max(0, tc - 0.01)); if (!pc) continue;
              ctx.save(); ctx.translate(pc[0], pc[1]); ctx.rotate(qc && qc0 ? Math.atan2(qc[1] - qc0[1], qc[0] - qc0[0]) : ang); ctx.scale(gsize, gsize);
              ctx.shadowColor = "rgba(95,214,168,0.8)"; ctx.shadowBlur = c ? 0 : 8;
              carShape(ctx, 7.6, 3.6, c ? "#BDF5DD" : "#E9FFF4", c ? "coach" : "loco");
              ctx.restore();
            }
          } else {
            ctx.translate(p[0], p[1]); ctx.rotate(ang); ctx.scale(gsize, gsize);
            const gs = GROUND_STYLE[r.mode]; ctx.shadowColor = gs.color; ctx.shadowBlur = 8;
            if (r.mode === "ferry") { ctx.fillStyle = "#E6F3FF"; ctx.fill(FERRY); ctx.shadowBlur = 0; ctx.fillStyle = "rgba(8,14,28,0.6)"; ctx.fillRect(-4.5, -1.4, 5, 2.8); }
            else if (r.mode === "bus") carShape(ctx, 11, 4, "#FFF0C9", "bus");
            else carShape(ctx, 8, 4, "#EEE8FF", "car");
          }
          ctx.restore();
        }
      }
      ctx.globalAlpha = 1;
    }

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
  // Plain scrolling scrolls the page; Ctrl/⌘ + scroll (and trackpad pinch, which sets ctrlKey) zooms.
  canvas.addEventListener("wheel", e => {
    if (!(e.ctrlKey || e.metaKey || isFree())) { onWheelHint?.(); return; }
    e.preventDefault(); setK(k * Math.exp(-e.deltaY * 0.0015)); lastInteract = performance.now();
  }, { passive: false });
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
      mode: "air", ...r, geo: { type: "LineString", coordinates: [[r.a.lon, r.a.lat], [r.b.lon, r.b.lat]] },
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
      // Fit into the part of the screen the overlays leave free (right of the stats panel, above the year strip).
      const left = W >= 900 ? Math.min(500, W * 0.36) : 0, top = W >= 900 ? 0 : 150, bottom = W >= 900 ? 130 : 170;
      const aw = W - left - 30, ah = H - top - bottom;
      const k1 = Math.max(1, Math.min(10, 0.85 / Math.max((x1 - x0 + 40) / aw, (y1 - y0 + 40) / ah)));
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, P0 = proj(), [t0x, t0y] = P0.translate();
      k = k0; tx = tx0; ty = ty0;
      const gx = left + aw / 2, gy = top + ah / 2;
      anim = { t0: performance.now(), dur, rot: () => rot, k: d3.interpolate(k0, k1), tx: d3.interpolate(tx0, gx - t0x - (cx - t0x) * k1), ty: d3.interpolate(ty0, gy - t0y - (cy - t0y) * k1) };
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
    zoomBy(f) { anim = null; setK(k * f); lastInteract = performance.now(); },
    setHighlight(ids) { highlight = ids && ids.size ? ids : null; },
    setCutoff(date, fresh) { cutoff = date; freshFrom = fresh || null; },
    project: ll => proj()(ll),
  };
}
