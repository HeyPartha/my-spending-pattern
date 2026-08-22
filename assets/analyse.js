/*
 * Turning categorised rows into the numbers on screen.
 *
 * The one idea that makes this different from a spreadsheet pivot: money that
 * moves between your own accounts, or a deposit you break, is not spending and
 * not income. If you count it, a person who shuffles ₹50,000 between two banks
 * every month appears to earn and spend ₹6 lakh a year that never existed.
 * Everything below filters on `flow` for exactly that reason.
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

  const { categorise, flowOf } = MSP.rules;

  const iso   = d => d.toISOString().slice(0, 10);
  const ymOf  = d => d.toISOString().slice(0, 7);
  const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun",
                              "Jul","Aug","Sep","Oct","Nov","Dec"];
  const prettyMonth = ym => {
    const [y, m] = ym.split("-");
    return `${MONTH_NAMES[+m - 1]} ${y}`;
  };

  /* ------------------------------------------------------------------ *
   * How long a period actually is, and what to call it
   *
   * Both of these used to be answered by counting months, which is wrong in
   * the same way twice. "12 months to Mar 2026" makes the reader do the
   * subtraction to find out where the year started, and a statement running to
   * the 8th of a month counts that month as a whole one -- so a spending
   * average divided by 30.4 x 8 was spread over 243 days when the statement
   * covered 220, and came out 9.5% too low. Days are a fact the rows already
   * carry; months were a guess about them.
   * ------------------------------------------------------------------ */

  const DAY = 864e5;

  /** First and last transaction date in a set of rows. */
  function extent(rows) {
    if (!rows || !rows.length) return null;
    let lo = rows[0].date, hi = rows[0].date;
    for (const r of rows) { if (r.date < lo) lo = r.date; if (r.date > hi) hi = r.date; }
    return { from: lo, to: hi };
  }

  /**
   * The number of days a period covers, for a per-day average.
   *
   * For the whole file that is simply first transaction to last. For one
   * selected month it is that calendar month clipped to what the statement
   * actually covers -- so a middle month counts its full length even if
   * payments cluster in one week, while a statement that stops on the 8th
   * counts eight days and not thirty-one.
   */
  function spanDays(allRows, ym) {
    const all = extent(allRows);
    if (!all) return 1;
    let from = all.from, to = all.to;
    if (ym && ym !== "all") {
      const [y, m] = ym.split("-").map(Number);
      const mStart = new Date(Date.UTC(y, m - 1, 1));
      const mEnd   = new Date(Date.UTC(y, m, 0));
      from = mStart > all.from ? mStart : all.from;
      to   = mEnd   < all.to   ? mEnd   : all.to;
    }
    return Math.max(1, Math.round((to - from) / DAY) + 1);
  }

  /**
   * What to print above a chart or on a share card.
   *
   * "Apr 2025 - Mar 2026" rather than "12 months to Mar 2026": the same width,
   * no arithmetic, and it cannot drift out of step with the data the way a
   * month count can. Where the span happens to be exactly an Indian financial
   * year the FY is added, because that is how an Indian statement is usually
   * discussed -- but only then, since claiming it otherwise would be wrong.
   */
  function periodLabel(allRows, ym) {
    if (ym && ym !== "all") return prettyMonth(ym);
    const e = extent(allRows);
    if (!e) return "";
    const a = ymOf(e.from), b = ymOf(e.to);
    if (a === b) return prettyMonth(a);
    const base = `${prettyMonth(a)} – ${prettyMonth(b)}`;
    const isFY = e.from.getUTCMonth() === 3 && e.to.getUTCMonth() === 2 &&
                 e.to.getUTCFullYear() === e.from.getUTCFullYear() + 1;
    return isFY ? `${base} · ${fyOf(e.from).replace("FY", "FY ")}` : base;
  }

  /** Indian financial year (April to March) containing this date. */
  const fyOf = d => {
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    return m >= 4 ? `FY${y}-${String((y + 1) % 100).padStart(2, "0")}`
                  : `FY${y - 1}-${String(y % 100).padStart(2, "0")}`;
  };

  /* ------------------------------------------------------------------ */

  /**
   * Cancel a failed payment against the refund that reversed it.
   *
   * Banks undo a failed standing instruction with a credit that repeats the
   * original reference number and usually starts "REV". Left alone the month
   * shows the money going out *and* an equal windfall coming back in, and a
   * failed loan instalment looks paid. Both legs become transfers so they
   * cancel; the reference must match, so a coincidental equal-and-opposite pair
   * is never merged by accident.
   */
  function markReversals(rows) {
    const revRx = /(?:^|[/\s])rev(?:ersal)?[/\s]/i;
    const used = new Set();
    for (const c of rows) {
      if (c.amount >= 0 || !revRx.test(c.description)) continue;
      const refs = c.description.match(/\d{6,}/g) || [];
      const near = rows.filter((d, i) =>
        d !== c && !used.has(i) && d.amount === -c.amount &&
        Math.abs(d.date - c.date) <= 5 * 864e5 &&
        (!refs.length || refs.some(r => d.description.includes(r))));
      if (!refs.length || !near.length) continue;
      const hit = near[0];
      used.add(rows.indexOf(hit));
      for (const leg of [c, hit]) {
        leg.category = "Reversed"; leg.flow = "TRANSFER";
        leg.group = "Transfer";    leg.source = "matched reversal";
        leg.major = "Reversed";
      }
    }
    return rows;
  }

  /**
   * Pair a debit against an equal credit a few days later.
   *
   * Within one account this is a payment that came back; across two accounts it
   * is you moving your own money. Either way it is not spending. Only rows the
   * rules left as ordinary expenses are considered, so a genuine salary is never
   * eaten by a coincidence.
   */
  function pairTransfers(rows, windowDays = 4) {
    const claimed = new Set();
    for (let i = 0; i < rows.length; i++) {
      const d = rows[i];
      if (d.amount <= 0 || claimed.has(i) || d.flow !== "EXPENSE") continue;
      for (let j = 0; j < rows.length; j++) {
        const c = rows[j];
        if (j === i || claimed.has(j) || c.amount !== -d.amount) continue;
        if (Math.abs(c.date - d.date) > windowDays * 864e5) continue;
        if (c.flow !== "INCOME" && c.flow !== "EXPENSE") continue;
        claimed.add(i); claimed.add(j);
        for (const leg of [d, c]) {
          leg.category = "Self Transfer"; leg.flow = "TRANSFER";
          leg.group = "Transfer";         leg.source = "matched pair";
          leg.major = "Self Transfer";
        }
        break;
      }
    }
    return rows;
  }

  /**
   * Let the rows that were recognised name the ones that were not.
   *
   * The same shop reaches the statement under several names. A payments app
   * writes "Paid to SUNRISE CATERERS"; the bank's own UPI line for the
   * identical payee is truncated to "UPI/SUNRISE/xxxx-000000000/…". The first
   * is obviously a caterer and gets filed as Food. The second says nothing,
   * looks like a person's name, and in one real statement there were 333 of
   * them -- a third of the whole file in the wrong place because one export
   * truncates at ten characters.
   *
   * No rule can fix that, because "SUNRISE" genuinely does not mean anything
   * on its own. But the file already contains the answer. Rows are grouped by
   * the first distinctive word of the payee, and where a group has a confident
   * category from its longer spellings, the unnamed rows in that group inherit
   * it. Only Miscellaneous and People rows are ever overwritten, so a rule
   * that did fire is never second-guessed.
   */
  const VAGUE = new Set(["Miscellaneous", "Person-to-Person"]);
  function propagateByPayee(rows) {
    const keyOf = r => {
      const w = (r.clean || "").split(/\s+/).filter(Boolean);
      return w.length && w[0].length >= 5 ? w[0] : null;
    };
    const votes = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      if (!k || VAGUE.has(r.category) || r.flow !== "EXPENSE") continue;
      if (!votes.has(k)) votes.set(k, new Map());
      const v = votes.get(k);
      v.set(r.category, (v.get(r.category) || 0) + 1);
    }
    for (const r of rows) {
      if (!VAGUE.has(r.category)) continue;
      const v = votes.get(keyOf(r));
      if (!v) continue;
      const best = [...v.entries()].sort((a, b) => b[1] - a[1]);
      // A single stray row is not evidence; two spellings agreeing is.
      if (best[0][1] < 2) continue;
      r.category = best[0][0];
      r.source = "learned from the same payee elsewhere in this file";
      r.major = MSP.rules.majorOf(r.category);
      r.group = MSP.rules.groupOf(r.category);
    }
    return rows;
  }

  /** Categorise, then run both pairing passes. Order matters. */
  function prepare(rawRows) {
    const rows = rawRows.map(categorise);
    propagateByPayee(rows);
    markReversals(rows);
    pairTransfers(rows);
    return rows;
  }

  /* ------------------------------------------------------------------ */

  const sum = (a, f) => a.reduce((s, r) => s + f(r), 0);

  /** Per-month totals across the whole file. */
  function byMonth(rows) {
    const map = new Map();
    for (const r of rows) {
      const k = ymOf(r.date);
      if (!map.has(k)) map.set(k, { month: k, spent: 0, income: 0, invested: 0, n: 0 });
      const m = map.get(k);
      if (r.flow === "EXPENSE")        m.spent += r.amount;
      else if (r.flow === "INCOME")    m.income += -r.amount;
      else if (r.flow === "INVESTMENT" && r.amount > 0) m.invested += r.amount;
      m.n++;
    }
    const out = [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
    for (const m of out) {
      m.saved = m.income - m.spent;
      m.rate  = m.income ? (m.income - m.spent) / m.income : null;
    }
    return out;
  }

  /**
   * Category totals for a set of rows, biggest first, with the trend arrow.
   *
   * Grouped by the headline category rather than the detailed one. Thirty
   * slices is not a chart -- see MAJOR in rules.js. The detail survives on
   * every row, so tapping a slice still lists the individual payments.
   */
  function byCategory(rows, prevRows = []) {
    const tot = new Map(), prev = new Map();
    for (const r of rows)     if (r.flow === "EXPENSE")
      tot.set(r.major, (tot.get(r.major) || 0) + r.amount);
    for (const r of prevRows) if (r.flow === "EXPENSE")
      prev.set(r.major, (prev.get(r.major) || 0) + r.amount);

    const grand = [...tot.values()].reduce((a, b) => a + b, 0) || 1;
    return [...tot.entries()]
      .map(([category, amount]) => {
        const was = prev.get(category) ?? null;
        return {
          category, amount, share: amount / grand, previous: was,
          change: was == null ? null : amount - was,
          direction: was == null ? null
                   : amount > was * 1.05 ? "up"
                   : amount < was * 0.95 ? "down" : "flat",
          count: rows.filter(r => r.major === category).length,
        };
      })
      .sort((a, b) => b.amount - a.amount);
  }

  /**
   * One level down: what a headline category is actually made of.
   *
   * Returns at most `limit` parts, biggest first, with everything below that
   * folded into a single "Other" row. The Other row is not tidiness -- it is
   * what makes the parts add up to the total the visitor just tapped. A
   * breakdown that silently drops the tail is a breakdown you cannot check,
   * and the first thing anyone does with one is add it up.
   *
   * It also keeps the palette honest: a ninth slice never gets an invented
   * colour, it goes into Other.
   */
  function breakdown(rows, keyOf, limit = 4, otherLabel = "Everything else") {
    const tot = new Map();
    for (const r of rows) {
      if (r.flow !== "EXPENSE") continue;
      const k = keyOf(r) || otherLabel;
      if (!tot.has(k)) tot.set(k, { key: k, amount: 0, count: 0 });
      const e = tot.get(k);
      e.amount += r.amount; e.count++;
    }
    const all = [...tot.values()].sort((a, b) => b.amount - a.amount);
    if (all.length <= limit + 1) return all;

    const head = all.slice(0, limit);
    const tail = all.slice(limit);
    head.push({
      key: otherLabel,
      amount: tail.reduce((a, b) => a + b.amount, 0),
      count: tail.reduce((a, b) => a + b.count, 0),
      isOther: true,
      parts: tail.length,
    });
    return head;
  }

  /** Needs / Wants / Misc split of spending. */
  function needsWants(rows) {
    const g = new Map();
    for (const r of rows) if (r.flow === "EXPENSE")
      g.set(r.group, (g.get(r.group) || 0) + r.amount);
    const total = [...g.values()].reduce((a, b) => a + b, 0) || 1;
    return ["Needs", "Wants", "Misc"]
      .filter(k => g.get(k))
      .map(k => ({ group: k, amount: g.get(k), share: g.get(k) / total }));
  }

  /** The merchants taking the most money, which is usually the surprise. */
  function topPayees(rows, n = 8) {
    const m = new Map();
    for (const r of rows) {
      if (r.flow !== "EXPENSE") continue;
      const key = (r.clean || r.description).split(" ").slice(0, 3).join(" ") || "—";
      if (!m.has(key)) m.set(key, { payee: key, amount: 0, count: 0,
                                    category: r.category });
      const e = m.get(key); e.amount += r.amount; e.count++;
    }
    return [...m.values()].sort((a, b) => b.amount - a.amount).slice(0, n);
  }

  /**
   * Repeating charges: the same payee for about the same amount, monthly.
   *
   * Worth surfacing on its own because subscriptions are the spending people are
   * least aware of -- they were agreed to once and never revisited.
   */
  function recurring(rows) {
    const m = new Map();
    for (const r of rows) {
      if (r.flow !== "EXPENSE" || r.amount < 49) continue;
      const key = (r.clean || r.description).split(" ").slice(0, 2).join(" ");
      if (!key) continue;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(r);
    }
    const out = [];
    for (const [payee, list] of m) {
      if (list.length < 3) continue;
      const months = new Set(list.map(r => ymOf(r.date)));
      if (months.size < 3) continue;
      const amts = list.map(r => r.amount).sort((a, b) => a - b);
      const med  = amts[Math.floor(amts.length / 2)];
      const tight = amts.filter(a => Math.abs(a - med) <= Math.max(med * 0.15, 20));
      if (tight.length < Math.max(3, list.length * 0.6)) continue;
      // Rent, an EMI and an insurance premium repeat every month too, but
      // nobody has forgotten about them. Only the discretionary ones belong in a
      // "charges you forgot you agreed to" claim; the table still shows all.
      const cat = list[0].category;
      out.push({ payee, amount: med, months: months.size, category: cat,
                 yearly: med * 12,
                 discretionary: !["EMI", "Rent", "Insurance", "Maid & Help",
                                  "Bills-Utilities", "Tax"].includes(cat) });
    }
    return out.sort((a, b) => b.amount - a.amount).slice(0, 8);
  }

  /**
   * Instalments the statement implies.
   *
   * Detected rather than configured: the same amount leaving on roughly the same
   * day of three or more consecutive months, filed as EMI or a loan-ish
   * narration. A missed one is invisible in a spending report -- it shows up as
   * nothing at all -- so it is worth naming.
   */
  function instalments(rows) {
    const m = new Map();
    for (const r of rows) {
      if (r.amount <= 0) continue;
      if (r.category !== "EMI" && !/loan|emi|instal/i.test(r.description)) continue;
      const key = Math.round(r.amount);
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(r);
    }
    const out = [];
    for (const [amount, list] of m) {
      const months = [...new Set(list.map(r => ymOf(r.date)))].sort();
      if (months.length < 3) continue;
      const days = list.map(r => r.date.getUTCDate());
      out.push({
        amount, months: months.length,
        day: Math.round(days.reduce((a, b) => a + b, 0) / days.length),
        lastPaid: months[months.length - 1],
        payee: (list[0].clean || list[0].description).slice(0, 40),
      });
    }
    return out.sort((a, b) => b.amount - a.amount);
  }

  /** Headline numbers for one period. */
  function kpis(rows, prevRows, days = 1) {
    const spent    = sum(rows.filter(r => r.flow === "EXPENSE"), r => r.amount);
    /* "Money in" can never be negative, so it is clamped and the rows that
     * would have made it negative are reported instead of quietly averaged in.
     *
     * A month once displayed a *negative* income. The cause was a misread
     * narration, since fixed, but the lesson is the one worth keeping:
     * an impossible figure on the front page destroys trust in every figure
     * beside it, and it is exactly the kind of thing a person notices and the
     * code does not. Anything that would drive this below zero is a row whose
     * direction could not be resolved, and saying so is more use than printing
     * a number that cannot be true. */
    const incomeRows = rows.filter(r => r.flow === "INCOME");
    const rawIncome  = sum(incomeRows, r => -r.amount);
    const contrary   = incomeRows.filter(r => r.amount > 0);
    const income     = Math.max(0, rawIncome);
    const invested = sum(rows.filter(r => r.flow === "INVESTMENT" && r.amount > 0),
                         r => r.amount);
    const pSpent  = sum(prevRows.filter(r => r.flow === "EXPENSE"), r => r.amount);
    const pIncome = sum(prevRows.filter(r => r.flow === "INCOME"), r => -r.amount);
    const pInv    = sum(prevRows.filter(r => r.flow === "INVESTMENT" && r.amount > 0),
                        r => r.amount);
    // What you kept is income minus what you spent. Money put into an SIP or a
    // deposit has NOT left you -- it changed form. Subtracting investment here
    // as though it were consumption is a common and demoralising error: it makes
    // the most disciplined months look like the worst ones.
    const saved = income - spent;

    /* What was set aside as "not spending", stated rather than assumed.
     *
     * Transfers between your own accounts, cash withdrawals and reversals are
     * deliberately kept out of Spent and Money in -- counting them would double
     * every rupee that merely moved. But silence about it is how a month came
     * to report an eighth of the debits its own statement showed, with nothing
     * on the page inviting anyone to question it. The total is now
     * shown, so the figure can be checked against the file it came from. */
    const excluded = sum(rows.filter(r => r.flow === "TRANSFER" && r.amount > 0),
                         r => r.amount);
    const excludedRows = rows.filter(r => r.flow === "TRANSFER").length;

    const tile = (key, label, value, previous, lowerIsBetter, sub) => ({
      key, label, value, previous, lowerIsBetter, sub,
      change: previous ? value - previous : null,
      changePct: previous ? (value - previous) / previous : null,
    });
    return [
      /* Only worth saying when there is real income to compare against. A
       * payment-app export contains almost no credits, and "95203% of what
       * came in" is noise dressed up as insight. */
      tile("spent", "Spent", spent, pSpent, true,
           income > spent * 0.1
             ? `${Math.round(spent / income * 100)}% of what came in` : null),
      tile("income", "Money in", income, Math.max(0, pIncome), false,
           contrary.length
             ? `${contrary.length} row${contrary.length > 1 ? "s" : ""} could not be resolved`
             : null),
      tile("invested", "Invested", invested, pInv, false,
           income > spent * 0.1
             ? `${Math.round(invested / income * 100)}% of what came in` : null),
      tile("saved", "Kept", saved, pIncome - pSpent, false,
           income > spent * 0.1 ? `${Math.round(saved / income * 100)}% saving rate`
                  + (invested ? `, ${Math.round(invested / income * 100)}% of it invested` : "")
                  : null),
      /* Divided by the days the statement actually covers, not by
       * 30.4 x the number of months it touches. A statement ending on the 8th
       * used to have that month counted as a full one. */
      tile("daily", "A day, on average", spent / Math.max(1, days), null, true,
           `${rows.filter(r => r.flow === "EXPENSE").length} payments over `
           + `${Math.round(days)} days`),
    ].concat(excluded > 0 ? [tile("excluded", "Moved, not spent", excluded, null, false,
           `${excludedRows} transfer${excludedRows > 1 ? "s" : ""}, `
           + "not counted as spending")] : []);
  }

  /**
   * Plain-language observations, ranked by how much money is at stake.
   *
   * Deliberately conservative: everything here is arithmetic on the rows, never
   * advice, and nothing is stated that the file does not show.
   */
  function insights(rows, monthly, cats, recur) {
    const out = [];
    const last = monthly[monthly.length - 1];
    const earlier = monthly.slice(0, -1);
    const avg = earlier.length
      ? earlier.reduce((s, m) => s + m.spent, 0) / earlier.length : null;

    if (last && avg && Math.abs(last.spent - avg) / avg > 0.15) {
      const up = last.spent > avg;
      out.push({ level: up ? "warn" : "good",
        title: `${prettyMonth(last.month)} ran ${up ? "high" : "low"}`,
        body: `You spent ${inr(last.spent)}, against ${inr(avg)} a month before `
            + `that — ${up ? "up" : "down"} ${Math.round(Math.abs(last.spent - avg) / avg * 100)}%.`,
        weight: Math.abs(last.spent - avg) });
    }

    const risen = cats.filter(c => c.direction === "up" && c.change > 1000)
                      .sort((a, b) => b.change - a.change)[0];
    if (risen) out.push({ level: "warn",
      title: `${risen.category} is climbing`,
      body: `${inr(risen.amount)} this period against ${inr(risen.previous)} last — `
          + `${inr(risen.change)} more, across ${risen.count} payments.`,
      weight: risen.change });

    const top = cats[0];
    if (top) out.push({ level: "info",
      title: `${top.category} takes the biggest share`,
      body: `${inr(top.amount)}, which is ${Math.round(top.share * 100)}% of everything `
          + `you spent. ${top.count} payments.`,
      weight: top.amount });

    const disc = recur.filter(r => r.discretionary);
    const subs = disc.reduce((s, r) => s + r.amount, 0);
    if (subs > 0) out.push({ level: "info",
      title: `${disc.length} charges repeat every month`,
      body: `They add up to ${inr(subs)} a month — ${inr(subs * 12)} over a year. `
          + `These are the easiest to forget you agreed to.`,
      weight: subs * 12 });

    const rate = monthly.length
      ? monthly.reduce((s, m) => s + (m.income - m.spent), 0) /
        (monthly.reduce((s, m) => s + m.income, 0) || 1) : 0;
    if (monthly.some(m => m.income > 0))
      out.push({ level: rate > 0.2 ? "good" : rate > 0 ? "warn" : "bad",
        title: `You keep ${Math.round(rate * 100)}% of what comes in`,
        body: (() => {
          const when = monthly.length > 1
            ? `Between ${prettyMonth(monthly[0].month)} and ${prettyMonth(monthly[monthly.length - 1].month)}`
            : `In ${prettyMonth(monthly[0].month)}`;
          return rate > 0
            ? `${when}, ${inr(monthly.reduce((s,m)=>s+m.income,0) - monthly.reduce((s,m)=>s+m.spent,0))} stayed with you.`
            : `${when} you spent more than came in.`;
        })(),
        weight: Math.abs(rate) * 1e6 });

    const weekend = rows.filter(r => r.flow === "EXPENSE" &&
      [0, 6].includes(r.date.getUTCDay()));
    const wkSpend = sum(weekend, r => r.amount);
    const allSpend = sum(rows.filter(r => r.flow === "EXPENSE"), r => r.amount);
    if (allSpend && wkSpend / allSpend > 0.35) out.push({ level: "info",
      title: "Weekends carry more than their share",
      body: `${Math.round(wkSpend / allSpend * 100)}% of your spending happens on `
          + `Saturday and Sunday — two days in seven.`,
      weight: wkSpend * 0.5 });

    return out.sort((a, b) => b.weight - a.weight).slice(0, 6);
  }

  /* ------------------------------------------------------------------ */

  /** Indian number formatting: lakh and crore, because that is how it reads. */
  function inr(v, sign = false) {
    if (v == null || isNaN(v)) return "—";
    const n = Math.abs(v);
    const s = v < 0 ? "−" : sign ? "+" : "";
    if (n >= 1e7)   return `${s}₹${(n / 1e7).toFixed(2)} Cr`;
    if (n >= 1e5)   return `${s}₹${(n / 1e5).toFixed(2)} L`;
    if (n >= 1000)  return `${s}₹${Math.round(n).toLocaleString("en-IN")}`;
    return `${s}₹${n.toFixed(n < 100 && n % 1 ? 2 : 0)}`;
  }
  const pct = v => v == null || isNaN(v) ? "—" : `${(v * 100).toFixed(0)}%`;

  MSP.analyse = { MONTH_NAMES, breakdown, byCategory, byMonth, extent, fyOf, inr, insights, instalments, iso, kpis, markReversals, needsWants, pairTransfers, pct, periodLabel, prepare, prettyMonth, recurring, spanDays, topPayees, ymOf };
})(window.MSP = window.MSP || {});
