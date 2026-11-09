/** Browse paginated exact artist names using index summaries only. */
import { request, qs } from "./api.js";
import * as ui from "./ui.js";
import * as auth from "./auth.js";
import { emit, state } from "./store.js";
import { normalizeArtistGroup } from "./artist-group.js";
import { openArtistDetail, closeArtistDetail, validArtistSummary, artistAvatar, artistDuration } from "./artist-detail.js";

const PAGE_SIZE = 24;
const SORTS = ["name", "tracks", "recent"];
const query = { q: "", sort: "name", order: "asc", page: 1 };
let nodes = null, active = false, dirty = true, loaded = false, loading = false, blocked = false;
let generation = 0, invalidation = 0, controller = null, pendingSearch = null;
let snapshot = null, error = "", loadedAt = 0;
const cards = new Map();
const count = value => Number.isSafeInteger(value) && value >= 0;
const focusable = node => node?.isConnected && node.getClientRects().length && !node.closest("[inert]") && !node.matches(":disabled");
// Mirror Rust str::trim for search text. Exact artist identity has separate
// ASCII-space normalization and must never pass through this helper.
const trimSearch = value => value.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, "");

function usable() {
  const session = auth.current();
  return !blocked && (!session.required || session.authenticated) && !document.querySelector(".app-content")?.inert;
}
function currentPage() { return active && usable() && state.tab === "artists" && nodes?.host.isConnected; }
function queryKey(value = query) { return JSON.stringify([value.q, value.sort, value.order, value.page]); }
function inputQuery() { return { q: trimSearch(nodes.q.value), sort: nodes.sort.value, order: nodes.order.value, page: query.page }; }

export function init() {
  if (nodes) return;
  const host = ui.byId("artists-root");
  if (!host) return;
  host.classList.add("artist-workspace");
  const q = ui.el("input", { id: "artists-q", type: "search", maxlength: "4000", autocomplete: "off", placeholder: "搜索曲库中的艺术家…", "aria-label": "搜索艺术家" });
  const sort = ui.el("select", { id: "artists-sort", "aria-label": "艺术家排序" }, [ui.el("option", { value: "name", text: "艺术家名称" }), ui.el("option", { value: "tracks", text: "收藏曲目数" }), ui.el("option", { value: "recent", text: "最近收录" })]);
  const order = ui.el("select", { id: "artists-order", "aria-label": "排序方向" }, [ui.el("option", { value: "asc", text: "升序" }), ui.el("option", { value: "desc", text: "降序" })]);
  const clear = ui.el("button", { id: "artists-clear", type: "button", class: "btn btn-sm btn-ghost", text: "清空搜索", hidden: true, onClick: () => { q.value = ""; changeQuery({ q: "" }); pendingSearch.cancel(); q.focus({ preventScroll: true }); void refresh(); } });
  const refreshButton = ui.el("button", { id: "artists-refresh", type: "button", class: "btn btn-sm btn-ghost", onClick: () => { pendingSearch.cancel(); void refresh(); } }, [ui.icon("refresh", { size: 14 }), "刷新"]);
  const total = ui.el("span", { id: "artists-total", class: "badge count-chip", text: "等待载入" });
  const updated = ui.el("span", { id: "artists-updated", class: "hint" });
  const status = ui.el("div", { id: "artists-status", class: "artists-status", role: "status", "aria-live": "polite", "aria-atomic": "true" });
  const list = ui.el("ul", { id: "artists-list", class: "artists-list", "aria-label": "艺术家收藏" });
  const previous = ui.el("button", { id: "artists-prev", type: "button", class: "btn btn-sm", text: "上一页", onClick: () => changePage(-1) });
  const next = ui.el("button", { id: "artists-next", type: "button", class: "btn btn-sm", text: "下一页", onClick: () => changePage(1) });
  const page = ui.el("span", { id: "artists-page", text: "— / —" });
  const range = ui.el("span", { id: "artists-range", class: "artists-range" });
  const pager = ui.el("nav", { id: "artists-pager", class: "artists-pager", "aria-label": "艺术家分页" }, [range, ui.el("div", { class: "spacer" }), previous, page, next]);
  const allTracks = ui.el("button", { id: "artists-all-tracks", type: "button", class: "btn btn-sm", onClick: () => { if (currentPage()) emit("albums:all-tracks"); } }, [ui.icon("music", { size: 14 }), "回到曲目库"]);
  nodes = { host, q, sort, order, clear, refreshButton, total, updated, status, list, previous, next, page, range, pager, allTracks };
  host.append(ui.el("div", { class: "artists-intro" }, [ui.el("span", { class: "artists-intro-art", "aria-hidden": "true" }, [ui.icon("artist", { size: 31 })]),
    ui.el("div", { class: "artists-intro-copy" }, [ui.el("p", { class: "eyebrow", text: "VOICES IN YOUR COLLECTION" }), ui.el("h2", { text: "熟悉的声音，收藏在一起。" }), ui.el("p", { text: "按艺术家翻阅专辑与曲目，重新发现收藏里的音乐。" })]), allTracks]),
    ui.el("section", { class: "card artists-collection", "aria-label": "浏览艺术家收藏" }, [ui.el("div", { class: "card-head artists-heading" }, [ui.el("h2", {}, [ui.icon("artist", { size: 17 }), "艺术家收藏"]), total, ui.el("div", { class: "grow" }, [updated, refreshButton])]),
      ui.el("div", { class: "artists-toolbar" }, [ui.el("label", { class: "search-field artists-search" }, [ui.icon("search", { size: 17 }), q]), ui.el("div", { class: "artists-sort" }, [ui.el("span", { class: "lbl", text: "排序" }), sort, order]), clear]),
      ui.el("p", { class: "artists-guide" }, [ui.el("span", { text: "按曲目艺术家的完整名称归组；合作名称保持原样。" }), ui.el("span", { text: "未标注艺术家的曲目仍可在曲库查看。" })]), status, list, pager]));
  pendingSearch = ui.debounce(() => { if (currentPage()) void refresh(); }, 250);
  q.addEventListener("input", () => { changeQuery({ q: trimSearch(q.value) }); pendingSearch(); });
  q.addEventListener("keydown", event => { if (event.key !== "Enter" || event.isComposing) return; pendingSearch.cancel(); changeQuery({ q: trimSearch(q.value) }); void refresh(); });
  sort.addEventListener("change", () => {
    pendingSearch.cancel(); const value = SORTS.includes(sort.value) ? sort.value : "name";
    order.value = value === "name" ? "asc" : "desc"; changeQuery({ sort: value, order: order.value }); void refresh();
  });
  order.addEventListener("change", () => { pendingSearch.cancel(); changeQuery({ order: order.value === "desc" ? "desc" : "asc" }); void refresh(); });
  sync();
}

