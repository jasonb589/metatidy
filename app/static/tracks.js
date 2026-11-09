/**
 * 页签 1：曲库 / 元数据编辑。
 *
 * 交互要点：
 * - 搜索输入 300ms 防抖，只重建 tbody（不改动其它 DOM）
 * - 编辑走「填字段 → 预览差异（只读）→ 确认 → 写入」，失败明细直接列在抽屉里
 * - 封面只在该行 has_cover 为真时才请求 /cover，避免满屏 404
 */

import { api, coverUrl, pollJob } from "./api.js";
import * as ui from "./ui.js";
import { openTrackDetails } from "./track-inspector.js";
import { initSavedFilters } from "./saved-filters.js";
import { showKeyboardHelp } from "./keyboard-help.js";
import { normalizeAlbumGroup, albumGroupLabel } from "./album-group.js";
import { playTrack } from "./audio-player.js";
import { createEditSequence } from "./edit-sequence.js";
import {
  state,
  emit,
  on,
  isSelected,
  toggleSelect,
  selectRows,
  clearSelection,
  selectionRows,
  selectionCount,
  removeFromSelection,
  setCurrentTrack,
  updateTrackSnapshot,
} from "./store.js";

const EDIT_FIELDS = [
  "title",
  "artist",
  "album",
  "albumartist",
  "genre",
  "year",
  "track",
  "disc",
  "language",
  "albumtype",
  "composer",
  "lyricist",
  "copyright",
  "comment",
  "mb_artist_id",
  "release_group_id",
];

/** 打开面板时从文件里读回来的歌词基线：只有改动过才带进预览 / 写入。 */
let lyricsBase = "";

const FILTER_KEYS = ["folder", "album_group", "artist", "album", "language", "albumtype", "genre", "year", "missing_cover", "missing_lyrics", "no_artist", "no_album", "not_loaded"];
const SORT_KEYS = ["artist", "album", "title", "year", "track", "disc_track", "path", "indexed", "edited"];

let nodes = null;
let editTrigger = null;
let refreshSequence = 0;
let editRevision = 0;
let editBaseline = new Map();
let editTouched = new Set();
let editDetailRequest = null;
let editLyricsRequest = null;
let editUnavailable = false;
let lyricsTouched = false;
let savedFilters = null;
let cancelPendingSearch = () => {};
let audioState = { id: null, status: "stopped" };
let editSequence = null;
let editSequenceView = null;
let editLeavePrompt = null;
let editAccessBlocked = false;
let selectionControls = null;

export function init() {
  nodes = {
    strip: ui.byId("stats-strip"),
    health: ui.byId("library-health"),
    quickFilters: ui.byId("quick-filters"),
    scanBtn: ui.byId("btn-scan"),
    scanFull: ui.byId("scan-full"),
    scanFast: ui.byId("scan-fast"),
    scanPrune: ui.byId("scan-prune"),
    scanProgress: ui.byId("scan-progress"),
    scanRoot: ui.byId("scan-root"),
    updated: ui.byId("tracks-updated"),
    total: ui.byId("tracks-total"),
    reload: ui.byId("btn-tracks-reload"),
    reset: ui.byId("btn-filters-reset"),
    editSelected: ui.byId("btn-edit-selected"),
    q: ui.byId("tracks-q"),
    sort: ui.byId("tracks-sort"),
    order: ui.byId("tracks-order"),
    pageSize: ui.byId("tracks-pagesize"),
    fArtist: ui.byId("filter-artist"),
    fAlbum: ui.byId("filter-album"),
    fLanguage: ui.byId("filter-language"),
    fAlbumtype: ui.byId("filter-albumtype"),
    fGenre: ui.byId("filter-genre"),
    fYear: ui.byId("filter-year"),
    fCover: ui.byId("filter-missing-cover"),
    fLyrics: ui.byId("filter-missing-lyrics"),
    fNoArtist: ui.byId("filter-no-artist"),
    fNoAlbum: ui.byId("filter-no-album"),
    fNotLoaded: ui.byId("filter-not-loaded"),
    checkPage: ui.byId("check-page"),
    tbody: ui.byId("tracks-tbody"),
    tableWrap: ui.byId("tracks-table-wrap"),
    tableStatus: ui.byId("tracks-table-status"),
    selectionBar: ui.byId("selection-bar"),
    pager: ui.byId("tracks-pager"),
    drawer: ui.byId("edit-drawer"),
    drawerScope: ui.byId("edit-scope"),
    drawerClose: ui.byId("edit-close"),
    drawerPreview: ui.byId("btn-edit-preview"),
    drawerClear: ui.byId("btn-edit-clear"),
    drawerResult: ui.byId("edit-result"),
    editDescription: ui.byId("edit-description"),
    editLoadStatus: ui.byId("edit-load-status"),
    editLoadRetry: ui.byId("edit-load-retry"),
    editChangeSummary: ui.byId("edit-change-summary"),
    editNormalize: ui.byId("edit-normalize"),
    editOverwrite: ui.byId("edit-overwrite"),
    editLyrics: ui.byId("edit-lyrics"),
    editLyricsHint: ui.byId("edit-lyrics-hint"),
    dlLanguages: ui.byId("dl-languages"),
    dlAlbumtypes: ui.byId("dl-albumtypes"),
  };
  editSequenceView = createEditSequence({
    host: ui.byId("edit-sequence"), onNavigate: navigateEditSequence, onSkip: skipEditSequence,
  });
  initLibraryViews();
  window.addEventListener("metatidy:audio-state", event => {
    audioState = event.detail || { id: null, status: "stopped" };
    syncAudioControls();
  });

  const debouncedSearch = ui.debounce(() => {
    state.tracks.q = nodes.q.value.trim();
    state.tracks.page = 1;
    refresh();
  }, 300);
  cancelPendingSearch = debouncedSearch.cancel;

  nodes.q.addEventListener("input", () => {
    // 先保存文字，避免防抖期间点击快捷筛选时被旧 query 覆盖。
    state.tracks.q = nodes.q.value.trim();
    state.tracks.page = 1;
    syncFilterShortcuts();
    debouncedSearch();
  });
  nodes.q.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      debouncedSearch.cancel();
      state.tracks.q = nodes.q.value.trim();
      state.tracks.page = 1;
      refresh();
    }
  });

  nodes.sort.addEventListener("change", () => {
    state.tracks.sort = nodes.sort.value;
    state.tracks.page = 1;
    refresh();
  });
  nodes.order.addEventListener("change", () => {
    state.tracks.order = nodes.order.value;
    state.tracks.page = 1;
    refresh();
  });
  nodes.pageSize.addEventListener("change", () => {
    state.tracks.page_size = Number(nodes.pageSize.value) || 100;
    state.tracks.page = 1;
    refresh();
  });

  nodes.fArtist.addEventListener("change", () => applyFilter("artist", nodes.fArtist.value.trim()));
  nodes.fAlbum.addEventListener("change", () => applyFilter("album", nodes.fAlbum.value.trim()));
  nodes.fLanguage.addEventListener("change", () => applyFilter("language", nodes.fLanguage.value));
  nodes.fAlbumtype.addEventListener("change", () => applyFilter("albumtype", nodes.fAlbumtype.value));
  nodes.fGenre.addEventListener("change", () => applyFilter("genre", nodes.fGenre.value.trim()));
  nodes.fYear.addEventListener("change", () => applyFilter("year", nodes.fYear.value.trim()));
  nodes.fCover.addEventListener("change", () => applyFilter("missing_cover", nodes.fCover.checked));
  nodes.fLyrics.addEventListener("change", () => applyFilter("missing_lyrics", nodes.fLyrics.checked));
  nodes.fNoArtist.addEventListener("change", () => applyFilter("no_artist", nodes.fNoArtist.checked));
  nodes.fNoAlbum.addEventListener("change", () => applyFilter("no_album", nodes.fNoAlbum.checked));
  nodes.fNotLoaded.addEventListener("change", () => applyFilter("not_loaded", nodes.fNotLoaded.checked));

  nodes.quickFilters?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-quick-filter]");
    if (!button) return;
    const key = button.dataset.quickFilter;
    if (key === "all") resetFilters();
    else if (key === "missing_cover" || key === "missing_lyrics") {
      state.tracks.filters.missing_cover = key === "missing_cover";
      state.tracks.filters.missing_lyrics = key === "missing_lyrics";
      syncControls();
    } else return;
    state.tracks.page = 1;
    refresh();
  });

  on("selection:changed", () => {
    nodes.tbody.querySelectorAll("tr[data-id]").forEach((row) => {
      const selected = isSelected(row.dataset.id);
      row.setAttribute("aria-selected", String(selected));
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (checkbox) checkbox.checked = selected;
    });
    nodes.grid.querySelectorAll(".track-card[data-id]").forEach((card) => {
      const selected = isSelected(card.dataset.id);
      card.dataset.selected = String(selected);
      card.querySelector('input[type="checkbox"]').checked = selected;
    });
    syncPageCheckbox();
    renderSelectionBar();
  });

  nodes.reset.addEventListener("click", () => {
    resetFilters();
    refresh();
  });

  // 恢复上次的筛选/排序/每页，并挂上表格键盘导航
  loadPrefs();
  savedFilters = initSavedFilters({
    host: ui.byId("saved-filters-host"),
    getSnapshot: () => ({
      q: state.tracks.q, sort: state.tracks.sort, order: state.tracks.order,
      page_size: state.tracks.page_size, view: state.tracks.view, density: state.tracks.density,
      filters: { ...state.tracks.filters },
    }),
    applySnapshot: (snapshot) => {
      debouncedSearch.cancel();
      Object.assign(state.tracks, snapshot, { filters: { ...snapshot.filters }, page: 1 });
      syncControls();
      refresh();
    },
  });
  wireTableKeys();

  // 命令面板（Ctrl/⌘+K）只发事件，真正做事在这里
  on("palette:scan", (payload = {}) => {
    if (nodes.scanBtn.disabled) return; // 已有扫描在跑，别叠第二个
    // 面板给的是明确模式，设成互斥，结果才可预期
    if (payload.fast) {
      nodes.scanFast.checked = true;
      nodes.scanFull.checked = false;
    }
    if (payload.full) {
      nodes.scanFull.checked = true;
      nodes.scanFast.checked = false;
    }
    if (state.tab !== "tracks") location.hash = "#tracks";
    startScan();
  });
  on("palette:reload", () => refresh());
  on("palette:clear-filters", () => {
    resetFilters();
    refresh();
  });
  on("palette:focus-search", () => {
    const focus = () => {
      nodes.q.focus();
      nodes.q.select();
    };
    // 切页签要先等 hashchange → activateTab 把面板显出来，隐藏元素聚焦会被忽略
    if (state.tab === "tracks") focus();
    else {
      location.hash = "#tracks";
      setTimeout(focus, 60);
    }
  });
  on("palette:track", (row) => {
    if (!row) return;
    const open = () => {
      const fresh = state.tracks.items.find((item) => String(item.id) === String(row.id));
      openEdit([fresh || row]);
    };
    if (state.tab === "tracks") open();
    else {
      location.hash = "#tracks";
      setTimeout(open, 60);
    }
  });
  nodes.reload.addEventListener("click", () => refresh());
  nodes.scanBtn.addEventListener("click", startScan);

  // 「快速扫描」与「全量重扫」可以叠加：fast 只从路径建索引（不打开文件），
  // full 忽略 mtime 缓存强制重算——两个一起勾就是「按目录结构把整库重算一遍」。
  nodes.editSelected.addEventListener("click", () => openEdit(selectionRows()));

  nodes.checkPage.addEventListener("change", () => {
    selectRows(state.tracks.items, nodes.checkPage.checked);
  });

  document.querySelectorAll("th[data-sort-col] .th-sort").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.sort;
      if (state.tracks.sort === key) {
        state.tracks.order = state.tracks.order === "asc" ? "desc" : "asc";
      } else {
        state.tracks.sort = key;
        state.tracks.order = "asc";
      }
      nodes.sort.value = state.tracks.sort;
      nodes.order.value = state.tracks.order;
      state.tracks.page = 1;
      refresh();
    });
  });

  nodes.tbody.addEventListener("click", (event) => {
    const listen = event.target.closest("button[data-play-id]");
    if (listen) { listenToTrack(listen.dataset.playId); return; }
    const detail = event.target.closest("button[data-detail-id]");
    if (detail) {
      inspectTrack(detail.dataset.detailId, detail);
      return;
    }
    const edit = event.target.closest("button[data-edit-id]");
    if (edit) {
      const row = state.tracks.items.find((item) => String(item.id) === edit.dataset.editId);
      if (row) openEdit([row]);
    }
  });

  nodes.drawerClose.addEventListener("click", () => closeEdit());
  nodes.drawerClear.addEventListener("click", resetEditDraft);
  nodes.editLoadRetry.addEventListener("click", () => void loadEditMetadata());
  for (const key of EDIT_FIELDS) {
    const input = ui.byId(`edit-${key}`);
    const hint = ui.el("small", { id: `edit-hint-${key}`, class: "edit-field-hint" });
    input.closest(".field").append(hint);
    input.setAttribute("aria-describedby", hint.id);
    input.addEventListener("input", () => { editTouched.add(key); syncEditDraft(); });
  }
  nodes.editLyrics?.addEventListener("input", () => { lyricsTouched = true; syncEditDraft(); });
  const lockEdit = () => { editAccessBlocked = true; closeEdit({ restoreFocus: false, force: true }); };
  window.addEventListener("metatidy:unauthorized", lockEdit);
  window.addEventListener("metatidy:logout", lockEdit);
  window.addEventListener("metatidy:authenticated", () => { editAccessBlocked = false; });
  nodes.drawerPreview.addEventListener("click", runPreview);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !state.edit.open || event.defaultPrevented || hasOverlayAboveEditor()) return;
    event.preventDefault();
    closeEdit();
  });

  // 抽屉关闭时整体移出可聚焦顺序，避免 Tab 走到 aria-hidden 面板里的输入框
  nodes.drawer.inert = true;
  syncControls();
}

