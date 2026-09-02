import admin from "firebase-admin";
import webpush from "web-push";
import { zonedToEpochMs, localNow, localAt, addDays } from "../lib/localtime.js";

// How far back to still send a reminder (so a task due 3 hours ago on first setup
// doesn't suddenly fire, and a brief scheduler outage doesn't spam old reminders).
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Evening digest: a single "here's tomorrow" push, sent once per day from this hour
// onward (local time). Override with DIGEST_HOUR; set it to -1 to switch the digest off.
const DIGEST_HOUR = Number(process.env.DIGEST_HOUR ?? 19);

// Advance warnings, furthest out first. Each fires once per task; which ones already
// went out is recorded on the task in `notifiedStages`.
const HOUR = 60 * 60 * 1000;
export const STAGES = [
  { key: "1w", lead: 7 * 24 * HOUR },
  { key: "1d", lead: 24 * HOUR },
  { key: "6h", lead: 6 * HOUR },
];

// Say how long is actually left rather than naming the stage. Shifting a reminder out of
// quiet hours moves it — the day-before warning for an 11:59pm deadline goes out at 7am
// on the day itself — so a fixed "Due tomorrow" label would be plainly wrong.
export function titleFor(msLeft) {
  const h = Math.round(msLeft / HOUR);
  if (h >= 36) return `Due in ${Math.round(h / 24)} days`;
  if (h >= 20) return "Due tomorrow";
  if (h >= 2) return `Due in ${h} hours`;
  if (h >= 1) return "Due in about an hour";
  return "Due very soon";
}

// A task with a date but no time still deserves advance warning, so treat it as due at
// this hour. 5pm keeps every derived reminder inside waking hours: a week out and a day
// out both land at 5pm, and the six-hour warning at 11am the same morning.
const ANCHOR_HOUR = Number(process.env.DUE_ANCHOR_HOUR ?? 17);

// Don't buzz a phone overnight. A reminder landing in these hours is pushed to the
// morning instead — most schoolwork is due at 23:59, so without this the week-out and
// day-out warnings would both arrive just before midnight. Set QUIET_END to -1 to
// deliver at the exact computed time instead.
const QUIET_START = Number(process.env.QUIET_START ?? 22); // 10pm
const QUIET_END = Number(process.env.QUIET_END ?? 7); // 7am

function inQuietHours(hour) {
  if (QUIET_END < 0) return false;
  return QUIET_START > QUIET_END ? hour >= QUIET_START || hour < QUIET_END
                                 : hour >= QUIET_START && hour < QUIET_END;
}

// The instant a task is actually due, or null if it has no date at all.
export function dueAtOf(task) {
  if (!task.dueDate) return null;
  const time = task.dueTime || `${String(ANCHOR_HOUR).padStart(2, "0")}:00`;
  return zonedToEpochMs(task.dueDate, time);
}

// When a stage should actually be delivered: its exact lead time, moved to QUIET_END the
// next morning if that lands overnight. Returns null when the shift would carry it past
// the deadline — a nearer stage covers that case, and a "due in 6 hours" arriving after
// the thing is due is worse than staying quiet.
export function deliverAt(dueAt, lead) {
  let t = dueAt - lead;
  for (let i = 0; i < 2 && inQuietHours(localAt(t).hour); i++) {
    const { date, hour } = localAt(t);
    const morning = hour < QUIET_END ? date : addDays(date, 1);
    t = zonedToEpochMs(morning, `${String(QUIET_END).padStart(2, "0")}:00`);
  }
  return t >= dueAt ? null : t;
}

