/*
 * Feedback.
 *
 * This is the one thing on the page that deliberately sends something, so it
 * is worth being precise about the boundary:
 *
 *   - It sends ONLY what the person types into these three fields.
 *   - It never attaches a transaction, a total, a category, a file name, or
 *     anything derived from the statement. The form has no access to that
 *     state and is not passed it.
 *   - Nothing is sent until the send button is pressed.
 *
 * Two ways to deliver it, chosen in CONFIG below:
 *
 *   "mailto"   -- opens the person's own mail app with the message filled in.
 *                 No server, no third party, nothing to configure, and the
 *                 sender can see exactly what is being sent before it goes.
 *                 The cost is that it needs a mail client and looks clunky.
 *
 *   "endpoint" -- POSTs JSON to a URL you own or a form service. Smoother, but
 *                 it is a real request to a real server, so the page says so
 *                 plainly rather than burying it.
 *
 * The default is mailto, because a static site with no backend should not
 * quietly acquire one.
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

  const CONFIG = {
    mode: "mailto",                       // "mailto" | "endpoint"
    email: "helloDSandAI@gmail.com",      // where feedback goes
    endpoint: "",                         // e.g. "https://formspree.io/f/xxxxxxx"
  };

  const esc = s => String(s ?? "").replace(/[&<>"]/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function feedbackHtml() {
    const sending = CONFIG.mode === "endpoint" && CONFIG.endpoint;
    return `
    <div class="card wide" id="feedback" style="margin-top:12px">
      <h2>Tell me what to fix</h2>
      <p class="muted" style="margin-top:0">Did a payment land in the wrong
        category? Did your bank's file not open? That is the most useful thing
        you can tell me.</p>
      <div class="fbgrid">
        <label>Your email
          <input type="email" id="fb-email" placeholder="you@example.com"
                 autocomplete="email" required>
        </label>
        <label>Mobile <span class="opt">optional</span>
          <input type="tel" id="fb-phone" placeholder="+91…" autocomplete="tel">
        </label>
      </div>
      <label style="display:block;margin-top:10px">What happened
        <textarea id="fb-note" rows="4" required
          placeholder="e.g. my HDFC statement opened fine but every UPI payment came out as Miscellaneous"></textarea>
      </label>
      <div class="fbrow">
        <button class="btn pri" id="fb-send">${sending ? "Send feedback" : "Copy it"}</button>
        ${sending ? "" : `<a class="btn" id="fb-mail" href="#">Open email app</a>`}
        <span class="muted" id="fb-msg"></span>
      </div>
      <p class="muted">Only these three boxes are sent — never your statement,
        your totals or anything worked out from them.
        ${sending ? "Sending posts them to a form service."
                  : `<b>Copy it</b> puts the message on your clipboard so you can paste
                     it into WhatsApp or any mail app. <b>Open email app</b> only works
                     if you have one set up on this device.`}</p>
    </div>`;
  }

  function wireFeedback(root) {
    const q = s => root.querySelector(s);
    const btn = q("#fb-send"), msg = q("#fb-msg");
    if (!btn) return;

    const say = (text, bad) => {
      msg.textContent = text;
      msg.className = "muted " + (bad ? "bad" : "good");
    };

    btn.onclick = async () => {
      const email = q("#fb-email").value.trim();
      const phone = q("#fb-phone").value.trim();
      const note  = q("#fb-note").value.trim();

      if (!note) return say("Please write what happened first.", true);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
        return say("That email address does not look right.", true);

      // Context that helps reproduce a parsing bug, and identifies nobody.
      const ua = navigator.userAgent.slice(0, 120);
      const body =
        `${note}\n\n---\nFrom: ${email}${phone ? `\nMobile: ${phone}` : ""}\n` +
        `Browser: ${ua}\nPage: ${location.href}`;

      if (CONFIG.mode === "endpoint" && CONFIG.endpoint) {
        btn.disabled = true; say("Sending…");
        try {
          const res = await fetch(CONFIG.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ email, phone, message: note, browser: ua }),
          });
          btn.disabled = false;
          if (!res.ok) throw new Error(res.status);
          q("#fb-note").value = "";
          say("Thank you — that is genuinely useful.");
        } catch {
          btn.disabled = false;
          say("Could not send. You can email " + CONFIG.email + " instead.", true);
        }
        return;
      }

      /* No mail app, no dead end.
       *
       * This used to do `location.href = "mailto:…"`, which navigates away.
       * On a desktop with no mail client configured that pops a "choose an
       * application" dialog, and on a phone it either opens something the
       * person does not use or does nothing at all -- and either way they have
       * left the page and lost what they typed.
       *
       * So the button copies instead. The clipboard works everywhere, the text
       * can go into WhatsApp as easily as into mail, and the page stays put.
       * The mailto is still there as a link for anyone who wants it. */
      const full = `To: ${CONFIG.email}\nSubject: My Spending Pattern — feedback\n\n${body}`;
      try {
        await navigator.clipboard.writeText(full);
        say(`Copied. Paste it into an email or WhatsApp to ${CONFIG.email}.`);
      } catch {
        // Clipboard needs https and a user gesture; if it is refused, show the
        // text so it can be selected by hand rather than losing it.
        const box = q("#fb-note");
        box.value = full;
        box.select();
        say("Press Ctrl+C (or long-press → Copy) to copy the selected text.", true);
      }
    };

    const mail = q("#fb-mail");
    if (mail) mail.onclick = e => {
      e.preventDefault();
      const email = q("#fb-email").value.trim();
      const phone = q("#fb-phone").value.trim();
      const note  = q("#fb-note").value.trim();
      if (!note) return say("Please write what happened first.", true);
      const body = `${note}\n\n---\nFrom: ${email}${phone ? `\nMobile: ${phone}` : ""}`;
      // A new tab, not this one. If no mail app answers, the person still has
      // the page -- and everything they typed -- exactly where they left it.
      window.open(`mailto:${CONFIG.email}`
        + `?subject=${encodeURIComponent("My Spending Pattern — feedback")}`
        + `&body=${encodeURIComponent(body)}`, "_blank");
    };
  }

  MSP.feedback = { CONFIG, feedbackHtml, wireFeedback };
})(window.MSP = window.MSP || {});