/** 视图只改变当前页的呈现；筛选、分页和跨页勾选继续共用原状态。 */
function initLibraryViews() {
  nodes.libraryCard = nodes.tableWrap.closest(".library-card");
  nodes.viewControls = ui.el("div", { id: "library-view-controls", class: "library-view-controls" });
  const views = ui.el("div", { class: "library-segment", role: "group", "aria-label": "曲目视图" });
  for (const [value, label, icon] of [["list", "列表", "music"], ["cards", "封面", "cover"]]) {
    views.append(ui.el("button", {
      id: `view-${value}`, type: "button", "aria-pressed": String(value === "list"),
      "aria-controls": value === "list" ? "tracks-table-wrap" : "tracks-grid",
      "aria-label": `${label}视图`, title: value === "cards" ? "按曲目浏览封面卡片" : "以列表浏览曲目",
      onClick: () => {
        if (state.tracks.view === value) return;
        state.tracks.view = value;
        syncViewControls();
        renderTableStatus();
        renderCollection({ animate: false });
        animateViewChange();
        savePrefs();
      },
    }, [ui.icon(icon, { size: 14 }), ui.el("span", { text: label })]));
  }
  nodes.densityControls = ui.el("div", {
    id: "library-density-controls", class: "library-segment library-density", role: "group", "aria-label": "列表密度",
  });
  for (const [value, label] of [["comfortable", "舒适"], ["compact", "紧凑"]]) {
    nodes.densityControls.append(ui.el("button", {
      id: `density-${value}`, type: "button", text: label,
      "aria-pressed": String(value === "comfortable"), "aria-label": `${label}密度`,
      onClick: () => {
        state.tracks.density = value;
        syncViewControls();
        savePrefs();
      },
    }));
  }
  nodes.displaySettings = ui.byId("library-display-settings");
  nodes.displaySummary = ui.byId("library-display-summary");
  nodes.displayDensity = ui.byId("library-display-density");
  nodes.displayDensity.append(nodes.densityControls);
  const closeDisplaySettings = (restoreFocus = false) => {
    if (!nodes.displaySettings.open) return;
    nodes.displaySettings.open = false;
    if (restoreFocus) ui.byId("library-display-toggle").focus({ preventScroll: true });
  };
  document.addEventListener("click", event => {
    if (!nodes.displaySettings.contains(event.target)) closeDisplaySettings();
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.defaultPrevented || !nodes.displaySettings.open || document.querySelector("dialog[open]")) return;
    event.preventDefault();
    closeDisplaySettings(true);
  });
  window.addEventListener("hashchange", () => closeDisplaySettings());
  window.addEventListener("metatidy:unauthorized", () => closeDisplaySettings());
  nodes.viewControls.append(views, ui.el("button", {
    type: "button", id: "btn-library-shortcuts", class: "library-help-button", text: "?",
    title: "键盘快捷键（?）", "aria-label": "查看键盘快捷键", onClick: showKeyboardHelp,
  }));
  const toolbar = nodes.quickFilters?.closest(".filter-toolbar") || nodes.q.closest(".library-toolbar");
  toolbar.append(nodes.viewControls);

  nodes.recentIndexed = ui.el("button", {
    id: "quick-recent-indexed", type: "button", text: "最近索引", "aria-pressed": "false",
    title: "按最近一次索引时间倒序排列，保留当前筛选。全量重扫也会更新索引时间。",
    onClick: () => {
      state.tracks.sort = "indexed";
      state.tracks.order = "desc";
      state.tracks.page = 1;
      syncControls();
      refresh();
    },
  });
  nodes.quickFilters?.append(nodes.recentIndexed);

  nodes.checkGridPage = ui.el("input", { id: "check-grid-page", type: "checkbox", "aria-label": "选择本页全部曲目" });
  nodes.checkGridPage.addEventListener("change", () => selectRows(state.tracks.items, nodes.checkGridPage.checked));
  nodes.gridControls = ui.el("div", { id: "tracks-grid-controls", class: "tracks-grid-controls", hidden: true }, [
    ui.el("label", { class: "check" }, [nodes.checkGridPage, ui.el("span", { text: "选择本页" })]),
    ui.el("span", { class: "hint", text: "每张封面代表一首曲目" }),
  ]);
  nodes.grid = ui.el("ul", { id: "tracks-grid", class: "tracks-grid", "aria-label": "曲目封面卡片", hidden: true });
  nodes.tableWrap.after(nodes.gridControls, nodes.grid);
  nodes.grid.addEventListener("click", (event) => {
    const listen = event.target.closest("button[data-play-id]");
    if (listen) { listenToTrack(listen.dataset.playId); return; }
    const button = event.target.closest("button[data-edit-id], button[data-scrape-id], button[data-detail-id]");
    if (!button) return;
    if (button.dataset.detailId) {
      inspectTrack(button.dataset.detailId, button);
      return;
    }
    const id = button.dataset.editId || button.dataset.scrapeId;
    const row = state.tracks.items.find((item) => String(item.id) === id);
    if (!row) return;
    if (button.dataset.editId) openEdit([row]);
    else {
      setCurrentTrack(row);
      location.hash = "#scrape";
    }
  });
}

function listenToTrack(id) {
  const row = state.tracks.items.find(item => String(item.id) === String(id));
  if (row) playTrack(row, { rows: [...state.tracks.items] });
}

function playButton(row, { cover = false, reveal = true } = {}) {
  const title = row.title || row.filename || "未命名曲目";
  return ui.el("button", {
    type: "button", class: cover ? "track-listen-cover" : "track-card-play",
    dataset: { playId: String(row.id), trackTitle: title }, title: `播放 ${title}`,
    "aria-label": `播放 ${title}`, "aria-pressed": "false",
  }, [
    cover ? ui.coverThumb(row, { size: 48, reveal }) : null,
    ui.el("span", { class: "track-play-glyph", "aria-hidden": "true" }, [ui.icon("play", { size: cover ? 13 : 18 })]),
  ]);
}

function syncAudioControls() {
  for (const host of [nodes.tbody, nodes.grid]) {
    for (const button of host.querySelectorAll("button[data-play-id]")) {
      const current = Number(button.dataset.playId) === audioState.id;
      const active = current && ["playing", "loading"].includes(audioState.status);
      const action = active ? "暂停" : current && audioState.status === "error" ? "重试播放" : "播放";
      button.setAttribute("aria-pressed", String(active));
      button.setAttribute("aria-label", `${action} ${button.dataset.trackTitle}`);
      button.title = `${action} ${button.dataset.trackTitle}`;
      button.dataset.audioState = current ? audioState.status : "stopped";
      const glyph = active ? "pause" : "play";
      if (button.dataset.glyph !== glyph) {
        button.dataset.glyph = glyph;
        button.querySelector(".track-play-glyph").replaceChildren(ui.icon(glyph, { size: button.classList.contains("track-listen-cover") ? 13 : 18 }));
      }
      button.closest("tr[data-id], .track-card[data-id]").dataset.audioState = current ? audioState.status : "stopped";
    }
  }
}

function inspectTrack(id, trigger) {
  const row = state.tracks.items.find((item) => String(item.id) === String(id));
  if (!row) return;
  openTrackDetails(row, {
    rows: [...state.tracks.items], trigger,
    onEdit: (track) => openEdit([track]),
    onScrape: (track) => { setCurrentTrack(track); location.hash = "#scrape"; },
  });
}

/** 只在用户切换视图时轻淡入，不让后台轮询重播动画。 */
function animateViewChange() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const host = state.tracks.view === "cards" ? nodes.grid : nodes.tableWrap;
  host.getAnimations().forEach((animation) => animation.cancel());
  host.animate([{ opacity: .35, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], {
    duration: 180, easing: "cubic-bezier(.2,.7,.2,1)",
  });
}

function syncViewControls() {
  nodes.libraryCard.dataset.libraryView = state.tracks.view;
  nodes.libraryCard.dataset.libraryDensity = state.tracks.density;
  for (const view of ["list", "cards"]) ui.byId(`view-${view}`).setAttribute("aria-pressed", String(state.tracks.view === view));
  for (const density of ["comfortable", "compact"]) ui.byId(`density-${density}`).setAttribute("aria-pressed", String(state.tracks.density === density));
  nodes.densityControls.hidden = state.tracks.view !== "list";
  nodes.displayDensity.hidden = state.tracks.view !== "list";
  const sortLabel = nodes.sort.selectedOptions[0]?.textContent || "歌手";
  nodes.displaySummary.textContent = `${sortLabel} · ${state.tracks.order === "desc" ? "降序" : "升序"} · ${state.tracks.page_size} 首`;
  nodes.displaySummary.title = nodes.displaySummary.textContent;
  savedFilters?.sync();
}

function showCollection(visible) {
  const cards = state.tracks.view === "cards";
  nodes.tableWrap.hidden = !visible || cards;
  nodes.grid.hidden = !visible || !cards;
  nodes.gridControls.hidden = !visible || !cards || !state.tracks.items.length;
}

