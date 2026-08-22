/*
 * My Spending Pattern -- the page.
 *
 * Everything is in memory. There is no database, no account, and no fetch()
 * that carries transaction data anywhere; reload the page and it is gone. That
 * is a deliberate design choice rather than a missing feature -- it is what
 * makes the promise on the landing page true, and checkable: open the network
 * tab and watch nothing leave.
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

  const { readStatement, dedupe } = MSP.parse;
  const { demoRows } = MSP.demo;
  const { barChart, lineChart, donut, columns, esc } = MSP.charts;
  const { CARDS, SIZES, renderCard, downloadAll } = MSP.share;
  const { feedbackHtml, wireFeedback } = MSP.feedback;
  const {
    prepare, byMonth, byCategory, breakdown, needsWants, topPayees, recurring,
    instalments, kpis, insights, inr, pct, ymOf, prettyMonth, periodLabel, spanDays,
  } = MSP.analyse;

  const $ = s => document.querySelector(s);
  /* How many payments the table lists. A long scroll of rows buried the
   * cards underneath it, and the full set is one click away as a CSV. */
  const RECENT = 10;
  const state = {
    raw: [],          // rows as read from the files
    rows: [],         // categorised
    files: [],        // { name, read, from, to }
    isDemo: false,
    period: "all",    // "all" or a YYYY-MM
    /* Where the visitor has drilled to, as a path.
     *   []                            everything
     *   ["Travel & Transport"]        one headline category
     *   ["Travel & Transport","Trip"] one of its parts
     * A path rather than a flag because the way back has to be unambiguous:
     * every level knows its parent, so the breadcrumb writes itself and there
     * is no state where the chart and the table disagree about what is shown. */
    drill: [],
    // Every card is selected to begin with -- someone who wants them all
    // should not have to tick five boxes, and unticking is the easier action.
    share: { size: "story", theme: "dark", amounts: true, picked: null },
  };

  /* ------------------------------------------------------------------ *
   * Loading
   * ------------------------------------------------------------------ */
  /**
   * Read the dropped files, asking for a password where one is needed.
   *
   * Banks send statements locked far more often than not, and "convert it
   * yourself first" is exactly the friction that makes a tool go unused. So a
   * locked file prompts, in the page, and the password goes no further than
   * the decryption routine.
   */
  async function addFiles(fileList) {
    const note = $("#dropnote");
    const problems = [];
    let added = 0;

    for (const file of fileList) {
      note.textContent = `Reading ${file.name}…`;
      let password, override;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const { rows, meta } = await readStatement(file, password, override);
          if (!rows.length) {
            problems.push(`${file.name}: opened, but no transactions were found in it.`);
            break;
          }
          // The demo is invented data; a real file replaces it rather than
          // being mixed into it.
          if (state.isDemo) { state.raw = []; state.files = []; state.isDemo = false; }
          const fresh = dedupe(state.raw, rows);
          state.raw = state.raw.concat(fresh).sort((a, b) => a.date - b.date);
          state.files.push({ name: file.name, read: fresh.length,
                             repeated: rows.length - fresh.length,
                             from: meta.from, to: meta.to,
                             skipped: meta.skippedUndated,
                             noAmount: meta.skippedZero,
                             signed: meta.signed });
          added += fresh.length;
          break;
        } catch (err) {
          if (err && err.needsPassword) {
            const pw = await askPassword(file.name, attempt > 0 ? err.message : null);
            if (pw === null) { problems.push(`${file.name}: skipped.`); break; }
            password = pw;
            continue;
          }
          /* The columns could not be worked out. Ask rather than refuse.
           *
           * A growing number of banks draw the header row as a picture, so
           * there is no word "Description" anywhere in the file to match. The
           * transactions are all there and perfectly readable -- the only
           * missing piece is which column is which, and the person looking at
           * the file can answer that in five seconds. */
          if (err && err.needsColumns && !override) {
            const picked = await askColumns(file.name, err.needsColumns);
            if (picked === null) { problems.push(`${file.name}: skipped.`); break; }
            override = picked;
            continue;
          }
          problems.push(`${file.name}: ${err.message}`);
          break;
        }
      }
    }

    note.innerHTML = problems.length
      ? problems.map(p => `<span class="bad">${esc(p)}</span>`).join("<br>")
      : "";
    if (added || state.raw.length) { state.period = "all"; state.drill = []; render(); }
  }

  /**
   * Ask for a file's password. Resolves to the password, or null if cancelled.
   *
   * A dialog in the page rather than `prompt()`, so it can say plainly what
   * happens to the password — which is the thing anyone sensible wants to know
   * before typing their date of birth into a website.
   */
  function askPassword(filename, retryMessage) {
    return new Promise(resolve => {
      const dlg = document.createElement("dialog");
      dlg.className = "pwdlg";
      dlg.innerHTML = `
        <form method="dialog">
          <h3>This file is locked</h3>
          <p class="muted"><b>${esc(filename)}</b> needs a password to open.</p>
          ${retryMessage ? `<p class="bad">${esc(retryMessage)}</p>` : ""}
          <input type="password" id="pw-input" autocomplete="off"
                 placeholder="Password" autofocus>
          <p class="muted">Banks usually use your date of birth as
            <code>DDMMYYYY</code>, your PAN in capitals, or your customer ID —
            the email the statement came in normally says which.</p>
          <p class="pwnote">🔒 The password is used here in your browser to open
            the file and nothing else. It is not saved, not remembered, and not
            sent anywhere — there is nowhere for it to be sent to.</p>
          <div class="fbrow">
            <button class="btn pri" value="ok" id="pw-ok">Open it</button>
            <button class="btn" value="cancel">Skip this file</button>
          </div>
        </form>`;
      document.body.appendChild(dlg);
      const input = dlg.querySelector("#pw-input");
      dlg.addEventListener("close", () => {
        const v = dlg.returnValue === "ok" ? input.value : null;
        dlg.remove();
        resolve(v);
      });
      dlg.showModal();
      setTimeout(() => input.focus(), 50);
    });
  }

  /**
   * Ask which column is which. Resolves to { columns, start }, or null.
   *
   * The alternative was a dead end -- "could not find the transaction table"
   * and nothing to do about it. The file is readable; only the labels are
   * missing, and the person has the file open in front of them. A guess is
   * pre-filled where one could be made, so in the usual case this is a glance
   * and one button rather than six decisions.
   */
  function askColumns(filename, info) {
    const ROLES = [
      ["",        "— ignore —"],
      ["date",    "Date"],
      ["desc",    "Description"],
      ["debit",   "Money out (debit)"],
      ["credit",  "Money in (credit)"],
      ["amount",  "Amount (one column, both ways)"],
      ["balance", "Balance"],
    ];
    const guess = info.guess || {};
    const roleAt = {};
    for (const [k] of ROLES) if (k && guess[k] !== undefined) roleAt[guess[k]] = k;

    const width = info.width || Math.max(1, ...info.preview.map(r => r.length));
    const cut = v => (v.length > 26 ? v.slice(0, 25) + "…" : v);

    return new Promise(resolve => {
      const dlg = document.createElement("dialog");
      dlg.className = "pwdlg coldlg";
      dlg.innerHTML = `
        <form method="dialog">
          <h3>Which column is which?</h3>
          <p class="muted">${info.bodyRows >= 5
            ? `<b>${esc(filename)}</b> has ${info.bodyRows} rows that look like
               transactions, but its header row is drawn as a picture rather
               than written as text, so the columns could not be named
               automatically.`
            : `<b>${esc(filename)}</b> could not be read automatically — nothing
               in it matched a heading this page knows, and the layout was not
               obvious from the figures either.`}</p>
          <p class="muted">Here are the first rows. Set
            <b>Date</b>, <b>Description</b> and the money columns — the rest can
            stay on “ignore”.</p>
          <div class="colwrap">
            <table class="coltable">
              <thead><tr>${Array.from({ length: width }, (_, c) => `
                <th><select data-col="${c}">${ROLES.map(([v, label]) =>
                  `<option value="${v}"${roleAt[c] === v ? " selected" : ""}>${esc(label)}</option>`
                ).join("")}</select></th>`).join("")}</tr></thead>
              <tbody>${info.preview.map(r => `<tr>${
                Array.from({ length: width }, (_, c) =>
                  `<td>${esc(cut(r[c] || ""))}</td>`).join("")
              }</tr>`).join("")}</tbody>
            </table>
          </div>
          <p class="bad" id="col-err" hidden></p>
          <div class="fbrow">
            <button class="btn pri" value="ok" id="col-ok">Read it this way</button>
            <button class="btn" value="cancel">Skip this file</button>
          </div>
        </form>`;
      document.body.appendChild(dlg);

      const read = () => {
        const columns = {};
        dlg.querySelectorAll("select[data-col]").forEach(sel => {
          if (sel.value) columns[sel.value] = +sel.dataset.col;
        });
        return columns;
      };

      /* Two selects on the same role is the one mistake worth catching -- it
       * silently discards a column instead of failing. */
      const err = dlg.querySelector("#col-err");
      const check = () => {
        const used = [...dlg.querySelectorAll("select[data-col]")]
          .map(x => x.value).filter(Boolean);
        const dup = used.find((v, i) => used.indexOf(v) !== i);
        const cols = read();
        let msg = "";
        if (dup) msg = "Two columns are both set to the same thing.";
        else if (cols.date === undefined) msg = "One column has to be the date.";
        else if (cols.debit === undefined && cols.credit === undefined &&
                 cols.amount === undefined)
          msg = "Pick the money column — either an Amount, or Money out and Money in.";
        err.hidden = !msg;
        err.textContent = msg;
        dlg.querySelector("#col-ok").disabled = !!msg;
        return !msg;
      };
      dlg.addEventListener("change", check);
      check();

      dlg.addEventListener("close", () => {
        const v = dlg.returnValue === "ok"
          ? { columns: read(), start: info.start || 0 } : null;
        dlg.remove();
        resolve(v);
      });
      dlg.showModal();
    });
  }

  function loadDemo() {
    state.raw = demoRows();
    state.files = [{ name: "example data", read: state.raw.length, repeated: 0,
                     from: state.raw[0].date,
                     to: state.raw[state.raw.length - 1].date, skipped: 0 }];
    state.isDemo = true;
    state.period = "all"; state.drill = [];
    render();
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */
  function render() {
    state.rows = prepare(state.raw.map(r => ({ ...r })));
    const all = state.rows;
    if (!all.length) return;

    $("#hero").hidden = true;
    $("#app").hidden = false;
    // The drop zone has done its job; fold it to one line.
    const dz = $("#drop");
    dz.classList.add("mini");
    const cb = $("#drop-collapse");
    cb.hidden = false; cb.onclick = openPicker;
    const sb = $("#drop-reset");
    if (sb) { sb.hidden = false; sb.onclick = reset; }
    dz.setAttribute("aria-label", "Drop another statement to add it");

    const monthly = byMonth(all);
    const months = monthly.map(m => m.month);
    if (state.period !== "all" && !months.includes(state.period)) state.period = "all";

    const inPeriod = state.period === "all"
      ? all : all.filter(r => ymOf(r.date) === state.period);
    const prev = (() => {
      if (state.period === "all") return [];
      const i = months.indexOf(state.period);
      return i > 0 ? all.filter(r => ymOf(r.date) === months[i - 1]) : [];
    })();
    /* The days the selected period actually covers. Counting months treated a
     * statement ending on the 8th as a whole month and made the per-day
     * average 9.5% too low on a real file. */
    const spanDaysN = spanDays(all, state.period);

    const cats  = byCategory(inPeriod, prev);
    const k     = kpis(inPeriod, prev, spanDaysN);
    const nw    = needsWants(inPeriod);
    const pay   = topPayees(inPeriod);
    const recur = recurring(all);
    const emis  = instalments(all);
    const notes = insights(all, monthly, cats, recur);

    const filtered =
        state.drill.length === 0 ? inPeriod
      : state.drill.length === 1 ? inPeriod.filter(r => r.major === state.drill[0])
      : inPeriod.filter(r => r.major === state.drill[0] &&
                             r.category === state.drill[1]);

    $("#app").innerHTML = `
      ${banner()}
      ${periodChips(months)}

      <div class="grid tiles" style="margin-top:12px">
        ${k.map(tileHtml).join("")}
      </div>

      <div class="grid two" style="margin-top:12px">
        <div class="card">
          <h2>Where it goes</h2>
          ${crumbHtml()}
          <div id="c-cat"></div>
          <p class="muted">${drillHint()}</p>
        </div>
        <div class="card">
          <h2>Needs, wants and the rest</h2>
          <div id="c-nw"></div>
        </div>
      </div>

      <div class="card wide" style="margin-top:12px">
        <h2>Month by month</h2>
        <div id="c-trend"></div>
      </div>

      <div class="grid two" style="margin-top:12px">
        <div class="card"><h2>What you spend on most</h2><div id="c-pay"></div></div>
        <div class="card">
          <h2>Worth knowing</h2>
          ${notes.map(n => `<div class="insight">
              <span class="dot2" style="background:var(--${
                n.level === "good" ? "good" : n.level === "warn" ? "warning"
                : n.level === "bad" ? "critical" : "series-1"})"></span>
              <div><b>${esc(n.title)}</b><p>${esc(n.body)}</p></div></div>`).join("")}
        </div>
      </div>

      ${recur.length ? `<div class="card wide" style="margin-top:12px">
        <h2>Charges that repeat every month
          <span class="pill">${inr(recur.reduce((s, r) => s + r.amount, 0))} a month</span></h2>
        <div class="tblwrap"><table>
          <thead><tr><th>Payee</th><th>Category</th><th class="num">Each month</th>
            <th class="num">Seen in</th><th class="num">A year</th></tr></thead>
          <tbody>${recur.map(r => `<tr>
            <td class="name">${esc(r.payee)}</td><td>${esc(r.category)}</td>
            <td class="num">${inr(r.amount)}</td>
            <td class="num">${r.months} months</td>
            <td class="num">${inr(r.yearly)}</td></tr>`).join("")}</tbody>
        </table></div>
        <p class="muted">Found by looking for the same payee at about the same amount
          in three or more months. Cancelling one is the cheapest saving there is.</p>
      </div>` : ""}

      ${emis.length ? `<div class="card wide" style="margin-top:12px">
        <h2>Loan instalments this statement shows
          <span class="pill">${inr(emis.reduce((s, e) => s + e.amount, 0))} a month</span></h2>
        <div class="tblwrap"><table>
          <thead><tr><th>Payee</th><th class="num">Amount</th><th class="num">Around the</th>
            <th class="num">Months seen</th><th>Last one</th></tr></thead>
          <tbody>${emis.map(e => `<tr>
            <td class="name">${esc(e.payee)}</td>
            <td class="num">${inr(e.amount)}</td>
            <td class="num">${e.day}${ordinal(e.day)}</td>
            <td class="num">${e.months}</td>
            <td>${prettyMonth(e.lastPaid)}</td></tr>`).join("")}</tbody>
        </table></div>
        <p class="muted">Worked out from the statement, not entered by you: the same
          amount leaving on roughly the same day, three months or more.</p>
      </div>` : ""}

      ${shareHtml()}

      <div class="card wide" style="margin-top:12px">
        <h2>${state.drill.length ? esc(state.drill[state.drill.length - 1]) : "Every payment"}
          <span class="pill">${filtered.length} rows</span></h2>
        <div class="tblwrap"><table>
          <thead><tr><th>Date</th><th>What it was</th><th>Category</th>
            <th class="num">Amount</th></tr></thead>
          <tbody>${filtered.slice(-RECENT).reverse().map(r => `<tr>
            <td>${r.date.toISOString().slice(0, 10)}</td>
            <td class="name">${esc((r.clean || r.description).slice(0, 46))}</td>
            <td>${esc(r.category)}</td>
            <td class="num ${r.amount < 0 ? "good" : ""}">${inr(r.amount)}</td>
          </tr>`).join("")}</tbody>
        </table></div>
        <p class="muted">The ${Math.min(RECENT, filtered.length)} most recent of ${filtered.length} — the rest are in the CSV below.
          ${state.rows.filter(r => r.source === "unmatched").length} of
          ${state.rows.length} payments could not be named from the narration and
          are counted under Miscellaneous.</p>
      </div>


      <div class="card wide" style="margin-top:12px">
        <h2>Take it with you</h2>
        <div style="display:flex;gap:9px;flex-wrap:wrap">
          <button class="btn" id="btn-csv">Download as CSV</button>
          <button class="btn" id="btn-reset">Clear everything</button>
        </div>
        <p class="muted">The download is built in your browser from what is on screen.
          Clearing wipes it from memory — closing the tab does the same.</p>
      </div>

      ${feedbackHtml()}`;

    /* charts */
    drawCategoryChart(cats, inPeriod);

    donut($("#c-nw"), nw.map(g => ({ label: g.group, value: g.amount })), { fmt: inr });

    lineChart($("#c-trend"), monthly.map(m => ({
        label: prettyMonth(m.month), spent: m.spent, income: m.income,
        invested: m.invested })),
      [{ key: "spent", label: "Spent" }, { key: "income", label: "Money in" },
       { key: "invested", label: "Invested" }], { fmt: inr });

    barChart($("#c-pay"), pay.map(p => ({
        label: p.payee, value: p.amount,
        hint: `<b>${esc(p.payee)}</b>${p.count} payments · ${esc(p.category)}` })),
      { fmt: inr });

    /* wiring */
    wireShare(shareData(all, inPeriod, monthly, cats, nw, recur));
    wireFeedback($("#app"));
    $("#app").querySelectorAll("[data-crumb]").forEach(b => b.onclick = () => {
      state.drill = state.drill.slice(0, +b.dataset.crumb);
      render();
    });
    $("#btn-csv").onclick = downloadCsv;
    $("#btn-reset").onclick = reset;
    // Scoped to the period row on purpose. A document-wide ".chip" selector also
    // caught the share-card chips further down the page and replaced their
    // handler with a period change, so picking a card silently did nothing.
    document.querySelectorAll("#periodchips .chip").forEach(c => c.onclick = () => {
      state.period = c.dataset.p; render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  const ordinal = d => ["th","st","nd","rd"][(d % 100 - 20) % 10] || ["th","st","nd","rd"][d] || "th";

  /* ------------------------------------------------------------------ *
   * Shareable cards
   * ------------------------------------------------------------------ */

  /** Everything a card can draw, and nothing else. */
  function shareData(all, inPeriod, monthly, cats, nw, recur) {
    const sum = (rows, f) => rows.reduce((s, r) => s + f(r), 0);
    const spent  = sum(inPeriod.filter(r => r.flow === "EXPENSE"), r => r.amount);
    const income = sum(inPeriod.filter(r => r.flow === "INCOME"), r => -r.amount);
    const invested = sum(
      inPeriod.filter(r => r.flow === "INVESTMENT" && r.amount > 0), r => r.amount);
    return {
      periodLabel: periodLabel(all, state.period),
      spent, income, invested, kept: income - spent,
      savingRate: income ? (income - spent) / income : null,
      categories: cats,
      split: nw,
      months: monthly.map(m => ({ label: prettyMonth(m.month).slice(0, 3),
                                  spent: m.spent, income: m.income })),
      recurring: recur,
    };
  }

  function shareHtml() {
    const s = state.share;
    // Everything is selected by default. This runs while the page HTML is
    // being built, before wireShare has seen the data, so the set is created
    // here and trimmed to the cards that can actually be drawn afterwards.
    if (!s.picked) s.picked = new Set(CARDS.map(c => c.id));
    return `
    <div class="card wide" id="sharecard" style="margin-top:12px">
      <h2>Make a picture of it
        <span class="pill">for Instagram &amp; WhatsApp</span></h2>
      <p class="muted" style="margin-top:0">Each card is drawn fresh at story
        size — not a screenshot — so it stays readable on a phone.</p>

      <div class="sharepick" id="share-pick">
        ${CARDS.map(c => `<button class="chip" data-card="${c.id}"
          aria-pressed="${s.picked.has(c.id)}">${esc(c.name)}</button>`).join("")}
        <button class="chip" id="share-toggle-all">Select none</button>
      </div>

      <div class="shareopts">
        <div class="seg" id="share-size">
          ${Object.entries(SIZES).map(([k, v]) => `<button data-size="${k}"
            aria-pressed="${s.size === k}">${esc(v.label)}</button>`).join("")}
        </div>
        <div class="seg" id="share-theme">
          <button data-theme="dark"  aria-pressed="${s.theme === "dark"}">Dark</button>
          <button data-theme="light" aria-pressed="${s.theme === "light"}">Light</button>
        </div>
        <label class="switch">
          <input type="checkbox" id="share-amounts" ${s.amounts ? "checked" : ""}>
          <span>Show rupee amounts</span>
        </label>
      </div>

      <div class="sharepreview" id="share-preview"></div>

      <div class="fbrow">
        <button class="btn pri" id="share-go">Download the selected cards</button>
        <span class="muted" id="share-msg"></span>
      </div>
      <p class="muted">Turn amounts off and the cards show only percentages and
        rankings — the shape of your spending without the size of your salary.
        Every card carries the <b>${esc(MSP.share.WATERMARK)}</b>
        mark. Images are made in your browser; nothing is uploaded.</p>
    </div>`;
  }

  function wireShare(data) {
    state._shareData = data;
    const s = state.share;
    // Default to every card the current data can actually draw.
    if (!s.picked)
      s.picked = new Set(CARDS.filter(c => c.need(data)).map(c => c.id));
    const panel = $("#sharecard");
    if (!panel) return;

    const preview = () => {
      const host = $("#share-preview");
      host.innerHTML = "";
      const ids = CARDS.filter(c => s.picked.has(c.id) && c.need(data)).map(c => c.id);
      if (!ids.length) {
        host.innerHTML = '<p class="muted">Pick at least one card.</p>';
        return;
      }
      for (const id of ids) {
        const canvas = renderCard(id, data, s);
        canvas.className = "sharethumb";
        canvas.title = CARDS.find(c => c.id === id).name;
        host.appendChild(canvas);
      }
    };

    panel.querySelectorAll("[data-card]").forEach(b => b.onclick = () => {
      const id = b.dataset.card;
      if (!CARDS.find(c => c.id === id).need(data)) return;
      s.picked.has(id) ? s.picked.delete(id) : s.picked.add(id);
      b.setAttribute("aria-pressed", s.picked.has(id));
      refreshToggle();
      preview();
    });
    // A card with nothing to draw is shown disabled rather than hidden, so the
    // list does not change shape as the period filter moves.
    panel.querySelectorAll("[data-card]").forEach(b => {
      if (!CARDS.find(c => c.id === b.dataset.card).need(data)) {
        b.disabled = true; b.title = "Not enough data in this period";
        b.style.opacity = .45;
      }
    });
    panel.querySelectorAll("[data-size]").forEach(b => b.onclick = () => {
      s.size = b.dataset.size;
      panel.querySelectorAll("[data-size]").forEach(x =>
        x.setAttribute("aria-pressed", x.dataset.size === s.size));
      preview();
    });
    panel.querySelectorAll("[data-theme]").forEach(b => b.onclick = () => {
      s.theme = b.dataset.theme;
      panel.querySelectorAll("[data-theme]").forEach(x =>
        x.setAttribute("aria-pressed", x.dataset.theme === s.theme));
      preview();
    });
    $("#share-amounts").onchange = e => { s.amounts = e.target.checked; preview(); };

    const toggleAll = $("#share-toggle-all");
    const refreshToggle = () => {
      const all = CARDS.filter(c => c.need(data));
      const allOn = all.every(c => s.picked.has(c.id));
      toggleAll.textContent = allOn ? "Select none" : "Select all";
      toggleAll.dataset.mode = allOn ? "none" : "all";
    };
    if (toggleAll) {
      refreshToggle();
      toggleAll.onclick = () => {
        const all = CARDS.filter(c => c.need(data));
        if (toggleAll.dataset.mode === "none") s.picked.clear();
        else all.forEach(c => s.picked.add(c.id));
        panel.querySelectorAll("[data-card]").forEach(b =>
          b.setAttribute("aria-pressed", s.picked.has(b.dataset.card)));
        refreshToggle();
        preview();
      };
    }

    $("#share-go").onclick = async () => {
      const ids = CARDS.filter(c => s.picked.has(c.id) && c.need(data)).map(c => c.id);
      const btn = $("#share-go"), msg = $("#share-msg");
      if (!ids.length) { msg.textContent = "Pick at least one card first."; return; }
      btn.disabled = true;
      const done = await downloadAll(ids, data, s,
        (i, n) => { msg.textContent = `Saving ${i} of ${n}…`; });
      btn.disabled = false;
      msg.textContent = done === 1
        ? "Saved to your downloads."
        : `${done} images saved to your downloads.`;
      if (done > 1) msg.textContent +=
        " Your browser may ask whether to allow several files — that prompt is the browser's, not this page's.";
    };

    preview();
  }

  /* ------------------------------------------------------------------ *
   * Drilling into a category
   *
   * Three levels, each answering the next question a person actually asks:
   *
   *   Where did the money go?              ten headline categories
   *   What is inside that one?             its parts, plus Everything else
   *   Who did I actually pay?              the payees inside that part
   *
   * Two rules make it trustworthy rather than merely clickable. Every level
   * sums to the level above -- the tail is folded into a visible "Everything
   * else" row instead of being dropped, so the numbers can be checked by
   * adding them up. And the breadcrumb is always present, because a chart you
   * can get lost inside is worse than one that does not move at all.
   * ------------------------------------------------------------------ */

  function crumbHtml() {
    if (!state.drill.length) return "";
    const parts = ["All spending", ...state.drill];
    return `<nav class="crumb" aria-label="Category">` + parts.map((p, i) =>
      i === parts.length - 1
        ? `<span aria-current="true">${esc(p)}</span>`
        : `<button type="button" class="linky" data-crumb="${i}">${esc(p)}</button>`
      ).join(`<span class="sep">›</span>`) + `</nav>`;
  }

  const drillHint = () =>
      state.drill.length === 0 ? "Tap a category to see what is inside it."
    : state.drill.length === 1 ? "Tap again to see who you paid."
    : "These are the payees behind that total.";

  function drawCategoryChart(cats, inPeriod) {
    const host = $("#c-cat");

    if (state.drill.length === 0) {
      barChart(host, cats.slice(0, 10).map(c => ({
        label: c.category, value: c.amount, arrow: c.direction,
        hint: `<b>${esc(c.category)}</b>${inr(c.amount)} · ${c.count} payments`
            + (c.previous != null ? `<br>was ${inr(c.previous)} last month` : "")
            + `<br>Tap to open`,
      })), { fmt: inr, onClick: r => { state.drill = [r.label]; render(); } });
      return;
    }

    const inMajor = inPeriod.filter(r => r.major === state.drill[0]);

    if (state.drill.length === 1) {
      const parts = breakdown(inMajor, r => r.category, 4,
                              `Rest of ${state.drill[0]}`);
      barChart(host, parts.map(p => ({
        label: p.key, value: p.amount,
        hint: `<b>${esc(p.key)}</b>${inr(p.amount)} · ${p.count} payments`
            + (p.isOther ? `<br>${p.parts} smaller kinds, added up`
                         : `<br>Tap to see who you paid`),
      })), { fmt: inr, onClick: r => {
        // "Rest of …" is a total, not a category — there is nothing under it.
        if (parts.find(p => p.key === r.label)?.isOther) return;
        state.drill = [state.drill[0], r.label];
        render();
      } });
      return;
    }

    const inDetail = inMajor.filter(r => r.category === state.drill[1]);
    /* Two words, not the whole cleaned string. The cleaner keeps the payment
     * remark after the payee -- "s ramesh kumar lawyerchar" and "s ramesh
     * kumar fees" -- and keying on all of it splits one person into a list of
     * near-identical rows that reads as noise. The same
     * two-word key is what the top-payees table uses. */
    const payees = breakdown(
      inDetail, r => (r.clean || r.description).split(" ").slice(0, 2).join(" ") || "—",
      6, "Everyone else");
    barChart(host, payees.map(p => ({
      label: p.key, value: p.amount,
      hint: `<b>${esc(p.key)}</b>${inr(p.amount)} · ${p.count} payments`,
    })), { fmt: inr });
  }

  function tileHtml(t) {
    const dir = t.change == null ? null
              : Math.abs(t.changePct) < 0.02 ? "flat"
              : (t.change > 0) === !t.lowerIsBetter ? "down" : "up";
    return `<div class="card tile">
      <div class="label">${esc(t.label)}</div>
      <div class="value">${inr(t.value)}</div>
      ${dir ? `<div class="delta ${dir}">
        <span class="arrow">${dir === "up" ? "▲" : dir === "down" ? "▼" : "—"}</span>
        ${inr(Math.abs(t.change))} vs last month</div>` : ""}
      ${t.sub ? `<div class="sub">${esc(t.sub)}</div>` : ""}
    </div>`;
  }

  function periodChips(months) {
    return `<div class="chips" id="periodchips">
      <button class="chip" data-p="all" aria-pressed="${state.period === "all"}">
        All months</button>
      ${months.slice().reverse().map(m => `<button class="chip" data-p="${m}"
        aria-pressed="${state.period === m}">${esc(prettyMonth(m))}</button>`).join("")}
    </div>`;
  }

  function banner() {
    const f = state.files;
    if (state.isDemo) return `<div class="banner demo">
      <span>👋</span><div><b>This is example data</b> — an invented person's year,
      not yours. Open your own statement whenever you like; nothing you load is
      uploaded or stored.</div></div>`;
    const total = f.reduce((s, x) => s + x.read, 0);
    const rep   = f.reduce((s, x) => s + x.repeated, 0);
    const noAmt = f.reduce((s, x) => s + (x.noAmount || 0), 0);
    const noDate = f.reduce((s, x) => s + (x.skipped || 0), 0);
    /* Say what was left out, in the same breath as what was read.
     *
     * A row count that quietly differs from the file is how someone ends up
     * trusting a wrong total. Somebody checked a 255-row sheet against this,
     * got 227, and had no way to find out where the other 28 went. Rows with
     * no amount in them are not transactions and skipping them is right --
     * but silently is not. */
    const notes = [];
    if (rep)   notes.push(`${rep} repeated from a file already loaded`);
    if (noAmt) notes.push(`${noAmt} with no amount`);
    if (noDate) notes.push(`${noDate} with no date`);
    const unsigned = f.length && f.every(x => x.signed === false);
    return `<div class="banner"><span>✅</span><div>
      <b>${total} transactions</b> from ${f.length} file${f.length > 1 ? "s" : ""}
      ${notes.length ? ` · skipped ${notes.join(", ")}` : ""} —
      ${f.map(x => esc(x.name)).join(", ")}.
      Read in this browser — nothing was sent anywhere.
      ${unsigned ? `<br><span class="muted">This file has a single amount column
        and no debit/credit marker, so a row counts as money going out unless
        its own wording says otherwise — "refund", "deposit", "credit". If
        "Money in" looks too low, that is why.</span>` : ""}</div></div>`;
  }

  /* ------------------------------------------------------------------ */
  function downloadCsv() {
    /* Both labels, because exporting only one of them reads as a bug.
     *
     * There are three levels: the category is the finest label, the headline
     * is what the chart draws, and the group is the needs/wants split. The
     * export used to carry the category alone, so a row the screen showed
     * under "Payments to People" arrived in the spreadsheet as
     * "Person-to-Person" and the two looked like they disagreed. They never
     * did -- they are different columns -- but nothing on the page said so. */
    const head = "date,description,category,headline,group,flow,amount\n";
    const body = state.rows.map(r => [
      r.date.toISOString().slice(0, 10),
      `"${String(r.description).replace(/"/g, '""')}"`,
      r.category, r.major, r.group, r.flow, r.amount,
    ].join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([head + body], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = "my-spending-pattern.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  function reset() {
    state.raw = []; state.rows = []; state.files = [];
    state.isDemo = false; state.drill = []; state.period = "all";
    $("#app").hidden = true; $("#app").innerHTML = "";
    $("#hero").hidden = false; $("#dropnote").textContent = "";
    $("#drop").classList.remove("mini");
    $("#drop-collapse").hidden = true;
    if ($("#drop-reset")) $("#drop-reset").hidden = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ------------------------------------------------------------------ *
   * Wiring the shell
   * ------------------------------------------------------------------ */
  const openPicker = () => $("#file").click();
  /* Clicking the name goes back to the start. There was no way back from an
   * analysis except reloading the page, which on a phone is a deliberate act
   * people do not think to try -- the title in the corner is where everyone
   * looks first, so that is what it now does. */
  $("#brand").onclick = () => { if (state.rows.length || state.isDemo) reset(); };
  ["#btn-open", "#hero-open", "#btn-choose"].forEach(s => $(s).onclick = openPicker);
  ["#btn-demo", "#hero-demo", "#btn-demo2"].forEach(s => $(s).onclick = loadDemo);
  $("#file").onchange = e => { addFiles([...e.target.files]); e.target.value = ""; };

  const drop = $("#drop");
  ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.add("over");
  }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.remove("over");
  }));
  drop.addEventListener("drop", e => addFiles([...e.dataTransfer.files]));
  // Dropping anywhere else should not make the browser navigate to the file.
  addEventListener("dragover", e => e.preventDefault());
  addEventListener("drop", e => e.preventDefault());

  const theme = $("#btn-theme");
  theme.onclick = () => {
    const now = document.documentElement.getAttribute("data-theme");
    const next = now === "dark" ? "light" : now === "light" ? "" : "dark";
    if (next) document.documentElement.setAttribute("data-theme", next);
    else document.documentElement.removeAttribute("data-theme");
    try { localStorage.setItem("msp-theme", next); } catch {}
    if (state.rows.length) render();          // charts re-read the CSS variables
  };
  try {
    const saved = localStorage.getItem("msp-theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  } catch {}

  $("#link-about").onclick = e => {
    e.preventDefault();
    alert(
      "My Spending Pattern reads your statement inside this page.\n\n" +
      "The file is opened with the browser's own file reader, parsed in " +
      "JavaScript, and categorised by a list of text rules. No part of it is " +
      "sent to a server — there is no server. Close the tab and it is gone.\n\n" +
      "You can check this yourself: open your browser's developer tools, go to " +
      "the Network tab, and load a statement. Nothing goes out.");
  };

  /* Redraw when the window is actually resized -- and only then.
   *
   * This listener used to fire on any resize and rebuild the whole page. On a
   * phone that is a trap: opening the on-screen keyboard shrinks the viewport,
   * which fires `resize`, which replaced the DOM, which destroyed the input the
   * keyboard belonged to. The keyboard then closed, firing `resize` again. The
   * result was a keyboard flickering open and shut and a page that jumped
   * around while you tried to type your email address.
   *
   * Two guards. Only a change of *width* counts, since the keyboard changes
   * only height. And nothing is redrawn at all while a field has focus. */
  let t, lastWidth = innerWidth;
  addEventListener("resize", () => {
    if (innerWidth === lastWidth) return;              // keyboard, not a resize
    lastWidth = innerWidth;
    const typing = document.activeElement;
    if (typing && /^(INPUT|TEXTAREA|SELECT)$/.test(typing.tagName)) return;
    clearTimeout(t);
    t = setTimeout(() => state.rows.length && render(), 200);
  });

  /* ------------------------------------------------------------------ *
   * Offline support.
   *
   * Registered here rather than as an inline <script> in the page, so the site
   * can ship a Content-Security-Policy of `script-src 'self'` with no
   * 'unsafe-inline' escape hatch. That header is what makes the privacy promise
   * enforceable by the browser instead of merely stated in the footer.
   *
   * It fails quietly on file:// because service workers need http(s), and
   * double-clicking index.html should still work.
   * ------------------------------------------------------------------ */
  /*
   * Register the offline cache, and reload once when a new version takes over.
   *
   * Without the reload the page keeps running the old scripts until the tab is
   * closed and reopened -- which on a phone, where tabs live for weeks, means
   * an update can sit installed and invisible indefinitely. The guard stops it
   * looping: controllerchange also fires the first time a worker ever takes
   * control, and reloading then would be a reload on every first visit.
   */
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading || !navigator.serviceWorker.controller) return;
      if (!sessionStorage.getItem("msp-had-controller")) return;
      reloading = true;
      location.reload();
    });
    try {
      if (navigator.serviceWorker.controller)
        sessionStorage.setItem("msp-had-controller", "1");
    } catch {}
    addEventListener("load", () =>
      navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})(window.MSP = window.MSP || {});
