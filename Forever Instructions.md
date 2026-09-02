# To Do — project instructions

Living reference for this project. **Keep it current**: whenever you add a feature, change
an endpoint, add an env var, or learn a non-obvious gotcha, update the relevant section in
the same commit. It exists so a brand-new chat can pick up without re-deriving anything.

**This file is the real reference.** `CLAUDE.md` next to it is a two-line stub that points
here — it exists only because that filename is what auto-loads into a session. Edit this
file; leave the stub alone.

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
| Date/zone math | `lib/localtime.js` | local↔UTC, shared by every function |
| Firebase init | `lib/firebase-admin.js` | one copy; the env var is a lossy channel |
| Action tokens | `lib/action-token.js` | signs notification Done/Snooze buttons |
| Google auth | `lib/google-oauth.js` | one refresh token for Gmail + Calendar |
| Schedulers | **cron-job.org** | not GitHub Actions (see gotchas) |

**Firestore layout** (all under `users/{uid}/`): `tasks/{taskId}`, `pushSubs/{subId}`,
`canvasSynced/{canvasAssignmentId}`, `gmailSynced/{messageId}`,
`calendarSynced/{eventId}`, `meta/digest`, `meta/calendar` (holds `calendarId`).

### Endpoints
- `POST /api/organize` — natural-language quick-add. Returns title, category, priority,
  dueDate, dueTime, description, repeat. Gets a server-built date-reference table so
  relative dates ("friday") resolve correctly instead of the model doing date math.
- `POST /api/plan` — "Plan my day": orders today's tasks + a short coaching note.
- `/api/send-reminders` — cron target, **every 1 min**. Sends due-time pushes, the three
  advance warnings (a week / a day / six hours before), and the 7pm evening digest
  ("3 due tomorrow").
- `/api/sync-canvas` — cron target, **hourly**. Canvas → tasks.
- `/api/task-action` — POST, called by the **service worker** when a notification's
  Done or Snooze button is tapped. Not cron-guarded: it authenticates with a signed,
  expiring token naming one task (`lib/action-token.js`), because the service worker
  runs with the app closed and no signed-in user. CORS-limited to the Pages origin.
- `/api/sync-calendar` — cron target, hourly. Two directions. **Push:** every open dated
  task becomes an event on a separate Google calendar named "To Do" that the app creates
  and owns; finishing a task deletes its event. **Pull:** events on the *real* calendars
  are AI-triaged into tasks — strictly, since a calendar is mostly schedule rather than
  work ("an event you just show up to is not a task"). Same `&inspect=1` / `&dry=1` modes
  as the Gmail sync, plus `&pushonly=1` to skip the read half.
- `/api/sync-gmail` — cron target, hourly. Gmail label(s) → tasks, AI decides what's
  actionable. Two diagnostic modes, both leaving the data alone: `&inspect=1` lists what
  past runs decided (including the "not a task" verdicts, the only way to tell whether the
  prompt is too strict), `&dry=1` triages unseen mail and reports what it *would* create
  without writing or marking anything examined. `GMAIL_LABEL` accepts one label or a comma-separated list; multiple labels
  are OR'd via Gmail's `{...}` brace syntax. Read-only scope, last 14 days, 25 messages a
  run. Every message examined is recorded in `gmailSynced` — including "not a task"
  verdicts — so nothing is re-triaged and deleted tasks don't come back.

All cron endpoints are guarded by `CRON_SECRET`, accepted as header `x-cron-secret` **or**
`?secret=`.

### Vercel env vars
`GROQ_API_KEY`, `GROQ_MODEL` (optional override), `FIREBASE_SERVICE_ACCOUNT`,
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `CRON_SECRET`, `CANVAS_BASE_URL`, `CANVAS_TOKEN`,
`CANVAS_TARGET_UID`, `CANVAS_EXCLUDE_COURSES` (optional), `DUE_ANCHOR_HOUR` (optional,
default 17), `QUIET_START`/`QUIET_END` (optional, default 22/7; `QUIET_END=-1` disables
quiet hours), `SWEEP_EVERY_MIN` (optional, default 5; 1 disables the gate),
`CALENDAR_NAME` (optional, default "To Do"), `CALENDAR_PULL_DAYS` (optional, default
30), `ACTION_SECRET` (optional, falls back to `CRON_SECRET`), `PUBLIC_API_BASE`
(optional), `GOOGLE_CLIENT_ID`,
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

**Notification buttons:** reminders carry **Done** and **Snooze 1h**, handled in `sw.js`
without opening the app. A repeating task gets Snooze only — completing one has to spawn
its next occurrence and that logic lives in the client, so a server-side Done would
quietly break the chain. A failed tap (offline, expired token) raises a "Couldn't update
that task" notification rather than silently doing nothing. iOS renders action buttons
only from 16.4 and inconsistently; where they're absent the notification still opens the
app on tap. Done records `completedBy: "user"`, so the Canvas sync won't undo it.