function applyFilter(key, value) {
  state.tracks.filters[key] = value;
  syncFilterShortcuts();
  state.tracks.page = 1;
  refresh();
}

function resetFilters() {
  cancelPendingSearch();
  FILTER_KEYS.forEach((key) => {
    state.tracks.filters[key] = typeof state.tracks.filters[key] === "boolean" ? false : "";
  });
  state.tracks.filters.folder_recursive = true;
  state.tracks.q = "";
  state.tracks.page = 1;
  syncControls();
}

/** A folder is an exact server-returned scope; keep the current search and tags. */
export function setFolderScope({ folder, recursive = true } = {}) {
  if (typeof folder !== "string" || !folder || folder.includes("\0")) return false;
  cancelPendingSearch();
  state.tracks.filters.folder = folder;
  state.tracks.filters.folder_recursive = recursive !== false;
  state.tracks.page = 1;
  syncControls();
  return true;
}

/** Prepare the existing scan form. The user still chooses options and starts it. */
export function prepareFolderScan(folder) {
  if (typeof folder !== "string" || !folder || folder.includes("\0")) return false;
  const previous = nodes.scanRoot.value;
  nodes.scanRoot.value = folder;
  if (nodes.scanRoot.value !== folder) {
    nodes.scanRoot.value = previous;
    ui.toast("warn", "无法预填扫描目录", "目录名称包含扫描输入框无法保留的字符，请从上一级目录准备扫描。");
    return false;
  }
  const options = nodes.scanRoot.closest("details");
  if (options) options.open = true;
  nodes.scanRoot.scrollIntoView({ block: "center", behavior: "instant" });
  nodes.scanRoot.focus({ preventScroll: true });
  return true;
}

/** Prepare an exact album scope before app.js navigates and loads the track page. */
export function setAlbumScope(group) {
  const encoded = normalizeAlbumGroup(JSON.stringify([group?.album, group?.album_artist]));
  if (!encoded) return false;
  resetFilters();
  state.tracks.filters.album_group = encoded;
  state.tracks.sort = "disc_track";
  state.tracks.order = "asc";
  syncControls();
  return true;
}

export function setAllTracksScope({ no_album = false } = {}) {
  resetFilters();
  state.tracks.filters.no_album = Boolean(no_album);
  syncControls();
}

function syncControls() {
  nodes.q.value = state.tracks.q;
  nodes.sort.value = state.tracks.sort;
  nodes.order.value = state.tracks.order;
  nodes.pageSize.value = String(state.tracks.page_size);
  nodes.fArtist.value = state.tracks.filters.artist;
  nodes.fAlbum.value = state.tracks.filters.album;
  nodes.fLanguage.value = state.tracks.filters.language;
  nodes.fAlbumtype.value = state.tracks.filters.albumtype;
  nodes.fGenre.value = state.tracks.filters.genre;
  nodes.fYear.value = state.tracks.filters.year;
  nodes.fCover.checked = state.tracks.filters.missing_cover;
  nodes.fLyrics.checked = state.tracks.filters.missing_lyrics;
  nodes.fNoArtist.checked = state.tracks.filters.no_artist;
  nodes.fNoAlbum.checked = state.tracks.filters.no_album;
  nodes.fNotLoaded.checked = state.tracks.filters.not_loaded;
  syncViewControls();
  syncFilterShortcuts();
}

/** 快捷筛选与完整筛选共用同一份状态，切换入口后保持选中态一致。 */
function syncFilterShortcuts() {
  const filters = state.tracks.filters;
  nodes.quickFilters?.querySelectorAll("button[data-quick-filter]").forEach((button) => {
    const key = button.dataset.quickFilter;
    const active = key === "all"
      ? !state.tracks.q && !FILTER_KEYS.some((filter) => Boolean(filters[filter]))
      : Boolean(filters[key]);
    button.setAttribute("aria-pressed", String(active));
  });
  nodes.health?.querySelectorAll("button[data-health-filter]").forEach((button) => {
    button.setAttribute("aria-pressed", String(Boolean(filters[button.dataset.healthFilter])));
  });
  nodes.recentIndexed.setAttribute("aria-pressed", String(state.tracks.sort === "indexed" && state.tracks.order === "desc"));
  savedFilters?.sync();
}

/* ------------------------------------------------- 筛选 chips / 偏好 / 键盘 */

/** 筛选键 → 中文名（chips 上显示）。 */
const FILTER_LABELS = {
  folder: "目录",
  album_group: "专辑分组",
  artist: "艺术家",
  album: "专辑",
  language: "语言",
  albumtype: "专辑类型",
  genre: "流派",
  year: "年份",
  missing_cover: "缺封面",
  missing_lyrics: "缺歌词",
  no_artist: "无歌手",
  no_album: "无专辑",
  not_loaded: "待读标签",
};

const PREFS_KEY = "metatidy.tracks.prefs";

/** 把已启用的筛选条件画成可单个移除的 chips。 */
function renderFilterChips() {
  const box = ui.byId("filter-chips");
  if (!box) return;
  const active = FILTER_KEYS.filter((key) => {
    const value = state.tracks.filters[key];
    return typeof value === "boolean" ? value : Boolean(String(value || "").trim());
  });
  ui.clear(box);
  box.hidden = active.length === 0;
  active.forEach((key) => {
    const value = state.tracks.filters[key];
    const text =
      typeof value === "boolean"
        ? FILTER_LABELS[key] || key
        : key === "folder" ? `目录：${value}${state.tracks.filters.folder_recursive ? "（含子目录）" : "（仅本层）"}`
        : `${FILTER_LABELS[key] || key}：${key === "album_group" ? albumGroupLabel(value) : value}`;
    const x = ui.el("button", { class: "x", type: "button", title: "移除这个条件", "aria-label": `移除筛选：${text}`, text: "×" });
    x.addEventListener("click", () => {
      state.tracks.filters[key] = typeof value === "boolean" ? false : "";
      if (key === "folder") state.tracks.filters.folder_recursive = true;
      syncControls();
      state.tracks.page = 1;
      refresh();
    });
    box.append(ui.el("span", { class: "filter-chip", dataset: { filterKey: key } }, [ui.el("b", { text }), x]));
  });
}

/** 记住筛选 / 排序 / 每页，刷新后不丢。 */
function savePrefs() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        q: state.tracks.q,
        sort: state.tracks.sort,
        order: state.tracks.order,
        page_size: state.tracks.page_size,
        view: state.tracks.view,
        density: state.tracks.density,
        filters: state.tracks.filters,
      }),
    );
  } catch {
    /* 隐私模式等场景写不了，忽略 */
  }
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (typeof saved.q === "string") state.tracks.q = saved.q.slice(0, 1000);
      if (SORT_KEYS.includes(saved.sort)) state.tracks.sort = saved.sort;
      if (saved.order === "asc" || saved.order === "desc") state.tracks.order = saved.order;
      if ([50, 100, 200].includes(Number(saved.page_size))) state.tracks.page_size = Number(saved.page_size);
      if (saved.view === "list" || saved.view === "cards") state.tracks.view = saved.view;
      if (saved.density === "comfortable" || saved.density === "compact") state.tracks.density = saved.density;
      FILTER_KEYS.forEach((key) => {
        const value = saved.filters ? saved.filters[key] : undefined;
        if (key === "folder") { state.tracks.filters.folder = typeof value === "string" && !value.includes("\0") ? value : ""; return; }
        if (key === "album_group") { state.tracks.filters[key] = normalizeAlbumGroup(value); return; }
        if (typeof value === typeof state.tracks.filters[key]) state.tracks.filters[key] = typeof value === "string" ? value.slice(0, 1000) : value;
      });
      state.tracks.filters.folder_recursive = saved.filters?.folder_recursive !== false;
    }
  } catch {
    /* 存坏了就当没有 */
  }
  syncControls();
}

/** 键盘导航：`/` 聚焦搜索、`↑↓` 选行、`Enter` 打开编辑、空格勾选、`Esc` 取消。 */
function wireTableKeys() {
  let activeRow = null;
  const rows = () => [...(state.tracks.view === "cards" ? nodes.grid.querySelectorAll(".track-card[data-id]") : nodes.tbody.querySelectorAll("tr[data-id]"))];

  function setActive(row) {
    rows().forEach((r) => r.classList.remove("is-active"));
    activeRow = row || null;
    if (activeRow) {
      activeRow.classList.add("is-active");
      activeRow.scrollIntoView({ block: "nearest" });
      if (state.tracks.view === "cards") activeRow.focus({ preventScroll: true });
    }
  }

  function move(delta) {
    const list = rows();
    if (!list.length) return;
    const index = list.indexOf(activeRow);
    const next =
      index === -1
        ? delta > 0
          ? 0
          : list.length - 1
        : Math.min(list.length - 1, Math.max(0, index + delta));
    setActive(list[next]);
  }

  document.addEventListener("keydown", (event) => {
    // 隐藏的曲库与浮层不抢别的工作区的键盘操作。
    if (state.tab !== "tracks" || state.edit.open || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || hasOverlayAboveEditor()) return;
    if (activeRow && (!activeRow.isConnected || !rows().includes(activeRow))) activeRow = null;
    const target = event.target;
    if (target?.closest?.("#jobs-pop, #audio-player")) return;
    const focusedCard = target?.closest?.(".track-card[data-id]");
    if (focusedCard && target === focusedCard) activeRow = focusedCard;
    const tag = (target && target.tagName) || "";
    const typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || Boolean(target && target.isContentEditable);
    // 按钮、链接和原生展开控件保留自己的键盘行为。
    const interactive = typing || tag === "BUTTON" || tag === "A" || tag === "SUMMARY";

    if (event.key === "/" && !typing) {
      event.preventDefault();
      nodes.q.focus();
      nodes.q.select();
      return;
    }
    if (event.key === "Escape" && activeRow) {
      setActive(null);
      return;
    }
    if (interactive) return;
    const cards = state.tracks.view === "cards";
    const columns = cards ? Math.max(1, getComputedStyle(nodes.grid).gridTemplateColumns.split(" ").length) : 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(columns);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-columns);
    } else if (cards && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      move(event.key === "ArrowRight" ? 1 : -1);
    } else if (event.key === " " && activeRow) {
      event.preventDefault();
      activeRow.querySelector('input[type="checkbox"]')?.click();
    } else if (event.key === "Enter" && activeRow) {
      event.preventDefault();
      const btn = activeRow.querySelector("button[data-edit-id]");
      btn?.click();
    } else if (event.key.toLowerCase() === "i" && activeRow) {
      event.preventDefault();
      inspectTrack(activeRow.dataset.id, activeRow.querySelector("button[data-detail-id]"));
    }
  });
}

/* --------------------------------------------------------------- 数据 */

