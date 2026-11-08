/** Persistent, ordered track references. This page never reads or writes music files. */
import { api } from "./api.js";
import * as ui from "./ui.js";
import { on, emit, selectRows, selectionRows, selectionIds, selectionRevision } from "./store.js";

const LIST_SIZE = 20, MEMBER_SIZE = 50, CHECK_SIZE = 200, MAX_TRACKS = 20000;
const PENDING_CREATE_KEY = "metatidy.collections.pending-create.v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requests = new Map();
let nodes, active = false, blocked = false, lifecycle = 0, modal = null, mutation = null;
let checking = null, checkGeneration = 0, uncertainCreate = null, recoveryLoaded = false, recoveryWarning = "", searchLater;
const list = { q: "", page: 1, pages: 0, total: 0, items: [], loading: false, loaded: false, dirty: true, error: "" };
const detail = { id: "", collection: null, items: [], page: 1, pages: 0, total: 0, loading: false, dirty: true, error: "" };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const trackId = value => Number.isSafeInteger(value) && value > 0;
const titleOf = row => String(row?.title || row?.filename || `曲目 #${row?.id || ""}`);
const button = (id, text, action, cls = "") => ui.el("button", { id, type: "button", class: `btn ${cls}`.trim(), text, onClick: action });
const message = (node, text, tone = "") => { if (node) { node.textContent = text; node.dataset.tone = tone; } };
const sameIds = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);
const canUse = () => {
  const session = window.__MT_AUTH?.state;
  return !blocked && Boolean(session && (!session.required || session.authenticated));
};
const live = () => active && canUse();
const scopeCurrent = scope => scope.revision === selectionRevision() && sameIds(scope.ids, selectionIds());
const editable = () => live() && Boolean(detail.collection) && !detail.loading && !detail.dirty && !detail.error && !mutation && !checking;

function uuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const value = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function restoreCreate() {
  if (recoveryLoaded || !canUse()) return;
  recoveryLoaded = true;
  try {
    const stored = sessionStorage.getItem(PENDING_CREATE_KEY);
    if (!stored) return;
    if (stored.length > 500000) throw new Error("待核对请求过大");
    const record = JSON.parse(stored), payload = record?.payload;
    if (record?.version !== 1 || !payload || !UUID.test(payload.id) || typeof payload.name !== "string" || payload.name !== payload.name.trim()
      || !validName(payload.name) || !Array.isArray(payload.ids) || payload.ids.length > MAX_TRACKS || payload.ids.some(id => !trackId(id))
      || new Set(payload.ids).size !== payload.ids.length) throw new Error("待核对请求格式无效");
    uncertainCreate = { payload: { id: payload.id, name: payload.name, ids: [...payload.ids] }, inFlight: false };
  } catch {
    recoveryWarning = "无法读取此标签页的上次创建记录。请先在清单列表核对是否已保存，再创建其他清单。";
  }
}
function rememberCreate(record) {
  try {
    sessionStorage.setItem(PENDING_CREATE_KEY, JSON.stringify({ version: 1, payload: record.payload }));
    return true;
  } catch { return false; }
}
function forgetCreate(record) {
  if (uncertainCreate === record) uncertainCreate = null;
  try { sessionStorage.removeItem(PENDING_CREATE_KEY); recoveryWarning = ""; }
  catch { recoveryWarning = "这次创建已得到明确结果，但浏览器未能清理恢复记录；重新载入后请按原请求核对。"; }
}

function cancelRequest(kind) { requests.get(kind)?.controller.abort(); requests.delete(kind); }
function requestFor(kind) {
  cancelRequest(kind);
  const request = { controller: new AbortController(), lifecycle };
  requests.set(kind, request);
  return { signal: request.controller.signal, current: () => live() && lifecycle === request.lifecycle && requests.get(kind) === request && !request.controller.signal.aborted };
}
function summaryOf(value, expectedId = "") {
  if (!value || !UUID.test(value.id) || expectedId && value.id !== expectedId || !UUID.test(value.revision)
    || typeof value.name !== "string" || !value.name.trim() || [...value.name.trim()].length > 120
    || !integer(value.track_count) || value.track_count > MAX_TRACKS || !integer(value.missing_count) || value.missing_count > value.track_count
    || !Number.isFinite(value.created_at) || !Number.isFinite(value.updated_at)) throw new Error("清单响应不完整，请刷新核对。");
  return { ...value };
}
function paginationOf(result, size) {
  if (!result || !integer(result.total) || !integer(result.page) || result.page < 1 || result.page_size !== size
    || !integer(result.pages) || result.pages !== Math.ceil(result.total / size) || result.page > Math.max(1, result.pages)
    || !Array.isArray(result.items) || result.items.length !== Math.min(size, Math.max(0, result.total - (result.page - 1) * size))) throw new Error("分页范围不完整，请刷新核对。");
}
function detailOf(result, id) {
  const collection = summaryOf(result?.collection, id);
  paginationOf(result, MEMBER_SIZE);
  if (result.total !== collection.track_count) throw new Error("清单曲目数发生变化，请刷新核对。");
  let previous = 0;
  const seen = new Set();
  for (const item of result.items) {
    if (!trackId(item.id) || seen.has(item.id) || !trackId(item.position) || item.position <= previous
      || !["found", "missing"].includes(item.status) || Number(item.snapshot?.id) !== item.id
      || item.status === "found" && Number(item.track?.id) !== item.id || item.status === "missing" && item.track !== null) throw new Error("清单成员身份不完整，请刷新核对。");
    seen.add(item.id); previous = item.position;
  }
  return { ...result, collection };
}
function sameCollection(value, expected, missing = expected.missing_count) {
  const actual = summaryOf(value, expected.id);
  if (actual.revision !== expected.revision || actual.track_count !== expected.track_count || actual.missing_count !== missing) throw new Error("清单或曲库索引已变化，请刷新后重新核对。");
  return actual;
}
function snapshotScope(scope = { rows: selectionRows(), revision: selectionRevision() }) {
  if (!scope || !Array.isArray(scope.rows) || !Number.isSafeInteger(scope.revision)) throw new Error("选择范围已失效，请重新审阅。");
  const rows = scope.rows.map(row => ({ ...row })), ids = rows.map(row => row.id);
  if (!ids.length || ids.length > MAX_TRACKS || ids.some(id => !trackId(id)) || new Set(ids).size !== ids.length) throw new Error(`请选择 1–${ui.fmtNum(MAX_TRACKS)} 首不同曲目。`);
  const snapshot = { rows, ids, revision: scope.revision };
  if (!scopeCurrent(snapshot)) throw new Error("当前选择已变化，请重新审阅后保存。");
  return snapshot;
}

