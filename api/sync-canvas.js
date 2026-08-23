import admin from "firebase-admin";

// Groq retires models periodically; set GROQ_MODEL in Vercel to swap without a code change.
const MODEL = (process.env.GROQ_MODEL || "llama-3.3-70b-versatile").trim();


// Canvas pagination plus the AI naming pass can run past Vercel's 10s default.
export const maxDuration = 60;

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

function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

const CATEGORIES = ["Work", "Personal", "Shopping", "Health", "Urgent", "Other"];

// Let the same model the app uses for quick-add decide how imported Canvas work is
// named and presented, so it reads like a task the user typed rather than a raw
// Canvas string ("HW 4.2 - Ch4 (Sec 4.2) [PERIOD 3]"). Falls back to plain
// formatting if the model is unavailable — the sync must never depend on it.
async function formatWithAI(batch) {
  const key = (process.env.GROQ_API_KEY || "").trim();
  if (!key) throw new Error("GROQ_API_KEY missing in this function's env");

  const lines = batch.map((b, i) =>
    `${i}. name="${b.a.name || ""}" | course="${shortCourse(b.course)}" | ` +
    `${b.isTest ? "test/quiz" : "assignment"}${b.a.points_possible ? ` | ${b.a.points_possible} pts` : ""} | ` +
    `due ${b.dueLabel}${b.overdue ? " (OVERDUE)" : ""}` +
    (b.blurb ? ` | details="${b.blurb.slice(0, 200)}"` : "")
  ).join("\n");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      messages: [{
        role: "system",
        content:
          `Rewrite school assignments as clean to-do items. Return ONLY JSON: ` +
          `{"items":[{"i":<index>,"title":...,"category":...,"priority":...,"description":...}]} ` +
          `with one entry per input line, same index.\n` +
          `- "title": short, natural, scannable — how a student would write it themselves. ` +
          `Strip course codes, section numbers, period markers, and bracketed junk. Lead with the subject ` +
          `when it isn't obvious (e.g. "HW 4.2 - Polynomial Long Div (Ch4) [P3]" + course "Algebra 2" -> ` +
          `"Algebra 2 homework: polynomial long division"). Sentence case, no trailing period, under 60 chars.\n` +
          `- "category": exactly one of ${CATEGORIES.join(", ")}. School work is "Work" unless it's overdue, ` +
          `in which case "Urgent".\n` +
          `- "priority": high, medium, or low. Tests/quizzes, overdue work, and high point values are high; ` +
          `small routine homework is low; everything else medium.\n` +
          `- "description": one short line of useful context (course, what it is, points). No URLs. ` +
          `Don't restate the title.`,
      }, { role: "user", content: lines }],
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
  const out = new Map();
  for (const it of parsed.items || []) {
    if (typeof it.i !== "number") continue;
    out.set(it.i, {
      title: typeof it.title === "string" ? it.title.trim().slice(0, 120) : null,
      category: CATEGORIES.find((c) => c.toLowerCase() === String(it.category || "").toLowerCase()) || null,
      priority: ["high", "medium", "low"].includes(String(it.priority || "").toLowerCase())
        ? String(it.priority).toLowerCase() : null,
      description: typeof it.description === "string" ? it.description.trim().slice(0, 300) : null,
    });
  }
  return out;
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
    // doesn't cause it to reappear on the next run. ?reset=1 wipes that memory so
    // previously-imported (and since-deleted) work gets pulled in fresh.
    const syncedRef = db.collection("users").doc(uid).collection("canvasSynced");
    let cleared = 0, removedTasks = 0;
    // Accept either a header or a query param — some shells mangle query strings.
    if (req.query.reset === "1" || req.headers["x-canvas-reset"] === "1") {
      const del = async (refs) => {
        for (let i = 0; i < refs.length; i += 400) {
          const batch = db.batch();
          refs.slice(i, i + 400).forEach((r) => batch.delete(r));
          await batch.commit();
        }
      };
      // Also delete the tasks this sync previously created. Clearing only the dedupe
      // memory re-imports everything on top of the existing copies, so each reset would
      // duplicate the whole list. Hand-written tasks (no canvasId) are left alone.
      const allTasks = await db.collection("users").doc(uid).collection("tasks").get();
      const canvasTasks = allTasks.docs.filter((d) => d.data().canvasId);
      await del(canvasTasks.map((d) => d.ref));
      removedTasks = canvasTasks.length;

      const old = await syncedRef.get();
      await del(old.docs.map((d) => d.ref));
      cleared = old.docs.length;
    }
    const seenSnap = cleared ? { docs: [] } : await syncedRef.get();
    const seen = new Set(seenSnap.docs.map((d) => d.id));

    const tasksRef = db.collection("users").doc(uid).collection("tasks");

    // Build the list of genuinely-new items first, with the facts the model needs.
    const fresh = pending.filter(({ a }) => !seen.has(String(a.id))).map(({ course, a, dueMs }) => {
      const { date, time } = localParts(a.due_at);
      const overdue = dueMs < now;
      return {
        course, a, dueMs, date, time, overdue,
        soon: dueMs - now < 2 * 24 * 60 * 60 * 1000,
        isTest: !!(a.quiz_id || (a.submission_types || []).includes("online_quiz") || TEST_WORDS.test(a.name || "")),
        blurb: stripHtml(a.description),
        dueLabel: `${date} ${time}`,
      };
    });

    // Ask the model to name/present them, in batches so one long response can't
    // get truncated. Any failure just falls through to plain formatting.
    const ai = new Map();
    let aiError = null;
    for (let i = 0; i < fresh.length; i += 8) {
      const batch = fresh.slice(i, i + 8);
      try {
        const got = await formatWithAI(batch);
        if (got) for (const [j, v] of got) if (batch[j]) ai.set(fresh[i + j], v);
      } catch (e) {
        // keep going with fallback formatting, but report why it fell back
        if (!aiError) aiError = String(e && e.message ? e.message : e).slice(0, 300);
      }
    }

    let added = 0;
    for (const item of fresh) {
      const { course, a, dueMs, date, time, overdue, soon, isTest } = item;
      const key = String(a.id);
      const smart = ai.get(item) || {};

      const bits = [shortCourse(course)];
      if (isTest) bits.push("Test/Quiz");
      if (a.points_possible) bits.push(`${a.points_possible} pts`);
      if (overdue) bits.push("OVERDUE");
      const fallbackDesc = bits.join(" · ");

      const id = db.collection("_").doc().id; // random id, same shape as the app's
      await tasksRef.doc(id).set({
        id,
        text: smart.title || a.name || "Canvas assignment",
        done: false,
        category: smart.category || (overdue ? "Urgent" : "Work"),
        priority: smart.priority || (overdue || isTest || soon ? "high" : "medium"),
        dueDate: date,
        dueTime: time,
        // Canvas link is always appended so the task stays traceable to the source.
        description: `${smart.description || fallbackDesc}\n${a.html_url || ""}`.trim(),
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

    return res.status(200).json({
      ok: true,
      courses: courses.length,
      pending: pending.length,
      added,
      aiNamed: ai.size,
      aiError,
      cleared,
      removedTasks,
      overdue: fresh.filter((f) => f.overdue).length,
      upcoming: fresh.filter((f) => !f.overdue).length,
    });
  } catch (err) {
    return res.status(500).json({ error: "sync_failed", detail: String(err) });
  }
}
