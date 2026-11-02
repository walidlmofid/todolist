const STORAGE_KEY = "todo-app-v1";
const SYNC_KEY = "todo-sync-v1";
const DEFAULT_GROUP_ID = "ungrouped";
const EPOCH = new Date(0).toISOString();

// ---------- State ----------

let state = load();
let sync = loadSync();
let editCount = 0;

function freshState() {
  return {
    groups: [{ id: DEFAULT_GROUP_ID, name: "Ungrouped", createdAt: EPOCH, updatedAt: EPOCH }],
    tasks: [],
    deleted: {},
  };
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.groups) && Array.isArray(saved.tasks)) return upgrade(saved);
  } catch (e) { /* fall through to a fresh state */ }
  return freshState();
}

// Fills in the fields syncing relies on, so data saved by older versions keeps working.
function upgrade(data) {
  data.deleted = data.deleted || {};
  data.groups.forEach((g, i) => {
    g.createdAt = g.createdAt || (g.id === DEFAULT_GROUP_ID ? EPOCH : new Date(i + 1).toISOString());
    g.updatedAt = g.updatedAt || g.createdAt;
  });
  data.tasks.forEach((t, i) => {
    if (typeof t.pos !== "number") t.pos = i;
    t.updatedAt = t.updatedAt || t.doneAt || t.createdAt;
  });
  if (!data.groups.some(g => g.id === DEFAULT_GROUP_ID)) data.groups.unshift(freshState().groups[0]);
  return sortState(data);
}

