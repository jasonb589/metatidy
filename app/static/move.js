/**
 * 页签 3：整理移动。
 *
 * 流程严格按后端设计：预览计划（只算不动，落库换 token）→ 仅演练（干跑，绝不动文件）
 * 或 确认执行（二次确认 → 后台任务 → 轮询进度 → 成功/跳过/失败汇总，失败清单必须列出）。
 * 目标越出库根目录的条目后端会标成 invalid，界面照样展示但明确写清不会执行。
 */

import { api, pollJob, movePlanExportUrl } from "./api.js";
import * as ui from "./ui.js";
import { state, on, emit, selectionIds, selectionCount } from "./store.js";

const ACTION_META = {
  move: { label: "移动", variant: "badge-accent" },
  in_place: { label: "已在目标位置", variant: "badge-mute" },
  conflict_rename: { label: "改名避让", variant: "badge-warn" },
  conflict_skip: { label: "跳过（目标已存在）", variant: "badge-mute" },
  conflict_overwrite: { label: "覆盖目标", variant: "badge-err" },
  invalid: { label: "无效（不执行）", variant: "badge-err" },
};

const ACTION_ORDER = ["move", "conflict_rename", "conflict_overwrite", "conflict_skip", "in_place", "invalid"];
const POLICY_LABELS = { rename: "冲突时改名避让", skip: "冲突时跳过", overwrite: "冲突时覆盖目标" };

let nodes = null;
let lastFocusedTemplate = null;
let planContext = null;
let operation = null;
let previewRevision = 0;
let configRevision = 0;
let listRevision = 0;
let listController = null;
let sessionUsable = true;
let searchLater = null;
let templateTouched = false;
let templateRevision = 0;
const view = { q: "", action: "", page: 1, page_size: 100, pages: 0, filtered: 0, items: [], loading: false, error: "" };

