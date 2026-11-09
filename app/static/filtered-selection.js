/** Prepare one complete query snapshot before appending to the in-memory selection. */
import { api } from "./api.js";
import * as ui from "./ui.js";
import { on, emit, selectionIds, selectionRevision, selectRows } from "./store.js";

const LIMIT = 20000;
const QUERY_TEXT = ["q", "artist", "album", "language", "albumtype", "genre", "year", "sort", "order", "folder"];
const QUERY_FLAGS = ["folder_recursive", "missing_cover", "missing_lyrics", "no_artist", "no_album", "not_loaded"];
const QUERY_KEYS = [...QUERY_TEXT, ...QUERY_FLAGS, "album_group"];
const ROW_TEXT = ["path", "dir", "filename", "ext", "title", "artist", "album", "albumartist", "genre", "year", "track", "disc", "language", "albumtype"];
const ROW_NUMBERS = ["duration", "indexed_at", "edited_at", "scraped_at", "mtime"];
const ROW_KEYS = ["id", ...ROW_TEXT, ...ROW_NUMBERS, "size", "has_cover", "has_lyrics", "tags_loaded", "path_derived"];
const SORT_LABELS = { artist: "歌手", album: "专辑", title: "标题", year: "年份", track: "轨号", disc_track: "碟号与曲序", path: "路径", indexed: "索引时间", edited: "编辑时间" };
const QUERY_CHANGED = "筛选或排序已变化，本次结果已作废。请重新获取。";
const MEMBERS_CHANGED = "已选曲目发生变化，本次结果已作废。请重新获取。";
const RESULTS_CHANGED = "曲库结果已变化，本次未追加任何曲目。请重新获取后确认。";
const INCOMPLETE = "返回的筛选结果不完整，未追加任何曲目。请重新获取。";
let closeActive = null;

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const focusable = node => node?.isConnected && node.getClientRects().length && !node.closest("[inert]") && !node.matches(":disabled");

function sameQuery(left, right) {
  return exactKeys(left, QUERY_KEYS) && exactKeys(right, QUERY_KEYS)
    && QUERY_TEXT.every(key => typeof left[key] === "string" && left[key] === right[key])
    && QUERY_FLAGS.every(key => typeof left[key] === "boolean" && left[key] === right[key])
    && (left.album_group === null ? right.album_group === null
      : Array.isArray(left.album_group) && left.album_group.length === 2 && Array.isArray(right.album_group)
        && right.album_group.length === 2 && left.album_group.every((value, index) => typeof value === "string" && value === right.album_group[index]));
}

function invalidSnapshot() {
  const error = new Error(INCOMPLETE);
  error.code = "invalid_selection_snapshot";
  return error;
}

/** Never repair a malformed/partial response by dropping rows or coercing IDs. */
function validateSnapshot(data, query, previous = null) {
  if (!exactKeys(data, ["query", "revision", "total", "limit", "items"])
    || !sameQuery(data.query, query) || typeof data.revision !== "string" || !/^[a-f0-9]{64}$/.test(data.revision)
    || data.limit !== LIMIT || !Number.isSafeInteger(data.total) || data.total < 0 || data.total > LIMIT
    || !Array.isArray(data.items) || data.items.length !== data.total) throw invalidSnapshot();
  const ids = new Set();
  for (const row of data.items) {
    if (!exactKeys(row, ROW_KEYS) || !Number.isSafeInteger(row.id) || row.id <= 0 || ids.has(row.id)
      || !ROW_TEXT.every(key => typeof row[key] === "string")
      || !ROW_NUMBERS.every(key => typeof row[key] === "number" && Number.isFinite(row[key]))
      || !Number.isSafeInteger(row.size) || row.size < 0
      || ![0, 1].includes(row.has_cover) || ![0, 1].includes(row.has_lyrics)
      || typeof row.tags_loaded !== "boolean" || typeof row.path_derived !== "boolean") throw invalidSnapshot();
    ids.add(row.id);
  }
  if (previous && (data.revision !== previous.revision || data.total !== previous.total
    || data.items.some((row, index) => ROW_KEYS.some(key => row[key] !== previous.items[index][key])))) {
    const error = new Error(RESULTS_CHANGED);
    error.code = "selection_changed";
    throw error;
  }
  return data;
}

export function closeFilteredSelection({ restoreFocus = false } = {}) {
  closeActive?.({ restoreFocus });
}

