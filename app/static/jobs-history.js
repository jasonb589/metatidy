/** Historical queries are independent of global task polling and never reorder on a timer. */
import { api } from "./api.js";
import { renderJobs, clearJobs, parseResult } from "./jobs-panel.js";
import * as ui from "./ui.js";

const query = { q: "", kind: "", state: "", page: 1, page_size: 20 };
let nodes;
let mode = "overview";
let loaded = false;
let loading = false;
let generation = 0;
let controller = null;
const liveRequests = new Map();
let sessionUsable = true;
let pages = 0;
let total = 0;
let observedOverview = "";
let currentItems = [];
let refreshGlobal = null;
let queryError = false;
const automatic = (job) => job.kind === "scan" && (job.summary?.trigger === "watch" || parseResult(job).trigger === "watch");

export function initJobsHistory({ onRefreshGlobal }) {
  refreshGlobal = onRefreshGlobal;
  nodes = {
    overview: ui.byId("jobs-overview"), history: ui.byId("jobs-history"), overviewTab: ui.byId("jobs-overview-tab"), historyTab: ui.byId("jobs-history-tab"),
    q: ui.byId("jobs-history-q"), kind: ui.byId("jobs-history-kind"), state: ui.byId("jobs-history-state"), reset: ui.byId("jobs-history-reset"),
    status: ui.byId("jobs-history-status"), update: ui.byId("jobs-history-update"), loadNew: ui.byId("jobs-history-load-new"),
    prev: ui.byId("jobs-history-prev"), next: ui.byId("jobs-history-next"), page: ui.byId("jobs-history-page"), total: ui.byId("jobs-history-total"),
    stats: ui.byId("jobs-global-stats"), activeHint: ui.byId("jobs-active-hint"), summary: ui.byId("jobs-summary"),
  };
  const search = ui.debounce(() => void loadHistory(), 250);
  const changed = () => {
    query.q = nodes.q.value.trim(); query.kind = nodes.kind.value; query.state = nodes.state.value; query.page = 1;
    cancel(); resetResults(); nodes.status.textContent = "正在查询历史任务…"; search();
  };
  nodes.q.addEventListener("input", changed);
  nodes.q.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing) { search.cancel(); void loadHistory(); } });
  for (const node of [nodes.kind, nodes.state]) node.addEventListener("change", () => { search.cancel(); changed(); search.cancel(); void loadHistory(); });
  nodes.reset.addEventListener("click", () => { nodes.q.value = ""; nodes.kind.value = ""; nodes.state.value = ""; changed(); search.cancel(); void loadHistory(); });
  nodes.prev.addEventListener("click", () => { if (query.page > 1) { query.page -= 1; void loadHistory(); } });
  nodes.next.addEventListener("click", () => { if (query.page < pages) { query.page += 1; void loadHistory(); } });
  nodes.loadNew.addEventListener("click", () => void loadHistory());
  for (const [tab, value] of [[nodes.overviewTab, "overview"], [nodes.historyTab, "history"]]) {
    tab.addEventListener("click", () => setMode(value));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const next = event.key === "Home" ? "overview" : event.key === "End" ? "history" : value === "overview" ? "history" : "overview";
      setMode(next); (next === "overview" ? nodes.overviewTab : nodes.historyTab).focus();
    });
  }
  window.addEventListener("metatidy:unauthorized", () => {
    sessionUsable = false; cancel(); search.cancel(); loaded = false; currentItems = []; total = 0; pages = 0; queryError = false;
    Object.assign(query, { q: "", kind: "", state: "", page: 1 }); observedOverview = "";
    clearJobs("jobs-history-list"); nodes.stats.replaceChildren(); nodes.status.textContent = ""; nodes.summary.textContent = "登录后查看任务";
    nodes.activeHint.replaceChildren(); nodes.activeHint.hidden = true; nodes.update.hidden = true; nodes.q.value = ""; nodes.kind.value = ""; nodes.state.value = ""; syncPager();
  });
  syncPager();
}

function setMode(next) {
  mode = next;
  nodes.overview.hidden = mode !== "overview"; nodes.history.hidden = mode !== "history";
  for (const [tab, active] of [[nodes.overviewTab, mode === "overview"], [nodes.historyTab, mode === "history"]]) { tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1; }
  if (mode === "history" && !loaded && !loading) void loadHistory();
}

function cancel() {
  controller?.abort(); controller = null; generation += 1; loading = false;
  for (const request of liveRequests.values()) request.abort(); liveRequests.clear();
}

function resetResults() {
  loaded = false; queryError = false; currentItems = []; total = 0; pages = 0;
  clearJobs("jobs-history-list"); nodes.update.hidden = true; syncPager();
}

