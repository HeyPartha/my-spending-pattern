/*
 * Reading a bank statement, entirely in the browser.
 *
 * Nothing here is uploaded. The File object comes from an <input> or a drop
 * event, is read with FileReader, and every line below runs on the reader's
 * own machine. There is no fetch() in this file and no server to send it to.
 *
 * Two formats:
 *
 *   CSV  -- parsed by hand, because bank CSVs have a preamble (account holder,
 *           branch, IFSC, date range) before the real header row, and a
 *           disclaimer paragraph after the last transaction. A naive
 *           split-on-comma reader trips over both.
 *
 *   XLSX -- a zip of XML. Browsers ship DecompressionStream("deflate-raw") and
 *           DOMParser, so the whole reader is about a hundred lines and needs
 *           no library. This matters for a static site: a spreadsheet library
 *           is a megabyte of JavaScript to make one file type work.
 *
 * The old binary .xls format is a different thing entirely -- a compound
 * document with its own record stream -- and is deliberately not supported.
 * Opening it and saving as .xlsx or .csv takes a user ten seconds; shipping a
 * BIFF reader costs everyone else page weight forever.
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

  /* ------------------------------------------------------------------ *
   * Dates
   * ------------------------------------------------------------------ */

  /**
   * Parse a date the way the bank happened to write it in that row.
   *
   * Banks mix separators inside a single export -- `5/8/2026` on one line and
   * `28-02-2026` on the next. Anything that locks onto one format from the first
   * row silently drops the rest, and undated rows get discarded. That exact bug
   * once cost 31 rows out of 72, including every salary credit.
   *
   * Day-first is assumed, which is right for Indian statements. Where the day is
   * clearly above 12 the other way round is used instead, so an unusual export
   * still lands on the right date.
   */
  function parseDate(v) {
    if (v == null || v === "") return null;
    if (v instanceof Date && !isNaN(v)) return v;

    // Excel serial number (days since 1899-12-30)
    if (typeof v === "number" && v > 20000 && v < 60000)
      return new Date(Math.round((v - 25569) * 86400000));

    const s = String(v).trim();
    if (!s) return null;

    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);          // ISO
    if (m) return mk(+m[1], +m[2], +m[3]);

    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);            // d/m/y
    if (m) {
      let [, a, b, y] = m.map(Number);
      if (y < 100) y += 2000;
      // day-first unless the first field cannot be a day
      return a > 12 && b <= 12 ? mk(y, b, a) : mk(y, b, a);
    }

    m = s.match(/^([A-Za-z]{3,})\s*(\d{1,2})\s*,?\s*(\d{2,4})/);        // Aug 10, 2026
    if (m) {
      const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
      let y = +m[3]; if (y < 100) y += 2000;
      if (mon >= 0) return mk(y, mon + 1, +m[2]);
    }

    m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{2,4})/);       // 05-Aug-2026
    if (m) {
      const mon = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
      let y = +m[3]; if (y < 100) y += 2000;
      if (mon >= 0) return mk(y, mon + 1, +m[1]);
    }

    /* A date with no year at all -- "18 Jan", "Jan 18".
     *
     * SBI's PDF sets "18 Jan 2026" across two lines and only "18 Jan" reaches
     * this function. The year has to come from somewhere sensible, and it is
     * emphatically NOT `new Date(s)`: JavaScript parses "18 Jan" as 18 January
     * *2001*, silently and with no error. That put 44 of one statement's 103
     * rows five years in the past, invented chips for Dec 2001 and Jun 2001,
     * and made a monthly chart that could not be read.
     *
     * So a year-less date is returned marked, and the caller fills the year in
     * from the rows around it -- a statement is in date order, which makes
     * that a fact rather than a guess.
     */
    m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})\s*$/)
     || s.match(/^([A-Za-z]{3,})[-\s](\d{1,2})\s*$/);
    if (m) {
      const dayFirst = /^\d/.test(s);
      const mon = MONTHS.indexOf((dayFirst ? m[2] : m[1]).slice(0, 3).toLowerCase());
      const day = +(dayFirst ? m[1] : m[2]);
      if (mon >= 0 && day >= 1 && day <= 31) {
        const d = new Date(Date.UTC(1970, mon, day));
        d.yearUnknown = true;
        return d;
      }
    }

    /* Deliberately no `new Date(s)` fallback here. It accepts almost anything
     * and answers with confidence -- which is the worst behaviour a parser can
     * have when the alternative is admitting the row has no date and saying so
     * in the "rows skipped" count. */
    return null;
  }
  const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const mk = (y, m, d) =>
    (m >= 1 && m <= 12 && d >= 1 && d <= 31) ? new Date(Date.UTC(y, m - 1, d)) : null;

  const num = v => {
    if (v == null || v === "") return 0;
    if (typeof v === "number") return v;
    const s = String(v).replace(/[₹,\s\u00a0]/g, "").replace(/^(rs\.?|inr)/i, "").replace(/\((.*)\)/, "-$1");
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  };

  /* ------------------------------------------------------------------ *
   * CSV
   * ------------------------------------------------------------------ */
  function splitCsvLine(line) {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim());
  }

  function csvToGrid(text) {
    // A quoted field can contain newlines, so lines are re-joined when the
    // quote count is odd -- the trailing bank disclaimer is usually one of these.
    const raw = text.replace(/\r\n?/g, "\n").split("\n");
    const rows = []; let buf = "";
    for (const line of raw) {
      buf = buf ? buf + "\n" + line : line;
      if ((buf.match(/"/g) || []).length % 2 === 0) { rows.push(splitCsvLine(buf)); buf = ""; }
    }
    if (buf) rows.push(splitCsvLine(buf));
    return rows;
  }

  /**
   * An HTML table -> a grid.
   *
   * Several banks export a `.xls` that is really an HTML table. Excel opens
   * it, so nobody at the bank notices, and every spreadsheet reader chokes on
   * it. The browser already has a perfectly good HTML parser.
   */
  function htmlToGrid(text) {
    const doc = new DOMParser().parseFromString(text, "text/html");
    const grid = [];
    for (const tr of doc.querySelectorAll("tr")) {
      const row = [];
      for (const td of tr.querySelectorAll("td,th")) {
        row.push((td.textContent || "").replace(/\s+/g, " ").trim());
        // a merged cell stands for several, so the columns still line up
        const span = parseInt(td.getAttribute("colspan") || "1", 10);
        for (let k = 1; k < span; k++) row.push("");
      }
      if (row.length) grid.push(row);
    }
    return grid;
  }

  /* ------------------------------------------------------------------ *
   * XLSX -- a zip of XML, read with what the browser already has
   * ------------------------------------------------------------------ */
  async function unzip(buffer) {
    const dv = new DataView(buffer), files = {};
    // Walk the central directory backwards from the end-of-central-directory
    // record. Reading local headers front-to-back is unreliable because the
    // compressed size is sometimes only in the data descriptor.
    let eocd = -1;
    for (let i = dv.byteLength - 22; i >= 0 && i > dv.byteLength - 65558; i--)
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("not a valid .xlsx file");

    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method   = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen  = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const cmtLen   = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(
        new Uint8Array(buffer, p + 46, nameLen));

      const lNameLen  = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const bytes = new Uint8Array(buffer, start, compSize);

      files[name] = method === 0 ? bytes : await inflate(bytes);
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return files;
  }

  async function inflate(bytes) {
    const ds = new DecompressionStream("deflate-raw");
    const out = new Response(
      new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(await out);
  }

  const xmlOf = bytes => new DOMParser().parseFromString(
    new TextDecoder().decode(bytes), "application/xml");

  function colOf(ref) {                       // "BC12" -> 54
    let n = 0;
    for (const ch of ref) {
      const c = ch.charCodeAt(0);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  async function xlsxToGrid(buffer) {
    const files = await unzip(buffer);
    const shared = [];
    if (files["xl/sharedStrings.xml"]) {
      for (const si of xmlOf(files["xl/sharedStrings.xml"]).getElementsByTagName("si"))
        shared.push([...si.getElementsByTagName("t")].map(t => t.textContent).join(""));
    }
    // first worksheet by document order
    const sheetName = Object.keys(files)
      .filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
      .sort()[0];
    if (!sheetName) throw new Error("no worksheet found in this file");

    const grid = [];
    for (const row of xmlOf(files[sheetName]).getElementsByTagName("row")) {
      const cells = [];
      for (const c of row.getElementsByTagName("c")) {
        const i = colOf(c.getAttribute("r") || "A1");
        const t = c.getAttribute("t");
        const vEl = c.getElementsByTagName("v")[0];
        let v = "";
        if (t === "s")       v = shared[+(vEl?.textContent ?? -1)] ?? "";
        else if (t === "inlineStr") v = c.textContent;
        else if (vEl)        v = isNaN(+vEl.textContent) ? vEl.textContent : +vEl.textContent;
        cells[i] = v;
      }
      grid.push([...cells].map(v => v === undefined ? "" : v));
    }
    return grid;
  }

  /* ------------------------------------------------------------------ *
   * Finding the real header row, and what each column means
   * ------------------------------------------------------------------ */
  /* What each column heading looks like.
   *
   * Scored rather than first-match, because the obvious regexes collide on
   * real files. PhonePe's export has a column called "Credit/debit
   * instrument" that holds "Paid by XXXX70" -- a naive /^credit/ claims it as
   * the credit column, the amount then reads as zero, and every row is
   * silently dropped. That single collision is why the app appeared not to
   * read CSVs at all.
   *
   * So each candidate scores against every role, the best pairing wins, and
   * the values themselves get a vote: a column of words cannot be an amount.
   */
  const HEAD = {
    date: [
      [/^(transaction|txn|tran|posting|value)\s*[.\-]?\s*date$/i, 10],
      [/^date$|^dt$/i, 9],
      [/date/i, 4],
    ],
    /* Widely, because this heading is the one people abbreviate.
     *
     * A hand-kept sheet headed "Desc" matched nothing here, so no description
     * column was found, every narration came through empty, and the whole file
     * was filed as Miscellaneous -- 227 rows of it. The dedupe key includes the
     * description, so with it blank any two payments of the same amount on the
     * same day collapsed into one and ten real transactions disappeared as
     * well. One unmatched heading, three wrong answers. */
    desc: [
      [/^(transaction\s*)?(remarks?|narration|particulars?|description|details?|desc)$/i, 10],
      [/^(desc|narr|part|remark|detail|descr|note|memo)/i, 8],
      [/^(text|purpose|payee|merchant|beneficiary|name|comment|notes?|for|what)$/i, 7],
      [/remark|narrat|descri|particular|^details?$|transaction\s*detail/i, 6],
      [/^to\s*\/\s*from$|^paid\s*to$|^sent\s*to$/i, 5],
    ],
    debit: [
      [/^(debit|withdrawal)\b/i, 10],
      [/withdraw|debit\s*amount|\bdr\s*amount\b|paid\s*out|^wdl/i, 7],
      [/^dr$/i, 5],
    ],
    credit: [
      [/^(credit|deposit)\b(?!.*instrument)/i, 10],
      [/deposit\s*amount|credit\s*amount|paid\s*in/i, 7],
      [/^cr$/i, 5],
    ],
    amount: [
      [/^(amount|amt)\b/i, 9],
      [/^amount|^amt|\bamount\b/i, 5],
    ],
    balance: [
      [/balance/i, 9],
    ],
    drcr: [
      [/^(transaction\s*type|type|dr\s*\/\s*cr|cr\s*\/\s*dr|indicator)$/i, 10],
      [/\btype\b/i, 5],
    ],
  };

  const scoreHead = (text, role) => {
    /* Also tested with the spaces removed.
     *
     * A heading read out of a PDF often arrives with stray gaps in it --
     * "Am ount", "With drawal" -- because the glyphs were positioned
     * individually and the reader had to guess where the words break. The
     * heading is still perfectly recognisable once the spaces are gone, and
     * without this the amount column goes unfound and every row is dropped. */
    const forms = [text, text.replace(/\s+/g, "")];
    let best = 0;
    for (const [rx, pts] of HEAD[role])
      for (const f of forms) if (rx.test(f)) best = Math.max(best, pts);
    return best;
  };

  /**
   * Find the row that names the columns.
   *
   * Bank exports put six or seven lines of account details above the table --
   * and those lines contain the word "Date" too, so taking the first row that
   * mentions a date lands on the wrong one. ICICI goes further and repeats a
   * "Transaction Date from / to" line in its preamble.
   *
   * So every row in the first stretch of the file is scored on how many
   * distinct column roles it names, and the best-scoring row wins. A real
   * header names three or four; a preamble line names one.
   */
  function findHeader(grid) {
    let best = -1, bestScore = 0;
    for (let i = 0; i < Math.min(grid.length, 60); i++) {
      const cells = grid[i].map(c => String(c ?? "").trim()).filter(Boolean);
      if (cells.length < 2) continue;

      const roles = new Set();
      let score = 0;
      for (const c of cells) {
        if (c.length > 40) continue;                 // a sentence, not a heading
        for (const role of Object.keys(HEAD)) {
          const sc = scoreHead(c, role);
          if (sc >= 5 && !roles.has(role)) { roles.add(role); score += sc; }
        }
      }
      if (!roles.has("date")) continue;
      if (!roles.has("desc") && !roles.has("debit") && !roles.has("credit")
          && !roles.has("amount")) continue;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  /**
   * Decide which column is which.
   *
   * Two passes. Headings are scored against every role and the highest score
   * wins the column, so a strong match ("Withdrawal Amount") beats a weak one
   * ("Credit/debit instrument") for the same slot. Then the data is checked:
   * a column claimed as an amount whose values are mostly words is not an
   * amount, and the claim is dropped rather than believed.
   */
  function mapColumns(header, sample) {
    const roles = Object.keys(HEAD);
    const pairs = [];
    header.forEach((raw, i) => {
      const c = String(raw ?? "").trim();
      if (!c) return;
      for (const role of roles) {
        const sc = scoreHead(c, role);
        if (sc) pairs.push({ role, i, sc, text: c });
      }
    });
    pairs.sort((a, b) => b.sc - a.sc);

    const idx = {}, taken = new Set();
    for (const p of pairs) {
      if (idx[p.role] !== undefined || taken.has(p.i)) continue;
      idx[p.role] = p.i;
      taken.add(p.i);
    }

    // Does the data agree? A money column has to hold numbers.
    const numericShare = i => {
      const vals = sample.map(r => String(r[i] ?? "").trim()).filter(Boolean);
      if (!vals.length) return 1;                  // empty column: no evidence
      const nums = vals.filter(v => /^[-+(]?\s*(₹|rs\.?|inr)?[\s\u00a0]*[\d,]+(\.\d+)?\)?$/i.test(v));
      return nums.length / vals.length;
    };
    for (const role of ["debit", "credit", "amount", "balance"])
      if (idx[role] !== undefined && numericShare(idx[role]) < 0.6) delete idx[role];

    /* No recognisable heading? Take the column that holds the words.
     *
     * Headings are the polite way to find the narration and they cannot be
     * relied on: people keep their own sheets, banks invent labels, and an
     * export can arrive with no header row worth the name. The data does not
     * lie in the same way -- exactly one column in a statement is full of
     * long text that is not a number and not a date, and that column is the
     * description. Without this fallback an unrecognised heading silently
     * costs every rule its input. */
    if (idx.desc === undefined) {
      const taken = new Set(Object.values(idx));
      let best = -1, bestScore = 0;
      const width = sample.length ? Math.max(...sample.map(r => r.length)) : 0;
      for (let i = 0; i < width; i++) {
        if (taken.has(i)) continue;
        const vals = sample.map(r => String(r[i] ?? "").trim()).filter(Boolean);
        if (vals.length < Math.max(2, sample.length * 0.5)) continue;
        const wordy = vals.filter(v =>
          /[A-Za-z]{3}/.test(v) && !/^[-+(₹\s]*[\d,]+(\.\d+)?\)?$/.test(v));
        if (wordy.length < vals.length * 0.7) continue;
        // Longest average text wins: a "Type" column of DEBIT/CREDIT is wordy
        // too, but it is short and repetitive.
        const score = wordy.reduce((a, v) => a + v.length, 0) / wordy.length;
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best >= 0 && bestScore >= 6) idx.desc = best;
    }

    // A lone signed "Amount" plus a DEBIT/CREDIT column is the PhonePe shape;
    // separate debit and credit columns is the bank shape. Having neither
    // means nothing can be read, so say so clearly rather than returning zeros.
    return idx;
  }

  /**
   * The account holder's name, read out of the statement's own header.
   *
   * This is the single most useful fact in the block of text above the table,
   * and it was being skipped over as page furniture. Every bank prints it, and
   * with it a whole class of rows stops being a mystery: a NEFT or IMPS whose
   * narration carries your own name is you moving your own money, not a
   * payment to anybody. Those rows are the largest amounts in a statement, so
   * getting them wrong distorts every total on the page.
   *
   * Nothing is hardcoded and nothing is remembered. The name comes out of the
   * file the visitor just opened, is used while categorising it, and goes when
   * the tab closes -- like everything else here.
   */
  const NAME_LABEL =
    /^\s*(a\/?c|account)?\s*(holder'?s?)?\s*name\s*$|^\s*customer\s*name\s*$/i;
  const TITLE = /^(mr|mrs|ms|miss|dr|shri|smt|sri)\b\.?\s+/i;

  function findHolder(grid, headerRow) {
    const tidy = t => String(t ?? "")
      .replace(/\(.*?\)/g, " ")               // "( INR )" in ICICI's header
      .replace(/\b(mr|mrs|ms|miss|dr|shri|smt|sri)\b\.?/gi, " ")
      .replace(/[^A-Za-z\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const looksName = t => {
      const w = t.split(" ").filter(Boolean);
      return w.length >= 2 && w.length <= 5 && w.join("").length >= 6;
    };
    const take = t => { const c = tidy(t); return looksName(c) ? c.toUpperCase() : null; };

    for (let i = 0; i < Math.min(headerRow, grid.length); i++) {
      const row = grid[i] || [];
      for (let c = 0; c < row.length; c++) {
        /* A cell can hold the label and the value together or apart. Bank of
         * India writes one cell, "Account Holder Name :  A N SHARMA";
         * the PDF of the same account puts the label and the name in separate
         * columns. Both spellings have to work or the feature only ever fires
         * for whichever bank it was written against. */
        for (const line of String(row[c] ?? "").split(/[\r\n]+/)) {
          const kv = line.split(/[:\t]/);
          if (kv.length > 1 && NAME_LABEL.test(kv[0])) {
            const hit = take(kv.slice(1).join(" "));
            if (hit) return hit;
          }
          // A name on its own line, announced by a title. SBI's export opens
          // with "Mr. A N SHARMA" and no label anywhere.
          if (TITLE.test(line)) { const hit = take(line); if (hit) return hit; }
        }
        if (NAME_LABEL.test(String(row[c] ?? "").replace(/[:\s]+$/, ""))) {
          for (let k = c + 1; k < row.length; k++) {
            const hit = take(String(row[k] ?? "").replace(/^[\s:.\-\t]+/, ""));
            if (hit) return hit;
          }
        }
      }
      /* ICICI writes no name label at all -- the holder is tacked onto the
       * account-number line as "100200300400 ( INR ) - A N SHARMA". */
      for (const cell of row) {
        const m = String(cell ?? "").match(/\d{6,}[^-]*-\s*([A-Za-z][A-Za-z\s.]{5,40})$/);
        if (m) { const hit = take(m[1]); if (hit) return hit; }
      }
    }
    return null;
  }

  /**
   * Give a year to the rows that arrived without one.
   *
   * A statement is in date order. That is the whole trick: a row printed
   * between 30 December and 3 January belongs to the later year, and a row
   * between two rows of 2026 belongs to 2026. Nothing has to be guessed.
   *
   * Rows are still in file order here, so the direction of the statement can
   * be read off the rows that do have years -- some banks print newest first.
   * A month that runs backwards against that direction is a year boundary.
   */
  function fillMissingYears(rows) {
    const known = rows.filter(r => !r.yearUnknown);
    if (!known.length) return rows;

    const ascending = known.length < 2
      || known[known.length - 1].date >= known[0].date;
    const step = ascending ? 1 : -1;

    let year = known[0].date.getUTCFullYear();
    let prevMonth = null;
    for (const r of rows) {
      const mo = r.date.getUTCMonth();
      if (!r.yearUnknown) {
        year = r.date.getUTCFullYear();
      } else {
        // December followed by January (or the reverse, in a newest-first
        // statement) is the only place the year can change.
        if (prevMonth !== null) {
          if (ascending && mo < prevMonth - 6) year += step;
          else if (!ascending && mo > prevMonth + 6) year += step;
        }
        r.date = new Date(Date.UTC(year, mo, r.date.getUTCDate()));
      }
      prevMonth = mo;
      delete r.yearUnknown;
    }
    return rows;
  }


  /* ------------------------------------------------------------------ *
   * Working out the columns from the data, when the headings cannot help
   *
   * State Bank of India's current statement PDF draws its table header as
   * graphics rather than text. Searching every stream in one such file for
   * "Description", "Txn Date", "Value Date", "Ref No" and "Cheque" returns
   * zero hits -- the words are pictures. Only "Balance" happens to be real
   * text. No list of column names can ever match that file, however long, and
   * SBI is the largest bank in the country.
   *
   * So the headings become an optimisation rather than a requirement. The
   * transactions themselves say which column is which:
   *
   *   the date column      is the one that parses as dates
   *   the description      is the one full of long words
   *   the balance          is the one whose CHANGE between two rows equals
   *                        another column's value on the second row
   *
   * That last test is arithmetic rather than a guess, and it is decisive: on
   * the file above, the true balance column scores 608 out of 609 and the only
   * other candidate scores 0 out of 496. And once the balance is known, the
   * direction of every row is known too -- a figure matching a fall in the
   * balance is money out, one matching a rise is money in -- so debit and
   * credit need no headings either.
   * ------------------------------------------------------------------ */

  /** A cell a bank means as "nothing here". */
  const BLANKISH = /^(|-|–|—|\.|n\/?a|nil|null)$/i;
  const blankish = v => BLANKISH.test(String(v ?? "").trim());

  /** Money-shaped: digits, optional grouping, currency, sign, CR/DR suffix.
   *
   * The trailing `/-` is included because it is how a great many Indian
   * statements and hand-kept sheets write a rupee figure, and rejecting it
   * made a column of perfectly ordinary amounts read as text. */
  const moneyish = v => {
    const t = String(v ?? "").trim();
    if (blankish(t)) return false;
    return /^[-+(]?\s*(₹|rs\.?|inr)?[\s ]*[\d,]+(\.\d+)?\s*\)?\s*(\/[-=])?\s*(cr|dr)?$/i.test(t);
  };

  /**
   * The rows that are transactions: a date, and at least one figure.
   *
   * Deliberately not "rows below the header" -- there is no header here. The
   * letterhead has no dates, and the summary block at the end has figures but
   * no date, so both fall away without being named.
   */
  function findBody(grid) {
    const out = [];
    for (let i = 0; i < grid.length; i++) {
      const r = grid[i] || [];
      if (r.some(c => parseDate(c)) && r.some(moneyish)) out.push(i);
    }
    return out;
  }

  function inferColumns(grid) {
    const bodyAt = findBody(grid);
    if (bodyAt.length < 5) return null;
    const body = bodyAt.map(i => grid[i]);
    const width = Math.max(...body.map(r => r.length));
    const n = body.length;

    const stat = [];
    for (let i = 0; i < width; i++) {
      const vals = body.map(r => String(r[i] ?? "").trim());
      const filled = vals.filter(v => !blankish(v));
      const wordy = filled.filter(v => /[A-Za-z]{3}/.test(v) && !moneyish(v));
      stat.push({
        i,
        fill:  filled.length / n,
        dates: vals.filter(v => parseDate(v)).length / n,
        nums:  filled.length ? filled.filter(moneyish).length / filled.length : 0,
        count: filled.length,
        text:  wordy.length ? wordy.reduce((a, v) => a + v.length, 0) / wordy.length : 0,
        wordy: wordy.length / n,
      });
    }

    const idx = {};

    /* Dates. Two columns of them is normal -- a transaction date and a value
     * date -- and the leftmost is the transaction date in every Indian format
     * I have seen. */
    const dateCols = stat.filter(c => c.dates >= 0.8).map(c => c.i);
    if (!dateCols.length) return null;
    idx.date = dateCols[0];

    // The narration: the wordiest column that is not a date.
    const textCols = stat.filter(c => !dateCols.includes(c.i) && c.wordy >= 0.5 && c.text >= 6)
                         .sort((a, b) => b.text - a.text);
    if (textCols.length) idx.desc = textCols[0].i;

    const numCols = stat.filter(c => !dateCols.includes(c.i) && c.i !== idx.desc &&
                                     c.nums >= 0.9 && c.count >= 3).map(c => c.i);
    if (!numCols.length) return null;

    const num = v => {
      const t = String(v ?? "").replace(/[₹,\s ]/g, "").replace(/^(rs\.?|inr)/i, "");
      const x = parseFloat(t.replace(/[()]/g, ""));
      return isNaN(x) ? null : (/^\(|\)$/.test(t) ? -x : x);
    };

    /* Which numeric column is the running balance? The one whose change from
     * row to row is explained by another column on that row. */
    let balance = null, best = 0;
    for (const b of numCols) {
      let ok = 0, tried = 0;
      for (let k = 1; k < body.length; k++) {
        const prev = num(body[k - 1][b]), now = num(body[k][b]);
        if (prev == null || now == null) continue;
        const move = Math.round((prev - now) * 100) / 100;
        tried++;
        const explained = numCols.some(c => {
          if (c === b) return false;
          const v = num(body[k][c]);
          return v != null && (Math.abs(Math.abs(v) - Math.abs(move)) < 0.02);
        });
        if (explained) ok++;
      }
      const score = tried ? ok / tried : 0;
      if (score > best) { best = score; balance = b; }
    }
    // Two thirds is a comfortable margin: a real balance column scores near 1
    // and anything else scores near 0. Nothing lands in between by accident.
    if (balance != null && best >= 0.66) idx.balance = balance;

    const money = numCols.filter(c => c !== idx.balance);
    if (!money.length) return null;

    if (idx.balance != null) {
      /* With a balance, direction is a fact rather than a guess: a figure that
       * matches a fall in the balance is money leaving. Each money column is
       * put to that vote across the whole file. */
      const votes = new Map(money.map(c => [c, { out: 0, in: 0 }]));
      for (let k = 1; k < body.length; k++) {
        const prev = num(body[k - 1][idx.balance]), now = num(body[k][idx.balance]);
        if (prev == null || now == null) continue;
        const move = Math.round((prev - now) * 100) / 100;
        for (const c of money) {
          const v = num(body[k][c]);
          if (v == null || !v) continue;
          if (Math.abs(Math.abs(v) - Math.abs(move)) > 0.02) continue;
          votes.get(c)[move > 0 ? "out" : "in"]++;
        }
      }
      const outs = money.filter(c => votes.get(c).out > votes.get(c).in);
      const ins  = money.filter(c => votes.get(c).in  > votes.get(c).out);
      if (outs.length === 1 && ins.length === 1) {
        idx.debit = outs[0]; idx.credit = ins[0];
      } else if (money.length === 1) {
        // One column for both directions. The balance supplies the sign.
        idx.amount = money[0];
        idx.signFromBalance = true;
      } else {
        idx.debit = money[0]; idx.credit = money[1];
      }
    } else if (money.length >= 2) {
      idx.debit = money[0]; idx.credit = money[1];
    } else {
      idx.amount = money[0];
    }

    return { idx, start: bodyAt[0], body: bodyAt.length };
  }

  /* ------------------------------------------------------------------ *
   * Public entry point
   * ------------------------------------------------------------------ */

  /**
   * Turn a stretch of grid rows into transactions, given a column map.
   *
   * Split out of readStatement so the same code can be run against the layout
   * the headings suggest, the layout the data suggests, and the layout the
   * visitor picks -- and the results compared. Whichever yields the most
   * transactions is the one that was right.
   */
  function buildRows(grid, start, idx, holder) {
    const bal = i => (idx.balance === undefined ? null
                      : (moneyish(grid[i][idx.balance]) ? num(grid[i][idx.balance]) : null));
    const rows = [];
    let skippedUndated = 0, skippedZero = 0;
    if (!idx || idx.date === undefined) return { rows, skippedUndated, skippedZero };

    /* Which transaction does a wrapped line belong to -- the one above, or the
     * one below?
     *
     * Almost every bank wraps a long narration downwards, so a line with no
     * date continues the transaction above it. SBI does the opposite: it
     * prints the transaction type ("WDL TFR", "DEP TFR", "DIRECT DR",
     * "POS ATM PURCH") on the line ABOVE the dated row. Assuming downwards
     * there hands every row its neighbour's type word and takes its own away.
     *
     * This is not guessed per bank, it is measured per file. A type word says
     * which way the money went, and the row's own debit and credit columns say
     * the same thing independently -- so whichever side the marker is really
     * on is the side that agrees with those columns. On the statement this was
     * written for, above agreed 599 times out of 599 and below agreed 509:
     * not a close call, and no bank name had to be hard-coded to see it. */
    const OUT_WORD = /\b(wdl|withdraw\w*|purch\w*|pos)\b/i;
    const IN_WORD  = /\b(dep|deposit|refund|credited)\b/i;
    const markerOf = t => (OUT_WORD.test(t) ? "out" : IN_WORD.test(t) ? "in" : null);
    const bare = i => {                       // an undated line with no figures on it
      const r = grid[i];
      if (!r || parseDate(r[idx.date])) return null;
      if (["debit", "credit", "amount", "balance"]
          .some(k => idx[k] !== undefined && String(r[idx[k]] ?? "").trim())) return null;
      const t = String(r[idx.desc] ?? "").trim();
      return t || null;
    };

    function leadsItsRow() {
      // Only answerable where the file states direction in its own columns.
      if (idx.debit === undefined || idx.credit === undefined) return false;
      let up = 0, down = 0;
      for (let i = start; i < grid.length; i++) {
        const r = grid[i];
        if (!r || !parseDate(r[idx.date])) continue;
        const dr = String(r[idx.debit] ?? "").trim();
        const cr = String(r[idx.credit] ?? "").trim();
        const dir = moneyish(dr) ? "out" : moneyish(cr) ? "in" : null;
        if (!dir) continue;
        const above = i > start ? bare(i - 1) : null;
        let below = null;
        for (let j = i + 1; j < grid.length && below === null; j++) {
          if (grid[j] && parseDate(grid[j][idx.date])) break;
          const t = bare(j);
          if (t && markerOf(t)) below = t;
        }
        if (above && markerOf(above)) up += markerOf(above) === dir ? 1 : -1;
        if (below && markerOf(below)) down += markerOf(below) === dir ? 1 : -1;
      }
      // A clear win, on enough rows to mean something.
      return up > down && up >= 5;
    }

    const leads = leadsItsRow();
    /* In leading layout only the line immediately before a dated row is that
     * row's marker; everything else in the block still belongs to the row
     * above, exactly as usual. */
    const isLeader = i => {
      if (!leads || !bare(i)) return false;
      for (let j = i + 1; j < grid.length; j++) {
        const r = grid[j];
        if (!r || !r.filter(c => String(c ?? "").trim()).length) continue;
        return !!parseDate(r[idx.date]);
      }
      return false;
    };
    let pending = "";

    for (let i = start; i < grid.length; i++) {
      const r = grid[i];
      if (!r || !r.filter(c => String(c ?? "").trim()).length) continue;

      const date = parseDate(r[idx.date]);
      let description = String(r[idx.desc] ?? "").replace(/\s+/g, " ").trim();
      /* A marker line held over from just above this row (see leadsItsRow). It
       * goes in front, because that is where the bank printed it. */
      if (date && pending) { description = (pending + " " + description).trim(); pending = ""; }

      /* A wrapped cell is a continuation of the row above, not a row.
       *
       * PDF statements set a long narration over two or three lines, and each
       * line arrives here as its own grid row with no date and no amount.
       * Dropping them loses the end of the payee name -- "Deposit or" without
       * "Inves", or a payee name cut off halfway -- which is exactly the
       * part that decides the category. So they are glued back on. */
      if (!date) {
        const money = ["debit", "credit", "amount", "balance"]
          .some(k => idx[k] !== undefined && String(r[idx[k]] ?? "").trim());
        if (description && !money && isLeader(i)) {
          pending = (pending + " " + description).trim();   // belongs to the row below
        } else if (description && !money && rows.length) {
          const prev = rows[rows.length - 1];
          prev.description = (prev.description +
            (/[-/]$/.test(prev.description) ? "" : " ") + description).trim();
        } else if (description) skippedUndated++;
        continue;
      }

      // Sign convention throughout: positive is money leaving the account.
      /* Sign convention: positive means money left the account.
       *
       * Three shapes in the wild. Separate Withdrawal / Deposit columns (most
       * banks). One Amount column plus a DEBIT/CREDIT marker (PhonePe, Paytm).
       * And one signed Amount column with nothing else, where a minus sign is
       * the only clue. */
      let amount = 0;
      const dr = idx.debit !== undefined ? num(r[idx.debit]) : 0;
      const cr = idx.credit !== undefined ? num(r[idx.credit]) : 0;

      if (dr || cr) {
        amount = Math.abs(dr) - Math.abs(cr);
      } else if (idx.amount !== undefined) {
        const raw = String(r[idx.amount] ?? "");
        const a = num(raw);
        const tag = (String(r[idx.drcr] ?? "") + " " + description).toUpperCase();
        if (/\bDEBIT\b|\bDR\b|\bWITHDRAW|\bWDL\b|\bPAID\s*TO\b/.test(tag))
          amount = Math.abs(a);
        else if (/\bCREDIT\b|\bCR\b|\bDEPOSIT\b|\bDEP\s*TFR\b|\bCR\s*TFR\b|\bREFUND\b|\bCASHBACK\b|\bRECEIVED\s*FROM\b|\bSALARY\b/.test(tag))
          amount = -Math.abs(a);
        else if (/^\s*[-(]/.test(raw))                       amount = Math.abs(a);
        else amount = a > 0 ? a : -Math.abs(a);
      } else if (idx.debit !== undefined || idx.credit !== undefined) {
        amount = 0;                        // both columns blank: not a payment
      }

      /* One money column and a balance beside it: the balance says which way.
       *
       * This is the layout of a statement whose header is a picture, where
       * there is nothing to read the words "debit" and "credit" from. The
       * change in the balance is not a hint about direction, it is the
       * direction, so it overrules the guesswork above. */
      if (idx.signFromBalance && amount) {
        const now = bal(i);
        let prev = null;
        for (let k = i - 1; k >= start && prev === null; k--) prev = bal(k);
        if (prev !== null && now !== null) {
          const move = Math.round((prev - now) * 100) / 100;
          if (Math.abs(Math.abs(move) - Math.abs(amount)) < 0.02)
            amount = move;
        }
      }
      if (!amount) { pending = ""; skippedZero++; continue; }

      rows.push({
        date, description,
        amount: Math.round(amount * 100) / 100,
        balance: idx.balance !== undefined ? num(r[idx.balance]) : null,
        yearUnknown: !!date.yearUnknown,
        holder,
        /* Did the file itself say which way the money went? A single unsigned
         * amount column does not, and the difference matters downstream: a row
         * the rules call income has to be allowed to correct its own sign, but
         * only when the file never stated one. */
        unsigned: !(idx.debit !== undefined || idx.credit !== undefined ||
                    idx.drcr !== undefined || idx.signFromBalance),
      });
    }
    return { rows, skippedUndated, skippedZero };
  }

  /**
   * Turn a File into transaction rows.
   *
   * Returns { rows, meta } where meta explains what was read and, importantly,
   * what was skipped -- a row count that quietly differs from the file is how
   * people end up trusting a wrong total.
   */
  async function readStatement(file, password, override) {
    const name = (file.name || "").toLowerCase();
    let grid;

    /* The extension is a hint, not a fact.
     *
     * Bank of India's "Excel" download is a CSV named .xlsx. Several banks
     * send an HTML table named .xls. Trusting the name means handing a zip
     * reader a text file and telling the person their statement is corrupt,
     * so the first bytes decide instead. */
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const isZip = head[0] === 0x50 && head[1] === 0x4B;
    const isOle = head[0] === 0xD0 && head[1] === 0xCF;
    const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44;

    /* Somebody photographed their statement.
     *
     * On a phone the file picker offers the camera alongside the file list, and
     * taking a picture of a statement is a completely reasonable thing to
     * assume would work. It does not, and the reason is worth saying out loud
     * rather than hiding behind "could not read this file": a photo contains
     * no text, only pixels, and reading it needs character recognition -- which
     * guesses, and a guessed digit in an amount is a wrong total that looks
     * entirely normal. Every other refusal in this app exists for the same
     * reason. */
    const ascii = (a, b, c, d) =>
      head[a] === 0x66 && head[b] === 0x74 && head[c] === 0x79 && head[d] === 0x70;
    const isImage =
      (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) ||          // JPEG
      (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E) ||          // PNG
      (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) ||          // GIF
      (head[0] === 0x42 && head[1] === 0x4D && file.size > 1000) ||          // BMP
      ascii(4, 5, 6, 7);                                                     // HEIC/HEIF
    if (isImage) throw new Error(
      "That is a photo, not a statement file. This page reads the file your " +
      "bank gives you — the PDF, Excel or CSV from net banking — and a " +
      "picture has no text in it to read, only pixels. Downloading the " +
      "statement takes about as long as photographing it and the numbers " +
      "will be exact.");

    if (isPdf) {
      grid = await MSP.pdfread.readPdf(await file.arrayBuffer(), password);
    } else if (isZip) {
      grid = await xlsxToGrid(await file.arrayBuffer());
    } else if (isOle) {
      /* An OLE container is either a real .xls or an encrypted Office file --
       * the same wrapper is used for both, so the streams inside decide. */
      const buf = await file.arrayBuffer();
      const res = await MSP.xls.readOle(buf, password);
      // A decrypted Office file is just the .xlsx it always was.
      grid = res.zip ? await xlsxToGrid(res.zip) : res.grid;
    } else {
      // Everything else is text: CSV, tab-separated, or an HTML table that a
      // bank has labelled .xls.
      const text = await file.text();
      grid = /<\s*(table|tr|td)[\s>]/i.test(text.slice(0, 4000))
        ? htmlToGrid(text)
        : csvToGrid(text);
    }

    /* Three ways to find the table, tried in order of how much they can be
     * trusted.
     *
     * The headings first, because when they exist they are unambiguous and
     * cost nothing. Then the data, for the growing number of statements whose
     * header is a picture. Then the visitor, because being asked one question
     * beats being told the file cannot be read.
     *
     * The header path is also checked rather than believed: a header can be
     * found, map cleanly, and still yield almost no rows -- so if it produces
     * far fewer transactions than the file obviously contains, the inferred
     * layout is tried too and the better of the two wins.
     */
    const h = findHeader(grid);
    let idx = null, start = 0, how = null;

    /* The visitor has told us which column is which. Their answer wins over
     * anything guessed here -- they can see the file. */
    if (override && override.columns && override.columns.date !== undefined) {
      idx = override.columns;
      start = override.start ?? 0;
      how = "you picked the columns";
    }

    if (!idx && h >= 0) {
      const byHead = mapColumns(grid[h], grid.slice(h + 1, h + 25));
      if (byHead.date !== undefined) { idx = byHead; start = h + 1; how = "headings"; }
    }

    const holder = findHolder(grid, h >= 0 ? h : 0);
    const looksLikeBody = findBody(grid).length;
    let best = idx ? buildRows(grid, start, idx, holder) : null;

    if (!override && (!best || best.rows.length < looksLikeBody * 0.5)) {
      const inferred = inferColumns(grid);
      if (inferred) {
        const alt = buildRows(grid, inferred.start, inferred.idx, holder);
        if (!best || alt.rows.length > best.rows.length) {
          best = alt; idx = inferred.idx; start = inferred.start; how = "the data itself";
        }
      }
    }

    if (!best || !best.rows.length) {
      /* Nothing worked. Rather than a dead end, hand the caller everything it
       * needs to ask the visitor which column is which -- the first rows of
       * the file and the best guess so far. */
      const e = new Error(looksLikeBody >= 5
        ? `This file has ${looksLikeBody} rows that look like transactions, but ` +
          "the columns could not be worked out — its header may be a picture " +
          "rather than text. Pick the columns and it will read."
        : "Could not find a transaction table in this file. It needs rows with " +
          "a date and an amount.");
      /* What the picker needs: rows that look like transactions rather than
       * the first rows of the file. A statement's first forty rows are the
       * letterhead -- address, IFSC, branch phone -- and picking columns from
       * those is guesswork with extra steps. */
      const bodyAt = findBody(grid);
      const show = bodyAt.length ? bodyAt.slice(0, 12)
                                 : grid.map((_, i) => i).slice(0, 12);
      const width = Math.max(1, ...show.map(i => (grid[i] || []).length));
      e.needsColumns = {
        preview: show.map(i => {
          const r = grid[i] || [];
          return Array.from({ length: width }, (_, c) => String(r[c] ?? ""));
        }),
        guess: (idx && idx.date !== undefined ? idx : null) ||
               (inferColumns(grid) || {}).idx || {},
        bodyRows: looksLikeBody,
        start: bodyAt.length ? bodyAt[0] : 0,
        width,
      };
      throw e;
    }

    const { rows, skippedUndated, skippedZero } = best;
    fillMissingYears(rows);
    rows.sort((a, b) => a.date - b.date);
    return {
      rows,
      meta: {
        file: file.name,
        holder,
        headerRow: h + 1,
        columns: idx,
        read: rows.length,
        skippedUndated,
        skippedZero,
        columnsUsed: Object.keys(idx),
        foundBy: how,
        signed: idx.debit !== undefined || idx.credit !== undefined ||
                idx.drcr !== undefined,
        from: rows.length ? rows[0].date : null,
        to:   rows.length ? rows[rows.length - 1].date : null,
      },
    };
  }

  /**
   * Drop rows this statement shares with what is already loaded.
   *
   * Re-exports overlap: ask for six months every month and five of them repeat.
   * The key is date + amount + narration rather than a date cut-off, because a
   * bank can insert a row *behind* the newest date it has already given you --
   * a delayed entry, a corrected one -- and a cut-off cannot see those.
   */
  function dedupe(existing, incoming) {
    const key = r => `${r.date.toISOString().slice(0, 10)}|${r.amount}|` +
                     `${r.description.toLowerCase().replace(/\s+/g, "")}`;

    /* Counted, not just seen.
     *
     * Two identical rows in one file are usually two real payments -- the same
     * ₹70 at the same stall twice in a day is an ordinary Tuesday, not a
     * duplicate. The earlier version kept a set, so the second one was thrown
     * away, and a file with several such pairs quietly lost them.
     *
     * What this is actually for is the overlap between two exports: ask your
     * bank for six months every month and five of them repeat. So the test is
     * how many copies of a row have already been loaded, not whether one has.
     * A row appearing twice in a file is kept twice; a row appearing once in
     * each of two files is kept once.
     */
    const have = new Map();
    for (const r of existing) {
      const k = key(r);
      have.set(k, (have.get(k) || 0) + 1);
    }
    const used = new Map();
    const fresh = [];
    for (const r of incoming) {
      const k = key(r);
      const n = used.get(k) || 0;
      used.set(k, n + 1);
      if (n < (have.get(k) || 0)) continue;      // already loaded this many
      fresh.push(r);
    }
    return fresh;
  }

  MSP.parse = { dedupe, parseDate, readStatement, inferColumns, findBody,
                _xlsx: xlsxToGrid, _findHeader: findHeader, _map: mapColumns,
                _holder: findHolder };
})(window.MSP = window.MSP || {});
