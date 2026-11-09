/**
 * 命令面板（Ctrl/⌘ + K）。
 *
 * 目标：把「切页签 / 找一首歌 / 触发扫描 / 换主题」这类高频动作收进一个键盘入口，
 * 不用再满屏找按钮。它是一个**纯新增**的组件：不改动任何既有 DOM 钩子，
 * 需要别的模块做事时只发事件（`palette:*`）。
 */
import { API, qs, request } from "./api.js";
import { emit } from "./store.js";
import { icon } from "./ui.js";

const TABS = [
  { name: "tracks", label: "曲库", ico: "music" },
  { name: "albums", label: "专辑收藏", ico: "album" },
  { name: "collections", label: "曲目清单", ico: "folder" },
  { name: "artist-portraits", label: "歌手头像", ico: "artist" },
  { name: "scrape", label: "搜索刮削", ico: "search" },
  { name: "move", label: "整理移动", ico: "move" },
  { name: "settings", label: "设置", ico: "settings" },
];

const STATIC_COMMANDS = [
  ...TABS.map((t) => ({
    title: `切换到「${t.label}」`,
    hint: "页签",
    ico: t.ico,
    run: () => {
      location.hash = `#${t.name}`;
    },
  })),
  {
    title: "快速扫描（只建索引）",
    hint: "扫描",
    ico: "scan",
    run: () => emit("palette:scan", { fast: true }),
  },
  {
    title: "全量重扫（忽略缓存，慢）",
    hint: "扫描",
    ico: "scan",
    run: () => emit("palette:scan", { full: true }),
  },
  {
    title: "刷新曲目列表",
    hint: "曲库",
    ico: "refresh",
    run: () => emit("palette:reload"),
  },
  {
    title: "清空筛选",
    hint: "曲库",
    ico: "filter",
    run: () => emit("palette:clear-filters"),
  },
  {
    title: "聚焦搜索框",
    hint: "曲库",
    ico: "search",
    run: () => emit("palette:focus-search"),
  },
  {
    title: "切换日夜主题",
    hint: "外观",
    ico: "theme",
    run: () => document.getElementById("btn-theme")?.click(),
  },
  {
    title: "审阅跨页已选曲目",
    hint: "选择",
    ico: "music",
    run: () => emit("library:review-selection"),
  },
  {
    title: "按文件夹浏览曲库",
    hint: "曲库目录",
    ico: "folder",
    run: () => emit("library:browse-folders"),
  },
  {
    title: "核对疑似重复曲目",
    hint: "曲库工具",
    ico: "copy",
    run: () => emit("library:review-duplicates"),
  },
  {
    title: "打开任务面板",
    hint: "任务",
    ico: "jobs",
    run: () => document.getElementById("btn-jobs")?.click(),
  },
  {
    title: "查看键盘快捷键",
    hint: "帮助",
    ico: "command",
    run: () => document.getElementById("btn-shortcuts-footer")?.click(),
  },
];

let host = null;
let input = null;
let listNode = null;
let emptyNode = null;
let items = [];
let active = 0;
let seq = 0;
let searching = false;
let paletteTrigger = null;
let searchController = null;
let initialized = false;
let accessBlocked = false;

function canUsePalette() {
  const session = window.__MT_AUTH?.state;
  const veil = document.getElementById("auth-veil");
  return !accessBlocked && Boolean(session && (!session.required || session.authenticated))
    && !document.querySelector(".app-content[inert]")
    && !(veil && !veil.hidden && veil.getClientRects().length);
}

function anotherDialog() {
  return [...document.querySelectorAll("dialog[open]")].some(dialog => dialog !== host);
}

function ready() { return isPaletteOpen() && canUsePalette() && !anotherDialog(); }

function cancelSearch() {
  seq += 1;
  searchController?.abort(); searchController = null;
  searching = false;
}

