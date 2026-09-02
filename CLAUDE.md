# To Do — project instructions

Living reference for this project. **Keep it current**: whenever you add a feature, change
an endpoint, add an env var, or learn a non-obvious gotcha, update the relevant section in
the same commit. It exists so a brand-new chat can pick up without re-deriving anything.

Owner: Shaurya (Woodbridge HS, Irvine CA — IUSD). Timezone **America/Los_Angeles**.

---

## What this is

A vanilla-JS PWA to-do app (no build step, no framework) at
`C:\Users\tossh\Organized\Projects\TO DO LIST`. Installs to iPhone and laptop home
screens, syncs across devices, pulls in schoolwork from Canvas, and sends push reminders.

- **Repo:** GitHub `ShauryaSharm/todo-app` — **public** (required for free Pages). Never
  commit secrets.
- **App URL:** https://shauryasharm.github.io/todo-app/ (GitHub Pages)
- **API URL:** https://todo-app-tan-nine-89.vercel.app (Vercel, same repo, auto-deploys)

## Architecture

| Piece | Where | Notes |
|---|---|---|
| Static app | GitHub Pages | `index.html`, `app.js`, `style.css`, `sw.js` |
| Serverless API | Vercel `/api/*` | auto-deploys from the same repo on push |
| Auth + data | Firebase `todo-app-65862` (Spark/free) | Google sign-in, Firestore |
| AI | Groq | via `lib/groq.js` |
| Schedulers | **cron-job.org** | not GitHub Actions (see gotchas) |

**Firestore layout** (all under `users/{uid}/`): `tasks/{taskId}`, `pushSubs/{subId}`,
`canvasSynced/{canvasAssignmentId}`, `gmailSynced/{messageId}`, `meta/digest`.

### Endpoints
- `POST /api/organize` — natural-language quick-add. Returns title, category, priority,
  dueDate, dueTime, description, repeat. Gets a server-built date-reference table so
  relative dates ("friday") resolve correctly instead of the model doing date math.
- `POST /api/plan` — "Plan my day": orders today's tasks + a short coaching note.
- `/api/send-reminders` — cron target, **every 1 min**. Sends due-time pushes; also sends
  the 7pm evening digest ("3 due tomorrow").
- `/api/sync-canvas` — cron target, **hourly**. Canvas → tasks.
- `/api/sync-gmail` — cron target, hourly. Gmail label → tasks, AI decides what's actionable.

All cron endpoints are guarded by `CRON_SECRET`, accepted as header `x-cron-secret` **or**
`?secret=`.

### Vercel env vars
`GROQ_API_KEY`, `GROQ_MODEL` (optional override), `FIREBASE_SERVICE_ACCOUNT`,
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `CRON_SECRET`, `CANVAS_BASE_URL`, `CANVAS_TOKEN`,
`CANVAS_TARGET_UID`, `CANVAS_EXCLUDE_COURSES` (optional), `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GMAIL_LABEL`, `DIGEST_HOUR` (optional,
default 19, `-1` disables).

---

## Features

**Design:** true-black minimal, near-white accent (no amber/blue/purple — Shaurya ruled
those out). Colour comes only from category bars: Homework=orange, Work=lime,
Personal=teal, Shopping=green, Health=pink, Urgent=red, Other=gray. Overdue overrides to
fully red (bar, border, text).

**Views:** Today / Upcoming / Calendar / All / Done, with live count badges (Today's badge
turns red when anything is overdue). Calendar is an agenda grouped by day with month
headers and category-tinted cards.

**Tasks:** due date + time, priority, category, AI description, repeat. Inline editor
(tap a task) for title/date/time/priority/repeat/category, closed via Done button, Escape,
or clicking outside.

**Interaction:** swipe right to complete / left to delete (card flies off, *then* commits;
only arms once the gesture is clearly horizontal so scrolling still works), undo toast on
delete, haptics, staggered entrance, page-load cascade, view crossfade, "all done"
celebration. Respects `prefers-reduced-motion`.

**AI:** quick-add parses reminder/alarm phrasing ("remind me to X at 8pm"), dates, times,
category, priority, and recurrence. Plan my day. Canvas/Gmail item naming.

**Reminders:** web push to installed PWA. Per-task at due time + a 7pm digest of
tomorrow's work.

**Recurring:** daily / weekdays / weekly / monthly. Completing spawns the next occurrence
and leaves the finished copy in Done.

---

## Critical workflows

