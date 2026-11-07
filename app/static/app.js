/**
 * 应用入口：页签路由、全局数据（status / settings / sources）、任务面板、错误兜底。
 * 单页、无框架：每个页签模块自己管 DOM，这里只负责把后端状态分发下去。
 */

import { api, ApiError } from "./api.js";
import * as ui from "./ui.js";
import { state, on } from "./store.js";
import * as tracks from "./tracks.js";
import * as scrape from "./scrape.js";
import * as move from "./move.js";
import * as settings from "./settings.js";
import * as theme from "./theme.js";
import * as auth from "./auth.js";
import * as palette from "./palette.js";

const TABS = ["tracks", "scrape", "move", "settings"];
const PAGE_COPY = {
  tracks: { eyebrow: "YOUR MUSIC ARCHIVE", title: "我的音乐库", description: "收藏有序，热爱如初。" },
  scrape: { eyebrow: "METADATA DISCOVERY", title: "元数据刮削", description: "找到每首歌的完整故事。" },
  move: { eyebrow: "LIBRARY ORGANIZATION", title: "整理音乐库", description: "让每一份收藏，都有自己的位置。" },
  settings: { eyebrow: "MAKE IT YOURS", title: "工作台设置", description: "按照你的习惯，打理你的音乐。" },
};
const loadedTabs = new Set();

let jobsTimer = 0;
let booted = false;
let started = false;
let sessionReady = false;
let closeSidebar = () => {};
let closeJobs = () => {};

function boot() {
  if (booted) return;
  booted = true;
  tracks.init();
  scrape.init();
  move.init();
  settings.init();
  theme.init();
  auth.init();
  // 命令面板（Ctrl/⌘+K）：纯新增组件，别的模块通过 palette:* 事件响应
  palette.initPalette();

  wireSidebar();
  wireTabs();
  wireJobs();
  wireShortcuts();
  wireSessionGuard();
  decorateCardHeads();

  on("status:refresh", () => {
    if (!canUseWorkspace()) return;
    loadStatus().catch(() => {});
  });
  on("tracks:refresh", () => {
    if (!canUseWorkspace()) return;
    tracks.refresh().catch(() => {});
  });
  on("settings:saved", () => {
    move.onSettings();
    scrape.onSettingsLoaded();
  });
  on("jobs:refresh", () => {
    refreshJobs().catch(() => {});
  });

  window.addEventListener("error", (event) => {
    ui.toast("err", "界面脚本出错", event.message || String(event.error || ""));
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message = reason instanceof ApiError ? reason.message : reason && reason.message ? reason.message : String(reason);
    ui.toast("err", "请求未处理", message);
  });

  startGuarded().catch((err) => {
    ui.toast("err", "初始化失败", err && err.message ? err.message : String(err));
  });
}

/**
 * 先确认登录状态，再决定要不要初始化界面。
 *
 * 关键点：需要登录且没有会话时**一个数据请求都不发**（否则一屏 401 会把 toast 刷满）；
 * 首次登录成功后接着走正常启动，如果是「用着用着会话过期了」则整页重载最干净。
 */
async function startGuarded() {
  auth.onAuthenticated(async () => {
    if (started) location.reload();
    else await start();
  });
  const session = await auth.loadSession();
  if (session.required && !session.authenticated) {
    auth.showLoginOverlay("请输入访问密码。");
    return;
  }
  await start();
}

async function start() {
  started = true;
  sessionReady = true;
  setWorkspaceLocked(false);
  await Promise.all([loadStatus(), loadSettings(), loadSources()]);
  // 读取最新地址：认证/初始化期间可能通过浏览器前进后退切换了目标页面。
  const hash = (location.hash || "").replace("#", "");
  const initial = TABS.includes(hash) ? hash : "tracks";
  await activateTab(initial, { focus: false, scroll: false });
  refreshJobs().catch(() => {});
  window.setInterval(() => {
    if (document.visibilityState === "visible") refreshJobs().catch(() => {});
  }, 15000);
}

/* ------------------------------------------------------------------ 页签 */

function wireTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  document.querySelector(".tabs")?.setAttribute("aria-orientation", "vertical");
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => {
      activateTab(tab.dataset.tab, { focus: false }).catch(reportNavigationError);
    });
    tab.addEventListener("keydown", (event) => {
      let next = -1;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      if (next < 0) return;
      event.preventDefault();
      activateTab(tabs[next].dataset.tab, { focus: true, dismissSidebar: false }).catch(reportNavigationError);
    });
  });
  window.addEventListener("hashchange", () => {
    const name = (location.hash || "").replace("#", "");
    if (TABS.includes(name) && name !== state.tab) {
      activateTab(name, { focus: false }).catch(reportNavigationError);
    }
  });
}

function reportNavigationError(err) {
  ui.toast("err", "页面加载失败", err && err.message ? err.message : String(err));
}

async function activateTab(name, { focus = true, dismissSidebar = true, scroll = true } = {}) {
  if (!TABS.includes(name) || !canUseWorkspace()) return;
  const changed = name !== state.tab;
  state.tab = name;
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    const active = panel.dataset.panel === name;
    panel.dataset.active = active ? "true" : "false";
    panel.hidden = !active;
  });
  const copy = PAGE_COPY[name];
  ui.setText(ui.byId("page-eyebrow"), copy.eyebrow);
  ui.setText(ui.byId("page-title"), copy.title);
  ui.setText(ui.byId("page-description"), copy.description);
  document.title = `${copy.title} · metatidy`;
  document.body.dataset.page = name;
  if (dismissSidebar) closeSidebar();
  closeJobs({ restoreFocus: false });
  if ((location.hash || "").replace("#", "") !== name) {
    history.replaceState(null, "", `#${name}`);
  }
  // 只在跨页导航时回到标题；刷新、同页点击和初次加载保留当前位置。
  // instant 避免长列表页面继承 CSS smooth 后仍缓慢停留在下方。
  if (changed && scroll) window.scrollTo({ top: 0, left: window.scrollX, behavior: "instant" });

  if (name === "tracks" && !loadedTabs.has("tracks")) {
    loadedTabs.add("tracks");
    await tracks.refresh();
  } else if (name === "scrape") {
    await scrape.refreshAll();
    loadedTabs.add("scrape");
  } else if (name === "move") {
    move.onStatus(state.status || {});
    move.onSettings();
    loadedTabs.add("move");
  } else if (name === "settings") {
    settings.onStatus(state.status || {});
    settings.onSettings();
    settings.refreshAll();
    loadedTabs.add("settings");
  }
}

/* ------------------------------------------------------------ 工作区外壳 */

function canUseWorkspace() {
  const session = auth.current();
  return sessionReady && (!session.required || session.authenticated);
}

function setWorkspaceLocked(locked) {
  if (locked) {
    closeSidebar({ restoreFocus: false });
    closeJobs({ restoreFocus: false });
    palette.closePalette();
    // 原生 dialog 位于浏览器顶层，会遮住登录框；失效会话下按取消处理。
    document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
    const drawer = ui.byId("edit-drawer");
    if (drawer) drawer.inert = true;
  }
  const content = document.querySelector(".app-content");
  if (content) content.inert = locked;
  const skipLink = document.querySelector(".skip-link");
  if (skipLink) skipLink.inert = locked;
  if (locked) {
    const sidebar = ui.byId("app-sidebar");
    if (sidebar) sidebar.inert = true;
  } else closeSidebar({ restoreFocus: false });
}

