/*
 * The small amount of cryptography needed to open a locked statement.
 *
 * Indian banks nearly always send statements password-protected -- the PDF
 * wants your date of birth, the spreadsheet wants your customer ID. Telling
 * people to unlock the file themselves first is exactly the friction that
 * makes a tool not get used, so the app asks for the password and opens the
 * file itself.
 *
 * Nothing here weakens anything. Decryption happens in the browser with the
 * password the owner typed, the password is held in a local variable for the
 * length of one function call, and it is never stored, logged or sent.
 *
 * The browser's WebCrypto gives us SHA-1, SHA-256, SHA-512 and AES. It does
 * not give us MD5 or RC4, both of which the older PDF and Office formats
 * still depend on, so those two are implemented here. They are used only to
 * *read* files the person already owns.
 */
(function (MSP) {
  "use strict";

  const enc = new TextEncoder();
  const u8 = n => new Uint8Array(n);
  const concat = (...parts) => {
    const total = parts.reduce((a, p) => a + p.length, 0);
    const out = u8(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };

  /* ------------------------------------------------------------------ *
   * MD5 -- required by the PDF standard security handler up to revision 4.
   * WebCrypto deliberately does not offer it, and rightly so; it is here
   * because the file format needs it, not because it is a good hash.
   * ------------------------------------------------------------------ */
  function md5(bytes) {
    const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
               5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
               4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
               6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    const K = new Int32Array(64);
    for (let i = 0; i < 64; i++) K[i] = (Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

    const len = bytes.length;
    const withPad = u8((((len + 8) >> 6) + 1) << 6);
    withPad.set(bytes);
    withPad[len] = 0x80;
    const dv = new DataView(withPad.buffer);
    dv.setUint32(withPad.length - 8, (len << 3) >>> 0, true);
    dv.setUint32(withPad.length - 4, Math.floor(len / 536870912), true);

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const rol = (x, c) => (x << c) | (x >>> (32 - c));

    for (let i = 0; i < withPad.length; i += 64) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let j = 0; j < 64; j++) {
        let F, g;
        if (j < 16)      { F = (B & C) | (~B & D);        g = j; }
        else if (j < 32) { F = (D & B) | (~D & C);        g = (5 * j + 1) % 16; }
        else if (j < 48) { F = B ^ C ^ D;                 g = (3 * j + 5) % 16; }
        else             { F = C ^ (B | ~D);              g = (7 * j) % 16; }
        F = (F + A + K[j] + dv.getUint32(i + g * 4, true)) | 0;
        A = D; D = C; C = B;
        B = (B + rol(F, S[j])) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0;
      c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const out = u8(16), odv = new DataView(out.buffer);
    odv.setUint32(0, a0 >>> 0, true); odv.setUint32(4, b0 >>> 0, true);
    odv.setUint32(8, c0 >>> 0, true); odv.setUint32(12, d0 >>> 0, true);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * RC4 -- the other thing WebCrypto will not do, for the same good reason.
   * ------------------------------------------------------------------ */
  function rc4(key, data) {
    const S = u8(256);
    for (let i = 0; i < 256; i++) S[i] = i;
    for (let i = 0, j = 0; i < 256; i++) {
      j = (j + S[i] + key[i % key.length]) & 255;
      [S[i], S[j]] = [S[j], S[i]];
    }
    const out = u8(data.length);
    for (let k = 0, i = 0, j = 0; k < data.length; k++) {
      i = (i + 1) & 255;
      j = (j + S[i]) & 255;
      [S[i], S[j]] = [S[j], S[i]];
      out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
    }
    return out;
  }

  const sha = async (algo, bytes) =>
    u8(await crypto.subtle.digest(algo, bytes));
  const sha1   = b => sha("SHA-1", b);
  const sha256 = b => sha("SHA-256", b);
  const sha512 = b => sha("SHA-512", b);

  /** AES-CBC decrypt with no padding check -- these formats pad their own way. */
  async function aesCbcDecrypt(key, iv, data) {
    // WebCrypto insists on PKCS#7 padding when decrypting. Office and PDF
    // streams are not always padded that way, so a block of known padding is
    // appended, encrypted with the same key, and handed over as the final
    // block; the plaintext then comes back intact and the extra block is
    // dropped. This is the standard trick for "no padding" via WebCrypto.
    const k = await crypto.subtle.importKey("raw", key, "AES-CBC", false,
                                            ["encrypt", "decrypt"]);
    const body = data.subarray(0, data.length - (data.length % 16));
    if (!body.length) return u8(0);
    const lastCipher = body.subarray(body.length - 16);
    const padBlock = new Uint8Array(16).fill(16);
    const extra = u8(await crypto.subtle.encrypt(
      { name: "AES-CBC", iv: lastCipher }, k, padBlock));
    const full = concat(body, extra.subarray(0, 16));
    const out = u8(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, k, full));
    return out;
  }

  async function aesEcbDecryptBlock(key, block) {
    // ECB of one block == CBC of that block with a zero IV.
    const k = await crypto.subtle.importKey("raw", key, "AES-CBC", false,
                                            ["encrypt", "decrypt"]);
    const zero = u8(16);
    const padBlock = new Uint8Array(16).fill(16);
    const extra = u8(await crypto.subtle.encrypt(
      { name: "AES-CBC", iv: block }, k, padBlock));
    const out = u8(await crypto.subtle.decrypt({ name: "AES-CBC", iv: zero }, k,
                                               concat(block, extra.subarray(0, 16))));
    return out.subarray(0, 16);
  }

  /* ------------------------------------------------------------------ *
   * PDF standard security handler
   * ------------------------------------------------------------------ */
  const PAD = new Uint8Array([
    0x28,0xBF,0x4E,0x5E,0x4E,0x75,0x8A,0x41,0x64,0x00,0x4E,0x56,0xFF,0xFA,0x01,0x08,
    0x2E,0x2E,0x00,0xB6,0xD0,0x68,0x3E,0x80,0x2F,0x0C,0xA9,0xFE,0x64,0x53,0x69,0x7A]);

  /** Algorithm 2: the file key, for revisions 2 to 4. */
  function pdfKeyLegacy(password, O, P, idBytes, R, lengthBits, encryptMetadata) {
    const pw = concat(enc.encode(password || ""), PAD).subarray(0, 32);
    const p = u8(4);
    new DataView(p.buffer).setInt32(0, P, true);
    let input = concat(pw, O.subarray(0, 32), p, idBytes);
    if (R >= 4 && !encryptMetadata)
      input = concat(input, new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]));

    let key = md5(input);
    const n = R === 2 ? 5 : Math.max(5, lengthBits >> 3);
    if (R >= 3) for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n));
    return key.subarray(0, n);
  }

  /** Algorithm 6: does this password open the document? */
  function pdfCheckUser(key, U, R, idBytes) {
    if (R === 2) {
      const test = rc4(key, PAD);
      return test.every((b, i) => b === U[i]);
    }
    let h = md5(concat(PAD, idBytes));
    let test = rc4(key, h);
    for (let i = 1; i <= 19; i++) {
      const k2 = key.map(b => b ^ i);
      test = rc4(k2, test);
    }
    return test.every((b, i) => b === U[i]);          // first 16 bytes only
  }

  /** Revision 6 (AES-256): the 2.B hash. */
  async function hash2B(password, salt, udata) {
    const pw = enc.encode(password || "");
    let K = await sha256(concat(pw, salt, udata));
    for (let round = 0; ; round++) {
      const K1parts = [];
      for (let i = 0; i < 64; i++) K1parts.push(pw, K, udata);
      const K1 = concat(...K1parts);
      const aesKey = await crypto.subtle.importKey(
        "raw", K.subarray(0, 16), "AES-CBC", false, ["encrypt"]);
      const iv = K.subarray(16, 32);
      const padded = u8(await crypto.subtle.encrypt(
        { name: "AES-CBC", iv }, aesKey, K1));
      const E = padded.subarray(0, K1.length);
      let sum = 0;
      for (let i = 0; i < 16; i++) sum += E[i];
      const mod = sum % 3;
      K = mod === 0 ? await sha256(E) : mod === 1 ? await sha("SHA-384", E)
                                                  : await sha512(E);
      if (round >= 63 && E[E.length - 1] <= round - 32) break;
    }
    return K.subarray(0, 32);
  }

  /**
   * Work out the file key for a PDF, or return null if the password is wrong.
   * `dict` is the parsed /Encrypt dictionary.
   */
  async function pdfFileKey(dict, idBytes, password) {
    const { R, V, P, O, U, OE, UE, lengthBits, encryptMetadata } = dict;

    if (R <= 4) {
      const n = R === 2 ? 5 : Math.max(5, lengthBits >> 3);

      // The usual case: what was typed is the password that opens the file.
      // (An empty one is common too -- plenty of statements are locked only
      // against printing, and open with no password at all.)
      let key = pdfKeyLegacy(password, O, P, idBytes, R, lengthBits,
                             encryptMetadata);
      if (pdfCheckUser(key, U, R, idBytes)) return key;

      /* Otherwise it may be the *owner* password. Owner and user passwords are
       * different things in a PDF, and a person given one of them has no way
       * to know which they hold -- so both are tried rather than making them
       * guess. The owner password decrypts /O to reveal the user password,
       * which is then used normally. */
      let h = md5(concat(enc.encode(password || ""), PAD).subarray(0, 32));
      if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h);
      const ownerKey = h.subarray(0, n);

      let userPw = O.subarray(0, 32);
      if (R === 2) userPw = rc4(ownerKey, userPw);
      else for (let i = 19; i >= 0; i--)
        userPw = rc4(ownerKey.map(b => b ^ i), userPw);

      // The recovered value is the padded user password; trim it at the pad.
      let end = userPw.length;
      for (let i = 0; i + PAD.length <= userPw.length; i++) {
        let hit = true;
        for (let j = 0; j < 8; j++) if (userPw[i + j] !== PAD[j]) { hit = false; break; }
        if (hit) { end = i; break; }
      }
      const recovered = String.fromCharCode(...userPw.subarray(0, end));
      key = pdfKeyLegacy(recovered, O, P, idBytes, R, lengthBits, encryptMetadata);
      if (pdfCheckUser(key, U, R, idBytes)) return key;

      return null;
    }

    // Revision 5 and 6: AES-256.
    const vSalt = U.subarray(32, 40), kSalt = U.subarray(40, 48);
    const empty = u8(0);
    const check = R === 5
      ? await sha256(concat(enc.encode(password || ""), vSalt))
      : await hash2B(password, vSalt, empty);
    const ok = check.every((b, i) => b === U[i]);
    if (!ok) return null;

    const ikey = R === 5
      ? await sha256(concat(enc.encode(password || ""), kSalt))
      : await hash2B(password, kSalt, empty);
    // UE holds the file key, wrapped with AES-256-CBC and a zero IV.
    const k = await crypto.subtle.importKey("raw", ikey, "AES-CBC", false,
                                            ["encrypt", "decrypt"]);
    const zero = u8(16);
    const padBlock = new Uint8Array(16).fill(16);
    const tail = u8(await crypto.subtle.encrypt(
      { name: "AES-CBC", iv: UE.subarray(16, 32) }, k, padBlock));
    const out = u8(await crypto.subtle.decrypt({ name: "AES-CBC", iv: zero }, k,
                                               concat(UE, tail.subarray(0, 16))));
    return out.subarray(0, 32);
  }

  /** Decrypt one string or stream from a PDF. */
  /**
   * Strip the PKCS#7 padding an AES stream carries.
   *
   * `aesCbcDecrypt` deliberately returns the plaintext without letting
   * WebCrypto interpret the padding, because Office streams are not padded
   * that way. PDF streams are, so the padding is still on the end here -- and
   * up to sixteen stray bytes after a compressed stream make the inflater
   * reject the whole thing as trailing junk. Two pages of a real statement
   * disappeared for exactly this reason.
   */
  function stripPkcs7(out) {
    if (!out.length) return out;
    const n = out[out.length - 1];
    if (n < 1 || n > 16 || n > out.length) return out;
    for (let i = out.length - n; i < out.length; i++)
      if (out[i] !== n) return out;              // not padding after all
    return out.subarray(0, out.length - n);
  }

  async function pdfDecrypt(fileKey, num, gen, data, cfm, R) {
    if (cfm === "AESV3" || R >= 5) {
      const iv = data.subarray(0, 16);
      return stripPkcs7(await aesCbcDecrypt(fileKey, iv, data.subarray(16)));
    }
    // Per-object key: the file key plus the object and generation numbers.
    const extra = new Uint8Array([
      num & 255, (num >> 8) & 255, (num >> 16) & 255,
      gen & 255, (gen >> 8) & 255,
    ]);
    let input = concat(fileKey, extra);
    if (cfm === "AESV2") input = concat(input, new Uint8Array([0x73, 0x41, 0x6C, 0x54]));
    const objKey = md5(input).subarray(0, Math.min(fileKey.length + 5, 16));

    if (cfm === "AESV2") {
      const iv = data.subarray(0, 16);
      return stripPkcs7(await aesCbcDecrypt(objKey, iv, data.subarray(16)));
    }
    return rc4(objKey, data);
  }

  /* ------------------------------------------------------------------ *
   * Office (OOXML) encryption -- a locked .xlsx
   * ------------------------------------------------------------------ */

  /** Agile encryption (Office 2010 and later): the common case today. */
  async function ooxmlAgileKey(xml, password) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const enc4 = doc.getElementsByTagName("keyEncryptor")[0];
    const pk = doc.getElementsByTagNameNS("*", "encryptedKey")[0]
            || (enc4 && enc4.getElementsByTagName("p:encryptedKey")[0]);
    if (!pk) return null;

    const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const attr = (el, n) => el.getAttribute(n);
    const spin = +attr(pk, "spinCount");
    const salt = b64(attr(pk, "saltValue"));
    const keyBits = +attr(pk, "keyBits");
    const hashName = (attr(pk, "hashAlgorithm") || "SHA512").toUpperCase();
    const algo = hashName.includes("512") ? "SHA-512"
               : hashName.includes("384") ? "SHA-384"
               : hashName.includes("256") ? "SHA-256" : "SHA-1";

    // UTF-16LE password, then spinCount iterations of hash(counter || h)
    const pw = u8(password.length * 2);
    for (let i = 0; i < password.length; i++)
      new DataView(pw.buffer).setUint16(i * 2, password.charCodeAt(i), true);

    let h = u8(await crypto.subtle.digest(algo, concat(salt, pw)));
    for (let i = 0; i < spin; i++) {
      const c = u8(4);
      new DataView(c.buffer).setUint32(0, i, true);
      h = u8(await crypto.subtle.digest(algo, concat(c, h)));
    }
    const blockKey = async blk =>
      (u8(await crypto.subtle.digest(algo, concat(h, blk))))
        .subarray(0, keyBits >> 3);

    const VERIFIER_IN  = new Uint8Array([0xfe,0xa7,0xd2,0x76,0x3b,0x4b,0x9e,0x79]);
    const VERIFIER_OUT = new Uint8Array([0xd7,0xaa,0x0f,0x6d,0x30,0x61,0x34,0x4e]);
    const KEYVALUE     = new Uint8Array([0x14,0x6e,0x0b,0xe7,0xab,0xac,0xd0,0xd6]);

    const vIn  = await aesCbcDecrypt(await blockKey(VERIFIER_IN), salt,
                                     b64(attr(pk, "encryptedVerifierHashInput")));
    const vOut = await aesCbcDecrypt(await blockKey(VERIFIER_OUT), salt,
                                     b64(attr(pk, "encryptedVerifierHashValue")));
    const expect = u8(await crypto.subtle.digest(algo, vIn.subarray(0, 16)));
    for (let i = 0; i < 16; i++) if (expect[i] !== vOut[i]) return null;  // wrong password

    const keyValue = await aesCbcDecrypt(await blockKey(KEYVALUE), salt,
                                         b64(attr(pk, "encryptedKeyValue")));
    // the key for the package itself
    const kd = doc.getElementsByTagNameNS("*", "keyData")[0];
    return {
      key: keyValue.subarray(0, keyBits >> 3),
      salt: b64(kd.getAttribute("saltValue")),
      algo,
      blockSize: +kd.getAttribute("blockSize") || 16,
    };
  }

  MSP.crypto = {
    md5, rc4, sha1, sha256, sha512, concat,
    aesCbcDecrypt, aesEcbDecryptBlock,
    pdfFileKey, pdfDecrypt, ooxmlAgileKey,
  };
})(window.MSP = window.MSP || {});