export async function refresh({ background = false, canApply = () => true } = {}) {
  const sequence = ++refreshSequence;
  state.tracks.loading = true;
  if (!background) {
    state.tracks.error = "";
    syncViewControls();
    syncFilterShortcuts();
    renderFilterChips();
    renderTableStatus();
    // 首屏才需要骨架；已有内容等回包后再替换，避免重播封面和行入场。
    if (!state.tracks.items.length) renderCollection();
  }
  const params = {
    q: state.tracks.q,
    page: state.tracks.page,
    page_size: state.tracks.page_size,
    sort: state.tracks.sort,
    order: state.tracks.order,
    ...state.tracks.filters,
  };
  try {
    const data = await api.tracks(params);
    if (sequence !== refreshSequence) return;
    if (background && !canApply()) return false;
    state.tracks.error = "";
    state.tracks.items = data.items || [];
    const current = state.tracks.items.find((row) => Number(row.id) === state.currentTrackId);
    if (current) updateTrackSnapshot(current, { partial: true });
    state.tracks.total = data.total || 0;
    state.tracks.page = data.page || 1;
    state.tracks.pages = data.pages || 1;
    state.tracks.loadedAt = Date.now();
  } catch (err) {
    if (sequence !== refreshSequence) return;
    if (background) return false;
    state.tracks.error = err.message;
    state.tracks.items = [];
    state.tracks.total = 0;
    state.tracks.pages = 1;
    ui.toast("err", "读取曲目失败", err.message);
  } finally {
    if (sequence === refreshSequence) state.tracks.loading = false;
  }
  if (sequence !== refreshSequence) return;
  renderTableStatus();
  renderCollection({ animate: !background });
  renderPager();
  renderSelectionBar();
  renderFilterChips();
  savePrefs();
  return true;
}

/** 库统计条 + 语言/类型下拉选项（依赖 /api/status）。 */
export function onStatus(status) {
  const stats = status.stats || {};

  const cards = [
    { key: "tracks", label: "曲目总数", value: ui.fmtNum(stats.tracks || 0), ico: "music", note: "每一首，都值得珍藏" },
    { key: "artists", label: "艺术家", value: ui.fmtNum(stats.artists || 0), ico: "artist", note: "收藏不同的声音" },
    { key: "albums", label: "专辑", value: ui.fmtNum(stats.albums || 0), ico: "album", note: "让音乐成辑归档" },
    { key: "bytes", label: "曲库体积", value: ui.fmtBytes(stats.bytes || 0), ico: "disk", note: "已索引的音频文件" },
  ];

  ui.clear(nodes.strip);
  cards.forEach((card) => {
    nodes.strip.append(ui.el("div", { class: `stat stat-${card.key}` }, [
      ui.el("span", { class: "stat-icon", "aria-hidden": "true" }, [ui.icon(card.ico, { size: 20 })]),
      ui.el("span", { class: "k", text: card.label }),
      ui.el("span", { class: "v", text: card.value }),
      ui.el("span", { class: "stat-note", text: card.note }),
    ]));
  });
  renderLibraryHealth(stats);

  const languages = stats.languages || [];
  const albumtypes = stats.albumtypes || [];
  fillSelect(nodes.fLanguage, languages, state.tracks.filters.language);
  fillSelect(nodes.fAlbumtype, albumtypes, state.tracks.filters.albumtype);
  fillDatalist(nodes.dlLanguages, languages);
  fillDatalist(nodes.dlAlbumtypes, albumtypes);
  renderTableStatus();
  syncFilterShortcuts();
}

function renderLibraryHealth(stats) {
  if (!nodes.health) return;
  const total = Number(stats.tracks) || 0;
  // 缺失字段可能重叠，因此只计算独立的封面覆盖率，不推算“完整曲目”数量。
  const covered = Math.max(0, total - (Number(stats.missing_cover) || 0));
  const coverage = total ? Math.max(0, Math.min(100, Math.round(covered / total * 100))) : 0;
  ui.clear(nodes.health);
  nodes.health.append(
    ui.el("div", { class: "health-summary" }, [
      ui.el("span", { class: "health-icon", "aria-hidden": "true" }, [ui.icon("cover", { size: 18 })]),
      ui.el("div", {}, [
        ui.el("strong", { text: "收藏完整度" }),
        ui.el("span", { class: "hint", text: total ? `封面覆盖率 ${coverage}%` : "扫描后查看曲库信息" }),
      ]),
      ui.el("div", {
        class: "health-meter",
        role: "meter",
        "aria-label": "已索引曲目的封面覆盖率",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": String(coverage),
        "aria-valuetext": total ? `${coverage}%` : "暂无曲目",
      }, [ui.el("span", { style: { width: `${coverage}%` } })]),
    ]),
    ui.el("div", { class: "health-filters" }, [
      ["missing_cover", "待补封面", "cover"],
      ["missing_lyrics", "待补歌词", "lyrics"],
      ["no_artist", "缺少艺术家", "artist"],
      ["no_album", "缺少专辑", "album"],
    ].map(([key, label, ico]) => ui.el("button", {
      type: "button",
      class: "health-filter",
      dataset: { healthFilter: key },
      "aria-pressed": String(Boolean(state.tracks.filters[key])),
      title: `筛选${label}的曲目`,
      onClick: () => {
        state.tracks.filters[key] = !state.tracks.filters[key];
        state.tracks.page = 1;
        syncControls();
        refresh();
      },
    }, [ui.icon(ico, { size: 14 }), ui.el("span", { text: label }), ui.el("b", { class: "badge", text: ui.fmtNum(stats[key] || 0) })]))),
  );
}

function fillSelect(select, values, current) {
  const previous = current || "";
  ui.clear(select);
  select.append(ui.el("option", { value: "", text: "全部" }));
  values.forEach((value) => select.append(ui.el("option", { value, text: value })));
  // 统计与列表并行刷新时，旧筛选可能暂时不在统计里；保留它，避免控件与结果不一致。
  if (previous && !values.includes(previous)) select.append(ui.el("option", { value: previous, text: previous }));
  select.value = previous;
}

function fillDatalist(list, values) {
  ui.clear(list);
  values.forEach((value) => list.append(ui.el("option", { value })));
}

/* --------------------------------------------------------------- 渲染 */

function renderTableStatus() {
  ui.clear(nodes.tableStatus);
  nodes.tableWrap.setAttribute("aria-busy", String(state.tracks.loading));
  nodes.grid.setAttribute("aria-busy", String(state.tracks.loading));
  nodes.reload.disabled = state.tracks.loading;
  if (state.tracks.loading && !state.tracks.items.length) {
    nodes.tableStatus.append(ui.loadingLine("正在读取索引…"));
    showCollection(true);
    return;
  }
  if (state.tracks.error) {
    nodes.tableStatus.append(ui.emptyState("warn", "暂时无法读取曲库", state.tracks.error, [
      ui.el("button", { type: "button", class: "btn", text: "重新加载", onClick: () => refresh() }),
    ]));
    showCollection(false);
    return;
  }
  const stats = (state.status && state.status.stats) || {};
  if ((stats.tracks || 0) === 0) {
    nodes.tableStatus.append(
      ui.emptyState("album", "你的音乐收藏，从这里开始", "扫描音乐目录，把散落的歌曲收进曲库。扫描只建立索引，不修改音频文件。", [
        ui.el("button", {
          type: "button",
          class: "btn btn-primary",
          text: "开始扫描曲库",
          onClick: () => nodes.scanBtn.click(),
        }),
      ]),
    );
    showCollection(false);
    return;
  }
  if (!state.tracks.total) {
    nodes.tableStatus.append(
      ui.emptyState("search", "还没有找到这首歌", "试试其他关键词，或清除筛选，重新看看整个音乐收藏。", [
        ui.el("button", {
          type: "button",
          class: "btn",
          text: "清空筛选",
          onClick: () => {
            resetFilters();
            refresh();
          },
        }),
      ]),
    );
    showCollection(false);
    return;
  }
  showCollection(true);
}

function renderCollection({ animate = true } = {}) {
  const focused = document.activeElement;
  const oldRow = focused?.closest("tr[data-id], .track-card[data-id]");
  const action = focused?.matches('input[type="checkbox"]') ? 'input[type="checkbox"]'
    : focused?.matches("button[data-play-id]") ? "button[data-play-id]"
      : focused?.matches("button[data-edit-id]") ? "button[data-edit-id]"
      : focused?.matches("button[data-scrape-id]") ? "button[data-scrape-id]"
        : focused?.matches("button[data-detail-id]") ? "button[data-detail-id]" : null;
  if (state.tracks.view === "cards") {
    ui.clear(nodes.tbody);
    renderCards({ animate });
  } else {
    ui.clear(nodes.grid);
    renderTable({ animate });
  }
  syncPageCheckbox();
  syncAudioControls();
  ui.setText(nodes.total, `共 ${ui.fmtNum(state.tracks.total)} 首`);
  if (state.tracks.loadedAt) ui.setText(nodes.updated, `列表更新于 ${ui.fmtTime(state.tracks.loadedAt / 1000)}`);
  // 后台更新后仍能继续 Tab/空格操作当前曲目，不让焦点掉回页面顶部。
  if (!animate && oldRow) {
    const host = state.tracks.view === "cards" ? nodes.grid : nodes.tbody;
    const replacement = [...host.querySelectorAll("[data-id]")].find((row) => row.dataset.id === oldRow.dataset.id);
    if (action) replacement?.querySelector(action)?.focus({ preventScroll: true });
    else if (focused === oldRow && state.tracks.view === "cards") replacement?.focus({ preventScroll: true });
  }
}

function cardArtwork(row, reveal = true) {
  let tone = 0;
  for (const char of String(row.album || row.artist || row.title || row.id)) tone = (tone * 31 + char.codePointAt(0)) % 6;
  const art = ui.el("div", { class: "track-card-art", dataset: { tone } });
  const fallback = (failed = false) => {
    art.classList.add("is-placeholder");
    art.title = failed ? "封面暂时无法读取" : "暂无内嵌封面";
    art.append(ui.icon("music", { size: 38 }), ui.el("span", { text: failed ? "封面暂不可用" : "等待一张封面" }));
  };
  if (row.has_cover) {
    const img = ui.el("img", { src: coverUrl(row.id, 256), width: 256, height: 256, alt: "", loading: "lazy", decoding: "async" });
    img.addEventListener("error", () => { img.remove(); fallback(true); }, { once: true });
    art.append(img);
    if (reveal) ui.enhanceArtwork?.(art, img);
  } else fallback();
  return art;
}