export function init() {
  if (nodes) return;
  const root = ui.byId("collections-root");
  if (!root) return;
  root.classList.add("collections-workspace"); root.dataset.view = "list";
  const create = button("collections-create", "新建清单", () => openCreate(), "btn-primary");
  ui.withIcon(create, "plus");
  const refresh = button("collections-refresh", "刷新", () => void refreshPage(), "btn-sm btn-ghost"); ui.withIcon(refresh, "refresh");
  const q = ui.el("input", { id: "collections-q", type: "search", maxlength: 500, autocomplete: "off", placeholder: "按清单名称搜索…", "aria-label": "搜索曲目清单" });
  const search = button("collections-search", "搜索", () => searchList(), "btn-sm");
  const listStatus = ui.el("p", { id: "collections-list-status", class: "cl-status", role: "status", text: "进入页面后读取已保存的清单。" });
  const cards = ui.el("div", { id: "collections-list", class: "cl-list", "aria-label": "已保存的曲目清单" });
  const listPrev = button("collections-list-prev", "上一页", () => void loadList(list.page - 1), "btn-sm btn-ghost");
  const listNext = button("collections-list-next", "下一页", () => void loadList(list.page + 1), "btn-sm btn-ghost");
  const listPage = ui.el("span", { id: "collections-list-page", class: "cl-page" });
  const detailPanel = ui.el("section", { id: "collections-detail", class: "cl-detail", "aria-labelledby": "collections-detail-title" });
  const back = button("collections-back", "返回清单", () => showList(), "btn-sm btn-ghost cl-back");
  const detailTitle = ui.el("h2", { id: "collections-detail-title", tabindex: -1, text: "留一份，继续整理" });
  const detailMeta = ui.el("p", { id: "collections-detail-meta", class: "cl-detail-meta" });
  const detailStatus = ui.el("p", { id: "collections-detail-status", class: "cl-status", role: "status" });
  const detailRefresh = button("collections-detail-refresh", "刷新详情", () => void loadDetail(detail.id, detail.page, { latest: true }), "btn-sm btn-ghost");
  const rename = button("collections-rename", "重命名", () => openRename(), "btn-sm btn-ghost");
  const remove = button("collections-delete", "删除清单", () => openDelete(), "btn-sm btn-ghost cl-danger");
  const append = button("collections-append", "追加当前选择", () => openAppend(), "btn-sm");
  const addSelection = button("collections-add-selection", "加入当前选择…", () => void prepareSelection(), "btn-sm btn-primary"); ui.withIcon(addSelection, "plus");
  const checkStatus = ui.el("p", { id: "collections-check-status", class: "cl-status", role: "status" });
  const cancelCheck = button("collections-cancel-check", "取消核对", () => cancelCheckWithFocus(), "btn-sm btn-ghost");
  const detailTools = ui.el("div", { class: "cl-detail-tools", hidden: true }, [addSelection, append, ui.el("span", { class: "cl-tool-spacer" }), rename, remove]);
  const members = ui.el("div", { id: "collections-members", class: "cl-members", "aria-label": "清单曲目，按保存顺序排列" });
  const membersPrev = button("collections-members-prev", "上一页", () => void loadDetail(detail.id, detail.page - 1), "btn-sm btn-ghost");
  const membersNext = button("collections-members-next", "下一页", () => void loadDetail(detail.id, detail.page + 1), "btn-sm btn-ghost");
  const membersPage = ui.el("span", { id: "collections-members-page", class: "cl-page" });
  const membersPager = ui.el("nav", { class: "cl-pager", "aria-label": "清单曲目分页", hidden: true }, [membersPrev, membersPage, membersNext]);
  const recoveryText = ui.el("p");
  const recoveryButton = button("collections-recover-create", "核对上次创建…", () => openCreateRecovery(), "btn-sm");
  const recovery = ui.el("aside", { id: "collections-recovery", class: "cl-recovery", hidden: true, role: "status" }, [ui.icon("info"), recoveryText, recoveryButton]);
  detailPanel.append(
    ui.el("header", { class: "cl-detail-head" }, [ui.el("div", { class: "cl-detail-top" }, [back, ui.el("span", { class: "cl-detail-label", text: "曲目清单" }), detailRefresh]), detailTitle, detailMeta]),
    detailTools, detailStatus, ui.el("div", { class: "cl-check" }, [checkStatus, cancelCheck]), members, membersPager,
  );
  root.replaceChildren(
    ui.el("header", { id: "collections-toolbar", class: "cl-intro" }, [ui.el("div", {}, [ui.el("p", { class: "eyebrow", text: "YOUR TRACK COLLECTIONS" }), ui.el("h1", { text: "曲目清单" }), ui.el("p", { class: "cl-intro-copy", text: "把一次选择留下来，下一次从这里继续。" })]), ui.el("div", { class: "cl-intro-actions" }, [refresh, create])]),
    ui.el("div", { class: "cl-sharing" }, [ui.icon("copy", { size: 14 }), ui.el("p", { text: "清单会保留到下次打开；登录同一服务的设备都能查看。" })]),
    recovery,
    ui.el("div", { class: "cl-layout" }, [ui.el("aside", { class: "cl-browser", "aria-label": "浏览清单" }, [ui.el("form", { class: "cl-search", onSubmit: event => { event.preventDefault(); searchList(); } }, [q, search]), listStatus, cards, ui.el("nav", { class: "cl-pager", "aria-label": "清单分页" }, [listPrev, listPage, listNext])]), detailPanel]),
  );
  nodes = { root, create, refresh, q, search, listStatus, cards, listPrev, listNext, listPage, detailPanel, back, detailTitle, detailMeta, detailStatus, detailRefresh, detailTools, rename, remove, append, addSelection, checkStatus, cancelCheck, members, membersPrev, membersNext, membersPage, membersPager, recovery, recoveryText, recoveryButton };
  searchLater = ui.debounce(searchList, 250);
  q.addEventListener("input", searchLater);
  on("selection:changed", () => {
    if (checking && checking.selectionRevision !== selectionRevision()) cancelCheck("当前选择已变化，核对结果已清除，请重新加入。");
    if (modal?.scope && !scopeCurrent(modal.scope) && !modal.busy) {
      modal.invalid = true; modal.confirm.disabled = true;
      message(modal.status, "当前选择已变化。此次确认已失效，请关闭后重新审阅完整选择。", "warn");
    }
    syncControls();
  });
  const unauthorized = () => {
    blocked = true; leave();
    Object.assign(list, { items: [], loaded: false, dirty: true, error: "", total: 0, page: 1, pages: 0 });
    Object.assign(detail, { id: "", collection: null, items: [], dirty: true, error: "", total: 0, page: 1, pages: 0 });
    renderList(); renderDetail();
  };
  window.addEventListener("metatidy:unauthorized", unauthorized);
  window.addEventListener("metatidy:logout", unauthorized);
  window.addEventListener("metatidy:authenticated", () => { blocked = false; });
  renderList(); renderDetail(); syncControls();
}