export function init() {
  nodes = {
    dir: ui.byId("move-dir"),
    filename: ui.byId("move-filename"),
    tokens: ui.byId("move-tokens"),
    testBtn: ui.byId("btn-tpl-test"),
    sample: ui.byId("tpl-sample"),
    tplResult: ui.byId("tpl-result"),
    root: ui.byId("move-root"),
    conflict: ui.byId("move-conflict"),
    limit: ui.byId("move-limit"),
    scopeHint: ui.byId("move-scope-hint"),
    scopeSelectedLabel: ui.byId("move-scope-selected-label"),
    previewBtn: ui.byId("btn-move-preview"),
    dryBtn: ui.byId("btn-move-dry"),
    execBtn: ui.byId("btn-move-exec"),
    progress: ui.byId("move-progress"),
    planned: ui.byId("move-planned"),
    counts: ui.byId("move-counts"),
    filters: ui.byId("move-filters"),
    planState: ui.byId("move-plan-state"),
    tableWrap: ui.byId("move-table-wrap"),
    tbody: ui.byId("move-tbody"),
    summary: ui.byId("move-summary"),
    overview: ui.byId("move-review-overview"), badge: ui.byId("move-plan-badge"), meta: ui.byId("move-plan-meta"),
    listStatus: ui.byId("move-list-status"), cards: ui.byId("move-plan-cards"), pager: ui.byId("move-plan-pager"),
    q: ui.byId("move-plan-q"), action: ui.byId("move-plan-action"), reset: ui.byId("move-plan-reset"),
    prev: ui.byId("move-plan-prev"), next: ui.byId("move-plan-next"), page: ui.byId("move-plan-page"), range: ui.byId("move-plan-range"),
    exportScope: ui.byId("move-export-scope"), exportCsv: ui.byId("move-export-csv"), exportJson: ui.byId("move-export-json"), exportNote: ui.byId("move-export-note"),
  };

  [nodes.dir, nodes.filename].forEach((input) => {
    input.addEventListener("focus", () => {
      lastFocusedTemplate = input;
    });
    input.addEventListener("input", configurationChanged);
  });
  nodes.conflict.addEventListener("change", () => {
    state.move.conflict = nodes.conflict.value;
    configurationChanged();
  });
  nodes.limit.addEventListener("change", () => {
    state.move.limit = Math.max(0, Number(nodes.limit.value) || 0);
    configurationChanged();
  });
  nodes.limit.addEventListener("input", configurationChanged);
  document.querySelectorAll("input[name=move-scope]").forEach((radio) => {
    radio.addEventListener("change", () => {
      state.move.scope = radio.value;
      renderScope();
      configurationChanged();
    });
  });

  nodes.testBtn.addEventListener("click", testTemplate);
  nodes.previewBtn.addEventListener("click", previewPlan);
  nodes.dryBtn.addEventListener("click", dryRun);
  nodes.execBtn.addEventListener("click", executePlan);

  on("selection:changed", () => { const selected = state.move.scope === "selected"; renderScope(); if (selected) configurationChanged(); });
  searchLater = ui.debounce(() => void loadItems(), 250);
  nodes.q.addEventListener("input", () => { view.q = nodes.q.value.trim(); view.page = 1; cancelList(); syncExports(); searchLater(); });
  nodes.q.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing) { searchLater.cancel(); void loadItems(); } });
  nodes.action.addEventListener("change", () => changeAction(nodes.action.value));
  nodes.reset.addEventListener("click", () => { nodes.q.value = ""; view.q = ""; changeAction(""); });
  nodes.prev.addEventListener("click", () => { if (view.page > 1) { view.page -= 1; void loadItems(); } });
  nodes.next.addEventListener("click", () => { if (view.page < view.pages) { view.page += 1; void loadItems(); } });
  nodes.exportScope.addEventListener("change", syncExports);
  window.addEventListener("metatidy:unauthorized", () => {
    sessionUsable = false; previewRevision += 1; templateRevision += 1; configRevision += 1;
    cancelList(); searchLater.cancel(); planContext = null; operation = null; state.move.plan = null;
    Object.assign(view, { q: "", action: "", page: 1, pages: 0, filtered: 0, items: [], error: "" });
    nodes.q.value = ""; nodes.action.value = "";
    for (const node of [nodes.summary, nodes.tbody, nodes.cards, nodes.counts, nodes.listStatus, nodes.tplResult]) ui.clear(node);
    nodes.progress.hidden = true; syncPlan();
  });
  syncPlan();
}

/* ------------------------------------------------------------- 模板 */

export function onSettings() {
  const values = (state.settings && state.settings.values) || {};
  if (!nodes.dir.value) nodes.dir.value = values.dir_template || "{language}/{artist}/{album}";
  if (!nodes.filename.value) nodes.filename.value = values.filename_template || "{track:02} - {title}";
  if (values.conflict_policy && !templateTouched && !planContext) {
    nodes.conflict.value = values.conflict_policy;
    state.move.conflict = values.conflict_policy;
  }
  state.move.dirTemplate = nodes.dir.value;
  state.move.filenameTemplate = nodes.filename.value;
  renderTokens();
  renderScope();
  syncPlan();
}

export function onStatus(status) {
  ui.setText(nodes.root, status.library_root || "—");
  nodes.sample.title = `音乐目录：${status.music_dir || "—"}`;
}

/** Navigate from selection review; planning still requires an explicit click. */
export function selectSelectedScope() {
  if (!sessionUsable || !selectionCount() || operation) return false;
  state.move.scope = "selected";
  state.move.limit = 0;
  nodes.limit.value = "0";
  document.querySelector('input[name="move-scope"][value="selected"]').checked = true;
  renderScope(); configurationChanged();
  nodes.scopeHint.textContent = `范围为全部已选 ${selectionCount()} 首，条数上限已清除。请先预览计划。`;
  return true;
}

function renderTokens() {
  ui.clear(nodes.tokens);
  state.placeholders.forEach((placeholder) => {
    nodes.tokens.append(
      ui.el("button", {
        type: "button",
        class: "token-btn",
        text: `{${placeholder.key}}`,
        title: `${placeholder.desc}（点击插入到光标处）`,
        onClick: () => insertToken(placeholder.key),
      }),
    );
  });
  if (!state.placeholders.length) {
    nodes.tokens.append(ui.el("span", { class: "hint", text: "占位符列表来源于后端 /api/settings。" }));
  }
}

