import { firebaseConfig } from "./firebase-config.js";

const STORAGE_KEY = "todo-tasks-v1";

const taskInput = document.getElementById("taskInput");
const addForm = document.getElementById("addForm");
const taskList = document.getElementById("taskList");
const emptyState = document.getElementById("emptyState");
const filterBtns = document.querySelectorAll(".filter-btn");
const signinBtn = document.getElementById("signinBtn");
const signoutBtn = document.getElementById("signoutBtn");
const userChip = document.getElementById("userChip");
const userPhoto = document.getElementById("userPhoto");
const userName = document.getElementById("userName");
const syncStatus = document.getElementById("syncStatus");

let tasks = loadLocal();
let filter = "all";
let cloud = null; // set once Firebase is wired up and a user signs in

function loadLocal() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
}

function render() {
  const visible = tasks
    .filter((t) => (filter === "active" ? !t.done : filter === "done" ? t.done : true))
    .sort((a, b) => b.createdAt - a.createdAt);

  taskList.innerHTML = "";
  emptyState.hidden = visible.length > 0;
  emptyState.textContent = tasks.length === 0
    ? "Nothing here yet — add your first task above."
    : "Nothing to show for this filter.";

  for (const task of visible) {
    const li = document.createElement("li");
    li.className = "task-item" + (task.done ? " done" : "");

    const check = document.createElement("button");
    check.className = "task-check";
    check.setAttribute("aria-label", "Toggle complete");
    check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><path d="M4 12l6 6L20 6"/></svg>';
    check.onclick = () => toggleTask(task.id);

    const text = document.createElement("span");
    text.className = "task-text";
    text.textContent = task.text;

    const del = document.createElement("button");
    del.className = "task-delete";
    del.setAttribute("aria-label", "Delete task");
    del.textContent = "✕";
    del.onclick = () => deleteTask(task.id);

    li.append(check, text, del);
    taskList.appendChild(li);
  }
}

function upsertTask(task) {
  const i = tasks.findIndex((t) => t.id === task.id);
  if (i === -1) tasks.push(task);
  else tasks[i] = task;
}

function addTask(text) {
  const task = { id: uid(), text, done: false, createdAt: Date.now(), updatedAt: Date.now() };
  upsertTask(task);
  saveLocal();
  render();
  cloud?.push(task);
}

function toggleTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.done = !task.done;
  task.updatedAt = Date.now();
  saveLocal();
  render();
  cloud?.push(task);
}

function deleteTask(id) {
  tasks = tasks.filter((t) => t.id !== id);
  saveLocal();
  render();
  cloud?.remove(id);
}

addForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = taskInput.value.trim();
  if (!text) return;
  addTask(text);
  taskInput.value = "";
});

filterBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    filterBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    filter = btn.dataset.filter;
    render();
  });
});

render();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

if (firebaseConfig) {
  initCloudSync(firebaseConfig).catch((err) => {
    console.error("Cloud sync unavailable:", err);
    syncStatus.textContent = "Sync unavailable — working locally.";
  });
} else {
  signinBtn.hidden = true;
}

async function initCloudSync(config) {
  const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js");
  const {
    getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js");
  const {
    getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot,
  } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");

  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const provider = new GoogleAuthProvider();

  signinBtn.hidden = false;
  signinBtn.onclick = () => signInWithPopup(auth, provider).catch((err) => {
    console.error(err);
    syncStatus.textContent = "Sign-in failed. Try again.";
  });
  signoutBtn.onclick = () => signOut(auth);

  let unsubscribeSnapshot = null;

  onAuthStateChanged(auth, async (user) => {
    if (unsubscribeSnapshot) {
      unsubscribeSnapshot();
      unsubscribeSnapshot = null;
    }

    if (!user) {
      cloud = null;
      signinBtn.hidden = false;
      userChip.hidden = true;
      syncStatus.textContent = "";
      return;
    }

    signinBtn.hidden = true;
    userChip.hidden = false;
    userPhoto.src = user.photoURL || "";
    userName.textContent = user.displayName || user.email || "";
    syncStatus.textContent = "Syncing…";

    const tasksRef = collection(db, "users", user.uid, "tasks");

    // one-time merge: push any locally-created tasks up so nothing made offline is lost
    for (const task of tasks) {
      await setDoc(doc(tasksRef, task.id), task, { merge: true });
    }

    cloud = {
      push: (task) => setDoc(doc(tasksRef, task.id), task, { merge: true }).catch(() => {}),
      remove: (id) => deleteDoc(doc(tasksRef, id)).catch(() => {}),
    };

    unsubscribeSnapshot = onSnapshot(tasksRef, (snap) => {
      tasks = snap.docs.map((d) => d.data());
      saveLocal();
      render();
      syncStatus.textContent = "Synced";
    }, (err) => {
      console.error(err);
      syncStatus.textContent = "Sync error — working from local copy.";
    });
  });
}
