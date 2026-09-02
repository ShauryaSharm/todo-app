import { groqChat } from "../lib/groq.js";
import { initAdmin } from "../lib/firebase-admin.js";
import { getAccessToken, googleApi } from "../lib/google-oauth.js";
import { TZ, zonedToEpochMs, localNow, addDays } from "../lib/localtime.js";
import crypto from "crypto";

// Two directions plus per-event AI triage; comfortably past Vercel's 10s default.
export const maxDuration = 60;

const CAL = "https://www.googleapis.com/calendar/v3";

// The calendar this app creates and owns. The calendar.app.created scope only grants
// access to calendars the app made itself, so this is the only one it can write to —
// the real calendars are readable and untouchable.
const CAL_NAME = process.env.CALENDAR_NAME || "To Do";

const PUSH_BACK_DAYS = 7; // keep recently-overdue work visible on the calendar
const PUSH_AHEAD_DAYS = 60;
const PULL_AHEAD_DAYS = Number(process.env.CALENDAR_PULL_DAYS ?? 30);
const MAX_EVENTS = 40;

const CATEGORIES = ["Homework", "Work", "Personal", "Shopping", "Health", "Urgent", "Other"];

// Google event ids must be base32hex (0-9, a-v). A sha1 hex digest is a subset of that,
// so deriving the id from the task id makes writes idempotent — no mapping to store, and
// a re-run updates the same event instead of creating a duplicate.
const eventIdFor = (taskId) =>
  "todo" + crypto.createHash("sha1").update(String(taskId)).digest("hex");

// ---------- the app's own calendar ----------
async function ensureCalendar(token, metaRef) {
  const saved = (await metaRef.get()).data()?.calendarId;
  if (saved) {
    // Confirm it still exists — deleting it in Google shouldn't wedge the sync forever.
    try {
      await googleApi(`${CAL}/calendars/${encodeURIComponent(saved)}`, token);
      return { id: saved, created: false };
    } catch (err) {
      if (err.status !== 404 && err.status !== 403) throw err;
    }
  }
  const made = await googleApi(`${CAL}/calendars`, token, {
    method: "POST",
    body: JSON.stringify({ summary: CAL_NAME, timeZone: TZ }),
  });
  await metaRef.set({ calendarId: made.id, calendarName: CAL_NAME }, { merge: true });
  return { id: made.id, created: true };
}

// ---------- tasks -> calendar ----------
// A dated task becomes an all-day event, or a 30-minute block when it has a due time.
function eventForTask(task) {
  const body = {
    summary: task.text || "Task",
    description: [task.description || "", "— from To Do"].filter(Boolean).join("\n"),
    source: { title: "To Do", url: "https://shauryasharm.github.io/todo-app/" },
  };
  if (task.dueTime) {
    const startMs = zonedToEpochMs(task.dueDate, task.dueTime);
    body.start = { dateTime: new Date(startMs).toISOString(), timeZone: TZ };
    body.end = { dateTime: new Date(startMs + 30 * 60000).toISOString(), timeZone: TZ };
  } else {
    body.start = { date: task.dueDate };
    body.end = { date: addDays(task.dueDate, 1) }; // an all-day end date is exclusive
  }
  return body;
}

async function upsertEvent(token, calId, task) {
  const id = eventIdFor(task.id);
  const body = eventForTask(task);
  const base = `${CAL}/calendars/${encodeURIComponent(calId)}/events`;
  try {
    await googleApi(`${base}/${id}`, token, { method: "PUT", body: JSON.stringify(body) });
    return "updated";
  } catch (err) {
    // 404 = not there yet; 410 = deleted previously, which PUT can't revive.
    if (err.status !== 404 && err.status !== 410) throw err;
    await googleApi(base, token, { method: "POST", body: JSON.stringify({ ...body, id }) });
    return "created";
  }
}

async function removeEvent(token, calId, taskId) {
  try {
    await googleApi(
      `${CAL}/calendars/${encodeURIComponent(calId)}/events/${eventIdFor(taskId)}`,
      token,
      { method: "DELETE" }
    );
    return true;
  } catch (err) {
    if (err.status === 404 || err.status === 410) return false; // already gone
    throw err;
  }
}

