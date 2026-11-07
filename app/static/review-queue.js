/** A bounded, session-only review list. Search responses and writes stay in scrape.js. */
import * as ui from "./ui.js";

const LABELS = {
  queued: "等待搜索", searching: "搜索中", ready: "待审阅", empty: "无候选",
  failed: "搜索失败", expired: "需要重搜", skipped: "已跳过", done: "已处理", stopped: "未搜索",
};

export function initReviewQueue({ host, maxItems = 200, onOpen, onRetry, onSkip, onClear, onStop }) {
  let generation = 0;
  let entries = [];
  let activeId = null;
  let running = false;
  let filter = "all";
  let expanded = true;
  const rows = new Map();
  host.classList.add("review-queue");
  const summary = ui.el("p", { id: "review-summary", class: "review-summary", role: "status", "aria-live": "polite", "aria-atomic": "true" });
  const meter = ui.el("span", { class: "review-meter-fill" });
  const filters = ui.el("div", { class: "review-filters", role: "group", "aria-label": "筛选审阅队列" });
  for (const [value, label] of [["all", "全部"], ["ready", "待审"], ["attention", "需处理"], ["done", "已结束"]]) {
    filters.append(ui.el("button", { type: "button", dataset: { reviewFilter: value }, text: label, "aria-pressed": String(value === filter), onClick: () => { filter = value; render(); } }));
  }
  const list = ui.el("ol", { id: "review-list", class: "review-list", "aria-label": "本批待审曲目" });
  const empty = ui.el("div", { id: "review-empty", class: "review-empty" });
  const expand = ui.el("button", { id: "review-expand", type: "button", class: "btn btn-sm review-expand", text: "展开队列", hidden: true, onClick: () => { expanded = true; render(); } });
  const stop = ui.el("button", { id: "review-stop", type: "button", class: "btn btn-sm", text: "停止搜索", hidden: true, onClick: () => onStop?.({ generation }) });
  const clear = ui.el("button", { id: "review-clear", type: "button", class: "btn btn-sm btn-ghost", text: "清空队列", onClick: () => onClear?.({ generation }) });
  host.append(
    ui.el("div", { class: "review-overview" }, [
      ui.el("div", { class: "review-overview-head" }, [ui.el("span", { class: "review-kicker", text: "逐首，找到合适的版本" }), ui.el("span", { class: "badge badge-mute", text: "仅本次会话" })]),
      summary, ui.el("div", { class: "review-meter", "aria-hidden": "true" }, [meter]),
      ui.el("p", { class: "hint", text: "批量搜索后，在这里继续审阅。候选保留 30 分钟，刷新页面后清空。" }),
      ui.el("div", { class: "review-tools" }, [stop, clear, expand]),
    ]), filters, list, empty,
  );

  function visible(item) {
    if (filter === "ready") return item.status === "ready";
    if (filter === "attention") return ["failed", "empty", "expired", "stopped"].includes(item.status);
    if (filter === "done") return ["done", "skipped"].includes(item.status);
    return true;
  }

  function makeRow(item) {
    const payload = () => ({ generation, trackId: item.trackId, attempt: item.attempt });
    const open = ui.el("button", { type: "button", class: "review-open", dataset: { reviewOpen: item.trackId }, onClick: () => onOpen?.(payload()) });
    const number = ui.el("span", { class: "review-number", "aria-hidden": "true" });
    const title = ui.el("strong", { class: "review-title" });
    const subtitle = ui.el("span", { class: "review-subtitle" });
    const status = ui.el("span", { class: "review-state" });
    open.append(number, ui.el("span", { class: "review-row-copy" }, [title, subtitle]), status);
    const note = ui.el("p", { class: "review-note" });
    const retry = ui.el("button", { type: "button", class: "btn btn-sm btn-ghost", dataset: { reviewRetry: item.trackId }, text: "重新搜索", onClick: () => onRetry?.(payload()) });
    const skip = ui.el("button", { type: "button", class: "btn btn-sm btn-ghost", dataset: { reviewSkip: item.trackId }, text: "跳过", onClick: () => onSkip?.(payload()) });
    const actions = ui.el("div", { class: "review-row-actions" }, [retry, skip]);
    const node = ui.el("li", { class: "review-item", dataset: { reviewId: item.trackId } }, [open, note, actions]);
    return { node, open, number, title, subtitle, status, note, actions, retry, skip, item };
  }

  function render() {
    const ready = entries.filter((item) => item.status === "ready").length;
    const finished = entries.filter((item) => ["done", "skipped"].includes(item.status)).length;
    const searched = entries.filter((item) => !["queued", "searching", "stopped"].includes(item.status)).length;
    const summaryText = entries.length ? `${running ? `已搜索 ${searched} / ${entries.length}` : `本批 ${entries.length} 首`} · 待审 ${ready} · 已结束 ${finished}` : "还没有待审曲目";
    if (summary.textContent !== summaryText) summary.textContent = summaryText;
    meter.style.width = `${entries.length ? Math.round(searched / entries.length * 100) : 0}%`;
    stop.hidden = !running;
    clear.disabled = !entries.length;
    filters.hidden = !entries.length;
    for (const button of filters.children) button.setAttribute("aria-pressed", String(button.dataset.reviewFilter === filter));
    host.dataset.collapsed = String(!expanded && activeId !== null);
    expand.hidden = expanded || activeId === null;
    const keep = new Set();
    let cursor = list.firstElementChild;
    entries.forEach((item, index) => {
      keep.add(item.trackId);
      let row = rows.get(item.trackId);
      if (!row) { row = makeRow(item); rows.set(item.trackId, row); }
      Object.assign(row.item, item);
      row.node.hidden = !visible(item);
      row.node.dataset.status = item.status;
      row.open.setAttribute("aria-current", String(item.trackId === activeId));
      row.open.disabled = ["queued", "searching"].includes(item.status);
      row.number.textContent = String(index + 1).padStart(2, "0");
      row.title.textContent = item.title || item.filename || `#${item.trackId}`;
      row.title.title = row.title.textContent;
      row.subtitle.textContent = `${item.artist || "未知歌手"}${item.count ? ` · ${item.count} 个候选` : ""}`;
      row.status.textContent = LABELS[item.status] || item.status;
      row.note.textContent = item.detail || "";
      row.note.hidden = !item.detail;
      row.retry.disabled = item.status === "searching" || item.status === "queued";
      row.skip.disabled = ["done", "skipped", "searching"].includes(item.status);
      row.retry.setAttribute("aria-label", `重新搜索 ${row.title.textContent}`);
      row.skip.setAttribute("aria-label", `跳过 ${row.title.textContent}`);
      row.actions.hidden = item.status === "queued" || item.status === "searching";
      if (row.node !== cursor) list.insertBefore(row.node, cursor);
      cursor = row.node.nextElementSibling;
    });
    for (const [id, row] of rows) if (!keep.has(id)) { row.node.remove(); rows.delete(id); }
    const hasVisible = entries.some(visible);
    list.hidden = !hasVisible;
    empty.hidden = hasVisible;
    empty.textContent = entries.length ? "这个分类下还没有曲目。" : "在下方勾选“仅搜索并逐首审阅”，为选中的曲目建立队列。";
  }

  render();
  return {
    update({ generation: nextGeneration, items, activeId: nextActive = activeId, running: nextRunning = running, collapse = false }) {
      if (nextGeneration < generation || !Array.isArray(items) || items.length > maxItems) return false;
      if (nextGeneration !== generation) { rows.forEach((row) => row.node.remove()); rows.clear(); filter = "all"; expanded = true; }
      generation = nextGeneration;
      entries = items.map((item) => ({ ...item }));
      activeId = nextActive;
      running = nextRunning;
      if (collapse) expanded = false;
      render();
      return true;
    },
    reveal(trackId = activeId) {
      expanded = true; filter = "all"; render();
      const button = rows.get(trackId)?.open;
      button?.focus({ preventScroll: true });
      button?.scrollIntoView({ block: "nearest", behavior: "instant" });
    },
    clear(nextGeneration = generation + 1) {
      generation = nextGeneration; entries = []; activeId = null; running = false; expanded = true;
      rows.forEach((row) => row.node.remove()); rows.clear(); render();
    },
  };
}
