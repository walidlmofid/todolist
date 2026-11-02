const STORAGE_KEY = "todo-app-v1";
const SYNC_KEY = "todo-sync-v1";
const BASE_KEY = "todo-base-v1";
const DEFAULT_GROUP_ID = "ungrouped";
const EPOCH = new Date(0).toISOString();

// ---------- State ----------

let state = load();
let sync = loadSync();
let editCount = 0;

function freshState() {
  return {
    groups: [{ id: DEFAULT_GROUP_ID, name: "Ungrouped", createdAt: EPOCH }],
    tasks: [],
  };
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.groups) && Array.isArray(saved.tasks)) return upgrade(saved);
  } catch (e) { /* fall through to a fresh state */ }
  return freshState();
}

// Brings data saved by older versions up to date.
function upgrade(data) {
  delete data.app;
  delete data.version;
  delete data.deleted;
  data.groups.forEach((g, i) => {
    g.createdAt = g.createdAt || (g.id === DEFAULT_GROUP_ID ? EPOCH : new Date(i + 1).toISOString());
    delete g.updatedAt;
  });
  data.tasks.forEach((t, i) => {
    if (typeof t.pos !== "number") t.pos = i;
    delete t.updatedAt;
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
  state.tasks.push({
    id: uid(),
    text,
    groupId,
    pos: nextPos(),
    createdAt: now(),
    doneAt: null,
  });
  commit();
}

function toggleTask(id) {
  const task = state.tasks.find(t => t.id === id);
  task.doneAt = task.doneAt ? null : now();
  commit();
}

function deleteTask(id) {
  state.tasks = state.tasks.filter(t => t.id !== id);
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
  commit();
}

function addGroup(name) {
  const group = { id: uid(), name, createdAt: now() };
  state.groups.push(group);
  commit();
  return group;
}

function renameGroup(id) {
  const group = state.groups.find(g => g.id === id);
  const name = prompt("Rename group:", group.name);
  if (name && name.trim()) {
    group.name = name.trim();
    commit();
  }
}

// Deleting a group keeps its tasks: they go back to "Ungrouped".
function deleteGroup(id) {
  const group = state.groups.find(g => g.id === id);
  if (!confirm(`Delete group "${group.name}"? Its tasks will be moved to Ungrouped.`)) return;
  state.tasks.forEach(t => { if (t.groupId === id) t.groupId = DEFAULT_GROUP_ID; });
  state.groups = state.groups.filter(g => g.id !== id);
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
//
// Syncing compares three versions: this device, GitHub, and the "base" (what
// GitHub had the last time this device synced). Anything changed on only one
// side is taken from that side. If both sides changed the same thing, you
// choose. Nothing on this device changes until you've reviewed it.

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

function loadBase() {
  try {
    const saved = JSON.parse(localStorage.getItem(BASE_KEY));
    return saved && saved.repo === sync.repo && saved.path === sync.path ? upgrade(saved.data) : null;
  } catch (e) {
    return null;
  }
}

function saveBase(data) {
  localStorage.setItem(BASE_KEY, JSON.stringify({ repo: sync.repo, path: sync.path, data }));
}

const clone = x => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What can change on a task or group, and how to describe it.
const KINDS = {
  groups: {
    label: g => `group "${g.name}"`,
    added: g => `New group "${g.name}"`,
    parts: [
      {
        key: g => g.name,
        copy: (from, to) => { to.name = from.name; },
        describe: (before, after) => `Renamed group "${before.name}" to "${after.name}"`,
        show: g => `named "${g.name}"`,
      },
    ],
  },
  tasks: {
    label: t => `"${t.text}"`,
    added: (t, groupName) => `New task "${t.text}" in ${groupName(t.groupId)}`,
    parts: [
      {
        key: t => t.text,
        copy: (from, to) => { to.text = from.text; },
        describe: (before, after) => `Renamed "${before.text}" to "${after.text}"`,
        show: t => `"${t.text}"`,
      },
      {
        key: t => [t.groupId, t.pos],
        copy: (from, to) => { to.groupId = from.groupId; to.pos = from.pos; },
        describe: (before, after, groupName) => before.groupId === after.groupId
          ? `Reordered "${after.text}"`
          : `Moved "${after.text}" to ${groupName(after.groupId)}`,
        show: (t, groupName) => `in ${groupName(t.groupId)}`,
        // Both devices reordering within the same group isn't worth asking about.
        minor: (a, b) => a.groupId === b.groupId,
      },
      {
        key: t => !!t.doneAt,
        copy: (from, to) => { to.doneAt = from.doneAt; },
        describe: (before, after) => `${after.doneAt ? "Checked" : "Unchecked"} "${after.text}"`,
        show: t => (t.doneAt ? "checked" : "not checked"),
      },
    ],
  },
};

// Works out what a sync would do. Returns the changes coming to this device,
// the conflicts to decide on, and finish() to build the final data once decided.
function planSync(base, local, remote) {
  const incoming = [];
  const conflicts = [];
  const results = {};
  const groupName = id =>
    (remote.groups.find(g => g.id === id) || local.groups.find(g => g.id === id) || { name: "Ungrouped" }).name;

  for (const [kind, { label, added, parts }] of Object.entries(KINDS)) {
    const index = list => new Map((list || []).map(x => [x.id, x]));
    const baseItems = index(base && base[kind]);
    const localItems = index(local[kind]);
    const remoteItems = index(remote[kind]);
    const out = new Map();
    results[kind] = out;

    for (const id of new Set([...localItems.keys(), ...remoteItems.keys()])) {
      const b = baseItems.get(id);
      const l = localItems.get(id);
      const r = remoteItems.get(id);
      const changedSinceBase = x => !b || parts.some(p => !same(p.key(x), p.key(b)));

      if (l && r) {
        const item = clone(l);
        out.set(id, item);
        for (const part of parts) {
          if (same(part.key(l), part.key(r))) continue;
          const localChanged = !b || !same(part.key(l), part.key(b));
          const remoteChanged = !b || !same(part.key(r), part.key(b));
          if (!localChanged) {
            part.copy(r, item);
            incoming.push(part.describe(l, r, groupName));
          } else if (remoteChanged && !(part.minor && part.minor(l, r))) {
            conflicts.push({
              title: label(l),
              mine: `This device: ${part.show(l, groupName)}`,
              theirs: `Other device: ${part.show(r, groupName)}`,
              useTheirs: () => part.copy(r, item),
            });
          }
        }
      } else if (l) {
        if (!b) {
          out.set(id, clone(l)); // new on this device
        } else if (changedSinceBase(l)) {
          out.set(id, clone(l));
          conflicts.push({
            title: `${label(l)} was deleted on your other device, but changed on this one`,
            mine: "Keep it",
            theirs: "Delete it",
            useTheirs: () => out.delete(id),
          });
        } else {
          incoming.push(`Deleted ${kind === "tasks" ? "task " : ""}${label(l)}`);
        }
      } else if (!b) {
        out.set(id, clone(r));
        incoming.push(added(r, groupName));
      } else if (changedSinceBase(r)) {
        conflicts.push({
          title: `${label(r)} was deleted on this device, but changed on your other device`,
          mine: "Keep it deleted",
          theirs: "Bring it back",
          useTheirs: () => out.set(id, clone(r)),
        });
      }
      // Otherwise it was deleted here and untouched there: it stays deleted.
    }
  }

  const finish = () => {
    const groups = [...results.groups.values()];
    if (!groups.some(g => g.id === DEFAULT_GROUP_ID)) groups.unshift(freshState().groups[0]);
    const groupIds = new Set(groups.map(g => g.id));
    const tasks = [...results.tasks.values()];
    tasks.forEach(t => { if (!groupIds.has(t.groupId)) t.groupId = DEFAULT_GROUP_ID; });
    return sortState({ groups, tasks });
  };

  return { incoming, conflicts, finish };
}

// Same data always gives the same text, so we can tell whether anything changed.
function canonical(data) {
  const byId = (a, b) => a.id.localeCompare(b.id);
  return JSON.stringify({ groups: [...data.groups].sort(byId), tasks: [...data.tasks].sort(byId) });
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

// One round: download, review, merge, upload. Returns "done", "cancelled",
// or "retry" if another device uploaded in between.
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

  let merged = clone(state);
  if (remote) {
    const plan = planSync(loadBase(), merged, remote);
    if (plan.incoming.length || plan.conflicts.length) {
      if (!(await reviewSync(plan))) return "cancelled";
    }
    merged = plan.finish();
    state = merged;
    save();
    render();
    // This device now includes everything GitHub had.
    saveBase(remote);
    if (canonical(merged) === canonical(remote)) return "done";
  }

  const device = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? "phone" : "computer";
  const put = await github("PUT", {
    message: `Sync from ${device}`,
    content: toBase64(JSON.stringify({ app: "todo", version: 2, ...merged }, null, 2) + "\n"),
    ...(sha && { sha }),
  });
  if (put.status === 409 || put.status === 422) return "retry";
  if (!put.ok) throw apiError(put);
  saveBase(merged);
  return "done";
}

let syncing = false;

async function syncNow() {
  if (!sync.repo || !sync.token) return openSettings();
  if (syncing) return;
  syncing = true;
  renderSync();
  const editsBefore = editCount;
  try {
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await syncOnce();
      if (result !== "retry") break;
    }
    if (result === "retry") throw new Error("The data changed on GitHub while syncing. Please try again.");
    if (result === "done") {
      sync.lastSync = now();
      sync.pending = editCount !== editsBefore;
      sync.error = null;
    }
  } catch (e) {
    sync.error = e.message;
    alert("Sync failed: " + e.message);
  } finally {
    syncing = false;
    saveSync();
    renderSync();
  }
}

// ---------- Sync review ----------

const reviewDialog = document.getElementById("review");

// Shows what the sync would change. Resolves true if you press Apply.
function reviewSync(plan) {
  document.getElementById("review-incoming").hidden = !plan.incoming.length;
  document.getElementById("review-list").replaceChildren(
    ...plan.incoming.map(text => el("li", { textContent: text }))
  );

  document.getElementById("review-conflicts").hidden = !plan.conflicts.length;
  document.getElementById("conflict-list").replaceChildren(...plan.conflicts.map((c, i) =>
    el("fieldset", { className: "conflict" }, [
      el("legend", { textContent: c.title }),
      el("label", {}, [el("input", { type: "radio", name: `conflict-${i}`, value: "mine", checked: true }), c.mine]),
      el("label", {}, [el("input", { type: "radio", name: `conflict-${i}`, value: "theirs" }), c.theirs]),
    ])
  ));

  return new Promise(resolve => {
    const finish = apply => {
      if (apply) {
        plan.conflicts.forEach((c, i) => {
          if (reviewDialog.querySelector(`input[name="conflict-${i}"]:checked`).value === "theirs") c.useTheirs();
        });
      }
      reviewDialog.close();
      resolve(apply);
    };
    document.getElementById("review-form").onsubmit = e => { e.preventDefault(); finish(true); };
    document.getElementById("review-cancel").onclick = () => finish(false);
    reviewDialog.oncancel = e => { e.preventDefault(); finish(false); };
    reviewDialog.showModal();
  });
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

// Saves the app's files so it can open without internet (not possible from a local file).
if ("serviceWorker" in navigator && window.isSecureContext && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register("sw.js");
}

render();
