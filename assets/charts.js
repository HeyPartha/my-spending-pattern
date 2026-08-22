/*
 * Charts, hand-drawn as SVG.
 *
 * A charting library would be 200-400 KB for four chart types, on a page whose
 * whole promise is that it loads fast and works offline. These are a few
 * hundred lines and cost nothing.
 *
 * The rules being followed here, briefly, because they are easy to undo by
 * accident later:
 *
 *   - Categorical hues are assigned in a fixed order and never cycled. A ninth
 *     series does not get a new colour; it folds into "Other".
 *   - Bars are capped at 24px, rounded at the data end and square at the
 *     baseline. Lines are 2px, markers at least 8px across with a 2px ring in
 *     the surface colour so they stay readable where they cross.
 *   - Marks touching other marks are separated by a 2px gap of surface colour,
 *     never by a stroke.
 *   - One y-axis. Two measures at different scales get two charts.
 *   - Text never wears the series colour; a coloured mark sits beside it.
 *   - Labels are selective. A number on every point is noise.
 */
/*
 * Loaded as a plain script, not an ES module, and that is deliberate.
 *
 * Browsers refuse to load ES modules over file:// -- so an index.html opened
 * by double-clicking it would silently do nothing at all, every button dead,
 * with only a CORS error in a console the visitor never opens. Since this app
 * has no build step and no server, being able to just open the file is worth
 * more than the syntax. Each file therefore attaches its exports to one global
 * `MSP` object and reads its dependencies from the same place.
 */
