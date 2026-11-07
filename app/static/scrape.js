/**
 * 页签 2：搜索刮削。
 *
 * 三栏工作台：左侧选曲 → 中间候选 → 右侧写入面板；下方是批量刮削。
 * 所有写入都是「先算差异（/api/tracks/preview 只读） → 确认 → /api/scrape/apply」。
 * 批量刮削有两个模式，避免「0 阈值」在界面上被误解：
 *  - 仅搜索：由前端逐首调用 /api/search 汇总候选，**不写任何文件**
 *  - 自动写入：走后端 /api/scrape/batch 后台任务，按最低分阈值写入（批量为不可逐首预览，故额外二次确认）
 */

import { api, pollJob } from "./api.js";
import * as ui from "./ui.js";
import { initReviewQueue } from "./review-queue.js";
import {
  state,
  on,
  emit,
  selectionIds,
  selectionCount,
  clearSelection,
  toggleSelect,
  isSelected,
  setCurrentTrack,
  currentTrackRow,
  updateTrackSnapshot,
} from "./store.js";

const WRITE_FIELDS = [
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
  "mb_artist_id",
  "release_group_id",
];

const DEFAULT_WRITE_FIELDS = ["title", "artist", "album", "albumartist", "genre", "year", "albumtype"];

let nodes = null;
let batchAbort = false;
let fetchedLyrics = null;
// 用户在写入面板里手动改过勾选后，设置页的值就不再覆盖它们
let panelTouched = false;
// 用户对「写封面」的意愿（null = 还没表达过）；候选没有封面时会临时取消勾选
let coverWanted = null;
// A search result belongs to the current-track identity captured at its start.
// Object identity also rejects A → B → A and same-track replacement searches.
let activeSearchScope = null;
let candidateScope = null;
let observedTrackId = null;
let choiceRevision = 0;
let lyricsRevision = 0;
let lyricsBusy = false;
let pendingWrite = null;
let pickRevision = 0;
const REVIEW_MAX = 200;
const REVIEW_TTL = 30 * 60 * 1000;
const REVIEW_BYTES = 16 * 1024 * 1024;
const REVIEW_ENTRY_BYTES = 2 * 1024 * 1024;
let reviewQueue = null;
let reviewRun = null;
let reviewGeneration = 0;
let reviewActiveId = null;
let reviewOpenRevision = 0;
let sessionUsable = true;
let automaticBatchBusy = false;

function currentTrackId() {
  const id = Number(state.currentTrackId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isCurrentScope(scope) {
  if (!sessionUsable || !scope || scope !== activeSearchScope || scope.currentId !== currentTrackId()) return false;
  if (!scope.review) return true;
  const { run, entry, attempt } = scope.review;
  return run === reviewRun && entry.attempt === attempt && entry.status === "ready"
    && Boolean(entry.response) && Date.now() - entry.searchedAt < REVIEW_TTL;
}

function chosenCandidate() {
  return isCurrentScope(candidateScope) ? state.scrape.candidates[state.scrape.chosenIndex] : null;
}

function captureChoice() {
  const candidate = chosenCandidate();
  return candidate ? { scope: candidateScope, candidate, revision: choiceRevision } : null;
}

function isCurrentChoice(choice) {
  if (!choice || !isCurrentScope(choice.scope) || choice.scope !== candidateScope
      || choice.revision !== choiceRevision || choice.candidate !== chosenCandidate()) return false;
  const row = currentTrackRow();
  return Boolean(row && choice.scope.trackId !== null && Number(row.id) === choice.scope.trackId);
}

function syncSingleControls() {
  const choice = captureChoice();
  const writable = isCurrentChoice(choice);
  nodes.searchBtn.disabled = state.scrape.searching;
  nodes.searchBtn.textContent = state.scrape.searching ? "搜索中…" : "搜索候选";
  nodes.applyBtn.disabled = !writable || lyricsBusy || Boolean(pendingWrite);
  nodes.applyBtn.textContent = pendingWrite
    ? pendingWrite.submitted ? "正在写入…" : "预览中…"
    : "预览差异并写入";
  nodes.applyBtn.title = writable ? "" : "请为当前曲目重新搜索并选择候选后再写入";
  nodes.lyricsTry.disabled = !writable || lyricsBusy || Boolean(pendingWrite);
  nodes.lyricsTry.textContent = lyricsBusy ? "试抓中…" : "试抓歌词";
  renderReviewContext();
}

function invalidateCandidates(message = "") {
  activeSearchScope = null;
  candidateScope = null;
  choiceRevision += 1;
  lyricsRevision += 1;
  lyricsBusy = false;
  fetchedLyrics = null;
  // Submitted writes must finish against their captured target. An obsolete
  // preview can be discarded immediately so the new track remains usable.
  if (pendingWrite && !pendingWrite.submitted) pendingWrite = null;
  state.scrape.searching = false;
  state.scrape.searched = false;
  state.scrape.candidates = [];
  state.scrape.sourceStatus = [];
  state.scrape.chosenIndex = -1;
  state.scrape.chosenFields = new Set();
  state.scrape.error = "";
  ui.clear(nodes.searchState);
  ui.clear(nodes.result);
  if (message) nodes.searchState.append(ui.notice("info", message));
  renderCandidates();
  renderSourceStatus();
  renderWritePanel();
}

export function init() {
  nodes = {
    srcChips: ui.byId("src-chips"),
    srcCount: ui.byId("src-count"),
    srcAll: ui.byId("src-all"),
    srcNone: ui.byId("src-none"),
    srcDefault: ui.byId("src-default"),

    pickQ: ui.byId("pick-q"),
    pickList: ui.byId("pick-list"),
    pickPager: ui.byId("pick-pager"),
    pickTotal: ui.byId("pick-total"),

    keyword: ui.byId("search-keyword"),
    artistHint: ui.byId("search-artist"),
    limit: ui.byId("search-limit"),
    searchBtn: ui.byId("btn-search"),
    searchState: ui.byId("search-state"),
    sourceStatus: ui.byId("source-status"),
    candList: ui.byId("cand-list"),
    candCount: ui.byId("cand-count"),
    candHidden: ui.byId("cand-hidden"),

    writeTarget: ui.byId("write-target"),
    writeCandidate: ui.byId("write-candidate"),
    writeFields: ui.byId("write-fields"),
    writeCover: ui.byId("write-cover"),
    writeLyrics: ui.byId("write-lyrics"),
    lyricsBox: ui.byId("write-lyrics-box"),
    lyricsMeta: ui.byId("write-lyrics-meta"),
    lyricsText: ui.byId("write-lyrics-text"),
    lyricsTry: ui.byId("btn-lyrics-try"),
    writeNormalize: ui.byId("write-normalize"),
    writeOverwrite: ui.byId("write-overwrite"),
    applyBtn: ui.byId("btn-scrape-apply"),
    writeAll: ui.byId("btn-write-all"),
    writeNone: ui.byId("btn-write-none"),
    result: ui.byId("scrape-result"),

    batchCount: ui.byId("batch-count"),
    batchUseCurrent: ui.byId("batch-use-current"),
    batchClear: ui.byId("batch-clear"),
    batchLimit: ui.byId("batch-limit"),
    batchThreshold: ui.byId("batch-threshold"),
    batchThresholdHint: ui.byId("batch-threshold-hint"),
    batchFields: ui.byId("batch-fields"),
    batchCover: ui.byId("batch-cover"),
    batchLyrics: ui.byId("batch-lyrics"),
    batchRun: ui.byId("btn-batch-run"),
    batchProgress: ui.byId("batch-progress"),
    batchResult: ui.byId("batch-result"),
    reviewContext: ui.byId("review-context"),
    reviewNavigation: ui.byId("review-navigation"),
  };

  const debouncedPick = ui.debounce(() => {
    state.scrape.pickQ = nodes.pickQ.value.trim();
    state.scrape.pickPage = 1;
    refreshPick();
  }, 300);
  nodes.pickQ.addEventListener("input", debouncedPick);

  nodes.srcAll.addEventListener("click", () => {
    state.sourceChoice = new Set(state.sources.map((source) => source.name));
    renderSources();
  });
  nodes.srcNone.addEventListener("click", () => {
    state.sourceChoice = new Set();
    renderSources();
  });
  nodes.srcDefault.addEventListener("click", () => {
    state.sourceChoice = new Set(state.sources.filter((source) => source.default_on).map((source) => source.name));
    renderSources();
  });

  nodes.searchBtn.addEventListener("click", runSearch);
  nodes.keyword.addEventListener("keydown", (event) => {
    if (event.key === "Enter") runSearch();
  });
  nodes.artistHint.addEventListener("keydown", (event) => {
    if (event.key === "Enter") runSearch();
  });

  nodes.writeAll.addEventListener("click", () => {
    nodes.writeFields.querySelectorAll("input[type=checkbox]:not(:disabled)").forEach((input) => {
      input.checked = true;
    });
    syncChosenFieldsFromDom();
  });
  nodes.writeNone.addEventListener("click", () => {
    nodes.writeFields.querySelectorAll("input[type=checkbox]").forEach((input) => {
      input.checked = false;
    });
    syncChosenFieldsFromDom();
  });
  nodes.writeFields.addEventListener("change", syncChosenFieldsFromDom);
  nodes.applyBtn.addEventListener("click", previewAndWrite);
  // 勾选框一改，预览里的说明也跟着变（否则「勾了写歌词」看不到任何反馈）
  nodes.writeLyrics.addEventListener("change", renderWritePanel);

  // 面板里改过这几项之后，设置页的值不再覆盖它们；另外记住「写封面」的意愿，
  // 换成没有封面的候选时会临时取消勾选，换回来要恢复
  nodes.writeCover.addEventListener("change", () => {
    panelTouched = true;
    coverWanted = nodes.writeCover.checked;
  });
  [nodes.writeLyrics, nodes.writeOverwrite, nodes.writeNormalize].forEach((box) => {
    box.addEventListener("change", () => {
      panelTouched = true;
    });
  });
  nodes.lyricsTry.addEventListener("click", tryFetchLyrics);

  nodes.batchUseCurrent.addEventListener("click", () => {
    const row = currentTrackRow();
    if (!row) {
      ui.toast("warn", "还没有当前曲目", "先在左上角的列表里点一首歌。");
      return;
    }
    toggleSelect(row, true);
    renderPick();
  });
  nodes.batchClear.addEventListener("click", () => clearSelection());
  document.querySelectorAll("input[name=batch-mode]").forEach((radio) => {
    radio.addEventListener("change", syncBatchMode);
  });
  nodes.batchRun.addEventListener("click", runBatch);

  renderBatchFields();
  syncBatchMode();
  reviewQueue = initReviewQueue({
    host: ui.byId("review-queue-root"), maxItems: REVIEW_MAX,
    onOpen: openReviewEntry, onRetry: retryReviewEntry, onSkip: skipReviewEntry,
    onClear: () => clearReviewQueue(), onStop: () => stopReviewSearch(),
  });
  for (const [id, mode] of [["scrape-library-tab", "library"], ["scrape-review-tab", "review"]]) {
    const button = ui.byId(id);
    button.addEventListener("click", () => showPicker(mode));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? "library" : event.key === "End" ? "review" : mode === "review" ? "library" : "review";
      showPicker(next);
      ui.byId(next === "review" ? "scrape-review-tab" : "scrape-library-tab").focus();
    });
  }
  window.setInterval(expireReviewEntries, 30000);

  on("selection:changed", () => {
    renderBatchCount();
    renderPick();
  });
  on("current:changed", () => {
    const nextId = currentTrackId();
    if (nextId !== observedTrackId) {
      observedTrackId = nextId;
      reviewOpenRevision += 1;
      reviewActiveId = null;
      invalidateCandidates("当前曲目已切换，请重新搜索并选择候选。");
      syncReviewQueue();
    }
    renderPick();
    syncSearchFields();
  });
  on("current:updated", (row) => {
    const review = activeSearchScope?.review;
    if (review && review.entry.status === "ready" && (String(row.title || "") !== review.entry.baseline.title || String(row.artist || "") !== review.entry.baseline.artist)) {
      dropReviewResponse(review.run, review.entry);
      review.entry.status = "expired";
      review.entry.detail = "曲目标题或歌手已更新，请重新搜索。";
      invalidateCandidates(review.entry.detail);
      syncReviewQueue();
    }
    syncSearchFields();
  });
  observedTrackId = currentTrackId();
  window.addEventListener("metatidy:unauthorized", () => {
    sessionUsable = false;
    clearReviewQueue();
    invalidateCandidates();
    setCurrentTrack(null);
  });
}

