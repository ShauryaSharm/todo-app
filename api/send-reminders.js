import admin from "firebase-admin";
import webpush from "web-push";

// How far back to still send a reminder (so a task due 3 hours ago on first setup
// doesn't suddenly fire, and a brief scheduler outage doesn't spam old reminders).
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Evening digest: a single "here's tomorrow" push, sent once per day from this hour
// onward (local time). Override with DIGEST_HOUR; set it to -1 to switch the digest off.
const DIGEST_HOUR = Number(process.env.DIGEST_HOUR ?? 19);
const TZ = "America/Los_Angeles";

function localNow() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hour12: false,
    }).formatToParts(new Date()).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour === "24" ? 0 : p.hour) };
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
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

    let sent = 0, cleaned = 0, considered = 0, digests = 0;

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

    return res.status(200).json({ ok: true, considered, sent, cleaned, digests });
  } catch (err) {
    return res.status(500).json({ error: "send_failed", detail: String(err) });
  }
}