function cancel() { generation += 1; controller?.abort(); controller = null; loading = false; }

function changeQuery(values) {
  cancel(); Object.assign(query, values, { page: 1 }); dirty = true; error = "";
  // Invalidate immediately on raw input events, including A→B→A before debounce.
  snapshot = null; loaded = false; loadedAt = 0; cards.clear(); nodes.list.replaceChildren();
  nodes.status.replaceChildren(ui.el("p", { text: "正在准备查询艺术家…" })); nodes.status.hidden = false;
  sync();
}

function changePage(delta) {
  if (!currentPage() || loading || !snapshot) return;
  const requested = Math.max(1, Math.min(snapshot.pages || 1, query.page + delta));
  if (requested === query.page) return;
  pendingSearch.cancel(); cancel(); query.page = requested; dirty = true; snapshot = null; loaded = false;
  cards.clear(); nodes.list.replaceChildren(); void refresh();
}

export function isLoading() { return loading; }
export function invalidate() { dirty = true; invalidation += 1; }
export function activate() {
  init(); if (!nodes || !usable()) return Promise.resolve(false);
  active = true;
  return dirty || !loaded || error ? refresh() : Promise.resolve(true);
}
export function leave() {
  active = false; pendingSearch?.cancel(); if (loading) dirty = true; cancel();
  closeArtistDetail({ restoreFocus: false }); sync();
}

function validate(data, wanted) {
  if (!data || data.q !== wanted.q || data.sort !== wanted.sort || data.order !== wanted.order || !count(data.total) || data.page_size !== PAGE_SIZE
    || data.pages !== Math.ceil(data.total / PAGE_SIZE) || data.page !== Math.max(1, Math.min(Math.max(1, data.pages), wanted.page))
    || !Array.isArray(data.items) || data.items.length !== Math.min(PAGE_SIZE, Math.max(0, data.total - (data.page - 1) * PAGE_SIZE))) throw new Error("艺术家列表的分页范围不完整，请刷新重试。");
  const names = new Set();
  for (const item of data.items) {
    if (!validArtistSummary(item) || names.has(item.name)) throw new Error("艺术家列表包含无效或重复分组，请刷新重试。");
    names.add(item.name);
  }
  return data;
}

