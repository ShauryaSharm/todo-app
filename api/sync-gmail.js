import admin from "firebase-admin";
import { groqChat } from "../lib/groq.js";
import { zonedToEpochMs } from "../lib/localtime.js";

// Token exchange + per-message AI triage can run past Vercel's 10s default.
export const maxDuration = 60;

const TZ = "America/Los_Angeles";
const LOOKBACK = process.env.GMAIL_LOOKBACK || "14d";  // don't import years of history
const MAX_MESSAGES = 25;
const CATEGORIES = ["Homework", "Work", "Personal", "Shopping", "Health", "Urgent", "Other"];

function initAdmin() {
  if (admin.apps.length) return;
  const stripBOM = (s) => s.replace(/^﻿/, "");
  const raw = stripBOM((process.env.FIREBASE_SERVICE_ACCOUNT || "").trim());
  const candidates = [raw, `{${raw}}`, () => stripBOM(Buffer.from(raw, "base64").toString("utf8").trim())];
  let sa, err;
  for (const c of candidates) {
    try { sa = JSON.parse(typeof c === "function" ? c() : c); break; }
    catch (e) { err = err || e; }
  }
  if (!sa) throw new Error(`service account unparseable: ${err && err.message}`);
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}

// Refresh tokens don't expire; trade one for a short-lived access token each run.
async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN || "",
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    // While the OAuth app sits in "Testing", Google expires the refresh token after 7
    // days and every later refresh comes back invalid_grant. That reads like a generic
    // auth failure, so say plainly what it is and how to fix it — otherwise the sync
    // just stops producing tasks and nothing explains why.
    if (text.includes("invalid_grant")) {
      throw new Error(
        "GOOGLE_REFRESH_TOKEN is dead (invalid_grant). If the OAuth app is still in " +
        "Testing status, Google expires the token after 7 days: mint a new one in the " +
        "OAuth playground and update the Vercel env var. Publishing the app to " +
        "production stops the expiry for good."
      );
    }
    throw new Error(`google token ${res.status}: ${text.slice(0, 200)}`);
  }
  const tok = JSON.parse(text).access_token;
  if (!tok) throw new Error("google returned no access_token");
  return tok;
}

async function gmail(path, token) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`gmail ${res.status} on ${path}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

function header(msg, name) {
  const h = (msg.payload?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

function todayLocal() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date()).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}`;
}

// The AI decides whether an email is actually something to do. Most mail isn't —
// newsletters, receipts, FYI announcements — so the default answer is "no task".
async function triage(emails, today) {
  const lines = emails.map((e, i) =>
    `${i}. from="${e.from}" | subject="${e.subject}" | preview="${(e.snippet || "").slice(0, 300)}"`
  ).join("\n");

  const { data } = await groqChat({
    temperature: 0.2,
    max_tokens: 1200,
    response_format: { type: "json_object" },
    messages: [{
      role: "system",
      content:
        `You triage a student's email into to-do items. Today is ${today}. Return ONLY JSON: ` +
        `{"items":[{"i":<index>,"task":true|false,"title":...,"category":...,"priority":...,"dueDate":...,"dueTime":...,"description":...}]} ` +
        `with one entry per input line, same index.\n` +
        `- "task": true ONLY if the email asks the reader to actually DO something with a clear action — ` +
        `submit a form, sign up, bring something, reply by a date, attend at a specific time, pay something. ` +
        `Default to FALSE for newsletters, receipts, order/shipping updates, promotions, digests, social ` +
        `notifications, "no action needed" notices, grade postings, and general announcements. Be strict: a ` +
        `wrong "true" adds clutter, a wrong "false" costs nothing.\n` +
        `- "title": short imperative task, how a student would write it ("Turn in field trip form"). Under 60 chars. ` +
        `Never just copy the subject line.\n` +
        `- "category": one of ${CATEGORIES.join(", ")}. School-related is "Homework".\n` +
        `- "priority": high, medium or low.\n` +
        `- "dueDate": "YYYY-MM-DD" if the email states or clearly implies a deadline, else null. Resolve relative ` +
        `dates against today. "dueTime": "HH:MM" 24-hour if a time is given, else null.\n` +
        `- "description": one short line of context (who it's from, what it's about). No URLs.\n` +
        `For entries where task is false, the other fields may be null.`,
    }, { role: "user", content: lines }],
  });

  const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
  const out = new Map();
  for (const it of parsed.items || []) {
    if (typeof it.i !== "number" || !it.task) continue;
    if (typeof it.title !== "string" || !it.title.trim()) continue;
    out.set(it.i, {
      title: it.title.trim().slice(0, 120),
      category: CATEGORIES.find((c) => c.toLowerCase() === String(it.category || "").toLowerCase()) || "Other",
      priority: ["high", "medium", "low"].includes(String(it.priority || "").toLowerCase())
        ? String(it.priority).toLowerCase() : "medium",
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(it.dueDate || "") ? it.dueDate : null,
      dueTime: /^\d{2}:\d{2}$/.test(it.dueTime || "") ? it.dueTime : null,
      description: typeof it.description === "string" ? it.description.trim().slice(0, 300) : "",
    });
  }
  return out;
}

