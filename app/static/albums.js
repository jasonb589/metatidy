/** Album browsing reads paginated index summaries; audio files remain untouched. */
import { request, qs, coverUrl } from "./api.js";
import { emit } from "./store.js";
import * as ui from "./ui.js";

const PAGE_SIZE = 24;
const SORTS = ["album", "artist", "recent"];
const query = { q: "", sort: "album", incomplete: false, page: 1 };
let nodes = null;
let active = false;
let dirty = true;
let loaded = false;
let loading = false;
let sequence = 0;
let invalidation = 0;
let controller = null;
let pendingSearch = null;
let items = [];
let total = 0;
let pages = 0;
let error = "";
let cards = new Map();
let loadedAt = 0;

const count = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const albumKey = (item) => JSON.stringify([item.album, item.album_artist]);
const label = (value, fallback = "") => typeof value === "string" && value ? value : fallback;

function duration(value) {
  const seconds = Math.round(count(value));
  if (!seconds) return "时长待补充";
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分 ${seconds % 60} 秒`;
}

export function init() {
  if (nodes) return;
  const host = ui.byId("albums-root");
  if (!host) return;
  host.classList.add("album-workspace");
  const q = ui.el("input", { id: "albums-q", type: "search", autocomplete: "off", placeholder: "搜索专辑或专辑艺术家…", "aria-label": "搜索专辑" });
  const sort = ui.el("select", { id: "albums-sort", "aria-label": "专辑排序" }, [
    ui.el("option", { value: "album", text: "专辑名称" }),
    ui.el("option", { value: "artist", text: "专辑艺术家" }),
    ui.el("option", { value: "recent", text: "最近索引" }),
  ]);
  const incomplete = ui.el("input", { id: "albums-incomplete", type: "checkbox" });
  const refreshButton = ui.el("button", { id: "albums-refresh", type: "button", class: "btn btn-sm btn-ghost", onClick: () => { pendingSearch.cancel(); void refresh(); } }, [ui.icon("refresh", { size: 14 }), "刷新"]);
  const totalLabel = ui.el("span", { id: "albums-total", class: "badge count-chip", text: "等待载入" });
  const status = ui.el("div", { id: "albums-status", class: "albums-status", role: "status", "aria-live": "polite" });
  const grid = ui.el("ul", { id: "albums-grid", class: "albums-grid", "aria-label": "专辑收藏" });
  const pager = ui.el("nav", { id: "albums-pager", class: "albums-pager", "aria-label": "专辑分页" });
  const clear = ui.el("button", { id: "albums-clear-filters", type: "button", class: "btn btn-sm btn-ghost", text: "清空筛选", hidden: true, onClick: resetFilters });
  const updated = ui.el("span", { id: "albums-updated", class: "hint" });
  const allTracks = ui.el("button", { id: "albums-all-tracks", type: "button", class: "btn btn-sm", onClick: () => emit("albums:all-tracks") }, [ui.icon("music", { size: 14 }), "回到曲目库"]);
  nodes = { host, q, sort, incomplete, refreshButton, totalLabel, status, grid, pager, clear, updated, allTracks };

  host.append(
    ui.el("div", { class: "albums-intro" }, [
      ui.el("div", { class: "albums-intro-icon", "aria-hidden": "true" }, [ui.icon("album", { size: 24 })]),
      ui.el("div", { class: "albums-intro-copy" }, [
        ui.el("p", { class: "eyebrow", text: "COLLECTED TOGETHER" }),
        ui.el("h2", { text: "让每张专辑，完整相聚。" }),
        ui.el("p", { text: "从一张封面开始，查看整张专辑的收藏与资料。" }),
      ]), allTracks,
    ]),
    ui.el("section", { class: "card albums-collection", "aria-label": "浏览专辑" }, [
      ui.el("div", { class: "card-head albums-heading" }, [
        ui.el("h2", {}, [ui.icon("album", { size: 16 }), "专辑收藏"]), totalLabel,
        ui.el("div", { class: "grow" }, [updated, refreshButton]),
      ]),
      ui.el("div", { class: "albums-toolbar" }, [
        ui.el("label", { class: "search-field albums-search" }, [ui.icon("search", { size: 17 }), q]),
        ui.el("label", { class: "row-inline albums-sort" }, [ui.el("span", { class: "lbl", text: "排序" }), sort]),
        ui.el("label", { class: "check albums-incomplete" }, [incomplete, ui.el("span", { text: "仅待完善" })]), clear,
      ]),
      ui.el("div", { class: "albums-guide" }, [
        ui.el("span", { text: "按专辑名与专辑艺术家归组；未填专辑艺术家时使用曲目歌手。" }),
        ui.el("span", { text: "不含未标注专辑的曲目。" }),
      ]), status, grid, pager,
    ]),
  );

  pendingSearch = ui.debounce(() => { if (active) void refresh(); }, 300);
  q.addEventListener("input", () => {
    changeQuery({ q: q.value.trim() });
    pendingSearch();
  });
  q.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    pendingSearch.cancel();
    changeQuery({ q: q.value.trim() });
    void refresh();
  });
  sort.addEventListener("change", () => {
    pendingSearch.cancel();
    changeQuery({ sort: SORTS.includes(sort.value) ? sort.value : "album" });
    void refresh();
  });
  incomplete.addEventListener("change", () => {
    pendingSearch.cancel();
    changeQuery({ incomplete: incomplete.checked });
    void refresh();
  });
  window.addEventListener("metatidy:unauthorized", leave);
  renderPager();
}

function changeQuery(changes) {
  controller?.abort();
  sequence += 1;
  loading = false;
  Object.assign(query, changes, { page: 1 });
  dirty = true;
  error = "";
  syncControls();
}

function resetFilters() {
  pendingSearch.cancel();
  changeQuery({ q: "", incomplete: false });
  nodes.q.value = "";
  nodes.incomplete.checked = false;
  nodes.q.focus({ preventScroll: true });
  void refresh();
}

function syncControls() {
  if (!nodes) return;
  nodes.clear.hidden = !query.q && !query.incomplete;
  nodes.refreshButton.disabled = loading;
  nodes.refreshButton.setAttribute("aria-busy", String(loading));
  nodes.grid.setAttribute("aria-busy", String(loading));
}

export function isLoading() { return loading; }

export function invalidate() {
  dirty = true;
  invalidation += 1;
}

export function activate() {
  init();
  active = true;
  if (nodes && (dirty || !loaded || error)) return refresh();
  return Promise.resolve(true);
}

export function leave() {
  active = false;
  pendingSearch?.cancel();
  if (loading) dirty = true;
  controller?.abort();
  sequence += 1;
  loading = false;
  syncControls();
}

/** Stale requests may finish, but only a current, visible page may accept them. */
export async function refresh({ background = false, canApply = () => true } = {}) {
  if (!nodes || !active || (background && loading)) { dirty = true; return false; }
  const revision = ++sequence;
  const invalidatedAt = invalidation;
  controller?.abort();
  const abort = new AbortController();
  controller = abort;
  loading = true;
  if (!background) error = "";
  syncControls();
  if (!background) {
    renderStatus({ pending: true });
    if (!loaded) renderSkeletons();
  }
  const wanted = { ...query, page_size: PAGE_SIZE };
  try {
    const result = await request(`/api/albums?${qs(wanted)}`, { signal: abort.signal });
    if (!active || revision !== sequence) return false;
    if (!canApply()) { dirty = true; return false; }
    if (!Array.isArray(result.items) || !Number.isFinite(Number(result.total))) throw new Error("专辑数据不完整，请刷新重试。");
    items = result.items.filter((item) => item && typeof item.album === "string" && typeof item.album_artist === "string");
    total = count(result.total);
    pages = Math.max(1, Math.trunc(count(result.pages)));
    query.page = Math.max(1, Math.min(pages, Math.trunc(count(result.page)) || 1));
    loaded = true;
    loadedAt = Date.now();
    dirty = invalidation !== invalidatedAt;
    error = "";
    loading = false;
    renderGrid({ animate: !background });
    renderStatus();
    renderPager();
    return true;
  } catch (reason) {
    if (!active || revision !== sequence || abort.signal.aborted) return false;
    dirty = true;
    if (background) return false;
    error = reason?.message || "无法载入专辑";
    loading = false;
    renderGrid({ animate: false });
    renderStatus();
    renderPager();
    return false;
  } finally {
    if (revision === sequence) {
      loading = false;
      syncControls();
      if (background && loaded && nodes.status.querySelector(".albums-loading-text")) renderStatus();
    }
  }
}

function renderStatus({ pending = false } = {}) {
  nodes.status.replaceChildren();
  nodes.status.hidden = false;
  nodes.totalLabel.textContent = loaded ? `共 ${ui.fmtNum(total)} 张` : "等待载入";
  nodes.updated.textContent = loadedAt ? `更新于 ${ui.fmtTime(loadedAt / 1000)}` : "";
  if (pending) {
    nodes.status.append(ui.el("p", { class: "albums-loading-text", text: loaded ? "正在更新专辑…" : "正在整理专辑收藏…" }));
    return;
  }
  if (error) {
    nodes.status.append(ui.el("div", { class: "albums-error" }, [
      ui.icon("warn", { size: 19 }),
      ui.el("div", {}, [ui.el("strong", { text: "专辑暂时无法更新" }), ui.el("p", { text: error }), loaded && items.length ? ui.el("p", { class: "hint", text: "下方保留上一次成功载入的专辑。" }) : null]),
      ui.el("button", { id: "albums-retry", type: "button", class: "btn btn-sm", text: "重试", onClick: () => void refresh() }),
    ]));
    return;
  }
  if (!items.length) {
    const filtered = Boolean(query.q || query.incomplete);
    nodes.status.append(ui.el("div", { class: "albums-empty" }, [
      ui.el("span", { class: "albums-empty-icon", "aria-hidden": "true" }, [ui.icon(filtered ? "search" : "album", { size: 31 })]),
      ui.el("h3", { text: filtered ? "没有符合条件的专辑" : "等待第一张专辑入库" }),
      ui.el("p", { text: filtered ? "试试其他专辑名或艺术家，或者清空筛选。" : "这里只展示已填写专辑名的曲目。先扫描音乐，或到曲目库补全空白的专辑标签。" }),
      ui.el("div", { class: "albums-empty-actions" }, filtered ? [
        ui.el("button", { type: "button", class: "btn", text: "清空筛选", onClick: resetFilters }),
      ] : [
        ui.el("button", { id: "albums-untagged", type: "button", class: "btn", text: "查看未标注专辑的曲目", onClick: () => emit("albums:all-tracks", { no_album: true }) }),
      ]),
    ]));
    return;
  }
  nodes.status.hidden = true;
}

function renderSkeletons() {
  cards.clear();
  nodes.grid.hidden = false;
  nodes.grid.replaceChildren(...Array.from({ length: 6 }, () => ui.el("li", { class: "album-card album-skeleton", "aria-hidden": "true" }, [
    ui.el("div", { class: "album-art" }), ui.el("div", { class: "album-skeleton-line" }), ui.el("div", { class: "album-skeleton-line short" }),
  ])));
}

function artwork(item, animate) {
  let tone = 0;
  for (const char of albumKey(item)) tone = (tone * 31 + char.codePointAt(0)) % 5;
  const art = ui.el("span", { class: "album-art", dataset: { tone } });
  const fallback = (failed = false) => {
    art.classList.add("album-art-empty");
    art.replaceChildren(ui.icon("album", { size: 46 }), ui.el("span", { text: failed ? "封面暂不可用" : "待补一张封面" }));
  };
  if (Number.isSafeInteger(Number(item.cover_track_id)) && Number(item.cover_track_id) > 0) {
    const img = ui.el("img", { src: coverUrl(Number(item.cover_track_id), 256), width: 256, height: 256, alt: "", loading: "lazy", decoding: "async" });
    img.addEventListener("error", () => fallback(true), { once: true });
    art.append(img);
    if (animate) ui.enhanceArtwork(art, img);
  } else fallback();
  return art;
}

function createCard(item, index, animate) {
  const key = albumKey(item);
  const open = () => emit("albums:open", { album: item.album, album_artist: item.album_artist });
  const albumName = label(item.album, "未命名专辑");
  const artist = label(item.album_artist, "未知专辑艺术家");
  const missing = [
    ["missing_cover", "待补封面", "cover"], ["missing_lyrics", "待补歌词", "lyrics"], ["not_loaded", "待读标签", "info"],
  ].filter(([field]) => count(item[field]) > 0);
  const card = ui.el("li", { class: `album-card${animate && index < 8 ? " album-card-enter" : ""}`, dataset: { albumKey: key }, style: animate && index < 8 ? { animationDelay: `${index * 22}ms` } : null });
  card.append(
    ui.el("button", { type: "button", class: "album-art-open", dataset: { action: "art" }, "aria-label": `查看 ${artist} · ${albumName} 的曲目`, onClick: open }, [
      artwork(item, animate),
      ui.el("span", { class: "album-count", "aria-hidden": "true", text: `${ui.fmtNum(count(item.track_count))} 首` }),
      ui.el("span", { class: "album-art-hint", "aria-hidden": "true" }, [ui.icon("music", { size: 15 }), "打开专辑"]),
    ]),
    ui.el("div", { class: "album-card-content" }, [
      ui.el("h3", { class: "album-title truncate", title: albumName, text: albumName }),
      ui.el("p", { class: "album-artist truncate", title: artist, text: artist }),
      ui.el("div", { class: "album-meta" }, [
        ui.el("span", { text: duration(item.duration) }),
        label(item.year) ? ui.el("span", { class: "album-year", text: item.year, title: item.year }) : null,
      ]),
      ui.el("div", { class: "album-completeness" }, missing.length ? missing.map(([field, caption, icon]) => ui.el("span", {
        class: "album-missing", dataset: { field }, title: `${ui.fmtNum(count(item[field]))} 首曲目${caption}`,
      }, [ui.icon(icon, { size: 12 }), `${caption} ${ui.fmtNum(count(item[field]))}`])) : [
        ui.el("span", { class: "album-complete" }, [ui.icon("check", { size: 12 }), "封面与歌词已齐备"]),
      ]),
      ui.el("div", { class: "album-card-foot" }, [
        ui.el("span", { class: "album-bytes", title: "已索引的音频文件大小", text: ui.fmtBytes(count(item.bytes)) }),
        ui.el("button", { type: "button", class: "btn btn-sm btn-ghost album-open", dataset: { albumOpen: key, action: "open" }, text: "查看曲目", "aria-label": `查看 ${artist} · ${albumName} 的曲目`, onClick: open }),
      ]),
    ]),
  );
  return card;
}

function renderGrid({ animate }) {
  const focused = document.activeElement;
  const currentCard = nodes.grid.contains(focused) ? focused.closest(".album-card") : null;
  const focusKey = currentCard?.dataset.albumKey;
  const action = focused?.dataset.action;
  const nextCards = new Map();
  const ordered = [];
  items.forEach((item, index) => {
    const key = albumKey(item);
    if (nextCards.has(key)) return;
    const fingerprint = JSON.stringify(item);
    const previous = cards.get(key);
    const element = previous?.fingerprint === fingerprint ? previous.element : createCard(item, index, animate);
    if (previous?.element === element) {
      element.classList.remove("album-card-enter");
      element.style.animationDelay = "";
      const art = element.querySelector(".album-art");
      if (art) art.style.animation = "none";
      const image = art?.querySelector("img");
      if (image) image.style.animation = "none";
    }
    nextCards.set(key, { element, fingerprint });
    ordered.push(element);
  });
  // Keep unchanged cards attached so polling does not replay their artwork,
  // reset browser focus, or interrupt an image request already in progress.
  let cursor = nodes.grid.firstElementChild;
  ordered.forEach((element) => {
    if (element !== cursor) nodes.grid.insertBefore(element, cursor);
    cursor = element.nextElementSibling;
  });
  while (cursor) {
    const next = cursor.nextElementSibling;
    cursor.remove();
    cursor = next;
  }
  nodes.grid.hidden = items.length === 0;
  cards = nextCards;
  if (focusKey) {
    const replacement = cards.get(focusKey)?.element;
    const button = replacement?.querySelector(action === "art" ? ".album-art-open" : ".album-open");
    (button || nodes.q).focus({ preventScroll: true });
  }
}

function renderPager() {
  const focusedId = nodes.pager.contains(document.activeElement) ? document.activeElement.id : "";
  const navigate = (page) => {
    pendingSearch.cancel();
    query.page = Math.max(1, Math.min(pages || 1, page));
    dirty = true;
    void refresh();
  };
  nodes.pager.replaceChildren(
    ui.el("span", { id: "albums-page", class: "albums-page-label", text: `第 ${query.page} / ${pages || 1} 页` }),
    ui.el("span", { class: "hint albums-page-size", text: `每页 ${PAGE_SIZE} 张` }),
    ui.el("div", { class: "spacer" }),
    ui.el("button", { id: "albums-prev", type: "button", class: "btn btn-sm", text: "上一页", disabled: query.page <= 1 || !loaded, onClick: () => navigate(query.page - 1) }),
    ui.el("button", { id: "albums-next", type: "button", class: "btn btn-sm", text: "下一页", disabled: query.page >= pages || !loaded, onClick: () => navigate(query.page + 1) }),
  );
  nodes.pager.hidden = !loaded || (!items.length && !error);
  if (focusedId) {
    const destination = ui.byId(focusedId);
    if (destination && !destination.disabled && !nodes.pager.hidden) destination.focus({ preventScroll: true });
    else nodes.q.focus({ preventScroll: true });
  }
}