export async function activate() {
  init();
  if (!nodes || !canUse()) return false;
  restoreCreate();
  active = true; lifecycle += 1;
  const work = [loadList(list.page)];
  if (detail.id) work.push(loadDetail(detail.id, detail.page, { latest: true }));
  syncControls();
  await Promise.allSettled(work);
  return live();
}
export function leave() {
  active = false; lifecycle += 1; searchLater?.cancel();
  for (const kind of [...requests.keys()]) cancelRequest(kind);
  cancelCheck(); modal?.close({ restoreFocus: false });
  list.loading = detail.loading = false; list.dirty = detail.dirty = true;
  syncControls();
}
export function invalidate() {
  list.dirty = detail.dirty = true;
  cancelCheck("曲库已更新，请重新核对清单。" );
  if (modal && !modal.busy) { modal.invalid = true; modal.confirm.disabled = true; message(modal.status, "资料已更新，请关闭并刷新核对后再操作。", "warn"); }
  if (detail.collection) message(nodes?.detailStatus, "曲库资料已更新，请刷新详情后继续操作。", "warn");
  syncControls();
}
export async function openSaveSelection(scope) {
  init();
  if (!nodes || !live()) return false;
  try { const snapshot = snapshotScope(scope); return openCreate(snapshot); }
  catch (error) { ui.toast("warn", "选择未保存", error.message); return false; }
}

