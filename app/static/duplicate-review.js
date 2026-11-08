/** Read-only metadata groups. Every selection addition validates the whole group revision. */
import { api } from "./api.js";
import * as ui from "./ui.js";
import { on, emit, isSelected, selectRows, selectionCount, selectionRevision } from "./store.js";

const GROUP_SIZE = 20;
const FILE_SIZE = 50;
const REVISION = /^[a-f0-9]{32}$/;
const TRACK_FIELDS = ["id", "path", "dir", "filename", "ext", "title", "artist", "album", "albumartist", "genre", "year", "track", "disc", "language", "albumtype", "has_cover", "has_lyrics", "duration", "indexed_at", "edited_at", "scraped_at", "mtime", "size", "tags_loaded", "path_derived"];
const text = value => typeof value === "string" ? value : "";
const nonblankTag = value => text(value).replace(/^ +| +$/g, "").length > 0;
const validId = value => Number.isSafeInteger(value) && value > 0;
const groupKey = value => Array.isArray(value) && value.length === 2 && value.every(part => typeof part === "string" && part.length) ? JSON.stringify(value) : "";
const snapshot = row => JSON.stringify(TRACK_FIELDS.map(key => row[key]));
const missing = value => value === null || value === undefined || value === "";
const shown = value => missing(value) ? "未记录" : String(value);
const positive = value => typeof value === "number" && Number.isFinite(value) && value > 0;
const btn = (id, label, action, cls = "") => ui.el("button", { id, type: "button", class: `btn btn-sm ${cls}`.trim(), text: label, onClick: action });
let activeClose = null;
let activeInvalidate = null;

export function invalidateDuplicateReview() { activeInvalidate?.(); }