function insertToken(key) {
  const target = lastFocusedTemplate && document.activeElement !== nodes.testBtn ? lastFocusedTemplate : nodes.dir;
  const token = `{${key}}`;
  const start = target.selectionStart === null ? target.value.length : target.selectionStart;
  const end = target.selectionEnd === null ? target.value.length : target.selectionEnd;
  target.value = `${target.value.slice(0, start)}${token}${target.value.slice(end)}`;
  const caret = start + token.length;
  target.focus();
  target.setSelectionRange(caret, caret);
  if (target === nodes.dir) state.move.dirTemplate = target.value;
  else state.move.filenameTemplate = target.value;
  lastFocusedTemplate = target;
  configurationChanged();
}

async function testTemplate() {
  const revision = ++templateRevision;
  const config = configRevision;
  const row = currentSampleRow();
  state.move.dirTemplate = nodes.dir.value;
  state.move.filenameTemplate = nodes.filename.value;
  nodes.testBtn.disabled = true;
  nodes.testBtn.textContent = "渲染中…";
  ui.clear(nodes.tplResult);
  try {
    const result = await api.templateTest({
      dir_template: nodes.dir.value,
      filename_template: nodes.filename.value,
      track_id: row ? Number(row.id) : undefined,
    });
    if (!sessionUsable || revision !== templateRevision || config !== configRevision) return;
    ui.setText(nodes.sample, `样本曲目：${result.track.artist || "无歌手"} - ${result.track.title || "无标题"}（#${result.track.id}）`);
    const body = [
      ui.el("dl", { class: "kv" }, [
        ui.el("dt", { text: "源" }),
        ui.el("dd", { title: result.source, text: result.source }),
        ui.el("dt", { text: "目标" }),
        ui.el("dd", { class: "good", title: result.target, text: result.target }),
      ]),
    ];
    if (result.warnings && result.warnings.length) {
      body.push(ui.notice("warn", `模板警告：${result.warnings.join("；")}`));
    }
    nodes.tplResult.append(ui.el("div", { class: "result-block" }, body));
  } catch (err) {
    if (!sessionUsable || revision !== templateRevision || config !== configRevision) return;
    ui.clear(nodes.tplResult);
    nodes.tplResult.append(ui.notice("err", `试渲染失败：${err.message}`));
  } finally {
    if (revision === templateRevision) { nodes.testBtn.disabled = false; nodes.testBtn.textContent = "实时试渲染"; }
  }
}

function currentSampleRow() {
  const ids = selectionIds();
  if (ids.length) return state.selection.get(Number(ids[0]));
  if (state.currentTrackId && state.selection.has(state.currentTrackId)) return state.selection.get(state.currentTrackId);
  return null;
}

/* ------------------------------------------------------------- 范围 */

function renderScope() {
  const count = selectionCount();
  ui.setText(nodes.scopeSelectedLabel, `曲库已勾选（${count} 首）`);
  const radio = document.querySelector("input[name=move-scope][value=selected]");
  if (radio) radio.disabled = count === 0;
  ui.setText(
    nodes.scopeHint,
    state.move.scope === "selected" ? count ? `将只整理已勾选的 ${count} 首` : "已选范围为空，请重新勾选曲目。范围仍为已选曲目。" : "将按当前模板整理库里全部曲目（可用条数上限先小批量试）",
  );
}

/* Plan identity, view filters and execution state are deliberately separate. */
function configurationChanged() {
  templateTouched = true;
  configRevision += 1;
  previewRevision += 1;
  if (planContext) planContext.dirty = true;
  if (operation && ["preview", "dry", "confirm"].includes(operation.kind)) operation = null;
  syncPlan();
}

function cancelList() {
  listController?.abort(); listController = null; listRevision += 1; view.loading = false;
}