function syncControls() {
  if (!nodes) return;
  const locked = !live() || Boolean(mutation), usable = editable();
  nodes.create.disabled = locked; nodes.refresh.disabled = locked || list.loading || detail.loading;
  nodes.search.disabled = !live() || list.loading; nodes.q.disabled = !live();
  nodes.listPrev.disabled = !live() || list.loading || list.page <= 1;
  nodes.listNext.disabled = !live() || list.loading || list.page >= list.pages;
  nodes.detailRefresh.hidden = !detail.id; nodes.detailRefresh.disabled = locked || detail.loading;
  nodes.rename.disabled = nodes.remove.disabled = !usable;
  nodes.append.disabled = !usable || !selectionIds().length;
  nodes.append.textContent = `追加当前选择${selectionIds().length ? ` ${ui.fmtNum(selectionIds().length)} 首` : ""}`;
  nodes.addSelection.disabled = !usable || !detail.collection?.track_count;
  nodes.addSelection.setAttribute("aria-busy", String(Boolean(checking)));
  nodes.cancelCheck.hidden = !checking; nodes.cancelCheck.disabled = false;
  nodes.membersPrev.disabled = !usable || detail.page <= 1;
  nodes.membersNext.disabled = !usable || detail.page >= detail.pages;
  for (const item of nodes.members.querySelectorAll("[data-remove-id]")) item.disabled = !usable;
  nodes.cards.setAttribute("aria-busy", String(list.loading)); nodes.members.setAttribute("aria-busy", String(detail.loading));
  nodes.recovery.hidden = !live() || !uncertainCreate && !recoveryWarning;
  nodes.recoveryText.textContent = uncertainCreate ? `“${uncertainCreate.payload.name}”的创建结果${uncertainCreate.inFlight ? "仍在返回" : "尚未确认"}。请核对原请求，再创建其他清单。` : recoveryWarning;
  nodes.recoveryButton.hidden = !uncertainCreate;
  nodes.recoveryButton.disabled = locked;
}
function emptyState(icon, title, copy) {
  return ui.el("div", { class: "cl-empty" }, [ui.el("div", { class: "cl-empty-icon" }, [ui.icon(icon, { size: 28 })]), ui.el("strong", { text: title }), ui.el("p", { text: copy })]);
}
function renderList() {
  if (!nodes) return;
  nodes.listPage.textContent = `${list.page} / ${Math.max(1, list.pages)}`;
  message(nodes.listStatus, list.loading ? "正在读取清单…" : list.error || (list.loaded ? `${ui.fmtNum(list.total)} 份${list.q ? "匹配的" : "已保存的"}清单` : "进入页面后读取已保存的清单。"), list.error ? "error" : "");
  const focused = nodes.cards.contains(document.activeElement) ? document.activeElement?.dataset.collectionId : null;
  nodes.cards.replaceChildren(...list.items.map((item, index) => {
    const card = button("", "", () => void selectCollection(item.id), "cl-card"); card.removeAttribute("id");
    card.dataset.collectionId = item.id; card.dataset.active = String(detail.id === item.id);
    card.setAttribute("aria-pressed", String(detail.id === item.id)); card.title = item.name;
    card.append(ui.el("span", { class: "cl-card-art", "aria-hidden": "true" }, [ui.icon("lyrics", { size: 22 }), ui.el("span", { text: String((list.page - 1) * LIST_SIZE + index + 1).padStart(2, "0") })]), ui.el("span", { class: "cl-card-copy" }, [ui.el("strong", { text: item.name, title: item.name }), ui.el("span", { class: "cl-card-count", text: `${ui.fmtNum(item.track_count)} 首${item.missing_count ? ` · ${ui.fmtNum(item.missing_count)} 首索引缺失` : ""}` }), ui.el("span", { class: "cl-card-date", text: `更新于 ${ui.fmtTime(item.updated_at)}` })]), ui.el("span", { class: "cl-card-arrow", text: "›", "aria-hidden": "true" }));
    return card;
  }));
  if (!list.items.length) nodes.cards.append(emptyState("lyrics", list.loading ? "正在打开清单册" : list.error ? "暂时无法读取清单" : list.q ? "没有同名清单" : "从一份清单开始", list.error ? "点击刷新，重新读取服务里的清单。" : list.q ? "试试其他关键词，或清空搜索。" : "新建空清单，或在已选曲目审阅中保存完整选择。"));
  if (focused) [...nodes.cards.querySelectorAll("[data-collection-id]")].find(node => node.dataset.collectionId === focused)?.focus({ preventScroll: true });
  syncControls();
}
function renderDetail() {
  if (!nodes) return;
  const collection = detail.collection;
  nodes.detailPanel.dataset.id = detail.id;
  nodes.detailPanel.dataset.revision = collection?.revision || "";
  nodes.detailTools.hidden = !collection; nodes.membersPager.hidden = !collection || !detail.total;
  nodes.detailTitle.textContent = collection?.name || (detail.loading ? "正在打开清单…" : "留一份，继续整理");
  nodes.detailMeta.textContent = collection ? `${ui.fmtNum(collection.track_count)} 首 · ${ui.fmtNum(collection.missing_count)} 首索引缺失 · 固定保存顺序` : "保存你的整理范围，跨设备接着处理。";
  message(nodes.detailStatus, detail.loading ? "正在读取曲目资料…" : detail.error || (collection ? "按保存顺序显示；索引缺失的曲目保留保存时的资料。" : ""), detail.error ? "error" : "");
  nodes.membersPage.textContent = `${detail.page} / ${Math.max(1, detail.pages)} · ${ui.fmtNum(detail.total)} 首`;
  nodes.members.replaceChildren(...detail.items.map(item => {
    const row = item.status === "found" ? item.track : item.snapshot;
    const remove = button("", "移除", () => openRemove(item), "btn-sm btn-ghost cl-member-remove"); remove.removeAttribute("id"); remove.dataset.removeId = item.id; remove.setAttribute("aria-label", `从清单移除 ${titleOf(row)}`);
    return ui.el("article", { class: "cl-member", dataset: { memberId: item.id, status: item.status } }, [ui.el("span", { class: "cl-position", text: String(item.position).padStart(2, "0"), "aria-label": `保存顺序 ${item.position}` }), ui.el("div", { class: "cl-member-copy" }, [ui.el("strong", { class: "cl-member-title", text: titleOf(row), title: titleOf(row) }), ui.el("p", { class: "cl-member-meta", text: [row.artist || "未知艺术家", row.album || "未填写专辑"].join(" · "), title: [row.artist || "未知艺术家", row.album || "未填写专辑"].join(" · ") }), ui.el("p", { class: "cl-member-path", text: row.path || row.filename || "没有保存路径", title: row.path || row.filename || "没有保存路径" }), ui.el("span", { class: `cl-member-status ${item.status === "missing" ? "is-missing" : ""}`, text: item.status === "missing" ? "索引缺失 · 保存时的资料" : "最新资料" })]), remove]);
  }));
  if (!detail.items.length) nodes.members.append(emptyState(collection ? "music" : "lyrics", detail.loading ? "正在载入曲目" : collection ? "清单还是空的" : "选择一份清单", collection ? "在曲库勾选曲目，然后追加到这里。清单会保留加入时的顺序。" : "从左侧打开清单，查看曲目并加入当前选择。"));
  syncControls();
}
function searchList() { if (!live()) return; searchLater?.cancel(); list.q = nodes.q.value.trim(); void loadList(1); }
async function loadList(page = 1) {
  if (!live() || !nodes || !Number.isInteger(page) || page < 1) return false;
  const request = requestFor("list"), query = list.q;
  list.loading = true; list.error = ""; renderList();
  try {
    const result = await api.collections({ q: query, page, page_size: LIST_SIZE }, { signal: request.signal });
    if (!request.current()) return false;
    paginationOf(result, LIST_SIZE);
    const items = result.items.map(item => summaryOf(item));
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error("清单身份重复，请刷新核对。");
    Object.assign(list, { items, page: result.page, pages: result.pages, total: result.total, loaded: true, dirty: false });
    return true;
  } catch (error) { if (request.current()) list.error = `读取清单失败：${error.message}`; return false; }
  finally { if (request.current()) { list.loading = false; renderList(); } }
}
async function selectCollection(id) {
  if (!live() || mutation) return;
  cancelCheck(); modal?.close({ restoreFocus: false });
  nodes.root.dataset.view = "detail";
  await loadDetail(id, 1, { latest: true });
  if (live() && detail.id === id) { nodes.detailTitle.focus({ preventScroll: true }); animateDetail(); }
}
function showList() {
  cancelCheck(); modal?.close({ restoreFocus: false });
  nodes.root.dataset.view = "list";
  const selected = [...nodes.cards.querySelectorAll("[data-collection-id]")].find(node => node.dataset.collectionId === detail.id);
  (selected || nodes.q).focus({ preventScroll: true });
}
async function loadDetail(id, page = 1, { latest = false } = {}) {
  if (!live() || !UUID.test(id) || !Number.isInteger(page) || page < 1) return false;
  cancelCheck();
  const request = requestFor("detail"), revision = !latest && detail.id === id ? detail.collection?.revision : undefined;
  if (detail.id !== id) Object.assign(detail, { id, collection: null, items: [], total: 0, page: 1, pages: 0 });
  detail.loading = true; detail.error = ""; detail.dirty = true; renderDetail(); renderList();
  try {
    const result = detailOf(await api.collection(id, { page, page_size: MEMBER_SIZE, ...(revision ? { revision } : {}) }, { signal: request.signal }), id);
    if (!request.current() || detail.id !== id) return false;
    if (revision && result.collection.revision !== revision) throw new Error("清单已在其他设备修改，请刷新详情。");
    Object.assign(detail, { collection: result.collection, items: result.items, page: result.page, pages: result.pages, total: result.total, dirty: false });
    const card = list.items.findIndex(item => item.id === id);
    if (card !== -1) list.items[card] = result.collection;
    return true;
  } catch (error) {
    if (request.current()) { detail.error = error.status === 404 ? "这份清单已不存在，请刷新清单列表。" : `读取详情失败：${error.message}`; detail.dirty = true; }
    return false;
  } finally { if (request.current()) { detail.loading = false; renderDetail(); renderList(); } }
}
async function refreshPage() {
  if (!live() || mutation) return;
  cancelCheck(); modal?.close({ restoreFocus: false });
  await Promise.allSettled([loadList(list.page), ...(detail.id ? [loadDetail(detail.id, detail.page, { latest: true })] : [])]);
}
function animateDetail() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !nodes.detailPanel.animate) return;
  for (const animation of nodes.detailPanel.getAnimations()) animation.cancel();
  nodes.detailPanel.animate([{ opacity: .7, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "ease-out" });
}