// ---------- calendar -> tasks ----------
// Same strictness as the Gmail triage: most of a calendar is schedule, not to-do items.
async function triageEvents(events, today) {
  const lines = events.map((e, i) =>
    `${i}. title="${e.summary}" | when="${e.when}" | where="${e.location}" | notes="${e.description.slice(0, 200)}"`
  ).join("\n");

  const { data } = await groqChat({
    temperature: 0.2,
    max_tokens: 1200,
    response_format: { type: "json_object" },
    messages: [{
      role: "system",
      content:
        `You decide which of a student's calendar events need a to-do item. Today is ${today}. ` +
        `Return ONLY JSON: {"items":[{"i":<index>,"task":true|false,"title":...,"category":...,` +
        `"priority":...,"dueDate":...,"dueTime":...,"description":...}]} with one entry per input ` +
        `line, same index.\n` +
        `- "task": true ONLY if something must be DONE or PREPARED, not merely attended. An event ` +
        `you just show up to is NOT a task — the calendar already reminds you about it. A test to ` +
        `revise for, a form to bring, a project due, something to buy beforehand IS a task.\n` +
        `- Default to FALSE for classes, practices, lunch, shifts, appointments you simply attend, ` +
        `birthdays, holidays, reminders and blocked-out time. Be strict: a wrong true adds clutter, ` +
        `a wrong false costs nothing.\n` +
        `- "title": short imperative, how a student would write it ("Study for bio test"). Under 60 ` +
        `chars. Never just copy the event title.\n` +
        `- "category": one of ${CATEGORIES.join(", ")}. School-related is "Homework".\n` +
        `- "priority": high, medium or low.\n` +
        `- "dueDate": "YYYY-MM-DD", normally the event's own date, or earlier when the work has to ` +
        `be finished beforehand. "dueTime": "HH:MM" 24-hour if a time matters, else null.\n` +
        `- "description": one short line of context. No URLs.\n` +
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

  try {
    const app = initAdmin();
    const db = app.firestore();

    let uid = (process.env.CANVAS_TARGET_UID || "").trim();
    if (!uid) {
      const users = await db.collection("users").listDocuments();
      if (users.length !== 1) return res.status(400).json({ error: "set CANVAS_TARGET_UID" });
      uid = users[0].id;
    }

    const token = await getAccessToken();
    const userRef = db.collection("users").doc(uid);
    const metaRef = userRef.collection("meta").doc("calendar");
    const tasksRef = userRef.collection("tasks");

    const { id: calId, created } = await ensureCalendar(token, metaRef);
    const { date: today } = localNow();

    // ---------- push: dated tasks onto the app's own calendar ----------
    const from = addDays(today, -PUSH_BACK_DAYS);
    const to = addDays(today, PUSH_AHEAD_DAYS);
    const dated = await tasksRef.where("dueDate", ">=", from).where("dueDate", "<=", to).get();

    let pushed = 0, unpushed = 0;
    for (const doc of dated.docs) {
      const task = doc.data();
      if (!task.dueDate) continue;
      const onCalendar = !!task.calendarPushedAt;

      // A finished task shouldn't clutter the calendar; drop the event, keep the task.
      if (task.done) {
        if (onCalendar) {
          if (await removeEvent(token, calId, doc.id)) unpushed++;
          await doc.ref.update({ calendarPushedAt: null }).catch(() => {});
        }
        continue;
      }
      // Only rewrite when something the event actually shows has changed.
      if (onCalendar && task.calendarPushedAt >= (task.updatedAt || 0)) continue;

      await upsertEvent(token, calId, { ...task, id: doc.id });
      await doc.ref.update({ calendarPushedAt: Date.now() }).catch(() => {});
      pushed++;
    }

    if (req.query.pushonly) {
      return res.status(200).json({
        ok: true, calendar: CAL_NAME, calendarCreated: created, pushed, unpushed,
      });
    }

    // ---------- pull: real calendar events -> tasks ----------
    const cals = (await googleApi(`${CAL}/users/me/calendarList`, token)).items || [];
    const timeMin = new Date().toISOString();
    const timeMax = new Date(zonedToEpochMs(addDays(today, PULL_AHEAD_DAYS), "23:59")).toISOString();

    const candidates = [];
    for (const c of cals) {
      if (c.id === calId) continue; // never read our own calendar — that's a feedback loop
      const q = new URLSearchParams({
        timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "50",
      });
      const page = await googleApi(`${CAL}/calendars/${encodeURIComponent(c.id)}/events?${q}`, token);
      for (const ev of page.items || []) {
        if (ev.status === "cancelled") continue;
        // Instances of a repeating series are a timetable, not work: classes, practices,
        // shifts. Judging each of thirty instances separately would flood the list.
        if (ev.recurringEventId) continue;
        if (ev.transparency === "transparent") continue; // marked "free"
        candidates.push({
          id: ev.id,
          summary: ev.summary || "(no title)",
          description: ev.description || "",
          location: ev.location || "",
          when: ev.start?.dateTime || ev.start?.date || "",
        });
      }
    }

    // Remember every event judged, including the "not a task" ones, so re-runs don't
    // re-triage and a task deleted in the app doesn't come back.
    const seenRef = userRef.collection("calendarSynced");
    const seen = new Set((await seenRef.get()).docs.map((d) => d.id));
    const fresh = candidates.filter((e) => !seen.has(e.id)).slice(0, MAX_EVENTS);

    // ?inspect=1 — what past runs decided, touching nothing.
    if (req.query.inspect) {
      const rows = (await seenRef.get()).docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0));
      return res.status(200).json({
        ok: true, examined: rows.length, madeTasks: rows.filter((r) => r.madeTask).length,
        verdicts: rows.slice(0, 60).map((r) => ({
          madeTask: !!r.madeTask, summary: r.summary || "(none)",
          seenAt: r.seenAt ? new Date(r.seenAt).toISOString() : null,
        })),
      });
    }

    if (!fresh.length) {
      return res.status(200).json({
        ok: true, calendar: CAL_NAME, calendarCreated: created,
        pushed, unpushed, matched: candidates.length, examined: 0, added: 0,
      });
    }

    // ?dry=1 — see the verdicts without writing anything, same as the Gmail sync.
    if (req.query.dry) {
      const out = [];
      for (let i = 0; i < fresh.length; i += 8) {
        const batch = fresh.slice(i, i + 8);
        const verdicts = await triageEvents(batch, today);
        batch.forEach((e, j) => out.push({
          summary: e.summary, when: e.when, verdict: verdicts.get(j) || null,
        }));
      }
      return res.status(200).json({
        ok: true, dry: true, pushed, examined: out.length,
        wouldAdd: out.filter((o) => o.verdict).length, results: out,
      });
    }

    let added = 0;
    for (let i = 0; i < fresh.length; i += 8) {
      const batch = fresh.slice(i, i + 8);
      const verdicts = await triageEvents(batch, today);
      for (let j = 0; j < batch.length; j++) {
        const ev = batch[j];
        const v = verdicts.get(j);
        if (v) {
          const id = db.collection("_").doc().id;
          await tasksRef.doc(id).set({
            id,
            text: v.title,
            done: false,
            category: v.category,
            priority: v.priority,
            dueDate: v.dueDate,
            dueTime: v.dueTime,
            description: v.description,
            remindAt: v.dueDate && v.dueTime ? zonedToEpochMs(v.dueDate, v.dueTime) : null,
            notified: false,
            notifiedStages: [],
            snoozedUntil: null,
            repeat: null,
            calendarEventId: ev.id,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          added++;
        }
        // Recorded either way, so a "not a task" verdict isn't re-judged hourly.
        await seenRef.doc(ev.id).set({
          summary: ev.summary.slice(0, 200), madeTask: !!v, seenAt: Date.now(),
        });
      }
    }

    return res.status(200).json({
      ok: true, calendar: CAL_NAME, calendarCreated: created,
      pushed, unpushed, matched: candidates.length, examined: fresh.length, added,
    });
  } catch (err) {
    return res.status(500).json({ error: "calendar_sync_failed", detail: String(err).slice(0, 400) });
  }
}
