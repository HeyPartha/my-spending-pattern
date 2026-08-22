/*
 * A made-up year of transactions, so the page has something real to show
 * before anyone uploads anything.
 *
 * This is invented data about an invented person. It is generated from a fixed
 * seed so the demo looks the same on every visit and every device, which makes
 * it possible to screenshot, to explain, and to spot when a change to the
 * analysis code alters a number that should not have moved.
 *
 * It is written to be *awkward* on purpose, because a demo built from tidy data
 * proves nothing. It contains: a salary that changes mid-year, two loan
 * instalments, four subscriptions, money shuttled between two of the person's
 * own accounts, a fixed deposit opened and later broken, one failed standing
 * instruction with its reversal, a holiday that wrecks one month, and a
 * scattering of small cash-like payments.
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

  /* A tiny deterministic generator -- mulberry32. Math.random() would make the
   * demo different on every reload, and then no two screenshots would match. */
  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  const NAMES = {
    food: ["UPI/SWIGGY/swiggy.rzp@axl/PayviaRazo/AIRTEL PAY/{ref}/IBL{hex}",
           "UPI/ZOMATO LTD/zomatoorder.rz/Order/YES BANK/{ref}/YESB{hex}",
           "UPI/DOMINOS PIZZA/dominos@ybl/Food/HDFC BANK/{ref}/IBL{hex}",
           "UPI/CAFE COFFEE/ccd.merchant@/Cafe/ICICI BANK/{ref}/IBL{hex}",
           "UPI/ANNAPURNA MESS/annapurna@okax/Food/AXIS BANK/{ref}/UTIB{hex}"],
    grocery: ["UPI/SWIGGY INSTAMART/instamart.rz/Grocery/AIRTEL PAY/{ref}/IBL{hex}",
              "UPI/BLINKIT/blinkit@ybl/Grocery/YES BANK/{ref}/YESB{hex}",
              "UPI/DMART READY/dmart@hdfcbank/Supermarket/HDFC BANK/{ref}/HDFC{hex}",
              "UPI/SRI LAKSHMI STORES/lakshmi@paytm/Kirana/PAYTM PAYM/{ref}/PYTM{hex}"],
    local: ["UPI/UBER INDIA/uber.rzp@icici/Cab/ICICI BANK/{ref}/IBL{hex}",
            "UPI/RAPIDO/rapido@ybl/Bike/YES BANK/{ref}/YESB{hex}",
            "UPI/NAMMA METRO/bmrcl@sbi/Metro/STATE BANK/{ref}/SBIN{hex}",
            "UPI/AUTO FARE/driver8821@okhd/Auto/HDFC BANK/{ref}/HDFC{hex}"],
    shop: ["UPI/AMAZON PAY INDIA/amazon@apl/Shopping/AXIS BANK/{ref}/UTIB{hex}",
           "UPI/FLIPKART/flipkart.hypg@/Shopping/YES BANK/{ref}/YJP{hex}",
           "UPI/MYNTRA DESIGNS/myntra@ybl/Clothing/YES BANK/{ref}/YESB{hex}",
           "UPI/DECATHLON SPORTS/decathlon@hdfc/Sports/HDFC BANK/{ref}/HDFC{hex}"],
    health: ["UPI/APOLLO PHARMACY/apollo@ybl/Pharmacy/YES BANK/{ref}/YESB{hex}",
             "UPI/PRACTO/practo@icici/Consultation/ICICI BANK/{ref}/IBL{hex}"],
    fuel: ["UPI/INDIAN OIL/iocl@sbi/Fuel/STATE BANK/{ref}/SBIN{hex}",
           "BIL/FASTAG RECHARGE/{ref}/NETC"],
    ent: ["UPI/BOOKMYSHOW/bms@icici/Movie/ICICI BANK/{ref}/IBL{hex}",
          "UPI/PVR INOX/pvr@hdfcbank/Cinema/HDFC BANK/{ref}/HDFC{hex}"],
  };

  const hex = r => Math.floor(r() * 0xffffffff).toString(16).padStart(8, "0");
  const ref = r => String(Math.floor(r() * 9e11 + 1e11));
  const pick = (r, a) => a[Math.floor(r() * a.length)];
  const fill = (r, tpl) => tpl.replace("{ref}", ref(r)).replace("{hex}", hex(r));
  const money = (r, lo, hi) => Math.round((lo + r() * (hi - lo)) / 5) * 5;
  const D = (y, m, d) => new Date(Date.UTC(y, m - 1, Math.min(d, 28)));

  /**
   * Twelve months ending last month, so the demo never shows a part-month at the
   * end and never looks stale.
   */
  function demoRows(endDate = new Date()) {
    const r = rng(20260401);
    const rows = [];
    const push = (date, description, amount, balance = null) =>
      rows.push({ date, description, amount, balance });

    const end = new Date(Date.UTC(endDate.getUTCFullYear(),
                                  endDate.getUTCMonth(), 1));
    const months = [];
    for (let i = 12; i >= 1; i--) {
      const d = new Date(end); d.setUTCMonth(d.getUTCMonth() - i + 1);
      months.push([d.getUTCFullYear(), d.getUTCMonth() + 1]);
    }
    const MON = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
    const holiday = months[7];        // one month gets a holiday in it

    months.forEach(([y, m], mi) => {
      /* --- salary: a raise two thirds of the way through the year ------- */
      const pay = mi < 8 ? 98500 : 114200;
      push(D(y, m, 28), `SAL ${MON[m - 1]}${String(y).slice(2)}:118824:`,
           -(pay + Math.round(r() * 900)));

      /* --- fixed monthly commitments ------------------------------------ */
      push(D(y, m, 5), "BIL/Auto Loan XX41822 EMI/LOAN ACCOUNT PAYMENT", 11240);
      push(D(y, m, 2), "ACH D- EDUCATION LOAN INSTALMENT 2211948", 7500);
      push(D(y, m, 1), "UPI/GOKUL APARTMENTS/gokul@okicici/House Rent/ICICI BANK/"
           + `${ref(r)}/IBL${hex(r)}`, 21000);
      push(D(y, m, 7), "ACH D- NIPPON INDIA MF SIP 8841002", 4000);
      push(D(y, m, 7), "ACH D- PARAG PARIKH FLEXI SIP 4410", 2500);
      push(D(y, m, 12), "UPI/NETFLIX ENTERTAINMENT/netflix@ybl/Subscription/"
           + `YES BANK/${ref(r)}/YESB${hex(r)}`, 649);
      push(D(y, m, 14), "UPI/SPOTIFY INDIA/spotify@icici/Subscription/"
           + `ICICI BANK/${ref(r)}/IBL${hex(r)}`, 149);
      push(D(y, m, 18), "UPI/DISNEY HOTSTAR/hotstar@hdfcbank/Subscription/"
           + `HDFC BANK/${ref(r)}/HDFC${hex(r)}`, 299);
      push(D(y, m, 9), `BIL/JIO PREPAID RECHARGE/${ref(r)}/JIO`, 399);
      push(D(y, m, 10), `BIL/BESCOM ELECTRICITY/${ref(r)}/BESCOM`,
           money(r, 900, 2400));
      push(D(y, m, 11), "UPI/ACT FIBERNET/actcorp@icici/Broadband/"
           + `ICICI BANK/${ref(r)}/IBL${hex(r)}`, 1180);
      push(D(y, m, 3), "UPI/LAKSHMI DEVI/lakshmi.d@okaxis/Maid salary/"
           + `AXIS BANK/${ref(r)}/UTIB${hex(r)}`, 4500);
      if (m % 3 === 1)
        push(D(y, m, 21), `BIL/LIC OF INDIA PREMIUM/${ref(r)}/LICI`, 8412);

      /* --- day to day ---------------------------------------------------- */
      const isHoliday = y === holiday[0] && m === holiday[1];
      const meals = 16 + Math.floor(r() * 9);
      for (let i = 0; i < meals; i++)
        push(D(y, m, 1 + Math.floor(r() * 27)), fill(r, pick(r, NAMES.food)),
             money(r, 90, 620));
      for (let i = 0; i < 7 + Math.floor(r() * 4); i++)
        push(D(y, m, 1 + Math.floor(r() * 27)), fill(r, pick(r, NAMES.grocery)),
             money(r, 240, 2300));
      for (let i = 0; i < 12 + Math.floor(r() * 8); i++)
        push(D(y, m, 1 + Math.floor(r() * 27)), fill(r, pick(r, NAMES.local)),
             money(r, 35, 420));
      for (let i = 0; i < 2 + Math.floor(r() * 4); i++)
        push(D(y, m, 1 + Math.floor(r() * 27)), fill(r, pick(r, NAMES.shop)),
             money(r, 350, 4200));
      for (let i = 0; i < 2 + Math.floor(r() * 3); i++)
        push(D(y, m, 1 + Math.floor(r() * 27)), fill(r, pick(r, NAMES.fuel)),
             money(r, 500, 2600));
      if (r() > 0.35)
        push(D(y, m, 1 + Math.floor(r() * 27)), fill(r, pick(r, NAMES.ent)),
             money(r, 300, 1500));
      if (r() > 0.55)
        push(D(y, m, 1 + Math.floor(r() * 27)), fill(r, pick(r, NAMES.health)),
             money(r, 200, 3200));

      /* --- money moved to his own second account, and back sometimes ----- */
      const moved = money(r, 8000, 20000);
      push(D(y, m, 6), `IMPS/SELF SAVING TRANSFER/${ref(r)}/OWN ACCOUNT`, moved);
      if (r() > 0.6)
        push(D(y, m, 20), `IMPS/SELF SAVING TRANSFER/${ref(r)}/OWN ACCOUNT`, -moved);

      /* --- the holiday, which wrecks one month --------------------------- */
      if (isHoliday) {
        push(D(y, m, 6), `UPI/MAKEMYTRIP INDIA/makemytrip@icici/Flight/ICICI BANK/${ref(r)}/IBL${hex(r)}`, 34800);
        push(D(y, m, 9), `UPI/OYO ROOMS/oyo@ybl/Hotel/YES BANK/${ref(r)}/YESB${hex(r)}`, 18600);
        push(D(y, m, 11), `UPI/GOA SHACK CAFE/shack@okaxis/Food/AXIS BANK/${ref(r)}/UTIB${hex(r)}`, 4200);
        push(D(y, m, 12), `UPI/SCOOTER RENTAL/rent@paytm/Travel/PAYTM PAYM/${ref(r)}/PYTM${hex(r)}`, 2400);
      }
    });

    /* --- one-off events, placed by hand so the demo always contains them - */
    const [ly, lm] = months[3];
    push(D(ly, lm, 15), "TERM DEPOSIT 0011223344 OPENED E-TDR", 90000);
    const [by, bm] = months[10];
    push(D(by, bm, 8), "E-TDR 0011223344 CLOSED PROCEEDS", -93070);

    // A standing instruction that failed and was reversed the same morning.
    // Without matching these two the month shows a phantom expense and an equal
    // phantom windfall -- and the instalment looks paid when it was not.
    const [fy, fm] = months[9];
    const failRef = "600100200300";
    push(D(fy, fm, 2), `ACH D- EDUCATION LOAN INSTALMENT ${failRef}`, 7500);
    push(D(fy, fm, 2), `REV/ACH D- EDUCATION LOAN INSTALMENT ${failRef}/RETURN`, -7500);
    push(D(fy, fm, 4), `NEFT/EDUCATION LOAN/${ref(r)}/LOAN ACCOUNT PAYMENT`, 7500);

    const [ry, rm] = months[6];
    push(D(ry, rm, 22), `NEFT/INCOME TAX REFUND AY 2025-26/${ref(r)}/CBDT`, -18240);
    const [cy, cm] = months[2];
    push(D(cy, cm, 17), `ATM CASH WDL/${ref(r)}/HDFC ATM KORAMANGALA`, 10000);

    rows.sort((a, b) => a.date - b.date);

    // A running balance, so the demo looks like a real statement rather than a
    // list. Starts at a plausible opening figure and follows the rows.
    let bal = 84200;
    for (const row of rows) { bal -= row.amount; row.balance = Math.round(bal * 100) / 100; }
    return rows;
  }

  MSP.demo = { demoRows };
})(window.MSP = window.MSP || {});
