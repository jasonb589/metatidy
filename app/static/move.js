/**
 * 页签 3：整理移动。
 *
 * 流程严格按后端设计：预览计划（只算不动，落库换 token）→ 仅演练（干跑，绝不动文件）
 * 或 确认执行（二次确认 → 后台任务 → 轮询进度 → 成功/跳过/失败汇总，失败清单必须列出）。
 * 目标越出库根目录的条目后端会标成 invalid，界面照样展示但明确写清不会执行。
 */

import { api, pollJob } from "./api.js";
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

let nodes = null;
let lastFocusedTemplate = null;

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
  };

  [nodes.dir, nodes.filename].forEach((input) => {
    input.addEventListener("focus", () => {
      lastFocusedTemplate = input;
    });
  });
  nodes.conflict.addEventListener("change", () => {
    state.move.conflict = nodes.conflict.value;
  });
  nodes.limit.addEventListener("change", () => {
    state.move.limit = Math.max(0, Number(nodes.limit.value) || 0);
  });
  document.querySelectorAll("input[name=move-scope]").forEach((radio) => {
    radio.addEventListener("change", () => {
      state.move.scope = radio.value;
      renderScope();
    });
  });

  nodes.testBtn.addEventListener("click", testTemplate);
  nodes.previewBtn.addEventListener("click", previewPlan);
  nodes.dryBtn.addEventListener("click", dryRun);
  nodes.execBtn.addEventListener("click", executePlan);

  on("selection:changed", renderScope);
}

/* ------------------------------------------------------------- 模板 */

export function onSettings() {
  const values = (state.settings && state.settings.values) || {};
  if (!nodes.dir.value) nodes.dir.value = values.dir_template || "{language}/{artist}/{album}";
  if (!nodes.filename.value) nodes.filename.value = values.filename_template || "{track:02} - {title}";
  if (values.conflict_policy) {
    nodes.conflict.value = values.conflict_policy;
    state.move.conflict = values.conflict_policy;
  }
  state.move.dirTemplate = nodes.dir.value;
  state.move.filenameTemplate = nodes.filename.value;
  renderTokens();
  renderScope();
}

export function onStatus(status) {
  ui.setText(nodes.root, status.library_root || "—");
  nodes.sample.title = `音乐目录：${status.music_dir || "—"}`;
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
}

async function testTemplate() {
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
    ui.clear(nodes.tplResult);
    nodes.tplResult.append(ui.notice("err", `试渲染失败：${err.message}`));
  } finally {
    nodes.testBtn.disabled = false;
    nodes.testBtn.textContent = "实时试渲染";
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
  if (!count && state.move.scope === "selected") {
    state.move.scope = "all";
    const all = document.querySelector("input[name=move-scope][value=all]");
    if (all) all.checked = true;
  }
  ui.setText(
    nodes.scopeHint,
    state.move.scope === "selected" ? `将只整理已勾选的 ${count} 首` : "将按当前模板整理库里全部曲目（可用条数上限先小批量试）",
  );
}

/* ------------------------------------------------------------- 预览 */

async function previewPlan() {
  const scope = state.move.scope;
  const payload = {
    dir_template: nodes.dir.value,
    filename_template: nodes.filename.value,
    conflict_policy: nodes.conflict.value,
  };
  if (scope === "selected") {
    const ids = selectionIds();
    if (!ids.length) {
      ui.toast("warn", "没有勾选曲目", "先在「曲库」页勾选，或把范围改成「全部曲目」。");
      return;
    }
    payload.ids = ids;
  } else {
    payload.filters = {};
  }
  const limit = Math.max(0, Number(nodes.limit.value) || 0);
  if (limit) payload.limit = limit;

  nodes.previewBtn.disabled = true;
  nodes.previewBtn.textContent = "计算中…";
  ui.clear(nodes.planState);
  nodes.planState.append(ui.loadingLine("正在按模板计算目标路径（只算不动）…"));
  try {
    const plan = await api.movePreview(payload);
    state.move.plan = plan;
    state.move.filterAction = "";
    state.move.summary = null;
    ui.clear(nodes.summary);
    renderPlan();
    ui.toast("ok", "计划已生成", `共 ${plan.planned} 条，其中可执行 ${(plan.counts.move || 0) + (plan.counts.conflict_rename || 0)} 条；尚未移动任何文件。`);
  } catch (err) {
    state.move.plan = null;
    renderPlan();
    ui.clear(nodes.planState);
    nodes.planState.append(ui.notice("err", `预览失败：${err.message}`));
    ui.toast("err", "预览计划失败", err.message);
  } finally {
    nodes.previewBtn.disabled = false;
    nodes.previewBtn.textContent = "预览计划";
  }
}