**Reminders:** web push to installed PWA. Per-task at due time, three advance warnings
(1 week / 1 day / 6 hours before), and a 7pm digest of tomorrow's work. Which warnings
have already gone out is recorded per task in `notifiedStages`; `applyRemind()` clears it
so moving a due date re-arms them. A task with a date but no time is treated as due at
`DUE_ANCHOR_HOUR` (5pm) purely for reminder timing. Anything landing between 22:00 and
07:00 is pushed to 07:00 — most schoolwork is due at 23:59, so without that the week-out
and day-out warnings would both arrive just before midnight. A warning whose shifted time
would fall after the deadline is dropped rather than sent late. Notification titles are
derived from the time actually remaining at delivery ("Due in 17 hours"), never from the
stage name, because the quiet-hours shift makes a fixed "Due tomorrow" wrong.

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
- **Anything derived from "today" needs a re-render when the day rolls over.** The PWA is
  backgrounded, not closed, so `app.js` re-renders on `visibilitychange`, on `focus`, and
  on a 60s interval; without it the app shows yesterday's Today, with yesterday's work not
  yet marked overdue, until some unrelated interaction triggers a render.
- **Signing in must not upload the whole local list.** A merge-write of every local task
  resurrected anything deleted on another device while this one was closed. `app.js`
  records `todo-last-cloud-sync` and only uploads tasks changed after it.
- **Don't let the sync resurrect user checkoffs.** Completions record `completedBy`
  (`"user"` vs `"sync"`); the Canvas sync only re-opens its own. Plenty of schoolwork is
  finished without being submitted on Canvas.
- **Reset must delete tasks too.** Clearing only the dedupe memory re-imported everything
  on top of existing copies (21 tasks for 7 assignments). Every sync now also collapses
  duplicates sharing a `canvasId`.
- **All Google scopes must be minted in one authorization.** A refresh token carries only
  the scopes ticked when it was created, so re-authorizing for Calendar alone silently
  kills the Gmail sync. The full set is `gmail.readonly`, `calendar.readonly` and
  `calendar.app.created` — the last of which grants access *only* to calendars this app
  itself created, so it can never modify or delete anything on the real calendars.
- **The calendar sync must never read its own calendar.** Its own pushed events would be
  triaged straight back into tasks, which would be pushed back as events. `sync-calendar.js`
  skips `calId` when listing.
- **Watch Firestore's 50k free daily reads when adding anything to `send-reminders`.**
  It runs every minute, so a query returning 50 docs costs 72,000 reads/day on its own —
  over quota, after which reads fail and reminders stop dead. The advance-warning and
  snooze sweeps are therefore gated to every 5th minute (`SWEEP_EVERY_MIN`), which is
  free given their 1-hour window. Only the due-time check runs every minute.
- **Firestore sorts `null` before every number.** A bare `where("snoozedUntil", "<=", now)`
  matches every task that has never been snoozed. Pair it with `where(field, ">", 0)`.
- **Never build a timestamp with `new Date("YYYY-MM-DDTHH:MM")` on the server.** That
  resolves against the runtime's zone, and Vercel runs in UTC — a 3pm Pacific deadline
  was stored as 8am Pacific, so Gmail-created reminders fired seven hours early. Use
  `zonedToEpochMs()` from `lib/localtime.js`. The client may parse naively; it's already
  in Shaurya's zone.
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
  His actual Gmail labels (confirmed 2026-09-01, no dedicated "To Do" label exists):
  School, Scouts, Family, Volunteering, Jobs, Newsletters, Accounts, Promos. The
  actionable ones are School / Scouts / Volunteering — hence multi-label support.
  Google Cloud project `todo-gmail-507402`, OAuth client `todo-gmail-client`, redirect
  URI `https://developers.google.com/oauthplayground`, scope `gmail.readonly`.
  **The app is stuck in Testing status.** Its Audience page insists "OAuth configuration
  is incomplete — visit the Branding page" while Branding is demonstrably complete (Save
  greyed out, all required fields stored), and Data Access refuses to persist a scope.
  Publish app stays disabled. Not worth more time: Testing works, it just needs Shaurya
  listed as a test user, and the refresh token then expires every 7 days. `sync-gmail.js`
  detects that (`invalid_grant`) and returns an error saying to mint a new token rather
  than failing silently. Retry publishing later — it may just be a console bug.
- Discussed and ranked as next up (2026-09-02): Canvas `points_possible` driving priority
  so a 100-point essay outranks a 5-point warmup; Google Calendar read-only, cheap now the
  OAuth plumbing exists but needs re-authorizing for a wider scope; a weekly overdue triage
  pass; AI time estimates (held back — likely to be wrong often enough to lose trust).
- Deliberately not built (judged as clutter for now): search, subtasks, course grouping,
  tags beyond the 7 categories, streaks/gamification, light theme.