/* ------------------------------------------------------------- 数据源 */

export function onSources(sources) {
  state.sources = sources || [];
  if (!state.sourceChoice.size) {
    const fromSettings = (state.settings && state.settings.values && state.settings.values.enabled_sources) || [];
    const valid = new Set(state.sources.map((source) => source.name));
    const preset = fromSettings.filter((name) => valid.has(name));
    state.sourceChoice = new Set(preset.length ? preset : state.sources.filter((source) => source.default_on).map((source) => source.name));
  }
  renderSources();
}

function renderSources() {
  ui.clear(nodes.srcChips);
  const unavailable = [];
  state.sources.forEach((source) => {
    const pressed = state.sourceChoice.has(source.name);
    if (pressed && source.status === "不可用") unavailable.push(source.label);
    const title = [
      source.label,
      `状态：${source.status}`,
      source.needs_key ? `需要密钥：${source.needs_key}（未配置时该源会返回错误）` : "无需密钥",
    ].join("\n");
    nodes.srcChips.append(
      ui.el(
        "button",
        {
          type: "button",
          class: "chip-toggle",
          "aria-pressed": pressed ? "true" : "false",
          dataset: { status: source.status },
          title,
          onClick: () => {
            if (state.sourceChoice.has(source.name)) state.sourceChoice.delete(source.name);
            else state.sourceChoice.add(source.name);
            renderSources();
          },
        },
        [
          ui.el("span", { class: "dot", "aria-hidden": "true" }),
          ui.el("span", { class: "name", text: source.label }),
          ui.el("span", { class: "badge badge-mute", text: source.status }),
        ],
      ),
    );
  });
  ui.setText(nodes.srcCount, `已选 ${state.sourceChoice.size} / ${state.sources.length}`);
  if (unavailable.length) {
    nodes.srcChips.append(
      ui.el("span", { class: "hint hint-warn", text: `已勾选的 ${unavailable.join("、")} 当前不可用，搜索时只会返回错误信息。` }),
    );
  }
}

/* ------------------------------------------------------------- 选曲 */

export async function refreshPick() {
  const revision = ++pickRevision;
  state.scrape.loadingPick = true;
  const params = {
    q: state.scrape.pickQ,
    page: state.scrape.pickPage,
    page_size: state.scrape.pickPageSize,
    sort: "artist",
    order: "asc",
  };
  try {
    const data = await api.tracks(params);
    if (revision !== pickRevision) return;
    state.scrape.pickItems = data.items || [];
    state.scrape.pickTotal = data.total || 0;
    state.scrape.pickPages = data.pages || 1;
    state.scrape.pickPage = data.page || 1;
    const current = state.scrape.pickItems.find((row) => Number(row.id) === currentTrackId());
    if (current) updateTrackSnapshot(current, { partial: true });
  } catch (err) {
    if (revision !== pickRevision) return;
    state.scrape.pickItems = [];
    state.scrape.pickTotal = 0;
    state.scrape.pickPages = 1;
    ui.toast("err", "读取曲目失败", err.message);
  } finally {
    if (revision === pickRevision) state.scrape.loadingPick = false;
  }
  renderPick();
  syncSearchFields();
  syncSingleControls();
}