export async function refresh({ background = false, canApply = () => true } = {}) {
  if (!nodes || !currentPage() || background && loading) { dirty = true; return false; }
  pendingSearch?.cancel(); cancel(); const token = generation, invalidatedAt = invalidation;
  const wanted = { ...query, page_size: PAGE_SIZE }, key = queryKey(wanted);
  const abort = new AbortController(); controller = abort; loading = true; error = "";
  const current = () => token === generation && currentPage() && !abort.signal.aborted && key === queryKey() && key === queryKey(inputQuery());
  sync();
  if (!current()) return false;
  if (!background) { renderStatus(true); if (!snapshot) renderSkeletons(); }
  try {
    const data = await request(`/api/library/artists?${qs(wanted)}`, { signal: abort.signal });
    if (!current()) return false;
    if (!canApply()) { dirty = true; return false; }
    snapshot = validate(data, wanted); query.page = data.page; loaded = true; loading = false; dirty = invalidation !== invalidatedAt; loadedAt = Date.now();
    renderList(!background);
    if (token !== generation || !currentPage()) return false;
    renderStatus(); sync(); return true;
  } catch (reason) {
    if (!current()) return false;
    dirty = true; if (background) return false;
    loading = false; error = reason.message || "艺术家暂时无法读取"; renderList(false); renderStatus(); sync(); return false;
  } finally { if (token === generation) { controller = null; loading = false; sync(); } }
}

function sync() {
  if (!nodes) return;
  const focused = document.activeElement;
  nodes.host.dataset.phase = loading ? "loading" : error ? "error" : loaded ? "ready" : "idle";
  nodes.clear.hidden = !nodes.q.value;
  nodes.refreshButton.disabled = loading; nodes.refreshButton.setAttribute("aria-busy", String(loading));
  nodes.list.setAttribute("aria-busy", String(loading));
  nodes.total.textContent = loaded && snapshot ? `${ui.fmtNum(snapshot.total)} 位` : loading ? "读取中" : "等待载入";
  nodes.updated.textContent = loadedAt ? `更新于 ${ui.fmtTime(loadedAt / 1000)}` : "";
  nodes.page.textContent = loaded && snapshot ? `${snapshot.page} / ${Math.max(1, snapshot.pages)}` : "— / —";
  nodes.range.textContent = loaded && snapshot ? `共 ${ui.fmtNum(snapshot.total)} 位 · 每页 ${PAGE_SIZE} 位` : loading ? "正在读取收藏…" : "等待载入";
  nodes.previous.disabled = loading || !loaded || !snapshot || snapshot.page <= 1;
  nodes.next.disabled = loading || !loaded || !snapshot || snapshot.page >= snapshot.pages;
  nodes.pager.hidden = !loaded && !loading || Boolean(snapshot && !snapshot.total && !error);
  if (currentPage() && focused && nodes.host.contains(focused) && !focusable(focused)) nodes.q.focus({ preventScroll: true });
}

function renderStatus(pending = false) {
  nodes.status.replaceChildren(); nodes.status.hidden = false;
  if (pending) { nodes.status.append(ui.el("p", { text: snapshot ? "正在更新艺术家收藏…" : "正在读取艺术家收藏…" })); return; }
  if (error) {
    nodes.status.append(ui.el("div", { class: "artists-error" }, [ui.icon("warn", { size: 18 }), ui.el("div", {}, [ui.el("strong", { text: "艺术家暂时无法更新" }), ui.el("p", { text: error }), snapshot ? ui.el("p", { text: "以下保留本次查询上次成功载入的内容。" }) : null,
      ui.el("button", { id: "artists-retry", type: "button", class: "btn btn-sm", text: "重试读取", onClick: () => void refresh() })])])); return;
  }
  if (!snapshot?.items.length) {
    const filtered = Boolean(query.q);
    nodes.status.append(ui.el("div", { class: "artists-empty" }, [ui.el("span", { class: "artists-empty-icon", "aria-hidden": "true" }, [ui.icon(filtered ? "search" : "artist", { size: 31 })]),
      ui.el("h3", { text: filtered ? "没有找到这位艺术家" : "等待熟悉的声音入库" }), ui.el("p", { text: filtered ? "试试其他名称，或者清空搜索继续浏览收藏。" : "扫描音乐后，已填写艺术家的曲目会在这里归组。" }),
      ui.el("button", { id: "artists-empty-action", type: "button", class: "btn", text: filtered ? "清空搜索" : "查看未标注艺术家的曲目", onClick: () => {
        if (!currentPage()) return;
        if (filtered) { nodes.q.value = ""; changeQuery({ q: "" }); void refresh(); }
        else emit("albums:all-tracks", { no_artist: true });
      } })])); return;
  }
  nodes.status.hidden = true;
}