function movable(plan) {
  return ["move", "conflict_rename", "conflict_overwrite"].reduce((sum, action) => sum + (Number(plan?.counts?.[action]) || 0), 0);
}

function usable(context = planContext) {
  return Boolean(sessionUsable && context && context === planContext && !context.dirty && !context.consumed && !context.expired && !context.uncertain);
}

function syncPlan() {
  const context = planContext;
  const plan = context?.plan;
  nodes.previewBtn.disabled = !sessionUsable || Boolean(operation);
  nodes.previewBtn.textContent = operation?.kind === "preview" ? "计算中…" : "预览计划";
  nodes.dryBtn.disabled = !usable() || Boolean(operation);
  nodes.execBtn.disabled = !usable() || Boolean(operation) || !movable(plan);
  nodes.dryBtn.textContent = operation?.kind === "dry" ? "演练中…" : "仅演练";
  nodes.execBtn.textContent = operation?.kind === "execute" ? "执行中…" : `确认执行（${movable(plan)}）`;
  nodes.overview.hidden = !plan;
  nodes.filters.hidden = !plan;
  nodes.planned.textContent = plan ? `${ui.fmtNum(plan.planned)} 条计划` : "—";
  nodes.badge.textContent = !plan ? operation?.kind === "preview" ? "计算中" : "等待预览"
    : context.consumed ? operation?.kind === "execute" ? "已提交执行" : "计划已消费"
    : context.expired ? "计划已失效" : context.uncertain ? "执行状态待核对"
    : context.dirty ? "配置已更改" : operation?.kind === "dry" ? "演练中" : operation?.kind === "confirm" ? "等待确认" : "待审阅";
  nodes.meta.textContent = plan ? `匹配 ${ui.fmtNum(plan.total)} 首 · 本计划 ${ui.fmtNum(plan.planned)} 条${plan.truncated ? "（按条数上限生成）" : ""} · ${plan.dir_template} / ${plan.filename_template} · ${POLICY_LABELS[plan.conflict_policy] || plan.conflict_policy}` : "";
  nodes.planState.replaceChildren();
  if (!plan) nodes.planState.append(ui.el("p", { class: "hint", text: operation?.kind === "preview" ? "正在计算整份计划，尚未移动文件…" : "预览后可检索完整计划、核对路径，再演练与确认执行。" }));
  else {
    if (context.dirty) nodes.planState.append(ui.notice("warn", "配置或选择已更改。下方保留旧计划供查看，请重新预览后演练或执行。"));
    if (context.expired) nodes.planState.append(ui.notice("warn", "这份计划已失效，请重新预览。"));
    if (context.uncertain) nodes.planState.append(ui.notice("warn", "提交响应未确认，请先到任务中心核对。此计划已锁定，避免重复移动。"));
    if (context.consumed && !operation) nodes.planState.append(ui.notice("info", "这份计划已提交过实际执行，不能再次执行。可继续查看与导出计划；再次整理请重新预览。"));
    if (plan.template_warnings?.length) nodes.planState.append(ui.notice("warn", `模板提示：${plan.template_warnings.join("；")}`));
    if (Number(plan.counts?.invalid)) nodes.planState.append(ui.notice("warn", `${plan.counts.invalid} 条无效项不会执行，可以按“无效项”筛选查看原因。`));
    if (Number(plan.counts?.conflict_overwrite)) nodes.planState.append(ui.notice("err", `${plan.counts.conflict_overwrite} 条计划将覆盖同名目标文件，执行无法自动撤销。`));
  }
  const hasRows = Boolean(plan && view.items.length);
  nodes.tableWrap.hidden = !hasRows;
  nodes.cards.hidden = !hasRows;
  nodes.pager.hidden = !plan;
  syncExports();
}

