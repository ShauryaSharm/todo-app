import { firebaseConfig } from "./firebase-config.js";
import { AI_ENDPOINT, PLAN_ENDPOINT } from "./ai-config.js";
import { VAPID_PUBLIC_KEY } from "./notify-config.js";

const STORAGE_KEY = "todo-tasks-v1";

const CATEGORY_COLORS = {
  Work: "var(--cat-work)",
  Homework: "var(--cat-homework)",
  Personal: "var(--cat-personal)",
  Shopping: "var(--cat-shopping)",
  Health: "var(--cat-health)",
  Urgent: "var(--cat-urgent)",
  Other: "var(--cat-other)",
};

const CATEGORY_KEYWORDS = {
  Urgent: ["urgent", "asap", "important", "overdue", "emergency", "now"],
  // Checked before Work so school terms win over generic words like "project".
  Homework: ["homework", "hw", "essay", "assignment", "study", "quiz", "test", "exam",
    "worksheet", "lab report", "chapter", "read pages", "flashcards", "review packet",
    "problem set", "due in class", "school", "class"],
  Work: ["meeting", "email", "report", "project", "client", "presentation", "deadline", "boss", "invoice", "work", "slides"],
  Shopping: ["buy", "purchase", "store", "grocery", "groceries", "milk", "shop", "order", "pick up"],
  Health: ["doctor", "dentist", "gym", "workout", "medicine", "prescription", "pharmacy", "appointment", "therapy", "exercise", "run"],
  Personal: ["mom", "dad", "family", "friend", "birthday", "clean", "laundry", "call", "text"],
};

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

// ---------- DOM ----------
const taskInput = document.getElementById("taskInput");
const addForm = document.getElementById("addForm");
const taskList = document.getElementById("taskList");
const emptyState = document.getElementById("emptyState");
const viewBtns = document.querySelectorAll(".view-btn");
const progress = document.getElementById("progress");
const progressFill = document.getElementById("progressFill");
const progressLabel = document.getElementById("progressLabel");
const planBtn = document.getElementById("planBtn");
const planNote = document.getElementById("planNote");
const clearDone = document.getElementById("clearDone");
const remindBtn = document.getElementById("remindBtn");
const signinBtn = document.getElementById("signinBtn");
const signoutBtn = document.getElementById("signoutBtn");
const userChip = document.getElementById("userChip");
const userPhoto = document.getElementById("userPhoto");
const syncStatus = document.getElementById("syncStatus");

// ---------- state ----------
let tasks = loadLocal();
let view = "today";
let editingId = null;
let cloud = null;
let pushStore = null;              // { saveSub(sub), removeSub(id) } — set when signed in
let planOrder = null;              // AI "plan my day" ordering (session only)
const parsingIds = new Set();      // tasks currently being parsed by AI
let renderLocked = false;          // true while a checkoff animation is mid-play

