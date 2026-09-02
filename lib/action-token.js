import crypto from "crypto";

// A notification has to be actionable while the app is closed, so the service worker
// posts back on its own with no signed-in user to prove who it is. Each push therefore
// carries a token naming exactly one task, signed with a server-only secret. Worst case
// if one leaks: someone can complete or snooze that single task.
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // a week-out warning is the longest-lived push

function secret() {
  const s = process.env.ACTION_SECRET || process.env.CRON_SECRET;
  if (!s) throw new Error("set CRON_SECRET (or ACTION_SECRET) to sign notification actions");
  return s;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function sign(body) {
  return crypto.createHmac("sha256", secret()).update(body).digest("base64url");
}

export function signAction(uid, taskId, now = Date.now()) {
  const body = `${b64url(uid)}.${b64url(taskId)}.${now + TTL_MS}`;
  return `${body}.${sign(body)}`;
}

// Returns { uid, taskId } or null. Never throws on malformed input — this is reached by
// anything on the internet that can guess the URL.
export function verifyAction(token, now = Date.now()) {
  if (typeof token !== "string" || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [u, t, exp, mac] = parts;
  const body = `${u}.${t}.${exp}`;

  const expected = sign(body);
  // Constant-time compare, and only on equal lengths — timingSafeEqual throws otherwise.
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  if (!/^\d+$/.test(exp) || Number(exp) < now) return null;
  try {
    const uid = Buffer.from(u, "base64url").toString("utf8");
    const taskId = Buffer.from(t, "base64url").toString("utf8");
    return uid && taskId ? { uid, taskId } : null;
  } catch { return null; }
}