async function previewPlan() {
  if (!sessionUsable || operation) return;
  const payload = { dir_template: nodes.dir.value, filename_template: nodes.filename.value, conflict_policy: nodes.conflict.value };
  if (state.move.scope === "selected") {
    payload.ids = selectionIds();
    if (!payload.ids.length) { ui.toast("warn", "没有勾选曲目", "请先选择曲目或使用全部曲目范围。"); return; }
  } else payload.filters = {};
  const limit = Math.max(0, Number(nodes.limit.value) || 0);
  if (limit) payload.limit = limit;
  const revision = ++previewRevision;
  const config = configRevision;
  const busy = { kind: "preview" };
  operation = busy;
  cancelList(); searchLater.cancel();
  syncPlan();
  try {
    const result = await api.movePreview(payload);
    if (!sessionUsable || previewRevision !== revision || config !== configRevision || operation !== busy) return;
    if (!result.token || !result.counts) throw new Error("计划响应不完整，请重新预览。");
    const plan = { ...result, items: [] };
    planContext = { plan, revision, config, dirty: false, consumed: false, expired: false, uncertain: false, report: null };
    state.move.plan = plan;
    state.move.summary = null;
    Object.assign(view, { q: "", action: "", page: 1, pages: 0, filtered: 0, items: [], error: "" });
    nodes.q.value = ""; nodes.action.value = "";
    nodes.summary.replaceChildren(); nodes.tbody.replaceChildren(); nodes.cards.replaceChildren();
    nodes.progress.hidden = true;
    renderCounts();
    operation = null;
    syncPlan();
    await loadItems();
  } catch (error) {
    if (!sessionUsable || revision !== previewRevision || operation !== busy) return;
    ui.toast("err", "预览失败", error.message);
    if (planContext) planContext.dirty = true;
  } finally {
    if (operation === busy) { operation = null; syncPlan(); }
  }
}

function changeAction(action) {
  searchLater.cancel(); view.action = ACTION_ORDER.includes(action) ? action : ""; view.page = 1;
  nodes.action.value = view.action; renderCounts(); syncExports(); void loadItems();
}

function renderCounts() {
  const focused = nodes.counts.contains(document.activeElement) ? document.activeElement.dataset.moveAction : null;
  const counts = planContext?.plan.counts || {};
  nodes.counts.replaceChildren(...[["", Number(planContext?.plan.planned) || 0], ...ACTION_ORDER.filter((action) => counts[action]).map((action) => [action, counts[action]])].map(([action, count]) => ui.el("button", {
    type: "button", class: "chip", dataset: { moveAction: action }, "aria-pressed": String(action === view.action),
    onClick: () => changeAction(view.action === action ? "" : action),
  }, [action ? ACTION_META[action].label : "全部计划", ui.el("strong", { text: ui.fmtNum(count) })])));
  if (focused !== null) [...nodes.counts.children].find((button) => button.dataset.moveAction === focused)?.focus({ preventScroll: true });
}

async function loadItems() {
  const context = planContext;
  if (!context || !sessionUsable) return;
  cancelList();
  const revision = ++listRevision;
  const abort = new AbortController(); listController = abort;
  const query = { q: view.q, action: view.action, page: view.page, page_size: view.page_size };
  view.loading = true; view.error = "";
  view.items = []; view.filtered = 0; view.pages = 0;
  nodes.tbody.replaceChildren(); nodes.cards.replaceChildren();
  nodes.tableWrap.hidden = true; nodes.cards.hidden = true;
  nodes.listStatus.textContent = "正在查询完整计划…";
  nodes.tableWrap.setAttribute("aria-busy", "true");
  syncPager();
  try {
    const data = await api.movePlanItems(context.plan.token, query, { signal: abort.signal });
    if (!sessionUsable || context !== planContext || revision !== listRevision) return;
    if (data.token !== context.plan.token || !Array.isArray(data.items)) throw new Error("计划明细响应不完整，请重试。");
    context.consumed ||= Boolean(data.executed);
    view.items = data.items;
    view.page = Number(data.page) || 1; view.pages = Number(data.pages) || 0; view.filtered = Number(data.filtered_total) || 0;
    view.loading = false;
    renderItems(); syncPlan(); syncPager();
    nodes.listStatus.textContent = view.items.length ? "" : "没有符合条件的计划条目，试试其他关键词或清空筛选。";
  } catch (error) {
    if (!sessionUsable || context !== planContext || revision !== listRevision || abort.signal.aborted) return;
    view.loading = false; view.error = error.message;
    if (error.status === 404) context.expired = true;
    nodes.listStatus.replaceChildren(ui.el("span", { text: `明细读取失败：${error.message} ` }), ui.el("button", { id: "move-list-retry", type: "button", class: "btn btn-sm", text: "重试", onClick: () => void loadItems() }));
    syncPlan(); syncPager();
  } finally {
    if (revision === listRevision) { view.loading = false; nodes.tableWrap.setAttribute("aria-busy", "false"); syncPager(); }
  }
}

