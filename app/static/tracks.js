/**
 * 页签 1：曲库 / 元数据编辑。
 *
 * 交互要点：
 * - 搜索输入 300ms 防抖，只重建 tbody（不改动其它 DOM）
 * - 编辑走「填字段 → 预览差异（只读）→ 确认 → 写入」，失败明细直接列在抽屉里
 * - 封面只在该行 has_cover 为真时才请求 /cover，避免满屏 404
 */

import { api, pollJob } from "./api.js";
import * as ui from "./ui.js";
import {
  state,
  emit,
  isSelected,
  toggleSelect,
  selectRows,
  clearSelection,
  selectionRows,
  selectionCount,
  removeFromSelection,
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

const FILTER_KEYS = ["language", "albumtype", "genre", "year", "missing_cover", "missing_lyrics", "no_artist", "no_album"];

let nodes = null;
let editTrigger = null;

export function init() {
  nodes = {
    strip: ui.byId("stats-strip"),
    scanBtn: ui.byId("btn-scan"),
    scanFull: ui.byId("scan-full"),
    scanFast: ui.byId("scan-fast"),
    scanPrune: ui.byId("scan-prune"),
    scanProgress: ui.byId("scan-progress"),
    updated: ui.byId("tracks-updated"),
    total: ui.byId("tracks-total"),
    reload: ui.byId("btn-tracks-reload"),
    reset: ui.byId("btn-filters-reset"),
    editSelected: ui.byId("btn-edit-selected"),
    q: ui.byId("tracks-q"),
    sort: ui.byId("tracks-sort"),
    order: ui.byId("tracks-order"),
    pageSize: ui.byId("tracks-pagesize"),
    fLanguage: ui.byId("filter-language"),
    fAlbumtype: ui.byId("filter-albumtype"),
    fGenre: ui.byId("filter-genre"),
    fYear: ui.byId("filter-year"),
    fCover: ui.byId("filter-missing-cover"),
    fLyrics: ui.byId("filter-missing-lyrics"),
    fNoArtist: ui.byId("filter-no-artist"),
    fNoAlbum: ui.byId("filter-no-album"),
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
    editNormalize: ui.byId("edit-normalize"),
    editOverwrite: ui.byId("edit-overwrite"),
    editLyrics: ui.byId("edit-lyrics"),
    editLyricsHint: ui.byId("edit-lyrics-hint"),
    dlLanguages: ui.byId("dl-languages"),
    dlAlbumtypes: ui.byId("dl-albumtypes"),
  };

  const debouncedSearch = ui.debounce(() => {
    state.tracks.q = nodes.q.value.trim();
    state.tracks.page = 1;
    refresh();
  }, 300);

  nodes.q.addEventListener("input", debouncedSearch);
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

  nodes.fLanguage.addEventListener("change", () => applyFilter("language", nodes.fLanguage.value));
  nodes.fAlbumtype.addEventListener("change", () => applyFilter("albumtype", nodes.fAlbumtype.value));
  nodes.fGenre.addEventListener("change", () => applyFilter("genre", nodes.fGenre.value.trim()));
  nodes.fYear.addEventListener("change", () => applyFilter("year", nodes.fYear.value.trim()));
  nodes.fCover.addEventListener("change", () => applyFilter("missing_cover", nodes.fCover.checked));
  nodes.fLyrics.addEventListener("change", () => applyFilter("missing_lyrics", nodes.fLyrics.checked));
  nodes.fNoArtist.addEventListener("change", () => applyFilter("no_artist", nodes.fNoArtist.checked));
  nodes.fNoAlbum.addEventListener("change", () => applyFilter("no_album", nodes.fNoAlbum.checked));

  nodes.reset.addEventListener("click", () => {
    resetFilters();
    refresh();
  });
  nodes.reload.addEventListener("click", () => refresh());
  nodes.scanBtn.addEventListener("click", startScan);

  // 「快速扫描」与「全量重扫」可以叠加：fast 只从路径建索引（不打开文件），
  // full 忽略 mtime 缓存强制重算——两个一起勾就是「按目录结构把整库重算一遍」。
  nodes.editSelected.addEventListener("click", () => openEdit(selectionRows()));

  nodes.checkPage.addEventListener("change", () => {
    selectRows(state.tracks.items, nodes.checkPage.checked);
    renderTable();
    renderSelectionBar();
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
    const edit = event.target.closest("button[data-edit-id]");
    if (edit) {
      const row = state.tracks.items.find((item) => String(item.id) === edit.dataset.editId);
      if (row) openEdit([row]);
    }
  });

  nodes.drawerClose.addEventListener("click", closeEdit);
  nodes.drawerClear.addEventListener("click", () => {
    EDIT_FIELDS.forEach((key) => {
      const input = ui.byId(`edit-${key}`);
      if (input) input.value = "";
    });
    if (nodes.editLyrics) nodes.editLyrics.value = "";
    lyricsBase = "";
  });
  nodes.drawerPreview.addEventListener("click", runPreview);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.edit.open) closeEdit();
  });

  // 抽屉关闭时整体移出可聚焦顺序，避免 Tab 走到 aria-hidden 面板里的输入框
  nodes.drawer.inert = true;
  syncControls();
}