export default async function handler(req, res) {
  const secret = req.query.secret || req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // GMAIL_LABEL takes one label or a comma-separated list ("School, Scouts, Volunteering").
  // Actionable mail is spread across several of Shaurya's filters, not collected in one.
  const labels = (process.env.GMAIL_LABEL || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!labels.length) return res.status(400).json({ error: "set GMAIL_LABEL" });

  try {
    initAdmin();
    const db = admin.firestore();

    let uid = (process.env.CANVAS_TARGET_UID || "").trim();
    if (!uid) {
      const users = await db.collection("users").listDocuments();
      if (users.length !== 1) return res.status(400).json({ error: "set CANVAS_TARGET_UID" });
      uid = users[0].id;
    }

    const token = await getAccessToken();
    // Gmail ORs the terms inside {braces}; a single label needs no braces.
    const labelExpr = labels.map((l) => `label:"${l}"`).join(" ");
    const q = encodeURIComponent(
      `${labels.length > 1 ? `{${labelExpr}}` : labelExpr} newer_than:${LOOKBACK}`
    );
    const list = await gmail(`/messages?q=${q}&maxResults=${MAX_MESSAGES}`, token);
    const ids = (list.messages || []).map((m) => m.id);

    // Remember every message we've looked at, so re-runs don't re-triage or re-add —
    // and so a task deleted in the app doesn't come back.
    const seenRef = db.collection("users").doc(uid).collection("gmailSynced");
    const seen = new Set((await seenRef.get()).docs.map((d) => d.id));
    const fresh = ids.filter((id) => !seen.has(id));

    if (!fresh.length) {
      return res.status(200).json({ ok: true, labels, matched: ids.length, examined: 0, added: 0 });
    }

    const emails = [];
    for (const id of fresh) {
      const m = await gmail(`/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, token);
      emails.push({ id, subject: header(m, "Subject"), from: header(m, "From"), snippet: m.snippet || "" });
    }

    const today = todayLocal();
    const tasksRef = db.collection("users").doc(uid).collection("tasks");
    let added = 0;

    for (let i = 0; i < emails.length; i += 8) {
      const batch = emails.slice(i, i + 8);
      const verdicts = await triage(batch, today);
      for (let j = 0; j < batch.length; j++) {
        const email = batch[j];
        const v = verdicts.get(j);
        if (v) {
          const id = db.collection("_").doc().id;
          // Vercel runs in UTC, so parsing the due date with the Date constructor put
          // every reminder seven or eight hours early. Resolve it in Shaurya's zone.
          const remindAt = v.dueDate && v.dueTime ? zonedToEpochMs(v.dueDate, v.dueTime) : null;
          await tasksRef.doc(id).set({
            id,
            text: v.title,
            done: false,
            category: v.category,
            priority: v.priority,
            dueDate: v.dueDate,
            dueTime: v.dueTime,
            description: `${v.description}\nhttps://mail.google.com/mail/u/0/#inbox/${email.id}`.trim(),
            remindAt,
            notified: false,
            notifiedStages: [],
            repeat: null,
            gmailId: email.id,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          added++;
        }
        // Mark examined either way, so a "not a task" verdict isn't re-judged hourly.
        await seenRef.doc(email.id).set({
          subject: email.subject.slice(0, 200), madeTask: !!v, seenAt: Date.now(),
        });
      }
    }

    return res.status(200).json({ ok: true, labels, matched: ids.length, examined: emails.length, added });
  } catch (err) {
    return res.status(500).json({ error: "gmail_sync_failed", detail: String(err).slice(0, 300) });
  }
}
