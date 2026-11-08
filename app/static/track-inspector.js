/**
 * Read-only track dossier. Index details and artwork are loaded on demand;
 * lyrics read the original file only after an explicit click.
 */
import { api, coverUrl } from "./api.js";
import * as ui from "./ui.js";
import { playTrack } from "./audio-player.js";

const TAG_FIELDS = ["artist", "album", "albumartist", "genre", "year", "track", "disc", "language", "albumtype"];
const EXTRA_FIELDS = ["composer", "lyricist", "copyright", "comment", "mb_artist_id", "release_group_id"];
let closeActiveInspector = null;

function validId(row) {
  const id = Number(row?.id);
  return Number.isSafeInteger(id) && id > 0;
}

function text(value, fallback = "未填写") {
  return value === null || value === undefined || String(value).trim() === "" ? fallback : String(value);
}

function timestamp(value) {
  return Number(value) > 0 ? ui.fmtTime(Number(value)) : "暂无记录";
}

function formatOf(row) {
  return String(row.ext || (row.filename || "").match(/\.([^./\\]+)$/)?.[1] || "").replace(/^\./, "").toUpperCase();
}

/**
 * Open one track, with optional previous/next navigation within the supplied page.
 * Callbacks receive the latest loaded row, after the modal has been closed.
 */
