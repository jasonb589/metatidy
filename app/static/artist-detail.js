/** Indexed artist collections retain exact scope and page state beneath an album. */
import { request, qs } from "./api.js";
import * as ui from "./ui.js";
import * as auth from "./auth.js";
import { emit, state } from "./store.js";
import { normalizeArtistGroup } from "./artist-group.js";
import { normalizeAlbumGroup } from "./album-group.js";
import { openAlbumDetail, closeAlbumDetail } from "./album-detail.js";

const SIZES = { albums: 24, tracks: 50 };
const SUMMARY_COUNTS = ["track_count", "album_count", "unalbumed_count", "bytes", "missing_cover", "missing_lyrics", "not_loaded"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const focusable = node => node?.isConnected && node.getClientRects().length && !node.closest("[inert]") && !node.matches(":disabled");
let closeActive = null;
let accessBlocked = false;

function usable() {
  const session = auth.current();
  return !accessBlocked && (!session.required || session.authenticated) && !document.querySelector(".app-content")?.inert;
}

export function validArtistSummary(summary, name = summary?.name) {
  return object(summary) && typeof summary.name === "string" && Boolean(normalizeArtistGroup(summary.name)) && summary.name === normalizeArtistGroup(summary.name)
    && summary.name === name && SUMMARY_COUNTS.every(key => count(summary[key])) && summary.track_count > 0
    && ["duration", "indexed_at"].every(key => finite(summary[key])) && summary.album_count <= summary.track_count && summary.unalbumed_count <= summary.track_count
    && ["missing_cover", "missing_lyrics", "not_loaded"].every(key => summary[key] <= summary.track_count);
}

export function artistDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  if (!minutes) return seconds > 0 ? "不足 1 分钟" : "时长待补充";
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${ui.fmtNum(minutes)} 分钟`;
}

export function artistAvatar(name, className = "") {
  let tone = 0;
  for (const char of name) tone = (tone * 31 + char.codePointAt(0)) % 5;
  const display = name.replace(/\s/g, "");
  let initial = "";
  if (typeof Intl.Segmenter === "function") initial = [...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(display)][0]?.segment || "";
  else initial = Array.from(display)[0] || "";
  return ui.el("span", { class: `artist-avatar ${className}`.trim(), dataset: { tone }, "aria-hidden": "true", text: initial || "♪" });
}

function summaryKey(summary) { return JSON.stringify([summary.name, ...SUMMARY_COUNTS.map(key => summary[key]), summary.duration, summary.indexed_at]); }
function albumKey(row) { return normalizeAlbumGroup(JSON.stringify([row.album, row.album_artist])); }
function snapshotError(message = "艺术家详情的范围或身份不完整，请刷新后重试。") { return new Error(message); }

export function closeArtistDetail({ restoreFocus = false } = {}) { closeActive?.({ restoreFocus }); }

export function openArtistDetail(initial) {
  const name = normalizeArtistGroup(typeof initial === "string" ? initial : initial?.name);
  if (!name || !usable()) return;
  closeActive?.({ restoreFocus: false });
  if (document.querySelector("dialog[open]")) return;
  const originTab = state.tab, opener = document.activeElement;
  let closed = false, nested = false, requestToken = 0, controller = null, revision = "", summary = null, stale = false;
  let section = "albums", loading = false, ready = false;
  const wanted = { albums: 1, tracks: 1 };
  const cache = { albums: new Map(), tracks: new Map() };
  const seen = { albums: new Map(), tracks: new Map() };
  const scrolls = { albums: 0, tracks: 0 };
  let phase = "loading";

  const dialog = ui.el("dialog", { id: "artist-detail-dialog", class: "artist-detail", "aria-labelledby": "artist-detail-title" });
  const closeButton = ui.el("button", { id: "artist-detail-close", type: "button", class: "btn btn-sm btn-ghost", text: "关闭", "aria-label": "关闭艺术家详情", onClick: () => close() });
  const refreshButton = ui.el("button", { id: "artist-detail-refresh", type: "button", class: "btn btn-sm btn-ghost", text: "刷新详情", onClick: () => void refreshDetail() });
  const title = ui.el("h2", { id: "artist-detail-title", class: "ard-title", tabindex: "-1", text: name, title: name });
  const description = ui.el("p", { class: "ard-description", text: "正在读取这位艺术家的收藏…" });
  const facts = ui.el("dl", { id: "artist-detail-facts", class: "ard-facts" });
  const metadata = ui.el("div", { class: "ard-metadata" });
  const quality = ui.el("div", { class: "ard-quality" });
  const note = ui.el("p", { class: "ard-note", text: "同一艺术家字段的完整名称归为一组；合作名称保持原样。" });
  const overview = ui.el("section", { id: "artist-detail-overview", class: "ard-overview", "aria-label": "艺术家收藏概况" }, [artistAvatar(name, "ard-avatar"), ui.el("div", { class: "ard-intro" }, [title, description, facts, metadata, quality, note])]);
  const albumCount = ui.el("span", { text: "—" });
  const trackCount = ui.el("span", { text: "—" });
  const albumsTab = ui.el("button", { id: "artist-detail-albums-tab", type: "button", role: "tab", "aria-controls": "artist-detail-content", "aria-selected": "true", onClick: () => switchSection("albums") }, ["专辑", albumCount]);
  const tracksTab = ui.el("button", { id: "artist-detail-tracks-tab", type: "button", role: "tab", "aria-controls": "artist-detail-content", "aria-selected": "false", tabindex: "-1", onClick: () => switchSection("tracks") }, ["曲目", trackCount]);
  const tabs = ui.el("div", { id: "artist-detail-tabs", class: "ard-tabs", role: "tablist", "aria-label": "艺术家收藏内容" }, [albumsTab, tracksTab]);
  const status = ui.el("p", { id: "artist-detail-status", class: "ard-status", role: "status", "aria-live": "polite", "aria-atomic": "true" });
  const retry = ui.el("button", { id: "artist-detail-retry", type: "button", class: "btn btn-sm", hidden: true, text: "重试读取", onClick: () => void (stale ? refreshDetail() : loadPage(section, wanted[section])) });
  const list = ui.el("div", { id: "artist-detail-list", class: "ard-list" });
  const content = ui.el("div", { id: "artist-detail-content", class: "ard-content", role: "tabpanel", "aria-labelledby": "artist-detail-albums-tab" }, [list]);
  const previous = ui.el("button", { id: "artist-detail-prev", type: "button", class: "btn btn-sm", text: "上一页", onClick: () => { scrolls[section] = 0; void loadPage(section, wanted[section] - 1); } });
  const next = ui.el("button", { id: "artist-detail-next", type: "button", class: "btn btn-sm", text: "下一页", onClick: () => { scrolls[section] = 0; void loadPage(section, wanted[section] + 1); } });
  const range = ui.el("span", { id: "artist-detail-range", text: "读取中…" });
  const pageLabel = ui.el("span", { id: "artist-detail-page", text: "— / —" });
  const browse = ui.el("button", { id: "artist-detail-browse", type: "button", class: "btn btn-primary", text: "在曲库查看全部曲目", disabled: true, onClick: browseTracks });
  dialog.append(ui.el("header", { class: "ard-head" }, [ui.el("p", { class: "eyebrow", text: "THE ARTIST COLLECTION" }), ui.el("div", { class: "ard-head-actions" }, [refreshButton, closeButton])]),
    ui.el("div", { class: "ard-layout" }, [overview, ui.el("section", { class: "ard-browser", "aria-label": "艺术家专辑与曲目" }, [tabs, ui.el("div", { class: "ard-load-state" }, [status, retry]), content,
      ui.el("nav", { class: "ard-pager", "aria-label": "艺术家详情分页" }, [range, ui.el("div", { class: "spacer" }), previous, pageLabel, next])])]),
    ui.el("footer", { class: "ard-footer" }, [ui.el("p", { class: "ard-footer-note", text: "在曲库中查看此艺术家的精确范围，已有选择会保留。" }), browse]));

  function usableHere() { return !closed && dialog.open && dialog.isConnected && usable() && state.tab === originTab; }
  function guard(token = requestToken) {
    if (closed || token !== requestToken) return false;
    if (!usableHere()) { close({ restoreFocus: false }); return false; }
    return true;
  }
  function stop() { requestToken += 1; controller?.abort(); controller = null; loading = false; }
  function resetSnapshots() {
    for (const value of Object.values(cache)) value.clear();
    for (const value of Object.values(seen)) value.clear();
    revision = ""; summary = null; ready = false;
    wanted.albums = 1; wanted.tracks = 1; scrolls.albums = 0; scrolls.tracks = 0;
  }
  function markStale(message) {
    stop(); resetSnapshots(); stale = true; phase = "stale";
    list.replaceChildren(); renderSummary(); status.textContent = message; sync();
  }
  function renderSummary() {
    if (!summary) {
      facts.replaceChildren(); metadata.replaceChildren(); quality.replaceChildren();
      description.textContent = stale ? "收藏范围已变化，请刷新详情。" : "正在读取这位艺术家的收藏…";
      albumCount.textContent = "—"; trackCount.textContent = "—";
      return;
    }
    description.textContent = `${ui.fmtNum(summary.track_count)} 首音乐，在这里相聚。`;
    facts.replaceChildren(...[["收藏曲目", summary.track_count], ["关联专辑", summary.album_count]].map(([label, value]) => ui.el("div", {}, [ui.el("dt", { text: label }), ui.el("dd", { text: ui.fmtNum(value) })])));
    metadata.replaceChildren(ui.el("p", { text: `${artistDuration(summary.duration)} · ${ui.fmtBytes(summary.bytes)}` }), ui.el("p", { text: summary.indexed_at ? `最近收录 ${ui.fmtTime(summary.indexed_at)}` : "收录时间待补充" }));
    if (summary.unalbumed_count) metadata.append(ui.el("p", { text: `${ui.fmtNum(summary.unalbumed_count)} 首尚未标注专辑，可在曲目页查看。` }));
    quality.replaceChildren(...[["missing_cover", "待补封面"], ["missing_lyrics", "待补歌词"], ["not_loaded", "待读标签"]].filter(([key]) => summary[key] > 0).map(([key, label]) => ui.el("span", { class: "badge badge-mute", text: `${label} ${ui.fmtNum(summary[key])}` })));
    note.textContent = "根据曲库已索引的艺术家标签归组；合作名称保持原样。专辑详情展示整张专辑。";
    albumCount.textContent = ui.fmtNum(summary.album_count); trackCount.textContent = ui.fmtNum(summary.track_count);
  }
  function sync() {
    const focused = document.activeElement;
    dialog.dataset.phase = phase; dialog.dataset.view = section; dialog.dataset.nested = String(nested);
    const current = cache[section].get(wanted[section]);
    previous.disabled = loading || stale || !ready || !current || current.page <= 1;
    next.disabled = loading || stale || !ready || !current || current.page >= current.pages;
    refreshButton.disabled = loading || nested;
    browse.disabled = loading || stale || !ready || !summary || nested;
    retry.hidden = !["error", "stale"].includes(phase); retry.disabled = loading;
    retry.textContent = stale ? "刷新艺术家详情" : "重试读取";
    for (const [button, view] of [[albumsTab, "albums"], [tracksTab, "tracks"]]) {
      const active = section === view; button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1;
    }
    content.setAttribute("aria-labelledby", section === "albums" ? albumsTab.id : tracksTab.id);
    content.setAttribute("aria-busy", String(loading));
    pageLabel.textContent = current && !stale && ready ? `${current.page} / ${Math.max(1, current.pages)}` : "— / —";
    range.textContent = current && !stale && ready ? `共 ${ui.fmtNum(current.total)} ${section === "albums" ? "张专辑" : "首曲目"}` : loading ? "读取中…" : "尚未载入";
    if (dialog.open && !nested && focused && dialog.contains(focused) && !focusable(focused)) (focusable(retry) ? retry : section === "albums" ? albumsTab : tracksTab).focus({ preventScroll: true });
  }
  function validate(data, view, requested) {
    if (!object(data) || data.name !== name || !validArtistSummary(data.summary, name) || !/^[a-f0-9]{32}$/.test(data.revision || "") || data.section !== view
      || !count(data.total) || data.total !== data.summary[view === "albums" ? "album_count" : "track_count"] || data.page_size !== SIZES[view]
      || data.pages !== Math.ceil(data.total / SIZES[view]) || data.page !== Math.max(1, Math.min(Math.max(1, data.pages), requested))
      || !Array.isArray(data.items) || data.items.length !== Math.min(SIZES[view], Math.max(0, data.total - (data.page - 1) * SIZES[view]))) throw snapshotError();
    const unique = new Set();
    for (const row of data.items) {
      if (!object(row)) throw snapshotError();
      const identity = view === "albums" ? albumKey(row) : row.id;
      if (!identity || unique.has(identity)) throw snapshotError("详情分页出现重复或无效项，请刷新艺术家详情。");
      unique.add(identity);
      if (view === "albums") {
        if (JSON.stringify([row.album, row.album_artist]) !== identity || !count(row.track_count) || row.track_count < 1 || !count(row.artist_track_count)
          || row.artist_track_count < 1 || row.artist_track_count > row.track_count || row.artist_track_count > data.summary.track_count
          || !finite(row.duration) || !count(row.bytes) || typeof row.year !== "string") throw snapshotError();
      } else if (!positiveId(row.id) || normalizeArtistGroup(row.artist) !== name || !["filename", "path", "title", "artist", "album", "albumartist"].every(key => typeof row[key] === "string")
        || !finite(row.duration) || ![0, 1].includes(row.has_cover) || ![0, 1].includes(row.has_lyrics) || typeof row.tags_loaded !== "boolean") throw snapshotError();
    }
    if (revision && (revision !== data.revision || summaryKey(summary) !== summaryKey(data.summary))) {
      const error = snapshotError("艺术家的收藏范围已变化，请刷新详情后继续。"); error.stale = true; throw error;
    }
    const known = cache[view].get(data.page);
    const identities = data.items.map(row => view === "albums" ? albumKey(row) : row.id);
    if (known && JSON.stringify(known.items.map(row => view === "albums" ? albumKey(row) : row.id)) !== JSON.stringify(identities)) throw snapshotError("同一版本的分页内容发生变化，请刷新详情。");
    for (const identity of identities) if (seen[view].has(identity) && seen[view].get(identity) !== data.page) throw snapshotError("详情分页出现重复项，请刷新艺术家详情。");
    return { data, identities };
  }
  async function loadPage(view, requested) {
    if (!guard() || nested || stale || !SIZES[view] || requested < 1) return;
    const prior = cache[view].get(requested);
    if (prior) {
      stop(); wanted[view] = prior.page; ready = true; phase = "ready"; status.textContent = ""; renderItems(prior, true); sync(); return;
    }
    stop(); wanted[view] = requested; loading = true; ready = false; phase = "loading";
    const token = requestToken, expectedRevision = revision;
    controller = new AbortController(); list.replaceChildren(); status.textContent = `正在读取${view === "albums" ? "关联专辑" : "收藏曲目"}…`; sync();
    if (!guard(token)) return;
    try {
      const data = await request(`/api/library/artists/detail?${qs({ artist_group: name, section: view, page: requested, page_size: SIZES[view], revision: expectedRevision })}`, { signal: controller.signal });
      if (!guard(token) || section !== view) return;
      const validated = validate(data, view, requested);
      revision = data.revision; summary = data.summary; cache[view].set(data.page, data);
      for (const id of validated.identities) seen[view].set(id, data.page);
      wanted[view] = data.page; loading = false; ready = true; phase = "ready"; status.textContent = "";
      renderSummary(); renderItems(data, true); sync();
    } catch (error) {
      if (!guard(token)) return;
      if (error.status === 404 || error.status === 409 || error.stale) { markStale(`${error.message} 请刷新后继续。`); return; }
      loading = false; ready = false; phase = "error"; status.textContent = `详情读取失败：${error.message}`; list.replaceChildren(); sync();
    } finally { if (token === requestToken) { controller = null; loading = false; sync(); } }
  }
  function refreshDetail() {
    if (!guard() || nested) return;
    stop(); resetSnapshots(); stale = false; phase = "loading";
    renderSummary(); return loadPage(section, 1);
  }
  function switchSection(nextSection) {
    if (!guard() || nested || nextSection === section) return;
    scrolls[section] = content.scrollTop; stop(); section = nextSection;
    if (stale) { list.replaceChildren(); sync(); return; }
    void loadPage(section, wanted[section]);
  }
  function renderItems(data, animate) {
    list.classList.remove("ard-list-enter");
    if (!data.items.length) {
      list.replaceChildren(ui.el("div", { class: "ard-empty" }, [ui.el("p", { text: section === "albums" ? "这位艺术家的曲目还没有专辑标签。" : "此页没有曲目。" }), section === "albums" ? ui.el("button", { id: "artist-detail-show-tracks", type: "button", class: "btn btn-sm", text: "查看收藏曲目", onClick: () => switchSection("tracks") }) : null]));
    } else list.replaceChildren(...data.items.map((row, index) => section === "albums" ? albumRow(row) : trackRow(row, (data.page - 1) * SIZES.tracks + index + 1)));
    if (animate) { void list.offsetWidth; list.classList.add("ard-list-enter"); }
    content.scrollTop = scrolls[section] || 0;
  }
  function albumRow(row) {
    return ui.el("article", { class: "ard-album", dataset: { albumGroup: albumKey(row) } }, [ui.el("span", { class: "ard-record", "aria-hidden": "true" }, [ui.icon("album", { size: 23 })]),
      ui.el("div", { class: "ard-album-copy" }, [ui.el("button", { type: "button", class: "ard-album-name", text: row.album, title: row.album, onClick: event => showAlbum(row, event.currentTarget) }),
        ui.el("p", { class: "ard-album-artist", text: row.album_artist || "未知专辑艺术家", title: row.album_artist }),
        ui.el("p", { class: "ard-album-meta" }, [ui.el("span", { text: `本艺术家 ${ui.fmtNum(row.artist_track_count)} 首 / 全专辑 ${ui.fmtNum(row.track_count)} 首` }), row.year ? ui.el("span", { text: row.year }) : null])]),
      ui.el("button", { type: "button", class: "btn btn-sm btn-ghost ard-album-open", text: "专辑详情", "aria-label": `查看 ${row.album} 的整张专辑`, onClick: event => showAlbum(row, event.currentTarget) })]);
  }
  function trackRow(row, ordinal) {
    const group = normalizeAlbumGroup(JSON.stringify([row.album, normalizeArtistGroup(row.albumartist) || normalizeArtistGroup(row.artist)]));
    return ui.el("article", { class: "ard-track", dataset: { artistTrackId: row.id } }, [ui.el("span", { class: "ard-track-number", text: String(ordinal).padStart(2, "0") }),
      ui.el("div", { class: "ard-track-copy" }, [ui.el("strong", { class: "ard-track-name", text: row.title || row.filename, title: row.title || row.filename }),
        group ? ui.el("button", { type: "button", class: "ard-track-album", text: row.album, title: row.album, onClick: event => { const [album, album_artist] = JSON.parse(group); showAlbum({ album, album_artist }, event.currentTarget); } }) : ui.el("p", { class: "ard-album-artist", text: "尚未标注专辑" }),
        ui.el("span", { class: "ard-track-path", text: row.path, title: row.path }),
        ui.el("p", { class: "ard-track-missing", text: [!row.has_cover ? "待补封面" : "", !row.has_lyrics ? "待补歌词" : "", row.tags_loaded === false ? "待读标签" : ""].filter(Boolean).join(" · ") })]),
      ui.el("span", { class: "ard-track-duration", text: ui.fmtDuration(row.duration) || "—" })]);
  }
  function showAlbum(row, button) {
    if (!guard() || nested || stale || !ready || !albumKey(row)) return;
    const token = requestToken; scrolls[section] = content.scrollTop;
    nested = true; dialog.dataset.nested = "true"; dialog.inert = true;
    openAlbumDetail(row, { returnLabel: "返回艺术家", onClose: ({ restoreFocus = false } = {}) => {
      if (closed || token !== requestToken) return;
      nested = false; dialog.inert = false; dialog.dataset.nested = "false";
      if (!restoreFocus) { close({ restoreFocus: false }); return; }
      if (!guard(token)) return;
      (focusable(button) ? button : section === "albums" ? albumsTab : tracksTab).focus({ preventScroll: true });
      // Focus handlers can navigate or expire the session synchronously.
      guard(token);
    } });
    if (!document.querySelector("#album-detail-dialog[open]")) { nested = false; dialog.inert = false; sync(); }
  }
  function browseTracks() {
    if (!guard() || !ready || !summary || stale || loading || nested) return;
    close({ restoreFocus: false });
    if (usable() && state.tab === originTab) emit("artists:open-tracks", { name });
  }
  for (const [button, view] of [[albumsTab, "albums"], [tracksTab, "tracks"]]) button.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const nextView = event.key === "Home" ? "albums" : event.key === "End" ? "tracks" : view === "albums" ? "tracks" : "albums";
    switchSection(nextView); (nextView === "albums" ? albumsTab : tracksTab).focus({ preventScroll: true });
  });
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("close", () => close());
  dialog.addEventListener("keydown", event => {
    if (nested) return;
    if (event.key === "Escape") event.stopPropagation();
    if (event.key !== "Tab") return;
    const inputs = [...dialog.querySelectorAll("button,[tabindex]")].filter(node => node.tabIndex >= 0 && focusable(node)), first = inputs[0], last = inputs.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === title)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  const leave = () => close({ restoreFocus: false });
  for (const event of ["metatidy:unauthorized", "metatidy:logout", "hashchange"]) window.addEventListener(event, leave);
  const observer = new MutationObserver(() => { if (!closed && !dialog.isConnected) close({ restoreFocus: false }); });
  function close({ restoreFocus = true } = {}) {
    if (closed) return;
    closed = true; stop(); observer.disconnect();
    if (nested) closeAlbumDetail({ restoreFocus: false });
    nested = false; dialog.inert = false; resetSnapshots();
    for (const event of ["metatidy:unauthorized", "metatidy:logout", "hashchange"]) window.removeEventListener(event, leave);
    if (closeActive === close) closeActive = null;
    if (dialog.open) dialog.close(); dialog.remove();
    if (restoreFocus && usable() && state.tab === originTab) [opener, ui.byId("artists-q"), ui.byId("tab-artists")].find(focusable)?.focus({ preventScroll: true });
  }
  closeActive = close;
  document.body.append(dialog); dialog.showModal(); title.focus({ preventScroll: true });
  observer.observe(document.body, { childList: true });
  renderSummary(); sync(); void loadPage("albums", 1);
  return dialog;
}

for (const event of ["metatidy:unauthorized", "metatidy:logout"]) window.addEventListener(event, () => { accessBlocked = true; closeArtistDetail(); });
window.addEventListener("metatidy:authenticated", () => { accessBlocked = false; });