export function openDuplicateReview() {
  activeClose?.({ restoreFocus: false });
  const opener = document.activeElement;
  let closed = false, markedDirty = false, detailStale = false;
  let groupsLoading = false, groupsPage = 1, groupsPages = 1, groupsTotal = 0, groupsReady = false;
  let currentGroup = null, currentKey = "", revision = "", total = 0, filePage = 1, filePages = 1, detailReady = false, detailLoading = false;
  let groupsGeneration = 0, detailGeneration = 0, addGeneration = 0;
  let groupsController = null, detailController = null, addController = null, addingId = 0;
  let expectedSelection = selectionRevision();
  let currentRows = [];
  const knownPages = new Map(), knownIds = new Map();
  const dialog = ui.el("dialog", { id: "duplicate-review-dialog", class: "duplicate-review", "aria-labelledby": "duplicate-review-title" });
  const closeButton = btn("duplicate-review-close", "关闭", () => close(), "btn-ghost");
  const refresh = btn("duplicate-review-refresh", "刷新核对", () => { markedDirty = false; void loadGroups(1); }, "btn-ghost");
  const q = ui.el("input", { id: "duplicate-review-q", type: "search", autocomplete: "off", maxlength: 200, placeholder: "搜索歌手或曲名…", "aria-label": "搜索疑似重复分组" });
  const search = btn("duplicate-review-search", "搜索", () => void loadGroups(1));
  const groupStatus = ui.el("p", { id: "duplicate-review-group-status", class: "dr-status", role: "status" });
  const groupList = ui.el("div", { id: "duplicate-review-groups", class: "dr-group-list", "aria-label": "疑似重复分组" });
  const groupPrev = btn("duplicate-review-groups-prev", "上一页", () => void loadGroups(groupsPage - 1));
  const groupNext = btn("duplicate-review-groups-next", "下一页", () => void loadGroups(groupsPage + 1));
  const groupPage = ui.el("span", { id: "duplicate-review-groups-page", text: "1 / 1" });
  const heading = ui.el("h3", { id: "duplicate-review-group-title", text: "选择一组，逐份核对" });
  const artist = ui.el("p", { id: "duplicate-review-artist", class: "dr-artist" });
  const facts = ui.el("div", { id: "duplicate-review-facts", class: "dr-facts" });
  const detailStatus = ui.el("p", { id: "duplicate-review-detail-status", class: "dr-status", role: "status" });
  const retry = btn("duplicate-review-detail-retry", "重新读取这组", () => void loadDetails(1, true));
  retry.hidden = true;
  const difference = ui.el("p", { id: "duplicate-review-differences", class: "dr-differences" });
  const list = ui.el("div", { id: "duplicate-review-files", class: "dr-files", "aria-label": "文件差异对比", tabindex: -1 });
  const filePrev = btn("duplicate-review-files-prev", "上一页", () => void loadDetails(filePage - 1));
  const fileNext = btn("duplicate-review-files-next", "下一页", () => void loadDetails(filePage + 1));
  const filePageLabel = ui.el("span", { id: "duplicate-review-files-page", text: "— / —" });
  const range = ui.el("span", { id: "duplicate-review-range", text: "尚未选择分组" });
  const changeGroup = btn("duplicate-review-change-group", "切换分组", () => {
    dialog.dataset.showGroups = "true";
    (groupList.querySelector('.dr-group[aria-pressed="true"]') || q).focus({ preventScroll: true });
  }, "btn-ghost dr-change-group");
  const notice = ui.el("p", { id: "duplicate-review-notice", class: "dr-notice", role: "status", hidden: true });
  const addStatus = ui.el("p", { id: "duplicate-review-add-status", class: "dr-add-status", role: "status", text: "逐行核对后加入已有选择，可继续到已选审阅。" });
  const review = btn("duplicate-review-selection", "审阅已选", () => { close({ restoreFocus: false }); emit("library:review-selection"); }, "btn-primary");
  const selection = ui.el("span", { id: "duplicate-review-selection-count", class: "dr-selection-count" });
  dialog.append(
    ui.el("header", { class: "dr-head" }, [ui.el("div", {}, [ui.el("p", { class: "eyebrow", text: "COMPARE YOUR COLLECTION" }), ui.el("h2", { id: "duplicate-review-title", text: "疑似重复曲目核对" })]), ui.el("div", { class: "dr-head-actions" }, [refresh, closeButton])]),
    ui.el("p", { class: "dr-scope", text: "已读取标签中，歌手与曲名忽略首尾空格及大小写后相同。同名版本需人工核对；未比较音频内容。" }), notice,
    ui.el("div", { class: "dr-layout" }, [
      ui.el("aside", { class: "dr-groups", "aria-label": "选择待核对分组" }, [ui.el("form", { class: "dr-search", onSubmit: event => { event.preventDefault(); void loadGroups(1); } }, [q, search]), groupStatus, groupList, ui.el("nav", { class: "dr-pager dr-groups-pager", "aria-label": "分组分页" }, [groupPrev, groupPage, groupNext])]),
      ui.el("section", { class: "dr-comparison" }, [ui.el("div", { class: "dr-comparison-head" }, [ui.el("div", { class: "dr-comparison-heading" }, [ui.el("span", { class: "dr-kicker", text: "文件对照" }), changeGroup]), heading, artist, facts]), ui.el("div", { class: "dr-detail-state" }, [detailStatus, retry]), difference, list, ui.el("nav", { class: "dr-pager dr-files-pager", "aria-label": "组内文件分页" }, [range, ui.el("div", { class: "spacer" }), filePrev, filePageLabel, fileNext])]),
    ]),
    ui.el("footer", { class: "dr-footer" }, [ui.el("div", {}, [selection, addStatus]), review]),
  );

  const unsubscribe = on("selection:changed", () => {
    if (closed) return;
    if (addingId && expectedSelection !== selectionRevision()) cancelAdd("已有选择范围发生变化，本次加入已取消，请重新核对。");
    sync();
  });
  const unauthorized = () => close({ restoreFocus: false });
  const hashChanged = () => close({ restoreFocus: false });
  q.addEventListener("input", () => {
    groupsGeneration++; groupsController?.abort(); groupsLoading = false; groupsReady = false;
    groupList.replaceChildren(); resetDetail(); groupStatus.textContent = "搜索已修改，按 Enter 或点击搜索。"; sync();
  });
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("close", () => close());
  window.addEventListener("metatidy:unauthorized", unauthorized);
  window.addEventListener("hashchange", hashChanged);
  activeClose = close;
  activeInvalidate = () => {
    if (closed) return;
    markedDirty = true; cancelAdd("曲库索引已更新，请刷新核对后继续加入。");
    notice.textContent = "曲库索引有更新。当前对照保持不变，刷新核对后再加入选择。"; notice.hidden = false; sync();
  };
  document.body.append(dialog); renderEmpty(); sync(); dialog.showModal(); q.focus(); void loadGroups(1);

  function close({ restoreFocus = true } = {}) {
    if (closed) return;
    closed = true; groupsGeneration++; detailGeneration++; groupsController?.abort(); detailController?.abort(); cancelAdd(); unsubscribe();
    window.removeEventListener("metatidy:unauthorized", unauthorized); window.removeEventListener("hashchange", hashChanged);
    if (activeClose === close) { activeClose = null; activeInvalidate = null; }
    if (dialog.open) dialog.close(); dialog.remove();
    const target = opener?.isConnected && opener.getClientRects().length && !opener.closest("[inert]") ? opener : ui.byId("btn-duplicates") || ui.byId("tracks-q");
    if (restoreFocus && target?.getClientRects().length && !target.closest("[inert]")) target.focus({ preventScroll: true });
  }
  function cancelAdd(value) {
    addGeneration++; addController?.abort(); addController = null; addingId = 0;
    if (value) addStatus.textContent = value;
  }
  function resetDetail() {
    detailGeneration++; detailController?.abort(); cancelAdd(); currentGroup = null; currentKey = revision = "";
    currentRows = []; total = 0; filePage = filePages = 1; detailReady = detailLoading = detailStale = false; knownPages.clear(); knownIds.clear();
    dialog.dataset.hasGroup = "false"; dialog.dataset.showGroups = "true";
    heading.textContent = "选择一组，逐份核对"; artist.textContent = ""; facts.replaceChildren(); detailStatus.textContent = ""; difference.textContent = ""; retry.hidden = true; renderEmpty();
  }
  function renderEmpty() {
    list.replaceChildren(ui.el("div", { class: "dr-empty" }, [ui.icon("copy", { size: 42 }), ui.el("h4", { text: "相同曲名，可能是不同收藏。" }), ui.el("p", { text: "从左侧选择一组，比较专辑、格式、时长和文件路径，再逐行加入选择。" })]));
  }
  function sync() {
    if (closed) return;
    search.disabled = groupsLoading; refresh.disabled = groupsLoading || detailLoading;
    groupPrev.disabled = groupsLoading || !groupsReady || groupsPage <= 1; groupNext.disabled = groupsLoading || !groupsReady || groupsPage >= groupsPages;
    groupPage.textContent = groupsReady ? `${groupsPage} / ${groupsPages}` : "— / —";
    groupList.setAttribute("aria-busy", String(groupsLoading)); list.setAttribute("aria-busy", String(detailLoading));
    filePrev.disabled = detailLoading || detailStale || !detailReady || filePage <= 1;
    fileNext.disabled = detailLoading || detailStale || !detailReady || filePage >= filePages;
    filePageLabel.textContent = detailReady ? `${filePage} / ${filePages}` : "— / —";
    range.textContent = detailReady ? `${(filePage - 1) * FILE_SIZE + 1}–${Math.min(filePage * FILE_SIZE, total)} / ${ui.fmtNum(total)} 份文件` : currentGroup ? "等待读取文件" : "尚未选择分组";
    selection.textContent = `已有选择 ${ui.fmtNum(selectionCount())} 首`; review.disabled = !selectionCount() || Boolean(addingId);
    list.querySelectorAll(".dr-add").forEach(node => {
      const id = Number(node.dataset.id), selected = isSelected(id);
      node.textContent = selected ? "已在选择中" : addingId === id ? "正在核对…" : "加入选择";
      node.disabled = selected || Boolean(addingId) || detailLoading || !detailReady || detailStale || markedDirty;
      node.closest(".dr-file").dataset.selected = String(selected);
    });
    notice.hidden = !markedDirty;
  }
  function validatePagination(data, size, requested, minimum = 0) {
    if (!Number.isSafeInteger(data.total) || data.total < minimum || data.page_size !== size || !Array.isArray(data.items)
      || data.pages !== Math.ceil(data.total / size) || data.page !== Math.max(1, Math.min(Math.max(1, data.pages), requested))
      || data.items.length !== Math.min(size, Math.max(0, data.total - (data.page - 1) * size))) throw new Error("返回的分页范围不完整，请重新读取。");
  }
  async function loadGroups(wanted = 1) {
    if (closed) return;
    const focused = document.activeElement;
    groupsController?.abort(); const abort = new AbortController(); groupsController = abort; const request = ++groupsGeneration;
    groupsLoading = true; groupsReady = false; groupList.replaceChildren(); resetDetail(); groupStatus.textContent = "正在核对标签索引…"; sync();
    try {
      const data = await api.duplicateGroups({ q: q.value.trim(), page: wanted, page_size: GROUP_SIZE }, { signal: abort.signal });
      if (closed || request !== groupsGeneration) return;
      validatePagination(data, GROUP_SIZE, wanted);
      const keys = new Set();
      for (const item of data.items) { const key = groupKey(item.group); if (!key || keys.has(key) || !Number.isSafeInteger(item.track_count) || item.track_count < 2 || !text(item.artist) || !text(item.title)) throw new Error("分组资料不完整，请重新读取。"); keys.add(key); }
      groupsPage = data.page; groupsPages = Math.max(1, data.pages); groupsTotal = data.total; groupsReady = true;
      groupStatus.textContent = data.total ? `共 ${ui.fmtNum(groupsTotal)} 组 · 仅依据真实标签` : q.value.trim() ? "没有匹配的疑似重复分组。" : "暂未发现符合条件的分组。未读标签和路径推断记录不参与核对。";
      groupList.replaceChildren(...data.items.map((item, index) => {
        const select = ui.el("button", { class: "dr-group", type: "button", dataset: { group: groupKey(item.group) }, "aria-pressed": "false", style: { "--dr-delay": `${Math.min(index, 5) * 25}ms` }, onClick: () => {
          resetDetail(); currentGroup = item; currentKey = groupKey(item.group); heading.textContent = item.title; artist.textContent = item.artist;
          dialog.dataset.hasGroup = "true"; dialog.dataset.showGroups = "false";
          groupList.querySelectorAll(".dr-group").forEach(node => node.setAttribute("aria-pressed", String(node === select)));
          void loadDetails(1, true);
        } }, [ui.el("span", { class: "dr-group-copy" }, [ui.el("strong", { text: item.title }), ui.el("span", { text: item.artist })]), ui.el("span", { class: "dr-group-count", text: `${item.track_count} 份` })]);
        return select;
      }));
    } catch (error) { if (!closed && request === groupsGeneration && !abort.signal.aborted) groupStatus.textContent = `分组读取失败：${error.message}。可点击搜索重试。`; }
    finally { if (!closed && request === groupsGeneration) { groupsLoading = false; sync(); restoreControl(focused, [groupPrev, groupNext, search, refresh], q); } }
  }
  function restoreControl(focused, controls, fallback) {
    if (controls.includes(focused) && (document.activeElement === document.body || document.activeElement === dialog)) (!focused.disabled && focused.isConnected ? focused : fallback).focus({ preventScroll: true });
  }
  async function loadDetails(wanted = 1, reset = false) {
    if (closed || !currentGroup) return;
    cancelAdd(); const focused = document.activeElement; const key = currentKey;
    detailController?.abort(); const abort = new AbortController(); detailController = abort; const request = ++detailGeneration;
    if (reset) { revision = ""; detailReady = false; knownIds.clear(); knownPages.clear(); }
    const expectedRevision = revision;
    detailLoading = true; detailStale = false; currentRows = []; list.replaceChildren(); difference.textContent = ""; detailStatus.textContent = "正在读取这一组文件资料…"; retry.hidden = true; sync();
    try {
      const data = await api.duplicateDetail({ group: key, page: wanted, page_size: FILE_SIZE, ...(expectedRevision ? { revision: expectedRevision } : {}) }, { signal: abort.signal });
      if (closed || request !== detailGeneration || key !== currentKey) return;
      validatePagination(data, FILE_SIZE, wanted, 2);
      if (groupKey(data.group) !== key || !REVISION.test(data.revision || "") || expectedRevision && data.revision !== expectedRevision || !data.summary) throw new Error("分组身份或版本已变化，请重新读取这一组。");
      let last = 0;
      const ids = [];
      for (const row of data.items) {
        if (!validId(row.id) || row.id <= last || row.tags_loaded !== true || row.path_derived !== false || !nonblankTag(row.artist) || !nonblankTag(row.title) || typeof row.path !== "string" || knownIds.has(row.id) && knownIds.get(row.id) !== data.page) throw new Error("文件身份、标签来源或分页顺序不一致，请刷新这一组。");
        last = row.id; ids.push(row.id);
      }
      const previous = knownPages.get(data.page);
      if (previous && JSON.stringify(previous) !== JSON.stringify(ids) || expectedRevision && total !== data.total) throw new Error("同一版本的文件范围不一致，请重新读取。");
      revision = data.revision; total = data.total; filePage = data.page; filePages = data.pages; detailReady = true; currentRows = data.items;
      knownPages.set(filePage, ids); ids.forEach(id => knownIds.set(id, filePage));
      renderSummary(data.summary); renderFiles(data.items); detailStatus.textContent = "只展示索引资料，未读取或检查磁盘文件。";
      if (window.matchMedia("(max-width: 700px)").matches && groupList.contains(document.activeElement)) changeGroup.focus({ preventScroll: true });
    } catch (error) {
      if (closed || request !== detailGeneration || abort.signal.aborted) return;
      detailReady = false; detailStale = true; detailStatus.textContent = `这一组暂时无法核对：${error.message}`; retry.hidden = false;
    } finally { if (!closed && request === detailGeneration) { detailLoading = false; sync(); restoreControl(focused, [filePrev, fileNext, retry], retry.hidden ? closeButton : retry); } }
  }
  function renderSummary(summary) {
    const duration = positive(summary.duration_min) ? summary.duration_min === summary.duration_max ? ui.fmtDuration(summary.duration_min) : `${ui.fmtDuration(summary.duration_min)}–${ui.fmtDuration(summary.duration_max)}` : "时长未记录";
    facts.replaceChildren(...[`${ui.fmtNum(total)} 份文件`, `${ui.fmtBytes(summary.bytes)} 合计`, duration, Array.isArray(summary.formats) && summary.formats.length ? summary.formats.map(value => String(value).toUpperCase()).join(" / ") : "格式未记录"].map(value => ui.el("span", { text: value })));
  }
  function renderFiles(rows) {
    const fields = [
      ["album", "专辑", row => shown(row.album)], ["year", "年份", row => shown(row.year)],
      ["ext", "格式", row => text(row.ext).toUpperCase() || "未记录"], ["duration", "时长", row => positive(row.duration) ? ui.fmtDuration(row.duration) : "未记录"],
      ["size", "大小", row => typeof row.size === "number" && Number.isFinite(row.size) && row.size >= 0 ? ui.fmtBytes(row.size) : "未记录"],
      ["has_cover", "封面", row => row.has_cover ? "已有标记" : "未标记"], ["has_lyrics", "歌词", row => row.has_lyrics ? "已有标记" : "未标记"],
    ];
    const different = new Set(fields.filter(([key]) => new Set(rows.map(row => row[key] === null || row[key] === undefined || row[key] === "" ? "" : String(row[key]))).size > 1).map(([key]) => key));
    difference.textContent = rows.length > 1 ? different.size ? `本页有差异：${fields.filter(([key]) => different.has(key)).map(([, label]) => label).join("、")}。轻色标记仅表示不同。` : "本页比较字段相同，请继续核对文件路径与版本；这不代表音频相同。" : "本页仅显示一份文件，请结合前后页核对。";
    list.replaceChildren(...rows.map((row, index) => {
      const add = ui.el("button", { class: "btn btn-sm dr-add", type: "button", dataset: { id: row.id }, text: "加入选择", onClick: () => void addOne(row, add) });
      const copy = ui.el("button", { class: "btn btn-sm btn-ghost dr-copy", type: "button", "aria-label": `复制文件 ${row.id} 的路径`, text: "复制路径", onClick: async () => {
        try { await navigator.clipboard.writeText(row.path); if (!closed && copy.isConnected) { addStatus.textContent = `已复制文件 #${row.id} 的路径。`; } }
        catch { if (!closed) addStatus.textContent = "未能复制，可从路径文本中选取复制。"; }
      } });
      return ui.el("article", { class: "dr-file", dataset: { id: row.id, selected: String(isSelected(row.id)) }, style: { "--dr-delay": `${Math.min(index, 5) * 25}ms` } }, [
        ui.el("div", { class: "dr-file-head" }, [ui.el("span", { class: "dr-file-number", text: String((filePage - 1) * FILE_SIZE + index + 1).padStart(2, "0") }), ui.el("div", { class: "dr-file-name" }, [ui.el("strong", { text: row.filename || row.title }), ui.el("span", { text: `${row.artist} · ${row.title} · #${row.id}` })]), add]),
        ui.el("dl", { class: "dr-file-fields" }, fields.map(([key, label, format]) => ui.el("div", { class: "dr-field", dataset: { different: String(different.has(key)) } }, [ui.el("dt", { text: label }), ui.el("dd", { text: format(row) })]))),
        ui.el("div", { class: "dr-path-line" }, [ui.el("code", { class: "dr-path", text: row.path }), copy]),
        ui.el("p", { class: "dr-file-index", text: `最近索引：${positive(row.indexed_at) ? ui.fmtTime(row.indexed_at) : "未记录"} · 已读取标签` }),
      ]);
    })); list.scrollTop = 0;
    if (window.matchMedia("(max-width: 700px)").matches) list.closest(".dr-comparison").scrollTop = 0;
  }
  async function addOne(row, control) {
    if (closed || addingId || !detailReady || detailLoading || detailStale || markedDirty || isSelected(row.id)) return;
    const key = currentKey, expectedRevision = revision, expectedPage = filePage, expectedSnapshot = snapshot(row), expectedTotal = total;
    expectedSelection = selectionRevision();
    const members = expectedSelection, token = ++addGeneration, abort = new AbortController(); addController = abort; addingId = row.id;
    const current = () => !closed && token === addGeneration && key === currentKey && revision === expectedRevision && filePage === expectedPage && members === selectionRevision() && !markedDirty && !abort.signal.aborted;
    addStatus.textContent = `正在核对文件 #${row.id} 与整组版本…`; sync();
    try {
      const data = await api.duplicateSelection({ group: currentGroup.group, revision: expectedRevision, track_id: row.id }, { signal: abort.signal });
      if (!current()) return;
      if (groupKey(data.group) !== key || data.revision !== expectedRevision || data.total !== expectedTotal || data.track?.id !== row.id || snapshot(data.track) !== expectedSnapshot || !positive(data.selected_at)) throw new Error("单行核对返回的身份或资料不一致，请重新读取这一组。");
      addingId = 0; addController = null; addGeneration++;
      selectRows([data.track], true);
      addStatus.textContent = `已将文件 #${row.id} 追加到选择。可继续核对，或审阅已选。`;
      sync();
      const following = [...list.querySelectorAll(".dr-add")].find(node => !node.disabled);
      (following || review).focus({ preventScroll: true });
    } catch (error) {
      if (!current()) return;
      detailStale = true; detailReady = false; retry.hidden = false;
      addStatus.textContent = `未加入选择：${error.message}。请重新读取这一组。`;
    } finally {
      if (!closed && token === addGeneration) { addingId = 0; addController = null; sync(); if (document.activeElement === document.body || document.activeElement === dialog) (control.isConnected && !control.disabled ? control : retry).focus({ preventScroll: true }); }
    }
  }
}