export function openTrackDetails(row, { rows = [], onEdit = () => {}, onScrape = () => {}, trigger } = {}) {
  if (!validId(row)) return null;
  closeActiveInspector?.({ restoreFocus: false });

  const opener = trigger instanceof HTMLElement ? trigger : document.activeElement;
  const seen = new Set();
  let collection = (Array.isArray(rows) ? rows : []).filter((item) => {
    if (!validId(item) || seen.has(Number(item.id))) return false;
    seen.add(Number(item.id));
    return true;
  }).map((item) => ({ ...item }));
  let index = collection.findIndex((item) => Number(item.id) === Number(row.id));
  if (index < 0) {
    collection = [{ ...row }];
    index = 0;
  } else collection[index] = { ...collection[index], ...row };

  let current = null;
  let generation = 0;
  let detailRequest = 0;
  let closed = false;
  let artKey = "";
  let lyricsLoaded = false;
  let lyricsRequested = false;

  const dialog = ui.el("dialog", {
    id: "track-inspector", class: "track-inspector", "aria-labelledby": "track-inspector-heading",
  });
  const closeButton = ui.el("button", {
    id: "track-inspector-close", type: "button", class: "btn btn-ghost ti-close", autofocus: true,
    "aria-label": "关闭曲目详情", title: "关闭（Esc）", onClick: () => close(),
  }, [ui.icon("close", { size: 18 })]);
  const previousButton = ui.el("button", {
    id: "track-inspector-prev", type: "button", class: "btn btn-sm btn-ghost ti-nav-button",
    "aria-label": "查看当前页上一首", title: "上一首（←）", text: "←", onClick: () => navigate(-1),
  });
  const nextButton = ui.el("button", {
    id: "track-inspector-next", type: "button", class: "btn btn-sm btn-ghost ti-nav-button",
    "aria-label": "查看当前页下一首", title: "下一首（→）", text: "→", onClick: () => navigate(1),
  });
  const position = ui.el("span", { id: "track-inspector-position", class: "ti-position", "aria-live": "polite" });
  const artwork = ui.el("div", { class: "ti-art", "aria-label": "曲目封面" });
  const title = ui.el("h3", { id: "track-inspector-title", class: "ti-title", tabindex: "-1" });
  const artist = ui.el("p", { class: "ti-artist" });
  const album = ui.el("p", { class: "ti-album" });
  const facts = ui.el("div", { class: "ti-facts" });
  const badges = ui.el("div", { class: "ti-statuses" });
  const playButton = ui.el("button", {
    id: "track-inspector-play", type: "button", class: "btn ti-audio-action", text: "试听这首歌",
    onClick: () => {
      if (closed || !current) return;
      const selected = { ...current }, rows = collection.map(item => Number(item.id) === Number(current.id) ? selected : { ...item });
      close(); playTrack(selected, { rows });
    },
  });
  const intro = ui.el("div", { class: "ti-intro" }, [title, artist, album, facts, badges, playButton]);

  const loadStatus = ui.el("p", { id: "track-inspector-status", class: "ti-load-status hint", role: "status" });
  const retryButton = ui.el("button", {
    id: "track-inspector-retry", type: "button", class: "btn btn-sm", text: "重新读取资料", hidden: true,
    onClick: () => void loadDetails(),
  });
  const tagList = ui.el("dl", { id: "track-inspector-tags", class: "ti-fields" });
  const extraList = ui.el("dl", { class: "ti-fields ti-extra-fields" });
  const extraDetails = ui.el("details", { class: "ti-extra" }, [
    ui.el("summary", {}, [ui.el("span", { text: "更多标签" }), ui.el("span", { class: "hint", text: "创作信息与标识" })]),
    extraList,
  ]);
  const fileList = ui.el("dl", { id: "track-inspector-file-info", class: "ti-fields" });
  const pathField = ui.el("textarea", {
    id: "track-inspector-path", class: "ti-path", rows: "2", readonly: true, spellcheck: "false",
    "aria-label": "音乐文件完整路径",
  });
  const copyFeedback = ui.el("span", { id: "track-inspector-copy-feedback", class: "hint", role: "status" });
  const copyButton = ui.el("button", {
    id: "track-inspector-copy-path", class: "btn btn-sm btn-ghost", type: "button", onClick: () => void copyPath(),
  }, [ui.icon("copy", { size: 14 }), "复制路径"]);
  const lyricsStatus = ui.el("p", { id: "track-inspector-lyrics-status", class: "hint", role: "status" });
  const lyricsText = ui.el("pre", { id: "track-inspector-lyrics", class: "ti-lyrics", hidden: true, tabindex: "0", "aria-label": "文件中的歌词" });
  const lyricsButton = ui.el("button", {
    id: "track-inspector-lyrics-load", type: "button", class: "btn btn-sm", text: "读取歌词",
    onClick: () => void loadLyrics(),
  }, [ui.icon("lyrics", { size: 14 })]);
  const lyricsSection = ui.el("section", { class: "ti-section ti-lyrics-section", "aria-labelledby": "track-inspector-lyrics-heading" }, [
    ui.el("div", { class: "ti-section-head" }, [
      ui.el("h4", { id: "track-inspector-lyrics-heading", text: "歌词" }), lyricsButton,
    ]), lyricsStatus, lyricsText,
  ]);

  const content = ui.el("div", { class: "ti-content" }, [
    ui.el("div", { class: "ti-load" }, [loadStatus, retryButton]),
    ui.el("section", { class: "ti-section", "aria-labelledby": "track-inspector-tags-heading" }, [
      ui.el("h4", { id: "track-inspector-tags-heading", text: "音乐标签" }), tagList, extraDetails,
    ]),
    ui.el("section", { class: "ti-section", "aria-labelledby": "track-inspector-file-heading" }, [
      ui.el("h4", { id: "track-inspector-file-heading", text: "文件与索引" }), fileList,
      ui.el("div", { class: "ti-path-heading" }, [ui.el("label", { for: "track-inspector-path", text: "完整路径" }), copyButton]),
      pathField, copyFeedback,
    ]), lyricsSection,
  ]);
  const body = ui.el("div", { class: "ti-body" }, [
    ui.el("div", { class: "ti-summary" }, [artwork, intro]), content,
  ]);
  const editButton = ui.el("button", {
    id: "track-inspector-edit", class: "btn btn-primary", type: "button", onClick: () => act(onEdit),
  }, [ui.icon("edit", { size: 15 }), "编辑元数据"]);
  const scrapeButton = ui.el("button", {
    id: "track-inspector-scrape", class: "btn", type: "button", onClick: () => act(onScrape),
  }, [ui.icon("search", { size: 15 }), "查找元数据"]);
  dialog.append(
    ui.el("header", { class: "ti-header" }, [
      ui.el("div", { class: "ti-heading" }, [
        ui.el("p", { class: "eyebrow", text: "IN YOUR COLLECTION" }),
        ui.el("h2", { id: "track-inspector-heading", text: "曲目详情" }),
      ]),
      ui.el("nav", { class: "ti-navigation", "aria-label": "浏览当前页曲目" }, [previousButton, position, nextButton]), closeButton,
    ]), body,
    ui.el("footer", { class: "ti-footer" }, [
      ui.el("span", { class: "hint ti-readonly-note", text: "查看资料不会修改音乐文件" }),
      ui.el("div", { class: "ti-actions" }, [scrapeButton, editButton]),
    ]),
  );

  function isCurrent(token) {
    return !closed && dialog.open && token === generation;
  }

  function close({ restoreFocus = true } = {}) {
    if (closed) return;
    closed = true;
    generation += 1;
    if (closeActiveInspector === close) closeActiveInspector = null;
    window.removeEventListener("metatidy:unauthorized", onUnauthorized);
    window.removeEventListener("hashchange", onHashChange);
    if (dialog.open) dialog.close();
    dialog.remove();
    if (restoreFocus && opener instanceof HTMLElement && opener.isConnected && !opener.closest("[inert]")) {
      opener.focus({ preventScroll: true });
    }
  }

  function onUnauthorized() { close({ restoreFocus: false }); }
  function onHashChange() { close({ restoreFocus: false }); }

  function act(callback) {
    if (closed || !current) return;
    const selected = { ...current };
    close();
    callback(selected);
  }

  function renderArtwork() {
    const key = `${current.id}:${Boolean(current.has_cover)}`;
    if (key === artKey) return;
    artKey = key;
    artwork.replaceChildren();
    artwork.dataset.state = "empty";
    const placeholder = (failed = false) => {
      artwork.dataset.state = failed ? "failed" : "empty";
      artwork.replaceChildren(ui.icon(failed ? "cover" : "music", { size: 42 }), ui.el("span", {
        text: failed ? "封面暂时无法读取" : "尚未收录封面",
      }));
    };
    if (!current.has_cover) { placeholder(); return; }
    const image = ui.el("img", {
      src: coverUrl(current.id, 512), width: "512", height: "512", decoding: "async",
      alt: `${text(current.title, current.filename || "曲目")} 的封面`,
    });
    artwork.dataset.state = "loading";
    image.addEventListener("load", () => {
      if (image.parentNode === artwork) artwork.dataset.state = "loaded";
    }, { once: true });
    image.addEventListener("error", () => {
      if (image.parentNode === artwork) placeholder(true);
    }, { once: true });
    artwork.append(image);
  }

  function field(label, value, extraClass = "") {
    return ui.el("div", { class: `ti-field ${extraClass}`.trim() }, [
      ui.el("dt", { text: label }), ui.el("dd", { text: value }),
    ]);
  }

  function renderDetails() {
    title.textContent = text(current.title, current.filename || "未命名曲目");
    artist.textContent = text(current.artist, "未知艺术家");
    album.textContent = text(current.album, "尚未填写专辑");
    const format = formatOf(current);
    facts.replaceChildren(...[
      format ? ui.el("span", { class: "format-tag", text: format }) : null,
      Number(current.duration) > 0 ? ui.el("span", { text: ui.fmtDuration(current.duration) }) : null,
      current.year ? ui.el("span", { text: String(current.year) }) : null,
    ].filter(Boolean));
    badges.replaceChildren(
      ui.badge(current.has_cover ? "已有封面" : "待补封面", current.has_cover ? "badge-ok" : "badge-mute"),
      ui.badge(current.has_lyrics ? "已标记歌词" : "未标记歌词", current.has_lyrics ? "badge-ok" : "badge-mute"),
    );
    renderArtwork();
    tagList.replaceChildren(...TAG_FIELDS.map((key) => field(ui.fieldLabel(key), text(current[key]))));
    extraList.replaceChildren(...EXTRA_FIELDS.map((key) => field(ui.fieldLabel(key), text(current[key]), key === "comment" ? "ti-field-wide" : "")));
    const loaded = current.tags_loaded === true ? "标签已读取" : current.tags_loaded === false ? "标签尚未读取" : "读取状态待确认";
    const derived = current.path_derived === true ? "含路径推断字段" : current.path_derived === false ? "未使用路径推断" : "来源待确认";
    const accessible = current.file_exists === true ? "原文件可访问" : current.file_exists === false ? "原文件暂不可访问" : "文件状态待确认";
    fileList.replaceChildren(
      field("格式", text(format, "暂无记录")),
      field("文件大小", current.size !== null && current.size !== undefined && Number.isFinite(Number(current.size)) && Number(current.size) >= 0 ? ui.fmtBytes(Number(current.size)) : "暂无记录"),
      field("时长", Number(current.duration) > 0 ? ui.fmtDuration(Number(current.duration)) : "暂无记录"),
      field("文件状态", accessible, current.file_exists === false ? "ti-field-warning" : ""),
      field("标签读取", loaded, current.tags_loaded === false ? "ti-field-warning" : ""),
      field("字段来源", derived),
      field("最近索引", timestamp(current.indexed_at)),
      field("最近编辑", timestamp(current.edited_at)),
      field("最近刮削", timestamp(current.scraped_at)),
      field("文件修改", timestamp(current.mtime)),
    );
    pathField.value = text(current.path, "");
    pathField.placeholder = "索引中没有文件路径";
    copyButton.disabled = !pathField.value;
  }

  async function loadDetails() {
    const token = generation;
    const request = ++detailRequest;
    const id = Number(current.id);
    content.setAttribute("aria-busy", "true");
    loadStatus.className = "ti-load-status hint";
    loadStatus.textContent = "正在读取索引资料…";
    retryButton.hidden = true;
    try {
      const detail = await api.track(id);
      if (!isCurrent(token) || request !== detailRequest) return;
      if (!detail || Number(detail.id) !== id) throw new Error("返回的曲目资料不完整，请重试。");
      current = { ...current, ...detail };
      renderDetails();
      if (!lyricsRequested) updateLyricsHint();
      loadStatus.textContent = current.tags_loaded === false
        ? "当前为快速索引；读取真实标签后，资料会更完整。"
        : "资料来自曲库索引；歌词可按需从原文件读取。";
    } catch (error) {
      if (!isCurrent(token) || request !== detailRequest) return;
      loadStatus.className = "ti-load-status hint hint-err";
      loadStatus.textContent = `最新资料读取失败：${error.message || "请稍后重试"}。当前显示列表快照。`;
      retryButton.hidden = false;
    } finally {
      if (isCurrent(token) && request === detailRequest) content.setAttribute("aria-busy", "false");
    }
  }

  async function loadLyrics() {
    if (lyricsButton.disabled || lyricsLoaded) return;
    const token = generation;
    const id = Number(current.id);
    lyricsRequested = true;
    lyricsButton.disabled = true;
    lyricsButton.textContent = "读取中…";
    lyricsSection.setAttribute("aria-busy", "true");
    lyricsStatus.className = "hint";
    lyricsStatus.textContent = "正在读取原文件中的歌词，云盘文件可能需要稍等。";
    try {
      const result = await api.trackLyrics(id);
      if (!isCurrent(token)) return;
      const value = typeof result.lyrics === "string" ? result.lyrics : "";
      lyricsText.textContent = value;
      lyricsText.hidden = !value;
      lyricsStatus.textContent = value ? `${value.split(/\r?\n/).length} 行 · ${value.length} 字` : "原文件中没有读取到歌词。";
      lyricsLoaded = true;
      lyricsButton.textContent = "已读取";
    } catch (error) {
      if (!isCurrent(token)) return;
      lyricsStatus.className = "hint hint-err";
      lyricsStatus.textContent = `歌词读取失败：${error.message || "请稍后重试"}`;
      lyricsButton.textContent = "重试读取";
    } finally {
      if (isCurrent(token)) {
        lyricsButton.disabled = lyricsLoaded;
        lyricsSection.setAttribute("aria-busy", "false");
      }
    }
  }

  async function copyPath() {
    if (!pathField.value) return;
    const token = generation;
    const path = pathField.value;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(path);
      if (isCurrent(token)) copyFeedback.textContent = "已复制完整路径";
    } catch {
      if (!isCurrent(token)) return;
      pathField.focus({ preventScroll: true });
      pathField.select();
      copyFeedback.textContent = "已选中路径，请按 Ctrl+C（Mac 为 ⌘C），手机可长按复制。";
    }
  }

  function showTrack() {
    generation += 1;
    current = { ...collection[index] };
    dialog.dataset.trackId = String(current.id);
    position.textContent = `${index + 1} / ${collection.length}`;
    position.setAttribute("aria-label", `当前页第 ${index + 1} 首，共 ${collection.length} 首`);
    previousButton.disabled = index <= 0;
    nextButton.disabled = index >= collection.length - 1;
    lyricsLoaded = false;
    lyricsRequested = false;
    lyricsText.textContent = "";
    lyricsText.hidden = true;
    lyricsButton.textContent = "读取歌词";
    lyricsButton.disabled = false;
    lyricsSection.setAttribute("aria-busy", "false");
    lyricsStatus.className = "hint";
    updateLyricsHint();
    copyFeedback.textContent = "";
    extraDetails.open = false;
    body.scrollTop = 0;
    renderDetails();
    void loadDetails();
  }

  function updateLyricsHint() {
    lyricsStatus.textContent = current.has_lyrics
      ? "索引记录包含歌词，点击后从原文件读取。"
      : "索引未标记歌词，也可以从原文件检查。";
  }

  function navigate(delta) {
    const next = index + delta;
    if (closed || next < 0 || next >= collection.length) return;
    const focused = document.activeElement;
    index = next;
    showTrack();
    // A navigation button becoming disabled must not strand keyboard focus.
    if (focused === previousButton && previousButton.disabled) nextButton.focus({ preventScroll: true });
    if (focused === nextButton && nextButton.disabled) previousButton.focus({ preventScroll: true });
  }

  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  dialog.addEventListener("close", () => close());
  dialog.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.target.closest("input, textarea, select, [contenteditable=true]")) return;
    if (!window.getSelection()?.isCollapsed) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      navigate(event.key === "ArrowLeft" ? -1 : 1);
    }
  });
  window.addEventListener("metatidy:unauthorized", onUnauthorized);
  window.addEventListener("hashchange", onHashChange);
  closeActiveInspector = close;
  document.body.append(dialog);
  dialog.showModal();
  showTrack();
  closeButton.focus({ preventScroll: true });
  return { close, dialog };
}