function build() {
  if (host) return;
  host = document.createElement("dialog");
  host.className = "palette-veil";
  host.hidden = true;
  host.setAttribute("aria-modal", "true");
  host.setAttribute("aria-label", "命令面板");

  const box = document.createElement("div");
  box.className = "palette";

  const head = document.createElement("div");
  head.className = "palette-head";
  const ico = icon("command", { size: 16 });
  if (ico) head.append(ico);
  input = document.createElement("input");
  input.type = "text";
  input.id = "palette-input";
  input.autocomplete = "off";
  input.placeholder = "输入命令，或搜一首歌…";
  input.setAttribute("aria-label", "搜索命令或曲目");
  head.append(input);

  const body = document.createElement("div");
  body.className = "palette-body";
  listNode = document.createElement("div");
  listNode.className = "palette-list";
  listNode.id = "palette-list";
  listNode.setAttribute("aria-label", "可执行的命令和曲目");
  input.setAttribute("aria-controls", listNode.id);
  emptyNode = document.createElement("div");
  emptyNode.className = "palette-empty";
  emptyNode.setAttribute("role", "status");
  emptyNode.textContent = "没有匹配的命令或曲目。";
  body.append(listNode, emptyNode);

  const foot = document.createElement("div");
  foot.className = "palette-foot";
  foot.append(keyHint("↑↓", "选择"), keyHint("Enter", "执行"), keyHint("Esc", "关闭"));

  box.append(head, body, foot);
  host.append(box);
  document.body.append(host);

  let backdropDown = false;
  host.addEventListener("pointerdown", event => { backdropDown = event.target === host; });
  host.addEventListener("click", event => {
    if (event.target === host && backdropDown) closePalette();
    backdropDown = false;
  });
  host.addEventListener("cancel", event => { event.preventDefault(); event.stopPropagation(); closePalette(); });
  // Native callers (including the session guard) may close the dialog directly.
  host.addEventListener("close", () => { if (!host.open) finishClose(); });
  input.addEventListener("input", () => {
    void refresh();
  });
  host.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") || event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); closePalette();
    } else if (event.key === "Tab") {
      trapTab(event);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation(); move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && event.target === input) {
      event.preventDefault();
      event.stopPropagation(); runActive();
    }
  });
}

function trapTab(event) {
  const focusable = [input, ...listNode.querySelectorAll("button:not(:disabled)")];
  const first = focusable[0], last = focusable.at(-1), focused = document.activeElement;
  if (event.shiftKey && (focused === first || !host.contains(focused))) {
    event.preventDefault(); last.focus({ preventScroll: true });
    if (last !== input) last.scrollIntoView({ block: "nearest", behavior: "instant" });
  } else if (!event.shiftKey && (focused === last || !host.contains(focused))) {
    event.preventDefault(); first.focus({ preventScroll: true });
  }
  // The shell must not interpret the same Tab against an open lower widget.
  event.stopPropagation();
}

function keyHint(key, label) {
  const wrap = document.createElement("span");
  wrap.className = "palette-key";
  const k = document.createElement("kbd");
  k.textContent = key;
  const l = document.createElement("span");
  l.textContent = label;
  wrap.append(k, l);
  return wrap;
}

function matches(text, query) {
  if (!query) return true;
  return text.toLowerCase().includes(query.toLowerCase());
}

async function refresh() {
  if (!ready()) return;
  const query = (input.value || "").trim();
  cancelSearch();
  const my = seq;

  const statics = STATIC_COMMANDS.filter((c) => matches(c.title, query)).map((c) => ({
    title: c.title,
    hint: c.hint,
    ico: c.ico,
    run: c.run,
  }));

  // 本地命令必须同步换成当前查询；输入后立即 Enter 也不能执行上一轮结果。
  // 只有远程曲目匹配时，先清空旧项，等待期间 Enter 不执行任何操作。
  items = statics;
  active = 0;
  searching = query.length >= 2;
  renderItems();
  if (!searching) return;

  let tracks = [];
  const controller = new AbortController(); searchController = controller;
  try {
    const data = await request(`${API}/tracks?${qs({ q: query, page_size: 8 })}`, { signal: controller.signal });
    if (my !== seq || !ready() || controller.signal.aborted) return;
    const seen = new Set();
    tracks = (Array.isArray(data.items) ? data.items : []).filter(row => Number.isSafeInteger(row?.id) && row.id > 0 && !seen.has(row.id) && seen.add(row.id)).slice(0, 8).map((row) => ({
      title: row.title || row.filename || String(row.id),
      hint: [row.artist, row.album].filter(Boolean).join(" · ") || "曲目",
      ico: "music",
      run: () => emit("palette:track", row),
    }));
  } catch {
    tracks = [];
  }
  if (my !== seq || !ready() || controller.signal.aborted) return;

  // Local buttons remain the exact same DOM nodes. Appending remote results
  // must preserve both the user's highlight and an actually focused command.
  items = [...statics, ...tracks];
  tracks.forEach((item, index) => listNode.append(createRow(item, statics.length + index)));
  searching = false;
  searchController = null;
  updateStatus(); updateHighlight();
}

