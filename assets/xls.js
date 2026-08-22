/*
 * Reading the old binary .xls format, in the browser, with no library.
 *
 * This exists because telling people to convert their file is not a real
 * answer. ICICI and several other Indian banks hand you a .xls by default --
 * for many people it is the only export their net banking offers -- and an app
 * that refuses it is an app they cannot use.
 *
 * A .xls is two formats stacked. The outer one is a Compound File Binary
 * container (the same thing older .doc and .ppt files use): a small FAT
 * filesystem inside a single file, with named streams in it. Inside that sits
 * a "Workbook" stream of BIFF8 records -- a flat sequence of (id, length,
 * payload) triples describing the cells.
 *
 * Only what a bank statement actually needs is implemented: the shared-string
 * table and the cell records that reference it. No formulas, no formatting, no
 * charts, no second worksheet. That keeps this around 250 lines instead of the
 * megabyte a general spreadsheet library costs.
 *
 * Ported from the Python reader in the private PFM tool, which was written for
 * exactly this ICICI export.
 */
(function (MSP) {
  "use strict";

  const CFB_MAGIC = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

  /* ------------------------------------------------------------------ *
   * The outer container: a FAT filesystem in a file
   * ------------------------------------------------------------------ */
  function readCFB(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    for (let i = 0; i < 8; i++)
      if (u8[i] !== CFB_MAGIC[i]) throw new Error("not a .xls file");

    const ss  = 1 << dv.getUint16(30, true);          // sector size
    const mss = 1 << dv.getUint16(32, true);          // mini-sector size
    const nFat        = dv.getUint32(44, true);
    const dirStart    = dv.getUint32(48, true);
    const miniCutoff  = dv.getUint32(56, true);
    const miniFatSt   = dv.getUint32(60, true);
    const difatStart  = dv.getUint32(68, true);
    const nDifat      = dv.getUint32(72, true);

    const sector = n => new Uint8Array(buf, 512 + n * ss, ss);
    const asInts = bytes => {
      const out = new Uint32Array(bytes.length / 4);
      const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < out.length; i++) out[i] = d.getUint32(i * 4, true);
      return out;
    };

    // the double-indirect FAT: where the FAT sectors themselves live
    const difat = [];
    for (let i = 0; i < 109; i++) difat.push(dv.getUint32(76 + i * 4, true));
    let s = difatStart, guard = 0;
    while (nDifat && s < 0xFFFFFFFA && guard++ < 1e5) {
      const v = asInts(sector(s));
      for (let i = 0; i < v.length - 1; i++) difat.push(v[i]);
      s = v[v.length - 1];
    }

    const fat = [];
    for (let i = 0; i < nFat && i < difat.length; i++)
      if (difat[i] < 0xFFFFFFFA) for (const v of asInts(sector(difat[i]))) fat.push(v);

    const miniFat = [];
    s = miniFatSt; guard = 0;
    while (s < 0xFFFFFFFA && guard++ < 1e5) {
      for (const v of asInts(sector(s))) miniFat.push(v);
      s = fat[s];
    }

    /** Follow a chain of sectors to the end and join them. */
    const chain = (start, table, read) => {
      const parts = []; let n = start, guard = 0;
      while (n < 0xFFFFFFFA && guard++ < 1e6) { parts.push(read(n)); n = table[n]; }
      const total = parts.reduce((a, p) => a + p.length, 0);
      const out = new Uint8Array(total); let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    };

    // directory entries: name -> {start, size}
    const dirRaw = chain(dirStart, fat, sector);
    const dirs = {}; let root = null;
    const ddv = new DataView(dirRaw.buffer, dirRaw.byteOffset, dirRaw.byteLength);
    for (let i = 0; i + 128 <= dirRaw.length; i += 128) {
      const nlen = ddv.getUint16(i + 64, true);
      let name = "";
      for (let j = 0; j < Math.max(0, nlen - 2); j += 2)
        name += String.fromCharCode(ddv.getUint16(i + j, true));
      const type  = dirRaw[i + 66];
      const start = ddv.getUint32(i + 116, true);
      const size  = Number(ddv.getBigUint64(i + 120, true));
      if (type === 5) root = { start, size };
      else if (type === 2 && name) dirs[name] = { start, size };
    }

    // Small streams live inside the root entry's own stream, cut into
    // mini-sectors. Anything at or above the cutoff uses normal sectors.
    const miniStore = root ? chain(root.start, fat, sector) : new Uint8Array(0);
    const miniSector = n => miniStore.subarray(n * mss, (n + 1) * mss);

    const read = name => {
      const e = dirs[name];
      if (!e) throw new Error(`no "${name}" stream in this file`);
      const data = e.size < miniCutoff
        ? chain(e.start, miniFat, miniSector)
        : chain(e.start, fat, sector);
      return data.subarray(0, e.size);
    };
    return { dirs, read };
  }

  /* ------------------------------------------------------------------ *
   * BIFF8 records
   * ------------------------------------------------------------------ */
  const BOF = 0x0809, SST = 0x00FC, CONTINUE = 0x003C, LABELSST = 0x00FD,
        LABEL = 0x0204, NUMBER = 0x0203, RK = 0x027E, MULRK = 0x00BD,
        FORMULA = 0x0006, RSTRING = 0x00D6;

  function* records(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let pos = 0;
    while (pos + 4 <= u8.length) {
      const rid = dv.getUint16(pos, true), len = dv.getUint16(pos + 2, true);
      pos += 4;
      const payload = u8.subarray(pos, pos + len);
      pos += len;
      if (rid === SST) {
        // A CONTINUE run belongs to the record before it. The pieces are kept
        // separate rather than concatenated, because each continuation starts
        // with its own compression flag that the string parser has to read.
        const chunks = [payload];
        while (pos + 4 <= u8.length && dv.getUint16(pos, true) === CONTINUE) {
          const clen = dv.getUint16(pos + 2, true);
          pos += 4;
          chunks.push(u8.subarray(pos, pos + clen));
          pos += clen;
        }
        yield [rid, chunks];
      } else {
        yield [rid, payload];
      }
    }
  }

  /**
   * Decode the shared-string table.
   *
   * The awkward part: a single string can straddle a CONTINUE boundary, and
   * the continuation restarts with its own compression flag — so the second
   * half of one word can be a different character encoding from the first.
   */
  function parseSST(chunks) {
    if (!chunks.length || chunks[0].length < 8) return [];
    const head = new DataView(chunks[0].buffer, chunks[0].byteOffset,
                              chunks[0].byteLength);
    const unique = head.getUint32(4, true);

    let ci = 0, off = 8, cur = chunks[0];
    const dv = () => new DataView(cur.buffer, cur.byteOffset, cur.byteLength);
    const strings = [];

    const nextChunk = () => {
      ci++;
      if (ci >= chunks.length) return false;
      cur = chunks[ci]; off = 0;
      return true;
    };

    for (let n = 0; n < unique; n++) {
      if (off + 3 > cur.length && !nextChunk()) break;
      const cch = dv().getUint16(off, true);
      const grbit = cur[off + 2];
      off += 3;
      let wide = !!(grbit & 0x01);
      const rich = !!(grbit & 0x08), ext = !!(grbit & 0x04);
      let cruns = 0, cext = 0;
      if (rich) { cruns = dv().getUint16(off, true); off += 2; }
      if (ext)  { cext  = dv().getInt32(off, true);  off += 4; }

      let out = "", left = cch;
      while (left > 0) {
        if (off >= cur.length) {
          if (!nextChunk()) break;
          wide = !!(cur[0] & 0x01);       // fresh flag on the continuation
          off = 1;
        }
        const width = wide ? 2 : 1;
        const take = Math.min(left, Math.floor((cur.length - off) / width));
        if (take <= 0) { off = cur.length; continue; }
        if (wide) {
          const d = dv();
          for (let i = 0; i < take; i++)
            out += String.fromCharCode(d.getUint16(off + i * 2, true));
        } else {
          for (let i = 0; i < take; i++) out += String.fromCharCode(cur[off + i]);
        }
        off += take * width;
        left -= take;
      }

      // rich-text runs and phonetic data can straddle chunks too
      for (let skip of [cruns * 4, cext]) {
        while (skip > 0) {
          if (off >= cur.length && !nextChunk()) { skip = 0; break; }
          const step = Math.min(skip, cur.length - off);
          off += step; skip -= step;
        }
      }
      strings.push(out);
    }
    return strings;
  }

  /** RK values pack a number into 30 bits, four different ways. */
  function rkToNumber(rk) {
    const cents = rk & 0x01, isInt = rk & 0x02;
    const val = rk & 0xFFFFFFFC;
    let num;
    if (isInt) {
      num = (val | 0) >> 2;
    } else {
      const b = new ArrayBuffer(8), d = new DataView(b);
      d.setUint32(4, val >>> 0, true);          // top 32 bits of a double
      num = d.getFloat64(0, true);
    }
    return cents ? num / 100 : num;
  }

  /**
   * The first worksheet, as an array of rows.
   *
   * Values come back as strings or numbers; dates arrive as Excel serial
   * numbers, which the statement parser already knows how to read.
   */
  function readXls(buf) {
    const ole = readCFB(buf);
    const name = ole.dirs.Workbook ? "Workbook" : "Book";
    return readXlsStream(ole.read(name));
  }

  function readXlsStream(stream) {
    let sst = [], sheet = -1;
    const cells = new Map();
    const put = (r, c, v) => cells.set(r * 4096 + c, v);

    for (const [rid, payload] of records(stream)) {
      if (rid === SST) { sst = parseSST(payload); continue; }
      const d = payload.length
        ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
        : null;
      if (rid === BOF && d && payload.length >= 4) {
        if (d.getUint16(2, true) === 0x0010) sheet++;   // a worksheet BOF
        continue;
      }
      if (sheet > 0) continue;                          // first sheet only
      if (!d) continue;

      if (rid === LABELSST && payload.length >= 10) {
        const i = d.getUint32(6, true);
        put(d.getUint16(0, true), d.getUint16(2, true), sst[i] ?? "");
      } else if ((rid === LABEL || rid === RSTRING) && payload.length >= 9) {
        const r = d.getUint16(0, true), c = d.getUint16(2, true);
        const ln = d.getUint16(6, true), grbit = payload[8];
        let out = "";
        if (grbit & 1) for (let i = 0; i < ln; i++) out += String.fromCharCode(d.getUint16(9 + i * 2, true));
        else           for (let i = 0; i < ln; i++) out += String.fromCharCode(payload[9 + i]);
        put(r, c, out);
      } else if (rid === NUMBER && payload.length >= 14) {
        put(d.getUint16(0, true), d.getUint16(2, true), d.getFloat64(6, true));
      } else if (rid === RK && payload.length >= 10) {
        put(d.getUint16(0, true), d.getUint16(2, true),
            rkToNumber(d.getUint32(6, true)));
      } else if (rid === MULRK && payload.length >= 6) {
        const r = d.getUint16(0, true), first = d.getUint16(2, true);
        const count = Math.floor((payload.length - 6) / 6);
        for (let i = 0; i < count; i++)
          put(r, first + i, rkToNumber(d.getUint32(4 + i * 6 + 2, true)));
      } else if (rid === FORMULA && payload.length >= 14) {
        // A cached numeric result. The pattern FFFF in the top two bytes means
        // the result is a string or an error rather than a number, and those
        // arrive separately; skipping them is correct, not a shortcut.
        if (d.getUint16(12, true) !== 0xFFFF)
          put(d.getUint16(0, true), d.getUint16(2, true), d.getFloat64(6, true));
      }
    }

    if (!cells.size) return [];
    let maxR = 0, maxC = 0;
    for (const k of cells.keys()) {
      const r = Math.floor(k / 4096), c = k % 4096;
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
    }
    const grid = [];
    for (let r = 0; r <= maxR; r++) {
      const row = [];
      for (let c = 0; c <= maxC; c++) row.push(cells.get(r * 4096 + c) ?? "");
      grid.push(row);
    }
    return grid;
  }

  /* ------------------------------------------------------------------ *
   * A locked Office file uses the same OLE wrapper as a legacy .xls
   * ------------------------------------------------------------------ */

  /**
   * Decrypt an EncryptedPackage stream into the .xlsx zip it really is.
   *
   * The package is split into 4096-byte segments, each encrypted with its own
   * IV derived from the salt and the segment number -- so they can be decrypted
   * in any order, which is what lets Excel open a huge file quickly.
   */
  async function decryptPackage(info, pkg) {
    const { key, salt, algo, blockSize } = info;
    const total = Number(new DataView(pkg.buffer, pkg.byteOffset, 8)
      .getBigUint64(0, true));
    const body = pkg.subarray(8);
    const out = new Uint8Array(total);
    const SEG = 4096;

    for (let i = 0, o = 0; o < total; i++, o += SEG) {
      const blk = new Uint8Array(4);
      new DataView(blk.buffer).setUint32(0, i, true);
      const iv = (new Uint8Array(await crypto.subtle.digest(
        algo, MSP.crypto.concat(salt, blk)))).subarray(0, blockSize);
      const chunk = body.subarray(i * SEG, (i + 1) * SEG);
      if (!chunk.length) break;
      const plain = await MSP.crypto.aesCbcDecrypt(key, iv, chunk);
      out.set(plain.subarray(0, Math.min(SEG, total - o)), o);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * A locked legacy .xls: RC4 CryptoAPI
   *
   * Not the same scheme as a locked .xlsx at all. The file is a perfectly
   * ordinary compound file with a perfectly ordinary Workbook stream -- it is
   * the *contents* of the BIFF records that are enciphered, in place, leaving
   * every record header readable. That is what lets Excel jump straight to a
   * sheet in a locked file without decrypting the whole thing.
   *
   * Three consequences the code below has to respect, and each one produces
   * silent garbage rather than an error if you get it wrong:
   *
   *   1. The keystream is restarted every 1024 bytes of the stream, with a key
   *      derived from the block number. Position in the file, not position in
   *      the record, decides which key applies.
   *   2. The four header bytes of every record stay in clear -- but the
   *      keystream still runs across them, so they cannot simply be skipped.
   *   3. A handful of records are never enciphered (the ones Excel must read
   *      before it knows there is a password at all), and BOUNDSHEET keeps its
   *      first four bytes in clear because that is a file offset Excel needs.
   * ------------------------------------------------------------------ */

  const FILEPASS = 0x002F;
  /* Written before the password takes effect, so they are readable as-is. */
  const UNENCRYPTED = new Set([
    0x0809, 0x0009, 0x0209, 0x0409,   // BOF, in all its historical spellings
    FILEPASS, 0x00E1,                 // FilePass, InterfaceHdr
    0x0196, 0x0138, 0x0194, 0x00FF,   // RRDInfo, RRDHead, WriteAccess, ExtSST
  ]);

  const utf16le = s => {
    const out = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      out[i * 2] = s.charCodeAt(i) & 255;
      out[i * 2 + 1] = s.charCodeAt(i) >> 8;
    }
    return out;
  };

  const le32 = n => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };

  /** Find the FilePass record, if the workbook has one. */
  function findFilePass(stream) {
    const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    let pos = 0;
    while (pos + 4 <= stream.length) {
      const rid = dv.getUint16(pos, true), len = dv.getUint16(pos + 2, true);
      if (rid === FILEPASS) return stream.subarray(pos + 4, pos + 4 + len);
      // FilePass, when present, is the second or third record in the stream.
      // Once real cell data starts there will not be one, and scanning the
      // whole file would only find false positives in enciphered bytes.
      if (pos > 4096) return null;
      pos += 4 + len;
    }
    return null;
  }

  /**
   * Derive the key for one 1024-byte block. MS-OFFCRYPTO 2.3.5.2.
   *
   * A 40-bit key is padded to 128 bits with zeros rather than being used as a
   * short key -- RC4 would happily accept five bytes and produce a completely
   * different keystream.
   */
  async function rc4Key(salt, pwd, keyBits, block) {
    const h = await MSP.crypto.sha1(MSP.crypto.concat(salt, pwd));
    const k = await MSP.crypto.sha1(MSP.crypto.concat(h, le32(block)));
    if (keyBits === 40) {
      const out = new Uint8Array(16);
      out.set(k.subarray(0, 5));
      return out;
    }
    return k.subarray(0, Math.max(5, keyBits >> 3));
  }

  /**
   * Decipher a Workbook stream in place. Returns null if the password is
   * wrong, so the caller can ask again instead of showing a broken sheet.
   */
  async function decryptBiff(stream, info, password) {
    const pwd = utf16le(password);
    const { salt, keyBits, verifier, verifierHash } = info;

    // The verifier and its hash are one continuous run of the block-0
    // keystream, not two separate ones.
    const k0 = await rc4Key(salt, pwd, keyBits, 0);
    const plain = MSP.crypto.rc4(k0, MSP.crypto.concat(verifier, verifierHash));
    const want = await MSP.crypto.sha1(plain.subarray(0, 16));
    for (let i = 0; i < 20; i++)
      if (want[i] !== plain[16 + i]) return null;

    const BLK = 1024;
    const dec = new Uint8Array(stream);            // a copy, then patched
    for (let b = 0; b * BLK < stream.length; b++) {
      const key = await rc4Key(salt, pwd, keyBits, b);
      dec.set(MSP.crypto.rc4(key, stream.subarray(b * BLK, (b + 1) * BLK)),
              b * BLK);
    }

    // Put back everything that was never enciphered. Reading the ids and
    // lengths from the original is the point -- headers are always in clear.
    const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    let pos = 0;
    while (pos + 4 <= stream.length) {
      const rid = dv.getUint16(pos, true), len = dv.getUint16(pos + 2, true);
      const end = Math.min(pos + 4 + len, stream.length);
      dec.set(stream.subarray(pos, Math.min(pos + 4, stream.length)), pos);
      if (UNENCRYPTED.has(rid)) dec.set(stream.subarray(pos + 4, end), pos + 4);
      else if (rid === 0x0085)                     // BoundSheet8: lbPlyPos
        dec.set(stream.subarray(pos + 4, Math.min(pos + 8, end)), pos + 4);
      pos += 4 + len;
    }
    return dec;
  }

  /** Read the FilePass payload, or explain why this one cannot be opened. */
  function parseFilePass(fp) {
    const dv = new DataView(fp.buffer, fp.byteOffset, fp.byteLength);
    const type = dv.getUint16(0, true);
    if (type !== 1) throw new Error(
      "This .xls uses Excel's oldest and weakest protection, which this app " +
      "does not implement. Open it with your password and use File → " +
      "Save As to save a copy as .xlsx or .csv, then try that.");

    const major = dv.getUint16(2, true), minor = dv.getUint16(4, true);
    if (minor !== 2) throw new Error(
      "This .xls uses an Excel 97 era encryption this app cannot open. Open " +
      "it with your password and Save As → .xlsx or .csv, then try that.");
    if (major < 2 || major > 4) throw new Error(
      "This .xls is protected in a way this app does not recognise. Open it " +
      "with your password and Save As → .xlsx or .csv, then try that.");

    const hdrSize = dv.getUint32(10, true);
    const hdr = 14;                                 // EncryptionHeader starts
    const algId  = dv.getUint32(hdr + 8, true);
    const keyBits = dv.getUint32(hdr + 16, true) || 40;
    if (algId && algId !== 0x6801) throw new Error(
      "This .xls is encrypted with a cipher this app does not implement. " +
      "Open it with your password and Save As → .xlsx or .csv.");

    let p = hdr + hdrSize;                          // EncryptionVerifier
    const saltSize = dv.getUint32(p, true); p += 4;
    const salt = fp.subarray(p, p + saltSize); p += saltSize;
    const verifier = fp.subarray(p, p + 16); p += 16;
    const hashSize = dv.getUint32(p, true); p += 4;
    const verifierHash = fp.subarray(p, p + Math.max(20, hashSize)).subarray(0, 20);
    return { salt, keyBits, verifier, verifierHash };
  }

  /**
   * Open an OLE container: either a real .xls, or an encrypted Office file.
   *
   * Both use the same outer wrapper, so the streams inside decide which it is.
   * Returns { grid } for a spreadsheet read directly, or { zip } holding the
   * decrypted .xlsx for the caller to parse.
   */
  async function readOle(buf, password) {
    const ole = readCFB(buf);

    if (ole.dirs.EncryptedPackage) {
      if (!password) {
        const e = new Error("This spreadsheet is password-protected.");
        e.needsPassword = true;
        throw e;
      }
      const infoRaw = ole.read("EncryptionInfo");
      const dv = new DataView(infoRaw.buffer, infoRaw.byteOffset, infoRaw.byteLength);
      const major = dv.getUint16(0, true), minor = dv.getUint16(2, true);
      if (!(major === 4 && minor === 4)) {
        throw new Error(
          "This file uses an older Excel encryption that this app cannot open. " +
          "Open it in Excel with your password and use File → Save As to save " +
          "an unprotected copy, then try that.");
      }
      // Agile: an XML descriptor follows the 8-byte header.
      let xml = "";
      for (let i = 8; i < infoRaw.length; i++) xml += String.fromCharCode(infoRaw[i]);
      const info = await MSP.crypto.ooxmlAgileKey(xml.replace(/^[^<]*/, ""), password);
      if (!info) {
        const e = new Error(
          "That password did not open the spreadsheet. Bank files usually use " +
          "your customer ID, your PAN in capitals, or your date of birth.");
        e.needsPassword = true;
        throw e;
      }
      const zip = await decryptPackage(info, ole.read("EncryptedPackage"));
      return { zip: zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) };
    }

    if (!ole.dirs.Workbook && !ole.dirs.Book)
      throw new Error("This does not look like a spreadsheet.");

    /* A FilePass record means the old .xls itself is enciphered. It has to be
     * caught here: without the password the records still parse, and produce
     * tens of thousands of rows of noise rather than an error. */
    const stream = ole.read(ole.dirs.Workbook ? "Workbook" : "Book");
    const fp = findFilePass(stream);
    if (!fp) return { grid: readXlsStream(stream) };

    if (!password) {
      const e = new Error("This spreadsheet is password-protected.");
      e.needsPassword = true;
      throw e;
    }
    const plain = await decryptBiff(stream, parseFilePass(fp), password);
    if (!plain) {
      const e = new Error(
        "That password did not open the spreadsheet. Bank files usually use " +
        "your customer ID, your PAN in capitals, or your date of birth.");
      e.needsPassword = true;
      throw e;
    }
    return { grid: readXlsStream(plain) };
  }

  MSP.xls = { readXls, readOle };
})(window.MSP = window.MSP || {});