function renderPlan() {
  const plan = state.move.plan;
  ui.clear(nodes.counts);
  ui.clear(nodes.filters);
  ui.clear(nodes.tbody);

  if (!plan) {
    ui.setText(nodes.planned, "—");
    nodes.tableWrap.hidden = true;
    nodes.dryBtn.disabled = true;
    nodes.execBtn.disabled = true;
    if (!nodes.planState.textContent) {
      nodes.planState.append(ui.el("div", { class: "hint", text: "还没有计划：点「预览计划」先看每首歌会被移到哪里。" }));
    }
    return;
  }

  nodes.tableWrap.hidden = false;
  ui.setText(nodes.planned, `${plan.planned} / ${plan.total} 条`);
  ui.clear(nodes.planState);

  const counts = plan.counts || {};
  const entries = ACTION_ORDER.filter((action) => counts[action]).map((action) => [action, counts[action]]);
  entries.forEach(([action, count]) => {
    const meta = ACTION_META[action] || { label: action, variant: "" };
    nodes.counts.append(
      ui.el(
        "button",
        {
          type: "button",
          class: "chip",
          "aria-pressed": state.move.filterAction === action ? "true" : "false",
          title: "点击只看这一类",
          onClick: () => {
            state.move.filterAction = state.move.filterAction === action ? "" : action;
            renderPlan();
          },
        },
        [meta.label, ui.el("strong", { text: String(count) })],
      ),
    );
  });

  if (plan.template_warnings && plan.template_warnings.length) {
    nodes.planState.append(ui.notice("warn", `模板警告：${plan.template_warnings.join("；")}`));
  }

  const invalidCount = counts.invalid || 0;
  const movableCount = (counts.move || 0) + (counts.conflict_rename || 0) + (counts.conflict_overwrite || 0);
  nodes.dryBtn.disabled = false;
  nodes.execBtn.disabled = false;
  nodes.execBtn.textContent = movableCount ? `确认执行（${movableCount}）` : "确认执行（0）";

  const items = (plan.items || []).filter((item) => !state.move.filterAction || item.action === state.move.filterAction);
  const fragment = document.createDocumentFragment();
  items.forEach((item, index) => {
    const meta = ACTION_META[item.action] || { label: item.action, variant: "" };
    const tr = ui.el("tr", {});
    if (index < 12) {
      tr.classList.add("enter");
      tr.style.animationDelay = `${index * 10}ms`;
    }
    tr.append(
      ui.el("td", { class: "num mono", title: `曲目 #${item.track_id}`, text: `#${item.track_id}` }),
      ui.el("td", {}, [ui.el("span", { class: "truncate path-cell", title: item.source, text: item.source })]),
      ui.el("td", {}, [ui.el("span", { class: "truncate", title: item.target, text: item.target || "—" })]),
      ui.el("td", {}, [ui.el("span", { class: `badge ${meta.variant}`, text: meta.label })]),
      ui.el("td", {}, [
        ui.el("span", {
          class: "truncate",
          title: [item.reason, item.warning].filter(Boolean).join(" / "),
          text: [item.reason, item.warning].filter(Boolean).join(" / ") || "—",
        }),
      ]),
    );
    fragment.append(tr);
  });
  nodes.tbody.append(fragment);

  if (plan.display_truncated) {
    nodes.planState.append(ui.notice("warn", `计划共 ${plan.planned} 条，这里只显示前 ${(plan.items || []).length} 条；执行时后端仍会处理全部条目。`));
  }
  if (invalidCount) {
    nodes.planState.append(
      ui.notice("warn", `${invalidCount} 条被标为 invalid（目标越出库根目录、源文件不存在或模板渲染失败），这些条目在演练和执行时都会被跳过。`),
    );
  }
  if (plan.conflict_policy === "overwrite" && counts.conflict_overwrite) {
    nodes.planState.append(ui.notice("err", `冲突策略为 overwrite：${counts.conflict_overwrite} 条会覆盖目标位置的同名文件，无法撤销。`));
  }
}

/* ------------------------------------------------------------- 执行 */

async function dryRun() {
  const plan = state.move.plan;
  if (!plan) return;
  nodes.dryBtn.disabled = true;
  nodes.dryBtn.textContent = "演练中…";
  ui.clear(nodes.summary);
  try {
    const summary = await api.moveExecute({ token: plan.token, dry_run: true });
    renderSummary(summary, { dryRun: true });
    ui.toast("ok", "演练完成", `模拟移动 ${summary.moved} 个文件，跳过 ${summary.skipped} 个；文件系统没有任何改动。`);
  } catch (err) {
    ui.clear(nodes.summary);
    nodes.summary.append(ui.notice("err", `演练失败：${err.message}`));
    ui.toast("err", "演练失败", err.message);
  } finally {
    nodes.dryBtn.disabled = false;
    nodes.dryBtn.textContent = "仅演练";
  }
}

