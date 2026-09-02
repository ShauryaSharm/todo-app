import admin from "firebase-admin";

import { groqChat } from "../lib/groq.js";
import { initAdmin } from "../lib/firebase-admin.js";

// Canvas pagination plus the AI naming pass can run past Vercel's 10s default.
export const maxDuration = 60;

const TZ = "America/Los_Angeles";
const TEST_WORDS = /\b(quiz|test|exam|midterm|final|assessment)\b/i;
// Ignore work that's been overdue longer than this, so old missing assignments
// from earlier in the term don't flood the list.
const MAX_OVERDUE_MS = 20 * 24 * 60 * 60 * 1000;

// Canvas lists clubs, counseling pages and forums as "courses" even though they carry
// no real coursework. Matched case-insensitively as substrings of the course name.
// Set CANVAS_EXCLUDE_COURSES in Vercel (comma-separated) to replace this list.
const DEFAULT_EXCLUDES = ["student forum", "counseling", "join whs leadership"];
const EXCLUDES = (() => {
  const custom = (process.env.CANVAS_EXCLUDE_COURSES || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return custom.length ? custom : DEFAULT_EXCLUDES;
})();
function isExcludedCourse(name) {
  const l = String(name || "").toLowerCase();
  return EXCLUDES.some((e) => l.includes(e));
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

const CATEGORIES = ["Homework", "Work", "Personal", "Shopping", "Health", "Urgent", "Other"];

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

  const { data } = await groqChat({
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
          `- "category": exactly one of ${CATEGORIES.join(", ")}. School work is "Homework" unless it's ` +
          `overdue, in which case "Urgent".\n` +
          `- "priority": high, medium, or low. Tests/quizzes, overdue work, and high point values are high; ` +
          `small routine homework is low; everything else medium.\n` +
          `- "description": one short line of useful context (course, what it is, points). No URLs. ` +
          `Don't restate the title.`,
      }, { role: "user", content: lines }],
  });
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
    const pending = [];     // still needs doing -> should exist as an open task
    const submitted = [];   // turned in / graded -> matching task should be checked off
    const skippedCourses = [];
    for (const c of courses) {
      if (isExcludedCourse(c.name)) { skippedCourses.push(c.name); continue; }
      const assignments = await canvasGetAll(
        `/api/v1/courses/${c.id}/assignments`, { "include[]": "submission" }
      );
      for (const a of assignments) {
        if (!a.published || !a.due_at) continue;             // skip undated/unpublished
        const dueMs = new Date(a.due_at).getTime();
        if (now - dueMs > MAX_OVERDUE_MS) continue;          // too old to be worth showing
        const sub = a.submission || {};
        if (sub.submitted_at || sub.workflow_state === "graded") submitted.push({ a });
        else pending.push({ course: c.name, a, dueMs });
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

    // Index the Canvas-imported tasks that already exist, so this run can reconcile
    // them instead of blindly re-adding.
    const existingSnap = cleared ? { docs: [] } : await tasksRef.get();
    const byCanvasId = new Map();
    const duplicateRefs = [];
    for (const d of existingSnap.docs) {
      const t = d.data();
      if (!t.canvasId) continue;                 // hand-written task, leave alone
      const k = String(t.canvasId);
      const prev = byCanvasId.get(k);
      // Already-imported work from a course that's since been excluded should go away
      // too, not linger forever just because it was added before the rule existed.
      const from = `${t.canvasCourse || ""} ${t.description || ""}`;
      if (isExcludedCourse(from)) { duplicateRefs.push(d.ref); continue; }
      if (!prev) { byCanvasId.set(k, { ref: d.ref, task: t }); continue; }
      // Two tasks for the same assignment: keep one, drop the other. Prefer a copy
      // that's already checked off (don't lose completion), otherwise the oldest.
      const preferNew =
        (t.done && !prev.task.done) ||
        (!!t.done === !!prev.task.done && (t.createdAt || 0) < (prev.task.createdAt || 0));
      if (preferNew) { duplicateRefs.push(prev.ref); byCanvasId.set(k, { ref: d.ref, task: t }); }
      else { duplicateRefs.push(d.ref); }
    }

    // Clean up duplicates left behind by earlier runs, so the list self-heals
    // instead of needing a full reset.
    let duplicatesRemoved = 0;
    for (let i = 0; i < duplicateRefs.length; i += 400) {
      const b = db.batch();
      duplicateRefs.slice(i, i + 400).forEach((r) => b.delete(r));
      await b.commit();
    }
    duplicatesRemoved = duplicateRefs.length;

    let updated = 0, completed = 0, reopened = 0, aiError = null;

    // 1. Anything turned in on Canvas gets checked off here (if it isn't already).
    for (const { a } of submitted) {
      const hit = byCanvasId.get(String(a.id));
      if (!hit || hit.task.done) continue;
      await hit.ref.update({
        done: true, completedAt: Date.now(), completedBy: "sync", updatedAt: Date.now(),
      });
      completed++;
    }

    // 2. Still-pending work that's already on the list: refresh the facts Canvas owns
    //    (due date/time) without touching the title, category or done state, so edits
    //    made in the app survive a sync.
    for (const { a, dueMs } of pending) {
      const hit = byCanvasId.get(String(a.id));
      if (!hit) continue;
      const { date, time } = localParts(a.due_at);
      const t = hit.task;
      const patch = {};

      // Only undo a completion this sync made itself. If a person checked it off, that
      // stands — plenty of work is finished without ever being submitted on Canvas
      // (handed in on paper, done in class), and resurrecting it every hour is worse
      // than leaving a stale item done.
      if (t.done && t.completedBy === "sync") {
        patch.done = false;
        patch.completedAt = null;
        patch.completedBy = null;
        reopened++;
      }
      if (t.dueDate !== date || t.dueTime !== time) {
        patch.dueDate = date;
        patch.dueTime = time;
        patch.remindAt = dueMs;
        patch.notified = dueMs < now;   // re-arm the reminder for a moved due date
        updated++;
      }

      if (!Object.keys(patch).length) continue;   // nothing changed
      patch.updatedAt = Date.now();
      await hit.ref.update(patch);
    }

    // 2b. Backfill AI naming for work imported while the model was down. Only touch
    //     tasks whose title is still the exact raw Canvas name — if it differs, the AI
    //     already named it or the user edited it, and neither should be clobbered.
    const needsName = pending
      .map((p) => ({ ...p, hit: byCanvasId.get(String(p.a.id)) }))
      .filter((p) => p.hit && (p.hit.task.text || "") === (p.a.name || ""))
      .map((p) => ({
        ...p,
        overdue: p.dueMs < now,
        isTest: !!(p.a.quiz_id || (p.a.submission_types || []).includes("online_quiz") || TEST_WORDS.test(p.a.name || "")),
        blurb: stripHtml(p.a.description),
        dueLabel: localParts(p.a.due_at).date + " " + localParts(p.a.due_at).time,
      }));

    let renamed = 0;
    for (let i = 0; i < needsName.length; i += 8) {
      const batch = needsName.slice(i, i + 8);
      try {
        const got = await formatWithAI(batch);
        if (!got) continue;
        for (const [j, v] of got) {
          const item = batch[j];
          if (!item || !v || !v.title) continue;
          const keepUrl = (item.hit.task.description || "").match(/https?:\/\/\S+/);
          await item.hit.ref.update({
            text: v.title,
            category: v.category || item.hit.task.category,
            priority: v.priority || item.hit.task.priority,
            description: `${v.description || ""}\n${keepUrl ? keepUrl[0] : ""}`.trim(),
            updatedAt: Date.now(),
          });
          renamed++;
        }
      } catch (e) {
        if (!aiError) aiError = String(e && e.message ? e.message : e).slice(0, 300);
      }
    }

    // 3. Genuinely new work: never imported before, and not already on the list.
    const fresh = pending
      .filter(({ a }) => !seen.has(String(a.id)) && !byCanvasId.has(String(a.id)))
      .map(({ course, a, dueMs }) => {
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
        category: smart.category || (overdue ? "Urgent" : "Homework"),
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
        canvasCourse: course || "",
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
      updated,
      completed,
      reopened,
      duplicatesRemoved,
      renamed,
      skippedCourses,
      cleared,
      removedTasks,
      overdue: fresh.filter((f) => f.overdue).length,
      upcoming: fresh.filter((f) => !f.overdue).length,
    });
  } catch (err) {
    return res.status(500).json({ error: "sync_failed", detail: String(err) });
  }
}
