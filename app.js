const STORAGE_KEY = "todo-app-v1";
const DEFAULT_GROUP_ID = "ungrouped";

// ---------- State ----------

let state = load();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.groups) && Array.isArray(saved.tasks)) return saved;
  } catch (e) { /* fall through to a fresh state */ }
  return {
    groups: [{ id: DEFAULT_GROUP_ID, name: "Ungrouped" }],
    tasks: [],
  };
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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
    createdAt: new Date().toISOString(),
    doneAt: null,
  });
  commit();
}

function toggleTask(id) {
  const task = state.tasks.find(t => t.id === id);
  task.doneAt = task.doneAt ? null : new Date().toISOString();
  commit();
}

function deleteTask(id) {
  state.tasks = state.tasks.filter(t => t.id !== id);
  commit();
}

// Moves a task into a group, optionally placing it right before another task.
function moveTask(id, groupId, beforeId = null) {
  const index = state.tasks.findIndex(t => t.id === id);
  const [task] = state.tasks.splice(index, 1);
  task.groupId = groupId;
  const beforeIndex = beforeId ? state.tasks.findIndex(t => t.id === beforeId) : -1;
  if (beforeIndex === -1) state.tasks.push(task);
  else state.tasks.splice(beforeIndex, 0, task);
  commit();
}

function addGroup(name) {
  const group = { id: uid(), name };
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
  save();
  render();
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

render();
