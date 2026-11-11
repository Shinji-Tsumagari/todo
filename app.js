"use strict";

const STORAGE_KEY = "todo-app.tasks.v1";
const TOAST_MS = 6000;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const FILTERS = {
  all: () => true,
  active: (task) => !task.done,
  done: (task) => task.done,
};

const EMPTY_MESSAGES = {
  all: "タスクはまだありません。上の欄から追加できます。",
  active: "未完了のタスクはありません。",
  done: "完了したタスクはまだありません。",
};

const byId = (id) => document.getElementById(id);

const els = {
  today: byId("today"),
  progressBar: byId("progress-bar"),
  progressText: byId("progress-text"),
  addForm: byId("add-form"),
  addTitle: byId("add-title"),
  addDue: byId("add-due"),
  filters: byId("filters"),
  list: byId("list"),
  empty: byId("empty"),
  remaining: byId("remaining"),
  clearDone: byId("clear-done"),
  toastCard: byId("toast-card"),
  toastMessage: byId("toast-message"),
  toastUndo: byId("toast-undo"),
  template: byId("task-template"),
};

let tasks = loadTasks();
let filter = "all";
let toastTimer = null;
let toastUndoHandler = null;

// タスクID → 行要素。再描画で行を作り直さず、フォーカスと編集中の入力を保つ。
const rows = new Map();

// ---- 保存 ----

function isTask(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.done === "boolean" &&
    typeof value.createdAt === "number" &&
    (value.due === null || (typeof value.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.due)))
  );
}

function loadTasks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(parsed) ? parsed.filter(isTask) : [];
  } catch {
    return [];
  }
}

function saveTasks() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    showToast("保存できませんでした。ブラウザの保存領域を確認してください。");
  }
}

function commit() {
  saveTasks();
  render();
}

// ---- 日付 ----
// toISOString() はUTC基準で、日本時間の午前9時前だと前日になるためローカル時刻から組み立てる。

function localISODate(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function toUTC(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function formatDate(iso, today) {
  const [year, month, day] = iso.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(toUTC(iso)).getUTCDay()];
  const yearPrefix = iso.slice(0, 4) === today.slice(0, 4) ? "" : `${year}年`;
  return `${yearPrefix}${month}月${day}日（${weekday}）`;
}

function describeDue(task, today) {
  const days = (toUTC(task.due) - toUTC(today)) / 86400000;
  if (days === 0) return { text: "今日まで", tone: task.done ? "" : "today" };
  if (days === 1) return { text: "明日まで", tone: "" };
  if (days < 0 && !task.done) {
    return { text: `${formatDate(task.due, today)}・${-days}日超過`, tone: "overdue" };
  }
  return { text: formatDate(task.due, today), tone: "" };
}

// ---- 並び順: 未完了 → 期限が近い順 → 期限なし（同じ条件なら新しい順） ----

function compareTasks(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  if (a.due !== b.due) {
    if (a.due === null) return 1;
    if (b.due === null) return -1;
    return a.due < b.due ? -1 : 1;
  }
  return b.createdAt - a.createdAt;
}

// ---- 描画 ----

function createRow(id) {
  const row = els.template.content.firstElementChild.cloneNode(true);
  row.dataset.id = id;
  rows.set(id, row);
  return row;
}

// 編集フォームには触らない。別タブの更新で再描画されても入力中の内容が消えないようにするため。
function updateRow(row, task, today) {
  row.classList.toggle("is-done", task.done);
  row.querySelector(".task-title").textContent = task.title;

  const checkbox = row.querySelector(".task-check input");
  checkbox.checked = task.done;
  checkbox.setAttribute("aria-label", `「${task.title}」を完了にする`);
  row.querySelector('[data-action="edit"]').setAttribute("aria-label", `「${task.title}」を編集`);
  row.querySelector('[data-action="delete"]').setAttribute("aria-label", `「${task.title}」を削除`);

  const due = row.querySelector(".task-due");
  due.hidden = task.due === null;
  if (task.due !== null) {
    const { text, tone } = describeDue(task, today);
    due.textContent = text;
    due.dataset.tone = tone;
  }
}

function activeFilterButton() {
  return els.filters.querySelector('[aria-pressed="true"]');
}

function renderList(today) {
  const visible = tasks.filter(FILTERS[filter]).sort(compareTasks);
  const visibleIds = new Set(visible.map((task) => task.id));

  const active = document.activeElement;
  const focusedRow = active?.closest(".task") ?? null;
  const nextFocusRow = focusedRow?.nextElementSibling ?? focusedRow?.previousElementSibling ?? null;

  for (const [id, row] of rows) {
    if (!visibleIds.has(id)) {
      row.remove();
      rows.delete(id);
    }
  }

  visible.forEach((task, index) => {
    const row = rows.get(task.id) ?? createRow(task.id);
    updateRow(row, task, today);
    const current = els.list.children[index] ?? null;
    if (current !== row) els.list.insertBefore(row, current);
  });

  // 行の移動や削除で失われたフォーカスを復元する。
  if (focusedRow && !focusedRow.isConnected) {
    const target = nextFocusRow?.isConnected
      ? nextFocusRow.querySelector(".task-check input")
      : activeFilterButton();
    target.focus({ preventScroll: true });
  } else if (active?.isConnected && document.activeElement !== active) {
    active.focus({ preventScroll: true });
  }

  els.empty.hidden = visible.length > 0;
  els.empty.textContent = EMPTY_MESSAGES[filter];
}

function render() {
  const today = localISODate();
  const total = tasks.length;
  const doneCount = tasks.filter(FILTERS.done).length;
  const activeCount = total - doneCount;

  els.today.textContent = formatDate(today, today);
  els.progressBar.style.transform = `scaleX(${total === 0 ? 0 : doneCount / total})`;
  els.progressText.textContent = total === 0 ? "0件" : `${total}件中 ${doneCount}件完了`;

  els.filters.querySelectorAll("[data-filter]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
  });
  els.filters.querySelector('[data-count="all"]').textContent = total;
  els.filters.querySelector('[data-count="active"]').textContent = activeCount;
  els.filters.querySelector('[data-count="done"]').textContent = doneCount;

  renderList(today);

  els.remaining.textContent = activeCount === 0 ? "" : `残り ${activeCount}件`;
  els.clearDone.hidden = doneCount === 0;
}