function syncPager() {
  nodes.range.textContent = `整份计划 ${ui.fmtNum(planContext?.plan.planned || 0)} 条 · ${view.loading ? "正在查询" : view.error ? "明细未载入" : `当前条件 ${ui.fmtNum(view.filtered)} 条`}`;
  nodes.page.textContent = `${view.page} / ${Math.max(1, view.pages)}`;
  nodes.prev.disabled = view.loading || view.page <= 1;
  nodes.next.disabled = view.loading || view.page >= view.pages;
}

function syncExports() {
  const token = sessionUsable ? planContext?.plan.token : null;
  const filtered = nodes.exportScope.value === "filtered";
  const params = filtered ? { q: view.q, action: view.action } : {};
  for (const [link, format] of [[nodes.exportCsv, "csv"], [nodes.exportJson, "json"]]) {
    link.setAttribute("aria-disabled", String(!token));
    if (token) link.href = movePlanExportUrl(token, { ...params, format });
    else link.removeAttribute("href");
  }
  nodes.exportNote.textContent = filtered ? `按当前搜索${view.q ? `“${view.q}”` : "（无关键词）"}及动作筛选导出全部匹配条目，不限本页。` : "导出整份计划，不受搜索、筛选或当前页影响。";
}

function pathLabel(path) { return String(path || "").split(/[\\/]/).filter(Boolean).at(-1) || "—"; }

function renderItems() {
  const focused = document.activeElement;
  const focusedKey = focused?.dataset.moveDetail;
  nodes.tbody.replaceChildren(); nodes.cards.replaceChildren();
  for (const item of view.items) {
    const meta = ACTION_META[item.action] || { label: item.action, variant: "badge-mute" };
    const reason = [item.reason, item.warning].filter(Boolean).join(" · ");
    const details = () => openPathDetails(item);
    const row = ui.el("tr", { dataset: { moveOrdinal: item.ordinal } }, [
      ui.el("td", { class: "num mono", text: item.ordinal, title: `曲目 #${item.track_id}` }),
      ui.el("td", {}, [ui.el("button", { type: "button", class: "move-path-button truncate", dataset: { moveDetail: item.ordinal }, text: item.source, title: "查看完整路径对照", onClick: details })]),
      ui.el("td", {}, [ui.el("span", { class: "truncate path-cell", title: item.target || "", text: item.target || "—" })]),
      ui.el("td", {}, [ui.el("span", { class: `badge ${meta.variant}`, text: meta.label })]),
      ui.el("td", {}, [ui.el("span", { class: "move-row-note", text: reason || "—" })]),
    ]);
    nodes.tbody.append(row);
    nodes.cards.append(ui.el("article", { class: "move-plan-card", dataset: { moveOrdinal: item.ordinal } }, [
      ui.el("div", { class: "move-plan-card-head" }, [ui.el("strong", { text: `${item.ordinal}. ${item.filename || pathLabel(item.source)}` }), ui.el("span", { class: `badge ${meta.variant}`, text: meta.label })]),
      ui.el("div", { class: "move-card-path" }, [ui.el("span", { text: "从" }), ui.el("span", { text: item.source })]),
      ui.el("div", { class: "move-card-path" }, [ui.el("span", { text: "到" }), ui.el("span", { text: item.target || "—" })]),
      reason ? ui.el("p", { class: "hint", text: reason }) : null,
      ui.el("button", { type: "button", class: "btn btn-sm btn-ghost", dataset: { moveDetail: item.ordinal }, text: "展开路径对照", onClick: details }),
    ]));
  }
  if (focusedKey) {
    const parent = focused?.closest(".move-plan-card") ? nodes.cards : nodes.tbody;
    [...parent.querySelectorAll("[data-move-detail]")].find((button) => button.dataset.moveDetail === focusedKey)?.focus({ preventScroll: true });
  }
}

