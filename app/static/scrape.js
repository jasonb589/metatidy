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

  on("selection:changed", () => {
    renderBatchCount();
    renderPick();
  });
  on("current:changed", () => {
    renderPick();
    syncSearchFields();
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
    state.scrape.pickItems = data.items || [];
    state.scrape.pickTotal = data.total || 0;
    state.scrape.pickPages = data.pages || 1;
    state.scrape.pickPage = data.page || 1;
  } catch (err) {
    state.scrape.pickItems = [];
    state.scrape.pickTotal = 0;
    state.scrape.pickPages = 1;
    ui.toast("err", "读取曲目失败", err.message);
  } finally {
    state.scrape.loadingPick = false;
  }
  renderPick();
}

function renderPick() {
  ui.clear(nodes.pickList);
  ui.setText(nodes.pickTotal, `共 ${ui.fmtNum(state.scrape.pickTotal)} 首`);

  if (!state.scrape.pickItems.length) {
    nodes.pickList.append(
      ui.emptyState("··", state.scrape.pickQ ? "没有匹配的曲目" : "曲库还没有曲目", state.scrape.pickQ ? "换个关键词试试。" : "先到「曲库」页扫描一次。"),
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
  nodes.searchBtn.disabled = true;
  nodes.searchBtn.textContent = "搜索中…";
  ui.clear(nodes.searchState);
  nodes.searchState.append(
    ui.loadingLine(`正在并发查询 ${state.sourceChoice.size} 个数据源（每源最多 ${limit} 条，慢源最多等 20 秒）…`),
  );
  state.scrape.chosenIndex = -1;
  state.scrape.chosenFields = new Set();
  renderWritePanel();
  try {
    const result = await api.search({
      track_id: row ? Number(row.id) : null,
      keyword,
      artist_hint: artistHint,
      sources: [...state.sourceChoice],
      limit,
    });
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
    state.scrape.candidates = [];
    state.scrape.sourceStatus = [];
    state.scrape.error = err.message;
    ui.clear(nodes.searchState);
    nodes.searchState.append(ui.notice("err", `搜索失败：${err.message}`));
  } finally {
    nodes.searchBtn.disabled = false;
    nodes.searchBtn.textContent = "搜索候选";
    renderCandidates();
    renderSourceStatus();
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
}

/** 歌词预览面板（常显：标题 + 说明/统计 + 「试抓歌词」按钮；有歌词时摊开全文）。
 *
 * 为什么要它：原来只能勾「写歌词」却看不到会写进去什么，等于盲勾；候选本身不带歌词时，
 * 还能用「试抓歌词」先让后端按标题/歌手查一次看看能不能抓到。
 *
 *
 * - 候选自带歌词 → 直接展示（行数 / 字数 + 全文）；
 * - 候选不带歌词 → 说明可以点「试抓歌词」让后端按标题/歌手去查（不假装有）；
 * - 写入完成后 → 用后端返回的**真实写入内容**刷新（`written: true`）。 */
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
  const row = currentTrackRow();
  const cand = state.scrape.candidates[state.scrape.chosenIndex];
  if (!row || !cand) {
    ui.toast("warn", "先选一个候选", "试抓用的是当前候选的标题/歌手（和写入时同一组关键词）。");
    return;
  }
  const btn = nodes.lyricsTry;
  btn.disabled = true;
  btn.textContent = "试抓中…";
  nodes.lyricsBox.hidden = false;
  nodes.lyricsBox.style.display = "";
  setLyricsBody("", "正在试抓…（网易云 → QQ → LRCLIB → 酷狗）");
  try {
    const res = await api.lyricsPreview({
      track_id: Number(row.id),
      title: cand.title || "",
      artist: cand.artist || "",
      album: cand.album || "",
      duration: Number(cand.duration) || 0,
    });
    if (res.lyrics) {
      fetchedLyrics = {
        index: state.scrape.chosenIndex,
        text: res.lyrics,
        source: res.source || "",
      };
      // 候选的关键词查不到时后端会退回用曲目标签再查一次，这里把这件事说明白
      renderLyricsPreview(
        { lyrics: res.lyrics },
        {
          source:
            res.used === "曲目标签"
              ? `${res.source || "未知来源"}（按曲目标签查的）`
              : res.source || "",
        },
      );
      ui.toast("ok", "抓到歌词（还没写入）", `${res.source || "未知来源"} · ${res.lines} 行 ${res.chars} 字`);
    } else {
      renderLyricsPreview({ lyrics: "" });
      ui.toast("warn", "没抓到歌词", res.detail || "四个源都没有结果");
    }
  } catch (err) {
    setLyricsBody("", (err && err.message) || "试抓失败");
    ui.toast("err", "试抓歌词失败", (err && err.message) || "");
  } finally {
    btn.disabled = false;
    btn.textContent = "试抓歌词";
  }
}

function renderWritePanel() {
  const row = currentTrackRow();
  const cand = state.scrape.candidates[state.scrape.chosenIndex];
  ui.clear(nodes.writeFields);

  if (!cand) {
    ui.setText(nodes.writeTarget, "未选候选");
    ui.clear(nodes.writeCandidate);
    nodes.writeCandidate.append(document.createTextNode("在中间列表里点一个候选，再勾选要写入的字段。"));
    nodes.applyBtn.disabled = true;
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
    nodes.writeCover.checked = false;
    nodes.writeCover.parentElement.title = "这个候选项没有封面地址";
  } else {
    nodes.writeCover.parentElement.title = "";
  }
  const hasLyrics = Boolean(cand.lyrics);
  if (!hasLyrics && !nodes.writeLyrics.checked) {
    nodes.writeLyrics.parentElement.title = "候选没有内嵌歌词，勾选后后端会按标题/歌手再查一次";
  }

  renderLyricsPreview(cand);

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

  nodes.applyBtn.disabled = !row;
  nodes.applyBtn.title = row ? "" : "先选中一首「当前曲目」才能写入";
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
  const row = currentTrackRow();
  const cand = state.scrape.candidates[state.scrape.chosenIndex];
  if (!row || !cand) return;
  // 「试抓歌词」抓到的那一份原样带进写入：后端优先用候选里的歌词，这样「你看到的」和
  // 「写进去的」是同一份（否则写入时后端会再抓一次，可能换一个版本）。
  const fetched =
    fetchedLyrics && fetchedLyrics.index === state.scrape.chosenIndex ? fetchedLyrics : null;
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

  nodes.applyBtn.disabled = true;
  nodes.applyBtn.textContent = "预览中…";
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
      const preview = await api.previewTracks({ ids: [Number(row.id)], fields: values, normalize_artist: normalize });
      body = ui.diffView(preview.items || []);
      const changed = preview.changed_fields || 0;
      ui.clear(nodes.result);
      nodes.result.append(ui.notice("info", `差异预览完成，共 ${changed} 处变更；尚未写入文件。`));
      body.unshift(ui.notice("info", `来源：${cand.source || "未知"} · ${cand.title || ""} — ${cand.artist || ""}`));
      if (withCoverLyrics.length) {
        body.push(
          ui.notice("warn", `除字段外还会写入：${withCoverLyrics.join(" + ")}（没有差异预览：${noDiffWhy.join("；")}）。`),
        );
      }
      coverHints.forEach((text) => body.push(ui.notice("info", text)));
      body.push(
        ui.el("div", { class: "hint", text: overwrite ? "覆盖已有值：开" : "覆盖已有值：关（已有非空字段会被跳过）" }),
      );
      answer = await ui.openDialog({
        title: `写入预览：${row.title || row.filename}`,
        subtitle: "旧值红色 / 新值绿色，确认后才会写进文件",
        body,
        actions: [
          { id: "cancel", label: "取消" },
          { id: "apply", label: "确认写入", variant: "btn-primary" },
        ],
      });
    } else {
      answer = (await ui.confirmDialog({
        title: "确认写入",
        message: `这次只写 ${withCoverLyrics.join(" + ")}，没有字段差异可预览。`,
        details: [
          { label: "曲目", value: row.title || row.filename || "" },
          { label: "来源", value: cand.source || "未知" },
        ],
        confirmLabel: "确认写入",
        note: `${withCoverLyrics.join(" + ")}会直接合并进现有标签，不会删除其它字段。`,
      }))
        ? "apply"
        : "";
    }
    if (answer !== "apply") {
      ui.clear(nodes.result);
      nodes.result.append(ui.notice("info", "已取消，未写入任何文件。"));
      return;
    }

    const result = await api.scrapeApply({
      track_id: Number(row.id),
      candidate: writeCand,
      fields: Object.keys(values),
      write_cover: writeCover,
      write_lyrics: writeLyrics,
      normalize_artist: normalize,
      overwrite,
    });
    const writtenFields = result.written || [];
    const changeCount = Object.keys(result.changes || {}).length;
    ui.clear(nodes.result);
    nodes.result.append(
      ui.notice("ok", `已写入：${writtenFields.map(ui.fieldLabel).join("、") || "（无字段）"}；实际变更 ${changeCount} 处。`),
      ui.resultBlock({
        summary: [
          { label: "字段", value: writtenFields.length },
          { label: "差异", value: changeCount },
          { label: "封面", value: result.cover ? "已写" : "未写" },
          { label: "歌词", value: result.lyrics ? "已写" : "未写" },
        ],
      }),
    );
    renderLyricsPreview({ lyrics: result.lyrics }, { written: true });
    ui.toast("ok", "刮削写入完成", `${row.title || row.filename}：${writtenFields.map(ui.fieldLabel).join("、") || "无字段"}`);
    emit("status:refresh");
    emit("tracks:refresh");
    await refreshPick();
  } catch (err) {
    ui.clear(nodes.result);
    nodes.result.append(ui.notice("err", `写入失败：${err.message}`));
    ui.toast("err", "刮削写入失败", err.message);
  } finally {
    nodes.applyBtn.disabled = !currentTrackRow();
    nodes.applyBtn.textContent = "预览差异并写入";
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
  if (!isApply) {
    nodes.batchCover.checked = false;
    nodes.batchLyrics.checked = false;
  }
  nodes.batchRun.textContent = isApply ? "开始批量刮削并写入" : "开始批量搜索";
}

function renderBatchCount() {
  const count = selectionCount();
  ui.setText(nodes.batchCount, count ? `已选 ${count} 首` : "未选择");
}

async function runBatch() {
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

  if (!isApply) {
    await runBatchSearchOnly(ids, { fields, limit, sources, normalize });
    return;
  }
  if (!fields.length && !nodes.batchCover.checked && !nodes.batchLyrics.checked) {
    ui.toast("warn", "没有选择要写入的字段", "至少勾选一个字段。");
    return;
  }

  const confirmed = await ui.confirmDialog({
    title: "确认批量刮削会写入文件",
    message: `将对 ${ids.length} 首曲目逐首搜索，并把达到阈值的候选字段直接写入文件。批量模式无法逐首预览差异。`,
    details: [
      { label: "曲目数", value: String(ids.length) },
      { label: "数据源", value: sources.join("、") },
      { label: "写入字段", value: fields.map(ui.fieldLabel).join("、") || "（无）" },
      { label: "写封面", value: nodes.batchCover.checked ? "是" : "否" },
      { label: "写歌词", value: nodes.batchLyrics.checked ? "是" : "否" },
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
  if (!confirmed) {
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
      write_cover: nodes.batchCover.checked,
      write_lyrics: nodes.batchLyrics.checked,
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

/** 仅搜索模式：前端逐首调 /api/search，绝不写入文件。 */
async function runBatchSearchOnly(ids, { fields, limit, sources, normalize }) {
  batchAbort = false;
  nodes.batchRun.disabled = true;
  ui.clear(nodes.batchResult);
  const progress = ui.createProgress(nodes.batchProgress, { label: "批量搜索（不写文件）" });
  const stopBtn = ui.el("button", {
    type: "button",
    class: "btn btn-sm",
    text: "停止",
    onClick: () => {
      batchAbort = true;
      ui.toast("info", "已停止", "已完成的部分结果保留在下方。");
    },
  });
  progress.node.append(stopBtn);

  const rows = [];
  let done = 0;
  let hits = 0;
  try {
    for (const id of ids) {
      if (batchAbort) break;
      const row = state.selection.get(Number(id)) || {};
      const keyword = row.title || "";
      let status = "无候选";
      let detail = "";
      let best = null;
      try {
        const result = await api.search({
          track_id: Number(id),
          keyword: row.title || "",
          artist_hint: row.artist || "",
          sources,
          limit,
        });
        const candidates = result.candidates || [];
        if (candidates.length) {
          best = candidates[0];
          hits += 1;
          status = "有候选";
          detail = `${best.source || ""} · ${best.title || ""} — ${best.artist || ""} · 分 ${best.score}（${best.confidence || "待确认"}）`;
        } else {
          const errors = (result.source_status || []).filter((item) => item.error);
          detail = errors.length
            ? `全部数据源无结果（${errors.length} 个源报错：${errors.map((item) => item.source).join("、")}）`
            : "全部数据源都没有返回结果";
        }
      } catch (err) {
        status = "失败";
        detail = err.message;
      }
      rows.push({ id, keyword, status, detail });
      done += 1;
      progress.update({ state: "running", done, total: ids.length, message: `${keyword || `#${id}`} → ${status}` });
      renderBatchSearchRows(rows, ids.length, done);
    }
    progress.finish({ state: "done", done, total: ids.length, message: batchAbort ? "已停止（已完成的部分保留）" : "搜索完成" });
    if (batchAbort) progress.setStatus(`已停止：${done}/${ids.length}`, "hint-warn");
    ui.toast(hits ? "ok" : "warn", `批量搜索完成：${hits} 首有候选`, `共处理 ${done} 首，未写入任何文件。${fields.length ? "（搜索模式不使用字段选择）" : ""}`);
  } catch (err) {
    ui.clear(nodes.batchResult);
    nodes.batchResult.append(ui.notice("err", `批量搜索失败：${err.message}`));
    ui.toast("err", "批量搜索失败", err.message);
  } finally {
    nodes.batchRun.disabled = false;
    stopBtn.remove();
    void normalize;
  }
}

function renderBatchSearchRows(rows, total, done) {
  ui.clear(nodes.batchResult);
  const hit = rows.filter((row) => row.status === "有候选").length;
  const failed = rows.filter((row) => row.status === "失败").length;
  nodes.batchResult.append(
    ui.resultBlock({
      summary: [
        { label: "已查", value: `${done}/${total}` },
        { label: "有候选", value: hit },
        { label: "无候选", value: rows.length - hit - failed },
        { label: "失败", value: failed },
      ],
      failures: rows
        .filter((row) => row.status === "失败")
        .map((row) => ({ who: titleOf(row.id), why: row.detail })),
      failuresTitle: "失败明细",
    }),
    ui.el("div", { class: "lbl", text: "逐首结果（仅搜索，不写文件）" }),
    ui.el(
      "div",
      { class: "result-list" },
      rows.map((row) =>
        ui.el("div", { class: "item" }, [
          ui.el("span", { class: "who", text: titleOf(row.id) }),
          ui.el("span", {
            class: "why",
            style: { color: row.status === "有候选" ? "var(--ok)" : row.status === "失败" ? "" : "var(--fg-3)" },
            title: row.detail,
            text: row.detail || row.status,
          }),
        ]),
      ),
    ),
  );
}

/** 供 app.js 在状态/设置更新后调用。 */
export function onSettingsLoaded() {
  const values = (state.settings && state.settings.values) || {};
  if (values.write_cover !== undefined) nodes.writeCover.checked = Boolean(values.write_cover);
  if (values.write_lyrics !== undefined) nodes.writeLyrics.checked = Boolean(values.write_lyrics);
  if (values.overwrite_existing !== undefined) nodes.writeOverwrite.checked = Boolean(values.overwrite_existing);
  if (values.normalize_artist_ampersand !== undefined) nodes.writeNormalize.checked = Boolean(values.normalize_artist_ampersand);
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