function renderSkeletons() {
  cards.clear(); nodes.list.hidden = false;
  nodes.list.replaceChildren(...Array.from({ length: 6 }, () => ui.el("li", { class: "artist-card artists-skeleton", "aria-hidden": "true" }, [ui.el("div", {}, [ui.el("span", { class: "artist-avatar" }), ui.el("div", { class: "artists-skeleton-lines" }, [ui.el("div", { class: "artists-skeleton-line" }), ui.el("div", { class: "artists-skeleton-line short" })])])])));
}

function createCard(item, index, animate) {
  const name = item.name;
  const card = ui.el("li", { class: `artist-card${animate && index < 8 ? " artist-card-enter" : ""}`, dataset: { artistName: name }, style: animate && index < 8 ? { animationDelay: `${index * 18}ms` } : null });
  const valid = () => currentPage() && Boolean(snapshot?.items.some(row => row.name === name)) && normalizeArtistGroup(name) === name;
  card.append(ui.el("button", { type: "button", class: "artist-open", dataset: { action: "detail" }, "aria-label": `查看 ${name} 的艺术家收藏`, onClick: () => { if (valid()) openArtistDetail(item); } }, [artistAvatar(name),
    ui.el("span", { class: "artist-card-copy" }, [ui.el("strong", { class: "artist-card-name", text: name, title: name }), ui.el("span", { class: "artist-card-counts" }, [ui.el("span", {}, [ui.el("strong", { text: ui.fmtNum(item.track_count) }), " 首曲目"]), ui.el("span", {}, [ui.el("strong", { text: ui.fmtNum(item.album_count) }), " 张专辑"])])])]),
    ui.el("div", { class: "artist-card-foot" }, [ui.el("span", { class: "artist-card-duration", text: artistDuration(item.duration) }), ui.el("button", { type: "button", class: "btn btn-sm btn-ghost artist-browse", dataset: { action: "browse" }, text: "在曲库查看", "aria-label": `在曲库查看 ${name} 的全部曲目`, onClick: () => { if (valid()) emit("artists:open-tracks", { name }); } })]));
  return card;
}

function renderList(animate) {
  const focused = document.activeElement, focusKey = nodes.list.contains(focused) ? focused.closest(".artist-card")?.dataset.artistName : null, focusAction = focused?.dataset.action;
  const nextCards = new Map(), ordered = [];
  for (const [index, item] of (snapshot?.items || []).entries()) {
    const fingerprint = JSON.stringify(item), old = cards.get(item.name);
    const element = old?.fingerprint === fingerprint ? old.element : createCard(item, index, animate);
    if (element === old?.element) { element.classList.remove("artist-card-enter"); element.style.animationDelay = ""; }
    nextCards.set(item.name, { element, fingerprint }); ordered.push(element);
  }
  let cursor = nodes.list.firstElementChild;
  for (const element of ordered) { if (element !== cursor) nodes.list.insertBefore(element, cursor); cursor = element.nextElementSibling; }
  while (cursor) { const next = cursor.nextElementSibling; cursor.remove(); cursor = next; }
  cards.clear(); for (const [name, card] of nextCards) cards.set(name, card);
  nodes.list.hidden = !ordered.length;
  if (focusKey && currentPage()) (cards.get(focusKey)?.element.querySelector(focusAction === "browse" ? ".artist-browse" : ".artist-open") || nodes.q).focus({ preventScroll: true });
}

for (const event of ["metatidy:unauthorized", "metatidy:logout"]) window.addEventListener(event, () => {
  blocked = true; leave(); snapshot = null; loaded = false; loadedAt = 0; error = ""; dirty = true; cards.clear();
  if (nodes) { nodes.list.replaceChildren(); nodes.status.replaceChildren(); sync(); }
});
window.addEventListener("metatidy:authenticated", () => { blocked = false; dirty = true; });