function applyFilter(key, value) {
  state.tracks.filters[key] = value;
  state.tracks.page = 1;
  refresh();
}

function resetFilters() {
  FILTER_KEYS.forEach((key) => {
    state.tracks.filters[key] = typeof state.tracks.filters[key] === "boolean" ? false : "";
  });
  state.tracks.q = "";
  syncControls();
}

function syncControls() {
  nodes.q.value = state.tracks.q;
  nodes.sort.value = state.tracks.sort;
  nodes.order.value = state.tracks.order;
  nodes.pageSize.value = String(state.tracks.page_size);
  nodes.fLanguage.value = state.tracks.filters.language;
  nodes.fAlbumtype.value = state.tracks.filters.albumtype;
  nodes.fGenre.value = state.tracks.filters.genre;
  nodes.fYear.value = state.tracks.filters.year;
  nodes.fCover.checked = state.tracks.filters.missing_cover;
  nodes.fLyrics.checked = state.tracks.filters.missing_lyrics;
  nodes.fNoArtist.checked = state.tracks.filters.no_artist;
  nodes.fNoAlbum.checked = state.tracks.filters.no_album;
}

/* --------------------------------------------------------------- 数据 */

export async function refresh() {
  state.tracks.loading = true;
  state.tracks.error = "";
  renderTableStatus();
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
    state.tracks.items = data.items || [];
    state.tracks.total = data.total || 0;
    state.tracks.page = data.page || 1;
    state.tracks.pages = data.pages || 1;
    state.tracks.loadedAt = Date.now();
  } catch (err) {
    state.tracks.error = err.message;
    state.tracks.items = [];
    state.tracks.total = 0;
    state.tracks.pages = 1;
    ui.toast("err", "读取曲目失败", err.message);
  } finally {
    state.tracks.loading = false;
  }
  renderTableStatus();
  renderTable();
  renderPager();
  renderSelectionBar();
}

