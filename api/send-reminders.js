import admin from "firebase-admin";
import webpush from "web-push";

// How far back to still send a reminder (so a task due 3 hours ago on first setup
// doesn't suddenly fire, and a brief scheduler outage doesn't spam old reminders).
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

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

    let sent = 0, cleaned = 0, considered = 0;

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
    }

    return res.status(200).json({ ok: true, considered, sent, cleaned });
  } catch (err) {
    return res.status(500).json({ error: "send_failed", detail: String(err) });
  }
}
