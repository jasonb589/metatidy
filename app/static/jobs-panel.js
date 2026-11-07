/** Keyed task cards: polling updates text, never replaces disclosure controls. */
import * as ui from "./ui.js";
import { api, jobReportUrl } from "./api.js";

const collections = new Map();
let sessionRevision = 0;
const KIND_ICONS = { scan: "scan", scrape: "search", move: "move" };
const STATE_COPY = { running: ["运行中", "badge-info"], done: ["已完成", "badge-ok"], error: ["失败", "badge-err"] };

export function parseResult(job) {
  if (job.result && typeof job.result === "object" && !Array.isArray(job.result)) return job.result;
  try {
    const value = JSON.parse(job.result || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function setText(node, value) {
  if (!node) return;
  const text = value == null ? "" : String(value);
  if (node.textContent !== text) node.textContent = text;
}

function jobVersion(job) {
  return JSON.stringify([job.state, job.updated_at, job.done, job.total, job.message, job.error]);
}

function latestJob(current, incoming) {
  if (!current) return incoming;
  const known = Number(current.updated_at) || 0;
  const next = Number(incoming.updated_at) || 0;
  if (known > next || known === next && current.state !== "running" && incoming.state === "running") return current;
  if (known === next && current.state === "running" && incoming.state === "running" && Number(current.done) > Number(incoming.done)) return current;
  return incoming;
}

function cancelDetails(card) {
  card.request += 1;
  card.controller?.abort();
  card.controller = null;
  card.loading = false;
}

function describeError(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return value == null ? "" : String(value);
  const who = value.source || value.path || value.filename || (value.track_id != null ? `曲目 #${value.track_id}` : "");
  const target = value.target ? ` → ${value.target}` : "";
  return [who + target, value.error || value.reason || value.message || JSON.stringify(value)].filter(Boolean).join("\n");
}

function errorsFor(job, result) {
  return [job.error, ...(Array.isArray(result.errors) ? result.errors : []),
    ...(Array.isArray(result.failures) ? result.failures : []),
    ...(Array.isArray(result.details) ? result.details.filter(item => item?.error) : [])]
    .map(describeError).filter(Boolean);
}

function summaryMetrics(job, result) {
  const fields = job.kind === "scan"
    ? [["added", "新增"], ["updated", "更新"], ["skipped", "跳过"], ["removed", "清理记录"], ["failed", "失败"]]
    : job.kind === "scrape"
      ? [["applied", "已写入"], ["skipped", result.search_only ? "仅搜索 / 跳过" : "跳过"], ["failed", "失败"]]
      : job.kind === "move"
        ? [["moved", "已移动"], ["renamed", "自动改名"], ["skipped", "跳过"], ["failed", "失败"]]
        : [];
  return fields.filter(([key]) => result[key] != null && Number.isFinite(Number(result[key])));
}

function contextRows(job, result, automatic) {
  const rows = [["任务编号", job.id], ["开始时间", ui.fmtTime(job.created_at)]];
  if (job.kind === "scan") {
    rows.push(["触发方式", automatic ? "文件监听 · 自动增量" : "手动扫描"]);
    if (result.root) rows.push(["扫描目录", result.root]);
    if (result.fast_mode != null) rows.push(["扫描方式", result.fast_mode ? "快速索引" : "读取音频标签"]);
    if (result.scanned != null) rows.push(["检查文件", `${ui.fmtNum(result.scanned)} 首`]);
    if (result.parsed != null) rows.push(["读取标签", `${ui.fmtNum(result.parsed)} 首`]);
  } else if (result.search_only != null) rows.push(["执行方式", result.search_only ? "仅搜索候选" : "自动写入"]);
  if (result.dry_run != null) rows.push(["执行方式", result.dry_run ? "仅演练" : "实际移动"]);
  if (result.library_root) rows.push(["归档目录", result.library_root]);
  const seconds = Number(result.total_seconds ?? result.seconds);
  if (Number.isFinite(seconds) && seconds >= 0) rows.push(["耗时", `${seconds.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 秒`]);
  return rows;
}

function createCard(id, cards, isAutomatic) {
  const title = ui.el("span", { class: "job-title" });
  const time = ui.el("time", { class: "job-time" });
  const message = ui.el("span", { class: "job-message" });
  const icon = ui.el("span", { class: "job-icon", "aria-hidden": "true" });
  const state = ui.el("span", { class: "badge" });
  const summary = ui.el("summary", { class: "job-summary" }, [icon,
    ui.el("span", { class: "job-heading" }, [title, message, time]), state,
    ui.el("span", { class: "job-chevron", "aria-hidden": "true", text: "⌄" })]);
  const metrics = ui.el("div", { class: "job-metrics" });
  const context = ui.el("dl", { class: "job-context" });
  const progressText = ui.el("span");
  const progressFill = ui.el("i");
  const progressBar = ui.el("div", { class: "job-progress-bar", role: "progressbar", "aria-label": "任务进度" }, [progressFill]);
  const progress = ui.el("div", { class: "job-progress" }, [progressText, progressBar]);
  const errorText = ui.el("pre", { class: "job-error-text", tabindex: "0", "aria-label": "完整错误详情" });
  const errorTitle = ui.el("strong");
  const copyFeedback = ui.el("span", { class: "job-copy-feedback", role: "status" });
  const copy = ui.el("button", { type: "button", class: "btn btn-sm job-copy-error", text: "复制错误详情" });
  const errors = ui.el("section", { class: "job-errors", hidden: true }, [
    ui.el("div", { class: "job-error-head" }, [errorTitle, copy]), errorText, copyFeedback,
  ]);
  const detailRows = ui.el("div", { class: "job-detail-rows" });
  const detailNote = ui.el("p", { class: "hint" });
  const details = ui.el("section", { class: "job-detail-section", hidden: true }, [
    ui.el("h3", { text: "处理明细" }), detailRows, detailNote,
  ]);
  const resultStatus = ui.el("p", { class: "job-result-status", role: "status" });
  const retry = ui.el("button", { type: "button", class: "btn btn-sm job-detail-retry", text: "重新读取结果", hidden: true });
  const report = ui.el("a", { class: "btn btn-sm job-report-download", href: jobReportUrl(id), download: "", text: "下载已存结果 JSON" });
  const reportNote = ui.el("span", { class: "hint", text: "下载服务器已保存的汇总与明细。" });
  const body = ui.el("div", { class: "job-body" }, [progress, metrics, context, resultStatus, retry, errors, details, ui.el("div", { class: "job-report-actions" }, [reportNote, report])]);
  const node = ui.el("details", { class: "job-card", dataset: { jobId: id } }, [summary, body]);
  const card = { node, title, time, message, icon, state, metrics, context, progress, progressText, progressBar, progressFill,
    errors, errorTitle, errorText, copy, copyFeedback, details, detailRows, detailNote, resultStatus, retry, report, reportNote,
    fingerprint: "", errorReport: "", hasErrors: false, job: null, detail: null, loading: false, request: 0, controller: null, sourceVersion: "", isAutomatic };
  retry.addEventListener("click", () => void loadDetails(card, cards));
  node.addEventListener("toggle", () => { if (node.open && card.job && card.job.result === undefined && !card.detail && !card.loading) void loadDetails(card, cards); });
  copy.addEventListener("click", async () => {
    const text = card.errorReport;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setText(copyFeedback, "错误详情已复制");
    } catch {
      // HTTP deployments may not expose Clipboard API. Select the readable
      // diagnostic so a keyboard copy still works without a hidden input.
      errorText.focus({ preventScroll: true });
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(errorText);
      selection?.removeAllRanges();
      selection?.addRange(range);
      setText(copyFeedback, "已选中错误详情，请按 Ctrl/Cmd+C 复制");
    }
  });
  cards.set(id, card);
  return card;
}

async function loadDetails(card, cards) {
  const id = card.node.dataset.jobId;
  const request = ++card.request;
  const session = sessionRevision;
  const sourceVersion = card.sourceVersion;
  const controller = new AbortController(); card.controller = controller;
  card.loading = true; card.retry.hidden = true;
  setText(card.resultStatus, "正在读取服务器保存的任务结果…");
  try {
    const job = await api.job(id, { signal: controller.signal });
    if (session !== sessionRevision || cards.get(id) !== card || request !== card.request || sourceVersion !== card.sourceVersion) return;
    if (String(job.id) !== id || job.result === undefined) throw new Error("任务详情响应不完整。");
    if (Number(job.updated_at) < Number(card.job.updated_at) || card.job.state !== "running" && job.state === "running") throw new Error("任务状态已更新，请重新读取最新结果。");
    const restoreRetryFocus = document.activeElement === card.retry;
    card.detail = job; card.fingerprint = "";
    updateCard(card, job, card.isAutomatic(job));
    if (restoreRetryFocus && card.node.open) card.report.focus({ preventScroll: true });
  } catch (error) {
    if (session !== sessionRevision || cards.get(id) !== card || request !== card.request) return;
    setText(card.resultStatus, `结果读取失败：${error.message}`); card.retry.hidden = false;
  } finally { if (request === card.request) { card.loading = false; card.controller = null; } }
}

function updateCard(card, job, automatic) {
  card.job = job;
  const hasResult = job.result !== undefined;
  const fingerprint = JSON.stringify([job, automatic]);
  if (card.fingerprint === fingerprint) {
    card.errors.hidden = !card.hasErrors && !card.errors.contains(document.activeElement);
    return;
  }
  const previousState = card.node.dataset.jobState;
  card.fingerprint = fingerprint;
  const result = hasResult ? parseResult(job) : job.summary || {};
  const state = STATE_COPY[job.state] || [job.state || "未知", "badge-mute"];
  const partial = job.state === "done" && (job.has_errors || Number(result.failed) > 0 || errorsFor(job, result).length > 0);
  card.node.dataset.partial = String(Boolean(partial));
  card.node.dataset.jobState = job.state;
  setText(card.title, automatic ? "自动增量扫描" : ui.jobKindLabel(job.kind));
  setText(card.state, partial ? "已完成 · 部分失败" : state[0]);
  card.state.className = `badge ${state[1]}`;
  if (card.icon.dataset.kind !== job.kind) {
    card.icon.dataset.kind = job.kind;
    card.icon.replaceChildren(ui.icon(KIND_ICONS[job.kind] || "jobs", { size: 17 }));
  }
  const metrics = summaryMetrics(job, result);
  const summary = metrics.filter(([key]) => Number(result[key]) > 0).slice(0, 3)
    .map(([key, label]) => `${label} ${ui.fmtNum(result[key])}`).join(" · ");
  setText(card.message, job.error || (job.state === "done" && summary) || job.message || "等待任务结果");
  card.message.title = job.error || job.message || summary;
  setText(card.time, ui.fmtTime(job.created_at));
  const timestamp = new Date(Number(job.created_at) * 1000);
  card.time.dateTime = Number(job.created_at) > 0 && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : "";

  card.progress.hidden = job.state !== "running";
  const total = Math.max(0, Number(job.total) || 0);
  const done = Math.max(0, Number(job.done) || 0);
  const percent = total ? Math.min(100, Math.round(done / total * 100)) : 0;
  setText(card.progressText, total ? `已处理 ${ui.fmtNum(done)} / ${ui.fmtNum(total)} · ${percent}%` : `已处理 ${ui.fmtNum(done)}，正在继续…`);
  card.progressBar.setAttribute("aria-valuemin", "0");
  card.progressBar.setAttribute("aria-valuemax", "100");
  if (total) card.progressBar.setAttribute("aria-valuenow", String(percent));
  else card.progressBar.removeAttribute("aria-valuenow");
  card.progressBar.dataset.indeterminate = String(!total);
  card.progressFill.style.width = total ? `${percent}%` : "24%";
  if (!card.loading || hasResult) {
    let status = !hasResult ? "展开后读取完整的已保存结果。" : !job.result ? job.state === "running" ? "任务仍在进行，尚未保存最终结果。" : "这个任务没有保存结果正文。" : "";
    if (hasResult && job.result) {
      try { JSON.parse(typeof job.result === "string" ? job.result : JSON.stringify(job.result)); }
      catch { status = "已保存结果无法解析，可下载原始记录查看。"; }
    }
    setText(card.resultStatus, status);
    if (hasResult) card.retry.hidden = true;
  }
  setText(card.reportNote, job.state === "running" ? "下载进行中的快照，结果尚未最终完成。" : job.kind === "scrape" && result.details_truncated !== false ? "已存明细可能截断；报告不会补造缺失记录。" : job.kind === "move" ? "结果不包含全部成功文件的最终路径。" : "下载服务器已保存的汇总与明细。");

  card.metrics.hidden = !metrics.length;
  card.metrics.replaceChildren(...metrics.map(([key, label]) => ui.el("div", { class: "job-metric", dataset: { metric: key } }, [
    ui.el("strong", { text: ui.fmtNum(result[key]) }), ui.el("span", { text: label }),
  ])));
  card.context.replaceChildren(...contextRows(job, result, automatic).flatMap(([label, value]) => [
    ui.el("dt", { text: label }), ui.el("dd", { text: value, title: String(value ?? "") }),
  ]));

  const errorLines = errorsFor(job, result);
  card.hasErrors = errorLines.length > 0;
  const report = [`任务 ${job.id}`, `${ui.jobKindLabel(job.kind)} · ${state[0]}`, ...errorLines].join("\n\n");
  if (card.errorReport !== report) {
    card.errorReport = report;
    setText(card.errorText, errorLines.join("\n\n"));
    setText(card.copyFeedback, "");
  }
  // Preserve an existing focused control even if an unusual job update clears
  // its previous error; the next poll can hide it once focus has moved away.
  card.errors.hidden = !card.hasErrors && !card.errors.contains(document.activeElement);
  setText(card.errorTitle, `错误详情${errorLines.length ? ` · ${errorLines.length}` : ""}`);

  const storedRows = Array.isArray(result.details) ? result.details : [];
  const rows = storedRows.filter(item => item && !item.error);
  card.details.hidden = !storedRows.length && result.details_truncated !== true;
  card.detailRows.replaceChildren(...rows.slice(0, 30).map(item => {
    const candidate = item.candidate || {};
    const who = [candidate.title || item.title || (item.track_id != null ? `曲目 #${item.track_id}` : "曲目"), candidate.artist].filter(Boolean).join(" · ");
    const what = [item.status, candidate.source, item.score != null ? `匹配分 ${item.score}` : ""].filter(Boolean).join(" · ");
    return ui.el("div", { class: "job-detail-row" }, [ui.el("span", { text: who }), ui.el("span", { text: what })]);
  }));
  const truncated = result.details_truncated === true;
  const notes = [];
  if (rows.length > 30) notes.push("非错误明细显示前 30 条。");
  if (storedRows.length) notes.push(`已保存 ${ui.fmtNum(storedRows.length)} 条明细（含错误）。`);
  if (truncated) notes.push(`保存内容已截断${result.details_total != null ? `，原明细总数 ${ui.fmtNum(result.details_total)}` : ""}。`);
  else if (job.kind === "scrape" && hasResult && storedRows.length && result.details_truncated == null) notes.push("旧记录未注明是否截断。");
  setText(card.detailNote, notes.join(""));
  card.detailNote.hidden = !notes.length;
  if (previousState && previousState !== job.state && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    card.state.animate([{ opacity: .3, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "ease-out" });
  }
}

export function renderJobs(list, isAutomatic, { hostId = "jobs-list", retainOpen = true } = {}) {
  const host = ui.byId(hostId);
  if (!host) return;
  let collection = collections.get(hostId);
  if (!collection) { collection = { cards: new Map(), empty: null }; collections.set(hostId, collection); }
  const { cards } = collection;
  const focus = host.contains(document.activeElement) ? document.activeElement : null;
  const scrollTop = host.scrollTop;
  const current = new Set();
  const ordered = [];
  for (const incoming of list) {
    const id = String(incoming.id);
    if (current.has(id)) continue;
    current.add(id);
    const card = cards.get(id) || createCard(id, cards, isAutomatic);
    const job = latestJob(card.job, incoming);
    const version = jobVersion(job);
    const changed = card.sourceVersion && card.sourceVersion !== version;
    if (changed) { cancelDetails(card); card.detail = null; }
    else if (job.result !== undefined && card.loading) cancelDetails(card);
    card.sourceVersion = version;
    let shown = job;
    if (job.result === undefined && card.detail) {
      if (Number(job.updated_at) <= Number(card.detail.updated_at) && job.state === card.detail.state) shown = { ...job, ...card.detail };
      else card.detail = null;
    }
    updateCard(card, shown, isAutomatic(shown));
    if (changed && card.node.open && job.result === undefined && !card.detail && !card.loading) void loadDetails(card, cards);
    ordered.push(card.node);
  }
  for (const [id, card] of cards) {
    if (current.has(id)) continue;
    // A task may fall outside the server's recent-job window while being read.
    if (retainOpen && (card.node.open || card.node.contains(focus))) {
      ordered.push(card.node);
      if (card.job?.state === "running" && !card.loading) void loadDetails(card, cards);
    }
    else { cancelDetails(card); card.node.remove(); cards.delete(id); }
  }
  if (ordered.length) collection.empty?.remove();
  else {
    collection.empty ||= ui.el("div", { class: "jobs-empty" }, [ui.icon("jobs", { size: 30 }),
      ui.el("strong", { text: "音乐正在好好收藏" }), ui.el("p", { text: "扫描、刮削和归档任务会显示在这里。" })]);
    host.append(collection.empty);
  }
  ordered.forEach((node, index) => {
    const at = host.children[index] || null;
    if (at !== node) {
      if (typeof host.moveBefore === "function" && node.parentNode === host) host.moveBefore(node, at);
      else host.insertBefore(node, at);
    }
  });
  if (focus?.isConnected && document.activeElement !== focus) focus.focus({ preventScroll: true });
  host.scrollTop = scrollTop;
}

export function clearJobs(hostId) {
  const collection = collections.get(hostId);
  if (!collection) return;
  for (const card of collection.cards.values()) cancelDetails(card);
  collection.cards.clear(); collections.delete(hostId); ui.byId(hostId)?.replaceChildren();
}

window.addEventListener("metatidy:unauthorized", () => { sessionRevision += 1; [...collections.keys()].forEach(clearJobs); });
