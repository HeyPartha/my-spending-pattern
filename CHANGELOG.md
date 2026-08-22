# Changelog

Every entry is one upload to the live site. The number matches the `CACHE`
constant in `sw.js` and the build stamp in the page footer, so any device can be
checked against this list at a glance.

Builds 1-6 were reconstructed from the working history after the fact; from
build 7 onwards each entry was written as the work was done.

---

## v13 - the wrong word won, and one line from a friend fixed 127 rows

Two banks use the same three letters to mean different things, and the app
believed the wrong one. **SBI prefixes every electronic debit with "WDL TFR"**
- withdrawal by transfer - including every UPI payment to a shop. ICICI uses it
only for a genuine bank transfer, and that is the meaning the rule was written
from. Sitting above the merchant rules, it swallowed **540 of 623 rows in one
statement**: a two-figure payment to a grocer and a municipal bill of about the
price of a bus fare both came out as "a transfer, purpose unstated" and were
dropped from spending. One month **reported an eighth of what the statement's
own debit column said had gone out, and about one percent of its credits.**

The wording now sits at the very bottom of the rule list behind a negative
look-ahead: one UPI reference anywhere in the line and it stays silent, because
the payee is the answer and the rail is not.

**The narration was also being stapled to the wrong transaction.** SBI prints
the type on the line *above* the dated row; every other bank wraps downwards.
Assuming downwards hands each row its neighbour's type word and takes its own
away. This is not guessed per bank - a type word says which way the money went,
and the debit and credit columns say the same thing independently, so the app
tries both directions and keeps whichever agrees with those columns more often.
**Above agreed 599 times out of 599; below agreed 509.** Afterwards every marker
in the file sits on the row that earned it: 598 right, 0 wrong.

That defect had a visible symptom. A five-figure **withdrawal** was handed the
next row's words "DEP TFR INB Refund of", the rules read "Refund", and a month's
**"Money in" displayed as a negative number**. An impossible figure on the front
page. Fixed at the source, and "Money in" can no longer go below zero whatever
happens upstream - if a row cannot be resolved the tile says so instead.

**And the app now says what it left out.** A "Spent" figure an order of
magnitude below the statement's own debit column is where trust is lost. Transfers between your own
accounts are still kept out of spending, because counting them would double
every rupee that merely moved - but the total is now on screen as **"Moved, not
spent"**, so the figure can be checked against the file it came from.

**Reading the field that was always there.** Two things on an Indian UPI line
name the payee, and only the weaker one was being read. The bank truncates the
name to about eight characters, so a supermarket, a DTH provider and a
municipal corporation all arrive as a short string that reads like a person's
name - and canteen lunches and utility bills were filed as payments to
people. The handle beside it is not truncated, and a national
merchant's handle spells the brand out. It survived cleaning and nothing looked
at it. Now both are matched. Card purchases too: a `POS ATM PURCH` line writes
the merchant's full registered name, and a school fee and a supermarket bill
were the two largest unclassified rows in one file.

**A correction to v11, and the best thing in this build.** v11 said of one
caterer: *"There is no word in that line meaning food. No rule will ever get it
right."* That was wrong. Someone who knew the account looked at the same rows
and said, in one line, that the payee was a staff canteen - which is knowledge
no amount of pattern matching could have recovered, and exactly the kind a
person has and a program does not. **Those rows went from almost none correct
to all of them.**

Measured on the same 1,307 hand-labelled rows as v11, same answer key, same
scorer: **63.2% to 72.8% accuracy.** Food F1 0.75 to 0.88. Weighted precision
0.85. Miscellaneous on the statement that started all this fell from **73.2% of
spending to 2.9%**.

- **"DIRECT DR" gets its own name.** SBI's wording for a standing instruction -
  a mandate it debits for you. What it pays for is written nowhere, and
  inventing a purpose would be worse than admitting there is not one, but a
  dozen identical debits a year are a recurring commitment, and calling them
  "miscellaneous" hid the largest regular payment in the file.
- **`People` is now `Person-to-Person`, and `People & Gifts` is `Payments to
  People`.** The CSV also carries the headline column now: a row shown under one
  name on screen and exported under another reads as a bug, and nothing on the
  page explained that they were two different columns.
- `1,240/-` was already money; now a municipal body, a state electricity board,
  a DTH connection, a school and a staff canteen are all recognised from a
  truncated name or a handle.
