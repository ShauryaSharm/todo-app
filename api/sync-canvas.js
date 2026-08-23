import admin from "firebase-admin";

const TZ = "America/Los_Angeles";
const TEST_WORDS = /\b(quiz|test|exam|midterm|final|assessment)\b/i;
// Ignore work that's been overdue longer than this, so old missing assignments
// from earlier in the term don't flood the list.
const MAX_OVERDUE_MS = 20 * 24 * 60 * 60 * 1000;

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

// --- Canvas API (token stays server-side) ---
async function canvasGetAll(path, params = {}) {
  const base = (process.env.CANVAS_BASE_URL || "").replace(/\/+$/, "");
  const token = (process.env.CANVAS_TOKEN || "").trim();
  if (!base || !token) throw new Error("Missing CANVAS_BASE_URL or CANVAS_TOKEN");

  const url = new URL(base + path);
  url.searchParams.set("per_page", "100");
  for (const [k, v] of Object.entries(params)) url.searchParams.append(k, v);

  let next = url.toString();
  const out = [];
  while (next) {
    const res = await fetch(next, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Canvas ${res.status} on ${path}`);
    out.push(...(await res.json()));
    // follow the RFC5988 Link header for pagination
    const link = res.headers.get("link") || "";
    const m = link.split(",").find((p) => p.includes('rel="next"'));
    next = m ? m.slice(m.indexOf("<") + 1, m.indexOf(">")) : null;
  }
  return out;
}

// Canvas returns UTC; the app stores local date/time strings.
function localParts(iso) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(iso)).map((p) => [p.type, p.value])
  );
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}` };
}

function shortCourse(name) {
  return String(name || "").split(/\s+-\s+/)[0].trim();
}

export default async function handler(req, res) {
  const secret = req.query.secret || req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    initAdmin();
    const db = admin.firestore();

    // Which user's list to add to. Prefer an explicit UID; fall back to the sole
    // user when there's exactly one (this is a personal app).
    let uid = (process.env.CANVAS_TARGET_UID || "").trim();
    if (!uid) {
      const users = await db.collection("users").listDocuments();
      if (users.length !== 1) {
        return res.status(400).json({
          error: "set CANVAS_TARGET_UID",
          detail: `${users.length} users found; can't pick automatically`,
        });
      }
      uid = users[0].id;
    }

    const courses = await canvasGetAll("/api/v1/courses", {
      enrollment_state: "active", "state[]": "available",
    });

    const now = Date.now();
    const pending = [];
    for (const c of courses) {
      const assignments = await canvasGetAll(
        `/api/v1/courses/${c.id}/assignments`, { "include[]": "submission" }
      );
      for (const a of assignments) {
        if (!a.published || !a.due_at) continue;             // skip undated/unpublished
        const sub = a.submission || {};
        if (sub.submitted_at || sub.workflow_state === "graded") continue; // already done
        const dueMs = new Date(a.due_at).getTime();
        if (now - dueMs > MAX_OVERDUE_MS) continue;          // too old to be worth showing
        pending.push({ course: c.name, a, dueMs });
      }
    }

    // Dedupe against everything we've ever synced, so deleting a task in the app
    // doesn't cause it to reappear on the next run.
    const seenSnap = await db.collection("users").doc(uid).collection("canvasSynced").get();
    const seen = new Set(seenSnap.docs.map((d) => d.id));

    const tasksRef = db.collection("users").doc(uid).collection("tasks");
    let added = 0;

    for (const { course, a, dueMs } of pending) {
      const key = String(a.id);
      if (seen.has(key)) continue;

      const { date, time } = localParts(a.due_at);
      const overdue = dueMs < now;
      const soon = dueMs - now < 2 * 24 * 60 * 60 * 1000;
      const isTest = a.quiz_id || (a.submission_types || []).includes("online_quiz") || TEST_WORDS.test(a.name || "");

      const bits = [shortCourse(course)];
      if (isTest) bits.push("Test/Quiz");
      if (a.points_possible) bits.push(`${a.points_possible} pts`);
      if (overdue) bits.push("OVERDUE");

      const id = db.collection("_").doc().id; // random id, same shape as the app's
      await tasksRef.doc(id).set({
        id,
        text: a.name || "Canvas assignment",
        done: false,
        category: overdue ? "Urgent" : "Work",
        priority: overdue || isTest || soon ? "high" : "medium",
        dueDate: date,
        dueTime: time,
        description: `${bits.join(" · ")}\n${a.html_url || ""}`.trim(),
        // Past-due reminders are ignored by send-reminders' 1-hour window, so
        // importing old work won't spam notifications.
        remindAt: dueMs,
        notified: overdue,
        canvasId: key,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await db.collection("users").doc(uid).collection("canvasSynced").doc(key).set({
        name: a.name || "", syncedAt: Date.now(),
      });
      added++;
    }

    return res.status(200).json({ ok: true, courses: courses.length, pending: pending.length, added });
  } catch (err) {
    return res.status(500).json({ error: "sync_failed", detail: String(err) });
  }
}