### Deploying
```
cd "C:\Users\tossh\Organized\Projects\TO DO LIST"
git push origin main
```
**Claude's `git push` is blocked by the permission classifier** — commit normally, then ask
Shaurya to run the push himself. One push deploys both Pages and Vercel. Wait ~1 min.

### After changing client files
Bump `CACHE_NAME` in `sw.js` (currently around v27). Then hard-refresh (Ctrl+Shift+R) or
fully close/reopen the phone app, or the old cached version keeps serving.

### After changing `firestore.rules`
**Pushing does NOT deploy Firestore rules.** They must be pasted into Firebase Console →
Firestore → Rules → Publish. Forgetting this caused a silent "Missing or insufficient
permissions" bug.

### Verifying things
Prefer real evidence over reasoning. Endpoints can be curl'd directly with `CRON_SECRET`;
GitHub run history is readable via `api.github.com/repos/ShauryaSharm/todo-app/actions/...`;
Groq's live model list via `curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $KEY"`.

---

## Gotchas (all learned the hard way — don't re-discover these)

- **GitHub Actions cron is throttled.** A `*/5 * * * *` schedule actually fired every
  1–3 hours on this low-activity repo. Confirmed via run timestamps. Use **cron-job.org**.
  `.github/workflows/reminders.yml` remains only as a harmless backup.
- **Never hardcode a Groq model.** Groq retired `llama-3.1-8b-instant` *and*
  `llama-3.3-70b-versatile`, silently breaking every AI feature at once. `lib/groq.js`
  walks a chain (currently leading with `openai/gpt-oss-20b`) and stops early on 401/403.
- **Firestore needs `persistentLocalCache`.** The default memory cache lost offline writes
  when the PWA was killed, and the next cloud snapshot overwrote the local copy.
- **Don't let the sync resurrect user checkoffs.** Completions record `completedBy`
  (`"user"` vs `"sync"`); the Canvas sync only re-opens its own. Plenty of schoolwork is
  finished without being submitted on Canvas.
- **Reset must delete tasks too.** Clearing only the dedupe memory re-imported everything
  on top of existing copies (21 tasks for 7 assignments). Every sync now also collapses
  duplicates sharing a `canvasId`.
- **A time with no date must default to today**, or `remindAt` never computes and the
  reminder silently never fires — with no visible date chip either.
- **Always clear loading state in `finally`.** An early return left task ids in
  `parsingIds`, so cards shimmered "thinking" forever and looked unsaved.
- **`setMonth` overflows.** Jan 31 + 1 month becomes Mar 3; monthly recurrence clamps to
  the last real day instead.
- **Env vars only reach new Vercel deployments.** Redeploying an old build can reuse the
  old (empty) values — push a commit instead.
- **Watch for placeholder text in pasted commands** (`YOUR_REAL_SECRET`,
  `PASTE_YOUR_KEY_HERE`) — this has caused several false "it's broken" reports.
- Screenshots frequently time out in the local preview browser; verify via DOM inspection
  instead, but remember that misses purely *visual* bugs (a squished layout slipped
  through that way once).

---

## Working style

- Shaurya is a high-school student, not a professional developer. Give exact click-by-click
  steps for anything in a browser UI, and full terminal commands including `cd`.
- When he says something is broken after an explanation, **stop reasoning and go get hard
  data** — this has repeatedly proved him right and me wrong. See
  `debug-with-hard-data-not-theory` in memory.
- Surface real error messages rather than generic ones; several long debugging sessions
  were caused by error handling that masked the actual failure.
- He can't create accounts or paste secrets on his behalf — guide, don't guess.
- Prefer fixing root causes and self-healing behaviour over one-off cleanups.

---

## Local-only, never commit

`Connecting iusd.instructure/` — Python scripts + `.env` holding the Canvas token. It's in
`.gitignore` (the repo is public). It's the original source of the Canvas integration; the
live sync is the Vercel function, not these scripts.

---

## Status / open items

- Working: PWA install, cross-device sync, Canvas hourly sync, push reminders, evening
  digest, recurring tasks, swipe gestures, offline persistence, AI quick-add.
- **In progress: Gmail sync.** Code is written (`api/sync-gmail.js`) and committed, but
  OAuth setup is unfinished — needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REFRESH_TOKEN` and `GMAIL_LABEL` in Vercel, then a test run, then an hourly
  cron-job.org entry. Shaurya was midway through the Google Cloud OAuth playground steps.
- Deliberately not built (judged as clutter for now): search, subtasks, course grouping.