function renderCards({ animate = true } = {}) {
  ui.clear(nodes.grid);
  if (state.tracks.loading && !state.tracks.items.length) {
    for (let index = 0; index < 8; index += 1) nodes.grid.append(ui.el("li", { class: "track-card card-skeleton", "aria-hidden": "true" }, [
      ui.el("div", { class: "track-card-art" }), ui.el("div", { class: "card-skeleton-line" }), ui.el("div", { class: "card-skeleton-line short" }),
    ]));
    showCollection(true);
    return;
  }
  const fragment = document.createDocumentFragment();
  state.tracks.items.forEach((row, index) => {
    const title = row.title || row.filename || "（无标题）";
    const format = String(row.ext || (row.filename || "").match(/\.([^./\\]+)$/)?.[1] || "").replace(/^\./, "").toUpperCase();
    const card = ui.el("li", {
      class: `track-card${animate && index < 8 ? " card-enter" : ""}`,
      dataset: { id: row.id, selected: String(isSelected(row.id)) }, tabindex: "-1", "aria-labelledby": `card-title-${row.id}`,
      style: animate && index < 8 ? { animationDelay: `${index * 18}ms` } : null,
    });
    const checkbox = ui.el("input", { type: "checkbox", checked: isSelected(row.id), "aria-label": `选择曲目 ${title}` });
    checkbox.addEventListener("change", () => toggleSelect(row, checkbox.checked));
    const art = ui.el("button", {
      type: "button", class: "track-art-button", dataset: { detailId: String(row.id) },
      "aria-label": `查看 ${title} 的详细资料`, title: "查看曲目资料",
    }, [cardArtwork(row, animate), ui.el("span", { class: "art-detail-hint", "aria-hidden": "true" }, [ui.icon("info", { size: 14 }), "查看资料"])]);
    card.append(
      ui.el("div", { class: "track-card-top" }, [
        art,
        ui.el("label", { class: "track-card-select", title: `选择 ${title}` }, [checkbox]),
        playButton(row),
        !row.has_lyrics ? ui.el("span", { class: "card-missing-lyrics", text: "待补歌词" }) : null,
      ]),
      ui.el("div", { class: "track-card-body" }, [
        ui.el("h3", { id: `card-title-${row.id}`, class: "track-card-title" }, [ui.el("button", {
          type: "button", class: "track-title-button truncate", dataset: { detailId: String(row.id) },
          title: row.path || title, "aria-label": `查看 ${title} 的详细资料`, text: title,
        })]),
        ui.el("p", { class: "track-card-artist truncate", title: row.artist || "未知艺术家", text: row.artist || "未知艺术家" }),
        ui.el("p", { class: "track-card-album truncate", title: row.album || "尚未填写专辑", text: row.album || "尚未填写专辑" }),
        ui.el("div", { class: "track-card-meta" }, [
          format ? ui.el("span", { class: "format-tag", text: format }) : null,
          ui.el("span", { text: [ui.fmtDuration(row.duration), row.year].filter(Boolean).join(" · ") || "待完善资料" }),
        ]),
        ui.el("div", { class: "track-card-actions" }, [
          ui.el("button", { type: "button", class: "btn btn-sm card-edit", dataset: { editId: String(row.id) }, "aria-label": `编辑 ${title} 的元数据` }, [ui.icon("edit", { size: 13 }), "编辑"]),
          ui.el("button", { type: "button", class: "btn btn-sm btn-ghost card-scrape", dataset: { scrapeId: String(row.id) }, "aria-label": `为 ${title} 查找元数据` }, [ui.icon("search", { size: 13 }), "刮削"]),
        ]),
      ]),
    );
    fragment.append(card);
  });
  nodes.grid.append(fragment);
}

function renderTable({ animate = true } = {}) {
  ui.clear(nodes.tbody);
  const rows = state.tracks.items;
  const fragment = document.createDocumentFragment();

  // 首屏加载：先铺骨架行，别让表格空白或高度跳动
  if (state.tracks.loading && !rows.length) {
    ui.skeletonRows(8).forEach((tr) => fragment.append(tr));
    nodes.tbody.append(fragment);
    showCollection(true); // 骨架行得看得见（空结果时容器本来是收起的）
    return;
  }

  rows.forEach((row, index) => {
    const tr = ui.el("tr", { dataset: { id: row.id } });
    const format = String(row.ext || (row.filename || "").match(/\.([^./\\]+)$/)?.[1] || "").replace(/^\./, "").toUpperCase();
    const duration = ui.fmtDuration(row.duration);
    const mobileMeta = [row.artist || "未知艺术家", row.album].filter(Boolean).join(" · ");
    if (isSelected(row.id)) tr.setAttribute("aria-selected", "true");
    if (animate && index < 12) {
      tr.classList.add("enter");
      tr.style.animationDelay = `${index * 12}ms`;
    }

    const checkbox = ui.el("input", {
      type: "checkbox",
      checked: isSelected(row.id),
      "aria-label": `选择曲目 ${row.title || row.filename || row.id}`,
    });
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      toggleSelect(row, checkbox.checked);
      tr.setAttribute("aria-selected", checkbox.checked ? "true" : "false");
      syncPageCheckbox();
      renderSelectionBar();
    });

    tr.append(
      ui.el("td", { class: "col-check" }, [checkbox]),
      ui.el("td", {}, [playButton(row, { cover: true, reveal: animate })]),
      ui.el("td", {}, [
        ui.el("button", {
          type: "button", class: "truncate cell-title track-title-button", dataset: { detailId: String(row.id) },
          "aria-label": `查看 ${row.title || row.filename || row.id} 的详细资料`,
          title: row.path || row.filename || "",
          text: row.title || "（无标题）",
        }),
        ui.el("span", { class: "truncate cell-mobile-meta", title: mobileMeta, text: mobileMeta }),
        ui.el("span", { class: "cell-meta" }, [
          format ? ui.el("span", { class: "format-tag", text: format }) : null,
          duration ? ui.el("span", { class: "track-duration", text: duration }) : null,
          !format && !duration ? ui.el("span", { class: "truncate", text: row.filename || "待完善元数据" }) : null,
        ]),
      ]),
      ui.el("td", {}, [
        ui.el("span", { class: "truncate", title: row.artist || "无歌手", text: row.artist || "—" }),
      ]),
      ui.el("td", {}, [ui.el("span", { class: "truncate", title: row.album || "无专辑", text: row.album || "—" })]),
      ui.el("td", { class: "num", text: row.year || "—" }),
      ui.el("td", { class: "num col-track", text: row.track || "—" }),
      ui.el("td", { class: "col-language" }, [ui.el("span", { class: "truncate", text: row.language || "—" })]),
      ui.el("td", { class: "col-albumtype" }, [ui.el("span", { class: "truncate", text: row.albumtype || "—" })]),
      ui.el("td", { class: "col-filename" }, [
        ui.el("span", {
          class: "truncate path-cell",
          title: row.path || row.filename || "",
          text: row.filename || "",
        }),
      ]),
      ui.el("td", {}, [
        ui.el("button", {
          type: "button",
          class: "btn btn-sm row-edit",
          dataset: { editId: String(row.id) },
          "aria-label": `编辑 ${row.title || row.filename || row.id} 的元数据`,
        }, [ui.icon("edit", { size: 14 }), ui.el("span", { class: "row-edit-label", text: "编辑" })]),
      ]),
    );
    fragment.append(tr);
  });

  nodes.tbody.append(fragment);
  syncPageCheckbox();

  ui.setText(nodes.total, `共 ${ui.fmtNum(state.tracks.total)} 首`);
  document.querySelectorAll("th[data-sort-col]").forEach((th) => {
    const key = th.dataset.sortCol;
    const button = th.querySelector(".th-sort");
    const mark = button.querySelector(".sort-mark");
    if (mark) mark.remove();
    if (state.tracks.sort === key) {
      th.setAttribute("aria-sort", state.tracks.order === "asc" ? "ascending" : "descending");
      button.append(ui.el("span", { class: "sort-mark", text: state.tracks.order === "asc" ? "▲" : "▼" }));
    } else {
      th.removeAttribute("aria-sort");
    }
  });

  if (state.tracks.loadedAt) {
    ui.setText(nodes.updated, `列表更新于 ${ui.fmtTime(state.tracks.loadedAt / 1000)}`);
  }
}

function syncPageCheckbox() {
  const rows = state.tracks.items;
  const selected = rows.filter((row) => isSelected(row.id)).length;
  for (const checkbox of [nodes.checkPage, nodes.checkGridPage]) {
    checkbox.checked = rows.length > 0 && selected === rows.length;
    checkbox.indeterminate = selected > 0 && selected < rows.length;
    checkbox.disabled = rows.length === 0;
  }
}

function renderSelectionBar() {
  const wasHidden = nodes.selectionBar.hidden;
  const count = selectionCount();
  nodes.editSelected.disabled = count === 0;
  if (!selectionControls) {
    const screen = window.matchMedia("(max-width: 700px), (max-width: 1000px) and (max-height: 500px)");
    const total = ui.el("strong"), note = ui.el("span"), chips = ui.el("div", { class: "selection-tracks" });
    const review = ui.el("button", { type: "button", id: "selection-review", class: "btn btn-sm", text: "审阅已选", onClick: () => emit("library:review-selection") });
    const extra = ui.el("div", { id: "selection-more-actions", class: "selection-more-actions" }, [
      ui.el("button", { type: "button", id: "selection-edit", class: "btn btn-sm btn-primary", text: "编辑已选", onClick: () => openEdit(selectionRows()) }),
      ui.el("button", { type: "button", id: "selection-scrape", class: "btn btn-sm", text: "批量刮削", onClick: () => emit("library:batch-scrape") }),
      ui.el("button", { type: "button", id: "selection-clear", class: "btn btn-sm btn-ghost", text: "清空选择", onClick: () => {
        clearSelection();
        const pageCheck = state.tracks.view === "cards" ? nodes.checkGridPage : nodes.checkPage;
        (pageCheck.disabled || !pageCheck.getClientRects().length ? nodes.q : pageCheck).focus({ preventScroll: true });
      } }),
    ]);
    const more = ui.el("button", { type: "button", id: "selection-more-toggle", class: "btn btn-sm btn-ghost", text: "更多", "aria-controls": "selection-more-actions", "aria-expanded": "false", onClick: () => setMore(!selectionControls.expanded) });
    function setMore(open, restore = true) {
      selectionControls.expanded = Boolean(open);
      const hide = screen.matches && !open;
      if (screen.matches) more.hidden = false;
      if (hide && restore && extra.contains(document.activeElement)) more.focus({ preventScroll: true });
      if (!screen.matches && document.activeElement === more) review.focus({ preventScroll: true });
      more.hidden = !screen.matches; more.setAttribute("aria-expanded", String(screen.matches && open));
      more.textContent = open ? "收起" : "更多"; extra.hidden = hide;
      nodes.selectionBar.dataset.expanded = String(screen.matches && open);
      selectionControls.measure?.();
    }
    nodes.selectionBar.append(ui.el("div", { class: "selection-summary", role: "status", "aria-live": "polite" }, [total, note]), chips, ui.el("div", { class: "spacer" }), review, more, extra);
    selectionControls = { total, note, chips, more, extra, expanded: false, setMore };
    screen.addEventListener("change", () => setMore(false));
    nodes.selectionBar.addEventListener("keydown", event => {
      if (event.defaultPrevented || event.key !== "Escape" || !screen.matches || !selectionControls.expanded || document.querySelector("dialog[open]")) return;
      event.preventDefault(); event.stopPropagation(); setMore(false); more.focus({ preventScroll: true });
    });
    const measure = () => {
      const height = nodes.selectionBar.getBoundingClientRect().height;
      document.documentElement.style.setProperty("--selection-bar-height", `${Math.ceil(height)}px`);
    };
    selectionControls.measure = measure;
    new ResizeObserver(measure).observe(nodes.selectionBar);
    nodes.selectionBar.addEventListener("animationend", () => nodes.selectionBar.classList.remove("selection-enter"));
    setMore(false);
  }
  if (!count) {
    nodes.selectionBar.hidden = true;
    nodes.selectionBar.classList.remove("selection-enter");
    selectionControls.setMore(false, false);
    selectionControls.total.textContent = selectionControls.note.textContent = "";
    selectionControls.chips.replaceChildren();
    document.documentElement.style.setProperty("--selection-bar-height", "0px");
    return;
  }
  nodes.selectionBar.hidden = false;
  if (wasHidden) nodes.selectionBar.classList.add("selection-enter");
  const rows = selectionRows().slice(0, 2);
  const onPage = state.tracks.items.filter((row) => isSelected(row.id)).length;
  selectionControls.total.textContent = `已选 ${count} 首`;
  selectionControls.note.textContent = count > onPage ? `当前页 ${onPage} 首 · 其他页 ${count - onPage} 首` : "跨页保留选择";
  selectionControls.chips.replaceChildren(
    ...rows.map((row) =>
      ui.el("span", { class: "chip selection-track", title: row.path || row.filename }, [
        ui.el("span", { class: "truncate", style: { maxWidth: "120px" }, text: row.title || row.filename || String(row.id) }),
      ]),
    ),
  );
  selectionControls.measure();
}

