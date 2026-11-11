const STORAGE_KEY = "todo-app-v1";
const SYNC_KEY = "todo-sync-v1";
const BASE_KEY = "todo-base-v1";
const DEFAULT_GROUP_ID = "ungrouped";
const EPOCH = new Date(0).toISOString();
const GROUP_DRAG = "application/x-todo-group";

// Bump when the saved data changes shape. A device running an older version
// of the app refuses to sync newer data instead of damaging it.
const DATA_VERSION = 4;

const PRIORITIES = ["No priority", "Low", "Medium", "High"];

// How a group orders its tasks.
const SORTS = {
  manual: "My order",
  newest: "Newest first",
  oldest: "Oldest first",
  "priority-high": "High priority first",
  "priority-low": "Low priority first",
};

const ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;

// Archived tasks stay in the task list, marked with archivedAt.
const isActive = t => !t.archivedAt;

// ---------- State ----------

let state = load();
let sync = loadSync();
let editCount = 0;

function freshState() {
  return {
    groups: [{ id: DEFAULT_GROUP_ID, name: "Ungrouped", createdAt: EPOCH, pos: 0, priority: 0, sort: "manual" }],
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

// Brings data saved by older versions up to date. Defaults must only depend
// on the item itself, so every device upgrades the same data the same way.
function upgrade(data) {
  delete data.app;
  delete data.version;
  delete data.deleted;
  data.groups.forEach((g, i) => {
    g.createdAt = g.createdAt || (g.id === DEFAULT_GROUP_ID ? EPOCH : new Date(i + 1).toISOString());
    if (typeof g.pos !== "number") g.pos = Date.parse(g.createdAt);
    g.priority = g.priority || 0;
    g.sort = g.sort || "manual";
    delete g.updatedAt;
  });
  data.tasks.forEach((t, i) => {
    if (typeof t.pos !== "number") t.pos = i;
    t.priority = t.priority || 0;
    delete t.updatedAt;
  });
  if (!data.groups.some(g => g.id === DEFAULT_GROUP_ID)) data.groups.unshift(freshState().groups[0]);
  return sortState(data);
}

// Groups and tasks are both kept in their chosen order.
function sortState(data) {
  const byPos = (a, b) => a.pos - b.pos || a.createdAt.localeCompare(b.createdAt);
  data.groups.sort(byPos);
  data.tasks.sort(byPos);
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

function nextPos(list) {
  return list.reduce((max, x) => Math.max(max, x.pos), 0) + 1;
}

// A position that sorts between two neighbours (either may be missing).
function between(before, after) {
  if (before && after) return (before.pos + after.pos) / 2;
  if (before) return before.pos + 1;
  if (after) return after.pos - 1;
  return 0;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ---------- Actions ----------

function addTask(text, groupId, priority) {
  state.tasks.push({
    id: uid(),
    text,
    groupId,
    pos: nextPos(state.tasks),
    createdAt: now(),
    doneAt: null,
    priority,
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
  task.pos = beforeIndex === -1 ? nextPos(state.tasks) : between(others[beforeIndex - 1], others[beforeIndex]);
  task.groupId = groupId;
  commit();
}

// Works for both tasks and groups.
function setPriority(item, priority) {
  item.priority = priority;
  commit();
}

function setSort(group, sort) {
  group.sort = sort;
  commit();
}

function groupNameOf(id) {
  return (state.groups.find(g => g.id === id) || { name: "Ungrouped" }).name;
}

// Remembers the group's name, so the archive still shows it if the group is renamed or deleted later.
function archive(task, at) {
  task.archivedAt = at;
  task.archivedGroup = groupNameOf(task.groupId);
}

function archiveDone() {
  state.tasks.filter(t => isActive(t) && t.doneAt).forEach(t => archive(t, now()));
  commit();
}

// Done tasks are archived 24 hours after they were checked. The archive time
// is that moment, so every device archives a task with the same time.
function autoArchive() {
  if (syncing) return;
  const due = state.tasks.filter(t => isActive(t) && t.doneAt && Date.now() - Date.parse(t.doneAt) >= ARCHIVE_AFTER_MS);
  if (!due.length) return;
  due.forEach(t => archive(t, new Date(Date.parse(t.doneAt) + ARCHIVE_AFTER_MS).toISOString()));
  commit();
}

// A restored task goes back to its group as not done (otherwise it would be archived again right away).
function restoreTask(id) {
  const task = state.tasks.find(t => t.id === id);
  delete task.archivedAt;
  delete task.archivedGroup;
  task.doneAt = null;
  if (!state.groups.some(g => g.id === task.groupId)) task.groupId = DEFAULT_GROUP_ID;
  commit();
}

function deleteArchived(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!confirm(`Delete "${task.text}" for good? This can't be undone.`)) return;
  deleteTask(id);
}

function addGroup(name) {
  const group = { id: uid(), name, createdAt: now(), pos: nextPos(state.groups), priority: 0, sort: "manual" };
  state.groups.push(group);
  commit();
  return group;
}

// Puts a group at a place in the list of the other groups (0 = top).
function placeGroup(id, index) {
  const group = state.groups.find(g => g.id === id);
  const others = state.groups.filter(g => g.id !== id);
  if (index < 0 || index > others.length) return;
  group.pos = between(others[index - 1], others[index]);
  commit();
}

function shiftGroup(id, step) {
  placeGroup(id, state.groups.findIndex(g => g.id === id) + step);
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
const priorityName = p => `${PRIORITIES[p] || "No priority"}${p ? " priority" : ""}`;

// What can change on a task or group, and how to describe it. Each part
// lists the fields it covers; `key` (optional) decides what counts as a change.
const KINDS = {
  groups: {
    label: g => `group "${g.name}"`,
    added: g => `New group "${g.name}"`,
    parts: [
      {
        fields: ["name"],
        describe: (before, after) => `Renamed group "${before.name}" to "${after.name}"`,
        show: g => `named "${g.name}"`,
      },
      {
        fields: ["pos"],
        describe: (before, after) => `Moved group "${after.name}"`,
        // Both devices reordering groups isn't worth asking about.
        minor: () => true,
      },
      {
        fields: ["priority"],
        describe: (before, after) => `Set group "${after.name}" to ${priorityName(after.priority)}`,
        show: g => priorityName(g.priority),
      },
      {
        fields: ["sort"],
        describe: (before, after) => `Sorted group "${after.name}": ${SORTS[after.sort] || after.sort}`,
        show: g => `sorted "${SORTS[g.sort] || g.sort}"`,
      },
    ],
  },
  tasks: {
    label: t => `"${t.text}"`,
    added: (t, groupName) => `New task "${t.text}" in ${groupName(t.groupId)}`,
    parts: [
      {
        fields: ["text"],
        describe: (before, after) => `Renamed "${before.text}" to "${after.text}"`,
        show: t => `"${t.text}"`,
      },
      {
        fields: ["groupId", "pos"],
        describe: (before, after, groupName) => before.groupId === after.groupId
          ? `Reordered "${after.text}"`
          : `Moved "${after.text}" to ${groupName(after.groupId)}`,
        show: (t, groupName) => `in ${groupName(t.groupId)}`,
        // Both devices reordering within the same group isn't worth asking about.
        minor: (a, b) => a.groupId === b.groupId,
      },
      {
        // Checked and archived are one part, so e.g. "unchecked here" vs
        // "archived there" is asked about instead of mixed together.
        fields: ["doneAt", "archivedAt", "archivedGroup"],
        key: t => [!!t.doneAt, !!t.archivedAt],
        describe: (before, after) => {
          if (after.archivedAt && !before.archivedAt) return `Archived "${after.text}"`;
          if (!after.archivedAt && before.archivedAt) return `Restored "${after.text}" from the archive`;
          return `${after.doneAt ? "Checked" : "Unchecked"} "${after.text}"`;
        },
        show: t => (t.archivedAt ? "archived" : t.doneAt ? "checked" : "not checked"),
      },
      {
        fields: ["priority"],
        describe: (before, after) => after.priority
          ? `Set "${after.text}" to ${priorityName(after.priority)}`
          : `Removed priority from "${after.text}"`,
        show: t => priorityName(t.priority),
      },
    ],
  },
};

// Known parts, plus one quiet part per field this version doesn't know about
// (added by a newer version), so those fields are merged instead of lost.
function partsFor(kind, ...items) {
  const known = KINDS[kind].parts;
  const knownFields = new Set(["id", "createdAt", ...known.flatMap(p => p.fields)]);
  const extra = [...new Set(items.filter(Boolean).flatMap(Object.keys))]
    .filter(f => !knownFields.has(f))
    .map(f => ({ fields: [f], quiet: true }));
  return [...known, ...extra];
}

const partKey = (part, x) => JSON.stringify(part.key ? part.key(x) : part.fields.map(f => x[f] ?? null));

function copyPart(part, from, to) {
  part.fields.forEach(f => {
    if (f in from) to[f] = clone(from[f]);
    else delete to[f];
  });
}

// Works out what a sync would do. Returns the changes coming to this device,
// the conflicts to decide on, and finish() to build the final data once decided.
function planSync(base, local, remote) {
  const incoming = [];
  const conflicts = [];
  const results = {};
  const groupName = id =>
    (remote.groups.find(g => g.id === id) || local.groups.find(g => g.id === id) || { name: "Ungrouped" }).name;

  for (const [kind, { label, added }] of Object.entries(KINDS)) {
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
      const parts = partsFor(kind, b, l, r);
      const changedSinceBase = x => !b || parts.some(p => partKey(p, x) !== partKey(p, b));

      if (l && r) {
        const item = clone(l);
        out.set(id, item);
        for (const part of parts) {
          if (partKey(part, l) === partKey(part, r)) continue;
          const localChanged = !b || partKey(part, l) !== partKey(part, b);
          const remoteChanged = !b || partKey(part, r) !== partKey(part, b);
          if (!localChanged) {
            copyPart(part, r, item);
            if (!part.quiet) incoming.push(part.describe(l, r, groupName));
          } else if (remoteChanged && !part.quiet && !(part.minor && part.minor(l, r))) {
            conflicts.push({
              title: label(l),
              mine: `This device: ${part.show(l, groupName)}`,
              theirs: `Other device: ${part.show(r, groupName)}`,
              useTheirs: () => copyPart(part, r, item),
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
    const raw = JSON.parse(fromBase64(file.content));
    if ((raw.version || 0) > DATA_VERSION) {
      throw new Error("Your tasks were saved by a newer version of this app. Close the app completely and open it again to update it, then sync.");
    }
    remote = upgrade(raw);
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
    content: toBase64(JSON.stringify({ app: "todo", version: DATA_VERSION, ...merged }, null, 2) + "\n"),
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
      hideNotice();
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

// ---------- Checking for changes from the other device ----------
//
// Only looks: downloads the file and counts what Sync would bring in.
// Nothing on this device changes until you press Sync.

const noticeEl = document.getElementById("notice");
const noticeText = document.getElementById("notice-text");
const noticeAction = document.getElementById("notice-action");
let noticeKey = null;
let dismissedKey = null;
let lastCheck = 0;

async function checkRemote(force = false) {
  if (!sync.repo || !sync.token || syncing || !navigator.onLine) return;
  if (!force && Date.now() - lastCheck < 30 * 1000) return;
  lastCheck = Date.now();
  try {
    const res = await github("GET");
    if (!res.ok || syncing) return;
    const file = await res.json();
    const raw = JSON.parse(fromBase64(file.content));
    if ((raw.version || 0) > DATA_VERSION) {
      showNotice(file.sha, "Your tasks were saved by a newer version of this app. Reload to update it.", "Reload", () => location.reload());
      return;
    }
    const plan = planSync(loadBase(), clone(state), upgrade(raw));
    const count = plan.incoming.length + plan.conflicts.length;
    if (!count) return hideNotice();
    showNotice(file.sha,
      `${count} ${count === 1 ? "change" : "changes"} from your other device ${count === 1 ? "is" : "are"} waiting.`,
      "Sync now", syncNow);
  } catch (e) {
    // Best effort: pressing Sync reports any real problem.
  }
}

function showNotice(key, text, actionLabel, action) {
  if (key === dismissedKey) return;
  noticeKey = key;
  noticeText.textContent = text;
  noticeAction.textContent = actionLabel;
  noticeAction.onclick = action;
  noticeEl.hidden = false;
}

function hideNotice() {
  noticeEl.hidden = true;
  noticeKey = null;
}

// Hidden until something newer arrives, or the app is opened again.
document.getElementById("notice-close").addEventListener("click", () => {
  dismissedKey = noticeKey;
  hideNotice();
});

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
const taskPrioritySelect = document.getElementById("task-priority");

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

function priorityOptions(selected) {
  return PRIORITIES.map((label, i) => el("option", { value: i, textContent: label, selected: i === selected }));
}

function prioritySelect(item) {
  const select = el("select", { className: `priority p${item.priority}`, title: "Priority" }, priorityOptions(item.priority));
  select.addEventListener("change", () => setPriority(item, Number(select.value)));
  return select;
}

const ARROWS = {
  top: "M6 4h12M12 20V9M7 13l5-5 5 5",
  up: "M12 19V5M7 10l5-5 5 5",
  down: "M12 5v14M7 14l5 5 5-5",
  bottom: "M6 20h12M12 4v11M7 11l5 5 5-5",
};

function arrowButton(name, title, disabled, onclick) {
  const button = el("button", { className: "icon-btn arrow-btn", title, disabled, onclick });
  button.setAttribute("aria-label", title);
  button.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${ARROWS[name]}"/></svg>`;
  return button;
}

const isGroupDrag = e => e.dataTransfer.types.includes(GROUP_DRAG);

function render() {
  const selected = taskGroupSelect.value || DEFAULT_GROUP_ID;
  taskGroupSelect.replaceChildren(...groupOptions(selected));
  if (!state.groups.some(g => g.id === selected)) taskGroupSelect.value = DEFAULT_GROUP_ID;

  groupsEl.replaceChildren(...state.groups.map(renderGroup));
  renderStats();
  renderToolbar();
  renderSync();
  if (archiveDialog.open) renderArchive();
}

// Tasks, Completed and Groups count what's on the board; Done Today also counts archived tasks.
function renderStats() {
  const today = new Date().toDateString();
  const active = state.tasks.filter(isActive);
  document.getElementById("stat-total").textContent = active.length;
  document.getElementById("stat-done").textContent = active.filter(t => t.doneAt).length;
  document.getElementById("stat-today").textContent =
    state.tasks.filter(t => t.doneAt && new Date(t.doneAt).toDateString() === today).length;
  document.getElementById("stat-groups").textContent = state.groups.length;
}

function renderToolbar() {
  const doneCount = state.tasks.filter(t => isActive(t) && t.doneAt).length;
  const archivedCount = state.tasks.length - state.tasks.filter(isActive).length;
  const archiveBtn = document.getElementById("archive-done-btn");
  archiveBtn.disabled = !doneCount;
  archiveBtn.textContent = doneCount ? `Archive done (${doneCount})` : "Archive done";
  document.getElementById("archive-count").textContent = archivedCount;
}

function sortTasks(tasks, sort) {
  const created = (a, b) => a.createdAt.localeCompare(b.createdAt);
  const compare = {
    newest: (a, b) => created(b, a),
    oldest: created,
    // Same priority keeps your own order.
    "priority-high": (a, b) => b.priority - a.priority || a.pos - b.pos,
    "priority-low": (a, b) => a.priority - b.priority || a.pos - b.pos,
  }[sort];
  return compare ? [...tasks].sort(compare) : tasks;
}

function sortSelect(group) {
  const select = el("select", { className: "sort-select" + (group.sort === "manual" ? "" : " active"), title: "Sort tasks" },
    Object.entries(SORTS).map(([value, label]) => el("option", { value, textContent: label, selected: value === group.sort })));
  select.addEventListener("change", () => setSort(group, select.value));
  return select;
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

function renderGroup(group, index) {
  const sorted = group.sort !== "manual";
  const tasks = sortTasks(state.tasks.filter(t => isActive(t) && t.groupId === group.id), group.sort);
  const doneCount = tasks.filter(t => t.doneAt).length;

  const first = index === 0;
  const last = index === state.groups.length - 1;
  const tools = el("div", { className: "group-tools" }, [
    prioritySelect(group),
    arrowButton("top", "Move group to the top", first, () => placeGroup(group.id, 0)),
    arrowButton("up", "Move group up", first, () => shiftGroup(group.id, -1)),
    arrowButton("down", "Move group down", last, () => shiftGroup(group.id, 1)),
    arrowButton("bottom", "Move group to the bottom", last, () => placeGroup(group.id, state.groups.length - 1)),
  ]);

  if (group.id !== DEFAULT_GROUP_ID) {
    tools.append(
      el("button", { className: "icon-btn", title: "Rename group", textContent: "✎", onclick: () => renameGroup(group.id) }),
      el("button", { className: "icon-btn danger", title: "Delete group", textContent: "✕", onclick: () => deleteGroup(group.id) }),
    );
  }

  const header = el("div", { className: "group-header", draggable: true, title: "Drag to reorder groups" }, [
    el("span", { className: "group-name", textContent: group.name }),
    sortSelect(group),
    el("span", { className: "group-count", textContent: `${doneCount}/${tasks.length}` }),
    tools,
  ]);

  const list = el("ul", { className: "tasks" },
    tasks.length ? tasks.map(t => renderTask(t, sorted)) : [el("li", { className: "empty", textContent: "No tasks — drag one here" })]
  );

  const section = el("section", { className: `group gp${group.priority}` }, [header, list]);

  header.addEventListener("dragstart", e => {
    e.dataTransfer.setData(GROUP_DRAG, group.id);
    e.dataTransfer.effectAllowed = "move";
    section.classList.add("dragging");
  });
  header.addEventListener("dragend", () => section.classList.remove("dragging"));

  const clearMarks = () => section.classList.remove("drop-target", "drop-above", "drop-below");
  const dropsBelow = e => {
    const box = section.getBoundingClientRect();
    return e.clientY > box.top + box.height / 2;
  };

  // A dragged group lands above or below this one; a dragged task lands at the end of it.
  section.addEventListener("dragover", e => {
    e.preventDefault();
    clearMarks();
    if (!isGroupDrag(e)) section.classList.add("drop-target");
    else section.classList.add(dropsBelow(e) ? "drop-below" : "drop-above");
  });
  section.addEventListener("dragleave", e => {
    if (!section.contains(e.relatedTarget)) clearMarks();
  });
  section.addEventListener("drop", e => {
    e.preventDefault();
    clearMarks();
    if (isGroupDrag(e)) {
      const id = e.dataTransfer.getData(GROUP_DRAG);
      if (id === group.id) return;
      const others = state.groups.filter(g => g.id !== id);
      placeGroup(id, others.findIndex(g => g.id === group.id) + (dropsBelow(e) ? 1 : 0));
      return;
    }
    const id = e.dataTransfer.getData("text/plain");
    const task = state.tasks.find(t => t.id === id);
    // In a sorted group the order is automatic, so only moving in from another group does anything.
    if (task && (task.groupId !== group.id || !sorted)) moveTask(id, group.id);
  });

  return section;
}

// In a sorted group, dropping a task on another task just moves it into the group.
function renderTask(task, sorted) {
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
    el("div", { className: "task-controls" }, [
      prioritySelect(task),
      groupSelect,
      el("button", { className: "icon-btn danger", title: "Delete task", textContent: "✕", onclick: () => deleteTask(task.id) }),
    ]),
  ]);

  li.addEventListener("dragstart", e => {
    e.stopPropagation();
    e.dataTransfer.setData("text/plain", task.id);
    li.classList.add("dragging");
  });
  li.addEventListener("dragend", () => li.classList.remove("dragging"));

  // Dropping a task on a task puts it right before it. Group drags are left to the group.
  li.addEventListener("dragover", e => {
    if (isGroupDrag(e) || sorted) return;
    e.preventDefault();
    e.stopPropagation();
    li.classList.add("drop-before");
  });
  li.addEventListener("dragleave", () => li.classList.remove("drop-before"));
  li.addEventListener("drop", e => {
    if (isGroupDrag(e) || sorted) return;
    e.preventDefault();
    e.stopPropagation();
    const id = e.dataTransfer.getData("text/plain");
    if (id && id !== task.id) moveTask(id, task.groupId, task.id);
    else render();
  });

  return li;
}

// ---------- Archive ----------

const archiveDialog = document.getElementById("archive");
const archiveSearch = document.getElementById("archive-search");

function renderArchive() {
  const query = archiveSearch.value.trim().toLowerCase();
  const archived = state.tasks
    .filter(t => !isActive(t))
    .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  const shown = archived.filter(t =>
    !query || t.text.toLowerCase().includes(query) || (t.archivedGroup || "").toLowerCase().includes(query));

  document.getElementById("archive-summary").textContent = query
    ? `${shown.length} of ${archived.length} archived tasks`
    : `${archived.length} archived task${archived.length === 1 ? "" : "s"}`;

  const emptyText = query
    ? "No archived tasks match."
    : "Nothing archived yet. Done tasks are archived automatically 24 hours after you check them.";

  document.getElementById("archive-list").replaceChildren(...(shown.length ? shown.map(renderArchived) : [
    el("li", { className: "empty", textContent: emptyText }),
  ]));
}

function renderArchived(task) {
  const tags = [el("span", { className: "tag", textContent: task.archivedGroup || groupNameOf(task.groupId) })];
  if (task.priority) tags.push(el("span", { className: `tag priority p${task.priority}`, textContent: PRIORITIES[task.priority] }));
  const dates = [`Created ${formatDate(task.createdAt)}`];
  if (task.doneAt) dates.push(`Done ${formatDate(task.doneAt)}`);
  dates.push(`Archived ${formatDate(task.archivedAt)}`);

  return el("li", { className: "archived-task" }, [
    el("div", { className: "archived-main" }, [
      el("div", { className: "task-text", textContent: task.text }),
      el("div", { className: "archived-tags" }, tags),
      el("div", { className: "task-dates", textContent: dates.join("  ·  ") }),
    ]),
    el("div", { className: "archived-actions" }, [
      el("button", { className: "secondary small", type: "button", textContent: "Restore", title: "Put it back in its group, not done", onclick: () => restoreTask(task.id) }),
      el("button", { className: "icon-btn danger", type: "button", textContent: "✕", title: "Delete for good", onclick: () => deleteArchived(task.id) }),
    ]),
  ]);
}

document.getElementById("archive-done-btn").addEventListener("click", archiveDone);
document.getElementById("archive-open-btn").addEventListener("click", () => {
  archiveSearch.value = "";
  renderArchive();
  archiveDialog.showModal();
});
document.getElementById("archive-close").addEventListener("click", () => archiveDialog.close());
archiveSearch.addEventListener("input", renderArchive);

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

taskPrioritySelect.replaceChildren(...priorityOptions(0));

document.getElementById("task-form").addEventListener("submit", e => {
  e.preventDefault();
  const input = document.getElementById("task-input");
  const text = input.value.trim();
  if (!text) return;
  addTask(text, taskGroupSelect.value, Number(taskPrioritySelect.value));
  input.value = "";
  taskPrioritySelect.value = "0";
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
autoArchive();
checkRemote(true);
// Keep archiving and checking for changes while the app stays open, and when it comes back to the screen.
setInterval(autoArchive, 60 * 1000);
setInterval(checkRemote, 5 * 60 * 1000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  autoArchive();
  checkRemote();
});
window.addEventListener("online", () => checkRemote(true));