/** capture() commits current input drafts; current() only reads the query and generation. */
export function openFilteredSelection({ capture, current, canApply }) {
  if (!canApply() || document.querySelector("dialog[open]")) return;
  closeActive?.({ restoreFocus: false });
  const opener = document.activeElement;
  const tools = ui.byId("library-tools");
  if (tools) tools.open = false;
  let closed = false, requestToken = 0, controller = null, context = null, prepared = null, retryCheck = false;
  const dialog = ui.el("dialog", { id: "filtered-selection-dialog", class: "filtered-selection", "aria-labelledby": "filtered-selection-title", "aria-describedby": "filtered-selection-description" });
  const title = ui.el("h2", { id: "filtered-selection-title", tabindex: "-1", text: "选择全部筛选结果" });
  const closeButton = ui.el("button", { id: "filtered-selection-close", type: "button", class: "btn btn-ghost fs-close", "aria-label": "关闭全部筛选结果选择", onClick: () => close() }, [ui.icon("close", { size: 18 })]);
  const scope = ui.el("ul", { id: "filtered-selection-scope", class: "fs-scope", "aria-label": "本次筛选范围" });
  const scopeNote = ui.el("p", { class: "fs-scope-note" });
  const status = ui.el("p", { id: "filtered-selection-status", class: "fs-status", role: "status", "aria-live": "polite", "aria-atomic": "true" });
  const countNodes = {};
  const counts = ui.el("dl", { id: "filtered-selection-counts", class: "fs-counts", hidden: true }, [
    ["matched", "本次匹配"], ["existing", "其中已选"], ["new", "将追加"], ["union", "追加后已选"],
  ].map(([key, label]) => {
    countNodes[key] = ui.el("dd", { id: `filtered-selection-${key}`, text: "—" });
    return ui.el("div", { class: `fs-count fs-count-${key}` }, [ui.el("dt", { text: label }), countNodes[key]]);
  }));
  const sampleList = ui.el("ol", { id: "filtered-selection-samples", class: "fs-samples" });
  const sampleNote = ui.el("p", { class: "fs-sample-note" });
  const samples = ui.el("section", { class: "fs-sample-section", hidden: true, "aria-label": "范围中的曲目示例" }, [
    ui.el("div", { class: "fs-section-label" }, [ui.el("h3", { text: "范围中的曲目" }), sampleNote]), sampleList,
  ]);
  const body = ui.el("div", { class: "fs-body" }, [
    ui.el("section", { class: "fs-scope-section" }, [ui.el("h3", { text: "本次范围" }), scope, scopeNote]),
    status, counts, samples,
  ]);
  const cancel = ui.el("button", { id: "filtered-selection-cancel", type: "button", class: "btn btn-ghost", text: "取消", onClick: () => close() });
  const retry = ui.el("button", { id: "filtered-selection-retry", type: "button", class: "btn", text: "重新获取", hidden: true, onClick: () => void (retryCheck ? confirm() : prepare()) });
  const confirmButton = ui.el("button", { id: "filtered-selection-confirm", type: "button", class: "btn btn-primary", text: "获取结果后确认", disabled: true, onClick: () => void confirm() });
  dialog.append(
    ui.el("header", { class: "fs-head" }, [
      ui.el("span", { class: "fs-mark", "aria-hidden": "true" }, [ui.icon("filter", { size: 22 })]),
      ui.el("div", { class: "fs-heading" }, [ui.el("p", { class: "eyebrow", text: "跨页选择" }), title, ui.el("p", { id: "filtered-selection-description", text: "将当前筛选范围加入已选曲目" })]), closeButton,
    ]), body,
    ui.el("footer", { class: "fs-foot" }, [
      ui.el("p", { text: "保留已有选择，新曲目按当前排序追加。确认后可审阅全部已选。" }),
      ui.el("div", { class: "fs-actions" }, [cancel, retry, confirmButton]),
    ]),
  );

  function stopRequest() {
    requestToken += 1;
    controller?.abort(); controller = null;
  }
  function renderPhase(phase, message) {
    const focused = document.activeElement;
    dialog.dataset.phase = phase;
    status.textContent = message;
    const busy = phase === "loading" || phase === "checking";
    status.setAttribute("aria-busy", String(busy));
    confirmButton.disabled = phase !== "ready";
    confirmButton.hidden = !["loading", "ready", "checking"].includes(phase);
    retry.hidden = !["stale", "error", "over-limit"].includes(phase);
    retry.textContent = retryCheck ? "重试核对" : "重新获取";
    if (phase === "checking") confirmButton.textContent = "正在核对…";
    else if (phase === "loading") confirmButton.textContent = "获取结果后确认";
    if ((focused === confirmButton && confirmButton.disabled)
      || (focused === retry && retry.hidden)) (retry.hidden ? cancel : retry).focus({ preventScroll: true });
  }
  function invalidate(message) {
    if (closed || !context) return;
    stopRequest(); prepared = null; retryCheck = false;
    counts.hidden = true; samples.hidden = true; sampleList.replaceChildren();
    renderPhase("stale", message);
  }
  function guard(token = requestToken) {
    if (closed || token !== requestToken || !context) return false;
    if (!dialog.open || !dialog.isConnected || !canApply()) { close({ restoreFocus: false }); return false; }
    const now = current();
    if (now.generation !== context.generation || !sameQuery(now.query, context.query)) { invalidate(QUERY_CHANGED); return false; }
    if (selectionRevision() !== context.members) { invalidate(MEMBERS_CHANGED); return false; }
    return true;
  }
  function drawScope(query, selectedCount) {
    const parts = [];
    if (query.q) parts.push(["搜索", query.q]);
    if (query.folder) parts.push(["目录", `${query.folder}${query.folder_recursive ? "（含子目录）" : "（仅本层）"}`]);
    if (query.album_group) parts.push(["专辑分组", `${query.album_group[0]} · ${query.album_group[1] || "未知专辑艺术家"}`]);
    for (const [key, label] of [["artist", "艺术家"], ["album", "专辑"], ["language", "语言"], ["albumtype", "专辑类型"], ["genre", "流派"], ["year", "年份"]]) {
      if (query[key]) parts.push([label, query[key]]);
    }
    for (const [key, label] of [["missing_cover", "待补封面"], ["missing_lyrics", "待补歌词"], ["no_artist", "缺少艺术家"], ["no_album", "缺少专辑"], ["not_loaded", "未读取标签"]]) {
      if (query[key]) parts.push(["条件", label]);
    }
    if (!parts.length) parts.push(["范围", "整个曲库"]);
    parts.push(["排序", `${SORT_LABELS[query.sort] || query.sort} · ${query.order === "desc" ? "降序" : "升序"}`]);
    scope.replaceChildren(...parts.map(([label, value]) => ui.el("li", {}, [ui.el("span", { text: label }), ui.el("strong", { text: value, title: value })])));
    scopeNote.textContent = `已有选择 ${ui.fmtNum(selectedCount)} 首 · 每次匹配与追加后已选均最多 ${ui.fmtNum(LIMIT)} 首`;
  }
  function drawSnapshot(snapshot) {
    const newRows = snapshot.items.filter(row => !context.ids.has(row.id));
    const union = context.ids.size + newRows.length;
    for (const [key, value] of Object.entries({ matched: snapshot.total, existing: snapshot.total - newRows.length, new: newRows.length, union })) {
      countNodes[key].textContent = ui.fmtNum(value);
    }
    counts.hidden = false;
    const exampleRows = snapshot.items.slice(0, 3);
    samples.hidden = !exampleRows.length;
    sampleNote.textContent = `前 ${exampleRows.length} 首 · 共 ${ui.fmtNum(snapshot.total)} 首`;
    sampleList.replaceChildren(...exampleRows.map((row, index) => ui.el("li", { dataset: { id: row.id } }, [
      ui.el("span", { class: "fs-sample-number", text: String(index + 1).padStart(2, "0") }),
      ui.el("div", { class: "fs-sample-copy" }, [ui.el("strong", { text: row.title || row.filename, title: row.path }), ui.el("span", { text: `${row.artist || "未知艺术家"} · ${row.album || "未知专辑"}` })]),
      ui.el("span", { class: `fs-sample-state${context.ids.has(row.id) ? " is-selected" : ""}`, text: context.ids.has(row.id) ? "已选" : "待追加" }),
    ])));
    if (union > LIMIT) {
      prepared = null;
      renderPhase("over-limit", "追加后将超过 20,000 首。请缩小筛选范围或减少已有选择。");
      return;
    }
    prepared = snapshot;
    confirmButton.textContent = newRows.length ? `追加 ${ui.fmtNum(newRows.length)} 首并审阅` : "审阅当前选择";
    renderPhase(snapshot.total ? "ready" : "empty", snapshot.total
      ? (newRows.length ? "已获取完整范围。确认时会再次核对结果，然后加入选择。" : "这些曲目均已在当前选择中。")
      : "当前筛选没有匹配曲目，请调整条件后重试。");
  }
  function showError(error, checking) {
    if (error.status === 401) { close({ restoreFocus: false }); return; }
    if (error.code === "selection_changed") { invalidate(RESULTS_CHANGED); return; }
    if (error.code === "selection_limit_exceeded") {
      prepared = null; retryCheck = false; counts.hidden = true; samples.hidden = true; sampleList.replaceChildren();
      renderPhase("over-limit", "匹配结果超过 20,000 首。请缩小筛选范围后再选择。");
      return;
    }
    if (error.code === "invalid_selection_snapshot") {
      prepared = null; retryCheck = false; counts.hidden = true; samples.hidden = true; sampleList.replaceChildren();
      renderPhase("error", INCOMPLETE);
      return;
    }
    retryCheck = checking && Boolean(prepared);
    const prefix = checking ? "暂时无法核对结果，未追加任何曲目。" : "获取筛选结果失败，未追加任何曲目。";
    renderPhase("error", `${prefix}${error.message ? ` ${error.message}` : ""}`);
  }
  async function prepare() {
    if (closed || !canApply()) { close({ restoreFocus: false }); return; }
    stopRequest(); context = null; prepared = null; retryCheck = false;
    counts.hidden = true; samples.hidden = true; sampleList.replaceChildren();
    const captured = capture();
    context = { ...captured, members: selectionRevision(), ids: new Set(selectionIds()) };
    drawScope(context.query, context.ids.size);
    renderPhase("loading", "正在获取全部筛选结果…");
    const token = requestToken;
    controller = new AbortController();
    try {
      const data = await api.filteredSelection({ query: context.query }, { signal: controller.signal });
      if (!guard(token)) return;
      drawSnapshot(validateSnapshot(data, context.query));
    } catch (error) {
      if (guard(token)) showError(error, false);
    } finally { if (token === requestToken) controller = null; }
  }
  async function confirm() {
    if (!["ready", "error"].includes(dialog.dataset.phase) || !prepared || !guard()) return;
    const snapshot = prepared;
    stopRequest(); retryCheck = false;
    const token = requestToken;
    controller = new AbortController();
    renderPhase("checking", "正在核对结果是否变化…");
    try {
      const data = await api.filteredSelection({ query: snapshot.query, revision: snapshot.revision }, { signal: controller.signal });
      if (!guard(token)) return;
      validateSnapshot(data, context.query, snapshot);
      const newRows = snapshot.items.filter(row => !context.ids.has(row.id));
      if (context.ids.size + newRows.length > LIMIT) {
        prepared = null;
        renderPhase("over-limit", "追加后将超过 20,000 首。请缩小筛选范围或减少已有选择。");
        return;
      }
      if (!guard(token)) return;
      const committedContext = context;
      // Closing releases our listeners, but native focus restoration can run
      // synchronous application handlers. Recheck once more before appending.
      close({ restoreFocus: false });
      if (!canApply()) return;
      const now = current();
      if (now.generation !== committedContext.generation || !sameQuery(now.query, committedContext.query)) {
        ui.toast("warn", "未追加曲目", QUERY_CHANGED); return;
      }
      if (selectionRevision() !== committedContext.members) {
        ui.toast("warn", "未追加曲目", MEMBERS_CHANGED); return;
      }
      if (newRows.length) selectRows(newRows);
      const review = ui.byId("selection-review");
      if (focusable(review)) review.focus({ preventScroll: true });
      emit("library:review-selection");
    } catch (error) {
      if (guard(token)) showError(error, true);
    } finally { if (token === requestToken) controller = null; }
  }

  const unsubscribeScope = on("tracks:query-changed", () => invalidate(QUERY_CHANGED));
  const unsubscribeSelection = on("selection:changed", () => {
    if (context && selectionRevision() !== context.members) invalidate(MEMBERS_CHANGED);
  });
  const leave = () => close({ restoreFocus: false });
  for (const name of ["metatidy:unauthorized", "metatidy:logout", "hashchange"]) window.addEventListener(name, leave);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("close", () => close());
  dialog.addEventListener("keydown", event => {
    if (event.key === "Escape") event.stopPropagation();
    if (event.key !== "Tab") return;
    const buttons = [...dialog.querySelectorAll("button")].filter(focusable);
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === title)) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  function close({ restoreFocus = true } = {}) {
    if (closed) return;
    closed = true; stopRequest(); context = null; prepared = null;
    unsubscribeScope(); unsubscribeSelection();
    for (const name of ["metatidy:unauthorized", "metatidy:logout", "hashchange"]) window.removeEventListener(name, leave);
    if (closeActive === close) closeActive = null;
    if (dialog.open) dialog.close();
    dialog.remove();
    if (restoreFocus) {
      const target = [opener, ui.byId("library-tools-toggle"), ui.byId("tracks-q")].find(focusable);
      target?.focus({ preventScroll: true });
    }
  }
  closeActive = close;
  document.body.append(dialog); dialog.showModal(); title.focus({ preventScroll: true });
  void prepare();
}