function renderPager() {
  ui.clear(nodes.pager);
  const { page, pages, total, page_size: pageSize } = state.tracks;
  const jump = ui.el("input", {
    type: "number",
    class: "jump",
    min: "1",
    max: String(Math.max(1, pages)),
    value: String(page),
    "aria-label": "跳转到页码",
  });
  const go = () => {
    const value = Math.max(1, Math.min(pages || 1, Number(jump.value) || 1));
    jump.value = String(value);
    state.tracks.page = value;
    refresh();
  };
  jump.addEventListener("change", go);
  jump.addEventListener("keydown", (event) => {
    if (event.key === "Enter") go();
  });

  nodes.pager.append(
    ui.el("button", {
      type: "button",
      class: "btn btn-sm",
      text: "上一页",
      disabled: page <= 1,
      onClick: () => {
        state.tracks.page = Math.max(1, page - 1);
        refresh();
      },
    }),
    ui.el("button", {
      type: "button",
      class: "btn btn-sm",
      text: "下一页",
      disabled: page >= pages,
      onClick: () => {
        state.tracks.page = Math.min(pages || 1, page + 1);
        refresh();
      },
    }),
    ui.el("span", { class: "pageno", text: `第 ${page} / ${pages || 1} 页` }),
    ui.el("span", { class: "hint", text: `每页 ${pageSize} 首 · 共 ${ui.fmtNum(total)} 首` }),
    ui.el("div", { class: "spacer" }),
    ui.el("label", { class: "row-inline" }, [ui.el("span", { class: "lbl", text: "跳到" }), jump]),
  );
}

/* --------------------------------------------------------------- 扫描 */

async function startScan() {
  const fast = nodes.scanFast.checked;
  const full = nodes.scanFull.checked;
  const prune = nodes.scanPrune.checked;
  // 留空 = 整个库；填子目录（相对音乐目录）就只走这一支，新增专辑时不用全库重走
  const root = (nodes.scanRoot.value || "").trim();
  nodes.scanBtn.disabled = true;
  nodes.scanBtn.setAttribute("aria-busy", "true");
  nodes.scanBtn.textContent = "扫描中…";
  const progress = ui.createProgress(nodes.scanProgress, {
    label: `${fast ? "快速扫描（只建索引）" : full ? "全量扫描" : "扫描"}${root ? ` · 只扫 ${root}` : ""}`,
  });
  try {
    const { job_id: jobId } = await api.scan({ full, prune, fast, root });
    const job = await pollJob(jobId, { onTick: (tick) => progress.update(tick) });
    progress.finish(job);
    if (job.state === "error") {
      ui.toast("err", "扫描失败", job.error || "后端任务出错");
    } else {
      let summary = "";
      try {
        const result = JSON.parse(job.result || "{}");
        summary = `扫描 ${result.scanned ?? 0} 个文件（新增 ${result.added ?? 0}，更新 ${result.updated ?? 0}，跳过 ${result.skipped ?? 0}，移除 ${result.removed ?? 0}）${root ? `；范围 ${root}` : ""}`;
      } catch {
        summary = "扫描完成";
      }
      ui.toast(
        "ok",
        fast ? "快速扫描完成" : "扫描完成",
        fast ? `${summary}；字段来自目录结构，没有读取音频标签` : summary
      );
    }
  } catch (err) {
    progress.finish({ state: "error", message: err.message });
    ui.toast("err", "扫描失败", err.message);
  } finally {
    nodes.scanBtn.disabled = false;
    nodes.scanBtn.setAttribute("aria-busy", "false");
    nodes.scanBtn.textContent = "开始扫描";
    ui.withIcon(nodes.scanBtn, "scan");
    nodes.scanRoot.value = "";
    emit("status:refresh");
    await refresh();
    emit("jobs:refresh");
  }
}

/* ------------------------------------------------------- 编辑 + 预览确认 */

function hasOverlayAboveEditor() {
  return Boolean(document.querySelector("dialog[open]")) ||
    [...document.querySelectorAll(".palette-veil, #auth-veil")].some((node) => node.getClientRects().length && !node.hidden);
}

function isCurrentEdit(revision) {
  return state.edit.open && revision === editRevision;
}

// Baselines use what the control can actually display. Text inputs strip line
// breaks, while textareas normalize CRLF; neither may create an unintended edit.
function editDisplayValue(key, value) {
  const control = ui.byId(`edit-${key}`).cloneNode(false);
  control.value = value === null ? "" : String(value);
  return control.value;
}

function fieldBaseline(rows, key) {
  const values = [];
  for (const row of rows) {
    if (!Object.hasOwn(row, key) || (row[key] !== null && typeof row[key] !== "string" && !(typeof row[key] === "number" && Number.isFinite(row[key])))) {
      return { kind: "unknown", value: "" };
    }
    values.push(editDisplayValue(key, row[key]));
  }
  if (values.some(value => value !== values[0])) return { kind: "mixed", value: "" };
  return { kind: values[0]?.trim() ? "unchanged" : "empty", value: values[0] || "" };
}

function populateEditBaseline(rows, { preserveDraft = false } = {}) {
  for (const key of EDIT_FIELDS) {
    const baseline = fieldBaseline(rows, key);
    editBaseline.set(key, baseline);
    if (!preserveDraft || !editTouched.has(key)) ui.byId(`edit-${key}`).value = baseline.value;
  }
  syncEditDraft();
}

function syncEditDraft() {
  if (!state.edit.open) return;
  const pending = collectFields();
  for (const key of EDIT_FIELDS) {
    const input = ui.byId(`edit-${key}`);
    const baseline = editBaseline.get(key) || { kind: "unknown", value: "" };
    const changed = Object.hasOwn(pending, key);
    const ignoredBlank = input.value.trim() === "" && baseline.value.trim() !== "";
    input.closest(".field").dataset.editState = changed ? "changed" : baseline.kind;
    input.placeholder = baseline.kind === "mixed" ? "多个不同值，输入后统一修改"
      : baseline.kind === "unknown" ? "尚未载入，留空保持原值" : "未填写";
    ui.byId(`edit-hint-${key}`).textContent = changed ? (baseline.kind === "mixed" || baseline.kind === "unknown" ? "将应用到所选曲目" : "已修改，等待预览")
      : ignoredBlank ? "留空会保留原值，不会清除标签"
        : baseline.kind === "mixed" ? "多个不同值 · 留空保持各自原值"
          : baseline.kind === "unknown" ? "此字段尚未载入 · 留空不修改"
            : baseline.kind === "empty" ? "当前未填写"
              : state.edit.rows.length > 1 ? "所选曲目的共同值" : "现有值";
  }
  const count = Object.keys(pending).length;
  nodes.editChangeSummary.textContent = count ? `${count} 个字段待预览${state.edit.rows.length > 1 ? ` · 应用于 ${ui.fmtNum(state.edit.rows.length)} 首曲目` : ""}` : "尚未修改 · 未改动的字段不会写入";
  nodes.editChangeSummary.dataset.changed = String(count > 0);
  nodes.drawerPreview.disabled = state.edit.busy || editUnavailable;
  nodes.drawerClear.disabled = state.edit.busy;
  nodes.editLoadRetry.disabled = state.edit.busy;
  nodes.drawerClose.disabled = Boolean(editSequence && state.edit.busy);
  if (editSequence) editSequenceView.render({
    ...editSequence, busy: state.edit.busy || Boolean(editLeavePrompt), dirty: count > 0, unavailable: editUnavailable,
  });
}

function resetEditDraft() {
  if (!state.edit.open || state.edit.busy) return;
  editTouched.clear();
  for (const key of EDIT_FIELDS) ui.byId(`edit-${key}`).value = editBaseline.get(key)?.value || "";
  lyricsTouched = false;
  nodes.editLyrics.value = lyricsBase;
  nodes.drawerResult.replaceChildren();
  syncEditDraft();
}

async function loadEditMetadata() {
  if (!state.edit.open || state.edit.rows.length !== 1) return;
  editDetailRequest?.abort();
  const request = new AbortController();
  editDetailRequest = request;
  const revision = editRevision, id = Number(state.edit.rows[0].id);
  nodes.editLoadStatus.textContent = "正在载入完整索引资料；你可以先修改已显示的字段。";
  nodes.editLoadStatus.dataset.tone = "loading";
  nodes.editLoadRetry.hidden = true;
  try {
    const detail = await api.track(id, { signal: request.signal });
    if (!isCurrentEdit(revision) || request !== editDetailRequest || request.signal.aborted) return;
    if (!detail || Array.isArray(detail) || Number(detail.id) !== id) throw new Error("返回的曲目与当前编辑对象不一致");
    state.edit.rows[0] = { ...state.edit.rows[0], ...detail, id };
    for (const key of EDIT_FIELDS) if (!Object.hasOwn(detail, key)) delete state.edit.rows[0][key];
    if (editSequence) {
      editSequence.rows[editSequence.index] = { ...state.edit.rows[0] };
      nodes.drawerScope.textContent = state.edit.rows[0].title || state.edit.rows[0].filename || `曲目 #${id}`;
      nodes.drawerScope.title = [nodes.drawerScope.textContent, state.edit.rows[0].path].filter(Boolean).join("\n");
    }
    populateEditBaseline(state.edit.rows, { preserveDraft: true });
    editUnavailable = detail.file_exists === false;
    const partial = [...editBaseline.values()].some(field => field.kind === "unknown");
    nodes.editLoadStatus.textContent = editUnavailable ? "原文件暂不可访问。请检查挂载后重新载入，当前修改会保留。"
      : partial ? "部分字段尚未载入，已单独标记；你可以重新载入，或只修改已知内容。"
      : detail.tags_loaded === false || detail.path_derived === true ? "已载入索引资料，其中包含路径推断；预览时会读取文件里的真实值。"
        : "已载入完整索引资料；预览时会核对文件里的实际值。";
    nodes.editLoadStatus.dataset.tone = editUnavailable || partial ? "warn" : "success";
    nodes.editLoadRetry.hidden = !editUnavailable && !partial;
  } catch (error) {
    if (!isCurrentEdit(revision) || request !== editDetailRequest || request.signal.aborted) return;
    if (error.status === 404) editUnavailable = true;
    nodes.editLoadStatus.textContent = error.status === 404 ? "这首曲目已不在索引中。请刷新曲库，或恢复索引后重新载入。"
      : `完整资料载入失败：${error.message}。已显示的内容和你的修改已保留。`;
    nodes.editLoadStatus.dataset.tone = "error";
    nodes.editLoadRetry.hidden = false;
  } finally {
    if (isCurrentEdit(revision) && request === editDetailRequest) { editDetailRequest = null; syncEditDraft(); }
  }
}