- The feedback line in the footer is a real mailto link.
- Nothing else moved: 14 balance-chain checks, 4 PDF-versus-spreadsheet pairs
  identical, SBI's printed summary reproduced exactly, and every other file in
  the test set categorised row for row as it was in v12.
- New standing check: across all 69 file-months, no month may report a negative
  "Money in", or spend more than the bank's own debits, or receive more than its
  credits. Currently 0 failures; it was 1.

**Periods are named, not counted - and one of them was a wrong number.** Every
chart and share card was headed *"12 months to Mar 2026"*, which makes the
reader do the subtraction to find out when the period started. It now reads
**"Apr 2025 - Mar 2026"** - same width, no arithmetic - and where the span is
exactly an Indian financial year the FY is added: *"Apr 2025 - Mar 2026 ·
FY 2025-26"*. Only then, because claiming it otherwise would be false.

The same habit of counting months rather than measuring days was quietly
producing a wrong figure. **"A day, on average" divided by 30.4 x the number of
months a statement touched**, so a statement running to the 8th of a month had
that month counted as a whole one. On a real ICICI export covering 1 January to
8 August the spending was spread over 243 days when the file covers 220, so the
tile read **9.5% too low**. On a statement of two part-months it was out by
half. It now divides by the days the statement actually covers, and says so:
*"743 payments over 362 days"*.

- The month filter reads **"All months"**. The count was beside it in the chips
  anyway, and it came from the same fragile place: months that contain a
  transaction, not months the statement spans. A statement with one quiet month
  would have described a year as eleven months.
- *"Over 12 months you spent more than came in"* became *"Between Apr 2025 and
  Mar 2026 you spent more than came in."*
- Verified against **SBI's printed annual summary**. That export states its own
  figures for the year - debit count, credit count, total debits, total credits
  and closing balance - and **all five were reproduced exactly**, to the paisa,
  on a file that could not be opened at all two builds ago. What the page shows
  adds back to them too: Spent plus Invested plus Moved-not-spent equals the
  bank's own total debits, with nothing left over.

## v12 - a statement whose header is a picture, and a page that was never there

A friend's SBI statement would not open at all: *"Could not find the
transaction table in this file."* The transactions were all present and
perfectly readable. What was missing was the header row - SBI's current export
**draws** "Date", "Description", "Debit", "Credit" and "Balance" as graphics
rather than writing them as text, so the words appear **zero** times anywhere in
the file. Every column-matching rule in the app was looking for words that do
not exist.

**The columns are now worked out from the figures instead of the headings.**
A statement carries its own proof of what each column is:

* Exactly one column parses as a date on nearly every row - and where two do, a
  transaction date and a value date, the leftmost is the transaction date.
* Exactly one column is long text that is neither a number nor a date.
* **One numeric column has a property no other column has**: the difference
  between its value on consecutive rows is explained by another column on that
  row. That is the running balance, and nothing else behaves that way. On the
  file that failed, the real balance column scored 608 of 609 and the nearest
  alternative scored 0 of 496 - a margin wide enough that this is a fact, not a
  guess.
* With the balance identified, **direction stops being guesswork**. A figure
  that matches a fall in the balance is money leaving. Each money column is put
  to that vote across the whole file, so debit and credit are told apart with no
  header, no marker word and no assumption about which comes first.

The headings are still tried first, because when they exist they are
unambiguous and cost nothing. The data is the fallback - and the better of the
two wins on row count, so a header that maps cleanly but yields almost nothing
no longer wins by default. The file that read as an error now reads all of it.

**And if both fail, you are asked instead of refused.** A dialog shows the first
transaction rows of the file as they actually are, with a selector over each
column pre-filled with the best guess: Date, Description, Money out, Money in,
Amount, Balance, or ignore. Two columns set to the same thing is caught before
it can silently discard one. Being asked one question beats being told a file
cannot be read.

**A page had been disappearing from PDFs, and this is how it was found.**
Once the balance column is known, the whole statement can be checked against the
bank's own arithmetic - and on that file the chain broke in exactly one place: a
four-figure step between two consecutive days with nothing to explain it. **Page 19 of
49 was missing**, along with the thirteen transactions on it.

