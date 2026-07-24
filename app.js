import { firebaseConfig } from "./firebase-config.js";
import { AI_ENDPOINT, PLAN_ENDPOINT } from "./ai-config.js";

const STORAGE_KEY = "todo-tasks-v1";

const CATEGORY_COLORS = {
  Work: "var(--cat-work)",
  Personal: "var(--cat-personal)",
  Shopping: "var(--cat-shopping)",
  Health: "var(--cat-health)",
  Urgent: "var(--cat-urgent)",
  Other: "var(--cat-other)",
};

const CATEGORY_KEYWORDS = {
  Urgent: ["urgent", "asap", "important", "overdue", "emergency", "now"],
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
    let msg = EMPTY_MSG[view];
    if (view === "today") {
      const next = nextUpcoming();
      if (next) msg = `Nothing due today.<br><span class="muted">Next up: <b>${escapeHtml(next.text)}</b> · ${formatDue(next.dueDate, next.dueTime)}</span>`;
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
  if (editingId === task.id) li.appendChild(renderEditor(task));
  return li;
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

  // AI-written description (only shown when there is one)
  let descRow = null;
  if (task.description) {
    descRow = document.createElement("div");
    descRow.className = "editor-row editor-desc-row";
    descRow.innerHTML =
      '<span class="editor-label">Details <span class="ai-tag">AI</span></span>' +
      `<p class="editor-desc">${escapeHtml(task.description)}</p>`;
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
  wrap.append(dateRow, timeRow, priRow, catRow);
  return wrap;
}

function offsetDate(days) {
  const d = new Date(todayStr() + "T00:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- mutations ----------
function persist(task) { saveLocal(); render(); cloud?.push(task); }

function addTask(text) {
  const task = {
    id: uid(), text, done: false,
    category: guessCategory(text), priority: "medium",
    dueDate: null, dueTime: null, description: "",
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
    task.updatedAt = Date.now();
    parsingIds.delete(id);
    persist(task);
  } catch {
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

// ---------- cloud sync ----------
if (firebaseConfig) {
  initCloudSync(firebaseConfig).catch((err) => {
    console.error("Cloud sync unavailable:", err);
    setStatus("Sync unavailable — working locally.", "err");
  });
} else {
  signinBtn.hidden = true;
}

function setStatus(msg, cls) {
  syncStatus.textContent = msg;
  syncStatus.className = "sync-status" + (cls ? " " + cls : "");
}

async function initCloudSync(config) {
  const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js");
  const { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } =
    await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js");
  const { getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot } =
    await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");

  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = getFirestore(app);
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
      cloud = null; signinBtn.hidden = false; userChip.hidden = true; setStatus("");
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

    unsub = onSnapshot(tasksRef, (snap) => {
      tasks = snap.docs.map((d) => d.data());
      saveLocal(); render(); setStatus("Synced", "ok");
    }, (err) => { console.error(err); setStatus("Sync error — using local copy.", "err"); });
  });
}
