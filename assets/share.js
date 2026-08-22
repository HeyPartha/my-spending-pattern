/*
 * Shareable cards, drawn on a canvas.
 *
 * The screen layout is the wrong shape for a phone story and far too dense to
 * read at thumbnail size, so these are not screenshots -- each card is drawn
 * from scratch at the target aspect ratio with one idea on it and type large
 * enough to read while scrolling past.
 *
 * Everything happens in the browser. `canvas.toBlob` produces the PNG, the
 * Web Share API hands it to WhatsApp or Instagram directly on a phone, and on
 * a desktop it falls back to a download. No image is ever uploaded.
 *
 * One deliberate feature: **amounts can be turned off.** Sharing a picture of
 * your finances to a public story is a different act from looking at it
 * yourself, and most people want the shape of their spending to be visible
 * without the size of their salary. With amounts off the cards show
 * percentages and rankings only, and no rupee figure is drawn anywhere.
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

  const { inr } = MSP.analyse;

  /* ------------------------------------------------------------------ *
   * THE MARK ON EVERY IMAGE — edit these two lines to change every card.
   *
   * Two lines and no more. An earlier version stacked a credit, a domain and a
   * strapline, which at thumbnail size read as a block of grey noise and buried
   * the one line that matters. "DSandAI.com" is spelled out rather than using
   * "&" so it survives being retyped or read aloud from a screenshot.
   * ------------------------------------------------------------------ */
  const WATERMARK = "Generated at dsandai.com/spending";
  const TAGLINE   = "Visit the page to generate yours.";

  /* Story is 9:16; post is 4:5, which is the tallest Instagram allows in the
   * feed and so the most legible. Both are 1080 wide, which is what Instagram
   * and WhatsApp compress to anyway. */
  const SIZES = {
    story: { w: 1080, h: 1920, label: "Story · 9:16" },
    post:  { w: 1080, h: 1350, label: "Post · 4:5" },
  };

  const THEMES = {
    dark:  { bg: "#0d0d0d", card: "#1a1a19", edge: null, ink: "#ffffff",
             ink2: "#c3c2b7", mute: "#898781", grid: "#2c2c2a",
             s1: "#3987e5", s2: "#d95926", s3: "#199e70" },
    // White on off-white is almost invisible once Instagram has compressed it,
    // so the light theme gives its cards a hairline edge.
    light: { bg: "#f9f9f7", card: "#ffffff", edge: "#e1e0d9", ink: "#0b0b0b",
             ink2: "#52514e", mute: "#898781", grid: "#e1e0d9",
             s1: "#2a78d6", s2: "#eb6834", s3: "#1baf7a" },
  };

  const F = (size, weight = 400) =>
    `${weight} ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

  /* ------------------------------------------------------------------ *
   * small drawing helpers
   * ------------------------------------------------------------------ */
  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function fitText(c, text, max) {
    let t = String(text);
    if (c.measureText(t).width <= max) return t;
    while (t.length > 1 && c.measureText(t + "…").width > max) t = t.slice(0, -1);
    return t + "…";
  }

  /** Header and footer are identical on every card, so they live in one place. */
  function chrome(c, S, T, { title, subtitle }) {
    c.fillStyle = T.bg;
    c.fillRect(0, 0, S.w, S.h);

    const M = 72;
    // brand mark
    const g = c.createLinearGradient(M, 84, M + 56, 140);
    g.addColorStop(0, T.s1); g.addColorStop(1, T.s3);
    c.fillStyle = g; roundRect(c, M, 84, 56, 56, 18); c.fill();

    c.fillStyle = T.ink; c.font = F(32, 700);
    c.fillText("My Spending Pattern", M + 76, 124);

    c.fillStyle = T.ink; c.font = F(64, 700);
    c.fillText(fitText(c, title, S.w - M * 2), M, 244);
    if (subtitle) {
      c.fillStyle = T.mute; c.font = F(30, 400);
      c.fillText(fitText(c, subtitle, S.w - M * 2), M, 292);
    }

    // The mark. Always drawn, always last, never optional.
    c.fillStyle = T.ink2; c.font = F(29, 600);
    c.fillText(WATERMARK, M, S.h - 84);
    c.fillStyle = T.mute; c.font = F(25, 400);
    c.fillText(TAGLINE, M, S.h - 46);
    return { M, top: 360, bottom: S.h - 140 };
  }

  /* A story is 9:16 and most cards have less content than that. Rather than
   * leaving a third of the image empty at the bottom, each card measures its own
   * block and centres it in the space between the header and the watermark. */
  const centre = (top, bottom, height) =>
    Math.max(top, top + (bottom - top - height) / 2);

  /* ------------------------------------------------------------------ *
   * the cards
   * ------------------------------------------------------------------ */

  /** Headline numbers. The one people actually post. */
  function cardSummary(c, S, T, d, opts) {
    const { M, top, bottom } = chrome(c, S, T,
      { title: "Where my money went", subtitle: d.periodLabel });
    const showAmt = opts.amounts;

    // With amounts hidden every figure is shown against income, which makes a
    // "Money in: 100%" row meaningless -- so it is dropped in that mode.
    const rows = [
      ["Spent",    d.spent,    T.s1],
      ["Money in", d.income,   T.s3],
      ["Kept",     d.kept,     T.s3],
      ["Invested", d.invested, T.s2],
    ].filter(r => r[1] && (showAmt || r[0] !== "Money in"));

    const h = Math.min(230, (bottom - top - 170) / rows.length);
    const blockH = h * rows.length + (d.savingRate != null ? 154 : 0);
    let y = centre(top, bottom, blockH);
    for (const [label, value, col] of rows) {
      c.fillStyle = T.card; roundRect(c, M, y, S.w - M * 2, h - 18, 26); c.fill();
      if (T.edge) { c.strokeStyle = T.edge; c.lineWidth = 2; c.stroke(); }
      c.fillStyle = T.mute; c.font = F(28, 500);
      c.fillText(label, M + 40, y + 56);
      c.fillStyle = T.ink; c.font = F(showAmt ? 66 : 54, 700);
      const txt = showAmt ? inr(value)
        : d.income ? `${Math.round(value / d.income * 100)}% of what came in`
                   : "—";
      c.fillText(txt, M + 40, y + 128);
      // a colour key on the right so the card is not all one grey
      c.fillStyle = col;
      roundRect(c, S.w - M - 56, y + 40, 16, h - 98, 8); c.fill();
      y += h;
    }

    if (d.savingRate != null) {
      c.fillStyle = T.card; roundRect(c, M, y + 6, S.w - M * 2, 148, 26); c.fill();
      if (T.edge) { c.strokeStyle = T.edge; c.lineWidth = 2; c.stroke(); }
      c.fillStyle = T.mute; c.font = F(28, 500);
      c.fillText("Saving rate", M + 40, y + 62);
      c.fillStyle = d.savingRate >= 0.2 ? T.s3 : d.savingRate > 0 ? T.ink : T.s2;
      c.font = F(72, 700);
      c.fillText(`${Math.round(d.savingRate * 100)}%`, M + 40, y + 132);
    }
  }

  /** Top categories as bars. Percentages always; rupees only if allowed. */
  function cardCategories(c, S, T, d, opts) {
    const { M, top, bottom } = chrome(c, S, T,
      { title: "My top spends", subtitle: d.periodLabel });
    const items = d.categories.slice(0, S.h > 1500 ? 8 : 6);
    if (!items.length) return;
    const max = items[0].amount || 1;
    const step = Math.min(150, (bottom - top - 20) / items.length);
    let y = centre(top, bottom, step * items.length);

    items.forEach((it, i) => {
      const col = [T.s1, T.s2, T.s3][i % 3];
      c.fillStyle = T.ink; c.font = F(34, 600);
      c.fillText(fitText(c, it.category, S.w - M * 2 - 300), M, y + 34);

      c.textAlign = "right";
      c.fillStyle = T.ink2; c.font = F(32, 600);
      c.fillText(opts.amounts ? inr(it.amount) : `${Math.round(it.share * 100)}%`,
                 S.w - M, y + 34);
      c.textAlign = "left";

      const bw = S.w - M * 2, bh = 26;
      c.fillStyle = T.grid; roundRect(c, M, y + 56, bw, bh, 13); c.fill();
      const w = Math.max(bh, (it.amount / max) * bw);
      c.fillStyle = col; roundRect(c, M, y + 56, w, bh, 13); c.fill();
      y += step;
    });
  }

  /** Needs vs wants, as a donut. The most-shared shape in personal finance. */
  function cardSplit(c, S, T, d, opts) {
    const { M, top, bottom } = chrome(c, S, T,
      { title: "Needs vs wants", subtitle: d.periodLabel });
    const parts = d.split;
    const total = parts.reduce((s, p) => s + p.amount, 0) || 1;

    const cx = S.w / 2, r = Math.min(300, (bottom - top) / 2 - 140);
    const blockH = r * 2 + 90 + parts.length * 62;
    const cy = centre(top, bottom, blockH) + r;
    const r0 = r * 0.62;
    let a0 = -Math.PI / 2;
    const GAP = 3 / r;

    parts.forEach((p, i) => {
      const a1 = a0 + (p.amount / total) * Math.PI * 2;
      const s = a0 + GAP / 2, e = a1 - GAP / 2;
      if (e > s) {
        c.beginPath();
        c.arc(cx, cy, r, s, e);
        c.arc(cx, cy, r0, e, s, true);
        c.closePath();
        c.fillStyle = [T.s1, T.s2, T.s3][i % 3];
        c.fill();
      }
      a0 = a1;
    });

    // the biggest share, in the hole
    const big = parts[0];
    if (big) {
      c.textAlign = "center";
      c.fillStyle = T.ink; c.font = F(76, 700);
      c.fillText(`${Math.round(big.amount / total * 100)}%`, cx, cy + 10);
      c.fillStyle = T.mute; c.font = F(30, 500);
      c.fillText(big.group, cx, cy + 54);
      c.textAlign = "left";
    }

    let y = cy + r + 90;
    for (const [i, p] of parts.entries()) {
      c.fillStyle = [T.s1, T.s2, T.s3][i % 3];
      roundRect(c, M, y - 24, 26, 26, 8); c.fill();
      c.fillStyle = T.ink; c.font = F(34, 600);
      c.fillText(p.group, M + 46, y);
      c.textAlign = "right";
      c.fillStyle = T.ink2; c.font = F(32, 500);
      c.fillText(opts.amounts
        ? `${inr(p.amount)}  ·  ${Math.round(p.amount / total * 100)}%`
        : `${Math.round(p.amount / total * 100)}%`, S.w - M, y);
      c.textAlign = "left";
      y += 62;
    }
  }

  /** The trend. Shape reads fine with the axis numbers removed. */
  function cardTrend(c, S, T, d, opts) {
    const { M, top, bottom } = chrome(c, S, T,
      // The same period label as every other card. "12 months" told you how
      // many bars there were, which you can see, and not when they were.
      { title: "Month by month", subtitle: d.periodLabel });
    const data = d.months;
    if (data.length < 2) return;

    const x0 = M, x1 = S.w - M;
    const plotH = 620, blockH = plotH + 260;
    const y0 = centre(top, bottom, blockH) + 40;
    const y1 = Math.min(bottom - 200, y0 + plotH);
    const max = Math.max(...data.flatMap(m => [m.spent, m.income])) || 1;
    const X = i => x0 + (i / (data.length - 1)) * (x1 - x0);
    const Y = v => y1 - (v / max) * (y1 - y0);

    for (let g = 0; g <= 3; g++) {
      const gy = y1 - (g / 3) * (y1 - y0);
      c.strokeStyle = T.grid; c.lineWidth = 2;
      c.beginPath(); c.moveTo(x0, gy); c.lineTo(x1, gy); c.stroke();
    }

    for (const [key, col] of [["income", T.s3], ["spent", T.s1]]) {
      c.strokeStyle = col; c.lineWidth = 6;
      c.lineJoin = "round"; c.lineCap = "round";
      c.beginPath();
      data.forEach((m, i) => i ? c.lineTo(X(i), Y(m[key])) : c.moveTo(X(i), Y(m[key])));
      c.stroke();
      const last = data[data.length - 1];
      c.fillStyle = col;
      c.beginPath(); c.arc(X(data.length - 1), Y(last[key]), 13, 0, 7); c.fill();
      c.strokeStyle = T.bg; c.lineWidth = 5;
      c.beginPath(); c.arc(X(data.length - 1), Y(last[key]), 13, 0, 7); c.stroke();
    }

    c.fillStyle = T.mute; c.font = F(26, 500);
    c.fillText(data[0].label, x0, y1 + 46);
    c.textAlign = "right";
    c.fillText(data[data.length - 1].label, x1, y1 + 46);
    c.textAlign = "left";

    let ly = y1 + 130;
    for (const [label, col] of [["Money in", T.s3], ["Spent", T.s1]]) {
      c.fillStyle = col; roundRect(c, M, ly - 22, 26, 26, 8); c.fill();
      c.fillStyle = T.ink; c.font = F(32, 600);
      c.fillText(label, M + 46, ly);
      ly += 56;
    }

    if (opts.amounts && d.spent) {
      c.fillStyle = T.mute; c.font = F(28, 400);
      c.fillText(`${inr(d.spent)} spent in total`, M, ly + 16);
    }
  }

  /** Subscriptions. The most quietly shocking number on the whole page. */
  function cardRecurring(c, S, T, d, opts) {
    const { M, top, bottom } = chrome(c, S, T,
      { title: "Charges I forgot about", subtitle: "The same payee, every month" });
    const all = d.recurring.filter(r => r.discretionary);
    const items = all.slice(0, S.h > 1500 ? 7 : 5);
    if (!items.length) return;
    const monthly = all.reduce((s, r) => s + r.amount, 0);

    const step0 = Math.min(96, (bottom - top - 250) / Math.max(items.length, 1));
    const startY = centre(top, bottom, 250 + step0 * items.length);
    c.fillStyle = T.card; roundRect(c, M, startY, S.w - M * 2, 190, 26); c.fill();
    if (T.edge) { c.strokeStyle = T.edge; c.lineWidth = 2; c.stroke(); }
    c.fillStyle = T.mute; c.font = F(28, 500);
    c.fillText(`${all.length} repeating charges cost me`, M + 40, startY + 62);
    c.fillStyle = T.s2; c.font = F(72, 700);
    c.fillText(opts.amounts ? `${inr(monthly * 12)} a year` : "every single month",
               M + 40, startY + 144);

    let y = startY + 250;
    const step = step0;
    for (const it of items) {
      c.fillStyle = T.ink; c.font = F(32, 500);
      c.fillText(fitText(c, it.payee, S.w - M * 2 - 260), M, y);
      c.textAlign = "right";
      c.fillStyle = T.ink2; c.font = F(30, 600);
      c.fillText(opts.amounts ? `${inr(it.amount)}/mo` : `${it.months} months`,
                 S.w - M, y);
      c.textAlign = "left";
      c.strokeStyle = T.grid; c.lineWidth = 2;
      c.beginPath(); c.moveTo(M, y + 22); c.lineTo(S.w - M, y + 22); c.stroke();
      y += step;
    }
  }

  /* `need` is asked before the data exists (the panel renders first), so each
   * test tolerates an empty object rather than assuming its own field is there. */
  const CARDS = [
    { id: "summary",    name: "The headline",      draw: cardSummary,
      need: d => (d?.spent || 0) > 0 },
    { id: "categories", name: "Top spends",        draw: cardCategories,
      need: d => (d?.categories?.length || 0) > 1 },
    { id: "split",      name: "Needs vs wants",    draw: cardSplit,
      need: d => (d?.split?.length || 0) > 1 },
    { id: "trend",      name: "Month by month",    draw: cardTrend,
      need: d => (d?.months?.length || 0) > 1 },
    { id: "recurring",  name: "Repeating charges", draw: cardRecurring,
      need: d => (d?.recurring || []).filter(r => r.discretionary).length > 0 },
  ];

  /* ------------------------------------------------------------------ */

  /** Draw one card and return the canvas. */
  function renderCard(cardId, data, opts = {}) {
    const S = SIZES[opts.size || "story"];
    const T = THEMES[opts.theme || "dark"];
    const card = CARDS.find(c => c.id === cardId);
    const canvas = document.createElement("canvas");
    canvas.width = S.w; canvas.height = S.h;
    const c = canvas.getContext("2d");
    c.textBaseline = "alphabetic";
    card.draw(c, S, T, data, { amounts: opts.amounts !== false });
    return canvas;
  }

  const toBlob = canvas => new Promise(res => canvas.toBlob(res, "image/png"));

  /**
   * Save one card to the device.
   *
   * This used to call `navigator.share`, which on a phone opens the system
   * share sheet. That looked helpful and was not: it adds a step before the
   * image exists anywhere, it cannot save several files at once, and people
   * who just wanted the picture in their gallery had to pick an app to send it
   * to first. Downloading puts it straight in Photos or Downloads, where every
   * app can already find it.
   */
  async function saveCard(canvas, filename) {
    const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /**
   * Save several cards.
   *
   * Browsers rate-limit rapid downloads and Chrome on Android shows a
   * "download multiple files?" permission bar when they arrive together, so
   * they are spaced out. That prompt is the browser's own and cannot be
   * suppressed from a page -- which is the real reason the app now lets people
   * choose which cards they want rather than sending five every time.
   */
  async function downloadAll(ids, data, opts, onProgress) {
    for (let i = 0; i < ids.length; i++) {
      if (onProgress) onProgress(i + 1, ids.length);
      await saveCard(renderCard(ids[i], data, opts), `my-spending-${ids[i]}.png`);
      if (i < ids.length - 1) await new Promise(r => setTimeout(r, 700));
    }
    return ids.length;
  }

  MSP.share = { CARDS, SIZES, TAGLINE, WATERMARK, downloadAll, renderCard, saveCard };
})(window.MSP = window.MSP || {});