/** 库统计条 + 语言/类型下拉选项（依赖 /api/status）。 */
export function onStatus(status) {
  const stats = status.stats || {};
  const filters = state.tracks.filters;

  const cards = [
    { key: "tracks", label: "歌曲", value: ui.fmtNum(stats.tracks || 0) },
    { key: "artists", label: "歌手", value: ui.fmtNum(stats.artists || 0) },
    { key: "albums", label: "专辑", value: ui.fmtNum(stats.albums || 0) },
    { key: "missing_cover", label: "缺封面", value: ui.fmtNum(stats.missing_cover || 0), filter: "missing_cover", miss: true },
    { key: "missing_lyrics", label: "缺歌词", value: ui.fmtNum(stats.missing_lyrics || 0), filter: "missing_lyrics", miss: true },
    { key: "bytes", label: "占用", value: ui.fmtBytes(stats.bytes || 0) },
  ];

  ui.clear(nodes.strip);
  cards.forEach((card) => {
    const active = card.filter ? Boolean(filters[card.filter]) : false;
    const body = [
      ui.el("span", { class: "k", text: card.label }),
      ui.el("span", { class: `v ${card.miss && Number(String(card.value).replace(/[^\d]/g, "")) > 0 ? "miss" : ""}`.trim(), text: card.value }),
    ];
    if (card.filter) {
      nodes.strip.append(
        ui.el(
          "button",
          {
            type: "button",
            class: "stat",
            "aria-pressed": active ? "true" : "false",
            title: active ? "点击取消该筛选" : "点击只看这些曲目",
            onClick: () => {
              filters[card.filter] = !filters[card.filter];
              syncControls();
              state.tracks.page = 1;
              refresh();
              onStatus(state.status);
            },
          },
          body,
        ),
      );
    } else {
      nodes.strip.append(ui.el("div", { class: "stat" }, body));
    }
  });

  const languages = stats.languages || [];
  const albumtypes = stats.albumtypes || [];
  fillSelect(nodes.fLanguage, languages, state.tracks.filters.language);
  fillSelect(nodes.fAlbumtype, albumtypes, state.tracks.filters.albumtype);
  fillDatalist(nodes.dlLanguages, languages);
  fillDatalist(nodes.dlAlbumtypes, albumtypes);
  renderTableStatus();
}

function fillSelect(select, values, current) {
  const previous = current || "";
  ui.clear(select);
  select.append(ui.el("option", { value: "", text: "全部" }));
  values.forEach((value) => select.append(ui.el("option", { value, text: value })));
  const values2 = values.includes(previous) ? previous : "";
  select.value = values2;
  state.tracks.filters[select.id === "filter-language" ? "language" : "albumtype"] = values2;
}

function fillDatalist(list, values) {
  ui.clear(list);
  values.forEach((value) => list.append(ui.el("option", { value })));
}

/* --------------------------------------------------------------- 渲染 */

