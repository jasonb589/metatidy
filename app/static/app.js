/**
 * 应用入口：页签路由、全局数据（status / settings / sources）、任务面板、错误兜底。
 * 单页、无框架：每个页签模块自己管 DOM，这里只负责把后端状态分发下去。
 */

import { api, ApiError } from "./api.js";
import * as ui from "./ui.js";
import { state, on, emit } from "./store.js";
import * as tracks from "./tracks.js";
import * as scrape from "./scrape.js";
import * as move from "./move.js";
import * as settings from "./settings.js";
import * as theme from "./theme.js";

const TABS = ["tracks", "scrape", "move", "settings"];
const loadedTabs = new Set();

let jobsTimer = 0;
let booted = false;

function boot() {
  if (booted) return;
  booted = true;
  tracks.init();
  scrape.init();
  move.init();
  settings.init();
  theme.init();

  wireTabs();
  wireJobs();

  on("status:refresh", () => {
    loadStatus().catch(() => {});
  });
  on("tracks:refresh", () => {
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

  start().catch((err) => {
    ui.toast("err", "初始化失败", err && err.message ? err.message : String(err));
  });
}

async function start() {
  const hash = (location.hash || "").replace("#", "");
  const initial = TABS.includes(hash) ? hash : "tracks";
  await Promise.all([loadStatus(), loadSettings(), loadSources()]);
  await activateTab(initial, { focus: false });
  refreshJobs().catch(() => {});
  window.setInterval(() => {
    if (document.visibilityState === "visible") refreshJobs().catch(() => {});
  }, 15000);
}

/* ------------------------------------------------------------------ 页签 */

function wireTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab, { focus: false }));
    tab.addEventListener("keydown", (event) => {
      let next = -1;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      if (next < 0) return;
      event.preventDefault();
      activateTab(tabs[next].dataset.tab, { focus: true });
    });
  });
  window.addEventListener("hashchange", () => {
    const name = (location.hash || "").replace("#", "");
    if (TABS.includes(name) && name !== state.tab) activateTab(name, { focus: false });
  });
}

async function activateTab(name, { focus = true } = {}) {
  if (!TABS.includes(name)) return;
  state.tab = name;
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.dataset.active = panel.dataset.panel === name ? "true" : "false";
  });
  if ((location.hash || "").replace("#", "") !== name) {
    history.replaceState(null, "", `#${name}`);
  }

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

/* ------------------------------------------------------------- 全局数据 */

async function loadStatus() {
  const status = await api.status();
  state.status = status;
  const chip = ui.byId("header-version");
  if (chip) {
    const scraper = status.scraper || {};
    const pg = status.postgres === true;
    const redis = status.redis === true;
    // 这个胶囊的价值是「一眼看出后端健不健康」：版本 + 两个存储的连通状态。
    // 数据源数量只在 tooltip 里给（数字基本恒定，摆在正面没有信息量）。
    chip.textContent = `v${status.version} · PG ${pg ? "✓" : "✗"} Redis ${redis ? "✓" : "✗"}`;
    chip.title = [
      `后端版本 ${status.version}`,
      `Postgres ${pg ? "已连接" : "未连接！"}`,
      `Redis ${redis ? "已连接" : "未连接（任务进度只落数据库）"}`,
      `数据源 ${scraper.available ? `${scraper.count} 个可用` : "不可用"}`,
      `音乐目录 ${status.music_dir}（${status.music_dir_exists ? "存在" : "不存在！"}）`,
      `库根目录 ${status.library_root}`,
      `缓存目录 ${status.data_dir}`,
    ].join("\n");
    chip.className = `chip ${pg && redis && status.music_dir_exists ? "" : "is-bad"}`.trim();
  }
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
  scrape.onSources(state.sources);
  settings.onSettings();
  return data;
}

/* ------------------------------------------------------------- 任务面板 */

function wireJobs() {
  const pop = ui.byId("jobs-pop");
  const button = ui.byId("btn-jobs");
  button.addEventListener("click", () => {
    const open = pop.dataset.open !== "true";
    pop.dataset.open = open ? "true" : "false";
    button.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      refreshJobs().catch(() => {});
      window.clearInterval(jobsTimer);
      jobsTimer = window.setInterval(() => {
        if (pop.dataset.open === "true") refreshJobs().catch(() => {});
      }, 3000);
    } else {
      window.clearInterval(jobsTimer);
    }
  });
  ui.byId("jobs-close").addEventListener("click", () => {
    pop.dataset.open = "false";
    button.setAttribute("aria-expanded", "false");
    button.focus();
    window.clearInterval(jobsTimer);
  });
  ui.byId("jobs-refresh").addEventListener("click", () => refreshJobs().catch(() => {}));
}

async function refreshJobs() {
  const data = await api.jobs();
  const list = data.jobs || [];
  const running = list.filter((job) => job.state === "running").length;
  const badge = ui.byId("jobs-running");
  badge.hidden = running === 0;
  badge.textContent = String(running);

  const host = ui.byId("jobs-list");
  ui.clear(host);
  if (!list.length) {
    host.append(ui.el("div", { class: "hint", text: "还没有任务记录：扫描、批量刮削、整理执行都会出现在这里。" }));
    return;
  }
  list.forEach((job) => {
    const percent = job.total ? Math.round((job.done / job.total) * 100) : null;
    host.append(
      ui.el("div", { class: "row", style: { gap: "var(--s2)", alignItems: "baseline" } }, [
        ui.el("span", { class: "badge", text: ui.jobKindLabel(job.kind) }),
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
