/*
 * Pulling the text out of a PDF bank statement, in the browser, with no
 * library.
 *
 * pdf.js is the usual answer and it is excellent, but it is well over a
 * megabyte -- more than five times the size of this entire app -- to solve a
 * problem this narrow. A bank statement PDF is a table of text at known
 * positions; none of the rendering, font hinting, image or annotation
 * machinery that makes pdf.js big is needed to read one.
 *
 * How this works. A PDF is a set of numbered objects, most of them compressed
 * with Deflate. Rather than walking the cross-reference table -- which has
 * several formats and is genuinely often broken in files produced by report
 * generators -- this scans for every stream, inflates it with the browser's
 * own DecompressionStream, and reads the text-drawing operators:
 *
 *     (Some text) Tj            draw a string
 *     [(kerned) -20 (text)] TJ  draw an array of pieces
 *     x y Td  /  a b c d e f Tm move the cursor
 *     /F1 10 Tf                 choose a font
 *
 * Two things separate working from gibberish. Text is grouped by its
 * y-coordinate into lines and by x-gaps into columns, which turns a bag of
 * fragments back into a table. And glyph codes are translated through the
 * font's ToUnicode table -- PDFs subset their fonts, so the bytes on the page
 * are glyph numbers, and only that table knows <01> is an "S".
 *
 * Deliberately not supported, each with a clear message rather than a wrong
 * answer:
 *
 *   * Password-protected PDFs. Most Indian banks email these locked with your
 *     date of birth or PAN. Decryption needs RC4 and AES key derivation;
 *     rather than half-implement that, the app explains how to save an
 *     unlocked copy, which every PDF reader can do in two clicks.
 *   * Scanned PDFs. A photograph of a statement contains no text at all, only
 *     pixels. Reading it needs OCR, which is a different project.
 */
