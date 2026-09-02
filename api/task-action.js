import { initAdmin } from "../lib/firebase-admin.js";
import { verifyAction } from "../lib/action-token.js";

const ALLOWED_ORIGIN = "https://shauryasharm.github.io";

// Snooze lengths the service worker is allowed to ask for. Bounded so a replayed or
// fiddled request can't park a task years out where it silently never fires again.
const MIN_SNOOZE = 5;
const MAX_SNOOZE = 24 * 60;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { token, action, minutes } = req.body || {};
  // The token is the only credential here: the service worker acts with the app closed
  // and no signed-in user, so it proves nothing except "a push we sent named this task".
  const claim = verifyAction(token);
  if (!claim) return res.status(401).json({ error: "bad or expired token" });
  if (action !== "done" && action !== "snooze") {
    return res.status(400).json({ error: "action must be done or snooze" });
  }

  try {
    const app = initAdmin();
    const ref = app.firestore()
      .collection("users").doc(claim.uid)
      .collection("tasks").doc(claim.taskId);

    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "task no longer exists" });
    const task = snap.data();

    if (action === "done") {
      if (task.done) return res.status(200).json({ ok: true, action, already: true });
      // completedBy "user" matters: the Canvas sync only re-opens completions it made
      // itself, so a tap here has to be recorded as a person's decision or the next
      // hourly sync would undo it.
      await ref.update({
        done: true,
        completedAt: Date.now(),
        completedBy: "user",
        snoozedUntil: null,
        updatedAt: Date.now(),
      });
      return res.status(200).json({ ok: true, action, text: task.text || "" });
    }

    const mins = Math.min(MAX_SNOOZE, Math.max(MIN_SNOOZE, Number(minutes) || 60));
    const until = Date.now() + mins * 60 * 1000;
    await ref.update({ snoozedUntil: until, updatedAt: Date.now() });
    return res.status(200).json({ ok: true, action, minutes: mins, until });
  } catch (err) {
    return res.status(500).json({ error: "action_failed", detail: String(err).slice(0, 300) });
  }
}