The cause was one line of defensive code. The bytes between `stream` and
`endstream` include the newline separating them, and the decompressor refuses
trailing junk - so the reader trimmed trailing newline and space bytes before
inflating. But compressed bytes are arbitrary. **Roughly one deflate stream in
256 legitimately ends in the byte that happens to be a newline**, and trimming
it destroyed a valid page. The full buffer is now tried first and trimming is
only a fallback, which is the right order: a deflate stream states its own end,
so a full-length decode that succeeds is proof the length was right.

**610 rows → 623, and the balance chain closes on all 622 links.** This was a
silent loss in every PDF the app has ever read, waiting for a stream to end in
the wrong byte.

- `1,240/-` is money. The trailing `/-` is how a great many Indian statements
  and hand-kept sheets write a rupee figure, and rejecting it made a column of
  ordinary amounts read as text.
- Nothing else moved: 14 balance-chain checks, 4 PDF-versus-spreadsheet pairs
  identical transaction for transaction, and SBI's own printed summary - its
  debit and credit counts and totals - reproduced exactly.

## v11 - measured against 1,307 hand-labelled rows

The first build tuned against a real answer key rather than against my own
judgement: six months of a personal expense tracker, 1,307 transactions, each
one already categorised by hand. Scored with a confusion matrix, per-category
precision and recall.

**It started at 50.0% accuracy, and one category explained most of the gap.**
Travel recall was **0.10** - of 290 travel rows the app found 29 - while
Miscellaneous had precision 0.15, absorbing 508 rows that belonged elsewhere.
Two numbers, one fact seen from both ends.

The cause was a single missing word. **"Auto" is not in the vocabulary.** In an
Indian city the auto-rickshaw is the most common thing anyone pays for by UPI,
the remark says `Auto`, and no rule looked for it - so the payee won, and the
payee is the driver's personal name, which reads as a payment to a person. 123
rows in six months, 42% of all travel.

Everything changed here, with the measured effect:

* `auto`, `autp`, `rickshaw`, `toto` → local travel. **Travel recall 0.10 → 0.61
  at precision 0.97.**
* `bike` → local travel, **not** Car & Fuel. A bike remark is a bike taxi, not a
  motorcycle bill - an error introduced in the previous build.
* `family` / `fami` → Family. The bank writes the word into the narration and
  nothing was reading it. **F1 0.00 → 0.42.**
* `ticket` → outstation. `jaiib`, `caiib`, `exam` → education.
* Rentomojo, Furlenco, Cityfurnish → Subscriptions. Furniture rental is a
  monthly bill, not a purchase. **Bills F1 0.65 → 0.73.**
* The `stores` pattern added in v10 was too greedy - it was catching "Swiggy
  Stores" as groceries. Narrowed. **Grocery precision 0.34 → 0.46.**
* Indian Railways and Metro aliases, so the truncated "Indian Rai" and
  "WB.METROQR" are recognised.

**50.0% → 63.2% accuracy. Macro F1 0.44 → 0.54. Weighted precision 0.83.**

A note on the two aliases: they had been written into an earlier build twice and
silently failed to apply both times, because the patch text did not match the
file and nothing checked. Every edit in this build was asserted and spot-tested
before it shipped.

**The honest ceiling.** 481 rows are still wrong and 125 of them are one payee -
a caterer whose narration is a name, a bank code and a reference number and
nothing else. There is no word in that line meaning "food". No rule will ever get it right. Teaching
the app five payees would take accuracy to 75%, and fifteen to 80% - which is
the argument for letting people correct a payee once and have it stick, in
numbers rather than opinion.

## v10 - one unmatched heading, three wrong answers

Checked against a hand-kept sheet of 255 rows rather than a bank export, and it
failed in a way worth writing down. The sheet's description column was headed
**`Desc`**. Nothing in the column-matching list matched that, so no description
column was found - and from that single miss:

* every narration arrived empty, so no rule could fire and **all 227 rows came
  out as Miscellaneous**;
* the duplicate check keys on date, amount and description, so with the
  description blank any two payments of the same amount on the same day
  collapsed - **ten real transactions vanished** as "repeated";
* and 18 rows with no amount were dropped silently, so 255 became 227 with
  nothing on screen to explain the other 28.

Four changes, each of which generalises past this one file:

* **Headings are matched far more widely** - `Desc`, `Narr`, `Payee`,
  `Merchant`, `Note`, `Particulars` and the rest.