function renderPick() {
  ui.clear(nodes.pickList);
  ui.setText(nodes.pickTotal, `共 ${ui.fmtNum(state.scrape.pickTotal)} 首`);

  if (!state.scrape.pickItems.length) {
    nodes.pickList.append(
      ui.emptyState("search", state.scrape.pickQ ? "没有匹配的曲目" : "曲库还没有曲目", state.scrape.pickQ ? "换个关键词试试。" : "先到「曲库」页扫描一次。"),
    );
    ui.clear(nodes.pickPager);
    return;
  }

  const fragment = document.createDocumentFragment();
  state.scrape.pickItems.forEach((row) => {
    const isCurrent = Number(state.currentTrackId) === Number(row.id);
    const checkbox = ui.el("input", {
      type: "checkbox",
      checked: isSelected(row.id),
      "aria-label": `批量选择 ${row.title || row.filename}`,
    });
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => toggleSelect(row, checkbox.checked));

    const marks = [];
    if (!row.has_cover) marks.push(ui.el("span", { class: "badge badge-mute", text: "缺封面" }));
    if (!row.has_lyrics) marks.push(ui.el("span", { class: "badge badge-mute", text: "缺歌词" }));

    const node = ui.el(
      "div",
      {
        class: "pick-row",
        role: "button",
        tabindex: "0",
        "aria-current": isCurrent ? "true" : "false",
        title: row.path || "",
        onClick: () => setCurrentTrack(row),
        onKeydown: (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setCurrentTrack(row);
          }
        },
      },
      [
        checkbox,
        ui.el("div", { style: { minWidth: 0 } }, [
          ui.el("div", { class: "nm", text: row.title || row.filename || `#${row.id}` }),
          ui.el("div", { class: "sub", text: `${row.artist || "无歌手"} · ${row.album || "无专辑"}` }),
        ]),
        ui.el("div", { class: "marks" }, marks),
      ],
    );
    fragment.append(node);
  });
  nodes.pickList.append(fragment);

  ui.clear(nodes.pickPager);
  const { pickPage: page, pickPages: pages } = state.scrape;
  nodes.pickPager.append(
    ui.el("button", {
      type: "button",
      class: "btn btn-sm",
      text: "上一页",
      disabled: page <= 1,
      onClick: () => {
        state.scrape.pickPage = Math.max(1, page - 1);
        refreshPick();
      },
    }),
    ui.el("button", {
      type: "button",
      class: "btn btn-sm",
      text: "下一页",
      disabled: page >= pages,
      onClick: () => {
        state.scrape.pickPage = Math.min(pages, page + 1);
        refreshPick();
      },
    }),
    ui.el("span", { class: "pageno", text: `${page} / ${pages || 1}` }),
  );
}

function syncSearchFields() {
  const row = currentTrackRow();
  nodes.candHidden.textContent = row
    ? `当前曲目：${row.artist || "无歌手"} - ${row.title || row.filename}`
    : "未设当前曲目：可只填关键词直接搜索（此时没有分数与置信度）";
}

/* ------------------------------------------------------------- 搜索 */

async function runSearch() {
  if (!sessionUsable) return;
  const keyword = nodes.keyword.value.trim();
  const artistHint = nodes.artistHint.value.trim();
  const row = currentTrackRow();
  if (!row && !keyword) {
    ui.toast("warn", "缺少搜索关键词", "关键词留空时用当前曲目的标题，所以先选一首歌或填一个关键词。");
    return;
  }
  if (!state.sourceChoice.size) {
    ui.toast("warn", "还没有选择数据源", "至少勾选一个数据源再搜索。");
    return;
  }
  const limit = Math.max(1, Math.min(10, Number(nodes.limit.value) || 3));
  const queued = reviewRun?.entries.find((entry) => entry.trackId === reviewActiveId && entry.trackId === Number(row?.id));
  if (queued) {
    await retryReviewEntry(reviewPayload(queued), { keyword, artistHint, limit, sources: [...state.sourceChoice] });
    return;
  }
  reviewOpenRevision += 1;
  reviewActiveId = null;
  syncReviewQueue();
  invalidateCandidates();
  const scope = { currentId: currentTrackId(), trackId: row ? Number(row.id) : null };
  activeSearchScope = scope;
  state.scrape.searching = true;
  syncSingleControls();
  nodes.searchState.append(
    ui.loadingLine(`正在并发查询 ${state.sourceChoice.size} 个数据源（每源最多 ${limit} 条，慢源最多等 20 秒）…`),
  );
  try {
    const result = await api.search({
      track_id: row ? Number(row.id) : null,
      keyword,
      artist_hint: artistHint,
      sources: [...state.sourceChoice],
      limit,
    });
    if (!isCurrentScope(scope)) return;
    candidateScope = scope;
    state.scrape.candidates = result.candidates || [];
    state.scrape.sourceStatus = result.source_status || [];
    state.scrape.searched = true;
    state.scrape.error = "";
    ui.clear(nodes.searchState);
    const okSources = state.scrape.sourceStatus.filter((item) => item.count > 0).length;
    nodes.searchState.append(
      ui.notice(
        state.scrape.candidates.length ? "ok" : "warn",
        state.scrape.candidates.length
          ? `命中 ${state.scrape.candidates.length} 个候选，来自 ${okSources} 个数据源。`
          : "没有命中任何候选：可以改关键词/歌手提示，或换几个数据源再试。",
      ),
    );
  } catch (err) {
    if (!isCurrentScope(scope)) return;
    state.scrape.candidates = [];
    state.scrape.sourceStatus = [];
    state.scrape.error = err.message;
    ui.clear(nodes.searchState);
    nodes.searchState.append(ui.notice("err", `搜索失败：${err.message}`));
  } finally {
    if (isCurrentScope(scope)) {
      state.scrape.searching = false;
      renderCandidates();
      renderSourceStatus();
      renderWritePanel();
    }
  }
}

function confidenceBadge(confidence) {
  const variant = confidence === "高" ? "badge-ok" : confidence === "中" ? "badge-accent" : "badge-mute";
  return ui.el("span", { class: `badge ${variant}`, text: confidence || "待确认" });
}

function renderSourceStatus() {
  ui.clear(nodes.sourceStatus);
  state.scrape.sourceStatus.forEach((item) => {
    const source = state.sources.find((entry) => entry.name === item.source);
    const label = source ? source.label : item.source;
    const variant = item.error ? "badge-err" : item.count > 0 ? "badge-ok" : "badge-mute";
    nodes.sourceStatus.append(
      ui.el("span", { class: `badge ${variant}`, title: item.error || `${label}：${item.count} 条`, text: `${label} ${item.count}` }),
    );
  });
}

function renderCandidates() {
  ui.clear(nodes.candList);
  ui.setText(nodes.candCount, String(state.scrape.candidates.length));
  if (!state.scrape.candidates.length) {
    nodes.candList.append(
      ui.el("div", { class: "hint", text: state.scrape.searched ? "这次搜索没有候选。" : "左侧选一首歌，然后点「搜索候选」。" }),
    );
    return;
  }
  state.scrape.candidates.forEach((cand, index) => {
    const chosen = state.scrape.chosenIndex === index;
    const cover = cand.cover
      ? ui.remoteCover(cand.cover, { size: 64, label: `${cand.source} 提供的封面` })
      : ui.el("span", { class: "thumb thumb-lg ph", text: "无" });
    const node = ui.el(
      "div",
      {
        class: "cand",
        // 给 CSS 一层专辑封面色晕（.cand::before 读 --art）
        style: { "--art": cand.cover ? `url("${cand.cover}")` : "none" },
        role: "button",
        tabindex: "0",
        "aria-pressed": chosen ? "true" : "false",
        onClick: () => chooseCandidate(index),
        onKeydown: (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            chooseCandidate(index);
          }
        },
      },
      [
        ui.el("div", { class: "cand-cover" }, [cover, ui.el("span", { class: "cap", text: cand.source || "" })]),
        ui.el("div", { class: "cand-main" }, [
          ui.el("div", { class: "cand-title", title: cand.title || "", text: cand.title || "（无标题）" }),
          ui.el("div", { class: "cand-meta", text: [cand.artist, cand.album, cand.year].filter(Boolean).join(" · ") || "—" }),
          cand.context ? ui.el("div", { class: "cand-ctx", text: cand.context }) : null,
          ui.el("div", { class: "row tight" }, [
            cand.track ? ui.el("span", { class: "badge badge-mute", text: `轨 ${cand.track}` }) : null,
            cand.disc ? ui.el("span", { class: "badge badge-mute", text: `碟 ${cand.disc}` }) : null,
            cand.language ? ui.el("span", { class: "badge badge-mute", text: cand.language }) : null,
            cand.albumtype ? ui.el("span", { class: "badge badge-mute", text: cand.albumtype }) : null,
            cand.duration ? ui.el("span", { class: "badge badge-mute", text: ui.fmtDuration(cand.duration) }) : null,
            cand.lyrics ? ui.el("span", { class: "badge badge-info", text: "含歌词" }) : null,
          ]),
        ]),
        ui.el("div", { class: "cand-side" }, [
          confidenceBadge(cand.confidence),
          ui.el("span", { class: "badge badge-mono", title: "后端打分（标题/歌手/时长/专辑加权）", text: `分 ${cand.score}` }),
          ui.el("span", { class: "badge badge-mute", text: chosen ? "已选为写入来源" : "点击选用" }),
        ]),
      ],
    );
    nodes.candList.append(node);
  });
}

