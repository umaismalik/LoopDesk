// Email sender: Resend first, SMTP (e.g. Gmail app password) as automatic fallback.
const PERSONAL = ["gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "icloud.com"];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let testingOwner = "";

function cfg() {
  const apiKey = process.env.RESEND_KEY || process.env.RESEND_API_KEY || "";
  let from = process.env.RESEND_FROMEMAIL || process.env.RESEND_FROM_EMAIL || process.env.EMAIL_FROM || "";
  let replyTo = process.env.EMAIL_REPLY_TO || "";
  const addr = from.match(/<([^>]+)>/)?.[1] || from;
  const domain = addr.split("@").pop()?.toLowerCase() || "";
  const smtpFirst = PERSONAL.includes(domain) || process.env.SMTP_HOST?.toLowerCase() === "smtp.gmail.com";
  if (!from || PERSONAL.includes(domain)) {
    if (from && !replyTo) replyTo = addr;
    from = "LoopDesk <onboarding@resend.dev>";
  }
  return { apiKey, from, replyTo, sandbox: /@resend\.dev>?$/i.test(from), smtpFirst };
}
export function emailStatus() {
  const c = cfg();
  return { resend: !!c.apiKey, from: c.from, replyTo: c.replyTo, sandbox: c.sandbox, smtp: !!process.env.SMTP_HOST };
}
const shell = (html) => `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;color:#0f172a"><div style="font-weight:700;font-size:18px;color:#4f46e5;margin-bottom:16px">LoopDesk · Team &amp; Project Management</div><div style="font-size:14px;line-height:1.6">${html}</div><hr style="border:0;border-top:1px solid #e5e9f2;margin:24px 0"><div style="font-size:12px;color:#64748b">This is an automated message from LoopDesk.</div></div>`;
function friendly(msg, status) {
  const t = String(msg).toLowerCase();
  if (t.includes("own email") || t.includes("testing emails")) return "Resend is in testing mode, so it can only email the Resend account owner. Verify a domain at resend.com/domains and set RESEND_FROMEMAIL to an address on that domain.";
  if (t.includes("not verified")) return "The sender domain is not verified in Resend.";
  if (status === 401 || t.includes("api key")) return "RESEND_KEY is invalid or missing.";
  return "Resend: " + msg;
}
// `calendar` is an optional iCalendar invite { method: "REQUEST" | "CANCEL", content }. Sent as a proper
// text/calendar part, mail apps such as Gmail and Outlook add (or remove) the event in the recipient's calendar.
async function sendWithSmtp({ to, subject, html, calendar }) {
  if (!process.env.SMTP_HOST) return { sent: false, error: "SMTP is not configured." };
  const gmail = process.env.SMTP_HOST.toLowerCase() === "smtp.gmail.com";
  const password = gmail ? (process.env.SMTP_PASS || "").replace(/\s/g, "") : process.env.SMTP_PASS;
  if (gmail && password.length !== 16) {
    return { sent: false, error: "Gmail SMTP_PASS must be a 16-character Google App Password. Create one in your Google Account after enabling 2-Step Verification; do not use your regular Gmail password." };
  }
  try {
    const nodemailer = (await import("nodemailer")).default;
    const port = Number(process.env.SMTP_PORT || 587);
    await nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465, auth: { user: process.env.SMTP_USER, pass: password } })
      .sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, html, ...(calendar ? { icalEvent: { method: calendar.method, filename: "invite.ics", content: calendar.content } } : {}) });
    return { sent: true, provider: "smtp" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/534-5\.7\.9|Application-specific password required|InvalidSecondFactor/i.test(message)) {
      return { sent: false, error: "Gmail requires a Google App Password. Enable 2-Step Verification, create an App Password in your Google Account, set it as SMTP_PASS (without spaces), and restart the app. A normal Gmail password will not work." };
    }
    if (/535-5\.7\.8|BadCredentials/i.test(message)) {
      return { sent: false, error: "Gmail rejected the SMTP login. Check that SMTP_USER is the full Gmail address and SMTP_PASS is a current Google App Password, not your normal account password." };
    }
    return { sent: false, error: "SMTP failed: " + message };
  }
}
async function deliver({ to, subject, html, calendar }) {
  const { apiKey, from, replyTo, sandbox, smtpFirst } = cfg();
  const body = shell(html);
  if (smtpFirst) return sendWithSmtp({ to, subject, html: body, calendar });
  let err = "";
  if (!apiKey) err = "RESEND_KEY is not set.";
  else if (sandbox && testingOwner && String(to).toLowerCase() !== testingOwner) err = friendly("testing emails", 403);
  else {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            from, to: [to], subject, html: body, ...(replyTo ? { reply_to: replyTo } : {}),
            ...(calendar ? { attachments: [{ filename: "invite.ics", content: Buffer.from(calendar.content).toString("base64"), content_type: `text/calendar; charset=utf-8; method=${calendar.method}` }] } : {}),
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok) return { sent: true, provider: "resend", id: j.id };
        const msg = j.message || j.name || "HTTP " + r.status;
        if (r.status === 429 && i === 0) { await wait(1200); continue; }
        if (sandbox && r.status === 403) { const o = /\(([^)\s]+@[^)\s]+)\)/.exec(msg); if (o) testingOwner = o[1].toLowerCase(); }
        err = friendly(msg, r.status);
        break;
      } catch (e) { err = "Could not reach Resend: " + e.message; if (i === 0) await wait(800); }
    }
  }
  const s = await sendWithSmtp({ to, subject, html: body, calendar });
  if (s.sent) return s;
  return { sent: false, error: [err, s.error].filter(Boolean).join(" | ") };
}
// Emails go out one at a time (Resend allows about 2 requests per second).
let chain = Promise.resolve();
export function sendEmail(msg) {
  const run = chain.then(() => deliver(msg));
  chain = run.catch(() => {}).then(() => wait(600));
  return run;
}