/** 载入文件里现有的歌词（只读；失败也不影响编辑其它字段）。 */
async function loadLyrics(trackId) {
  const rowId = Number(trackId);
  if (!rowId || !nodes.editLyrics) return;
  const revision = editRevision;
  editLyricsRequest?.abort();
  const request = new AbortController();
  editLyricsRequest = request;
  if (nodes.editLyricsHint) nodes.editLyricsHint.textContent = "正在读取文件里的歌词…";
  try {
    const data = await api.trackLyrics(rowId, { signal: request.signal });
    // 期间可能已经关了面板或换了曲目：只认当前这一首
    const current = state.edit.rows[0];
    if (!isCurrentEdit(revision) || request !== editLyricsRequest || request.signal.aborted || !current || Number(current.id) !== rowId) return;
    lyricsBase = editDisplayValue("lyrics", typeof data.lyrics === "string" ? data.lyrics : "");
    // 网络返回之前已经开始输入时，保留用户的文字，只更新比对基线。
    if (!lyricsTouched) nodes.editLyrics.value = lyricsBase;
    if (nodes.editLyricsHint) {
      nodes.editLyricsHint.textContent = data.has_lyrics
        ? `文件里现有 ${data.lines} 行 · ${data.chars} 字（改了才会写入；清空 = 不改动）`
        : "这个文件当前没有歌词：写进去后点「预览变更」，确认才会落盘。";
    }
  } catch (err) {
    if (!isCurrentEdit(revision) || request !== editLyricsRequest || request.signal.aborted) return;
    if (nodes.editLyricsHint) {
      nodes.editLyricsHint.textContent = `读取现有歌词失败：${err.message}（留空表示不改动歌词）`;
    }
  } finally {
    if (isCurrentEdit(revision) && request === editLyricsRequest) { editLyricsRequest = null; syncEditDraft(); }
  }
}

function canEditWorkspace() {
  const session = window.__MT_AUTH?.state;
  return !editAccessBlocked && Boolean(session && (!session.required || session.authenticated));
}

/** All replacements of a sequence use the same leave check, including older edit entry points. */
function requestEditChange(action, { protect = Boolean(editSequence) } = {}) {
  if (!canEditWorkspace()) return;
  if (editLeavePrompt) { editLeavePrompt.keep.focus(); return; }
  if (state.edit.open && protect) {
    if (state.edit.busy) { ui.toast("info", "当前操作尚未结束", "请等待预览或写入完成后，再切换曲目或结束本轮。"); return; }
    const fields = Object.keys(collectFields());
    if (fields.length) {
      const revision = editRevision;
      void confirmEditLeave(fields).then(discard => {
        if (discard && isCurrentEdit(revision) && !state.edit.busy && canEditWorkspace()) action();
      });
      return;
    }
  }
  action();
}

function confirmEditLeave(fields) {
  const revision = editRevision, trigger = document.activeElement;
  return new Promise(resolve => {
    const dialog = ui.el("dialog", { id: "edit-sequence-leave-dialog", class: "modal narrow", "aria-labelledby": "edit-sequence-leave-title" });
    let settled = false;
    const finish = discard => {
      if (settled) return;
      settled = true;
      if (editLeavePrompt?.dialog === dialog) editLeavePrompt = null;
      if (dialog.open) dialog.close();
      dialog.remove();
      syncEditDraft();
      if (!discard && isCurrentEdit(revision) && canEditWorkspace()) {
        const target = trigger instanceof HTMLElement && trigger.isConnected && trigger.getClientRects().length && !trigger.matches(":disabled") ? trigger : ui.byId("edit-title");
        target.focus({ preventScroll: true });
      }
      resolve(discard);
    };
    const keep = ui.el("button", { id: "edit-sequence-keep", type: "button", class: "btn btn-primary", autofocus: true, text: "返回编辑", onClick: () => finish(false) });
    const discard = ui.el("button", { id: "edit-sequence-discard", type: "button", class: "btn", text: "放弃本首修改", onClick: () => finish(true) });
    dialog.append(
      ui.el("div", { class: "modal-head" }, [ui.el("h2", { id: "edit-sequence-leave-title", text: "这首曲目还有未提交的修改" })]),
      ui.el("div", { class: "modal-body" }, [
        ui.el("p", { text: `${fields.length} 个字段尚未提交：${fields.map(ui.fieldLabel).join("、")}。` }),
        ui.el("p", { class: "hint", text: "返回编辑可继续预览并确认。放弃只会丢弃当前草稿，之前已写入的标签会保留。" }),
      ]),
      ui.el("div", { class: "modal-foot" }, [keep, discard]),
    );
    dialog.addEventListener("cancel", event => { event.preventDefault(); finish(false); });
    dialog.addEventListener("close", () => finish(false));
    editLeavePrompt = { dialog, keep, cancel: () => finish(false) };
    document.body.append(dialog); dialog.showModal(); keep.focus(); syncEditDraft();
  });
}

function openEdit(rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  const snapshot = rows.map(row => ({ ...row }));
  requestEditChange(() => openEditNow(snapshot));
}

function openEditNow(rows, { sequence = null, preserveTrigger = false } = {}) {
  if (!rows || !rows.length) return;
  const switching = state.edit.open && sequence && editSequence === sequence;
  editSequence = sequence;
  if (!editSequence) editSequenceView.hide();
  nodes.drawer.dataset.editMode = sequence ? "sequence" : "standard";
  ui.byId("edit-drawer-title").textContent = sequence ? "逐首编辑" : "编辑元数据";
  nodes.drawerClose.textContent = sequence ? "结束本轮" : "关闭";
  nodes.drawerClose.setAttribute("aria-label", sequence ? "结束逐首编辑" : "关闭编辑面板");
  nodes.drawerClose.disabled = false;
  editDetailRequest?.abort();
  editLyricsRequest?.abort();
  editDetailRequest = editLyricsRequest = null;
  const revision = ++editRevision;
  const trigger = document.activeElement;
  if (!preserveTrigger && (!state.edit.open || !nodes.drawer.contains(trigger))) {
    editTrigger = trigger instanceof HTMLElement ? trigger : null;
    if (sequence && (!editTrigger || editTrigger === document.body || !editTrigger.getClientRects().length)) editTrigger = ui.byId("selection-review") || nodes.q;
  }
  state.edit.rows = rows.map((row) => ({ ...row }));
  state.edit.open = true;
  state.edit.busy = false;
  editUnavailable = false;
  editBaseline = new Map();
  editTouched = new Set();
  lyricsTouched = false;
  nodes.drawerPreview.disabled = false;
  nodes.drawerPreview.textContent = "预览变更";
  nodes.drawerResult.replaceChildren();
  // 歌词：先清空，再载入文件里现有的（多选时留空 = 不改动歌词）
  lyricsBase = "";
  if (nodes.editLyrics) nodes.editLyrics.value = "";
  if (nodes.editLyricsHint) {
    nodes.editLyricsHint.textContent = rows.length === 1
      ? "正在载入现有歌词；只提交修改，留空保持原值。"
      : "批量编辑不载入各首歌词；填写后会统一替换所选曲目的歌词，留空保持各自原值。";
  }
  populateEditBaseline(state.edit.rows);
  nodes.editDescription.textContent = sequence ? "逐首修改，预览并确认后才写入。切换前会检查草稿；本轮顺序保持不变。" : rows.length === 1
    ? "已有资料直接显示，只提交实际修改的字段。留空保持原值；预览并确认后才写入。"
    : "相同字段显示共同值，不同内容会明确标记。只提交你修改的字段，留空保持各自原值。";
  nodes.editLoadRetry.hidden = true;
  nodes.editLoadStatus.dataset.tone = "success";
  nodes.editLoadStatus.textContent = "已显示所选曲目的已知资料；未载入字段不会被当作空值写入。";
  if (rows.length === 1) { void loadEditMetadata(); void loadLyrics(rows[0].id); }
  const first = state.edit.rows[0];
  ui.setText(nodes.drawerScope, sequence ? first.title || first.filename || `曲目 #${first.id}` : rows.length === 1 ? `1 首：${first.title || first.filename}` : `${rows.length} 首`);
  nodes.drawerScope.title = sequence ? [nodes.drawerScope.textContent, first.path].filter(Boolean).join("\n") : rows.length === 1 ? first.path || "" : rows.map((row) => row.title || row.filename).join("\n");
  nodes.drawer.dataset.open = "true";
  // 抽屉头也用这张封面做色晕（.drawer-head::before 读 --art）
  nodes.drawer.style.setProperty(
    "--art",
    first.has_cover ? `url("${coverUrl(first.id)}")` : "none",
  );
  nodes.drawer.setAttribute("aria-hidden", "false");
  nodes.drawer.inert = false;
  if (sequence) {
    nodes.drawer.querySelector(".drawer-body").scrollTop = 0;
    syncEditDraft();
    if (switching) editSequenceView.animate();
  }
  // 等一帧：抽屉用 visibility 过渡，切换当帧直接 focus 有概率落空
  const focusTarget = ui.byId("edit-title");
  if (focusTarget) requestAnimationFrame(() => { if (isCurrentEdit(revision)) focusTarget.focus(); });
}

/** Review handoff carries the complete, immutable selection scope. */
export function editSelection(rows) { openEdit(rows); }

/** The session owns a separate order: successful writes may remove global selection members. */
export function editSelectionSequence(rows) {
  if (!Array.isArray(rows)) return;
  const seen = new Set();
  const snapshot = rows.filter(row => Number.isSafeInteger(Number(row?.id)) && Number(row.id) > 0 && !seen.has(Number(row.id)) && seen.add(Number(row.id))).map(row => ({ ...row, id: Number(row.id) }));
  if (!snapshot.length) return;
  requestEditChange(() => {
    const sequence = { rows: snapshot, index: 0, states: new Map() };
    openEditNow([snapshot[0]], { sequence });
  }, { protect: true });
}

function navigateEditSequence(index) {
  const sequence = editSequence;
  if (!sequence || !Number.isInteger(index) || index < 0 || index >= sequence.rows.length || index === sequence.index) return;
  requestEditChange(() => {
    if (editSequence !== sequence) return;
    sequence.index = index;
    openEditNow([sequence.rows[index]], { sequence, preserveTrigger: true });
  });
}

function skipEditSequence() {
  const sequence = editSequence;
  if (!sequence) return;
  requestEditChange(() => {
    if (editSequence !== sequence) return;
    const id = sequence.rows[sequence.index].id;
    if (!["saved", "unchanged"].includes(sequence.states.get(id)?.status)) sequence.states.set(id, { status: "skipped" });
    resetEditDraft(); syncEditDraft();
  });
}

function recordEditSequence(status, revision) {
  if (!editSequence || !isCurrentEdit(revision)) return;
  editSequence.states.set(editSequence.rows[editSequence.index].id, { status });
  syncEditDraft();
}

function closeEdit({ restoreFocus = true, force = false } = {}) {
  if (force) { closeEditNow({ restoreFocus }); return; }
  requestEditChange(() => closeEditNow({ restoreFocus }));
}

function closeEditNow({ restoreFocus = true } = {}) {
  if (!state.edit.open) return;
  editRevision += 1;
  editLeavePrompt?.cancel();
  ui.byId("edit-preview-dialog")?.close();
  editDetailRequest?.abort();
  editLyricsRequest?.abort();
  editDetailRequest = editLyricsRequest = null;
  state.edit.open = false;
  state.edit.busy = false;
  editSequence = null;
  editSequenceView.hide();
  nodes.drawer.dataset.open = "false";
  // 先把焦点移出即将隐藏的抽屉；列表刷新后原触发按钮可能已经不在文档中。
  if (restoreFocus) {
    if (editTrigger?.isConnected && editTrigger.getClientRects().length && !editTrigger.matches(":disabled") && !editTrigger.closest("[inert]") && !nodes.drawer.contains(editTrigger)) editTrigger.focus();
    else if (state.tab === "tracks") nodes.q.focus();
    else document.querySelector('.tab[aria-selected="true"]')?.focus();
  }
  nodes.drawer.setAttribute("aria-hidden", "true");
  nodes.drawer.inert = true;
  editTrigger = null;
  emit("edit:closed");
}

