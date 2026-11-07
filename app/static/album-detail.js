/** Exact album groups, paginated index details and an atomic append-to-selection. */
import { api, coverUrl } from "./api.js";
import * as ui from "./ui.js";
import { emit, on, selectRows, selectionIds, selectionRevision } from "./store.js";
import { normalizeAlbumGroup } from "./album-group.js";

const PAGE_SIZE = 100;
const RESOLVE_SIZE = 200;
let closeActive = null;
const validId = (id) => Number.isSafeInteger(id) && id > 0;
const trimSpaces = (value) => String(value || "").replace(/^ +| +$/g, "");
const groupOf = (row) => JSON.stringify([trimSpaces(row.album), trimSpaces(row.albumartist) || trimSpaces(row.artist)]);
const number = (value) => Math.max(0, Number(value) || 0);

export function openAlbumDetail(initial) {
  const key = normalizeAlbumGroup(JSON.stringify([initial.album, initial.album_artist]));
  if (!key) return;
  closeActive?.({ restoreFocus: false });
  const group = JSON.parse(key); const opener = document.activeElement;
  let closed = false, loading = false, ready = false, stale = false;
  let page = 1, wantedPage = 1, pages = 0, total = 0, revision = "", pageRequest = 0, pageController = null;
  let addRequest = 0, addController = null, preparing = false, prepared = null;
  let artId = null;
  const knownIds = new Map();
  const knownPages = new Map();

  const dialog = ui.el("dialog", { id: "album-detail-dialog", class: "album-detail", "aria-labelledby": "album-detail-title" });
  const closeButton = ui.el("button", { id: "album-detail-close", type: "button", class: "btn btn-sm btn-ghost", text: "关闭", "aria-label": "关闭专辑详情", onClick: () => close() });
  const refresh = ui.el("button", { id: "album-detail-refresh", type: "button", class: "btn btn-sm btn-ghost", text: "刷新详情", onClick: () => void loadPage(1, true) });
  const artwork = ui.el("div", { id: "album-detail-art", class: "ad-art" });
  const title = ui.el("h2", { id: "album-detail-title", text: group[0] });
  const artist = ui.el("p", { class: "ad-artist", text: group[1] || "未知专辑艺术家" });
  const facts = ui.el("p", { id: "album-detail-facts", class: "ad-facts" });
  const completeness = ui.el("div", { id: "album-detail-completeness", class: "ad-completeness" });
  const summaryNote = ui.el("p", { class: "ad-summary-note", text: "正在读取专辑索引…" });
  const status = ui.el("p", { id: "album-detail-status", class: "ad-status", role: "status" });
  const retry = ui.el("button", { id: "album-detail-retry", type: "button", class: "btn btn-sm", text: "重试读取", hidden: true, onClick: () => void loadPage(stale ? 1 : wantedPage, stale) });
  const list = ui.el("div", { id: "album-detail-list", class: "ad-list", "aria-label": "按碟号与曲号排序的专辑曲目" });
  const previous = ui.el("button", { id: "album-detail-prev", type: "button", class: "btn btn-sm", text: "上一页", onClick: () => void loadPage(page - 1) });
  const next = ui.el("button", { id: "album-detail-next", type: "button", class: "btn btn-sm", text: "下一页", onClick: () => void loadPage(page + 1) });
  const range = ui.el("span", { id: "album-detail-range" });
  const pageLabel = ui.el("span", { id: "album-detail-page" });
  const addStatus = ui.el("p", { id: "album-detail-add-status", class: "ad-add-status", role: "status", text: "整张加入会追加到已有选择，准备完成后会显示准确范围供确认。" });
  const prepare = ui.el("button", { id: "album-detail-prepare", type: "button", class: "btn btn-primary", text: "准备整张加入选择", onClick: () => void prepareSelection() });
  const cancel = ui.el("button", { id: "album-detail-cancel", type: "button", class: "btn btn-sm btn-ghost", text: "取消准备", hidden: true, onClick: () => {
    cancelAddition("已取消准备，已有选择未改变。"); sync(); prepare.focus({ preventScroll: true });
  } });
  const confirm = ui.el("button", { id: "album-detail-confirm", type: "button", class: "btn btn-primary", text: "确认追加并审阅", hidden: true, onClick: () => confirmSelection() });
  const viewTracks = ui.el("button", { id: "album-detail-view-tracks", type: "button", class: "btn", text: "在曲库查看", onClick: () => {
    close({ restoreFocus: false }); emit("albums:open", { album: group[0], album_artist: group[1] });
  } });
  dialog.append(
    ui.el("header", { class: "ad-head" }, [ui.el("p", { class: "eyebrow", text: "INSIDE THE ALBUM" }), ui.el("div", { class: "ad-head-actions" }, [refresh, closeButton])]),
    ui.el("div", { class: "ad-layout" }, [
      ui.el("section", { class: "ad-overview", "aria-label": "专辑概况" }, [artwork, ui.el("div", { class: "ad-intro" }, [title, artist, facts, completeness, summaryNote])]),
      ui.el("section", { class: "ad-tracks" }, [
        ui.el("div", { class: "ad-list-head" }, [ui.el("h3", { text: "专辑曲序" }), ui.el("span", { class: "hint", text: "按碟号、曲号排序" })]),
        ui.el("div", { class: "ad-load-state" }, [status, retry]), list,
        ui.el("nav", { class: "ad-pager", "aria-label": "专辑曲目分页" }, [range, ui.el("div", { class: "spacer" }), previous, pageLabel, next]),
      ]),
    ]),
    ui.el("footer", { class: "ad-footer" }, [addStatus, ui.el("div", { class: "ad-footer-actions" }, [viewTracks, ui.el("div", { class: "spacer" }), cancel, prepare, confirm])]),
  );
  const unsubscribe = on("selection:changed", () => {
    const expected = prepared?.members ?? addController?.members;
    if (closed || expected === undefined || expected === selectionRevision()) return;
    cancelAddition("已有选择范围发生变化，准备结果已取消，请重新准备。"); sync();
  });
  const unauthorized = () => close({ restoreFocus: false });
  const hashChanged = () => close({ restoreFocus: false });
  window.addEventListener("metatidy:unauthorized", unauthorized); window.addEventListener("hashchange", hashChanged);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  dialog.addEventListener("close", () => close());
  closeActive = close;
  document.body.append(dialog); renderSummary(initial, true); sync(); dialog.showModal(); closeButton.focus(); void loadPage(1);

  function close({ restoreFocus = true } = {}) {
    if (closed) return;
    closed = true; pageRequest += 1; pageController?.abort(); cancelAddition(); knownIds.clear(); knownPages.clear(); unsubscribe();
    window.removeEventListener("metatidy:unauthorized", unauthorized); window.removeEventListener("hashchange", hashChanged);
    if (closeActive === close) closeActive = null;
    if (dialog.open) dialog.close(); dialog.remove();
    const fallback = ui.byId("albums-q");
    const target = opener?.isConnected && opener.getClientRects().length ? opener : fallback;
    if (restoreFocus && target?.getClientRects().length && !target.closest("[inert]")) target.focus({ preventScroll: true });
  }

  function cancelAddition(message) {
    addRequest += 1; addController?.abort(); addController = null; prepared = null; preparing = false;
    if (message) addStatus.textContent = message;
  }

  function sync() {
    prepare.disabled = !ready || loading || stale || preparing; prepare.hidden = Boolean(prepared);
    prepare.textContent = preparing ? "正在准备整张选择…" : "准备整张加入选择";
    confirm.hidden = !prepared; cancel.hidden = !preparing && !prepared; cancel.textContent = prepared ? "取消追加" : "取消准备";
    refresh.disabled = loading; previous.disabled = loading || stale || !ready || page <= 1; next.disabled = loading || stale || !ready || page >= pages;
    pageLabel.textContent = ready && !stale ? `${page} / ${Math.max(1, pages)}` : "— / —";
    range.textContent = ready && !stale ? `共 ${ui.fmtNum(total)} 首` : loading ? "读取中…" : "未载入";
    list.setAttribute("aria-busy", String(loading));
  }

  function renderSummary(summary, snapshot = false) {
    title.textContent = summary.album; artist.textContent = summary.album_artist || "未知专辑艺术家";
    const minutes = Math.round(number(summary.duration) / 60);
    facts.textContent = [summary.year, `${ui.fmtNum(summary.track_count)} 首`, minutes ? `${ui.fmtNum(minutes)} 分钟` : "时长待补", ui.fmtBytes(summary.bytes)].filter(Boolean).join(" · ");
    completeness.replaceChildren(...[["missing_cover", "待补封面"], ["missing_lyrics", "待补歌词"], ["not_loaded", "待读标签"]]
      .filter(([field]) => number(summary[field]) > 0).map(([field, text]) => ui.el("span", { class: "badge badge-mute", text: `${text} ${ui.fmtNum(summary[field])}` })));
    if (!completeness.children.length) completeness.append(ui.el("span", { class: "badge badge-ok", text: "封面与歌词已齐备" }));
    summaryNote.textContent = snapshot ? "正在读取最新索引，当前概况来自专辑列表。" : "概况与曲目来自曲库索引；未检查磁盘文件。";
    const id = validId(summary.cover_track_id) ? summary.cover_track_id : 0;
    if (artId === id) return;
    artId = id;
    const fallback = (failed = false) => {
      artwork.dataset.state = failed ? "failed" : "empty";
      artwork.replaceChildren(ui.icon("album", { size: 56 }), ui.el("span", { text: failed ? "封面暂不可用" : "待补一张封面" }));
    };
    if (!id) { fallback(); return; }
    artwork.dataset.state = "loading";
    const image = ui.el("img", { src: coverUrl(id, 512), width: 512, height: 512, decoding: "async", alt: `${summary.album} 的专辑封面` });
    image.addEventListener("load", () => { if (!closed && artId === id && image.parentNode === artwork) artwork.dataset.state = "loaded"; }, { once: true });
    image.addEventListener("error", () => { if (!closed && artId === id && image.parentNode === artwork) fallback(true); }, { once: true }); artwork.replaceChildren(image);
  }

  function validatePage(data, wanted) {
    if (JSON.stringify(data.group) !== key || !/^[a-f0-9]{32}$/.test(data.revision || "") || !data.summary
      || JSON.stringify([data.summary.album, data.summary.album_artist]) !== key || !Number.isSafeInteger(data.total) || data.total < 1
      || data.summary.track_count !== data.total || data.page_size !== PAGE_SIZE || data.pages !== Math.ceil(data.total / PAGE_SIZE)
      || data.page !== Math.max(1, Math.min(data.pages, wanted)) || !Array.isArray(data.items)
      || data.items.length !== Math.min(PAGE_SIZE, data.total - (data.page - 1) * PAGE_SIZE)) throw new Error("专辑详情响应的范围不完整，请重新读取。");
    const ids = new Set();
    for (const row of data.items) {
      if (!validId(row.id) || ids.has(row.id) || groupOf(row) !== key) throw new Error("专辑曲目的身份或分组不一致，请重新读取。");
      ids.add(row.id);
    }
  }

  async function loadPage(wanted, reset = false) {
    if (closed) return;
    const focusControl = [previous, next, refresh, retry].includes(document.activeElement) ? document.activeElement : null;
    wantedPage = wanted;
    cancelAddition("整张加入会追加到已有选择，准备完成后会显示准确范围供确认。");
    pageController?.abort(); const abort = new AbortController(); pageController = abort; const request = ++pageRequest;
    if (reset) { revision = ""; knownIds.clear(); knownPages.clear(); ready = false; stale = false; artId = null; }
    loading = true; list.replaceChildren(); status.textContent = "正在读取专辑曲序…"; retry.hidden = true; sync();
    try {
      const data = await api.albumDetail({ album_group: key, page: wanted, page_size: PAGE_SIZE }, { signal: abort.signal });
      if (closed || request !== pageRequest) return;
      validatePage(data, wanted);
      if (revision && data.revision !== revision) {
        stale = true; throw new Error("专辑的曲目范围或曲序已经变化，请刷新详情后继续。");
      }
      const priorPage = knownPages.get(data.page);
      if (revision && total !== data.total || priorPage && JSON.stringify(priorPage) !== JSON.stringify(data.items.map((row) => row.id))) {
        stale = true; throw new Error("相同专辑版本返回的曲目范围或曲序不一致，请刷新详情。");
      }
      for (const row of data.items) {
        const seenPage = knownIds.get(row.id);
        if (seenPage && seenPage !== data.page) throw new Error("专辑分页出现重复曲目，请刷新详情。");
      }
      for (const row of data.items) knownIds.set(row.id, data.page);
      knownPages.set(data.page, data.items.map((row) => row.id));
      revision = data.revision; total = data.total; page = data.page; pages = data.pages; ready = true; stale = false;
      renderSummary(data.summary); renderRows(data.items); status.textContent = "";
    } catch (error) {
      if (closed || request !== pageRequest || abort.signal.aborted) return;
      if (error.status === 404 || error.status === 409) stale = true;
      ready = false; status.textContent = `详情读取失败：${error.message}`; retry.hidden = false; retry.textContent = stale ? "刷新专辑详情" : "重试读取";
    } finally {
      if (!closed && request === pageRequest) {
        loading = false; sync();
        if (focusControl && document.activeElement === document.body && dialog.open) {
          const target = !focusControl.disabled && !focusControl.hidden ? focusControl : !next.disabled ? next : !previous.disabled ? previous : closeButton;
          target.focus({ preventScroll: true });
        }
      }
    }
  }

  function renderRows(rows) {
    list.replaceChildren(...rows.map((row) => {
      const disc = trimSpaces(row.disc) || "1", track = trimSpaces(row.track) || "—";
      return ui.el("article", { class: "ad-track", dataset: { albumTrackId: row.id } }, [
        ui.el("span", { class: "ad-track-number", title: `碟号 ${disc} · 曲号 ${track}`, text: `${disc} · ${track}` }),
        ui.el("div", { class: "ad-track-copy" }, [ui.el("strong", { text: row.title || row.filename || `曲目 #${row.id}` }), ui.el("span", { text: row.artist || "未知艺术家" }),
          ui.el("span", { class: "ad-track-missing", text: [!row.has_cover ? "待补封面" : "", !row.has_lyrics ? "待补歌词" : "", row.tags_loaded === false ? "待读标签" : ""].filter(Boolean).join(" · ") })]),
        ui.el("span", { class: "ad-track-duration", text: ui.fmtDuration(row.duration) || "—" }),
      ]);
    })); list.scrollTop = 0;
  }

  function validateSelection(data, expectedRevision) {
    if (JSON.stringify(data.group) !== key || data.revision !== expectedRevision || data.total !== total || !Array.isArray(data.ids)
      || data.ids.length !== total || data.ids.some((id) => !validId(id)) || new Set(data.ids).size !== total) throw new Error("整张专辑的曲目范围响应不完整，请刷新后重试。");
    for (const [seenPage, ids] of knownPages) if (JSON.stringify(data.ids.slice((seenPage - 1) * PAGE_SIZE, seenPage * PAGE_SIZE)) !== JSON.stringify(ids)) throw new Error("整张专辑的曲序与已读取页面不一致，请刷新后重试。");
  }

  async function prepareSelection() {
    if (!ready || loading || stale || preparing || closed) return;
    const restorePrepare = document.activeElement === prepare;
    cancelAddition(); const token = ++addRequest; const abort = new AbortController(); abort.members = selectionRevision(); addController = abort;
    const members = abort.members, expectedRevision = revision; const existing = selectionIds();
    const current = () => !closed && token === addRequest && members === selectionRevision() && revision === expectedRevision && !abort.signal.aborted;
    preparing = true; addStatus.textContent = "正在核对整张专辑的曲目范围，已有选择保持不变…"; sync();
    try {
      const selection = await api.albumSelection({ album_group: group, revision: expectedRevision }, { signal: abort.signal });
      if (!current()) return; validateSelection(selection, expectedRevision);
      const ids = selection.ids, tracks = []; const resolvePages = Math.ceil(ids.length / RESOLVE_SIZE);
      for (let page = 1; page <= resolvePages; page += 1) {
        addStatus.textContent = `正在准备整张选择：${ui.fmtNum(tracks.length)} / ${ui.fmtNum(ids.length)} 首。未完成前不改变已有选择。`;
        const result = await api.trackSelection({ ids, page, page_size: RESOLVE_SIZE }, { signal: abort.signal });
        if (!current()) return;
        const expected = ids.slice((page - 1) * RESOLVE_SIZE, page * RESOLVE_SIZE);
        if (result.total !== total || result.selected_total !== total || result.page !== page || result.page_size !== RESOLVE_SIZE || result.pages !== resolvePages
          || result.found_total !== total || result.missing_total !== 0 || !Array.isArray(result.items) || result.items.length !== expected.length) throw new Error("准备期间曲目索引不完整，请刷新专辑后重试。已有选择未改变。");
        for (const [index, item] of result.items.entries()) {
          if (item.id !== expected[index] || item.status !== "found" || item.track?.id !== item.id || groupOf(item.track) !== key) throw new Error("准备期间曲目身份或所属专辑发生变化，请刷新后重试。");
          tracks.push(item.track);
        }
      }
      // Pagination reads separate snapshots. Recheck group membership and order
      // after resolving every row; metadata and disk contents remain unlocked.
      const final = await api.albumSelection({ album_group: group, revision: expectedRevision }, { signal: abort.signal });
      if (!current()) return; validateSelection(final, expectedRevision);
      if (JSON.stringify(final.ids) !== JSON.stringify(ids)) throw new Error("准备期间专辑曲序发生变化，请刷新详情。");
      const combined = new Set([...existing, ...ids]); const added = combined.size - existing.length;
      prepared = { tracks, members, revision: expectedRevision, existing: existing.length, total: combined.size, added };
      addStatus.textContent = `已有选择 ${ui.fmtNum(existing.length)} 首 + 本张 ${ui.fmtNum(ids.length)} 首（重合 ${ui.fmtNum(ids.length - added)} 首）= 合并后 ${ui.fmtNum(combined.size)} 首。确认后追加本次准备的范围并打开审阅；不修改音乐文件。`;
      confirm.textContent = `确认追加 ${ui.fmtNum(added)} 首并审阅`;
    } catch (error) {
      if (!current()) return;
      prepared = null; addStatus.textContent = `准备失败：${error.message}`;
      if (error.status === 404 || error.status === 409) { stale = true; status.textContent = "专辑范围已失效，请刷新详情后重新准备。"; }
    } finally {
      if (current()) {
        preparing = false; addController = null; sync();
        if (restorePrepare && document.activeElement === document.body && dialog.open) (prepared ? confirm : prepare.disabled ? refresh : prepare).focus({ preventScroll: true });
      }
    }
  }

  function confirmSelection() {
    const pending = prepared;
    if (!pending || closed || pending.members !== selectionRevision() || pending.revision !== revision || stale) {
      cancelAddition("范围已变化，请重新准备整张选择。"); sync(); return;
    }
    const tracks = pending.tracks; const added = pending.added; const merged = pending.total;
    close({ restoreFocus: true }); selectRows(tracks);
    emit("library:review-selection"); ui.toast("ok", `已追加 ${ui.fmtNum(added)} 首`, `合并后共选中 ${ui.fmtNum(merged)} 首，可在已选审阅中继续核对。`);
  }
}