// Groups: "Ungrouped" first, then oldest to newest. Tasks: by position.
function sortState(data) {
  data.groups.sort((a, b) =>
    (b.id === DEFAULT_GROUP_ID) - (a.id === DEFAULT_GROUP_ID) || a.createdAt.localeCompare(b.createdAt));
  data.tasks.sort((a, b) => a.pos - b.pos || a.createdAt.localeCompare(b.createdAt));
  return data;
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function now() {
  return new Date().toISOString();
}

function nextPos() {
  return state.tasks.reduce((max, t) => Math.max(max, t.pos), 0) + 1;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ---------- Actions ----------

function addTask(text, groupId) {
  const time = now();
  state.tasks.push({
    id: uid(),
    text,
    groupId,
    pos: nextPos(),
    createdAt: time,
    updatedAt: time,
    doneAt: null,
  });
  commit();
}

function toggleTask(id) {
  const task = state.tasks.find(t => t.id === id);
  task.doneAt = task.doneAt ? null : now();
  task.updatedAt = now();
  commit();
}

function deleteTask(id) {
  state.tasks = state.tasks.filter(t => t.id !== id);
  state.deleted[id] = now();
  commit();
}

// Moves a task into a group, optionally placing it right before another task.
function moveTask(id, groupId, beforeId = null) {
  const task = state.tasks.find(t => t.id === id);
  const others = state.tasks.filter(t => t.groupId === groupId && t.id !== id);
  const beforeIndex = others.findIndex(t => t.id === beforeId);
  if (beforeIndex === -1) {
    task.pos = nextPos();
  } else {
    const before = others[beforeIndex];
    const prev = others[beforeIndex - 1];
    task.pos = prev ? (prev.pos + before.pos) / 2 : before.pos - 1;
  }
  task.groupId = groupId;
  task.updatedAt = now();
  commit();
}

function addGroup(name) {
  const time = now();
  const group = { id: uid(), name, createdAt: time, updatedAt: time };
  state.groups.push(group);
  commit();
  return group;
}

function renameGroup(id) {
  const group = state.groups.find(g => g.id === id);
  const name = prompt("Rename group:", group.name);
  if (name && name.trim()) {
    group.name = name.trim();
    group.updatedAt = now();
    commit();
  }
}

// Deleting a group keeps its tasks: they go back to "Ungrouped".
function deleteGroup(id) {
  const group = state.groups.find(g => g.id === id);
  if (!confirm(`Delete group "${group.name}"? Its tasks will be moved to Ungrouped.`)) return;
  const time = now();
  state.tasks.forEach(t => {
    if (t.groupId === id) {
      t.groupId = DEFAULT_GROUP_ID;
      t.updatedAt = time;
    }
  });
  state.groups = state.groups.filter(g => g.id !== id);
  state.deleted[id] = time;
  commit();
}

function commit() {
  sortState(state);
  save();
  editCount++;
  sync.pending = true;
  saveSync();
  render();
}

// ---------- Sync (GitHub) ----------

function loadSync() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveSync() {
  localStorage.setItem(SYNC_KEY, JSON.stringify(sync));
}

// Combines two copies of the data: for each task or group the most recently
// changed version wins, and anything deleted after its last change stays deleted.
function merge(local, remote) {
  const deleted = { ...remote.deleted };
  for (const [id, at] of Object.entries(local.deleted)) {
    if (!deleted[id] || at > deleted[id]) deleted[id] = at;
  }

  const combine = (mine, theirs) => {
    const byId = new Map(theirs.map(x => [x.id, x]));
    for (const x of mine) {
      const other = byId.get(x.id);
      if (!other || x.updatedAt >= other.updatedAt) byId.set(x.id, x);
    }
    return [...byId.values()].filter(x => !(deleted[x.id] && deleted[x.id] >= x.updatedAt));
  };

  const groups = combine(local.groups, remote.groups);
  const groupIds = new Set(groups.map(g => g.id));
  const tasks = combine(local.tasks, remote.tasks);
  tasks.forEach(t => { if (!groupIds.has(t.groupId)) t.groupId = DEFAULT_GROUP_ID; });

  return sortState({ groups, tasks, deleted });
}

// Same data always gives the same text, so we can tell whether anything changed.
function canonical(data) {
  const byId = (a, b) => a.id.localeCompare(b.id);
  return JSON.stringify({
    groups: [...data.groups].sort(byId),
    tasks: [...data.tasks].sort(byId),
    deleted: Object.entries(data.deleted).sort(),
  });
}

function toBase64(text) {
  let binary = "";
  new TextEncoder().encode(text).forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
}

async function github(method, body) {
  const path = sync.path.split("/").map(encodeURIComponent).join("/");
  try {
    return await fetch(`https://api.github.com/repos/${sync.repo}/contents/${path}`, {
      method,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${sync.token}`,
        Accept: "application/vnd.github+json",
        ...(body && { "Content-Type": "application/json" }),
      },
      body: body && JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("Couldn't reach GitHub. Check your internet connection.");
  }
}

function apiError(res) {
  const messages = {
    401: "The access key was rejected. It may be mistyped or expired.",
    403: "The access key isn't allowed to write to this repository. It needs \"Contents: Read and write\".",
    404: "Repository not found, or the access key doesn't have access to it.",
  };
  return new Error(messages[res.status] || `GitHub returned an error (${res.status}).`);
}

// One round: download, merge, upload. Returns false if someone else
// uploaded in between, so the caller can try again.
async function syncOnce() {
  const res = await github("GET");
  let remote = null;
  let sha;
  if (res.ok) {
    const file = await res.json();
    sha = file.sha;
    remote = upgrade(JSON.parse(fromBase64(file.content)));
  } else if (res.status !== 404) {
    throw apiError(res);
  }

  state = merge(state, remote || freshState());
  save();
  render();

  if (remote && canonical(state) === canonical(remote)) return true;

  const device = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? "phone" : "computer";
  const put = await github("PUT", {
    message: `Sync from ${device}`,
    content: toBase64(JSON.stringify({ app: "todo", version: 1, ...state }, null, 2) + "\n"),
    ...(sha && { sha }),
  });
  if (put.status === 409 || put.status === 422) return false;
  if (!put.ok) throw apiError(put);
  return true;
}

let syncing = false;

async function syncNow() {
  if (!sync.repo || !sync.token) return openSettings();
  if (syncing) return;
  syncing = true;
  renderSync();
  const editsBefore = editCount;
  try {
    let done = false;
    for (let attempt = 0; attempt < 3 && !done; attempt++) done = await syncOnce();
    if (!done) throw new Error("The data changed on GitHub while syncing. Please try again.");
    sync.lastSync = now();
    sync.pending = editCount !== editsBefore;
    sync.error = null;
  } catch (e) {
    sync.error = e.message;
    alert("Sync failed: " + e.message);
  } finally {
    syncing = false;
    saveSync();
    renderSync();
  }
}

// ---------- Rendering ----------

const groupsEl = document.getElementById("groups");
const taskGroupSelect = document.getElementById("task-group");

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function groupOptions(selectedId) {
  return state.groups.map(g =>
    el("option", { value: g.id, textContent: g.name, selected: g.id === selectedId })
  );
}

function render() {
  const selected = taskGroupSelect.value || DEFAULT_GROUP_ID;
  taskGroupSelect.replaceChildren(...groupOptions(selected));
  if (!state.groups.some(g => g.id === selected)) taskGroupSelect.value = DEFAULT_GROUP_ID;

  groupsEl.replaceChildren(...state.groups.map(renderGroup));
  renderStats();
  renderSync();
}

function renderStats() {
  const today = new Date().toDateString();
  const done = state.tasks.filter(t => t.doneAt);
  document.getElementById("stat-total").textContent = state.tasks.length;
  document.getElementById("stat-done").textContent = done.length;
  document.getElementById("stat-today").textContent =
    done.filter(t => new Date(t.doneAt).toDateString() === today).length;
  document.getElementById("stat-groups").textContent = state.groups.length;
}

function renderSync() {
  const button = document.getElementById("sync-btn");
  const status = document.getElementById("sync-status");
  const unsynced = sync.pending || (!sync.lastSync && state.tasks.length > 0);

  button.disabled = syncing;
  button.classList.toggle("pending", unsynced && !syncing);
  button.title = unsynced ? "You have changes that aren't synced yet" : "Sync with GitHub";

  if (syncing) {
    status.textContent = "Syncing…";
  } else if (sync.error) {
    status.textContent = "Sync failed";
  } else if (sync.lastSync) {
    const last = new Date(sync.lastSync);
    const sameDay = last.toDateString() === new Date().toDateString();
    status.textContent = "Synced " + (sameDay
      ? last.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : last.toLocaleDateString(undefined, { day: "numeric", month: "short" }));
  } else {
    status.textContent = "Not synced";
  }
}

function renderGroup(group) {
  const tasks = state.tasks.filter(t => t.groupId === group.id);
  const doneCount = tasks.filter(t => t.doneAt).length;

  const header = el("div", { className: "group-header" }, [
    el("span", { className: "group-name", textContent: group.name }),
    el("span", { className: "group-count", textContent: `${doneCount}/${tasks.length}` }),
  ]);

  if (group.id !== DEFAULT_GROUP_ID) {
    header.append(
      el("button", { className: "icon-btn", title: "Rename group", textContent: "✎", onclick: () => renameGroup(group.id) }),
      el("button", { className: "icon-btn danger", title: "Delete group", textContent: "✕", onclick: () => deleteGroup(group.id) }),
    );
  }

  const list = el("ul", { className: "tasks" },
    tasks.length ? tasks.map(renderTask) : [el("li", { className: "empty", textContent: "No tasks — drag one here" })]
  );

  const section = el("section", { className: "group" }, [header, list]);

  // Dropping on the group (not on a specific task) puts the task at the end.
  section.addEventListener("dragover", e => {
    e.preventDefault();
    section.classList.add("drop-target");
  });
  section.addEventListener("dragleave", e => {
    if (!section.contains(e.relatedTarget)) section.classList.remove("drop-target");
  });
  section.addEventListener("drop", e => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain");
    if (id) moveTask(id, group.id);
  });

  return section;
}

function renderTask(task) {
  const dates = [`Created ${formatDate(task.createdAt)}`];
  if (task.doneAt) dates.push(`Done ${formatDate(task.doneAt)}`);

  const groupSelect = el("select", { title: "Move to group" }, groupOptions(task.groupId));
  groupSelect.addEventListener("change", () => moveTask(task.id, groupSelect.value));

  const li = el("li", { className: "task" + (task.doneAt ? " done" : ""), draggable: true }, [
    el("input", { type: "checkbox", checked: !!task.doneAt, onchange: () => toggleTask(task.id) }),
    el("div", { className: "task-body" }, [
      el("div", { className: "task-text", textContent: task.text }),
      el("div", { className: "task-dates", textContent: dates.join("  ·  ") }),
    ]),
    groupSelect,
    el("button", { className: "icon-btn danger", title: "Delete task", textContent: "✕", onclick: () => deleteTask(task.id) }),
  ]);

  li.addEventListener("dragstart", e => {
    e.dataTransfer.setData("text/plain", task.id);
    li.classList.add("dragging");
  });
  li.addEventListener("dragend", () => li.classList.remove("dragging"));

  // Dropping on a task puts the dragged task right before it.
  li.addEventListener("dragover", e => {
    e.preventDefault();
    li.classList.add("drop-before");
  });
  li.addEventListener("dragleave", () => li.classList.remove("drop-before"));
  li.addEventListener("drop", e => {
    e.preventDefault();
    e.stopPropagation();
    const id = e.dataTransfer.getData("text/plain");
    if (id && id !== task.id) moveTask(id, task.groupId, task.id);
    else render();
  });

  return li;
}

// ---------- Settings ----------

const settingsDialog = document.getElementById("settings");
const repoInput = document.getElementById("set-repo");
const pathInput = document.getElementById("set-path");
const tokenInput = document.getElementById("set-token");

function openSettings() {
  repoInput.value = sync.repo || "";
  pathInput.value = sync.path || "tasks.json";
  tokenInput.value = "";
  tokenInput.placeholder = sync.token ? "Saved — leave empty to keep it" : "github_pat_…";
  tokenInput.required = !sync.token;
  settingsDialog.showModal();
}

document.getElementById("settings-form").addEventListener("submit", e => {
  e.preventDefault();
  // Accepts "owner/name" or a full GitHub link to the repository.
  const repo = repoInput.value.trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    alert('Repository should look like "yourname/todolist-data".');
    return;
  }
  sync.repo = repo;
  sync.path = pathInput.value.trim() || "tasks.json";
  if (tokenInput.value.trim()) sync.token = tokenInput.value.trim();
  sync.error = null;
  saveSync();
  settingsDialog.close();
  syncNow();
});

document.getElementById("set-cancel").addEventListener("click", () => settingsDialog.close());

document.getElementById("set-forget").addEventListener("click", () => {
  if (!confirm("Remove the access key from this device?")) return;
  delete sync.token;
  saveSync();
  settingsDialog.close();
  renderSync();
});

document.getElementById("sync-btn").addEventListener("click", syncNow);
document.getElementById("settings-btn").addEventListener("click", openSettings);

// ---------- Forms ----------

document.getElementById("task-form").addEventListener("submit", e => {
  e.preventDefault();
  const input = document.getElementById("task-input");
  const text = input.value.trim();
  if (!text) return;
  addTask(text, taskGroupSelect.value);
  input.value = "";
  input.focus();
});

document.getElementById("group-form").addEventListener("submit", e => {
  e.preventDefault();
  const input = document.getElementById("group-input");
  const name = input.value.trim();
  if (!name) return;
  const group = addGroup(name);
  taskGroupSelect.value = group.id;
  input.value = "";
});

document.getElementById("today").textContent = new Date().toLocaleDateString(undefined, {
  weekday: "long", day: "numeric", month: "long",
});

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js");
}

render();