function renderTableStatus() {
  ui.clear(nodes.tableStatus);
  if (state.tracks.loading && !state.tracks.items.length) {
    nodes.tableStatus.append(ui.loadingLine("正在读取索引…"));
    return;
  }
  if (state.tracks.error) {
    nodes.tableStatus.append(ui.notice("err", [ui.el("strong", { text: "读取失败：" }), state.tracks.error]));
    return;
  }
  const stats = (state.status && state.status.stats) || {};
  if ((stats.tracks || 0) === 0) {
    nodes.tableStatus.append(
      ui.emptyState("00", "曲库还是空的", "后端还没有索引到任何音频文件。扫描会遍历音乐目录并按 mtime 增量解析标签，不会改动文件。", [
        ui.el("button", {
          type: "button",
          class: "btn btn-primary",
          text: "扫描曲库",
          onClick: () => nodes.scanBtn.click(),
        }),
      ]),
    );
    nodes.tableWrap.hidden = true;
    return;
  }
  if (!state.tracks.total) {
    nodes.tableStatus.append(
      ui.emptyState("··", "没有匹配的曲目", "当前搜索或筛选条件下没有结果，试试放宽条件。", [
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
    nodes.tableWrap.hidden = true;
    return;
  }
  nodes.tableWrap.hidden = false;
}

function renderTable() {
  ui.clear(nodes.tbody);
  const rows = state.tracks.items;
  const fragment = document.createDocumentFragment();

  rows.forEach((row, index) => {
    const tr = ui.el("tr", { dataset: { id: row.id } });
    if (isSelected(row.id)) tr.setAttribute("aria-selected", "true");
    if (index < 12) {
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
      ui.el("td", {}, [ui.coverThumb(row, { size: 48 })]),
      ui.el("td", {}, [
        ui.el("span", {
          class: "truncate cell-title",
          title: row.path || row.filename || "",
          text: row.title || "（无标题）",
        }),
      ]),
      ui.el("td", {}, [
        ui.el("span", { class: "truncate", title: row.artist || "无歌手", text: row.artist || "—" }),
      ]),
      ui.el("td", {}, [ui.el("span", { class: "truncate", title: row.album || "无专辑", text: row.album || "—" })]),
      ui.el("td", { class: "num", text: row.year || "—" }),
      ui.el("td", { class: "num", text: row.track || "—" }),
      ui.el("td", {}, [ui.el("span", { class: "truncate", text: row.language || "—" })]),
      ui.el("td", {}, [ui.el("span", { class: "truncate", text: row.albumtype || "—" })]),
      ui.el("td", {}, [
        ui.el("span", {
          class: "truncate path-cell",
          title: row.path || row.filename || "",
          text: row.filename || "",
        }),
      ]),
      ui.el("td", {}, [
        ui.el("button", {
          type: "button",
          class: "btn btn-sm",
          text: "编辑",
          dataset: { editId: String(row.id) },
          "aria-label": `编辑 ${row.title || row.filename || row.id} 的元数据`,
        }),
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
  nodes.checkPage.checked = rows.length > 0 && selected === rows.length;
  nodes.checkPage.indeterminate = selected > 0 && selected < rows.length;
  nodes.checkPage.disabled = rows.length === 0;
}

function renderSelectionBar() {
  ui.clear(nodes.selectionBar);
  const count = selectionCount();
  nodes.editSelected.disabled = count === 0;
  if (!count) {
    nodes.selectionBar.hidden = true;
    return;
  }
  nodes.selectionBar.hidden = false;
  const rows = selectionRows().slice(0, 6);
  nodes.selectionBar.append(
    ui.el("span", { class: "lbl", style: { marginBottom: "0" }, text: `已选 ${count} 首` }),
    ...rows.map((row) =>
      ui.el("span", { class: "chip", title: row.path || row.filename }, [
        ui.el("span", { class: "truncate", style: { maxWidth: "180px" }, text: row.title || row.filename || String(row.id) }),
      ]),
    ),
    count > rows.length ? ui.el("span", { class: "hint", text: `…等 ${count} 首` }) : "",
    ui.el("div", { class: "spacer" }),
    ui.el("button", {
      type: "button",
      class: "btn btn-sm btn-primary",
      text: "编辑已选",
      onClick: () => openEdit(selectionRows()),
    }),
    ui.el("button", { type: "button", class: "btn btn-sm", text: "清空选择", onClick: () => clearSelection() }),
  );
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
  nodes.scanBtn.disabled = true;
  nodes.scanBtn.textContent = "扫描中…";
  const progress = ui.createProgress(nodes.scanProgress, {
    label: fast ? "快速扫描（只建索引）" : full ? "全量扫描" : "扫描",
  });
  try {
    const { job_id: jobId } = await api.scan({ full, prune, fast });
    const job = await pollJob(jobId, { onTick: (tick) => progress.update(tick) });
    progress.finish(job);
    if (job.state === "error") {
      ui.toast("err", "扫描失败", job.error || "后端任务出错");
    } else {
      let summary = "";
      try {
        const result = JSON.parse(job.result || "{}");
        summary = `扫描 ${result.scanned ?? 0} 个文件（新增 ${result.added ?? 0}，更新 ${result.updated ?? 0}，跳过 ${result.skipped ?? 0}，移除 ${result.removed ?? 0}）`;
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
    nodes.scanBtn.textContent = "扫描曲库";
    emit("status:refresh");
    await refresh();
    emit("jobs:refresh");
  }
}

/* ------------------------------------------------------- 编辑 + 预览确认 */

/** 载入文件里现有的歌词（只读；失败也不影响编辑其它字段）。 */
async function loadLyrics(trackId) {
  const rowId = Number(trackId);
  if (!rowId || !nodes.editLyrics) return;
  if (nodes.editLyricsHint) nodes.editLyricsHint.textContent = "正在读取文件里的歌词…";
  try {
    const data = await api.trackLyrics(rowId);
    // 期间可能已经关了面板或换了曲目：只认当前这一首
    const current = state.edit.rows[0];
    if (!state.edit.open || !current || Number(current.id) !== rowId) return;
    lyricsBase = data.lyrics || "";
    nodes.editLyrics.value = lyricsBase;
    if (nodes.editLyricsHint) {
      nodes.editLyricsHint.textContent = data.has_lyrics
        ? `文件里现有 ${data.lines} 行 · ${data.chars} 字（改了才会写入；清空 = 不改动）`
        : "这个文件当前没有歌词：写进去后点「预览变更」，确认才会落盘。";
    }
  } catch (err) {
    if (nodes.editLyricsHint) {
      nodes.editLyricsHint.textContent = `读取现有歌词失败：${err.message}（留空表示不改动歌词）`;
    }
  }
}

function openEdit(rows) {
  if (!rows || !rows.length) return;
  state.edit.rows = rows.map((row) => ({ ...row }));
  state.edit.open = true;
  editTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  nodes.drawerResult.replaceChildren();
  EDIT_FIELDS.forEach((key) => {
    const input = ui.byId(`edit-${key}`);
    if (input) input.value = "";
  });
  // 歌词：先清空，再载入文件里现有的（多选时留空 = 不改动歌词）
  lyricsBase = "";
  if (nodes.editLyrics) nodes.editLyrics.value = "";
  if (nodes.editLyricsHint) {
    nodes.editLyricsHint.textContent =
      "打开面板时会自动载入文件里现有的歌词；改了才会写入，清空 = 不改动（歌词不受「覆盖已有值」影响）。";
  }
  if (state.edit.rows.length === 1) loadLyrics(state.edit.rows[0].id);
  const first = state.edit.rows[0];
  ui.setText(nodes.drawerScope, rows.length === 1 ? `1 首：${first.title || first.filename}` : `${rows.length} 首`);
  nodes.drawerScope.title = rows.length === 1 ? first.path || "" : rows.map((row) => row.title || row.filename).join("\n");
  nodes.drawer.dataset.open = "true";
  // 抽屉头也用这张封面做色晕（.drawer-head::before 读 --art）
  nodes.drawer.style.setProperty(
    "--art",
    first.has_cover ? `url("/api/tracks/${first.id}/cover?size=64")` : "none",
  );
  nodes.drawer.setAttribute("aria-hidden", "false");
  nodes.drawer.inert = false;
  // 等一帧：抽屉用 visibility 过渡，切换当帧直接 focus 有概率落空
  const focusTarget = ui.byId("edit-title");
  if (focusTarget) requestAnimationFrame(() => focusTarget.focus());
}

function closeEdit() {
  state.edit.open = false;
  nodes.drawer.dataset.open = "false";
  nodes.drawer.setAttribute("aria-hidden", "true");
  nodes.drawer.inert = true;
  if (editTrigger && editTrigger.isConnected) editTrigger.focus();
  editTrigger = null;
}

function collectFields() {
  const fields = {};
  EDIT_FIELDS.forEach((key) => {
    const input = ui.byId(`edit-${key}`);
    if (!input) return;
    const value = input.value.trim();
    if (value !== "") fields[key] = value;
  });
  // 歌词：只有改动过才带上（基线是打开面板时从文件里读回来的那份）
  const lyrics = nodes.editLyrics ? nodes.editLyrics.value : "";
  if (lyrics.trim() !== "" && lyrics !== lyricsBase) fields.lyrics = lyrics;
  return fields;
}

async function runPreview() {
  const ids = state.edit.rows.map((row) => Number(row.id)).filter(Boolean);
  if (!ids.length) return;
  const fields = collectFields();
  if (!Object.keys(fields).length) {
    ui.toast("warn", "还没有填写要修改的字段", "留空的字段表示保持原值不变。");
    return;
  }
  const normalize = nodes.editNormalize.checked;
  const overwrite = nodes.editOverwrite.checked;
  state.edit.busy = true;
  nodes.drawerPreview.disabled = true;
  nodes.drawerPreview.textContent = "预览中…";
  ui.clear(nodes.drawerResult);
  nodes.drawerResult.append(ui.loadingLine("正在读取文件内的现值…（只读，不改动文件）"));
  try {
    const preview = await api.previewTracks({ ids, fields, normalize_artist: normalize });
    ui.clear(nodes.drawerResult);
    const changed = preview.changed_fields || 0;
    nodes.drawerResult.append(
      ui.notice(
        changed ? "info" : "warn",
        changed
          ? `预览完成：${preview.items.length} 首曲目、合计 ${changed} 处变更。尚未写入任何文件。`
          : "预览完成：所选字段与文件里的现值完全一致，执行不会产生任何写入。",
      ),
    );
    const body = ui.diffView(preview.items || []);
    body.push(
      ui.el("div", { class: "hint" }, [
        `将写入字段：${Object.keys(preview.fields || fields).map(ui.fieldLabel).join("、")}`,
        overwrite ? "；已勾选覆盖已有值" : "；未勾选覆盖，已有非空值的字段会被跳过",
      ]),
    );
    const answer = await ui.openDialog({
      title: `变更预览（${ids.length} 首）`,
      subtitle: "旧值红色、新值绿色；确认后才会写入音频标签",
      body,
      actions: [
        { id: "cancel", label: "取消" },
        { id: changed ? "apply" : "apply", label: changed ? `确认写入 ${ids.length} 首` : `仍然执行（0 处变更）`, variant: "btn-primary" },
      ],
    });
    if (answer !== "apply") {
      nodes.drawerResult.append(ui.notice("info", "已取消，未写入任何文件。"));
      return;
    }
    await applyChanges(ids, fields, normalize, overwrite);
  } catch (err) {
    ui.clear(nodes.drawerResult);
    nodes.drawerResult.append(ui.notice("err", `预览失败：${err.message}`));
    ui.toast("err", "预览失败", err.message);
  } finally {
    state.edit.busy = false;
    nodes.drawerPreview.disabled = false;
    nodes.drawerPreview.textContent = "预览变更";
  }
}

async function applyChanges(ids, fields, normalize, overwrite) {
  ui.clear(nodes.drawerResult);
  nodes.drawerResult.append(ui.loadingLine("正在写入标签…"));
  try {
    const result = await api.applyTracks({ ids, fields, normalize_artist: normalize, overwrite });
    const failed = result.failed || [];
    ui.clear(nodes.drawerResult);
    nodes.drawerResult.append(
      ui.el("div", { class: "lbl", text: "写入结果" }),
      ui.resultBlock({
        summary: [
          { label: "成功", value: result.written ?? 0, variant: "chip" },
          { label: "失败", value: failed.length, variant: failed.length ? "chip" : "chip" },
          { label: "字段", value: (result.fields || []).length },
        ],
        failures: failed.map((item) => ({
          who: item.path || `#${item.track_id}`,
          why: item.error || "未知错误",
        })),
        failuresTitle: "失败明细（这些文件没有被改动）",
      }),
    );
    if (failed.length) {
      ui.toast("warn", `写入完成，但有 ${failed.length} 首失败`, "失败原因已列在编辑面板里。");
    } else {
      ui.toast("ok", `已写入 ${result.written ?? 0} 首`, `字段：${(result.fields || []).map(ui.fieldLabel).join("、")}`);
    }
    removeFromSelection(ids.filter((id) => !failed.some((item) => Number(item.track_id) === Number(id))));
    emit("status:refresh");
    await refresh();
  } catch (err) {
    ui.clear(nodes.drawerResult);
    nodes.drawerResult.append(ui.notice("err", `写入失败：${err.message}`));
    ui.toast("err", "写入失败", err.message);
  }
}

export function invalidateSelectionCount() {
  renderSelectionBar();
  syncPageCheckbox();
}