function wireSessionGuard() {
  // 所有控件在确认会话前不可操作，登录表单位于工作区外，仍可正常聚焦。
  setWorkspaceLocked(true);
  window.addEventListener("metatidy:unauthorized", () => {
    sessionReady = false;
    setWorkspaceLocked(true);
  });
  window.addEventListener("keydown", (event) => {
    if (!canUseWorkspace() && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
}

/** 模态内容拥有自己的键盘行为，外壳不能在同一次 Escape 中继续关闭下层界面。 */
function hasForegroundOverlay() {
  if (palette.isPaletteOpen() || document.querySelector("dialog[open], #edit-drawer[data-open='true']")) return true;
  const authVeil = ui.byId("auth-veil");
  return Boolean(authVeil && authVeil.getClientRects().length && !authVeil.hidden);
}

function wireSidebar() {
  const sidebar = ui.byId("app-sidebar");
  const toggle = ui.byId("sidebar-toggle");
  const backdrop = ui.byId("sidebar-backdrop");
  if (!sidebar || !toggle || !backdrop) return;

  const media = window.matchMedia("(max-width: 900px)");
  const originalRole = sidebar.getAttribute("role");
  const content = document.querySelector(".app-content");
  const background = content && !content.contains(sidebar)
    ? [content]
    : [document.querySelector(".app-header"), ui.byId("main")].filter((node) => node && !node.contains(sidebar));
  const previousInert = new Map();
  let open = false;

  const focusables = () => [...sidebar.querySelectorAll("button:not(:disabled), a[href], input:not(:disabled), [tabindex='0']")]
    .filter((node) => node.tabIndex >= 0 && node.getClientRects().length && !node.closest("[inert]"));
  const focusInside = () => {
    const close = ui.byId("sidebar-close");
    const target = close?.getClientRects().length ? close : sidebar.querySelector(".tab[aria-selected='true']");
    (target || focusables()[0] || sidebar).focus();
  };

  function setOpen(want, { restoreFocus = true } = {}) {
    const wasOpen = open;
    open = Boolean(want && media.matches && canUseWorkspace());
    sidebar.dataset.open = String(open);
    document.body.dataset.sidebarOpen = String(open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "关闭导航菜单" : "打开导航菜单");
    backdrop.hidden = !open;
    if (!open) {
      previousInert.forEach((value, node) => { node.inert = value; });
      previousInert.clear();
      // 先把焦点交回可用内容，再隐藏抽屉，避免焦点留在 aria-hidden 子树里。
      if (wasOpen && restoreFocus && media.matches) toggle.focus();
    }
    sidebar.inert = !canUseWorkspace() || (media.matches && !open);
    if (media.matches && !open) sidebar.setAttribute("aria-hidden", "true");
    else sidebar.removeAttribute("aria-hidden");

    if (open) {
      sidebar.setAttribute("role", "dialog");
      sidebar.setAttribute("aria-modal", "true");
      background.forEach((node) => {
        if (!previousInert.has(node)) previousInert.set(node, node.inert);
        node.inert = true;
      });
      closeJobs({ restoreFocus: false });
      if (!wasOpen) requestAnimationFrame(() => { if (open) focusInside(); });
    } else {
      if (originalRole) sidebar.setAttribute("role", originalRole);
      else sidebar.removeAttribute("role");
      sidebar.removeAttribute("aria-modal");
    }
  }

  closeSidebar = (options) => setOpen(false, options);
  toggle.setAttribute("aria-controls", sidebar.id);
  toggle.addEventListener("click", () => setOpen(!open));
  backdrop.addEventListener("click", () => setOpen(false));
  ui.byId("sidebar-close")?.addEventListener("click", () => setOpen(false));

  document.addEventListener("keydown", (event) => {
    if (!open || event.defaultPrevented || hasForegroundOverlay()) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      // 命令面板接下来由 window 的监听器打开，先解除侧栏对工作区的焦点隔离。
      setOpen(false, { restoreFocus: false });
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "Tab") {
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
  }, true);

  const syncViewport = () => {
    const wasFocused = sidebar.contains(document.activeElement);
    setOpen(false, { restoreFocus: false });
    if (wasFocused && media.matches) toggle.focus();
    else if (wasFocused && !document.activeElement?.getClientRects().length) {
      sidebar.querySelector(".tab[aria-selected='true']")?.focus();
    }
  };
  if (typeof media.addEventListener === "function") media.addEventListener("change", syncViewport);
  else if (typeof media.addListener === "function") media.addListener(syncViewport);
  setOpen(false, { restoreFocus: false });
}

function wireShortcuts() {
  ui.byId("btn-scan-shortcut")?.addEventListener("click", async () => {
    if (!canUseWorkspace()) return;
    try {
      await activateTab("tracks", { focus: false });
      const options = ui.byId("scan-options");
      if (options) options.open = true;
      const button = ui.byId("btn-scan");
      if (button) {
        button.scrollIntoView({ block: "nearest", behavior: "auto" });
        button.focus({ preventScroll: true });
      }
    } catch (err) {
      reportNavigationError(err);
    }
  });
}

/* ------------------------------------------------------------- 全局数据 */

async function loadStatus() {
  const status = await api.status();
  state.status = status;
  const chip = ui.byId("header-version");
  if (chip) {
    const scraper = status.scraper || {};
    const pg = status.postgres === true;
    const redis = status.redis === true;
    // Redis 是可选依赖：缺少 Redis 不代表曲库服务不可用，降级说明保留在详情里。
    const healthy = pg && status.music_dir_exists;
    chip.textContent = healthy ? "服务已连接" : "服务异常";
    chip.title = [
      `后端版本 ${status.version}`,
      `Postgres ${pg ? "已连接" : "未连接！"}`,
      `Redis ${redis ? "已连接" : "未连接（任务进度只落数据库）"}`,
      `数据源 ${scraper.available ? `${scraper.count} 个可用` : "不可用"}`,
      `音乐目录 ${status.music_dir}（${status.music_dir_exists ? "存在" : "不存在！"}）`,
      `库根目录 ${status.library_root}`,
      `缓存目录 ${status.data_dir}`,
    ].join("\n");
    chip.classList.toggle("is-bad", !healthy);
    chip.classList.toggle("is-connected", Boolean(healthy));
  }
  ui.setText(ui.byId("sidebar-track-count"), ui.fmtNum(status.stats?.tracks ?? status.tracks ?? 0));
  const path = ui.byId("sidebar-library-path");
  if (path) {
    path.textContent = status.library_root || status.music_dir || "尚未设置目录";
    path.title = path.textContent;
  }
  const sourceCount = status.scraper?.count;
  if (Number.isFinite(Number(sourceCount))) ui.setText(ui.byId("sidebar-source-count"), ui.fmtNum(sourceCount));
  if (!status.music_dir_exists) {
    ui.toast("err", "音乐目录不存在", `${status.music_dir} —— 扫描会失败，请检查挂载或环境变量。`, { timeout: 12000 });
  }
  tracks.onStatus(status);
  tracks.invalidateSelectionCount();
  move.onStatus(status);
  settings.onStatus(status);
  return status;
}

async function loadSettings() {
  const data = await api.settings();
  state.settings = data;
  state.placeholders = data.placeholders || [];
  move.onSettings();
  scrape.onSettingsLoaded();
  settings.onSettings();
  return data;
}

async function loadSources() {
  const data = await api.sources();
  state.sources = data.sources || [];
  ui.setText(ui.byId("sidebar-source-count"), ui.fmtNum(state.sources.length));
  scrape.onSources(state.sources);
  settings.onSettings();
  return data;
}

/* ------------------------------------------------------------- 任务面板 */

function wireJobs() {
  const pop = ui.byId("jobs-pop");
  const button = ui.byId("btn-jobs");
  function setOpen(open, { restoreFocus = false } = {}) {
    if (open && !canUseWorkspace()) return;
    const wasOpen = pop.dataset.open === "true";
    if (!open && wasOpen && restoreFocus) button.focus();
    pop.dataset.open = open ? "true" : "false";
    button.setAttribute("aria-expanded", open ? "true" : "false");
    pop.setAttribute("aria-hidden", open ? "false" : "true");
    pop.inert = !open;
    window.clearInterval(jobsTimer);
    if (open) {
      refreshJobs().catch(() => {});
      jobsTimer = window.setInterval(() => {
        if (pop.dataset.open === "true") refreshJobs().catch(() => {});
      }, 3000);
      if (!wasOpen) requestAnimationFrame(() => {
        if (pop.dataset.open === "true") ui.byId("jobs-close")?.focus();
      });
    }
  }
  closeJobs = (options) => setOpen(false, options);
  button.addEventListener("click", () => {
    setOpen(pop.dataset.open !== "true");
  });
  ui.byId("jobs-close").addEventListener("click", () => {
    setOpen(false, { restoreFocus: true });
  });
  document.addEventListener("pointerdown", (event) => {
    if (pop.dataset.open === "true" && !pop.contains(event.target) && !button.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || pop.dataset.open !== "true" || hasForegroundOverlay()) return;
    event.preventDefault();
    setOpen(false, { restoreFocus: true });
  }, true);
  pop.addEventListener("focusout", () => {
    requestAnimationFrame(() => {
      if (pop.dataset.open === "true" && !pop.contains(document.activeElement) && document.activeElement !== button) setOpen(false);
    });
  });
  ui.byId("jobs-refresh").addEventListener("click", () => refreshJobs().catch(() => {}));
  setOpen(false);
}

/** 任务类型 → 图标名（未知类型不显示图标）。 */
const JOB_KIND_ICONS = { scan: "scan", scrape: "search", move: "move" };

/** 卡片小标题 → 图标名。纯装饰：文案对不上就不加，不影响任何功能。 */
const CARD_ICONS = {
  "最近任务": "jobs",
  "曲目": "music",
  "数据源": "search",
  "批量刮削": "scan",
  "目录层级模板": "move",
  "范围与策略": "filter",
  "移动计划": "move",
  "后端状态": "info",
  "整理与写入设置": "settings",
  "歌手别名库": "artist",
  "专辑别名库": "album",
};

/** 给每个卡片小标题补一个图标（幂等：已有图标就跳过）。 */
function decorateCardHeads() {
  document.querySelectorAll(".card-head h2").forEach((h2) => {
    const name = CARD_ICONS[(h2.textContent || "").trim()];
    if (!name || h2.querySelector(".ico-svg")) return;
    const svg = ui.icon(name, { size: 14 });
    if (svg) h2.prepend(svg);
  });
}

async function refreshJobs() {
  if (!canUseWorkspace()) return;
  const data = await api.jobs();
  const list = data.jobs || [];
  const running = list.filter((job) => job.state === "running").length;
  const badge = ui.byId("jobs-running");
  // 同时设内联样式：反代可能缓存着没有 [hidden] 规则的旧 CSS，否则「任务 0」会一直挂着
  badge.hidden = running === 0;
  badge.style.display = running === 0 ? "none" : "";
  badge.textContent = String(running);

  const host = ui.byId("jobs-list");
  ui.clear(host);
  if (!list.length) {
      host.append(ui.el("div", { class: "hint jobs-empty" }, [ui.icon("jobs", { size: 14 }), ui.el("span", { text: "还没有任务记录：扫描、批量刮削、整理执行都会出现在这里。" })]));
    return;
  }
  list.forEach((job) => {
    const percent = job.total ? Math.round((job.done / job.total) * 100) : null;
    host.append(
      ui.el("div", { class: "row", style: { gap: "var(--s2)", alignItems: "baseline" } }, [
          ui.el("span", { class: "badge" }, [ui.icon(JOB_KIND_ICONS[job.kind], { size: 12 }), ui.el("span", { text: ui.jobKindLabel(job.kind) })]),
        ui.jobStateBadge(job.state),
        ui.el("span", { class: "hint mono", text: job.id }),
        ui.el("span", {
          class: "hint",
          text: job.state === "running" && job.total ? `${job.done}/${job.total}（${percent}%）` : job.state === "running" ? `已处理 ${job.done}` : "",
        }),
        ui.el("div", { class: "spacer" }),
        ui.el("span", { class: "hint", text: ui.fmtTime(job.created_at) }),
      ]),
      ui.el("div", {
        class: "hint mono truncate",
        title: job.error || job.message || "",
        text: job.error || job.message || "—",
      }),
    );
  });
}

document.addEventListener("DOMContentLoaded", boot);
if (document.readyState !== "loading") boot();