function chooseCandidate(index) {
  if (!isCurrentScope(candidateScope) || !state.scrape.candidates[index]) return;
  choiceRevision += 1;
  lyricsRevision += 1;
  lyricsBusy = false;
  if (pendingWrite && !pendingWrite.submitted) pendingWrite = null;
  ui.clear(nodes.result);
  state.scrape.chosenIndex = index;
  fetchedLyrics = null; // 换了候选，之前试抓的那一份就不能再用了
  const cand = state.scrape.candidates[index] || {};
  const preset = new Set();
  DEFAULT_WRITE_FIELDS.forEach((field) => {
    if (cand[field]) preset.add(field);
  });
  state.scrape.chosenFields = preset;
  renderCandidates();
  renderWritePanel();
  if (reviewActiveId !== null && matchMedia("(max-width: 700px)").matches) {
    ui.byId("scrape-write-card").scrollIntoView({ block: "start", behavior: "instant" });
    nodes.applyBtn.focus({ preventScroll: true });
  }
}

/** 歌词预览面板（常显：标题 + 说明/统计 + 「试抓歌词」按钮；有歌词时摊开全文）。
 *
 * 为什么要它：原来只能勾「写歌词」却看不到会写进去什么，等于盲勾；候选本身不带歌词时，
 * 还能用「试抓歌词」先让后端按标题/歌手查一次看看能不能抓到。
 *
 *
 * - 候选自带歌词 → 直接展示（行数 / 字数 + 全文）；
 * - 候选不带歌词 → 说明可以点「试抓歌词」让后端按标题/歌手去查（不假装有）；
 * - 写入完成后 → 有本次提交的歌词正文时展示；只有写入标志时提示到曲目详情读取。 */
function renderLyricsPreview(cand, { written = false, source = "" } = {}) {
  const box = nodes.lyricsBox;
  if (!box) return;
  box.hidden = false;
  box.style.display = "";
  const text = String((cand && cand.lyrics) || "").trim();
  if (!text) {
    setLyricsBody(
      "",
      nodes.writeLyrics && nodes.writeLyrics.checked
        ? "候选不带歌词；点「试抓歌词」让后端按标题/歌手去查（网易云 → QQ → LRCLIB → 酷狗）"
        : "候选不带歌词；勾选「写歌词」后写入时后端会再查一次，或直接点「试抓歌词」",
    );
    return;
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "").length;
  const label = `${written ? "已写入 " : ""}${source ? `来自 ${source} · ` : ""}${lines} 行 · ${text.length} 字`;
  setLyricsBody(text, label);
}

/** 面板正文与说明。正文为空就把 <pre> 收起来（显隐同时走内联样式，防反代缓存旧 CSS）。 */
function setLyricsBody(text, meta) {
  nodes.lyricsMeta.textContent = meta;
  nodes.lyricsText.textContent = text;
  nodes.lyricsText.hidden = !text;
  nodes.lyricsText.style.display = text ? "" : "none";
}

/** 「试抓歌词」：不写文件，只按当前候选的标题/歌手去链路上查一次。 */
async function tryFetchLyrics() {
  const choice = captureChoice();
  if (!isCurrentChoice(choice)) {
    ui.toast("warn", "先选一个候选", "试抓用的是当前候选的标题/歌手（和写入时同一组关键词）。");
    return;
  }
  const cand = choice.candidate;
  const revision = ++lyricsRevision;
  lyricsBusy = true;
  fetchedLyrics = null;
  syncSingleControls();
  nodes.lyricsBox.hidden = false;
  nodes.lyricsBox.style.display = "";
  setLyricsBody("", "正在试抓…（网易云 → QQ → LRCLIB → 酷狗）");
  try {
    const res = await api.lyricsPreview({
      track_id: choice.scope.trackId,
      title: cand.title || "",
      artist: cand.artist || "",
      album: cand.album || "",
      duration: Number(cand.duration) || 0,
    });
    if (revision !== lyricsRevision || !isCurrentChoice(choice)) return;
    if (res.lyrics) {
      fetchedLyrics = {
        choice,
        text: res.lyrics,
        source: res.used === "曲目标签" ? `${res.source || "未知来源"}（按曲目标签查的）` : res.source || "",
      };
      // 候选的关键词查不到时后端会退回用曲目标签再查一次，这里把这件事说明白
      renderLyricsPreview(
        { lyrics: res.lyrics },
        {
          source: fetchedLyrics.source,
        },
      );
      ui.toast("ok", "抓到歌词（还没写入）", `${res.source || "未知来源"} · ${res.lines} 行 ${res.chars} 字`);
    } else {
      renderLyricsPreview({ lyrics: "" });
      ui.toast("warn", "没抓到歌词", res.detail || "四个源都没有结果");
    }
  } catch (err) {
    if (revision !== lyricsRevision || !isCurrentChoice(choice)) return;
    setLyricsBody("", (err && err.message) || "试抓失败");
    ui.toast("err", "试抓歌词失败", (err && err.message) || "");
  } finally {
    if (revision === lyricsRevision) {
      lyricsBusy = false;
      syncSingleControls();
    }
  }
}

function renderWritePanel() {
  const row = currentTrackRow();
  const cand = chosenCandidate();
  ui.clear(nodes.writeFields);

  if (!cand) {
    ui.setText(nodes.writeTarget, "未选候选");
    ui.clear(nodes.writeCandidate);
    nodes.writeCandidate.append(document.createTextNode("在中间列表里点一个候选，再勾选要写入的字段。"));
    nodes.writeCandidate.className = "hint";
    nodes.writeCover.disabled = true;
    nodes.lyricsBox.hidden = true;
    nodes.lyricsBox.style.display = "none";
    setLyricsBody("", "");
    syncSingleControls();
    return;
  }

  ui.setText(nodes.writeTarget, row ? `写入：${row.title || row.filename}` : "未选当前曲目");
  ui.clear(nodes.writeCandidate);
  nodes.writeCandidate.className = "";
  nodes.writeCandidate.append(
    ui.el("div", { class: "hint" }, [
      ui.el("span", { text: `来源 ${cand.source || "未知"} · ` }),
      ui.el("strong", { style: { color: "var(--fg)" }, text: cand.title || "（无标题）" }),
      ui.el("span", { text: ` — ${cand.artist || "无歌手"}${cand.album ? " · " + cand.album : ""}` }),
    ]),
  );

  const hasCoverUrl = Boolean(cand.cover);
  nodes.writeCover.disabled = !hasCoverUrl;
  if (!hasCoverUrl) {
    // 候选没有封面地址就写不了，只能先取消勾选；但记住用户原本的意愿，
    // 换到带封面的候选时恢复，免得把用户勾的选择静默清掉
    nodes.writeCover.checked = false;
    nodes.writeCover.parentElement.title = "这个候选项没有封面地址";
  } else {
    if (coverWanted !== null) nodes.writeCover.checked = coverWanted;
    nodes.writeCover.parentElement.title = "";
  }
  const hasLyrics = Boolean(cand.lyrics);
  if (!hasLyrics && !nodes.writeLyrics.checked) {
    nodes.writeLyrics.parentElement.title = "候选没有内嵌歌词，勾选后后端会按标题/歌手再查一次";
  }

  if (fetchedLyrics && isCurrentChoice(fetchedLyrics.choice)) {
    renderLyricsPreview({ lyrics: fetchedLyrics.text }, { source: fetchedLyrics.source });
  } else if (lyricsBusy) {
    setLyricsBody("", "正在试抓…（网易云 → QQ → LRCLIB → 酷狗）");
  } else renderLyricsPreview(cand);

  WRITE_FIELDS.forEach((field) => {
    const value = cand[field];
    const disabled = value === undefined || value === null || value === "";
    const checked = state.scrape.chosenFields.has(field) && !disabled;
    const input = ui.el("input", {
      type: "checkbox",
      checked,
      disabled,
      "aria-label": `写入字段 ${ui.fieldLabel(field)}`,
    });
    input.dataset.field = field;
    input.addEventListener("change", () => {
      if (input.checked) state.scrape.chosenFields.add(field);
      else state.scrape.chosenFields.delete(field);
    });
    nodes.writeFields.append(
      ui.el("label", { class: "check", title: disabled ? "该候选项没有这个字段" : `${ui.fieldLabel(field)}：${value}` }, [
        input,
        ui.el("span", { text: disabled ? `${ui.fieldLabel(field)}（无）` : `${ui.fieldLabel(field)} · ${value}` }),
      ]),
    );
  });

  syncSingleControls();
}

function syncChosenFieldsFromDom() {
  const next = new Set();
  nodes.writeFields.querySelectorAll("input[data-field]").forEach((input) => {
    if (input.checked && !input.disabled) next.add(input.dataset.field);
  });
  state.scrape.chosenFields = next;
}