(function (MSP) {
  "use strict";

  /**
   * Bytes -> a string where character N is byte N, exactly.
   *
   * NOT `new TextDecoder("latin1")`. That label is an alias for windows-1252
   * in the encoding standard, which remaps bytes 0x80-0x9F to other code
   * points -- so 0x86 comes back as U+2020 and `charCodeAt() & 255` gives 0x20.
   * String length is preserved, so offsets still work and the damage is
   * invisible in ordinary text; it only shows up in binary fields. It cost an
   * afternoon here: the /U value in an encrypted PDF came back one byte wrong
   * and every correct password was rejected.
   */
  function asText(u8) {
    let out = "";
    for (let i = 0; i < u8.length; i += 8192)
      out += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    return out;
  }

  async function inflate(bytes) {
    /* The byte range between "stream" and "endstream" includes the newline
     * that separates them, and DecompressionStream is strict: one extra byte
     * and it throws "Trailing junk found after the end of the compressed
     * stream" and the whole PDF reads as empty. So the tail is trimmed, and if
     * that still fails the last few bytes are dropped one at a time -- some
     * writers pad the stream to an even length.
     *
     * Most PDF streams are zlib ("deflate"); a few are raw. Both are tried. */
    let end = bytes.length;
    while (end > 0 && (bytes[end - 1] === 0x0A || bytes[end - 1] === 0x0D ||
                       bytes[end - 1] === 0x20)) end--;

    /* The whole buffer is tried before any trimmed version.
     *
     * Compressed bytes are arbitrary, so the last byte of a perfectly good
     * deflate stream is 0x0A once every 256 streams -- and trimming it first
     * threw away page 19 of a 49-page statement, taking a day of transactions
     * with it and leaving the running balance adrift by four figures, with
     * nothing on screen to say so. A deflate stream states its own end, so a full-length decode
     * that succeeds is proof the length was right; trimming is only ever a
     * fallback for a stream whose end had to be guessed. */
    const ends = [];
    for (const e of [bytes.length, end, end - 1, end - 2])
      if (e > 0 && !ends.includes(e)) ends.push(e);

    for (const e of ends) {
      const slice = bytes.subarray(0, e);
      for (const fmt of ["deflate", "deflate-raw"]) {
        try {
          const s = new Blob([slice]).stream()
            .pipeThrough(new DecompressionStream(fmt));
          return new Uint8Array(await new Response(s).arrayBuffer());
        } catch { /* try the other format, then a shorter slice */ }
      }
    }
    return null;
  }

  /** Control codes a font uses for a space, normalised to a real space. */
  const tidyText = t =>
    t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u0080-\u009f\u00a0\u2007\u202f]/g, " ");

  /** Undo the escaping inside a ( … ) literal string. */
  function unescapePdf(s) {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== "\\") { out += c; continue; }
      const n = s[++i];
      if (n === undefined) break;
      if (n === "n") out += "\n";
      else if (n === "r") out += "\r";
      else if (n === "t") out += "\t";
      else if (n === "b" || n === "f") out += " ";
      else if (n >= "0" && n <= "7") {              // octal escape
        let oct = n;
        while (oct.length < 3 && s[i + 1] >= "0" && s[i + 1] <= "7") oct += s[++i];
        out += String.fromCharCode(parseInt(oct, 8));
      } else out += n;                              // \( \) \\ and the rest
    }
    return tidyText(out);
  }

  /**
   * Decode a <hex> string.
   *
   * With a ToUnicode map the bytes are glyph codes in a subset font, and only
   * the map knows which letter each one is. Without a map the convention is
   * UTF-16BE. Choosing wrong is the difference between "SWIGGY" and a row of
   * control characters.
   */
  function hexToText(h, map) {
    // A glyph table sometimes maps the space to a control code rather than
    // 0x20. Anything below a printable character is whitespace here.
    const tidy = tidyText;
    const clean = h.replace(/[^0-9a-fA-F]/g, "");
    let out = "";
    if (map && map.size) {
      /* One byte per glyph or two?
       *
       * A subset font numbers its glyphs from 1, so its codes are small. An
       * Identity-encoded font uses the real glyph ids and its codes run into
       * the thousands. Reading a two-byte font one byte at a time produces
       * plausible-looking rubbish rather than an obvious failure, so the map
       * itself is asked which it is. */
      if (map.wide === undefined) {
        let max = 0;
        for (const k of map.keys()) if (k > max) max = k;
        map.wide = max > 255;
      }
      if (map.wide) {
        for (let i = 0; i + 3 < clean.length; i += 4)
          out += map.get(parseInt(clean.substr(i, 4), 16)) ?? "";
        if (out.trim()) return tidy(out);
        out = "";
      }
      for (let i = 0; i + 1 < clean.length; i += 2)
        out += map.get(parseInt(clean.substr(i, 2), 16)) ?? "";
      if (out.trim()) return tidy(out);
      out = "";                                     // maybe a two-byte map
      for (let i = 0; i + 3 < clean.length; i += 4)
        out += map.get(parseInt(clean.substr(i, 4), 16)) ?? "";
      if (out.trim()) return tidy(out);
    }
    out = "";
    for (let i = 0; i + 3 < clean.length; i += 4) {
      const code = parseInt(clean.substr(i, 4), 16);
      if (code) out += String.fromCharCode(code);
    }
    if (!out.trim()) {
      out = "";
      for (let i = 0; i + 1 < clean.length; i += 2)
        out += String.fromCharCode(parseInt(clean.substr(i, 2), 16));
    }
    return tidy(out);
  }

  /**
   * Parse a ToUnicode CMap -- the table saying which letter each glyph is.
   *
   *     3 beginbfchar  <01> <0053>              endbfchar
   *     1 beginbfrange <10> <19> <0030>         endbfrange
   *     1 beginbfrange <20> <22> [<41><42><43>] endbfrange
   */
  function parseCMap(text) {
    const map = new Map();
    const chr = h => String.fromCharCode(
      ...(h.match(/.{1,4}/g) || []).map(x => parseInt(x, 16)).filter(Boolean));

    for (const blk of text.match(/beginbfchar[\s\S]*?endbfchar/g) || []) {
      const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let m;
      while ((m = re.exec(blk))) map.set(parseInt(m[1], 16), chr(m[2]));
    }
    for (const blk of text.match(/beginbfrange[\s\S]*?endbfrange/g) || []) {
      const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g;
      let m;
      while ((m = re.exec(blk))) {
        const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
        if (m[3]) {
          const base = parseInt(m[3], 16);
          for (let c = lo; c <= hi && c - lo < 65536; c++)
            map.set(c, String.fromCharCode(base + (c - lo)));
        } else if (m[4]) {
          (m[4].match(/<[0-9A-Fa-f]+>/g) || []).forEach(
            (it, i) => map.set(lo + i, chr(it.slice(1, -1))));
        }
      }
    }
    return map;
  }

  /**
   * Read the text-showing operators out of one content stream.
   * Returns [{ x, y, text }] in the order they were drawn.
   */
  function extractPieces(content, fontMaps, fallbackMap) {
    const pieces = [];
    let x = 0, y = 0, leading = 0, font = null, size = 10;
    let stack = [];                     // operands waiting for their operator

    const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\[[^\]]*\]|[-+]?[\d.]+|\/[^\s/<>\[\]()]+|[A-Za-z'"*]+/g;
    let m;
    while ((m = re.exec(content))) {
      const tok = m[0];
      if (/^[-+]?[\d.]+$/.test(tok)) { stack.push(parseFloat(tok)); continue; }
      if ("(<[/".includes(tok[0])) { stack.push(tok); continue; }

      switch (tok) {
        case "Td": case "TD": {
          const ty = stack.pop(), tx = stack.pop();
          if (typeof tx === "number") x += tx;
          if (typeof ty === "number") y += ty;
          if (tok === "TD" && typeof ty === "number") leading = -ty;
          break;
        }
        case "Tm": {                    // full matrix; e and f are the position
          const f = stack.pop(), e = stack.pop();
          stack.pop(); stack.pop(); stack.pop(); stack.pop();
          if (typeof e === "number") x = e;
          if (typeof f === "number") y = f;
          break;
        }
        case "TL": { const l = stack.pop(); if (typeof l === "number") leading = l; break; }
        case "T*": y -= leading; break;
        case "BT": x = 0; y = 0; break;
        case "Tf": {                    // "/F1 10 Tf" -- size on top, name under
          const sz = stack.pop();
          if (typeof sz === "number" && sz > 0) size = sz;
          const name = stack.pop();
          if (typeof name === "string" && name[0] === "/")
            font = (fontMaps && fontMaps.get(name.slice(1))) || fallbackMap || null;
          break;
        }
        case "Tj": case "'": case '"': {
          const s = stack.pop();
          if (tok !== "Tj") y -= leading;
          if (typeof s === "string" && s[0] === "(")
            pieces.push({ x, y, size, text: unescapePdf(s.slice(1, -1)) });
          else if (typeof s === "string" && s[0] === "<")
            pieces.push({ x, y, size, text: hexToText(s, font) });
          break;
        }
        case "TJ": {
          const arr = stack.pop();
          if (typeof arr === "string" && arr[0] === "[") {
            let out = "";
            const inner = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|[-+]?[\d.]+/g;
            let im;
            while ((im = inner.exec(arr))) {
              const t = im[0];
              if (t[0] === "(") out += unescapePdf(t.slice(1, -1));
              else if (t[0] === "<") out += hexToText(t, font);
              // A large negative kern is how a PDF draws the space between two
              // words in separate runs. Without this, "SWIGGY BANGALORE"
              // extracts as "SWIGGYBANGALORE".
              else if (parseFloat(t) < -120) out += " ";
            }
            if (out) pieces.push({ x, y, size, text: out });
          }
          break;
        }
        default: break;
      }
      stack = [];
    }
    return pieces;
  }

  /**
   * Fragments -> rows of cells.
   *
   * Everything drawn at about the same height is one line; within a line, a
   * horizontal gap wide enough to be deliberate starts a new column. A PDF has
   * no cells, only text at coordinates, so the grid has to be inferred.
   */
  function piecesToRows(pieces) {
    if (!pieces.length) return [];
    const use = pieces.filter(p => p.text.trim());
    if (!use.length) return [];

    /* Group text into table rows.
     *
     * A fixed tolerance does not work. When a cell wraps -- a long UPI
     * narration, or a date broken as "28-01-" / "2026" -- one table row is
     * drawn as two or three lines of text, and grouping only exactly-equal
     * heights splits that row apart, losing the date from the transaction.
     *
     * But the two spacings are quite different and the file tells you what
     * they are: in a real statement the lines inside a row sit about 10pt
     * apart while the rows themselves are 30pt apart. So the gaps between
     * consecutive heights are measured, the biggest jump in that sorted list
     * is found, and the midpoint of the jump becomes the threshold. No
     * constant to guess, and it adapts to the font size of the document.
     */
    const ys = [...new Set(use.map(p => Math.round(p.y * 10) / 10))]
      .sort((a, b) => b - a);
    const gaps = [];
    for (let i = 1; i < ys.length; i++) gaps.push(ys[i - 1] - ys[i]);

    let threshold = 3;
    if (gaps.length > 2) {
      const sorted = [...gaps].sort((a, b) => a - b);
      let bestJump = 0, at = -1;
      /* Ignore both tails. A title block leaves one unusually small gap at the
       * bottom of the list, and the joins between stacked pages leave a few
       * enormous ones at the top; either can drag the split point to a
       * meaningless place and collapse every row into one. */
      const lo = Math.floor(sorted.length * 0.1);
      const hi = Math.max(lo + 1, Math.floor(sorted.length * 0.9));
      for (let i = lo; i < hi && i < sorted.length - 1; i++) {
        const jump = sorted[i + 1] - sorted[i];
        if (jump > bestJump) { bestJump = jump; at = i; }
      }
      if (at >= 0 && bestJump > 3) threshold = (sorted[at] + sorted[at + 1]) / 2;
    }

    const rowsOfY = [];
    let cur = [ys[0]];
    for (let i = 1; i < ys.length; i++) {
      if (ys[i - 1] - ys[i] <= threshold) cur.push(ys[i]);
      else { rowsOfY.push(cur); cur = [ys[i]]; }
    }
    rowsOfY.push(cur);

    const bandOf = new Map();
    rowsOfY.forEach((band, i) => band.forEach(y => bandOf.set(y, i)));
    const lines = rowsOfY.map(() => []);
    for (const p of use) lines[bandOf.get(Math.round(p.y * 10) / 10)].push(p);

    /* Work out where the columns are, once, for the whole page.
     *
     * Splitting each row independently on "is there a wide gap here" does not
     * work: when a cell is empty -- a credit row has no withdrawal amount --
     * that row comes back one cell short and every value after it shifts left
     * into the wrong column. A credit then reads as a debit, which is the
     * worst kind of wrong: plausible, and silent.
     *
     * So the x-positions where text starts are collected across the whole page
     * and clustered. A position two or more rows share is a column edge; each
     * row's text is then placed into that fixed grid, with empty strings where
     * a cell has nothing in it.
     */
    /* Merge each line's pieces into runs of touching text.
     *
     * Some PDFs draw one glyph at a time, each separately positioned. Treating
     * every glyph start as a possible column edge invents a column between
     * every pair of letters, and a payee arrives split across three cells.
     *
     * The trick is knowing when that is happening. Estimating character widths
     * from the font size is not reliable enough -- it merged words that should
     * have stayed apart in ordinary documents. Instead each line is asked
     * whether its pieces are glyphs or words: if the typical piece is one or
     * two characters long, the gaps between piece positions are measured and
     * compared with the line's own typical gap. A gap much wider than the
     * character pitch is a space; wider still is a new cell. Lines that
     * already contain whole words are left exactly as they are.
     */
    const median = a => {
      if (!a.length) return 0;
      const b = [...a].sort((x, y) => x - y);
      return b[b.length >> 1];
    };

    /* Measured character widths, gathered across the whole document.
     *
     * Keyed by character and expressed as a fraction of the font size, so one
     * table serves every size on the page. Only pairs of single-glyph pieces
     * on the same line count, because those are the ones whose spacing is the
     * glyph's own advance rather than a layout decision. */
    const widths = new Map();
    for (const line of lines) {
      const row = [...line].sort((a, b) => a.x - b.x);
      for (let i = 1; i < row.length; i++) {
        const a = row[i - 1], b = row[i];
        if (a.text.length !== 1 || !a.size) continue;
        const rel = (b.x - a.x) / a.size;
        if (rel <= 0 || rel > 2) continue;          // a gap, not an advance
        if (!widths.has(a.text)) widths.set(a.text, []);
        widths.get(a.text).push(rel);
      }
    }
    const widthCache = new Map();
    const widthOf = (ch, size) => {
      if (!widthCache.has(ch)) {
        const list = widths.get(ch);
        /* A low percentile, not the median.
         *
         * The advances measured after a letter are a mixture: the letter's own
         * width when the next glyph follows it directly, and that width plus a
         * space when it does not. The median of the mixture sits between the
         * two, so with it every gap looks normal and no space is ever
         * detected -- "Paid to Amazon India" came back as "PaidtoAmazonIndia".
         * The letter's true width is the small end of the mixture, which is
         * what a low percentile picks out. */
        let v = null;
        if (list && list.length >= 4) {
          const sorted = [...list].sort((a, b) => a - b);
          v = sorted[Math.floor(sorted.length * 0.2)];
        }
        widthCache.set(ch, v);
      }
      const rel = widthCache.get(ch);
      return rel == null ? null : rel * (size || 10);
    };

    const runsPerLine = lines.map(line => {
      const sorted = line.sort((a, b) => (b.y - a.y) || (a.x - b.x));
      const glyphy = sorted.length > 6 &&
        median(sorted.map(p => p.text.length)) <= 2;
      if (!glyphy)
        return sorted.map(p => ({ x: p.x, text: p.text, size: p.size }));

      const deltas = [];
      for (let i = 1; i < sorted.length; i++) {
        const d = sorted[i].x - sorted[i - 1].x;
        if (d > 0.5) deltas.push(d);
      }
      const pitch = median(deltas) || 6;

      /* How wide is the letter we just drew?
       *
       * Comparing every gap to one median pitch for the line treats "M" and
       * "i" as the same width, so the space after a wide letter looks like a
       * word break. That is not a cosmetic problem. "May31,2026" came out as
       * "M ay31,2026", stopped matching the date pattern, and every May
       * transaction in a 99-page statement -- 170 of them, 22% of the file --
       * was silently dropped while every other month came through perfectly.
       * Merchant names suffered the same way: "SW IGGY", "LIM ITED".
       *
       * The fix needs no font metrics. A PDF places each glyph at an explicit
       * position, so the distance from an "M" to whatever follows it *is* the
       * width of "M", measured over and over on every page. widthOf() is that
       * measurement, taken from the document itself and keyed by character.
       */
      const runs = [{ x: sorted[0].x, text: sorted[0].text, size: sorted[0].size }];
      for (let i = 1; i < sorted.length; i++) {
        const d = sorted[i].x - sorted[i - 1].x;
        const prev = sorted[i - 1];
        /* The line's median pitch decides a space, as before -- it is a good
         * judge for ordinary letters and this reader ran on it for a long
         * time. The measured width is used only to veto: a gap that is no
         * wider than the letter that made it cannot be a space, however it
         * compares to the median. That single veto is what stops a capital M
         * from splitting "May" into "M ay". */
        const w = widthOf(prev.text.slice(-1), prev.size) || 0;
        if (d > Math.max(pitch * 3.2, w * 2.4))
          runs.push({ x: sorted[i].x, text: sorted[i].text, size: sorted[i].size });
        else runs[runs.length - 1].text +=
          (d > pitch * 1.22 && d > w * 1.12 ? " " : "") + sorted[i].text;
      }
      return runs;
    });

    /* Let the transactions define the columns, not the letterhead.
     *
     * Everything drawn on the page is text at an x-position, and the block at
     * the top -- account holder, address, IFSC, branch -- has its own strong
     * alignments that have nothing to do with the table. Those alignments
     * become columns, and a heading like "Debit", which sits well to the left
     * of the right-aligned figures it names, then lands in the letterhead's
     * column instead of its own. The table ends up with a Debit heading over
     * nothing and a nameless column full of debits.
     *
     * So the columns are measured from the transaction lines alone -- the ones
     * carrying both a date and a figure -- and every other line is then fitted
     * into that grid. The page furniture no longer gets a vote on where the
     * table's columns are, which is right: it is not part of the table.
     */
    const looksDate = t =>
      /(^|\s)(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[-\s][A-Za-z]{3,9}[-\s]\d{2,4})/
        .test(t);
    const looksNum = t => /^[₹\s]*-?[\d,]+\.\d{2}\s*(cr|dr)?$/i.test(t.trim());
    const bodyBands = new Set();
    runsPerLine.forEach((runs, band) => {
      if (runs.some(r => looksDate(r.text)) && runs.some(r => looksNum(r.text)))
        bodyBands.add(band);
    });
    const fromBody = bodyBands.size >= 5;

    const marks = [];
    runsPerLine.forEach((runs, band) => {
      if (fromBody && !bodyBands.has(band)) return;
      runs.forEach(r => marks.push({ x: r.x, band }));
    });
    marks.sort((a, b) => a.x - b.x);

    const edges = [];
    let run = [marks[0]];
    for (let i = 1; i <= marks.length; i++) {
      if (i < marks.length && marks[i].x - run[run.length - 1].x <= 6) {
        run.push(marks[i]);
      } else {
        /* A cluster counts as a column only if it appears on two or more
         * separate rows.
         *
         * Two on the same row is not evidence of a column -- the address block
         * in a letterhead has several pieces side by side, and each of them was
         * inventing a column that then pulled the real headings out of
         * alignment with their own data.
         *
         * Two *rows* is the right floor, though, not a percentage: a column
         * carrying a value on only two rows -- salary credits, say -- is still
         * a column, and folding it into its neighbour turns income into
         * spending. */
        if (new Set(run.map(r => r.band)).size >= 2)
          edges.push(run.reduce((a, b) => a + b.x, 0) / run.length);
        run = [marks[i]];
      }
    }
    if (!edges.length) edges.push(marks[0].x);

    /* Nearest edge, not "the last edge to the left of this".
     *
     * Header cells are often centred over a column whose data is left-aligned,
     * so "Narration" can start 100pt to the right of the narrations beneath
     * it. Snapping to the left-hand edge put the heading in one column and its
     * own data in another -- and the header row is what names the columns, so
     * every description came back empty. */
    const colOf = x => {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < edges.length; i++) {
        const d = Math.abs(x - edges[i]);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    };

    const out = [];
    const lefts  = edges.map(() => []);     // where each column's text starts
    const rights = edges.map(() => []);     // where each column's text *ends*
    /* Only the transaction lines are consulted when deciding what a column
     * looks like. The letterhead is squeezed into the table's grid too --
     * harmless, since those rows carry no date and are skipped later -- but if
     * "Branch Name:" is allowed to count as one of the debit column's values
     * then the column stops looking numeric and never gets repaired. */
    const body = [];
    runsPerLine.forEach((runs, band) => {
      const cells = new Array(edges.length).fill("");
      const isBody = !fromBody || bodyBands.has(band);
      for (const r of runs) {
        const c = colOf(r.x);
        // "28-01-" + "2026" is one date split over two lines of a wrapped
        // cell, so those join with nothing; anything else gets a space.
        const glue = !cells[c] ? ""
          : (/[-/.]$/.test(cells[c]) || /^[-/.]/.test(r.text)) ? "" : " ";
        cells[c] += glue + r.text;
        if (isBody) {
          lefts[c].push(r.x);
          rights[c].push(r.x + (r.size || 10) * 0.5 * r.text.length);
        }
      }
      if (cells.some(c => c.trim())) {
        out.push(cells.map(c => c.trim()));
        body.push(isBody);
      }
    });
    const bodyRows = out.filter((_, k) => body[k]);

    /* Put right-aligned money back into one column.
     *
     * Everything above clusters on where text *starts*, which is right for
     * words and wrong for figures. "6,000.00" and "125,000.00" in the same
     * withdrawal column begin four points apart and end at the same place, so
     * left-clustering splits one column into two or three. mapColumns then
     * finds a "Debit" heading above a column holding a third of the debits,
     * and two thirds of the file is silently dropped -- which is exactly what
     * reduced a 41-row statement to 3.
     *
     * So adjacent columns are folded together when all three hold: both are
     * numeric, they end at the same x, and no single row has a value in both.
     * That last condition is the safeguard that keeps Debit and Credit apart
     * -- they are two genuine columns, and rows exist with a figure in each.
     */
    const isNum = s => /^[₹\s]*-?[\d,]+(\.\d+)?\s*(cr|dr)?$/i.test(s.trim());
    const numeric = i => {
      const vals = bodyRows.map(r => r[i]).filter(v => v && v.trim());
      const n = vals.filter(isNum).length;
      // One stray non-number is allowed: the column heading sits in the same
      // column as the figures whenever the heading is right-aligned too, and
      // insisting on a pure column of digits is what stops "Credit" and its
      // own overflow column from being recognised as one thing.
      return n >= 2 && n >= vals.length - 1;
    };
    const group = edges.map((_, i) => i);
    for (let i = 1; i < edges.length; i++) {
      const a = group[i - 1];
      if (!numeric(a) || !numeric(i)) continue;
      if (Math.abs(median(rights[a]) - median(rights[i])) > 6) continue;
      if (bodyRows.some(r => r[a] && r[a].trim() && r[i] && r[i].trim())) continue;
      group[i] = a;
      for (const r of out) if (r[i]) { r[a] = r[i]; r[i] = ""; }
      lefts[a]  = lefts[a].concat(lefts[i]);
      rights[a] = rights[a].concat(rights[i]);
    }

    /* Put a centred heading back over the figures it names.
     *
     * The same right-alignment causes a second, quieter failure. "Debit" is
     * centred over its column while the amounts under it are right-aligned, so
     * the heading starts well to the left of every figure and lands in the
     * column before. The table then has a Debit heading over an empty column
     * and a nameless column full of debits -- and a nameless column is a
     * dropped column.
     *
     * The test is geometric rather than a guess: a lone piece of text with no
     * column of its own, whose centre falls inside the horizontal span of the
     * numbers immediately to its right, is that column's heading.
     */
    const span = i => [Math.min(...lefts[i]), Math.max(...rights[i])];
    for (let i = 0; i < edges.length - 1; i++) {
      const j = i + 1;
      if (group[i] !== i || group[j] !== j) continue;
      const mine = out.map(r => r[i]).filter(v => v && v.trim());
      if (mine.length !== 1 || isNum(mine[0]) || !numeric(j)) continue;
      const [l, r] = span(j), c = (Math.min(...lefts[i]) + Math.max(...rights[i])) / 2;
      if (c < l - 2 || c > r + 2) continue;
      if (out.some(row => row[i] && row[i].trim() && row[j] && row[j].trim())) continue;
      for (const row of out) if (row[i]) { row[j] = row[i]; row[i] = ""; }
    }

    // A column nothing ever landed in is noise from the page furniture; drop
    // it so the header and the data line up on the same indices.
    const used = edges.map((_, i) => out.some(r => r[i]));
    return out.map(r => r.filter((_, i) => used[i]));
  }

  /**
   * Read the /Encrypt dictionary and derive the file key.
   * Returns { decrypt } or null when the password is wrong.
   */
  async function setupDecryption(text, u8, password) {
    const ref = /\/Encrypt\s+(\d+)\s+\d+\s+R/.exec(text);
    if (!ref) return null;
    const objRe = new RegExp("(?:^|[^0-9])" + ref[1] + "\\s+\\d+\\s+obj([\\s\\S]{0,900}?)endobj");
    const om = objRe.exec(text);
    if (!om) return null;
    const d = om[1];

    // A PDF literal string: ( … ) with backslash escapes, holding raw bytes.
    const litBytes = str => {
      const out = [];
      for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (c !== "\\") { out.push(str.charCodeAt(i) & 255); continue; }
        const n = str[++i];
        if (n === "n") out.push(10);
        else if (n === "r") out.push(13);
        else if (n === "t") out.push(9);
        else if (n === "b") out.push(8);
        else if (n === "f") out.push(12);
        else if (n >= "0" && n <= "7") {
          let oct = n;
          while (oct.length < 3 && str[i + 1] >= "0" && str[i + 1] <= "7") oct += str[++i];
          out.push(parseInt(oct, 8) & 255);
        } else out.push(str.charCodeAt(i) & 255);
      }
      return new Uint8Array(out);
    };
    const grab = name => {
      const lit = new RegExp("/" + name + "\\s*\\(((?:\\\\.|[^\\\\()])*)\\)").exec(d);
      if (lit) return litBytes(lit[1]);
      const hex = new RegExp("/" + name + "\\s*<([0-9A-Fa-f\\s]*)>").exec(d);
      if (hex) {
        const clean = hex[1].replace(/[^0-9A-Fa-f]/g, "");
        const out = new Uint8Array(clean.length >> 1);
        for (let i = 0; i < out.length; i++)
          out[i] = parseInt(clean.substr(i * 2, 2), 16);
        return out;
      }
      return new Uint8Array(0);
    };

    const numOf = (name, dflt) => {
      const m = new RegExp("/" + name + "\\s+(-?\\d+)").exec(d);
      return m ? +m[1] : dflt;
    };
    /* Key length, which the format states in two different units.
     *
     * The encryption dictionary gives /Length in BITS (128). A crypt filter
     * inside the same dictionary gives its own /Length in BYTES (16) -- and it
     * appears first, so a naive search finds 16 and builds a two-byte key.
     * Every correct password is then rejected, which is exactly what happened
     * with a real Bank of India statement. Anything small enough to be a byte
     * count is treated as one. */
    const keyBits = (() => {
      const all = [...d.matchAll(/\/Length\s+(\d+)/g)].map(m => +m[1]);
      const big = all.filter(v => v > 64);
      if (big.length) return big[big.length - 1];
      return all.length ? all[all.length - 1] * 8 : 40;
    })();
    const cfmM = /\/CFM\s*\/(\w+)/.exec(d);
    const dict = {
      R: numOf("R", 4), V: numOf("V", 2), P: numOf("P", -1),
      lengthBits: keyBits,
      encryptMetadata: !/\/EncryptMetadata\s+false/.test(d),
      O: grab("O"), U: grab("U"), OE: grab("OE"), UE: grab("UE"),
    };
    const cfm = cfmM ? cfmM[1] : (dict.V >= 5 ? "AESV3" : "V2");

    // The first element of /ID goes into the key.
    const idm = /\/ID\s*\[\s*<([0-9A-Fa-f\s]*)>/.exec(text);
    let idBytes = new Uint8Array(0);
    if (idm) {
      const clean = idm[1].replace(/[^0-9A-Fa-f]/g, "");
      idBytes = new Uint8Array(clean.length >> 1);
      for (let i = 0; i < idBytes.length; i++)
        idBytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    }

    const key = await MSP.crypto.pdfFileKey(dict, idBytes, password);
    if (!key) return null;
    return {
      decrypt: (num, gen, data) =>
        MSP.crypto.pdfDecrypt(key, num, gen, data, cfm, dict.R),
    };
  }

  /** A PDF file -> a grid of rows, for the same header detection as the rest. */
  async function readPdf(buf, password) {
    const u8 = new Uint8Array(buf);
    const text = asText(u8);

    if (!text.startsWith("%PDF")) throw new Error("this is not a PDF file");

    /* Locked files.
     *
     * Banks nearly always send statements encrypted -- and often with an empty
     * user password, where the lock only stops printing and the document
     * itself opens fine. So an empty password is tried first, silently; only
     * if that fails is the person asked for one. */
    let crypt = null;
    if (/\/Encrypt[\s\d]/.test(text)) {
      crypt = await setupDecryption(text, u8, password || "");
      if (!crypt) {
        const err = new Error(password
          ? "That password did not open the file. Bank statements usually use "
          + "your date of birth as DDMMYYYY, your PAN in capitals, or your "
          + "customer ID — check the email the statement came in."
          : "This statement is password-protected.");
        err.needsPassword = true;
        throw err;
      }
    }

    /* Inflate every stream and keep them all before reading any: a font's
     * ToUnicode table often sits after the page that uses it, and the content
     * is unreadable without it.
     *
     * The leading [^a-zA-Z] is load-bearing. Without it the search also matches
     * the "stream" inside "endstream", which yields garbage ranges spanning
     * half the file. */
    /* Where every object starts, so a stream can be attributed to the right
     * one. Looking back a fixed number of characters from each "stream" was
     * close enough for a plain file and wrong for an encrypted one: the
     * per-object key is built from the object number, so attributing a stream
     * to its neighbour decrypts it to noise. */
    const objAt = [];
    for (const om of text.matchAll(/(?:^|[^0-9])(\d+)\s+(\d+)\s+obj\b/g))
      objAt.push({ pos: om.index, num: +om[1], gen: +om[2] });
    const ownerOf = pos => {
      let lo = 0, hi = objAt.length - 1, best = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (objAt[mid].pos <= pos) { best = objAt[mid]; lo = mid + 1; }
        else hi = mid - 1;
      }
      return best;
    };

    /* Every object's declared length, so a stream's end is known rather than
     * guessed.
     *
     * Searching for the next "endstream" works on a plain file and fails on an
     * encrypted one: ciphertext is arbitrary bytes, and sooner or later those
     * bytes spell "endstream". The stream is then cut short, the scan
     * resynchronises in the middle of the next object, and pages vanish. Two
     * of three pages of a real Bank of India statement disappeared exactly
     * this way. /Length is authoritative, so it is used where it exists --
     * following the indirect reference when the length is stored as its own
     * object, which is common. */
    const lengthOf = pos => {
      const owner = ownerOf(pos);
      if (!owner) return -1;
      const head = text.slice(owner.pos, pos);
      const direct = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(head);
      if (direct) return +direct[1];
      const indirect = /\/Length\s+(\d+)\s+\d+\s+R/.exec(head);
      if (indirect) {
        const target = objAt.find(o => o.num === +indirect[1]);
        if (target) {
          const v = /obj\s*(\d+)/.exec(text.slice(target.pos, target.pos + 60));
          if (v) return +v[1];
        }
      }
      return -1;
    };

    /* How many fonts the document declares. Zero means every page is a
     * picture -- there is no text object anywhere -- and that distinction is
     * what lets the failure message name the real problem instead of guessing. */
    const fonts = (text.match(/\/Type\s*\/Font\b/g) || []).length;

    const streams = [];
    const re = /[^a-zA-Z]stream\r?\n?/g;
    let m;
    while ((m = re.exec(text))) {
      const start = m.index + m[0].length;
      const declared = lengthOf(m.index);
      let end;
      if (declared >= 0 && start + declared <= text.length) {
        end = start + declared;
        // sanity: "endstream" should be within a few bytes of where /Length says
        const after = text.slice(end, end + 20);
        if (!/^\s*endstream/.test(after)) {
          const found = text.indexOf("endstream", start);
          end = found < 0 ? end : found;
        }
      } else {
        end = text.indexOf("endstream", start);
        if (end < 0) continue;
      }
      re.lastIndex = end + 9;

      let bytes = u8.subarray(start, end);
      const owner = ownerOf(m.index);
      const objNum = owner ? owner.num : -1;
      const objGen = owner ? owner.gen : 0;
      if (crypt && objNum >= 0) {
        try { bytes = await crypt.decrypt(objNum, objGen, bytes); }
        catch { /* leave it and let the inflate decide */ }
      }
      const out = bytes[0] === 0x78 ? await inflate(bytes) : bytes;
      if (out) streams.push({ num: objNum, body: asText(out) });
    }

    /* Every glyph table in the file, keyed by the object it came from. */
    const cmaps = new Map();
    for (const st of streams)
      if (st.num >= 0 && /beginbfchar|beginbfrange/.test(st.body))
        cmaps.set(st.num, parseCMap(st.body));

    /* Font dictionaries usually live inside compressed object streams, so the
     * raw file text does not contain them at all. Searching the decompressed
     * bodies as well is what makes multi-font documents come out as words
     * instead of noise. */
    const corpus = text + "\n" + streams.map(s => s.body).join("\n");

    const toUni = new Map();
    for (const om of corpus.matchAll(/(\d+)\s+\d+\s+obj([\s\S]{0,2000}?)(?:stream|endobj)/g)) {
      const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(om[2]);
      if (tu) toUni.set(+om[1], +tu[1]);
    }
    // Inside an object stream the objects are not wrapped in "N 0 obj", so a
    // bare "/Type/Font … /ToUnicode N 0 R" has to be picked up as well.
    for (const fm of corpus.matchAll(/\/BaseFont[\s\S]{0,400}?\/ToUnicode\s+(\d+)\s+\d+\s+R/g))
      toUni.set(-1, +fm[1]);                       // at least remember it exists

    /* Resource name -> glyph table.
     *
     * Rather than looking for a /Font dictionary specifically -- which may sit
     * in an object this reader never parses -- every "/Name 12 0 R" reference
     * anywhere in the file is tested, and kept only when object 12 turns out
     * to be a font with a ToUnicode table. Wrong guesses cannot survive that
     * test, and it finds the mapping wherever the writer chose to put it. */
    const fontMaps = new Map();
    for (const ref of corpus.matchAll(/\/([A-Za-z]{1,4}\d{0,3})\s+(\d+)\s+\d+\s+R/g)) {
      const cm = cmaps.get(toUni.get(+ref[2]));
      if (cm && cm.size) fontMaps.set(ref[1], cm);
    }
    /* When the /F1 -> font -> /ToUnicode chain cannot be followed, fall back to
     * the biggest glyph table in the document and use it for every font.
     *
     * This is not a lazy shortcut. Page resource dictionaries usually live
     * inside compressed streams, so the raw file text often does not contain
     * the /Font mapping at all -- and a statement is nearly always set in one
     * font. Guessing wrong shows as visible nonsense rather than a plausible
     * wrong number, so the failure is at least obvious. */
    let fallbackMap = null;
    for (const cm of cmaps.values())
      if (!fallbackMap || cm.size > fallbackMap.size) fallbackMap = cm;

    /* An embedded JPEG contains the bytes "Tj" often enough to look like a
     * content stream. Real page content is almost entirely printable ASCII, so
     * that is the test. */
    const printableShare = b => {
      const n = Math.min(b.length, 2000);
      let ok = 0;
      for (let i = 0; i < n; i++) {
        const c = b.charCodeAt(i);
        if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) ok++;
      }
      return n ? ok / n : 0;
    };
    const contents = streams.map(s => s.body)
      .filter(b => (/\bTj\b|\bTJ\b/.test(b)) && printableShare(b) > 0.85);
    if (!contents.length) {
      /* Name the actual problem. "Could not read this PDF" sends people off
       * to try the same file again; "this one is a picture" tells them what to
       * do instead. The most common cause is not a scanner at all -- it is a
       * tool that removed the password by re-rendering every page as a JPEG.
       * Those files come out ten to forty times larger than the locked
       * original they were made from, and the original reads perfectly. */
      const scanned = fonts === 0;
      throw new Error(scanned
        ? "This PDF is a picture of a statement, not a statement — there is " +
          "no text inside it, only an image, so there is nothing to read. " +
          "Password-removal tools often do this. Try the original locked file " +
          "from your bank and let this page ask for the password, or download " +
          "the Excel or CSV version instead."
        : "No text could be read from this PDF. If it is a scan or a photo " +
          "there is nothing to read — ask your bank for the CSV or Excel " +
          "version, which every net banking site offers.");
    }

    /* One column grid for the whole document, not one per page.
     *
     * Running the layout per page looked reasonable and quietly lost seven
     * eighths of a statement: the header is only on page one, so pages two
     * onwards were fitted to their own slightly different grid and their
     * columns no longer lined up with the headings. Pages are stacked on one
     * tall sheet instead -- each pushed far below the last so their rows never
     * merge -- and the columns are worked out once, across all of them.
     */
    const every = [];
    contents.forEach((c, page) => {
      for (const p of extractPieces(c, fontMaps, fallbackMap))
        every.push({ ...p, y: p.y - page * 5000 });
    });
    const rows = piecesToRows(every);

    /* Did it actually come out as words?
     *
     * Some PDFs embed fonts whose glyph tables this reader cannot match to the
     * text that uses them, and the result is confident-looking nonsense. A
     * statement that is mostly unreadable characters is worse than no
     * statement, because the totals would be invented. So it is checked, and
     * the person is pointed at the export that will work.
     */
    const all = rows.flat().join("");
    if (all.replace(/\s+/g, "").length > 200) {
      const solid = all.replace(/\s+/g, "");
      const readable = solid.length
        ? (solid.match(/[A-Za-z0-9.,:\/\-₹()]/g) || []).length / solid.length : 1;
      if (readable < 0.6) throw new Error(
        "This PDF stores its text in a way this reader cannot turn back into " +
        "words — the fonts inside it are not labelled. Your bank's Excel or " +
        "CSV download of the same statement will work; it is usually next to " +
        "the PDF button in net banking.");
    }
    return rows;
  }

  MSP.pdfread = { readPdf };
})(window.MSP = window.MSP || {});