function loadLocal() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}
function saveLocal() { localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); }
function uid() { return crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- date helpers ----------
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function isOverdue(t) { return !t.done && t.dueDate && t.dueDate < todayStr(); }
function isToday(t) { return t.dueDate === todayStr(); }

function formatDue(dateStr, timeStr) {
  if (!dateStr) return "";
  const today = new Date(todayStr() + "T00:00:00");
  const due = new Date(dateStr + "T00:00:00");
  const diff = Math.round((due - today) / 86400000);
  let label;
  if (diff === 0) label = "Today";
  else if (diff === 1) label = "Tomorrow";
  else if (diff === -1) label = "Yesterday";
  else if (diff < -1) label = `${Math.abs(diff)}d ago`;
  else if (diff > 1 && diff < 7) label = due.toLocaleDateString(undefined, { weekday: "short" });
  else label = due.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (timeStr) label += " · " + formatTime(timeStr);
  return label;
}
function formatTime(t) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${ampm}` : `${h12}${ampm}`;
}

// ---------- category guess ----------
function guessCategory(text) {
  const lower = text.toLowerCase();
  for (const [category, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some((kw) => lower.includes(kw))) return category;
  }
  return "Other";
}

// ---------- sorting / filtering ----------
function comparator(a, b) {
  const ao = isOverdue(a), bo = isOverdue(b);
  if (ao !== bo) return ao ? -1 : 1;                    // overdue first
  const ad = a.dueDate || "9999-99-99", bd = b.dueDate || "9999-99-99";
  if (ad !== bd) return ad < bd ? -1 : 1;               // sooner due first
  const ap = PRIORITY_RANK[a.priority] ?? 1, bp = PRIORITY_RANK[b.priority] ?? 1;
  if (ap !== bp) return ap - bp;                        // higher priority first
  return b.createdAt - a.createdAt;                     // newest first
}

function visibleTasks() {
  const active = tasks.filter((t) => !t.done);
  if (view === "today") {
    const today = active.filter((t) => t.dueDate && t.dueDate <= todayStr());
    if (planOrder) {
      const rank = new Map(planOrder.map((id, i) => [id, i]));
      return today.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
    }
    return today.sort(comparator);
  }
  if (view === "upcoming")
    return active.filter((t) => t.dueDate && t.dueDate > todayStr()).sort(comparator);
  if (view === "done")
    return tasks.filter((t) => t.done).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  return active.sort(comparator); // "all"
}

const EMPTY_MSG = {
  today: "Nothing due today.<br><span class=\"muted\">Enjoy the calm, or check <b>All</b>.</span>",
  upcoming: "No upcoming tasks scheduled.",
  all: "All clear.<br><span class=\"muted\">Add your first task above.</span>",
  done: "Nothing completed yet.<br><span class=\"muted\">Check something off to see it here.</span>",
};

function updateCounts() {
  const active = tasks.filter((t) => !t.done);
  const todayActive = active.filter((t) => t.dueDate && t.dueDate <= todayStr());
  const overdueCount = active.filter(isOverdue).length;
  const counts = {
    today: todayActive.length,
    upcoming: active.filter((t) => t.dueDate && t.dueDate > todayStr()).length,
    calendar: active.filter((t) => t.dueDate).length,
    all: active.length,
    done: tasks.filter((t) => t.done).length,
  };
  viewBtns.forEach((btn) => {
    const badge = btn.querySelector(".count");
    const n = counts[btn.dataset.view];
    badge.hidden = !n;
    badge.textContent = n || "";
    badge.classList.toggle("has-overdue", btn.dataset.view === "today" && overdueCount > 0);
  });
}

function nextUpcoming() {
  return tasks
    .filter((t) => !t.done && t.dueDate && t.dueDate > todayStr())
    .sort(comparator)[0];
}

// ---------- render ----------
function render() {
  if (renderLocked) return; // a checkoff animation is mid-play; don't let a sync echo wipe it out

  viewBtns.forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  updateCounts();

  if (view === "calendar") {
    progress.hidden = true;
    planBtn.hidden = true;
    planNote.hidden = true;
    clearDone.hidden = true;
    renderCalendar();
    return;
  }

  const list = visibleTasks();
  taskList.innerHTML = "";
  clearDone.hidden = !(view === "done" && list.length > 0);

  // progress bar (Today view only)
  const todayTasks = tasks.filter((t) => t.dueDate && t.dueDate <= todayStr());
  const todayDone = todayTasks.filter((t) => t.done).length;
  if (view === "today" && todayTasks.length > 0) {
    progress.hidden = false;
    progressFill.style.width = `${Math.round((todayDone / todayTasks.length) * 100)}%`;
    progressLabel.textContent = `${todayDone}/${todayTasks.length} done`;
    const activeToday = todayTasks.filter((t) => !t.done).length;
    planBtn.hidden = !(PLAN_ENDPOINT && activeToday >= 2);
  } else {
    progress.hidden = true;
    planBtn.hidden = true;
  }

  // plan note only in today view
  planNote.hidden = !(view === "today" && planNote.textContent);

  emptyState.hidden = list.length > 0;
  if (list.length === 0) {
    emptyState.classList.remove("celebrate");
    let msg = EMPTY_MSG[view];
    if (view === "today") {
      if (todayTasks.length > 0 && todayDone === todayTasks.length) {
        // finished everything due today — reward the moment
        emptyState.classList.add("celebrate");
        msg = '<span class="celebrate-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l6 6L20 6"/></svg></span>'
          + 'All done for today.<br><span class="muted">Everything’s checked off — nice work.</span>';
      } else {
        const next = nextUpcoming();
        if (next) msg = `Nothing due today.<br><span class="muted">Next up: <b>${escapeHtml(next.text)}</b> · ${formatDue(next.dueDate, next.dueTime)}</span>`;
      }
    }
    emptyState.innerHTML = msg;
    return;
  }

  list.forEach((task, i) => {
    const li = renderTask(task);
    li.style.animationDelay = `${Math.min(i * 35, 350)}ms`;
    taskList.appendChild(li);
  });
}

function renderCalendar() {
  const items = tasks
    .filter((t) => !t.done && t.dueDate)
    .sort((a, b) => {
      if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
      return (a.dueTime || "99:99") < (b.dueTime || "99:99") ? -1 : 1;
    });

  taskList.innerHTML = "";
  emptyState.hidden = items.length > 0;
  if (items.length === 0) {
    emptyState.innerHTML = "Nothing scheduled.<br><span class=\"muted\">Add a task with a date to see it here.</span>";
    return;
  }

  const thisYear = new Date().getFullYear();
  let lastMonth = null, lastDate = null, i = 0;

  for (const task of items) {
    i++;
    const d = new Date(task.dueDate + "T00:00:00");
    const monthKey = `${d.getFullYear()}-${d.getMonth()}`;

    if (monthKey !== lastMonth) {
      const mh = document.createElement("li");
      mh.className = "cal-month";
      mh.textContent = d.toLocaleDateString(undefined, {
        month: "long",
        ...(d.getFullYear() !== thisYear ? { year: "numeric" } : {}),
      }).toUpperCase();
      taskList.appendChild(mh);
      lastMonth = monthKey;
      lastDate = null;
    }

    if (task.dueDate !== lastDate) {
      const dh = document.createElement("li");
      dh.className = "cal-day";
      if (task.dueDate < todayStr()) dh.classList.add("overdue");
      else if (task.dueDate === todayStr()) dh.classList.add("is-today");
      dh.innerHTML =
        `<span class="cal-daynum">${String(d.getDate()).padStart(2, "0")}</span>` +
        `<span class="cal-weekday">${d.toLocaleDateString(undefined, { weekday: "long" })}</span>`;
      taskList.appendChild(dh);
      lastDate = task.dueDate;
    }

    const li = renderTask(task);
    li.classList.add("cal");
    li.style.animationDelay = `${Math.min(i * 30, 350)}ms`;
    taskList.appendChild(li);
  }
}

function renderTask(task) {
  const li = document.createElement("li");
  li.className = "task-item" + (task.done ? " done" : "");
  li.style.setProperty("--cat-color", CATEGORY_COLORS[task.category] || CATEGORY_COLORS.Other);
  if (!task.done && task.priority === "high") li.classList.add("pri-high");
  if (isOverdue(task)) li.classList.add("overdue");
  if (parsingIds.has(task.id)) li.classList.add("parsing");

  // checkbox
  const check = document.createElement("button");
  check.className = "task-check";
  check.setAttribute("aria-label", "Toggle complete");
  check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l6 6L20 6"/></svg>';
  check.onclick = () => toggleTask(task.id, li);

  // body (text + meta)
  const body = document.createElement("div");
  body.className = "task-body";
  const text = document.createElement("div");
  text.className = "task-text";
  text.textContent = task.text;
  body.appendChild(text);

  const meta = document.createElement("div");
  meta.className = "task-meta";
  const dot = document.createElement("span");
  dot.className = "cat-dot";
  dot.style.background = CATEGORY_COLORS[task.category] || CATEGORY_COLORS.Other;
  dot.title = task.category || "Other";
  meta.appendChild(dot);
  if (task.dueDate) {
    const chip = document.createElement("span");
    chip.className = "chip" + (isOverdue(task) ? " due-overdue" : isToday(task) ? " due-today" : "");
    chip.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>' +
      `<span>${formatDue(task.dueDate, task.dueTime)}</span>`;
    meta.appendChild(chip);
  }
  if (task.repeat && REPEATS[task.repeat]) {
    const rep = document.createElement("span");
    rep.className = "chip";
    rep.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>' +
      `<span>${REPEATS[task.repeat]}</span>`;
    meta.appendChild(rep);
  }
  if (task.description) {
    const infoChip = document.createElement("span");
    infoChip.className = "chip chip-info";
    infoChip.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/></svg><span>Details</span>';
    meta.appendChild(infoChip);
  }
  body.appendChild(meta);
  body.onclick = () => { editingId = editingId === task.id ? null : task.id; render(); };

  // delete
  const del = document.createElement("button");
  del.className = "task-delete";
  del.setAttribute("aria-label", "Delete task");
  del.textContent = "✕";
  del.onclick = (e) => { e.stopPropagation(); deleteTask(task.id, li); };

  li.append(check, body, del);
  attachSwipe(li, task);
  if (editingId === task.id) li.appendChild(renderEditor(task));
  return li;
}

// Swipe right to complete, swipe left to delete. Hitting the small circle on a phone
// is the main daily friction; this makes the whole row the target.
const SWIPE_TRIGGER = 70;
function attachSwipe(li, task) {
  let startX = 0, startY = 0, dx = 0, active = false, decided = false;

  li.addEventListener("touchstart", (e) => {
    if (editingId === task.id) return;      // don't fight the open editor
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    dx = 0; active = true; decided = false;
    li.style.transition = "none";
  }, { passive: true });

  li.addEventListener("touchmove", (e) => {
    if (!active) return;
    const t = e.touches[0];
    const mx = t.clientX - startX, my = t.clientY - startY;
    // Only claim the gesture once it's clearly horizontal, so vertical scrolling
    // through a long list still works normally.
    if (!decided) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      if (Math.abs(my) > Math.abs(mx)) { active = false; return; }
      decided = true;
    }
    dx = mx;
    li.style.transform = `translateX(${dx}px)`;
    li.classList.toggle("swipe-complete", dx > SWIPE_TRIGGER);
    li.classList.toggle("swipe-delete", dx < -SWIPE_TRIGGER);
  }, { passive: true });

  const springBack = () => {
    li.style.transition = "transform 0.28s var(--ease)";
    li.style.transform = "";
    li.classList.remove("swipe-complete", "swipe-delete");
  };

  // Fly the card the rest of the way off in the direction it was thrown, then act.
  // Acting first (or snapping back to 0 first) made it look like it vanished instantly.
  const flyOut = (dir, after) => {
    const dist = (li.offsetWidth || 400) + 40;
    li.style.transition = "transform 0.22s ease-out, opacity 0.22s ease-out";
    li.style.transform = `translateX(${dir * dist}px)`;
    li.style.opacity = "0";
    // Pass no element to the action so it doesn't try to run its own exit animation
    // on top of this one.
    setTimeout(after, 200);
  };

  const end = () => {
    if (!active) return;
    active = false;
    const thrown = dx;
    dx = 0;
    if (thrown > SWIPE_TRIGGER && !task.done) flyOut(1, () => toggleTask(task.id, null));
    else if (thrown < -SWIPE_TRIGGER) flyOut(-1, () => deleteTask(task.id, null));
    else springBack();          // didn't reach the trigger — ease back into place
  };
  li.addEventListener("touchend", end, { passive: true });
  li.addEventListener("touchcancel", () => { active = false; dx = 0; springBack(); }, { passive: true });
}

function renderEditor(task) {
  const wrap = document.createElement("div");
  wrap.className = "task-editor";
  wrap.onclick = (e) => e.stopPropagation();

  // header with an explicit close button
  const head = document.createElement("div");
  head.className = "editor-head";
  head.innerHTML = '<span class="editor-label">Edit task</span>';
  const doneBtn = document.createElement("button");
  doneBtn.className = "editor-done";
  doneBtn.textContent = "Done";
  doneBtn.onclick = () => { editingId = null; render(); };
  head.appendChild(doneBtn);

  // editable title
  const titleRow = document.createElement("div");
  titleRow.className = "editor-row";
  titleRow.innerHTML = '<span class="editor-label">Task</span>';
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "title-input";
  titleInput.value = task.text;
  titleInput.maxLength = 200;
  // Update state live (no full re-render, so the field keeps focus); sync to cloud on blur.
  titleInput.oninput = () => {
    const v = titleInput.value;
    if (!v.trim()) return;
    task.text = v;
    task.updatedAt = Date.now();
    saveLocal();
    const te = titleInput.closest(".task-item")?.querySelector(".task-text");
    if (te) te.textContent = v;
  };
  titleInput.onblur = () => { titleInput.value = task.text; cloud?.push(task); };
  titleInput.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); titleInput.blur(); } };
  titleRow.appendChild(titleInput);

  // AI-written description (only shown when there is one). Canvas tasks carry their
  // assignment URL in here — pull it out so it becomes a real tappable button instead
  // of an unclickable wall of text.
  let descRow = null;
  const url = (task.description || "").match(/https?:\/\/\S+/);
  const prose = (task.description || "").replace(/https?:\/\/\S+/g, "").trim();
  if (prose || url) {
    descRow = document.createElement("div");
    descRow.className = "editor-row editor-desc-row";
    descRow.innerHTML = prose
      ? '<span class="editor-label">Details <span class="ai-tag">AI</span></span>' +
        `<p class="editor-desc">${escapeHtml(prose)}</p>`
      : "";
    if (url) {
      const a = document.createElement("a");
      a.className = "open-link";
      a.href = url[0];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.innerHTML = (task.canvasId ? "Open in Canvas" : "Open link") +
        ' <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14L21 3"/></svg>';
      descRow.appendChild(a);
    }
  }

  // due date row
  const dateRow = document.createElement("div");
  dateRow.className = "editor-row";
  dateRow.innerHTML = '<span class="editor-label">Due date</span>';
  const quick = [
    ["Today", todayStr()],
    ["Tomorrow", offsetDate(1)],
    ["Next week", offsetDate(7)],
    ["None", null],
  ];
  for (const [label, val] of quick) {
    const b = document.createElement("button");
    b.className = "mini-btn" + ((task.dueDate || null) === val ? " active" : "");
    b.textContent = label;
    b.onclick = () => { updateTask(task.id, { dueDate: val, dueTime: val ? task.dueTime : null }); };
    dateRow.appendChild(b);
  }
  const dateInput = document.createElement("input");
  dateInput.type = "date";
  if (task.dueDate) dateInput.value = task.dueDate;
  dateInput.onchange = () => updateTask(task.id, { dueDate: dateInput.value || null });
  dateRow.appendChild(dateInput);

  // time row — AI pre-fills this; you can set/adjust the exact time yourself
  const timeRow = document.createElement("div");
  timeRow.className = "editor-row";
  timeRow.innerHTML = '<span class="editor-label">Time</span>';
  const timeInput = document.createElement("input");
  timeInput.type = "time";
  if (task.dueTime) timeInput.value = task.dueTime;
  timeInput.onchange = () => {
    if (timeInput.value) updateTask(task.id, { dueTime: timeInput.value, dueDate: task.dueDate || todayStr() });
    else updateTask(task.id, { dueTime: null });
  };
  timeRow.appendChild(timeInput);
  const clearTime = document.createElement("button");
  clearTime.className = "mini-btn";
  clearTime.textContent = "Clear";
  clearTime.onclick = () => updateTask(task.id, { dueTime: null });
  timeRow.appendChild(clearTime);

  // priority row
  const priRow = document.createElement("div");
  priRow.className = "editor-row";
  priRow.innerHTML = '<span class="editor-label">Priority</span>';
  for (const p of ["high", "medium", "low"]) {
    const b = document.createElement("button");
    b.className = "mini-btn" + (task.priority === p ? " active" : "");
    b.textContent = p[0].toUpperCase() + p.slice(1);
    b.onclick = () => updateTask(task.id, { priority: p });
    priRow.appendChild(b);
  }

  // repeat row
  const repRow = document.createElement("div");
  repRow.className = "editor-row";
  repRow.innerHTML = '<span class="editor-label">Repeat</span>';
  for (const [val, label] of [["", "None"], ...Object.entries(REPEATS)]) {
    const b = document.createElement("button");
    b.className = "mini-btn" + ((task.repeat || "") === val ? " active" : "");
    b.textContent = label;
    b.onclick = () => updateTask(task.id, { repeat: val || null });
    repRow.appendChild(b);
  }

  // category row
  const catRow = document.createElement("div");
  catRow.className = "editor-row";
  catRow.innerHTML = '<span class="editor-label">Category</span>';
  for (const c of Object.keys(CATEGORY_COLORS)) {
    const b = document.createElement("button");
    b.className = "mini-btn" + (task.category === c ? " active" : "");
    b.textContent = c;
    b.onclick = () => updateTask(task.id, { category: c });
    catRow.appendChild(b);
  }

  wrap.append(head, titleRow);
  if (descRow) wrap.appendChild(descRow);
  wrap.append(dateRow, timeRow, priRow, repRow, catRow);
  return wrap;
}

function offsetDate(days) {
  const d = new Date(todayStr() + "T00:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- repeating tasks ----------
const REPEATS = { daily: "Daily", weekdays: "Weekdays", weekly: "Weekly", monthly: "Monthly" };

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nextOccurrence(dateStr, repeat) {
  if (!dateStr || !REPEATS[repeat]) return null;
  const d = new Date(dateStr + "T00:00:00");
  if (repeat === "daily") d.setDate(d.getDate() + 1);
  else if (repeat === "weekly") d.setDate(d.getDate() + 7);
  else if (repeat === "monthly") {
    // setMonth alone overflows: Jan 31 + 1 month becomes "Feb 31" -> Mar 3. Move to the
    // 1st first, then clamp to the last real day of the target month.
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  }
  else if (repeat === "weekdays") {
    do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  }
  return ymd(d);
}

// Completing a repeating task spawns the next one, leaving the finished copy in Done
// so history (and the streak of checking it off) is preserved.
function spawnNextOccurrence(task) {
  const next = nextOccurrence(task.dueDate, task.repeat);
  if (!next) return;
  const clone = {
    ...task,
    id: uid(),
    dueDate: next,
    done: false,
    completedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  delete clone.canvasId;          // a repeat is ours, not Canvas's
  delete clone.canvasCourse;
  applyRemind(clone);
  tasks.push(clone);
  saveLocal();
  cloud?.push(clone);
}

// ---------- reminders: derive an absolute timestamp from due date + time ----------
function applyRemind(task) {
  // A time with no date should still get a reminder — default silently to today rather
  // than dropping it, since a bare dueTime with no dueDate would otherwise never fire.
  if (task.dueTime && !task.dueDate) task.dueDate = todayStr();

  if (task.dueDate && task.dueTime) {
    const ts = new Date(`${task.dueDate}T${task.dueTime}:00`).getTime(); // local time
    task.remindAt = Number.isFinite(ts) ? ts : null;
  } else {
    task.remindAt = null;
  }
  task.notified = false; // re-arm whenever the schedule changes
}

// ---------- mutations ----------
function persist(task) { saveLocal(); render(); cloud?.push(task); }

function addTask(text) {
  const task = {
    id: uid(), text, done: false,
    category: guessCategory(text), priority: "medium",
    dueDate: null, dueTime: null, description: "", repeat: null,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  tasks.push(task);
  planOrder = null; planNote.textContent = "";   // a new task makes any AI plan stale
  persist(task);
  parseWithAI(task.id, text);
}

function updateTask(id, patch) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  Object.assign(task, patch, { updatedAt: Date.now() });
  if ("dueDate" in patch || "dueTime" in patch) applyRemind(task);
  persist(task);
}

function toggleTask(id, li) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  const becomingDone = !task.done;
  task.done = becomingDone;
  task.completedAt = becomingDone ? Date.now() : null;
  task.updatedAt = Date.now();
  saveLocal();

  if (becomingDone && navigator.vibrate) navigator.vibrate([14, 45, 18]); // little double-tap haptic
  if (becomingDone && task.repeat) spawnNextOccurrence(task);

  // Play the check animation on the real element before the list re-renders it away,
  // instead of the task just instantly vanishing. renderLocked holds off any render()
  // triggered by the cloud sync echo (Firestore's onSnapshot fires back almost
  // immediately after a write) so it can't wipe the animating element out mid-play.
  if (becomingDone && li && li.isConnected) {
    renderLocked = true;
    li.querySelector(".task-check").classList.add("pop");
    li.classList.add("done");
    cloud?.push(task);
    setTimeout(() => {
      li.classList.add("removing");
      setTimeout(() => { renderLocked = false; render(); }, 260);
    }, 420);
  } else {
    cloud?.push(task);
    render();
  }
}

function clearCompleted() {
  const done = tasks.filter((t) => t.done);
  if (done.length === 0) return;
  tasks = tasks.filter((t) => !t.done);
  saveLocal();
  render();
  done.forEach((t) => cloud?.remove(t.id));
}

function deleteTask(id, li) {
  if (li) {
    li.classList.add("removing");
    setTimeout(() => finishDelete(id), 260);
  } else finishDelete(id);
}
function finishDelete(id) {
  const removed = tasks.find((t) => t.id === id);
  tasks = tasks.filter((t) => t.id !== id);
  saveLocal(); render(); cloud?.remove(id);
  if (removed) showUndoToast(removed);
}

let toastTimer = null;
function showUndoToast(task) {
  hideToast(true);
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.id = "undoToast";
  toast.innerHTML = `<span>Deleted “${escapeHtml(task.text.slice(0, 30))}${task.text.length > 30 ? "…" : ""}”</span>`;
  const btn = document.createElement("button");
  btn.textContent = "Undo";
  btn.onclick = () => {
    tasks.push(task);
    saveLocal(); render(); cloud?.push(task);
    hideToast();
  };
  toast.appendChild(btn);
  document.body.appendChild(toast);
  toastTimer = setTimeout(() => hideToast(), 5000);
}
function hideToast(instant) {
  clearTimeout(toastTimer);
  const el = document.getElementById("undoToast");
  if (!el) return;
  if (instant) { el.remove(); return; }
  el.classList.add("hiding");
  setTimeout(() => el.remove(), 240);
}

async function parseWithAI(id, text) {
  if (!AI_ENDPOINT) return;
  parsingIds.add(id);
  render();
  try {
    const now = new Date();
    const res = await fetch(AI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text, today: todayStr(),
        weekday: now.toLocaleDateString(undefined, { weekday: "long" }),
      }),
    });
    if (!res.ok) return;
    const d = await res.json();
    if (d.error) return;
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    task.text = d.title || task.text;
    task.category = d.category || task.category;
    task.priority = d.priority || task.priority;
    task.dueDate = d.dueDate || task.dueDate;
    task.dueTime = d.dueTime || task.dueTime;
    if (typeof d.description === "string") task.description = d.description;
    if (d.repeat) {
      task.repeat = d.repeat;
      // A repeat needs a date to advance from; start it today if none was given.
      if (!task.dueDate) task.dueDate = todayStr();
    }
    applyRemind(task);
    task.updatedAt = Date.now();
    persist(task);
  } catch {
    /* keep the task exactly as typed */
  } finally {
    // Must always run: an early return (AI error, task deleted mid-flight) used to
    // leave the id in parsingIds, so the card shimmered as "thinking" forever and
    // looked like it never saved.
    parsingIds.delete(id);
    render();
  }
}

async function planMyDay() {
  if (!PLAN_ENDPOINT) return;
  const todayActive = tasks.filter((t) => !t.done && t.dueDate && t.dueDate <= todayStr());
  if (todayActive.length < 2) return;
  planBtn.classList.add("loading");
  try {
    const res = await fetch(PLAN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tasks: todayActive.map((t) => ({
          id: t.id, title: t.text, category: t.category, priority: t.priority, dueTime: t.dueTime,
        })),
      }),
    });
    const d = await res.json();
    if (d.error || !d.order) { setStatus("Couldn't plan right now.", "err"); return; }
    planOrder = d.order;
    planNote.textContent = d.note || "";
    render();
  } catch {
    setStatus("Couldn't plan right now.", "err");
  } finally {
    planBtn.classList.remove("loading");
  }
}

// ---------- events ----------
addForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = taskInput.value.trim();
  if (!text) return;
  addTask(text);
  taskInput.value = "";
  taskInput.focus(); // keep focus so you can rattle off several tasks in a row
});

// Escape closes an open editor, or drops focus out of the input
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (editingId) { editingId = null; render(); }
  else if (document.activeElement === taskInput) taskInput.blur();
});

// Click outside an open task card closes its editor
document.addEventListener("click", (e) => {
  if (editingId && !e.target.closest(".task-item")) { editingId = null; render(); }
});

viewBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.view === view) return;
    view = btn.dataset.view;
    editingId = null;
    btn.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    // quick crossfade instead of an instant content swap
    taskList.classList.add("switching");
    setTimeout(() => {
      render();
      taskList.classList.remove("switching");
    }, 110);
  });
});

planBtn.addEventListener("click", planMyDay);
clearDone.addEventListener("click", clearCompleted);

render();

// ---------- service worker ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

// ---------- push reminders ----------
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
function subId(endpoint) {
  // stable, Firestore-safe doc id from the subscription endpoint
  return "sub_" + btoa(endpoint).replace(/[^a-zA-Z0-9]/g, "").slice(-40);
}

async function updateRemindUI() {
  // only offer reminders when signed in (delivery is per-account) and supported
  if (!pushStore || !VAPID_PUBLIC_KEY || !pushSupported) { remindBtn.hidden = true; return; }
  remindBtn.hidden = false;
  let on = false;
  try {
    const reg = await navigator.serviceWorker.ready;
    on = Notification.permission === "granted" && !!(await reg.pushManager.getSubscription());
  } catch { on = false; }
  remindBtn.classList.toggle("on", on);
  remindBtn.title = on ? "Reminders on — tap to turn off" : "Enable reminders";
}

async function toggleReminders() {
  if (!pushStore) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();

    if (existing && Notification.permission === "granted") {
      // turn off
      try { await pushStore.removeSub(subId(existing.endpoint)); } catch {}
      await existing.unsubscribe().catch(() => {});
      setStatus("Reminders turned off.", "ok");
      updateRemindUI();
      return;
    }

    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      setStatus(`Notifications ${perm} — enable them in your device settings.`, "err");
      return;
    }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    // Firestore rejects any field that's literally `undefined` (Safari's toJSON()
    // sometimes includes expirationTime that way instead of omitting/nulling it).
    const raw = sub.toJSON();
    const json = {
      endpoint: raw.endpoint,
      expirationTime: raw.expirationTime ?? null,
      keys: { p256dh: raw.keys?.p256dh ?? "", auth: raw.keys?.auth ?? "" },
    };
    await pushStore.saveSub(subId(sub.endpoint), json);
    setStatus("Reminders enabled 🔔", "ok");
  } catch (err) {
    // Wraps the WHOLE flow, not just the subscribe step, so nothing fails silently —
    // whatever actually breaks (SW readiness, permission call, subscribe, Firestore
    // save) shows its real name+message right on screen.
    console.error(err);
    setStatus(`Reminder error: ${(err && err.name) || "Error"} — ${(err && err.message) || err}`, "err");
  }
  updateRemindUI();
}

remindBtn.addEventListener("click", toggleReminders);

// ---------- cloud sync ----------
if (firebaseConfig) {
  initCloudSync(firebaseConfig).catch((err) => {
    console.error("Cloud sync unavailable:", err);
    setStatus("Sync unavailable — working locally.", "err");
  });
} else {
  signinBtn.hidden = true;
}

let statusTimer = null;
function setStatus(msg, cls) {
  clearTimeout(statusTimer);
  syncStatus.textContent = msg;
  syncStatus.className = "sync-status" + (cls ? " " + cls : "");
  syncStatus.style.opacity = "1";
  // "Synced" is a transient confirmation — let it fade so it isn't permanent clutter.
  if (cls === "ok") statusTimer = setTimeout(() => { syncStatus.style.opacity = "0"; }, 2500);
}

async function initCloudSync(config) {
  const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js");
  const { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } =
    await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js");
  const {
    getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
    collection, doc, setDoc, deleteDoc, onSnapshot,
  } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
  const subDoc = (uid, id) => doc(collection(db, "users", uid, "pushSubs"), id);

  const app = initializeApp(config);
  const auth = getAuth(app);

  // Persist the cache to IndexedDB. Without it Firestore only queues offline writes in
  // memory, so a task added on flaky wifi is lost if the PWA is killed before it
  // reconnects — and the next cloud snapshot then overwrites the local copy too.
  let db;
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch {
    db = getFirestore(app);   // private browsing / unsupported storage — still works, just online-only
  }
  const provider = new GoogleAuthProvider();

  signinBtn.hidden = false;
  signinBtn.onclick = () => signInWithPopup(auth, provider).catch((err) => {
    console.error(err); setStatus("Sign-in failed. Try again.", "err");
  });
  signoutBtn.onclick = () => signOut(auth);

  let unsub = null;
  onAuthStateChanged(auth, async (user) => {
    if (unsub) { unsub(); unsub = null; }
    if (!user) {
      cloud = null; pushStore = null; signinBtn.hidden = false; userChip.hidden = true;
      setStatus(""); updateRemindUI();
      return;
    }
    signinBtn.hidden = true; userChip.hidden = false;
    userPhoto.src = user.photoURL || "";
    setStatus("Syncing…");

    const tasksRef = collection(db, "users", user.uid, "tasks");
    for (const task of tasks) await setDoc(doc(tasksRef, task.id), task, { merge: true });

    cloud = {
      push: (task) => setDoc(doc(tasksRef, task.id), task, { merge: true }).catch(() => {}),
      remove: (id) => deleteDoc(doc(tasksRef, id)).catch(() => {}),
    };
    pushStore = {
      saveSub: (id, sub) => setDoc(subDoc(user.uid, id), sub),
      removeSub: (id) => deleteDoc(subDoc(user.uid, id)),
    };
    updateRemindUI();

    unsub = onSnapshot(tasksRef, (snap) => {
      tasks = snap.docs.map((d) => d.data());
      saveLocal(); render(); setStatus("Synced", "ok");
    }, (err) => { console.error(err); setStatus("Sync error — using local copy.", "err"); });
  });
}