/* ------------------------------------------------------- 单首写入（预览确认） */

async function previewAndWrite() {
  if (pendingWrite || lyricsBusy) return;
  expireReviewEntries();
  const choice = captureChoice();
  const row = currentTrackRow();
  if (!isCurrentChoice(choice) || !row) {
    ui.toast("warn", "候选已失效", "请为当前曲目重新搜索并选择候选。");
    syncSingleControls();
    return;
  }
  const cand = choice.candidate;
  // 「试抓歌词」抓到的那一份原样带进写入：后端优先用候选里的歌词，这样「你看到的」和
  // 「写进去的」是同一份（否则写入时后端会再抓一次，可能换一个版本）。
  const fetched = fetchedLyrics && isCurrentChoice(fetchedLyrics.choice) ? fetchedLyrics : null;
  const writeCand = fetched ? { ...cand, lyrics: fetched.text } : cand;
  syncChosenFieldsFromDom();

  const values = {};
  state.scrape.chosenFields.forEach((field) => {
    const value = cand[field];
    if (value !== undefined && value !== null && value !== "") values[field] = value;
  });
  const writeCover = nodes.writeCover.checked && Boolean(cand.cover);
  const writeLyrics = nodes.writeLyrics.checked;
  const normalize = nodes.writeNormalize.checked;
  const overwrite = nodes.writeOverwrite.checked;

  if (!Object.keys(values).length && !writeCover && !writeLyrics) {
    ui.toast("warn", "没有要写入的内容", "至少勾选一个字段，或勾选写封面 / 写歌词。");
    return;
  }

  const operation = { choice, submitted: false };
  pendingWrite = operation;
  const canContinue = () => pendingWrite === operation && isCurrentChoice(choice);
  syncSingleControls();
  ui.clear(nodes.result);
  try {
    const withCoverLyrics = [];
    if (writeCover) withCoverLyrics.push("封面");
    if (writeLyrics) withCoverLyrics.push("歌词");
    // 说明文字必须与实际勾选一致：没勾封面就不能出现「封面」，否则会被读成封面也会写。
    const noDiffWhy = [];
    if (writeCover) noDiffWhy.push("封面从数据源下载");
    if (writeLyrics) {
      noDiffWhy.push(
        fetched
          ? `歌词用你刚试抓的那一份（${fetched.source || "未知来源"}）`
          : "歌词取候选内容，候选没带就由后端再查一次",
      );
    }
    const coverHints = [];
    if (nodes.writeCover.checked && !cand.cover) {
      coverHints.push("勾了「写封面」，但这个候选没有封面地址，本次写不上封面。");
    } else if (!nodes.writeCover.checked && cand.cover) {
      coverHints.push("这个候选有封面地址，但没勾「写封面」，本次不会写封面。");
    }

    let body = [];
    let answer = "apply";
    if (Object.keys(values).length) {
      const preview = await api.previewTracks({ ids: [choice.scope.trackId], fields: values, normalize_artist: normalize, overwrite });
      if (!canContinue()) return;
      const target = Array.isArray(preview.items)
        ? preview.items.find((item) => Number(item?.track_id) === choice.scope.trackId) : null;
      if (!target) throw new Error("预览未包含当前曲目，可能已从曲库移除。请刷新曲库后重试；本次未写入。");
      if (target.file_exists === false) throw new Error("当前音乐文件不存在，请检查挂载或刷新曲库后重试；本次未写入。");
      if (target.current?.error) throw new Error(`无法读取当前文件的标签：${target.current.error}。本次未写入。`);
      body = ui.diffView([target]);
      const changed = Object.keys(target.changes || {}).length;
      const hasWrite = changed > 0 || withCoverLyrics.length > 0;
      ui.clear(nodes.result);
      nodes.result.append(ui.notice("info", hasWrite ? `差异预览完成，共 ${changed} 处文本变更；尚未写入文件。` : "本次无需变更，可在预览中查看已跳过的字段。"));
      body.unshift(ui.notice("info", `来源：${cand.source || "未知"} · ${cand.title || ""} — ${cand.artist || ""}`));
      if (withCoverLyrics.length) {
        body.push(
          ui.notice("warn", `除字段外还会写入：${withCoverLyrics.join(" + ")}（没有差异预览：${noDiffWhy.join("；")}）。`),
        );
      }
      coverHints.forEach((text) => body.push(ui.notice("info", text)));
      body.push(
        ui.el("div", { class: "hint", text: overwrite ? "覆盖已有文本与封面：开；勾选歌词表示明确替换。" : "覆盖已有文本与封面：关；已有值会跳过，勾选歌词仍表示明确替换。" }),
      );
      answer = await ui.openDialog({
        title: `写入预览：${row.title || row.filename}`,
        subtitle: "旧值红色 / 新值绿色，确认后才会写进文件",
        body,
        actions: hasWrite ? [
          { id: "cancel", label: "取消" },
          { id: "apply", label: "确认写入", variant: "btn-primary" },
        ] : [{ id: "done", label: "完成审阅", variant: "btn-primary" }],
      });
      if (answer === "done" && canContinue()) {
        ui.clear(nodes.result);
        nodes.result.append(ui.notice("ok", "本次无需变更，没有提交写入。"));
        const skipped = ui.skippedFieldsView(target.skipped);
        if (skipped) nodes.result.append(skipped);
        completeReviewChoice(choice, "无需变更");
        return;
      }
    } else {
      answer = (await ui.confirmDialog({
        title: "确认写入",
        message: `这次只写 ${withCoverLyrics.join(" + ")}，没有字段差异可预览。`,
        details: [
          { label: "曲目", value: row.title || row.filename || "" },
          { label: "来源", value: cand.source || "未知" },
        ],
        confirmLabel: "确认写入",
        note: `封面${overwrite ? "允许覆盖已有封面" : "保留已有封面，只补空缺"}；勾选歌词表示明确替换歌词，不受覆盖开关影响。其它字段保持不变。`,
      }))
        ? "apply"
        : "";
    }
    // A modal can outlive its search, selected candidate, track, or session.
    // Revalidate immediately before sending the irreversible write request.
    if (!canContinue()) {
      if (answer === "apply") ui.toast("info", "确认已过期", "曲目或候选已改变，本次确认未写入。请重新预览后确认。");
      return;
    }
    if (answer !== "apply") {
      ui.clear(nodes.result);
      nodes.result.append(ui.notice("info", "已取消，未写入任何文件。"));
      return;
    }

    operation.submitted = true;
    syncSingleControls();
    const result = await api.scrapeApply({
      track_id: choice.scope.trackId,
      candidate: writeCand,
      fields: Object.keys(values),
      write_cover: writeCover,
      write_lyrics: writeLyrics,
      normalize_artist: normalize,
      overwrite,
    });
    const writtenFields = result.written || [];
    const changeCount = Object.keys(result.changes || {}).length;
    const changedFile = result.file_changed ?? Boolean(writtenFields.length || result.cover || result.lyrics);
    if (canContinue()) {
      ui.clear(nodes.result);
      nodes.result.append(
        ui.notice("ok", changedFile ? `已写入：${writtenFields.map(ui.fieldLabel).join("、") || "封面或歌词"}；实际变更 ${changeCount} 处。` : "本次无需变更，已有内容已保留。"),
        ui.resultBlock({
          summary: [
            { label: "字段", value: writtenFields.length },
            { label: "差异", value: changeCount },
            { label: "封面", value: result.cover ? "已写" : "未写" },
            { label: "歌词", value: result.lyrics ? "已写" : "未写" },
          ],
        }),
      );
      const skipped = ui.skippedFieldsView(result.skipped);
      if (skipped) nodes.result.append(skipped);
      const writtenLyrics = typeof result.lyrics === "string" ? result.lyrics
        : result.lyrics && typeof writeCand.lyrics === "string" ? writeCand.lyrics : "";
      if (writtenLyrics) renderLyricsPreview({ lyrics: writtenLyrics }, { written: true });
      else setLyricsBody("", result.lyrics ? "歌词已写入，可在曲目详情中读取文件里的歌词。" : "本次没有写入歌词。");
    }
    completeReviewChoice(choice, changedFile ? "已写入并完成审阅" : "无需变更，已保留现有内容");
    ui.toast("ok", changedFile ? "刮削写入完成" : "无需变更", `${row.title || row.filename}：${writtenFields.map(ui.fieldLabel).join("、") || (changedFile ? "封面或歌词" : "已有内容已保留")}`);
    emit("status:refresh");
    emit("tracks:refresh");
    const fresh = await api.track(choice.scope.trackId).catch(() => null);
    if (fresh && sessionUsable && currentTrackId() === choice.scope.trackId && activeSearchScope === choice.scope) updateTrackSnapshot(fresh);
    await refreshPick();
  } catch (err) {
    if (canContinue()) {
      ui.clear(nodes.result);
      nodes.result.append(ui.notice("err", `写入失败：${err.message}`));
    }
    if (canContinue() || operation.submitted) ui.toast("err", "刮削写入失败", `${row.title || row.filename}：${err.message}`);
  } finally {
    if (pendingWrite === operation) {
      pendingWrite = null;
      syncSingleControls();
    }
  }
}