function openPathDetails(item) {
  const context = planContext;
  if (!context || !sessionUsable) return;
  const source = String(item.source || ""); const target = String(item.target || "");
  let common = 0;
  while (common < source.length && common < target.length && source[common] === target[common]) common += 1;
  common = source.slice(0, common).search(/[^\\/]*$/);
  const section = (label, path, highlight) => {
    const feedback = ui.el("span", { class: "hint", role: "status" });
    const pre = ui.el("pre", { tabindex: "0" });
    if (highlight && common >= 0) pre.append(document.createTextNode(path.slice(0, common)), ui.el("mark", { text: path.slice(common) }));
    else pre.textContent = path || "—";
    const copy = async () => {
      try { await navigator.clipboard.writeText(path); feedback.textContent = "已复制"; }
      catch { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(pre); selection.removeAllRanges(); selection.addRange(range); feedback.textContent = "已选中，请复制"; }
    };
    return ui.el("section", { class: "move-detail-path" }, [ui.el("div", { class: "row" }, [ui.el("strong", { text: label }), ui.el("div", { class: "spacer" }), feedback, ui.el("button", { type: "button", class: "btn btn-sm", text: "复制路径", disabled: !path, onClick: copy })]), pre]);
  };
  void ui.openDialog({ title: "计划路径对照", subtitle: `第 ${item.ordinal} 条 · 曲目 #${item.track_id} · ${ACTION_META[item.action]?.label || item.action}`, body: [
    ui.notice("info", "这是计划目标。执行时若出现新的目标冲突，最终位置可能调整。"),
    section("源路径", source, false), section("计划目标", target, true),
    item.reason || item.warning ? ui.notice("warn", [item.reason, item.warning].filter(Boolean).join("；")) : null,
  ], actions: [{ id: "close", label: "关闭" }] });
}

async function dryRun() {
  const context = planContext;
  if (!usable(context) || operation) return;
  const busy = { kind: "dry", context }; operation = busy; syncPlan();
  try {
    const summary = await api.moveExecute({ token: context.plan.token, dry_run: true });
    if (!usable(context) || operation !== busy) return;
    renderSummary(context, summary, true);
  } catch (error) {
    if (!sessionUsable || context !== planContext || operation !== busy) return;
    if (error.status === 404) context.expired = true;
    ui.toast("err", "演练失败", error.message);
  } finally { if (operation === busy) { operation = null; syncPlan(); } }
}