(function (MSP) {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs))
      if (v != null) n.setAttribute(k, v);
    return n;
  };
  const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

  /* Shared tooltip. One node, moved around, rather than one per chart. */
  let tipEl;
  function tip() {
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.className = "tip";
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  function showTip(html, x, y) {
    const t = tip();
    t.innerHTML = html;
    t.style.opacity = "1";
    const w = t.offsetWidth, h = t.offsetHeight;
    t.style.left = Math.min(Math.max(8, x - w / 2), innerWidth - w - 8) + "px";
    t.style.top  = Math.max(8, y - h - 14) + "px";
  }
  const hideTip = () => { if (tipEl) tipEl.style.opacity = "0"; };

  /* ------------------------------------------------------------------ *
   * Horizontal bars -- one series, magnitude by category.
   * A single series needs no legend: the card title already names it.
   * ------------------------------------------------------------------ */
  function barChart(host, rows, { fmt, onClick, selected } = {}) {
    host.innerHTML = "";
    if (!rows.length) { host.innerHTML = '<p class="muted">Nothing to show.</p>'; return; }
    const max = Math.max(...rows.map(r => r.value)) || 1;

    for (const r of rows) {
      const row = document.createElement("button");
      row.className = "barrow" + (selected === r.label ? " sel" : "");
      row.type = "button";
      row.innerHTML =
        `<span class="barlabel">${esc(r.label)}</span>
         <span class="bartrack"><span class="barfill" style="width:${
           Math.max(1.5, r.value / max * 100)}%"></span></span>
         <span class="barval">${fmt ? fmt(r.value) : r.value}${
           r.arrow ? ` <span class="arrow ${r.arrow}">${
             r.arrow === "up" ? "▲" : r.arrow === "down" ? "▼" : "—"}</span>` : ""}</span>`;
      // Hide the tooltip before handing over. Clicking a bar re-renders the
      // chart underneath it, so the row that owned the tooltip is gone before
      // its mouseleave ever fires and the tip is left floating over the page.
      if (onClick) row.onclick = () => { hideTip(); onClick(r); };
      row.onmouseenter = e => r.hint && showTip(r.hint, e.clientX,
                                                row.getBoundingClientRect().top);
      row.onmouseleave = hideTip;
      host.appendChild(row);
    }
  }

  /* ------------------------------------------------------------------ *
   * Line chart over months, up to three series, with a crosshair.
   * ------------------------------------------------------------------ */
  function lineChart(host, data, series, { fmt } = {}) {
    host.innerHTML = "";
    if (data.length < 2) {
      host.innerHTML = '<p class="muted">At least two months are needed for a trend.</p>';
      return;
    }
    const W = host.clientWidth || 640, H = 240;
    const P = { t: 16, r: 54, b: 26, l: 8 };
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H,
                            role: "img", "aria-label": "Trend over time" });

    const vals = data.flatMap(d => series.map(s => +d[s.key] || 0));
    const max = Math.max(...vals, 1);
    const step = Math.pow(10, Math.floor(Math.log10(max)));
    const top = Math.ceil(max / step) * step;
    const x = i => P.l + (data.length === 1 ? iw / 2 : i / (data.length - 1) * iw);
    const y = v => P.t + ih - (v / top) * ih;

    for (let g = 0; g <= 4; g++) {                      // hairline, solid, recessive
      const gy = P.t + ih - (g / 4) * ih;
      svg.appendChild(el("line", { x1: P.l, x2: P.l + iw, y1: gy, y2: gy,
                                   class: "gridline" }));
      const t = el("text", { x: P.l + iw + 8, y: gy + 4, class: "tick" });
      t.textContent = shortNum(top * g / 4);
      svg.appendChild(t);
    }
    data.forEach((d, i) => {
      if (data.length > 8 && i % Math.ceil(data.length / 6)) return;
      const t = el("text", { x: x(i), y: H - 6, class: "tick",
                             "text-anchor": "middle" });
      t.textContent = (d.label || "").slice(0, 3);
      svg.appendChild(t);
    });

    series.forEach((s, si) => {
      const col = SERIES[si % SERIES.length];
      const pts = data.map((d, i) => [x(i), y(+d[s.key] || 0)]);
      svg.appendChild(el("path", {
        d: pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" "),
        fill: "none", stroke: col, "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round" }));
      const [ex, ey] = pts[pts.length - 1];
      svg.appendChild(el("circle", { cx: ex, cy: ey, r: 4.5, fill: col,
                                     stroke: "var(--surface-1)", "stroke-width": 2 }));
    });

    const cross = el("line", { y1: P.t, y2: P.t + ih, class: "crosshair" });
    svg.appendChild(cross);
    svg.addEventListener("pointermove", ev => {
      const box = svg.getBoundingClientRect();
      const px = (ev.clientX - box.left) / box.width * W;
      const i = Math.max(0, Math.min(data.length - 1,
        Math.round((px - P.l) / (iw || 1) * (data.length - 1))));
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
      cross.style.opacity = "1";
      showTip(`<b>${esc(data[i].label)}</b>` + series.map((s, si) =>
        `<div><i style="background:${SERIES[si % SERIES.length]}"></i>${
          esc(s.label)} <b>${fmt ? fmt(+data[i][s.key] || 0) : data[i][s.key]}</b></div>`
        ).join(""), ev.clientX, box.top + 10);
    });
    svg.addEventListener("pointerleave", () => {
      cross.style.opacity = "0"; hideTip();
    });

    host.appendChild(svg);
    if (series.length >= 2) host.appendChild(legend(series));
  }

  function legend(series) {
    const d = document.createElement("div");
    d.className = "legend";
    d.innerHTML = series.map((s, i) =>
      `<span><i style="background:${SERIES[i % SERIES.length]}"></i>${esc(s.label)}</span>`
    ).join("");
    return d;
  }

  /* ------------------------------------------------------------------ *
   * Donut -- a part-to-whole split of three or four slices, no more.
   * Every slice is direct-labelled, which is also what discharges the
   * light-mode contrast warning on the aqua slot.
   * ------------------------------------------------------------------ */
  function donut(host, parts, { fmt } = {}) {
    host.innerHTML = "";
    const total = parts.reduce((s, p) => s + p.value, 0);
    if (!total) { host.innerHTML = '<p class="muted">Nothing to show.</p>'; return; }

    const S = 190, R = 78, r0 = 50, C = S / 2;
    const svg = el("svg", { viewBox: `0 0 ${S} ${S}`, height: S, class: "donut",
                            role: "img", "aria-label": "Share of spending" });
    let a0 = -Math.PI / 2;
    const GAP = 2 / R;                       // 2px of surface between slices

    parts.forEach((p, i) => {
      const sweep = (p.value / total) * Math.PI * 2;
      const a1 = a0 + sweep;
      const s = a0 + (parts.length > 1 ? GAP / 2 : 0);
      const e = a1 - (parts.length > 1 ? GAP / 2 : 0);
      if (e > s) {
        const pt = (ang, rad) => [C + Math.cos(ang) * rad, C + Math.sin(ang) * rad];
        const big = e - s > Math.PI ? 1 : 0;
        const [x1, y1] = pt(s, R),  [x2, y2] = pt(e, R);
        const [x3, y3] = pt(e, r0), [x4, y4] = pt(s, r0);
        const path = el("path", {
          d: `M${x1},${y1} A${R},${R} 0 ${big} 1 ${x2},${y2} `
           + `L${x3},${y3} A${r0},${r0} 0 ${big} 0 ${x4},${y4} Z`,
          fill: SERIES[i % SERIES.length] });
        path.addEventListener("pointerenter", ev => showTip(
          `<b>${esc(p.label)}</b>${fmt ? fmt(p.value) : p.value} · ${
            Math.round(p.value / total * 100)}%`, ev.clientX, ev.clientY));
        path.addEventListener("pointerleave", hideTip);
        svg.appendChild(path);
      }
      a0 = a1;
    });
    host.appendChild(svg);

    const key = document.createElement("div");
    key.className = "donutkey";
    key.innerHTML = parts.map((p, i) =>
      `<div><span class="sw" style="background:${SERIES[i % SERIES.length]}"></span>
       <span class="k">${esc(p.label)}</span>
       <span class="v">${fmt ? fmt(p.value) : p.value}
         <em>${Math.round(p.value / total * 100)}%</em></span></div>`).join("");
    host.appendChild(key);
  }

  /* ------------------------------------------------------------------ *
   * Columns for one month's daily spend -- shows the rhythm of a month.
   * ------------------------------------------------------------------ */
  function columns(host, data, { fmt } = {}) {
    host.innerHTML = "";
    if (!data.length) return;
    const W = host.clientWidth || 640, H = 130, P = { t: 10, b: 18 };
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H,
                            role: "img", "aria-label": "Spending by day" });
    const max = Math.max(...data.map(d => d.value), 1);
    const band = W / data.length;
    const bw = Math.min(24, Math.max(2, band - 2));      // 2px surface gap

    data.forEach((d, i) => {
      const h = (d.value / max) * (H - P.t - P.b);
      const x = i * band + (band - bw) / 2, y = H - P.b - h;
      const rect = el("rect", { x, y, width: bw, height: Math.max(h, d.value ? 1.5 : 0),
        rx: Math.min(4, bw / 2), fill: "var(--series-1)" });
      rect.addEventListener("pointerenter", ev => showTip(
        `<b>${esc(d.label)}</b>${fmt ? fmt(d.value) : d.value}`, ev.clientX, ev.clientY));
      rect.addEventListener("pointerleave", hideTip);
      svg.appendChild(rect);
    });
    svg.appendChild(el("line", { x1: 0, x2: W, y1: H - P.b, y2: H - P.b,
                                 class: "axisline" }));
    host.appendChild(svg);
  }

  const shortNum = v => v >= 1e7 ? (v / 1e7).toFixed(1) + "Cr"
                      : v >= 1e5 ? (v / 1e5).toFixed(1) + "L"
                      : v >= 1000 ? Math.round(v / 1000) + "k" : Math.round(v);
  const esc = s => String(s ?? "").replace(/[&<>"]/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  MSP.charts = { barChart, columns, donut, esc, lineChart };
})(window.MSP = window.MSP || {});
