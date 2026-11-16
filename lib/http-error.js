// Turns an unexpected server error into a message that is safe to show in the browser.
//
// Errors we raise on purpose ("Connect a Google Calendar account first", validation messages) are
// meant for the person and pass through unchanged. Anything that comes from infrastructure — database
// responses, network failures, programming errors — can contain table names, SQL details or internal
// URLs, so it is logged on the server with a short reference and the browser only gets that reference.
import crypto from "crypto";

const INTERNAL = [
  /supabase/i, /rest\/v1/i, /\bpgrst\d+/i, /"code"\s*:/, /\bsql\b/i, /relation .* does not exist/i,
  /fetch failed/i, /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/, /socket hang up/i,
  /is not a function|is not defined|cannot read propert/i, /unexpected token/i,
  /api[_-]?key|authorization|bearer/i,
];
const PROGRAMMING_ERRORS = new Set(["TypeError", "ReferenceError", "SyntaxError", "RangeError"]);

export function publicErrorMessage(error, context = "Request") {
  const message = String(error?.message || error || "").replace(/^Error:\s*/, "").trim();
  const internal = !message || PROGRAMMING_ERRORS.has(error?.name) || INTERNAL.some((pattern) => pattern.test(message));
  if (!internal) return message.slice(0, 300);
  const reference = crypto.randomBytes(4).toString("hex");
  console.error(`${context} failed [ref ${reference}]:`, error);
  return `Something went wrong on our side. Please try again. (Reference ${reference})`;
}