async function loadHistory() {
  if (!sessionUsable) return;
  const pagingFocus = [nodes.prev, nodes.next].includes(document.activeElement) ? document.activeElement : null;
  cancel(); const revision = ++generation; const abort = new AbortController(); controller = abort;
  resetResults(); loading = true;
  nodes.status.textContent = "正在查询历史任务…"; syncPager();
  try {
    const data = await api.jobsHistory({ ...query }, { signal: abort.signal });
    if (!sessionUsable || generation !== revision) return;
    if (!Array.isArray(data.items)) throw new Error("任务历史响应不完整。");
    currentItems = data.items; total = Number(data.total) || 0; pages = Number(data.pages) || 0; query.page = Number(data.page) || 1;
    loaded = true; nodes.update.hidden = true;
    renderJobs(currentItems, automatic, { hostId: "jobs-history-list", retainOpen: false });
    nodes.status.textContent = total ? "" : "没有符合条件的任务，试试其他条件。";
  } catch (error) {
    if (!sessionUsable || generation !== revision || abort.signal.aborted) return;
    queryError = true;
    nodes.status.replaceChildren(ui.el("span", { text: `历史读取失败：${error.message} ` }), ui.el("button", { id: "jobs-history-retry", type: "button", class: "btn btn-sm", text: "重试", onClick: () => void loadHistory() }));
  } finally {
    if (generation === revision) {
      loading = false; syncPager();
      if (pagingFocus && document.activeElement === document.body && ui.byId("jobs-pop").dataset.open === "true") {
        (pagingFocus.disabled ? nodes.historyTab : pagingFocus).focus({ preventScroll: true });
      }
    }
  }
}

function syncPager() {
  nodes.prev.disabled = loading || !loaded || query.page <= 1;
  nodes.next.disabled = loading || !loaded || query.page >= pages;
  nodes.page.textContent = loaded ? `${query.page} / ${Math.max(1, pages)}` : "— / —";
  nodes.total.textContent = loading ? "查询中…" : loaded ? `匹配 ${ui.fmtNum(total)} 项` : queryError ? "历史未载入" : "尚未查询";
}

export function refreshVisibleJobs() {
  if (mode === "history") void loadHistory();
  else refreshGlobal?.();
}

export function onJobsCenterOpen() {
  if (mode === "history" && !loaded && !loading) void loadHistory();
}

export function updateJobsOverview(data) {
  if (!nodes || !sessionUsable) return;
  const jobs = data.jobs || [];
  const counts = data.counts || { total: jobs.length, running: jobs.filter((job) => job.state === "running").length, done: jobs.filter((job) => job.state === "done").length, error: jobs.filter((job) => job.state === "error").length };
  nodes.summary.textContent = `全局 ${ui.fmtNum(counts.total)} 项任务 · 进行中含排队任务`;
  if (!nodes.stats.children.length) {
    for (const [key, label] of [["running", "进行中（含排队）"], ["done", "已完成任务"], ["error", "任务失败"]]) nodes.stats.append(ui.el("div", { class: "jobs-stat", dataset: { jobsStat: key } }, [ui.el("strong"), ui.el("span", { text: label })]));
  }
  for (const node of nodes.stats.children) node.querySelector("strong").textContent = ui.fmtNum(counts[node.dataset.jobsStat] || 0);
  const active = data.active || [];
  const activeTotal = Number(data.active_total) || Number(counts.running) || 0;
  nodes.activeHint.hidden = activeTotal <= active.length;
  if (activeTotal > active.length) {
    if (!nodes.activeHint.children.length) nodes.activeHint.append(ui.el("span"), ui.el("button", { id: "jobs-show-running", type: "button", class: "btn btn-sm", text: "查看全部进行中", onClick: () => {
      query.q = ""; query.kind = ""; query.state = "running"; query.page = 1; nodes.q.value = ""; nodes.kind.value = ""; nodes.state.value = "running"; loaded = false; setMode("history");
    } }));
    nodes.activeHint.firstChild.textContent = `进行中 ${activeTotal} 项，优先展示 ${active.length} 项。`;
  }
  const fingerprint = JSON.stringify([counts, jobs.map((job) => [job.id, job.state]), active.map((job) => [job.id, job.state]), data.latest_completed_watch?.cursor]);
  if (observedOverview && observedOverview !== fingerprint && loaded) nodes.update.hidden = false;
  observedOverview = fingerprint;
  // History order and membership never follow global polling. Only visible
  // running records may get a newer summary, preserving their existing slot.
  if (mode === "history" && currentItems.some((job) => job.state === "running")) {
    const updates = new Map([...active, ...jobs].map((job) => [String(job.id), job]));
    currentItems = currentItems.map((job) => {
      const update = updates.get(String(job.id));
      return job.state === "running" && update && Number(update.updated_at) >= Number(job.updated_at) ? update : job;
    });
    renderJobs(currentItems, automatic, { hostId: "jobs-history-list", retainOpen: false });
    if (ui.byId("jobs-pop").dataset.open === "true") {
      for (const job of currentItems) if (job.state === "running" && !updates.has(String(job.id))) void refreshHistoricalJob(job);
    }
  }
}

/** Follow only the running records already on this page; never refill or sort it. */
async function refreshHistoricalJob(current) {
  const id = String(current.id);
  if (liveRequests.has(id)) return;
  const revision = generation; const abort = new AbortController(); liveRequests.set(id, abort);
  try {
    const job = await api.job(id, { signal: abort.signal });
    if (!sessionUsable || revision !== generation || abort.signal.aborted || String(job.id) !== id) return;
    const index = currentItems.findIndex((item) => String(item.id) === id);
    if (index < 0 || currentItems[index].state !== "running" || Number(job.updated_at) < Number(currentItems[index].updated_at)) return;
    if (job.state !== currentItems[index].state) nodes.update.hidden = false;
    currentItems[index] = job;
    renderJobs(currentItems, automatic, { hostId: "jobs-history-list", retainOpen: false });
  } catch {
    // Keep the last known progress; an open card still exposes result-load retry.
  } finally { if (liveRequests.get(id) === abort) liveRequests.delete(id); }
}