async function executePlan() {
  const context = planContext;
  if (!usable(context) || operation || !movable(context.plan)) return;
  const plan = context.plan; const config = configRevision;
  const busy = { kind: "confirm", context }; operation = busy; syncPlan();
  const confirmed = await ui.confirmDialog({
    title: "确认执行整份移动计划", message: `将处理整份计划中的 ${movable(plan)} 个可移动文件。当前搜索或动作筛选不会缩小执行范围。`,
    details: [{ label: "整份计划", value: `${plan.planned} 条` }, { label: "将移动", value: `${movable(plan)} 个文件`, danger: true },
      { label: "跳过与无效", value: `${Number(plan.planned) - movable(plan)} 条` }, { label: "冲突策略", value: POLICY_LABELS[plan.conflict_policy] || plan.conflict_policy },
      { label: "库根目录", value: plan.library_root }, { label: "目录模板", value: plan.dir_template }, { label: "文件名模板", value: plan.filename_template }],
    confirmLabel: `确认移动 ${movable(plan)} 个文件`, danger: true,
    note: "这是真实文件操作，无法自动撤销。计划只能提交执行一次，建议先演练；提交后可在任务中心核对进度。",
  });
  if (!confirmed || !usable(context) || config !== configRevision || operation !== busy) {
    if (confirmed && sessionUsable) ui.toast("info", "确认已失效", "计划或配置已改变，请重新预览后确认。");
    if (operation === busy) { operation = null; syncPlan(); }
    return;
  }
  busy.kind = "execute"; context.uncertain = true; syncPlan();
  nodes.summary.replaceChildren();
  const progress = ui.createProgress(nodes.progress, { label: "整理移动" });
  let jobId = null;
  try {
    const response = await api.moveExecute({ token: plan.token, dry_run: false });
    jobId = response.job_id;
    context.consumed = true; context.uncertain = false;
    if (!jobId) throw new Error("执行已提交，但响应缺少任务编号，请到任务中心核对。");
    if (sessionUsable && context === planContext) syncPlan();
    const job = await pollJob(jobId, { interval: 700, onTick: (tick) => { if (sessionUsable && context === planContext) progress.update(tick); } });
    if (!sessionUsable || context !== planContext) return;
    progress.finish(job);
    if (job.state === "error") throw new Error(job.error || job.message || "执行失败");
    let summary;
    try { summary = typeof job.result === "string" ? JSON.parse(job.result) : job.result; } catch { throw new Error("任务已结束，但结果无法读取，请在任务中心核对。"); }
    if (!summary) throw new Error("任务没有返回结果，请在任务中心核对。");
    renderSummary(context, summary, false, jobId);
    emit("status:refresh"); emit("tracks:refresh");
  } catch (error) {
    if (error.status === 409) { context.consumed = true; context.uncertain = false; }
    if (error.status === 404) { context.expired = true; context.uncertain = false; }
    if (sessionUsable && context === planContext) {
      progress.finish({ state: "error", message: error.message });
      nodes.summary.replaceChildren(ui.notice("err", `执行状态：${error.message}${jobId ? `（任务 ${jobId}）` : ""}。请到任务中心核对，勿重复提交。`));
    }
  } finally { if (operation === busy) { operation = null; syncPlan(); } }
}

function renderSummary(context, summary, dryRun, jobId = null) {
  const failures = Array.isArray(summary.failures) ? summary.failures : [];
  const report = { report_type: dryRun ? "move_dry_run" : "move_execution_summary", token: context.plan.token, job_id: jobId, generated_at: new Date().toISOString(),
    moved: Number(summary.moved) || 0, skipped: Number(summary.skipped) || 0, failed: Number(summary.failed) || 0, renamed: Number(summary.renamed) || 0, failures,
    note: dryRun ? "仅演练，未移动文件。" : "执行汇总与失败明细；不包含逐文件最终成功路径。" };
  context.report = report;
  if (!dryRun) state.move.summary = summary;
  nodes.summary.replaceChildren(
    ui.notice(dryRun ? "info" : report.failed ? "warn" : "ok", dryRun ? `演练结果：按已保存计划预计移动 ${report.moved}，跳过 ${report.skipped}。没有改动文件，也不会重新检查文件现状。` : `执行结果：移动 ${report.moved}，跳过 ${report.skipped}，改名 ${report.renamed}，失败 ${report.failed}。`),
    ui.resultBlock({ failures: failures.map((item) => ({ who: item.source || item.target || "—", why: item.error || "未知错误" })), failuresTitle: "实际失败明细" }),
    ui.el("div", { class: "move-result-actions" }, [ui.el("span", { class: "hint", text: report.note }), ui.el("button", { id: "move-export-result", type: "button", class: "btn btn-sm", text: dryRun ? "导出演练汇总 JSON" : "导出执行汇总 JSON", onClick: () => {
      if (!sessionUsable || planContext !== context) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json;charset=utf-8" }));
      const link = ui.el("a", { href: url, download: `${report.report_type}-${context.plan.token.slice(0, 8)}.json` });
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } })]),
  );
}