/* ------------------------------------------------------------- 批量 */

function renderBatchFields() {
  ui.clear(nodes.batchFields);
  const defaults = new Set(DEFAULT_WRITE_FIELDS);
  WRITE_FIELDS.forEach((field) => {
    const input = ui.el("input", { type: "checkbox", checked: defaults.has(field), "aria-label": `批量字段 ${ui.fieldLabel(field)}` });
    input.dataset.field = field;
    nodes.batchFields.append(ui.el("label", { class: "check" }, [input, ui.el("span", { text: ui.fieldLabel(field) })]));
  });
}

function batchFieldsSelected() {
  const out = [];
  nodes.batchFields.querySelectorAll("input[data-field]").forEach((input) => {
    if (input.checked) out.push(input.dataset.field);
  });
  return out;
}

function syncBatchMode() {
  const mode = document.querySelector("input[name=batch-mode]:checked");
  const isApply = mode && mode.value === "apply";
  nodes.batchThreshold.disabled = !isApply;
  nodes.batchThresholdHint.textContent = isApply
    ? "0 = 后端不做阈值判断（只要有候选就写入最佳候选）；分数口径与后端一致，超过 100 也算高分。"
    : "当前模式不写文件，最低分只在「自动写入」下生效。";
  nodes.batchCover.disabled = !isApply;
  nodes.batchLyrics.disabled = !isApply;
  ui.byId("batch-fields-wrap").hidden = !isApply;
  nodes.batchCover.closest("label").hidden = !isApply;
  nodes.batchLyrics.closest("label").hidden = !isApply;
  nodes.batchThreshold.closest("label").hidden = !isApply;
  nodes.batchRun.textContent = isApply ? "开始批量刮削并写入" : "开始批量搜索";
}

function renderBatchCount() {
  const count = selectionCount();
  ui.setText(nodes.batchCount, count ? `已选 ${count} 首` : "未选择");
}

async function runBatch() {
  if (!sessionUsable || pendingWrite || automaticBatchBusy) return;
  const ids = selectionIds();
  if (!ids.length) {
    ui.toast("warn", "还没有选择曲目", "在左侧列表或曲库页勾选要处理的曲目。");
    return;
  }
  if (!state.sourceChoice.size) {
    ui.toast("warn", "还没有选择数据源", "至少勾选一个数据源。");
    return;
  }
  const mode = document.querySelector("input[name=batch-mode]:checked");
  const isApply = mode && mode.value === "apply";
  const fields = batchFieldsSelected();
  const limit = Math.max(1, Math.min(10, Number(nodes.batchLimit.value) || 3));
  const threshold = Number(nodes.batchThreshold.value) || 0;
  const sources = [...state.sourceChoice];
  const normalize = nodes.writeNormalize.checked;
  const writeCover = nodes.batchCover.checked;
  const writeLyrics = nodes.batchLyrics.checked;

  if (!isApply) {
    if (ids.length > REVIEW_MAX) {
      ui.toast("warn", "本批超过 200 首", `当前已选 ${ids.length} 首。请缩小选择到 200 首以内后再搜索，队列不会截断曲目。`);
      return;
    }
    await runBatchSearchOnly(ids, { fields, limit, sources, normalize });
    return;
  }
  if (!fields.length && !writeCover && !writeLyrics) {
    ui.toast("warn", "没有选择要写入的字段", "至少勾选一个字段。");
    return;
  }

  automaticBatchBusy = true;
  const confirmed = await ui.confirmDialog({
    title: "确认批量刮削会写入文件",
    message: `将对 ${ids.length} 首曲目逐首搜索，并把达到阈值的候选字段直接写入文件。批量模式无法逐首预览差异。`,
    details: [
      { label: "曲目数", value: String(ids.length) },
      { label: "数据源", value: sources.join("、") },
      { label: "写入字段", value: fields.map(ui.fieldLabel).join("、") || "（无）" },
      { label: "写封面", value: writeCover ? "是" : "否" },
      { label: "写歌词", value: writeLyrics ? "是" : "否" },
      {
        label: "最低分",
        value: threshold > 0 ? `${threshold}（低于该分数的只跳过，不写入）` : "0 —— 不设阈值，只要有候选就写入最佳候选",
        danger: threshold <= 0,
      },
    ],
    confirmLabel: `确认写入 ${ids.length} 首`,
    danger: true,
    note: "建议先用「仅搜索」模式看一遍分数，再决定阈值；写入后无法自动撤销。",
  });
  if (!confirmed || !sessionUsable) {
    automaticBatchBusy = false;
    ui.toast("info", "已取消批量刮削", "没有写入任何文件。");
    return;
  }

  batchAbort = false;
  nodes.batchRun.disabled = true;
  ui.clear(nodes.batchResult);
  const progress = ui.createProgress(nodes.batchProgress, { label: "批量刮削" });
  const stopBtn = ui.el("button", {
    type: "button",
    class: "btn btn-sm",
    text: "停止",
    title: "停止只在任务开始前生效：后端任务一旦启动就会跑完当前一批不会中断",
    onClick: () => {
      batchAbort = true;
      ui.toast("warn", "已停止跟踪", "后端任务仍在后台运行，结果可在「任务」面板查看。");
    },
  });
  progress.node.append(stopBtn);

  try {
    const { job_id: jobId } = await api.scrapeBatch({
      ids,
      fields,
      sources,
      limit,
      write_cover: writeCover,
      write_lyrics: writeLyrics,
      auto_apply_min_score: threshold,
      normalize_artist: normalize,
    });
    const job = await pollJob(jobId, {
      onTick: (tick) => progress.update(tick),
      interval: 800,
    });
    progress.finish(job);
    if (job.state === "error") {
      ui.clear(nodes.batchResult);
      nodes.batchResult.append(ui.notice("err", `批量刮削失败：${job.error || job.message}`));
      ui.toast("err", "批量刮削失败", job.error || "");
      return;
    }
    let result = {};
    try {
      result = JSON.parse(job.result || "{}");
    } catch {
      result = {};
    }
    renderBatchApplyResult(result, ids);
    ui.toast("ok", "批量刮削完成", `写入 ${result.applied ?? 0}，跳过 ${result.skipped ?? 0}，失败 ${result.failed ?? 0}`);
    emit("status:refresh");
    emit("tracks:refresh");
    await refreshPick();
  } catch (err) {
    progress.finish({ state: "error", message: err.message });
    ui.clear(nodes.batchResult);
    nodes.batchResult.append(ui.notice("err", `批量刮削失败：${err.message}`));
    ui.toast("err", "批量刮削失败", err.message);
  } finally {
    automaticBatchBusy = false;
    nodes.batchRun.disabled = false;
    stopBtn.remove();
  }
}

function titleOf(trackId) {
  const row = state.selection.get(Number(trackId));
  return row ? row.title || row.filename || `#${trackId}` : `#${trackId}`;
}

function renderBatchApplyResult(result, ids) {
  const details = result.details || [];
  ui.clear(nodes.batchResult);
  nodes.batchResult.append(
    ui.resultBlock({
      summary: [
        { label: "已写入", value: result.applied ?? 0 },
        { label: "跳过", value: result.skipped ?? 0 },
        { label: "失败", value: result.failed ?? 0 },
        { label: "提交", value: ids.length },
      ],
      failures: details
        .filter((item) => item.status === "失败")
        .map((item) => ({ who: titleOf(item.track_id), why: item.error || "未知错误" })),
      failuresTitle: "失败明细",
    }),
  );
  const list = ui.el("div", { class: "result-list" }, []);
  details
    .filter((item) => item.status !== "失败")
    .forEach((item) => {
      list.append(
        ui.el("div", { class: "item" }, [
          ui.el("span", { class: "who", text: titleOf(item.track_id) }),
          ui.el("span", {
            class: "why",
            style: { color: item.status === "已写入" ? "var(--ok)" : "var(--fg-3)" },
            text: item.status === "已写入" ? `已写入 · 分数 ${item.score ?? "—"}` : `${item.status}${item.score !== undefined ? ` · 分数 ${item.score}` : ""}`,
          }),
        ]),
      );
    });
  if (list.childElementCount) {
    nodes.batchResult.append(ui.el("div", { class: "lbl", text: `逐首结果（${list.childElementCount}）` }), list);
  }
}

