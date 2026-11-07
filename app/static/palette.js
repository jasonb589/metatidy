/**
 * 命令面板（Ctrl/⌘ + K）。
 *
 * 目标：把「切页签 / 找一首歌 / 触发扫描 / 换主题」这类高频动作收进一个键盘入口，
 * 不用再满屏找按钮。它是一个**纯新增**的组件：不改动任何既有 DOM 钩子，
 * 需要别的模块做事时只发事件（`palette:*`）。
 */
import { api } from "./api.js";
import { emit } from "./store.js";
import { icon } from "./ui.js";

const TABS = [
  { name: "tracks", label: "曲库", ico: "music" },
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

function build() {
  if (host) return;
  host = document.createElement("div");
  host.className = "palette-veil";
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-modal", "true");
  host.setAttribute("aria-label", "命令面板");
  host.style.display = "none";

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

  host.addEventListener("mousedown", (event) => {
    if (event.target === host) closePalette();
  });
  input.addEventListener("input", () => {
    void refresh();
  });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runActive();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
    }
  });
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
  const query = (input.value || "").trim();
  const my = ++seq;

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
  render();
  if (!searching) return;

  let tracks = [];
  try {
    const data = await api.tracks({ q: query, page_size: 8 });
    if (my !== seq) return;
    tracks = (data.items || []).map((row) => ({
      title: row.title || row.filename || String(row.id),
      hint: [row.artist, row.album].filter(Boolean).join(" · ") || "曲目",
      ico: "music",
      run: () => emit("palette:track", row),
    }));
  } catch {
    tracks = [];
  }
  if (my !== seq) return;

  // 请求期间用户可能已用方向键选中本地命令，追加曲目时保留该选择。
  const selected = items[active];
  items = [...statics, ...tracks];
  active = Math.max(0, items.indexOf(selected));
  searching = false;
  render();
}

function render() {
  listNode.replaceChildren();
  listNode.setAttribute("aria-busy", String(searching));
  emptyNode.textContent = searching ? "正在查找曲目…" : "没有匹配的命令或曲目。";
  emptyNode.style.display = items.length ? "none" : "";
  items.forEach((item, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `palette-item${index === active ? " is-active" : ""}`;
    // 读屏能播报当前高亮项（item 是原生 button，键盘导航不用额外处理）
    if (index === active) row.setAttribute("aria-current", "true");
    const ico = icon(item.ico || "command", { size: 15 });
    if (ico) row.append(ico);
    const main = document.createElement("span");
    main.className = "palette-title";
    main.textContent = item.title;
    const hint = document.createElement("span");
    hint.className = "palette-hint";
    hint.textContent = item.hint || "";
    row.append(main, hint);
    row.addEventListener("mousemove", () => {
      if (active !== index) {
        active = index;
        render();
      }
    });
    row.addEventListener("click", () => {
      active = index;
      runActive();
    });
    listNode.append(row);
  });
}

function move(delta) {
  if (!items.length) return;
  active = (active + delta + items.length) % items.length;
  render();
  listNode.children[active]?.scrollIntoView({ block: "nearest" });
}

function runActive() {
  const item = items[active];
  if (!item) return;
  closePalette();
  item.run();
}

export function openPalette() {
  if (document.querySelector("dialog[open], .app-content[inert]")) return;
  build();
  if (!isPaletteOpen()) paletteTrigger = document.activeElement;
  host.style.display = "flex";
  input.value = "";
  void refresh();
  // 等一帧再聚焦：display 刚切成 flex 时直接 focus 有概率落空
  requestAnimationFrame(() => { if (isPaletteOpen()) input.focus(); });
}

export function closePalette() {
  if (!host) return;
  const restoreFocus = host.contains(document.activeElement);
  // 已关闭的查询不能在回包后覆盖下一次打开的命令列表。
  seq += 1;
  searching = false;
  host.style.display = "none";
  if (restoreFocus) {
    const valid = paletteTrigger instanceof HTMLElement && paletteTrigger.isConnected
      && paletteTrigger.getClientRects().length && !paletteTrigger.closest("[inert]")
      && !paletteTrigger.matches(":disabled") && !host.contains(paletteTrigger);
    (valid ? paletteTrigger : document.getElementById("btn-palette"))?.focus({ preventScroll: true });
  }
  paletteTrigger = null;
}

export function isPaletteOpen() {
  return Boolean(host) && host.style.display !== "none";
}

export function initPalette() {
  build();
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || document.querySelector("dialog[open]")) return;
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
  document.getElementById("btn-palette")?.addEventListener("click", openPalette);
}
