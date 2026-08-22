/*
 * Categorisation, in the browser.
 *
 * A bank narration is mostly noise. A UPI line looks like
 *
 *     UPI/ETERNAL LI/zomatoorder.rz/PayviaRazo/AIRTEL PAY/900000000000/IBL000...
 *
 * and only one of those seven segments names the merchant. The rest are the
 * payment rail, a generic remark and two reference ids. Two things go wrong if
 * you match against the whole string:
 *
 *   1. Rail bleed. "AIRTEL PAY" routes hundreds of Zomato and Uber payments,
 *      so a rule looking for "airtel" files food delivery as a phone bill.
 *   2. Reference ids are unique per row, so they dominate any similarity match
 *      while carrying no meaning at all.
 *
 * So the text is cleaned first, and each rule declares which version of the
 * text it is allowed to see:
 *
 *   clean   -- merchant name only. Merchant rules use this.
 *   raw     -- clean text plus the original narration. Money-movement rules
 *              need it, because cleaning removes the banking verbs they match.
 *   nospace -- the untouched narration with spaces removed. Some banks wrap
 *              long narrations mid-word, and digits survive here.
 *
 * Rules are ordered and the first match wins. Order is load-bearing: a loan
 * repayment often carries the account holder's own name, so if the
 * self-transfer rule ran first every EMI would vanish from spending.
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
   * Categories: name -> [flow, group]
   *
   * flow decides whether something counts as money spent. A transfer between
   * your own accounts is not an expense, and breaking a fixed deposit is not
   * income -- getting this wrong is what makes most spending reports useless.
   * ------------------------------------------------------------------ */
  const EXPENSE = "EXPENSE", INCOME = "INCOME",
               TRANSFER = "TRANSFER", INVESTMENT = "INVESTMENT";

  const CATEGORIES = {
    "Food":               [EXPENSE, "Needs"],
    "Groceries":          [EXPENSE, "Needs"],
    "Travel-Local":       [EXPENSE, "Needs"],
    "Travel-Outstation":  [EXPENSE, "Wants"],
    "Trip":               [EXPENSE, "Wants"],
    "Rent":               [EXPENSE, "Needs"],
    "Bills-Utilities":    [EXPENSE, "Needs"],
    "Internet & Mobile":  [EXPENSE, "Needs"],
    "Subscriptions":      [EXPENSE, "Wants"],
    "Entertainment":      [EXPENSE, "Wants"],
    "Shopping":           [EXPENSE, "Wants"],
    "Fitness":            [EXPENSE, "Needs"],
    "Health & Medical":   [EXPENSE, "Needs"],
    "Education":          [EXPENSE, "Needs"],
    "Family":             [EXPENSE, "Needs"],
    "Maid & Help":        [EXPENSE, "Needs"],
    "Car & Fuel":         [EXPENSE, "Needs"],
    "Insurance":          [EXPENSE, "Needs"],
    "Fees & Charges":     [EXPENSE, "Misc"],
    "Tax":                [EXPENSE, "Needs"],
    "Property & Home":    [EXPENSE, "Needs"],
    "Gifts & Donations":  [EXPENSE, "Wants"],
    "Pets":               [EXPENSE, "Wants"],
    "Personal Care":      [EXPENSE, "Wants"],
    "Person-to-Person":   [EXPENSE, "Misc"],
    "Miscellaneous":      [EXPENSE, "Misc"],
    "EMI":                [EXPENSE, "Needs"],
    "Standing Instruction":[EXPENSE, "Needs"],
    "Salary":             [INCOME,  "Income"],
    "Interest Income":    [INCOME,  "Income"],
    "Other Income":       [INCOME,  "Income"],
    "Credit Card Payment":[TRANSFER, "Transfer"],
    "Self Transfer":      [TRANSFER, "Transfer"],
    "Cash Withdrawal":    [TRANSFER, "Transfer"],
    "Transfer Out":       [TRANSFER, "Transfer"],
    "Reversed":           [TRANSFER, "Transfer"],
    "FD/RD Redeemed":     [TRANSFER, "Transfer"],
    "Investment-Equity":  [INVESTMENT, "Investment"],
    "Investment-Deposit": [INVESTMENT, "Investment"],
    "Investment-Gold":    [INVESTMENT, "Investment"],
    "Investment-MF":      [INVESTMENT, "Investment"],
    "Investment-Other":   [INVESTMENT, "Investment"],
  };

  const flowOf  = c => (CATEGORIES[c] || [EXPENSE, "Misc"])[0];
  const groupOf = c => (CATEGORIES[c] || [EXPENSE, "Misc"])[1];

  /* ------------------------------------------------------------------ *
   * Ten headline categories
   *
   * The list above is deliberately fine-grained -- it is what the rules aim
   * at, and "Travel-Outstation" is a more honest label than "Travel" when a
   * flight and a bus fare are different decisions. But thirty-odd slices is
   * not a chart, it is a colour swatch: the eye cannot rank them and nothing
   * stands out, so the picture stops answering the only question worth
   * asking, which is where the money actually went.
   *
   * So the detail is kept on every row and rolled up for display. Ten buckets
   * plus Miscellaneous is about the limit of what a person can hold in their
   * head at once, and each one here is something you could plausibly decide to
   * spend less on -- which is the test a category has to pass to be worth
   * drawing.
   * ------------------------------------------------------------------ */
  const MAJOR = {
    "Food":               "Food & Drink",
    "Groceries":          "Groceries",
    "Travel-Local":       "Travel & Transport",
    "Travel-Outstation":  "Travel & Transport",
    "Trip":               "Travel & Transport",
    "Car & Fuel":         "Travel & Transport",
    "Bills-Utilities":    "Bills & Utilities",
    "Internet & Mobile":  "Bills & Utilities",
    "Shopping":           "Shopping",
    "Personal Care":      "Shopping",
    "Health & Medical":   "Health & Fitness",
    "Fitness":            "Health & Fitness",
    "Pets":               "Health & Fitness",
    "Rent":               "Home & Family",
    "Property & Home":    "Home & Family",
    "Maid & Help":        "Home & Family",
    "Family":             "Home & Family",
    "Person-to-Person":   "Payments to People",
    "Gifts & Donations":  "Payments to People",
    "Entertainment":      "Fun & Learning",
    "Subscriptions":      "Fun & Learning",
    "Education":          "Fun & Learning",
    "EMI":                "Loans, Fees & Tax",
    "Standing Instruction":"Loans, Fees & Tax",
    "Insurance":          "Loans, Fees & Tax",
    "Fees & Charges":     "Loans, Fees & Tax",
    "Tax":                "Loans, Fees & Tax",
    "Miscellaneous":      "Miscellaneous",
  };
  /* Income, investment and transfers are not spending and never appear in the
   * category chart, so they keep their own names. */
  const majorOf = c => MAJOR[c] || c;

  /* ------------------------------------------------------------------ *
   * Text cleaning
   * ------------------------------------------------------------------ */

  // Payment rails and sponsor banks. These name the plumbing, never the shop.
  const RAILS = [
    "airtel pay","airtelpay","state bank","statebank","axis bank","icici bank",
    "hdfc bank","kotak mahindra","kotak mahi","punjab nat","yes bank","yesbank",
    "bank of ba","bank of in","bank of ind","union bank","idfc first","indusind",
    "canara","federal ba","rbl bank","au small","bandhan","ippb","jio paymen",
    "fino","equitas","dbs bank","citi","idbi","central b","karnataka",
    "south indi","city union","csb bank","paytm paym","one97","utkarsh",
    "ujjivan","esaf","suryoday","jana small","dcb bank","karur","tamilnad",
    "indian ban","indian ove","maharashtr","hsbc","standard c","razorpay",
    "billdesk","payu","ccavenue","phonepe","google pay","gpay","bharatpe",
    "cred","slice","paytm","navi","mobikwik","freecharge","amazon pay",
    "uco bank","sbi bank","boi bank",
    // the same names as they appear inside a VPA handle, with no space
    "hdfcbank","icicibank","axisbank","yesbank","kotakbank","sbibank",
    "idfcbank","indusbank","federalbank","rblbank","paytmbank",
  ];

  // Words that appear on most rows and identify nothing.
  const FILLER = [
    "upi","imps","neft","rtgs","nach","ach","ecs","atm","pos","vps","nfs","wdl",
    "tfr","inb","chq","cash","dr","cr","debit","credit","payment","pay","paid",
    "payviarazo","payvia","collect","autopay","mandate","transfer","to transfer",
    "by transfer","sent","received","txn","rpy","pymt","intent","upiintent",
    "merchant","merchan","payment from","payment to","payment for","others",
    // A PDF sets these as one run with no space, so they arrive glued.
    "paidto","receivedfrom","paymentto","paymentfrom","sentto","transactionid",
    "paidby","paidvia","receivedby","transaction","utr","utrno",
    "bil","bil/","ecom","purchase","onl","online","ib","mb","bulk","misc",
    "ach d","ach d-","nach dr","refno","ref","utr","ret","chg","charges",
    // Bare bank codes. They appear as the sponsor bank on a UPI line and inside
    // handles like "dmart@hdfcbank", so without these the top-payee list reads
    // "supermarket ready hdfc" instead of "supermarket".
    "hdfc","icici","sbi","boi","axis","kotak","yes","idfc","pnb","uco","idbi",
    "rbl","indusind","canara","federal","bandhan","dbs","hsbc","bob","union",
    "okicici","okhdfc","okaxis","oksbi","ybl","ibl","apl","axl","paytm","upi",
    "lici","netc","bescom","corp","ltd","pvt","india","indian","limited",
  ];

  // Longest first, so "swiggy instamart" is matched before "swiggy".
  const ALIASES = [
    [/swiggy\s*instamart|instamart/gi, "SWIGGYINSTAMART"],
    [/\bswiggy\s*genie\b/gi,           "SWIGGYGENIE"],
    [/\bswiggy\b/gi,                   "SWIGGY"],
    [/zomato|eternal\s*li/gi,          "ZOMATO"],
    [/blinkit|grofers/gi,              "BLINKIT"],
    [/\bzepto\b/gi,                    "ZEPTO"],
    [/big\s*basket|bigbasket|bbdaily/gi, "BIGBASKET"],
    [/\buber\b|uber\s*india/gi,        "UBER"],
    [/\bola\b|ola\s*cabs|olacabs/gi,   "OLACABS"],
    [/\brapido\b/gi,                   "RAPIDO"],
    [/\bnamma\s*yatri\b/gi,            "NAMMA"],
    [/\birctc\b/gi,                    "IRCTC"],
    /* Bank narrations truncate the payee to about ten characters, so Indian
     * Railways arrives as "Indian Rai" and its UPI handle as "iruts". Neither
     * contains the word a railway rule looks for. */
    [/indian\s*rail\w*|\biruts\b|\bindian\s*rai\b|\buts\s*app\b/gi, "IRCTC"],
    [/metro\w*|\bwb[\s.]*metro\b/gi, "METRO"],
    [/red\s*bus|redbus/gi,             "REDBUS"],
    [/make\s*my\s*trip|makemytrip/gi,  "MAKEMYTRIP"],
    [/\bgoibibo\b/gi,                  "GOIBIBO"],
    [/\bcleartrip\b/gi,                "CLEARTRIP"],
    [/\bindigo\b|\b6e\b/gi,            "INDIGO"],
    [/\bspicejet\b/gi,                 "SPICEJET"],
    [/\bvistara\b/gi,                  "VISTARA"],
    [/air\s*india/gi,                  "AIRINDIA"],
    [/\bamazon\b(?!\s*pay)/gi,         "AMAZON"],
    [/\bflipkart\b/gi,                 "FLIPKART"],
    [/\bmyntra\b/gi,                   "MYNTRA"],
    [/\bajio\b/gi,                     "AJIO"],
    [/\bmeesho\b/gi,                   "MEESHO"],
    [/\bnykaa\b/gi,                    "NYKAA"],
    [/\bdecathlon\b/gi,                "DECATHLON"],
    [/\bnetflix\b/gi,                  "NETFLIX"],
    [/hotstar|disney\s*\+?\s*hotstar/gi, "HOTSTAR"],
    [/\bspotify\b/gi,                  "SPOTIFY"],
    [/prime\s*video|primevideo/gi,     "PRIMEVIDEO"],
    [/book\s*my\s*show|bookmyshow/gi,  "BOOKMYSHOW"],
    [/\bpvr\b|\binox\b|pvrinox/gi,     "PVRINOX"],
    [/cult\s*fit|cultfit|cure\s*fit/gi,"CULTFIT"],
    [/\bdominos\b|domino'?s/gi,        "DOMINOS"],
    [/mc\s*donald|mcdonalds/gi,        "MCDONALDS"],
    [/\bkfc\b/gi,                      "KFC"],
    [/\bstarbucks\b/gi,                "STARBUCKS"],
    [/\bzerodha\b/gi,                  "ZERODHA"],
    [/\bgroww\b/gi,                    "GROWW"],
    [/\bupstox\b/gi,                   "UPSTOX"],
    [/et\s*money|etmoney/gi,           "ETMONEY"],
    [/\bkuvera\b|\bcoin\b/gi,          "KUVERA"],
    [/\bjio\b|reliance\s*jio/gi,       "JIO"],
    [/\bairtel\b(?!\s*pay)/gi,         "AIRTEL"],
    [/\bvi\b|vodafone\s*idea|vodafoneidea/gi, "VODAFONEIDEA"],
    [/\bbsnl\b/gi,                     "BSNL"],
    [/act\s*fibernet|actfibernet/gi,   "ACTFIBERNET"],
    [/\bfastag\b|fas\s*tag/gi,         "FASTAG"],
    [/indian\s*oil|\biocl\b|bharat\s*petro|\bbpcl\b|\bhpcl\b|\bshell\b/gi, "FUEL"],
    [/\blic\b|life\s*insurance\s*corp/gi, "LIC"],
    [/policy\s*bazaar|policybazaar/gi, "POLICYBAZAAR"],
    [/\bapollo\b|\bpharmeasy\b|\b1mg\b|\bnetmeds\b/gi, "PHARMACY"],
    [/\bpracto\b/gi,                   "PRACTO"],
    [/\bdmart\b|d\s*mart|\bspencers\b|\breliance\s*fresh\b|\bmore\s*supermarket\b/gi,
                                       "SUPERMARKET"],

    /* ---- read from the UPI handle and the truncated payee ---------------
     *
     * Two fields on an Indian UPI line say who was paid, and until now only
     * the weaker one was being read. The bank truncates the payee name to
     * about eight characters, so a supermarket, a DTH provider and a municipal
     * corporation all arrive as a short string that reads like a person's
     * name -- and ordinary bills and canteen lunches were filed as payments to
     * people. The handle beside it is not truncated, and for a national
     * merchant it spells the brand out. It survives cleaning and nothing was
     * looking at it.
     *
     * Each entry below is written to match either spelling, so a merchant is
     * recognised from whichever of the two fields the bank filled in. */

    // Avenue Supermarts is DMart; "avenuefood" is a different payee entirely,
    // so the food handle is matched first and the grocery name after it.
    [/avenuefood|avenue\s*f(?=\s|$)/gi,  "CANTEEN"],
    [/avenue\s*supermarts?|avenuesuper/gi, "SUPERMARKET"],

    // DTH, cable and mobile recharge -- a bill either way, whichever of the
    // three it turns out to be.
    [/dish\s*tvq?r?|dishtvg?|\bdishtv\b/gi, "DTH"],
    [/tata\s*play|tataplay|\bvideocon\s*d2h\b|\bd2h\b|\bsun\s*direct\b/gi, "DTH"],

    // A staff canteen. Nothing in the narration means "food": the payee is
    // just a name, and only somebody who knows the account could say what it
    // is. That is the argument for letting a payee be labelled once by hand.
    [/brindava\w*/gi,                  "CANTEEN"],

    // Municipal bodies and state electricity boards. A municipal tax or a
    // power bill is a utility, and the payee name is always truncated.
    [/thane\s*munic\w*|thanemunic|\bmunicipal\s*corp\w*|\bnagar\s*nigam\b/gi, "CIVICBILL"],
    [/mahavitaran|\bmahavitr\w*|\bmsedcl\b|\bmseb\b|\btorrent\s*power\b/gi, "CIVICBILL"],
    [/\bbescom\b|\btsspdcl\b|\bapspdcl\b|\bpspcl\b|\buppcl\b|\bcesc\b/gi, "CIVICBILL"],

    // Schools and colleges. A card swipe writes the merchant's full
    // registered name, and nothing was reading it.
    [/narayana\s*educa\w*|\bvidyalaya\b|vidya\s*mandir|\bpublic\s*school\b/gi, "SCHOOLFEE"],
    [/\bjunior\s*college\b|\bdegree\s*college\b|\beducational\s*(society|trust|instit\w*)\b/gi,
                                       "SCHOOLFEE"],
  ];

  const RX_REF   = /\b[a-z0-9]*\d{6,}[a-z0-9]*\b/gi;   // reference ids
  const RX_PUNCT = /[\/\\|,;:_\-#*()\[\]{}<>"'.]+/g;

  /**
   * Merchant-only text: aliases applied, rails, ids and filler stripped.
   *
   * The recognised merchants are pulled out first and held aside by name, rather
   * than being tagged in the string and fished back out afterwards. An earlier
   * version re-collected them with a match on upper-case words, which of course
   * also collected every other upper-case word the bank had written -- so
   * "UPI/GOKUL APARTMENTS/gokul@okicici/House Rent/ICICI BANK/…" came back as
   * "gokul apartments icici bank gokul@okicici house rent" and the top-payee
   * list read like raw narration.
   */
  function cleanText(raw) {
    if (!raw) return "";
    let s = String(raw);

    const found = [];
    for (const [rx, tag] of ALIASES) {
      if (rx.test(s)) { found.push(tag.toLowerCase()); s = s.replace(rx, " "); }
      rx.lastIndex = 0;                       // these are /g, so reset the cursor
    }

    /* Split a merchant's name away from the reference number it is glued to.
     *
     * SBI writes card purchases as "OTHPG 600359195186SWIGGY BANGALORE". Every
     * token containing a digit is discarded below -- correctly, since those are
     * ids -- and without this line the shop's name goes out with the id. A
     * card purchase at a well-known chain read as an uncategorisable mystery
     * for exactly that reason. */
    s = s.replace(/(\d)([A-Za-z])/g, "$1 $2").replace(/([A-Za-z])(\d)/g, "$1 $2");

    let low = " " + s.toLowerCase().replace(RX_PUNCT, " ").replace(/@/g, " ") + " ";
    for (const r of RAILS) low = low.split(r).join(" ");

    const kept = low.split(/\s+/).filter(w =>
      w &&
      w.length > 2 &&                         // "ib", "mb", stray initials
      !/\d/.test(w) &&                        // any token with a digit is an id
      !FILLER.includes(w));

    // Merchant first, then whatever descriptive words survived. Capped, because
    // beyond four words it is narration again rather than a name.
    return [...new Set([...found, ...kept])].slice(0, 4).join(" ").trim();
  }

  /* ------------------------------------------------------------------ *
   * Rules
   * ------------------------------------------------------------------ */
  const R = (pattern, category, scope = "clean", note = "") =>
    ({ rx: new RegExp(pattern, "i"), category, scope, note });

  const RULES = [
    /* --- loans: before any name-based transfer rule ------------------ *
     * An EMI narration usually carries the account holder's own name, so a
     * self-transfer rule placed first would swallow every instalment and loan
     * repayment would disappear from spending entirely.                */
    R(String.raw`auto\s*loan.*emi|\bemi\b.*auto\s*loan|loan\s*account\s*payment`
      + String.raw`|\bhome\s*loan\s*emi\b|equated\s*month|\bedu\s*loan\b`
      + String.raw`|loan\s*repay|\bloan\s*instal|\bloan\b`,
      "EMI", "raw", "loan repayment"),

    /* --- deposits: also before the name rules ------------------------ *
     * A maturing deposit reads almost exactly like one being opened, and both
     * carry your name. Direction decides which it was -- see categorise().  */
    R(String.raw`\be[\s-]?tdr\b|\be[\s-]?stdr\b|term\s*deposit|fixed\s*deposit`
      + String.raw`|recurring\s*deposit|\brd\s*instal|\bfd\s*book`,
      "Investment-Deposit", "raw", "credits flip to FD/RD Redeemed"),

    /* --- money moving between your own accounts ---------------------- *
     * Not income, not spending. Counting it inflates both sides, and for
     * anyone who shuffles money between two or three banks it swamps the
     * real numbers completely.                                          */
    R(String.raw`\bself\s*(saving|transfer|acct|account|deposit|trf)\b`
      + String.raw`|\bown\s*account\b|\bto\s*self\b|\bown\s*transfer\b`
      + String.raw`|(?=.*\b(imps|neft|rtgs|tfr|transfer|p2a|mmt)\b).*\bself\b`,
      "Self Transfer", "raw"),

    /* Bank wording for "you moved your own money", which is not spending.
     *
     * Bank of India labels an outgoing own-account transfer "UAMBDeposit or
     * Inves", "UAMBSelf Saving" or "mySave" -- UAMB and UAIB being its mobile
     * and internet channels, not a payee. Left unmatched these are the single
     * largest block of Miscellaneous in a BOI statement, and every one of them
     * is money that never left the person's own name. "Deposit or Inves" in
     * particular is the bank's generic label on a transfer, not a description
     * of anything bought -- one such row was once guessed as tens of
     * thousands of rupees of shopping, which is the kind of wrong that makes
     * a whole report useless.
     */
    R(String.raw`\bua[im]b\s*(self|deposit|saving|inves|mysave)`
      + String.raw`|deposit\s*or\s*inves|\bmysave\b|\bself\s*saving\b`
      + String.raw`|\bfund\s*transfer\s*to\s*own\b|\btran\s*for\s*funding\b`,
      "Self Transfer", "raw", "BOI / SBI own-account wording"),
    R(String.raw`\bcc\s*paid\b|credit\s*card\s*(bill|payment|paid)`
      + String.raw`|\bcard\s*settlement\b|\bcred\s*club\b|\bautopay\s*cc\b`,
      "Credit Card Payment", "raw"),
    R(String.raw`\bcash\s*wdl|\batm\s*wdl|cash\s*withdraw|\bnfs\b.*wdl`
      + String.raw`|\batm\s*cash\b|\bcwdr\b`,
      "Cash Withdrawal", "raw"),

    /* Money sent out by cheque or a bank transfer with no payee worth reading.
     *
     * "WDL TFR" is ICICI's wording for an outgoing transfer and "CAS PRES CHQ"
     * for a cheque presented. Both say what happened -- money left by transfer
     * -- and nothing about what it bought, because nothing was bought. These
     * are the largest single amounts in a statement, and calling a six-figure
     * bank transfer "Miscellaneous spending" makes every chart on the page
     * wrong. Labelled for what the bank actually wrote, and kept out of
     * spending, where a claim about purpose would be invented. */
    /* Cheques only. "WDL TFR" used to live here and it was a mistake that took
     * a whole statement with it.
     *
     * It is ICICI's wording for an outgoing transfer, which is what this rule
     * was written from. But SBI prefixes *every* electronic debit with
     * "WDL TFR" -- withdrawal by transfer -- including every UPI payment to a
     * shop, and "DEP TFR" likewise on the credit side. Sitting up here, above
     * the merchant rules, it swallowed seven eighths of the rows in one real
     * statement: a two-figure payment to a grocer and a small municipal bill
     * both came out as "a transfer, purpose unstated" and were excluded from
     * spending altogether, so the month reported about an eighth of the debits
     * its own statement showed. The wording is handled at the bottom of this
     * list now,
     * where it can only speak if nothing else in the line does. */
    R(String.raw`\bcas\s*pres\s*chq\b|\bchq\s*paid\b`
      + String.raw`|\bclg\s*chq\b|\boutward\s*(clearing|cheque)\b`,
      "Transfer Out", "raw", "a cheque: the bank's own words"),

    /* --- tax and property -------------------------------------------- */
    R(String.raw`central\s*board\s*(of)?\s*direct\s*t|\bcbdt\b|income\s*tax`
      + String.raw`|\badvance\s*tax\b|\btds\b|self\s*assessment\s*tax`,
      "Tax", "raw"),
    R(String.raw`earnest\s*money|registration\s*(fee|charge)|sub\s*registrar`
      + String.raw`|stamp\s*duty|\bbuilder\b|\bmaintenance\s*(soc|society)`
      + String.raw`|society\s*maint`,
      "Property & Home", "raw"),

    /* --- investments -------------------------------------------------- */
    R(String.raw`etmoney|zerodha|groww|upstox|kuvera|\bbroker\b|indian\s*clearing`
      + String.raw`|\bnse\b|\bbse\b|\bdemat\b`, "Investment-Equity"),
    R(String.raw`\bsip\b|mutual\s*fund|\bmf\s*purchase|\bnav\b|\bamc\b`
      + String.raw`|\bnippon\b|\bhdfc\s*mf\b|\bsbi\s*mf\b|\baxis\s*mf\b`
      + String.raw`|\bicici\s*pru\b|\bparag\s*parikh\b|\bquant\s*mf\b`
      + String.raw`|\bmirae\b|\bcams\b|\bkfintech\b|\bbse\s*star\b`,
      "Investment-MF"),
    R(String.raw`\bgovtsaving\b|\bnps\b|\bppf\b|\bssy\b|\bkvp\b|\bnsc\b`,
      "Investment-Other"),
    R(String.raw`digital\s*gold|\bsafegold\b|augmont|\bmmtc\b|gold\s*bond|\bsgb\b`,
      "Investment-Gold"),

    /* --- household help: before the income rules ---------------------- *
     * "Maid salary" contains the word salary. Left to the income rule it
     * becomes money coming in, which is exactly backwards.                */
    R(String.raw`\bmaid\b|housekeep|\bservant\b|\bcook\b`
      + String.raw`|\b(driver|maid|cook|nanny)\s*salary\b`,
      "Maid & Help", "raw"),

    R(String.raw`\bfamily\b|\bfami\b|\bmaa\b|\bmother\b|\bfather\b|\bbaba\b`
      + String.raw`|\bparents?\b|\bhome\s*transfer\b`, "Family", "raw"),

    /* --- income -------------------------------------------------------- *
     * Payroll systems rarely write the word "salary". A very common Indian
     * format is "SAL JUL26:227288:" -- month, year, employee number. The
     * digits only survive in the untouched narration, which is what the
     * nospace scope is for; "sal" on its own would be far too loose.      */
    R(String.raw`\bsalary\b|\bsal\s*cr\b|payroll|\bwages\b|\bstipend\b`,
      "Salary", "raw"),
    R(String.raw`sal(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\d{2}`,
      "Salary", "nospace", "payroll credit written as SAL MMM YY"),
    R(String.raw`credit\s*interest|\bint\.?\s*pd\b|interest\s*paid|\bintt\b`
      + String.raw`|sbint\.?\s*pd|\bint\s*coll\b`, "Interest Income", "raw"),
    R(String.raw`\brefund\b|\bcashback\b|\breimburse|medical\s*aid`
      + String.raw`|\bdividend\b|\bbonus\b|\bpli\s*for\s*f\.?y`,
      "Other Income", "raw"),

    /* --- what the payment was for, and what kind of shop it was --------- *
     *
     * This block does most of the work, and it is the answer to the complaint
     * that everything ends up under Miscellaneous.
     *
     * Chain-store rules only ever recognise chains, and most of what an Indian
     * statement contains is not a chain. It is the caterer two streets away,
     * a sweet shop, a tea stall, a medical store with the owner's name over
     * the door -- shops no list will ever contain. But their *trade* is
     * written in the name, and a caterer sells food whoever owns it. So these
     * rules read the trade word rather than the brand.
     *
     * The second half reads the remark. A UPI narration carries a short
     * purpose field that the payer typed -- "Cold drink", "Haircut", "Xerox",
     * "Momo", "Water", "Repair pho" -- sitting in the middle of the line
     * between the payee and the sponsoring bank. It is the closest thing to a
     * label a bank statement ever contains, it is written by the person
     * themselves, and it was being thrown away.
     *
     * Both are matched against the cleaned text, so a bank name in the rail
     * segment cannot trigger them.
     */

    // Food: prepared food, eaten anywhere, from any kind of seller.
    R(String.raw`\bcaterer|\bcatering\b|\btiffin\b|\bdabba\b|\bmess\b`
      + String.raw`|\bdhaba\b|\brestaurant|\brestro\b|\bhotel\s*(and|&)?\s*rest`
      + String.raw`|\bcafe\b|\bcaf\b|\bchai\b|\btea\s*(stall|shop|corner|point)?\b`
      + String.raw`|\bcoffee\b|\bjuice\b|\bsweet|\bmithai\b|\bbakery\b|\bbakers\b`
      + String.raw`|\bconfection|\bdairy\b|\bdelicacy\b|\bdelicacies\b`
      + String.raw`|\bsnack|\bchaat\b|\bmomo\b|\bbiryani\b|\bpizza\b|\bburger\b`
      + String.raw`|\brolls?\b|\bparatha\b|\bthali\b|\bbhojan|\bbhavan\b`
      + String.raw`|\bcanteen\b|\bkitchen\b|\bfoods?\b|\beatery\b|\bdiner\b`
      + String.raw`|\bhospitalit`
      + String.raw`|\bcate\b|\bcater\b|\brestau\b|\bbaker\b|\bsweets?\b`
      + String.raw`|\bchicken\b|\bmutton\b|\bfish\b|\begg\b|\bpaneer\b`
      + String.raw`|\bbreakfast\b|\btiffin\b|\bjolparry\b|\bjalpan\b`
      + String.raw`|\bicecream\b|\bice\s*cream\b|\bcold\s*drink\b|\bwater\s*can\b`
      + String.raw`|\bbreakfast\b|\blunch\b|\bdinner\b|\bnashta\b`,
      "Food", "clean", "trade word, not a brand"),

    // Groceries: raw ingredients and the shops that sell them.
    R(String.raw`\bkirana\b|\bgeneral\s*store|\bprovision|\bsupermart\b`
      + String.raw`|\bspencers\b|\bretail\s*limited?\b|\bhypermarket\b`
      + String.raw`|\bsto\b|\bgener\b|\bkiran\b|\bprovis\b`
      + String.raw`|\bessential|\bdaily\s*need|\bsupplies\b`
      + String.raw`|\bsuper\s*market\b|\bdepartmental\b|\bmart\b(?!\s*ins)`
      + String.raw`|\bvegetable|\bsabzi\b|\bfruits?\b|\bmilk\b|\bdairy\s*farm\b`
      + String.raw`|\batta\b|\bmasala\b|\bgrocer`,
      "Groceries", "clean"),

    /* "Auto" in a remark is an auto-rickshaw -- the single most common thing
     * anyone in an Indian city pays for by UPI, and the payee is the driver,
     * so without this rule every one of them is filed as a payment to a
     * person. 123 of 290 travel rows in a six-month sample. "Auto Loan" is
     * safe: the EMI rule is tested first. Bikes here too -- a "bike" remark is
     * a bike taxi, not a motorcycle bill. */
    R(String.raw`\bauto\b|\bautp\b|\bauto\s*rickshaw\b|\brickshaw\b`
      + String.raw`|\bbike\b|\bola\s*bike\b|\bshare\s*auto\b|\btoto\b`,
      "Travel-Local", "clean", "an auto is a ride, and the payee is its driver"),
    R(String.raw`\bticket\b|\bticket\s*book|\bpnr\b`, "Travel-Outstation", "clean"),

    // Getting about. Indian Railways UTS is the suburban ticket app; Chalo is
    // the bus-pass one. Both are commuting, not a holiday.
    R(String.raw`\brailway|\birctc\b|\bmetro\b|\buts\b|\blocal\s*train\b|\bchalo\s*mob`
      + String.raw`|\bchalo\s*mobility\b|\bbus\s*(pass|ticket|fare)?\b`
      + String.raw`|\bmsrtc\b|\bksrtc\b|\btsrtc\b|\bmetro\w*`
      + String.raw`|\brickshaw\b|\bauto\s*fare\b|\btaxi\b|\btoll\b|\bparking\b`,
      "Travel-Local", "clean"),
    R(String.raw`\bflight\b|\bairlines?\b|\bairways\b|\btrip\s*jack\b`
      + String.raw`|\btripjack\b|\byatra\b|\beasemytrip\b|\bixigo\b`
      + String.raw`|\bresort\b|\blodge\b|\bhomestay\b|\bguest\s*house\b`
      + String.raw`|\blounge\b`,
      "Travel-Outstation", "clean", "an airport lounge is not a restaurant"),
    R(String.raw`\bindiahikes\b|\btrek\w*|\bhikes?\b|\bcamping\b|\bexpedition\b`,
      "Trip", "clean"),

    // Health. "medicos" and "medical stores" are how most Indian chemists are
    // named; neither contains the word pharmacy.
    /* Truncated trade words and the remark, both.
     *
     * A bank cuts the payee to about ten characters, so "VIJAY MEDICAL" arrives
     * as "VIJAY MEDI" and "UNITED MEDICOS" as "UNITED MED" -- a rule looking
     * for the whole word never fires. And the payer's own remark frequently
     * says "Meds", which is the plainest label a statement will ever carry. */
    R(String.raw`\bmeds?\b|\bmedi\b|\bmedic\b|\bmedis\b|\bchemis\b`
      + String.raw`|\bpharm\b|\bhospi\b|\bclini\b|\bdiagno\b|\bpatho\b`
      + String.raw`|frank\s*ross|\bdavaindia\b|\bwellness\s*forever\b`
      + String.raw`|\bmedplus\b|\bnetmeds\b|\bdoctor\b|\bdental\b`,
      "Health & Medical", "clean", "truncated names, and the remark"),
    R(String.raw`\bmedico|\bmedical\b|\bmedicine|\bchemist\b|\bdrug\s*(house|store)`
      + String.raw`|\bpharma|\bhospital\b|\bnursing\s*home\b|\bclinic\b`
      + String.raw`|\bdiagnost|\bpatholog|\bdental\b|\bdentist\b|\boptic`
      + String.raw`|\bspectacle|\bphysio|\bayurved|\bhomeo|\bdoctor\b|\bdr\.\s`,
      "Health & Medical", "clean"),

    // Haircuts and the like. Its own bucket rather than Shopping, because the
    // amounts are small and regular and it reads oddly under either Health or
    // Shopping.
    R(String.raw`\bsalon\b|\bparlour\b|\bparlor\b|\bbarber\b|\bhaircut\b`
      + String.raw`|\bgrooming\b|\bspa\b|\bbeauty\b|\bunisex\b|\bnail\s*art\b`,
      "Personal Care", "clean"),

    // Learning. Coaching apps and institutes are a large line in a lot of
    // Indian statements and almost never say "education".
    R(String.raw`\bphysicswal|\bunacademy\b|\bbyjus?\b|\bvedantu\b|\btoppr\b`
      + String.raw`|\bcoaching\b|\btuition\b|\binstitute\b|\bacademy\b`
      + String.raw`|\bclasses\b|\biibf\b|\bjaiib\b|\bcaiib\b|\bexam\w*`
      + String.raw`|\badmission\b|\bsemester\b`
      + String.raw`|\bhostel\b|\bstudy\b`
      // schoolfee: a school or college, usually swiped on a card, where the
      // merchant name is written out in full and nothing was reading it. A
      // term's fees was the single largest unclassified row in one file.
      + String.raw`|schoolfee|\bschool\b|\bcollege\b|\bvidyalaya\b`
      + String.raw`|\btuition\s*fee\b|\bschool\s*fee\b`,
      "Education", "clean"),

    // Software and services billed monthly. These are subscriptions whatever
    // they are for, and grouping them is the point -- the annual total is the
    // number that changes behaviour.
    R(String.raw`\bopenai\b|\banthropic\b|\bclaude\b|\bchatgpt\b|\bgithub\b`
      + String.raw`|\bplaystore\b|\bgoogle\s*play\b|\bapp\s*store\b|\bicloud\b`
      + String.raw`|\bgodaddy\b|\bhosting\b|\bdomain\s*renew|\bnamecheap\b`
      + String.raw`|\bhostinger\b|\bcanva\b|\bnotion\b|\bfigma\b|\bzoom\b`
      + String.raw`|\bmandateexe\b|\blinkedin\b|\bbumble\b|\btinder\b`
      + String.raw`|\brentomojo\b|\bfurlenco\b|\bcityfurnish\b`
      + String.raw`|\bshaadi|\bmatrimony\b|\bjeevansathi\b`,
      "Subscriptions", "clean"),

    // Things bought. Trade words again, plus the department stores.
    R(String.raw`\bxerox\b|\bprint|\bstationer|\bbook\s*(stall|shop|store)\b`
      + String.raw`|\btanishq\b|\bjewell?er|\bwatch\s*(co|shop)\b|\btitan\b`
      + String.raw`|\blife\s*style\b|\bshoppers\s*stop\b|\bwestside\b`
      + String.raw`|\bpantaloons\b|\breliance\s*trends\b|\bcroma\b`
      + String.raw`|\bvijay\s*sales\b|\bfurniture\b|\brentomojo\b|\bfurlenco\b`
      + String.raw`|\bgarment|\bboutique\b|\bfootwear\b|\bsaree\b|\btailor\b`
      + String.raw`|\bmobile\s*(park|shop|store|care)\b|\brepair\b|\bhardware\b`
      + String.raw`|\belectronics\b|\bcottage\s*ind`
      + String.raw`|\bbooks?\b|\bcraft\b|\bart\s*materi|\bstation`
      + String.raw`|\bkhadim|\bbata\b|\bliberty\s*shoe|\bmetro\s*shoe`,
      "Shopping", "clean"),

    // Where you live. A society or apartment name on a transfer is almost
    // always rent or maintenance.
    R(String.raw`\bapartment|\bapartments\b|\bsociety\b|\bchs\b|\bco\s*op\s*hsg`
      + String.raw`|\bhousing\b|\bmaintenance\b|\bproperties\b|\brealty\b`
      + String.raw`|\bestate\b|\bbroker\s*fee\b|\bpg\s*owner\b|\blandlord\b`,
      // "raw", because a wrapped narration can push the telling word past the
      // four-token limit the cleaner keeps: "PRAK RITI APARTMENT" cleans down
      // to "prak riti" and the word that names it is the one that is lost.
      "Rent", "raw"),

    /* --- merchants ------------------------------------------------------ */
    R(String.raw`swiggyinstamart|blinkit|zepto|bigbasket|supermarket|dunzo`
      + String.raw`|\bgrocery\b|\bkirana\b|\bvegetable`, "Groceries"),
    R(String.raw`swiggy|zomato|dominos|mcdonalds|\bkfc\b|starbucks|swiggygenie`
      + String.raw`|\bcafe\b|\brestaurant\b|\bbakery\b|\bbiryani\b|\bfood\b`
      // canteen: a staff canteen and a payee whose UPI handle contains "food"
      + String.raw`|canteen|\bmess\b|\btiffin\b|\bdhaba\b|\bhotel\s*mess\b`,
      "Food"),
    R(String.raw`\buber\b|olacabs|rapido|namma|\bmetro\b|\bauto\s*fare\b`
      + String.raw`|\bcab\b|\bbmtc\b|\bbest\b|\btoll\b`, "Travel-Local"),
    R(String.raw`irctc|redbus|makemytrip|goibibo|cleartrip|indigo|spicejet`
      + String.raw`|vistara|airindia|\bairport\b|\bhotel\b|\boyo\b|\bairbnb\b`,
      "Travel-Outstation"),
    R(String.raw`netflix|hotstar|spotify|primevideo|\byoutube\s*prem`
      + String.raw`|\bsubscription\b|\bapple\.com\b|\bgoogle\s*storage\b`,
      "Subscriptions"),
    R(String.raw`bookmyshow|pvrinox|\bcinema\b|\bgaming\b|\bsteam\b`,
      "Entertainment"),
    R(String.raw`amazon|flipkart|myntra|ajio|meesho|nykaa|decathlon`
      + String.raw`|\bshopping\b|\bstore\b|\blifestyle\b|\bshoppers\b`, "Shopping"),
    R(String.raw`cultfit|\bgym\b|\byoga\b|\bfitness\b`, "Fitness"),
    R(String.raw`pharmacy|practo|\bhospital\b|\bclinic\b|\bdiagnost|\bmedical\b`
      + String.raw`|\bdoctor\b|\bdental\b|\blab\b`, "Health & Medical"),
    R(String.raw`\bmotors?\b|\bautomobile|\bcar\b|\bscooter\b`
      + String.raw`|\btyre|\bpuncture\b|\bgarage\b|\bworkshop\b`,
      "Car & Fuel", "clean"),
    R(String.raw`\bfuel\b|\bpetrol\b|\bdiesel\b|fastag|\bservicing\b`
      + String.raw`|\bparking\b|\bcar\s*wash\b`, "Car & Fuel"),
    R(String.raw`\belectricity\b|\bbescom\b|\bmseb\b|\bwbsedcl\b|tataplay`
      + String.raw`|\bgas\s*bill\b|\bpng\b|\bwater\s*bill\b|\bbill\s*pay`
      // civicbill: a municipal body or a state electricity board, recognised
      // from the truncated payee or from the UPI handle. Two dozen payments
      // to one municipal corporation were filed as payments to a person
      // before this.
      + String.raw`|civicbill|\bproperty\s*tax\b|\bwater\s*tax\b`,
      "Bills-Utilities"),
    R(String.raw`jio|airtel|vodafoneidea|bsnl|actfibernet|broadband|\bwifi\b`
      // dth: Dish TV, Tata Play, d2h and the rest -- a DTH or cable
      // subscription is a bill in the same way a broadband line is.
      + String.raw`|\brecharge\b|\bdth\b|\bcable\s*tv\b`, "Internet & Mobile"),
    R(String.raw`\binsurance\b|\blic\b|policybazaar|\bpremium\b|\bhealth\s*cover\b`,
      "Insurance"),
    R(String.raw`\bschool\b|\bcollege\b|\btuition\b|\bcourse\b|\budemy\b`
      + String.raw`|\bcoursera\b|\bexam\s*fee\b|\bguitar\b|music\s*(class|lesson)`,
      "Education"),
    R(String.raw`\bmaid\b|housekeep|\bservant\b|\bcook\b|\bdriver\s*salary\b`,
      "Maid & Help"),
    R(String.raw`\bdonation\b|\btemple\b|\bgift\b|\bcharity\b|\bngo\b`
      + String.raw`|\bpuja\b|\bpooja\b|\bsamagri\b|\bprasad\b|\bmandir\b`,
      "Gifts & Donations"),
    R(String.raw`\bpet\b|\bvet\b|\bdog\s*food\b|\bpetshop\b`, "Pets"),
    R(String.raw`\brent\b|\broom\s*rent\b|\bhouse\s*rent\b`, "Rent"),
    R(String.raw`\bcharge[sd]?\b|\bfee[s]?\b|\bgst\b|\bpenalty\b|sms\s*chg`
      + String.raw`|\bamc\s*charge\b|\bmin\s*bal\b`, "Fees & Charges"),

    /* Last of all: SBI's plain "TO TRANSFER" with nothing else to go on.
     *
     * It sits at the bottom on purpose. Every rule above gets first refusal,
     * so a transfer that is really a loan instalment, a deposit or a payment to
     * a named merchant keeps its proper label; only the ones where the bank
     * wrote nothing but "money left by transfer" end up here. Where the
     * narration also carries the account holder's own name, categorise() then
     * upgrades this to Self Transfer. */
    R(String.raw`\bto\s*transfer\b|\bfund\s*transfer\b|\btfr\s*to\b`,
      "Transfer Out", "raw", "the bank wrote only that money moved"),

    /* A standing instruction. SBI's "DIRECT DR" is a mandate it debits on your
     * behalf -- an insurance premium, a SIP, a loan instalment. What it is for
     * is not written anywhere in the line, and inventing a purpose would be
     * worse than admitting there isn't one. But it is a recurring commitment
     * rather than loose spending, and calling it "miscellaneous" hides the
     * largest regular payment in a statement: a dozen identical five-figure
     * debits over a year sat unlabelled in one real file. */
    R(String.raw`\bdirect\s*dr\b|\bstanding\s*instruction\b|\bsi\s*debit\b`
      + String.raw`|\bmandate\s*debit\b`,
      "Standing Instruction", "raw", "a mandate the bank debits for you"),

    /* Last of all: the bank said money moved by transfer and nothing else.
     *
     * Every rule above has had first refusal, and the person test after this
     * has not run yet -- so reaching here means there is no merchant, no
     * payee, no UPI handle and no trade word anywhere in the line. Only then
     * is "WDL TFR" actually the whole story. The negative look-ahead is what
     * keeps it honest: one UPI reference in the line and this rule stays
     * silent, because the payee is the answer, not the rail. */
    R(String.raw`^(?!.*(\bupi\b|\bimps\b|\bneft\b|\brtgs\b|@|paid\s*to))`
      + String.raw`(?=.*\b(wdl|dep)\s*tfr\b)`,
      "Transfer Out", "raw", "a transfer with nothing else in the line"),
  ];

  /**
   * First rule that fires wins.
   * Returns { category, rule } or { category: null }.
   */
  function applyRules(clean, raw) {
    clean = clean || "";
    const combined = raw ? `${clean} ${raw}` : clean;
    if (!combined.trim()) return { category: null };
    const nospace = String(raw || clean).toLowerCase().replace(/\s+/g, "");
    /* Merchant rules are tested against the cleaned text and against the same
     * text with its spaces removed. Banks wrap long narrations mid-word, so a
     * shop arrives as "SPEN CERS RETAIL" or a name as "SHAR MA KUMAR", and
     * a rule looking for the whole word never fires. Squashing the spaces
     * costs nothing and rescues a row that would otherwise be a mystery. */
    const squashed = clean.replace(/\s+/g, "");
    for (const r of RULES) {
      if (r.scope === "raw")     { if (r.rx.test(combined)) return { category: r.category, rule: r }; continue; }
      if (r.scope === "nospace") { if (nospace && r.rx.test(nospace)) return { category: r.category, rule: r }; continue; }
      if (clean && r.rx.test(clean)) return { category: r.category, rule: r };
      if (squashed && r.rx.test(squashed)) return { category: r.category, rule: r };
    }
    return { category: null };
  }

  /**
   * Categorise one row. `amount` is positive for money going out.
   *
   * Direction settles the deposit ambiguity: paying into a fixed deposit is an
   * investment, and the same words on a credit mean the deposit was broken --
   * which is not income, it is your own savings coming back.
   */
  /**
   * Does this look like money handed to a person rather than a business?
   *
   * "Miscellaneous" is the least useful thing a report can say, and a large
   * part of what lands there is not a mystery at all -- it is a UPI payment to
   * somebody's name. Saying so is a real answer: knowing that a sixth of the
   * year went to individuals is worth something, where "uncategorised" is
   * worth nothing.
   *
   * The test is that the payee reads as a name and the handle is personal --
   * a phone number or a name, rather than the paytmqr / Q-code / .rzp handles
   * that a shop is issued. Business words veto it outright, because plenty of
   * firms are named after their founder.
   */
  /**
   * A transfer carrying the account holder's own name.
   *
   * `row.holder` is read out of the statement's own header by parse.js. When a
   * NEFT, IMPS or "TO TRANSFER" line also carries that name, the money went to
   * another account in the same name -- it is not a payment to anybody and
   * counting it as spending is what produced a spent figure in lakhs on an
   * account that saw four actual purchases.
   *
   * Two deliberate limits. It only applies to transfer narrations, never to a
   * UPI payment to a shop, because a merchant's name occasionally collides
   * with a person's. And it runs only after every other rule has declined, so
   * a loan instalment or a deposit that happens to carry the name is still
   * recognised as what it is.
   *
   * The honest caveat: a transfer to a different person who shares your
   * surname reads as your own. If that matters, add a rule for that payee
   * higher up this list, where the first match wins.
   */
  const TRANSFER_VERB = /neft|imps|rtgs|\btfr\b|transfer|\bp2a\b|\bmmt\b|\bwdl\b/i;

  function ownNameTransfer(row) {
    const holder = row.holder;
    if (!holder || !row.description) return false;
    const raw = String(row.description);
    if (!TRANSFER_VERB.test(raw)) return false;

    // Spaces removed on both sides: banks wrap long narrations mid-word, so
    // the name arrives as "SHAR MA KUMAR" or "SHARMA KUM AR".
    const flat = raw.toLowerCase().replace(/[^a-z]/g, "");
    const parts = holder.toLowerCase().split(/\s+/).filter(Boolean);
    if (flat.includes(parts.join(""))) return true;
    return parts.some(p => p.length >= 6 && flat.includes(p));
  }

  const BUSINESSY =/\b(store|stores|shop|traders?|enterprise|enterprises|agency|agencies|services|solutions|industries|company|corporation|technolog|systems|foods?|caterer|centre|center|works|associates|consult|pvt|private|limited|ltd|llp|inc|co)\b/i;
  const MERCHANT_HANDLE = /paytmqr|paytm-|\bq\d{6,}|\.rzp\b|razorpay|billdesk|payu|bharatpe|\bqr\d/i;

  function looksLikeAPerson(clean, raw) {
    if (!clean || BUSINESSY.test(clean)) return false;
    if (MERCHANT_HANDLE.test(raw || "")) return false;
    // A UPI or IMPS line, not a card swipe or a bill payment
    /* No \b around neft/imps: Bank of India writes "UNAWBNEFT" and "UNAMBNEFT"
     * as one word, so a word-boundary match never sees the NEFT inside it and
     * four real payments a month fell straight through to Miscellaneous. */
    /* `\s*` not `\s+`: a PDF draws "Paid to" as one run with no space between
     * the words, so a rule demanding one silently stopped recognising people
     * in every PDF -- 380 payments to named individuals came out as
     * Miscellaneous in a file whose CSV twin classified them correctly. */
    if (!/\bupi\b|imps|neft|rtgs|paid\s*to\b|sent\s*to\b|\bp2p\b/i.test(raw || "")) return false;
    const words = clean.split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 4) return false;
    return words.every(w => /^[a-z]+$/.test(w) && w.length >= 3);
  }

  function categorise(row) {
    const clean = cleanText(row.description);
    let { category } = applyRules(clean, row.description);
    let source = category ? "rule" : "unmatched";
    if ((!category || category === "Transfer Out") && ownNameTransfer(row)) {
      category = "Self Transfer";
      source = "a transfer carrying your own name";
    }
    if (!category && row.amount > 0 && looksLikeAPerson(clean, row.description)) {
      category = "Person-to-Person";
      source = "paid to a person";
    }
    if (!category) category = "Miscellaneous";
    if (category === "Investment-Deposit" && row.amount < 0) {
      category = "FD/RD Redeemed";
      source = "rule (credit = deposit broken)";
    }
    // An unmatched credit is far more likely to be income than an expense.
    if (source === "unmatched" && row.amount < 0) category = "Other Income";

    /* Keep the sign and the category telling the same story.
     *
     * A hand-kept sheet with one unsigned amount column says nothing about
     * direction, so a row reading "DEP TFR INB Refund of…" arrived as money
     * going out while the rules correctly called it income. Everything
     * downstream trusts that income rows are negative, so a month's "Money in"
     * came out as a *negative* number -- impossible, on the front page.
     *
     * The correction only applies where the file gave no direction of its own.
     * Where a bank did print debit and credit columns, they are the authority
     * and a rule never overrides them. */
    if (row.unsigned && row.amount > 0 && flowOf(category) === INCOME)
      row = { ...row, amount: -row.amount };
    return { ...row, clean, category, source, major: majorOf(category),
             flow: flowOf(category), group: groupOf(category) };
  }

  MSP.rules = { CATEGORIES, EXPENSE, INCOME, INVESTMENT, MAJOR, RULES, TRANSFER,
                applyRules, categorise, cleanText, flowOf, groupOf, majorOf };
})(window.MSP = window.MSP || {});