* **If no heading matches, the data decides.** Exactly one column in a
  statement is full of long text that is neither a number nor a date. That
  column is the description, and it is now found by looking rather than by
  hoping the heading was one we knew.
* **Duplicates are counted, not just seen.** Two identical rows in one file are
  two real payments - the same ₹70 at the same stall twice in a day is an
  ordinary Tuesday. Only rows already loaded from an *earlier* file are
  dropped, which is what the check was always for.
* **Skipped rows are stated on screen.** "237 transactions · skipped 18 with no
  amount" instead of a number that quietly disagrees with the file.

Two more things fell out of testing it:

**A row could be labelled income while its amount said money out.** A sheet with
one unsigned amount column carries no direction, so "DEP TFR INB Refund of…"
was read as money leaving while the rules correctly called it income -
and a month's "Money in" came out as a *negative* number. Where a file states no
direction, the category may now correct the sign; where a bank printed debit and
credit columns, those remain the authority and no rule overrides them.

**380 payments to named people were Miscellaneous in a PDF** whose CSV twin
classified them correctly. The person test looked for "paid to" with a space in
it, and a PDF draws those two words as one run. Also: trade words are now
matched where the bank truncates them - "VIJAY MEDI" for a medical store,
"GANGA CATE" for a caterer - and the remark people type ("Meds", "Car",
"Puja") is read as the label it is.

Across all nine test files Miscellaneous is now **5.0%** of spending.

## v9 - verified against the banks' own numbers

A deliberate attempt to prove the totals wrong, using three checks that do not
rely on the app agreeing with itself. Two of them passed everywhere. The third
found something serious.

**A PDF was silently dropping a fifth of a statement.** Text in a PDF is drawn
one glyph at a time, and the reader decided where the word-spaces were by
comparing each gap to the line's median. That treats a capital "M" as the same
width as an "i", so a gap that is really the M's own width read as a space:
"May31,2026" came out "M ay31,2026", stopped matching the date pattern, and
**every May transaction - 170 rows, 22% of a 99-page statement - disappeared**,
while April, June, July and August came through perfectly. The total was
five figures short and nothing anywhere said so.

The fix needs no font metrics. A PDF places each glyph at an explicit position,
so the distance from an "M" to the next glyph *is* the width of the M, measured
over and over on every page. Those measurements are now collected across the
document and used as a veto: a gap no wider than the letter that made it cannot
be a space. Merchant names came out cleaner as a side effect - "SW IGGY" and
"LIM ITED" were the same defect - and Miscellaneous fell to 4.9% of spending.

**What was checked, and against what:**

* **The bank's own arithmetic.** Every statement prints a running balance. For
  each row the app's amount must explain the movement between two balances the
  bank printed. All 2,466 rows across seven files link into an unbroken chain.
* **The bank's own summary.** SBI's export prints its own four figures - the
  number of debits and of credits, and the total of each. The app reproduces
  all four exactly.
* **The same account from two formats.** PDF and spreadsheet share almost no
  code - one goes through stream inflation and glyph mapping, the other
  through a zip reader. All four pairs now agree transaction for transaction.

## v8 - privacy pass over the source

**Removed every trace of real data from the code itself.** The comments had
grown up around real statements and had quietly kept the evidence: an account
number in a worked example, real payee and merchant names used to illustrate why
a rule exists, individual rupee amounts tied to one person's accounts, real UPI
reference numbers copied into the demo data. None of it was ever transmitted by
the app - it was sitting in the source, which every visitor downloads. All of it
is now invented equivalents that make the same point.

The lesson worth keeping: an app can be perfectly private at runtime and still
leak through the story its comments tell. Anything you would not publish must
not be in an example either.

- `.htaccess` refuses to serve `.md`, `.txt`, `.zip`, `.bak` and dotfiles, so
  maintenance notes and stray build archives are not downloadable.

## v7 - trust the numbers

**The update mechanism was broken, which had hidden the previous build.** The
service worker's install step fetched assets through the browser's ordinary HTTP
cache, and the site sends a seven-day cache header on JavaScript - so a new
cache was being filled with old files. Phones that had visited before kept
running the previous build for a week. Install now fetches with
`cache: "reload"`, and the page reloads once when a new worker takes over.
A **build stamp** in the footer makes "are these two devices even running the
same code?" answerable in one glance.