function initAdmin() {
  if (admin.apps.length) return;
  const stripBOM = (s) => s.replace(/^﻿/, "");
  const raw = stripBOM((process.env.FIREBASE_SERVICE_ACCOUNT || "").trim());

  // Try, in order: raw JSON; JSON with outer braces re-added (they sometimes get dropped
  // when pasting); base64-decoded JSON. First one that parses wins.
  const candidates = [raw, `{${raw}}`, () => stripBOM(Buffer.from(raw, "base64").toString("utf8").trim())];
  let serviceAccount, jsonErr;
  for (const c of candidates) {
    try { serviceAccount = JSON.parse(typeof c === "function" ? c() : c); break; }
    catch (e) { jsonErr = jsonErr || e; }
  }
  if (!serviceAccount) {
    const codes = [...raw.slice(0, 4)].map((ch) => ch.charCodeAt(0)).join(",");
    throw new Error(
      `service account unparseable: jsonError="${jsonErr && jsonErr.message}"; len=${raw.length}; firstCharCodes=[${codes}]; hasPrivateKey=${raw.includes("private_key")}`
    );
  }
  // private_key sometimes arrives with literal "\n" instead of real newlines — repair it
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

export default async function handler(req, res) {
  // Protect the endpoint: only the scheduler (which knows CRON_SECRET) may trigger it.
  const secret = req.query.secret || req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    initAdmin();
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:tosshaurya@gmail.com",
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    const db = admin.firestore();
    const now = Date.now();

    let sent = 0, cleaned = 0, considered = 0, digests = 0, advance = 0;

    // Loop per-user rather than a collectionGroup query, so we only rely on the
    // automatic collection-scope index (a collectionGroup query would require a
    // manually-enabled index). listDocuments() also finds users that only have
    // subcollections and no parent doc.
    const userRefs = await db.collection("users").listDocuments();
    for (const userRef of userRefs) {
      const uid = userRef.id;
      const snap = await userRef.collection("tasks").where("remindAt", "<=", now).get();

      let subsSnap = null;
      for (const doc of snap.docs) {
      const task = doc.data();
      if (task.done || task.notified) continue;
      if (typeof task.remindAt !== "number" || task.remindAt < now - WINDOW_MS) continue;
      considered++;

      if (!subsSnap) subsSnap = await userRef.collection("pushSubs").get();
      const payload = JSON.stringify({
        title: "Task due",
        body: task.text || "You have a task due.",
        tag: doc.id,
        url: "https://shauryasharm.github.io/todo-app/",
      });

      let delivered = 0;
      for (const subDoc of subsSnap.docs) {
        try {
          await webpush.sendNotification(subDoc.data(), payload);
          delivered++;
        } catch (err) {
          // subscription expired/invalid — remove it
          if (err.statusCode === 404 || err.statusCode === 410) {
            await subDoc.ref.delete().catch(() => {});
            cleaned++;
          }
        }
      }

      // mark notified so it doesn't fire again (even if there were no live subs)
      await doc.ref.update({ notified: true }).catch(() => {});
      if (delivered) sent++;
      }

      // ---- advance warnings: a week, a day and six hours before something is due
      const { date: today } = localNow();
      // Only tasks whose deadline is close enough for a stage to be live, so this stays
      // a small read even with a long history. One day of slack past the furthest stage.
      const upcoming = await userRef.collection("tasks")
        .where("dueDate", ">=", today)
        .where("dueDate", "<=", addDays(today, 8))
        .get();

      for (const doc of upcoming.docs) {
        const task = doc.data();
        if (task.done) continue;
        const dueAt = dueAtOf(task);
        if (!dueAt) continue;

        const already = Array.isArray(task.notifiedStages) ? task.notifiedStages : [];
        const ripe = STAGES.filter((st) => {
          if (already.includes(st.key)) return false;
          const at = deliverAt(dueAt, st.lead);
          return at !== null && now >= at && now < at + WINDOW_MS;
        });
        if (!ripe.length) continue;

        // If a task is created late, several stages can come due together. Send only the
        // most urgent, but record them all so the earlier ones don't fire afterwards.
        const stage = ripe[ripe.length - 1];
        considered++;

        if (!subsSnap) subsSnap = await userRef.collection("pushSubs").get();
        const payload = JSON.stringify({
          title: titleFor(dueAt - now),
          body: task.text || "You have a task coming up.",
          tag: `${doc.id}-${stage.key}`,
          url: "https://shauryasharm.github.io/todo-app/",
        });
        let delivered = 0;
        for (const subDoc of subsSnap.docs) {
          try { await webpush.sendNotification(subDoc.data(), payload); delivered++; }
          catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
              await subDoc.ref.delete().catch(() => {});
              cleaned++;
            }
          }
        }
        // Record even when nothing was delivered, so a phone that was offline doesn't
        // collect a week of backdated warnings the moment it reconnects.
        await doc.ref.update({
          notifiedStages: admin.firestore.FieldValue.arrayUnion(...ripe.map((r) => r.key)),
        }).catch(() => {});
        if (delivered) advance++;
      }

      // ---- evening digest: one heads-up about tomorrow, so the night can be planned
      const { date: todayLocal, hour } = localNow();
      if (DIGEST_HOUR >= 0 && hour >= DIGEST_HOUR) {
        const metaRef = userRef.collection("meta").doc("digest");
        const last = (await metaRef.get()).data()?.lastSent;
        if (last !== todayLocal) {
          const tomorrow = addDays(todayLocal, 1);
          const all = await userRef.collection("tasks").where("dueDate", "==", tomorrow).get();
          const open = all.docs.map((d) => d.data()).filter((t) => !t.done);
          if (open.length) {
            const top = open
              .sort((a, b) => (a.dueTime || "99:99").localeCompare(b.dueTime || "99:99"))
              .slice(0, 3).map((t) => t.text).join(" · ");
            if (!subsSnap) subsSnap = await userRef.collection("pushSubs").get();
            const payload = JSON.stringify({
              title: `${open.length} due tomorrow`,
              body: top + (open.length > 3 ? ` +${open.length - 3} more` : ""),
              tag: "digest-" + todayLocal,
              url: "https://shauryasharm.github.io/todo-app/",
            });
            for (const subDoc of subsSnap.docs) {
              try { await webpush.sendNotification(subDoc.data(), payload); digests++; }
              catch { /* dead subs are cleaned up by the reminder loop above */ }
            }
          }
          // Record it either way, so an empty day doesn't retry every minute.
          await metaRef.set({ lastSent: todayLocal }, { merge: true });
        }
      }
    }

    return res.status(200).json({ ok: true, considered, sent, advance, cleaned, digests });
  } catch (err) {
    return res.status(500).json({ error: "send_failed", detail: String(err) });
  }
}
