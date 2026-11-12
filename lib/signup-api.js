// Public self sign-up: anyone can create their own company workspace.
//   1. POST /api/signup { action: "request", companyName, name, email, password, projectName }
//      → stores a pending request and emails a verification link (valid 24 hours).
//   2. POST /api/signup { action: "verify", token } (from the link)
//      → creates the company, its owner account and a first project, and signs the owner in.
// Someone who already has a LoopDesk account (e.g. invited to another company) signs up with that
// account's password; the new company is added to the same login.
// Set SIGNUP_DISABLED=true on the server to close sign-ups.
import crypto from "crypto";
import { sendEmail } from "./email";
import { createLoginSession, remote } from "./store";
import { TenantSetupError, findMemberByEmail, provisionTenant, savePendingSignup, takePendingSignup } from "./tenant-store";

const J = (o, s = 200) => Response.json(o, { status: s, headers: { "Cache-Control": "no-store" } });
const hash = (p) => { const s = crypto.randomBytes(16).toString("hex"); return s + ":" + crypto.scryptSync(p, s, 64).toString("hex"); };
const verify = (p, h) => {
  if (!h) return false;
  const [s, x] = h.split(":");
  try { return crypto.timingSafeEqual(crypto.scryptSync(p, s, 64), Buffer.from(x, "hex")); } catch { return false; }
};
const pwOk = (p) => p && p.length >= 8 && /[a-z]/i.test(p) && /\d/.test(p);
const html = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const siteUrl = (origin) => (process.env.APP_URL || origin).replace(/\/+$/, "");

// Basic abuse protection: a few sign-up attempts per address per hour.
const attempts = globalThis.__loopdeskSignupAttempts || (globalThis.__loopdeskSignupAttempts = new Map());
const limited = (key) => {
  const now = Date.now(), list = (attempts.get(key) || []).filter((t) => now - t < 3600e3);
  list.push(now); attempts.set(key, list);
  if (attempts.size > 5000) attempts.clear();
  return list.length > 6;
};

export async function signupRequest(req, method, url) {
  if (method !== "POST") return J({ error: "not found" }, 404);
  if (String(process.env.SIGNUP_DISABLED || "").toLowerCase() === "true") return J({ error: "New sign-ups are closed right now. Please contact us." }, 403);
  try {
    const b = await req.json();
    if (b.action === "verify") return await verifySignup(String(b.token || ""));

    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";
    const email = String(b.email || "").trim().toLowerCase();
    const name = String(b.name || "").trim().slice(0, 80);
    const companyName = String(b.companyName || "").trim().slice(0, 80);
    const projectName = String(b.projectName || "").trim().slice(0, 60) || "My first project";
    const password = String(b.password || "");
    if (limited("ip:" + ip) || limited("email:" + email)) return J({ error: "Too many sign-up attempts. Please try again in an hour." }, 429);
    if (!companyName) return J({ error: "Enter your company name" }, 400);
    if (!name) return J({ error: "Enter your name" }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return J({ error: "Enter a valid work email" }, 400);
    if (!b.accept) return J({ error: "Please accept the terms to continue" }, 400);

    const existing = await findMemberByEmail(email);
    if (existing?.status === "disabled") return J({ error: "This account is disabled. Please contact support." }, 403);
    if (existing && !verify(password, existing.pw)) {
      return J({ error: "An account with this email already exists. Enter that account's password to add a new company to it, or sign in instead.", existing: true }, 400);
    }
    if (!existing && !pwOk(password)) return J({ error: "Password must be 8+ characters with at least one letter and one number" }, 400);

    const token = crypto.randomBytes(24).toString("hex");
    await savePendingSignup(token, email, {
      email, name: existing?.name || name, companyName, projectName,
      existingMemberId: existing?.id || "", passwordHash: existing ? "" : hash(password),
    });
    const link = `${siteUrl(url.origin)}/?signup=${token}`;
    const result = await sendEmail({
      to: email,
      subject: `Confirm your LoopDesk workspace for ${companyName}`,
      html: `<p>Hi ${html(name)},</p><p>Thanks for signing up! Confirm your email to create the <b>${html(companyName)}</b> workspace on LoopDesk.</p><p><a href="${html(link)}" style="display:inline-block;padding:11px 20px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">Confirm email &amp; create workspace</a></p><p style="color:#64748b;font-size:12px">This link works once and expires in 24 hours. If you did not sign up, you can ignore this email.</p>`,
    });
    if (!result.sent) return J({ error: "We could not send the confirmation email: " + (result.error || "email delivery failed") }, 502);
    return J({ ok: true, email });
  } catch (error) {
    if (error instanceof TenantSetupError) return J({ error: error.message }, 503);
    console.error("Sign-up failed:", error);
    return J({ error: "Sign-up failed. Please try again." }, 500);
  }
}

async function verifySignup(token) {
  const pending = await takePendingSignup(token);
  if (!pending) return J({ error: "This confirmation link is invalid or has expired. Please sign up again." }, 400);
  const p = pending.payload || {};
  // Someone may have created an account with this email after the request was made.
  let existingMemberId = p.existingMemberId || "";
  if (!existingMemberId) {
    const now = await findMemberByEmail(p.email);
    if (now) return J({ error: "An account with this email was created in the meantime. Sign in, or sign up again with that account's password." }, 409);
  }
  const sessionToken = crypto.randomBytes(16).toString("hex") + "." + Date.now();
  const created = await provisionTenant({
    existingMemberId, name: p.name, email: p.email, passwordHash: p.passwordHash,
    companyName: p.companyName, projectName: p.projectName, sessionToken,
  });
  if (remote) await createLoginSession(created.memberId, sessionToken);
  return J({ ok: true, key: sessionToken, projectId: created.projectId });
}