// ---- トースト ----

function startToastTimer() {
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, TOAST_MS);
}

function showToast(message, undo = null) {
  toastUndoHandler = undo;
  els.toastCard.hidden = false;
  els.toastMessage.textContent = message;
  els.toastUndo.hidden = undo === null;
  startToastTimer();
}

function hideToast() {
  clearTimeout(toastTimer);
  toastUndoHandler = null;
  els.toastCard.hidden = true;
  els.toastMessage.textContent = "";
}

// ---- 操作 ----

function findTask(id) {
  return tasks.find((task) => task.id === id);
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function addTask(title, due) {
  tasks.push({ id: createId(), title, done: false, due, createdAt: Date.now() });
  // 「完了」表示のままだと追加したタスクが見えないため、表示を切り替える。
  if (filter === "done") filter = "all";
  commit();
}

function updateTask(id, changes) {
  const task = findTask(id);
  if (!task) return;
  Object.assign(task, changes);
  commit();
}

function removeTasks(ids, message) {
  const removed = tasks.filter((task) => ids.has(task.id));
  tasks = tasks.filter((task) => !ids.has(task.id));
  commit();
  showToast(message, () => {
    tasks.push(...removed);
    commit();
    const target = rows.get(removed[0].id)?.querySelector(".task-check input") ?? activeFilterButton();
    target.focus({ preventScroll: true });
  });
}

function startEdit(row) {
  const task = findTask(row.dataset.id);
  if (!task) return;
  const title = row.querySelector(".task-edit-title");
  row.querySelector(".task-view").hidden = true;
  row.querySelector(".task-edit").hidden = false;
  title.value = task.title;
  row.querySelector(".task-edit-due").value = task.due ?? "";
  title.focus();
  title.select();
}

function stopEdit(row) {
  row.querySelector(".task-edit").hidden = true;
  row.querySelector(".task-view").hidden = false;
  row.querySelector('[data-action="edit"]').focus({ preventScroll: true });
}

// ---- イベント ----

// 送信は <form> の標準動作に任せる。IMEの変換確定のEnterでは submit が発生しない。
els.addForm.addEventListener("submit", (event) => {
  event.preventDefault();
  addTask(els.addTitle.value.trim(), els.addDue.value || null);
  els.addForm.reset();
  els.addTitle.focus();
});

els.filters.addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  filter = button.dataset.filter;
  render();
});

els.list.addEventListener("change", (event) => {
  if (!event.target.matches(".task-check input")) return;
  updateTask(event.target.closest(".task").dataset.id, { done: event.target.checked });
});

els.list.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  const row = event.target.closest(".task");
  if (action === "edit") startEdit(row);
  if (action === "cancel") stopEdit(row);
  if (action === "delete") removeTasks(new Set([row.dataset.id]), "タスクを削除しました");
});

els.list.addEventListener("dblclick", (event) => {
  if (event.target.matches(".task-title")) startEdit(event.target.closest(".task"));
});

els.list.addEventListener("submit", (event) => {
  event.preventDefault();
  const row = event.target.closest(".task");
  const title = row.querySelector(".task-edit-title").value.trim();
  const due = row.querySelector(".task-edit-due").value || null;
  stopEdit(row);
  updateTask(row.dataset.id, { title, due });
});

els.list.addEventListener("keydown", (event) => {
  // keyCode 229 はSafariのIME確定直後のキー入力。
  if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
  if (event.target.closest(".task-edit")) stopEdit(event.target.closest(".task"));
});

els.clearDone.addEventListener("click", () => {
  const ids = new Set(tasks.filter(FILTERS.done).map((task) => task.id));
  const message = `完了したタスク${ids.size}件を削除しました`;
  // このボタンは押すと非表示になるので、先にフォーカスを移す。
  activeFilterButton().focus({ preventScroll: true });
  removeTasks(ids, message);
});

els.toastUndo.addEventListener("click", () => {
  const undo = toastUndoHandler;
  hideToast();
  undo?.();
});

els.toastCard.addEventListener("mouseenter", () => clearTimeout(toastTimer));
els.toastCard.addEventListener("mouseleave", startToastTimer);
els.toastCard.addEventListener("focusin", () => clearTimeout(toastTimer));
els.toastCard.addEventListener("focusout", startToastTimer);

// 別タブでの変更を反映する。古い内容で上書きしてしまうのを防ぐ。
window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  tasks = loadTasks();
  render();
});

// 開いたまま日付をまたいだ場合に「今日」「超過」の表示を更新する。
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) render();
});

render();
