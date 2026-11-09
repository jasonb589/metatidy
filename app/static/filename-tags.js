/** A filename is a proposal; only a complete, immutable file-tag preview can be submitted. */
import { api } from "./api.js";
import * as ui from "./ui.js";
import * as auth from "./auth.js";
import { state, on, emit, selectionRevision } from "./store.js";

const LIMIT = 500;
const PAGE_SIZE = 50;
const FIELDS = ["track", "disc", "artist", "title", "album"];
const PARSE_STATES = ["matched", "ambiguous", "unmatched", "invalid", "index_missing"];
const PLAN_STATES = ["ready", "unchanged", "excluded", "ambiguous", "unmatched", "invalid", "index_missing", "unreadable", "pending", "writing", "written", "stale", "failed", "needs_verification", "not_started"];
const LABELS = {
  matched: "匹配", ambiguous: "有歧义", unmatched: "不匹配", invalid: "字段无效", index_missing: "索引缺失",
  ready: "将修改", unchanged: "无需变更", excluded: "本轮排除", unreadable: "无法读取",
  pending: "等待处理", writing: "正在写入", written: "已写入", stale: "文件已变化", failed: "失败", needs_verification: "需要核对", not_started: "未处理",
};
const ATTENTION = new Set(["ambiguous", "unmatched", "invalid", "index_missing", "unreadable", "stale", "failed", "needs_verification", "not_started"]);
const PRESETS = [
  ["{track} - {artist} - {title}", "轨号 - 艺术家 - 标题", "01 - 周杰伦 - 稻香.flac → 轨号 01 · 艺术家 周杰伦 · 标题 稻香"],
  ["{track} - {title}", "轨号 - 标题", "03 - 稻香.flac → 轨号 03 · 标题 稻香"],
  ["{artist} - {title}", "艺术家 - 标题", "周杰伦 - 稻香.flac → 艺术家 周杰伦 · 标题 稻香"],
  ["{title}", "整个文件名作为标题", "稻香.flac → 标题 稻香"],
];
const RECOVERY_KEY = "metatidy-filename-tags-recovery";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string";
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const opaque = value => text(value) && value.length > 0 && value.length <= 1024;
const fieldMap = value => object(value) && Object.entries(value).every(([key, value]) => FIELDS.includes(key) && text(value));
const focusable = node => node?.isConnected && node.getClientRects().length && !node.closest("[inert]") && !node.matches(":disabled");
let closeActive = null;
let accessBlocked = false;

function usable() {
  const session = auth.current();
  return !accessBlocked && (!session.required || session.authenticated) && !document.querySelector(".app-content")?.inert;
}

function invalidSnapshot() {
  const error = new Error("返回的逐曲结果不完整或不一致，请重新读取后再审阅。");
  error.code = "invalid_plan_snapshot";
  return error;
}

function checkItems(items, ids, statuses) {
  if (!Array.isArray(items) || items.length !== ids.length) throw invalidSnapshot();
  items.forEach((item, index) => {
    if (!object(item) || item.track_id !== ids[index] || !text(item.filename) || !text(item.path)
      || !statuses.includes(item.status) || !fieldMap(item.parsed_fields) || !(item.reason === null || text(item.reason))) throw invalidSnapshot();
  });
}

function checkCounts(counts, items, allowed) {
  if (!object(counts) || Object.entries(counts).some(([key, value]) => !allowed.includes(key) || !count(value))) throw invalidSnapshot();
  const actual = {};
  for (const item of items) actual[item.status] = (actual[item.status] || 0) + 1;
  if (allowed.some(key => (counts[key] || 0) !== (actual[key] || 0))) throw invalidSnapshot();
}

function validateAnalysis(data, ids, template) {
  if (!object(data) || !opaque(data.analysis_revision) || data.limit !== LIMIT || data.total !== ids.length || data.template !== template) throw invalidSnapshot();
  checkItems(data.items, ids, PARSE_STATES);
  checkCounts(data.counts, data.items, PARSE_STATES);
  if (data.items.some(item => item.status === "matched" && !Object.keys(item.parsed_fields).length)) throw invalidSnapshot();
  return data;
}

function planFingerprint(plan) {
  const ordered = value => Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, field]) => [key, object(field) ? ordered(field) : field]);
  return JSON.stringify([plan.token, plan.revision, plan.total, plan.included_total, plan.ready_total, plan.changed_fields, plan.template,
    plan.overwrite, plan.normalize_artist, plan.items.map(item => [item.track_id, item.filename, item.path, item.included,
      ...[item.parsed_fields, item.processed_fields, item.current, item.effective_fields, item.changes].map(ordered), item.skipped])]);
}