function openDialog({ action, title, copy, label, scope = null, name, confirm, onClose = null }) {
  modal?.close({ restoreFocus: false });
  const opener = document.activeElement;
  const dialog = ui.el("dialog", { id: "collections-dialog", class: "modal narrow cl-dialog", dataset: { action }, "aria-labelledby": "collections-dialog-title" });
  const status = ui.el("p", { id: "collections-dialog-status", class: "cl-dialog-status", role: "status" });
  const body = ui.el("div", { class: "modal-body" }, [ui.el("p", { id: "collections-dialog-copy", text: copy })]);
  let input = null;
  if (name !== undefined) {
    input = ui.el("input", { id: "collections-name", type: "text", autocomplete: "off", maxlength: 240, value: name, "aria-describedby": "collections-name-hint" });
    body.append(ui.el("label", { class: "field" }, [ui.el("span", { class: "lbl", text: "清单名称" }), input]), ui.el("p", { id: "collections-name-hint", class: "hint", text: "1–120 个字符，可使用中文和 emoji。" }));
  }
  body.append(status);
  const cancel = button("collections-cancel", "取消", () => model.close(), "btn");
  const submit = button("collections-confirm", label, () => {
    if (model.closed || model.busy || model.invalid || !live() || mutation) return;
    if (model.scope && !scopeCurrent(model.scope)) { model.invalid = true; submit.disabled = true; message(status, "当前选择已变化，请重新审阅后操作。", "warn"); return; }
    if (input && !validName(input.value)) { message(status, "请输入 1–120 个字符的清单名称。", "warn"); input.focus(); return; }
    void confirm(model);
  }, action === "delete" || action === "remove" ? "btn-danger" : "btn-primary");
  const model = { dialog, body, status, input, cancel, confirm: submit, scope, closed: false, busy: false, invalid: false, lifecycle,
    current: () => !model.closed && modal === model && model.lifecycle === lifecycle && live(),
    close: ({ restoreFocus = true } = {}) => {
      if (model.closed) return;
      model.closed = true; if (modal === model) modal = null;
      model.readController?.abort();
      onClose?.(); if (dialog.open) dialog.close(); dialog.remove();
      if (restoreFocus && live()) {
        const target = opener?.isConnected && opener.getClientRects().length && !opener.matches(":disabled") ? opener : nodes.detailTitle;
        target?.focus({ preventScroll: true });
      }
    },
  };
  dialog.append(ui.el("header", { class: "modal-head" }, [ui.el("div", {}, [ui.el("p", { class: "eyebrow", text: "TRACK COLLECTION" }), ui.el("h2", { id: "collections-dialog-title", text: title })])]), body, ui.el("footer", { class: "modal-foot" }, [cancel, submit]));
  dialog.addEventListener("cancel", event => { event.preventDefault(); model.close(); });
  dialog.addEventListener("close", () => model.close());
  input?.addEventListener("input", () => { submit.disabled = model.busy || model.invalid || !validName(input.value); });
  if (input) submit.disabled = !validName(input.value);
  modal = model; document.body.append(dialog); dialog.showModal(); (input || cancel).focus();
  return model;
}
const validName = value => { const length = [...value.trim()].length; return length > 0 && length <= 120 && !value.includes("\0"); };
function openCreate(scope = null) {
  if (!live() || mutation) return false;
  restoreCreate();
  if (uncertainCreate) { openCreateRecovery(); return false; }
  cancelCheck();
  openDialog({ action: "create", title: scope ? "保存完整选择为清单" : "新建曲目清单", copy: scope ? `将完整选择的 ${ui.fmtNum(scope.ids.length)} 首保存为新清单，包含其他分页的选择。顺序与本次选择一致；任何曲目已从索引移除时，本次创建会整体取消。` : "创建一份空清单，稍后从当前选择追加曲目。同一服务的登录设备会共享这份清单。", label: scope ? `确认保存 ${ui.fmtNum(scope.ids.length)} 首` : "确认创建", name: "", scope,
    confirm: async model => {
      const payload = { id: uuid(), name: model.input.value.trim(), ids: scope ? [...scope.ids] : [] };
      await createWithPayload(model, payload);
    },
  });
  return true;
}
function openCreateRecovery() {
  if (!live() || mutation || !uncertainCreate) return;
  const record = uncertainCreate, payload = record.payload;
  const model = openDialog({ action: "create", title: "核对上次创建", copy: `“${payload.name}” · ${ui.fmtNum(payload.ids.length)} 首。上次请求可能已经保存。重试会使用同一个创建标识和原始内容，不会创建第二份清单；也可以先只读核对清单是否存在。`, label: "使用原请求核对并重试", confirm: model => createWithPayload(model, payload) });
  addCreateCheck(model, record);
}
function addCreateCheck(model, record) {
  if (model.body.querySelector("#collections-check-create")) return;
  model.body.append(button("collections-check-create", "只读核对清单是否存在", () => void checkCreate(model, record), "btn-sm btn-ghost"));
}
async function checkCreate(model, record) {
  if (!model.current() || model.busy || mutation || uncertainCreate !== record || record.inFlight) return;
  const controller = new AbortController(); model.readController = controller; model.busy = true; model.confirm.disabled = true;
  model.body.querySelector("#collections-forget-create")?.remove();
  for (const node of model.body.querySelectorAll("button")) node.disabled = true;
  message(model.status, "正在只读核对原清单是否已保存…");
  try {
    const result = detailOf(await api.collection(record.payload.id, { page: 1, page_size: MEMBER_SIZE }, { signal: controller.signal }), record.payload.id);
    if (!model.current() || controller.signal.aborted || uncertainCreate !== record) return;
    forgetCreate(record); model.close({ restoreFocus: false });
    nodes.root.dataset.view = "detail";
    const generation = lifecycle;
    await Promise.allSettled([loadList(list.page), loadDetail(result.collection.id, 1, { latest: true })]);
    if (live() && generation === lifecycle && detail.id === result.collection.id) nodes.detailTitle.focus({ preventScroll: true });
  } catch (error) {
    if (!model.current() || controller.signal.aborted || uncertainCreate !== record) return;
    if (error.status === 404 && !mutation && !record.inFlight) {
      message(model.status, "目前没有找到原清单。可以继续用原请求重试，或确认忘记此标签页的重试记录。延迟的请求以后仍可能保存，请留意清单列表。", "warn");
      model.body.append(button("collections-forget-create", "忘记这次重试记录…", () => openForgetCreate(record), "btn-sm btn-ghost"));
    } else message(model.status, `暂时无法确认清单状态：${error.message} 原请求已保留，请稍后核对。`, "warn");
  } finally {
    model.busy = false;
    if (model.current()) {
      model.confirm.disabled = model.invalid;
      for (const node of model.body.querySelectorAll("button")) node.disabled = false;
    }
    syncControls();
  }
}
function openForgetCreate(record) {
  if (!live() || mutation || uncertainCreate !== record || record.inFlight) return;
  openDialog({ action: "forget-create", title: "忘记这次重试记录？", copy: `仅忘记此标签页对“${record.payload.name}”的重试记录，不会删除任何清单或音乐文件。刚才未找到清单，但延迟的请求以后仍可能保存；创建其他清单前，请回到列表核对。`, label: "确认忘记重试记录", confirm: model => {
    if (!model.current() || mutation || uncertainCreate !== record || record.inFlight) return;
    forgetCreate(record); model.close(); syncControls();
    ui.toast("info", "已忘记重试记录", "清单和音乐文件未删除。稍后可刷新列表核对。");
  } });
}
async function createWithPayload(model, payload) {
  const recovering = Boolean(uncertainCreate);
  const record = uncertainCreate || { payload: { ...payload, ids: [...payload.ids] }, inFlight: false };
  if (!rememberCreate(record)) {
    message(model.status, "浏览器无法保留本次创建标识，尚未发送请求。请允许当前标签页使用会话存储后重试。", "warn");
    return;
  }
  uncertainCreate = record; record.inFlight = true;
  await runMutation(model, () => api.createCollection(record.payload), {
    // Idempotent replies contain the current summary; another device may have
    // renamed or appended since creation. The server checks the original payload.
    validate: result => summaryOf(result?.collection, record.payload.id),
    success: collection => { forgetCreate(record); return collection.id; },
    failure: error => {
      record.inFlight = false;
      // A later rejection says nothing about an earlier request that may have
      // committed. Keep its identity through expired sessions and recovery.
      if (!recovering && error.status >= 400 && error.status < 500 && ![401, 403, 408, 429].includes(error.status)) { forgetCreate(record); return false; }
      return true;
    },
    create: true,
  });
}
function openRename() {
  if (!editable()) return;
  const collection = { ...detail.collection };
  openDialog({ action: "rename", title: "重命名清单", copy: `修改“${collection.name}”的名称，成员与保存顺序保持原样。`, name: collection.name, label: "确认重命名", confirm: model => runMutation(model, () => api.renameCollection(collection.id, { revision: collection.revision, name: model.input.value.trim() }), { validate: result => {
    const renamed = summaryOf(result?.collection, collection.id);
    if (renamed.name !== model.input.value.trim() || renamed.track_count !== collection.track_count) throw new Error("重命名响应无法核对。");
    return renamed;
  }, success: () => collection.id }) });
}
function openDelete() {
  if (!editable()) return;
  const collection = { ...detail.collection };
  openDialog({ action: "delete", title: "删除这份清单？", copy: `将删除“${collection.name}”及其 ${ui.fmtNum(collection.track_count)} 条成员引用。只删除服务数据库里的这份清单，曲库索引、当前选择和音乐文件不会删除。其他登录设备也将看不到这份清单。`, label: "确认删除清单", confirm: model => runMutation(model, () => api.deleteCollection(collection.id, { revision: collection.revision }), { validate: result => { if (result?.deleted !== true || result.id !== collection.id) throw new Error("删除结果无法核对。"); return result; }, success: () => "" }) });
}
function openAppend() {
  if (!editable()) return;
  let scope;
  try { scope = snapshotScope(); } catch (error) { ui.toast("warn", "无法追加", error.message); return; }
  const collection = { ...detail.collection };
  openDialog({ action: "append", title: "追加完整选择", scope, copy: `将当前完整选择的 ${ui.fmtNum(scope.ids.length)} 首追加到“${collection.name}”末尾，包含其他分页的选择。已在清单中的曲目会保留原顺序；若待追加曲目已从索引移除，本次操作会整体取消。`, label: `确认追加 ${ui.fmtNum(scope.ids.length)} 首`, confirm: model => runMutation(model, () => api.collectionMembers(collection.id, { revision: collection.revision, action: "append", ids: [...scope.ids] }), { validate: result => memberResult(result, collection, "append", scope.ids.length), success: () => collection.id }) });
}
function openRemove(item) {
  if (!editable()) return;
  const collection = { ...detail.collection }, row = item.status === "found" ? item.track : item.snapshot;
  openDialog({ action: "remove", title: "从清单移除这首曲目？", copy: `“${titleOf(row)}”将从“${collection.name}”中移除${item.status === "missing" ? "，保存的缺失快照也会移除" : ""}。只修改清单成员，当前选择、曲库索引和音乐文件不受影响。`, label: "确认移除", confirm: model => runMutation(model, () => api.collectionMembers(collection.id, { revision: collection.revision, action: "remove", ids: [item.id] }), { validate: result => memberResult(result, collection, "remove", 1), success: () => collection.id }) });
}
function memberResult(result, old, action, maximum) {
  const collection = summaryOf(result?.collection, old.id);
  if (!integer(result.added) || !integer(result.removed) || result.added > (action === "append" ? maximum : 0) || result.removed > (action === "remove" ? maximum : 0)
    || collection.track_count !== old.track_count + result.added - result.removed) throw new Error("成员变更结果无法核对。");
  return collection;
}
async function runMutation(model, call, options) {
  if (!model.current() || model.busy || model.invalid || mutation || model.scope && !scopeCurrent(model.scope)) return;
  const token = { lifecycle, model }; mutation = token; model.busy = true; model.confirm.disabled = true;
  const retryButton = model.body.querySelector("#collections-retry-create");
  if (retryButton) retryButton.disabled = true;
  for (const node of model.body.querySelectorAll("button")) node.disabled = true;
  model.body.querySelector("#collections-forget-create")?.remove();
  if (model.input) model.input.disabled = true;
  model.cancel.textContent = "关闭";
  message(model.status, "请求已发送，正在确认数据库结果。关闭窗口不会撤回已发送的请求。"); syncControls();
  try {
    const value = options.validate(await call());
    const nextId = options.success?.(value);
    list.dirty = detail.dirty = true;
    if (!model.current()) return;
    model.close({ restoreFocus: false });
    if (typeof nextId === "string") {
      if (nextId) nodes.root.dataset.view = "detail";
      else { Object.assign(detail, { id: "", collection: null, items: [], total: 0, page: 1, pages: 0, error: "" }); nodes.root.dataset.view = "list"; renderDetail(); }
    }
    mutation = null;
    const reloaded = await Promise.allSettled([loadList(list.page), ...(nextId ? [loadDetail(nextId, 1, { latest: true })] : [])]);
    if (live() && lifecycle === token.lifecycle && (!nextId || detail.id === nextId)) {
      if (nextId && reloaded[1]?.status === "fulfilled" && reloaded[1].value) message(nodes.detailStatus, "清单已保存，可在其他登录设备继续查看。");
      (nextId ? nodes.detailTitle : nodes.create).focus({ preventScroll: true });
    }
  } catch (error) {
    list.dirty = detail.dirty = true;
    const uncertain = options.failure?.(error);
    if (!model.current()) return;
    if (options.create && uncertain) {
      message(model.status, `创建结果尚未确认：${error.message} 可能已经保存。可使用原请求重试核对，不会创建第二份清单。`, "warn");
      model.scope = null;
      let retry = model.body.querySelector("#collections-retry-create");
      if (!retry) {
        retry = button("collections-retry-create", "使用原请求重试", () => {
          if (!model.current() || mutation || !uncertainCreate) return;
          model.invalid = false; void createWithPayload(model, uncertainCreate.payload);
        }, "btn-sm");
        model.body.append(retry);
      }
      retry.disabled = false;
      addCreateCheck(model, uncertainCreate);
      model.body.querySelector("#collections-check-create").disabled = false;
    } else {
      const known = error.status >= 400 && error.status < 500;
      message(model.status, `${known ? "请求未完成" : "变更结果尚未确认"}：${error.message} 请关闭并刷新核对后再操作。`, "warn");
    }
    model.invalid = true;
  } finally {
    if (mutation === token) mutation = null;
    model.busy = false;
    if (uncertainCreate?.inFlight && options.create) uncertainCreate.inFlight = false;
    syncControls();
  }
}