function collectFields() {
  const fields = {};
  EDIT_FIELDS.forEach((key) => {
    const input = ui.byId(`edit-${key}`);
    if (!input) return;
    const value = input.value.trim();
    if (value !== "" && value !== (editBaseline.get(key)?.value || "").trim()) fields[key] = value;
  });
  // 歌词：只有改动过才带上（基线是打开面板时从文件里读回来的那份）
  const lyrics = nodes.editLyrics ? nodes.editLyrics.value : "";
  if (lyrics.trim() !== "" && lyrics.trim() !== lyricsBase.trim()) fields.lyrics = lyrics;
  return fields;
}

async function runPreview() {
  if (state.edit.busy || !state.edit.open || editUnavailable || editLeavePrompt || !canEditWorkspace()) return;
  const revision = editRevision;
  const ids = state.edit.rows.map((row) => Number(row.id)).filter(Boolean);
  if (!ids.length) return;
  const fields = collectFields();
  if (!Object.keys(fields).length) {
    ui.toast("info", "还没有需要提交的修改", "未修改的字段与留空的字段都会保留原值。");
    return;
  }
  const normalize = nodes.editNormalize.checked;
  const overwrite = nodes.editOverwrite.checked;
  state.edit.busy = true;
  syncEditDraft();
  nodes.drawerPreview.disabled = true;
  nodes.drawerPreview.textContent = "预览中…";
  ui.clear(nodes.drawerResult);
  nodes.drawerResult.append(ui.loadingLine("正在读取文件内的现值…（只读，不改动文件）"));
  try {
    const preview = await api.previewTracks({ ids, fields, normalize_artist: normalize, overwrite });
    if (!isCurrentEdit(revision)) return;
    ui.clear(nodes.drawerResult);
    if (Number(preview.index_missing_total) > 0) {
      recordEditSequence("error", revision);
      const sameSelection = ids.length === state.selection.size && ids.every((id) => state.selection.has(id));
      nodes.drawerResult.append(ui.notice("warn", `本次编辑范围有 ${ui.fmtNum(preview.index_missing_total)} 首不在曲库索引。这不表示磁盘文件已删除。${sameSelection ? "请先核对已选范围，再预览变更。" : "请刷新曲库，重新打开对应曲目后再编辑。"}`));
      if (sameSelection) nodes.drawerResult.append(ui.el("button", { id: "edit-review-selection", type: "button", class: "btn btn-sm", text: "审阅已选并核对索引", onClick: () => {
        if (ids.length !== state.selection.size || !ids.every((id) => state.selection.has(id))) { ui.toast("warn", "选择范围已变化", "请刷新曲库，重新打开对应曲目后再编辑。"); return; }
        requestEditChange(() => { closeEditNow(); emit("library:review-selection"); });
      } }));
      return;
    }
    const previewItems = Array.isArray(preview.items) ? preview.items : [];
    if (!previewItems.length) throw new Error("所选曲目无法读取，请刷新曲库后重试。");
    if (previewItems.some((item) => !ids.includes(Number(item.track_id))) || (!preview.truncated && new Set(previewItems.map((item) => Number(item.track_id))).size !== ids.length)) {
      throw new Error("预览中的曲目与选择范围不一致，请刷新曲库后重试。");
    }
    const invalid = previewItems.find((item) => item.file_exists === false || item.current?.error);
    if (invalid) throw new Error(`${invalid.filename || `#${invalid.track_id}`}：${invalid.current?.error || "音乐文件不存在"}。请检查文件后重试。`);
    const changed = preview.changed_fields || 0;
    const noChanges = !changed && !preview.truncated;
    nodes.drawerResult.append(
      ui.notice(
        "info",
        changed
          ? `预览完成：${previewItems.length} 首曲目、合计 ${changed} 处变更。尚未写入任何文件。`
          : preview.truncated ? "已预览的部分没有变更，其余曲目尚未展示。尚未写入任何文件。"
          : "预览完成：按当前覆盖选项，没有需要写入的变更。已有值与跳过原因可在预览中查看。",
      ),
    );
    const body = ui.diffView(previewItems);
    if (preview.truncated) body.unshift(ui.notice("warn", `选择了 ${ids.length} 首，逐曲预览仅展示前 ${previewItems.length} 首；确认后会处理全部所选曲目。`));
    body.push(
      ui.el("div", { class: "hint" }, [
        `本次选择：${Object.keys(fields).map(ui.fieldLabel).join("、")}`,
        overwrite ? "；已勾选覆盖已有值" : "；未勾选覆盖，已有非空值的字段会被跳过",
        fields.lyrics ? "。手动填写的歌词会替换原有歌词。" : "。",
      ]),
    );
    const answer = await ui.openDialog({
      id: "edit-preview-dialog",
      title: `变更预览（${ids.length} 首）`,
      subtitle: "旧值红色、新值绿色；确认后才会写入音频标签",
      body,
      actions: noChanges ? [{ id: "close", label: "关闭预览", variant: "btn-primary" }] : [
        { id: "cancel", label: "取消" },
        { id: "apply", label: `确认处理 ${ids.length} 首`, variant: "btn-primary" },
      ],
    });
    if (!isCurrentEdit(revision)) return;
    if (noChanges) { recordEditSequence("unchanged", revision); return; }
    if (answer !== "apply") {
      nodes.drawerResult.append(ui.notice("info", "已取消，未写入任何文件。"));
      return;
    }
    await applyChanges(ids, fields, normalize, overwrite, revision);
  } catch (err) {
    if (!isCurrentEdit(revision)) return;
    recordEditSequence("error", revision);
    ui.clear(nodes.drawerResult);
    nodes.drawerResult.append(ui.notice("err", `预览失败：${err.message}`));
    ui.toast("err", "预览失败", err.message);
  } finally {
    if (isCurrentEdit(revision)) {
      state.edit.busy = false;
      nodes.drawerPreview.textContent = "预览变更";
      syncEditDraft();
    }
  }
}

async function applyChanges(ids, fields, normalize, overwrite, revision) {
  ui.clear(nodes.drawerResult);
  nodes.drawerResult.append(ui.loadingLine("正在写入标签…"));
  try {
    const result = await api.applyTracks({ ids, fields, normalize_artist: normalize, overwrite });
    // A queue completion marker needs a matching per-track outcome, not merely
    // an HTTP success or an aggregate count. An unknown result remains reviewable.
    if (editSequence && isCurrentEdit(revision)) {
      const outcomes = Array.isArray(result?.items) ? result.items : null;
      const failures = Array.isArray(result?.failed) ? result.failed : null;
      if (!outcomes || !failures || outcomes.length + failures.length !== 1 ||
          [...outcomes, ...failures].some(item => Number(item?.track_id) !== ids[0]) ||
          outcomes.some(item => typeof item.file_changed !== "boolean" || !Array.isArray(item.written))) {
        throw new Error("写入结果无法核对。请先重新载入资料并核对文件，再决定是否重试；本次未标记为已写入。");
      }
    }
    const failed = result.failed || [];
    const unchanged = Number(result.skipped) || 0;
    if (editSequence && isCurrentEdit(revision)) {
      const outcome = Array.isArray(result.items) ? result.items.find(item => Number(item.track_id) === ids[0]) : null;
      recordEditSequence(failed.length || typeof outcome?.file_changed !== "boolean" ? "error" : outcome.file_changed ? "saved" : "unchanged", revision);
    }
    if (isCurrentEdit(revision)) {
      ui.clear(nodes.drawerResult);
      nodes.drawerResult.append(
        ui.el("div", { class: "lbl", text: "写入结果" }),
        ui.resultBlock({
          summary: [
            { label: "已写入", value: result.written ?? 0, variant: "chip" },
            { label: "无需变更", value: unchanged },
            { label: "失败", value: failed.length },
            { label: "字段", value: (result.fields || []).length },
          ],
          failures: failed.map((item) => ({
            who: item.path || `#${item.track_id}`,
            why: `${item.file_changed ? "文件已改动，后续处理未完成：" : ""}${item.error || "未知错误"}`,
          })),
          failuresTitle: "失败明细",
        }),
      );
      const skippedItems = (Array.isArray(result.items) ? result.items : []).filter((item) => item.skipped?.length);
      if (skippedItems.length) {
        const details = ui.el("details", { class: "edit-skipped-results" }, [
          ui.el("summary", { text: `查看 ${skippedItems.length} 首曲目的保留与跳过详情` }),
        ]);
        for (const item of skippedItems.slice(0, 100)) {
          const row = state.edit.rows.find((row) => Number(row.id) === Number(item.track_id));
          details.append(ui.el("div", { class: "edit-skipped-track" }, [
            ui.el("p", { class: "lbl", text: row?.title || row?.filename || `#${item.track_id}` }),
            ui.skippedFieldsView(item.skipped),
          ]));
        }
        if (skippedItems.length > 100) details.append(ui.el("p", { class: "hint", text: "这里只展示前 100 首的详情，其余曲目已包含在结果统计中。" }));
        nodes.drawerResult.append(details);
      }
    }
    if (failed.length) {
      ui.toast("warn", `写入完成，但有 ${failed.length} 首失败`, isCurrentEdit(revision)
        ? "失败原因已列在编辑面板里。"
        : failed.map((item) => `${item.path || `#${item.track_id}`}：${item.error || "未知错误"}`).join("；"));
    } else {
      ui.toast("ok", result.written ? `已写入 ${result.written} 首` : "没有需要写入的变更",
        [unchanged ? `${unchanged} 首保留现值` : "", (result.fields || []).length ? `字段：${result.fields.map(ui.fieldLabel).join("、")}` : ""].filter(Boolean).join("；"));
    }
    if (isCurrentEdit(revision) && ids.length === 1 && !failed.some(item => Number(item.track_id) === ids[0])) {
      const outcome = result.items?.find(item => Number(item.track_id) === ids[0]);
      // Read the resulting index instead of guessing normalized/aliased values.
      // A draft typed while the write was running still belongs to the user.
      for (const key of Array.isArray(outcome?.written) ? outcome.written : []) {
        if (EDIT_FIELDS.includes(key) && ui.byId(`edit-${key}`).value.trim() === String(fields[key] ?? "").trim()) editTouched.delete(key);
      }
      if (outcome?.lyrics && nodes.editLyrics.value.trim() === String(fields.lyrics ?? "").trim()) lyricsTouched = false;
      await Promise.allSettled([loadEditMetadata(), ...(outcome?.lyrics ? [loadLyrics(ids[0])] : [])]);
    }
    const writtenIds = Array.isArray(result.items)
      ? result.items.filter((item) => item.file_changed && !failed.some((failure) => Number(failure.track_id) === Number(item.track_id))).map((item) => Number(item.track_id))
      : ids.filter((id) => !failed.some((item) => Number(item.track_id) === Number(id)));
    removeFromSelection(writtenIds);
    emit("status:refresh");
    await refresh();
  } catch (err) {
    if (isCurrentEdit(revision)) {
      recordEditSequence("error", revision);
      ui.clear(nodes.drawerResult);
      nodes.drawerResult.append(ui.notice("err", `写入失败：${err.message}`));
    }
    ui.toast("err", "写入失败", err.message);
  }
}

export function invalidateSelectionCount() {
  renderSelectionBar();
  syncPageCheckbox();
}