/* ------------------------------------------------------ 会话审阅队列 */

function showPicker(mode) {
  const review = mode === "review";
  ui.byId("scrape-library-picker").hidden = review;
  ui.byId("review-queue-root").hidden = !review;
  for (const [id, selected] of [["scrape-library-tab", !review], ["scrape-review-tab", review]]) {
    const button = ui.byId(id);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
}

function reviewEntry(payload) {
  if (!sessionUsable || !reviewRun || payload.generation !== reviewRun.generation) return null;
  const entry = reviewRun.entries.find((item) => item.trackId === Number(payload.trackId));
  return entry && entry.attempt === payload.attempt ? entry : null;
}

function reviewPayload(entry) {
  return { generation: reviewRun.generation, trackId: entry.trackId, attempt: entry.attempt };
}

function dropReviewResponse(run, entry) {
  run.bytes = Math.max(0, run.bytes - entry.bytes);
  entry.bytes = 0;
  entry.response = null;
}

function completeReviewChoice(choice, detail) {
  const review = choice?.scope.review;
  if (!review || review.run !== reviewRun || review.entry.attempt !== review.attempt) return;
  review.entry.status = "done";
  review.entry.detail = detail;
  dropReviewResponse(review.run, review.entry);
  // Keep the result panel visible while preventing a second write with this result.
  if (activeSearchScope === choice.scope) {
    choiceRevision += 1;
    fetchedLyrics = null;
    state.scrape.candidates = [];
    state.scrape.chosenIndex = -1;
    state.scrape.chosenFields = new Set();
    renderCandidates();
  }
  syncReviewQueue();
}

function expireReviewEntries() {
  if (!reviewRun) return;
  let changed = false;
  for (const entry of reviewRun.entries) {
    if (entry.response && Date.now() - entry.searchedAt >= REVIEW_TTL) {
      dropReviewResponse(reviewRun, entry);
      if (entry.status === "ready") {
        entry.status = "expired";
        entry.detail = "候选已超过 30 分钟，请重新搜索。";
      }
      if (activeSearchScope?.review?.entry === entry) invalidateCandidates(entry.detail);
      changed = true;
    }
  }
  if (changed) syncReviewQueue();
}

function clearReviewQueue() {
  const old = reviewRun;
  if (old) { old.stop = true; old.entries.forEach((entry) => dropReviewResponse(old, entry)); }
  reviewRun = null;
  reviewGeneration += 1;
  reviewOpenRevision += 1;
  reviewActiveId = null;
  if (activeSearchScope?.review) invalidateCandidates("待审队列已清空，请重新搜索候选。");
  reviewQueue?.clear(reviewGeneration);
  ui.byId("review-count").textContent = "0";
  nodes.reviewContext.hidden = true;
  nodes.reviewNavigation.hidden = true;
  nodes.batchProgress.hidden = true;
  ui.clear(nodes.batchResult);
  nodes.batchRun.disabled = !sessionUsable || automaticBatchBusy;
}

function stopReviewSearch() {
  if (!reviewRun || !reviewRun.running) return;
  reviewRun.stop = true;
  reviewRun.running = false;
  for (const entry of reviewRun.entries) {
    if (["queued", "searching"].includes(entry.status)) {
      entry.attempt += 1;
      entry.status = "stopped";
      entry.detail = "已停止搜索，可单独重新搜索。";
    }
  }
  nodes.batchRun.disabled = automaticBatchBusy;
  syncReviewQueue();
  ui.toast("info", "搜索已停止", "已完成的候选保留在待审队列，可继续审阅。");
}

function syncReviewQueue({ collapse = false } = {}) {
  const run = reviewRun;
  const entries = run?.entries || [];
  ui.byId("review-count").textContent = String(entries.length);
  if (run) reviewQueue?.update({ generation: run.generation, items: entries.map((entry) => ({
    trackId: entry.trackId, attempt: entry.attempt, title: entry.row.title, filename: entry.row.filename,
    artist: entry.row.artist, status: entry.status, count: entry.count, detail: entry.detail,
  })), activeId: reviewActiveId, running: run.running, collapse });
  renderReviewContext();
}

function renderReviewContext() {
  const focusedId = (nodes.reviewContext.contains(document.activeElement) || nodes.reviewNavigation.contains(document.activeElement)) ? document.activeElement.id : "";
  const run = reviewRun;
  const entry = run?.entries.find((item) => item.trackId === reviewActiveId);
  nodes.reviewContext.hidden = !entry;
  nodes.reviewNavigation.hidden = !entry;
  if (!entry) return;
  const index = run.entries.indexOf(entry);
  const payload = reviewPayload(entry);
  const label = entry.row.title || entry.row.filename || `#${entry.trackId}`;
  const status = { ready: "选择候选后预览，确认才写入", done: "已处理这一首，可继续下一首", skipped: "已跳过这一首", expired: "需要重新搜索后再审阅", failed: "搜索失败，可重新搜索", empty: "暂无候选，可改关键词重新搜索", searching: "正在重新搜索…", stopped: "这首还没有搜索" }[entry.status] || "等待搜索";
  nodes.reviewContext.replaceChildren(
    ui.el("div", { class: "review-context-heading" }, [ui.el("span", { class: "badge badge-accent", text: `审阅 ${index + 1} / ${run.entries.length}` }), ui.el("strong", { text: label })]),
    ui.el("p", { class: "hint", text: entry.detail || status }),
    ui.el("div", { class: "review-context-actions" }, [
      ui.el("button", { id: "review-return", type: "button", class: "btn btn-sm btn-ghost", text: "返回队列", onClick: () => { showPicker("review"); reviewQueue.reveal(entry.trackId); } }),
      ui.el("button", { id: "review-current-retry", type: "button", class: "btn btn-sm", text: "重新搜索", disabled: entry.status === "searching" || Boolean(pendingWrite), onClick: () => retryReviewEntry(payload) }),
    ]),
  );
  const next = run.entries.find((item, i) => i > index && item.status === "ready") || run.entries.find((item, i) => i < index && item.status === "ready");
  nodes.reviewNavigation.replaceChildren(
    ui.el("span", { class: "hint", text: status }),
    ui.el("button", { id: "review-current-skip", type: "button", class: "btn btn-sm", text: "跳过这一首", disabled: ["done", "skipped", "searching"].includes(entry.status) || Boolean(pendingWrite), onClick: () => skipReviewEntry(payload) }),
    ui.el("button", { id: "review-next", type: "button", class: "btn btn-sm btn-primary", text: "下一首待审阅", disabled: !next || Boolean(pendingWrite), onClick: () => next && openReviewEntry(reviewPayload(next)) }),
  );
  if (focusedId) {
    const replacement = ui.byId(focusedId);
    if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
    else ui.byId("review-return")?.focus({ preventScroll: true });
  }
}

function storeReviewResponse(run, entry, response) {
  const bytes = new TextEncoder().encode(JSON.stringify(response)).byteLength;
  dropReviewResponse(run, entry);
  if (bytes > REVIEW_ENTRY_BYTES) {
    entry.status = "expired";
    entry.detail = "这首的候选内容过大，未保留。请减少每源条数后重新搜索。";
    return;
  }
  for (const other of run.entries) {
    if (run.bytes + bytes <= REVIEW_BYTES) break;
    if (other === entry || !other.response) continue;
    dropReviewResponse(run, other);
    if (other.status === "ready") { other.status = "expired"; other.detail = "较早的候选已释放以控制会话内存，请重新搜索。"; }
    if (activeSearchScope?.review?.entry === other) invalidateCandidates(other.detail);
  }
  entry.response = response;
  entry.bytes = bytes;
  run.bytes += bytes;
}

async function searchReviewEntry(run, entry, options) {
  if (!sessionUsable || reviewRun !== run) return;
  const attempt = ++entry.attempt;
  dropReviewResponse(run, entry);
  entry.status = "searching"; entry.detail = ""; entry.count = 0;
  syncReviewQueue();
  const current = () => sessionUsable && reviewRun === run && entry.attempt === attempt;
  try {
    const row = await api.track(entry.trackId);
    if (!current()) return;
    if (Number(row.id) !== entry.trackId || row.file_exists === false) throw new Error("音乐文件不存在或已从曲库移除，请检查挂载与索引。");
    entry.row = { ...row };
    const query = options || { keyword: row.title || "", artistHint: row.artist || "", sources: run.sources, limit: run.limit };
    entry.searchOptions = { ...query, sources: [...query.sources] };
    const response = await api.search({ track_id: entry.trackId, keyword: query.keyword, artist_hint: query.artistHint, sources: query.sources, limit: query.limit });
    if (!current()) return;
    const searchedTrack = response.track;
    if (!searchedTrack || Number(searchedTrack.id) !== entry.trackId) throw new Error("搜索结果未绑定这首曲目，可能已从曲库移除。请刷新曲库后重试。");
    entry.baseline = { title: String(searchedTrack.title ?? row.title ?? ""), artist: String(searchedTrack.artist ?? row.artist ?? "") };
    entry.searchedAt = Date.now();
    entry.count = Array.isArray(response.candidates) ? response.candidates.length : 0;
    const errors = (response.source_status || []).filter((item) => item.error);
    entry.status = entry.count ? "ready" : errors.length ? "failed" : "empty";
    entry.detail = entry.count ? `${entry.count} 个候选 · 最佳分数 ${response.candidates[0].score ?? "—"}`
      : errors.length ? `${errors.length} 个数据源报错，可以重试。` : "没有匹配候选，可打开后调整关键词搜索。";
    storeReviewResponse(run, entry, response);
  } catch (error) {
    if (!current()) return;
    entry.status = "failed"; entry.detail = error?.message || "搜索失败，请重试。";
  }
  if (current()) syncReviewQueue();
}

async function openReviewEntry(payload) {
  expireReviewEntries();
  const entry = reviewEntry(payload);
  const run = reviewRun;
  if (!entry || ["queued", "searching"].includes(entry.status) || pendingWrite?.submitted) return;
  invalidateCandidates();
  setCurrentTrack(entry.row);
  const revision = ++reviewOpenRevision;
  reviewActiveId = entry.trackId;
  showPicker("review");
  syncReviewQueue({ collapse: true });
  nodes.searchState.append(ui.loadingLine("正在核对曲目资料…"));
  const current = () => sessionUsable && reviewRun === run && reviewOpenRevision === revision && entry.attempt === payload.attempt && currentTrackId() === entry.trackId;
  try {
    const row = await api.track(entry.trackId);
    if (!current()) return;
    if (Number(row.id) !== entry.trackId || row.file_exists === false) throw new Error("音乐文件不存在或已移除，请检查挂载与索引。");
    entry.row = { ...row };
    updateTrackSnapshot(row);
    nodes.keyword.value = entry.searchOptions?.keyword ?? row.title ?? "";
    nodes.artistHint.value = entry.searchOptions?.artistHint ?? row.artist ?? "";
    if (entry.status === "ready" && (Date.now() - entry.searchedAt >= REVIEW_TTL || !entry.response
        || String(row.title || "") !== entry.baseline.title || String(row.artist || "") !== entry.baseline.artist)) {
      dropReviewResponse(run, entry);
      entry.status = "expired";
      entry.detail = "曲目标题、歌手或候选有效期已改变，请重新搜索。";
    }
    ui.clear(nodes.searchState);
    if (entry.status === "ready" && entry.response) {
      const scope = { currentId: entry.trackId, trackId: entry.trackId, review: { run, entry, attempt: entry.attempt } };
      activeSearchScope = scope; candidateScope = scope;
      state.scrape.candidates = entry.response.candidates || [];
      state.scrape.sourceStatus = entry.response.source_status || [];
      state.scrape.searched = true;
      nodes.searchState.append(ui.notice("info", "已载入这首的搜索结果。选择候选后预览，确认才会写入。"));
    } else nodes.searchState.append(ui.notice("info", entry.detail || "请重新搜索当前曲目。"));
    renderCandidates(); renderSourceStatus(); renderWritePanel(); syncReviewQueue({ collapse: true });
    if (state.tab === "scrape") {
      const heading = ui.byId("scrape-candidates-heading");
      heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: "start", behavior: "instant" });
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches) nodes.candList.animate([{ opacity: .55, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 180 });
    }
  } catch (error) {
    if (!current()) return;
    dropReviewResponse(run, entry);
    entry.status = "failed"; entry.detail = error?.message || "曲目暂时无法读取。";
    ui.clear(nodes.searchState); nodes.searchState.append(ui.notice("err", entry.detail)); syncReviewQueue();
  }
}

