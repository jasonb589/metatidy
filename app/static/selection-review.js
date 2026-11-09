/** Review the in-memory selection; index checks never inspect or modify audio. */
import { api } from "./api.js";
import * as ui from "./ui.js";
import { on, selectionRows, selectionRevision, removeFromSelection } from "./store.js";

const PAGE_SIZE = 50;
const CHECK_PAGE_SIZE = 200;
let closeActive = null;
const label = (row) => row.title || row.filename || `曲目 #${row.id}`;

export function openSelectionReview({ onAction = () => {} } = {}) {
  closeActive?.({ restoreFocus: false });
  const opener = document.activeElement;
  let closed = false;
  let page = 1;
  let members = selectionRevision();
  let rows = selectionRows().map((row) => ({ ...row }));
  let pendingRemoval = null;
  let checkGeneration = 0;
  let controller = null;
  let checking = false;
  let checked = null;
  let checkedAt = 0;
  const cards = new Map();

  const dialog = ui.el("dialog", { id: "selection-review-dialog", class: "selection-review", "aria-labelledby": "selection-review-title" });
  const total = ui.el("p", { id: "selection-review-total", class: "sr-total", role: "status" });
  const closeButton = ui.el("button", { id: "selection-review-close", type: "button", class: "btn btn-sm btn-ghost", text: "关闭", "aria-label": "关闭已选曲目审阅", onClick: () => close() });
  const q = ui.el("input", { id: "selection-review-q", type: "search", maxlength: "500", autocomplete: "off", placeholder: "在已选曲目中搜索标题、艺术家、专辑或路径…", "aria-label": "搜索已选曲目" });
  const removeMatching = ui.el("button", { id: "selection-review-remove-matching", type: "button", class: "btn btn-sm", onClick: () => askRemoval(matching().map((row) => row.id), "当前匹配") });
  const checkButton = ui.el("button", { id: "selection-review-check", type: "button", class: "btn btn-sm", text: "核对全部已选索引", onClick: () => void checkIndex() });
  const cancelCheck = ui.el("button", { id: "selection-review-cancel-check", type: "button", class: "btn btn-sm btn-ghost", text: "取消核对", hidden: true, onClick: () => {
    cancelIndex("核对已取消，未完成的结果已丢弃。"); render(); checkButton.focus({ preventScroll: true });
  } });
  const removeMissing = ui.el("button", { id: "selection-review-remove-missing", type: "button", class: "btn btn-sm", text: "移除索引缺失项", hidden: true, onClick: () => askRemoval([...checked].filter(([, item]) => item.status === "missing").map(([id]) => id), "索引缺失") });
  const checkStatus = ui.el("p", { id: "selection-review-check-status", class: "sr-check-status", role: "status", text: "未核对索引。核对只检查曲库记录，不检查磁盘文件。" });
  const notice = ui.el("p", { id: "selection-review-notice", class: "sr-notice", role: "status" });
  const removalText = ui.el("p");
  const confirmRemoval = ui.el("button", { id: "selection-review-confirm-remove", type: "button", class: "btn btn-sm btn-primary", text: "确认移除", onClick: applyRemoval });
  const cancelRemoval = ui.el("button", { id: "selection-review-cancel-remove", type: "button", class: "btn btn-sm btn-ghost", text: "取消", onClick: () => { pendingRemoval = null; removal.hidden = true; removeMatching.focus({ preventScroll: true }); } });
  const removal = ui.el("section", { id: "selection-review-removal", class: "sr-removal", hidden: true, "aria-label": "确认从选择中移除" }, [removalText, ui.el("div", { class: "sr-removal-actions" }, [cancelRemoval, confirmRemoval])]);
  const list = ui.el("div", { id: "selection-review-list", class: "sr-list", "aria-label": "已选曲目快照" });
  const previous = ui.el("button", { id: "selection-review-prev", type: "button", class: "btn btn-sm", text: "上一页", onClick: () => changePage(-1) });
  const next = ui.el("button", { id: "selection-review-next", type: "button", class: "btn btn-sm", text: "下一页", onClick: () => changePage(1) });
  const pageLabel = ui.el("span", { id: "selection-review-page" });
  const range = ui.el("span", { id: "selection-review-range" });
  const actions = [
    ["edit", "编辑"], ["edit-sequence", "逐首编辑"], ["filename-tags", "从文件名提取标签"], ["scrape", "批量刮削"], ["move", "整理"],
  ].map(([action, text]) => ui.el("button", { id: `selection-review-${action}`, type: "button", class: `btn btn-sm${action === "edit" ? " btn-primary" : action === "edit-sequence" ? " sr-sequence-action" : ""}`, "aria-describedby": action.startsWith("edit") ? "selection-review-edit-note" : null, dataset: { action, label: text }, onClick: () => {
    if (!rows.length || checking) return;
    const scope = { rows: rows.map((row) => ({ ...row })), revision: selectionRevision() };
    close({ restoreFocus: false }); onAction(action, scope);
  } }));
  const saveCollection = ui.el("button", { id: "selection-review-save-collection", type: "button", class: "btn btn-sm sr-save-collection", onClick: () => {
    if (!rows.length || checking) return;
    const scope = { rows: rows.map(row => ({ ...row })), revision: selectionRevision() };
    close({ restoreFocus: false }); onAction("save-collection", scope);
  } });
  dialog.append(
    ui.el("header", { class: "sr-head" }, [ui.el("div", {}, [ui.el("p", { class: "eyebrow", text: "YOUR SELECTED TRACKS" }), ui.el("h2", { id: "selection-review-title", text: "已选曲目审阅" }), total]), closeButton]),
    ui.el("div", { class: "sr-controls" }, [
      ui.el("p", { class: "sr-snapshot-note", text: "以下为本次选择快照，可能与最新索引、磁盘文件不同。搜索仅筛选审阅列表。" }),
      q, ui.el("div", { class: "sr-tools" }, [checkButton, cancelCheck, removeMissing, removeMatching]), checkStatus, notice, removal,
    ]), list,
    ui.el("nav", { class: "sr-pager", "aria-label": "已选曲目分页" }, [range, ui.el("div", { class: "spacer" }), previous, pageLabel, next]),
    ui.el("footer", { class: "sr-footer" }, [
      ui.el("p", { text: "操作针对全部已选，不受搜索或分页影响；进入后仍需预览或确认。" }),
      ui.el("div", { class: "sr-handoffs" }, actions),
      ui.el("p", { id: "selection-review-edit-note", class: "sr-edit-note" }, [ui.el("strong", { text: "编辑" }), "统一修改；", ui.el("strong", { text: "逐首编辑" }), "分别修改。"]),
      ui.el("div", { class: "sr-save-row" }, [ui.el("span", { text: "留到下次，换设备也能继续" }), saveCollection]),
    ]),
  );

  const unsubscribe = on("selection:changed", () => {
    if (closed) return;
    const revision = selectionRevision();
    if (members !== revision) {
      members = revision;
      cancelIndex("选择范围已变化，请重新核对索引。");
      if (pendingRemoval) { pendingRemoval = null; removal.hidden = true; notice.textContent = "选择范围已变化，刚才的移除确认已取消。"; }
    }
    rows = selectionRows().map((row) => ({ ...row })); render();
  });
  q.addEventListener("input", () => { page = 1; pendingRemoval = null; removal.hidden = true; render(); list.scrollTop = 0; });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  dialog.addEventListener("close", () => close());
  const unauthorized = () => close({ restoreFocus: false });
  const hashChanged = () => close({ restoreFocus: false });
  window.addEventListener("metatidy:unauthorized", unauthorized);
  window.addEventListener("hashchange", hashChanged);
  closeActive = close;
  document.body.append(dialog); render(); dialog.showModal(); q.focus();

  function close({ restoreFocus = true } = {}) {
    if (closed) return;
    closed = true; cancelIndex(); unsubscribe(); pendingRemoval = null; rows = []; checked = null; cards.clear();
    window.removeEventListener("metatidy:unauthorized", unauthorized); window.removeEventListener("hashchange", hashChanged);
    if (closeActive === close) closeActive = null;
    if (dialog.open) dialog.close(); dialog.remove();
    if (restoreFocus) {
      const fallback = ui.byId("selection-review") || ui.byId("batch-review-selection") || ui.byId("tracks-q");
      const target = opener?.isConnected && opener.getClientRects().length && !opener.closest("[inert]") ? opener : fallback;
      if (target?.getClientRects().length && !target.closest("[inert]")) target.focus({ preventScroll: true });
    }
  }

  function matching() {
    const needle = q.value.trim().toLocaleLowerCase();
    return needle ? rows.filter((row) => [row.id, row.title, row.artist, row.album, row.filename, row.path].some((value) => String(value ?? "").toLocaleLowerCase().includes(needle))) : rows;
  }

  function createCard(row) {
    const title = ui.el("strong", { class: "sr-track-title" });
    const meta = ui.el("span", { class: "sr-track-meta" });
    const path = ui.el("span", { class: "sr-track-path" });
    const status = ui.el("span", { class: "badge badge-mute" });
    const remove = ui.el("button", { type: "button", class: "btn btn-sm btn-ghost sr-remove", text: "移除", dataset: { removeId: row.id }, onClick: () => {
      const visible = [...list.querySelectorAll(".sr-remove")]; const index = visible.indexOf(remove);
      const following = visible[index + 1]?.dataset.removeId || visible[index - 1]?.dataset.removeId;
      removeFromSelection([row.id]);
      (list.querySelector(`[data-remove-id="${following}"]`) || list.querySelector(".sr-remove") || q).focus({ preventScroll: true });
      notice.textContent = "已从选择中移除，音乐文件未改动。";
    } });
    const node = ui.el("article", { class: "sr-track", dataset: { selectionId: row.id } }, [ui.el("div", { class: "sr-track-copy" }, [title, meta, path]), ui.el("div", { class: "sr-track-actions" }, [status, remove])]);
    return { node, title, meta, path, status, remove };
  }

  function render() {
    if (closed) return;
    const filtered = matching(); const pages = Math.ceil(filtered.length / PAGE_SIZE); page = Math.max(1, Math.min(page, pages || 1));
    const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    total.textContent = `全部已选 ${ui.fmtNum(rows.length)} 首 · 当前匹配 ${ui.fmtNum(filtered.length)} 首`;
    removeMatching.textContent = `从选择中移除当前匹配 ${ui.fmtNum(filtered.length)} 首`; removeMatching.disabled = !filtered.length;
    checkButton.disabled = checking || !rows.length; cancelCheck.hidden = !checking;
    checkButton.textContent = checking ? "正在核对全部已选…" : checked ? "重新核对全部已选索引" : "核对全部已选索引";
    const missing = checked ? [...checked.values()].filter((item) => item.status === "missing").length : 0;
    removeMissing.hidden = !missing; removeMissing.textContent = `移除全部索引缺失 ${ui.fmtNum(missing)} 首`;
    for (const button of actions) {
      const actionLabel = button.dataset.action === "scrape" && rows.length === 1 ? "刮削" : button.dataset.label;
      button.textContent = `${actionLabel}全部已选 ${ui.fmtNum(rows.length)} 首`; button.disabled = !rows.length || checking;
    }
    saveCollection.textContent = `保存全部已选 ${ui.fmtNum(rows.length)} 首为清单`;
    saveCollection.disabled = !rows.length || checking;
    previous.disabled = page <= 1; next.disabled = page >= pages;
    pageLabel.textContent = `${page} / ${Math.max(1, pages)}`;
    range.textContent = filtered.length ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, filtered.length)} / ${ui.fmtNum(filtered.length)} 首` : "没有匹配曲目";
    const scroll = list.scrollTop; const focus = list.contains(document.activeElement) ? document.activeElement : null;
    const ids = new Set(visible.map((row) => row.id));
    for (const [id, card] of cards) if (!ids.has(id)) { card.node.remove(); cards.delete(id); }
    list.querySelector(".sr-empty")?.remove();
    visible.forEach((row, index) => {
      const card = cards.get(row.id) || createCard(row); cards.set(row.id, card);
      card.title.textContent = label(row); card.title.title = label(row);
      card.meta.textContent = [row.artist || "未知艺术家", row.album || "未填写专辑", `#${row.id}`].join(" · ");
      card.path.textContent = row.path || row.filename || "快照没有路径"; card.path.title = card.path.textContent;
      const check = checked?.get(row.id);
      card.node.dataset.indexStatus = check?.status || "unchecked";
      card.status.textContent = check ? check.status === "found" ? "索引中存在" : "索引中缺失" : "未核对";
      card.status.className = `badge ${check ? check.status === "found" ? "badge-ok" : "badge-warn" : "badge-mute"}`;
      card.status.title = check ? `核对时间 ${ui.fmtTime(checkedAt)}；未检查磁盘文件。` : "当前显示选择快照，尚未核对曲库索引。";
      card.remove.setAttribute("aria-label", `从选择中移除 ${label(row)}`);
      const at = list.children[index] || null;
      if (at !== card.node) { if (typeof list.moveBefore === "function" && card.node.parentNode === list) list.moveBefore(card.node, at); else list.insertBefore(card.node, at); }
    });
    if (!visible.length) list.append(ui.el("div", { class: "sr-empty" }, [ui.icon("music", { size: 28 }), ui.el("strong", { text: rows.length ? "没有匹配的已选曲目" : "当前没有选择曲目" }), ui.el("p", { text: rows.length ? "换个关键词，或清空搜索查看全部选择。" : "在曲库或刮削页勾选曲目后，可在这里跨页审阅。" })]));
    if (focus?.isConnected && document.activeElement !== focus) focus.focus({ preventScroll: true }); list.scrollTop = scroll;
  }

  function changePage(delta) {
    page += delta; render(); list.scrollTop = 0;
    const button = delta > 0 ? next : previous; (button.disabled ? q : button).focus({ preventScroll: true });
  }

  function askRemoval(ids, scope) {
    if (!ids.length) return;
    pendingRemoval = { ids: [...ids], revision: selectionRevision() };
    removalText.textContent = `将从选择中移除${scope}的 ${ui.fmtNum(ids.length)} 首，包含其他审阅页。只更改勾选范围，不删除或修改音乐文件。`;
    confirmRemoval.textContent = `确认移除 ${ui.fmtNum(ids.length)} 首`; removal.hidden = false; cancelRemoval.focus({ preventScroll: true });
  }

  function applyRemoval() {
    const pending = pendingRemoval; pendingRemoval = null; removal.hidden = true;
    if (!pending || pending.revision !== selectionRevision()) { notice.textContent = "选择范围已变化，请重新审阅后操作。"; return; }
    removeFromSelection(pending.ids); notice.textContent = `已从选择中移除 ${ui.fmtNum(pending.ids.length)} 首，音乐文件未改动。`; q.focus({ preventScroll: true });
  }

  function cancelIndex(message) {
    checkGeneration += 1; controller?.abort(); controller = null; checking = false; checked = null; checkedAt = 0;
    if (message) checkStatus.textContent = message;
  }

  async function checkIndex() {
    if (checking || !rows.length) return;
    const ids = rows.map((row) => row.id); const revision = selectionRevision();
    cancelIndex(); const generation = ++checkGeneration; controller = new AbortController(); const abort = controller;
    checking = true; pendingRemoval = null; removal.hidden = true; notice.textContent = "";
    const found = new Map(); const pages = Math.ceil(ids.length / CHECK_PAGE_SIZE); let counts = null;
    const current = () => !closed && generation === checkGeneration && revision === selectionRevision() && !abort.signal.aborted;
    checkStatus.textContent = `正在核对索引：0 / ${ui.fmtNum(ids.length)} 首。未完成前不使用部分结果。`; render();
    try {
      for (let page = 1; page <= pages; page += 1) {
        const result = await api.trackSelection({ ids, page, page_size: CHECK_PAGE_SIZE }, { signal: abort.signal });
        if (!current()) return;
        const expected = ids.slice((page - 1) * CHECK_PAGE_SIZE, page * CHECK_PAGE_SIZE);
        if (result.total !== ids.length || result.selected_total !== ids.length || result.page !== page || result.page_size !== CHECK_PAGE_SIZE || result.pages !== pages
          || !Array.isArray(result.items) || result.items.length !== expected.length || !Number.isInteger(result.found_total) || !Number.isInteger(result.missing_total)
          || result.found_total < 0 || result.missing_total < 0 || result.found_total + result.missing_total !== ids.length) throw new Error("索引响应的范围不完整，请重新核对。");
        const nextCounts = `${result.found_total}:${result.missing_total}`;
        if (counts && counts !== nextCounts) throw new Error("核对期间曲库索引发生变化，请重新核对。");
        counts = nextCounts;
        for (const [index, item] of result.items.entries()) {
          if (item.id !== expected[index] || found.has(item.id) || !["found", "missing"].includes(item.status)
            || item.status === "found" && Number(item.track?.id) !== item.id || item.status === "missing" && item.track !== null) throw new Error("索引响应的曲目身份不完整，请重新核对。");
          found.set(item.id, item);
        }
        checkStatus.textContent = `正在核对索引：${ui.fmtNum(found.size)} / ${ui.fmtNum(ids.length)} 首。未完成前不使用部分结果。`;
      }
      const missing = [...found.values()].filter((item) => item.status === "missing").length;
      if (found.size !== ids.length || counts !== `${ids.length - missing}:${missing}`) throw new Error("核对期间索引结果不一致，请重新核对。");
      if (!current()) return;
      checked = found; checkedAt = Date.now() / 1000;
      checkStatus.textContent = `核对完成：索引存在 ${ui.fmtNum(ids.length - missing)} 首，缺失 ${ui.fmtNum(missing)} 首。缺失只表示没有曲库记录，磁盘文件未检查。`;
    } catch (error) {
      if (!current()) return;
      checked = null; checkStatus.textContent = `索引核对失败：${error.message} 未采用部分结果，可重新核对。`;
    } finally {
      if (current()) { checking = false; controller = null; render(); if (document.activeElement === document.body) checkButton.focus({ preventScroll: true }); }
    }
  }
}