function validatePlan(data, expected = {}) {
  if (!object(data) || !opaque(data.token) || !opaque(data.revision) || !["ready", "running", "done", "error"].includes(data.state)
    || !count(data.total) || data.total < 1 || data.total > LIMIT || !count(data.included_total) || !count(data.ready_total) || !count(data.changed_fields)
    || !text(data.template) || typeof data.overwrite !== "boolean" || typeof data.normalize_artist !== "boolean"
    || !Number.isFinite(data.expires_at) || data.expires_at <= 0 || !(data.job_id === null || opaque(data.job_id))
    || !(data.request_id === null || opaque(data.request_id)) || !Array.isArray(data.items)) throw invalidSnapshot();
  const ids = expected.ids || data.items.map(item => item?.track_id);
  if (ids.length !== data.total || ids.some(id => !positiveId(id)) || new Set(ids).size !== ids.length) throw invalidSnapshot();
  checkItems(data.items, ids, PLAN_STATES);
  checkCounts(data.counts, data.items, PLAN_STATES);
  for (const item of data.items) {
    if (typeof item.included !== "boolean" || typeof item.file_changed !== "boolean" || !(item.stage === null || text(item.stage))
      || ![item.processed_fields, item.current, item.effective_fields].every(fieldMap) || !object(item.changes)
      || Object.entries(item.changes).some(([key, change]) => !FIELDS.includes(key) || !object(change) || !text(change.old) || !text(change.new))
      || !Array.isArray(item.skipped) || item.skipped.some(skip => !object(skip) || !FIELDS.includes(skip.field) || !text(skip.reason))
      || Object.entries(item.changes).some(([key, change]) => !Object.hasOwn(item.parsed_fields, key) || item.current[key] !== change.old || item.effective_fields[key] !== change.new)
      || Object.keys(item.effective_fields).some(key => !Object.hasOwn(item.parsed_fields, key))
      || item.status === "ready" && (!item.included || !Object.keys(item.changes).length)) throw invalidSnapshot();
  }
  const ready = data.items.filter(item => Object.keys(item.changes).length).length;
  const changed = data.items.reduce((sum, item) => sum + Object.keys(item.changes).length, 0);
  if (data.included_total !== data.items.filter(item => item.included).length || data.ready_total !== ready || data.changed_fields !== changed
    || expected.token && data.token !== expected.token || expected.revision && data.revision !== expected.revision
    || expected.template !== undefined && data.template !== expected.template
    || expected.overwrite !== undefined && data.overwrite !== expected.overwrite
    || expected.normalize_artist !== undefined && data.normalize_artist !== expected.normalize_artist
    || expected.include_ids && data.items.some(item => item.included !== expected.include_ids.has(item.track_id))
    || expected.analysis && data.items.some((item, index) => {
      const original = expected.analysis.items[index];
      return item.filename !== original.filename || item.path !== original.path
        || FIELDS.some(key => item.parsed_fields[key] !== original.parsed_fields[key]);
    })
    || expected.fingerprint && planFingerprint(data) !== expected.fingerprint) throw invalidSnapshot();
  return data;
}

function readRecovery() {
  try {
    const saved = JSON.parse(localStorage.getItem(RECOVERY_KEY) || "null");
    return object(saved) && opaque(saved.token) ? saved : null;
  } catch { return null; }
}

function updateRecoveryButton() {
  const button = ui.byId("jobs-filename-tags-resume");
  if (button) button.hidden = !readRecovery();
}

function saveRecovery(plan, requestId) {
  try { localStorage.setItem(RECOVERY_KEY, JSON.stringify({ token: plan.token, revision: plan.revision, request_id: requestId || plan.request_id })); } catch { /* Task history remains available. */ }
  updateRecoveryButton();
}

function clearRejectedRecovery(token) {
  try { if (readRecovery()?.token === token) localStorage.removeItem(RECOVERY_KEY); } catch { /* Storage is optional. */ }
  updateRecoveryButton();
}

export function initFilenameTagsRecovery() {
  const button = ui.byId("jobs-filename-tags-resume");
  if (button && !button.dataset.wired) {
    button.dataset.wired = "true";
    button.addEventListener("click", () => { const saved = readRecovery(); if (saved) emit("filename-tags:results", saved.token); });
  }
  updateRecoveryButton();
}

export function closeFilenameTags({ restoreFocus = false } = {}) { closeActive?.({ restoreFocus }); }

export function openFilenameTags(scope) { return openWorkflow({ scope }); }

export function openFilenameTagResults(token) {
  if (opaque(token)) return openWorkflow({ token });
}

