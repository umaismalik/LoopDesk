// Password hashing with scrypt. The async form runs on Node's thread pool, so checking a password
// does not freeze the server for every other request while it computes.
import crypto from "crypto";
import { promisify } from "util";

const scrypt = promisify(crypto.scrypt);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + (await scrypt(String(password), salt, 64)).toString("hex");
}

// A missing or malformed stored hash is a failed check, never a server error.
export async function verifyPassword(password, stored) {
  const [salt, digest] = String(stored || "").split(":");
  if (!salt || !/^[0-9a-f]{128}$/i.test(digest || "")) return false;
  return crypto.timingSafeEqual(await scrypt(String(password), salt, 64), Buffer.from(digest, "hex"));
}