function cancelCheck(text = "") {
  const previous = checking; checking = null; checkGeneration += 1;
  previous?.controller.abort();
  if (modal?.dialog.dataset.action === "add-selection") modal.close({ restoreFocus: false });
  message(nodes?.checkStatus, text); syncControls();
}
function cancelCheckWithFocus() { cancelCheck("核对已取消，未加入任何曲目。"); nodes.addSelection.focus({ preventScroll: true }); }
function checkCurrent(check) {
  return checking === check && check.generation === checkGeneration && check.lifecycle === lifecycle && live() && !check.controller.signal.aborted
    && check.selectionRevision === selectionRevision() && sameIds(check.selectedIds, selectionIds()) && detail.id === check.collection.id;
}
async function prepareSelection() {
  if (!editable() || !detail.collection.track_count) return;
  cancelCheck();
  const check = { collection: { ...detail.collection }, controller: new AbortController(), generation: ++checkGeneration, lifecycle,
    selectionRevision: selectionRevision(), selectedIds: selectionIds(), ids: [], found: [], missing: 0, already: 0, added: 0 };
  checking = check; syncControls();
  message(nodes.checkStatus, "正在读取整份清单的固定顺序；核对完成前不会加入任何曲目。");
  try {
    const result = await api.collectionSelection(check.collection.id, { revision: check.collection.revision }, { signal: check.controller.signal });
    if (!checkCurrent(check)) return;
    sameCollection(result?.collection, check.collection);
    const ids = result.ids;
    if (!Array.isArray(ids) || ids.length !== check.collection.track_count || ids.length > MAX_TRACKS || ids.some(id => !trackId(id)) || new Set(ids).size !== ids.length) throw new Error("清单的完整成员范围无法核对。");
    check.ids = [...ids];
    const visibleIds = detail.items.map(item => item.id), expectedVisible = ids.slice((detail.page - 1) * MEMBER_SIZE, detail.page * MEMBER_SIZE);
    if (!sameIds(visibleIds, expectedVisible)) throw new Error("清单成员的保存顺序无法核对。");
    const seen = new Set(), found = [], pages = Math.ceil(ids.length / CHECK_SIZE); let counts = "";
    for (let page = 1; page <= pages; page += 1) {
      const result = await api.trackSelection({ ids: [...ids], page, page_size: CHECK_SIZE }, { signal: check.controller.signal });
      if (!checkCurrent(check)) return;
      const expected = ids.slice((page - 1) * CHECK_SIZE, page * CHECK_SIZE);
      if (result.total !== ids.length || result.selected_total !== ids.length || result.page !== page || result.page_size !== CHECK_SIZE || result.pages !== pages
        || !integer(result.found_total) || !integer(result.missing_total) || result.found_total + result.missing_total !== ids.length
        || !Array.isArray(result.items) || result.items.length !== expected.length) throw new Error("索引响应的完整范围无法核对。");
      const nextCounts = `${result.found_total}:${result.missing_total}`;
      if (counts && counts !== nextCounts) throw new Error("核对期间曲库索引发生变化。");
      counts = nextCounts;
      for (const [index, item] of result.items.entries()) {
        if (item.id !== expected[index] || seen.has(item.id) || !["found", "missing"].includes(item.status)
          || item.status === "found" && Number(item.track?.id) !== item.id || item.status === "missing" && item.track !== null) throw new Error("索引响应的顺序或曲目身份无法核对。");
        seen.add(item.id); if (item.status === "found") found.push({ ...item.track });
      }
      message(nodes.checkStatus, `正在核对完整清单：${ui.fmtNum(seen.size)} / ${ui.fmtNum(ids.length)} 首。不会采用部分结果。`);
    }
    const missing = ids.length - found.length;
    if (seen.size !== ids.length || counts !== `${found.length}:${missing}`) throw new Error("索引核对结果不完整。");
    check.found = found; check.missing = missing;
    await verifyCheckCollection(check, missing);
    if (!checkCurrent(check)) return;
    const selected = new Set(check.selectedIds); check.already = found.filter(row => selected.has(row.id)).length; check.added = found.length - check.already;
    message(nodes.checkStatus, `核对完成：可追加 ${ui.fmtNum(check.added)} 首，已在选择 ${ui.fmtNum(check.already)} 首，索引缺失 ${ui.fmtNum(missing)} 首。`);
    const model = openDialog({ action: "add-selection", title: "将清单加入当前选择", copy: `“${check.collection.name}”共 ${ui.fmtNum(ids.length)} 首。可追加 ${ui.fmtNum(check.added)} 首，已在当前选择 ${ui.fmtNum(check.already)} 首，索引缺失 ${ui.fmtNum(missing)} 首。原有选择会保留；缺失成员会继续保留在清单里，本次不会加入选择。确认后打开已选曲目审阅。`, label: check.added ? `确认追加 ${ui.fmtNum(check.added)} 首并审阅` : "确认并审阅当前选择", confirm: model => confirmSelection(check, model), onClose: () => {
      if (checking === check) { checking = null; checkGeneration += 1; check.controller.abort(); syncControls(); }
    } });
    if (!found.length) { model.invalid = true; model.confirm.disabled = true; message(model.status, "这份清单目前没有可加入的曲目。缺失快照仍保留，可在曲库索引恢复后重新核对。", "warn"); }
  } catch (error) {
    if (!checkCurrent(check)) return;
    cancelCheck(`核对未完成：${error.message} 未加入任何曲目，请刷新后重试。`);
    nodes.addSelection.focus({ preventScroll: true });
  }
}
async function verifyCheckCollection(check, missing) {
  const result = await api.collection(check.collection.id, { page: 1, page_size: MEMBER_SIZE, revision: check.collection.revision }, { signal: check.controller.signal });
  if (!checkCurrent(check)) return;
  const verified = detailOf(result, check.collection.id);
  sameCollection(verified.collection, check.collection, missing);
  if (!sameIds(verified.items.map(item => item.id), check.ids.slice(0, MEMBER_SIZE))) throw new Error("清单成员的顺序已变化，请重新核对。");
  const found = new Set(check.found.map(row => row.id));
  if (verified.items.some(item => (item.status === "found") !== found.has(item.id))) throw new Error("清单成员的索引状态已变化，请重新核对。");
}
async function confirmSelection(check, model) {
  if (!checkCurrent(check) || !model.current()) return;
  model.busy = true; model.confirm.disabled = true;
  message(model.status, "正在最后核对清单版本和选择范围…");
  try {
    await verifyCheckCollection(check, check.missing);
    if (!checkCurrent(check) || !model.current()) return;
    const rows = check.found.map(row => ({ ...row }));
    checking = null; checkGeneration += 1; check.controller.abort();
    model.close({ restoreFocus: false });
    message(nodes.checkStatus, `已追加 ${ui.fmtNum(check.added)} 首，保留原有选择；${ui.fmtNum(check.missing)} 首缺失成员仍在清单中。`);
    selectRows(rows); emit("library:review-selection");
  } catch (error) {
    if (!model.current() || !checkCurrent(check)) return;
    checking = null; checkGeneration += 1; check.controller.abort(); model.invalid = true;
    message(model.status, `最终核对未通过：${error.message} 未加入任何曲目。请关闭后刷新清单。`, "warn");
  } finally { model.busy = false; syncControls(); }
}
