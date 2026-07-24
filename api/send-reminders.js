import admin from "firebase-admin";
import webpush from "web-push";

// How far back to still send a reminder (so a task due 3 hours ago on first setup
// doesn't suddenly fire, and a brief scheduler outage doesn't spam old reminders).
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

function initAdmin() {
  if (admin.apps.length) return;
  const stripBOM = (s) => s.replace(/^﻿/, "");
  const raw = stripBOM((process.env.FIREBASE_SERVICE_ACCOUNT || "").trim());

  // Accept either raw JSON or base64-encoded JSON. Rather than guessing from the first
  // character (fragile — a leading BOM or stray whitespace defeats that), just try
  // parsing it directly first and only fall back to base64-decoding if that fails.
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    const decoded = stripBOM(Buffer.from(raw, "base64").toString("utf8"));
    serviceAccount = JSON.parse(decoded);
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

    // Tasks whose reminder time has arrived. Single-field range → no composite index needed.
    const snap = await db
      .collectionGroup("tasks")
      .where("remindAt", "<=", now)
      .get();

    let sent = 0, cleaned = 0, considered = 0;

    for (const doc of snap.docs) {
      const task = doc.data();
      if (task.done || task.notified) continue;
      if (typeof task.remindAt !== "number" || task.remindAt < now - WINDOW_MS) continue;
      considered++;

      const uid = doc.ref.parent.parent && doc.ref.parent.parent.id;
      if (!uid) continue;

      const subsSnap = await db.collection("users").doc(uid).collection("pushSubs").get();
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

    return res.status(200).json({ ok: true, considered, sent, cleaned });
  } catch (err) {
    return res.status(500).json({ error: "send_failed", detail: String(err) });
  }
}