function updateStatus() {
  listNode.setAttribute("aria-busy", String(searching));
  emptyNode.textContent = searching ? "正在查找曲目…" : "没有匹配的命令或曲目。";
  emptyNode.hidden = Boolean(items.length);
}

function renderItems() {
  // Queries change only while the input is focused; hover and arrow navigation
  // never call this renderer or detach a focused button.
  listNode.replaceChildren(...items.map(createRow));
  updateStatus(); updateHighlight();
}

function createRow(item, index) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "palette-item";
  row.dataset.paletteIndex = index;
  const ico = icon(item.ico || "command", { size: 15 });
  if (ico) row.append(ico);
  const main = document.createElement("span");
  main.className = "palette-title";
  main.textContent = item.title;
  const hint = document.createElement("span");
  hint.className = "palette-hint";
  hint.textContent = item.hint || "";
  row.append(main, hint);
  row.addEventListener("pointermove", () => { if (ready() && active !== index) { active = index; updateHighlight(); } });
  row.addEventListener("focus", () => { if (ready()) { active = index; updateHighlight(); } });
  row.addEventListener("click", () => {
    if (!ready()) return;
    active = index;
    runActive();
  });
  return row;
}

function updateHighlight() {
  for (const [index, row] of [...listNode.children].entries()) {
    const selected = index === active;
    row.classList.toggle("is-active", selected);
    if (selected) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
  }
}

function move(delta) {
  if (!ready() || !items.length) return;
  const rowFocused = listNode.contains(document.activeElement);
  if (rowFocused) active = Number(document.activeElement.closest(".palette-item").dataset.paletteIndex);
  active = (active + delta + items.length) % items.length;
  updateHighlight();
  const row = listNode.children[active];
  if (rowFocused) row?.focus({ preventScroll: true });
  row?.scrollIntoView({ block: "nearest", behavior: "instant" });
}

function runActive() {
  if (!ready()) return;
  const item = items[active];
  if (!item) return;
  closePalette();
  item.run();
}

export function openPalette() {
  if (!canUsePalette() || anotherDialog()) return;
  build();
  if (isPaletteOpen()) { input.focus({ preventScroll: true }); return; }
  paletteTrigger = document.activeElement;
  input.value = "";
  host.hidden = false;
  host.showModal();
  void refresh();
  input.focus({ preventScroll: true });
}

export function closePalette({ restoreFocus = true } = {}) {
  if (!host?.open) return;
  const restore = restoreFocus && host.contains(document.activeElement);
  host.close();
  finishClose(restore);
}

function finishClose(restoreFocus = false) {
  cancelSearch();
  host.hidden = true;
  if (restoreFocus && canUsePalette() && !anotherDialog()) {
    const valid = paletteTrigger instanceof HTMLElement && paletteTrigger.isConnected
      && paletteTrigger.getClientRects().length && !paletteTrigger.closest("[inert]")
      && !paletteTrigger.matches(":disabled") && !host.contains(paletteTrigger);
    (valid ? paletteTrigger : document.getElementById("btn-palette"))?.focus({ preventScroll: true });
  }
  paletteTrigger = null;
}

export function isPaletteOpen() {
  return Boolean(host?.open);
}

export function initPalette() {
  if (initialized) return;
  initialized = true;
  build();
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || anotherDialog()) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "k") {
      event.preventDefault();
      if (isPaletteOpen()) closePalette();
      else openPalette();
      return;
    }
    if (key === "escape" && isPaletteOpen()) {
      event.preventDefault();
      closePalette();
    }
  });
  const lock = () => { accessBlocked = true; closePalette({ restoreFocus: false }); cancelSearch(); };
  window.addEventListener("metatidy:unauthorized", lock);
  window.addEventListener("metatidy:logout", lock);
  window.addEventListener("metatidy:authenticated", () => { accessBlocked = false; });
  document.getElementById("btn-palette")?.addEventListener("click", openPalette);
}