async function executePlan() {
  const plan = state.move.plan;
  if (!plan) return;
  const counts = plan.counts || {};
  const movable = (counts.move || 0) + (counts.conflict_rename || 0) + (counts.conflict_overwrite || 0);
  const invalid = counts.invalid || 0;
  const skipped = (counts.conflict_skip || 0) + (counts.in_place || 0);

  const confirmed = await ui.confirmDialog({
    title: "确认执行整理移动",
    message: `即将按当前计划移动 ${movable} 个音频文件。这是真实文件操作，metatidy 不提供自动撤销。`,
    details: [
      { label: "将移动", value: `${movable} 个文件`, danger: movable > 0 },
      { label: "跳过", value: `${skipped} 个（已在目标位置或按策略跳过）` },
      { label: "无效项", value: `${invalid} 个（不执行）`, danger: invalid > 0 },
      { label: "冲突策略", value: plan.conflict_policy || state.move.conflict },
      { label: "库根目录", value: plan.library_root || "—" },
      { label: "目录模板", value: plan.dir_template || "—" },
      { label: "文件名模板", value: plan.filename_template || "—" },
    ],
    confirmLabel: `确认移动 ${movable} 个文件`,
    danger: true,
    note: "移动失败的文件会保留在源路径（后端绝不删源）；计划 token 只能执行一次，重复执行需要重新预览。建议先点「仅演练」确认清单。",
  });
  if (!confirmed) {
    ui.toast("info", "已取消执行", "没有移动任何文件。");
    return;
  }

  nodes.execBtn.disabled = true;
  nodes.dryBtn.disabled = true;
  ui.clear(nodes.summary);
  const progress = ui.createProgress(nodes.progress, { label: "整理移动" });
  try {
    const { job_id: jobId } = await api.moveExecute({ token: plan.token, dry_run: false });
    const job = await pollJob(jobId, { onTick: (tick) => progress.update(tick), interval: 700 });
    progress.finish(job);
    if (job.state === "error") {
      ui.clear(nodes.summary);
      nodes.summary.append(ui.notice("err", `执行失败：${job.error || job.message}`));
      ui.toast("err", "整理移动失败", job.error || "");
      return;
    }
    let summary = {};
    try {
      summary = JSON.parse(job.result || "{}");
    } catch {
      summary = {};
    }
    renderSummary(summary, { dryRun: false });
    ui.toast(
      summary.failed ? "warn" : "ok",
      `整理完成：移动 ${summary.moved ?? 0}，跳过 ${summary.skipped ?? 0}，失败 ${summary.failed ?? 0}`,
      summary.renamed ? `其中 ${summary.renamed} 个因冲突改名。` : "路径已同步到索引。",
    );
    emit("status:refresh");
    emit("tracks:refresh");
  } catch (err) {
    progress.finish({ state: "error", message: err.message });
    ui.clear(nodes.summary);
    nodes.summary.append(ui.notice("err", `执行失败：${err.message}`));
    ui.toast("err", "整理移动失败", err.message);
  } finally {
    nodes.execBtn.disabled = false;
    nodes.dryBtn.disabled = false;
    renderPlan();
  }
}

function renderSummary(summary, { dryRun }) {
  ui.clear(nodes.summary);
  const failures = summary.failures || [];
  nodes.summary.append(
    ui.el("div", {
      class: `notice ${dryRun ? "notice-info" : failures.length ? "notice-warn" : "notice-ok"}`,
    }, [
      ui.el("div", { class: "body" }, [
        dryRun
          ? `演练结果（没有改动任何文件）：模拟移动 ${summary.moved ?? 0}，跳过 ${summary.skipped ?? 0}，改名避让 ${summary.renamed ?? 0}。`
          : `执行结果：成功移动 ${summary.moved ?? 0}，跳过 ${summary.skipped ?? 0}，改名避让 ${summary.renamed ?? 0}，失败 ${summary.failed ?? 0}。`,
      ]),
    ]),
    ui.resultBlock({
      failures: failures.map((item) => ({
        who: item.source || item.target || "—",
        why: item.error || "未知错误",
      })),
      failuresTitle: "失败明细（这些文件仍在源路径）",
    }),
  );
  if (!dryRun) {
    state.move.summary = summary;
  }
}