**A silent date bug put 44 of one statement's 103 rows in 2001.** SBI sets
`18 Jan 2026` across two lines, so only `18 Jan` reached the parser, and
JavaScript's `new Date("18 Jan")` returns the year 2001 without complaint. The
permissive fallback is gone; a year-less date now takes its year from the rows
around it, which a date-ordered statement makes a fact rather than a guess.

**The account holder's name is now read from the statement's own header** and
used to recognise money moving between your own accounts. Those are the largest
rows in a file, and mislabelling them distorts every total on the page.

- Category **drill-down**: tap a category for its parts, tap again for the
  payees, with a breadcrumb back. Each level sums to the one above because the
  tail folds into a visible "everything else" row.
- **Start over** button; a second file still merges with the first and repeated
  rows are still dropped.
- Honest, specific messages for the two things that cannot be read: a PDF that
  is a picture with no text in it, and a photograph.
- File picker offers documents again, not the camera, on Android.

## v6 - password-protected files, and a categorisation overhaul

**Locked statements open in the browser.** Indian banks send them locked by
default, and "convert it yourself first" is the friction that makes a tool go
unused. Implemented from the specifications, with no library:

- **PDF** standard security handler - RC4, AES-128 and AES-256, with the
  key-derivation and verification algorithms written out by hand.
- **Modern locked Excel** - the agile encryption scheme of OOXML.
- **The old binary `.xls`** - RC4 CryptoAPI, where record headers stay in clear
  text and the contents are enciphered in 1024-byte blocks with a different key
  per block. The previous build had not even noticed those files were locked and
  returned 65,000 rows of noise.

**Miscellaneous fell from 65% of rows to 6%.** Not by guessing harder - by
using three things that were already in the file and being thrown away: the
trade word in a payee's name (a caterer sells food whoever owns it), the purpose
remark a payer types into a UPI transfer, and the fact that a payee recognised
under one spelling can name its own truncated spellings elsewhere in the same
file. Thirty-odd categories are rolled up into **ten headline ones** for the
chart, with the detail kept on every row.

- Share cards download directly instead of opening the share sheet; you choose
  which ones, all selected by default.
- Statements with a preamble above the transaction table are handled properly.
- Clicking the title returns to the start.

## v5 - mobile, and the formats people actually have

- The old binary **`.xls`** ICICI and others still default to, read directly
  from its BIFF8 records rather than by asking people to convert it first.
- Mobile keyboard no longer causes the page to rebuild and jump while typing.
- Share cards moved above the payments table; the table capped at ten rows.
- `.htaccess` for the domain: HTTPS, compression, caching, security headers,
  and a Content-Security-Policy that stops the page contacting anything.

## v4 - the version that could actually be opened

**Converted from ES modules to plain scripts.** Browsers refuse ES modules over
`file://`, so double-clicking `index.html` produced a page whose every button
was dead, with only a CORS error in a console nobody opens. Being openable from
disk is worth more than the nicer syntax.

- Credit line and share-card watermark settled.

## v3 - something to show people

- **Share cards**: every chart redrawn on a canvas at phone size, story or post,
  light or dark, with amounts switchable off so the shape of a year can be
  posted without the size of a salary.
- **Feedback form** that opens the visitor's own mail app, so a static site does
  not quietly acquire a backend.
- Deployed to a domain on shared cPanel hosting; installable as a PWA.

## v2 - the judgements that make the totals mean something

Three passes without which a spending report is arithmetic on the wrong numbers:

- **Moving money between your own accounts is not spending.** A debit matched to
  an equal credit within a few days is a transfer.
- **Breaking a deposit is not income.** It is your own savings coming back.
- **A failed payment and its refund cancel**, matched on the reference number
  they share, so a failed instalment is not an expense *and* a windfall.

Plus: recurring-charge detection, loan instalments inferred from the statement
rather than entered, and the needs-versus-wants split.

## v1 - the idea, working

A bank statement in, a year of spending out, **entirely in the browser**. CSV
and XLSX read with no library - XLSX via the browser's own `DecompressionStream`
and `DOMParser`. A rule-based categoriser, hand-drawn SVG charts, a demo year
generated from a fixed seed, and an offline cache.

The premise from the first commit: every other tool in this space asks you to
upload a bank statement to a server you cannot inspect. Here there is no server
to upload it to, and you can verify that in thirty seconds with the network tab.