function openWorkflow({ scope = null, token = null }) {
  if (!usable()) return;
  if (state.edit.open || state.edit.busy) { ui.toast("warn", "请先结束当前元数据编辑", "保存或关闭编辑器后，再进入文件名提取。"); return; }
  closeActive?.({ restoreFocus: false });
  if (document.querySelector("dialog[open]")) return;
  const opener = document.activeElement;
  const originTab = state.tab;
  const rows = scope?.rows?.map(row => ({ ...row })) || [];
  const ids = rows.map(row => row.id);
  const members = scope?.revision ?? selectionRevision();
  const invalidScope = !token && (!ids.length || ids.length > LIMIT || ids.some(id => !positiveId(id)) || new Set(ids).size !== ids.length);
  let closed = false, generation = 0, controller = null, pollTimer = 0, expiryTimer = 0;
  let analysis = null, plan = null, include = new Set(), page = 1, selectionStale = false;
  let sealed = Boolean(token), recoveryToken = token, requestId = null, refreshedLibrary = false;
  let phase = token ? "loading-results" : invalidScope ? "over-limit" : "template";
  let message = token ? "正在读取已保存的逐曲结果…" : invalidScope ? `本次选择 ${ui.fmtNum(ids.length)} 首。每批需选择 1–500 首，请缩小范围后重新进入。`
    : scope?.recheck ? "本轮仅包含上次未完成或需要核对的曲目。重新分析后读取文件现状，成功项不会再次纳入；所有写入仍需新的明确确认。"
      : "先分析文件名，再读取真实标签形成预览。";
  const cards = new Map();

  const dialog = ui.el("dialog", { id: "filename-tags-dialog", class: "filename-tags", "aria-labelledby": "filename-tags-title", "aria-describedby": "filename-tags-description" });
  const title = ui.el("h2", { id: "filename-tags-title", tabindex: "-1", text: token ? "标签提取结果" : "从文件名提取标签" });
  const description = ui.el("p", { id: "filename-tags-description", text: token ? "按本次操作的原始顺序查看全部结果" : `本轮 ${ui.fmtNum(ids.length)} 首 · 按已选顺序 · 最多 500 首` });
  const closeButton = ui.el("button", { id: "filename-tags-close", type: "button", class: "btn btn-ghost ft-close", "aria-label": "关闭文件名提取", onClick: () => close() }, [ui.icon("close", { size: 18 })]);
  const steps = ui.el("ol", { class: "ft-steps", "aria-label": "处理步骤" }, ["选择格式", "解析审阅", "真实标签预览", "写入结果"].map((label, index) => ui.el("li", { dataset: { step: index }, text: `${index + 1} ${label}` })));
  const preset = ui.el("select", { id: "filename-tags-preset", "aria-label": "文件名格式预设" }, [
    ...PRESETS.map(([value, label]) => ui.el("option", { value, text: label })), ui.el("option", { value: "custom", text: "自定义格式" }),
  ]);
  const template = ui.el("input", { id: "filename-tags-template", type: "text", maxlength: "500", autocomplete: "off", spellcheck: "false", value: scope?.recheck && text(scope.template) ? scope.template : PRESETS[0][0], "aria-describedby": "filename-tags-template-note" });
  preset.value = PRESETS.some(([value]) => value === template.value) ? template.value : "custom";
  const example = ui.el("p", { id: "filename-tags-example", class: "ft-example" });
  const firstName = rows[0]?.filename || rows[0]?.path?.split(/[\\/]/).pop() || "";
  const setup = ui.el("section", { class: "ft-setup", "aria-label": "文件名提取格式" }, [
    ui.el("div", { class: "ft-template-heading" }, [ui.el("label", { for: "filename-tags-template", text: "文件名格式" }), preset]), template,
    ui.el("p", { id: "filename-tags-template-note", class: "ft-note", text: "支持 {track}、{disc}、{artist}、{title}、{album}，每个字段最多一次。分隔符和空格按原样匹配，只去掉最后一个扩展名。" }), example,
    ui.el("p", { class: "ft-source-example", title: firstName, text: firstName ? `本轮首个文件：${firstName}` : "" }),
  ]);
  const overwrite = ui.el("input", { id: "filename-tags-overwrite", type: "checkbox" });
  const normalize = ui.el("input", { id: "filename-tags-normalize", type: "checkbox" });
  const policy = ui.el("p", { class: "ft-policy", text: "默认仅补文件标签中的空值。已有值将保留；歌词、封面和其他字段不在本次提取范围内。" });
  const options = ui.el("section", { class: "ft-options", "aria-label": "写入规则" }, [
    ui.el("div", { class: "ft-option-row" }, [ui.el("label", { class: "ft-check" }, [overwrite, "覆盖已有标签值"]), ui.el("label", { class: "ft-check" }, [normalize, "规范化艺术家名称"])]), policy,
  ]);
  const status = ui.el("p", { id: "filename-tags-status", class: "ft-status", role: "status", "aria-live": "polite", "aria-atomic": "true" });
  const counts = ui.el("dl", { id: "filename-tags-counts", class: "ft-counts", hidden: true });
  const search = ui.el("input", { id: "filename-tags-search", type: "search", maxlength: "500", autocomplete: "off", placeholder: "搜索文件名、路径或提取字段…", "aria-label": "搜索本轮曲目" });
  const filter = ui.el("select", { id: "filename-tags-filter", "aria-label": "按处理状态查看" }, [ui.el("option", { value: "", text: "全部状态" }), ...Object.entries(LABELS).map(([value, label]) => ui.el("option", { value, text: label }))]);
  const excludeAll = ui.el("button", { id: "filename-tags-exclude-all", type: "button", class: "btn btn-sm btn-ghost", text: "排除全部", onClick: () => changeInclude(new Set()) });
  const includeReady = ui.el("button", { id: "filename-tags-include-ready", type: "button", class: "btn btn-sm", text: "纳入全部匹配项", onClick: () => changeInclude(new Set(analysis?.items.filter(item => item.status === "matched").map(item => item.track_id) || [])) });
  const rangeNote = ui.el("p", { class: "ft-note", text: "搜索与分页仅影响查看；排除仅影响本轮，不移除全局选择。" });
  const tools = ui.el("div", { class: "ft-review-tools", hidden: true }, [ui.el("div", { class: "ft-find" }, [search, filter]), ui.el("div", { class: "ft-inclusion" }, [rangeNote, excludeAll, includeReady])]);
  const list = ui.el("div", { id: "filename-tags-list", class: "ft-list", "aria-label": "本轮完整逐曲结果" });
  const range = ui.el("span", { id: "filename-tags-range" });
  const previous = ui.el("button", { id: "filename-tags-prev", type: "button", class: "btn btn-sm", text: "上一页", onClick: () => changePage(-1) });
  const next = ui.el("button", { id: "filename-tags-next", type: "button", class: "btn btn-sm", text: "下一页", onClick: () => changePage(1) });
  const pageLabel = ui.el("span", { id: "filename-tags-page" });
  const pager = ui.el("nav", { class: "ft-pager", "aria-label": "提取结果分页", hidden: true }, [range, ui.el("div", { class: "spacer" }), previous, pageLabel, next]);
  const resultMessage = ui.el("p", { id: "filename-tags-results", class: "ft-results", hidden: true });
  const body = ui.el("div", { class: "ft-body" }, [setup, options, status, counts, resultMessage, tools, list, pager]);
  const summary = ui.el("p", { id: "filename-tags-summary", class: "ft-summary" });
  const cancel = ui.el("button", { id: "filename-tags-cancel", type: "button", class: "btn btn-ghost", text: "取消", onClick: cancelOrClose });
  const analyze = ui.el("button", { id: "filename-tags-analyze", type: "button", class: "btn btn-primary", text: "分析文件名", onClick: () => void analyzeNames() });
  const preview = ui.el("button", { id: "filename-tags-preview", type: "button", class: "btn btn-primary", hidden: true, onClick: () => void previewTags() });
  const confirm = ui.el("button", { id: "filename-tags-confirm", type: "button", class: "btn btn-primary", hidden: true, onClick: () => void submit() });
  const retry = ui.el("button", { id: "filename-tags-retry", type: "button", class: "btn", hidden: true, onClick: () => void (sealed ? loadResults() : analysis ? previewTags() : analyzeNames()) });
  const recheck = ui.el("button", { id: "filename-tags-recheck", type: "button", class: "btn", hidden: true, onClick: recheckUnfinished });
  const job = ui.el("button", { id: "filename-tags-job", type: "button", class: "btn", text: "查看任务中心", hidden: true, onClick: () => {
    close({ restoreFocus: false });
    if (usable()) ui.byId("btn-jobs")?.click();
  } });
  dialog.append(ui.el("header", { class: "ft-head" }, [ui.el("span", { class: "ft-mark", "aria-hidden": "true" }, [ui.icon("edit", { size: 22 })]), ui.el("div", { class: "ft-heading" }, [ui.el("p", { class: "eyebrow", text: "FILENAME TO TAGS" }), title, description]), closeButton]), steps, body,
    ui.el("footer", { class: "ft-foot" }, [summary, ui.el("div", { class: "ft-actions" }, [cancel, retry, recheck, analyze, preview, confirm, job])]));

  function stopRequest() {
    generation += 1; controller?.abort(); controller = null;
    clearTimeout(pollTimer); clearTimeout(expiryTimer); pollTimer = 0; expiryTimer = 0;
  }

  function signature() { return JSON.stringify([template.value, overwrite.checked, normalize.checked, [...include]]); }

  function guard(request = generation, expected = null) {
    if (closed || request !== generation) return false;
    if (!dialog.open || !dialog.isConnected || !usable() || state.tab !== originTab) { close({ restoreFocus: false }); return false; }
    if (!sealed && members !== selectionRevision()) { invalidateSelection(); return false; }
    if (!sealed && expected !== null && expected !== signature()) { invalidatePreview("选项已变化，请重新读取标签并预览。"); return false; }
    return !selectionStale || sealed;
  }

  function setPhase(nextPhase, nextMessage) {
    phase = nextPhase; message = nextMessage; render();
  }

  function invalidateSelection() {
    if (closed || sealed || selectionStale) return;
    selectionStale = true; stopRequest(); analysis = null; plan = null; include.clear();
    setPhase("stale", "已选曲目发生变化，本轮结果已作废。请关闭后重新审阅选择。");
  }

  function invalidatePreview(note) {
    if (closed || sealed) return;
    stopRequest(); plan = null;
    setPhase(analysis ? "analysis-ready" : "template", note);
  }

  function changeTemplate() {
    if (closed || sealed || selectionStale) return;
    stopRequest(); analysis = null; plan = null; include.clear(); page = 1;
    preset.value = PRESETS.some(([value]) => value === template.value) ? template.value : "custom";
    setPhase("template", "格式已变化，请重新分析文件名。");
  }

  function changeInclude(nextIds) {
    if (!guard() || sealed || !analysis || ["analyzing", "previewing"].includes(phase)) return;
    include = nextIds;
    invalidatePreview("纳入范围已变化，请重新读取标签并预览。");
  }

  function cancelOrClose() {
    if (["analyzing", "previewing"].includes(phase)) {
      stopRequest(); plan = null;
      setPhase(analysis ? "analysis-ready" : "template", "本次读取已取消，未提交任何写入。");
      return;
    }
    close();
  }

  function planExpectation() {
    return { ids, template: template.value, overwrite: overwrite.checked, normalize_artist: normalize.checked, include_ids: new Set(include), analysis };
  }

  async function analyzeNames() {
    if (!guard() || invalidScope || sealed || !template.value || ["analyzing", "previewing"].includes(phase)) return;
    stopRequest(); analysis = null; plan = null; include.clear(); page = 1;
    const request = generation, format = template.value, expected = signature();
    controller = new AbortController();
    setPhase("analyzing", "正在分析全部文件名，仅查询索引，不读取音频、封面或歌词…");
    if (!guard(request, expected)) return;
    try {
      const data = await api.filenameTagsParse({ ids: [...ids], template: format }, { signal: controller.signal });
      if (!guard(request, expected)) return;
      analysis = validateAnalysis(data, ids, format);
      include = new Set(analysis.items.filter(item => item.status === "matched").map(item => item.track_id));
      setPhase("analysis-ready", `已分析全部 ${ui.fmtNum(ids.length)} 首，匹配 ${ui.fmtNum(include.size)} 首。请审阅提取字段，再读取文件中的真实标签。`);
    } catch (error) { if (guard(request, expected)) showError(error, "文件名分析失败"); }
    finally { if (request === generation) controller = null; }
  }

  async function previewTags() {
    if (!guard() || sealed || !analysis || !include.size || ["analyzing", "previewing"].includes(phase)) return;
    stopRequest(); plan = null;
    const request = generation, expected = signature(), expectation = planExpectation();
    controller = new AbortController();
    setPhase("previewing", `正在读取 ${ui.fmtNum(include.size)} 首的真实标签，云盘可能需要一些时间。读取完成后才生成确认计划。`);
    if (!guard(request, expected)) return;
    try {
      const data = await api.filenameTagsPreview({ ids: [...ids], template: expectation.template, analysis_revision: analysis.analysis_revision,
        include_ids: ids.filter(id => include.has(id)), overwrite: expectation.overwrite, normalize_artist: expectation.normalize_artist }, { signal: controller.signal });
      if (!guard(request, expected)) return;
      const validated = validatePlan(data, expectation);
      if (validated.state !== "ready" || validated.job_id !== null || validated.request_id !== null) throw invalidSnapshot();
      plan = validated;
      setPhase("preview-ready", plan.ready_total ? "真实标签预览已完成。请核对每首的当前值和将写入值，确认后才会修改文件。" : "预览已完成，按当前规则没有需要写入的变更。可查看保留原因或调整范围后重新预览。");
      scheduleExpiry();
    } catch (error) { if (guard(request, expected)) showError(error, "真实标签预览失败"); }
    finally { if (request === generation) controller = null; }
  }

  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    if (!plan || sealed) return;
    const remaining = plan.expires_at * 1000 - Date.now();
    if (remaining <= 0) { plan = null; setPhase("stale", "预览计划已过期，请重新读取标签并预览。"); return; }
    expiryTimer = setTimeout(() => { if (!closed && !sealed) { plan = null; setPhase("stale", "预览计划已过期，请重新读取标签并预览。"); } }, Math.min(remaining + 20, 2147483647));
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  async function submit() {
    if (phase !== "preview-ready" || !plan || !plan.ready_total || !guard()) return;
    if (plan.expires_at * 1000 <= Date.now()) { scheduleExpiry(); return; }
    try { validatePlan(plan, planExpectation()); } catch (error) { showError(error, "无法确认这份计划"); return; }
    const confirmed = plan;
    stopRequest(); const request = generation, expected = signature();
    controller = new AbortController();
    phase = "submitting"; message = "正在提交已审阅的计划。提交后关闭界面不会撤销后台写入。"; render();
    // Rendering can move focus and synchronously trigger navigation or selection changes.
    if (!guard(request, expected)) return;
    requestId = uuid(); recoveryToken = confirmed.token;
    saveRecovery(confirmed, requestId);
    sealed = true;
    try {
      const data = await api.filenameTagsApply({ token: confirmed.token, revision: confirmed.revision, request_id: requestId }, { signal: controller.signal });
      if (!guard(request)) return;
      if (!object(data) || data.token !== confirmed.token || data.revision !== confirmed.revision || !opaque(data.job_id) || !["running", "done", "error"].includes(data.state)) throw invalidSnapshot();
      plan = { ...confirmed, job_id: data.job_id, request_id: requestId };
      emit("jobs:refresh");
      setPhase("submitted", "任务已提交。关闭界面不会停止写入；可随时从任务中心查看全部逐曲结果。");
      void loadResults();
    } catch (error) {
      if (!guard(request)) return;
      if (error.status === 401) { close({ restoreFocus: false }); return; }
      if (error.status >= 400 && error.status < 500 && ["plan_missing", "plan_changed", "plan_expired", "invalid_plan_snapshot", "no_changes", "queue_full", "request_id_reused"].includes(error.code)) {
        sealed = false; requestId = null; recoveryToken = null; plan = null;
        clearRejectedRecovery(confirmed.token);
        if (members !== selectionRevision()) { invalidateSelection(); return; }
        setPhase("stale", `服务器未接受本次提交：${error.message}。请重新读取标签并预览后确认。`);
        return;
      }
      setPhase("submission-unknown", `暂时无法确认提交结果：${error.message}。请读取已保存状态，不要重复提交。`);
      emit("jobs:refresh");
    } finally { if (request === generation) { controller = null; render(); } }
  }

  async function loadResults() {
    if (!recoveryToken || !guard() || phase === "submitting") return;
    stopRequest(); const request = generation;
    const expected = { token: recoveryToken, ...(plan ? { revision: plan.revision, fingerprint: planFingerprint(plan) } : {}) };
    controller = new AbortController();
    if (!plan) setPhase("loading-results", "正在读取服务器保存的完整逐曲结果…");
    else { status.setAttribute("aria-busy", "true"); retry.disabled = true; }
    try {
      const data = await api.filenameTagsPlan(recoveryToken, { signal: controller.signal });
      if (!guard(request)) return;
      plan = validatePlan(data, expected);
      template.value = plan.template; overwrite.checked = plan.overwrite; normalize.checked = plan.normalize_artist;
      include = new Set(plan.items.filter(item => item.included).map(item => item.track_id));
      description.textContent = `本轮 ${ui.fmtNum(plan.total)} 首 · 原始顺序 · 完整逐曲结果`;
      saveRecovery(plan, requestId);
      if (plan.state === "ready") {
        setPhase("submission-unknown", "这份计划尚未记录已提交任务。此处只查询状态，不会重新写入；若刚才断线，可稍后再次读取。重新操作前请核对文件现状。");
      } else {
        setPhase(plan.state === "running" ? "submitted" : "results", plan.state === "running"
          ? "任务正在后台处理。以下显示已保存进度，关闭界面不会停止写入。"
          : "本次处理已结束。逐曲结果已保存；失败、已变化或需要核对的曲目不会自动重试。");
        if (plan.state !== "running" && !refreshedLibrary) { refreshedLibrary = true; emit("jobs:refresh"); emit("status:refresh"); emit("tracks:refresh"); }
      }
      if (plan.state === "running") pollTimer = setTimeout(() => { if (document.visibilityState === "hidden") { pollTimer = setTimeout(() => void loadResults(), 3000); } else void loadResults(); }, 2000);
    } catch (error) {
      if (guard(request)) setPhase("results-error", `结果读取失败：${error.message}。现有显示是上次读取的记录；可重新读取，不会重新提交写入。`);
    } finally { if (request === generation) { controller = null; render(); } }
  }

  function unfinishedItems() {
    if (!plan || !["done", "error"].includes(plan.state)) return [];
    return plan.items.filter(item => item.included && ["unreadable", "stale", "failed", "needs_verification", "not_started"].includes(item.status));
  }

  function recheckUnfinished() {
    if (!sealed || phase !== "results" || !guard()) return;
    const unfinished = unfinishedItems();
    if (!unfinished.length) return;
    const nextScope = { rows: unfinished.map(item => ({ id: item.track_id, filename: item.filename, path: item.path })), revision: selectionRevision(), template: plan.template, recheck: true };
    close({ restoreFocus: false });
    // Native dialog focus restoration may synchronously change application state.
    if (usable() && state.tab === originTab && nextScope.revision === selectionRevision()) openFilenameTags(nextScope);
  }

  function showError(error, prefix) {
    if (error.status === 401) { close({ restoreFocus: false }); return; }
    plan = null;
    if (error.code === "analysis_changed") { analysis = null; include.clear(); setPhase("stale", "文件名或索引已变化，请重新分析后审阅。"); return; }
    if (["plan_expired", "plan_changed"].includes(error.code)) { setPhase("stale", "预览计划已变化或过期，请重新读取标签并预览。"); return; }
    setPhase("error", `${prefix}：${error.message}`);
  }

  function itemsForDisplay() {
    if (plan) return plan.items;
    return (analysis?.items || []).map(item => ({ ...item, status: item.status === "matched" && !include.has(item.track_id) ? "excluded" : item.status }));
  }

  function matching() {
    const needle = search.value.trim().toLocaleLowerCase();
    return itemsForDisplay().filter(item => (!filter.value || item.status === filter.value) && (!needle || [item.track_id, item.filename, item.path,
      ...Object.values(item.parsed_fields), ...Object.values(item.processed_fields || {}), item.reason, LABELS[item.status]].some(value => String(value ?? "").toLocaleLowerCase().includes(needle))));
  }

  function drawCounts() {
    const items = itemsForDisplay(); counts.hidden = !items.length;
    const attention = items.filter(item => ATTENTION.has(item.status)).length;
    const values = sealed ? [["total", "本轮全部", items.length], ["written", "已写入", items.filter(item => item.status === "written").length], ["unchanged", "无需变更 / 排除", items.filter(item => ["unchanged", "excluded"].includes(item.status)).length], ["attention", "需留意", attention]]
      : plan ? [["total", "本轮全部", items.length], ["ready", "将修改", plan.ready_total], ["unchanged", "无需变更", items.filter(item => item.status === "unchanged").length], ["excluded", "排除 / 无法处理", items.filter(item => item.status === "excluded" || ATTENTION.has(item.status)).length]]
        : [["total", "本轮全部", items.length], ["matched", "纳入匹配项", include.size], ["attention", "无法唯一提取", attention], ["excluded", "本轮排除", items.filter(item => item.status === "excluded").length]];
    counts.replaceChildren(...values.map(([key, label, value]) => ui.el("div", { class: `ft-count ft-count-${key}` }, [ui.el("dt", { text: label }), ui.el("dd", { id: `filename-tags-count-${key}`, text: ui.fmtNum(value) })])));
  }

  function createCard(id) {
    const number = ui.el("span", { class: "ft-track-number" });
    const name = ui.el("strong", { class: "ft-track-name" });
    const path = ui.el("span", { class: "ft-track-path" });
    const badge = ui.el("span", { class: "badge" });
    const checkbox = ui.el("input", { type: "checkbox", dataset: { includeId: id }, onChange: () => {
      const changed = new Set(include); if (checkbox.checked) changed.add(id); else changed.delete(id); changeInclude(changed);
    } });
    const choice = ui.el("label", { class: "ft-track-choice" }, [checkbox, "纳入"]);
    const fields = ui.el("div", { class: "ft-track-fields" });
    const reason = ui.el("p", { class: "ft-track-reason" });
    const node = ui.el("article", { class: "ft-track", dataset: { trackId: id } }, [ui.el("header", { class: "ft-track-head" }, [number, ui.el("div", { class: "ft-track-copy" }, [name, path]), ui.el("div", { class: "ft-track-actions" }, [badge, choice])]), fields, reason]);
    return { node, number, name, path, badge, checkbox, choice, fields, reason, fingerprint: "" };
  }

  function fieldDetails(item) {
    if (!hasFilePreview(item)) {
      return Object.entries(item.parsed_fields).map(([key, value]) => ui.el("span", { class: "ft-field-chip", title: value }, [ui.el("span", { text: ui.fieldLabel(key) }), ui.el("strong", { text: value })]));
    }
    return FIELDS.filter(key => Object.hasOwn(item.parsed_fields, key)).map(key => {
      const change = item.changes[key], parsed = item.parsed_fields[key], processed = item.processed_fields[key];
      const current = item.current[key], skipped = item.skipped.find(skip => skip.field === key);
      const value = (label, content, className = "") => ui.el("div", { class: `ft-field-value ${className}` }, [ui.el("span", { text: label }), ui.el("strong", { text: content || "（空）", title: content || "（空）" })]);
      return ui.el("div", { class: `ft-field-row${change ? " is-changed" : ""}`, dataset: { field: key } }, [
        ui.el("span", { class: "ft-field-label", text: ui.fieldLabel(key) }), value("提取原文", parsed),
        value(sealed ? "预览时的文件值" : "文件现值", current, change ? "ft-old" : ""),
        value(change ? sealed ? item.status === "written" ? "已写入" : "计划写入" : "将写入" : "保留", change?.new ?? current, change ? "ft-new" : ""),
        ui.el("p", { class: "ft-field-reason", text: [processed !== undefined && processed !== parsed ? `处理后候选：${processed}` : "", skipped ? `${ui.skipReasonLabel(skipped.reason)}${skipped.detail ? ` · ${skipped.detail}` : ""}` : change ? "此字段纳入计划" : "未形成有效变更"].filter(Boolean).join(" · ") }),
      ]);
    });
  }

  function hasFilePreview(item) {
    return Boolean(plan && item.included && item.status !== "unreadable" && Object.keys(item.current || {}).length);
  }

  function drawList() {
    const filtered = matching(), pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)); page = Math.min(Math.max(1, page), pages);
    const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), visibleIds = new Set(visible.map(item => item.track_id));
    const scroll = body.scrollTop;
    for (const [id, card] of cards) if (!visibleIds.has(id)) { card.node.remove(); cards.delete(id); }
    list.querySelector(".ft-empty")?.remove();
    visible.forEach((item, index) => {
      const card = cards.get(item.track_id) || createCard(item.track_id); cards.set(item.track_id, card);
      const all = plan?.items || analysis.items;
      card.number.textContent = String(all.findIndex(row => row.track_id === item.track_id) + 1).padStart(2, "0");
      card.name.textContent = item.filename || `曲目 #${item.track_id}`; card.name.title = card.name.textContent;
      card.path.textContent = item.path || "没有索引路径"; card.path.title = card.path.textContent;
      card.badge.textContent = LABELS[item.status]; card.badge.className = `badge ${ATTENTION.has(item.status) ? "badge-warn" : ["ready", "matched", "written"].includes(item.status) ? "badge-ok" : "badge-mute"}`;
      card.node.dataset.status = item.status;
      card.checkbox.checked = include.has(item.track_id);
      card.choice.hidden = sealed;
      const matched = analysis?.items.find(row => row.track_id === item.track_id)?.status === "matched";
      card.checkbox.disabled = !matched || ["analyzing", "previewing", "submitting"].includes(phase) || selectionStale;
      card.checkbox.setAttribute("aria-label", `纳入 ${item.filename || `曲目 #${item.track_id}`}`);
      const fingerprint = JSON.stringify([item, Boolean(plan), sealed]);
      if (fingerprint !== card.fingerprint) { card.fields.replaceChildren(...fieldDetails(item)); card.fingerprint = fingerprint; }
      card.fields.classList.toggle("ft-field-chips", !hasFilePreview(item));
      card.reason.textContent = [item.reason, item.stage ? `处理阶段：${({ read: "读取", write: "写入", verify: "核验", index: "更新索引" })[item.stage] || item.stage}` : "", item.file_changed && item.status !== "written" ? "文件可能已发生变化，请核对后重新预览。" : ""].filter(Boolean).join(" · ");
      card.reason.hidden = !card.reason.textContent;
      const at = list.children[index] || null;
      if (at !== card.node) { if (typeof list.moveBefore === "function" && card.node.parentNode === list) list.moveBefore(card.node, at); else list.insertBefore(card.node, at); }
    });
    if (!visible.length && (analysis || plan)) list.append(ui.el("p", { class: "ft-empty", text: "没有符合当前搜索与状态的曲目，清空条件可查看全部结果。" }));
    tools.hidden = !analysis && !plan; pager.hidden = !analysis && !plan;
    previous.disabled = page <= 1; next.disabled = page >= pages; pageLabel.textContent = `${page} / ${pages}`;
    range.textContent = filtered.length ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, filtered.length)} / ${ui.fmtNum(filtered.length)} 首` : "0 首";
    body.scrollTop = scroll;
  }

  function changePage(delta) {
    page += delta; drawList();
    list.scrollIntoView({ block: "start", behavior: "instant" });
    const button = delta > 0 ? next : previous; (button.disabled ? search : button).focus({ preventScroll: true });
  }

  function render() {
    if (closed) return;
    const focused = document.activeElement;
    dialog.dataset.phase = phase; dialog.dataset.sealed = String(sealed);
    status.textContent = message; status.setAttribute("aria-busy", String(["analyzing", "previewing", "submitting", "loading-results"].includes(phase)));
    const busy = ["analyzing", "previewing", "submitting", "loading-results"].includes(phase);
    const locked = sealed || busy || selectionStale || invalidScope;
    template.disabled = locked; preset.disabled = locked; overwrite.disabled = locked; normalize.disabled = locked;
    setup.hidden = sealed; options.hidden = sealed;
    const examplePreset = PRESETS.find(([value]) => value === template.value);
    example.textContent = examplePreset?.[2] || "自定义格式会在分析后显示提取结果。字段之间须有明确分隔符；多个合理拆分会标为歧义。";
    policy.textContent = overwrite.checked ? "已开启覆盖。文件中已有值也可能被替换；请重新预览并逐项核对。" : "仅补文件标签中的空值，保留已有值。歌词、封面和其他字段不在本次提取范围内。";
    options.dataset.overwrite = String(overwrite.checked);
    const step = sealed ? 3 : plan ? 2 : analysis ? 1 : 0;
    for (const node of steps.children) { const active = Number(node.dataset.step) === step; node.dataset.active = String(active); if (active) node.setAttribute("aria-current", "step"); else node.removeAttribute("aria-current"); }
    analyze.hidden = sealed || Boolean(analysis) || selectionStale || invalidScope;
    analyze.disabled = busy || !template.value; analyze.textContent = phase === "analyzing" ? "正在分析文件名…" : "分析文件名";
    preview.hidden = sealed || !analysis || selectionStale || Boolean(plan?.ready_total && phase === "preview-ready");
    preview.disabled = busy || !include.size;
    preview.textContent = phase === "previewing" ? "正在读取标签…" : plan ? "重新读取标签并预览" : `读取标签并预览 ${ui.fmtNum(include.size)} 首`;
    confirm.hidden = sealed || phase !== "preview-ready" || !plan?.ready_total;
    confirm.disabled = phase !== "preview-ready" || !plan?.ready_total;
    confirm.textContent = `确认写入 ${ui.fmtNum(plan?.ready_total || 0)} 首`;
    retry.hidden = !["error", "stale", "submission-unknown", "results-error", "results"].includes(phase) || selectionStale || invalidScope;
    retry.disabled = busy || Boolean(controller && sealed);
    retry.textContent = sealed ? "重新读取已保存状态" : analysis ? "重新读取标签并预览" : "重新分析文件名";
    const unfinished = unfinishedItems();
    recheck.hidden = phase !== "results" || !sealed || !unfinished.length;
    recheck.disabled = Boolean(controller);
    recheck.textContent = `核对未完成曲目 ${ui.fmtNum(unfinished.length)} 首`;
    if (!retry.hidden && !sealed) { analyze.hidden = true; preview.hidden = true; }
    cancel.textContent = ["analyzing", "previewing"].includes(phase) ? "取消读取" : sealed || phase === "submitting" ? "关闭界面" : "取消";
    job.hidden = !sealed || !plan?.job_id;
    excludeAll.hidden = sealed; includeReady.hidden = sealed;
    excludeAll.disabled = busy || !include.size || selectionStale;
    includeReady.disabled = busy || !analysis?.items.some(item => item.status === "matched" && !include.has(item.track_id)) || selectionStale;
    rangeNote.textContent = sealed ? "搜索与分页仅影响查看，以下保留完整操作范围和原始顺序。" : "搜索与分页仅影响查看；排除仅影响本轮，不移除全局选择。";
    if (sealed) summary.textContent = "提交后关闭界面不会撤销写入。失败或结果未知的曲目需核对并重新预览。";
    else if (plan) summary.textContent = `${overwrite.checked ? "覆盖模式 · " : "仅补空值 · "}将修改 ${ui.fmtNum(plan.ready_total)} 首、${ui.fmtNum(plan.changed_fields)} 处字段；保留 ${ui.fmtNum(plan.counts.unchanged || 0)} 首，排除 ${ui.fmtNum(plan.counts.excluded || 0)} 首。`;
    else if (analysis) summary.textContent = `本轮纳入 ${ui.fmtNum(include.size)} / ${ui.fmtNum(ids.length)} 首。读取标签后会显示真实差异，尚未写入。`;
    else summary.textContent = "分析只使用文件名。真实标签预览完成后，才可确认写入。";
    resultMessage.hidden = !sealed || !plan;
    if (plan && sealed) resultMessage.textContent = `计划变更 ${ui.fmtNum(plan.ready_total)} 首、${ui.fmtNum(plan.changed_fields)} 处字段。${plan.state === "ready" ? "尚未确认任务是否提交。" : plan.state === "running" ? "正在处理，其余状态会随保存结果更新。" : "已结束，完整结果均可分页查看。"}`;
    drawCounts(); drawList();
    if (focused && dialog.contains(focused) && !focusable(focused) && dialog.open) (focusable(retry) ? retry : cancel).focus({ preventScroll: true });
  }

  template.addEventListener("input", changeTemplate);
  preset.addEventListener("change", () => { if (preset.value !== "custom") template.value = preset.value; changeTemplate(); template.focus({ preventScroll: true }); });
  for (const input of [overwrite, normalize]) input.addEventListener("change", () => invalidatePreview("写入规则已变化，请重新读取标签并预览。"));
  search.addEventListener("input", () => { page = 1; drawList(); });
  filter.addEventListener("change", () => { page = 1; drawList(); });
  const unsubscribe = on("selection:changed", () => { if (members !== selectionRevision()) invalidateSelection(); });
  const leave = () => close({ restoreFocus: false });
  for (const name of ["metatidy:unauthorized", "metatidy:logout", "hashchange"]) window.addEventListener(name, leave);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("close", () => close());
  dialog.addEventListener("keydown", event => {
    if (event.key === "Escape") event.stopPropagation();
    if (event.key !== "Tab") return;
    const inputs = [...dialog.querySelectorAll("button,input,select,[tabindex]")].filter(node => node.tabIndex >= 0 && focusable(node));
    const first = inputs[0], last = inputs.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === title)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  const observer = new MutationObserver(() => { if (!closed && !dialog.isConnected) close({ restoreFocus: false }); });
  function close({ restoreFocus = true } = {}) {
    if (closed) return;
    closed = true; stopRequest(); unsubscribe(); observer.disconnect(); analysis = null; plan = null; include.clear(); cards.clear();
    for (const name of ["metatidy:unauthorized", "metatidy:logout", "hashchange"]) window.removeEventListener(name, leave);
    if (closeActive === close) closeActive = null;
    if (dialog.open) dialog.close(); dialog.remove();
    if (restoreFocus && usable()) [opener, ui.byId("selection-review"), ui.byId("batch-review-selection"), ui.byId("btn-jobs"), ui.byId("tracks-q")].find(focusable)?.focus({ preventScroll: true });
  }
  closeActive = close;
  document.body.append(dialog); render(); dialog.showModal(); title.focus({ preventScroll: true });
  observer.observe(document.body, { childList: true });
  if (!sealed && members !== selectionRevision()) invalidateSelection();
  if (token) void loadResults();
  return dialog;
}

for (const event of ["metatidy:unauthorized", "metatidy:logout"]) window.addEventListener(event, () => { accessBlocked = true; closeFilenameTags(); });
window.addEventListener("metatidy:authenticated", () => { accessBlocked = false; updateRecoveryButton(); });