async function retryReviewEntry(payload, options) {
  const entry = reviewEntry(payload);
  const run = reviewRun;
  if (!entry || entry.status === "searching" || pendingWrite?.submitted) return;
  const reopen = reviewActiveId === entry.trackId;
  if (reopen) { reviewOpenRevision += 1; invalidateCandidates("正在重新搜索这首曲目…"); }
  await searchReviewEntry(run, entry, options);
  if (sessionUsable && run === reviewRun && reopen && reviewActiveId === entry.trackId && entry.status === "ready") await openReviewEntry(reviewPayload(entry));
}

function skipReviewEntry(payload) {
  const entry = reviewEntry(payload);
  if (!entry || entry.status === "searching" || pendingWrite?.submitted) return;
  entry.attempt += 1; entry.status = "skipped"; entry.detail = "本次跳过，需要时可重新搜索。";
  dropReviewResponse(reviewRun, entry);
  if (reviewActiveId === entry.trackId) { reviewOpenRevision += 1; invalidateCandidates("已跳过这一首，可继续下一首待审阅。"); }
  syncReviewQueue();
}

/** One immutable selection snapshot, one bounded in-memory batch. */
async function runBatchSearchOnly(ids, { limit, sources }) {
  clearReviewQueue();
  const run = {
    generation: reviewGeneration, running: true, stop: false, bytes: 0, limit, sources: [...sources],
    entries: ids.map((id) => ({ trackId: Number(id), row: { ...(state.selection.get(Number(id)) || { id }) }, status: "queued", attempt: 0, count: 0, detail: "", response: null, bytes: 0, baseline: null, searchedAt: 0 })),
  };
  reviewRun = run;
  nodes.batchRun.disabled = true;
  showPicker("review");
  syncReviewQueue();
  const text = ui.el("p", { text: "正在搜索这批曲目，已完成的结果可立即进入审阅。" });
  nodes.batchResult.append(ui.el("div", { class: "review-batch-summary" }, [text, ui.el("button", { id: "review-start", type: "button", class: "btn btn-sm btn-primary", text: "查看待审队列", onClick: () => {
    showPicker("review");
    const ready = reviewRun?.entries.find((item) => item.status === "ready");
    if (ready) void openReviewEntry(reviewPayload(ready));
    else reviewQueue.reveal();
  } })]));
  for (const entry of run.entries) {
    if (!sessionUsable || reviewRun !== run || run.stop) break;
    if (entry.status !== "queued") continue;
    await searchReviewEntry(run, entry);
  }
  if (reviewRun !== run || !sessionUsable) return;
  run.running = false;
  nodes.batchRun.disabled = automaticBatchBusy;
  const ready = run.entries.filter((entry) => entry.status === "ready").length;
  text.textContent = run.stop ? `搜索已停止，保留 ${ready} 首待审结果。` : `搜索完成，${ready} 首可以继续审阅。每首都需要单独预览确认。`;
  syncReviewQueue();
}

/** 供 app.js 在状态/设置更新后调用。 */
export function onSettingsLoaded() {
  const values = (state.settings && state.settings.values) || {};
  // 写入面板里的勾选是「本次写入」的即时决定：用户手动改过之后就别再用设置页的值覆盖他
  // （否则在面板里取消勾选、中途保存一次设置，就会被悄悄改回设置里的默认值）
  if (!panelTouched) {
    if (values.write_cover !== undefined) nodes.writeCover.checked = Boolean(values.write_cover);
    if (values.write_lyrics !== undefined) nodes.writeLyrics.checked = Boolean(values.write_lyrics);
    if (values.overwrite_existing !== undefined) nodes.writeOverwrite.checked = Boolean(values.overwrite_existing);
    if (values.normalize_artist_ampersand !== undefined) nodes.writeNormalize.checked = Boolean(values.normalize_artist_ampersand);
  }
  renderWritePanel();
}

export function refreshSelectionViews() {
  renderBatchCount();
  renderPick();
}

export function refreshAll() {
  syncSearchFields();
  renderSources();
  renderBatchCount();
  renderSourceStatus();
  renderCandidates();
  renderWritePanel();
  return refreshPick();
}
