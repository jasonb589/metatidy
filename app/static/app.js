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
import { renderJobs, parseResult } from "./jobs-panel.js";
import { initKeyboardHelp } from "./keyboard-help.js";

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
let jobsRequest = null;
let watchJobsReady = false;
const completedWatchJobs = new Set();
let pendingLibraryRefresh = false;
let libraryRefreshRunning = false;
let libraryRefreshTimer = 0;

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
  initKeyboardHelp();

  wireSidebar();
  wireTabs();
  wireJobs();
  wireShortcuts();
  wireSessionGuard();
  wireLibraryUpdates();
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
  on("library:batch-scrape", () => {
    if (!canUseWorkspace() || !state.selection.size) return;
    activateTab("scrape", { focus: false }).then(() => {
      if (state.tab !== "scrape" || !canUseWorkspace()) return;
      const button = ui.byId("btn-batch-run");
      button.closest(".card")?.scrollIntoView({ block: "start", behavior: "instant" });
      document.querySelector('input[name="batch-mode"]:checked')?.focus({ preventScroll: true });
    }).catch(reportNavigationError);
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
  // 先建立历史任务基线，再读曲库；初始化期间完成的自动扫描不会被漏掉。
  await refreshJobs().catch(() => {});
  await Promise.all([loadStatus(), loadSettings(), loadSources()]);
  // 读取最新地址：认证/初始化期间可能通过浏览器前进后退切换了目标页面。
  const hash = (location.hash || "").replace("#", "");
  const initial = TABS.includes(hash) ? hash : "tracks";
  await activateTab(initial, { focus: false, scroll: false });
  refreshJobs().catch(() => {});
  window.setInterval(() => {
    if (document.visibilityState === "visible") pollBackgroundState();
  }, 15000);
}

/** 定时轮询只更新监听状态与任务；曲目和表单仅在确有新结果时更新。 */
async function pollBackgroundState() {
  if (!canUseWorkspace()) return;
  await Promise.allSettled([loadStatus({ lightweight: true }), refreshJobs()]);
  scheduleLibraryRefresh();
}

function canRefreshLibrary({ allowLoading = false } = {}) {
  if (!canUseWorkspace() || document.visibilityState !== "visible" || state.edit.open || state.edit.busy || hasForegroundOverlay()) return false;
  if (!allowLoading && state.tracks.loading) return false;
  const focused = document.activeElement;
  // 统计会更新筛选候选值，等用户结束输入/选择再刷新这些控件。
  return !focused?.closest(".library-toolbar input, .library-toolbar select, #tracks-pager, #filter-chips");
}

function scheduleLibraryRefresh() {
  if (!pendingLibraryRefresh || libraryRefreshTimer) return;
  libraryRefreshTimer = window.setTimeout(() => {
    libraryRefreshTimer = 0;
    void flushLibraryRefresh();
  }, 120);
}

async function flushLibraryRefresh() {
  if (!pendingLibraryRefresh || libraryRefreshRunning || !canRefreshLibrary()) return;
  pendingLibraryRefresh = false;
  libraryRefreshRunning = true;
  try {
    await loadStatus({ canApply: canRefreshLibrary });
    if (!canRefreshLibrary()) {
      pendingLibraryRefresh = true;
      return;
    }
    const applied = await tracks.refresh({ background: true, canApply: () => canRefreshLibrary({ allowLoading: true }) });
    if (applied === false) pendingLibraryRefresh = true;
  } catch {
    // 保留现有曲目；下一轮轮询或结束编辑后再尝试，不反复弹错误通知。
    pendingLibraryRefresh = true;
  } finally {
    libraryRefreshRunning = false;
  }
}

function wireLibraryUpdates() {
  on("edit:closed", scheduleLibraryRefresh);
  for (const event of ["focusout", "click", "keyup", "close"]) {
    document.addEventListener(event, scheduleLibraryRefresh, true);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void pollBackgroundState();
  });
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
  ui.setText(ui.byId("header-page-name"), copy.title);
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

async function loadStatus({ lightweight = false, canApply = () => true } = {}) {
  const status = await api.status();
  if (!canUseWorkspace()) return status;
  const previous = state.status;
  state.status = status;
  renderAutoScanStatus(status.auto_scan);
  if (lightweight || !canApply()) return status;
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
  if (!status.music_dir_exists && (!previous || previous.music_dir_exists || previous.music_dir !== status.music_dir)) {
    ui.toast("err", "音乐目录不存在", `${status.music_dir} —— 扫描会失败，请检查挂载或环境变量。`, { timeout: 12000 });
  }
  tracks.onStatus(status);
  tracks.invalidateSelectionCount();
  move.onStatus(status);
  settings.onStatus(status);
  return status;
}

function renderAutoScanStatus(auto) {
  const sidebar = ui.byId("sidebar-auto-scan");
  const hint = ui.byId("scan-auto-status");
  if (!sidebar || !hint) return;
  sidebar.hidden = hint.hidden = !auto;
  if (!auto) return;

  let label = "自动更新已开启";
  let tone = "ready";
  let description = "新增或修改的音乐会自动增量入库，文件写入完成后再扫描；已有记录不会自动删除。";
  if (!auto.enabled) {
    label = "自动更新未开启";
    tone = "muted";
    description = "自动更新未开启。导入新歌后，可在此手动增量扫描；无需勾选全量重扫。";
  } else if (auto.state === "retrying" || auto.state === "error" || auto.error) {
    label = "自动更新正在重试";
    tone = "warn";
    description = "自动更新暂不可用，服务将自动重试。已有曲库记录会保留。";
  } else if (auto.state === "scanning") {
    label = "正在更新曲库";
    tone = "busy";
  } else if (auto.pending_scopes > 0) {
    label = "等待文件写入完成";
    tone = "busy";
  } else if (!auto.watching) {
    label = "正在连接自动更新";
    tone = "muted";
  }
  if (auto.enabled && auto.fast) description += "当前使用快速扫描，按路径建立索引。";
  const detail = [description, auto.last_scan_at ? `上次完成：${ui.fmtTime(auto.last_scan_at)}` : "", auto.error || ""].filter(Boolean).join("\n");
  if (sidebar.textContent !== label) sidebar.textContent = label;
  sidebar.dataset.tone = tone;
  sidebar.title = detail;
  const text = `${label} · ${description}`;
  if (hint.textContent !== text) hint.textContent = text;
  hint.title = detail;
  hint.classList.toggle("hint-warn", tone === "warn");
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

function refreshJobs() {
  if (jobsRequest) return jobsRequest;
  jobsRequest = loadJobs().finally(() => { jobsRequest = null; });
  return jobsRequest;
}

function isAutomaticScan(job) {
  return job.kind === "scan" && (parseResult(job).trigger === "watch" || state.status?.auto_scan?.last_job_id === job.id);
}

async function loadJobs() {
  if (!canUseWorkspace()) return;
  const data = await api.jobs();
  if (!canUseWorkspace()) return;
  const list = data.jobs || [];
  for (const job of list) {
    if (job.state !== "done" || !isAutomaticScan(job)) continue;
    if (watchJobsReady && !completedWatchJobs.has(job.id)) pendingLibraryRefresh = true;
    completedWatchJobs.add(job.id);
  }
  watchJobsReady = true;
  // 任务接口只返回最近记录，保留足够的去重窗口即可。
  while (completedWatchJobs.size > 256) completedWatchJobs.delete(completedWatchJobs.values().next().value);
  scheduleLibraryRefresh();
  const running = list.filter((job) => job.state === "running").length;
  const badge = ui.byId("jobs-running");
  // 同时设内联样式：反代可能缓存着没有 [hidden] 规则的旧 CSS，否则「任务 0」会一直挂着
  badge.hidden = running === 0;
  badge.style.display = running === 0 ? "none" : "";
  if (badge.textContent !== String(running)) badge.textContent = String(running);

  renderJobs(list, isAutomaticScan);
}

document.addEventListener("DOMContentLoaded", boot);
if (document.readyState !== "loading") boot();
